#!/usr/bin/env bun
/**
 * opencode-import: convert OpenCode (SQLite) sessions, subagents included, into native omp sessions.
 * See README.md. Progress goes to stderr; the plan / final summary goes to stdout.
 */
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { defaultDbPath } from "./db";
import { type Plan, type Summary, runImport } from "./import";
import { type Selection, parseSince, readIdsFile } from "./select";

const USAGE = `usage: opencode-import [selection] [options] [ses_...]...

selection (roots; every selected root brings all its descendants):
  ses_...               explicit OpenCode session ids (a child id converts its own subtree)
  --ids-file FILE       JSON array of ids, or of objects with an "id" field
  --all                 every root session
  --since 90d|DATE      roots with time_updated since: 90d, 12h, 4w, 2026-07-09 (local midnight), ISO timestamp
  --project DIR         roots whose directory is DIR or inside it
                        (--all/--since/--project combine with AND; explicit ids are always included)

options:
  --db FILE             OpenCode database (default: \${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db)
  --session-dir DIR     write flat into DIR (omp --session-dir layout) instead of omp's per-cwd directories
  --dry-run             print the plan (roots, descendants, message counts, status); write nothing
  --force               re-convert even when unchanged or modified after a previous import
  --fallback-cwd DIR    re-root sessions whose source directory no longer exists (default: keep the source cwd)
  --default-model P/M   omp model that sessions with no resolvable source model resume on
                        (default: omp's configured modelRoles.default, if omp can resolve it)
  -h, --help
`;

function usageError(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        all: { type: "boolean" },
        since: { type: "string" },
        project: { type: "string" },
        "ids-file": { type: "string" },
        db: { type: "string" },
        "session-dir": { type: "string" },
        "dry-run": { type: "boolean" },
        force: { type: "boolean" },
        "fallback-cwd": { type: "string" },
        "default-model": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return usageError((error as Error).message);
  }
})();

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const ids = [...positionals];
let selection: Selection;
try {
  if (values["ids-file"]) ids.push(...readIdsFile(values["ids-file"]));
  selection = {
    ids,
    all: values.all === true,
    since: values.since === undefined ? undefined : parseSince(values.since),
    project: values.project,
  };
} catch (error) {
  usageError((error as Error).message);
}
if (ids.length === 0 && !selection.all && selection.since === undefined && selection.project === undefined) {
  usageError("nothing selected: give session ids, --ids-file, --all, --since or --project");
}

const fmtTime = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const home = os.homedir();
const tilde = (p: string) => (p === home || p.startsWith(`${home}${path.sep}`) ? `~${p.slice(home.length)}` : p);

function printPlan(plan: Plan, dbPath: string): void {
  const out = (line: string) => console.log(line);
  out(`opencode-import plan (dry run, nothing written)`);
  out(`  database:    ${dbPath}`);
  out(`  destination: ${plan.destination}`);
  out(`  manifest:    ${path.join(plan.manifestDir, ".opencode-import.json")}`);
  for (const id of plan.unknown) out(`  warning: ${id} is not in the database`);
  for (const [id, owner] of Object.entries(plan.covered)) out(`  note: ${id} is part of ${owner}'s subtree`);
  if (plan.pendingIntents.length > 0) out(`  note: ${plan.pendingIntents.length} interrupted import(s) (${plan.pendingIntents.join(", ")}) will be recovered by the next real run`);
  out("");
  out(`${"status".padEnd(9)} ${"root".padEnd(30)} ${"updated".padEnd(16)} ${"desc".padStart(5)} ${"msgs(root)".padStart(11)} ${"msgs(all)".padStart(10)}  cwd / title`);
  const byStatus: Record<string, number> = {};
  let descendants = 0;
  let rootMessages = 0;
  let totalMessages = 0;
  for (const e of plan.entries) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    descendants += e.descendants;
    rootMessages += e.rootMessages;
    totalMessages += e.totalMessages;
    out(
      `${e.status.padEnd(9)} ${e.root.id.padEnd(30)} ${fmtTime(e.root.time_updated).padEnd(16)} ${String(e.descendants).padStart(5)} ${String(e.rootMessages).padStart(11)} ${String(e.totalMessages).padStart(10)}  ${tilde(e.root.directory)}  ${JSON.stringify(clip(e.root.title, 50))}${e.reason ? `  [${e.reason}]` : ""}`,
    );
  }
  out("");
  const withKids = plan.entries.filter(e => e.descendants > 0).length;
  out(`roots: ${plan.entries.length} (${withKids} with subagents)  descendants: ${descendants}  sessions: ${plan.entries.length + descendants}`);
  out(`messages: ${totalMessages} (roots ${rootMessages}, descendants ${totalMessages - rootMessages})`);
  out(`status: ${["new", "updated", "unchanged", "diverged"].map(s => `${s} ${byStatus[s] ?? 0}`).join(", ")}`);
}

function printSummary(summary: Summary): void {
  const seconds = summary.ms / 1000;
  const mb = (n: number) => (n / 1_048_576).toFixed(2);
  const { roots, sessions } = summary;
  console.log(`converted: ${roots.converted} root(s), ${sessions.converted} session(s) including subagents`);
  const skipCounts: Record<string, number> = {};
  for (const s of summary.skipped) skipCounts[s.status] = (skipCounts[s.status] ?? 0) + 1;
  const skipDetail = Object.entries(skipCounts).map(([status, n]) => `${status} ${n}`).join(", ");
  console.log(`skipped:   ${roots.skipped} root(s)${skipDetail ? ` (${skipDetail})` : ""}`);
  console.log(`failed:    ${sessions.failed} session(s) in ${new Set(summary.failures.map(f => f.rootId)).size} root(s)`);
  const rate = seconds > 0 ? `${(sessions.converted / seconds).toFixed(1)} sessions/s, ${(summary.sourceBytes / 1_048_576 / seconds).toFixed(2)} MB/s source JSON` : "";
  console.log(`time:      ${seconds.toFixed(2)} s${rate ? `  (${rate})` : ""}`);
  console.log(`data:      ${mb(summary.sourceBytes)} MB read from OpenCode, ${mb(summary.outputBytes)} MB of omp session files written`);
  const { rolledForward, rolledBack } = summary.recovered;
  if (rolledForward.length + rolledBack.length > 0) console.log(`recovered: ${rolledForward.length} interrupted import(s) completed, ${rolledBack.length} rolled back`);
  if (summary.needsModelFlag.length > 0) console.log(`model:     ${summary.needsModelFlag.length} session(s) have no model omp can resolve and no default model is set: resume them with --model, or re-run with --default-model`);
  if (summary.interrupted) console.log("interrupted: remaining roots were not processed; re-run to continue");
  for (const s of summary.skipped) if (s.status === "diverged") console.log(`diverged:  ${s.id}: ${s.reason}`);
  for (const f of summary.failures) console.log(`FAILED:    ${f.id} ${JSON.stringify(clip(f.title, 50))} (root ${f.rootId}): ${f.error}`);
}

const dbPath = path.resolve(values.db ?? defaultDbPath());
try {
  const { summary, plan } = await runImport({
    dbPath,
    sessionDir: values["session-dir"],
    selection,
    dryRun: values["dry-run"] === true,
    force: values.force === true,
    fallbackCwd: values["fallback-cwd"] ? path.resolve(values["fallback-cwd"]) : undefined,
    defaultModel: values["default-model"],
    log: message => console.error(message),
  });
  if (values["dry-run"]) {
    printPlan(plan, dbPath);
    process.exit(0);
  }
  printSummary(summary);
  process.exit(summary.interrupted ? 130 : summary.sessions.failed > 0 ? 1 : 0);
} catch (error) {
  console.error(`error: ${(error as Error).message}`);
  process.exit(2);
}
