import { useEffect, useRef, useState } from "react";
import {
	bodyStyle,
	compactButtonStyle,
	errorStyle,
	hintStyle,
	nestedStyle,
	primaryButtonStyle,
	titleStyle,
} from "../styles.ts";

/** 目标账户在打开确认时固定；不把重新授权解释为新增或默认账户切换。 */
export function AccountReauthorization({
	account,
	methods,
	disabled,
	labels,
	onConfirm,
}: {
	readonly account: string;
	readonly methods: readonly { id: string; label: string }[];
	readonly disabled: boolean;
	readonly labels: { action: string; hint: string; cancel: string };
	readonly onConfirm: (method: string) => Promise<unknown>;
}) {
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string>();
	const [pending, setPending] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const cancel = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (open) cancel.current?.focus();
	}, [open]);
	return (
		<div style={{ display: "inline-flex", flexDirection: "column", gap: 8 }}>
			<button
				ref={trigger}
				type="button"
				style={compactButtonStyle}
				disabled={disabled || pending}
				aria-expanded={open}
				onClick={() => setOpen(true)}
			>
				{labels.action}
			</button>
			{open ? (
				<fieldset style={{ ...nestedStyle, margin: "6px 0", gap: 8 }}>
					<legend style={{ ...titleStyle, fontSize: 13, padding: "0 4px" }}>{account}</legend>
					<p style={{ ...bodyStyle, margin: 0, ...hintStyle }}>{labels.hint}</p>
					<div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
						{methods.map((method) => (
							<button
								key={method.id}
								type="button"
								style={primaryButtonStyle}
								disabled={pending || disabled}
								onClick={() => {
									if (pending) return;
									setPending(true);
									setError(undefined);
									void onConfirm(method.id)
										.then(
											() => setOpen(false),
											(failure: unknown) => setError(failure instanceof Error ? failure.message : labels.action),
										)
										.finally(() => setPending(false));
								}}
							>
								{labels.action} · {method.label}
							</button>
						))}
						<button
							ref={cancel}
							type="button"
							style={compactButtonStyle}
							disabled={pending}
							onClick={() => {
								setOpen(false);
								trigger.current?.focus();
							}}
						>
							{labels.cancel}
						</button>
					</div>
					{error ? (
						<p role="alert" style={{ ...errorStyle, margin: 0 }}>
							{error}
						</p>
					) : null}
				</fieldset>
			) : null}
		</div>
	);
}
