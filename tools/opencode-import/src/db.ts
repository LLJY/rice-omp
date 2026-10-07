/**
 * Read-only access to the OpenCode (1.18.x) SQLite store.
 *
 * Opened with bun:sqlite `{ readonly: true }`, i.e. SQLITE_OPEN_READONLY: the connection can never write, and it
 * coexists with a live OpenCode writer in WAL mode (verified against a ~39 GB database with a running writer).
 * This is the same guarantee the sqlite3 CLI gave with `file:...?mode=ro`, so the CLI is not needed. Never open
 * with `immutable`: on a live WAL database that would ignore the -wal file and read a stale snapshot.
 *
 * The `message`/`part` tables can be tens of GB. They are only ever queried by `session_id` through the
 * per-session indexes, one short read transaction per session. The `session` table is small and is read whole.
 */
import { Database } from "bun:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Json = any;

export interface SessionRow {
  id: string;
  parent_id: string | null;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
}

export interface SourcePart {
  id: string;
  created: number;
  data: Json;
}

export interface SourceMessage {
  id: string;
  created: number;
  info: Json;
  parts: SourcePart[];
}

export interface SourceSession {
  /** Full `session` row. */
  session: Json;
  messages: SourceMessage[];
  /** `session_message` rows (OpenCode v2 control records), if the table exists. */
  control: Json[];
  /** Direct children, oldest first. */
  children: { id: string; title: string }[];
  /** Size of the JSON loaded for this session, for throughput reporting. */
  bytes: number;
  /** Message/part rows whose JSON did not parse; kept as `{ type: "unparsed", raw }` parts or skipped messages. */
  unparsedRows: number;
  /** Source revision captured in the same read transaction as the rows above (see {@link revisionOf}). */
  revision: string;
}

export function defaultDbPath(env: Record<string, string | undefined> = process.env): string {
  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "opencode.db");
}

export function safeParse(text: unknown): Json {
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Keeps `sum()` of millisecond timestamps exact in a JS number (each term < 2^30, so 9e6 rows stay under 2^53). */
const SUM_MOD = 1_000_000_007;

interface Aggregate {
  count: number;
  /** max(time_updated) for message/part rows, max(seq) for control rows; 0 when empty. */
  max: number;
  /** sum(time_updated % SUM_MOD) (seq for control rows): moves when any single row's timestamp moves, not just the newest. */
  sum: number;
}

/**
 * Revision of one session's imported source: the whole `session` row (title, revert, directory, cost, tokens,
 * `time_updated`, ...) plus, for its messages, parts and control rows, the row count, the newest `time_updated`
 * and a sum of all of them. `session.time_updated` alone is not enough: OpenCode edits titles, messages and parts
 * without advancing it. The one thing this cannot see is a row rewritten in place without its own `time_updated`
 * moving; OpenCode's projectors advance a row's `time_updated` when they update it.
 */
export function revisionOf(sessionRow: Json, messages: Aggregate, parts: Aggregate, control: Aggregate): string {
  const text = JSON.stringify([sessionRow, [messages.count, messages.max, messages.sum], [parts.count, parts.max, parts.sum], [control.count, control.max, control.sum]]);
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export class OpenCodeDb {
  readonly #db: Database;
  readonly #indexes: Set<string>;
  readonly #hasControlTable: boolean;
  readonly #sessionColumns: Set<string>;

  constructor(readonly file: string) {
    if (!fs.existsSync(file)) throw new Error(`OpenCode database not found: ${file}`);
    this.#db = new Database(file, { readonly: true });
    // Fail early (and readably) on a database that is not an OpenCode store.
    const names = new Set((this.#db.query("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as { name: string }[]).map(r => r.name));
    for (const table of ["session", "message", "part"]) {
      if (!names.has(table)) throw new Error(`${file} has no '${table}' table; not an OpenCode 1.x SQLite store`);
    }
    this.#indexes = names;
    this.#hasControlTable = names.has("session_message");
    this.#sessionColumns = new Set((this.#db.query("PRAGMA table_info(session)").all() as { name: string }[]).map(r => r.name));
  }

  close(): void {
    this.#db.close();
  }

  /** `INDEXED BY` clause when the index exists in this database's schema, else nothing (the planner decides). */
  #hint(index: string): string {
    return this.#indexes.has(index) ? `INDEXED BY ${index}` : "";
  }

  /** Every session row (small table; safe to scan). */
  listSessions(): SessionRow[] {
    // Older schemas may lack the aggregate columns; they come back NULL there.
    const optional = ["cost", "tokens_input", "tokens_output", "tokens_reasoning", "tokens_cache_read", "tokens_cache_write"]
      .map(c => (this.#sessionColumns.has(c) ? c : `NULL AS ${c}`))
      .join(", ");
    return this.#db.query(`SELECT id, parent_id, directory, title, time_created, time_updated, ${optional} FROM session`).all() as SessionRow[];
  }

  /** Number of messages in one session (index-only count for that session). */
  countMessages(sessionId: string): number {
    const row = this.#db
      .query(`SELECT count(*) AS n FROM message ${this.#hint("message_session_time_created_id_idx")} WHERE session_id = ?`)
      .get(sessionId) as { n: number };
    return row.n;
  }

  /**
   * Current {@link revisionOf} of a session via per-session aggregate queries (indexed by `session_id`), for
   * comparing against a recorded import without loading the transcript. Equal to `load(id).revision` on an
   * unchanged session.
   */
  revision(sessionId: string): string | undefined {
    this.#db.exec("BEGIN");
    try {
      const session = this.#db.query("SELECT * FROM session WHERE id = ?").get(sessionId) as Json;
      if (!session) return undefined;
      const aggregate = (sql: string): Aggregate => {
        const row = this.#db.query(sql).get(sessionId) as { n: number; m: number | null; s: number | null };
        return { count: row.n, max: row.m ?? 0, sum: row.s ?? 0 };
      };
      const timestamps = (table: string, index: string) =>
        aggregate(`SELECT count(*) AS n, max(time_updated) AS m, sum(time_updated % ${SUM_MOD}) AS s FROM ${table} ${this.#hint(index)} WHERE session_id = ?`);
      const messages = timestamps("message", "message_session_time_created_id_idx");
      const parts = timestamps("part", "part_session_idx");
      const control = this.#hasControlTable
        ? aggregate(`SELECT count(*) AS n, max(seq) AS m, sum(seq % ${SUM_MOD}) AS s FROM session_message ${this.#hint("session_message_session_seq_idx")} WHERE session_id = ?`)
        : { count: 0, max: 0, sum: 0 };
      return revisionOf(session, messages, parts, control);
    } finally {
      this.#db.exec("COMMIT");
    }
  }

  /** One session's rows inside a single short read transaction, so a live writer cannot tear the snapshot. */
  load(sessionId: string): SourceSession {
    this.#db.exec("BEGIN");
    try {
      const session = this.#db.query("SELECT * FROM session WHERE id = ?").get(sessionId) as Json;
      if (!session) throw new Error(`OpenCode session ${sessionId} not found`);
      const messageRows = this.#db
        .query(`SELECT id, time_created, time_updated, data FROM message ${this.#hint("message_session_time_created_id_idx")} WHERE session_id = ? ORDER BY time_created, id`)
        .all(sessionId) as { id: string; time_created: number; time_updated: number; data: string }[];
      const partRows = this.#db
        .query(`SELECT id, message_id, time_created, time_updated, data FROM part ${this.#hint("part_session_idx")} WHERE session_id = ?`)
        .all(sessionId) as { id: string; message_id: string; time_created: number; time_updated: number; data: string }[];
      const controlRows = this.#hasControlTable
        ? (this.#db
            .query(`SELECT id, type, seq, time_created, data FROM session_message ${this.#hint("session_message_session_seq_idx")} WHERE session_id = ? ORDER BY seq`)
            .all(sessionId) as Json[])
        : [];
      const children = this.#db
        .query(`SELECT id, title FROM session ${this.#hint("session_parent_idx")} WHERE parent_id = ? ORDER BY time_created, id`)
        .all(sessionId) as { id: string; title: string }[];

      let bytes = 0;
      let unparsedRows = 0;
      const parseRow = (text: string, kind: "part" | "message"): Json => {
        try {
          return JSON.parse(text);
        } catch {
          unparsedRows++;
          return kind === "part" ? { type: "unparsed", raw: text } : { role: "unparsed", raw: text };
        }
      };
      let partMax = 0;
      let partSum = 0;
      const byMessage = new Map<string, SourcePart[]>();
      for (const row of partRows) {
        bytes += row.data.length;
        if (row.time_updated > partMax) partMax = row.time_updated;
        partSum += row.time_updated % SUM_MOD;
        const list = byMessage.get(row.message_id) ?? [];
        list.push({ id: row.id, created: row.time_created, data: parseRow(row.data, "part") });
        byMessage.set(row.message_id, list);
      }
      let messageMax = 0;
      let messageSum = 0;
      const messages = messageRows.map(row => {
        bytes += row.data.length;
        if (row.time_updated > messageMax) messageMax = row.time_updated;
        messageSum += row.time_updated % SUM_MOD;
        return {
          id: row.id,
          created: row.time_created,
          info: parseRow(row.data, "message"),
          parts: (byMessage.get(row.id) ?? []).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        };
      });
      const controlMax = controlRows.reduce((max, r) => Math.max(max, Number(r.seq) || 0), 0);
      const controlSum = controlRows.reduce((sum, r) => sum + ((Number(r.seq) || 0) % SUM_MOD), 0);
      const revision = revisionOf(
        session,
        { count: messageRows.length, max: messageMax, sum: messageSum },
        { count: partRows.length, max: partMax, sum: partSum },
        { count: controlRows.length, max: controlMax, sum: controlSum },
      );
      return { session, messages, control: controlRows.map(r => ({ ...r, data: safeParse(r.data) })), children, bytes, unparsedRows, revision };
    } finally {
      this.#db.exec("COMMIT");
    }
  }
}

/** Parent -> children index over the session table. */
export class SessionTree {
  readonly byId = new Map<string, SessionRow>();
  readonly #children = new Map<string, SessionRow[]>();

  constructor(rows: SessionRow[]) {
    for (const row of rows) this.byId.set(row.id, row);
    for (const row of rows) {
      if (!row.parent_id) continue;
      const list = this.#children.get(row.parent_id) ?? [];
      list.push(row);
      this.#children.set(row.parent_id, list);
    }
    for (const list of this.#children.values()) list.sort((a, b) => a.time_created - b.time_created || (a.id < b.id ? -1 : 1));
  }

  children(id: string): SessionRow[] {
    return this.#children.get(id) ?? [];
  }

  /** `id` followed by every descendant (depth-first). Cycle-safe. */
  subtree(id: string): SessionRow[] {
    const out: SessionRow[] = [];
    const seen = new Set<string>();
    const walk = (current: string) => {
      const row = this.byId.get(current);
      if (!row || seen.has(current)) return;
      seen.add(current);
      out.push(row);
      for (const child of this.children(current)) walk(child.id);
    };
    walk(id);
    return out;
  }
}
