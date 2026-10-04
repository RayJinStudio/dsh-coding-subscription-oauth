declare module "@deepseek-ai/dsh-client-ui-primitives" {
	import type { ComponentType, CSSProperties, RefObject, SVGProps } from "react";

	export interface AnchoredPositionOptions {
		open: boolean;
		anchorRef: RefObject<HTMLElement | null>;
		panelRef: RefObject<HTMLElement | null>;
		side?: "top" | "bottom";
		align?: "start" | "end";
		gap: number;
		margin: number;
	}

	export function useAnchoredPosition(options: AnchoredPositionOptions): CSSProperties | null;

	export function useDismissOnOutsidePointer(
		root: RefObject<HTMLElement | null>,
		open: boolean,
		setOpen: (open: boolean) => void,
		portal?: RefObject<HTMLElement | null>,
	): void;

	export const IconDataOutlineRegular: ComponentType<SVGProps<SVGSVGElement>> | undefined;
	export const IconDataOutline16: ComponentType<SVGProps<SVGSVGElement>> | undefined;
}
