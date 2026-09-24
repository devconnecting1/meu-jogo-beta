/*
 * "Saving..." / "Saved" -- the one trust signal of automatic saving (docs/DESIGN_RULES.md SAV-01).
 *
 * The owner took the Save button out (2026-09-24: saving is automatic and has to make sense), so the player needs
 * another way to know their progress is safe. The SERVER decides every write (server/save/saveCadence.ts) and pushes
 * what happened to it on SaveAck (`store`, shared/net/net.ts); this draws it:
 *
 *   saving   a small floppy in muted grey and "Saving..."          until the answer comes
 *   saved    the floppy in green and "Saved"                        SAVED_HOLD_S, then it fades (Reduce Motion: it goes)
 *   failing  the floppy in red and "Progress not saved — retrying"  stays until a write lands: nobody quits thinking
 *                                                                     it saved while the DataStore is down
 *   stopped  the floppy in red and "Progress not saved"             stays: this server lost the session lock and will
 *                                                                     never write again (the player is elsewhere)
 *
 * Where: in the Roblox top bar, just right of its buttons (GuiService.TopbarInset, skin.ts `topBar`) -- the one strip
 * of the screen the HUD never uses (it stays under the bar's height, UI-02 / UI-09) and no menu needs, in the lobby and
 * in a run alike; when the bar has no free stretch (or the chip would not fit its height) it sits just under the bar
 * at the left. Not blocking: it takes no input and covers nothing a player aims at. It shows only for a write that
 * carried new progress (the server does not announce a lock refresh), so at most once per write -- about once a
 * minute while playing -- and never per frame.
 *
 * The chip is a sunk `well` of the kit with the light text on it (UI-05, measured by test:contrast), colours from the
 * theme only (UI-01), no contour (UI-04). Built once, on the first notice; afterwards a notice rewrites a colour, a
 * text, a size or Visible, and the fade rewrites transparencies -- no Instance is ever created again (UI-09's rule,
 * checked by test:hud section 8), and no Tween either: the fade is stepped here, on Heartbeat, only while it runs.
 */
import { GameContext } from "shared/game/context";
import { langGet } from "shared/data/lang";
import type { StoreState } from "shared/net/net";
import { onStoreState } from "../systems/saveClient";
import { PixelIcon } from "./pixelIcon";
import { topBar } from "./skin";
import { GAME, TEXT, THEME } from "./theme";
import {
	makeLabel,
	makeSurface,
	onLayoutChange,
	reducedMotion,
	setDesign,
	setSurfaceTransparency,
	uiScale,
	viewportSize,
} from "./widgets";

const RunService = game.GetService("RunService");

/** over the menus (250) and the popups (300) and the hit flash (350), under the toasts (1000) */
const INDICATOR_Z = 900;
/** the chip in design units: "Saving..." / "Saved" */
export const CHIP_W = 118;
/** the chip that carries a failure message */
export const CHIP_W_WIDE = 300;
export const CHIP_H = 26;
/** floppy side, design units */
const ICON = 16;
/** from the Roblox buttons (or the screen's edge), design units */
const GAP = 8;
/** how long "Saved" stays before it fades (s) */
export const SAVED_HOLD_S = 2.5;
/** the fade-out (s); 0 with Reduce Motion */
export const FADE_S = 0.4;
/** a "Saving..." no answer followed (the connection dropped): it goes after this long (s) */
const SAVING_TIMEOUT_S = 45;

interface Look {
	key: string;
	icon: Color3;
	text: Color3;
	wide: boolean;
	/** s the chip stays before fading; undefined = until the next notice */
	hold: number | undefined;
}

/** each state's words (lang.ts keys), colours (theme tokens) and how long it stays */
export const LOOKS: Record<StoreState, Look> = {
	saving: {
		key: "Saving...",
		icon: THEME.mutedForeground,
		text: THEME.mutedForeground,
		wide: false,
		hold: SAVING_TIMEOUT_S,
	},
	saved: { key: "Saved", icon: GAME.success, text: THEME.foreground, wide: false, hold: SAVED_HOLD_S },
	failing: {
		key: "Progress not saved — retrying",
		icon: THEME.destructive,
		text: THEME.destructive,
		wide: true,
		hold: undefined,
	},
	stopped: {
		key: "Progress not saved",
		icon: THEME.destructive,
		text: THEME.destructive,
		wide: true,
		hold: undefined,
	},
};

export class SaveIndicator {
	private readonly layer: Instance;
	private readonly lang: () => number;
	private root: Frame | undefined;
	private chip: Frame | undefined;
	private label: TextLabel | undefined;
	private icon: PixelIcon | undefined;
	private readonly pixels = new Array<Frame>();
	private state: StoreState | undefined;
	private wide = false;
	/** s left before the fade starts (undefined = no timer) */
	private holdLeft: number | undefined;
	/** s left of the fade (undefined = not fading) */
	private fadeLeft: number | undefined;
	/** the transparency the chip is drawn at now (0 = shown) */
	private alpha = 0;

	constructor(layer: Instance, lang: () => number) {
		this.layer = layer;
		this.lang = lang;
	}

	/** the server's news about a write of the save */
	show(state: StoreState): void {
		const look = LOOKS[state];
		this.build();
		const root = this.root!;
		this.state = state;
		const text = langGet(look.key, this.lang());
		const label = this.label!;
		if (label.Text !== text) label.Text = text;
		if (label.TextColor3 !== look.text) label.TextColor3 = look.text;
		this.icon!.setColor(look.icon);
		if (this.wide !== look.wide) {
			this.wide = look.wide;
			this.layout();
		}
		this.holdLeft = look.hold;
		this.fadeLeft = undefined;
		this.setAlpha(0);
		if (!root.Visible) root.Visible = true;
	}

	/** one frame: the hold, then the fade (Reduce Motion: no fade, the chip just goes) */
	step(dt: number): void {
		let rest = dt;
		if (this.holdLeft !== undefined) {
			this.holdLeft -= rest;
			if (this.holdLeft > 0) return;
			// the part of this frame past the hold already fades
			rest = -this.holdLeft;
			this.holdLeft = undefined;
			if (reducedMotion()) {
				this.hide();
				return;
			}
			this.fadeLeft = FADE_S;
		}
		if (this.fadeLeft === undefined) return;
		this.fadeLeft -= rest;
		if (this.fadeLeft <= 0) {
			this.hide();
			return;
		}
		this.setAlpha(1 - this.fadeLeft / FADE_S);
	}

	/** what is on screen (tests): the state, or undefined when the chip is hidden */
	shown(): StoreState | undefined {
		return this.root !== undefined && this.root.Visible ? this.state : undefined;
	}

	/** the chip's root (tests) */
	frame(): Frame | undefined {
		return this.root;
	}

	private hide(): void {
		this.fadeLeft = undefined;
		this.holdLeft = undefined;
		if (this.root !== undefined && this.root.Visible) this.root.Visible = false;
		this.setAlpha(0);
	}

	private setAlpha(t: number): void {
		if (t === this.alpha) return;
		this.alpha = t;
		if (this.chip !== undefined) setSurfaceTransparency(this.chip, t);
		if (this.label !== undefined) this.label.TextTransparency = t;
		for (const px of this.pixels) px.BackgroundTransparency = t;
	}

	/** built on the first notice: a session that never writes (Studio, a read-only one) never builds it */
	private build(): void {
		if (this.root !== undefined) return;
		const root = new Instance("Frame");
		root.Name = "SaveIndicator";
		root.BackgroundTransparency = 1;
		root.BackgroundColor3 = THEME.background;
		root.BorderSizePixel = 0;
		root.Active = false;
		root.Selectable = false;
		root.Visible = false;
		root.ZIndex = INDICATOR_Z;
		setDesign(root, CHIP_W, CHIP_H);
		this.chip = makeSurface(root, "Chip", 0, 0, CHIP_W, CHIP_H, "well", { zIndex: INDICATOR_Z });
		this.icon = PixelIcon(
			root,
			"Icon",
			"save",
			CHIP_H / 2,
			CHIP_H / 2,
			ICON,
			THEME.mutedForeground,
			INDICATOR_Z + 1,
		);
		for (const px of this.icon.frame.GetChildren()) if (px.IsA("Frame")) this.pixels.push(px);
		this.label = makeLabel(root, "Text", "", CHIP_H, 0, CHIP_W - CHIP_H - GAP, CHIP_H, TEXT.sm, THEME.foreground, {
			font: "label",
			align: "left",
			zIndex: INDICATOR_Z + 1,
		});
		this.root = root;
		onLayoutChange(root, () => this.layout());
		root.Parent = this.layer;
	}

	/** in the top bar right of the Roblox buttons, or just under the bar when it has no room (see the header) */
	private layout(): void {
		const root = this.root;
		const label = this.label;
		const icon = this.icon;
		if (root === undefined || label === undefined || icon === undefined) return;
		const s = uiScale();
		const bar = topBar();
		const v = viewportSize();
		const w = math.round((this.wide ? CHIP_W_WIDE : CHIP_W) * s);
		const h = math.round(CHIP_H * s);
		const gap = math.max(2, math.round(GAP * s));
		let x = gap;
		let y = gap;
		if (bar.h > 0) {
			const inBar = h <= bar.h - 2 && bar.freeMin < v.X && bar.freeMin + gap + w <= bar.freeMax;
			x = inBar ? bar.freeMin + gap : gap;
			y = inBar ? math.floor((bar.h - h) / 2) : bar.h + gap;
		}
		root.Position = UDim2.fromOffset(x, y);
		root.Size = UDim2.fromOffset(w, h);
		icon.frame.Position = UDim2.fromOffset(math.floor(h / 2), math.floor(h / 2));
		label.Position = UDim2.fromOffset(h, 0);
		label.Size = UDim2.fromOffset(math.max(0, w - h - gap), h);
	}
}

/** listens for the server's news about the save's writes for the rest of the session (call once, at boot) */
export function startSaveIndicator(ctx: GameContext): SaveIndicator {
	const indicator = new SaveIndicator(ctx.uiLayer, () => ctx.save.settings.langType);
	onStoreState(state => indicator.show(state));
	RunService.Heartbeat.Connect(dt => indicator.step(dt));
	return indicator;
}
