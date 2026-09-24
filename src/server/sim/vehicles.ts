/*
 * Bicycles and motorcycles, owned by the SERVER (docs/DESIGN_RULES.md VEI-05; docs/MULTIPLAYER.md §2.1, §2.4, §4.5).
 *
 * A parked vehicle is a construction like any other: a `Solid` the server put in the world (tags "vehicle", its
 * PLACEABLES id in `placeable`, its builder in `owner`), replicated by the SolidAdd / SolidRemove deltas the
 * construction code already sends (server/sim/build.ts hooks `addSolid` / `removeSolid`). What this module adds is
 * getting on, riding and getting off:
 *
 *   ON    E, on foot, with a rideable vehicle as the `interactTarget` at the SERVER's position -- the very query the
 *         HUD's "E: Ride" ran. The client never names a vehicle (§8.3), so it can only get on the one it stands at.
 *         The solid leaves the world (SolidRemove), the survivor moves onto its seat, and `PlayerState.ride` is set:
 *         from then on `stepPlayer` moves them with the vehicle's handling (shared/sim/vehicle.ts), and ONLY because
 *         the server set that field. A client that predicts riding without it is simply corrected back to a walk.
 *   OFF   E again, a death, leaving the world, a crash that broke it, or being thrown by a zombie. The vehicle goes
 *         back into the world where the rider was (SolidAdd, on the nearest quarter turn), with the hp it has now;
 *         the rider steps off to its side when there is room (it is passable: getting off always works).
 *   RIDE  per tick, after the survivor stepped: a crash into a solid costs the vehicle and the rider (armour does
 *         not help, it is a fall); a zombie ahead at crash speed throws the rider off, below it the vehicle stops
 *         against it; the motorcycle burns the RIDER's oil and makes engine noise; the odometer feeds "Rider".
 *
 * Who may ride (VEI-05): ANYONE, one at a time -- it is a co-op game and a bicycle is a thing you lend. What keeps
 * that from being a griefing tool: nobody destroys another's build (a crash leaves at least 1 hp, MP-11; only a
 * broken vehicle has to be repaired, with steel), the fuel is the rider's own, a parked vehicle bars no door (it is
 * passable), and getting on and off is rate-limited (the solid churns the reliable channel for everybody).
 *
 * No weapons while riding: the simulation hands the combat a holstered command (server/sim/simulation.ts
 * `holstered`, as with a construction on the cursor), and the attack button is the bell or the horn -- a noise the
 * horde hears, which is a lure as much as a warning.
 *
 * Pure module: no Instances, no services, no os.clock.
 */
import { VehicleDef, vehicleDef, VehicleKind } from "shared/data/buildings";
import { PLAYER_RADIUS, circleBlocked, moveActor, segmentClear } from "shared/game/physics";
import { PlayerState, applyPlayerDamage } from "shared/game/player";
import { ZombieState, zombieRadius } from "shared/game/entities";
import { Solid, WorldData, addSolid, isBlocking, removeSolid } from "shared/game/world";
import { SLOT_NONE } from "shared/net/mpConfig";
import { FxEvent, FxType } from "shared/net/protocol";
import { debrisMaterialId } from "shared/net/fxWire";
import { interactTarget } from "shared/sim/interactQuery";
import { PLACEABLES, placedSolid } from "shared/sim/placement";
import { StepResult, WORLD_MARGIN } from "shared/sim/playerMove";
import {
	BROKEN_RATIO,
	engineRuns,
	isRideable,
	parkedHeading,
	parkedRect,
	quantHeading,
	quarterOf,
	rideHeading,
	rideSpeed,
	vehicleBroken,
	vehicleKindOfSolid,
} from "shared/sim/vehicle";
import { RIDER_UNITS_PER_POINT, creditRide } from "../save/achievements";
import type { ServerPlayer } from "./players";

/** seconds between two mounts or dismounts of one survivor: each is a global delta (§4.5), so it is rate-limited */
export const MOUNT_COOLDOWN_S = 0.5;
/** seconds between two engine noise rings (VEI-05) */
export const VEHICLE_NOISE_PERIOD = 0.5;
/** seconds between two presses of the bell / horn that are heard */
export const HORN_COOLDOWN_S = 1;
/** the ring a crash makes (metal on concrete, a body on the asphalt) */
export const CRASH_NOISE = 400;
/** the zombie that was run into: knocked this hard (staggers: zombieTuning STAGGER_KNOCK is 6) and stunned this long */
export const RAM_KNOCK = 8;
export const RAM_STUN = 1;
/** the zombie a slow vehicle stopped against: a shove, no damage */
export const BUMP_KNOCK = 3;
export const BUMP_STUN = 0.3;
/** a step-aside spot counts only if a walk from the saddle ends this close to it */
const STEP_ASIDE_EPS = 0.5;
/** a zombie counts as ahead within this cosine of the heading (±72°): one from behind never stops the vehicle */
const AHEAD_COS = 0.3;
/** seconds between two `distance` events (the Rider achievement's odometer) */
export const ODOMETER_REPORT_S = 1;

/** why a press of E did not get the survivor on */
export type RideRefusal = "cooldown" | "noOil";
/** why a rider is on foot again */
export type DismountWhy = "action" | "thrown" | "broken" | "dead" | "left";

/**
 * Everything that happens to a ride, for whoever listens (ServerSimulation.onRide): the achievements ("Rider" is
 * the odometer of `distance`), the tests, a future HUD message.
 */
export type RideEvent =
	| { kind: "mounted"; vehicle: VehicleKind }
	| { kind: "dismounted"; vehicle: VehicleKind; why: DismountWhy }
	| { kind: "refused"; vehicle: VehicleKind; why: RideRefusal }
	| { kind: "distance"; vehicle: VehicleKind; units: number }
	| { kind: "crash"; vehicle: VehicleKind; speed: number; into: "solid" | "zombie"; vehicleHp: number }
	| { kind: "horn"; vehicle: VehicleKind };

/**
 * A noise a vehicle made (VEI-05) -- THE event the zombies' hearing takes: the engine every VEHICLE_NOISE_PERIOD,
 * the bell or the horn, a crash. `radius` is where it stops being heard, in world units.
 */
export interface VehicleNoise {
	x: number;
	y: number;
	radius: number;
	source: "engine" | "horn" | "crash";
	/** who is riding */
	slot: number;
	vehicle: VehicleKind;
}

/** what the rest of the simulation lends this module (read when called: combat and the horde come later) */
export interface VehicleHooks {
	/** hurt the rider: armour does not help (a fall), knocked along `dir`; with the combat's bookkeeping when there is one */
	hurt?: (sp: ServerPlayer, raw: number, dir: number) => void;
	/** a zombie run into: damage with the combat's kill credit, knock and stun, pushed along `away` */
	ram?: (sp: ServerPlayer, z: ZombieState, damage: number, knock: number, stun: number, away: number) => void;
	/** a zombie a slow vehicle stopped against: no damage */
	shove?: (z: ZombieState, dir: number, knock: number, stun: number) => void;
}

export interface ServerVehiclesOptions {
	world: WorldData;
	/** the vehicle noise event (see VehicleNoise); undefined drops it, which is what a pure test wants */
	noise?: (noise: VehicleNoise) => void;
	/** cosmetic effects in wire form (a crash's debris and camera shake) */
	fx?: (event: FxEvent) => void;
	/** everything that happened to a ride (RideEvent) */
	event?: (sp: ServerPlayer, e: RideEvent) => void;
	hooks?: VehicleHooks;
}

/** the vehicle under a rider: what the parked solid was, carried while it is out of the world */
interface Ridden {
	placeable: number;
	def: VehicleDef;
	hp: number;
	hpMax: number;
	owner: number;
	/**
	 * The body that got on. The vehicle is wherever THIS body is: when the life code swaps the survivor's body (a
	 * stand-up, a resumed body), the vehicle is parked where the old one rode, never teleported to the new one.
	 */
	body: PlayerState;
	/** seconds to the next engine ring */
	noiseT: number;
	hornCd: number;
	/** distance ridden and not yet reported, and seconds to the next report */
	odometer: number;
	reportT: number;
	/** distance reported but short of a whole Rider point (RIDER_UNITS_PER_POINT) */
	riderCarry: number;
}

export class ServerVehicles {
	private readonly world: WorldData;
	private readonly noise?: (noise: VehicleNoise) => void;
	private readonly fx?: (event: FxEvent) => void;
	private readonly event?: (sp: ServerPlayer, e: RideEvent) => void;
	private readonly hooks: VehicleHooks;
	private readonly riders = new Map<number, Ridden>();
	/** seconds until this slot may get on or off again */
	private readonly cooldown = new Map<number, number>();
	/**
	 * The fraction of an oil unit each slot has burnt and not yet paid (the save keeps whole units). Per SLOT, not per
	 * ride, like the combat's fuel debt: kept on the ride it was dropped at every dismount, so getting off every few
	 * seconds rode for free (security review of 5874cfa, V2). Cleared when the slot leaves the world.
	 */
	private readonly fuelDebt = new Map<number, number>();

	constructor(options: ServerVehiclesOptions) {
		this.world = options.world;
		this.noise = options.noise;
		this.fx = options.fx;
		this.event = options.event;
		this.hooks = options.hooks ?? {};
	}

	/** is this slot on a vehicle? */
	riding(slot: number): boolean {
		return this.riders.has(slot);
	}

	/** how many survivors are riding (tests, the admin panel) */
	count(): number {
		return this.riders.size();
	}

	/** the hp of the vehicle under this rider, or undefined on foot */
	vehicleHp(slot: number): number | undefined {
		return this.riders.get(slot)?.hp;
	}

	// ---------------------------------------------------------------- E and the attack button

	/**
	 * A press of E by a survivor on FOOT (the caller has already handled a rider's: `getOff`). Answers whether the
	 * press was a vehicle's -- got on, or refused -- so the interaction does not also act on it. A vehicle that is
	 * broken is NOT taken here: the press falls through to the interaction, which repairs it (VEI-05).
	 */
	tryMount(sp: ServerPlayer): boolean {
		const p = sp.state;
		if (p.dead || this.riders.has(sp.slot)) return false;
		const target = interactTarget(this.world, p.x, p.y);
		if (target === undefined || target.kind !== "vehicle") return false;
		const s = target.solid;
		if (!isRideable(s) || vehicleBroken(s)) return false;
		const def = vehicleDef(vehicleKindOfSolid(s));
		if (def === undefined) return false;
		// not through a wall: the nearest point of it must be in plain sight (the interaction's own reach rule)
		const nx = math.clamp(p.x, s.x, s.x + s.w);
		const ny = math.clamp(p.y, s.y, s.y + s.h);
		if (!segmentClear(this.world, p.x, p.y, nx, ny, isBlocking)) return false;
		if ((this.cooldown.get(sp.slot) ?? 0) > 0) {
			this.tell(sp, { kind: "refused", vehicle: def.kind, why: "cooldown" });
			return true;
		}
		if (!engineRuns(def, sp.save)) {
			this.tell(sp, { kind: "refused", vehicle: def.kind, why: "noOil" });
			return true;
		}
		this.mount(sp, s, def);
		return true;
	}

	/** E on a vehicle: off it (rate-limited like getting on: each is a global delta) */
	getOff(sp: ServerPlayer): boolean {
		if (!this.riders.has(sp.slot)) return false;
		if ((this.cooldown.get(sp.slot) ?? 0) > 0) return true;
		this.dismount(sp, "action");
		return true;
	}

	/** the attack button on a vehicle: the bicycle's bell, the motorcycle's horn */
	horn(sp: ServerPlayer): void {
		const rec = this.riders.get(sp.slot);
		if (rec === undefined || rec.hornCd > 0) return;
		rec.hornCd = HORN_COOLDOWN_S;
		this.emitNoise(sp, rec, rec.def.hornRadius, "horn");
		this.tell(sp, { kind: "horn", vehicle: rec.def.kind });
	}

	// ---------------------------------------------------------------- the ride

	/**
	 * After `stepPlayer` moved a survivor (same tick, same command): everything a ride costs or causes. `zombies`
	 * are the horde's, where they stood this tick.
	 */
	afterStep(sp: ServerPlayer, res: StepResult, zombies: ReadonlyArray<ZombieState>, dt: number): void {
		const p = sp.state;
		const rec = this.riders.get(sp.slot);
		if (rec === undefined) {
			// a ride nobody here granted (a body kept from another town, a stale table): it is not a ride
			if (p.ride !== undefined) p.ride = undefined;
			return;
		}
		if (p !== rec.body || p.ride === undefined) {
			// the body under the rider was replaced (a stand-up, a resumed body, an admin): the vehicle is parked where
			// the body that rode it is, not where the new one stands
			this.dismount(sp, "left");
			return;
		}
		if (p.dead) {
			this.dismount(sp, "dead");
			return;
		}
		const def = rec.def;
		rec.hornCd = math.max(0, rec.hornCd - dt);
		rec.odometer += res.moved;

		const crash = res.crash ?? 0;
		if (crash > 0) {
			this.crash(sp, rec, crash, "solid");
			if (vehicleBrokenRec(rec)) {
				this.dismount(sp, "broken");
				return;
			}
		}
		if (this.hitZombies(sp, rec, zombies)) return;

		if (def.oilFull > 0) this.burnFuel(sp, rec, dt);
		if (def.noiseFull > 0 && engineRuns(def, sp.save)) {
			rec.noiseT -= dt;
			if (rec.noiseT <= 0) {
				rec.noiseT = VEHICLE_NOISE_PERIOD;
				const k = rideSpeed(p.ride) / def.topSpeed;
				this.emitNoise(sp, rec, def.noiseIdle + (def.noiseFull - def.noiseIdle) * k, "engine");
			}
		}
		rec.reportT -= dt;
		if (rec.reportT <= 0) {
			rec.reportT = ODOMETER_REPORT_S;
			this.reportDistance(sp, rec);
		}
	}

	/** the per-slot cooldowns run down (once per tick, whoever is riding) */
	step(dt: number): void {
		for (const [slot, t] of this.cooldown) {
			if (t <= dt) this.cooldown.delete(slot);
			else this.cooldown.set(slot, t - dt);
		}
	}

	/**
	 * The survivor leaves the world: the vehicle is left where they were, never taken with them. A vehicle the
	 * leaver BUILT that somebody else is riding stops counting against the slot (as server/sim/build.ts `remove`
	 * does for the ones standing in the world): the next player in that slot inherits no quota.
	 */
	remove(sp: ServerPlayer): void {
		if (this.riders.has(sp.slot)) this.dismount(sp, "left");
		this.cooldown.delete(sp.slot);
		this.fuelDebt.delete(sp.slot);
		for (const [, rec] of this.riders) if (rec.owner === sp.slot) rec.owner = SLOT_NONE;
	}

	// ---------------------------------------------------------------- on and off

	private mount(sp: ServerPlayer, s: Solid, def: VehicleDef): void {
		const p = sp.state;
		const rec: Ridden = {
			placeable: s.placeable ?? def.item,
			def,
			hp: s.hp,
			hpMax: s.hpMax > 0 ? s.hpMax : def.hpMax,
			owner: s.owner ?? SLOT_NONE,
			body: p,
			noiseT: 0,
			hornCd: 0,
			odometer: 0,
			reportT: ODOMETER_REPORT_S,
			riderCarry: 0,
		};
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		// out of the world: SolidRemove to everybody (build.ts's hook), and nobody else can get on it now
		removeSolid(this.world, s);
		p.x = cx;
		p.y = cy;
		p.reactionSpeed = 0;
		p.ride = { kind: def.kind, heading: quantHeading(parkedHeading(s)), speed: 0 };
		this.riders.set(sp.slot, rec);
		this.cooldown.set(sp.slot, MOUNT_COOLDOWN_S);
		this.tell(sp, { kind: "mounted", vehicle: def.kind });
	}

	/**
	 * Off the vehicle, which goes back into the world under the rider on its nearest quarter turn (SolidAdd), with
	 * the hp it has now and its builder. It is passable, so this cannot fail: nothing has to make room for it.
	 */
	private dismount(sp: ServerPlayer, why: DismountWhy): void {
		const rec = this.riders.get(sp.slot);
		if (rec === undefined) return;
		// the body that rode: where the vehicle is, even when the life code has handed the survivor a new one
		const p = rec.body;
		const heading = p.ride !== undefined ? rideHeading(p.ride) : 0;
		const rot = quarterOf(heading);
		const pdef = PLACEABLES[rec.placeable];
		this.reportDistance(sp, rec);
		this.riders.delete(sp.slot);
		p.ride = undefined;
		sp.state.ride = undefined;
		this.cooldown.set(sp.slot, MOUNT_COOLDOWN_S);
		if (pdef !== undefined) {
			const r = parkedRect(rec.def, p.x, p.y, rot);
			r.x = math.clamp(r.x, 0, math.max(0, this.world.width - r.w - 1));
			r.y = math.clamp(r.y, 0, math.max(0, this.world.height - r.h - 1));
			addSolid(this.world, {
				...placedSolid(pdef, r, rot),
				hp: rec.hp,
				hpMax: rec.hpMax,
				placeable: rec.placeable,
				owner: rec.owner,
			});
		}
		// on their own feet beside it -- not for a death (the body lies where it fell) nor a throw (they fly on), and
		// only the body that is still the survivor's
		if ((why === "action" || why === "broken") && !p.dead && p === sp.state) this.stepAside(p, rec.def, heading);
		this.tell(sp, { kind: "dismounted", vehicle: rec.def.kind, why });
	}

	/**
	 * The rider steps off to the left of the vehicle, else the right, behind, ahead; else stays on it (passable). An
	 * offset counts only if a walk from the saddle actually gets there: a free spot on the far side of a wall or a
	 * closed door is not beside the vehicle (security review of 5874cfa: the step used to go through them).
	 */
	private stepAside(p: PlayerState, def: VehicleDef, heading: number): void {
		const side = def.width / 2 + PLAYER_RADIUS + 2;
		const tip = def.length / 2 + PLAYER_RADIUS + 2;
		const ca = math.cos(heading);
		const sa = math.sin(heading);
		// (forward, lateral) offsets in the vehicle's frame; lateral −1 = the rider's left
		const tries: ReadonlyArray<[number, number]> = [
			[0, -side],
			[0, side],
			[-tip, 0],
			[tip, 0],
		];
		for (const [f, l] of tries) {
			const x = p.x + ca * f - sa * l;
			const y = p.y + sa * f + ca * l;
			if (x < WORLD_MARGIN || y < WORLD_MARGIN) continue;
			if (x > this.world.width - WORLD_MARGIN || y > this.world.height - WORLD_MARGIN) continue;
			if (circleBlocked(this.world, x, y, PLAYER_RADIUS) !== undefined) continue;
			const walk = moveActor(this.world, p.x, p.y, PLAYER_RADIUS, x - p.x, y - p.y);
			if (math.abs(walk.x - x) > STEP_ASIDE_EPS || math.abs(walk.y - y) > STEP_ASIDE_EPS) continue;
			p.x = x;
			p.y = y;
			return;
		}
	}

	// ---------------------------------------------------------------- crashes and zombies

	/** what a crash at `speed` costs: the vehicle (never below 1 hp: MP-11) and the rider (a fall: no armour) */
	private crash(sp: ServerPlayer, rec: Ridden, speed: number, into: "solid" | "zombie"): void {
		const p = sp.state;
		const def = rec.def;
		const k = math.clamp(speed / def.topSpeed, 0, 1);
		const heading = p.ride !== undefined ? rideHeading(p.ride) : 0;
		rec.hp = math.max(1, rec.hp - def.crashDamage * k);
		// a wall throws you back off it; a zombie you go over
		const dir = into === "solid" ? heading + math.pi : heading;
		this.hurt(sp, def.crashHurt * k, dir);
		this.emitNoise(sp, rec, CRASH_NOISE, "crash");
		this.fx?.({
			t: FxType.Debris,
			x: p.x + math.cos(heading) * def.length * 0.5,
			y: p.y + math.sin(heading) * def.length * 0.5,
			angle: dir,
			material: debrisMaterialId("car"),
			count: 8,
		});
		this.fx?.({ t: FxType.Shake, slot: sp.slot, magnitude: 3 + 4 * k, duration: 0.25 });
		this.tell(sp, { kind: "crash", vehicle: def.kind, speed, into, vehicleHp: rec.hp });
	}

	/**
	 * The zombies AHEAD within reach of the moving vehicle. At crash speed the first one is run into -- rammed and
	 * the rider thrown off over it; below it the vehicle stops against it. Answers whether the rider came off.
	 */
	private hitZombies(sp: ServerPlayer, rec: Ridden, zombies: ReadonlyArray<ZombieState>): boolean {
		const p = sp.state;
		const r = p.ride;
		if (r === undefined || r.speed <= 0) return false;
		const def = rec.def;
		const heading = rideHeading(r);
		const ca = math.cos(heading);
		const sa = math.sin(heading);
		for (const z of zombies) {
			if (z.hp <= 0) continue;
			const dx = z.x - p.x;
			const dy = z.y - p.y;
			const reach = def.radius + zombieRadius(z) + 2;
			const d2 = dx * dx + dy * dy;
			if (d2 >= reach * reach) continue;
			const d = math.sqrt(d2);
			if (d > 0.001 && dx * ca + dy * sa < AHEAD_COS * d) continue;
			const v = rideSpeed(r);
			if (v >= def.crashSpeed) {
				const k = v / def.topSpeed;
				this.hooks.ram?.(sp, z, def.ramDamage * k, RAM_KNOCK, RAM_STUN, heading);
				this.crash(sp, rec, v, "zombie");
				this.dismount(sp, "thrown");
				return true;
			}
			r.speed = 0;
			this.hooks.shove?.(z, heading, BUMP_KNOCK, BUMP_STUN);
			return false;
		}
		return false;
	}

	// ---------------------------------------------------------------- fuel, noise, odometer

	/** the motorcycle burns the RIDER's oil: idling, and more the faster it goes; whole units leave the backpack */
	private burnFuel(sp: ServerPlayer, rec: Ridden, dt: number): void {
		const def = rec.def;
		const save = sp.save;
		const r = sp.state.ride;
		if (r === undefined || !engineRuns(def, save)) return;
		// whole units, like the flamethrower's fuel debt (server/sim/combat.ts spendFuel): the save keeps integers, and
		// the fraction stays with the SLOT across getting off and on
		let debt = (this.fuelDebt.get(sp.slot) ?? 0) + (def.oilIdle + (def.oilFull * rideSpeed(r)) / def.topSpeed) * dt;
		while (debt >= 1) {
			debt -= 1;
			save.oil = math.max(0, save.oil - 1);
		}
		this.fuelDebt.set(sp.slot, debt);
	}

	private emitNoise(sp: ServerPlayer, rec: Ridden, radius: number, source: VehicleNoise["source"]): void {
		if (radius <= 0) return;
		this.noise?.({ x: sp.state.x, y: sp.state.y, radius, source, slot: sp.slot, vehicle: rec.def.kind });
	}

	/** the odometer: a `distance` event, and the Rider achievement a point per RIDER_UNITS_PER_POINT (the remainder kept) */
	private reportDistance(sp: ServerPlayer, rec: Ridden): void {
		if (rec.odometer <= 0) return;
		const units = rec.odometer;
		rec.odometer = 0;
		rec.riderCarry += units;
		const points = math.floor(rec.riderCarry / RIDER_UNITS_PER_POINT);
		if (points > 0) {
			rec.riderCarry -= points * RIDER_UNITS_PER_POINT;
			creditRide(sp.save, points);
		}
		this.tell(sp, { kind: "distance", vehicle: rec.def.kind, units });
	}

	private hurt(sp: ServerPlayer, raw: number, dir: number): void {
		if (raw <= 0) return;
		if (this.hooks.hurt !== undefined) {
			this.hooks.hurt(sp, raw, dir);
			return;
		}
		if (applyPlayerDamage(sp.state, sp.save, raw, true)) sp.state.reactionDir = dir;
	}

	private tell(sp: ServerPlayer, e: RideEvent): void {
		this.event?.(sp, e);
	}
}

/** below BROKEN_RATIO: the crash that got it there ends the ride */
function vehicleBrokenRec(rec: Ridden): boolean {
	return rec.hp < rec.hpMax * BROKEN_RATIO;
}
