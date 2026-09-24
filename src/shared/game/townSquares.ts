/*
 * The downtown squares (docs/DESIGN_RULES.md MOB-07). Main Street is a stock, not a lottery (EDI-19): a downtown block
 * takes the shops the stock still has and a parking lot in the back, and what they leave is paving -- 256 to 1152 u of
 * the town's grey pavers with nothing on them, five to seven of them a town, right where the survivors walk. The owner
 * (2026-09-24, a screenshot of one with a blood stain in it): "esse espaço vazio é normal?". A real town made a square
 * of that ground, and so does this one: each empty stretch gets a PROGRAM --
 *
 *   fountain  a civic square: the fountain in the middle of its mosaic, benches facing it, lamp posts, planters, bins;
 *   memorial  the town's memorial on its plinth and, at its foot, the flowers and candles of a vigil (APO-01: the
 *             first days of the outbreak), benches, a notice board of missing-person flyers, planters, lamp posts;
 *   garden    a pocket park: a planted bed with its trees in the paving, benches round it, a hopscotch chalked on it;
 *   cafe      a cafe's terrace: tables and chairs under parasols, some pushed back, one knocked over as they ran;
 *   kiosk     a newsstand on the corner of the street, a notice board, benches, bins, lamp posts;
 *   cleared   (rarer: a town in three) a lot cleared for a building that never came -- bare earth, rubble, a skip,
 *             road barriers along the sidewalk --
 *
 * dealt from a shuffled deck, so the squares of a town differ (a program comes back only when the deck is spent, and
 * then in another look), and on every one the same floor: the paving's mosaic, a drain's grate, cracked and sunken
 * slabs, weeds in the joints, leaves under the trees, the paper people dropped.
 *
 * Laid LAST, once every building's inside is planned (world.ts `generateTown`), from the squares' own streams (the town's
 * seed and where each lies; never the town's stream): nothing else in the town moves -- every other solid keeps its
 * rect and its id (tools/test-world-art.mjs `noSquares`). Integers and + - * / only, no Map iteration, no sort (MP-26:
 * the server and every client lay the same squares, npm run test:seed).
 *
 * Every piece stands off every building by SQUARE_CLEAR (the doors' approach and the windows the horde climbs: EDI-09),
 * pinches no slot with anything round it and closes off no ground (EDI-11, CID-05: townLots.ts `pinchesAny`,
 * `closesPocket`), and a piece that cannot stand where its program wants it is left out; the validator holds every square
 * to SQUARE_PIECES_MIN pieces (MOB-07).
 */
import { TOWN } from "shared/engine/constants";
import type { TreeSite } from "shared/data/trees";
import { alongX, closesPocket, PATH, pinchesAny, prop, standing, TownKit } from "./townLots";
import type { DoorSide, GroundKind, Lot, Rect, Solid, SquareProgram, TownSquare } from "./world";

// ---------------------------------------------------------------------------------------------- sizes

/** the grid the empty paving is found on */
const CELL = 32;
/** the shortest side of a square: less is a service yard, not a square */
export const SQUARE_MIN = 256;
/** a square keeps this far from every building (its doors' approach, its windows: EDI-09, as the backyards do) */
export const SQUARE_CLEAR = 96;
/** and this far from anything else standing (a street tree, a bin, a lamp: its pieces then ask EDI-11 themselves) */
const SOLID_CLEAR = 32;
/** at most this many squares on one block (every stretch of empty paving gets one: validate:world, MOB-07) */
export const SQUARES_PER_LOT = 4;
/** a square holds at least this many standing pieces (props, trees, bins; checked by validate:world) */
export const SQUARE_PIECES_MIN = 4;
/** and at least this many things lie on its floor (weeds, paper, a drain, a crack, leaves, a vigil...) */
export const FLOOR_MIN = 3;
/** a free stretch this much longer than wide is two squares, PATH apart */
const SPLIT_ASPECT = 2.2;
/**
 * How many looks each program has: a square's look picks its mosaic's pattern, its planters' and parasols' colours (the
 * atlas's ART_LOOKS) and, for the grove, what grows in its grates -- two squares of a town never share program and look
 */
export const SQUARE_LOOKS: Record<SquareProgram, number> = {
	fountain: 3,
	memorial: 3,
	garden: 3,
	grove: 6,
	cafe: 3,
	kiosk: 3,
	cleared: 3,
};
/** the looks of the mosaic, the planters and the parasols in the townProps atlas */
export const ART_LOOKS = 3;
/** the share of towns with a cleared lot (at most one) */
const CLEARED_SHARE = 0.35;
/** the programs of the deck, and the shortest side each needs */
const PROGRAMS: ReadonlyArray<SquareProgram> = ["fountain", "memorial", "garden", "grove", "cafe", "kiosk"];
export const SQUARE_MIN_SIDE: Record<SquareProgram, number> = {
	fountain: 320,
	memorial: 288,
	garden: 320,
	grove: 256,
	cafe: 352,
	kiosk: 256,
	cleared: 256,
};
/**
 * How many of each a town holds at most (P1: one memorial -- the town's --, a fountain or two, a cleared lot): a
 * program at its cap stays out of the deck; the grove, the plainest, takes what the others cannot
 */
export const SQUARE_CAP: Record<SquareProgram, number> = {
	fountain: 2,
	memorial: 1,
	garden: 2,
	grove: 6,
	cafe: 2,
	kiosk: 3,
	cleared: 1,
};

/** the pieces (world units): a bench (townLots.ts BENCH_L x BENCH_D), a planter, a lamp post, a notice board... */
const BENCH_L = 64;
const BENCH_D = 24;
export const PLANTER = 64;
export const LAMPPOST = 16;
export const BOARD_L = 64;
export const BOARD_D = 12;
export const KIOSK_L = 112;
export const KIOSK_D = 80;
export const CAFE_TABLE = 80;
export const PARASOL = 112;
export const RUBBLE_L = 96;
export const RUBBLE_D = 64;
export const BARRIER_L = 88;
export const BARRIER_D = 24;
const FOUNTAIN = 88;
const STATUE = 48;
const DUMPSTER_L = 128;
const DUMPSTER_D = 64;
/** where a cafe table goes when its own spot pinches: a step off it either way */
const CAFE_NUDGE: ReadonlyArray<[number, number]> = [
	[0, 0],
	[16, 0],
	[-16, 0],
	[0, 16],
	[0, -16],
];
/** a grove's trees along the square, trunk to trunk */
const GROVE_PITCH = 224;
/** a cafe's tables, table to table: two bodies and a little between two of them */
const CAFE_PITCH = CAFE_TABLE + 96;
/** the mosaic in the middle of a square: the larger for a square this wide, else the one that fits (townProps cells) */
export const MEDALLION_SIZES: ReadonlyArray<number> = [288, 192, 128];
const MEDALLION_LARGE_FROM = 416;
/** the floor's decals (townProps atlas cells, tools/town-prop-art.mjs GROUND): sizes as laid along x */
export const DECAL_SIZE: Record<string, [number, number]> = {
	drain: [32, 32],
	cracked: [64, 48],
	weeds: [32, 32],
	leaves: [48, 48],
	vigil: [64, 32],
	chalk: [160, 48],
	paper: [40, 32],
	bag: [36, 28],
};
/** a cafe table's looks: set, pushed back (a chair on its side), knocked over (townProps `cafe`) */
export const CAFE_SET = 0;
export const CAFE_PUSHED = 1;
export const CAFE_DOWN = 2;

// ---------------------------------------------------------------------------------------------- the streams

/** MINSTD, like the town's, the campus's and the parks' own streams */
class SquareRng {
	private s: number;

	constructor(seed: number) {
		let s = math.floor(math.abs(seed)) % 2147483647;
		if (s === 0) s = 1;
		this.s = s;
	}

	next(): number {
		this.s = (this.s * 48271) % 2147483647;
		return (this.s - 1) / 2147483646;
	}

	int(a: number, b: number): number {
		return math.min(b, a + math.floor(this.next() * (b - a + 1)));
	}

	chance(p: number): boolean {
		return this.next() < p;
	}
}

/** the deck's stream: from the town's seed alone (integers: every product under 2^53) */
function deckSeed(town: number): number {
	return (((math.floor(math.abs(town)) % 2147483000) * 13 + 70001) % 2147483646) + 1;
}

/** a square's own stream: from the town's seed and where the square lies */
function squareSeed(town: number, x: number, y: number): number {
	const a = (math.floor(x) * 7919 + math.floor(y) * 104729 + 90001) % 2147483647;
	return ((a + (math.floor(math.abs(town)) % 1000003) * 173) % 2147483646) + 1;
}

// ---------------------------------------------------------------------------------------------- geometry

function snap8(v: number): number {
	return math.floor(v / 8 + 0.5) * 8;
}

/** is `r` inside `s`, `m` in from its edges? */
function within(s: Rect, r: Rect, m: number): boolean {
	return r.x >= s.x + m && r.y >= s.y + m && r.x + r.w <= s.x + s.w - m && r.y + r.h <= s.y + s.h - m;
}

function touches(a: Rect, b: Rect, m: number): boolean {
	return a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
}

/** the rect `w` x `h` centred on (cx, cy), on the 8 u grid */
function rectAt(cx: number, cy: number, w: number, h: number): Rect {
	return { x: snap8(cx - w / 2), y: snap8(cy - h / 2), w, h };
}

/** the side a thing facing the way `side`'s outward normal points faces (the opposite side) */
function opposite(side: DoorSide): DoorSide {
	if (side === "top") return "bottom";
	if (side === "bottom") return "top";
	if (side === "left") return "right";
	return "left";
}

function distToRect(x: number, y: number, r: Rect): number {
	const dx = math.max(r.x - x, 0, x - (r.x + r.w));
	const dy = math.max(r.y - y, 0, y - (r.y + r.h));
	return math.sqrt(dx * dx + dy * dy);
}

// ---------------------------------------------------------------------------------------------- the empty paving

/** the yard's 32 u cells a square may take: none within SQUARE_CLEAR of a building, SOLID_CLEAR of anything else */
interface Grid {
	x0: number;
	y0: number;
	cols: number;
	rows: number;
	free: Array<boolean>;
}

function blockGrid(g: Grid, ax: number, ay: number, bx: number, by: number): void {
	const i0 = math.max(0, math.floor((ax - g.x0) / CELL));
	const i1 = math.min(g.cols - 1, math.ceil((bx - g.x0) / CELL) - 1);
	const j0 = math.max(0, math.floor((ay - g.y0) / CELL));
	const j1 = math.min(g.rows - 1, math.ceil((by - g.y0) / CELL) - 1);
	for (let j = j0; j <= j1; j++) {
		for (let i = i0; i <= i1; i++) g.free[j * g.cols + i] = false;
	}
}

/**
 * The block's empty paving, rasterised: every solid round it (a building by its box and SQUARE_CLEAR, anything else
 * by SOLID_CLEAR; a building's walls and furniture are inside its box), every ground rect of the lot (a walk to a
 * door, a driveway, a parking lot, a tree's planter, the bank's steps) and every reserved zone (a door's approach).
 */
export function emptyPaving(kit: TownKit, lot: Lot): Grid {
	const y = lot.yard;
	const g: Grid = { x0: y.x, y0: y.y, cols: math.floor(y.w / CELL), rows: math.floor(y.h / CELL), free: [] };
	for (let k = 0; k < g.cols * g.rows; k++) g.free.push(true);
	for (const s of kit.solidsIn(y.x - 128, y.y - 128, y.w + 256, y.h + 256)) {
		if (s.parentId !== undefined || s.removed === true) continue;
		const p = s.kind === "building" ? SQUARE_CLEAR : SOLID_CLEAR;
		blockGrid(g, s.x - p, s.y - p, s.x + s.w + p, s.y + s.h + p);
	}
	for (const q of lot.ground) blockGrid(g, q.x - 16, q.y - 16, q.x + q.w + 16, q.y + q.h + 16);
	for (let j = 0; j < g.rows; j++) {
		for (let i = 0; i < g.cols; i++) {
			const k = j * g.cols + i;
			if (g.free[k] && kit.reserved(g.x0 + i * CELL, g.y0 + j * CELL, CELL, CELL)) g.free[k] = false;
		}
	}
	return g;
}

/** the largest free rectangle of the grid whose sides are both at least `min` (the first found of equal ones) */
export function largestFree(g: Grid, min: number): Rect | undefined {
	const n = math.ceil(min / CELL);
	const hgt: Array<number> = [];
	for (let i = 0; i < g.cols; i++) hgt.push(0);
	let best: Rect | undefined;
	let bestArea = 0;
	for (let j = 0; j < g.rows; j++) {
		for (let i = 0; i < g.cols; i++) hgt[i] = g.free[j * g.cols + i] ? hgt[i] + 1 : 0;
		for (let i = 0; i < g.cols; i++) {
			let h = math.huge;
			for (let k = i; k < g.cols; k++) {
				h = math.min(h, hgt[k]);
				if (h < n) break;
				const wc = k - i + 1;
				if (wc < n || wc * h <= bestArea) continue;
				bestArea = wc * h;
				best = { x: g.x0 + i * CELL, y: g.y0 + (j - h + 1) * CELL, w: wc * CELL, h: h * CELL };
			}
		}
	}
	return best;
}

/** a free stretch as squares: one, or two PATH apart when it is much longer than wide */
function asSquares(r: Rect): Array<Rect> {
	const ax = r.w >= r.h;
	const long = ax ? r.w : r.h;
	const short = ax ? r.h : r.w;
	if (long < short * SPLIT_ASPECT || long < SQUARE_MIN * 2 + PATH) return [r];
	const half = math.floor((long - PATH) / 2 / 8) * 8;
	if (ax) {
		return [
			{ x: r.x, y: r.y, w: half, h: r.h },
			{ x: r.x + r.w - half, y: r.y, w: half, h: r.h },
		];
	}
	return [
		{ x: r.x, y: r.y, w: r.w, h: half },
		{ x: r.x, y: r.y + r.h - half, w: r.w, h: half },
	];
}

// ---------------------------------------------------------------------------------------------- the deck

interface Deck {
	rng: SquareRng;
	cards: Array<SquareProgram>;
	/** how many squares each program has made, and where its looks start */
	made: Record<SquareProgram, number>;
	start: Record<SquareProgram, number>;
	cleared: boolean;
}

function shuffled(rng: SquareRng, list: ReadonlyArray<SquareProgram>): Array<SquareProgram> {
	const out = [...list];
	for (let i = out.size() - 1; i > 0; i--) {
		const j = rng.int(0, i);
		const t = out[i];
		out[i] = out[j];
		out[j] = t;
	}
	return out;
}

function newDeck(town: number): Deck {
	const rng = new SquareRng(deckSeed(town));
	const cards = shuffled(rng, PROGRAMS);
	const cleared = rng.chance(CLEARED_SHARE);
	if (cleared) {
		// somewhere after the first card (the validators' shims have no Array.insert: moved by hand)
		const at = rng.int(1, cards.size());
		cards.push("cleared");
		for (let i = cards.size() - 1; i > at; i--) {
			cards[i] = cards[i - 1];
			cards[i - 1] = "cleared";
		}
	}
	const start = {} as Record<SquareProgram, number>;
	const made = {} as Record<SquareProgram, number>;
	for (const p of [...PROGRAMS, "cleared" as SquareProgram]) {
		start[p] = rng.int(0, SQUARE_LOOKS[p] - 1);
		made[p] = 0;
	}
	return { rng, cards, made, start, cleared };
}

/**
 * The next program the deck holds that fits a square this short and is not at its cap; a spent deck is shuffled again
 * (no cleared lot); the grove when nothing else can
 */
function deal(d: Deck, short: number): SquareProgram {
	for (let pass = 0; pass < 2; pass++) {
		for (let i = 0; i < d.cards.size(); i++) {
			const p = d.cards[i];
			if (SQUARE_MIN_SIDE[p] > short || d.made[p] >= SQUARE_CAP[p]) continue;
			d.cards.remove(i);
			return p;
		}
		for (const p of shuffled(d.rng, PROGRAMS)) d.cards.push(p);
	}
	return "grove";
}

// ---------------------------------------------------------------------------------------------- laying a square

/** one square being laid: its rect, its stream, what it took (pieces, the mosaic, the decals: nothing overlaps them) */
interface Sq {
	kit: TownKit;
	lot: Lot;
	s: Rect;
	rng: SquareRng;
	look: number;
	pieces: number;
	taken: Array<Rect>;
	benches: Array<Solid>;
	/** every fixture it has so far (a bin may stand a sealed step off any of them) */
	placed: Array<Solid>;
	/** what lies on its floor (nothing that stands is put over it) */
	decals: Array<Rect>;
	/** its paving has its pattern (the mosaic, a bed, a deck, bare earth), or this many trees in grates */
	pattern: boolean;
	pits: number;
	/** where a pocket park's hopscotch is chalked (dressFloor) */
	chalk?: Rect;
	/** a cafe's deck: what the customers dropped lies on it (dressFloor) */
	deck?: Rect;
	/** its mosaic: weeds come up in its joints too (dressFloor) */
	mosaic?: Rect;
}

/** does `r` cover something lying on the square's floor? */
function onDecal(sq: Sq, r: Rect): boolean {
	for (const d of sq.decals) if (touches(d, r, 0)) return true;
	return false;
}

/**
 * A standing piece at `r` if it fits: inside the square, free (`canPlace` with a margin), pinching no slot with what
 * stands round it (EDI-11) and closing off no ground (CID-05); undefined otherwise.
 */
function stand(sq: Sq, tags: string, r: Rect, low: boolean, extra?: Partial<Solid>): Solid | undefined {
	const kit = sq.kit;
	if (!within(sq.s, r, 0) || onDecal(sq, r) || !kit.canPlace(r.x, r.y, r.w, r.h, 8)) return undefined;
	if (pinchesAny(kit, r) || closesPocket(kit, r)) return undefined;
	const s = prop(kit, tags, r, low, extra);
	sq.pieces += 1;
	sq.taken.push(r);
	sq.placed.push(s);
	return s;
}

/** a litter bin with its corner at (x, y), on the same terms */
function binAt(sq: Sq, x: number, y: number): boolean {
	const kit = sq.kit;
	const r = { x, y, w: TOWN.TRASH, h: TOWN.TRASH };
	if (!within(sq.s, r, 0) || onDecal(sq, r) || !kit.canPlace(x, y, r.w, r.h, 8)) return false;
	if (pinchesAny(kit, r) || closesPocket(kit, r)) return false;
	kit.bin(x, y);
	sq.pieces += 1;
	sq.taken.push(r);
	return true;
}

/** a tree whose trunk stands at (x, y), a car's length off every street corner (VEG-01); in a planter on paving */
function treeAt(sq: Sq, x: number, y: number, site: TreeSite, pit: boolean): boolean {
	const kit = sq.kit;
	const t = TOWN.TREE_TRUNK;
	const r = { x: x - t / 2, y: y - t / 2, w: t, h: t };
	if (!within(sq.s, r, 24) || onDecal(sq, { x: x - 36, y: y - 36, w: 72, h: 72 })) return false;
	for (const j of kit.w.junctions) if (distToRect(x, y, j) < TOWN.CORNER_CLEAR + 24) return false;
	if (!kit.canPlace(r.x, r.y, t, t, 24) || pinchesAny(kit, r) || closesPocket(kit, r)) return false;
	kit.tree(x, y, site);
	if (pit) {
		sq.lot.ground.push({ x: x - 36, y: y - 36, w: 72, h: 72, kind: "pit" });
		sq.pits += 1;
	}
	sq.pieces += 1;
	sq.taken.push(r);
	return true;
}

/**
 * A flat thing of the square's floor at `r`: never under anything standing, never over another -- but for `over`, the
 * floor it is meant to lie on (a vigil on the mosaic at the memorial's foot, paper on a cafe's deck)
 */
function floor(sq: Sq, kind: GroundKind, r: Rect, variant?: number, over?: Rect): boolean {
	if (!within(sq.s, r, 0)) return false;
	for (const q of sq.taken) if (q !== over && touches(q, r, 8)) return false;
	// under a tree's trunk or anything standing, never; under a parasol, as under a tree's crown, it may
	for (const o of sq.kit.solidsIn(r.x - 4, r.y - 4, r.w + 8, r.h + 8)) if (o.kind !== "canopy") return false;
	sq.lot.ground.push({ x: r.x, y: r.y, w: r.w, h: r.h, kind, variant });
	sq.taken.push(r);
	if (kind === "medallion") {
		sq.pattern = true;
		sq.mosaic = r;
	} else {
		sq.decals.push(r);
	}
	return true;
}

/** a decal of the floor somewhere in `area` (the square by default): a few tries from the square's stream */
function scatter(sq: Sq, kind: string, area?: Rect, over?: Rect): boolean {
	const size = DECAL_SIZE[kind];
	const turn = size[0] !== size[1] && sq.rng.chance(0.5);
	const w = turn ? size[1] : size[0];
	const h = turn ? size[0] : size[1];
	const a = area ?? sq.s;
	for (let t = 0; t < 10; t++) {
		const x = snap8(a.x + sq.rng.next() * math.max(0, a.w - w));
		const y = snap8(a.y + sq.rng.next() * math.max(0, a.h - h));
		if (floor(sq, kind as GroundKind, { x, y, w, h }, undefined, over)) return true;
	}
	return false;
}

/** the paving's mosaic, centred on (cx, cy): the larger one on a wide square */
function medallion(sq: Sq, cx: number, cy: number): Rect | undefined {
	const wide = math.min(sq.s.w, sq.s.h) >= MEDALLION_LARGE_FROM;
	for (const m of MEDALLION_SIZES) {
		if (m > MEDALLION_SIZES[1] && !wide) continue;
		const r = rectAt(cx, cy, m, m);
		if (floor(sq, "medallion", r, sq.look % ART_LOOKS)) return r;
	}
	return undefined;
}

/** a bench at (cx, cy) whose seat faces `face` (along x when it faces up or down) */
function bench(sq: Sq, cx: number, cy: number, face: DoorSide): boolean {
	const ax = face === "top" || face === "bottom";
	const s = stand(sq, "bench", rectAt(cx, cy, ax ? BENCH_L : BENCH_D, ax ? BENCH_D : BENCH_L), true, { face });
	if (s !== undefined) sq.benches.push(s);
	return s !== undefined;
}

/** four benches round (cx, cy), `d` out, each facing it */
function benchRing(sq: Sq, cx: number, cy: number, d: number, sides: ReadonlyArray<DoorSide>): void {
	for (const side of sides) {
		if (side === "top") bench(sq, cx, cy - d, "bottom");
		else if (side === "bottom") bench(sq, cx, cy + d, "top");
		else if (side === "left") bench(sq, cx - d, cy, "right");
		else bench(sq, cx + d, cy, "left");
	}
}

/** lamp posts on the diagonals of (cx, cy), `d` out along each axis (dark: the power is out, LUZ-02) */
function lampPosts(sq: Sq, cx: number, cy: number, d: number, most: number): void {
	let n = 0;
	for (const [sx, sy] of [
		[-1, -1],
		[1, 1],
		[1, -1],
		[-1, 1],
	]) {
		if (n >= most) break;
		if (stand(sq, "lamppost", rectAt(cx + sx * d, cy + sy * d, LAMPPOST, LAMPPOST), false) !== undefined) n++;
	}
}

/** a planter in each corner of the square that takes one (flowers or a clipped shrub, by the square's look) */
function cornerPlanters(sq: Sq, inset: number): void {
	const s = sq.s;
	const P = PLANTER;
	for (const [x, y] of [
		[s.x + inset, s.y + inset],
		[s.x + s.w - inset - P, s.y + inset],
		[s.x + inset, s.y + s.h - inset - P],
		[s.x + s.w - inset - P, s.y + s.h - inset - P],
	]) {
		stand(sq, "planter", { x: snap8(x), y: snap8(y), w: P, h: P }, true, { variant: sq.look % ART_LOOKS });
	}
}

/** a litter bin at an end of some of the benches, a sealed step from it (never a slot: EDI-11) */
function binsByBenches(sq: Sq, most: number): void {
	let n = 0;
	const T = TOWN.TRASH;
	for (const b of sq.benches) {
		if (n >= most) break;
		const ax = b.w >= b.h;
		const spots: Array<[number, number]> = ax
			? [
					[b.x + b.w + 12, b.y + b.h / 2 - T / 2],
					[b.x - 12 - T, b.y + b.h / 2 - T / 2],
				]
			: [
					[b.x + b.w / 2 - T / 2, b.y + b.h + 12],
					[b.x + b.w / 2 - T / 2, b.y - 12 - T],
				];
		for (const [x, y] of spots) {
			if (binAt(sq, snap8(x), snap8(y))) {
				n++;
				break;
			}
		}
	}
}

/** the side of the square along its block's street (the yard's edge on a street), if it has one */
function streetSide(sq: Sq): DoorSide | undefined {
	const s = sq.s;
	const y = sq.lot.yard;
	for (const e of sq.lot.edges) {
		if (e.side === "top" && s.y <= y.y + 8) return "top";
		if (e.side === "bottom" && s.y + s.h >= y.y + y.h - 8) return "bottom";
		if (e.side === "left" && s.x <= y.x + 8) return "left";
		if (e.side === "right" && s.x + s.w >= y.x + y.w - 8) return "right";
	}
	return undefined;
}

/** a rect `l` along side `side` of the square and `d` deep, `inset` in from it, centred at `u` along it */
function alongSide(s: Rect, side: DoorSide, u: number, l: number, d: number, inset: number): Rect {
	if (side === "top") return { x: snap8(u - l / 2), y: s.y + inset, w: l, h: d };
	if (side === "bottom") return { x: snap8(u - l / 2), y: s.y + s.h - inset - d, w: l, h: d };
	if (side === "left") return { x: s.x + inset, y: snap8(u - l / 2), w: d, h: l };
	return { x: s.x + s.w - inset - d, y: snap8(u - l / 2), w: d, h: l };
}

/** the middle of a side, as a distance along it */
function sideMid(s: Rect, side: DoorSide): number {
	return alongX(side) ? s.x + s.w / 2 : s.y + s.h / 2;
}

// ---------------------------------------------------------------------------------------------- the programs

const ALL_SIDES: ReadonlyArray<DoorSide> = ["top", "bottom", "left", "right"];

/** a civic square: the fountain in the middle of the mosaic, benches facing it, lamp posts, planters, bins */
function fountainSquare(sq: Sq, cx: number, cy: number): void {
	medallion(sq, cx, cy);
	stand(sq, "fountain", rectAt(cx, cy, FOUNTAIN, FOUNTAIN), true);
	benchRing(sq, cx, cy, 152, ALL_SIDES);
	lampPosts(sq, cx, cy, 168, 4);
	cornerPlanters(sq, 24);
	binsByBenches(sq, 2);
}

/**
 * The town's memorial on its plinth in the middle of the mosaic, and at its foot what people left there in the first
 * days (the vigil: flowers, candles burnt down); planters either side, benches facing it, the notice board of flyers
 */
function memorialSquare(sq: Sq, cx: number, cy: number): void {
	const mosaic = medallion(sq, cx, cy);
	stand(sq, "statue", rectAt(cx, cy, STATUE, STATUE), false);
	floor(sq, "vigil", rectAt(cx, cy + STATUE / 2 + 8 + 16, 64, 32), undefined, mosaic);
	// benches facing it: a pair in front and one behind, or (a square too shallow for them) either side of it
	for (const sx of [-1, 1]) bench(sq, cx + sx * 80, cy + 152, "top");
	bench(sq, cx, cy - 152, "bottom");
	if (sq.benches.size() === 0) {
		bench(sq, cx - 168, cy, "right");
		bench(sq, cx + 168, cy, "left");
	}
	// flowers either side of the plinth, or on its diagonals where the benches stand
	for (const sx of [-1, 1]) {
		const v = { variant: sq.look % ART_LOOKS };
		if (stand(sq, "planter", rectAt(cx + sx * 144, cy, PLANTER, PLANTER), true, v) !== undefined) continue;
		stand(sq, "planter", rectAt(cx + sx * 120, cy - 96, PLANTER, PLANTER), true, v);
	}
	const side = streetSide(sq) ?? "top";
	noticeBoard(sq, side, cx, cy);
	lampPosts(sq, cx, cy, 176, 2);
	binsByBenches(sq, 1);
}

/** the notice board near the square's street side, facing into the square (a few tries along that side) */
function noticeBoard(sq: Sq, side: DoorSide, cx: number, cy: number): void {
	const mid = sideMid(sq.s, side);
	const face = opposite(side);
	const ax = alongX(side);
	for (const off of [0, -120, 120, -200, 200]) {
		const r = alongSide(sq.s, side, mid + off, BOARD_L, BOARD_D, 32);
		// never across the square's middle (the centrepiece's ring)
		if (math.abs((ax ? r.y + r.h / 2 : r.x + r.w / 2) - (ax ? cy : cx)) < 120) continue;
		if (stand(sq, "noticeboard", r, false, { face }) !== undefined) return;
	}
}

/** a pocket park: the planted bed with its trees, benches round it facing it, a hopscotch on the paving */
function gardenSquare(sq: Sq, cx: number, cy: number): void {
	const s = sq.s;
	const inset = math.min(s.w, s.h) >= 384 ? 96 : 72;
	const bed = { x: s.x + inset, y: s.y + inset, w: s.w - inset * 2, h: s.h - inset * 2 };
	sq.lot.ground.push({ ...bed, kind: "bed" });
	sq.pattern = true;
	const ax = bed.w >= bed.h;
	const long = ax ? bed.w : bed.h;
	const n = math.clamp(math.floor(long / 224), 1, 3);
	for (let k = 0; k < n; k++) {
		const u = (ax ? bed.x : bed.y) + ((k + 0.5) * long) / n;
		treeAt(sq, snap8(ax ? u : cx), snap8(ax ? cy : u), "plaza", false);
	}
	// the benches at the bed's edge between its trees (or its quarters), facing the lawn
	const us: Array<number> = [];
	if (n === 1) us.push(0.25, 0.75);
	else for (let k = 1; k < n; k++) us.push(k / n);
	for (const f of us) {
		const u = snap8((ax ? bed.x : bed.y) + f * long);
		if (ax) {
			bench(sq, u, bed.y - 16 - BENCH_D / 2, "bottom");
			bench(sq, u, bed.y + bed.h + 16 + BENCH_D / 2, "top");
		} else {
			bench(sq, bed.x - 16 - BENCH_D / 2, u, "right");
			bench(sq, bed.x + bed.w + 16 + BENCH_D / 2, u, "left");
		}
	}
	// the bed's short ends: a planter each, and a bin by a bench
	for (const sgn of [-1, 1]) {
		const d = long / 2 + 16 + PLANTER / 2;
		stand(sq, "planter", rectAt(ax ? cx + sgn * d : cx, ax ? cy : cy + sgn * d, PLANTER, PLANTER), true, {
			variant: sq.look % ART_LOOKS,
		});
	}
	binsByBenches(sq, 1);
	// the hopscotch, chalked on the paving along one side of the bed (with the rest of the floor: dressFloor)
	sq.chalk = ax
		? { x: s.x, y: sq.rng.chance(0.5) ? s.y : bed.y + bed.h, w: s.w, h: inset }
		: { x: sq.rng.chance(0.5) ? s.x : bed.x + bed.w, y: s.y, w: inset, h: s.h };
}

/** a paved court of trees in their grates down the square, a bench against each grate facing out; the mosaic between */
function groveSquare(sq: Sq, cx: number, cy: number): void {
	const s = sq.s;
	const ax = s.w >= s.h;
	const long = ax ? s.w : s.h;
	const short = ax ? s.h : s.w;
	const a0 = ax ? s.x : s.y;
	const P = GROVE_PITCH;
	// what grows in the grates: a street's narrow kinds, or (the other three looks) a planter's mix with young trees
	const site: TreeSite = sq.look >= 3 ? "shop" : "pit";
	const rows: Array<number> = short >= 416 ? [-(short / 2 - 104), short / 2 - 104] : [0];
	const n = math.max(1, math.floor((long - 176) / P) + 1);
	if (n === 1 && rows.size() === 1) {
		// room for one tree down the middle: two on a diagonal (diagonal neighbours leave no slot), or at its two ends
		const d = short / 2 - 72;
		const e = long / 2 - 72;
		let planted = 0;
		for (const [du, dv] of [
			[-d, -d],
			[d, d],
			[d, -d],
			[-d, d],
			[-e, 0],
			[e, 0],
		]) {
			if (planted >= 2) break;
			const x = snap8(cx + (ax ? du : dv));
			const y = snap8(cy + (ax ? dv : du));
			if (!treeAt(sq, x, y, site, true)) continue;
			planted++;
			// its bench against the grate, on the side towards the square's middle, facing along the square
			const sx = x < cx ? 1 : -1;
			bench(sq, x + sx * 50, y, sx > 0 ? "right" : "left");
		}
		binsByBenches(sq, 1);
		return;
	}
	const first = a0 + (long - (n - 1) * P) / 2;
	// the middle slot of one odd row is the mosaic's
	const mid = n >= 3 && n % 2 === 1 && rows.size() === 1 ? (n - 1) / 2 : -1;
	const off = TOWN.TREE_TRUNK / 2 + 16 + BENCH_D / 2;
	for (let r = 0; r < rows.size(); r++) {
		const v = rows[r];
		for (let k = 0; k < n; k++) {
			if (k === mid) continue;
			const u = snap8(first + k * P);
			const x = ax ? u : snap8(cx + v);
			const y = ax ? snap8(cy + v) : u;
			if (!treeAt(sq, x, y, site, true)) continue;
			// the bench on the side away from the other row (alternating along a single one, from the look's side)
			const sgn = rows.size() > 1 ? (v < 0 ? -1 : 1) : (k + sq.look) % 2 === 0 ? 1 : -1;
			if (ax) bench(sq, x, y + sgn * off, sgn > 0 ? "bottom" : "top");
			else bench(sq, x + sgn * off, y, sgn > 0 ? "right" : "left");
		}
	}
	if (mid >= 0) {
		const u = snap8(first + mid * P);
		medallion(sq, ax ? u : cx, ax ? cy : u);
	}
	binsByBenches(sq, 1);
}

/** a cafe's terrace: tables and chairs in rows, parasols over some, one pushed back, one knocked over as they ran */
function cafeSquare(sq: Sq, cx: number, cy: number): void {
	const s = sq.s;
	const E = 32;
	const nx = math.clamp(math.floor((s.w - E * 2 - CAFE_TABLE) / CAFE_PITCH) + 1, 1, 4);
	const ny = math.clamp(math.floor((s.h - E * 2 - CAFE_TABLE) / CAFE_PITCH) + 1, 1, 4);
	const x0 = cx - ((nx - 1) * CAFE_PITCH) / 2;
	const y0 = cy - ((ny - 1) * CAFE_PITCH) / 2;
	// the terrace's timber deck under the tables (the cafe's floor: no mosaic, no drain, no weeds on it)
	const dw = (nx - 1) * CAFE_PITCH + CAFE_TABLE + 48;
	const dh = (ny - 1) * CAFE_PITCH + CAFE_TABLE + 48;
	const deck = rectAt(cx, cy, math.min(dw, s.w - 16), math.min(dh, s.h - 16));
	sq.lot.ground.push({ ...deck, kind: "terrace" });
	sq.taken.push(deck);
	sq.pattern = true;
	sq.deck = deck;
	let down = 0;
	for (let j = 0; j < ny; j++) {
		for (let i = 0; i < nx; i++) {
			const roll = sq.rng.next();
			const look = roll < 0.62 ? CAFE_SET : roll < 0.9 || down > 0 ? CAFE_PUSHED : CAFE_DOWN;
			// its spot, or a step off it where something round it pinches (EDI-11)
			let t: Solid | undefined;
			for (const [dx, dy] of CAFE_NUDGE) {
				if (t !== undefined) break;
				const r = rectAt(x0 + i * CAFE_PITCH + dx, y0 + j * CAFE_PITCH + dy, CAFE_TABLE, CAFE_TABLE);
				t = stand(sq, "cafe", r, true, { variant: look });
			}
			if (t === undefined) continue;
			if (look === CAFE_DOWN) down++;
			if (look !== CAFE_DOWN && sq.rng.chance(0.6)) parasol(sq, t);
		}
	}
	cornerPlanters(sq, 16);
	// what the customers left on the deck: the paper of their orders, a bag
	const papers = sq.rng.int(2, 4);
	for (let i = 0; i < papers; i++) scatter(sq, "paper", deck, deck);
	if (sq.rng.chance(0.4)) scatter(sq, "bag", deck, deck);
}

/** a parasol over a cafe table: aerial like a tent (passable, see-through with a body under it), over nothing else */
function parasol(sq: Sq, under: Solid): void {
	const kit = sq.kit;
	const r = rectAt(under.x + under.w / 2, under.y + under.h / 2, PARASOL, PARASOL);
	if (!within(sq.s, r, 0)) return;
	for (const o of kit.solidsIn(r.x, r.y, r.w, r.h)) {
		if (o !== under && (standing(o) || o.kind === "canopy")) return;
	}
	kit.add({
		kind: "canopy",
		x: r.x,
		y: r.y,
		w: r.w,
		h: r.h,
		hp: 999999,
		hpMax: 999999,
		destructible: false,
		tags: "parasol",
		passable: true,
		canopyAlpha: 1,
		variant: sq.look % ART_LOOKS,
	});
}

/** a newsstand on the corner of the street, the mosaic, benches, a notice board, lamp posts and bins */
function kioskSquare(sq: Sq, cx: number, cy: number): void {
	const s = sq.s;
	// on the street side of the square; a square inside its block has it at an end, its back to the nearer street
	const street = streetSide(sq);
	let side: DoorSide = street ?? nearerEnd(sq);
	let mid = sideMid(s, side);
	// its spot, a step along the side, or the far side where something round it pinches (EDI-11)
	let placed = false;
	for (const q of [side, opposite(side)]) {
		for (const off of [0, -48, 48, -96, 96]) {
			if (placed) break;
			const u = sideMid(s, q) + off;
			placed = stand(sq, "kiosk", alongSide(s, q, u, KIOSK_L, KIOSK_D, 24), false, { face: q }) !== undefined;
			if (placed) {
				side = q;
				mid = u;
			}
		}
	}
	// the mosaic and the benches in what is left of the square, and the notice board beside the kiosk
	let mx = cx;
	let my = cy;
	for (const push of [(KIOSK_D + 24) / 2, (KIOSK_D + 24) / 2 + 32]) {
		mx = cx;
		my = cy;
		if (side === "top") my = cy + push;
		else if (side === "bottom") my = cy - push;
		else if (side === "left") mx = cx + push;
		else mx = cx - push;
		mx = snap8(mx);
		my = snap8(my);
		if (medallion(sq, mx, my) !== undefined) break;
	}
	noticeBoardBeside(sq, side, mid);
	const sides: Array<DoorSide> = [];
	for (const q of ALL_SIDES) if (q !== side) sides.push(q);
	benchRing(sq, mx, my, 144, sides);
	lampPosts(sq, mx, my, 160, 2);
	binsByBenches(sq, 2);
	if (sq.pieces < SQUARE_PIECES_MIN) cornerPlanters(sq, 16);
}

/** the end of the square's long axis nearer one of its block's streets (where a kiosk inside the block stands) */
function nearerEnd(sq: Sq): DoorSide {
	const s = sq.s;
	const y = sq.lot.yard;
	if (s.w >= s.h) return s.x - y.x <= y.x + y.w - (s.x + s.w) ? "left" : "right";
	return s.y - y.y <= y.y + y.h - (s.y + s.h) ? "top" : "bottom";
}

/** the notice board along the street side, beside the kiosk (a step off it: the flyers face the square) */
function noticeBoardBeside(sq: Sq, side: DoorSide, mid: number): void {
	for (const off of [KIOSK_L / 2 + 16 + BOARD_L / 2, -(KIOSK_L / 2 + 16 + BOARD_L / 2), 200, -200]) {
		const r = alongSide(sq.s, side, mid + off, BOARD_L, BOARD_D, 32);
		if (stand(sq, "noticeboard", r, false, { face: opposite(side) }) !== undefined) return;
	}
}

/** a lot cleared for a building that never came: bare earth, rubble, a skip, road barriers along the sidewalk */
function clearedSquare(sq: Sq): void {
	const s = sq.s;
	sq.lot.ground.push({ x: s.x + 16, y: s.y + 16, w: s.w - 32, h: s.h - 32, kind: "waste" });
	sq.pattern = true;
	const side = streetSide(sq) ?? "top";
	const ax = alongX(side);
	// the barriers along the sidewalk, at the square's two ends (the middle open: the way in)
	const a0 = ax ? s.x : s.y;
	const a1 = ax ? s.x + s.w : s.y + s.h;
	for (const u of [a0 + 40 + BARRIER_L / 2, a1 - 40 - BARRIER_L / 2]) {
		stand(sq, "barrier", alongSide(s, side, u, BARRIER_L, BARRIER_D, 16), true, { face: side });
	}
	// the skip at the back
	const back = opposite(side);
	for (const off of [0, -96, 96, -160, 160]) {
		const r = alongSide(s, back, sideMid(s, back) + off, DUMPSTER_L, DUMPSTER_D, 32);
		if (stand(sq, "dumpster", r, false, { face: side }) !== undefined) break;
	}
	// the rubble, where it fell
	const want = sq.rng.int(2, 4);
	let got = 0;
	for (let t = 0; t < 24 && got < want; t++) {
		const turn = sq.rng.chance(0.5);
		const w = turn ? RUBBLE_D : RUBBLE_L;
		const h = turn ? RUBBLE_L : RUBBLE_D;
		const x = snap8(s.x + 40 + sq.rng.next() * math.max(0, s.w - 80 - w));
		const y = snap8(s.y + 40 + sq.rng.next() * math.max(0, s.h - 80 - h));
		if (stand(sq, "rubble", { x, y, w, h }, true, { variant: sq.rng.int(0, 2) }) !== undefined) got++;
	}
	if (sq.pieces < SQUARE_PIECES_MIN) cornerPlanters(sq, 24);
}

/**
 * A square its program left with too few pieces (a narrow one: what stands round its middle did not fit) gets planters in
 * its corners, lamp posts at the middle of its sides and benches along them, facing in, until it holds enough
 */
function fill(sq: Sq): void {
	const s = sq.s;
	if (sq.pieces >= SQUARE_PIECES_MIN) return;
	cornerPlanters(sq, 16);
	for (const side of ALL_SIDES) {
		if (sq.pieces >= SQUARE_PIECES_MIN) return;
		const mid = sideMid(s, side);
		stand(sq, "lamppost", alongSide(s, side, mid, LAMPPOST, LAMPPOST, 24), false);
	}
	for (const side of ALL_SIDES) {
		const ax = alongX(side);
		const len = ax ? s.w : s.h;
		const a0 = ax ? s.x : s.y;
		for (const f of [0.25, 0.75]) {
			if (sq.pieces >= SQUARE_PIECES_MIN) return;
			const r = alongSide(s, side, a0 + f * len, ax ? BENCH_L : BENCH_D, ax ? BENCH_D : BENCH_L, 16);
			const b = stand(sq, "bench", r, true, { face: opposite(side) });
			if (b !== undefined) sq.benches.push(b);
		}
	}
	// last, a lamp post or a bin in a corner
	const T = TOWN.TRASH;
	for (const [fx, fy] of [
		[0, 0],
		[1, 1],
		[1, 0],
		[0, 1],
	]) {
		if (sq.pieces >= SQUARE_PIECES_MIN) return;
		const x = s.x + 24 + fx * (s.w - 48 - LAMPPOST);
		const y = s.y + 24 + fy * (s.h - 48 - LAMPPOST);
		const lamp = { x: snap8(x), y: snap8(y), w: LAMPPOST, h: LAMPPOST };
		if (stand(sq, "lamppost", lamp, false) !== undefined) continue;
		binAt(sq, snap8(s.x + 16 + fx * (s.w - 32 - T)), snap8(s.y + 16 + fy * (s.h - 32 - T)));
	}
	// and, in a square crowded to its edges, a bin a sealed step off one of its fixtures (never a slot: EDI-11)
	for (const p of [...sq.placed]) {
		for (const [x, y] of [
			[p.x + p.w + 12, p.y + p.h / 2 - T / 2],
			[p.x - 12 - T, p.y + p.h / 2 - T / 2],
			[p.x + p.w / 2 - T / 2, p.y + p.h + 12],
			[p.x + p.w / 2 - T / 2, p.y - 12 - T],
		]) {
			if (sq.pieces >= SQUARE_PIECES_MIN) return;
			binAt(sq, snap8(x), snap8(y));
		}
	}
}

/** the floor every square has: a drain, cracked and sunken slabs, weeds in the joints, leaves, paper */
function dressFloor(sq: Sq, program: SquareProgram): void {
	const s = sq.s;
	if (sq.chalk !== undefined) scatter(sq, "chalk", sq.chalk);
	scatter(sq, "drain");
	if (s.w * s.h > 250000) scatter(sq, "drain");
	const cracks = sq.rng.int(1, 3) + (program === "cleared" ? 2 : 0);
	for (let i = 0; i < cracks; i++) scatter(sq, "cracked");
	const weeds = sq.rng.int(2, 4) + (program === "cleared" ? 3 : 0);
	for (let i = 0; i < weeds; i++) scatter(sq, "weeds");
	// the leaves under the trees in and round the square
	for (const t of sq.kit.solidsIn(s.x - 96, s.y - 96, s.w + 192, s.h + 192)) {
		if (t.kind !== "tree") continue;
		const n = sq.rng.int(1, 2);
		for (let i = 0; i < n; i++) scatter(sq, "leaves", { x: t.x - 96, y: t.y - 96, w: t.w + 192, h: t.h + 192 });
	}
	const papers = sq.rng.int(1, 3);
	for (let i = 0; i < papers; i++) scatter(sq, "paper");
	if (sq.rng.chance(0.3)) scatter(sq, "bag");
	// a square crowded with its pieces still has its weeds and its paper (FLOOR_MIN): on a cafe's deck, its paper
	for (let t = 0; t < 16 && sq.decals.size() < FLOOR_MIN; t++) {
		if (sq.deck !== undefined && t % 2 === 1) scatter(sq, "paper", sq.deck, sq.deck);
		else if (sq.mosaic !== undefined && t % 2 === 0) scatter(sq, "weeds", sq.mosaic, sq.mosaic);
		else scatter(sq, t % 2 === 0 ? "weeds" : "paper");
	}
}

/**
 * A square whose program found no room for its pattern (a kiosk's corner too tight for the mosaic): the mosaic where it
 * fits after all, the smaller first, or two trees in their grates
 */
function ensurePattern(sq: Sq, cx: number, cy: number): void {
	if (sq.pattern || sq.pits >= 2) return;
	const s = sq.s;
	for (const [fx, fy] of [
		[0, 0],
		[-0.25, 0],
		[0.25, 0],
		[0, -0.25],
		[0, 0.25],
	]) {
		for (const m of [MEDALLION_SIZES[1], MEDALLION_SIZES[2]]) {
			if (floor(sq, "medallion", rectAt(cx + fx * s.w, cy + fy * s.h, m, m), sq.look % ART_LOOKS)) return;
		}
	}
	const d = math.min(s.w, s.h) / 2 - 72;
	for (const [sx, sy] of [
		[-1, -1],
		[1, 1],
		[1, -1],
		[-1, 1],
	]) {
		if (sq.pits >= 2) return;
		treeAt(sq, snap8(cx + sx * d), snap8(cy + sy * d), "pit", true);
	}
}

/** one square: its program's pieces, then its floor */
function laySquare(kit: TownKit, lot: Lot, s: Rect, town: number, deck: Deck): TownSquare {
	const short = math.min(s.w, s.h);
	const program = deal(deck, short);
	const look = (deck.start[program] + deck.made[program]) % SQUARE_LOOKS[program];
	deck.made[program] += 1;
	const sq: Sq = {
		kit,
		lot,
		s,
		rng: new SquareRng(squareSeed(town, s.x, s.y)),
		look,
		pieces: 0,
		taken: [],
		benches: [],
		placed: [],
		decals: [],
		pattern: false,
		pits: 0,
	};
	const cx = snap8(s.x + s.w / 2);
	const cy = snap8(s.y + s.h / 2);
	if (program === "fountain") fountainSquare(sq, cx, cy);
	else if (program === "memorial") memorialSquare(sq, cx, cy);
	else if (program === "garden") gardenSquare(sq, cx, cy);
	else if (program === "grove") groveSquare(sq, cx, cy);
	else if (program === "cafe") cafeSquare(sq, cx, cy);
	else if (program === "kiosk") kioskSquare(sq, cx, cy);
	else clearedSquare(sq);
	fill(sq);
	ensurePattern(sq, cx, cy);
	dressFloor(sq, program);
	return { x: s.x, y: s.y, w: s.w, h: s.h, program, look };
}

/**
 * The downtown squares of the whole town (MOB-07): on every downtown block without a program of its own (the market,
 * the public parking lot), in the paving its shops left empty, up to SQUARES_PER_LOT a block. `pace` between two
 * blocks (a caller yielding: it draws nothing and touches nothing of the town).
 */
export function furnishSquares(kit: TownKit, town: number, pace?: () => void): void {
	const deck = newDeck(town);
	for (const lot of kit.w.lots) {
		if (lot.kind !== "block" || lot.zone !== "commercial" || lot.program !== undefined) continue;
		const g = emptyPaving(kit, lot);
		const made: Array<TownSquare> = [];
		while (made.size() < SQUARES_PER_LOT) {
			const r = largestFree(g, SQUARE_MIN);
			if (r === undefined) break;
			blockGrid(g, r.x - PATH, r.y - PATH, r.x + r.w + PATH, r.y + r.h + PATH);
			for (const s of asSquares(r)) {
				if (made.size() >= SQUARES_PER_LOT) break;
				made.push(laySquare(kit, lot, s, town, deck));
			}
		}
		if (made.size() > 0) lot.squares = made;
		if (pace !== undefined) pace();
	}
}
