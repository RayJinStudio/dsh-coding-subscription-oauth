/**
 * WorkBuddy provider card: account state, one-click daily check-in, remaining
 * credits, model enable/disable, and per-model context length.
 *
 * The card is read-only about the credential: the WorkBuddy desktop app owns the
 * sign-in, so there is no login form here. The only write actions are the model
 * selection, a context budget, and the explicit check-in — and the check-in is a
 * real one-per-day grant, so it is a button and never a timer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { jsonRequest } from "../api.ts";
import { WORKBUDDY_CHECKIN_PATH, WORKBUDDY_MODELS_PATH, WORKBUDDY_STATUS_PATH } from "../constants.ts";
import type { GrokBuildSettingsKey } from "../locales.ts";
import {
	authFileBadgeRowStyle,
	authFileCardMutedStyle,
	authFileCardSelectedStyle,
	authFileCardStyle,
	authFileGridStyle,
	authFileRadioStyle,
	badgeStyle,
	bodyStyle,
	buttonStyle,
	cardStyle,
	checkRowStyle,
	compactButtonStyle,
	compactPrimaryButtonStyle,
	errorStyle,
	hintStyle,
	monoStyle,
	nestedStyle,
	rowStyle,
	successStyle,
	TRANSITION,
	titleStyle,
} from "../styles.ts";
import type {
	GrokBuildSettingsInjected,
	WorkBuddyAuthFileView,
	WorkBuddyCheckinResult,
	WorkBuddyCheckinView,
	WorkBuddyModelView,
	WorkBuddyView,
} from "../types.ts";

/** Context-length preset offered on top of a model's own window. */
const CONTEXT_PRESETS: readonly number[] = [200_000, 500_000];

/**
 * Preset tiers a model's own window can reach.
 *
 * A tier ABOVE the model's window is deliberately omitted: offering "500K" to a
 * 192K model would persist a budget that `Math.min` silently discards, so the
 * radio would read as a chosen downgrade while changing nothing. The native
 * window is always the last tier, and an exact tie is not duplicated.
 */
export function contextTiersFor(nativeContextWindow: number): number[] {
	const tiers = CONTEXT_PRESETS.filter((preset) => preset < nativeContextWindow);
	return [...tiers, nativeContextWindow];
}

/** Render a tier as a short label: 200K, 500K, 1M. */
export function formatContextTier(tokens: number): string {
	if (tokens >= 1_000_000) {
		const millions = tokens / 1_000_000;
		return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
	}
	return `${Math.round(tokens / 1000)}K`;
}

/** The app's current sign-in file; every other `.info` beside it is a rotation backup. */
const WORKBUDDY_LIVE_BASENAME = "workbuddy-desktop.info";

/** The final path segment, tolerating either separator since paths can be Windows-shaped. */
function authFileBasename(path: string): string {
	const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return separator === -1 ? path : path.slice(separator + 1);
}

/**
 * How a credential file is described when its account is not known.
 *
 * The full path is deliberately NOT the label. It is long, it is the same for
 * every candidate bar the last segment, and wrapping it dominated the section
 * while telling the user nothing they act on — what they pick by is the account
 * in the file and whether it is the live sign-in.
 */
export function authFileRoleKey(file: WorkBuddyAuthFileView): GrokBuildSettingsKey {
	if (file.source === "dsh") return "workbuddyAuthFileSourceDsh";
	return authFileBasename(file.path) === WORKBUDDY_LIVE_BASENAME
		? "workbuddyAuthFilePrimary"
		: "workbuddyAuthFileBackup";
}

/**
 * The app's rotation stamp for a backup, read out of its filename.
 *
 * Parsing rather than displaying: `workbuddy-desktop.2026-10-04T14-44-28-667Z.<pid>.<uuid>.info`
 * is unreadable as a name, but the timestamp inside it is exactly what tells two
 * backups apart. Returns undefined for a name without the stamp, which is not an
 * error — the live file simply has none.
 */
export function authFileStamp(path: string): string | undefined {
	const match = /^workbuddy-desktop\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/u.exec(authFileBasename(path));
	if (match === null) return undefined;
	return `${match[1]} ${match[2]}:${match[3]}`;
}

/** The locale key explaining why a file yielded no credential. */
export function authFileReasonKey(reason: string | undefined): GrokBuildSettingsKey {
	switch (reason) {
		case "missing":
			return "workbuddyAuthReasonMissing";
		case "unreadable":
			return "workbuddyAuthReasonUnreadable";
		case "invalid":
			return "workbuddyAuthReasonInvalid";
		case "encrypted":
			return "workbuddyAuthReasonEncrypted";
		case "wrong-region":
			return "workbuddyAuthReasonWrongRegion";
		default:
			return "workbuddyAuthFileUnreadable";
	}
}

export interface WorkBuddyCardProps extends GrokBuildSettingsInjected {
	onStartConversation?: (() => void) | undefined;
}

export function WorkBuddyCard({ t, onStartConversation }: WorkBuddyCardProps) {
	const [view, setView] = useState<WorkBuddyView | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [checking, setChecking] = useState(false);
	const [notice, setNotice] = useState<string | undefined>(undefined);
	/** The auth file a switch is currently being applied to. */
	const [fileSwitching, setFileSwitching] = useState<string | undefined>(undefined);
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const load = useCallback(async (): Promise<void> => {
		try {
			const next = await jsonRequest<WorkBuddyView>(WORKBUDDY_STATUS_PATH);
			if (!mounted.current) return;
			setView(next);
			setError(undefined);
		} catch (failure: unknown) {
			if (!mounted.current) return;
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const applyView = (next: WorkBuddyView): void => {
		if (!mounted.current) return;
		setView(next);
	};

	const refreshModels = async (): Promise<void> => {
		setRefreshing(true);
		try {
			applyView(await jsonRequest<WorkBuddyView>(WORKBUDDY_MODELS_PATH, "POST", { action: "refresh" }));
			setError(undefined);
		} catch (failure: unknown) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setRefreshing(false);
		}
	};

	const toggleModel = async (model: WorkBuddyModelView, enabled: boolean): Promise<void> => {
		if (view === undefined) return;
		const current = new Set(view.catalog.enabledModelIds);
		if (enabled) current.add(model.id);
		else current.delete(model.id);
		const enabledIds = view.catalog.models.map((entry) => entry.id).filter((id) => current.has(id));
		setBusy(true);
		try {
			applyView(
				await jsonRequest<WorkBuddyView>(WORKBUDDY_MODELS_PATH, "POST", {
					action: "select",
					// Switching the LAST model off is an explicit empty selection ("serve
					// nothing"), which is a different intent from clearing the selection
					// ("serve everything"). `null` is the latter and is only sent when the
					// user re-enables a model onto a full roster.
					selected: enabledIds.length === 0 ? [] : enabledIds.length === view.catalog.models.length ? null : enabledIds,
				}),
			);
			setError(undefined);
		} catch (failure: unknown) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(false);
		}
	};

	const setBudget = async (modelId: string, budget: number): Promise<void> => {
		setBusy(true);
		try {
			applyView(await jsonRequest<WorkBuddyView>(WORKBUDDY_MODELS_PATH, "POST", { action: "budget", modelId, budget }));
			setError(undefined);
		} catch (failure: unknown) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(false);
		}
	};

	/**
	 * Point credential discovery at one auth file, or back at the defaults.
	 *
	 * `null` means "no override", which is a different request from selecting the
	 * file that happens to be the default: only the former follows a future change
	 * of the platform layout.
	 */
	const chooseAuthFile = async (path: string | undefined): Promise<void> => {
		setBusy(true);
		setFileSwitching(path);
		try {
			applyView(
				await jsonRequest<WorkBuddyView>(WORKBUDDY_MODELS_PATH, "POST", {
					action: "authFile",
					path: path ?? null,
				}),
			);
			setError(undefined);
		} catch (failure: unknown) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(false);
			setFileSwitching(undefined);
		}
	};

	/** Re-scan for auth files without changing the selection. */
	const rescanAuthFiles = async (): Promise<void> => {
		setRefreshing(true);
		try {
			applyView(await jsonRequest<WorkBuddyView>(`${WORKBUDDY_STATUS_PATH}?checkin=0`));
			setError(undefined);
		} catch (failure: unknown) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setRefreshing(false);
		}
	};

	const claimCheckin = async (): Promise<void> => {
		setChecking(true);
		try {
			const result = await jsonRequest<WorkBuddyCheckinResult>(WORKBUDDY_CHECKIN_PATH, "POST", {});
			if (!mounted.current) return;
			if (result.alreadyCheckedIn) setNotice(t("workbuddyCheckinAlready"));
			else {
				const credit = result.claim?.credit ?? result.checkin.todayCredit;
				setNotice(t("workbuddyCheckinSuccess", { credits: String(credit) }));
			}
			setError(undefined);
			await load();
		} catch (failure: unknown) {
			if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setChecking(false);
		}
	};

	if (view === undefined) {
		return (
			<div style={cardStyle} role="status" aria-busy={error === undefined}>
				<h3 style={titleStyle}>{t("workbuddyTitle")}</h3>
				<p style={bodyStyle}>{error ?? t("loadingAccount")}</p>
			</div>
		);
	}

	const signedIn = view.provider.state === "signed-in";
	const regionLabel = view.provider.region === "global" ? t("workbuddyRegionGlobal") : t("workbuddyRegionCn");
	const checkin = view.checkin;

	return (
		<div style={cardStyle}>
			<div style={rowStyle}>
				<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
					<div>
						<h3 style={{ ...titleStyle, fontSize: 16 }}>{t("workbuddyTitle")}</h3>
						<p style={{ ...bodyStyle, marginTop: 4 }}>{t("workbuddyDescription")}</p>
					</div>
				</div>
				<span
					style={{
						...bodyStyle,
						color: signedIn ? "var(--dsw-alias-state-success-primary, #22a06b)" : "var(--dsw-alias-label-secondary)",
						fontWeight: 600,
					}}
				>
					{signedIn ? t("workbuddySignedIn") : t("workbuddySignedOut")}
				</span>
			</div>

			{error === undefined ? null : (
				<p style={errorStyle} role="alert">
					{error}
				</p>
			)}

			{notice === undefined ? null : (
				<p style={successStyle} role="status">
					{notice}
				</p>
			)}

			{/* The auth-file switcher is shown in BOTH states on purpose: the moment a
			    user most needs to point discovery at another file is when the current
			    one is unreadable, which is exactly when the card reads as signed out. */}
			<AuthFileSection
				t={t}
				files={view.authFiles}
				override={view.authFileOverride}
				busy={busy}
				switching={fileSwitching}
				refreshing={refreshing}
				onChoose={(path) => {
					void chooseAuthFile(path);
				}}
				onRescan={() => {
					void rescanAuthFiles();
				}}
			/>

			{!signedIn ? (
				<>
					<p style={hintStyle}>{t("workbuddySignedOutHint")}</p>
					<p style={hintStyle}>{t("workbuddyEncryptedHint")}</p>
					<p style={hintStyle}>
						{t("workbuddyDesktopFile")}:{" "}
						{view.desktopFilePresent ? t("workbuddyDesktopFilePresent") : t("workbuddyDesktopFileMissing")}
					</p>
				</>
			) : (
				<>
					<div style={nestedStyle}>
						<div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
							<span style={bodyStyle}>
								{regionLabel}
								{view.provider.domain === undefined ? "" : ` · ${view.provider.domain}`}
							</span>
							{view.provider.nickname === undefined ? null : (
								<span style={bodyStyle}>
									{t("workbuddyAccount")}: {view.provider.nickname}
								</span>
							)}
							{view.provider.expiresAtMs === undefined ? null : (
								<span style={bodyStyle}>
									{t("workbuddyExpires")}: {new Date(view.provider.expiresAtMs).toLocaleString()}
								</span>
							)}
						</div>
						<div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 6 }}>
							{view.credits === undefined ? null : (
								<span style={bodyStyle}>
									{t("workbuddyCredits")}:{" "}
									{t("workbuddyCreditsTotal", {
										remaining: String(Math.round(view.credits.totalRemaining)),
										count: String(view.credits.totalCount),
									})}
								</span>
							)}
							{view.creditsError === undefined ? null : <span style={errorStyle}>{view.creditsError}</span>}
						</div>
						{/* Per package, because the aggregate alone cannot show which one is
						    running out. `remaining` is already the figure the user spends
						    down, so a monthly package reads as its current cycle. */}
						{view.credits === undefined || view.credits.packages.length === 0 ? null : (
							<div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 4 }}>
								{view.credits.packages.map((entry) => (
									<span key={entry.dealName} style={hintStyle}>
										{entry.packageName ?? entry.dealName}:{" "}
										{t("workbuddyCreditsCycle", {
											remaining: String(Math.round(entry.remaining)),
											total: String(Math.round(entry.total)),
										})}
										{entry.monthly ? ` · ${t("workbuddyCreditsMonthly")}` : ""}
										{entry.cycleEndTime === undefined ? "" : ` · ${entry.cycleEndTime}`}
									</span>
								))}
							</div>
						)}
					</div>

					{/* Daily check-in: an explicit user action, never a timer. */}
					<div style={{ ...nestedStyle, marginTop: 12 }}>
						<div style={rowStyle}>
							<strong style={titleStyle}>{t("workbuddyCheckin")}</strong>
							{checkin === undefined || !view.checkinSupported ? null : checkin.active ? (
								<button
									type="button"
									style={checkin.todayCheckedIn ? compactButtonStyle : compactPrimaryButtonStyle}
									disabled={checking || checkin.todayCheckedIn}
									onClick={() => {
										void claimCheckin();
									}}
								>
									{checkin.todayCheckedIn ? t("workbuddyCheckinDone") : t("workbuddyCheckinAction")}
								</button>
							) : (
								<span style={hintStyle}>{t("workbuddyCheckinInactive")}</span>
							)}
						</div>
						{checkin === undefined ? (
							<p style={hintStyle}>
								{view.checkinSupported ? (view.checkinError ?? t("workbuddyError")) : t("workbuddyCheckinUnsupported")}
							</p>
						) : (
							<CheckinFacts t={t} checkin={checkin} />
						)}
					</div>

					{/* Model enable/disable, context length, fixed image policy. */}
					<div style={{ ...nestedStyle, marginTop: 12 }}>
						<div style={rowStyle}>
							<strong style={titleStyle}>{t("workbuddyModels")}</strong>
							<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
								<span style={hintStyle}>
									{view.catalog.enabledModelIds.length === 0
										? t("workbuddyModelsSelected", {
												enabled: "0",
												total: String(view.catalog.models.length),
											})
										: view.catalog.enabledModelIds.length === view.catalog.models.length
											? t("workbuddyModelsAll")
											: t("workbuddyModelsSelected", {
													enabled: String(view.catalog.enabledModelIds.length),
													total: String(view.catalog.models.length),
												})}
								</span>
								<button
									type="button"
									style={compactButtonStyle}
									disabled={refreshing}
									onClick={() => {
										void refreshModels();
									}}
								>
									{refreshing ? t("workbuddyModelsRefreshing") : t("workbuddyModelsRefresh")}
								</button>
							</div>
						</div>
						<p style={hintStyle}>
							{view.catalog.source === "live" ? t("workbuddyCatalogLive") : t("workbuddyCatalogFallback")}
							{view.catalog.error === undefined ? "" : ` — ${view.catalog.error}`}
						</p>
						<p style={hintStyle}>{t("workbuddyContextHint")}</p>
						<p style={hintStyle}>{t("workbuddyImageFixed")}</p>
						<ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
							{view.catalog.models.map((model) => (
								<ModelRow
									key={model.id}
									t={t}
									model={model}
									enabled={model.enabled}
									busy={busy}
									onToggle={(next) => {
										void toggleModel(model, next);
									}}
									onBudget={(budget) => {
										void setBudget(model.id, budget);
									}}
								/>
							))}
						</ul>
					</div>

					{onStartConversation === undefined ? null : (
						<button type="button" style={buttonStyle} onClick={onStartConversation}>
							{t("opencodeGoStartConversation")}
						</button>
					)}
				</>
			)}
		</div>
	);
}

function CheckinFacts({ t, checkin }: { t: GrokBuildSettingsInstalled; checkin: WorkBuddyCheckinView }) {
	return (
		<div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 4 }}>
			<span style={bodyStyle}>
				{t("workbuddyCheckinStreak")}: {t("workbuddyCheckinDays", { days: String(checkin.streakDays) })}
			</span>
			<span style={bodyStyle}>
				{t("workbuddyCheckinToday")}: {t("workbuddyCheckinCredits", { credits: String(checkin.todayCredit) })}
			</span>
		</div>
	);
}

/**
 * Auth-file picker.
 *
 * The platform defaults miss a redirected profile, a second install, or a file
 * kept elsewhere, so every discovered candidate is listed with its own state and
 * the user picks one by clicking rather than by typing a path. Unreadable files
 * stay listed and selectable: choosing one is how you find out it is empty, and
 * hiding it would make a typo look like a missing feature.
 */
function AuthFileSection({
	t,
	files,
	override,
	busy,
	switching,
	refreshing,
	onChoose,
	onRescan,
}: {
	t: GrokBuildSettingsInstalled;
	files: readonly WorkBuddyAuthFileView[] | undefined;
	override: string | undefined;
	busy: boolean;
	switching: string | undefined;
	refreshing: boolean;
	onChoose: (path: string | undefined) => void;
	onRescan: () => void;
}) {
	// Defensive: the client bundle and the server bundle are installed separately,
	// so a freshly-loaded card can briefly talk to a server build that predates
	// this field. An absent list renders as "nothing found" rather than crashing
	// the whole settings panel.
	const listed = files ?? [];
	return (
		<div style={{ ...nestedStyle, marginTop: 12 }}>
			<div style={rowStyle}>
				<strong style={titleStyle}>{t("workbuddyAuthFile")}</strong>
				<button type="button" style={compactButtonStyle} disabled={refreshing} onClick={onRescan}>
					{refreshing ? t("workbuddyModelsRefreshing") : t("workbuddyAuthFileRescan")}
				</button>
			</div>
			<p style={hintStyle}>{t("workbuddyAuthFileHint")}</p>
			{/* A radio group, so the card is one tab stop and arrow keys move between
			    choices. The cards are labels rather than buttons: clicking anywhere
			    in one selects it, which is the whole affordance. */}
			<fieldset
				style={{
					border: "none",
					margin: 0,
					padding: 0,
					display: "grid",
					gap: 10,
				}}
			>
				<legend style={{ ...hintStyle, padding: 0, marginBottom: 8 }}>{t("workbuddyAuthFile")}</legend>
				<div style={authFileGridStyle}>
					{/* Selecting the defaults is its own choice: it follows the platform layout
					    if that moves, which pinning the current default would not. */}
					<label style={override === undefined ? authFileCardSelectedStyle : authFileCardMutedStyle}>
						<input
							type="radio"
							name="workbuddy-auth-file"
							style={authFileRadioStyle}
							checked={override === undefined}
							disabled={busy}
							onChange={() => onChoose(undefined)}
						/>
						<span style={{ display: "grid", gap: 4, minWidth: 0 }}>
							<span style={{ ...bodyStyle, fontWeight: 500, color: "var(--dsw-alias-label-primary)" }}>
								{t("workbuddyAuthFileDefault")}
							</span>
							<span style={hintStyle}>{t("workbuddyAuthFileDefaultHint")}</span>
						</span>
					</label>
					{listed.map((file) => {
						const selected = override !== undefined && override === file.path;
						const stamp = authFileStamp(file.path);
						// The account is the heading when it is known; a file with no
						// readable account says so rather than showing a bare path.
						const heading = file.readable
							? file.accountName === undefined || file.accountName === ""
								? t("workbuddyAuthFileAccountUnknown")
								: file.accountName
							: t("workbuddyAuthFileAccountUnknown");
						return (
							<label key={file.path} style={selected ? authFileCardSelectedStyle : authFileCardStyle}>
								<input
									type="radio"
									name="workbuddy-auth-file"
									style={authFileRadioStyle}
									checked={selected}
									disabled={busy}
									onChange={() => onChoose(file.path)}
								/>
								<span style={{ display: "grid", gap: 4, minWidth: 0 }}>
									<span
										style={{
											...bodyStyle,
											fontWeight: 500,
											color: "var(--dsw-alias-label-primary)",
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
										}}
									>
										{heading}
									</span>
									{/* The role and the rotation stamp, never the location: the path is
									    long and identical across candidates, so it identifies nothing. */}
									<span style={hintStyle}>
										{t(authFileRoleKey(file))}
										{stamp === undefined ? "" : ` · ${stamp}`}
									</span>
									<span style={authFileBadgeRowStyle}>
										{switching === file.path ? (
											<span style={badgeStyle("info")}>{t("workbuddyAuthFileSwitching")}</span>
										) : null}
										{file.active ? <span style={badgeStyle("success")}>{t("workbuddyAuthFileActive")}</span> : null}
										{/* Exactly one badge explains the file: readable ones report their
										    region and account, unreadable ones report the cause. Both is
										    noise, and neither is a reason to hide the choice. */}
										{file.readable ? (
											<span style={badgeStyle("neutral")}>
												{file.region === "global" ? t("workbuddyRegionGlobal") : t("workbuddyRegionCn")}
											</span>
										) : (
											<span style={badgeStyle("warning")}>{t(authFileReasonKey(file.reason))}</span>
										)}
									</span>
								</span>
							</label>
						);
					})}
				</div>
				{listed.length === 0 ? <span style={hintStyle}>{t("workbuddyAuthFileNone")}</span> : null}
			</fieldset>
		</div>
	);
}

type GrokBuildSettingsInstalled = GrokBuildSettingsInjected["t"];

/** One model row: enable checkbox, credit rate, and context-length tiers. */
function ModelRow({
	t,
	model,
	enabled,
	busy,
	onToggle,
	onBudget,
}: {
	t: GrokBuildSettingsInstalled;
	model: WorkBuddyModelView;
	enabled: boolean;
	busy: boolean;
	onToggle: (enabled: boolean) => void;
	onBudget: (budget: number) => void;
}) {
	const tiers = contextTiersFor(model.nativeContextWindow);
	const active = model.contextWindow;
	return (
		<li style={{ ...nestedStyle, marginBottom: 8 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
				<label style={{ ...checkRowStyle, display: "inline-flex", alignItems: "center", gap: 6 }}>
					<input
						type="checkbox"
						checked={enabled}
						disabled={busy}
						onChange={(event) => onToggle(event.target.checked)}
					/>
					<span style={bodyStyle}>{model.name}</span>
				</label>
				<span style={{ ...hintStyle, ...monoStyle }}>{model.id}</span>
				{model.creditMultiplier === undefined ? null : (
					<span style={hintStyle}>
						{model.creditMultiplier === 0 ? t("workbuddyFree") : `x${model.creditMultiplier}`}
					</span>
				)}
				{model.takesImages ? <span style={hintStyle}>image</span> : null}
				{model.reasoning ? <span style={hintStyle}>reasoning</span> : null}
			</div>
			<fieldset
				className="dsm-workbuddy-context-budget"
				style={{ border: "none", margin: "4px 0 0", padding: 0, display: "flex", gap: 10, flexWrap: "wrap" }}
			>
				<legend style={{ ...hintStyle, padding: 0 }}>{t("workbuddyContextLength")}</legend>
				{tiers.map((tier) => (
					<label
						key={tier}
						style={{ ...checkRowStyle, display: "inline-flex", alignItems: "center", gap: 4, transition: TRANSITION }}
					>
						<input
							type="radio"
							name={`workbuddy-context-${model.id}`}
							checked={active === tier}
							disabled={busy}
							onChange={() => onBudget(tier)}
						/>
						<span>
							{tier === model.nativeContextWindow
								? `${formatContextTier(tier)} · ${t("workbuddyContextNative")}`
								: formatContextTier(tier)}
						</span>
					</label>
				))}
			</fieldset>
		</li>
	);
}
