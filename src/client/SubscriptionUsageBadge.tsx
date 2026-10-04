import * as primitives from "@deepseek-ai/dsh-client-ui-primitives";
import { useAnchoredPosition, useDismissOnOutsidePointer } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ComponentType, type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type KimiUsage, parseKimiUsage } from "../kimi-usage.ts";
import { jsonRequest } from "./api.ts";
import { CODEX_USAGE_PATH, KIMI_USAGE_PATH, SUBSCRIPTION_USAGE_PATH } from "./constants.ts";
import { hostIcon } from "./host-icons.ts";
import type { GrokBuildSettingsKey } from "./locales.ts";
import { en } from "./locales.ts";
import { parseUsage } from "./parsers.ts";
import type { UsageView } from "./types.ts";
import { useUsageBadgeMode } from "./usage-badge-preferences.ts";

export type IconComponent = ComponentType<{ style?: CSSProperties }>;

const UsageBadgeIcon = hostIcon(primitives, "DataOutline") as unknown as IconComponent;

const USAGE_POLL_INTERVAL_MS = 60_000;
const MODEL_POLL_INTERVAL_MS = 3000;
const PANEL_GAP = 8;
const PANEL_MARGIN = 12;

export interface ModelDirectoriesLike {
	directoryFor(sessionId: string): {
		load(): Promise<{ current: { provider: string; model: string } | null }>;
	};
}

export interface SubscriptionUsageBadgeInjected {
	currentModel: () => Promise<{ provider: string; model: string } | undefined>;
}

export interface SubscriptionUsageBadgeProps {
	readonly currentModel?: SubscriptionUsageBadgeInjected["currentModel"];
	readonly t?: (key: GrokBuildSettingsKey, params?: Record<string, unknown>) => string;
}

export interface UsageWindowDisplay {
	kind: "session" | "weekly" | "other";
	scope?: string | undefined;
	usedPercent: number;
	resetsAt?: number | undefined;
}

export interface AccountUsageDisplay {
	key: string;
	account?: string | undefined;
	plan?: string | undefined;
	isDefault: boolean;
	windows: UsageWindowDisplay[];
	extraLabel?: string | undefined;
	fetchedAt?: number | undefined;
}

export interface ProviderUsageDisplay {
	provider: "codex" | "kimi";
	name: string;
	accounts: AccountUsageDisplay[];
}

/**
 * Map an LLM route or provider id onto the badge's provider key. The model
 * selector's group ids are the plugin's own routes, so this is the bridge
 * between "which model is selected" and "which subscription it spends"; an
 * unknown value is a model outside every supported subscription.
 */
export function providerKeyOf(provider: string | undefined): "codex" | "kimi" | undefined {
	if (!provider) return undefined;
	if (provider === "codex" || provider === "codex-oauth" || provider === "openai-codex") return "codex";
	if (provider === "kimi" || provider === "kimi-code-oauth" || provider === "kimi-coding") return "kimi";
	return undefined;
}

export function windowLabel(w: UsageWindowDisplay): string {
	if (w.resetsAt === undefined) {
		if (w.scope !== undefined && w.scope !== "") return w.scope;
		switch (w.kind) {
			case "session":
				return "5h";
			case "weekly":
				return "Wk";
			default:
				return "W";
		}
	}
	const ms = Math.max(0, w.resetsAt * 1000 - Date.now());
	const minutes = Math.floor(ms / 60_000);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	if (days > 0) return `${days}d${hours % 24}h`;
	if (hours > 0) return `${hours}h${minutes % 60}m`;
	return `${Math.max(1, minutes)}m`;
}

function usedPercent(w: UsageWindowDisplay): number {
	return Math.round(Math.min(100, Math.max(0, w.usedPercent)));
}

export function usageBarColor(percent: number): string {
	if (percent >= 95) return "var(--dsw-alias-state-error-primary)";
	if (percent >= 80) return "var(--dsw-alias-state-warn-label)";
	return "var(--dsw-alias-state-success-primary)";
}

export function compactSegment(
	d: ProviderUsageDisplay,
	_model?: string,
	_t: (key: GrokBuildSettingsKey, params?: Record<string, unknown>) => string = fallbackTranslate,
): string {
	const account = d.accounts.find((a) => a.isDefault) ?? d.accounts[0];
	if (!account || account.windows.length === 0) return d.name;
	const parts = account.windows.slice(0, 2).map((w) => `${windowLabel(w)} ${usedPercent(w)}%`);
	if (account.windows.length > 2) parts.push(`+${account.windows.length - 2}`);
	return `${d.name} ${parts.join(" · ")}`;
}

type ModelSelection = { provider: string; model: string };

export function createCurrentModelReader(
	models: () => ModelDirectoriesLike | undefined,
	sessionId: string,
): SubscriptionUsageBadgeInjected["currentModel"] {
	return async () => {
		const directories = models();
		if (directories === undefined) return undefined;
		const { current } = await directories.directoryFor(sessionId).load();
		return current ?? undefined;
	};
}

function fallbackTranslate(key: GrokBuildSettingsKey, params?: Record<string, unknown>): string {
	const template = en[key] ?? "";
	return template.replace(/\{(\w+)\}/gu, (_, name: string) => String(params?.[name] ?? ""));
}

type Translate = (key: GrokBuildSettingsKey, params?: Record<string, unknown>) => string;

function statsScopeOf(seat: HTMLElement): HTMLElement | null {
	let node: HTMLElement | null = seat.parentElement;
	for (let depth = 0; node !== null && depth < 4; depth++) {
		if (node.querySelector("[data-composer-stats]") !== null) return node;
		node = node.parentElement;
	}
	return seat.parentElement;
}

/** Project one `UsageView` (this plugin's server shape) into badge windows. */
function convertUsageViewToWindows(usage: UsageView): UsageWindowDisplay[] {
	const windows: UsageWindowDisplay[] = [];
	for (const limit of usage.rateLimits) {
		for (const w of limit.windows) {
			if (w.usedPercent === undefined) continue;
			const isSession = w.windowSeconds !== undefined && w.windowSeconds <= 18_000;
			const isWeekly = w.windowSeconds !== undefined && w.windowSeconds >= 604_800;
			windows.push({
				kind: isSession ? "session" : isWeekly ? "weekly" : "other",
				scope: limit.name,
				usedPercent: w.usedPercent,
				...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}),
			});
		}
	}
	return windows;
}

/**
 * The plugin's routes serve already-normalized payloads: `GET /oauth/usage` and
 * `GET /kimi/usage` return the `KimiUsage` projection, while the codex share is
 * the camelCase `CodexUsage` projection `parseUsage` reads directly. Re-parsing
 * the Kimi projection as the provider's raw `/usages` document (the pre-fix
 * behaviour) dropped every window and hid the badge.
 */
function codexWindowsOf(raw: unknown): UsageWindowDisplay[] {
	const usage = parseUsage(raw);
	return usage === undefined ? [] : convertUsageViewToWindows(usage);
}

function kimiWindowsOf(raw: unknown): UsageWindowDisplay[] {
	return convertKimiUsageToWindows(parseKimiUsage(raw));
}

function convertKimiUsageToWindows(usage: KimiUsage): UsageWindowDisplay[] {
	const windows: UsageWindowDisplay[] = [];
	const rows = [...usage.limits, ...(usage.summary ? [usage.summary] : [])];
	for (const row of rows) {
		const usedPercent = Math.round(100 - row.remainingPercent);
		const isSession = row.window?.unit === "hour" && row.window.duration <= 5;
		const isWeekly = row.window?.unit === "week" || (row.window?.unit === "day" && row.window.duration >= 7);
		const resetsAt = row.resetAt ? Math.round(Date.parse(row.resetAt) / 1000) : undefined;
		windows.push({
			kind: isSession ? "session" : isWeekly ? "weekly" : "other",
			scope: row.name ?? (isSession ? "5h" : isWeekly ? "Weekly" : undefined),
			usedPercent,
			...(resetsAt !== undefined && !Number.isNaN(resetsAt) ? { resetsAt } : {}),
		});
	}
	return windows;
}

export function SubscriptionUsageBadge({ currentModel, t }: SubscriptionUsageBadgeProps) {
	const translate: Translate = t ?? fallbackTranslate;
	const [displays, setDisplays] = useState<ProviderUsageDisplay[]>([]);
	const [selection, setSelection] = useState<ModelSelection | undefined>(undefined);
	const displayMode = useUsageBadgeMode();
	const [open, setOpen] = useState(false);
	const [hover, setHover] = useState(false);
	const inflightRef = useRef(false);
	const mountedRef = useRef(true);
	const rootRef = useRef<HTMLSpanElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const seatRef = useRef<HTMLSpanElement | null>(null);
	/** Last selection already in state; guards against duplicate reader answers. */
	const selectedRef = useRef<ModelSelection | undefined>(undefined);

	const refresh = useCallback(async (): Promise<void> => {
		if (inflightRef.current) return;
		inflightRef.current = true;
		try {
			const res = await jsonRequest<{
				providers?: {
					codex?: { supported: boolean; usage?: unknown };
					kimi?: { supported: boolean; usage?: unknown };
				};
			}>(SUBSCRIPTION_USAGE_PATH).catch(() => undefined);

			if (!mountedRef.current) return;

			const newDisplays: ProviderUsageDisplay[] = [];

			// 1. Codex. When the aggregate route answers for a provider, it is
			// authoritative (a `supported: false` share means the server had no
			// usable quota, not that a second route should be guessed at). The
			// per-provider route stays a fallback for older plugin builds whose
			// aggregate omits the provider entirely.
			const codexShare = res?.providers?.codex;
			let codexRaw = codexShare?.usage;
			if (codexShare === undefined) {
				codexRaw = await jsonRequest<unknown>(CODEX_USAGE_PATH).catch(() => undefined);
			}
			const codexWindows = codexWindowsOf(codexRaw);
			if (codexWindows.length > 0) {
				newDisplays.push({
					provider: "codex",
					name: "Codex",
					accounts: [{ key: "default", isDefault: true, windows: codexWindows }],
				});
			}

			// 2. Kimi
			const kimiShare = res?.providers?.kimi;
			let kimiRaw = kimiShare?.usage;
			if (kimiShare === undefined) {
				kimiRaw = await jsonRequest<unknown>(KIMI_USAGE_PATH).catch(() => undefined);
			}
			const kimiUsage = parseKimiUsage(kimiRaw);
			const kimiWindows = kimiWindowsOf(kimiUsage);
			if (kimiWindows.length > 0) {
				const extra = kimiUsage.extraUsage;
				const extraLabel = extra
					? `Booster: ${(extra.balanceCents / 100).toFixed(2)} / ${(extra.totalCents / 100).toFixed(2)} ${extra.currency}`
					: undefined;
				newDisplays.push({
					provider: "kimi",
					name: "Kimi",
					accounts: [
						{ key: "default", isDefault: true, windows: kimiWindows, extraLabel, fetchedAt: kimiUsage.fetchedAt },
					],
				});
			}

			setDisplays(newDisplays);
		} catch {
			// Failed poll must not crash badge
		} finally {
			inflightRef.current = false;
		}
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	useEffect(() => {
		if (displayMode === "hidden") return;
		void refresh();
		const timer = setInterval(() => {
			void refresh();
		}, USAGE_POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [refresh, displayMode]);

	useEffect(() => {
		if (currentModel === undefined) return;
		let cancelled = false;
		let inflight = false;
		const reload = (): void => {
			if (inflight) return;
			inflight = true;
			void currentModel()
				.then(
					(model) => {
						if (cancelled) return;
						// The reader answers with a fresh object on every poll, and a
						// repeated selection is not a state change.
						const seen = selectedRef.current;
						if (seen?.provider === model?.provider && seen?.model === model?.model) return;
						selectedRef.current = model;
						setSelection(model);
					},
					() => {},
				)
				.finally(() => {
					inflight = false;
				});
		};
		reload();
		const timer = setInterval(reload, MODEL_POLL_INTERVAL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [currentModel]);

	const pos = useAnchoredPosition({
		open,
		anchorRef: rootRef,
		panelRef,
		side: "top",
		gap: PANEL_GAP,
		margin: PANEL_MARGIN,
	});
	useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open]);

	const [statsRow, setStatsRow] = useState<HTMLElement | null>(null);
	useEffect(() => {
		const seat = seatRef.current;
		if (seat === null) return;
		const scope = statsScopeOf(seat);
		if (scope === null) return;
		const find = (): HTMLElement | null => scope.querySelector<HTMLElement>("[data-composer-stats]");
		setStatsRow(find());
		const observer = new MutationObserver(() => {
			setStatsRow(find());
		});
		observer.observe(scope, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (displayMode === "hidden") setOpen(false);
	}, [displayMode]);

	const seat = <span ref={seatRef} style={styles.seat} aria-hidden />;
	if (displayMode === "hidden" || displays.length === 0) return seat;

	// Only the subscription behind the selected model: an unresolved selection,
	// a model outside every supported subscription, or a provider that reports
	// no usage each render nothing rather than some other provider's quota.
	const targetKey = providerKeyOf(selection?.provider);
	if (targetKey === undefined) return seat;
	const activeDisplay = displays.find((disp) => disp.provider === targetKey);
	if (activeDisplay === undefined) return seat;

	const label = compactSegment(activeDisplay, selection?.model, translate);
	const title = translate("usageBadgeTitle");

	const toggle = (): void => {
		const next = !open;
		setOpen(next);
		if (next) void refresh();
	};

	const orderedDisplays = [activeDisplay, ...displays.filter((disp) => disp !== activeDisplay)];

	const pill = (
		<span ref={rootRef} style={styles.anchor}>
			<button
				type="button"
				style={{ ...styles.pill, ...(hover || open ? styles.pillActive : {}) }}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={`${title} · ${label}`}
				title={title}
				onMouseEnter={() => setHover(true)}
				onMouseLeave={() => setHover(false)}
				onClick={toggle}
			>
				<UsageBadgeIcon />
				<span style={styles.label}>{label}</span>
			</button>
			{open &&
				createPortal(
					<div ref={panelRef} role="dialog" aria-label={title} style={{ ...styles.panel, ...(pos ?? MEASURE_STYLE) }}>
						<div style={styles.title}>
							<span style={styles.titleLabel}>
								<UsageBadgeIcon />
								{title}
							</span>
						</div>
						<div style={styles.titleRule} aria-hidden />
						{orderedDisplays.map((disp, index) => (
							<section key={disp.provider} style={index === 0 ? undefined : styles.section}>
								<div style={styles.providerRow}>
									<span style={styles.providerName}>
										{disp.name}
										{disp === activeDisplay ? (
											<span style={styles.currentTag}>{translate("usageBadgeCurrent")}</span>
										) : null}
									</span>
								</div>
								{disp.accounts.map((account) => (
									<div key={account.key} style={styles.accountBlock}>
										<dl style={styles.details}>
											{account.windows.map((w, windowIndex) => {
												const percent = usedPercent(w);
												return (
													<div
														key={`${w.kind}-${w.scope ?? "default"}-${String(windowIndex)}`}
														style={styles.windowItem}
													>
														<dt style={styles.dt}>
															{w.kind === "session"
																? translate("usageSession")
																: w.kind === "weekly"
																	? translate("usageWeekly")
																	: translate("usageWindow")}
															{w.scope ? ` · ${w.scope}` : ""}
														</dt>
														<dd style={styles.dd}>
															{percent}%
															{w.resetsAt !== undefined && <span style={styles.reset}> · {windowLabel(w)}</span>}
														</dd>
														<div style={styles.bar} aria-hidden>
															<div
																style={{
																	...styles.barFill,
																	width: `${percent}%`,
																	background: usageBarColor(percent),
																}}
															/>
														</div>
													</div>
												);
											})}
										</dl>
										{account.extraLabel ? (
											<div style={{ marginTop: 6, fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }}>
												{account.extraLabel}
											</div>
										) : null}
									</div>
								))}
							</section>
						))}
					</div>,
					document.body,
				)}
		</span>
	);

	return (
		<>
			{seat}
			{statsRow?.isConnected ? createPortal(pill, statsRow) : pill}
		</>
	);
}

const MEASURE_STYLE: CSSProperties = { visibility: "hidden", left: 0, top: 0 };

/**
 * Inline style map that also accepts CSS custom properties: the panel rebinds
 * `--dsw-elevation-stroke-color`, which React's `CSSProperties` does not name.
 */
type StyleMap = Record<string, CSSProperties & Record<`--${string}`, string>>;

const styles: StyleMap = {
	seat: { display: "none" },
	anchor: { minWidth: 0, maxWidth: "100%", display: "inline-flex" },
	pill: {
		boxSizing: "border-box",
		maxWidth: "100%",
		color: "var(--dsw-alias-label-tertiary)",
		font: "inherit",
		fontSize: "var(--dsh-content-font-size-secondary, 13px)",
		fontVariantNumeric: "tabular-nums",
		lineHeight: "20px",
		whiteSpace: "nowrap",
		background: "transparent",
		border: "none",
		borderRadius: 24,
		alignItems: "center",
		gap: 6,
		padding: "1px 8px",
		display: "inline-flex",
		cursor: "pointer",
	},
	pillActive: {
		background: "var(--dsw-alias-interactive-bg-hover)",
		color: "var(--dsw-alias-label-secondary)",
	},
	label: { textOverflow: "ellipsis", minWidth: 0, overflow: "hidden" },
	// The DSH stat-dialog skin (ui-chat stat-dialog.module.css): menu surface,
	// `--dsw-menu-backdrop-filter` transparency/blur, and the elevation-prominent
	// stroke triple. Without the backdrop filter the semi-transparent menu fill
	// lets the composer (model selector, submit button) read through the panel.
	panel: {
		position: "fixed",
		zIndex: 1100,
		boxSizing: "border-box",
		background: "var(--dsw-specific-menu)",
		backdropFilter: "var(--dsw-menu-backdrop-filter)",
		// Rebound stroke color: the elevation shadow substitutes it at this element.
		"--dsw-elevation-stroke-color": "var(--dsw-alias-border-l1)",
		width: "max-content",
		minWidth: "min(300px, 100vw - 24px)",
		maxWidth: "min(440px, 100vw - 24px)",
		maxHeight: "min(560px, 100dvh - 24px)",
		overflowY: "auto",
		overscrollBehavior: "contain",
		boxShadow: "var(--dsw-elevation-prominent)",
		color: "var(--dsw-alias-label-secondary)",
		cursor: "default",
		border: 0,
		borderRadius: "var(--dsw-radius-lg, 16px)",
		padding: 16,
		fontSize: 12,
		lineHeight: "18px",
	},
	title: {
		color: "var(--dsw-alias-label-primary)",
		display: "flex",
		justifyContent: "space-between",
		gap: 16,
		marginBottom: 8,
		fontWeight: 500,
	},
	titleLabel: { alignItems: "center", gap: 6, minWidth: 0, display: "inline-flex" },
	titleRule: { borderTop: "0.5px solid var(--dsw-alias-border-l2)", marginBottom: 10 },
	// One rule per provider section, identical to the title rule under a heading.
	section: { marginTop: 12, paddingTop: 10, borderTop: "0.5px solid var(--dsw-alias-border-l2)" },
	providerRow: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "baseline",
		gap: 16,
		marginBottom: 6,
	},
	providerName: {
		color: "var(--dsw-alias-label-primary)",
		fontWeight: 500,
		display: "inline-flex",
		alignItems: "center",
		gap: 6,
	},
	currentTag: {
		fontSize: 10,
		lineHeight: "14px",
		fontWeight: 400,
		padding: "0 5px",
		borderRadius: "var(--dsw-radius-sm, 8px)",
		color: "var(--dsw-alias-label-secondary)",
		background: "var(--dsw-alias-interactive-bg-hover)",
	},
	accountBlock: { marginTop: 8 },
	details: { margin: 0, padding: 0 },
	windowItem: {
		color: "var(--dsw-alias-label-tertiary)",
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) max-content",
		gap: "6px 16px",
		marginBottom: 8,
	},
	dt: { minWidth: 0, margin: 0, overflowWrap: "anywhere" },
	dd: {
		minWidth: 0,
		margin: 0,
		color: "var(--dsw-alias-label-secondary)",
		fontVariantNumeric: "tabular-nums",
		textAlign: "right",
	},
	reset: { color: "var(--dsw-alias-label-tertiary)" },
	bar: {
		gridColumn: "1 / -1",
		height: 4,
		borderRadius: 2,
		overflow: "hidden",
		background: "var(--dsw-alias-border-l2)",
		marginBottom: 2,
	},
	barFill: { height: "100%", borderRadius: 2 },
};
