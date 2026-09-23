import { damageCal, rnd, rndRange } from "shared/engine/rng";
import { DESIGN } from "shared/engine/constants";
import { difficultyOfDay } from "shared/game/save";
import { zombieDef } from "shared/data/zombies";

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
	/** px/frame @30fps (multiply by SPEED_SCALE for px/s) */
	moveSpeed: number;
	exp: number;
	/** heading it wants to face (radians) */
	angle: number;
	/** heading actually drawn: turns towards `angle` at 150°/s, snaps on rush/jump/knockback */
	angleSlow: number;
	detect: boolean;
	/** seconds left of the "!" bubble */
	detectShow: number;
	/** seconds of stun left (no voluntary movement; knockback still applies) */
	stunned: number;
	attacked: boolean;
	iframe: number;
	/** knockback speed in px/frame @30fps (decays by DESIGN.REACTION_FRICTION per second, max 9) */
	reactionSpeed: number;
	reactionDir: number;
	wanderTimer: number;
	wanderDir: number;
	wave: boolean;
	// --- senses, memory and pack (shared/sim/ai/*): the original has none of this ------------------
	/** last position where the target was perceived, or credibly reported (noise, shout, a bullet) */
	lastSeenX?: number;
	lastSeenY?: number;
	/** seconds since the target was last perceived */
	lostFor?: number;
	/** seconds left of the search around the last known position; undefined = not searching */
	searchTimer?: number;
	/** seconds until the next line-of-sight ray (LOD budget, docs/MULTIPLAYER.md §3.4) */
	losCd?: number;
	/** result of the last line-of-sight ray, reused until `losCd` runs out */
	losClear?: boolean;
	/**
	 * Heading decided by the last navigation step, and the seconds left before it is recomputed. The LOD ring
	 * (docs/MULTIPLAYER.md §3.4) sets that interval: the body keeps walking `navDir` every tick meanwhile.
	 */
	navDir?: number;
	navCd?: number;
	/** best path cost (in flow-field cells) this zombie has reached, and how long it has not improved on it */
	bestCells?: number;
	jamT?: number;
	/** seconds left of "walk around the building instead of queueing", and which way round */
	orbit?: number;
	orbitSide?: number;
	/** seconds until this zombie may shout again (group alert) */
	alertCd?: number;
	/** seconds left of a shout: renderer may draw a louder "!" and the audio owner a roar */
	shout?: number;
	/** seconds left of a sidestep (spitter kiting, charger looking for a clear lane) */
	strafe?: number;
	/** which way that sidestep goes: +1 or −1 */
	strafeSide?: number;
	// --- telegraphed attack (the original bites the instant it touches you) -----------------------
	/** seconds left of the bite wind-up; the body leans back while > 0 and cannot damage anyone */
	windup?: number;
	/** how long the current wind-up lasts, so the view can normalise it to 0…1 */
	windupMax?: number;
	/** seconds left of a heavy-hit stagger (the view flinches; the zombie cannot act) */
	stagger?: number;
	/** 0..1 visibility (darkness/lights), eased by the AI; renderer multiplies by it */
	alpha: number;
	/** walk-cycle phase (rad), advanced by the AI while moving; renderer animates feet with it */
	feetCycle?: number;
	/** 1 → 0 after a hit; renderer flashes/outlines while > 0 */
	hitFlash?: number;
	/** visual + hitbox scale (big variant = 1.4) */
	scale?: number;
	/** true while the wander timer is a pause (standing still) */
	wanderPause?: boolean;
	// spitter
	attackCd?: number;
	/** head wind-up 0..10 before spitting (renderer may pull the head back by it) */
	headX?: number;
	/** where the spit will be aimed (predicted player position) */
	aimX?: number;
	aimY?: number;
	// exploder
	/** seconds until the dead exploder blows up; -1 = not lit */
	fuse?: number;
	// charger
	rush?: boolean;
	rushReady?: boolean;
	rushCd?: number;
	rushSpeed?: number;
	rushDir?: number;
	/** seconds spent in the current rush */
	rushTime?: number;
	backstep?: boolean;
	/** charges that found no clear lane in a row; after a few the charger repositions instead */
	rushFail?: number;
	// jumper
	jumping?: boolean;
	jumpReady?: boolean;
	/** seconds until the next take-off is allowed (counted from the previous take-off) */
	jumpCd?: number;
	jumpDir?: number;
	jumpTargetX?: number;
	jumpTargetY?: number;
	/** visual lift in world px while airborne (renderer offsets sprite/shadow) */
	jumpHeight?: number;
	/** planned length and distance already covered by the current jump */
	jumpLength?: number;
	jumpTravel?: number;
	jumpAir?: number;
	special: boolean;
}

/** base zombie collision radius; the renderer should draw bodies about this big (× scale) */
export const ZOMBIE_BASE_RADIUS = 16;

export function zombieRadius(z: ZombieState): number {
	return zombieDef(z.type).radius * (z.scale ?? 1);
}

export interface BossState {
	id: number;
	type: number;
	x: number;
	y: number;
	hp: number;
	hpMax: number;
	/** hp regenerated per second (original: per frame × 30) */
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

/** hit radius of the centipede (boss 1) body segments — original body_width 120 → 60, trimmed */
export const BOSS1_SEGMENT_RADIUS = 34;

/**
 * Hit/contact radius of a boss body (world units). Boss 1 is a chain of segments: use
 * BOSS1_SEGMENT_RADIUS on bodyX/bodyY instead. Renderer should draw bosses about this big.
 */
export function bossHitRadius(b: BossState): number {
	if (b.type === 1) return BOSS1_SEGMENT_RADIUS + 6;
	if (b.type === 2) return 65;
	if (b.type === 3) return 45;
	return 38;
}

let nextId = 1;

export function resetEntityIds(): void {
	nextId = 1;
}

export function createZombie(typeId: ZombieType, x: number, y: number, day: number, wave = false): ZombieState {
	const d = difficultyOfDay(day);
	const b = zombieDef(typeId);
	let sp = b.speed * (1 + d / 3);
	let hp = math.floor(b.hp * (1 + d));
	let scale = 1;
	// walker variants (obj_zombie Create): 10% fast & frail from day 2, 5% big & tough from day 3
	if (typeId === 1 && day > 1 && rnd() * 10 < 1) {
		sp *= 2;
		hp = math.floor(hp / 2);
	} else if (typeId === 1 && day > 2 && rnd() * 20 < 1) {
		hp = math.floor(hp * 1.5);
		scale = 1.4;
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
		// 10% of the walkers already hunt the player when they appear (obj_zombie "random detect") —
		// but not on day 1, so the first daylight is about noise/proximity (the first hunter used to
		// reach a brand-new player ~11 s after pressing Play)
		detect: typeId === 1 && day > 1 && rnd() * 10 < 1,
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
		feetCycle: 0,
		hitFlash: 0,
		scale,
		special: typeId !== 1,
	};
	z.angleSlow = z.angle;
	if (typeId === 4) {
		z.damageRush = math.floor(b.rushDamage * (1 + d));
		z.rushReady = true;
		z.rushCd = 0;
		z.rushSpeed = 5;
		z.rushTime = 0;
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

/** XP per boss: centipede 1000, tentacle 800, charger 800, needle 1000 (the original's 3/4 gave 10 by a bug) */
const BOSS_EXP: Record<number, number> = { 1: 1000, 2: 800, 3: 800, 4: 1000 };

export function createBoss(typeId: number, x: number, y: number): BossState {
	const b: BossState = {
		id: nextId++,
		type: typeId,
		x,
		y,
		hp: 10000,
		hpMax: 10000,
		// original: +1 hp per frame (+1.5 for boss 3) → per second
		hpRecover: (typeId === 3 ? 1.5 : 1) * 30,
		damage: typeId === 1 ? 3 : 25,
		exp: BOSS_EXP[typeId] ?? 800,
		moveSpeed: typeId === 1 ? 22 : typeId === 3 ? 14 : typeId === 4 ? 8 : 0,
		angle: 0,
		attackCd: 0,
		dead: false,
		hitFlash: 0,
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
