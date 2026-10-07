/**
 * Output integrity: fingerprints, divergence detection, and crash-recoverable bundle publication.
 *
 * Publication protocol (all under the destination lock, see lock.ts):
 *   1. the new bundle is written completely under `<dir>/.opencode-import-staging/<intent id>/`;
 *   2. an *intent* (new bundle record + the previous bundle it replaces) is saved to the manifest;
 *   3. the previous bundle's root file and artifacts directory are moved to `<dir>/.opencode-import-trash/<id>/`;
 *   4. the staged artifacts directory, then the staged root file, are renamed into the session directory;
 *   5. one atomic manifest save records the new bundle and drops the intent (the commit);
 *   6. trash and staging are deleted.
 * Nothing reaches the session directory before step 4, the previous bundle survives (in the trash) until step 5, and
 * `reconcile` finishes or undoes whatever step a killed run reached: it rolls forward when every file of the new bundle
 * is in place with its recorded hash, otherwise it deletes the partial new files and restores the previous bundle.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Bundle, type Fingerprint, type Intent, type Manifest, saveManifest } from "./manifest";

export const STAGING_DIR = ".opencode-import-staging";
export const TRASH_DIR = ".opencode-import-trash";

/** Test seam: a failpoint that throws this simulates the process dying there (no cleanup runs). */
export class SimulatedCrash extends Error {}

export type Failpoint = "staged" | "intent" | "trashed" | "swapped" | "committed";

export function fingerprintFile(file: string): Fingerprint | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (let n = fs.readSync(fd, buffer, 0, buffer.length, null); n > 0; n = fs.readSync(fd, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, n));
    return { size: stat.size, mtimeMs: stat.mtimeMs, sha256: hash.digest("hex") };
  } finally {
    fs.closeSync(fd);
  }
}

/** Every file the importer wrote for a bundle: each member's session file and `.md`. */
export function ownedFiles(bundle: Bundle): { path: string; fingerprint: Fingerprint }[] {
  const out: { path: string; fingerprint: Fingerprint }[] = [];
  for (const member of Object.values(bundle.members)) {
    out.push({ path: member.file, fingerprint: member.fingerprint });
    if (member.output && member.outputFingerprint) out.push({ path: member.output, fingerprint: member.outputFingerprint });
  }
  return out;
}

export interface BundleCheck {
  /** Owned files whose content differs from what was written (e.g. continued in omp, title edited). */
  modified: string[];
  /** Owned files that no longer exist. */
  missing: string[];
  /** Files under the bundle's artifacts directory that the importer did not write (e.g. a new omp subagent). */
  unexpected: string[];
}

function filesBelow(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Compare a committed bundle's files with the fingerprints recorded when it was written. */
export function checkBundle(bundle: Bundle): BundleCheck {
  const check: BundleCheck = { modified: [], missing: [], unexpected: [] };
  const owned = ownedFiles(bundle);
  for (const file of owned) {
    let size: number;
    try {
      size = fs.statSync(file.path).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        check.missing.push(file.path);
        continue;
      }
      throw error;
    }
    // A different size is already a difference; equal sizes are decided by content (title edits keep the size).
    if (size !== file.fingerprint.size || fingerprintFile(file.path)?.sha256 !== file.fingerprint.sha256) check.modified.push(file.path);
  }
  const known = new Set(owned.map(f => f.path));
  for (const file of filesBelow(bundle.artifactsDir)) if (!known.has(file)) check.unexpected.push(file);
  return check;
}

export const isDiverged = (check: BundleCheck): boolean => check.modified.length + check.unexpected.length > 0;

export function describeDivergence(check: BundleCheck): string {
  const first = check.modified[0] ?? check.unexpected[0];
  const count = check.modified.length + check.unexpected.length;
  const kind = check.modified.length > 0 ? "modified" : "added";
  return `${path.basename(first)} was ${kind} after import${count > 1 ? ` (+${count - 1} more)` : ""}`;
}

// ---------------------------------------------------------------------------------------------- publication

const stemOf = (bundle: Bundle) => path.basename(bundle.file, ".jsonl");

function moveIfExists(from: string, to: string): void {
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

const remove = (target: string) => fs.rmSync(target, { recursive: true, force: true });

/** Undo a publication that did not commit: drop the partial new files and put the previous bundle back. */
function rollback(manifestDir: string, manifest: Manifest, intent: Intent): void {
  remove(intent.bundle.file);
  remove(intent.bundle.artifactsDir);
  if (intent.previous) {
    const stem = stemOf(intent.previous);
    if (!fs.existsSync(intent.previous.artifactsDir)) moveIfExists(path.join(intent.trashDir, stem), intent.previous.artifactsDir);
    if (!fs.existsSync(intent.previous.file)) moveIfExists(path.join(intent.trashDir, `${stem}.jsonl`), intent.previous.file);
  }
  delete manifest.intents[intent.rootId];
  saveManifest(manifestDir, manifest);
  remove(intent.stagingDir);
  remove(intent.trashDir);
}

export interface PublishOptions {
  manifestDir: string;
  manifest: Manifest;
  force: boolean;
  failpoint?: (point: Failpoint, rootId: string) => void;
}

export type PublishResult = { status: "published" } | { status: "diverged"; detail: string };

/**
 * Move a fully staged bundle into place and commit it. Refuses (without touching anything) when the bundle it would
 * replace was modified after import, unless `force`. A normal error during the swap rolls back before rethrowing; a
 * {@link SimulatedCrash} (tests) leaves everything as a killed process would, for `reconcile`.
 */
export function publishBundle(options: PublishOptions, intent: Intent): PublishResult {
  const { manifestDir, manifest } = options;
  const at = (point: Failpoint) => options.failpoint?.(point, intent.rootId);
  if (intent.previous && !options.force) {
    const check = checkBundle(intent.previous);
    if (isDiverged(check)) return { status: "diverged", detail: describeDivergence(check) };
  }
  const stem = stemOf(intent.bundle);
  fs.mkdirSync(path.dirname(intent.bundle.file), { recursive: true });
  manifest.intents[intent.rootId] = intent;
  saveManifest(manifestDir, manifest);
  at("intent");
  try {
    if (intent.previous) {
      const previousStem = stemOf(intent.previous);
      moveIfExists(intent.previous.file, path.join(intent.trashDir, `${previousStem}.jsonl`)); // root first: the bundle disappears from omp at once
      moveIfExists(intent.previous.artifactsDir, path.join(intent.trashDir, previousStem));
    }
    at("trashed");
    moveIfExists(path.join(intent.stagingDir, stem), intent.bundle.artifactsDir); // artifacts before the root: the root's appearance publishes
    fs.renameSync(path.join(intent.stagingDir, `${stem}.jsonl`), intent.bundle.file);
    at("swapped");
  } catch (error) {
    if (error instanceof SimulatedCrash) throw error;
    rollback(manifestDir, manifest, intent);
    throw error;
  }
  manifest.bundles[intent.rootId] = intent.bundle;
  delete manifest.intents[intent.rootId];
  saveManifest(manifestDir, manifest);
  at("committed");
  remove(intent.trashDir);
  remove(intent.stagingDir);
  return { status: "published" };
}

export interface ReconcileResult {
  rolledForward: string[];
  rolledBack: string[];
  /** Staging/trash directories and stray manifest temp files removed. */
  swept: number;
}

/** Resolve intents left by a killed run, then remove orphan staging/trash directories. Run under the lock. */
export function reconcile(manifestDir: string, manifest: Manifest, log: (message: string) => void): ReconcileResult {
  const result: ReconcileResult = { rolledForward: [], rolledBack: [], swept: 0 };
  for (const intent of Object.values(manifest.intents)) {
    const complete = ownedFiles(intent.bundle).every(file => fingerprintFile(file.path)?.sha256 === file.fingerprint.sha256);
    if (complete) {
      manifest.bundles[intent.rootId] = intent.bundle;
      delete manifest.intents[intent.rootId];
      saveManifest(manifestDir, manifest);
      remove(intent.stagingDir);
      remove(intent.trashDir);
      result.rolledForward.push(intent.rootId);
      log(`recovered interrupted import of ${intent.rootId}: completed (all files in place)`);
    } else {
      rollback(manifestDir, manifest, intent);
      result.rolledBack.push(intent.rootId);
      log(`recovered interrupted import of ${intent.rootId}: rolled back${intent.previous ? " (previous output restored)" : ""}`);
    }
  }
  for (const name of [STAGING_DIR, TRASH_DIR]) {
    const root = path.join(manifestDir, name);
    for (const entry of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      remove(path.join(root, entry));
      result.swept++;
    }
    if (fs.existsSync(root)) fs.rmdirSync(root);
  }
  for (const entry of fs.existsSync(manifestDir) ? fs.readdirSync(manifestDir) : []) {
    if (/^\.opencode-import\.json\.\d+\.tmp$/.test(entry)) {
      remove(path.join(manifestDir, entry));
      result.swept++;
    }
  }
  return result;
}
