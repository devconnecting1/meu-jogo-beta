import { angleDiff } from "shared/engine/vec2";

/*
 * Zombie senses (docs/MULTIPLAYER.md §3.4, docs/DESIGN_RULES.md P2 "melhor que o original").
 *
 * The original has no eyes: `obj_zombie` Step "///detect" turns a zombie hostile only when
 *   - the survivor is closer than 50 px, or
 *   - the clock says night (day_time > 19 or < 6), or
 *   - it is raining,
 * and the last two are GLOBAL: every zombie on the map flips at the same instant, at any distance.
 * There is no cone, no line of sight and no way at all to break contact once seen.
 *
 * Here the night/rain "smell" is kept exactly as it was — SMELL_RANGE is wider than the cull window, so in
 * practice the same blanket alert — and daylight gets real eyes: a range, a cone around the way the body
 * faces, and a clear line (the caller raycasts). Dusk/dawn darkness and rain shorten the range, and the
 * survivor's "Stealth" skill shortens it further, so daytime finally has counterplay.
 *
 * Pure: numbers in, numbers out. No world, no Instances, no getCtx — it travels to server/sim with the AI
 * (docs/MULTIPLAYER.md §11.2).
 */

/** light and weather the senses work in */
export interface SenseConditions {
	/** 0 = full daylight, 1 = deepest night (DayNight.darkAlpha) */
	darkness: number;
	night: boolean;
	raining: boolean;
}

export interface SenseRanges {
	/** how far a zombie can see a survivor straight ahead */
	sight: number;
	/** half-angle of the eye cone (radians) */
	cone: number;
	/** radius of the original's blanket night/rain alert (0 by day) */
	smell: number;
}

/** eyesight in full daylight (~9.5 m at 55 u/m) */
export const SIGHT_DAY = 520;
/** however dark and wet it gets, a zombie still makes out a body this close ahead of it */
export const SIGHT_MIN = 130;
/** half-angle of the eye cone: a wandering zombie watches a 120° wedge */
export const SIGHT_CONE = math.rad(60);
/** this close the cone opens up — it hears you breathing behind its shoulder */
export const SIGHT_CLOSE = 150;
export const SIGHT_CLOSE_CONE = math.rad(150);
/** fraction of the sight range left in the rain */
export const RAIN_SIGHT = 0.55;
/** fraction of the sight range lost at darkness 1 (dusk and dawn, before the smell takes over) */
export const DARK_SIGHT = 0.7;
/** "Stealth" (skill 15) also makes the survivor harder to make out, not just quieter */
export const STEALTH_SIGHT = 0.7;
/** obj_zombie: `point_distance(...) < 50` — noticed whatever the zombie is facing */
export const TOUCH_RANGE = 50;
/**
 * Night / rain smell. The original flips every zombie on the map; the spawner culls anything past
 * DESIGN.ZOMBIE_SPAWN_MAX (1080 u) from a survivor, so this radius is the same thing with a number on it.
 */
export const SMELL_RANGE = 2400;

/** how far each sense reaches under `c`; `stealthy` = the target has the Stealth skill */
export function senseRanges(c: SenseConditions, stealthy = false): SenseRanges {
	const stealth = stealthy ? STEALTH_SIGHT : 1;
	let sight = SIGHT_DAY * (1 - DARK_SIGHT * math.clamp(c.darkness, 0, 1));
	if (c.raining) sight *= RAIN_SIGHT;
	sight = math.max(SIGHT_MIN, sight) * stealth;
	return { sight, cone: SIGHT_CONE, smell: c.night || c.raining ? SMELL_RANGE : 0 };
}

/**
 * Is the target inside the eye cone (range + angle)? The LINE itself is not checked here: the caller
 * raycasts, and only when this said yes — that is what keeps the raycasts rare.
 */
export function inSightCone(dist: number, facing: number, toTarget: number, r: SenseRanges): boolean {
	if (dist > r.sight) return false;
	const half = dist < SIGHT_CLOSE ? SIGHT_CLOSE_CONE : r.cone;
	return math.abs(angleDiff(facing, toTarget)) <= half;
}

// ---------------------------------------------------------------- LOD (§3.4)

/** ≤ this from the nearest survivor: the zombie decides at 30 Hz */
export const LOD_NEAR = 800;
/** ≤ this: 15 Hz. Beyond it: 7.5 Hz, and nobody can see it, so cosmetics are skipped */
export const LOD_MID = 1600;

/** seconds between two AI decisions (steering, perception) for a zombie this far from a survivor */
export function decisionInterval(dist: number): number {
	if (dist <= LOD_NEAR) return 1 / 30;
	if (dist <= LOD_MID) return 1 / 15;
	return 1 / 7.5;
}

/** seconds between two line-of-sight rays for a zombie this far from a survivor */
export function losInterval(dist: number): number {
	if (dist <= LOD_NEAR) return 0.2;
	if (dist <= LOD_MID) return 0.5;
	return 1;
}

/** cosmetics (light/alpha, footstep noise) are pointless this far out: nobody is looking */
export function visibleToSomeone(dist: number): boolean {
	return dist <= LOD_MID;
}
