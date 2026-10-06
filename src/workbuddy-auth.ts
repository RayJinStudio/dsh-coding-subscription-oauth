/**
 * WorkBuddy credential discovery, parsing, ranking, refresh and persistence.
 *
 * The WorkBuddy desktop app signs the user in; this plugin never starts its own
 * OAuth flow. It reads the app's own auth document, which may be plaintext or
 * (desktop 5.6.0+) have its token fields sealed with the app's at-rest key —
 * see {@link ./workbuddy-at-rest.ts}.
 *
 * Two properties are load-bearing and worth stating up front:
 *
 *  1. **The desktop file is read-only.** Every write targets this plugin's own
 *     copy under `$DSH_HOME`, never the vendor's file. Logging out removes only
 *     the plugin's copy, so the desktop app stays signed in.
 *  2. **The live file always outranks its backups.** A revoked backup keeps a
 *     far-future `expiresAt`, so ranking by expiry alone picks a dead token and
 *     signs the user out of a working account. The app's own issuance stamp
 *     (`lastRefreshTime`) is the tie-breaker that makes this correct.
 *
 * Provenance: the discovery order, the two accepted document shapes, the
 * `hasEncryptedCredentialFields` gate, the ranking rule and the refresh
 * protocol are a port of `dingminhua/dsh-connect-workbuddy` (MIT, Copyright (c)
 * 2026 LaoDing), re-verified against a live desktop install (5.7.3).
 *
 * @module dsh-coding-subscription-oauth/workbuddy-auth
 */

import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { isEncryptedFieldWrapper, openEncryptedField, readAtRestKey } from "./workbuddy-at-rest.ts";

/** Region of a WorkBuddy account, derived from the credential's `domain`. */
export type WorkBuddyRegion = "cn" | "global";

/** Legacy plugin-owned single-copy basename (pre region split); migration source. */
export const WORKBUDDY_AUTH_FILENAME = ".workbuddy-auth.json";

/** Env variable that overrides the desktop auth-file location. */
export const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";

/** Basename of the live WorkBuddy desktop auth file. */
const WORKBUDDY_LIVE_FILENAME = "workbuddy-desktop.info";

/** Prefix of the plugin-owned per-region credential copies. */
const WORKBUDDY_OWN_PREFIX = ".workbuddy-auth";

/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1 as const;

/**
 * Region of a WorkBuddy credential, from its `domain`.
 *
 * A total predicate: everything that is not one of the two international brand
 * domains (exact or subdomain) is `cn`, including the empty string. The
 * `codebuddy.ai` spelling matters — a token issued there is rejected by the
 * `workbuddy.ai` gateway and vice versa, so the region decides the host, not
 * just a label.
 */
export function workbuddyRegionOf(domain: string): WorkBuddyRegion {
	const lowered = domain.trim().toLowerCase();
	if (lowered === "workbuddy.ai" || lowered.endsWith(".workbuddy.ai")) return "global";
	if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) return "global";
	return "cn";
}

/** A normalized WorkBuddy credential; timestamps are epoch milliseconds. */
export interface WorkBuddyCredential {
	accessToken: string;
	refreshToken: string;
	expiresAtMs: number;
	refreshExpiresAtMs?: number;
	domain: string;
	uid: string;
	enterpriseId?: string;
	nickname?: string;
	uin?: string;
	/** Which auth file this came from; a refreshed credential is always `dsh`. */
	source: "desktop" | "dsh";
	/** Absolute path of the auth file this credential was read from. */
	filePath: string;
	/**
	 * Epoch ms the upstream last issued this token (`auth.lastRefreshTime`).
	 * The only trustworthy freshness signal: a revoked backup keeps a far-future
	 * `expiresAt`, so expiry alone cannot order two candidates.
	 */
	lastRefreshAtMs?: number;
}

/** Why one candidate file yielded no credential. */
export type WorkBuddyCandidateReason = "missing" | "unreadable" | "invalid" | "encrypted" | "wrong-region";

/** A candidate file that produced no credential, with its reason. */
export interface WorkBuddyCandidateFailure {
	path: string;
	source: "desktop" | "dsh";
	reason: WorkBuddyCandidateReason;
	message?: string;
}

/** Secret-free discovery diagnostic: every path consulted plus the failures. */
export interface WorkBuddyAuthDiagnosis {
	tried: readonly string[];
	failures: readonly WorkBuddyCandidateFailure[];
}

/** One selectable account. Carries no token material. */
export interface WorkBuddyAccountChoice {
	id: string;
	/** Display name; the nickname when the document has one, else empty. */
	accountName: string;
	domain: string;
	source: "desktop" | "dsh";
	tokenExpiresAtMs: number;
	filePath: string;
	selected: boolean;
}

/** Secret-free auth status. */
export interface WorkBuddyAuthStatus {
	state: "signed-in" | "signed-out";
	expiresAtMs?: number;
	refreshExpiresAtMs?: number;
	nickname?: string;
	/** Omitted when empty. */
	domain?: string;
	region?: WorkBuddyRegion;
	source?: "desktop" | "dsh";
}

/**
 * One auth file the store can read, as the settings UI needs it.
 *
 * `displayPath` is secret-free and home-relative so a screenshot cannot leak the
 * operator's absolute layout, while `path` is the exact value a switch writes.
 */
export interface WorkBuddyCandidateFile {
	/** Absolute path, for the switch request. */
	path: string;
	/** Home-relative rendering, for display. */
	displayPath: string;
	source: "desktop" | "dsh";
	/** Whether this file is currently in the probe path. */
	active: boolean;
	/** Whether it yielded a readable credential. */
	readable: boolean;
	/** Region of the credential it holds, when readable. */
	region?: WorkBuddyRegion;
	accountName?: string;
	tokenExpiresAtMs?: number;
	/** Why it yielded nothing, when not readable. */
	reason?: WorkBuddyCandidateReason;
	message?: string;
}

/** Outcome of a token refresh; seconds are the upstream's own unit. */
export interface WorkBuddyRefreshOutcome {
	accessToken: string;
	refreshToken?: string;
	expiresInSec?: number;
	domain?: string;
}

/** Raised when a stored credential exists but cannot be read without the app. */
export const ENCRYPTED_CREDENTIAL_CODE = "WORKBUDDY_ENCRYPTED_CREDENTIAL";

/**
 * A desktop document whose token fields are sealed and whose at-rest key could
 * not be obtained. Deliberately distinct from an invalid document: the user is
 * signed in, and telling them to sign in again cannot help.
 */
export class WorkBuddyEncryptedCredentialError extends Error {
	readonly code = ENCRYPTED_CREDENTIAL_CODE;
	constructor(readonly paths: readonly string[]) {
		super(
			`WorkBuddy stores its credentials encrypted and the desktop app did not provide the at-rest key` +
				` (checked: ${paths.join(", ")}). Install or start the WorkBuddy desktop app, or set` +
				` WORKBUDDY_APP_EXECUTABLE to its executable. Signing in again will not change this.`,
		);
		this.name = "WorkBuddyEncryptedCredentialError";
	}
}

/** Whether an error is the encrypted-credential condition; code-based, not `instanceof`. */
export function isWorkBuddyEncryptedCredentialError(value: unknown): value is WorkBuddyEncryptedCredentialError {
	return (
		typeof value === "object" && value !== null && (value as { code?: unknown }).code === ENCRYPTED_CREDENTIAL_CODE
	);
}

/** A non-empty, trimmed env value, or undefined when unset/blank. */
function nonEmptyEnv(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Platform-default directories holding the WorkBuddy desktop app's auth file.
 *
 * Windows and Linux prefer the OS-issued env location and fall back to the
 * home-derived convention when it is unset or blank, so a redirected profile
 * (OneDrive folder backup, enterprise policy) still resolves. macOS has no
 * equivalent env variable; the single Application Support path is used as-is.
 *
 * Windows has exactly ONE location, not two: the app's own
 * `getSharedAuthDirectory()` resolves the auth directory to
 * `<home>\AppData\Local\CodeBuddyExtension\Data\Public\auth` and never consults
 * `%APPDATA%\Roaming`. A Roaming candidate used to be probed here because the
 * reference implementation carried one; it was convention-derived, never
 * observed on real hardware, and its only visible effect was a permanent
 * `not readable (missing)` row in the credential-file list. The redirect
 * protection lives entirely in the `%LOCALAPPDATA%`-first lookup below, which
 * this removal does not touch.
 */
export function defaultDesktopAuthDirs(
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	if (platform === "darwin") {
		return [join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth")];
	}
	if (platform === "win32") {
		const local = nonEmptyEnv(env["LOCALAPPDATA"]) ?? join(home, "AppData", "Local");
		return [join(local, "CodeBuddyExtension", "Data", "Public", "auth")];
	}
	if (platform === "linux") {
		const config = nonEmptyEnv(env["XDG_CONFIG_HOME"]) ?? join(home, ".config");
		return [join(config, "CodeBuddyExtension", "Data", "Public", "auth")];
	}
	return [];
}

/** The live auth file's platform candidates, in probe order. */
export function defaultDesktopAuthCandidates(
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	return defaultDesktopAuthDirs(platform, home, env).map((dir) => join(dir, WORKBUDDY_LIVE_FILENAME));
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
export function expiryToMs(value: number): number {
	if (value <= 0) return 0;
	return value > 1e12 ? value : value * 1000;
}

/**
 * Resolve one string field, transparently opening the app's encrypted-field
 * wrapper when present.
 *
 * `key` is undefined when the at-rest key could not be obtained, in which case
 * an encrypted field resolves to undefined rather than a fabricated value.
 */
function credentialField(value: unknown, key: Buffer | undefined): string | undefined {
	if (typeof value === "string") return value;
	if (!isEncryptedFieldWrapper(value)) return undefined;
	if (key === undefined) return undefined;
	return openEncryptedField(value, key);
}

/**
 * An optional field that may legitimately be absent: an absent value, a
 * non-string that is not a wrapper, and an unopenable wrapper all mean
 * "unknown", which must not fail the whole document.
 *
 * `account.phoneNumber` is deliberately never read: it is encrypted in these
 * builds and is none of the plugin's business.
 */
function optionalCredentialField(value: unknown, key: Buffer | undefined): string | undefined {
	if (typeof value === "string") return value === "" ? undefined : value;
	if (!isEncryptedFieldWrapper(value)) return undefined;
	if (key === undefined) return undefined;
	try {
		return openEncryptedField(value, key);
	} catch {
		return undefined;
	}
}

/**
 * Parse a WorkBuddy auth document in either on-disk shape: the nested form
 * `{"auth":{...},"account":{...}}` and the flat panel form. Returns undefined
 * when the document carries no readable access token.
 */
export function parseWorkBuddyAuth(
	text: string,
	filePath: string,
	atRestKey?: Buffer,
): WorkBuddyCredential | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const document = parsed as Record<string, unknown>;
	const auth =
		typeof document["auth"] === "object" && document["auth"] !== null
			? (document["auth"] as Record<string, unknown>)
			: document;
	const identity =
		typeof document["account"] === "object" && document["account"] !== null
			? (document["account"] as Record<string, unknown>)
			: document;
	let accessToken: string | undefined;
	let refreshToken: string | undefined;
	try {
		accessToken = credentialField(auth["accessToken"], atRestKey);
		refreshToken = credentialField(auth["refreshToken"], atRestKey);
	} catch {
		// A malformed envelope, a key mismatch, or a failed authentication tag is
		// "this document is not readable", exactly like an absent token — it must
		// never surface as a half-decrypted credential.
		return undefined;
	}
	if (accessToken === undefined || accessToken === "") return undefined;
	const expiresAtMs = typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0;
	const refreshExpiresAtMs =
		typeof auth["refreshExpiresAt"] === "number" ? expiryToMs(auth["refreshExpiresAt"]) : undefined;
	const lastRefreshAtMs = typeof auth["lastRefreshTime"] === "number" ? expiryToMs(auth["lastRefreshTime"]) : undefined;
	const enterpriseId = optionalCredentialField(identity["enterpriseId"], atRestKey);
	const nickname = optionalCredentialField(identity["nickname"], atRestKey);
	const uin = optionalCredentialField(identity["uin"], atRestKey);
	return {
		accessToken,
		refreshToken: refreshToken ?? "",
		expiresAtMs,
		...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
		domain: optionalCredentialField(auth["domain"], atRestKey) ?? "",
		uid: optionalCredentialField(identity["uid"], atRestKey) ?? "",
		...(enterpriseId === undefined ? {} : { enterpriseId }),
		...(nickname === undefined ? {} : { nickname }),
		...(uin === undefined ? {} : { uin }),
		...(lastRefreshAtMs === undefined ? {} : { lastRefreshAtMs }),
		source: "desktop",
		filePath,
	};
}

/**
 * Whether a document carries any field the reader must decrypt. Deciding this
 * BEFORE asking the app for its key keeps the plain case (and every
 * plugin-owned copy) from paying for a child process on every read.
 */
export function hasEncryptedCredentialFields(text: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return false;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
	const document = parsed as Record<string, unknown>;
	const auth =
		typeof document["auth"] === "object" && document["auth"] !== null
			? (document["auth"] as Record<string, unknown>)
			: document;
	const identity =
		typeof document["account"] === "object" && document["account"] !== null
			? (document["account"] as Record<string, unknown>)
			: document;
	return (
		isEncryptedFieldWrapper(auth["accessToken"]) ||
		isEncryptedFieldWrapper(auth["refreshToken"]) ||
		isEncryptedFieldWrapper(identity["nickname"]) ||
		isEncryptedFieldWrapper(identity["uin"]) ||
		isEncryptedFieldWrapper(identity["uid"]) ||
		isEncryptedFieldWrapper(identity["enterpriseId"]) ||
		isEncryptedFieldWrapper(auth["domain"])
	);
}

/** Filename of a path regardless of the host separator. */
export function authFileName(path: string): string {
	const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return separator === -1 ? path : path.slice(separator + 1);
}

/**
 * A home-relative rendering of an auth path, for display.
 *
 * The operator's home directory is personal data, so a path under it renders as
 * `~/…`; anything else is shown as-is rather than being hidden, because a path
 * the user chose outside their home is exactly what they need to recognize.
 */
export function displayAuthPath(path: string, home: string = homedir()): string {
	const normalized = path.replace(/\\/gu, "/");
	const normalizedHome = home.replace(/\\/gu, "/").replace(/\/+$/u, "");
	if (normalizedHome !== "" && (normalized === normalizedHome || normalized.startsWith(`${normalizedHome}/`))) {
		return `~${normalized.slice(normalizedHome.length)}`;
	}
	return path;
}

/**
 * Stable account id. `uin` is the billing identity the upstream keys on and
 * survives across re-login; `uid` is the fallback for documents without one.
 *
 * A BLANK identifier is treated as absent rather than as a value: `??` alone
 * would let an empty `uin` win the chain, which collapses every such account
 * onto one id and makes two different sign-ins indistinguishable. The parser
 * already normalizes empty optional fields to undefined, so this is a belt on
 * top of that braces.
 */
export function workbuddyAccountId(credential: Pick<WorkBuddyCredential, "uin" | "uid" | "nickname">): string {
	const firstNonBlank = [credential.uin, credential.uid, credential.nickname].find(
		(value): value is string => typeof value === "string" && value.trim() !== "",
	);
	return createHash("sha256")
		.update(`workbuddy\0${firstNonBlank ?? "unknown"}`)
		.digest("hex")
		.slice(0, 24);
}

/** Plugin-owned copy path for one region inside the Harness home. */
export function workbuddyOwnAuthPath(region: WorkBuddyRegion, dshHome?: string): string {
	return join(resolveDshHome(dshHome), `${WORKBUDDY_OWN_PREFIX}.${region}.json`);
}

/** Pre-region-split single-copy path; read as a migration source, removed by logout. */
export function legacyWorkbuddyOwnAuthPath(dshHome?: string): string {
	return join(resolveDshHome(dshHome), WORKBUDDY_AUTH_FILENAME);
}

interface OwnDocument {
	version: typeof OWN_FORMAT_VERSION;
	accountId?: string;
	credential: WorkBuddyCredential;
}

function isENOENT(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Serialize the plugin-owned copy. */
function ownDocument(credential: WorkBuddyCredential, accountId: string | undefined): OwnDocument {
	return {
		version: OWN_FORMAT_VERSION,
		...(accountId === undefined ? {} : { accountId }),
		credential,
	};
}

/** Parse the plugin-owned copy; other versions and shapes are rejected. */
function parseOwnDocument(text: string, filePath: string): WorkBuddyCredential | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const document = parsed as Record<string, unknown>;
	if (document["version"] !== OWN_FORMAT_VERSION) return undefined;
	if (typeof document["credential"] !== "object" || document["credential"] === null) return undefined;
	const credential = parseWorkBuddyAuth(JSON.stringify({ auth: document["credential"] }), filePath);
	if (credential === undefined) return undefined;
	return { ...credential, source: "dsh" };
}

/** One candidate file's probe result: the credential it yielded, or why it did not. */
type AuthFileProbe =
	| { credential: WorkBuddyCredential }
	| { failure: Omit<WorkBuddyCandidateFailure, "path" | "source"> };

/** Whether `text` is parseable JSON at all, to separate "bad JSON" from "no token". */
function isParseableJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * Probe one auth file, reporting WHY it yielded no credential.
 *
 * The plain read is tried first and the app is only asked for its at-rest key
 * when the document actually carries encrypted wrappers, so the common case
 * costs no child process. `resolveAtRestKey` is injectable so the encrypted path
 * is testable without a real desktop install.
 */
async function probeAuthFile(
	path: string,
	resolveAtRestKey: () => Promise<Buffer | undefined>,
): Promise<AuthFileProbe> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error: unknown) {
		const missing = isENOENT(error);
		return {
			failure: {
				reason: missing ? "missing" : "unreadable",
				// An ENOENT message repeats the path, and the card already prints the
				// path on its own line. A genuine read error says something the reason
				// alone does not, so only that one is kept.
				...(missing ? {} : { message: error instanceof Error ? error.message : String(error) }),
			},
		};
	}
	const plain = parseWorkBuddyAuth(text, path);
	if (plain !== undefined) return { credential: plain };
	// Not plain-readable. Distinguish "the app encrypted this and we could not
	// open it" from "this document is simply not a credential": only the former
	// deserves the encrypted-specific advice.
	if (!hasEncryptedCredentialFields(text)) {
		return {
			failure: isParseableJson(text)
				? { reason: "invalid", message: "no access token in the document" }
				: { reason: "invalid", message: "the file is not valid JSON" },
		};
	}
	let key: Buffer | undefined;
	try {
		key = await resolveAtRestKey();
	} catch (error: unknown) {
		return {
			failure: { reason: "encrypted", message: error instanceof Error ? error.message : String(error) },
		};
	}
	if (key === undefined) {
		return { failure: { reason: "encrypted", message: "the WorkBuddy desktop app was not found" } };
	}
	const opened = parseWorkBuddyAuth(text, path, key);
	if (opened === undefined) {
		return { failure: { reason: "invalid", message: "the encrypted credential could not be opened" } };
	}
	return { credential: opened };
}

/**
 * Rank two candidate files for the same account.
 *
 * The live `workbuddy-desktop.info` always wins: it is the app's current
 * sign-in, and the upstream revokes the tokens in the timestamped backups even
 * though their stored `expiresAt` is still in the future.
 */
function fileRank(path: string): number {
	return authFileName(path) === WORKBUDDY_LIVE_FILENAME ? 0 : 1;
}

/**
 * Whether `candidate` is a better pick than `incumbent` for the same account.
 *
 * Ordering, strongest signal first: the live file; then the most recent
 * `lastRefreshAtMs` (the upstream's own issuance time); then `expiresAtMs`, only
 * as a fallback for documents that omit the record. Step two is what makes this
 * correct — a revoked backup keeps a far-future `expiresAt` and would otherwise
 * outrank the working live credential.
 */
function isFresher(candidate: WorkBuddyCredential, incumbent: WorkBuddyCredential): boolean {
	const rankDiff = fileRank(candidate.filePath) - fileRank(incumbent.filePath);
	if (rankDiff !== 0) return rankDiff < 0;
	const candidateRefresh = candidate.lastRefreshAtMs;
	const incumbentRefresh = incumbent.lastRefreshAtMs;
	if (candidateRefresh !== undefined && incumbentRefresh !== undefined) {
		if (candidateRefresh !== incumbentRefresh) return candidateRefresh > incumbentRefresh;
	} else if (candidateRefresh !== undefined) {
		// A file that records its issuance time outranks one that does not.
		return true;
	} else if (incumbentRefresh !== undefined) {
		return false;
	}
	return candidate.expiresAtMs > incumbent.expiresAtMs;
}

/** Sortable owner-preference key, so two regions never share one cached file. */
export function workbuddyCredentialKey(credential: WorkBuddyCredential): string {
	return `${workbuddyRegionOf(credential.domain)}\0${workbuddyAccountId(credential)}`;
}

/** Options for one region-scoped credential store. */
export interface WorkBuddyStoreOptions {
	/** Restrict discovery to one region; undefined accepts either. */
	region?: WorkBuddyRegion;
	/** Override the desktop auth file; else {@link WORKBUDDY_AUTH_FILE_ENV}, else defaults. */
	desktopPath?: string;
	/** Override the plugin-owned copy path. */
	ownPath?: string;
	/** Override the legacy plugin-owned copy path. */
	legacyOwnPath?: string;
	/** Replace the platform directory list entirely. */
	authDirs?: readonly string[];
	/** Refresh protocol; required, because only the host knows the gateway. */
	refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>;
	/** Refresh this long before expiry. Defaults to five minutes. */
	refreshMarginMs?: number;
	/** Injectable at-rest key reader, so the encrypted path is testable. */
	resolveAtRestKey?: () => Promise<Buffer | undefined>;
	platform?: NodeJS.Platform;
	home?: string;
	env?: NodeJS.ProcessEnv;
}

const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** A token with at least this much validity is still usable after a failed refresh. */
const USABLE_AFTER_FAILED_REFRESH_MS = 30_000;

/**
 * One region's WorkBuddy credential owner.
 *
 * Reads the desktop app's sign-in (read-only) plus this plugin's own refreshed
 * copy, picks the freshest per account, and refreshes on demand under a
 * single-flight so concurrent requests cannot each spend a refresh.
 */
export class WorkBuddyCredentialStore {
	private readonly region: WorkBuddyRegion | undefined;
	private readonly refreshMarginMs: number;
	private readonly resolveAtRestKey: () => Promise<Buffer | undefined>;
	private readonly platform: NodeJS.Platform;
	private readonly home: string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly refreshImpl: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>;
	private desktopPath: string | undefined;
	private ownPathOverride: string | undefined;
	private legacyOwnPathOverride: string | undefined;
	private authDirsOverride: readonly string[] | undefined;
	private selectedId: string | undefined;
	private explicitSelection = false;
	private inflight: Promise<WorkBuddyCredential> | undefined;
	private forceRefresh = false;
	private lastKnown: WorkBuddyCredential | undefined;
	private lastFailures: readonly WorkBuddyCandidateFailure[] = [];
	private lastTried: readonly string[] = [];

	constructor(options: WorkBuddyStoreOptions) {
		this.region = options.region;
		this.refreshMarginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
		this.resolveAtRestKey = options.resolveAtRestKey ?? readAtRestKey;
		this.refreshImpl = options.refresh;
		this.platform = options.platform ?? process.platform;
		this.home = options.home ?? homedir();
		this.env = options.env ?? process.env;
		this.desktopPath = options.desktopPath ?? nonEmptyEnv(this.env[WORKBUDDY_AUTH_FILE_ENV]);
		this.ownPathOverride = options.ownPath;
		this.legacyOwnPathOverride = options.legacyOwnPath;
		this.authDirsOverride = options.authDirs;
	}

	/** The plugin-owned copy this store refreshes into. */
	ownAuthPath(): string {
		if (this.ownPathOverride !== undefined) return resolve(this.ownPathOverride);
		return workbuddyOwnAuthPath(this.region ?? "cn");
	}

	private legacyOwnPath(): string {
		return resolve(this.legacyOwnPathOverride ?? legacyWorkbuddyOwnAuthPath());
	}

	/** Override the desktop auth file at runtime (settings-driven). */
	setDesktopPath(path: string | undefined): void {
		this.desktopPath = path === undefined || path.trim() === "" ? undefined : path.trim();
		this.inflight = undefined;
		this.lastKnown = undefined;
	}

	/** The desktop auth-file override currently in force, if any. */
	desktopPathOverride(): string | undefined {
		return this.desktopPath;
	}

	/**
	 * Every auth file this store WOULD read, in probe order, with whether it is
	 * currently in the search path.
	 *
	 * Exists so the UI can offer a file to switch to: the platform defaults alone
	 * miss a redirected profile, a second install, or a file the operator keeps
	 * elsewhere, and without listing them the only way to use one is to know its
	 * path already.
	 *
	 * `overridden` files are reported even when an override is in force, so the
	 * user can see what they switched AWAY from and switch back.
	 */
	async candidateFiles(): Promise<WorkBuddyCandidateFile[]> {
		const effective = new Set(this.desktopCandidates().map((path) => resolve(path)));
		const seen = new Set<string>();
		// Collected as bare identities first; `active`/`readable` are filled in by
		// the probe pass below, so there is exactly one place that decides them.
		const staged: Array<{ path: string; source: "desktop" | "dsh" }> = [];
		const push = (path: string, source: "desktop" | "dsh"): void => {
			const absolute = resolve(path);
			if (seen.has(absolute)) return;
			seen.add(absolute);
			staged.push({ path: absolute, source });
		};
		// The configured/override file first: it is the one in use.
		for (const path of this.desktopCandidates()) {
			push(path, "desktop");
			for (const backup of await this.backupsBeside(path)) push(backup, "desktop");
		}
		// Platform defaults that the current override is masking.
		for (const path of defaultDesktopAuthCandidates(this.platform, this.home, this.env)) {
			if (effective.has(resolve(path))) continue;
			push(path, "desktop");
			for (const backup of await this.backupsBeside(path)) push(backup, "desktop");
		}
		for (const path of this.ownCandidates()) {
			try {
				await stat(path);
			} catch {
				continue;
			}
			push(path, "dsh");
		}
		return Promise.all(
			staged.map(async (entry): Promise<WorkBuddyCandidateFile> => {
				const probe = await probeAuthFile(entry.path, this.resolveAtRestKey);
				const base = {
					...entry,
					displayPath: displayAuthPath(entry.path, this.home),
					active: effective.has(entry.path),
				};
				if ("credential" in probe) {
					const credential = probe.credential;
					return {
						...base,
						readable: true,
						region: workbuddyRegionOf(credential.domain),
						accountName: credential.nickname ?? "",
						tokenExpiresAtMs: credential.expiresAtMs,
					};
				}
				return {
					...base,
					readable: false,
					reason: probe.failure.reason,
					...(probe.failure.message === undefined ? {} : { message: probe.failure.message }),
				};
			}),
		);
	}

	/** Whether the user picked an account explicitly, rather than by freshness. */
	hasExplicitSelection(): boolean {
		return this.explicitSelection;
	}

	/** Select an account by id; `undefined` returns to automatic (freshest) choice. */
	selectAccount(id: string | undefined): void {
		this.selectedId = id === undefined || id === "" ? undefined : id;
		this.explicitSelection = this.selectedId !== undefined;
		this.inflight = undefined;
	}

	selectedAccountId(): string | undefined {
		return this.selectedId;
	}

	/** Every discovered account, best-first within an account. */
	async accounts(): Promise<WorkBuddyAccountChoice[]> {
		const all = await this.readAll();
		const byKey = new Map<string, WorkBuddyCredential>();
		for (const credential of all) {
			const key = workbuddyCredentialKey(credential);
			const incumbent = byKey.get(key);
			if (incumbent === undefined || isFresher(credential, incumbent)) byKey.set(key, credential);
		}
		const chosen = [...byKey.values()].sort(
			(a, b) => (b.lastRefreshAtMs ?? b.expiresAtMs) - (a.lastRefreshAtMs ?? a.expiresAtMs),
		);
		const activeId = this.selectedId;
		return chosen.map((credential) => {
			const id = workbuddyAccountId(credential);
			return {
				id,
				accountName: credential.nickname ?? "",
				domain: credential.domain,
				source: credential.source,
				tokenExpiresAtMs: credential.expiresAtMs,
				filePath: credential.filePath,
				selected: activeId === undefined ? false : activeId === id,
			};
		});
	}

	/** Secret-free discovery diagnostic: every path consulted plus the failures. */
	async diagnose(): Promise<WorkBuddyAuthDiagnosis> {
		await this.readAll();
		return { tried: [...this.lastTried], failures: [...this.lastFailures] };
	}

	/** The credential to send upstream: {@link current}, refreshed on demand. */
	async resolve(): Promise<WorkBuddyCredential> {
		const credential = await this.current();
		if (credential === undefined) throw await this.describeMissingCredential();
		if (!this.needsRefresh(credential)) return credential;
		const forced = this.forceRefresh;
		this.forceRefresh = false;
		this.inflight ??= this.refreshNow(credential, forced).finally(() => {
			this.inflight = undefined;
		});
		return this.inflight;
	}

	/** Secret-free status; never throws. */
	async status(): Promise<WorkBuddyAuthStatus> {
		try {
			const credential = await this.current();
			if (credential === undefined) return { state: "signed-out" };
			return {
				state: "signed-in",
				expiresAtMs: credential.expiresAtMs,
				...(credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs }),
				...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
				...(credential.domain === "" ? {} : { domain: credential.domain }),
				region: workbuddyRegionOf(credential.domain),
				source: credential.source,
			};
		} catch {
			return { state: "signed-out" };
		}
	}

	/** Whether a desktop auth file exists at all, for UI hints. */
	async desktopFilePresent(): Promise<boolean> {
		for (const path of this.desktopCandidates()) {
			try {
				const info = await stat(path);
				if (info.isFile()) return true;
			} catch {
				// Absent is the normal case for most candidates.
			}
		}
		return false;
	}

	/**
	 * Remove this plugin's own copies only.
	 *
	 * The desktop app's file is never touched, so the user stays signed in to the
	 * app and simply re-imports on the next read.
	 */
	async logout(): Promise<void> {
		this.selectedId = undefined;
		this.explicitSelection = false;
		this.inflight = undefined;
		for (const path of [this.ownAuthPath(), this.legacyOwnPath()]) {
			await rm(path, { force: true });
			await rm(`${path}.lock`, { force: true });
		}
	}

	private matchesRegion(domain: string): boolean {
		return this.region === undefined || workbuddyRegionOf(domain) === this.region;
	}

	/** Owned copies, region-scoped first so two regions never collide. */
	private ownCandidates(): string[] {
		const own = this.ownAuthPath();
		const legacy = this.legacyOwnPath();
		if (this.region === undefined) return [legacy, workbuddyOwnAuthPath("cn"), workbuddyOwnAuthPath("global")];
		return [own, legacy];
	}

	private desktopCandidates(): string[] {
		if (this.desktopPath !== undefined) return [resolve(this.desktopPath)];
		if (this.authDirsOverride !== undefined) {
			return this.authDirsOverride.map((dir) => join(dir, WORKBUDDY_LIVE_FILENAME));
		}
		return defaultDesktopAuthCandidates(this.platform, this.home, this.env);
	}

	/**
	 * The live file first, then its `.info` siblings newest-name-first.
	 *
	 * Matching is `name.endsWith('.info')` with no prefix test, because the app
	 * has shipped more than one live filename and a backup is identified by the
	 * timestamp the app embeds, not by a prefix this plugin would have to guess.
	 */
	private async backupsBeside(path: string): Promise<string[]> {
		let entries: string[];
		try {
			entries = await readdir(dirname(path));
		} catch {
			return [];
		}
		const base = authFileName(path);
		return entries
			.filter((name) => name !== base && name.endsWith(".info"))
			.map((name) => join(dirname(path), name))
			.sort()
			.reverse();
	}

	private async readCandidate(
		path: string,
		source: "desktop" | "dsh",
		tried: string[],
		failures: WorkBuddyCandidateFailure[],
	): Promise<WorkBuddyCredential[]> {
		tried.push(path);
		const probe = await probeAuthFile(path, this.resolveAtRestKey);
		if ("credential" in probe) {
			if (!this.matchesRegion(probe.credential.domain)) {
				// A region mismatch is a REPORTED failure, not a silent skip: the
				// card's "paths checked" list must account for a file that parsed.
				failures.push({ path, source, reason: "wrong-region" });
				return [];
			}
			return [probe.credential];
		}
		failures.push({ path, source, ...probe.failure });
		return [];
	}

	/** Every readable credential across the desktop files and the plugin's copies. */
	private async readAll(): Promise<WorkBuddyCredential[]> {
		const tried: string[] = [];
		const failures: WorkBuddyCandidateFailure[] = [];
		const found: WorkBuddyCredential[] = [];

		for (const path of this.desktopCandidates()) {
			// An EXPLICIT selection pins exactly that file. Scanning its siblings
			// anyway would let a sibling's fresher token win, so the user's choice
			// would appear to do nothing — the switch has to mean what it says.
			const candidates = this.desktopPath === undefined ? [path, ...(await this.backupsBeside(path))] : [path];
			for (const candidate of candidates) {
				found.push(...(await this.readCandidate(candidate, "desktop", tried, failures)));
			}
		}
		for (const path of this.ownCandidates()) {
			// An absent owned copy is skipped, never listed: it is the normal
			// state before the first refresh, not a diagnostic.
			try {
				await stat(path);
			} catch {
				continue;
			}
			tried.push(path);
			let text: string;
			try {
				text = await readFile(path, "utf8");
			} catch (error: unknown) {
				failures.push({
					path,
					source: "dsh",
					reason: "unreadable",
					message: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			const credential = parseOwnDocument(text, path);
			if (credential === undefined) {
				failures.push({ path, source: "dsh", reason: "invalid" });
				continue;
			}
			if (!this.matchesRegion(credential.domain)) {
				failures.push({ path, source: "dsh", reason: "wrong-region" });
				continue;
			}
			found.push(credential);
		}

		this.lastTried = tried;
		this.lastFailures = failures;
		return found;
	}

	/**
	 * The credential the next request should use: the explicitly selected account
	 * when there is one, else the freshest. An explicit selection that no longer
	 * exists falls back rather than failing the request, so removing an account
	 * cannot wedge the route.
	 */
	private async current(): Promise<WorkBuddyCredential | undefined> {
		const all = await this.readAll();
		if (all.length === 0) return undefined;
		const best = new Map<string, WorkBuddyCredential>();
		for (const credential of all) {
			const key = workbuddyCredentialKey(credential);
			const incumbent = best.get(key);
			if (incumbent === undefined || isFresher(credential, incumbent)) best.set(key, credential);
		}
		let chosen: WorkBuddyCredential | undefined;
		if (this.selectedId !== undefined) {
			chosen = [...best.values()].find((credential) => workbuddyAccountId(credential) === this.selectedId);
		}
		chosen ??= [...best.values()].sort(
			(a, b) => (b.lastRefreshAtMs ?? b.expiresAtMs) - (a.lastRefreshAtMs ?? a.expiresAtMs),
		)[0];
		// Remembered so the synchronous surfaces (a provider's `getModels` closure,
		// which pi-ai requires to be synchronous) can still answer with the base
		// URL and headers of the account actually in use.
		this.lastKnown = chosen;
		return chosen;
	}

	/**
	 * The credential this store most recently resolved, WITHOUT touching the disk.
	 *
	 * Exists for the synchronous catalog closure a pi-ai provider requires. It is
	 * a cache, not a source of truth: callers that need a fresh or refreshed
	 * credential must use {@link resolve}, which also populates this.
	 */
	peek(): WorkBuddyCredential | undefined {
		return this.lastKnown;
	}

	/** Build the actionable error for "no usable credential". */
	private async describeMissingCredential(): Promise<Error> {
		const encrypted = this.lastFailures.filter((failure) => failure.reason === "encrypted");
		if (encrypted.length > 0) {
			return new WorkBuddyEncryptedCredentialError(encrypted.map((failure) => failure.path));
		}
		const interesting = this.lastFailures.filter((failure) => failure.reason !== "missing");
		const detail =
			interesting.length === 0
				? "no WorkBuddy sign-in was found"
				: interesting.map((failure) => `${failure.path}: ${failure.reason}`).join("; ");
		return new Error(
			`WorkBuddy is not signed in (${detail}). Sign in with the WorkBuddy desktop app;` +
				" the plugin reads that sign-in and never asks for a separate login.",
		);
	}

	private needsRefresh(credential: WorkBuddyCredential): boolean {
		if (this.forceRefresh) return true;
		if (credential.expiresAtMs <= 0) return true;
		return Date.now() + this.refreshMarginMs >= credential.expiresAtMs;
	}

	/**
	 * Force the next {@link resolve} to refresh before use.
	 *
	 * Called after an upstream 401 rejected a token that was still locally valid,
	 * which is the only signal that the stored expiry is wrong. Unlike the OAuth
	 * stores this cannot backdate a file it does not own, so the intent is held in
	 * memory and applied to the next read.
	 */
	async invalidateAccessToken(): Promise<void> {
		this.forceRefresh = true;
		this.inflight = undefined;
	}

	/**
	 * Refresh under a single-flight, tolerating a refresh that fails while the
	 * stored token is still usable.
	 *
	 * A refresh failure with more than 30 seconds of validity left returns the
	 * old token silently — the request the user is waiting on should not die
	 * because a token rotation hiccuped. With less than that, the failure is
	 * reported, because the token is about to be useless anyway.
	 *
	 * A FORCED refresh (the upstream just rejected a locally-valid token) is the
	 * exception: the stored token is known-bad, so its remaining validity is
	 * worthless and a failed refresh must surface rather than hand back the very
	 * token that was refused.
	 */
	private async refreshNow(credential: WorkBuddyCredential, forced = false): Promise<WorkBuddyCredential> {
		if (credential.refreshToken === "") {
			if (!forced && credential.expiresAtMs > Date.now() + USABLE_AFTER_FAILED_REFRESH_MS) return credential;
			throw new Error(
				"WorkBuddy access token expired and no refresh token is stored;" +
					" open the WorkBuddy desktop app once to sign in again",
			);
		}
		try {
			const outcome = await this.refreshImpl(credential);
			const refreshed: WorkBuddyCredential = {
				...credential,
				accessToken: outcome.accessToken,
				...(outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken }),
				expiresAtMs:
					outcome.expiresInSec === undefined ? credential.expiresAtMs : Date.now() + outcome.expiresInSec * 1000,
				...(outcome.domain === undefined || outcome.domain === "" ? {} : { domain: outcome.domain }),
				source: "dsh",
			};
			await this.saveOwn(refreshed);
			return refreshed;
		} catch (error: unknown) {
			if (!forced && credential.expiresAtMs > Date.now() + USABLE_AFTER_FAILED_REFRESH_MS) return credential;
			throw new Error(
				`WorkBuddy token refresh failed and the access token is expired (${
					error instanceof Error ? error.message : String(error)
				}); open the WorkBuddy desktop app once to sign in again`,
			);
		}
	}

	/** Write the plugin-owned copy; the desktop file is never a write target. */
	private async saveOwn(credential: WorkBuddyCredential): Promise<void> {
		const path = this.ownAuthPath();
		const document = ownDocument(credential, workbuddyAccountId(credential));
		await withFileLock(path, async () => {
			await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, {
				mode: 0o600,
				dirMode: 0o700,
			});
		});
	}
}
