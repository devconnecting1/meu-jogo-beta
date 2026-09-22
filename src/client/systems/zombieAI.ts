import { COLORS } from "shared/engine/colors";
import { DESIGN } from "shared/engine/constants";
import { chance, choose, rndRange } from "shared/engine/rng";
import { damageToPlayer } from "shared/game/player";
import { pointInSolid, rectHitsSolid, Solid, spawnGroundItem, WorldData } from "shared/game/world";
import { ZombieState } from "shared/game/entities";
import { BUILDING_SPAWNS } from "shared/data/spawns";
import { GameRefs, SPEED_SCALE } from "./types";

const BODY = 36;
const CONTACT = 26;
const STEP_OFFS: Array<number> = [0, 0.4, -0.4, 0.9, -0.9, 1.5, -1.5, 2.2, -2.2];

export function actorDist(ax: number, ay: number, bx: number, by: number): number {
	const dx = ax - bx;
	const dy = ay - by;
	return math.sqrt(dx * dx + dy * dy);
}

function hasLos(world: WorldData, x0: number, y0: number, x1: number, y1: number): boolean {
	const dx = x1 - x0;
	const dy = y1 - y0;
	const d = math.sqrt(dx * dx + dy * dy);
	if (d < 1) return true;
	const steps = math.floor(d / 24);
	for (let i = 1; i <= steps; i++) {
		const t = i / steps;
		const s = pointInSolid(world, x0 + dx * t, y0 + dy * t);
		if (s !== undefined && !(s.kind === "door" && s.open)) return false;
	}
	return true;
}

function stepWithAvoidance(
	world: WorldData,
	x: number,
	y: number,
	ang: number,
	dist: number,
): { x: number; y: number; blocked?: Solid } {
	let first: Solid | undefined;
	for (const off of STEP_OFFS) {
		const a = ang + off;
		const nx = x + math.cos(a) * dist;
		const ny = y + math.sin(a) * dist;
		const hit = rectHitsSolid(world, nx, ny, BODY, BODY);
		if (hit === undefined) {
			return { x: nx, y: ny };
		}
		if (first === undefined) first = hit;
	}
	return { x, y, blocked: first };
}

function findTrap(world: WorldData, x: number, y: number): Solid | undefined {
	for (const s of world.solids) {
		if (s.tags !== "trap" && s.tags !== "trap_electric") continue;
		if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return s;
	}
	return undefined;
}

function dropLoot(refs: GameRefs, x: number, y: number): void {
	const rate = 10 + refs.save.skillLevels[9] * 10;
	if (!chance(rate)) return;
	const e = choose(BUILDING_SPAWNS[0]);
	let count = 1;
	if (e.max >= 1) {
		count = math.max(1, math.floor(e.min + math.random() * (e.max - e.min + 1)));
	}
	spawnGroundItem(refs.world, e.kind, e.index, count, x, y);
}

function killZombie(refs: GameRefs, z: ZombieState): void {
	refs.onExp(z.exp);
	refs.particles.bloodBurst(z.x, z.y, 10);
	dropLoot(refs, z.x, z.y);
}

function damageStructure(hit: Solid, dmg: number): void {
	if (!hit.destructible) return;
	hit.hp -= dmg;
}

function moveZombie(
	refs: GameRefs,
	z: ZombieState,
	ang: number,
	speed: number,
	dt: number,
	ignoreSolids: boolean,
): Solid | undefined {
	const rvx = math.cos(z.reactionDir) * z.reactionSpeed;
	const rvy = math.sin(z.reactionDir) * z.reactionSpeed;
	const vx = math.cos(ang) * speed + rvx;
	const vy = math.sin(ang) * speed + rvy;
	const dist = math.sqrt(vx * vx + vy * vy) * SPEED_SCALE * dt;
	if (dist <= 0) return undefined;
	if (ignoreSolids) {
		z.x += vx * SPEED_SCALE * dt;
		z.y += vy * SPEED_SCALE * dt;
		return undefined;
	}
	const useAng = math.atan2(vy, vx);
	const res = stepWithAvoidance(refs.world, z.x, z.y, useAng, dist);
	z.x = res.x;
	z.y = res.y;
	z.angle = useAng;
	return res.blocked;
}

function wanderSpeed(z: ZombieState, dt: number): number {
	z.wanderTimer -= dt;
	if (z.wanderTimer <= 0) {
		z.wanderTimer = rndRange(1, 2);
		z.wanderDir = math.random() * math.pi * 2;
	}
	return z.moveSpeed * 2 * 0.3333333;
}

function updateDetect(refs: GameRefs, z: ZombieState, distP: number): void {
	if (refs.daynight.isNight || refs.daynight.isRaining || distP < 50) {
		z.detect = true;
	}
	if (distP > DESIGN.DEACTIVE_RANGE) {
		z.detect = false;
	}
}

export function applyKnockback(z: ZombieState, fromAngle: number, power: number): void {
	z.reactionDir = fromAngle;
	z.reactionSpeed = math.min(9, z.reactionSpeed + power);
}

function attackPlayer(refs: GameRefs, z: ZombieState): void {
	const p = refs.player;
	const ang = math.atan2(p.y - z.y, p.x - z.x);
	damageToPlayer(p, refs.save, z.damage);
	p.reactionDir = ang;
	z.stunned = 1;
}

function updateSpitter(refs: GameRefs, z: ZombieState, dt: number, distP: number): void {
	z.attackCd = (z.attackCd ?? 0) - dt;
	if (z.detect && distP < 400 && (z.attackCd ?? 0) <= 0) {
		z.attackCd = 6;
		const ang = math.atan2(refs.player.y - z.y, refs.player.x - z.x);
		refs.bullets.push({
			id: -(refs.bullets.size() + 1),
			x: z.x,
			y: z.y,
			angle: ang,
			range: 420,
			travel: 0,
			damage: z.damage,
			speed: 360,
			kind: "arrow",
			alive: true,
			fromPlayer: false,
			alpha: 1,
			life: 2,
		});
	}
}

function updateCharger(refs: GameRefs, z: ZombieState, dt: number, distP: number): void {
	if (z.rush === true) {
		z.attackCd = (z.attackCd ?? 0) - dt;
		z.rushSpeed = math.min(25, (z.rushSpeed ?? 5) + 10 * dt);
		if ((z.attackCd ?? 0) <= 0) {
			z.rush = false;
			z.rushCd = 3;
			z.rushSpeed = 5;
		}
		return;
	}
	z.rushCd = (z.rushCd ?? 0) - dt;
	if (z.detect && (z.rushCd ?? 0) <= 0 && distP > 100) {
		const p = refs.player;
		if (hasLos(refs.world, z.x, z.y, p.x, p.y)) {
			z.rush = true;
			z.attackCd = 2;
			z.rushSpeed = 5;
			z.rushDir = math.atan2(p.y - z.y, p.x - z.x);
		}
	}
}

function updateJumper(refs: GameRefs, z: ZombieState, dt: number, distP: number): void {
	const p = refs.player;
	if (distP < 30) {
		p.buffs.poison = 30;
	}
	if (z.jumping === true) {
		const tx = z.jumpTargetX ?? z.x;
		const ty = z.jumpTargetY ?? z.y;
		const d = actorDist(z.x, z.y, tx, ty);
		z.jumpHeight = math.min(40, (z.jumpHeight ?? 0) + 160 * dt);
		if (d < 10) {
			z.jumping = false;
			z.jumpHeight = 0;
			z.jumpCd = 2.7;
		} else {
			const ang = math.atan2(ty - z.y, tx - z.x);
			const step = 660 * dt;
			z.x += math.cos(ang) * step;
			z.y += math.sin(ang) * step;
		}
		return;
	}
	z.jumpHeight = 0;
	z.jumpCd = (z.jumpCd ?? 0) - dt;
	if (z.detect && (z.jumpCd ?? 0) <= 0 && distP < 520) {
		const ang = math.atan2(p.y - z.y, p.x - z.x);
		const reach = math.min(200, distP);
		z.jumping = true;
		z.jumpTargetX = z.x + math.cos(ang) * reach;
		z.jumpTargetY = z.y + math.sin(ang) * reach;
		z.jumpHeight = 0;
	}
}

function updateExplosive(refs: GameRefs, z: ZombieState, dt: number): boolean {
	if ((z.fuse ?? -1) < 0) {
		z.fuse = 0.83;
	}
	z.fuse = (z.fuse ?? 0.83) - dt;
	if (z.fuse > 0) return false;
	const p = refs.player;
	const d = actorDist(p.x, p.y, z.x, z.y);
	if (d < 160) {
		damageToPlayer(p, refs.save, 6, true);
		p.reactionDir = math.atan2(p.y - z.y, p.x - z.x);
	}
	refs.particles.debrisBurst(z.x, z.y, 16, COLORS.blood);
	refs.onExp(z.exp);
	dropLoot(refs, z.x, z.y);
	return true;
}

export function updateZombies(refs: GameRefs, dt: number): void {
	const p = refs.player;
	for (let i = refs.zombies.size() - 1; i >= 0; i--) {
		const z = refs.zombies[i];

		if (z.hp <= 0) {
			if (z.type === 3) {
				const exploded = updateExplosive(refs, z, dt);
				if (exploded) {
					refs.zombies.remove(i);
				}
			} else {
				killZombie(refs, z);
				refs.zombies.remove(i);
			}
			continue;
		}

		if (z.reactionSpeed > 0) {
			z.reactionSpeed = math.max(0, z.reactionSpeed - DESIGN.REACTION_FRICTION * dt);
		}
		if (z.stunned > 0) {
			z.stunned -= dt;
			continue;
		}

		const distP = actorDist(z.x, z.y, p.x, p.y);
		updateDetect(refs, z, distP);

		if (z.type === 2) updateSpitter(refs, z, dt, distP);
		if (z.type === 4) updateCharger(refs, z, dt, distP);
		if (z.type === 5) updateJumper(refs, z, dt, distP);

		let targetX = p.x;
		let targetY = p.y;
		let chasing = z.detect;
		let forceTarget = false;
		if (z.type === 1) {
			const fromSpawn = actorDist(z.x, z.y, z.spawnX, z.spawnY);
			if (fromSpawn > 2000 && distP > 600) {
				chasing = false;
				forceTarget = true;
				targetX = z.spawnX;
				targetY = z.spawnY;
			}
		}
		if (z.type === 2 && distP < 360) {
			chasing = false;
		}

		let ang: number;
		let speed: number;
		if (chasing || forceTarget) {
			ang = math.atan2(targetY - z.y, targetX - z.x);
			speed = z.moveSpeed;
		} else {
			speed = wanderSpeed(z, dt);
			ang = z.wanderDir;
		}

		if (z.type === 4 && z.rush === true) {
			ang = z.rushDir ?? ang;
			speed = z.rushSpeed ?? speed;
		} else if (z.type === 4 && chasing && distP < 110) {
			ang = math.atan2(z.y - p.y, z.x - p.x);
			speed = z.moveSpeed;
		}

		const ignore = z.type === 5 && z.jumping === true;
		const blocked = moveZombie(refs, z, ang, speed, dt, ignore);

		if (blocked !== undefined && chasing) {
			damageStructure(blocked, z.damage * dt * 2);
		}

		const distAfter = actorDist(z.x, z.y, p.x, p.y);
		if (distAfter < CONTACT) {
			attackPlayer(refs, z);
		}

		if (!ignore && findTrap(refs.world, z.x, z.y) !== undefined && chance(40)) {
			z.stunned = math.max(z.stunned, 7 / 30);
		}
	}
}
