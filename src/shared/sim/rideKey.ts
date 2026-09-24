/*
 * A ride on the wire's grid (docs/DESIGN_RULES.md VEI-05, docs/MULTIPLAYER.md §4.2 and protocol.ts note 16).
 *
 * The state of a mounted survivor that the self block carries, and the grid the simulation keeps it on so that what
 * the server sends back is exactly what it simulated: the heading in HEADING_STEPS steps of a turn (14 bits), the
 * speed in SPEED_STEP u/s steps (8 bits), the kind (2 bits). shared/sim/vehicle.ts steps it; this module only
 * packs, unpacks and range-checks it.
 *
 * It is its own module on purpose: shared/net/protocol.ts validates a decoded ride with `rideKeyValid`, and the
 * protocol must not drag the world, the physics and the colours in with it (tools/test-net.mjs loads it bare).
 * It imports nothing but the vehicle data.
 */
import { VehicleDef, vehicleDef } from "shared/data/buildings";

const TAU = math.pi * 2;

/** heading steps per turn: 14 bits of the self block's u16 (0.022°) */
export const HEADING_STEPS = 16384;
/** speed step on the wire and in the simulation, u/s: a u8 of them reaches 510, the motorcycle's top speed */
export const SPEED_STEP = 2;
export const SPEED_STEPS_MAX = 255;

/** a mounted survivor's vehicle, on the wire's grid */
export interface RideState {
	/** VehicleKind: 1 bicycle, 2 motorcycle */
	kind: number;
	/** integer 0..HEADING_STEPS-1, world frame (0 = +x, a quarter = +y, i.e. down the screen) */
	heading: number;
	/** integer 0..SPEED_STEPS_MAX, in SPEED_STEP u/s */
	speed: number;
}

/** v wrapped into [0, n) with floor semantics (identical in Luau and JS) */
function wrapInt(v: number, n: number): number {
	return v - math.floor(v / n) * n;
}

/** radians → heading step */
export function quantHeading(rad: number): number {
	return wrapInt(math.floor((rad / TAU) * HEADING_STEPS + 0.5), HEADING_STEPS);
}

/** heading step → radians in [0, 2π) */
export function headingOf(step: number): number {
	return (step / HEADING_STEPS) * TAU;
}

/** the most speed steps a kind can hold (its top speed on the grid) */
export function topSteps(def: VehicleDef): number {
	return math.min(SPEED_STEPS_MAX, math.floor(def.topSpeed / SPEED_STEP));
}

/** u/s → speed step, within what this vehicle can do */
export function quantSpeed(v: number, def: VehicleDef): number {
	return math.clamp(math.floor(v / SPEED_STEP + 0.5), 0, topSteps(def));
}

/** the ride's speed in u/s */
export function rideSpeed(r: RideState): number {
	return r.speed * SPEED_STEP;
}

/** the ride's heading in radians */
export function rideHeading(r: RideState): number {
	return headingOf(r.heading);
}

/**
 * The ride as ONE number, the 24 bits the self block carries: kind · 2²² + heading · 2⁸ + speed, and 0 on foot.
 * Prediction keeps it per command to compare with the server's at the ack.
 */
export function packRide(r: RideState | undefined): number {
	if (r === undefined) return 0;
	return (r.kind * HEADING_STEPS + r.heading) * 256 + r.speed;
}

/** is `key` a ride the server could have sent? (kind 0..2, on foot = 0 exactly, speed within the kind's top) */
export function rideKeyValid(key: number): boolean {
	if (key !== math.floor(key) || key < 0) return false;
	if (key === 0) return true;
	const def = vehicleDef(math.floor(key / (HEADING_STEPS * 256)));
	if (def === undefined) return false;
	return key % 256 <= topSteps(def);
}

/** the ride a valid key names, or undefined on foot (see `rideKeyValid`) */
export function unpackRide(key: number): RideState | undefined {
	if (key <= 0) return undefined;
	const speed = key % 256;
	const hk = math.floor(key / 256);
	return { kind: math.floor(hk / HEADING_STEPS), heading: hk % HEADING_STEPS, speed };
}
