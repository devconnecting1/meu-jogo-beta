/*
 * What the server sends to each client (docs/MULTIPLAYER.md §4.1, §4.2, §4.3, §4.4, §4.5, §4.6).
 *
 *   Snap   unreliable, every SNAP_NEAR_EVERY_TICKS ticks (20 Hz): the own block, the other survivors, the
 *          bosses and the horde — each entity filtered by the interest rings and the visibility rules of §4.3
 *   Fx     unreliable, one batch per tick when something happened: blood, debris, shakes, tracers, shots
 *   World  reliable, batched per tick: InitBegin, the roster, PlayerLife, ZombieDied, Clock, Announce (§4.5)
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
} from "shared/net/mpConfig";
import {
	AnnounceKind,
	BossSnap,
	DeathCause,
	FxEvent,
	ModFlag,
	PlayerFlag,
	PlayerSnap,
	SelfFlag,
	SelfSnap,
	Snapshot,
	WorldEv,
	WorldEvent,
	ZombieFlag,
	ZombieSnap,
	encodeFx,
	encodeSnapshot,
	encodeWorld,
} from "shared/net/protocol";
import { fxPosition, fxSlot, toWireFx } from "shared/net/fxWire";
import { FxEvent as SimFxEvent } from "shared/sim/types";
import { BossState, ZombieState } from "shared/game/entities";
import { WorldData, buildingAt } from "shared/game/world";
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
import { ServerPlayer, bufferDepth } from "../sim/players";
import { ServerSimulation } from "../sim/simulation";

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
		moveAng: sp.moveAng,
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
	const out: ZombieSnap = { netId, x: z.x, y: z.y, angle: 0, flags: 0, type: z.type, big: false, mid };
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

	constructor(
		private readonly sim: ServerSimulation,
		private readonly transport: ReplicationTransport,
		private readonly options: ReplicatorOptions,
	) {}

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
		this.queueFor(sp.slot, {
			t: WorldEv.InitBegin,
			mapHash: this.options.mapHash,
			tick0Time: this.options.tick0Time,
			simHz: this.sim.simHz,
			chunk: 0,
			chunks: 1,
		});
		// the hour, the day, the weather and the wave flags: a newcomer must not spend up to CLOCK_RESYNC_S
		// seconds in the wrong half of the day (§4.6)
		this.queueFor(sp.slot, this.sim.clock.clockEventNow(this.sim.tick));
		// the roster the newcomer needs (itself included: that is how it learns its own slot), then the others
		const joined = joinedEvent(sp);
		for (const other of this.sim.players()) {
			this.queueFor(sp.slot, joinedEvent(other));
			if (other.slot !== sp.slot) this.queueFor(other.slot, joined);
		}
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

	// ------------------------------------------------------------ per tick (§3.1 step 4)

	/** call once per simulation tick, after the step */
	afterTick(tick: number): void {
		this.collectWorldDeltas(tick);
		this.collectFx();
		if (tick % WORLD_FLUSH_EVERY_TICKS === 0) this.flushWorld(tick);
		this.flushFx(tick);
		if (tick % SNAP_NEAR_EVERY_TICKS === 0) this.sendSnapshots();
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
	}

	/** one ZombieDied, to each client that could see that zombie in the last rounds (§4.3, §4.4) */
	private announceZombieDeath(d: ZombieDeath): void {
		for (const viewer of this.sim.players()) {
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
				for (const sp of this.sim.players()) {
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
		if (this.fxQueue.size() === 0) return;
		for (const viewer of this.sim.players()) {
			const list = this.fxForViewer;
			list.clear();
			for (const e of this.fxQueue) {
				const slot = fxSlot(e);
				if (slot !== SLOT_NONE) {
					if (slot === viewer.slot) list.push(e);
					continue;
				}
				const at = fxPosition(e);
				if (at !== undefined && !this.inFxRange(viewer, at.x, at.y)) continue;
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
		const everyone = this.sim.players();
		// one interest point per survivor, shared by every viewer of this round (§4.3)
		const points = interestPoints(everyone);
		this.prepareHorde();
		for (const viewer of everyone) {
			const snap = this.snapshotFor(viewer, index, points);
			const res = encodeSnapshot(snap);
			this.stats.droppedEntities += res.dropped;
			for (const part of res.parts) {
				const len = buffer.len(part);
				// the engine silently drops anything above the limit: never let it get that far unnoticed
				if (len > UNRELIABLE_PAYLOAD_LIMIT || len > SNAP_MAX_BYTES) {
					this.stats.droppedEntities += 1;
					continue;
				}
				this.transport.snap(viewer.slot, part);
				this.stats.snapParts += 1;
				this.stats.snapBytes += len;
				this.addBytes(viewer.slot, len + REMOTE_OVERHEAD_BYTES);
			}
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
		costume: sp.costume,
		deco: sp.deco,
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
