/** Coding-subscription adapter assembled from public dsh-llm-pi-ai extension points. */

import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import type { RetryPolicyConfig } from "@deepseek-ai/dsh-llm";
import { type LlmAdapter, LlmError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from "@deepseek-ai/dsh-llm-pi-ai";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AliasLlmRoutePolicy } from "./alias-adapter.ts";
import { AliasLlmAdapter } from "./alias-adapter.ts";
import { preferredGrokBuildModelFrom } from "./catalog.ts";
import { withCodexFastRouting } from "./codex-model-capabilities.ts";
import {
	CLAUDE_CODE_OAUTH_ROUTE,
	CLAUDE_PI_PROVIDER,
	CODEX_OAUTH_FAST_ROUTE,
	CODEX_OAUTH_ROUTE,
	CODEX_PI_PROVIDER,
	DEFAULT_GROK_BUILD_MODEL,
	GROK_BUILD_ROUTE,
	GROK_BUILD_STREAM_IDLE_TIMEOUT_MS,
	KIMI_CODE_OAUTH_ROUTE,
	KIMI_PI_PROVIDER,
	OPENCODE_ZEN_ROUTE,
	WORKBUDDY_ROUTE,
	XAI_PI_PROVIDER,
} from "./ids.ts";
import type { OAuthProviderSession } from "./oauth-session.ts";
import { OPENCODE_ZEN_DISPLAY_NAME, opencodeZenProvider } from "./opencode-zen-provider.ts";
import { grokBuildBaselineModels, grokBuildFingerprintHeaders } from "./provider.ts";
import { safeMessage } from "./redact.ts";
import type { GrokBuildSession } from "./session.ts";
import { WORKBUDDY_DISPLAY_NAME, workbuddyChatBase, workbuddyProvider } from "./workbuddy-provider.ts";
import type { WorkBuddySession } from "./workbuddy-session.ts";
import { workbuddyModelHeaders } from "./workbuddy-upstream.ts";

type PiAiAuthInjection = PiAiAdapterOptions["auth"];
type PiAiCredentialStore = PiAiAuthInjection["credentials"];

const REQUEST_IMAGE_POLICY = {
	maxRequestImageBytes: 20 * 1024 * 1024,
	requestImagePixelBudget: 2048 * 2048,
	requestImageMaxBytes: 1024 * 1024,
} as const;

/**
 * Route pi-ai credential operations to the already owner-locked OAuth files.
 * The adapter may ask its collection about every profile, so an unknown id is
 * never allowed to reach a writable store. Reads are empty and writes fail
 * closed, preserving the existing per-provider refresh lock and file policy.
 */
function oauthAuthInjection(grok: GrokBuildSession, subscriptions: readonly OAuthProviderSession[]): PiAiAuthInjection {
	const stores = new Map<string, PiAiCredentialStore>([
		[XAI_PI_PROVIDER, grok.store],
		...subscriptions.map((session) => [session.definition.nativeProviderId, session.store] as const),
	]);
	const storeFor = (providerId: string): PiAiCredentialStore | undefined => stores.get(providerId);
	return {
		credentials: {
			async read(providerId, options) {
				return storeFor(providerId)?.read(providerId, options);
			},
			async list(options) {
				const entries = await Promise.all([...stores.values()].map((store) => store.list(options)));
				return entries.flat();
			},
			async modify(providerId, fn, options) {
				const store = storeFor(providerId);
				if (store === undefined)
					throw new Error(`refusing credential write for unknown OAuth provider "${providerId}"`);
				return store.modify(providerId, fn, options);
			},
			async delete(providerId, options) {
				const store = storeFor(providerId);
				if (store === undefined)
					throw new Error(`refusing credential deletion for unknown OAuth provider "${providerId}"`);
				await store.delete(providerId, options);
			},
		},
		authContext: {
			// Subscription adapters obtain request credentials only from their
			// owner-scoped stores. Do not let a foreign environment/file credential
			// silently change a selected OAuth route.
			env: async () => undefined,
			fileExists: async () => false,
		},
	};
}

/** Prefer grok-4.6 when the current (live or baseline) list has it. */
export function preferredGrokBuildModel(models: readonly { id: string }[] = grokBuildBaselineModels()): string {
	return preferredGrokBuildModelFrom(models.length === 0 ? [{ id: DEFAULT_GROK_BUILD_MODEL }] : models);
}

function missingCredential(name: string): never {
	throw new LlmError(
		`${name} is not signed in. Open Settings → Coding OAuth and sign in with your subscription.`,
		"MISSING_CREDENTIAL",
	);
}

/**
 * Minimum remaining validity demanded of an exported OAuth access token.
 * pi-ai 0.84+ already refreshes five minutes before the stored expiry; this
 * explicit floor documents the plugin contract and hard-fails a refresh that
 * returns an even-shorter-lived token instead of handing it to a request.
 */
const MIN_OAUTH_VALIDITY_MS = 60_000;

/**
 * Provider retry policy for the coding-subscription routes. The harness
 * default retryable set (EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT)
 * deliberately excludes AUTH, so an upstream 401 — e.g. an access token the
 * server revoked before its local expiry — used to kill the turn outright.
 * AUTH is added here because {@link AliasLlmAdapter} invalidates the stored
 * credential on every AUTH finish, so the retried step refreshes first and
 * does not repeat the same rejected token. Quota exhaustion stays outside the
 * set: retrying a billing-limit 403 cannot succeed and only delays the real
 * message. Genuine credential death is converted to MISSING_CREDENTIAL (not
 * retryable) by the resolver below, so it cannot loop either.
 *
 * Five stacked exponential delays (5s → 10s → 20s → 40s → 80s, ~155s total)
 * pair with the xAI capacity remap in {@link AliasLlmAdapter}: "at capacity"
 * finish errors become RATE_LIMIT so they enter this policy instead of failing
 * as PI_AI_ERROR.
 */
const CODING_OAUTH_RETRY_POLICY = {
	mode: "normal" as const,
	maxRetries: 5,
	retryableCodes: ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "AUTH"],
	backoff: { initialDelayMs: 5_000, maxDelayMs: 80_000, jitterRatio: 0.1 },
};

function profile(
	provider: string,
	displayName: string,
	piProvider: ResolvedPiAiProviderProfile["piProvider"],
	retryPolicy?: RetryPolicyConfig | undefined,
	headers?: Record<string, string> | undefined,
): ResolvedPiAiProviderProfile & { modelErrors: Map<string, string> } {
	return {
		provider,
		displayName,
		streamIdleTimeoutMs: GROK_BUILD_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(
			retryPolicy ?? CODING_OAUTH_RETRY_POLICY,
			"dsh-coding-subscription-oauth retryPolicy",
		),
		configuredMaxTokens: new Map(),
		// Host dsh-llm-pi-ai 0.1.5+ calls modelErrors.get during resolveModel (#38).
		modelErrors: new Map(),
		...REQUEST_IMAGE_POLICY,
		...(headers === undefined ? {} : { headers }),
		// dsh-llm-pi-ai 0.2.0-rc.2 declares `piProvider?: Provider` under
		// `exactOptionalPropertyTypes`, so an explicitly `undefined` key is rejected:
		// the route must omit the property entirely when no provider was constructed.
		...(piProvider === undefined ? {} : { piProvider }),
	};
}

/** Existing Grok-only constructor retained for public API compatibility. */
export function createGrokBuildAdapter(
	session: GrokBuildSession,
	resolveAttachments: () => AttachmentStore | undefined,
): PiAiAdapter {
	return new PiAiAdapter({
		profiles: () =>
			new Map<string, ResolvedPiAiProviderProfile>([
				[
					GROK_BUILD_ROUTE,
					profile(GROK_BUILD_ROUTE, "xAI Grok Build", session.provider(), undefined, grokBuildFingerprintHeaders()),
				],
			]),
		resolveApiKey: async () =>
			resolveOAuthToken("Grok Build", async () => {
				const auth = await session.models.getAuth(XAI_PI_PROVIDER, { minOAuthValidityMs: MIN_OAUTH_VALIDITY_MS });
				return auth?.auth.apiKey;
			}),
		auth: oauthAuthInjection(session, []),
		resolveAttachments,
	});
}

/** Opt-in Codex Fast wiring; ordinary `codex-oauth` is unchanged when this is omitted. */
export interface CodingOAuthAdapterOptions {
	retryPolicy?: RetryPolicyConfig;
	codexFast?: { isEligible(modelId: string): boolean };
	/**
	 * WorkBuddy session, when the route should be served.
	 *
	 * Unlike the OAuth subscriptions this is not a login provider: the credential
	 * comes from the WorkBuddy desktop app, so the session owns discovery,
	 * refresh, the live roster and the per-model context budgets.
	 */
	workbuddy?: WorkBuddySession;
	/**
	 * OpenCode Zen, when the route should be served.
	 *
	 * Not an OAuth login either: the credential is a Zen API key the operator
	 * stores through the credentials service. `models` is a live closure because
	 * the enabled set is settings-card state, and the route serves whatever
	 * protocols the enabled models name — that is what
	 * {@link opencodeZenProvider} exists for, since DSH settings can only name
	 * one protocol per route.
	 */
	opencodeZen?: {
		models: () => readonly Model<Api>[];
		resolveApiKey: () => Promise<string | undefined>;
	};
}

function isRetryPolicyConfig(value: object): value is RetryPolicyConfig {
	return "mode" in value;
}

function splitCodingOAuthAdapterArgs(
	fourth?: RetryPolicyConfig | CodingOAuthAdapterOptions,
	fifth?: CodingOAuthAdapterOptions,
): CodingOAuthAdapterOptions {
	if (fifth !== undefined) {
		return {
			...(fourth !== undefined && isRetryPolicyConfig(fourth) ? { retryPolicy: fourth } : {}),
			...fifth,
		};
	}
	if (fourth === undefined) return {};
	if (isRetryPolicyConfig(fourth)) return { retryPolicy: fourth };
	return {
		...(fourth.retryPolicy === undefined ? {} : { retryPolicy: fourth.retryPolicy }),
		...(fourth.codexFast === undefined ? {} : { codexFast: fourth.codexFast }),
		...(fourth.workbuddy === undefined ? {} : { workbuddy: fourth.workbuddy }),
		...(fourth.opencodeZen === undefined ? {} : { opencodeZen: fourth.opencodeZen }),
	};
}

/** Create the four-route OAuth adapter while preserving each pi-ai native id. */
export function createCodingOAuthAdapter(
	grok: GrokBuildSession,
	subscriptions: readonly OAuthProviderSession[],
	resolveAttachments: () => AttachmentStore | undefined,
	retryPolicy?: RetryPolicyConfig,
	options?: CodingOAuthAdapterOptions,
): LlmAdapter;
export function createCodingOAuthAdapter(
	grok: GrokBuildSession,
	subscriptions: readonly OAuthProviderSession[],
	resolveAttachments: () => AttachmentStore | undefined,
	options?: CodingOAuthAdapterOptions,
): LlmAdapter;
export function createCodingOAuthAdapter(
	grok: GrokBuildSession,
	subscriptions: readonly OAuthProviderSession[],
	resolveAttachments: () => AttachmentStore | undefined,
	retryPolicyOrOptions?: RetryPolicyConfig | CodingOAuthAdapterOptions,
	options?: CodingOAuthAdapterOptions,
): LlmAdapter {
	const { retryPolicy, codexFast, workbuddy, opencodeZen } = splitCodingOAuthAdapterArgs(retryPolicyOrOptions, options);
	const byNativeId = new Map(subscriptions.map((session) => [session.definition.nativeProviderId, session]));
	const codexSession = byNativeId.get(CODEX_PI_PROVIDER);
	const aliases = new Map<string, string>([
		[GROK_BUILD_ROUTE, GROK_BUILD_ROUTE],
		[CODEX_OAUTH_ROUTE, CODEX_PI_PROVIDER],
		[KIMI_CODE_OAUTH_ROUTE, KIMI_PI_PROVIDER],
		[CLAUDE_CODE_OAUTH_ROUTE, CLAUDE_PI_PROVIDER],
	]);
	if (codexFast !== undefined && codexSession !== undefined) {
		aliases.set(CODEX_OAUTH_FAST_ROUTE, CODEX_OAUTH_FAST_ROUTE);
	}
	if (workbuddy !== undefined) {
		// The route and the pi-ai provider id are deliberately identical, as they
		// are for Grok Build: the model descriptors carry `provider: WORKBUDDY_ROUTE`,
		// and the profile map is keyed by that same id.
		aliases.set(WORKBUDDY_ROUTE, WORKBUDDY_ROUTE);
	}
	if (opencodeZen !== undefined) {
		// Same identity rule as WorkBuddy and Grok Build: the descriptor's
		// `provider` and the profile-map key are one string, so alias it to itself.
		aliases.set(OPENCODE_ZEN_ROUTE, OPENCODE_ZEN_ROUTE);
	}
	const policies = new Map<string, AliasLlmRoutePolicy>([
		[
			GROK_BUILD_ROUTE,
			{
				displayName: "xAI Grok Build (OAuth)",
				isAuthenticated: async () => (await grok.store.read(XAI_PI_PROVIDER))?.type === "oauth",
				onAuthFailure: () => grok.invalidateAccessToken(),
			},
		],
	]);
	for (const session of subscriptions) {
		policies.set(session.definition.route, {
			displayName: `${session.definition.displayName.replace(/\s*\([^)]*\)$/u, "")} (OAuth)`,
			isAuthenticated: async () => (await session.status()).authenticated,
			onAuthFailure: () => session.invalidateAccessToken(),
		});
	}
	if (codexFast !== undefined && codexSession !== undefined) {
		policies.set(CODEX_OAUTH_FAST_ROUTE, {
			displayName: "OpenAI Codex Fast requested (OAuth)",
			isAuthenticated: async () => (await codexSession.status()).authenticated,
			includeModel: (modelId) => codexFast.isEligible(modelId),
			onAuthFailure: () => codexSession.invalidateAccessToken(),
		});
	}
	if (workbuddy !== undefined) {
		policies.set(WORKBUDDY_ROUTE, {
			displayName: WORKBUDDY_DISPLAY_NAME,
			// The desktop app owns the sign-in, so "authenticated" is "the plugin
			// can read a usable credential", never a login this plugin performed.
			isAuthenticated: async () => (await workbuddy.store.status()).state === "signed-in",
			onAuthFailure: () => workbuddy.store.invalidateAccessToken(),
		});
	}
	if (opencodeZen !== undefined) {
		policies.set(OPENCODE_ZEN_ROUTE, {
			displayName: OPENCODE_ZEN_DISPLAY_NAME,
			// A Zen API key is stored through the credentials service rather than a
			// login this plugin runs, so "authenticated" means "a key resolves".
			isAuthenticated: async () => (await opencodeZen.resolveApiKey()) !== undefined,
			// There is no refresh to invalidate: the key is long-lived and the
			// operator replaces it in the card. A 401 therefore surfaces as an auth
			// failure without pretending a silent renewal happened.
			onAuthFailure: async () => undefined,
		});
	}

	const inner = new PiAiAdapter({
		profiles: () => {
			const profiles = new Map<string, ResolvedPiAiProviderProfile>();
			profiles.set(
				GROK_BUILD_ROUTE,
				profile(GROK_BUILD_ROUTE, "xAI Grok Build", grok.provider(), retryPolicy, grokBuildFingerprintHeaders()),
			);
			for (const session of subscriptions) {
				profiles.set(
					session.definition.nativeProviderId,
					profile(session.definition.nativeProviderId, session.definition.displayName, session.provider(), retryPolicy),
				);
			}
			if (codexFast !== undefined && codexSession !== undefined) {
				const wrapped = withCodexFastRouting(codexSession.provider(), {
					isEligible: (modelId) => codexFast.isEligible(modelId),
					profileProviderId: CODEX_OAUTH_FAST_ROUTE,
					nativeProviderId: CODEX_PI_PROVIDER,
				});
				// Models.streamSimple dispatches on model.provider. Advertise the Fast
				// profile id on the catalog so the wrapper runs, then restore native
				// identity inside withCodexFastRouting before the wire call.
				const fastProvider = {
					...wrapped,
					getModels: () =>
						wrapped
							.getModels()
							.map((model) =>
								model.provider === CODEX_OAUTH_FAST_ROUTE ? model : { ...model, provider: CODEX_OAUTH_FAST_ROUTE },
							),
				};
				profiles.set(
					CODEX_OAUTH_FAST_ROUTE,
					profile(
						CODEX_OAUTH_FAST_ROUTE,
						"OpenAI Codex Fast requested",
						fastProvider as unknown as ResolvedPiAiProviderProfile["piProvider"],
						retryPolicy,
					),
				);
			}
			if (workbuddy !== undefined) {
				// The roster closure is LIVE and synchronous, because pi-ai's
				// `profiles` callback is. It re-derives the base URL and the
				// credential-dependent WorkBuddy headers from the credential the store
				// has most recently seen, so switching between a domestic and an
				// international account reaches the next request without a rebuild.
				profiles.set(
					WORKBUDDY_ROUTE,
					profile(
						WORKBUDDY_ROUTE,
						WORKBUDDY_DISPLAY_NAME,
						workbuddyProvider({
							models: () => {
								const peeked = workbuddy.store.peek();
								const base = `${workbuddyChatBase({ domain: peeked?.domain ?? "" })}/v2`;
								return workbuddy.piModels(base, peeked === undefined ? {} : workbuddyModelHeaders(peeked));
							},
						}),
						retryPolicy,
					),
				);
			}
			if (opencodeZen !== undefined) {
				// The provider is built with a multi-protocol `api` map, which is the
				// only way one route can serve the protocols a Zen account spans:
				// DSH settings name a single protocol per route and ignore a per-model
				// one, so a settings-declared route could never hold a mixed selection.
				profiles.set(
					OPENCODE_ZEN_ROUTE,
					profile(
						OPENCODE_ZEN_ROUTE,
						OPENCODE_ZEN_DISPLAY_NAME,
						opencodeZenProvider({ models: opencodeZen.models }),
						retryPolicy,
					),
				);
			}
			return profiles;
		},
		resolveApiKey: async (provider) => {
			if (provider === GROK_BUILD_ROUTE) {
				return resolveOAuthToken("Grok Build", async () => {
					const auth = await grok.models.getAuth(XAI_PI_PROVIDER, { minOAuthValidityMs: MIN_OAUTH_VALIDITY_MS });
					return auth?.auth.apiKey;
				});
			}
			if (provider === WORKBUDDY_ROUTE) {
				if (workbuddy === undefined) throw new LlmError(`Unknown OAuth provider "${provider}"`, "NO_ADAPTER");
				// The store owns refresh (single-flight, five-minute margin) and the
				// desktop app owns the sign-in, so this is the only place a WorkBuddy
				// request acquires its bearer.
				return resolveOAuthToken("WorkBuddy", async () => (await workbuddy.store.resolve()).accessToken);
			}
			if (provider === OPENCODE_ZEN_ROUTE) {
				if (opencodeZen === undefined) throw new LlmError(`Unknown OAuth provider "${provider}"`, "NO_ADAPTER");
				// A Zen key is long-lived and operator-managed, so there is nothing to
				// refresh: a miss is a missing credential, reported as such rather
				// than retried as a transient auth failure.
				const key = await opencodeZen.resolveApiKey();
				if (key === undefined || key.length === 0) return missingCredential("OpenCode Zen");
				return key;
			}
			const session =
				provider === CODEX_OAUTH_FAST_ROUTE ? byNativeId.get(CODEX_PI_PROVIDER) : byNativeId.get(provider);
			if (session === undefined) throw new LlmError(`Unknown OAuth provider "${provider}"`, "NO_ADAPTER");
			return resolveOAuthToken(session.definition.displayName, () => session.resolveAccessToken());
		},
		auth: oauthAuthInjection(grok, subscriptions),
		resolveAttachments,
	});

	// The Fast wrapper restores wire/replay model identity to openai-codex.
	// Keep the opaque envelope untouched and map public Fast source identity to
	// that native replay provider before PiAiAdapter validates it.
	const replayProviders = new Map(aliases);
	replayProviders.set(CODEX_OAUTH_FAST_ROUTE, CODEX_PI_PROVIDER);
	return new AliasLlmAdapter(inner, aliases, policies, replayProviders);
}

/**
 * Resolve an OAuth access token for one route, translating a failed refresh
 * (revoked refresh token, dead grant) into MISSING_CREDENTIAL so the failure
 * is not retried and the user is told to sign in again rather than shown a
 * bare upstream 401.
 */
async function resolveOAuthToken(
	displayName: string,
	getAccessToken: () => Promise<string | undefined>,
): Promise<string> {
	let accessToken: string | undefined;
	try {
		accessToken = await getAccessToken();
	} catch (error) {
		throw new LlmError(
			`${displayName} could not refresh its sign-in (${safeMessage(error)}).` +
				" Open Settings → Coding OAuth and sign in again.",
			"MISSING_CREDENTIAL",
		);
	}
	if (accessToken === undefined || accessToken.length === 0) return missingCredential(displayName);
	return accessToken;
}
