/**
 * CLIProxyAPI providers with live model discovery.
 *
 * Lists models from the proxy's `/v1/models` and registers them as:
 * - `cpa`: chat models on Codex Responses over WebSocket (`/backend-api/codex/responses`).
 *   OpenAI-owned models also get remote compaction V2 (`compaction_trigger` on that endpoint):
 *   CPA forwards it to Codex OAuth and returns the `compaction` item. CPA's Claude route
 *   answers the trigger with a plain message, which omp rejects, so Claude keeps local methods.
 * - `cpa-images`: `gpt-image-*` on the OpenAI images API (`/v1/images/generations`).
 * models.yml cannot express this: a provider has one baseUrl (it also overrides
 * per-model URLs), and discovery derives `/models` from it, but the proxy serves
 * the model list only under `/v1` and Codex only under `/backend-api`.
 */
import { getBundledModelReferenceIndex, resolveModelReference } from "@oh-my-pi/pi-catalog/identity";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";

type ModelRow = NonNullable<ProviderConfigInput["models"]>[number];

const PROXY_URL = process.env.CPA_BASE_URL ?? "http://127.0.0.1:8317";
const API_KEY_ENV = "CPA_KEY";

// Both providers refresh together; coalesce their concurrent /v1/models requests.
// Only the in-flight request is shared: omp's model manager owns caching and refresh.
let catalog: Promise<CatalogEntry[]> | undefined;

interface CatalogEntry {
	row: ModelRow;
	ownedBy: unknown;
}

async function fetchCatalog(apiKey: string | undefined): Promise<CatalogEntry[]> {
	const res = await fetch(`${PROXY_URL}/v1/models`, {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
	});
	if (!res.ok) throw new Error(`CLIProxyAPI /v1/models: HTTP ${res.status}`);
	const body: unknown = await res.json();
	const rows = body && typeof body === "object" && "data" in body && Array.isArray(body.data) ? body.data : [];
	const references = getBundledModelReferenceIndex();
	const entries: CatalogEntry[] = [];
	for (const row of rows) {
		const id = row && typeof row === "object" && "id" in row ? row.id : undefined;
		if (typeof id !== "string" || id.length === 0) continue;
		const reference = resolveModelReference(id, references);
		entries.push({
			ownedBy: "owned_by" in row ? row.owned_by : undefined,
			row: {
				id,
				name: reference?.name ?? id,
				reasoning: reference?.reasoning ?? false,
				input: reference?.input ?? ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: reference?.contextWindow ?? 128_000,
				maxTokens: reference?.maxTokens ?? 16_384,
			},
		});
	}
	return entries;
}

async function sharedCatalog(apiKey: string | undefined): Promise<CatalogEntry[]> {
	catalog ??= fetchCatalog(apiKey).finally(() => {
		catalog = undefined;
	});
	return catalog;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("cpa", {
		baseUrl: `${PROXY_URL}/backend-api`,
		api: "openai-codex-responses",
		apiKey: API_KEY_ENV,
		async fetchDynamicModels(apiKey) {
			return (await sharedCatalog(apiKey))
				.filter(({ row }) => !row.id.startsWith("gpt-image"))
				.map(({ row, ownedBy }) => ({
					...row,
					preferWebsockets: true,
					...(ownedBy === "openai" ? { remoteCompaction: { v2StreamingEnabled: true } } : {}),
				}));
		},
	});
	pi.registerProvider("cpa-images", {
		baseUrl: `${PROXY_URL}/v1`,
		api: "openai-images",
		apiKey: API_KEY_ENV,
		async fetchDynamicModels(apiKey) {
			return (await sharedCatalog(apiKey)).filter(({ row }) => row.id.startsWith("gpt-image")).map(({ row }) => row);
		},
	});
}
