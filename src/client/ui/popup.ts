import { GameContext } from "shared/game/context";
import {
	ButtonStyle,
	FONTS,
	PALETTE,
	makeAnchored,
	makeButton,
	makeFrame,
	makeLabel,
	makePanel,
	makeScreen,
	tween,
} from "./widgets";

export interface PopupButtonSpec {
	text: string;
	style?: ButtonStyle;
	onClick?: () => void;
	/** keep the popup open after the click (default: close) */
	keepOpen?: boolean;
}

/** modal dialog; returns the overlay (destroy it to close) */
export function popup(ctx: GameContext, title: string, body: string, buttons: Array<PopupButtonSpec>): Frame {
	const { root, body: area } = makeScreen(ctx.uiLayer, "PopupOverlay", {
		color: PALETTE.overlay,
		transparency: 0.4,
		zIndex: 300,
	});
	const panel = makePanel(area, "PopupPanel", 290, 130, 540, 370, { color: PALETTE.surface });
	makeLabel(panel, "PopupTitle", title, 32, 26, 476, 40, 26, PALETTE.text, { font: FONTS.display, align: "left" });
	makeFrame(panel, "Rule", 32, 74, 476, 2, PALETTE.accent, { transparency: 0.4 });
	makeLabel(panel, "PopupBody", body, 32, 92, 476, 180, 18, PALETTE.textDim, { align: "left", valign: "top" });
	const count = buttons.size();
	const gap = 14;
	const btnW = count > 0 ? math.min(200, (476 - gap * (count - 1)) / count) : 0;
	let bx = 540 - 32 - (btnW * count + gap * math.max(count - 1, 0));
	for (let i = 0; i < count; i++) {
		const spec = buttons[i];
		const style: ButtonStyle = spec.style ?? (i === count - 1 ? "primary" : "secondary");
		makeButton(panel, `PopupBtn${i}`, spec.text, bx, 294, btnW, 50, style, (): void => {
			if (spec.keepOpen !== true) root.Destroy();
			if (spec.onClick !== undefined) spec.onClick();
		});
		bx += btnW + gap;
	}
	return root;
}

export type ToastKind = "info" | "success" | "error" | "coin";

const MAX_TOASTS = 4;
const TOAST_TIME = 2.6;

function toastStack(ctx: GameContext): Frame {
	const existing = ctx.uiLayer.FindFirstChild("ToastStack");
	if (existing !== undefined && existing.IsA("Frame")) return existing;
	// top-centre, below the Roblox top bar and the HUD day box, above every panel/overlay of the UI layer
	const stack = makeAnchored(ctx.uiLayer, "ToastStack", 0.5, 0, 460, 230, 0, 70, true);
	stack.ZIndex = 1000;
	const layout = new Instance("UIListLayout");
	layout.SortOrder = Enum.SortOrder.LayoutOrder;
	layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
	layout.Padding = new UDim(0.02, 0);
	layout.Parent = stack;
	return stack;
}

function accentOf(kind: ToastKind): Color3 {
	if (kind === "success") return PALETTE.success;
	if (kind === "error") return PALETTE.danger;
	if (kind === "coin") return PALETTE.coin;
	return PALETTE.info;
}

let toastOrder = 0;

/** short notification on top of everything; at most 4 visible, identical texts are merged */
export function toast(ctx: GameContext, text: string, kind: ToastKind = "info"): void {
	const stack = toastStack(ctx);
	for (const child of stack.GetChildren()) {
		if (child.IsA("Frame") && child.GetAttribute("Text") === text) {
			// same message again: refresh it instead of stacking a copy
			child.SetAttribute("Born", os.clock());
			child.LayoutOrder = ++toastOrder;
			return;
		}
	}
	const live: Array<Frame> = [];
	for (const child of stack.GetChildren()) {
		if (child.IsA("Frame")) live.push(child);
	}
	live.sort((a, b) => a.LayoutOrder < b.LayoutOrder);
	while (live.size() >= MAX_TOASTS) {
		live.remove(0)?.Destroy();
	}
	const item = makeFrame(stack, "Toast", 0, 0, 460, 50, PALETTE.surface, {
		radius: 25,
		stroke: accentOf(kind),
		strokeTransparency: 0.35,
		transparency: 0.06,
	});
	item.Position = new UDim2();
	item.ZIndex = 1001;
	item.LayoutOrder = ++toastOrder;
	item.SetAttribute("Text", text);
	item.SetAttribute("Born", os.clock());
	makeFrame(item, "Dot", 18, 19, 12, 12, accentOf(kind), { radius: 6, zIndex: 1002 });
	const label = makeLabel(item, "Text", text, 40, 0, 404, 50, 17, PALETTE.text, {
		font: FONTS.medium,
		align: "left",
		zIndex: 1002,
	});
	task.spawn(() => {
		while (item.Parent !== undefined) {
			const born = item.GetAttribute("Born");
			if (typeIs(born, "number") && os.clock() - born >= TOAST_TIME) break;
			task.wait(0.2);
		}
		if (item.Parent === undefined) return;
		tween(item, 0.3, { BackgroundTransparency: 1 });
		tween(label, 0.3, { TextTransparency: 1 });
		task.wait(0.3);
		item.Destroy();
	});
}
