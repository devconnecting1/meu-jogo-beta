/*
 * The HUD's quick HEAL and EAT plates (docs/DESIGN_RULES.md ITM-07, UI-09): heal or eat in one press, without opening
 * the Bag -- nothing pauses (UI-06), and the Bag covers ~80% of a 16:9 screen.
 *
 *   desktop ("row", in the console's vitals section, at the end of the bar each one fills):
 *     [####HP 88 / 100####...] [bnd 3 H]          the plate: the item it will use (pixel icon, UI-11), how many of
 *     [##FOOD 58 / 100##.....] [can 5 F]          its kind the backpack holds, and the key on this device (H / F on
 *     [#LV 3 · 30 / 120..................]        the keyboard, a pixel arrow for the D-pad's up / down on a pad)
 *
 *   touch ("tile", QuickDeck: two thumb-sized tiles on their own small plate over the console's bars, hud.ts places it):
 *     .-----------.
 *     | [bnd][can] |   the icon in the middle of the tile, the count in a dark chip at its foot, no key (a tap is
 *     '-----------'   the key, like the hotbar's)
 *
 * What a plate says, from the shared pick (shared/game/quickUse.ts) the client runtime hands it every frame
 * (client/systems/quickUse.ts QuickView): usable = raised iron (pressable, UI-07); nothing to do -- none, the bar
 * full, dead -- the empty socket (dark, ringed) with the icon greyed and the count muted, and the reason on the
 * tooltip (desktop, under the mouse) or in the feed when pressed anyway (every device). The use cooldown is a dark veil
 * draining from the top (UI-06 does not pause the world, so the plate shows the wait instead); a use lights the plate
 * for a moment (the "pulse") and lifts the icon a pixel -- with Reduce Motion, the light only.
 *
 * A click or a tap writes `InputState.quickUsePressed` (the field H / F and the D-pad write): one path. Built once;
 * `update` creates nothing and writes only what changed (tools/test-hud.mjs: 600 frames, no Instance).
 *
 * Its own module for Luau's 200-locals-per-chunk budget (npm run check:registers), and it never imports hudConsole.ts
 * (which imports it): hud.ts places the touch deck with hudConsole.ts placeTouchQuick.
 */
import { ItemKind } from "shared/data/kinds";
import { USABLES } from "shared/data/usables";
import { iconKeys } from "shared/data/itemIcons";
import { PlayerSaveData } from "shared/game/save";
import { QUICK_HEAL_KIND, QuickVitals, newQuickPick, quickPick } from "shared/game/quickUse";
import type { QuickView } from "../systems/quickUse";
import { IconView, drawItemIcon, maxFrameCount } from "./itemIcon";
import { PlateState, paintPlate, reliefPx } from "./plate";
import { STAT, SURFACE, TEXT, THEME, TRANSPARENCY, fontOf } from "./theme";
import { Px, pixelIcon } from "./hudSky";
import { SCHEMES, SCHEME_GAMEPAD } from "./tutorial";
import { Groove, Section } from "./window";
import * as W from "./widgets";

const BOLD = fontOf("sans", Enum.FontWeight.Bold);
const NUMERIC = fontOf("mono", Enum.FontWeight.Bold);

/** the row of SCHEMES the plates' keys come from (tutorial.ts) */
export const QUICK_ROW = "Quick heal / eat";

/** relief of the groove a row plate sits in, of the plate, of the empty socket's ring */
const GROOVE_UNIT = 2;
const PLATE_UNIT = 2;
const TILE_UNIT = 4;
const SOCKET_UNIT = 2;
/** a row plate's key cap (design units of the plate): its side and its right margin */
const KEY_SIDE = 12;
const KEY_RIGHT = 2;
/** a row plate's icon starts this far in; the count sits between it and the key */
const ICON_LEFT = 2;
/** a tile's count chip: its height as a share of the tile, its distance from the bottom and the sides (the hotbar's) */
const CHIP_SHARE = 0.22;
const CHIP_BOTTOM = 2;
const CHIP_SIDE = 4;
/** the Frames of the costliest usable icon: every plate holds that many from the start (a pick change creates none) */
const USE_ICON_FRAMES = maxFrameCount(iconKeys(ItemKind.Use));

/** the D-pad's arrow on a pad (7 x 7, hudSky.ts pixelIcon): up heals, down eats */
const ARROW_UP: Array<Px> = [
	[3, 1, 1, 1],
	[2, 2, 3, 1],
	[1, 3, 5, 1],
	[0, 4, 7, 1],
];
const ARROW_DOWN: Array<Px> = [
	[0, 2, 7, 1],
	[1, 3, 5, 1],
	[2, 4, 3, 1],
	[3, 5, 1, 1],
];

/**
 * The key of plate `kind` on `scheme`, from the real bindings (tutorial.ts SCHEMES, the row QUICK_ROW): a keyboard's
 * "H / F" gives each plate its letter; a pad shows the D-pad's arrow ("pad"); touch taps the plate itself (none).
 */
export function quickLegend(scheme: number, kind: number): string {
	const s = SCHEMES[scheme];
	if (s === undefined) return "";
	let chip = "";
	for (const [c, does] of s.rows) if (does === QUICK_ROW) chip = c;
	if (chip === "") return "";
	if (scheme === SCHEME_GAMEPAD) return "pad";
	const key = chip.split(" / ")[kind] ?? "";
	return key.size() > 0 && key.size() <= 2 ? key : "";
}

/** the pick with no runtime behind it (a test's HUD, the first frame): the shared rule on the state's vitals */
const fallback: [QuickView, QuickView] = [newQuickPick(0) as QuickView, newQuickPick(1) as QuickView];
const fallbackVitals: QuickVitals = { hp: 0, hpMax: 0, hunger: 0, hungerMax: 0, dead: false };
export function quickViewsOf(
	save: PlayerSaveData,
	hp: number,
	hpMax: number,
	hunger: number,
	hungerMax: number,
): ReadonlyArray<QuickView> {
	fallbackVitals.hp = hp;
	fallbackVitals.hpMax = hpMax;
	fallbackVitals.hunger = hunger;
	fallbackVitals.hungerMax = hungerMax;
	fallbackVitals.dead = hp <= 0;
	for (let k = 0; k < 2; k++) {
		quickPick(k, save, fallbackVitals, fallback[k]);
		fallback[k].cooldown = 0;
		fallback[k].pulse = 0;
	}
	return fallback;
}

/** what the tooltip says of a plate: what a press does ("Bandage: +20 HP"), or why it does nothing */
export function quickTipText(view: QuickView, tr: (key: string) => string): string {
	const heal = view.kind === QUICK_HEAL_KIND;
	if (view.why === "ok") {
		const u = USABLES[view.id];
		const name = u !== undefined ? tr(u.name) : "";
		return `${name}: +${math.floor(view.gain + 0.5)} ${tr(heal ? "HP" : "FOOD")}`;
	}
	if (view.why === "none") return tr(heal ? "No healing items" : "No food");
	if (view.why === "full") return tr(heal ? "Already at full health" : "You're already full");
	if (view.why === "risky") return tr("Eating that would kill you");
	return "";
}

/** a crisp icon side for `px` pixels of room (itemIcon.ts draws 16 / 32 / 48 evenly, 24 / 40 as regular halves) */
function crispSide(px: number): number {
	for (const s of [64, 48, 40, 32, 24, 16]) if (s <= px + 2) return s;
	return 16;
}

export type QuickShape = "row" | "tile";

/**
 * One quick plate. `row`: `w` x `h` design units of `parent` at (x, y), a dark groove with the plate in it. `tile`: a
 * square tile of `w` placed straight on `parent` (a groove bed, like a hotbar tile).
 */
export class QuickPlate {
	readonly kind: number;
	readonly shape: QuickShape;
	/** the pressable plate */
	readonly button: TextButton;
	/** what hosts it: its groove (row) or the button itself (tile) */
	readonly host: Frame | TextButton;
	private readonly icon: IconView;
	private readonly count: TextLabel;
	private readonly chip: Frame | undefined;
	private readonly key: Frame | undefined;
	private readonly legend: TextLabel | undefined;
	private readonly up: Frame | undefined;
	private readonly down: Frame | undefined;
	private readonly veil: Frame;
	private readonly unit: number;
	/** the design size of the plate (the icon's fit before the engine sizes it) */
	private readonly dw: number;
	private readonly dh: number;
	// what is on screen now (a frame writes only a change)
	private id = -2;
	private dim = false;
	private countNow = -1;
	/** usable now (undefined until the first update: the count's colour is written then) */
	private live: boolean | undefined;
	private hot = false;
	private cool = -1;
	private lift = false;
	private legendNow = "?";
	private iconAt = "";
	private hovered = false;

	constructor(
		parent: Frame,
		name: string,
		kind: number,
		shape: QuickShape,
		x: number,
		y: number,
		w: number,
		h: number,
		z: number,
		onPress: () => void,
	) {
		this.kind = kind;
		this.shape = shape;
		this.unit = shape === "tile" ? TILE_UNIT : PLATE_UNIT;
		this.dw = w;
		this.dh = h;
		const b = new Instance("TextButton");
		b.Name = name;
		b.AutoButtonColor = false;
		b.BorderSizePixel = 0;
		b.BackgroundTransparency = 1;
		b.BackgroundColor3 = THEME.background;
		b.Text = "";
		b.TextColor3 = THEME.foreground;
		// the HUD never takes the pad's selection mid-fight (UI-09): the D-pad's up / down are its keys
		b.Selectable = false;
		b.SetAttribute("QuickKind", kind);
		if (shape === "row") {
			const groove = Groove(parent, `${name}Groove`, x, y, w, h);
			groove.ZIndex = z;
			b.ZIndex = z + 1;
			W.setDesign(b, w, h);
			b.Parent = groove;
			W.onLayoutChange(b, () => {
				const u = reliefPx(GROOVE_UNIT);
				b.Position = new UDim2(0, u, 0, u);
				b.Size = new UDim2(1, -2 * u, 1, -2 * u);
			});
			this.host = groove;
		} else {
			const [pw, ph] = W.designOf(parent);
			b.Position = UDim2.fromScale(x / pw, y / ph);
			b.Size = UDim2.fromScale(w / pw, h / ph);
			b.ZIndex = z;
			W.setDesign(b, w, h);
			b.Parent = parent;
			this.host = b;
		}
		this.button = b;
		const bz = b.ZIndex;

		// the item it will use: the Bag's and the card's drawing (UI-11), what it draws centred in its square; it holds
		// the Frames of the costliest usable icon from the start, so a new pick rewrites them and creates none
		this.icon = IconView(b, "ItemIcon", 0, 0, h, bz + 1, USE_ICON_FRAMES, "drawn");

		if (shape === "row") {
			// the count right after the icon ("×3", the Bag's way of counting), light on the iron (UI-05)
			const countX = ICON_LEFT + h - 2;
			const countW = w - countX - KEY_SIDE - KEY_RIGHT - 1;
			this.count = W.makeLabel(b, "Count", "", countX, 0, countW, h, TEXT.xs, THEME.secondaryForeground, {
				font: NUMERIC,
				align: "left",
				zIndex: bz + 2,
			});
			// the key: the kit's dark-iron key (information, never pressable), a letter or the D-pad's arrow
			const key = W.makeFrame(
				b,
				"Key",
				w - KEY_SIDE - KEY_RIGHT,
				(h - KEY_SIDE) / 2,
				KEY_SIDE,
				KEY_SIDE,
				THEME.background,
				{
					transparency: 1,
					zIndex: bz + 4,
				},
			);
			paintPlate(key, SURFACE.key, "idle", 2);
			this.legend = W.makeLabel(key, "Legend", "", 0, 0, KEY_SIDE, KEY_SIDE, TEXT.xs, THEME.foreground, {
				font: BOLD,
				zIndex: bz + 5,
			});
			const arrows = W.makeFrame(key, "Arrow", 3, 3, KEY_SIDE - 6, KEY_SIDE - 6, THEME.background, {
				transparency: 1,
				zIndex: bz + 5,
			});
			this.up = pixelIcon(arrows, "Up", ARROW_UP, THEME.foreground, bz + 5);
			this.down = pixelIcon(arrows, "Down", ARROW_DOWN, THEME.foreground, bz + 5);
			this.up.Visible = false;
			this.down.Visible = false;
			key.Visible = false;
			this.key = key;
		} else {
			// the count in a dark chip at the foot, the number in the numbers' yellow (the hotbar's ammo chip)
			const chipH = math.round(w * CHIP_SHARE);
			const chipW = w - 2 * CHIP_SIDE;
			const chip = W.makeFrame(b, "Chip", CHIP_SIDE, h - chipH - CHIP_BOTTOM, chipW, chipH, THEME.background, {
				transparency: 1,
				zIndex: bz + 3,
			});
			paintPlate(chip, SURFACE.well, "flat", 1);
			this.chip = chip;
			this.count = W.makeLabel(chip, "Count", "", 2, 0, chipW - 4, chipH, TEXT.xs, STAT.value, {
				font: NUMERIC,
				zIndex: bz + 4,
			});
		}

		// the use cooldown: a dark veil over the plate, draining from the top (anchored at the bottom)
		const veil = new Instance("Frame");
		veil.Name = "Cooldown";
		veil.BorderSizePixel = 0;
		veil.BackgroundColor3 = SURFACE.well;
		veil.BackgroundTransparency = TRANSPARENCY.cooldown;
		veil.AnchorPoint = new Vector2(0, 1);
		veil.Position = UDim2.fromScale(0, 1);
		veil.Size = UDim2.fromScale(1, 0);
		veil.Visible = false;
		veil.ZIndex = bz + 3;
		veil.Parent = b;
		this.veil = veil;

		b.GetPropertyChangedSignal("GuiState").Connect(() => {
			this.hovered = b.GuiState === Enum.GuiState.Hover || b.GuiState === Enum.GuiState.Press;
			this.paint();
		});
		b.Activated.Connect(onPress);
		b.GetPropertyChangedSignal("AbsoluteSize").Connect(() => this.placeIcon());
		W.onLayoutChange(b, () => this.placeIcon());
		// the plate's Frames are made now, never by a frame's update (plate.ts builds them on the first paint)
		this.paint();
	}

	/** the mouse is over it (the console shows its tooltip) */
	isHovered(): boolean {
		return this.hovered;
	}

	/** paints the plate from its state and the pointer: usable = raised iron, else the empty socket */
	private paint(): void {
		const b = this.button;
		if (this.live !== true) {
			paintPlate(b, SURFACE.well, "outline", SOCKET_UNIT, SURFACE.line);
			return;
		}
		const gs = b.GuiState;
		const pressed = gs === Enum.GuiState.Press;
		const state: PlateState = pressed ? "press" : this.hot || gs === Enum.GuiState.Hover ? "hot" : "idle";
		paintPlate(b, THEME.secondary, state, this.unit);
	}

	/**
	 * The icon's square, in the plate's pixels once it has a size (a crisp side: itemIcon.ts draws whole pixels), in
	 * design units before. Row: at the left, centred on the height; tile: centred on the face above the chip. `lift`
	 * raises it a pixel (the pulse). Runs on a resize and on the pulse, never every frame.
	 */
	private placeIcon(): void {
		const b = this.button;
		const T = b.AbsoluteSize;
		const px = T.X > 0 && T.Y > 0;
		const at = `${T.X},${T.Y},${this.lift}`;
		if (at === this.iconAt) return;
		this.iconAt = at;
		const f = this.icon.frame;
		if (!px) {
			const side = this.shape === "row" ? this.dh : this.dh - math.round(this.dw * CHIP_SHARE) - CHIP_BOTTOM;
			const x = this.shape === "row" ? ICON_LEFT : (this.dw - side) / 2;
			f.Position = UDim2.fromScale(x / this.dw, 0);
			f.Size = UDim2.fromScale(side / this.dw, side / this.dh);
			return;
		}
		const s = T.Y / this.dh;
		const u = reliefPx(this.unit);
		const lift = this.lift ? math.max(1, math.floor(s + 0.5)) : 0;
		let side: number;
		let x: number;
		let y: number;
		if (this.shape === "row") {
			side = crispSide(T.Y - 2 * u);
			x = math.floor(ICON_LEFT * s + 0.5);
			y = math.floor((T.Y - side) / 2 + 0.5) - lift;
		} else {
			const chipTop = T.Y - (CHIP_BOTTOM + math.round(this.dw * CHIP_SHARE)) * s;
			side = crispSide(math.min(T.X - 2 * u, chipTop - u) - 2);
			x = math.floor((T.X - side) / 2 + 0.5);
			y = math.floor((u + chipTop - side) / 2 + 0.5) - lift;
		}
		f.Position = UDim2.fromOffset(x, y);
		f.Size = UDim2.fromOffset(side, side);
	}

	/** the text size of the count and the key when the touch deck is scaled (hud.ts placeConsole) */
	scaleText(mult: number): void {
		W.scaleText(this.count, TEXT.xs * mult);
		if (this.legend !== undefined) W.scaleText(this.legend, TEXT.xs * mult);
	}

	/**
	 * Every frame: the plate from `view` (the pick, the cooldown, the pulse) and the key of `scheme`. `still` = Reduce
	 * Motion: the veil holds instead of draining and the icon does not jump. Writes only what changed.
	 */
	update(view: QuickView, scheme: number, still: boolean): void {
		// the pulse answers the press: the plate stays lit through it even when that use just filled the bar (it greys
		// out once the light is over -- "full" is the next thing the plate has to say, not an interruption of this one)
		const pulsing = view.pulse > 0;
		const live = view.why === "ok" || pulsing;
		const dim = !live;
		if (view.id !== this.id || dim !== this.dim) {
			this.id = view.id;
			this.dim = dim;
			drawItemIcon(this.icon, ItemKind.Use, view.id, dim);
		}
		if (view.count !== this.countNow) {
			this.countNow = view.count;
			this.count.Text = `×${W.fmtInt(view.count)}`;
		}
		const hot = pulsing;
		if (live !== this.live || hot !== this.hot) {
			const wasLive = this.live;
			this.live = live;
			this.hot = hot;
			this.paint();
			if (live !== wasLive) {
				const onPlate = this.shape === "row";
				this.count.TextColor3 = live
					? onPlate
						? THEME.secondaryForeground
						: STAT.value
					: THEME.mutedForeground;
			}
		}
		// the pulse lifts the icon for its first half (a jump: not under Reduce Motion)
		const lift = !still && view.pulse > 0.5;
		if (lift !== this.lift) {
			this.lift = lift;
			this.placeIcon();
		}
		// the veil: the part of the use cooldown still to run; held whole under Reduce Motion, gone when ready
		const cool = view.cooldown > 0 ? (still ? 1 : math.clamp(view.cooldown, 0, 1)) : 0;
		if (cool !== this.cool) {
			this.cool = cool;
			const on = cool > 0;
			if (this.veil.Visible !== on) this.veil.Visible = on;
			if (on) this.veil.Size = UDim2.fromScale(1, cool);
		}
		const key = this.key;
		if (key === undefined) return;
		const legend = quickLegend(scheme, this.kind);
		if (legend === this.legendNow) return;
		this.legendNow = legend;
		key.Visible = legend !== "";
		const pad = legend === "pad";
		if (this.legend !== undefined) this.legend.Text = pad ? "" : legend;
		if (this.up !== undefined) this.up.Visible = pad && this.kind === QUICK_HEAL_KIND;
		if (this.down !== undefined) this.down.Visible = pad && this.kind !== QUICK_HEAL_KIND;
	}
}

/**
 * the touch deck's design size: two tiles on a groove bed, in a section, in the console's body and frame -- body ->
 * section -> groove, as the console and the touch sky: a groove straight on the graphite body is 1,15:1 and vanishes
 */
export const DECK_PAD = 5;
export const DECK_INSET = 4;
export const DECK_BED_PAD = 4;
export const DECK_GAP = 4;

/** the deck's design width and height for tiles of `tile` design units */
export function deckSize(tile: number): [number, number] {
	const frame = (DECK_PAD + DECK_INSET + DECK_BED_PAD) * 2;
	return [frame + tile * 2 + DECK_GAP, frame + tile];
}

/**
 * Touch: the two quick tiles on their own small plate, the console's vocabulary (UI-07: the graphite body and its
 * frame, the section, the dark groove bed, the tiles on it), as big as the hotbar's tiles -- a thumb's (>= MIN_TOUCH_PX).
 * hud.ts places it over the console's bars, clear of every thumb control (hudConsole.ts placeTouchQuick).
 */
export class QuickDeck {
	readonly frame: Frame;
	readonly plates: Array<QuickPlate> = [];
	readonly w: number;
	readonly h: number;

	constructor(root: Frame, tile: number, onPress: (kind: number) => void) {
		const [w, h] = deckSize(tile);
		this.w = w;
		this.h = h;
		const frame = new Instance("Frame");
		frame.Name = "QuickDeck";
		frame.BackgroundTransparency = 1;
		frame.BackgroundColor3 = THEME.background;
		frame.BorderSizePixel = 0;
		// with the console: above the damage vignette, under the touch layer (ZIndex 8), which it never overlaps
		frame.ZIndex = 2;
		frame.Size = UDim2.fromOffset(w, h);
		W.setDesign(frame, w, h);
		frame.Parent = root;
		this.frame = frame;
		const body = W.Card(frame, "Body", { x: 0, y: 0, w, h, fill: SURFACE.window, pad: DECK_PAD });
		const sw = w - DECK_PAD * 2;
		const sh = h - DECK_PAD * 2;
		const section = Section(body, "Quick", {
			x: DECK_PAD,
			y: DECK_PAD,
			w: sw,
			h: sh,
			zIndex: body.ZIndex + 1,
		}).frame;
		const bed = Groove(section, "QuickBed", DECK_INSET, DECK_INSET, sw - DECK_INSET * 2, sh - DECK_INSET * 2);
		bed.ZIndex = section.ZIndex + 1;
		for (let k = 0; k < 2; k++) {
			const x = DECK_BED_PAD + k * (tile + DECK_GAP);
			const name = k === QUICK_HEAL_KIND ? "QuickHeal" : "QuickEat";
			this.plates.push(
				new QuickPlate(bed, name, k, "tile", x, DECK_BED_PAD, tile, tile, bed.ZIndex + 1, () => onPress(k)),
			);
		}
	}

	/** placed in screen pixels (hud.ts, from placeTouchQuick) at `scale` px per design unit; its text scaled with it */
	place(x: number, y: number, scale: number): void {
		this.frame.Position = UDim2.fromOffset(math.round(x), math.round(y));
		this.frame.Size = UDim2.fromOffset(math.ceil(this.w * scale), math.ceil(this.h * scale));
		const mult = math.clamp(scale / math.max(W.uiScale(), 0.05), 0.5, 4);
		for (const p of this.plates) p.scaleText(mult);
	}

	update(views: ReadonlyArray<QuickView>, scheme: number, still: boolean): void {
		for (let k = 0; k < this.plates.size(); k++) {
			const v = views[k];
			if (v !== undefined) this.plates[k].update(v, scheme, still);
		}
	}
}

/**
 * Desktop: the one tooltip of the two plates, over the console's vitals, under the mouse only -- what a press does, or
 * why it does nothing (the reason a greyed plate owes the player). A child of the console, above its top edge; built
 * once, written only when the text changes.
 */
export class QuickTip {
	readonly frame: Frame;
	private readonly label: TextLabel;
	private text = "";

	constructor(parent: Frame, x: number, y: number, w: number, h: number, z: number) {
		const card = W.Card(parent, "QuickTip", { x, y, w, h, fill: SURFACE.window, pad: 4, zIndex: z });
		this.frame = card;
		this.label = W.makeLabel(card, "Text", "", 6, 0, w - 12, h, TEXT.sm, THEME.foreground, {
			font: "label",
			zIndex: z + 2,
		});
		card.Visible = false;
	}

	show(text: string): void {
		const on = text !== "";
		if (text !== this.text) {
			this.text = text;
			this.label.Text = text;
		}
		if (this.frame.Visible !== on) this.frame.Visible = on;
	}
}
