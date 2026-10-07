/**
 * Exclusive destination lock: one importer at a time may plan, write and commit to a manifest directory.
 *
 * `<dir>/.opencode-import.lock` is created with O_EXCL and holds `{pid, host, token, startedAt}`. A holder whose pid is
 * gone (same host) is stale and is taken over; a live holder makes the caller wait (polling) up to `waitMs`, then fail.
 * Takeover itself is serialized by a short-lived `.opencode-import.lock.takeover` guard so two waiters cannot both
 * delete each other's fresh lock. Pid liveness is the only staleness signal (no start-time check), so a recycled pid
 * on the same host keeps a dead importer's lock alive until it is removed by hand; the error names the file.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const LOCK_NAME = ".opencode-import.lock";

interface LockInfo {
  pid: number;
  host: string;
  token: string;
  startedAt: string;
}

export interface LockOptions {
  /** Longest to wait for a live holder, in ms (default 120 000). */
  waitMs?: number;
  pollMs?: number;
  log?: (message: string) => void;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readInfo(file: string): LockInfo | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LockInfo>;
    if (typeof parsed.pid === "number" && typeof parsed.token === "string") return parsed as LockInfo;
  } catch {
    // Missing or half-written: treated by the caller.
  }
  return undefined;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface Lock {
  release(): void;
}

export async function acquireLock(dir: string, options: LockOptions = {}): Promise<Lock> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_NAME);
  const guard = `${file}.takeover`;
  const info: LockInfo = { pid: process.pid, host: os.hostname(), token: crypto.randomUUID(), startedAt: new Date().toISOString() };
  const deadline = Date.now() + (options.waitMs ?? 120_000);
  const pollMs = options.pollMs ?? 200;
  let announced = false;
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify(info), { flag: "wx" });
      return {
        release() {
          // Only remove our own lock: after a takeover the file belongs to someone else.
          if (readInfo(file)?.token === info.token) fs.rmSync(file, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = readInfo(file);
    // A half-written lock (holder between create and write) is retried; one that stays unreadable is stale by age.
    const unreadableAge = holder ? 0 : Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
    const stale = holder ? holder.host === info.host && !alive(holder.pid) : unreadableAge > 10_000;
    if (stale) {
      let held = false;
      try {
        fs.writeFileSync(guard, String(process.pid), { flag: "wx" });
        held = true;
      } catch {
        // Another waiter is taking over; it will finish or its guard will age out below.
        const age = Date.now() - (fs.statSync(guard, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
        if (age > 30_000) fs.rmSync(guard, { force: true });
      }
      if (held) {
        try {
          // Re-check under the guard: the lock may have been replaced by a live holder since we looked.
          const again = readInfo(file);
          if ((again === undefined && !holder) || (again && holder && again.token === holder.token)) {
            options.log?.(`removing stale import lock${holder ? ` (pid ${holder.pid} is gone)` : ""}`);
            fs.rmSync(file, { force: true });
          }
        } finally {
          fs.rmSync(guard, { force: true });
        }
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`another opencode-import is running against ${dir} (pid ${holder?.pid ?? "?"} on ${holder?.host ?? "?"}); lock file ${file}`);
    }
    if (!announced) {
      options.log?.(`waiting for the import lock held by pid ${holder?.pid ?? "?"}`);
      announced = true;
    }
    await sleep(pollMs);
  }
}
