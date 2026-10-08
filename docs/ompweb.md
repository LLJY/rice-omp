# ompweb with rice-omp

[ompweb](https://github.com/kahme247/ompweb) (third-party, MIT) is a browser UI over the same omp agent dir
(`~/.omp/agent`): sessions, `config.yml`, `mcp.json`. We run the fork [LLJY/ompweb](https://github.com/LLJY/ompweb),
branch `rice`: upstream `main` plus our patches. Verified against omp 18.8.1.

## Why the fork

- **Slow `get_state` aborted runs.** Upstream resets a session whose `get_state` reply takes over 5 s, which aborts the
  run (UI: "Generation stopped by user"). omp answers in milliseconds, but ompweb parses session files synchronously:
  a phone tab waking on a 400 MB session blocked the server for ~5 s on flareon. The fork waits 60 s
  (`OMP_WEB_GET_STATE_TIMEOUT_MS`) and never resets a running session that is still streaming.
- **Upstream `main`, not 0.5.1**, for the opt-in auto-resume after a restart and the session-ownership fix
  (kahme247/ompweb#202).

## Install (no root)

```sh
git clone -b rice git@github.com:LLJY/ompweb.git ~/Projects/ompweb && cd ~/Projects/ompweb
git remote add upstream https://github.com/kahme247/ompweb.git
npm ci && npm pkg set version="0.5.1-rice.$(git rev-parse --short HEAD)"   # version label shown in the UI
npm pack --pack-destination /tmp && git checkout package.json              # prepack runs the build
systemctl --user stop ompweb                                               # kills its omp sessions, see below
npm install -g --prefix ~/.local /tmp/kahme247-ompweb-*.tgz                # ~/.local/bin must be on PATH
ompweb-systemd install                                                     # first install only: user unit + env file
systemctl --user start ompweb && journalctl --user -u ompweb -f
```

- npm's default global prefix may be `/usr` (root-only), so install with `--prefix ~/.local`.
- npm blocks `usocket`'s install script. Only the Linux tray icon needs it; the web service does not.
- `ompweb-systemd install` writes `~/.config/systemd/user/ompweb.service` and `~/.omp/agent/web-service.env`
  (mode 600) with `PORT`, `OMP_WEB_HOSTNAME`, `OMP_WEB_NO_OPEN`, `OMP_WEB_OMP_BIN`.
  - `OMP_WEB_OMP_BIN` is the absolute omp path resolved at install time. Re-run the installer if omp moves.
- Restart after editing the env file: `systemctl --user restart ompweb`.
- **Updating the fork:** `git fetch upstream && git rebase upstream/main` on `rice`, run `npm test`, push, then repeat
  the install steps. Drop patches once upstream merges them.

### Restarts kill running sessions

Every omp session ompweb started runs inside `ompweb.service` (`KillMode=control-group`), so stopping or restarting
the service ends their in-flight turns, subagents and MCP servers. Transcripts are kept. With
`{"autoResumeSessions": true}` in `~/.omp/agent/omp-web-settings.json` (Settings → System & Updates → **Resume
running sessions after a restart**) ompweb restarts sessions that were mid-run and tells them to continue; the
command running at that moment is still lost. Restart only when no long run is active.

### Known gaps

- The **Agents** settings page skips a symlinked `~/.omp/agent/agents` (`lib/omp/agents-service.ts`), so rice-omp's
  agents are missing there; on `main` the "Skipped symbolic-link agents directory" warning is not shown in the API
  response. omp itself loads them; sessions and subagents are unaffected.

### Server checklist

- **Run without a login session:** `loginctl enable-linger "$USER"`.
- **Expose beyond loopback:** set `OMP_WEB_PASSWORD` and `OMP_WEB_HOSTNAME` in `web-service.env`. `0.0.0.0` binds IPv4 only; `"::"` binds IPv4 and IPv6. Then restrict the port in the firewall to trusted sources. flareon allows `30177/tcp` only from the LAN (`192.168.10.0/24`, its IPv6 /64, `fc00::/7`, `fe80::/10` on the LAN NIC) and WireGuard (`10.100.0.0/24`, `fd08:4711::/64` on `wg0`). Plain HTTP sends the password and session cookie unencrypted, so outside a VPN put HTTPS in front.
- **Keep the fork:** set `OMP_WEB_DISABLE_AUTOUPDATE=1` so in-app updates don't replace it with the npm release.
- **Before first use:** install rice-omp (`./install.sh`). ompweb's own files in the agent dir (`web-service.env`,
  `omp-web-settings.json`, `projects.json`, `usage.db`) are per-machine and not part of rice-omp.

## How ompweb reads and writes omp settings

1. **Reads only keys present in `config.yml`** (`lib/omp/settings-config.ts`, `readNativeSettings`). It does not ask omp for effective values. For a missing key the settings form shows **ompweb's own fallback**, which can differ from omp's real default:

   | Key | ompweb shows when unset | omp's actual default |
   |---|---|---|
   | `memory.backend` | `mnemopi` (looks like memory is ON) | `off` |
   | `autolearn.enabled` / `autolearn.autoContinue` | on / on | `false` / `false` |
   | `compaction.strategy` | `snapcompact` | key is legacy and ignored; see below |
   | `retry.maxRetries` | `2` | `10` |
   | `retry.modelFallback` | off | `true` |

   Other fallbacks (`defaultThinkingLevel: high`, `hideThinkingBlock: false`, `textVerbosity: medium`, `tools.approvalMode: yolo`, mnemopi/mcp toggles) match omp 18.8.0.

   rice-omp therefore pins memory, autolearn and retry in `agent/config.yml` at omp's real defaults, so ompweb displays the truth.
   - Recheck after upgrading ompweb: grep the built UI (`.next/static/chunks`) for `eW?.<key>??<fallback>`, and compare with `omp config get <key>`.

2. **Compaction:** ompweb only knows the legacy `compaction.strategy`. It does not know `compaction.methodOrder`, which is what omp actually uses.
   - omp ignores `strategy` whenever `methodOrder` is set. Tested with `strategy: handoff | snapcompact | off`: the effective `methodOrder` stayed `[remote, handoff, soft, shake]`.
   - The ompweb compaction dropdown is therefore meaningless here; it shows `snapcompact` whatever omp uses. Change compaction in `agent/config.yml` (`methodOrder`).
   - Pinning `strategy` for display does not stick: omp deletes the legacy key whenever it saves `config.yml`.

3. **Settings writes** target `~/.omp/agent/config.yml` by path without resolving symlinks, then atomically rename a temp file over it. rice-omp links that file into its checkout, so an ompweb settings save replaces the link with a plain file. It sets only the keys you changed and keeps the rest of the file. ompweb's **MCP editor** is project-scoped: it writes `<project>/.omp/mcp.json`, not the synced user `mcp.json` (`lib/omp/mcp-config.ts`).

## Keeping the repo the source of truth

After saving settings in ompweb, re-run `./install.sh` in the rice-omp checkout. It three-way merges the edited file into the checkout, using the repo version from its previous run as the base, so the change shows in `git diff` and commits pulled in the meantime are kept. It then restores the link. On a conflict it leaves the checkout alone, keeps the live file as `<file>.local-<timestamp>` and prints the diff for a manual merge. omp's own `/settings` writes through the link and needs no extra step.
