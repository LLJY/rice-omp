#!/usr/bin/env sh
# Link rice-omp's agent/ files into an omp agent dir (default ~/.omp/agent), so the live config IS
# this checkout: edits made through omp show up in `git diff`, and `git pull` updates the live setup.
# Idempotent; re-run it to fold back edits from tools that replaced a link with a plain file.
#
#   install.sh [--host NAME | --no-host] [DEST]
#
# --host NAME layers hosts/NAME/ on top for this machine (remembered for later runs):
#   hosts/NAME/models.yml  linked as models.yml (per-model limits, costs, overrides)
#   hosts/NAME/config.yml  loaded as an omp config overlay via PI_CONFIG_FILES in DEST/.env
# omp's own state (agent.db, sessions, ...) is never touched; .env only gets that one managed line.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
src=$repo/agent
default="$HOME/.omp/agent"

host_arg=
host_set=false
while [ $# -gt 0 ]; do
	case $1 in
	--host)
		[ $# -ge 2 ] || { echo "rice-omp: --host needs a name" >&2; exit 2; }
		host_arg=$2 host_set=true
		shift 2
		;;
	--host=*) host_arg=${1#--host=} host_set=true; shift ;;
	--no-host) host_arg= host_set=true; shift ;;
	-*) echo "usage: install.sh [--host NAME | --no-host] [DEST]" >&2; exit 2 ;;
	*) break ;;
	esac
done
dest=${1:-"$default"}
mkdir -p "$dest"
dest=$(CDPATH= cd -- "$dest" && pwd)
stamp=$(date +%Y%m%d-%H%M%S)

# Installing into the checkout itself (directly or via a symlinked agent dir) would replace the
# source files with links to themselves.
src_p=$(CDPATH= cd -- "$src" && pwd -P)
dest_p=$(CDPATH= cd -- "$dest" && pwd -P)
case "$dest_p/" in "$repo/"* | "$src_p/"* | "$(CDPATH= cd -- "$repo" && pwd -P)/"*)
	echo "rice-omp: refusing to install into the checkout itself ($dest_p)" >&2
	exit 1
	;;
esac

host=
if [ "$host_set" = true ]; then
	host=$host_arg
elif [ -f "$dest/.rice-omp" ]; then
	host=$(sed -n 's/^host=//p' "$dest/.rice-omp")
fi
hostdir=
if [ -n "$host" ]; then
	case $host in */* | .*) echo "rice-omp: invalid host name '$host'" >&2; exit 2 ;; esac
	hostdir=$repo/hosts/$host
	[ -d "$hostdir" ] || { echo "rice-omp: no such host dir: $hostdir" >&2; exit 1; }
fi

# Repo version of each linked file as of the last run: the merge base for edits made while a link was
# broken. (Also the record dir of the old copy-based installer, which holds exactly what it installed.)
base=$dest/.rice-omp-installed

installed=false
if [ -e "$dest/.rice-omp" ] || [ -d "$base" ] || [ -e "$dest/config.yml.pre-rice" ]; then installed=true; fi

aside() { # keep $1 as $1.local-<stamp>
	mv "$1" "$1.local-$stamp"
	echo "rice-omp: kept $1 as $1.local-$stamp" >&2
}

warn_secrets() {
	if grep -Eq 'Bearer [A-Za-z0-9_.~+/-]{8,}|"client_?[sS]ecret"' "$1"; then
		echo "rice-omp: WARNING $1 contains a literal credential; move it to ~/.omp/agent/.env (\"!printf %s \\\"\$VAR\\\"\") before committing" >&2
	fi
}

# Directories differ other than by the checkout's own regenerated MCP artifacts?
differs() {
	diff -rq "$1" "$2" 2>&1 |
		grep -F -x -v -e "Only in $1/workflow: node_modules" -e "Only in $1/researcher-mcp: bin" | grep -q .
}

# omp's settings writer follows the config.yml link, but ompweb's settings/models writers and
# `/mcp add --scope user` replace the link with a plain file. Three-way merge such an edit into the
# checkout (base = repo version at the last run), so neither the edit nor commits pulled since are lost.
# Without a base, or on a conflict, the live copy is kept aside and the checkout is left alone.
adopt() { # adopt NAME TARGET
	live=$dest/$1
	if cmp -s "$live" "$2"; then return 0; fi
	if [ -f "$base/$1" ] && cmp -s "$live" "$base/$1"; then return 0; fi # not edited since last run
	merged=$(mktemp)
	if [ -f "$base/$1" ] && command -v git >/dev/null 2>&1 &&
		git merge-file -p -L live -L base -L repo "$live" "$base/$1" "$2" >"$merged" 2>/dev/null; then
		cat "$merged" >"$2"
		rm -f "$merged"
		echo "rice-omp: merged live edits to $1 into the checkout; review with: git -C '$repo' diff" >&2
		warn_secrets "$2"
		return 0
	fi
	rm -f "$merged"
	echo "rice-omp: could not merge live edits to $1 (conflict or no merge base); merge by hand:" >&2
	diff -u "$2" "$live" >&2 || true
	cp -a "$live" "$live.local-$stamp"
	echo "rice-omp: kept $live as $live.local-$stamp" >&2
}

link() { # link NAME TARGET
	live=$dest/$1
	if [ -L "$live" ]; then
		[ "$(readlink "$live")" = "$2" ] && return 0
		rm -f "$live" # points elsewhere (e.g. the checkout moved)
	elif [ -e "$live" ]; then
		if [ "$installed" = false ]; then
			if [ -e "$live.pre-rice" ]; then aside "$live"; else mv "$live" "$live.pre-rice"; fi
		elif [ -f "$live" ]; then
			adopt "$1" "$2"
			rm -f "$live"
		elif [ -d "$live" ]; then
			# Directory copy from the old installer: drop regenerated artifacts, keep anything else that differs.
			if [ "$1" = mcp ]; then rm -rf "$live/workflow/node_modules" "$live/researcher-mcp/bin"; fi
			if differs "$2" "$live"; then aside "$live"; else rm -rf "${live:?}"; fi
		else
			aside "$live"
		fi
	fi
	ln -s "$2" "$live"
}

# Superseded by extensions/cliproxyapi.ts: a static `cpa`/`cpa-images` model list from an early
# rice-omp would shadow discovery. Any other models.yml is machine-local and left alone.
if [ ! -L "$dest/models.yml" ] && [ -f "$dest/models.yml" ] && grep -q '^  cpa-images:' "$dest/models.yml"; then
	[ -e "$dest/models.yml.pre-rice" ] || cp -a "$dest/models.yml" "$dest/models.yml.pre-rice"
	rm -f "$dest/models.yml"
	echo "rice-omp: retired the old static cpa models.yml (saved as models.yml.pre-rice)" >&2
fi

items='APPEND_SYSTEM.md config.yml agents skills extensions mcp'
# mcp.json names its launchers under the default agent dir, so other dirs (profiles) get a generated copy.
if [ "$dest" = "$default" ]; then items="$items mcp.json"; fi
for item in $items; do link "$item" "$src/$item"; done
mkdir -p "$base"
for item in APPEND_SYSTEM.md config.yml mcp.json; do cp "$src/$item" "$base/$item"; done

# Host models.yml. Switching hosts (or --no-host) unlinks the previous host's file.
if [ -n "$hostdir" ] && [ -f "$hostdir/models.yml" ]; then
	link models.yml "$hostdir/models.yml"
	cp "$hostdir/models.yml" "$base/models.yml"
elif [ -L "$dest/models.yml" ]; then
	case $(readlink "$dest/models.yml") in "$repo"/hosts/*) rm -f "$dest/models.yml" "$base/models.yml" ;; esac
fi

# Host config overlay: one managed PI_CONFIG_FILES line in .env (omp loads .env before settings).
envf=$dest/.env
mark='# rice-omp host overlay (managed by install.sh)'
if [ -f "$envf" ] && grep -qxF "$mark" "$envf"; then
	tmp=$(mktemp)
	awk -v m="$mark" '$0 == m { skip = 1; next } skip { skip = 0; next } { print }' "$envf" >"$tmp"
	cat "$tmp" >"$envf"
	rm -f "$tmp"
fi
if [ -n "$hostdir" ] && [ -f "$hostdir/config.yml" ]; then
	if [ -f "$envf" ] && grep -q '^PI_CONFIG_FILES=' "$envf"; then
		echo "rice-omp: $envf already sets PI_CONFIG_FILES; add $hostdir/config.yml to it yourself" >&2
	else
		[ ! -s "$envf" ] || [ -z "$(tail -c 1 "$envf")" ] || echo >>"$envf"
		printf '%s\nPI_CONFIG_FILES=%s\n' "$mark" "$hostdir/config.yml" >>"$envf"
		chmod 600 "$envf"
	fi
fi

if [ "$dest" != "$default" ]; then
	live=$dest/mcp.json
	gen=$(mktemp)
	esc=$(printf '%s' "$dest" | sed 's/[|&\\]/\\&/g')
	sed "s|\${HOME}/\.omp/agent|$esc|g" "$src/mcp.json" >"$gen"
	if [ -L "$live" ]; then
		rm -f "$live"
	elif [ -e "$live" ] && ! cmp -s "$live" "$gen"; then
		if [ "$installed" = false ]; then
			if [ -e "$live.pre-rice" ]; then aside "$live"; else mv "$live" "$live.pre-rice"; fi
		elif ! cmp -s "$live" "$base/mcp.json.generated" 2>/dev/null; then
			echo "rice-omp: $live was edited; port the change to agent/mcp.json in the repo:" >&2
			diff -u "$gen" "$live" >&2 || true
			aside "$live"
		fi
	fi
	cp "$gen" "$live"
	cp "$gen" "$base/mcp.json.generated"
	rm -f "$gen"
	echo "rice-omp: $live is generated for this dir; edit agent/mcp.json in the repo and re-run." >&2
fi

printf '%s\nhost=%s\n' "$repo" "$host" >"$dest/.rice-omp"
echo "Linked rice-omp ($repo) into $dest${host:+ (host: $host)}" >&2
