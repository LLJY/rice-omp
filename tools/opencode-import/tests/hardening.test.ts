import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { LOCK_NAME } from "../src/lock";
import { loadManifest } from "../src/manifest";
import { SimulatedCrash, reconcile, type Failpoint } from "../src/publish";
import { inProject } from "../src/select";
import { OMP_AVAILABLE, cleanupTmp, fileOf, importAll, layout, nativeUsage, openSession, readJsonl, resolveAgentUrl, restorableModels, tmp, workspace, type Workspace } from "./helpers";
import { T } from "./fixture";

afterAll(cleanupTmp);

function sql(ws: Workspace, statement: string, ...params: (string | number)[]): void {
  const db = new Database(ws.dbPath);
  db.query(statement).run(...params);
  db.close();
}

const only = (...ids: string[]) => ({ ids, all: false });

/** A failpoint that simulates the process dying at `point` for one root. */
const crashAt =
  (target: Failpoint, rootId = "ses_parent") =>
  (point: Failpoint, id: string) => {
    if (point === target && id === rootId) throw new SimulatedCrash(`crash at ${point}`);
  };

describe.skipIf(!OMP_AVAILABLE)("hardening", () => {
  describe("bundle divergence protection", () => {
    it("a continued child blocks replacement even though the root file is unchanged", async () => {
      const ws = workspace();
      const first = await importAll(ws, { selection: only("ses_parent") });
      const parentFile = fileOf(first, "ses_parent");
      const childFile = join(parentFile.slice(0, -".jsonl".length), "ImplementFix.jsonl");
      const rootBefore = readFileSync(parentFile, "utf8");
      appendFileSync(childFile, `${JSON.stringify({ type: "custom", customType: "continued_in_omp", id: "zz", parentId: null, timestamp: new Date().toISOString(), data: {} })}\n`);
      sql(ws, "UPDATE session SET title = 'parent renamed' WHERE id = 'ses_parent'");

      const second = await importAll(ws, { selection: only("ses_parent") });
      expect(second.summary.roots).toEqual({ converted: 0, skipped: 1, failed: 0 });
      expect(second.summary.skipped[0]).toMatchObject({ id: "ses_parent", status: "diverged" });
      expect(second.summary.skipped[0].reason).toContain("ImplementFix.jsonl was modified after import");
      // Nothing was deleted or rewritten.
      expect(readFileSync(parentFile, "utf8")).toBe(rootBefore);
      expect(readFileSync(childFile, "utf8")).toContain("continued_in_omp");
      expect(layout(ws.sessionDir).roots).toEqual([parentFile]);
      expect(loadManifest(ws.sessionDir).bundles.ses_parent.file).toBe(parentFile);

      const forced = await importAll(ws, { selection: only("ses_parent"), force: true });
      expect(forced.summary.roots.converted).toBe(1);
      expect(existsSync(parentFile)).toBe(false);
      expect(layout(ws.sessionDir).roots).toEqual([fileOf(forced, "ses_parent")]);
    });

    it("a same-size edit of the root (omp's fixed-width title slot) is detected", async () => {
      const ws = workspace();
      const first = await importAll(ws, { selection: only("ses_tools") });
      const file = fileOf(first, "ses_tools");
      const text = readFileSync(file, "utf8");
      const edited = text.replace('"title":"session ses_tools"', '"title":"session ses_toolz"');
      expect(edited.length).toBe(text.length);
      writeFileSync(file, edited);
      sql(ws, "UPDATE session SET title = 'renamed in opencode' WHERE id = 'ses_tools'");

      const second = await importAll(ws, { selection: only("ses_tools") });
      expect(second.summary.skipped[0]).toMatchObject({ status: "diverged" });
      expect(readFileSync(file, "utf8")).toBe(edited);
    });

    it("a subagent added in omp under the bundle's artifacts directory counts as divergence", async () => {
      const ws = workspace();
      const first = await importAll(ws, { selection: only("ses_parent") });
      const parentFile = fileOf(first, "ses_parent");
      writeFileSync(join(parentFile.slice(0, -".jsonl".length), "NewOmpAgent.md"), "made later\n");
      sql(ws, "UPDATE session SET title = 'again' WHERE id = 'ses_parent'");
      const second = await importAll(ws, { selection: only("ses_parent") });
      expect(second.summary.skipped[0]).toMatchObject({ status: "diverged" });
      expect(second.summary.skipped[0].reason).toContain("NewOmpAgent.md was added after import");
    });
  });

  describe("failed replacement keeps the previous bundle", () => {
    it("a formerly converted child that now fails leaves the old bundle fully intact", async () => {
      const ws = workspace();
      const first = await importAll(ws, { selection: only("ses_parent") });
      const parentFile = fileOf(first, "ses_parent");
      const artifacts = parentFile.slice(0, -".jsonl".length);
      const snapshot = new Map([parentFile, ...readdirSync(artifacts).filter(n => n.endsWith(".jsonl") || n.endsWith(".md")).map(n => join(artifacts, n))].map(f => [f, readFileSync(f, "utf8")]));
      // ses_childB has no directory any more: the source changed (so a replacement is attempted) and that child cannot be converted.
      sql(ws, "UPDATE session SET directory = '' WHERE id = 'ses_childB'");

      const second = await importAll(ws, { selection: only("ses_parent") });
      expect(second.summary.roots).toEqual({ converted: 0, skipped: 0, failed: 1 });
      expect(second.summary.failures.map(f => f.id)).toEqual(["ses_childB"]);
      expect(second.summary.failures[0].error).toContain("previous import kept");
      for (const [file, content] of snapshot) expect(readFileSync(file, "utf8")).toBe(content);
      expect(layout(ws.sessionDir)).toEqual({ roots: [parentFile], staging: [], trash: [] });
      const manifest = loadManifest(ws.sessionDir);
      expect(manifest.bundles.ses_parent.file).toBe(parentFile);
      expect(manifest.bundles.ses_parent.failed).toEqual([]);
      // The old bundle is still a working, linked session.
      expect(JSON.stringify((await openSession(parentFile)).messages)).toContain("FIX DONE");

      // Once the child converts again, the replacement goes through.
      sql(ws, "UPDATE session SET directory = ?, title = 'Implement fix v2' WHERE id = 'ses_childB'", ws.cwd);
      const third = await importAll(ws, { selection: only("ses_parent") });
      expect(third.summary.roots.converted).toBe(1);
      expect(existsSync(parentFile)).toBe(false);
    });

    it("a first import with a failing child still publishes the rest and retries the child next run", async () => {
      const ws = workspace();
      sql(ws, "UPDATE session SET directory = '' WHERE id = 'ses_childB'");
      const first = await importAll(ws, { selection: only("ses_parent") });
      expect(first.summary.roots.converted).toBe(1);
      expect(first.summary.sessions).toEqual({ converted: 3, failed: 1 });
      expect(loadManifest(ws.sessionDir).bundles.ses_parent.failed).toEqual(["ses_childB"]);
    });
  });

  describe("source revision", () => {
    it("a title change that leaves session.time_updated alone re-converts", async () => {
      const ws = workspace();
      await importAll(ws, { selection: only("ses_tools") });
      const before = new Database(ws.dbPath, { readonly: true }).query("SELECT time_updated FROM session WHERE id = 'ses_tools'").get() as { time_updated: number };
      sql(ws, "UPDATE session SET title = 'a new title' WHERE id = 'ses_tools'");
      const after = new Database(ws.dbPath, { readonly: true }).query("SELECT time_updated FROM session WHERE id = 'ses_tools'").get() as { time_updated: number };
      expect(after.time_updated).toBe(before.time_updated);

      const second = await importAll(ws, { selection: only("ses_tools") });
      expect(second.summary.roots.converted).toBe(1);
      expect(readJsonl(fileOf(second, "ses_tools"))[0].title).toBe("a new title");
    });

    it("a part rewritten by OpenCode (its own time_updated advances, the session's does not) re-converts", async () => {
      const ws = workspace();
      await importAll(ws, { selection: only("ses_tools") });
      const part = new Database(ws.dbPath, { readonly: true }).query("SELECT data FROM part WHERE id = 't_a1_p05'").get() as { data: string };
      const data = JSON.parse(part.data);
      expect(data.callID).toBe("c_run"); // the tool call that was still running at first import
      data.state = { ...data.state, status: "completed", output: "finished later" };
      sql(ws, "UPDATE part SET data = ?, time_updated = time_updated + 500 WHERE id = 't_a1_p05'", JSON.stringify(data));

      const second = await importAll(ws, { selection: only("ses_tools") });
      expect(second.summary.roots.converted).toBe(1);
      expect(JSON.stringify((await openSession(fileOf(second, "ses_tools"))).messages)).toContain("finished later");
    });

    it("a change in a descendant re-converts the whole bundle, a new message too", async () => {
      const ws = workspace();
      await importAll(ws, { selection: only("ses_parent") });
      sql(ws, "UPDATE part SET data = ?, time_updated = time_updated + 500 WHERE id = 'g_a1_p02'", JSON.stringify({ type: "text", text: "GRAND RESULT v2" }));
      const second = await importAll(ws, { selection: only("ses_parent") });
      expect(second.summary.roots.converted).toBe(1);

      const db = new Database(ws.dbPath);
      db.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('cb_u9', 'ses_childB', ?, ?, ?)").run(T + 9_999_000, T + 9_999_000, JSON.stringify({ role: "user" }));
      db.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('cb_u9_p01', 'cb_u9', 'ses_childB', ?, ?, ?)").run(T + 9_999_000, T + 9_999_000, JSON.stringify({ type: "text", text: "one more" }));
      db.close();
      const third = await importAll(ws, { selection: only("ses_parent") });
      expect(third.summary.roots.converted).toBe(1);
      const fourth = await importAll(ws, { selection: only("ses_parent") });
      expect(fourth.summary.roots).toEqual({ converted: 0, skipped: 1, failed: 0 });
    });
  });

  describe("interrupted publication", () => {
    async function setup() {
      const ws = workspace();
      const first = await importAll(ws, { selection: only("ses_parent") });
      const oldFile = fileOf(first, "ses_parent");
      sql(ws, "UPDATE session SET title = 'parent v2' WHERE id = 'ses_parent'");
      return { ws, oldFile, oldArtifacts: oldFile.slice(0, -".jsonl".length) };
    }

    it("killed after staging a new root: nothing reached the session dir; the next run sweeps and imports once", async () => {
      const ws = workspace();
      await expect(importAll(ws, { selection: only("ses_parent"), failpoint: crashAt("staged") })).rejects.toThrow("crash at staged");
      expect(layout(ws.sessionDir).roots).toEqual([]);
      expect(layout(ws.sessionDir).staging.length).toBe(1);
      expect(Object.keys(loadManifest(ws.sessionDir).bundles)).toEqual([]);

      const rerun = await importAll(ws, { selection: only("ses_parent") });
      expect(rerun.summary.roots.converted).toBe(1);
      expect(layout(ws.sessionDir)).toEqual({ roots: [fileOf(rerun, "ses_parent")], staging: [], trash: [] });
    });

    it("killed after the intent is saved: rolled back, previous bundle untouched, then replaced", async () => {
      const { ws, oldFile, oldArtifacts } = await setup();
      await expect(importAll(ws, { selection: only("ses_parent"), failpoint: crashAt("intent") })).rejects.toThrow("crash at intent");
      expect(Object.keys(loadManifest(ws.sessionDir).intents)).toEqual(["ses_parent"]);

      const manifest = loadManifest(ws.sessionDir);
      expect(reconcile(ws.sessionDir, manifest, () => {})).toMatchObject({ rolledBack: ["ses_parent"], rolledForward: [] });
      expect(existsSync(oldFile) && existsSync(oldArtifacts)).toBe(true);
      expect(loadManifest(ws.sessionDir).intents).toEqual({});
      expect(layout(ws.sessionDir)).toEqual({ roots: [oldFile], staging: [], trash: [] });

      const rerun = await importAll(ws, { selection: only("ses_parent") });
      expect(rerun.summary.roots.converted).toBe(1);
      expect(layout(ws.sessionDir).roots).toEqual([fileOf(rerun, "ses_parent")]);
    });

    it("killed with the previous bundle parked in the trash: the previous bundle is restored", async () => {
      const { ws, oldFile, oldArtifacts } = await setup();
      await expect(importAll(ws, { selection: only("ses_parent"), failpoint: crashAt("trashed") })).rejects.toThrow("crash at trashed");
      // Mid-swap the old bundle is gone from the session dir (parked), and nothing new is there yet.
      expect(existsSync(oldFile) || existsSync(oldArtifacts)).toBe(false);
      expect(layout(ws.sessionDir).trash.length).toBe(1);

      const result = reconcile(ws.sessionDir, loadManifest(ws.sessionDir), () => {});
      expect(result.rolledBack).toEqual(["ses_parent"]);
      expect(existsSync(oldFile) && existsSync(join(oldArtifacts, "ImplementFix.jsonl"))).toBe(true);
      expect(layout(ws.sessionDir)).toEqual({ roots: [oldFile], staging: [], trash: [] });
      expect(loadManifest(ws.sessionDir).bundles.ses_parent.file).toBe(oldFile);
    });

    it("killed after the files were swapped but before the manifest commit: rolled forward, no duplicate", async () => {
      const { ws, oldFile } = await setup();
      await expect(importAll(ws, { selection: only("ses_parent"), failpoint: crashAt("swapped") })).rejects.toThrow("crash at swapped");
      expect(existsSync(oldFile)).toBe(false);
      expect(loadManifest(ws.sessionDir).bundles.ses_parent.file).toBe(oldFile); // manifest still names the old files
      const newFile = layout(ws.sessionDir).roots[0];
      expect(newFile).not.toBe(oldFile);

      const result = reconcile(ws.sessionDir, loadManifest(ws.sessionDir), () => {});
      expect(result.rolledForward).toEqual(["ses_parent"]);
      const manifest = loadManifest(ws.sessionDir);
      expect(manifest.bundles.ses_parent.file).toBe(newFile);
      expect(manifest.intents).toEqual({});
      expect(layout(ws.sessionDir)).toEqual({ roots: [newFile], staging: [], trash: [] });

      const rerun = await importAll(ws, { selection: only("ses_parent") });
      expect(rerun.summary.roots).toEqual({ converted: 0, skipped: 1, failed: 0 }); // the recovered bundle is current
      expect(layout(ws.sessionDir).roots).toEqual([newFile]);
    });

    it("killed after the commit but before cleanup: the next run sweeps the leftovers", async () => {
      const { ws } = await setup();
      await expect(importAll(ws, { selection: only("ses_parent"), failpoint: crashAt("committed") })).rejects.toThrow("crash at committed");
      const left = layout(ws.sessionDir);
      expect(left.roots.length).toBe(1);
      expect(left.trash.length + left.staging.length).toBeGreaterThan(0);
      const result = reconcile(ws.sessionDir, loadManifest(ws.sessionDir), () => {});
      expect(result.swept).toBeGreaterThan(0);
      expect(layout(ws.sessionDir)).toEqual({ roots: left.roots, staging: [], trash: [] });
    });

    it("a normal error during the swap rolls back in place and leaves the old bundle", async () => {
      const { ws, oldFile } = await setup();
      const result = await importAll(ws, {
        selection: only("ses_parent"),
        failpoint: point => {
          if (point === "trashed") throw new Error("disk full");
        },
      });
      expect(result.summary.roots.failed).toBe(1);
      expect(result.summary.failures[0].error).toBe("disk full");
      expect(layout(ws.sessionDir)).toEqual({ roots: [oldFile], staging: [], trash: [] });
      expect(loadManifest(ws.sessionDir).intents).toEqual({});
      expect(existsSync(join(oldFile.slice(0, -6), "ImplementFix.jsonl"))).toBe(true);
    });
  });

  describe("destination lock", () => {
    const writeLock = (ws: Workspace, pid: number) => {
      mkdirSync(ws.sessionDir, { recursive: true });
      writeFileSync(join(ws.sessionDir, LOCK_NAME), JSON.stringify({ pid, host: hostname(), token: "someone-else", startedAt: new Date().toISOString() }));
    };

    it("a live holder blocks a second importer, which fails without touching the lock or the destination", async () => {
      const ws = workspace();
      writeLock(ws, process.pid);
      await expect(importAll(ws, { selection: only("ses_tools"), lockWaitMs: 400 })).rejects.toThrow(/another opencode-import is running/);
      expect(JSON.parse(readFileSync(join(ws.sessionDir, LOCK_NAME), "utf8")).token).toBe("someone-else");
      expect(layout(ws.sessionDir).roots).toEqual([]);
    });

    it("a lock left by a dead process is taken over and released", async () => {
      const ws = workspace();
      const dead = Bun.spawnSync(["true"]).pid;
      writeLock(ws, dead);
      const logs: string[] = [];
      const result = await importAll(ws, { selection: only("ses_tools"), log: m => logs.push(m) });
      expect(result.summary.roots.converted).toBe(1);
      expect(logs.some(l => l.includes("removing stale import lock"))).toBe(true);
      expect(existsSync(join(ws.sessionDir, LOCK_NAME))).toBe(false);
    });

    it("importers in one process serialize: neither loses the other's manifest entry", async () => {
      const ws = workspace();
      const [a, b] = await Promise.all([importAll(ws, { selection: only("ses_tools") }), importAll(ws, { selection: only("ses_parent") })]);
      expect(a.summary.roots.converted + b.summary.roots.converted).toBe(2);
      expect(Object.keys(loadManifest(ws.sessionDir).bundles).sort()).toEqual(["ses_parent", "ses_tools"]);
      expect(layout(ws.sessionDir).roots.length).toBe(2);
    });

    it("two importer processes on one destination both land in the manifest", async () => {
      const ws = workspace();
      const agentDir = tmp("opencode-import-agent-");
      const run = (id: string) =>
        Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "--db", ws.dbPath, "--session-dir", ws.sessionDir, id], {
          env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
          stdout: "pipe",
          stderr: "pipe",
        });
      const procs = ["ses_tools", "ses_parent", "ses_ctail"].map(run);
      const codes = await Promise.all(procs.map(p => p.exited));
      expect(codes).toEqual([0, 0, 0]);
      expect(Object.keys(loadManifest(ws.sessionDir).bundles).sort()).toEqual(["ses_ctail", "ses_parent", "ses_tools"]);
      expect(layout(ws.sessionDir).roots.length).toBe(3);
      expect(existsSync(join(ws.sessionDir, LOCK_NAME))).toBe(false);
    }, 60_000);
  });

  describe("model restore (native path)", () => {
    const everyFile = (ws: Workspace) => Object.values(loadManifest(ws.sessionDir).bundles).flatMap(b => Object.values(b.members).map(m => m.file));

    it("pins a validated default when no source model resolves, so every session restores a model omp has", async () => {
      const ws = workspace();
      const resolvable = new Set(["cpa/default-test"]);
      const result = await importAll(ws, { resolvable, defaultModel: "cpa/default-test" });
      expect(result.summary.needsModelFlag).toEqual([]);
      const files = everyFile(ws);
      expect(files.length).toBe(17); // 12 roots + 5 subagents
      for (const file of files) {
        const models = await restorableModels(file);
        expect(models.every(m => resolvable.has(m))).toBe(true);
      }
      expect(await restorableModels(fileOf(result, "ses_tools"))).toEqual(["cpa/default-test"]);
      const entries = readJsonl(fileOf(result, "ses_tools"));
      const first = entries.find(e => e.type === "model_change");
      expect(first).toMatchObject({ model: "cpa/default-test", parentId: null });
      const mapping = entries.find(e => e.customType === "opencode_model_mapping");
      expect(mapping.data).toMatchObject({ restoreModel: "cpa/default-test", sourceModelsNotResolvable: ["openai/gpt-test"] });
      expect(entries.find(e => e.customType === "opencode_import").data.restoreModel).toBe("cpa/default-test");
    });

    it("leaves a resolvable source model alone", async () => {
      const ws = workspace();
      const resolvable = new Set(["openai/gpt-test", "cpa/default-test"]);
      const result = await importAll(ws, { selection: only("ses_tools"), resolvable, defaultModel: "cpa/default-test" });
      expect(await restorableModels(fileOf(result, "ses_tools"))).toEqual(["openai/gpt-test"]);
      expect(readJsonl(fileOf(result, "ses_tools")).some(e => e.customType === "opencode_model_mapping")).toBe(false);
    });

    it("without any default the session is reported, because omp would fail to restore its model", async () => {
      const ws = workspace();
      const result = await importAll(ws, { selection: only("ses_tools"), resolvable: new Set() });
      expect(result.summary.needsModelFlag).toEqual(["ses_tools"]);
      expect(await restorableModels(fileOf(result, "ses_tools"))).toEqual(["openai/gpt-test"]); // unresolvable: bare resume needs --model
    });

    it("rejects a default model omp cannot resolve before writing anything", async () => {
      const ws = workspace();
      await expect(importAll(ws, { selection: only("ses_tools"), resolvable: new Set(["cpa/x"]), defaultModel: "nope/model" })).rejects.toThrow(/not a model omp can resolve/);
      expect(layout(ws.sessionDir).roots).toEqual([]);
      expect(existsSync(join(ws.sessionDir, LOCK_NAME))).toBe(false);
    });
  });

  describe("task usage accounting (native consumers)", () => {
    it("adds each child's spend to the parent once, even when several task calls resume it", async () => {
      const ws = workspace();
      const result = await importAll(ws, { selection: only("ses_parent") });
      const parentFile = fileOf(result, "ses_parent");
      const { messages } = await openSession(parentFile);
      const byCall = Object.fromEntries(messages.filter(m => m.role === "toolResult").map(m => [m.toolCallId, m]));

      // ses_childA (input 100, output 50, cost 0.5) is behind c_t1 and its resume c_t2; ses_childB behind c_t3.
      const a1 = byCall.c_t1.details.usage;
      const a2 = byCall.c_t2.details.usage;
      expect(a1.input + a2.input).toBe(100);
      expect(a1.output + a2.output).toBe(50);
      expect(a1.cost.total + a2.cost.total).toBeCloseTo(0.5, 10);
      expect(byCall.c_t3.details.usage).toMatchObject({ input: 100, output: 50, totalTokens: 150 });
      expect(byCall.c_t3.details.usage.cost.total).toBeCloseTo(0.5, 10);
      expect(byCall.c_t1.details.results[0].usage).toEqual(a1); // the per-result copy is the same share, not a second count
      expect(byCall.c_t5.details.usage).toBeUndefined(); // a child outside this import adds nothing

      const { stats, tokenTotals } = await nativeUsage(parentFile);
      expect(stats.subagentCost).toBeCloseTo(1.0, 10); // childA once + childB, not 1.5
      expect(stats.cost).toBeCloseTo(1.02, 10); // + the parent's own two assistant steps
      expect(stats.input).toBe(220);
      expect(stats.output).toBe(110);
      expect(tokenTotals.input).toBe(220);
      expect(tokenTotals.output).toBe(110);
    });
  });

  describe("reverted children", () => {
    it("agent://<id> returns the child's surviving output, not text the child's own revert undid", async () => {
      const ws = workspace();
      const result = await importAll(ws, { selection: only("ses_revparent") });
      const parentFile = fileOf(result, "ses_revparent");
      expect(await resolveAgentUrl(parentFile, "agent://WholeRevertChild")).toBe("kept child answer\n");
      expect(await resolveAgentUrl(parentFile, "agent://PartialRevertChild")).toBe("kept part answer\n");

      // The resumed child transcripts agree with that output.
      const artifacts = parentFile.slice(0, -".jsonl".length);
      const whole = (await openSession(join(artifacts, "WholeRevertChild.jsonl"))).contextText;
      expect(whole).toContain("kept child answer");
      expect(whole).not.toContain("reverted child answer");
      const partial = (await openSession(join(artifacts, "PartialRevertChild.jsonl"))).contextText;
      expect(partial).toContain("kept part answer");
      expect(partial).not.toContain("dropped part answer");
      expect(partial).not.toContain("later child answer");
      // The parent's task result is what the parent saw at the time and stays that way.
      expect(JSON.stringify((await openSession(parentFile)).messages)).toContain("WHOLE CHILD LAST OUTPUT");
    });
  });

  describe("project containment", () => {
    it("is a bounded relative-path check on the project's own platform flavor", () => {
      expect(inProject("/work/a/sub", "/work/a")).toBe(true);
      expect(inProject("/work/a", "/work/a/")).toBe(true);
      expect(inProject("/work/ab", "/work/a")).toBe(false);
      expect(inProject("/anything/at/all", "/")).toBe(true);
      // Windows paths, evaluated with win32 rules whatever the host is.
      expect(inProject("C:\\work\\app\\sub", "C:\\work\\app")).toBe(true);
      expect(inProject("C:\\work\\app", "C:\\work\\app\\")).toBe(true);
      expect(inProject("C:\\work\\apple", "C:\\work\\app")).toBe(false);
      expect(inProject("C:\\work\\app\\..\\other", "C:\\work\\app")).toBe(false);
      expect(inProject("C:\\work", "C:\\")).toBe(true);
      expect(inProject("D:\\work", "C:\\")).toBe(false);
      expect(inProject("c:\\WORK\\App\\x", "C:\\work\\app")).toBe(true);
    });
  });
});
