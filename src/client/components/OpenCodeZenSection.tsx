/**
 * OpenCode Zen section of the shared subscription card.
 *
 * Rendered inside the OpenCode card alongside the Go section rather than as its
 * own provider entry, so the two OpenCode products read as one subject in
 * Settings → Accounts.
 *
 * The model list is deliberately protocol-aware in appearance only: the card
 * shows each model's protocol because it is genuinely per model, but there is no
 * protocol selector, because a Zen account spans several protocols at once and
 * the route dispatches on each model's own. That is the whole reason this route
 * exists instead of an `llm-pi-ai` settings profile.
 */

import { useCallback, useEffect, useState } from "react";
import { jsonRequest } from "../api.ts";
import { OPENCODE_ZEN_CONNECTION_PATH } from "../constants.ts";
import type { GrokBuildSettingsKey } from "../locales.ts";
import {
	bodyStyle,
	buttonStyle,
	cardStyle,
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

export interface ZenModel {
	readonly id: string;
	readonly name?: string | undefined;
	readonly protocol: string;
	readonly contextWindow?: number | undefined;
	readonly maxTokens?: number | undefined;
	readonly input?: readonly ("text" | "image")[] | undefined;
	readonly free: boolean;
}

export interface ZenSnapshot {
	readonly providerId: string;
	readonly displayName: string;
	readonly baseURL: string;
	readonly credential: {
		readonly selectedRef: string;
		readonly configured: boolean;
		readonly writable: boolean;
		readonly requiresChoice: boolean;
		readonly candidates: readonly {
			readonly ref: string;
			readonly configured: boolean;
			readonly writable: boolean;
		}[];
	};
	readonly configuration: {
		readonly writable: boolean;
		readonly selectionMode: "default" | "selected";
		readonly models: readonly ZenModel[];
		readonly protocols: readonly string[];
		readonly ready: boolean;
		readonly unknownModels: readonly string[];
		readonly catalogSize: number;
	};
	readonly catalog: readonly ZenModel[];
}

export type ZenViewKey =
	| "zenTitle"
	| "zenDescription"
	| "zenConfigured"
	| "zenUnconfigured"
	| "zenChooseCredential"
	| "zenApiKey"
	| "zenApiKeyPlaceholder"
	| "zenReuseHint"
	| "zenSaveKey"
	| "zenReuse"
	| "zenClearKey"
	| "zenClearKeyConfirm"
	| "zenCredentialCleared"
	| "zenLoadDirectory"
	| "zenModel"
	| "zenApply"
	| "zenEdit"
	| "zenCredentialSaved"
	| "zenApplied"
	| "zenDirectoryLoaded"
	| "zenReadOnly"
	| "zenUnknownModels"
	| "zenProtocolHint"
	| "zenFree"
	| "zenProviderIdHint";

export interface ZenViewProps {
	readonly t: (key: ZenViewKey, params?: Record<string, string | number>) => string;
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

export function OpenCodeZenSection({ t }: ZenViewProps) {
	const [status, setStatus] = useState<ZenSnapshot>();
	const [error, setError] = useState<string>();
	const [editing, setEditing] = useState(true);
	const [pending, setPending] = useState(false);
	const [credentialRef, setCredentialRef] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [enabledIds, setEnabledIds] = useState<string[]>([]);
	const [notice, setNotice] = useState<ZenViewKey>();
	const [seeded, setSeeded] = useState(false);

	const accept = useCallback((next: ZenSnapshot) => {
		setStatus(next);
		return next;
	}, []);

	const reload = useCallback(async () => {
		try {
			const next = await jsonRequest<ZenSnapshot>(OPENCODE_ZEN_CONNECTION_PATH);
			accept(next);
			setError(undefined);
			return next;
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
			return undefined;
		}
	}, [accept]);

	useEffect(() => {
		void reload();
	}, [reload]);

	// Seed the draft from the saved snapshot once per load, so a reload does not
	// discard edits the operator is mid-way through.
	useEffect(() => {
		if (!status || seeded) return;
		// Adopt the resolved reference: with no picker, this is the only slot the
		// save and clear buttons can act on.
		setCredentialRef(status.credential.selectedRef);
		setEnabledIds(status.configuration.models.map((model) => model.id));
		setSeeded(true);
	}, [status, seeded]);

	const run = (action: () => Promise<void>): void => {
		setPending(true);
		setError(undefined);
		void action()
			.catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
			.finally(() => setPending(false));
	};

	const catalog = status?.catalog ?? [];
	const configured = status?.configuration.ready === true;
	/** The resolved slot the buttons act on; see the seed effect above. */
	const candidate =
		status?.credential.candidates.find((entry) => entry.ref === credentialRef) ??
		status?.credential.candidates.find((entry) => entry.ref === status.credential.selectedRef);
	/**
	 * A read-only source (typically an environment variable shadowing the store)
	 * disables both buttons: a write would appear to succeed while resolution
	 * kept returning the shadowing value.
	 */
	const readOnly = status !== undefined && (status.configuration.writable === false || candidate?.writable !== true);

	return (
		<section
			aria-label={t("zenTitle")}
			data-opencode-zen-status={configured ? "ready" : "unconfigured"}
			style={{
				...cardStyle,
				width: "100%",
				minWidth: 0,
				margin: 0,
				boxSizing: "border-box",
				background: "var(--dsw-alias-bg-canvas, #fff)",
			}}
		>
			<div style={{ ...actions, justifyContent: "space-between", alignItems: "center" }}>
				<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
					<ProviderIcon kind="opencodeZen" size={20} />
					<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
						<strong style={{ ...titleStyle, fontSize: 16 }}>{t("zenTitle")}</strong>
						<p style={{ ...bodyStyle, margin: 0 }}>{t("zenDescription")}</p>
						{status?.providerId ? (
							<p style={{ ...hintStyle, margin: 0 }}>{t("zenProviderIdHint", { providerId: status.providerId })}</p>
						) : null}
					</div>
				</div>
				{status !== undefined ? (
					<Badge
						label={configured ? t("zenConfigured") : t("zenUnconfigured")}
						tone={configured ? "success" : "neutral"}
					/>
				) : null}
			</div>
			{editing ? (
				<div style={{ ...nestedStyle, gap: 12 }}>
					{/* One input, two buttons — same shape as the Go section above.
					    The reference picker is gone: this route writes to one known
					    slot, so the resolved reference is shown as a hint instead of
					    being a choice with no content. */}
					<div style={field}>
						<span style={{ ...bodyStyle, fontWeight: 500 }}>{t("zenApiKey")}</span>
						<div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
							<input
								style={{ ...inputStyle, flex: 1, minWidth: 0 }}
								type="password"
								aria-label={t("zenApiKey")}
								autoComplete="off"
								value={apiKey}
								disabled={pending || readOnly}
								placeholder={candidate?.configured ? `${credentialRef} 已配置` : t("zenApiKeyPlaceholder")}
								onChange={(event) => {
									setApiKey(event.target.value);
									setNotice(undefined);
								}}
							/>
							<button
								type="button"
								style={primaryButtonStyle}
								disabled={pending || readOnly || apiKey.trim() === "" || !credentialRef}
								onClick={() =>
									run(async () => {
										if (apiKey.trim() === "" || !credentialRef) return;
										const next = await jsonRequest<ZenSnapshot>(OPENCODE_ZEN_CONNECTION_PATH, "POST", {
											action: "credential",
											credentialRef,
											apiKey,
										});
										accept(next);
										setApiKey("");
										setNotice("zenCredentialSaved");
									})
								}
							>
								{t("zenSaveKey")}
							</button>
							<button
								type="button"
								style={buttonStyle}
								disabled={pending || readOnly || !candidate?.configured || !credentialRef}
								onClick={() =>
									run(async () => {
										if (!candidate?.configured || !credentialRef) return;
										// Destructive and easy to mis-click, so it asks once.
										if (!globalThis.confirm(t("zenClearKeyConfirm"))) return;
										const next = await jsonRequest<ZenSnapshot>(OPENCODE_ZEN_CONNECTION_PATH, "POST", {
											action: "clear",
											credentialRef,
										});
										accept(next);
										setApiKey("");
										setNotice("zenCredentialCleared");
									})
								}
							>
								{t("zenClearKey")}
							</button>
						</div>
					</div>
					{readOnly ? <p style={{ ...hintStyle, margin: 0 }}>{t("zenReadOnly")}</p> : null}
					<label style={field}>
						<span style={{ ...bodyStyle, fontWeight: 600 }}>{t("zenModel")}</span>
						<fieldset
							aria-label={t("zenModel")}
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
									checked={catalog.length > 0 && enabledIds.length === catalog.length}
									disabled={pending || catalog.length === 0}
									onChange={(event) => {
										setEnabledIds(event.target.checked ? catalog.map((model) => model.id) : []);
										setNotice(undefined);
									}}
								/>
								<span style={{ flex: 1 }}>{t("zenModel")}</span>
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
									disabled={pending || !status?.credential.configured}
									onClick={() =>
										run(async () => {
											await jsonRequest<unknown>(`${OPENCODE_ZEN_CONNECTION_PATH}?directory=1`);
											setNotice("zenDirectoryLoaded");
										})
									}
								>
									{t("zenLoadDirectory")}
								</button>
							</div>
							{catalog.map((model) => (
								<label
									key={model.id}
									style={{
										display: "flex",
										alignItems: "center",
										gap: 8,
										padding: "3px 4px",
										minWidth: 0,
									}}
								>
									<input
										type="checkbox"
										checked={enabledIds.includes(model.id)}
										disabled={pending}
										onChange={(event) => {
											setEnabledIds((current) =>
												event.target.checked
													? current.includes(model.id)
														? current
														: [...current, model.id]
													: current.filter((id) => id !== model.id),
											);
											setNotice(undefined);
										}}
									/>
									<span style={{ ...monoStyle, fontSize: 13, overflowWrap: "anywhere" }}>
										{model.name ?? model.id} · {model.protocol}
										{model.free ? ` · ${t("zenFree")}` : ""}
									</span>
								</label>
							))}
						</fieldset>
					</label>
					{status && status.configuration.unknownModels.length > 0 ? (
						<div style={{ ...warningStyle, margin: 0 }}>
							<p style={{ margin: 0 }}>
								{t("zenUnknownModels", { models: status.configuration.unknownModels.join(", ") })}
							</p>
						</div>
					) : null}
					<div style={actions}>
						<button
							type="button"
							style={primaryButtonStyle}
							disabled={pending || enabledIds.length === 0}
							onClick={() =>
								run(async () => {
									const next = await jsonRequest<ZenSnapshot>(OPENCODE_ZEN_CONNECTION_PATH, "POST", {
										action: "apply",
										models: enabledIds,
									});
									accept(next);
									setNotice("zenApplied");
								})
							}
						>
							{t("zenApply")}
						</button>
					</div>
				</div>
			) : null}
			{notice ? (
				<p role="status" style={{ ...bodyStyle, margin: 0, color: "var(--dsw-alias-state-success-primary)" }}>
					{t(notice)}
				</p>
			) : null}
			{error ? (
				<p role="alert" style={{ ...bodyStyle, margin: 0, color: "var(--dsw-alias-state-error-primary)" }}>
					{error}
				</p>
			) : null}
		</section>
	);
}

/** Untranslated pass-through used by AccountsTab's translator. */
export type { GrokBuildSettingsKey };
