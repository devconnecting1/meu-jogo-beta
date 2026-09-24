//!native
import { angleDiff } from "shared/engine/vec2";
import { isBlocking, Solid } from "shared/game/world";
import * as Light from "shared/sim/survivorLight";

/*
 * Zombie senses (docs/DESIGN_RULES.md IA-01, docs/MULTIPLAYER.md §3.4, P2 "melhor que o original").
 *
 * The original has no eyes: `obj_zombie` Step "///detect" turns a zombie hostile only when
 *   - the survivor is closer than 50 px, or
 *   - the clock says night (day_time > 19 or < 6), or
 *   - it is raining,
 * and the last two are GLOBAL: every zombie on the map flips at the same instant, at any distance.
 * There is no cone, no line of sight and no way at all to break contact once seen.
 *
 * Here every zombie has the same three senses, day and night:
 *   - EYES: a range, a cone around the way the body faces and a clear line through the world's walls. Darkness
 *     and rain shorten the range; the survivor's OWN light works the other way — a lit body in a dark street is
 *     seen from further than an unlit one, and a flashlight further still (it is a beacon: the light that lets
 *     you see is the light that gives you away). A zombie standing in a flashlight's beam sees the light
 *     whatever way it faces.
 *   - EARS: noise rings (shared/sim/ai/noise.ts): shots by weapon class, construction, breaking things, steps.
 *   - TOUCH: this close it notices you whatever it faces and whatever is in between.
 * The original's night/rain "smell" (a blanket alert over the whole map) is gone: the night waves still hunt
 * like the original (they always know where you are), the ambient horde now has to see or hear you.
 *
 * Sight is not all-or-nothing either: a survivor at the edge of the range, in the corner of the eye, is a
 * GLIMPSE — the zombie turns suspicious and walks to where it saw something — and only becomes a sighting after
 * it has kept you in view for `noticeTime` (instant up close). That is what makes the gold "?" appear before the
 * red "!", and what gives a quick survivor a moment to break the line.
 *
 * Pure: numbers in, numbers out. No world, no Instances, no getCtx — it travels to server/sim with the AI
 * (docs/MULTIPLAYER.md §11.2).
 */

/** light and weather the senses work in */
export interface SenseConditions {
	/** 0 = full daylight, 1 = deepest night (the clock's darkAlpha) */
	darkness: number;
	night: boolean;
	raining: boolean;
}

/**
 * How visible ONE survivor is right now: the light they carry, or stand in. The lights themselves are the ONE rule
 * the light map and the horde's visibility read (shared/sim/survivorLight.ts, LUZ-04); the brain fills this from it.
 */
export interface Beacon {
	/** the range their own light makes them visible from in the dark (0 = none), before rain and Stealth */
	range: number;
	/** the reach of the beam they cast (the flashlight, or a motorcycle's headlight: survivorLight `survivorBeamReach`); 0 = no beam */
	beam: number;
	/** the direction the beam points (the survivor's aim) */
	beamAngle: number;
}

export interface SenseRanges {
	/** how far a zombie can make this survivor out straight ahead */
	sight: number;
	/** half-angle of the eye cone (radians) */
	cone: number;
	/** flashlight beam length (0 = no beam): a zombie inside it sees the light whatever way it faces */
	beam: number;
	/** where the beam points */
	beamAngle: number;
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
/** fraction of every range left in the rain */
export const RAIN_SIGHT = 0.55;
/** fraction of the eyesight lost at darkness 1: 520 u by day, 188 u at the deepest night (0.85) */
export const DARK_SIGHT = 0.75;
/** "Stealth" (skill 15) also makes the survivor harder to make out, not just quieter */
export const STEALTH_SIGHT = 0.7;
/**
 * Touch: noticed whatever the zombie is facing and whatever is between them. The original's 50 px, one step
 * wider: two bodies touch at 34 u, and a survivor at arm's length behind a zombie's shoulder is not hidden.
 */
export const TOUCH_RANGE = 64;
/**
 * A light is made out from this far past the edge of the ground it lights: the survivor's own glow (LUZ-02, 250 u)
 * from 380 u, a torch (400 u) from 530, a flashlight (its 560 u beam) from 690 -- further than daylight: the light
 * that lets you see is the light that gives you away. Night vision and Nocturnal are eyes, not light: they add
 * nothing (survivorLight `survivorGlowRadius`).
 */
export const BEACON_BEYOND = 130;
/** how far off a survivor whose light reaches `lightR` is made out in the dark */
export function beaconSight(lightR: number): number {
	return lightR + BEACON_BEYOND;
}
/** the bare survivor's own glow, seen in the dark from here */
export const GLOW_SIGHT = beaconSight(Light.SURVIVOR_LIGHT_R);
/** half the flashlight's beam: the same cone the light map draws and `isLit` lights (LUZ-04) */
export const BEAM_HALF = Light.CONE_HALF_ANGLE;
/** the survivor's own light only starts to matter at dusk, and counts in full from this darkness on */
export const BEACON_FROM = 0.2;
export const BEACON_FULL = 0.5;
/** a survivor standing in a lamp's or a fire's light is seen as in daylight */
export const LAMP_SIGHT = SIGHT_DAY;
/** noises carry this much in the rain (the brain's `emitSound` applies it to every ring) */
export const RAIN_HEARING = 0.6;

/**
 * How far each sense reaches under `c` against a survivor carrying `beacon`; `stealthy` = Stealth skill.
 * `out` is filled and returned when given (the brain pools one per survivor: this runs every tick).
 */
export function senseRanges(c: SenseConditions, beacon?: Beacon, stealthy = false, out?: SenseRanges): SenseRanges {
	const dark = math.clamp(c.darkness, 0, 1);
	let sight = SIGHT_DAY * (1 - DARK_SIGHT * dark);
	if (beacon !== undefined && beacon.range > sight) {
		const k = math.clamp((dark - BEACON_FROM) / (BEACON_FULL - BEACON_FROM), 0, 1);
		sight += (beacon.range - sight) * k;
	}
	if (c.raining) sight *= RAIN_SIGHT;
	sight = math.max(SIGHT_MIN, sight) * (stealthy ? STEALTH_SIGHT : 1);
	const lit = beacon !== undefined && beacon.beam > 0 && dark > BEACON_FROM;
	const r = out ?? { sight: 0, cone: 0, beam: 0, beamAngle: 0 };
	r.sight = sight;
	r.cone = SIGHT_CONE;
	r.beam = lit ? beacon.beam * (c.raining ? RAIN_SIGHT : 1) : 0;
	r.beamAngle = beacon?.beamAngle ?? 0;
	return r;
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

/**
 * Is a zombie at `dist` from the survivor, in direction `fromSurvivor` (survivor → zombie), inside that
 * survivor's flashlight beam? It sees the light shining at it whatever way it faces (the line is still the
 * caller's raycast: a beam does not go through a wall).
 */
export function inBeam(dist: number, fromSurvivor: number, r: SenseRanges): boolean {
	if (r.beam <= 0 || dist > r.beam) return false;
	return math.abs(angleDiff(r.beamAngle, fromSurvivor)) <= BEAM_HALF;
}

// ---------------------------------------------------------------- a glimpse becomes a sighting

/** closer than this fraction of the sight range, seeing is instant */
export const NOTICE_INSTANT = 0.4;
/** seconds of continuous view it takes to be sure, just past NOTICE_INSTANT and at the very edge */
export const NOTICE_MIN = 0.3;
export const NOTICE_MAX = 1.5;
/** a zombie that is already looking for someone (suspicious, searching) is sure this many times faster */
export const NOTICE_ALERT = 2;
/** the certainty a glimpse built fades at this rate (per second) once the survivor is out of view */
export const NOTICE_DECAY = 0.4;

/**
 * Seconds of continuous view a zombie needs to be sure of a survivor `dist` away with sight range `sight`:
 * 0 (instant) up close, NOTICE_MAX at the very edge of what it can see.
 */
export function noticeTime(dist: number, sight: number): number {
	const k = sight > 0 ? dist / sight : 1;
	if (k <= NOTICE_INSTANT) return 0;
	const t = math.clamp((k - NOTICE_INSTANT) / (1 - NOTICE_INSTANT), 0, 1);
	return NOTICE_MIN + (NOTICE_MAX - NOTICE_MIN) * t;
}

// ---------------------------------------------------------------- what the eyes cannot see through

/**
 * Stops a zombie's line of sight: a wall (the building's, the border's), a closed door and an iron barricade.
 * NOT a car, a bin, a pump or a tree trunk — a standing body is taller than a car bonnet, and ducking behind a
 * parked car was a hiding spot the original never had and we do not want (DESIGN_RULES IA-01). Not a wooden
 * barricade or a player structure either: planks have gaps, and a fortified house must not be an invisible one
 * (the interiors rule: no safe spots inside). A solid tagged "window" (the interiors work) is glass: it stops
 * a body, not the eyes.
 */
export function blocksSight(s: Solid): boolean {
	if (!isBlocking(s) || s.tags === "window") return false;
	const k = s.kind;
	return (
		k === "wall_h" ||
		k === "wall_v" ||
		k === "building" ||
		k === "door" ||
		k === "iron_door" ||
		k === "iron_barricade"
	);
}

// ---------------------------------------------------------------- LOD (§3.4)

/** ≤ this from the nearest survivor: the zombie decides at 30 Hz */
export const LOD_NEAR = 800;
/** ≤ this: 15 Hz. Beyond it: 7.5 Hz, and nobody can see it, so cosmetics are skipped */
export const LOD_MID = 1600;

/** seconds between two AI decisions (steering) for a zombie this far from a survivor */
export function decisionInterval(dist: number): number {
	if (dist <= LOD_NEAR) return 1 / 30;
	if (dist <= LOD_MID) return 1 / 15;
	return 1 / 7.5;
}

/**
 * Seconds between two looks (cone, beam and the line-of-sight ray) for a zombie this far from a survivor:
 * 10 Hz near, 5 Hz in the mid ring, 2 Hz far out. Staggered per zombie by the caller, so a horde's looks are
 * spread over the ticks instead of landing on one (docs/MULTIPLAYER.md §3.4).
 */
export function senseInterval(dist: number): number {
	if (dist <= LOD_NEAR) return 0.1;
	if (dist <= LOD_MID) return 0.2;
	return 0.5;
}

/** cosmetics (light/alpha, footstep noise) are pointless this far out: nobody is looking */
export function visibleToSomeone(dist: number): boolean {
	return dist <= LOD_MID;
}
