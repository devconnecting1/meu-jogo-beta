/*
 * The server's fixed-step simulation (docs/MULTIPLAYER.md §3.1, §3.2).
 *
 * From F2 on this is the whole world: the survivors (F1), the horde, the bosses, the clock and the waves
 * (2A/2B) and every shot, swing and point of damage (2C), all in ONE `step()` in the §3.1 order —
 *
 *   1. input and movement per survivor, then that survivor's weapon machine with the SAME command;
 *   2. the world: clock and waves, population, flow field, zombies, bosses;
 *   3. the position history, recorded AFTER the world moved (a shot rewinds into it, so recording it
 *      before would rewind into data that is already one tick stale);
 *   4. replication, through `onTick`.
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
import { FxEvent } from "shared/net/protocol";
import { WorldData } from "shared/game/world";
import { PlayerState } from "shared/game/player";
import { stepPlayer } from "shared/sim/playerMove";
import { emitSound, reactToHit } from "shared/sim/ai/zombieBrain";
import { ServerCombat } from "./combat";
import { Progress, creditDaySurvived } from "./progress";
import { ServerProjectiles } from "./projectiles";
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
	/**
	 * Every shot, swing and point of damage (§2.3, 2C), or undefined while the horde is not here to shoot at.
	 * It is built with the horde because the two are the same decision: either the server owns the world or
	 * it owns none of it.
	 */
	readonly combat?: ServerCombat;
	/** XP, kills and boss credit straight into the live saves (§3.6, 2C) */
	readonly progress?: Progress;
	/** arrows, flames, acid and needles in flight (§3.1 step 2) */
	readonly projectiles?: ServerProjectiles;
	/**
	 * A cosmetic effect the simulation asked for, already in wire form (§4.1 Fx). server/net/mpHost.ts points
	 * it at the replicator; a caller that leaves it undefined simply drops the effects, which is what the
	 * pure tests want.
	 */
	onFx?: (event: FxEvent) => void;

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
		// §3.6: the world rolled into a new day, and everybody who is in it lived through that night
		this.clock.onNewDay = () => {
			for (const sp of this.roster) creditDaySurvived(sp.save);
		};
		if (!(options.zombies ?? MP_PHASE >= 2)) return;
		const horde = new ZombieWorld(options.world, this.clock);
		this.horde = horde;
		const progress = new Progress({ saveOf: slot => this.bySlot.get(slot)?.save });
		this.progress = progress;
		const projectiles = new ServerProjectiles({
			playerOf: slot => this.bySlot.get(slot),
			onFx: event => this.onFx?.(event),
		});
		this.projectiles = projectiles;
		const combat = new ServerCombat({
			world: options.world,
			targets: { zombies: () => horde.zombies, bosses: () => horde.bossRoster.list },
			progress,
			simHz: this.simHz,
			hooks: {
				// the reaction, the stun and the hunt the hit seeds belong to the horde's own brain (2A);
				// combat only ever decides HOW MUCH hp came off
				hitZombie: (z, damage, dir, knock, stun) => reactToHit(z, dir, knock, stun),
				noise: (x, y, radius, shot) => emitSound(horde.refs, x, y, radius, shot),
				fx: event => this.onFx?.(event),
				// a bow and a flamethrower do not fire a ray: they ask the world to fly something (§2.3)
				projectile: request => projectiles.launch(horde.refs, request),
			},
		});
		this.combat = combat;
		projectiles.combat = combat;
		// §2.3/MP-00: from here on a survivor only ever loses hp through the server's combat. The brains still
		// call `damageToPlayer`, which is inert at MP_PHASE ≥ 2 — this sink is what makes the bite land.
		horde.refs.damagePlayer = combat.damageSink(p => this.slotOfState(p));
		// the kill XP is paid by `combat` at the instant hp reaches 0, killer and assists together (§3.6).
		// `onExp` fires LATER, from the brain that removes the body, for that very same zombie: paying it
		// again would double every kill, so it deliberately credits nobody.
		horde.onExp = () => {};
	}

	/** the slot of the survivor this `PlayerState` belongs to, or -1 (the damage sink refuses those) */
	private slotOfState(p: PlayerState): number {
		for (const sp of this.roster) {
			if (sp.state === p) return sp.slot;
		}
		return -1;
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
		// the weapon machine and the session counters of a slot that is free again would otherwise be
		// inherited by whoever takes it next (§4.4: a slot is stable for a session, not beyond it)
		this.combat?.remove(slot);
		this.progress?.remove(slot);
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
			// the weapon machine runs on the SAME command as the movement: the aim a shot is fired along is
			// the one the player was holding when they walked that step, never the one two ticks later
			this.combat?.stepPlayer(sp, cmd, this.tick, this.tickDt);
			if (res.died && this.onDeath !== undefined) this.onDeath(sp);
		}
		// the horde walks in the SAME tick as the survivors: one world, one clock, one set of positions
		if (this.horde !== undefined) {
			if (this.roster.size() > 0) {
				this.horde.step(this.roster, this.tickDt, this.tick);
				// after the bodies moved, so a flame burns what is in front of it NOW and not a tick ago
				this.projectiles?.step(this.horde.refs, this.tickDt);
			} else {
				// nobody is in the world: there is no source for the flow field, no light, nothing to hunt
				// and nobody to see it. The clock keeps running (a server that empties at dusk must still be
				// dark when somebody joins, §4.6) and everything else stands still, which also means an
				// empty server costs nothing.
				this.clock.step(this.tickDt);
			}
		}
		// §3.1 step 3, and it MUST be here: the history a shot rewinds into is the world as it ended this
		// tick, so recording it before the horde moved would compensate latency against stale positions
		this.combat?.afterWorld(this.tick);
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
