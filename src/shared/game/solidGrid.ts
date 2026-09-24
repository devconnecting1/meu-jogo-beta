//!native
import type { Solid, SolidGrid, WorldData } from "./world";

/*
 * The spatial grid of the town's solids and every query over it. This is the hottest code of the server tick after
 * the flow field -- every body's collision, every ray and every rasterised flow-field tile goes through `queryGrid` --
 * so it is compiled to native code (`//!native` on the first line becomes Luau's `--!native`), which Roblox advises
 * for exactly this kind of numeric table work (create.roblox.com/docs/luau/native-code-gen).
 *
 * It lives apart from world.ts because the rest of that file is the town generator, which runs once per town: the
 * kind of code the same docs say NOT to compile natively (server startup time, memory, and the game's limit on
 * native code). world.ts re-exports the public functions, so nothing that imports them from there changes, and only
 * TYPES come back from world.ts (`import type`): there is no runtime cycle between the two modules.
 */

export function rectOverlap(
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

/** the one cell every grid starts with everywhere: never written (gridInsert gives a cell its own list first) */
const EMPTY_CELL: Array<Solid> = [];

/** an empty spatial grid of `cell`-sized cells over width × height */
export function newGrid(width: number, height: number, cell: number): SolidGrid {
	const cols = math.max(1, math.ceil(width / cell));
	const rows = math.max(1, math.ceil(height / cell));
	const cells: Array<Array<Solid>> = [];
	for (let i = 0; i < cols * rows; i++) {
		cells.push(EMPTY_CELL);
	}
	return { cell, cols, rows, cells, stamp: 0, count: 0 };
}

function cellCol(g: SolidGrid, x: number): number {
	return math.clamp(math.floor(x / g.cell), 0, g.cols - 1);
}

function cellRow(g: SolidGrid, y: number): number {
	return math.clamp(math.floor(y / g.cell), 0, g.rows - 1);
}

export function gridInsert(g: SolidGrid, s: Solid): void {
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

export function gridRemove(g: SolidGrid, s: Solid): void {
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
export function gridOf(w: WorldData, s: Solid): SolidGrid {
	return s.parentId !== undefined ? w.fine : w.grid;
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
