/*
 * The college campus (docs/DESIGN_RULES.md EDI-17): where its four buildings, its quad and what stands on the quad go,
 * on one whole city block. The town generator (world.ts `placeCampus`) picks the block, clears it and applies this plan
 * once the rest of the town stands.
 *
 * Pure: integers on the 8-unit grid, its own MINSTD stream (never the town's), no Instances. The same seed gives the
 * same campus on the server and on every client (the map hash of §4.5 covers it).
 *
 * The layout is a PINWHEEL: each building faces its own street (EDI-01: a main door on every side of the block) and
 * is anchored at one corner, so between the end of one and the side of the next a LANE runs from each street into the
 * quad in the middle. That is how a small college fills a block: the halls on the streets, the green inside, four
 * ways in -- and for the game, a courtyard the horde reaches from every side (no dead end, EDI-15).
 *
 *        street                                     the main hall faces the town (the avenues' crossing), the
 *   ┌──────────────┐  lane                          dorm the other way, the library and the lab the two sides;
 *   │   HALL       │ ║ ┌────┐                        clockwise or not by the seed
 *   └──────────────┘ ║ │    │
 *   ┌────┐  ┌──────────┐ │ LAB│ street
 *   │    │  │   QUAD   │ │    │
 *   │LIB │  │    ◎     │ └────┘
 *   │    │  └──────────┘ ═════ lane
 *   └────┘ ┌──────────────┐
 *     lane │     DORM     │
 *          └──────────────┘
 */
import type { DoorSide, Rect } from "./world";

/** the four buildings' types (shared/data/buildings.ts BuildingType.Campus*) */
const HALL = 12;
const LIBRARY = 13;
const LAB = 14;
const DORM = 15;

/** a campus building's front lawn: from the yard's street edge to its facade (civic, EDI-02) */
export const CAMPUS_SETBACK = 48;
/** a lane between two buildings, from a street into the quad: wider than an alley (96), two bodies and a margin */
export const CAMPUS_LANE = 112;
/** depth of the main hall (two rows of rooms: lecture rooms and the lobby, offices and the back hall) */
export const CAMPUS_HALL_DEPTH = 400;
/** depth of the library, the lab and the dorm */
export const CAMPUS_DEPTH = 352;
/** a building's length along its street: no shorter (three rooms side by side), no longer (no endless bar) */
export const CAMPUS_LEN_MIN = 600;
export const CAMPUS_LEN_MAX = 760;
/** the quad: at least this much green between the four buildings */
export const CAMPUS_QUAD_MIN = 400;
/** outdoors like indoors (EDI-11): two things either touch, stand SEALED close, or leave PATH between them */
const PATH = 88;
const SEALED = 30;
/** what the quad keeps clear along every wall: the back doors' approach (80) and the windows the horde climbs */
const WALL_CLEAR = 104;
/** a trunk keeps a body's path (PATH) and a little from the walls: the canopy is aerial, the trunk is not */
const TREE_WALL_CLEAR = 96;
/** the quad's paving: a walk round it along the walls, a cross through it, the plaza in the middle (a share of the
 * quad's short side, within these bounds) */
const RING = 48;
const CROSS = 56;
const PLAZA_MIN = 144;
const PLAZA_MAX = 240;
/** the centrepiece: a fountain's basin, or a statue on its plinth */
const FOUNTAIN = 88;
const STATUE = 48;
/** a bench, and a tree's trunk (TOWN.TREE_TRUNK) */
const BENCH_L = 64;
const BENCH_D = 24;
const TRUNK = 44;

export type CampusRole = "hall" | "library" | "lab" | "dorm";
export type CampusPropKind = "fountain" | "statue" | "bench";

export interface CampusBuilding {
	/** BuildingType (12 hall, 13 library, 14 lab, 15 dorm) */
	type: number;
	role: CampusRole;
	/** the footprint's box (world) */
	rect: Rect;
	/** the street its main door faces */
	side: DoorSide;
}

export interface CampusProp extends Rect {
	kind: CampusPropKind;
	/** a bench's seat faces this way (towards the quad's middle) */
	face: DoorSide;
}

export interface CampusGround extends Rect {
	/** "walk" (the lanes, the ring and the cross) or "patio" (the plaza) */
	kind: "walk" | "patio";
}

export interface CampusPlan {
	buildings: Array<CampusBuilding>;
	quad: Rect;
	/** each street's way into the quad: its side, and the span along that street where it meets the sidewalk */
	lanes: Array<{ side: DoorSide; rect: Rect; a: number; b: number }>;
	ground: Array<CampusGround>;
	props: Array<CampusProp>;
	/** tree trunks' centres, on the quad's grass */
	trees: Array<{ x: number; y: number }>;
}

/** MINSTD, like the town's and the interiors' */
export class CampusRng {
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

/** the campus's own stream from the town's seed (integers only: the server and a phone must agree to the bit) */
export function campusSeed(town: number): number {
	return ((math.floor(math.abs(town)) % 2147483000) * 7 + 99991) % 2147483646;
}

/** the four sides, clockwise from the top */
export const CAMPUS_SIDES: ReadonlyArray<DoorSide> = ["top", "right", "bottom", "left"];

function opposite(s: DoorSide): DoorSide {
	if (s === "top") return "bottom";
	if (s === "bottom") return "top";
	if (s === "left") return "right";
	return "left";
}

function snap(v: number): number {
	return math.floor(v / 8) * 8;
}

function rect(x0: number, y0: number, x1: number, y1: number): Rect {
	return { x: math.min(x0, x1), y: math.min(y0, y1), w: math.abs(x1 - x0), h: math.abs(y1 - y0) };
}

/**
 * The four buildings on `yard` (the block minus its sidewalks), the hall facing `hallSide`, the pinwheel turning
 * clockwise (`cw`) or not, the library and the lab swapped by `swap`. Undefined when the block is too small for this
 * way round: a building shorter than CAMPUS_LEN_MIN or a quad smaller than CAMPUS_QUAD_MIN.
 */
export function campusLayout(
	yard: Rect,
	hallSide: DoorSide,
	cw: boolean,
	swap: boolean,
): { buildings: Array<CampusBuilding>; quad: Rect; lanes: CampusPlan["lanes"] } | undefined {
	const m = CAMPUS_SETBACK;
	const g = CAMPUS_LANE;
	const X0 = yard.x;
	const Y0 = yard.y;
	const X1 = yard.x + yard.w;
	const Y1 = yard.y + yard.h;
	const W = yard.w;
	const H = yard.h;
	// who faces which street
	const role: Record<DoorSide, CampusRole> = { top: "hall", right: "hall", bottom: "hall", left: "hall" };
	const i = CAMPUS_SIDES.indexOf(hallSide);
	role[hallSide] = "hall";
	role[opposite(hallSide)] = "dorm";
	role[CAMPUS_SIDES[(i + 1) % 4]] = swap ? "lab" : "library";
	role[CAMPUS_SIDES[(i + 3) % 4]] = swap ? "library" : "lab";
	const depth = (s: DoorSide) => (role[s] === "hall" ? CAMPUS_HALL_DEPTH : CAMPUS_DEPTH);
	const Bt = depth("top");
	const Br = depth("right");
	const Bb = depth("bottom");
	const Bl = depth("left");
	// the quad: what the four depths leave in the middle
	const quad = rect(X0 + m + Bl, Y0 + m + Bt, X1 - m - Br, Y1 - m - Bb);
	if (quad.w < CAMPUS_QUAD_MIN || quad.h < CAMPUS_QUAD_MIN) return undefined;
	// each building runs from its corner towards the next one, a lane short of it
	const len = (room: number) => snap(math.min(CAMPUS_LEN_MAX, room));
	const Lt = len(W - 2 * m - (cw ? Br : Bl) - g);
	const Lr = len(H - 2 * m - (cw ? Bb : Bt) - g);
	const Lb = len(W - 2 * m - (cw ? Bl : Br) - g);
	const Ll = len(H - 2 * m - (cw ? Bt : Bb) - g);
	if (math.min(Lt, Lr, Lb, Ll) < CAMPUS_LEN_MIN) return undefined;
	const rects: Record<DoorSide, Rect> = cw
		? {
				top: rect(X0 + m, Y0 + m, X0 + m + Lt, Y0 + m + Bt),
				right: rect(X1 - m - Br, Y0 + m, X1 - m, Y0 + m + Lr),
				bottom: rect(X1 - m - Lb, Y1 - m - Bb, X1 - m, Y1 - m),
				left: rect(X0 + m, Y1 - m - Ll, X0 + m + Bl, Y1 - m),
			}
		: {
				top: rect(X1 - m - Lt, Y0 + m, X1 - m, Y0 + m + Bt),
				left: rect(X0 + m, Y0 + m, X0 + m + Bl, Y0 + m + Ll),
				bottom: rect(X0 + m, Y1 - m - Bb, X0 + m + Lb, Y1 - m),
				right: rect(X1 - m - Br, Y1 - m - Lr, X1 - m, Y1 - m),
			};
	const typeOf: Record<CampusRole, number> = { hall: HALL, library: LIBRARY, lab: LAB, dorm: DORM };
	const buildings: Array<CampusBuilding> = [];
	// the hall first (the campus's landmark), then clockwise
	for (let k = 0; k < 4; k++) {
		const s = CAMPUS_SIDES[(i + k) % 4];
		buildings.push({ type: typeOf[role[s]], role: role[s], rect: rects[s], side: s });
	}
	// the lanes: along each street, the stretch of yard between its building's free end and the next building,
	// from the sidewalk to the quad's edge
	const t = rects.top;
	const r = rects.right;
	const b = rects.bottom;
	const l = rects.left;
	const lanes: CampusPlan["lanes"] = cw
		? [
				{ side: "top", rect: rect(t.x + t.w, Y0, r.x, quad.y), a: t.x + t.w, b: r.x },
				{ side: "right", rect: rect(quad.x + quad.w, r.y + r.h, X1, b.y), a: r.y + r.h, b: b.y },
				{ side: "bottom", rect: rect(l.x + l.w, quad.y + quad.h, b.x, Y1), a: l.x + l.w, b: b.x },
				{ side: "left", rect: rect(X0, t.y + t.h, quad.x, l.y), a: t.y + t.h, b: l.y },
			]
		: [
				{ side: "top", rect: rect(l.x + l.w, Y0, t.x, quad.y), a: l.x + l.w, b: t.x },
				{ side: "left", rect: rect(X0, l.y + l.h, quad.x, b.y), a: l.y + l.h, b: b.y },
				{ side: "bottom", rect: rect(b.x + b.w, quad.y + quad.h, r.x, Y1), a: b.x + b.w, b: r.x },
				{ side: "right", rect: rect(quad.x + quad.w, t.y + t.h, X1, r.y), a: t.y + t.h, b: r.y },
			];
	return { buildings, quad, lanes };
}

/** do `a` and `b` leave a gap one body fits in and two do not (the EDI-11 slot)? Diagonal neighbours never do. */
function pinches(a: Rect, b: Rect): boolean {
	const du = math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
	const dv = math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
	if (du > 0 && dv > 0) return false;
	if (du === 0 && dv === 0) return true;
	const gap = math.max(du, dv);
	return gap >= SEALED && gap < PATH;
}

function overlaps(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * The quad's paving, its centrepiece, benches and trees. Everything that stands (a basin, a plinth, a bench, a trunk)
 * keeps WALL_CLEAR from the buildings (their back doors and windows open onto the quad) and, from everything else,
 * either SEALED close or PATH away (EDI-11 outdoors: no slot to be cornered in). What does not fit is left out: a
 * small quad has its centrepiece alone.
 */
export function campusQuad(
	quad: Rect,
	rng: CampusRng,
): { ground: Array<CampusGround>; props: Array<CampusProp>; trees: Array<{ x: number; y: number }> } {
	const ground: Array<CampusGround> = [];
	const props: Array<CampusProp> = [];
	const trees: Array<{ x: number; y: number }> = [];
	const cx = snap(quad.x + quad.w / 2);
	const cy = snap(quad.y + quad.h / 2);
	const x0 = quad.x;
	const y0 = quad.y;
	const x1 = quad.x + quad.w;
	const y1 = quad.y + quad.h;
	// the plaza round the centrepiece grows with the quad
	const P = math.clamp(math.floor((math.min(quad.w, quad.h) * 0.34) / 16) * 16, PLAZA_MIN, PLAZA_MAX);
	// the walk round the quad along the walls (the lanes arrive on it), the cross, the plaza
	ground.push({ ...rect(x0, y0, x1, y0 + RING), kind: "walk" });
	ground.push({ ...rect(x0, y1 - RING, x1, y1), kind: "walk" });
	ground.push({ ...rect(x0, y0 + RING, x0 + RING, y1 - RING), kind: "walk" });
	ground.push({ ...rect(x1 - RING, y0 + RING, x1, y1 - RING), kind: "walk" });
	ground.push({ ...rect(x0 + RING, cy - CROSS / 2, cx - P / 2, cy + CROSS / 2), kind: "walk" });
	ground.push({ ...rect(cx + P / 2, cy - CROSS / 2, x1 - RING, cy + CROSS / 2), kind: "walk" });
	ground.push({ ...rect(cx - CROSS / 2, y0 + RING, cx + CROSS / 2, cy - P / 2), kind: "walk" });
	ground.push({ ...rect(cx - CROSS / 2, cy + P / 2, cx + CROSS / 2, y1 - RING), kind: "walk" });
	ground.push({ ...rect(cx - P / 2, cy - P / 2, cx + P / 2, cy + P / 2), kind: "patio" });
	// the centrepiece: a fountain, or the founder on a plinth
	const statue = rng.chance(0.4);
	const c = statue ? STATUE : FOUNTAIN;
	const piece = rect(cx - c / 2, cy - c / 2, cx + c / 2, cy + c / 2);
	props.push({ ...piece, kind: statue ? "statue" : "fountain", face: "bottom" });
	/** stands clear of the walls by `clear`, off the paving, and neither pinches nor touches what already stands */
	const fits = (q: Rect, clear: number): boolean => {
		if (q.x < x0 + clear || q.y < y0 + clear || q.x + q.w > x1 - clear || q.y + q.h > y1 - clear) return false;
		for (const gr of ground) if (overlaps(q, gr)) return false;
		for (const p of props) if (pinches(q, p)) return false;
		for (const t of trees) {
			if (pinches(q, rect(t.x - TRUNK / 2, t.y - TRUNK / 2, t.x + TRUNK / 2, t.y + TRUNK / 2))) return false;
		}
		return true;
	};
	// the four quarters of grass between the walks: two diagonal ones get a tree, the other two a bench facing the
	// plaza (which pair is the seed's); each only where it stands clear
	const qx = [snap((x0 + RING + cx - CROSS / 2) / 2), snap((cx + CROSS / 2 + x1 - RING) / 2)];
	const qy = [snap((y0 + RING + cy - CROSS / 2) / 2), snap((cy + CROSS / 2 + y1 - RING) / 2)];
	const treeDiag = rng.chance(0.5) ? 0 : 1;
	// a bench lies along the quad's long side, its seat towards the plaza
	const horizontal = quad.w >= quad.h;
	for (let k = 0; k < 4; k++) {
		const ix = k % 2;
		const iy = math.floor(k / 2);
		const tree = (ix + iy) % 2 === treeDiag;
		const clear = tree ? TREE_WALL_CLEAR : WALL_CLEAR;
		const w = tree ? TRUNK : horizontal ? BENCH_L : BENCH_D;
		const h = tree ? TRUNK : horizontal ? BENCH_D : BENCH_L;
		// the middle of its quarter, pulled in from the walls as far as their clearance asks
		const px = ix === 0 ? math.max(x0 + clear + w / 2, qx[0]) : math.min(x1 - clear - w / 2, qx[1]);
		const py = iy === 0 ? math.max(y0 + clear + h / 2, qy[0]) : math.min(y1 - clear - h / 2, qy[1]);
		const bx = snap(px - w / 2);
		const by = snap(py - h / 2);
		const q = rect(bx, by, bx + w, by + h);
		if (!fits(q, clear)) continue;
		if (tree) {
			trees.push({ x: bx + w / 2, y: by + h / 2 });
			continue;
		}
		const face: DoorSide = horizontal ? (iy === 0 ? "bottom" : "top") : ix === 0 ? "right" : "left";
		props.push({ ...q, kind: "bench", face });
	}
	return { ground, props, trees };
}
