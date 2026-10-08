import { useEffect, useRef, useState } from "react";
import { GO_APIS, type GoApi, isGoApi, knownGoApi } from "../../opencode-go-protocol.ts";
import {
	bodyStyle,
	buttonStyle,
	cardStyle,
	checkRowStyle,
	compactButtonStyle,
	errorStyle,
	hintStyle,
	inputStyle,
	monoStyle,
	nestedStyle,
	primaryButtonStyle,
	titleStyle,
	warningStyle,
} from "../styles.ts";
import { Badge } from "./Badge.tsx";
import { ProviderIcon } from "./ProviderIcons.tsx";

export interface GoModel {
	readonly id: string;
	readonly name?: string | undefined;
	readonly contextWindow?: number | undefined;
	readonly maxTokens?: number | undefined;
	readonly protocol?: string | undefined;
	readonly reasoningEfforts?: false | Record<string, string | null> | undefined;
}
export interface GoSnapshot {
	readonly providerId?: string;
	readonly credential: {
		readonly selectedRef: string;
		readonly configured: boolean;
		readonly writable: boolean;
		readonly requiresChoice: boolean;
		readonly candidates: readonly { readonly ref: string; readonly configured: boolean; readonly writable: boolean }[];
	};
	readonly configuration: {
		readonly api?: string | null | undefined;
		readonly revision: number | null;
		readonly writable: boolean;
		readonly ready: boolean;
		readonly conflicts: readonly string[];
		readonly models: readonly GoModel[];
	};
	readonly legacy?: {
		readonly providerId: string;
		readonly present: boolean;
		readonly migratable: boolean;
		readonly targetProviderId: string;
	};
	readonly call: {
		readonly active: boolean;
		readonly lastCall: "no-call" | "success" | "failure" | "missing-session";
		readonly updatedAt: number | null;
		readonly pending?: boolean | undefined;
		readonly streamStatus?: string | undefined;
		readonly configurationConflict?: boolean | undefined;
	};
}
export type GoViewKey =
	| "protocol"
	| "protocolHint"
	| "title"
	| "description"
	| "configured"
	| "unconfigured"
	| "credential"
	| "apiKey"
	| "apiKeyPlaceholder"
	| "reuseHint"
	| "reuse"
	| "saveKey"
	| "clearKey"
	| "clearKeyConfirm"
	| "credentialCleared"
	| "fetchModels"
	| "model"
	| "modelsEmpty"
	| "chooseCredential"
	| "apply"
	| "startConversation"
	| "edit"
	| "cancel"
	| "reload"
	| "credentialSaved"
	| "directoryLoaded"
	| "applied"
	| "readOnly"
	| "configurationChanged"
	| "conflictPreview"
	| "confirmConflict"
	| "legacyMigration"
	| "migrate"
	| "providerIdHint"
	| "status.no-call"
	| "status.success"
	| "status.failure"
	| "status.missing-session"
	| "status.pending"
	| "status.cancelled"
	| "status.conflict"
	| "regionOptIn";
export interface GoViewProps {
	readonly status: GoSnapshot | undefined;
	readonly call?: GoSnapshot["call"];
	readonly loadError?: string;
	readonly t: (key: GoViewKey, params?: Record<string, string | number>) => string;
	readonly onReload: () => Promise<GoSnapshot | undefined>;
	readonly onSaveCredential: (input: { credentialRef: string; apiKey?: string }) => Promise<GoSnapshot>;
	/** Delete the stored key for the given reference. */
	readonly onClearCredential: (input: { credentialRef: string }) => Promise<GoSnapshot>;
	readonly onLoadModels: (ref: string) => Promise<{ models: readonly GoModel[] }>;
	readonly onApply: (input: {
		api?: GoApi;
		credentialRef: string;
		models: readonly GoModel[];
		expectedRevision: number;
		confirmConflicts: boolean;
	}) => Promise<GoSnapshot>;
	readonly onMigrateLegacy?: (input: { expectedRevision: number; confirmConflicts: boolean }) => Promise<GoSnapshot>;
	readonly onStartConversation?: (() => void) | undefined;
}

const field = { display: "flex", flexDirection: "column", gap: 6 } as const;
const actions = { display: "flex", flexWrap: "wrap", gap: 8 } as const;
const modelListStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 4,
	maxHeight: 220,
	overflow: "auto",
	padding: "8px 10px",
	border: "0.5px solid var(--dsw-alias-border-l2)",
	borderRadius: "var(--dsw-radius-md, 12px)",
	background: "var(--dsw-alias-bg-layer-1)",
	minWidth: 0,
} as const;

/** 两个独立插件使用同一操作契约；已保存快照与当前表单草稿分开。 */
export function OpenCodeGoConnectionView({
	status,
	call,
	loadError,
	t,
	onReload,
	onSaveCredential,
	onClearCredential,
	onLoadModels,
	onApply,
	onMigrateLegacy,
	onStartConversation,
}: GoViewProps) {
	const [editing, setEditing] = useState<boolean | null>(true);
	const [dirty, setDirty] = useState(false);
	const [credentialRef, setCredentialRef] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [enabledIds, setEnabledIds] = useState<string[]>([]);
	const [api, setApi] = useState<GoApi>("openai-completions");
	const [revision, setRevision] = useState<number | null>(null);
	const [catalog, setCatalog] = useState<readonly GoModel[]>([]);
	const [confirmedRevision, setConfirmedRevision] = useState<number | null>(null);
	const confirmed = confirmedRevision !== null && confirmedRevision === status?.configuration.revision;
	const setConfirmed = (value: boolean): void =>
		setConfirmedRevision(value ? (status?.configuration.revision ?? null) : null);
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState<GoViewKey>();
	const [pending, setPending] = useState(false);
	const running = useRef(false);
	const showingForm = editing ?? (status !== undefined && !status.configuration.ready);
	const candidate =
		status?.credential.candidates.find((item) => item.ref === credentialRef) ??
		status?.credential.candidates.find((item) => item.ref === status.credential.selectedRef);
	/**
	 * The card acts on the credential already in use.
	 *
	 * The status document resolves which reference that is (a configured store
	 * slot, else an environment reference), and with the picker gone there is
	 * nothing to second-guess it with. When that slot is read-only — typically an
	 * environment variable shadowing the store — both buttons are disabled and
	 * `readOnly` says why, because a write would appear to succeed while
	 * resolution kept returning the shadowing value.
	 */
	const readOnly = status !== undefined && (status.configuration.writable === false || candidate?.writable !== true);
	const choices = catalog.length ? catalog : (status?.configuration.models ?? []);
	const visibleChoices = choices.filter((model) => {
		const suggested = knownGoApi(model.id) ?? (isGoApi(model.protocol) ? model.protocol : undefined);
		return suggested === undefined || suggested === api;
	});
	const conflicts = [...(status?.configuration.conflicts ?? [])];
	if (status?.configuration.api && api !== status.configuration.api && !conflicts.includes("protocol"))
		conflicts.push("protocol");
	const currentCall = call ?? status?.call;
	const callKey: GoViewKey = currentCall?.pending
		? "status.pending"
		: currentCall?.configurationConflict
			? "status.conflict"
			: currentCall?.streamStatus === "cancelled"
				? "status.cancelled"
				: `status.${currentCall?.lastCall ?? "no-call"}`;
	useEffect(() => {
		if (!status || dirty || pending) return;
		// Adopt the resolved reference: with no picker, this is the only slot the
		// save and clear buttons can act on.
		setCredentialRef(status.credential.selectedRef);
		setRevision(status.configuration.revision);
		setEnabledIds(status.configuration.models.map((model) => model.id));
		setApi(isGoApi(status.configuration.api) ? status.configuration.api : "openai-completions");
	}, [status, dirty, pending]);
	const change = (): void => {
		setDirty(true);
		setNotice(undefined);
	};
	const run = (action: () => Promise<void>): void => {
		if (running.current) return;
		running.current = true;
		setPending(true);
		setError(undefined);
		void action()
			.catch((failure: unknown) => {
				const code =
					failure !== null && typeof failure === "object" && "code" in failure && typeof failure.code === "string"
						? failure.code
						: undefined;
				if (code === "region-opt-in-required") {
					const detail = failure instanceof Error ? failure.message : "";
					setError(detail ? `${t("regionOptIn")} ${detail}` : t("regionOptIn"));
					return;
				}
				setError(failure instanceof Error ? failure.message : t("status.failure"));
			})
			.finally(() => {
				running.current = false;
				setPending(false);
			});
	};
	const toggleModel = (id: string, checked: boolean): void => {
		change();
		setEnabledIds((current) => {
			if (checked) return current.includes(id) ? current : [...current, id];
			return current.filter((entry) => entry !== id);
		});
		setConfirmed(false);
	};
	return (
		<article
			className="dus-oauth-card"
			data-opencode-go-status={currentCall?.lastCall ?? "loading"}
			data-unsaved={dirty || apiKey !== "" ? "true" : undefined}
			style={cardStyle}
		>
			<div style={{ ...actions, justifyContent: "space-between", alignItems: "center" }}>
				<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
					<ProviderIcon kind="opencodeGo" size={20} />
					<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
						<strong style={{ ...titleStyle, fontSize: 16 }}>{t("title")}</strong>
						<p style={{ ...bodyStyle, margin: 0 }}>{t("description")}</p>
						{status?.providerId ? (
							<p style={{ ...hintStyle, margin: 0 }}>{t("providerIdHint", { providerId: status.providerId })}</p>
						) : null}
					</div>
				</div>
				{status !== undefined ? (
					<Badge label={status.configuration.ready ? t("configured") : t("unconfigured")} tone={status.configuration.ready ? "success" : "neutral"} />
				) : null}
			</div>
			<p style={{ ...bodyStyle, margin: 0 }}>{t(callKey)}</p>
			{status?.legacy?.migratable && onMigrateLegacy ? (
				<div
					role="status"
					style={{
						...warningStyle,
						display: "flex",
						flexDirection: "column",
						gap: 8,
					}}
				>
					<p style={{ ...bodyStyle, margin: 0 }}>
						{t("legacyMigration", {
							legacyId: status.legacy.providerId,
							providerId: status.legacy.targetProviderId,
						})}
					</p>
					<div>
						<button
							type="button"
							style={compactButtonStyle}
							disabled={pending || status.configuration.revision === null || !status.configuration.writable}
							onClick={() => {
								if (status.configuration.revision === null) return;
								run(async () => {
									await onMigrateLegacy({
										expectedRevision: status.configuration.revision!,
										confirmConflicts: true,
									});
									setEditing(false);
									setDirty(false);
									setNotice("applied");
								});
							}}
						>
							{t("migrate")}
						</button>
					</div>
				</div>
			) : null}
			{showingForm ? (
				<div style={{ ...nestedStyle, gap: 12 }}>
					{/* One input, two buttons.
					    The credential reference is no longer a picker: this route has a
					    single well-known slot, so asking the operator to choose between
					    environment-variable names was a decision with no content. The
					    reference is resolved internally and shown as a hint instead. */}
					<div style={field}>
						<span style={{ ...bodyStyle, fontWeight: 600 }}>{t("apiKey")}</span>
						<div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
							<input
								style={{ ...inputStyle, flex: 1, minWidth: 0 }}
								type="password"
								aria-label={t("apiKey")}
								autoComplete="off"
								value={apiKey}
								disabled={pending || readOnly}
								placeholder={candidate?.configured ? `${credentialRef} 已配置` : t("apiKeyPlaceholder")}
								onChange={(event) => {
									change();
									setApiKey(event.target.value);
								}}
							/>
							<button
								style={primaryButtonStyle}
								type="button"
								disabled={pending || readOnly || apiKey.trim() === ""}
								onClick={() =>
									run(async () => {
										if (apiKey.trim() === "") return;
										const saved = await onSaveCredential({ credentialRef, apiKey });
										setApiKey("");
										setNotice("credentialSaved");
										if (saved.configuration.models.length === 0) {
											// First key on this route: load the directory so the model
											// list is not empty on the next screen.
											const result = await onLoadModels(credentialRef);
											setCatalog(result.models);
										}
									})
								}
							>
								{t("saveKey")}
							</button>
							<button
								style={buttonStyle}
								type="button"
								disabled={pending || readOnly || !candidate?.configured}
								onClick={() =>
									run(async () => {
										if (!candidate?.configured) return;
										// Destructive and easy to mis-click, so it asks once.
										if (!globalThis.confirm(t("clearKeyConfirm"))) return;
										await onClearCredential({ credentialRef });
										setApiKey("");
										setNotice("credentialCleared");
									})
								}
							>
								{t("clearKey")}
							</button>
						</div>
					</div>
					{readOnly ? <p style={{ ...hintStyle, margin: 0 }}>{t("readOnly")}</p> : null}
					<label style={field}>
						<span style={{ ...bodyStyle, fontWeight: 600 }}>{t("protocol")}</span>
						<select
							aria-label={t("protocol")}
							style={inputStyle}
							value={api}
							disabled={pending || !status?.configuration.writable}
							onChange={(event) => {
								change();
								const next = event.target.value as GoApi;
								setApi(next);
								setEnabledIds((current) =>
									current.filter((id) => {
										const suggested = knownGoApi(id);
										return suggested === undefined || suggested === next;
									}),
								);
								setConfirmed(false);
							}}
						>
							{GO_APIS.map((value) => (
								<option key={value} value={value}>
									{value}
								</option>
							))}
						</select>
					</label>
					<p style={{ ...hintStyle, margin: 0 }}>{t("protocolHint")}</p>
					<div style={field}>
						<span style={{ ...bodyStyle, fontWeight: 600 }}>{t("model")}</span>
						<fieldset
							aria-label={t("model")}
							style={{
								...modelListStyle,
								border: "0.5px solid var(--dsw-alias-border-l2)",
								margin: 0,
								minWidth: 0,
								padding: "0 10px 8px",
							}}
						>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: 8,
									padding: "8px 4px 3px",
									margin: "0 -10px",
									paddingLeft: 14,
									paddingRight: 14,
									borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
									fontWeight: 600,
									fontSize: 13,
									position: "sticky",
									top: 0,
									background: "var(--dsw-alias-bg-layer-1)",
									zIndex: 1,
								}}
							>
								<input
									type="checkbox"
									checked={visibleChoices.length > 0 && enabledIds.length === visibleChoices.length}
									disabled={pending || visibleChoices.length === 0}
									onChange={(event) => {
										change();
										setEnabledIds(event.target.checked ? visibleChoices.map((model) => model.id) : []);
										setConfirmed(false);
									}}
								/>
								<span style={{ flex: 1 }}>{t("model")}</span>
								<button
									type="button"
									style={{
										background: "none",
										border: "none",
										padding: 0,
										color: "var(--dsw-alias-link, var(--dsw-alias-brand-primary))",
										fontSize: 13,
										cursor: "pointer",
									}}
									disabled={pending || !candidate?.configured}
									onClick={() =>
										run(async () => {
											if (!candidate?.configured) return;
											const result = await onLoadModels(credentialRef);
											setCatalog(result.models);
											setDirty(true);
											const matching = result.models.filter((model) => {
												const suggested = knownGoApi(model.id);
												return suggested === undefined || suggested === api;
											});
											if (enabledIds.length === 0) {
												const preferred = matching.find((model) => model.id === "deepseek-v4.1-flash") ?? matching[0];
												setEnabledIds(preferred ? [preferred.id] : []);
											}
											setNotice("directoryLoaded");
										})
									}
								>
									{t("fetchModels")}
								</button>
							</div>
							{visibleChoices.length === 0 ? (
								<p style={{ ...hintStyle, margin: 0 }}>{t("modelsEmpty")}</p>
							) : (
								visibleChoices.map((model) => {
									const label = model.name ?? model.id;
									const efforts = model.reasoningEfforts;
									// Show selectable levels: off may be null; other levels need a wire string.
									const thinking =
										efforts && typeof efforts === "object"
											? Object.entries(efforts)
													.filter(
														([level, wire]) => level === "off" || (typeof wire === "string" && wire.trim() !== ""),
													)
													.map(([level]) => level)
											: [];
									return (
										<label
											key={model.id}
											style={{
												...checkRowStyle,
												padding: "3px 4px",
												borderRadius: "var(--dsw-radius-sm, 8px)",
												minWidth: 0,
											}}
										>
											<input
												type="checkbox"
												checked={enabledIds.includes(model.id)}
												disabled={pending || status?.configuration.writable !== true}
												onChange={(event) => toggleModel(model.id, event.target.checked)}
											/>
											<span style={{ ...monoStyle, fontSize: 13, overflowWrap: "anywhere" }}>
												{label}
												{thinking.length > 0 ? ` · thinking: ${thinking.join("/")}` : ""}
											</span>
										</label>
									);
								})
							)}
						</fieldset>
					</div>
					{status && revision !== status.configuration.revision ? (
						<p role="status" style={{ ...hintStyle, margin: 0 }}>
							{t("configurationChanged")}
						</p>
					) : null}
					{conflicts.length ? (
						<div style={{ ...warningStyle, margin: 0 }}>
							<p style={{ margin: 0 }}>{t("conflictPreview", { conflicts: conflicts.join(", ") })}</p>
							<label style={{ ...checkRowStyle, marginTop: 6 }}>
								<input
									type="checkbox"
									checked={confirmed}
									disabled={pending}
									onChange={(event) => setConfirmed(event.target.checked)}
								/>{" "}
								<span>{t("confirmConflict")}</span>
							</label>
						</div>
					) : null}
					<div style={actions}>
						<button
							style={primaryButtonStyle}
							type="button"
							disabled={
								pending ||
								!candidate?.configured ||
								!status?.configuration.writable ||
								revision === null ||
								(!!conflicts.length && !confirmed)
							}
							onClick={() =>
								run(async () => {
									if (
										!candidate?.configured ||
										!status?.configuration.writable ||
										revision === null ||
										(conflicts.length && !confirmed)
									)
										return;
									const byId = new Map(choices.map((item) => [item.id, item]));
									const saved = await onApply({
										api,
										credentialRef,
										models: enabledIds.map((id) => byId.get(id) ?? { id }),
										expectedRevision: revision,
										confirmConflicts: confirmed,
									});
									setRevision(saved.configuration.revision);
									setDirty(false);
									setNotice("applied");
								})
							}
						>
							{t("apply")}
						</button>
					</div>
				</div>
			) : null}
			{notice ? (
				<p role="status" style={{ ...bodyStyle, margin: 0, color: "var(--dsw-alias-state-success-primary)" }}>
					{t(notice)}
				</p>
			) : null}
			{error || loadError ? (
				<div
					role="alert"
					style={{
						...nestedStyle,
						borderColor: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent)",
					}}
				>
					<p style={{ ...errorStyle, margin: 0 }}>{error ?? loadError}</p>
					{!showingForm ? (
						<div>
							<button
								style={buttonStyle}
								type="button"
								onClick={() =>
									run(async () => {
										await onReload();
									})
								}
							>
								{t("reload")}
							</button>
						</div>
					) : null}
				</div>
			) : null}
		</article>
	);
}
