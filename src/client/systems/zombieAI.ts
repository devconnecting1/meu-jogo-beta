import { MP_PHASE } from "shared/net/mpConfig";
import { PlayerSaveData } from "shared/game/save";
import { Solid, WorldData } from "shared/game/world";
import { FlowField } from "shared/game/physics";
import * as Ctx from "shared/sim/ai/context";
import * as Brain from "shared/sim/ai/zombieBrain";
import { GameRefs } from "./types";

/*
 * The client's side of the zombie simulation (docs/MULTIPLAYER.md §11.3 F2).
 *
 * The AI itself is gone from here: it lives in shared/sim/ai/zombieBrain.ts, which the authoritative server
 * tick (server/sim/zombies.ts) runs on the very same code. What is left is the adapter — a GameRefs turned
 * into an AiRefs, and the single-source flow field centred on the local survivor — plus the API the rest of
 * the client already calls (combat.ts, the admin overlay).
 *
 * With MP_PHASE >= 2 the client simulates NOTHING: the horde comes from the server's snapshots (F2-2D) and
 * every entry point here is a no-op. Until then (MP_PHASE = 1) this is the game exactly as it was, one world
 * per client — which is why two players still see different hordes before 2D lands.
 */

/** flow field refresh: a new field is started every 0.4 s and built over a few frames */
const FLOW_INTERVAL = 0.4;
const FLOW_BUDGET = 800;

const flow = new FlowField();
const state = Ctx.newBrainState();
let flowTimer = 0;
let flowSolidCount = -1;
let flowWorld: WorldData | undefined;
/** the GameRefs the cached context currently mirrors */
let bound: GameRefs | undefined;
let ctx: Ctx.AiRefs | undefined;

/** the client only ever simulates its own survivor's world, so every save is the local one */
const localSave = (): PlayerSaveData => (bound as GameRefs).save;
const localExp = (amount: number): void => (bound as GameRefs).onExp(amount);

/**
 * The AiRefs view of this GameRefs. The optional arrays are created up front and SHARED with the refs, so the
 * renderer keeps seeing the puddles, noise rings and blasts the simulation pushes into them.
 *
 * One context for the whole client world: the boss AI and the population (bossAI.ts, spawner.ts) take the same
 * one, so they all read the same flow field, brain state and kill counter.
 */
export function aiContext(refs: GameRefs): Ctx.AiRefs {
	bound = refs;
	refs.puddles ??= [];
	refs.sounds ??= [];
	refs.explosions ??= [];
	if (ctx === undefined) {
		ctx = {
			world: refs.world,
			players: refs.players,
			zombies: refs.zombies,
			bosses: refs.bosses,
			bullets: refs.bullets,
			fx: refs.fx,
			clock: refs.daynight,
			field: flow,
			ai: state,
			saveOf: localSave,
			onExp: localExp,
			puddles: refs.puddles,
			sounds: refs.sounds,
			explosions: refs.explosions,
		};
		return ctx;
	}
	ctx.world = refs.world;
	ctx.players = refs.players;
	ctx.zombies = refs.zombies;
	ctx.bosses = refs.bosses;
	ctx.bullets = refs.bullets;
	ctx.fx = refs.fx;
	ctx.clock = refs.daynight;
	ctx.puddles = refs.puddles;
	ctx.sounds = refs.sounds;
	ctx.explosions = refs.explosions;
	return ctx;
}

/**
 * One window centred on the local survivor, rebuilt every FLOW_INTERVAL over a few frames. The server's field
 * is multi-source and tiled (§3.3, server/sim/flowField.ts); this one keeps the single-player behaviour, and
 * answers `targetOf` with the only survivor it was built for.
 */
function updateFlow(refs: GameRefs, dt: number): void {
	if (flowWorld !== refs.world) {
		flowWorld = refs.world;
		flow.valid = false;
		flowTimer = 0;
		flowSolidCount = -1;
	}
	flowTimer -= dt;
	const count = refs.world.solids.size();
	let hunting = false;
	for (const z of refs.zombies) {
		if (z.detect) {
			hunting = true;
			break;
		}
	}
	if (!hunting) return;
	if (!flow.building && (flowTimer <= 0 || count !== flowSolidCount || !flow.valid)) {
		flowTimer = FLOW_INTERVAL;
		flowSolidCount = count;
		flow.targetIndex = math.max(0, refs.players.indexOf(refs.player));
		flow.startRebuild(refs.world, refs.player.x, refs.player.y);
		if (!flow.valid) flow.step(1e9); // the very first field is built at once
	}
	if (flow.building) flow.step(FLOW_BUDGET);
}

/** the chase flow field (read-only use: the admin panel's debug overlay draws it) */
export function debugFlowField(): FlowField {
	return flow;
}

export const actorDist = Ctx.actorDist;
export const applyKnockback = Brain.applyKnockback;
export const reactToHit = Brain.reactToHit;
export const seedHunt = Brain.seedHunt;

/** kills since the last call, then resets: the pacing director's "they are winning" signal */
export function takeKills(): number {
	return Brain.takeKills(state);
}

/** spitter acid lands: a puddle that halves the player's speed while they stand in it */
export function addPuddle(refs: GameRefs, x: number, y: number): void {
	Brain.addPuddle(aiContext(refs), x, y);
}

/** emit a noise ring (obj_sound / obj_sound_shot): the zombies it reaches go and look */
export function emitSound(refs: GameRefs, x: number, y: number, rMax: number, shot: boolean, unique = false): void {
	Brain.emitSound(aiContext(refs), x, y, rMax, shot, unique);
}

/** a zombie (or blast) hits a player construction; destroyed ones leave the world for real */
export function damageStructure(refs: GameRefs, s: Solid, dmg: number): void {
	Brain.damageStructure(aiContext(refs), s, dmg);
}

/**
 * Zombie AI + physics for one frame. With MP_PHASE >= 2 the server owns the horde and this does nothing:
 * the client must never simulate a zombie it does not own, or the two worlds drift apart again.
 */
export function updateZombies(refs: GameRefs, dt: number): void {
	if (MP_PHASE >= 2) return;
	const c = aiContext(refs);
	updateFlow(refs, dt);
	Brain.updateZombies(c, dt);
}
