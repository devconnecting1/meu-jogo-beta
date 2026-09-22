import { COLORS } from "shared/engine/colors";
import { DESIGN } from "shared/engine/constants";
import { chance, choose, damageCal, rnd, rndRange } from "shared/engine/rng";
import { angleDiff } from "shared/engine/vec2";
import { damageToPlayer } from "shared/game/player";
import { querySolids, removeSolid, Solid, spawnGroundItem, WorldData } from "shared/game/world";
import {
	blocksMovement,
	blocksShots,
	circleBlocked,
	FlowField,
	isPlayerBuilt,
	moveActor,
	PLAYER_RADIUS,
	segmentClear,
} from "shared/game/physics";
import { ZombieState, zombieRadius } from "shared/game/entities";
import { zombieDef } from "shared/data/zombies";
import { BUILDING_SPAWNS } from "shared/data/spawns";
import { getCtx } from "../bootstrap";
import { GameRefs, SPEED_SCALE } from "./types";

// --- tuning (original values @30fps converted to seconds / px per second) ---------------------
/** stunned_time 30 frames */
const STUN_TIME = 1;
/** detect_show_time 30 frames */
const DETECT_SHOW_TIME = 1;
/** my_angle_speed 5°/frame */
const TURN_RATE = math.rad(5) * 30;
/** feet_cycle_angle_speed 10°/frame */
const FEET_RATE = math.rad(10) * 30;
/** reaction_speed_max */
const REACTION_MAX = 9;
/** zombies only hit constructions when the player is this close (par_action collision) */
const STRUCT_ATTACK_RANGE = 800;
/** walkers stop hunting 2000 px from where they spawned unless the player is within 600 */
const LEASH_SPAWN = 2000;
const LEASH_PLAYER = 600;
/** spitter */
const SPIT_RANGE = 400;
const SPIT_KEEP = SPIT_RANGE - 40;
const SPIT_COOLDOWN = 6;
const SPIT_SPEED = 15 * SPEED_SCALE;
const SPIT_LEAD = 20 / 30;
const PUDDLE_RADIUS = 70;
const PUDDLE_LIFE = 5;
/** charger */
const RUSH_MIN_DIST = 100;
const RUSH_TIME = 2;
const RUSH_COOLDOWN = 3;
const RUSH_SPEED_MIN = 5;
const RUSH_SPEED_MAX = 25;
/** +1 px/frame every frame */
const RUSH_ACCEL = 30;
/** jumper */
const JUMP_LENGTH = 200;
const JUMP_SPEED = 8 * SPEED_SCALE;
const JUMP_COOLDOWN = 2.7;
const JUMP_AIR_MAX = 2;
const JUMP_LIFT = 28;
const POISON_TIME = 30;
/** exploder */
const FUSE_TIME = 50 / 30;
const BLAST_RADIUS = 180;
const BLAST_GROW = 1.5 * 20 * 30;
const BLAST_DPS = 6 * 30;
const BLAST_ZOMBIE_DAMAGE = 60;
/** noise */
const WALK_TEMPO = 20 / 30;
const WALK_RING_MAX = 200;
const WALK_RING_SPEED = 7 * SPEED_SCALE;
/** flow field refresh: a new field is started every 0.4 s and built over a few frames */
const FLOW_INTERVAL = 0.4;
const FLOW_BUDGET = 800;
/** each zombie re-reads its path heading this often (staggered by id) */
const NAV_REFRESH = 0.15;

// --- module state (reset whenever a new world is loaded) ----------------------------------------
const flow = new FlowField();
let flowTimer = 0;
let flowSolidCount = -1;
let boundWorld: WorldData | undefined;
let lastPX: number | undefined;
let lastPY = 0;
let playerVX = 0;
let playerVY = 0;
let walkAccum = 0;
let walkTimer = 0;
let seenMorning = -1;
/** frame counter used to stagger expensive per-zombie checks */
let frameNo = 0;
/** cached path heading per zombie id: [heading, seconds until refresh] */
const navCache = new Map<number, { heading: number; t: number }>();
const sepX: Array<number> = [];
const sepY: Array<number> = [];
const nearSolids: Array<Solid> = [];

interface Light {
	x: number;
	y: number;
	/** radius (world units) inside which a zombie is visible */
	r: number;
	/** 1 = omni, 2 = cone (flashlight, ±45°) */
	kind: number;
	angle: number;
}

/**
 * Visibility radii at night. They match the renderer's light map (gameLoop PLAYER_LIGHT_R /
 * LIGHT_R) so a zombie is never invisible while standing on lit ground.
 */
const PLAYER_LIGHT_R = 250;
const STRUCTURE_LIGHT_R: Record<string, number> = { lamp: 400, lamp_drone: 320, campfire: 300, brazier: 330 };
/** flashlight (equipHand 13): original power 400 in a 45° cone → ~560 px */
const FLASHLIGHT_R = 560;
const lights: Array<Light> = [];

/** the chase flow field (read-only use: the admin panel's debug overlay draws it) */
export function debugFlowField(): FlowField {
	return flow;
}

export function actorDist(ax: number, ay: number, bx: number, by: number): number {
	const dx = ax - bx;
	const dy = ay - by;
	return math.sqrt(dx * dx + dy * dy);
}

function camShake(magnitude: number, duration: number): void {
	getCtx().cam.shake(magnitude, duration);
}

function setDetect(z: ZombieState): void {
	if (!z.detect) {
		z.detect = true;
		z.detectShow = DETECT_SHOW_TIME;
	}
}

/**
 * Knockback: the zombie is pushed along `fromAngle` (away from the attacker) at `power` px/frame,
 * stacking up to reaction_speed_max (9). Walls stop it (moveActor), stun does not cancel it.
 */
export function applyKnockback(z: ZombieState, fromAngle: number, power: number): void {
	if (z.jumping === true || z.rush === true) return;
	z.reactionDir = fromAngle;
	z.reactionSpeed = math.min(REACTION_MAX, z.reactionSpeed + power);
}

/**
 * Everything a zombie does when struck (bullet, arrow, blade, fire, shock): 1 s stun, flash,
 * knockback and it now hunts the player. Damage itself is applied by the caller.
 */
export function reactToHit(z: ZombieState, knockAngle: number, knockPower: number, stun = STUN_TIME): void {
	if (z.rush !== true) z.stunned = math.max(z.stunned, stun);
	z.hitFlash = 1;
	setDetect(z);
	applyKnockback(z, knockAngle, knockPower);
}

// --- noise --------------------------------------------------------------------------------------

/**
 * Emit a noise ring (obj_sound / obj_sound_shot). Zombies reached by the growing ring start
 * hunting. Only matters in daylight without rain (at night everyone hunts anyway).
 * `unique`: gunfire keeps a single ring alive at a time like the original.
 */
export function emitSound(refs: GameRefs, x: number, y: number, rMax: number, shot: boolean, unique = false): void {
	if (!refs.daynight.soundMatters()) return;
	refs.sounds ??= [];
	if (unique) {
		for (const s of refs.sounds) {
			if (s.shot && s.r < s.rMax * 0.5) return;
		}
	}
	refs.sounds.push({ x, y, r: 0, rMax, shot });
}

function updateNoise(refs: GameRefs, dt: number): void {
	const p = refs.player;
	let moved = 0;
	if (lastPX !== undefined && dt > 0) {
		const dx = p.x - lastPX;
		const dy = p.y - lastPY;
		moved = math.sqrt(dx * dx + dy * dy);
		// ignore teleports (respawn, boss grab) when estimating the running velocity
		if (moved < 600 * dt + 50) {
			playerVX = dx / dt;
			playerVY = dy / dt;
		}
	}
	lastPX = p.x;
	lastPY = p.y;

	if (refs.daynight.soundMatters()) {
		// sound_view_walk(dist*30) every frame, flushed every walk_tempo frames (÷1.2, max 200)
		walkAccum += moved * 30;
		walkTimer += dt;
		if (walkTimer >= WALK_TEMPO) {
			walkTimer = 0;
			if (walkAccum > 0) {
				let rMax = math.min(WALK_RING_MAX, walkAccum / 1.2);
				if (refs.save.skillLevels[15] > 0) rMax /= 2;
				emitSound(refs, p.x, p.y, rMax, false);
			}
			walkAccum = 0;
		}
	} else {
		walkAccum = 0;
		walkTimer = 0;
	}

	const sounds = refs.sounds;
	if (sounds === undefined) return;
	for (let i = sounds.size() - 1; i >= 0; i--) {
		const s = sounds[i];
		if (s.shot) {
			s.r += ((20 * (s.rMax - s.r)) / 300 + 1) * SPEED_SCALE * dt;
		} else {
			s.r += WALK_RING_SPEED * dt;
		}
		for (const z of refs.zombies) {
			if (z.detect || z.hp <= 0) continue;
			if (actorDist(z.x, z.y, s.x, s.y) < s.r) setDetect(z);
		}
		if (s.r > s.rMax) sounds.remove(i);
	}
}

// --- puddles / explosions ----------------------------------------------------------------------

/** spitter acid lands: a puddle that halves the player's speed while they stand in it */
export function addPuddle(refs: GameRefs, x: number, y: number): void {
	refs.puddles ??= [];
	refs.puddles.push({ x, y, r: PUDDLE_RADIUS, life: PUDDLE_LIFE, lifeMax: PUDDLE_LIFE });
}

function updatePuddles(refs: GameRefs, dt: number): void {
	const p = refs.player;
	p.puddleSlow = math.max(0, (p.puddleSlow ?? 0) - dt);
	const puddles = refs.puddles;
	if (puddles === undefined) return;
	for (let i = puddles.size() - 1; i >= 0; i--) {
		const pd = puddles[i];
		pd.life -= dt;
		if (pd.life <= 0) {
			puddles.remove(i);
			continue;
		}
		if (actorDist(p.x, p.y, pd.x, pd.y) < pd.r) {
			p.puddleSlow = 0.2;
		}
	}
}

function dropLoot(refs: GameRefs, z: ZombieState): void {
	const rate = DESIGN.ZOMBIE_ITEM_PERCENT + refs.save.skillLevels[9] * 10;
	if (!chance(rate)) return;
	const w = refs.world;
	const def = zombieDef(z.type);
	const fling = () => {
		const a = rnd() * math.pi * 2;
		return { vx: math.cos(a) * 150, vy: math.sin(a) * 150 };
	};
	// own table: rotten meat or leather
	if (rnd() < def.dropChance) {
		const v = fling();
		if (rnd() < 0.5) spawnGroundItem(w, 3, 19, 1, z.x, z.y, v.vx, v.vy);
		else spawnGroundItem(w, 4, 41, 1, z.x, z.y, v.vx, v.vy);
	}
	// walkers also roll the general ground-loot table (db_spawn_random(0))
	if (z.type === 1) {
		const e = choose(BUILDING_SPAWNS[0]);
		const v = fling();
		if (e.max < 1) {
			if (rnd() < e.max) spawnGroundItem(w, e.kind, e.index, 1, z.x, z.y, v.vx, v.vy);
		} else {
			const count = math.max(1, math.floor(e.min + rnd() * (e.max - e.min + 1)));
			spawnGroundItem(w, e.kind, e.index, count, z.x, z.y, v.vx, v.vy);
		}
	}
}

function killZombie(refs: GameRefs, z: ZombieState): void {
	refs.onExp(z.exp);
	refs.particles.bloodBurst(z.x, z.y, 10);
	dropLoot(refs, z);
}

function explode(refs: GameRefs, z: ZombieState): void {
	refs.explosions ??= [];
	refs.explosions.push({ x: z.x, y: z.y, r: 0, rMax: BLAST_RADIUS, life: 0.4 });
	refs.onExp(z.exp);
	dropLoot(refs, z);
	refs.particles.bloodBurst(z.x, z.y, 12);
	refs.particles.debrisBurst(z.x, z.y, 18, COLORS.zombie3);
	const p = refs.player;
	if (actorDist(p.x, p.y, z.x, z.y) < 800) camShake(7, 0.3);
	emitSound(refs, z.x, z.y, 800, true);
	// better than the original: the blast also throws and hurts the zombies around it
	for (const o of refs.zombies) {
		if (o === z || o.hp <= 0) continue;
		const d = actorDist(o.x, o.y, z.x, z.y);
		if (d < BLAST_RADIUS) {
			o.hp -= BLAST_ZOMBIE_DAMAGE * (1 - d / BLAST_RADIUS);
			reactToHit(o, math.atan2(o.y - z.y, o.x - z.x), 9);
		}
	}
}

function updateExplosions(refs: GameRefs, dt: number): void {
	const list = refs.explosions;
	if (list === undefined) return;
	const p = refs.player;
	for (let i = list.size() - 1; i >= 0; i--) {
		const e = list[i];
		if (e.r < e.rMax) {
			e.r = math.min(e.rMax, e.r + BLAST_GROW * dt);
			// obj_zombie3_boom: −6 hp every frame the player is inside the growing blast, ignoring i-frames
			if (actorDist(p.x, p.y, e.x, e.y) < e.r + PLAYER_RADIUS * 0.5) {
				const wasHit = p.attacked;
				damageToPlayer(p, refs.save, BLAST_DPS * dt, true);
				if (!wasHit) {
					p.reactionDir = math.atan2(p.y - e.y, p.x - e.x);
					refs.particles.bloodBurst(p.x, p.y, 4, "player");
				}
			}
		} else {
			e.life -= dt;
			if (e.life <= 0) list.remove(i);
		}
	}
}

// --- constructions ----------------------------------------------------------------------------

/** a zombie (or blast) hits a player construction; destroyed ones leave the world for real */
export function damageStructure(refs: GameRefs, s: Solid, dmg: number): void {
	if (!s.destructible || s.removed === true) return;
	s.hp -= dmg;
	s.hitShake = math.max(s.hitShake ?? 0, 8 / 30);
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	refs.particles.debrisBurst(cx, cy, 3, COLORS.barricade);
	if (s.hp <= 0) {
		refs.particles.debrisBurst(cx, cy, 14, COLORS.barricade);
		removeSolid(refs.world, s);
	}
}

function findTrap(world: WorldData, x: number, y: number): Solid | undefined {
	nearSolids.clear();
	querySolids(world, x - 1, y - 1, x + 1, y + 1, nearSolids);
	for (const s of nearSolids) {
		if (s.tags === "trap" || s.tags === "trap_electric") return s;
	}
	return undefined;
}

function decayShakes(refs: GameRefs, dt: number): void {
	const p = refs.player;
	nearSolids.clear();
	querySolids(refs.world, p.x - 1400, p.y - 1400, p.x + 1400, p.y + 1400, nearSolids);
	for (const s of nearSolids) {
		const t = s.hitShake;
		if (t !== undefined && t > 0) s.hitShake = math.max(0, t - dt);
	}
}

// --- lighting (image_alpha of obj_zombie) ------------------------------------------------------

function collectLights(refs: GameRefs): void {
	lights.clear();
	const p = refs.player;
	const save = refs.save;
	// "Nocturnal" (skill 16) and the torch widen what the survivor can make out in the dark
	let r = PLAYER_LIGHT_R;
	if (save.skillLevels[16] > 0) r *= 1.5;
	if (save.equipHand === 15) r = math.max(r, 400);
	lights.push({ x: p.x, y: p.y, r, kind: 1, angle: 0 });
	if (save.equipHand === 13) {
		lights.push({ x: p.x, y: p.y, r: FLASHLIGHT_R, kind: 2, angle: p.angle });
	}
	if (refs.daynight.darkAlpha <= 0.05) return;
	for (const s of nearSolids) {
		if (s.powered !== true) continue;
		const lr = STRUCTURE_LIGHT_R[s.tags];
		if (lr !== undefined) lights.push({ x: s.x + s.w / 2, y: s.y + s.h / 2, r: lr, kind: 1, angle: 0 });
	}
}

/**
 * obj_zombie image_alpha: fully visible while ambient light ≥ 0.4 (day, dusk) or when inside a
 * light; otherwise it fades out in the dark (3/s), like the original.
 */
function updateAlpha(refs: GameRefs, z: ZombieState, dt: number): void {
	let lit = 1 - refs.daynight.darkAlpha >= 0.4;
	if (!lit) {
		for (const l of lights) {
			const dx = z.x - l.x;
			const dy = z.y - l.y;
			if (dx * dx + dy * dy > l.r * l.r) continue;
			if (l.kind === 2 && math.abs(angleDiff(l.angle, math.atan2(dy, dx))) > math.rad(45)) continue;
			lit = true;
			break;
		}
	}
	const target = lit ? 1 : 0;
	if (z.alpha < target) z.alpha = math.min(target, z.alpha + 3 * dt);
	else if (z.alpha > target) z.alpha = math.max(target, z.alpha - 3 * dt);
}

// --- navigation ------------------------------------------------------------------------------

function syncWorld(refs: GameRefs): void {
	if (boundWorld !== refs.world) {
		boundWorld = refs.world;
		flow.valid = false;
		flowTimer = 0;
		flowSolidCount = -1;
		lastPX = undefined;
		walkAccum = 0;
		walkTimer = 0;
		seenMorning = refs.daynight.morningCount;
		navCache.clear();
	}
}

function updateFlow(refs: GameRefs, dt: number): void {
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
		flow.startRebuild(refs.world, refs.player.x, refs.player.y);
		if (!flow.valid) flow.step(1e9); // the very first field is built at once
	}
	if (flow.building) flow.step(FLOW_BUDGET);
}

const PROBE_OFFSETS: Array<number> = [0, 0.5, -0.5, 1, -1, 1.6, -1.6];

/** local steering when there is no flow field: first free heading around the wanted one */
function steer(world: WorldData, z: ZombieState, r: number, wanted: number): number {
	const probe = r + 14;
	for (const off of PROBE_OFFSETS) {
		const a = wanted + off;
		if (circleBlocked(world, z.x + math.cos(a) * probe, z.y + math.sin(a) * probe, r) === undefined) {
			return a;
		}
	}
	return wanted;
}

/** heading towards the player: straight when close, else along the flow field (doors!) */
function chaseHeading(refs: GameRefs, z: ZombieState, r: number, distP: number): number {
	const p = refs.player;
	const direct = math.atan2(p.y - z.y, p.x - z.x);
	if (distP < 72 && segmentClear(refs.world, z.x, z.y, p.x, p.y, blocksMovement)) return direct;
	const cached = navCache.get(z.id);
	if (cached !== undefined && cached.t > 0) return cached.heading;
	let h: number | undefined;
	if (flow.contains(z.x, z.y)) h = flow.heading(z.x, z.y);
	if (h === undefined) h = steer(refs.world, z, r, direct);
	// stagger refreshes so ~1/9 of the horde re-plans each frame
	const t = NAV_REFRESH * (0.75 + ((z.id * 7) % 10) / 20);
	if (cached !== undefined) {
		cached.heading = h;
		cached.t = t;
	} else {
		navCache.set(z.id, { heading: h, t });
	}
	return h;
}

function computeSeparation(refs: GameRefs): void {
	const zs = refs.zombies;
	const n = zs.size();
	sepX.clear();
	sepY.clear();
	for (let i = 0; i < n; i++) {
		sepX.push(0);
		sepY.push(0);
	}
	for (let i = 0; i < n; i++) {
		const a = zs[i];
		if (a.jumping === true) continue;
		const ra = zombieRadius(a);
		for (let j = i + 1; j < n; j++) {
			const b = zs[j];
			if (b.jumping === true) continue;
			const min = ra + zombieRadius(b);
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			if (math.abs(dx) >= min || math.abs(dy) >= min) continue;
			const d2 = dx * dx + dy * dy;
			if (d2 >= min * min) continue;
			let d = math.sqrt(d2);
			let nx: number;
			let ny: number;
			if (d < 0.01) {
				const ang = (a.id * 2.399) % (math.pi * 2);
				nx = math.cos(ang);
				ny = math.sin(ang);
				d = 0;
			} else {
				nx = dx / d;
				ny = dy / d;
			}
			// each gets half of the overlap (capped so a pile resolves over a few frames, no jitter)
			const push = math.min(6, (min - d) * 0.5);
			sepX[i] -= nx * push;
			sepY[i] -= ny * push;
			sepX[j] += nx * push;
			sepY[j] += ny * push;
		}
	}
}

// --- per type ----------------------------------------------------------------------------------

/** random walk with pauses (random_move / alarm[2]) */
function wander(z: ZombieState, dt: number): number {
	z.wanderTimer -= dt;
	if (z.wanderTimer <= 0) {
		if (z.wanderPause === true) {
			z.wanderPause = false;
			z.wanderTimer = rndRange(2, 4);
			z.wanderDir = rnd() * math.pi * 2;
		} else {
			z.wanderPause = true;
			z.wanderTimer = rndRange(20 / 30, 40 / 30);
		}
	}
	return z.wanderPause === true ? 0 : ((z.moveSpeed * 2) / 3) * SPEED_SCALE;
}

function fireSpit(refs: GameRefs, z: ZombieState): void {
	const tx = z.aimX ?? refs.player.x;
	const ty = z.aimY ?? refs.player.y;
	const ang = math.atan2(ty - z.y, tx - z.x);
	refs.bullets.push({
		id: -(1 + (z.id % 90000)),
		x: z.x,
		y: z.y,
		angle: ang,
		range: actorDist(z.x, z.y, tx, ty),
		travel: 0,
		damage: 0,
		speed: SPIT_SPEED,
		kind: "arrow",
		alive: true,
		fromPlayer: false,
		alpha: 1,
		life: 1,
		targetX: tx,
		targetY: ty,
	});
}

/** spitter: stays at range, winds its head back, spits where the player WILL be */
function thinkSpitter(refs: GameRefs, z: ZombieState, dt: number, distP: number): void {
	z.attackCd = (z.attackCd ?? 0) - dt;
	const p = refs.player;
	const canSpit =
		z.detect &&
		z.stunned <= 0 &&
		distP < SPIT_RANGE &&
		(z.attackCd ?? 0) <= 0 &&
		((z.headX ?? 0) > 0 || segmentClear(refs.world, z.x, z.y, p.x, p.y, blocksShots));
	if (canSpit) {
		z.aimX = p.x + playerVX * SPIT_LEAD;
		z.aimY = p.y + playerVY * SPIT_LEAD;
		z.headX = (z.headX ?? 0) + 0.8 * SPEED_SCALE * dt;
		if ((z.headX ?? 0) >= 10) {
			z.headX = 0;
			z.attackCd = SPIT_COOLDOWN;
			fireSpit(refs, z);
		}
	} else {
		z.headX = 0;
	}
}

function endRush(z: ZombieState): void {
	z.rush = false;
	z.rushReady = false;
	z.rushCd = RUSH_COOLDOWN;
	z.rushSpeed = RUSH_SPEED_MIN;
	z.rushTime = 0;
}

/** charger: keeps ~110 px away, then charges in a straight line when it has a clear run */
function thinkCharger(refs: GameRefs, z: ZombieState, dt: number, distP: number): boolean {
	if (z.rush === true) {
		z.rushTime = (z.rushTime ?? 0) + dt;
		z.rushSpeed = math.min(RUSH_SPEED_MAX, (z.rushSpeed ?? RUSH_SPEED_MIN) + RUSH_ACCEL * dt);
		z.reactionSpeed = 0;
		if ((z.rushTime ?? 0) >= RUSH_TIME) endRush(z);
		return z.rush === true;
	}
	z.backstep = false;
	if (z.rushReady !== true) {
		z.rushCd = (z.rushCd ?? 0) - dt;
		if ((z.rushCd ?? 0) <= 0) z.rushReady = true;
	}
	if (!z.detect || z.stunned > 0) return false;
	const p = refs.player;
	const losCheck = (frameNo + z.id) % 6 === 0; // the long LOS ray is checked ~10×/s, not every frame
	if (
		z.rushReady === true &&
		distP > RUSH_MIN_DIST &&
		losCheck &&
		segmentClear(refs.world, z.x, z.y, p.x, p.y, blocksMovement)
	) {
		z.rush = true;
		z.rushReady = false;
		z.rushTime = 0;
		z.rushSpeed = RUSH_SPEED_MIN;
		z.rushDir = math.atan2(p.y - z.y, p.x - z.x);
		z.angle = z.rushDir;
		z.angleSlow = z.rushDir;
		return true;
	}
	if (distP < RUSH_MIN_DIST + 10) z.backstep = true;
	return false;
}

const JUMP_TRIES_LEN: Array<number> = [JUMP_LENGTH, 150, 100];
const JUMP_TRIES_ANG: Array<number> = [0, 0.35, -0.35, 0.7, -0.7];

/**
 * Take off towards `dir`, landing only on free ground with a clear flight line
 * (the original jumper flew through walls).
 */
function startJump(refs: GameRefs, z: ZombieState, r: number, dir: number): boolean {
	for (const len of JUMP_TRIES_LEN) {
		for (const off of JUMP_TRIES_ANG) {
			const a = dir + off;
			const tx = z.x + math.cos(a) * len;
			const ty = z.y + math.sin(a) * len;
			if (circleBlocked(refs.world, tx, ty, r) !== undefined) continue;
			if (!segmentClear(refs.world, z.x, z.y, tx, ty, blocksMovement)) continue;
			z.jumping = true;
			z.jumpReady = false;
			z.jumpCd = JUMP_COOLDOWN;
			z.jumpDir = a;
			z.jumpTargetX = tx;
			z.jumpTargetY = ty;
			z.jumpLength = len;
			z.jumpTravel = 0;
			z.jumpAir = 0;
			z.jumpHeight = 0;
			z.reactionSpeed = 0;
			z.angle = a;
			z.angleSlow = a;
			return true;
		}
	}
	return false;
}

function thinkJumper(refs: GameRefs, z: ZombieState, r: number, dt: number, distP: number): void {
	z.jumpCd = (z.jumpCd ?? 0) - dt;
	if ((z.jumpCd ?? 0) > 0 || z.stunned > 0) return;
	let dir: number | undefined;
	if (z.detect) {
		dir = chaseHeading(refs, z, r, distP);
	} else if (z.wanderPause !== true) {
		dir = z.wanderDir;
	}
	if (dir === undefined) return;
	if (!startJump(refs, z, r, dir)) {
		z.jumpCd = 0.5;
		z.wanderDir = rnd() * math.pi * 2;
	}
}

function jumperPoison(refs: GameRefs, z: ZombieState, r: number): void {
	const p = refs.player;
	if (actorDist(z.x, z.y, p.x, p.y) < r + PLAYER_RADIUS + 6 && p.buffs.poison < POISON_TIME) {
		p.buffs.poison = POISON_TIME;
	}
}

// --- contact with the player ----------------------------------------------------------------------

function contactAttack(refs: GameRefs, z: ZombieState): void {
	const rushing = z.rush === true;
	if (z.stunned > 0 && !rushing) return;
	const p = refs.player;
	const dmg = rushing ? (z.damageRush ?? z.damage) : z.damage;
	if (damageToPlayer(p, refs.save, dmg)) {
		p.reactionDir = math.atan2(p.y - z.y, p.x - z.x);
		if (rushing) p.reactionSpeed = math.max(p.reactionSpeed, DESIGN.REACTION_MAX + 4);
		refs.particles.bloodBurst(p.x, p.y, 4, "player");
		camShake(p.buffs.pain > 0 ? 3 : 5, 0.18);
		// obj_player_body: the zombie that landed the hit is stunned for stunned_time
		z.stunned = STUN_TIME;
	}
	if (rushing) {
		endRush(z);
		z.stunned = math.max(z.stunned, 0.5);
	}
}

// --- main -------------------------------------------------------------------------------------

function faceAndAnimate(
	refs: GameRefs,
	z: ZombieState,
	movedX: number,
	movedY: number,
	dt: number,
	distP: number,
): void {
	const p = refs.player;
	const speed = dt > 0 ? math.sqrt(movedX * movedX + movedY * movedY) / dt : 0;
	const walking = speed > SPEED_SCALE;
	if (walking) z.angle = math.atan2(movedY, movedX);
	if (z.backstep === true) z.angle = math.atan2(p.y - z.y, p.x - z.x);
	if (z.detect && distP < 100) z.angle = math.atan2(p.y - z.y, p.x - z.x);
	if (z.type === 2 && (z.headX ?? 0) > 0 && z.aimX !== undefined && z.aimY !== undefined) {
		z.angle = math.atan2(z.aimY - z.y, z.aimX - z.x);
		z.angleSlow = z.angle;
	}
	if (z.rush === true && z.rushDir !== undefined) {
		z.angle = z.rushDir;
		z.angleSlow = z.rushDir;
	} else if (z.jumping === true && z.jumpDir !== undefined) {
		z.angle = z.jumpDir;
		z.angleSlow = z.jumpDir;
	} else if (z.reactionSpeed > 0) {
		z.angle = z.reactionDir + math.pi;
		z.angleSlow = z.angle;
	}
	const diff = angleDiff(z.angleSlow, z.angle);
	const turn = TURN_RATE * dt;
	if (math.abs(diff) <= turn) z.angleSlow = z.angle;
	else z.angleSlow += diff > 0 ? turn : -turn;
	if (walking) {
		z.feetCycle =
			((z.feetCycle ?? 0) + FEET_RATE * dt * math.clamp(speed / (3 * SPEED_SCALE), 0.5, 2)) % (math.pi * 2);
	} else {
		z.feetCycle = 0;
	}
}

function updateDetect(refs: GameRefs, z: ZombieState, distP: number): void {
	const dn = refs.daynight;
	if (dn.isNight || dn.isRaining || distP < 50) setDetect(z);
}

/** returns true when the zombie must be removed */
function updateOne(refs: GameRefs, z: ZombieState, idx: number, dt: number): boolean {
	const world = refs.world;
	const p = refs.player;
	z.hitFlash = math.max(0, (z.hitFlash ?? 0) - dt);
	if (z.detectShow > 0) z.detectShow = math.max(0, z.detectShow - dt);

	if (z.hp <= 0) {
		if (z.type !== 3) {
			killZombie(refs, z);
			return true;
		}
		// the exploder keeps walking with a lit fuse, then blows up
		if ((z.fuse ?? -1) < 0) {
			z.fuse = FUSE_TIME;
			z.detect = true;
			z.hitFlash = 1;
		}
		z.fuse = (z.fuse ?? 0) - dt;
		if ((z.fuse ?? 0) <= 0) {
			explode(refs, z);
			return true;
		}
	}

	const r = zombieRadius(z);
	let distP = actorDist(z.x, z.y, p.x, p.y);
	if (z.stunned > 0) z.stunned = math.max(0, z.stunned - dt);
	z.reactionSpeed = math.min(REACTION_MAX, z.reactionSpeed);
	if (z.reactionSpeed > 0) z.reactionSpeed = math.max(0, z.reactionSpeed - DESIGN.REACTION_FRICTION * dt);
	updateDetect(refs, z, distP);

	// ---- airborne jumper: flies its planned line, lands early on a wall -------------------------
	if (z.type === 5 && z.jumping === true) {
		const step = JUMP_SPEED * dt;
		const dir = z.jumpDir ?? 0;
		const res = moveActor(world, z.x, z.y, r, math.cos(dir) * step, math.sin(dir) * step);
		const movedX = res.x - z.x;
		const movedY = res.y - z.y;
		z.x = res.x;
		z.y = res.y;
		z.jumpTravel = (z.jumpTravel ?? 0) + step;
		z.jumpAir = (z.jumpAir ?? 0) + dt;
		const len = z.jumpLength ?? JUMP_LENGTH;
		const t = math.clamp((z.jumpTravel ?? 0) / len, 0, 1);
		z.jumpHeight = math.sin(t * math.pi) * JUMP_LIFT;
		if (res.hit !== undefined || t >= 1 || (z.jumpAir ?? 0) >= JUMP_AIR_MAX) {
			z.jumping = false;
			z.jumpHeight = 0;
		}
		distP = actorDist(z.x, z.y, p.x, p.y);
		jumperPoison(refs, z, r);
		if (distP <= r + PLAYER_RADIUS + 2) contactAttack(refs, z);
		faceAndAnimate(refs, z, movedX, movedY, dt, distP);
		updateAlpha(refs, z, dt);
		return false;
	}

	// ---- decide the voluntary velocity (px/s) --------------------------------------------------
	let heading = 0;
	let speed = 0;
	let wandering = false;
	const dying = z.hp <= 0;
	if (z.type === 2) thinkSpitter(refs, z, dt, distP);
	const rushing = z.type === 4 && thinkCharger(refs, z, dt, distP);

	if (rushing) {
		heading = z.rushDir ?? 0;
		speed = (z.rushSpeed ?? RUSH_SPEED_MIN) * SPEED_SCALE;
	} else if (z.type === 5) {
		thinkJumper(refs, z, r, dt, distP);
		jumperPoison(refs, z, r);
		// the jumper never walks: it only moves by jumping
	} else if (z.stunned <= 0 || dying) {
		// (a dying exploder ignores the stun: it keeps walking at you with its fuse lit)
		let chase = z.detect || dying;
		if (chase && z.type === 1 && !z.wave) {
			const fromSpawn = actorDist(z.x, z.y, z.spawnX, z.spawnY);
			if (fromSpawn > LEASH_SPAWN && distP > LEASH_PLAYER) chase = false;
		}
		if (chase && z.type === 2 && distP < SPIT_KEEP) {
			speed = 0;
		} else if (chase && z.backstep === true) {
			heading = math.atan2(z.y - p.y, z.x - p.x);
			heading = steer(world, z, r, heading);
			speed = z.moveSpeed * SPEED_SCALE;
		} else if (chase) {
			heading = chaseHeading(refs, z, r, distP);
			speed = z.moveSpeed * SPEED_SCALE;
		} else {
			speed = wander(z, dt);
			heading = z.wanderDir;
			wandering = true;
		}
	}

	// ---- move: intent + knockback + crowd separation, through real collision ------------------
	let mx = math.cos(heading) * speed * dt;
	let my = math.sin(heading) * speed * dt;
	if (z.reactionSpeed > 0 && !rushing) {
		mx += math.cos(z.reactionDir) * z.reactionSpeed * SPEED_SCALE * dt;
		my += math.sin(z.reactionDir) * z.reactionSpeed * SPEED_SCALE * dt;
	}
	mx += sepX[idx] ?? 0;
	my += sepY[idx] ?? 0;
	const res = moveActor(world, z.x, z.y, r, mx, my);
	let movedX = res.x - z.x;
	let movedY = res.y - z.y;
	z.x = res.x;
	z.y = res.y;

	const hit = res.hit;
	if (hit !== undefined) {
		if (speed > 0 && isPlayerBuilt(hit) && hit.destructible && (z.stunned <= 0 || rushing)) {
			// par_action collision: hit the construction in the way (only near the player)
			if (distP < STRUCT_ATTACK_RANGE) {
				const dmg = rushing ? (z.damageRush ?? z.damage) : z.damage;
				damageStructure(refs, hit, damageCal(dmg));
				z.stunned = STUN_TIME;
				if (rushing) endRush(z);
			}
		} else if (rushing) {
			// obj_zombie4: a rush that meets a wall ends in a crash
			endRush(z);
			z.stunned = math.max(z.stunned, 0.5);
			if (distP < 800) camShake(4, 0.2);
		}
		if (wandering) z.wanderDir = rnd() * math.pi * 2;
	}

	// ---- the player is a solid body: stop at contact distance, bite on contact -----------------
	const minD = r + PLAYER_RADIUS;
	const dx = z.x - p.x;
	const dy = z.y - p.y;
	distP = math.sqrt(dx * dx + dy * dy);
	if (distP < minD) {
		let nx = 1;
		let ny = 0;
		if (distP > 0.01) {
			nx = dx / distP;
			ny = dy / distP;
		}
		const back = moveActor(world, z.x, z.y, r, nx * (minD - distP), ny * (minD - distP));
		movedX += back.x - z.x;
		movedY += back.y - z.y;
		z.x = back.x;
		z.y = back.y;
		distP = actorDist(z.x, z.y, p.x, p.y);
	}
	if (distP <= minD + 3) contactAttack(refs, z);

	// ---- floor trap: 40%/frame chance of a short stun (frame-rate independent) ------------------
	if (z.stunned <= 0 && findTrap(world, z.x, z.y) !== undefined) {
		if (rnd() < 1 - math.pow(0.6, dt * 30)) z.stunned = STUN_TIME / 4;
	}

	faceAndAnimate(refs, z, movedX, movedY, dt, distP);
	updateAlpha(refs, z, dt);
	return false;
}

/**
 * Zombie AI + physics for one frame: noise, puddles, blasts, the flow field, crowd separation and
 * each zombie's behaviour (walker, spitter, exploder, charger, jumper).
 */
export function updateZombies(refs: GameRefs, dt: number): void {
	syncWorld(refs);
	frameNo++;
	for (const [id, c] of navCache) {
		c.t -= dt;
		if (c.t < -5) navCache.delete(id); // zombie gone
	}
	// 7:00 — zombies that did not come with a night wave lose the trail
	if (refs.daynight.morningCount !== seenMorning) {
		seenMorning = refs.daynight.morningCount;
		for (const z of refs.zombies) {
			if (!z.wave) z.detect = false;
		}
	}
	decayShakes(refs, dt);
	collectLights(refs);
	updateNoise(refs, dt);
	updatePuddles(refs, dt);
	updateExplosions(refs, dt);
	updateFlow(refs, dt);
	computeSeparation(refs);
	for (let i = refs.zombies.size() - 1; i >= 0; i--) {
		const z = refs.zombies[i];
		if (updateOne(refs, z, i, dt)) {
			refs.zombies.remove(i);
		}
	}
}
