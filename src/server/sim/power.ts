/*
 * The electric grid, decided by the SERVER (docs/DESIGN_RULES.md §10A ELE-01..ELE-08, docs/MULTIPLAYER.md §3.6, §4.5).
 *
 * Every electric build is a `Solid` the server world already holds (server/sim/build.ts places it); this module
 * keeps, beside each one, the little state electricity needs — a box's charge, a drone's battery, a generator's
 * tank, a switch — and settles the flows four times a second (POWER_STEP_S):
 *
 *   1. every machine is plugged into the NEAREST battery box within POWER_LINK_RANGE of it (centre to centre), the
 *      original's `instance_nearest(obj_bettery)` + `line_length`. No wiring: the cable is drawn, never laid;
 *   2. generators pour into their box (the sun by day, the reactor always, the oil engine while it has fuel and its
 *      box has room), then the consumers draw from theirs in a fixed order; one that cannot be fed goes dark;
 *   3. drones on their pad drink from the pad's box; drones in the air drink their own battery and come home empty;
 *   4. what changed is published — `publish(solid, state, pilot)` — for the wire (`PowerSet`, global) and for
 *      `Solid.powered`, which is the one flag the rest of the game already reads (a lamp lights the night for the
 *      horde, a cooker is cooking heat: shared/sim/craftRule.ts `isWorkingCooker`).
 *
 * The survivor's E on a machine comes here through server/sim/interaction.ts (`act`): charge the stun gun at a box,
 * refuel the oil generator, flip a switch, launch or call back a drone. Anything this module does not claim falls
 * back to the ordinary E (a repair).
 *
 * The machine's maker counts (P3: a turret built by a roboticist IS a reinforced turret): Robotics and Engineering
 * are read from the owner's save while the owner is in the world, and remembered when they leave.
 *
 * Pure module: no Instances, no services, no os.clock. Iteration is over arrays in insertion order, never over a
 * Map, so two servers fed the same ticks settle the same grid.
 */
import {
	batteryCapacity,
	DRONE_DOCK_RATE,
	DRONE_FLIGHT_DRAW,
	DRONE_LAUNCH_MIN,
	DRONE_MAX_ESCORTS,
	droneCapacity,
	droneOffset,
	generatorOutput,
	LAMP_DRONE_LIGHT,
	levelOf,
	linkDist2,
	machineOf,
	MachineDef,
	OIL_BURN,
	OIL_REFUEL_COST,
	OIL_REFUEL_TANK,
	OIL_START_BELOW,
	OIL_TANK,
	packPowerState,
	Point,
	POWER_LINK_RANGE,
	POWER_PUBLISH_MAX,
	POWER_RESTART_MIN,
	POWER_STEP_S,
	SKILL_ENGINEERING,
	SKILL_ROBOTICS,
	SOLAR_RAIN_FACTOR,
	STUN_CHARGE_PER_PRESS,
	STUN_GUN_ID,
} from "shared/data/power";
import { countItem, removeItem } from "shared/sim/inventory";
import { creditLitLamp } from "../save/achievements";
import { isNightAt } from "shared/sim/clock";
import { ownsWeapon, PlayerSaveData, SAVE_LIMITS } from "shared/game/save";
import { PlayerState } from "shared/game/player";
import { querySolids, Solid, WorldData } from "shared/game/world";
import { SIM_HZ, SLOT_NONE } from "shared/net/mpConfig";
import { WorldEv, WPowerSet } from "shared/net/protocol";

/** ETC index of oil (a save field of its own: shared/sim/inventory.ts) */
const OIL_ITEM = 48;
const LINK2 = POWER_LINK_RANGE * POWER_LINK_RANGE;

/** the part of the world clock the grid reads (server/sim/waves.ts WorldClock) */
export interface PowerClock {
	dayTime: number;
	isRaining: boolean;
	darkAlpha: number;
}

/** everything the grid keeps about one electric build */
export interface MachineState {
	readonly solid: Solid;
	readonly def: MachineDef;
	/** its maker's skills (refreshed from the owner's save while the owner is in the world) */
	robotics: boolean;
	engineering: boolean;
	/** a box's charge, a drone's battery, the oil generator's tank */
	store: number;
	/** a switched consumer's switch (E) */
	on: boolean;
	/** fed and running at the last settle (published as the Working bit) */
	working: boolean;
	/** the box this machine is plugged into, if one is in range */
	link: MachineState | undefined;
	/** the oil generator's engine (auto-start below OIL_START_BELOW, stop when the box is full) */
	running: boolean;
	/** a drone's survivor, or SLOT_NONE on its pad */
	pilot: number;
	/** turrets: seconds until the next shot (server/sim/turrets.ts) */
	cooldown: number;
	/** turrets: the order it was armed in, which staggers the target searches evenly (ids come in patterns) */
	seq: number;
	/** turrets: the first tick it may look for a target again after a look that found nothing */
	nextSearch: number;
	/** turrets: where the head points, radians (the drawing learns it from the tracers) */
	aim: number;
	/** the 0..3 level last published, and what was last published */
	level: number;
	pubState: number;
	pubPilot: number;
	published: boolean;
}

/** what a survivor's E on a machine did */
export type MachineOutcome =
	| { kind: "charged"; solid: Solid; amount: number }
	| { kind: "refueled"; solid: Solid; tank: number }
	| { kind: "switched"; solid: Solid; on: boolean; working: boolean }
	| { kind: "launched"; solid: Solid; pilot: number }
	| { kind: "recalled"; solid: Solid }
	| { kind: "refused"; solid: Solid; why: "empty" | "full" | "material" | "charging" | "escorts" };

/** one light a flying drone carries, for the horde's visibility (shared/sim/ai/zombieBrain.ts collectLights) */
export interface CarriedLight {
	x: number;
	y: number;
	r: number;
}

export interface ServerPowerOptions {
	world: WorldData;
	clock: PowerClock;
	/** the live save of a slot in the world, for its maker's skills; undefined once they left */
	saveOf?: (slot: number) => PlayerSaveData | undefined;
	/** the body of a survivor who can fly a drone: in the world and alive (undefined otherwise) */
	bodyOf?: (slot: number) => PlayerState | undefined;
	/** a machine's published state changed (the wire: `PowerSet`, global; state = shared/data/power.ts bits) */
	publish?: (s: Solid, state: number, pilot: number) => void;
	simHz?: number;
	/** may this slot's run earn achievements? (§9.3: not an assisted run; unset = yes) */
	paysRewards?: (slot: number) => boolean;
}

export class ServerPower {
	private readonly world: WorldData;
	private readonly clock: PowerClock;
	private readonly saveOf?: (slot: number) => PlayerSaveData | undefined;
	private readonly bodyOf?: (slot: number) => PlayerState | undefined;
	private readonly publish?: (s: Solid, state: number, pilot: number) => void;
	private readonly paysRewards?: (slot: number) => boolean;
	private readonly simHz: number;
	/** every tracked machine, in the order it appeared (the settle order) */
	private readonly list = new Array<MachineState>();
	private readonly bySolid = new Map<Solid, MachineState>();
	/** the machines that shoot (turrets, electric turrets, turret drones), for server/sim/turrets.ts */
	private readonly armed = new Array<MachineState>();
	/** the lights carried by flying lamp drones this tick */
	readonly lights = new Array<CarriedLight>();
	private readonly scratch = new Array<Solid>();
	private readonly point: Point = { x: 0, y: 0 };
	/** ticks since the last settle, and how many make one POWER_STEP_S (counted in ticks: no float drift) */
	private settleTicks = 0;
	private readonly stepTicks: number;
	private armedSeq = 0;
	private seconds = 0;
	/** settles run and deltas published (the tests and §12.2 read them) */
	readonly stats = { settles: 0, published: 0, deferred: 0 };

	constructor(options: ServerPowerOptions) {
		this.world = options.world;
		this.clock = options.clock;
		this.saveOf = options.saveOf;
		this.bodyOf = options.bodyOf;
		this.publish = options.publish;
		this.paysRewards = options.paysRewards;
		this.simHz = options.simHz !== undefined && options.simHz > 0 ? options.simHz : SIM_HZ;
		this.stepTicks = math.max(1, math.floor(POWER_STEP_S * this.simHz + 0.5));
		// a world may already hold machines (a test, an adopted town): they are the grid from the first settle
		for (const s of this.world.solids) this.track(s);
	}

	// ---------------------------------------------------------------- the machines

	/** server/sim/build.ts: a solid appeared (`added`) or left the world; only the electric ones are kept */
	note(s: Solid, added: boolean): void {
		if (added) this.track(s);
		else this.untrack(s);
	}

	/** the grid's state of one machine, or undefined when it is not an electric build */
	stateOf(s: Solid): MachineState | undefined {
		return this.bySolid.get(s);
	}

	/** every machine that can shoot, in a stable order */
	shooters(): ReadonlyArray<MachineState> {
		return this.armed;
	}

	/** how many machines the grid holds */
	count(): number {
		return this.list.size();
	}

	private track(s: Solid): void {
		const def = machineOf(s);
		if (def === undefined || s.removed === true || this.bySolid.has(s)) return;
		const owner = s.owner ?? SLOT_NONE;
		const save = owner !== SLOT_NONE ? this.saveOf?.(owner) : undefined;
		const robotics = (save?.skillLevels[SKILL_ROBOTICS] ?? 0) > 0;
		const engineering = (save?.skillLevels[SKILL_ENGINEERING] ?? 0) > 0;
		const st: MachineState = {
			solid: s,
			def,
			robotics,
			engineering,
			// a box is five charged cells, a drone leaves the bench charged, and the oil generator comes filled
			// (obj_bettery `electricity = 1000`, obj_generator_oil `oil = 1000`)
			store:
				def.role === "battery"
					? batteryCapacity(engineering)
					: def.role === "drone"
						? droneCapacity(robotics)
						: def.source === "oil"
							? OIL_TANK
							: 0,
			// a lamp placed already lit stays lit; everything switched is otherwise built off
			on: def.switched && s.powered === true,
			working: false,
			link: undefined,
			running: false,
			pilot: SLOT_NONE,
			cooldown: 0,
			seq: def.weapon !== undefined ? this.armedSeq++ : 0,
			nextSearch: 0,
			aim: 0,
			level: -1,
			pubState: 0,
			pubPilot: SLOT_NONE,
			published: false,
		};
		this.list.push(st);
		this.bySolid.set(s, st);
		if (def.weapon !== undefined) this.armed.push(st);
		// a new box may be nearer to the machines around it; anything else only needs its own cable
		if (def.role === "battery") this.relinkAround(s);
		else st.link = this.nearestBattery(st);
	}

	private untrack(s: Solid): void {
		const st = this.bySolid.get(s);
		if (st === undefined) return;
		this.bySolid.delete(s);
		const i = this.list.indexOf(st);
		if (i >= 0) this.list.remove(i);
		const j = this.armed.indexOf(st);
		if (j >= 0) this.armed.remove(j);
		if (st.def.role !== "battery") return;
		// the machines that were plugged into it look for the next nearest box, now
		for (const o of this.list) {
			if (o.link === st) o.link = this.nearestBattery(o);
		}
	}

	/** a box appeared: every machine within the link range of it may now be nearer to it than to its own */
	private relinkAround(box: Solid): void {
		const cx = box.x + box.w / 2;
		const cy = box.y + box.h / 2;
		const found = querySolids(
			this.world,
			cx - POWER_LINK_RANGE,
			cy - POWER_LINK_RANGE,
			cx + POWER_LINK_RANGE,
			cy + POWER_LINK_RANGE,
			new Array<Solid>(),
		);
		for (const o of found) {
			const st = this.bySolid.get(o);
			if (st === undefined || st.def.role === "battery") continue;
			st.link = this.nearestBattery(st);
		}
	}

	/** the nearest box within the link range of this machine (ties: the older box, which is the lower id) */
	private nearestBattery(st: MachineState): MachineState | undefined {
		const s = st.solid;
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		this.scratch.clear();
		querySolids(
			this.world,
			cx - POWER_LINK_RANGE,
			cy - POWER_LINK_RANGE,
			cx + POWER_LINK_RANGE,
			cy + POWER_LINK_RANGE,
			this.scratch,
		);
		let best: MachineState | undefined;
		let bestD = LINK2;
		for (const o of this.scratch) {
			if (o === s || o.tags !== "battery" || o.removed === true) continue;
			const b = this.bySolid.get(o);
			if (b === undefined) continue;
			const d = linkDist2(s, o);
			if (d > bestD) continue;
			if (d === bestD && best !== undefined && o.id > best.solid.id) continue;
			best = b;
			bestD = d;
		}
		this.scratch.clear();
		return best;
	}

	// ---------------------------------------------------------------- the tick

	/**
	 * One simulation tick. The drones' positions (and the light a lamp drone carries) follow their survivors every
	 * tick; the flows settle every POWER_STEP_S.
	 */
	step(dt: number, tick: number): void {
		this.seconds = tick / this.simHz;
		this.carryLights();
		this.settleTicks += 1;
		if (this.settleTicks < this.stepTicks) return;
		this.settle(this.settleTicks * dt);
		this.settleTicks = 0;
	}

	/** settles `span` seconds of flow right now (the tick calls it every POWER_STEP_S; the tests may call it) */
	settle(span: number): void {
		this.stats.settles += 1;
		for (const st of this.list) this.refreshSkills(st);
		for (const st of this.list) if (st.def.role === "generator") this.generate(st, span);
		for (const st of this.list) if (st.def.role === "consumer") this.consume(st, span);
		for (const st of this.list) if (st.def.role === "drone") this.fly(st, span);
		this.publishChanges();
	}

	private refreshSkills(st: MachineState): void {
		const owner = st.solid.owner ?? SLOT_NONE;
		if (owner === SLOT_NONE) return;
		const save = this.saveOf?.(owner);
		if (save === undefined) return;
		st.robotics = (save.skillLevels[SKILL_ROBOTICS] ?? 0) > 0;
		st.engineering = (save.skillLevels[SKILL_ENGINEERING] ?? 0) > 0;
	}

	/** a box's capacity, by its maker's Engineering */
	capacityOf(st: MachineState): number {
		if (st.def.role === "battery") return batteryCapacity(st.engineering);
		if (st.def.role === "drone") return droneCapacity(st.robotics);
		if (st.def.source === "oil") return OIL_TANK;
		return 0;
	}

	private generate(g: MachineState, span: number): void {
		const b = g.link;
		let factor = 0;
		if (b !== undefined) {
			const cap = this.capacityOf(b);
			if (g.def.source === "solar") {
				// the sun shines by day (06:00-19:00, the hours `isNightAt` calls day); rain halves it
				if (!isNightAt(this.clock.dayTime)) factor = this.clock.isRaining ? SOLAR_RAIN_FACTOR : 1;
			} else if (g.def.source === "reactor") {
				factor = 1;
			} else {
				// auto-start: on below 95 %, off when full or dry (obj_generator_oil only ran while the box had room)
				if (!g.running && g.store > 0 && b.store < cap * OIL_START_BELOW) g.running = true;
				if (g.running && (b.store >= cap || g.store <= 0)) g.running = false;
				if (g.running) {
					const burn = math.min(g.store, OIL_BURN * span);
					factor = burn / (OIL_BURN * span);
					g.store -= burn;
				}
			}
			const add = generatorOutput(g.engineering) * span * factor;
			b.store = math.min(cap, b.store + add);
		} else {
			g.running = false;
		}
		g.working = factor > 0;
		g.solid.powered = g.working;
	}

	private consume(c: MachineState, span: number): void {
		const wants = c.def.switched ? c.on : true;
		const b = c.link;
		if (!wants || b === undefined) {
			c.working = false;
		} else {
			const need = c.def.draw * span;
			// a consumer that is running keeps running while its box covers the step; one that went dark waits
			// for a little more than that, so the edge of empty is not a flicker
			const threshold = c.working ? need : math.max(need, POWER_RESTART_MIN);
			if (b.store >= threshold) {
				b.store -= need;
				c.working = true;
			} else {
				c.working = false;
			}
		}
		c.solid.powered = c.working;
	}

	private fly(d: MachineState, span: number): void {
		if (d.pilot !== SLOT_NONE) {
			const body = this.bodyOf?.(d.pilot);
			d.store = math.max(0, d.store - DRONE_FLIGHT_DRAW * span);
			// the survivor left, died, or the battery ran out: it flies home to its pad
			if (body === undefined || d.store <= 0) d.pilot = SLOT_NONE;
		}
		let charging = false;
		if (d.pilot === SLOT_NONE) {
			const b = d.link;
			const cap = this.capacityOf(d);
			if (b !== undefined && d.store < cap) {
				const take = math.min(DRONE_DOCK_RATE * span, cap - d.store, b.store);
				if (take > 0) {
					b.store -= take;
					d.store += take;
					charging = true;
				}
			}
		}
		// in the air it is armed (or lit); on its pad the light says it is drinking
		d.working = d.pilot !== SLOT_NONE || charging;
		// never `powered`: the pad does not light the night, the drone does (`lights`)
		d.solid.powered = false;
	}

	/** where a machine is right now: a drone in the air is beside its survivor, everything else is where it stands */
	positionOf(st: MachineState, out: Point): Point {
		const s = st.solid;
		if (st.def.role === "drone" && st.pilot !== SLOT_NONE) {
			const body = this.bodyOf?.(st.pilot);
			if (body !== undefined) {
				droneOffset(s.id, st.def.light === true, this.seconds, out);
				out.x += body.x;
				out.y += body.y;
				return out;
			}
		}
		out.x = s.x + s.w / 2;
		out.y = s.y + s.h / 2;
		return out;
	}

	/** the lights of the lamp drones in the air, where they are this tick */
	private carryLights(): void {
		this.lights.clear();
		for (const st of this.list) {
			if (st.def.light !== true || st.pilot === SLOT_NONE) continue;
			const p = this.positionOf(st, this.point);
			this.lights.push({ x: p.x, y: p.y, r: LAMP_DRONE_LIGHT });
		}
	}

	/**
	 * A turret pays for a shot (or a turret drone, from its own battery). False when it cannot: the shot does not
	 * happen. Only an ARMED machine pays: a dark turret does not fire at all.
	 */
	spend(st: MachineState, cost: number): boolean {
		if (st.def.role === "drone") {
			if (st.pilot === SLOT_NONE || st.store < cost) return false;
			st.store -= cost;
			return true;
		}
		const b = st.link;
		if (!st.working || b === undefined || b.store < cost) return false;
		b.store -= cost;
		return true;
	}

	/** is this machine able to shoot right now? (a turret fed by the grid, a turret drone in the air) */
	armedNow(st: MachineState): boolean {
		if (st.def.role === "drone") return st.pilot !== SLOT_NONE;
		return st.working;
	}

	/** the survivor a machine's kill pays (§3.6): a drone's escort, a turret's builder while in the world */
	creditOf(st: MachineState): number {
		if (st.def.role === "drone") return st.pilot !== SLOT_NONE ? st.pilot : -1;
		const owner = st.solid.owner ?? SLOT_NONE;
		if (owner === SLOT_NONE || this.saveOf?.(owner) === undefined) return -1;
		return owner;
	}

	// ---------------------------------------------------------------- E on a machine

	/**
	 * A survivor pressed E on `s` (already found in reach by server/sim/interaction.ts). Returns what happened, or
	 * undefined when this machine has nothing to do for E right now — the caller then does the ordinary E (repair).
	 */
	act(slot: number, body: PlayerState, save: PlayerSaveData, s: Solid): MachineOutcome | undefined {
		const st = this.bySolid.get(s);
		if (st === undefined || body.dead) return undefined;
		const def = st.def;
		if (def.role === "battery") return this.chargeStunGun(st, save);
		if (def.role === "generator") return def.source === "oil" ? this.refuel(st, save) : undefined;
		if (def.role === "drone") return this.launchOrRecall(st, slot);
		if (!def.switched) return undefined;
		st.on = !st.on;
		// the switch answers at once: the lamp does not wait a quarter of a second to come on
		this.consume(st, 0);
		this.publishOne(st);
		// CON-04 Thomas Edison: a lamp this survivor switched on lit on the grid (not in an assisted run, §9.3)
		if (st.on && st.working && def.tag === "lamp" && (this.paysRewards?.(slot) ?? true)) creditLitLamp(save);
		return { kind: "switched", solid: s, on: st.on, working: st.working };
	}

	/**
	 * ELE-07: the stun gun is charged at a battery box, never at a generator — the generator's power goes INTO the box,
	 * and a gun charged straight off a running engine would be charge out of nothing. 100 a press, as the original.
	 */
	private chargeStunGun(st: MachineState, save: PlayerSaveData): MachineOutcome | undefined {
		if (!ownsWeapon(save, STUN_GUN_ID)) return undefined;
		const room = SAVE_LIMITS.AMMO_MAX - save.electric;
		if (room < 1) return { kind: "refused", solid: st.solid, why: "full" };
		const amount = math.min(STUN_CHARGE_PER_PRESS, math.floor(st.store), math.floor(room));
		if (amount < 1) return { kind: "refused", solid: st.solid, why: "empty" };
		st.store -= amount;
		save.electric += amount;
		this.publishOne(st);
		return { kind: "charged", solid: st.solid, amount };
	}

	/** obj_generator_oil: 5 oil from the backpack buy 100 of tank; a full tank has nothing to take (→ repair) */
	private refuel(st: MachineState, save: PlayerSaveData): MachineOutcome | undefined {
		if (st.store > OIL_TANK - OIL_REFUEL_TANK) return undefined;
		if (countItem(save, 4, OIL_ITEM) < OIL_REFUEL_COST) {
			return { kind: "refused", solid: st.solid, why: "material" };
		}
		removeItem(save, 4, OIL_ITEM, OIL_REFUEL_COST);
		st.store = math.min(OIL_TANK, st.store + OIL_REFUEL_TANK);
		this.publishOne(st);
		return { kind: "refueled", solid: st.solid, tank: st.store };
	}

	private launchOrRecall(st: MachineState, slot: number): MachineOutcome {
		if (st.pilot !== SLOT_NONE) {
			st.pilot = SLOT_NONE;
			st.working = false;
			this.publishOne(st);
			return { kind: "recalled", solid: st.solid };
		}
		if (st.store < this.capacityOf(st) * DRONE_LAUNCH_MIN) {
			return { kind: "refused", solid: st.solid, why: "charging" };
		}
		if (this.escortsOf(slot) >= DRONE_MAX_ESCORTS) return { kind: "refused", solid: st.solid, why: "escorts" };
		st.pilot = slot;
		st.working = true;
		this.publishOne(st);
		return { kind: "launched", solid: st.solid, pilot: slot };
	}

	/** how many drones are escorting this survivor */
	escortsOf(slot: number): number {
		let n = 0;
		for (const st of this.list) if (st.def.role === "drone" && st.pilot === slot) n += 1;
		return n;
	}

	/** the survivor left the world: every drone escorting them flies home (§4.4: a slot is per session) */
	remove(slot: number): void {
		for (const st of this.list) {
			if (st.def.role !== "drone" || st.pilot !== slot) continue;
			st.pilot = SLOT_NONE;
			st.working = false;
			this.publishOne(st);
		}
	}

	// ---------------------------------------------------------------- what the wire hears

	/** the state bits of one machine as they would be published now */
	stateBits(st: MachineState): number {
		const cap = this.capacityOf(st);
		st.level = cap > 0 ? levelOf(st.store / cap, st.level) : 0;
		let working = st.working;
		// a box "works" while it holds charge: its lamp says whether anything can be drawn from it
		if (st.def.role === "battery") working = st.store >= 1;
		return packPowerState(
			working,
			st.level,
			st.def.role === "drone" && st.pilot !== SLOT_NONE,
			st.def.switched && st.on,
		);
	}

	private publishOne(st: MachineState): boolean {
		const state = this.stateBits(st);
		const pilot = st.def.role === "drone" ? st.pilot : SLOT_NONE;
		if (st.published && state === st.pubState && pilot === st.pubPilot) return false;
		st.published = true;
		st.pubState = state;
		st.pubPilot = pilot;
		this.stats.published += 1;
		this.publish?.(st.solid, state, pilot);
		return true;
	}

	private publishChanges(): void {
		let sent = 0;
		for (const st of this.list) {
			if (sent >= POWER_PUBLISH_MAX) {
				// the rest keep their difference and go out at the next settle
				this.stats.deferred += 1;
				continue;
			}
			if (this.publishOne(st)) sent += 1;
		}
	}

	/** every machine as last published, for a survivor joining the world (§4.5 WorldInit) */
	initAll(out: Array<MachineState>): Array<MachineState> {
		for (const st of this.list) {
			if (!st.published) this.publishOne(st);
			out.push(st);
		}
		return out;
	}
}

/** the `PowerSet` delta of a machine, as last published (§4.5, the WorldInit of a newcomer) */
export function powerSetOf(st: MachineState): WPowerSet {
	return { t: WorldEv.PowerSet, id: st.solid.id, state: st.pubState, pilot: st.pubPilot };
}

/** the `PowerSet` delta of a change `publish` reports (server/sim/simulation.ts queues it, global) */
export function powerSet(s: Solid, state: number, pilot: number): WPowerSet {
	return { t: WorldEv.PowerSet, id: s.id, state, pilot };
}
