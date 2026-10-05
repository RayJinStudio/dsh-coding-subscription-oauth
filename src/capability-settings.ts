import Schema from "@deepseek-ai/schemastery";
import { CAPABILITY_SETTINGS_NAMESPACE } from "./ids.ts";

/**
 * Integration-ready capability settings controller for the
 * `coding-subscription-oauth` namespace. Schema defaults sit under the
 * composition/YAML `base`, and the user section layers on top. The controller
 * talks to an injected structural settings service while registering a real
 * Schemastery section that the Host settings service can render and validate.
 * @module dsh-coding-subscription-oauth/capability-settings
 */

/** Settings namespace owned by this plugin. */
export { CAPABILITY_SETTINGS_NAMESPACE } from "./ids.ts";

/** Default-off capability flags. Presence in the user section marks an override. */
export const CAPABILITY_FLAG_KEYS = [
	"codexSearch",
	"kimiSearch",
	"codexImages",
	"codexImageEdits",
	"codexImagesAnyModel",
	"codexUsage",
	"codexFast",
	"grokImagineImage",
	"grokImagineVideo",
] as const;

/** Conservative numeric limits persisted beside the flags. */
export const CAPABILITY_LIMIT_KEYS = ["searchResults", "imageCount", "videoArtifactTtlMs"] as const;

/** Every key the controller admits into secret-free state. */
export const CAPABILITY_SETTINGS_KEYS = [...CAPABILITY_FLAG_KEYS, ...CAPABILITY_LIMIT_KEYS] as const;

export type CapabilityFlagKey = (typeof CAPABILITY_FLAG_KEYS)[number];
export type CapabilityLimitKey = (typeof CAPABILITY_LIMIT_KEYS)[number];
export type CapabilitySettingsKey = (typeof CAPABILITY_SETTINGS_KEYS)[number];

/** Resolved, secret-free capability section. */
export interface CapabilitySettings {
	readonly codexSearch: boolean;
	/** Kimi Code subscription search (`/coding/v1/search`). */
	readonly kimiSearch: boolean;
	readonly codexImages: boolean;
	readonly codexImageEdits: boolean;
	/** Allow non-Codex-route models to use the Codex image generate/edit tools. */
	readonly codexImagesAnyModel: boolean;
	readonly codexUsage: boolean;
	readonly codexFast: boolean;
	readonly grokImagineImage: boolean;
	readonly grokImagineVideo: boolean;
	readonly searchResults: number;
	readonly imageCount: number;
	readonly videoArtifactTtlMs: number;
}

/** Sparse overlay used for YAML/composition `base` and the user section. */
export type CapabilitySettingsPatch = Partial<CapabilitySettings>;

/** Inclusive bounds and schema defaults for each numeric limit. */
export const CAPABILITY_SETTINGS_BOUNDS = {
	searchResults: { min: 1, max: 20, default: 5 },
	imageCount: { min: 1, max: 4, default: 1 },
	videoArtifactTtlMs: {
		min: 60 * 60 * 1000,
		max: 7 * 24 * 60 * 60 * 1000,
		default: 7 * 24 * 60 * 60 * 1000,
	},
} as const;

/** Schema defaults: every flag off, every limit at its conservative default. */
export const DEFAULT_CAPABILITY_SETTINGS: CapabilitySettings = Object.freeze({
	codexSearch: false,
	kimiSearch: false,
	codexImages: false,
	codexImageEdits: false,
	codexImagesAnyModel: false,
	codexUsage: false,
	codexFast: false,
	grokImagineImage: false,
	grokImagineVideo: false,
	searchResults: CAPABILITY_SETTINGS_BOUNDS.searchResults.default,
	imageCount: CAPABILITY_SETTINGS_BOUNDS.imageCount.default,
	videoArtifactTtlMs: CAPABILITY_SETTINGS_BOUNDS.videoArtifactTtlMs.default,
});

/**
 * Real Schemastery schema registered with the Host settings service. Defaults
 * remain conservative, and bounds are enforced before a user document commits.
 */
export const CapabilitySettingsSchema = Schema.object({
	codexSearch: Schema.boolean().default(false),
	kimiSearch: Schema.boolean().default(false),
	codexImages: Schema.boolean().default(false),
	codexImageEdits: Schema.boolean().default(false),
	codexImagesAnyModel: Schema.boolean().default(false),
	codexUsage: Schema.boolean().default(false),
	codexFast: Schema.boolean().default(false),
	grokImagineImage: Schema.boolean().default(false),
	grokImagineVideo: Schema.boolean().default(false),
	searchResults: Schema.number()
		.step(1)
		.min(CAPABILITY_SETTINGS_BOUNDS.searchResults.min)
		.max(CAPABILITY_SETTINGS_BOUNDS.searchResults.max)
		.default(CAPABILITY_SETTINGS_BOUNDS.searchResults.default),
	imageCount: Schema.number()
		.step(1)
		.min(CAPABILITY_SETTINGS_BOUNDS.imageCount.min)
		.max(CAPABILITY_SETTINGS_BOUNDS.imageCount.max)
		.default(CAPABILITY_SETTINGS_BOUNDS.imageCount.default),
	videoArtifactTtlMs: Schema.number()
		.step(1)
		.min(CAPABILITY_SETTINGS_BOUNDS.videoArtifactTtlMs.min)
		.max(CAPABILITY_SETTINGS_BOUNDS.videoArtifactTtlMs.max)
		.default(CAPABILITY_SETTINGS_BOUNDS.videoArtifactTtlMs.default),
});

/** Serialized schema metadata consumed by Settings UI tests and diagnostics. */
export const CAPABILITY_SETTINGS_SCHEMA_JSON = CapabilitySettingsSchema.toJSON();

export type CapabilitySettingsSchemaType = typeof CapabilitySettingsSchema;

/** Revision-bearing, secret-free snapshot used for CAS writes and UI. */
export interface CapabilitySettingsSnapshot {
	readonly ns: typeof CAPABILITY_SETTINGS_NAMESPACE;
	readonly value: CapabilitySettings;
	readonly base?: CapabilitySettingsPatch;
	readonly user?: CapabilitySettingsPatch;
	readonly revision: number;
	readonly writable: boolean;
	readonly applies: "live";
	readonly secrets: readonly [];
}

/** Owner-facing subset of `ctx.settings.register()` used when the parent injects a provider. */
export interface CapabilitySettingsScope {
	get(): unknown;
	watch(callback: (next: unknown, prev: unknown) => void | Promise<void>): () => void;
	update(patch: object): Promise<void>;
	replace(section: object): Promise<void>;
}

/** One namespace descriptor as returned by a structural `describe()`. */
export interface CapabilitySettingsDescriptor {
	readonly ns: string;
	readonly value?: unknown;
	readonly base?: unknown;
	readonly user?: unknown;
	readonly revision?: number;
	readonly applies?: "live" | "restart";
	readonly secrets?: readonly { readonly path?: readonly string[]; readonly set?: boolean }[];
}

/**
 * Duck-typed settings service. A real `ctx.settings` satisfies this without a
 * compile-time dependency on `@deepseek-ai/dsh-settings`.
 */
export interface CapabilitySettingsService {
	readonly writable?: boolean;
	describe?(options?: { readonly redactSecrets?: boolean }): readonly CapabilitySettingsDescriptor[];
	get?(ns: string): unknown;
	update?(ns: string, patch: object, expectedRevision?: number): Promise<void>;
	replace?(ns: string, section: object, expectedRevision?: number): Promise<void>;
	mutate?(ns: string, ops: readonly CapabilitySettingsPathOp[], expectedRevision?: number): Promise<void>;
	register?(
		ns: string,
		schema: CapabilitySettingsSchemaType,
		options?: {
			readonly base?: CapabilitySettingsPatch;
			readonly applies?: "live" | "restart";
			readonly validate?: (value: CapabilitySettings) => void;
		},
	): CapabilitySettingsScope;
}

/** One path-addressed entry-config edit, mirroring the Host's `settings.mutate()` wire form. */
export interface CapabilitySettingsPathOp {
	readonly op: "set" | "unset";
	readonly path: readonly string[];
	readonly value?: unknown;
}

/**
 * A 0.2.x `.volatile()` Config field: the loader hands the plugin a live reference
 * whose `get()` returns the value committed by the running fiber, instead of the
 * parsed object 0.1.x passed through.
 */
export interface CapabilityVolatileSection<T> {
	get(): T | undefined;
}

/** Construction options. `base` is the YAML / composition entry layered under the user section. */
export interface CapabilitySettingsControllerOptions {
	readonly settings?: CapabilitySettingsService | undefined;
	readonly base?: CapabilitySettingsPatch | undefined;
	/**
	 * Live reader for a volatile Config section. Preferred over `describe()` because it
	 * is the value the Host actually committed into this plugin's fiber.
	 */
	readonly volatileSection?: (() => unknown) | undefined;
	/**
	 * Profile plugin entry id owning this plugin's Config under the 0.2.x form model
	 * (the composed entry id, normally the plugin's exported `name`). Used when
	 * `describe()` does not show which entry carries the capability section.
	 */
	readonly entryNamespace?: string | undefined;
	/** Contain both synchronous and asynchronous observer failures. */
	readonly onListenerError?: ((error: unknown) => void) | undefined;
}

/** Listener invoked after a committed snapshot change. */
export type CapabilitySettingsListener = (snapshot: CapabilitySettingsSnapshot) => void | Promise<void>;

const SECRET_KEY = /secret|token|password|passphrase|apikey|api_key|authorization|credential|cookie|private[_-]?key/iu;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const KNOWN_KEYS = new Set<string>(CAPABILITY_SETTINGS_KEYS);

/**
 * A write refused because the namespace moved since the caller read it.
 * `code` matches the Host settings seam so a later wire layer can map it.
 */
export class CapabilitySettingsConflictError extends Error {
	readonly code = "SETTINGS_CONFLICT";
	readonly ns = CAPABILITY_SETTINGS_NAMESPACE;
	readonly expected: number;
	readonly actual: number;

	constructor(expected: number, actual: number) {
		super(
			`settings namespace "${CAPABILITY_SETTINGS_NAMESPACE}" changed since it was read ` +
				`(expected revision ${String(expected)}, now ${String(actual)})`,
		);
		this.name = "CapabilitySettingsConflictError";
		this.expected = expected;
		this.actual = actual;
	}
}

/** A write refused because no writable settings provider is attached. */
export class CapabilitySettingsReadOnlyError extends Error {
	readonly code: "SETTINGS_PROVIDER_ABSENT" | "SETTINGS_READ_ONLY" | "SETTINGS_DISPOSED";
	readonly ns = CAPABILITY_SETTINGS_NAMESPACE;
	readonly reason: "absent" | "read-only" | "disposed";

	constructor(reason: "absent" | "read-only" | "disposed") {
		const code =
			reason === "absent"
				? "SETTINGS_PROVIDER_ABSENT"
				: reason === "disposed"
					? "SETTINGS_DISPOSED"
					: "SETTINGS_READ_ONLY";
		const detail =
			reason === "absent"
				? `settings provider is absent: "${CAPABILITY_SETTINGS_NAMESPACE}" cannot be updated`
				: reason === "disposed"
					? `settings controller is disposed: "${CAPABILITY_SETTINGS_NAMESPACE}" cannot be updated`
					: `settings provider is read-only: "${CAPABILITY_SETTINGS_NAMESPACE}" cannot be updated in-process`;
		super(detail);
		this.name = "CapabilitySettingsReadOnlyError";
		this.code = code;
		this.reason = reason;
	}
}

export function isCapabilitySettingsConflictError(error: unknown): error is CapabilitySettingsConflictError {
	return error instanceof CapabilitySettingsConflictError;
}

export function isCapabilitySettingsReadOnlyError(error: unknown): error is CapabilitySettingsReadOnlyError {
	return error instanceof CapabilitySettingsReadOnlyError;
}

/** Pick every independently default-off flag from a resolved section. */
export function capabilityFlags(settings: CapabilitySettings): Pick<CapabilitySettings, CapabilityFlagKey> {
	return {
		codexSearch: settings.codexSearch,
		kimiSearch: settings.kimiSearch,
		codexImages: settings.codexImages,
		codexImageEdits: settings.codexImageEdits,
		codexImagesAnyModel: settings.codexImagesAnyModel,
		codexUsage: settings.codexUsage,
		codexFast: settings.codexFast,
		grokImagineImage: settings.grokImagineImage,
		grokImagineVideo: settings.grokImagineVideo,
	};
}

/** Pick the conservative numeric limits from a resolved section. */
export function capabilityLimits(settings: CapabilitySettings): Pick<CapabilitySettings, CapabilityLimitKey> {
	return {
		searchResults: settings.searchResults,
		imageCount: settings.imageCount,
		videoArtifactTtlMs: settings.videoArtifactTtlMs,
	};
}

/** Layer schema defaults, then YAML/composition `base`, then the user section. */
export function resolveCapabilitySettings(
	base?: CapabilitySettingsPatch | undefined,
	user?: CapabilitySettingsPatch | undefined,
): CapabilitySettings {
	return normalizeCapabilitySettings({
		...DEFAULT_CAPABILITY_SETTINGS,
		...normalizeCapabilitySettingsPatch(base),
		...normalizeCapabilitySettingsPatch(user),
	});
}

/**
 * Admit a candidate section: known keys only, flags default off, limits clamped,
 * secret-shaped keys dropped. Used for both reads and the structural schema.
 */
export function normalizeCapabilitySettings(input?: unknown): CapabilitySettings {
	const patch = normalizeCapabilitySettingsPatch(input);
	const codexImages = patch.codexImages ?? DEFAULT_CAPABILITY_SETTINGS.codexImages;
	return Object.freeze({
		codexSearch: patch.codexSearch ?? DEFAULT_CAPABILITY_SETTINGS.codexSearch,
		kimiSearch: patch.kimiSearch ?? DEFAULT_CAPABILITY_SETTINGS.kimiSearch,
		codexImages,
		codexImageEdits: patch.codexImageEdits ?? DEFAULT_CAPABILITY_SETTINGS.codexImageEdits,
		// any-model is meaningless without images; clear at admit so UI cascade alone cannot leave it on
		codexImagesAnyModel: codexImages
			? (patch.codexImagesAnyModel ?? DEFAULT_CAPABILITY_SETTINGS.codexImagesAnyModel)
			: false,
		codexUsage: patch.codexUsage ?? DEFAULT_CAPABILITY_SETTINGS.codexUsage,
		codexFast: patch.codexFast ?? DEFAULT_CAPABILITY_SETTINGS.codexFast,
		grokImagineImage: patch.grokImagineImage ?? DEFAULT_CAPABILITY_SETTINGS.grokImagineImage,
		grokImagineVideo: patch.grokImagineVideo ?? DEFAULT_CAPABILITY_SETTINGS.grokImagineVideo,
		searchResults: patch.searchResults ?? DEFAULT_CAPABILITY_SETTINGS.searchResults,
		imageCount: patch.imageCount ?? DEFAULT_CAPABILITY_SETTINGS.imageCount,
		videoArtifactTtlMs: patch.videoArtifactTtlMs ?? DEFAULT_CAPABILITY_SETTINGS.videoArtifactTtlMs,
	});
}

/**
 * Normalize a sparse overlay. Invalid or secret fields are omitted so a lower
 * layer (YAML base / schema default) remains authoritative for that key.
 */
export function normalizeCapabilitySettingsPatch(input?: unknown): CapabilitySettingsPatch {
	if (!isPlainObject(input)) return {};
	const patch: {
		codexSearch?: boolean;
		kimiSearch?: boolean;
		codexImages?: boolean;
		codexImageEdits?: boolean;
		codexImagesAnyModel?: boolean;
		codexUsage?: boolean;
		codexFast?: boolean;
		grokImagineImage?: boolean;
		grokImagineVideo?: boolean;
		searchResults?: number;
		imageCount?: number;
		videoArtifactTtlMs?: number;
	} = {};
	const flags = input as Record<string, unknown>;
	assignFlag(patch, "codexSearch", flags["codexSearch"]);
	assignFlag(patch, "kimiSearch", flags["kimiSearch"]);
	assignFlag(patch, "codexImages", flags["codexImages"]);
	assignFlag(patch, "codexImageEdits", flags["codexImageEdits"]);
	assignFlag(patch, "codexImagesAnyModel", flags["codexImagesAnyModel"]);
	assignFlag(patch, "codexUsage", flags["codexUsage"]);
	assignFlag(patch, "codexFast", flags["codexFast"]);
	assignFlag(patch, "grokImagineImage", flags["grokImagineImage"]);
	assignFlag(patch, "grokImagineVideo", flags["grokImagineVideo"]);
	assignLimit(patch, "searchResults", flags["searchResults"]);
	assignLimit(patch, "imageCount", flags["imageCount"]);
	assignLimit(patch, "videoArtifactTtlMs", flags["videoArtifactTtlMs"]);
	return Object.freeze(patch);
}

/**
 * Strictly admit a caller-authored sparse section before normalizing it. Reads
 * remain compatibility-tolerant, but writes must never silently drop unknown
 * fields, coerce types, truncate decimals, or clamp out-of-range limits.
 */
export function assertCapabilitySettingsPatch(
	input: unknown,
	label = "capability settings",
): asserts input is CapabilitySettingsPatch {
	assertPlainObject(input, label);
	for (const [key, value] of Object.entries(input)) {
		if (!KNOWN_KEYS.has(key)) throw new TypeError(`${label} contains unknown key ${key}`);
		if ((CAPABILITY_FLAG_KEYS as readonly string[]).includes(key)) {
			if (typeof value !== "boolean") throw new TypeError(`${label}.${key} must be a boolean`);
			continue;
		}
		const limitKey = key as CapabilityLimitKey;
		const bounds = CAPABILITY_SETTINGS_BOUNDS[limitKey];
		if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
			throw new TypeError(`${label}.${key} must be an integer`);
		}
		if (value < bounds.min || value > bounds.max) {
			throw new TypeError(`${label}.${key} must be in [${String(bounds.min)}, ${String(bounds.max)}]`);
		}
	}
}

/** Reject a resolved section the owner could not act on. Schema-valid by construction after normalize. */
export function assertServiceableCapabilitySettings(value: CapabilitySettings): void {
	for (const key of CAPABILITY_FLAG_KEYS) {
		if (typeof value[key] !== "boolean") {
			throw new TypeError(`capability settings: ${key} must be a boolean`);
		}
	}
	for (const key of CAPABILITY_LIMIT_KEYS) {
		const bounds = CAPABILITY_SETTINGS_BOUNDS[key];
		const numeric = value[key];
		if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < bounds.min || numeric > bounds.max) {
			throw new TypeError(
				`capability settings: ${key} must be an integer in [${String(bounds.min)}, ${String(bounds.max)}]`,
			);
		}
	}
}

/**
 * Live capability-settings controller. Without an injected provider the
 * resolved state is the YAML/default layer and every write fails explicitly.
 */
export class CapabilitySettingsController {
	readonly ns = CAPABILITY_SETTINGS_NAMESPACE;
	private readonly settings: CapabilitySettingsService | undefined;
	private readonly base: CapabilitySettingsPatch;
	private readonly onListenerError: (error: unknown) => void;
	private readonly configuredEntryNamespace: string | undefined;
	private readonly volatileSection: (() => unknown) | undefined;
	private readonly listeners = new Set<CapabilitySettingsListener>();
	private scope: CapabilitySettingsScope | undefined;
	private scopeDisposer: (() => void) | undefined;
	private resolvedNamespace: string | undefined;
	private localRevision = 0;
	private lastSnapshot: CapabilitySettingsSnapshot;
	private disposed = false;

	constructor(options: CapabilitySettingsControllerOptions = {}) {
		this.settings = options.settings;
		this.base = normalizeCapabilitySettingsPatch(options.base);
		this.configuredEntryNamespace =
			typeof options.entryNamespace === "string" && options.entryNamespace.length > 0
				? options.entryNamespace
				: undefined;
		this.volatileSection = options.volatileSection;
		this.onListenerError = options.onListenerError ?? (() => undefined);
		this.attachScope();
		this.lastSnapshot = this.readSnapshot();
	}

	/** Current revision-bearing snapshot. Re-reads the injected provider when present. */
	snapshot(): CapabilitySettingsSnapshot {
		const next = this.readSnapshot();
		this.lastSnapshot = next;
		return next;
	}

	/** Resolved capability section (schema defaults ← YAML base ← user). */
	current(): CapabilitySettings {
		return this.snapshot().value;
	}

	/**
	 * Merge a secret-free patch into the user layer using compare-and-swap on
	 * `expectedRevision` from a previously read {@link snapshot}.
	 */
	async patch(patch: CapabilitySettingsPatch, expectedRevision: number): Promise<CapabilitySettingsSnapshot> {
		return this.write("update", patch, expectedRevision);
	}

	/**
	 * Replace the user section wholesale (`{}` re-inherits YAML base and defaults).
	 * Compare-and-swap uses the same revision token as {@link patch}.
	 */
	async replace(section: CapabilitySettingsPatch, expectedRevision: number): Promise<CapabilitySettingsSnapshot> {
		return this.write("replace", section, expectedRevision);
	}

	/**
	 * Observe committed snapshot changes. The disposer removes this listener;
	 * an invocation already running still settles.
	 */
	subscribe(listener: CapabilitySettingsListener): () => void {
		if (this.disposed) return () => undefined;
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Re-read the injected provider (or the local YAML/default layer) and notify
	 * listeners when the secret-free snapshot moved.
	 */
	reconcile(): CapabilitySettingsSnapshot {
		const next = this.readSnapshot();
		this.publish(next);
		return this.lastSnapshot;
	}

	/** Drop the register() watcher and every listener. Further writes fail. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const releaseScope = this.scopeDisposer;
		this.scopeDisposer = undefined;
		this.scope = undefined;
		this.listeners.clear();
		try {
			releaseScope?.();
		} catch (error: unknown) {
			this.onListenerError(error);
		}
	}

	private attachScope(): void {
		const register = this.settings?.register;
		if (register === undefined) return;
		this.scope = register.call(this.settings, CAPABILITY_SETTINGS_NAMESPACE, CapabilitySettingsSchema, {
			base: this.base,
			applies: "live",
			validate: assertServiceableCapabilitySettings,
		});
		this.scopeDisposer = this.scope.watch(() => {
			if (this.disposed) return;
			this.reconcile();
		});
	}

	/**
	 * Whether the attached service is the 0.2.x form model: one descriptor per profile
	 * plugin entry, no dynamic `register()`. There the capability section is this
	 * plugin entry's `capabilities` Config field, so reads unwrap it and writes address
	 * the entry (and are applied with path ops to keep sibling fields intact).
	 */
	private get entryScoped(): boolean {
		return (
			this.settings !== undefined &&
			typeof this.settings.register !== "function" &&
			typeof this.settings.describe === "function"
		);
	}

	/**
	 * Namespace the attached service addresses. 0.1.x registered this plugin's own
	 * namespace; 0.2.x only accepts profile plugin entries, so resolve the entry that
	 * owns this plugin's Config once and reuse it.
	 * @returns the legacy namespace, or the owning entry id under the form model.
	 */
	hostNamespace(): string {
		if (this.resolvedNamespace !== undefined) return this.resolvedNamespace;
		this.resolvedNamespace = this.resolveHostNamespace();
		return this.resolvedNamespace;
	}

	private resolveHostNamespace(): string {
		if (!this.entryScoped) return CAPABILITY_SETTINGS_NAMESPACE;
		let descriptors: readonly CapabilitySettingsDescriptor[] | undefined;
		try {
			const described = this.settings?.describe?.({ redactSecrets: true });
			if (Array.isArray(described)) descriptors = described;
		} catch {
			descriptors = undefined;
		}
		// A service that still lists this plugin's own namespace keeps the 0.1.x address.
		if (descriptors?.some((entry) => entry?.ns === CAPABILITY_SETTINGS_NAMESPACE) === true) {
			return CAPABILITY_SETTINGS_NAMESPACE;
		}
		// The composed entry id is authoritative when the caller knows it: an entry with
		// no user section yet can be absent from describe() while still accepting writes.
		if (this.configuredEntryNamespace !== undefined) return this.configuredEntryNamespace;
		const owner = descriptors?.find((entry) => capabilitySectionOf(entry?.value) !== undefined);
		return typeof owner?.ns === "string" && owner.ns.length > 0 ? owner.ns : CAPABILITY_SETTINGS_NAMESPACE;
	}

	private describedSection(value: unknown): unknown {
		return this.entryScoped ? capabilitySectionOf(value) : value;
	}

	private writeReason(): "absent" | "read-only" | "disposed" | undefined {
		if (this.disposed) return "disposed";
		if (this.settings === undefined) return "absent";
		if (this.settings.writable === false) return "read-only";
		const canWrite =
			typeof this.settings.update === "function" ||
			typeof this.settings.replace === "function" ||
			typeof this.settings.mutate === "function" ||
			this.scope !== undefined;
		if (!canWrite) return "read-only";
		return undefined;
	}

	private isWritable(): boolean {
		return this.writeReason() === undefined;
	}

	private async write(
		mode: "update" | "replace",
		input: CapabilitySettingsPatch,
		expectedRevision: number,
	): Promise<CapabilitySettingsSnapshot> {
		const reason = this.writeReason();
		if (reason !== undefined) throw new CapabilitySettingsReadOnlyError(reason);
		assertCapabilitySettingsPatch(input, `capability settings ${mode}`);
		const current = this.readSnapshot();
		if (expectedRevision !== current.revision) {
			throw new CapabilitySettingsConflictError(expectedRevision, current.revision);
		}
		const normalized = normalizeCapabilitySettingsPatch(input);
		if (mode === "update" && !hasOwnKeys(normalized)) return current;
		const settings = this.settings!;
		try {
			if (this.entryScoped) {
				await this.writeEntryScoped(settings, mode, normalized, expectedRevision);
			} else if (mode === "update") {
				if (typeof settings.update === "function") {
					await settings.update(CAPABILITY_SETTINGS_NAMESPACE, { ...normalized }, expectedRevision);
				} else {
					await this.scope!.update({ ...normalized });
				}
			} else if (typeof settings.replace === "function") {
				await settings.replace(CAPABILITY_SETTINGS_NAMESPACE, { ...normalized }, expectedRevision);
			} else {
				await this.scope!.replace({ ...normalized });
			}
		} catch (error) {
			throw toConflictError(error) ?? error;
		}
		this.localRevision = current.revision + 1;
		const next = this.readSnapshot();
		this.publish(next);
		return this.lastSnapshot;
	}

	private readSnapshot(): CapabilitySettingsSnapshot {
		const writable = this.isWritable();
		const described = this.readDescribed();
		const describedBase = this.describedSection(described?.base);
		const describedUser = this.describedSection(described?.user);
		const describedValue = this.describedSection(described?.value);
		const base = describedBase !== undefined ? normalizeCapabilitySettingsPatch(describedBase) : this.base;
		const user = describedUser !== undefined ? normalizeCapabilitySettingsPatch(describedUser) : undefined;
		// A volatile Config section is the value this plugin's fiber actually runs with,
		// so it wins over both the described entry form and the composition base.
		const live = this.readVolatileSection();
		const resolved =
			live !== undefined
				? normalizeCapabilitySettings(live)
				: describedValue !== undefined
					? normalizeCapabilitySettings(describedValue)
					: this.readResolvedFromService(base, user);
		const revision =
			typeof described?.revision === "number" && Number.isFinite(described.revision)
				? described.revision
				: this.localRevision;
		return freezeSnapshot({
			ns: CAPABILITY_SETTINGS_NAMESPACE,
			value: resolved,
			revision,
			writable,
			applies: "live",
			secrets: [],
			...(hasOwnKeys(base) ? { base } : {}),
			...(user !== undefined && hasOwnKeys(user) ? { user } : {}),
		});
	}

	private readVolatileSection(): unknown {
		try {
			return this.volatileSection?.();
		} catch {
			return undefined;
		}
	}

	private readResolvedFromService(
		base: CapabilitySettingsPatch,
		user: CapabilitySettingsPatch | undefined,
	): CapabilitySettings {
		const raw = this.scope?.get() ?? this.readServiceValue();
		if (raw !== undefined) return normalizeCapabilitySettings(raw);
		return resolveCapabilitySettings(base, user);
	}

	private readServiceValue(): unknown {
		const get = this.settings?.get;
		if (get === undefined) return undefined;
		return this.describedSection(get.call(this.settings, this.hostNamespace()));
	}

	/**
	 * Apply one edit through the 0.2.x form model. `mutate()` is preferred because a
	 * shallow `update()` of the entry would drop the capability keys a sparse patch
	 * does not restate; `replace` resets the section instead of the whole entry.
	 */
	private async writeEntryScoped(
		settings: CapabilitySettingsService,
		mode: "update" | "replace",
		normalized: CapabilitySettingsPatch,
		expectedRevision: number,
	): Promise<void> {
		const ns = this.hostNamespace();
		const keys = Object.keys(normalized);
		const mutate = settings.mutate;
		if (typeof mutate === "function") {
			const ops: CapabilitySettingsPathOp[] =
				mode === "replace"
					? [{ op: "set", path: ["capabilities"], value: { ...normalized } }]
					: keys.map((key) => ({
							op: "set" as const,
							path: ["capabilities", key],
							value: normalized[key as keyof CapabilitySettingsPatch],
						}));
			await mutate.call(settings, ns, ops, expectedRevision);
			return;
		}
		if (typeof settings.update === "function") {
			await settings.update(ns, { capabilities: { ...normalized } }, expectedRevision);
			return;
		}
		throw new CapabilitySettingsReadOnlyError("read-only");
	}

	private readDescribed(): CapabilitySettingsDescriptor | undefined {
		const describe = this.settings?.describe;
		if (describe === undefined) return undefined;
		try {
			const descriptors = describe.call(this.settings, { redactSecrets: true });
			if (!Array.isArray(descriptors)) return undefined;
			const ns = this.hostNamespace();
			return descriptors.find((entry) => entry?.ns === ns);
		} catch {
			return undefined;
		}
	}

	private publish(next: CapabilitySettingsSnapshot): void {
		if (sameSnapshot(this.lastSnapshot, next)) {
			this.lastSnapshot = next;
			return;
		}
		this.lastSnapshot = next;
		for (const listener of [...this.listeners]) {
			try {
				const result = listener(next);
				if (result !== undefined) void Promise.resolve(result).catch(this.onListenerError);
			} catch (error) {
				// One broken observer must not starve the rest or the write path.
				this.onListenerError(error);
			}
		}
	}
}

/** Construct a {@link CapabilitySettingsController}. */
export function createCapabilitySettingsController(
	options: CapabilitySettingsControllerOptions = {},
): CapabilitySettingsController {
	return new CapabilitySettingsController(options);
}

function assignFlag<K extends CapabilityFlagKey>(target: { [P in K]?: boolean }, key: K, value: unknown): void {
	if (typeof value === "boolean") target[key] = value;
}

function assignLimit<K extends CapabilityLimitKey>(target: { [P in K]?: number }, key: K, value: unknown): void {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	const bounds = CAPABILITY_SETTINGS_BOUNDS[key];
	const integer = Math.trunc(value);
	target[key] = Math.min(bounds.max, Math.max(bounds.min, integer));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Read the capability section out of one 0.2.x settings descriptor, whose value is
 * the owning plugin entry's whole Config (`{ capabilities, … }`) rather than the
 * bare section 0.1.x registered under this plugin's own namespace.
 */
function capabilitySectionOf(value: unknown): unknown {
	if (!isPlainObject(value)) return undefined;
	return isPlainObject(value["capabilities"]) ? value["capabilities"] : undefined;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
	for (const key of Object.keys(value)) {
		if (RESERVED_KEYS.has(key) || SECRET_KEY.test(key)) {
			throw new TypeError(`${label} must be secret-free (rejected key ${key})`);
		}
	}
}

function hasOwnKeys(value: object): boolean {
	return Object.keys(value).length > 0;
}

function freezeSnapshot(snapshot: CapabilitySettingsSnapshot): CapabilitySettingsSnapshot {
	return Object.freeze(snapshot);
}

function sameSnapshot(left: CapabilitySettingsSnapshot | undefined, right: CapabilitySettingsSnapshot): boolean {
	if (left === undefined) return false;
	return (
		left.revision === right.revision &&
		left.writable === right.writable &&
		deepEqualJson(left.value, right.value) &&
		deepEqualJson(left.base, right.base) &&
		deepEqualJson(left.user, right.user)
	);
}

function deepEqualJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((entry, index) => deepEqualJson(entry, b[index]));
	}
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => key in right && deepEqualJson(left[key], right[key]));
}

function toConflictError(error: unknown): CapabilitySettingsConflictError | undefined {
	if (error instanceof CapabilitySettingsConflictError) return error;
	if (typeof error !== "object" || error === null) return undefined;
	const candidate = error as { code?: unknown; expected?: unknown; actual?: unknown };
	if (candidate.code !== "SETTINGS_CONFLICT") return undefined;
	if (typeof candidate.expected !== "number" || typeof candidate.actual !== "number") return undefined;
	return new CapabilitySettingsConflictError(candidate.expected, candidate.actual);
}
