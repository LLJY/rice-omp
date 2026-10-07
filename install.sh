#!/usr/bin/env sh
# Link rice-omp's agent/ files into an omp agent dir (default ~/.omp/agent), so the live config IS
# this checkout: edits made through omp show up in `git diff`, and `git pull` updates the live setup.
# Idempotent; re-run it to fold back edits from tools that replaced a link with a plain file.
# omp's own state (agent.db, sessions, .env, ...) is never touched.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
src=$repo/agent
default="$HOME/.omp/agent"
dest=${1:-"$default"}
mkdir -p "$dest"
dest=$(CDPATH= cd -- "$dest" && pwd)
stamp=$(date +%Y%m%d-%H%M%S)

# Installing into the checkout itself (directly or via a symlinked agent dir) would replace the
# source files with links to themselves.
src_p=$(CDPATH= cd -- "$src" && pwd -P)
dest_p=$(CDPATH= cd -- "$dest" && pwd -P)
case "$dest_p/" in "$src_p/"*)
	echo "rice-omp: refusing to install into the checkout itself ($dest_p)" >&2
	exit 1
	;;
esac

links='APPEND_SYSTEM.md config.yml agents skills extensions mcp'
# mcp.json names its launchers under the default agent dir, so other dirs (profiles) get a generated copy.
if [ "$dest" = "$default" ]; then links="$links mcp.json"; fi

# Repo version of each file as of the last run: the merge base for edits made while a link was broken.
# (Also the record dir of the old copy-based installer, which holds exactly what it installed.)
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

# omp's settings writer follows the config.yml link, but ompweb's settings writer and
# `/mcp add --scope user` replace the link with a plain file. Three-way merge such an edit into the
# checkout (base = repo version at the last run), so neither the edit nor commits pulled since are lost.
# Without a base, or on a conflict, the live copy is kept aside and the checkout is left alone.
adopt() {
	live=$dest/$1
	if cmp -s "$live" "$src/$1"; then return 0; fi
	if [ -f "$base/$1" ] && cmp -s "$live" "$base/$1"; then return 0; fi # not edited since last run
	merged=$(mktemp)
	if [ -f "$base/$1" ] && command -v git >/dev/null 2>&1 &&
		git merge-file -p -L live -L base -L repo "$live" "$base/$1" "$src/$1" >"$merged" 2>/dev/null; then
		cat "$merged" >"$src/$1"
		rm -f "$merged"
		echo "rice-omp: merged live edits to $1 into the checkout; review with: git -C '$repo' diff agent/$1" >&2
		warn_secrets "$src/$1"
		return 0
	fi
	rm -f "$merged"
	echo "rice-omp: could not merge live edits to $1 (conflict or no merge base); merge by hand:" >&2
	diff -u "$src/$1" "$live" >&2 || true
	cp -a "$live" "$live.local-$stamp"
	echo "rice-omp: kept $live as $live.local-$stamp" >&2
}

for item in $links; do
	live=$dest/$item
	target=$src/$item
	if [ -L "$live" ]; then
		[ "$(readlink "$live")" = "$target" ] && continue
		rm -f "$live" # points elsewhere (e.g. the checkout moved)
	elif [ -e "$live" ]; then
		if [ "$installed" = false ]; then
			if [ -e "$live.pre-rice" ]; then aside "$live"; else mv "$live" "$live.pre-rice"; fi
		elif [ -f "$live" ]; then
			adopt "$item"
			rm -f "$live"
		elif [ -d "$live" ]; then
			# Directory copy from the old installer: drop regenerated artifacts, keep anything else that differs.
			if [ "$item" = mcp ]; then rm -rf "$live/workflow/node_modules" "$live/researcher-mcp/bin"; fi
			if differs "$target" "$live"; then aside "$live"; else rm -rf "${live:?}"; fi
		else
			aside "$live"
		fi
	fi
	ln -s "$target" "$live"
done

mkdir -p "$base"
for item in APPEND_SYSTEM.md config.yml mcp.json; do cp "$src/$item" "$base/$item"; done

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

# Superseded by extensions/cliproxyapi.ts; a leftover static `cpa` provider would shadow its discovery.
if [ -e "$dest/models.yml" ]; then
	[ -e "$dest/models.yml.pre-rice" ] || cp -a "$dest/models.yml" "$dest/models.yml.pre-rice"
	rm -f "$dest/models.yml"
fi

printf '%s\n' "$repo" >"$dest/.rice-omp"
echo "Linked rice-omp ($repo) into $dest" >&2
