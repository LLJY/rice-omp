#!/usr/bin/env sh
# Stdio launcher for researcher-mcp: builds the vendored Go source on first use
# (or when any source is newer than the binary), then execs the server.
# Build output goes to stderr; stdout is reserved for MCP traffic.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bin="$here/bin/researcher-mcp"

if [ ! -x "$bin" ] || [ -n "$(find "$here/src" -newer "$bin" -type f -print -quit)" ]; then
	command -v go >/dev/null 2>&1 || { echo "researcher-mcp: Go toolchain (1.25+) not found on PATH" >&2; exit 1; }
	mkdir -p "$here/bin"
	(cd "$here/src" && CGO_ENABLED=0 go build -trimpath -o "$bin" ./cmd/google-scholar-mcp) >&2
fi

exec "$bin" "$@"
