import { DESIGN } from "shared/engine/constants";
import { damageCal, rnd, rndInt } from "shared/engine/rng";
import { WeaponKind } from "shared/data/kinds";
import { WeaponDef, WEAPONS } from "shared/data/weapons";
import { EQUIPS } from "shared/data/equips";
import { USABLES } from "shared/data/usables";
import { PlayerSaveData } from "shared/game/save";
import { MP_PHASE } from "shared/net/mpConfig";
import type { RideState } from "shared/sim/rideKey";

export interface BuffState {
	speed: number;
	calm: number;
	pain: number;
	poison: number;
}

export interface WeaponRuntime {
	pointer: number;
	ammoCount: number;
	/** seconds of reload left (counts down while `reloading`) */
	reloadCount: number;
	/** length of the current reload in seconds (HUD: progress = 1 - reloadCount / reloadTotal) */
	reloadTotal?: number;
	reloading: boolean;
	relaunchCount: number;
	angleRange: number;
	autoReloadIdle: number;
	/** bow draw 0..1 (1 = full draw, releasing fires) */
	bowCount: number;
	/** chainsaw rev in seconds (cuts once ≥ warm-up) */
	chainCount: number;
	/** seconds the sniper has been aiming (button held) */
	scopeTime: number;
}

export interface PlayerState {
	x: number;
	y: number;
	hp: number;
	hpMax: number;
	hungry: number;
	hungryMax: number;
	moveSpeed: number;
	angle: number;
	attacked: boolean;
	iframe: number;
	reactionSpeed: number;
	reactionDir: number;
	buffs: BuffState;
	weapon: WeaponRuntime;
	attackCount: number;
	swingerAngle: number;
	swingerActive: boolean;
	/** current melee reach in world units, set by combat; renderer draws the swing with it */
	swingReach?: number;
	/** 1 → 0 after taking damage; renderer flashes the player / vignette while > 0 */
	hitFlash?: number;
	/** seconds of spitter-acid slow left (set by zombieAI while standing in a puddle) */
	puddleSlow?: number;
	vehicleId: number;
	/**
	 * The bicycle or motorcycle this survivor rides (DESIGN_RULES VEI-05), undefined on foot. Only the SERVER sets it
	 * (server/sim/vehicles.ts, on an E it resolved itself); the client adopts it from the self block and predicts
	 * with it. `stepPlayer` then moves the survivor with the vehicle's handling instead of the walk.
	 */
	ride?: RideState;
	noMoveKill: number;
	dead: boolean;
	/** admin panel "god mode" (and free camera): damageToPlayer does nothing */
	godMode?: boolean;
	/** admin panel "noclip": stepPlayer moves this survivor without collision (docs/MULTIPLAYER.md §10) */
	noclip?: boolean;
	/**
	 * admin panel "infinite ammo": the magazine is refilled for free, so it must never turn into real ammo
	 * (switching weapons does not return it to the pool, picked-up arrows are not added)
	 */
	infiniteAmmo?: boolean;
}

/**
 * The survivor's maximum health: 100, +10 a level of the Health skill (skill 0). The original recomputed it every
 * step (obj_player `hp_max = 100 + rpg_skill_get_level(0)*10`), and so does `stepPlayer` (shared/sim/playerMove.ts):
 * Health learnt mid-life raises the bar at once, not at the next body (QA K2).
 */
export function maxHpOf(save: PlayerSaveData): number {
	return 100 + (save.skillLevels[0] ?? 0) * 10;
}

export function createPlayer(save: PlayerSaveData, x: number, y: number): PlayerState {
	const w = save.equipWeapon >= 0 ? WEAPONS[save.equipWeapon] : WEAPONS[0];
	return {
		x,
		y,
		hp: maxHpOf(save),
		hpMax: maxHpOf(save),
		hungry: DESIGN.PLAYER_HUNGRY,
		hungryMax: DESIGN.PLAYER_HUNGRY,
		moveSpeed: DESIGN.MOVE_SPEED,
		angle: 0,
		attacked: false,
		iframe: 0,
		reactionSpeed: 0,
		reactionDir: 0,
		buffs: { speed: 0, calm: 0, pain: 0, poison: 0 },
		weapon: {
			pointer: save.equipWeapon,
			ammoCount: w.mag,
			reloadCount: 0,
			reloading: false,
			relaunchCount: 0,
			angleRange: 0,
			autoReloadIdle: 0,
			bowCount: 0,
			chainCount: 0,
			scopeTime: 0,
		},
		attackCount: 0,
		swingerAngle: 0,
		swingerActive: false,
		vehicleId: -1,
		noMoveKill: 0,
		dead: false,
	};
}

/**
 * Defence from what the survivor wears. Only the Cloth slot counts: the outfit and the pet are cosmetics and, by
 * MON-01, change nothing that happens in a night — so they are left out HERE, by construction, instead of trusting
 * every kind-4 row of the data table to keep `def: 0` forever.
 */
export function playerEquipDefence(save: PlayerSaveData): number {
	let def = 0;
	if (save.equipCloth >= 0) def += EQUIPS[save.equipCloth].def;
	return def;
}

/** below this fraction of the hunger bar the survivor starts to drag their feet */
const STARVING_RATIO = 0.25;

/**
 * Walking speed in px/frame @30fps (× SPEED_SCALE for px/s).
 * Differences from Dead Town: its `move_speed -= hungry/hungry_max*0.5` made a FULL stomach the
 * slowest state; here only an empty-ish stomach slows you (up to −1.5 when starving, and the
 * gameLoop already drains HP at 0). Like the original, being hit slows you during the i-frames
 * unless you are on painkillers, and standing in spitter acid halves the speed.
 */
export function recalcMoveSpeed(p: PlayerState, save: PlayerSaveData): number {
	let s = DESIGN.MOVE_SPEED + save.skillLevels[7] * 0.3;
	// the cosmetic slots never move this number (MON-01; see playerEquipDefence)
	if (save.equipCloth >= 0) s += EQUIPS[save.equipCloth]?.speed ?? 0;
	if (p.buffs.speed > 0) s += 2;
	const fed = p.hungryMax > 0 ? p.hungry / p.hungryMax : 1;
	if (fed < STARVING_RATIO) {
		s -= ((STARVING_RATIO - fed) / STARVING_RATIO) * 1.5;
	}
	if (p.attacked && p.buffs.pain <= 0) {
		s -= 1.5;
	}
	if ((p.puddleSlow ?? 0) > 0) {
		s *= 0.5;
	}
	return math.max(1, s);
}

export function currentWeapon(p: PlayerState): WeaponDef {
	const id = p.weapon.pointer;
	if (id >= 0 && id < WEAPONS.size()) return WEAPONS[id];
	return WEAPONS[0];
}

/**
 * Would `itemUseEffect` do anything right now? The same test, without touching the body or the backpack: the
 * server's `useItem` and the client's prediction of it (client/net/bagPrediction.ts) ask the one question.
 */
export function itemUseWouldWork(p: PlayerState, save: PlayerSaveData, usableId: number): boolean {
	const u = USABLES[usableId];
	if (u === undefined) return false;
	if ((save.invenUse[usableId] ?? 0) <= 0) return false;
	const hasBuff = u.speed > 0 || u.calm > 0 || u.pain > 0;
	const healsHp = u.hp < 0 || (u.hp > 0 && p.hp < p.hpMax);
	const feedsHunger = u.hunger !== 0 && p.hungry < p.hungryMax;
	return hasBuff || healsHp || feedsHunger;
}

/**
 * Consume one usable from the backpack. Returns false (and does nothing) when the survivor has
 * none left, the id is unknown, or the item would have no effect at all: a pure hp/hunger item
 * (no buff, no poison cure) with both hp and hunger already at their max does nothing, so it is
 * not worth burning. `hp` heals, `hunger` feeds (the old code had them swapped).
 */
export function itemUseEffect(p: PlayerState, save: PlayerSaveData, usableId: number): boolean {
	if (!itemUseWouldWork(p, save, usableId)) return false;
	const u = USABLES[usableId];

	p.hp = math.clamp(p.hp + u.hp, -1000, p.hpMax);
	p.hungry = math.clamp(p.hungry + u.hunger, 0, p.hungryMax);
	// buff lengths are minutes; using another one refreshes (never shortens) the buff
	if (u.speed > 0) p.buffs.speed = math.max(p.buffs.speed, u.speed * 60);
	if (u.calm > 0) p.buffs.calm = math.max(p.buffs.calm, u.calm * 60);
	if (u.pain > 0) p.buffs.pain = math.max(p.buffs.pain, u.pain * 60);
	save.invenUse[usableId] = math.max(0, (save.invenUse[usableId] ?? 0) - 1);
	return true;
}

/**
 * MP_PHASE from which a survivor may only lose HP inside `server/sim/combat.ts` (docs/MULTIPLAYER.md §2.3
 * "Dano em jogadores", §8.3, MP-00). Below it the current single-player path stays exactly as it was.
 */
export const DAMAGE_SERVER_PHASE = 2;

/** true when the server, and only the server, decides how much HP a survivor loses */
export function damageIsServerOwned(): boolean {
	return MP_PHASE >= DAMAGE_SERVER_PHASE;
}

/**
 * Hurt the player. Normal hits respect the 1.5 s i-frames and the armour; `bypassDef` (explosions,
 * the centipede's body, poison-like damage) ignores both. Returns true when damage was actually
 * applied — callers use it to stun the attacker only on a real hit (like obj_player_body).
 * The caller sets p.reactionDir (knockback direction).
 *
 * This is the SERVER entry point (and, below DAMAGE_SERVER_PHASE, the local one). Client systems go through
 * `damageToPlayer`, which stops being a damage source once the server owns it.
 */
export function applyPlayerDamage(p: PlayerState, save: PlayerSaveData, raw: number, bypassDef = false): boolean {
	if (p.dead || p.godMode === true) return false;
	if (p.attacked && !bypassDef) return false;
	let dd = raw;
	if (!bypassDef) {
		dd -= playerEquipDefence(save);
		if (dd < 0) dd = 0;
	}
	p.hp -= dd;
	p.hitFlash = 1;
	if (!p.attacked) {
		p.attacked = true;
		p.iframe = DESIGN.IFRAMES;
		p.reactionSpeed = DESIGN.REACTION_MAX;
		return true;
	}
	return dd > 0;
}

/**
 * What every client system (zombie bites, boss attacks, the boss needle) still calls. From
 * DAMAGE_SERVER_PHASE on it does NOTHING and answers false: the bite that matters was already resolved on
 * the server, against ITS zombie positions, and arrives as a `hp` field in the snapshot (§4.2 self block).
 *
 * Keeping the call sites and neutering the function here — instead of deleting the calls — is deliberate:
 * it is ONE place to audit ("who can take HP off a survivor?"), it keeps the F2 rollback to MP_PHASE 1 a
 * one-constant change, and a system added later that forgets the rule is harmless by default. The playtest
 * that started this front (two players in the same place, one at 84/100 from zombies only his client knew
 * about) is impossible once this returns false.
 */
export function damageToPlayer(p: PlayerState, save: PlayerSaveData, raw: number, bypassDef = false): boolean {
	if (damageIsServerOwned()) return false;
	return applyPlayerDamage(p, save, raw, bypassDef);
}

/** reserve of an ammo pool (1 normal, 2 shotgun, 3 MG, 4 arrow, 5 oil — 48 accepted as oil too) */
export function weaponAmmoPool(save: PlayerSaveData, pool: number): number {
	if (pool === 1) return save.ammoNormal;
	if (pool === 2) return save.ammoShotgun;
	if (pool === 3) return save.ammoMachinegun;
	if (pool === 4) return save.ammoArrow;
	if (pool === 5 || pool === 48) return save.oil;
	return save.electric;
}

/** reserve that feeds this weapon (flamethrower → oil, stun gun → electricity, melee → 0) */
export function weaponReserve(save: PlayerSaveData, w: WeaponDef): number {
	if (w.id === 25 || w.id === 5) return math.floor(save.oil);
	if (w.id === 26) return math.floor(save.electric);
	if (w.mag <= 0 && w.kind !== WeaponKind.Bow) return 0;
	return weaponAmmoPool(save, w.ammoPool);
}

export function weaponSpendAmmo(save: PlayerSaveData, pool: number, n: number): void {
	if (pool === 1) save.ammoNormal = math.max(0, save.ammoNormal - n);
	else if (pool === 2) save.ammoShotgun = math.max(0, save.ammoShotgun - n);
	else if (pool === 3) save.ammoMachinegun = math.max(0, save.ammoMachinegun - n);
	else if (pool === 4) save.ammoArrow = math.max(0, save.ammoArrow - n);
	else if (pool === 5 || pool === 48) save.oil = math.max(0, save.oil - n);
	else save.electric = math.max(0, save.electric - n);
}

export { damageCal, rnd, rndInt };
