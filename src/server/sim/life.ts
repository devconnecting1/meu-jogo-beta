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
 *      `onWorldWiped` fires, once. That hook is the ONE place the world's reset to day 1 plugs in (the owner's next
 *      task); until it exists the daybreak wait still stands everybody up, which is also what keeps a server whose
 *      survivors all died from staying sterile for ever (`rebuildClusters` skips the dead).
 *
 * Pure module: no Instances, no services, no os.clock. server/net/mpHost.ts feeds `step(dt)` from its Heartbeat and
 * maps Players to UserIds; tools/test-body.mjs drives the real host through its remotes.
 */
import { rebirthPrice } from "shared/data/shop";
import { WEAPONS, WeaponDef, usesMagazine } from "shared/data/weapons";
import { PLAYER_RADIUS, circleBlocked } from "shared/game/physics";
import { PlayerState, createPlayer, damageIsServerOwned, weaponReserve, weaponSpendAmmo } from "shared/game/player";
import { PlayerSaveData, SAVE_LIMITS, ownsWeapon } from "shared/game/save";
import type { ShopActionReason } from "shared/net/net";
import { LifeState } from "shared/net/protocol";
import { daybreakWaitSeconds } from "shared/sim/clock";
import { isFuelWeapon } from "./combat";
import { SPAWN_SHIELD_S, ServerPlayer, SpawnQuery, createServerPlayer, findSpawnPoint } from "./players";
import type { ServerSimulation } from "./simulation";

/** §7.2: "O estado de mundo fica 5 min em memória" after a disconnect (seconds) */
export const KEEP_AFTER_LEAVE_S = 300;
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
 */
export function unloadMagazine(state: PlayerState, save: PlayerSaveData): number {
	const rt = state.weapon;
	const w = rt.pointer >= 0 && rt.pointer < WEAPONS.size() ? WEAPONS[rt.pointer] : undefined;
	const rounds = math.max(0, math.floor(rt.ammoCount));
	rt.ammoCount = 0;
	rt.reloading = false;
	rt.reloadCount = 0;
	if (w === undefined || !usesMagazine(w) || isFuelWeapon(w) || rounds <= 0 || state.infiniteAmmo === true) return 0;
	weaponSpendAmmo(save, w.ammoPool, -rounds);
	return rounds;
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
	const changed = upd.runOver !== prev.runOver || upd.runHp !== prev.runHp || upd.runHunger !== prev.runHunger;
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
}

/** what `onWorldWiped` is told */
export interface WipeReport {
	/** the world's day on which it was lost */
	day: number;
	/** "timeout": the window closed with nobody standing; "declined": every dead survivor chose not to pay */
	reason: "timeout" | "declined";
	/** the UserIds of the dead the window waited on */
	dead: Array<number>;
}

/** why a body stood back up */
export type StandReason = "daybreak" | "rebirth";

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
}

/** the v3 run body as the last departure wrote it (§7.2) */
interface BankedBody {
	runHp: number;
	runHunger: number;
	runOver: boolean;
	runRev: number;
}

export class LifeKeeper {
	/** rule 6: the world is lost. The ONE place the reset to day 1 plugs in; nothing is reset yet */
	onWorldWiped?: (report: WipeReport) => void;
	/** the server just wrote into this survivor's save (death, stand-up, the body banked): persist it */
	onSaveChanged?: (userId: number) => void;
	/** a body stood back up (for the host's log and the tests) */
	onStandUp?: (sp: ServerPlayer, why: StandReason) => void;

	private readonly sim: ServerSimulation;
	private readonly wire: LifeWire;
	private readonly records = new Map<number, LifeRecord>();
	/** seconds left in the decision window of rule 6, or undefined while it is closed */
	private wipeIn?: number;
	/** the hook already fired for this fall; re-armed once somebody is standing again */
	private wiped = false;

	constructor(sim: ServerSimulation, wire: LifeWire) {
		this.sim = sim;
		this.wire = wire;
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
		if (rec !== undefined) rec.goneFor = undefined;
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
		if (rec.goneFor === undefined) rec.goneFor = 0;
		if (rec.dead) rec.declined = true;
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
		if (serverOwnsLife()) {
			writeRunBody(sp.save, sp.state);
			this.onSaveChanged?.(sp.userId);
		}
		this.wire.life(sp.slot, LifeState.Dead);
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
				downFor: dead ? daybreakWaitSeconds(this.sim.clock.dayTime) : undefined,
			};
			this.records.set(userId, rec);
		} else if (rec.banked !== undefined && save !== undefined && save !== rec.save) {
			this.reconcile(rec, save);
		}
		if (save !== undefined) rec.save = save;
		return rec;
	}

	/**
	 * A reconnect within the 5 min: the session loaded a NEW save table. If it still holds exactly what the departure
	 * banked, the kept body is the survivor's. If not, the save moved somewhere else meanwhile — another server hurt
	 * them, killed them, sold them a Rebirth — and a body kept here would be a heal (or a revive) bought by hopping
	 * back. The save is the truth then, except that a death on EITHER side stands.
	 */
	private reconcile(rec: LifeRecord, save: PlayerSaveData): void {
		const b = rec.banked;
		rec.banked = undefined;
		if (
			b === undefined ||
			(b.runHp === save.runHp &&
				b.runHunger === save.runHunger &&
				b.runOver === save.runOver &&
				b.runRev === save.runRev)
		) {
			return;
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
		rec.dead = dead;
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

	/** rule 3: back where it left; only a spot that has turned solid moves it, to the nearest safe ring around it */
	private placeKept(state: PlayerState): void {
		const world = this.sim.world;
		if (circleBlocked(world, state.x, state.y, PLAYER_RADIUS - 1) === undefined) return;
		const spot = findSpawnPoint(world, {
			allies: [{ x: state.x, y: state.y }],
			zombies: this.sim.horde?.zombies ?? [],
		});
		state.x = spot.x;
		state.y = spot.y;
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

	/** rule 6, once per step */
	private stepWipe(dt: number): void {
		let alive = 0;
		let waiting = 0;
		const dead = new Array<number>();
		for (const [userId, rec] of this.records) {
			// somebody who left the server is not a survivor of this world any more, and somebody who never had a
			// body in it (a death carried in from another session, asked about from the lobby) never was
			if (rec.goneFor !== undefined || !rec.entered) continue;
			const sp = this.inWorld(rec);
			if (sp !== undefined ? !sp.state.dead : !rec.dead && (rec.body !== undefined || rec.fullNext)) {
				alive += 1;
				continue;
			}
			if (!rec.dead) continue;
			dead.push(userId);
			// in the street or in the lobby, a dead survivor who has not declined may still pay
			if (!rec.declined) waiting += 1;
		}
		if (alive > 0 || dead.size() === 0) {
			// somebody is standing (a Rebirth, a daybreak, a living survivor walking in), or nobody is here at all:
			// an empty world is not a lost one
			this.wipeIn = undefined;
			this.wiped = false;
			return;
		}
		if (this.wiped) return;
		this.wipeIn = (this.wipeIn ?? WIPE_DECISION_S) - dt;
		const reason = waiting === 0 ? "declined" : this.wipeIn <= 0 ? "timeout" : undefined;
		if (reason === undefined) return;
		this.wipeIn = undefined;
		this.wiped = true;
		this.onWorldWiped?.({ day: this.sim.clock.day, reason, dead });
	}
}
