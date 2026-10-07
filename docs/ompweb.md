# ompweb with rice-omp

[ompweb](https://github.com/kahme247/ompweb) (third-party, MIT) is a browser UI over the same omp agent dir
(`~/.omp/agent`): sessions, `config.yml`, `mcp.json`. Verified against ompweb 0.5.1 and omp 18.8.0.

## Install (no root)

```sh
npm install -g --prefix ~/.local @kahme247/ompweb@0.5.1   # ~/.local/bin must be on PATH
ompweb-systemd install                                     # user unit, starts at login, restarts on crash
journalctl --user -u ompweb -f
```

- npm's default global prefix may be `/usr` (root-only), so install with `--prefix ~/.local`.
- npm blocks `usocket`'s install script. Only the Linux tray icon needs it; the web service does not.
- `ompweb-systemd install` writes `~/.config/systemd/user/ompweb.service` and `~/.omp/agent/web-service.env`
  (mode 600) with `PORT`, `OMP_WEB_HOSTNAME`, `OMP_WEB_NO_OPEN`, `OMP_WEB_OMP_BIN`.
  - `OMP_WEB_OMP_BIN` is the absolute omp path resolved at install time. Re-run the installer if omp moves.
- Restart after editing the env file: `systemctl --user restart ompweb`.

### Server checklist

- **Run without a login session:** `loginctl enable-linger "$USER"`.
- **Expose beyond loopback:** set `OMP_WEB_HOSTNAME=0.0.0.0` *and* `OMP_WEB_PASSWORD` in `web-service.env`. Serve it over HTTPS (reverse proxy) or a VPN such as Tailscale; never plain HTTP with a password.
- **Pin the version:** set `OMP_WEB_DISABLE_AUTOUPDATE=1` so in-app updates don't drift from the pinned version.
- **Before first use:** install rice-omp (`./install.sh`). ompweb only reads the agent dir and adds nothing of its own.

## How ompweb reads and writes omp settings

1. **Reads only keys present in `config.yml`** (`lib/omp/settings-config.ts`, `readNativeSettings`). It does not ask omp for effective values. For a missing key the settings form shows **ompweb's own fallback**, which can differ from omp's real default:

   | Key | ompweb shows when unset | omp's actual default |
   |---|---|---|
   | `memory.backend` | `mnemopi` (looks like memory is ON) | `off` |
   | `autolearn.enabled` / `autolearn.autoContinue` | on / on | `false` / `false` |
   | `compaction.strategy` | `snapcompact` | key is legacy; see below |
   | `retry.maxRetries` | `2` | `10` |
   | `retry.modelFallback` | off | `true` |

   Other fallbacks (`defaultThinkingLevel: high`, `hideThinkingBlock: false`, `textVerbosity: medium`, `tools.approvalMode: yolo`, mnemopi/mcp toggles) match omp 18.8.0.

   rice-omp therefore pins these keys in `agent/config.yml` at omp's real defaults, so ompweb displays the truth.
   - Recheck after upgrading ompweb: grep the built UI (`.next/static/chunks`) for `eW?.<key>??<fallback>`, and compare with `omp config get <key>`.

2. **Compaction:** ompweb only knows the legacy `compaction.strategy`. It does not know `compaction.methodOrder`, which is what omp actually uses.
   - omp ignores `strategy` whenever `methodOrder` is set. Tested with `strategy: handoff | snapcompact | off`: the effective `methodOrder` stayed `[remote, handoff, soft, shake]`.
   - The ompweb compaction dropdown is therefore display-only here. Change compaction in `agent/config.yml` (`methodOrder`).
   - `strategy: handoff` is kept in the repo so the dropdown shows the method actually used locally.

3. **Writes** go straight to the live `~/.omp/agent/config.yml`. It sets only the keys you changed, then does an atomic rename; comments and other keys survive. omp's `/settings` also writes there.

## Keeping the repo the source of truth

Edits in ompweb or omp `/settings` land in the live agent dir, not in rice-omp, and `./install.sh` replaces the live files with the repo's.

When an owned file (`config.yml`, `mcp.json`, `APPEND_SYSTEM.md`) changed since the last install, `install.sh`:
- saves it as `<file>.local-<timestamp>`;
- prints a `diff -u` of what is being replaced.

To keep a UI change, copy it into `agent/config.yml`, commit, then install.
