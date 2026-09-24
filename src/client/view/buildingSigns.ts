/*
 * How a building says what it is (docs/DESIGN_RULES.md EDI-03, ART-07): a storefront sign beside its main entrance,
 * facing the street, and -- where a real building has one -- a marking on the roof (the hospital's helipad). The
 * pixel art is data (shared/data/buildingSigns.ts); this module places it and draws it through the town's Renderer.
 *
 *   drawBuildingSign(r, cam, view, type, doorX, doorY, doorSide, roof, roofAlpha, shadow)
 *   drawPriceSign(r, cam, view, footing, alpha, shadow)     a gas station's price pylon (EDI-16), the same pixel art
 *
 * It is the ONE hook client/view/worldView.ts calls (`drawSignage`), from the flat drawing and from the art drawing
 * alike, with only what a sign needs to know: the building's type, where its main entrance is and in which wall,
 * and the roof rect the sign stands on (the main wing's, once a building has several).
 *
 * Where: on the entrance wall, inside the footprint (on the parapet's coping, SIGN_INSET in from the facade), next
 * to the doorway on the side with more room, SIGN_GAP clear of it. Never over the doorway, never over the sidewalk:
 * the roof layer covers what is under it, and a sign hanging over the sidewalk would hide a zombie walking there
 * (LEG-03). Always upright on screen, whichever wall it is on: a pictogram is read, not a direction.
 *
 * What: the board (flat: its grid as a few rectangles; art: one ImageLabel of the same pixels once its texture has
 * an id, client/view/worldArt.ts), a small drop shadow on the roof that moves with the light (LUZ-01) and what a
 * few days did to it (APO-01), picked by a hash of the building: most are only grimy, some cracked, some chipped at
 * a corner, some bleached by the sun. It fades with the roof (roofAlpha), so it never hides the inside of a building
 * the survivor walked into.
 *
 * Night: the signs are dark. The power is out a few days after the outbreak; a lit or flickering sign would be a
 * light with no reason (LUZ-02), a beacon across the dark town and a promise of power the town cannot keep (P3),
 * and a flicker would write properties every frame (a still camera writes nothing, test:world-art). They read at
 * night where everything does: in the survivor's light.
 *
 * Cost: nothing allocates per frame (one scratch SpriteOpts, one scratch rect, the runs decomposed once per type);
 * flat at most SIGN_MAX_FLAT sprites a building (board runs + shadow + wear, the helipad 6 more on a board of 11),
 * with art at most SIGN_MAX_ART. The pool never grows after warm-up.
 */
import { Camera, ViewRect } from "shared/engine/camera";
import { COLORS, Z } from "shared/engine/colors";
import { TOWN } from "shared/engine/constants";
import { Renderer, SpriteOpts } from "shared/engine/renderer";
import {
	BUILDING_SIGNS,
	BuildingSign,
	HELIPAD,
	PRICE_SIGN,
	PRICE_SIGN_POST_ROWS,
	SIGN_ART,
	SIGN_TEXEL,
} from "shared/data/buildingSigns";
import { DoorSide, hash01, Rect } from "shared/game/world";
import { artId } from "./worldArt";
import { WORLD_ART, WorldArtName } from "./worldArtAssets";

/** how far inside the facade the board stands: on the parapet's coping, never over the sidewalk */
export const SIGN_INSET = 4;
/** clear space between the doorway's edge and the board */
export const SIGN_GAP = 16;
/** how close to a corner of the building the board may go */
export const SIGN_EDGE = 16;
/** the most sprites one building's signage costs: flat (board runs + shadow + wear), and with art */
export const SIGN_MAX_FLAT = 32;
export const SIGN_MAX_ART = 6;

/** Z layers (Z.roof + 1 .. + 9): all over the roof, its units and its rim, all under the tree canopy (Z.canopy) */
const Z_PAINT = Z.roof + 1;
const Z_SHADOW = Z.roof + 3;
const Z_BOARD = Z.roof + 4;
/** the board's runs stack at most this many layers above Z_BOARD (test:world-art checks every sign) */
export const SIGN_MAX_LAYER = 4;
const Z_WEAR = Z_BOARD + SIGN_MAX_LAYER + 1;

const BLACK = COLORS.shadow;
const OUTLINE = SIGN_ART.k;
const BLEACH = SIGN_ART.W;
const CRACK = SIGN_ART.s;

/** one rectangle of a board, in texels, and its layer above Z_BOARD */
interface SignRun {
	x: number;
	y: number;
	w: number;
	h: number;
	color: Color3;
	z: number;
}

const runsCache = new Map<number, Array<SignRun>>();

/**
 * The runs of a grid (the decomposition of client/ui/itemIcon.ts): colour by colour in `order`, each colour's texels
 * covered by rectangles that may spill over texels of colours painted after it (never an earlier colour's). Greedy:
 * from each uncovered texel, of two candidates -- the widest span the rule allows, or just the run of that colour --
 * the one that grows down over more texels of its colour. Then each run gets the lowest layer above every earlier
 * run it overlaps, so a board needs 3 to 5 layers, not one per colour.
 */
function decompose(rows: Array<string>, order: string): Array<SignRun> {
	const m = rows.size();
	const n = (rows[0] ?? "").size();
	// one character at a time with Luau's string.sub, as client/ui/itemIcon.ts reads its grids
	const rankOf = new Map<string, number>();
	const colours = order.size();
	for (let i = 1; i <= colours; i++) rankOf.set(order.sub(i, i), i - 1);
	const rank: Array<number> = [];
	for (let y = 0; y < m; y++) {
		const row = rows[y];
		for (let x = 0; x < n; x++) rank.push(rankOf.get(row.sub(x + 1, x + 1)) ?? -1);
	}
	const runs: Array<SignRun> = [];
	const layers: Array<number> = [];
	for (let L = 0; L < colours; L++) {
		const color = SIGN_ART[order.sub(L + 1, L + 1)];
		if (color === undefined) continue;
		const covered: Array<boolean> = [];
		for (let i = 0; i < n * m; i++) covered.push(false);
		const needed = (i: number): boolean => rank[i] === L && !covered[i];
		const allowed = (i: number): boolean => rank[i] >= L;
		const mine = (i: number): boolean => rank[i] === L;
		const widest = (ok: (i: number) => boolean, x: number, y: number): [number, number] => {
			let x0 = x;
			while (x0 > 0 && ok(y * n + x0 - 1)) x0 -= 1;
			let x1 = x;
			while (x1 < n - 1 && ok(y * n + x1 + 1)) x1 += 1;
			return [x0, x1];
		};
		const grow = (x0: number, x1: number, y: number): [number, number] => {
			let gain = 0;
			for (let i = x0; i <= x1; i++) if (needed(y * n + i)) gain += 1;
			let y1 = y;
			while (y1 + 1 < m) {
				const ny = y1 + 1;
				let ok = true;
				let more = 0;
				for (let i = x0; i <= x1; i++) {
					if (!allowed(ny * n + i)) ok = false;
					else if (needed(ny * n + i)) more += 1;
				}
				if (!ok || more === 0) break;
				gain += more;
				y1 = ny;
			}
			return [y1, gain];
		};
		for (let y = 0; y < m; y++) {
			for (let x = 0; x < n; x++) {
				if (!needed(y * n + x)) continue;
				const [a0, a1] = widest(allowed, x, y);
				const [, b1] = widest(mine, x, y);
				const [ay1, again] = grow(a0, a1, y);
				const [by1, bgain] = grow(x, b1, y);
				const wide = again >= bgain;
				const x0 = wide ? a0 : x;
				const x1 = wide ? a1 : b1;
				const y1 = wide ? ay1 : by1;
				for (let yy = y; yy <= y1; yy++) {
					for (let i = x0; i <= x1; i++) if (mine(yy * n + i)) covered[yy * n + i] = true;
				}
				runs.push({ x: x0, y, w: x1 - x0 + 1, h: y1 - y + 1, color, z: 0 });
				layers.push(L);
			}
		}
	}
	// the lowest layer above every earlier-colour run a run overlaps
	for (let i = 0; i < runs.size(); i++) {
		const a = runs[i];
		let z = 0;
		for (let j = 0; j < i; j++) {
			const b = runs[j];
			if (layers[j] >= layers[i]) continue;
			if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) z = math.max(z, b.z + 1);
		}
		a.z = z;
	}
	return runs;
}

/** the flat drawing of type `bt`'s sign (computed once), or undefined for a type without one */
function runsOf(bt: number): Array<SignRun> | undefined {
	const cached = runsCache.get(bt);
	if (cached !== undefined) return cached;
	const sign = BUILDING_SIGNS[bt];
	if (sign === undefined) return undefined;
	const runs = decompose(sign.rows, sign.order);
	runsCache.set(bt, runs);
	return runs;
}

/** tests: the runs of type `bt`'s sign as plain data [x, y, w, h, r, g, b, layer] in texels */
export function signRuns(bt: number): Array<[number, number, number, number, number, number, number, number]> {
	const out: Array<[number, number, number, number, number, number, number, number]> = [];
	for (const q of runsOf(bt) ?? []) {
		out.push([q.x, q.y, q.w, q.h, q.color.R, q.color.G, q.color.B, q.z]);
	}
	return out;
}

/** the texture of a type's sign in the town art (a name missing from worldArtAssets.ts: always drawn flat) */
function textureOf(sign: BuildingSign): WorldArtName | undefined {
	const name = sign.texture as WorldArtName;
	return WORLD_ART[name] !== undefined ? name : undefined;
}

// ------------------------------------------------------------------ where

/** a board's size in texels */
function colsOf(sign: BuildingSign): number {
	return (sign.rows[0] ?? "").size();
}
function rowsOf(sign: BuildingSign): number {
	return sign.rows.size();
}

/**
 * Where the sign of type `bt` stands on a building with its main entrance at (doorX, doorY) in wall `side` of
 * `roof`, written into `out` (top-left corner and size, world units): along the entrance wall, SIGN_INSET inside
 * the facade, next to the doorway on the side with more room. False for a type without a sign (a house).
 */
export function placeSign(out: Rect, bt: number, side: DoorSide, doorX: number, doorY: number, roof: Rect): boolean {
	const sign = BUILDING_SIGNS[bt];
	if (sign === undefined) return false;
	const w = colsOf(sign) * SIGN_TEXEL;
	const h = rowsOf(sign) * SIGN_TEXEL;
	const alongX = side === "top" || side === "bottom";
	const u = alongX ? doorX : doorY;
	const lo = alongX ? roof.x : roof.y;
	const hi = alongX ? roof.x + roof.w : roof.y + roof.h;
	const len = alongX ? w : h;
	const clear = TOWN.DOOR_W / 2 + SIGN_GAP;
	const roomHi = hi - SIGN_EDGE - (u + clear);
	const roomLo = u - clear - (lo + SIGN_EDGE);
	let a: number;
	if (roomHi >= len && roomHi >= roomLo) a = u + clear;
	else if (roomLo >= len) a = u - clear - len;
	else if (roomHi >= len) a = u + clear;
	// a facade too short for a sign beside its door (no generated building is): the far end of the longer side
	else a = roomHi >= roomLo ? hi - SIGN_EDGE - len : lo + SIGN_EDGE;
	a = math.floor(a + 0.5);
	out.w = w;
	out.h = h;
	if (alongX) {
		out.x = a;
		out.y = side === "top" ? roof.y + SIGN_INSET : roof.y + roof.h - SIGN_INSET - h;
	} else {
		out.y = a;
		out.x = side === "left" ? roof.x + SIGN_INSET : roof.x + roof.w - SIGN_INSET - w;
	}
	return true;
}

/** tests and tools/validate-world.mjs: `placeSign` into a new rect, or undefined for a type without a sign */
export function signRect(bt: number, side: DoorSide, doorX: number, doorY: number, roof: Rect): Rect | undefined {
	const out = { x: 0, y: 0, w: 0, h: 0 };
	return placeSign(out, bt, side, doorX, doorY, roof) ? out : undefined;
}

/** does type `bt` paint a helipad on its roof? */
export function hasHelipad(bt: number): boolean {
	return BUILDING_SIGNS[bt]?.roofMark === "helipad";
}

/** the helipad's square on `roof` (its centre), world units */
export function helipadRect(roof: Rect): Rect {
	const d = HELIPAD.size * SIGN_TEXEL;
	return { x: roof.x + roof.w / 2 - d / 2, y: roof.y + roof.h / 2 - d / 2, w: d, h: d };
}

// ------------------------------------------------------------------ drawing

/** the one SpriteOpts every draw here fills; `fresh` resets every field the renderer reads */
const OPTS: SpriteOpts = {};
const SPOT: Rect = { x: 0, y: 0, w: 0, h: 0 };

function fresh(w: number, h: number, z: number, color: Color3, alpha: number): SpriteOpts {
	const o = OPTS;
	o.w = w;
	o.h = h;
	o.zIndex = z;
	o.color = color;
	o.alpha = alpha;
	o.image = undefined;
	o.rotation = undefined;
	o.cornerRadius = undefined;
	o.circle = undefined;
	o.anchorX = undefined;
	o.anchorY = undefined;
	o.stroke = undefined;
	o.strokeThickness = undefined;
	o.strokeAlpha = undefined;
	o.imageTint = undefined;
	o.scaleType = undefined;
	o.tileW = undefined;
	o.tileH = undefined;
	o.sliceX0 = undefined;
	o.sliceY0 = undefined;
	o.sliceX1 = undefined;
	o.sliceY1 = undefined;
	o.sliceScale = undefined;
	o.pixelated = undefined;
	return o;
}

/** a rect of `w` x `h` texels at texel (tx, ty) of the board whose top-left corner is (x0, y0) */
function texels(
	r: Renderer,
	cam: Camera,
	x0: number,
	y0: number,
	tx: number,
	ty: number,
	w: number,
	h: number,
	z: number,
	color: Color3,
	alpha: number,
): void {
	const T = SIGN_TEXEL;
	r.drawRect(cam, x0 + (tx + w / 2) * T, y0 + (ty + h / 2) * T, fresh(w * T, h * T, z, color, alpha));
}

/**
 * What a few days did to a sign (APO-01), by a hash of its building: 30% cracked (a jagged line down from the top
 * edge), 15% chipped at a corner (the plastic face broken out, the dark box behind it showing), 20% bleached by the
 * sun; the rest only carry the grime of their bottom row. At most three sprites.
 */
function drawWear(
	r: Renderer,
	cam: Camera,
	x0: number,
	y0: number,
	cols: number,
	rows: number,
	roof: Rect,
	a: number,
): void {
	const h = hash01(roof.x, roof.y, 91);
	if (h < 0.3) {
		// the pale stress line of cracked plastic: it reads as damage over a light face and a dark pictogram alike
		const right = hash01(roof.x, roof.y, 92) < 0.5;
		const k = math.floor(hash01(roof.x, roof.y, 93) * 3);
		const col = right ? cols - 3 - k : 2 + k;
		const step = right ? -1 : 1;
		texels(r, cam, x0, y0, col, 1, 1, 2, Z_WEAR, CRACK, 0.9 * a);
		texels(r, cam, x0, y0, col + step, 3, 1, 1, Z_WEAR, CRACK, 0.9 * a);
		texels(r, cam, x0, y0, col + step * 2, 4, 1, 2, Z_WEAR, CRACK, 0.7 * a);
	} else if (h < 0.45) {
		if (hash01(roof.x, roof.y, 94) < 0.5) texels(r, cam, x0, y0, cols - 4, 1, 3, 2, Z_WEAR, OUTLINE, a);
		else texels(r, cam, x0, y0, 1, rows - 3, 3, 2, Z_WEAR, OUTLINE, a);
	} else if (h < 0.65) {
		texels(r, cam, x0, y0, 1, 1, cols - 2, rows - 2, Z_WEAR, BLEACH, 0.2 * a);
	}
}

/** the hospital's helipad: flat, the deck with its ring, the white cross and the red H; with art, one sprite */
function drawHelipad(r: Renderer, cam: Camera, v: ViewRect, roof: Rect, a: number): void {
	const T = SIGN_TEXEL;
	const cx = roof.x + roof.w / 2;
	const cy = roof.y + roof.h / 2;
	const half = (HELIPAD.size * T) / 2;
	if (cx + half < v.minX || cx - half > v.maxX || cy + half < v.minY || cy - half > v.maxY) return;
	const tex = artId("helipad");
	if (tex !== undefined) {
		const o = fresh(half * 2, half * 2, Z_PAINT, BLACK, a);
		o.color = undefined;
		o.image = tex;
		r.drawRect(cam, cx, cy, o);
		return;
	}
	const deck = SIGN_ART[HELIPAD.deck] ?? OUTLINE;
	const paint = SIGN_ART[HELIPAD.paint] ?? BLEACH;
	const mark = SIGN_ART[HELIPAD.mark] ?? BLEACH;
	const pa = HELIPAD.alpha * a;
	// the deck and its ring, one circle: the ring is the UIStroke drawn outside it (its width is in screen pixels)
	const ringW = HELIPAD.ringWidth * T;
	const ring = fresh(0, 0, Z_PAINT, deck, pa);
	ring.stroke = paint;
	ring.strokeThickness = ringW * cam.zoom;
	ring.strokeAlpha = pa;
	r.drawCircle(cam, cx, cy, HELIPAD.ring * T - ringW * 2, ring);
	const sq = HELIPAD.square * T;
	r.drawRect(cam, cx, cy, fresh(sq, sq * 3, Z_PAINT, paint, pa));
	r.drawRect(cam, cx, cy, fresh(sq * 3, sq, Z_PAINT, paint, pa));
	const lh = HELIPAD.letter * T;
	const leg = HELIPAD.leg * T;
	const legX = lh / 2 - leg / 2;
	r.drawRect(cam, cx - legX, cy, fresh(leg, lh, Z_PAINT + 1, mark, a));
	r.drawRect(cam, cx + legX, cy, fresh(leg, lh, Z_PAINT + 1, mark, a));
	r.drawRect(cam, cx, cy, fresh(lh - leg * 2, HELIPAD.bar * T, Z_PAINT + 1, mark, a));
}

/**
 * The signage of a building of type `bt` whose main entrance is at (doorX, doorY) in wall `side`, on `roof`, at the
 * roof's opacity `alpha`; `shadow` says where the shadow of a point falls (LUZ-01). Types without a sign (houses)
 * draw nothing.
 */
export function drawBuildingSign(
	r: Renderer,
	cam: Camera,
	v: ViewRect,
	bt: number,
	doorX: number,
	doorY: number,
	side: DoorSide,
	roof: Rect,
	alpha: number,
	shadow: (x: number, y: number, len: number) => { x: number; y: number },
): void {
	if (alpha <= 0.01) return;
	const sign = BUILDING_SIGNS[bt];
	if (sign === undefined) return;
	if (sign.roofMark === "helipad") drawHelipad(r, cam, v, roof, alpha);
	const q = SPOT;
	placeSign(q, bt, side, doorX, doorY, roof);
	if (q.x > v.maxX || q.x + q.w < v.minX || q.y > v.maxY || q.y + q.h < v.minY) return;
	const cx = q.x + q.w / 2;
	const cy = q.y + q.h / 2;
	// a box on the parapet: its shadow on the roof, short (it stands a hand's width proud of the coping)
	const so = shadow(cx, cy, SIGN_INSET);
	r.drawRect(cam, cx + so.x, cy + so.y, fresh(q.w, q.h, Z_SHADOW, BLACK, 0.3 * alpha));
	const name = textureOf(sign);
	const tex = name !== undefined ? artId(name) : undefined;
	if (tex !== undefined) {
		const o = fresh(q.w, q.h, Z_BOARD, BLACK, alpha);
		o.color = undefined;
		o.image = tex;
		r.drawRect(cam, cx, cy, o);
	} else {
		const runs = runsOf(bt);
		if (runs !== undefined) {
			for (const run of runs) {
				texels(r, cam, q.x, q.y, run.x, run.y, run.w, run.h, Z_BOARD + run.z, run.color, alpha);
			}
		}
	}
	drawWear(r, cam, q.x, q.y, colsOf(sign), rowsOf(sign), roof, alpha);
}

// ------------------------------------------------------------------ a gas station's price sign (EDI-16)

let priceRuns: Array<SignRun> | undefined;

/** tests: the price sign's runs as plain data [x, y, w, h, r, g, b, layer] in texels */
export function priceSignRuns(): Array<[number, number, number, number, number, number, number, number]> {
	if (priceRuns === undefined) priceRuns = decompose(PRICE_SIGN.rows, PRICE_SIGN.order);
	const out: Array<[number, number, number, number, number, number, number, number]> = [];
	for (const q of priceRuns) out.push([q.x, q.y, q.w, q.h, q.color.R, q.color.G, q.color.B, q.z]);
	return out;
}

/**
 * Where the price pylon standing on `footing` (the solid tagged "gas_sign", world.ts `placeGas`) is drawn, written
 * into `out` (world units): upright on screen, like every sign, its post's foot on the footing's middle. It is also
 * the rect the loop fades while a body is under it (gameLoop `updateCanopy`: the tree crown's fade, LEG-03).
 */
export function priceSignRect(footing: Rect, out: Rect): Rect {
	const w = colsOf(PRICE_SIGN) * SIGN_TEXEL;
	const h = rowsOf(PRICE_SIGN) * SIGN_TEXEL;
	out.w = w;
	out.h = h;
	out.x = math.floor(footing.x + footing.w / 2 - w / 2 + 0.5);
	out.y = math.floor(footing.y + footing.h / 2 - h + 0.5);
	return out;
}

/**
 * The price pylon on `footing`, at opacity `alpha` (its `canopyAlpha`: see-through while a body is under it), with
 * its long thin shadow on the forecourt (LUZ-01). Flat: its runs; art: one ImageLabel once `signPrice` has an id.
 * Dark at night like every sign (no power, ART-07). At most runs + 1 sprites, none allocated per frame.
 */
export function drawPriceSign(
	r: Renderer,
	cam: Camera,
	v: ViewRect,
	footing: Rect,
	alpha: number,
	shadow: (x: number, y: number, len: number) => { x: number; y: number },
): void {
	const q = priceSignRect(footing, SPOT);
	// the board stands a post's height up: its shadow lies on the forecourt that far off the foot, in the light's
	// direction, as wide as the board and foreshortened
	const fx = footing.x + footing.w / 2;
	const fy = footing.y + footing.h / 2;
	const so = shadow(fx, fy, 64);
	const sw = q.w;
	const sh = (q.h - PRICE_SIGN_POST_ROWS * SIGN_TEXEL) * 0.5;
	const sx = fx + so.x;
	const sy = fy + so.y;
	if (sx + sw / 2 >= v.minX && sx - sw / 2 <= v.maxX && sy + sh / 2 >= v.minY && sy - sh / 2 <= v.maxY) {
		r.drawRect(cam, sx, sy, fresh(sw, sh, Z.shadow, BLACK, 0.22));
	}
	if (q.x > v.maxX || q.x + q.w < v.minX || q.y > v.maxY || q.y + q.h < v.minY) return;
	const name = textureOf(PRICE_SIGN);
	const tex = name !== undefined ? artId(name) : undefined;
	if (tex !== undefined) {
		const o = fresh(q.w, q.h, Z_BOARD, BLACK, alpha);
		o.color = undefined;
		o.image = tex;
		r.drawRect(cam, q.x + q.w / 2, q.y + q.h / 2, o);
		return;
	}
	if (priceRuns === undefined) priceRuns = decompose(PRICE_SIGN.rows, PRICE_SIGN.order);
	for (const run of priceRuns) {
		texels(r, cam, q.x, q.y, run.x, run.y, run.w, run.h, Z_BOARD + run.z, run.color, alpha);
	}
}
