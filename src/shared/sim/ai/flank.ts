//!native
/*
 * Flanking: stop the horde from queueing at one door (docs/DESIGN_RULES.md P2, docs/MULTIPLAYER.md §3.3).
 *
 * The original walks every zombie with `mp_potential_step_object(obj_player.x, ...)`, so twenty zombies take
 * the same potential line and end up in single file at the same corner. Our flow field already routes them
 * around buildings and in through the door, which is a big improvement — but it is still ONE cheapest path,
 * so they still queue.
 *
 * The fix costs one grid lookup per probe: a coarse occupancy grid of the hunting zombies makes a crowded
 * lane EXPENSIVE. The zombie scores a handful of probe points around the flow heading by
 *   path cost to the survivor (the field already knows it, exactly) + crowd penalty + a nudge to keep going
 *   straight,
 * and walks towards the cheapest one. When the front door jams, the second entrance stops being the second
 * best route and becomes the best one, so part of the horde peels off and comes around — the base gets
 * surrounded instead of besieged at one hinge.
 *
 * Pure: a grid of counters and arithmetic on a path field the caller owns. No world, no Instances (§11.2).
 */

/** what flanking needs from the flow field (physics.FlowField satisfies it structurally) */
export interface PathField {
	/** side of one cell in world units */
	readonly cell: number;
	/** is this world point inside the complete field? */
	contains(x: number, y: number): boolean;
	/** path distance in cells from the point to the survivor; huge when unreachable */
	pathCells(x: number, y: number): number;
}

export interface Point {
	x: number;
	y: number;
}

/** how far ahead the probes look (≈ 3 flow-field cells: far enough for the costs to differ) */
export const FLANK_PROBE = 168;
/** probe offsets around the flow heading (radians) */
export const FLANK_OFFSETS: ReadonlyArray<number> = [0, 0.6, -0.6, 1.2, -1.2, 1.7, -1.7];
/** bodies allowed in a cell before it starts costing extra */
export const FLANK_FREE = 2;
/** bodies allowed in the 288 u block around a lane before that lane counts as queued up */
export const FLANK_FREE_LANE = 4;
/** path cells added per crowded body over FLANK_FREE */
export const FLANK_WEIGHT = 1.5;
/** however jammed a lane is, the detour it justifies is capped (nobody walks around the block) */
export const FLANK_MAX_PENALTY = 18;
/** cost of not going straight, per radian of deviation (keeps the normal case honest) */
export const FLANK_TURN_COST = 1.1;

/**
 * Coarse count of hunting zombies per 96 u cell, rebuilt once per tick over a window around the survivors.
 * 96 u is three bodies wide: a cell with 3+ zombies in it really is a jam, not two friends walking.
 */
export class Congestion {
	readonly cell = 96;
	readonly size = 28;
	private counts: Array<number> = [];
	private ox = 0;
	private oy = 0;

	constructor() {
		for (let i = 0; i < this.size * this.size; i++) this.counts.push(0);
	}

	/** clear the grid and centre it on (cx, cy) */
	begin(cx: number, cy: number): void {
		const half = (this.size * this.cell) / 2;
		this.ox = cx - half;
		this.oy = cy - half;
		const n = this.size * this.size;
		for (let i = 0; i < n; i++) this.counts[i] = 0;
	}

	private index(x: number, y: number): number {
		const gx = math.floor((x - this.ox) / this.cell);
		const gy = math.floor((y - this.oy) / this.cell);
		if (gx < 0 || gy < 0 || gx >= this.size || gy >= this.size) return -1;
		return gy * this.size + gx;
	}

	add(x: number, y: number): void {
		const i = this.index(x, y);
		if (i >= 0) this.counts[i] += 1;
	}

	/** bodies counted in the cell holding (x, y); 0 outside the window */
	at(x: number, y: number): number {
		const i = this.index(x, y);
		return i >= 0 ? this.counts[i] : 0;
	}

	/** is this point crowded enough to be worth looking for a way round? */
	crowded(x: number, y: number): boolean {
		return this.at(x, y) > FLANK_FREE;
	}

	/**
	 * Bodies in the 3×3 block of cells around (x, y) — a 288 u square. A queue at a doorway straddles two or
	 * three cells, so counting one cell under-reads it badly; this is what the entrance scoring uses.
	 */
	around(x: number, y: number): number {
		let n = 0;
		for (let ox = -1; ox <= 1; ox++) {
			for (let oy = -1; oy <= 1; oy++) {
				n += this.at(x + ox * this.cell, y + oy * this.cell);
			}
		}
		return n;
	}
}

/** extra path cells a lane costs because of the bodies already in it */
export function crowdPenalty(crowd: Congestion, x: number, y: number): number {
	const over = crowd.around(x, y) - FLANK_FREE_LANE;
	if (over <= 0) return 0;
	return math.min(FLANK_MAX_PENALTY, over * FLANK_WEIGHT);
}

/**
 * Heading the zombie should walk. `base` is the flow field's answer; `bias` (−1…1, a per-zombie constant)
 * only breaks ties, so two zombies in the same jam pick opposite ways round instead of the same one.
 * `free(x, y)` tells whether a body fits at a probe point. Returns `base` untouched when nothing is crowded,
 * which is the common case and costs one grid lookup.
 */
export function flankHeading(
	field: PathField,
	crowd: Congestion,
	x: number,
	y: number,
	base: number,
	bias: number,
	free: (px: number, py: number) => boolean,
): number {
	const aheadX = x + math.cos(base) * FLANK_PROBE;
	const aheadY = y + math.sin(base) * FLANK_PROBE;
	if (!crowd.crowded(aheadX, aheadY) && !crowd.crowded(x, y)) return base;
	if (!field.contains(x, y)) return base;
	let bestScore = math.huge;
	let bestDir = base;
	for (const off of FLANK_OFFSETS) {
		const a = base + off;
		const px = x + math.cos(a) * FLANK_PROBE;
		const py = y + math.sin(a) * FLANK_PROBE;
		if (!field.contains(px, py)) continue;
		const cells = field.pathCells(px, py);
		if (cells >= 1e8) continue;
		if (off !== 0 && !free(px, py)) continue;
		const score =
			cells + crowdPenalty(crowd, px, py) + math.abs(off) * FLANK_TURN_COST - bias * off * FLANK_TURN_COST;
		if (score < bestScore) {
			bestScore = score;
			bestDir = a;
		}
	}
	return bestDir;
}

// ---------------------------------------------------------------- giving up on a jammed way in

/**
 * A hunting zombie whose PATH COST has not dropped for JAM_PATIENCE seconds, with a crowd around it, is not
 * walking anywhere: it is the twelfth body in a queue at a door. It then commits to walking AROUND the
 * target for ORBIT_TIME, ignoring the field. That is all it takes: the tangent carries it past the point
 * where the flow field itself starts preferring the other entrance, and from there it walks in normally.
 *
 * This is deliberately not a waypoint system. Path cost is the one number that is exactly right (the field
 * computed it), so "am I getting closer along a real path?" is free and never lies, and a zombie that IS
 * making progress — including one chewing through a barricade — never leaves its lane.
 */
export const JAM_PATIENCE = 1.5;
/** path cells of progress that count as "still getting there" (below this it is just jostling) */
export const JAM_PROGRESS = 1.5;
/** no point walking round the building when you are already on top of them */
export const JAM_MIN_DIST = 200;
/** seconds spent circling the target before the flow field takes over again */
export const ORBIT_TIME = 6;
