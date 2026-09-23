import { isBlocking, querySolids, Solid, WorldData } from "./world";

/** collision radius of the player body (world units) */
export const PLAYER_RADIUS = 18;
/** collision radius of a normal zombie (the big variant multiplies it by ZombieState.scale) */
export const ZOMBIE_RADIUS = 16;

export interface MoveResult {
	x: number;
	y: number;
	/** first solid that blocked the move, if any */
	hit?: Solid;
}

/** Built by the player (barricades, doors, turrets, lamps…): zombies attack them, bullets fly over them. */
export function isPlayerBuilt(s: Solid): boolean {
	return (
		s.kind === "barricade" ||
		s.kind === "iron_barricade" ||
		s.kind === "door" ||
		s.kind === "iron_door" ||
		s.kind === "structure"
	);
}

/** Stops bodies (player, zombies): walls, trees, cars, closed doors, structures. Not traps / open doors. */
export function blocksMovement(s: Solid): boolean {
	return isBlocking(s);
}

/**
 * Stops bullets, arrows and line of sight. Like the original (collision with par_solid only),
 * shots fly over the player's own constructions so you can shoot from behind a barricade.
 */
export function blocksShots(s: Solid): boolean {
	return isBlocking(s) && !isPlayerBuilt(s);
}

// ---------------------------------------------------------------------------
// circle vs AABB

const scratch: Array<Solid> = [];

/** push a circle out of every blocking rect it overlaps (a few Gauss-Seidel passes) */
function resolveCircle(world: WorldData, x: number, y: number, r: number): MoveResult {
	let hit: Solid | undefined;
	for (let iter = 0; iter < 4; iter++) {
		scratch.clear();
		querySolids(world, x - r, y - r, x + r, y + r, scratch);
		let moved = false;
		for (const s of scratch) {
			if (!isBlocking(s)) continue;
			const qx = math.clamp(x, s.x, s.x + s.w);
			const qy = math.clamp(y, s.y, s.y + s.h);
			const dx = x - qx;
			const dy = y - qy;
			const d2 = dx * dx + dy * dy;
			if (d2 >= r * r - 1e-6) continue;
			if (d2 > 1e-9) {
				const d = math.sqrt(d2);
				const push = r - d + 0.01;
				x += (dx / d) * push;
				y += (dy / d) * push;
			} else {
				// centre inside the rect: leave through the nearest side
				const left = x - s.x;
				const right = s.x + s.w - x;
				const top = y - s.y;
				const bottom = s.y + s.h - y;
				const m = math.min(left, right, top, bottom);
				if (m === left) x = s.x - r - 0.01;
				else if (m === right) x = s.x + s.w + r + 0.01;
				else if (m === top) y = s.y - r - 0.01;
				else y = s.y + s.h + r + 0.01;
			}
			moved = true;
			if (hit === undefined) hit = s;
		}
		if (!moved) break;
	}
	return { x, y, hit };
}

/**
 * Move a circular actor by (dx, dy) against the world's blocking solids.
 * Real circle×AABB collision: penetration is resolved along the contact normal, so the actor
 * slides along walls and rounds corners; long moves are split into sub-steps (≤ radius/2) so
 * nothing tunnels through a thin wall. Used for the player (gameLoop), zombies and knockback.
 */
export function moveActor(world: WorldData, x: number, y: number, radius: number, dx: number, dy: number): MoveResult {
	let len = math.sqrt(dx * dx + dy * dy);
	// a lag spike must not turn into a teleport
	if (len > 400) {
		dx = (dx / len) * 400;
		dy = (dy / len) * 400;
		len = 400;
	}
	const maxStep = math.max(radius * 0.5, 4);
	const steps = math.clamp(math.ceil(len / maxStep), 1, 100);
	const sx = dx / steps;
	const sy = dy / steps;
	let hit: Solid | undefined;
	for (let i = 0; i < steps; i++) {
		const r = resolveCircle(world, x + sx, y + sy, radius);
		x = r.x;
		y = r.y;
		if (hit === undefined && r.hit !== undefined) hit = r.hit;
	}
	if (len < 1e-6) {
		// still resolve a standing actor (e.g. a door closed on it)
		const r = resolveCircle(world, x, y, radius);
		x = r.x;
		y = r.y;
		hit = r.hit;
	}
	return { x, y, hit };
}

/** First blocking solid overlapping the circle (spawn / landing / placement checks). */
export function circleBlocked(world: WorldData, x: number, y: number, r: number): Solid | undefined {
	scratch.clear();
	querySolids(world, x - r, y - r, x + r, y + r, scratch);
	for (const s of scratch) {
		if (!isBlocking(s)) continue;
		const qx = math.clamp(x, s.x, s.x + s.w);
		const qy = math.clamp(y, s.y, s.y + s.h);
		const dx = x - qx;
		const dy = y - qy;
		if (dx * dx + dy * dy < r * r) return s;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// rays

/** distance along the unit ray (dx, dy) at which it enters the rect, if within [0, maxDist] */
function rayAabb(x0: number, y0: number, dx: number, dy: number, maxDist: number, s: Solid): number | undefined {
	let tmin = 0;
	let tmax = maxDist;
	if (math.abs(dx) < 1e-9) {
		if (x0 < s.x || x0 > s.x + s.w) return undefined;
	} else {
		let t1 = (s.x - x0) / dx;
		let t2 = (s.x + s.w - x0) / dx;
		if (t1 > t2) {
			const t = t1;
			t1 = t2;
			t2 = t;
		}
		tmin = math.max(tmin, t1);
		tmax = math.min(tmax, t2);
		if (tmin > tmax) return undefined;
	}
	if (math.abs(dy) < 1e-9) {
		if (y0 < s.y || y0 > s.y + s.h) return undefined;
	} else {
		let t1 = (s.y - y0) / dy;
		let t2 = (s.y + s.h - y0) / dy;
		if (t1 > t2) {
			const t = t1;
			t1 = t2;
			t2 = t;
		}
		tmin = math.max(tmin, t1);
		tmax = math.min(tmax, t2);
		if (tmin > tmax) return undefined;
	}
	return tmin;
}

export interface RayHit {
	/** distance to the first hit (maxDist when nothing was hit) */
	dist: number;
	solid?: Solid;
}

const rayScratch: Array<Solid> = [];

/**
 * Cast a ray from (x0, y0) along the angle for maxDist; returns the nearest solid accepted by
 * `filter` (default: blocksShots). Exact slab test against every solid of the ray's bounding box.
 */
export function raycast(
	world: WorldData,
	x0: number,
	y0: number,
	angle: number,
	maxDist: number,
	filter: (s: Solid) => boolean = blocksShots,
): RayHit {
	const dx = math.cos(angle);
	const dy = math.sin(angle);
	const x1 = x0 + dx * maxDist;
	const y1 = y0 + dy * maxDist;
	rayScratch.clear();
	querySolids(
		world,
		math.min(x0, x1) - 1,
		math.min(y0, y1) - 1,
		math.max(x0, x1) + 1,
		math.max(y0, y1) + 1,
		rayScratch,
	);
	let best = maxDist;
	let bestSolid: Solid | undefined;
	for (const s of rayScratch) {
		if (!filter(s)) continue;
		const t = rayAabb(x0, y0, dx, dy, best, s);
		if (t !== undefined && t < best) {
			best = t;
			bestSolid = s;
		}
	}
	return { dist: best, solid: bestSolid };
}

/** true when nothing accepted by `filter` lies on the segment */
export function segmentClear(
	world: WorldData,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	filter: (s: Solid) => boolean = blocksShots,
): boolean {
	const dx = x1 - x0;
	const dy = y1 - y0;
	const d = math.sqrt(dx * dx + dy * dy);
	if (d < 1) return true;
	return raycast(world, x0, y0, math.atan2(dy, dx), d, filter).solid === undefined;
}

/**
 * Entry distance of the unit ray (dx, dy) into the circle (cx, cy, r), or undefined.
 * A ray that starts inside the circle hits at 0.
 */
export function rayCircle(
	x0: number,
	y0: number,
	dx: number,
	dy: number,
	cx: number,
	cy: number,
	r: number,
): number | undefined {
	const ox = cx - x0;
	const oy = cy - y0;
	const along = ox * dx + oy * dy;
	const perp2 = ox * ox + oy * oy - along * along;
	if (perp2 > r * r) return undefined;
	const half = math.sqrt(r * r - perp2);
	const t = along - half;
	if (t >= 0) return t;
	if (along + half >= 0) return 0;
	return undefined;
}

// ---------------------------------------------------------------------------
// navigation: flow field around the player

const FREE = 0;
const SOFT = 1;
const HARD = 2;
const INF = 1e9;
const COST_ORTHO = 10;
const COST_DIAG = 14;
/** extra cost to go through a player construction (zombies would rather walk around it) */
const COST_SOFT = 60;
const BUCKETS = COST_DIAG + COST_SOFT + 1;
const NX: Array<number> = [1, -1, 0, 0, 1, 1, -1, -1];
const NY: Array<number> = [0, 0, 1, -1, 1, -1, 1, -1];

/**
 * Dijkstra flow field (Dial's bucket queue) on a 32 px grid centred on the target (the player).
 * Buildings are walled boxes with one doorway, so a zombie that follows the field walks around
 * the building and in through the door instead of pushing against a wall. Player constructions
 * are "soft" cells: passable at a high cost, so when the only way in is a barricade the zombies
 * path to it and hit it (zombieAI does the attack).
 *
 * Built incrementally and double-buffered: `startRebuild` rasterises the solids into the back
 * buffer, `step(budget)` expands at most `budget` cells per call (a few frames per rebuild), and
 * queries always read the last COMPLETE field — no frame ever pays for a whole Dijkstra.
 */
export class FlowField {
	readonly cell = 32;
	readonly size = 80;
	/** world position of the complete (front) grid's top-left corner */
	ox = 0;
	oy = 0;
	targetX = 0;
	targetY = 0;
	/**
	 * Index (in the AI's player list) of the survivor this field was built for. One source means one owner for
	 * every cell, so `targetOf` is that index everywhere; the server's multi-source field answers per cell
	 * (server/sim/flowField.ts, docs/MULTIPLAYER.md §3.3).
	 */
	targetIndex = 0;
	/** a complete field is available for queries */
	valid = false;
	/** a rebuild is in progress in the back buffer */
	building = false;
	private grid: Array<number> = [];
	private dist: Array<number> = [];
	private bGrid: Array<number> = [];
	private bDist: Array<number> = [];
	private bOx = 0;
	private bOy = 0;
	private bTx = 0;
	private bTy = 0;
	private bD = 0;
	private bPending = 0;
	private buckets: Array<Array<number>> = [];
	private solidsBuf: Array<Solid> = [];

	constructor() {
		const n = this.size * this.size;
		for (let i = 0; i < n; i++) {
			this.grid.push(FREE);
			this.dist.push(INF);
			this.bGrid.push(FREE);
			this.bDist.push(INF);
		}
		for (let i = 0; i < BUCKETS; i++) {
			this.buckets.push([]);
		}
	}

	/** is the world point inside the (complete) field? */
	contains(x: number, y: number): boolean {
		const span = this.cell * this.size;
		return this.valid && x >= this.ox && y >= this.oy && x < this.ox + span && y < this.oy + span;
	}

	private cellIndex(x: number, y: number): number {
		const gx = math.floor((x - this.ox) / this.cell);
		const gy = math.floor((y - this.oy) / this.cell);
		if (gx < 0 || gy < 0 || gx >= this.size || gy >= this.size) return -1;
		return gy * this.size + gx;
	}

	private rasterize(world: WorldData): void {
		const size = this.size;
		const cell = this.cell;
		const grid = this.bGrid;
		const n = size * size;
		for (let i = 0; i < n; i++) grid[i] = FREE;
		const span = cell * size;
		const ox = this.bOx;
		const oy = this.bOy;
		const buf = this.solidsBuf;
		buf.clear();
		querySolids(world, ox, oy, ox + span, oy + span, buf);
		const inflate = 4;
		for (const s of buf) {
			if (!isBlocking(s)) continue;
			const v = isPlayerBuilt(s) && s.destructible ? SOFT : HARD;
			const gx0 = math.max(0, math.floor((s.x - inflate - ox) / cell));
			const gy0 = math.max(0, math.floor((s.y - inflate - oy) / cell));
			const gx1 = math.min(size - 1, math.floor((s.x + s.w + inflate - ox) / cell));
			const gy1 = math.min(size - 1, math.floor((s.y + s.h + inflate - oy) / cell));
			for (let gy = gy0; gy <= gy1; gy++) {
				const row = gy * size;
				for (let gx = gx0; gx <= gx1; gx++) {
					if (grid[row + gx] < v) grid[row + gx] = v;
				}
			}
		}
	}

	private seed(i: number, d: number): void {
		if (d < this.bDist[i]) {
			this.bDist[i] = d;
			this.buckets[d % BUCKETS].push(i);
			this.bPending++;
		}
	}

	/** Start computing a new field towards (tx, ty) in the back buffer (rasterises the solids). */
	startRebuild(world: WorldData, tx: number, ty: number): void {
		const size = this.size;
		const cell = this.cell;
		const half = (size * cell) / 2;
		this.bOx = math.floor((tx - half) / cell) * cell;
		this.bOy = math.floor((ty - half) / cell) * cell;
		this.bTx = tx;
		this.bTy = ty;
		this.rasterize(world);
		const n = size * size;
		const dist = this.bDist;
		for (let i = 0; i < n; i++) dist[i] = INF;
		for (const b of this.buckets) b.clear();
		this.bD = 0;
		this.bPending = 0;
		this.building = true;
		const gx = math.floor((tx - this.bOx) / cell);
		const gy = math.floor((ty - this.bOy) / cell);
		if (gx < 0 || gy < 0 || gx >= size || gy >= size) {
			this.building = false;
			return;
		}
		const start = gy * size + gx;
		this.seed(start, 0);
		// the player may stand in a cell that touches a wall: also seed the walkable cells around
		if (this.bGrid[start] !== FREE) {
			for (let k = 0; k < 8; k++) {
				const nx = gx + NX[k];
				const ny = gy + NY[k];
				if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
				const i = ny * size + nx;
				if (this.bGrid[i] !== HARD) this.seed(i, COST_ORTHO);
			}
		}
	}

	/**
	 * Expand up to `budget` cells of the pending rebuild. Returns true when the new field is
	 * complete (it then becomes the one queries use).
	 */
	step(budget: number): boolean {
		if (!this.building) return false;
		const size = this.size;
		const dist = this.bDist;
		const grid = this.bGrid;
		const buckets = this.buckets;
		let work = 0;
		let d = this.bD;
		while (this.bPending > 0 && work < budget) {
			const bucket = buckets[d % BUCKETS];
			if (bucket.size() === 0) {
				d++;
				continue;
			}
			const c = bucket.pop()!;
			this.bPending--;
			work++;
			if (dist[c] !== d) continue;
			const cx = c % size;
			const cy = (c - cx) / size;
			for (let k = 0; k < 8; k++) {
				const gx = cx + NX[k];
				const gy = cy + NY[k];
				if (gx < 0 || gy < 0 || gx >= size || gy >= size) continue;
				const ni = gy * size + gx;
				const g = grid[ni];
				if (g === HARD) continue;
				let cost = COST_ORTHO;
				if (k >= 4) {
					// no corner cutting through a wall joint
					if (grid[cy * size + gx] === HARD || grid[gy * size + cx] === HARD) continue;
					cost = COST_DIAG;
				}
				if (g === SOFT) cost += COST_SOFT;
				const nd = d + cost;
				if (nd < dist[ni]) {
					dist[ni] = nd;
					buckets[nd % BUCKETS].push(ni);
					this.bPending++;
				}
			}
		}
		this.bD = d;
		if (this.bPending > 0) return false;
		// swap: the back buffer becomes the field everybody reads
		const g = this.grid;
		this.grid = this.bGrid;
		this.bGrid = g;
		const dd = this.dist;
		this.dist = this.bDist;
		this.bDist = dd;
		this.ox = this.bOx;
		this.oy = this.bOy;
		this.targetX = this.bTx;
		this.targetY = this.bTy;
		this.valid = true;
		this.building = false;
		return true;
	}

	/** Synchronous rebuild (tests / first frame). */
	rebuild(world: WorldData, tx: number, ty: number): void {
		this.startRebuild(world, tx, ty);
		this.step(1e9);
	}

	/** straight segment between two points crosses no HARD cell */
	private lineFree(x0: number, y0: number, x1: number, y1: number): boolean {
		const dx = x1 - x0;
		const dy = y1 - y0;
		const d = math.sqrt(dx * dx + dy * dy);
		const steps = math.max(1, math.ceil(d / (this.cell * 0.5)));
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			const c = this.cellIndex(x0 + dx * t, y0 + dy * t);
			if (c < 0 || this.grid[c] === HARD) return false;
		}
		return true;
	}

	private cellCenterX(c: number): number {
		return this.ox + (c % this.size) * this.cell + this.cell / 2;
	}

	private cellCenterY(c: number): number {
		return this.oy + math.floor(c / this.size) * this.cell + this.cell / 2;
	}

	/** lowest-distance walkable neighbour of cell c (undefined when c is a local minimum) */
	private downhill(c: number): number | undefined {
		const size = this.size;
		const cx = c % size;
		const cy = (c - cx) / size;
		let best = this.dist[c];
		let bestI: number | undefined;
		for (let k = 0; k < 8; k++) {
			const gx = cx + NX[k];
			const gy = cy + NY[k];
			if (gx < 0 || gy < 0 || gx >= size || gy >= size) continue;
			const ni = gy * size + gx;
			if (this.grid[ni] === HARD) continue;
			if (k >= 4 && (this.grid[cy * size + gx] === HARD || this.grid[gy * size + cx] === HARD)) continue;
			if (this.dist[ni] < best) {
				best = this.dist[ni];
				bestI = ni;
			}
		}
		return bestI;
	}

	/**
	 * Heading (radians) a body at (x, y) should walk to follow the field, or undefined when the
	 * point is outside the field, unreachable, or already in the target cell (walk straight then).
	 * Follows the gradient a few cells ahead and aims at the farthest one in plain sight, so paths
	 * are smooth instead of 8-directional.
	 */
	heading(x: number, y: number): number | undefined {
		if (!this.valid) return undefined;
		const c = this.cellIndex(x, y);
		if (c < 0) return undefined;
		let cur = c;
		if (this.dist[cur] >= INF) {
			const nb = this.downhill(cur);
			if (nb === undefined || this.dist[nb] >= INF) return undefined;
			return math.atan2(this.cellCenterY(nb) - y, this.cellCenterX(nb) - x);
		}
		if (this.dist[cur] === 0) return undefined;
		let aim: number | undefined;
		let first: number | undefined;
		for (let step = 0; step < 4; step++) {
			const nb = this.downhill(cur);
			if (nb === undefined) break;
			cur = nb;
			if (first === undefined) first = nb;
			if (this.lineFree(x, y, this.cellCenterX(cur), this.cellCenterY(cur))) {
				aim = cur;
			} else {
				break;
			}
			if (this.dist[cur] === 0) break;
		}
		const target = aim ?? first;
		if (target === undefined) return undefined;
		return math.atan2(this.cellCenterY(target) - y, this.cellCenterX(target) - x);
	}

	/** the survivor every cell of this field leads to, or -1 while no complete field exists */
	targetOf(): number {
		return this.valid ? this.targetIndex : -1;
	}

	/** path distance (in cells) from the point to the target, huge when unreachable */
	pathCells(x: number, y: number): number {
		const c = this.cellIndex(x, y);
		if (c < 0) return INF;
		return this.dist[c] / COST_ORTHO;
	}
}
