/*
 * The everyday town, drawn (docs/DESIGN_RULES.md EDI-19..EDI-24, MOB-04..MOB-06; laid out by shared/game/townLots.ts):
 * the ground it adds -- the bank's steps, a court, a sand pit, a poured slab, a vegetable bed -- the bank's portico,
 * columns, vault door, deposit boxes and roof, and the fixtures of the streets, the parks and the backyards.
 *
 * With the town's fixtures' atlas (ART-16, ./townPropArt.ts) every fixture, the market's tents, the shelter's roof
 * and the ground here are its pixel art; without it (ART-01), and for what stays out of it -- the bank's portico,
 * roof, vault door and boxes -- Frames: lit from the top left like the rest of the town (LUZ-01), a dark outline,
 * three tones, a shadow on the sun's side. Every colour is a module constant (the renderer's write cache keys on the
 * Color3's identity), and what is inside a building (the vault door, the boxes) is drawn only while its roof is
 * lifted.
 *
 * worldView.ts hands over: `drawTownGround` first for every ground rect, `drawTownProp` for a "prop" solid before the
 * campus's, `drawPortico` for the bank's canopy, `drawVaultDoor` for its door, `drawBankRoof` with the signage.
 */
import { COLORS, Z } from "shared/engine/colors";
import { Camera, ViewRect } from "shared/engine/camera";
import { Renderer } from "shared/engine/renderer";
import { CRATE_STACKED, CRATE_TIPPED, TENT_DOWN, TENT_SAGGING, TENT_TORN } from "shared/game/townLots";
import type { GroundRect, Rect, Solid, WorldData } from "shared/game/world";
import { isPortico, isVaultBox, isVaultDoor } from "shared/sim/vault";
import { overlaps } from "./drawKit";
import { drawCanopyArt, drawGroundArt, drawPropArt, ShadowFn } from "./townPropArt";

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
/** a court's key under each hoop (its paint a shade darker), and its size */
const COURT_KEY = Color3.fromRGB(150, 84, 64);
const KEY_WIDE = 96;
const KEY_DEEP = 112;
/**
 * The street market's litter (EDI-21, APO-01): produce a shade darker and a size smaller than any item's icon on the
 * ground (LEG-03: nothing here reads as something to pick up), paper, a kraft shopping bag
 */
const APPLE = Color3.fromRGB(138, 40, 34);
const ORANGE = Color3.fromRGB(176, 102, 34);
const CABBAGE = Color3.fromRGB(84, 116, 56);
const PRODUCE: ReadonlyArray<Color3> = [APPLE, ORANGE, CABBAGE];
const LITTER_PAPER = Color3.fromRGB(198, 192, 174);
const KRAFT = Color3.fromRGB(162, 124, 80);
const KRAFT_SHADE = Color3.fromRGB(120, 88, 56);
/** a spill's three pieces of produce: where (shares of the rect) and how big */
const SPILL_AT: ReadonlyArray<[number, number, number]> = [
	[-0.3, -0.2, 10],
	[0.05, 0.25, 12],
	[0.32, -0.12, 10],
];

/** a litter rect's own pick of `n` (from its corner: the same every frame and on every client) */
function litterPick(g: Rect, n: number): number {
	return math.floor(math.abs(g.x * 0.37 + g.y * 0.61) / 8) % n;
}

/** what the market's crowd dropped: a spill of produce, two sheets of paper, a shopping bag on its side */
function drawLitter(r: Renderer, cam: Camera, g: GroundRect): void {
	const cx = g.x + g.w / 2;
	const cy = g.y + g.h / 2;
	const z = Z.ground + 4;
	const p = litterPick(g, 3);
	if (g.kind === "paper") {
		r.drawRect(cam, cx - g.w * 0.2, cy - g.h * 0.15, {
			w: 16,
			h: 12,
			rotation: 0.35 + p * 0.3,
			color: LITTER_PAPER,
			alpha: 0.9,
			zIndex: z,
		});
		r.drawRect(cam, cx + g.w * 0.22, cy + g.h * 0.18, {
			w: 14,
			h: 11,
			rotation: -0.5 - p * 0.2,
			color: LITTER_PAPER,
			alpha: 0.85,
			zIndex: z,
		});
		return;
	}
	if (g.kind === "bag") {
		const rot = 0.3 + p * 0.4;
		r.drawRect(cam, cx, cy, { w: 24, h: 16, rotation: rot, color: KRAFT, zIndex: z });
		r.drawRect(cam, cx + math.cos(rot) * 10, cy + math.sin(rot) * 10, {
			w: 5,
			h: 16,
			rotation: rot,
			color: KRAFT_SHADE,
			zIndex: z + 1,
		});
		r.drawCircle(cam, cx + math.cos(rot) * 20, cy + math.sin(rot) * 20 + 4, 10, {
			color: PRODUCE[p],
			zIndex: z,
		});
		return;
	}
	for (let i = 0; i < SPILL_AT.size(); i++) {
		const [fx, fy, d] = SPILL_AT[i];
		const c = PRODUCE[(p + i) % 3];
		r.drawCircle(cam, cx + g.w * fx, cy + g.h * fy, c === CABBAGE ? d + 3 : d, { color: c, zIndex: z });
	}
}

/** a building site's bare earth, and the ruts the trucks left */
const EARTH = Color3.fromRGB(128, 100, 72);
const EARTH_RUT = Color3.fromRGB(104, 80, 58);

// ------------------------------------------------------------------ ground

/** the bank's steps: a riser every this far across them (four steps from the sidewalk to the portico) */
const STEP = 24;

/**
 * The everyday town's own ground kinds; false for any other (worldView draws it). Flat in both drawings: a stone step
 * reads by its risers, a court by its lines, a sand pit by its timber edge.
 */
export function drawTownGround(r: Renderer, cam: Camera, g: GroundRect, v: ViewRect): boolean {
	const k = g.kind;
	if (k === "spill" || k === "paper" || k === "bag") {
		if (overlaps(g.x, g.y, g.w, g.h, v) && !drawGroundArt(r, cam, g)) drawLitter(r, cam, g);
		return true;
	}
	if (k !== "steps" && k !== "court" && k !== "sandbox" && k !== "pad" && k !== "garden" && k !== "site") {
		return false;
	}
	if (!overlaps(g.x, g.y, g.w, g.h, v) || drawGroundArt(r, cam, g)) return true;
	const cx = g.x + g.w / 2;
	const cy = g.y + g.h / 2;
	const z = Z.ground + 3;
	const alongX = g.w >= g.h;
	if (k === "site") {
		// the building site's churned earth
		r.drawRect(cam, cx, cy, { w: g.w, h: g.h, color: EARTH, stroke: EARTH_RUT, strokeThickness: 3, zIndex: z });
		return true;
	}
	if (k === "steps") {
		// the stone, its joint round it, and each step's edge: the lit nosing, the riser's shadow under it
		r.drawRect(cam, cx, cy, { w: g.w, h: g.h, color: STONE, stroke: STONE_JOINT, strokeThickness: 2, zIndex: z });
		const across = alongX ? g.h : g.w;
		for (let t = STEP; t < across; t += STEP) {
			r.drawRect(cam, alongX ? cx : g.x + t - 4, alongX ? g.y + t - 4 : cy, {
				w: alongX ? g.w - 4 : 3,
				h: alongX ? 3 : g.h - 4,
				color: STONE_LIT,
				zIndex: z + 1,
			});
			r.drawRect(cam, alongX ? cx : g.x + t, alongX ? g.y + t : cy, {
				w: alongX ? g.w - 4 : 5,
				h: alongX ? 5 : g.h - 4,
				color: STONE_JOINT,
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
		r.drawCircle(cam, cx, cy, 72, {
			color: COURT,
			alpha: 0,
			stroke: COURT_LINE,
			strokeThickness: 2,
			zIndex: z + 1,
		});
		// the keys under the two hoops
		const len = alongX ? g.w : g.h;
		for (const sgn of [-1, 1]) {
			const off = sgn * (len / 2 - 8 - KEY_DEEP / 2);
			r.drawRect(cam, alongX ? cx + off : cx, alongX ? cy : cy + off, {
				w: alongX ? KEY_DEEP : KEY_WIDE,
				h: alongX ? KEY_WIDE : KEY_DEEP,
				color: COURT_KEY,
				stroke: COURT_LINE,
				strokeThickness: 2,
				zIndex: z + 1,
			});
		}
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

// ------------------------------------------------------------------ the bank (EDI-24)

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
 * The bank's portico (EDI-24): a pediment roof over the columns, its ridge running from the facade to the street --
 * the half towards the light lit, the other in shade -- the cornice along its street edge, and the alarm bell's red box
 * in the middle of it. While the bell rings (`powered`, the server's LightSet) its lamp flashes. See-through with a body
 * under it (`canopyAlpha`, the canopy's fade).
 */
export function drawPortico(r: Renderer, cam: Camera, s0: Solid, v: ViewRect, shadow: ShadowFn, clock: number): void {
	if (!overlaps(s0.x - 60, s0.y - 60, s0.w + 120, s0.h + 120, v)) return;
	const face = s0.face ?? "top";
	// drawn PORTICO_TRIM short of its street edge: the colonnade shows under the cornice (aerial: nothing collides)
	const s = trimmed(s0, face, PORTICO_TRIM);
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	const a = s0.canopyAlpha ?? 1;
	const so = shadow(cx, cy, PORTICO_LIFT);
	r.drawRect(cam, cx + so.x, cy + so.y, { w: s.w, h: s.h, color: BLACK, alpha: 0.26, zIndex: Z.shadow });
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
	// the frieze just behind the cornice: its line of shadow, where a real one's dentils would be
	const frieze = streetEdge(trimmed(s, face, CORNICE), face, 4);
	r.drawRect(cam, frieze.x + frieze.w / 2, frieze.y + frieze.h / 2, {
		w: frieze.w,
		h: frieze.h,
		color: STONE_JOINT,
		alpha: a,
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
	if (s0.powered === true) {
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

/**
 * How much of the portico's roof is left out on its street side when drawn: with it, the colonnade's front half shows
 * under the cornice (EDI-24: from the street, with the roof on, the bank reads by its columns and its steps)
 */
const PORTICO_TRIM = 10;

/** `s` without the strip `d` deep on its street side (`face`) */
function trimmed(s: Rect, face: string, d: number): Rect {
	if (face === "top") return { x: s.x, y: s.y + d, w: s.w, h: s.h - d };
	if (face === "bottom") return { x: s.x, y: s.y, w: s.w, h: s.h - d };
	if (face === "left") return { x: s.x + d, y: s.y, w: s.w - d, h: s.h };
	return { x: s.x, y: s.y, w: s.w - d, h: s.h };
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
 * The vault's steel door (EDI-24), while the bank's roof is lifted: shut, a thick slab with its bolts and the wheel of
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
		const into =
			vault === undefined
				? 1
				: alongX
					? vault.y + vault.h / 2 > cy
						? 1
						: -1
					: vault.x + vault.w / 2 > cx
						? 1
						: -1;
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
	r.drawCircle(cam, cx, cy, d, {
		color: STEEL_DARK,
		stroke: STEEL_LINE,
		strokeThickness: 2,
		zIndex: Z.structure + 2,
	});
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
	r.drawRect(cam, cx, cy, {
		w: s.w,
		h: s.h,
		color: STEEL,
		stroke: STEEL_LINE,
		strokeThickness: 2,
		zIndex: Z.structure,
	});
	const alongX = s.w >= s.h;
	const len = alongX ? s.w : s.h;
	// the row line along the middle, and a door every BOX_PITCH across it
	r.drawRect(cam, cx, cy, {
		w: alongX ? s.w - 4 : 2,
		h: alongX ? 2 : s.h - 4,
		color: STEEL_DARK,
		zIndex: Z.structure + 1,
	});
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
 * The bank's roof (EDI-24), with the signage in both drawings: the stone parapet round it (lit on the top and left
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
	for (const q of s.rooms ?? []) {
		if (q.kind === "lobby" && (hall === undefined || q.w * q.h > hall.w * hall.h)) hall = q;
	}
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

/** the outline every fixture wears (the storefront signs' `k`), and the shadow's darkness */
const INK = Color3.fromRGB(26, 24, 28);
const SHADOW_A = 0.28;

/** wood: a trestle table, a crate, a shed's boards, a picnic table */
const WOOD_LIT = Color3.fromRGB(196, 158, 108);
const WOOD = Color3.fromRGB(158, 118, 76);
const WOOD_SHADE = Color3.fromRGB(112, 80, 50);
/** the lit edge of a crate stacked on another (the light reaches it first) */
const WOOD_TOP = WOOD_LIT.Lerp(WHITE, 0.2);
/** painted and galvanised metal */
const GALV = Color3.fromRGB(150, 156, 160);
const GALV_LIT = Color3.fromRGB(196, 200, 204);
const IRON = Color3.fromRGB(58, 60, 66);
/** what a market stall sells: produce, bread and preserves, cloth and leather (spawns.ts YARD_LOOT `stall0..2`) */
const WARES: ReadonlyArray<[Color3, Color3]> = [
	[Color3.fromRGB(196, 58, 44), Color3.fromRGB(104, 160, 60)],
	[Color3.fromRGB(214, 170, 96), Color3.fromRGB(170, 96, 58)],
	[Color3.fromRGB(96, 92, 158), Color3.fromRGB(150, 110, 70)],
];
/** a tent's canvas: faded white, and its stripes in one of three colours */
const CANVAS = Color3.fromRGB(226, 222, 206);
const CANVAS_SHADE = Color3.fromRGB(178, 172, 156);
const TENT_STRIPES: ReadonlyArray<Color3> = [
	Color3.fromRGB(182, 58, 52),
	Color3.fromRGB(52, 102, 162),
	Color3.fromRGB(62, 130, 82),
];
/** the food truck: its white body, its windscreen, its striped awning */
const TRUCK_BODY = Color3.fromRGB(230, 226, 212);
const TRUCK_SHADE = Color3.fromRGB(184, 180, 166);
const GLASS_DARK = Color3.fromRGB(46, 58, 70);
/** the building site: the pile's lumber, bricks and steel; the toilet's blue, the mixer's orange, the dumpster's green */
const BRICK = Color3.fromRGB(160, 78, 58);
const BRICK_LIT = Color3.fromRGB(196, 110, 84);
const STEEL_BAR = Color3.fromRGB(110, 116, 124);
const TOILET_BLUE = Color3.fromRGB(58, 104, 168);
const MIXER_ORANGE = Color3.fromRGB(214, 120, 40);
const DUMPSTER_GREEN = Color3.fromRGB(56, 96, 68);
/** the playground's paint: the swings' frame, the slide, the climbing frame, a spring rider */
const PLAY_RED = Color3.fromRGB(196, 62, 50);
const PLAY_YELLOW = Color3.fromRGB(226, 184, 58);
const PLAY_BLUE = Color3.fromRGB(62, 116, 186);
const RUBBER = Color3.fromRGB(34, 34, 38);
/** the lit tones of those (built once: the renderer's write cache keys on the Color3) */
const BRICK_JOINT = BRICK.Lerp(INK, 0.35);
const TOILET_LIT = TOILET_BLUE.Lerp(WHITE, 0.3);
const DUMPSTER_LIT = DUMPSTER_GREEN.Lerp(WHITE, 0.25);
const PLAY_YELLOW_LIT = PLAY_YELLOW.Lerp(WHITE, 0.35);
const SPRINGER_LIT = WHITE.Lerp(PLAY_YELLOW, 0.4);
/** a hoop's backboard and rim */
const BOARD_WHITE = Color3.fromRGB(232, 232, 226);
const RIM_ORANGE = Color3.fromRGB(222, 110, 38);
/** the street: a lamp's pole and head, a hydrant, a mailbox, the blue collection box, a bus stop's sign */
const LAMP_HEAD = Color3.fromRGB(88, 92, 98);
const HYDRANT_RED = Color3.fromRGB(190, 52, 42);
const HYDRANT_CAP = Color3.fromRGB(226, 196, 70);
const MAIL_FLAG = Color3.fromRGB(200, 50, 44);
const POST_BLUE = Color3.fromRGB(44, 72, 136);
const POST_BLUE_LIT = Color3.fromRGB(78, 108, 172);
const SIGN_BLUE = Color3.fromRGB(44, 92, 164);
/** a bus shelter's roof: smoked glass on a steel frame */
const SHELTER_GLASS = Color3.fromRGB(120, 150, 164);
/** the backyards: a shed's roof, a pool's water and coping, a trampoline's mat and pads, a grill */
const SHED_ROOF = Color3.fromRGB(96, 104, 96);
const SHED_ROOF_LIT = Color3.fromRGB(128, 138, 128);
const WATER = Color3.fromRGB(64, 152, 196);
const WATER_LIT = Color3.fromRGB(120, 196, 226);
const COPING = Color3.fromRGB(220, 216, 204);
const PAD_BLUE = Color3.fromRGB(56, 110, 180);

/** what the tent over each market stall is (a stall's table and crates show only while their tent is lifted) */
let tentsFor: WorldData | undefined;
const coveredBy = new Map<Solid, Solid>();

function tentOver(world: WorldData, s: Solid): Solid | undefined {
	if (tentsFor !== world) {
		tentsFor = world;
		coveredBy.clear();
		const tents: Array<Solid> = [];
		for (const q of world.solids) if (q.kind === "canopy" && q.tags === "tent") tents.push(q);
		for (const q of world.solids) {
			if (q.kind !== "prop" || (q.tags !== "stall" && q.tags !== "crates" && q.tags !== "trestle")) continue;
			const cx = q.x + q.w / 2;
			const cy = q.y + q.h / 2;
			for (const t of tents) {
				if (cx >= t.x && cx <= t.x + t.w && cy >= t.y && cy <= t.y + t.h) {
					coveredBy.set(q, t);
					break;
				}
			}
		}
	}
	return coveredBy.get(s);
}

/** a market tent's state (townLots.ts TENT_STANDING .. TENT_DOWN): `variant` is its stripe colour + 3 × state */
function tentState(s: Solid): number {
	return math.floor((s.variant ?? 0) / 3);
}

/** does this tent hide what stands under it (it stands, and nobody is under it)? */
function tentHides(tent: Solid | undefined): boolean {
	return tent !== undefined && tentState(tent) !== TENT_DOWN && (tent.canopyAlpha ?? 1) >= 0.99;
}

/** a tipped crate's turn on its side (radians), and the way its open top faces */
const TIP = 0.35;
const TIP_NX = -math.sin(TIP);
const TIP_NY = math.cos(TIP);

/** a crate, two stacked, or one tipped over with its produce rolling out (townLots.ts CRATE_ONE .. CRATE_TIPPED) */
function drawCrates(r: Renderer, cam: Camera, s: Solid, shadow: ShadowFn): void {
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	const v = s.variant ?? 0;
	if (v === CRATE_TIPPED) {
		const so = shadow(cx, cy, 4);
		r.drawRect(cam, cx + so.x, cy + so.y, {
			w: s.w - 6,
			h: s.h - 12,
			rotation: TIP,
			color: BLACK,
			alpha: SHADOW_A,
			zIndex: Z.shadow,
		});
		r.drawRect(cam, cx, cy, {
			w: s.w - 6,
			h: s.h - 12,
			rotation: TIP,
			color: WOOD,
			stroke: INK,
			strokeThickness: 2,
			strokeAlpha: 0.8,
			zIndex: Z.structure,
		});
		// its open top, dark inside, and an apple and a cabbage that rolled out of it
		const o = (s.h - 12) / 2 - 4;
		r.drawRect(cam, cx + TIP_NX * o, cy + TIP_NY * o, {
			w: s.w - 12,
			h: 6,
			rotation: TIP,
			color: WOOD_SHADE,
			zIndex: Z.structure + 1,
		});
		r.drawCircle(cam, cx + TIP_NX * (o + 10) - 8, cy + TIP_NY * (o + 10), 10, {
			color: APPLE,
			zIndex: Z.structure + 1,
		});
		r.drawCircle(cam, cx + TIP_NX * (o + 14) + 10, cy + TIP_NY * (o + 12), 13, {
			color: CABBAGE,
			zIndex: Z.structure + 1,
		});
		return;
	}
	const wide = s.w >= s.h;
	box(r, cam, s, WOOD, WOOD_LIT, v === CRATE_STACKED ? 10 : 0, shadow);
	r.drawRect(cam, cx, cy, {
		w: wide ? 4 : s.w - 8,
		h: wide ? s.h - 8 : 4,
		color: WOOD_SHADE,
		zIndex: Z.structure + 2,
	});
	if (v === CRATE_STACKED) {
		// a second one on top, a size smaller and off-square: the lit one
		box(
			r,
			cam,
			{ x: s.x + 3, y: s.y + 2, w: s.w - 12, h: s.h - 12 },
			WOOD_LIT,
			WOOD_TOP,
			0,
			shadow,
			0,
			Z.structure + 3,
		);
		r.drawRect(cam, cx - 3, cy - 4, {
			w: wide ? 4 : s.w - 20,
			h: wide ? s.h - 20 : 4,
			color: WOOD,
			zIndex: Z.structure + 5,
		});
	}
}

/**
 * A trestle table knocked over in the rush (EDI-21): its top's underside, the two trestles sticking up at its ends,
 * the cloth half off it on the aisle side (its wares are the spill in front of it: townLots.ts).
 */
function drawTrestle(r: Renderer, cam: Camera, s: Solid, shadow: ShadowFn): void {
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	const wide = s.w >= s.h;
	box(r, cam, s, WOOD_SHADE, undefined, 2, shadow);
	for (const f of [-0.33, 0.33]) {
		r.drawRect(cam, wide ? cx + s.w * f : cx, wide ? cy : cy + s.h * f, {
			w: wide ? 6 : s.w - 8,
			h: wide ? s.h - 8 : 6,
			color: WOOD_LIT,
			stroke: INK,
			strokeThickness: 1,
			zIndex: Z.structure + 2,
		});
	}
	const n = sideN(s.face);
	r.drawRect(cam, cx + n.x * 16 + (wide ? s.w * 0.12 : 0), cy + n.y * 16 + (wide ? 0 : s.h * 0.12), {
		w: wide ? s.w * 0.55 : s.w - 4,
		h: wide ? s.h - 4 : s.h * 0.55,
		rotation: (s.variant ?? 0) === 1 ? -0.22 : 0.18,
		color: CANVAS_SHADE,
		stroke: INK,
		strokeThickness: 1,
		strokeAlpha: 0.6,
		zIndex: Z.structure + 1,
	});
}

/** the hand cart a vendor left in an aisle: its bed, the wheels at its sides, the handle at its `face` end */
function drawCart(r: Renderer, cam: Camera, s: Solid, shadow: ShadowFn): void {
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	const wide = s.w >= s.h;
	const n = sideN(s.face);
	const len = wide ? s.w : s.h;
	const bed = len - 24;
	const bx = cx - n.x * 12;
	const by = cy - n.y * 12;
	const bedRect: Rect = wide
		? { x: bx - bed / 2, y: s.y + 4, w: bed, h: s.h - 8 }
		: { x: s.x + 4, y: by - bed / 2, w: s.w - 8, h: bed };
	for (const sgn of [-1, 1]) {
		r.drawRect(cam, wide ? bx : cx + sgn * (s.w / 2 - 3), wide ? cy + sgn * (s.h / 2 - 3) : by, {
			w: wide ? 18 : 6,
			h: wide ? 6 : 18,
			color: RUBBER,
			zIndex: Z.structure,
		});
	}
	box(r, cam, bedRect, WOOD, WOOD_LIT, 6, shadow, 0, Z.structure + 1);
	r.drawRect(cam, cx + n.x * (len / 2 - 6), cy + n.y * (len / 2 - 6), {
		w: wide ? 4 : s.w - 10,
		h: wide ? s.h - 10 : 4,
		color: IRON,
		zIndex: Z.structure + 1,
	});
	if ((s.variant ?? 0) === 1) {
		box(r, cam, { x: bx - 14, y: by - 14, w: 28, h: 28 }, WOOD_LIT, undefined, 0, shadow, 0, Z.structure + 3);
	}
}

/** a box of the town: its shadow on the sun's side (`lift` long), the body with its outline, a lit top edge */
function box(
	r: Renderer,
	cam: Camera,
	s: Rect,
	body: Color3,
	lit: Color3 | undefined,
	lift: number,
	shadow: ShadowFn,
	corner = 0,
	z = Z.structure,
): void {
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	if (lift > 0) {
		const so = shadow(cx, cy, lift);
		r.drawRect(cam, cx + so.x, cy + so.y, {
			w: s.w,
			h: s.h,
			color: BLACK,
			alpha: SHADOW_A,
			cornerRadius: corner,
			zIndex: Z.shadow,
		});
	}
	r.drawRect(cam, cx, cy, {
		w: s.w,
		h: s.h,
		color: body,
		stroke: INK,
		strokeThickness: 2,
		strokeAlpha: 0.8,
		cornerRadius: corner,
		zIndex: z,
	});
	if (lit !== undefined) {
		const wide = s.w >= s.h;
		r.drawRect(cam, wide ? cx : s.x + 4, wide ? s.y + 4 : cy, {
			w: wide ? s.w - 6 : 3,
			h: wide ? 3 : s.h - 6,
			color: lit,
			zIndex: z + 1,
		});
	}
}

/** the outward normal of a side */
function sideN(side: string | undefined): { x: number; y: number } {
	if (side === "top") return { x: 0, y: -1 };
	if (side === "bottom") return { x: 0, y: 1 };
	if (side === "left") return { x: -1, y: 0 };
	return { x: 1, y: 0 };
}

/**
 * A fixture of the everyday town (townLots.ts); false for anything else (the campus quad's fountain and statue and
 * every bench: worldView's own `drawProp`, which draws a bench the way the campus's are drawn).
 */
export function drawTownProp(r: Renderer, cam: Camera, s: Solid, world: WorldData, shadow: ShadowFn): boolean {
	const t = s.tags;
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	const wide = s.w >= s.h;
	const k = s.variant ?? 0;
	if (isVaultBox(s)) {
		drawDepositBoxes(r, cam, s, world, shadow);
		return true;
	}
	// under a standing market tent nobody is under, nothing shows; under a tent that came down, all of it does
	const market = t === "stall" || t === "crates" || t === "trestle";
	if (market && tentHides(tentOver(world, s))) return true;
	// the town's pixel art (ART-16), the bench included; the flat drawing below without it (ART-01)
	if (drawPropArt(r, cam, s, world, shadow)) return true;
	if (t === "column") {
		drawColumn(r, cam, s, shadow);
		return true;
	}
	// ---- the street market (EDI-21)
	if (market) {
		if (t === "crates") {
			drawCrates(r, cam, s, shadow);
			return true;
		}
		if (t === "trestle") {
			drawTrestle(r, cam, s, shadow);
			return true;
		}
		// the table, its cloth, and what is still on it
		box(r, cam, s, WOOD, undefined, 0, shadow);
		const [a, b] = WARES[k % 3];
		r.drawRect(cam, cx, cy, { w: s.w - 10, h: s.h - 10, color: CANVAS_SHADE, zIndex: Z.structure + 1 });
		r.drawRect(cam, cx - (wide ? s.w / 5 : 0), cy - (wide ? 0 : s.h / 5), {
			w: wide ? s.w / 3 : s.w - 18,
			h: wide ? s.h - 18 : s.h / 3,
			color: a,
			cornerRadius: 4,
			zIndex: Z.structure + 2,
		});
		r.drawRect(cam, cx + (wide ? s.w / 4 : 0), cy + (wide ? 0 : s.h / 4), {
			w: wide ? s.w / 4 : s.w - 20,
			h: wide ? s.h - 20 : s.h / 4,
			color: b,
			cornerRadius: 4,
			zIndex: Z.structure + 2,
		});
		return true;
	}
	if (t === "handcart") {
		drawCart(r, cam, s, shadow);
		return true;
	}
	if (t === "foodtruck") {
		// the body, the cab's windscreen at the front (`face`), the roof vent, the serving hatch's awning on its side
		box(r, cam, s, TRUCK_BODY, TRUCK_SHADE, 10, shadow, 6);
		const n = sideN(s.face);
		const len = wide ? s.w : s.h;
		r.drawRect(cam, cx + n.x * (len / 2 - 22), cy + n.y * (len / 2 - 22), {
			w: wide ? 14 : s.w - 16,
			h: wide ? s.h - 16 : 14,
			color: GLASS_DARK,
			zIndex: Z.structure + 2,
		});
		r.drawRect(cam, cx - n.x * 20, cy - n.y * 20, {
			w: 24,
			h: 24,
			color: TRUCK_SHADE,
			stroke: INK,
			strokeThickness: 1,
			zIndex: Z.structure + 2,
		});
		r.drawRect(cam, wide ? cx - n.x * 20 : s.x - 10, wide ? s.y - 10 : cy - n.y * 20, {
			w: wide ? len * 0.45 : 16,
			h: wide ? 16 : len * 0.45,
			color: TENT_STRIPES[0],
			stroke: INK,
			strokeThickness: 1,
			zIndex: Z.structure + 3,
		});
		return true;
	}
	// ---- the building site (EDI-22)
	if (t === "fence") {
		r.drawRect(cam, cx, cy, { w: s.w, h: s.h, color: GALV, stroke: IRON, strokeThickness: 1, zIndex: Z.structure });
		r.drawRect(cam, cx, cy, { w: wide ? s.w : 2, h: wide ? 2 : s.h, color: GALV_LIT, zIndex: Z.structure + 1 });
		return true;
	}
	if (t === "studs") {
		box(r, cam, s, WOOD_LIT, undefined, 4, shadow);
		return true;
	}
	if (t === "scaffold") {
		// the planks between two runs of tube
		box(r, cam, s, WOOD, undefined, 14, shadow);
		r.drawRect(cam, cx, cy, {
			w: s.w,
			h: s.h,
			color: GALV,
			alpha: 0,
			stroke: GALV_LIT,
			strokeThickness: 3,
			zIndex: Z.structure + 1,
		});
		return true;
	}
	if (t === "pile") {
		if (k === 1) {
			box(r, cam, s, BRICK, BRICK_LIT, 6, shadow);
		} else if (k === 2) {
			box(r, cam, s, STEEL_BAR, GALV_LIT, 4, shadow);
		} else {
			box(r, cam, s, WOOD, WOOD_LIT, 6, shadow);
		}
		// the stack's rows
		for (const f of [-0.2, 0.2]) {
			r.drawRect(cam, wide ? cx : cx + s.w * f, wide ? cy + s.h * f : cy, {
				w: wide ? s.w - 8 : 2,
				h: wide ? 2 : s.h - 8,
				color: k === 1 ? BRICK_JOINT : WOOD_SHADE,
				zIndex: Z.structure + 2,
			});
		}
		return true;
	}
	if (t === "portapotty") {
		box(r, cam, s, TOILET_BLUE, TOILET_LIT, 16, shadow, 4);
		r.drawRect(cam, cx, cy, { w: 12, h: 12, color: CANVAS, cornerRadius: 6, zIndex: Z.structure + 2 });
		return true;
	}
	if (t === "mixer") {
		box(r, cam, s, IRON, undefined, 6, shadow, 4);
		r.drawCircle(cam, cx - 2, cy - 2, s.w - 14, {
			color: MIXER_ORANGE,
			stroke: INK,
			strokeThickness: 2,
			zIndex: Z.structure + 1,
		});
		return true;
	}
	if (t === "dumpster") {
		box(r, cam, s, DUMPSTER_GREEN, DUMPSTER_LIT, 12, shadow, 3);
		r.drawRect(cam, cx, cy, { w: wide ? 3 : s.w - 6, h: wide ? s.h - 6 : 3, color: INK, zIndex: Z.structure + 2 });
		return true;
	}
	// ---- the parks (MOB-05)
	if (t === "swings") {
		// the top bar end to end, the A-frame's feet, three seats hanging from it
		const so = shadow(cx, cy, 18);
		r.drawRect(cam, cx + so.x, cy + so.y, {
			w: wide ? s.w : 4,
			h: wide ? 4 : s.h,
			color: BLACK,
			alpha: SHADOW_A,
			zIndex: Z.shadow,
		});
		r.drawRect(cam, cx, cy, {
			w: wide ? s.w : 6,
			h: wide ? 6 : s.h,
			color: PLAY_RED,
			stroke: INK,
			strokeThickness: 1,
			zIndex: Z.structure + 1,
		});
		for (const e of [-1, 1]) {
			r.drawRect(cam, wide ? cx + e * (s.w / 2 - 4) : cx, wide ? cy : cy + e * (s.h / 2 - 4), {
				w: wide ? 8 : s.w,
				h: wide ? s.h : 8,
				color: PLAY_RED,
				stroke: INK,
				strokeThickness: 1,
				zIndex: Z.structure,
			});
		}
		for (const f of [-0.22, 0.22]) {
			r.drawRect(cam, wide ? cx + s.w * f : cx + 10, wide ? cy + 10 : cy + s.h * f, {
				w: wide ? 20 : 8,
				h: wide ? 8 : 20,
				color: RUBBER,
				zIndex: Z.structure + 2,
			});
		}
		return true;
	}
	if (t === "slide") {
		box(r, cam, s, PLAY_YELLOW, PLAY_YELLOW_LIT, 14, shadow, 4);
		// the ladder's platform at one end
		r.drawRect(cam, wide ? s.x + 12 : cx, wide ? cy : s.y + 12, {
			w: wide ? 20 : s.w,
			h: wide ? s.h : 20,
			color: PLAY_BLUE,
			stroke: INK,
			strokeThickness: 1,
			zIndex: Z.structure + 2,
		});
		return true;
	}
	if (t === "climber") {
		box(r, cam, s, PLAY_BLUE, undefined, 16, shadow);
		r.drawRect(cam, cx, cy, {
			w: s.w - 16,
			h: s.h - 16,
			color: CANVAS,
			alpha: 0,
			stroke: PLAY_YELLOW,
			strokeThickness: 3,
			zIndex: Z.structure + 1,
		});
		r.drawRect(cam, cx, cy, { w: 4, h: s.h - 4, color: PLAY_YELLOW, zIndex: Z.structure + 2 });
		r.drawRect(cam, cx, cy, { w: s.w - 4, h: 4, color: PLAY_YELLOW, zIndex: Z.structure + 2 });
		return true;
	}
	if (t === "springer") {
		const so = shadow(cx, cy, 6);
		r.drawCircle(cam, cx + so.x, cy + so.y, s.w, { color: BLACK, alpha: SHADOW_A, zIndex: Z.shadow });
		r.drawCircle(cam, cx, cy, s.w, {
			color: k % 2 === 0 ? PLAY_YELLOW : PLAY_RED,
			stroke: INK,
			strokeThickness: 2,
			zIndex: Z.structure,
		});
		r.drawCircle(cam, cx - 4, cy - 5, 10, { color: SPRINGER_LIT, zIndex: Z.structure + 1 });
		return true;
	}
	if (t === "hoop") {
		// the backboard across the baseline, the rim over the court (the side it faces)
		box(r, cam, s, BOARD_WHITE, undefined, 22, shadow);
		const n = sideN(s.face);
		r.drawCircle(cam, cx + n.x * 18, cy + n.y * 18, 22, {
			color: RIM_ORANGE,
			alpha: 0,
			stroke: RIM_ORANGE,
			strokeThickness: 3,
			zIndex: Z.structure + 2,
		});
		return true;
	}
	if (t === "picnic") {
		// the table between its two benches, all one frame of planks
		box(r, cam, s, WOOD_SHADE, undefined, 6, shadow, 2);
		r.drawRect(cam, cx, cy, {
			w: wide ? s.w - 4 : s.w - 36,
			h: wide ? s.h - 36 : s.h - 4,
			color: WOOD,
			stroke: INK,
			strokeThickness: 1,
			zIndex: Z.structure + 1,
		});
		return true;
	}
	// ---- the street (MOB-04)
	// the street's most numerous fixtures are two sprites each, and no outline (a town holds hundreds: the flyover's pool
	// and the frame budget of a street, test:lobby and test:world-art §4)
	if (t === "streetlight") {
		// the pole's foot, and its dark lamp head out over the curb (the power is out: LUZ-02), high above the street
		r.drawCircle(cam, cx, cy, s.w, { color: INK, zIndex: Z.structure });
		const n = sideN(s.face);
		r.drawRect(cam, cx + n.x * 24, cy + n.y * 24, {
			w: n.x !== 0 ? 36 : 12,
			h: n.x !== 0 ? 12 : 36,
			color: LAMP_HEAD,
			cornerRadius: 4,
			zIndex: Z.roof - 1,
		});
		return true;
	}
	if (t === "hydrant") {
		r.drawCircle(cam, cx, cy, s.w, { color: HYDRANT_RED, zIndex: Z.structure });
		r.drawCircle(cam, cx - 1, cy - 1, s.w - 10, { color: HYDRANT_CAP, zIndex: Z.structure + 1 });
		return true;
	}
	if (t === "mailbox") {
		// the box on its post, the red flag up on its side
		r.drawRect(cam, cx, cy, { w: 14, h: 22, color: IRON, cornerRadius: 5, zIndex: Z.structure });
		r.drawRect(cam, cx + 8, cy - 4, { w: 4, h: 10, color: MAIL_FLAG, zIndex: Z.structure + 1 });
		return true;
	}
	if (t === "postbox") {
		box(r, cam, s, POST_BLUE, POST_BLUE_LIT, 12, shadow, 6);
		r.drawRect(cam, cx, cy - s.h / 6, { w: s.w - 12, h: 4, color: INK, zIndex: Z.structure + 2 });
		return true;
	}
	if (t === "busstop") {
		// the pole, and its sign standing upright above it (ART-07: a picture, no text: the bus's front)
		r.drawCircle(cam, cx, cy, s.w, { color: IRON, stroke: INK, strokeThickness: 1, zIndex: Z.structure });
		r.drawRect(cam, cx, cy - 26, {
			w: 26,
			h: 26,
			color: SIGN_BLUE,
			stroke: INK,
			strokeThickness: 2,
			zIndex: Z.roof - 1,
		});
		r.drawRect(cam, cx, cy - 28, { w: 14, h: 12, color: WHITE, zIndex: Z.roof });
		return true;
	}
	// ---- the backyards (MOB-06)
	if (t === "shed") {
		// its gable roof from above: the lit slope, the shaded one, the ridge
		box(r, cam, s, SHED_ROOF, undefined, 16, shadow);
		r.drawRect(cam, wide ? cx : s.x + s.w / 4, wide ? s.y + s.h / 4 : cy, {
			w: wide ? s.w - 4 : s.w / 2 - 2,
			h: wide ? s.h / 2 - 2 : s.h - 4,
			color: SHED_ROOF_LIT,
			zIndex: Z.structure + 1,
		});
		r.drawRect(cam, cx, cy, {
			w: wide ? s.w - 4 : 3,
			h: wide ? 3 : s.h - 4,
			color: INK,
			alpha: 0.7,
			zIndex: Z.structure + 2,
		});
		return true;
	}
	if (t === "pool") {
		r.drawRect(cam, cx, cy, {
			w: s.w,
			h: s.h,
			color: COPING,
			stroke: INK,
			strokeThickness: 2,
			strokeAlpha: 0.7,
			cornerRadius: 6,
			zIndex: Z.ground + 4,
		});
		r.drawRect(cam, cx, cy, { w: s.w - 14, h: s.h - 14, color: WATER, cornerRadius: 4, zIndex: Z.ground + 5 });
		r.drawRect(cam, cx - s.w / 6, cy - s.h / 6, {
			w: s.w / 3,
			h: 6,
			color: WATER_LIT,
			alpha: 0.7,
			cornerRadius: 3,
			zIndex: Z.ground + 6,
		});
		return true;
	}
	if (t === "trampoline") {
		const so = shadow(cx, cy, 10);
		r.drawCircle(cam, cx + so.x, cy + so.y, s.w, { color: BLACK, alpha: SHADOW_A, zIndex: Z.shadow });
		r.drawCircle(cam, cx, cy, s.w, { color: PAD_BLUE, stroke: INK, strokeThickness: 2, zIndex: Z.structure });
		r.drawCircle(cam, cx, cy, s.w - 16, { color: RUBBER, zIndex: Z.structure + 1 });
		return true;
	}
	if (t === "grill") {
		const so = shadow(cx, cy, 8);
		r.drawCircle(cam, cx + so.x, cy + so.y, s.w, { color: BLACK, alpha: SHADOW_A, zIndex: Z.shadow });
		r.drawCircle(cam, cx, cy, s.w, { color: RUBBER, stroke: INK, strokeThickness: 2, zIndex: Z.structure });
		r.drawRect(cam, cx - 3, cy - 3, { w: 10, h: 4, color: GALV_LIT, zIndex: Z.structure + 1 });
		return true;
	}
	return false;
}

/**
 * The everyday town's roofs on posts (EDI-21, MOB-04): a market stall's striped tent -- its canvas, three stripes
 * across it, the ridge -- and a bus shelter's smoked glass on its frame. See-through with a body under them
 * (`canopyAlpha`, the canopy's fade), their shadow on the sun's side.
 */
export function drawTownCanopy(r: Renderer, cam: Camera, s: Solid, v: ViewRect, shadow: ShadowFn): boolean {
	const t = s.tags;
	if (t !== "tent" && t !== "shelter") return false;
	if (!overlaps(s.x - 40, s.y - 40, s.w + 80, s.h + 80, v) || drawCanopyArt(r, cam, s, shadow)) return true;
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	if (t === "tent") {
		drawTent(r, cam, s, cx, cy, shadow);
		return true;
	}
	const a = s.canopyAlpha ?? 1;
	const so = shadow(cx, cy, 20);
	r.drawRect(cam, cx + so.x, cy + so.y, { w: s.w, h: s.h, color: BLACK, alpha: 0.22 * a + 0.04, zIndex: Z.shadow });
	if (t === "shelter") {
		r.drawRect(cam, cx, cy, {
			w: s.w,
			h: s.h,
			color: SHELTER_GLASS,
			alpha: 0.75 * a,
			stroke: IRON,
			strokeThickness: 3,
			strokeAlpha: a,
			zIndex: Z.roof,
		});
		return true;
	}
	return true;
}

/** a tear's dark edge, and a sagging canvas's puddle of old rain */
const TEAR = Color3.fromRGB(58, 54, 48);
const PUDDLE = Color3.fromRGB(84, 106, 118);

/**
 * A market stall's tent (EDI-21): its canvas, three stripes across the ridge and the shaded slope (the bottom / right
 * half: light from the top left), turned by its `heading` (a few degrees: nobody set them square). Torn: a dark rent
 * and a flap hanging off its edge; sagging: the belly between the poles darker, old rain in it. Standing, it is
 * aerial and see-through with a body under it (`canopyAlpha`). Down, it lies on its tables under the actors: crumpled,
 * two stripes skewed by the fold, a pole sticking out -- and whatever is under it shows round it.
 */
function drawTent(r: Renderer, cam: Camera, s: Solid, cx: number, cy: number, shadow: ShadowFn): void {
	const st = tentState(s);
	const th = s.heading ?? 0;
	const c = math.cos(th);
	const sn = math.sin(th);
	const wide = s.w >= s.h;
	const stripe = TENT_STRIPES[(s.variant ?? 0) % 3];
	if (st === TENT_DOWN) {
		// over the stacked crates' lids (Z.structure + 5), under every actor
		const z = Z.structure + 6;
		// the sheet, and the part of it that slumped off the tables in a heap, in shade
		const mx = wide ? -s.w * 0.06 : -s.w * 0.05;
		const my = wide ? -s.h * 0.05 : -s.h * 0.06;
		r.drawRect(cam, cx + mx * c - my * sn, cy + mx * sn + my * c, {
			w: s.w * (wide ? 0.8 : 0.7),
			h: s.h * (wide ? 0.7 : 0.8),
			rotation: th,
			color: CANVAS,
			stroke: INK,
			strokeThickness: 2,
			strokeAlpha: 0.8,
			zIndex: z,
		});
		const hx = wide ? s.w * 0.22 : s.w * 0.15;
		const hy = wide ? s.h * 0.15 : s.h * 0.22;
		r.drawRect(cam, cx + hx * c - hy * sn, cy + hx * sn + hy * c, {
			w: s.w * (wide ? 0.46 : 0.55),
			h: s.h * (wide ? 0.55 : 0.46),
			rotation: th + 0.35,
			color: CANVAS_SHADE,
			stroke: INK,
			strokeThickness: 2,
			strokeAlpha: 0.7,
			zIndex: z + 1,
		});
		const across = wide ? s.w : s.h;
		for (const f of [-0.26, 0.08]) {
			const d = across * f;
			r.drawRect(cam, cx + (wide ? d * c : -d * sn) + mx, cy + (wide ? d * sn : d * c) + my, {
				w: wide ? across / 9 : s.w * 0.6,
				h: wide ? s.h * 0.6 : across / 9,
				rotation: th + 0.1,
				color: stripe,
				zIndex: z + 2,
			});
		}
		// the folds it came down in, and a pole that fell with it
		for (const [len, turn] of [
			[0.7, -0.15],
			[0.4, 0.55],
		] as Array<[number, number]>) {
			r.drawRect(cam, cx + mx, cy + my, {
				w: wide ? s.w * len : 8,
				h: wide ? 8 : s.h * len,
				rotation: th + turn,
				color: BLACK,
				alpha: 0.22,
				zIndex: z + 3,
			});
		}
		const px = wide ? s.w * 0.44 : 0;
		const py = wide ? 0 : s.h * 0.44;
		r.drawRect(cam, cx + px * c - py * sn, cy + px * sn + py * c, {
			w: 4,
			h: (wide ? s.h : s.w) * 0.9,
			rotation: th + (wide ? 0.6 : 0.6 + math.pi / 2),
			color: IRON,
			zIndex: z + 3,
		});
		return;
	}
	const a = s.canopyAlpha ?? 1;
	const so = shadow(cx, cy, st === TENT_SAGGING ? 20 : 26);
	r.drawRect(cam, cx + so.x, cy + so.y, {
		w: s.w,
		h: s.h,
		rotation: th,
		color: BLACK,
		alpha: 0.22 * a + 0.04,
		zIndex: Z.shadow,
	});
	r.drawRect(cam, cx, cy, {
		w: s.w,
		h: s.h,
		rotation: th,
		color: CANVAS,
		alpha: a,
		stroke: INK,
		strokeThickness: 2,
		strokeAlpha: 0.8 * a,
		zIndex: Z.roof,
	});
	const across = wide ? s.w : s.h;
	for (const f of [-0.33, 0, 0.33]) {
		const d = across * f;
		r.drawRect(cam, cx + (wide ? d * c : -d * sn), cy + (wide ? d * sn : d * c), {
			w: wide ? across / 7 : s.w,
			h: wide ? s.h : across / 7,
			rotation: th,
			color: stripe,
			alpha: a,
			zIndex: Z.roof + 1,
		});
	}
	// the shaded slope
	const hx = wide ? 0 : s.w / 4;
	const hy = wide ? s.h / 4 : 0;
	r.drawRect(cam, cx + hx * c - hy * sn, cy + hx * sn + hy * c, {
		w: wide ? s.w : s.w / 2,
		h: wide ? s.h / 2 : s.h,
		rotation: th,
		color: BLACK,
		alpha: 0.14 * a,
		zIndex: Z.roof + 2,
	});
	if (st === TENT_TORN) {
		// the rent, off the middle, and the flap hanging over the edge on the shaded side
		const tx = wide ? s.w * 0.18 : -s.w * 0.1;
		const ty = wide ? -s.h * 0.1 : s.h * 0.18;
		r.drawRect(cam, cx + tx * c - ty * sn, cy + tx * sn + ty * c, {
			w: wide ? 10 : s.w * 0.42,
			h: wide ? s.h * 0.42 : 10,
			rotation: th + 0.3,
			color: TEAR,
			alpha: 0.85 * a,
			zIndex: Z.roof + 3,
		});
		const fx = wide ? s.w * 0.28 : s.w / 2 + 8;
		const fy = wide ? s.h / 2 + 8 : s.h * 0.28;
		r.drawRect(cam, cx + fx * c - fy * sn, cy + fx * sn + fy * c, {
			w: 34,
			h: 20,
			rotation: th + 0.5,
			color: stripe,
			alpha: a,
			stroke: INK,
			strokeThickness: 1,
			strokeAlpha: 0.7 * a,
			zIndex: Z.roof + 3,
		});
	} else if (st === TENT_SAGGING) {
		// the belly between the poles, and the old rain lying in it
		r.drawRect(cam, cx, cy, {
			w: s.w * 0.62,
			h: s.h * 0.5,
			rotation: th,
			color: BLACK,
			alpha: 0.16 * a,
			cornerRadius: 12,
			zIndex: Z.roof + 3,
		});
		r.drawRect(cam, cx - 6 * sn, cy + 6 * c, {
			w: wide ? s.w * 0.28 : s.w * 0.22,
			h: wide ? s.h * 0.2 : s.h * 0.28,
			rotation: th,
			color: PUDDLE,
			alpha: 0.55 * a,
			cornerRadius: 8,
			zIndex: Z.roof + 4,
		});
	}
}

/** is this solid the bank's vault door (worldView draws it here instead of as a built door)? */
export function vaultDoorSolid(s: Solid): boolean {
	return isVaultDoor(s);
}
