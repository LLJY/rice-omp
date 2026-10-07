import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { tool } from "../../src/custom-tools/tool";
import { INSTRUCTIONS, WORKPLAN_TOOLS, createWorkflowServer } from "../../src/mcp/workflow";

const temps: string[] = [];

afterEach(() => {
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(path);
  return path;
}

type Root = { current: string | null };
type Result = Awaited<ReturnType<Client["callTool"]>>;

async function connect(tools = WORKPLAN_TOOLS, root?: Root): Promise<Client> {
  const client = new Client({ name: "test", version: "0" }, root ? { capabilities: { roots: {} } } : {});
  if (root) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: root.current ? [{ uri: pathToFileURL(root.current).href }] : [],
    }));
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createWorkflowServer(tools).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function text(result: Result): string {
  return (result.content as Array<{ text: string }>)[0]!.text;
}

function errorText(result: Result): string {
  expect(result.isError).toBe(true);
  return text(result);
}

const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

describe("workflow MCP server", () => {
  it("exposes the instructions, read-only hints, and schemas", async () => {
    const client = await connect();
    expect(client.getInstructions()).toBe(INSTRUCTIONS);

    const { tools } = await client.listTools();
    expect(Object.fromEntries(tools.map((entry) => [entry.name, entry.annotations?.readOnlyHint]))).toEqual({
      workplan_create: false,
      workplan_inspect: true,
      workplan_list: true,
      workplan_patch: false,
      workplan_read: true,
      workplan_reset: false,
      workplan_update: false,
      workplan_validate: true,
    });
    const create = tools.find((entry) => entry.name === "workplan_create")!;
    expect([...(create.inputSchema.required ?? [])].sort()).toEqual(["goal", "id"]);
  });

  it("binds every call to the current MCP root and follows root changes", async () => {
    const first = tempDir("wf-root-a-");
    const second = tempDir("wf-root-b-");
    const root = { current: first };
    const client = await connect(WORKPLAN_TOOLS, root);

    const created = await call(client, "workplan_create", {
      id: "demo",
      goal: "Ship it",
      phases: [{ title: "Build", steps: [{ title: "Write code", validation: "bun test" }] }],
    });
    expect(created.isError).toBeFalsy();
    expect(JSON.parse(text(created)).path).toBe(join(first, ".omp", "workplan", "demo.json"));
    expect(existsSync(join(first, ".omp", "workplan", "demo.json"))).toBe(true);

    const patched = await call(client, "workplan_patch", {
      id: "demo",
      patchText: ["*** Begin Patch", "*** Update File: .omp/workplan/demo.md", "@@", "-## Goal", "+## Goal (patched)", "*** End Patch"].join("\n"),
    });
    expect(text(patched)).toContain("Patched workplan demo");
    expect(readFileSync(join(first, ".omp", "workplan", "demo.md"), "utf8")).toContain("## Goal (patched)");
    expect((await call(client, "workplan_validate", { id: "demo" })).isError).toBeFalsy();
    expect(JSON.parse(text(await call(client, "workplan_list"))).count).toBe(1);

    root.current = second;
    expect(JSON.parse(text(await call(client, "workplan_list"))).count).toBe(0);

    root.current = null;
    expect(errorText(await call(client, "workplan_list"))).toContain("provided no file:// root");
  });

  it("rejects external overrides and symlinked roots before execution", async () => {
    const rootDir = tempDir("wf-safe-root-");
    const outside = tempDir("wf-safe-outside-");
    const rootLink = `${rootDir}-link`;
    temps.push(rootLink);
    symlinkSync(rootDir, rootLink, "dir");
    symlinkSync(outside, join(rootDir, "outside-link"), "dir");

    let calls = 0;
    const probe = tool({
      description: "Count calls",
      args: { workspaceRoot: tool.schema.string().optional() },
      async execute() {
        calls += 1;
        return "called";
      },
    });
    const root = { current: rootDir };
    const client = await connect([["probe", probe, false]], root);

    expect(errorText(await call(client, "probe", { workspaceRoot: outside }))).toContain("workspaceRoot must stay inside");
    expect(errorText(await call(client, "probe", { workspaceRoot: "outside-link" }))).toContain("must not be a symlink");
    root.current = rootLink;
    expect(errorText(await call(client, "probe"))).toContain("must not be a symbolic link");
    expect(calls).toBe(0);
  });

  it("validates write targets requested through ask", async () => {
    const outside = tempDir("wf-ask-outside-");
    const asker = (permission: string, target: string) =>
      tool({
        description: "Ask for a permission",
        args: {},
        async execute(_args, context) {
          await context.ask({ permission, patterns: [target], always: [target], metadata: {} });
          return "approved";
        },
      });
    const client = await connect(
      [
        ["write_outside", asker("edit", outside), true],
        ["write_inside", asker("edit", "notes.md"), true],
        ["readonly_write", asker("edit", "notes.md"), false],
        ["external", asker("external_directory", outside), true],
      ],
      { current: tempDir("wf-ask-root-") },
    );

    expect(errorText(await call(client, "write_outside"))).toContain("target must stay inside");
    expect(text(await call(client, "write_inside"))).toBe("approved");
    expect(errorText(await call(client, "readonly_write"))).toContain("Unsupported");
    expect(errorText(await call(client, "external"))).toContain("External workspace access is not allowed");
  });

  it("applies schema defaults, maps structured output, and propagates cancellation", async () => {
    const probe = tool({
      description: "Defaulted structured result",
      args: { value: tool.schema.string().default("default") },
      async execute(args) {
        return { output: args.value, metadata: { ignored: true } };
      },
    });
    let seen: AbortSignal | undefined;
    const slow = tool({
      description: "Wait for cancellation",
      args: {},
      async execute(_args, context) {
        seen = context.abort;
        await new Promise((_, reject) => context.abort.addEventListener("abort", () => reject(context.abort.reason), { once: true }));
        return "unreachable";
      },
    });
    const client = await connect(
      [
        ["probe", probe, false],
        ["slow", slow, false],
      ],
      { current: tempDir("wf-map-root-") },
    );

    expect(text(await call(client, "probe"))).toBe("default");
    expect((await call(client, "probe", { value: 1 })).isError).toBe(true);

    const controller = new AbortController();
    const pending = client.callTool({ name: "slow", arguments: {} }, undefined, { signal: controller.signal });
    while (!seen) await Bun.sleep(5);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow();
    for (let i = 0; i < 100 && !seen.aborted; i += 1) await Bun.sleep(5);
    expect(seen.aborted).toBe(true);
  });

  it("starts over stdio via its shebang, ignores the project's bunfig, and falls back to its cwd", async () => {
    const cwd = tempDir("wf-stdio-");
    writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    writeFileSync(join(cwd, "preload.ts"), 'require("node:fs").writeFileSync("PRELOADED", "");\n');
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: fileURLToPath(new URL("../../src/mcp/workflow.ts", import.meta.url)),
        cwd,
        stderr: "pipe",
      }),
    );

    try {
      expect(client.getInstructions()).toBe(INSTRUCTIONS);
      expect((await call(client, "workplan_create", { id: "stdio-demo", goal: "Prove cwd fallback" })).isError).toBeFalsy();
      expect(existsSync(join(cwd, ".omp", "workplan", "stdio-demo.json"))).toBe(true);
      expect(existsSync(join(cwd, "PRELOADED"))).toBe(false);
    } finally {
      await client.close();
    }
  });
});
