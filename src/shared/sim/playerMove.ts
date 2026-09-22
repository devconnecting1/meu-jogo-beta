/*
 * stepPlayer: one step of a survivor's own simulation — movement (moveActor, speed from skills, equipment, buffs,
 * hunger, hits and acid, plus knockback), hunger, regeneration, poison, buff timers and i-frames.
 *
 * Deterministic: the result depends only on (world, player, save, command, dt). No Instances, no services, no random
 * numbers, no getCtx — so the client predicts with it and the server simulates the same command with the very same
 * code (docs/MULTIPLAYER.md §2.2, §11.2 "GameLoop.updatePlayer → shared/sim/playerMove.ts").
 *
 * Moved as-is from GameLoop.updatePlayer (HEAD 2f48f55); tools/test-sim.mjs replays 300 commands twice and against a
 * copy of that original code.
 */
import { DESIGN } from "shared/engine/constants";
import { clamp } from "shared/engine/vec2";
import { moveActor, PLAYER_RADIUS } from "shared/game/physics";
import { PlayerState, recalcMoveSpeed } from "shared/game/player";
import { PlayerSaveData } from "shared/game/save";
import { WorldData } from "shared/game/world";
import { aimOf, InputCommand, moveDirX, moveDirY, SPEED_SCALE } from "./types";

/** the survivor never leaves [MARGIN, size − MARGIN] of the world */
export const WORLD_MARGIN = 40;
/** below this travelled distance the step does not count as walking (foot cycle, noise) */
export const WALK_EPSILON = 0.05;

export interface StepResult {
	/** distance actually travelled this step (world units) */
	moved: number;
	/** the survivor asked to move and did: drives the walk cycle and the footstep noise */
	walking: boolean;
	/** hp reached 0 in this step (the caller shows the game over) */
	died: boolean;
}

/**
 * Advances `p` by one command. Mutates the survivor (position, hp, hunger, buffs, knockback) and returns what the
 * view needs. `dt` is the step length in seconds (fixed 1/60 from F1 on; the F0 client loop passes its frame time).
 */
export function stepPlayer(
	world: WorldData,
	p: PlayerState,
	save: PlayerSaveData,
	cmd: InputCommand,
	dt: number,
): StepResult {
	p.angle = aimOf(cmd.aim);

	// wanted direction in world space, normalised exactly like the stick vector was before F0
	let wdx = 0;
	let wdy = 0;
	if (cmd.moveMag > 0) {
		const dx = moveDirX(cmd.moveAng);
		const dy = moveDirY(cmd.moveAng);
		const l = math.sqrt(dx * dx + dy * dy);
		if (l > 0.0001) {
			wdx = dx / l;
			wdy = dy / l;
		}
	}
	const speed = recalcMoveSpeed(p, save) * SPEED_SCALE;
	const rx = math.cos(p.reactionDir) * p.reactionSpeed * SPEED_SCALE;
	const ry = math.sin(p.reactionDir) * p.reactionSpeed * SPEED_SCALE;
	if (p.reactionSpeed > 0) {
		p.reactionSpeed = math.max(0, p.reactionSpeed - DESIGN.REACTION_FRICTION * dt);
	}
	const mvx = wdx * speed + rx;
	const mvy = wdy * speed + ry;
	const res =
		p.noclip === true
			? { x: p.x + mvx * dt, y: p.y + mvy * dt }
			: moveActor(world, p.x, p.y, PLAYER_RADIUS, mvx * dt, mvy * dt);
	const moved = math.sqrt((res.x - p.x) * (res.x - p.x) + (res.y - p.y) * (res.y - p.y));
	p.x = clamp(res.x, WORLD_MARGIN, world.width - WORLD_MARGIN);
	p.y = clamp(res.y, WORLD_MARGIN, world.height - WORLD_MARGIN);
	const walking = moved > WALK_EPSILON && (wdx !== 0 || wdy !== 0);

	const hungerRate = 1 - save.skillLevels[8] / 3;
	p.hungry = math.max(0, p.hungry - 0.01 * 30 * hungerRate * dt);
	if (p.hungry <= 0) {
		p.hp -= 0.02 * 30 * dt;
	} else if (p.hp < p.hpMax) {
		p.hp = math.min(p.hpMax, p.hp + 0.04 * 30 * (1 + save.skillLevels[1]) * dt);
	}
	if (p.buffs.poison > 0) {
		p.buffs.poison -= dt;
		p.hp -= 0.06 * 30 * (save.skillLevels[20] > 0 ? 0.5 : 1) * dt;
	}
	if (p.buffs.speed > 0) p.buffs.speed -= dt;
	if (p.buffs.calm > 0) p.buffs.calm -= dt;
	if (p.buffs.pain > 0) p.buffs.pain -= dt;
	if (p.attacked) {
		p.iframe -= dt;
		if (p.iframe <= 0) {
			p.attacked = false;
			p.iframe = 0;
		}
	}
	let died = false;
	if (p.hp <= 0 && !p.dead) {
		p.hp = 0;
		p.dead = true;
		died = true;
	}
	return { moved, walking, died };
}
