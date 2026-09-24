/*
 * Contracts of the shared simulation (docs/MULTIPLAYER.md §2.2, §4.1 "Fx", §11.3 F0).
 *
 * - InputCommand: one tick of a survivor's input, already quantised exactly as the wire carries it (§2.2
 *   "Comando", 8 bytes). The client builds it from the local input and steps on it (prediction from F1 on); the
 *   server decodes the same bytes, so both sides apply the very same values.
 * - FxEvent: cosmetic effects the simulation asks for (camera shake, blood, debris, tracers, messages). Systems only
 *   push them into `refs.fx`; the view (client gameLoop) turns them into particles, camera shake and HUD messages.
 *   On the server the same events become the Fx channel.
 *
 * shared/sim/* never touches Instances, services or getCtx: it runs in the client, the server and in Node
 * (tools/test-sim.mjs). Integer maths avoids `%` on negative numbers (Luau and JS disagree there).
 */

/** balancing unit: speeds are px/frame at 30 fps (the original); × SPEED_SCALE = px/s (unchanged in MP, D3) */
export const SPEED_SCALE = 30;

const TAU = math.pi * 2;

/** v wrapped into [0, n) with floor semantics (identical in Luau and JS) */
function wrapInt(v: number, n: number): number {
	return v - math.floor(v / n) * n;
}

// ---------------------------------------------------------------- input command (§2.2)

/** move direction steps per turn (u8): the 8 keyboard directions land exactly (45° = 32 steps) */
export const MOVE_ANGLE_STEPS = 256;
/** aim steps per turn (u16): 0.0055°, 0.1 u of error at the sniper's 1200 u */
export const AIM_STEPS = 65536;
/** sequence numbers are u16 and wrap (compare with seqNewer) */
export const SEQ_MOD = 65536;

/** `held` bits (u8): buttons down during the tick */
export const HELD_ATTACK = 1;
export const HELD_ACTION = 2;
/** reserved for a separate sniper-scope input (today the scope is the held attack of a sniper) */
export const HELD_SCOPE = 4;

/** `edges`: four 2-bit counters (0–3 per tick), slot 0 in the low bits */
export const EDGE_ATTACK_PRESS = 0;
export const EDGE_ATTACK_RELEASE = 1;
export const EDGE_ACTION_PRESS = 2;
export const EDGE_RELOAD = 3;

/** one tick of input, quantised (§2.2): every field is an unsigned integer of the given width */
export interface InputCommand {
	/** u16, wraps at SEQ_MOD */
	seq: number;
	/** u8: move direction in MOVE_ANGLE_STEPS steps, world frame (0 = +x, 64 = +y, i.e. down) */
	moveAng: number;
	/**
	 * u8: 0 = standing. Any value > 0 walks at full speed: the stick's deflection does not scale the speed (as
	 * before F0); the analogue stick still sends its magnitude for later use.
	 */
	moveMag: number;
	/** u16: aim angle in AIM_STEPS steps, world frame */
	aim: number;
	/** u8: HELD_* bits */
	held: number;
	/** u8: 2-bit counters at the EDGE_* slots */
	edges: number;
}

/** radians → u8 move step */
export function quantizeMoveAngle(rad: number): number {
	return wrapInt(math.floor((rad / TAU) * MOVE_ANGLE_STEPS + 0.5), MOVE_ANGLE_STEPS);
}

/** radians → u16 aim step */
export function quantizeAim(rad: number): number {
	return wrapInt(math.floor((rad / TAU) * AIM_STEPS + 0.5), AIM_STEPS);
}

/** u8 move step → x of the unit direction (the four axes are exact: no 6e-17 drift into a wall) */
export function moveDirX(step: number): number {
	if (step === 64 || step === 192) return 0;
	if (step === 0) return 1;
	if (step === 128) return -1;
	return math.cos((step / MOVE_ANGLE_STEPS) * TAU);
}

/** u8 move step → y of the unit direction */
export function moveDirY(step: number): number {
	if (step === 0 || step === 128) return 0;
	if (step === 64) return 1;
	if (step === 192) return -1;
	return math.sin((step / MOVE_ANGLE_STEPS) * TAU);
}

/** u16 aim step → radians in (−π, π] (the range of atan2) */
export function aimOf(step: number): number {
	const a = (step / AIM_STEPS) * TAU;
	return a > math.pi ? a - TAU : a;
}

/** the four 2-bit edge counters (each clamped to 0–3) packed into a u8 */
export function packEdges(
	attackPresses: number,
	attackReleases: number,
	actionPresses: number,
	reloads: number,
): number {
	const c = (n: number): number => math.clamp(math.floor(n), 0, 3);
	return c(attackPresses) + c(attackReleases) * 4 + c(actionPresses) * 16 + c(reloads) * 64;
}

/** one 2-bit counter (EDGE_* slot) out of `edges` */
export function edgeCount(edges: number, slot: number): number {
	return wrapInt(math.floor(edges / math.pow(4, slot)), 4);
}

/**
 * Quantises one tick of input. (dx, dy): wanted world-space move direction of any length; (0, 0) = standing.
 * `magnitude` (0–1): the stick's deflection (1 for keys). `aim`: world-space aim angle.
 */
export function makeCommand(
	seq: number,
	dx: number,
	dy: number,
	magnitude: number,
	aim: number,
	held: number,
	edges: number,
): InputCommand {
	const moving = dx !== 0 || dy !== 0;
	return {
		seq: wrapInt(math.floor(seq), SEQ_MOD),
		moveAng: moving ? quantizeMoveAngle(math.atan2(dy, dx)) : 0,
		moveMag: moving ? math.clamp(math.floor(magnitude * 255 + 0.5), 1, 255) : 0,
		aim: quantizeAim(aim),
		held: math.clamp(math.floor(held), 0, 255),
		edges: math.clamp(math.floor(edges), 0, 255),
	};
}

/** modular u16 comparison: is `a` after `b` (within half the ring)? */
export function seqNewer(a: number, b: number): boolean {
	const d = wrapInt(a - b, SEQ_MOD);
	return d !== 0 && d < SEQ_MOD / 2;
}

// ---------------------------------------------------------------- cosmetic effects (§4.1 Fx)

/** whose blood: zombies (and bosses) bleed green, survivors red (LEG-02) */
export type BloodSource = "zombie" | "player";
/** what a debris burst is made of; the view picks the colour */
export type DebrisMaterial = "impact" | "tree" | "car" | "structure" | "exploder" | "boss";
/** kind of shot line; the view picks the colour */
export type TracerKind = "bullet" | "electric" | "boss";
/**
 * A sound the SIMULATION decides (P0-4): the moment it happens and where -- a bite that landed, a door that turned, a
 * usable the survivor used, a horn or a bell -- heard by whoever is near, as the horde hears its noise. Each name is
 * the client's catalogue entry (shared/data/sounds.ts); on the wire it is a u8 of shared/net/fxWire.ts WIRE_SOUNDS.
 */
export type WorldSound =
	| "bite"
	| "doorOpen"
	| "doorClose"
	| "ironDoorOpen"
	| "ironDoorClose"
	| "useEat"
	| "useBandage"
	| "useMedkit"
	| "usePills"
	| "useInject"
	| "hornMoto"
	| "bellBike";

/**
 * A cosmetic effect asked for by the simulation. `player` is the survivor's index in `refs.players` (its slot from
 * F1 on): a shake only moves that survivor's camera; a message without `player` is for everyone.
 */
export type FxEvent =
	| { kind: "shake"; player: number; magnitude: number; duration: number }
	| { kind: "blood"; x: number; y: number; count: number; source: BloodSource; dir?: number }
	| { kind: "debris"; x: number; y: number; count: number; material: DebrisMaterial }
	| { kind: "tracer"; x1: number; y1: number; x2: number; y2: number; tracer: TracerKind; life: number }
	| { kind: "message"; text: string; player?: number }
	| { kind: "sound"; sound: WorldSound; x: number; y: number };
