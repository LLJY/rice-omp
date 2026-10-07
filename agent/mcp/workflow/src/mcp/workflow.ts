#!/usr/bin/env -S bun --config=/dev/null --no-env-file
// omp spawns stdio servers in the user's project: ignore its bunfig.toml (preloads can corrupt stdout) and .env.
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolContext, ToolDefinition } from "../custom-tools/tool";
import * as workplan from "../custom-tools/workplan";
import { assertSafePathAccess, isWithinWorkspaceRoot, resolveWorkspaceRoot } from "../custom-tools/workplan/shared";

export const INSTRUCTIONS =
  'Durable workplans under .omp/workplan/. Only use when the user says "use workflow(s)": load skill://workflow-plan when planning and skill://workflow-execute when executing an approved plan.';

type WorkspaceTool = readonly [name: string, definition: ToolDefinition<any>, mutates: boolean];

export const WORKPLAN_TOOLS: readonly WorkspaceTool[] = [
  ["workplan_create", workplan.create, true],
  ["workplan_inspect", workplan.inspect, false],
  ["workplan_list", workplan.list, false],
  ["workplan_patch", workplan.patch, true],
  ["workplan_read", workplan.read, false],
  ["workplan_reset", workplan.reset, true],
  ["workplan_update", workplan.update, true],
  ["workplan_validate", workplan.validate, false],
];

type Extra = { signal: AbortSignal; sessionId?: string; requestId: string | number };

/** Session workspace root: omp's MCP root (follows the session working dir), else the process cwd. */
async function sessionRoot(server: McpServer, signal: AbortSignal): Promise<string> {
  if (!server.server.getClientCapabilities()?.roots) return process.cwd();
  const { roots } = await server.server.listRoots(undefined, { signal });
  const root = roots.find((entry) => entry.uri.startsWith("file://"));
  if (!root) throw new Error("Client advertised MCP roots but provided no file:// root.");
  return fileURLToPath(root.uri);
}

/** Port of rice-opencode's createWorkspaceTool guards, bound to the omp session root. */
async function runWorkspaceTool(
  server: McpServer,
  [name, definition, mutates]: WorkspaceTool,
  args: Record<string, unknown>,
  extra: Extra,
): Promise<CallToolResult> {
  extra.signal.throwIfAborted();
  const worktree = resolve(await sessionRoot(server, extra.signal));
  const rootStat = await lstat(worktree);
  if (rootStat.isSymbolicLink()) throw new Error("Session workspace root must not be a symbolic link.");
  if (!rootStat.isDirectory()) throw new Error("Session workspace root must be a directory.");

  const override = typeof args.workspaceRoot === "string" ? args.workspaceRoot : undefined;
  const workspaceRoot = resolveWorkspaceRoot(worktree, override);
  if (!isWithinWorkspaceRoot(worktree, workspaceRoot)) {
    throw new Error("workspaceRoot must stay inside the session workspace root.");
  }
  await assertSafePathAccess(worktree, workspaceRoot, "workspaceRoot");

  const context: ToolContext = {
    worktree,
    directory: worktree,
    sessionID: extra.sessionId ?? "",
    messageID: String(extra.requestId),
    agent: "omp",
    abort: extra.signal,
    metadata() {},
    // Approval is omp's job (readOnlyHint annotations); this only re-validates write targets.
    async ask(permission) {
      extra.signal.throwIfAborted();
      if (permission.permission === "external_directory") {
        throw new Error("External workspace access is not allowed.");
      }
      if (permission.permission !== "edit" || !mutates) {
        throw new Error(`Unsupported ${name} permission: ${permission.permission}`);
      }
      if (!permission.patterns.length) throw new Error(`${name} requires a target path.`);
      for (const pattern of permission.patterns) {
        const target = resolve(worktree, pattern);
        if (!isWithinWorkspaceRoot(worktree, target)) {
          throw new Error(`${name} target must stay inside the session workspace root.`);
        }
        await assertSafePathAccess(worktree, target, "Patch target");
      }
    },
  };

  extra.signal.throwIfAborted();
  const result = await definition.execute(args, context);
  return { content: [{ type: "text", text: typeof result === "string" ? result : result.output }] };
}

export function createWorkflowServer(tools: readonly WorkspaceTool[] = WORKPLAN_TOOLS): McpServer {
  const server = new McpServer({ name: "workflow", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  for (const entry of tools) {
    const [name, definition, mutates] = entry;
    server.registerTool(
      name,
      { description: definition.description, inputSchema: definition.schema, annotations: { readOnlyHint: !mutates } },
      (args, extra) => runWorkspaceTool(server, entry, args as Record<string, unknown>, extra),
    );
  }

  return server;
}

if (import.meta.main) {
  await createWorkflowServer().connect(new StdioServerTransport());
}
