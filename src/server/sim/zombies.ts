//!native
import * as CFG from "shared/net/mpConfig";
import { Bullet } from "shared/game/bullets";
import { PlayerState } from "shared/game/player";
import { PlayerSaveData, defaultSave } from "shared/game/save";
import { WorldData } from "shared/game/world";
import { ZombieState } from "shared/game/entities";
import { FxEvent } from "shared/sim/types";
import * as Ctx from "shared/sim/ai/context";
import * as Brain from "shared/sim/ai/zombieBrain";
import { SpatialHash } from "shared/sim/ai/spatialHash";
import { FlowSource, MultiFlowField } from "./flowField";
import { BossRoster } from "./bosses";
import { ServerPopulation } from "./population";
import { WorldClock } from "./waves";
import { ServerPlayer } from "./players";
import type { SimProfiler } from "./metrics";

/*
 * The authoritative horde (docs/MULTIPLAYER.md §3.1 step 2, §3.3, §3.4, §11.3 F2-2A). SERVER ONLY, and pure:
 * no Instances, no services, no os.clock — the caller hands it the roster and a dt, so tools/test-ai.mjs runs
 * the very same thing under Node.
 *
 * This is what fixes the playtest that started F2: two clients standing in the same street, one surrounded and
 * losing hp, the other alone in an empty road. There is ONE horde now, it lives here, and every client will be
 * shown the same one (the snapshot itself is F2-2D's).
 *
 * What it owns:
 *   - the zombie list and the identity each one travels under (`netId`, the recyclable u16 pool of §4.4);
 *   - the multi-source flow field (§3.3), rebuilt on a budget so no tick pays for a whole Dijkstra;
 *   - the world clock and the population (clusters and S(k), §3.5, MP-09 against EVERY survivor);
 *   - the deaths, which the replication has to announce reliably (§4.4 `ZombieDied`).
 *
 * What it deliberately does NOT own: the snapshot (2D), the damage a bullet does (2C) and the XP (2C, §3.6) —
 * it exposes what those fronts need to read and calls `onExp` when something dies.
 */

/** why an entity left the world: the client draws blood and a corpse for a kill, and nothing for a despawn */
export const DeathCause = {
	/** recycled by the population (too far from everyone) or dropped some other way */
	Despawned: 0,
	/** hp reached 0: blood, corpse and drop, at the place it fell */
	Killed: 1,
} as const;
export type DeathCause = (typeof DeathCause)[keyof typeof DeathCause];

export interface ZombieDeath {
	netId: number;
	x: number;
	y: number;
	cause: DeathCause;
}

/** what the server remembers about one zombie beyond its simulation state */
interface ZombieRecord {
	netId: number;
	/** last known position, for the safety net below (a death the simulation announced carries its own) */
	x: number;
	y: number;
	/** the tick it was last seen alive */
	tick: number;
}

/**
 * Cells the flow field may expand per tick. §3.2 budgets 2 ms for the field and estimates ~2 µs per cell
 * interpreted, so 1000 cells is that budget with the estimate taken at face value. It is a knob, not a law:
 * tools/test-ai.mjs prints the real cost per cell, and `SIM_HZ` dropping to 30 (§3.1) doubles the time this
 * budget buys per tick without changing the number.
 */
export const FLOW_CELL_BUDGET = 1000;
/** never start a new field more often than this (§3.3 aims at 5–10 Hz; below that it is just churn) */
const FLOW_MIN_TICKS = CFG.ticksPer(CFG.FLOW_FIELD_HZ_MAX);
/**
 * Ceilings for the things the server simulates but nobody drains yet: the Fx queue belongs to F2-2D and the
 * projectile list to F2-2C. Until they are wired, a spitter firing into an empty channel must not grow a
 * table for ever — dropping the oldest is the right failure, because an effect nobody sent is already lost.
 */
const FX_CAP = 512;
const BULLET_CAP = 256;

export class ZombieWorld {
	readonly world: WorldData;
	readonly clock: WorldClock;
	readonly field = new MultiFlowField();
	readonly population = new ServerPopulation();
	readonly bossRoster = new BossRoster();
	readonly zombies: Array<ZombieState> = [];
	readonly bullets: Array<Bullet> = [];
	/** cosmetic effects the simulation asked for this tick; F2-2D drains it into the Fx channel */
	readonly fx: Array<FxEvent> = [];
	readonly refs: Ctx.AiRefs;
	/** xp from a kill at (x, y); F2-2C attributes it to the killer and the assists (§3.6) */
	onExp?: (amount: number, x: number, y: number) => void;
	/**
	 * Milliseconds clock for the §12.2 breakdown ("os.clock() por etapa"), injected so this module stays
	 * pure. Leave it undefined and the tick measures nothing at all.
	 */
	nowMs?: () => number;
	/** milliseconds spent in each phase of the LAST tick (all zero while `nowMs` is undefined) */
	readonly cost = { clock: 0, population: 0, field: 0, zombies: 0, bosses: 0, book: 0 };
	/**
	 * MicroProfiler labels for the same phases (`PZ.horde.*`, server/sim/metrics.ts), injected like `nowMs`;
	 * undefined labels nothing. ServerSimulation.instrument sets both.
	 */
	profile?: SimProfiler;
	/** the clock reading the next `lap` measures from (a field: the step makes no closure per tick) */
	private lapAt = 0;

	private readonly players: Array<PlayerState> = [];
	/** the slot of each entry of `players`, in the same order */
	private readonly slots: Array<number> = [];
	private readonly saves = new Map<PlayerState, PlayerSaveData>();
	private readonly fallbackSave = defaultSave();
	private readonly ids = new Map<ZombieState, ZombieRecord>();
	private readonly deaths: Array<ZombieDeath> = [];
	private readonly gone: Array<ZombieState> = [];
	private readonly sources: Array<FlowSource> = [];
	private readonly sourcePool: Array<FlowSource> = [];
	/** freed netIds and the tick they may be handed out again (§4.4: not before 2 s) */
	private readonly freeIds: Array<number> = [];
	private readonly freeAt: Array<number> = [];
	private nextNetId = CFG.NET_ID_MIN;
	private flowWait = 0;
	/** the tick being simulated, so a death announced mid-tick can time its netId release */
	private lastTick = 0;
	private solidCount = -1;
	private readonly hash = new SpatialHash();
	private hashTick = -1;
	/** `zombiesNear`'s hash answer (scratch: one per call, never kept) */
	private readonly nearIdx: Array<number> = [];
	/**
	 * Entries in `ids`: roblox-ts compiles a Map's size() to a counting loop over the whole map, and `trackEntities`
	 * asks it every tick with ~150 entries.
	 */
	private idCount = 0;

	constructor(world: WorldData, clock?: WorldClock) {
		this.world = world;
		this.clock = clock ?? new WorldClock();
		// §3.5, the hook 2B left for 2A: the night's headcount is decided once, by the clock, and rationed
		// across the clusters that exist when dusk falls (server/sim/population.ts explains the split).
		this.clock.onWaveFill = fill => this.population.split(fill, this.clock);
		this.refs = {
			world,
			players: this.players,
			zombies: this.zombies,
			bosses: this.bossRoster.list,
			bullets: this.bullets,
			fx: this.fx,
			clock: this.clock,
			field: this.field,
			ai: Ctx.newBrainState(),
			saveOf: p => this.saves.get(p) ?? this.fallbackSave,
			onExp: (amount, x, y) => {
				if (this.onExp !== undefined) this.onExp(amount, x, y);
			},
			// a construction the horde chewed through: only those tiles have to be read again (§3.3)
			onSolidChanged: (x, y, w, h) => {
				this.field.dirtyRect(x, y, w, h);
				this.solidCount = this.world.solids.size();
			},
			onZombieGone: (z, killed) => this.retire(z, killed),
			puddles: [],
			sounds: [],
			explosions: [],
		};
	}

	// ---------------------------------------------------------------- netIds (§4.4)

	private takeNetId(tick: number): number {
		const head = this.freeAt[0];
		if (head !== undefined && tick >= head) {
			this.freeAt.shift();
			return this.freeIds.shift() as number;
		}
		if (this.nextNetId <= CFG.NET_ID_MAX) {
			const id = this.nextNetId;
			this.nextNetId += 1;
			return id;
		}
		// the pool ran dry before anything came back: reuse the oldest anyway rather than hand out 0
		const id = this.freeIds.shift();
		this.freeAt.shift();
		return id ?? CFG.NET_ID_MIN;
	}

	private releaseNetId(netId: number, tick: number): void {
		this.freeIds.push(netId);
		this.freeAt.push(tick + math.floor(CFG.NET_ID_REUSE_DELAY_S * CFG.SIM_HZ));
	}

	/** the id this zombie travels under, or 0 while it has not been registered yet */
	netIdOf(z: ZombieState): number {
		return this.ids.get(z)?.netId ?? 0;
	}

	// ---------------------------------------------------------------- the roster

	/**
	 * Mirrors the authoritative survivors into the AI's view of the world. The arrays are reused, and the AI's
	 * "player index" — what an FxEvent carries and what the field's `targetOf` answers — is the position in
	 * THIS list, not the player's slot: slots 0 and 3 alone are indices 0 and 1. `slotOf` translates, and
	 * F2-2D has to call it before anything goes on the wire (§4.2 addresses survivors by slot).
	 */
	private syncPlayers(roster: ReadonlyArray<ServerPlayer>): void {
		this.players.clear();
		this.saves.clear();
		this.slots.clear();
		for (const sp of roster) {
			this.players.push(sp.state);
			this.slots.push(sp.slot);
			this.saves.set(sp.state, sp.save);
		}
	}

	/** the slot of the survivor at AI index `index` (an FxEvent's `player`), or SLOT_NONE */
	slotOf(index: number): number {
		return this.slots[index] ?? CFG.SLOT_NONE;
	}

	/**
	 * Every standing survivor is a seed; §3.3 lets a downed one seed at DOWNED_SEED once F4 has them. The source
	 * records are pooled: this runs every tick the field is idle (to ask `upToDate`), and the field copies what it
	 * needs out of them.
	 */
	private collectSources(): void {
		this.sources.clear();
		for (let i = 0; i < this.players.size(); i++) {
			const p = this.players[i];
			if (p.dead) continue;
			let s = this.sourcePool[this.sources.size()];
			if (s === undefined) {
				s = { x: 0, y: 0, index: 0, seed: 0 };
				this.sourcePool.push(s);
			}
			s.x = p.x;
			s.y = p.y;
			s.index = i;
			s.seed = 0;
			this.sources.push(s);
		}
	}

	/**
	 * Keeps the chase field fresh inside its budget (§3.3): one rebuild at a time, never started more often
	 * than FLOW_MIN_TICKS, and expanded FLOW_CELL_BUDGET cells per tick. The very first field of a world is
	 * built in one go, so the horde is not blind for the first second of a session.
	 *
	 * A rebuild whose answer would be the field already in use is not started at all (`MultiFlowField.upToDate`: no
	 * survivor changed cell, nothing was dirtied): the check runs again next tick, so the one after a survivor steps
	 * into a new cell or a barricade goes up starts at once.
	 */
	private updateField(): void {
		const count = this.world.solids.size();
		if (count !== this.solidCount) {
			// somebody changed the map without saying where (a chopped tree, a new construction): the static
			// layer has to be read again. F3 can make this surgical by calling field.dirtyRect itself.
			if (this.solidCount >= 0) this.field.dirtyAll(true);
			this.solidCount = count;
		}
		if (this.flowWait > 0) this.flowWait -= 1;
		if (!this.field.building && this.flowWait <= 0) {
			this.collectSources();
			if (this.sources.size() > 0 && !this.field.upToDate(this.sources)) {
				this.flowWait = FLOW_MIN_TICKS;
				this.field.startRebuild(this.world, this.sources);
				if (!this.field.valid) this.field.step(1e9);
			}
		}
		if (this.field.building) this.field.step(FLOW_CELL_BUDGET);
	}

	// ---------------------------------------------------------------- the tick

	/**
	 * One simulation tick of the whole horde, in the §3.1 order: clock and waves, population, flow field,
	 * zombies, bosses. `roster` is the authoritative survivor list; `tick` is the simulation tick.
	 */
	step(roster: ReadonlyArray<ServerPlayer>, dt: number, tick: number): void {
		this.lastTick = tick;
		const prof = this.profile;
		const now = this.nowMs;
		this.lapAt = now !== undefined ? now() : 0;
		prof?.begin("PZ.horde.clock");
		this.syncPlayers(roster);
		this.clock.step(dt);
		prof?.end();
		this.lap("clock");
		prof?.begin("PZ.horde.population");
		this.population.update(this.refs, dt);
		prof?.end();
		this.lap("population");
		prof?.begin("PZ.horde.field");
		this.updateField();
		prof?.end();
		this.lap("field");
		prof?.begin("PZ.horde.zombies");
		Brain.updateZombies(this.refs, dt);
		prof?.end();
		this.lap("zombies");
		prof?.begin("PZ.horde.bosses");
		this.bossRoster.step(this.refs, dt, tick);
		prof?.end();
		this.lap("bosses");
		prof?.begin("PZ.horde.book");
		this.trackEntities(tick);
		this.trim();
		prof?.end();
		this.lap("book");
	}

	/** the time since the previous lap goes to `into` (nothing at all while `nowMs` is undefined) */
	private lap(into: "clock" | "population" | "field" | "zombies" | "bosses" | "book"): void {
		const now = this.nowMs;
		if (now === undefined) return;
		const t1 = now();
		this.cost[into] = t1 - this.lapAt;
		this.lapAt = t1;
	}

	/**
	 * A zombie is leaving the world and the simulation said so itself, which is the only way to know WHERE it
	 * fell and WHY (a record stamped at the end of the tick is already one tick stale, and the body is gone).
	 */
	private retire(z: ZombieState, killed: boolean): void {
		const rec = this.ids.get(z);
		if (rec === undefined) return; // it never lived long enough to get an id: nobody was ever told about it
		this.ids.delete(z);
		this.idCount -= 1;
		this.releaseNetId(rec.netId, this.lastTick);
		this.deaths.push({
			netId: rec.netId,
			x: z.x,
			y: z.y,
			cause: killed ? DeathCause.Killed : DeathCause.Despawned,
		});
	}

	/** new zombies get an id, and anything that vanished without a word is turned into a silent despawn */
	private trackEntities(tick: number): void {
		for (const z of this.zombies) {
			let rec = this.ids.get(z);
			if (rec === undefined) {
				rec = { netId: this.takeNetId(tick), x: z.x, y: z.y, tick };
				this.ids.set(z, rec);
				this.idCount += 1;
				continue;
			}
			rec.x = z.x;
			rec.y = z.y;
			rec.tick = tick;
		}
		// one integer comparison tells whether anything vanished behind the simulation's back — an admin
		// clearing the horde, a future system splicing the list. `retire` has already handled the rest.
		if (this.idCount === this.zombies.size()) return;
		this.gone.clear();
		for (const [z, rec] of this.ids) {
			if (rec.tick !== tick) this.gone.push(z);
		}
		for (const z of this.gone) {
			const rec = this.ids.get(z) as ZombieRecord;
			this.ids.delete(z);
			this.idCount -= 1;
			this.releaseNetId(rec.netId, tick);
			this.deaths.push({ netId: rec.netId, x: rec.x, y: rec.y, cause: DeathCause.Despawned });
		}
	}

	/** nothing the other fronts have not wired up yet may grow without a ceiling */
	private trim(): void {
		while (this.fx.size() > FX_CAP) this.fx.shift();
		while (this.bullets.size() > BULLET_CAP) this.bullets.shift();
		while (this.deaths.size() > FX_CAP) this.deaths.shift();
	}

	// ---------------------------------------------------------------- what F2-2C and F2-2D read

	/** the deaths since the last call (§4.4: one reliable `ZombieDied` each) */
	takeDeaths(out: Array<ZombieDeath>): Array<ZombieDeath> {
		for (const d of this.deaths) out.push(d);
		this.deaths.clear();
		return out;
	}

	/** the cosmetic events since the last call (§4.1 Fx) */
	takeFx(out: Array<FxEvent>): Array<FxEvent> {
		for (const e of this.fx) out.push(e);
		this.fx.clear();
		return out;
	}

	/**
	 * The zombies within `radius` of a point, appended to `out` (§4.3 interest, §3.4: the same hash the
	 * separation uses). The index is rebuilt at most once per tick, so calling this once per client is free.
	 */
	zombiesNear(x: number, y: number, radius: number, tick: number, out: Array<ZombieState>): Array<ZombieState> {
		if (this.hashTick !== tick) {
			this.hashTick = tick;
			this.hash.begin();
			for (let i = 0; i < this.zombies.size(); i++) {
				const z = this.zombies[i];
				this.hash.insert(i, z.x, z.y);
			}
		}
		const found = this.nearIdx;
		found.clear();
		this.hash.within(x, y, radius, found);
		const r2 = radius * radius;
		for (const i of found) {
			const z = this.zombies[i];
			if (z === undefined) continue;
			const dx = z.x - x;
			const dy = z.y - y;
			if (dx * dx + dy * dy <= r2) out.push(z);
		}
		return out;
	}

	/** how many zombies are alive right now (MP-09 ceiling: CFG.MAX_ZOMBIES) */
	count(): number {
		return this.zombies.size();
	}
}
