/*
 * The everyday town (docs/DESIGN_RULES.md EDI-18..EDI-22, MOB-04..MOB-06): what a small North American town holds
 * besides its houses and its shops -- the civic centre with the fire and police stations, the neighbourhood church,
 * the street market, a public parking lot, a house going up, the parks' playgrounds and courts, the backyards'
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
/** a column of the portico: its side, and its centre's distances from the main door along the facade */
export const BANK_COLUMN = 40;
export const BANK_COLUMN_AT: ReadonlyArray<number> = [104, 232, 360];
/**
 * The column row stands this far in front of the facade: a sealed gap (narrower than the slimmest body, EDI-11) --
 * nobody is cornered behind a column. Between two columns there are 88 u (PATH): two bodies walk through.
 */
export const BANK_COLUMN_GAP = 16;
/** the portico's roof reaches this much past the outer columns and in front of the column row */
export const BANK_PORTICO_EAVE = 24;

/**
 * The bank (EDI-23): Main Street's landmark, at the end of an avenue face towards the avenues' crossing (`towardA`:
 * the edge's `a` end), standing back behind its broad stone steps, a portico of six stone columns before its facade
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
	const roof = edgeRect(e, lo - BANK_PORTICO_EAVE, hi + BANK_PORTICO_EAVE, c0 - BANK_PORTICO_EAVE, face);
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
