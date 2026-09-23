/*
 * Authoritative combat: the server decides every shot, swing, hit and point of damage
 * (docs/MULTIPLAYER.md §2.1, §2.3, §3.1 step 1, §8.1, §8.3, §9.1; DESIGN_RULES MP-00, MP-01).
 *
 * The problem this front closes: until F1, `damageToPlayer` was only ever called from client systems, so the
 * CLIENT decided how much HP it lost, and XP/kills arrived as a report the server could only rate-limit. Two
 * players standing in the same place saw different hordes and different health bars.
 *
 * The rule here is simple and has no exceptions: **nothing the client claims about a hit is believed**. The
 * protocol does not even have a place to claim one — an Input command carries an aim angle and a press counter
 * (§2.2), and everything else (which weapon, how many rounds are in the magazine, how fast it fires, how wide
 * the cone is, what the ray meets, how much that costs in HP) is read off the server's own state. A modified
 * client can send `edges = 3 presses` every tick for ever; the cadence, the magazine and the reserve are here,
 * so it fires exactly as fast as an honest one.
 *
 * What IS compensated is latency, and only within a measured ceiling (§2.3):
 *   - hitscan is traced against zombies/bosses REWOUND to the instant the shooter was drawing
 *     (`server/sim/history.ts`), capped by `min(REWIND_MAX_S, ping + interp + 2 ticks)` — the ping the server
 *     measured (slow to rise, quick to fall), never the one the client declares, so a lag switch loses compensation
 *     instead of buying it — and kept within VIEW_CONTINUITY_TICKS of the shooter's own running view offset, so a
 *     view that jumps for one shot inside the ceiling is clamped too (`judge`). A zombie the shooter draws in the
 *     MID ring is drawn a near interval further back, and is rewound that much further (`viewExtraTicks`);
 *   - walls, doors and constructions are traced in the PRESENT: rewinding them would let someone shoot through
 *     a door another player just closed;
 *   - the damage, the reaction and the knockback land on the zombie in the PRESENT;
 *   - melee is not rewound at all (it happens at contact distance, where the zombie's server position is also
 *     what decides its bite; mixing the two clocks creates "I killed it but it still bit me"). It gets a
 *     latency MARGIN instead: what a walker covers in the measured age of the view (`meleeMargin`, 12-24 units)
 *     of reach and ±MELEE_ARC_MARGIN_DEG of arc.
 *
 * Spread is rolled with the SERVER's RNG and never sent (§2.3 "Seed da dispersão"), which is what makes
 * no-spread and no-recoil impossible rather than merely detectable (§9.1).
 *
 * Ownership: this module never touches Instances and never reaches into 2A's zombie/boss internals. It reads
 * the live lists through `CombatTargets` and applies damage through `CombatHooks`, whose defaults implement the
 * plain "hp − damage + knockback" so the module runs (and is tested) on its own.
 *
 * WIRING (server/sim/simulation.ts belongs to another front; these are the only two calls it owes us, in the
 * §3.1 order — the second one MUST come after the world half moved, or every shot rewinds into stale data):
 *
 *   step(): …
 *     for each player:  const cmd = takeCommand(sp);
 *                       const res = stepPlayer(this.world, sp.state, sp.save, cmd, this.tickDt);
 *                       noteStep(sp, cmd, res.walking);
 *                       combat.stepPlayer(sp, cmd, this.tick, this.tickDt);   // §3.1 step 1
 *     …world half (zombies, bosses, projectiles)…
 *     combat.afterWorld(this.tick);                                           // §3.1 step 3
 *     …replication (step 4)…
 *
 * and, wherever the host already reads `Player:GetNetworkPing()` (it returns SECONDS), `combat.setPing(slot, s)`
 * once a second -- the live host goes through ServerSimulation.setPing, which remembers it across a leave/enter
 * and a new town: that measurement is the rewind ceiling, and leaving it at 0 only ever compensates LESS.
 * `combat.remove(slot)` on leave.
 */
import * as Cfg from "shared/net/mpConfig";
import * as Ent from "shared/game/entities";
import * as Net from "shared/net/protocol";
import * as Phys from "shared/game/physics";
import * as Ply from "shared/game/player";
import * as Wp from "shared/data/weapons";
import { DESIGN } from "shared/engine/constants";
import { WeaponKind } from "shared/data/kinds";
import { angleDiff } from "shared/engine/vec2";
import { isFiniteNumber, unwrapTick } from "shared/net/codec";
import { ownsWeapon } from "shared/game/save";
import type { PlayerSaveData } from "shared/game/save";
import { querySolids, Solid, WorldData } from "shared/game/world";
import { SPEED_SCALE } from "shared/sim/types";
import { biteRewindCapS, judgedTick, PositionHistory, rewindCapS } from "./history";
import type { Progress } from "./progress";
import type { ServerPlayer } from "./players";

const DEG = math.pi / 180;

// ---------------------------------------------------------------- balance (same numbers the client had)

/**
 * Knockback in px/frame @30fps (the original's `reaction_speed +=`). An arrow's and a flame's knockback are
 * NOT here: they belong to whoever flies the projectile and lands the hit (`CombatHooks.projectile`).
 */
const KNOCK_BULLET = 3;
const KNOCK_MELEE = 6;
const KNOCK_HEADSHOT = 6;

/** gunfire noise ring (sound_view_shot(800)); the silencer divides it by 3 */
const SHOT_NOISE = 800;
const SILENCER_ID = 12;
const LASER_SIGHT_ID = 7;

/** obj_player_knife: 2 bodies per swing (the chainsaw is unlimited) */
const MELEE_MAX_TARGETS = 2;
/** weapon_angle_delay_time 5 frames: the blade stops briefly on impact */
const HITSTOP = 5 / 30;

/** obj_bullet_arrow: 25 px/frame (40 with Robin Hood), losing 0.2 px/frame every frame */
const ARROW_SPEED = 25 * SPEED_SCALE;
const ARROW_SPEED_SKILL = 40 * SPEED_SCALE;
const ARROW_FRICTION = 0.2 * SPEED_SCALE * SPEED_SCALE;
/** obj_bullet_fire: 20 px/frame */
const FIRE_SPEED = 20 * SPEED_SCALE;
/** fuel per shot: 0.1 oil (flamethrower) / 0.1 electricity (stun gun) */
const SPECIAL_FUEL_PER_SHOT = 0.1;

/** stun gun: nearest zombie inside ±40° and its range, then chains to two more */
const STUN_CONE = 40 * DEG;
const STUN_CHAINS = 2;

/** chainsaw: warm-up before it cuts, cools while idle, 3 oil/s */
const CHAINSAW_WARMUP = 1.5;
const CHAINSAW_MAX = 8;
const CHAINSAW_OIL_PER_SEC = 0.1 * 30;
const CHAINSAW_ARC = 25 * DEG;

/**
 * Hard ceiling of shots resolved for ONE tick of input, whatever the `edges` counters claim. With the cadence
 * floor of one tick this is already unreachable for automatic weapons; it exists so that a forged packet can
 * never turn three press counters into three magazines.
 */
const MAX_SHOTS_PER_TICK = 3;

/** §2.3 "Mordida justa": the zombie must also be within contact + this, where the VICTIM saw it */
export const FAIR_BITE_MARGIN = 24;

/** the measured ping: a higher sample moves the ceiling this fraction of the way, a lower one PING_FALL (§2.3) */
export const PING_RISE = 0.1;
export const PING_FALL = 0.5;
/** weight of one new view in a survivor's running view offset (per tick with a fresh Input: ~1/3 s to follow) */
const VIEW_OFFSET_ALPHA = 0.05;

/** exactly the shape of `damageToPlayer`, so a call site swaps one identifier (see `ServerCombat.damageSink`) */
export type PlayerDamageSink = (p: Ply.PlayerState, save: PlayerSaveData, raw: number, bypassDef?: boolean) => boolean;

// ---------------------------------------------------------------- collaboration with the rest of the sim

export interface CombatTargets {
	/** live zombies, present tick (2A owns the list and its order) */
	zombies: () => ReadonlyArray<Ent.ZombieState>;
	bosses: () => ReadonlyArray<Ent.BossState>;
	/**
	 * How many ticks further back than `viewTick` -- the render time of the frame the shot was fired from -- the
	 * survivor in `slot` DREW this zombie: the mid ring's extra delay (client/net/snapshotBuffer.ts), 0 in the near
	 * ring, and in between for a second after it changed ring (the client eases it). The replication layer knows the
	 * rings (server/net/replication.ts sets it through ServerSimulation.zombieViewLag); absent, every body is near.
	 */
	viewExtraTicks?: (slot: number, z: Ent.ZombieState, viewTick: number) => number;
}

/** a projectile the server must fly (§2.3): combat validates and asks, 2A/2D own the flight and the Fx */
export interface ProjectileRequest {
	/** Net.ProjKind */
	kind: number;
	ownerSlot: number;
	x: number;
	y: number;
	angle: number;
	/** world units per second */
	speed: number;
	damage: number;
	range: number;
	/** arrows slow down as they fly */
	friction?: number;
}

export interface CombatHooks {
	/** 2A's reactToHit: the hp change is ours, the reaction and the stun belong to the zombie owner */
	hitZombie?: (z: Ent.ZombieState, damage: number, fromAngle: number, knock: number, stun: number) => void;
	hitBoss?: (b: Ent.BossState, damage: number, x: number, y: number) => void;
	/** hp reached 0 inside this resolution; the XP was already paid, 2A removes the body */
	zombieKilled?: (z: Ent.ZombieState, killerSlot: number) => void;
	bossKilled?: (b: Ent.BossState, killerSlot: number) => void;
	/** gunfire noise ring (zombieAI's emitSound): a shot is heard far further than it travels */
	noise?: (x: number, y: number, radius: number, shot: boolean) => void;
	/** a blade crossed a tree/car/bin: true when it gave something (F3's server/sim/interaction.ts) */
	chop?: (s: Solid, chopping: boolean) => boolean;
	projectile?: (request: ProjectileRequest) => void;
	/** cosmetics for the Fx channel (§4.1); this module never draws anything itself */
	fx?: (event: Net.FxEvent) => void;
}

export interface ServerCombatOptions {
	world: WorldData;
	targets: CombatTargets;
	/** shared with the rest of the tick; one is created when the caller has none */
	history?: PositionHistory;
	progress?: Progress;
	hooks?: CombatHooks;
	simHz?: number;
	/** the server's own RNG; injectable so the tests can replay a run exactly (never replicated) */
	random?: () => number;
	/**
	 * §2.3 "Mordida justa": a bite only lands when the zombie was also in reach where the VICTIM saw it.
	 * On by default — it removes "bitten from across the street" without handing an advantage to whoever lags.
	 */
	fairBite?: boolean;
}

/** per-survivor combat counters (§9.3 evidence, §12.2 metrics) */
export interface CombatStats {
	shots: number;
	pellets: number;
	hitsZombie: number;
	hitsBoss: number;
	/** presses refused because the weapon was still cooling down (§8.1 cadence) */
	blockedCadence: number;
	/** presses refused because the magazine was empty */
	blockedAmmo: number;
	/** times the declared view had to be clamped to the ping ceiling (§2.3, lag-switch signal) */
	rewindClamped: number;
	/** melee contacts */
	melee: number;
	damageDealt: number;
	damageTaken: number;
}

interface Swing {
	active: boolean;
	angle: number;
	limit: number;
	speed: number;
	reach: number;
	hits: number;
	delay: number;
	hitIds: Set<number>;
	solidIds: Set<number>;
}

interface SlotState {
	slot: number;
	/** seconds until the next shot/swing may start (weapon_relaunch_time_count) */
	fireCd: number;
	/** fractional fuel owed by the flamethrower / stun gun / chainsaw (paid in whole units) */
	fuelDebt: number;
	/** bow: seconds the string has been held */
	drawTime: number;
	lastX?: number;
	lastY: number;
	/** weapon_angle_range_move: extra spread from running (deg) */
	moveSpread: number;
	swing: Swing;
	/** the weapon the machine is currently built for: a change resets cadence, reload and swing */
	weaponId: number;
	/** ping measured by the server (`Player:GetNetworkPing()`), in seconds — never a client number; filtered */
	pingS: number;
	pingSeen: boolean;
	/** running `tick − declared view`, in ticks: where this survivor's view normally sits (§2.3 continuity) */
	viewOffset: number;
	viewSeen: boolean;
	/** the survivor's consumed-command count when the offset last moved: it only moves on a command's own view */
	viewPackets: number;
	stats: CombatStats;
}

/** one thing a ray met */
interface TraceHit {
	t: number;
	x: number;
	y: number;
	zombie?: Ent.ZombieState;
	boss?: Ent.BossState;
	solid?: Solid;
}

function newSwing(): Swing {
	return {
		active: false,
		angle: 0,
		limit: 0,
		speed: 0,
		reach: 0,
		hits: 0,
		delay: 0,
		hitIds: new Set<number>(),
		solidIds: new Set<number>(),
	};
}

function newStats(): CombatStats {
	return {
		shots: 0,
		pellets: 0,
		hitsZombie: 0,
		hitsBoss: 0,
		blockedCadence: 0,
		blockedAmmo: 0,
		rewindClamped: 0,
		melee: 0,
		damageDealt: 0,
		damageTaken: 0,
	};
}

/** flamethrower / stun gun: their magazine refills for free, every shot burns 0.1 fuel */
export function isFuelWeapon(w: Wp.WeaponDef): boolean {
	return w.id === 25 || w.id === 26;
}

export class ServerCombat {
	readonly world: WorldData;
	readonly history: PositionHistory;
	readonly simHz: number;
	readonly fairBite: boolean;

	private readonly targets: CombatTargets;
	private readonly hooks: CombatHooks;
	private readonly progress?: Progress;
	private readonly rnd: () => number;
	private readonly slots = new Map<number, SlotState>();

	/** rewound candidates for the shot being resolved (parallel arrays: no allocation per pellet) */
	private readonly candZ = new Array<Ent.ZombieState>();
	private readonly candX = new Array<number>();
	private readonly candY = new Array<number>();
	private readonly candB = new Array<Ent.BossState>();
	private readonly candBX = new Array<number>();
	private readonly candBY = new Array<number>();
	private readonly point = { x: 0, y: 0 };
	private readonly solidBuf = new Array<Solid>();
	private readonly hit: TraceHit = { t: 0, x: 0, y: 0 };
	/** server seconds, derived from the tick: the assist window of §3.6 needs a clock, not a wall clock */
	private nowS = 0;

	constructor(options: ServerCombatOptions) {
		this.world = options.world;
		this.targets = options.targets;
		this.history = options.history ?? new PositionHistory();
		this.progress = options.progress;
		this.hooks = options.hooks ?? {};
		this.simHz = options.simHz !== undefined && options.simHz > 0 ? options.simHz : Cfg.SIM_HZ;
		this.rnd = options.random ?? (() => math.random());
		this.fairBite = options.fairBite !== false;
	}

	// ---------------------------------------------------------------- roster and metrics

	statsOf(slot: number): CombatStats {
		return this.slotOf(slot).stats;
	}

	/**
	 * The ping the SERVER measured for this survivor, in seconds (§2.3 rewind ceiling), once a second. Slow to rise,
	 * quick to fall: the first sample is taken as it is, a lower one is followed at PING_FALL a sample, a higher one
	 * at PING_RISE. A client that throttles its own link for a moment -- to widen the window for the shots right
	 * after -- moves its ceiling a tenth of the way per second; an honest ping that settles lower is trusted at once.
	 * The slot's state goes with the slot (`remove`) and with the town; a survivor coming back is seeded with the
	 * value it had (`seedPing`, ServerSimulation.setPing), so only a server's very first sample of them is raw.
	 */
	setPing(slot: number, seconds: number): void {
		const st = this.slotOf(slot);
		const sample = isFiniteNumber(seconds) && seconds > 0 ? math.min(seconds, 1) : 0;
		if (!st.pingSeen) {
			st.pingSeen = true;
			st.pingS = sample;
			return;
		}
		st.pingS += (sample - st.pingS) * (sample < st.pingS ? PING_FALL : PING_RISE);
	}

	/**
	 * Starts this slot's filter from a ping it already had (ServerSimulation.setPing: the same survivor, back through
	 * a leave/enter or a new town), so its next sample is filtered instead of taken as it is. A slot that has one
	 * already keeps it.
	 */
	seedPing(slot: number, seconds: number): void {
		const st = this.slotOf(slot);
		if (st.pingSeen || !isFiniteNumber(seconds) || seconds < 0) return;
		st.pingSeen = true;
		st.pingS = math.min(seconds, 1);
	}

	pingOf(slot: number): number {
		return this.slotOf(slot).pingS;
	}

	remove(slot: number): void {
		this.slots.delete(slot);
	}

	private slotOf(slot: number): SlotState {
		let st = this.slots.get(slot);
		if (st === undefined) {
			st = {
				slot,
				fireCd: 0,
				fuelDebt: 0,
				drawTime: 0,
				lastY: 0,
				moveSpread: 0,
				swing: newSwing(),
				weaponId: -1,
				pingS: 0,
				pingSeen: false,
				viewOffset: 0,
				viewSeen: false,
				viewPackets: -1,
				stats: newStats(),
			};
			this.slots.set(slot, st);
		}
		return st;
	}

	// ---------------------------------------------------------------- the tick (§3.1)

	/**
	 * §3.1 step 1, once per survivor, right after `stepPlayer`/`noteStep` and with the SAME command: the
	 * weapon machine (reload, cadence, shot with rewind, sweep) for the tick that command paid for.
	 */
	stepPlayer(sp: ServerPlayer, cmd: Net.InputCommand, tick: number, dt: number): void {
		this.nowS = tick / this.simHz;
		const st = this.slotOf(sp.slot);
		this.noteView(sp, st, tick);
		const p = sp.state;
		p.hitFlash = math.max(0, (p.hitFlash ?? 0) - dt);
		st.fireCd = math.max(st.fireCd - dt, -dt);
		this.recoverRecoil(sp, dt);
		this.trackMovement(sp, st, dt);

		// the aim is the one `stepPlayer` already dequantised from this very command: one value, one source
		const aim = p.angle;
		const w = this.weaponOf(sp, st);

		if (p.dead) {
			st.swing.active = false;
			st.drawTime = 0;
			p.swingerActive = false;
			return;
		}

		const held = (cmd.held & Net.HeldBit.Attack) !== 0;
		const presses = Net.edgeCount(cmd.edges, Net.EdgeShift.AttackPress);
		const releases = Net.edgeCount(cmd.edges, Net.EdgeShift.AttackRelease);
		const reloadPressed = Net.edgeCount(cmd.edges, Net.EdgeShift.Reload) > 0;
		this.updateReload(sp, st, w, reloadPressed, dt);

		if (w.id === 5) {
			this.updateChainsaw(sp, st, w, aim, held, dt);
			return;
		}
		if (w.kind === WeaponKind.Melee) {
			p.weapon.chainCount = 0;
			this.updateMelee(sp, st, w, aim, held || presses > 0, dt);
			return;
		}
		p.swingerActive = false;
		if (w.kind === WeaponKind.Bow && w.id !== 23) {
			this.updateBow(sp, st, w, aim, held, releases > 0, dt);
			return;
		}
		if (w.kind === WeaponKind.Sniper) {
			p.weapon.scopeTime = held ? p.weapon.scopeTime + dt : 0;
			// bolt action fires when the button is released; the semi-auto also while held
			if ((releases > 0 || (w.auto && held)) && st.fireCd <= 0) {
				if (this.fireGun(sp, st, w, aim, tick)) st.fireCd += w.cooldown;
			}
			return;
		}
		// rifles, pistols, MGs, shotguns, crossbow, flamethrower, stun gun
		const allowed = w.auto ? (held || presses > 0 ? 1 : 0) : math.min(presses, MAX_SHOTS_PER_TICK);
		let shots = 0;
		while (shots < allowed) {
			if (st.fireCd > 0) {
				st.stats.blockedCadence += 1;
				break;
			}
			if (!this.fireGun(sp, st, w, aim, tick)) break;
			// the floor of one tick is the hard rate cap: at most one resolution per command, i.e. SIM_HZ/s
			st.fireCd += math.max(w.cooldown, 1 / this.simHz);
			shots += 1;
		}
	}

	/**
	 * §3.1 step 3, once per tick after the world half moved: stores where every zombie and boss ended up, so
	 * the next shots can be judged against the world their shooters were drawing.
	 */
	afterWorld(tick: number): void {
		this.history.beginTick(tick);
		for (const z of this.targets.zombies()) {
			if (z.hp > 0) this.history.record(z.id, z.x, z.y);
		}
		for (const b of this.targets.bosses()) {
			if (!b.dead) this.history.record(b.id, b.x, b.y);
		}
	}

	// ---------------------------------------------------------------- damage to survivors (§2.3)

	/**
	 * The ONLY way a survivor loses HP from MP_PHASE 2 on (§2.3, §8.3, MP-00). Zombie bites, boss attacks,
	 * explosions and acid all come through here, on the server, against the server's positions.
	 */
	damagePlayer(sp: ServerPlayer, raw: number, fromAngle: number, bypassDef = false): boolean {
		return this.damageActor(sp.slot, sp.state, sp.save, raw, bypassDef, fromAngle);
	}

	/**
	 * The same thing for a caller that only holds a `PlayerState` — which is what the shared AI does
	 * (`shared/sim/ai/*` knows survivors, not sessions). `fromAngle` is optional because the zombie brains set
	 * `reactionDir` themselves right after, exactly as they did when they called `damageToPlayer`.
	 */
	damageActor(
		slot: number,
		p: Ply.PlayerState,
		save: PlayerSaveData,
		raw: number,
		bypassDef = false,
		fromAngle?: number,
	): boolean {
		const before = p.hp;
		if (!Ply.applyPlayerDamage(p, save, raw, bypassDef)) return false;
		if (fromAngle !== undefined) p.reactionDir = fromAngle;
		const st = this.slotOf(slot);
		st.stats.damageTaken += math.max(0, before - p.hp);
		this.emitBlood(p.x, p.y, fromAngle ?? p.reactionDir, 3, Net.BloodKind.Red);
		return true;
	}

	/**
	 * A drop-in replacement for `damageToPlayer` with the identical signature, bound to this server.
	 *
	 * `damageToPlayer` becomes a no-op at MP_PHASE ≥ 2 by design (shared/game/player.ts), and the zombie and
	 * boss brains in `shared/sim/ai/*` still call it — on the SERVER, where the damage is legitimate. Rather
	 * than teaching that gate to tell a server apart from a client (it cannot, and a gate with an exception is
	 * a gate with a hole), the horde owner injects this sink into its refs and the call sites change by one
	 * identifier. `slotOf` maps a survivor to their slot; a survivor it does not know takes no damage.
	 */
	damageSink(slotOf: (p: Ply.PlayerState) => number): PlayerDamageSink {
		return (p, save, raw, bypassDef) => {
			const slot = slotOf(p);
			if (slot < 0) return false;
			return this.damageActor(slot, p, save, raw, bypassDef ?? false);
		};
	}

	/**
	 * §2.3 "Mordida justa": a contact attack only lands when the zombie was ALSO within `contact + margin` at
	 * the instant the victim was drawing (rewound by their own view, capped by FAIR_BITE_REWIND_MAX_S). The
	 * server's present-tick check stays in 2A; this is the second, kinder condition on top of it.
	 *
	 * Note the asymmetry with a shot, and why it is the right one: the shooter's rewind helps the person who
	 * acted, the bite's rewind helps the person who was acted upon. Neither ever hands an advantage to lag.
	 */
	biteAllowed(sp: ServerPlayer, z: Ent.ZombieState, contact: number, tick: number): boolean {
		if (!this.fairBite) return true;
		const st = this.slotOf(sp.slot);
		const cap = biteRewindCapS(this.lagOf(sp, st), Cfg.INTERP_DEFAULT_S, this.simHz);
		// The same continuity as a shot, on the same running offset -- it is the same screen: a view that jumps to where
		// the zombie was still far would dodge the bite. That offset usually lies past this shorter ceiling (a round
		// trip plus the buffer is ~9 ticks already at 30 ms), and then the ceiling wins (`judge`): the bite is judged
		// FAIR_BITE_REWIND_MAX_S back, never further (the review of dee095a, S1)
		const at = this.judge(st, tick, this.declaredView(sp, tick), cap, 0);
		if (!this.history.sampleInto(z.id, at, this.point)) return true; // no past: the present already decided
		const reach = contact + FAIR_BITE_MARGIN;
		const dx = this.point.x - sp.state.x;
		const dy = this.point.y - sp.state.y;
		return dx * dx + dy * dy <= reach * reach;
	}

	// ---------------------------------------------------------------- weapon machine

	/** the weapon the SERVER says this survivor holds: owned, or the starting blade (§8.1 switchWeapon) */
	private weaponOf(sp: ServerPlayer, st: SlotState): Wp.WeaponDef {
		const id = sp.save.equipWeapon;
		const owned = id >= 0 && id < Wp.WEAPONS.size() && ownsWeapon(sp.save, id);
		const w = owned ? Wp.WEAPONS[id] : Wp.WEAPONS[0];
		if (st.weaponId < 0) {
			// first tick: ADOPT what createPlayer handed out instead of resetting it, or every survivor
			// would spawn with an empty magazine and a reload they never asked for
			st.weaponId = w.id;
			sp.state.weapon.pointer = w.id;
			return w;
		}
		if (st.weaponId !== w.id) {
			const rt = sp.state.weapon;
			const old = Wp.WEAPONS[st.weaponId];
			// rounds left in the old magazine go back to their pool (admin free ammo does not)
			if (old !== undefined && Wp.usesMagazine(old) && !isFuelWeapon(old) && rt.ammoCount > 0) {
				if (sp.state.infiniteAmmo !== true) Ply.weaponSpendAmmo(sp.save, old.ammoPool, -rt.ammoCount);
			}
			st.weaponId = w.id;
			st.fireCd = 0;
			st.drawTime = 0;
			st.swing.active = false;
			st.swing.hitIds.clear();
			st.swing.solidIds.clear();
			rt.pointer = w.id;
			rt.ammoCount = 0;
			rt.reloading = false;
			rt.reloadCount = 0;
			rt.reloadTotal = 0;
			rt.bowCount = 0;
			rt.angleRange = 0;
			rt.chainCount = 0;
			rt.scopeTime = 0;
			sp.state.swingerActive = false;
		}
		return w;
	}

	/** "Quick reload": the original counts reload frames × (1 + level/4) → FASTER, not slower */
	private reloadTime(sp: ServerPlayer, w: Wp.WeaponDef): number {
		return w.reload / (1 + sp.save.skillLevels[4] / 4);
	}

	private updateReload(sp: ServerPlayer, st: SlotState, w: Wp.WeaponDef, pressed: boolean, dt: number): void {
		const rt = sp.state.weapon;
		const fuel = isFuelWeapon(w);
		const reserve = fuel ? (Ply.weaponReserve(sp.save, w) >= 1 ? 1 : 0) : Ply.weaponReserve(sp.save, w);
		if (!Wp.usesMagazine(w) || rt.ammoCount >= w.mag || reserve <= 0) {
			rt.reloading = false;
			rt.reloadCount = 0;
			rt.autoReloadIdle = 0;
			return;
		}
		// empty magazine or shotgun tube → reload right away; otherwise after 1 s idle or on R
		const want =
			rt.reloading || pressed || rt.ammoCount <= 0 || w.kind === WeaponKind.Shotgun || rt.autoReloadIdle >= 1;
		if (!want) {
			rt.autoReloadIdle += dt;
			return;
		}
		if (st.fireCd > 0) {
			// firing interrupts the reload: progress restarts (weapon_reload_time_count = 0)
			rt.reloading = false;
			rt.reloadCount = 0;
			return;
		}
		if (!rt.reloading) {
			rt.reloading = true;
			rt.reloadTotal = this.reloadTime(sp, w);
			rt.reloadCount = rt.reloadTotal;
		}
		rt.reloadCount -= dt;
		if (rt.reloadCount > 0) return;
		const want2 = w.kind === WeaponKind.Shotgun ? 1 : w.mag - rt.ammoCount;
		if (fuel) {
			rt.ammoCount = w.mag;
		} else {
			const take = math.max(0, math.min(want2, reserve));
			rt.ammoCount += take;
			Ply.weaponSpendAmmo(sp.save, w.ammoPool, take);
		}
		rt.reloading = false;
		rt.reloadCount = 0;
		rt.autoReloadIdle = 0;
	}

	private recoverRecoil(sp: ServerPlayer, dt: number): void {
		const rt = sp.state.weapon;
		if (rt.angleRange <= 0) return;
		// quadratic settle like the original (faster when calm), plus a small linear floor
		const k = sp.state.buffs.calm > 0 ? 5 : 7;
		const con = 0.1 * ((rt.angleRange * rt.angleRange) / k) * SPEED_SCALE * dt + 2 * dt;
		rt.angleRange = rt.angleRange <= con ? 0 : rt.angleRange - con;
	}

	/**
	 * weapon_angle_range_move: the spread grows with the distance covered this tick. It is measured from the
	 * SERVER's own movement, so "hold still in the packets while running" is not a thing.
	 */
	private trackMovement(sp: ServerPlayer, st: SlotState, dt: number): void {
		const p = sp.state;
		if (st.lastX !== undefined && dt > 0) {
			const dx = p.x - st.lastX;
			const dy = p.y - st.lastY;
			const perFrame = math.sqrt(dx * dx + dy * dy) / (dt * SPEED_SCALE);
			const noPenalty = sp.save.skillLevels[18] > 0;
			st.moveSpread = noPenalty || perFrame > 60 ? 0 : perFrame / 4;
		}
		st.lastX = p.x;
		st.lastY = p.y;
	}

	/**
	 * obj_bullet: spread = ±(basic + recoil + running) × one of a few ranges (laser sight and the skill add
	 * narrower options). Rolled with the server's RNG: the client cannot remove it, and cannot predict it.
	 */
	private spreadRoll(sp: ServerPlayer): number {
		const skill = sp.save.skillLevels[5] > 0;
		const laser = sp.save.equipGun === LASER_SIGHT_ID;
		const options = skill && laser ? 4 : skill || laser ? 3 : 2;
		const pick = math.min(options - 1, math.floor(this.rnd() * options));
		const scale = pick === 0 ? 1 : pick === 1 ? 0.6 : 0.4;
		return (this.rnd() * 2 - 1) * scale;
	}

	/** damage_cal(n): the same roll shared/engine/rng.ts does, on the injectable server RNG */
	private damageRoll(n: number): number {
		return math.floor(n / 2 + this.rnd() * n);
	}

	private spendFuel(sp: ServerPlayer, st: SlotState, w: Wp.WeaponDef, amount: number): boolean {
		const save = sp.save;
		const have = w.id === 26 ? save.electric : save.oil;
		if (have <= 0) return false;
		st.fuelDebt += amount;
		while (st.fuelDebt >= 1) {
			st.fuelDebt -= 1;
			if (w.id === 26) save.electric = math.max(0, save.electric - 1);
			else save.oil = math.max(0, save.oil - 1);
		}
		return true;
	}

	// ---------------------------------------------------------------- guns (§2.3 flow of a shot)

	/** false when the shot did not happen (no round, no fuel): the caller must not spend the cadence on it */
	private fireGun(sp: ServerPlayer, st: SlotState, w: Wp.WeaponDef, aim: number, tick: number): boolean {
		const p = sp.state;
		const rt = p.weapon;
		if (rt.ammoCount <= 0) {
			st.stats.blockedAmmo += 1;
			return false;
		}
		if (isFuelWeapon(w) && !this.spendFuel(sp, st, w, SPECIAL_FUEL_PER_SHOT)) return false;
		rt.ammoCount -= 1;
		rt.autoReloadIdle = 0;
		st.stats.shots += 1;
		const spread = w.cone + rt.angleRange + st.moveSpread;

		if (w.id === 25) {
			this.launchFire(sp, w, aim, spread);
		} else if (w.id === 26) {
			this.fireStun(sp, st, w, aim);
		} else if (w.kind === WeaponKind.Bow) {
			this.launchArrow(sp, w, aim, spread); // crossbow: a magazine weapon that shoots an arrow
		} else {
			this.firePellets(sp, st, w, aim, spread, tick);
		}
		if (w.kind !== WeaponKind.Bow) {
			const loud = sp.save.equipGun === SILENCER_ID ? SHOT_NOISE / 3 : SHOT_NOISE;
			this.hooks.noise?.(p.x, p.y, loud, true);
		}
		rt.angleRange = math.min(40, rt.angleRange + w.recoil);
		return true;
	}

	private firePellets(
		sp: ServerPlayer,
		st: SlotState,
		w: Wp.WeaponDef,
		aim: number,
		spread: number,
		tick: number,
	): void {
		const p = sp.state;
		this.prepareTargets(sp, st, tick);
		const hits = new Array<Net.ShotHit>();
		const pellets = math.min(w.pellets, Net.FX_SHOT_MAX_HITS);
		for (let i = 0; i < pellets; i++) {
			const a = aim + this.spreadRoll(sp) * spread * DEG;
			const h = this.trace(p.x, p.y, a, w.range);
			st.stats.pellets += 1;
			let kind: number = Net.HitKind.None;
			const dmg = this.damageRoll(w.dmg);
			if (h.zombie !== undefined) {
				const extra = this.headshot(sp, a, h.zombie, dmg);
				this.damageZombie(sp, st, h.zombie, dmg + extra, KNOCK_BULLET + (extra > 0 ? KNOCK_HEADSHOT : 0), 0);
				kind = Net.HitKind.Zombie;
			} else if (h.boss !== undefined) {
				this.damageBoss(sp, st, h.boss, dmg, h.x, h.y);
				kind = Net.HitKind.Boss;
			} else if (h.solid !== undefined) {
				kind = h.solid.kind === "car" || h.solid.kind === "tree" ? Net.HitKind.MapItem : Net.HitKind.Solid;
				if (h.solid.kind === "car" && h.solid.tags === "car") this.hooks.chop?.(h.solid, false);
			}
			hits.push({ x: h.x, y: h.y, hit: kind });
		}
		// §2.3 step 3: everyone in interest gets the real end points; the shooter swaps its predicted ones
		this.hooks.fx?.({ t: Net.FxType.Shot, slot: sp.slot, weapon: w.id, hits });
	}

	/** obj_bullet headshot (skill "Head shooter"): a shot within 2° of the body centre, 10 % → +50 % */
	private headshot(sp: ServerPlayer, shotAngle: number, z: Ent.ZombieState, dmg: number): number {
		if (sp.save.skillLevels[19] <= 0) return 0;
		const to = math.atan2(z.y - sp.state.y, z.x - sp.state.x);
		if (math.abs(angleDiff(shotAngle, to)) >= 2 * DEG) return 0;
		if (this.rnd() * 100 >= 10) return 0;
		this.emitBlood(z.x, z.y, to, 6, Net.BloodKind.Green);
		return math.floor(dmg / 2);
	}

	/** obj_bullet_electric: zap the nearest zombie in the cone, then chain to its neighbours */
	private fireStun(sp: ServerPlayer, st: SlotState, w: Wp.WeaponDef, aim: number): void {
		const p = sp.state;
		const done = new Set<number>();
		let fromX = p.x;
		let fromY = p.y;
		let cone = STUN_CONE;
		// the stun gun PICKS its target instead of being aimed at a body, so it reads the present positions:
		// rewinding a target selection would let a client choose someone who has already left the cone (§2.3)
		for (let jump = 0; jump <= STUN_CHAINS; jump++) {
			let best: Ent.ZombieState | undefined;
			let bestD = w.range;
			for (const z of this.targets.zombies()) {
				if (z.hp <= 0 || done.has(z.id)) continue;
				const d = math.sqrt((z.x - fromX) * (z.x - fromX) + (z.y - fromY) * (z.y - fromY));
				if (d >= bestD || d < 1) continue;
				if (jump === 0 && math.abs(angleDiff(aim, math.atan2(z.y - fromY, z.x - fromX))) > cone) continue;
				if (!Phys.segmentClear(this.world, fromX, fromY, z.x, z.y, Phys.blocksShots)) continue;
				best = z;
				bestD = d;
			}
			if (best === undefined) {
				if (jump === 0) this.stunBoss(sp, st, w, aim);
				return;
			}
			done.add(best.id);
			this.damageZombie(sp, st, best, this.damageRoll(w.dmg), 0, 0, math.atan2(best.y - fromY, best.x - fromX));
			fromX = best.x;
			fromY = best.y;
			cone = math.pi;
		}
	}

	private stunBoss(sp: ServerPlayer, st: SlotState, w: Wp.WeaponDef, aim: number): void {
		const p = sp.state;
		for (const b of this.targets.bosses()) {
			if (b.hp <= 0) continue;
			const d = math.sqrt((b.x - p.x) * (b.x - p.x) + (b.y - p.y) * (b.y - p.y));
			if (d >= w.range + Ent.bossHitRadius(b)) continue;
			if (math.abs(angleDiff(aim, math.atan2(b.y - p.y, b.x - p.x))) >= STUN_CONE) continue;
			this.damageBoss(sp, st, b, this.damageRoll(w.dmg), b.x, b.y);
			return;
		}
	}

	private launchArrow(sp: ServerPlayer, w: Wp.WeaponDef, aim: number, spread: number): void {
		const p = sp.state;
		const robin = sp.save.skillLevels[6] > 0;
		const a = aim + this.spreadRoll(sp) * spread * (robin ? 0.5 : 1) * DEG;
		this.hooks.projectile?.({
			kind: Net.ProjKind.Arrow,
			ownerSlot: sp.slot,
			x: p.x + math.cos(aim) * DESIGN.PLAYER_ARM,
			y: p.y + math.sin(aim) * DESIGN.PLAYER_ARM,
			angle: a,
			speed: robin ? ARROW_SPEED_SKILL : ARROW_SPEED,
			damage: w.dmg,
			range: w.range,
			friction: ARROW_FRICTION,
		});
	}

	private launchFire(sp: ServerPlayer, w: Wp.WeaponDef, aim: number, spread: number): void {
		const p = sp.state;
		this.hooks.projectile?.({
			kind: Net.ProjKind.Fire,
			ownerSlot: sp.slot,
			x: p.x + math.cos(aim) * DESIGN.PLAYER_ARM,
			y: p.y + math.sin(aim) * DESIGN.PLAYER_ARM,
			angle: aim + this.spreadRoll(sp) * spread * DEG,
			speed: FIRE_SPEED,
			damage: w.dmg,
			range: w.range,
		});
	}

	private updateBow(
		sp: ServerPlayer,
		st: SlotState,
		w: Wp.WeaponDef,
		aim: number,
		held: boolean,
		released: boolean,
		dt: number,
	): void {
		const rt = sp.state.weapon;
		const need = w.cooldown;
		if (held && sp.save.ammoArrow > 0) st.drawTime += dt;
		rt.bowCount = need > 0 ? math.min(1, st.drawTime / need) : 1;
		if (!held && !released) {
			st.drawTime = 0;
			rt.bowCount = 0;
			return;
		}
		if (!released) return;
		// a full draw fires; letting go early cancels the shot (no arrow spent) — the draw time is the
		// server's own, so "instant full draw" is not something a packet can claim
		if (st.drawTime >= need && st.fireCd <= 0 && sp.save.ammoArrow > 0) {
			sp.save.ammoArrow -= 1;
			this.launchArrow(sp, w, aim, w.cone + rt.angleRange + st.moveSpread);
			st.fireCd = w.cooldown;
			rt.autoReloadIdle = 0;
			st.stats.shots += 1;
		} else if (st.fireCd > 0) {
			st.stats.blockedCadence += 1;
		}
		st.drawTime = 0;
		rt.bowCount = 0;
	}

	// ---------------------------------------------------------------- melee (§2.3, no rewind, with margin)

	private updateMelee(
		sp: ServerPlayer,
		st: SlotState,
		w: Wp.WeaponDef,
		aim: number,
		wants: boolean,
		dt: number,
	): void {
		const s = st.swing;
		if (!s.active) {
			sp.state.swingerActive = false;
			if (!wants || st.fireCd > 0) {
				if (wants) st.stats.blockedCadence += 1;
				return;
			}
			s.active = true;
			s.limit = w.cone;
			s.angle = -w.cone;
			s.speed = math.max(1, w.range);
			s.reach = Wp.meleeReach(w) + this.meleeMargin(st);
			s.hits = 0;
			s.delay = 0;
			s.hitIds.clear();
			s.solidIds.clear();
		}
		const p = sp.state;
		if (s.delay > 0) {
			s.delay -= dt;
		} else {
			const prev = s.angle;
			const step = s.speed * SPEED_SCALE * dt * (math.abs(s.angle - s.limit - 20) / 80);
			s.angle = math.min(s.limit + 1, s.angle + math.max(step, 0.5));
			this.sweep(sp, st, w, aim, prev, s.angle);
		}
		p.swingerActive = true;
		p.swingerAngle = aim + s.angle * DEG;
		p.swingReach = s.reach;
		if (s.angle > s.limit) {
			s.active = false;
			st.fireCd = math.max(st.fireCd, 0) + w.cooldown;
		}
	}

	/**
	 * The melee's latency margin of reach (§2.3): what a walker covers in the time this survivor's honest view is old
	 * -- the measured ping, the queue's target wait and the interpolation delay -- between MELEE_RANGE_MARGIN and
	 * MELEE_RANGE_MARGIN_MAX. The fixed 12 u was a walker in 130 ms; at 140 ms of RTT a body is drawn ~225 ms old
	 * (a round trip plus the buffer, client/net/snapshotBuffer.ts), 20 u of walk (the review of 2026-09-23, #6).
	 * Nothing the client sends goes in -- not even how long its commands wait -- so it is no wider for one that tries.
	 */
	private meleeMargin(st: SlotState): number {
		// The queue's TARGET wait, not the measured one (`viewWait`): the client decides how deep it keeps its queue,
		// and one kept at INPUT_BUFFER_MAX bought ~6 u of reach (the review of dee095a, N6). The rewind may count the
		// measured wait -- a shot is judged at a view, and the continuity holds it -- but reach is simply handed out.
		const age = st.pingS + Cfg.INPUT_BUFFER_TARGET / this.simHz + Cfg.INTERP_DEFAULT_S;
		return math.clamp(Cfg.MELEE_MARGIN_UPS * age, Cfg.MELEE_RANGE_MARGIN, Cfg.MELEE_RANGE_MARGIN_MAX);
	}

	/**
	 * The blade sweeps from −cone to +cone around the aim; bodies inside the reach whose bearing it crosses
	 * this tick are hit (2 per swing), each hit pausing it for a few frames. The arc gets ±MELEE_ARC_MARGIN_DEG
	 * and the reach `meleeMargin` of latency margin (§2.3).
	 */
	private sweep(sp: ServerPlayer, st: SlotState, w: Wp.WeaponDef, aim: number, fromDeg: number, toDeg: number): void {
		const s = st.swing;
		const p = sp.state;
		const lo = fromDeg - Cfg.MELEE_ARC_MARGIN_DEG;
		const hi = toDeg + Cfg.MELEE_ARC_MARGIN_DEG;
		const bonus = 1 + sp.save.skillLevels[3] / 4;
		const knock = KNOCK_MELEE + sp.save.skillLevels[2] * 3;
		const crossed = new Array<{ z: Ent.ZombieState; a: number }>();
		for (const z of this.targets.zombies()) {
			if (z.hp <= 0 || s.hitIds.has(z.id)) continue;
			const dx = z.x - p.x;
			const dy = z.y - p.y;
			const d = math.sqrt(dx * dx + dy * dy);
			const zr = Ent.zombieRadius(z);
			if (d - zr > s.reach) continue;
			const rel = angleDiff(aim, math.atan2(dy, dx)) / DEG;
			const pad = d > zr ? math.deg(math.asin(zr / d)) : 90;
			if (rel + pad < lo || rel - pad > hi) continue;
			crossed.push({ z, a: rel });
		}
		crossed.sort((a, b) => a.a < b.a);
		for (const c of crossed) {
			if (s.hits >= MELEE_MAX_TARGETS) break;
			s.hits += 1;
			s.hitIds.add(c.z.id);
			st.stats.melee += 1;
			this.damageZombie(sp, st, c.z, math.floor(this.damageRoll(w.dmg) * bonus), knock, 0);
			s.delay = HITSTOP;
		}
		for (const b of this.targets.bosses()) {
			if (s.hits >= MELEE_MAX_TARGETS || s.hitIds.has(-b.id) || b.hp <= 0) continue;
			const tip = aim + ((fromDeg + toDeg) / 2) * DEG;
			let touched: { x: number; y: number } | undefined;
			for (let k = 1; k <= 3 && touched === undefined; k++) {
				const dist = (s.reach * k) / 3;
				touched = this.bossContact(b, p.x + math.cos(tip) * dist, p.y + math.sin(tip) * dist, 8);
			}
			if (touched === undefined) continue;
			s.hits += 1;
			s.hitIds.add(-b.id);
			st.stats.melee += 1;
			this.damageBoss(sp, st, b, math.floor(this.damageRoll(w.dmg) * bonus), touched.x, touched.y);
			s.delay = HITSTOP;
		}
		this.chopMapItems(sp, w, aim, lo, hi, s.reach, false);
	}

	/** the chainsaw: hold to rev (warm-up), then it cuts everything in front continuously */
	private updateChainsaw(
		sp: ServerPlayer,
		st: SlotState,
		w: Wp.WeaponDef,
		aim: number,
		held: boolean,
		dt: number,
	): void {
		const p = sp.state;
		const rt = p.weapon;
		const fuelled = held && sp.save.oil > 0 && this.spendFuel(sp, st, w, CHAINSAW_OIL_PER_SEC * dt);
		rt.chainCount = fuelled ? math.min(CHAINSAW_MAX, rt.chainCount + dt) : math.max(0, rt.chainCount - dt);
		const cutting = fuelled && rt.chainCount >= CHAINSAW_WARMUP;
		const reach = Wp.meleeReach(w) + this.meleeMargin(st);
		p.swingerActive = cutting;
		p.swingerAngle = aim;
		p.swingReach = reach;
		if (!cutting) return;
		const arc = CHAINSAW_ARC + Cfg.MELEE_ARC_MARGIN_DEG * DEG;
		const bonus = 1 + sp.save.skillLevels[3] / 4;
		const knock = (KNOCK_MELEE + sp.save.skillLevels[2] * 3) * SPEED_SCALE * dt;
		for (const z of this.targets.zombies()) {
			if (z.hp <= 0) continue;
			const dx = z.x - p.x;
			const dy = z.y - p.y;
			const d = math.sqrt(dx * dx + dy * dy);
			const zr = Ent.zombieRadius(z);
			if (d - zr > reach) continue;
			const pad = d > zr ? math.asin(zr / d) : math.pi / 2;
			if (math.abs(angleDiff(aim, math.atan2(dy, dx))) > arc + pad) continue;
			// damage_cal(10) every frame of contact → per second
			this.damageZombie(sp, st, z, this.damageRoll(w.dmg) * bonus * SPEED_SCALE * dt, knock, 0);
		}
		for (const b of this.targets.bosses()) {
			if (b.hp <= 0) continue;
			const tip = this.bossContact(
				b,
				p.x + math.cos(aim) * reach * 0.7,
				p.y + math.sin(aim) * reach * 0.7,
				reach * 0.3,
			);
			if (tip === undefined) continue;
			this.damageBoss(sp, st, b, this.damageRoll(w.dmg) * bonus * SPEED_SCALE * dt, tip.x, tip.y);
		}
		this.chopMapItems(sp, w, aim, -CHAINSAW_ARC / DEG, CHAINSAW_ARC / DEG, reach, true);
	}

	/** trees / cars / bins the blade passes over shake and may drop an item (once per swing) */
	private chopMapItems(
		sp: ServerPlayer,
		w: Wp.WeaponDef,
		aim: number,
		fromDeg: number,
		toDeg: number,
		reach: number,
		continuous: boolean,
	): void {
		if (this.hooks.chop === undefined) return;
		const p = sp.state;
		const st = this.slotOf(sp.slot);
		const buf = this.solidBuf;
		buf.clear();
		querySolids(this.world, p.x - reach - 8, p.y - reach - 8, p.x + reach + 8, p.y + reach + 8, buf);
		for (const s of buf) {
			if (s.kind !== "tree" && s.kind !== "car") continue;
			if (!continuous && st.swing.solidIds.has(s.id)) continue;
			const qx = math.clamp(p.x, s.x, s.x + s.w);
			const qy = math.clamp(p.y, s.y, s.y + s.h);
			if (math.sqrt((qx - p.x) * (qx - p.x) + (qy - p.y) * (qy - p.y)) > reach) continue;
			const cx = s.x + s.w / 2;
			const cy = s.y + s.h / 2;
			const rel = angleDiff(aim, math.atan2(cy - p.y, cx - p.x)) / DEG;
			const half = math.max(s.w, s.h) / 2;
			const cd = math.max(1, math.sqrt((cx - p.x) * (cx - p.x) + (cy - p.y) * (cy - p.y)));
			const pad = cd > half ? math.deg(math.asin(half / cd)) : 90;
			if (rel + pad < fromDeg || rel - pad > toDeg) continue;
			if (!continuous) st.swing.solidIds.add(s.id);
			if (this.hooks.chop(s, Wp.isChoppingTool(w))) {
				this.hooks.fx?.({ t: Net.FxType.SolidShake, solidId: s.id, angle: aim, strength: 1 });
			}
		}
	}

	// ---------------------------------------------------------------- tracing with rewind (§2.3)

	/**
	 * What the rewind ceiling counts as this shooter's latency, in seconds: the ping the SERVER measured (filtered,
	 * `setPing`), plus the ticks the consumed command waited in the input queue (players.ts `viewWait`, measured here
	 * too, and never more than INPUT_BUFFER_MAX). An honest view is a round trip, the client's buffer AND that wait
	 * old when its shot is simulated; without the wait a 150 ms client sat on the edge of its ceiling and a
	 * quarter of its shots were clamped (tools/test-combat.mjs, c'').
	 */
	private lagOf(sp: ServerPlayer, st: SlotState): number {
		const wait = isFiniteNumber(sp.viewWait) ? math.clamp(sp.viewWait, 0, Cfg.INPUT_BUFFER_MAX) : 0;
		return st.pingS + wait / this.simHz;
	}

	/** the (fractional) tick this client SAYS it was drawing; §8.3 never trusts it, `judge` clamps it */
	private declaredView(sp: ServerPlayer, tick: number): number {
		return unwrapTick(sp.viewTick, tick) + sp.viewFrac / 256;
	}

	/**
	 * Keeps the survivor's running view offset (`tick − declared`, in ticks), once per tick that consumed a real
	 * command -- whose view is the frame that built it (players.ts `takeCommand`). An honest client's view moves
	 * smoothly (its delay changes at ±5 %, §5.1) with a tick or two of arrival jitter on top; a view that jumps for
	 * one shot shows up against it. Only views the ceiling allows feed it, and a wait (no command) holds it where
	 * it was instead of letting a stale view drag it.
	 */
	private noteView(sp: ServerPlayer, st: SlotState, tick: number): void {
		const consumed = sp.counters.consumed;
		if (consumed === 0 || consumed === st.viewPackets) return;
		st.viewPackets = consumed;
		const hz = this.simHz;
		const cap = rewindCapS(this.lagOf(sp, st), Cfg.INTERP_DEFAULT_S, hz) * hz;
		const offset = math.clamp(tick - this.declaredView(sp, tick), 0, cap);
		if (!st.viewSeen) {
			st.viewSeen = true;
			st.viewOffset = offset;
			return;
		}
		st.viewOffset += (offset - st.viewOffset) * VIEW_OFFSET_ALPHA;
	}

	/**
	 * The (fractional) tick a declared view is judged at (§2.3): inside the ping ceiling `[now − cap, now]`
	 * (`judgedTick`), and within VIEW_CONTINUITY_TICKS of where this survivor's view normally sits, shifted by
	 * `extra` for a body the survivor draws further back (the mid ring). Either bound may cut: the ceiling stops a
	 * view older than the ping explains, the continuity a view that jumps for one shot inside it.
	 *
	 * When the two do not meet -- the running offset sits further back than this ceiling reaches: a bite's shorter
	 * one (`biteAllowed`), or a ping that has just fallen faster than the offset follows -- the CEILING wins: the
	 * newest end of the continuity lay past it, and answering that end rewound past the ceiling (the review of
	 * dee095a, S1: an offset of 16 ticks judged 13 back under a ceiling of 6, 9 or 12).
	 */
	private judge(st: SlotState, tick: number, declared: number, capS: number, extra: number): number {
		const hz = this.simHz;
		const at = judgedTick(tick, declared, capS, hz);
		if (!st.viewSeen) return at;
		const oldest = tick - capS * hz;
		const lo = math.max(oldest, tick - (st.viewOffset + extra + Cfg.VIEW_CONTINUITY_TICKS));
		const hi = math.min(tick, tick - math.max(0, st.viewOffset + extra - Cfg.VIEW_CONTINUITY_TICKS));
		// lo > hi only when the whole continuity window is older than `oldest` (then lo IS `oldest`)
		return lo <= hi ? math.clamp(at, lo, hi) : lo;
	}

	/**
	 * Rewinds every live target to the instant the shooter was drawing, once per shot (not per pellet), into
	 * the parallel candidate arrays. A target with no history yet (it appeared this tick) keeps its present
	 * position: the honest answer, and never a free hit.
	 *
	 * A zombie the shooter draws in the MID ring is drawn a near interval further back than the declared view (the
	 * buffer's render time; client/net/snapshotBuffer.ts `extra`), and is judged there, with MID_REWIND_EXTRA_S more
	 * ceiling for it alone. Judged at the declared view it stood 3 ticks ahead of the body on the shooter's screen:
	 * 4.5 u at the median, 10 u at worst (the review of 2026-09-23, #2).
	 */
	private prepareTargets(sp: ServerPlayer, st: SlotState, tick: number): void {
		const cap = rewindCapS(this.lagOf(sp, st), Cfg.INTERP_DEFAULT_S, this.simHz);
		const declared = this.declaredView(sp, tick);
		const at = this.judge(st, tick, declared, cap, 0);
		// MP-16 level 1 evidence (server/net/mpHost.ts `anomalies`): a view the ceiling or the continuity had to move
		if (math.abs(declared - at) > 1e-6) st.stats.rewindClamped += 1;
		const rewind = at < tick - 1e-6;
		const midCap = cap + Cfg.MID_REWIND_EXTRA_S;
		this.candZ.clear();
		this.candX.clear();
		this.candY.clear();
		this.candB.clear();
		this.candBX.clear();
		this.candBY.clear();
		for (const z of this.targets.zombies()) {
			if (z.hp <= 0) continue;
			let x = z.x;
			let y = z.y;
			// asked at the JUDGED view, not the declared one: within the ceiling and the continuity either way
			const extra = this.targets.viewExtraTicks?.(sp.slot, z, at) ?? 0;
			const zAt = extra > 0 ? this.judge(st, tick, declared - extra, midCap, extra) : at;
			if (zAt < tick - 1e-6 && this.history.sampleInto(z.id, zAt, this.point)) {
				x = this.point.x;
				y = this.point.y;
			}
			this.candZ.push(z);
			this.candX.push(x);
			this.candY.push(y);
		}
		for (const b of this.targets.bosses()) {
			if (b.hp <= 0) continue;
			let x = b.x;
			let y = b.y;
			if (rewind && this.history.sampleInto(b.id, at, this.point)) {
				x = this.point.x;
				y = this.point.y;
			}
			this.candB.push(b);
			this.candBX.push(x);
			this.candBY.push(y);
		}
	}

	/**
	 * First thing on the ray: wall/tree/car in the PRESENT, or a rewound body. Solids are never rewound — a
	 * door someone just closed must stop the bullet, or closing it would be pointless (§2.3).
	 */
	private trace(x0: number, y0: number, ang: number, range: number): TraceHit {
		const dx = math.cos(ang);
		const dy = math.sin(ang);
		const wall = Phys.raycast(this.world, x0, y0, ang, range, Phys.blocksShots);
		let best = wall.dist;
		const out = this.hit;
		out.zombie = undefined;
		out.boss = undefined;
		out.solid = undefined;
		for (let i = 0; i < this.candZ.size(); i++) {
			const z = this.candZ[i];
			const t = Phys.rayCircle(x0, y0, dx, dy, this.candX[i], this.candY[i], Ent.zombieRadius(z));
			if (t !== undefined && t < best) {
				best = t;
				out.zombie = z;
			}
		}
		for (let i = 0; i < this.candB.size(); i++) {
			const b = this.candB[i];
			// the centipede's body is a trail behind the head: shifting the segments by the head's rewind
			// offset is the trail the shooter was drawing (the client rebuilds it from the head anyway, §4.2)
			const ox = this.candBX[i] - b.x;
			const oy = this.candBY[i] - b.y;
			if (b.type === 1 && b.bodyX !== undefined && b.bodyY !== undefined) {
				for (let k = 0; k < b.bodyX.size(); k += 2) {
					const t = Phys.rayCircle(
						x0,
						y0,
						dx,
						dy,
						b.bodyX[k] + ox,
						b.bodyY[k] + oy,
						Ent.BOSS1_SEGMENT_RADIUS,
					);
					if (t !== undefined && t < best) {
						best = t;
						out.boss = b;
						out.zombie = undefined;
					}
				}
			} else {
				const t = Phys.rayCircle(x0, y0, dx, dy, this.candBX[i], this.candBY[i], Ent.bossHitRadius(b));
				if (t !== undefined && t < best) {
					best = t;
					out.boss = b;
					out.zombie = undefined;
				}
			}
		}
		if (out.boss !== undefined) out.zombie = undefined;
		if (out.zombie === undefined && out.boss === undefined) out.solid = wall.solid;
		out.t = best;
		out.x = x0 + dx * best;
		out.y = y0 + dy * best;
		return out;
	}

	/** does a circle touch a boss body? returns the contact point */
	private bossContact(b: Ent.BossState, x: number, y: number, r: number): { x: number; y: number } | undefined {
		if (b.hp <= 0) return undefined;
		if (b.type === 1 && b.bodyX !== undefined && b.bodyY !== undefined) {
			for (let i = 0; i < b.bodyX.size(); i += 2) {
				const dx = b.bodyX[i] - x;
				const dy = b.bodyY[i] - y;
				const rr = Ent.BOSS1_SEGMENT_RADIUS + r;
				if (dx * dx + dy * dy < rr * rr) return { x: b.bodyX[i], y: b.bodyY[i] };
			}
			return undefined;
		}
		const rr = Ent.bossHitRadius(b) + r;
		const dx = b.x - x;
		const dy = b.y - y;
		return dx * dx + dy * dy < rr * rr ? { x: b.x, y: b.y } : undefined;
	}

	// ---------------------------------------------------------------- applying damage (in the PRESENT)

	/**
	 * The zombie takes the hit where it is NOW, pushed away from where the shooter is NOW (§2.3: only the
	 * decision "did it connect?" is rewound; the consequences happen in the present, or two players would see
	 * bodies fly in different directions).
	 */
	private damageZombie(
		sp: ServerPlayer,
		st: SlotState,
		z: Ent.ZombieState,
		damage: number,
		knock: number,
		stun: number,
		away?: number,
		weaponKind?: number,
	): void {
		if (damage <= 0 || z.hp <= 0) return;
		const dir = away ?? math.atan2(z.y - sp.state.y, z.x - sp.state.x);
		const dealt = math.min(damage, z.hp);
		z.hp -= damage;
		st.stats.hitsZombie += 1;
		st.stats.damageDealt += dealt;
		this.progress?.noteZombieDamage(z.id, sp.slot, dealt, this.nowS);
		if (this.hooks.hitZombie !== undefined) this.hooks.hitZombie(z, damage, dir, knock, stun);
		else this.defaultReaction(z, dir, knock, stun);
		this.emitBlood(z.x, z.y, dir, 3, Net.BloodKind.Green);
		if (z.hp <= 0) {
			// the credit says what did it too (CON-04): the zombie's kind, and the kind of the weapon -- the one that
			// launched the projectile, or the one the server says is in hand
			const kind = weaponKind ?? Wp.WEAPONS[st.weaponId]?.kind ?? -1;
			this.progress?.zombieKilled(z.id, z.exp, sp.slot, this.nowS, z.type, kind);
			this.history.forget(z.id);
			this.hooks.zombieKilled?.(z, sp.slot);
		}
	}

	private damageBoss(sp: ServerPlayer, st: SlotState, b: Ent.BossState, damage: number, x: number, y: number): void {
		if (damage <= 0 || b.hp <= 0) return;
		const dealt = math.min(damage, b.hp);
		b.hp -= damage;
		b.hitFlash = 1;
		st.stats.hitsBoss += 1;
		st.stats.damageDealt += dealt;
		this.progress?.noteBossDamage(b.id, sp.slot, dealt, this.nowS);
		this.hooks.hitBoss?.(b, damage, x, y);
		this.emitBlood(x, y, math.atan2(y - sp.state.y, x - sp.state.x), 3, Net.BloodKind.Green);
		if (b.hp <= 0) {
			this.progress?.bossKilled(b.id, b.exp, b.hpMax, sp.slot, b.type);
			this.history.forget(b.id);
			this.hooks.bossKilled?.(b, sp.slot);
		}
	}

	/**
	 * A projectile in flight reached this zombie (server/sim/projectiles.ts). The flight belongs to the world
	 * half of the tick (§3.1 step 2); the DAMAGE belongs here, and going through the same private path as a
	 * bullet is what stops an arrow ever paying different XP, or leaving a different assist trail, from a
	 * rifle round that did the same harm. `weaponKind` is the kind of the weapon that launched it (the survivor may
	 * hold another by the time it lands): what a kill by it is credited as (CON-04).
	 */
	hitZombieWith(
		sp: ServerPlayer,
		z: Ent.ZombieState,
		damage: number,
		knock: number,
		stun: number,
		away?: number,
		weaponKind?: number,
	): void {
		this.damageZombie(sp, this.slotOf(sp.slot), z, damage, knock, stun, away, weaponKind);
	}

	/** the same for a boss (`x`, `y` are where the projectile touched it, for the blood) */
	hitBossWith(sp: ServerPlayer, b: Ent.BossState, damage: number, x: number, y: number): void {
		this.damageBoss(sp, this.slotOf(sp.slot), b, damage, x, y);
	}

	/** the server's damage roll, so a projectile rolls it exactly as a bullet does */
	rollDamage(n: number): number {
		return this.damageRoll(n);
	}

	/** what 2A's reactToHit does, in the plain form, so this module works (and is tested) on its own */
	private defaultReaction(z: Ent.ZombieState, dir: number, knock: number, stun: number): void {
		z.hitFlash = 1;
		if (knock > 0) {
			z.reactionSpeed = math.min(9, z.reactionSpeed + knock);
			z.reactionDir = dir;
		}
		if (stun > 0) z.stunned = math.max(z.stunned, stun);
	}

	private emitBlood(x: number, y: number, angle: number, amount: number, kind: number): void {
		this.hooks.fx?.({ t: Net.FxType.Blood, x, y, angle, amount, kind });
	}
}
