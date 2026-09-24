//!native
/*
 * What the server sends to each client (docs/MULTIPLAYER.md §4.1, §4.2, §4.3, §4.4, §4.5, §4.6).
 *
 *   Snap   unreliable, every SNAP_NEAR_EVERY_TICKS ticks (20 Hz): the own block, the other survivors, the
 *          bosses and the horde — each entity filtered by the interest rings and the visibility rules of §4.3
 *   Fx     unreliable, one batch on the snapshot's cadence when something happened: blood, debris, shakes, tracers,
 *          shots -- each to the viewers that could SEE where it happened (§4.3's roof and dark rules, audit L2),
 *          stamped with the tick the client plays it at (client/net/fxTimeline.ts, audit M3)
 *   World  reliable, batched on the snapshot's cadence (at once for InitBegin, WorldReset, PlayerLife): InitBegin, the roster (PlayerJoined, and PlayerProfile when a level, an
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
	MAX_BOSSES,
	MAX_PLAYERS,
	SLOT_NONE,
	SNAP_NEAR_EVERY_TICKS,
	SNAP_MAX_BYTES,
	SNAP_ZOMBIE_CAP,
	UNRELIABLE_PAYLOAD_LIMIT,
	FX_FLUSH_EVERY_TICKS,
	FX_MAX_BYTES,
	WORLD_FLUSH_EVERY_TICKS,
	midViewExtraTicks,
} from "shared/net/mpConfig";
import {
	AnnounceKind,
	BloodKind,
	BossSnap,
	DeathCause,
	FxEvent,
	FxShot,
	FxType,
	HitKind,
	LifeState,
	ModFlag,
	PlayerFlag,
	PlayerSnap,
	ProjKind,
	SelfFlag,
	ShotHit,
	SelfSnap,
	Snapshot,
	SolidState,
	WEAPON_HOLSTERED,
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
import { debrisMaterialId, toWireFx, tracerKindId } from "shared/net/fxWire";
import { positionLit } from "shared/sim/ai/zombieBrain";
import { FxEvent as SimFxEvent } from "shared/sim/types";
import { BossState, ZombieState } from "shared/game/entities";
import { WEAPONS } from "shared/data/weapons";
import { blocksShots, raycast } from "shared/game/physics";
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
	/** entities that did not fit in SNAP_MAX_PARTS, were cut by SNAP_ZOMBIE_CAP, or rode a part over the limit */
	droppedEntities: number;
	/** Snap parts over the unreliable limit, never sent (the encoder keeps them under it: the alarm, not a path) */
	droppedParts: number;
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
	/**
	 * The server's real clock in seconds (the host passes os.clock): when the interest decides whether a client still
	 * has a track for a body, it asks it in the time the client retires tracks in (server/net/interest.ts, S3 NIT 1).
	 * Omitted (a test with no real time), the simulation's own time: tick / simHz.
	 */
	now?: () => number;
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
		// ITM-06: a weapon put away is not in their hands -- everyone sees them empty-handed (decision 20)
		weapon: p.holstered === true ? WEAPON_HOLSTERED : math.max(0, p.weapon.pointer),
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

/**
 * One effect of the batch being flushed, placed ONCE for every viewer (audit M3/L2): its position used to be
 * rebuilt per (viewer, event), a table each time, and a Shake-less effect with no position went to everybody.
 */
interface FxEntry {
	e: FxEvent;
	/** where it happens; false: nowhere a viewer can be near (a Shake goes by slot; anything else then goes to all) */
	placed: boolean;
	x: number;
	y: number;
	/** it shows something the roof or the dark hides (a zombie's blood, a spit): §4.3's rules apply at (x, y) */
	sight: boolean;
	/** the building (x, y) is inside, 0 outdoors, and whether it is lit (true by day): read only when `sight` */
	building: number;
	lit: boolean;
	/** a machine's Tracer that does not start at the machine (a chained zap): its start point too (L7) */
	fromSight: boolean;
	fromX: number;
	fromY: number;
	fromBuilding: number;
	fromLit: boolean;
	/** a Shot placed at its shooter's body (a miss can be drawn from there, `missFor`) */
	atShooter: boolean;
	/** a Shot with a hit on a zombie, and per hit the same three -- only a hit ON A ZOMBIE shows what the dark hides */
	zombieHits: boolean;
	hitSight: Array<boolean>;
	hitBuilding: Array<number>;
	hitLit: Array<boolean>;
	/** per hit: the miss a hidden zombie hit is shown as, made at most once a flush (`missMade`); pooled objects */
	missMade: Array<boolean>;
	misses: Array<ShotHit>;
}

/** the World events that cannot wait for the cadence: a join's anchor, a new town, a death or a stand-up (§7.3) */
function urgentEvent(e: WorldEvent): boolean {
	return e.t === WorldEv.InitBegin || e.t === WorldEv.WorldReset || e.t === WorldEv.PlayerLife;
}

/** a set of player slots (0..MAX_PLAYERS-1) in one number */
function maskHas(mask: number, slot: number): boolean {
	return math.floor(mask / 2 ** slot) % 2 === 1;
}

/** the survivors and bosses part 0 of a snapshot carries (shared/net/protocol.ts `encodeSnapshot`: the caps) */
function partZeroActors(snap: Snapshot): number {
	return math.min(snap.players.size(), MAX_PLAYERS) + math.min(snap.bosses.size(), MAX_BOSSES);
}

/** the debris a boss throws: a boss is sent in range whatever the light, so is its debris */
const BOSS_DEBRIS = debrisMaterialId("boss");
/** a boss's beam: sent in range, as the boss is */
const BOSS_TRACER = tracerKindId("boss");
/** projectiles whose spawn is still waiting for its end, at most (the map is a safety net, not a store) */
const PROJ_SEEN_MAX = 1024;

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
		droppedParts: 0,
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
	/** the F3 outbox, drained once per tick */
	private readonly interactive = new Array<PendingWorld>();
	private readonly initSolids = new Array<Solid>();
	private readonly initItems = new Array<WItemAdd>();
	private readonly initMachines = new Array<MachineState>();
	/** effects of the batch being flushed, placed once (`prepareFx`), and their pool */
	private readonly fxEntries = new Array<FxEntry>();
	private readonly fxEntryPool = new Array<FxEntry>();
	/**
	 * projId -> the viewers (a slot mask) its ProjSpawn was sent to: its ProjEnd goes to exactly them (audit L2). A
	 * projectile's end is where it hit, and shown to a viewer who never saw it fly it is a position given away; not
	 * shown to one who did, the arrow flies on to its full range on their screen.
	 */
	private readonly projSeen = new Map<number, number>();
	/** a World event that cannot wait for the cadence was queued (`urgentEvent`) */
	private urgent = false;
	/** the viewer's copies of the shots it may only see part of (`shotFor`), reused flush after flush */
	private readonly shotPool = new Array<FxShot>();
	private shotsUsed = 0;
	private readonly shownScratch = new Array<boolean>();
	/** the server's clock, s (`ReplicatorOptions.now`) */
	private readonly now: () => number;
	/** the town every InitBegin names: it changes when a world ends (MP-22, `openTown`) */
	private mapHash: number;
	private seed: number;
	/** (MP-23) the tick at which every tally goes out again (a survivor joined), or undefined */
	private tallyRound: number | undefined;
	/**
	 * §10 (F6-6B): an admin's free camera. The slot's interest -- the survivors, the horde, the bosses, the effects and
	 * the world deltas it is sent -- is centred on this point instead of its body up to tick `expires` (the panel
	 * refreshes it; a client that stops asking falls back to its body by itself). server/admin/adminWorld.ts sets it,
	 * already validated and kept within FREECAM_MAX_RANGE of the body; ground items keep following the body.
	 */
	private readonly views = new Map<number, { x: number; y: number; expires: number }>();

	constructor(
		private readonly sim: ServerSimulation,
		private readonly transport: ReplicationTransport,
		private readonly options: ReplicatorOptions,
	) {
		this.mapHash = options.mapHash;
		this.seed = options.seed ?? DESIGN.TOWN_SEED;
		this.now = options.now ?? (() => this.sim.tick / this.sim.simHz);
		// the shot's rewind needs what only this layer knows: which ring a zombie is in for which viewer (§2.3)
		sim.zombieViewLag = (slot, z, viewTick) => this.viewLagOf(slot, z, viewTick);
		// ...and the ground items are shown by the same sight rules the horde is (audit L2)
		sim.itemVisible = (slot, x, y) => this.canSeeAt(slot, x, y);
	}

	/**
	 * (§4.3, audit L2) Can the survivor in `slot` see (x, y)? Not inside a building they are not in (the roof, EDI-04),
	 * and in the dark only if something lights the spot or it is within DARK_SENSE_RANGE of them -- the rules a zombie
	 * standing there is sent by. The range is the caller's.
	 */
	canSeeAt(slot: number, x: number, y: number): boolean {
		const viewer = this.sim.get(slot);
		if (viewer === undefined) return true;
		const vx = viewer.state.x;
		const vy = viewer.state.y;
		if (!visibleThroughWalls(this.buildingIdAt(vx, vy), this.buildingIdAt(x, y))) return false;
		if (!worldIsDark(this.sim.clock.darkAlpha)) return true;
		const dx = x - vx;
		const dy = y - vy;
		return visibleInDark(true, this.litAt(x, y) ? 1 : 0, dx * dx + dy * dy);
	}

	/** the id of the building (x, y) is inside, 0 outdoors (§4.3 rule 1) */
	private buildingIdAt(x: number, y: number): number {
		const b = buildingAt(this.sim.world, x, y);
		return b !== undefined ? b.id : 0;
	}

	/** is (x, y) inside some light this tick (the horde's own test, §4.3 rule 2)? With no horde there is no dark rule */
	private litAt(x: number, y: number): boolean {
		const horde = this.sim.horde;
		return horde === undefined || positionLit(horde.refs, x, y);
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
		if (urgentEvent(event)) this.urgent = true;
		this.broadcast.push(event);
	}

	/** queue a World event for one client only (roster on join, loot flags in F3…) */
	queueFor(slot: number, event: WorldEvent): void {
		if (urgentEvent(event)) this.urgent = true;
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
		for (const add of items.initFor(sp.slot, this.initItems)) this.queueFor(sp.slot, add);
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
		this.views.clear();
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

	/** §10: the admin in `slot` looks at (x, y) up to tick `expires` (see `views`) */
	setView(slot: number, x: number, y: number, expires: number): void {
		this.views.set(slot, { x, y, expires });
	}

	/** §10: back to the body */
	clearView(slot: number): void {
		this.views.delete(slot);
	}

	/** the free camera of `slot` while it is live, or undefined (the body is the centre); allocates nothing */
	private liveView(slot: number): { x: number; y: number; expires: number } | undefined {
		if (this.views.size() === 0) return undefined;
		const v = this.views.get(slot);
		if (v === undefined) return undefined;
		if (this.sim.tick > v.expires) {
			this.views.delete(slot);
			return undefined;
		}
		return v;
	}

	/** the point `viewer`'s interest is centred on: its body, or its admin free camera while that is live */
	viewCenter(viewer: ServerPlayer): Positioned {
		const v = this.liveView(viewer.slot);
		return v !== undefined ? { slot: viewer.slot, x: v.x, y: v.y } : interestPoint(viewer);
	}

	left(slot: number): void {
		this.views.delete(slot);
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

	/**
	 * UI-13 (protocol note 21): why the survivor in `slot` just died, for their death screen -- `arg` is
	 * shared/data/deathCause.ts `deathWireOf`. Reliable and DIRECTED like a title: their news, nobody else's.
	 */
	died(slot: number, arg: number): void {
		this.queueFor(slot, { t: WorldEv.Announce, msg: AnnounceKind.Died, arg });
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
		// on the snapshot's cadence (audit M3), or at once for what cannot wait (`urgentEvent`) -- and the effects go
		// with the World batch whenever it goes: a zombie's death and its blood then always carry the same tick, and
		// the client plays them on one frame, one pool (client/view/fxView.ts; the security review of the net
		// hardening: an urgent flush used to send the death a batch ahead of its blood, and the floor poured a second)
		const world = this.urgent || tick % WORLD_FLUSH_EVERY_TICKS === 0;
		if (world) this.flushWorld(tick);
		if (world || tick % FX_FLUSH_EVERY_TICKS === 0) this.flushFx(tick);
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
				// the viewer's interest point is where their body is (`interestPoint`), or an admin's free camera
				const v = this.liveView(viewer.slot);
				const dx = (v !== undefined ? v.x : viewer.state.x) - p.x;
				const dy = (v !== undefined ? v.y : viewer.state.y) - p.y;
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

	/**
	 * One ZombieDied, to each client that is DRAWING that zombie (§4.3, §4.4): a snapshot carried it to them and not so
	 * long ago that their track retired. In range was not enough (audit L2): a zombie in the dark or in a building is in
	 * range and never sent, and its death told them where it had been.
	 */
	private announceZombieDeath(d: ZombieDeath): void {
		const now = this.now();
		for (const viewer of this.sim.survivors()) {
			if (!this.hordeRings.hasTrack(viewer.slot, d.netId, now)) continue;
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
		this.urgent = false;
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
	 * The effects since the last flush, one batch per client (audit M3: on the snapshot's cadence, stamped with this
	 * tick, which is when the client plays them), each to the viewers it may reach (§4.3):
	 *   - a `Shake` to the survivor it belongs to, and nobody else;
	 *   - anything else inside the viewer's outermost interest ring (INTEREST_EXIT, so a tracer and the zombie it hits
	 *     arrive together), and -- when it shows something the roof or the dark hides: a zombie's blood or debris, a
	 *     spit, a sound, a shot's hit on a zombie -- only where the viewer could see it (`seesAt`, audit L2): a zombie
	 *     the snapshot withholds in the dark used to be given away by its own blood;
	 *   - a `ProjEnd` to the viewers its `ProjSpawn` went to.
	 * The shooter always gets their own shot whole: it is their feedback, and their client drew the line already.
	 */
	private flushFx(tick: number): void {
		if (this.fxQueue.size() === 0) return;
		const dark = worldIsDark(this.sim.clock.darkAlpha);
		this.prepareFx(dark);
		for (const viewer of this.sim.survivors()) {
			const list = this.fxForViewer;
			list.clear();
			// the viewer's interest point: the body, or an admin's free camera while it is live (§10)
			const view = this.liveView(viewer.slot);
			const vx = view !== undefined ? view.x : viewer.state.x;
			const vy = view !== undefined ? view.y : viewer.state.y;
			const vb = this.buildingIdAt(vx, vy);
			// this viewer's copies of the shots (`shotFor`) are encoded below, before the next viewer's are made
			this.shotsUsed = 0;
			for (const en of this.fxEntries) {
				const e = en.e;
				if (e.t === FxType.Shake) {
					if (e.slot === viewer.slot) list.push(e);
					continue;
				}
				if (e.t === FxType.ProjEnd) {
					const seen = this.projSeen.get(e.projId);
					if (seen !== undefined) {
						if (maskHas(seen, viewer.slot)) list.push(e);
						continue;
					}
				}
				if (!en.placed) {
					list.push(e);
					continue;
				}
				const dx = en.x - vx;
				const dy = en.y - vy;
				const d2 = dx * dx + dy * dy;
				if (d2 > FX_RANGE2) continue;
				if (e.t === FxType.Shot) {
					const shown = this.shotFor(en, e, viewer.slot, vb, vx, vy);
					if (shown !== undefined) list.push(shown);
					continue;
				}
				if (en.sight && !this.seesAt(vb, en.building, en.lit, d2)) continue;
				if (en.fromSight) {
					const fx = en.fromX - vx;
					const fy = en.fromY - vy;
					if (!this.seesAt(vb, en.fromBuilding, en.fromLit, fx * fx + fy * fy)) continue;
				}
				list.push(e);
				if (e.t === FxType.ProjSpawn) this.noteProj(e.projId, viewer.slot);
			}
			if (list.size() === 0) continue;
			const res = encodeFx({ tick, events: list });
			this.stats.droppedEvents += res.dropped;
			for (const packet of res.packets) {
				const len = buffer.len(packet);
				if (len > UNRELIABLE_PAYLOAD_LIMIT || len > FX_MAX_BYTES) {
					this.stats.droppedEvents += 1;
					continue;
				}
				this.transport.fx(viewer.slot, packet);
				this.stats.fxPackets += 1;
				this.stats.fxBytes += len;
				this.addBytes(viewer.slot, len + REMOTE_OVERHEAD_BYTES);
			}
		}
		// every end of this batch has gone to whoever saw its spawn: the projectile is over
		for (const en of this.fxEntries) {
			const e = en.e;
			if (e.t === FxType.ProjEnd) this.projSeen.delete(e.projId);
		}
		this.fxQueue.clear();
	}

	/** places every effect of the batch once (`FxEntry`): where it is, and what of it the dark or a roof may hide */
	private prepareFx(dark: boolean): void {
		const entries = this.fxEntries;
		entries.clear();
		for (const e of this.fxQueue) {
			let en = this.fxEntryPool[entries.size()];
			if (en === undefined) {
				en = {
					e,
					placed: false,
					x: 0,
					y: 0,
					sight: false,
					building: 0,
					lit: true,
					fromSight: false,
					fromX: 0,
					fromY: 0,
					fromBuilding: 0,
					fromLit: true,
					atShooter: false,
					zombieHits: false,
					hitSight: [],
					hitBuilding: [],
					hitLit: [],
					missMade: [],
					misses: [],
				};
				this.fxEntryPool.push(en);
			}
			en.e = e;
			en.placed = false;
			en.sight = false;
			en.building = 0;
			en.lit = true;
			en.fromSight = false;
			en.atShooter = false;
			en.zombieHits = false;
			entries.push(en);
			if (e.t === FxType.Shake) continue;
			if (e.t === FxType.Shot) {
				this.prepareShot(en, e, dark);
				continue;
			}
			if (e.t === FxType.Tracer) {
				if (e.kind === BOSS_TRACER) {
					// a boss's beam, from the boss: sent in range, as the boss is
					this.place(en, e.x1, e.y1);
				} else {
					// a machine's: its end is a zombie, and a zap chained from one starts at a zombie too (L7)
					this.place(en, e.x2, e.y2);
					en.sight = true;
					if (e.machine !== true) {
						en.fromSight = true;
						en.fromX = e.x1;
						en.fromY = e.y1;
						en.fromBuilding = this.buildingIdAt(e.x1, e.y1);
						en.fromLit = !dark || this.litAt(e.x1, e.y1);
					}
				}
			} else if (e.t === FxType.SolidShake) {
				if (e.x !== undefined && e.y !== undefined) this.place(en, e.x, e.y);
			} else {
				this.place(en, e.x, e.y);
				// what shows a zombie: its green blood, its debris (a chewed wall, an exploder), a spit, a sound. A survivor's
				// red blood, an explosion (its own light), a boss's needle, a survivor's arrow: sent in range, as a survivor
				// or a boss is
				if (e.t === FxType.Blood) {
					en.sight = e.kind === BloodKind.Green;
				} else if (e.t === FxType.Debris) {
					en.sight = e.material !== BOSS_DEBRIS;
				} else if (e.t === FxType.Sound) {
					en.sight = true;
				} else if (e.t === FxType.ProjSpawn) {
					en.sight = e.kind === ProjKind.Spit;
					this.openProj(e.projId);
				}
			}
			if (en.sight) {
				en.building = this.buildingIdAt(en.x, en.y);
				en.lit = !dark || this.litAt(en.x, en.y);
			}
		}
	}

	private place(en: FxEntry, x: number, y: number): void {
		en.placed = true;
		en.x = x;
		en.y = y;
	}

	/** a shot is placed at its shooter (or its first hit); each hit on a zombie carries its own sight */
	private prepareShot(en: FxEntry, e: FxShot, dark: boolean): void {
		const shooter = e.slot !== SLOT_NONE ? this.sim.get(e.slot) : undefined;
		if (shooter !== undefined) {
			this.place(en, shooter.state.x, shooter.state.y);
			en.atShooter = true;
		} else if (e.hits.size() > 0) {
			this.place(en, e.hits[0].x, e.hits[0].y);
		}
		let any = false;
		for (const h of e.hits) if (h.hit === HitKind.Zombie) any = true;
		en.zombieHits = any;
		if (!any) return;
		const sight = en.hitSight;
		const building = en.hitBuilding;
		const lit = en.hitLit;
		sight.clear();
		building.clear();
		lit.clear();
		en.missMade.clear();
		for (const h of e.hits) {
			const zombie = h.hit === HitKind.Zombie;
			sight.push(zombie);
			building.push(zombie ? this.buildingIdAt(h.x, h.y) : 0);
			lit.push(!zombie || !dark || this.litAt(h.x, h.y));
			en.missMade.push(false);
		}
	}

	/** §4.3 at a point the caller already placed: not behind a roof the viewer is not under, and seen in the dark */
	private seesAt(viewerBuilding: number, building: number, lit: boolean, dist2: number): boolean {
		return visibleThroughWalls(viewerBuilding, building) && visibleInDark(true, lit ? 1 : 0, dist2);
	}

	/**
	 * The shot as `slot` may see it: whole for its shooter and for a shot that hit no zombie; otherwise each hit on a
	 * zombie the viewer could not see is shown as the MISS it would have been (`missFor`): the pellet going on to the
	 * weapon's range or the first wall. Dropped, it told them just as much -- an ally's gun that fires and draws no line
	 * hit something in the dark (the security review of the net hardening, L7). A copy only then, from this viewer's
	 * pool (`scratchShot`); undefined when nothing is left to draw (no shooter to draw a miss from).
	 */
	private shotFor(en: FxEntry, e: FxShot, slot: number, vb: number, vx: number, vy: number): FxShot | undefined {
		if (e.slot === slot || !en.zombieHits) return e;
		const sight = en.hitSight;
		const building = en.hitBuilding;
		const lit = en.hitLit;
		const shown = this.shownScratch;
		shown.clear();
		let hidden = 0;
		const n = e.hits.size();
		for (let i = 0; i < n; i++) {
			const h = e.hits[i];
			const dx = h.x - vx;
			const dy = h.y - vy;
			const ok = !sight[i] || this.seesAt(vb, building[i], lit[i], dx * dx + dy * dy);
			shown.push(ok);
			if (!ok) hidden += 1;
		}
		if (hidden === 0) return e;
		const out = this.scratchShot(e);
		for (let i = 0; i < n; i++) {
			if (shown[i]) {
				out.hits.push(e.hits[i]);
				continue;
			}
			const miss = this.missFor(en, e, i);
			if (miss !== undefined) out.hits.push(miss);
		}
		shown.clear();
		return out.hits.size() > 0 ? out : undefined;
	}

	/**
	 * Hit `i` of `e` as a miss: from the shooter, through where it hit, on to the weapon's range or the first solid the
	 * shot stops at (combat.ts `trace`'s wall, without the zombie). Made once per flush for every viewer. Undefined
	 * with no shooter's body to draw it from.
	 */
	private missFor(en: FxEntry, e: FxShot, i: number): ShotHit | undefined {
		if (!en.atShooter) return undefined;
		let miss = en.misses[i];
		if (miss === undefined) {
			miss = { x: 0, y: 0, hit: HitKind.None };
			en.misses[i] = miss;
		}
		if (en.missMade[i]) return miss;
		en.missMade[i] = true;
		const h = e.hits[i];
		const ang = math.atan2(h.y - en.y, h.x - en.x);
		const range = WEAPONS[e.weapon]?.range ?? INTEREST_EXIT;
		const ray = raycast(this.sim.world, en.x, en.y, ang, range, blocksShots);
		miss.x = en.x + math.cos(ang) * ray.dist;
		miss.y = en.y + math.sin(ang) * ray.dist;
		const s = ray.solid;
		miss.hit =
			s === undefined ? HitKind.None : s.kind === "car" || s.kind === "tree" ? HitKind.MapItem : HitKind.Solid;
		return miss;
	}

	/** a Shot of this viewer's pool (reset per viewer in `flushFx`): `e` with its hits still to be filled */
	private scratchShot(e: FxShot): FxShot {
		let out = this.shotPool[this.shotsUsed];
		if (out === undefined) {
			out = { t: FxType.Shot, slot: e.slot, weapon: e.weapon, hits: [] };
			this.shotPool.push(out);
		}
		this.shotsUsed += 1;
		out.slot = e.slot;
		out.weapon = e.weapon;
		out.hits.clear();
		return out;
	}

	/**
	 * A projectile starts, seen by nobody yet (`noteProj` adds each viewer its ProjSpawn goes to): a spit nobody could
	 * see ends for nobody, instead of falling back to "everybody in range" at its end.
	 */
	private openProj(projId: number): void {
		if (!this.projSeen.has(projId) && this.projSeen.size() >= PROJ_SEEN_MAX) this.projSeen.clear();
		this.projSeen.set(projId, 0);
	}

	/** the ProjSpawn of `projId` went to `slot`: its ProjEnd will too */
	private noteProj(projId: number, slot: number): void {
		const mask = this.projSeen.get(projId) ?? 0;
		if (maskHas(mask, slot)) return;
		this.projSeen.set(projId, mask + 2 ** slot);
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
		const now = this.now();
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
				// the engine silently drops anything above the limit: never let it get that far unnoticed. What the part
				// carried is what is lost -- its zombies, and on part 0 the survivors and the bosses too (it counted one)
				if (len > UNRELIABLE_PAYLOAD_LIMIT || len > SNAP_MAX_BYTES) {
					this.stats.droppedEntities += carried + (i === 0 ? partZeroActors(snap) : 0);
					this.stats.droppedParts += 1;
					first += carried;
					continue;
				}
				this.transport.snap(viewer.slot, part);
				this.stats.snapParts += 1;
				this.stats.snapBytes += len;
				this.addBytes(viewer.slot, len + REMOTE_OVERHEAD_BYTES);
				this.noteCarried(viewer.slot, snap.zombies, first, carried, snap.tick, now);
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
		now: number,
	): void {
		const midExtra = midViewExtraTicks(this.sim.simHz);
		for (let k = from; k < from + count; k++) {
			const z = zombies[k];
			if (z !== undefined) this.hordeRings.noteSent(slot, z.netId, z.mid, tick, midExtra, now);
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
		const entries = classify(this.rings, this.viewCenter(viewer), points);
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
		const view = this.liveView(viewer.slot);
		const vx = view !== undefined ? view.x : viewer.state.x;
		const vy = view !== undefined ? view.y : viewer.state.y;
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
		const view = this.liveView(viewer.slot);
		const vx = view !== undefined ? view.x : viewer.state.x;
		const vy = view !== undefined ? view.y : viewer.state.y;
		for (const b of horde.bossRoster.list) {
			const netId = horde.bossRoster.netIdOf(b);
			if (netId < 1) continue;
			const dx = b.x - vx;
			const dy = b.y - vy;
			if (dx * dx + dy * dy > FX_RANGE2) continue;
			out.push(bossBlockOf(b, netId));
		}
		// the town's MAX_BOSSES and an admin's (§10) may stand together; the snapshot carries MAX_BOSSES, so the ones a
		// viewer gets are the nearest (the encoder keeps the first ones; one left out fades like any boss out of sight)
		if (out.size() > MAX_BOSSES) {
			out.sort(
				(a, b) =>
					(a.x - vx) * (a.x - vx) + (a.y - vy) * (a.y - vy) <
					(b.x - vx) * (b.x - vx) + (b.y - vy) * (b.y - vy),
			);
			while (out.size() > MAX_BOSSES) out.pop();
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
