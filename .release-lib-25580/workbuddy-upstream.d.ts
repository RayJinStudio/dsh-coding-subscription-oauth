/**
 * WorkBuddy upstream HTTP protocol: hosts, credential headers, the model
 * catalog, the daily check-in, and the request-body normalization the gateway
 * requires.
 *
 * Everything here is pure transport and parsing — no cordis context, no
 * credential store — so the module stays importable from tests and the CLI.
 * The caller passes a {@link WorkBuddyCredential} per request, which is what
 * makes a token refresh apply to the very next call.
 *
 * Provenance: the endpoint paths, the header conventions, the envelope shape,
 * the catalog parser and the check-in protocol are a port of
 * `dingminhua/dsh-connect-workbuddy` (MIT, Copyright (c) 2026 LaoDing),
 * re-verified against the live CN gateway.
 *
 * @module dsh-coding-subscription-oauth/workbuddy-upstream
 */
import type { WorkBuddyCredential, WorkBuddyRefreshOutcome, WorkBuddyRegion } from "./workbuddy-auth.js";
/** Path of the chat completion endpoint, appended to a region's chat base. */
export declare const WORKBUDDY_CHAT_PATH = "/v2/chat/completions";
/** Token-refresh endpoint; the only call that carries the refresh token. */
export declare const WORKBUDDY_REFRESH_PATH = "/v2/plugin/auth/token/refresh";
/** Daily check-in status endpoint (read-only). */
export declare const WORKBUDDY_CHECKIN_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
/** Daily check-in claim endpoint (a real, one-per-day grant). */
export declare const WORKBUDDY_CHECKIN_CLAIM_PATH = "/v2/billing/meter/daily-checkin";
/** Remaining-credit endpoint. */
export declare const WORKBUDDY_CREDITS_PATH = "/v2/billing/meter/get-user-resource";
/**
 * User agent the catalog fetch and every chat request uses.
 *
 * Load-bearing rather than cosmetic, in two independent ways:
 *
 * 1. `/v3/config` serves a DIFFERENT roster per client channel selected by this
 *    product token. The CLI channel is what the chat path emulates, and for CN it
 *    is the only channel carrying the free `hy4-preview-f`.
 * 2. The chat endpoint's channel check rejects a request whose `User-Agent` does
 *    not name an official client, answering business code `11128`
 *    ("not sent from an official client"). This is why the value must be stated
 *    on `profile.headers` and not only on the model: `dsh-llm-pi-ai` merges the
 *    harness attribution UA over anything a model supplies.
 */
export declare const WORKBUDDY_CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
/**
 * Stand-in system message for a request that reached the wire carrying none.
 *
 * Both gateways want the conversation to OPEN with a system message, and the
 * international one enforces it — a user-first body is refused with business
 * code `11128` ("first message is not system prompt"). Deliberately tiny: this
 * is a last-resort placeholder, not a persona.
 */
export declare const WORKBUDDY_FALLBACK_SYSTEM_PROMPT = "You are a helpful assistant.";
/** Gateway for an international credential, following its own brand domain. */
export declare function workbuddyGlobalBase(domain: string): string;
/** The chat completion base for a credential's region. */
export declare function workbuddyChatBase(credential: Pick<WorkBuddyCredential, "domain">): string;
/** The billing base for a credential's region. */
export declare function workbuddyBillingBase(credential: Pick<WorkBuddyCredential, "domain">): string;
/** Whether a region exposes the daily check-in at all (CN only today). */
export declare function workbuddyCheckinSupported(region: WorkBuddyRegion): boolean;
/**
 * Chat request headers, including the `X-No-*` conventions the official CLI
 * uses to state an absent field.
 *
 * The refresh token is deliberately absent: `chat` requests must never carry
 * it, and {@link workbuddyRefreshHeaders} is the only place it appears.
 */
export declare function workbuddyChatHeaders(credential: WorkBuddyCredential): Record<string, string>;
/**
 * Credential-dependent headers for a per-request wire call.
 *
 * `Authorization` is deliberately absent: pi-ai injects `Bearer <apiKey>` from
 * the surrounding adapter's resolver, and duplicating it here would mean two
 * sources for one header.
 */
export declare function workbuddyModelHeaders(credential: WorkBuddyCredential): Record<string, string>;
/** Refresh-endpoint headers; the refresh token appears here and nowhere else. */
export declare function workbuddyRefreshHeaders(credential: WorkBuddyCredential): Record<string, string>;
/**
 * Billing request headers.
 *
 * Deliberately thinner than the chat set: the billing host does not want the
 * CLI `User-Agent`, `Origin`, `Referer`, `X-Product` or the `X-No-*` sentinels,
 * and sending them changes the request the shipped desktop flow makes.
 */
export declare function workbuddyBillingHeaders(credential: WorkBuddyCredential): Record<string, string>;
/**
 * Classify a transport-level or gateway-level failure into the code this plugin
 * raises. Kept coarse on purpose: the caller only needs to decide retryable vs
 * not, and a fabricated fine-grained cause would be worse than a broad one.
 */
export type WorkBuddyErrorKind = "auth" | "quota" | "rate_limit" | "not_found" | "server" | "client" | "transport";
/** One upstream failure, secret-free. */
export declare class WorkBuddyUpstreamError extends Error {
    readonly status: number;
    readonly kind: WorkBuddyErrorKind;
    constructor(kind: WorkBuddyErrorKind, status: number, message: string);
}
/** Classify one upstream failure body. */
export declare function classifyWorkBuddyError(status: number, body: string): WorkBuddyErrorKind;
/** One catalog entry the adapter exposes. */
export interface WorkBuddyModelInfo {
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
    /** Credit multiplier parsed from the upstream `credits` string. */
    creditMultiplier?: number;
    /** The upstream's own image-input flag; see the module's fixed modality policy. */
    supportsImages?: boolean;
    reasoning?: WorkBuddyReasoning;
    descriptionZh?: string;
    descriptionEn?: string;
    supportsToolCall?: boolean;
}
/** Normalized reasoning metadata for one model. */
export interface WorkBuddyReasoning {
    supportedEfforts?: string[];
    defaultEffort?: string;
    canDisableThinking?: boolean;
}
/** Parse the upstream's `credits` string into a multiplier. */
export declare function parseWorkBuddyCreditMultiplier(value: unknown): number | undefined;
/** Parse the upstream's `reasoning` object; unknown shapes degrade to undefined. */
export declare function parseWorkBuddyReasoning(value: unknown): WorkBuddyReasoning | undefined;
/**
 * Parse one catalog entry; entries without usable token limits are dropped.
 *
 * `maxInputTokens` becomes `contextWindow` and `maxOutputTokens` becomes
 * `maxTokens` — a rename, not a conversion.
 */
export declare function parseWorkBuddyModel(value: unknown): WorkBuddyModelInfo | undefined;
/**
 * Select the chat-capable roster from a catalog document.
 *
 * The desktop config lists the CLI channel's own agent next to the full model
 * list; the chat path can only use what that agent declares, so when a `cli`
 * agent exists its `models` array is the roster. Falling back to the full list
 * keeps the provider usable on a config that carries no agent section.
 */
export declare function selectWorkBuddyRoster(data: unknown): WorkBuddyModelInfo[];
/** Fetch the account's model roster for one credential. */
export declare function fetchWorkBuddyCatalog(credential: WorkBuddyCredential, signal?: AbortSignal, onFallback?: (message: string) => void): Promise<WorkBuddyModelInfo[]>;
/** Today's check-in state, as the billing host reports it. */
export interface WorkBuddyCheckinStatus {
    active: boolean;
    todayCheckedIn: boolean;
    streakDays: number;
    dailyCredit: number;
    todayCredit: number;
    isStreakDay: boolean;
    nextStreakDay: number;
    streakBonusDays: number;
    streakBonusCredit: number;
    /** Server-provided button label, when present. */
    claimButtonText?: string;
}
/** What a successful claim granted. */
export interface WorkBuddyCheckinClaim {
    credit: number;
    streakDays: number;
    isStreakDay: boolean;
}
/** Query today's check-in status without changing account state. */
export declare function fetchWorkBuddyCheckinStatus(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<WorkBuddyCheckinStatus>;
/**
 * Claim today's check-in reward.
 *
 * This is a REAL grant on the user's account and is therefore only ever called
 * from an explicit user action, never from a timer: the caller must read
 * {@link fetchWorkBuddyCheckinStatus} first and skip the claim when
 * `todayCheckedIn` is already true.
 */
export declare function claimWorkBuddyCheckin(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<WorkBuddyCheckinClaim>;
/**
 * POST the token-refresh endpoint.
 *
 * The response is merged by the caller; `expiresIn` is in SECONDS, which is the
 * upstream's own unit and unlike the millisecond stamps in the auth document.
 */
export declare function refreshWorkBuddyToken(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<WorkBuddyRefreshOutcome>;
/**
 * One credit package, kept separate so the card can group by cycle.
 *
 * `remaining`/`total` are always the figures the user is actually spending down,
 * and for a monthly package that means the CURRENT CYCLE's, not the package's.
 * This matters because the upstream leaves `CapacityRemain`/`CapacitySize` at the
 * full monthly allocation (measured: 500/500) while the cycle counters carry the
 * real spend (71/500); reading the package-level fields there reports the whole
 * allocation as still unspent, so a sum across packages reads as a total rather
 * than a remainder. The reference implementation resolves this the same way
 * (`monthly ? CycleCapacityRemain : CapacityRemain`).
 *
 * The parent envelope's `Dosage`/`TotalDosage` are sums across packages rather
 * than per-row, so they are never read here.
 */
export interface WorkBuddyCreditPackage {
    accountId: number;
    dealName: string;
    packageName?: string;
    capacityType: number;
    capacityUnit: string;
    /** What the user is spending down: the current cycle for a monthly package, the package itself otherwise. */
    remaining: number;
    /** The capacity `remaining` is measured against. */
    total: number;
    /** True for a monthly resource, whose `remaining`/`total` are the current cycle's. */
    monthly: boolean;
    cycleStartTime?: string;
    cycleEndTime?: string;
    expiredTime?: string;
}
/** Aggregated remaining credit. */
export interface WorkBuddyCredits {
    totalCount: number;
    /** Sum of every package's remaining amount. */
    totalRemaining: number;
    packages: WorkBuddyCreditPackage[];
}
/**
 * Whether a package is a monthly-cycle one, whose CURRENT CYCLE figures are what
 * the user watches. Everything else is a one-off gift spending down its total.
 */
export declare function isWorkBuddyMonthlyPackage(capacityType: number): boolean;
/**
 * Read the remaining credit, keeping every package separate.
 *
 * The response is triple-nested PascalCase (`data.Response.Data.Accounts`), so
 * each level is unwrapped defensively rather than assumed.
 */
export declare function fetchWorkBuddyCredits(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<WorkBuddyCredits>;
/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy gateway.
 *
 * Three quirks, each measured against the live gateway: streaming is forced
 * (the upstream rejects non-streaming), `developer` becomes `system` (the
 * gateway rejects `developer` with code `11128`), and the conversation is
 * guaranteed to open with a system message.
 *
 * The `model` id passes through verbatim — no prefixing and no `auto`
 * special-case — because the upstream keys its own roster directly.
 */
export declare function prepareWorkBuddyChatBody(source: string): string;
//# sourceMappingURL=workbuddy-upstream.d.ts.map