//!native
/*
 * What the server sends to each client (docs/MULTIPLAYER.md §4.1, §4.2, §4.3, §4.4, §4.5, §4.6).
 *
 *   Snap   unreliable, every SNAP_NEAR_EVERY_TICKS ticks (20 Hz): the own block, the other survivors, the
 *          bosses and the horde — each entity filtered by the interest rings and the visibility rules of §4.3
 *   Fx     unreliable, one batch per tick when something happened: blood, debris, shakes, tracers, shots
 *   World  reliable, batched per tick: InitBegin, the roster (PlayerJoined, and PlayerProfile when a level, an
 *          outfit, a pet or the title shown changes in session — MON-04, MON-05), PlayerLife, ZombieDied, Clock,
 *          Announce (§4.5; a title earned is one, sent to its owner only), WorldReset when every survivor died
 *          and a new town replaced the old one (MP-22), and PlayerTally, the scoreboard's two numbers (MP-23)
 *
 * This is the last link of F2: the server has simulated one horde, one clock and one set of waves since 2A/2B,
 * and until this file put them on the wire no client could see any of it. Everything here is therefore about
 * saying the same thing to everybody — the same `netId`s, the same deaths, the same hour — while saying it
 * only to those who are allowed to know (§4.3, MP-07).
 *
 * Pure module in the sense that matters for testing: it never touches an Instance. Everything leaves through a
 * `ReplicationTransport`, which server/net/remotes.ts implements with the real remotes and tools/test-server-sim.mjs
 * and tools/test-replication.mjs implement with an array (so the tests decode exactly the bytes a client receives).
 */
import { DESIGN } from "shared/engine/constants";
import { titleToWire } from "shared/data/titles";
import { quantPos, dequantPos } from "shared/net/codec";
import {
	INTEREST_EXIT,
	MAX_PLAYERS,
	SLOT_NONE,
	SNAP_NEAR_EVERY_TICKS,
	SNAP_MAX_BYTES,
	SNAP_ZOMBIE_CAP,
	UNRELIABLE_PAYLOAD_LIMIT,
	WORLD_FLUSH_EVERY_TICKS,
	midViewExtraTicks,
} from "shared/net/mpConfig";
import {
	AnnounceKind,
	BossSnap,
	DeathCause,
	FxEvent,
	LifeState,
	ModFlag,
	PlayerFlag,
	PlayerSnap,
	SelfFlag,
	SelfSnap,
	Snapshot,
	SolidState,
	WItemAdd,
	WorldEv,
	WorldEvent,
	WorldResetLife,
	ZombieFlag,
	ZombieSnap,
	encodeFx,
	encodeSnapshot,
	encodeWorld,
} from "shared/net/protocol";
import { fxPosition, fxSlot, toWireFx } from "shared/net/fxWire";
import { FxEvent as SimFxEvent } from "shared/sim/types";
import { BossState, ZombieState } from "shared/game/entities";
import { Solid, WorldData, buildingAt } from "shared/game/world";
import { isDoor } from "shared/sim/interactQuery";
import { packRide, rideHeading } from "shared/sim/rideKey";
import { carriesLight, survivorCone } from "shared/sim/survivorLight";
import {
	ActorInterest,
	InterestTable,
	Positioned,
	Ring,
	actorInSnapshot,
	classify,
	inSnapshot,
	visibleInDark,
	visibleThroughWalls,
	worldIsDark,
} from "./interest";
import { DeathCause as HordeDeathCause, ZombieDeath } from "../sim/zombies";
import { BossDeath } from "../sim/bosses";
import { ServerPlayer, bufferDepth, refreshProfile, refreshTally } from "../sim/players";
import { ServerSimulation } from "../sim/simulation";
import { solidAdd } from "../sim/build";
import { MachineState, powerSetOf } from "../sim/power";
import { PendingWorld } from "../sim/worldOut";

/** rough per-event framing the engine adds on top of the payload; only used for the §12.2 bandwidth attribute */
export const REMOTE_OVERHEAD_BYTES = 20;

/**
 * Snapshot rounds a (viewer, entity) interest pair may go unseen before it is swept out of the table. A pair
 * stops being refreshed the moment its zombie dies; `forgetTarget` is the exact path and this is the net that
 * catches whatever the exact path missed. 200 rounds is 10 s at 20 Hz — long enough never to fire in anger.
 */
const INTEREST_SWEEP_AGE = 200;
/** rounds between two sweeps: they walk the whole table, so they are rare and the table is small anyway */
const INTEREST_SWEEP_EVERY = 100;
/**
 * Ticks between two looks at every survivor's profile (level, outfit, pet, title — MON-04, MON-05). 6 ticks is 10 Hz at 60 Hz:
 * a change of outfit reaches the others within 100 ms of the server accepting it, and the check costs a few
 * comparisons per survivor ten times a second instead of sixty.
 */
export const PROFILE_EVERY_TICKS = 6;
/**
 * (MP-23) Ticks between two looks at every survivor's scoreboard numbers (this life's day, the zombies put down):
 * 60 ticks is once a second at 60 Hz. The kills move in a fight far more often than an outfit does, and a scoreboard
 * a second late is still right -- so a survivor costs the others at most one 8-byte `PlayerTally` a second.
 */
export const TALLY_EVERY_TICKS = 60;
/** (MP-23) ticks after a join when every tally is sent again: after the newcomer's PlayerJoined has been flushed */
export const TALLY_AFTER_JOIN_TICKS = 2;
/** spitter head recoil is 0..10 on the wire's raw u8: 25 steps per unit keeps the wind-up smooth */
export const SPIT_EXTRA_SCALE = 25;
/**
 * The outermost interest radius, squared. Bosses and effects have no rotation and no second ring: they are
 * sent while they are inside the hysteresis band of §4.3, so a tracer and the zombie it hits arrive together.
 */
const FX_RANGE2 = INTEREST_EXIT * INTEREST_EXIT;

export interface ReplicationTransport {
	/** one Snap part to one client (unreliable) */
	snap(slot: number, part: buffer): void;
	/** one Fx batch to one client (unreliable) */
	fx(slot: number, packet: buffer): void;
	/** one World batch to one client (reliable) */
	world(slot: number, packet: buffer): void;
	/** one World batch to every client in the world (reliable) */
	worldAll(packet: buffer): void;
}

export interface ReplicationStats {
	snapParts: number;
	snapBytes: number;
	fxPackets: number;
	fxBytes: number;
	worldPackets: number;
	worldBytes: number;
	/** entities that did not fit in SNAP_MAX_PARTS, or were cut by SNAP_ZOMBIE_CAP */
	droppedEntities: number;
	/** World/Fx events that could not fit in a packet even alone */
	droppedEvents: number;
}

export interface ReplicatorOptions {
	/** workspace:GetServerTimeNow() at simulation tick 0 (§4.6) */
	tick0Time: number;
	/** §4.5 map hash, so the client can check it generated the same town */
	mapHash: number;
	/** (MP-22) the seed the town was generated from; DESIGN.TOWN_SEED, the town every server opens with, if omitted */
	seed?: number;
}

/** (MP-22) what the replicator tells the clients when a world ends: server/sim/worldReset.ts */
export interface TownChange {
	/** the new town */
	seed: number;
	mapHash: number;
	/** the world day the old town fell on */
	endedDay: number;
	/** the survivors whose life the server reset to day 1, with the runRev that left in their saves */
	lives: ReadonlyArray<WorldResetLife>;
}

// ---------------------------------------------------------------- map hash (§4.5)

const U32 = 4294967296;

/**
 * "Quantidade de sólidos + Σ id × coordenadas mod 2³²" (§4.5). Coordinates are floored first so the value is an
 * exact integer on both sides (Luau and the client share one f64 path, but `%` on fractions is not worth the risk).
 */
export function mapHashOf(world: WorldData): number {
	let acc = world.solids.size() % U32;
	for (const s of world.solids) {
		const coords = math.floor(s.x) + math.floor(s.y) * 7 + math.floor(s.w) * 13 + math.floor(s.h) * 17;
		acc = (acc + ((s.id * coords) % U32)) % U32;
	}
	return acc < 0 ? acc + U32 : acc;
}

// ---------------------------------------------------------------- snapshot blocks (§4.2)

/** the local survivor's authoritative state; x/y are f32, so the client reconciles against the exact value */
export function selfBlockOf(sim: ServerSimulation, sp: ServerPlayer): SelfSnap {
	const p = sp.state;
	let flags = 0;
	if (p.attacked) flags += SelfFlag.Hit;
	if (p.buffs.poison > 0) flags += SelfFlag.Poison;
	if (p.buffs.speed > 0) flags += SelfFlag.Speed;
	if (p.buffs.calm > 0) flags += SelfFlag.Calm;
	if (p.buffs.pain > 0) flags += SelfFlag.Pain;
	if ((p.puddleSlow ?? 0) > 0) flags += SelfFlag.Acid;
	if (p.dead) flags += SelfFlag.Dead;
	let modFlags = 0;
	if (p.noclip === true) modFlags += ModFlag.Noclip;
	if (p.godMode === true) modFlags += ModFlag.God;
	if (sim.spawnShielded(sp)) modFlags += ModFlag.SpawnShield;
	const w = p.weapon;
	const total = w.reloadTotal ?? 0;
	const reload = w.reloading && total > 0 ? 1 - w.reloadCount / total : 0;
	return {
		x: p.x,
		y: p.y,
		ackSeq: sp.ackSeq,
		bufDepth: bufferDepth(sp),
		reactionSpeed: p.reactionSpeed,
		reactionDir: p.reactionDir,
		hp: math.max(0, p.hp),
		// hungryMax is 100 (DESIGN.PLAYER_HUNGRY), so the raw value fits the u8 of §4.2 with room to spare
		hunger: math.max(0, p.hungry),
		flags,
		iframe: math.max(0, p.iframe),
		mag: math.max(0, w.ammoCount),
		reload: math.clamp(reload, 0, 1),
		// spread and bleed are F2/F4; draw is already meaningful for the bow
		spread: 0,
		draw: math.clamp(w.bowCount, 0, 1),
		bleed: 0,
		modFlags,
		weapon: math.max(0, w.pointer),
		// VEI-05: the vehicle under them, on the grid the simulation keeps it on (the prediction replays from it)
		ride: packRide(p.ride),
	};
}

const TAU = math.pi * 2;

/** shortest signed difference between two angles, in (−π, π] */
function angleDelta(a: number, b: number): number {
	let d = (a - b) % TAU;
	if (d > math.pi) d -= TAU;
	else if (d < -math.pi) d += TAU;
	return d;
}

/** another survivor as the wire carries them (§4.2: 12 B) */
export function playerBlockOf(sp: ServerPlayer): PlayerSnap {
	const p = sp.state;
	let flags = 0;
	if (sp.walking) flags += PlayerFlag.Walking;
	if (p.swingerActive) flags += PlayerFlag.Swinging;
	if (p.weapon.reloading) flags += PlayerFlag.Reloading;
	if (p.dead) flags += PlayerFlag.Dead;
	// LUZ-04: the cone the horde's visibility lights along their aim (zombieBrain `collectLights`, by the same rule),
	// so every screen draws it where it lights the zombies. A body carries none (`carriesLight`)
	if (carriesLight(p) && survivorCone(sp.save) !== undefined) flags += PlayerFlag.Flashlight;
	return {
		slot: sp.slot,
		x: p.x,
		y: p.y,
		aim: p.angle,
		flags,
		weapon: math.max(0, p.weapon.pointer),
		swing: p.swingerActive ? angleDelta(p.swingerAngle, p.angle) : 0,
		hp: p.hpMax > 0 ? math.clamp(p.hp / p.hpMax, 0, 1) : 0,
		revive: 0,
		// VEI-05: on a saddle the feet point nowhere; the angle is the vehicle's heading, and the kind tells which
		moveAng: p.ride !== undefined ? rideHeading(p.ride) : sp.moveAng,
		ride: p.ride?.kind ?? 0,
	};
}

/**
 * One zombie as the wire carries it (§4.2: 9 B, +1 when it is mid-air or winding up a spit).
 *
 * The angle sent is `angleSlow`, the heading the simulation DRAWS with (it turns towards `angle` at 150°/s),
 * not the one it wants: the client draws what it receives and turns nothing itself, so sending the intention
 * instead of the pose would make every zombie snap round on each packet.
 */
export function zombieBlockOf(z: ZombieState, netId: number, mid: boolean): ZombieSnap {
	const out: ZombieSnap = { netId, x: z.x, y: z.y, angle: 0, flags: 0, type: z.type, big: false, mid, aware: 0 };
	fillZombieBlock(out, z, netId, mid);
	return out;
}

/**
 * The same thing written into a block the replicator already owns. A 150-strong horde seen by 6 clients is
 * 900 of these per round: allocating one table each would hand the collector 18 000 tables a second for
 * nothing, so the hot path refills a pool and only the array slots churn.
 */
export function fillZombieBlock(out: ZombieSnap, z: ZombieState, netId: number, mid: boolean): void {
	let flags = 0;
	if (z.detectShow > 0 && z.hp > 0) flags += ZombieFlag.Detect;
	if (z.stunned > 0 || (z.stagger ?? 0) > 0) flags += ZombieFlag.Stunned;
	if ((z.hitFlash ?? 0) > 0) flags += ZombieFlag.HitFlash;
	if (z.jumping === true) flags += ZombieFlag.Jumping;
	if (z.rush === true) flags += ZombieFlag.Charging;
	const fuse = z.fuse ?? -1;
	if (fuse > 0) flags += ZombieFlag.FuseLit;
	const headX = z.headX ?? 0;
	if (headX > 0) flags += ZombieFlag.SpitPrep;
	// one optional byte, and the flags say what it means: the jump wins because a jumper in the air is the
	// one case where the body is not where its shadow is
	let extra: number | undefined;
	if (z.jumping === true) extra = math.clamp(z.jumpHeight ?? 0, 0, 255);
	else if (headX > 0) extra = math.clamp(headX * SPIT_EXTRA_SCALE, 0, 255);
	out.netId = netId;
	out.x = z.x;
	out.y = z.y;
	out.angle = z.angleSlow;
	out.flags = flags;
	out.type = z.type;
	out.big = (z.scale ?? 1) > 1.2;
	out.mid = mid;
	// what the brain decided it is doing (IA-03), drawn over its head by every client (IA-05, protocol decision 17)
	out.aware = z.aware ?? 0;
	out.extra = extra;
}

/**
 * One boss as the wire carries it (§4.2: 14 B). The centipede's 50 segments never travel — the client rebuilds
 * the trail behind the interpolated head with the same follow-the-leader rule the simulation uses — so `phase`
 * carries the only per-type animation number the view needs (`moveCycle`, or `movePos` for the serpent).
 */
export function bossBlockOf(b: BossState, netId: number): BossSnap {
	let flags = 0;
	if ((b.hitFlash ?? 0) > 0) flags += ZombieFlag.HitFlash;
	if (b.attack === true) flags += ZombieFlag.Charging;
	const cycle = b.type === 3 ? (b.moveCycle ?? 0) : (b.movePos ?? 0);
	return {
		netId,
		type: b.type,
		x: b.x,
		y: b.y,
		angle: b.angle,
		hp: b.hpMax > 0 ? math.clamp(b.hp / b.hpMax, 0, 1) : 0,
		flags,
		// moveCycle is 0..360 degrees: a whole degree is finer than a walk cycle can show
		phase: math.clamp(math.floor(cycle), 0, 255),
		extra: 0,
	};
}

/**
 * The interest input of one entity. interest.ts deliberately knows nothing about a ServerPlayer: it classifies
 * plain (slot, x, y) points, which is the same shape the zombie spatial hash feeds it.
 */
export function interestPoint(sp: ServerPlayer): Positioned {
	return { slot: sp.slot, x: sp.state.x, y: sp.state.y };
}

/** one point per survivor; built once per snapshot round and shared by every viewer */
export function interestPoints(players: ReadonlyArray<ServerPlayer>): Array<Positioned> {
	const out = new Array<Positioned>();
	for (const sp of players) out.push(interestPoint(sp));
	return out;
}

/** the position a client will read back from a snapshot (0.5 u steps, §4.2) — used by the tests */
export function wirePosition(v: number): number {
	return dequantPos(quantPos(v));
}

/**
 * One zombie, prepared once per snapshot round: everything the per-viewer loop needs without touching the
 * simulation again. `buildingAt` in particular is a grid query — resolving it once per zombie instead of once
 * per (zombie, viewer) is the difference between 150 and 900 queries per round.
 */
interface HordeEntry {
	z: ZombieState;
	netId: number;
	x: number;
	y: number;
	/** "is it inside SOME light" as the horde itself computed it (§4.3 rule 2) */
	alpha: number;
	/** id of the building it stands in, or 0 outdoors (§4.3 rule 1) */
	building: number;
}

/** one candidate for one viewer's snapshot, before the distance sort and the SNAP_ZOMBIE_CAP cut */
interface ZombiePick {
	entry: HordeEntry;
	dist2: number;
	/** mid ring: the client gets it at 10 Hz and waits 600 ms before retiring it (§4.3, §4.4) */
	mid: boolean;
}

// ---------------------------------------------------------------- the replicator

export class Replicator {
	readonly stats: ReplicationStats = {
		snapParts: 0,
		snapBytes: 0,
		fxPackets: 0,
		fxBytes: 0,
		worldPackets: 0,
		worldBytes: 0,
		droppedEntities: 0,
		droppedEvents: 0,
	};
	/** bytes sent to each slot since the last `takeBytes` (§12.2 `pz_out_Bps`) */
	private readonly bytes = new Map<number, number>();
	private readonly rings = new InterestTable();
	/** the same hysteresis, per (viewer, zombie netId) */
	private readonly hordeRings = new ActorInterest();
	private readonly broadcast = new Array<WorldEvent>();
	private readonly directed = new Map<number, Array<WorldEvent>>();
	/** effects of the tick being flushed: everyone's, then the ones addressed to one survivor */
	private readonly fxQueue = new Array<FxEvent>();
	private snapIndex = 0;
	/** monotonic snapshot round, for the interest sweep */
	private round = 0;

	// scratch, reused every round so a 150-strong horde allocates nothing per tick
	private readonly horde = new Array<HordeEntry>();
	private readonly hordePool = new Array<HordeEntry>();
	private readonly deaths = new Array<ZombieDeath>();
	private readonly bossDeaths = new Array<BossDeath>();
	private readonly simFx = new Array<SimFxEvent>();
	/** this viewer's candidates, sorted by distance; the objects come from `pickPool` */
	private readonly picks = new Array<ZombiePick>();
	private readonly pickPool = new Array<ZombiePick>();
	private readonly zombieBlocks = new Array<ZombieSnap>();
	private readonly zombiePool = new Array<ZombieSnap>();
	private readonly bossBlocks = new Array<BossSnap>();
	private readonly fxForViewer = new Array<FxEvent>();
	/** where each queued effect happened (`flushFx`, once per tick): x, y, and whether it has a place at all */
	private readonly fxX = new Array<number>();
	private readonly fxY = new Array<number>();
	private readonly fxPlaced = new Array<boolean>();
	private readonly fxAt = { x: 0, y: 0 };
	/** the F3 outbox, drained once per tick */
	private readonly interactive = new Array<PendingWorld>();
	private readonly initSolids = new Array<Solid>();
	private readonly initItems = new Array<WItemAdd>();
	private readonly initMachines = new Array<MachineState>();
	/** the town every InitBegin names: it changes when a world ends (MP-22, `openTown`) */
	private mapHash: number;
	private seed: number;
	/** (MP-23) the tick at which every tally goes out again (a survivor joined), or undefined */
	private tallyRound: number | undefined;

	constructor(
		private readonly sim: ServerSimulation,
		private readonly transport: ReplicationTransport,
		private readonly options: ReplicatorOptions,
	) {
		this.mapHash = options.mapHash;
		this.seed = options.seed ?? DESIGN.TOWN_SEED;
		// the shot's rewind needs what only this layer knows: which ring a zombie is in for which viewer (§2.3)
		sim.zombieViewLag = (slot, z, viewTick) => this.viewLagOf(slot, z, viewTick);
	}

	/**
	 * How many ticks further back than `viewTick` -- the render time of the frame that declared it -- `slot` drew
	 * zombie `z`: a body sent in the mid ring is drawn one near interval later than the buffer's render time
	 * (client/net/snapshotBuffer.ts, `extra`), a near one at it, and a body that changed ring somewhere in between,
	 * because the client eases that over a second. The answer mirrors that easing from the `mid` flags the snapshots
	 * actually carried to this viewer (`hordeRings`, `noteCarried`); switched at once with the ring, it was up to
	 * 3 ticks off for a second after every crossing of 800 u (the review of dee095a, S3).
	 */
	viewLagOf(slot: number, z: ZombieState, viewTick: number): number {
		const netId = this.sim.horde?.netIdOf(z) ?? 0;
		if (!(netId > 0)) return 0;
		return this.hordeRings.viewExtra(slot, netId, viewTick, this.sim.simHz);
	}

	// ------------------------------------------------------------ reliable deltas (§4.5)

	/** queue a World event for everyone in the world */
	queue(event: WorldEvent): void {
		this.broadcast.push(event);
	}

	/** queue a World event for one client only (roster on join, loot flags in F3…) */
	queueFor(slot: number, event: WorldEvent): void {
		let list = this.directed.get(slot);
		if (list === undefined) {
			list = new Array<WorldEvent>();
			this.directed.set(slot, list);
		}
		list.push(event);
	}

	/**
	 * A cosmetic effect for this tick, already in wire form (server/sim/combat.ts speaks §4.2 directly). It is
	 * routed by interest when it flushes: a shot nobody can see is not sent, and a `Shake` only ever reaches
	 * the one survivor it belongs to.
	 */
	queueFx(event: FxEvent): void {
		this.fxQueue.push(event);
	}

	/**
	 * Everything a joining client needs before its first snapshot (§7.1 step 6): the clock anchor and the map
	 * hash (§4.6, §4.5), the roster including itself, and the world clock as it stands RIGHT NOW — without
	 * touching the broadcast schedule, so one player joining does not reset everyone else's resync timer.
	 * F3 adds the world deltas (constructions, doors, items) to the very same batch.
	 */
	welcome(sp: ServerPlayer): void {
		this.queueFor(sp.slot, this.initBegin());
		// the hour, the day, the weather and the wave flags: a newcomer must not spend up to CLOCK_RESYNC_S
		// seconds in the wrong half of the day (§4.6)
		this.queueFor(sp.slot, this.sim.clock.clockEventNow(this.sim.tick));
		// profiles first: an outfit changed since the last flush must be in the PlayerJoined the newcomer reads,
		// not in a PlayerProfile that reaches it before it knows that survivor exists (broadcasts go out first)
		this.collectProfiles();
		// the roster the newcomer needs (itself included: that is how it learns its own slot), then the others
		const joined = joinedEvent(sp);
		for (const other of this.sim.players()) {
			this.queueFor(sp.slot, joinedEvent(other));
			/*
			 * …and who in it is already down. PlayerLife is reliable, but it went out when the death happened, to
			 * whoever was there then; a body can also come back into the world dead (a kept corpse, a death carried
			 * over from another session — server/sim/life.ts). It goes DIRECTED and right after its PlayerJoined:
			 * the broadcast list is flushed before the directed one, so a broadcast would reach a client before it
			 * knew the slot and be dropped.
			 *
			 * The newcomer's OWN state is always said, alive too: a client entering with a death still pending (a
			 * New game waits for daybreak, MP-21) draws its survivor dead from the first frame, and has to be told
			 * when the server let it in standing instead — daybreak came while it was in the lobby, or the world
			 * ended and gave it a new life (MP-22). Before this, "alive" was the silence, and silence cannot correct.
			 */
			if (other.state.dead) this.queueFor(sp.slot, lifeEvent(other.slot, LifeState.Dead));
			else if (other.slot === sp.slot) this.queueFor(sp.slot, lifeEvent(sp.slot, LifeState.Up));
			if (other.slot !== sp.slot) {
				this.queueFor(other.slot, joined);
				if (sp.state.dead) this.queueFor(other.slot, lifeEvent(sp.slot, LifeState.Dead));
			}
		}
		this.welcomeWorld(sp);
		/*
		 * MP-23: the scoreboard's numbers go out to EVERYBODY a couple of ticks from now, not inside this welcome. The
		 * broadcast half of a flush goes before the directed half, so a tally broadcast in the same flush as this
		 * newcomer's PlayerJoined would reach it for a slot it does not know yet, and be dropped -- and a directed one
		 * written now could be overtaken by a newer broadcast in that same flush. Two ticks on, every PlayerJoined of
		 * this welcome has been flushed, and one full round tells the newcomer every survivor's numbers (and the
		 * others the newcomer's), in order.
		 */
		this.tallyRound = this.sim.tick + TALLY_AFTER_JOIN_TICKS;
	}

	/**
	 * The dynamic world, for one joining survivor (§4.5 WorldInit).
	 *
	 * The STATIC map is not sent and never will be: both sides generate it from the seed, and `mapHash` in
	 * InitBegin is how they check they agree. What has to travel is everything that happened since -- every
	 * construction and every door somebody opened (global, so all of them), and the ground items near where
	 * this survivor is standing (§4.5's 1800 u). Without this, a player joining a three-hour-old server walks
	 * into a base that, for them, was never built.
	 *
	 * `encodeWorld` splits the batch into 16 KB packets on its own, so a long game does not need chunking
	 * here; `InitBegin.chunks` stays 1 until somebody needs the batch spread over several ticks.
	 */
	private welcomeWorld(sp: ServerPlayer): void {
		const build = this.sim.build;
		if (build !== undefined) {
			this.initSolids.clear();
			for (const solid of build.initAll(this.initSolids)) this.queueFor(sp.slot, solidAdd(solid));
			this.initSolids.clear();
		}
		// the grid's state of each machine, AFTER its SolidAdd (ELE-01..08: a box's charge, a drone in the air)
		const power = this.sim.power;
		if (power !== undefined) {
			this.initMachines.clear();
			for (const st of power.initAll(this.initMachines)) this.queueFor(sp.slot, powerSetOf(st));
			this.initMachines.clear();
		}
		// a door of the generated map that somebody opened: the mirror generated it closed
		for (const solid of this.sim.world.solids) {
			if (solid.placeable !== undefined) continue;
			if (!isDoor(solid) || solid.open !== true) continue;
			this.queueFor(sp.slot, { t: WorldEv.DoorSet, id: solid.id, state: SolidState.Open });
		}
		const items = this.sim.items;
		if (items === undefined) return;
		this.initItems.clear();
		for (const add of items.initFor(sp.state.x, sp.state.y, this.initItems)) this.queueFor(sp.slot, add);
		this.initItems.clear();
	}

	/** the join message (§4.5 WorldInit): the clock anchor, and the town — its seed and the hash to check it by */
	private initBegin(): WorldEvent {
		return {
			t: WorldEv.InitBegin,
			mapHash: this.mapHash,
			seed: this.seed,
			tick0Time: this.options.tick0Time,
			simHz: this.sim.simHz,
			chunk: 0,
			chunks: 1,
		};
	}

	/**
	 * MP-22, first half: the town is about to end. Everything still queued belongs to it — a death, a stand-up, a
	 * ZombieDied for one viewer — and goes out NOW, stamped with the current tick, so no event of the old town can
	 * land after the WorldReset that ends it (review of f851ad2, L3). The horde's interest is forgotten: the new
	 * horde hands its netIds out from 1 again, and a pair kept from the old one would lend its ring (and its death
	 * notice) to a stranger.
	 */
	closeTown(): void {
		this.flushWorld(this.sim.tick);
		this.hordeRings.clear();
		this.fxQueue.clear();
	}

	/**
	 * MP-22, second half: the new town stands and its lives have been handed out (server/sim/worldReset.ts), so
	 * the stand-ups are already queued. This puts the news AHEAD of them and sends it all at once, in the same
	 * heartbeat as the reset — not at the next tick's flush, where a wallet answered in between could overtake it
	 * (review of f851ad2, B2):
	 *
	 *   - `WorldReset` to EVERY connected client (the broadcast is FireAllClients): the lobby builds its next Play in
	 *     the new town, and a client named in `lives` takes the new life, runRev included, as the server wrote it;
	 *   - the PlayerLife stand-ups, right behind it;
	 *   - the join message again, to each survivor in the world: the same InitBegin a newcomer gets, with the new
	 *     seed and hash, so each client checks it built the town the server did (§4.5). Directed events flush after
	 *     the broadcast ones, so it lands after the WorldReset it confirms.
	 *
	 * The batch carries the current tick — the one whose snapshots, sent before it, were the old town's: the client
	 * drops snapshot parts up to AND including that tick (client/net/netClient.ts `townGuard`).
	 */
	openTown(change: TownChange): void {
		this.mapHash = change.mapHash;
		this.seed = change.seed;
		const lives = new Array<WorldResetLife>();
		for (const life of change.lives) lives.push({ userId: life.userId, runRev: life.runRev });
		this.broadcast.unshift({ t: WorldEv.WorldReset, seed: change.seed, endedDay: change.endedDay, lives });
		for (const sp of this.sim.players()) this.queueFor(sp.slot, this.initBegin());
		this.flushWorld(this.sim.tick);
	}

	left(slot: number): void {
		this.rings.forget(slot);
		this.hordeRings.forgetViewer(slot);
		this.directed.delete(slot);
		this.bytes.delete(slot);
		this.queue({ t: WorldEv.PlayerLeft, slot });
	}

	/**
	 * §4.5 "derrubado/reviveu/morreu": a reliable life-state change. F2 only ever sends `Dead` (the snapshot's
	 * own flag is unreliable and a death must not be lost); F4 adds Downed/Revived with the same call.
	 */
	life(slot: number, state: number): void {
		this.queue({ t: WorldEv.PlayerLife, slot, state });
	}

	/**
	 * MON-05: the survivor in `slot` just earned `titleId` (the save already has it). Reliable, and DIRECTED: it is
	 * their news, for their toast. What the others see is the title they choose to show, which reaches everybody
	 * through the profile (`PlayerProfile`) like an outfit does.
	 */
	titleUnlocked(slot: number, titleId: number): void {
		this.queueFor(slot, { t: WorldEv.Announce, msg: AnnounceKind.TitleUnlocked, arg: titleToWire(titleId) });
	}

	// ------------------------------------------------------------ per tick (§3.1 step 4)

	/** call once per simulation tick, after the step */
	afterTick(tick: number): void {
		// the MicroProfiler's view of this layer (§12.2, F6): what it gathered, what it flushed, the snapshots
		const prof = this.sim.profile;
		prof?.begin("PZ.repl.collect");
		this.collectWorldDeltas(tick);
		this.collectFx();
		if (tick % PROFILE_EVERY_TICKS === 0) this.collectProfiles();
		// a full round is due after a join; until it goes, the periodic pass waits for it (a delta broadcast in the
		// same flush as a newcomer's PlayerJoined would reach it for a slot it does not know yet)
		const round = this.tallyRound !== undefined && tick >= this.tallyRound;
		if (round) {
			this.tallyRound = undefined;
			this.collectTallies(true);
		} else if (this.tallyRound === undefined && tick % TALLY_EVERY_TICKS === 0) {
			this.collectTallies(false);
		}
		prof?.end();
		prof?.begin("PZ.repl.flush");
		if (tick % WORLD_FLUSH_EVERY_TICKS === 0) this.flushWorld(tick);
		this.flushFx(tick);
		prof?.end();
		if (tick % SNAP_NEAR_EVERY_TICKS === 0) {
			prof?.begin("PZ.repl.snap");
			this.sendSnapshots();
			prof?.end();
		}
	}

	/**
	 * The reliable half of a tick: the deaths the horde announced (§4.4) and the clock (§4.5, §4.6).
	 *
	 * A death is the one zombie event that may not be lost — it is what turns a body into blood, a corpse and
	 * a drop at the place it fell — so it goes on the reliable channel, and only to the clients that had that
	 * zombie in interest. Sending it to everybody would hand a listener the position of every kill on the map.
	 */
	private collectWorldDeltas(tick: number): void {
		const horde = this.sim.horde;
		if (horde !== undefined) {
			this.deaths.clear();
			horde.takeDeaths(this.deaths);
			for (const d of this.deaths) {
				// a despawn is silent: nothing fell, nothing died, the client's own timeout retires the body
				if (d.cause === HordeDeathCause.Killed) this.announceZombieDeath(d);
				this.hordeRings.forgetTarget(d.netId);
			}
			this.bossDeaths.clear();
			horde.bossRoster.takeDeaths(this.bossDeaths);
			// a boss going down is news for the whole server (§4.5 Announce), unlike a walker's death
			for (const b of this.bossDeaths) {
				this.queue({ t: WorldEv.Announce, msg: AnnounceKind.BossKilled, arg: b.type });
			}
		}
		const clock = this.sim.clock;
		const tickEvent = clock.clockEvent(tick);
		if (tickEvent !== undefined) this.queue(tickEvent);
		for (const a of clock.takeAnnouncements()) this.queue(clock.announceEvent(a));
		this.collectInteractive();
	}

	/**
	 * The F3 half (§4.5): everything the interactive world changed this tick -- a door, a construction, an
	 * item picked up or dropped, a light, a repaired barricade, a looted house.
	 *
	 * The simulation writes these into `sim.worldOut` without knowing what a client is (server/sim/worldOut.ts
	 * explains why); this is where they meet the audiences. Global events go out to everybody because everyone
	 * predicts movement against them; the rest is filtered, either to one slot or by distance, which is both
	 * cheaper and the §4.3 rule that a modified client is not handed a map of every drop in town.
	 */
	private collectInteractive(): void {
		const out = this.sim.worldOut;
		if (out.size() === 0) return;
		out.take(this.interactive);
		for (const p of this.interactive) {
			if (p.slot !== SLOT_NONE) {
				this.queueFor(p.slot, p.ev);
				continue;
			}
			if (p.range <= 0) {
				this.queue(p.ev);
				continue;
			}
			const r2 = p.range * p.range;
			for (const viewer of this.sim.survivors()) {
				// the viewer's interest point is where their body is (`interestPoint`)
				const dx = viewer.state.x - p.x;
				const dy = viewer.state.y - p.y;
				if (dx * dx + dy * dy <= r2) this.queueFor(viewer.slot, p.ev);
			}
		}
		this.interactive.clear();
	}

	/**
	 * (MON-04, §4.4) Whoever's level, outfit or pet moved since the roster last said so gets a `PlayerProfile`, to
	 * everybody — the survivor included, so their own client hears what the server ACCEPTED (a cosmetic it does
	 * not own is not what the others see, whatever its backpack says).
	 *
	 * `refreshProfile` reads the save, so this catches every path that can change those three (a report, an equip
	 * intent, XP, an admin edit, a new run) without any of them having to remember to call it.
	 */
	private collectProfiles(): void {
		for (const sp of this.sim.survivors()) {
			if (refreshProfile(sp)) this.queue(profileEvent(sp));
		}
	}

	/**
	 * (MP-23) Whoever's day of life or kill count moved since the roster last said so gets a `PlayerTally`, to everybody
	 * -- their own client included, which is how the scoreboard shows the server's numbers for everyone alike. `all`
	 * (the round after a join) sends every survivor's, moved or not.
	 */
	private collectTallies(all: boolean): void {
		for (const sp of this.sim.survivors()) {
			if (refreshTally(sp) || all) this.queue(tallyEvent(sp));
		}
	}

	/** one ZombieDied, to each client that could see that zombie in the last rounds (§4.3, §4.4) */
	private announceZombieDeath(d: ZombieDeath): void {
		for (const viewer of this.sim.survivors()) {
			if (this.hordeRings.ring(viewer.slot, d.netId) === Ring.Out) continue;
			this.queueFor(viewer.slot, {
				t: WorldEv.ZombieDied,
				netId: d.netId,
				x: d.x,
				y: d.y,
				// §4.4's `cause` picks the blood and the corpse. The horde only knows that hp reached 0;
				// which weapon did it belongs to combat (2C) and reaches the client through the Fx channel.
				cause: DeathCause.Shot,
			});
		}
	}

	/** the horde's cosmetic events of this tick, translated to the wire vocabulary (shared/net/fxWire.ts) */
	private collectFx(): void {
		const horde = this.sim.horde;
		if (horde === undefined) return;
		this.simFx.clear();
		horde.takeFx(this.simFx);
		for (const e of this.simFx) {
			const wire = toWireFx(e, index => horde.slotOf(index));
			if (wire !== undefined) this.fxQueue.push(wire);
		}
	}

	private flushWorld(tick: number): void {
		if (this.broadcast.size() > 0) {
			const res = encodeWorld({ tick, events: this.broadcast });
			this.stats.droppedEvents += res.dropped;
			for (const packet of res.packets) {
				this.transport.worldAll(packet);
				this.stats.worldPackets += 1;
				this.stats.worldBytes += buffer.len(packet);
				for (const sp of this.sim.survivors()) {
					this.addBytes(sp.slot, buffer.len(packet) + REMOTE_OVERHEAD_BYTES);
				}
			}
			this.broadcast.clear();
		}
		if (this.directed.size() === 0) return;
		for (const [slot, events] of this.directed) {
			if (events.size() === 0) continue;
			const res = encodeWorld({ tick, events });
			this.stats.droppedEvents += res.dropped;
			for (const packet of res.packets) {
				this.transport.world(slot, packet);
				this.stats.worldPackets += 1;
				this.stats.worldBytes += buffer.len(packet);
				this.addBytes(slot, buffer.len(packet) + REMOTE_OVERHEAD_BYTES);
			}
		}
		this.directed.clear();
	}

	/**
	 * The effects of this tick, one batch per client, filtered by §4.3: an effect is sent to a viewer when it
	 * happened inside their interest radius (the same INTEREST_EXIT band the entities use, so a tracer and the
	 * zombie it hits arrive together), and a `Shake` only to the survivor it belongs to.
	 */
	private flushFx(tick: number): void {
		const queue = this.fxQueue;
		if (queue.size() === 0) return;
		// where each effect happened, asked once per effect and not once per effect and viewer (F11)
		const xs = this.fxX;
		const ys = this.fxY;
		const placed = this.fxPlaced;
		xs.clear();
		ys.clear();
		placed.clear();
		for (const e of queue) {
			placed.push(fxPosition(e, this.fxAt));
			xs.push(this.fxAt.x);
			ys.push(this.fxAt.y);
		}
		for (const viewer of this.sim.survivors()) {
			const list = this.fxForViewer;
			list.clear();
			for (let i = 0; i < queue.size(); i++) {
				const e = queue[i];
				const slot = fxSlot(e);
				if (slot !== SLOT_NONE) {
					if (slot === viewer.slot) list.push(e);
					continue;
				}
				if (placed[i] && !this.inFxRange(viewer, xs[i], ys[i])) continue;
				list.push(e);
			}
			if (list.size() === 0) continue;
			const res = encodeFx({ tick, events: list });
			this.stats.droppedEvents += res.dropped;
			for (const packet of res.packets) {
				const len = buffer.len(packet);
				if (len > UNRELIABLE_PAYLOAD_LIMIT) {
					this.stats.droppedEvents += 1;
					continue;
				}
				this.transport.fx(viewer.slot, packet);
				this.stats.fxPackets += 1;
				this.stats.fxBytes += len;
				this.addBytes(viewer.slot, len + REMOTE_OVERHEAD_BYTES);
			}
		}
		this.fxQueue.clear();
	}

	/** an effect is worth sending while it happens inside the viewer's outermost interest ring (§4.3) */
	private inFxRange(viewer: ServerPlayer, x: number, y: number): boolean {
		const dx = x - viewer.state.x;
		const dy = y - viewer.state.y;
		return dx * dx + dy * dy <= FX_RANGE2;
	}

	private sendSnapshots(): void {
		const index = this.snapIndex;
		this.snapIndex = (this.snapIndex + 1) % MAX_PLAYERS;
		this.round += 1;
		if (this.round % INTEREST_SWEEP_EVERY === 0) this.hordeRings.sweep(this.round, INTEREST_SWEEP_AGE);
		const everyone = this.sim.survivors();
		// one interest point per survivor, shared by every viewer of this round (§4.3)
		const points = interestPoints(everyone);
		this.prepareHorde();
		for (const viewer of everyone) {
			const snap = this.snapshotFor(viewer, index, points);
			const res = encodeSnapshot(snap);
			this.stats.droppedEntities += res.dropped;
			/** index in `snap.zombies` of the first zombie the part at hand carries */
			let first = 0;
			for (let i = 0; i < res.parts.size(); i++) {
				const part = res.parts[i];
				const carried = res.partZombies[i];
				const len = buffer.len(part);
				// the engine silently drops anything above the limit: never let it get that far unnoticed
				if (len > UNRELIABLE_PAYLOAD_LIMIT || len > SNAP_MAX_BYTES) {
					this.stats.droppedEntities += 1;
					first += carried;
					continue;
				}
				this.transport.snap(viewer.slot, part);
				this.stats.snapParts += 1;
				this.stats.snapBytes += len;
				this.addBytes(viewer.slot, len + REMOTE_OVERHEAD_BYTES);
				this.noteCarried(viewer.slot, snap.zombies, first, carried, snap.tick);
				first += carried;
			}
		}
	}

	/**
	 * What this viewer's tracks will hold, and so how far back it will draw each body (`viewLagOf`): the `mid` flags of
	 * the zombies a part that went out actually carried. Noted before the encoder, the ones it cut past its last part
	 * were marked sent, with a ring, to a client that never had a track for them (the second review of the
	 * zombie-motion branch, NIT 2).
	 */
	private noteCarried(
		slot: number,
		zombies: ReadonlyArray<ZombieSnap>,
		from: number,
		count: number,
		tick: number,
	): void {
		const hz = this.sim.simHz;
		const midExtra = midViewExtraTicks(hz);
		for (let k = from; k < from + count; k++) {
			const z = zombies[k];
			if (z !== undefined) this.hordeRings.noteSent(slot, z.netId, z.mid, tick, midExtra, hz);
		}
	}

	/** everything about the horde that does not depend on who is looking (§4.3), once per round */
	private prepareHorde(): void {
		this.horde.clear();
		const horde = this.sim.horde;
		if (horde === undefined) return;
		const world = this.sim.world;
		const pool = this.hordePool;
		for (const z of horde.zombies) {
			const netId = horde.netIdOf(z);
			// a zombie that has not been registered yet has no identity to travel under: it will be in the
			// next snapshot, 50 ms later, which nobody can see
			if (netId < 1) continue;
			// `buildingAt` is a grid query: resolved once per zombie here, it would be once per (zombie,
			// viewer) inside the per-client loop — 150 queries a round instead of 900
			const inside = buildingAt(world, z.x, z.y);
			const building = inside !== undefined ? inside.id : 0;
			const at = this.horde.size();
			let entry = pool[at];
			if (entry === undefined) {
				entry = { z, netId, x: z.x, y: z.y, alpha: z.alpha, building };
				pool.push(entry);
			} else {
				entry.z = z;
				entry.netId = netId;
				entry.x = z.x;
				entry.y = z.y;
				entry.alpha = z.alpha;
				entry.building = building;
			}
			this.horde.push(entry);
		}
	}

	/** the snapshot one viewer gets this round (§4.2, §4.3) */
	private snapshotFor(viewer: ServerPlayer, snapIndex: number, points: ReadonlyArray<Positioned>): Snapshot {
		const others = new Array<PlayerSnap>();
		const entries = classify(this.rings, interestPoint(viewer), points);
		for (const e of entries) {
			if (!inSnapshot(e, snapIndex)) continue;
			const sp = this.sim.get(e.slot);
			if (sp !== undefined) others.push(playerBlockOf(sp));
		}
		return {
			tick: this.sim.tick,
			self: selfBlockOf(this.sim, viewer),
			players: others,
			zombies: this.zombiesFor(viewer, snapIndex),
			bosses: this.bossesFor(viewer),
		};
	}

	/**
	 * The horde one viewer may see this round, nearest first.
	 *
	 * Order matters twice over: the encoder fills its parts in this order, and SNAP_ZOMBIE_CAP cuts the tail,
	 * so "nearest first" is what decides that a packet spends its bytes on the zombies in the viewer's face
	 * rather than on the ones two streets away.
	 */
	private zombiesFor(viewer: ServerPlayer, snapIndex: number): Array<ZombieSnap> {
		const out = this.zombieBlocks;
		out.clear();
		if (this.horde.size() === 0) return out;
		const dark = worldIsDark(this.sim.clock.darkAlpha);
		const vx = viewer.state.x;
		const vy = viewer.state.y;
		const inside = buildingAt(this.sim.world, vx, vy);
		const viewerBuilding = inside !== undefined ? inside.id : 0;
		const picks = this.picks;
		const pool = this.pickPool;
		picks.clear();
		for (const entry of this.horde) {
			const dx = entry.x - vx;
			const dy = entry.y - vy;
			const dist2 = dx * dx + dy * dy;
			const ring = this.hordeRings.update(viewer.slot, entry.netId, dist2, this.round);
			if (ring === Ring.Out) continue;
			if (!actorInSnapshot(ring, entry.netId, snapIndex)) continue;
			if (!visibleThroughWalls(viewerBuilding, entry.building)) continue;
			if (!visibleInDark(dark, entry.alpha, dist2)) continue;
			const at = picks.size();
			let pick = pool[at];
			if (pick === undefined) {
				pick = { entry, dist2, mid: ring === Ring.Mid };
				pool.push(pick);
			} else {
				pick.entry = entry;
				pick.dist2 = dist2;
				pick.mid = ring === Ring.Mid;
			}
			picks.push(pick);
		}
		picks.sort((a, b) => a.dist2 < b.dist2);
		const n = math.min(picks.size(), SNAP_ZOMBIE_CAP);
		// past the cap the wire simply runs out of room: what is dropped is the furthest away, which is also
		// the least worth drawing, and the client's despawn timeout (§4.4) retires it without a flicker
		this.stats.droppedEntities += picks.size() - n;
		const blocks = this.zombiePool;
		for (let i = 0; i < n; i++) {
			const pick = picks[i];
			let block = blocks[i];
			if (block === undefined) {
				block = zombieBlockOf(pick.entry.z, pick.entry.netId, pick.mid);
				blocks.push(block);
			} else {
				fillZombieBlock(block, pick.entry.z, pick.entry.netId, pick.mid);
			}
			out.push(block);
		}
		// what each viewer's track holds is noted once the encoder has said what went out (`noteCarried`)
		return out;
	}

	/** §4.3: a boss is sent while it is inside the viewer's rings, every snapshot — there is no boss radar */
	private bossesFor(viewer: ServerPlayer): Array<BossSnap> {
		const out = this.bossBlocks;
		out.clear();
		const horde = this.sim.horde;
		if (horde === undefined) return out;
		const vx = viewer.state.x;
		const vy = viewer.state.y;
		for (const b of horde.bossRoster.list) {
			const netId = horde.bossRoster.netIdOf(b);
			if (netId < 1) continue;
			const dx = b.x - vx;
			const dy = b.y - vy;
			if (dx * dx + dy * dy > FX_RANGE2) continue;
			out.push(bossBlockOf(b, netId));
		}
		return out;
	}

	// ------------------------------------------------------------ bandwidth accounting (§12.2)

	private addBytes(slot: number, n: number): void {
		this.bytes.set(slot, (this.bytes.get(slot) ?? 0) + n);
	}

	/** bytes sent to `slot` since the last call, and resets the counter */
	takeBytes(slot: number): number {
		const n = this.bytes.get(slot) ?? 0;
		this.bytes.set(slot, 0);
		return n;
	}
}

function joinedEvent(sp: ServerPlayer): WorldEvent {
	return {
		t: WorldEv.PlayerJoined,
		slot: sp.slot,
		userId: sp.userId,
		name: sp.name,
		level: sp.level,
		outfit: sp.outfit,
		pet: sp.pet,
		title: sp.title,
	};
}

function tallyEvent(sp: ServerPlayer): WorldEvent {
	return { t: WorldEv.PlayerTally, slot: sp.slot, lifeDay: sp.lifeDay, kills: sp.kills };
}

function lifeEvent(slot: number, state: number): WorldEvent {
	return { t: WorldEv.PlayerLife, slot, state };
}

function profileEvent(sp: ServerPlayer): WorldEvent {
	return {
		t: WorldEv.PlayerProfile,
		slot: sp.slot,
		level: sp.level,
		outfit: sp.outfit,
		pet: sp.pet,
		title: sp.title,
	};
}

/**
 * The snapshot one viewer gets, for callers that hold their own interest table (tools/test-server-sim.mjs).
 * The live server goes through `Replicator`, which keeps one table per server instead of one per call.
 */
export function buildSnapshot(
	sim: ServerSimulation,
	viewer: ServerPlayer,
	rings: InterestTable,
	snapIndex: number,
	points?: ReadonlyArray<Positioned>,
): Snapshot {
	const others = new Array<PlayerSnap>();
	const entries = classify(rings, interestPoint(viewer), points ?? interestPoints(sim.players()));
	for (const e of entries) {
		if (!inSnapshot(e, snapIndex)) continue;
		const sp = sim.get(e.slot);
		if (sp !== undefined) others.push(playerBlockOf(sp));
	}
	return {
		tick: sim.tick,
		self: selfBlockOf(sim, viewer),
		players: others,
		zombies: [],
		bosses: [],
	};
}
