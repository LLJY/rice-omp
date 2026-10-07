#!/usr/bin/env sh
# Stdio launcher for the workflow (workplan) MCP: installs pinned deps on first use, then execs the server.
# Install output goes to stderr; stdout is reserved for MCP traffic.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ ! -d "$here/node_modules/@modelcontextprotocol/sdk" ]; then
	command -v bun >/dev/null 2>&1 || { echo "workflow-mcp: bun not found on PATH" >&2; exit 1; }
	(cd "$here" && bun install --frozen-lockfile --production) >&2
fi

# Ignore the project's bunfig.toml (preloads can corrupt stdout) and .env.
exec bun --config=/dev/null --no-env-file "$here/src/mcp/workflow.ts" "$@"
