/*
 * Ground items: what lies in the street to be picked up (docs/DESIGN_RULES.md ITM-06). Drawn by
 * client/gameLoop.ts every frame, and by tools/render-ground-items.mjs onto every ground for the pictures.
 *
 * What an item looks like on the ground:
 *   - WITH the item icons' atlas (it has an asset id): the item's own pixel icon, the very picture the Bag, the item
 *     card and the hotbar show (UI-11), upright (a turned Pixelated image is a staircase of diamonds, ART-08), at
 *     ICON_TEXEL units per icon pixel -- 32 u for the 16 x 16 cell, the size the flat looks below always had (a
 *     pistol 24 u, a rifle 30 u; at the town's 4 u per texel an apple would be as wide as the survivor, ESC-01). The
 *     drawn box is centred on the item, not the grid (the Bag's fit "drawn"). Its drop shadow is the same cell tinted
 *     black, one icon pixel along the light: a silhouette, the 1-pixel dark outline every icon already has doubled on
 *     one side, which is what lifts it off a pale floor (LEG-03). 2 sprites an item.
 *   - WITHOUT it (no id, or the atlas failed to load: client/view/worldArt.ts): the flat looks of before -- one
 *     silhouette per category, turned a little, with its short shadow (ART-01: no id, nothing changes).
 * And in both, what the item is FOR (shared/sim/pickupRule.ts groundTier):
 *   - a weapon or equipment (taken with E) lies on a faint pale ring, a boss's trophy or a golden weapon on a gold
 *     one (the Gold bar's colour, not LEG-02's electric yellow); a supply (walked up) has none: a street of wood reads
 *     as a street, not as a row of targets;
 *   - the glint: every GLINT_PERIOD for gear, a smaller one half as often for supplies; none with Reduce Motion;
 *   - the item E would take (`target`, the same query the hint and the server run) wears four corner brackets, and
 *     only that one: with three items in reach, the one the next press takes is the one marked;
 *   - several items on one spot (a boss's trophies, a zombie's drop on another's) fan out on a ring round it, evenly,
 *     in the order they fell -- drawn apart, lying where they lie (the pickup reach is measured where they LIE);
 *   - a drop (an item first seen sliding) hops twice as it lands; with Reduce Motion it just slides.
 * Everything is under the night (Z below the dark layer): an item is as lit as the ground it lies on, and in the dark
 * only the survivor's light (250 u, always over the 40 u reach) shows it -- loot never glows through the night.
 *
 * The glint's and the brackets' sprites exist only while shown: each ZIndex is its own bucket in the renderer's pool
 * (one sub-pool per ZIndex), so one appearing or going moves no other sprite. Nothing here creates an Instance once
 * the pool has grown to the busiest screen (npm run test:pool).
 */
import { COLORS, Z } from "shared/engine/colors";
import { Camera, ViewRect } from "shared/engine/camera";
import { Renderer, SpriteOpts } from "shared/engine/renderer";
import { ItemKind, WeaponKind } from "shared/data/kinds";
import { EQUIPS } from "shared/data/equips";
import { USABLES } from "shared/data/usables";
import { isChoppingTool, WEAPONS } from "shared/data/weapons";
import { ITEM_ICONS, iconOf } from "shared/data/itemIcons";
import type { GroundItem } from "shared/game/world";
import { groundTier, GroundTier } from "shared/sim/pickupRule";
import { ICON_ATLAS_CELLS } from "../ui/itemIconAtlas";
import { circleInView, part } from "./drawKit";
import { artId } from "./worldArt";
import type { ShadowFn } from "./worldView";

const WHITE = COLORS.white;
const BLACK = COLORS.shadow;

/** one flat piece of a ground item, in the item's own frame (f along its heading, l to its right) */
interface ItemPart {
	f: number;
	l: number;
	w: number;
	h: number;
	color: Color3;
	/** corner radius (world units); CIRCLE for a disc */
	r: number;
	/** extra turn relative to the item (radians) */
	rot: number;
	/** dark outline that separates the piece from any ground (off for insets such as labels) */
	edge: boolean;
}

/** a ground item's silhouette: its pieces bottom → top and the footprint of its drop shadow */
interface ItemLook {
	parts: Array<ItemPart>;
	shadowW: number;
	shadowH: number;
	shadowR: number;
}

const CIRCLE = -1;

function piece(f: number, l: number, w: number, h: number, color: Color3, r = 2, edge = true, rot = 0): ItemPart {
	return { f, l, w, h, color, r, rot, edge };
}

function look(shadowW: number, shadowH: number, shadowR: number, parts: Array<ItemPart>): ItemLook {
	return { parts, shadowW, shadowH, shadowR };
}

/**
 * Item palette. Built from the world palette and kept clear of the fixed gameplay colours (LEG-02):
 * no zombie green, poison purple or electric yellow on loot. Red appears only as the medical cross
 * (it restores the player's health, the thing red stands for). Each look has one light, saturated
 * piece so it reads on dark asphalt and a dark outline so it reads on pale pavement.
 */
const LOOT = {
	steel: COLORS.blade,
	gunmetal: COLORS.wallIron.Lerp(COLORS.weapon, 0.25),
	grip: COLORS.weapon,
	handle: COLORS.treeTrunk,
	lumber: COLORS.arrow.Lerp(COLORS.treeTrunk, 0.25),
	tin: COLORS.blade.Lerp(COLORS.wallIron, 0.4),
	foodLabel: COLORS.campfire.Lerp(COLORS.blood, 0.15),
	medCase: WHITE.Lerp(COLORS.wallHouse, 0.25),
	medCross: COLORS.uiRed,
	ammoBox: COLORS.treeLeafDark.Lerp(COLORS.fence, 0.6),
	brass: COLORS.uiAccent.Lerp(WHITE, 0.2),
	fuel: COLORS.car.Lerp(COLORS.fence, 0.3),
	cloth: COLORS.wallHouse,
	leather: COLORS.doormat.Lerp(COLORS.treeTrunk, 0.3),
	steelBar: COLORS.wallIron.Lerp(WHITE, 0.2),
	gold: COLORS.uiAccent,
	stone: COLORS.curb.Lerp(WHITE, 0.12),
	burlap: COLORS.dirtPath.Lerp(COLORS.wallHouse, 0.2),
	/** machine parts are blue like every machine (LEG-02) */
	parts: COLORS.uiBlue.Lerp(COLORS.wallIron, 0.45),
	plastic: COLORS.wallShop,
	lens: COLORS.uiBlue.Lerp(WHITE, 0.3),
	fletch: WHITE.Lerp(COLORS.sidewalk, 0.2),
};
const LOOT_EDGE = COLORS.shadow.Lerp(COLORS.road, 0.25);

/** two stacked long pieces: lumber, metal bars */
function stackLook(color: Color3, len: number, thick: number, r: number): ItemLook {
	return look(len + 4, thick * 2 + 6, r, [
		piece(-2, -thick * 0.55, len, thick, color, r),
		piece(2, thick * 0.55, len - 2, thick, color.Lerp(WHITE, 0.12), r),
	]);
}

/** armour lying flat: a vest with its neck opening towards the item's heading */
function vestLook(color: Color3): ItemLook {
	return look(26, 30, 8, [
		piece(0, 0, 26, 30, color, 8),
		piece(9, 0, 9, 12, color.Lerp(COLORS.shadow, 0.45), 4, false),
	]);
}

const ITEM_LOOKS = {
	/** knives, swords, machetes, crowbars: handle + long steel head */
	blade: look(34, 8, 3, [piece(-11, 0, 13, 7, LOOT.handle, 2), piece(6, 0, 23, 6, LOOT.steel, 3)]),
	/** axes and saws: wooden haft + steel head across it */
	axe: look(34, 18, 3, [piece(-2, 0, 32, 6, LOOT.lumber, 3), piece(11, -4, 9, 18, LOOT.steel, 2)]),
	/** wooden stick / baseball bat */
	club: look(34, 9, 4, [piece(2, 0, 30, 8, LOOT.lumber, 4), piece(-13, 0, 9, 6, LOOT.handle, 2)]),
	/** pistols: slide + grip (an L) */
	pistol: look(26, 24, 3, [piece(-7, 8, 9, 15, LOOT.grip, 2, true, 0.3), piece(1, -3, 24, 8, LOOT.gunmetal, 2)]),
	/** rifles, shotguns, machine guns: wooden stock, grip, long receiver and barrel */
	longGun: look(36, 14, 3, [
		piece(-13, 0, 12, 10, LOOT.handle, 3),
		piece(-3, 5, 7, 9, LOOT.grip, 2),
		piece(4, 0, 30, 7, LOOT.gunmetal, 2),
	]),
	/** bows and the crossbow: two limbs in a shallow V + the string */
	bow: look(18, 34, 6, [
		piece(-4, 0, 2, 30, LOOT.fletch, 1, false),
		piece(1, -8, 5, 19, LOOT.handle, 2, true, -0.35),
		piece(1, 8, 5, 19, LOOT.handle, 2, true, 0.35),
	]),
	/** cartridges: an olive ammo box, open, brass showing */
	ammo: look(26, 20, 3, [piece(0, 0, 26, 20, LOOT.ammoBox, 3), piece(1, 0, 18, 12, LOOT.brass, 2, false)]),
	/** a bundle of arrows */
	arrows: look(34, 12, 2, [
		piece(0, -3, 32, 3, LOOT.lumber, 1),
		piece(1, 3, 32, 3, LOOT.lumber, 1),
		piece(-12, 0, 8, 12, LOOT.fletch, 2, false),
	]),
	/** oil: a jerrycan with its cap */
	fuel: look(24, 28, 4, [piece(0, 0, 24, 28, LOOT.fuel, 4), piece(8, -7, 8, 8, LOOT.steel, CIRCLE)]),
	/** food: a can lying on its side (tin ends, paper label) */
	food: look(28, 18, 5, [piece(0, 0, 28, 18, LOOT.tin, 5), piece(0, 0, 16, 18, LOOT.foodLabel, 0, false)]),
	/** medicine: a white case with a red cross */
	medicine: look(28, 24, 4, [
		piece(0, 0, 28, 24, LOOT.medCase, 4),
		piece(0, 0, 16, 5, LOOT.medCross, 1, false),
		piece(0, 0, 5, 16, LOOT.medCross, 1, false),
	]),
	lumber: stackLook(LOOT.lumber, 32, 8, 1),
	steel: stackLook(LOOT.steelBar, 26, 10, 2),
	gold: stackLook(LOOT.gold, 26, 10, 2),
	cloth: stackLook(LOOT.cloth, 28, 11, 5),
	leather: stackLook(LOOT.leather, 28, 11, 5),
	stone: look(26, 20, 9, [
		piece(-2, -1, 22, 18, LOOT.stone, 8),
		piece(8, 6, 12, 10, LOOT.stone.Lerp(WHITE, 0.15), 5),
	]),
	/** gunpowder: a tied sack */
	powder: look(24, 26, 8, [piece(-2, 0, 22, 24, LOOT.burlap, 8), piece(11, 0, 5, 12, LOOT.handle, 2)]),
	/** machine parts and electronics: a big steel-blue washer */
	parts: look(24, 24, 12, [piece(0, 0, 24, 24, LOOT.parts, CIRCLE), piece(0, 0, 9, 9, LOOT.grip, CIRCLE, false)]),
	/** placeable kits (desks, turrets, barricades...): a braced wooden crate */
	crate: look(28, 28, 2, [
		piece(0, 0, 28, 28, LOOT.lumber.Lerp(COLORS.treeTrunk, 0.25), 2),
		piece(0, 0, 34, 5, LOOT.lumber.Lerp(COLORS.treeTrunk, 0.55), 1, false, math.pi / 4),
	]),
	/** gadgets and attachments (flashlight, watch, scope...): a device with a blue lens */
	gadget: look(24, 18, 4, [piece(0, 0, 24, 18, LOOT.plastic, 4), piece(5, 0, 8, 8, LOOT.lens, CIRCLE)]),
};

/** armour (equip kind 1) by material; the rest of the equipment is gadgets */
const VEST_LOOKS: Record<number, ItemLook> = {
	0: vestLook(LOOT.cloth),
	1: vestLook(LOOT.leather),
	2: vestLook(LOOT.leather),
	3: vestLook(LOOT.lumber),
	4: vestLook(LOOT.steelBar),
	5: vestLook(LOOT.plastic),
	14: vestLook(LOOT.parts),
};

/** usables that heal or treat (first aid, pain killer, adrenaline, sedative, bandage) vs food */
function isMedicine(id: number): boolean {
	const u = USABLES[id];
	if (u === undefined) return false;
	return u.pain > 0 || u.speed > 0 || u.calm > 0 || (u.hunger <= 0 && u.hp > 0);
}

/** silhouette of a ground item by category: weapon, ammo/fuel, food, medicine, material, equipment */
function itemLook(kind: number, id: number): ItemLook {
	if (kind === ItemKind.Weapon) {
		const w = WEAPONS[id];
		if (w === undefined) return ITEM_LOOKS.blade;
		if (w.kind === WeaponKind.Melee) {
			if (isChoppingTool(w)) return ITEM_LOOKS.axe;
			return id === 1 || id === 6 ? ITEM_LOOKS.club : ITEM_LOOKS.blade;
		}
		if (w.kind === WeaponKind.Bow) return ITEM_LOOKS.bow;
		return w.kind === WeaponKind.Pistol ? ITEM_LOOKS.pistol : ITEM_LOOKS.longGun;
	}
	if (kind === ItemKind.Equip) {
		const e = EQUIPS[id];
		if (e !== undefined && e.kind === 1) return VEST_LOOKS[id] ?? VEST_LOOKS[0];
		return ITEM_LOOKS.gadget;
	}
	if (kind === ItemKind.Use) return isMedicine(id) ? ITEM_LOOKS.medicine : ITEM_LOOKS.food;
	// etc items (etcItems.ts): kits 0–22, materials 23–43, ammo 44–47, oil 48
	if (id >= 44 && id <= 46) return ITEM_LOOKS.ammo;
	if (id === 47) return ITEM_LOOKS.arrows;
	if (id === 48) return ITEM_LOOKS.fuel;
	if (id === 23) return ITEM_LOOKS.lumber;
	if (id === 24) return ITEM_LOOKS.stone;
	if (id === 25 || id === 26) return ITEM_LOOKS.steel;
	if (id === 27 || id === 28) return ITEM_LOOKS.gold;
	if (id === 33) return ITEM_LOOKS.powder;
	if (id === 34) return ITEM_LOOKS.cloth;
	if (id === 41) return ITEM_LOOKS.leather;
	if (id <= 22) return ITEM_LOOKS.crate;
	return ITEM_LOOKS.parts;
}

/*
 * The view's own option tables, one scratch per call site (M4): a literal per item piece and glint was a table per
 * sprite per frame. The keys that never change are written here; each draw writes the rest.
 */
const ITEM_SHADOW_O: SpriteOpts = { color: BLACK, alpha: 0.3, zIndex: Z.actorShadow };
const ITEM_PIECE_O: SpriteOpts = { strokeThickness: 1, strokeAlpha: 0.75 };
const GLINT_O: SpriteOpts = { color: WHITE, zIndex: Z.item + 4 };
/** the icon and its silhouette shadow: one cell of the atlas each */
const ICON_O: SpriteOpts = { zIndex: Z.item, pixelated: true };
const ICON_SHADOW_O: SpriteOpts = { zIndex: Z.actorShadow, pixelated: true, imageTint: BLACK };
/** the tier's ring: a dark band under a thin light line, both only strokes (the ground shows through) */
const RING_DARK_O: SpriteOpts = { circle: true, alpha: 0, stroke: BLACK, zIndex: Z.actorShadow + 1 };
const RING_LIGHT_O: SpriteOpts = { circle: true, alpha: 0, zIndex: Z.actorShadow + 1 };
/**
 * The target's corner brackets: light bars with a dark edge, over the survivor (an item in reach lies under the body
 * as often as not, and what E takes must always be seen) and under the night like the item itself.
 */
const BRACKET_O: SpriteOpts = {
	color: WHITE,
	stroke: BLACK,
	strokeThickness: 1,
	strokeAlpha: 0.85,
	zIndex: Z.player + 3,
};

/** how far a dropped item lies turned from the world axes (radians), fixed per item (the flat looks only) */
const ITEM_TILT = 0.55;
/** units of the world per pixel of an item's icon: the 16 x 16 cell is 32 u, the flat looks' size */
export const ICON_TEXEL = 2;
/** the glint that marks loot: once every period (s), lasting `len` (s), per item out of phase */
const GLINT_PERIOD = 2.6;
const GLINT_LEN = 0.45;
const GLINT_ARM = 14;
/** a supply's glint: half as often, and smaller */
const GLINT_PERIOD_SUPPLY = GLINT_PERIOD * 2;
const GLINT_ARM_SUPPLY = 8;
/** the rings: pale for gear (taken with E), gold for a trophy (the Gold bar's colour, never LEG-02's yellow) */
const RING_GEAR = WHITE;
const RING_RARE = COLORS.uiAccent;
const RING_ALPHA = 0.55;
const RING_PAD = 4;
/**
 * Items closer than PILE_R to another lie in a pile, and fan out in a ring around where they lie, evenly, in the order
 * they fell (by id): PILE_SPREAD units out for two, PILE_STEP more for each one past two, up to PILE_SPREAD_MAX --
 * six trophies sit 33 u out, 33 u apart: an icon each, none under another.
 */
export const PILE_R = 12;
export const PILE_SPREAD = 15;
const PILE_STEP = 4.5;
const PILE_SPREAD_MAX = 36;
/** past this many items on screen the pile check stops (it is pairwise): a farm's floor draws, just unfanned */
const PILE_CHECK_MAX = 64;
/** where the first of a pile goes on its ring (up and a little left: the rest follow clockwise) */
const PILE_START = -math.pi * 0.62;
/** a drop's two hops: how long each lasts (s) and how high it goes (units, drawn up the screen) */
const HOP_T1 = 0.26;
const HOP_T2 = 0.14;
const HOP_H1 = 7;
const HOP_H2 = 2;
/** the target's brackets: arm length and thickness, the gap round the drawn box, and their breath */
const BRACKET_ARM = 6;
const BRACKET_W = 2;
const BRACKET_GAP = 4;
const BRACKET_BREATH = 1.5;
/** the four corners, as signs (a literal in the loop would be two tables a frame) */
const SIGNS = [-1, 1];

/** an icon on the ground: its atlas cell, where the drawn box's centre is in the cell, and the box's size (units) */
interface GroundIcon {
	x: number;
	y: number;
	n: number;
	/** from the item's position to the cell's centre (units): the drawn box lands centred on the item */
	ox: number;
	oy: number;
	w: number;
	h: number;
}

const icons = new Map<string, GroundIcon | false>();

/** the icon of `key` on the ground, or false when the atlas has no cell for it (then the flat look draws) */
function groundIcon(key: string): GroundIcon | false {
	const known = icons.get(key);
	if (known !== undefined) return known;
	const cell = ICON_ATLAS_CELLS[key];
	const rows = ITEM_ICONS[key];
	if (cell === undefined || rows === undefined) {
		icons.set(key, false);
		return false;
	}
	const n = cell[2];
	let x0 = n;
	let y0 = n;
	let x1 = 0;
	let y1 = 0;
	for (let y = 0; y < rows.size(); y++) {
		const row = rows[y];
		for (let x = 0; x < n; x++) {
			if (row.sub(x + 1, x + 1) === ".") continue;
			x0 = math.min(x0, x);
			y0 = math.min(y0, y);
			x1 = math.max(x1, x + 1);
			y1 = math.max(y1, y + 1);
		}
	}
	if (x1 <= x0) {
		x0 = 0;
		y0 = 0;
		x1 = n;
		y1 = n;
	}
	const g: GroundIcon = {
		x: cell[0],
		y: cell[1],
		n,
		ox: (n / 2 - (x0 + x1) / 2) * ICON_TEXEL,
		oy: (n / 2 - (y0 + y1) / 2) * ICON_TEXEL,
		w: (x1 - x0) * ICON_TEXEL,
		h: (y1 - y0) * ICON_TEXEL,
	};
	icons.set(key, g);
	return g;
}

/** per item (kind and id as one number): its icon on the ground, looked up once -- `iconOf` builds a table a call */
const byItem = new Map<number, GroundIcon | false>();

function groundIconOf(kind: number, id: number): GroundIcon | false {
	const k = kind * 1000 + id;
	const known = byItem.get(k);
	if (known !== undefined) return known;
	const g = groundIcon(iconOf(kind, id).key);
	byItem.set(k, g);
	return g;
}

/** how high a drop is `t` seconds after it appeared (0 once it has landed) */
export function hopHeight(t: number): number {
	if (t < 0) return 0;
	if (t < HOP_T1) return HOP_H1 * math.sin((t / HOP_T1) * math.pi);
	if (t < HOP_T1 + HOP_T2) return HOP_H2 * math.sin(((t - HOP_T1) / HOP_T2) * math.pi);
	return 0;
}

/** the whole hop lasts this long (s) */
export const HOP_TIME = HOP_T1 + HOP_T2;

export class GroundItemsView {
	/** the id of the item E would take now (shared/sim/interactQuery.ts), -1 for none: it alone wears the brackets */
	target = -1;
	/** the Reduce Motion setting (client/ui/skin.ts reducedMotion): no glint, no hop, brackets that do not breathe */
	reduceMotion = false;
	private readonly shadow: ShadowFn;
	/** this frame's items in view, and where each is drawn (a pile fans out): scratch, refilled in place */
	private readonly shown = new Array<GroundItem>();
	private readonly drawX = new Array<number>();
	private readonly drawY = new Array<number>();
	/** per item of this frame: how many lie in its pile (1: alone), and how many of them fell before it */
	private readonly piled = new Array<number>();
	private readonly rank = new Array<number>();
	/** per drop being drawn: seconds since it appeared, and the frame it was last drawn (to forget it once gone) */
	private readonly hops = new Map<number, number>();
	private readonly hopSeen = new Map<number, number>();
	/** every item ever drawn, so an item that comes into view already at rest never hops (pruned with `hops`) */
	private readonly seen = new Map<number, number>();
	private frame = 0;

	constructor(shadow: ShadowFn) {
		this.shadow = shadow;
	}

	/** every item of `items` in view, at the loop's animation clock; `dt` ages the drops' hops */
	draw(r: Renderer, cam: Camera, v: ViewRect, items: ReadonlyArray<GroundItem>, clock: number, dt = 0): void {
		this.frame += 1;
		const atlas = artId("itemIcons");
		const shown = this.shown;
		shown.clear();
		for (const it of items) {
			if (circleInView(it.x, it.y, 40, v)) shown.push(it);
		}
		this.fanPiles();
		for (let i = 0; i < shown.size(); i++) {
			const it = shown[i];
			const hop = this.hopOf(it, dt);
			const tier = groundTier(it.kind, it.itemId);
			const icon = atlas !== undefined ? groundIconOf(it.kind, it.itemId) : false;
			const x = this.drawX[i];
			const y = this.drawY[i];
			let halfW: number;
			let halfH: number;
			if (icon !== false && atlas !== undefined) {
				this.drawIcon(r, cam, atlas, icon, it, x, y, hop);
				halfW = icon.w / 2;
				halfH = icon.h / 2;
			} else {
				const lk = itemLook(it.kind, it.itemId);
				this.drawFlat(r, cam, lk, it, x, y, hop);
				halfW = math.max(lk.shadowW, lk.shadowH) / 2;
				halfH = halfW;
			}
			if (tier !== "supply") this.drawRing(r, cam, tier, x, y, halfW, halfH);
			if (it.id === this.target) this.drawBrackets(r, cam, x, y - hop, halfW, halfH, clock);
			if (!this.reduceMotion) this.drawGlint(r, cam, it, tier, x - halfW + 3, y - hop - halfH + 3, clock);
		}
		if (this.frame % 30 === 0) this.forget();
	}

	/**
	 * Where each item of this frame is drawn: where it lies, or -- when others lie within PILE_R -- on a ring round it,
	 * the wider the bigger the pile, its slot its place in the order they fell (the lower id first): the ring is split
	 * evenly, so no icon lies on another, and it closes up as the pile is taken apart.
	 */
	private fanPiles(): void {
		const shown = this.shown;
		const n = shown.size();
		const piled = this.piled;
		const rank = this.rank;
		for (let i = 0; i < n; i++) {
			piled[i] = 1;
			rank[i] = 0;
		}
		const m = math.min(n, PILE_CHECK_MAX);
		for (let i = 1; i < m; i++) {
			const a = shown[i];
			for (let j = 0; j < i; j++) {
				const b = shown[j];
				const dx = a.x - b.x;
				if (dx > PILE_R || dx < -PILE_R) continue;
				const dy = a.y - b.y;
				if (dy > PILE_R || dy < -PILE_R || dx * dx + dy * dy > PILE_R * PILE_R) continue;
				piled[i] += 1;
				piled[j] += 1;
				if (a.id > b.id) rank[i] += 1;
				else rank[j] += 1;
			}
		}
		for (let i = 0; i < n; i++) {
			const it = shown[i];
			const k = piled[i];
			if (k > 1) {
				const a = PILE_START + (rank[i] / k) * math.pi * 2;
				const spread = math.min(PILE_SPREAD_MAX, PILE_SPREAD + PILE_STEP * (k - 2));
				this.drawX[i] = it.x + math.cos(a) * spread;
				this.drawY[i] = it.y + math.sin(a) * spread;
			} else {
				this.drawX[i] = it.x;
				this.drawY[i] = it.y;
			}
		}
	}

	/** how high this item is drawn this frame: a drop (first seen sliding) hops as it lands; nothing else moves */
	private hopOf(it: GroundItem, dt: number): number {
		const id = it.id;
		if (!this.seen.has(id)) {
			this.seen.set(id, this.frame);
			if (!this.reduceMotion && (it.vx !== 0 || it.vy !== 0)) this.hops.set(id, 0);
		} else {
			this.seen.set(id, this.frame);
		}
		const t = this.hops.get(id);
		if (t === undefined) return 0;
		if (t >= HOP_TIME || this.reduceMotion) {
			this.hops.delete(id);
			return 0;
		}
		this.hops.set(id, t + dt);
		this.hopSeen.set(id, this.frame);
		return hopHeight(t);
	}

	/** drops the memory of items no longer drawn (taken, or out of view): every 30 frames, allocation-free */
	private forget(): void {
		const frame = this.frame;
		for (const [id, at] of this.seen) {
			if (frame - at > 30) this.seen.delete(id);
		}
		for (const [id, at] of this.hopSeen) {
			if (frame - at > 30) {
				this.hopSeen.delete(id);
				this.hops.delete(id);
			}
		}
	}

	private drawIcon(
		r: Renderer,
		cam: Camera,
		atlas: string,
		g: GroundIcon,
		it: GroundItem,
		x: number,
		y: number,
		hop: number,
	): void {
		const side = g.n * ICON_TEXEL;
		// the shadow: the same cell in black, one icon pixel along the light, and further while the drop is up
		const so = this.shadow(it.x, it.y, ICON_TEXEL + hop * 0.5);
		const sh = ICON_SHADOW_O;
		sh.image = atlas;
		sh.rectX = g.x;
		sh.rectY = g.y;
		sh.rectW = g.n;
		sh.rectH = g.n;
		sh.w = side;
		sh.h = side;
		sh.alpha = 0.45;
		r.drawRect(cam, x + g.ox + so.x, y + g.oy + so.y, sh);
		const o = ICON_O;
		o.image = atlas;
		o.rectX = g.x;
		o.rectY = g.y;
		o.rectW = g.n;
		o.rectH = g.n;
		o.w = side;
		o.h = side;
		r.drawRect(cam, x + g.ox, y + g.oy - hop, o);
	}

	private drawFlat(r: Renderer, cam: Camera, lk: ItemLook, it: GroundItem, x: number, y: number, hop: number): void {
		const a = (((it.id * 37) % 23) / 11 - 1) * ITEM_TILT;
		const so = this.shadow(it.x, it.y, 4 + hop * 0.5);
		const sh = ITEM_SHADOW_O;
		sh.w = lk.shadowW;
		sh.h = lk.shadowH;
		sh.cornerRadius = lk.shadowR;
		part(r, cam, x + so.x, y + so.y, a, 0, 0, sh);
		const ca = math.cos(a);
		const sa = math.sin(a);
		const o = ITEM_PIECE_O;
		for (let i = 0; i < lk.parts.size(); i++) {
			const pc = lk.parts[i];
			o.w = pc.w;
			o.h = pc.h;
			// a piece may be turned inside the item (bow limbs, crate brace)
			o.rotation = a + pc.rot;
			o.color = pc.color;
			o.circle = pc.r === CIRCLE;
			o.cornerRadius = pc.r;
			o.stroke = pc.edge ? LOOT_EDGE : undefined;
			o.zIndex = Z.item + i;
			r.drawRect(cam, x + ca * pc.f - sa * pc.l, y - hop + sa * pc.f + ca * pc.l, o);
		}
	}

	/** the tier's ring on the ground round the item: a dark band and a thin light (or gold) line on it */
	private drawRing(
		r: Renderer,
		cam: Camera,
		tier: GroundTier,
		x: number,
		y: number,
		halfW: number,
		halfH: number,
	): void {
		const d = (math.max(halfW, halfH) + RING_PAD) * 2;
		const dark = RING_DARK_O;
		dark.w = d;
		dark.h = d;
		dark.strokeThickness = 3;
		dark.strokeAlpha = 0.3;
		r.drawRect(cam, x, y, dark);
		const light = RING_LIGHT_O;
		light.w = d;
		light.h = d;
		light.stroke = tier === "rare" ? RING_RARE : RING_GEAR;
		light.strokeThickness = 1;
		light.strokeAlpha = tier === "rare" ? 0.9 : RING_ALPHA;
		r.drawRect(cam, x, y, light);
	}

	/** four corner brackets round what E takes: on the item E would take now, and only on it */
	private drawBrackets(
		r: Renderer,
		cam: Camera,
		x: number,
		y: number,
		halfW: number,
		halfH: number,
		clock: number,
	): void {
		const breath = this.reduceMotion ? 0 : BRACKET_BREATH * (0.5 + 0.5 * math.sin(clock * math.pi * 2 * 1.2));
		const hx = halfW + BRACKET_GAP + breath;
		const hy = halfH + BRACKET_GAP + breath;
		const o = BRACKET_O;
		for (const sx of SIGNS) {
			for (const sy of SIGNS) {
				const cx = x + sx * hx;
				const cy = y + sy * hy;
				// the horizontal arm, then the vertical one, both running from the corner inwards
				o.w = BRACKET_ARM;
				o.h = BRACKET_W;
				r.drawRect(cam, cx - (sx * (BRACKET_ARM - BRACKET_W)) / 2, cy, o);
				o.w = BRACKET_W;
				o.h = BRACKET_ARM;
				r.drawRect(cam, cx, cy - (sy * (BRACKET_ARM - BRACKET_W)) / 2, o);
			}
		}
	}

	/** a four-point sparkle at the item's upper left, out of phase per item; gear often, supplies seldom and small */
	private drawGlint(
		r: Renderer,
		cam: Camera,
		it: GroundItem,
		tier: GroundTier,
		gx: number,
		gy: number,
		clock: number,
	): void {
		const period = tier === "supply" ? GLINT_PERIOD_SUPPLY : GLINT_PERIOD;
		const t = (clock + it.id * 0.61) % period;
		if (t >= GLINT_LEN) return;
		const s = math.sin((t / GLINT_LEN) * math.pi);
		const arm = 3 + (tier === "supply" ? GLINT_ARM_SUPPLY : GLINT_ARM) * s;
		const g = GLINT_O;
		g.w = arm;
		g.h = 2;
		g.alpha = (tier === "supply" ? 0.7 : 0.9) * s;
		r.drawRect(cam, gx, gy, g);
		g.w = 2;
		g.h = arm;
		r.drawRect(cam, gx, gy, g);
	}
}
