/*
 * Automated defence, decided by the SERVER (docs/DESIGN_RULES.md ELE-04, ELE-05, MP-01; docs/MULTIPLAYER.md §3.1
 * step 2 "torretas e armadilhas", §3.6 "Torreta ou armadilha mata").
 *
 * Three machines shoot, all powered by server/sim/power.ts:
 *
 *   turret           a rifle on a post: the nearest zombie in TURRET_RANGE with a clear line, hitscan with ±10°, the
 *                    SAME trace a survivor's bullet takes (walls stop it, the player's own constructions do not,
 *                    survivors are not in it at all — MP-01), 25 damage (Robotics ×1.5), every 20 frames;
 *   electric turret  a shock at the nearest zombie in SHOCK_RANGE that holds it SHOCK_STUN s and jumps to two more;
 *   turret drone     the turret's gun on a drone escorting a survivor, fired from wherever the drone is.
 *
 * Every hit goes through `MachineDamage` — ServerCombat's own damage path (the reaction, the blood, the kill credit
 * of §3.6) — so a turret's bullet is a bullet; the only difference is WHO it pays: the builder while in the world,
 * or the drone's survivor, and never as a zombie THEY put down (MON-05 counts those).
 *
 * The cost is bounded (§3.2): a turret looks for a target only when it could fire; a look that finds nothing waits
 * SEARCH_EVERY ticks (each turret on its own phase); the looks of one tick are dealt round-robin, one turret in
 * SEARCH_EVERY and never more than SEARCH_BUDGET for the whole server; and a look reads the horde's spatial hash
 * (ZombieWorld.zombiesNear), never the whole list.
 *
 * Pure module: no Instances, no services, no os.clock. The RNG is injectable.
 */
import {
	Point,
	SHOCK_CHAIN_RANGE,
	SHOCK_CHAINS,
	SHOCK_COOLDOWN,
	SHOCK_NOISE,
	SHOCK_RANGE,
	SHOCK_STUN,
	SHOCK_ZAP_COST,
	TURRET_COOLDOWN,
	TURRET_DRONE_RANGE,
	TURRET_MUZZLE,
	TURRET_NOISE,
	TURRET_RANGE,
	TURRET_SHOT_COST,
	TURRET_SPREAD_DEG,
	turretDamage,
} from "shared/data/power";
import { BossState, bossHitRadius, zombieRadius, ZombieState } from "shared/game/entities";
import { blocksShots, raycast, rayCircle, segmentClear } from "shared/game/physics";
import { Solid, WorldData } from "shared/game/world";
import { FxEvent, FxType } from "shared/net/protocol";
import { MachineState, ServerPower } from "./power";

const DEG = math.pi / 180;
/** a turret with nothing to shoot looks again on its own tick of every this many (10 Hz at 60 Hz) */
export const SEARCH_EVERY = 6;
/** the most target searches the whole server does in one tick, whatever the number of turrets */
export const SEARCH_BUDGET = 12;
/** knockback of a turret's bullet: a survivor's bullet (combat.ts KNOCK_BULLET) */
const KNOCK_BULLET = 3;
/** how long a tracer is drawn (fxView's own bullet streak) */
const TRACER_LIFE = 0.08;
const ARC_LIFE = 0.15;
/** Net TracerKind ids (shared/net/fxWire.ts): 1 bullet, 2 electric */
const TRACER_BULLET = 1;
const TRACER_ELECTRIC = 2;
/** the biggest zombie radius the candidate search has to allow for (a big charger) */
const BODY_PAD = 32;

/** how a machine's hit is applied: ServerCombat's damage path (server/sim/combat.ts `machineHit*`) */
export interface MachineDamage {
	machineHitZombie(
		creditSlot: number,
		fromX: number,
		fromY: number,
		z: ZombieState,
		damage: number,
		knock: number,
		stun: number,
	): void;
	machineHitBoss(
		creditSlot: number,
		fromX: number,
		fromY: number,
		b: BossState,
		damage: number,
		x: number,
		y: number,
	): void;
	rollDamage(n: number): number;
}

export interface ServerTurretsOptions {
	world: WorldData;
	power: ServerPower;
	/** the zombies within `radius` of a point (ZombieWorld.zombiesNear: the horde's spatial hash) */
	zombiesNear: (x: number, y: number, radius: number, tick: number, out: Array<ZombieState>) => Array<ZombieState>;
	bosses: () => ReadonlyArray<BossState>;
	damage: MachineDamage;
	/** cosmetics for the Fx channel: the tracer of every shot (§4.1) */
	fx?: (event: FxEvent) => void;
	/** a shot is heard (zombieBrain's emitSound): the horde comes to look */
	noise?: (x: number, y: number, radius: number) => void;
	random?: () => number;
}

/** per-tick counters: the cost test reads them (§3.2) */
export interface TurretStats {
	searches: number;
	shots: number;
	zaps: number;
	hits: number;
	/** the largest number of searches any single tick did */
	maxSearchesInTick: number;
}

export class ServerTurrets {
	private readonly world: WorldData;
	private readonly power: ServerPower;
	private readonly zombiesNear: ServerTurretsOptions["zombiesNear"];
	private readonly bosses: () => ReadonlyArray<BossState>;
	private readonly damage: MachineDamage;
	private readonly fx?: (event: FxEvent) => void;
	private readonly noise?: (x: number, y: number, radius: number) => void;
	private readonly rnd: () => number;
	private readonly near = new Array<ZombieState>();
	private readonly done = new Array<ZombieState>();
	private readonly at: Point = { x: 0, y: 0 };
	/** where the next tick's round-robin starts */
	private cursor = 0;
	readonly stats: TurretStats = { searches: 0, shots: 0, zaps: 0, hits: 0, maxSearchesInTick: 0 };

	constructor(options: ServerTurretsOptions) {
		this.world = options.world;
		this.power = options.power;
		this.zombiesNear = options.zombiesNear;
		this.bosses = options.bosses;
		this.damage = options.damage;
		this.fx = options.fx;
		this.noise = options.noise;
		this.rnd = options.random ?? (() => math.random());
	}

	/**
	 * §3.1 step 2, after the horde and the projectiles moved: the armed machines that are ready look and fire.
	 *
	 * The looks are dealt round-robin from where the last tick stopped, at most `quota` a tick — one turret in
	 * SEARCH_EVERY, never more than SEARCH_BUDGET — so a base of many turrets costs the same every tick and none of
	 * them is starved by the ones before it in the list. A look that finds nothing waits SEARCH_EVERY ticks.
	 */
	step(tick: number, dt: number): void {
		const list = this.power.shooters();
		const n = list.size();
		for (const st of list) {
			if (st.cooldown > 0) st.cooldown = math.max(0, st.cooldown - dt);
		}
		if (n === 0) return;
		const quota = math.min(SEARCH_BUDGET, math.ceil(n / SEARCH_EVERY));
		let searches = 0;
		let visited = 0;
		let i = this.cursor % n;
		while (visited < n && searches < quota) {
			const st = list[i];
			i = (i + 1) % n;
			visited += 1;
			if (st.cooldown > 0 || tick < st.nextSearch || !this.power.armedNow(st)) continue;
			searches += 1;
			this.stats.searches += 1;
			const fired = st.def.weapon === "shock" ? this.zap(st, tick) : this.shoot(st, tick);
			// nothing to shoot: look again in SEARCH_EVERY ticks, each turret on its own phase
			if (!fired) st.nextSearch = tick + SEARCH_EVERY - ((tick + st.seq) % SEARCH_EVERY);
		}
		this.cursor = i;
		if (searches > this.stats.maxSearchesInTick) this.stats.maxSearchesInTick = searches;
	}

	/** the nearest live zombie within `range` of (x, y) with a clear line of fire, or undefined */
	private target(
		x: number,
		y: number,
		range: number,
		tick: number,
		skip?: ReadonlyArray<ZombieState>,
	): ZombieState | undefined {
		this.near.clear();
		this.zombiesNear(x, y, range, tick, this.near);
		let best: ZombieState | undefined;
		let bestD = range * range;
		for (const z of this.near) {
			if (z.hp <= 0) continue;
			if (skip !== undefined && skip.includes(z)) continue;
			const dx = z.x - x;
			const dy = z.y - y;
			const d = dx * dx + dy * dy;
			if (d >= bestD) continue;
			// shots fly over the survivors' own constructions (physics.blocksShots), walls and trees stop them
			if (!segmentClear(this.world, x, y, z.x, z.y, blocksShots)) continue;
			best = z;
			bestD = d;
		}
		this.near.clear();
		return best;
	}

	// ---------------------------------------------------------------- the gun (turret, turret drone)

	/** false when it had nothing to shoot at (or could not pay for the shot) */
	private shoot(st: MachineState, tick: number): boolean {
		const from = this.power.positionOf(st, this.at);
		const fx = from.x;
		const fy = from.y;
		const range = st.def.role === "drone" ? TURRET_DRONE_RANGE : TURRET_RANGE;
		const z = this.target(fx, fy, range, tick);
		const boss = z === undefined ? this.bossTarget(fx, fy, range) : undefined;
		if (z === undefined && boss === undefined) return false;
		const tx = z !== undefined ? z.x : (boss as BossState).x;
		const ty = z !== undefined ? z.y : (boss as BossState).y;
		if (!this.power.spend(st, TURRET_SHOT_COST)) return false;
		st.cooldown = TURRET_COOLDOWN;
		st.aim = math.atan2(ty - fy, tx - fx);
		this.stats.shots += 1;
		// obj_bullet's spread: ±angle_range × one of (1, 0.6) — the turret's is 10°
		const scale = this.rnd() < 0.5 ? 1 : 0.6;
		const a = st.aim + (this.rnd() * 2 - 1) * scale * TURRET_SPREAD_DEG * DEG;
		const mx = fx + math.cos(st.aim) * TURRET_MUZZLE;
		const my = fy + math.sin(st.aim) * TURRET_MUZZLE;
		const credit = this.power.creditOf(st);
		const dmg = this.damage.rollDamage(turretDamage("gun", st.robotics));
		// the same trace a survivor's bullet takes, in the present (a turret has no latency to compensate)
		const wall = raycast(this.world, fx, fy, a, range, blocksShots);
		let best = wall.dist;
		let hitZ: ZombieState | undefined;
		let hitB: BossState | undefined;
		const dx = math.cos(a);
		const dy = math.sin(a);
		this.near.clear();
		this.zombiesNear(fx, fy, range + BODY_PAD, tick, this.near);
		for (const c of this.near) {
			if (c.hp <= 0) continue;
			const t = rayCircle(fx, fy, dx, dy, c.x, c.y, zombieRadius(c));
			if (t !== undefined && t < best) {
				best = t;
				hitZ = c;
			}
		}
		this.near.clear();
		for (const b of this.bosses()) {
			if (b.hp <= 0) continue;
			const t = rayCircle(fx, fy, dx, dy, b.x, b.y, bossHitRadius(b));
			if (t !== undefined && t < best) {
				best = t;
				hitB = b;
				hitZ = undefined;
			}
		}
		const hx = fx + dx * best;
		const hy = fy + dy * best;
		if (hitZ !== undefined) {
			this.stats.hits += 1;
			this.damage.machineHitZombie(credit, fx, fy, hitZ, dmg, KNOCK_BULLET, 0);
		} else if (hitB !== undefined) {
			this.stats.hits += 1;
			this.damage.machineHitBoss(credit, fx, fy, hitB, dmg, hx, hy);
		}
		this.fx?.({ t: FxType.Tracer, x1: mx, y1: my, x2: hx, y2: hy, kind: TRACER_BULLET, life: TRACER_LIFE });
		this.noise?.(fx, fy, TURRET_NOISE);
		return true;
	}

	private bossTarget(x: number, y: number, range: number): BossState | undefined {
		for (const b of this.bosses()) {
			if (b.hp <= 0) continue;
			const dx = b.x - x;
			const dy = b.y - y;
			const r = range + bossHitRadius(b);
			if (dx * dx + dy * dy > r * r) continue;
			if (!segmentClear(this.world, x, y, b.x, b.y, blocksShots)) continue;
			return b;
		}
		return undefined;
	}

	// ---------------------------------------------------------------- the shock (electric turret)

	/** false when it had nothing to shock (or could not pay for it) */
	private zap(st: MachineState, tick: number): boolean {
		const from = this.power.positionOf(st, this.at);
		let fromX = from.x;
		let fromY = from.y;
		const first = this.target(fromX, fromY, SHOCK_RANGE, tick);
		if (first === undefined) return false;
		if (!this.power.spend(st, SHOCK_ZAP_COST)) return false;
		st.cooldown = SHOCK_COOLDOWN;
		st.aim = math.atan2(first.y - fromY, first.x - fromX);
		this.stats.zaps += 1;
		const credit = this.power.creditOf(st);
		const base = turretDamage("shock", st.robotics);
		const done = this.done;
		done.clear();
		let z: ZombieState | undefined = first;
		for (let jump = 0; jump <= SHOCK_CHAINS && z !== undefined; jump++) {
			done.push(z);
			this.stats.hits += 1;
			this.damage.machineHitZombie(credit, fromX, fromY, z, this.damage.rollDamage(base), 0, SHOCK_STUN);
			this.fx?.({
				t: FxType.Tracer,
				x1: fromX,
				y1: fromY,
				x2: z.x,
				y2: z.y,
				kind: TRACER_ELECTRIC,
				life: ARC_LIFE,
			});
			fromX = z.x;
			fromY = z.y;
			z = jump < SHOCK_CHAINS ? this.target(fromX, fromY, SHOCK_CHAIN_RANGE, tick, done) : undefined;
		}
		done.clear();
		const s: Solid = st.solid;
		this.noise?.(s.x + s.w / 2, s.y + s.h / 2, SHOCK_NOISE);
		return true;
	}
}
