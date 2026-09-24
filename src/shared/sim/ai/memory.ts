//!native
/*
 * Zombie memory, investigation and the awareness state the players see (docs/DESIGN_RULES.md IA-03, P2).
 *
 * The original has none of this. `detect` is a boolean that, once on, homes on `obj_player.x/y` live and for
 * ever: the only thing that ever clears it is the 7:00 sweep in sys_spawn_time_light (and wave zombies are not
 * even in that sweep). Break line of sight, hide behind a house, leave the city — it still walks straight at
 * where you are RIGHT NOW, through a wall it cannot see through.
 *
 * Here a zombie is in one of four states, decided on the server and shown to every player (the awareness
 * marks, client/view/zombieAwareness.ts):
 *
 *   IDLE        shambles about (wander): nothing to follow.
 *   SUSPICIOUS  heard something, was told by a shout, was shot from out of sight or caught a glimpse at the
 *               edge of its eyes: it walks to that PLACE — never to where the survivor is now.
 *   SEARCHING   it reached the place and found nothing: a few short hops around it, stopping to look each time
 *               (a zombie that stands still and turns is a zombie whose eye cone sweeps the street), then it
 *               gives up and goes back to wandering.
 *   CHASING     it SEES the survivor (or touches them, or is a night-wave zombie): it hunts the live position.
 *               Lose it and it keeps closing in for LOST_GRACE (no doorway stutter), then it walks to where it
 *               last saw you and searches there — not instant omniscience.
 *
 * Noise, a shout from another zombie and being shot all write into the same memory, so a zombie always walks to
 * a place it has a reason to believe in.
 *
 * Pure: state in, action out. Moves to server/sim with the AI (docs/MULTIPLAYER.md §11.2).
 */

/** the four states the players see; 2 bits on the wire (docs/MULTIPLAYER.md §4.2) */
export const Aware = {
	Idle: 0,
	Suspicious: 1,
	Searching: 2,
	Chasing: 3,
} as const;
export type Aware = (typeof Aware)[keyof typeof Aware];
export const AWARE_MAX = 3;

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
	/**
	 * Walking to the last known position: the closest it has got, and for how long it has not got closer. A place
	 * it cannot reach (the other side of a long wall) is searched from where it got stuck.
	 */
	gotoBest?: number;
	gotoT?: number;
	/** the search: which hop, seconds spent on this hop, seconds left of the look-around at its end */
	searchHop?: number;
	hopT?: number;
	lookT?: number;
}

/** after losing the target the zombie keeps closing in for this long (momentum; no doorway stutter) */
export const LOST_GRACE = 0.7;
/**
 * A suspicious zombie that has not got GOTO_PROGRESS closer to its place for GOTO_STALL seconds cannot get there
 * (a long wall, a locked door): it searches from where it got stuck instead of grinding the wall.
 */
export const GOTO_STALL = 2.5;
export const GOTO_PROGRESS = 20;
/** seconds spent looking around the last known position before giving up */
export const SEARCH_TIME = 8;
/** "I am at the last known position" */
export const SEARCH_ARRIVE = 80;
/** how far from the last known position the search hops reach (widening with each hop) */
export const SEARCH_RADIUS = 180;
/** one hop is over when it gets this close to its point, or after HOP_MAX seconds */
export const HOP_ARRIVE = 30;
export const HOP_MAX = 2.2;
/** seconds it stands looking around at the end of a hop */
export const LOOK_MIN = 0.6;
export const LOOK_MAX = 1.2;
/** how wide it turns its head while looking (radians either side) */
export const LOOK_SWEEP = 1.3;
/** a zombie shot from out of sight turns and walks this far towards whoever shot it */
export const SHOT_MEMORY = 300;
/** the golden angle: consecutive hops (and neighbours' hops) never go the same way */
const GOLDEN = 2.399;

export type MindAction =
	/** the target is perceived right now: hunt the live position */
	| "chase"
	/** walk to the last known position */
	| "goto"
	/** hop and look around the last known position */
	| "search"
	/** nothing left to follow: back to wandering */
	| "idle";

/** the state the players are shown for what the body is doing */
export function awareOf(action: MindAction): Aware {
	if (action === "chase") return Aware.Chasing;
	if (action === "goto") return Aware.Suspicious;
	if (action === "search") return Aware.Searching;
	return Aware.Idle;
}

function clearSearch(m: ZombieMemory): void {
	m.searchTimer = undefined;
	m.searchHop = undefined;
	m.hopT = undefined;
	m.lookT = undefined;
	m.gotoT = undefined;
	m.gotoBest = undefined;
}

/** the target was perceived at (x, y) */
export function see(m: ZombieMemory, x: number, y: number): void {
	m.detect = true;
	m.lastSeenX = x;
	m.lastSeenY = y;
	m.lostFor = 0;
	clearSearch(m);
}

/** is it hunting a target it perceives (or perceived less than LOST_GRACE ago)? */
export function chasing(m: ZombieMemory): boolean {
	return m.detect && (m.lostFor ?? 0) < LOST_GRACE;
}

/**
 * The zombie has a REASON to believe the target is at (x, y) — a noise ring, another zombie's shout, the
 * direction a bullet came from, a glimpse at the edge of its eyes — but has not perceived it. It walks to that
 * place (suspicious), not to the survivor. An already-hunting zombie keeps the fresher memory it has; a
 * suspicious or searching one takes the newer place.
 */
export function report(m: ZombieMemory, x: number, y: number): void {
	// `<`, as in `chasing`: a report leaves lostFor AT the grace, and a second one in the same tick (a glimpse and a
	// noise) must still be taken, not mistaken for a chase
	if (m.detect && (m.lostFor ?? 0) < LOST_GRACE) return;
	const lx = m.lastSeenX;
	const ly = m.lastSeenY;
	// the same place again while walking there (a noise repeated, a glimpse held) keeps the walk's progress, so a
	// place it cannot reach is still given up on after GOTO_STALL instead of being renewed for ever
	const same =
		m.detect &&
		m.searchTimer === undefined &&
		lx !== undefined &&
		ly !== undefined &&
		(lx - x) * (lx - x) + (ly - y) * (ly - y) <= SEARCH_ARRIVE * SEARCH_ARRIVE;
	m.detect = true;
	m.lastSeenX = x;
	m.lastSeenY = y;
	m.lostFor = LOST_GRACE;
	if (!same) clearSearch(m);
}

/** forget everything and go back to wandering (7:00, leash, end of a search) */
export function forget(m: ZombieMemory): void {
	m.detect = false;
	m.lastSeenX = undefined;
	m.lastSeenY = undefined;
	m.lostFor = undefined;
	clearSearch(m);
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
		// hunting with nothing remembered: a zombie told to hunt with no place to go (an admin spawn, a legacy
		// path). It keeps hunting, like the original, until something gives it a place or the morning clears it.
		return "chase";
	}
	if (m.searchTimer === undefined) {
		const dx = lx - zx;
		const dy = ly - zy;
		const d = math.sqrt(dx * dx + dy * dy);
		const best = m.gotoBest;
		if (best === undefined || d < best - GOTO_PROGRESS) {
			m.gotoBest = d;
			m.gotoT = 0;
		} else {
			m.gotoT = (m.gotoT ?? 0) + dt;
		}
		if (d > SEARCH_ARRIVE && (m.gotoT ?? 0) < GOTO_STALL) return "goto";
		m.searchTimer = SEARCH_TIME;
		m.searchHop = 0;
		m.hopT = 0;
		m.lookT = 0;
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

/** the point of hop `hop` around the last known position; `phase` is a per-zombie constant */
function hopAngle(hop: number, phase: number): number {
	return phase + hop * GOLDEN;
}

function hopRadius(hop: number): number {
	return SEARCH_RADIUS * math.min(1, 0.35 + 0.3 * hop);
}

export function searchPointX(m: ZombieMemory, phase: number): number {
	const hop = m.searchHop ?? 0;
	return (m.lastSeenX ?? 0) + math.cos(hopAngle(hop, phase)) * hopRadius(hop);
}

export function searchPointY(m: ZombieMemory, phase: number): number {
	const hop = m.searchHop ?? 0;
	return (m.lastSeenY ?? 0) + math.sin(hopAngle(hop, phase)) * hopRadius(hop);
}

/**
 * One step of the search: hop to a point around the last known position, then stand and look around for a
 * moment, then the next hop — each one somewhere else (the golden angle) and a little wider. Returns true while
 * it should walk to (searchPointX, searchPointY), false while it stands looking (`lookAngle`).
 */
export function searchWalk(m: ZombieMemory, phase: number, dt: number, zx: number, zy: number): boolean {
	const look = m.lookT ?? 0;
	if (look > 0) {
		m.lookT = look - dt;
		if ((m.lookT ?? 0) <= 0) {
			m.lookT = 0;
			m.searchHop = (m.searchHop ?? 0) + 1;
			m.hopT = 0;
		}
		return false;
	}
	m.hopT = (m.hopT ?? 0) + dt;
	const dx = searchPointX(m, phase) - zx;
	const dy = searchPointY(m, phase) - zy;
	if (dx * dx + dy * dy < HOP_ARRIVE * HOP_ARRIVE || (m.hopT ?? 0) >= HOP_MAX) {
		// deterministic per zombie and hop: no random draw, so the search replays the same on every run
		const k = (((m.searchHop ?? 0) + 1) * 0.618 + phase * 0.31) % 1;
		m.lookT = LOOK_MIN + (LOOK_MAX - LOOK_MIN) * k;
		return false;
	}
	return true;
}

/** where a zombie standing still in the search is looking: outwards from the spot, sweeping side to side */
export function lookAngle(m: ZombieMemory, phase: number): number {
	const hop = m.searchHop ?? 0;
	return hopAngle(hop, phase) + math.sin((m.lookT ?? 0) * 4 + phase) * LOOK_SWEEP;
}
