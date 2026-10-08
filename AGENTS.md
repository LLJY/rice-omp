# rice-omp: agent notes

Lucas's personal [omp](https://github.com/can1357/oh-my-pi) configuration, synced between machines with plain git (remote `git@github.com:LLJY/rice-omp.git`, branch `master`). `README.md` is the user-facing reference; this file is how to change things safely.

## Layout

| Path | What |
|---|---|
| `agent/` | Mirrors `~/.omp/agent/`. `install.sh` symlinks `APPEND_SYSTEM.md`, `config.yml`, `mcp.json`, `agents/`, `skills/`, `extensions/`, `mcp/` into it, so this checkout **is** the live config on every machine. |
| `agent/config.yml` | Shared omp settings. omp's `/settings` rewrites it in its own format: no comments, block lists, quoted `"off"`, no trailing newline. Keep it that way; rationale goes in `README.md`. |
| `agent/extensions/` | omp extensions (TypeScript, loaded at omp start). `cliproxyapi.ts`: CLIProxyAPI model discovery. `workflow-compaction.ts`: workflow status in compaction summaries. |
| `agent/mcp/` | Vendored MCP servers: `workflow` (workplan tools, bun, tests), `researcher-mcp` (Go, built on launch), `hound/run.sh`. |
| `hosts/<name>/` | Per-machine overrides: `models.yml` (linked) and `config.yml` (overlay via a managed `PI_CONFIG_FILES=` line in `~/.omp/agent/.env`). Arrays replace, not merge. |
| `tools/opencode-import/` | One-off importer of OpenCode sessions into omp's native format (bun, tests). |
| `docs/ompweb.md` | ompweb (web UI) notes; flareon runs the fork `LLJY/ompweb`, branch `rice`. |

## Machines

| Machine | Install | Notes |
|---|---|---|
| Workstation (`wailord`) | `./install.sh` | Checkout at `~/Projects/rice-omp`. |
| Server `flareon.local` | `./install.sh --host flareon` | Same path. Runs ompweb (user unit `ompweb`, port 30177) and CLIProxyAPI. `ssh flareon.local`; sudo works without a password. |

## Changing config

1. Edit in the checkout. Test changes that can break a session (extensions, MCP servers, `install.sh`) before committing: run the code against real omp in a throwaway setup, e.g. `omp --mode rpc --no-session` in a `/tmp` workspace, `HOME=/tmp/x ./install.sh`, or `PI_CODING_AGENT_DIR=/tmp/x`. Unit tests: `cd agent/mcp/workflow && bun test`, `cd tools/opencode-import && bun test`.
2. Commit **only the files you changed**: `git add <paths> && git commit`. Never `git commit -a`: omp and ompweb write into the linked files at any time (e.g. `/settings`, `dev.autoqaConsent`), and `-a` sweeps those in.
3. `git push`.
4. Update every other machine. On flareon:
   ```sh
   ssh flareon.local 'cd ~/Projects/rice-omp && git pull --ff-only && ./install.sh'
   ```
   Always run `./install.sh` after a pull, even when no links changed. It records the repo version of each linked file as the base for its three-way merge; pulling without it leaves that base stale, and the next ompweb settings edit then conflicts instead of merging.
5. If `install.sh` prints `could not merge live edits` / `kept … as ….local-<timestamp>`: a tool replaced a link with a plain file (ompweb settings, `/mcp add --scope user`). Read the printed diff, put the edit where it belongs (shared `agent/config.yml`, or `hosts/<name>/config.yml` for one machine), commit, then delete the `.local-*` file. Never discard it unread: it is the user's setting.

What applies when: `config.yml` live; `mcp.json` after `/mcp reload`; `APPEND_SYSTEM.md`, skills and agents for new sessions; `extensions/` after an omp restart. On flareon, sessions run inside ompweb, so restarting `ompweb` kills their in-flight turns: ask the user before `systemctl --user restart ompweb`.

## Rules

- Secrets live only in `~/.omp/agent/.env` (`CPA_KEY`, `EXA_API_KEY`, `CONTEXT7_API_KEY`), referenced as `"!printf %s \"$VAR\""` in `mcp.json`. Never commit or print them.
- Prefer omp's native features; add an extension or MCP server only for what omp can't do. omp source for API questions: `~/node_modules/@oh-my-pi/pi-coding-agent/src` (extension types in `src/extensibility/`).
- Don't open PRs, issues or other public posts (here, upstream omp, ompweb) unless the user asks for that specific action.
