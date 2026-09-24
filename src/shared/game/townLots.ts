/*
 * The everyday town (docs/DESIGN_RULES.md EDI-18..EDI-23, MOB-04..MOB-06): what a small North American town holds
 * besides its houses and its shops -- the fire station on the avenue, the neighbourhood church, the bank on Main
 * Street, the street market, a public parking lot, a house going up, the parks' playgrounds and courts, the backyards'
 * sheds and pools, and the street furniture on the sidewalks' service strip.
 *
 * Pure layout, run once per town by shared/game/world.ts `generateTown`, which hands in a `TownKit`: the town's own
 * random stream and its placement rules (the same `canPlace` every tree, bin and car goes through, the reserved
 * zones, the sidewalk cuts), and the few builders it owns (a building on a street face, a car, a parking lot). This
 * module never imports world.ts at run time (a require cycle Luau refuses): only its types, and its own copy of the
 * two pure helpers it needs (`edgeRect`, `alongX`).
 *
 * Every fixture is a "prop" solid (tags: what it is): it blocks bodies, a `low` one lets bullets fly over, none hides
 * anyone from a zombie's eyes (shared/sim/ai/perception.ts `blocksSight` takes walls only). The roofs on posts -- a
 * market stall's tent, a bus shelter -- are "canopy" solids like the gas station's (aerial, passable, see-through with
 * a body under them). A searchable one (a market stall, a food truck, a pile of building material, a garden shed)
 * carries `lootSlots` and is rolled like a gas station's pump island (shared/sim/loot.ts `yardLootRows`).
 *
 * Nothing here ever stands in a sidewalk's clear path, in front of a doorway, on a driveway or within a car length of
 * a street corner (CID-01..03, EDI-01, VEG-01), and between two obstacles there is either no gap or a gap of two
 * bodies at least (EDI-11's rule, outdoors: nobody is cornered in a slot).
 */
import { TOWN } from "shared/engine/constants";
import type { DoorSide, GroundKind, Lot, LotEdge, Rect, Solid, WorldData } from "./world";

// ---------------------------------------------------------------------------------------------- the kit

/** the town's random stream (world.ts TownRng): every draw here moves it, like the generator's own */
export interface KitRng {
	next(): number;
	range(a: number, b: number): number;
	int(a: number, b: number): number;
	chance(p: number): boolean;
}

/** a free stretch of a lot's yard opening onto edge `e`: [u0,u1] along it × [v0,v1] from its curb */
export interface FreeFront {
	u0: number;
	u1: number;
	v0: number;
	v1: number;
}

/** a building the town placed (world.ts `Placed`), as this module reads it */
export interface PlacedBuilding {
	solid: Solid;
	edge: LotEdge;
	doorU: number;
	type: number;
}

export interface TownKit {
	w: WorldData;
	rng: KitRng;
	/** free of every solid (building boxes too), reserved zone and boss plaza, and of roads unless `allowRoad` */
	canPlace: (x: number, y: number, w: number, h: number, pad: number, allowRoad?: boolean) => boolean;
	/** keeps a rect out of every later placement (a parking lot, a court, a playground, a door's approach) */
	reserve: (r: Rect) => void;
	/** is the rect inside a reserved zone? */
	reserved: (x: number, y: number, w: number, h: number) => boolean;
	/** a building of type `t` on edge `e` starting `u` along it, `setback` behind the sidewalk; undefined: no room */
	build: (lot: Lot, e: LotEdge, t: number, u: number, setback: number) => Solid | undefined;
	/** a paved stretch of the edge's service strip (no tree, no bin, no lamp there) */
	cut: (e: LotEdge, a: number, b: number, kind: GroundKind) => void;
	/** is [u0,u1] of the edge's service strip (± margin) in a cut? */
	inCut: (e: LotEdge, u0: number, u1: number, margin: number) => boolean;
	/** nobody parks in front of [u0,u1] of the edge */
	noParking: (e: LotEdge, u0: number, u1: number) => void;
	/** a parking lot opening onto `e` over the free stretch (world.ts addParking); false: it did not fit */
	parking: (lot: Lot, e: LotEdge, free: FreeFront) => boolean;
	/** the largest free stretch of the lot's yard opening onto any of its streets (world.ts bestFrontRect) */
	freeFront: (lot: Lot, minAlong: number, minDepth: number) => { e: LotEdge; r: FreeFront } | undefined;
	/** a car (world.ts addCar) */
	car: (x: number, y: number, w: number, h: number, heading: number) => Solid;
	/** a solid of the town (world.ts addSolid) */
	add: (s: Omit<Solid, "id">) => Solid;
	/** the buildings placed on a lot so far */
	placedOn: (lot: Lot) => Array<PlacedBuilding>;
	/** every solid touching the rect (world.ts querySolids) */
	solidsIn: (x: number, y: number, w: number, h: number) => Array<Solid>;
	/** the street trees' lattice along a road (world.ts streetTrees): both sides of a street line up on it */
	treeLattice: (road: number) => { pitch: number; phase: number };
}

// ---------------------------------------------------------------------------------------------- geometry

export function alongX(side: DoorSide): boolean {
	return side === "top" || side === "bottom";
}

/** rect of [u0,u1] along an edge × [v0,v1] measured inward from its curb (world.ts `edgeRect`) */
export function edgeRect(e: LotEdge, u0: number, u1: number, v0: number, v1: number): Rect {
	const p0 = e.curb + e.inward * v0;
	const p1 = e.curb + e.inward * v1;
	const lo = math.min(p0, p1);
	const hi = math.max(p0, p1);
	const a = math.min(u0, u1);
	const b = math.max(u0, u1);
	return alongX(e.side) ? { x: a, y: lo, w: b - a, h: hi - lo } : { x: lo, y: a, w: hi - lo, h: b - a };
}

/** extent of the lot's yard along an edge */
function yardSpan(lot: Lot, e: LotEdge): { a: number; b: number } {
	return alongX(e.side)
		? { a: lot.yard.x, b: lot.yard.x + lot.yard.w }
		: { a: lot.yard.y, b: lot.yard.y + lot.yard.h };
}

/** depth of the yard measured from an edge's sidewalk */
function yardDepth(lot: Lot, e: LotEdge): number {
	return alongX(e.side) ? lot.yard.h : lot.yard.w;
}

function snap8(v: number): number {
	return math.floor(v / 8 + 0.5) * 8;
}

/** a fixture of the town (see the header): indestructible, `low` ones let bullets by */
function prop(kit: TownKit, tags: string, r: Rect, low: boolean, extra?: Partial<Solid>): Solid {
	return kit.add({
		kind: "prop",
		x: r.x,
		y: r.y,
		w: r.w,
		h: r.h,
		hp: 999999,
		hpMax: 999999,
		destructible: false,
		tags,
		low,
		...extra,
	});
}

/** heading of an edge's inward normal (radians): the way a car on that street's lot faces into the lot */
export function inwardHeading(side: DoorSide): number {
	if (side === "top") return math.pi / 2;
	if (side === "bottom") return -math.pi / 2;
	if (side === "left") return 0;
	return math.pi;
}

// ---------------------------------------------------------------------------------------------- fire station (EDI-22)

/** the fire station's apron: the concrete from the sidewalk to the apparatus bay, deep enough for the engine */
export const FIRE_APRON = 256;
/** the fire station's long side, along its avenue (world.ts TOWN_DEFS 24: 808 x 684) */
const STATION_ALONG = 808;

/**
 * The fire station (EDI-22): on an avenue -- where the engine gets out fastest -- at one end of a block's face, the
 * houses filling the rest of it. It stands behind its apron: the concrete the engine rolls out on, with a curb cut as
 * wide as the building and nobody parked across it. False when it does not fit on this face.
 */
export function placeFireStation(kit: TownKit, lot: Lot, e: LotEdge): boolean {
	const span = yardSpan(lot, e);
	let fire: Solid | undefined;
	const first = kit.rng.chance(0.5);
	for (const atA of [first, !first]) {
		const u = snap8(atA ? span.a + TOWN.SIDE_YARD : span.b - TOWN.SIDE_YARD - STATION_ALONG);
		fire = kit.build(lot, e, 24, u, FIRE_APRON);
		if (fire !== undefined) break;
	}
	if (fire === undefined) return false;
	const u0 = alongX(e.side) ? fire.x : fire.y;
	const u1 = u0 + (alongX(e.side) ? fire.w : fire.h);
	const apron = edgeRect(e, u0, u1, TOWN.SIDEWALK, TOWN.SIDEWALK + FIRE_APRON);
	lot.ground.push({ ...apron, kind: "apron" });
	kit.reserve(apron);
	// the curb cut the engine rolls out across, and nobody parked in front of it
	kit.cut(e, u0, u1, "drive");
	const drive = edgeRect(e, u0, u1, 0, TOWN.SIDEWALK);
	lot.ground.push({ ...drive, kind: "drive" });
	kit.reserve(drive);
	kit.noParking(e, u0 - 60, u1 + 60);
	return true;
}

// ---------------------------------------------------------------------------------------------- the bank (EDI-23)

/** the bank's footprint: along its avenue, and deep (world.ts TOWN_DEFS 22) */
export const BANK_ALONG = 808;
export const BANK_DEPTH = 620;
/** the broad stone steps between the sidewalk and the bank's facade: the one shop that stands back (EDI-02) */
export const BANK_STEPS = 96;
/**
 * A column of the portico: its side, and its centre's distances from the main door along the facade -- four columns,
 * a tetrastyle front two thirds of the facade wide, the door between the middle pair
 */
export const BANK_COLUMN = 40;
export const BANK_COLUMN_AT: ReadonlyArray<number> = [104, 232];
/**
 * The column row stands this far in front of the facade: a sealed gap (narrower than the slimmest body, EDI-11) --
 * nobody is cornered behind a column. Between two columns there are 88 u (PATH): two bodies walk through.
 */
export const BANK_COLUMN_GAP = 16;
/**
 * The portico's roof reaches this much past the outer columns; towards the street it stops BANK_PORTICO_SHOW short of
 * the columns' front: the front of each column stands out under the cornice, seen from above
 */
export const BANK_PORTICO_EAVE = 24;
export const BANK_PORTICO_SHOW = 14;

/**
 * The bank (EDI-23): Main Street's landmark, at the end of an avenue face towards the avenues' crossing (`towardA`:
 * the edge's `a` end), standing back behind its broad stone steps, a portico of four stone columns before its facade
 * under a pediment roof (a "canopy" solid, tags "portico": aerial, see-through with a body under it). The portico
 * carries the alarm bell: while it rings its `powered` is on (server/sim/vault.ts; the LightSet of any light). The
 * inside -- the banking hall, the offices and the vault -- is shared/game/interiors.ts's; the vault door and its boxes
 * are world.ts `bankVault`'s. Answers the bank's record, or undefined when it does not fit on this face.
 */
export function placeBank(kit: TownKit, lot: Lot, e: LotEdge, towardA: boolean): Solid | undefined {
	const span = yardSpan(lot, e);
	if (yardDepth(lot, e) < BANK_STEPS + BANK_DEPTH + TOWN.SIDE_YARD) return undefined;
	let bank: Solid | undefined;
	for (const atA of [towardA, !towardA]) {
		const u = snap8(atA ? span.a + TOWN.SIDE_YARD : span.b - TOWN.SIDE_YARD - BANK_ALONG);
		bank = kit.build(lot, e, 22, u, BANK_STEPS);
		if (bank !== undefined) break;
	}
	if (bank === undefined) return undefined;
	const ax = alongX(e.side);
	const u0 = ax ? bank.x : bank.y;
	const u1 = u0 + (ax ? bank.w : bank.h);
	const door = (ax ? bank.doorX : bank.doorY) ?? (u0 + u1) / 2;
	const top = TOWN.SIDEWALK;
	const face = TOWN.SIDEWALK + BANK_STEPS;
	// the steps take the whole forecourt: the footpath the town laid to the door is under them
	const steps = edgeRect(e, u0, u1, top, face);
	for (let i = lot.ground.size() - 1; i >= 0; i--) {
		const q = lot.ground[i];
		if (q.kind !== "walk") continue;
		if (q.x < steps.x + steps.w && steps.x < q.x + q.w && q.y < steps.y + steps.h && steps.y < q.y + q.h) {
			lot.ground.remove(i);
		}
	}
	lot.ground.push({ ...steps, kind: "steps" });
	kit.reserve(steps);
	// the columns, symmetrical about the door; one that would stand past the facade's corner is left out
	const c1 = face - BANK_COLUMN_GAP;
	const c0 = c1 - BANK_COLUMN;
	let lo = door;
	let hi = door;
	for (const at of BANK_COLUMN_AT) {
		for (const sgn of [-1, 1]) {
			const c = door + sgn * at;
			if (c - BANK_COLUMN / 2 < u0 + 8 || c + BANK_COLUMN / 2 > u1 - 8) continue;
			prop(kit, "column", edgeRect(e, c - BANK_COLUMN / 2, c + BANK_COLUMN / 2, c0, c1), false, {
				bankId: bank.id,
			});
			lo = math.min(lo, c - BANK_COLUMN / 2);
			hi = math.max(hi, c + BANK_COLUMN / 2);
		}
	}
	// the portico's roof over the columns and the top step, up to the facade (its pediment faces the street)
	const roof = edgeRect(e, lo - BANK_PORTICO_EAVE, hi + BANK_PORTICO_EAVE, c0 + BANK_PORTICO_SHOW, face);
	kit.add({
		kind: "canopy",
		x: roof.x,
		y: roof.y,
		w: roof.w,
		h: roof.h,
		hp: 999999,
		hpMax: 999999,
		destructible: false,
		tags: "portico",
		passable: true,
		face: e.side,
		canopyAlpha: 1,
		bankId: bank.id,
	});
	return bank;
}

// ---------------------------------------------------------------------------------------------- the church (EDI-18)

/**
 * The neighbourhood church (EDI-18): on a residential street, set back behind a front lawn like the houses beside it
 * (EDI-02: a civic building with its yard), at one end of the block's face so the houses fill the rest. False when
 * it does not fit on this face.
 */
export function placeChurch(kit: TownKit, lot: Lot, e: LotEdge): boolean {
	const span = yardSpan(lot, e);
	if (yardDepth(lot, e) < 684 + TOWN.SETBACK_HOUSE_MIN + TOWN.SIDE_YARD * 2) return false;
	const atA = kit.rng.chance(0.5);
	const along = 808;
	const u = snap8(atA ? span.a + TOWN.SIDE_YARD : span.b - TOWN.SIDE_YARD - along);
	const setback = snap8(kit.rng.range(TOWN.SETBACK_HOUSE_MIN, TOWN.SETBACK_HOUSE_MAX));
	return kit.build(lot, e, 23, u, setback) !== undefined;
}

// ---------------------------------------------------------------------------------------------- standing things

/** two bodies side by side (EDI-11): the narrowest gap between two standing things that is a way through */
export const PATH = 88;
/** narrower than the slimmest body (a walker, 32): a gap nobody walks into, so nobody is cornered in it */
export const SEALED = 30;

/**
 * Do two standing things leave a gap one body fits in and two do not (EDI-11, outdoors)? Diagonal neighbours never
 * do: a body walks round the corner.
 */
export function pinches(a: Rect, b: Rect): boolean {
	const du = math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
	const dv = math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
	if (du > 0 && dv > 0) return false;
	const gap = math.max(du, dv);
	return gap >= SEALED && gap < PATH;
}

/** does this solid stand in a body's way (a building's box until its walls are planned, a tree, a car, a fixture)? */
function standing(s: Solid): boolean {
	if (s.removed === true || s.kind === "canopy" || s.kind === "window") return false;
	return s.kind === "building" || s.passable !== true;
}

/**
 * The strip between two things that face each other across a gap (their overlap along it × the gap), or undefined
 * when they do not face each other (diagonal neighbours, or touching).
 */
export function gapBetween(a: Rect, b: Rect): Rect | undefined {
	const du = math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
	const dv = math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
	if (du > 0 === dv > 0) return undefined;
	if (du > 0) {
		const y0 = math.max(a.y, b.y);
		const y1 = math.min(a.y + a.h, b.y + b.h);
		const x0 = math.min(a.x + a.w, b.x + b.w);
		return { x: x0, y: y0, w: du, h: y1 - y0 };
	}
	const x0 = math.max(a.x, b.x);
	const x1 = math.min(a.x + a.w, b.x + b.w);
	const y0 = math.min(a.y + a.h, b.y + b.h);
	return { x: x0, y: y0, w: x1 - x0, h: dv };
}

/**
 * Does a third thing cut the gap strip `g` right across (from one side of it to the other, along the two things that
 * face each other)? Then that gap is no slot: the pairs that count are the ones either side of the third thing.
 */
export function cutAcross(g: Rect, o: Rect, alongY: boolean): boolean {
	if (!(o.x < g.x + g.w && g.x < o.x + o.w && o.y < g.y + g.h && g.y < o.y + o.h)) return false;
	return alongY ? o.y <= g.y && o.y + o.h >= g.y + g.h : o.x <= g.x && o.x + o.w >= g.x + g.w;
}

/**
 * Would something standing at `r` pinch a slot with anything standing near it? A gap a third thing fills right across
 * (the table between the food truck and the crates behind the table) is no slot: the pairs either side of it count.
 */
function pinchesAny(kit: TownKit, r: Rect): boolean {
	const near = kit.solidsIn(r.x - PATH, r.y - PATH, r.w + PATH * 2, r.h + PATH * 2);
	for (const s of near) {
		if (!standing(s) || !pinches(r, s)) continue;
		const g = gapBetween(r, s);
		let filled = false;
		if (g !== undefined) {
			// the two face each other across x (the strip runs along y, as long as their overlap) or across y
			const alongY = math.max(0, s.x - (r.x + r.w), r.x - (s.x + s.w)) > 0;
			for (const o of near) {
				if (o !== s && standing(o) && cutAcross(g, o, alongY)) filled = true;
			}
		}
		if (!filled) return true;
	}
	return false;
}

/** is anything standing within `d` of the rect a building (its box)? */
function nearBuilding(kit: TownKit, r: Rect, d: number): boolean {
	for (const s of kit.solidsIn(r.x - d, r.y - d, r.w + d * 2, r.h + d * 2)) {
		if (s.kind === "building" && s.removed !== true) return true;
	}
	return false;
}

/**
 * A fixture at `r` if it is free (`canPlace` with `pad`: nothing within it, no reserved zone, no road) and pinches no
 * slot with what stands round it (EDI-11); undefined otherwise.
 */
function fixture(
	kit: TownKit,
	tags: string,
	r: Rect,
	low: boolean,
	extra?: Partial<Solid>,
	pad = 8,
): Solid | undefined {
	if (!kit.canPlace(r.x, r.y, r.w, r.h, pad)) return undefined;
	if (pinchesAny(kit, r)) return undefined;
	return prop(kit, tags, r, low, extra);
}

/**
 * `r` grown by `d` on every side. Reserved round a fixture laid before the trees (a park's, the market's, the building
 * site's) it keeps every tree PATH off it: the trees are planted later, and a trunk does not ask about slots (EDI-11).
 */
function grown(r: Rect, d: number): Rect {
	return { x: r.x - d, y: r.y - d, w: r.w + d * 2, h: r.h + d * 2 };
}

/** the rect `w` × `h` in the lot's own frame: along x when `ax`, else along y */
function frameRect(ax: boolean, a0: number, a1: number, c0: number, c1: number): Rect {
	return ax ? { x: a0, y: c0, w: a1 - a0, h: c1 - c0 } : { x: c0, y: a0, w: c1 - c0, h: a1 - a0 };
}

/** the side a thing faces when its front looks the way `side`'s inward normal points (into the lot) */
function inwardSide(side: DoorSide): DoorSide {
	if (side === "top") return "bottom";
	if (side === "bottom") return "top";
	if (side === "left") return "right";
	return "left";
}

/** usable [a,b] of an edge's service strip: `clear` from each street corner (world.ts `stripRange`) */
function stripRange(e: LotEdge, clear: number): { a: number; b: number } {
	return { a: e.cornerA ? e.a + clear : e.a + 64, b: e.cornerB ? e.b - clear : e.b - 64 };
}

/** a searchable fixture's container fields (a stall's, a pile's, a shed's): rolled lazily, one slot (MP-05) */
function holds(): Partial<Solid> {
	return { lootSlots: 1, lootItems: [], lootTimer: 0 };
}

// ---------------------------------------------------------------------------------------------- parks (MOB-05)

/** a park's playground: the sand, and the play equipment on it (tags, along, across, low) */
const PLAY_W = 320;
const PLAY_H = 256;
const PLAY_KIT: ReadonlyArray<[string, number, number]> = [
	["swings", 144, 40],
	["slide", 40, 112],
	["climber", 88, 88],
	["springer", 28, 28],
	["springer", 28, 28],
];
/** a half court: its asphalt, and the hoop at its baseline */
const COURT_W = 352;
const COURT_H = 320;
/** a bench (the campus's: shared/game/campus.ts BENCH_L × BENCH_D) and a picnic table */
const BENCH_L = 64;
const BENCH_D = 24;
const PICNIC_W = 96;
const PICNIC_H = 72;

/** the four quarters a park's two crossing paths leave, clear of the paths' margins (world.ts reserves 20 u) */
function parkQuarters(lot: Lot): Array<Rect> {
	const y = lot.yard;
	let vx = y.x + y.w / 2;
	let hy = y.y + y.h / 2;
	for (const p of lot.paths) {
		if (p.h > p.w) vx = p.x + p.w / 2;
		else hy = p.y + p.h / 2;
	}
	const m = 44 + 20 + 8;
	const xs: Array<[number, number]> = [
		[y.x + 24, vx - m],
		[vx + m, y.x + y.w - 24],
	];
	const ys: Array<[number, number]> = [
		[y.y + 24, hy - m],
		[hy + m, y.y + y.h - 24],
	];
	const out: Array<Rect> = [];
	for (const [x0, x1] of xs) for (const [y0, y1] of ys) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
	return out;
}

/** the rect `w` × `h` centred in `q`, on the 8 u grid; undefined if it does not fit with `m` round it */
function centred(q: Rect, w: number, h: number, m: number): Rect | undefined {
	if (q.w < w + m * 2 || q.h < h + m * 2) return undefined;
	return { x: snap8(q.x + (q.w - w) / 2), y: snap8(q.y + (q.h - h) / 2), w, h };
}

/**
 * A park (MOB-05): a playground on its sand in one quarter -- a swing set, a slide, a climbing frame, spring riders
 * -- a half court with its hoop in another one park in two, benches along the paths and a picnic table. Laid before
 * the park's trees, which then grow round them (the areas are reserved).
 */
export function furnishPark(kit: TownKit, lot: Lot): void {
	const quarters = parkQuarters(lot);
	for (let i = quarters.size() - 1; i > 0; i--) {
		const j = kit.rng.int(0, i);
		const t = quarters[i];
		quarters[i] = quarters[j];
		quarters[j] = t;
	}
	let play = false;
	let court = !kit.rng.chance(0.5);
	let picnic = false;
	for (const q of quarters) {
		if (!play) {
			const a = centred(q, PLAY_W, PLAY_H, 24);
			if (a !== undefined && kit.canPlace(a.x, a.y, a.w, a.h, 0)) {
				play = true;
				playground(kit, lot, a);
				continue;
			}
		}
		if (!court) {
			const wide = q.w >= q.h;
			const c = centred(q, wide ? COURT_W : COURT_H, wide ? COURT_H : COURT_W, 24);
			if (c !== undefined && kit.canPlace(c.x, c.y, c.w, c.h, 0)) {
				court = true;
				halfCourt(kit, lot, c, wide);
				continue;
			}
		}
		if (!picnic) {
			const p = centred(q, PICNIC_W, PICNIC_H, 48);
			if (p !== undefined && fixture(kit, "picnic", p, true) !== undefined) {
				picnic = true;
				kit.reserve(grown(p, PATH));
			}
		}
	}
	// a bench on each side of each path, a quarter of the way along
	for (const p of lot.paths) {
		const vertical = p.h > p.w;
		for (const f of [0.25, 0.75]) {
			if (!kit.rng.chance(0.6)) continue;
			const side = kit.rng.chance(0.5) ? -1 : 1;
			const at = vertical ? p.y + p.h * f : p.x + p.w * f;
			const off = 20 + 8;
			let r: Rect;
			let face: DoorSide;
			if (vertical) {
				const x = side < 0 ? p.x - off - BENCH_D : p.x + p.w + off;
				r = { x: snap8(x), y: snap8(at - BENCH_L / 2), w: BENCH_D, h: BENCH_L };
				face = side < 0 ? "right" : "left";
			} else {
				const y = side < 0 ? p.y - off - BENCH_D : p.y + p.h + off;
				r = { x: snap8(at - BENCH_L / 2), y: snap8(y), w: BENCH_L, h: BENCH_D };
				face = side < 0 ? "bottom" : "top";
			}
			if (fixture(kit, "bench", r, true, { face }) !== undefined) kit.reserve(grown(r, PATH));
		}
	}
}

/** the sand and the equipment on it, each where it pinches nothing (EDI-11) */
function playground(kit: TownKit, lot: Lot, a: Rect): void {
	const kit0 = kit.rng.int(0, 3);
	for (const [tags, w, h] of PLAY_KIT) {
		let placed = false;
		// a walk over the sand from a corner the rng picks: the first free spot takes it
		for (let k = 0; k < 4 && !placed; k++) {
			const corner = (kit0 + k) % 4;
			for (let dy = 16; dy + h <= a.h - 16 && !placed; dy += 16) {
				for (let dx = 16; dx + w <= a.w - 16 && !placed; dx += 16) {
					const x = corner % 2 === 0 ? a.x + dx : a.x + a.w - dx - w;
					const y = corner < 2 ? a.y + dy : a.y + a.h - dy - h;
					placed = fixture(kit, tags, { x, y, w, h }, true, undefined, 4) !== undefined;
				}
			}
		}
	}
	lot.ground.push({ ...a, kind: "sandbox" });
	kit.reserve(grown(a, PATH));
}

/** the court's asphalt and lines, and a hoop at the middle of each baseline (the key's end) */
function halfCourt(kit: TownKit, lot: Lot, c: Rect, wide: boolean): void {
	lot.ground.push({ ...c, kind: "court" });
	for (const atLow of [true, false]) {
		const hoop = wide
			? { x: atLow ? c.x + 12 : c.x + c.w - 28, y: c.y + c.h / 2 - 24, w: 16, h: 48 }
			: { x: c.x + c.w / 2 - 24, y: atLow ? c.y + 12 : c.y + c.h - 28, w: 48, h: 16 };
		const face: DoorSide = wide ? (atLow ? "right" : "left") : atLow ? "bottom" : "top";
		fixture(kit, "hoop", hoop, false, { face }, 0);
	}
	kit.reserve(grown(c, PATH));
}

// ---------------------------------------------------------------------------------------------- the street market (EDI-20)

/** a stall: the table (a container) the vendor stood behind, the crates behind it; the tent over two back to back */
export const STALL_W = 128;
export const STALL_D = 44;
export const CRATE = 44;
/** the stalls along a row, table to table: two bodies between two tables */
export const STALL_PITCH = 224;
/** the aisles between two rows of stalls, and the cross aisle through the middle of every row */
export const MARKET_AISLE = 240;
const MARKET_CROSS = 160;
/** the food truck (a car's footprint) */
const TRUCK_L = 220;
const TRUCK_W = 100;
/** the share of the tables still holding something to take */
const STALL_STOCKED = 0.35;
/** and never more than this many of them (a market is a street of stalls, not a supermarket: EDI-20) */
export const MARKET_STOCKED_MAX = 8;

/**
 * The street market (EDI-20): a downtown block given to the weekly market, abandoned mid-day when the town fell.
 * Rows of stalls back to back -- a table facing the aisle, the crates behind it, a striped tent over each pair --
 * with a wide aisle between two rows and a cross aisle through the middle, every aisle open onto a sidewalk; the
 * food truck parked at the end of an aisle. About a third of the tables still hold what they sold (produce, bread and
 * preserves, cloth and leather: spawns.ts YARD_LOOT), the truck its food. Answers false when the block cannot hold
 * one row.
 */
export function placeMarket(kit: TownKit, lot: Lot): boolean {
	const y = lot.yard;
	const ax = y.w >= y.h;
	const A0 = ax ? y.x : y.y;
	const A1 = A0 + (ax ? y.w : y.h);
	const C0 = ax ? y.y : y.x;
	const C1 = C0 + (ax ? y.h : y.w);
	const block = STALL_D * 2 + CRATE * 2;
	const margin = 112;
	const n = math.floor((C1 - C0 - margin * 2 + MARKET_AISLE) / (block + MARKET_AISLE));
	if (n < 1) return false;
	const used = n * block + (n - 1) * MARKET_AISLE;
	const c0 = snap8(C0 + (C1 - C0 - used) / 2);
	const mid = (A0 + A1) / 2;
	// the tables' positions along a row: two halves round the cross aisle, from the middle out
	const starts: Array<number> = [];
	const ends = 96;
	for (let a = mid + MARKET_CROSS / 2; a + STALL_W <= A1 - ends; a += STALL_PITCH) starts.push(snap8(a));
	for (let a = mid - MARKET_CROSS / 2 - STALL_W; a >= A0 + ends; a -= STALL_PITCH) starts.push(snap8(a));
	if (starts.size() === 0) return false;
	const sideLow: DoorSide = ax ? "top" : "left";
	const sideHigh: DoorSide = ax ? "bottom" : "right";
	let stockedLeft = MARKET_STOCKED_MAX;
	for (let b = 0; b < n; b++) {
		const cb = c0 + b * (block + MARKET_AISLE);
		for (const a of starts) {
			const pair = frameRect(ax, a, a + STALL_W, cb, cb + block);
			if (!kit.canPlace(pair.x, pair.y, pair.w, pair.h, 0)) continue;
			const tableLow = frameRect(ax, a, a + STALL_W, cb, cb + STALL_D);
			const tableHigh = frameRect(ax, a, a + STALL_W, cb + block - STALL_D, cb + block);
			const cm = a + (STALL_W - CRATE) / 2;
			// the low row's table faces the low aisle, the high row's the high one; what each sells, from the rng
			for (const [r, face] of [
				[tableLow, sideLow],
				[tableHigh, sideHigh],
			] as Array<[Rect, DoorSide]>) {
				const stocked = kit.rng.chance(STALL_STOCKED) && stockedLeft > 0;
				if (stocked) stockedLeft -= 1;
				prop(kit, "stall", r, true, {
					face,
					variant: kit.rng.int(0, 2),
					...(stocked ? holds() : {}),
				});
			}
			prop(kit, "crates", frameRect(ax, cm, cm + CRATE, cb + STALL_D, cb + STALL_D + CRATE), true, {
				variant: kit.rng.int(0, 2),
			});
			prop(kit, "crates", frameRect(ax, cm, cm + CRATE, cb + STALL_D + CRATE, cb + block - STALL_D), true, {
				variant: kit.rng.int(0, 2),
			});
			const tent = frameRect(ax, a - 16, a + STALL_W + 16, cb - 16, cb + block + 16);
			kit.add({
				kind: "canopy",
				x: tent.x,
				y: tent.y,
				w: tent.w,
				h: tent.h,
				hp: 999999,
				hpMax: 999999,
				destructible: false,
				tags: "tent",
				passable: true,
				canopyAlpha: 1,
				face: sideLow,
				variant: kit.rng.int(0, 2),
			});
		}
	}
	// the food truck at the far end of the first aisle (or of the margin, with one row), against the row's side
	const aisle0 = n > 1 ? c0 + block : c0 - margin;
	const truck = frameRect(ax, A1 - ends - TRUCK_L, A1 - ends, aisle0 + 24, aisle0 + 24 + TRUCK_W);
	fixture(kit, "foodtruck", truck, false, { face: ax ? "right" : "bottom", ...holds() }, 0);
	// the rows' ground is the market's: no tree grows in an aisle
	kit.reserve(grown(frameRect(ax, A0 + ends, A1 - ends, c0, c0 + used), PATH));
	return true;
}

// ---------------------------------------------------------------------------------------------- a house going up (EDI-21)

/** the plot: along its street and deep, the fence 16 u behind the sidewalk, its gate in the middle */
export const SITE_ALONG = 560;
export const SITE_DEPTH = 640;
const SITE_FENCE = 8;
const SITE_GATE = 128;
/** the slab (and the frame standing on it): 100 u in from the side fences, 176 u behind the front one */
const SLAB_SIDE = 100;
const SLAB_FRONT = 176;
const SLAB_DEPTH = 320;

/**
 * A house going up (EDI-21): a plot on a residential street fenced round with a chain-link fence (bullets fly through,
 * bodies do not) and a gate onto its street; on the poured slab the timber frame of the walls, a door-wide gap in
 * front and one at the side, the scaffolding along the back; in the front yard the piles of what it is built of --
 * lumber, bricks, steel (each a container: spawns.ts YARD_LOOT) -- a portable toilet, a mixer and a dumpster. Every
 * gap two bodies wide or sealed (EDI-11). False when the plot does not fit on this face.
 */
export function placeConstruction(kit: TownKit, lot: Lot, e: LotEdge): boolean {
	const span = yardSpan(lot, e);
	if (yardDepth(lot, e) < 16 + SITE_DEPTH + TOWN.SIDE_YARD) return false;
	const u0 = snap8((span.a + span.b) / 2 - SITE_ALONG / 2);
	const u1 = u0 + SITE_ALONG;
	const vF = TOWN.SIDEWALK + 16;
	const vB = vF + SITE_DEPTH;
	const plot = edgeRect(e, u0, u1, vF, vB);
	if (!kit.canPlace(plot.x, plot.y, plot.w, plot.h, TOWN.BUILDING_GAP)) return false;
	const F = SITE_FENCE;
	const gate = (u0 + u1) / 2;
	const fence = (a0: number, a1: number, b0: number, b1: number) =>
		prop(kit, "fence", edgeRect(e, a0, a1, b0, b1), true, { face: e.side });
	fence(u0, gate - SITE_GATE / 2, vF, vF + F);
	fence(gate + SITE_GATE / 2, u1, vF, vF + F);
	fence(u0, u0 + F, vF + F, vB - F);
	fence(u1 - F, u1, vF + F, vB - F);
	fence(u0, u1, vB - F, vB);
	// the drive through the sidewalk to the gate
	kit.cut(e, gate - SITE_GATE / 2, gate + SITE_GATE / 2, "drive");
	lot.ground.push({ ...edgeRect(e, gate - SITE_GATE / 2, gate + SITE_GATE / 2, 0, vF + F), kind: "drive" });
	kit.noParking(e, gate - 150, gate + 150);
	// the slab and the frame on it: the back wall whole, the side walls partial, the front open in the middle
	const su0 = u0 + SLAB_SIDE;
	const su1 = u1 - SLAB_SIDE;
	const sv0 = vF + SLAB_FRONT;
	const sv1 = sv0 + SLAB_DEPTH;
	// the churned earth inside the fence, and the slab poured on it
	lot.ground.push({ ...edgeRect(e, u0 + F, u1 - F, vF + F, vB - F), kind: "site" });
	lot.ground.push({ ...edgeRect(e, su0, su1, sv0, sv1), kind: "pad" });
	const studs = (a0: number, a1: number, b0: number, b1: number) =>
		prop(kit, "studs", edgeRect(e, a0, a1, b0, b1), true, { face: e.side });
	studs(su0, su1, sv1 - F, sv1);
	studs(su0, su0 + F, sv0 + F, sv0 + 160);
	studs(su1 - F, su1, sv0 + PATH + F, sv1 - F);
	studs(su0, su0 + 104, sv0, sv0 + F);
	studs(su1 - 104, su1, sv0, sv0 + F);
	// the scaffolding along the back, a hand's width off the frame
	prop(kit, "scaffold", edgeRect(e, su0 + 40, su1 - 40, sv1 + F, sv1 + F + 40), true, { face: e.side });
	// the way in stays open, from the gate to the frame's doorway
	kit.reserve(edgeRect(e, gate - SITE_GATE / 2 - 16, gate + SITE_GATE / 2 + 16, vF, sv0 + F));
	// the piles, the toilet, the mixer and the dumpster along the front fence, wherever each pinches nothing: the
	// front yard stays two bodies deep behind them, and the side and back yards stay clear (no pocket behind a pile)
	const loose: Array<[string, number, number, boolean, number]> = [
		["pile", 112, 56, true, 0],
		["pile", 72, 56, true, 1],
		["pile", 96, 40, true, 2],
		["portapotty", 48, 48, false, -1],
		["mixer", 56, 56, true, -1],
		["dumpster", 128, 64, false, -1],
	];
	for (const [tags, along, deep, low, variant] of loose) {
		let placed = false;
		const v = vF + F + 8;
		if (v + deep > sv0 - PATH) continue;
		for (let u = u0 + F + 8; u + along <= u1 - F - 8 && !placed; u += 16) {
			const r = edgeRect(e, u, u + along, v, v + deep);
			const extra: Partial<Solid> = { face: e.side };
			if (variant >= 0) {
				extra.variant = variant;
				extra.lootSlots = 1;
				extra.lootItems = [];
				extra.lootTimer = 0;
			}
			placed = fixture(kit, tags, r, low, extra, 4) !== undefined;
		}
	}
	kit.reserve(grown(plot, PATH));
	return true;
}

// ---------------------------------------------------------------------------------------------- a public parking lot (MOB-05)

/**
 * A public parking lot (MOB-05): a downtown block paved for the shoppers, one or two lots of stalls from its streets
 * (world.ts addParking), the cars their owners never came back for. False when not even one fits.
 */
export function placePublicParking(kit: TownKit, lot: Lot): boolean {
	let made = 0;
	for (let i = 0; i < 2; i++) {
		const f = kit.freeFront(lot, 360, 424);
		if (f === undefined || !kit.parking(lot, f.e, f.r)) break;
		made++;
	}
	return made > 0;
}

// ---------------------------------------------------------------------------------------------- the streets (MOB-04)

/** a street lamp's pole, a hydrant, a mailbox's post, a collection box, a bus stop's sign */
const POLE = 16;
/** the share of a block's faces with a hydrant near a corner */
const HYDRANT_SHARE = 0.6;
const HYDRANT = 20;
const MAILBOX = 16;
const POSTBOX = 28;
const SIGN_POLE = 12;
/** a bus shelter's roof over the service strip and the edge of the clear path (passable: it stands on posts) */
const SHELTER_L = 176;
const SHELTER_D = 72;

/** a thing of `along` × `deep` centred in the service strip at `u` (the verge, between the curb and the clear path) */
function inVerge(e: LotEdge, u: number, along: number, deep: number): Rect {
	const v = TOWN.VERGE / 2;
	return edgeRect(e, u - along / 2, u + along / 2, v - deep / 2, v + deep / 2);
}

/**
 * The street furniture of one lot's sidewalks (MOB-04, CID-02), laid last, once every building, tree, bin and car
 * stands: street lamps between the street trees (every lattice step on an avenue, every second one on any other
 * street; dark: the power is out, LUZ-02), a fire hydrant near a corner of most faces, a mailbox at the
 * curb beside the path of most houses, a bench on a downtown face, a blue collection box on some downtown blocks, and
 * on the avenues a bus stop -- the sign, the bench, the shelter's roof. All in the service strip, never in a cut
 * (a path, a driveway), never within a car length of a corner, and pinching no slot (EDI-11).
 */
export function furnishStreets(kit: TownKit, lot: Lot): void {
	const downtown = lot.zone === "commercial";
	const houses = kit.placedOn(lot);
	for (const e of lot.edges) {
		const road = kit.w.roads[e.road];
		const range = stripRange(e, TOWN.CORNER_CLEAR + 16);
		if (range.b - range.a < 200) continue;
		// street lamps: halfway between two street trees (both sides of a street line up on the lattice)
		const lat = kit.treeLattice(e.road);
		const every = road.avenue ? 1 : 2;
		let k = math.ceil((range.a - lat.phase) / lat.pitch - 0.5);
		while (lat.phase + (k + 0.5) * lat.pitch <= range.b) {
			const u = snap8(lat.phase + (k + 0.5) * lat.pitch);
			const on = k % every === 0;
			k++;
			if (!on || kit.inCut(e, u - POLE / 2, u + POLE / 2, 24)) continue;
			fixture(kit, "streetlight", inVerge(e, u, POLE, POLE), false, { face: e.side }, 16);
		}
		// a hydrant near one corner of most faces
		const hydrant = kit.rng.chance(HYDRANT_SHARE);
		for (const u of kit.rng.chance(0.5) ? [range.a + 24, range.b - 24] : [range.b - 24, range.a + 24]) {
			if (!hydrant) break;
			if (kit.inCut(e, u - HYDRANT, u + HYDRANT, 16)) continue;
			if (fixture(kit, "hydrant", inVerge(e, u, HYDRANT, HYDRANT), false, undefined, 16) !== undefined) break;
		}
		// a mailbox at the curb beside the path of most houses on this face (past the door's approach, world.ts
		// addBuilding keeps 80 u each side of the door clear)
		for (const p of houses) {
			if (p.edge !== e || (p.type !== 1 && p.type !== 2) || !kit.rng.chance(0.7)) continue;
			for (const sgn of kit.rng.chance(0.5) ? [1, -1] : [-1, 1]) {
				const u = p.doorU + sgn * 104;
				if (u < range.a || u > range.b || kit.inCut(e, u - MAILBOX / 2, u + MAILBOX / 2, 8)) continue;
				if (
					fixture(kit, "mailbox", inVerge(e, u, MAILBOX, MAILBOX), false, { face: e.side }, 12) !== undefined
				) {
					break;
				}
			}
		}
		if (downtown) {
			// a bench facing the shops, and on some blocks a blue collection box
			for (let t = 0; t < 6; t++) {
				const u = snap8(kit.rng.range(range.a + 48, range.b - 48));
				if (kit.inCut(e, u - BENCH_L / 2, u + BENCH_L / 2, 16)) continue;
				const r = inVerge(e, u, BENCH_L, BENCH_D);
				if (fixture(kit, "bench", r, true, { face: inwardSide(e.side) }, 16) !== undefined) break;
			}
			if (kit.rng.chance(0.35)) {
				for (let t = 0; t < 6; t++) {
					const u = snap8(kit.rng.range(range.a + 32, range.b - 32));
					if (kit.inCut(e, u - POSTBOX, u + POSTBOX, 8)) continue;
					if (
						fixture(kit, "postbox", inVerge(e, u, POSTBOX, POSTBOX), false, { face: e.side }, 16) !==
						undefined
					) {
						break;
					}
				}
			}
		}
		if (road.avenue && kit.rng.chance(0.3)) busStop(kit, e, range);
	}
}

/** a bus stop on an avenue: the sign, the bench under the shelter's roof, the roof over both (MOB-04) */
function busStop(kit: TownKit, e: LotEdge, range: { a: number; b: number }): void {
	for (let t = 0; t < 6; t++) {
		const u = snap8(kit.rng.range(range.a + SHELTER_L / 2 + 24, range.b - SHELTER_L / 2 - 24));
		if (kit.inCut(e, u - SHELTER_L / 2 - 16, u + SHELTER_L / 2 + 16, 8)) continue;
		const roof = edgeRect(e, u - SHELTER_L / 2, u + SHELTER_L / 2, 4, 4 + SHELTER_D);
		// the roof is aerial, but nothing else of the town may stand under it (a tree's trunk, a lamp)
		let clear = true;
		for (const s of kit.solidsIn(roof.x, roof.y, roof.w, roof.h)) if (standing(s)) clear = false;
		if (!clear) continue;
		const bench = fixture(
			kit,
			"bench",
			inVerge(e, u - 24, BENCH_L, BENCH_D),
			true,
			{ face: inwardSide(e.side) },
			8,
		);
		if (bench === undefined) continue;
		fixture(kit, "busstop", inVerge(e, u + SHELTER_L / 2 - 16, SIGN_POLE, SIGN_POLE), false, { face: e.side }, 4);
		kit.add({
			kind: "canopy",
			x: roof.x,
			y: roof.y,
			w: roof.w,
			h: roof.h,
			hp: 999999,
			hpMax: 999999,
			destructible: false,
			tags: "shelter",
			passable: true,
			canopyAlpha: 1,
			face: e.side,
		});
		return;
	}
}

// ---------------------------------------------------------------------------------------------- backyards (MOB-06)

/** what a backyard may hold: tags, along, deep, low, the share of houses that have one, a container? */
const YARD_THINGS: ReadonlyArray<[string, number, number, boolean, number, boolean]> = [
	["shed", 96, 72, false, 0.2, true],
	["pool", 176, 96, true, 0.14, false],
	["swings", 128, 40, true, 0.14, false],
	["trampoline", 88, 88, true, 0.1, false],
	["grill", 32, 32, true, 0.25, false],
];
/** a vegetable bed (ground: nothing stands) */
const GARDEN_W = 128;
const GARDEN_H = 64;
const GARDEN_SHARE = 0.22;
/** a backyard thing keeps this far from every building: its back door and windows open onto the yard (EDI-09) */
const YARD_CLEAR = 96;

/**
 * The backyards of one block's houses (MOB-06), laid last with the streets: behind each house, some of a garden shed
 * (a container of tools and material: spawns.ts YARD_LOOT), a pool, a swing set, a trampoline, a grill, a vegetable
 * bed -- YARD_CLEAR from every building (their back doors and windows), pinching no slot (EDI-11).
 */
export function furnishBackyards(kit: TownKit, lot: Lot): void {
	const y = lot.yard;
	for (const p of kit.placedOn(lot)) {
		if (p.type !== 1 && p.type !== 2) continue;
		const e = p.edge;
		const b = p.solid;
		const ax = alongX(e.side);
		const u0 = ax ? b.x : b.y;
		const u1 = u0 + (ax ? b.w : b.h);
		// the house's back, as a distance from its curb
		const near = ax ? b.y : b.x;
		const far = near + (ax ? b.h : b.w);
		const back = e.inward > 0 ? far - e.curb : e.curb - near;
		const tryAt = (along: number, deep: number): Rect | undefined => {
			for (let v = back + YARD_CLEAR; v <= back + YARD_CLEAR + 160; v += 32) {
				for (let u = u0; u + along <= u1; u += 32) {
					const r = edgeRect(e, u, u + along, v, v + deep);
					if (r.x < y.x + 16 || r.y < y.y + 16 || r.x + r.w > y.x + y.w - 16 || r.y + r.h > y.y + y.h - 16) {
						continue;
					}
					if (
						!kit.canPlace(r.x, r.y, r.w, r.h, 16) ||
						nearBuilding(kit, r, YARD_CLEAR) ||
						pinchesAny(kit, r)
					) {
						continue;
					}
					return r;
				}
			}
			return undefined;
		};
		for (const [tags, along, deep, low, share, box] of YARD_THINGS) {
			if (!kit.rng.chance(share)) continue;
			const r = tryAt(along, deep);
			if (r !== undefined) {
				prop(kit, tags, r, low, box ? { face: inwardSide(e.side), ...holds() } : { face: inwardSide(e.side) });
			}
		}
		if (kit.rng.chance(GARDEN_SHARE)) {
			const r = tryAt(GARDEN_W, GARDEN_H);
			if (r !== undefined) {
				lot.ground.push({ ...r, kind: "garden" });
				kit.reserve(r);
			}
		}
	}
}
