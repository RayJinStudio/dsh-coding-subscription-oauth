/** Web search tab: the DSH search-provider pin plus the status-bar usage display. */

import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { jsonRequest } from "../api.ts";
import { SEARCH_PROVIDER_PATH } from "../constants.ts";
import type { GrokBuildSettingsKey } from "../locales.ts";
import { parseSearchProvider } from "../parsers.ts";
import { bodyStyle, cardStyle, compactButtonStyle, errorStyle, hintStyle, titleStyle } from "../styles.ts";
import type { SearchProviderView } from "../types.ts";
import { UsageBadgeDisplaySetting } from "./UsageBadgeDisplaySetting.tsx";

type Translate = (key: GrokBuildSettingsKey, params?: Record<string, unknown>) => string;

export interface SearchTabProps {
	readonly t: Translate;
}

export function SearchTab({ t }: SearchTabProps) {
	const [view, setView] = useState<SearchProviderView | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async (): Promise<void> => {
		setBusy(true);
		try {
			setView(parseSearchProvider(await jsonRequest<unknown>(SEARCH_PROVIDER_PATH)));
			setError(undefined);
		} catch (failure: unknown) {
			setView(undefined);
			setError(failure instanceof Error ? failure.message : t("searchProviderUnavailable"));
		} finally {
			setBusy(false);
		}
	}, [t]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const select = async (value: string): Promise<void> => {
		if (busy || view?.writable !== true || view.current === value) return;
		setBusy(true);
		try {
			setView(
				parseSearchProvider(await jsonRequest<unknown>(SEARCH_PROVIDER_PATH, "PATCH", { searchProvider: value })),
			);
			setError(undefined);
		} catch (failure: unknown) {
			setError(failure instanceof Error ? failure.message : t("searchProviderSaveFailed"));
			// Re-read so the control reflects what the profile actually holds.
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	const disabled = busy || view?.writable !== true;

	return (
		<div style={styles.stack}>
			<div style={styles.card}>
				<h3 style={{ ...titleStyle, fontSize: 16 }}>{t("searchProviderTitle")}</h3>
				<p style={{ ...bodyStyle, marginTop: 6 }}>{t("searchProviderIntro")}</p>
				{error === undefined ? null : (
					<p role="alert" style={{ ...errorStyle, marginTop: 8 }}>
						{error}
					</p>
				)}
				{view === undefined && error !== undefined ? (
					<div>
						<button type="button" style={compactButtonStyle} onClick={() => void refresh()}>
							{t("retry")}
						</button>
					</div>
				) : null}
				{view === undefined ? null : (
					<label style={{ ...styles.field, marginTop: 10 }}>
						<span style={styles.label}>{t("searchProviderField")}</span>
						<select
							style={styles.select}
							aria-label={t("searchProviderField")}
							value={view.current}
							disabled={disabled}
							onChange={(event) => {
								void select(event.currentTarget.value);
							}}
						>
							<option value="">{t("searchProviderAuto")}</option>
							{view.candidates.map((candidate) => (
								<option key={candidate.id} value={candidate.id} disabled={!candidate.available}>
									{searchProviderLabel(candidate.id, candidate.builtIn, candidate.available, t)}
								</option>
							))}
						</select>
					</label>
				)}
				{view === undefined ? null : (
					<p style={{ ...hintStyle, marginTop: 6 }}>{view.unavailableReason ?? t("searchProviderHint")}</p>
				)}
				{view?.writable === true && view.candidates.length === 0 ? (
					<p style={{ ...hintStyle, marginTop: 6 }}>{t("searchProviderNoCandidates")}</p>
				) : null}
			</div>
			<div style={styles.card}>
				<UsageBadgeDisplaySetting t={t} />
			</div>
		</div>
	);
}

/**
 * One option label: the raw id plus its origin and usability, so an operator can
 * tell a shipped provider from a plugin one and see a disconnected provider.
 */
function searchProviderLabel(id: string, builtIn: boolean, available: boolean, t: Translate): string {
	const parts = [id];
	if (builtIn) parts.push(t("searchProviderBuiltIn"));
	if (!available) parts.push(t("searchProviderUnavailableTag"));
	return parts.join(" · ");
}

const styles: Record<string, CSSProperties> = {
	stack: { display: "flex", flexDirection: "column", gap: 12 },
	card: { ...cardStyle, display: "block" },
	field: { display: "flex", flexDirection: "column", gap: 4, fontSize: 14, lineHeight: "22px" },
	label: { color: "var(--dsw-alias-label-primary)", fontWeight: 500 },
	select: {
		height: 32,
		width: "100%",
		boxSizing: "border-box",
		border: "1px solid var(--dsw-alias-border-l2)",
		borderRadius: "var(--dsw-radius-sm, 8px)",
		padding: "0 10px",
		font: "inherit",
		fontSize: 13,
		background: "var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))",
		color: "var(--dsw-alias-label-primary)",
	},
};
