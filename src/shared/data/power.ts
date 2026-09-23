/*
 * Electricity and automated defence: the rules (docs/DESIGN_RULES.md §10A ELE-01..ELE-08).
 *
 * The original (Dead Town, `obj_bettery`, `obj_generator_*`, `obj_turret*`, `obj_lightaction_move`, `obj_gps`,
 * `obj_cooker`) plugged every electric object into its NEAREST battery box within `global.line_length` = 300 px and
 * drew a cable to it. That is the whole grid: no wiring puzzle, one circle to learn. We keep it, and keep its numbers
 * (a generator makes 0.2 a frame = 6 a second, a machine eats 0.1 a frame = 3 a second, a box holds 1000), and fix
 * what it did badly:
 *
 *   - an idle turret ate 3/s whether or not it ever fired: here it idles at 1/s and each shot costs 2 (ELE-04);
 *   - a lamp, a beacon and a cooker ate power from the moment they were built: here they have a switch (E);
 *   - the drones flew for free; here each carries a battery that its pad refills from the grid (ELE-05);
 *   - the oil generator burnt fuel the moment its box had room: here it starts below 95 % and stops when full,
 *     as a real auto-start generator does, which also keeps its "running" light from flickering (ELE-02).
 *
 * Pure data and pure functions, shared by the server's grid (server/sim/power.ts), its turrets
 * (server/sim/turrets.ts), the wire (shared/net/protocol.ts `PowerSet`) and the client's drawing
 * (client/view/machinesView.ts). No Instances.
 */
import type { Solid } from "shared/game/world";

// ---------------------------------------------------------------- skills (shared/data/skills.ts)

/** "Robotics": turret damage ×1.5 (obj_turret: `turret_damage/2*rpg_skill_get_level(13)`) */
export const SKILL_ROBOTICS = 13;
/** "Engineering": generator output ×1.5 and battery ×1.2 (obj_generator_*, obj_bettery) */
export const SKILL_ENGINEERING = 14;
/** what a level of Robotics multiplies turret damage by, and the drones' battery */
export const ROBOTICS_DAMAGE = 1.5;
export const ROBOTICS_DRONE_BATTERY = 1.5;
/** what a level of Engineering multiplies a generator's output by, and a battery box's capacity */
export const ENGINEERING_OUTPUT = 1.5;
export const ENGINEERING_BATTERY = 1.2;

// ---------------------------------------------------------------- the grid (ELE-01)

/** a machine plugs into the nearest battery box whose centre is within this many units of its own (line_length) */
export const POWER_LINK_RANGE = 300;
/** the grid settles its flows this often; turrets fire (and pay) in between */
export const POWER_STEP_S = 0.25;
/** a consumer that went dark comes back only once its box holds this much (no flicker at the edge of empty) */
export const POWER_RESTART_MIN = 5;
/** the most PowerSet deltas one settle may publish; the rest wait for the next settle (a safety valve) */
export const POWER_PUBLISH_MAX = 64;

/** battery box: 1000 charge, as the original's `electricity_max`; it is 5 cells, and it comes charged */
export const BATTERY_CAPACITY = 1000;
/** each generator makes this much a second into its box (0.2 a frame at 30 fps) */
export const GENERATOR_OUTPUT = 6;
/** the solar panel under rain or clouds (P1: a cloudy day still makes some power) */
export const SOLAR_RAIN_FACTOR = 0.5;
/** the oil generator's own tank, and what it burns a second while running (0.1 a frame) */
export const OIL_TANK = 1000;
export const OIL_BURN = 3;
/** E with oil in the backpack: 5 oil buy 100 of tank (oil_max/200 → oil_max/10), 33 s of running */
export const OIL_REFUEL_COST = 5;
export const OIL_REFUEL_TANK = 100;
/** the oil generator starts when its box drops below this fraction and stops when the box is full */
export const OIL_START_BELOW = 0.95;

/** stun gun: E at a battery box moves up to this much charge into it (the original's 100 a press) */
export const STUN_GUN_ID = 26;
export const STUN_CHARGE_PER_PRESS = 100;

// ---------------------------------------------------------------- consumers (ELE-03, ELE-04)

/** charge per second a switched-on lamp, signal generator and cooker draw */
export const LAMP_DRAW = 1;
export const BEACON_DRAW = 1;
export const COOKER_DRAW = 2;

/** gun turret (obj_turret): 25 damage every 20 frames, ±10°, hitscan like a survivor's shot */
export const TURRET_DAMAGE = 25;
export const TURRET_COOLDOWN = 20 / 30;
export const TURRET_SPREAD_DEG = 10;
/**
 * 300 u, not the original's 200: the original's 200 px were a third of a phone screen; here a walker (90 u/s) crosses
 * 200 u in 2.2 s — three shots, 75 damage, and it bites the turret with 25 hp left. At 300 u it takes five shots
 * (~125) and falls before it touches the turret: one turret stops one walker (ELE-04). It is also the cable's reach,
 * so the base has one radius to learn.
 */
export const TURRET_RANGE = 300;
/** standby draw while armed, and the price of each shot, in charge */
export const TURRET_STANDBY = 1;
export const TURRET_SHOT_COST = 2;
/** a turret shot is a gunshot: heard as far as a survivor's (combat.ts SHOT_NOISE) */
export const TURRET_NOISE = 800;
/** where the bullet leaves the turret's head, from its centre */
export const TURRET_MUZZLE = 26;

/** electric turret (obj_trap_electric): a 10-damage shock every 20 frames at the nearest zombie within 200 */
export const SHOCK_DAMAGE = 10;
export const SHOCK_COOLDOWN = 20 / 30;
export const SHOCK_RANGE = 200;
/** it holds what it hits (the stun gun's bolt does, `stunned = 1`); the original's trap only hurt */
export const SHOCK_STUN = 0.6;
/** and the arc jumps to two more zombies within 120 u of the last, like the stun gun's chain */
export const SHOCK_CHAINS = 2;
export const SHOCK_CHAIN_RANGE = 120;
export const SHOCK_STANDBY = 1;
export const SHOCK_ZAP_COST = 3;
/** a crackle, not a gunshot */
export const SHOCK_NOISE = 200;

// ---------------------------------------------------------------- drones (ELE-05)

/** a drone's own battery (Robotics ×1.5), what flying costs a second, and what its pad pours back */
export const DRONE_BATTERY = 400;
export const DRONE_FLIGHT_DRAW = 1;
export const DRONE_DOCK_RATE = 10;
/** it takes off only with this fraction of its battery (no launch-and-land at the edge of empty) */
export const DRONE_LAUNCH_MIN = 0.1;
/** at most this many drones escort one survivor (LEG-03: a swarm would hide the survivor and the zombies) */
export const DRONE_MAX_ESCORTS = 3;
/** obj_turret_move circles the player at 100 px; obj_lightaction_move at 300 (we keep the light closer: 180) */
export const TURRET_DRONE_ORBIT = 100;
export const LAMP_DRONE_ORBIT = 180;
/** 1° a frame at 30 fps, in radians a second (written out: the protocol loads this module in every test shim) */
export const DRONE_ORBIT_SPEED = (30 * math.pi) / 180;
/** the turret drone shoots what is within this of ITSELF */
export const TURRET_DRONE_RANGE = 250;
/** the lamp drone's light (shared/sim/ai/zombieTuning.ts STRUCTURE_LIGHT_R had it at 320 already) */
export const LAMP_DRONE_LIGHT = 320;

// ---------------------------------------------------------------- the signal generator (ELE-06)

/** the beacon's arrow shows once its survivor is this far from it, fully drawn at BEACON_ARROW_FULL */
export const BEACON_ARROW_FROM = 400;
export const BEACON_ARROW_FULL = 1000;

// ---------------------------------------------------------------- the machines

export type MachineRole = "battery" | "generator" | "consumer" | "drone";

export interface MachineDef {
	tag: string;
	role: MachineRole;
	/** consumers: E switches it (lamp, beacon, cooker); the turrets are armed whenever they have power */
	switched: boolean;
	/** charge a second while working (consumers, and a drone in the air) */
	draw: number;
	/** generators: what kind of power */
	source?: "solar" | "reactor" | "oil";
	/** consumers that shoot, and drones that do */
	weapon?: "gun" | "shock";
	/** drones that light */
	light?: boolean;
}

function m(
	tag: string,
	role: MachineRole,
	draw: number,
	extra?: Partial<Pick<MachineDef, "switched" | "source" | "weapon" | "light">>,
): MachineDef {
	return {
		tag,
		role,
		draw,
		switched: extra?.switched ?? false,
		source: extra?.source,
		weapon: extra?.weapon,
		light: extra?.light,
	};
}

/** every electric build, by its tag (shared/sim/placement.ts PLACEABLES) */
export const MACHINES: Record<string, MachineDef> = {
	battery: m("battery", "battery", 0),
	solar: m("solar", "generator", 0, { source: "solar" }),
	reactor: m("reactor", "generator", 0, { source: "reactor" }),
	oil_generator: m("oil_generator", "generator", 0, { source: "oil" }),
	turret: m("turret", "consumer", TURRET_STANDBY, { weapon: "gun" }),
	electric_turret: m("electric_turret", "consumer", SHOCK_STANDBY, { weapon: "shock" }),
	lamp: m("lamp", "consumer", LAMP_DRAW, { switched: true }),
	gps: m("gps", "consumer", BEACON_DRAW, { switched: true }),
	cooker: m("cooker", "consumer", COOKER_DRAW, { switched: true }),
	turret_drone: m("turret_drone", "drone", DRONE_FLIGHT_DRAW, { weapon: "gun" }),
	lamp_drone: m("lamp_drone", "drone", DRONE_FLIGHT_DRAW, { light: true }),
};

/** the electric build this solid is, or undefined */
export function machineOf(s: Solid): MachineDef | undefined {
	return MACHINES[s.tags];
}

export function isMachine(s: Solid): boolean {
	return MACHINES[s.tags] !== undefined;
}

/** centre-to-centre distance², the one the link range is measured with */
export function linkDist2(a: Solid, b: Solid): number {
	const dx = a.x + a.w / 2 - (b.x + b.w / 2);
	const dy = a.y + a.h / 2 - (b.y + b.h / 2);
	return dx * dx + dy * dy;
}

// ---------------------------------------------------------------- stations
// A cooker is cooking heat while its `powered` is set: the grid writes it (switched on AND fed, ELE-03) and the one
// craft rule reads it (shared/sim/craftRule.ts `isWorkingCooker`, station "cook"); nothing about cooking lives here.

// ---------------------------------------------------------------- published state (the wire and the mirror)

/**
 * `PowerSet.state` and the client mirror: bit 0 working (a consumer fed and switched on, a generator running, a box
 * holding charge), bits 1-2 the level of its store (box charge, drone battery, oil tank: 0 empty, 1 low, 2 half,
 * 3 high), bit 3 a drone in the air, bit 4 a switched machine's switch is on (a lamp can be on and still dark: no
 * power). Bits 5-7 are reserved and must be 0.
 */
export const PowerBit = {
	Working: 1,
	LevelShift: 1,
	LevelMask: 6,
	Flying: 8,
	On: 16,
} as const;
export const POWER_STATE_MASK = 31;
export const POWER_LEVEL_MAX = 3;

export function packPowerState(working: boolean, level: number, flying: boolean, on = false): number {
	let s = working ? PowerBit.Working : 0;
	s += math.clamp(math.floor(level), 0, POWER_LEVEL_MAX) * 2;
	if (flying) s += PowerBit.Flying;
	if (on) s += PowerBit.On;
	return s;
}

export function powerWorking(state: number): boolean {
	return state % 2 === 1;
}

export function powerLevel(state: number): number {
	return math.floor(state / 2) % 4;
}

export function powerFlying(state: number): boolean {
	return math.floor(state / 8) % 2 === 1;
}

/** a switched machine's switch (E) is on, fed or not */
export function powerOn(state: number): boolean {
	return math.floor(state / 16) % 2 === 1;
}

/** the level bands: empty below 2 %, then thirds */
const LEVEL_EDGES = [0.02, 1 / 3, 2 / 3];
/** a level only changes once the fraction is this far inside the new band (no flicker at an edge) */
const LEVEL_HYSTERESIS = 0.03;

/** the 0..3 level of a store at fraction `f`, given the level it was published at */
export function levelOf(f: number, previous: number): number {
	let raw = 0;
	for (let i = 0; i < LEVEL_EDGES.size(); i++) {
		if (f >= LEVEL_EDGES[i]) raw = i + 1;
	}
	if (raw === previous || previous < 0 || previous > POWER_LEVEL_MAX) return raw;
	// moving up: the fraction must clear the edge by the margin; moving down: fall below it by the margin
	if (raw > previous) return f >= LEVEL_EDGES[raw - 1] + LEVEL_HYSTERESIS ? raw : previous;
	return f < LEVEL_EDGES[previous - 1] - LEVEL_HYSTERESIS ? raw : previous;
}

// ---------------------------------------------------------------- drone flight

/** a point, written by the functions below instead of allocating one */
export interface Point {
	x: number;
	y: number;
}

/**
 * Where a drone escorting a survivor is, relative to them, at `seconds` of server time (tick / SIM_HZ), written into
 * `out`. A pure function of the drone's id and the clock, so the server (which shoots from there and lights from
 * there) and every client (which draws it there, from the survivor it already draws) agree without a position on
 * the wire. Each drone starts at its own angle (the golden angle of its id) and turns its own way (its id's parity).
 */
export function droneOffset(solidId: number, lamp: boolean, seconds: number, out: Point): Point {
	const r = lamp ? LAMP_DRONE_ORBIT : TURRET_DRONE_ORBIT;
	const phase = (solidId * 2.399963229728653) % (2 * math.pi);
	const dir = solidId % 2 === 0 ? 1 : -1;
	const a = phase + dir * DRONE_ORBIT_SPEED * seconds;
	out.x = math.cos(a) * r;
	out.y = math.sin(a) * r;
	return out;
}

/** a drone's battery capacity, given whether its maker knew Robotics */
export function droneCapacity(robotics: boolean): number {
	return robotics ? DRONE_BATTERY * ROBOTICS_DRONE_BATTERY : DRONE_BATTERY;
}

/** a battery box's capacity, given whether its maker knew Engineering */
export function batteryCapacity(engineering: boolean): number {
	return engineering ? BATTERY_CAPACITY * ENGINEERING_BATTERY : BATTERY_CAPACITY;
}

/** a generator's output a second, given whether its maker knew Engineering */
export function generatorOutput(engineering: boolean): number {
	return engineering ? GENERATOR_OUTPUT * ENGINEERING_OUTPUT : GENERATOR_OUTPUT;
}

/** a turret's (or turret drone's, or shock turret's) damage, given whether its maker knew Robotics */
export function turretDamage(weapon: "gun" | "shock", robotics: boolean): number {
	const base = weapon === "shock" ? SHOCK_DAMAGE : TURRET_DAMAGE;
	return robotics ? base * ROBOTICS_DAMAGE : base;
}
