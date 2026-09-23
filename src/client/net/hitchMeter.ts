/*
 * Counts what an eye calls a stutter in a body that is walking: its DRAWN speed collapsing or spiking for a
 * moment and then carrying on as before.
 *
 * Why it exists. A playtest reported an ally moving "as if he had lag, all the time, and short -- one step",
 * while the person moving felt perfectly smooth. Every layer that could cause that was measured offline and
 * came back clean -- the snapshot buffer (tools/test-smoothness.mjs), the pixel rounding, the input queue
 * (tools/test-input-buffer.mjs), the clock -- and the playtest's own [PZ-NET] line showed a healthy network.
 * What no offline harness has is THIS client, on THIS machine, drawing a real ally. So the meter watches the
 * position the view is about to draw and reports how often it jolts, and whether the jolts line up with long
 * frames (the machine) or not (the data).
 *
 * The definition, so the number means one thing:
 *   - only a body that is clearly walking is judged: its speed is at least MOVING_UPS and has been for
 *     SETTLE_FRAMES frames. Until then the smoothed speed simply FOLLOWS the drawn one, because a smoothed
 *     speed climbing from zero would make the first judged frame look twice as fast as its average -- a
 *     false jump every time anybody starts walking;
 *   - a SPIKE is one frame drawn at more than SPIKE x the smoothed speed: the body jumped to catch up;
 *   - a DIP is one frame drawn at less than DIP x the smoothed speed, and it only counts if the body is back
 *     above RECOVER x within RECOVER_FRAMES: a freeze that carried on. A dip that never recovers is the player
 *     STOPPING, which is not a stutter and is not counted.
 * Speed is always distance over that frame's OWN dt: dividing by a neighbour's dt invents teleports (the
 * mistake that once produced a phantom 1890 u/s in tools/test-smoothness.mjs).
 *
 * Pure: no Instances, no services. tools/test-smoothness.mjs drives it with the real buffer's output.
 */

/** below this smoothed speed a body is standing or shuffling, and a speed change there means nothing */
export const MOVING_UPS = 100;
/**
 * The same threshold for the horde. A walker moves at 90 u/s (3 px/frame at 30 fps), under a survivor's 100: judged
 * from MOVING_UPS it would never be judged at all. Half a walker's pace still tells walking from shuffling.
 */
export const ZOMBIE_MOVING_UPS = 40;
/** one frame drawn this much faster than the smoothed speed is a jump */
export const SPIKE = 1.8;
/** one frame drawn this much slower than the smoothed speed starts a suspected freeze */
export const DIP = 0.4;
/** ... which counts as a stutter only if the body is back to this within RECOVER_FRAMES */
export const RECOVER = 0.7;
export const RECOVER_FRAMES = 6;
/** frames of walking before a body is judged at all (see the definition above) */
export const SETTLE_FRAMES = 6;
/** time constant of the smoothed speed: long enough to ignore one frame, short enough to follow a walk */
const EMA_TAU_S = 0.25;
/** a frame this much longer than 1/60 s is the machine hitching, not the data */
const LONG_FRAME_S = 1.5 / 60;
/** a body not observed for this long is forgotten (left the interest ring, died, left the server) */
const FORGET_S = 2;

interface Track {
	x: number;
	y: number;
	/** smoothed drawn speed, u/s */
	ema: number;
	/** consecutive frames at walking speed, up to SETTLE_FRAMES */
	settle: number;
	/** frames since a dip started, or -1 when none is pending */
	dipAge: number;
	/** whether the frame the dip started in was a long one */
	dipLong: boolean;
	/** how far below the smoothed speed the dip went, as 1 - ratio */
	dipDepth: number;
	seenAt: number;
}

export interface HitchReport {
	/** stutters since the last report */
	jolts: number;
	/** ... of which happened on a frame the machine itself was late for */
	inLongFrames: number;
	/** seconds of walking observed, summed over every body: the denominator that makes `jolts` comparable */
	walkingS: number;
	/** the biggest deviation from the smoothed speed, as a fraction (0.6 = drawn 60% off) */
	worst: number;
}

export class HitchMeter {
	private readonly tracks = new Map<number, Track>();
	private clock = 0;
	private jolts = 0;
	private inLongFrames = 0;
	private walkingS = 0;
	private worst = 0;

	/** `movingUps`: the speed from which a body counts as walking (MOVING_UPS for survivors, ZOMBIE_MOVING_UPS) */
	constructor(private readonly movingUps = MOVING_UPS) {}

	/** once per frame, before any `observe` of that frame */
	beginFrame(dt: number): void {
		if (dt > 0) this.clock += dt;
		for (const [id, t] of this.tracks) {
			if (this.clock - t.seenAt > FORGET_S) this.tracks.delete(id);
		}
	}

	/** the position body `id` is about to be DRAWN at this frame, and the frame's own dt */
	observe(id: number, x: number, y: number, dt: number): void {
		const t = this.tracks.get(id);
		if (t === undefined) {
			this.tracks.set(id, {
				x,
				y,
				ema: 0,
				settle: 0,
				dipAge: -1,
				dipLong: false,
				dipDepth: 0,
				seenAt: this.clock,
			});
			return;
		}
		t.seenAt = this.clock;
		const dx = x - t.x;
		const dy = y - t.y;
		t.x = x;
		t.y = y;
		if (dt <= 0) return;
		const speed = math.sqrt(dx * dx + dy * dy) / dt;
		const long = dt > LONG_FRAME_S;
		const k = math.min(1, dt / EMA_TAU_S);

		if (t.settle < SETTLE_FRAMES) {
			// standing, or only just started walking: follow the speed as it is and judge nothing
			t.settle = speed >= this.movingUps ? t.settle + 1 : 0;
			t.ema = speed;
			t.dipAge = -1;
			return;
		}
		this.walkingS += dt;
		const r = speed / t.ema;

		if (t.dipAge >= 0) {
			t.dipAge += 1;
			if (r >= RECOVER) {
				// back to walking: that was a freeze, not a stop
				this.jolt(t.dipDepth, t.dipLong || long);
				t.dipAge = -1;
			} else if (t.dipAge > RECOVER_FRAMES) {
				// never came back: the player stopped, which is not a stutter. Start over from standing, so the
				// time spent stopped is not counted as walking either.
				t.dipAge = -1;
				t.settle = 0;
				t.ema = speed;
			}
			// while a dip is pending the smoothed speed is held, so one frozen frame cannot drag it down
			return;
		}
		if (r > SPIKE) {
			this.jolt(r - 1, long);
		} else if (r < DIP) {
			t.dipAge = 0;
			t.dipLong = long;
			t.dipDepth = 1 - r;
			return;
		}
		t.ema += (speed - t.ema) * k;
	}

	/**
	 * Stops judging body `id` until it is observed again, from standing. For a body that left the view: when it
	 * comes back, the distance it covered unseen must not read as one enormous frame.
	 */
	forget(id: number): void {
		this.tracks.delete(id);
	}

	/** what happened since the last call, and a fresh start */
	take(): HitchReport {
		const out = { jolts: this.jolts, inLongFrames: this.inLongFrames, walkingS: this.walkingS, worst: this.worst };
		this.jolts = 0;
		this.inLongFrames = 0;
		this.walkingS = 0;
		this.worst = 0;
		return out;
	}

	private jolt(depth: number, long: boolean): void {
		this.jolts += 1;
		if (long) this.inLongFrames += 1;
		if (depth > this.worst) this.worst = depth;
	}
}
