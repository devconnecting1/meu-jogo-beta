/*
 * Snapshot reassembly and interpolation of everyone else (docs/MULTIPLAYER.md §4.2, §4.4, §5.1).
 *
 * A `Snap` packet is unreliable: it can be lost, duplicated, split in up to 4 self-contained parts and
 * delivered out of order (§1.1). So every part is merged into a per-entity history of samples ordered by
 * server tick, duplicates and stale packets are dropped, and the view reads a position INTERPOLATED for a
 * render time that sits `delay` behind the client's server-tick estimate:
 *
 *   renderTick = clockNow − delay × SIM_HZ            delay = clamp(2 × interval + 2 × jitter, 80, 250) ms
 *
 * The delay starts at 100 ms (two snapshot intervals at 20 Hz), adapts to the measured arrival interval and
 * jitter, and is only ever allowed to move by ±5 % of real time so it never shows up as a jolt (§5.1). When
 * the history runs dry the state is extrapolated with the velocity of the last two samples, for at most
 * EXTRAPOLATE_MAX_S and never through a wall, and then held still until a packet arrives.
 *
 * The render time is monotonic by construction: it is clamped against the previous frame's, so a tightening
 * buffer or a jittery clock can stall the movement for a frame but can never run it backwards.
 *
 * Pure: no Roblox service and no Instance (the world is only used for the extrapolation's wall check).
 */
import { angleLerp, lerp } from "shared/engine/vec2";
import { unwrapTick } from "shared/net/codec";
import {
	EXTRAPOLATE_MAX_S,
	INTERP_DEFAULT_S,
	INTERP_MAX_S,
	INTERP_MIN_S,
	SIM_HZ,
	SNAP_NEAR_HZ,
} from "shared/net/mpConfig";
import { PlayerSnap, SnapshotPart } from "shared/net/protocol";
import { circleBlocked, PLAYER_RADIUS } from "shared/game/physics";
import { WorldData } from "shared/game/world";

/** samples kept per entity: 1.5 s at 20 Hz, comfortably more than INTERP_MAX_S + EXTRAPOLATE_MAX_S */
const SAMPLES_PER_SLOT = 32;
/** a packet older than this many ticks behind the newest one is thrown away instead of inserted */
const MAX_REORDER_TICKS = 60;
/** the adaptive delay never moves faster than this fraction of real time (§5.1) */
const DELAY_MAX_RATE = 0.05;
/** weight of one arrival sample in the interval / jitter averages */
const ARRIVAL_ALPHA = 0.1;
/** a slot with no sample for this long is dropped even without a PlayerLeft (§4.4 safety net) */
const SLOT_TIMEOUT_S = 2;
/** walk-cycle phase per world unit travelled — the same constant the local survivor uses in the game loop */
export const FEET_CYCLE_PER_UNIT = 0.09;
/** a render time this far behind the previous frame's is a resync, not jitter: let it through */
const RENDER_RESET_S = 1;

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

class SlotTrack {
	readonly samples = new Array<Sample>();
	lastSeen = 0;
	feetCycle = 0;
	hasDrawn = false;
	drawnX = 0;
	drawnY = 0;

	/** inserts in tick order; ignores duplicates and packets too old to matter */
	insert(s: Sample): boolean {
		const list = this.samples;
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

	newestTick(): number {
		const n = this.samples.size();
		return n > 0 ? this.samples[n - 1].tick : -math.huge;
	}
}

export interface SnapshotStats {
	/** interpolation delay currently in use, seconds */
	delay: number;
	/** where the delay is heading (the adaptive target) */
	targetDelay: number;
	/** measured arrival interval and its mean deviation, seconds */
	interval: number;
	jitter: number;
	/** newest server tick any part has carried */
	newestTick: number;
	/** parts accepted, and those dropped as stale, duplicate or out of the reorder window */
	accepted: number;
	dropped: number;
	/** entities currently tracked */
	tracked: number;
	/** frames whose render time had to be held because it would have gone backwards */
	stalls: number;
}

export class SnapshotBuffer {
	private readonly tracks = new Map<number, SlotTrack>();
	private readonly out = new Array<RemoteState>();
	private simHz = SIM_HZ;
	private delayS = INTERP_DEFAULT_S;
	private targetS = INTERP_DEFAULT_S;
	private intervalS = 1 / SNAP_NEAR_HZ;
	private jitterS = 0;
	private arrivalSeen = false;
	private lastArrival = 0;
	private newest = -math.huge;
	private lastRender = -math.huge;
	private accepted = 0;
	private dropped = 0;
	private stalls = 0;

	/** the server's SIM_HZ, from InitBegin (§3.1: it may be the 30 Hz fallback) */
	setRate(simHz: number): void {
		if (simHz >= 1) this.simHz = simHz;
	}

	reset(): void {
		this.tracks.clear();
		this.out.clear();
		this.delayS = INTERP_DEFAULT_S;
		this.targetS = INTERP_DEFAULT_S;
		this.intervalS = 1 / SNAP_NEAR_HZ;
		this.jitterS = 0;
		this.arrivalSeen = false;
		this.newest = -math.huge;
		this.lastRender = -math.huge;
	}

	/** PlayerLeft (§4.4): stop drawing that slot at once */
	forget(slot: number): void {
		this.tracks.delete(slot);
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
			this.noteArrival(arrival);
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
		return true;
	}

	/** arrival interval and jitter → the §5.1 target delay */
	private noteArrival(arrival: number): void {
		if (this.arrivalSeen) {
			const gap = math.max(0, arrival - this.lastArrival);
			const dev = math.abs(gap - this.intervalS);
			this.intervalS += (gap - this.intervalS) * ARRIVAL_ALPHA;
			this.jitterS += (dev - this.jitterS) * ARRIVAL_ALPHA;
		}
		this.arrivalSeen = true;
		this.lastArrival = arrival;
		this.targetS = math.clamp(2 * this.intervalS + 2 * this.jitterS, INTERP_MIN_S, INTERP_MAX_S);
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
		this.delayS += math.clamp(diff, -maxMove, maxMove);
		const render = this.renderTick(clockTick);
		this.lastRender = render;
		this.out.clear();
		const gone = new Array<number>();
		for (const [slot, track] of this.tracks) {
			if (track.samples.size() === 0 || now - track.lastSeen > SLOT_TIMEOUT_S) {
				gone.push(slot);
				continue;
			}
			this.out.push(this.stateOf(slot, track, render, step, world));
		}
		for (const slot of gone) this.tracks.delete(slot);
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
			newestTick: this.newest,
			accepted: this.accepted,
			dropped: this.dropped,
			tracked: this.tracks.size(),
			stalls: this.stalls,
		};
	}
}
