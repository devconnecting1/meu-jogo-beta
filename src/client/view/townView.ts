/*
 * The everyday town, drawn (docs/DESIGN_RULES.md EDI-18..EDI-23, MOB-04..MOB-06; laid out by shared/game/townLots.ts):
 * the ground it adds -- the bank's steps, a court, a sand pit, a poured slab, a vegetable bed -- the bank's portico,
 * columns, vault door, deposit boxes and roof, and the fixtures of the streets, the parks and the backyards.
 *
 * Frames only, the same with or without the town's textures (ART-12, like a building's furniture and the campus's
 * quad): lit from the top left like the rest of the town (LUZ-01), a dark outline, three tones, a shadow on the sun's
 * side. Every colour is a module constant (the renderer's write cache keys on the Color3's identity), and what is
 * inside a building (the vault door, the boxes) is drawn only while its roof is lifted.
 *
 * worldView.ts hands over: `drawTownGround` first for every ground rect, `drawTownProp` for a "prop" solid before the
 * campus's, `drawPortico` for the bank's canopy, `drawVaultDoor` for its door, `drawBankRoof` with the signage.
 */
import { COLORS, Z } from "shared/engine/colors";
import { Camera, ViewRect } from "shared/engine/camera";
import { Renderer } from "shared/engine/renderer";
import type { GroundRect, Rect, Solid, WorldData } from "shared/game/world";
import { isPortico, isVaultBox, isVaultDoor } from "shared/sim/vault";
import { overlaps } from "./drawKit";

/** where the shadow of something at (x, y) falls, for a shadow `len` long (worldView.ts ShadowFn, LUZ-01) */
type ShadowFn = (x: number, y: number, len: number) => { x: number; y: number };

const WHITE = COLORS.white;
const BLACK = COLORS.shadow;

// ------------------------------------------------------------------ palette

/** the bank's limestone: lit, face, shade, the dark of a joint, and the outline */
const STONE_LIT = Color3.fromRGB(232, 226, 208);
const STONE = Color3.fromRGB(208, 200, 178);
const STONE_SHADE = Color3.fromRGB(166, 156, 134);
const STONE_JOINT = Color3.fromRGB(128, 118, 100);
const STONE_LINE = Color3.fromRGB(70, 62, 52);
/** the vault's steel */
const STEEL_LIT = Color3.fromRGB(176, 182, 190);
const STEEL = Color3.fromRGB(128, 134, 142);
const STEEL_DARK = Color3.fromRGB(80, 84, 92);
const STEEL_LINE = Color3.fromRGB(34, 36, 42);
/** the alarm bell's box, and its lamp while it rings */
const BELL = Color3.fromRGB(188, 52, 46);
const BELL_LIT = Color3.fromRGB(255, 96, 72);
/** the banking hall's laylight: dark glass, and its frame */
const GLASS = Color3.fromRGB(70, 92, 110);
const GLASS_LIT = Color3.fromRGB(128, 156, 176);

/** a court's faded acrylic, a sand pit's sand and its timber, a slab's concrete, a vegetable bed's soil and rows */
const COURT = Color3.fromRGB(94, 124, 98);
const COURT_LINE = WHITE.Lerp(COURT, 0.2);
const SAND = Color3.fromRGB(214, 196, 150);
const TIMBER = Color3.fromRGB(120, 86, 56);
const SLAB = Color3.fromRGB(184, 182, 174);
const SLAB_EDGE = Color3.fromRGB(128, 124, 116);
const SOIL = Color3.fromRGB(92, 68, 48);
const SOIL_ROW = Color3.fromRGB(88, 134, 64);

// ------------------------------------------------------------------ ground

/** the bank's steps: a riser every this far across them (four steps from the sidewalk to the portico) */
const STEP = 24;

/**
 * The everyday town's own ground kinds; false for any other (worldView draws it). Flat in both drawings: a stone step
 * reads by its risers, a court by its lines, a sand pit by its timber edge.
 */
export function drawTownGround(r: Renderer, cam: Camera, g: GroundRect, v: ViewRect): boolean {
	const k = g.kind;
	if (k !== "steps" && k !== "court" && k !== "sandbox" && k !== "pad" && k !== "garden") return false;
	if (!overlaps(g.x, g.y, g.w, g.h, v)) return true;
	const cx = g.x + g.w / 2;
	const cy = g.y + g.h / 2;
	const z = Z.ground + 3;
	const alongX = g.w >= g.h;
	if (k === "steps") {
		// the stone, its joint round it, and the risers: a shade line at each step's edge
		r.drawRect(cam, cx, cy, { w: g.w, h: g.h, color: STONE, stroke: STONE_JOINT, strokeThickness: 2, zIndex: z });
		const across = alongX ? g.h : g.w;
		for (let t = STEP; t < across; t += STEP) {
			r.drawRect(cam, alongX ? cx : g.x + t, alongX ? g.y + t : cy, {
				w: alongX ? g.w : 4,
				h: alongX ? 4 : g.h,
				color: STONE_SHADE,
				zIndex: z + 1,
			});
		}
		return true;
	}
	if (k === "court") {
		r.drawRect(cam, cx, cy, { w: g.w, h: g.h, color: COURT, zIndex: z });
		// the boundary, the half-court line and the centre circle
		r.drawRect(cam, cx, cy, {
			w: g.w - 16,
			h: g.h - 16,
			color: COURT,
			alpha: 0,
			stroke: COURT_LINE,
			strokeThickness: 2,
			zIndex: z + 1,
		});
		r.drawRect(cam, cx, cy, {
			w: alongX ? 4 : g.w - 16,
			h: alongX ? g.h - 16 : 4,
			color: COURT_LINE,
			zIndex: z + 1,
		});
		r.drawCircle(cam, cx, cy, 72, { color: COURT, alpha: 0, stroke: COURT_LINE, strokeThickness: 2, zIndex: z + 1 });
		return true;
	}
	if (k === "sandbox") {
		r.drawRect(cam, cx, cy, { w: g.w, h: g.h, color: SAND, stroke: TIMBER, strokeThickness: 4, zIndex: z });
		return true;
	}
	if (k === "pad") {
		r.drawRect(cam, cx, cy, { w: g.w, h: g.h, color: SLAB, stroke: SLAB_EDGE, strokeThickness: 3, zIndex: z });
		return true;
	}
	// a vegetable bed: dark soil, and the rows of what was planted in spring
	r.drawRect(cam, cx, cy, { w: g.w, h: g.h, color: SOIL, stroke: TIMBER, strokeThickness: 2, zIndex: z });
	const across = alongX ? g.h : g.w;
	for (let t = 16; t < across - 8; t += 24) {
		r.drawRect(cam, alongX ? cx : g.x + t, alongX ? g.y + t : cy, {
			w: alongX ? g.w - 16 : 8,
			h: alongX ? 8 : g.h - 16,
			color: SOIL_ROW,
			zIndex: z + 1,
		});
	}
	return true;
}

// ------------------------------------------------------------------ the bank (EDI-23)

/** each bank's record and portico, by the bank's id (built once per world: the town is static) */
interface BankParts {
	bank?: Solid;
	portico?: Solid;
	/** the vault's floor, for the side the door swings to */
	vault?: Rect;
}
let banksFor: WorldData | undefined;
const banks = new Map<number, BankParts>();

function bankParts(world: WorldData, id: number): BankParts | undefined {
	if (banksFor !== world) {
		banksFor = world;
		banks.clear();
		for (const s of world.solids) {
			if (s.kind === "building" && s.buildingType === 22) {
				let vault: Rect | undefined;
				for (const q of s.rooms ?? []) if (q.kind === "vault") vault = q;
				const p = banks.get(s.id) ?? {};
				p.bank = s;
				p.vault = vault;
				banks.set(s.id, p);
			} else if (isPortico(s) && s.bankId !== undefined) {
				const p = banks.get(s.bankId) ?? {};
				p.portico = s;
				banks.set(s.bankId, p);
			}
		}
	}
	return banks.get(id);
}

/** is the roof over this bank on (its inside hidden)? */
function roofOn(p: BankParts | undefined): boolean {
	return p?.bank !== undefined && (p.bank.roofAlpha ?? 1) >= 0.99;
}

/** how high the portico stands (its shadow's length: a building's is 20) */
const PORTICO_LIFT = 30;
/** the pediment's cornice along the street edge, and the alarm bell's box on it */
const CORNICE = 10;
const BELL_W = 22;
const BELL_H = 14;
/** the bell's lamp: flashes this many times a second while it rings */
const BELL_HZ = 4;

/**
 * The bank's portico (EDI-23): a pediment roof over the columns, its ridge running from the facade to the street --
 * the half towards the light lit, the other in shade -- the cornice along its street edge, and the alarm bell's red box
 * in the middle of it. While the bell rings (`powered`, the server's LightSet) its lamp flashes. See-through with a body
 * under it (`canopyAlpha`, the canopy's fade).
 */
export function drawPortico(
	r: Renderer,
	cam: Camera,
	s: Solid,
	v: ViewRect,
	shadow: ShadowFn,
	clock: number,
): void {
	if (!overlaps(s.x - 60, s.y - 60, s.w + 120, s.h + 120, v)) return;
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	const a = s.canopyAlpha ?? 1;
	const so = shadow(cx, cy, PORTICO_LIFT);
	r.drawRect(cam, cx + so.x, cy + so.y, { w: s.w, h: s.h, color: BLACK, alpha: 0.26, zIndex: Z.shadow });
	const face = s.face ?? "top";
	// the ridge runs across the facade's line: along y for a portico on a top / bottom street, along x otherwise
	const ridgeY = face === "top" || face === "bottom";
	r.drawRect(cam, cx, cy, {
		w: s.w,
		h: s.h,
		color: STONE_SHADE,
		alpha: a,
		stroke: STONE_LINE,
		strokeThickness: 2,
		strokeAlpha: a,
		zIndex: Z.roof,
	});
	// the lit slope: the left half (a ridge along y) or the top half (along x)
	r.drawRect(cam, ridgeY ? s.x + s.w / 4 : cx, ridgeY ? cy : s.y + s.h / 4, {
		w: ridgeY ? s.w / 2 - 2 : s.w - 4,
		h: ridgeY ? s.h - 4 : s.h / 2 - 2,
		color: STONE,
		alpha: a,
		zIndex: Z.roof + 1,
	});
	// the ridge cap
	r.drawRect(cam, cx, cy, {
		w: ridgeY ? 6 : s.w - 4,
		h: ridgeY ? s.h - 4 : 6,
		color: STONE_LIT,
		alpha: a,
		zIndex: Z.roof + 2,
	});
	// the cornice on the street edge
	const street = streetEdge(s, face, CORNICE);
	r.drawRect(cam, street.x + street.w / 2, street.y + street.h / 2, {
		w: street.w,
		h: street.h,
		color: STONE_LIT,
		alpha: a,
		stroke: STONE_JOINT,
		strokeThickness: 1,
		strokeAlpha: a,
		zIndex: Z.roof + 2,
	});
	// the alarm bell's box, in the middle of the cornice
	const bx = street.x + street.w / 2;
	const by = street.y + street.h / 2;
	r.drawRect(cam, bx, by, {
		w: ridgeY ? BELL_W : BELL_H,
		h: ridgeY ? BELL_H : BELL_W,
		color: BELL,
		alpha: a,
		stroke: STONE_LINE,
		strokeThickness: 2,
		strokeAlpha: a,
		cornerRadius: 3,
		zIndex: Z.roof + 3,
	});
	if (s.powered === true) {
		const on = math.floor(clock * BELL_HZ * 2) % 2 === 0;
		r.drawCircle(cam, bx, by, on ? 64 : 40, { color: BELL_LIT, alpha: on ? 0.55 : 0.3, zIndex: Z.roof + 4 });
		r.drawRect(cam, bx, by, {
			w: ridgeY ? BELL_W - 8 : BELL_H - 6,
			h: ridgeY ? BELL_H - 6 : BELL_W - 8,
			color: on ? BELL_LIT : BELL,
			zIndex: Z.roof + 5,
		});
	}
}

/** the strip `d` deep along the street edge of a rect whose street is on `face` */
function streetEdge(s: Rect, face: string, d: number): Rect {
	if (face === "top") return { x: s.x, y: s.y, w: s.w, h: d };
	if (face === "bottom") return { x: s.x, y: s.y + s.h - d, w: s.w, h: d };
	if (face === "left") return { x: s.x, y: s.y, w: d, h: s.h };
	return { x: s.x + s.w - d, y: s.y, w: d, h: s.h };
}

/**
 * A stone column of the portico, seen from above: its round capital, lit from the top left, and its shadow. Its front
 * stands out under the portico's cornice (townLots.ts BANK_PORTICO_SHOW); the rest shows while the portico is lifted.
 */
function drawColumn(r: Renderer, cam: Camera, s: Solid, shadow: ShadowFn): void {
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	const d = math.min(s.w, s.h);
	const so = shadow(cx, cy, 12);
	r.drawCircle(cam, cx + so.x, cy + so.y, d, { color: BLACK, alpha: 0.3, zIndex: Z.shadow });
	r.drawCircle(cam, cx, cy, d, { color: STONE_SHADE, stroke: STONE_LINE, strokeThickness: 2, zIndex: Z.structure });
	r.drawCircle(cam, cx - 3, cy - 3, d - 12, { color: STONE, zIndex: Z.structure + 1 });
	r.drawCircle(cam, cx - 5, cy - 5, d - 26, { color: STONE_LIT, zIndex: Z.structure + 2 });
}

/**
 * The vault's steel door (EDI-23), while the bank's roof is lifted: shut, a thick slab with its bolts and the wheel of
 * its lock; cracked, the slab swung back flat against the vault's wall beside the doorway, the doorway empty.
 */
export function drawVaultDoor(r: Renderer, cam: Camera, s: Solid, world: WorldData): void {
	const p = s.bankId !== undefined ? bankParts(world, s.bankId) : undefined;
	if (roofOn(p)) return;
	const alongX = s.w >= s.h;
	const len = alongX ? s.w : s.h;
	const thick = alongX ? s.h : s.w;
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	if (s.open === true) {
		// against the wall inside the vault, beside the doorway's low end
		const vault = p?.vault;
		const into = vault === undefined ? 1 : alongX ? (vault.y + vault.h / 2 > cy ? 1 : -1) : vault.x + vault.w / 2 > cx ? 1 : -1;
		const slab = len - 16;
		const ox = alongX ? s.x - slab / 2 - 8 : cx + into * thick;
		const oy = alongX ? cy + into * thick : s.y - slab / 2 - 8;
		r.drawRect(cam, ox, oy, {
			w: alongX ? slab : thick - 8,
			h: alongX ? thick - 8 : slab,
			color: STEEL,
			stroke: STEEL_LINE,
			strokeThickness: 2,
			zIndex: Z.structure,
		});
		return;
	}
	r.drawRect(cam, cx, cy, {
		w: s.w,
		h: s.h,
		color: STEEL,
		stroke: STEEL_LINE,
		strokeThickness: 2,
		zIndex: Z.structure,
	});
	// the lit top-left edge of the slab
	r.drawRect(cam, alongX ? cx : s.x + 4, alongX ? s.y + 4 : cy, {
		w: alongX ? s.w - 6 : 3,
		h: alongX ? 3 : s.h - 6,
		color: STEEL_LIT,
		zIndex: Z.structure + 1,
	});
	// the bolts along it, and the wheel of the lock
	for (const f of [0.2, 0.8]) {
		r.drawRect(cam, alongX ? s.x + s.w * f : cx, alongX ? cy : s.y + s.h * f, {
			w: 6,
			h: 6,
			color: STEEL_DARK,
			zIndex: Z.structure + 1,
		});
	}
	const d = math.min(thick + 4, 30);
	r.drawCircle(cam, cx, cy, d, { color: STEEL_DARK, stroke: STEEL_LINE, strokeThickness: 2, zIndex: Z.structure + 2 });
	r.drawCircle(cam, cx - 1, cy - 1, d - 12, { color: STEEL_LIT, zIndex: Z.structure + 3 });
}

/** the vault's deposit boxes: a steel wall of small doors, two rows of them, while the bank's roof is lifted */
function drawDepositBoxes(r: Renderer, cam: Camera, s: Solid, world: WorldData, shadow: ShadowFn): void {
	const p = s.bankId !== undefined ? bankParts(world, s.bankId) : undefined;
	if (roofOn(p)) return;
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	const so = shadow(cx, cy, 8);
	r.drawRect(cam, cx + so.x, cy + so.y, { w: s.w, h: s.h, color: BLACK, alpha: 0.3, zIndex: Z.shadow });
	r.drawRect(cam, cx, cy, { w: s.w, h: s.h, color: STEEL, stroke: STEEL_LINE, strokeThickness: 2, zIndex: Z.structure });
	const alongX = s.w >= s.h;
	const len = alongX ? s.w : s.h;
	// the row line along the middle, and a door every BOX_PITCH across it
	r.drawRect(cam, cx, cy, { w: alongX ? s.w - 4 : 2, h: alongX ? 2 : s.h - 4, color: STEEL_DARK, zIndex: Z.structure + 1 });
	for (let t = BOX_PITCH; t < len - 4; t += BOX_PITCH) {
		r.drawRect(cam, alongX ? s.x + t : cx, alongX ? cy : s.y + t, {
			w: alongX ? 2 : s.w - 4,
			h: alongX ? s.h - 4 : 2,
			color: STEEL_DARK,
			zIndex: Z.structure + 1,
		});
	}
	// the lit top-left edge
	r.drawRect(cam, alongX ? cx : s.x + 3, alongX ? s.y + 3 : cy, {
		w: alongX ? s.w - 6 : 2,
		h: alongX ? 2 : s.h - 6,
		color: STEEL_LIT,
		zIndex: Z.structure + 2,
	});
}
/** one deposit box's door, along the wall */
const BOX_PITCH = 24;

/** the bank's parapet: the stone coping's width round the roof */
const PARAPET = 10;

/**
 * The bank's roof (EDI-23), with the signage in both drawings: the stone parapet round it (lit on the top and left
 * edges, its inner joint in shade) and, over the banking hall, the laylight of dark glass in its stone frame.
 */
export function drawBankRoof(r: Renderer, cam: Camera, v: ViewRect, s: Solid, a: number): void {
	if (!overlaps(s.x, s.y, s.w, s.h, v)) return;
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	// the parapet's coping: lit along the top and the left, in shade along the bottom and the right
	const P = PARAPET;
	const z = Z.roof + 2;
	r.drawRect(cam, cx, s.y + P / 2, { w: s.w, h: P, color: STONE_LIT, alpha: a, zIndex: z });
	r.drawRect(cam, s.x + P / 2, cy + P / 2, { w: P, h: s.h - P, color: STONE_LIT, alpha: a, zIndex: z });
	r.drawRect(cam, cx + P / 2, s.y + s.h - P / 2, { w: s.w - P, h: P, color: STONE_SHADE, alpha: a, zIndex: z });
	r.drawRect(cam, s.x + s.w - P / 2, cy, { w: P, h: s.h - P * 2, color: STONE_SHADE, alpha: a, zIndex: z });
	// the joint where the coping meets the roof
	r.drawRect(cam, cx, cy, {
		w: s.w - P * 2,
		h: s.h - P * 2,
		color: STONE,
		alpha: 0,
		stroke: STONE_JOINT,
		strokeThickness: 2,
		strokeAlpha: a,
		zIndex: z,
	});
	let hall: Rect | undefined;
	for (const q of s.rooms ?? []) if (q.kind === "lobby" && (hall === undefined || q.w * q.h > hall.w * hall.h)) hall = q;
	if (hall === undefined) return;
	const hx = hall.x + hall.w / 2;
	const hy = hall.y + hall.h / 2;
	const gw = math.min(hall.w * 0.5, 280);
	const gh = math.min(hall.h * 0.45, 120);
	r.drawRect(cam, hx, hy, {
		w: gw,
		h: gh,
		color: GLASS,
		alpha: a,
		stroke: STONE_JOINT,
		strokeThickness: 4,
		strokeAlpha: a,
		zIndex: Z.roof + 3,
	});
	// its glazing bars, and the sky caught in the top-left panes
	const wide = gw >= gh;
	r.drawRect(cam, hx, hy, { w: wide ? gw : 3, h: wide ? 3 : gh, color: STONE_JOINT, alpha: a, zIndex: Z.roof + 4 });
	for (const f of [-0.25, 0.25]) {
		r.drawRect(cam, wide ? hx + gw * f : hx, wide ? hy : hy + gh * f, {
			w: wide ? 3 : gw,
			h: wide ? gh : 3,
			color: STONE_JOINT,
			alpha: a,
			zIndex: Z.roof + 4,
		});
	}
	r.drawRect(cam, hx - gw / 4 - (wide ? gw / 8 : 0), hy - gh / 4, {
		w: wide ? gw / 4 - 8 : gw / 2 - 8,
		h: wide ? gh / 2 - 8 : gh / 4 - 8,
		color: GLASS_LIT,
		alpha: a * 0.6,
		zIndex: Z.roof + 4,
	});
}

// ------------------------------------------------------------------ fixtures ("prop" solids)

/**
 * A fixture of the everyday town (townLots.ts): the bank's columns and deposit boxes so far; false for anything else
 * (the campus quad's fountain, statue and benches: worldView's own `drawProp`).
 */
export function drawTownProp(r: Renderer, cam: Camera, s: Solid, world: WorldData, shadow: ShadowFn): boolean {
	const t = s.tags;
	if (t === "column") {
		drawColumn(r, cam, s, shadow);
		return true;
	}
	if (isVaultBox(s)) {
		drawDepositBoxes(r, cam, s, world, shadow);
		return true;
	}
	return false;
}

/** is this solid the bank's vault door (worldView draws it here instead of as a built door)? */
export function vaultDoorSolid(s: Solid): boolean {
	return isVaultDoor(s);
}
