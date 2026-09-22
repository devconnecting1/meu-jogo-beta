import { DESIGN } from "shared/engine/constants";
import { damageCal, rnd, rndInt } from "shared/engine/rng";
import { WeaponKind } from "shared/data/kinds";
import { WeaponDef, WEAPONS } from "shared/data/weapons";
import { EQUIPS } from "shared/data/equips";
import { USABLES } from "shared/data/usables";
import { PlayerSaveData } from "shared/game/save";

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
	noMoveKill: number;
	dead: boolean;
}

export function createPlayer(save: PlayerSaveData, x: number, y: number): PlayerState {
	const w = save.equipWeapon >= 0 ? WEAPONS[save.equipWeapon] : WEAPONS[0];
	return {
		x,
		y,
		hp: 100 + save.skillLevels[0] * 10,
		hpMax: 100 + save.skillLevels[0] * 10,
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

export function playerEquipDefence(save: PlayerSaveData): number {
	let def = 0;
	if (save.equipCloth >= 0) def += EQUIPS[save.equipCloth].def;
	if (save.equipDeco >= 0) def += EQUIPS[save.equipDeco].def;
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
	if (save.equipCloth >= 0) s += EQUIPS[save.equipCloth]?.speed ?? 0;
	if (save.equipDeco >= 0) s += EQUIPS[save.equipDeco]?.speed ?? 0;
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
 * Consume one usable from the backpack. Returns false (and does nothing) when the survivor has
 * none left or the id is unknown. `hp` heals, `hunger` feeds (the old code had them swapped).
 */
export function itemUseEffect(p: PlayerState, save: PlayerSaveData, usableId: number): boolean {
	const u = USABLES[usableId];
	if (u === undefined) return false;
	if ((save.invenUse[usableId] ?? 0) <= 0) return false;
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
 * Hurt the player. Normal hits respect the 1.5 s i-frames and the armour; `bypassDef` (explosions,
 * the centipede's body, poison-like damage) ignores both. Returns true when damage was actually
 * applied — callers use it to stun the attacker only on a real hit (like obj_player_body).
 * The caller sets p.reactionDir (knockback direction).
 */
export function damageToPlayer(p: PlayerState, save: PlayerSaveData, raw: number, bypassDef = false): boolean {
	if (p.dead) return false;
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
