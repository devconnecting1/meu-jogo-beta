import type { Bullet, BossState, PlayerState, PlayerSaveData, WorldData, ZombieState } from "shared/game";
import type { InputState } from "shared/engine/input";
import type { BloodSource, DebrisMaterial, FxEvent, TracerKind } from "shared/sim/types";
import type { DayNight } from "./daynight";

export { SPEED_SCALE } from "shared/sim/types";

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
	/** every survivor in this world (F0: only the local one); the AI targets the nearest living one */
	players: Array<PlayerState>;
	/** players[0], the local survivor: combat, building and interaction act for it */
	player: PlayerState;
	save: PlayerSaveData;
	input: InputState;
	zombies: Array<ZombieState>;
	bosses: Array<BossState>;
	bullets: Array<Bullet>;
	daynight: DayNight;
	pendingPlace: number;
	/** CRAFT_RECIPES id that produced pendingPlace (so cancelling refunds the right ingredients) */
	pendingRecipe?: number;
	/**
	 * pendingPlace came out of the backpack (the Bag's Build tab, DESIGN_RULES ITM-09), not out of a craft: placing it
	 * spends one, cancelling gives nothing back because nothing was taken. Only this client's own world reads it (the
	 * server's cursor keeps its own, server/sim/build.ts)
	 */
	pendingKit?: boolean;
	/**
	 * Cosmetic effects asked for by the systems (shake, blood, debris, tracers, messages). Systems only push; the
	 * gameLoop plays and clears them (docs/MULTIPLAYER.md §11.3 F0).
	 */
	fx: Array<FxEvent>;
	/** HUD message sink: only the gameLoop calls it, when it plays a "message" FxEvent */
	onMessage: (msg: string) => void;
	onExp: (amount: number) => void;
	/** created lazily by the AI/combat systems; the renderer draws them when present */
	puddles?: Array<Puddle>;
	sounds?: Array<SoundRing>;
	/** exploder blasts (zombieAI); optional for the renderer (particles + camera shake already sell it) */
	explosions?: Array<Explosion>;
}

// ---------------------------------------------------------------- survivors

/** the survivor's index in refs.players: the `player` of an FxEvent (its slot from F1 on) */
export function playerSlot(refs: GameRefs, p: PlayerState): number {
	return refs.players.indexOf(p);
}

/** the nearest living survivor to (x, y); refs.player when nobody is alive (a single survivor: always it) */
export function nearestPlayer(refs: GameRefs, x: number, y: number): PlayerState {
	let best = refs.player;
	let bestD = math.huge;
	for (const p of refs.players) {
		if (p.dead) continue;
		const dx = p.x - x;
		const dy = p.y - y;
		const d = dx * dx + dy * dy;
		if (d < bestD) {
			bestD = d;
			best = p;
		}
	}
	return best;
}

// ---------------------------------------------------------------- cosmetic effects (refs.fx)

/** shake the camera of survivor `p` */
export function fxShake(refs: GameRefs, p: PlayerState, magnitude: number, duration: number): void {
	refs.fx.push({ kind: "shake", player: playerSlot(refs, p), magnitude, duration });
}

/** blood spray; `dir` (radians) biases it away from the hit; big bursts (≥ 8) also leave a pool */
export function fxBlood(
	refs: GameRefs,
	x: number,
	y: number,
	count: number,
	source: BloodSource = "zombie",
	dir?: number,
): void {
	refs.fx.push({ kind: "blood", x, y, count, source, dir });
}

/** debris (wood chips, sparks, dust) */
export function fxDebris(refs: GameRefs, x: number, y: number, count: number, material: DebrisMaterial): void {
	refs.fx.push({ kind: "debris", x, y, count, material });
}

/** a shot line that fades over `life` seconds (it also lights the night briefly) */
export function fxTracer(
	refs: GameRefs,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	tracer: TracerKind,
	life: number,
): void {
	refs.fx.push({ kind: "tracer", x1, y1, x2, y2, tracer, life });
}

/** HUD message for survivor `p`, or for everyone when `p` is undefined */
export function fxMessage(refs: GameRefs, text: string, p?: PlayerState): void {
	refs.fx.push({ kind: "message", text, player: p !== undefined ? playerSlot(refs, p) : undefined });
}
