/*
 * The effects of the `Fx` channel, played when the drawing reaches them (docs/MULTIPLAYER.md §4.1, §5.1; audit M3).
 *
 * Everybody else is drawn `delay` behind the clock (client/net/snapshotBuffer.ts: the measured lateness plus a
 * buffer, ~130-160 ms at 80-140 ms of RTT). An effect played the moment its batch lands is that much AHEAD of the
 * bodies it belongs to: an ally's tracer before the ally has turned to shoot, a zombie's blood before the zombie
 * reached the spot. So each effect keeps the server tick of its batch and waits here until the render time reaches
 * it -- the tick the view is drawing the zombies and the allies at.
 *
 * Played at once, because nothing drawn is behind them: this survivor's own camera `Shake`, the `ShotResult` of this
 * survivor's own shot (the client drew the line when the trigger was pulled, §2.5) and this survivor's own
 * projectiles, spawn and end (they fly from the predicted body, which is not behind at all). Nothing waits longer
 * than FX_HOLD_MAX_S either: a render time that cannot reach a tick (a tick unwrapped on the wrong lap, the clock
 * re-anchoring) must not hold an effect for ever.
 *
 * Pure: no Roblox service and no Instance.
 */
import { FX_HOLD_MAX_S } from "shared/net/mpConfig";
import { FxEvent, FxType } from "shared/net/protocol";

/** effects waiting at most: a second of a heavy firefight; past it the oldest is dropped (the client is not drawing) */
export const FX_TIMELINE_MAX = 256;

export class FxTimeline {
	private readonly events = new Array<FxEvent>();
	/** the full server tick each effect is played at (its batch's, unwrapped) */
	private readonly ticks = new Array<number>();
	/** when each arrived (s), for FX_HOLD_MAX_S */
	private readonly arrived = new Array<number>();
	/** projectiles of this survivor whose spawn was played at once: their end is too */
	private readonly mine = new Set<number>();
	/** effects dropped because the timeline was full */
	dropped = 0;

	/** one effect of a batch stamped `tick` (a full tick), arrived at `now` (s) */
	push(e: FxEvent, tick: number, now: number): void {
		if (this.events.size() >= FX_TIMELINE_MAX) {
			this.events.remove(0);
			this.ticks.remove(0);
			this.arrived.remove(0);
			this.dropped += 1;
		}
		this.events.push(e);
		this.ticks.push(tick);
		this.arrived.push(now);
	}

	/** is this effect the local survivor's own, played without waiting? */
	private immediate(e: FxEvent, localSlot: number): boolean {
		if (e.t === FxType.Shake) return true;
		if (localSlot < 0) return false;
		if (e.t === FxType.Shot) return e.slot === localSlot;
		if (e.t === FxType.ProjSpawn) {
			if (e.owner !== localSlot) return false;
			// an end lost on the unreliable channel never takes its id back: the set is only ever a few flights deep
			if (this.mine.size() >= FX_TIMELINE_MAX) this.mine.clear();
			this.mine.add(e.projId);
			return true;
		}
		if (e.t === FxType.ProjEnd && this.mine.has(e.projId)) {
			this.mine.delete(e.projId);
			return true;
		}
		return false;
	}

	/**
	 * Appends to `out`, in arrival order, every effect due at render time `renderTick` (fractional server ticks; 0 or
	 * less: nothing is drawn yet, so nothing waits), and keeps the rest.
	 */
	take(out: Array<FxEvent>, renderTick: number, now: number, localSlot: number): Array<FxEvent> {
		const n = this.events.size();
		if (n === 0) return out;
		let kept = 0;
		for (let i = 0; i < n; i++) {
			const e = this.events[i];
			const due =
				renderTick <= 0 ||
				this.ticks[i] <= renderTick ||
				now - this.arrived[i] >= FX_HOLD_MAX_S ||
				this.immediate(e, localSlot);
			if (due) {
				out.push(e);
				continue;
			}
			this.events[kept] = e;
			this.ticks[kept] = this.ticks[i];
			this.arrived[kept] = this.arrived[i];
			kept += 1;
		}
		while (this.events.size() > kept) {
			this.events.pop();
			this.ticks.pop();
			this.arrived.pop();
		}
		return out;
	}

	size(): number {
		return this.events.size();
	}

	clear(): void {
		this.events.clear();
		this.ticks.clear();
		this.arrived.clear();
		this.mine.clear();
	}
}
