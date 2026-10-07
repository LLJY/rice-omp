/**
 * OpenCode session -> native omp session entries. Pure: no filesystem, no omp imports.
 *
 * The mapping (message/part -> omp message entries, tool call/result pairing, step usage, compaction boundaries,
 * revert handling, provenance) is the behavior verified by resuming real converted sessions in omp. Spec and
 * rationale: README.md ("What maps").
 */
import * as crypto from "node:crypto";
import { type ChildLink, taskEnvelope, taskResultText } from "./children";
import { type Json, type SourceMessage, type SourcePart, type SourceSession, safeParse } from "./db";

export const CONVERTER = { name: "rice-omp/opencode-import", version: 2 };
const CLEARED_MARKER = "[Old tool result content cleared]"; // OpenCode's provider-context substitute for pruned output
const INTERRUPTED_MARKER = "[Tool execution was interrupted]"; // OpenCode's replay text for pending/running tools

export interface BuildOptions {
  /** Exact `provider/model` selectors omp can resolve; only those get `model_change` entries. */
  resolvable: Set<string>;
  /** Direct children of this session by OpenCode session id (see planChildren). */
  children: Map<string, ChildLink>;
  /** Recorded when the source cwd is missing and the importer re-rooted the session. */
  fallbackCwd?: { from: string; to: string };
  /**
   * Validated omp model (`provider/model`, resolvable) to resume on when no source model is resolvable. omp restores a
   * session's model from its newest explicit default `model_change`, else from the assistant messages' own
   * provider/model; with neither resolvable a headless resume fails ("Could not restore model ..."). A session whose
   * active branch has assistant messages but no model_change gets one to this model as its first entry.
   */
  defaultModel?: string;
}

export interface BuiltSession {
  entries: Json[];
  title: string | undefined;
  counts: Json;
  /** True when a bare `omp --resume` of this session cannot restore a model (assistant messages, no resolvable model, no default model). */
  needsModelFlag: boolean;
}

const isRecord = (v: unknown): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);
const iso = (ms: number) => new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function pick(obj: Json, omit: string[]): Json | undefined {
  const out: Json = {};
  for (const [k, v] of Object.entries(obj ?? {})) if (!omit.includes(k)) out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}

interface DataUri {
  mime: string;
  base64: string;
  bytes: number;
}
function parseDataUri(url: unknown): DataUri | undefined {
  if (typeof url !== "string") return undefined;
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url);
  if (!m || !/;base64/i.test(m[2])) return undefined;
  const base64 = m[3];
  return { mime: m[1] || "application/octet-stream", base64, bytes: Math.floor((base64.length * 3) / 4) };
}

/** Attachment metadata that never carries the bytes (large PDFs stay in the OpenCode DB). */
function attachmentMeta(file: Json, partId?: string): Json {
  const uri = parseDataUri(file.url);
  return {
    partId,
    mime: file.mime,
    filename: file.filename,
    url: uri ? undefined : file.url,
    inlineData: uri ? { bytes: uri.bytes, sha256: crypto.createHash("sha256").update(Buffer.from(uri.base64, "base64")).digest("hex") } : undefined,
    source: file.source,
  };
}

/**
 * Map an OpenCode FilePart to model-visible blocks. Image data URIs become image content; text/plain and directory
 * references are already expanded into synthetic text parts by OpenCode (metadata only); anything else becomes an
 * explanatory note because omp message content only carries text and images.
 */
function fileBlocks(file: Json, partId?: string): { blocks: Json[]; meta: Json } {
  const meta = attachmentMeta(file, partId);
  const mime = String(file.mime ?? "");
  const uri = parseDataUri(file.url);
  if (uri && mime.startsWith("image/")) {
    return { blocks: [{ type: "image", mimeType: uri.mime.startsWith("image/") ? uri.mime : mime, data: uri.base64 }], meta };
  }
  if (mime === "text/plain" || mime === "application/x-directory") return { blocks: [], meta };
  const name = file.filename ?? "file";
  const where = uri ? `${uri.bytes} bytes inline` : typeof file.url === "string" ? file.url : "no url";
  const why = mime.startsWith("image/") ? "original image bytes are not available" : "omp message content cannot carry this media type";
  return { blocks: [{ type: "text", text: `[Attachment not embedded: ${name} (${mime || "unknown type"}, ${where}); ${why}]` }], meta };
}

// ---------------------------------------------------------------------------------------------- item model

type Item =
  | { kind: "message"; ts: number; msgId: string; message: Json }
  | { kind: "custom"; ts: number; customType: string; data: Json }
  | { kind: "model"; ts: number; model: string }
  | { kind: "compaction"; ts: number; summary: string; keptFromMsgId?: string; tokensBefore: number; details: Json };

/** One task call's slice of its child's cumulative usage (a child resumed by several calls is counted once overall). */
interface UsageShare {
  usage: Json;
  tokens: number;
  calls: number;
}

interface Ctx {
  resolvable: Set<string>;
  children: Map<string, ChildLink>;
  /** Usage share per linked `task` tool part id. */
  taskUsage: Map<string, UsageShare>;
  trackModel: boolean;
  lastModel?: string;
  unresolved: Set<string>;
  lastTotal: number;
  stats: { messages: number; toolCalls: number; toolResults: number; interrupted: number; pruned: number; images: number; linkedSubagents: number };
}

function usageFrom(tokens: Json, cost: unknown): Json {
  const input = num(tokens?.input);
  const reasoning = num(tokens?.reasoning);
  const output = num(tokens?.output) + reasoning; // omp output includes reasoning; OpenCode's excludes it
  const cacheRead = num(tokens?.cache?.read);
  const cacheWrite = num(tokens?.cache?.write);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    // OpenCode keeps only an aggregate cost; the per-bucket split is not recoverable.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: num(cost) },
  };
}

// ---------------------------------------------------------------------------------------------- user messages

function convertUser(m: SourceMessage): Item[] {
  const info = m.info;
  const content: Json[] = [];
  const meta: Json = {
    role: "user",
    sourceMessageId: m.id,
    time: info.time,
    agent: info.agent,
    model: info.model,
    system: info.system,
    tools: info.tools,
    format: info.format,
    summary: info.summary, // user title/diff summary: source metadata, NOT a context compaction
    extra: pick(info, ["role", "time", "agent", "model", "system", "tools", "format", "summary"]),
    ignoredText: [] as Json[],
    syntheticTextPartIds: [] as string[],
    files: [] as Json[],
    otherParts: [] as Json[],
  };
  let images = 0;
  for (const p of m.parts) {
    const d = p.data;
    switch (d.type) {
      case "text":
        if (d.ignored) meta.ignoredText.push({ partId: p.id, text: d.text, synthetic: d.synthetic, metadata: d.metadata });
        else if (typeof d.text === "string" && d.text !== "") {
          content.push({ type: "text", text: d.text });
          if (d.synthetic) meta.syntheticTextPartIds.push(p.id);
        }
        break;
      case "file": {
        const { blocks, meta: fm } = fileBlocks(d, p.id);
        for (const b of blocks) if (b.type === "image") images++;
        content.push(...blocks);
        meta.files.push(fm);
        break;
      }
      case "subtask":
        content.push({
          type: "text",
          text: `[Delegated task requested via OpenCode subtask${d.agent ? ` for agent "${d.agent}"` : ""}${d.description ? `: ${d.description}` : ""}]\n${d.prompt ?? ""}`.trimEnd(),
        });
        meta.otherParts.push({ partId: p.id, ...d });
        break;
      default:
        meta.otherParts.push({ partId: p.id, ...d });
    }
  }
  const items: Item[] = [];
  const ts = info.time?.created ?? m.created;
  if (content.length > 0) items.push({ kind: "message", ts, msgId: m.id, message: { role: "user", content, timestamp: ts } });
  items.push({ kind: "custom", ts, customType: "opencode_message", data: { ...meta, images, producedContext: content.length > 0 } });
  return items;
}

// ---------------------------------------------------------------------------------------------- assistant messages

interface Segment {
  startTs: number;
  parts: SourcePart[];
  finish?: Json;
  finishId?: string;
  start?: Json;
}

function toolArguments(state: Json): Record<string, unknown> {
  if (isRecord(state?.input) && Object.keys(state.input).length > 0) return state.input;
  if (typeof state?.raw === "string") {
    const parsed = safeParse(state.raw);
    if (isRecord(parsed)) return parsed;
  }
  return isRecord(state?.input) ? state.input : {};
}

/** `details.results[0]` of omp's own task tool result (SingleResult): what TUI task cards and exports read. */
function singleResult(ctx: Ctx, partId: string, link: ChildLink, state: Json, exitCode: number, text: string): Json {
  const share = shareOf(ctx, partId, link);
  const prompt = typeof state.input?.prompt === "string" ? state.input.prompt : "";
  const durationMs = Math.max(0, num(state.time?.end) - num(state.time?.start));
  return {
    index: 0,
    id: link.id,
    agent: link.agentType ?? "task",
    agentSource: "user",
    task: prompt,
    assignment: prompt,
    description: link.description,
    exitCode,
    output: text,
    stderr: "",
    truncated: false,
    durationMs,
    tokens: share.tokens,
    requests: 0,
    resolvedModel: link.model,
    usage: share.usage,
    outputMeta: { lineCount: text.split("\n").length, charCount: text.length },
    ...(exitCode === 0 ? {} : { error: typeof state.error === "string" ? state.error : "Task failed" }),
  };
}

function convertTool(p: SourcePart, segTs: number, ctx: Ctx): { call: Json; result: Json } {
  const d = p.data;
  const state: Json = d.state ?? {};
  const id = d.callID || `oc-${p.id}`;
  const name = d.tool || "unknown";
  const call: Json = { type: "toolCall", id, name, arguments: toolArguments(state) };
  const ts = state.time?.end ?? state.time?.start ?? p.created ?? segTs;
  const details: Json = {
    opencode: {
      partId: p.id,
      callID: d.callID,
      status: state.status,
      title: state.title,
      metadata: state.metadata,
      time: state.time,
      providerMetadata: pick(d, ["type", "callID", "tool", "state"]),
    },
  };
  const result: Json = { role: "toolResult", toolCallId: id, toolName: name, content: [], isError: false, timestamp: ts };
  const oc = details.opencode;
  const text = (t: string) => result.content.push({ type: "text", text: t });
  // A `task` call whose child session was converted alongside this one: link it the way omp links its own.
  const childId = name === "task" ? state.metadata?.sessionId : undefined;
  const link = typeof childId === "string" ? ctx.children.get(childId) : undefined;
  if (link) {
    oc.linkedSubagent = { sourceId: link.sourceId, agentId: link.id };
    // Show the model the call in omp's own task schema (`tasks[].name` is what omp turns into the agent id);
    // the OpenCode arguments stay in details. `solutionSpace` is required by omp's schema but OpenCode never had one.
    oc.originalArguments = call.arguments;
    const input = isRecord(call.arguments) ? call.arguments : {};
    call.arguments = {
      ...(typeof input.description === "string" ? { i: input.description } : {}),
      tasks: [{ agent: link.agentType ?? "task", name: link.name, task: typeof input.prompt === "string" ? input.prompt : "" }],
    };
  } else if (typeof childId === "string") oc.unlinkedChildSessionId = childId; // e.g. a fork copied a task call whose child belongs to the original session
  switch (state.status) {
    case "completed": {
      const attachments: Json[] = Array.isArray(state.attachments) ? state.attachments : [];
      if (state.time?.compacted) {
        // Pruned by OpenCode: the model saw only the marker, attachments included. Original stays in details.
        text(CLEARED_MARKER);
        result.prunedAt = state.time.compacted;
        oc.pruned = { compactedAt: state.time.compacted, originalOutput: state.output, attachments: attachments.map(a => attachmentMeta(a)) };
        ctx.stats.pruned++;
        if (link) details.results = [singleResult(ctx, p.id, link, state, 0, taskResultText(state.output))];
      } else if (link) {
        const output = taskResultText(state.output);
        text(taskEnvelope(link, output, Math.max(0, num(state.time?.end) - num(state.time?.start))));
        details.results = [singleResult(ctx, p.id, link, state, 0, output)];
      } else {
        if ((state.output ?? "") !== "" || attachments.length === 0) text(state.output === "" || state.output == null ? "(no output)" : String(state.output));
        oc.attachments = [];
        for (const a of attachments) {
          const { blocks, meta } = fileBlocks(a);
          result.content.push(...blocks);
          for (const b of blocks) if (b.type === "image") ctx.stats.images++;
          oc.attachments.push(meta);
        }
      }
      break;
    }
    case "error": {
      result.isError = true;
      // OpenCode replays interrupted tools with their partial metadata.output when present.
      const partial = state.metadata?.interrupted === true && typeof state.metadata.output === "string" ? state.metadata.output : undefined;
      text(partial ?? (typeof state.error === "string" && state.error !== "" ? state.error : "Tool error"));
      oc.error = state.error;
      if (partial !== undefined) oc.interruptedPartialOutput = true;
      if (link) details.results = [singleResult(ctx, p.id, link, state, 1, "")];
      break;
    }
    default: {
      // pending / running: nothing can resume; OpenCode itself replays these as an interrupted error.
      result.isError = true;
      text(INTERRUPTED_MARKER);
      oc.interrupted = true;
      oc.input = state.input;
      oc.raw = state.raw;
      ctx.stats.interrupted++;
      if (link) details.results = [singleResult(ctx, p.id, link, state, 1, "")];
    }
  }
  if (link) {
    details.projectAgentsDir = null;
    details.totalDurationMs = details.results?.[0]?.durationMs ?? 0;
    // omp's session statistics (SessionManager.getUsageStatistics, SessionStatsTracker) read a task result's
    // spend from the top-level `details.usage`, not from `details.results[]`.
    details.usage = shareOf(ctx, p.id, link).usage;
    ctx.stats.linkedSubagents++;
  }
  result.details = details;
  ctx.stats.toolCalls++;
  ctx.stats.toolResults++;
  return { call, result };
}

function convertAssistant(m: SourceMessage, ctx: Ctx): Item[] {
  const info = m.info;
  const provider = String(info.providerID ?? "unknown");
  const modelId = String(info.modelID ?? "unknown");
  const created = info.time?.created ?? m.created;

  // Split into steps: step-start opens a segment, step-finish closes it (and carries that step's usage).
  const segments: Segment[] = [];
  const aux: Json[] = [];
  let cur: Segment = { startTs: created, parts: [] };
  for (const p of m.parts) {
    const t = p.data.type;
    if (t === "step-start") {
      if (cur.parts.length > 0 || cur.finish) {
        segments.push(cur);
        cur = { startTs: p.created, parts: [] };
      } else cur.startTs = segments.length === 0 ? created : p.created;
      cur.start = p.data;
    } else if (t === "step-finish") {
      cur.finish = p.data;
      cur.finishId = p.id;
      segments.push(cur);
      cur = { startTs: p.created, parts: [] };
    } else if (t === "text" || t === "reasoning" || t === "tool" || t === "file") cur.parts.push(p);
    else aux.push({ partId: p.id, ...p.data }); // patch / snapshot / agent / retry / unknown: raw metadata only
  }
  if (cur.parts.length > 0) segments.push(cur);

  // OpenCode skips the whole message in provider context when it errored, unless it was an abort that still produced
  // something beyond reasoning. omp drops error/aborted assistant turns (and their paired results) the same way.
  const aborted = info.error?.name === "MessageAbortedError";
  const substantive = m.parts.some(p => p.data.type !== "step-start" && p.data.type !== "reasoning");
  const blocked = Boolean(info.error) && !(aborted && substantive);
  const errorText: string | undefined = info.error ? String(info.error.data?.message ?? info.error.name ?? "error") : undefined;
  const hasStepFinish = m.parts.some(p => p.data.type === "step-finish");

  const items: Item[] = [];
  const segMeta: Json[] = [];
  const ignoredText: Json[] = [];
  const modelKey = `${provider}/${modelId}`;
  let modelItemPending = false;
  if (ctx.trackModel && ctx.lastModel !== modelKey) {
    if (ctx.resolvable.has(modelKey)) modelItemPending = true;
    else ctx.unresolved.add(modelKey);
    ctx.lastModel = modelKey;
  }

  segments.forEach((seg, index) => {
    const content: Json[] = [];
    const results: Json[] = [];
    for (const p of seg.parts) {
      const d = p.data;
      if (d.type === "reasoning") {
        // Provider-native signatures/encrypted content are archived below, never replayed.
        if (typeof d.text === "string" && d.text.trim() !== "") content.push({ type: "thinking", thinking: d.text });
      } else if (d.type === "text") {
        if (d.ignored) ignoredText.push({ partId: p.id, text: d.text });
        else if (typeof d.text === "string" && d.text.trim() !== "") content.push({ type: "text", text: d.text });
      } else if (d.type === "tool") {
        const { call, result } = convertTool(p, seg.startTs, ctx);
        content.push(call);
        results.push(result);
      } else if (d.type === "file") {
        const { blocks, meta } = fileBlocks(d, p.id);
        content.push(...blocks);
        aux.push({ partId: p.id, file: meta });
      }
    }
    const lastSeg = index === segments.length - 1;
    const finishFromMessage = !hasStepFinish && lastSeg ? { tokens: info.tokens, cost: info.cost } : undefined;
    const usageSrc = seg.finish ?? finishFromMessage;
    const usage = usageSrc ? usageFrom(usageSrc.tokens, usageSrc.cost) : usageFrom(undefined, 0);
    if (!blocked && usageSrc) ctx.lastTotal = usage.totalTokens;
    segMeta.push({
      index,
      startedAt: seg.startTs,
      snapshotAtStart: seg.start?.snapshot,
      finish: seg.finish ? { id: seg.finishId, reason: seg.finish.reason, snapshot: seg.finish.snapshot, cost: seg.finish.cost, tokens: seg.finish.tokens } : undefined,
      usageFromMessageTotals: finishFromMessage ? true : undefined,
      emitted: content.length > 0,
      reasoningParts: seg.parts.filter(p => p.data.type === "reasoning").map(p => ({ partId: p.id, time: p.data.time, metadata: p.data.metadata })),
      textMetadata: seg.parts.filter(p => p.data.type === "text" && p.data.metadata).map(p => ({ partId: p.id, time: p.data.time, metadata: p.data.metadata })),
    });
    if (content.length === 0) return; // nothing a model could see (e.g. only empty reasoning)

    const hasCalls = results.length > 0;
    let stopReason: string;
    if (blocked) stopReason = aborted ? "aborted" : "error";
    else if (hasCalls) stopReason = "toolUse";
    else if (seg.finish?.reason === "length") stopReason = "length";
    else stopReason = "stop";

    const message: Json = {
      role: "assistant",
      content,
      api: "opencode-import", // honest provenance: the original transport is unknown
      provider,
      model: modelId,
      usage,
      stopReason,
      timestamp: seg.startTs,
    };
    if (blocked) message.errorMessage = errorText;
    if (modelItemPending) {
      items.push({ kind: "model", ts: seg.startTs, model: modelKey });
      modelItemPending = false;
    }
    items.push({ kind: "message", ts: seg.startTs, msgId: m.id, message });
    for (const r of results) items.push({ kind: "message", ts: r.timestamp, msgId: m.id, message: r });
    ctx.stats.messages++;
  });

  items.push({
    kind: "custom",
    ts: info.time?.completed ?? created,
    customType: "opencode_message",
    data: {
      role: "assistant",
      sourceMessageId: m.id,
      parentID: info.parentID,
      time: info.time,
      agent: info.agent,
      mode: info.mode,
      provider,
      model: modelId,
      variant: info.variant,
      path: info.path,
      cost: info.cost,
      tokens: info.tokens,
      finish: info.finish,
      error: info.error,
      structured: info.structured,
      summary: info.summary,
      droppedFromContextByOpenCode: blocked || undefined,
      extra: pick(info, ["role", "parentID", "time", "agent", "mode", "providerID", "modelID", "variant", "path", "cost", "tokens", "finish", "error", "structured", "summary"]),
      segments: segMeta,
      ignoredText: ignoredText.length ? ignoredText : undefined,
      auxParts: aux.length ? aux : undefined,
    },
  });
  return items;
}

// ---------------------------------------------------------------------------------------------- session conversion

interface Revert {
  messageID: string;
  partID?: string;
  snapshot?: string;
  diff?: string;
}

/** Split into the active branch and the reverted tail (whole-message or partial-message revert). */
function splitRevert(messages: SourceMessage[], revert: Revert | undefined): { active: SourceMessage[]; reverted: SourceMessage[]; note?: Json } {
  if (!revert?.messageID) return { active: messages, reverted: [] };
  const idx = messages.findIndex(m => m.id === revert.messageID);
  if (idx < 0) return { active: messages, reverted: [], note: { warning: "revert target message not found; nothing excluded", revert } };
  const target = messages[idx];
  if (revert.partID && target.parts.some(p => p.id === revert.partID)) {
    const kept = target.parts.filter(p => p.id < revert.partID!);
    return {
      active: [...messages.slice(0, idx), { ...target, parts: kept }],
      reverted: messages.slice(idx),
      note: { partial: true, keptParts: kept.length, droppedParts: target.parts.length - kept.length },
    };
  }
  return { active: messages.slice(0, idx), reverted: messages.slice(idx), note: { partial: false } };
}

function convertMessages(messages: SourceMessage[], ctx: Ctx, compactionNotes: Json[]): Item[] {
  const items: Item[] = [];
  const produced = new Set<string>(); // source messages that yielded at least one context-visible entry
  const consumed = new Set<string>(); // compaction prompt/summary messages replaced by a native compaction entry

  const summaryOf = new Map<string, SourceMessage>();
  messages.forEach((m, i) => {
    if (m.info.role !== "user" || !m.parts.some(p => p.data.type === "compaction")) return;
    const s = messages.find((x, j) => j > i && x.info.role === "assistant" && x.info.summary === true && x.info.parentID === m.id);
    if (s) summaryOf.set(m.id, s);
  });

  messages.forEach((m, i) => {
    if (consumed.has(m.id)) return;
    if (m.parts.length === 0) return;
    if (m.info.role === "user" && m.parts.some(p => p.data.type === "compaction")) {
      const part = m.parts.find(p => p.data.type === "compaction")!.data;
      const summaryMsg = summaryOf.get(m.id);
      const summary = summaryMsg
        ? summaryMsg.parts.filter(p => p.data.type === "text" && !p.data.ignored && typeof p.data.text === "string").map(p => p.data.text as string).join("\n\n").trim()
        : "";
      const ok = Boolean(summaryMsg && summaryMsg.info.finish && !summaryMsg.info.error && summary !== "");
      const base = {
        compactionMessageId: m.id,
        summaryMessageId: summaryMsg?.id,
        auto: part.auto,
        overflow: part.overflow,
        tailStartId: part.tail_start_id,
      };
      if (summaryMsg) consumed.add(summaryMsg.id);
      if (!ok) {
        // Failed/unfinished compaction: archive only; it must not establish a boundary.
        items.push({ kind: "custom", ts: m.created, customType: "opencode_compaction_attempt", data: { ...base, status: "failed", error: summaryMsg?.info.error, userInfo: m.info, summaryInfo: summaryMsg?.info } });
        compactionNotes.push({ ...base, status: "failed" });
        return;
      }
      let keptFrom: string | undefined;
      if (part.tail_start_id) {
        const tailIdx = messages.findIndex(x => x.id === part.tail_start_id);
        if (tailIdx >= 0 && tailIdx < i) keptFrom = messages.slice(tailIdx, i).find(x => produced.has(x.id))?.id;
      }
      const details = {
        source: "opencode",
        ...base,
        tailResolvedToMessageId: keptFrom,
        summaryModel: { provider: summaryMsg!.info.providerID, model: summaryMsg!.info.modelID },
        summaryCost: summaryMsg!.info.cost,
        summaryTokens: summaryMsg!.info.tokens,
        // omp did not measure this: last pre-compaction assistant step total, used only as display metadata.
        tokensBeforeBasis: "last pre-compaction assistant tokens.total (estimate)",
        userMessage: m.info,
        summaryMessage: summaryMsg!.info,
      };
      items.push({ kind: "compaction", ts: summaryMsg!.info.time?.completed ?? summaryMsg!.created, summary, keptFromMsgId: keptFrom, tokensBefore: ctx.lastTotal, details });
      compactionNotes.push({ ...base, status: "ok", keptFromMsgId: keptFrom });
      return;
    }
    const converted = m.info.role === "user" ? convertUser(m) : m.info.role === "assistant" ? convertAssistant(m, ctx) : [];
    if (converted.some(it => it.kind === "message")) produced.add(m.id);
    items.push(...converted);
  });
  return items;
}

/** Largest-remainder split of an integer `total` by `weights`: parts are whole numbers that add up to `total`. */
function splitInteger(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map(w => (total * w) / sum);
  const parts = exact.map(Math.floor);
  let rest = total - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((value, i) => ({ i, frac: value - Math.floor(value) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    parts[i]++;
    rest--;
  }
  return parts;
}

/**
 * Split each linked child's cumulative usage over the `task` calls that reference it (the first call and every
 * `task_id` resume), weighted by call duration (equal when no call has one), so the parent's statistics add the
 * child's spend once, not once per call. Calls are taken over the whole session including reverted ones.
 */
function apportionTaskUsage(messages: SourceMessage[], children: Map<string, ChildLink>): Map<string, UsageShare> {
  const callsByChild = new Map<string, { partId: string; weight: number }[]>();
  for (const m of messages) {
    for (const p of m.parts) {
      const d = p.data;
      const childId = d.type === "tool" && d.tool === "task" ? d.state?.metadata?.sessionId : undefined;
      if (typeof childId !== "string" || !children.has(childId)) continue;
      const list = callsByChild.get(childId) ?? [];
      list.push({ partId: p.id, weight: Math.max(0, num(d.state?.time?.end) - num(d.state?.time?.start)) });
      callsByChild.set(childId, list);
    }
  }
  const shares = new Map<string, UsageShare>();
  for (const [childId, calls] of callsByChild) {
    const total = children.get(childId)!.usage;
    const weights = calls.some(c => c.weight > 0) ? calls.map(c => c.weight) : calls.map(() => 1);
    const sum = weights.reduce((a, b) => a + b, 0);
    const input = splitInteger(total.input, weights);
    const output = splitInteger(total.output, weights);
    const cacheRead = splitInteger(total.cacheRead, weights);
    const cacheWrite = splitInteger(total.cacheWrite, weights);
    let costLeft = total.cost.total;
    calls.forEach((call, i) => {
      const last = i === calls.length - 1;
      const cost = last ? costLeft : (total.cost.total * weights[i]) / sum;
      costLeft -= cost;
      shares.set(call.partId, {
        calls: calls.length,
        tokens: input[i] + output[i] + cacheWrite[i],
        usage: {
          input: input[i],
          output: output[i],
          cacheRead: cacheRead[i],
          cacheWrite: cacheWrite[i],
          totalTokens: input[i] + output[i] + cacheRead[i] + cacheWrite[i],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
        },
      });
    });
  }
  return shares;
}

function shareOf(ctx: Ctx, partId: string, link: ChildLink): UsageShare {
  return ctx.taskUsage.get(partId) ?? { usage: link.usage, tokens: link.tokens, calls: 1 };
}

/** Convert one loaded OpenCode session into omp session entries (header and title are written by the importer). */
export function buildSession(source: SourceSession, opts: BuildOptions): BuiltSession {
  const s = source.session;
  const revert: Revert | undefined = s.revert ? (safeParse(s.revert) as Revert) : undefined;
  const sourceCwd: string = s.directory || "";

  const ctx: Ctx = {
    resolvable: opts.resolvable,
    children: opts.children,
    trackModel: true,
    unresolved: new Set(),
    lastTotal: 0,
    stats: { messages: 0, toolCalls: 0, toolResults: 0, interrupted: 0, pruned: 0, images: 0, linkedSubagents: 0 },
    taskUsage: apportionTaskUsage(source.messages, opts.children),
  };
  const { active, reverted, note: revertNote } = splitRevert(source.messages, revert);
  const compactionNotes: Json[] = [];
  const activeItems = convertMessages(active, ctx, compactionNotes);
  ctx.trackModel = false;
  const revertedItems = convertMessages(reverted, ctx, []);

  // See BuildOptions.defaultModel: pin the restore target when the active branch would otherwise restore an unresolvable model.
  const prefixItems: Item[] = [];
  const hasAssistant = activeItems.some(it => it.kind === "message" && it.message.role === "assistant");
  if (hasAssistant && opts.defaultModel && !activeItems.some(it => it.kind === "model")) {
    const ts = activeItems[0]?.ts ?? s.time_created;
    prefixItems.push(
      { kind: "model", ts, model: opts.defaultModel },
      { kind: "custom", ts, customType: "opencode_model_mapping", data: { restoreModel: opts.defaultModel, sourceModelsNotResolvable: [...ctx.unresolved], note: "no source model is available in omp; resuming uses restoreModel (pass --model to choose another)" } },
    );
  }

  const entries: Json[] = [];
  const firstEntryOfMessage = new Map<string, string>();
  let counter = 0;
  const ingest = (item: Item, parentId: string | null, offBranch: boolean): string => {
    const id = `oc-${(++counter).toString(36)}`;
    const timestamp = iso(item.ts);
    let entry: Json;
    if (item.kind === "message") {
      entry = { type: "message", id, parentId, timestamp, message: item.message };
      if (!offBranch && !firstEntryOfMessage.has(item.msgId)) firstEntryOfMessage.set(item.msgId, id);
    } else if (item.kind === "custom") {
      entry = { type: "custom", id, parentId, timestamp, customType: item.customType, data: item.data };
    } else if (item.kind === "model") {
      entry = { type: "model_change", id, parentId, timestamp, model: item.model };
    } else {
      const kept = item.keptFromMsgId ? firstEntryOfMessage.get(item.keptFromMsgId) : undefined;
      entry = {
        type: "compaction",
        id,
        parentId,
        timestamp,
        summary: item.summary,
        shortSummary: "Imported OpenCode compaction",
        firstKeptEntryId: kept ?? id, // no retained tail -> the compaction entry itself, as the Codex importer does
        tokensBefore: item.tokensBefore,
        details: item.details,
      };
    }
    entries.push(entry);
    return id;
  };

  let tip: string | null = null;
  for (const item of [...prefixItems, ...activeItems]) tip = ingest(item, tip, false);
  const activeTip = tip;
  if (reverted.length > 0) {
    // Reverted records stay as an off-branch sibling chain; a durable marker child of the active tip becomes the
    // leaf (changing the leaf in memory alone would not survive a reload).
    let offTip = activeTip;
    for (const item of revertedItems) offTip = ingest(item, offTip, true);
    tip = ingest(
      {
        kind: "custom",
        ts: s.time_updated,
        customType: "opencode_revert",
        data: { revert, ...revertNote, excludedMessageIds: reverted.map(m => m.id), note: "reverted messages are off the active branch; filesystem undo/snapshot restore is not migrated" },
      },
      activeTip,
      false,
    );
  }

  const counts = {
    sourceMessages: source.messages.length,
    sourceParts: source.messages.reduce((n, m) => n + m.parts.length, 0),
    activeMessages: active.length,
    revertedMessages: reverted.length,
    unparsedRows: source.unparsedRows,
    ...ctx.stats,
    compactions: compactionNotes,
  };
  ingest(
    {
      kind: "custom",
      ts: s.time_updated, // source recency, so the file's last entry sorts like the original; importedAt is in data
      customType: "opencode_import",
      data: {
        converter: CONVERTER,
        sourceId: s.id,
        parentId: s.parent_id,
        version: s.version,
        cwd: sourceCwd,
        title: s.title,
        model: safeParse(s.model),
        slug: s.slug,
        projectId: s.project_id,
        agent: s.agent,
        path: s.path,
        timeCreated: s.time_created,
        timeUpdated: s.time_updated,
        timeArchived: s.time_archived,
        cost: s.cost,
        tokens: { input: s.tokens_input, output: s.tokens_output, reasoning: s.tokens_reasoning, cacheRead: s.tokens_cache_read, cacheWrite: s.tokens_cache_write },
        summary: { additions: s.summary_additions, deletions: s.summary_deletions, files: s.summary_files },
        permission: safeParse(s.permission),
        metadata: safeParse(s.metadata),
        revert,
        childSessionIds: source.children.map(c => c.id),
        subagents: [...opts.children.values()].map(c => ({ sourceId: c.sourceId, agentId: c.id, title: c.title })),
        v2ControlRows: source.control,
        fallbackCwd: opts.fallbackCwd,
        modelsNotResolvableByOmp: [...ctx.unresolved],
        restoreModel: prefixItems.length > 0 ? opts.defaultModel : undefined,
        importedAt: new Date().toISOString(),
        counts,
      },
    },
    tip,
    false,
  );

  const needsModelFlag = hasAssistant && !opts.defaultModel && !activeItems.some(it => it.kind === "model");
  return { entries, title: typeof s.title === "string" && s.title ? s.title : undefined, counts, needsModelFlag };
}

/** The branch of messages omp will treat as active: everything before the revert point (a partial revert keeps the target's earlier parts). */
export function activeBranch(source: SourceSession): SourceMessage[] {
  const revert: Revert | undefined = source.session.revert ? (safeParse(source.session.revert) as Revert) : undefined;
  return splitRevert(source.messages, revert).active;
}

/** Last non-empty assistant text of `messages`: what OpenCode returns to the parent as the task result. Pass {@link activeBranch}, not the raw messages. */
export function finalAssistantText(messages: SourceMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.info.role !== "assistant") continue;
    const texts = m.parts.filter(p => p.data.type === "text" && !p.data.ignored && typeof p.data.text === "string" && p.data.text.trim() !== "");
    if (texts.length > 0) return (texts[texts.length - 1].data.text as string).trim();
  }
  return "";
}
