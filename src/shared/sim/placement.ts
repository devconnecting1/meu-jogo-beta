/*
 * Constructions: what can be placed (PLACEABLES) and where (docs/MULTIPLAYER.md §8.1 "place", §11.2). Pure rules
 * shared by the client's build ghost and, from F3 on, the server's validation of a `place` intent.
 */
import { CRAFT_RECIPES, CraftRecipe } from "shared/data/crafts";
import type { ZombieState } from "shared/game/entities";
import type { Opening } from "shared/game/interiors";
import { PLAYER_RADIUS, ZOMBIE_RADIUS } from "shared/game/physics";
import type { PlayerState } from "shared/game/player";
import { querySolids, Solid, SolidKind, WorldData } from "shared/game/world";

export interface PlaceableDef {
	tag: string;
	kind: SolidKind;
	w: number;
	h: number;
	hp: number;
	destructible: boolean;
	rotatable: boolean;
	powered?: boolean;
}

function p(
	tag: string,
	kind: SolidKind,
	w: number,
	h: number,
	hp: number,
	destructible = true,
	rotatable = false,
	powered?: boolean,
): PlaceableDef {
	return { tag, kind, w, h, hp, destructible, rotatable, powered };
}

/** by ETC item index (the kit a craftKind-1 recipe produces) */
export const PLACEABLES: Record<number, PlaceableDef> = {
	0: p("craftdesk", "structure", 96, 72, 200),
	1: p("craftdesk_pro", "structure", 112, 80, 400),
	2: p("turret", "structure", 64, 64, 400),
	3: p("turret_drone", "structure", 48, 48, 300),
	4: p("lamp", "structure", 48, 48, 400, true, false, false),
	5: p("lamp_drone", "structure", 40, 40, 300, true, false, false),
	6: p("battery", "structure", 40, 40, 300),
	7: p("generator", "structure", 72, 72, 500),
	8: p("generator", "structure", 80, 80, 500),
	9: p("generator", "structure", 72, 72, 500),
	10: p("barricade", "barricade", 128, 32, 700, true, true),
	11: p("door", "door", 96, 24, 500, true, true),
	12: p("iron_barricade", "iron_barricade", 128, 32, 1700, true, true),
	13: p("iron_door", "iron_door", 96, 24, 1500, true, true),
	14: p("campfire", "structure", 64, 64, 400, true, false, true),
	15: p("brazier", "structure", 64, 64, 400, true, false, true),
	16: p("electric_turret", "structure", 64, 64, 400),
	17: p("trap", "structure", 64, 64, 100),
	18: p("gps", "structure", 48, 48, 100),
	19: p("cooker", "structure", 56, 48, 300),
	20: p("furnace", "structure", 56, 48, 300),
	21: p("vehicle", "structure", 64, 40, 100),
	22: p("vehicle", "structure", 72, 44, 120),
	39: p("craftdesk", "structure", 96, 72, 240),
	40: p("craftdesk_pro", "structure", 112, 80, 480),
};

/** the ghost sits this far in front of the survivor (along the aim) ... */
export const PLACE_DISTANCE = 96;
/** ... with its top-left corner snapped to this grid */
export const PLACE_GRID = 128;

/** axis-aligned footprint of a construction (top-left corner + size) */
export interface PlaceRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** closest-point (rect × circle) overlap test */
export function rectCircleOverlap(
	rx: number,
	ry: number,
	rw: number,
	rh: number,
	cx: number,
	cy: number,
	cr: number,
): boolean {
	const qx = math.clamp(cx, rx, rx + rw);
	const qy = math.clamp(cy, ry, ry + rh);
	const dx = cx - qx;
	const dy = cy - qy;
	return dx * dx + dy * dy < cr * cr;
}

/**
 * Where the ghost of `def` goes for a survivor at (px, py) aiming at `aim`, with `rot` quarter turns
 * (rotatable pieces swap width and height on turns 1 and 3).
 */
export function ghostRect(def: PlaceableDef, px: number, py: number, aim: number, rot: number): PlaceRect {
	const cx = px + math.cos(aim) * PLACE_DISTANCE;
	const cy = py + math.sin(aim) * PLACE_DISTANCE;
	let w = def.w;
	let h = def.h;
	if (def.rotatable && (rot === 1 || rot === 3)) {
		w = def.h;
		h = def.w;
	}
	const gx = math.floor((cx - w / 2) / PLACE_GRID + 0.5) * PLACE_GRID;
	const gy = math.floor((cy - h / 2) / PLACE_GRID + 0.5) * PLACE_GRID;
	return { x: gx, y: gy, w, h };
}

/**
 * How far past the midpoint between two cells the ghost has to travel before it changes cell.
 *
 * A grid snap turns a continuous position into a step function, and a step function on a NOISY input
 * oscillates at the boundary forever. That noise did not exist while the client simulated itself -- standing
 * still meant standing exactly still -- but from MP_PHASE 2 the drawn position is prediction plus the
 * server's correction, which wobbles by a fraction of a unit every frame. Enough to flip a cell, and the
 * player sees the ghost vibrating in place.
 */
const GRID_HYSTERESIS = PLACE_GRID * 0.15;

/** one axis: keep the cell we are in until the target is clearly past the midpoint */
function stickyAxis(raw: number, prev: number | undefined): number {
	const snapped = math.floor(raw / PLACE_GRID + 0.5) * PLACE_GRID;
	if (prev === undefined) return snapped;
	if (snapped === prev) return prev;
	return math.abs(raw - prev) < PLACE_GRID / 2 + GRID_HYSTERESIS ? prev : snapped;
}

/**
 * `ghostRect` with a memory: the same rectangle, but it will not change cell for sub-unit noise.
 *
 * `prevX`/`prevY` are the last rectangle this ghost occupied, or undefined the first time. The aim and the
 * distance are unchanged -- only the decision of WHICH cell that lands in gains a deadband.
 */
export function ghostRectSticky(
	def: PlaceableDef,
	px: number,
	py: number,
	aim: number,
	rot: number,
	prevX?: number,
	prevY?: number,
): PlaceRect {
	const cx = px + math.cos(aim) * PLACE_DISTANCE;
	const cy = py + math.sin(aim) * PLACE_DISTANCE;
	let w = def.w;
	let h = def.h;
	if (def.rotatable && (rot === 1 || rot === 3)) {
		w = def.h;
		h = def.w;
	}
	return { x: stickyAxis(cx - w / 2, prevX), y: stickyAxis(cy - h / 2, prevY), w, h };
}

/** how close the ghost's centre must come to a doorway or a window to drop into it */
export const OPENING_SNAP = 88;

/** the openings a barricade or a door can fill: a building's doorways and windows, never an interior opening */
function fortifiable(o: Opening): boolean {
	return o.kind === "door" || o.kind === "window";
}

/** a barricade or a door: the pieces that fortify an opening (EDI-13) */
export function fortifies(def: PlaceableDef): boolean {
	return def.kind === "barricade" || def.kind === "iron_barricade" || def.kind === "door" || def.kind === "iron_door";
}

/**
 * Fortifying a building (docs/DESIGN_RULES.md EDI-13): a barricade or a door whose ghost comes near a doorway or
 * a window of a building fills that opening exactly -- its gap, wall thick -- instead of landing on the 128-unit
 * grid, where it could never fit between two walls. The placed piece keeps its own hit points, so the horde
 * breaks in at the usual rate (it paths to it as a SOFT cell and hits it: shared/sim/ai/zombieBrain.ts).
 * Only the building's doorways and windows (`fortifiable`): an interior opening can be an open-plan side 300 u
 * wide, and one 700 HP barricade must not seal a whole room off (review of ea5cf71). Everything else, and a ghost
 * with no such opening near, keeps the grid rect. Pure: the client's ghost and the server's placement
 * (server/sim/build.ts `ghost` and `place`) run this same function on the same world.
 */
export function snapToOpening(world: WorldData, def: PlaceableDef, r: PlaceRect): PlaceRect {
	if (!fortifies(def)) return r;
	const cx = r.x + r.w / 2;
	const cy = r.y + r.h / 2;
	let best: PlaceRect | undefined;
	let bestD = OPENING_SNAP;
	for (const s of querySolids(world, cx - OPENING_SNAP, cy - OPENING_SNAP, cx + OPENING_SNAP, cy + OPENING_SNAP)) {
		const openings = s.openings;
		if (s.kind !== "building" || openings === undefined) continue;
		for (const o of openings) {
			if (!fortifiable(o)) continue;
			const d = math.max(math.abs(o.x + o.w / 2 - cx), math.abs(o.y + o.h / 2 - cy));
			if (d < bestD) {
				bestD = d;
				best = { x: o.x, y: o.y, w: o.w, h: o.h };
			}
		}
	}
	return best ?? r;
}

/**
 * The opening whose gap starts exactly at (x, y), if any. A construction snapped into an opening travels in its
 * `SolidAdd` as a placeable, a position and a rotation -- not a size -- so a mirror of the world rebuilds its
 * rect with this (docs/MULTIPLAYER.md §4.5; the client does not materialise SolidAdd yet, MP_PHASE < 3).
 */
export function openingAt(world: WorldData, x: number, y: number): PlaceRect | undefined {
	for (const s of querySolids(world, x - 1, y - 1, x + 1, y + 1)) {
		const openings = s.openings;
		if (s.kind !== "building" || openings === undefined) continue;
		for (const o of openings) {
			if (!fortifiable(o)) continue;
			if (math.abs(o.x - x) < 0.5 && math.abs(o.y - y) < 0.5) return { x: o.x, y: o.y, w: o.w, h: o.h };
		}
	}
	return undefined;
}

/** inside the world, on no (non-passable) solid, and on no survivor's or live zombie's body */
export function placementValid(
	world: WorldData,
	r: PlaceRect,
	players: ReadonlyArray<PlayerState>,
	zombies: ReadonlyArray<ZombieState>,
): boolean {
	const gx = r.x;
	const gy = r.y;
	const w = r.w;
	const h = r.h;
	if (!(gx >= 0 && gy >= 0 && gx + w < world.width && gy + h < world.height)) return false;
	for (const s of querySolids(world, gx, gy, gx + w, gy + h)) {
		if (s.passable === true) continue;
		if (gx < s.x + s.w && gx + w > s.x && gy < s.y + s.h && gy + h > s.y) return false;
	}
	for (const pl of players) {
		if (rectCircleOverlap(gx, gy, w, h, pl.x, pl.y, PLAYER_RADIUS)) return false;
	}
	for (const z of zombies) {
		if (z.hp <= 0) continue;
		const zr = ZOMBIE_RADIUS * (z.scale ?? 1);
		if (rectCircleOverlap(gx, gy, w, h, z.x, z.y, zr)) return false;
	}
	return true;
}

/** the solid a placed construction becomes (doors start closed; lamps off, fires lit) */
export function placedSolid(def: PlaceableDef, r: PlaceRect, rot: number): Omit<Solid, "id"> {
	return {
		kind: def.kind,
		x: r.x,
		y: r.y,
		w: r.w,
		h: r.h,
		hp: def.hp,
		hpMax: def.hp,
		destructible: def.destructible,
		tags: def.tag,
		rot,
		open: def.kind === "door" || def.kind === "iron_door" ? false : undefined,
		powered: def.powered,
	};
}

/**
 * The craftKind-1 recipe that produced placeable `resultIndex` (cancelling refunds its ingredients), preferring
 * the one recorded at craft time (`preferred`, a CRAFT_RECIPES id).
 */
export function placeRecipe(resultIndex: number, preferred?: number): CraftRecipe | undefined {
	if (preferred !== undefined) {
		const r = CRAFT_RECIPES[preferred];
		if (r !== undefined && r.craftKind === 1 && r.resultIndex === resultIndex) return r;
	}
	for (const r of CRAFT_RECIPES) {
		if (r.craftKind === 1 && r.resultIndex === resultIndex) return r;
	}
	return undefined;
}
