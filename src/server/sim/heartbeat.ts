/*
 * The server's fixed-step accumulator (docs/MULTIPLAYER.md §3.1): how many ticks one Heartbeat runs.
 *
 *   - the Heartbeat's delta is added to a debt, clipped to MAX_FRAME_S first (a Studio breakpoint, a long hitch);
 *   - one tick runs per TICK_DT of debt, at most MAX_CATCHUP_TICKS per heartbeat;
 *   - what is left is carried to the next heartbeats, up to MAX_BACKLOG_S; anything beyond that is DROPPED and
 *     counted (`droppedTicks`), and so is the time the clip threw away. The world slows down instead of spiralling.
 *
 * The debt, and what it costs. Carrying it keeps the world's time whole through a hitch: every client draws the
 * horde a fixed delay behind the server, and a dropped tick is a hole in that timeline that each of them has to
 * run into and then ease back out of (tools/test-zombie-motion.mjs, profile `server`: 23.7 % of the zombie frames
 * extrapolated or held, 72 drawn past the data, with no debt; 1.0 % and 0 with it). But a repaid tick consumes a
 * command per survivor, and the clients send one per frame: repaid from a queue capped at INPUT_BUFFER_MAX, the
 * debt emptied every queue and each repaid tick was a WAIT, a survivor standing still in everyone else's world (the
 * review of 2026-09-23, tools/test-input-buffer.mjs case 5: 0 -> 3.91 waits a second). The commands for those
 * ticks HAD arrived -- during the hitch -- and the ceiling threw them away. So the ceiling now grants one more
 * command for every tick the Heartbeat still owes (`grace`, server/sim/players.ts): the repayment finds its
 * commands, and case 5 waits 0 times and loses 0 commands where the old drop rule lost 165.
 *
 * Its own module, and pure, so that the tests drive the rule the server SHIPS: tools/test-input-buffer.mjs used to
 * carry a copy of it, and the copy stayed on the old rule while the server moved -- which is how the emptied queues
 * got past it. Whatever this decides, the input queue sees.
 */
import { MAX_BACKLOG_S, MAX_CATCHUP_TICKS } from "shared/net/mpConfig";

/** a single Heartbeat delta is clipped to this before it reaches the debt (Studio breakpoints, hitches) */
export const MAX_FRAME_S = 1;
/** float slack on the debt: 60 deltas of 1/60 s must run 60 ticks, not 59 and a stray one later */
const EPS_S = 1e-7;

export class TickAccumulator {
	/** seconds owed to the simulation (normally under one tick) */
	private acc = 0;
	/** ticks whose time was dropped: past the backlog, or clipped off an overlong heartbeat (§3.1, §12.2) */
	droppedTicks = 0;
	/** heartbeats that had to drop time */
	lateFrames = 0;
	private clippedS = 0;
	private readonly backlog: number;
	/** the most `grace` ever answers: every tick the debt can hold, plus a heartbeat's catch-up */
	private readonly graceMax: number;

	/** `backlogS` other than MAX_BACKLOG_S is for the tests (tools/test-input-buffer.mjs `--backlog-ticks`) */
	constructor(
		readonly tickDt: number,
		backlogS = MAX_BACKLOG_S,
		private readonly catchup = MAX_CATCHUP_TICKS,
	) {
		this.backlog = math.max(0, math.floor(backlogS / tickDt + EPS_S)) * tickDt;
		this.graceMax = math.floor(this.backlog / tickDt + EPS_S) + catchup;
	}

	/** one Heartbeat of `dt` seconds: how many ticks to run now (0..MAX_CATCHUP_TICKS) */
	take(dt: number): number {
		if (!(dt > 0) || dt === math.huge) return 0;
		if (dt > MAX_FRAME_S) {
			// the clipped time is never simulated: it is dropped time like any other, and is counted as such
			this.clippedS += dt - MAX_FRAME_S;
			const whole = math.floor(this.clippedS / this.tickDt + EPS_S);
			if (whole > 0) {
				this.droppedTicks += whole;
				this.clippedS = math.max(0, this.clippedS - whole * this.tickDt);
				this.lateFrames += 1;
			}
		}
		this.acc += math.min(dt, MAX_FRAME_S);
		let ran = 0;
		while (this.acc >= this.tickDt - EPS_S && ran < this.catchup) {
			this.acc = math.max(0, this.acc - this.tickDt);
			ran += 1;
		}
		if (this.acc >= this.tickDt + this.backlog - EPS_S) {
			const dropped = math.floor((this.acc - this.backlog) / this.tickDt + EPS_S);
			this.droppedTicks += dropped;
			this.lateFrames += 1;
			this.acc = math.max(0, this.acc - dropped * this.tickDt);
		}
		return ran;
	}

	/**
	 * How many commands past INPUT_BUFFER_MAX a survivor's queue may hold right now, `sinceBeatS` seconds after the
	 * last Heartbeat: the ticks the server owes beyond the one the next heartbeat runs anyway -- the debt, plus the
	 * time this heartbeat is late. 0 while the server keeps time; never past what the debt can hold.
	 */
	grace(sinceBeatS: number): number {
		const late = sinceBeatS > 0 && sinceBeatS < math.huge ? math.min(sinceBeatS, MAX_FRAME_S) : 0;
		const due = math.floor((this.acc + late) / this.tickDt + EPS_S) - 1;
		return math.clamp(due, 0, this.graceMax);
	}

	/** the debt still owed, in seconds (published as `pz_backlog_ms`) */
	owed(): number {
		return this.acc;
	}

	/**
	 * Forgets the debt. A NEW world (MP-22's reset) starts from nothing: carried over, the old world's hitch would be
	 * repaid by the new one on its very first heartbeats -- and so would the time the reset itself took, which is why
	 * server/net/mpHost.ts also clips the heartbeat after one.
	 */
	forgive(): void {
		this.acc = 0;
		this.clippedS = 0;
	}
}
