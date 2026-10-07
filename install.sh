#!/usr/bin/env sh
# Link rice-omp's agent/ files into an omp agent dir (default ~/.omp/agent), so the live config IS
# this checkout: edits made through omp show up in `git diff`, and `git pull` updates the live setup.
# Idempotent; re-run it to repair links that a tool replaced with a plain file (see adopt below).
# omp's own state (agent.db, sessions, .env, ...) is never touched.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
src=$repo/agent
default="$HOME/.omp/agent"
dest=${1:-"$default"}
mkdir -p "$dest"
dest=$(CDPATH= cd -- "$dest" && pwd)
stamp=$(date +%Y%m%d-%H%M%S)

links='APPEND_SYSTEM.md config.yml agents skills extensions mcp'
# mcp.json names its launchers under the default agent dir, so other dirs (profiles) get a generated copy.
if [ "$dest" = "$default" ]; then links="$links mcp.json"; fi

# Installed before (marker, or *.pre-rice backups from the old copy-based installer)? Then a plain file
# where a link belongs was written by a tool, not left over from the machine's original setup.
installed=false
if [ -e "$dest/.rice-omp" ] || [ -e "$dest/config.yml.pre-rice" ]; then installed=true; fi

# omp's settings writer follows the config.yml link, but ompweb's settings and mcp.json writers and
# omp's /mcp add replace the link with a plain file. Fold such edits into the checkout so they show
# in `git diff` (the previous version stays recoverable from git); never clobber uncommitted repo edits.
adopt() {
	if cmp -s "$dest/$1" "$src/$1"; then return 0; fi
	# Unedited copy left by the old copy-based installer: nothing to adopt.
	if cmp -s "$dest/$1" "$dest/.rice-omp-installed/$1" 2>/dev/null; then return 0; fi
	if [ -n "$(git -C "$repo" status --porcelain -- "agent/$1" 2>/dev/null)" ]; then
		cp -a "$dest/$1" "$dest/$1.local-$stamp"
		echo "rice-omp: $1 changed both live and in the repo (uncommitted); live copy saved as $dest/$1.local-$stamp. Merge by hand:" >&2
		diff -u "$src/$1" "$dest/$1" >&2 || true
	else
		cp "$dest/$1" "$src/$1"
		echo "rice-omp: adopted live edits to $1; review with: git -C '$repo' diff agent/$1" >&2
	fi
}

for item in $links; do
	live=$dest/$item
	target=$src/$item
	if [ -L "$live" ]; then
		[ "$(readlink "$live")" = "$target" ] && continue
		rm -f "$live" # points elsewhere (e.g. the checkout moved)
	elif [ -e "$live" ]; then
		if [ "$installed" = false ]; then
			[ -e "$live.pre-rice" ] || mv "$live" "$live.pre-rice"
		elif [ -f "$live" ]; then
			adopt "$item"
		elif ! diff -rq -x node_modules -x bin "$target" "$live" >/dev/null 2>&1; then
			# Directory copy from the old installer that differs from the repo: keep it aside.
			mv "$live" "$live.local-$stamp"
			echo "rice-omp: $item differed from the repo; moved to $live.local-$stamp" >&2
		fi
		rm -rf "${live:?}"
	fi
	ln -s "$target" "$live"
done

if [ "$dest" != "$default" ]; then
	live=$dest/mcp.json
	if [ -L "$live" ]; then
		rm -f "$live"
	elif [ -e "$live" ] && [ "$installed" = false ] && [ ! -e "$live.pre-rice" ]; then
		mv "$live" "$live.pre-rice"
	fi
	esc=$(printf '%s' "$dest" | sed 's/[|&\\]/\\&/g')
	sed "s|\${HOME}/\.omp/agent|$esc|g" "$src/mcp.json" >"$live"
	echo "rice-omp: $live is generated for this dir; edit agent/mcp.json in the repo and re-run." >&2
fi

# Superseded by extensions/cliproxyapi.ts; a leftover static `cpa` provider would shadow its discovery.
if [ -e "$dest/models.yml" ]; then
	[ -e "$dest/models.yml.pre-rice" ] || cp -a "$dest/models.yml" "$dest/models.yml.pre-rice"
	rm -f "$dest/models.yml"
fi

rm -rf "$dest/.rice-omp-installed" # record dir from the old copy-based installer
printf '%s\n' "$repo" >"$dest/.rice-omp"
echo "Linked rice-omp ($repo) into $dest" >&2
