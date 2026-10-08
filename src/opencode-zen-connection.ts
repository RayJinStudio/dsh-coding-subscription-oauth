/**
 * OpenCode Zen connection controller: the settings card's backend.
 *
 * Shaped like `opencode-go-connection.ts` (status / credential / apply /
 * models) with one decisive difference: Zen spans several wire protocols, so
 * the card selects MODELS and each model's protocol is read from the installed
 * pi-ai catalogue. There is deliberately no `api` field — the protocol belongs
 * to the model, and the route's provider dispatches on it. A DSH-settings
 * route could not do this, because `PiAiProviderProfile.api` is one protocol
 * for the whole route and a per-model `api` is ignored.
 *
 * The enabled selection is stored in this plugin's OWN file under DSH_HOME
 * rather than in the `llm-pi-ai` settings layer. That is deliberate: writing a
 * route into `llm-pi-ai` would either collide with the operator's hand-written
 * `opencodezen` profile or silently do nothing (a mixed-protocol route cannot
 * resolve). The route this plugin serves is built in code by
 * {@link opencodeZenProvider}, so only the selection — not the route — needs
 * persisting.
 *
 * @module dsh-coding-subscription-oauth/opencode-zen-connection
 */

import { mkdir, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { type CredentialProvider, credentialRef } from "@deepseek-ai/dsh-credentials";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type { Api, Model } from "@earendil-works/pi-ai";
import { readJsonRequest } from "./http-json.ts";
import { classifyZenUpstreamError } from "./opencode-zen-gate.ts";
import {
	OPENCODE_ZEN_BASE_URL,
	OPENCODE_ZEN_DISPLAY_NAME,
	OPENCODE_ZEN_KNOWN_REFS,
	OPENCODE_ZEN_PROVIDER_ID,
} from "./opencode-zen-ids.ts";
import { zenModels } from "./opencode-zen-provider.ts";
import { safeMessage } from "./redact.ts";
import type { OwnerRequestPolicy } from "./web-origin.ts";
import { type PluginWebRouteRegistry, registerWebRouteSetupAtomically } from "./web-routes.ts";

export const OPENCODE_ZEN_CONNECTION_PATH = "/plugins/dsh-grok-build/opencode-zen" as const;

/** Plugin-owned selection document, alongside the other plugin caches. */
export const OPENCODE_ZEN_SELECTION_FILENAME = ".opencode-zen-models.json" as const;
const SELECTION_VERSION = 1;

type RecordValue = Record<string, unknown>;

export interface OpenCodeZenSelectionDocument {
	readonly version: number;
	/** `default` serves the whole catalogue; `selected` serves `ids` only. */
	readonly selectionMode: "default" | "selected";
	readonly ids: readonly string[];
	/** The credential reference the operator picked, when more than one is configured. */
	readonly credentialRef?: string;
	readonly fetchedAt: number;
}

/** One selectable Zen model, as the card sees it. */
export interface OpenCodeZenModel {
	readonly id: string;
	readonly name?: string;
	readonly protocol: string;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly input?: readonly ("text" | "image")[];
	readonly reasoningEfforts?: false | Record<string, string | null>;
	readonly free: boolean;
}

class ZenConnectionError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

const record = (value: unknown): RecordValue | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : undefined;
const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** Resolve the plugin-owned selection path beneath DSH_HOME. */
export function opencodeZenSelectionPath(dshHome?: string): string {
	return resolve(join(resolveDshHome(dshHome), OPENCODE_ZEN_SELECTION_FILENAME));
}

function parseSelection(raw: unknown): {
	selection: string[] | undefined;
	credentialRef: string | undefined;
	fetchedAt: number;
} {
	const document = record(raw);
	if (document === undefined || document["version"] !== SELECTION_VERSION)
		return { selection: undefined, credentialRef: undefined, fetchedAt: 0 };
	const ids = Array.isArray(document["ids"])
		? [...new Set(document["ids"].filter((id): id is string => typeof id === "string" && id.length > 0))]
		: [];
	const fetchedAt = typeof document["fetchedAt"] === "number" ? document["fetchedAt"] : 0;
	return {
		selection: document["selectionMode"] === "selected" ? ids : undefined,
		credentialRef: text(document["credentialRef"]),
		fetchedAt,
	};
}

/** Read the persisted selection; an absent or unreadable file means "everything". */
export async function readZenSelection(
	dshHome?: string,
): Promise<{ selection: string[] | undefined; credentialRef: string | undefined; fetchedAt: number }> {
	try {
		return parseSelection(JSON.parse(await readFile(opencodeZenSelectionPath(dshHome), "utf8")));
	} catch {
		return { selection: undefined, credentialRef: undefined, fetchedAt: 0 };
	}
}

/** Persist the selection atomically, owner-readable only. */
export async function writeZenSelection(
	state: { selection: string[] | undefined; credentialRef?: string | undefined },
	dshHome?: string,
): Promise<void> {
	const file = opencodeZenSelectionPath(dshHome);
	const document: OpenCodeZenSelectionDocument = {
		version: SELECTION_VERSION,
		selectionMode: state.selection === undefined ? "default" : "selected",
		ids: state.selection ?? [],
		...(state.credentialRef === undefined ? {} : { credentialRef: state.credentialRef }),
		fetchedAt: Date.now(),
	};
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	await writeFileAtomic(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The Zen catalogue as the card sees it.
 *
 * Sourced from pi-ai's installed `opencode` catalogue so a Zen model addition
 * or a protocol change arrives with a pi-ai upgrade rather than a plugin
 * release. A model absent from that catalogue cannot be served by this route,
 * because nothing local would know which protocol to speak.
 */
export function opencodeZenCatalog(): OpenCodeZenModel[] {
	return zenModels().map((model) => toCatalogRow(model));
}

function toCatalogRow(model: Model<Api>): OpenCodeZenModel {
	const efforts = (model as { thinkingLevelMap?: Record<string, string | null> }).thinkingLevelMap;
	return {
		id: model.id,
		...(model.name === undefined ? {} : { name: model.name }),
		protocol: model.api,
		...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
		...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
		...(model.input === undefined ? {} : { input: model.input }),
		...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
		free: /-free$/u.test(model.id) || model.id === "exo-free",
	};
}

/**
 * The models the route currently serves, in catalogue order.
 *
 * Reads the persisted selection through the optional `dshHome` override so the
 * adapter and the card agree on one source of truth, and so tests can point at
 * an isolated home.
 */
export async function opencodeZenEnabledModels(dshHome?: string): Promise<Model<Api>[]> {
	const { selection } = await readZenSelection(dshHome);
	return zenModels(selection === undefined ? undefined : (id) => selection.includes(id));
}

async function candidates(credentials: CredentialProvider, configured?: string) {
	const refs = [...new Set([...(configured === undefined ? [] : [configured]), ...OPENCODE_ZEN_KNOWN_REFS])];
	return Promise.all(
		refs.map(async (name) => {
			const ref = credentialRef(name);
			const [info, resolved] = await Promise.all([credentials.describe(ref), credentials.resolve(ref)]);
			return { ref: name, info, value: resolved?.value };
		}),
	);
}

interface Options {
	credentials: CredentialProvider;
	dshHome?: string;
	onConfigurationChange?: () => void;
	fetchImpl?: typeof fetch;
}

async function statusDocument(options: Options, preferredRef?: string) {
	const { credentialRef: storedRef } = await readZenSelection(options.dshHome);
	const found = await candidates(options.credentials, storedRef);
	const configured = found.filter((entry) => entry.info.configured);
	const configuredValues = new Set(
		configured.map((entry) => entry.value).filter((value): value is string => value !== undefined),
	);
	const selected =
		found.find((entry) => entry.ref === text(preferredRef)) ??
		found.find((entry) => entry.ref === storedRef) ??
		configured[0] ??
		found[0];
	if (selected === undefined)
		throw new ZenConnectionError("credential-unavailable", "Credential service is unavailable", 503);
	const catalog = opencodeZenCatalog();
	const { selection, fetchedAt } = await readZenSelection(options.dshHome);
	const known = new Set(catalog.map((model) => model.id));
	const unknown = selection?.filter((id) => !known.has(id)) ?? [];
	const enabledModels = selection === undefined ? catalog : catalog.filter((model) => selection.includes(model.id));
	return {
		providerId: OPENCODE_ZEN_PROVIDER_ID,
		displayName: OPENCODE_ZEN_DISPLAY_NAME,
		baseURL: OPENCODE_ZEN_BASE_URL,
		credential: {
			selectedRef: selected.ref,
			configured: selected.info.configured,
			writable: selected.info.writable,
			source: selected.info.source ?? null,
			requiresChoice: storedRef === undefined && configured.length > 1 && configuredValues.size > 1,
			candidates: found.map((entry) => ({
				ref: entry.ref,
				configured: entry.info.configured,
				writable: entry.info.writable,
				source: entry.info.source ?? null,
			})),
		},
		configuration: {
			writable: true,
			selectionMode: selection === undefined ? ("default" as const) : ("selected" as const),
			fetchedAt,
			models: enabledModels,
			// Several protocols is the normal case here, and is exactly what a
			// settings-declared route could not express.
			protocols: [...new Set(enabledModels.map((model) => model.protocol))],
			ready: selected.info.configured && enabledModels.length > 0 && unknown.length === 0,
			unknownModels: unknown,
			catalogSize: catalog.length,
		},
		catalog,
	};
}

/**
 * Fetch Zen's public model directory and match it against the local catalogue.
 *
 * The directory needs no credential, which is why the card can list models
 * before a key is entered. It reports ids only, so the protocol column is
 * filled from pi-ai's catalogue — the only local source that knows protocols.
 */
async function loadDirectory(options: Options): Promise<OpenCodeZenModel[]> {
	const response = await (options.fetchImpl ?? fetch)(`${OPENCODE_ZEN_BASE_URL}/models`, {
		headers: { accept: "application/json" },
		redirect: "error",
	});
	if (!response.ok) {
		const bodyText = await response.text().catch(() => "");
		const failure = classifyZenUpstreamError(response.status, bodyText);
		throw new ZenConnectionError(failure.code, failure.message, response.status);
	}
	const parsed = (await response.json()) as unknown;
	const rows = Array.isArray(parsed)
		? parsed
		: Array.isArray(record(parsed)?.["data"])
			? (record(parsed)?.["data"] as unknown[])
			: [];
	const known = new Map(opencodeZenCatalog().map((model) => [model.id, model]));
	return rows
		.map((entry) => text(record(entry)?.["id"]))
		.filter((id): id is string => id !== undefined)
		.map((id) => known.get(id) ?? { id, protocol: "unknown", free: /-free$/u.test(id) });
}

export function createOpenCodeZenConnectionController(options: Options) {
	return {
		status: (preferredRef?: string) => statusDocument(options, preferredRef),
		async models() {
			return loadDirectory(options);
		},
		async saveCredential(input: { credentialRef: string; apiKey?: string }) {
			const ref = credentialRef(input.credentialRef);
			const key = text(input.apiKey);
			if (key === undefined) {
				if (!(await options.credentials.describe(ref)).configured)
					throw new ZenConnectionError(
						"credential-missing",
						"The selected OpenCode Zen credential is not configured",
						409,
					);
			} else {
				if (!(await options.credentials.describe(ref)).writable)
					throw new ZenConnectionError("credential-readonly", "The selected credential source is read-only", 403);
				await options.credentials.set(ref, key);
				options.onConfigurationChange?.();
			}
			// Remember the choice so a restart does not fall back to another
			// configured reference and silently switch the account.
			const { selection } = await readZenSelection(options.dshHome);
			await writeZenSelection({ selection, credentialRef: input.credentialRef }, options.dshHome);
			return statusDocument(options, input.credentialRef);
		},
		/**
		 * Delete the stored OpenCode Zen key.
		 *
		 * Removes the value from the credential store rather than writing a blank,
		 * for the same reason as the Go route: an empty value resolves as absent,
		 * but a leftover record keeps describing the reference as configured. The
		 * remembered reference is dropped too, so the card returns to a clean
		 * "enter a key" state instead of pointing at an empty slot.
		 */
		async clearCredential(input: { credentialRef: string }) {
			const ref = credentialRef(input.credentialRef);
			if (!(await options.credentials.describe(ref)).writable)
				throw new ZenConnectionError("credential-readonly", "The selected credential source is read-only", 403);
			await options.credentials.unset(ref);
			const { selection } = await readZenSelection(options.dshHome);
			await writeZenSelection({ selection }, options.dshHome);
			options.onConfigurationChange?.();
			return statusDocument(options, input.credentialRef);
		},
		/**
		 * Persist the enabled model selection.
		 *
		 * `models: undefined` restores "serve the whole catalogue". Ids the local
		 * catalogue does not describe are refused rather than stored, because the
		 * route could not dispatch them — their protocol is unknown.
		 */
		async applyConfiguration(input: { models?: readonly string[] }) {
			if (input.models !== undefined) {
				const ids = [...new Set(input.models)];
				if (ids.length === 0)
					throw new ZenConnectionError("invalid-configuration", "Enable at least one OpenCode Zen model", 400);
				const known = new Set(opencodeZenCatalog().map((model) => model.id));
				const unknown = ids.filter((id) => !known.has(id));
				if (unknown.length > 0)
					throw new ZenConnectionError(
						"unknown-model",
						`The installed pi-ai catalogue does not describe ${unknown.join(", ")}, so its protocol is unknown`,
						400,
					);
				const { credentialRef: stored } = await readZenSelection(options.dshHome);
				await writeZenSelection({ selection: ids, credentialRef: stored }, options.dshHome);
			} else {
				const { credentialRef: stored } = await readZenSelection(options.dshHome);
				await writeZenSelection({ selection: undefined, credentialRef: stored }, options.dshHome);
			}
			options.onConfigurationChange?.();
			return statusDocument(options);
		},
	};
}

function json(res: ServerResponse, status: number, value: unknown) {
	const body = Buffer.from(`${JSON.stringify(value)}\n`);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": body.byteLength,
		"cache-control": "no-store",
	});
	res.end(body);
}

export function registerOpenCodeZenConnectionRoute(
	ctx: { webServer: PluginWebRouteRegistry; effect(callback: () => () => void, label?: string): unknown },
	controller: ReturnType<typeof createOpenCodeZenConnectionController>,
	policy: OwnerRequestPolicy,
) {
	let dispose: () => void = () => undefined;
	ctx.effect(() => {
		dispose = registerWebRouteSetupAtomically(ctx.webServer, (webServer) => {
			return webServer.register({
				kind: "exact",
				path: OPENCODE_ZEN_CONNECTION_PATH,
				handler: async (req: IncomingMessage, res: ServerResponse) => {
					if (!policy.authorize(req).authorized) return json(res, 403, { error: "forbidden", code: "forbidden" });
					try {
						const url = new URL(req.url ?? OPENCODE_ZEN_CONNECTION_PATH, "http://owner.invalid");
						const body = req.method === "POST" ? (record(await readJsonRequest(req)) ?? {}) : {};
						if (req.method === "GET") {
							const preferredRef = url.searchParams.get("credentialRef") ?? undefined;
							const state = await controller.status(preferredRef);
							return json(
								res,
								200,
								url.searchParams.get("directory") === "1"
									? { status: state, directory: await controller.models() }
									: state,
							);
						}
						if (req.method !== "POST")
							return json(res, 405, { error: "method not allowed", code: "method-not-allowed" });
						if (body["action"] === "credential")
							return json(
								res,
								200,
								await controller.saveCredential({
									credentialRef: String(body["credentialRef"] ?? ""),
									...(text(body["apiKey"]) === undefined ? {} : { apiKey: String(body["apiKey"]) }),
								}),
							);
						if (body["action"] === "clear")
							return json(
								res,
								200,
								await controller.clearCredential({
									credentialRef: String(body["credentialRef"] ?? ""),
								}),
							);
						if (body["action"] === "apply") {
							const raw = body["models"];
							const models = Array.isArray(raw)
								? raw
										.map((entry) => (typeof entry === "string" ? entry : text(record(entry)?.["id"])))
										.filter((id): id is string => id !== undefined)
								: undefined;
							return json(res, 200, await controller.applyConfiguration(models === undefined ? {} : { models }));
						}
						throw new ZenConnectionError(
							"invalid-action",
							"OpenCode Zen action must be credential, clear, or apply",
							400,
						);
					} catch (error) {
						if (error instanceof ZenConnectionError)
							return json(res, error.status, { error: error.message, code: error.code });
						return json(res, 500, { error: safeMessage(error), code: "opencode-zen-failed" });
					}
				},
			});
		});
		return dispose;
	}, "dsh-coding-subscription-oauth: OpenCode Zen connection route");
	return () => dispose();
}
