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
 * But only for a debt that is being REPAID (the review of dee095a, B1). Below 30 Hz a heartbeat is longer than the
 * MAX_CATCHUP_TICKS it may run: the debt only grows, sits at MAX_BACKLOG_S and drops the rest, and the ticks it
 * "owes" never run. Granting a command for each of them kept every queue about as deep as the debt for as long as
 * the slowdown lasted -- 352 ms from input to simulation at a 25 Hz heartbeat where the fixed ceiling gives 80 ms,
 * with every honest shot clamped (tools/test-input-buffer.mjs cases 12-14). So a debt earns grace only inside a
 * REPAYMENT: it began on a heartbeat that found the server keeping time (a hitch), and every heartbeat since has
 * kept it under what that hitch left and dropped nothing. The first heartbeat that climbs back over it, or drops,
 * means the server is not repaying; no grace then until it keeps time again. And a repayment that crawls (a tick
 * costing about half a heartbeat, so each heartbeat repays a sliver) earns only what it repays in as many
 * heartbeats as the grace can hold commands (INPUT_GRACE_MAX): it would otherwise keep the queues debt-deep for
 * seconds. At a 60 Hz heartbeat a repayment clears a tick a heartbeat, so that is the whole debt.
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
/** weight of one heartbeat in the running heartbeat length that measures how fast a debt is repaid */
const BEAT_ALPHA = 0.2;
/**
 * Slack, in ticks, on "the debt stays under what the hitch left": one heartbeat a scrap longer than a tick's worth
 * of two (Studio's frames jitter) must not end a repayment that the next heartbeat carries on with.
 */
const REPAY_SLACK_TICKS = 0.5;

/** what the debt is doing, for the queue's grace (`grace`) */
const Debt = {
	/** under one tick owed: the server keeps time */
	OnTime: 0,
	/** a hitch left a debt that every heartbeat since has kept under its peak, dropping nothing */
	Repaying: 1,
	/** the debt climbed back over its peak, or ticks were dropped: not repaid, no grace until on time again */
	Behind: 2,
} as const;
type Debt = (typeof Debt)[keyof typeof Debt];

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
	/** whether the debt is being repaid (see the header) */
	private debt: Debt = Debt.OnTime;
	/** the debt the hitch that opened this repayment left, in seconds */
	private peak = 0;
	/** heartbeats since the one that opened this repayment */
	private repayBeats = 0;
	/**
	 * Running heartbeat length outside a hitch, each clipped to MAX_CATCHUP_TICKS ticks: at this pace a heartbeat
	 * repays `catchup − this` ticks of debt. It is what a hitch that has just happened is expected to be repaid at,
	 * before the first heartbeat of the repayment says for itself; a run of slow heartbeats pulls it to the clip and
	 * the expected repayment to zero.
	 */
	private beatS: number;

	/** `backlogS` other than MAX_BACKLOG_S is for the tests (tools/test-input-buffer.mjs `--backlog-ticks`) */
	constructor(
		readonly tickDt: number,
		backlogS = MAX_BACKLOG_S,
		private readonly catchup = MAX_CATCHUP_TICKS,
	) {
		this.backlog = math.max(0, math.floor(backlogS / tickDt + EPS_S)) * tickDt;
		this.graceMax = math.floor(this.backlog / tickDt + EPS_S) + catchup;
		this.beatS = tickDt;
	}

	/** one Heartbeat of `dt` seconds: how many ticks to run now (0..MAX_CATCHUP_TICKS) */
	take(dt: number): number {
		if (!(dt > 0) || dt === math.huge) return 0;
		const before = this.acc;
		const droppedBefore = this.droppedTicks;
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
		this.noteDebt(dt, before, this.droppedTicks > droppedBefore);
		return ran;
	}

	/** after a heartbeat: is what the server owes being repaid? (see the header) */
	private noteDebt(dt: number, before: number, dropped: boolean): void {
		const tick = this.tickDt;
		if (this.acc < tick - EPS_S) {
			// under a tick owed: whatever happened is settled
			this.debt = Debt.OnTime;
			this.peak = 0;
		} else if (before < tick - EPS_S) {
			// A server that kept time now owes: a hitch -- whatever it dropped with it -- that the next heartbeats repay.
			// The hitch itself says nothing about their pace, so it stays out of the running heartbeat length
			this.debt = Debt.Repaying;
			this.peak = this.acc;
			this.repayBeats = 0;
			return;
		} else if (this.debt === Debt.Repaying) {
			this.repayBeats += 1;
			// the debt climbed back over what the hitch left, or overflowed: this server is not repaying it
			if (dropped || this.acc > this.peak + REPAY_SLACK_TICKS * tick) this.debt = Debt.Behind;
		}
		this.beatS += (math.min(dt, this.catchup * tick) - this.beatS) * BEAT_ALPHA;
	}

	/**
	 * Ticks of debt one heartbeat repays: what this repayment has cleared per heartbeat since its hitch, or, before
	 * its first heartbeat (and outside one), what a heartbeat at the recent pace would clear.
	 */
	private pace(): number {
		if (this.debt === Debt.Repaying && this.repayBeats > 0) {
			return (this.peak - this.acc) / this.tickDt / this.repayBeats;
		}
		return this.catchup - this.beatS / this.tickDt;
	}

	/**
	 * How many commands past INPUT_BUFFER_MAX a survivor's queue may hold right now, `sinceBeatS` seconds after the
	 * last Heartbeat: the ticks the server owes beyond the one the next heartbeat runs anyway -- the debt, plus the
	 * time this heartbeat is late -- but only while that debt is being repaid, and no more than the repayment clears
	 * in `graceMax` heartbeats at its pace (`pace`). 0 while the server keeps time (unless this very heartbeat is
	 * late: a hitch in progress), 0 while it is behind, and never past what the debt can hold.
	 */
	grace(sinceBeatS: number): number {
		if (this.debt === Debt.Behind) return 0;
		const late = sinceBeatS > 0 && sinceBeatS < math.huge ? math.min(sinceBeatS, MAX_FRAME_S) : 0;
		const due = math.floor((this.acc + late) / this.tickDt + EPS_S) - 1;
		if (due <= 0) return 0;
		const repaid = math.floor(this.pace() * this.graceMax + EPS_S);
		return math.clamp(math.min(due, repaid), 0, this.graceMax);
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
		this.debt = Debt.OnTime;
		this.peak = 0;
	}
}
