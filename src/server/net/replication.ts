/*
 * What the server sends to each client (docs/MULTIPLAYER.md §4.1, §4.2, §4.3, §4.5, §4.6).
 *
 * F1 scope: the own block (with `ackSeq`, which is what the client reconciles against) and the other survivors,
 * plus the reliable player roster and the clock anchor. Zombies, bosses and Fx land in F2 on top of the same
 * pipeline — `buildSnapshot` already produces the full `Snapshot` shape of shared/net/protocol.ts.
 *
 *   Snap   unreliable, every SNAP_NEAR_EVERY_TICKS ticks (20 Hz); mid-ring players at 10 Hz (§4.3)
 *   World  reliable, batched per tick: InitBegin, PlayerJoined/Left, PlayerLife (§4.5)
 *
 * Pure module in the sense that matters for testing: it never touches an Instance. Everything leaves through a
 * `ReplicationTransport`, which server/net/remotes.ts implements with the real remotes and tools/test-server-sim.mjs
 * implements with an array (so the test decodes exactly the bytes a client would receive).
 */
import { quantPos, dequantPos } from "shared/net/codec";
import {
	MAX_PLAYERS,
	SNAP_NEAR_EVERY_TICKS,
	SNAP_MAX_BYTES,
	UNRELIABLE_PAYLOAD_LIMIT,
	WORLD_FLUSH_EVERY_TICKS,
} from "shared/net/mpConfig";
import {
	ModFlag,
	PlayerFlag,
	PlayerSnap,
	SelfFlag,
	SelfSnap,
	Snapshot,
	WorldEv,
	WorldEvent,
	encodeSnapshot,
	encodeWorld,
} from "shared/net/protocol";
import { WorldData } from "shared/game/world";
import { InterestTable, Positioned, classify, inSnapshot } from "./interest";
import { ServerPlayer, bufferDepth } from "../sim/players";
import { ServerSimulation } from "../sim/simulation";

/** rough per-event framing the engine adds on top of the payload; only used for the §12.2 bandwidth attribute */
export const REMOTE_OVERHEAD_BYTES = 20;

export interface ReplicationTransport {
	/** one Snap part to one client (unreliable) */
	snap(slot: number, part: buffer): void;
	/** one World batch to one client (reliable) */
	world(slot: number, packet: buffer): void;
	/** one World batch to every client in the world (reliable) */
	worldAll(packet: buffer): void;
}

export interface ReplicationStats {
	snapParts: number;
	snapBytes: number;
	worldPackets: number;
	worldBytes: number;
	/** entities that did not fit in SNAP_MAX_PARTS (always 0 in F1: at most 5 other players) */
	droppedEntities: number;
	/** World events that could not fit in a packet even alone */
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
 * The interest input of one entity. interest.ts deliberately knows nothing about a ServerPlayer: it classifies
 * plain (slot, x, y) points, which is the same shape F2 feeds it from the zombie spatial hash.
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

/** the snapshot one viewer gets this time round (§4.3: near every time, mid in rotation) */
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

/** the position a client will read back from a snapshot (0.5 u steps, §4.2) — used by the tests and by F2 */
export function wirePosition(v: number): number {
	return dequantPos(quantPos(v));
}

// ---------------------------------------------------------------- the replicator

export class Replicator {
	readonly stats: ReplicationStats = {
		snapParts: 0,
		snapBytes: 0,
		worldPackets: 0,
		worldBytes: 0,
		droppedEntities: 0,
		droppedEvents: 0,
	};
	/** bytes sent to each slot since the last `takeBytes` (§12.2 `pz_out_Bps`) */
	private readonly bytes = new Map<number, number>();
	private readonly rings = new InterestTable();
	private readonly broadcast = new Array<WorldEvent>();
	private readonly directed = new Map<number, Array<WorldEvent>>();
	private snapIndex = 0;

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
	 * Everything a joining client needs before its first snapshot (§7.1 step 6): the clock anchor and the map
	 * hash (§4.6, §4.5) and the roster, including itself. F3 adds the world deltas (constructions, doors, items)
	 * to the very same batch.
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
		// the roster the newcomer needs (itself included: that is how it learns its own slot), then the others
		const joined = joinedEvent(sp);
		for (const other of this.sim.players()) {
			this.queueFor(sp.slot, joinedEvent(other));
			if (other.slot !== sp.slot) this.queueFor(other.slot, joined);
		}
	}

	left(slot: number): void {
		this.rings.forget(slot);
		this.directed.delete(slot);
		this.bytes.delete(slot);
		this.queue({ t: WorldEv.PlayerLeft, slot });
	}

	/**
	 * §4.5 "derrubado/reviveu/morreu": a reliable life-state change. F1 only ever sends `Dead` (the snapshot's
	 * own flag is unreliable and a death must not be lost); F4 adds Downed/Revived with the same call.
	 */
	life(slot: number, state: number): void {
		this.queue({ t: WorldEv.PlayerLife, slot, state });
	}

	// ------------------------------------------------------------ per tick (§3.1 step 4)

	/** call once per simulation tick, after the step */
	afterTick(tick: number): void {
		if (tick % WORLD_FLUSH_EVERY_TICKS === 0) this.flushWorld(tick);
		if (tick % SNAP_NEAR_EVERY_TICKS === 0) this.sendSnapshots();
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

	private sendSnapshots(): void {
		const index = this.snapIndex;
		this.snapIndex = (this.snapIndex + 1) % MAX_PLAYERS;
		const everyone = this.sim.players();
		// one interest point per survivor, shared by every viewer of this round (§4.3)
		const points = interestPoints(everyone);
		for (const viewer of everyone) {
			const snap = buildSnapshot(this.sim, viewer, this.rings, index, points);
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
