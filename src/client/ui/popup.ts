import { GameContext } from "shared/game/context";
import { TEXT, THEME, TRANSPARENCY, space } from "./theme";
import {
	BUTTON_SIZE,
	Button,
	ButtonVariant,
	Dialog,
	ToastKind,
	autoFocus,
	cardHeaderHeight,
	makeLabel,
	showToast,
} from "./widgets";

export type { ToastKind } from "./widgets";

export interface PopupButtonSpec {
	text: string;
	/** default: the last button is the primary action ("default"), the others "secondary" */
	variant?: ButtonVariant;
	/** @deprecated previous kit names: "primary" = default, "ghost" = secondary (Close / Back), "danger" = destructive */
	style?: ButtonVariant | "primary" | "danger";
	onClick?: () => void;
	/** keep the popup open after the click (default: close) */
	keepOpen?: boolean;
}

const DIALOG_W = 520;
/** rough characters per line of the body at TEXT.base in the dialog width (for the height estimate) */
const CHARS_PER_LINE = 54;

function variantOf(spec: PopupButtonSpec, isLast: boolean): ButtonVariant {
	if (spec.variant !== undefined) return spec.variant;
	const style = spec.style;
	if (style === "primary") return "default";
	if (style === "danger") return "destructive";
	if (style === "ghost") return "secondary";
	if (style !== undefined) return style;
	return isLast ? "default" : "secondary";
}

function bodyLines(body: string): number {
	let lines = 0;
	for (const line of body.split("\n")) {
		lines += math.max(1, math.ceil(line.size() / CHARS_PER_LINE));
	}
	return math.max(1, lines);
}

/** modal dialog (popover card over a scrim); returns the overlay (destroy it to close) */
export function popup(ctx: GameContext, title: string, body: string, buttons: Array<PopupButtonSpec>): Frame {
	const bodyH = math.ceil(bodyLines(body) * TEXT.base * 1.45);
	const footerH = BUTTON_SIZE.default.h;
	// title strip + body + footer, with the card's padding
	const h = cardHeaderHeight() + bodyH + space(6) + footerH + space(6);
	// over a running match (a "?" opened from the Bag or from Settings) the street keeps moving behind it, so it only
	// dims it like every screen over a run (UI-06); in the menus it dims the screen it opens over
	const overRun = ctx.phase === "playing" || ctx.phase === "dead";
	const dialog = Dialog(ctx.uiLayer, "PopupOverlay", {
		w: DIALOG_W,
		h,
		title,
		zIndex: 300,
		scrim: overRun ? TRANSPARENCY.overWorld : TRANSPARENCY.overlay,
	});
	const card = dialog.card;
	const pad = space(6);
	const innerW = DIALOG_W - pad * 2;
	makeLabel(card, "PopupBody", body, pad, dialog.contentY, innerW, bodyH, TEXT.base, THEME.mutedForeground, {
		align: "left",
		valign: "top",
	});

	// DialogFooter: right-aligned, primary action last
	const count = buttons.size();
	const gap = space(2);
	const btnW = count > 0 ? math.min(200, (innerW - gap * (count - 1)) / count) : 0;
	let bx = DIALOG_W - pad - (btnW * count + gap * math.max(count - 1, 0));
	const footerY = h - pad - footerH;
	let primary: TextButton | undefined;
	let last: TextButton | undefined;
	for (let i = 0; i < count; i++) {
		const spec = buttons[i];
		const variant = variantOf(spec, i === count - 1);
		const b = Button(card, `PopupBtn${i}`, spec.text, {
			x: bx,
			y: footerY,
			w: btnW,
			variant,
			onClick: (): void => {
				if (spec.keepOpen !== true) dialog.close();
				if (spec.onClick !== undefined) spec.onClick();
			},
		});
		if (variant === "default") primary = b;
		last = b;
		bx += btnW + gap;
	}
	// a pad player lands on the dialog: its primary action, or -- a help or a Records popup, whose one button is a
	// secondary "Close" -- its last button. Left on the "?" behind the scrim, the next A opened a second popup
	const focus = primary ?? last;
	if (focus !== undefined) autoFocus(focus);
	return dialog.root;
}

/** sonner-style notification on top of everything; at most 4 visible, identical texts are merged */
export function toast(ctx: GameContext, text: string, kind: ToastKind = "info"): void {
	showToast(ctx.uiLayer, text, kind);
}
