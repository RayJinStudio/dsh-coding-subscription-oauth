/** Accessible toggle switch replacing native checkboxes for capability settings. */

import type { CSSProperties } from "react";
import { TRANSITION } from "../styles.ts";

export interface ToggleSwitchProps {
	checked: boolean;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
	/** Accessible label (visually hidden when label prop is rendered externally). */
	ariaLabel?: string;
	ariaDescribedBy?: string;
	id?: string;
}

const trackStyle = (checked: boolean, disabled: boolean): CSSProperties => ({
	boxSizing: "border-box",
	position: "relative",
	width: 36,
	height: 20,
	borderRadius: 999,
	flex: "0 0 auto",
	background: checked ? "var(--dsw-alias-button-primary-fill)" : "var(--dsw-alias-border-l3)",
	opacity: disabled ? 0.5 : 1,
	cursor: disabled ? "not-allowed" : "pointer",
	transition: TRANSITION,
	border: "none",
	padding: 2,
});

const thumbStyle = (checked: boolean): CSSProperties => ({
	position: "absolute",
	top: 2,
	left: checked ? 18 : 2,
	width: 16,
	height: 16,
	borderRadius: "50%",
	// Match DSH primary fill/foreground pairing so the thumb stays visible when
	// dark theme inverts brand-primary to near-white.
	background: checked
		? "var(--dsw-alias-label-primary-foreground)"
		: "var(--dsw-alias-switch-thumb, var(--dsw-alias-button-elevated-fill))",
	boxShadow: "0 1px 2px rgba(0, 0, 0, 0.15)",
	transition: TRANSITION,
});

export function ToggleSwitch({
	checked,
	disabled = false,
	onChange,
	ariaLabel,
	ariaDescribedBy,
	id,
}: ToggleSwitchProps) {
	return (
		<button
			id={id}
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={ariaLabel}
			aria-describedby={ariaDescribedBy}
			disabled={disabled}
			style={trackStyle(checked, disabled)}
			onClick={() => {
				if (!disabled) onChange(!checked);
			}}
		>
			<span aria-hidden="true" style={thumbStyle(checked)} />
		</button>
	);
}
