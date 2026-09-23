import { isBlocking, querySolids, Solid, WorldData } from "shared/game/world";
import { TOWN } from "shared/engine/constants";
import { isPlayerBuilt, stampWindow, WINDOW_COST } from "shared/game/physics";

/*
 * Multi-source chase field (docs/MULTIPLAYER.md §3.3). SERVER ONLY — but a pure module: no Instances, no
 * services, no os.clock, so tools/test-ai.mjs runs it under Node.
 *
 * The client's field (shared/game/physics.ts FlowField) is one 80×80 window centred on THE survivor,
 * re-rasterised from scratch every 0.4 s. With six survivors that breaks twice over: there is no single
 * centre, and re-rasterising six windows would cost more than the Dijkstra itself.
 *
 * So the field is laid over the world instead of over a player:
 *
 *   - the grid is WORLD-ALIGNED, in tiles of TILE × TILE cells of CELL units — 512 u, exactly the town's
 *     spatial-grid cell, so rasterising one tile queries one cell of it;
 *   - a tile is ACTIVE while it is within ACTIVE_RADIUS of a source, which for one survivor is the same
 *     reach the client window had;
 *   - the STATIC layer of a tile (walls, trees, cars) is rasterised once and cached for the session; only
 *     the DYNAMIC layer (constructions, doors) is redone, and only for tiles somebody marked dirty. That
 *     removes the biggest fixed cost of the old rebuild;
 *   - the Dijkstra (Dial's buckets, the same 10 / 14 / +60 costs) is MULTI-SOURCE: every standing survivor
 *     is a seed at distance 0, and a downed one a seed at DOWNED_SEED, so the horde prefers someone who can
 *     still fight back but does not ignore the body on the floor;
 *   - every cell also stores its OWNER: the seed that reached it first. That is "the nearest survivor along
 *     a real path" for free — which behind a wall is not the nearest one in a straight line.
 *
 * The rebuild is double-buffered and budgeted in cells: queries always read the last COMPLETE field, and no
 * tick ever pays for a whole Dijkstra (§3.2 gives it ~2 ms per tick).
 */

const FREE = 0;
/** a window's sill (docs/DESIGN_RULES.md EDI-10): passable at WINDOW_COST, so a door nearby wins */
const VAULT = 1;
const SOFT = 2;
const HARD = 3;
const INF = 1e9;
const COST_ORTHO = 10;
const COST_DIAG = 14;
/** extra cost to go through a player construction (zombies would rather walk around it) */
const COST_SOFT = 60;
/**
 * §3.3: a downed survivor enters the queue 20 cells "late", so a standing one nearby always wins the cell —
 * but with nobody else around, the horde still comes for the body.
 */
export const DOWNED_SEED = 200;
/**
 * Dial's queue needs one bucket per distinct distance in flight. The seeds already span DOWNED_SEED, so the
 * ring has to be wider than that plus the costliest edge, or a cell seeded at 200 would land in the bucket of
 * distance 50 and be dropped. This is why the ring is not just COST_DIAG + COST_SOFT + 1.
 */
const BUCKETS = DOWNED_SEED + COST_DIAG + COST_SOFT + 1;
const NX: Array<number> = [1, -1, 0, 0, 1, 1, -1, -1];
const NY: Array<number> = [0, 0, 1, -1, 1, -1, 1, -1];

/** side of one cell, in world units (the client field uses the same 32) */
export const CELL = 32;
/** cells per tile side: TILE × CELL must be TOWN.GRID_CELL, so a tile is one spatial-grid cell */
export const TILE = TOWN.GRID_CELL / CELL;
const TILE_CELLS = TILE * TILE;
/** §3.3: a tile is active while it is this close to a source — the client window's half-size */
export const ACTIVE_RADIUS = 1280;
/** how far a rasterised solid is inflated, so a body does not clip the corner of a wall cell */
const INFLATE = 4;
/** tile keys: the town is 44 × 33 tiles, so this offset and stride keep every key unique and positive */
const KEY_ORIGIN = 1024;
const KEY_STRIDE = 4096;

/** one survivor the horde may path to */
export interface FlowSource {
	x: number;
	y: number;
	/** index in AiRefs.players: what `targetOf` answers */
	index: number;
	/** starting distance: 0 standing, DOWNED_SEED downed (§3.3) */
	seed: number;
}

interface Tile {
	tx: number;
	ty: number;
	ox: number;
	oy: number;
	/** static layer (everything that is not player-built), rasterised once per staticGen */
	stat: Array<number>;
	statGen: number;
	/** static + dynamic layer, rebuilt while `dirty` */
	grid: Array<number>;
	dirty: boolean;
	/** complete field (queries) */
	dist?: Array<number>;
	owner?: Array<number>;
	frontIdx: number;
	frontGen: number;
	/** rebuild in progress */
	bDist?: Array<number>;
	bOwner?: Array<number>;
	backIdx: number;
	backGen: number;
}

export class MultiFlowField {
	readonly cell = CELL;
	/** a complete field is available for queries */
	valid = false;
	/** a rebuild is in progress in the back buffers */
	building = false;
	/** cells expanded by the rebuild in progress (diagnostics, §3.2) */
	cellsExpanded = 0;
	/** cells the last completed rebuild expanded */
	lastCells = 0;
	/** active tiles of the last completed field */
	lastTiles = 0;

	private readonly tiles = new Map<number, Tile>();
	private readonly pool: Array<Array<number>> = [];
	private frontTiles: Array<Tile> = [];
	private backTiles: Array<Tile> = [];
	/** 9 entries per tile: the back index of each neighbour, or -1 */
	private frontNb: Array<number> = [];
	private backNb: Array<number> = [];
	private readonly buckets: Array<Array<number>> = [];
	private frontGen = 0;
	private backGen = 0;
	private staticGen = 1;
	private pending = 0;
	private bD = 0;
	private readonly solidsBuf: Array<Solid> = [];

	constructor() {
		for (let i = 0; i < BUCKETS; i++) this.buckets.push([]);
	}

	// ---------------------------------------------------------------- tiles

	/** one key per tile; the offset keeps a lookup one tile outside the map from colliding with a real one */
	private key(tx: number, ty: number): number {
		return (ty + KEY_ORIGIN) * KEY_STRIDE + (tx + KEY_ORIGIN);
	}

	private tileAt(tx: number, ty: number): Tile {
		const k = this.key(tx, ty);
		let t = this.tiles.get(k);
		if (t === undefined) {
			t = {
				tx,
				ty,
				ox: tx * TILE * CELL,
				oy: ty * TILE * CELL,
				stat: this.acquire(FREE),
				statGen: 0,
				grid: this.acquire(FREE),
				dirty: true,
				frontIdx: -1,
				frontGen: -1,
				backIdx: -1,
				backGen: -1,
			};
			this.tiles.set(k, t);
		}
		return t;
	}

	private lookup(tx: number, ty: number): Tile | undefined {
		return this.tiles.get(this.key(tx, ty));
	}

	private acquire(fill: number): Array<number> {
		const a = this.pool.pop();
		if (a === undefined) {
			const fresh = new Array<number>();
			for (let i = 0; i < TILE_CELLS; i++) fresh.push(fill);
			return fresh;
		}
		for (let i = 0; i < TILE_CELLS; i++) a[i] = fill;
		return a;
	}

	private release(a: Array<number> | undefined): void {
		if (a !== undefined) this.pool.push(a);
	}

	/** the walls, trees and cars of this tile: they never move, so this is paid once per staticGen */
	private rasterizeStatic(world: WorldData, t: Tile): void {
		const grid = t.stat;
		for (let i = 0; i < TILE_CELLS; i++) grid[i] = FREE;
		const span = TILE * CELL;
		const buf = this.solidsBuf;
		buf.clear();
		querySolids(world, t.ox, t.oy, t.ox + span, t.oy + span, buf);
		for (const s of buf) {
			if (s.kind === "window") {
				stampWindow(s, t.ox, t.oy, CELL, TILE, (gx, gy) => {
					if (grid[gy * TILE + gx] < VAULT) grid[gy * TILE + gx] = VAULT;
				});
				continue;
			}
			if (isPlayerBuilt(s)) continue;
			if (!isBlocking(s)) continue;
			this.stamp(grid, t, s, HARD);
		}
		t.statGen = this.staticGen;
	}

	/** what the players put there: passable at a price (SOFT) so the horde chews through when it must */
	private rasterizeDynamic(world: WorldData, t: Tile): void {
		const grid = t.grid;
		const stat = t.stat;
		for (let i = 0; i < TILE_CELLS; i++) grid[i] = stat[i];
		const span = TILE * CELL;
		const buf = this.solidsBuf;
		buf.clear();
		querySolids(world, t.ox, t.oy, t.ox + span, t.oy + span, buf);
		for (const s of buf) {
			if (!isPlayerBuilt(s) || !isBlocking(s)) continue;
			this.stamp(grid, t, s, s.destructible ? SOFT : HARD);
		}
		t.dirty = false;
	}

	private stamp(grid: Array<number>, t: Tile, s: Solid, v: number): void {
		const gx0 = math.max(0, math.floor((s.x - INFLATE - t.ox) / CELL));
		const gy0 = math.max(0, math.floor((s.y - INFLATE - t.oy) / CELL));
		const gx1 = math.min(TILE - 1, math.floor((s.x + s.w + INFLATE - t.ox) / CELL));
		const gy1 = math.min(TILE - 1, math.floor((s.y + s.h + INFLATE - t.oy) / CELL));
		for (let gy = gy0; gy <= gy1; gy++) {
			const row = gy * TILE;
			for (let gx = gx0; gx <= gx1; gx++) {
				if (grid[row + gx] < v) grid[row + gx] = v;
			}
		}
	}

	private ensureGrid(world: WorldData, t: Tile): void {
		if (t.statGen !== this.staticGen) {
			this.rasterizeStatic(world, t);
			t.dirty = true;
		}
		if (t.dirty) this.rasterizeDynamic(world, t);
	}

	// ---------------------------------------------------------------- invalidation

	/**
	 * Something solid changed inside this rect: a barricade went up or down, a door opened. Only the tiles it
	 * touches re-rasterise, and only their dynamic layer unless `withStatic` says the map itself changed
	 * (a chopped tree, a wrecked car).
	 */
	dirtyRect(x: number, y: number, w: number, h: number, withStatic = false): void {
		const span = TILE * CELL;
		const tx0 = math.floor((x - INFLATE) / span);
		const tx1 = math.floor((x + w + INFLATE) / span);
		const ty0 = math.floor((y - INFLATE) / span);
		const ty1 = math.floor((y + h + INFLATE) / span);
		for (let ty = ty0; ty <= ty1; ty++) {
			for (let tx = tx0; tx <= tx1; tx++) {
				const t = this.lookup(tx, ty);
				if (t === undefined) continue;
				t.dirty = true;
				if (withStatic) t.statGen = 0;
			}
		}
	}

	/** the whole map has to be read again (the solid count moved and nobody said where) */
	dirtyAll(withStatic = false): void {
		if (withStatic) this.staticGen += 1;
		for (const [, t] of this.tiles) t.dirty = true;
	}

	// ---------------------------------------------------------------- rebuild

	private seed(t: Tile, cellIx: number, d: number, owner: number): void {
		const dist = t.bDist;
		const own = t.bOwner;
		if (dist === undefined || own === undefined) return;
		if (d >= dist[cellIx]) return;
		dist[cellIx] = d;
		own[cellIx] = owner;
		this.buckets[d % BUCKETS].push(t.backIdx * TILE_CELLS + cellIx);
		this.pending += 1;
	}

	/** Start a new field towards `sources` in the back buffers (activates and rasterises the tiles). */
	startRebuild(world: WorldData, sources: ReadonlyArray<FlowSource>): void {
		this.backGen += 1;
		const gen = this.backGen;
		const span = TILE * CELL;
		const reach = math.ceil(ACTIVE_RADIUS / span);
		this.backTiles.clear();
		if (sources.size() === 0) {
			this.building = false;
			return;
		}
		for (const s of sources) {
			const ctx = math.floor(s.x / span);
			const cty = math.floor(s.y / span);
			for (let ty = cty - reach; ty <= cty + reach; ty++) {
				for (let tx = ctx - reach; tx <= ctx + reach; tx++) {
					if (tx < 0 || ty < 0 || tx * span >= world.width || ty * span >= world.height) continue;
					// the tile's NEAREST corner decides: a square of tiles would activate a third more of
					// them than §3.3 asks for, and every one of them is 256 cells of Dijkstra
					const nx = math.clamp(s.x, tx * span, (tx + 1) * span);
					const ny = math.clamp(s.y, ty * span, (ty + 1) * span);
					const ddx = s.x - nx;
					const ddy = s.y - ny;
					if (ddx * ddx + ddy * ddy > ACTIVE_RADIUS * ACTIVE_RADIUS) continue;
					const t = this.tileAt(tx, ty);
					if (t.backGen === gen) continue;
					t.backGen = gen;
					t.backIdx = this.backTiles.size();
					this.backTiles.push(t);
				}
			}
		}
		// neighbour table: the Dijkstra crosses tile borders 8 ways per cell and must not hash for it
		this.backNb.clear();
		for (const t of this.backTiles) {
			for (let oy = -1; oy <= 1; oy++) {
				for (let ox = -1; ox <= 1; ox++) {
					const nb = this.lookup(t.tx + ox, t.ty + oy);
					this.backNb.push(nb !== undefined && nb.backGen === gen ? nb.backIdx : -1);
				}
			}
		}
		for (const t of this.backTiles) {
			this.ensureGrid(world, t);
			this.release(t.bDist);
			this.release(t.bOwner);
			t.bDist = this.acquire(INF);
			t.bOwner = this.acquire(-1);
		}
		for (const b of this.buckets) b.clear();
		this.pending = 0;
		this.bD = 0;
		this.cellsExpanded = 0;
		this.building = true;
		for (const s of sources) {
			const gcx = math.floor(s.x / CELL);
			const gcy = math.floor(s.y / CELL);
			const tx = math.floor(gcx / TILE);
			const ty = math.floor(gcy / TILE);
			const t = this.lookup(tx, ty);
			if (t === undefined || t.backGen !== gen) continue;
			const lx = gcx - tx * TILE;
			const ly = gcy - ty * TILE;
			const cellIx = ly * TILE + lx;
			this.seed(t, cellIx, s.seed, s.index);
			// a survivor may stand in a cell that touches a wall: also seed the walkable cells around
			if (t.grid[cellIx] !== FREE) {
				for (let k = 0; k < 8; k++) {
					const nb = this.resolveBack(t.backIdx, gcx + NX[k], gcy + NY[k]);
					if (nb < 0) continue;
					const nt = this.backTiles[math.floor(nb / TILE_CELLS)];
					const nl = nb % TILE_CELLS;
					if (nt.grid[nl] !== HARD) this.seed(nt, nl, s.seed + COST_ORTHO, s.index);
				}
			}
		}
	}

	/** global cell → packed id inside the BACK set, using the neighbour table (-1 outside) */
	private resolveBack(ti: number, gcx: number, gcy: number): number {
		const t = this.backTiles[ti];
		const tx = math.floor(gcx / TILE);
		const ty = math.floor(gcy / TILE);
		const ox = tx - t.tx;
		const oy = ty - t.ty;
		if (ox < -1 || ox > 1 || oy < -1 || oy > 1) return -1;
		const nb = this.backNb[ti * 9 + (oy + 1) * 3 + (ox + 1)];
		if (nb < 0) return -1;
		return nb * TILE_CELLS + (gcy - ty * TILE) * TILE + (gcx - tx * TILE);
	}

	/** same, in the FRONT set (queries) */
	private resolveFront(ti: number, gcx: number, gcy: number): number {
		const t = this.frontTiles[ti];
		const tx = math.floor(gcx / TILE);
		const ty = math.floor(gcy / TILE);
		const ox = tx - t.tx;
		const oy = ty - t.ty;
		if (ox < -1 || ox > 1 || oy < -1 || oy > 1) return -1;
		const nb = this.frontNb[ti * 9 + (oy + 1) * 3 + (ox + 1)];
		if (nb < 0) return -1;
		return nb * TILE_CELLS + (gcy - ty * TILE) * TILE + (gcx - tx * TILE);
	}

	/**
	 * Expand up to `budget` cells of the pending rebuild. Returns true when the new field is complete (it then
	 * becomes the one queries read). §3.2 budgets ~2 ms of this per tick.
	 *
	 * The inner loop has two paths because the expensive part of a tiled grid is not the maths, it is finding
	 * out WHICH tile a neighbour is in. 196 of every 256 cells are interior (not on a tile edge), and for
	 * those all eight neighbours live in the same tile at a fixed offset — no division, no lookup, no packing.
	 * Only the rim pays the general path.
	 */
	step(budget: number): boolean {
		if (!this.building) return false;
		const buckets = this.buckets;
		const tiles = this.backTiles;
		let work = 0;
		let d = this.bD;
		while (this.pending > 0 && work < budget) {
			const bucket = buckets[d % BUCKETS];
			if (bucket.size() === 0) {
				d += 1;
				continue;
			}
			const c = bucket.pop() as number;
			this.pending -= 1;
			const ti = (c - (c % TILE_CELLS)) / TILE_CELLS;
			const cellIx = c % TILE_CELLS;
			const t = tiles[ti];
			const dist = t.bDist as Array<number>;
			if (dist[cellIx] !== d) continue;
			work += 1;
			const owner = (t.bOwner as Array<number>)[cellIx];
			const lx = cellIx % TILE;
			const ly = (cellIx - lx) / TILE;
			const grid = t.grid;
			const bOwner = t.bOwner as Array<number>;
			if (lx > 0 && lx < TILE - 1 && ly > 0 && ly < TILE - 1) {
				// interior: every neighbour is this tile's own cell, at cellIx + dx + dy * TILE
				const base = ti * TILE_CELLS;
				for (let k = 0; k < 8; k++) {
					const nl = cellIx + NX[k] + NY[k] * TILE;
					const g = grid[nl];
					if (g === HARD) continue;
					let cost = COST_ORTHO;
					if (k >= 4) {
						// no corner cutting through a wall joint
						if (grid[cellIx + NX[k]] === HARD || grid[cellIx + NY[k] * TILE] === HARD) continue;
						cost = COST_DIAG;
					}
					if (g === SOFT) cost += COST_SOFT;
					else if (g === VAULT) cost += WINDOW_COST;
					const nd = d + cost;
					if (nd < dist[nl]) {
						dist[nl] = nd;
						bOwner[nl] = owner;
						buckets[nd % BUCKETS].push(base + nl);
						this.pending += 1;
					}
				}
				continue;
			}
			const gcx = t.tx * TILE + lx;
			const gcy = t.ty * TILE + ly;
			for (let k = 0; k < 8; k++) {
				const ni = this.resolveBack(ti, gcx + NX[k], gcy + NY[k]);
				if (ni < 0) continue;
				const nl = ni % TILE_CELLS;
				const nt = tiles[(ni - nl) / TILE_CELLS];
				const g = nt.grid[nl];
				if (g === HARD) continue;
				let cost = COST_ORTHO;
				if (k >= 4) {
					const sideA = this.resolveBack(ti, gcx + NX[k], gcy);
					const sideB = this.resolveBack(ti, gcx, gcy + NY[k]);
					if (sideA < 0 || sideB < 0) continue;
					const sa = sideA % TILE_CELLS;
					const sb = sideB % TILE_CELLS;
					if (tiles[(sideA - sa) / TILE_CELLS].grid[sa] === HARD) continue;
					if (tiles[(sideB - sb) / TILE_CELLS].grid[sb] === HARD) continue;
					cost = COST_DIAG;
				}
				if (g === SOFT) cost += COST_SOFT;
				else if (g === VAULT) cost += WINDOW_COST;
				const nd = d + cost;
				const ndist = nt.bDist as Array<number>;
				if (nd < ndist[nl]) {
					ndist[nl] = nd;
					(nt.bOwner as Array<number>)[nl] = owner;
					buckets[nd % BUCKETS].push(ni);
					this.pending += 1;
				}
			}
		}
		this.bD = d;
		this.cellsExpanded += work;
		if (this.pending > 0) return false;
		this.swap();
		return true;
	}

	/** the back buffers become the field every query reads */
	private swap(): void {
		const gen = this.backGen;
		// tiles that leave the active set give their buffers back
		for (const t of this.frontTiles) {
			if (t.backGen === gen) continue;
			this.release(t.dist);
			this.release(t.owner);
			t.dist = undefined;
			t.owner = undefined;
			t.frontIdx = -1;
		}
		for (const t of this.backTiles) {
			this.release(t.dist);
			this.release(t.owner);
			t.dist = t.bDist;
			t.owner = t.bOwner;
			t.bDist = undefined;
			t.bOwner = undefined;
			t.frontIdx = t.backIdx;
			t.frontGen = gen;
		}
		const tiles = this.frontTiles;
		this.frontTiles = this.backTiles;
		this.backTiles = tiles;
		const nb = this.frontNb;
		this.frontNb = this.backNb;
		this.backNb = nb;
		this.frontGen = gen;
		this.lastCells = this.cellsExpanded;
		this.lastTiles = this.frontTiles.size();
		this.valid = true;
		this.building = false;
	}

	/** synchronous rebuild (tests, and the very first field of a world) */
	rebuild(world: WorldData, sources: ReadonlyArray<FlowSource>): void {
		this.startRebuild(world, sources);
		this.step(1e9);
	}

	// ---------------------------------------------------------------- queries

	/** the front-set cell holding this world point, or -1 */
	private cellAt(x: number, y: number): number {
		if (!this.valid) return -1;
		const gcx = math.floor(x / CELL);
		const gcy = math.floor(y / CELL);
		const t = this.lookup(math.floor(gcx / TILE), math.floor(gcy / TILE));
		if (t === undefined || t.frontGen !== this.frontGen || t.dist === undefined) return -1;
		return t.frontIdx * TILE_CELLS + (gcy - t.ty * TILE) * TILE + (gcx - t.tx * TILE);
	}

	/** is this world point inside the complete field? */
	contains(x: number, y: number): boolean {
		return this.cellAt(x, y) >= 0;
	}

	/** path distance (in cells) to the nearest survivor, huge when outside or unreachable */
	pathCells(x: number, y: number): number {
		const c = this.cellAt(x, y);
		if (c < 0) return INF;
		const t = this.frontTiles[math.floor(c / TILE_CELLS)];
		return (t.dist as Array<number>)[c % TILE_CELLS] / COST_ORTHO;
	}

	/** §3.3: the survivor this cell routes to — "the nearest one along a real path" — or -1 */
	targetOf(x: number, y: number): number {
		const c = this.cellAt(x, y);
		if (c < 0) return -1;
		const t = this.frontTiles[math.floor(c / TILE_CELLS)];
		const d = (t.dist as Array<number>)[c % TILE_CELLS];
		if (d >= INF) return -1;
		return (t.owner as Array<number>)[c % TILE_CELLS];
	}

	private distOf(c: number): number {
		const t = this.frontTiles[math.floor(c / TILE_CELLS)];
		return (t.dist as Array<number>)[c % TILE_CELLS];
	}

	private gridOf(c: number): number {
		const t = this.frontTiles[math.floor(c / TILE_CELLS)];
		return t.grid[c % TILE_CELLS];
	}

	private centerX(c: number): number {
		const t = this.frontTiles[math.floor(c / TILE_CELLS)];
		const cellIx = c % TILE_CELLS;
		return t.ox + (cellIx % TILE) * CELL + CELL / 2;
	}

	private centerY(c: number): number {
		const t = this.frontTiles[math.floor(c / TILE_CELLS)];
		const cellIx = c % TILE_CELLS;
		return t.oy + math.floor(cellIx / TILE) * CELL + CELL / 2;
	}

	/** lowest-distance walkable neighbour of cell c (undefined when c is a cellIx minimum) */
	private downhill(c: number): number | undefined {
		const ti = math.floor(c / TILE_CELLS);
		const t = this.frontTiles[ti];
		const cellIx = c % TILE_CELLS;
		const lx = cellIx % TILE;
		const ly = (cellIx - lx) / TILE;
		const gcx = t.tx * TILE + lx;
		const gcy = t.ty * TILE + ly;
		let best = this.distOf(c);
		let bestI: number | undefined;
		for (let k = 0; k < 8; k++) {
			const ni = this.resolveFront(ti, gcx + NX[k], gcy + NY[k]);
			if (ni < 0) continue;
			if (this.gridOf(ni) === HARD) continue;
			if (k >= 4) {
				const a = this.resolveFront(ti, gcx + NX[k], gcy);
				const b = this.resolveFront(ti, gcx, gcy + NY[k]);
				if (a < 0 || b < 0 || this.gridOf(a) === HARD || this.gridOf(b) === HARD) continue;
			}
			const nd = this.distOf(ni);
			if (nd < best) {
				best = nd;
				bestI = ni;
			}
		}
		return bestI;
	}

	/** straight segment between two points crosses no HARD cell of the field */
	private lineFree(from: number, x0: number, y0: number, x1: number, y1: number): boolean {
		const dx = x1 - x0;
		const dy = y1 - y0;
		const d = math.sqrt(dx * dx + dy * dy);
		const steps = math.max(1, math.ceil(d / (CELL * 0.5)));
		const ti = math.floor(from / TILE_CELLS);
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			const c = this.resolveFront(ti, math.floor((x0 + dx * t) / CELL), math.floor((y0 + dy * t) / CELL));
			if (c < 0 || this.gridOf(c) === HARD) return false;
		}
		return true;
	}

	/**
	 * Heading (radians) a body at (x, y) should walk to follow the field, or undefined when the point is
	 * outside, unreachable, or already on a source. Follows the gradient a few cells ahead and aims at the
	 * farthest one in plain sight, so paths are smooth instead of 8-directional.
	 */
	heading(x: number, y: number): number | undefined {
		const c = this.cellAt(x, y);
		if (c < 0) return undefined;
		let cur = c;
		if (this.distOf(cur) >= INF) {
			const nb = this.downhill(cur);
			if (nb === undefined || this.distOf(nb) >= INF) return undefined;
			return math.atan2(this.centerY(nb) - y, this.centerX(nb) - x);
		}
		if (this.distOf(cur) === 0) return undefined;
		let aim: number | undefined;
		let first: number | undefined;
		for (let step = 0; step < 4; step++) {
			const nb = this.downhill(cur);
			if (nb === undefined) break;
			cur = nb;
			if (first === undefined) first = nb;
			if (this.lineFree(c, x, y, this.centerX(cur), this.centerY(cur))) {
				aim = cur;
			} else {
				break;
			}
			if (this.distOf(cur) === 0) break;
		}
		const target = aim ?? first;
		if (target === undefined) return undefined;
		return math.atan2(this.centerY(target) - y, this.centerX(target) - x);
	}

	/** tiles held in memory (the cache keeps the static layer of every tile ever walked) */
	cachedTiles(): number {
		return this.tiles.size();
	}
}
