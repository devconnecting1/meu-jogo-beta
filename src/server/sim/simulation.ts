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
import { MAX_PLAYERS, MP_PHASE, SIM_HZ } from "shared/net/mpConfig";
import { EdgeShift, edgeCount, FxEvent, IntentKind, IntentMessage } from "shared/net/protocol";
import { serverWorld, updateGroundItems, WorldData } from "shared/game/world";
import { currentWeapon, PlayerState } from "shared/game/player";
import { ZombieState } from "shared/game/entities";
import { gameHours } from "shared/sim/clock";
import { InputCommand } from "shared/net/protocol";
import { stepPlayer } from "shared/sim/playerMove";
import { emitSound, reactToHit } from "shared/sim/ai/zombieBrain";
import * as Noise from "shared/sim/ai/noise";
import { ServerBuild } from "./build";
import { TickAccumulator } from "./heartbeat";
import { ServerCombat } from "./combat";
import { BackpackOutcome, ServerCraft } from "./craft";
import { InteractOutcome, ServerInteraction } from "./interaction";
import { ServerItems } from "./items";
import { KEEP_AFTER_LEAVE_S } from "./life";
import { DayCredit, DayRefusal, Progress, creditDaySurvived, dayRefusal, survivedNight } from "./progress";
import { TitleId } from "shared/data/titles";
import { creditLifeNight, grantTitle } from "../save/titles";
import { ServerProjectiles } from "./projectiles";
import { ServerPlayer, noteStep, takeCommand } from "./players";
import { WorldClock } from "./waves";
import { WorldOut } from "./worldOut";
import { ZombieWorld } from "./zombies";

/**
 * MP_PHASE from which the SERVER owns the interactive world too: ground items, loot, doors, lights,
 * constructions, crafting and the backpack (docs/MULTIPLAYER.md §11.3 F3).
 *
 * It is deliberately one phase ABOVE the shipped `MP_PHASE`, because flipping it is a two-sided move: the
 * moment the server owns the items, the client must stop making its own and start drawing the `ItemAdd` /
 * `DoorSet` / `SolidAdd` deltas it currently ignores (client/net/netClient.ts, F3 front 3B/3C). Turning this
 * on before that lands would empty the town instead of sharing it. Everything below is written, wired and
 * tested at `world: true`; the switch is the last line of F3, not the first.
 */
export const WORLD_SERVER_PHASE = 3;

/** backpack intents one survivor may have waiting for their next tick (§8.2 caps the wire rate anyway) */
const INTENT_QUEUE_MAX = 8;
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
	horde?: ZombieWorld;
	progress?: Progress;
	projectiles?: ServerProjectiles;
	combat?: ServerCombat;
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
	 * May this survivor's run earn coins? (§9.3 assisted run: an admin used world tools in it.) The
	 * simulation has no idea who an admin is; server/main.server.ts owns that and wires this in. Left
	 * undefined, every run pays — which is what a pure test wants.
	 */
	paysRewards?: (sp: ServerPlayer) => boolean;
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
	/** reliable world deltas produced this tick; server/net/replication.ts drains it (§4.5) */
	readonly worldOut = new WorldOut();
	/** the result of a survivor's action press, for the caller's sounds and toasts */
	onInteract?: (sp: ServerPlayer, outcome: InteractOutcome) => void;
	/** the result of a backpack intent (craft, use, equip, learn) */
	onBackpack?: (sp: ServerPlayer, outcome: BackpackOutcome) => void;
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
	/** the bodies and the horde, as the interaction and placement queries want them (rebuilt per tick) */
	private readonly bodies = new Array<PlayerState>();
	/** the slot of each entry of `bodies`, in the same order: the roster index is NOT the slot */
	private readonly bodySlots = new Array<number>();
	/** backpack intents waiting for their slot's next step (§2.4) */
	private readonly intents = new Map<number, Array<IntentMessage>>();
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
	/** what the boot decided this server owns; a world that ends is rebuilt with the very same answers (MP-22) */
	private readonly ownsHorde: boolean;
	private readonly ownsInteractive: boolean;

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
		// the old town stops feeding the outbox: nothing that happens to it is news any more
		this.items?.detach();
		this.build?.detach();
		this.worldOut.clear();
		this.intents.clear();
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
		this.horde = systems.horde;
		this.progress = systems.progress;
		this.projectiles = systems.projectiles;
		this.combat = systems.combat;
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
			const items = new ServerItems({ world, out: this.worldOut });
			out.items = items;
			const build = new ServerBuild({
				world,
				out: this.worldOut,
				// the horde is built below; the closure defers the lookup so a wall dirties the flow field
				// (§3.3) whether or not there is a horde walking it yet
				onSolidChanged: (x, y, w, h) => this.horde?.refs.onSolidChanged?.(x, y, w, h),
			});
			out.build = build;
			out.craft = new ServerCraft({ world, build });
			out.interaction = new ServerInteraction({
				world,
				items,
				out: this.worldOut,
				fx: event => this.onFx?.(event),
			});
		}

		if (!this.ownsHorde) return out;
		const horde = new ZombieWorld(world, this.clock);
		out.horde = horde;
		const progress = new Progress({
			saveOf: slot => this.bySlot.get(slot)?.save,
			paysRewards: slot => {
				const sp = this.bySlot.get(slot);
				return sp === undefined || this.pays(sp);
			},
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
				noise: (x, y, radius, shot) => emitSound(horde.refs, x, y, this.gunNoise(x, y, radius), shot),
				fx: event => this.onFx?.(event),
				// a bow and a flamethrower do not fire a ray: they ask the world to fly something (§2.3)
				projectile: request => projectiles.launch(horde.refs, request),
			},
		});
		out.combat = combat;
		projectiles.combat = combat;
		// §2.3/MP-00: from here on a survivor only ever loses hp through the server's combat. The brains still
		// call `damageToPlayer`, which is inert at MP_PHASE ≥ 2 — this sink is what makes the bite land.
		horde.refs.damagePlayer = combat.damageSink(p => this.slotOfState(p));
		// the kill XP is paid by `combat` at the instant hp reaches 0, killer and assists together (§3.6).
		// `onExp` fires LATER, from the brain that removes the body, for that very same zombie: paying it
		// again would double every kill, so it deliberately credits nobody.
		horde.onExp = () => {};
		return out;
	}

	/**
	 * How far a shot fired from (x, y) is heard. The combat hook hands the horde the pistol's radius — the
	 * original's single 800, a third with the silencer — and the ears grade it by the CLASS of the gun
	 * (shared/sim/ai/noise.ts: a rifle or a shotgun carries 1.4×, a sniper 1.75×). The shooter is the survivor
	 * standing exactly where the shot left from; nobody there (a turret, a future caller) keeps the pistol's.
	 */
	private gunNoise(x: number, y: number, radius: number): number {
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
		// a construction still on the cursor is refunded, not forfeited: they paid for it
		this.build?.remove(slot, sp.save);
		this.craft?.remove(slot);
		this.interaction?.remove(slot);
		this.intents.delete(slot);
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
	 * For as long as their body is (life.ts KEEP_AFTER_LEAVE_S), not for as long as the server runs: someone gone
	 * longer comes back as a newcomer, and the table holds the survivors measured lately instead of one entry for
	 * everyone who ever played here (the second review of the zombie-motion branch, NIT 3). It is swept when a
	 * survivor it has no recent sample of is measured -- the one moment it can grow.
	 */
	setPing(sp: ServerPlayer, seconds: number): void {
		const combat = this.combat;
		if (combat === undefined) return;
		const oldest = this.tick - KEEP_AFTER_LEAVE_S * this.simHz;
		let known = this.pings.get(sp.userId);
		const recent = known !== undefined && known.at >= oldest;
		if (known !== undefined && recent) combat.seedPing(sp.slot, known.pingS);
		combat.setPing(sp.slot, seconds);
		if (known === undefined || !recent) {
			this.forgetPingsBefore(oldest);
			known = { pingS: 0, at: 0 };
			this.pings.set(sp.userId, known);
		}
		known.pingS = combat.pingOf(sp.slot);
		known.at = this.tick;
	}

	/** drops every ping last sampled before tick `oldest` */
	private forgetPingsBefore(oldest: number): void {
		const gone = new Array<number>();
		for (const [userId, p] of this.pings) {
			if (p.at < oldest) gone.push(userId);
		}
		for (const userId of gone) this.pings.delete(userId);
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
		this.tick += 1;
		this.stats.ticks += 1;
		this.dayTicks += 1;
		this.refreshBodies();
		for (const sp of this.roster) {
			const consumed = sp.counters.consumed;
			const cmd = takeCommand(sp);
			const res = stepPlayer(this.world, sp.state, sp.save, cmd, this.tickDt);
			noteStep(sp, cmd, res.walking);
			// a filled tick consumes nothing (players.ts), so only a command the client really sent can count — and
			// only a step that actually walked, or an edge: a stick held against a wall repeats itself for free
			this.notePresence(
				sp,
				sp.counters.consumed > consumed && ((cmd.moveMag > 0 && res.walking) || cmd.edges !== 0),
			);
			// the weapon machine runs on the SAME command as the movement: the aim a shot is fired along is
			// the one the player was holding when they walked that step, never the one two ticks later
			this.combat?.stepPlayer(sp, cmd, this.tick, this.tickDt);
			// ...and so do the discrete actions (§2.4): the E press and the build edges belong to the command
			// the player made them during, which is the one just consumed
			this.stepWorldActions(sp, cmd);
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
		this.stepInteractiveWorld();
		// §3.1 step 3, and it MUST be here: the history a shot rewinds into is the world as it ended this
		// tick, so recording it before the horde moved would compensate latency against stale positions
		this.combat?.afterWorld(this.tick);
		if (this.onTick !== undefined) this.onTick(this.tick);
	}

	// ---------------------------------------------------------------- the interactive world (F3)

	/**
	 * A backpack intent (craft, use, equip, learn) from one survivor (§2.4, §8.1). It is queued rather than
	 * applied on arrival, so it lands inside a tick, in order, next to the command it belongs to -- a craft
	 * and the movement that carried the player to the desk never interleave the wrong way round.
	 *
	 * The presence verbs are NOT handled here: server/net/mpHost.ts owns who is in the world.
	 */
	queueIntent(slot: number, msg: IntentMessage): boolean {
		if (this.craft === undefined) return false;
		if (msg.kind === IntentKind.EnterWorld || msg.kind === IntentKind.LeaveWorld) return false;
		if (!this.bySlot.has(slot)) return false;
		let list = this.intents.get(slot);
		if (list === undefined) {
			list = new Array<IntentMessage>();
			this.intents.set(slot, list);
		}
		// one tick's worth: a client that floods is already rate-limited on the wire (§8.2), and the
		// per-verb cooldowns in server/sim/craft.ts refuse the rest anyway
		if (list.size() >= INTENT_QUEUE_MAX) return false;
		list.push(msg);
		return true;
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
	private stepWorldActions(sp: ServerPlayer, cmd: InputCommand): void {
		const craft = this.craft;
		const build = this.build;
		const interaction = this.interaction;
		if (craft === undefined || build === undefined || interaction === undefined) return;
		const queued = this.intents.get(sp.slot);
		if (queued !== undefined && queued.size() > 0) {
			// a dead survivor does not craft, eat or re-equip: the asks are dropped, not held, so they
			// cannot all fire at once on the tick they are revived (F4)
			if (!sp.state.dead) {
				for (const msg of queued) this.applyIntent(sp, msg, craft);
			}
			queued.clear();
		}
		if (sp.state.dead) return;
		const action = edgeCount(cmd.edges, EdgeShift.ActionPress);
		const attack = edgeCount(cmd.edges, EdgeShift.AttackPress);
		const reload = edgeCount(cmd.edges, EdgeShift.Reload);
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
		const outcome = interaction.act({
			slot: sp.slot,
			state: sp.state,
			save: sp.save,
			players: this.bodies,
			zombies: this.horde?.zombies ?? EMPTY_ZOMBIES,
			hours: gameHours(this.clock.day, this.clock.dayTime),
		});
		if (this.onInteract !== undefined) this.onInteract(sp, outcome);
	}

	private applyIntent(sp: ServerPlayer, msg: IntentMessage, craft: ServerCraft): void {
		let outcome: BackpackOutcome;
		if (msg.kind === IntentKind.Craft) outcome = craft.craft(sp.slot, sp.state, sp.save, msg.arg);
		else if (msg.kind === IntentKind.UseItem) outcome = craft.useItem(sp.slot, sp.state, sp.save, msg.arg);
		else if (msg.kind === IntentKind.Equip) outcome = craft.equip(sp.save, msg.arg);
		else if (msg.kind === IntentKind.Unequip) outcome = craft.unequip(sp.save, msg.arg);
		else if (msg.kind === IntentKind.LearnSkill) outcome = craft.learnSkill(sp.save, msg.arg);
		else return;
		if (this.onBackpack !== undefined) this.onBackpack(sp, outcome);
	}

	/** the world's own upkeep: items in flight, loot that may respawn, fires burning down, cooldowns */
	private stepInteractiveWorld(): void {
		const items = this.items;
		if (items === undefined) return;
		updateGroundItems(this.world, this.tickDt);
		this.craft?.step(this.tickDt);
		this.build?.step(this.tickDt);
		if (this.roster.size() === 0) return;
		items.rollNearby(this.bodies, gameHours(this.clock.day, this.clock.dayTime), this.tickDt);
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
