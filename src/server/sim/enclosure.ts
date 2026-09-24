/*
 * "Would this construction box somebody in?" (docs/DESIGN_RULES.md MP-24, docs/MULTIPLAYER.md §8.1 `place`).
 *
 * A survivor cannot take down a construction (MP-11: only the horde damages them), and bodies do not block bodies
 * (MP-02) precisely so that nobody can pen an ally in. A wall could: a ring of barricades closed around somebody
 * else is a cell they cannot leave until the horde chews its way in -- and closed around the builder with no door,
 * it is a soft lock, since there is no taking one's own wall down either. So the server refuses the piece that
 * would CLOSE such a ring: after it, some living survivor who could walk ESCAPE_RANGE away before it could not.
 *
 * "Walk" is the survivors' own collision (a body of PLAYER_RADIUS against every blocking solid), with two
 * differences that both make a ring legal: a door -- built, or of a building -- is a way out whether it is open
 * or not (anybody opens a door; MP-11's lock is not built), and a window is a way out whether its glass is in or not
 * (EDI-10, EDI-18: anybody breaks a pane with E). A
 * base with a door in it is a base, not a cell. A yard wider than twice ESCAPE_RANGE is not a box either: its
 * survivors can walk, and the horde gets in the way it always does. That is an ACCEPTED limit (MP-24, the security
 * review of the net hardening, L3): a 1200 u yard closed around somebody is still a pen, but a big one -- ground
 * others walk into and out of, that the rot of MP-24 opens -- and a flood wide enough to see it would cost several
 * times this one on every checked placement.
 *
 * The walk is a flood over the body positions of a lattice of LATTICE u around the survivor. Two neighbouring
 * lattice points that both have room for a body can never have a wall between them (LATTICE < 2 × radius), so the
 * flood never leaks through one; a passage narrower than LATTICE + a body may read as closed, which refuses a
 * placement rather than allowing a cell (every window of the map is 80 u and every doorway wider). Only survivors
 * whose flood square the new piece reaches are walked, and only when the piece touches something else that blocks:
 * a piece standing alone closes nothing.
 *
 * The check costs a flood per survivor in reach, so the server runs at most a few a tick (server/sim/build.ts
 * SEALED_CHECKS_PER_TICK, `needsFlood` tells which placements need one); the others answer "rate".
 *
 * Pure module: no Instances, no services.
 */
import { PLAYER_RADIUS } from "shared/game/physics";
import type { PlayerState } from "shared/game/player";
import { isBlocking, querySolids, Solid, WorldData } from "shared/game/world";
import { isWindow } from "shared/game/windows";
import { isDoor } from "shared/sim/interactQuery";
import { PlaceRect, rectCircleOverlap } from "shared/sim/placement";

/** a survivor who can walk this far from where they stand is not boxed in */
export const ESCAPE_RANGE = 512;
/** the flood's lattice step: under a body's diameter, so two free neighbours never have a wall between them */
export const LATTICE = 32;
/**
 * The body the flood walks: exactly the survivors' own. One unit narrower (as it was) let a 35 u sliver read as a way
 * out that no body of 36 u fits through (the security review of the net hardening, L2).
 */
const BODY = PLAYER_RADIUS;
const SPAN = math.ceil(ESCAPE_RANGE / LATTICE);
/** lattice points per side of the flood square */
const SIDE = SPAN * 2 + 1;

const scratch = new Array<Solid>();
/** per lattice point: the flood's stamp when it was reached (a number per point, never cleared: the stamp moves) */
const seen = new Array<number>();
/** per lattice point: the stamp when its room for a body was measured, and the answer */
const measured = new Array<number>();
const free = new Array<boolean>();
const queue = new Array<number>();
let stamp = 0;
for (let i = 0; i < SIDE * SIDE; i++) {
	seen.push(0);
	measured.push(0);
	free.push(false);
}

/** a body at (x, y) touches something a survivor cannot walk through (a door is a way out; so is `extra` absent) */
function bodyBlocked(world: WorldData, x: number, y: number, extra: PlaceRect | undefined): boolean {
	if (extra !== undefined && rectCircleOverlap(extra.x, extra.y, extra.w, extra.h, x, y, BODY)) return true;
	if (x < BODY || y < BODY || x > world.width - BODY || y > world.height - BODY) return true;
	scratch.clear();
	querySolids(world, x - BODY, y - BODY, x + BODY, y + BODY, scratch);
	for (const s of scratch) {
		if (!isBlocking(s) || isDoor(s) || isWindow(s)) continue;
		if (rectCircleOverlap(s.x, s.y, s.w, s.h, x, y, BODY)) return true;
	}
	scratch.clear();
	return false;
}

/**
 * Can a survivor standing at (x0, y0) walk ESCAPE_RANGE away (to the edge of the flood square), with `extra` in the
 * world as a blocking rect? The point they stand on counts as free: they are standing there.
 */
export function canEscape(world: WorldData, x0: number, y0: number, extra?: PlaceRect): boolean {
	stamp += 1;
	const s = stamp;
	const ox = x0 - SPAN * LATTICE;
	const oy = y0 - SPAN * LATTICE;
	const start = SPAN * SIDE + SPAN;
	queue.clear();
	queue.push(start);
	seen[start] = s;
	let head = 0;
	while (head < queue.size()) {
		const at = queue[head];
		head += 1;
		const col = at % SIDE;
		const row = (at - col) / SIDE;
		if (col === 0 || row === 0 || col === SIDE - 1 || row === SIDE - 1) return true;
		for (let k = 0; k < 4; k++) {
			const nc = k === 0 ? col + 1 : k === 1 ? col - 1 : col;
			const nr = k === 2 ? row + 1 : k === 3 ? row - 1 : row;
			const ni = nr * SIDE + nc;
			if (seen[ni] === s) continue;
			seen[ni] = s;
			if (measured[ni] !== s) {
				measured[ni] = s;
				free[ni] = !bodyBlocked(world, ox + nc * LATTICE, oy + nr * LATTICE, extra);
			}
			if (free[ni]) queue.push(ni);
		}
	}
	return false;
}

/**
 * Does the rect come near enough anything else a survivor cannot walk through to close a gap with it: nearer than a
 * body's width, plus one (a gap of exactly 2 × PLAYER_RADIUS is the narrowest a body still passes)?
 */
function touchesAnything(world: WorldData, r: PlaceRect): boolean {
	const pad = PLAYER_RADIUS * 2 + 1;
	scratch.clear();
	querySolids(world, r.x - pad, r.y - pad, r.x + r.w + pad, r.y + r.h + pad, scratch);
	for (const s of scratch) {
		if (isBlocking(s) && !isDoor(s) && !isWindow(s)) {
			scratch.clear();
			return true;
		}
	}
	scratch.clear();
	return r.x < pad || r.y < pad || r.x + r.w > world.width - pad || r.y + r.h > world.height - pad;
}

/**
 * The living survivor a construction at `r` would box in, or undefined. `blocks` false (a door, a parked vehicle)
 * never boxes anybody in. A survivor who could not walk away before this piece either (penned by the map, or by
 * something built before this rule) is not the piece's doing, and does not stop it.
 */
export function boxesIn(
	world: WorldData,
	r: PlaceRect,
	blocks: boolean,
	bodies: ReadonlyArray<PlayerState>,
): PlayerState | undefined {
	if (!needsFlood(world, r, blocks, bodies)) return undefined;
	for (const p of bodies) {
		if (!inReach(r, p)) continue;
		if (canEscape(world, p.x, p.y, r)) continue;
		if (canEscape(world, p.x, p.y)) return p;
	}
	return undefined;
}

/** the piece reaches into this living survivor's flood square: only then can it change what the flood finds */
function inReach(r: PlaceRect, p: PlayerState): boolean {
	if (p.dead) return false;
	const reach = SPAN * LATTICE + BODY;
	return !(r.x > p.x + reach || r.x + r.w < p.x - reach || r.y > p.y + reach || r.y + r.h < p.y - reach);
}

/**
 * Would `boxesIn` walk anybody's flood for this piece? False for what cannot close anything (a door, a trap, a piece
 * standing alone) and for a piece nobody is near: those are free, and never count against the server's budget.
 */
export function needsFlood(
	world: WorldData,
	r: PlaceRect,
	blocks: boolean,
	bodies: ReadonlyArray<PlayerState>,
): boolean {
	if (!blocks) return false;
	let near = false;
	for (const p of bodies) {
		if (inReach(r, p)) {
			near = true;
			break;
		}
	}
	return near && touchesAnything(world, r);
}
