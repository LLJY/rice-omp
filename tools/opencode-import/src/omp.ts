/**
 * Locates the installed omp package and loads its SessionManager.
 *
 * The converter writes sessions through omp's own SessionManager so the files are exactly what omp itself would
 * write (header, title slot, entry ids, atomic persistence). The package is not a dependency of this tool: it is
 * resolved from the `omp` binary on PATH, or from OMP_PACKAGE_DIR.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const MARKER = path.join("src", "session", "session-manager.ts");
const PACKAGE_NAME = "@oh-my-pi/pi-coding-agent";

function isOmpPackageDir(dir: string): boolean {
  try {
    if (!fs.statSync(path.join(dir, MARKER)).isFile()) return false;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string };
    return pkg.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

/** Walk up from `start` to the first directory that is the omp package root. */
function packageRootAbove(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (isOmpPackageDir(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Package root of the installed omp: `$OMP_PACKAGE_DIR` when set, otherwise the directory above the real path of
 * the `omp` executable that contains `src/session/session-manager.ts`.
 */
export function resolveOmpPackageDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.OMP_PACKAGE_DIR;
  if (override) {
    const dir = path.resolve(override);
    if (!isOmpPackageDir(dir)) {
      throw new Error(`OMP_PACKAGE_DIR=${override} is not an ${PACKAGE_NAME} package root (missing ${MARKER})`);
    }
    return dir;
  }
  const bin = Bun.which("omp", { PATH: env.PATH });
  if (!bin) throw new Error("omp executable not found on PATH; install omp or set OMP_PACKAGE_DIR to its package root");
  const real = fs.realpathSync(bin);
  const found = packageRootAbove(path.dirname(real));
  if (!found) {
    throw new Error(
      `${real} is not inside an ${PACKAGE_NAME} package with sources (looked for ${MARKER}); set OMP_PACKAGE_DIR to the package root`,
    );
  }
  return found;
}

/** Minimal view of the omp SessionManager API this tool uses. */
export interface SessionManagerLike {
  ingestReplicatedEntry(entry: unknown): void;
  setSessionName(name: string, source?: string, trigger?: string): Promise<void>;
  moveTo(cwd: string, targetSessionDir?: string): Promise<void>;
  persistCopy(options?: { sessionDir?: string; suppressBreadcrumb?: boolean }): Promise<SessionManagerLike>;
  ensureOnDisk(): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  getSessionFile(): string | undefined;
  getCwd(): string;
}

export interface SessionManagerStatics {
  /** omp's per-cwd session directory for `cwd` (created, legacy directories migrated: what a plain persistCopy uses). */
  getDefaultSessionDir(cwd: string): string;
  inMemory(cwd?: string): SessionManagerLike;
  open(
    file: string,
    sessionDir?: string,
    storage?: unknown,
    options?: { initialCwd?: string; parentSession?: string; suppressBreadcrumb?: boolean; throwIfMissing?: boolean },
  ): Promise<SessionManagerLike>;
}

export interface OmpRuntime {
  packageDir: string;
  version: string;
  SessionManager: SessionManagerStatics;
  /** Root directory omp keeps per-cwd session directories in (no directory is created to learn it). */
  defaultSessionsRoot: string;
}

let cached: Promise<OmpRuntime> | undefined;

export function loadOmp(): Promise<OmpRuntime> {
  cached ??= (async () => {
    const packageDir = resolveOmpPackageDir();
    // The specifier is the installed omp's location, known only at runtime, so a static import cannot name it.
    const sm = (await import(path.join(packageDir, MARKER))) as { SessionManager: SessionManagerStatics };
    // sessionDirForCwd is the read-only lookup: unlike SessionManager.getDefaultSessionDir it neither creates
    // directories nor runs legacy-directory migrations.
    const paths = (await import(path.join(packageDir, "src", "session", "session-paths.ts"))) as {
      sessionDirForCwd(cwd: string): string;
    };
    const version = (JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as { version: string }).version;
    return {
      packageDir,
      version,
      SessionManager: sm.SessionManager,
      defaultSessionsRoot: path.dirname(paths.sessionDirForCwd(process.cwd())),
    };
  })();
  return cached;
}

/** Exact `provider/model` selectors omp can resolve today (`omp models --json`); empty when omp cannot list them. */
export async function listResolvableModels(warn: (message: string) => void): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const proc = Bun.spawn(["omp", "models", "--json"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) warn(`omp models --json exited ${code}; no model_change entries will be emitted`);
    else for (const m of (JSON.parse(text) as { models?: { selector?: unknown }[] }).models ?? []) if (typeof m.selector === "string") out.add(m.selector);
  } catch (error) {
    warn(`cannot list omp models (${(error as Error).message}); no model_change entries will be emitted`);
  }
  return out;
}

/**
 * The model omp itself would start a new session on: `modelRoles.default` from `omp config get modelRoles`, minus a
 * trailing `:thinking-level`, kept only if it is one of `resolvable`. Undefined when unset, a role alias, or unresolvable.
 */
export async function configuredDefaultModel(resolvable: Set<string>, warn: (message: string) => void): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["omp", "config", "get", "modelRoles"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return void warn(`omp config get modelRoles exited ${code}; no default model`);
    const configured = (JSON.parse(text) as { default?: unknown }).default;
    if (typeof configured !== "string") return undefined;
    const stripped = configured.replace(/:[^:/]*$/, "");
    return [configured, stripped].find(candidate => resolvable.has(candidate));
  } catch (error) {
    warn(`cannot read omp's default model (${(error as Error).message})`);
    return undefined;
  }
}
