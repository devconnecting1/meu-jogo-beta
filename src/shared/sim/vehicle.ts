/*
 * Riding a bicycle or a motorcycle (docs/DESIGN_RULES.md VEI-05, docs/MULTIPLAYER.md §2.2).
 *
 * Three things live here, all pure:
 *
 *   1. The STEP of a mounted survivor, `stepRide`, called by `stepPlayer` (shared/sim/playerMove.ts) in place of the
 *      walk. The server simulates it and the client predicts it with the very same code, like the walk: the command
 *      carries only the stick (direction) and the buttons, never a speed, so a client can go exactly as fast as the
 *      server's own `PlayerState.ride` lets it -- and only the server ever sets that (server/sim/vehicles.ts).
 *
 *   2. The STATE the wire carries for it, `RideState` (shared/sim/rideKey.ts, re-exported here), kept on the exact
 *      grid the self block can hold: the heading in HEADING_STEPS steps of a turn (14 bits) and the speed in
 *      SPEED_STEP u/s steps (8 bits), plus the kind (2 bits). The step quantises its own result every tick, so the
 *      state the server sends back is BIT-exact and the client's replay from it lands where the server did
 *      (prediction.ts compares at RECONCILE_EPS = 0.01 u).
 *
 *   3. The QUERIES around a parked vehicle: which kind a solid is, whether it can be ridden, where it goes when the
 *      rider gets off.
 *
 * Handling (VEI-05): the survivor points the stick where they want to GO, like walking, and the vehicle turns toward
 * it at a limited yaw rate -- `standTurn` when (nearly) stopped, never more than `grip / v` at speed, so a fast
 * bike turns wide -- while the throttle opens (stick within 100° of the heading) or the brakes bite (further round).
 * No stick: it coasts to a stop. No reverse: at a standstill the rider walks the front wheel round instead.
 *
 * Collision is a circle of `radius` (20 / 22, the survivor alone is 18). A HEAD-ON hit (under half of the step
 * made it forward) at `crashSpeed` or more is a crash: the vehicle stops dead and `stepRide` reports the impact
 * speed, which the server turns into damage (server/sim/vehicles.ts) -- the client predicts the stop, never the
 * damage. A glancing hit slides along the solid at the speed that survived, the heading following the slide.
 *
 * No Instances, no services, no random numbers: tools/test-vehicles.mjs runs it in Node.
 */
import { VehicleDef, vehicleDef, VehicleKind, vehicleKindOfItem, VEHICLES } from "shared/data/buildings";
import { DESIGN } from "shared/engine/constants";
import { moveActor } from "shared/game/physics";
import type { PlayerState } from "shared/game/player";
import type { PlayerSaveData } from "shared/game/save";
import type { Solid, WorldData } from "shared/game/world";
import { headingOf, quantHeading, quantSpeed, RideState, SPEED_STEP, unpackRide } from "./rideKey";
import { InputCommand, MOVE_ANGLE_STEPS, SPEED_SCALE } from "./types";

const TAU = math.pi * 2;
const QUARTER = math.pi / 2;

/** the stick further than this from the heading brakes instead of opening the throttle */
export const BRAKE_ANGLE = math.rad(100);
/** a step that got less than this fraction of its length forward was head-on */
export const CRASH_ALONG = 0.5;
/** below this fraction of its hp a vehicle is broken: it cannot be ridden, E repairs it (VEI-05) */
export const BROKEN_RATIO = 0.25;
/** the tag every parked vehicle carries (shared/sim/placement.ts) */
export const VEHICLE_TAG = "vehicle";

/** puts the ride named by `key` on the survivor (a fresh table: the old one may be in a history) */
export function applyRideKey(p: PlayerState, key: number): void {
	p.ride = unpackRide(key);
}

// ---------------------------------------------------------------- handling

/** the difference a - b wrapped into [-π, π) (floor-based: the same in Luau and JS) */
function wrapPi(d: number): number {
	return d - TAU * math.floor((d + math.pi) / TAU);
}

/** yaw rate the vehicle can manage at speed v, rad/s */
export function turnRate(def: VehicleDef, v: number): number {
	return math.min(def.standTurn, def.grip / math.max(v, 1));
}

/** does the engine run? A bicycle always "does"; a motorcycle needs oil in the RIDER's backpack */
export function engineRuns(def: VehicleDef, save: PlayerSaveData): boolean {
	return def.oilIdle <= 0 && def.oilFull <= 0 ? true : save.oil > 0;
}

/**
 * One step of a mounted survivor (see the header). Moves `p`, updates `p.ride` and returns the impact speed of a
 * head-on crash into a solid this step (u/s), or 0. The caller (`stepPlayer`) keeps the survivor inside the world.
 */
export function stepRide(
	world: WorldData,
	p: PlayerState,
	save: PlayerSaveData,
	cmd: InputCommand,
	dt: number,
): number {
	const r = p.ride;
	if (r === undefined) return 0;
	const def = vehicleDef(r.kind);
	if (def === undefined) {
		// a kind nothing can ride: off it, rather than a survivor stuck at speed 0 forever
		p.ride = undefined;
		return 0;
	}
	let h = headingOf(r.heading);
	let v = r.speed * SPEED_STEP;
	if (cmd.moveMag > 0) {
		const diff = wrapPi((cmd.moveAng / MOVE_ANGLE_STEPS) * TAU - h);
		const turn = turnRate(def, v) * dt;
		h += math.clamp(diff, -turn, turn);
		if (math.abs(diff) > BRAKE_ANGLE) v = math.max(0, v - def.brake * dt);
		else if (engineRuns(def, save)) v = math.min(def.topSpeed, v + def.accel * dt);
		else v = math.max(0, v - def.coast * dt);
	} else {
		v = math.max(0, v - def.coast * dt);
	}
	// onto the grid BEFORE moving: what moves the body is exactly what the wire carries
	let hs = quantHeading(h);
	let vs = quantSpeed(v, def);
	h = headingOf(hs);
	v = vs * SPEED_STEP;

	let crash = 0;
	const ca = math.cos(h);
	const sa = math.sin(h);
	const len = v * dt;
	if (p.noclip === true) {
		p.x += ca * len;
		p.y += sa * len;
	} else {
		// a standing rider is resolved too (mounted against a wall, a door closed on them), like a standing walker
		const res = moveActor(world, p.x, p.y, def.radius, ca * len, sa * len);
		const dx = res.x - p.x;
		const dy = res.y - p.y;
		p.x = res.x;
		p.y = res.y;
		if (res.hit !== undefined && len > 0) {
			const along = (dx * ca + dy * sa) / len;
			if (along < CRASH_ALONG && v >= def.crashSpeed) {
				crash = v;
				vs = 0;
			} else if (along > 0) {
				// a glancing hit: carry on along the solid, at the speed that survived it (a stall keeps its heading)
				const got = math.sqrt(dx * dx + dy * dy);
				vs = math.min(vs, quantSpeed(got / dt, def));
				if (vs > 0) hs = quantHeading(math.atan2(dy, dx));
			} else {
				// pushed back (mounted overlapping a wall and driven into it): nothing got through
				vs = 0;
			}
		}
	}

	// a bite's knockback moves a rider like a walker (playerMove.ts), after the ride so a crash reads clean
	if (p.reactionSpeed > 0) {
		const kx = math.cos(p.reactionDir) * p.reactionSpeed * SPEED_SCALE * dt;
		const ky = math.sin(p.reactionDir) * p.reactionSpeed * SPEED_SCALE * dt;
		p.reactionSpeed = math.max(0, p.reactionSpeed - DESIGN.REACTION_FRICTION * dt);
		if (p.noclip === true) {
			p.x += kx;
			p.y += ky;
		} else {
			const res = moveActor(world, p.x, p.y, def.radius, kx, ky);
			p.x = res.x;
			p.y = res.y;
		}
	}
	r.heading = hs;
	r.speed = vs;
	return crash;
}

/**
 * The render lead of a rider (prediction.ts `computeLead`): up to `t` seconds along the heading at the current
 * speed, collided, never simulated. Writes into `out` and returns it.
 */
export function rideLead(
	world: WorldData,
	x: number,
	y: number,
	r: RideState,
	noclip: boolean,
	t: number,
	out: { x: number; y: number },
): { x: number; y: number } {
	out.x = 0;
	out.y = 0;
	const def = vehicleDef(r.kind);
	if (def === undefined || r.speed <= 0 || t <= 0) return out;
	const h = headingOf(r.heading);
	const len = r.speed * SPEED_STEP * t;
	const dx = math.cos(h) * len;
	const dy = math.sin(h) * len;
	if (noclip) {
		out.x = dx;
		out.y = dy;
		return out;
	}
	const res = moveActor(world, x, y, def.radius, dx, dy);
	out.x = res.x - x;
	out.y = res.y - y;
	return out;
}

// ---------------------------------------------------------------- parked vehicles

/** the kind a solid is as a vehicle, or VehicleKind.None. A mirror without `placeable` guesses by size */
export function vehicleKindOfSolid(s: Solid): VehicleKind {
	if (s.tags !== VEHICLE_TAG) return VehicleKind.None;
	if (s.placeable !== undefined) return vehicleKindOfItem(s.placeable);
	const moto = vehicleDef(VehicleKind.Motorcycle);
	return moto !== undefined && math.max(s.w, s.h) >= moto.length ? VehicleKind.Motorcycle : VehicleKind.Bicycle;
}

/**
 * Can a survivor get on it? It has to be a vehicle the SERVER put in the world: a construction the client placed
 * on its own (MP_PHASE 2, client/systems/build.ts) carries no `placeable`, and the server knows nothing of it, so
 * offering "E: Ride" there would promise a speed the server would never grant.
 */
export function isRideable(s: Solid): boolean {
	return s.placeable !== undefined && s.removed !== true && vehicleKindOfSolid(s) !== VehicleKind.None;
}

/** below BROKEN_RATIO of its hp: E repairs it instead of riding it (VEI-05) */
export function vehicleBroken(s: Solid): boolean {
	return s.hpMax > 0 && s.hp < s.hpMax * BROKEN_RATIO;
}

/** where a parked vehicle points: its quarter turn (0 = +x, the way the kit's ghost lies) */
export function parkedHeading(s: Solid): number {
	return (s.rot ?? 0) * QUARTER;
}

/** the quarter turn (0..3) nearest to a heading in radians: how a vehicle is left when the rider gets off */
export function quarterOf(rad: number): number {
	const q = math.floor(rad / QUARTER + 0.5);
	return q - math.floor(q / 4) * 4;
}

/** the axis-aligned footprint of a vehicle of `def` parked at (cx, cy) on quarter turn `rot` */
export function parkedRect(
	def: VehicleDef,
	cx: number,
	cy: number,
	rot: number,
): { x: number; y: number; w: number; h: number } {
	const across = rot === 1 || rot === 3;
	const w = across ? def.width : def.length;
	const h = across ? def.length : def.width;
	return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export { VEHICLES, vehicleDef, VehicleKind, vehicleKindOfItem };
// the wire's grid (packRide, rideKeyValid, the steps...) lives in ./rideKey so the protocol can load it bare
export * from "./rideKey";
