import type { GoGatewayRoute } from "./go-gateway-route.ts";
/** Shared client types for the Coding OAuth settings UI. */

import type { GrokBuildSettingsKey } from "./locales.ts";

export type ProviderSlug = "grok" | "codex" | "kimi" | "claude";
export type LoginMethod = "pkce" | "device" | "browser";
export type CatalogSource = "live" | "cache" | "fallback";
export type SourceKind = ProviderSlug;
export type SourceReason = "missing" | "unsafe" | "invalid" | "too_large";
export type SourceConflict =
	| "none"
	| "same_credential"
	| "same_account"
	| "different_account"
	| "unknown_account"
	| "unreadable_destination"
	| "unsafe_destination";
export type SourcePreviewAction = "import" | "reuse" | "overwrite" | "blocked";
export type SourceCommitAction = "imported" | "unchanged" | "overwritten";
export type CapabilityFlagKey =
	| "codexSearch"
	| "kimiSearch"
	| "codexImages"
	| "codexImageEdits"
	| "codexImagesAnyModel"
	| "codexUsage"
	| "codexFast"
	| "grokImagineImage"
	| "grokImagineVideo";
export type CapabilityLimitKey = "searchResults" | "imageCount" | "videoArtifactTtlMs";
export type CapabilitySettingKey = CapabilityFlagKey | CapabilityLimitKey;
export type SettingsTabId = "accounts" | "capabilities" | "gateway" | "search" | "about";
export type CopyField = "openai" | "anthropic" | "key";

/** One WorkBuddy model row as the card renders it. */
export interface WorkBuddyModelView {
	id: string;
	name: string;
	/** Effective window after the saved budget, which is what DSH uses. */
	contextWindow: number;
	/** The model's own window; a budget can only lower it. */
	nativeContextWindow: number;
	maxTokens: number;
	creditMultiplier?: number;
	takesImages: boolean;
	reasoning: boolean;
	/** Whether the model is currently served to DSH. */
	enabled: boolean;
}

/** One discovered auth file, as the card offers it. */
export interface WorkBuddyAuthFileView {
	path: string;
	displayPath: string;
	source: "desktop" | "dsh";
	active: boolean;
	readable: boolean;
	region?: "cn" | "global";
	accountName?: string;
	tokenExpiresAtMs?: number;
	reason?: string;
	message?: string;
}

/** Today's check-in state, from the billing host. */
export interface WorkBuddyCheckinView {
	active: boolean;
	todayCheckedIn: boolean;
	streakDays: number;
	dailyCredit: number;
	todayCredit: number;
	isStreakDay: boolean;
	nextStreakDay: number;
	streakBonusDays: number;
	streakBonusCredit: number;
	claimButtonText?: string;
}

/** Aggregated remaining credit. */
export interface WorkBuddyCreditsView {
	totalCount: number;
	/** Sum of each package's `remaining`, i.e. what is actually left to spend. */
	totalRemaining: number;
	packages: readonly {
		accountId: number;
		dealName: string;
		packageName?: string;
		capacityType: number;
		capacityUnit: string;
		/** The current cycle's for a monthly package, the package's own otherwise. */
		remaining: number;
		total: number;
		/** True when `remaining`/`total` are the current cycle's figures. */
		monthly: boolean;
		cycleStartTime?: string;
		cycleEndTime?: string;
		expiredTime?: string;
	}[];
}

/** Secret-free WorkBuddy snapshot served by the plugin route. */
export interface WorkBuddyView {
	provider: {
		state: "signed-in" | "signed-out";
		region?: "cn" | "global";
		expiresAtMs?: number;
		nickname?: string;
		domain?: string;
		source?: "desktop" | "dsh";
	};
	catalog: {
		source: "live" | "cache" | "fallback";
		error?: string;
		models: readonly WorkBuddyModelView[];
		enabledModelIds: readonly string[];
		selectionExplicit: boolean;
		contextBudgets: Readonly<Record<string, number>>;
	};
	desktopFilePresent: boolean;
	/** Every auth file the store can read, plus which one is in force. */
	authFiles: readonly WorkBuddyAuthFileView[];
	authFileOverride?: string;
	checkinSupported: boolean;
	checkin?: WorkBuddyCheckinView;
	checkinError?: string;
	credits?: WorkBuddyCreditsView;
	creditsError?: string;
}

/** What a check-in click answered. */
export interface WorkBuddyCheckinResult {
	alreadyCheckedIn: boolean;
	claim?: { credit: number; streakDays: number; isStreakDay: boolean };
	checkin: WorkBuddyCheckinView;
}

/** One selectable DSH web search provider. */
export interface SearchProviderOption {
	/** Provider id written into the profile's `web.searchProvider`, or "" for auto. */
	id: string;
	/** Whether DSH ships this provider rather than the plugin registering it. */
	builtIn: boolean;
	/** Cheap local usability check reported by the web seam. */
	available: boolean;
}

/** Effective search-provider pin plus its candidates. */
export interface SearchProviderView {
	writable: boolean;
	/** Effective id; "" means DSH auto-selects the only usable provider. */
	current: string;
	candidates: SearchProviderOption[];
	unavailableReason?: string;
}

export type GrokStatus =
	| { status: "signed-out"; grokImportAvailable: boolean }
	| { status: "signing-in"; method: "pkce" | "device"; url?: string; userCode?: string; grokImportAvailable: boolean }
	| {
			status: "signed-in";
			models: string[];
			available: string[];
			selected: string[];
			catalogSource: CatalogSource;
			catalogError?: string;
			grokImportAvailable: boolean;
			accounts: readonly AccountSummary[];
			activeAccountId: string;
	  }
	| { status: "error"; message: string; grokImportAvailable: boolean };

export type SubscriptionStatus = {
	provider: Exclude<ProviderSlug, "grok">;
	route: string;
	displayName: string;
	loginMethods: readonly ("browser" | "device")[];
	recommendedLoginMethod: "browser" | "device";
	models: string[];
	available: string[];
	selected: string[];
} & (
	| { status: "signed-out" }
	| { status: "signing-in"; method: "browser" | "device"; url?: string; userCode?: string }
	| { status: "signed-in"; expiresAt?: number; accounts: readonly AccountSummary[]; activeAccountId: string }
	| { status: "error"; message: string }
);

/** Token-free account row from AuthDocument v2 status. */
export interface AccountSummary {
	id: string;
	label?: string;
	expires: number;
	accountId?: string;
}

export type ProviderStatus = (GrokStatus | SubscriptionStatus) & { operationError?: string };

export interface CodingOAuthStatus {
	accessMode: "loopback" | "ssh-tunnel" | "trusted-https-proxy" | "denied";
	uiOwner: "standalone" | "hub";
	compatibility: {
		coreAbi: string;
		dshVersion: string | null;
		status: "healthy" | "degraded" | "incompatible";
		diagnostics: readonly unknown[];
	};
	providers: {
		grok: GrokStatus;
		codex: SubscriptionStatus;
		kimi: SubscriptionStatus;
		claude: SubscriptionStatus;
	};
	antigravity: { installed: boolean; route: "agy"; management: "cli" };
	opencodeGo: {
		active: boolean;
		lastCall: "no-call" | "success" | "failure" | "missing-session";
		pending?: boolean;
		streamStatus?: string;
		configurationConflict?: boolean;
		updatedAt: number | null;
	};
}

export interface LoginChallenge {
	method: LoginMethod;
	url: string;
	userCode?: string;
}

export interface ProviderCardDefinition {
	slug: ProviderSlug;
	route: string;
	titleKey: GrokBuildSettingsKey;
	descriptionKey: GrokBuildSettingsKey;
	methods: readonly LoginMethod[];
	recommended: LoginMethod;
	/** Preferred method when the Settings UI is opened on a remote / non-loopback host. */
	remoteRecommended?: LoginMethod;
}

export interface SourceStatus {
	kind: SourceKind;
	displayPath: string;
	available: boolean;
	expiresAt?: number;
	reason?: SourceReason;
}

export interface SourcePreview {
	previewId: string;
	kind: SourceKind;
	displayPath: string;
	expiresAt?: number;
	ticketExpiresAt?: number;
	conflict?: SourceConflict;
	action?: SourcePreviewAction;
	warnings: string[];
	confirmOverwriteRequired: boolean;
}

export interface CapabilityFlags {
	codexSearch: boolean;
	kimiSearch: boolean;
	codexImages: boolean;
	codexImageEdits: boolean;
	codexImagesAnyModel: boolean;
	codexUsage: boolean;
	codexFast: boolean;
	grokImagineImage: boolean;
	grokImagineVideo: boolean;
}

export interface CapabilitySettingsView extends CapabilityFlags {
	searchResults: number;
	imageCount: number;
	videoArtifactTtlMs: number;
}

export interface CapabilitySnapshot {
	value: CapabilitySettingsView;
	revision: number;
	writable: boolean;
}

export interface UsageWindowView {
	usedPercent?: number;
	remainingPercent?: number;
	windowSeconds?: number;
	resetsAt?: number;
}

export interface UsageLimitView {
	id: string;
	name?: string;
	windows: UsageWindowView[];
}

export interface UsageView {
	rateLimits: UsageLimitView[];
	creditsUnlimited?: boolean;
	creditsBalance?: string;
	individualLimit?: string;
	individualUsed?: string;
	individualRemaining?: string;
	individualRemainingPercent?: number;
	individualResetsAt?: number;
	spendControlReached?: boolean;
	resetCredits?: number;
	fetchedAt?: number;
}

export interface ImagineCredentialView {
	configured: boolean;
	source?: string;
	writable?: boolean;
}

export interface PluginRequestError extends Error {
	status: number;
	code?: string;
}

export interface GatewayView {
	enabled: boolean;
	running: boolean;
	bind: string;
	port: number;
	model: string | null;
	keyConfigured: boolean;
	keyAvailable: boolean;
	keyHint: string;
	models: string[];
	warning: string;
	opencodeGoEnabled: boolean;
	opencodeGoRoute?: GoGatewayRoute | null;
	opencodeGoPreview?: GoGatewayRoute | null;
	opencodeGoMigration?: "none" | "required";
}

export interface GrokBuildSettingsInjected {
	t: (key: GrokBuildSettingsKey, params?: Record<string, unknown>) => string;
}

export type GrokBuildSettingsProps = Partial<GrokBuildSettingsInjected> & {
	close?: (() => void) | undefined;
	initialTab?: SettingsTabId;
};
