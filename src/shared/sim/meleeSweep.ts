/*
 * A melee blade's sweep, one step at a time -- the ONE formula the server's weapon machine (server/sim/combat.ts
 * `updateMelee`) and the client's feel (client/systems/combat.ts `updateSwing` / `predictSwing`) move the blade with --
 * and the time the rest of a sweep still in the air would take.
 *
 * That second number is the cadence rule of DESIGN_RULES ITM-06: an attack that STARTED is paid in full whatever the
 * hands do next. A sweep cut short -- the weapon put away (Holster), or switched for another -- pays the rest of its
 * arc (its current hit pause included) and the weapon's cooldown before the next attack may start, exactly as if it
 * had finished. Without it, putting the blade away mid-sweep and drawing it again was an animation cancel: 2.1-3.3x the
 * DPS of the Dagger, the Axe and the Katana (review of 398bf95, HIGH-1), and a switch to the blade and back ~5x the Axe.
 *
 * Pure: no Instances, no services. Angles in degrees off the aim, as the sweeps keep them.
 */
import { SPEED_SCALE } from "./types";

/**
 * The blade's angle one step of `dt` later: the original's ease-out (`weapon_angle_speed`, the weapon's `range`
 * column), never less than half a degree a step, and at most one degree past the limit (which ends the sweep).
 */
export function meleeSweepStep(angle: number, limit: number, speed: number, dt: number): number {
	const step = speed * SPEED_SCALE * dt * (math.abs(angle - limit - 20) / 80);
	return math.min(limit + 1, angle + math.max(step, 0.5));
}

/**
 * Seconds a sweep in the air still has to run, stepped at `dt` exactly as the sweeps step it: its hit pause (`delay`,
 * counted down a step at a time, the float the steppers leave included), then the rest of the arc up past `limit`.
 * Bounded: a pause is at most a few steps, every arc step moves the blade at least half a degree, and no cone is wider
 * than 2 x 60 degrees (at most ~240 steps).
 */
export function meleeSweepLeftS(angle: number, limit: number, speed: number, delay: number, dt: number): number {
	if (dt <= 0) return math.max(delay, 0);
	let t = 0;
	let d = delay;
	while (d > 0) {
		d -= dt;
		t += dt;
	}
	let a = angle;
	while (a <= limit) {
		a = meleeSweepStep(a, limit, speed, dt);
		t += dt;
	}
	return t;
}
