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
/** Region of a WorkBuddy account, derived from the credential's `domain`. */
export type WorkBuddyRegion = "cn" | "global";
/** Legacy plugin-owned single-copy basename (pre region split); migration source. */
export declare const WORKBUDDY_AUTH_FILENAME = ".workbuddy-auth.json";
/** Env variable that overrides the desktop auth-file location. */
export declare const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
/**
 * Region of a WorkBuddy credential, from its `domain`.
 *
 * A total predicate: everything that is not one of the two international brand
 * domains (exact or subdomain) is `cn`, including the empty string. The
 * `codebuddy.ai` spelling matters — a token issued there is rejected by the
 * `workbuddy.ai` gateway and vice versa, so the region decides the host, not
 * just a label.
 */
export declare function workbuddyRegionOf(domain: string): WorkBuddyRegion;
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
export declare const ENCRYPTED_CREDENTIAL_CODE = "WORKBUDDY_ENCRYPTED_CREDENTIAL";
/**
 * A desktop document whose token fields are sealed and whose at-rest key could
 * not be obtained. Deliberately distinct from an invalid document: the user is
 * signed in, and telling them to sign in again cannot help.
 */
export declare class WorkBuddyEncryptedCredentialError extends Error {
    readonly paths: readonly string[];
    readonly code = "WORKBUDDY_ENCRYPTED_CREDENTIAL";
    constructor(paths: readonly string[]);
}
/** Whether an error is the encrypted-credential condition; code-based, not `instanceof`. */
export declare function isWorkBuddyEncryptedCredentialError(value: unknown): value is WorkBuddyEncryptedCredentialError;
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
export declare function defaultDesktopAuthDirs(platform?: NodeJS.Platform, home?: string, env?: NodeJS.ProcessEnv): string[];
/** The live auth file's platform candidates, in probe order. */
export declare function defaultDesktopAuthCandidates(platform?: NodeJS.Platform, home?: string, env?: NodeJS.ProcessEnv): string[];
/** Normalize an expiry that may arrive in seconds or milliseconds. */
export declare function expiryToMs(value: number): number;
/**
 * Parse a WorkBuddy auth document in either on-disk shape: the nested form
 * `{"auth":{...},"account":{...}}` and the flat panel form. Returns undefined
 * when the document carries no readable access token.
 */
export declare function parseWorkBuddyAuth(text: string, filePath: string, atRestKey?: Buffer): WorkBuddyCredential | undefined;
/**
 * Whether a document carries any field the reader must decrypt. Deciding this
 * BEFORE asking the app for its key keeps the plain case (and every
 * plugin-owned copy) from paying for a child process on every read.
 */
export declare function hasEncryptedCredentialFields(text: string): boolean;
/** Filename of a path regardless of the host separator. */
export declare function authFileName(path: string): string;
/**
 * A home-relative rendering of an auth path, for display.
 *
 * The operator's home directory is personal data, so a path under it renders as
 * `~/…`; anything else is shown as-is rather than being hidden, because a path
 * the user chose outside their home is exactly what they need to recognize.
 */
export declare function displayAuthPath(path: string, home?: string): string;
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
export declare function workbuddyAccountId(credential: Pick<WorkBuddyCredential, "uin" | "uid" | "nickname">): string;
/** Plugin-owned copy path for one region inside the Harness home. */
export declare function workbuddyOwnAuthPath(region: WorkBuddyRegion, dshHome?: string): string;
/** Pre-region-split single-copy path; read as a migration source, removed by logout. */
export declare function legacyWorkbuddyOwnAuthPath(dshHome?: string): string;
/** Sortable owner-preference key, so two regions never share one cached file. */
export declare function workbuddyCredentialKey(credential: WorkBuddyCredential): string;
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
/**
 * One region's WorkBuddy credential owner.
 *
 * Reads the desktop app's sign-in (read-only) plus this plugin's own refreshed
 * copy, picks the freshest per account, and refreshes on demand under a
 * single-flight so concurrent requests cannot each spend a refresh.
 */
export declare class WorkBuddyCredentialStore {
    private readonly region;
    private readonly refreshMarginMs;
    private readonly resolveAtRestKey;
    private readonly platform;
    private readonly home;
    private readonly env;
    private readonly refreshImpl;
    private desktopPath;
    private ownPathOverride;
    private legacyOwnPathOverride;
    private authDirsOverride;
    private selectedId;
    private explicitSelection;
    private inflight;
    private forceRefresh;
    private lastKnown;
    private lastFailures;
    private lastTried;
    constructor(options: WorkBuddyStoreOptions);
    /** The plugin-owned copy this store refreshes into. */
    ownAuthPath(): string;
    private legacyOwnPath;
    /** Override the desktop auth file at runtime (settings-driven). */
    setDesktopPath(path: string | undefined): void;
    /** The desktop auth-file override currently in force, if any. */
    desktopPathOverride(): string | undefined;
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
    candidateFiles(): Promise<WorkBuddyCandidateFile[]>;
    /** Whether the user picked an account explicitly, rather than by freshness. */
    hasExplicitSelection(): boolean;
    /** Select an account by id; `undefined` returns to automatic (freshest) choice. */
    selectAccount(id: string | undefined): void;
    selectedAccountId(): string | undefined;
    /** Every discovered account, best-first within an account. */
    accounts(): Promise<WorkBuddyAccountChoice[]>;
    /** Secret-free discovery diagnostic: every path consulted plus the failures. */
    diagnose(): Promise<WorkBuddyAuthDiagnosis>;
    /** The credential to send upstream: {@link current}, refreshed on demand. */
    resolve(): Promise<WorkBuddyCredential>;
    /** Secret-free status; never throws. */
    status(): Promise<WorkBuddyAuthStatus>;
    /** Whether a desktop auth file exists at all, for UI hints. */
    desktopFilePresent(): Promise<boolean>;
    /**
     * Remove this plugin's own copies only.
     *
     * The desktop app's file is never touched, so the user stays signed in to the
     * app and simply re-imports on the next read.
     */
    logout(): Promise<void>;
    private matchesRegion;
    /** Owned copies, region-scoped first so two regions never collide. */
    private ownCandidates;
    private desktopCandidates;
    /**
     * The live file first, then its `.info` siblings newest-name-first.
     *
     * Matching is `name.endsWith('.info')` with no prefix test, because the app
     * has shipped more than one live filename and a backup is identified by the
     * timestamp the app embeds, not by a prefix this plugin would have to guess.
     */
    private backupsBeside;
    private readCandidate;
    /** Every readable credential across the desktop files and the plugin's copies. */
    private readAll;
    /**
     * The credential the next request should use: the explicitly selected account
     * when there is one, else the freshest. An explicit selection that no longer
     * exists falls back rather than failing the request, so removing an account
     * cannot wedge the route.
     */
    private current;
    /**
     * The credential this store most recently resolved, WITHOUT touching the disk.
     *
     * Exists for the synchronous catalog closure a pi-ai provider requires. It is
     * a cache, not a source of truth: callers that need a fresh or refreshed
     * credential must use {@link resolve}, which also populates this.
     */
    peek(): WorkBuddyCredential | undefined;
    /** Build the actionable error for "no usable credential". */
    private describeMissingCredential;
    private needsRefresh;
    /**
     * Force the next {@link resolve} to refresh before use.
     *
     * Called after an upstream 401 rejected a token that was still locally valid,
     * which is the only signal that the stored expiry is wrong. Unlike the OAuth
     * stores this cannot backdate a file it does not own, so the intent is held in
     * memory and applied to the next read.
     */
    invalidateAccessToken(): Promise<void>;
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
    private refreshNow;
    /** Write the plugin-owned copy; the desktop file is never a write target. */
    private saveOwn;
}
//# sourceMappingURL=workbuddy-auth.d.ts.map