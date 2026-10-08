# rice-omp

Personal [omp](https://github.com/can1357/oh-my-pi) setup, ported from `rice-opencode` and `good-goose`.

`agent/` mirrors `~/.omp/agent/`. `install.sh` links its files into the agent dir, so the live config is this git checkout. `mcp.json` launchers point at `${HOME}/.omp/agent`; `install.sh <dir>` writes a rewritten copy for other agent dirs.

## Install

```sh
./install.sh               # link agent/* into ~/.omp/agent (the machine's original files become *.pre-rice)
./install.sh --host NAME   # also layer hosts/NAME/ for this machine (remembered for later runs)
./install.sh <dir>         # or into another agent dir, e.g. ~/.omp/profiles/work/agent
```

omp itself: `curl -fsSL https://omp.sh/install | sh` (official script; installs through bun when present).

Runtime state (`agent.db`, sessions, `web-service.env`) stays in `~/.omp/agent` and is never touched; `.env` only ever gets the one managed host-overlay line below. The links are absolute: re-run `install.sh` after moving the checkout. It refuses to install into the checkout itself, and retires the old static `cpa` `models.yml` from early rice-omp (it would shadow discovery); any other `models.yml` is left alone.

### Per-machine overrides (`hosts/`)

Settings that only one machine should have (e.g. the server running weeks-long agents) live in `hosts/<name>/`, applied with `./install.sh --host <name>`:

| File | Applied as | Typical use |
|---|---|---|
| `hosts/<name>/models.yml` | linked as `~/.omp/agent/models.yml` | per-model `modelOverrides` under `providers.cpa`: `contextWindow` caps (omp compacts relative to the cap), `cost`, `compactionModel` |
| `hosts/<name>/config.yml` | omp config overlay via a managed `PI_CONFIG_FILES=` line in `~/.omp/agent/.env` | `enabledModels` (which chat models `/model` and Ctrl+P offer), role or compaction overrides |

The overlay sits above the shared `config.yml`, and arrays replace rather than merge, so give its `enabledModels` the complete list. Settings saved from omp's `/settings` still go to the shared `config.yml`. ompweb reads only the shared file, so it doesn't show overlay values. ompweb's model editor saves `models.yml` like any other detached edit, and `./install.sh` folds it back into `hosts/<name>/models.yml`. `--no-host` removes the layer.

### Syncing between machines

The repo is the config. Sync it with plain git; push from whichever machine is the source of truth at the time:

```sh
./install.sh # fold back edits from tools that broke a link (below); no-op otherwise
git diff     # settings changed on this machine
git commit -am '...' && git push
git pull     # other machines' changes apply live
```

- `config.yml` changes apply live (omp watches it), `mcp.json` needs `/mcp reload`, and `extensions/` needs an omp restart.
- omp's `/settings` writes through the `config.yml` link. It rewrites the whole file in its own format (block lists, no comments, no final newline), so `config.yml` is kept in that format and stays comment-free; rationale lives in this README.
- ompweb's settings page and `/mcp add --scope user` replace the `config.yml`/`mcp.json` link with a plain file. (ompweb's MCP editor and plain `/mcp add` write the project's `.omp/mcp.json`, not the synced one.) `./install.sh` three-way merges such an edit into the checkout, using the repo version from its previous run as the base, so commits pulled in the meantime survive, then restores the link. On a conflict, or with no base yet, it leaves the checkout alone, keeps the live file as `<file>.local-<timestamp>` and prints the diff.
- Keep secrets out of tracked files: `/mcp add --token` writes a literal `Authorization: Bearer …` header. Put the token in `~/.omp/agent/.env` and reference it as `"!printf %s \"$VAR\""` (as `context7` does); `install.sh` warns when an adopted file contains a literal credential.

Runtime prerequisites: `bun` ≥ 1.4 (workflow MCP; its `bun.lock` format is unreadable by 1.3.x, so run `bun upgrade`), `go` 1.25+ (researcher-mcp, built on first launch), `uvx` (hound; its launcher installs patchright Chromium on first run), and CLIProxyAPI on `127.0.0.1:8317` with `CPA_KEY` set.

Optional env (shell or `~/.omp/agent/.env`):

| Variable | Used by |
|---|---|
| `EXA_API_KEY` | native `web_search` via Exa (keyless public endpoint otherwise) |
| `CONTEXT7_API_KEY` | context7 MCP (rate-limited without) |
| `SCHOLAR_CONTACT_EMAIL` | researcher-mcp Unpaywall full-text lookup |

### Web UI (optional)

[ompweb](https://github.com/kahme247/ompweb) (third-party, MIT) serves a browser UI over the same `~/.omp/agent` sessions and config. We run the fork [LLJY/ompweb](https://github.com/LLJY/ompweb) (branch `rice`: upstream `main` plus our patches), built from source and installed under `~/.local` so no root is needed. Node ≥ 22.19. Install, update and restart steps are in [docs/ompweb.md](docs/ompweb.md).

It binds to loopback; set `OMP_WEB_PASSWORD` before exposing it beyond localhost. Restarting it kills the omp sessions it runs. ompweb shows its own fallbacks for settings absent from `config.yml` and only knows the legacy compaction key: see [docs/ompweb.md](docs/ompweb.md) for what rice-omp pins, the restart caveat and the server checklist.

## Contents

| Path | What |
|---|---|
| `agent/APPEND_SYSTEM.md` | Web-research, agent routing and background-job (`async-result`, end-turn instead of `wait`) rules appended to the default system prompt |
| `agent/config.yml` | `modelRoles`: `review`, `plan-check`, `research`, `proofread` role aliases used by the agents; `web: web/exa`; `disabledProviders: [opencode]` so only native MCP/skill config loads; `compaction.methodOrder: [remote, handoff, soft, shake]` (server-side for GPT, written summaries otherwise; snapcompact deliberately excluded); `memory`, `autolearn`, `retry` pinned at omp's defaults only so ompweb displays them correctly (see [docs/ompweb.md](docs/ompweb.md)); `generate_image.enabled` (off by default in omp; replaces rice-opencode's viz plugin); `display.pinnedAgents: full` and `display.subagentLivePreview`. `tui.mouse` stays at omp's default (off): capturing the mouse takes over terminal wheel scrolling |
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

## Moving OpenCode sessions over

`tools/opencode-import/` converts OpenCode (1.18.x) sessions into native omp sessions, subagent sessions included, so `omp --resume`, `history://` and `agent://` work on them. It reads `opencode.db` read-only and records each import in `.opencode-import.json` in the sessions dir; re-runs skip unchanged sessions and never overwrite ones you've continued in omp (`--force` overrides). See [its README](tools/opencode-import/README.md).

```sh
cd tools/opencode-import
bun src/cli.ts --since 90d --dry-run   # plan only
bun src/cli.ts --since 90d             # import into ~/.omp/agent/sessions
```

## Tests

```sh
cd agent/mcp/workflow && bun install && bun test
cd tools/opencode-import && bun test
```

## License

GPL-2.0 (`LICENSE.md`). Vendored `agent/mcp/researcher-mcp/src` remains MIT (its own `LICENSE`).
