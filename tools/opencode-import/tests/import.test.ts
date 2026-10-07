import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { OpenCodeDb, SessionTree } from "../src/db";
import { planImport, runImport } from "../src/import";
import { parseSince, readIdsFile } from "../src/select";
import { MISSING_DIR, T } from "./fixture";
import { OMP_AVAILABLE, cleanupTmp, discoverSubSessions, fileOf, importAll, openSession, readJsonl, tmp, workspace } from "./helpers";

type Json = Record<string, any>;

afterAll(cleanupTmp);

const iso = (offsetSeconds: number) => new Date(T + offsetSeconds * 1000).toISOString();

function toolResults(messages: Json[]): Record<string, Json> {
  return Object.fromEntries(messages.filter(m => m.role === "toolResult").map(m => [m.toolCallId, m]));
}

const resultText = (message: Json) => message.content.map((b: Json) => b.text ?? "").join("");

/** Root session files directly inside the session dir. */
function rootFiles(dir: string): string[] {
  return readdirSync(dir).filter(name => name.endsWith(".jsonl")).map(name => join(dir, name));
}

function updateSource(dbPath: string, sql: string, ...params: (string | number)[]): void {
  const db = new Database(dbPath);
  db.query(sql).run(...params);
  db.close();
}

describe.skipIf(!OMP_AVAILABLE)("opencode-import", () => {
  describe("tool call/result pairing", () => {
    it("pairs every call with exactly one result, flagging error and interrupted tools", async () => {
      const ws = workspace();
      const result = await importAll(ws, { selection: { ids: ["ses_tools"], all: false } });
      const { messages } = await openSession(fileOf(result, "ses_tools"));

      const calls = messages.filter(m => m.role === "assistant").flatMap(m => m.content.filter((b: Json) => b.type === "toolCall"));
      const results = toolResults(messages);
      expect(calls.map(c => c.id)).toEqual(["c_ok", "c_err", "c_run", "c_int"]);
      expect(Object.keys(results).sort()).toEqual(["c_err", "c_int", "c_ok", "c_run"]);

      expect(results.c_ok.isError).toBe(false);
      expect(resultText(results.c_ok)).toBe("file-a\nfile-b");
      expect(results.c_err.isError).toBe(true);
      expect(resultText(results.c_err)).toBe("command failed: exit 2");
      // A tool that never finished replays as an interrupted error, as OpenCode itself does.
      expect(results.c_run.isError).toBe(true);
      expect(resultText(results.c_run)).toBe("[Tool execution was interrupted]");
      // An interrupted tool that had produced partial output keeps it.
      expect(results.c_int.isError).toBe(true);
      expect(resultText(results.c_int)).toBe("partial output");
      expect(result.summary.sessions.failed).toBe(0);
    });
  });

  describe("compaction", () => {
    it("keeps the retained tail: firstKeptEntryId is the tail's first entry, before the compaction", async () => {
      const ws = workspace();
      const result = await importAll(ws, { selection: { ids: ["ses_ctail"], all: false } });
      const { entries, branchIds, contextText } = await openSession(fileOf(result, "ses_ctail"));

      const compaction = entries.find(e => e.type === "compaction")!;
      const tailEntry = entries.find(e => e.type === "message" && JSON.stringify(e.message).includes("tail question"))!;
      expect(compaction.summary).toBe("SUMMARY OF EARLIER WORK");
      expect(compaction.firstKeptEntryId).toBe(tailEntry.id);
      expect(branchIds.indexOf(compaction.firstKeptEntryId)).toBeGreaterThanOrEqual(0);
      expect(branchIds.indexOf(compaction.firstKeptEntryId)).toBeLessThan(branchIds.indexOf(compaction.id));

      expect(contextText).toContain("SUMMARY OF EARLIER WORK");
      expect(contextText).toContain("tail question");
      expect(contextText).toContain("after answer");
      expect(contextText).not.toContain("first question");
    });

    it("without a tail, the compaction entry is its own first kept entry and only post-compaction turns survive", async () => {
      const ws = workspace();
      const result = await importAll(ws, { selection: { ids: ["ses_cnotail"], all: false } });
      const { entries, contextText } = await openSession(fileOf(result, "ses_cnotail"));

      const compaction = entries.find(e => e.type === "compaction")!;
      expect(compaction.firstKeptEntryId).toBe(compaction.id);
      expect(contextText).toContain("SUMMARY OF EARLIER WORK");
      expect(contextText).toContain("after question");
      expect(contextText).not.toContain("tail question");
      expect(contextText).not.toContain("first question");
    });
  });

  describe("revert", () => {
    it("whole-message revert: reverted messages are off the active branch but kept in the file", async () => {
      const ws = workspace();
      const result = await importAll(ws, { selection: { ids: ["ses_revwhole"], all: false } });
      const file = fileOf(result, "ses_revwhole");
      const { entries, branchIds, contextText } = await openSession(file);

      expect(contextText).toContain("keep answer");
      expect(contextText).not.toContain("reverted question");
      expect(contextText).not.toContain("reverted answer");
      // Nothing from the reverted messages sits on the active branch ...
      const reverted = entries.filter(e => e.type === "message" && /reverted (question|answer)/.test(JSON.stringify(e.message)));
      expect(reverted.length).toBe(2);
      for (const entry of reverted) expect(branchIds).not.toContain(entry.id);
      // ... but the data is not lost, and a marker records why.
      const marker = entries.find(e => e.type === "custom" && e.customType === "opencode_revert")!;
      expect(marker.data.excludedMessageIds).toEqual(["rw_u2", "rw_a2"]);
      expect(branchIds).toContain(marker.id);
    });

    it("partial revert: parts before the revert point stay, the rest and later messages are excluded", async () => {
      const ws = workspace();
      const result = await importAll(ws, { selection: { ids: ["ses_revpart"], all: false } });
      const { entries, branchIds, contextText } = await openSession(fileOf(result, "ses_revpart"));

      expect(contextText).toContain("partial question");
      expect(contextText).toContain("kept text");
      expect(contextText).not.toContain("dropped text");
      expect(contextText).not.toContain("later question");
      expect(contextText).not.toContain("later answer");
      const offBranch = entries.filter(e => e.type === "message" && /dropped text|later (question|answer)/.test(JSON.stringify(e.message)));
      expect(offBranch.length).toBeGreaterThan(0);
      for (const entry of offBranch) expect(branchIds).not.toContain(entry.id);
      const marker = entries.find(e => e.type === "custom" && e.customType === "opencode_revert")!;
      expect(marker.data.partial).toBe(true);
    });
  });

  describe("subagents", () => {
    it("writes children in omp's native layout, linked from the parent's task calls", async () => {
      const ws = workspace();
      const result = await importAll(ws, { selection: { ids: ["ses_parent"], all: false } });
      expect(result.summary.sessions).toEqual({ converted: 4, failed: 0 });
      const parentFile = fileOf(result, "ses_parent");
      const artifacts = parentFile.slice(0, -".jsonl".length);

      // <parent minus .jsonl>/<AgentId>.jsonl (+ .md), nested ids dot-qualified under the owner's directory.
      const childFile = join(artifacts, "ValidateFallbackPlan.jsonl");
      const siblingFile = join(artifacts, "ImplementFix.jsonl");
      const grandFile = join(artifacts, "ValidateFallbackPlan", "ValidateFallbackPlan.DigDeeper.jsonl");
      for (const file of [childFile, siblingFile, grandFile]) expect(existsSync(file)).toBe(true);
      expect(readdirSync(artifacts).sort()).toEqual(["ImplementFix.jsonl", "ImplementFix.md", "ValidateFallbackPlan", "ValidateFallbackPlan.jsonl", "ValidateFallbackPlan.md"]);
      // `agent://<id>` reads <id>.md: the child's final output.
      expect(await Bun.file(join(artifacts, "ValidateFallbackPlan.md")).text()).toBe("PLAN STILL OK\n");
      expect(await Bun.file(join(artifacts, "ImplementFix.md")).text()).toBe("FIX DONE\n");

      // header.parentSession is the owner's file, exactly as omp's task executor records it.
      const childHeader = readJsonl(childFile).find(e => e.type === "session")!;
      expect(childHeader.parentSession).toBe(parentFile);
      expect(childHeader.cwd).toBe(ws.cwd);
      const grandHeader = readJsonl(grandFile).find(e => e.type === "session")!;
      expect(grandHeader.parentSession).toBe(childFile);
      const parentHeader = readJsonl(parentFile).find(e => e.type === "session")!;
      expect(parentHeader.parentSession).toBeUndefined();

      // omp's own sub-session discovery (/export, /dump all) finds the tree.
      const found = await discoverSubSessions(parentFile);
      expect(Object.keys(found).sort()).toEqual(["ImplementFix", "ValidateFallbackPlan", "ValidateFallbackPlan/ValidateFallbackPlan.DigDeeper"]);
      expect(found.ImplementFix.parent).toBeNull();
      expect(found["ValidateFallbackPlan/ValidateFallbackPlan.DigDeeper"].parent).toBe("ValidateFallbackPlan");

      // The parent's task results carry omp's task-result envelope and details.results[].id.
      const { messages, entries } = await openSession(parentFile);
      const results = toolResults(messages);
      const linked = results.c_t1;
      expect(resultText(linked)).toContain('<task-result id="ValidateFallbackPlan" agent="plan-checker" status="completed"');
      expect(resultText(linked)).toContain("PLAN OK");
      expect(linked.details.results[0]).toMatchObject({ id: "ValidateFallbackPlan", agent: "plan-checker", exitCode: 0, output: "PLAN OK" });
      expect(results.c_t3.details.results[0].id).toBe("ImplementFix");
      // A resumed call (task_id) points at the same child.
      expect(results.c_t2.details.results[0].id).toBe("ValidateFallbackPlan");
      // The model sees the call in omp's task schema; the OpenCode arguments stay in details.
      const call = messages.filter(m => m.role === "assistant").flatMap(m => m.content).find((b: Json) => b.type === "toolCall" && b.id === "c_t1");
      expect(call.arguments.tasks[0]).toMatchObject({ agent: "plan-checker", name: "ValidateFallbackPlan" });
      expect(linked.details.opencode.originalArguments.subagent_type).toBe("plan-checker");
      // A task call whose child is not part of this session stays an ordinary tool result, and an interrupted one stays an error.
      expect(results.c_t5.details.results).toBeUndefined();
      expect(results.c_t5.details.opencode.unlinkedChildSessionId).toBe("ses_not_a_child");
      expect(results.c_t4.isError).toBe(true);
      expect(entries.find(e => e.type === "custom" && e.customType === "opencode_import")!.data.subagents.map((s: Json) => s.agentId)).toEqual(["ValidateFallbackPlan", "ImplementFix"]);

      // The child is a complete, resumable session of its own, with the nested call linked to its child.
      const child = await openSession(childFile);
      expect(child.contextText).toContain("PLAN STILL OK");
      expect(toolResults(child.messages).c_g1.details.results[0].id).toBe("ValidateFallbackPlan.DigDeeper");
    });
  });

  describe("selection", () => {
    it("--since selects by the root's time_updated and still brings descendants older than the window", async () => {
      const ws = workspace();
      const since = parseSince(iso(4000));
      const db = new OpenCodeDb(ws.dbPath);
      const plan = await planImport({ dbPath: ws.dbPath, sessionDir: ws.sessionDir, selection: { ids: [], all: false, since }, dryRun: true, force: false }, db, new SessionTree(db.listSessions()));
      db.close();
      expect(plan.entries.map(e => e.root.id)).toEqual(["ses_parent"]);
      expect(plan.entries[0].descendants).toBe(3);
      expect(plan.entries[0].sessions.map(s => s.id)).toEqual(["ses_parent", "ses_childA", "ses_grand", "ses_childB"]);
      // Children are older than the window; they come along anyway.
      expect(plan.entries[0].sessions.filter(s => s.time_updated < since).length).toBe(3);

      const result = await importAll(ws, { selection: { ids: [], all: false, since } });
      expect(result.summary.roots.converted).toBe(1);
      expect(result.summary.sessions.converted).toBe(4);
      expect(existsSync(join(fileOf(result, "ses_parent").slice(0, -6), "ImplementFix.jsonl"))).toBe(true);
    });

    it("--since parses relative and absolute forms", () => {
      const now = new Date(2026, 9, 7, 15, 30);
      expect(parseSince("90d", now)).toBe(new Date(2026, 6, 9).getTime());
      expect(parseSince("2026-07-09", now)).toBe(new Date(2026, 6, 9).getTime());
      expect(parseSince("12h", now)).toBe(now.getTime() - 12 * 3_600_000);
      expect(() => parseSince("lately", now)).toThrow(/--since/);
    });

    it("--ids-file accepts id strings or objects; a child id converts its own subtree, standalone", async () => {
      const ws = workspace();
      const idsFile = join(tmp(), "scores.json");
      writeFileSync(idsFile, JSON.stringify([{ id: "ses_childA", title: "scorer output", score: 80 }, "ses_old"]));
      const ids = readIdsFile(idsFile);
      expect(ids).toEqual(["ses_childA", "ses_old"]);

      const result = await importAll(ws, { selection: { ids, all: false } });
      expect(result.summary.roots.converted).toBe(2);
      expect(result.summary.sessions.converted).toBe(3); // childA + its grandchild + old
      const childFile = fileOf(result, "ses_childA");
      // Standalone: a root file in the session dir, no parent link, but its own subagent is still linked.
      expect(readJsonl(childFile).find(e => e.type === "session")!.parentSession).toBeUndefined();
      expect(existsSync(join(childFile.slice(0, -6), "ValidateFallbackPlan.DigDeeper.jsonl"))).toBe(false);
      expect(Object.keys(await discoverSubSessions(childFile))).toEqual(["DigDeeper"]);
      expect(rootFiles(ws.sessionDir).length).toBe(2);
    });

    it("an explicit id already inside a selected root's subtree is not imported twice", async () => {
      const ws = workspace();
      const result = await importAll(ws, { selection: { ids: ["ses_parent", "ses_childB", "ses_grand", "ses_missing"], all: false } });
      expect(result.summary.roots.converted).toBe(1);
      expect(result.plan.covered).toEqual({ ses_childB: "ses_parent", ses_grand: "ses_parent" });
      expect(result.plan.unknown).toEqual(["ses_missing"]);
      expect(rootFiles(ws.sessionDir).length).toBe(1);
    });

    it("--project matches the directory and its subdirectories, not a longer sibling name", async () => {
      const ws = workspace();
      const db = new OpenCodeDb(ws.dbPath);
      const plan = await planImport({ dbPath: ws.dbPath, sessionDir: ws.sessionDir, selection: { ids: [], all: false, project: "/work/a" }, dryRun: true, force: false }, db, new SessionTree(db.listSessions()));
      db.close();
      expect(plan.entries.map(e => e.root.id).sort()).toEqual(["ses_projA", "ses_projA2"]);
    });

    it("--dry-run reports the plan and writes nothing", async () => {
      const ws = workspace();
      const { plan, summary } = await runImport({ dbPath: ws.dbPath, sessionDir: ws.sessionDir, selection: { ids: [], all: true }, dryRun: true, force: false });
      const parent = plan.entries.find(e => e.root.id === "ses_parent")!;
      expect(parent).toMatchObject({ descendants: 3, rootMessages: 4, status: "new" });
      expect(parent.totalMessages).toBe(4 + 2 + 2 + 2);
      expect(summary.sessions.converted).toBe(0);
      expect(existsSync(ws.sessionDir)).toBe(false);
    });
  });

  describe("destination", () => {
    it("keeps a source cwd that no longer exists; --fallback-cwd re-roots only on request", async () => {
      const ws = workspace();
      const kept = await importAll(ws, { selection: { ids: ["ses_missingcwd"], all: false } });
      const keptHeader = readJsonl(fileOf(kept, "ses_missingcwd")).find(e => e.type === "session")!;
      expect(keptHeader.cwd).toBe(MISSING_DIR);

      const ws2 = workspace();
      const rerooted = await importAll(ws2, { selection: { ids: ["ses_missingcwd"], all: false }, fallbackCwd: ws2.cwd });
      const header = readJsonl(fileOf(rerooted, "ses_missingcwd")).find(e => e.type === "session")!;
      expect(header.cwd).toBe(ws2.cwd);
      const importEntry = readJsonl(fileOf(rerooted, "ses_missingcwd")).find(e => e.customType === "opencode_import")!;
      expect(importEntry.data.fallbackCwd).toEqual({ from: MISSING_DIR, to: ws2.cwd });
      expect(importEntry.data.cwd).toBe(MISSING_DIR);
    });

    it("without --session-dir, writes under omp's per-cwd directory (CLI, isolated agent dir)", async () => {
      const ws = workspace();
      const agentDir = tmp("opencode-import-agent-");
      const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "--db", ws.dbPath, "ses_tools"], {
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect({ code, err: code === 0 ? "" : err }).toEqual({ code: 0, err: "" });
      expect(out).toContain("converted: 1 root(s), 1 session(s)");
      const sessionsRoot = join(agentDir, "sessions");
      const bucket = readdirSync(sessionsRoot).filter(name => !name.startsWith("."));
      expect(bucket.length).toBe(1);
      expect(readdirSync(join(sessionsRoot, bucket[0])).some(name => name.endsWith(".jsonl"))).toBe(true);
      expect(existsSync(join(sessionsRoot, ".opencode-import.json"))).toBe(true);
    });
  });

  describe("manifest idempotency", () => {
    it("a second run skips unchanged sessions; an updated source re-converts and replaces the old output", async () => {
      const ws = workspace();
      const first = await importAll(ws);
      const totalRoots = first.summary.roots.converted;
      expect(totalRoots).toBeGreaterThan(5);
      expect(first.summary.roots.failed).toBe(0);
      const manifest = JSON.parse(await Bun.file(join(ws.sessionDir, ".opencode-import.json")).text());
      expect(Object.keys(manifest.bundles).length).toBe(totalRoots);
      expect(manifest.bundles.ses_parent.members.ses_grand.file).toContain("ValidateFallbackPlan.DigDeeper.jsonl");
      expect(manifest.bundles.ses_parent.members.ses_grand.timeUpdated).toBe(T + 5000);

      const before = new Map(rootFiles(ws.sessionDir).map(f => [f, statSync(f).mtimeMs]));
      const second = await importAll(ws);
      expect(second.summary.roots).toEqual({ converted: 0, skipped: totalRoots, failed: 0 });
      expect(second.summary.skipped.every(s => s.status === "unchanged")).toBe(true);
      expect(new Map(rootFiles(ws.sessionDir).map(f => [f, statSync(f).mtimeMs]))).toEqual(before);

      // A descendant changes at the source: the whole bundle is converted again and replaces the old files.
      const oldParent = fileOf(first, "ses_parent");
      updateSource(ws.dbPath, "UPDATE session SET time_updated = ? WHERE id = 'ses_grand'", T + 9000 * 1000);
      const third = await importAll(ws);
      expect(third.summary.roots).toEqual({ converted: 1, skipped: totalRoots - 1, failed: 0 });
      expect(third.summary.files[0].id).toBe("ses_parent");
      const newParent = fileOf(third, "ses_parent");
      expect(newParent).not.toBe(oldParent);
      expect(existsSync(oldParent)).toBe(false);
      expect(existsSync(oldParent.slice(0, -6))).toBe(false);
      expect(existsSync(join(newParent.slice(0, -6), "ValidateFallbackPlan", "ValidateFallbackPlan.DigDeeper.jsonl"))).toBe(true);
      expect(rootFiles(ws.sessionDir).length).toBe(totalRoots);

      // --force converts everything again.
      const forced = await importAll(ws, { force: true });
      expect(forced.summary.roots.converted).toBe(totalRoots);
      expect(rootFiles(ws.sessionDir).length).toBe(totalRoots);
    });

    it("does not overwrite a session that was continued in omp after import; --force does", async () => {
      const ws = workspace();
      const first = await importAll(ws, { selection: { ids: ["ses_tools"], all: false } });
      const file = fileOf(first, "ses_tools");
      appendFileSync(file, `${JSON.stringify({ type: "custom", customType: "continued_in_omp", id: "zz", parentId: null, timestamp: iso(1), data: {} })}\n`);
      updateSource(ws.dbPath, "UPDATE session SET time_updated = time_updated + 1 WHERE id = 'ses_tools'");

      const second = await importAll(ws, { selection: { ids: ["ses_tools"], all: false } });
      expect(second.summary.roots).toEqual({ converted: 0, skipped: 1, failed: 0 });
      expect(second.summary.skipped[0].status).toBe("diverged");
      expect(existsSync(file)).toBe(true);

      const forced = await importAll(ws, { selection: { ids: ["ses_tools"], all: false }, force: true });
      expect(forced.summary.roots.converted).toBe(1);
      expect(existsSync(file)).toBe(false);
    });
  });

  describe("robustness", () => {
    it("one bad session does not abort the batch; a failed child is reported, kept out of its bundle, and retried", async () => {
      const ws = workspace();
      // A child of ses_childB with no usable directory, and a root with none either.
      const db = new Database(ws.dbPath);
      for (const [id, parent] of [["ses_badchild", "ses_childB"], ["ses_badroot", null]] as const) {
        db.query("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'p', ?, ?, '', 'bad', '1', ?, ?)").run(id, parent, id, T + 1, T + 800 * 1000);
        db.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(`${id}_m`, id, T + 2, T + 2, JSON.stringify({ role: "user" }));
        db.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(`${id}_p`, `${id}_m`, id, T + 2, T + 2, JSON.stringify({ type: "text", text: "hi" }));
      }
      db.close();

      const logs: string[] = [];
      const result = await importAll(ws, { log: m => logs.push(m) });
      const { summary } = result;
      expect(summary.roots.failed).toBe(1);
      expect(summary.failures.map(f => f.id).sort()).toEqual(["ses_badchild", "ses_badroot"]);
      expect(summary.failures.find(f => f.id === "ses_badroot")!.error).toMatch(/no directory/);
      expect(logs.some(l => l.includes("ses_badroot") && l.includes("FAILED"))).toBe(true);
      // Everything else converted, including the parent whose child failed.
      expect(summary.roots.converted).toBeGreaterThan(5);
      expect(existsSync(join(fileOf(result, "ses_parent").slice(0, -6), "ImplementFix.jsonl"))).toBe(true);
      expect(summary.files.some(f => f.id === "ses_badroot")).toBe(false);

      // The parent's bundle records the failed child, so the next run retries it instead of skipping.
      const manifest = JSON.parse(await Bun.file(join(ws.sessionDir, ".opencode-import.json")).text());
      expect(manifest.bundles.ses_parent.failed).toEqual(["ses_badchild"]);
      const again = await importAll(ws);
      expect(again.summary.failures.map(f => f.id).sort()).toEqual(["ses_badchild", "ses_badroot"]);
      expect(again.summary.roots.converted).toBe(1); // ses_parent retried; everything else skipped
    });

    it("rejects a database that is not an OpenCode store, and leaves the source database byte-identical", async () => {
      const dir = tmp();
      const bogus = join(dir, "x.db");
      const db = new Database(bogus);
      db.exec("CREATE TABLE unrelated (x)");
      db.close();
      expect(() => new OpenCodeDb(bogus)).toThrow(/not an OpenCode/);

      const ws = workspace();
      const digest = () => new Bun.CryptoHasher("sha256").update(readFileSync(ws.dbPath)).digest("hex");
      const before = digest();
      const result = await importAll(ws);
      expect(result.summary.roots.converted).toBeGreaterThan(5);
      expect(digest()).toBe(before);
    });
  });
});
