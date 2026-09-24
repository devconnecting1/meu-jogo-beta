import { COLORS, Z } from "shared/engine/colors";
import { DESIGN, TOWN } from "shared/engine/constants";
import { chance, rnd, rndInt, rndRange } from "shared/engine/rng";
import { Vec2, v2 } from "shared/engine/vec2";
import { DYNAMIC_ID_BASE } from "shared/net/mpConfig";
import { buildingSeed, planBuilding } from "./interiors";
import type { Decor, Opening, RoomRect } from "./interiors";

export type SolidKind =
	| "wall_h"
	| "wall_v"
	| "building"
	| "tree"
	| "car"
	| "barricade"
	| "iron_barricade"
	| "door"
	| "iron_door"
	| "structure"
	/** a building's furniture (tags: the piece, shared/game/interiors.ts): blocks bodies; `low` ones let bullets by */
	| "furniture"
	/** a window's gap (passable, tags "window"): bodies climb through slowly, the horde's field prices it (EDI-10) */
	| "window";

export type DoorSide = "top" | "bottom" | "left" | "right";

export interface Solid {
	id: number;
	kind: SolidKind;
	x: number;
	y: number;
	w: number;
	h: number;
	hp: number;
	hpMax: number;
	/** building only */
	buildingType?: number;
	roofColor?: Color3;
	roofAlpha?: number;
	open?: boolean;
	/** loot slots */
	lootSlots?: number;
	lootItems?: Array<{ kind: number; id: number; count: number }>;
	lootTimer?: number;
	powered?: boolean;
	rot?: number;
	destructible: boolean;
	tags: string;
	/** seconds of hit-shake left (tree/car/trash when struck); renderer offsets the sprite */
	hitShake?: number;
	/** true → ignored by collision (e.g. the building record whose walls are separate solids) */
	passable?: boolean;
	/**
	 * building only: its MAIN entrance -- the doorway facing the street (EDI-01) -- by the centre of its gap (on
	 * the wall's mid-line) and the side of the box that wall faces. It may be set back from the box's edge into a
	 * porch or an entrance court (the facade that holds it is the street edge of `mainWing`). Every entrance,
	 * this one first: `entrancesOf`.
	 */
	doorX?: number;
	doorY?: number;
	doorSide?: DoorSide;
	/** building walls (tags "bwall"), windows and furniture: id of the building record they belong to */
	parentId?: number;
	/**
	 * building only (shared/game/interiors.ts): the footprint as non-overlapping rects (the record's own rect is
	 * their bounding box: a porch or a loading notch lies inside the box and outside every part), the rooms' floors,
	 * every doorway / window / interior opening, the flat decoration, and where the loot can be searched (EDI-03).
	 */
	parts?: Array<Rect>;
	/**
	 * building: the main wing -- the block behind the stretch of facade that holds the main entrance, as deep as
	 * the footprint stays full behind all of it (inside the footprint; its street edge is that facade). The
	 * storefront sign stands on its edge by the door (client/view/buildingSigns.ts), the roof units on its back.
	 */
	mainWing?: Rect;
	rooms?: Array<RoomRect>;
	openings?: Array<Opening>;
	decor?: Array<Decor>;
	lootSpots?: Array<{ x: number; y: number }>;
	/** building wall: a partition inside the building (not an outside wall) */
	inner?: boolean;
	/** furniture: bullets fly over it (a table, a bed); a tall piece stops them (a shelf, a wardrobe) */
	low?: boolean;
	/** furniture: the side facing into the room, and a small number the drawing uses */
	face?: DoorSide;
	variant?: number;
	/** tree only: visual canopy radius and the renderer-eased canopy opacity */
	canopyR?: number;
	canopyAlpha?: number;
	/** visual tint picked at generation (car paint, tree foliage) */
	tint?: Color3;
	/**
	 * car only: where the nose points (radians, world frame). Parked cars follow right-hand traffic;
	 * abandoned ones sit a few degrees askew. Collision stays the axis-aligned rect.
	 */
	heading?: number;
	/**
	 * Server (docs/MULTIPLAYER.md §4.5): the PLACEABLES id this construction was built from, and the slot of
	 * whoever built it. Both travel in the `SolidAdd` delta — the id so the mirror knows what to draw, the
	 * owner so the per-player build cap (§8.1) can be kept by the construction itself rather than by a
	 * bookkeeping table that a destroyed wall could desynchronise.
	 */
	placeable?: number;
	owner?: number;
	/** set by removeSolid, so stale references (AI targets, UI) can notice */
	removed?: boolean;
	/** internal: spatial-grid query stamp used to de-duplicate multi-cell solids */
	gridStamp?: number;
}

/**
 * Something lying on the ground, waiting to be picked up.
 *
 * There is no lifetime here, and that is a decision rather than an omission. The field used to exist
 * (`life: 120`), was written on every spawn and was never read by anything — an expiry somebody intended and
 * nobody built. Giving it a meaning now would mean deciding, for the whole game, that a pile of ammunition
 * a player deliberately left on the floor of their base evaporates while they are out scavenging, which is
 * the opposite of what a base is for. So: ground items are permanent, by design.
 *
 * If a lifetime is ever wanted, it has to distinguish WHO made the item — world litter (a zombie's drop, a
 * bin's contents, a tree's wood) may reasonably rot; anything a player put down may not — and that
 * distinction does not exist in this type yet. Until it does, the honest state is no field at all.
 */
export interface GroundItem {
	id: number;
	kind: number;
	itemId: number;
	count: number;
	x: number;
	y: number;
	/** 0 when at rest, which is the common case and the one `updateGroundItems` skips */
	vx: number;
	vy: number;
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type LotKind = "block" | "park" | "plaza";

/** Land use: shops line downtown (around the avenue crossing), houses the rest, civic = school/hospital. */
export type LotZone = "residential" | "commercial" | "civic";

/** Flat ground features of a lot (visual only: nothing here collides). */
export type GroundKind =
	/** grass service strip along the curb (street trees, bins) */
	| "verge"
	/** tree pit in a paved service strip (downtown) */
	| "pit"
	/** footpath from a door to the sidewalk */
	| "walk"
	/** curb cut / driveway through the service strip */
	| "drive"
	/** gas-station forecourt */
	| "apron"
	/** parking-lot asphalt and its stall lines */
	| "parking"
	| "stall"
	/** school yard */
	| "playground"
	/** tactile curb ramp where a crosswalk lands */
	| "ramp"
	/** a house's porch: the wooden deck in the front notch its door opens into */
	| "porch"
	/** a paved notch of a building's footprint: back patio, loading bay, courtyard */
	| "patio";

export interface GroundRect extends Rect {
	kind: GroundKind;
}

/**
 * A street-facing edge of a lot. The sidewalk band (TOWN.SIDEWALK deep) runs inside the lot along it:
 * the first TOWN.VERGE from the curb is the service strip, the rest is the clear path.
 */
export interface LotEdge {
	/** side of the lot that faces the street (= the wall a building on this edge has its door in) */
	side: DoorSide;
	/** curb (lot boundary) coordinate: y for top/bottom edges, x for left/right */
	curb: number;
	/** +1 when the lot lies at larger coordinates than the curb (top/left), -1 otherwise */
	inward: number;
	/** extent along the edge (x for top/bottom, y for left/right) */
	a: number;
	b: number;
	/** a cross street meets this edge at `a` / at `b` (a street corner, not the map border) */
	cornerA: boolean;
	cornerB: boolean;
	/** index into WorldData.roads of the street this edge faces */
	road: number;
}

/** A city block between roads (visual ground data; collision lives in solids). */
export interface Lot extends Rect {
	kind: LotKind;
	zone: LotZone;
	/** the lot minus the sidewalk band on its road-facing edges */
	yard: Rect;
	/** lighter grass tufts (visual only) */
	patches: Array<Rect>;
	/** dirt footpaths in parks (visual only, kept free of trees) */
	paths: Array<Rect>;
	/** street-facing edges (sidewalk bands) */
	edges: Array<LotEdge>;
	/** verges, tree pits, footpaths, driveways, forecourts, parking lots, playgrounds, ramps */
	ground: Array<GroundRect>;
}

export interface Road extends Rect {
	vertical: boolean;
	/** two lanes each way + planted median */
	avenue: boolean;
	/** street trees line both sides of this street */
	treeLined: boolean;
	/** planted median segments (avenues only), interrupted at every crossing */
	medians: Array<Rect>;
}

/** Zebra crossing on one arm of an intersection, in line with the sidewalks it connects. */
export interface Crossing extends Rect {
	/** the crossed road runs vertically: stripes are vertical bars laid out along x */
	vertical: boolean;
}

/** Uniform spatial hash of solids; maintained ONLY by addSolid/removeSolid. */
export interface SolidGrid {
	cell: number;
	cols: number;
	rows: number;
	/** a cell that never held a solid is the shared EMPTY_CELL (a fine grid is ~22,000 cells, most of them empty) */
	cells: Array<Array<Solid>>;
	stamp: number;
	/** solids held: a grid that holds none is skipped by every query (the fine grid, while the town is being laid) */
	count: number;
}

export interface WorldData {
	solids: Array<Solid>;
	items: Array<GroundItem>;
	width: number;
	height: number;
	roads: Array<Road>;
	lots: Array<Lot>;
	/** road × road overlap boxes */
	junctions: Array<Rect>;
	crossings: Array<Crossing>;
	bossAnchors: Array<{ day: number; x: number; y: number; type: number; nextDay: number }>;
	nextId: number;
	grid: SolidGrid;
	/**
	 * The walls, windows and furniture of the buildings (`Solid.parentId` set, shared/game/interiors.ts) live in
	 * this finer grid instead of `grid`: a 512 u cell of a built-up block holds a hundred of them, and every
	 * collision query of every body would walk them all. Both grids answer every query; a solid is in one.
	 */
	fine: SolidGrid;
	/**
	 * Server only (docs/MULTIPLAYER.md §4.5). 0 = off, which is the map generator and every client.
	 *
	 * The static map is generated identically on both sides from the same seed, so a static solid has the
	 * same id everywhere and travels for free. Anything created AFTER generation — a construction, a dropped
	 * item, a loot spill — exists only because the server made it, and its id has to be one the client could
	 * not have invented: `DYNAMIC_ID_BASE` (1 000 000) upwards. Switching this on is what turns a world into
	 * THE world; `serverWorld()` does it.
	 */
	nextDynamicId: number;
	/**
	 * Server only: told about every change a client has to be told about, at the single place that makes it
	 * (§4.5 deltas). A hook instead of call sites, because the creators are scattered — a zombie's death drop
	 * is in shared/sim/ai/zombieBrain.ts, a boss's in bossBrain.ts, the horde's in population.ts, a player's
	 * in the interaction code. Routing all of them by hand is a list you can forget to add to; a hook on the
	 * mutation itself cannot be forgotten, which is the whole point when the failure mode is "one player sees
	 * an item that does not exist for anyone else".
	 */
	onItemAdd?: (w: WorldData, item: GroundItem) => void;
	onItemRemove?: (w: WorldData, item: GroundItem) => void;
	onSolidAdd?: (w: WorldData, solid: Solid) => void;
	onSolidRemove?: (w: WorldData, solid: Solid) => void;
}

/**
 * Turns a freshly generated world into the SERVER's world (§4.5): from here on everything it creates takes a
 * dynamic id. Call it once, after `generateTown`, before anybody plays in it.
 */
export function serverWorld(w: WorldData, from = DYNAMIC_ID_BASE): WorldData {
	w.nextDynamicId = math.max(from, w.nextId + 1);
	return w;
}

/** the id the next created object takes: dynamic on the server, the plain counter everywhere else */
function takeId(w: WorldData): number {
	if (w.nextDynamicId > 0) {
		const id = w.nextDynamicId;
		w.nextDynamicId += 1;
		return id;
	}
	const id = w.nextId;
	w.nextId += 1;
	return id;
}

function rectOverlap(
	ax: number,
	ay: number,
	aw: number,
	ah: number,
	bx: number,
	by: number,
	bw: number,
	bh: number,
): boolean {
	return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/** an empty spatial grid of `cell`-sized cells over width × height */
/** the one cell every grid starts with everywhere: never written (gridInsert gives a cell its own list first) */
const EMPTY_CELL: Array<Solid> = [];

function newGrid(width: number, height: number, cell: number): SolidGrid {
	const cols = math.max(1, math.ceil(width / cell));
	const rows = math.max(1, math.ceil(height / cell));
	const cells: Array<Array<Solid>> = [];
	for (let i = 0; i < cols * rows; i++) {
		cells.push(EMPTY_CELL);
	}
	return { cell, cols, rows, cells, stamp: 0, count: 0 };
}

/** the cell of the grid of building parts (walls, windows, furniture): a room, not a block */
const FINE_CELL = 128;

export function createWorld(width: number, height: number): WorldData {
	return {
		solids: [],
		items: [],
		width,
		height,
		roads: [],
		lots: [],
		junctions: [],
		crossings: [],
		bossAnchors: [
			{ day: DESIGN.BOSS1_DAY, x: DESIGN.BOSS1_X, y: DESIGN.BOSS1_Y, type: 1, nextDay: DESIGN.BOSS1_DAY },
			{ day: DESIGN.BOSS2_DAY, x: DESIGN.BOSS2_X, y: DESIGN.BOSS2_Y, type: 2, nextDay: DESIGN.BOSS2_DAY },
			{ day: DESIGN.BOSS3_DAY, x: DESIGN.BOSS3_X, y: DESIGN.BOSS3_Y, type: 3, nextDay: DESIGN.BOSS3_DAY },
			{ day: DESIGN.BOSS4_DAY, x: DESIGN.BOSS4_X, y: DESIGN.BOSS4_Y, type: 4, nextDay: DESIGN.BOSS4_DAY },
		],
		nextId: 1,
		nextDynamicId: 0,
		grid: newGrid(width, height, TOWN.GRID_CELL),
		fine: newGrid(width, height, FINE_CELL),
	};
}

// ---------------------------------------------------------------------------
// spatial grid

function cellCol(g: SolidGrid, x: number): number {
	return math.clamp(math.floor(x / g.cell), 0, g.cols - 1);
}

function cellRow(g: SolidGrid, y: number): number {
	return math.clamp(math.floor(y / g.cell), 0, g.rows - 1);
}

function gridInsert(g: SolidGrid, s: Solid): void {
	const c0 = cellCol(g, s.x);
	const c1 = cellCol(g, s.x + s.w);
	const r0 = cellRow(g, s.y);
	const r1 = cellRow(g, s.y + s.h);
	for (let r = r0; r <= r1; r++) {
		for (let c = c0; c <= c1; c++) {
			const k = r * g.cols + c;
			let bucket = g.cells[k];
			if (bucket === EMPTY_CELL) {
				bucket = [];
				g.cells[k] = bucket;
			}
			bucket.push(s);
		}
	}
	g.count++;
}

function gridRemove(g: SolidGrid, s: Solid): void {
	const c0 = cellCol(g, s.x);
	const c1 = cellCol(g, s.x + s.w);
	const r0 = cellRow(g, s.y);
	const r1 = cellRow(g, s.y + s.h);
	for (let r = r0; r <= r1; r++) {
		for (let c = c0; c <= c1; c++) {
			const bucket = g.cells[r * g.cols + c];
			const i = bucket.indexOf(s);
			if (i >= 0) bucket.unorderedRemove(i);
		}
	}
	g.count = math.max(0, g.count - 1);
}

/** the grid a solid lives in: a building's own parts in the fine one, everything else in the coarse one */
function gridOf(w: WorldData, s: Solid): SolidGrid {
	return s.parentId !== undefined ? w.fine : w.grid;
}

/** The ONLY way to add a solid (keeps the spatial grid in sync). Solids must not move afterwards. */
export function addSolid(w: WorldData, s: Omit<Solid, "id">): Solid {
	const solid: Solid = { ...s, id: takeId(w) };
	w.solids.push(solid);
	gridInsert(gridOf(w, solid), solid);
	if (w.onSolidAdd !== undefined) w.onSolidAdd(w, solid);
	return solid;
}

/** Remove a solid (destroyed structure, etc.). Always go through here so spatial indexes stay in sync. */
export function removeSolid(w: WorldData, s: Solid): void {
	const i = w.solids.indexOf(s);
	if (i >= 0) w.solids.remove(i);
	gridRemove(gridOf(w, s), s);
	s.removed = true;
	if (w.onSolidRemove !== undefined) w.onSolidRemove(w, s);
}

/**
 * Every solid (passable ones included) whose rect overlaps [x0,x1]×[y0,y1], each once.
 * Uses the spatial grid: cost ∝ cells touched, not world size.
 */
export function querySolids(
	w: WorldData,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	out: Array<Solid> = [],
): Array<Solid> {
	// one stamp for both grids (a solid is in one of them): each solid once per query
	w.grid.stamp++;
	const stamp = w.grid.stamp;
	queryGrid(w.grid, stamp, x0, y0, x1, y1, out);
	queryGrid(w.fine, stamp, x0, y0, x1, y1, out);
	return out;
}

/**
 * `querySolids` without the buildings' own walls, windows and furniture (the coarse grid alone): the town as seen
 * from above with every roof on -- the building records, trees, cars, constructions. Same order as the first part
 * of a `querySolids` answer.
 */
export function queryTown(
	w: WorldData,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	out: Array<Solid> = [],
): Array<Solid> {
	w.grid.stamp++;
	queryGrid(w.grid, w.grid.stamp, x0, y0, x1, y1, out);
	return out;
}

/** the buildings' own walls, windows and furniture alone (the fine grid): the rest of a `querySolids` answer */
export function queryParts(
	w: WorldData,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	out: Array<Solid> = [],
): Array<Solid> {
	w.grid.stamp++;
	queryGrid(w.fine, w.grid.stamp, x0, y0, x1, y1, out);
	return out;
}

function queryGrid(g: SolidGrid, stamp: number, x0: number, y0: number, x1: number, y1: number, out: Array<Solid>) {
	if (g.count === 0) return;
	const c0 = cellCol(g, x0);
	const c1 = cellCol(g, x1);
	const r0 = cellRow(g, y0);
	const r1 = cellRow(g, y1);
	for (let r = r0; r <= r1; r++) {
		for (let c = c0; c <= c1; c++) {
			for (const s of g.cells[r * g.cols + c]) {
				if (s.gridStamp === stamp) continue;
				s.gridStamp = stamp;
				if (s.x < x1 && s.x + s.w > x0 && s.y < y1 && s.y + s.h > y0) {
					out.push(s);
				}
			}
		}
	}
}

/**
 * Does this solid stop movement, bullets and line of sight?
 * No for: passable records (building footprints), open doors (wood or iron), floor traps
 * (zombies must be able to step on them).
 */
export function isBlocking(s: Solid): boolean {
	if (s.passable === true) return false;
	if ((s.kind === "door" || s.kind === "iron_door") && s.open === true) return false;
	if (s.tags === "trap" || s.tags === "trap_electric") return false;
	return true;
}

/**
 * Every solid whose rect may meet the segment (x0, y0)–(x1, y1), each once: the coarse grid over the segment's box
 * (as `querySolids`), and of the building parts' fine grid only the cells the segment (± 1 u) crosses -- a long
 * line of sight across a built-up block no longer walks every room it passes by. Rays: physics.ts `raycast`.
 */
export function querySegment(
	w: WorldData,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	out: Array<Solid> = [],
): Array<Solid> {
	w.grid.stamp++;
	const stamp = w.grid.stamp;
	const lx = math.min(x0, x1) - 1;
	const hx = math.max(x0, x1) + 1;
	const ly = math.min(y0, y1) - 1;
	const hy = math.max(y0, y1) + 1;
	queryGrid(w.grid, stamp, lx, ly, hx, hy, out);
	const g = w.fine;
	if (g.count === 0) return out;
	const c0 = cellCol(g, lx);
	const c1 = cellCol(g, hx);
	const dx = x1 - x0;
	for (let c = c0; c <= c1; c++) {
		// the stretch of the segment inside this column (± 1 u), and so the rows it crosses
		let ya = ly;
		let yb = hy;
		if (math.abs(dx) > 1e-9) {
			const xa = math.max(lx, c * g.cell);
			const xb = math.min(hx, (c + 1) * g.cell);
			const ta = math.clamp((xa - x0) / dx, 0, 1);
			const tb = math.clamp((xb - x0) / dx, 0, 1);
			const ya0 = y0 + (y1 - y0) * ta;
			const yb0 = y0 + (y1 - y0) * tb;
			ya = math.min(ya0, yb0) - 1;
			yb = math.max(ya0, yb0) + 1;
		}
		const r0 = cellRow(g, ya);
		const r1 = cellRow(g, yb);
		for (let r = r0; r <= r1; r++) {
			for (const s of g.cells[r * g.cols + c]) {
				if (s.gridStamp === stamp) continue;
				s.gridStamp = stamp;
				if (s.x < hx && s.x + s.w > lx && s.y < hy && s.y + s.h > ly) out.push(s);
			}
		}
	}
	return out;
}

/** First blocking solid containing the point (± pad). Bullets, line of sight, spawn checks. */
export function pointInSolid(w: WorldData, x: number, y: number, pad = 0): Solid | undefined {
	return pointInGrid(w.grid, x, y, pad) ?? pointInGrid(w.fine, x, y, pad);
}

function pointInGrid(g: SolidGrid, x: number, y: number, pad: number): Solid | undefined {
	if (g.count === 0) return undefined;
	const c0 = cellCol(g, x - pad);
	const c1 = cellCol(g, x + pad);
	const r0 = cellRow(g, y - pad);
	const r1 = cellRow(g, y + pad);
	for (let r = r0; r <= r1; r++) {
		for (let c = c0; c <= c1; c++) {
			for (const s of g.cells[r * g.cols + c]) {
				if (!isBlocking(s)) continue;
				if (x >= s.x - pad && x <= s.x + s.w + pad && y >= s.y - pad && y <= s.y + s.h + pad) {
					return s;
				}
			}
		}
	}
	return undefined;
}

/** First blocking solid overlapping the rect centred at (x, y). Movement (physics.moveActor). */
export function rectHitsSolid(w: WorldData, x: number, y: number, rw: number, rh: number): Solid | undefined {
	const left = x - rw / 2;
	const top = y - rh / 2;
	return rectInGrid(w.grid, left, top, rw, rh) ?? rectInGrid(w.fine, left, top, rw, rh);
}

function rectInGrid(g: SolidGrid, left: number, top: number, rw: number, rh: number): Solid | undefined {
	if (g.count === 0) return undefined;
	const c0 = cellCol(g, left);
	const c1 = cellCol(g, left + rw);
	const r0 = cellRow(g, top);
	const r1 = cellRow(g, top + rh);
	for (let r = r0; r <= r1; r++) {
		for (let c = c0; c <= c1; c++) {
			for (const s of g.cells[r * g.cols + c]) {
				if (!isBlocking(s)) continue;
				if (rectOverlap(left, top, rw, rh, s.x, s.y, s.w, s.h)) {
					return s;
				}
			}
		}
	}
	return undefined;
}

/**
 * Is the point inside this building's footprint (walls included)? The union of its parts: a porch, a patio or a
 * loading notch inside the bounding box is OUTSIDE (EDI-04: the roof fades only with the survivor really inside).
 */
export function insideBuilding(s: Solid, x: number, y: number): boolean {
	if (x < s.x || x > s.x + s.w || y < s.y || y > s.y + s.h) return false;
	const parts = s.parts;
	if (parts === undefined) return true;
	for (const p of parts) {
		if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return true;
	}
	return false;
}

/**
 * Every entrance of a building (EDI-09), the MAIN one first: the doorways of its plan, each with its gap (the
 * wall-thick rect) and the side it looks out of. Windows are not entrances here (`Solid.openings` has them).
 * `out` is filled and returned (no allocation per call); a building without a plan has none.
 */
export function entrancesOf(s: Solid, out: Array<Opening>): Array<Opening> {
	out.clear();
	const list = s.openings;
	if (list === undefined) return out;
	for (const o of list) if (o.kind === "door" && o.main) out.push(o);
	for (const o of list) if (o.kind === "door" && !o.main) out.push(o);
	return out;
}

/** Building record whose footprint contains the point (walls included), if any. */
export function buildingAt(w: WorldData, x: number, y: number): Solid | undefined {
	for (const s of querySolids(w, x - 1, y - 1, x + 1, y + 1)) {
		if (s.kind === "building" && insideBuilding(s, x, y)) {
			return s;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// procedural town
//
// Layout rules (docs/DESIGN_RULES.md, checked by tools/validate-world.mjs):
// - one avenue each way through the middle (median with trees), two-lane streets elsewhere;
//   zebra crossings on every arm of every intersection, in line with the sidewalks;
// - sidewalk band = service strip at the curb (grass verge, or tree pits downtown) + a clear path
//   that nothing solid ever enters; street trees and bins live only in the service strip;
// - shops around the avenue crossing stand at the sidewalk, houses keep a front yard, gas stations
//   take a corner with an open forecourt, schools/hospitals get a yard or a parking lot;
// - every door faces its street with a free approach (no tree, bin or parked car in front);
// - cars park parallel to the curb in the direction of traffic (right-hand), never near corners;
//   a few are abandoned askew in a lane, always leaving one lane free.

/** MINSTD (Park–Miller): every product stays below 2^53, so it is exact in Luau doubles. */
class TownRng {
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

	range(a: number, b: number): number {
		return a + this.next() * (b - a);
	}

	int(a: number, b: number): number {
		return math.min(b, a + math.floor(this.next() * (b - a + 1)));
	}

	chance(p: number): boolean {
		return this.next() < p;
	}
}

/** deterministic 0..1 hash of a position (original: random_set_seed(x + y + object_index)) */
export function hash01(x: number, y: number, salt = 0): number {
	const n = math.sin(x * 12.9898 + y * 78.233 + salt * 37.719) * 43758.5453;
	return n - math.floor(n);
}

/** Dead Town colour recipe: make_colour_hsv(floor(irandom(250)/10)*10, 70, 190) */
function deadTownHsv(x: number, y: number, salt: number): Color3 {
	const hue = (math.floor(hash01(x, y, salt) * 26) * 10) / 255;
	return Color3.fromHSV(hue, 70 / 255, 190 / 255);
}

interface BuildingDef {
	type: number;
	w: number;
	h: number;
	slots: number;
	name: string;
	weight: number;
}

/** houses (types 1/2): footprints are Dead Town's sprites × 4 */
const HOUSE_DEFS: Array<BuildingDef> = [
	{ type: 1, w: 428, h: 552, slots: 3, name: "house", weight: 4 },
	{ type: 1, w: 684, h: 556, slots: 2, name: "house", weight: 3 },
	{ type: 2, w: 808, h: 684, slots: 3, name: "house", weight: 2 },
	{ type: 2, w: 1068, h: 1068, slots: 3, name: "house", weight: 0.4 },
];

const SHOP_DEFS: Record<number, BuildingDef> = {
	6: { type: 6, w: 684, h: 556, slots: 2, name: "pharmacy", weight: 1 },
	7: { type: 7, w: 1064, h: 1068, slots: 4, name: "market", weight: 1 },
	8: { type: 8, w: 684, h: 556, slots: 2, name: "market", weight: 1 },
	9: { type: 9, w: 684, h: 556, slots: 2, name: "gunshop", weight: 1 },
	10: { type: 10, w: 684, h: 556, slots: 2, name: "cloth", weight: 1 },
	11: { type: 11, w: 1064, h: 1068, slots: 4, name: "restaurant", weight: 1 },
};

/** downtown shop mix, dealt without replacement (reshuffled when it runs out) */
const SHOP_MIX: Array<number> = [
	6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 8, 8, 8, 8, 8, 8, 9, 9, 9, 9, 9, 10, 10, 10, 10, 10, 11, 11, 11, 11,
];
/** small shops that also open on a residential corner along the avenue */
const CORNER_SHOPS: Array<number> = [8, 6, 10, 9];

const GAS_DEF: BuildingDef = { type: 5, w: 684, h: 556, slots: 2, name: "gas", weight: 1 };
/** the largest buildings, with room left on the lot for a school yard / parking lot */
const SCHOOL_DEF: BuildingDef = { type: 3, w: 1064, h: 812, slots: 4, name: "school", weight: 1 };
const HOSPITAL_DEF: BuildingDef = { type: 4, w: 1064, h: 812, slots: 4, name: "hospital", weight: 1 };

const SCHOOLS = 3;
const HOSPITALS = 3;
const GAS_STATIONS = 5;
const PARKS = 6;
/** lots on each side of the avenue crossing (along each avenue) that are downtown */
const DOWNTOWN_REACH = 2;
/** share of streets lined with trees (avenues always are, on the median) */
const TREE_LINED_SHARE = 0.55;

/** Shops get a signature roof so the player can navigate by colour; houses use Dead Town's HSV. */
const SHOP_ROOF: Record<number, Color3> = {
	3: Color3.fromRGB(176, 140, 90),
	4: Color3.fromRGB(222, 222, 216),
	5: Color3.fromRGB(206, 176, 64),
	6: Color3.fromRGB(88, 158, 108),
	7: Color3.fromRGB(204, 124, 62),
	8: Color3.fromRGB(204, 124, 62),
	9: Color3.fromRGB(78, 82, 90),
	10: Color3.fromRGB(150, 100, 160),
	11: Color3.fromRGB(172, 62, 56),
};

function pickWeighted(rng: TownRng, defs: Array<BuildingDef>): BuildingDef {
	let total = 0;
	for (const b of defs) total += b.weight;
	let r = rng.next() * total;
	for (const b of defs) {
		r -= b.weight;
		if (r < 0) return b;
	}
	return defs[0];
}

function snap8(v: number): number {
	return math.floor(v / 8 + 0.5) * 8;
}

interface Circle {
	x: number;
	y: number;
	r: number;
}

function circleHitsRect(c: Circle, x: number, y: number, w: number, h: number): boolean {
	const nx = math.clamp(c.x, x, x + w);
	const ny = math.clamp(c.y, y, y + h);
	const dx = c.x - nx;
	const dy = c.y - ny;
	return dx * dx + dy * dy < c.r * c.r;
}

function isAlongX(side: DoorSide): boolean {
	return side === "top" || side === "bottom";
}

/** rect of [u0,u1] along an edge × [v0,v1] measured inward from its curb (v < 0 lies on the road) */
function edgeRect(e: LotEdge, u0: number, u1: number, v0: number, v1: number): Rect {
	const p0 = e.curb + e.inward * v0;
	const p1 = e.curb + e.inward * v1;
	const lo = math.min(p0, p1);
	const hi = math.max(p0, p1);
	const a = math.min(u0, u1);
	const b = math.max(u0, u1);
	return isAlongX(e.side) ? { x: a, y: lo, w: b - a, h: hi - lo } : { x: lo, y: a, w: hi - lo, h: b - a };
}

/** extent of the lot's yard along an edge */
function yardSpan(lot: Lot, e: LotEdge): { a: number; b: number } {
	return isAlongX(e.side)
		? { a: lot.yard.x, b: lot.yard.x + lot.yard.w }
		: { a: lot.yard.y, b: lot.yard.y + lot.yard.h };
}

/** depth of the yard measured from an edge's sidewalk */
function yardDepth(lot: Lot, e: LotEdge): number {
	return isAlongX(e.side) ? lot.yard.h : lot.yard.w;
}

/** Rect bucket index (reserved zones: door approaches, driveways, no-parking, parking lots...). */
class RectIndex {
	private cells: Array<Array<Rect>> = [];
	private cols: number;
	private rows: number;

	constructor(
		width: number,
		height: number,
		private cell: number,
	) {
		this.cols = math.max(1, math.ceil(width / cell));
		this.rows = math.max(1, math.ceil(height / cell));
		for (let i = 0; i < this.cols * this.rows; i++) this.cells.push([]);
	}

	add(r: Rect): void {
		const c0 = math.clamp(math.floor(r.x / this.cell), 0, this.cols - 1);
		const c1 = math.clamp(math.floor((r.x + r.w) / this.cell), 0, this.cols - 1);
		const r0 = math.clamp(math.floor(r.y / this.cell), 0, this.rows - 1);
		const r1 = math.clamp(math.floor((r.y + r.h) / this.cell), 0, this.rows - 1);
		for (let row = r0; row <= r1; row++) {
			for (let col = c0; col <= c1; col++) this.cells[row * this.cols + col].push(r);
		}
	}

	/** every rect overlapping the box (a rect spanning several cells may appear more than once) */
	query(x: number, y: number, w: number, h: number, out: Array<Rect>): Array<Rect> {
		const c0 = math.clamp(math.floor(x / this.cell), 0, this.cols - 1);
		const c1 = math.clamp(math.floor((x + w) / this.cell), 0, this.cols - 1);
		const r0 = math.clamp(math.floor(y / this.cell), 0, this.rows - 1);
		const r1 = math.clamp(math.floor((y + h) / this.cell), 0, this.rows - 1);
		for (let row = r0; row <= r1; row++) {
			for (let col = c0; col <= c1; col++) {
				for (const r of this.cells[row * this.cols + col]) {
					if (rectOverlap(x, y, w, h, r.x, r.y, r.w, r.h)) out.push(r);
				}
			}
		}
		return out;
	}

	hits(x: number, y: number, w: number, h: number): boolean {
		const c0 = math.clamp(math.floor(x / this.cell), 0, this.cols - 1);
		const c1 = math.clamp(math.floor((x + w) / this.cell), 0, this.cols - 1);
		const r0 = math.clamp(math.floor(y / this.cell), 0, this.rows - 1);
		const r1 = math.clamp(math.floor((y + h) / this.cell), 0, this.rows - 1);
		for (let row = r0; row <= r1; row++) {
			for (let col = c0; col <= c1; col++) {
				for (const r of this.cells[row * this.cols + col]) {
					if (rectOverlap(x, y, w, h, r.x, r.y, r.w, r.h)) return true;
				}
			}
		}
		return false;
	}
}

/** Placement bookkeeping for one generation pass. */
class Placer {
	/** door approaches, driveways, forecourts, parking lots, park paths, no-parking zones */
	readonly reserved: RectIndex;
	bossClear: Array<Circle> = [];
	private scratch: Array<Solid> = [];

	constructor(private w: WorldData) {
		this.reserved = new RectIndex(w.width, w.height, TOWN.GRID_CELL);
	}

	reserve(r: Rect): void {
		this.reserved.add(r);
	}

	/** free of every solid (building footprints too), reserved area, boss plaza (and roads unless allowed) */
	canPlace(x: number, y: number, rw: number, rh: number, pad: number, allowRoad = false): boolean {
		const w = this.w;
		if (x < TOWN.BORDER || y < TOWN.BORDER || x + rw > w.width - TOWN.BORDER || y + rh > w.height - TOWN.BORDER) {
			return false;
		}
		this.scratch.clear();
		if (querySolids(w, x - pad, y - pad, x + rw + pad, y + rh + pad, this.scratch).size() > 0) return false;
		if (this.reserved.hits(x, y, rw, rh)) return false;
		for (const c of this.bossClear) {
			if (circleHitsRect(c, x, y, rw, rh)) return false;
		}
		if (!allowRoad) {
			for (const r of w.roads) {
				if (rectOverlap(x, y, rw, rh, r.x, r.y, r.w, r.h)) return false;
			}
		}
		return true;
	}
}

interface RoadSpan {
	start: number;
	size: number;
	avenue: boolean;
}

/** Evenly spaced roads with seeded jitter; the middle one is the avenue. */
function layoutRoads(total: number, rng: TownRng): Array<RoadSpan> {
	const inner = total - TOWN.BORDER * 2;
	const n = math.max(1, math.floor((inner - TOWN.LOT_TARGET) / (TOWN.LOT_TARGET + TOWN.ROAD_W) + 0.5));
	const avenue = math.floor((n + 1) / 2);
	const lot = (inner - (n - 1) * TOWN.ROAD_W - TOWN.AVENUE_W) / (n + 1);
	const spans: Array<RoadSpan> = [];
	let pos = TOWN.BORDER;
	for (let i = 1; i <= n; i++) {
		pos += lot;
		const size = i === avenue ? TOWN.AVENUE_W : TOWN.ROAD_W;
		spans.push({ start: snap8(pos + rng.range(-TOWN.ROAD_JITTER, TOWN.ROAD_JITTER)), size, avenue: i === avenue });
		pos += size;
	}
	return spans;
}

interface LotSpan {
	a: number;
	b: number;
	/** index of the road on the low / high side (-1 = map border) */
	lo: number;
	hi: number;
}

/** intervals between roads (and between the border and the first/last road) */
function lotSpans(total: number, roads: Array<RoadSpan>): Array<LotSpan> {
	const spans: Array<LotSpan> = [];
	let a = TOWN.BORDER;
	let lo = -1;
	for (let i = 0; i < roads.size(); i++) {
		spans.push({ a, b: roads[i].start, lo, hi: i });
		a = roads[i].start + roads[i].size;
		lo = i;
	}
	spans.push({ a, b: total - TOWN.BORDER, lo, hi: -1 });
	return spans;
}

/** a stretch of an edge's service strip that must stay paved and empty (footpath, driveway, forecourt) */
interface Cut {
	a: number;
	b: number;
	kind: GroundKind;
}

/** a building placed by the generator, remembered for bins/walkways */
interface Placed {
	solid: Solid;
	edge: LotEdge;
	/** door centre along the edge axis */
	doorU: number;
	def: BuildingDef;
}

/** generator state shared by the passes */
interface Gen {
	w: WorldData;
	rng: TownRng;
	placer: Placer;
	cuts: Map<LotEdge, Array<Cut>>;
	placed: Map<Lot, Array<Placed>>;
	/** per road index: street-tree pitch and lattice phase */
	pitch: Array<number>;
	phase: Array<number>;
	shopDeck: Array<number>;
	/** the town's seed: mixed into every building's own seed (interiors never draw from `rng`) */
	townSeed: number;
	/** called between two buildings' interiors (generateTown's `pace`): may yield, never changes the town */
	pace?: () => void;
}

function cutsOf(g: Gen, e: LotEdge): Array<Cut> {
	let c = g.cuts.get(e);
	if (c === undefined) {
		c = [];
		g.cuts.set(e, c);
	}
	return c;
}

function inCut(g: Gen, e: LotEdge, u0: number, u1: number, margin: number): boolean {
	for (const c of cutsOf(g, e)) {
		if (u1 > c.a - margin && u0 < c.b + margin) return true;
	}
	return false;
}

/** keep the road in front of [u0,u1] of an edge free of parked cars (doors, driveways) */
function noParking(g: Gen, e: LotEdge, u0: number, u1: number): void {
	g.placer.reserve(edgeRect(e, u0, u1, -(TOWN.CURB_GAP + TOWN.CAR_W + 24), 0));
}

/** a static piece of a building (wall, window, furniture): indestructible, belongs to the record `parentId` */
function addPart(w: WorldData, kind: SolidKind, q: Rect, parentId: number, tags: string, extra?: Partial<Solid>): void {
	if (q.w < 2 || q.h < 2) return;
	addSolid(w, {
		kind,
		x: q.x,
		y: q.y,
		w: q.w,
		h: q.h,
		hp: 999999,
		hpMax: 999999,
		destructible: false,
		tags,
		parentId,
		...extra,
	});
}

/**
 * A real building: a passable footprint record (loot, roof, the main door) whose street face looks onto edge `e`,
 * with its main door at `doorU` along it (EDI-01); `front` = curb → the footprint's street face. The walls, the
 * rooms, the other entrances, the windows and the furniture come later, from shared/game/interiors.ts, once the
 * whole town stands (`planInteriors`): until then the record's box keeps everything else out, exactly as the four
 * walls of the old box did, so the town around the buildings is the one it always was.
 */
function addBuilding(g: Gen, lot: Lot, b: BuildingDef, r: Rect, e: LotEdge, doorU: number, front: number): Solid {
	const w = g.w;
	const T = TOWN.WALL_T;
	const D = TOWN.DOOR_W;
	const side = e.side;
	const along = isAlongX(side) ? doorU - r.x : doorU - r.y;
	// the door on the street face (the plan may set it back into a porch)
	let doorX = r.x + along;
	let doorY = r.y + along;
	if (side === "top") doorY = r.y + T / 2;
	else if (side === "bottom") doorY = r.y + r.h - T / 2;
	else if (side === "left") doorX = r.x + T / 2;
	else doorX = r.x + r.w - T / 2;
	const roof = SHOP_ROOF[b.type] ?? deadTownHsv(r.x, r.y, b.type);
	const rec = addSolid(w, {
		kind: "building",
		x: r.x,
		y: r.y,
		w: r.w,
		h: r.h,
		hp: 99999,
		hpMax: 99999,
		destructible: false,
		tags: b.name,
		buildingType: b.type,
		roofColor: roof,
		roofAlpha: 1,
		lootSlots: b.slots,
		lootItems: [],
		lootTimer: 0,
		passable: true,
		doorX,
		doorY,
		doorSide: side,
	});
	// keep the approach free from the curb to 110 inside, and nobody parks in front of it
	const half = D / 2 + 24;
	g.placer.reserve(edgeRect(e, doorU - half, doorU + half, 0, front + 110));
	noParking(g, e, doorU - 110, doorU + 110);
	// footpath across the front yard, and through the service strip
	if (front > TOWN.SIDEWALK + 24) {
		const pw = b.type === 1 || b.type === 2 ? 36 : D / 2;
		lot.ground.push({ ...edgeRect(e, doorU - pw, doorU + pw, TOWN.SIDEWALK, front), kind: "walk" });
	}
	cutsOf(g, e).push({ a: doorU - 52, b: doorU + 52, kind: "walk" });
	let list = g.placed.get(lot);
	if (list === undefined) {
		list = [];
		g.placed.set(lot, list);
	}
	list.push({ solid: rec, edge: e, doorU, def: b });
	return rec;
}

/**
 * Try to put building `b` on edge `e` at `u` along it (front `setback` behind the sidewalk).
 * Returns the far end along the edge, or undefined when it does not fit.
 */
function tryFront(
	g: Gen,
	lot: Lot,
	e: LotEdge,
	b: BuildingDef,
	u: number,
	setback: number,
	longAlong: boolean,
	doorJitter: number,
): number | undefined {
	const span = yardSpan(lot, e);
	const depthMax = yardDepth(lot, e);
	const longFirst = b.w >= b.h;
	const firstFlip = longAlong ? !longFirst : g.rng.chance(0.5);
	for (const flip of [firstFlip, !firstFlip]) {
		const along = flip ? b.h : b.w;
		const depth = flip ? b.w : b.h;
		if (u + along > span.b - TOWN.SIDE_YARD) continue;
		if (setback + depth > depthMax - TOWN.SIDE_YARD) continue;
		const front = TOWN.SIDEWALK + setback;
		const r = edgeRect(e, u, u + along, front, front + depth);
		if (!g.placer.canPlace(r.x, r.y, r.w, r.h, TOWN.BUILDING_GAP)) continue;
		const slack = math.max(0, along / 2 - TOWN.DOOR_W / 2 - 80);
		const doorU = math.floor(u + along / 2 + g.rng.range(-1, 1) * slack * doorJitter);
		addBuilding(g, lot, b, r, e, doorU, front);
		return u + along;
	}
	return undefined;
}

interface PackOpts {
	setMin: number;
	setMax: number;
	gapMin: number;
	gapMax: number;
	max: number;
	longAlong: boolean;
	doorJitter: number;
}

/** Line buildings up along one street face of a lot, each facing that street. */
function packFace(
	g: Gen,
	lot: Lot,
	e: LotEdge,
	cands: () => Array<BuildingDef>,
	taken: (b: BuildingDef) => void,
	o: PackOpts,
): number {
	const span = yardSpan(lot, e);
	let u = snap8(span.a + TOWN.SIDE_YARD + g.rng.range(0, 64));
	let placed = 0;
	let guard = 0;
	while (placed < o.max && u < span.b - TOWN.SIDE_YARD - 400 && guard < 14) {
		guard++;
		let farEnd: number | undefined;
		for (const b of cands()) {
			farEnd = tryFront(g, lot, e, b, u, snap8(g.rng.range(o.setMin, o.setMax)), o.longAlong, o.doorJitter);
			if (farEnd !== undefined) {
				taken(b);
				break;
			}
		}
		if (farEnd !== undefined) {
			placed++;
			u = snap8(farEnd + g.rng.range(o.gapMin, o.gapMax));
		} else {
			u += 96;
		}
	}
	return placed;
}

function shuffle<T>(rng: TownRng, arr: Array<T>): Array<T> {
	for (let i = arr.size() - 1; i > 0; i--) {
		const j = rng.int(0, i);
		const t = arr[i];
		arr[i] = arr[j];
		arr[j] = t;
	}
	return arr;
}

/** next shops of the downtown deck (refilled and reshuffled when empty) */
function shopCandidates(g: Gen, n: number): Array<BuildingDef> {
	if (g.shopDeck.size() < n) {
		for (const t of shuffle(g.rng, [...SHOP_MIX])) g.shopDeck.push(t);
	}
	const out: Array<BuildingDef> = [];
	for (let i = 0; i < math.min(n, g.shopDeck.size()); i++) out.push(SHOP_DEFS[g.shopDeck[i]]);
	return out;
}

function takeShop(g: Gen, b: BuildingDef): void {
	const i = g.shopDeck.indexOf(b.type);
	if (i >= 0) g.shopDeck.remove(i);
}

function houseCandidates(g: Gen): Array<BuildingDef> {
	const first = pickWeighted(g.rng, HOUSE_DEFS);
	const out: Array<BuildingDef> = [first];
	for (const b of HOUSE_DEFS) {
		if (b !== first && b.w * b.h <= first.w * first.h) out.push(b);
	}
	return out;
}

// ---------------------------------------------------------------------------
// lot programs

/** [u0,u1] along an edge × [v0,v1] from its curb */
interface FrontRect {
	u0: number;
	u1: number;
	v0: number;
	v1: number;
}

/** free 32 u cells of a lot's yard: kept 32 u off every solid, outside reserved zones and boss plazas */
interface YardGrid {
	x0: number;
	y0: number;
	cols: number;
	rows: number;
	free: Array<boolean>;
}

const CELL = 32;

/** rasterised (cheap in Luau): each solid (+32) and reserved zone blocks the cells it overlaps */
function yardGrid(g: Gen, lot: Lot): YardGrid {
	const y = lot.yard;
	const x0 = y.x + 8;
	const y0 = y.y + 8;
	const cols = math.max(0, math.floor((y.w - 16) / CELL));
	const rows = math.max(0, math.floor((y.h - 16) / CELL));
	const free: Array<boolean> = [];
	for (let k = 0; k < cols * rows; k++) free.push(true);
	const block = (ax: number, ay: number, bx: number, by: number) => {
		const i0 = math.max(0, math.floor((ax - x0) / CELL));
		const i1 = math.min(cols - 1, math.ceil((bx - x0) / CELL) - 1);
		const j0 = math.max(0, math.floor((ay - y0) / CELL));
		const j1 = math.min(rows - 1, math.ceil((by - y0) / CELL) - 1);
		for (let j = j0; j <= j1; j++) {
			for (let i = i0; i <= i1; i++) free[j * cols + i] = false;
		}
	};
	const P = 32;
	for (const s of querySolids(g.w, y.x - P, y.y - P, y.x + y.w + P, y.y + y.h + P)) {
		block(s.x - P, s.y - P, s.x + s.w + P, s.y + s.h + P);
	}
	for (const r of g.placer.reserved.query(y.x, y.y, y.w, y.h, [])) block(r.x, r.y, r.x + r.w, r.y + r.h);
	for (const c of g.placer.bossClear) {
		if (!circleHitsRect(c, y.x, y.y, y.w, y.h)) continue;
		for (let j = 0; j < rows; j++) {
			for (let i = 0; i < cols; i++) {
				if (circleHitsRect(c, x0 + i * CELL, y0 + j * CELL, CELL, CELL)) free[j * cols + i] = false;
			}
		}
	}
	return { x0, y0, cols, rows, free };
}

/**
 * Largest free rectangle of the yard that opens onto edge `e`'s side (parking lot, school yard),
 * as [u0,u1] along the edge × [v0,v1] from the curb.
 */
function freeFrontRect(grid: YardGrid, e: LotEdge, minAlong: number, minDepth: number): FrontRect | undefined {
	const { x0, y0, cols, rows, free } = grid;
	const horizontal = isAlongX(e.side);
	const nu = horizontal ? cols : rows;
	const nv = horizontal ? rows : cols;
	if (nu <= 0 || nv <= 0) return undefined;
	// free depth from this edge's side of the yard, per column along it
	const depth: Array<number> = [];
	for (let i = 0; i < nu; i++) {
		let d = 0;
		for (let k = 0; k < nv; k++) {
			const j = e.inward > 0 ? k : nv - 1 - k;
			const idx = horizontal ? j * cols + i : i * cols + j;
			if (!free[idx]) break;
			d++;
		}
		depth.push(d);
	}
	const u0 = horizontal ? x0 : y0;
	let v0: number;
	if (e.side === "top") v0 = y0 - e.curb;
	else if (e.side === "bottom") v0 = e.curb - (y0 + rows * CELL);
	else if (e.side === "left") v0 = x0 - e.curb;
	else v0 = e.curb - (x0 + cols * CELL);
	let best: FrontRect | undefined;
	let bestArea = 0;
	for (let i = 0; i < nu; i++) {
		let h = math.huge;
		for (let j = i; j < nu; j++) {
			h = math.min(h, depth[j]);
			if (h <= 0) break;
			const along = (j - i + 1) * CELL;
			const dep = h * CELL;
			if (along >= minAlong && dep >= minDepth && along * dep > bestArea) {
				bestArea = along * dep;
				best = { u0: u0 + i * CELL, u1: u0 + (j + 1) * CELL, v0, v1: v0 + dep };
			}
		}
	}
	return best;
}

function addCar(w: WorldData, x: number, y: number, cw: number, ch: number, heading: number): void {
	const q = math.floor(heading / (math.pi / 2) + 0.5);
	addSolid(w, {
		kind: "car",
		x,
		y,
		w: cw,
		h: ch,
		hp: 300,
		hpMax: 300,
		destructible: true,
		tags: "car",
		rot: q - math.floor(q / 4) * 4,
		heading,
		tint: deadTownHsv(x, y, 17),
	});
}

function addTrash(w: WorldData, x: number, y: number): void {
	addSolid(w, {
		kind: "car",
		x,
		y,
		w: TOWN.TRASH,
		h: TOWN.TRASH,
		hp: 1,
		hpMax: 1,
		destructible: true,
		tags: "trash",
	});
}

/** heading of edge e's inward normal (radians) */
function inwardHeading(e: LotEdge): number {
	if (e.side === "top") return math.pi / 2;
	if (e.side === "bottom") return -math.pi / 2;
	if (e.side === "left") return 0;
	return math.pi;
}

/** Largest free rectangle opening onto any street edge of the lot. */
function bestFrontRect(
	lot: Lot,
	grid: YardGrid,
	minAlong: number,
	minDepth: number,
): { e: LotEdge; r: FrontRect } | undefined {
	let best: { e: LotEdge; r: FrontRect } | undefined;
	let bestArea = 0;
	for (const e of lot.edges) {
		const r = freeFrontRect(grid, e, minAlong, minDepth);
		if (r !== undefined && (r.u1 - r.u0) * (r.v1 - r.v0) > bestArea) {
			bestArea = (r.u1 - r.u0) * (r.v1 - r.v0);
			best = { e, r };
		}
	}
	return best;
}

/** Head-in parking lot opening onto edge `e` (one or two stall rows behind an aisle). */
function addParking(g: Gen, lot: Lot, e: LotEdge, free: FrontRect): boolean {
	const SW = 112;
	const SD = 224;
	const AISLE = 200;
	// no deeper than two rows + aisle, no wider than nine stalls (centred in the free space)
	const mid0 = (free.u0 + free.u1) / 2;
	const half = math.min(free.u1 - free.u0, SW * 9 + 16) / 2;
	const p = { u0: mid0 - half, u1: mid0 + half, v0: free.v0, v1: math.min(free.v1, free.v0 + SD * 2 + AISLE) };
	const depth = p.v1 - p.v0;
	const n = math.floor((p.u1 - p.u0 - 16) / SW);
	if (n < 3 || depth < SD + AISLE) return false;
	const us = p.u0 + (p.u1 - p.u0 - n * SW) / 2;
	const mid = (p.u0 + p.u1) / 2;
	lot.ground.push({ ...edgeRect(e, p.u0, p.u1, p.v0, p.v1), kind: "parking" });
	const rows: Array<{ v0: number; nose: number }> = [{ v0: p.v1 - SD, nose: inwardHeading(e) }];
	if (depth >= SD * 2 + AISLE) rows.push({ v0: p.v0, nose: inwardHeading(e) + math.pi });
	for (const row of rows) {
		const front = row.v0 === p.v0;
		for (let k = 0; k <= n; k++) {
			const u = us + k * SW;
			// the front row leaves the entrance open
			if (front && math.abs(u - mid) < 150) continue;
			lot.ground.push({ ...edgeRect(e, u - 3, u + 3, row.v0 + 8, row.v0 + SD - 8), kind: "stall" });
		}
		for (let k = 0; k < n; k++) {
			const su = us + k * SW;
			if (front && math.abs(su + SW / 2 - mid) < 150) continue;
			if (!g.rng.chance(0.4)) continue;
			const r = edgeRect(e, su + 6, su + 6 + TOWN.CAR_W, row.v0 + 12, row.v0 + 12 + TOWN.CAR_L);
			if (!g.placer.canPlace(r.x, r.y, r.w, r.h, 4)) continue;
			const nose = g.rng.chance(0.3) ? row.nose + math.pi : row.nose;
			addCar(g.w, r.x, r.y, r.w, r.h, math.atan2(math.sin(nose), math.cos(nose)));
		}
	}
	cutsOf(g, e).push({ a: mid - 120, b: mid + 120, kind: "drive" });
	lot.ground.push({ ...edgeRect(e, mid - 120, mid + 120, 0, p.v0), kind: "drive" });
	g.placer.reserve(edgeRect(e, mid - 128, mid + 128, 0, p.v0));
	noParking(g, e, mid - 150, mid + 150);
	g.placer.reserve(edgeRect(e, p.u0, p.u1, p.v0, p.v1));
	return true;
}

/**
 * Gas station on the corner where edge `e1` (forecourt + door) meets the cross street at its
 * `a` end (atA) or `b` end: shop at the back, pump islands on an open forecourt facing e1.
 */
function placeGas(g: Gen, lot: Lot, e1: LotEdge, e2: LotEdge, atA: boolean): boolean {
	const b = GAS_DEF;
	const along = b.w;
	const depth = b.h;
	const span = yardSpan(lot, e1);
	const u0 = atA ? span.a + 32 : span.b - 32 - along;
	const front = TOWN.SIDEWALK + TOWN.FORECOURT;
	if (front - TOWN.SIDEWALK + depth > yardDepth(lot, e1) - TOWN.SIDE_YARD) return false;
	const r = edgeRect(e1, u0, u0 + along, front, front + depth);
	if (!g.placer.canPlace(r.x, r.y, r.w, r.h, TOWN.BUILDING_GAP)) return false;
	const apU0 = atA ? span.a : u0 - 96;
	const apU1 = atA ? u0 + along + 96 : span.b;
	const apron = edgeRect(e1, apU0, apU1, TOWN.SIDEWALK, front);
	if (!g.placer.canPlace(apron.x, apron.y, apron.w, apron.h, 0)) return false;
	const doorU = atA ? u0 + along - 130 : u0 + 130;
	addBuilding(g, lot, b, r, e1, doorU, front);
	// two pump islands parallel to the street, clear of the door approach
	const vMid = TOWN.SIDEWALK + TOWN.FORECOURT / 2;
	for (const off of [70, 300]) {
		const a = atA ? span.a + off : span.b - off - 150;
		const p = edgeRect(e1, a, a + 150, vMid - 20, vMid + 20);
		addSolid(g.w, {
			kind: isAlongX(e1.side) ? "wall_h" : "wall_v",
			x: p.x,
			y: p.y,
			w: p.w,
			h: p.h,
			hp: 999999,
			hpMax: 999999,
			destructible: false,
			tags: "pump",
		});
	}
	lot.ground.push({ ...apron, kind: "apron" });
	g.placer.reserve(apron);
	// wide curb cuts on both streets
	cutsOf(g, e1).push({ a: apU0, b: apU1, kind: "drive" });
	lot.ground.push({ ...edgeRect(e1, apU0, apU1, 0, TOWN.SIDEWALK), kind: "drive" });
	g.placer.reserve(edgeRect(e1, apU0, apU1, 0, TOWN.SIDEWALK));
	noParking(g, e1, apU0 - 60, apU1 + 60);
	const c0 = e1.curb + e1.inward * TOWN.SIDEWALK;
	const c1 = e1.curb + e1.inward * front;
	const a2 = math.min(c0, c1);
	const b2 = math.max(c0, c1);
	cutsOf(g, e2).push({ a: a2, b: b2, kind: "drive" });
	lot.ground.push({ ...edgeRect(e2, a2, b2, 0, TOWN.SIDEWALK), kind: "drive" });
	g.placer.reserve(edgeRect(e2, a2, b2, 0, TOWN.SIDEWALK));
	noParking(g, e2, a2 - 60, b2 + 60);
	return true;
}

/** School / hospital on its own lot, with a school yard or a parking lot beside it. */
function placeCivic(g: Gen, lot: Lot, def: BuildingDef, edges: Array<LotEdge>): boolean {
	for (const e of edges) {
		const span = yardSpan(lot, e);
		const len = span.b - span.a;
		if (def.w > len - TOWN.SIDE_YARD * 2) continue;
		// off-centre towards one corner, leaving the widest free strip on the other side
		const u = snap8(g.rng.chance(0.5) ? span.a + TOWN.SIDE_YARD : span.b - TOWN.SIDE_YARD - def.w);
		if (tryFront(g, lot, e, def, u, TOWN.SETBACK + 16, true, 0) === undefined) continue;
		// hospital: a parking lot if one fits; otherwise (and for schools) a paved yard
		const grid = yardGrid(g, lot);
		const park = def === HOSPITAL_DEF ? bestFrontRect(lot, grid, 360, 424) : undefined;
		if (park !== undefined && addParking(g, lot, park.e, park.r)) return true;
		const best = bestFrontRect(lot, grid, 288, 224);
		if (best !== undefined) {
			const f = best.r;
			const r = { u0: f.u0, u1: f.u1, v0: f.v0, v1: math.min(f.v1, f.v0 + 576) };
			// school yard, or the hospital's ambulance bay
			const kind: GroundKind = def === HOSPITAL_DEF ? "apron" : "playground";
			lot.ground.push({ ...edgeRect(best.e, r.u0 + 16, r.u1 - 16, r.v0 + 16, r.v1 - 16), kind });
			g.placer.reserve(edgeRect(best.e, r.u0, r.u1, r.v0, r.v1));
			const mid = (r.u0 + r.u1) / 2;
			cutsOf(g, best.e).push({ a: mid - 52, b: mid + 52, kind: "walk" });
		}
		return true;
	}
	return false;
}

function addTree(w: WorldData, cx: number, cy: number): void {
	const t = TOWN.TREE_TRUNK;
	const h = hash01(cx, cy, 5);
	addSolid(w, {
		kind: "tree",
		x: cx - t / 2,
		y: cy - t / 2,
		w: t,
		h: t,
		hp: 100,
		hpMax: 100,
		destructible: true,
		tags: "tree",
		canopyR: TOWN.CANOPY_R_MIN + math.floor(h * (TOWN.CANOPY_R_MAX - TOWN.CANOPY_R_MIN + 1)),
		canopyAlpha: 1,
		tint: COLORS.treeLeaf.Lerp(COLORS.treeLeafLight, hash01(cx, cy, 9) * 0.6),
	});
}

/** tree trunk centred at (cx, cy) with `pad` of walkable space around it */
function tryTree(g: Gen, cx: number, cy: number, pad: number, allowRoad = false): boolean {
	const t = TOWN.TREE_TRUNK;
	if (!g.placer.canPlace(cx - t / 2, cy - t / 2, t, t, pad, allowRoad)) return false;
	addTree(g.w, cx, cy);
	return true;
}

/** usable [u0,u1] of an edge's service strip: one car length (+ the trunk) clear of each street corner */
function stripRange(e: LotEdge, clear: number): { a: number; b: number } {
	return { a: e.cornerA ? e.a + clear : e.a + 64, b: e.cornerB ? e.b - clear : e.b - 64 };
}

/** Bins at the curb beside some entrances (service strip, never in front of the door). */
function binsAtEntrances(g: Gen, lot: Lot): void {
	const list = g.placed.get(lot);
	if (list === undefined) return;
	for (const p of list) {
		const t = p.def.type;
		const prob = t === 1 || t === 2 ? 0.35 : t === 3 || t === 4 ? 0.8 : 0.6;
		if (!g.rng.chance(prob)) continue;
		const e = p.edge;
		const range = stripRange(e, TOWN.CORNER_CLEAR);
		const s = TOWN.TRASH;
		const dir = g.rng.chance(0.5) ? 1 : -1;
		for (const sgn of [dir, -dir]) {
			const u = p.doorU + sgn * g.rng.range(112, 150);
			if (u - s / 2 < range.a || u + s / 2 > range.b) continue;
			if (inCut(g, e, u - s / 2, u + s / 2, 8)) continue;
			const r = edgeRect(e, u - s / 2, u + s / 2, TOWN.VERGE / 2 - s / 2, TOWN.VERGE / 2 + s / 2);
			if (!g.placer.canPlace(r.x, r.y, r.w, r.h, 8)) continue;
			addTrash(g.w, r.x, r.y);
			break;
		}
	}
}

/** Dumpster-style bins behind shops (back of the lot, against the rear wall). */
function binsBehindShops(g: Gen, lot: Lot): void {
	const list = g.placed.get(lot);
	if (list === undefined) return;
	for (const p of list) {
		const t = p.def.type;
		if (t === 1 || t === 2 || !g.rng.chance(0.45)) continue;
		const b = p.solid;
		const s = TOWN.TRASH;
		for (let k = 0; k < 4; k++) {
			const f = g.rng.range(0.15, 0.85);
			let x: number;
			let y: number;
			if (b.doorSide === "top") {
				x = b.x + f * (b.w - s);
				y = b.y + b.h + 8;
			} else if (b.doorSide === "bottom") {
				x = b.x + f * (b.w - s);
				y = b.y - s - 8;
			} else if (b.doorSide === "left") {
				x = b.x + b.w + 8;
				y = b.y + f * (b.h - s);
			} else {
				x = b.x - s - 8;
				y = b.y + f * (b.h - s);
			}
			if (!g.placer.canPlace(x, y, s, s, 6)) continue;
			// the rear yard must stay passable: 60 u free around the bin on its three open sides
			const m = 60;
			let ok: boolean;
			if (b.doorSide === "top") ok = g.placer.canPlace(x - m, y, s + m * 2, s + m, 0);
			else if (b.doorSide === "bottom") ok = g.placer.canPlace(x - m, y - m, s + m * 2, s + m, 0);
			else if (b.doorSide === "left") ok = g.placer.canPlace(x, y - m, s + m, s + m * 2, 0);
			else ok = g.placer.canPlace(x - m, y - m, s + m, s + m * 2, 0);
			if (!ok) continue;
			addTrash(g.w, x, y);
			break;
		}
	}
}

/** Street trees on a lattice per street (both sides line up), in the service strip only. */
function streetTrees(g: Gen, lot: Lot): void {
	for (const e of lot.edges) {
		const road = g.w.roads[e.road];
		const pits = lot.zone === "commercial";
		if (!road.treeLined && !pits) continue;
		const pitch = g.pitch[e.road];
		const phase = g.phase[e.road];
		const half = TOWN.TREE_TRUNK / 2;
		const range = stripRange(e, TOWN.CORNER_CLEAR + half + 8);
		let k = math.ceil((range.a - phase) / pitch);
		while (phase + k * pitch <= range.b) {
			const u = phase + k * pitch;
			k++;
			if (inCut(g, e, u - half, u + half, 24)) continue;
			const c = edgeRect(e, u, u, TOWN.VERGE / 2, TOWN.VERGE / 2);
			const t = TOWN.TREE_TRUNK;
			if (!g.placer.canPlace(c.x - t / 2, c.y - t / 2, t, t, 24)) continue;
			if (pits) {
				lot.ground.push({ ...edgeRect(e, u - 32, u + 32, 2, TOWN.VERGE - 2), kind: "pit" });
			}
			if (g.rng.chance(pits ? 0.55 : 0.85)) addTree(g.w, c.x, c.y);
		}
	}
}

/** Trees in yards, parks, plazas and vacant corners: most of the town's trees. */
function yardTrees(g: Gen, lot: Lot, n: number, pad: number): void {
	const yard = lot.yard;
	let placedTrees = 0;
	for (let attempt = 0; attempt < n * 6 && placedTrees < n; attempt++) {
		const cx = snap8(yard.x + 56 + g.rng.next() * math.max(1, yard.w - 112));
		const cy = snap8(yard.y + 56 + g.rng.next() * math.max(1, yard.h - 112));
		if (tryTree(g, cx, cy, pad)) {
			placedTrees++;
			// downtown yards are paved: the tree grows in a planter
			if (lot.zone === "commercial") lot.ground.push({ x: cx - 36, y: cy - 36, w: 72, h: 72, kind: "pit" });
		}
	}
}

/** Grass verges (residential) along each edge, interrupted at corners and cuts; ramps at crossings. */
function sidewalkGround(g: Gen, lot: Lot): void {
	const SW = TOWN.SIDEWALK;
	for (const e of lot.edges) {
		// tactile ramps where the crosswalks land (both ends of a street corner)
		if (e.cornerA) lot.ground.push({ ...edgeRect(e, e.a + 8, e.a + SW - 8, 0, 16), kind: "ramp" });
		if (e.cornerB) lot.ground.push({ ...edgeRect(e, e.b - SW + 8, e.b - 8, 0, 16), kind: "ramp" });
		if (lot.zone === "commercial") continue;
		const range = stripRange(e, SW + 32);
		const cuts = [...cutsOf(g, e)];
		cuts.sort((p, q) => p.a < q.a || (p.a === q.a && p.b < q.b));
		let a = range.a;
		for (const c of cuts) {
			if (c.b <= a) continue;
			if (c.a >= range.b) break;
			if (c.a - 8 > a + 32) lot.ground.push({ ...edgeRect(e, a, c.a - 8, 0, TOWN.VERGE), kind: "verge" });
			a = math.max(a, c.b + 8);
		}
		if (range.b > a + 32) lot.ground.push({ ...edgeRect(e, a, range.b, 0, TOWN.VERGE), kind: "verge" });
		// walk cuts through the verge are paved
		for (const c of cuts) {
			if (c.kind === "walk" && c.b > range.a && c.a < range.b) {
				lot.ground.push({ ...edgeRect(e, c.a + 16, c.b - 16, 0, TOWN.VERGE), kind: "walk" });
			}
		}
	}
}

function overlapsGround(lot: Lot, r: Rect): boolean {
	for (const q of lot.ground) {
		if (rectOverlap(r.x, r.y, r.w, r.h, q.x, q.y, q.w, q.h)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// cars

/** occupied spans across a road (from its low side) of every car overlapping [t0,t1] along it */
function laneSpans(w: WorldData, road: Road, t0: number, t1: number, lo: number, hi: number): Array<Array<number>> {
	const v = road.vertical;
	const spans: Array<Array<number>> = [];
	const q = v ? querySolids(w, road.x, t0, road.x + road.w, t1) : querySolids(w, t0, road.y, t1, road.y + road.h);
	for (const s of q) {
		if (s.tags !== "car") continue;
		const a = v ? s.x : s.y;
		const b = v ? s.x + s.w : s.y + s.h;
		if (b > lo && a < hi) spans.push([math.max(a, lo), math.min(b, hi)]);
	}
	return spans;
}

/** widest contiguous free width of [lo,hi] across a road given occupied spans */
function freeWidth(spans: Array<Array<number>>, lo: number, hi: number): number {
	spans.sort((p, q) => p[0] < q[0]);
	let best = 0;
	let at = lo;
	for (const s of spans) {
		if (s[0] > at) best = math.max(best, s[0] - at);
		at = math.max(at, s[1]);
	}
	return math.max(best, hi - at);
}

function lotAt(w: WorldData, x: number, y: number): Lot | undefined {
	for (const l of w.lots) {
		if (x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) return l;
	}
	return undefined;
}

/** Parallel parking (right-hand traffic) and a few abandoned cars per street segment. */
function parkCars(g: Gen): void {
	const w = g.w;
	const L = TOWN.CAR_L;
	const W = TOWN.CAR_W;
	for (const road of w.roads) {
		const v = road.vertical;
		const cuts: Array<Rect> = [];
		for (const j of w.junctions) {
			if (v ? j.x === road.x : j.y === road.y) cuts.push(j);
		}
		cuts.sort((p, q) => (v ? p.y < q.y : p.x < q.x));
		const segs: Array<{ a: number; b: number; ja: boolean; jb: boolean }> = [];
		let a = v ? road.y : road.x;
		let ja = false;
		for (const c of cuts) {
			segs.push({ a, b: v ? c.y : c.x, ja, jb: true });
			a = v ? c.y + c.h : c.x + c.w;
			ja = true;
		}
		segs.push({ a, b: v ? road.y + road.h : road.x + road.w, ja, jb: false });
		const clear = TOWN.CORNER_CLEAR + 40;
		for (const seg of segs) {
			const lo = seg.a + (seg.ja ? clear : 120);
			const hi = seg.b - (seg.jb ? clear : 120);
			if (hi - lo < L) continue;
			// both curbs: west/north (low side) and east/south (high side)
			for (const high of [false, true]) {
				// right-hand traffic: vertical road → east curb faces north, west curb faces south;
				// horizontal road → south curb faces east, north curb faces west
				const heading = v ? (high ? -math.pi / 2 : math.pi / 2) : high ? 0 : math.pi;
				const across = v
					? high
						? road.x + road.w - TOWN.CURB_GAP - W
						: road.x + TOWN.CURB_GAP
					: high
						? road.y + road.h - TOWN.CURB_GAP - W
						: road.y + TOWN.CURB_GAP;
				const probe = v
					? lotAt(w, high ? road.x + road.w + 64 : road.x - 64, (lo + hi) / 2)
					: lotAt(w, (lo + hi) / 2, high ? road.y + road.h + 64 : road.y - 64);
				const p =
					probe === undefined || probe.kind !== "block"
						? 0.1
						: probe.zone === "commercial"
							? 0.3
							: probe.zone === "civic"
								? 0.22
								: 0.14;
				for (let t = lo; t + L <= hi; t += TOWN.PARK_SLOT) {
					if (!g.rng.chance(p)) continue;
					const at = math.floor(t + g.rng.range(0, 16));
					const x = v ? across : at;
					const y = v ? at : across;
					const cw = v ? W : L;
					const ch = v ? L : W;
					if (g.placer.canPlace(x, y, cw, ch, 8, true)) addCar(w, x, y, cw, ch, heading);
				}
			}
			// abandoned: askew in a travel lane, only if a lane stays free beside it
			if (hi - lo > L + 400 && g.rng.chance(0.09)) {
				const size = v ? road.w : road.h;
				const carriage = road.avenue ? (size - TOWN.MEDIAN_W) / 2 : size;
				const high = g.rng.chance(0.5);
				const base = v ? road.x : road.y;
				const c0 = high ? base + size - carriage : base;
				const c1 = c0 + carriage;
				// in the curb lane but clearly off the parking line (it stopped, it did not park)
				const center = high ? c1 - carriage / 4 - g.rng.range(4, 28) : c0 + carriage / 4 + g.rng.range(4, 28);
				const travel = v ? (high ? -math.pi / 2 : math.pi / 2) : high ? 0 : math.pi;
				const skew = g.rng.range(0.1, 0.24) * (g.rng.chance(0.5) ? 1 : -1);
				const heading = travel + skew + (g.rng.chance(0.2) ? math.pi : 0);
				// collision: halfway between the car's own rect and its rotated bounding box
				const cs = math.abs(math.cos(skew));
				const sn = math.abs(math.sin(skew));
				const hl = L / 2 + ((L / 2) * cs + (W / 2) * sn - L / 2) / 2;
				const hw = W / 2 + ((L / 2) * sn + (W / 2) * cs - W / 2) / 2;
				const t = g.rng.range(lo + 200, hi - 200 - L);
				const cx = v ? center : t + L / 2;
				const cy = v ? t + L / 2 : center;
				const x = math.floor(cx - (v ? hw : hl));
				const y = math.floor(cy - (v ? hl : hw));
				const cw = math.floor((v ? hw : hl) * 2);
				const ch = math.floor((v ? hl : hw) * 2);
				const span0 = v ? x : y;
				const span1 = v ? x + cw : y + ch;
				if (span0 > c0 + 4 && span1 < c1 - 4 && g.placer.canPlace(x, y, cw, ch, 24, true)) {
					const spans = laneSpans(w, road, t - 24, t + L + 24, c0, c1);
					spans.push([span0, span1]);
					if (freeWidth(spans, c0, c1) >= TOWN.LANE_FREE) addCar(w, x, y, cw, ch, heading);
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// interiors

/**
 * The inside of every building (shared/game/interiors.ts, docs/DESIGN_RULES.md EDI-08..EDI-15), planned once the
 * whole town stands: walls with their doorways and windows, the rooms, the furniture, the loot spots, and the
 * notches that make the footprint an L, a T or a U (a house's porch, a patio, a loading bay).
 *
 * Why at the very end: a building's box already kept everything else out while the town was laid (its record is a
 * solid for every placement query), so planning now changes nothing around it -- the town is the one it always
 * was -- and a secondary door (back door, service door, emergency exit) can be kept only where the ground outside it
 * is REALLY free: no tree, bin, pump, parked car or other building in the way, now that all of them are placed.
 * Nothing here draws from the town's `rng`: each building has its own seed (`buildingSeed`), integers only.
 */
function planInteriors(g: Gen): void {
	const w = g.w;
	const scratch: Array<Solid> = [];
	for (const lot of w.lots) {
		const list = g.placed.get(lot);
		if (list === undefined) continue;
		for (const p of list) {
			const rec = p.solid;
			const plan = planBuilding({
				type: p.def.type,
				rect: { x: rec.x, y: rec.y, w: rec.w, h: rec.h },
				side: p.edge.side,
				doorU: p.doorU,
				seed: buildingSeed(rec.x, rec.y, p.def.type, g.townSeed),
				canOpen: a => {
					const B = TOWN.BORDER;
					if (a.x < B || a.y < B || a.x + a.w > w.width - B || a.y + a.h > w.height - B) return false;
					scratch.clear();
					for (const s of querySolids(w, a.x, a.y, a.x + a.w, a.y + a.h, scratch)) {
						if (s !== rec) return false;
					}
					for (const road of w.roads) {
						if (rectOverlap(a.x, a.y, a.w, a.h, road.x, road.y, road.w, road.h)) return false;
					}
					return true;
				},
			});
			rec.doorX = plan.doorX;
			rec.doorY = plan.doorY;
			rec.parts = plan.parts;
			rec.mainWing = plan.mainWing;
			rec.rooms = plan.rooms;
			rec.openings = plan.openings;
			rec.decor = plan.decor;
			rec.lootSpots = plan.loot;
			const id = rec.id;
			for (const q of plan.walls) {
				addPart(w, q.w >= q.h ? "wall_h" : "wall_v", q, id, "bwall", q.inner ? { inner: true } : undefined);
			}
			for (const o of plan.openings) {
				if (o.kind === "window") addPart(w, "window", o, id, "window", { passable: true });
			}
			for (const f of plan.furniture) {
				addPart(w, "furniture", f, id, f.kind, { low: f.low, face: f.face, variant: f.variant });
			}
			// the notches of the footprint: a house's porch in front, a patio / loading bay / courtyard elsewhere
			const house = p.def.type === 1 || p.def.type === 2;
			for (const y of plan.yards) {
				lot.ground.push({ ...y, kind: house && y.front ? "porch" : "patio" });
				// the grass tufts were laid before the notch existed: none on a porch or a patio
				for (let i = lot.patches.size() - 1; i >= 0; i--) {
					const q = lot.patches[i];
					if (rectOverlap(q.x, q.y, q.w, q.h, y.x, y.y, y.w, y.h)) lot.patches.remove(i);
				}
			}
			// between two buildings, and only there: nothing is half-planned while the caller yields
			if (g.pace !== undefined) g.pace();
		}
	}
}

// ---------------------------------------------------------------------------

/**
 * Procedural town: avenues and streets, sidewalks, zoned lots with enterable buildings, trees, cars, bins.
 *
 * A pure function of `seed` (0: a random one). `pace`, when given, is called between two buildings' interiors -- the
 * bulk of the work -- so a server rebuilding the world can yield there (server/net/mpHost.ts, at a world reset); it
 * cannot change the town, and nothing is half-built when it runs.
 */
export function generateTown(seed = 0, pace?: () => void): WorldData {
	const w = createWorld(DESIGN.WORLD_W, DESIGN.WORLD_H);
	const townSeed = seed !== 0 ? seed : rndInt(1, 2147483646);
	const rng = new TownRng(townSeed);
	const placer = new Placer(w);
	const g: Gen = {
		w,
		rng,
		placer,
		cuts: new Map(),
		placed: new Map(),
		pitch: [],
		phase: [],
		shopDeck: [],
		townSeed,
		pace,
	};
	const SW = TOWN.SIDEWALK;
	for (const a of w.bossAnchors) {
		placer.bossClear.push({ x: a.x, y: a.y, r: TOWN.BOSS_CLEAR });
	}

	// --- roads (inside the border): one avenue each way, streets elsewhere ---
	const xs = layoutRoads(w.width, rng);
	const ys = layoutRoads(w.height, rng);
	const roadOfX: Array<number> = [];
	const roadOfY: Array<number> = [];
	for (const s of xs) {
		roadOfX.push(w.roads.size());
		w.roads.push({
			x: s.start,
			y: TOWN.BORDER,
			w: s.size,
			h: w.height - TOWN.BORDER * 2,
			vertical: true,
			avenue: s.avenue,
			treeLined: s.avenue || rng.chance(TREE_LINED_SHARE),
			medians: [],
		});
	}
	for (const s of ys) {
		roadOfY.push(w.roads.size());
		w.roads.push({
			x: TOWN.BORDER,
			y: s.start,
			w: w.width - TOWN.BORDER * 2,
			h: s.size,
			vertical: false,
			avenue: s.avenue,
			treeLined: s.avenue || rng.chance(TREE_LINED_SHARE),
			medians: [],
		});
	}
	for (let i = 0; i < w.roads.size(); i++) {
		const p = snap8(rng.range(TOWN.TREE_PITCH_MIN, TOWN.TREE_PITCH_MAX));
		g.pitch.push(p);
		g.phase.push(math.floor(rng.range(0, p)));
	}
	for (const vx of xs) {
		for (const hy of ys) {
			w.junctions.push({ x: vx.start, y: hy.start, w: vx.size, h: hy.size });
		}
	}
	// zebra crossings on every arm, in line with the sidewalks they connect
	for (const j of w.junctions) {
		const d = SW - 16;
		w.crossings.push({ x: j.x, y: j.y - SW + 8, w: j.w, h: d, vertical: true });
		w.crossings.push({ x: j.x, y: j.y + j.h + 8, w: j.w, h: d, vertical: true });
		w.crossings.push({ x: j.x - SW + 8, y: j.y, w: d, h: j.h, vertical: false });
		w.crossings.push({ x: j.x + j.w + 8, y: j.y, w: d, h: j.h, vertical: false });
	}
	// avenue medians, interrupted at every crossing (plus the crosswalk and a nose)
	for (const road of w.roads) {
		if (!road.avenue) continue;
		const v = road.vertical;
		const cross = v ? ys : xs;
		const off = ((v ? road.w : road.h) - TOWN.MEDIAN_W) / 2;
		let a = v ? road.y : road.x;
		const segEnd = v ? road.y + road.h : road.x + road.w;
		const ends: Array<{ a: number; b: number }> = [];
		for (const c of cross) {
			ends.push({ a, b: c.start - SW - 16 });
			a = c.start + c.size + SW + 16;
		}
		ends.push({ a, b: segEnd });
		for (const s of ends) {
			if (s.b - s.a < 200) continue;
			road.medians.push(
				v
					? { x: road.x + off, y: s.a, w: TOWN.MEDIAN_W, h: s.b - s.a }
					: { x: s.a, y: road.y + off, w: s.b - s.a, h: TOWN.MEDIAN_W },
			);
		}
	}

	// --- lots (blocks between roads), their sidewalk edges and zoning ---
	const spansX = lotSpans(w.width, xs);
	const spansY = lotSpans(w.height, ys);
	let avX = -1;
	let avY = -1;
	for (let i = 0; i < xs.size(); i++) if (xs[i].avenue) avX = i;
	for (let i = 0; i < ys.size(); i++) if (ys[i].avenue) avY = i;
	const lotGrid: Array<Array<Lot>> = [];
	const lotCol = new Map<Lot, number>();
	const lotRow = new Map<Lot, number>();
	for (let ci = 0; ci < spansX.size(); ci++) {
		const column: Array<Lot> = [];
		for (let ri = 0; ri < spansY.size(); ri++) {
			const sx = spansX[ci];
			const sy = spansY[ri];
			const lx = sx.a;
			const ly = sy.a;
			const lw = sx.b - sx.a;
			const lh = sy.b - sy.a;
			const yx = lx + (sx.lo >= 0 ? SW : 0);
			const yy = ly + (sy.lo >= 0 ? SW : 0);
			const yard = {
				x: yx,
				y: yy,
				w: lx + lw - (sx.hi >= 0 ? SW : 0) - yx,
				h: ly + lh - (sy.hi >= 0 ? SW : 0) - yy,
			};
			const edges: Array<LotEdge> = [];
			const cA = sx.lo >= 0;
			const cB = sx.hi >= 0;
			const rA = sy.lo >= 0;
			const rB = sy.hi >= 0;
			if (sy.lo >= 0) {
				edges.push({
					side: "top",
					curb: ly,
					inward: 1,
					a: lx,
					b: lx + lw,
					cornerA: cA,
					cornerB: cB,
					road: roadOfY[sy.lo],
				});
			}
			if (sy.hi >= 0) {
				edges.push({
					side: "bottom",
					curb: ly + lh,
					inward: -1,
					a: lx,
					b: lx + lw,
					cornerA: cA,
					cornerB: cB,
					road: roadOfY[sy.hi],
				});
			}
			if (sx.lo >= 0) {
				edges.push({
					side: "left",
					curb: lx,
					inward: 1,
					a: ly,
					b: ly + lh,
					cornerA: rA,
					cornerB: rB,
					road: roadOfX[sx.lo],
				});
			}
			if (sx.hi >= 0) {
				edges.push({
					side: "right",
					curb: lx + lw,
					inward: -1,
					a: ly,
					b: ly + lh,
					cornerA: rA,
					cornerB: rB,
					road: roadOfX[sx.hi],
				});
			}
			const nearAvX = ci === avX || ci === avX + 1;
			const nearAvY = ri === avY || ri === avY + 1;
			const downtown =
				(nearAvX && ri >= avY - DOWNTOWN_REACH && ri <= avY + 1 + DOWNTOWN_REACH) ||
				(nearAvY && ci >= avX - DOWNTOWN_REACH && ci <= avX + 1 + DOWNTOWN_REACH);
			const lot: Lot = {
				x: lx,
				y: ly,
				w: lw,
				h: lh,
				kind: "block",
				zone: downtown ? "commercial" : "residential",
				yard,
				patches: [],
				paths: [],
				edges,
				ground: [],
			};
			column.push(lot);
			lotCol.set(lot, ci);
			lotRow.set(lot, ri);
			w.lots.push(lot);
		}
		lotGrid.push(column);
	}
	const onAvenue = (l: Lot) => {
		const ci = lotCol.get(l) ?? -9;
		const ri = lotRow.get(l) ?? -9;
		return ci === avX || ci === avX + 1 || ri === avY || ri === avY + 1;
	};
	const cheb = (p: Lot, q: Lot) =>
		math.max(
			math.abs((lotCol.get(p) ?? 0) - (lotCol.get(q) ?? 0)),
			math.abs((lotRow.get(p) ?? 0) - (lotRow.get(q) ?? 0)),
		);

	// boss plazas: the lot holding each anchor (or the nearest lot when the anchor is on a road)
	for (const a of w.bossAnchors) {
		let best: Lot | undefined;
		let bestD = math.huge;
		for (const l of w.lots) {
			const nx = math.clamp(a.x, l.yard.x, l.yard.x + l.yard.w);
			const ny = math.clamp(a.y, l.yard.y, l.yard.y + l.yard.h);
			const d = (nx - a.x) * (nx - a.x) + (ny - a.y) * (ny - a.y);
			if (d < bestD) {
				bestD = d;
				best = l;
			}
		}
		if (best !== undefined) {
			best.kind = "plaza";
			best.zone = "residential";
		}
	}
	// pick lots for parks, schools, hospitals, gas stations (spread out, seeded)
	const pickLots = (count: number, ok: (l: Lot) => boolean, spacing: number, taken: Array<Lot>): Array<Lot> => {
		const out: Array<Lot> = [];
		const pool = shuffle(rng, w.lots.filter(ok));
		for (const l of pool) {
			if (out.size() >= count) break;
			let far = true;
			for (const o of taken) if (cheb(l, o) < spacing) far = false;
			for (const o of out) if (cheb(l, o) < spacing) far = false;
			if (far) out.push(l);
		}
		return out;
	};
	const special: Array<Lot> = w.lots.filter(l => l.kind === "plaza");
	const residentialFree = (l: Lot) => l.kind === "block" && l.zone === "residential" && l.edges.size() >= 2;
	const parks = pickLots(PARKS, l => residentialFree(l) && !onAvenue(l), 2, special);
	for (const l of parks) {
		l.kind = "park";
		special.push(l);
	}
	// schools in the neighbourhoods, hospitals on the avenues; spread out among their own kind
	const schools = pickLots(SCHOOLS, l => residentialFree(l) && !onAvenue(l), 3, []);
	for (const l of schools) l.zone = "civic";
	const hospitals = pickLots(HOSPITALS, l => residentialFree(l) && onAvenue(l), 3, []);
	for (const l of hospitals) l.zone = "civic";
	const gasLots = pickLots(GAS_STATIONS, l => l.kind === "block" && l.zone !== "civic" && onAvenue(l), 2, []);

	// --- parks: dirt paths (kept free of trees) ---
	for (const lot of w.lots) {
		if (lot.kind !== "park") continue;
		const yard = lot.yard;
		const pathW = 88;
		const px = snap8(yard.x + yard.w / 2 + rng.range(-120, 120) - pathW / 2);
		const py = snap8(yard.y + yard.h / 2 + rng.range(-120, 120) - pathW / 2);
		lot.paths.push({ x: px, y: yard.y, w: pathW, h: yard.h });
		lot.paths.push({ x: yard.x, y: py, w: yard.w, h: pathW });
		for (const p of lot.paths) {
			placer.reserve({ x: p.x - 20, y: p.y - 20, w: p.w + 40, h: p.h + 40 });
		}
		// the paths start at the sidewalk: keep the service strip open there
		for (const e of lot.edges) {
			const c = isAlongX(e.side) ? px + pathW / 2 : py + pathW / 2;
			cutsOf(g, e).push({ a: c - pathW / 2, b: c + pathW / 2, kind: "walk" });
		}
	}

	// --- buildings, by lot program ---
	const houseOpts: PackOpts = {
		setMin: TOWN.SETBACK_HOUSE_MIN,
		setMax: TOWN.SETBACK_HOUSE_MAX,
		gapMin: TOWN.BUILDING_GAP,
		gapMax: TOWN.BUILDING_GAP + 96,
		max: 3,
		longAlong: false,
		doorJitter: 0.6,
	};
	const shopOpts: PackOpts = {
		setMin: 0,
		setMax: TOWN.SETBACK_SHOP_MAX,
		gapMin: TOWN.BUILDING_GAP,
		gapMax: TOWN.BUILDING_GAP + 48,
		max: 2,
		longAlong: true,
		doorJitter: 0,
	};
	for (const lot of w.lots) {
		if (lot.kind !== "block") continue;
		// avenue-facing edges first (that is where the shops and the forecourt go); a stable
		// partition, not a sort: Luau's table.sort is unstable and would change the town
		const shuffled = shuffle(rng, [...lot.edges]);
		const edges: Array<LotEdge> = [];
		for (const e of shuffled) if (w.roads[e.road].avenue) edges.push(e);
		for (const e of shuffled) if (!w.roads[e.road].avenue) edges.push(e);
		if (lot.zone === "civic") {
			const def = hospitals.includes(lot) ? HOSPITAL_DEF : SCHOOL_DEF;
			if (!placeCivic(g, lot, def, edges)) lot.zone = "residential";
		}
		if (gasLots.includes(lot)) {
			let done = false;
			for (const e1 of edges) {
				if (done) break;
				if (!w.roads[e1.road].avenue) continue;
				for (const e2 of lot.edges) {
					if (done || isAlongX(e2.side) === isAlongX(e1.side)) continue;
					// e2 meets e1 at e1's a end when it is the low (top/left) side
					const atA = e2.side === "top" || e2.side === "left";
					if ((atA && !e1.cornerA) || (!atA && !e1.cornerB)) continue;
					done = placeGas(g, lot, e1, e2, atA);
				}
			}
		}
		if (lot.zone === "commercial") {
			for (const e of edges) {
				packFace(
					g,
					lot,
					e,
					() => shopCandidates(g, 4),
					b => takeShop(g, b),
					shopOpts,
				);
			}
			// a parking lot in the back if there is room
			const park = bestFrontRect(lot, yardGrid(g, lot), 360, 424);
			if (park !== undefined) addParking(g, lot, park.e, park.r);
		} else if (lot.zone === "residential") {
			for (const e of edges) {
				// the avenue side of a residential lot may open a corner shop
				if (w.roads[e.road].avenue && rng.chance(0.4)) {
					const kinds = shuffle(rng, [...CORNER_SHOPS]);
					packFace(
						g,
						lot,
						e,
						() => kinds.map(t => SHOP_DEFS[t]),
						() => {},
						{ ...shopOpts, max: 1 },
					);
				}
				packFace(
					g,
					lot,
					e,
					() => houseCandidates(g),
					() => {},
					houseOpts,
				);
			}
		}
		binsAtEntrances(g, lot);
		if (lot.zone === "commercial") binsBehindShops(g, lot);
	}

	// --- trees: street trees in the service strip, the rest in yards, parks and plazas ---
	for (const lot of w.lots) {
		streetTrees(g, lot);
	}
	for (const road of w.roads) {
		if (!road.avenue) continue;
		const idx = w.roads.indexOf(road);
		const pitch = g.pitch[idx];
		const phase = g.phase[idx];
		for (const m of road.medians) {
			const a0 = road.vertical ? m.y : m.x;
			const a1 = road.vertical ? m.y + m.h : m.x + m.w;
			const lo = a0 + (a0 > (road.vertical ? road.y : road.x) ? 96 : 64);
			const hi = a1 - (a1 < (road.vertical ? road.y + road.h : road.x + road.w) ? 96 : 64);
			let k = math.ceil((lo - phase) / pitch);
			while (phase + k * pitch <= hi) {
				const u = phase + k * pitch;
				k++;
				const cx = road.vertical ? m.x + m.w / 2 : u;
				const cy = road.vertical ? u : m.y + m.h / 2;
				if (rng.chance(0.9)) tryTree(g, cx, cy, 16, true);
			}
		}
	}
	for (const lot of w.lots) {
		if (lot.kind === "park") yardTrees(g, lot, rng.int(20, 30), 56);
		else if (lot.kind === "plaza") yardTrees(g, lot, rng.int(10, 16), 56);
		else if (lot.zone === "commercial") yardTrees(g, lot, rng.int(0, 2), 72);
		else if (lot.zone === "civic") yardTrees(g, lot, rng.int(2, 5), 64);
		else yardTrees(g, lot, rng.int(4, 8), 64);
	}

	// --- ground: verges, ramps; grass tufts where nothing else is drawn ---
	for (const lot of w.lots) {
		sidewalkGround(g, lot);
		if (lot.zone === "commercial") continue;
		const yard = lot.yard;
		const nPatch = rng.int(4, 8);
		for (let i = 0; i < nPatch; i++) {
			const pw = rng.range(80, 220);
			const ph = rng.range(60, 180);
			const p = {
				x: yard.x + rng.range(0, math.max(1, yard.w - pw)),
				y: yard.y + rng.range(0, math.max(1, yard.h - ph)),
				w: pw,
				h: ph,
			};
			if (!overlapsGround(lot, p)) lot.patches.push(p);
		}
	}

	// --- cars: parallel parking, a few abandoned ---
	parkCars(g);

	// --- map border: dense forest + fence ---
	const t = TOWN.BORDER;
	const border = (x: number, y: number, bw: number, bh: number, kind: SolidKind) =>
		addSolid(w, {
			kind,
			x,
			y,
			w: bw,
			h: bh,
			hp: 999999,
			hpMax: 999999,
			destructible: false,
			tags: "border",
		});
	border(0, 0, w.width, t, "wall_h");
	border(0, w.height - t, w.width, t, "wall_h");
	border(0, t, t, w.height - t * 2, "wall_v");
	border(w.width - t, t, t, w.height - t * 2, "wall_v");

	// --- the inside of every building, now that nothing else will be placed ---
	planInteriors(g);

	return w;
}

export function spawnGroundItem(
	w: WorldData,
	kind: number,
	itemId: number,
	count: number,
	x: number,
	y: number,
	vx = 0,
	vy = 0,
): GroundItem {
	const item: GroundItem = {
		id: takeId(w),
		kind,
		itemId,
		count,
		x,
		y,
		vx,
		vy,
	};
	w.items.push(item);
	if (w.onItemAdd !== undefined) w.onItemAdd(w, item);
	return item;
}

/**
 * Takes one ground item out of the world; answers whether it was still there.
 *
 * The answer is the whole point on the server (§8.3 "Atomicidade"): two survivors pressing E on the same
 * can of food in the same tick both find it with `interactTarget`, and this is the check-and-remove that
 * decides which of them is holding it. Luau is single-threaded and nothing here yields, so the second call
 * returns false and that player gets nothing — never a second copy.
 */
export function removeGroundItem(w: WorldData, item: GroundItem): boolean {
	const i = w.items.indexOf(item);
	if (i < 0) return false;
	w.items.remove(i);
	if (w.onItemRemove !== undefined) w.onItemRemove(w, item);
	return true;
}

/**
 * Slides the items that are still moving, and leaves the rest alone.
 *
 * An item spends a fraction of a second in flight after it is thrown and the rest of the run lying still, so
 * almost every entry of this list is at rest almost all of the time. Integrating a velocity of exactly zero
 * — and re-testing the world bounds of something that has not moved — is work that grows with the size of
 * the town and buys nothing. The early exit turns the per-frame cost of a scavenged town into one compare
 * per item.
 *
 * It runs on the client today (client/gameLoop.ts) and, from MP_PHASE 3, on the authoritative server as
 * well (server/sim/simulation.ts), which is the other reason it is worth being cheap.
 */
export function updateGroundItems(w: WorldData, dt: number): void {
	for (let i = w.items.size() - 1; i >= 0; i--) {
		const it = w.items[i];
		// at rest: it cannot move, and something that has not moved cannot have left the world
		if (it.vx === 0 && it.vy === 0) continue;
		it.x += it.vx * dt;
		it.y += it.vy * dt;
		it.vx *= 0.9;
		it.vy *= 0.9;
		if (it.vx * it.vx + it.vy * it.vy < 1) {
			it.vx = 0;
			it.vy = 0;
		}
		if (it.x < 0 || it.y < 0 || it.x > w.width || it.y > w.height) {
			w.items.remove(i);
			if (w.onItemRemove !== undefined) w.onItemRemove(w, it);
		}
	}
}

export function nearestInteractables(
	w: WorldData,
	x: number,
	y: number,
	radius: number,
): { solid?: Solid; item?: GroundItem } {
	let bestD = radius;
	let solid: Solid | undefined;
	for (const s of querySolids(w, x - radius, y - radius, x + radius, y + radius)) {
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const d = math.max(math.abs(cx - x) - s.w / 2, math.abs(cy - y) - s.h / 2);
		if (d < bestD) {
			bestD = d;
			solid = s;
		}
	}
	// box first, then squared distance: no square root per item (same reasoning as
	// shared/sim/interactQuery.ts's nearestGroundItem, which is the one the E key actually uses)
	const reach = DESIGN.ITEM_GET_DISTANCE + 20;
	let item: GroundItem | undefined;
	let bestI2 = reach * reach;
	for (const it of w.items) {
		const dx = it.x - x;
		if (dx > reach || dx < -reach) continue;
		const dy = it.y - y;
		if (dy > reach || dy < -reach) continue;
		const d2 = dx * dx + dy * dy;
		if (d2 < bestI2) {
			bestI2 = d2;
			item = it;
		}
	}
	return { solid, item };
}

export function isOnRoad(w: WorldData, x: number, y: number): boolean {
	for (const r of w.roads) {
		if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
	}
	return false;
}

/** Random point in the box with 40 u free of solids; never returns a blocked point unless the box is full. */
export function randomOpenPoint(w: WorldData, minX: number, minY: number, maxX: number, maxY: number): Vec2 {
	for (let tries = 0; tries < 60; tries++) {
		const x = rndRange(minX, maxX);
		const y = rndRange(minY, maxY);
		if (!pointInSolid(w, x, y, 40)) {
			return v2(x, y);
		}
	}
	// deterministic sweep from the centre outwards
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	const reach = math.max(maxX - minX, maxY - minY) / 2;
	for (let r = 0; r <= reach; r += 48) {
		const n = math.max(1, math.floor((r * math.pi * 2) / 48));
		for (let i = 0; i < n; i++) {
			const a = (i / n) * math.pi * 2;
			const x = cx + math.cos(a) * r;
			const y = cy + math.sin(a) * r;
			if (!pointInSolid(w, x, y, 40)) return v2(x, y);
		}
	}
	return v2(cx, cy);
}

export function randomRingPoint(cx: number, cy: number, minR: number, maxR: number): Vec2 {
	const a = rnd() * math.pi * 2;
	const r = minR + rnd() * (maxR - minR);
	return v2(cx + math.cos(a) * r, cy + math.sin(a) * r);
}

export { chance, Z };
