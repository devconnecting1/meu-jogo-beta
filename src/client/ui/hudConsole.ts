/*
 * The HUD console (docs/DESIGN_RULES.md UI-09): the in-run HUD in the vocabulary of the owner's "Settings" window
 * (UI-07). Layout idea from Pixel Quest's HUD -- one framed console at the bottom centre -- and nothing else from it:
 * every piece below is one of OUR kit's pieces and means something in OUR game.
 *
 *   desktop, 778 x 114 design units (x the UI size setting), 12 above the bottom edge
 *   #==========================================================================================================#
 *   # .------------. .-----------------------. .----------------------------------. .-------------------.    #
 *   # | .  . O .   | | [####HP 88 / 100####..] | |[1 ]  [2 ]  [3 ]  [   ]  [   ]   | | Pistol            |    #
 *   # |.         !.| | [##FOOD 58 / 100##....] | |[ D]  [ A]  [ P]  (   )  (   )   | | Pistol            |    #
 *   # |___________ | | [#LV 3 · 30 / 120.....] | |           [7/41]               | | [ 7 / 41        ] |    #
 *   # |   Day 5    | '-----------------------' '----------------------------------' '-------------------'    #
 *   # |Night in 2:10|                     [bag  B]  [menu  P]  [ppl 3  Q]                                   #
 *   #==========================================================================================================#
 *     the UI-07 frame and graphite body; four section plates (lighter iron) holding dark grooves:
 *     the sky (hudSky.ts: the day    vitals (three bars)   weapons (five tiles on a groove    the weapon in hand
 *     clock -- the sun's arc, the                          bed, and under it the Bag / Menu    (name, type, a
 *     world's day, the countdown)                          / Survivors plates)                 magazine readout)
 *
 *   touch (compact): the vitals and the weapons sections only, 512 x 88 design units, scaled so a tile is a thumb
 *   wide and placed in the free band between the move stick and the fire controls (placeTouchConsole). The sky and
 *   the survivors chip go where the touch controls put the Bag and the Menu: the top corner -- the chip in their row,
 *   left of Menu (placeTouchChip), the sky under the row (placeTouchSky) -- not into the thumbs' band.
 *
 * What each part is in the game:
 *  - the sky, at the left end: the world's clock read the way a survivor needs it -- the WORLD's day (MP-20), how long
 *    until nightfall and the horde, and at night how long until daybreak (hudSky.ts). It replaced the day plate that
 *    floated at the top centre, the last loose card of the HUD;
 *  - the three bars are the survivor's HP, food (hunger, 0..100) and XP towards the next level, with the level
 *    written in the XP bar ("LV 3 · 30 / 120"), like the reference. Each fill is a plate in relief (plate.ts) in
 *    its BAR token, darkened until the light label reads at 4,5:1 (UI-05); the label is never outlined (UI-04);
 *  - the five tiles are the first five weapons of `weaponKeyOrder` (shared/game/weaponSlots.ts), the very list
 *    keys 1-5 pick from (client/systems/combat.ts), in the same order. The weapon in hand is the raised BLUE tile
 *    ("what is chosen is blue", UI-07), another owned weapon is flat dark iron, a key with no weapon is an empty
 *    socket on the groove. Each tile shows the item's pixel icon (UI-11: the Bag's and the item card's), the key that
 *    picks it on this device (keyboard 1-5; the pad has no such key and touch taps the tile itself, so neither
 *    shows one) and, for a gun, its ammo in the item card's yellow: magazine / reserve on the gun in hand, the
 *    reserve alone on the others (a gun you are not holding keeps its rounds in the pool: combat.ts switchWeapon
 *    empties the magazine back into it). A reload refills the tile in hand from the bottom up. The icon sits in the
 *    MIDDLE of what the tile leaves it -- what it draws, not its 16 x 16 grid (itemIcon.ts fit "drawn") -- the face
 *    on a melee weapon's tile, the face above the ammo chip on a gun's; the key is a small cap in the very corner,
 *    and no pixel of any weapon's icon lands under it or on the chip; and the icon is drawn at a side the tile's
 *    pixels carry evenly (16 / 24 / 32 / 40 / 48... px: fitTileIcon), the same for every weapon;
 *  - a click or a tap on tile k writes `InputState.weaponSlotPressed = k`, the field key k writes
 *    (client/bootstrap.ts): combat has one way to switch weapons, not two;
 *  - the Bag and Menu plates are the in-run actions that have a button today, each a pixel icon and its key on this
 *    device (B / LB, P / Start), and after them the third: the match scoreboard's survivors chip (MP-23,
 *    scoreboard.ts builds it in `chipSlot`: the people icon, how many are in town and Q / Back). Nothing else is
 *    added: there is no quick-use bar in this game;
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
import { iconKeys, iconOf } from "shared/data/itemIcons";
import { IconView, drawItemIcon, drawnRects, maxFrameCount } from "./itemIcon";
import { weaponKindName } from "./itemInfo";
import { PlateState, paintPlate, reliefPx } from "./plate";
import { BAR, STAT, SURFACE, TEXT, THEME, fontOf, hex } from "./theme";
import { HudSky, Px, SKY_STACK_H, SKY_STACK_W, pixelIcon, skySection } from "./hudSky";
import { RegenCue } from "./hudRegen";
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
	/**
	 * Seconds since the body last lost hp (PlayerState.sinceHurt, DESIGN_RULES VIT-01): with hp and hunger, what the
	 * vitals' cue reads (hudRegen.ts: the HP bar glows while healing, a fork on FOOD when only food stops it).
	 * Undefined = not tracked: no glow.
	 */
	sinceHurt?: number;
}

const BOLD = fontOf("sans", Enum.FontWeight.Bold);
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
	/**
	 * the sky section, the weapon column and the Bag / Menu plates (desktop only: on touch the touch layer owns those
	 * buttons, and the sky rides under their row)
	 */
	full: boolean;
}

const TILE_GAP = 4;
/** the groove bed around the tiles */
const BED_PAD = 4;
/** the Bag / Menu plates (and the scoreboard's chip after them) under the hotbar's section */
const ICON_ROW_GAP = 6;
const ICON_H = 22;
const ICON_W = 76;
const ICON_GAP = 8;
/** Bag, Menu and the survivors chip */
const ROW_PLATES = 3;
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

/** the sky section and the gap after it (desktop only; 0 on touch) */
function skyW(L: Layout): number {
	return L.full ? L.inset * 2 + SKY_STACK_W + L.colGap : 0;
}

/**
 * the console's size from its parts: [sky] [vitals] [hotbar (+ the Bag / Menu row)] [weapon], each in its section
 */
function sized(L: Layout): Layout {
	const vitalsW = L.inset * 2 + L.barW;
	const hotbarW = L.inset * 2 + bedW(L.tile);
	const sideW = L.full ? L.colGap + L.inset * 2 + SIDE_W : 0;
	L.w = L.pad * 2 + skyW(L) + vitalsW + L.colGap + hotbarW + sideW;
	const hotbarH = L.inset * 2 + L.tile + BED_PAD * 2 + (L.full ? ICON_ROW_GAP + ICON_H : 0);
	const skyH = L.full ? L.inset * 2 + SKY_STACK_H : 0;
	L.h = L.pad * 2 + math.max(L.inset * 2 + barsH(L), hotbarH, skyH);
	return L;
}

/**
 * 10 + 132 + 8 + 200 + 8 + 266 + 8 + 136 + 10 = 778 wide, 10 + 94 + 10 = 114 tall: the sky 120 x 82 in its
 * section, bars 188 x 22 (3 x 22 + 2 x 8 = 82), tiles 46 (the bed 254 x 54), the Bag / Menu row 22 under the
 * hotbar's section. The sky made it 140 wider and not one unit taller: height is what the world can least spare on
 * a wide screen (the owner's 1365 x 567 shows 567 px of town).
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
/** the Frames of the costliest weapon icon: every tile holds that many from the start */
const WEAPON_ICON_FRAMES = maxFrameCount(iconKeys(ItemKind.Weapon));

/** HP below this blinks its fill out; food below this blinks red (the old HUD's thresholds) */
const LOW_HP = 0.25;
const LOW_FOOD = 0.15;
/** the HP fill lights up (the plate's "hot" light) while the hit flash is above this */
const HIT_HOT = 0.4;
/** the blink: sin(t x 8) -- 1,27 blinks a second, far under the 3 a second of WCAG 2.3.1 */
const BLINK_RATE = 8;

// ---------------------------------------------------------------- pixel icons (7 x 7 grids: hudSky.ts pixelIcon)

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
/** the touch sky plate: px per design unit = the touch unit x this (0,85 px on a 844 x 390 phone: as tall as Menu) */
const SKY_TOUCH_SCALE = 0.9;
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

function overlapsAny(r: PxRect, list: Array<PxRect>): boolean {
	for (const [x0, y0, x1, y1] of list) if (r[0] < x1 && x0 < r[2] && r[1] < y1 && y0 < r[3]) return true;
	return false;
}

/**
 * Where the touch sky plate goes (hudSky.ts skyPlate): with the touch controls' Menu and Bag -- the top corner, the one
 * part of a touch screen no thumb control reaches (input.ts keeps RELOAD and USE a whole button under it). Its first
 * free place, from the geometry bootstrap.ts hit-tests with and the console's own rect `deck`:
 *  1. right under the row of Menu and Bag, flush with its outer end (its home: the corner reads as one block -- the
 *     buttons, and the clock under them -- and it leaves the most of the top centre to the banners: hud.ts narrows a
 *     banner or a feed line that would reach it, `messageWidths`, never under their own minimum, `keepOut`);
 *  2. in the row, just left of Menu;
 *  3. at the other end of the row, when the console floats up there (a crowded phone: placeTouchConsole's last step);
 *  4. under the console, and 5. over it, when all of that is taken.
 * "Free" = on screen, below the Roblox bar, clear by TOUCH_GAP of the thumbs, of Menu / Bag, of the console and of
 * `keepOut` (hud.ts: the messages over the top centre at their narrowest).
 */
export function placeTouchSky(
	L: TouchLayout,
	deck: PxRect,
	plateW: number,
	plateH: number,
	keepOut: ReadonlyArray<PxRect> = [],
): ConsolePlacement {
	const unit = math.max(L.scale, 0.5);
	const gap = TOUCH_GAP * unit;
	const edge = TOUCH_EDGE * unit;
	// sized by the device's touch unit, not by the buttons: the sky is read, never pressed, so it does not grow with
	// the player's control size (a Menu button at its largest would have made it 362 px wide on a 1120 x 630 tablet)
	const scale = unit * SKY_TOUCH_SCALE;
	const h = plateH * scale;
	const w = plateW * scale;
	const top = L.pause.y - L.pause.r;
	const grow = (r: PxRect): PxRect => [r[0] - gap, r[1] - gap, r[2] + gap, r[3] + gap];
	const obstacles: Array<PxRect> = [];
	for (const r of thumbRects(L)) obstacles.push(grow(r));
	for (const b of [L.pause, L.bag]) obstacles.push(grow([b.x - b.r, b.y - b.r, b.x + b.r, b.y + b.r]));
	obstacles.push(grow(deck));
	for (const r of keepOut) obstacles.push(grow(r));
	// the row of Menu and Bag, and which of its ends is at the screen's edge (the right one, unless it moved)
	const rowL = math.min(L.pause.x - L.pause.r, L.bag.x - L.bag.r);
	const rowR = math.max(L.pause.x + L.pause.r, L.bag.x + L.bag.r);
	const rowB = math.max(L.pause.y + L.pause.r, L.bag.y + L.bag.r);
	const outerRight = L.viewW - rowR <= rowL;
	const homeX = outerRight ? rowR - w : rowL;
	// a message that reaches past the row's bottom (a banner on a tall screen) pushes the home down past it
	let homeY = rowB + gap;
	for (const m of keepOut) {
		if (homeX < m[2] + gap && m[0] - gap < homeX + w && m[1] - gap < homeY + h && homeY < m[3] + gap) {
			homeY = m[3] + gap;
		}
	}
	const cx = (deck[0] + deck[2]) / 2 - w / 2;
	const spots: Array<[number, number]> = [
		[homeX, homeY],
		[L.pause.x - L.pause.r - gap - w, top],
		[edge, top],
		[cx, deck[3] + gap],
		[cx, deck[1] - gap - h],
	];
	for (const [x, y] of spots) {
		const r: PxRect = [x, y, x + w, y + h];
		const onScreen = x >= edge - 0.001 && x + w <= L.viewW - edge + 0.001 && y >= L.inset && y + h <= L.viewH;
		if (onScreen && !overlapsAny(r, obstacles)) return { x, y, w, h, scale };
	}
	// nothing free (no screen the tests know gets here): its home, under the row
	return { x: spots[0][0], y: spots[0][1], w, h, scale };
}

/**
 * Where the match scoreboard's survivors chip goes on a touch screen (MP-23, scoreboard.ts): with the Bag and the Menu,
 * as on desktop (the console's button row) -- it is the third in-run button with a panel behind it. Its first free
 * place, once the sky `sky` is placed (placeTouchSky):
 *  1. in the row of Menu and Bag, next to its inner end (left of Menu), centred on the row's height: its home, where
 *     the corner reads as one block -- the three buttons over the clock. When the sky sits right under the row, the
 *     chip takes the sky's inner edge, so the block has one edge there (a few px off CHIP_W, never under a thumb);
 *     then the same place pushed up to the bar (a fixed stick at its largest can reach the row's height);
 *  2. beside the sky, on its side towards the screen's centre, then 3. on its other side;
 *  4. under the sky, at its inner end then at its outer end; 5. over the sky, the same two.
 * "Free" = as for the sky: on screen, below the Roblox bar, TOUCH_GAP clear of the thumbs, of Menu / Bag, of the
 * console, of the sky and of `keepOut` (hud.ts: the messages over the top centre at their narrowest). Sized by the sky's
 * scale (the device's touch unit: the chip is as tall as the sky's plate, about as tall as Menu), `chipW` x `chipH`
 * design units, and never under MIN_TOUCH_PX on a side: it is a thumb target.
 */
export function placeTouchChip(
	L: TouchLayout,
	deck: PxRect,
	sky: PxRect,
	chipW: number,
	chipH: number,
	keepOut: ReadonlyArray<PxRect> = [],
): ConsolePlacement {
	const unit = math.max(L.scale, 0.5);
	const gap = TOUCH_GAP * unit;
	const edge = TOUCH_EDGE * unit;
	const scale = unit * SKY_TOUCH_SCALE;
	const w = math.max(chipW * scale, MIN_TOUCH_PX);
	const h = math.max(chipH * scale, MIN_TOUCH_PX);
	const grow = (r: PxRect): PxRect => [r[0] - gap, r[1] - gap, r[2] + gap, r[3] + gap];
	const obstacles: Array<PxRect> = [];
	for (const r of thumbRects(L)) obstacles.push(grow(r));
	for (const b of [L.pause, L.bag]) obstacles.push(grow([b.x - b.r, b.y - b.r, b.x + b.r, b.y + b.r]));
	obstacles.push(grow(deck));
	obstacles.push(grow(sky));
	for (const r of keepOut) obstacles.push(grow(r));
	// the row of Menu and Bag, and its inner end (the one away from the screen's edge: the left, unless it moved)
	const rowL = math.min(L.pause.x - L.pause.r, L.bag.x - L.bag.r);
	const rowR = math.max(L.pause.x + L.pause.r, L.bag.x + L.bag.r);
	const rowB = math.max(L.pause.y + L.pause.r, L.bag.y + L.bag.r);
	const outerRight = L.viewW - rowR <= rowL;
	let homeX = outerRight ? rowL - gap - w : rowR + gap;
	let homeW = w;
	// the sky right under the row: share its inner edge, as long as the chip keeps about its size
	if (sky[1] >= rowB - 0.001 && sky[1] - rowB <= L.pause.r + gap) {
		const aligned = outerRight ? rowL - gap - sky[0] : sky[2] - (rowR + gap);
		if (aligned >= MIN_TOUCH_PX && aligned >= w * 0.8 && aligned <= w * 1.25) {
			homeW = aligned;
			homeX = outerRight ? sky[0] : rowR + gap;
		}
	}
	// the sky's inner side: towards the middle of the screen
	const innerLeft = (sky[0] + sky[2]) / 2 >= L.viewW / 2;
	const leftOf = sky[0] - gap - w;
	const rightOf = sky[2] + gap;
	const innerX = innerLeft ? sky[0] : sky[2] - w;
	const outerX = innerLeft ? sky[2] - w : sky[0];
	const spots: Array<[number, number, number]> = [
		[homeX, L.pause.y - h / 2, homeW],
		// the same place in the row, pushed up to the bar: with a fixed stick at its largest, its grab zone can reach
		// up to the row's height on the far side
		[homeX, L.inset, homeW],
		[innerLeft ? leftOf : rightOf, sky[1], w],
		[innerLeft ? rightOf : leftOf, sky[1], w],
		[innerX, sky[3] + gap, w],
		[outerX, sky[3] + gap, w],
		[innerX, sky[1] - gap - h, w],
		[outerX, sky[1] - gap - h, w],
	];
	for (const [x, y, sw] of spots) {
		const r: PxRect = [x, y, x + sw, y + h];
		const onScreen = x >= edge - 0.001 && x + sw <= L.viewW - edge + 0.001 && y >= L.inset && y + h <= L.viewH;
		if (onScreen && !overlapsAny(r, obstacles)) return { x, y, w: sw, h, scale };
	}
	// nothing free (no screen the tests know gets here): its home, in the row
	return { x: spots[0][0], y: spots[0][1], w: spots[0][2], h, scale };
}

// ---------------------------------------------------------------- bars

interface ConsoleBar {
	groove: Frame;
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
	icon: IconView;
	/** where the icon's square was last put (placeIcon writes only a change) */
	iconAt: string;
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

// ---------------------------------------------------------------- inside a tile: the icon, the key, the ammo

/** the key badge in a tile's top-left corner: its side and its distance from the corner (design units) */
const KEY_SIDE = 10;
const KEY_INSET = 0;
/** a gun's ammo chip along the bottom: its height as a share of the tile, its distance from the bottom and sides */
const CHIP_SHARE = 0.22;
const CHIP_BOTTOM = 2;
const CHIP_SIDE = 4;
/** px kept between an icon's drawn pixels and the edge of its room, and between them and the key badge */
const ICON_CLEAR = 1;

/** the ammo chip's height (design units) on a tile `size` design units square */
function chipHeight(size: number): number {
	return math.round(size * CHIP_SHARE);
}

/** a weapon icon the hotbar can show, and whether it shows on a gun's tile (over the ammo chip) */
interface WeaponIcon {
	key: string;
	gun: boolean;
}
let weaponIcons: Array<WeaponIcon> | undefined;

/** every weapon's icon (iconOf: its own or its category's), once per kind of tile it can be on */
function weaponIconList(): Array<WeaponIcon> {
	if (weaponIcons !== undefined) return weaponIcons;
	const out: Array<WeaponIcon> = [];
	for (let id = 0; id < WEAPONS.size(); id++) {
		const key = iconOf(ItemKind.Weapon, id).key;
		const gun = WEAPONS[id].mag > 0;
		if (!out.some(e => e.key === key && e.gun === gun)) out.push({ key, gun });
	}
	weaponIcons = out;
	return out;
}

/** where a tile's icon goes, in the tile's own pixels: the square's side and its top-left on each kind of tile */
export interface TileIconFit {
	side: number;
	/** a melee weapon's tile: the square centred on the face */
	melee: [number, number];
	/** a gun's tile: the square centred on the face above the ammo chip */
	gun: [number, number];
}

/**
 * The icon of a hotbar tile `T` px square, `design` design units in the layout, whose face starts `u` px in (the
 * plate's relief): the LARGEST side at which EVERY weapon icon -- the box of what it draws centred in its room (the
 * face on a melee weapon's tile, the face above the ammo chip on a gun's) -- stays ICON_CLEAR px inside that room and,
 * with `key` (a keyboard's digit on the corner), ICON_CLEAR px clear of the key badge, pixel by pixel. One side for
 * every weapon, so picking one up never resizes the hotbar's icons.
 *
 * The sides tried are those the drawer keeps as they are (itemIcon.ts measure) and draws evenly: whole screen pixels
 * per icon pixel (16, 32, 48, 64...) or a regular one and a half / two and a half (24, 40: every other icon pixel one
 * screen pixel wider). Any other side makes some icon pixels wider than their neighbours at random, and turns a
 * diagonal blade into a crooked staircase -- what the owner saw on a 41 px tile drawn at 25 px (1,56 px per pixel).
 * When nothing fits (a tile under ~30 px), the smallest side.
 */
export function fitTileIcon(T: number, u: number, design: number, key: boolean): TileIconFit {
	const s = T / design;
	const chipTop = T - (CHIP_BOTTOM + chipHeight(design)) * s;
	const k0 = KEY_INSET * s - ICON_CLEAR;
	const k1 = (KEY_INSET + KEY_SIDE) * s + ICON_CLEAR;
	const icons = weaponIconList();
	let last: TileIconFit | undefined;
	for (let side = math.floor((T - 2 * u) / 8) * 8; side >= 16; side -= 8) {
		if (side % 16 !== 0 && side !== 24 && side !== 40) continue;
		const at = (top: number, bottom: number): [number, number] => [
			math.floor((T - side) / 2 + 0.5),
			math.floor((top + bottom - side) / 2 + 0.5),
		];
		const fit: TileIconFit = { side, melee: at(u, T - u), gun: at(u, chipTop) };
		last = fit;
		let ok = true;
		for (const w of icons) {
			const [ox, oy] = w.gun ? fit.gun : fit.melee;
			const bottom = w.gun ? chipTop : T - u;
			let x0 = math.huge;
			let y0 = math.huge;
			let x1 = -math.huge;
			let y1 = -math.huge;
			for (const [rx0, ry0, rx1, ry1] of drawnRects(w.key, side)) {
				x0 = math.min(x0, ox + rx0);
				y0 = math.min(y0, oy + ry0);
				x1 = math.max(x1, ox + rx1);
				y1 = math.max(y1, oy + ry1);
				if (key && ox + rx0 < k1 && k0 < ox + rx1 && oy + ry0 < k1 && k0 < oy + ry1) ok = false;
			}
			const inside =
				x0 >= u + ICON_CLEAR && x1 <= T - u - ICON_CLEAR && y0 >= u + ICON_CLEAR && y1 <= bottom - ICON_CLEAR;
			if (!ok || !inside) {
				ok = false;
				break;
			}
		}
		if (ok) return fit;
	}
	return last ?? { side: 16, melee: [0, 0], gun: [0, 0] };
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
	/** the vitals' healing cue (hudRegen.ts) */
	private readonly regen: RegenCue;
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
	/**
	 * the tiles' icon (fitTileIcon), for the size they have: in the tile's pixels once it has one on screen, in its
	 * design units before (`iconT` = what the numbers are measured in, `iconPx` = pixels)
	 */
	private iconFit: TileIconFit | undefined;
	private iconT = 0;
	private iconPx = false;
	private iconFor = "";
	/** the sky at the left end (desktop; on touch hud.ts places its own plate under Menu and Bag) */
	private sky: HudSky | undefined;
	/**
	 * desktop: the third plate of the button row, after Bag and Menu -- an empty frame the match scoreboard fills with
	 * its survivors chip (scoreboard.ts, MP-23). undefined on touch (hud.ts places the chip with Menu and Bag)
	 */
	readonly chipSlot: Frame | undefined;

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

		// ---- left end (desktop): the sky -- the world's day, the sun's arc and the countdown to the horde (hudSky.ts)
		if (L.full) this.sky = skySection(body, tr, L.pad, L.pad, L.inset, z);
		const vitalsX = L.pad + skyW(L);

		// ---- then the three bars
		const vitalsW = L.inset * 2 + L.barW;
		const vitals = Section(body, "Vitals", { x: vitalsX, y: L.pad, w: vitalsW, h: inner, zIndex: z }).frame;
		const barY = (i: number): number => L.inset + (inner - L.inset * 2 - barsH(L)) / 2 + i * (L.barH + L.barGap);
		const faces = [BAR.hp, BAR.food, BAR.xp];
		const names = ["Hp", "Food", "Xp"];
		for (let i = 0; i < 3; i++) {
			this.bars.push(this.makeBar(vitals, names[i], L.inset, barY(i), faces[i], vitals.ZIndex + 1));
		}
		// VIT-01's cue on the same two bars: the HP glow while healing, the fork on FOOD when only food stops it
		const hpAt = { x: L.inset, y: barY(0), barW: L.barW, barH: L.barH, barGap: L.barGap };
		this.regen = new RegenCue(vitals, this.bars[1].groove, hpAt, vitals.ZIndex + 1);

		// ---- middle: the hotbar on its groove bed, in its section
		const hotbarX = vitalsX + vitalsW + L.colGap;
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
		// the icons follow the tiles' size on screen (the five are one size): a resize, the touch console placed, the
		// UI scale -- never a frame
		const first = this.tiles[0].button;
		first.GetPropertyChangedSignal("AbsoluteSize").Connect(() => this.layoutIcons());
		W.onLayoutChange(first, () => this.layoutIcons());

		if (!L.full) return;

		// ---- under the hotbar's section, on the body: the Bag and Menu plates and the scoreboard's chip, centred
		// under it (3 x 76 + 2 x 8 = 244 of the section's 266: the console keeps its size)
		const rowY = L.pad + hotbarH + ICON_ROW_GAP;
		const rowX = hotbarX + (hotbarW - (ICON_W * ROW_PLATES + ICON_GAP * (ROW_PLATES - 1))) / 2;
		this.makeIconPlate(body, "Bag", rowX, rowY, BAG, "Backpack", z, cb.onBag);
		this.makeIconPlate(body, "Menu", rowX + ICON_W + ICON_GAP, rowY, MENU, "Menu", z, cb.onMenu);
		this.chipSlot = W.makeFrame(
			body,
			"ChipSlot",
			rowX + 2 * (ICON_W + ICON_GAP),
			rowY,
			ICON_W,
			ICON_H,
			THEME.background,
			{
				transparency: 1,
				zIndex: z,
			},
		);

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
			groove,
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

	/** one hotbar tile (GridTile-style): the plate, the item icon, the key badge, the ammo chip, the reload fill */
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

		// the item's pixel icon, the same drawing as the Bag's tile and the item card (UI-11), what it draws centred in
		// the tile (fit "drawn"; the square is placed by placeIcon, clear of the key badge and the ammo chip). It holds
		// as many Frames as the costliest weapon icon from the start: a weapon picked up or lost rewrites the tile's
		// Frames and never creates one (update() runs every frame and creates nothing, UI-09)
		const icon = IconView(b, "ItemIcon", 0, 0, size, z + 1, WEAPON_ICON_FRAMES, "drawn");
		icon.frame.Visible = false;

		// the key that picks it: the kit's key look (a raised dark-iron plate, light legend), on the corner
		const key = W.makeFrame(b, "Key", KEY_INSET, KEY_INSET, KEY_SIDE, KEY_SIDE, THEME.background, {
			transparency: 1,
			zIndex: z + 3,
		});
		paintPlate(key, SURFACE.key, "idle", 2);
		const keyLabel = this.text(key, "Legend", "", 0, 0, KEY_SIDE, KEY_SIDE, TEXT.xs, THEME.foreground, {
			font: BOLD,
			zIndex: z + 4,
		});
		key.Visible = false;

		// the ammo: a dark chip along the bottom, the number in the item card's yellow
		const chipH = chipHeight(size);
		const chipW = size - 2 * CHIP_SIDE;
		const ammo = W.makeFrame(b, "Ammo", CHIP_SIDE, size - chipH - CHIP_BOTTOM, chipW, chipH, THEME.background, {
			transparency: 1,
			zIndex: z + 3,
		});
		paintPlate(ammo, SURFACE.well, "flat", 1);
		const ammoLabel = this.text(ammo, "Count", "", 2, 0, chipW - 4, chipH, TEXT.xs, STAT.value, {
			font: NUMERIC,
			zIndex: z + 4,
		});
		ammo.Visible = false;

		const t: HotbarTile = {
			button: b,
			icon,
			iconAt: "",
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

	/**
	 * Fits the tiles' icon to the size the tiles have (fitTileIcon): on screen, in whole pixels of the tile; before the
	 * engine has sized them (the first frame, a Node suite), in design units, placed in Scale. Runs when that size, the
	 * relief or the screen changes -- never per frame -- and rewrites only what moved.
	 */
	private layoutIcons(): void {
		const L = this.layout;
		const first = this.tiles[0];
		if (first === undefined) return;
		const T = first.button.AbsoluteSize.X;
		const px = T > 0;
		const u = px ? reliefPx(TILE_UNIT) : TILE_UNIT;
		const at = px ? `${T},${u}` : "design";
		if (at === this.iconFor) return;
		this.iconFor = at;
		this.iconPx = px;
		this.iconT = px ? T : L.tile;
		this.iconFit = fitTileIcon(this.iconT, u, L.tile, L.full);
		for (const t of this.tiles) this.placeIcon(t);
	}

	/** puts tile `t`'s icon square where its kind of tile has it (melee / gun), writing only a change */
	private placeIcon(t: HotbarTile): void {
		const fit = this.iconFit;
		if (fit === undefined) return;
		const [x, y] = t.gun ? fit.gun : fit.melee;
		const at = `${this.iconFor}|${x},${y}`;
		if (at === t.iconAt) return;
		t.iconAt = at;
		const f = t.icon.frame;
		if (this.iconPx) {
			f.Position = UDim2.fromOffset(x, y);
			f.Size = UDim2.fromOffset(fit.side, fit.side);
		} else {
			const T = this.iconT;
			f.Position = UDim2.fromScale(x / T, y / T);
			f.Size = UDim2.fromScale(fit.side / T, fit.side / T);
		}
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
		// Reduce Motion holds each bar in the state that carries the warning instead of blinking between two (the day
		// clock's countdown does the same, hudSky.ts): low HP stays lit, low food stays red
		const still = W.reducedMotion();
		const [hpBar, foodBar, xpBar] = this.bars;

		// HP: the fill blinks out when low, and lights up on a hit (the vignette is the other half of the cue)
		const hpRatio = state.hpMax > 0 ? state.hp / state.hpMax : 0;
		const hpNow = math.max(0, math.ceil(state.hp));
		if (hpNow !== hpBar.a || state.hpMax !== hpBar.b) {
			hpBar.a = hpNow;
			hpBar.b = state.hpMax;
			hpBar.label.Text = `${this.tags[0]} ${hpNow} / ${state.hpMax}`;
		}
		const hpShown = !(hpRatio < LOW_HP && !still && wave > 0);
		this.setBar(hpBar, hpRatio, BAR.hp, state.hitFlash > HIT_HOT ? "hot" : "idle", hpShown);

		// food: low hunger blinks the fill red, the colour of what it is doing to you (both pass under the label)
		const foodRatio = state.hungerMax > 0 ? state.hunger / state.hungerMax : 0;
		const foodNow = math.clamp(math.floor(state.hunger + 0.5), 0, math.max(state.hungerMax, 0));
		if (foodNow !== foodBar.a || state.hungerMax !== foodBar.b) {
			foodBar.a = foodNow;
			foodBar.b = state.hungerMax;
			foodBar.label.Text = `${this.tags[1]} ${foodNow} / ${state.hungerMax}`;
		}
		this.setBar(foodBar, foodRatio, foodRatio < LOW_FOOD && (still || wave > 0) ? BAR.hp : BAR.food, "idle", true);
		// VIT-01: the HP bar glows while the body heals, and FOOD shows a fork while only food stands in its way
		this.regen.update(state.hp, state.hpMax, state.hunger, state.sinceHurt, now, still);

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
		this.sky?.update(state, now);
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
				// a melee weapon's icon in the middle of the face, a gun's in the middle of the face above its chip
				this.placeIcon(t);
				drawItemIcon(t.icon, ItemKind.Weapon, id);
			}
			t.icon.frame.Visible = w !== undefined;
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
