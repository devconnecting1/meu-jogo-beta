/*
 * The HUD console and the day plate (docs/DESIGN_RULES.md UI-09): the in-run HUD in the vocabulary of the owner's
 * "Settings" window (UI-07). Layout idea from Pixel Quest's HUD -- one framed console at the bottom centre --
 * and nothing else from it: every piece below is one of OUR kit's pieces and means something in OUR game.
 *
 *   desktop, 638 x 114 design units (x the UI size setting), 12 above the bottom edge
 *   #=============================================================================================#
 *   # .-----------------------. .--------------------------------------. .-------------------.   #
 *   # | [####HP 88 / 100####..] | |[1 ]  [2 ]  [3 ]  [   ]  [   ]       | | Pistol            |   #
 *   # | [##FOOD 58 / 100##....] | |[ D]  [ A]  [ P]  (   )  (   )       | | Pistol            |   #
 *   # | [#LV 3 · 30 / 120.....] | |           [7/41]                   | | [ 7 / 41        ] |   #
 *   # '-----------------------' '--------------------------------------' '-------------------'   #
 *   #                                [bag  B]  [menu  P]                                          #
 *   #=============================================================================================#
 *     the UI-07 frame and graphite body; three section plates (lighter iron) holding dark grooves:
 *     vitals (three bars)          weapons (five tiles on a groove bed)   the weapon in hand (name,
 *                                  and under it the Bag / Menu plates     type, a magazine readout)
 *
 *   touch (compact): the vitals and the weapons sections only, 512 x 88 design units, scaled so a tile is a thumb
 *   wide and placed in the free band between the move stick and the fire controls (placeTouchConsole).
 *
 * What each part is in the game:
 *  - the three bars are the survivor's HP, food (hunger, 0..100) and XP towards the next level, with the level
 *    written in the XP bar ("LV 3 · 30 / 120"), like the reference. Each fill is a plate in relief (plate.ts) in
 *    its BAR token, darkened until the light label reads at 4,5:1 (UI-05); the label is never outlined (UI-04);
 *  - the five tiles are the first five weapons of `weaponKeyOrder` (shared/game/weaponSlots.ts), the very list
 *    keys 1-5 pick from (client/systems/combat.ts), in the same order. The weapon in hand is the raised BLUE tile
 *    ("what is chosen is blue", UI-07), another owned weapon is flat dark iron, a key with no weapon is an empty
 *    socket on the groove. Each tile shows the item's glyph (the Bag's and the item card's icon), the key that
 *    picks it on this device (keyboard 1-5; the pad has no such key and touch taps the tile itself, so neither
 *    shows one) and, for a gun, its ammo in the item card's yellow: magazine / reserve on the gun in hand, the
 *    reserve alone on the others (a gun you are not holding keeps its rounds in the pool: combat.ts switchWeapon
 *    empties the magazine back into it). A reload refills the tile in hand from the bottom up;
 *  - a click or a tap on tile k writes `InputState.weaponSlotPressed = k`, the field key k writes
 *    (client/bootstrap.ts): combat has one way to switch weapons, not two;
 *  - the Bag and Menu plates are the two in-run actions that have a button today, each a pixel icon and its key
 *    on this device (B / LB, P / Start). Nothing else is added: there is no quick-use bar in this game;
 *  - the right column says what the old weapon card said: the weapon in hand, its type, and its magazine.
 *
 * Built once per mount; `update()` runs every frame and never creates or destroys an Instance: a weapon picked up
 * or lost rewrites a tile in place (the Bag's rule, tools/test-hud.mjs), and every property is written only when
 * its value changed.
 *
 * Separate from hud.ts for Luau's 200-locals-per-chunk budget (npm run check:registers).
 */
import { ItemKind } from "shared/data/kinds";
import { WEAPONS } from "shared/data/weapons";
import { MIN_TOUCH_PX, TouchLayout } from "shared/engine/input";
import { weaponReserve } from "shared/game/player";
import { PlayerSaveData } from "shared/game/save";
import { WEAPON_KEY_COUNT, weaponKeyOrder } from "shared/game/weaponSlots";
import { Glyph, kindTone, makeGlyph, setGlyph } from "./itemCard";
import { weaponKindName } from "./itemInfo";
import { PlateState, paintPlate, reliefPx } from "./plate";
import { BAR, GAME, STAT, SURFACE, TEXT, THEME, fontOf, hex } from "./theme";
import { SCHEMES, currentScheme } from "./tutorial";
import { Groove, Section } from "./window";
import * as W from "./widgets";

/** what the game hands the HUD every frame (client/main.client.ts pushHud) */
export interface HudState {
	hp: number;
	hpMax: number;
	hunger: number;
	hungerMax: number;
	level: number;
	exp: number;
	expMax: number;
	/**
	 * The WORLD's day (MP-13, MP-20): what the town is living through, shared by everyone on the server.
	 * It is the number in the spotlight because it is the one the night, the horde and the waves follow.
	 */
	day: number;
	/**
	 * This survivor's own day (MP-13): how long THIS life has lasted. It goes back to 1 on "New game" while
	 * `day` above does not move at all, which is the whole point of MP-20 -- so the HUD shows it next to the
	 * world's day whenever the two have parted company, and stays out of the way while they agree (alone in
	 * your own world they always do, and printing the same number twice explains nothing).
	 */
	lifeDay: number;
	/** 0..24 in-game hours */
	dayTime: number;
	isNight: boolean;
	/** a watch/sundial is equipped: show HH:MM (as in the original, the time is an item perk) */
	showClock: boolean;
	/** the weapon in hand (PlayerState.weapon.pointer): the blue tile of the hotbar */
	weaponId: number;
	weaponName: string;
	mag: number;
	magSize: number;
	reloading: boolean;
	reloadRatio: number;
	ammoPool: number;
	/** 1 → 0 after taking damage */
	hitFlash: number;
}

const BOLD = fontOf("sans", Enum.FontWeight.Bold);
const EXTRA_BOLD = fontOf("sans", Enum.FontWeight.ExtraBold);
const NUMERIC = fontOf("mono", Enum.FontWeight.Bold);

// ---------------------------------------------------------------- layout (design units)

interface Layout {
	w: number;
	h: number;
	/** from the frame to the sections */
	pad: number;
	/** from a section's edge to its groove(s) */
	inset: number;
	/** between two sections */
	colGap: number;
	barW: number;
	barH: number;
	barGap: number;
	tile: number;
	/** the weapon column and the Bag / Menu plates (desktop only: on touch the touch layer owns those buttons) */
	full: boolean;
}

const TILE_GAP = 4;
/** the groove bed around the tiles */
const BED_PAD = 4;
/** the Bag / Menu plates under the hotbar's section */
const ICON_ROW_GAP = 6;
const ICON_H = 22;
const ICON_W = 76;
const ICON_GAP = 8;
/** the weapon column's content width (desktop) */
const SIDE_W = 124;
/** the weapon column's readout bed */
const READOUT_H = 40;
/** the console's distance from the bottom of the screen on desktop */
export const CONSOLE_MARGIN = 12;

function bedW(tile: number): number {
	return WEAPON_KEY_COUNT * tile + (WEAPON_KEY_COUNT - 1) * TILE_GAP + BED_PAD * 2;
}
function barsH(L: Layout): number {
	return 3 * L.barH + 2 * L.barGap;
}

/** the console's size from its parts: [vitals] [hotbar (+ the Bag / Menu row)] [weapon], each in its section */
function sized(L: Layout): Layout {
	const vitalsW = L.inset * 2 + L.barW;
	const hotbarW = L.inset * 2 + bedW(L.tile);
	const sideW = L.full ? L.colGap + L.inset * 2 + SIDE_W : 0;
	L.w = L.pad * 2 + vitalsW + L.colGap + hotbarW + sideW;
	const hotbarH = L.inset * 2 + L.tile + BED_PAD * 2 + (L.full ? ICON_ROW_GAP + ICON_H : 0);
	L.h = L.pad * 2 + math.max(L.inset * 2 + barsH(L), hotbarH);
	return L;
}

/**
 * 10 + 200 + 8 + 266 + 8 + 136 + 10 = 638 wide, 10 + 94 + 10 = 114 tall: bars 188 x 22 (3 x 22 + 2 x 8 = 82),
 * tiles 46 (the bed 254 x 54), the Bag / Menu row 22 under the hotbar's section.
 */
export const DESKTOP_LAYOUT: Layout = sized({
	w: 0,
	h: 0,
	pad: 10,
	inset: 6,
	colGap: 8,
	barW: 188,
	barH: 22,
	barGap: 8,
	tile: 46,
	full: true,
});

/** 8 + 192 + 8 + 296 + 8 = 512 wide, 8 + 72 + 8 = 88 tall: bars 180 x 18 (3 x 18 + 2 x 3 = 60), tiles 52 */
export const COMPACT_LAYOUT: Layout = sized({
	w: 0,
	h: 0,
	pad: 8,
	inset: 6,
	colGap: 8,
	barW: 180,
	barH: 18,
	barGap: 3,
	tile: 52,
	full: false,
});

/** relief of the grooves (window.ts Groove), of a bar's fill and of a tile */
const GROOVE_UNIT = 2;
const FILL_UNIT = 2;
const TILE_UNIT = 4;
/** the ring of an empty socket */
const SOCKET_UNIT = 2;

/** HP below this blinks its fill out; food below this blinks red (the old HUD's thresholds) */
const LOW_HP = 0.25;
const LOW_FOOD = 0.15;
/** the HP fill lights up (the plate's "hot" light) while the hit flash is above this */
const HIT_HOT = 0.4;
/** the blink: sin(t x 8) -- 1,27 blinks a second, far under the 3 a second of WCAG 2.3.1 */
const BLINK_RATE = 8;

// ---------------------------------------------------------------- pixel icons

/** a pixel-art icon: [x, y, w, h] rectangles on a grid, drawn with Frames that fill their host */
type Px = [number, number, number, number];

const SUN: Array<Px> = [
	[2, 2, 3, 3],
	[3, 0, 1, 1],
	[3, 6, 1, 1],
	[0, 3, 1, 1],
	[6, 3, 1, 1],
	[1, 1, 1, 1],
	[5, 1, 1, 1],
	[1, 5, 1, 1],
	[5, 5, 1, 1],
];
/** a crescent, horns to the right */
const MOON: Array<Px> = [
	[2, 0, 3, 1],
	[1, 1, 2, 1],
	[0, 2, 2, 3],
	[1, 5, 2, 1],
	[2, 6, 3, 1],
];
/** a satchel: the handle, and the body with its buckle (the hole shows the plate) */
const BAG: Array<Px> = [
	[2, 0, 3, 1],
	[1, 1, 1, 1],
	[5, 1, 1, 1],
	[0, 2, 7, 2],
	[0, 4, 3, 1],
	[4, 4, 3, 1],
	[0, 5, 7, 2],
];
/** three bars: the menu everybody knows, never the "II" of pause (UI-06: no menu pauses the world) */
const MENU: Array<Px> = [
	[0, 0, 7, 1],
	[0, 3, 7, 1],
	[0, 6, 7, 1],
];

/** draws `rects` (a 7 x 7 grid) in `color`, filling `host`; returns the icon's frame (shown / hidden as one) */
function pixelIcon(host: GuiObject, name: string, rects: Array<Px>, color: Color3, zIndex: number): Frame {
	const icon = new Instance("Frame");
	icon.Name = name;
	icon.BackgroundTransparency = 1;
	icon.BackgroundColor3 = THEME.background;
	icon.BorderSizePixel = 0;
	icon.Size = UDim2.fromScale(1, 1);
	icon.ZIndex = zIndex;
	for (let i = 0; i < rects.size(); i++) {
		const [x, y, w, h] = rects[i];
		const f = new Instance("Frame");
		f.Name = `Px${i}`;
		f.BorderSizePixel = 0;
		f.BackgroundColor3 = color;
		f.Position = UDim2.fromScale(x / 7, y / 7);
		f.Size = UDim2.fromScale(w / 7, h / 7);
		f.ZIndex = zIndex;
		f.Parent = icon;
	}
	icon.Parent = host;
	return icon;
}

// ---------------------------------------------------------------- key legends (tutorial.ts SCHEMES)

/** the key of `scheme` that does `what` ("" when the device has none): the real bindings of client/bootstrap.ts */
function keyFor(scheme: number, what: string): string {
	const s = SCHEMES[scheme];
	if (s === undefined) return "";
	for (const [chip, does] of s.rows) if (does === what) return chip;
	return "";
}

/**
 * The legend of hotbar tile `k` on `scheme`: the keyboard's "1 – 5" row gives each tile its digit; a scheme whose
 * "Switch weapon" row is not a digit (touch: "Tap a weapon") or that has no such row (the pad) shows no key.
 */
export function slotLegend(scheme: number, k: number): string {
	const chip = keyFor(scheme, "Switch weapon");
	return chip.match("^%d")[0] !== undefined ? `${k + 1}` : "";
}

// ---------------------------------------------------------------- touch placement

/** [left, top, right, bottom], screen pixels */
export type PxRect = [number, number, number, number];

/**
 * What the thumbs own on `L`, which the console may never cover: the move stick (its base at rest, or the whole
 * zone that grabs it when it does not float), the aim / fire pad, RELOAD and USE (USE is hidden until there is
 * something to use, and then it must not be under the console either).
 */
export function thumbRects(L: TouchLayout): Array<PxRect> {
	const out: Array<PxRect> = [];
	const circle = (x: number, y: number, r: number): void => {
		out.push([x - r, y - r, x + r, y + r]);
	};
	circle(L.move.homeX, L.move.homeY, L.floating ? L.move.baseR : math.max(L.move.baseR, L.move.grabR));
	circle(L.aim.homeX, L.aim.homeY, L.aim.baseR);
	circle(L.reload.x, L.reload.y, math.max(L.reload.r, MIN_TOUCH_PX / 2));
	circle(L.use.x, L.use.y, math.max(L.use.r, MIN_TOUCH_PX / 2));
	return out;
}

export interface ConsolePlacement {
	/** top-left corner and size, screen pixels */
	x: number;
	y: number;
	w: number;
	h: number;
	/** screen pixels per design unit of the console */
	scale: number;
}

/** touch units (px on a 414-pt phone, input.ts): a tile's side, the console's clearance and bottom margin */
const TOUCH_TILE = 36;
const TOUCH_GAP = 8;
const TOUCH_EDGE = 10;

/**
 * Where the compact console goes on a touch screen, from the touch layout's own numbers (shared/engine/input.ts,
 * the geometry bootstrap.ts hit-tests with):
 *  1. its size: a tile is TOUCH_TILE touch units wide (x the UI size setting), never under MIN_TOUCH_PX;
 *  2. its place: at the bottom, centred, in the band left free between the thumbs' rectangles (thumbRects) with
 *     TOUCH_GAP of clearance -- shifted towards the wider side if the thumbs are not symmetric (left-handed,
 *     different sizes), and shrunk to the band if it is narrower, as long as a tile stays MIN_TOUCH_PX wide;
 *  3. and when even that does not fit (a portrait phone: the two thumbs meet in the middle), above the thumbs.
 */
export function placeTouchConsole(L: TouchLayout, layout: Layout, k: number): ConsolePlacement {
	const unit = math.max(L.scale, 0.5);
	const gap = TOUCH_GAP * unit;
	const edge = TOUCH_EDGE * unit;
	const bottom = L.viewH - edge;
	const cx = L.viewW / 2;
	const minScale = MIN_TOUCH_PX / layout.tile;
	const wanted = math.max(MIN_TOUCH_PX, TOUCH_TILE * unit * k) / layout.tile;
	const rects = thumbRects(L);
	let scale = wanted;
	for (let pass = 0; pass < 3; pass++) {
		const w = layout.w * scale;
		const h = layout.h * scale;
		const top = bottom - h;
		let left = edge;
		let right = L.viewW - edge;
		for (const [x0, y0, x1, y1] of rects) {
			if (y1 + gap <= top || y0 - gap >= bottom) continue;
			if ((x0 + x1) / 2 < cx) left = math.max(left, x1 + gap);
			else right = math.min(right, x0 - gap);
		}
		const room = right - left;
		// (a hair of slack: after `scale = room / layout.w`, the product can land a rounding error above `room`)
		if (w <= room + 0.001) {
			return { x: math.clamp(cx - w / 2, left, math.max(left, right - w)), y: top, w, h, scale };
		}
		const fit = room / layout.w;
		if (fit < minScale) break;
		scale = fit;
	}
	// no room between the thumbs: over them, full width if need be
	let ceiling = bottom;
	for (const [, y0] of rects) ceiling = math.min(ceiling, y0 - gap);
	scale = math.min(wanted, (L.viewW - edge * 2) / layout.w);
	const w = layout.w * scale;
	const h = layout.h * scale;
	return { x: cx - w / 2, y: math.max(L.inset + edge, ceiling - h), w, h, scale };
}

// ---------------------------------------------------------------- bars

interface ConsoleBar {
	fill: Frame;
	label: TextLabel;
	ratio: number;
	/** the fill's face and relief as last painted */
	face: Color3;
	state: PlateState;
	shown: boolean;
	/** the narrowest fill that still has its notched shape (px): a sliver of HP never vanishes */
	minPx: number;
	/** the numbers the label shows now (it is only rebuilt when one changes) */
	a: number;
	b: number;
	c: number;
}

function sizeFill(bar: ConsoleBar): void {
	const r = bar.ratio;
	// from `minPx` at 0+ to the full width at 1: UDim2 cannot take a max(), so the offset fades out as it fills
	bar.fill.Size = new UDim2(r, (1 - r) * bar.minPx, 1, 0);
}

// ---------------------------------------------------------------- hotbar tiles

interface HotbarTile {
	button: TextButton;
	glyph: Glyph;
	key: Frame;
	keyLabel: TextLabel;
	ammo: Frame;
	ammoLabel: TextLabel;
	/** the reload rising in the tile in hand, inside `reloadBox` (the tile's face, one relief unit in) */
	reloadBox: Frame;
	reload: Frame;
	/** the weapon it shows, -1 = no weapon for this key (an empty socket) */
	id: number;
	inHand: boolean;
	reloading: boolean;
	reloadRatio: number;
	legend: string;
	/** the ammo it shows: the magazine (-1 = reserve only), the reserve, drawn red (empty) or not */
	mag: number;
	res: number;
	red: boolean;
	gun: boolean;
}

/** paints tile `t` from its state and the pointer over it (hover rises, press sinks) */
function paintTile(t: HotbarTile): void {
	const b = t.button;
	if (t.id < 0) {
		// an empty socket: a dark hole ringed in `line`, sunk in the groove
		paintPlate(b, SURFACE.well, "outline", SOCKET_UNIT, SURFACE.line);
		return;
	}
	const gs = b.GuiState;
	const pressed = gs === Enum.GuiState.Press;
	const hot = pressed || gs === Enum.GuiState.Hover;
	if (t.inHand && t.reloading) {
		// reloading: the tile drains to the dark bed and fills back in blue from the bottom (the `reload` frame)
		paintPlate(b, SURFACE.well, "flat", TILE_UNIT);
	} else if (t.inHand) {
		paintPlate(b, THEME.tabActive, pressed ? "press" : hot ? "hot" : "idle", TILE_UNIT);
	} else {
		paintPlate(b, SURFACE.section, pressed ? "press" : hot ? "hot" : "flat", TILE_UNIT);
	}
}

// ---------------------------------------------------------------- the console

export interface ConsoleCallbacks {
	/** tile k clicked / tapped: the caller writes InputState.weaponSlotPressed = k, like key k */
	onSlot: (k: number) => void;
	onBag: () => void;
	onMenu: () => void;
}

/** a label whose design text size is re-applied when the touch console is scaled (placeTouch) */
type ScaledText = [TextLabel, number];

export class HudConsole {
	readonly frame: Frame;
	readonly layout: Layout;
	private readonly tr: (key: string) => string;
	private readonly tags: [string, string, string];
	private readonly texts: Array<ScaledText> = [];
	private readonly bars: Array<ConsoleBar> = [];
	private readonly tiles: Array<HotbarTile> = [];
	/** the key order of this frame (weaponKeyOrder fills it: no allocation per frame) */
	private readonly order: Array<number> = [];
	private readonly legends: Array<TextLabel> = [];
	private readonly legendKeys: Array<string> = [];
	private scheme = -1;
	private textMult = 1;
	// the weapon column (desktop)
	private nameLabel: TextLabel | undefined;
	private typeLabel: TextLabel | undefined;
	private readout: Frame | undefined;
	private readoutLabel: TextLabel | undefined;
	/** the weapon column's section height (design units) */
	private sideH = 0;
	private sideId = -2;
	private readMag = -1;
	private readSize = -1;
	private readPool = -1;
	private readReloading = false;

	constructor(root: Frame, tr: (key: string) => string, compact: boolean, k: number, cb: ConsoleCallbacks) {
		const L = compact ? COMPACT_LAYOUT : DESKTOP_LAYOUT;
		this.layout = L;
		this.tr = tr;
		this.tags = [tr("HP"), tr("FOOD"), tr("LV")];

		const frame = new Instance("Frame");
		frame.Name = "Console";
		frame.BackgroundTransparency = 1;
		frame.BackgroundColor3 = THEME.background;
		frame.BorderSizePixel = 0;
		// above the damage vignette, under the touch layer (ZIndex 8): the thumbs' controls are never covered
		frame.ZIndex = 2;
		W.setDesign(frame, L.w, L.h);
		if (compact) {
			// placed in screen pixels by placeTouch(), from the touch layout
			frame.Size = UDim2.fromOffset(L.w, L.h);
		} else {
			// bottom centre, the "UI size" setting scaling it like the rest of the HUD (makeAnchored's recipe)
			frame.AnchorPoint = new Vector2(0.5, 1);
			frame.Size = UDim2.fromScale((L.w * k) / W.DESIGN_W, (L.h * k) / W.DESIGN_H);
			frame.Position = new UDim2(0.5, 0, 1 - CONSOLE_MARGIN / W.DESIGN_H, 0);
			frame.SetAttribute("TextScale", k);
			W.addAspect(frame, L.w / L.h);
		}
		frame.Parent = root;
		this.frame = frame;

		// the UI-07 window without its title band: the thick frame and the graphite body; on it, the section plates
		// (lighter iron), and in those the dark grooves -- a groove straight on the body would be 1,1:1 against it
		// and the empty part of a bar would vanish
		const body = W.Card(frame, "Body", { x: 0, y: 0, w: L.w, h: L.h, fill: SURFACE.window, pad: L.pad });
		const z = body.ZIndex + 1;
		const inner = L.h - L.pad * 2;

		// ---- left: the three bars
		const vitalsW = L.inset * 2 + L.barW;
		const vitals = Section(body, "Vitals", { x: L.pad, y: L.pad, w: vitalsW, h: inner, zIndex: z }).frame;
		const barY = (i: number): number => L.inset + (inner - L.inset * 2 - barsH(L)) / 2 + i * (L.barH + L.barGap);
		const faces = [BAR.hp, BAR.food, BAR.xp];
		const names = ["Hp", "Food", "Xp"];
		for (let i = 0; i < 3; i++) {
			this.bars.push(this.makeBar(vitals, names[i], L.inset, barY(i), faces[i], vitals.ZIndex + 1));
		}

		// ---- middle: the hotbar on its groove bed, in its section
		const hotbarX = L.pad + vitalsW + L.colGap;
		const hotbarW = L.inset * 2 + bedW(L.tile);
		const hotbarH = L.inset * 2 + L.tile + BED_PAD * 2;
		const hotbar = Section(body, "Weapons", { x: hotbarX, y: L.pad, w: hotbarW, h: hotbarH, zIndex: z }).frame;
		const bed = Groove(hotbar, "Hotbar", L.inset, L.inset, bedW(L.tile), L.tile + BED_PAD * 2);
		bed.ZIndex = hotbar.ZIndex + 1;
		for (let k2 = 0; k2 < WEAPON_KEY_COUNT; k2++) {
			const slot = k2;
			const x = BED_PAD + slot * (L.tile + TILE_GAP);
			this.tiles.push(this.makeTile(bed, slot, x, BED_PAD, L.tile, bed.ZIndex + 1, () => cb.onSlot(slot)));
		}

		if (!L.full) return;

		// ---- under the hotbar's section, on the body: the Bag and Menu plates, centred under it
		const rowY = L.pad + hotbarH + ICON_ROW_GAP;
		const rowX = hotbarX + (hotbarW - (ICON_W * 2 + ICON_GAP)) / 2;
		this.makeIconPlate(body, "Bag", rowX, rowY, BAG, "Backpack", z, cb.onBag);
		this.makeIconPlate(body, "Menu", rowX + ICON_W + ICON_GAP, rowY, MENU, "Menu", z, cb.onMenu);

		// ---- right: the weapon in hand (name, type, magazine), in its section. Light text only on the iron: the
		// muted grey reads on the dark beds, not on a section plate (UI-05), so the type is light and smaller
		const sideX = hotbarX + hotbarW + L.colGap;
		const sideW = L.inset * 2 + SIDE_W;
		const side = Section(body, "Hand", { x: sideX, y: L.pad, w: sideW, h: inner, zIndex: z }).frame;
		const sz = side.ZIndex + 1;
		this.sideH = inner;
		this.nameLabel = this.text(side, "WeaponName", "", L.inset, L.inset, SIDE_W, 20, TEXT.base, THEME.foreground, {
			font: BOLD,
			align: "left",
			zIndex: sz,
		});
		this.typeLabel = this.text(
			side,
			"WeaponType",
			"",
			L.inset,
			L.inset + 20,
			SIDE_W,
			16,
			TEXT.xs,
			THEME.foreground,
			{
				weight: Enum.FontWeight.Medium,
				align: "left",
				zIndex: sz,
			},
		);
		// the magazine on a dark readout bed: the yellow of numbers and the red of an empty magazine both read there
		const readout = Groove(side, "Readout", L.inset, inner - L.inset - READOUT_H, SIDE_W, READOUT_H);
		readout.ZIndex = sz;
		this.readout = readout;
		this.readoutLabel = this.text(
			readout,
			"Magazine",
			"",
			6,
			0,
			SIDE_W - 12,
			READOUT_H,
			TEXT.xl,
			THEME.mutedForeground,
			{
				font: NUMERIC,
				rich: true,
				zIndex: sz + 1,
			},
		);
	}

	/** makeLabel, remembered so the touch console can rescale its text with it */
	private text(
		parent: Instance,
		name: string,
		value: string,
		x: number,
		y: number,
		w: number,
		h: number,
		size: number,
		color: Color3,
		opts: W.LabelOpts,
	): TextLabel {
		const label = W.makeLabel(parent, name, value, x, y, w, h, size, color, opts);
		this.texts.push([label, size]);
		return label;
	}

	/** one bar: the dark groove, the fill plate in relief inside it, the light label centred over both */
	private makeBar(parent: Frame, name: string, x: number, y: number, face: Color3, z: number): ConsoleBar {
		const L = this.layout;
		const groove = Groove(parent, `${name}Bar`, x, y, L.barW, L.barH);
		groove.ZIndex = z;
		const inner = new Instance("Frame");
		inner.Name = "Inner";
		inner.BackgroundTransparency = 1;
		inner.BackgroundColor3 = THEME.background;
		inner.BorderSizePixel = 0;
		inner.ZIndex = z + 1;
		inner.Parent = groove;
		const fill = new Instance("Frame");
		fill.Name = "Fill";
		fill.BackgroundTransparency = 1;
		fill.BackgroundColor3 = THEME.background;
		fill.BorderSizePixel = 0;
		fill.ZIndex = z + 1;
		fill.Parent = inner;
		paintPlate(fill, face, "idle", FILL_UNIT);
		const label = this.text(groove, "Value", "", 0, 0, L.barW, L.barH, TEXT.sm, THEME.foreground, {
			font: BOLD,
			zIndex: z + 3,
		});
		const bar: ConsoleBar = {
			fill,
			label,
			ratio: 1,
			face,
			state: "idle",
			shown: true,
			minPx: 0,
			a: -1,
			b: -1,
			c: -1,
		};
		W.onLayoutChange(inner, () => {
			const u = reliefPx(GROOVE_UNIT);
			inner.Position = new UDim2(0, u, 0, u);
			inner.Size = new UDim2(1, -2 * u, 1, -2 * u);
			bar.minPx = 2 * reliefPx(FILL_UNIT) + 1;
			sizeFill(bar);
		});
		return bar;
	}

	/** one hotbar tile (GridTile-style): the plate, the item glyph, the key badge, the ammo chip, the reload fill */
	private makeTile(
		bed: Frame,
		k: number,
		x: number,
		y: number,
		size: number,
		z: number,
		onClick: () => void,
	): HotbarTile {
		const [dw, dh] = W.designOf(bed);
		const b = new Instance("TextButton");
		b.Name = `Slot${k + 1}`;
		b.Position = UDim2.fromScale(x / dw, y / dh);
		b.Size = UDim2.fromScale(size / dw, size / dh);
		W.setDesign(b, size, size);
		b.AutoButtonColor = false;
		b.BorderSizePixel = 0;
		b.BackgroundTransparency = 1;
		b.BackgroundColor3 = THEME.background;
		b.Text = "";
		b.TextColor3 = THEME.foreground;
		b.ZIndex = z;
		// in a run the pad's buttons are the survivor's (bootstrap.ts: a selected control takes the pad): the pad
		// has no weapon key, and its navigation must never land on the HUD mid-fight
		b.Selectable = false;

		// the reload, under everything the tile shows: its face, one tile relief unit in, filling from the bottom
		const reloadBox = new Instance("Frame");
		reloadBox.Name = "ReloadBox";
		reloadBox.BackgroundTransparency = 1;
		reloadBox.BackgroundColor3 = THEME.background;
		reloadBox.BorderSizePixel = 0;
		reloadBox.ZIndex = -4;
		reloadBox.Parent = b;
		W.onLayoutChange(reloadBox, () => {
			const u = reliefPx(TILE_UNIT);
			reloadBox.Position = new UDim2(0, u, 0, u);
			reloadBox.Size = new UDim2(1, -2 * u, 1, -2 * u);
		});
		const reload = new Instance("Frame");
		reload.Name = "Reload";
		reload.BorderSizePixel = 0;
		reload.BackgroundColor3 = THEME.tabActive;
		reload.AnchorPoint = new Vector2(0, 1);
		reload.Position = UDim2.fromScale(0, 1);
		reload.Size = UDim2.fromScale(1, 0);
		reload.Visible = false;
		reload.ZIndex = -4;
		reload.Parent = reloadBox;

		// the item's glyph, as in the Bag and the item card (its initial in a well, outlined in the weapon tone)
		const g = math.round(size * 0.5);
		const glyph = makeGlyph(b, (size - g) / 2, size * 0.1, g, z + 1);
		glyph.frame.Visible = false;
		this.texts.push([glyph.letter, g / 2]);

		// the key that picks it: the kit's key look (a raised dark-iron plate, light legend), on the corner
		const keyS = math.round(size * 0.34);
		const key = W.makeFrame(b, "Key", 3, 3, keyS, keyS, THEME.background, { transparency: 1, zIndex: z + 3 });
		paintPlate(key, SURFACE.key, "idle", 2);
		const keyLabel = this.text(key, "Legend", "", 0, 0, keyS, keyS, TEXT.xs, THEME.foreground, {
			font: BOLD,
			zIndex: z + 4,
		});
		key.Visible = false;

		// the ammo: a dark chip along the bottom, the number in the item card's yellow
		const chipH = math.round(size * 0.28);
		const ammo = W.makeFrame(b, "Ammo", 4, size - chipH - 4, size - 8, chipH, THEME.background, {
			transparency: 1,
			zIndex: z + 3,
		});
		paintPlate(ammo, SURFACE.well, "flat", 1);
		const ammoLabel = this.text(ammo, "Count", "", 2, 0, size - 12, chipH, TEXT.xs, STAT.value, {
			font: NUMERIC,
			zIndex: z + 4,
		});
		ammo.Visible = false;

		const t: HotbarTile = {
			button: b,
			glyph,
			key,
			keyLabel,
			ammo,
			ammoLabel,
			reloadBox,
			reload,
			id: -1,
			inHand: false,
			reloading: false,
			reloadRatio: -1,
			legend: "",
			mag: -2,
			res: -2,
			red: false,
			gun: false,
		};
		b.GetPropertyChangedSignal("GuiState").Connect(() => paintTile(t));
		b.Activated.Connect(onClick);
		paintTile(t);
		b.Parent = bed;
		return t;
	}

	/** a small iron plate under the hotbar: a pixel icon and the key of this device ("B", "LB") */
	private makeIconPlate(
		parent: Frame,
		name: string,
		x: number,
		y: number,
		icon: Array<Px>,
		action: string,
		z: number,
		onClick: () => void,
	): void {
		const b = W.Button(parent, name, "", {
			x,
			y,
			w: ICON_W,
			h: ICON_H,
			size: "sm",
			variant: "secondary",
			zIndex: z,
			onClick,
		});
		b.Selectable = false;
		const iconS = 12;
		const host = W.makeFrame(b, "Icon", 10, (ICON_H - iconS) / 2, iconS, iconS, THEME.background, {
			transparency: 1,
			zIndex: b.ZIndex + 1,
		});
		pixelIcon(host, "Pixels", icon, THEME.secondaryForeground, b.ZIndex + 1);
		const legend = this.text(b, "Key", "", 28, 0, ICON_W - 34, ICON_H, TEXT.xs, THEME.secondaryForeground, {
			font: BOLD,
			align: "left",
			zIndex: b.ZIndex + 1,
		});
		this.legends.push(legend);
		this.legendKeys.push(action);
	}

	/**
	 * Touch: sizes and places the console from the touch layout (placeTouchConsole) and scales its text with it.
	 * Called on mount and whenever the touch geometry changes -- never per frame. Writes, never creates.
	 */
	placeTouch(L: TouchLayout, k: number): ConsolePlacement {
		const p = placeTouchConsole(L, this.layout, k);
		// whole pixels; the size rounds UP so a tile never lands a fraction under MIN_TOUCH_PX (the clearance round
		// the console, TOUCH_GAP touch units, is what absorbs that fraction)
		this.frame.Position = UDim2.fromOffset(math.round(p.x), math.round(p.y));
		this.frame.Size = UDim2.fromOffset(math.ceil(p.w), math.ceil(p.h));
		// the kit caps text at design size x the UI scale; this console is drawn at p.scale instead
		const mult = math.clamp(p.scale / math.max(W.uiScale(), 0.05), 0.5, 4);
		if (math.abs(mult - this.textMult) > 0.001) {
			this.textMult = mult;
			for (const [label, size] of this.texts) W.scaleText(label, size * mult);
		}
		return p;
	}

	/**
	 * Every frame: bars, tiles, the weapon column, the key legends -- writing only what changed. `save` is the run's
	 * (its inventory decides the hotbar, as it decides what keys 1-5 pick).
	 */
	update(state: HudState, save: PlayerSaveData, now: number): void {
		const wave = math.sin(now * BLINK_RATE);
		const [hpBar, foodBar, xpBar] = this.bars;

		// HP: the fill blinks out when low, and lights up on a hit (the vignette is the other half of the cue)
		const hpRatio = state.hpMax > 0 ? state.hp / state.hpMax : 0;
		const hpNow = math.max(0, math.ceil(state.hp));
		if (hpNow !== hpBar.a || state.hpMax !== hpBar.b) {
			hpBar.a = hpNow;
			hpBar.b = state.hpMax;
			hpBar.label.Text = `${this.tags[0]} ${hpNow} / ${state.hpMax}`;
		}
		this.setBar(hpBar, hpRatio, BAR.hp, state.hitFlash > HIT_HOT ? "hot" : "idle", !(hpRatio < LOW_HP && wave > 0));

		// food: low hunger blinks the fill red, the colour of what it is doing to you (both pass under the label)
		const foodRatio = state.hungerMax > 0 ? state.hunger / state.hungerMax : 0;
		const foodNow = math.clamp(math.floor(state.hunger + 0.5), 0, math.max(state.hungerMax, 0));
		if (foodNow !== foodBar.a || state.hungerMax !== foodBar.b) {
			foodBar.a = foodNow;
			foodBar.b = state.hungerMax;
			foodBar.label.Text = `${this.tags[1]} ${foodNow} / ${state.hungerMax}`;
		}
		this.setBar(foodBar, foodRatio, foodRatio < LOW_FOOD && wave > 0 ? BAR.hp : BAR.food, "idle", true);

		// XP, with the level written in it
		const exp = math.max(0, math.floor(state.exp));
		if (state.level !== xpBar.a || exp !== xpBar.b || state.expMax !== xpBar.c) {
			xpBar.a = state.level;
			xpBar.b = exp;
			xpBar.c = state.expMax;
			xpBar.label.Text = `${this.tags[2]} ${state.level} · ${W.fmtInt(exp)} / ${W.fmtInt(state.expMax)}`;
		}
		this.setBar(xpBar, state.expMax > 0 ? state.exp / state.expMax : 0, BAR.xp, "idle", true);

		// the device's keys (keyboard 1-5 / B / P, the pad's LB / Start): only rewritten when the device changes
		const scheme = currentScheme();
		const schemeChanged = scheme !== this.scheme;
		if (schemeChanged) {
			this.scheme = scheme;
			for (let i = 0; i < this.legends.size(); i++) {
				this.legends[i].Text = keyFor(scheme, this.legendKeys[i]);
			}
		}

		// the hotbar: the first five of the list keys 1-5 pick from
		const order = weaponKeyOrder(save, state.weaponId, this.order);
		for (let k = 0; k < this.tiles.size(); k++) {
			this.updateTile(this.tiles[k], k, order[k] ?? -1, state, save, schemeChanged);
		}
		if (this.layout.full) this.updateSide(state);
	}

	private setBar(bar: ConsoleBar, ratio: number, face: Color3, plate: PlateState, on: boolean): void {
		const r = math.clamp(ratio === ratio ? ratio : 0, 0, 1);
		if (r !== bar.ratio) {
			bar.ratio = r;
			sizeFill(bar);
		}
		const shown = on && r > 0;
		if (shown !== bar.shown) {
			bar.shown = shown;
			bar.fill.Visible = shown;
		}
		if (face !== bar.face || plate !== bar.state) {
			bar.face = face;
			bar.state = plate;
			paintPlate(bar.fill, face, plate, FILL_UNIT);
		}
	}

	private updateTile(
		t: HotbarTile,
		k: number,
		id: number,
		state: HudState,
		save: PlayerSaveData,
		schemeChanged: boolean,
	): void {
		const w = id >= 0 ? WEAPONS[id] : undefined;
		const repaint = id !== t.id;
		if (repaint) {
			// a weapon picked up, lost or reordered: the SAME tile shows the new one (nothing is created)
			t.id = w !== undefined ? id : -1;
			t.gun = w !== undefined && w.mag > 0;
			if (w !== undefined) {
				setGlyph(t.glyph, this.tr(w.name), kindTone(ItemKind.Weapon), false);
				const size = this.layout.tile;
				const g = math.round(size * 0.5);
				// a melee weapon has no ammo chip: its glyph sits in the middle of the tile
				t.glyph.frame.Position = UDim2.fromScale((size - g) / 2 / size, t.gun ? 0.1 : (size - g) / 2 / size);
			}
			t.glyph.frame.Visible = w !== undefined;
			t.mag = -2;
		}
		if (repaint || schemeChanged) {
			const legend = t.id >= 0 ? slotLegend(this.scheme, k) : "";
			if (legend !== t.legend) {
				t.legend = legend;
				t.keyLabel.Text = legend;
			}
			const showKey = legend !== "";
			if (t.key.Visible !== showKey) t.key.Visible = showKey;
		}

		const inHand = t.id >= 0 && t.id === state.weaponId;
		const reloading = inHand && state.reloading && state.magSize > 0;
		if (repaint || inHand !== t.inHand || reloading !== t.reloading) {
			t.inHand = inHand;
			t.reloading = reloading;
			paintTile(t);
			if (t.reload.Visible !== reloading) t.reload.Visible = reloading;
		}
		if (reloading && state.reloadRatio !== t.reloadRatio) {
			t.reloadRatio = state.reloadRatio;
			t.reload.Size = UDim2.fromScale(1, math.clamp(state.reloadRatio, 0, 1));
		}

		// the ammo chip: magazine / reserve on the gun in hand, the reserve on the others; red when it is empty
		if (t.ammo.Visible !== t.gun) t.ammo.Visible = t.gun;
		if (!t.gun || w === undefined) return;
		const mag = inHand ? state.mag : -1;
		const res = inHand ? state.ammoPool : weaponReserve(save, w);
		if (mag !== t.mag || res !== t.res) {
			t.mag = mag;
			t.res = res;
			t.ammoLabel.Text = inHand ? `${mag}/${W.fmtInt(res)}` : W.fmtInt(res);
		}
		const red = inHand ? mag <= 0 && !state.reloading : res <= 0;
		if (red !== t.red || repaint) {
			t.red = red;
			t.ammoLabel.TextColor3 = red ? STAT.penalty : STAT.value;
		}
	}

	/** the weapon column: what the old weapon card said (name, type, magazine / reserve, reloading) */
	private updateSide(state: HudState): void {
		const name = this.nameLabel;
		const kind = this.typeLabel;
		const readout = this.readout;
		const label = this.readoutLabel;
		if (name === undefined || kind === undefined || readout === undefined || label === undefined) return;
		const w = WEAPONS[state.weaponId] ?? WEAPONS[0];
		const gun = state.magSize > 0;
		if (state.weaponId !== this.sideId) {
			this.sideId = state.weaponId;
			name.Text = state.weaponName;
			kind.Text = this.tr(weaponKindName(w.kind));
			// a melee weapon has no magazine: its name and type take the column's middle instead of a readout
			const h = this.sideH;
			const top = gun ? this.layout.inset : (h - 36) / 2;
			name.Position = UDim2.fromScale(name.Position.X.Scale, top / h);
			kind.Position = UDim2.fromScale(kind.Position.X.Scale, (top + 20) / h);
			readout.Visible = gun;
			this.readMag = -1;
			this.readSize = -1;
		}
		if (!gun) return;
		if (
			state.mag === this.readMag &&
			state.magSize === this.readSize &&
			state.ammoPool === this.readPool &&
			state.reloading === this.readReloading
		) {
			return;
		}
		this.readMag = state.mag;
		this.readSize = state.magSize;
		this.readPool = state.ammoPool;
		this.readReloading = state.reloading;
		if (state.reloading) {
			label.Text = `${this.tr("Reloading")}...`;
			return;
		}
		// the magazine in the numbers' yellow (the empty one in red), the reserve after it in the muted voice
		const magColor = state.mag <= 0 ? STAT.penalty : STAT.value;
		label.Text = `<font color="${hex(magColor)}">${state.mag}</font> / ${W.fmtInt(state.ammoPool)}`;
	}
}

// ---------------------------------------------------------------- the day plate

const DAY_W = 300;
const DAY_H = 44;
const DAY_ICON = 21;
const DAY_TEXT_X = 44;
const DAY_TEXT_W = 100;
const DAY_RIGHT_X = 160;
const DAY_RIGHT_W = DAY_W - DAY_RIGHT_X - 12;

/** morning / afternoon / evening / night of an in-game hour */
function phaseKey(t: number): string {
	if (t >= 19 || t < 6) return "Night";
	if (t < 11) return "Morning";
	if (t < 16) return "Afternoon";
	return "Evening";
}

/**
 * The day plate, top centre: a small UI-07 window body with the sun (or the moon at night) in pixels, the WORLD's
 * "Day N" in ExtraBold, and at its right the phase; under the phase, HH:MM when a watch is equipped and this life's
 * day when it has parted from the world's (MP-13 / MP-20: while they agree, the second number explains nothing).
 */
export class HudDay {
	readonly frame: Frame;
	private readonly tr: (key: string) => string;
	private readonly dayLabel: TextLabel;
	private readonly phaseLabel: TextLabel;
	private readonly clockLabel: TextLabel;
	private readonly lifeLabel: TextLabel;
	private readonly sun: Frame;
	private readonly moon: Frame;
	private day = -1;
	private life = -1;
	private phase = "";
	private minute = -1;
	private night: boolean | undefined;
	private twoLines: boolean | undefined;

	constructor(root: Frame, tr: (key: string) => string, k: number) {
		this.tr = tr;
		const box = W.makeAnchored(root, "DayPlate", 0.5, 0, DAY_W, DAY_H, 0, 10, true, k);
		box.ZIndex = 2;
		this.frame = box;
		const body = W.Card(box, "Body", { x: 0, y: 0, w: DAY_W, h: DAY_H, fill: SURFACE.window, pad: 12 });
		const z = body.ZIndex + 1;
		const icon = W.makeFrame(body, "SunMoon", 14, (DAY_H - DAY_ICON) / 2, DAY_ICON, DAY_ICON, THEME.background, {
			transparency: 1,
			zIndex: z,
		});
		this.sun = pixelIcon(icon, "Sun", SUN, GAME.sun, z);
		this.moon = pixelIcon(icon, "Moon", MOON, GAME.moon, z);
		this.moon.Visible = false;
		this.dayLabel = W.makeLabel(body, "Day", "", DAY_TEXT_X, 0, DAY_TEXT_W, DAY_H, TEXT.xl2, THEME.foreground, {
			font: EXTRA_BOLD,
			align: "left",
			zIndex: z,
		});
		W.Separator(body, "Divider", {
			x: DAY_RIGHT_X - 10,
			y: 10,
			length: DAY_H - 20,
			vertical: true,
			color: SURFACE.line,
			zIndex: z,
		});
		this.phaseLabel = W.makeLabel(body, "Phase", "", DAY_RIGHT_X, 13, DAY_RIGHT_W, 18, TEXT.sm, THEME.foreground, {
			font: "label",
			align: "left",
			zIndex: z,
		});
		this.clockLabel = W.makeLabel(body, "Clock", "", DAY_RIGHT_X, 24, 48, 15, TEXT.xs, THEME.mutedForeground, {
			mono: true,
			weight: Enum.FontWeight.Regular,
			align: "left",
			zIndex: z,
		});
		this.lifeLabel = W.makeLabel(
			body,
			"Life",
			"",
			DAY_RIGHT_X + 48,
			24,
			DAY_RIGHT_W - 48,
			15,
			TEXT.xs,
			THEME.mutedForeground,
			{
				font: "caption",
				align: "right",
				zIndex: z,
			},
		);
	}

	update(state: HudState): void {
		if (state.day !== this.day) {
			this.day = state.day;
			this.dayLabel.Text = `${this.tr("Day")} ${state.day}`;
		}
		// MP-13 + MP-20: this life's day only once "New game" (or joining an old town) has parted it from the world's
		const life = state.lifeDay !== state.day ? state.lifeDay : -1;
		if (life !== this.life) {
			this.life = life;
			this.lifeLabel.Text = life >= 0 ? `${this.tr("Life day")} ${life}` : "";
		}
		const phase = phaseKey(state.dayTime);
		if (phase !== this.phase) {
			this.phase = phase;
			this.phaseLabel.Text = this.tr(phase);
		}
		const minute = state.showClock ? math.floor(state.dayTime * 60) % (24 * 60) : -1;
		if (minute !== this.minute) {
			this.minute = minute;
			this.clockLabel.Text = minute >= 0 ? string.format("%02d:%02d", math.floor(minute / 60), minute % 60) : "";
		}
		// the phase takes the middle of the plate when nothing goes under it
		const twoLines = minute >= 0 || life >= 0;
		if (twoLines !== this.twoLines) {
			this.twoLines = twoLines;
			this.phaseLabel.Position = UDim2.fromScale(DAY_RIGHT_X / DAY_W, (twoLines ? 5 : 13) / DAY_H);
		}
		if (state.isNight !== this.night) {
			this.night = state.isNight;
			this.sun.Visible = !state.isNight;
			this.moon.Visible = state.isNight;
		}
	}
}
