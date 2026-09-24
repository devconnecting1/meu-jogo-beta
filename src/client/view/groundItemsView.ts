/*
 * Ground items: what lies in the street to be picked up (moved out of client/gameLoop.ts so a Node tool can draw it:
 * tools/render-ground-items.mjs).
 *
 * Ground items lie flat where they fell (no floating bob), turned a little, with a short shadow cast like every other
 * object's. Each category has its own silhouette (see ITEM_LOOKS); a brief glint every few seconds marks them as loot.
 * The glint's two sprites exist only while it flashes: its ZIndex is its own bucket in the renderer's pool (one
 * sub-pool per ZIndex), so one appearing or going moves no other sprite. It used to be drawn transparent between
 * flashes to keep a single pool's order stable -- two sprites per item on screen, about 83 % of the time for nothing.
 */
import { COLORS, Z } from "shared/engine/colors";
import { Camera, ViewRect } from "shared/engine/camera";
import { Renderer, SpriteOpts } from "shared/engine/renderer";
import { ItemKind, WeaponKind } from "shared/data/kinds";
import { EQUIPS } from "shared/data/equips";
import { USABLES } from "shared/data/usables";
import { isChoppingTool, WEAPONS } from "shared/data/weapons";
import type { GroundItem } from "shared/game/world";
import { circleInView, part } from "./drawKit";
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

/** how far a dropped item lies turned from the world axes (radians), fixed per item */
const ITEM_TILT = 0.55;
/** the glint that marks loot: once every period (s), lasting `len` (s), per item out of phase */
const GLINT_PERIOD = 2.6;
const GLINT_LEN = 0.45;
const GLINT_ARM = 14;

export class GroundItemsView {
	private readonly shadow: ShadowFn;

	constructor(shadow: ShadowFn) {
		this.shadow = shadow;
	}

	/** every item of `items` in view, at the loop's animation clock */
	draw(r: Renderer, cam: Camera, v: ViewRect, items: ReadonlyArray<GroundItem>, clock: number): void {
		for (const it of items) {
			if (!circleInView(it.x, it.y, 26, v)) continue;
			const lk = itemLook(it.kind, it.itemId);
			const a = (((it.id * 37) % 23) / 11 - 1) * ITEM_TILT;
			const so = this.shadow(it.x, it.y, 4);
			const sh = ITEM_SHADOW_O;
			sh.w = lk.shadowW;
			sh.h = lk.shadowH;
			sh.cornerRadius = lk.shadowR;
			part(r, cam, it.x + so.x, it.y + so.y, a, 0, 0, sh);
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
				r.drawRect(cam, it.x + ca * pc.f - sa * pc.l, it.y + sa * pc.f + ca * pc.l, o);
			}
			// glint: a small four-point sparkle at the item's upper-left, out of phase per item
			const t = (clock + it.id * 0.61) % GLINT_PERIOD;
			if (t >= GLINT_LEN) continue;
			const s = math.sin((t / GLINT_LEN) * math.pi);
			const gx = it.x - 10;
			const gy = it.y - 11;
			const arm = 3 + GLINT_ARM * s;
			const g = GLINT_O;
			g.w = arm;
			g.h = 2;
			g.alpha = 0.9 * s;
			r.drawRect(cam, gx, gy, g);
			g.w = 2;
			g.h = arm;
			r.drawRect(cam, gx, gy, g);
		}
	}
}
