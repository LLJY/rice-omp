import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ImportOptions, runImport } from "../src/import";
import { loadOmp, resolveOmpPackageDir } from "../src/omp";
import { buildStandardFixture } from "./fixture";

type Json = Record<string, any>;

/** The importer writes through omp's own SessionManager, so these tests need an installed omp to run. */
export const OMP_AVAILABLE = (() => {
  try {
    resolveOmpPackageDir();
    return true;
  } catch {
    return false;
  }
})();

const dirs: string[] = [];

export function tmp(prefix = "opencode-import-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export function cleanupTmp(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface Workspace {
  /** Existing directory used as the fixture sessions' cwd. */
  cwd: string;
  dbPath: string;
  sessionDir: string;
}

export function workspace(): Workspace {
  const root = tmp();
  const cwd = join(root, "project");
  Bun.spawnSync(["mkdir", "-p", cwd]);
  const dbPath = join(root, "opencode.db");
  buildStandardFixture(dbPath, cwd).close();
  return { cwd, dbPath, sessionDir: join(root, "sessions") };
}

export function importAll(ws: Workspace, overrides: Partial<ImportOptions> = {}) {
  return runImport({
    dbPath: ws.dbPath,
    sessionDir: ws.sessionDir,
    selection: { ids: [], all: true },
    dryRun: false,
    force: false,
    resolvable: new Set(),
    ...overrides,
  });
}

export function readJsonl(file: string): Json[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as Json);
}

/** What a resumed omp session would hand the model: entries plus the rebuilt context, via omp's own loader. */
export async function openSession(file: string): Promise<{ entries: Json[]; messages: Json[]; contextText: string; branchIds: string[] }> {
  const { SessionManager } = await loadOmp();
  // The importer's SessionManagerLike is the write-side subset; reading needs the rest of the real class.
  const manager = (await SessionManager.open(file)) as unknown as { getEntries(): Json[]; getBranch(): Json[]; buildSessionContext(): { messages: Json[] }; close(): Promise<void> };
  try {
    const messages = manager.buildSessionContext().messages;
    return { entries: manager.getEntries(), messages, contextText: JSON.stringify(messages), branchIds: manager.getBranch().map(e => e.id) };
  } finally {
    await manager.close();
  }
}

export interface OmpSubSession {
  agentId: string;
  parent: string | null;
  header: Json | null;
}

/** omp's own subagent discovery (what /export and /dump all use) over a session file's artifacts directory. */
export async function discoverSubSessions(file: string): Promise<Record<string, OmpSubSession>> {
  const { packageDir } = await loadOmp();
  // Specifier is resolved from the installed omp at runtime, so a static import cannot name it.
  const mod = (await import(join(packageDir, "src", "session", "sub-sessions.ts"))) as { collectSubSessions(file: string): Promise<Record<string, OmpSubSession>> };
  return mod.collectSubSessions(file);
}

export function fileOf(result: Awaited<ReturnType<typeof importAll>>, id: string): string {
  const found = result.summary.files.find(f => f.id === id);
  if (!found) throw new Error(`no output for ${id}`);
  return found.file;
}

/** The model strings a bare `omp --resume` of this file would try to restore, via omp's own context builder. */
export async function restorableModels(file: string): Promise<string[]> {
  const { SessionManager, packageDir } = await loadOmp();
  // Specifier is resolved from the installed omp at runtime, so a static import cannot name it.
  const { getRestorableSessionModels } = (await import(join(packageDir, "src", "session", "session-context.ts"))) as {
    getRestorableSessionModels(models: Record<string, string>, lastRole: string | undefined): string[];
  };
  const manager = (await SessionManager.open(file)) as unknown as { buildSessionContext(): { models: Record<string, string> }; getLastModelChangeRole(): string | undefined; close(): Promise<void> };
  try {
    return getRestorableSessionModels(manager.buildSessionContext().models, manager.getLastModelChangeRole());
  } finally {
    await manager.close();
  }
}

/** omp's own usage consumers over a session file: SessionManager statistics and the stats tracker's token totals. */
export async function nativeUsage(file: string): Promise<{ stats: Json; tokenTotals: Json }> {
  const { SessionManager, packageDir } = await loadOmp();
  const { SessionStatsTracker } = (await import(join(packageDir, "src", "session", "session-stats.ts"))) as {
    SessionStatsTracker: new (host: Json) => { getTokenTotals(): Json };
  };
  const manager = (await SessionManager.open(file)) as unknown as { getUsageStatistics(): Json; buildSessionContext(): { messages: Json[] }; close(): Promise<void> };
  try {
    const messages = manager.buildSessionContext().messages;
    // getTokenTotals only reads agent.state.messages and the branch; the rest of the host is not touched.
    const tracker = new SessionStatsTracker({ agent: { state: { messages } }, sessionManager: manager, session: {}, modelRegistry: {}, model: () => undefined, sessionId: () => "test" });
    return { stats: manager.getUsageStatistics(), tokenTotals: tracker.getTokenTotals() };
  } finally {
    await manager.close();
  }
}

/** `read agent://<id>` as omp's own handler resolves it for a caller whose session file is `sessionFile`. */
export async function resolveAgentUrl(sessionFile: string, url: string): Promise<string> {
  const { packageDir } = await loadOmp();
  const { parseInternalUrl } = (await import(join(packageDir, "src", "internal-urls", "parse.ts"))) as { parseInternalUrl(input: string): Json };
  const { AgentProtocolHandler } = (await import(join(packageDir, "src", "internal-urls", "agent-protocol.ts"))) as {
    AgentProtocolHandler: new () => { resolve(url: Json, context: Json): Promise<{ content: string }> };
  };
  return (await new AgentProtocolHandler().resolve(parseInternalUrl(url), { sessionFile })).content;
}

/** Root session files, staging entries and trash entries directly under a session dir. */
export function layout(dir: string): { roots: string[]; staging: string[]; trash: string[] } {
  const list = (sub: string) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)) : []);
  return {
    roots: existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".jsonl")).map(name => join(dir, name)) : [],
    staging: list(".opencode-import-staging"),
    trash: list(".opencode-import-trash"),
  };
}
