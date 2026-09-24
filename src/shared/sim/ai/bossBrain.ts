import { choose, rndRange } from "shared/engine/rng";
import { angleDiff } from "shared/engine/vec2";
import { BOSS1_SEGMENT_RADIUS, bossHitRadius, BossState } from "shared/game/entities";
import { spawnGroundItem } from "shared/game/world";
import { circleBlocked, PLAYER_RADIUS } from "shared/game/physics";
import { BOSS_TROPHIES, BUILDING_SPAWNS } from "shared/data/spawns";
import { SPEED_SCALE } from "shared/sim/types";
import * as Ctx from "shared/sim/ai/context";

/*
 * The four bosses (docs/MULTIPLAYER.md §3.1 step 2, §11.2). Each one chases the nearest living survivor and
 * hurts whoever it touches; the cosmetics go out as FxEvents. Like the zombie brain, this runs unchanged in
 * the client world (MP_PHASE < 2) and in the authoritative server tick.
 */

const fanCounters = new Map<number, number>();

function pushNeedle(refs: Ctx.AiRefs, x: number, y: number, angle: number, damage: number, speed: number): void {
	refs.bullets.push({
		id: -(100001 + refs.bullets.size()),
		x,
		y,
		angle,
		range: 900,
		travel: 0,
		damage,
		speed,
		kind: "arrow",
		alive: true,
		fromPlayer: false,
		alpha: 1,
		life: 3,
	});
}

/** XP (1000/800/800/1000 — see createBoss), message, blood and six loot drops */
function killBoss(refs: Ctx.AiRefs, b: BossState): void {
	refs.onExp(b.exp, b.x, b.y);
	Ctx.fxMessage(refs, "You killed it");
	Ctx.fxBlood(refs, b.x, b.y, 30);
	Ctx.fxDebris(refs, b.x, b.y, 20, "boss");
	fanCounters.delete(b.id);
	// an admin's spawn pays nobody (docs/MULTIPLAYER.md §10): no loot, no trophy
	if (b.unpaid === true) return;
	for (let i = 0; i < 6; i++) {
		const e = choose(BUILDING_SPAWNS[0]);
		let count = 1;
		if (e.max >= 1) {
			count = math.max(1, math.floor(e.min + math.random() * (e.max - e.min + 1)));
		}
		const a = rndRange(0, math.pi * 2);
		const r = rndRange(20, 80);
		spawnGroundItem(refs.world, e.kind, e.index, count, b.x + math.cos(a) * r, b.y + math.sin(a) * r);
	}
	// and its trophy, as in the original (shared/data/spawns.ts BOSS_TROPHIES): the one source of the Flamethrower
	// and the Plastic armor
	for (const t of BOSS_TROPHIES[b.type] ?? []) spawnGroundItem(refs.world, t.kind, t.index, t.count, b.x, b.y);
	fanCounters.delete(b.id);
}

function moveToward(b: BossState, tx: number, ty: number, speed: number, dt: number): void {
	const ang = math.atan2(ty - b.y, tx - b.x);
	b.angle = ang;
	b.x += math.cos(ang) * speed * SPEED_SCALE * dt;
	b.y += math.sin(ang) * speed * SPEED_SCALE * dt;
}

/** body contact damage: whoever the boss touches takes it, with their own armour */
function touchDamage(refs: Ctx.AiRefs, b: BossState, reach: number): void {
	for (const p of refs.players) {
		if (Ctx.actorDist(p.x, p.y, b.x, b.y) >= reach) continue;
		const ang = math.atan2(p.y - b.y, p.x - b.x);
		if (Ctx.hurtPlayer(refs, p, refs.saveOf(p), b.damage)) {
			p.reactionDir = ang;
			// from the boss through the survivor it touched (ART-15): the one blood of this hit
			Ctx.fxBlood(refs, p.x, p.y, 3, "player", ang);
		}
	}
}

/** the living survivor a boss is after, or players[0] when everyone is down (it keeps thrashing) */
function targetOf(refs: Ctx.AiRefs, b: BossState): number {
	const i = Ctx.nearestPlayerIndex(refs, b.x, b.y);
	return i < 0 ? 0 : i;
}

function updateSerpent(refs: Ctx.AiRefs, b: BossState, dt: number): void {
	const target = refs.players[targetOf(refs, b)];
	const bodyX = b.bodyX;
	const bodyY = b.bodyY;
	if (bodyX === undefined || bodyY === undefined) return;
	// obj_boss1 steering: the head only turns 4° per body step (2° when not in attack mode, which
	// toggles every 5 s) and wiggles inside 300 px, so it sweeps THROUGH the player in wide arcs
	// instead of homing (the old port homed at 660 px/s and ground the player to death)
	b.attackCd -= dt;
	if (b.attackCd <= 0) {
		b.attackCd = 5;
		b.attack = b.attack === false;
	}
	const stepsPerSec = (b.moveSpeed * SPEED_SCALE) / 30;
	const toP = math.atan2(target.y - b.y, target.x - b.x);
	if (Ctx.actorDist(target.x, target.y, b.x, b.y) < 300) {
		b.angle += rndRange(-1, 1) * math.rad(1) * stepsPerSec * dt;
	} else {
		const rate = math.rad(b.attack === false ? 2 : 4) * stepsPerSec * dt;
		b.angle += math.clamp(angleDiff(b.angle, toP), -rate, rate);
	}
	b.x += math.cos(b.angle) * b.moveSpeed * SPEED_SCALE * dt;
	b.y += math.sin(b.angle) * b.moveSpeed * SPEED_SCALE * dt;
	b.x = math.clamp(b.x, 0, refs.world.width);
	b.y = math.clamp(b.y, 0, refs.world.height);
	const n = bodyX.size();
	const spacing = 30;
	for (let i = 1; i < n; i++) {
		const dx = bodyX[i - 1] - bodyX[i];
		const dy = bodyY[i - 1] - bodyY[i];
		const d = math.sqrt(dx * dx + dy * dy);
		if (d < 1) continue;
		const pull = d - spacing;
		bodyX[i] += (dx / d) * pull;
		bodyY[i] += (dy / d) * pull;
	}
	bodyX[0] = b.x;
	bodyY[0] = b.y;
	// obj_boss1: every 3rd segment grinds a survivor for `damage` hp PER FRAME (head: double),
	// ignoring armour and i-frames → scaled to the frame time here
	for (const p of refs.players) {
		for (let i = 0; i < n; i += 3) {
			const d = Ctx.actorDist(p.x, p.y, bodyX[i], bodyY[i]);
			if (d < BOSS1_SEGMENT_RADIUS + PLAYER_RADIUS * 0.5) {
				const ang = math.atan2(p.y - bodyY[i], p.x - bodyX[i]);
				const perFrame = i === 0 ? b.damage * 2 : b.damage;
				const wasHit = p.attacked;
				Ctx.hurtPlayer(refs, p, refs.saveOf(p), perFrame * SPEED_SCALE * dt, true);
				if (!wasHit) {
					p.reactionDir = ang;
					Ctx.fxBlood(refs, p.x, p.y, 4, "player", ang);
				}
				break;
			}
		}
	}
}

function updateStationary(refs: Ctx.AiRefs, b: BossState, dt: number): void {
	const p = refs.players[targetOf(refs, b)];
	touchDamage(refs, b, bossHitRadius(b) + PLAYER_RADIUS);
	b.attackCd -= dt;
	if (b.attackCd <= 0) {
		b.attackCd = 80 / 30;
		if (Ctx.actorDist(p.x, p.y, b.x, b.y) < 420) {
			const ang = math.atan2(p.y - b.y, p.x - b.x);
			const tx = p.x + math.cos(ang + math.pi) * 90;
			const ty = p.y + math.sin(ang + math.pi) * 90;
			if (circleBlocked(refs.world, tx, ty, PLAYER_RADIUS) === undefined) {
				p.x = tx;
				p.y = ty;
			}
			if (Ctx.hurtPlayer(refs, p, refs.saveOf(p), b.damage)) p.reactionDir = ang + math.pi;
			Ctx.fxTracer(refs, b.x, b.y, p.x, p.y, "boss", 0.3);
			// from the boss through its victim (ART-15), though the grab pulls the survivor the other way
			Ctx.fxBlood(refs, p.x, p.y, 6, "player", ang);
		}
	}
}

function updateChargerBoss(refs: Ctx.AiRefs, b: BossState, dt: number): void {
	const target = refs.players[targetOf(refs, b)];
	b.moveCycle = ((b.moveCycle ?? 0) + dt * 60) % 360;
	const cycle = b.moveCycle;
	let speed = 14 / 6;
	if (cycle <= 180) {
		speed = 14 * math.sin((cycle * math.pi) / 180);
	}
	if (speed > 0) {
		moveToward(b, target.x, target.y, speed, dt);
	}
	touchDamage(refs, b, bossHitRadius(b) + PLAYER_RADIUS);
}

function updateNeedleBoss(refs: Ctx.AiRefs, b: BossState, dt: number): void {
	const target = refs.players[targetOf(refs, b)];
	touchDamage(refs, b, bossHitRadius(b) + PLAYER_RADIUS);
	if (b.attack !== true) {
		b.moveCount = (b.moveCount ?? 40) - dt * 30;
		moveToward(b, target.x, target.y, b.moveSpeed, dt);
		if ((b.moveCount ?? 0) <= 0) {
			b.attack = true;
			b.attackCd = 0.4;
			fanCounters.set(b.id, 0);
		}
		return;
	}
	b.attackCd -= dt;
	if (b.attackCd > 0) return;
	const fans = fanCounters.get(b.id) ?? 0;
	if (fans >= 3) {
		b.attack = false;
		b.moveCount = 40;
		return;
	}
	fanCounters.set(b.id, fans + 1);
	b.attackCd = 0.35;
	const base = math.atan2(target.y - b.y, target.x - b.x);
	for (let i = -3; i <= 3; i++) {
		pushNeedle(refs, b.x, b.y, base + (i * 15 * math.pi) / 180, 10, 18 * SPEED_SCALE);
	}
}

/** one frame of every boss in the world; a dead one drops its loot and leaves the list */
export function updateBosses(refs: Ctx.AiRefs, dt: number): void {
	if (refs.players.size() === 0) return;
	for (let i = refs.bosses.size() - 1; i >= 0; i--) {
		const b = refs.bosses[i];
		if (b.hp <= 0 && !b.dead) {
			b.dead = true;
			killBoss(refs, b);
			refs.bosses.remove(i);
			continue;
		}
		b.hitFlash = math.max(0, (b.hitFlash ?? 0) - dt);
		b.hp = math.min(b.hpMax, b.hp + b.hpRecover * dt);
		if (b.type === 1) updateSerpent(refs, b, dt);
		else if (b.type === 2) updateStationary(refs, b, dt);
		else if (b.type === 3) updateChargerBoss(refs, b, dt);
		else if (b.type === 4) updateNeedleBoss(refs, b, dt);
	}
}
