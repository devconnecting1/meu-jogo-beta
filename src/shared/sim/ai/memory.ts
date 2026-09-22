/*
 * Zombie memory and investigation (docs/DESIGN_RULES.md P2).
 *
 * The original has none of this. `detect` is a boolean that, once on, homes on `obj_player.x/y` live and for
 * ever: the only thing that ever clears it is the 7:00 sweep in sys_spawn_time_light (and wave zombies are not
 * even in that sweep). Break line of sight, hide behind a house, leave the city — it still walks straight at
 * where you are RIGHT NOW, through a wall it cannot see through.
 *
 * Here a zombie chases what it perceives and remembers where it last perceived it. Lose it and the zombie
 * runs to that spot, circles around it for a few seconds looking (moving, not standing), and only then goes
 * back to wandering. Noise, a shout from another zombie and being shot all write into the same memory, so a
 * zombie always walks to a PLACE it has a reason to believe in, never to a position it could not know.
 *
 * Pure: state in, action out. Moves to server/sim with the AI (docs/MULTIPLAYER.md §11.2).
 */

/** the fields of ZombieState this module owns (structural: ZombieState satisfies it) */
export interface ZombieMemory {
	detect: boolean;
	/** last position where the target was actually perceived (or credibly reported) */
	lastSeenX?: number;
	lastSeenY?: number;
	/** seconds since the target was last perceived */
	lostFor?: number;
	/** seconds left of the search around the last known position (undefined = not searching yet) */
	searchTimer?: number;
}

/** after losing the target the zombie keeps closing in for this long (momentum; no doorway stutter) */
export const LOST_GRACE = 0.7;
/** seconds spent looking around the last known position before giving up */
export const SEARCH_TIME = 5;
/** "I am at the last known position" */
export const SEARCH_ARRIVE = 80;
/** how wide the search circles around the last known position */
export const SEARCH_RADIUS = 170;
/** how fast the search point sweeps around it (rad/s) */
export const SEARCH_SPIN = 1.7;
/** a zombie shot from out of sight turns and walks this far towards whoever shot it */
export const SHOT_MEMORY = 300;

export type MindAction =
	/** the target is perceived right now: hunt the live position */
	| "chase"
	/** walk to the last known position */
	| "goto"
	/** sweep around the last known position */
	| "search"
	/** nothing left to follow: back to wandering */
	| "idle";

/** the target was perceived at (x, y) */
export function see(m: ZombieMemory, x: number, y: number): void {
	m.detect = true;
	m.lastSeenX = x;
	m.lastSeenY = y;
	m.lostFor = 0;
	m.searchTimer = undefined;
}

/**
 * The zombie has a REASON to believe the target is at (x, y) — a noise ring, another zombie's shout, the
 * direction a bullet came from — but has not perceived it. It hunts that place, not the survivor.
 * An already-hunting zombie keeps the fresher memory it has.
 */
export function report(m: ZombieMemory, x: number, y: number): void {
	if (m.detect && (m.lostFor ?? 0) <= LOST_GRACE) return;
	m.detect = true;
	m.lastSeenX = x;
	m.lastSeenY = y;
	m.lostFor = LOST_GRACE;
	m.searchTimer = undefined;
}

/** forget everything and go back to wandering (7:00, leash, end of a search) */
export function forget(m: ZombieMemory): void {
	m.detect = false;
	m.lastSeenX = undefined;
	m.lastSeenY = undefined;
	m.lostFor = undefined;
	m.searchTimer = undefined;
}

/**
 * One AI step of the memory. `perceived`: the senses have the target right now, at (tx, ty).
 * (zx, zy) is where the zombie stands. Returns what the body should do.
 */
export function think(
	m: ZombieMemory,
	dt: number,
	perceived: boolean,
	tx: number,
	ty: number,
	zx: number,
	zy: number,
): MindAction {
	if (perceived) {
		see(m, tx, ty);
		return "chase";
	}
	if (!m.detect) return "idle";
	m.lostFor = (m.lostFor ?? 0) + dt;
	// momentum: it does not stop the instant a doorway cuts the line
	if ((m.lostFor ?? 0) < LOST_GRACE) return "chase";
	const lx = m.lastSeenX;
	const ly = m.lastSeenY;
	if (lx === undefined || ly === undefined) {
		// hunting with nothing remembered: a night-wave zombie, which in the original knows where you are
		// and never stops knowing. Kept as it was — the waves are supposed to be a tide, not a search party.
		return "chase";
	}
	if (m.searchTimer === undefined) {
		const dx = lx - zx;
		const dy = ly - zy;
		if (dx * dx + dy * dy > SEARCH_ARRIVE * SEARCH_ARRIVE) return "goto";
		m.searchTimer = SEARCH_TIME;
		return "search";
	}
	m.searchTimer = m.searchTimer - dt;
	if ((m.searchTimer ?? 0) <= 0) {
		forget(m);
		return "idle";
	}
	return "search";
}

/** how far into the search we are, 0 → 1 (0 while walking to the spot) */
export function searchProgress(m: ZombieMemory): number {
	const t = m.searchTimer;
	if (t === undefined) return 0;
	return math.clamp(1 - t / SEARCH_TIME, 0, 1);
}

/**
 * Where a searching zombie walks: a point sweeping around the last known position, widening as the search
 * goes on. `phase` (a per-zombie constant, e.g. id × 2.399) sends neighbours around different arcs, so a
 * group that lost the survivor fans out instead of piling on one spot.
 */
export function searchPointX(m: ZombieMemory, phase: number): number {
	const p = searchProgress(m);
	return (m.lastSeenX ?? 0) + math.cos(phase + p * SEARCH_TIME * SEARCH_SPIN) * SEARCH_RADIUS * (0.35 + 0.65 * p);
}

export function searchPointY(m: ZombieMemory, phase: number): number {
	const p = searchProgress(m);
	return (m.lastSeenY ?? 0) + math.sin(phase + p * SEARCH_TIME * SEARCH_SPIN) * SEARCH_RADIUS * (0.35 + 0.65 * p);
}
