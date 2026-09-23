/*
 * The server's fixed-step simulation (docs/MULTIPLAYER.md §3.1, §3.2).
 *
 * F1 scope: ONLY the survivors are authoritative. Zombies, bosses, items and the clock are still simulated
 * locally by each client (§11.3 F1); F2 moves them here, into the same `step()` in the §3.1 order.
 *
 *   - fixed step of TICK_DT (1/SIM_HZ = 1/60 s), accumulated on the caller's Heartbeat delta;
 *   - at most MAX_CATCHUP_TICKS (2) ticks per call: beyond that the surplus time is DROPPED and counted
 *     (`droppedTicks`), so a slow heartbeat never spirals into a catch-up storm;
 *   - exactly one input command per player per tick, through the same `stepPlayer` the client predicts with
 *     (shared/sim/playerMove.ts), so there is no second implementation to drift.
 *
 * Nothing the client sends is a position: the survivor's x/y only ever move through `stepPlayer` with the
 * server's own speed, collision and dt (MP-00, §2.2 "elimina trapaça de movimento por construção").
 *
 * Pure module: no Instances, no services, no os.clock. The caller feeds `advance(dt)` and (optionally) a
 * millisecond reading per tick for the §12.2 metrics.
 */
import { isFiniteNumber } from "shared/net/codec";
import { MAX_CATCHUP_TICKS, MAX_PLAYERS, MP_PHASE, SIM_HZ } from "shared/net/mpConfig";
import { WorldData } from "shared/game/world";
import { stepPlayer } from "shared/sim/playerMove";
import { ServerPlayer, noteStep, takeCommand } from "./players";
import { WorldClock } from "./waves";
import { ZombieWorld } from "./zombies";

/** a single Heartbeat delta is clamped to this before it reaches the accumulator (Studio breakpoints, hitches) */
const MAX_FRAME_S = 1;
/** §12.2: ring of tick times used for the average and the p95 */
const METRIC_SAMPLES = 300;

export interface SimulationStats {
	/** simulation ticks run since boot */
	ticks: number;
	/** ticks whose time was dropped because the heartbeat fell more than MAX_CATCHUP_TICKS behind (§3.1) */
	droppedTicks: number;
	/** how many heartbeats had to drop time */
	lateFrames: number;
	/** ticks run in the last advance() call */
	lastCatchup: number;
}

export interface SimulationOptions {
	world: WorldData;
	/** defaults to mpConfig.SIM_HZ; the §3.1 fallback to 30 Hz needs no protocol change */
	simHz?: number;
	/**
	 * Simulate the horde here (§3.1 step 2). Defaults to MP_PHASE >= 2: with MP_PHASE = 1 the zombies are
	 * still local to each client (§11.3 F1), so the server must not spawn a second one. Tests pass `true`
	 * to exercise the authoritative horde without moving the phase switch.
	 */
	zombies?: boolean;
	/**
	 * The world's clock and night waves (server/sim/waves.ts). One per server: the horde reads it and the
	 * replication sends it (§4.5 `Clock`), so it is built here rather than inside either of them.
	 */
	clock?: WorldClock;
}

/** what a player looked like after a tick — everything the replication layer needs beyond `state` */
export interface StepOutcome {
	slot: number;
	died: boolean;
}

export class ServerSimulation {
	readonly world: WorldData;
	readonly simHz: number;
	readonly tickDt: number;
	/** full tick counter; the wire carries it modulo 65 536 (§4.2) */
	tick = 0;
	readonly stats: SimulationStats = { ticks: 0, droppedTicks: 0, lateFrames: 0, lastCatchup: 0 };
	/** called after every tick (replication, metrics); errors are the caller's to contain */
	onTick?: (tick: number) => void;
	/** called when a survivor's hp reached 0 during a tick (F4 turns this into downed/dead) */
	onDeath?: (sp: ServerPlayer) => void;
	/**
	 * The authoritative horde (§3.3, §3.5), or undefined while MP_PHASE < 2 and every client still simulates
	 * its own. F2-2D reads the zombies, their netIds and their deaths from here.
	 */
	readonly horde?: ZombieWorld;
	/**
	 * The world's clock: one day, one night and one set of wave queues for everybody (§4.6, §6.2). It ticks
	 * inside the horde's step when the server owns the world, and stands still at MP_PHASE < 2, where every
	 * client still runs its own DayNight.
	 */
	readonly clock: WorldClock;

	private readonly bySlot = new Map<number, ServerPlayer>();
	/** slots in ascending order: iteration is deterministic (a Luau Map is not ordered) */
	private readonly order = new Array<number>();
	/** the same survivors, in the same order, as one reusable array the world half of the tick walks */
	private readonly roster = new Array<ServerPlayer>();
	private acc = 0;
	private readonly samples = new Array<number>();
	private sampleAt = 0;

	constructor(options: SimulationOptions) {
		this.world = options.world;
		const hz = options.simHz ?? SIM_HZ;
		this.simHz = hz > 0 ? hz : SIM_HZ;
		this.tickDt = 1 / this.simHz;
		this.clock = options.clock ?? new WorldClock();
		if (options.zombies ?? MP_PHASE >= 2) this.horde = new ZombieWorld(options.world, this.clock);
	}

	// ---------------------------------------------------------------- roster

	/** the lowest free slot (§4.4: 0..MAX_PLAYERS-1, stable for the session), or undefined when the server is full */
	freeSlot(): number | undefined {
		for (let slot = 0; slot < MAX_PLAYERS; slot++) {
			if (!this.bySlot.has(slot)) return slot;
		}
		return undefined;
	}

	add(sp: ServerPlayer): boolean {
		if (this.bySlot.has(sp.slot)) return false;
		this.bySlot.set(sp.slot, sp);
		this.order.push(sp.slot);
		let i = this.order.size() - 1;
		while (i > 0 && this.order[i - 1] > sp.slot) {
			this.order[i] = this.order[i - 1];
			i -= 1;
		}
		this.order[i] = sp.slot;
		this.refreshRoster();
		return true;
	}

	remove(slot: number): ServerPlayer | undefined {
		const sp = this.bySlot.get(slot);
		if (sp === undefined) return undefined;
		this.bySlot.delete(slot);
		for (let i = 0; i < this.order.size(); i++) {
			if (this.order[i] === slot) {
				this.order.remove(i);
				break;
			}
		}
		this.refreshRoster();
		return sp;
	}

	/** the roster is rebuilt when somebody joins or leaves, never inside the tick */
	private refreshRoster(): void {
		this.roster.clear();
		for (const slot of this.order) {
			const sp = this.bySlot.get(slot);
			if (sp !== undefined) this.roster.push(sp);
		}
	}

	get(slot: number): ServerPlayer | undefined {
		return this.bySlot.get(slot);
	}

	/** every survivor in the world, always in ascending slot order */
	players(): Array<ServerPlayer> {
		const out = new Array<ServerPlayer>();
		for (const slot of this.order) {
			const sp = this.bySlot.get(slot);
			if (sp !== undefined) out.push(sp);
		}
		return out;
	}

	count(): number {
		return this.order.size();
	}

	// ---------------------------------------------------------------- the loop (§3.1)

	/**
	 * Accumulates `dt` (the Heartbeat delta) and runs whole ticks. Returns how many ran: normally 1, at most
	 * MAX_CATCHUP_TICKS. Surplus time beyond that is dropped and counted — the world slows down instead of
	 * entering a catch-up spiral (§3.1).
	 */
	advance(dt: number): number {
		if (!isFiniteNumber(dt) || dt <= 0) return 0;
		this.acc += math.min(dt, MAX_FRAME_S);
		let ran = 0;
		while (this.acc >= this.tickDt && ran < MAX_CATCHUP_TICKS) {
			this.acc -= this.tickDt;
			this.step();
			ran += 1;
		}
		if (this.acc >= this.tickDt) {
			const dropped = math.floor(this.acc / this.tickDt);
			this.stats.droppedTicks += dropped;
			this.stats.lateFrames += 1;
			this.acc -= dropped * this.tickDt;
		}
		this.stats.lastCatchup = ran;
		return ran;
	}

	/**
	 * One fixed step, in the §3.1 order: (1) input and movement for every survivor, (2) the world — clock,
	 * population, flow field, zombies, bosses — and then the replication through `onTick`.
	 *
	 * A survivor keeps being stepped after `dead`: §7.3 (downed, crawling at 20%, revive, spectate) is F4's —
	 * it gates the command here, in one place.
	 */
	step(): void {
		this.tick += 1;
		this.stats.ticks += 1;
		for (const sp of this.roster) {
			const cmd = takeCommand(sp);
			const res = stepPlayer(this.world, sp.state, sp.save, cmd, this.tickDt);
			noteStep(sp, cmd, res.walking);
			if (res.died && this.onDeath !== undefined) this.onDeath(sp);
		}
		// the horde walks in the SAME tick as the survivors: one world, one clock, one set of positions
		if (this.horde !== undefined) this.horde.step(this.roster, this.tickDt, this.tick);
		if (this.onTick !== undefined) this.onTick(this.tick);
	}

	/** has this survivor's 3 s spawn protection expired? (§7.1) */
	spawnShielded(sp: ServerPlayer): boolean {
		return this.tick < sp.spawnShieldUntil;
	}

	// ---------------------------------------------------------------- metrics (§12.2)

	/** records one tick's simulation time in milliseconds */
	sample(ms: number): void {
		if (!isFiniteNumber(ms)) return;
		if (this.samples.size() < METRIC_SAMPLES) this.samples.push(ms);
		else this.samples[this.sampleAt] = ms;
		this.sampleAt = (this.sampleAt + 1) % METRIC_SAMPLES;
	}

	avgMs(): number {
		const n = this.samples.size();
		if (n === 0) return 0;
		let total = 0;
		for (const v of this.samples) total += v;
		return total / n;
	}

	p95Ms(): number {
		const n = this.samples.size();
		if (n === 0) return 0;
		const copy = new Array<number>();
		for (const v of this.samples) copy.push(v);
		copy.sort((a, b) => a < b);
		return copy[math.min(n - 1, math.floor(n * 0.95))];
	}
}
