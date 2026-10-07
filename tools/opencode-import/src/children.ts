/**
 * Subagent (child session) linking, matching how omp stores its own subagents.
 *
 * Native layout (src/task/executor.ts, src/task/output-manager.ts, src/session/sub-sessions.ts):
 *   <dir>/<ts>_<uuid>.jsonl                      parent session
 *   <dir>/<ts>_<uuid>/<AgentId>.jsonl            subagent transcript; header.parentSession = parent file path
 *   <dir>/<ts>_<uuid>/<AgentId>.md               subagent's final output (what `agent://<AgentId>` reads)
 *   <dir>/<ts>_<uuid>/<AgentId>/<AgentId>.<Child>.jsonl   nested subagent: ids are dot-qualified by the owner's id
 *
 * AgentIds come from the task's requested name, restricted to [A-Za-z0-9_-], at most 48 characters, unique per
 * session (`Name`, `Name-2`, ...). The parent's `task` tool result carries `details.results[].id` = the AgentId
 * (TUI task cards and the HTML export use it to open the sub-session) and its model-facing text is the
 * `<task-result id="AgentId" ...>` envelope. `history://AgentId` finds `<AgentId>.jsonl` by scanning the
 * caller's artifacts directory; `agent://AgentId` reads `<AgentId>.md` from it.
 */
import * as path from "node:path";
import type { Json, SessionRow, SourceMessage } from "./db";

/** omp's agent-id cap (src/task/structured-subagent.ts sanitizeAgentId). */
const MAX_ID_LENGTH = 48;

export interface ChildLink {
  /** OpenCode session id of the child. */
  sourceId: string;
  /** Fully qualified omp agent id: the child's session-file stem (`Owner.Name` when nested). */
  id: string;
  /** Last segment of `id`. */
  name: string;
  title: string;
  agentType?: string;
  description?: string;
  model?: string;
  /** Aggregate usage of the child session in omp's Usage shape. */
  usage: Json;
  tokens: number;
}

/** Where a child's transcript and final output live, given its owner's artifacts directory. */
export function childPaths(artifactsDir: string, id: string): { sessionFile: string; outputPath: string; ownArtifactsDir: string } {
  return {
    sessionFile: path.join(artifactsDir, `${id}.jsonl`),
    outputPath: path.join(artifactsDir, `${id}.md`),
    ownArtifactsDir: path.join(artifactsDir, id),
  };
}

/** `Validate fallback fix plan` -> `ValidateFallbackFixPlan`; only characters omp allows in an agent id. */
export function pascalId(text: string): string {
  const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join("")
    .slice(0, MAX_ID_LENGTH);
}

/** `Title (@plan-checker subagent)` -> `Title`. */
function stripSubagentSuffix(title: string): string {
  return title.replace(/\s*\(@[^)]*subagent\)\s*$/, "").trim();
}

interface TaskCall {
  childId: string;
  agentType?: string;
  description?: string;
  model?: string;
}

/** The parent's `task` tool calls that reference a child session, in transcript order. */
function taskCalls(messages: SourceMessage[]): TaskCall[] {
  const calls: TaskCall[] = [];
  for (const m of messages) {
    for (const p of m.parts) {
      const d = p.data;
      if (d.type !== "tool" || d.tool !== "task") continue;
      const meta = d.state?.metadata;
      if (typeof meta?.sessionId !== "string") continue;
      const model = meta.model?.providerID && meta.model?.modelID ? `${meta.model.providerID}/${meta.model.modelID}` : undefined;
      calls.push({ childId: meta.sessionId, agentType: d.state?.input?.subagent_type, description: d.state?.input?.description, model });
    }
  }
  return calls;
}

function usageOf(row: SessionRow): { usage: Json; tokens: number } {
  const input = row.tokens_input ?? 0;
  const reasoning = row.tokens_reasoning ?? 0;
  const output = (row.tokens_output ?? 0) + reasoning;
  const cacheRead = row.tokens_cache_read ?? 0;
  const cacheWrite = row.tokens_cache_write ?? 0;
  return {
    tokens: input + output + cacheWrite,
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: row.cost ?? 0 },
    },
  };
}

/**
 * Assign native agent ids to the direct children of one session.
 *
 * `ownerId` is the owner's own fully qualified agent id (undefined for a root session): omp qualifies nested ids
 * with it (`Owner.Name`). Names come from the parent's `task` call description (what omp's task `name` is for),
 * else the child title. Ids are assigned in child creation order so a re-import reproduces the same names.
 */
export function planChildren(parentMessages: SourceMessage[], children: SessionRow[], ownerId: string | undefined): Map<string, ChildLink> {
  const calls = taskCalls(parentMessages);
  const taken = new Set<string>(["__advisor"]);
  const links = new Map<string, ChildLink>();
  for (const child of children) {
    const first = calls.find(c => c.childId === child.id);
    const base = pascalId(first?.description ?? "") || pascalId(stripSubagentSuffix(child.title)) || pascalId(first?.agentType ?? "") || "Subagent";
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base.slice(0, MAX_ID_LENGTH - String(n).length - 1)}-${n}`;
    taken.add(name.toLowerCase());
    const id = ownerId ? `${ownerId}.${name}` : name;
    links.set(child.id, {
      sourceId: child.id,
      id,
      name,
      title: child.title,
      agentType: first?.agentType,
      description: first?.description,
      model: first?.model,
      ...usageOf(child),
    });
  }
  return links;
}

/** Text inside OpenCode's `<task_result>` wrapper, or the whole output when it is not wrapped. */
export function taskResultText(output: unknown): string {
  const raw = typeof output === "string" ? output : "";
  const m = /<task_result>\n?([\s\S]*?)\n?<\/task_result>/.exec(raw);
  return (m ? m[1] : raw).trim();
}

// Same neutralisation omp applies (src/session/harness-tags.ts): child text must not forge harness blocks.
const HARNESS_TAG_START_RE = /<(?=\s*\/?\s*(?:irc|system-[a-z][a-z-]*)(?![\w-]))/gi;

function formatBytes(n: number): string {
  return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** omp's model-facing `<task-result>` envelope (src/task/result-summary.ts), with the full output inline. */
export function taskEnvelope(link: ChildLink, text: string, durationMs: number): string {
  const body = text === "" ? "(no output)" : text;
  const lines = body.split("\n").length;
  return [
    `<task-result id="${link.id}" agent="${link.agentType ?? "task"}" status="completed" duration="${formatDuration(durationMs)}">`,
    `<meta lines="${lines}" size="${formatBytes(Buffer.byteLength(body))}" />`,
    "<output>",
    body.replace(HARNESS_TAG_START_RE, "&lt;"),
    "</output>",
    "</task-result>",
  ].join("\n");
}
