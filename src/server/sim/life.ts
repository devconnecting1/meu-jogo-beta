/*
 * The survivor's BODY belongs to the server, in the world and out of it (docs/MULTIPLAYER.md §6.1, §7.1–§7.3,
 * §9.1; docs/DESIGN_RULES.md MP-21 as the owner rewrote it on 23 Sep 2026). SERVER ONLY.
 *
 * Why this file exists (security review, Sep 2026). Being in the world was the only thing that made a body the
 * server's: `LeaveWorld` dropped it and `EnterWorld` built a new one with `createPlayer` — full hp, a full stomach,
 * `dead: false`, a free magazine — at a safe spawn point, and a reconnect did the same. A survivor lying dead in the
 * street sent LeaveWorld + EnterWorld and walked away healed, which made the daybreak wait and the paid Rebirth
 * pointless; a living one used it as a free teleport, heal and reload. Nothing ever wrote `runOver`, and the v3
 * `runHp` / `runHunger` were read and written by nobody.
 *
 * The rules, all of them here:
 *
 *   1. ONE BODY PER USERID. A record lives while the player is connected and KEEP_AFTER_LEAVE_S (5 min, §7.2) after
 *      they disconnect. Out of the world it holds the body FROZEN exactly as it left — position, hp, hunger, buffs,
 *      magazine, dead or not. Leaving and coming back changes nothing.
 *   2. A NEW BODY COMES FROM THE SAVE. With no body on this server, entering builds one from the save: `runHp` /
 *      `runHunger` (0 = full, §6.1), the magazine paid out of the reserve (§7.1: "não de graça"), and DEAD when
 *      `runOver` says so — a death brought from another session waits for this world's daybreak.
 *   3. NO TELEPORT. A kept living body comes back where it left, not at a "safe" point: relocating it would be the
 *      free escape from a horde. Only a spot that has turned solid (a door, a wall) moves it, to the ring around it.
 *      §7.2's "if it is still safe" needs F4's 5 s leave channel to be fair; without the channel it is an exploit.
 *      A resumed body gets no spawn shield either, or cycling Leave/Enter would buy invulnerability.
 *   4. DEATH IS WRITTEN AT ONCE: `runOver = true` in the save the tick it happens, and the daybreak countdown starts.
 *      A client report can no longer move `runOver` (`stripClientLife`).
 *   5. THREE WAYS BACK UP, the same on every server kind (the owner's rule replaced MP-21's public/private split):
 *        daybreak   free, at 06:00 (`daybreakWaitSeconds`, never longer than one night);
 *        Rebirth    paid (`rebirthPrice(deathCount)`), and only for a death the SERVER decided;
 *        New game   a new LIFE (day 1, starter kit, MP-20), not a new body: it still waits for daybreak, or a
 *                   Rebirth. It is never a free revive.
 *   6. THE WORLD WIPE. When nobody is left alive, a WIPE_DECISION_S window opens. If it closes with nobody standing
 *      — or sooner, once every dead survivor has shown they will not pay (New game, Home, leaving the server) —
 *      `onWorldWiped` fires, once, and the world ENDS (MP-22, the owner's rule of 23 Sep 2026): server/net/mpHost.ts
 *      has server/sim/worldReset.ts build a new town from a new seed on day 1, and `restartWorld` below hands every
 *      survivor who fell with the old one a new life in it. A server whose survivors all died therefore never
 *      stays sterile (`rebuildClusters` skips the dead): it becomes a new world.
 *
 * Pure module: no Instances, no services, no os.clock. server/net/mpHost.ts feeds `step(dt)` from its Heartbeat and
 * maps Players to UserIds; tools/test-body.mjs drives the real host through its remotes.
 */
import { deathKindOf, deathWireOf } from "shared/data/deathCause";
import { rebirthPrice } from "shared/data/shop";
import { WEAPONS, WeaponDef, usesMagazine } from "shared/data/weapons";
import { PLAYER_RADIUS, circleBlocked } from "shared/game/physics";
import {
	PlayerState,
	createPlayer,
	damageIsServerOwned,
	weaponAmmoPool,
	weaponReserve,
	weaponSpendAmmo,
} from "shared/game/player";
import { PlayerSaveData, SAVE_LIMITS, ownsWeapon, resetRun } from "shared/game/save";
import { countLifeDeath } from "../save/achievements";
import type { ShopActionReason } from "shared/net/net";
import { LifeState } from "shared/net/protocol";
import { DAY_BREAK_HOUR, daybreakWaitSeconds, isNightAt } from "shared/sim/clock";
import { isFuelWeapon } from "./combat";
import { SPAWN_SHIELD_S, ServerPlayer, SpawnQuery, adoptSave, createServerPlayer, findSpawnPoint } from "./players";
import { canEscape } from "./enclosure";
import type { ServerSimulation } from "./simulation";
import * as Analytics from "../analytics/events";

/**
 * §7.2: "O estado de mundo fica 5 min em memória" after a disconnect (seconds).
 *
 * Everything a record holds lives only here, in THIS server's memory, and only this long — the new life a world that
 * ended owes an absent survivor (MP-22, `newLifeOwed`) included. Known limit, accepted for now (review of de4ba1e,
 * N3): a survivor who fell with a world, left during its window and comes back after this, or joins ANOTHER server,
 * finds only their save — dead, the old backpack and life day — and waits for that world's daybreak or pays a
 * Rebirth, like any other death they carried in. Hopping servers therefore dodges the new life (never a death: the
 * save still says dead). Closing it needs a world epoch in the save; nothing is persisted for it yet.
 */
export const KEEP_AFTER_LEAVE_S = 300;
/** spots `placeKept` asks for before it takes one as it comes: half near where the body was, half anywhere */
const KEPT_SPOT_TRIES = 8;
/**
 * The owner's rule (23 Sep 2026): once the last living survivor falls, how long the world waits for somebody to
 * pay a Rebirth before it counts as lost (seconds).
 */
export const WIPE_DECISION_S = 30;

/**
 * Does the SERVER decide who is dead? From the phase its combat takes the hp (MP_PHASE 2, §2.3) — below it every
 * client simulates its own death, reports it, and none of the rules here may overrule it.
 */
export function serverOwnsLife(): boolean {
	return damageIsServerOwned();
}

// ---------------------------------------------------------------- the body in the save (§6.1, §7.1)

/** the weapon the save equips, exactly as server/sim/combat.ts `weaponOf` resolves it */
function equippedWeapon(save: PlayerSaveData): WeaponDef {
	const id = save.equipWeapon;
	return id >= 0 && id < WEAPONS.size() && ownsWeapon(save, id) ? WEAPONS[id] : WEAPONS[0];
}

/**
 * The rounds in the magazine go back to their pool (§6.1: "Pente atual: volta para a reserva ao sair", the same
 * rule as a weapon switch in combat.ts). Admin free ammo never turns into real ammo; a fuel weapon's "magazine" is
 * only a gate (each shot burns fuel), so it has nothing to give back. Returns the rounds returned.
 *
 * Up to the save's ceiling (SAVE_LIMITS.AMMO_MAX, DESIGN_RULES ITM-07): a reserve at the ceiling takes back only what
 * fits. Past it the rounds used to be banked anyway and clamped away silently at the next load; now what is banked
 * is what the save can hold (review of 1186a83, L2).
 */
export function unloadMagazine(state: PlayerState, save: PlayerSaveData): number {
	const rt = state.weapon;
	const w = rt.pointer >= 0 && rt.pointer < WEAPONS.size() ? WEAPONS[rt.pointer] : undefined;
	const rounds = math.max(0, math.floor(rt.ammoCount));
	rt.ammoCount = 0;
	rt.reloading = false;
	rt.reloadCount = 0;
	if (w === undefined || !usesMagazine(w) || isFuelWeapon(w) || rounds <= 0 || state.infiniteAmmo === true) return 0;
	const back = math.min(rounds, math.max(0, SAVE_LIMITS.AMMO_MAX - weaponAmmoPool(save, w.ammoPool)));
	if (back > 0) weaponSpendAmmo(save, w.ammoPool, -back);
	return back;
}

/**
 * The admin switches of §10 (god mode, noclip, infinite ammo) off a body. They belong to the PERSON, not to a body:
 * server/admin/adminWorld.ts holds them by UserId and puts them back on whatever body that person has, every tick, for
 * as long as they are on. Left on a KEPT body they outlived a switch turned off from the lobby, or the admin's whole
 * session, and that run paid (the review of 8f50bc5, HIGH-1). An infinite-ammo magazine never becomes real rounds:
 * emptied here with nothing back, before the flag that keeps `unloadMagazine` from refunding it is gone.
 */
export function stripAdminMods(state: PlayerState): void {
	if (state.infiniteAmmo === true) {
		const rt = state.weapon;
		rt.ammoCount = 0;
		rt.reloading = false;
		rt.reloadCount = 0;
	}
	state.godMode = false;
	state.noclip = false;
	state.infiniteAmmo = false;
}

/**
 * Loads the weapon the save equips, paying every round out of the reserve (§7.1: a body is never handed a free
 * magazine). Returns the rounds taken from the reserve.
 */
export function loadMagazine(state: PlayerState, save: PlayerSaveData): number {
	const w = equippedWeapon(save);
	const rt = state.weapon;
	rt.pointer = w.id;
	rt.reloading = false;
	rt.reloadCount = 0;
	rt.reloadTotal = 0;
	if (!usesMagazine(w)) {
		// melee and the draw-bows: the field means nothing to the server (createPlayer's value)
		rt.ammoCount = w.mag;
		return 0;
	}
	if (isFuelWeapon(w)) {
		// the flamethrower and the stun gun burn fuel per shot; their magazine is free while there is fuel
		rt.ammoCount = weaponReserve(save, w) >= 1 ? w.mag : 0;
		return 0;
	}
	const have = math.clamp(math.floor(rt.ammoCount), 0, w.mag);
	const take = math.min(w.mag - have, math.max(0, math.floor(weaponReserve(save, w))));
	rt.ammoCount = have + take;
	weaponSpendAmmo(save, w.ammoPool, take);
	return take;
}

/**
 * A kept body still holds the weapon it left with. If the save now equips another one (changed from the lobby),
 * the old magazine goes back to its own pool and the new weapon comes in EMPTY, exactly like a switch in combat.ts:
 * a magazine filled from one pool must never walk back in as another weapon's rounds.
 */
function matchWeapon(state: PlayerState, save: PlayerSaveData): void {
	const w = equippedWeapon(save);
	if (state.weapon.pointer === w.id) return;
	unloadMagazine(state, save);
	state.weapon.pointer = w.id;
}

/** v3 run body → a body (§6.1): 0 hp means "not recorded" and stays full; hunger is stored as what was EATEN AWAY */
export function readRunBody(p: PlayerState, save: PlayerSaveData): void {
	if (save.runHp > 0) p.hp = math.clamp(save.runHp, 1, p.hpMax);
	p.hungry = math.clamp(p.hungryMax - save.runHunger, 0, p.hungryMax);
}

/**
 * A body → the v3 run body and `runOver` (§6.1, §7.2). The rounding never favours the player: hp is floored and
 * the hunger eaten away is ceiled. A dead body records nothing (its next body is a revive, which is full) — and a
 * body at 0 hp IS dead even before the next `stepPlayer` flags it: a bite lands in the horde's half of a tick and
 * the death is only noticed in the next one, so without this a disconnect in between saved it as alive at 1 hp.
 * Returns whether the save changed.
 */
export function writeRunBody(save: PlayerSaveData, p: PlayerState): boolean {
	const dead = p.dead || p.hp <= 0;
	const hp = dead ? 0 : math.clamp(math.floor(p.hp), 1, SAVE_LIMITS.RUN_HP_MAX);
	const eaten = dead ? 0 : math.clamp(math.ceil(p.hungryMax - p.hungry), 0, SAVE_LIMITS.RUN_HUNGER_MAX);
	const changed = save.runHp !== hp || save.runHunger !== eaten || save.runOver !== dead;
	save.runHp = hp;
	save.runHunger = eaten;
	save.runOver = dead;
	return changed;
}

/**
 * A body built from the save alone (§7.1 step 5). `full` is a revive (daybreak, Rebirth): full hp and hunger, not
 * the recorded ones. Below MP_PHASE 2 this is today's `createPlayer`, untouched: the client owns hp and ammo there.
 */
export function freshBody(save: PlayerSaveData, x: number, y: number, full: boolean): PlayerState {
	const p = createPlayer(save, x, y);
	if (!serverOwnsLife()) return p;
	// createPlayer hands out a full magazine for nothing: take it back and pay for it
	p.weapon.ammoCount = 0;
	loadMagazine(p, save);
	if (!full) readRunBody(p, save);
	return p;
}

/**
 * A client report may mirror the run's death, never move it (§8.3): from MP_PHASE 2 the server killed the survivor
 * itself, and `runOver = false` in a SaveRequest was a one-line revive. Pins it to the trusted copy and answers
 * whether the report had tried (a staleness signal for the admin panel, §9.3). `runHp` / `runHunger` are pinned by
 * `sanitizeClientReport` already; they are pinned here again so the body's three fields have one guard in one
 * place. The inventory in the same report is F3's (phase 3) to take away; this touches the life and nothing else.
 */
export function stripClientLife(prev: PlayerSaveData, upd: PlayerSaveData): boolean {
	if (!serverOwnsLife()) return false;
	// what counts as an attempt is the one thing a report could want from these: `runOver: false` over a death. The
	// hp and hunger are pinned in silence -- the client is never sent the ones the server banks (an autosave writes
	// them), so an honest report carries old values every time and would be "stale" on every report (review #10)
	const changed = prev.runOver && !upd.runOver;
	upd.runOver = prev.runOver;
	upd.runHp = prev.runHp;
	upd.runHunger = prev.runHunger;
	return changed;
}

/**
 * Why the economy refuses a Rebirth or a New game, or undefined when it may go ahead (server/main.server.ts
 * `handleAction`). `dead` is the SERVER's answer (`LifeKeeper.isDead`), taken BEFORE anything is reset.
 *
 *   - "outdated": the request names a run the session has already moved past (idempotent by `runRev`);
 *   - "invalid":  the survivor is alive. A Rebirth of a living body is a heal and a teleport for coins, and a New
 *                 game of one is the same for free — neither is a thing the official client ever asks for;
 *   - "funds":    a Rebirth the wallet cannot pay. `free` is a survivor whose daybreak already came while they were
 *                 in the lobby (`LifeKeeper.daybreakDue`): standing them up costs nothing, so nothing is charged.
 *
 * On every server kind: the owner's rule of 23 Sep 2026 made the paid Rebirth legal on public servers too (it had
 * been refused there since 63f8458), and the daybreak wait legal on private ones.
 */
export function runActionRefusal(
	kind: "rebirth" | "newRun",
	save: PlayerSaveData,
	runRev: unknown,
	dead: boolean,
	free = false,
): ShopActionReason | undefined {
	if (runRev !== save.runRev) return "outdated";
	if (serverOwnsLife() && !dead) return "invalid";
	if (kind === "rebirth" && !free && save.money < rebirthPrice(save.deathCount)) return "funds";
	return undefined;
}

// ---------------------------------------------------------------- the keeper

/** what the keeper needs from server/net/replication.ts */
export interface LifeWire {
	/** InitBegin, the clock and the roster for a survivor entering the world — life states of the fallen included */
	welcome(sp: ServerPlayer): void;
	left(slot: number): void;
	/** a reliable PlayerLife delta (§4.5) */
	life(slot: number, state: number): void;
	/**
	 * UI-13: why the survivor in `slot` died, to them alone (`Announce{Died}`, protocol note 24; `arg` is
	 * shared/data/deathCause.ts `deathWireOf`). Optional: a keeper wired to no client (a test) has nobody to tell.
	 */
	died?(slot: number, arg: number): void;
}

/** what `onWorldWiped` is told */
export interface WipeReport {
	/** the world's day on which it was lost */
	day: number;
	/**
	 * "timeout": the window closed with nobody standing; "declined": every dead survivor chose not to pay; "restart":
	 * the private server's keeper (its owner, or an admin on it) asked for a new town (MP-26): EVERY life of this town
	 * ends, standing or down (`survivorsNow` below, read again when the new town is committed)
	 */
	reason: "timeout" | "declined" | "restart";
	/**
	 * the UserIds of the dead the window waited on; a restart: every survivor of the town, as the host saw them when it
	 * was asked -- server/sim/worldReset.ts reads the list again at the commit (review of 0b44458, L1)
	 */
	dead: Array<number>;
	/** "restart" only: the UserId of who asked for it */
	by?: number;
}

/**
 * why a body stood back up ("newWorld": the world ended and a new life began in the next one, MP-22; "reset": an admin
 * reset the save, and the body that belonged to the old one is gone with it)
 */
export type StandReason = "daybreak" | "rebirth" | "newWorld" | "reset";

interface LifeRecord {
	userId: number;
	/** the live save table last seen for this survivor (the session's, server/main.server.ts) */
	save?: PlayerSaveData;
	/** in the world right now, in this slot */
	slot?: number;
	/** out of the world: the body as it left, frozen; undefined = a fresh one is built from the save on entry */
	body?: PlayerState;
	/** dead as far as the server knows (in the world `sp.state.dead` is the truth, and this follows it) */
	dead: boolean;
	/** the next fresh LIVING body is a revive (a Rebirth bought from the lobby): full, not `runHp` */
	fullNext: boolean;
	/** real seconds until daybreak stands this body up; ≤ 0 = due (out of the world it stands up on entry) */
	downFor?: number;
	/** this dead survivor has shown they will not pay (New game, Home, leaving): the wipe window need not wait */
	declined: boolean;
	/** real seconds since the player left the SERVER; undefined while connected (§7.2) */
	goneFor?: number;
	/** the magazine already went back to the reserve (the player left the server, §7.2) */
	unloaded: boolean;
	/** had a body in THIS world at some point: only those are its survivors when rule 6 counts the fallen */
	entered: boolean;
	/** what the departure wrote into the save, to tell on reconnect whether the save moved elsewhere meanwhile */
	banked?: BankedBody;
	/**
	 * MP-22: this survivor fell with a world that ended while they were NOT here with a loaded save — away from the
	 * server, or back and still loading — so the new life everybody else got is owed to them. It is granted the
	 * first time their loaded save comes back (`recordFor`), and ONLY against a departure it can be checked with:
	 * the save must still be exactly what their leaving banked (`reconcile`). No departure to compare with, or a
	 * save that moved on elsewhere meanwhile, and the debt is dropped: that save decides. It lives as long as the
	 * record does (KEEP_AFTER_LEAVE_S, and see N3 there). Review of f851ad2, B1 and M1: the reset used to write the
	 * new life into the CLOSED session's table and forget the record, and the fresh load came back with the old
	 * backpack. Review of de4ba1e, N1: granted without a departure, it reset a REAL save that had never been part
	 * of this world — a read-only session's death on a blank save became the real save's life day 1.
	 */
	newLifeOwed: boolean;
	/**
	 * Rule 6, decided at the departure (review of 577c729, L2 and L3): this survivor left the SERVER dead while nobody
	 * in the world was alive -- the world was already lost, whether or not the window had opened yet (a death and a
	 * departure in the same heartbeat). Leaving is declining (MP-22), so they still count among its fallen after they
	 * are gone. Cleared the moment somebody stands again: a later fall is a new one, and a death left behind while
	 * somebody still stood was only a departure.
	 */
	leftWhileLost: boolean;
	/**
	 * UI-13: the `Announce{Died}` arg of this survivor's last death (shared/data/deathCause.ts `deathWireOf`), told
	 * again whenever they come back to the world still dead (`enter`); forgotten when they stand up. Undefined: none
	 * known (a death this server did not see, one carried in over from another session's save).
	 */
	lastDeath?: number;
}

/** the v3 run body as the last departure wrote it (§7.2) */
interface BankedBody {
	runHp: number;
	runHunger: number;
	runOver: boolean;
	runRev: number;
}

export class LifeKeeper {
	/** rule 6: the world is lost. The ONE place the reset to day 1 plugs in (server/net/mpHost.ts, MP-22) */
	onWorldWiped?: (report: WipeReport) => void;
	/** the server just wrote into this survivor's save (death, stand-up, the body banked): persist it */
	onSaveChanged?: (userId: number) => void;
	/** a body stood back up (for the host's log and the tests) */
	onStandUp?: (sp: ServerPlayer, why: StandReason) => void;
	/**
	 * The live, LOADED save of a connected survivor by UserId — the session's (server/net/mpHost.ts) — or undefined
	 * while it is still loading. Rule 6 counts only survivors whose save is really here: behind a reconnect that is
	 * still loading there is nothing but the CLOSED session's table (review of f851ad2, B1). Unset (a pure test):
	 * every record's own last save counts, as before.
	 */
	liveSave?: (userId: number) => PlayerSaveData | undefined;
	/**
	 * How many players are connected to the SERVER right now with their save loaded, in the world or not
	 * (server/net/mpHost.ts: its links). A world lost by the departures of its dead ends only while somebody is here to
	 * see it (review of 577c729, L1): an empty server keeps it lost, and the next player whose save loads ends it before
	 * they can enter it. Unset (a pure test): the records of the players still connected.
	 */
	connected?: () => number;

	private readonly sim: ServerSimulation;
	private readonly wire: LifeWire;
	private readonly records = new Map<number, LifeRecord>();
	/** seconds left in the decision window of rule 6, or undefined while it is closed */
	private wipeIn?: number;
	/** the hook already fired for this fall; re-armed once somebody is standing again */
	private wiped = false;
	/**
	 * The world was left lost by a departure (`leftWhileLost`), and nobody has stood in it since: it ends at the next
	 * step with a player connected -- even once the records of those who left have expired (KEEP_AFTER_LEAVE_S), so a
	 * server that outlives five empty minutes does not open its lost world to the next arrival (L1).
	 */
	private lostByLeaving = false;

	constructor(sim: ServerSimulation, wire: LifeWire) {
		this.sim = sim;
		this.wire = wire;
		// the ping the rewind ceiling filters is kept exactly as long as the body is (ServerSimulation.setPing)
		sim.bodyKept = userId => this.records.has(userId);
	}

	// ------------------------------------------------------------ queries

	/** dead as far as the SERVER knows: in the world, out of it, or — seen for the first time — as the save says */
	isDead(userId: number, save: PlayerSaveData): boolean {
		const rec = this.recordFor(userId, save);
		const sp = this.inWorld(rec);
		return sp !== undefined ? sp.state.dead : rec.dead;
	}

	/** the body kept for a survivor who is out of the world (tests, admin), or undefined */
	keptBody(userId: number): PlayerState | undefined {
		return this.records.get(userId)?.body;
	}

	/** real seconds until daybreak stands this survivor up, or undefined when they are not waiting for it */
	daybreakIn(userId: number): number | undefined {
		return this.records.get(userId)?.downFor;
	}

	/**
	 * Dead, out of the world, and their daybreak already came: the next entry stands them up for free. A Rebirth asked
	 * from the lobby in that state must not be charged for it (server/main.server.ts passes `free`).
	 */
	daybreakDue(userId: number, save: PlayerSaveData): boolean {
		const rec = this.recordFor(userId, save);
		return this.inWorld(rec) === undefined && rec.dead && rec.downFor !== undefined && rec.downFor <= 0;
	}

	/** is the rule-6 decision window open right now (tests, admin) */
	wipeWindowOpen(): boolean {
		return this.wipeIn !== undefined;
	}

	// ------------------------------------------------------------ presence (§7.1, §7.2)

	/** the player (re)joined the server: a record kept from a disconnect stops expiring (§7.2) */
	connect(userId: number): void {
		const rec = this.records.get(userId);
		if (rec === undefined) return;
		rec.goneFor = undefined;
		// here again: counted by what they are now (dead and declined), not by how they left
		rec.leftWhileLost = false;
	}

	/**
	 * §7.1: put this survivor in the world — the kept body when there is one (rule 1), a fresh one from the save
	 * otherwise (rule 2). Undefined when every slot is taken. Already in the world: the body that is there.
	 */
	enter(info: { userId: number; name: string }, save: PlayerSaveData): ServerPlayer | undefined {
		const sim = this.sim;
		const rec = this.recordFor(info.userId, save);
		const already = this.inWorld(rec);
		if (already !== undefined) return already;
		const slot = sim.freeSlot();
		if (slot === undefined) return undefined;
		rec.goneFor = undefined;
		const owns = serverOwnsLife();
		let state = rec.body;
		// a daybreak that came while the survivor was away stands them up now, as it would have in the street
		if (rec.dead && rec.downFor !== undefined && rec.downFor <= 0) {
			if (state !== undefined && owns && !rec.unloaded) unloadMagazine(state, save);
			state = undefined;
			rec.dead = false;
			rec.lastDeath = undefined;
			rec.downFor = undefined;
			rec.fullNext = true;
		}
		const resumed = state !== undefined;
		if (state === undefined) {
			const spawn = findSpawnPoint(sim.world, this.spawnQuery(-1));
			state = freshBody(save, spawn.x, spawn.y, rec.fullNext);
			if (rec.dead) {
				// a corpse carries no loaded magazine: the rounds stay in the reserve for the body that stands up
				if (owns) unloadMagazine(state, save);
				state.dead = true;
				state.hp = 0;
			} else {
				rec.fullNext = false;
			}
		} else if (!state.dead) {
			this.placeKept(state);
			if (owns && rec.unloaded) loadMagazine(state, save);
			else if (owns) matchWeapon(state, save);
		} else if (owns) {
			// a kept corpse: its rounds go back to their OWN pool now and it holds the weapon the save equips, or the
			// combat's first-tick adoption would hand the old magazine to a new weapon and the stand-up would refund it
			// into the wrong pool
			if (!rec.unloaded) unloadMagazine(state, save);
			state.weapon.pointer = equippedWeapon(save).id;
		}
		rec.body = undefined;
		rec.unloaded = false;
		// ITM-06: the hands are the session's and never kept: a survivor back in the world, kept body or not, stands with
		// the weapon drawn
		state.holstered = undefined;
		const sp = createServerPlayer(
			{ slot, userId: info.userId, name: info.name },
			save,
			state.x,
			state.y,
			sim.tick,
			sim.simHz,
		);
		sp.state = state;
		// rule 3: a resumed body was never away from the danger it left, so it is not shielded from it either
		if (resumed) sp.spawnShieldUntil = sim.tick;
		sim.add(sp);
		rec.slot = slot;
		rec.save = save;
		rec.entered = true;
		rec.dead = state.dead;
		// back in the street to wait: the wipe window counts on them again
		if (state.dead) rec.declined = false;
		if (owns) save.runOver = state.dead;
		this.wire.welcome(sp);
		// UI-13: back in the street to wait, the death screen still says why -- after the welcome's own PlayerLife Dead,
		// on the same directed, ordered channel (the review of ca9494a, L3)
		if (state.dead && rec.lastDeath !== undefined) this.wire.died?.(slot, rec.lastDeath);
		return sp;
	}

	/** §7.2 "Ir ao lobby": the body leaves the world and is kept, frozen, exactly as it was (rule 1) */
	leave(userId: number): void {
		const rec = this.records.get(userId);
		if (rec === undefined || rec.slot === undefined) return;
		const slot = rec.slot;
		const sp = this.sim.get(slot);
		if (sp !== undefined) this.lethal(sp);
		rec.slot = undefined;
		if (sp !== undefined) {
			// the admin switches are the person's, never the kept body's (`stripAdminMods`): back on the next entry while
			// they are still on, and gone with the session otherwise
			stripAdminMods(sp.state);
			rec.body = sp.state;
			rec.dead = sp.state.dead;
			rec.save = sp.save;
			// so an autosave carries the body even if the player never comes back
			if (serverOwnsLife() && writeRunBody(sp.save, sp.state)) this.onSaveChanged?.(userId);
		}
		// Home while dead: the wipe window does not wait for somebody who walked away (rule 6)
		if (rec.dead) rec.declined = true;
		this.sim.remove(slot);
		this.wire.left(slot);
	}

	/**
	 * The player is leaving the SERVER (§7.2 "Desconectar"): out of the world, and the body banked into the save —
	 * `runHp`, `runHunger`, `runOver`, and the magazine back into the reserve. The record stays KEEP_AFTER_LEAVE_S
	 * for a reconnect. Idempotent: server/main.server.ts calls it before its final flush, and mpHost's own
	 * PlayerRemoving handler calls it too, in whichever order Roblox fires them.
	 */
	disconnect(userId: number, save?: PlayerSaveData): void {
		if (!this.records.has(userId)) return;
		// through `recordFor`, never straight onto `rec.save`: a player who reconnected with a save that moved on
		// another server must have it reconciled BEFORE anything kept here is banked over it
		const rec = this.recordFor(userId, save);
		this.leave(userId);
		const leaving = rec.goneFor === undefined;
		if (leaving) rec.goneFor = 0;
		if (rec.dead) rec.declined = true;
		// rule 6, decided now (L2, L3): dead, and nobody left standing in the world -- the fall is theirs to share
		if (leaving && rec.dead && rec.entered && this.standing(userId) === 0) {
			rec.leftWhileLost = true;
			this.lostByLeaving = true;
		}
		this.bank(rec);
	}

	/**
	 * The body IN THE WORLD into its save, without moving it or touching the magazine (the autosave, §7.2). A kept
	 * body was written when it left, and writing it again could only overwrite a save that has moved on since.
	 * Returns whether the save changed.
	 */
	settle(userId: number, save: PlayerSaveData): boolean {
		if (!serverOwnsLife() || !this.records.has(userId)) return false;
		const sp = this.inWorld(this.recordFor(userId, save));
		if (sp === undefined) return false;
		this.lethal(sp);
		return writeRunBody(save, sp.state);
	}

	// ------------------------------------------------------------ death and the three ways back up

	/** the simulation killed this survivor (rule 4) */
	died(sp: ServerPlayer): void {
		const rec = this.recordFor(sp.userId, sp.save);
		rec.dead = true;
		rec.declined = false;
		rec.downFor = daybreakWaitSeconds(this.sim.clock.dayTime);
		// A construction still on the cursor comes off it here: the kit is in the dying run's backpack (ITM-09), which
		// the body keeps through the death, the daybreak and a Rebirth (MP-21; nothing else in the backpack is lost to
		// a death either), and a New game wipes it with the rest of that run -- it never lands in the new life (R1)
		this.sim.build?.cancel(sp.slot);
		if (serverOwnsLife()) {
			// EVERY death of this life, whatever answers it (CON-04: Never die; `deathCount` only counts paid Rebirths)
			countLifeDeath(sp.save);
			writeRunBody(sp.save, sp.state);
			this.onSaveChanged?.(sp.userId);
		}
		this.wire.life(sp.slot, LifeState.Dead);
		// the body and the bosses standing are what the cause is read from (hunger, poison, a boss, the horde): the
		// dead survivor is told (UI-13, their death screen teaches), and the dashboard counts it -- one rule for both
		const bosses = this.sim.horde?.bossRoster.list;
		const dayTime = this.sim.clock.dayTime;
		const arg = deathWireOf(deathKindOf(sp.state, bosses), isNightAt(dayTime));
		// kept with the record, so a survivor who comes back to this death (Home and PLAY, a reconnect) hears it again
		rec.lastDeath = arg;
		if (arg !== undefined) this.wire.died?.(sp.slot, arg);
		Analytics.death(sp.save, dayTime, this.sim.count(), sp.state, bosses);
	}

	/**
	 * A Rebirth the economy accepted and charged (rule 5): up NOW if the body is in the world — a fresh, full body at
	 * a safe point, like any revive — or on the next entry if the survivor bought it from the lobby.
	 */
	rebirth(userId: number, save: PlayerSaveData): void {
		const rec = this.recordFor(userId, save);
		const sp = this.inWorld(rec);
		if (sp !== undefined) {
			this.standUp(rec, sp, "rebirth");
			return;
		}
		if (rec.body !== undefined && !rec.unloaded && serverOwnsLife()) unloadMagazine(rec.body, save);
		rec.body = undefined;
		rec.unloaded = false;
		rec.dead = false;
		rec.lastDeath = undefined;
		rec.downFor = undefined;
		rec.declined = false;
		rec.fullNext = true;
		if (serverOwnsLife()) {
			save.runOver = false;
			save.runHp = 0;
			save.runHunger = 0;
		}
	}

	/**
	 * A New game the economy accepted, AFTER `resetRun`: a new LIFE (day 1, the starter kit, MP-20) — but the death
	 * stands. The body still waits for daybreak, or for a Rebirth (rule 5; the owner's rule 4 of 23 Sep 2026: it
	 * must never become a free revive). The fallen body's rounds die with the old run: they are not the new life's.
	 */
	newLife(userId: number, save: PlayerSaveData): void {
		const rec = this.recordFor(userId, save);
		const sp = this.inWorld(rec);
		// the caller asked `runActionRefusal` first, so a living body never gets here (nor anything below MP_PHASE 2)
		if (!(sp !== undefined ? sp.state.dead : rec.dead)) return;
		rec.declined = true;
		if (sp !== undefined) {
			sp.state.weapon.ammoCount = 0;
			// the old run's construction is not the new life's (review R1): off the cursor, the kit wiped with that run
			this.sim.build?.drop(sp.slot);
		} else {
			rec.body = undefined;
			rec.unloaded = false;
		}
		rec.dead = true;
		if (rec.downFor === undefined) rec.downFor = daybreakWaitSeconds(this.sim.clock.dayTime);
		if (serverOwnsLife()) {
			// resetRun cleared these; the death is not over, and the save must say so (a reconnect reads it)
			save.runOver = true;
			save.runHp = 0;
			save.runHunger = 0;
		}
		this.onSaveChanged?.(userId);
	}

	/**
	 * Once per heartbeat, in the same real seconds the simulation just ran: the daybreak countdowns (rule 5), the
	 * 5 min memory of §7.2, and the wipe window (rule 6).
	 */
	step(dt: number): void {
		if (!(dt > 0)) return;
		for (const [userId, rec] of this.records) {
			if (rec.goneFor !== undefined) {
				rec.goneFor += dt;
				if (rec.goneFor >= KEEP_AFTER_LEAVE_S) {
					this.records.delete(userId);
					this.sim.forgetPing(userId);
					continue;
				}
			}
			const left = rec.downFor;
			if (left === undefined) continue;
			rec.downFor = math.max(0, left - dt);
			if (rec.downFor > 0) continue;
			const sp = this.inWorld(rec);
			// out of the world the stand-up waits for the entry: the lobby's copy of the save still says "game over",
			// and a body raised behind its back would leave both Rebirth and New game refusing ("you are alive")
			if (sp !== undefined && sp.state.dead) this.standUp(rec, sp, "daybreak");
		}
		this.stepWipe(dt);
	}

	// ------------------------------------------------------------ the admin (docs/MULTIPLAYER.md §10)

	/**
	 * An admin reset this survivor's save to a new player's (server/main.server.ts `adminEdit`), IN PLACE: the session
	 * keeps one table for its whole life, so `recordFor` sees the same save and would never notice (BUG-1 of the admin
	 * audit, 2026-09-24). Everything this record kept belonged to the save that is gone: the body out of the world and
	 * its magazine, a death and its daybreak wait, the departure banked, a new life a world owed. Kept, the old body was
	 * written back into the reset save on the way out, resumed on the next entry, and its magazine refunded into the new
	 * reserve by `matchWeapon`.
	 *
	 * So the record starts over from the reset save. A body IN the world is replaced now by a fresh one from that save
	 * at a safe point (rule 2: its magazine is paid out of the NEW reserve, and the old one is dropped, never refunded),
	 * and whatever the old run had on the cursor goes with it. The admin switches (§10) belong to the person and are
	 * put back on the new body by the simulation (`adminMods`). Returns whether a body was replaced.
	 */
	resetLife(userId: number, save: PlayerSaveData): boolean {
		const rec = this.records.get(userId);
		if (rec === undefined) return false;
		rec.save = save;
		rec.body = undefined;
		rec.unloaded = false;
		rec.dead = false;
		rec.lastDeath = undefined;
		rec.downFor = undefined;
		rec.declined = false;
		rec.fullNext = false;
		rec.newLifeOwed = false;
		rec.banked = undefined;
		const sp = this.inWorld(rec);
		if (sp === undefined) return false;
		const sim = this.sim;
		adoptSave(sp, save);
		// the old run's construction is not the new save's (review R1): off the cursor, the kit wiped with that run
		sim.build?.drop(sp.slot);
		// the old body's magazine was the old save's rounds: they die with it
		sp.state.weapon.ammoCount = 0;
		// ...and the weapon machine forgets the old weapon, or its switch to the new save's would pay that magazine back
		sim.combat?.remove(sp.slot);
		const spawn = findSpawnPoint(sim.world, this.spawnQuery(sp.slot));
		sp.state = freshBody(save, spawn.x, spawn.y, true);
		sp.spawnShieldUntil = sim.tick + math.floor(SPAWN_SHIELD_S * sim.simHz);
		if (serverOwnsLife()) writeRunBody(save, sp.state);
		this.wire.life(sp.slot, LifeState.Up);
		this.onSaveChanged?.(userId);
		this.onStandUp?.(sp, "reset");
		return true;
	}

	/**
	 * An admin moved the world's clock (§10): a dead survivor's wait for daybreak is counted again from the new hour,
	 * so "Night" does not stand them up in the middle of it. A clock set into the daybreak hour itself (06:00-07:00:
	 * "Dawn" lands on 06:59) IS the daybreak: they stand up now -- counted from the hour, the next 06:00 was a whole
	 * day away, and Dawn made the dead wait longer (the review of 8f50bc5, MEDIUM-3).
	 */
	clockMoved(): void {
		const dayTime = this.sim.clock.dayTime;
		const daybreak = dayTime >= DAY_BREAK_HOUR && dayTime < DAY_BREAK_HOUR + 1;
		for (const [, rec] of this.records) {
			if (!rec.dead || rec.downFor === undefined || rec.downFor <= 0) continue;
			rec.downFor = daybreak ? 0 : daybreakWaitSeconds(dayTime);
		}
	}

	// ------------------------------------------------------------ the world ends (rule 6, MP-22)

	/**
	 * Which of `dead` (a WipeReport's) will `restartWorld` give a new life: the ones this keeper still holds, on this
	 * server. Asked BEFORE the restart, so the clients can be told who they are before the first body stands up.
	 */
	fallenOf(dead: ReadonlyArray<number>, saveOf: (userId: number) => PlayerSaveData | undefined): Array<number> {
		const out = new Array<number>();
		for (const userId of dead) {
			const rec = this.records.get(userId);
			// only a survivor whose LOADED save is here now: anyone else is owed the new life instead (B1)
			if (rec === undefined || rec.goneFor !== undefined || saveOf(userId) === undefined) continue;
			if (!out.includes(userId)) out.push(userId);
		}
		return out;
	}

	/**
	 * MP-22: the world ended, and the simulation already stands in a new town (server/sim/worldReset.ts). No body
	 * outlives the streets it stood in:
	 *
	 *   - `fallen` (from `fallenOf`), the survivors whose deaths ended it and whose loaded save is here, start a NEW
	 *     LIFE — the reset New game gives (`resetRun`: day 1, the starter kit; level, skills, coins, packs and
	 *     costumes stay, MP-20) — and are alive again: in the world, a fresh, full body at a safe point of the new
	 *     town with the 3 s shield (MP-04), the first one anywhere and the rest around them; in the lobby, the next
	 *     entry builds one. `runRev` moves on, so a report captured in the old life is refused as outdated;
	 *   - a survivor who fell with this world but is not here with a loaded save — gone from the server during the
	 *     window, or back and still loading — is OWED that new life (`newLifeOwed`), granted when their save loads if
	 *     it is still what their departure banked (N1; see `newLifeOwed`, and N3 at KEEP_AFTER_LEAVE_S).
	 *     Leaving is not a way out of the reset (MP-21: leaving never buys anything a death costs; review M1), and
	 *     nothing is ever written into a CLOSED session's table (review B1);
	 *   - anybody else keeps their LIFE but not their body: the spot it stood on belongs to a town that no longer
	 *     exists, so a kept body goes into the loaded save (or already went into the save it left with) and the next
	 *     entry rebuilds it (rule 2); one in the world (never the case at a wipe, where nobody is standing) is moved
	 *     to a safe point as it is. What a departure banked stays, so a reconnect is still reconciled.
	 *
	 * `saveOf` is the session's live, loaded save of a connected player (undefined while loading), the table to reset.
	 *
	 * Two things a reader should know (review of f851ad2, L6):
	 *   - the "keeps their life" branch never has a LIVING body to handle at a wipe: a kept body that is alive counts
	 *     as alive for rule 6 and stops the wipe, so its banking and `moveKept` do not run today. They stay so that
	 *     `restartWorld` is right for any record whatever calls it, instead of trusting that only a wipe ever will;
	 *   - after the reset, everybody out of the world (the fallen in the lobby with their new life among them) is
	 *     `entered = false`, so rule 6 does not count them until they walk into the NEW town. Before the reset, a
	 *     living survivor in the lobby who had entered the old town held the world up; now a lone survivor who enters
	 *     the new town and dies ends it, whoever is still in the lobby. Deliberate: nobody is a survivor of a town
	 *     they have not set foot in (the same as a player who joins and never enters).
	 */
	restartWorld(
		fallen: ReadonlyArray<number>,
		saveOf: (userId: number) => PlayerSaveData | undefined,
		everyone = false,
	): void {
		const owns = serverOwnsLife();
		const reborn = new Set<number>();
		for (const userId of fallen) reborn.add(userId);
		const place = new Array<LifeRecord>();
		for (const [userId, rec] of this.records) {
			const save = rec.goneFor === undefined ? saveOf(userId) : undefined;
			// through `recordFor`, like every other entry point: a save that moved on elsewhere is reconciled first
			if (save !== undefined) this.recordFor(userId, save);
			const sp = this.inWorld(rec);
			// the table the session holds NOW is the one to reset (mpHost's admit pass would adopt it anyway)
			if (sp !== undefined && save !== undefined) adoptSave(sp, save);
			if (reborn.has(userId) && save !== undefined) {
				// the old life's rounds died with it: nothing in the fallen body goes back into the new reserve
				if (owns && sp !== undefined) sp.state.weapon.ammoCount = 0;
				this.grantNewLife(rec, save);
			} else {
				// MP-26's restart ends EVERY life of the town (`everyone`), not only the fallen's: a survivor who is away
				// (or still loading) is owed the new life too, granted when their save is back (as MP-22's fallen are)
				if ((rec.dead || everyone) && rec.entered && sp === undefined && save === undefined) {
					rec.newLifeOwed = true;
				}
				// unreachable at a wipe for a living body (L6 above): kept for any other caller. With no loaded save
				// the body is dropped with nothing written, magazine included (review of de4ba1e, N4): the only save
				// that can be loading is a reconnect's, whose departure already put the rounds back into it (`bank`),
				// or a retry's after a read-only session, whose blank table was never anybody's (`forgetUnsaved`)
				if (sp === undefined && rec.body !== undefined && save !== undefined && owns) {
					if (!rec.unloaded) unloadMagazine(rec.body, save);
					if (writeRunBody(save, rec.body)) this.onSaveChanged?.(userId);
				}
				rec.body = undefined;
				rec.unloaded = false;
			}
			if (sp !== undefined) place.push(rec);
			// nobody out of the world has had a body in the NEW world yet (rule 6 counts only those who have)
			else rec.entered = false;
			// the fall they left during is over: the debt above (`newLifeOwed`) is what remains of it
			rec.leftWhileLost = false;
		}
		for (const rec of place) {
			const sp = this.inWorld(rec);
			if (sp === undefined) continue;
			if (reborn.has(rec.userId)) this.standUp(rec, sp, "newWorld");
			else this.moveKept(rec, sp);
		}
		this.wipeIn = undefined;
		this.wiped = false;
		this.lostByLeaving = false;
	}

	/**
	 * A connected survivor's save has just finished loading (server/main.server.ts, BEFORE its LoadAck goes out):
	 * the record catches up with it now — the reconcile of a reconnect, and a new life a world owed them (MP-22) —
	 * so the first save the client sees is already the truth, not a death the server has moved past. Nothing for a
	 * survivor this server has never seen. Returns whether the save changed.
	 */
	adopt(userId: number, save: PlayerSaveData): boolean {
		if (!this.records.has(userId)) return false;
		const rev = save.runRev;
		this.recordFor(userId, save);
		return save.runRev !== rev;
	}

	/**
	 * A session whose save could not be read played on a BLANK table (server/main.server.ts status "error", "Play
	 * without saving"), and a retry has just loaded the real save. Whatever this record learned from that blank
	 * table — a body, a death, the declined flag, a new life a world owed — happened to nobody's save: the record is
	 * dropped, and the real save is met as a first sight (rule 2: dead only if its `runOver` says so, the next body
	 * built from it). Review of de4ba1e, R3b: that death used to carry over into the real save (the survivor
	 * entered dead and `runOver` was persisted), and a living blank body into a real save that was dead.
	 *
	 * Only a record built on `blank` (a reconnect's record, with its departure banked, is reconciled as usual), and
	 * only out of the world: the host never runs that retry while the survivor is in it, nor admits them while it
	 * is pending (server/main.server.ts `loadRequest`). Returns whether the record was dropped.
	 */
	forgetUnsaved(userId: number, blank: PlayerSaveData): boolean {
		const rec = this.records.get(userId);
		if (rec === undefined || rec.save !== blank || this.inWorld(rec) !== undefined) return false;
		this.records.delete(userId);
		return true;
	}

	/**
	 * The fallback when `restartWorld` failed part-way (server/sim/worldReset.ts; review of de4ba1e, N2): the new town
	 * already stands, so no fallen survivor may be left down in it — nobody else could end the window either. Every
	 * one of `fallen` whose loaded save is here and who is still down gets the new life now, standing at a safe
	 * point if they are in the world, and rule 6 is armed again. Who already has it is left alone.
	 */
	settleFallen(fallen: ReadonlyArray<number>, saveOf: (userId: number) => PlayerSaveData | undefined): void {
		const owns = serverOwnsLife();
		for (const userId of fallen) {
			const rec = this.records.get(userId);
			const save = saveOf(userId);
			if (rec === undefined || save === undefined) continue;
			const sp = this.inWorld(rec);
			if (sp !== undefined ? !sp.state.dead : !rec.dead) continue;
			if (sp !== undefined) {
				adoptSave(sp, save);
				if (owns) sp.state.weapon.ammoCount = 0;
			}
			this.grantNewLife(rec, save);
			if (sp !== undefined) this.standUp(rec, sp, "newWorld");
		}
		this.wipeIn = undefined;
		this.wiped = false;
		this.lostByLeaving = false;
	}

	/** MP-22: the new life a world's end gives (the reset New game gives), and a body that stands up for it */
	private grantNewLife(rec: LifeRecord, save: PlayerSaveData): void {
		// as `newLife`: whatever the old run still had on the cursor is not the new life's (review R1)
		if (rec.slot !== undefined) this.sim.build?.drop(rec.slot);
		if (serverOwnsLife()) {
			resetRun(save);
			save.runRev = math.min(save.runRev + 1, SAVE_LIMITS.COUNTER_MAX);
		}
		rec.save = save;
		rec.dead = false;
		rec.lastDeath = undefined;
		rec.downFor = undefined;
		rec.declined = false;
		rec.fullNext = true;
		rec.newLifeOwed = false;
		rec.body = undefined;
		rec.unloaded = false;
		rec.banked = undefined;
		this.onSaveChanged?.(rec.userId);
	}

	// ------------------------------------------------------------ internals

	private recordFor(userId: number, save: PlayerSaveData | undefined): LifeRecord {
		let rec = this.records.get(userId);
		if (rec === undefined) {
			// first sight on this server: the save says whether this survivor is alive (§6.1 `runOver`), and a death
			// brought from another session waits for THIS world's daybreak like any other (rule 2)
			const dead = serverOwnsLife() && save !== undefined && save.runOver;
			rec = {
				userId,
				dead,
				fullNext: false,
				declined: false,
				unloaded: false,
				entered: false,
				newLifeOwed: false,
				leftWhileLost: false,
				downFor: dead ? daybreakWaitSeconds(this.sim.clock.dayTime) : undefined,
			};
			this.records.set(userId, rec);
		} else if (save !== undefined && save !== rec.save) {
			// true only when there IS a departure to compare with and the save is still exactly what it banked
			const kept = rec.banked !== undefined && this.reconcile(rec, save);
			if (rec.newLifeOwed) {
				rec.newLifeOwed = false;
				// the save they left with, back unchanged: the world that ended while they were away owes them this
				// life. Anything else — a save that moved on elsewhere, or one no departure of theirs ever banked (a
				// read-only session's blank table was all this record knew: N1) — decides for itself
				if (kept && this.inWorld(rec) === undefined) this.grantNewLife(rec, save);
			}
		}
		if (save !== undefined) rec.save = save;
		return rec;
	}

	/**
	 * A reconnect within the 5 min: the session loaded a NEW save table. If it still holds exactly what the departure
	 * banked, the kept body is the survivor's. If not, the save moved somewhere else meanwhile — another server hurt
	 * them, killed them, sold them a Rebirth — and a body kept here would be a heal (or a revive) bought by hopping
	 * back. The save is the truth then, except that a death on EITHER side stands. Returns whether the save was
	 * still exactly what the departure banked.
	 */
	private reconcile(rec: LifeRecord, save: PlayerSaveData): boolean {
		const b = rec.banked;
		rec.banked = undefined;
		if (
			b === undefined ||
			(b.runHp === save.runHp &&
				b.runHunger === save.runHunger &&
				b.runOver === save.runOver &&
				b.runRev === save.runRev)
		) {
			return true;
		}
		rec.body = undefined;
		rec.unloaded = false;
		rec.fullNext = false;
		// the same run (runRev unchanged): a death here and one there both stand. A new run elsewhere — a Rebirth
		// paid there, a New game, an admin edit — moved runRev on, and then that save decides alone: a death kept
		// here would take back a Rebirth the player paid for on the other server
		const owns = serverOwnsLife();
		const dead = b.runRev === save.runRev ? rec.dead || (owns && save.runOver) : owns && save.runOver;
		if (dead && !rec.dead) rec.downFor = daybreakWaitSeconds(this.sim.clock.dayTime);
		if (!dead) rec.downFor = undefined;
		// a death that moved in from elsewhere is not the one this record saw
		if (!(dead && rec.dead)) rec.lastDeath = undefined;
		rec.dead = dead;
		return false;
	}

	private inWorld(rec: LifeRecord): ServerPlayer | undefined {
		return rec.slot !== undefined ? this.sim.get(rec.slot) : undefined;
	}

	/**
	 * A bite lands in the horde's half of a tick; `stepPlayer` only flags the death in the NEXT one. Anything that
	 * takes the body out of the simulation in between (LeaveWorld, a disconnect, the shutdown, the autosave) settles
	 * that death first, through the same `died` a tick would have run — or leaving would be a way not to die.
	 */
	private lethal(sp: ServerPlayer): void {
		if (sp.state.dead || sp.state.hp > 0) return;
		sp.state.hp = 0;
		sp.state.dead = true;
		this.died(sp);
	}

	/** §7.1: a ring around a standing ally, away from the horde (MP-04) */
	private spawnQuery(except: number): SpawnQuery {
		const allies = new Array<{ x: number; y: number }>();
		for (const other of this.sim.players()) {
			if (other.slot !== except && !other.state.dead) allies.push({ x: other.state.x, y: other.state.y });
		}
		return { allies, zombies: this.sim.horde?.zombies ?? [] };
	}

	/**
	 * rule 3: back where it left; only a spot that has turned solid, or been walled in (MP-24), moves it -- to a safe
	 * ring around it, or a newcomer's spot, that the body can walk away from
	 */
	private placeKept(state: PlayerState): void {
		const world = this.sim.world;
		// MP-24: the spot is free ground AND a body there can walk away. The rule that refuses the piece closing a ring
		// around a survivor sees the bodies IN the world; a kept one in the lobby is not there to see, so a ring closed
		// while its survivor waited was a cell they came back into (the security review of the net hardening, M1)
		if (
			circleBlocked(world, state.x, state.y, PLAYER_RADIUS - 1) === undefined &&
			canEscape(world, state.x, state.y)
		) {
			return;
		}
		const zombies = this.sim.horde?.zombies ?? [];
		// near where they left first, as before; then anywhere a newcomer would be put -- and only a spot they can
		// leave (the last resort of findSpawnPoint is taken as it is: it never fails to return a point)
		let spot = findSpawnPoint(world, { allies: [{ x: state.x, y: state.y }], zombies });
		for (let i = 0; i < KEPT_SPOT_TRIES && !canEscape(world, spot.x, spot.y); i++) {
			spot = findSpawnPoint(
				world,
				i < KEPT_SPOT_TRIES / 2 ? { allies: [{ x: state.x, y: state.y }], zombies } : { zombies },
			);
		}
		state.x = spot.x;
		state.y = spot.y;
	}

	/**
	 * MP-22, for a body in the world that is NOT starting a new life (a living one; a wipe never has any, since
	 * nobody is standing when it fires): the same body — hp, hunger, magazine — carried to a safe point of the new
	 * town, with the shield a newcomer gets there. Nothing about its life changes, so the roster hears nothing.
	 */
	private moveKept(rec: LifeRecord, sp: ServerPlayer): void {
		const sim = this.sim;
		const spawn = findSpawnPoint(sim.world, this.spawnQuery(sp.slot));
		sp.state.x = spawn.x;
		sp.state.y = spawn.y;
		// ITM-06: a new town is a new arrival -- the hands are the session's, and it stands with the weapon drawn
		sp.state.holstered = undefined;
		sp.spawnShieldUntil = sim.tick + math.floor(SPAWN_SHIELD_S * sim.simHz);
		if (serverOwnsLife() && rec.save !== undefined && writeRunBody(rec.save, sp.state)) {
			this.onSaveChanged?.(rec.userId);
		}
	}

	/** daybreak or a Rebirth: a fresh, full body at a safe point with the 3 s shield (§7.3), and the roster told */
	private standUp(rec: LifeRecord, sp: ServerPlayer, why: StandReason): void {
		const sim = this.sim;
		const owns = serverOwnsLife();
		// the rounds the fallen body still had go back to the reserve: the new body pays for its own
		if (owns) unloadMagazine(sp.state, sp.save);
		const spawn = findSpawnPoint(sim.world, this.spawnQuery(sp.slot));
		sp.state = freshBody(sp.save, spawn.x, spawn.y, true);
		sp.spawnShieldUntil = sim.tick + math.floor(SPAWN_SHIELD_S * sim.simHz);
		rec.dead = false;
		rec.lastDeath = undefined;
		rec.downFor = undefined;
		rec.declined = false;
		rec.fullNext = false;
		if (owns) writeRunBody(sp.save, sp.state);
		this.wire.life(sp.slot, LifeState.Up);
		this.onSaveChanged?.(rec.userId);
		this.onStandUp?.(sp, why);
	}

	/** §7.2: the body into the save and the magazine into the reserve, once per departure */
	private bank(rec: LifeRecord): void {
		const save = rec.save;
		if (save === undefined || !serverOwnsLife()) return;
		let changed = false;
		const body = rec.body;
		if (body !== undefined) {
			if (!rec.unloaded) {
				changed = unloadMagazine(body, save) > 0;
				rec.unloaded = true;
			}
			changed = writeRunBody(save, body) || changed;
		} else if (save.runOver !== rec.dead) {
			// no body kept (a Rebirth or a New game bought from the lobby): the record alone says alive or dead
			save.runOver = rec.dead;
			changed = true;
		}
		rec.banked = { runHp: save.runHp, runHunger: save.runHunger, runOver: save.runOver, runRev: save.runRev };
		if (changed) this.onSaveChanged?.(rec.userId);
	}

	/**
	 * Is this record standing in the world for rule 6 -- a body up in the street, or a living one kept in the lobby --
	 * and is it counted at all? `undefined`: not one of this world's survivors right now (gone, never entered, or its
	 * save still loading); `true`: standing; `false`: dead (in the street or in the lobby).
	 */
	private standingOf(userId: number, rec: LifeRecord): boolean | undefined {
		// somebody who left the server is not a survivor of this world any more, and somebody who never had a body in
		// it (a death carried in from another session, asked about from the lobby) never was
		if (rec.goneFor !== undefined || !rec.entered) return undefined;
		const sp = this.inWorld(rec);
		// a body standing in the street is standing, whatever its save is doing
		if (sp !== undefined && !sp.state.dead) return true;
		// anybody else whose save is still loading is not counted yet, dead or alive: all that stands behind a
		// reconnect is the CLOSED session's table (B1), and behind a retry the blank one — the world must not end,
		// nor reset anybody, on its word, and a body carried dead into a new town must not end it again every
		// window until the load is done (review of de4ba1e, N4; the host no longer runs a retry in the world)
		if (this.liveSave !== undefined && this.liveSave(userId) === undefined) return undefined;
		if (sp === undefined && !rec.dead && (rec.body !== undefined || rec.fullNext)) return true;
		return rec.dead ? false : undefined;
	}

	/** how many of this world's survivors stand (`standingOf`), leaving `except` out */
	private standing(except?: number): number {
		let n = 0;
		for (const [userId, rec] of this.records) {
			if (userId !== except && this.standingOf(userId, rec) === true) n += 1;
		}
		return n;
	}

	/** players connected to the server (`connected`), or the records of those still here */
	private connectedCount(): number {
		const hook = this.connected;
		if (hook !== undefined) return hook();
		let n = 0;
		for (const [, rec] of this.records) if (rec.goneFor === undefined) n += 1;
		return n;
	}

	/**
	 * MP-26, the town restarted by its keeper (server/match/townRestart.ts; the orchestrator's decision on the review of
	 * 0b44458, M1 + M2): EVERY survivor of this town -- everyone who had a body in it and is still this server's
	 * (connected, or gone less than KEEP_AFTER_LEAVE_S), standing or down. A restart is a whole MP-22 world end: all of
	 * them start a new life on day 1 in the new town (`restartWorld` with `everyone`), so it can never be a way to farm
	 * the easy first days with a life that goes on, nor end only the lives of the friends who happened to be down.
	 * Somebody who never set foot in this town (a player still in the lobby since they joined) has no life here to end.
	 */
	survivorsNow(): Array<number> {
		const out = new Array<number>();
		for (const [userId, rec] of this.records) if (rec.entered) out.push(userId);
		return out;
	}

	/** rule 6, once per step */
	private stepWipe(dt: number): void {
		let alive = 0;
		let waiting = 0;
		const dead = new Array<number>();
		for (const [userId, rec] of this.records) {
			if (rec.goneFor !== undefined) {
				// gone from the server: never standing. One who left it DEAD with nobody alive in the world declined and
				// still counts among its fallen (`leftWhileLost`, decided at the departure: L2, L3); a death left behind
				// while somebody still stood was only a departure, and nobody waits on it
				if (rec.dead && rec.leftWhileLost) dead.push(userId);
				continue;
			}
			const up = this.standingOf(userId, rec);
			if (up === undefined) continue;
			if (up) {
				alive += 1;
				continue;
			}
			dead.push(userId);
			// in the street or in the lobby, a dead survivor who has not declined may still pay
			if (!rec.declined) waiting += 1;
		}
		if (alive > 0) {
			// somebody is standing (a Rebirth, a daybreak, a living survivor walking in): the fall is over, and those who
			// left during it are only departures from now on
			this.wipeIn = undefined;
			this.wiped = false;
			this.lostByLeaving = false;
			for (const [, rec] of this.records) rec.leftWhileLost = false;
			return;
		}
		if (dead.size() === 0 && !this.lostByLeaving) {
			// nobody is here at all: an empty world is not a lost one
			this.wipeIn = undefined;
			this.wiped = false;
			return;
		}
		if (this.wiped) return;
		// a world its dead walked out of ends only with somebody on the server to see the next one (L1): with nobody
		// connected the empty server keeps it lost -- Roblox closes it soon -- and the next player to connect ends it
		// at once, before they can enter it
		if (this.connectedCount() === 0) {
			this.wipeIn = undefined;
			return;
		}
		this.wipeIn = (this.wipeIn ?? WIPE_DECISION_S) - dt;
		const reason = waiting === 0 ? "declined" : this.wipeIn <= 0 ? "timeout" : undefined;
		if (reason === undefined) return;
		this.wipeIn = undefined;
		this.wiped = true;
		this.lostByLeaving = false;
		this.onWorldWiped?.({ day: this.sim.clock.day, reason, dead });
	}
}
