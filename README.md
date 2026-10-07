# rice-omp

Personal [omp](https://github.com/can1357/oh-my-pi) setup, ported from `rice-opencode` and `good-goose`.

`agent/` mirrors `~/.omp/agent/`. Everything inside it is self-contained; MCP launchers resolve paths relative to `${HOME}/.omp/agent`.

## Install

```sh
./install.sh            # copies agent/* into ~/.omp/agent (backs up clobbered files as *.pre-rice)
./install.sh <dir>      # or into another agent dir, e.g. ~/.omp/profiles/work/agent
```

Copying `agent/`'s contents into `~/.omp/agent/` by hand is equivalent. Restart omp afterwards.

Runtime prerequisites: `bun` (workflow MCP), `go` 1.25+ (researcher-mcp, built on first launch), `uvx` (hound), and the local OpenAI-compatible proxy on `127.0.0.1:8317` with `CPA_KEY` set (the `cpa` provider in `models.yml`).

Optional env (shell or `~/.omp/agent/.env`):

| Variable | Used by |
|---|---|
| `EXA_API_KEY` | native `web_search` via Exa (keyless public endpoint otherwise) |
| `CONTEXT7_API_KEY` | context7 MCP (rate-limited without) |
| `SCHOLAR_CONTACT_EMAIL` | researcher-mcp Unpaywall full-text lookup |

## Contents

| Path | What |
|---|---|
| `agent/APPEND_SYSTEM.md` | Web-research and agent routing rules appended to the default system prompt |
| `agent/config.yml` | `modelRoles`: `review`, `plan-check`, `research`, `proofread` role aliases used by the agents; `web: web/exa`; `disabledProviders: [opencode]` so only native MCP/skill config loads |
| `agent/models.yml` | `cpa` provider (local proxy; key read from env `CPA_KEY`) |
| `agent/mcp.json` | `workflow`, `researcher-mcp`, `hound`, `context7`, `deepwiki` |
| `agent/agents/` | `plan-checker`, `researcher`, `document-proofreader` (verbatim rice-opencode prompts, omp frontmatter); `reviewer` (omp's bundled reviewer + architecture/code-smell pillars from `code-checker`) |
| `agent/skills/` | `workflow-plan`, `workflow-execute`, `git-commit`, `frontend-design` |
| `agent/mcp/workflow/` | Workplan MCP (8 `workplan_*` tools), stored per workspace in `.omp/workplan/` |
| `agent/mcp/researcher-mcp/` | Vendored Go source of [researcher-mcp](https://github.com/hoshinoht/researcher-mcp) + build-on-launch `run.sh` |

Change which model an agent uses by editing `modelRoles` in `config.yml` (or `/model` → Roles), not the agent files.

Exa is not an MCP entry: omp folds Exa MCP servers into its native `web_search`, so routing uses `web_search` with `modelRoles.web: web/exa`.

## Not ported (native in omp)

`build`, `swe`, `chat`, `plan` → main session / plan mode · `code-writer` → `task` · `explore` → `scout` · `code-checker` → merged into `reviewer` · opencode-mem, background-agents, notifier, auth plugins, viz → native memory, async tasks, providers, `generate_image`.

## Tests

```sh
cd agent/mcp/workflow && bun install && bun test
```
