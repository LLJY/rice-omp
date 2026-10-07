/**
 * Import manifest: which OpenCode sessions were converted to which omp files, with enough fingerprints to know
 * whether the source changed and whether the output was touched since.
 *
 * One bundle per imported root: the root session plus every descendant written beneath it. Keyed by the bundle's
 * root OpenCode id. (A child imported on its own is its own bundle, so one source id can appear in two bundles.)
 * Lives next to the sessions it describes: `<session dir or sessions root>/.opencode-import.json`. omp only ever
 * globs `*.jsonl` / `*\/*.jsonl` there, so the dotfiles are invisible to it.
 *
 * Besides committed bundles the manifest holds *intents*: a bundle that is being published (staged on disk, files
 * about to be moved into place). An intent is written before any file reaches the session directory and removed in
 * the same atomic save that commits the bundle, so an interrupted run is always either rolled back or rolled
 * forward by `reconcile` (see publish.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const MANIFEST_NAME = ".opencode-import.json";

/** Content identity of one output file. `sha256` is authoritative; size and mtime are for quick inspection. */
export interface Fingerprint {
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface BundleMember {
  /** Absolute path of the omp session file written for this OpenCode session. */
  file: string;
  fingerprint: Fingerprint;
  /** Absolute path of the child's `<AgentId>.md` (what `agent://<AgentId>` reads); absent when it has no output. */
  output?: string;
  outputFingerprint?: Fingerprint;
  /** Source `session.time_updated` (ms) at conversion time. */
  timeUpdated: number;
  /** Source revision (db.ts `revisionOf`) captured in the same read transaction as the converted rows. */
  revision: string;
}

export interface Bundle {
  rootId: string;
  /** Root session file (== members[rootId].file). */
  file: string;
  /** The root's artifacts directory: the root file minus `.jsonl`. Every child lives beneath it. */
  artifactsDir: string;
  importedAt: string;
  /** CONVERTER.version that produced it; a different converter re-converts. */
  converter: number;
  members: Record<string, BundleMember>;
  /** Descendants that failed to convert; a bundle with failures is retried on the next run. */
  failed: string[];
}

/** A bundle being published. See publish.ts for the protocol. */
export interface Intent {
  id: string;
  rootId: string;
  createdAt: string;
  /** Where the new bundle was written first (`<staging root>/<id>`): `<stem>.jsonl` and `<stem>/`. */
  stagingDir: string;
  /** Where the previous bundle's root file and artifacts directory are parked during the swap. */
  trashDir: string;
  /** The new bundle, with its final paths. */
  bundle: Bundle;
  /** The committed bundle being replaced, if any. */
  previous?: Bundle;
}

export interface Manifest {
  version: 2;
  bundles: Record<string, Bundle>;
  intents: Record<string, Intent>;
}

export function manifestPath(dir: string): string {
  return path.join(dir, MANIFEST_NAME);
}

export function emptyManifest(): Manifest {
  return { version: 2, bundles: {}, intents: {} };
}

export function loadManifest(dir: string): Manifest {
  const file = manifestPath(dir);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyManifest();
    throw error;
  }
  let parsed: Manifest;
  try {
    parsed = JSON.parse(text) as Manifest;
  } catch (error) {
    // Never silently start over: that would re-import everything next to the old output.
    throw new Error(`${file} is not valid JSON (${(error as Error).message}); fix or remove it`);
  }
  if (parsed.version !== 2 || typeof parsed.bundles !== "object" || parsed.bundles === null || typeof parsed.intents !== "object" || parsed.intents === null) {
    throw new Error(`${file}: unsupported manifest (expected version 2 written by this tool); remove it to start over`);
  }
  return parsed;
}

/** Durable atomic replace: write + fsync a temp file, rename it over the manifest, fsync the directory. */
export function saveManifest(dir: string, manifest: Manifest): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = manifestPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Directory fsync is unsupported on some platforms; the rename itself is already atomic.
  }
}
