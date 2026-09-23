/*
 * Snapshot reassembly and interpolation of everyone else (docs/MULTIPLAYER.md §4.2, §4.4, §5.1).
 *
 * A `Snap` packet is unreliable: it can be lost, duplicated, split in up to 4 self-contained parts and
 * delivered out of order (§1.1). So every part is merged into a per-entity history of samples ordered by
 * server tick, duplicates and stale packets are dropped, and the view reads a position INTERPOLATED for a
 * render time that sits `delay` behind the client's server-tick estimate:
 *
 *   renderTick = clockNow − delay × SIM_HZ
 *   delay      = lateness + clamp(interval + 2 × lateness deviation + 1 tick, 80, 250) ms
 *
 * `lateness` is MEASURED, not assumed: how far behind the client's clock each fresh snapshot lands (clockNow at
 * arrival − the tick it carries). It holds everything that keeps a snapshot from being there the instant its tick
 * happens: the downstream latency, the wait for the next client frame, the server's heartbeat bunching, and any
 * ticks the server DROPPED to get over a hitch (server/sim/simulation.ts `advance`) -- which shift its tick
 * numbering behind `tick0Time` for good. The first version of this buffer used `clamp(2 × interval + 2 × jitter)`
 * with no lateness in it, as if a snapshot arrived the moment it was made: the latency was paid out of the buffer,
 * and every dropped tick moved the render time closer to (and then past) the newest data. Measured in
 * tools/test-zombie-motion.mjs on the frame times of the owner's Studio playtest: 69 % of the zombie frames were
 * drawn extrapolated or held, 2.4-6.8 frozen frames a second per zombie -- the "laggy, with micro-stutters".
 *
 * The delay starts at the first measured value, and after that is only ever allowed to move by ±5 % of real time
 * so it never shows up as a jolt (§5.1); a gap wider than DELAY_SNAP_S is a resync and jumps. When the history
 * runs dry the state is extrapolated with the velocity of the last two samples, for at most EXTRAPOLATE_MAX_S and
 * never through a wall, and then held still until a packet arrives.
 *
 * A body sampled at the mid ring's 10 Hz (§4.3) needs one more near interval of buffer than one sampled at 20 Hz,
 * or half of its frames run past its newest sample. It is drawn that much further back, per track (`extra`), eased
 * at the same ±5 % when it changes ring (`easeExtra`): the near ring keeps the short delay, the wire stays as it is.
 *
 * The render time is monotonic by construction: it is clamped against the previous frame's, so a tightening
 * buffer or a jittery clock can stall the movement for a frame but can never run it backwards.
 *
 * Pure: no Roblox service and no Instance (the world is only used for the extrapolation's wall check).
 */
import { angleLerp, lerp } from "shared/engine/vec2";
import { unwrapTick } from "shared/net/codec";
import {
	DESPAWN_FADE_S,
	DESPAWN_MID_S,
	DESPAWN_NEAR_S,
	EXTRAPOLATE_MAX_S,
	INTERP_DEFAULT_S,
	INTERP_MAX_S,
	INTERP_MIN_S,
	SIM_HZ,
	SNAP_MID_HZ,
	SNAP_NEAR_HZ,
	ticksPer,
} from "shared/net/mpConfig";
import { BossSnap, PlayerSnap, SnapshotPart, ZombieSnap } from "shared/net/protocol";
import { circleBlocked, PLAYER_RADIUS } from "shared/game/physics";
import { ZOMBIE_BASE_RADIUS } from "shared/game/entities";
import { WorldData } from "shared/game/world";

/** samples kept per entity: 1.5 s at 20 Hz, comfortably more than INTERP_MAX_S + EXTRAPOLATE_MAX_S */
const SAMPLES_PER_SLOT = 32;
/** a packet older than this many ticks behind the newest one is thrown away instead of inserted */
const MAX_REORDER_TICKS = 60;
/** the adaptive delay never moves faster than this fraction of real time (§5.1) */
const DELAY_MAX_RATE = 0.05;
/** weight of one arrival sample in the interval / jitter averages, and in the lateness mean / deviation */
const ARRIVAL_ALPHA = 0.1;
/** ticks of margin on top of the measured lateness edge: a sample that lands exactly on time is already late */
const SAFETY_TICKS = 1;
/** a target this far from the delay in use is a resync (a long stall, a rejoin, a new run), not jitter: jump */
const DELAY_SNAP_S = 0.3;
/** a slot with no sample for this long is dropped even without a PlayerLeft (§4.4 safety net) */
const SLOT_TIMEOUT_S = 2;
/** walk-cycle phase per world unit travelled — the same constant the local survivor uses in the game loop */
export const FEET_CYCLE_PER_UNIT = 0.09;
/** a render time this far behind the previous frame's is a resync, not jitter: let it through */
const RENDER_RESET_S = 1;
/**
 * How fast a received body fades in and out, per second. It is the very rate the horde's own `updateAlpha`
 * used before F2 (shared/sim/ai/zombieBrain.ts), and §4.3 leans on it: with the interest hiding whatever is
 * outside every light at night, a zombie stepping into a lamp's circle appears — and this is what stops it
 * appearing as a pop. §4.4's despawn fade rides the same number.
 */
const ALPHA_RATE = 3;

/** one survivor as the interpolation sees them right now */
export interface RemoteState {
	slot: number;
	x: number;
	y: number;
	/** radians, interpolated the short way round */
	aim: number;
	/** feet direction, radians */
	moveAng: number;
	/**
	 * PlayerFlag bits of the newest sample at or before the render time.
	 *
	 * These are the CONTINUOUS bits and only those: walking, swinging, reloading, fired, flashlight. `Snap` is
	 * unreliable, so it is the right place for state that the next packet corrects anyway and the wrong place
	 * for state that must not be missed. Whether a survivor is up, down or dead comes from the reliable
	 * `PlayerLife` delta on the `World` channel (§4.5, §7.3), which netClient reads off the roster.
	 */
	flags: number;
	weapon: number;
	/** blade angle relative to the aim, radians */
	swing: number;
	/** 0..1 of their maximum hp */
	hp: number;
	/** revive progress 0..1 */
	revive: number;
	/** walk-cycle phase, advanced by the interpolated speed */
	feetCycle: number;
	/** interpolated speed in world units per second */
	speed: number;
	/** the render time is past the newest sample: the state is extrapolated or held */
	stale: boolean;
}

/**
 * One zombie as the interpolation sees it right now (§4.2's 9-byte record, made continuous again).
 *
 * In phase 2 the client SIMULATES nothing: every field here was decided on the server and every one that is
 * not on the wire is derived from what is — `feetCycle` from the distance actually travelled, `alpha` from
 * how long the body has been visible (§4.3's fade-in, §4.4's fade-out). There is no second horde to drift.
 */
export interface RemoteZombie {
	netId: number;
	x: number;
	y: number;
	/** the heading the server DREW with (`angleSlow`), interpolated the short way round */
	angle: number;
	/** ZombieFlag bits of the sample at or before the render time */
	flags: number;
	/** 1..ZOMBIE_TYPE_MAX */
	type: number;
	big: boolean;
	/** jump height, or the spitter's head recoil — which one is told by the flags */
	extra: number;
	/** walk-cycle phase, advanced by the interpolated speed */
	feetCycle: number;
	/** world units per second, from the interpolation */
	speed: number;
	/** 0..1: fades in when it appears and out when it stops arriving (§4.3, §4.4) */
	alpha: number;
	/** the render time is past the newest sample: the state is extrapolated or held */
	stale: boolean;
	/** the (fractional) server tick this body was drawn at: the buffer's render time, minus its ring's extra delay */
	tick: number;
}

/** one boss, interpolated. The centipede's body is rebuilt by the view from this head (§4.2) */
export interface RemoteBoss {
	netId: number;
	type: number;
	x: number;
	y: number;
	angle: number;
	/** 0..1 of its own maximum */
	hp: number;
	flags: number;
	/** the per-type animation counter (`moveCycle` / `movePos`) */
	phase: number;
	alpha: number;
	stale: boolean;
}

interface Sample {
	tick: number;
	x: number;
	y: number;
	aim: number;
	moveAng: number;
	flags: number;
	weapon: number;
	swing: number;
	hp: number;
	revive: number;
}

function sampleOf(tick: number, p: PlayerSnap): Sample {
	return {
		tick,
		x: p.x,
		y: p.y,
		aim: p.aim,
		moveAng: p.moveAng,
		flags: p.flags,
		weapon: p.weapon,
		swing: p.swing,
		hp: p.hp,
		revive: p.revive,
	};
}

/**
 * Inserts one sample in tick order, dropping duplicates (the §2.2 redundancy, a resent part) and anything so
 * far behind the newest that it can no longer be interpolated through. Shared by survivors, zombies and
 * bosses: `Snap` is unreliable and unordered for all three, so there is one answer to that, in one place.
 */
function insertSample<T extends { tick: number }>(list: Array<T>, s: T): boolean {
	const n = list.size();
	if (n > 0 && s.tick <= list[n - 1].tick - MAX_REORDER_TICKS) return false;
	let at = n;
	while (at > 0 && list[at - 1].tick > s.tick) at -= 1;
	if (at > 0 && list[at - 1].tick === s.tick) return false; // duplicate (redundant part or resend)
	list.push(s);
	for (let i = n; i > at; i--) list[i] = list[i - 1];
	list[at] = s;
	while (list.size() > SAMPLES_PER_SLOT) list.remove(0);
	return true;
}

/**
 * Moves a track's extra delay (ticks) towards `target` at no more than `maxStep`; a track that has none yet takes
 * its target at once (a body that first appears in the mid ring is drawn at the mid ring's delay from frame one).
 */
function easeExtra(current: number, target: number, maxStep: number): number {
	if (current < 0) return target;
	return current + math.clamp(target - current, -maxStep, maxStep);
}

class SlotTrack {
	readonly samples = new Array<Sample>();
	lastSeen = 0;
	feetCycle = 0;
	hasDrawn = false;
	drawnX = 0;
	drawnY = 0;
	/** this track's render delay on top of the buffer's, in ticks (the mid ring's spacing); -1 = unset */
	extra = -1;
	/**
	 * Tick gaps before the newest two samples. The wire does not say which ring an ally is in (§4.2), but the
	 * spacing does: two gaps of the mid interval in a row are the mid ring; one wide gap is just a lost packet.
	 */
	gapA = 0;
	gapB = 0;

	/** inserts in tick order; ignores duplicates and packets too old to matter */
	insert(s: Sample): boolean {
		const n = this.samples.size();
		const newest = n > 0 ? this.samples[n - 1].tick : undefined;
		const ok = insertSample(this.samples, s);
		if (ok && newest !== undefined && s.tick > newest) {
			this.gapB = this.gapA;
			this.gapA = s.tick - newest;
		}
		return ok;
	}

	newestTick(): number {
		const n = this.samples.size();
		return n > 0 ? this.samples[n - 1].tick : -math.huge;
	}
}

/** one sample of a zombie or a boss; the unused half is simply zero (a zombie has no hp on the wire) */
interface ActorSample {
	tick: number;
	x: number;
	y: number;
	angle: number;
	flags: number;
	type: number;
	big: boolean;
	extra: number;
	hp: number;
	phase: number;
}

class ActorTrack {
	readonly samples = new Array<ActorSample>();
	/** `arrival` of the newest sample: §4.4's despawn timeout is measured on it */
	lastSeen = 0;
	/** the entity was last seen in the mid ring, which gets 600 ms instead of 300 before it retires (§4.4) */
	mid = false;
	feetCycle = 0;
	alpha = 0;
	hasDrawn = false;
	drawnX = 0;
	drawnY = 0;
	/** this track's render delay on top of the buffer's, in ticks: the mid ring's wider spacing; -1 = unset */
	extra = -1;

	insert(s: ActorSample): boolean {
		return insertSample(this.samples, s);
	}
}

function zombieSample(tick: number, z: ZombieSnap): ActorSample {
	return {
		tick,
		x: z.x,
		y: z.y,
		angle: z.angle,
		flags: z.flags,
		type: z.type,
		big: z.big,
		extra: z.extra ?? 0,
		hp: 0,
		phase: 0,
	};
}

function bossSample(tick: number, b: BossSnap): ActorSample {
	return {
		tick,
		x: b.x,
		y: b.y,
		angle: b.angle,
		flags: b.flags,
		type: b.type,
		big: false,
		extra: b.extra,
		hp: b.hp,
		phase: b.phase,
	};
}

export interface SnapshotStats {
	/** interpolation delay currently in use, seconds (lateness + buffer) */
	delay: number;
	/** where the delay is heading (the adaptive target) */
	targetDelay: number;
	/** measured arrival interval and its mean deviation, seconds */
	interval: number;
	jitter: number;
	/** how far behind the client's clock a fresh snapshot lands, and its mean deviation, seconds */
	lateness: number;
	latenessDev: number;
	/** newest server tick any part has carried */
	newestTick: number;
	/** parts accepted, and those dropped as stale, duplicate or out of the reorder window */
	accepted: number;
	dropped: number;
	/** entities currently tracked */
	tracked: number;
	/** zombies and bosses currently tracked (§11.3 F2: the horde must be the same on every screen) */
	zombies: number;
	bosses: number;
	/** frames whose render time had to be held because it would have gone backwards */
	stalls: number;
}

/**
 * One scratch sample and one "was it extrapolated" flag, shared by every actor of a frame. The interpolation
 * answers hundreds of times per frame with a value nobody keeps past the next call, so a table per answer
 * would hand the collector the whole horde, twice a frame, for nothing.
 */
const SCRATCH: ActorSample = {
	tick: 0,
	x: 0,
	y: 0,
	angle: 0,
	flags: 0,
	type: 1,
	big: false,
	extra: 0,
	hp: 0,
	phase: 0,
};
let STALE = false;

function copySample(into: ActorSample, from: ActorSample): void {
	into.tick = from.tick;
	into.x = from.x;
	into.y = from.y;
	into.angle = from.angle;
	into.flags = from.flags;
	into.type = from.type;
	into.big = from.big;
	into.extra = from.extra;
	into.hp = from.hp;
	into.phase = from.phase;
}

export class SnapshotBuffer {
	private readonly tracks = new Map<number, SlotTrack>();
	private readonly out = new Array<RemoteState>();
	/** one track per zombie netId and per boss netId (§4.4: identity comes from the snapshot itself) */
	private readonly zombies = new Map<number, ActorTrack>();
	private readonly bosses = new Map<number, ActorTrack>();
	private readonly zOut = new Array<RemoteZombie>();
	private readonly bOut = new Array<RemoteBoss>();
	/** the view reads these every frame, so they are refilled in place instead of rebuilt */
	private readonly zPool = new Array<RemoteZombie>();
	private readonly bPool = new Array<RemoteBoss>();
	private readonly retire = new Array<number>();
	private simHz = SIM_HZ;
	private delayS = INTERP_DEFAULT_S;
	private targetS = INTERP_DEFAULT_S;
	private intervalS = 1 / SNAP_NEAR_HZ;
	private jitterS = 0;
	private arrivalSeen = false;
	private lastArrival = 0;
	/** lateness of the fresh snapshots (see the header), in ticks: running mean and mean deviation */
	private lateMean = 0;
	private lateDev = 0;
	/** the delay has been set from a measured lateness at least once since the last reset */
	private delayLocked = false;
	/** sample spacing of the near and mid rings at this server's rate, in ticks (3 and 6 at 60 Hz) */
	private nearTicks = ticksPer(SNAP_NEAR_HZ, SIM_HZ);
	private midTicks = ticksPer(SNAP_MID_HZ, SIM_HZ);
	private newest = -math.huge;
	private lastRender = -math.huge;
	private accepted = 0;
	private dropped = 0;
	private stalls = 0;

	/** the server's SIM_HZ, from InitBegin (§3.1: it may be the 30 Hz fallback) */
	setRate(simHz: number): void {
		if (simHz < 1) return;
		this.simHz = simHz;
		this.nearTicks = ticksPer(SNAP_NEAR_HZ, simHz);
		this.midTicks = ticksPer(SNAP_MID_HZ, simHz);
	}

	reset(): void {
		this.tracks.clear();
		this.zombies.clear();
		this.bosses.clear();
		this.out.clear();
		this.zOut.clear();
		this.bOut.clear();
		this.delayS = INTERP_DEFAULT_S;
		this.targetS = INTERP_DEFAULT_S;
		this.intervalS = 1 / SNAP_NEAR_HZ;
		this.jitterS = 0;
		this.arrivalSeen = false;
		this.lateMean = 0;
		this.lateDev = 0;
		this.delayLocked = false;
		this.newest = -math.huge;
		this.lastRender = -math.huge;
	}

	/** PlayerLeft (§4.4): stop drawing that slot at once */
	forget(slot: number): void {
		this.tracks.delete(slot);
	}

	/**
	 * `ZombieDied` (§4.4): the body is gone NOW, at the position the reliable event carries, and the view
	 * draws the blood and the corpse there. Letting the despawn timeout retire it instead would leave it
	 * standing for another 300 ms and then fade it out somewhere else entirely.
	 */
	forgetZombie(netId: number): void {
		this.zombies.delete(netId);
	}

	forgetBoss(netId: number): void {
		this.bosses.delete(netId);
	}

	/**
	 * One decoded `Snap` part. `refTick` is the client's current tick estimate (the wire tick is a u16 and
	 * has to be unwrapped against it); `arrival` any monotonic clock in seconds.
	 */
	receive(part: SnapshotPart, refTick: number, arrival: number): boolean {
		const tick = unwrapTick(part.tick, math.floor(refTick));
		if (this.newest > -math.huge && tick <= this.newest - MAX_REORDER_TICKS) {
			this.dropped += 1;
			return false;
		}
		if (tick > this.newest) {
			this.noteArrival(arrival, refTick - tick);
			this.newest = tick;
		}
		this.accepted += 1;
		for (const p of part.players) {
			let track = this.tracks.get(p.slot);
			if (track === undefined) {
				track = new SlotTrack();
				this.tracks.set(p.slot, track);
			}
			if (track.insert(sampleOf(tick, p))) track.lastSeen = arrival;
		}
		// §4.4 "implícitos pelo snapshot": a body the client has never seen IS its spawn, and the record
		// carries the type and the variant it needs to draw it — there is no reliable spawn event to wait for
		for (const z of part.zombies) {
			let track = this.zombies.get(z.netId);
			if (track === undefined) {
				track = new ActorTrack();
				this.zombies.set(z.netId, track);
			}
			if (track.insert(zombieSample(tick, z))) {
				track.lastSeen = arrival;
				track.mid = z.mid;
			}
		}
		for (const b of part.bosses) {
			let track = this.bosses.get(b.netId);
			if (track === undefined) {
				track = new ActorTrack();
				this.bosses.set(b.netId, track);
			}
			if (track.insert(bossSample(tick, b))) track.lastSeen = arrival;
		}
		return true;
	}

	/**
	 * One fresh snapshot: its arrival interval and jitter (the [PZ-NET] numbers) and its LATENESS (ticks between
	 * the tick it carries and the client's clock when it landed) → the §5.1 target delay.
	 *
	 *   target = lateness + clamp(near interval + 2 × lateness deviation + SAFETY_TICKS, INTERP_MIN_S, INTERP_MAX_S)
	 *
	 * The render time must stay behind the newest sample it can have: that sample left the server up to one near
	 * interval before `clock − lateness`, and lands a deviation or two later than the mean. Only the BUFFER part is
	 * clamped: the lateness is whatever the link and the server make it, and clamping it would put the render time
	 * past the data again (a Studio session that dropped a second of ticks has a second of lateness, for good).
	 */
	private noteArrival(arrival: number, late: number): void {
		if (this.arrivalSeen) {
			const gap = math.max(0, arrival - this.lastArrival);
			const dev = math.abs(gap - this.intervalS);
			this.intervalS += (gap - this.intervalS) * ARRIVAL_ALPHA;
			this.jitterS += (dev - this.jitterS) * ARRIVAL_ALPHA;
			const lateDev = math.abs(late - this.lateMean);
			this.lateMean += (late - this.lateMean) * ARRIVAL_ALPHA;
			this.lateDev += (lateDev - this.lateDev) * ARRIVAL_ALPHA;
		} else {
			this.lateMean = late;
			this.lateDev = 0;
		}
		this.arrivalSeen = true;
		this.lastArrival = arrival;
		const hz = this.simHz;
		const buffer = math.clamp(
			1 / SNAP_NEAR_HZ + (2 * this.lateDev + SAFETY_TICKS) / hz,
			INTERP_MIN_S,
			INTERP_MAX_S,
		);
		this.targetS = math.max(0, this.lateMean / hz) + buffer;
		if (!this.delayLocked) {
			// the first measurement IS the delay: easing to it from a guess at ±5 % would take seconds. Nothing has
			// been drawn from a sample yet, so the render time is re-based too instead of being held (a "stall")
			this.delayLocked = true;
			this.delayS = this.targetS;
			this.lastRender = -math.huge;
		}
	}

	/** current interpolation delay in seconds */
	delay(): number {
		return this.delayS;
	}

	/** the render time this frame, in (fractional) server ticks — never earlier than the last frame's */
	renderTick(clockTick: number): number {
		const want = clockTick - this.delayS * this.simHz;
		if (this.lastRender === -math.huge) return want;
		if (want < this.lastRender - RENDER_RESET_S * this.simHz) return want; // clock resync: follow it
		if (want < this.lastRender) {
			this.stalls += 1;
			return this.lastRender;
		}
		return want;
	}

	/**
	 * One render frame: eases the adaptive delay, moves the render time forward and rebuilds the
	 * interpolated state of every tracked survivor. `world` (the client's mirror) is optional and only used
	 * to keep an extrapolated survivor out of a wall.
	 */
	advance(dt: number, clockTick: number, now: number, world?: WorldData): void {
		const step = math.max(0, dt);
		const maxMove = DELAY_MAX_RATE * step;
		const diff = this.targetS - this.delayS;
		// a gap this wide is not jitter: a resync (a stall, a long hitch) is followed at once, and renderTick lets a
		// jump of more than RENDER_RESET_S through as well; anything smaller is eased, never felt
		if (math.abs(diff) > DELAY_SNAP_S) this.delayS = this.targetS;
		else this.delayS += math.clamp(diff, -maxMove, maxMove);
		const render = this.renderTick(clockTick);
		this.lastRender = render;
		// a track's own extra delay moves at the same ±5 % of real time as the buffer's
		const extraStep = maxMove * this.simHz;
		const midExtra = math.max(0, this.midTicks - this.nearTicks);
		this.out.clear();
		const gone = new Array<number>();
		for (const [slot, track] of this.tracks) {
			if (track.samples.size() === 0 || now - track.lastSeen > SLOT_TIMEOUT_S) {
				gone.push(slot);
				continue;
			}
			// the ring an ally is in shows in its own spacing: two mid-ring gaps in a row are the mid ring
			const spacing = track.gapA > 0 && track.gapB > 0 ? math.min(track.gapA, track.gapB) : this.nearTicks;
			track.extra = easeExtra(track.extra, math.clamp(spacing - this.nearTicks, 0, midExtra), extraStep);
			this.out.push(this.stateOf(slot, track, render - track.extra, step, world));
		}
		for (const slot of gone) this.tracks.delete(slot);
		this.advanceActors(render, step, now, world, extraStep, midExtra);
	}

	/**
	 * The horde and the bosses at the render time (§5.1), plus the two fades §4.3 and §4.4 lean on:
	 *
	 *   in   a body appears the first time a snapshot carries it — because it walked into a light, because
	 *        the viewer walked towards it, or because it just spawned. All three look the same from here,
	 *        and all three are covered by easing the alpha up instead of popping a body into frame.
	 *   out  a body that stops arriving for its ring's timeout (300 ms near, 600 ms mid) is retired over
	 *        DESPAWN_FADE_S. A body that DIED never comes through here: `ZombieDied` is reliable and takes
	 *        it away at once, at the place it fell.
	 */
	private advanceActors(
		render: number,
		dt: number,
		now: number,
		world: WorldData | undefined,
		extraStep: number,
		midExtra: number,
	): void {
		this.zOut.clear();
		this.bOut.clear();
		const retire = this.retire;
		retire.clear();
		for (const [netId, track] of this.zombies) {
			if (track.samples.size() === 0) {
				retire.push(netId);
				continue;
			}
			const missing = now - track.lastSeen > (track.mid ? DESPAWN_MID_S : DESPAWN_NEAR_S);
			track.alpha = math.clamp(track.alpha + (missing ? -dt / DESPAWN_FADE_S : dt * ALPHA_RATE), 0, 1);
			if (missing && track.alpha <= 0) {
				retire.push(netId);
				continue;
			}
			// the record says which ring it travels in (§4.2 `mid`): a mid-ring body is drawn one near interval
			// further back, so its 10 Hz samples are interpolated instead of run past
			track.extra = easeExtra(track.extra, track.mid ? midExtra : 0, extraStep);
			this.zOut.push(this.zombieStateOf(netId, track, render - track.extra, dt, world));
		}
		for (const netId of retire) this.zombies.delete(netId);
		retire.clear();
		for (const [netId, track] of this.bosses) {
			if (track.samples.size() === 0) {
				retire.push(netId);
				continue;
			}
			const missing = now - track.lastSeen > DESPAWN_MID_S;
			track.alpha = math.clamp(track.alpha + (missing ? -dt / DESPAWN_FADE_S : dt * ALPHA_RATE), 0, 1);
			if (missing && track.alpha <= 0) {
				retire.push(netId);
				continue;
			}
			this.bOut.push(this.bossStateOf(netId, track, render, world));
		}
		for (const netId of retire) this.bosses.delete(netId);
	}

	/**
	 * Position and heading of one actor at `render`, written into `SCRATCH`. Exactly the survivors' rule:
	 * interpolate between the two samples around the render time, extrapolate for at most EXTRAPOLATE_MAX_S
	 * when the buffer runs dry (never through a wall), then hold. The discrete fields — flags, type, the
	 * extra byte — come from the sample at or before the render time and are never blended: a hit flash
	 * halfway between on and off is not a state the server was ever in.
	 */
	private sampleAt(track: ActorTrack, render: number, radius: number, world?: WorldData): ActorSample {
		const list = track.samples;
		const n = list.size();
		const last = list[n - 1];
		const scratch = SCRATCH;
		if (render <= list[0].tick) {
			copySample(scratch, list[0]);
			STALE = false;
			return scratch;
		}
		if (render >= last.tick) {
			STALE = true;
			copySample(scratch, last);
			const ahead = math.min(render - last.tick, EXTRAPOLATE_MAX_S * this.simHz);
			const prev = n > 1 ? list[n - 2] : undefined;
			if (prev !== undefined && last.tick > prev.tick && ahead > 0) {
				const span = last.tick - prev.tick;
				const ex = last.x + ((last.x - prev.x) / span) * ahead;
				const ey = last.y + ((last.y - prev.y) / span) * ahead;
				if (world === undefined || radius <= 0 || circleBlocked(world, ex, ey, radius) === undefined) {
					scratch.x = ex;
					scratch.y = ey;
				}
			}
			return scratch;
		}
		let i = n - 2;
		while (i > 0 && list[i].tick > render) i -= 1;
		const a = list[i];
		const b = list[i + 1];
		const span = b.tick - a.tick;
		const t = span > 0 ? math.clamp((render - a.tick) / span, 0, 1) : 0;
		copySample(scratch, a);
		scratch.x = lerp(a.x, b.x, t);
		scratch.y = lerp(a.y, b.y, t);
		scratch.angle = angleLerp(a.angle, b.angle, t);
		scratch.hp = lerp(a.hp, b.hp, t);
		scratch.extra = lerp(a.extra, b.extra, t);
		STALE = false;
		return scratch;
	}

	private zombieStateOf(
		netId: number,
		track: ActorTrack,
		render: number,
		dt: number,
		world?: WorldData,
	): RemoteZombie {
		const at = this.sampleAt(track, render, ZOMBIE_BASE_RADIUS, world);
		const stale = STALE;
		let speed = 0;
		if (track.hasDrawn && dt > 0) {
			const dx = at.x - track.drawnX;
			const dy = at.y - track.drawnY;
			const moved = math.sqrt(dx * dx + dy * dy);
			// the feet are driven by the distance the body actually covered, the way an ally's are: the wire
			// carries no walk cycle, and one derived from the drawn movement cannot desync from the drawing
			track.feetCycle += moved * FEET_CYCLE_PER_UNIT;
			speed = moved / dt;
		}
		track.drawnX = at.x;
		track.drawnY = at.y;
		track.hasDrawn = true;
		let out = this.zPool[this.zOut.size()];
		if (out === undefined) {
			out = {
				netId,
				x: 0,
				y: 0,
				angle: 0,
				flags: 0,
				type: 1,
				big: false,
				extra: 0,
				feetCycle: 0,
				speed: 0,
				alpha: 0,
				stale: false,
				tick: 0,
			};
			this.zPool.push(out);
		}
		out.netId = netId;
		out.x = at.x;
		out.y = at.y;
		out.angle = at.angle;
		out.flags = at.flags;
		out.type = at.type;
		out.big = at.big;
		out.extra = at.extra;
		out.feetCycle = track.feetCycle;
		out.speed = speed;
		out.alpha = track.alpha;
		out.stale = stale;
		out.tick = render;
		return out;
	}

	private bossStateOf(netId: number, track: ActorTrack, render: number, world?: WorldData): RemoteBoss {
		const at = this.sampleAt(track, render, 0, world);
		const stale = STALE;
		let out = this.bPool[this.bOut.size()];
		if (out === undefined) {
			out = { netId, type: 1, x: 0, y: 0, angle: 0, hp: 0, flags: 0, phase: 0, alpha: 0, stale: false };
			this.bPool.push(out);
		}
		out.netId = netId;
		out.type = at.type;
		out.x = at.x;
		out.y = at.y;
		out.angle = at.angle;
		out.hp = at.hp;
		out.flags = at.flags;
		out.phase = at.phase;
		out.alpha = track.alpha;
		out.stale = stale;
		return out;
	}

	/** the interpolated horde of this frame (rebuilt by advance; do not keep the array) */
	zombieStates(): ReadonlyArray<RemoteZombie> {
		return this.zOut;
	}

	/** the interpolated bosses of this frame (rebuilt by advance; do not keep the array) */
	bossStates(): ReadonlyArray<RemoteBoss> {
		return this.bOut;
	}

	/** the interpolated (or extrapolated) state of one survivor at `render` */
	private stateOf(slot: number, track: SlotTrack, render: number, dt: number, world?: WorldData): RemoteState {
		const list = track.samples;
		const n = list.size();
		let x: number;
		let y: number;
		let aim: number;
		let moveAng: number;
		let swing: number;
		let hp: number;
		let revive: number;
		let base: Sample;
		let stale = false;

		const last = list[n - 1];
		if (render <= list[0].tick) {
			base = list[0];
			x = base.x;
			y = base.y;
			aim = base.aim;
			moveAng = base.moveAng;
			swing = base.swing;
			hp = base.hp;
			revive = base.revive;
		} else if (render >= last.tick) {
			stale = true;
			base = last;
			aim = last.aim;
			moveAng = last.moveAng;
			swing = last.swing;
			hp = last.hp;
			revive = last.revive;
			const ahead = math.min(render - last.tick, EXTRAPOLATE_MAX_S * this.simHz);
			const prev = n > 1 ? list[n - 2] : undefined;
			if (prev !== undefined && last.tick > prev.tick && ahead > 0) {
				const span = last.tick - prev.tick;
				const ex = last.x + ((last.x - prev.x) / span) * ahead;
				const ey = last.y + ((last.y - prev.y) / span) * ahead;
				if (world === undefined || circleBlocked(world, ex, ey, PLAYER_RADIUS) === undefined) {
					x = ex;
					y = ey;
				} else {
					x = last.x;
					y = last.y;
				}
			} else {
				x = last.x;
				y = last.y;
			}
		} else {
			let i = n - 2;
			while (i > 0 && list[i].tick > render) i -= 1;
			const a = list[i];
			const b = list[i + 1];
			const span = b.tick - a.tick;
			const t = span > 0 ? math.clamp((render - a.tick) / span, 0, 1) : 0;
			// discrete bits (walking, firing, downed, weapon) are not interpolated: they are the state the
			// render time is actually in, i.e. the sample at or before it
			base = a;
			x = lerp(a.x, b.x, t);
			y = lerp(a.y, b.y, t);
			aim = angleLerp(a.aim, b.aim, t);
			moveAng = angleLerp(a.moveAng, b.moveAng, t);
			swing = lerp(a.swing, b.swing, t);
			hp = lerp(a.hp, b.hp, t);
			revive = lerp(a.revive, b.revive, t);
		}

		let speed = 0;
		if (track.hasDrawn && dt > 0) {
			const dx = x - track.drawnX;
			const dy = y - track.drawnY;
			const moved = math.sqrt(dx * dx + dy * dy);
			track.feetCycle += moved * FEET_CYCLE_PER_UNIT;
			speed = moved / dt;
		}
		track.drawnX = x;
		track.drawnY = y;
		track.hasDrawn = true;

		return {
			slot,
			x,
			y,
			aim,
			moveAng,
			flags: base.flags,
			weapon: base.weapon,
			swing,
			hp,
			revive,
			feetCycle: track.feetCycle,
			speed,
			stale,
		};
	}

	/** the interpolated survivors of this frame (rebuilt by advance; do not keep the array) */
	states(): ReadonlyArray<RemoteState> {
		return this.out;
	}

	/**
	 * The render time the last `advance` used, in (fractional) server ticks — what the Input packet reports as
	 * `viewTick`/`viewFrac` so the server rewinds to exactly what this client was drawing (§2.2, §2.3). Reading it
	 * back instead of recomputing it matters: `renderTick` has the monotonic clamp as a side effect, so calling it
	 * twice in a frame would count a stall that never happened.
	 */
	renderNow(): number {
		return this.lastRender === -math.huge ? 0 : this.lastRender;
	}

	stats(): SnapshotStats {
		return {
			delay: this.delayS,
			targetDelay: this.targetS,
			interval: this.intervalS,
			jitter: this.jitterS,
			lateness: this.lateMean / this.simHz,
			latenessDev: this.lateDev / this.simHz,
			newestTick: this.newest,
			accepted: this.accepted,
			dropped: this.dropped,
			tracked: this.tracks.size(),
			zombies: this.zombies.size(),
			bosses: this.bosses.size(),
			stalls: this.stalls,
		};
	}
}
