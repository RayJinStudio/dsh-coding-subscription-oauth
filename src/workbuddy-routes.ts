/**
 * Plugin-owned same-origin Web routes for the WorkBuddy provider: the
 * account/catalog snapshot, the explicit daily check-in, and model selection /
 * per-model context budgets.
 *
 * Every route is behind the same owner-request policy as the rest of the plugin
 * (loopback peer, loopback `Host`, same-origin), and every response is
 * secret-free: no access token, no refresh token, no at-rest key.
 *
 * The check-in is a REAL one-per-day grant on the user's account, so it is a
 * POST that only an explicit click reaches. There is no scheduler here and none
 * should be added: an automatic check-in would spend the user's reward without
 * their knowledge, and the route already skips the claim when the account is
 * checked in.
 *
 * @module dsh-coding-subscription-oauth/workbuddy-routes
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonRequest } from "./http-json.ts";
import { WORKBUDDY_CHECKIN_PATH, WORKBUDDY_MODELS_PATH, WORKBUDDY_STATUS_PATH } from "./ids.ts";
import { safeMessage } from "./redact.ts";
import { LOOPBACK_OWNER_REQUEST_POLICY, type OwnerRequestPolicy } from "./web-origin.ts";
import { registerWebRouteSetupAtomically } from "./web-routes.ts";
import type { WorkBuddyCredential, WorkBuddyCredentialStore } from "./workbuddy-auth.ts";
import { workbuddyRegionOf } from "./workbuddy-auth.ts";
import { WORKBUDDY_NATIVE_MODALITY, workbuddyModelTakesImages } from "./workbuddy-provider.ts";
import type { WorkBuddySession } from "./workbuddy-session.ts";
import {
	claimWorkBuddyCheckin,
	fetchWorkBuddyCheckinStatus,
	fetchWorkBuddyCredits,
	type WorkBuddyCheckinClaim,
	type WorkBuddyCheckinStatus,
	type WorkBuddyCredits,
	workbuddyCheckinSupported,
} from "./workbuddy-upstream.ts";

export { WORKBUDDY_CHECKIN_PATH, WORKBUDDY_MODELS_PATH, WORKBUDDY_STATUS_PATH } from "./ids.ts";

/** Structural `ctx.webServer` + `ctx.effect` surface used by the registrar. */
export interface WorkBuddyRouteContext {
	readonly webServer: {
		register(route: {
			kind: "exact" | "prefix";
			path: string;
			handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
		}): () => void;
	};
	effect(callback: () => () => void | Promise<void>, label?: string): unknown;
}

/** One model row as the card needs it: capabilities plus the native window. */
export interface WorkBuddyModelView {
	readonly id: string;
	readonly name: string;
	/** Effective window after the saved budget, which is what DSH uses. */
	readonly contextWindow: number;
	/** The model's own window, which the budget can only lower. */
	readonly nativeContextWindow: number;
	readonly maxTokens: number;
	readonly creditMultiplier?: number;
	readonly takesImages: boolean;
	readonly reasoning: boolean;
	/**
	 * Whether this model is currently served to DSH.
	 *
	 * Every model in the roster is REPORTED, including disabled ones: a card that
	 * listed only the enabled models would make switching one off irreversible,
	 * because the checkbox needed to switch it back on would disappear with it.
	 */
	readonly enabled: boolean;
}

/** One discovered auth file, as the settings card offers it. */
export interface WorkBuddyAuthFileView {
	/** Absolute path; the exact value a switch writes. */
	readonly path: string;
	/** Home-relative rendering for display. */
	readonly displayPath: string;
	readonly source: "desktop" | "dsh";
	/** Whether this file is currently in the probe path. */
	readonly active: boolean;
	readonly readable: boolean;
	readonly region?: "cn" | "global";
	readonly accountName?: string;
	readonly tokenExpiresAtMs?: number;
	readonly reason?: string;
	readonly message?: string;
}

/** Secret-free snapshot the card renders. */
export interface WorkBuddyView {
	readonly provider: {
		readonly state: "signed-in" | "signed-out";
		readonly region?: "cn" | "global";
		readonly expiresAtMs?: number;
		readonly nickname?: string;
		readonly domain?: string;
		readonly source?: "desktop" | "dsh";
	};
	readonly catalog: {
		readonly source: "live" | "cache" | "fallback";
		readonly error?: string;
		readonly models: readonly WorkBuddyModelView[];
		readonly enabledModelIds: readonly string[];
		readonly selectionExplicit: boolean;
		readonly contextBudgets: Readonly<Record<string, number>>;
	};
	/**
	 * Every auth file the store can read, plus the one in force.
	 *
	 * Reported even when no override is set, so the user can see the platform
	 * default and pick a different file without knowing its path in advance.
	 */
	readonly authFiles: readonly WorkBuddyAuthFileView[];
	/** The override currently in force, when one is set. */
	readonly authFileOverride?: string;
	readonly desktopFilePresent: boolean;
	readonly checkinSupported: boolean;
	readonly checkin?: WorkBuddyCheckinStatus;
	readonly checkinError?: string;
	readonly credits?: WorkBuddyCredits;
	readonly creditsError?: string;
}

/** What a check-in click answered. */
export interface WorkBuddyCheckinResult {
	/** True when the reward was already taken, so no claim was issued. */
	readonly alreadyCheckedIn: boolean;
	readonly claim?: WorkBuddyCheckinClaim;
	/** The status AFTER the action, so the card renders the settled state. */
	readonly checkin: WorkBuddyCheckinStatus;
}

/** The owner-facing surface the routes drive. */
export interface WorkBuddyRouteSurface {
	/** Build the snapshot; `checkin: false` skips the billing calls. */
	snapshot(options?: { checkin?: boolean }): Promise<WorkBuddyView>;
	/** Read today's check-in state, then claim it when it is still unclaimed. */
	checkin(): Promise<WorkBuddyCheckinResult>;
	/** Persist the model selection; `selected: undefined` restores "serve every model". */
	setModels(input: { selected?: string[] }): Promise<WorkBuddyView>;
	/** Persist one model's context budget; `undefined` clears it. */
	setBudget(input: { modelId: string; budget?: number }): Promise<WorkBuddyView>;
	/** Re-fetch the live roster. */
	refresh(): Promise<WorkBuddyView>;
	/** Point credential discovery at one auth file, or back at the defaults. */
	setAuthFile(path: string | undefined): Promise<WorkBuddyView>;
}

export interface WorkBuddyRouteOptions {
	readonly session: WorkBuddySession;
	readonly store: WorkBuddyCredentialStore;
	readonly ownerRequestPolicy?: OwnerRequestPolicy;
}

function json(res: ServerResponse, status: number, value: unknown): void {
	const body = Buffer.from(`${JSON.stringify(value)}\n`);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": body.byteLength,
		"cache-control": "no-store",
	});
	res.end(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build the route surface over a session and its credential store.
 *
 * Billing calls (`check-in` status, credits) are attempted only for a signed-in
 * account and their failures are reported per section rather than failing the
 * whole snapshot: a billing outage must not hide the model list, and vice versa.
 */
export function createWorkBuddyRouteSurface(options: WorkBuddyRouteOptions): WorkBuddyRouteSurface {
	const { session, store } = options;

	async function buildView(withCheckin: boolean): Promise<WorkBuddyView> {
		const status = await store.status();
		const region = status.domain === undefined ? undefined : workbuddyRegionOf(status.domain);
		const native = session.availableModels();
		const visible = new Map(session.visibleModels().map((model) => [model.id, model]));
		// EVERY roster model is reported; `enabled` distinguishes the served ones.
		// Filtering to the visible set instead would delete a model's checkbox the
		// moment it was switched off, leaving no way to switch it back on.
		const models: WorkBuddyModelView[] = native.map((model) => {
			const effective = visible.get(model.id);
			return {
				id: model.id,
				name: model.name,
				contextWindow: effective?.contextWindow ?? model.contextWindow,
				nativeContextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				...(model.creditMultiplier === undefined ? {} : { creditMultiplier: model.creditMultiplier }),
				takesImages: workbuddyModelTakesImages(model),
				reasoning: model.reasoning !== undefined,
				enabled: visible.has(model.id),
			};
		});
		const checkinSupported = region !== undefined && workbuddyCheckinSupported(region);
		const authFiles = (await store.candidateFiles()).map(
			(entry): WorkBuddyAuthFileView => ({
				path: entry.path,
				displayPath: entry.displayPath,
				source: entry.source,
				active: entry.active,
				readable: entry.readable,
				...(entry.region === undefined ? {} : { region: entry.region }),
				...(entry.accountName === undefined || entry.accountName === "" ? {} : { accountName: entry.accountName }),
				...(entry.tokenExpiresAtMs === undefined ? {} : { tokenExpiresAtMs: entry.tokenExpiresAtMs }),
				...(entry.reason === undefined ? {} : { reason: entry.reason }),
				...(entry.message === undefined ? {} : { message: entry.message }),
			}),
		);
		const override = store.desktopPathOverride();
		const view: {
			provider: WorkBuddyView["provider"];
			catalog: WorkBuddyView["catalog"];
			authFiles: readonly WorkBuddyAuthFileView[];
			authFileOverride?: string;
			desktopFilePresent: boolean;
			checkinSupported: boolean;
			checkin?: WorkBuddyCheckinStatus;
			checkinError?: string;
			credits?: WorkBuddyCredits;
			creditsError?: string;
		} = {
			provider: {
				state: status.state,
				...(status.region === undefined ? {} : { region: status.region }),
				...(status.expiresAtMs === undefined ? {} : { expiresAtMs: status.expiresAtMs }),
				...(status.nickname === undefined ? {} : { nickname: status.nickname }),
				...(status.domain === undefined ? {} : { domain: status.domain }),
				...(status.source === undefined ? {} : { source: status.source }),
			},
			catalog: {
				source: session.catalogSource,
				...(session.catalogError === undefined ? {} : { error: session.catalogError }),
				models,
				enabledModelIds: session.enabledModelIds(),
				selectionExplicit: session.selectedModelIds() !== undefined,
				contextBudgets: session.contextBudgets(),
			},
			authFiles,
			...(override === undefined ? {} : { authFileOverride: override }),
			desktopFilePresent: await store.desktopFilePresent(),
			checkinSupported,
		};
		if (withCheckin && status.state === "signed-in") {
			let credential: WorkBuddyCredential | undefined;
			try {
				credential = await store.resolve();
			} catch (error: unknown) {
				view.checkinError = safeMessage(error);
			}
			if (credential !== undefined) {
				if (checkinSupported) {
					try {
						view.checkin = await fetchWorkBuddyCheckinStatus(credential);
					} catch (error: unknown) {
						view.checkinError = safeMessage(error);
					}
				}
				try {
					view.credits = await fetchWorkBuddyCredits(credential);
				} catch (error: unknown) {
					view.creditsError = safeMessage(error);
				}
			}
		}
		return view;
	}

	return {
		snapshot: (snapshotOptions) => buildView(snapshotOptions?.checkin !== false),
		async checkin(): Promise<WorkBuddyCheckinResult> {
			const credential = await store.resolve();
			const region = workbuddyRegionOf(credential.domain);
			if (!workbuddyCheckinSupported(region)) {
				throw new Error("WorkBuddy check-in is not available for this account's region");
			}
			// Read first: the claim is a real grant, and a second claim on the same
			// day is refused upstream. Checking here keeps the common case from
			// spending a doomed round trip and reports it as a normal outcome.
			const before = await fetchWorkBuddyCheckinStatus(credential);
			if (before.todayCheckedIn) return { alreadyCheckedIn: true, checkin: before };
			const claim = await claimWorkBuddyCheckin(credential);
			const after = await fetchWorkBuddyCheckinStatus(credential);
			return { alreadyCheckedIn: false, claim, checkin: after };
		},
		async setModels(input) {
			await session.setSelectedModels(input.selected);
			return buildView(false);
		},
		async setBudget(input) {
			if (input.modelId.trim() === "") throw new Error("modelId must be a non-empty string");
			await session.setContextBudget(input.modelId, input.budget);
			return buildView(false);
		},
		async refresh() {
			await session.refreshCatalog();
			return buildView(false);
		},
		async setAuthFile(path) {
			if (path !== undefined) {
				const trimmed = path.trim();
				if (trimmed === "") throw new Error("auth file path must be a non-empty string");
				// Only a file this store actually discovered may be selected. That
				// keeps the switch a choice among KNOWN candidates rather than an
				// arbitrary read: an unrestricted path would let a request point
				// credential discovery at any file on the machine.
				const candidates = await store.candidateFiles();
				if (!candidates.some((entry) => entry.path === trimmed)) {
					throw new Error("that path is not one of the discovered WorkBuddy auth files");
				}
			}
			// Through the session, not the store: the session is what persists the
			// pin, so a choice made here survives a restart.
			await session.setAuthFile(path);
			// A different credential means a different roster and a different region,
			// so the cached catalog is no longer valid for the new account.
			await session.refreshCatalog();
			return buildView(false);
		},
	};
}

/** Register the three WorkBuddy routes. Owns and returns the route disposer. */
export function registerWorkBuddyRoutes(ctx: WorkBuddyRouteContext, options: WorkBuddyRouteOptions): () => void {
	const policy = options.ownerRequestPolicy ?? LOOPBACK_OWNER_REQUEST_POLICY;
	const surface = createWorkBuddyRouteSurface(options);
	let dispose = (): void => undefined;
	ctx.effect(() => {
		dispose = registerWebRouteSetupAtomically(ctx.webServer, (webServer) => {
			webServer.register({
				kind: "exact",
				path: WORKBUDDY_STATUS_PATH,
				handler: async (req, res) => {
					if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
					if (!policy.authorize(req).authorized) return json(res, 403, { error: "forbidden" });
					try {
						const url = new URL(req.url ?? WORKBUDDY_STATUS_PATH, "http://owner.invalid");
						json(res, 200, await surface.snapshot({ checkin: url.searchParams.get("checkin") !== "0" }));
					} catch (error: unknown) {
						json(res, 500, { error: safeMessage(error) });
					}
				},
			});
			webServer.register({
				kind: "exact",
				path: WORKBUDDY_CHECKIN_PATH,
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
					if (!policy.authorize(req).authorized) return json(res, 403, { error: "forbidden" });
					try {
						json(res, 200, await surface.checkin());
					} catch (error: unknown) {
						json(res, 409, { error: safeMessage(error) });
					}
				},
			});
			webServer.register({
				kind: "exact",
				path: WORKBUDDY_MODELS_PATH,
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
					if (!policy.authorize(req).authorized) return json(res, 403, { error: "forbidden" });
					try {
						const body = await readJsonRequest(req);
						if (!isRecord(body)) return json(res, 400, { error: "body must be an object" });
						const action = body["action"];
						if (action === "refresh") return json(res, 200, await surface.refresh());
						if (action === "budget") {
							const modelId = body["modelId"];
							if (typeof modelId !== "string") return json(res, 400, { error: "modelId must be a string" });
							const raw = body["budget"];
							if (raw !== undefined && (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)) {
								return json(res, 400, { error: "budget must be a positive number or absent" });
							}
							return json(
								res,
								200,
								await surface.setBudget({
									modelId,
									...(typeof raw === "number" ? { budget: raw } : {}),
								}),
							);
						}
						if (action === "select") {
							const selected = body["selected"];
							if (selected !== undefined && !Array.isArray(selected)) {
								return json(res, 400, { error: "selected must be an array of model ids" });
							}
							if (Array.isArray(selected) && selected.some((id) => typeof id !== "string")) {
								return json(res, 400, { error: "selected must be an array of model ids" });
							}
							// An explicit `null` restores "serve every model", which is a
							// different intent from an empty array ("serve nothing").
							if (selected === null) return json(res, 200, await surface.setModels({}));
							return json(
								res,
								200,
								await surface.setModels(Array.isArray(selected) ? { selected: selected as string[] } : {}),
							);
						}
						if (action === "authFile") {
							const path = body["path"];
							if (path !== undefined && path !== null && typeof path !== "string") {
								return json(res, 400, { error: "path must be a string or null" });
							}
							// `null` returns discovery to the platform defaults.
							return json(res, 200, await surface.setAuthFile(typeof path === "string" ? path : undefined));
						}
						return json(res, 400, { error: "action must be select, budget, refresh or authFile" });
					} catch (error: unknown) {
						json(res, 500, { error: safeMessage(error) });
					}
				},
			});
		});
		return dispose;
	}, "dsh-coding-subscription-oauth: WorkBuddy routes");
	return () => dispose();
}

/** The fixed modality table, exposed so tests can pin the policy. */
export { WORKBUDDY_NATIVE_MODALITY };
