# rice-omp

Personal [omp](https://github.com/can1357/oh-my-pi) setup, ported from `rice-opencode` and `good-goose`.

`agent/` mirrors `~/.omp/agent/`. Everything inside it is self-contained; `mcp.json` launchers point at `${HOME}/.omp/agent`, and `install.sh <dir>` rewrites them for other agent dirs.

## Install

```sh
./install.sh            # copies agent/* into ~/.omp/agent (backs up clobbered files as *.pre-rice)
./install.sh <dir>      # or into another agent dir, e.g. ~/.omp/profiles/work/agent
```

Use `install.sh` for upgrades too: it also retires a stale `models.yml` (a static `cpa` provider would shadow discovery) and repoints MCP launchers for non-default dirs. Owned files changed outside the repo since the last install (omp `/settings`, ompweb, hand edits) are saved as `<file>.local-<timestamp>` and their diff is printed before replacement. Hand-copying `agent/`'s contents is equivalent only for a fresh `~/.omp/agent`. Restart omp afterwards.

Runtime prerequisites: `bun` (workflow MCP), `go` 1.25+ (researcher-mcp, built on first launch), `uvx` (hound; its launcher installs patchright Chromium on first run), and CLIProxyAPI on `127.0.0.1:8317` with `CPA_KEY` set.

Optional env (shell or `~/.omp/agent/.env`):

| Variable | Used by |
|---|---|
| `EXA_API_KEY` | native `web_search` via Exa (keyless public endpoint otherwise) |
| `CONTEXT7_API_KEY` | context7 MCP (rate-limited without) |
| `SCHOLAR_CONTACT_EMAIL` | researcher-mcp Unpaywall full-text lookup |

### Web UI (optional)

[ompweb](https://github.com/kahme247/ompweb) (third-party, MIT) serves a browser UI over the same `~/.omp/agent` sessions and config. Node ≥ 22.19; installed under `~/.local` so no root is needed:

```sh
npm install -g --prefix ~/.local @kahme247/ompweb
ompweb-systemd install          # user service on http://127.0.0.1:30177, starts at login
journalctl --user -u ompweb -f  # logs; port/host/password live in ~/.omp/agent/web-service.env
```

It binds to loopback; set `OMP_WEB_PASSWORD` before exposing it beyond localhost. ompweb shows its own fallbacks for settings absent from `config.yml` and only knows the legacy compaction key: see [docs/ompweb.md](docs/ompweb.md) for what rice-omp pins and the server checklist.

## Contents

| Path | What |
|---|---|
| `agent/APPEND_SYSTEM.md` | Web-research and agent routing rules appended to the default system prompt |
| `agent/config.yml` | `modelRoles`: `review`, `plan-check`, `research`, `proofread` role aliases used by the agents; `web: web/exa`; `disabledProviders: [opencode]` so only native MCP/skill config loads; `compaction.methodOrder: [remote, handoff, soft, shake]` (server-side for GPT, written summaries otherwise; no snapcompact); `generate_image.enabled` (off by default in omp); `display.pinnedAgents: full` and `display.subagentLivePreview`. `tui.mouse` stays at omp's default (off): capturing the mouse takes over terminal wheel scrolling |
| `agent/extensions/cliproxyapi.ts` | Discovers CLIProxyAPI models from `/v1/models` (omp caches 24 h; `omp models refresh cpa` or `/models` refresh forces it). `cpa/*`: every chat model over Codex Responses WebSocket (`/backend-api/codex/responses`); `cpa-images/*`: `gpt-image-*` for `generate_image`. Limits and thinking levels come from omp's catalog. Models CPA reports as `owned_by: openai` get remote compaction V2 (server-side, via Codex OAuth); Claude models fall back to omp's local methods because CPA's Claude route cannot compact. Env: `CPA_KEY` (required), `CPA_BASE_URL` (default `http://127.0.0.1:8317`); `PI_CODEX_WEBSOCKET=0` forces HTTP SSE on the same endpoint |
| `agent/mcp.json` | `workflow`, `researcher-mcp`, `hound`, `context7`, `deepwiki` |
| `agent/agents/` | `plan-checker`, `researcher`, `document-proofreader` (verbatim rice-opencode prompts, omp frontmatter); `reviewer` (omp's bundled reviewer + architecture/code-smell pillars from `code-checker`) |
| `agent/skills/` | `workflow-plan`, `workflow-execute`, `git-commit`, `frontend-design` |
| `agent/mcp/workflow/` | Workplan MCP (8 `workplan_*` tools), stored per workspace in `.omp/workplan/` |
| `agent/mcp/researcher-mcp/` | Vendored Go source of [researcher-mcp](https://github.com/hoshinoht/researcher-mcp) + build-on-launch `run.sh` |
| `agent/mcp/hound/run.sh` | Hound (`uvx hound-mcp[all]==12.4.1`) launcher; installs patchright Chromium for that environment if missing |

Change which model an agent uses by editing `modelRoles` in `config.yml` (or `/model` → Roles), not the agent files.

Exa is not an MCP entry: omp folds Exa MCP servers into its native `web_search`, so routing uses `web_search` with `modelRoles.web: web/exa`.

## Not ported (native in omp)

`build`, `swe`, `chat`, `plan` → main session / plan mode · `code-writer` → `task` · `explore` → `scout` · `code-checker` → merged into `reviewer` · opencode-mem, background-agents, notifier, auth plugins, viz → native memory, async tasks, providers, `generate_image`.

## Tests

```sh
cd agent/mcp/workflow && bun install && bun test
```

## License

GPL-2.0 (`LICENSE.md`). Vendored `agent/mcp/researcher-mcp/src` remains MIT (its own `LICENSE`).
