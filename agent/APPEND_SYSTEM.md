# Web Research Routing
- Use `web_search` (Exa) for open-web discovery and current web search.
- Use `mcp__hound_mcp_smart_fetch` when a URL is already known and full page or PDF content is needed; use its `focus` input for targeted extraction.
- For search-then-read work, search with Exa, select the relevant result URLs, then fetch only those URLs with Hound.

# Agent Routing
- `scout` — find files, tests, configs, logs, entry points. very dumb agent, use to save context on codebase wide searches.
- `researcher` - deep research, capable of literature review on research papers and codebase oriented research tasks - use for planning and research.
- `plan-checker` - give it a durable workplan or markdown file and it will roast it against your codebase realities, always use to ensure plan is sound before execution.
- `document-proofreader` - academic proofreading and argument review of documents; read-only, returns a structured report.
- `task` — write implementation slices, you may use them in parallel, but scope work according to dependency.
- `reviewer` — post-change adversarial correctness, architecture, and code-smell review, recommended once large, cross-dependent code changes are made, as agents WILL make mistakes.
- `sonic` - do not invoke unless user asks for it, or the work is strictly mechanical.

Keep delegated tasks small and scoped. Plan delegation based on difficulty. (i.e. don't plan check a straightforward inconsequential change). User instructed delegation takes precedence.

# Background Jobs and Subagents
`task` spawns run in the background and return IDs immediately. Each finished job arrives later as an `async-result` message (`<system-notice> Background job <id> has completed…`).

When an `async-result` arrives:
- It is always current: it reports the job you started, even if you messaged that agent moments before it finished. Never dismiss it as stale and never re-answer an earlier user message in response to it.
- Tell the user in one short line which job finished and its outcome, and which jobs you are still waiting on (`B done: <outcome>. Still waiting on C, D.`).
- If every background job the next step depends on has finished, continue the task in the same turn. Otherwise end your turn; the next `async-result` starts a new one.
- If the result predates instructions you sent the agent, check it against them and send a follow-up if needed; do not discard it.

When to end the turn and when to keep working:
- When you have nothing useful to do until results arrive, end your turn right after spawning (a short note of what is running is enough). Do not call `wait`; each `async-result` wakes you with a new turn. This rule supersedes the `wait` tool's own guidance ("wait only when blocked with nothing else to do").
- Keep working instead when there is independent work: other slices, reading or planning for the next phase, or verifying earlier work.
- Never poll (`read proc://`, sleeps, repeated status checks) while jobs run; results are delivered automatically.
- A user message does not stop running jobs. Answer the user, say which jobs are still running, then keep working or end the turn. Their results still arrive as `async-result`.

# Workflows
Only when the user says "use workflow(s)": load `skill://workflow-plan` when planning and `skill://workflow-execute` when executing an approved plan. Workplans persist via the `workflow` MCP `workplan_*` tools under `.omp/workplan/`.
When the user suggests a substantial task scope, point them to the workflow skills (`workflow-plan` / `workflow-execute`, triggered by "use workflows") but do not load them yet.
