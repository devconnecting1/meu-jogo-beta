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
 *   - at most MAX_CATCHUP_TICKS (2) ticks per call. What a late heartbeat could not run is carried as debt and
 *     paid by the next heartbeats, up to MAX_BACKLOG_S; only debt beyond that is DROPPED and counted
 *     (`droppedTicks`), so a slow heartbeat never spirals into a catch-up storm. The rule is
 *     server/sim/heartbeat.ts, which says what carrying it buys every client's drawing and what it takes for the
 *     input queues to afford it (`inputGrace`);
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
import { MAX_PLAYERS, MP_PHASE, SIM_HZ, WORLD_SERVER_PHASE } from "shared/net/mpConfig";
import { EdgeShift, edgeCount, FxEvent, FxType, HeldBit, IntentMessage } from "shared/net/protocol";
import { wireSoundId } from "shared/net/fxWire";
import { useSoundOf } from "shared/data/usables";
import { serverWorld, updateGroundItems, WorldData } from "shared/game/world";
import { applyPlayerDamage, currentWeapon, PlayerState } from "shared/game/player";
import { ZombieState } from "shared/game/entities";
import { gameHours } from "shared/sim/clock";
import { InputCommand } from "shared/net/protocol";
import { stepPlayer, WALK_EPSILON } from "shared/sim/playerMove";
import { emitSound, reactToHit } from "shared/sim/ai/zombieBrain";
import * as Noise from "shared/sim/ai/noise";
import type { WeaponDef } from "shared/data/weapons";
import { ServerBackpack } from "./backpack";
import { ServerBuild } from "./build";
import { TickAccumulator } from "./heartbeat";
import { ServerCombat } from "./combat";
import { BackpackOutcome, ServerCraft } from "./craft";
import { InteractOutcome, ServerInteraction } from "./interaction";
import { PickupResult, ServerItems, WalkingSurvivor } from "./items";
import { KEEP_AFTER_LEAVE_S } from "./life";
import { DayCredit, DayRefusal, Progress, creditDaySurvived, dayRefusal, survivedNight } from "./progress";
import { TitleId } from "shared/data/titles";
import { creditLifeNight, grantTitle } from "../save/titles";
import { ServerProjectiles } from "./projectiles";
import { ServerPlayer, noteStep, takeCommand } from "./players";
import { powerSet, ServerPower } from "./power";
import { ServerTurrets } from "./turrets";
import { RideEvent, ServerVehicles, VehicleNoise } from "./vehicles";
import { WorldClock } from "./waves";
import { ServerWindows } from "./windows";
import { WorldOut } from "./worldOut";
import { ZombieWorld } from "./zombies";
import { newPhaseCosts, PhaseCosts, SIM_PHASES, SimPhase, SimProfiler } from "./metrics";

/**
 * MP_PHASE from which the SERVER owns the interactive world too: ground items, loot, doors, lights,
 * constructions, crafting and the backpack (docs/MULTIPLAYER.md §11.3 F3). It lives in shared/net/mpConfig.ts
 * because it is a two-sided switch — the client mirrors the `World` deltas and sends the backpack verbs from the
 * same phase — and is re-exported here for the callers that always read it from the simulation.
 */
export { WORLD_SERVER_PHASE } from "shared/net/mpConfig";

/** what an absent horde falls back to, so the queries never allocate a list per tick */
const EMPTY_ZOMBIES: ReadonlyArray<ZombieState> = [];

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
	/**
	 * Own the INTERACTIVE world here too (§11.3 F3): ground items and loot, doors and lights, constructions,
	 * crafting and the backpack. Defaults to MP_PHASE >= WORLD_SERVER_PHASE; tests pass `true` to exercise it
	 * without moving the phase switch, exactly as `zombies` does for the horde.
	 */
	interactive?: boolean;
}

/** everything built around one town (`ServerSimulation.buildAround`), before it becomes the simulation's */
interface TownSystems {
	items?: ServerItems;
	build?: ServerBuild;
	craft?: ServerCraft;
	interaction?: ServerInteraction;
	vehicles?: ServerVehicles;
	horde?: ZombieWorld;
	progress?: Progress;
	projectiles?: ServerProjectiles;
	combat?: ServerCombat;
	power?: ServerPower;
	turrets?: ServerTurrets;
	windows?: ServerWindows;
}

/** what a player looked like after a tick — everything the replication layer needs beyond `state` */
export interface StepOutcome {
	slot: number;
	died: boolean;
}

/**
 * §3.6 bookkeeping for one survivor's current world day, keyed by UserId so a trip to the lobby does not reset it
 * (the ServerPlayer is rebuilt on every entry; the person is not).
 */
interface Presence {
	/** ticks spent ALIVE in the world since the previous midnight */
	aliveTicks: number;
	/** the last tick a REAL command moved or pressed something (§9.1), or undefined */
	activeTick?: number;
	/**
	 * MON-05: the last midnight PAID this survivor (and their run pays rewards), so the 06:00 that follows may make
	 * them a Survivor. Cleared at every daybreak, and by a new world.
	 */
	nightCredited?: boolean;
}

/** one survivor's filtered ping (server/sim/combat.ts `setPing`), kept across a leave/enter by `setPing` */
interface PingMemory {
	/** seconds */
	pingS: number;
	/** the tick of its last sample */
	at: number;
}

export class ServerSimulation {
	/**
	 * The town. Replaced — never edited in place — when a world ends (MP-22, `restartWorld`), together with every
	 * subsystem below that was built around it; read it through the simulation, never keep your own reference.
	 */
	world: WorldData;
	readonly simHz: number;
	readonly tickDt: number;
	/** full tick counter; the wire carries it modulo 65 536 (§4.2) */
	tick = 0;
	readonly stats: SimulationStats = { ticks: 0, droppedTicks: 0, lateFrames: 0, lastCatchup: 0 };
	/** called after every tick (replication, metrics); errors are the caller's to contain */
	onTick?: (tick: number) => void;
	/**
	 * How many ticks further back than `viewTick` (the render time of the frame that declared it) the survivor in
	 * `slot` drew zombie `z` (the mid ring's extra delay, eased when it changes ring, §4.3/§5.1), for the rewind of a
	 * shot (server/sim/combat.ts `viewExtraTicks`). The replication layer knows who was sent what in which ring, and
	 * sets it (server/net/replication.ts); unset, every body is near.
	 */
	zombieViewLag?: (slot: number, z: ZombieState, viewTick: number) => number;
	/**
	 * (§4.3, audit L2) Can the survivor in `slot` see the spot (x, y) -- not inside a building they are not in, and in
	 * the dark only if it is lit or within earshot? A ground item that just fell there (ITEM_NEWS_S) is told to them
	 * only then (a zombie's drop at the place it died in the dark handed a client the death it was never shown). Set by
	 * the replication layer, which owns the rules (server/net/replication.ts); unset, everything in range is seen.
	 */
	itemVisible?: (slot: number, x: number, y: number) => boolean;
	/**
	 * Does server/sim/life.ts still keep a body for this UserId -- connected, in the world or waiting in the lobby, or
	 * gone less than KEEP_AFTER_LEAVE_S? A survivor's ping is kept exactly that long (`setPing`). Set by the LifeKeeper;
	 * unset (a simulation with no keeper), the ping goes by the age of its last sample.
	 */
	bodyKept?: (userId: number) => boolean;
	/** called when a survivor's hp reached 0 during a tick (F4 turns this into downed/dead) */
	onDeath?: (sp: ServerPlayer) => void;
	/**
	 * Midnight paid this survivor (§3.6). The save is ALREADY updated — this is the hook the session layer
	 * uses to mark it dirty and push the new wallet, not a chance to change the number.
	 */
	onDayCredit?: (sp: ServerPlayer, credit: DayCredit) => void;
	/** Midnight did NOT pay this survivor, and why (§3.6: dead, absent for most of the day, or AFK) */
	onDayRefused?: (sp: ServerPlayer, reason: DayRefusal) => void;
	/**
	 * MON-05: this survivor just EARNED a title -- the save already has it (server/save/titles.ts `grantTitle`), and
	 * it fires once per title per save, ever. server/net/mpHost.ts tells the survivor and has the session written.
	 */
	onTitleUnlocked?: (sp: ServerPlayer, titleId: number) => void;
	/**
	 * BEM-04 / SAV-01: daybreak found this survivor standing in the world. The session layer asks for an event save, so
	 * the dawn card's "Progress saved" can be the truth soon after 06:00 (server/main.server.ts `saveSoon`, "dawn"), and
	 * decides the break line (`livedNight`: alive in the world every tick since midnight).
	 */
	onDawn?: (sp: ServerPlayer, livedNight: boolean) => void;
	/**
	 * May this survivor's run earn coins? (§9.3 assisted run: an admin used world tools in it.) The
	 * simulation has no idea who an admin is; server/main.server.ts owns that and wires this in. Left
	 * undefined, every run pays — which is what a pure test wants.
	 */
	paysRewards?: (sp: ServerPlayer) => boolean;
	/**
	 * The admin's switches (docs/MULTIPLAYER.md §10: god, noclip, infinite ammo) onto this survivor's body, right
	 * before its step. They belong to the PERSON, not to a body: a stand-up, a reset or a trip to the lobby builds a
	 * new body, and the switch must still be on in it. server/admin/adminWorld.ts sets it; undefined = nobody has any.
	 */
	adminMods?: (sp: ServerPlayer) => void;
	/**
	 * The authoritative horde (§3.3, §3.5), or undefined while MP_PHASE < 2 and every client still simulates
	 * its own. F2-2D reads the zombies, their netIds and their deaths from here. Like everything built around the
	 * town (combat, progress, projectiles and the F3 world below) it is rebuilt when a world ends (MP-22).
	 */
	horde?: ZombieWorld;
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
	combat?: ServerCombat;
	/** XP, kills and boss credit straight into the live saves (§3.6, 2C) */
	progress?: Progress;
	/** arrows, flames, acid and needles in flight (§3.1 step 2) */
	projectiles?: ServerProjectiles;
	/**
	 * The interactive world (§11.3 F3), or undefined while every client still owns its own copy of it.
	 * `worldOut` exists either way, because it costs nothing and it keeps server/net/replication.ts from
	 * having to ask whether F3 is on.
	 */
	items?: ServerItems;
	interaction?: ServerInteraction;
	build?: ServerBuild;
	craft?: ServerCraft;
	/**
	 * The bicycles and motorcycles being ridden (DESIGN_RULES VEI-05). Built with the constructions, because a vehicle
	 * IS one: it exists wherever the server owns the placed builds, and nowhere else.
	 */
	vehicles?: ServerVehicles;
	/**
	 * (VEI-05) Everything that happens to a ride: on, off (and why), a crash, the horn, and every second the distance
	 * ridden -- the odometer the "Rider" achievement counts. Undefined drops them.
	 */
	onRide?: (sp: ServerPlayer, e: RideEvent) => void;
	/**
	 * (VEI-05) A vehicle made a noise: the engine every half second, the horn or the bell, a crash. It has already
	 * reached the horde through `emitSound` (their hearing today) when this is called; this is the same event for
	 * anything else that listens.
	 */
	onVehicleNoise?: (noise: VehicleNoise) => void;
	/** the electric grid (ELE-01..08): boxes, generators, switched machines, drones — with the interactive world */
	power?: ServerPower;
	/** the machines that shoot (ELE-04, ELE-05) — with the grid AND the horde they shoot at */
	turrets?: ServerTurrets;
	/**
	 * The town's window glass (EDI-18): the global DoorSet of every pane that breaks, the tick's budget, and the reach,
	 * line and rate of a survivor breaking one. With the interactive world: where the server owns the doors, it owns
	 * the glass.
	 */
	windows?: ServerWindows;
	/** reliable world deltas produced this tick; server/net/replication.ts drains it (§4.5) */
	readonly worldOut = new WorldOut();
	/**
	 * the result of a survivor's action press, for the caller's sounds and toasts -- and of a supply walked up
	 * (ITM-07: `ServerItems.walkOver`), which is the press's `item` outcome without the press
	 */
	onInteract?: (sp: ServerPlayer, outcome: InteractOutcome) => void;
	/** the walk-over's report, bound once (a closure per tick would be garbage): the same `item` outcome as E's */
	private readonly walkTaken = (who: WalkingSurvivor, got: PickupResult): void => {
		const sp = this.bySlot.get(who.slot);
		if (sp !== undefined && got.ok && this.onInteract !== undefined) {
			this.onInteract(sp, { kind: "item", count: got.count });
		}
	};
	/** §9.3 for the walk-over, bound once: a supply walked up credits the collector only in a run that earns (as E's) */
	private readonly walkPays = (slot: number): boolean => this.paysSlot(slot);
	/** the result of a backpack intent (craft, use, equip, learn, switch), or of a pack delivered on the server */
	onBackpack?: (sp: ServerPlayer, outcome: BackpackOutcome) => void;
	/**
	 * The backpack verbs (server/sim/backpack.ts): queued per survivor, applied right before the command they were
	 * made during (§2.4), acknowledged by nonce. It outlives a town (MP-22): the acks are about the connection.
	 */
	readonly backpack: ServerBackpack;
	/**
	 * A cosmetic effect the simulation asked for, already in wire form (§4.1 Fx). server/net/mpHost.ts points
	 * it at the replicator; a caller that leaves it undefined simply drops the effects, which is what the
	 * pure tests want.
	 */
	onFx?: (event: FxEvent) => void;
	/**
	 * Milliseconds each phase of the LAST tick took (§12.2, server/sim/metrics.ts SIM_PHASES), the horde's own phases
	 * included. All zero until `instrument` hands the simulation a clock; `takeCosts` averages them over a window.
	 */
	readonly cost: PhaseCosts = newPhaseCosts();
	/**
	 * The MicroProfiler labels (`PZ.*`), or undefined. Set by `instrument`; the replicator labels its own phases with
	 * it (server/net/replication.ts).
	 */
	profile?: SimProfiler;

	private readonly bySlot = new Map<number, ServerPlayer>();
	/** slots in ascending order: iteration is deterministic (a Luau Map is not ordered) */
	private readonly order = new Array<number>();
	/** the same survivors, in the same order, as one reusable array the world half of the tick walks */
	private readonly roster = new Array<ServerPlayer>();
	/** the bodies and the horde, as the interaction and placement queries want them (rebuilt per tick) */
	private readonly bodies = new Array<PlayerState>();
	/** the slot of each entry of `bodies`, in the same order: the roster index is NOT the slot */
	private readonly bodySlots = new Array<number>();
	/** §3.6: who was alive and at the controls during the current world day, by UserId */
	private readonly presence = new Map<number, Presence>();
	/** the filtered ping of whoever played on this server lately, by UserId, and the tick it was last sampled (`setPing`) */
	private readonly pings = new Map<number, PingMemory>();
	/** ticks the world ran since the previous midnight (or since boot): what "half the day" is half of */
	private dayTicks = 0;
	/** the Heartbeat's debt (server/sim/heartbeat.ts): the one rule test:input drives too */
	private readonly beat: TickAccumulator;
	/** `restartWorld` committed a new town: the next `advance` runs one tick and forgets the rest of its delta */
	private resetBeat = false;
	private readonly samples = new Array<number>();
	private sampleAt = 0;
	/** the clock of the per-phase costs (`instrument`), or undefined: then the tick measures nothing */
	private nowMs?: () => number;
	/** the costs summed since the last `takeCosts`, and how many ticks that is */
	private readonly costSum: PhaseCosts = newPhaseCosts();
	private costTicks = 0;
	/** what the boot decided this server owns; a world that ends is rebuilt with the very same answers (MP-22) */
	private readonly ownsHorde: boolean;
	private readonly ownsInteractive: boolean;
	/** the survivor whose weapon machine is running this instant (the `chop` hook spills toward them) */
	private swinger?: ServerPlayer;

	constructor(options: SimulationOptions) {
		this.world = options.world;
		const hz = options.simHz ?? SIM_HZ;
		this.simHz = hz > 0 ? hz : SIM_HZ;
		this.tickDt = 1 / this.simHz;
		this.beat = new TickAccumulator(this.tickDt);
		this.clock = options.clock ?? new WorldClock();
		// §3.6: the world rolled into a new day. Whoever LIVED through it — alive now, alive in the world for at
		// least half of it, and at the controls in the last minutes — gets +1 day of life, the day's coins and any
		// record milestone, paid HERE because this is where the day is generated (§6.3: a reward the server
		// generates is a reward the server pays). Before the security review of Sep 2026 the whole roster was
		// paid: the dead, and a bot parked in the street.
		this.clock.onNewDay = () => this.creditMidnight();
		// MON-05: at 06:00 the night is over, and who lived through ALL of it since the midnight that paid them is a
		// Survivor. Like the midnight, it happens only as the clock runs: an admin moving the hands credits nobody
		this.clock.onDaybreak = () => this.creditDawn();
		// ...and a night the admin skipped through is nobody's (the hands moved: that midnight's credit is forgotten)
		this.clock.onClockSet = () => {
			for (const [, p] of this.presence) p.nightCredited = false;
		};
		this.ownsInteractive = options.interactive ?? MP_PHASE >= WORLD_SERVER_PHASE;
		this.ownsHorde = options.zombies ?? MP_PHASE >= 2;
		this.backpack = new ServerBackpack({
			craft: () => this.craft,
			placing: slot => this.build?.placing(slot) === true,
			simHz: this.simHz,
			// the pack's items land in the server's save only where the server owns the backpack; below that phase the
			// client still delivers them into its own copy and reports it
			deliversPacks: this.ownsInteractive,
		});
		this.backpack.onOutcome = (sp, msg, outcome) => {
			// a usable the server accepted is heard where the survivor stands (P0-4): eaten, torn, unzipped, rattled
			if (outcome.kind === "used") {
				const sound = wireSoundId(useSoundOf(outcome.item));
				this.onFx?.({ t: FxType.Sound, sound, x: sp.state.x, y: sp.state.y, volume: 1 });
			}
			this.onBackpack?.(sp, outcome);
		};
		this.backpack.onPacks = (sp, opened) => this.onBackpack?.(sp, { kind: "delivered", packs: opened });
		this.adoptSystems(this.buildAround(this.world));
	}

	/**
	 * MP-22: the world ended — nobody was left alive and nobody paid a Rebirth — and `world`, a town generated from a
	 * new seed, takes its place. Everything that belonged to the old town goes with it, through the SAME path the
	 * boot took (`buildAround`): the horde and the bosses, the projectiles in flight, the combat's rewind history,
	 * the kill credit, and — where the server owns them (F3) — the ground items, the loot timers, the doors, the
	 * fires and the constructions. The clock opens day 1 at 07:00 with no night promised (`WorldClock.restart`),
	 * and the §3.6 day count starts again.
	 *
	 * What stays: the survivors in their slots, their input queues and the tick counter — the session (and the
	 * clock epoch every client is anchored to) does not end with the town. Their BODIES belong to the old streets,
	 * though, and are not touched here: server/sim/life.ts `restartWorld` puts every one of them somewhere in the
	 * new town. A construction still on somebody's cursor is refunded, as leaving the world would refund it.
	 *
	 * ALL OR NOTHING (review of f851ad2, M2): the new town's systems are built into a local first, and only once
	 * every one of them exists does anything of the old town change. A failure while building throws with this
	 * simulation exactly as it was — the one thing construction touches outside itself, the clock's `onWaveFill`
	 * (a ZombieWorld subscribes on construction), is put back — so the caller can let the old world go on.
	 */
	restartWorld(world: WorldData): void {
		const fill = this.clock.onWaveFill;
		const [built, systems] = pcall(() => this.buildAround(world));
		if (!built) {
			this.clock.onWaveFill = fill;
			throw systems;
		}
		// from here on nothing is built, only swapped
		for (const sp of this.roster) this.build?.remove(sp.slot, sp.save);
		// a vehicle under somebody belonged to the old streets, like the rest of what they built (VEI-05)
		for (const sp of this.roster) sp.state.ride = undefined;
		// the old town stops feeding the outbox: nothing that happens to it is news any more
		this.items?.detach();
		this.build?.detach();
		this.windows?.detach();
		this.worldOut.clear();
		this.backpack.clear();
		// §3.6 counts the new world's first day from its first tick, exactly as a midnight would start it (the last
		// real input is about minutes, not days, and is kept); a night half-lived in the old town is no Survivor's
		for (const [, p] of this.presence) {
			p.aliveTicks = 0;
			p.nightCredited = false;
		}
		this.dayTicks = 0;
		this.world = world;
		this.clock.restart();
		this.adoptSystems(systems as TownSystems);
		// the reset is committed: the old world's Heartbeat debt is not the new one's to repay, and neither is the
		// time this reset is taking (generating the town, 100-250 ms), which the NEXT heartbeat's delta will carry
		this.forgiveBacklog();
		this.resetBeat = true;
	}

	/** the systems of one town become this simulation's (the boot's, or a new world's once all of them exist) */
	private adoptSystems(systems: TownSystems): void {
		this.items = systems.items;
		this.build = systems.build;
		this.craft = systems.craft;
		this.interaction = systems.interaction;
		this.vehicles = systems.vehicles;
		this.horde = systems.horde;
		this.progress = systems.progress;
		this.projectiles = systems.projectiles;
		this.combat = systems.combat;
		this.power = systems.power;
		this.turrets = systems.turrets;
		this.windows = systems.windows;
		// a new town's horde is measured like the old one was
		if (this.nowMs !== undefined || this.profile !== undefined) this.instrumentHorde();
	}

	// ---------------------------------------------------------------- metrics (§12.2, F6)

	/**
	 * Gives the tick a milliseconds clock for the per-phase costs and a MicroProfiler to label its phases with, down
	 * into the horde (whose `nowMs` / `profile` this sets, now and for every new town). server/net/mpHost.ts passes
	 * `os.clock` and `debug.profilebegin` / `profileend`; the pure tests pass nothing and the tick measures nothing.
	 */
	instrument(nowMs?: () => number, profile?: SimProfiler): void {
		this.nowMs = nowMs;
		this.profile = profile;
		this.instrumentHorde();
	}

	private instrumentHorde(): void {
		const horde = this.horde;
		if (horde === undefined) return;
		horde.nowMs = this.nowMs;
		horde.profile = this.profile;
	}

	/**
	 * The average milliseconds per tick of every phase since the previous call, written into `out`, which is
	 * returned; the window starts over. Returns zeros while nothing was measured. The host publishes it once a second
	 * next to `pz_tick_p95_ms` (server/net/mpHost.ts).
	 */
	takeCosts(out: PhaseCosts): PhaseCosts {
		const n = this.costTicks;
		for (const phase of SIM_PHASES) {
			out[phase] = n > 0 ? this.costSum[phase] / n : 0;
			this.costSum[phase] = 0;
		}
		this.costTicks = 0;
		return out;
	}

	/** the time since `t0` goes to `phase`; returns the new reading (0, and nothing measured, without a clock) */
	private lap(phase: SimPhase, t0: number): number {
		const now = this.nowMs;
		if (now === undefined) return 0;
		const t1 = now();
		this.cost[phase] = t1 - t0;
		this.costSum[phase] += t1 - t0;
		return t1;
	}

	/** the horde measured its own phases with the same clock: they stand in for its one entry */
	private lapHorde(horde: ZombieWorld): number {
		const now = this.nowMs;
		if (now === undefined) return 0;
		const c = horde.cost;
		this.cost.clock = c.clock;
		this.cost.population = c.population;
		this.cost.field = c.field;
		this.cost.zombies = c.zombies;
		this.cost.bosses = c.bosses;
		this.cost.book = c.book;
		this.costSum.clock += c.clock;
		this.costSum.population += c.population;
		this.costSum.field += c.field;
		this.costSum.zombies += c.zombies;
		this.costSum.bosses += c.bosses;
		this.costSum.book += c.book;
		return now();
	}

	/**
	 * Everything that is built around ONE town: the F3 interactive world when this server owns it, then the horde
	 * with its combat, kill credit and projectiles when it owns the world (§11.3). The boot calls it once;
	 * `restartWorld` calls it again for each new town, so a new world is exactly what a new server would build.
	 * It builds into the returned table and assigns nothing on `this`: the closures read `this.horde` and the
	 * roster when they RUN, which is after `adoptSystems`.
	 */
	private buildAround(world: WorldData): TownSystems {
		const out: TownSystems = {};
		// ---- F3: the interactive world (items, loot, doors, lights, builds, crafting) ----------------
		if (this.ownsInteractive) {
			// from here on everything this world creates takes a dynamic id (§4.5), so a client's mirror can
			// tell "the server made this" from "we both generated this from the seed"
			serverWorld(world);
			const items = new ServerItems({
				world,
				out: this.worldOut,
				visible: (slot, x, y) => this.itemVisible?.(slot, x, y) ?? true,
			});
			// the survivors' bodies, as refreshed every tick: who is near an item when it appears (§4.5)
			items.watch(this.bodies, this.bodySlots);
			out.items = items;
			// the grid keeps its machines by the build's world hooks, so it exists first (ELE-01)
			const power = new ServerPower({
				world,
				clock: this.clock,
				simHz: this.simHz,
				// the maker's Robotics / Engineering, while they are in the world
				saveOf: slot => this.bySlot.get(slot)?.save,
				// a drone escorts a survivor who is in the world and alive
				bodyOf: slot => {
					const sp = this.bySlot.get(slot);
					return sp !== undefined && !sp.state.dead ? sp.state : undefined;
				},
				// §4.5: global, like the construction itself (a drone flies with its survivor, far from its pad)
				publish: (s, state, pilot) => this.worldOut.queue(powerSet(s, state, pilot)),
				// §9.3: an assisted run earns no achievement (Thomas Edison), as it earns no coins
				paysRewards: slot => this.paysSlot(slot),
			});
			out.power = power;
			const build = new ServerBuild({
				world,
				out: this.worldOut,
				// the horde is built below; the closure defers the lookup so a wall dirties the flow field
				// (§3.3) whether or not there is a horde walking it yet
				onSolidChanged: (x, y, w, h) => this.horde?.refs.onSolidChanged?.(x, y, w, h),
				onSolid: (s, added) => power.note(s, added),
				// MP-24: the caps and the rot of abandoned constructions go by the account, read live off the roster
				userOf: slot => this.bySlot.get(slot)?.userId,
				present: userId => this.roster.some(sp => sp.userId === userId),
				// the MP-24 walk is a bar of its own in the MicroProfiler ("PZ.build.sealed")
				profile: () => this.profile,
			});
			out.build = build;
			// EDI-18: the town's glass. Every pane that breaks is a global DoorSet (the world's hook: a zombie's blow too),
			// and a pane giving way is heard and walked through by THIS town's horde, read when it breaks
			const windows = new ServerWindows({
				world,
				out: this.worldOut,
				horde: () => this.horde?.refs,
				fx: event => this.onFx?.(event),
			});
			out.windows = windows;
			out.interaction = new ServerInteraction({
				world,
				items,
				out: this.worldOut,
				fx: event => this.onFx?.(event),
				machines: power,
				// a door is a way in or a wall to the horde (§3.3), exactly like a construction going up or down
				onSolidChanged: (x, y, w, h) => this.horde?.refs.onSolidChanged?.(x, y, w, h),
				// §9.3: an assisted run's pickups and searches earn no achievement (Woodpile), as it earns no coins
				paysRewards: slot => this.paysSlot(slot),
				windows,
				// IA-02: a door turning is heard by the next zombie over; EDI-24: the bank vault's work, its door giving
				// way and its alarm
				noise: (x, y, radius, shot) => {
					const horde = this.horde;
					if (horde !== undefined) emitSound(horde.refs, x, y, radius, shot === true);
				},
			});
			// VEI-05: a parked vehicle is one of the constructions above; this is getting on, riding and getting off.
			// The hooks read the combat and the horde when they RUN (both are built below, or not at all)
			out.vehicles = new ServerVehicles({
				world,
				noise: n => this.vehicleNoise(n),
				fx: event => this.onFx?.(event),
				event: (sp, e) => this.onRide?.(sp, e),
				hooks: {
					hurt: (sp, raw, dir) => {
						if (this.combat !== undefined) this.combat.damagePlayer(sp, raw, dir, true);
						else if (applyPlayerDamage(sp.state, sp.save, raw, true)) sp.state.reactionDir = dir;
					},
					ram: (sp, z, damage, knock, stun, away) => {
						// weapon kind -1: a kill by the vehicle is nobody's weapon (not the holstered one), so it counts for
						// the kill credit and Street Sweeper, never for Quiet Archer or Long Shot (review of 5874cfa, V3)
						if (this.combat !== undefined) this.combat.hitZombieWith(sp, z, damage, knock, stun, away, -1);
						else reactToHit(z, away, knock, stun);
					},
					shove: (z, dir, knock, stun) => reactToHit(z, dir, knock, stun),
				},
				// §9.3: an assisted run rides, and earns no Road Trip point
				paysRewards: sp => this.pays(sp),
			});
		}
		// the backpack verbs work with or without the interactive world (server/sim/backpack.ts): only a build recipe
		// needs `build`, and ServerCraft refuses one without it before anything is spent. An assisted run cooks and
		// smelts, and earns no Camp Cook nor Metalworker (§9.3)
		out.craft = new ServerCraft({ world, build: out.build, paysRewards: slot => this.paysSlot(slot) });

		if (!this.ownsHorde) return out;
		const horde = new ZombieWorld(world, this.clock);
		out.horde = horde;
		const progress = new Progress({
			saveOf: slot => this.bySlot.get(slot)?.save,
			paysRewards: slot => this.paysSlot(slot),
			// MON-05: the killing blow that made a Horde Breaker
			titleUnlocked: (slot, titleId) => {
				const sp = this.bySlot.get(slot);
				if (sp !== undefined) this.onTitleUnlocked?.(sp, titleId);
			},
		});
		out.progress = progress;
		const projectiles = new ServerProjectiles({
			playerOf: slot => this.bySlot.get(slot),
			onFx: event => this.onFx?.(event),
			// EDI-18: an arrow that stopped at a pane breaks it, like a bullet (its flight is its line)
			glass: s => this.windows?.byShot(s) === "broken",
		});
		out.projectiles = projectiles;
		const combat = new ServerCombat({
			world,
			targets: {
				zombies: () => horde.zombies,
				bosses: () => horde.bossRoster.list,
				// read when a shot RUNS, so the replication layer can set it after this town was built
				viewExtraTicks: (slot, z, viewTick) => this.zombieViewLag?.(slot, z, viewTick) ?? 0,
			},
			progress,
			simHz: this.simHz,
			hooks: {
				// the reaction, the stun and the hunt the hit seeds belong to the horde's own brain (2A);
				// combat only ever decides HOW MUCH hp came off
				hitZombie: (z, damage, dir, knock, stun) => {
					reactToHit(z, dir, knock, stun);
					// a blow landing on a body is a thud the next zombie over hears (shared/sim/ai/noise.ts, LOW)
					emitSound(horde.refs, z.x, z.y, Noise.HIT, false);
				},
				noise: (x, y, radius, shot, gun) => emitSound(horde.refs, x, y, this.gunNoise(x, y, radius, gun), shot),
				fx: event => this.onFx?.(event),
				// a bow and a flamethrower do not fire a ray: they ask the world to fly something (§2.3)
				projectile: request => projectiles.launch(horde.refs, request),
				// F3: a blade that crosses a tree, a car or a bin may knock something out of it, toward whoever swung
				// (server/sim/items.ts). Only where the server owns the items; the swinger is the survivor whose
				// weapon machine is running
				chop: (s, chopping) => {
					const items = this.items;
					const by = this.swinger;
					if (items === undefined || by === undefined) return false;
					return items.hitMapItem(s, chopping, by.state.x, by.state.y);
				},
				// EDI-18: a bullet that stopped at a pane breaks it (the ray is its line); a blade's arc that crossed one
				// breaks it by hand -- reach, a clear line and the swinger's rate (server/sim/windows.ts)
				glass: (s, melee, reach) => {
					const windows = this.windows;
					if (windows === undefined) return false;
					if (!melee) return windows.byShot(s) === "broken";
					const by = this.swinger;
					// a swing, not a press: its refusals are no evidence against the swinger
					return by !== undefined && windows.byHand(by.slot, by.state, s, reach, false) === "broken";
				},
			},
		});
		out.combat = combat;
		projectiles.combat = combat;
		// the machines that shoot (ELE-04, ELE-05): they need the grid (F3) AND the horde; a lamp drone's light is
		// one the horde sees by
		const power = out.power;
		if (power !== undefined) {
			horde.refs.carriedLights = power.lights;
			out.turrets = new ServerTurrets({
				world,
				power,
				zombiesNear: (x, y, r, tick, found) => horde.zombiesNear(x, y, r, tick, found),
				bosses: () => horde.bossRoster.list,
				damage: combat,
				fx: event => this.onFx?.(event),
				noise: (x, y, radius) => emitSound(horde.refs, x, y, radius, true),
				// EDI-18: a turret's bullet breaks the pane it stops at, like a survivor's (the ray is its line)
				glass: s => this.windows?.byShot(s) === "broken",
			});
		}
		// §2.3/MP-00: from here on a survivor only ever loses hp through the server's combat. The brains still
		// call `damageToPlayer`, which is inert at MP_PHASE ≥ 2 — this sink is what makes the bite land.
		horde.refs.damagePlayer = combat.damageSink(p => this.slotOfState(p));
		// the kill XP is paid by `combat` at the instant hp reaches 0, killer and assists together (§3.6).
		// `onExp` fires LATER, from the brain that removes the body, for that very same zombie: paying it
		// again would double every kill, so it deliberately credits nobody.
		horde.onExp = () => {};
		return out;
	}

	/** VEI-05: a vehicle's noise reaches the horde's hearing first, then whoever else listens (`onVehicleNoise`) */
	private vehicleNoise(n: VehicleNoise): void {
		if (this.horde !== undefined) emitSound(this.horde.refs, n.x, n.y, n.radius, false);
		this.onVehicleNoise?.(n);
	}

	/**
	 * How far a shot fired from (x, y) is heard. The combat hook hands the horde the pistol's radius — the
	 * original's single 800, a third with the silencer — and the ears grade it by the CLASS of the gun
	 * (shared/sim/ai/noise.ts: a rifle or a shotgun carries 1.4×, a sniper 1.75×): the gun that fired, as the
	 * combat names it. A caller that names none falls back on the survivor standing exactly where the shot left
	 * from; nobody there (a turret, a future caller) keeps the pistol's.
	 */
	private gunNoise(x: number, y: number, radius: number, gun?: WeaponDef): number {
		if (gun !== undefined) return radius * Noise.gunClassScale(gun.kind, gun.id);
		for (const sp of this.roster) {
			if (sp.state.x !== x || sp.state.y !== y) continue;
			const w = currentWeapon(sp.state);
			return radius * Noise.gunClassScale(w.kind, w.id);
		}
		return radius;
	}

	/** §9.3: does this survivor's run still earn coins? (`paysRewards` unset = yes) */
	private pays(sp: ServerPlayer): boolean {
		return this.paysRewards === undefined || this.paysRewards(sp);
	}

	/** the same, for the survivor in `slot` (nobody there: nothing to withhold) */
	private paysSlot(slot: number): boolean {
		const sp = this.bySlot.get(slot);
		return sp === undefined || this.pays(sp);
	}

	/** §3.6 at the world's midnight: pay who earned the day (`dayRefusal`), then start counting the next one */
	private creditMidnight(): void {
		const span = this.dayTicks;
		for (const sp of this.roster) {
			const p = this.presence.get(sp.userId);
			if (p !== undefined) p.nightCredited = false;
			const refused = dayRefusal(sp.state.dead, p?.aliveTicks ?? 0, span, p?.activeTick, this.tick, this.simHz);
			if (refused !== undefined) {
				if (this.onDayRefused !== undefined) this.onDayRefused(sp, refused);
				continue;
			}
			const paid = this.pays(sp);
			const credit = creditDaySurvived(sp.save, paid);
			if (this.onDayCredit !== undefined) this.onDayCredit(sp, credit);
			// MON-05, on the very day count that paid it (so its presence and AFK rules come with it): this midnight
			// may make a Survivor at 06:00, and it is one more night of this life -- the seventh makes a Week One. An
			// assisted run (§9.3) keeps its day and earns no title and no night, as it earns no coins
			if (!paid) continue;
			if (p !== undefined) p.nightCredited = true;
			if (!credit.advanced) continue;
			const unlocked = creditLifeNight(sp.save);
			if (unlocked >= 0 && this.onTitleUnlocked !== undefined) this.onTitleUnlocked(sp, unlocked);
		}
		// a new day for everybody: the survivors in the world start it at 0, anybody else is forgotten (they start
		// at 0 too whenever they come back); the last real input is kept, it is about minutes, not days
		const inWorld = new Set<number>();
		for (const sp of this.roster) inWorld.add(sp.userId);
		for (const [userId, p] of this.presence) {
			if (inWorld.has(userId)) p.aliveTicks = 0;
			else this.presence.delete(userId);
		}
		this.dayTicks = 0;
	}

	/**
	 * MON-05 at 06:00: the night is over. A Survivor is whoever the midnight inside it paid AND who stayed alive in the
	 * world for every tick since, awake at the controls after it (`survivedNight`). `dayTicks` restarted at that midnight, so
	 * it is exactly the ticks of the night since. Nobody keeps the mark past this: the next night starts from zero.
	 */
	private creditDawn(): void {
		for (const sp of this.roster) {
			const p = this.presence.get(sp.userId);
			if (p === undefined) continue;
			const lived = survivedNight(
				p.nightCredited === true,
				sp.state.dead,
				p.aliveTicks,
				this.dayTicks,
				p.activeTick,
				this.tick,
				this.simHz,
			);
			// …and a run an admin helped along since midnight (§9.3) earns nothing, as at midnight itself
			if (lived && this.pays(sp)) this.unlockTitle(sp, TitleId.Survivor);
		}
		for (const [, p] of this.presence) p.nightCredited = false;
		// BEM-04: the night is over for everybody standing -- the moment the dawn card reports on, so the save goes soon --
		// and whether they lived it: alive in the world every tick since midnight (the count the Survivor title reads,
		// without its AFK part), for the break line's rule (shared/data/wellbeing.ts `breakNudgeEarned`)
		if (this.onDawn !== undefined) {
			for (const sp of this.roster) {
				if (sp.state.dead) continue;
				const p = this.presence.get(sp.userId);
				this.onDawn(sp, p !== undefined && this.dayTicks > 0 && p.aliveTicks >= this.dayTicks);
			}
		}
	}

	/** `titleId` is this survivor's now: into the save once, and announced once (server/save/titles.ts) */
	private unlockTitle(sp: ServerPlayer, titleId: number): void {
		if (grantTitle(sp.save, titleId) && this.onTitleUnlocked !== undefined) this.onTitleUnlocked(sp, titleId);
	}

	/** one tick of §3.6 bookkeeping; `acted` = a REAL command with movement or an edge was consumed this tick */
	private notePresence(sp: ServerPlayer, acted: boolean): void {
		let p = this.presence.get(sp.userId);
		if (p === undefined) {
			p = { aliveTicks: 0 };
			this.presence.set(sp.userId, p);
		}
		if (!sp.state.dead) p.aliveTicks += 1;
		if (acted) p.activeTick = this.tick;
	}

	/**
	 * §9.3, the admin's players table: seconds since this survivor last sent a REAL command with movement or an edge
	 * (the same test MP-13's AFK rule uses), counted from their entry when they have sent none. Read-only; undefined
	 * for someone not in the world.
	 */
	idleSeconds(sp: ServerPlayer): number {
		const since = this.presence.get(sp.userId)?.activeTick;
		const from = since !== undefined ? math.max(since, sp.joinTick) : sp.joinTick;
		return math.max(0, (this.tick - from) / this.simHz);
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
		// the welcome that follows (server/sim/life.ts) hands this client every item around the spawn point
		this.items?.welcomed(sp.slot, sp.state.x, sp.state.y);
		// MP-24: what this account built is theirs again, in this slot, and stops rotting
		this.build?.enter(sp.slot);
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
		// a vehicle under them stays in the town, where they were (VEI-05) -- before the builds forget the slot
		this.vehicles?.remove(sp);
		// a construction still on the cursor is refunded, not forfeited: they paid for it
		this.build?.remove(slot, sp.save);
		this.craft?.remove(slot);
		this.interaction?.remove(slot);
		this.windows?.remove(slot);
		// the drones escorting them fly home
		this.power?.remove(slot);
		this.items?.forget(slot);
		this.backpack.remove(slot);
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
		// ...and the bodies with it, so something made between two ticks (an admin's drop) already knows who is near
		this.refreshBodies();
	}

	get(slot: number): ServerPlayer | undefined {
		return this.bySlot.get(slot);
	}

	/**
	 * The same survivors as `players()`, in the same order, WITHOUT the copy: the simulation's own roster. For the
	 * loops that run every tick and cannot see anybody join or leave while they run (the replication's: a join or a
	 * leave happens between two ticks, and rebuilds this array in place). Never keep it, never write it.
	 */
	survivors(): ReadonlyArray<ServerPlayer> {
		return this.roster;
	}

	/** every survivor in the world, always in ascending slot order (a copy: see `survivors` for the per-tick loops) */
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
	 * MAX_CATCHUP_TICKS. What is left over is debt for the next heartbeats, up to MAX_BACKLOG_S; beyond that it
	 * is dropped and counted — the world slows down instead of entering a catch-up spiral (§3.1). The rule itself
	 * is server/sim/heartbeat.ts, so that tools/test-input-buffer.mjs drives exactly this one.
	 */
	advance(dt: number): number {
		if (!isFiniteNumber(dt) || dt <= 0) return 0;
		if (this.resetBeat) {
			// the first heartbeat after `restartWorld`: its delta is mostly the reset itself. One tick, and the rest is
			// forgotten -- repaid, it would open the new world with a burst of double ticks off queues holding one command
			this.resetBeat = false;
			this.beat.forgive();
			dt = math.min(dt, this.tickDt);
		}
		const owed = this.beat.take(dt);
		this.stats.droppedTicks = this.beat.droppedTicks;
		this.stats.lateFrames = this.beat.lateFrames;
		for (let i = 0; i < owed; i++) this.step();
		this.stats.lastCatchup = owed;
		return owed;
	}

	/**
	 * The ping the host measured for this survivor, once a second (server/sim/combat.ts `setPing`: the rewind
	 * ceiling, slow to rise and quick to fall). The combat's slot state starts over on every leave/enter and with
	 * every new town (MP-22), and it takes a first sample as it is: a link throttled at the moment of re-entry set
	 * the ceiling at once (the review of dee095a, N4). So the filtered value is kept here, by UserId, and a returning
	 * survivor's first sample is filtered against it.
	 *
	 * For exactly as long as life.ts keeps their body (`bodyKept`): while they are connected -- in the world, or waiting
	 * in the lobby, where nothing samples it -- and KEEP_AFTER_LEAVE_S after they left, when the keeper lets the body
	 * go and this goes with it (`forgetPing`). Not for as long as the server runs: someone gone longer comes back as a
	 * newcomer, and the table holds the survivors of lately instead of everyone who ever played here (the second review
	 * of the zombie-motion branch, NIT 3). It used to go KEEP_AFTER_LEAVE_S after its last SAMPLE, and five minutes in
	 * the lobby had a throttled re-entry's first sample taken raw (the review of the zombie-motion branch, S3 NIT 3).
	 * Without a keeper, by the age of the last sample; swept when a survivor it has no valid entry for is measured.
	 */
	setPing(sp: ServerPlayer, seconds: number): void {
		const combat = this.combat;
		if (combat === undefined) return;
		const oldest = this.tick - KEEP_AFTER_LEAVE_S * this.simHz;
		let known = this.pings.get(sp.userId);
		const valid = known !== undefined && (known.at >= oldest || this.bodyKept?.(sp.userId) === true);
		if (known !== undefined && valid) combat.seedPing(sp.slot, known.pingS);
		combat.setPing(sp.slot, seconds);
		if (known === undefined || !valid) {
			this.forgetPingsBefore(oldest);
			known = { pingS: 0, at: 0 };
			this.pings.set(sp.userId, known);
		}
		known.pingS = combat.pingOf(sp.slot);
		known.at = this.tick;
	}

	/** drops every ping last sampled before tick `oldest` whose survivor's body life.ts no longer keeps */
	private forgetPingsBefore(oldest: number): void {
		const gone = new Array<number>();
		for (const [userId, p] of this.pings) {
			if (p.at < oldest && this.bodyKept?.(userId) !== true) gone.push(userId);
		}
		for (const userId of gone) this.pings.delete(userId);
	}

	/** life.ts let this survivor's body go (KEEP_AFTER_LEAVE_S after they left): their ping goes with it */
	forgetPing(userId: number): void {
		this.pings.delete(userId);
	}

	/** the Heartbeat debt still owed to the world, in seconds (§12.2 `pz_backlog_ms`) */
	backlogS(): number {
		return this.beat.owed();
	}

	/**
	 * How many commands past INPUT_BUFFER_MAX a survivor's queue may keep, `sinceBeatS` seconds after the last
	 * Heartbeat (server/sim/heartbeat.ts `grace`): the ticks of a debt this server is REPAYING, which will each consume
	 * one -- none for a debt it is not (a heartbeat under 30 Hz owes ticks it never runs). server/net/mpHost.ts passes
	 * it to `ingestInput`.
	 */
	inputGrace(sinceBeatS: number): number {
		// right after a world reset the lateness is the reset's own, which `advance` forgives: nothing to keep for
		return this.resetBeat ? 0 : this.beat.grace(sinceBeatS);
	}

	/**
	 * Forgets the Heartbeat debt. `restartWorld` calls it last (a hitch of the old world must not be repaid by the new
	 * one), and the time the reset itself took, which shows up in the NEXT heartbeat's delta, is clipped by `advance`.
	 * The ticks forgiven either way put `tick` behind `tick0Time + tick / SIM_HZ`; the clients re-anchor on it from
	 * the TimePongs (client/net/clockSync.ts), and their buffers re-lock after the WorldReset (`netReset`).
	 */
	forgiveBacklog(): void {
		this.beat.forgive();
	}

	/**
	 * One fixed step, in the §3.1 order: (1) input and movement for every survivor, (2) the world — clock,
	 * population, flow field, zombies, bosses — and then the replication through `onTick`.
	 *
	 * A dead survivor's commands are still consumed (the queue drains and the ack moves, so a revive does not
	 * replay a backlog), but `stepPlayer` does nothing with them: a dead body is inert (shared/sim/playerMove.ts).
	 * §7.3's downed crawl at 20 % is F4's, and will gate the command there, in the same one place.
	 */
	step(): void {
		const prof = this.profile;
		prof?.begin("PZ.step");
		const now = this.nowMs;
		let t0 = now !== undefined ? now() : 0;
		this.tick += 1;
		this.stats.ticks += 1;
		this.dayTicks += 1;
		// EDI-18: this tick's panes, whatever breaks them (survivors below, the horde after), and the hands' buckets
		this.windows?.beginTick(this.tickDt);
		prof?.begin("PZ.players");
		this.refreshBodies();
		for (const sp of this.roster) {
			this.adminMods?.(sp);
			const consumed = sp.counters.consumed;
			const cmd = takeCommand(sp);
			// §2.4: the backpack verbs made during this command land BEFORE it is simulated -- its movement (armour,
			// a skill) and its weapon machine (a switch) already see them, exactly as the client predicted them
			this.backpack.beforeCommand(sp, cmd, this.tick);
			const rode = sp.state.ride !== undefined;
			// one shared table (shared/sim/playerMove.ts): what is read after other systems ran is copied first
			const res = stepPlayer(this.world, sp.state, sp.save, cmd, this.tickDt);
			const died = res.died;
			// VEI-05: what the ride cost or caused this step (a crash, a zombie ahead, fuel, noise), on the same command
			this.vehicles?.afterStep(sp, res, this.horde?.zombies ?? EMPTY_ZOMBIES, this.tickDt);
			noteStep(sp, cmd, res.walking);
			// a filled tick consumes nothing (players.ts), so only a command the client really sent can count — and
			// only a step that actually walked, or an edge: a stick held against a wall repeats itself for free. A
			// rider's step never "walks" (no feet, no footsteps: VEI-05), so for them the stick moving the vehicle is the
			// presence -- else three minutes on a motorcycle read as AFK and lost the day's credit (review V1)
			const went = res.walking || (rode && res.moved > WALK_EPSILON);
			const arrived = sp.counters.consumed > consumed;
			this.notePresence(sp, arrived && ((cmd.moveMag > 0 && went) || cmd.edges !== 0));
			// the weapon machine runs on the SAME command as the movement: the aim a shot is fired along is
			// the one the player was holding when they walked that step, never the one two ticks later. While a
			// construction is on the cursor the attack and reload edges are the builder's (place, rotate): the weapon
			// stays holstered, exactly as the client's `updatePredicted` holds it (§2.3 "posição de construção"). On a
			// vehicle both hands are on the bars (VEI-05): holstered too, and the attack button is the bell or horn. And a
			// weapon the survivor PUT AWAY (ITM-06, the Holster verb) is holstered by choice: no shot, no swing, no reload
			// -- while this very command's E, build edges and horn still reach `stepWorldActions` below, untouched
			this.swinger = sp;
			const holster =
				sp.state.holstered === true ||
				this.build?.placing(sp.slot) === true ||
				this.vehicles?.riding(sp.slot) === true;
			this.combat?.stepPlayer(sp, holster ? holstered(cmd) : cmd, this.tick, this.tickDt);
			this.swinger = undefined;
			// ...and so do the discrete actions (§2.4): the E press and the build edges belong to the command
			// the player made them during, which is the one just consumed
			this.stepWorldActions(sp, cmd, arrived);
			if (died && this.onDeath !== undefined) this.onDeath(sp);
		}
		prof?.end();
		t0 = this.lap("players", t0);
		// the horde walks in the SAME tick as the survivors: one world, one clock, one set of positions
		const horde = this.horde;
		if (horde !== undefined) {
			if (this.roster.size() > 0) {
				prof?.begin("PZ.horde");
				horde.step(this.roster, this.tickDt, this.tick);
				prof?.end();
				t0 = this.lapHorde(horde);
				// after the bodies moved, so a flame burns what is in front of it NOW and not a tick ago
				prof?.begin("PZ.projectiles");
				this.projectiles?.step(horde.refs, this.tickDt);
				prof?.end();
				t0 = this.lap("projectiles", t0);
				// §3.1 "torretas e armadilhas": after the projectiles, at the zombies where they stand now
				prof?.begin("PZ.turrets");
				this.turrets?.step(this.tick, this.tickDt);
				prof?.end();
				t0 = this.lap("turrets", t0);
			} else {
				// nobody is in the world: there is no source for the flow field, no light, nothing to hunt
				// and nobody to see it. The clock keeps running (a server that empties at dusk must still be
				// dark when somebody joins, §4.6) and everything else stands still, which also means an
				// empty server costs nothing.
				this.clock.step(this.tickDt);
				t0 = this.lap("clock", t0);
			}
		}
		prof?.begin("PZ.world");
		this.stepInteractiveWorld();
		prof?.end();
		t0 = this.lap("world", t0);
		// §3.1 step 3, and it MUST be here: the history a shot rewinds into is the world as it ended this
		// tick, so recording it before the horde moved would compensate latency against stale positions
		prof?.begin("PZ.combat");
		this.combat?.afterWorld(this.tick);
		prof?.end();
		t0 = this.lap("combat", t0);
		prof?.begin("PZ.replication");
		if (this.onTick !== undefined) this.onTick(this.tick);
		prof?.end();
		this.lap("replication", t0);
		if (now !== undefined) this.costTicks += 1;
		prof?.end();
	}

	// ---------------------------------------------------------------- the interactive world (F3)

	/**
	 * A backpack verb (switch, use, equip, unequip, learn, craft) from one survivor (§2.4, §8.1). It is queued rather
	 * than applied on arrival, so it lands inside a tick, in order, right before the command it was made during
	 * (server/sim/backpack.ts) -- a switch and the shot after it, a craft and the step that carried the player to the
	 * desk, never interleave the wrong way round. It works whether or not this server owns the interactive world.
	 *
	 * The presence verbs are NOT handled here: server/net/mpHost.ts owns who is in the world.
	 */
	queueIntent(slot: number, msg: IntentMessage): boolean {
		const sp = this.bySlot.get(slot);
		if (sp === undefined) return false;
		return this.backpack.queue(sp, msg, this.tick);
	}

	/** the bodies array the interaction and placement queries take, rebuilt once per tick */
	private refreshBodies(): void {
		this.bodies.clear();
		this.bodySlots.clear();
		for (const sp of this.roster) {
			this.bodies.push(sp.state);
			this.bodySlots.push(sp.slot);
		}
	}

	/**
	 * The discrete half of one survivor's command (§2.4). While a construction is on the cursor the three
	 * edges mean build, exactly as `BuildSystem.handleInput` swallows the frame on the client; otherwise the
	 * action press is the E key and the server picks the target itself.
	 */
	private stepWorldActions(sp: ServerPlayer, cmd: InputCommand, arrived: boolean): void {
		const build = this.build;
		const interaction = this.interaction;
		if (build === undefined || interaction === undefined) return;
		// E held down (the command's held Action bit): the work at a bank's vault door goes on (EDI-24); a survivor who
		// died, walked off or let go stops there. Only a command the client really sent holds it: a tick filled with the
		// last input (players.ts) repeats the held bit, and a client gone silent with E down must not crack a vault
		interaction.hold(sp.slot, sp.state, sp.save, arrived && (cmd.held & HeldBit.Action) !== 0);
		if (sp.state.dead) return;
		const action = edgeCount(cmd.edges, EdgeShift.ActionPress);
		const attack = edgeCount(cmd.edges, EdgeShift.AttackPress);
		const reload = edgeCount(cmd.edges, EdgeShift.Reload);
		const vehicles = this.vehicles;
		if (vehicles !== undefined && vehicles.riding(sp.slot)) {
			// VEI-05: on a vehicle E gets off and the attack button is the bell or the horn; nothing else is in reach
			if (action > 0) vehicles.getOff(sp);
			if (attack > 0) vehicles.horn(sp);
			return;
		}
		if (build.placing(sp.slot)) {
			// keep the sticky ghost tracking this tick's position before any edge consumes it
			build.ghost(sp.slot, sp.state);
			if (reload > 0) build.rotate(sp.slot);
			if (action > 0) build.cancel(sp.slot, sp.save);
			if (attack > 0 && build.placing(sp.slot)) {
				const placed = build.place(sp.slot, sp.state, this.bodies, this.horde?.zombies ?? EMPTY_ZOMBIES);
				// hammering a construction into place is LOUD (shared/sim/ai/noise.ts): building costs attention
				const horde = this.horde;
				if (placed.kind === "placed" && horde !== undefined) {
					const s = placed.solid;
					emitSound(horde.refs, s.x + s.w / 2, s.y + s.h / 2, Noise.BUILD, true);
				}
			}
			return;
		}
		if (action <= 0) return;
		// EDI-18: the press is for a window's glass only when its command says so (protocol.ts note 23) -- and then it
		// is for nothing else: a bike parked under the window does not take it (the review of b61425a)
		const glass = (cmd.held & HeldBit.Glass) !== 0;
		// a rideable vehicle in reach takes the press (a broken one falls through: the interaction repairs it)
		if (!glass && vehicles !== undefined && vehicles.tryMount(sp)) return;
		const outcome = interaction.act({
			slot: sp.slot,
			state: sp.state,
			save: sp.save,
			players: this.bodies,
			zombies: this.horde?.zombies ?? EMPTY_ZOMBIES,
			hours: gameHours(this.clock.day, this.clock.dayTime),
			glass,
		});
		// MP-24: a repair of a construction that is rotting (its builder long gone) makes it the repairer's
		if (outcome.kind === "repair") build.adopt(outcome.solid, sp.slot);
		if (this.onInteract !== undefined) this.onInteract(sp, outcome);
	}

	/** the world's own upkeep: items in flight, loot that may respawn, fires burning down, cooldowns */
	private stepInteractiveWorld(): void {
		// the §8.1 cooldowns decay whether or not this server owns the interactive world: the backpack verbs run
		// through `craft` either way, and a cooldown that never decays is a verb held forever (review #11)
		this.craft?.step(this.tickDt);
		this.build?.step(this.tickDt);
		const items = this.items;
		if (items === undefined) return;
		updateGroundItems(this.world, this.tickDt);
		// litter rots whether or not anybody is here to see it (GROUND_ITEM_LIFE_S)
		items.upkeep(this.tickDt);
		this.vehicles?.step(this.tickDt);
		// the grid keeps running with nobody in town: the sun still charges the boxes (ELE-02)
		this.power?.step(this.tickDt, this.tick);
		if (this.roster.size() === 0) return;
		items.rollNearby(this.bodies, gameHours(this.clock.day, this.clock.dayTime), this.tickDt);
		// ITM-07: the supplies under each survivor's body, by the E press's own checks; the save is dirty as after one
		items.walkOver(this.roster, this.walkTaken, this.walkPays);
		items.sweepInterest(this.tickDt);
		this.interaction?.step(this.bodies, this.bodySlots, this.tickDt);
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

/** HeldBit.Attack and HeldBit.SniperAim: the weapon's own buttons */
const WEAPON_HELD = HeldBit.Attack + HeldBit.SniperAim;

/**
 * The command as the weapon machine sees it while a construction is on the cursor: the attack and reload edges and
 * the weapon's held buttons are the builder's (place, rotate), so the gun sees none of them. The action edge (cancel)
 * is not the weapon's either, and the movement and the aim are untouched: this is only what `combat.stepPlayer` reads.
 */
function holstered(cmd: InputCommand): InputCommand {
	return {
		seq: cmd.seq,
		moveAng: cmd.moveAng,
		moveMag: cmd.moveMag,
		aim: cmd.aim,
		held: cmd.held - (cmd.held & WEAPON_HELD),
		edges: 0,
	};
}
