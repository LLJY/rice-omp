#!/usr/bin/env sh
# Stdio launcher for Hound: ensures patchright's Chromium exists for the pinned uvx
# environment (needed for screenshots and anti-bot browser fetches), then execs the server.
# Setup output goes to stderr; stdout is reserved for MCP traffic.
set -eu
spec='hound-mcp[all]==12.4.1'
command -v uvx >/dev/null 2>&1 || { echo "hound: uvx not found on PATH" >&2; exit 1; }

chrome=$(uvx --from "$spec" python -c 'from patchright.sync_api import sync_playwright; p = sync_playwright().start(); print(p.chromium.executable_path); p.stop()' 2>/dev/null | tail -n 1) || chrome=
if [ -z "$chrome" ] || [ ! -x "$chrome" ]; then
	echo "hound: installing patchright Chromium (first run)" >&2
	uvx --from "$spec" python -m patchright install chromium >&2 ||
		echo "hound: Chromium install failed; browser fetches and screenshots are unavailable" >&2
fi

# Hound 12.4.1 picks patchright's `chrome` channel whenever google-chrome/chromium is on PATH, but
# that channel only launches Google Chrome at its fixed Linux path; a distro `chromium` makes every
# browser launch fail. Seed Hound's detection cache with a channel that can actually start.
channel=chromium
[ -x /opt/google/chrome/chrome ] && channel=chrome
exec uvx --from "$spec" python -c 'import sys
import master_fetch.browser as b
b._chrome_channel_cache = sys.argv[1]
del sys.argv[1]
from master_fetch.cli import main
sys.exit(main())' "$channel" "$@"
