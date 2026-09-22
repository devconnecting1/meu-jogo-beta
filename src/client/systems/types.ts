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
	announceQueue: Array<string>;
	onMessage: (msg: string) => void;
	onExp: (amount: number) => void;
}
