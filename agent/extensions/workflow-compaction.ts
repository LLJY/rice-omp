/**
 * Preserve workflow-skill state through compaction (port of LLJY/opencode 6f2df07).
 *
 * After compaction the agent loses the loaded workflow-plan/workflow-execute skill and
 * the workplan it was driving. This asks every written summary for a conditional
 * `## Workflow Status` section that names the workplan, the current step and the skill
 * to re-read before continuing.
 *
 * - `soft` (and its iterative update): `session.compacting` adds the instruction as
 *   additional summarizer context; a returned `prompt` would replace omp's template, so
 *   only `context` is used.
 * - `handoff` (auto and `/handoff`): no compaction hook runs, but the request goes
 *   through the `context` transform, so the instruction is appended to the trailing
 *   handoff prompt message. Other requests pass through untouched.
 * - `remote` summaries are produced server-side and cannot be steered.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const WORKFLOW_STATUS = `Add this section after the last section of your output:

## Workflow Status
[Include this section only if a workplan is actively being planned or executed right now (workflow-plan or workflow-execute skill in use). Otherwise omit this section entirely.]
- Mode: [workflow-plan | workflow-execute]
- Workplan: [workplan id and exact path, e.g. .omp/workplan/<id>.json]
- Current step: [exact phase id / step id and its status]
- Plan-checker ran: [yes | no]
- Continuation requirement: [workflow-plan: "Read skill://workflow-plan before continuing." | workflow-execute: "Read skill://workflow-execute before continuing."]

Do not infer an active workflow from an old, completed, cancelled, proposed, or merely discussed workplan.`;

/** First line of omp's handoff-document prompt (pi-agent-core compaction/prompts/handoff-document.md). */
const HANDOFF_PROMPT_MARKER = "Write a handoff document for another instance of yourself.";

type TextBlock = { type: "text"; text: string };

function isHandoffPrompt(message: unknown): message is { role: "user"; content: TextBlock[] } {
	if (!message || typeof message !== "object") return false;
	const { role, content } = message as { role?: unknown; content?: unknown };
	if (role !== "user" || !Array.isArray(content)) return false;
	const first = content[0] as Partial<TextBlock> | undefined;
	return first?.type === "text" && typeof first.text === "string" && first.text.includes(HANDOFF_PROMPT_MARKER);
}

export default function (pi: ExtensionAPI) {
	pi.on("session.compacting", () => ({ context: [WORKFLOW_STATUS] }));

	pi.on("context", event => {
		const last = event.messages.at(-1);
		if (!isHandoffPrompt(last)) return;
		const messages = event.messages.slice(0, -1);
		messages.push({ ...last, content: [...last.content, { type: "text", text: `\n<instruction>\n${WORKFLOW_STATUS}\n</instruction>` }] });
		return { messages };
	});
}
