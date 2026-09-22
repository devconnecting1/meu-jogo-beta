import { DESIGN } from "shared/engine/constants";
import { damageCal, rnd, rndInt } from "shared/engine/rng";
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
	reloadCount: number;
	reloading: boolean;
	relaunchCount: number;
	angleRange: number;
	autoReloadIdle: number;
	bowCount: number;
	chainCount: number;
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

export function recalcMoveSpeed(p: PlayerState, save: PlayerSaveData): number {
	let s = DESIGN.MOVE_SPEED + save.skillLevels[7] * 0.3;
	if (save.equipCloth >= 0) s += EQUIPS[save.equipCloth].speed;
	if (save.equipDeco >= 0) s += EQUIPS[save.equipDeco].speed;
	if (p.buffs.speed > 0) s += 2;
	s -= (p.hungry / p.hungryMax) * 0.5;
	return s;
}

export function currentWeapon(p: PlayerState): WeaponDef {
	const id = p.weapon.pointer;
	if (id >= 0 && id < WEAPONS.size()) return WEAPONS[id];
	return WEAPONS[0];
}

export function itemUseEffect(p: PlayerState, save: PlayerSaveData, usableId: number): void {
	const u = USABLES[usableId];
	if (u === undefined) return;
	p.hungry = math.clamp(p.hungry + u.hp, 0, p.hungryMax);
	p.hp = math.clamp(p.hp + u.hunger, -1000, p.hpMax);
	if (u.speed > 0) p.buffs.speed = u.speed * 60;
	if (u.calm > 0) p.buffs.calm = u.calm * 60;
	if (u.pain > 0) p.buffs.pain = u.pain * 60;
	save.invenUse[usableId] = math.max(0, (save.invenUse[usableId] ?? 0) - 1);
}

export function damageToPlayer(p: PlayerState, save: PlayerSaveData, raw: number, bypassDef = false): void {
	if (p.attacked && !bypassDef) return;
	let dd = raw;
	if (!bypassDef) {
		dd -= playerEquipDefence(save);
		if (dd < 0) dd = 0;
	}
	p.hp -= dd;
	p.attacked = true;
	p.iframe = DESIGN.IFRAMES;
	p.reactionSpeed = DESIGN.REACTION_MAX;
}

export function weaponAmmoPool(save: PlayerSaveData, pool: number): number {
	if (pool === 1) return save.ammoNormal;
	if (pool === 2) return save.ammoShotgun;
	if (pool === 3) return save.ammoMachinegun;
	if (pool === 4) return save.ammoArrow;
	if (pool === 48) return save.oil;
	return save.electric;
}

export function weaponSpendAmmo(save: PlayerSaveData, pool: number, n: number): void {
	if (pool === 1) save.ammoNormal = math.max(0, save.ammoNormal - n);
	else if (pool === 2) save.ammoShotgun = math.max(0, save.ammoShotgun - n);
	else if (pool === 3) save.ammoMachinegun = math.max(0, save.ammoMachinegun - n);
	else if (pool === 4) save.ammoArrow = math.max(0, save.ammoArrow - n);
	else if (pool === 48) save.oil = math.max(0, save.oil - n);
	else save.electric = math.max(0, save.electric - n);
}

export { damageCal, rnd, rndInt };
