/*
 * Client clock: which server tick this client is living in (docs/MULTIPLAYER.md §4.6).
 *
 *   tickEstimado = (workspace:GetServerTimeNow() − tick0Time) × SIM_HZ
 *
 * `tick0Time` and `simHz` arrive in the WorldInit's InitBegin event (§4.5); until then the clock is not
 * locked and netActive() stays false. GetServerTimeNow() is already the server's clock, so the raw estimate
 * is right — but it is a *sampled* clock: it can step by a few milliseconds when the engine re-syncs, and
 * the render time of everyone else is derived from it (§5.1), so a step would show up as a jolt on every
 * other survivor at once. So the estimate the rest of the client reads is a free-running tick counter,
 * advanced by the frame's dt and pulled towards the raw estimate at no more than CLOCK_MAX_RATE of real
 * time (the same ±5 % render-clock dilation §5.1 allows). Only a gross error (a rejoin, a suspended tab,
 * the epoch changing) re-locks instantly.
 *
 * The epoch is RE-ANCHORED on the server's own tick (`noteServerTick`). `tick0Time + tick / SIM_HZ` holds only
 * while the server never loses time, and it does lose time: a hitch past its small Heartbeat debt, a Studio
 * breakpoint (server/sim/heartbeat.ts). Every TimePong carries the server's clock and its tick, stamped in the
 * same instant (server/net/mpHost.ts), so `serverTime − serverTick / SIM_HZ` is where tick 0 would have to be
 * for the world to be where it is: tick0Time plus every second the server dropped, plus a positive scrap (the
 * part of a tick not yet run, the wait for the next Heartbeat). The lowest of the last EPOCH_SAMPLES is the
 * anchor, and the smoothed tick eases onto it like any other error (±5 %, or a re-lock past CLOCK_SNAP_S).
 * With a fixed epoch the review of 2026-09-23 found a 10 s breakpoint left every client ~9.8 s "behind" for
 * good, and the server had to carry a debt that emptied the input queues just to keep the epoch true.
 *
 * Pure: no Roblox service is touched here. The caller passes `serverNow` (GetServerTimeNow) and `dt`, which
 * is also what lets tools/test-predict.mjs drive it with a simulated clock.
 */
import { isFiniteNumber } from "shared/net/codec";
import { SIM_HZ } from "shared/net/mpConfig";

/** above this error (seconds) the estimate is re-locked instead of eased: a rejoin or a long stall */
export const CLOCK_SNAP_S = 0.5;
/** the smoothed tick is never pulled faster than this fraction of real time (§5.1: ±5 %) */
export const CLOCK_MAX_RATE = 0.05;
/** time constant of the (rate-limited) correction */
export const CLOCK_TAU_S = 0.5;
/** weight of one RTT sample in the running average */
const RTT_ALPHA = 0.1;
/** a frame longer than this is treated as a stall: the clock re-locks instead of catching up slowly */
const MAX_FRAME_S = 0.5;
/** TimePongs whose lowest epoch is the anchor (one a second: the last 4 s) */
export const EPOCH_SAMPLES = 4;

export interface ClockStats {
	/** the clock is locked to an epoch (InitBegin arrived) */
	locked: boolean;
	/** smoothed − raw, in ticks: how much the smoothing is still holding back */
	offsetTicks: number;
	/** how many times the estimate had to be re-locked instead of eased */
	snaps: number;
	/** round trip time in seconds (TimeSync probe or Player:GetNetworkPing) */
	rtt: number;
	/** seconds the anchor has moved past InitBegin's tick0Time: the time the server dropped, as last measured */
	epochShift: number;
}

export class ClockSync {
	private tick0Time = 0;
	/** the anchor in use: tick0Time until a TimePong says the server's tick is behind it */
	private epoch = 0;
	private readonly anchors = new Array<number>();
	private anchorAt = 0;
	private simHz = SIM_HZ;
	private locked = false;
	private smooth = 0;
	private raw = 0;
	private snaps = 0;
	/** what the last update() moved the tick by BEYOND dt × simHz (the easing, or a re-lock), in ticks */
	private corrected = 0;
	private rttS = 0;
	private rttSeen = false;

	/** InitBegin (§4.5): the GetServerTimeNow() value of tick 0 and the server's SIM_HZ */
	setEpoch(tick0Time: number, simHz: number): void {
		if (!isFiniteNumber(tick0Time) || !isFiniteNumber(simHz) || simHz < 1) return;
		if (this.locked && this.tick0Time === tick0Time && this.simHz === simHz) return;
		// the same server announcing the same epoch again (a re-entry, MP-22's new town) keeps what the TimePongs
		// taught: the time it dropped is still dropped, the reset's own included
		if (this.tick0Time !== tick0Time || this.simHz !== simHz) {
			this.epoch = tick0Time;
			this.anchors.clear();
			this.anchorAt = 0;
		}
		this.tick0Time = tick0Time;
		this.simHz = simHz;
		this.locked = false;
	}

	/**
	 * A TimePong: the server's GetServerTimeNow() and its full tick, stamped together. Re-anchors the epoch on
	 * the lowest `serverTime − serverTick / simHz` of the last EPOCH_SAMPLES (see the header): never before
	 * tick0Time (the server cannot run ahead of its own clock), and ignored before InitBegin gave an epoch.
	 */
	noteServerTick(serverTime: number, serverTick: number): void {
		if (this.tick0Time === 0 || !isFiniteNumber(serverTime) || !isFiniteNumber(serverTick) || serverTick < 0) {
			return;
		}
		const at = math.max(this.tick0Time, serverTime - serverTick / this.simHz);
		if (this.anchors.size() < EPOCH_SAMPLES) this.anchors.push(at);
		else this.anchors[this.anchorAt] = at;
		this.anchorAt = (this.anchorAt + 1) % EPOCH_SAMPLES;
		let low = math.huge;
		for (const a of this.anchors) low = math.min(low, a);
		this.epoch = low;
	}

	/** the epoch is known and at least one sample has been taken */
	hasClock(): boolean {
		return this.locked;
	}

	/** ticks per second of the server this client is on (SIM_HZ, or the fallback 30 it reported) */
	rate(): number {
		return this.simHz;
	}

	/** drop the lock (leaving the world): the next update() re-locks on the current server time */
	reset(): void {
		this.locked = false;
		this.smooth = 0;
		this.raw = 0;
	}

	/** unsmoothed §4.6 estimate for `serverNow` = workspace:GetServerTimeNow() */
	rawTick(serverNow: number): number {
		if (!isFiniteNumber(serverNow)) return this.raw;
		return (serverNow - this.epoch) * this.simHz;
	}

	/**
	 * One frame. `serverNow` is workspace:GetServerTimeNow(); `dt` the frame time. Returns the smoothed
	 * (fractional) server tick, which never runs backwards unless the estimate had to be re-locked.
	 */
	update(dt: number, serverNow: number): number {
		this.corrected = 0;
		if (this.tick0Time === 0 && !this.locked && !isFiniteNumber(serverNow)) return this.smooth;
		const target = this.rawTick(serverNow);
		this.raw = target;
		const step = isFiniteNumber(dt) ? math.max(0, dt) : 0;
		if (!this.locked || step > MAX_FRAME_S) {
			if (this.locked) {
				this.snaps += 1;
				this.corrected = target - (this.smooth + step * this.simHz);
			}
			this.locked = true;
			this.smooth = target;
			return this.smooth;
		}
		this.smooth += step * this.simHz;
		const err = target - this.smooth;
		if (math.abs(err) > CLOCK_SNAP_S * this.simHz) {
			this.snaps += 1;
			this.corrected = err;
			this.smooth = target;
			return this.smooth;
		}
		const maxStep = CLOCK_MAX_RATE * this.simHz * step;
		let pull = err * math.min(1, step / CLOCK_TAU_S);
		if (pull > maxStep) pull = maxStep;
		else if (pull < -maxStep) pull = -maxStep;
		this.smooth += pull;
		this.corrected = pull;
		return this.smooth;
	}

	/**
	 * How far the last update() moved the tick beyond the frame's own dt × simHz, in ticks: the easing onto the raw
	 * estimate, or a re-lock. client/net/snapshotBuffer.ts `clockCorrected` takes it back out of the render time,
	 * which is measured against snapshot arrivals and has no use for the clock's own corrections.
	 */
	lastCorrection(): number {
		return this.corrected;
	}

	/** the smoothed (fractional) server tick of this frame */
	tickNow(): number {
		return this.smooth;
	}

	/** a measured round trip (TimeSync pong, or Player:GetNetworkPing on the server side) */
	noteRtt(rtt: number): void {
		if (!isFiniteNumber(rtt) || rtt < 0) return;
		const clamped = math.min(rtt, 5);
		this.rttS = this.rttSeen ? this.rttS + (clamped - this.rttS) * RTT_ALPHA : clamped;
		this.rttSeen = true;
	}

	rtt(): number {
		return this.rttS;
	}

	stats(): ClockStats {
		return {
			locked: this.locked,
			offsetTicks: this.smooth - this.raw,
			snaps: this.snaps,
			rtt: this.rttS,
			epochShift: this.epoch - this.tick0Time,
		};
	}
}
