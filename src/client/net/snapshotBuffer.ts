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
 * The delay LOCKS on the median of the first LOCK_SAMPLES latenesses after a reset (the first one alone may be a
 * straggler; it only gets the drawing started), and after that is only ever allowed to move by ±5 % of real time
 * so it never shows up as a jolt (§5.1). The one exception is a resync: RESYNC_SAMPLES fresh snapshots in a row
 * landing more than DELAY_SNAP_S away from the mean (a breakpoint, a rejoin) re-lock it the same way, and the
 * render time follows at once instead of holding. One straggler that far off is left out of the mean. When the
 * history runs dry the state is extrapolated with the velocity of the last two samples, for at most
 * EXTRAPOLATE_MAX_S and never through a wall, and then held still until a packet arrives.
 *
 * Two things the render time is kept clear of:
 *   - the CLOCK's corrections (`clockCorrected`): the lateness is measured against the clock, so when the clock
 *     eases or re-locks (client/net/clockSync.ts, which re-anchors on the server's tick) the mean and the delay move
 *     with it and the render time does not move at all;
 *   - a HITCH frame's overrun: a frame of HITCH_FRAME_S or more never carries the render time past the newest tick
 *     received. In one process (a Studio playtest) the server stood still for that frame too and simulated only
 *     what its Heartbeat debt allowed (server/sim/heartbeat.ts); the part of the frame it never simulated is added
 *     to the delay on the spot, which nobody sees -- the screen already stood still that long. Without it the
 *     render time ran past the data on every hitch and spent seconds easing back behind it.
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
import { seqDiff, unwrapTick, wrapU16 } from "shared/net/codec";
import {
	DESPAWN_FADE_S,
	DESPAWN_MID_S,
	DESPAWN_NEAR_S,
	EXTRAPOLATE_MAX_S,
	FX_HOLD_MAX_S,
	INTERP_DEFAULT_S,
	INTERP_MAX_S,
	INTERP_MIN_S,
	NET_ID_REUSE_DELAY_S,
	RENDER_DELAY_RATE,
	SIM_HZ,
	SNAP_NEAR_HZ,
	STREAM_QUIET_S,
	SURVIVOR_TELEPORT_UPS,
	TRACK_FADE_IN_RATE,
	TRACK_SNAP_SLACK_U,
	ZOMBIE_TELEPORT_UPS,
	midViewExtraTicks,
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
/**
 * the adaptive delay never moves faster than this fraction of real time (§5.1); a track's `extra` neither, and the
 * server mirrors that one (server/net/interest.ts `viewExtra`)
 */
const DELAY_MAX_RATE = RENDER_DELAY_RATE;
/** weight of one arrival sample in the interval / jitter averages, and in the lateness mean / deviation */
const ARRIVAL_ALPHA = 0.1;
/** ticks of margin on top of the measured lateness edge: a sample that lands exactly on time is already late */
const SAFETY_TICKS = 1;
/** fresh latenesses this far from the mean, RESYNC_SAMPLES in a row, are a resync (a breakpoint, a rejoin) */
const DELAY_SNAP_S = 0.3;
/** latenesses whose median locks the delay after a reset */
const LOCK_SAMPLES = 3;
/** far-off latenesses on the same side whose median re-locks it on a resync */
const RESYNC_SAMPLES = 2;
/** a client frame this long is a hitch: it never carries the render time past the newest tick received */
export const HITCH_FRAME_S = 0.05;
/** a slot with no sample for this long is dropped even without a PlayerLeft (§4.4 safety net) */
const SLOT_TIMEOUT_S = 2;
/** walk-cycle phase per world unit travelled — the same constant the local survivor uses in the game loop */
export const FEET_CYCLE_PER_UNIT = 0.09;
/**
 * A render time this far behind the previous frame's is a resync, not jitter: let it through. It is DELAY_SNAP_S,
 * not the 1 s it used to be: between the two, a jump back was HELD, and the whole horde stood frozen for up to a
 * second (the review of 2026-09-23). With the clock's corrections taken out and a re-lock re-basing the render
 * time itself, only a caller that skips `clockCorrected` can still get here.
 */
const RENDER_RESET_S = DELAY_SNAP_S;
/**
 * How fast a received body fades in and out, per second. It is the very rate the horde's own `updateAlpha`
 * used before F2 (shared/sim/ai/zombieBrain.ts), and §4.3 leans on it: with the interest hiding whatever is
 * outside every light at night, a zombie stepping into a lamp's circle appears — and this is what stops it
 * appearing as a pop. §4.4's despawn fade rides the same number. Shared with the server (TRACK_FADE_IN_RATE), which
 * has to know when a track that never fully appeared is gone (server/net/interest.ts `retiredAfterS`).
 */
const ALPHA_RATE = TRACK_FADE_IN_RATE;
/** the part ticks remembered to tell a gap in the whole stream from a gap in one track (`discontinuity`) */
const PART_TICKS_KEPT = 64;
/**
 * A body that walked on through a silence of the stream is drawn catching up with its interpolation, not jumping onto
 * it (`bridge`): the offset between where it was drawn and where the new data puts that same instant eases out with
 * this time constant, never faster than BRIDGE_CATCHUP_UPS -- under the 1.25x + 4 u a frame tools/test-zombie-motion.mjs
 * (l) allows any body, at any speed. A 400 ms burst leaves a walker ~28 u behind: gone in about half a second.
 */
const BRIDGE_TAU_S = 0.2;
const BRIDGE_CATCHUP_UPS = 150;
/** below this the bridge offset is dropped (under a tenth of a pixel) */
const BRIDGE_EPS = 0.05;

/** how a newer sample follows a zombie track (`SnapshotBuffer.discontinuity`) */
const Break = {
	/** one walk: interpolated as always */
	None: 0,
	/** the track must start again where the sample is, faded in: a re-entry, or a jump no zombie can make */
	Restart: 1,
	/** the whole stream went quiet for longer than the track's timeout, and the body walked on meanwhile */
	Stream: 2,
} as const;
type Break = (typeof Break)[keyof typeof Break];

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
	/** (VEI-05) the VehicleKind they ride at the sample at or before the render time, 0 on foot; `moveAng` is its heading */
	ride: number;
	/** 0..1: 1, except fading in where they appeared after a jump no survivor can walk (`allyJumped`, N3) */
	alpha: number;
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
	/** what the server decided it is doing (0 idle … 3 chasing, protocol decision 17), of the same sample as `flags` */
	aware: number;
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
	ride: number;
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
		ride: p.ride ?? 0,
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
	/** 1, or fading in after a restart where the survivor appeared (`SnapshotBuffer.allyJumped`, N3) */
	alpha = 1;
	/** the tick the track restarted at: nothing from before it joins it again (the body before the jump) */
	floor = -math.huge;

	/** inserts in tick order; ignores duplicates and packets too old to matter */
	insert(s: Sample): boolean {
		if (s.tick < this.floor) return false;
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
	/** a zombie's awareness state (0 for a boss) */
	aware: number;
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
	/** where it stands in the buffer's draw order (`SnapshotBuffer.zOrder`), or -1 */
	ix = -1;
	/**
	 * The tick the track (re)started at (`SnapshotBuffer.restartTrack`): a sample from before it belongs to the body it
	 * was before the break, and interpolated towards the new one it would draw the very slide the restart is for.
	 */
	floor = -math.huge;
	/** the render tick this track was last drawn at, and a stream silence it just came back from (`bridge`) */
	renderAt = -math.huge;
	bridge = false;
	/** what the drawing still owes its interpolation after a stream silence, eased out (BRIDGE_TAU_S) */
	offX = 0;
	offY = 0;

	constructor(readonly netId: number) {}

	insert(s: ActorSample): boolean {
		if (s.tick < this.floor) return false;
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
		aware: z.aware,
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
		aware: 0,
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
	/** zombie samples refused because the reliable `ZombieDied` had already buried that netId (§4.4, audit M1) */
	ghosts: number;
	/** frames whose render time had to be held because it would have gone backwards */
	stalls: number;
	/** times the delay was (re)locked from a median: once after a reset, then once per resync */
	relocks: number;
	/** seconds of hitch frames the render time did not run through, because no tick had arrived for them */
	absorbedS: number;
	/** zombie tracks started again, faded in, instead of drawn gliding: a re-entry or a teleport (`discontinuity`) */
	restarts: number;
	/** zombie tracks that came back after a silence of the whole stream and were kept, at their alpha (`discontinuity`) */
	bridged: number;
	/** survivor tracks restarted, faded in, where the survivor appeared (`allyJumped`, N3) */
	allyJumps: number;
}

/** the median of a few values (LOCK_SAMPLES), without touching the caller's array */
function medianOf(values: ReadonlyArray<number>): number {
	const s = new Array<number>();
	for (const v of values) {
		let at = s.size();
		s.push(v);
		while (at > 0 && s[at - 1] > v) {
			s[at] = s[at - 1];
			at -= 1;
		}
		s[at] = v;
	}
	const n = s.size();
	if (n === 0) return 0;
	return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
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
	aware: 0,
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
	into.aware = from.aware;
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
	/**
	 * The horde's DRAW order (perf audit M2): the view draws `zombieStates()` in this order and the renderer hands
	 * out sprite slots by it, so the order of one frame has to be the order of the next. It used to be the iteration
	 * order of `zombies` -- a Luau table keyed by sparse integers, whose order a recycled netId or a rehash could
	 * reshuffle wholesale, moving every walker's seven sprites to other slots in one frame. Here a new body is
	 * appended and a body that goes is replaced by the LAST one (`dropZombie`): a spawn writes one walker's sprites,
	 * a death two walkers', whatever the horde's size (tools/test-pool.mjs 10).
	 */
	private readonly zOrder = new Array<ActorTrack>();
	private readonly zOut = new Array<RemoteZombie>();
	private readonly bOut = new Array<RemoteBoss>();
	/** the view reads these every frame, so they are refilled in place instead of rebuilt */
	private readonly zPool = new Array<RemoteZombie>();
	private readonly bPool = new Array<RemoteBoss>();
	private readonly retire = new Array<number>();
	/**
	 * netId → the wire tick (u16) of the batch that carried its `ZombieDied` (§4.4, audit M1). `Snap` is unreliable and
	 * unordered against the reliable `World`: a part carrying that zombie ALIVE, from a tick before the death, can land
	 * after the death did -- by jitter, or because it was still sitting in netClient's queue -- and used to build a new
	 * track: the body stood up again for its ring's despawn timeout, 300 or 600 ms. A zombie sample of a buried netId
	 * at or before its death tick is refused. The server hands a netId out again only NET_ID_REUSE_DELAY_S later, so
	 * a newer sample is a new zombie and ends the tomb; `pruneTombs` drops the ones no sample can reach any more.
	 */
	private readonly tombs = new Map<number, number>();
	private ghosts = 0;
	/**
	 * Deaths waiting for the drawing to reach them (audit M3): netId -> the wire tick of its `ZombieDied` and when it
	 * arrived. The body is drawn `delay` behind the clock, so a death acted on the moment it lands took the body away
	 * while it was still walking to the spot it fell on -- and, once the effects wait for the render time
	 * (client/net/fxTimeline.ts), ahead of its own blood. It goes when the render time reaches the death's tick
	 * (`releaseDeaths`), never later than FX_HOLD_MAX_S: the rule the effects follow, so the kill's blood (the same
	 * tick, the same flush) plays on the very frame the body goes -- which is what lets client/view/fxView.ts pour one
	 * pool for the two. A mid-ring body, drawn one near interval further back, goes that 50 ms early, at 800 u and more.
	 */
	private readonly dying = new Map<number, { tick: number; at: number }>();
	/** the netIds whose death the last `advance` released (`takeDied`) */
	private readonly died = new Array<number>();
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
	/** the delay has been locked on a median of LOCK_SAMPLES latenesses since the last reset */
	private delayLocked = false;
	/** latenesses waiting to (re)lock the delay: the first ones after a reset, or a run of far-off ones */
	private readonly pending = new Array<number>();
	private relocks = 0;
	private absorbedTicks = 0;
	/** sample spacing of the near ring at this server's rate, in ticks (3 at 60 Hz; the mid ring's is 6) */
	private nearTicks = ticksPer(SNAP_NEAR_HZ, SIM_HZ);
	private newest = -math.huge;
	private lastRender = -math.huge;
	private accepted = 0;
	private dropped = 0;
	private stalls = 0;
	/** zombie tracks started again at a re-entry or a teleport (`restartTrack`) */
	private restarts = 0;
	/** zombie tracks that came back after a stream-wide silence and were kept as one walk (`discontinuity`) */
	private bridged = 0;
	/** survivor tracks restarted where the survivor appeared (`allyJumped`, N3) */
	private allyJumps = 0;
	/** arrival of the newest part accepted, any tick (`STREAM_QUIET_S`) */
	private lastPartAt = -math.huge;
	/** the last PART_TICKS_KEPT distinct ticks accepted parts carried, a ring (`partBetween`) */
	private readonly partTicks = new Array<number>();
	private partTickAt = 0;

	/** the server's SIM_HZ, from InitBegin (§3.1: it may be the 30 Hz fallback) */
	setRate(simHz: number): void {
		if (simHz < 1) return;
		this.simHz = simHz;
		this.nearTicks = ticksPer(SNAP_NEAR_HZ, simHz);
	}

	reset(): void {
		this.tracks.clear();
		this.zombies.clear();
		this.zOrder.clear();
		this.bosses.clear();
		this.tombs.clear();
		this.dying.clear();
		this.died.clear();
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
		this.pending.clear();
		this.newest = -math.huge;
		this.lastRender = -math.huge;
		this.lastPartAt = -math.huge;
		this.partTicks.clear();
		this.partTickAt = 0;
	}

	/**
	 * The client clock moved by `ticks` beyond the frame's own time (client/net/clockSync.ts `lastCorrection`:
	 * its easing, a re-lock, a new anchor). Called right after the clock's update, before this frame's snapshots
	 * are received. The lateness is measured against that clock, so the mean and the delay move with it and the
	 * render time -- clock minus delay -- does not move at all: which tick is drawn is decided by when the
	 * snapshots arrive, never by how the clock is being corrected.
	 */
	clockCorrected(ticks: number): void {
		if (ticks === 0 || !(ticks > -math.huge && ticks < math.huge) || !this.arrivalSeen) return;
		this.lateMean += ticks;
		for (let i = 0; i < this.pending.size(); i++) this.pending[i] += ticks;
		this.delayS += ticks / this.simHz;
		this.targetS += ticks / this.simHz;
	}

	/** PlayerLeft (§4.4): stop drawing that slot at once */
	forget(slot: number): void {
		this.tracks.delete(slot);
	}

	/**
	 * A zombie's body goes NOW (the client takes a `ZombieDied` through `zombieDied`, which waits for the drawing to
	 * reach it, audit M3; this is the immediate form, for a test or a tool). Letting the despawn timeout retire it
	 * instead would leave it standing for another 300 ms and then fade it out somewhere else entirely.
	 *
	 * `deathTick` is the wire tick (u16) of the World batch that carried the death: from here on a sample of this
	 * netId at or before it is from the dead body, and is refused (`tombs`, audit M1).
	 */
	forgetZombie(netId: number, deathTick?: number): void {
		this.dropZombie(netId);
		if (deathTick !== undefined) this.tombs.set(netId, wrapU16(deathTick));
	}

	/** a new zombie track, at the END of the draw order (`zOrder`) */
	private addZombie(netId: number): ActorTrack {
		const track = new ActorTrack(netId);
		track.ix = this.zOrder.size();
		this.zOrder.push(track);
		this.zombies.set(netId, track);
		return track;
	}

	/**
	 * Is a sample of this survivor, newer than all the track holds, further from the last one than any survivor can go
	 * in the time between (SURVIVOR_TELEPORT_UPS)? A stand-up at daybreak or a Rebirth at a safe spot, an admin moving
	 * the body: interpolated, the ally slid across the town for a snapshot interval as they appeared (review of 577c729,
	 * N3). The body is put where it is, faded in, as a zombie's is (`restartTrack`).
	 */
	private allyJumped(track: SlotTrack, tick: number, x: number, y: number): boolean {
		const n = track.samples.size();
		if (n === 0) return false;
		const last = track.samples[n - 1];
		const gap = tick - last.tick;
		if (gap <= 0) return false;
		const dx = x - last.x;
		const dy = y - last.y;
		const reach = (SURVIVOR_TELEPORT_UPS * gap) / this.simHz + TRACK_SNAP_SLACK_U;
		return dx * dx + dy * dy > reach * reach;
	}

	/**
	 * How does a sample of `track`, newer than all it holds, follow it? (review of 577c729, M1)
	 *
	 *   teleport  further from its last sample than any zombie can go in that time (ZOMBIE_TELEPORT_UPS): a netId the
	 *             server moved or handed to another body. The server gives a relocation a new netId, so this is the
	 *             client's guard for whatever else could; drawn, it was a body racing across the screen. Restart.
	 *   re-entry  nothing came for THIS track for longer than its ring's despawn timeout (§4.4) while the stream went on
	 *             carrying others: it left the interest, the light or the roof rule, or the snapshot cap skipped it, and
	 *             came back. Whatever it did meanwhile was not sent, and interpolating from where it was last seen showed
	 *             a body held, fading, then jumping to wherever the interpolation stood between the two. Restart.
	 *   silence   the same gap, but the WHOLE stream said nothing in it (no part at all between the two ticks: a loss
	 *             burst, a stalled link or server). The body did walk from one sample to the other, and every other body
	 *             went quiet with it: it is kept as one walk -- history and alpha -- exactly as a single lost snapshot
	 *             is -- and it catches up with what its extrapolation missed over ~0.2 s (`bridge`), never in one frame.
	 *             Measured in tools/test-zombie-motion.mjs (l), a 350 and a 400 ms burst: a restart faded every body
	 *             out to 0.05 and back in; dropping only the history jumped 43 u in one frame to the newest sample; kept
	 *             whole but snapped, 29.5 u in one frame; eased, 0 frames over the body's own speed.
	 */
	private discontinuity(track: ActorTrack, tick: number, x: number, y: number): Break {
		const n = track.samples.size();
		if (n === 0) return Break.None;
		const last = track.samples[n - 1];
		const gap = tick - last.tick;
		if (gap <= 0) return Break.None;
		const dx = x - last.x;
		const dy = y - last.y;
		const reach = (ZOMBIE_TELEPORT_UPS * gap) / this.simHz + TRACK_SNAP_SLACK_U;
		if (dx * dx + dy * dy > reach * reach) return Break.Restart;
		if (gap <= (track.mid ? DESPAWN_MID_S : DESPAWN_NEAR_S) * this.simHz) return Break.None;
		return this.partBetween(last.tick, tick) ? Break.Restart : Break.Stream;
	}

	/** did any accepted part carry a tick strictly between `from` and `to`? (the ring of `notePart`) */
	private partBetween(from: number, to: number): boolean {
		for (const t of this.partTicks) {
			if (t > from && t < to) return true;
		}
		return false;
	}

	/**
	 * One part accepted: its tick joins the ring `partBetween` reads, and a silence of the whole stream before it is
	 * forgiven to every track -- the despawn timeout counts the time the stream was talking, not the time it was quiet
	 * (`STREAM_QUIET_S`). A body that really left is still retired: from here on the stream talks, and it is not in it.
	 */
	private notePart(tick: number, arrival: number): void {
		const quiet = this.lastPartAt > -math.huge ? arrival - this.lastPartAt : 0;
		if (quiet > STREAM_QUIET_S) {
			const forgive = quiet - 1 / SNAP_NEAR_HZ;
			for (const track of this.zOrder) track.lastSeen += forgive;
			for (const [, track] of this.bosses) track.lastSeen += forgive;
		}
		if (arrival > this.lastPartAt) this.lastPartAt = arrival;
		const n = this.partTicks.size();
		const newest = n > 0 ? this.partTicks[(this.partTickAt + n - 1) % n] : undefined;
		if (tick === newest) return;
		if (n < PART_TICKS_KEPT) {
			this.partTicks.push(tick);
			return;
		}
		this.partTicks[this.partTickAt] = tick;
		this.partTickAt = (this.partTickAt + 1) % PART_TICKS_KEPT;
	}

	/**
	 * The track starts again at `tick` (see `discontinuity`): its history is dropped, so it is drawn at the new sample from
	 * the next frame on, never interpolated from the old one; it fades in from nothing there, like a body seen for the
	 * first time; and nothing from before `tick` may join it again (`floor`). Its place in the draw order and its extra
	 * delay stay: the server mirrors that delay per (viewer, netId) until the client would have retired the track, so it
	 * must go on easing as it was (server/net/interest.ts `noteSent`).
	 */
	private restartTrack(track: ActorTrack, tick: number): void {
		track.samples.clear();
		track.floor = tick;
		track.alpha = 0;
		track.hasDrawn = false;
		track.bridge = false;
		track.offX = 0;
		track.offY = 0;
		this.restarts += 1;
	}

	/** a zombie track goes: the last one of the draw order takes its place, so nobody else moves (`zOrder`) */
	private dropZombie(netId: number): void {
		const track = this.zombies.get(netId);
		if (track === undefined) return;
		this.zombies.delete(netId);
		const ix = track.ix;
		track.ix = -1;
		if (ix < 0 || this.zOrder[ix] !== track) return;
		const last = this.zOrder.pop();
		if (last === undefined || last === track) return;
		this.zOrder[ix] = last;
		last.ix = ix;
	}

	/**
	 * `ZombieDied` (§4.4), played when the drawing reaches it (audit M3): the body stays drawn until the render time
	 * reaches `deathTick` (the wire tick of the World batch that carried it), then goes with the corpse and the blood
	 * of the same tick (`takeDied`). From now on no part from before the death can bring the body back once it went
	 * (`tombs`, audit M1); until then its own late samples still land in its track, which is still drawn.
	 */
	zombieDied(netId: number, deathTick: number, now: number): void {
		const tick = wrapU16(deathTick);
		this.tombs.set(netId, tick);
		this.dying.set(netId, { tick, at: now });
	}

	/** the netIds whose death `advance` released since the last call, appended to `out` and cleared here */
	takeDied(out: Array<number>): Array<number> {
		for (const netId of this.died) out.push(netId);
		this.died.clear();
		return out;
	}

	/** is this sample of `netId`, at wire tick `tick16`, from a body the reliable channel already buried? */
	private buried(netId: number, tick16: number): boolean {
		const tomb = this.tombs.get(netId);
		if (tomb === undefined) return false;
		// a death still waiting for the drawing: the body is on screen, and its own late samples keep it smooth
		if (seqDiff(tick16, tomb) <= 0) return !(this.dying.has(netId) && this.zombies.has(netId));
		// newer than the death: the server gave the netId to a new zombie (never before NET_ID_REUSE_DELAY_S)
		this.tombs.delete(netId);
		return false;
	}

	/** tombs no sample can reach any more: past the reuse delay and the reorder window, relative to the newest tick */
	private pruneTombs(): void {
		if (this.tombs.size() === 0 || this.newest === -math.huge) return;
		const newest16 = wrapU16(this.newest);
		const keep = NET_ID_REUSE_DELAY_S * this.simHz + MAX_REORDER_TICKS;
		const gone = this.retire;
		gone.clear();
		for (const [netId, tomb] of this.tombs) {
			if (seqDiff(newest16, tomb) > keep) gone.push(netId);
		}
		for (const netId of gone) this.tombs.delete(netId);
		gone.clear();
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
		this.notePart(tick, arrival);
		for (const p of part.players) {
			let track = this.tracks.get(p.slot);
			if (track === undefined) {
				track = new SlotTrack();
				this.tracks.set(p.slot, track);
			} else if (this.allyJumped(track, tick, p.x, p.y)) {
				// put somewhere new (N3): drawn there from the next frame, faded in, never interpolated across the town
				track.samples.clear();
				track.floor = tick;
				track.alpha = 0;
				track.hasDrawn = false;
				track.gapA = 0;
				track.gapB = 0;
				this.allyJumps += 1;
			}
			if (track.insert(sampleOf(tick, p))) track.lastSeen = arrival;
		}
		// §4.4 "implícitos pelo snapshot": a body the client has never seen IS its spawn, and the record
		// carries the type and the variant it needs to draw it — there is no reliable spawn event to wait for
		const tick16 = wrapU16(tick);
		for (const z of part.zombies) {
			// ...except a body whose death already came in on the reliable channel: this part is older than it (M1)
			if (this.buried(z.netId, tick16)) {
				this.ghosts += 1;
				continue;
			}
			let track = this.zombies.get(z.netId);
			if (track === undefined) {
				track = this.addZombie(z.netId);
			} else {
				const kind = this.discontinuity(track, tick, z.x, z.y);
				if (kind === Break.Restart) {
					this.restartTrack(track, tick);
				} else if (kind === Break.Stream) {
					this.bridged += 1;
					track.bridge = true;
				}
			}
			if (track.insert(zombieSample(tick, z))) {
				track.lastSeen = arrival;
				track.mid = z.mid;
			}
		}
		for (const b of part.bosses) {
			let track = this.bosses.get(b.netId);
			if (track === undefined) {
				track = new ActorTrack(b.netId);
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
	 * past the data again (a Studio session that dropped a second of ticks has a second of lateness until the clock
	 * re-anchors). The lateness may be negative (a clock anchored a scrap late): the render time is the arrival's
	 * tick minus the buffer either way, so it is not clamped at zero either.
	 */
	private noteArrival(arrival: number, late: number): void {
		const first = !this.arrivalSeen;
		if (!first) {
			const gap = math.max(0, arrival - this.lastArrival);
			const dev = math.abs(gap - this.intervalS);
			this.intervalS += (gap - this.intervalS) * ARRIVAL_ALPHA;
			this.jitterS += (dev - this.jitterS) * ARRIVAL_ALPHA;
		}
		this.arrivalSeen = true;
		this.lastArrival = arrival;
		const hz = this.simHz;
		let lock = false;
		if (first) {
			// the drawing has to start somewhere: the first lateness, until LOCK_SAMPLES of them can outvote it
			this.pending.push(late);
			this.lateMean = late;
			this.lateDev = 0;
			lock = true;
		} else if (!this.delayLocked || math.abs(late - this.lateMean) > DELAY_SNAP_S * hz) {
			// the first few after a reset, or one far off: kept apart. A run of far-off ones on the same side is a
			// resync; a lone straggler (a packet that sat in a stalled link) is simply never averaged in
			if (this.delayLocked && this.pending.size() > 0) {
				const side = this.pending[0] > this.lateMean;
				if (late > this.lateMean !== side) this.pending.clear();
			}
			this.pending.push(late);
			// a resync re-locks on two: the drawing stands still while it waits (the render time is past the data), and
			// two far-off samples on the same side, 50 ms apart, are no longer one packet stuck in a link
			if (this.pending.size() >= (this.delayLocked ? RESYNC_SAMPLES : LOCK_SAMPLES)) {
				// the median and the median deviation: the straggler that was first after a reset outvoted on both
				const mid = medianOf(this.pending);
				const spread = new Array<number>();
				for (const v of this.pending) spread.push(math.abs(v - mid));
				this.lateMean = mid;
				this.lateDev = medianOf(spread);
				this.pending.clear();
				this.delayLocked = true;
				this.relocks += 1;
				lock = true;
			}
		} else {
			this.pending.clear();
			const lateDev = math.abs(late - this.lateMean);
			this.lateMean += (late - this.lateMean) * ARRIVAL_ALPHA;
			this.lateDev += (lateDev - this.lateDev) * ARRIVAL_ALPHA;
		}
		const buffer = math.clamp(
			1 / SNAP_NEAR_HZ + (2 * this.lateDev + SAFETY_TICKS) / hz,
			INTERP_MIN_S,
			INTERP_MAX_S,
		);
		this.targetS = this.lateMean / hz + buffer;
		if (lock) {
			// a measured lateness IS the delay: easing onto it from a guess at ±5 % would take seconds. The render
			// time is re-based too instead of being held (a "stall"): after a reset nothing has been drawn from a
			// sample yet, and after a resync what is on screen is already a held or extrapolated body
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
		// always eased, never felt: the one jump is a (re)lock, which `noteArrival` makes and re-bases the render for
		this.delayS += math.clamp(this.targetS - this.delayS, -maxMove, maxMove);
		let render = this.renderTick(clockTick);
		// a hitch frame never carries the drawing past the newest tick received (see the header): what it would have
		// run through is time the server has not simulated yet, so it goes into the delay instead, all at once, unseen.
		// Only the delay: the target stays, and the delay eases back onto it at ±5 % as the server repays its debt
		if (step >= HITCH_FRAME_S && this.lastRender > -math.huge && this.newest > -math.huge && render > this.newest) {
			const held = math.max(this.newest, this.lastRender);
			if (render > held) {
				this.delayS += (render - held) / this.simHz;
				this.absorbedTicks += render - held;
				render = held;
			}
		}
		this.lastRender = render;
		// a track's own extra delay moves at the same ±5 % of real time as the buffer's
		const extraStep = maxMove * this.simHz;
		// the very number the server rewinds a mid-ring target by (server/net/replication.ts `viewLagOf`, §2.3)
		const midExtra = midViewExtraTicks(this.simHz);
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
		this.pruneTombs();
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
	 *        it away when the drawing reaches the death, at the place it fell (`releaseDeaths`, audit M3) -- and
	 *        a late part from before the death cannot stand it up again (`tombs`).
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
		// the retirements first, then the drawing: a body that goes is replaced by the last one (`dropZombie`), and
		// the frame that retires it already draws the order the next frames will
		this.releaseDeaths(render, now);
		// the whole stream is silent (a loss burst, a stalled link): nobody is missing from it, and every fade holds
		// where it is until it talks again (M1: the horde blinked out and back in at every burst of 300 ms and more)
		const quiet = now - this.lastPartAt > STREAM_QUIET_S;
		const order = this.zOrder;
		for (const track of order) {
			if (track.samples.size() === 0) {
				retire.push(track.netId);
				continue;
			}
			if (quiet) continue;
			const missing = now - track.lastSeen > (track.mid ? DESPAWN_MID_S : DESPAWN_NEAR_S);
			track.alpha = math.clamp(track.alpha + (missing ? -dt / DESPAWN_FADE_S : dt * ALPHA_RATE), 0, 1);
			if (missing && track.alpha <= 0) retire.push(track.netId);
		}
		for (const netId of retire) this.dropZombie(netId);
		retire.clear();
		for (const track of order) {
			// the record says which ring it travels in (§4.2 `mid`): a mid-ring body is drawn one near interval
			// further back, so its 10 Hz samples are interpolated instead of run past
			track.extra = easeExtra(track.extra, track.mid ? midExtra : 0, extraStep);
			this.zOut.push(this.zombieStateOf(track.netId, track, render - track.extra, dt, world));
		}
		for (const [netId, track] of this.bosses) {
			if (track.samples.size() === 0) {
				retire.push(netId);
				continue;
			}
			const missing = !quiet && now - track.lastSeen > DESPAWN_MID_S;
			if (!quiet) {
				track.alpha = math.clamp(track.alpha + (missing ? -dt / DESPAWN_FADE_S : dt * ALPHA_RATE), 0, 1);
			}
			if (missing && track.alpha <= 0) {
				retire.push(netId);
				continue;
			}
			this.bOut.push(this.bossStateOf(netId, track, render, world));
		}
		for (const netId of retire) this.bosses.delete(netId);
	}

	/** the deaths the drawing has reached (the render time is at the death's tick), or that waited FX_HOLD_MAX_S */
	private releaseDeaths(render: number, now: number): void {
		if (this.dying.size() === 0) return;
		const due = this.retire;
		due.clear();
		const at = math.floor(render);
		for (const [netId, d] of this.dying) {
			// no body drawn (retired, never carried): nothing to wait for
			const drawn = this.zombies.has(netId);
			if (!drawn || unwrapTick(d.tick, at) <= render || now - d.at >= FX_HOLD_MAX_S) due.push(netId);
		}
		for (const netId of due) {
			this.dying.delete(netId);
			this.dropZombie(netId);
			this.died.push(netId);
		}
		due.clear();
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
		if (track.bridge) this.bridge(track, world);
		const at = this.sampleAt(track, render, ZOMBIE_BASE_RADIUS, world);
		const stale = STALE;
		// a stream silence still being caught up with (`bridge`): drawn that much behind its interpolation, less every frame
		let x = at.x;
		let y = at.y;
		if (track.offX !== 0 || track.offY !== 0) {
			const len = math.sqrt(track.offX * track.offX + track.offY * track.offY);
			const shrink = math.min(len, (len * dt) / BRIDGE_TAU_S, BRIDGE_CATCHUP_UPS * dt);
			const left = len - shrink;
			if (left < BRIDGE_EPS) {
				track.offX = 0;
				track.offY = 0;
			} else {
				track.offX *= left / len;
				track.offY *= left / len;
			}
			x += track.offX;
			y += track.offY;
		}
		track.renderAt = render;
		let speed = 0;
		if (track.hasDrawn && dt > 0) {
			const dx = x - track.drawnX;
			const dy = y - track.drawnY;
			const moved = math.sqrt(dx * dx + dy * dy);
			// the feet are driven by the distance the body actually covered, the way an ally's are: the wire
			// carries no walk cycle, and one derived from the drawn movement cannot desync from the drawing
			track.feetCycle += moved * FEET_CYCLE_PER_UNIT;
			speed = moved / dt;
		}
		track.drawnX = x;
		track.drawnY = y;
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
				aware: 0,
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
		out.x = x;
		out.y = y;
		out.angle = at.angle;
		out.flags = at.flags;
		out.type = at.type;
		out.big = at.big;
		out.aware = at.aware;
		out.extra = at.extra;
		out.feetCycle = track.feetCycle;
		out.speed = speed;
		out.alpha = track.alpha;
		out.stale = stale;
		out.tick = render;
		return out;
	}

	/**
	 * The body came back from a silence of the whole stream as one walk (`discontinuity`): where it was drawn last frame
	 * -- extrapolated, then held, through the silence -- against where the new samples put that same instant. The
	 * difference is what the drawing owes, and it is paid back over BRIDGE_TAU_S instead of in one frame (M1).
	 */
	private bridge(track: ActorTrack, world?: WorldData): void {
		track.bridge = false;
		if (!track.hasDrawn || track.renderAt === -math.huge) return;
		const past = this.sampleAt(track, track.renderAt, ZOMBIE_BASE_RADIUS, world);
		track.offX = track.drawnX - past.x;
		track.offY = track.drawnY - past.y;
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
		if (track.alpha < 1) track.alpha = math.min(1, track.alpha + dt * ALPHA_RATE);

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
			ride: base.ride,
			alpha: track.alpha,
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
			ghosts: this.ghosts,
			stalls: this.stalls,
			relocks: this.relocks,
			absorbedS: this.absorbedTicks / this.simHz,
			restarts: this.restarts,
			bridged: this.bridged,
			allyJumps: this.allyJumps,
		};
	}
}
