/** Accounts tab: provider cards, CLI tips, and pull preview. */

import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { PROVIDERS } from "../constants.ts";
import { allOfficialCliMissing, anyOfficialCliAvailable } from "../display.ts";
import {
	bodyStyle,
	cardStyle,
	dotStyle,
	hintStyle,
	monoStyle,
	rowStyle,
	skeletonStyle,
	snippetStyle,
	statusStyle,
	TRANSITION,
	titleStyle,
} from "../styles.ts";
import type {
	CodingOAuthStatus,
	GrokBuildSettingsInjected,
	LoginMethod,
	ProviderSlug,
	SourcePreview,
	SourceStatus,
	UsageView,
} from "../types.ts";
import { Badge } from "./Badge.tsx";
import { CliPullPreview } from "./CliPullPreview.tsx";
import { NoticeBanner } from "./NoticeBanner.tsx";
import { OpenCodeGoCard } from "./OpenCodeGoCard.tsx";
import { ProviderCard } from "./ProviderCard.tsx";
import { ProviderIcon, type ProviderIconKind } from "./ProviderIcons.tsx";

export type ProviderFilterId = "opencodeGo" | ProviderSlug | "antigravity";

export interface AccountsTabProps {
	renderCapabilities?: ((scope: "codex" | "kimi" | "grok") => ReactNode) | undefined;
	onLoadCapabilities?: (() => void) | undefined;
	onStartConversation?: (() => void) | undefined;
	t: GrokBuildSettingsInjected["t"];
	status: CodingOAuthStatus | undefined;
	remote: boolean;
	remoteTipDismissed: boolean;
	onDismissRemoteTip: () => void;
	sources: readonly SourceStatus[] | undefined;
	sourcesError: string | undefined;
	sourcesNotice: string | undefined;
	sourcesBusy: boolean;
	preview: SourcePreview | undefined;
	confirmOverwrite: boolean;
	busyProvider: ProviderSlug | undefined;
	codeInputs: Partial<Record<ProviderSlug, string>>;
	popupBlocked: Partial<Record<ProviderSlug, boolean>>;
	expandedProviders: Partial<Record<ProviderSlug, boolean>>;
	showUsage: boolean;
	usage: UsageView | undefined;
	usageError: string | undefined;
	usageLoading: boolean;
	kimiUsage?: UsageView | undefined;
	kimiUsageError?: string | undefined;
	kimiUsageLoading?: boolean;
	onSignIn: (slug: ProviderSlug, method: LoginMethod, targetAccountId?: string) => void | Promise<void>;
	onSignOut: (slug: ProviderSlug) => void;
	onCancelLogin: (slug: ProviderSlug) => void;
	onSubmitCode: (slug: ProviderSlug) => void;
	onCodeChange: (slug: ProviderSlug, value: string) => void;
	onToggleExpanded: (slug: ProviderSlug) => void;
	onPreviewSource: (slug: ProviderSlug) => void;
	onSaveModels: (
		slug: ProviderSlug,
		selected: string[],
		selectionMode?: "default" | "selected",
	) => Promise<string | undefined>;
	onSetDefaultAccount: (slug: ProviderSlug, accountId: string) => void;
	onRemoveAccount: (slug: ProviderSlug, accountId: string) => Promise<boolean>;
	onRetryStatus: () => void;
	onConfirmOverwriteChange: (checked: boolean) => void;
	onCommitSource: () => void;
	onCancelSourcePreview: () => void;
	onRefreshSources: () => void;
	onDismissSourcesNotice: () => void;
}

export function AccountsTab({
	renderCapabilities,
	onLoadCapabilities,
	onStartConversation,
	t,
	status,
	remote,
	remoteTipDismissed,
	onDismissRemoteTip,
	sources,
	sourcesError,
	sourcesNotice,
	sourcesBusy,
	preview,
	confirmOverwrite,
	busyProvider,
	codeInputs,
	popupBlocked,
	expandedProviders,
	showUsage,
	usage,
	usageError,
	usageLoading,
	kimiUsage,
	kimiUsageError,
	kimiUsageLoading,
	onSignIn,
	onSignOut,
	onCancelLogin,
	onSubmitCode,
	onCodeChange,
	onToggleExpanded,
	onPreviewSource,
	onSaveModels,
	onSetDefaultAccount,
	onRemoveAccount,
	onRetryStatus,
	onConfirmOverwriteChange,
	onCommitSource,
	onCancelSourcePreview,
	onRefreshSources,
	onDismissSourcesNotice,
}: AccountsTabProps) {
	const [selectedProvider, setSelectedProvider] = useState<ProviderFilterId>("opencodeGo");
	const previousPreviewKind = useRef<ProviderSlug | undefined>(undefined);

	useEffect(() => {
		if (preview !== undefined) {
			setSelectedProvider(preview.kind);
			previousPreviewKind.current = preview.kind;
			document.getElementById(`coding-oauth-source-preview-${preview.kind}`)?.focus();
			return;
		}
		const trigger = previousPreviewKind.current;
		if (trigger === undefined || sourcesBusy) return;
		previousPreviewKind.current = undefined;
		document.getElementById(`coding-oauth-source-pull-${trigger}`)?.focus();
	}, [preview, sourcesBusy]);

	if (status === undefined) {
		return (
			<div style={skeletonStyle} role="status" aria-busy="true">
				<div style={statusStyle}>
					<span aria-hidden="true" style={dotStyle("loading")} />
					{t("loadingAccount")}
				</div>
			</div>
		);
	}

	const providerTabs: readonly {
		id: ProviderFilterId;
		iconKind: ProviderIconKind;
		label: string;
		statusTone?: "success" | "info" | "error" | "neutral" | undefined;
	}[] = [
		{
			id: "opencodeGo",
			iconKind: "opencodeGo",
			label: "OpenCode Go",
			statusTone: status.opencodeGo.active ? "success" : undefined,
		},
		{
			id: "grok",
			iconKind: "grok",
			label: "xAI Grok",
			statusTone:
				status.providers.grok.status === "signed-in"
					? "success"
					: status.providers.grok.status === "signing-in"
						? "info"
						: status.providers.grok.status === "error"
							? "error"
							: undefined,
		},
		{
			id: "codex",
			iconKind: "codex",
			label: "OpenAI Codex",
			statusTone:
				status.providers.codex.status === "signed-in"
					? "success"
					: status.providers.codex.status === "signing-in"
						? "info"
						: status.providers.codex.status === "error"
							? "error"
							: undefined,
		},
		{
			id: "kimi",
			iconKind: "kimi",
			label: "Kimi Code",
			statusTone:
				status.providers.kimi.status === "signed-in"
					? "success"
					: status.providers.kimi.status === "signing-in"
						? "info"
						: status.providers.kimi.status === "error"
							? "error"
							: undefined,
		},
		{
			id: "claude",
			iconKind: "claude",
			label: "Claude Code",
			statusTone:
				status.providers.claude.status === "signed-in"
					? "success"
					: status.providers.claude.status === "signing-in"
						? "info"
						: status.providers.claude.status === "error"
							? "error"
							: undefined,
		},
		{
			id: "antigravity",
			iconKind: "antigravity",
			label: "Antigravity",
			statusTone: status.antigravity.installed ? "success" : undefined,
		},
	];

	const getDotColor = (tone?: "success" | "info" | "error" | "neutral") => {
		if (tone === "success") return "var(--dsw-alias-state-success-primary, #22a06b)";
		if (tone === "info") return "var(--dsw-alias-brand-primary, #1677ff)";
		if (tone === "error") return "var(--dsw-alias-state-error-primary, #d92d20)";
		return undefined;
	};

	return (
		<>
			{remote && !remoteTipDismissed ? (
				<NoticeBanner
					message={t("remoteAccountsTip")}
					dismissLabel={t("remoteTipDismiss")}
					onDismiss={onDismissRemoteTip}
				/>
			) : null}
			{allOfficialCliMissing(sources) ? (
				<NoticeBanner
					message={t("sourcesAllMissingHint")}
					dismissLabel={t("sourcesCheckAgain")}
					onDismiss={() => {
						onRefreshSources();
					}}
				/>
			) : null}
			{anyOfficialCliAvailable(sources) ? <p style={hintStyle}>{t("sourcesAvailableHint")}</p> : null}
			{sourcesError === undefined ? null : (
				<p style={{ ...bodyStyle, color: "var(--dsw-alias-state-error-primary)" }} role="alert">
					{sourcesError}
				</p>
			)}
			{sourcesNotice === undefined ? null : (
				<NoticeBanner
					key={sourcesNotice}
					message={sourcesNotice}
					tone="success"
					autoHideMs={5000}
					onDismiss={onDismissSourcesNotice}
				/>
			)}
			<div
				role="tablist"
				aria-label={t("providerFilterLabel")}
				style={{
					display: "flex",
					flexWrap: "wrap",
					gap: 6,
					alignItems: "center",
					padding: 4,
					borderRadius: "var(--dsw-radius-lg, 16px)",
					background: "var(--dsw-alias-bg-module-platform)",
					border: "0.5px solid var(--dsw-alias-border-l2)",
					marginBottom: 14,
				}}
			>
				{providerTabs.map((tab) => {
					const isSelected = selectedProvider === tab.id;
					const dot = getDotColor(tab.statusTone);
					return (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={isSelected}
							style={{
								boxSizing: "border-box",
								display: "inline-flex",
								alignItems: "center",
								gap: 7,
								height: 38,
								minHeight: 38,
								padding: "0 14px",
								borderRadius: "var(--dsw-radius-md, 12px)",
								border: isSelected ? "0.5px solid var(--dsw-alias-border-l3)" : "none",
								background: isSelected ? "var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1))" : "transparent",
								color: isSelected ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
								fontWeight: isSelected ? 600 : 500,
								fontSize: 13,
								lineHeight: "20px",
								cursor: "pointer",
								transition: TRANSITION,
								boxShadow: isSelected ? "0 1px 2px rgba(0, 0, 0, 0.08)" : "none",
							}}
							onClick={() => setSelectedProvider(tab.id)}
						>
							<ProviderIcon kind={tab.iconKind} size={14} />
							<span>{tab.label}</span>
							{dot ? (
								<span
									aria-hidden="true"
									style={{
										width: 6,
										height: 6,
										borderRadius: "50%",
										background: dot,
										flexShrink: 0,
									}}
								/>
							) : null}
						</button>
					);
				})}
			</div>
			<div style={{ display: "flex", flexDirection: "column", gap: 14, width: "100%" }}>
				{selectedProvider === "opencodeGo" ? (
					<OpenCodeGoCard t={t} fallback={status.opencodeGo} onStartConversation={onStartConversation} />
				) : null}
				{PROVIDERS.filter((d) => selectedProvider === d.slug).map((definition) => {
					const providerStatus = status.providers[definition.slug];
					const expanded = providerStatus.status === "signing-in" || expandedProviders[definition.slug] === true;
					return (
						<Fragment key={definition.slug}>
							<ProviderCard
								capabilitiesPanel={
									definition.slug === "codex" || definition.slug === "kimi" || definition.slug === "grok"
										? renderCapabilities?.(definition.slug)
										: undefined
								}
								onLoadCapabilities={onLoadCapabilities}
								t={t}
								definition={definition}
								providerStatus={providerStatus}
								busy={busyProvider === definition.slug}
								sourcesBusy={sourcesBusy}
								remote={remote}
								codeInput={codeInputs[definition.slug] ?? ""}
								popupBlocked={popupBlocked[definition.slug] === true}
								expanded={expanded}
								source={sources?.find((entry) => entry.kind === definition.slug)}
								showUsage={definition.slug === "kimi" ? true : showUsage}
								usage={definition.slug === "kimi" ? kimiUsage : usage}
								usageError={definition.slug === "kimi" ? kimiUsageError : usageError}
								usageLoading={definition.slug === "kimi" ? (kimiUsageLoading ?? false) : usageLoading}
								onSignIn={(method, targetAccountId) => onSignIn(definition.slug, method, targetAccountId)}
								onSignOut={() => {
									onSignOut(definition.slug);
								}}
								onCancelLogin={() => {
									onCancelLogin(definition.slug);
								}}
								onSubmitCode={() => {
									onSubmitCode(definition.slug);
								}}
								onCodeChange={(value) => {
									onCodeChange(definition.slug, value);
								}}
								onToggleExpanded={() => {
									onToggleExpanded(definition.slug);
								}}
								onPreviewSource={() => {
									onPreviewSource(definition.slug);
								}}
								onSaveModels={(selected, selectionMode) => onSaveModels(definition.slug, selected, selectionMode)}
								onSetDefaultAccount={(accountId) => {
									onSetDefaultAccount(definition.slug, accountId);
								}}
								onRemoveAccount={(accountId) => onRemoveAccount(definition.slug, accountId)}
								onRetryStatus={onRetryStatus}
							/>
							{preview?.kind === definition.slug ? (
								<div style={{ gridColumn: "1 / -1", minWidth: 0 }}>
									<CliPullPreview
										t={t}
										preview={preview}
										confirmOverwrite={confirmOverwrite}
										sourcesBusy={sourcesBusy}
										onConfirmOverwriteChange={onConfirmOverwriteChange}
										onCommit={onCommitSource}
										onCancel={onCancelSourcePreview}
									/>
								</div>
							) : null}
						</Fragment>
					);
				})}
				{selectedProvider === "antigravity" ? (
					<div style={cardStyle}>
						<div style={rowStyle}>
							<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
								<ProviderIcon kind="antigravity" size={20} />
								<div>
									<h3 style={{ ...titleStyle, fontSize: 16 }}>{t("antigravityTitle")}</h3>
									<p style={{ ...bodyStyle, marginTop: 4 }}>{t("antigravityDescription")}</p>
									<p style={{ ...bodyStyle, marginTop: 4 }}>
										<span style={monoStyle}>{status.antigravity.route}</span>
									</p>
								</div>
							</div>
							<Badge
								label={status.antigravity.installed ? t("antigravityInstalled") : t("antigravityMissing")}
								tone={status.antigravity.installed ? "success" : "neutral"}
								installed={status.antigravity.installed}
							/>
						</div>
						<p style={bodyStyle}>{t("antigravityCliHint")}</p>
						<code style={snippetStyle}>{t("antigravityCliCommand")}</code>
					</div>
				) : null}
			</div>
		</>
	);
}
