/**
 * Batch import: plan (dry run) and execution.
 *
 * Layout written (what omp itself produces for subagents, see children.ts):
 *   <session dir>/<ts>_<id>.jsonl                          root session
 *   <session dir>/<ts>_<id>/<AgentId>.jsonl (+ .md)        child sessions, header.parentSession -> root file
 *   <session dir>/<ts>_<id>/<AgentId>/<AgentId>.<Name>.jsonl   grandchildren
 * where <session dir> is `sessionDir` when given, else omp's per-cwd directory for the session's cwd.
 *
 * Every bundle (a root and its descendants) is staged completely, then published by the crash-recoverable protocol in
 * publish.ts; the whole run holds the destination lock (lock.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type ChildLink, childPaths, planChildren } from "./children";
import { CONVERTER, activeBranch, buildSession, finalAssistantText } from "./convert";
import { OpenCodeDb, type SessionRow, SessionTree } from "./db";
import { acquireLock } from "./lock";
import { type Bundle, type Intent, type Manifest, loadManifest } from "./manifest";
import { type OmpRuntime, configuredDefaultModel, listResolvableModels, loadOmp } from "./omp";
import { type Failpoint, STAGING_DIR, SimulatedCrash, TRASH_DIR, checkBundle, describeDivergence, fingerprintFile, isDiverged, publishBundle, reconcile } from "./publish";
import { type Selection, selectRoots } from "./select";

export interface ImportOptions {
  dbPath: string;
  /** Write every root flat into this directory (omp's `--session-dir` layout) instead of omp's per-cwd directories. */
  sessionDir?: string;
  selection: Selection;
  dryRun: boolean;
  force: boolean;
  /** Re-root sessions whose source directory no longer exists into this directory (default: keep the source cwd). */
  fallbackCwd?: string;
  /**
   * omp model (`provider/model`) that sessions with no resolvable source model resume on. Must be resolvable by omp.
   * Default: omp's configured `modelRoles.default` when resolvable.
   */
  defaultModel?: string;
  /** Test seam: resolvable model selectors, instead of asking `omp models --json` (also skips reading omp's config). */
  resolvable?: Set<string>;
  /** Test seam: called at each publication step; throwing {@link SimulatedCrash} there simulates the process dying. */
  failpoint?: (point: Failpoint, rootId: string) => void;
  /** Longest to wait for another importer's lock, ms. */
  lockWaitMs?: number;
  /** Progress sink (stderr in the CLI). */
  log?: (message: string) => void;
}

export type BundleStatus = "new" | "updated" | "unchanged" | "diverged";

export interface PlanEntry {
  root: SessionRow;
  /** Root first, then every descendant, depth first. */
  sessions: SessionRow[];
  descendants: number;
  /** Message counts: the root alone, and root plus descendants. */
  rootMessages: number;
  totalMessages: number;
  status: BundleStatus;
  reason?: string;
  previous?: Bundle;
}

export interface Plan {
  entries: PlanEntry[];
  unknown: string[];
  covered: Record<string, string>;
  /** Directory the manifest lives in (and, with a session dir, where sessions go). */
  manifestDir: string;
  /** Where sessions are written: the session dir, or "per-cwd" under the sessions root. */
  destination: string;
  /** Roots whose earlier import was interrupted; the next real run reconciles them first. */
  pendingIntents: string[];
}

export interface Failure {
  id: string;
  title: string;
  error: string;
  /** Root session this failure belongs to. */
  rootId: string;
}

export interface Summary {
  roots: { converted: number; skipped: number; failed: number };
  /** Sessions written / failed, descendants included. */
  sessions: { converted: number; failed: number };
  /** Skipped roots with the reason: unchanged / diverged. */
  skipped: { id: string; status: BundleStatus; reason?: string }[];
  failures: Failure[];
  files: { id: string; file: string }[];
  /** Interrupted imports from an earlier run that this run finished or undid. */
  recovered: { rolledForward: string[]; rolledBack: string[] };
  /** Converted sessions that cannot restore a model on a bare `omp --resume` (no resolvable model at all); resume with --model. */
  needsModelFlag: string[];
  sourceBytes: number;
  outputBytes: number;
  ms: number;
  interrupted: boolean;
}

const NOOP = () => {};
const remove = (target: string) => fs.rmSync(target, { recursive: true, force: true });

/** Where manifest and (without --session-dir) the per-cwd session directories live. */
async function resolveDestination(opts: ImportOptions, omp: OmpRuntime | undefined): Promise<{ manifestDir: string; destination: string }> {
  if (opts.sessionDir) return { manifestDir: path.resolve(opts.sessionDir), destination: path.resolve(opts.sessionDir) };
  const runtime = omp ?? (await loadOmp());
  return { manifestDir: runtime.defaultSessionsRoot, destination: `${runtime.defaultSessionsRoot}/<per-cwd>` };
}

function classify(db: OpenCodeDb, sessions: SessionRow[], previous: Bundle | undefined, force: boolean): { status: BundleStatus; reason?: string } {
  if (!previous) return { status: "new" };
  let reason: string | undefined;
  if (previous.converter !== CONVERTER.version) reason = `converter v${previous.converter} -> v${CONVERTER.version}`;
  else if (previous.failed.length > 0) reason = `${previous.failed.length} descendant(s) failed last time`;
  else if (!fs.existsSync(previous.file)) reason = "previous output is missing";
  else if (sessions.length !== Object.keys(previous.members).length || sessions.some(s => !previous.members[s.id])) reason = "subagent set changed";
  else {
    for (const s of sessions) {
      if (db.revision(s.id) !== previous.members[s.id].revision) {
        reason = `source changed (${s.id === previous.rootId ? "root" : s.id})`;
        break;
      }
    }
  }
  if (reason === undefined) return force ? { status: "updated", reason: "forced" } : { status: "unchanged" };
  if (!force) {
    const check = checkBundle(previous);
    if (isDiverged(check)) return { status: "diverged", reason: `${reason}, but ${describeDivergence(check)}; --force replaces it` };
  }
  return { status: "updated", reason };
}

export async function planImport(opts: ImportOptions, db: OpenCodeDb, tree: SessionTree, omp?: OmpRuntime): Promise<Plan> {
  const { manifestDir, destination } = await resolveDestination(opts, omp);
  const manifest = loadManifest(manifestDir);
  const { roots, unknown, covered } = selectRoots(tree, opts.selection);
  const entries: PlanEntry[] = roots.map(root => {
    const sessions = tree.subtree(root.id);
    const counts = sessions.map(s => db.countMessages(s.id));
    const previous = manifest.bundles[root.id];
    return {
      root,
      sessions,
      descendants: sessions.length - 1,
      rootMessages: counts[0],
      totalMessages: counts.reduce((a, b) => a + b, 0),
      previous,
      ...classify(db, sessions, previous, opts.force),
    };
  });
  return { entries, unknown, covered, manifestDir, destination, pendingIntents: Object.keys(manifest.intents) };
}

// ---------------------------------------------------------------------------------------------- execution

function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Source cwd is kept even when it no longer exists; --fallback-cwd re-roots only those. */
function resolveCwd(directory: string, fallback: string | undefined): { cwd: string; fallbackCwd?: { from: string; to: string } } {
  if (directory && (dirExists(directory) || !fallback)) return { cwd: directory };
  if (!fallback) throw new Error("session has no directory; pass --fallback-cwd DIR");
  if (!dirExists(fallback)) throw new Error(`--fallback-cwd ${fallback} is not an existing directory`);
  return { cwd: fallback, fallbackCwd: { from: directory, to: fallback } };
}

function utimes(file: string, ms: number): void {
  const when = new Date(ms);
  if (!Number.isNaN(when.getTime())) fs.utimesSync(file, when, when);
}

interface RunContext {
  opts: ImportOptions;
  db: OpenCodeDb;
  tree: SessionTree;
  omp: OmpRuntime;
  manifestDir: string;
  resolvable: Set<string>;
  defaultModel: string | undefined;
  log: (message: string) => void;
  sourceBytes: number;
  outputBytes: number;
  needsModelFlag: string[];
}

interface Staged {
  bundle: Bundle;
  sessions: { converted: number; failed: number };
  failures: Failure[];
}

async function writeRoot(ctx: RunContext, entries: unknown[], cwd: string, title: string | undefined, timeUpdated: number, stagingDir: string): Promise<string> {
  const manager = ctx.omp.SessionManager.inMemory(cwd);
  for (const entry of entries) manager.ingestReplicatedEntry(entry);
  if (title) await manager.setSessionName(title, "auto", "opencode-import");
  const persisted = await manager.persistCopy({ sessionDir: stagingDir, suppressBreadcrumb: true });
  await persisted.flush();
  const file = persisted.getSessionFile();
  await persisted.close();
  if (!file) throw new Error("omp did not report a session file");
  utimes(file, timeUpdated);
  return file;
}

async function writeChild(ctx: RunContext, file: string, parentFile: string, cwd: string, entries: unknown[], title: string | undefined, timeUpdated: number): Promise<void> {
  // Same call omp's task executor uses for a subagent transcript (src/task/executor.ts). `parentFile` is the owner's
  // FINAL path: the child is written under staging but must point at where the parent will be.
  const manager = await ctx.omp.SessionManager.open(file, undefined, undefined, { initialCwd: cwd, parentSession: parentFile, suppressBreadcrumb: true });
  for (const entry of entries) manager.ingestReplicatedEntry(entry);
  if (title) await manager.setSessionName(title, "auto", "opencode-import");
  await manager.ensureOnDisk();
  await manager.flush();
  await manager.close();
  utimes(file, timeUpdated);
}

interface Owner {
  row: SessionRow;
  /** Where the owner's children are written now (staging) and where they will live. */
  stagedArtifactsDir: string;
  finalArtifactsDir: string;
  /** The owner's final session file: the children's `parentSession`. */
  finalFile: string;
  links: Map<string, ChildLink>;
}

/** Stage `owner`'s descendants depth-first. A failed child is recorded and its own subtree is not written. */
async function stageDescendants(ctx: RunContext, owner: Owner, staged: Staged, rootId: string): Promise<void> {
  for (const row of ctx.tree.children(owner.row.id)) {
    const link = owner.links.get(row.id);
    if (!link) continue;
    const at = childPaths(owner.stagedArtifactsDir, link.id);
    const final = childPaths(owner.finalArtifactsDir, link.id);
    try {
      const source = ctx.db.load(row.id);
      ctx.sourceBytes += source.bytes;
      const grandLinks = planChildren(source.messages, ctx.tree.children(row.id), link.id);
      const { cwd, fallbackCwd } = resolveCwd(String(source.session.directory ?? ""), ctx.opts.fallbackCwd);
      const built = buildSession(source, { resolvable: ctx.resolvable, children: grandLinks, fallbackCwd, defaultModel: ctx.defaultModel });
      if (built.needsModelFlag) ctx.needsModelFlag.push(row.id);
      await writeChild(ctx, at.sessionFile, owner.finalFile, cwd, built.entries, built.title, row.time_updated);
      // `agent://<id>` reads `<id>.md`: the child's final output, taken from its active (post-revert) transcript.
      const finalText = finalAssistantText(activeBranch(source));
      if (finalText !== "") fs.writeFileSync(at.outputPath, `${finalText}\n`);
      const member = {
        file: final.sessionFile,
        fingerprint: fingerprintFile(at.sessionFile)!,
        ...(finalText !== "" ? { output: final.outputPath, outputFingerprint: fingerprintFile(at.outputPath)! } : {}),
        timeUpdated: row.time_updated,
        revision: source.revision,
      };
      staged.bundle.members[row.id] = member;
      staged.sessions.converted++;
      ctx.outputBytes += member.fingerprint.size;
      await stageDescendants(ctx, { row, stagedArtifactsDir: at.ownArtifactsDir, finalArtifactsDir: final.ownArtifactsDir, finalFile: final.sessionFile, links: grandLinks }, staged, rootId);
    } catch (error) {
      if (error instanceof SimulatedCrash) throw error;
      const skipped = ctx.tree.subtree(row.id).length - 1;
      const message = (error as Error).message ?? String(error);
      staged.failures.push({ id: row.id, title: row.title, rootId, error: skipped > 0 ? `${message} (${skipped} descendant(s) not written)` : message });
      staged.bundle.failed.push(row.id);
      staged.sessions.failed++;
      ctx.log(`  ! ${row.id} ${JSON.stringify(row.title)}: ${message}`);
    }
  }
}

/** Write one root and its whole subtree under `stagingDir`, with the final paths and fingerprints recorded in the bundle. */
async function stageBundle(ctx: RunContext, root: SessionRow, stagingDir: string): Promise<Staged> {
  const source = ctx.db.load(root.id); // one short read transaction; the rest of the bundle never holds the DB
  ctx.sourceBytes += source.bytes;
  const links = planChildren(source.messages, ctx.tree.children(root.id), undefined);
  const { cwd, fallbackCwd } = resolveCwd(String(source.session.directory ?? ""), ctx.opts.fallbackCwd);
  const built = buildSession(source, { resolvable: ctx.resolvable, children: links, fallbackCwd, defaultModel: ctx.defaultModel });
  if (built.needsModelFlag) ctx.needsModelFlag.push(root.id);
  const stagedRoot = await writeRoot(ctx, built.entries, cwd, built.title, root.time_updated, stagingDir);
  const stem = path.basename(stagedRoot, ".jsonl");
  const finalDir = ctx.opts.sessionDir ? path.resolve(ctx.opts.sessionDir) : ctx.omp.SessionManager.getDefaultSessionDir(cwd);
  const finalRoot = path.join(finalDir, `${stem}.jsonl`);
  const finalArtifactsDir = path.join(finalDir, stem);
  const fingerprint = fingerprintFile(stagedRoot)!;
  ctx.outputBytes += fingerprint.size;

  const staged: Staged = {
    bundle: {
      rootId: root.id,
      file: finalRoot,
      artifactsDir: finalArtifactsDir,
      importedAt: new Date().toISOString(),
      converter: CONVERTER.version,
      members: { [root.id]: { file: finalRoot, fingerprint, timeUpdated: root.time_updated, revision: source.revision } },
      failed: [],
    },
    sessions: { converted: 1, failed: 0 },
    failures: [],
  };
  await stageDescendants(ctx, { row: root, stagedArtifactsDir: path.join(stagingDir, stem), finalArtifactsDir, finalFile: finalRoot, links }, staged, root.id);
  return staged;
}

/** A replacement may drop the previous bundle only if it still contains every session the previous one had. */
function coversPrevious(previous: Bundle, next: Bundle): boolean {
  return Object.keys(previous.members).every(id => id in next.members);
}

export async function runImport(opts: ImportOptions): Promise<{ summary: Summary; plan: Plan }> {
  const started = performance.now();
  const log = opts.log ?? NOOP;
  const db = new OpenCodeDb(opts.dbPath);
  try {
    const tree = new SessionTree(db.listSessions());
    const omp = opts.sessionDir && opts.dryRun ? undefined : await loadOmp();
    const summary: Summary = {
      roots: { converted: 0, skipped: 0, failed: 0 },
      sessions: { converted: 0, failed: 0 },
      skipped: [],
      failures: [],
      files: [],
      recovered: { rolledForward: [], rolledBack: [] },
      needsModelFlag: [],
      sourceBytes: 0,
      outputBytes: 0,
      ms: 0,
      interrupted: false,
    };
    if (opts.dryRun) {
      const plan = await planImport(opts, db, tree, omp);
      for (const id of plan.unknown) log(`warning: ${id} is not in ${opts.dbPath}`);
      for (const [id, owner] of Object.entries(plan.covered)) log(`note: ${id} is already part of ${owner}'s subtree; not imported separately`);
      summary.ms = performance.now() - started;
      return { summary, plan };
    }

    const { manifestDir } = await resolveDestination(opts, omp);
    const lock = await acquireLock(manifestDir, { waitMs: opts.lockWaitMs, log });
    try {
      // Everything below runs under the lock: reconcile, plan, write, commit.
      const recovered = reconcile(manifestDir, loadManifest(manifestDir), log);
      summary.recovered = { rolledForward: recovered.rolledForward, rolledBack: recovered.rolledBack };
      const plan = await planImport(opts, db, tree, omp);
      for (const id of plan.unknown) log(`warning: ${id} is not in ${opts.dbPath}`);
      for (const [id, owner] of Object.entries(plan.covered)) log(`note: ${id} is already part of ${owner}'s subtree; not imported separately`);

      // `omp models --json` costs about a second; a run that converts nothing never needs it.
      const needsModels = plan.entries.some(e => e.status === "new" || e.status === "updated");
      const resolvable = opts.resolvable ?? (needsModels ? await listResolvableModels(message => log(`warning: ${message}`)) : new Set<string>());
      let defaultModel: string | undefined;
      if (opts.defaultModel) {
        if (!resolvable.has(opts.defaultModel)) throw new Error(`--default-model ${opts.defaultModel} is not a model omp can resolve (see \`omp models\`)`);
        defaultModel = opts.defaultModel;
      } else if (needsModels && !opts.resolvable) {
        defaultModel = await configuredDefaultModel(resolvable, message => log(`warning: ${message}`));
        if (!defaultModel) log("warning: omp has no resolvable default model; sessions whose models omp cannot resolve will need `--model` to resume (or pass --default-model)");
      }

      const ctx: RunContext = { opts, db, tree, omp: omp!, manifestDir, resolvable, defaultModel, log, sourceBytes: 0, outputBytes: 0, needsModelFlag: [] };
      const manifest: Manifest = loadManifest(manifestDir);

      let stop = false;
      const onSigint = () => {
        stop = true;
        log("interrupt: finishing the current session, then stopping");
      };
      process.once("SIGINT", onSigint);
      try {
        let index = 0;
        for (const entry of plan.entries) {
          index++;
          const label = `[${index}/${plan.entries.length}] ${entry.root.id} ${JSON.stringify(entry.root.title.slice(0, 60))}`;
          if (stop) {
            summary.interrupted = true;
            break;
          }
          if (entry.status === "unchanged" || entry.status === "diverged") {
            summary.roots.skipped++;
            summary.skipped.push({ id: entry.root.id, status: entry.status, reason: entry.reason });
            log(`${label}: skipped (${entry.status}${entry.reason ? `: ${entry.reason}` : ""})`);
            continue;
          }
          const t0 = performance.now();
          const intentId = crypto.randomUUID().slice(0, 12);
          const stagingDir = path.join(manifestDir, STAGING_DIR, intentId);
          try {
            fs.mkdirSync(stagingDir, { recursive: true });
            const staged = await stageBundle(ctx, entry.root, stagingDir);
            opts.failpoint?.("staged", entry.root.id);
            if (staged.failures.length > 0 && entry.previous && !coversPrevious(entry.previous, staged.bundle)) {
              // A formerly converted session now fails: keep the complete previous bundle rather than a lesser one.
              remove(stagingDir);
              summary.roots.failed++;
              summary.sessions.failed += staged.sessions.failed;
              summary.failures.push(...staged.failures.map(f => ({ ...f, error: `${f.error} (previous import kept)` })));
              log(`${label}: replacement incomplete; previous import kept`);
              continue;
            }
            const intent: Intent = {
              id: intentId,
              rootId: entry.root.id,
              createdAt: new Date().toISOString(),
              stagingDir,
              trashDir: path.join(manifestDir, TRASH_DIR, intentId),
              bundle: staged.bundle,
              previous: entry.previous,
            };
            const published = publishBundle({ manifestDir, manifest, force: opts.force, failpoint: opts.failpoint }, intent);
            if (published.status === "diverged") {
              remove(stagingDir);
              summary.roots.skipped++;
              summary.skipped.push({ id: entry.root.id, status: "diverged", reason: `${published.detail}; --force replaces it` });
              log(`${label}: skipped (diverged: ${published.detail})`);
              continue;
            }
            summary.roots.converted++;
            summary.sessions.converted += staged.sessions.converted;
            summary.sessions.failed += staged.sessions.failed;
            summary.failures.push(...staged.failures);
            summary.files.push({ id: entry.root.id, file: staged.bundle.file });
            log(`${label}: ${entry.status === "updated" ? "re-converted" : "converted"} ${staged.sessions.converted} session(s) in ${Math.round(performance.now() - t0)} ms -> ${staged.bundle.file}`);
          } catch (error) {
            if (error instanceof SimulatedCrash) throw error;
            remove(stagingDir);
            const message = (error as Error).message ?? String(error);
            summary.roots.failed++;
            summary.sessions.failed++;
            summary.failures.push({ id: entry.root.id, title: entry.root.title, rootId: entry.root.id, error: message });
            log(`${label}: FAILED: ${message}`);
          }
        }
      } finally {
        process.removeListener("SIGINT", onSigint);
      }
      summary.needsModelFlag = ctx.needsModelFlag;
      summary.sourceBytes = ctx.sourceBytes;
      summary.outputBytes = ctx.outputBytes;
      summary.ms = performance.now() - started;
      return { summary, plan };
    } finally {
      lock.release();
    }
  } finally {
    db.close();
  }
}
