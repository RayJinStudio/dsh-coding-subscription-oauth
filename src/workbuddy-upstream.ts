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

import type { WorkBuddyCredential, WorkBuddyRefreshOutcome, WorkBuddyRegion } from "./workbuddy-auth.ts";
import { workbuddyRegionOf } from "./workbuddy-auth.ts";

/** CN chat gateway. Its `/v3/config` serves the domestic roster. */
const CN_CHAT_BASE = "https://copilot.tencent.com";
/** CN billing host; the check-in and credit endpoints live here. */
const CN_BILLING_BASE = "https://www.codebuddy.cn";
/** International gateway for the `workbuddy.ai` brand. */
const GLOBAL_BASE = "https://www.workbuddy.ai";
/** International gateway for the `codebuddy.ai` brand; tokens are NOT interchangeable. */
const GLOBAL_CODEBUDDY_BASE = "https://www.codebuddy.ai";

/**
 * Remote product-config path, the primary catalog source for both regions.
 *
 * Field-compatible with the legacy CN path for every key this module reads, so
 * one parser serves both.
 */
const CONFIG_PATH = "/v3/config";

/**
 * Legacy model-catalog path, kept only as the CN region's fallback.
 *
 * It is NOT the document the desktop app reads: the gateway answers it with the
 * CLI channel's roster, whose second slot is the paid `hy4-preview` while the
 * app's own config lists the free `hy4-preview-f` under the same display name.
 */
const LEGACY_MODELS_PATH = "/v2/enterprises/personal/models";

/** Path of the chat completion endpoint, appended to a region's chat base. */
export const WORKBUDDY_CHAT_PATH = "/v2/chat/completions";

/** Token-refresh endpoint; the only call that carries the refresh token. */
export const WORKBUDDY_REFRESH_PATH = "/v2/plugin/auth/token/refresh";

/** Daily check-in status endpoint (read-only). */
export const WORKBUDDY_CHECKIN_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";

/** Daily check-in claim endpoint (a real, one-per-day grant). */
export const WORKBUDDY_CHECKIN_CLAIM_PATH = "/v2/billing/meter/daily-checkin";

/** Remaining-credit endpoint. */
export const WORKBUDDY_CREDITS_PATH = "/v2/billing/meter/get-user-resource";

/** Product code the credit query is scoped to. */
const CREDITS_PRODUCT_CODE = "p_tcaca";

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
export const WORKBUDDY_CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";

/** @deprecated Local alias kept so existing call sites read unchanged. */
const CLIENT_UA = WORKBUDDY_CLIENT_UA;

/** Timeout for a small JSON call. */
const JSON_TIMEOUT_MS = 30_000;

/**
 * Stand-in system message for a request that reached the wire carrying none.
 *
 * Both gateways want the conversation to OPEN with a system message, and the
 * international one enforces it — a user-first body is refused with business
 * code `11128` ("first message is not system prompt"). Deliberately tiny: this
 * is a last-resort placeholder, not a persona.
 */
export const WORKBUDDY_FALLBACK_SYSTEM_PROMPT = "You are a helpful assistant.";

/** Gateway for an international credential, following its own brand domain. */
export function workbuddyGlobalBase(domain: string): string {
	const lowered = domain.trim().toLowerCase();
	if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) return GLOBAL_CODEBUDDY_BASE;
	return GLOBAL_BASE;
}

/** The chat completion base for a credential's region. */
export function workbuddyChatBase(credential: Pick<WorkBuddyCredential, "domain">): string {
	return workbuddyRegionOf(credential.domain) === "global" ? workbuddyGlobalBase(credential.domain) : CN_CHAT_BASE;
}

/** The billing base for a credential's region. */
export function workbuddyBillingBase(credential: Pick<WorkBuddyCredential, "domain">): string {
	return workbuddyRegionOf(credential.domain) === "global" ? workbuddyGlobalBase(credential.domain) : CN_BILLING_BASE;
}

/** Whether a region exposes the daily check-in at all (CN only today). */
export function workbuddyCheckinSupported(region: WorkBuddyRegion): boolean {
	return region === "cn";
}

/** Headers every upstream request shares. */
function commonHeaders(credential: WorkBuddyCredential): Record<string, string> {
	const billing = workbuddyBillingBase(credential);
	return {
		Accept: "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		Origin: billing,
		Referer: `${billing}/`,
		"User-Agent": CLIENT_UA,
	};
}

/**
 * Chat request headers, including the `X-No-*` conventions the official CLI
 * uses to state an absent field.
 *
 * The refresh token is deliberately absent: `chat` requests must never carry
 * it, and {@link workbuddyRefreshHeaders} is the only place it appears.
 */
export function workbuddyChatHeaders(credential: WorkBuddyCredential): Record<string, string> {
	return {
		...commonHeaders(credential),
		"Content-Type": "application/json",
		...(credential.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid }),
		...(credential.enterpriseId === undefined || credential.enterpriseId === ""
			? { "X-No-Enterprise-Id": "1" }
			: { "X-Enterprise-Id": credential.enterpriseId }),
		...(credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain }),
		"X-Product": "SaaS",
		Authorization: `Bearer ${credential.accessToken}`,
	};
}

/**
 * Credential-dependent headers for a per-request wire call.
 *
 * `Authorization` is deliberately absent: pi-ai injects `Bearer <apiKey>` from
 * the surrounding adapter's resolver, and duplicating it here would mean two
 * sources for one header.
 */
export function workbuddyModelHeaders(credential: WorkBuddyCredential): Record<string, string> {
	const { Authorization: _authorization, ...rest } = workbuddyChatHeaders(credential);
	return rest;
}

/** Refresh-endpoint headers; the refresh token appears here and nowhere else. */
export function workbuddyRefreshHeaders(credential: WorkBuddyCredential): Record<string, string> {
	return {
		...commonHeaders(credential),
		"X-Refresh-Token": credential.refreshToken,
		"X-Auth-Refresh-Source": "workbuddy",
		...(credential.enterpriseId === undefined || credential.enterpriseId === ""
			? {}
			: { "X-Enterprise-Id": credential.enterpriseId }),
	};
}

/**
 * Billing request headers.
 *
 * Deliberately thinner than the chat set: the billing host does not want the
 * CLI `User-Agent`, `Origin`, `Referer`, `X-Product` or the `X-No-*` sentinels,
 * and sending them changes the request the shipped desktop flow makes.
 */
export function workbuddyBillingHeaders(credential: WorkBuddyCredential): Record<string, string> {
	return {
		Authorization: `Bearer ${credential.accessToken}`,
		Accept: "application/json",
		"Content-Type": "application/json",
		...(credential.uid === "" ? {} : { "X-User-Id": credential.uid }),
		...(credential.enterpriseId === undefined || credential.enterpriseId === ""
			? {}
			: { "X-Enterprise-Id": credential.enterpriseId, "X-Tenant-Id": credential.enterpriseId }),
		...(credential.domain === "" ? {} : { "X-Domain": credential.domain }),
	};
}

/** The shared `{code,msg,data}` envelope every WorkBuddy JSON answer uses. */
interface Envelope {
	code: number;
	msg: string;
	data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classify a transport-level or gateway-level failure into the code this plugin
 * raises. Kept coarse on purpose: the caller only needs to decide retryable vs
 * not, and a fabricated fine-grained cause would be worse than a broad one.
 */
export type WorkBuddyErrorKind = "auth" | "quota" | "rate_limit" | "not_found" | "server" | "client" | "transport";

/** One upstream failure, secret-free. */
export class WorkBuddyUpstreamError extends Error {
	readonly status: number;
	readonly kind: WorkBuddyErrorKind;
	constructor(kind: WorkBuddyErrorKind, status: number, message: string) {
		super(message);
		this.name = "WorkBuddyUpstreamError";
		this.kind = kind;
		this.status = status;
	}
}

/** Markers that mean "the account is out of credit", ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
	"insufficient credit",
	"no credit",
	"credit exhausted",
	"out of credit",
	"quota exceeded",
	"quota exhaust",
	"payment required",
	"credit not enough",
	"not enough credit",
	"积分不足",
	"额度不足",
	"余额不足",
	"积分用完",
	"额度用尽",
	"没有积分",
];

/** Markers that mean the stored session was revoked upstream. */
const SESSION_DEAD_MARKERS = ["Offline user session not found", "12153"];

/** Classify one upstream failure body. */
export function classifyWorkBuddyError(status: number, body: string): WorkBuddyErrorKind {
	// 402 is unambiguous on its own, and is decided before the text scan so a
	// payment-required status can never be reclassified by an unrelated word.
	if (status === 402) return "quota";
	const lowered = body.toLowerCase();
	if (HARD_CREDIT_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()) || body.includes(marker))) {
		return "quota";
	}
	if (SESSION_DEAD_MARKERS.some((marker) => body.includes(marker))) return "auth";
	if (status === 401 || status === 403) return "auth";
	if (status === 429) return "rate_limit";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	if (status >= 400) return "client";
	return "transport";
}

/** How much of an unexpected body is quoted back in an error message. */
const ENVELOPE_EXCERPT_BYTES = 400;

/**
 * Read one JSON envelope, mapping HTTP and business failures to one error type.
 *
 * The body is parsed IN FULL and only the error EXCERPT is bounded. Truncating
 * before parsing would corrupt any answer larger than the cap — and would bound
 * nothing, because `response.text()` has already buffered the whole body by the
 * time it returns. `maxBytes` is a real ceiling on how much is READ, for a
 * hostile or runaway answer, and it is generous enough for the largest catalog
 * the gateway serves.
 */
async function readEnvelope(response: Response, maxBytes = 8 * 1024 * 1024): Promise<Envelope> {
	const declared = response.headers.get("content-length");
	if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw new WorkBuddyUpstreamError(
			"server",
			response.status,
			`WorkBuddy answered with more than ${maxBytes} bytes (HTTP ${response.status})`,
		);
	}
	const text = await response.text();
	if (Buffer.byteLength(text, "utf8") > maxBytes) {
		throw new WorkBuddyUpstreamError(
			"server",
			response.status,
			`WorkBuddy answered with more than ${maxBytes} bytes (HTTP ${response.status})`,
		);
	}
	const excerpt = (): string => text.slice(0, ENVELOPE_EXCERPT_BYTES);
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new WorkBuddyUpstreamError(
			classifyWorkBuddyError(response.status, text),
			response.status,
			`WorkBuddy answered with a non-JSON response (HTTP ${response.status}): ${excerpt().replace(/\s+/gu, " ")}`,
		);
	}
	if (!isRecord(body)) {
		throw new WorkBuddyUpstreamError(
			"server",
			response.status,
			`WorkBuddy answered with an unexpected envelope (HTTP ${response.status})`,
		);
	}
	const code = typeof body["code"] === "number" ? body["code"] : -1;
	const msg = typeof body["msg"] === "string" ? body["msg"] : "";
	if (!response.ok || code !== 0) {
		throw new WorkBuddyUpstreamError(
			classifyWorkBuddyError(response.status, msg),
			response.status,
			`WorkBuddy upstream failed (HTTP ${response.status}${code === -1 ? "" : `, code ${code}`}): ${
				msg.slice(0, 160) || excerpt() || "no message"
			}`,
		);
	}
	return { code, msg, data: body["data"] };
}

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

/**
 * Effort vocabulary the upstream declares. `minimal` has never appeared; both
 * gateways accept every level in it on singular-form models, so the singular
 * `effort` value is a DEFAULT rather than the model's only level.
 */
const SINGULAR_EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"] as const;

/** Parse the upstream's `credits` string into a multiplier. */
export function parseWorkBuddyCreditMultiplier(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value);
	if (match === null) return undefined;
	const parsed = Number(match[1]);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Whether reasoning metadata uses the singular `effort` spelling. */
function isSingularEffortForm(raw: Record<string, unknown>): boolean {
	return (
		typeof raw["effort"] === "string" &&
		!Array.isArray(raw["supportedEfforts"]) &&
		typeof raw["defaultEffort"] !== "string" &&
		typeof raw["canDisableThinking"] !== "boolean"
	);
}

/** Fold a singular-form `effort` into the plural shape the rest understands. */
function singularEffortLadder(raw: Record<string, unknown>): string[] | undefined {
	const effort = typeof raw["effort"] === "string" ? raw["effort"] : undefined;
	if (effort === undefined) return undefined;
	return (SINGULAR_EFFORT_LADDER as readonly string[]).includes(effort) ? [...SINGULAR_EFFORT_LADDER] : [effort];
}

/** Parse the upstream's `reasoning` object; unknown shapes degrade to undefined. */
export function parseWorkBuddyReasoning(value: unknown): WorkBuddyReasoning | undefined {
	if (!isRecord(value)) return undefined;
	const raw = value;
	const effort = typeof raw["effort"] === "string" ? raw["effort"] : undefined;
	const supportedEfforts = Array.isArray(raw["supportedEfforts"])
		? raw["supportedEfforts"].filter((entry): entry is string => typeof entry === "string")
		: singularEffortLadder(raw);
	const defaultEffort = typeof raw["defaultEffort"] === "string" ? raw["defaultEffort"] : effort;
	const canDisableThinking =
		typeof raw["canDisableThinking"] === "boolean"
			? raw["canDisableThinking"]
			: isSingularEffortForm(raw)
				? true
				: undefined;
	if (supportedEfforts === undefined && defaultEffort === undefined && canDisableThinking === undefined) {
		return undefined;
	}
	return {
		...(supportedEfforts === undefined || supportedEfforts.length === 0 ? {} : { supportedEfforts }),
		...(defaultEffort === undefined ? {} : { defaultEffort }),
		...(canDisableThinking === undefined ? {} : { canDisableThinking }),
	};
}

/**
 * Parse one catalog entry; entries without usable token limits are dropped.
 *
 * `maxInputTokens` becomes `contextWindow` and `maxOutputTokens` becomes
 * `maxTokens` — a rename, not a conversion.
 */
export function parseWorkBuddyModel(value: unknown): WorkBuddyModelInfo | undefined {
	if (!isRecord(value)) return undefined;
	const raw = value;
	const id = typeof raw["id"] === "string" ? raw["id"] : "";
	if (id === "" || raw["disabled"] === true) return undefined;
	const input = typeof raw["maxInputTokens"] === "number" ? raw["maxInputTokens"] : 0;
	const output = typeof raw["maxOutputTokens"] === "number" ? raw["maxOutputTokens"] : 0;
	if (input <= 0 || output <= 0) return undefined;
	const name = typeof raw["name"] === "string" && raw["name"] !== "" ? raw["name"] : id;
	const descriptionZh =
		typeof raw["descriptionZh"] === "string" && raw["descriptionZh"] !== "" ? raw["descriptionZh"] : undefined;
	const descriptionEn =
		typeof raw["descriptionEn"] === "string" && raw["descriptionEn"] !== "" ? raw["descriptionEn"] : undefined;
	const creditMultiplier = parseWorkBuddyCreditMultiplier(raw["credits"]);
	const reasoning = parseWorkBuddyReasoning(raw["reasoning"]);
	const supportsToolCall = typeof raw["supportsToolCall"] === "boolean" ? raw["supportsToolCall"] : undefined;
	// `disabledMultimodal: true` is a hard veto whenever `supportsImages` is true.
	// That pair has not been seen to conflict on live data, so the veto is
	// defensive; it only decides which way to lean if upstream ever does.
	const supportsImages =
		raw["disabledMultimodal"] === true
			? false
			: typeof raw["supportsImages"] === "boolean"
				? raw["supportsImages"]
				: undefined;
	return {
		id,
		name,
		contextWindow: input,
		maxTokens: output,
		...(creditMultiplier === undefined ? {} : { creditMultiplier }),
		...(supportsImages === undefined ? {} : { supportsImages }),
		...(reasoning === undefined ? {} : { reasoning }),
		...(descriptionZh === undefined ? {} : { descriptionZh }),
		...(descriptionEn === undefined ? {} : { descriptionEn }),
		...(supportsToolCall === undefined ? {} : { supportsToolCall }),
	};
}

/**
 * Select the chat-capable roster from a catalog document.
 *
 * The desktop config lists the CLI channel's own agent next to the full model
 * list; the chat path can only use what that agent declares, so when a `cli`
 * agent exists its `models` array is the roster. Falling back to the full list
 * keeps the provider usable on a config that carries no agent section.
 */
export function selectWorkBuddyRoster(data: unknown): WorkBuddyModelInfo[] {
	if (!isRecord(data)) return [];
	const rows = Array.isArray(data["models"]) ? data["models"] : [];
	const parsed = rows
		.map((row) => parseWorkBuddyModel(row))
		.filter((model): model is WorkBuddyModelInfo => model !== undefined);
	const agents = Array.isArray(data["agents"]) ? data["agents"] : [];
	const cli = agents.find((agent) => isRecord(agent) && agent["description"] === "cli agent");
	if (isRecord(cli) && Array.isArray(cli["models"])) {
		const wanted = new Set(cli["models"].filter((id): id is string => typeof id === "string"));
		const selected = parsed.filter((model) => wanted.has(model.id));
		if (selected.length > 0) return selected;
	}
	return parsed;
}

/** Fetch the account's model roster for one credential. */
export async function fetchWorkBuddyCatalog(
	credential: WorkBuddyCredential,
	signal?: AbortSignal,
	onFallback?: (message: string) => void,
): Promise<WorkBuddyModelInfo[]> {
	const base = workbuddyChatBase(credential);
	const read = async (path: string): Promise<WorkBuddyModelInfo[]> => {
		const response = await fetch(`${base}${path}`, {
			headers: {
				Authorization: `Bearer ${credential.accessToken}`,
				Accept: "application/json",
				...(credential.uid === "" ? {} : { "X-User-Id": credential.uid }),
				...(credential.domain === "" ? {} : { "X-Domain": credential.domain }),
				"X-Product": "SaaS",
				"X-Requested-With": "XMLHttpRequest",
				Connection: "close",
				"User-Agent": CLIENT_UA,
			},
			...(signal === undefined ? {} : { signal }),
		});
		const envelope = await readEnvelope(response, 1024 * 1024);
		const roster = selectWorkBuddyRoster(envelope.data);
		if (roster.length === 0) throw new Error("WorkBuddy model catalog listed no usable models");
		return roster;
	};
	try {
		return await read(CONFIG_PATH);
	} catch (error: unknown) {
		if (signal?.aborted === true) throw error;
		onFallback?.(
			`WorkBuddy catalog ${CONFIG_PATH} failed; falling back to ${LEGACY_MODELS_PATH}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return read(LEGACY_MODELS_PATH);
	}
}

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

function numberField(data: Record<string, unknown>, key: string): number {
	return typeof data[key] === "number" ? (data[key] as number) : 0;
}

/** A numeric field, or undefined when the key is absent or not a number. */
function optionalNumberField(data: Record<string, unknown>, key: string): number | undefined {
	return typeof data[key] === "number" ? (data[key] as number) : undefined;
}

/** Query today's check-in status without changing account state. */
export async function fetchWorkBuddyCheckinStatus(
	credential: WorkBuddyCredential,
	signal?: AbortSignal,
): Promise<WorkBuddyCheckinStatus> {
	const response = await fetch(`${workbuddyBillingBase(credential)}${WORKBUDDY_CHECKIN_STATUS_PATH}`, {
		method: "POST",
		headers: workbuddyBillingHeaders(credential),
		body: "{}",
		signal: signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS),
	});
	const envelope = await readEnvelope(response);
	const data = isRecord(envelope.data) ? envelope.data : {};
	return {
		active: data["active"] === true,
		todayCheckedIn: data["today_checked_in"] === true,
		streakDays: numberField(data, "streak_days"),
		dailyCredit: numberField(data, "daily_credit"),
		todayCredit: numberField(data, "today_credit"),
		isStreakDay: data["is_streak_day"] === true,
		nextStreakDay: numberField(data, "next_streak_day"),
		streakBonusDays: numberField(data, "streak_bonus_days"),
		streakBonusCredit: numberField(data, "streak_bonus_credit"),
		...(typeof data["claim_button_text"] === "string" && data["claim_button_text"] !== ""
			? { claimButtonText: data["claim_button_text"] }
			: {}),
	};
}

/**
 * Claim today's check-in reward.
 *
 * This is a REAL grant on the user's account and is therefore only ever called
 * from an explicit user action, never from a timer: the caller must read
 * {@link fetchWorkBuddyCheckinStatus} first and skip the claim when
 * `todayCheckedIn` is already true.
 */
export async function claimWorkBuddyCheckin(
	credential: WorkBuddyCredential,
	signal?: AbortSignal,
): Promise<WorkBuddyCheckinClaim> {
	const response = await fetch(`${workbuddyBillingBase(credential)}${WORKBUDDY_CHECKIN_CLAIM_PATH}`, {
		method: "POST",
		headers: workbuddyBillingHeaders(credential),
		body: "{}",
		signal: signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS),
	});
	const envelope = await readEnvelope(response);
	const data = isRecord(envelope.data) ? envelope.data : {};
	return {
		credit: numberField(data, "credit"),
		streakDays: numberField(data, "streak_days"),
		isStreakDay: data["is_streak_day"] === true,
	};
}

/**
 * POST the token-refresh endpoint.
 *
 * The response is merged by the caller; `expiresIn` is in SECONDS, which is the
 * upstream's own unit and unlike the millisecond stamps in the auth document.
 */
export async function refreshWorkBuddyToken(
	credential: WorkBuddyCredential,
	signal?: AbortSignal,
): Promise<WorkBuddyRefreshOutcome> {
	const response = await fetch(`${workbuddyChatBase(credential)}${WORKBUDDY_REFRESH_PATH}`, {
		method: "POST",
		headers: workbuddyRefreshHeaders(credential),
		signal: signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS),
	});
	const envelope = await readEnvelope(response);
	const data = isRecord(envelope.data) ? envelope.data : {};
	const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
	if (accessToken === "") {
		throw new Error("WorkBuddy token refresh returned no accessToken; sign in again in the WorkBuddy app");
	}
	return {
		accessToken,
		...(typeof data["refreshToken"] === "string" && data["refreshToken"] !== ""
			? { refreshToken: data["refreshToken"] }
			: {}),
		...(typeof data["expiresIn"] === "number" && data["expiresIn"] > 0 ? { expiresInSec: data["expiresIn"] } : {}),
		...(typeof data["domain"] === "string" && data["domain"] !== "" ? { domain: data["domain"] } : {}),
	};
}

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

/** The upstream's marker for a monthly-cycle package. */
const MONTHLY_CAPACITY_TYPE = 4;

/**
 * Whether a package is a monthly-cycle one, whose CURRENT CYCLE figures are what
 * the user watches. Everything else is a one-off gift spending down its total.
 */
export function isWorkBuddyMonthlyPackage(capacityType: number): boolean {
	return capacityType === MONTHLY_CAPACITY_TYPE;
}

/** Format a date the way the billing body expects (local time, not ISO). */
function formatBillingTime(date: Date): string {
	const pad = (value: number): string => value.toString().padStart(2, "0");
	const day = [date.getFullYear().toString().padStart(4, "0"), pad(date.getMonth() + 1), pad(date.getDate())].join("-");
	return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Read the remaining credit, keeping every package separate.
 *
 * The response is triple-nested PascalCase (`data.Response.Data.Accounts`), so
 * each level is unwrapped defensively rather than assumed.
 */
export async function fetchWorkBuddyCredits(
	credential: WorkBuddyCredential,
	signal?: AbortSignal,
): Promise<WorkBuddyCredits> {
	const now = new Date();
	const response = await fetch(`${workbuddyBillingBase(credential)}${WORKBUDDY_CREDITS_PATH}`, {
		method: "POST",
		headers: workbuddyBillingHeaders(credential),
		body: JSON.stringify({
			PageNumber: 1,
			PageSize: 100,
			ProductCode: CREDITS_PRODUCT_CODE,
			Status: [0, 3],
			PackageEndTimeRangeBegin: formatBillingTime(now),
			PackageEndTimeRangeEnd: formatBillingTime(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
		}),
		signal: signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS),
	});
	const envelope = await readEnvelope(response);
	const data = isRecord(envelope.data) ? envelope.data : {};
	const body = isRecord(data["Response"]) ? (data["Response"] as Record<string, unknown>) : {};
	const inner = isRecord(body["Data"]) ? (body["Data"] as Record<string, unknown>) : {};
	const rows = Array.isArray(inner["Accounts"]) ? inner["Accounts"] : [];
	const packages: WorkBuddyCreditPackage[] = [];
	for (const row of rows) {
		if (!isRecord(row)) continue;
		const capacityType = numberField(row, "CapacityType");
		const monthly = isWorkBuddyMonthlyPackage(capacityType);
		// A monthly package's real spend lives in the CYCLE counters; its
		// package-level `CapacityRemain` stays at the full allocation, so reading it
		// would report an untouched month as an unspent one. The cycle keys are
		// preferred but not assumed: when the upstream omits them, the package-level
		// figures still beat reporting zero. `Dosage`/`TotalDosage` are envelope
		// aggregates across packages, never read here.
		const remainingRaw = monthly
			? (optionalNumberField(row, "CycleCapacityRemain") ?? numberField(row, "CapacityRemain"))
			: numberField(row, "CapacityRemain");
		const capacityTotal = monthly
			? (optionalNumberField(row, "CycleCapacitySize") ?? numberField(row, "CapacitySize"))
			: numberField(row, "CapacitySize");
		packages.push({
			accountId: numberField(row, "AccountId"),
			dealName: typeof row["DealName"] === "string" ? row["DealName"] : "",
			...(typeof row["PackageName"] === "string" && row["PackageName"] !== ""
				? { packageName: row["PackageName"] }
				: {}),
			capacityType,
			capacityUnit: typeof row["CapacityUnit"] === "string" ? row["CapacityUnit"] : "",
			// A negative remainder is the upstream's "overdrawn" spelling; the user
			// has nothing left either way, so it reads as zero.
			remaining: remainingRaw < 0 ? 0 : remainingRaw,
			total: capacityTotal,
			monthly,
			...(typeof row["CycleStartTime"] === "string" && row["CycleStartTime"] !== ""
				? { cycleStartTime: row["CycleStartTime"] }
				: {}),
			...(typeof row["CycleEndTime"] === "string" && row["CycleEndTime"] !== ""
				? { cycleEndTime: row["CycleEndTime"] }
				: {}),
			...(typeof row["ExpiredTime"] === "string" && row["ExpiredTime"] !== ""
				? { expiredTime: row["ExpiredTime"] }
				: {}),
		});
	}
	return {
		totalCount: numberField(inner, "TotalCount"),
		totalRemaining: packages.reduce((sum, entry) => sum + entry.remaining, 0),
		packages,
	};
}

/** Whether a value is a plain object (used by the body normalizer). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Guarantee the conversation OPENS with a system message.
 *
 * The international gateway refuses a user-first body with business code
 * `11128`, and a system message can go missing before this module sees the body:
 * `dsh-llm-pi-ai` folds a leading `system` message into `Context.systemPrompt`,
 * and pi-ai only emits that prompt when it is non-empty. By the time the body is
 * on the wire the real prompt is no longer recoverable, and a minimal
 * placeholder is strictly better than a guaranteed 400.
 */
function ensureSystemHead(obj: Record<string, unknown>): void {
	const messages = obj["messages"];
	if (!Array.isArray(messages) || messages.length === 0) return;
	const head = messages[0];
	if (!isPlainObject(head)) return;
	const role = head["role"];
	if (typeof role === "string" && role.trim().toLowerCase() === "system") return;
	messages.unshift({ role: "system", content: WORKBUDDY_FALLBACK_SYSTEM_PROMPT });
}

/**
 * Flatten `tool_choice` to the bare string the gateway accepts.
 *
 * The upstream's field is a string; object forms are a 400, and
 * `tool_choice: "none"` must also remove the declarations, since the gateway
 * ignores the choice once `tools` are present.
 */
function normalizeToolChoice(obj: Record<string, unknown>): void {
	const suppress = (): void => {
		delete obj["tools"];
		delete obj["functions"];
	};
	if (!("tool_choice" in obj)) return;
	const choice: unknown = obj["tool_choice"];
	if (typeof choice === "string") {
		if (choice.trim().toLowerCase() === "none") {
			delete obj["tool_choice"];
			suppress();
		}
		return;
	}
	if (isPlainObject(choice)) {
		const type = typeof choice["type"] === "string" ? choice["type"].trim().toLowerCase() : "";
		if (type === "none") {
			delete obj["tool_choice"];
			suppress();
		} else if (type === "auto" || type === "required") {
			obj["tool_choice"] = type;
		} else if (type === "function") {
			const fn = isPlainObject(choice["function"]) ? (choice["function"] as Record<string, unknown>) : undefined;
			let name = typeof fn?.["name"] === "string" ? fn["name"] : "";
			if (name === "" && typeof choice["name"] === "string") name = choice["name"];
			name = name.trim();
			obj["tool_choice"] = name !== "" ? name : "auto";
		} else {
			delete obj["tool_choice"];
		}
		return;
	}
	delete obj["tool_choice"];
}

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
export function prepareWorkBuddyChatBody(source: string): string {
	let body: unknown;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (!isPlainObject(body)) return source;
	const obj = body;
	obj["stream"] = true;
	if (Array.isArray(obj["messages"])) {
		for (const value of obj["messages"]) {
			if (!isPlainObject(value)) continue;
			if (value["role"] === "developer") value["role"] = "system";
		}
	}
	ensureSystemHead(obj);
	normalizeToolChoice(obj);
	return JSON.stringify(obj);
}
