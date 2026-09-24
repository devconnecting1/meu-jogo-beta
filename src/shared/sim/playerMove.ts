/*
 * stepPlayer: one step of a survivor's own simulation — movement (moveActor, speed from skills, equipment, buffs,
 * hunger, hits and acid, plus knockback; a mounted survivor moves with the vehicle's handling instead,
 * shared/sim/vehicle.ts), hunger, regeneration, poison, buff timers and i-frames.
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
import { maxHpOf, PlayerState, recalcMoveSpeed } from "shared/game/player";
import { PlayerSaveData } from "shared/game/save";
import { WorldData } from "shared/game/world";
import { aimOf, InputCommand, moveDirX, moveDirY, SPEED_SCALE } from "./types";
import { stepRide } from "./vehicle";

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
	/**
	 * Mounted only (VEI-05): the speed, u/s, of a head-on crash into a solid this step. The step already stopped the
	 * vehicle (and the client predicted that); what the crash COSTS is the server's (server/sim/vehicles.ts).
	 */
	crash?: number;
}

/** what a step of a body that is already dead returns: it goes nowhere, and it does not die a second time */
const LIFELESS: StepResult = { moved: 0, walking: false, died: false };
/**
 * What every other step returns: ONE table owned by this module, overwritten by the next step (six survivors at
 * 60 Hz on the server, and every command the prediction replays, used to make a table each). Read it at once and
 * never keep it -- a caller that collects results copies them.
 */
const STEP: StepResult = { moved: 0, walking: false, died: false };

/**
 * Advances `p` by one command. Mutates the survivor (position, hp, hunger, buffs, knockback) and returns what the
 * view needs. `dt` is the step length in seconds (fixed 1/60 from F1 on; the F0 client loop passes its frame time).
 *
 * A DEAD body is inert: the command is consumed as if it were standing still, and nothing else moves either --
 * no turning, no knockback, no hunger, no regeneration. Before this it kept walking (security review, Sep 2026):
 * the server consumed the dead survivor's commands like anyone's, the zombies ignore the dead, and the interest
 * rings and the proximity chat follow the body, so a corpse was an invulnerable scout for its team. It also
 * regenerated from 0 hp while lying there. The server and the client's prediction run this very function, so
 * both stop together (tools/test-server-sim.mjs, tools/test-predict.mjs).
 */
export function stepPlayer(
	world: WorldData,
	p: PlayerState,
	save: PlayerSaveData,
	cmd: InputCommand,
	dt: number,
): StepResult {
	if (p.dead) return LIFELESS;
	p.angle = aimOf(cmd.aim);

	let moved: number;
	let walking: boolean;
	let crash = 0;
	if (p.ride !== undefined) {
		// mounted (VEI-05): the vehicle's handling replaces the walk; everything after the movement is the same
		const x0 = p.x;
		const y0 = p.y;
		crash = stepRide(world, p, save, cmd, dt);
		p.x = clamp(p.x, WORLD_MARGIN, world.width - WORLD_MARGIN);
		p.y = clamp(p.y, WORLD_MARGIN, world.height - WORLD_MARGIN);
		moved = math.sqrt((p.x - x0) * (p.x - x0) + (p.y - y0) * (p.y - y0));
		walking = false;
	} else {
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
		moved = math.sqrt((res.x - p.x) * (res.x - p.x) + (res.y - p.y) * (res.y - p.y));
		p.x = clamp(res.x, WORLD_MARGIN, world.width - WORLD_MARGIN);
		p.y = clamp(res.y, WORLD_MARGIN, world.height - WORLD_MARGIN);
		walking = moved > WALK_EPSILON && (wdx !== 0 || wdy !== 0);
	}

	// Health (skill 0) learnt mid-life raises the bar now, as in the original's every-step hp_max (QA K2); the hp
	// already there stays, and regeneration fills the new room
	const hpMax = maxHpOf(save);
	if (p.hpMax !== hpMax) {
		p.hpMax = hpMax;
		if (p.hp > hpMax) p.hp = hpMax;
	}

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
	STEP.moved = moved;
	STEP.walking = walking;
	STEP.died = died;
	STEP.crash = crash > 0 ? crash : undefined;
	return STEP;
}
