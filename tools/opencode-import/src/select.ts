/**
 * Which OpenCode sessions to import.
 *
 * Selection is by root session. Every selected root brings all of its descendants (recursively, via
 * `session.parent_id`). A child id selected directly is treated as a root of its own subtree (converted standalone,
 * without a parent link); if its ancestor is selected too, the ancestor's bundle already contains it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionRow, SessionTree } from "./db";

export interface Selection {
  /** Explicit OpenCode session ids (positional and --ids-file). */
  ids: string[];
  /** Bulk: every root session. */
  all: boolean;
  /** Bulk: roots with time_updated >= this (ms epoch). */
  since?: number;
  /** Bulk: roots whose directory is this path or inside it. */
  project?: string;
}

export interface SelectionResult {
  /** Roots to import, explicit ids first (in the order given), then bulk matches newest first. */
  roots: SessionRow[];
  /** Explicit ids that are not in the database. */
  unknown: string[];
  /** Explicit ids dropped because an ancestor is selected too: id -> that ancestor. */
  covered: Record<string, string>;
}

const DAY_MS = 86_400_000;

/**
 * `90d` (calendar days back from local midnight today: on 2026-10-07 that is 2026-07-09T00:00 local), `12h`, `4w`,
 * an ISO date (local midnight) or a full ISO timestamp.
 */
export function parseSince(text: string, now: Date = new Date()): number {
  const rel = /^(\d+)([dhw])$/.exec(text.trim());
  if (rel) {
    const n = Number(rel[1]);
    if (rel[2] === "h") return now.getTime() - n * 3_600_000;
    const days = rel[2] === "w" ? n * 7 : n;
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - days);
    return d.getTime();
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime();
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new Error(`--since: cannot parse ${JSON.stringify(text)} (use 90d, 12h, 4w, 2026-07-09 or an ISO timestamp)`);
  return ms;
}

/** `--ids-file`: a JSON array of id strings, or of objects with an `id` field (e.g. a scorer's scores.json). */
export function readIdsFile(file: string): string[] {
  const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(data)) throw new Error(`${file}: expected a JSON array of ids or {id} objects`);
  return data.map((item, i) => {
    if (typeof item === "string") return item;
    if (typeof item === "object" && item !== null && "id" in item && typeof item.id === "string") return item.id;
    throw new Error(`${file}[${i}]: expected an id string or an object with a string "id"`);
  });
}

/** Windows-style paths (`C:\x`, `C:/x`, `\\host\share`) are compared with win32 rules even on another host platform. */
function flavorOf(project: string): path.PlatformPath {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(project) ? path.win32 : path;
}

/** True when `directory` is `project` or inside it, by bounded relative-path check (so `/work/a` excludes `/work/ab`, `C:\` contains `C:\x`). */
export function inProject(directory: string, project: string): boolean {
  const flavor = flavorOf(project);
  const relative = flavor.relative(flavor.resolve(project), flavor.resolve(directory));
  if (relative === "") return true;
  return relative !== ".." && !relative.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(relative);
}

export function selectRoots(tree: SessionTree, selection: Selection): SelectionResult {
  const picked = new Map<string, SessionRow>();
  const unknown: string[] = [];
  for (const id of selection.ids) {
    const row = tree.byId.get(id);
    if (row) picked.set(id, row);
    else if (!unknown.includes(id)) unknown.push(id);
  }

  const bulk = selection.all || selection.since !== undefined || selection.project !== undefined;
  if (bulk) {
    const project = selection.project;
    const matches = [...tree.byId.values()]
      // An orphan (parent row missing) has nothing above it, so it is a root for selection purposes.
      .filter(row => !row.parent_id || !tree.byId.has(row.parent_id))
      .filter(row => selection.since === undefined || row.time_updated >= selection.since)
      .filter(row => project === undefined || inProject(row.directory, project))
      .sort((a, b) => b.time_updated - a.time_updated || (a.id < b.id ? -1 : 1));
    for (const row of matches) if (!picked.has(row.id)) picked.set(row.id, row);
  }

  const covered: Record<string, string> = {};
  const roots: SessionRow[] = [];
  for (const row of picked.values()) {
    const seen = new Set<string>([row.id]);
    let ancestor = row.parent_id ? tree.byId.get(row.parent_id) : undefined;
    let owner: string | undefined;
    while (ancestor && !seen.has(ancestor.id)) {
      if (picked.has(ancestor.id)) owner = ancestor.id; // keep climbing: the outermost selected ancestor owns it
      seen.add(ancestor.id);
      ancestor = ancestor.parent_id ? tree.byId.get(ancestor.parent_id) : undefined;
    }
    if (owner) covered[row.id] = owner;
    else roots.push(row);
  }
  return { roots, unknown, covered };
}
