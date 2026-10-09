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
- `frontend-code-writer` — use instead of `task` for UI work (web pages, components, styling, layout, Flutter screens). Runs on the `ui` model role, loads `frontend-design`, verifies with screenshots, keeps styling lean.
- `reviewer` — post-change adversarial correctness, architecture, and code-smell review, recommended once large, cross-dependent code changes are made, as agents WILL make mistakes.
- `sonic` - do not invoke unless user asks for it, or the work is strictly mechanical.

Keep delegated tasks small and scoped. Plan delegation based on difficulty. (i.e. don't plan check a straightforward inconsequential change). User instructed delegation takes precedence.

# Workflows
Only when the user says "use workflow(s)": load `skill://workflow-plan` when planning and `skill://workflow-execute` when executing an approved plan. Workplans persist via the `workflow` MCP `workplan_*` tools under `.omp/workplan/`.
When the user suggests a substantial task scope, point them to the workflow skills (`workflow-plan` / `workflow-execute`, triggered by "use workflows") but do not load them yet.
