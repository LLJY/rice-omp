/**
 * Synthetic OpenCode database built from the real schema (tests/schema.sql). No user data: every row is made up here.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, any>;

export const T = Date.UTC(2026, 8, 1); // fixture epoch (ms); all fixture times are offsets from it

export interface SessionSpec {
  id: string;
  parent?: string;
  directory: string;
  title: string;
  updated: number;
  created?: number;
  revert?: Json;
}

export class FixtureDb {
  readonly db: Database;
  #seq = 0;

  constructor(readonly file: string) {
    this.db = new Database(file, { create: true });
    this.db.exec("PRAGMA foreign_keys = OFF");
    this.db.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
  }

  session(spec: SessionSpec): void {
    this.db
      .query(
        `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, revert, cost, tokens_input, tokens_output)
         VALUES (?, 'prj_test', ?, ?, ?, ?, '1.18.19', ?, ?, ?, 0.5, 100, 50)`,
      )
      .run(spec.id, spec.parent ?? null, spec.id, spec.directory, spec.title, spec.created ?? spec.updated - 10, spec.updated, spec.revert ? JSON.stringify(spec.revert) : null);
  }

  touchSession(id: string, updated: number): void {
    this.db.query("UPDATE session SET time_updated = ? WHERE id = ?").run(updated, id);
  }

  #message(sessionId: string, id: string, info: Json, parts: Json[]): void {
    const created = T + ++this.#seq * 1000;
    this.db.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(id, sessionId, created, created, JSON.stringify({ ...info, time: { created, completed: created + 500 } }));
    parts.forEach((data, i) => {
      // Part ids sort in insertion order within a message, as OpenCode's ascending ids do.
      this.db.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(`${id}_p${String(i + 1).padStart(2, "0")}`, id, sessionId, created + i, created + i, JSON.stringify(data));
    });
  }

  user(sessionId: string, id: string, text: string, extra: Json[] = []): void {
    this.#message(sessionId, id, { role: "user", agent: "build", model: { providerID: "openai", modelID: "gpt-test" } }, [{ type: "text", text }, ...extra]);
  }

  /** Assistant message whose parts are wrapped in one step (step-start ... step-finish). */
  assistant(sessionId: string, id: string, parentId: string, parts: Json[], info: Json = {}): void {
    const finish = { type: "step-finish", reason: "stop", tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.01 };
    this.#message(sessionId, id, { role: "assistant", parentID: parentId, providerID: "openai", modelID: "gpt-test", finish: "stop", tokens: finish.tokens, cost: 0.01, ...info }, [{ type: "step-start" }, ...parts, finish]);
  }

  /** Summary assistant message for a compaction request. */
  summary(sessionId: string, id: string, compactionId: string, text: string): void {
    this.assistant(sessionId, id, compactionId, [{ type: "text", text }], { summary: true });
  }

  close(): void {
    this.db.close();
  }
}

export const text = (value: string): Json => ({ type: "text", text: value });

export function tool(callID: string, name: string, state: Json): Json {
  return { type: "tool", callID, tool: name, state: { time: { start: T, end: T + 2000 }, ...state } };
}

export const taskWrapped = (id: string, result: string) => `<task id="${id}" state="completed">\n<task_result>\n${result}\n</task_result>\n</task>`;

/** A task call whose result carries the child session id, as OpenCode records it. */
export function taskCall(callID: string, parent: string, child: string, description: string, agentType: string, result: string, resume = false): Json {
  return tool(callID, "task", {
    status: "completed",
    input: { subagent_type: agentType, description, prompt: `prompt for ${description}`, ...(resume ? { task_id: child } : {}) },
    metadata: { parentSessionId: parent, sessionId: child, model: { providerID: "openai", modelID: "gpt-child" }, truncated: false },
    title: description,
    output: taskWrapped(child, result),
  });
}

export const MISSING_DIR = "/nonexistent/opencode-import-fixture";

/**
 * The standard fixture. `cwd` must exist (sessions that should resolve their cwd use it).
 *
 *   ses_tools        tool call/result pairing: completed, error, never-finished, interrupted-with-partial-output
 *   ses_ctail        compaction with a retained tail          ses_cnotail    compaction without one
 *   ses_revwhole     whole-message revert                     ses_revpart    partial-message revert
 *   ses_parent       root updated recently; children updated long before it:
 *     ses_childA     -> ses_grand (nested)                    ses_childB
 *   ses_old          root outside any recent --since window
 *   ses_missingcwd   root whose directory does not exist
 *   ses_projA, ses_projA2 (inside /work/a), ses_projAB (/work/ab: a prefix, not a subdirectory)
 *   ses_revparent    root with two reverted children: ses_revW (whole-message revert), ses_revP (partial-message revert)
 */
export function buildStandardFixture(file: string, cwd: string): FixtureDb {
  const f = new FixtureDb(file);
  const roots: [string, number][] = [["ses_tools", 100], ["ses_ctail", 200], ["ses_cnotail", 300], ["ses_revwhole", 400], ["ses_revpart", 500]];
  for (const [id, dt] of roots) f.session({ id, directory: cwd, title: `session ${id}`, updated: T + dt * 1000 });

  // -- tool pairing
  f.user("ses_tools", "t_u1", "Please run the tools");
  f.assistant("ses_tools", "t_a1", "t_u1", [
    text("Running tools"),
    tool("c_ok", "bash", { status: "completed", input: { command: "ls" }, output: "file-a\nfile-b", title: "ls", metadata: {} }),
    tool("c_err", "bash", { status: "error", input: { command: "false" }, error: "command failed: exit 2" }),
    tool("c_run", "bash", { status: "running", input: { command: "sleep 99" } }),
    tool("c_int", "read", { status: "error", input: { filePath: "/x" }, error: "Tool execution aborted", metadata: { interrupted: true, output: "partial output" } }),
  ]);
  f.user("ses_tools", "t_u2", "thanks");
  f.assistant("ses_tools", "t_a2", "t_u2", [text("You're welcome")]);

  // -- compaction: u1 a1 [u2 a2 = tail] compaction summary u3 a3
  for (const [sid, tail] of [["ses_ctail", true], ["ses_cnotail", false]] as const) {
    const p = sid === "ses_ctail" ? "ct" : "cn";
    f.user(sid, `${p}_u1`, "first question");
    f.assistant(sid, `${p}_a1`, `${p}_u1`, [text("first answer")]);
    f.user(sid, `${p}_u2`, "tail question");
    f.assistant(sid, `${p}_a2`, `${p}_u2`, [text("tail answer")]);
    f.user(sid, `${p}_uc`, "", [{ type: "compaction", auto: true, ...(tail ? { tail_start_id: `${p}_u2` } : {}) }]);
    f.summary(sid, `${p}_s`, `${p}_uc`, "SUMMARY OF EARLIER WORK");
    f.user(sid, `${p}_u3`, "after question");
    f.assistant(sid, `${p}_a3`, `${p}_u3`, [text("after answer")]);
  }

  // -- whole revert: m3/m4 are reverted
  f.user("ses_revwhole", "rw_u1", "keep question");
  f.assistant("ses_revwhole", "rw_a1", "rw_u1", [text("keep answer")]);
  f.user("ses_revwhole", "rw_u2", "reverted question");
  f.assistant("ses_revwhole", "rw_a2", "rw_u2", [text("reverted answer")]);
  f.db.query("UPDATE session SET revert = ? WHERE id = 'ses_revwhole'").run(JSON.stringify({ messageID: "rw_u2" }));

  // -- partial revert: inside rp_a1, parts before p03 stay (step-start, "kept text"); p03 onward and later messages go
  f.user("ses_revpart", "rp_u1", "partial question");
  f.assistant("ses_revpart", "rp_a1", "rp_u1", [text("kept text"), text("dropped text")]);
  f.user("ses_revpart", "rp_u2", "later question");
  f.assistant("ses_revpart", "rp_a2", "rp_u2", [text("later answer")]);
  f.db.query("UPDATE session SET revert = ? WHERE id = 'ses_revpart'").run(JSON.stringify({ messageID: "rp_a1", partID: "rp_a1_p03" }));

  // -- subagents
  f.session({ id: "ses_parent", directory: cwd, title: "parent session", updated: T + 5000 * 1000 });
  f.session({ id: "ses_childA", parent: "ses_parent", directory: cwd, title: "Validate fallback plan (@plan-checker subagent)", updated: T + 10 * 1000, created: T + 1 });
  f.session({ id: "ses_childB", parent: "ses_parent", directory: cwd, title: "Implement fix (@code-writer subagent)", updated: T + 20 * 1000, created: T + 2 });
  f.session({ id: "ses_grand", parent: "ses_childA", directory: cwd, title: "Dig deeper (@general subagent)", updated: T + 5 * 1000, created: T + 3 });
  f.user("ses_parent", "p_u1", "delegate the work");
  f.assistant("ses_parent", "p_a1", "p_u1", [
    taskCall("c_t1", "ses_parent", "ses_childA", "Validate fallback plan", "plan-checker", "PLAN OK"),
    taskCall("c_t2", "ses_parent", "ses_childA", "Recheck plan", "plan-checker", "PLAN STILL OK", true),
    taskCall("c_t3", "ses_parent", "ses_childB", "Implement fix", "code-writer", "FIX DONE"),
    tool("c_t4", "task", { status: "error", input: { prompt: "undefined" }, metadata: { interrupted: true }, error: "aborted" }),
    tool("c_t5", "task", { status: "completed", input: { subagent_type: "general", description: "Foreign child", prompt: "p" }, metadata: { sessionId: "ses_not_a_child" }, output: taskWrapped("ses_not_a_child", "FOREIGN RESULT") }),
  ]);
  f.user("ses_parent", "p_u2", "what did they say?");
  f.assistant("ses_parent", "p_a2", "p_u2", [text("All delegated.")]);
  f.user("ses_childA", "ca_u1", "prompt for Validate fallback plan");
  f.assistant("ses_childA", "ca_a1", "ca_u1", [taskCall("c_g1", "ses_childA", "ses_grand", "Dig deeper", "general", "GRAND RESULT"), text("PLAN STILL OK")]);
  f.user("ses_grand", "g_u1", "prompt for Dig deeper");
  f.assistant("ses_grand", "g_a1", "g_u1", [text("GRAND RESULT")]);
  f.user("ses_childB", "cb_u1", "prompt for Implement fix");
  f.assistant("ses_childB", "cb_a1", "cb_u1", [text("FIX DONE")]);

  // -- children whose own transcripts were reverted: agent://<id> must show what survives the revert
  f.session({ id: "ses_revparent", directory: cwd, title: "revert parent", updated: T + 900 * 1000 });
  f.session({ id: "ses_revW", parent: "ses_revparent", directory: cwd, title: "Whole revert child (@general subagent)", updated: T + 11 * 1000, created: T + 1 });
  f.session({ id: "ses_revP", parent: "ses_revparent", directory: cwd, title: "Partial revert child (@general subagent)", updated: T + 12 * 1000, created: T + 2 });
  f.user("ses_revparent", "rv_u1", "delegate");
  f.assistant("ses_revparent", "rv_a1", "rv_u1", [
    taskCall("c_rw", "ses_revparent", "ses_revW", "Whole revert child", "general", "WHOLE CHILD LAST OUTPUT"),
    taskCall("c_rp", "ses_revparent", "ses_revP", "Partial revert child", "general", "PARTIAL CHILD LAST OUTPUT"),
  ]);
  f.user("ses_revW", "rw2_u1", "first child question");
  f.assistant("ses_revW", "rw2_a1", "rw2_u1", [text("kept child answer")]);
  f.user("ses_revW", "rw2_u2", "second child question");
  f.assistant("ses_revW", "rw2_a2", "rw2_u2", [text("reverted child answer")]);
  f.db.query("UPDATE session SET revert = ? WHERE id = 'ses_revW'").run(JSON.stringify({ messageID: "rw2_u2" }));
  f.user("ses_revP", "rp2_u1", "child question");
  f.assistant("ses_revP", "rp2_a1", "rp2_u1", [text("kept part answer"), text("dropped part answer")]);
  f.user("ses_revP", "rp2_u2", "later child question");
  f.assistant("ses_revP", "rp2_a2", "rp2_u2", [text("later child answer")]);
  f.db.query("UPDATE session SET revert = ? WHERE id = 'ses_revP'").run(JSON.stringify({ messageID: "rp2_a1", partID: "rp2_a1_p03" }));

  // -- selection helpers
  f.session({ id: "ses_old", directory: cwd, title: "old session", updated: T - 100_000 * 1000 });
  f.user("ses_old", "o_u1", "old question");
  f.assistant("ses_old", "o_a1", "o_u1", [text("old answer")]);
  f.session({ id: "ses_missingcwd", directory: MISSING_DIR, title: "missing cwd session", updated: T + 600 * 1000 });
  f.user("ses_missingcwd", "m_u1", "where am I");
  f.assistant("ses_missingcwd", "m_a1", "m_u1", [text("nowhere")]);
  for (const [id, dir] of [["ses_projA", "/work/a"], ["ses_projA2", "/work/a/sub"], ["ses_projAB", "/work/ab"]] as const) {
    f.session({ id, directory: dir, title: `project ${id}`, updated: T + 700 * 1000 });
    f.user(id, `${id}_u1`, "q");
    f.assistant(id, `${id}_a1`, `${id}_u1`, [text("a")]);
  }
  return f;
}
