import { damageCal, rnd, rndRange } from "shared/engine/rng";
import { DESIGN } from "shared/engine/constants";
import { difficultyOfDay } from "shared/game/save";

export type ZombieType = 1 | 2 | 3 | 4 | 5;

export interface ZombieState {
	id: number;
	type: ZombieType;
	x: number;
	y: number;
	spawnX: number;
	spawnY: number;
	hp: number;
	hpMax: number;
	damage: number;
	damageRush?: number;
	moveSpeed: number;
	exp: number;
	angle: number;
	angleSlow: number;
	detect: boolean;
	detectShow: number;
	stunned: number;
	attacked: boolean;
	iframe: number;
	reactionSpeed: number;
	reactionDir: number;
	wanderTimer: number;
	wanderDir: number;
	wave: boolean;
	alpha: number;
	/** walk-cycle phase (rad), advanced by the AI while moving; renderer animates feet with it */
	feetCycle?: number;
	/** 1 → 0 after a hit; renderer flashes/outlines while > 0 */
	hitFlash?: number;
	/** visual + hitbox scale (big variant = 1.4) */
	scale?: number;
	// spitter
	attackCd?: number;
	headX?: number;
	// exploder
	fuse?: number;
	// charger
	rush?: boolean;
	rushReady?: boolean;
	rushCd?: number;
	rushSpeed?: number;
	rushDir?: number;
	backstep?: boolean;
	// jumper
	jumping?: boolean;
	jumpReady?: boolean;
	jumpCd?: number;
	jumpDir?: number;
	jumpTargetX?: number;
	jumpTargetY?: number;
	jumpHeight?: number;
	special: boolean;
}

export interface BossState {
	id: number;
	type: number;
	x: number;
	y: number;
	hp: number;
	hpMax: number;
	hpRecover: number;
	damage: number;
	exp: number;
	moveSpeed: number;
	angle: number;
	attackCd: number;
	dead: boolean;
	/** 1 → 0 after a hit; renderer flashes while > 0 */
	hitFlash?: number;
	// boss1
	bodyX?: Array<number>;
	bodyY?: Array<number>;
	bodyNumber?: number;
	movePos?: number;
	// boss3
	moveCycle?: number;
	// boss4
	moveCount?: number;
	moveDir?: number;
	attack?: boolean;
}

let nextId = 1;

export function resetEntityIds(): void {
	nextId = 1;
}

export function createZombie(typeId: ZombieType, x: number, y: number, day: number, wave = false): ZombieState {
	const d = difficultyOfDay(day);
	const base: Record<number, { sp: number; hp: number; dmg: number; exp: number }> = {
		1: { sp: 3, hp: 100, dmg: 10, exp: 10 },
		2: { sp: 2.5, hp: 100, dmg: 10, exp: 20 },
		3: { sp: 1.7, hp: 150, dmg: 10, exp: 20 },
		4: { sp: 2.5, hp: 150, dmg: 10, exp: 20 },
		5: { sp: 2.5, hp: 100, dmg: 10, exp: 20 },
	};
	const b = base[typeId];
	let sp = b.sp * (1 + d / 3);
	let hp = math.floor(b.hp * (1 + d));
	if (typeId === 1 && day > 1 && rnd() * 10 < 1) {
		sp *= 2;
		hp = math.floor(hp / 2);
	} else if (typeId === 1 && day > 2 && rnd() * 20 < 1) {
		hp = math.floor(hp * 1.5);
	}
	const z: ZombieState = {
		id: nextId++,
		type: typeId,
		x,
		y,
		spawnX: x,
		spawnY: y,
		hp,
		hpMax: hp,
		damage: math.floor(b.dmg * (1 + d)),
		moveSpeed: sp,
		exp: b.exp,
		angle: rnd() * math.pi * 2,
		angleSlow: 0,
		detect: typeId === 1 && rnd() * 10 < 1,
		detectShow: 0,
		stunned: 0,
		attacked: false,
		iframe: 0,
		reactionSpeed: 0,
		reactionDir: 0,
		wanderTimer: rndRange(1, 2),
		wanderDir: rnd() * math.pi * 2,
		wave,
		alpha: 1,
		special: typeId !== 1,
	};
	if (typeId === 4) {
		z.damageRush = math.floor(20 * (1 + d));
		z.rushReady = true;
		z.rushCd = 0;
		z.rushSpeed = 5;
	}
	if (typeId === 5) {
		z.jumpReady = true;
		z.jumpCd = 0;
		z.jumpHeight = 0;
	}
	if (typeId === 2) {
		z.attackCd = 0;
		z.headX = 0;
	}
	if (typeId === 3) {
		z.fuse = -1;
	}
	return z;
}

export function createBoss(typeId: number, x: number, y: number): BossState {
	const b: BossState = {
		id: nextId++,
		type: typeId,
		x,
		y,
		hp: 10000,
		hpMax: 10000,
		hpRecover: typeId === 3 ? 1.5 : 1,
		damage: typeId === 1 ? 3 : 25,
		exp: typeId === 1 ? 1000 : typeId === 2 ? 800 : 10,
		moveSpeed: typeId === 1 ? 22 : typeId === 3 ? 14 : typeId === 4 ? 8 : 0,
		angle: 0,
		attackCd: 0,
		dead: false,
	};
	if (typeId === 1) {
		const bodyX: Array<number> = [];
		const bodyY: Array<number> = [];
		for (let i = 0; i < 50; i++) {
			bodyX.push(x);
			bodyY.push(y);
		}
		b.bodyX = bodyX;
		b.bodyY = bodyY;
		b.bodyNumber = 50;
		b.movePos = 0;
	}
	if (typeId === 3) {
		b.moveCycle = 0;
	}
	if (typeId === 4) {
		b.moveCount = 40;
		b.moveDir = rnd() * math.pi * 2;
		b.attack = false;
	}
	return b;
}

export { damageCal, DESIGN };
