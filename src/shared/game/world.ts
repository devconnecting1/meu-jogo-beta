import { COLORS, Z } from "shared/engine/colors";
import { DESIGN, TOWN } from "shared/engine/constants";
import { chance, rnd, rndInt, rndRange } from "shared/engine/rng";
import { Vec2, v2 } from "shared/engine/vec2";

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
	| "structure";

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
	/** building only: centre of the doorway (on the wall's mid-line) and which wall it is in */
	doorX?: number;
	doorY?: number;
	doorSide?: DoorSide;
	/** building walls (tags "bwall"): id of the building record they belong to */
	parentId?: number;
	/** tree only: visual canopy radius and the renderer-eased canopy opacity */
	canopyR?: number;
	canopyAlpha?: number;
	/** visual tint picked at generation (car paint, tree foliage) */
	tint?: Color3;
	/** set by removeSolid, so stale references (AI targets, UI) can notice */
	removed?: boolean;
	/** internal: spatial-grid query stamp used to de-duplicate multi-cell solids */
	gridStamp?: number;
}

export interface GroundItem {
	id: number;
	kind: number;
	itemId: number;
	count: number;
	x: number;
	y: number;
	vx: number;
	vy: number;
	life: number;
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type LotKind = "block" | "park" | "plaza";

/** A city block between roads (visual ground data; collision lives in solids). */
export interface Lot extends Rect {
	kind: LotKind;
	/** grass area: the lot minus the sidewalk band on its road-facing edges */
	yard: Rect;
	/** darker grass patches (visual only) */
	patches: Array<Rect>;
	/** dirt footpaths in parks (visual only, kept free of trees) */
	paths: Array<Rect>;
}

/** Uniform spatial hash of solids; maintained ONLY by addSolid/removeSolid. */
export interface SolidGrid {
	cell: number;
	cols: number;
	rows: number;
	cells: Array<Array<Solid>>;
	stamp: number;
}

export interface WorldData {
	solids: Array<Solid>;
	items: Array<GroundItem>;
	width: number;
	height: number;
	roads: Array<Rect>;
	lots: Array<Lot>;
	bossAnchors: Array<{ day: number; x: number; y: number; type: number; nextDay: number }>;
	nextId: number;
	grid: SolidGrid;
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

export function createWorld(width: number, height: number): WorldData {
	const cell = TOWN.GRID_CELL;
	const cols = math.max(1, math.ceil(width / cell));
	const rows = math.max(1, math.ceil(height / cell));
	const cells: Array<Array<Solid>> = [];
	for (let i = 0; i < cols * rows; i++) {
		cells.push([]);
	}
	return {
		solids: [],
		items: [],
		width,
		height,
		roads: [],
		lots: [],
		bossAnchors: [
			{ day: DESIGN.BOSS1_DAY, x: DESIGN.BOSS1_X, y: DESIGN.BOSS1_Y, type: 1, nextDay: DESIGN.BOSS1_DAY },
			{ day: DESIGN.BOSS2_DAY, x: DESIGN.BOSS2_X, y: DESIGN.BOSS2_Y, type: 2, nextDay: DESIGN.BOSS2_DAY },
			{ day: DESIGN.BOSS3_DAY, x: DESIGN.BOSS3_X, y: DESIGN.BOSS3_Y, type: 3, nextDay: DESIGN.BOSS3_DAY },
			{ day: DESIGN.BOSS4_DAY, x: DESIGN.BOSS4_X, y: DESIGN.BOSS4_Y, type: 4, nextDay: DESIGN.BOSS4_DAY },
		],
		nextId: 1,
		grid: { cell, cols, rows, cells, stamp: 0 },
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
			g.cells[r * g.cols + c].push(s);
		}
	}
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
}

/** The ONLY way to add a solid (keeps the spatial grid in sync). Solids must not move afterwards. */
export function addSolid(w: WorldData, s: Omit<Solid, "id">): Solid {
	const solid: Solid = { ...s, id: w.nextId++ };
	w.solids.push(solid);
	gridInsert(w.grid, solid);
	return solid;
}

/** Remove a solid (destroyed structure, etc.). Always go through here so spatial indexes stay in sync. */
export function removeSolid(w: WorldData, s: Solid): void {
	const i = w.solids.indexOf(s);
	if (i >= 0) w.solids.remove(i);
	gridRemove(w.grid, s);
	s.removed = true;
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
	const g = w.grid;
	g.stamp++;
	const stamp = g.stamp;
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
	return out;
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

/** First blocking solid containing the point (± pad). Bullets, line of sight, spawn checks. */
export function pointInSolid(w: WorldData, x: number, y: number, pad = 0): Solid | undefined {
	const g = w.grid;
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
	const g = w.grid;
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

/** Building record whose footprint contains the point (walls included), if any. */
export function buildingAt(w: WorldData, x: number, y: number): Solid | undefined {
	for (const s of querySolids(w, x - 1, y - 1, x + 1, y + 1)) {
		if (s.kind === "building" && x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
			return s;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// procedural town

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

const BUILDING_DEFS: Array<BuildingDef> = [
	{ type: 1, w: 428, h: 552, slots: 3, name: "house", weight: 3 },
	{ type: 1, w: 684, h: 556, slots: 2, name: "house", weight: 3 },
	{ type: 2, w: 808, h: 684, slots: 3, name: "house", weight: 3 },
	{ type: 2, w: 1068, h: 1068, slots: 3, name: "house", weight: 1 },
	{ type: 5, w: 684, h: 556, slots: 2, name: "gas", weight: 1 },
	{ type: 6, w: 684, h: 556, slots: 2, name: "pharmacy", weight: 1 },
	{ type: 7, w: 1064, h: 1068, slots: 4, name: "market", weight: 1 },
	{ type: 8, w: 684, h: 556, slots: 2, name: "market", weight: 1 },
	{ type: 9, w: 684, h: 556, slots: 2, name: "gunshop", weight: 1 },
	{ type: 10, w: 684, h: 556, slots: 2, name: "cloth", weight: 1 },
	{ type: 11, w: 1064, h: 1068, slots: 4, name: "restaurant", weight: 1 },
	{ type: 3, w: 1064, h: 1068, slots: 4, name: "school", weight: 1 },
	{ type: 4, w: 1064, h: 1068, slots: 4, name: "hospital", weight: 1 },
];

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

function pickBuilding(rng: TownRng): BuildingDef {
	let total = 0;
	for (const b of BUILDING_DEFS) total += b.weight;
	let r = rng.next() * total;
	for (const b of BUILDING_DEFS) {
		r -= b.weight;
		if (r < 0) return b;
	}
	return BUILDING_DEFS[0];
}

/** Evenly spaced road starts along one axis, with seeded jitter so lots are not all identical. */
function layoutRoads(total: number, rng: TownRng): Array<number> {
	const inner = total - TOWN.BORDER * 2;
	const n = math.max(1, math.floor((inner - TOWN.LOT_TARGET) / (TOWN.LOT_TARGET + TOWN.ROAD_W) + 0.5));
	const lot = (inner - n * TOWN.ROAD_W) / (n + 1);
	const starts: Array<number> = [];
	for (let i = 1; i <= n; i++) {
		const base = TOWN.BORDER + i * lot + (i - 1) * TOWN.ROAD_W;
		starts.push(math.floor(base + rng.range(-TOWN.ROAD_JITTER, TOWN.ROAD_JITTER)));
	}
	return starts;
}

/** intervals between roads (and between the border and the first/last road) */
function lotSpans(total: number, starts: Array<number>): Array<{ a: number; b: number; lo: boolean; hi: boolean }> {
	const spans: Array<{ a: number; b: number; lo: boolean; hi: boolean }> = [];
	let a = TOWN.BORDER;
	let lo = false;
	for (const s of starts) {
		spans.push({ a, b: s, lo, hi: true });
		a = s + TOWN.ROAD_W;
		lo = true;
	}
	spans.push({ a, b: total - TOWN.BORDER, lo, hi: false });
	return spans;
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

/** Placement bookkeeping for one generation pass. */
class Placer {
	/** door approaches, park paths: nothing solid may be placed here */
	reserved: Array<Rect> = [];
	bossClear: Array<Circle> = [];

	constructor(private w: WorldData) {}

	/** free of every solid (building footprints too), reserved area, boss plaza (and roads unless allowed) */
	canPlace(x: number, y: number, rw: number, rh: number, pad: number, allowRoad = false): boolean {
		const w = this.w;
		if (x < TOWN.BORDER || y < TOWN.BORDER || x + rw > w.width - TOWN.BORDER || y + rh > w.height - TOWN.BORDER) {
			return false;
		}
		const px = x - pad;
		const py = y - pad;
		const pw = rw + pad * 2;
		const ph = rh + pad * 2;
		if (querySolids(w, px, py, px + pw, py + ph).size() > 0) return false;
		for (const r of this.reserved) {
			if (rectOverlap(x, y, rw, rh, r.x, r.y, r.w, r.h)) return false;
		}
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

function nearestRoadSide(w: WorldData, x: number, y: number, bw: number, bh: number): DoorSide {
	let best: DoorSide = "bottom";
	let bestD = math.huge;
	for (const r of w.roads) {
		const overlapX = r.x < x + bw && r.x + r.w > x;
		const overlapY = r.y < y + bh && r.y + r.h > y;
		if (overlapX) {
			if (r.y + r.h <= y && y - (r.y + r.h) < bestD) {
				bestD = y - (r.y + r.h);
				best = "top";
			}
			if (r.y >= y + bh && r.y - (y + bh) < bestD) {
				bestD = r.y - (y + bh);
				best = "bottom";
			}
		}
		if (overlapY) {
			if (r.x + r.w <= x && x - (r.x + r.w) < bestD) {
				bestD = x - (r.x + r.w);
				best = "left";
			}
			if (r.x >= x + bw && r.x - (x + bw) < bestD) {
				bestD = r.x - (x + bw);
				best = "right";
			}
		}
	}
	return best;
}

function addWall(w: WorldData, kind: SolidKind, x: number, y: number, ww: number, wh: number, parentId: number): void {
	if (ww < 2 || wh < 2) return;
	addSolid(w, {
		kind,
		x,
		y,
		w: ww,
		h: wh,
		hp: 999999,
		hpMax: 999999,
		destructible: false,
		tags: "bwall",
		parentId,
	});
}

/**
 * A real building: a passable footprint record (loot, roof, door info) + 4 solid walls with one
 * doorway on the wall that faces the nearest road.
 */
function addBuilding(
	w: WorldData,
	rng: TownRng,
	placer: Placer,
	b: BuildingDef,
	x: number,
	y: number,
	bw: number,
	bh: number,
): void {
	const T = TOWN.WALL_T;
	const D = TOWN.DOOR_W;
	const side = nearestRoadSide(w, x, y, bw, bh);
	const horizontal = side === "top" || side === "bottom";
	const len = horizontal ? bw : bh;
	const slack = math.max(0, len / 2 - D / 2 - 80);
	const along = math.floor(len / 2 + rng.range(-1, 1) * slack * 0.7);
	let doorX: number;
	let doorY: number;
	if (side === "top") {
		doorX = x + along;
		doorY = y + T / 2;
	} else if (side === "bottom") {
		doorX = x + along;
		doorY = y + bh - T / 2;
	} else if (side === "left") {
		doorX = x + T / 2;
		doorY = y + along;
	} else {
		doorX = x + bw - T / 2;
		doorY = y + along;
	}
	const roof = SHOP_ROOF[b.type] ?? deadTownHsv(x, y, b.type);
	const rec = addSolid(w, {
		kind: "building",
		x,
		y,
		w: bw,
		h: bh,
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
	const id = rec.id;
	const d0 = along - D / 2;
	const d1 = along + D / 2;
	// top / bottom walls span the full width; left / right fit between them
	if (side === "top") {
		addWall(w, "wall_h", x, y, d0, T, id);
		addWall(w, "wall_h", x + d1, y, bw - d1, T, id);
	} else {
		addWall(w, "wall_h", x, y, bw, T, id);
	}
	if (side === "bottom") {
		addWall(w, "wall_h", x, y + bh - T, d0, T, id);
		addWall(w, "wall_h", x + d1, y + bh - T, bw - d1, T, id);
	} else {
		addWall(w, "wall_h", x, y + bh - T, bw, T, id);
	}
	if (side === "left") {
		addWall(w, "wall_v", x, y + T, T, d0 - T, id);
		addWall(w, "wall_v", x, y + d1, T, bh - T - d1, id);
	} else {
		addWall(w, "wall_v", x, y + T, T, bh - T * 2, id);
	}
	if (side === "right") {
		addWall(w, "wall_v", x + bw - T, y + T, T, d0 - T, id);
		addWall(w, "wall_v", x + bw - T, y + d1, T, bh - T - d1, id);
	} else {
		addWall(w, "wall_v", x + bw - T, y + T, T, bh - T * 2, id);
	}
	// keep the approach (outside, across setback + sidewalk up to the curb) and the entry (inside) clear
	const out = TOWN.SETBACK + TOWN.SIDEWALK + 8;
	const inn = 110;
	const half = D / 2 + 24;
	if (side === "top") placer.reserved.push({ x: doorX - half, y: y - out, w: half * 2, h: out + inn });
	else if (side === "bottom") placer.reserved.push({ x: doorX - half, y: y + bh - inn, w: half * 2, h: out + inn });
	else if (side === "left") placer.reserved.push({ x: x - out, y: doorY - half, w: out + inn, h: half * 2 });
	else placer.reserved.push({ x: x + bw - inn, y: doorY - half, w: out + inn, h: half * 2 });
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
function tryTree(w: WorldData, placer: Placer, cx: number, cy: number, pad: number): boolean {
	const t = TOWN.TREE_TRUNK;
	if (!placer.canPlace(cx - t / 2, cy - t / 2, t, t, pad)) return false;
	addTree(w, cx, cy);
	return true;
}

function addCar(w: WorldData, x: number, y: number, vertical: boolean): void {
	addSolid(w, {
		kind: "car",
		x,
		y,
		w: vertical ? TOWN.CAR_W : TOWN.CAR_L,
		h: vertical ? TOWN.CAR_L : TOWN.CAR_W,
		hp: 300,
		hpMax: 300,
		destructible: true,
		tags: "car",
		rot: vertical ? 1 : 0,
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

/** Procedural town: road grid, sidewalks, enterable buildings, trees, parked cars, trash cans. */
export function generateTown(seed = 0): WorldData {
	const w = createWorld(DESIGN.WORLD_W, DESIGN.WORLD_H);
	const rng = new TownRng(seed !== 0 ? seed : rndInt(1, 2147483646));
	const placer = new Placer(w);
	const R = TOWN.ROAD_W;
	const SW = TOWN.SIDEWALK;
	for (const a of w.bossAnchors) {
		placer.bossClear.push({ x: a.x, y: a.y, r: TOWN.BOSS_CLEAR });
	}

	// --- roads (inside the border) ---
	const xs = layoutRoads(w.width, rng);
	const ys = layoutRoads(w.height, rng);
	for (const x of xs) {
		w.roads.push({ x, y: TOWN.BORDER, w: R, h: w.height - TOWN.BORDER * 2 });
	}
	for (const y of ys) {
		w.roads.push({ x: TOWN.BORDER, y, w: w.width - TOWN.BORDER * 2, h: R });
	}

	// --- lots (blocks between roads) ---
	for (const sx of lotSpans(w.width, xs)) {
		for (const sy of lotSpans(w.height, ys)) {
			const lx = sx.a;
			const ly = sy.a;
			const lw = sx.b - sx.a;
			const lh = sy.b - sy.a;
			const yx = lx + (sx.lo ? SW : 0);
			const yy = ly + (sy.lo ? SW : 0);
			const yard = {
				x: yx,
				y: yy,
				w: lx + lw - (sx.hi ? SW : 0) - yx,
				h: ly + lh - (sy.hi ? SW : 0) - yy,
			};
			let kind: LotKind = "block";
			for (const a of w.bossAnchors) {
				if (a.x >= lx && a.x <= lx + lw && a.y >= ly && a.y <= ly + lh) kind = "plaza";
			}
			if (kind === "block" && rng.chance(0.14)) kind = "park";
			const lot: Lot = { x: lx, y: ly, w: lw, h: lh, kind, yard, patches: [], paths: [] };
			const nPatch = rng.int(4, 8);
			for (let i = 0; i < nPatch; i++) {
				const pw = rng.range(80, 220);
				const ph = rng.range(60, 180);
				lot.patches.push({
					x: yard.x + rng.range(0, math.max(1, yard.w - pw)),
					y: yard.y + rng.range(0, math.max(1, yard.h - ph)),
					w: pw,
					h: ph,
				});
			}
			if (kind === "park") {
				const pathW = 88;
				const px = yard.x + yard.w / 2 + rng.range(-120, 120) - pathW / 2;
				const py = yard.y + yard.h / 2 + rng.range(-120, 120) - pathW / 2;
				lot.paths.push({ x: px, y: yard.y, w: pathW, h: yard.h });
				lot.paths.push({ x: yard.x, y: py, w: yard.w, h: pathW });
				for (const p of lot.paths) {
					placer.reserved.push({ x: p.x - 20, y: p.y - 20, w: p.w + 40, h: p.h + 40 });
				}
			}
			w.lots.push(lot);
		}
	}

	// --- buildings: lined up along the lot's street faces, never on the sidewalk or road ---
	for (const lot of w.lots) {
		if (lot.kind !== "block") continue;
		const inner = {
			x: lot.yard.x + TOWN.SETBACK,
			y: lot.yard.y + TOWN.SETBACK,
			w: lot.yard.w - TOWN.SETBACK * 2,
			h: lot.yard.h - TOWN.SETBACK * 2,
		};
		const sides: Array<DoorSide> = [];
		if (lot.yard.y > lot.y) sides.push("top");
		if (lot.yard.y + lot.yard.h < lot.y + lot.h) sides.push("bottom");
		if (lot.yard.x > lot.x) sides.push("left");
		if (lot.yard.x + lot.yard.w < lot.x + lot.w) sides.push("right");
		const target = rng.int(2, inner.w * inner.h > 1150 * 1150 ? 4 : 3);
		const placed: Array<Rect> = [];
		for (let attempt = 0; attempt < 40 && placed.size() < target; attempt++) {
			const b = pickBuilding(rng);
			let bw = b.w;
			let bh = b.h;
			if (rng.chance(0.5)) {
				bw = b.h;
				bh = b.w;
			}
			if (bw > inner.w || bh > inner.h) {
				const t = bw;
				bw = bh;
				bh = t;
				if (bw > inner.w || bh > inner.h) continue;
			}
			const side = sides.size() > 0 ? sides[rng.int(0, sides.size() - 1)] : "top";
			let bx = inner.x + rng.next() * (inner.w - bw);
			let by = inner.y + rng.next() * (inner.h - bh);
			if (side === "top") by = inner.y;
			else if (side === "bottom") by = inner.y + inner.h - bh;
			else if (side === "left") bx = inner.x;
			else bx = inner.x + inner.w - bw;
			bx = math.floor(bx / 8) * 8;
			by = math.floor(by / 8) * 8;
			bx = math.clamp(bx, inner.x, inner.x + inner.w - bw);
			by = math.clamp(by, inner.y, inner.y + inner.h - bh);
			let ok = true;
			const g = TOWN.BUILDING_GAP;
			for (const p of placed) {
				if (rectOverlap(bx - g, by - g, bw + g * 2, bh + g * 2, p.x, p.y, p.w, p.h)) {
					ok = false;
					break;
				}
			}
			if (!ok || !placer.canPlace(bx, by, bw, bh, 0)) continue;
			placed.push({ x: bx, y: by, w: bw, h: bh });
			addBuilding(w, rng, placer, b, bx, by, bw, bh);
		}
		// trash cans against a side wall (never on the door side)
		const bins = rng.int(0, 2);
		for (let i = 0; i < bins && placed.size() > 0; i++) {
			const p = placed[rng.int(0, placed.size() - 1)];
			const s = TOWN.TRASH;
			for (let k = 0; k < 6; k++) {
				const face = rng.int(0, 3);
				let tx = p.x + rng.range(20, p.w - s - 20);
				let ty = p.y + rng.range(20, p.h - s - 20);
				if (face === 0) ty = p.y - s - 6;
				else if (face === 1) ty = p.y + p.h + 6;
				else if (face === 2) tx = p.x - s - 6;
				else tx = p.x + p.w + 6;
				if (placer.canPlace(tx, ty, s, s, 4)) {
					addTrash(w, tx, ty);
					break;
				}
			}
		}
	}

	// --- trees: street trees on every sidewalk, some in yards, dense in parks and plazas ---
	for (const lot of w.lots) {
		const yard = lot.yard;
		// street trees in the middle of the sidewalk band
		const edges: Array<{ x0: number; y0: number; dx: number; dy: number; len: number }> = [];
		const bottomY = lot.y + lot.h - SW / 2;
		const rightX = lot.x + lot.w - SW / 2;
		if (yard.y > lot.y) edges.push({ x0: lot.x, y0: lot.y + SW / 2, dx: 1, dy: 0, len: lot.w });
		if (yard.y + yard.h < lot.y + lot.h) edges.push({ x0: lot.x, y0: bottomY, dx: 1, dy: 0, len: lot.w });
		if (yard.x > lot.x) edges.push({ x0: lot.x + SW / 2, y0: lot.y, dx: 0, dy: 1, len: lot.h });
		if (yard.x + yard.w < lot.x + lot.w) edges.push({ x0: rightX, y0: lot.y, dx: 0, dy: 1, len: lot.h });
		for (const e of edges) {
			let t = 150 + rng.range(0, 120);
			while (t < e.len - 150) {
				if (rng.chance(0.6)) {
					tryTree(w, placer, e.x0 + e.dx * t, e.y0 + e.dy * t, 12);
				}
				t += rng.range(260, 380);
			}
		}
		// yard / park / plaza trees
		const n = lot.kind === "park" ? rng.int(20, 32) : lot.kind === "plaza" ? rng.int(10, 16) : rng.int(2, 6);
		const pad = lot.kind === "block" ? 64 : 56;
		let placedTrees = 0;
		for (let attempt = 0; attempt < n * 4 && placedTrees < n; attempt++) {
			const cx = yard.x + 50 + rng.next() * math.max(1, yard.w - 100);
			const cy = yard.y + 50 + rng.next() * math.max(1, yard.h - 100);
			if (tryTree(w, placer, cx, cy, pad)) placedTrees++;
		}
	}

	// --- parked cars along the curb lanes, never inside intersections ---
	for (const road of w.roads) {
		const vertical = road.h > road.w;
		const cross = w.roads.filter(r => r.h > r.w !== vertical);
		// segments between intersections along the road
		const cuts: Array<number> = [];
		for (const c of cross) cuts.push(vertical ? c.y : c.x);
		cuts.sort((a, b) => a < b);
		let segA = vertical ? road.y : road.x;
		const segments: Array<{ a: number; b: number }> = [];
		for (const c of cuts) {
			segments.push({ a: segA, b: c });
			segA = c + R;
		}
		segments.push({ a: segA, b: vertical ? road.y + road.h : road.x + road.w });
		for (const seg of segments) {
			const r = rng.next();
			const count = r < 0.3 ? 0 : r < 0.75 ? 1 : 2;
			let placedCars = 0;
			for (let i = 0; i < count * 3; i++) {
				if (i >= 3 && placedCars >= count) break;
				const L = TOWN.CAR_L;
				const Wd = TOWN.CAR_W;
				const room = seg.b - seg.a - 160 * 2 - L;
				if (room <= 0) break;
				const along = seg.a + 160 + rng.next() * room;
				const lane = rng.next();
				// parked at either curb; ~12 % abandoned in the middle of the road
				let off: number;
				if (lane < 0.44) off = 14;
				else if (lane < 0.88) off = R - 14 - Wd;
				else off = R / 2 - Wd / 2 + rng.range(-40, 40);
				const cx = vertical ? road.x + off : along;
				const cy = vertical ? along : road.y + off;
				const cw = vertical ? Wd : L;
				const ch = vertical ? L : Wd;
				if (placedCars < count && placer.canPlace(cx, cy, cw, ch, 12, true)) {
					addCar(w, math.floor(cx), math.floor(cy), vertical);
					placedCars++;
				}
			}
		}
	}

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
): void {
	w.items.push({
		id: w.nextId++,
		kind,
		itemId,
		count,
		x,
		y,
		vx,
		vy,
		life: 120,
	});
}

export function updateGroundItems(w: WorldData, dt: number): void {
	for (let i = w.items.size() - 1; i >= 0; i--) {
		const it = w.items[i];
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
	let item: GroundItem | undefined;
	let bestI = DESIGN.ITEM_GET_DISTANCE + 20;
	for (const it of w.items) {
		const d = math.sqrt((it.x - x) * (it.x - x) + (it.y - y) * (it.y - y));
		if (d < bestI) {
			bestI = d;
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

export function randomOpenPoint(w: WorldData, minX: number, minY: number, maxX: number, maxY: number): Vec2 {
	for (let tries = 0; tries < 40; tries++) {
		const x = rndRange(minX, maxX);
		const y = rndRange(minY, maxY);
		if (!pointInSolid(w, x, y, 40)) {
			return v2(x, y);
		}
	}
	return v2((minX + maxX) / 2, (minY + maxY) / 2);
}

export function randomRingPoint(cx: number, cy: number, minR: number, maxR: number): Vec2 {
	const a = rnd() * math.pi * 2;
	const r = minR + rnd() * (maxR - minR);
	return v2(cx + math.cos(a) * r, cy + math.sin(a) * r);
}

export { chance, Z };
