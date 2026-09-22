import type { Bullet, BossState, PlayerState, PlayerSaveData, WorldData, ZombieState } from "shared/game";
import type { InputState } from "shared/engine/input";
import type { DayNight } from "./daynight";
import type { ParticleSystem } from "./particles";

export const SPEED_SCALE = 30;

export interface Tracer {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	color: Color3;
	life: number;
}

/** spitter acid puddle on the ground: slows the player while inside it */
export interface Puddle {
	x: number;
	y: number;
	r: number;
	life: number;
	lifeMax: number;
}

/** expanding noise ring: zombies it reaches start chasing (daytime stealth) */
export interface SoundRing {
	x: number;
	y: number;
	r: number;
	rMax: number;
	shot: boolean;
}

/** blast of a dead exploder: grows to rMax, hurting the player while the front passes over them */
export interface Explosion {
	x: number;
	y: number;
	r: number;
	rMax: number;
	/** seconds the (already full-size) blast stays drawable */
	life: number;
}

export interface GameRefs {
	world: WorldData;
	player: PlayerState;
	save: PlayerSaveData;
	input: InputState;
	zombies: Array<ZombieState>;
	bosses: Array<BossState>;
	bullets: Array<Bullet>;
	particles: ParticleSystem;
	daynight: DayNight;
	tracers: Array<Tracer>;
	pendingPlace: number;
	/** CRAFT_RECIPES id that produced pendingPlace (so cancelling refunds the right ingredients) */
	pendingRecipe?: number;
	announceQueue: Array<string>;
	onMessage: (msg: string) => void;
	onExp: (amount: number) => void;
	/** created lazily by the AI/combat systems; the renderer draws them when present */
	puddles?: Array<Puddle>;
	sounds?: Array<SoundRing>;
	/** exploder blasts (zombieAI); optional for the renderer (particles + camera shake already sell it) */
	explosions?: Array<Explosion>;
}
