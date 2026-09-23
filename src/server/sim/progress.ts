/*
 * XP, kills, bosses and levels, decided by the SERVER and written straight into the live save
 * (docs/MULTIPLAYER.md §3.6, §6.1, §8.3, §11.3 F2 acceptance; DESIGN_RULES MP-00, MP-15).
 *
 * Until F2 the numbers came from the client: `gameLoop.onExp` levelled the local save and the player REPORTED
 * the result, which server/main.server.ts could only rate-limit ("is this much progress plausible per minute?").
 * That is a plausibility filter, not authority — a modified client inside the credit window is indistinguishable
 * from a good player. From MP_PHASE 2 on the server counts the kill itself and the reported fields are ignored
 * (`stripClientProgress`), which is exactly the §11.3 F2 acceptance line: "o XP só vem do servidor".
 *
 * What this module owns:
 *   - a damage ledger per zombie, so the 60 % assist share of §3.6 / MP-15 kills "kill stealing" without paying
 *     twice for the same body;
 *   - a participation ledger per boss (≥ 3 % of its HP, or ≥ 20 s within 1200 u while it was alive), so every
 *     survivor who actually fought it gets the full XP and the boss kill;
 *   - the level curve itself (`expMaxInit`, the same one the single-player loop used), applied to the live save.
 *
 * Pure module: no Instances, no services, no os.clock. Every entry point takes `now` in seconds, which is what
 * lets the ledgers be replayed deterministically in Node (tools/test-combat.mjs).
 */
import { SAVE_LIMITS, expMaxInit, PlayerSaveData } from "shared/game/save";
import { ECONOMY } from "shared/data/shop";
import { isFiniteNumber } from "shared/net/codec";
import { MP_PHASE } from "shared/net/mpConfig";

// ---------------------------------------------------------------- constants (§3.6)

/** MP_PHASE from which the server, not the report, decides progress (§11.3 F2) */
export const PROGRESS_SERVER_PHASE = 2;

/** a hit counts as helping to kill for this long (§3.6 "nos últimos 10 s") */
export const ASSIST_WINDOW_S = 10;
/** what an assist is worth, against the killer's 100 % (§3.6, MP-15) */
export const ASSIST_SHARE = 0.6;
/** share of a boss's HP that alone makes a survivor a participant (§3.6) */
export const BOSS_DAMAGE_SHARE = 0.03;
/** …or this long spent within BOSS_NEAR_RANGE of the living boss (§3.6) */
export const BOSS_NEAR_S = 20;
export const BOSS_NEAR_RANGE = 1200;

/** the fields a client report may no longer move once the server owns them (§11.3 F2 acceptance) */
export const SERVER_PROGRESS_FIELDS: ReadonlyArray<string> = ["level", "exp", "skillPoint", "bossKills", "day"];

/**
 * Does the SERVER count and pay progress? From MP_PHASE 2 on it does, which means the day's and the boss's
 * coins are paid by `creditDaySurvived` / `creditBossKill` at the instant the event happens, and the report
 * path in server/main.server.ts must not pay for them a second time (§6.3).
 */
export function serverOwnsProgress(): boolean {
	return MP_PHASE >= PROGRESS_SERVER_PHASE;
}

// ---------------------------------------------------------------- the level curve

/**
 * Grants `amount` XP to a save, levelling exactly like the single-player loop did (gameLoop.onExp): every
 * full `expMaxInit(level)` is one level and one skill point. Returns the levels gained.
 *
 * The loop is bounded twice over: XP is clamped to a sane maximum first, and `expMaxInit` never returns less
 * than 20, so a corrupt save can never spin here.
 */
export function awardExp(save: PlayerSaveData, amount: number): number {
	if (!isFiniteNumber(amount) || amount <= 0) return 0;
	save.exp += math.min(amount, SAVE_LIMITS.COUNTER_MAX);
	let levels = 0;
	while (save.level < SAVE_LIMITS.LEVEL_MAX) {
		const need = expMaxInit(save.level);
		if (need <= 0 || save.exp < need) break;
		save.exp -= need;
		save.level += 1;
		save.skillPoint += 1;
		levels += 1;
	}
	if (save.level >= SAVE_LIMITS.LEVEL_MAX) save.exp = math.min(save.exp, expMaxInit(save.level));
	return levels;
}

/**
 * A boss went down (§3.6): the lifetime counter, and the coins that go with it.
 *
 * Same regression as `creditDaySurvived`, same cause: `applyProgressLimits` only paid COINS_PER_BOSS when a
 * report moved `bossKills`, and `stripClientProgress` pins `bossKills`. Since F2 a boss has paid nothing.
 * `paid = false` is the assisted run (§9.3): an admin spawned it, so it is not worth coins.
 */
export function creditBossKill(save: PlayerSaveData, paid = true): number {
	const before = save.bossKills;
	save.bossKills = math.min(SAVE_LIMITS.COUNTER_MAX, save.bossKills + 1);
	if (!paid || save.bossKills === before) return 0;
	const coins = ECONOMY.COINS_PER_BOSS;
	save.money = math.min(SAVE_LIMITS.MONEY_MAX, save.money + coins);
	return coins;
}

/** what one midnight paid a survivor (§3.6); `coins` is already inside `save.money` */
export interface DayCredit {
	/** the survivor's run day AFTER the credit */
	day: number;
	/** true when the day actually advanced (it does not at DAY_MAX) */
	advanced: boolean;
	/** coins added to `save.money`, milestone bonus included */
	coins: number;
	/** of those, the §3.6 record-milestone bonus */
	milestone: number;
}

/**
 * The world's clock passed midnight and this survivor lived through it (§3.6 "Dia sobrevivido", §6.2).
 *
 * `day` is the survivor's OWN day — how long this run has lasted — which is not the world's day: somebody
 * joining on world day 30 starts their run at 1. Before F2 the client counted it and reported it; with the
 * report's progress fields now pinned (`stripClientProgress`), this is the only thing that can still move
 * it, and without it a run's day would be frozen for ever.
 *
 * THE COINS ARE PAID HERE, and that is the F3 fix. F2 pinned `day` in the report, and the payment lived in
 * server/main.server.ts's `applyProgressLimits`, which only pays when `upd.day > prev.day` — a condition
 * `stripClientProgress` had just made permanently false. So from F2 on, a day survived silently paid
 * nothing: no COINS_PER_DAY and no milestone bonus, for anybody, ever. A reward that is generated by the
 * server has to be paid by the server, at the instant it is generated (§6.3), which is this line.
 *
 * The milestone baseline is `bestDay`, exactly as `applyProgressLimits` had it: the bonus is for REACHING a
 * multiple of MILESTONE_EVERY for the first time, so a rebirth back to day 1 does not sell it again.
 *
 * `paid = false` reproduces §9.3's "assisted run": an admin used world tools in this run, so the day still
 * advances (the world moved) but the run earns nothing. The caller decides — the ledger has no idea what an
 * admin is, and `setClock` (the admin's own skip) never reaches here at all, which is §3.6's "Horas puladas
 * por admin: ninguém, 0".
 *
 * WHO is credited is `dayRefusal`'s question, asked by server/sim/simulation.ts before it calls this: until the
 * security review of Sep 2026 everybody in the roster at midnight was paid — the dead, and a bot parked in the
 * street — and `bestDay` climbed without anybody surviving anything.
 */
export function creditDaySurvived(save: PlayerSaveData, paid = true): DayCredit {
	const before = save.day;
	const bestBefore = save.bestDay;
	save.day = math.min(SAVE_LIMITS.DAY_MAX, save.day + 1);
	save.bestDay = math.clamp(math.max(save.bestDay, save.day), 1, SAVE_LIMITS.DAY_MAX);
	const advanced = save.day > before;
	const out: DayCredit = { day: save.day, advanced, coins: 0, milestone: 0 };
	// a run stuck at DAY_MAX has not survived another day, so it is not paid for one either
	if (!advanced || !paid) return out;
	out.coins = ECONOMY.COINS_PER_DAY;
	for (let d = bestBefore + 1; d <= save.day; d++) {
		if (d % ECONOMY.MILESTONE_EVERY === 0) out.milestone += ECONOMY.MILESTONE_BONUS;
	}
	out.coins += out.milestone;
	save.money = math.min(SAVE_LIMITS.MONEY_MAX, save.money + out.coins);
	return out;
}

/**
 * §9.1 "Bot / macro de farm AFK": no REAL command that moved or pressed something for this long, and midnight does
 * not pay (seconds). A filled tick (§2.2) is the server waiting for input, not the player playing, and a HELD button
 * repeats itself in every command for free, so neither counts; a step or an edge (attack, action, reload) does.
 */
export const AFK_WINDOW_S = 180;
/**
 * §3.6 / MP-13: the share of the day a survivor must have spent ALIVE in the world to be paid for it — measured
 * against the ticks the world actually ran since the previous midnight (or since the server started, for its
 * first one). Walking in at 23:50, or lying dead from dusk, is not a day survived.
 */
export const PRESENCE_SHARE = 0.5;

/** why midnight did not pay somebody who was in the world (§3.6) */
export type DayRefusal = "dead" | "absent" | "afk";

/**
 * Does this survivor earn the day that just ended (§3.6 "Dia sobrevivido", §9.1, MP-13)? Undefined = yes; otherwise
 * the reason not:
 *   - "dead":   the body is lying in the street (it waits for daybreak or a Rebirth, server/sim/life.ts);
 *   - "absent": alive in the world for fewer than PRESENCE_SHARE of `dayTicks`;
 *   - "afk":    no real input with movement or an edge in the last AFK_WINDOW_S (`lastActiveTick` undefined =
 *               never since the previous midnight's bookkeeping began).
 */
export function dayRefusal(
	dead: boolean,
	aliveTicks: number,
	dayTicks: number,
	lastActiveTick: number | undefined,
	tick: number,
	simHz: number,
): DayRefusal | undefined {
	if (dead) return "dead";
	if (aliveTicks < dayTicks * PRESENCE_SHARE) return "absent";
	if (lastActiveTick === undefined || tick - lastActiveTick > AFK_WINDOW_S * simHz) return "afk";
	return undefined;
}

/**
 * Overwrites every server-owned progress field of a client report with the trusted copy, and answers whether
 * the report had tried to move any of them. With MP_PHASE ≥ 2 the server counted those numbers itself, so a
 * report carrying different ones is not "suspicious", it is simply **stale** — §9.2 level 0, corrected in
 * silence. The answer is only a signal for the admin panel (§9.3).
 *
 * WIRING (server/main.server.ts belongs to another front): in `processReport`, one line between the sanitize
 * and the credit window —
 *
 *   const upd = sanitizeClientReport(decoded, prev);
 *   if (upd === undefined) { rejectReport(s, "invalid"); return; }
 *   stripClientProgress(prev, upd);                       // ← F2 2C: the server counted these itself
 *   const reward = applyProgressLimits(s, prev, upd, …);
 *
 * With the fields pinned to `prev`, the day/level/boss credit windows have nothing left to clamp and the coins
 * follow the server's own events instead of a report (§9.1 "exploit de economia").
 */
export function stripClientProgress(prev: PlayerSaveData, upd: PlayerSaveData): boolean {
	if (MP_PHASE < PROGRESS_SERVER_PHASE) return false;
	let changed = false;
	if (upd.level !== prev.level) changed = true;
	if (upd.exp !== prev.exp) changed = true;
	if (upd.skillPoint !== prev.skillPoint) changed = true;
	if (upd.bossKills !== prev.bossKills) changed = true;
	if (upd.day !== prev.day) changed = true;
	upd.level = prev.level;
	upd.exp = prev.exp;
	upd.skillPoint = prev.skillPoint;
	upd.bossKills = prev.bossKills;
	upd.day = prev.day;
	return changed;
}

// ---------------------------------------------------------------- ledgers

interface Contributor {
	slot: number;
	damage: number;
	/** `now` of the last hit that landed (assists expire, §3.6) */
	at: number;
	/** seconds spent close to the living boss (§3.6 participation) */
	near: number;
}

interface Ledger {
	total: number;
	/** by slot; at most MAX_PLAYERS entries, so a linear scan beats a Map here */
	by: Array<Contributor>;
}

function newLedger(): Ledger {
	return { total: 0, by: new Array<Contributor>() };
}

/** forgets one slot's share of a fight (its occupant left the world) */
function dropContributor(l: Ledger, slot: number): void {
	for (let i = l.by.size() - 1; i >= 0; i--) {
		const c = l.by[i];
		if (c.slot !== slot) continue;
		l.total = math.max(0, l.total - c.damage);
		l.by.remove(i);
	}
}

function contributor(l: Ledger, slot: number): Contributor {
	for (const c of l.by) {
		if (c.slot === slot) return c;
	}
	const c: Contributor = { slot, damage: 0, at: 0, near: 0 };
	l.by.push(c);
	return c;
}

/** what one survivor earned from one kill */
export interface ExpAward {
	slot: number;
	exp: number;
	/** levels gained by applying it (0 when the save was not reachable) */
	levels: number;
	/** this survivor struck the killing blow (§3.6: 100 %, against the assist's 60 %) */
	killer: boolean;
}

/** per-session counters the admin panel reads (§9.3) and the tests assert on */
export interface ProgressStats {
	kills: number;
	assists: number;
	bossKills: number;
	exp: number;
	/** coins this session paid for bosses (§3.6); the day's coins are paid by `creditDaySurvived` */
	coins: number;
}

export interface ProgressOptions {
	/** the live save of a slot, or undefined when that survivor already left (the XP is simply dropped) */
	saveOf: (slot: number) => PlayerSaveData | undefined;
	/**
	 * Whether this slot's run may earn coins (§9.3 "assisted run": an admin used world tools in it, so it
	 * keeps playing but stops paying). Defaults to yes — the ledger itself has no idea what an admin is.
	 */
	paysRewards?: (slot: number) => boolean;
}

export class Progress {
	private readonly saveOf: (slot: number) => PlayerSaveData | undefined;
	private readonly paysRewards: (slot: number) => boolean;
	private readonly zombies = new Map<number, Ledger>();
	private readonly bosses = new Map<number, Ledger>();
	private readonly stats = new Map<number, ProgressStats>();

	constructor(options: ProgressOptions) {
		this.saveOf = options.saveOf;
		this.paysRewards = options.paysRewards ?? (() => true);
	}

	// ---- zombies -----------------------------------------------------------------------------

	/** a survivor hurt this zombie; `now` is the server clock in seconds (the assist window, §3.6) */
	noteZombieDamage(zombieId: number, slot: number, amount: number, now: number): void {
		if (!isFiniteNumber(amount) || amount <= 0 || slot < 0) return;
		let l = this.zombies.get(zombieId);
		if (l === undefined) {
			l = newLedger();
			this.zombies.set(zombieId, l);
		}
		const c = contributor(l, slot);
		c.damage += amount;
		c.at = now;
		l.total += amount;
	}

	/**
	 * The zombie died: the killer takes the full `exp`, everyone else who hurt it inside ASSIST_WINDOW_S takes
	 * ASSIST_SHARE of it (§3.6, MP-15 "acaba com o roubo de abate"). The ledger is dropped, so a body can never
	 * pay twice — which also means 2A must call this exactly once per death, whatever killed it.
	 */
	zombieKilled(zombieId: number, exp: number, killerSlot: number, now: number): Array<ExpAward> {
		const l = this.zombies.get(zombieId);
		this.zombies.delete(zombieId);
		const out = new Array<ExpAward>();
		const base = isFiniteNumber(exp) && exp > 0 ? exp : 0;
		if (killerSlot >= 0) {
			out.push(this.pay(killerSlot, base, true));
			this.bump(killerSlot).kills += 1;
		}
		if (l !== undefined) {
			for (const c of l.by) {
				if (c.slot === killerSlot || now - c.at > ASSIST_WINDOW_S) continue;
				out.push(this.pay(c.slot, base * ASSIST_SHARE, false));
				this.bump(c.slot).assists += 1;
			}
		}
		return out;
	}

	/** the body left the world without dying (despawn, admin clear): forget it without paying anything */
	forgetZombie(zombieId: number): void {
		this.zombies.delete(zombieId);
	}

	// ---- bosses ------------------------------------------------------------------------------

	noteBossDamage(bossId: number, slot: number, amount: number, now: number): void {
		if (!isFiniteNumber(amount) || amount <= 0 || slot < 0) return;
		let l = this.bosses.get(bossId);
		if (l === undefined) {
			l = newLedger();
			this.bosses.set(bossId, l);
		}
		const c = contributor(l, slot);
		c.damage += amount;
		c.at = now;
		l.total += amount;
	}

	/** `dt` seconds spent within BOSS_NEAR_RANGE of this living boss (§3.6 second participation rule) */
	noteBossNear(bossId: number, slot: number, dt: number): void {
		if (!isFiniteNumber(dt) || dt <= 0 || slot < 0) return;
		let l = this.bosses.get(bossId);
		if (l === undefined) {
			l = newLedger();
			this.bosses.set(bossId, l);
		}
		contributor(l, slot).near += dt;
	}

	/**
	 * The boss went down: EVERY participant gets the full XP, +1 boss kill and the boss coins (§3.6 — the coins
	 * themselves are server/main.server.ts's, paid from `bossKills`). A participant either did ≥ 3 % of `hpMax`
	 * or stayed ≥ 20 s nearby while it lived.
	 */
	bossKilled(bossId: number, exp: number, hpMax: number, killerSlot: number): Array<ExpAward> {
		const l = this.bosses.get(bossId);
		this.bosses.delete(bossId);
		const out = new Array<ExpAward>();
		const base = isFiniteNumber(exp) && exp > 0 ? exp : 0;
		const need = isFiniteNumber(hpMax) && hpMax > 0 ? hpMax * BOSS_DAMAGE_SHARE : 0;
		let killerPaid = false;
		if (l !== undefined) {
			for (const c of l.by) {
				if (c.damage < need && c.near < BOSS_NEAR_S) continue;
				const isKiller = c.slot === killerSlot;
				killerPaid = killerPaid || isKiller;
				out.push(this.pay(c.slot, base, isKiller));
				this.creditBoss(c.slot);
			}
		}
		// the killing blow always counts, even from someone who only just arrived: they finished it
		if (killerSlot >= 0 && !killerPaid) {
			out.push(this.pay(killerSlot, base, true));
			this.creditBoss(killerSlot);
		}
		return out;
	}

	forgetBoss(bossId: number): void {
		this.bosses.delete(bossId);
	}

	// ---- session counters --------------------------------------------------------------------

	statsOf(slot: number): ProgressStats {
		return this.bump(slot);
	}

	/**
	 * The survivor left the world, and the slot is free for whoever enters next (§4.4: `freeSlot` hands out the
	 * lowest one). The ledgers are keyed by SLOT, so their share of every fight still going on has to go with
	 * them: before this only the counters were dropped, and a newcomer who took the slot inherited the leaver's
	 * boss participation — the XP, the boss kill and COINS_PER_BOSS — and any assist still inside its window.
	 */
	remove(slot: number): void {
		this.stats.delete(slot);
		for (const [, l] of this.zombies) dropContributor(l, slot);
		for (const [, l] of this.bosses) dropContributor(l, slot);
	}

	clear(): void {
		this.zombies.clear();
		this.bosses.clear();
		this.stats.clear();
	}

	// ---- internals ---------------------------------------------------------------------------

	private pay(slot: number, exp: number, killer: boolean): ExpAward {
		const amount = math.floor(exp);
		const save = this.saveOf(slot);
		const levels = save !== undefined ? awardExp(save, amount) : 0;
		if (save !== undefined) this.bump(slot).exp += amount;
		return { slot, exp: amount, levels, killer };
	}

	private creditBoss(slot: number): void {
		const save = this.saveOf(slot);
		const stats = this.bump(slot);
		if (save !== undefined) stats.coins += creditBossKill(save, this.paysRewards(slot));
		stats.bossKills += 1;
	}

	private bump(slot: number): ProgressStats {
		let s = this.stats.get(slot);
		if (s === undefined) {
			s = { kills: 0, assists: 0, bossKills: 0, exp: 0, coins: 0 };
			this.stats.set(slot, s);
		}
		return s;
	}
}
