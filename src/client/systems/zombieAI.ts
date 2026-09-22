import { DESIGN } from "shared/engine/constants";
import { chance, choose, damageCal, rnd, rndRange } from "shared/engine/rng";
import { angleDiff } from "shared/engine/vec2";
import { damageToPlayer, PlayerState } from "shared/game/player";
import { isBlocking, querySolids, removeSolid, Solid, spawnGroundItem, WorldData } from "shared/game/world";
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
// Namespace imports on purpose: roblox-ts emits ONE Luau local per named binding, and a module chunk may hold
// at most 200 locals. These four modules were 24 of them and this file hit the ceiling, which the compiler
// cannot see: it is a Luau LOAD-time limit, so the build stays green and the client fails to boot instead.
// Keep them qualified, and count the top-level locals before adding a new named import here.
import * as Alert from "shared/sim/ai/alert";
import * as Flank from "shared/sim/ai/flank";
import * as Mind from "shared/sim/ai/memory";
import * as Sense from "shared/sim/ai/perception";
import { fxBlood, fxDebris, fxShake, GameRefs, nearestPlayer, SPEED_SCALE } from "./types";

/*
 * Zombie AI and physics. Every survivor in refs.players is a possible target: each zombie hunts the nearest living
 * one (F2 turns the flow field multi-source, docs/MULTIPLAYER.md §3.3). Cosmetics (blood, debris, camera shake) are
 * asked for through refs.fx and played by the view — nothing here touches the camera or the particle system.
 *
 * What the original (obj_zombie / par_zombie) does NOT have, and lives in shared/sim/ai/*:
 *   - eyes: by day it only notices you inside 50 px, and at night or in the rain every zombie on the map turns
 *     hostile at once (perception.ts gives it a range, a cone and a line of sight, keeping the night smell);
 *   - memory: `detect` homes on your LIVE position for ever, through walls, until 7:00 clears it (memory.ts makes
 *     it run to the last place it actually perceived you and search around it before giving up);
 *   - a pack: no code ever writes another zombie's `detect` (alert.ts makes the first one to spot you shout, with
 *     a hard wake budget so it can never cascade);
 *   - a second route: mp_potential_step_object queues everyone on one line (flank.ts prices crowded lanes so part
 *     of the horde comes round the other side);
 *   - a wind-up: it bites the frame it touches you (here a short, readable lean-back you can step out of).
 */

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
/** an investigating zombie shuffles instead of sprinting: the player can read the difference */
const SEARCH_SPEED = 0.7;
/** spitter */
const SPIT_RANGE = 400;
const SPIT_KEEP = SPIT_RANGE - 40;
/** closer than this the spitter gives ground instead of standing and spitting in your face */
const SPIT_BACK = 240;
const SPIT_COOLDOWN = 6;
const SPIT_SPEED = 15 * SPEED_SCALE;
const SPIT_LEAD = 20 / 30;
/** seconds of sidestep after a spit (it never stands still in the open) */
const SPIT_REPOSITION = 1.2;
const PUDDLE_RADIUS = 70;
const PUDDLE_LIFE = 5;
/** exploder: how far it looks around for a wall to breach, and how close it must be to bother */
const EXPLODER_SEEK = 320;
const EXPLODER_NEAR_TARGET = 900;
/** two survivors closer than this to each other are a cluster worth blowing up */
const EXPLODER_CLUSTER = 320;
/** charger */
const RUSH_MIN_DIST = 100;
const RUSH_TIME = 2;
const RUSH_COOLDOWN = 3;
const RUSH_SPEED_MIN = 5;
const RUSH_SPEED_MAX = 25;
/** +1 px/frame every frame */
const RUSH_ACCEL = 30;
/** charges that found no clear lane before it goes looking for one */
const RUSH_FAIL_MAX = 2;
/** seconds of sidestep while a special looks for a clear lane */
const STRAFE_TIME = 0.9;
const STRAFE_SPEED = 0.75;
/** jumper */
const JUMP_LENGTH = 200;
const JUMP_SPEED = 8 * SPEED_SCALE;
const JUMP_COOLDOWN = 2.7;
const JUMP_AIR_MAX = 2;
const JUMP_LIFT = 28;
/** a hunting jumper only takes off when the leap actually shortens its path, in flow-field cells */
const JUMP_GAIN = 2.5;
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
/** line-of-sight rays allowed per frame across the whole horde (amortised perception) */
const LOS_BUDGET = 24;
/** telegraphed bite: lean back, then bite. Step out of BITE_KEEP during it and the bite whiffs. */
const WINDUP_TIME = 0.26;
const WINDUP_BACK = 1.2;
const BITE_KEEP = 16;
const WHIFF_RECOVER = 0.35;
/** knockback power (combat.ts: melee 6, headshot 9, blast 9) that visibly staggers a zombie */
const STAGGER_KNOCK = 6;
const STAGGER_TIME = 0.45;

// --- module state (reset whenever a new world is loaded) ----------------------------------------
const flow = new FlowField();
const crowd = new Flank.Congestion();
let flowTimer = 0;
let flowSolidCount = -1;
let boundWorld: WorldData | undefined;
let seenMorning = -1;
/** frame counter used to stagger expensive per-zombie checks */
let frameNo = 0;
/** line-of-sight rays left this frame, and shouts left this frame */
let losBudget = LOS_BUDGET;
let shoutsLeft = Alert.ALERT_SHOUTS_PER_TICK;
/** how far each sense reaches this frame (light, weather and the survivor's Stealth skill) */
let senses: Sense.SenseRanges = { sight: 0, cone: 0, smell: 0 };
const alertOut: Array<number> = [];
/** zombies killed since the pacing director last looked (spawner.ts drains it) */
let killCount = 0;

/** kills since the last call, then resets: the pacing director's "they are winning" signal */
export function takeKills(): number {
	const n = killCount;
	killCount = 0;
	return n;
}

/** footsteps and velocity of one survivor (the spitter leads its target with it) */
interface PlayerTrack {
	lastX?: number;
	lastY: number;
	vx: number;
	vy: number;
	walkAccum: number;
	walkTimer: number;
}

const tracks = new Map<PlayerState, PlayerTrack>();

function trackOf(p: PlayerState): PlayerTrack {
	let t = tracks.get(p);
	if (t === undefined) {
		t = { lastY: 0, vx: 0, vy: 0, walkAccum: 0, walkTimer: 0 };
		tracks.set(p, t);
	}
	return t;
}
const sepX: Array<number> = [];
const sepY: Array<number> = [];
const nearSolids: Array<Solid> = [];
const seekSolids: Array<Solid> = [];

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

/** the "!" bubble of obj_zombie: shown on the frame a zombie starts hunting */
function showDetect(z: ZombieState): void {
	if (!z.detect) z.detectShow = DETECT_SHOW_TIME;
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
 * knockback and it now hunts. Damage itself is applied by the caller.
 *
 * Better than the original, which never links being shot to `detect` at all: the zombie turns towards
 * WHERE THE SHOT CAME FROM (`fromAngle` points away from the attacker) instead of magically knowing
 * where the shooter stands — so a shot from cover pulls the horde to the cover, not onto you.
 * A heavy hit (melee, headshot, blast) also staggers it and kills any bite it was winding up.
 */
export function reactToHit(z: ZombieState, knockAngle: number, knockPower: number, stun = STUN_TIME): void {
	if (z.rush !== true) z.stunned = math.max(z.stunned, stun);
	z.hitFlash = 1;
	showDetect(z);
	Mind.report(z, z.x - math.cos(knockAngle) * Mind.SHOT_MEMORY, z.y - math.sin(knockAngle) * Mind.SHOT_MEMORY);
	if (knockPower >= STAGGER_KNOCK) {
		z.stagger = math.max(z.stagger ?? 0, STAGGER_TIME);
		cancelWindup(z);
	}
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
	const matters = refs.daynight.soundMatters();
	for (const p of refs.players) {
		const t = trackOf(p);
		let moved = 0;
		if (t.lastX !== undefined && dt > 0) {
			const dx = p.x - t.lastX;
			const dy = p.y - t.lastY;
			moved = math.sqrt(dx * dx + dy * dy);
			// ignore teleports (respawn, boss grab) when estimating the running velocity
			if (moved < 600 * dt + 50) {
				t.vx = dx / dt;
				t.vy = dy / dt;
			}
		}
		t.lastX = p.x;
		t.lastY = p.y;

		if (matters) {
			// sound_view_walk(dist*30) every frame, flushed every walk_tempo frames (÷1.2, max 200)
			t.walkAccum += moved * 30;
			t.walkTimer += dt;
			if (t.walkTimer >= WALK_TEMPO) {
				t.walkTimer = 0;
				if (t.walkAccum > 0) {
					let rMax = math.min(WALK_RING_MAX, t.walkAccum / 1.2);
					if (refs.save.skillLevels[15] > 0) rMax /= 2;
					emitSound(refs, p.x, p.y, rMax, false);
				}
				t.walkAccum = 0;
			}
		} else {
			t.walkAccum = 0;
			t.walkTimer = 0;
		}
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
			if (actorDist(z.x, z.y, s.x, s.y) < s.r) {
				// a noise says WHERE IT CAME FROM, not where the survivor is now: it goes and looks
				showDetect(z);
				Mind.report(z, s.x, s.y);
			}
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
	for (const p of refs.players) {
		p.puddleSlow = math.max(0, (p.puddleSlow ?? 0) - dt);
	}
	const puddles = refs.puddles;
	if (puddles === undefined) return;
	for (let i = puddles.size() - 1; i >= 0; i--) {
		const pd = puddles[i];
		pd.life -= dt;
		if (pd.life <= 0) {
			puddles.remove(i);
			continue;
		}
		for (const p of refs.players) {
			if (actorDist(p.x, p.y, pd.x, pd.y) < pd.r) {
				p.puddleSlow = 0.2;
			}
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
	killCount++;
	fxBlood(refs, z.x, z.y, 10);
	dropLoot(refs, z);
}

function explode(refs: GameRefs, z: ZombieState): void {
	refs.explosions ??= [];
	refs.explosions.push({ x: z.x, y: z.y, r: 0, rMax: BLAST_RADIUS, life: 0.4 });
	refs.onExp(z.exp);
	killCount++;
	dropLoot(refs, z);
	fxBlood(refs, z.x, z.y, 12);
	fxDebris(refs, z.x, z.y, 18, "exploder");
	for (const p of refs.players) {
		if (actorDist(p.x, p.y, z.x, z.y) < 800) fxShake(refs, p, 7, 0.3);
	}
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
	for (let i = list.size() - 1; i >= 0; i--) {
		const e = list[i];
		if (e.r < e.rMax) {
			e.r = math.min(e.rMax, e.r + BLAST_GROW * dt);
			// obj_zombie3_boom: −6 hp every frame a survivor is inside the growing blast, ignoring i-frames
			for (const p of refs.players) {
				if (actorDist(p.x, p.y, e.x, e.y) >= e.r + PLAYER_RADIUS * 0.5) continue;
				const wasHit = p.attacked;
				damageToPlayer(p, refs.save, BLAST_DPS * dt, true);
				if (!wasHit) {
					p.reactionDir = math.atan2(p.y - e.y, p.x - e.x);
					fxBlood(refs, p.x, p.y, 4, "player");
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
	fxDebris(refs, cx, cy, 3, "structure");
	if (s.hp <= 0) {
		fxDebris(refs, cx, cy, 14, "structure");
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

/** also fills nearSolids for collectLights (around the local survivor: this is what its screen shows) */
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
	const save = refs.save;
	// "Nocturnal" (skill 16) and the torch widen what the survivor can make out in the dark
	let r = PLAYER_LIGHT_R;
	if (save.skillLevels[16] > 0) r *= 1.5;
	if (save.equipHand === 15) r = math.max(r, 400);
	// every survivor carries their own light (F1+: their own save decides the radius)
	for (const p of refs.players) {
		lights.push({ x: p.x, y: p.y, r, kind: 1, angle: 0 });
		if (save.equipHand === 13) {
			lights.push({ x: p.x, y: p.y, r: FLASHLIGHT_R, kind: 2, angle: p.angle });
		}
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
		tracks.clear();
		seenMorning = refs.daynight.morningCount;
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
		// one window centred on the local survivor; F2 makes the field multi-source (§3.3)
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

/** world and body radius the flanking probes test against (module level: no closure per call) */
let probeWorld: WorldData | undefined;
let probeR = 16;
const probeFree = (px: number, py: number): boolean =>
	probeWorld === undefined || circleBlocked(probeWorld, px, py, probeR) === undefined;

/** which way this zombie prefers to go round a jam (constant per zombie, so a crowd splits, not swings) */
function flankBias(z: ZombieState): number {
	return ((z.id * 2.399) % 2) - 1;
}

/** is it time for this zombie to re-plan? (LOD ring, §3.4; staggered by id so the cost spreads) */
function navDue(z: ZombieState, distP: number, dt: number): boolean {
	z.navCd = (z.navCd ?? 0) - dt;
	if ((z.navCd ?? 0) > 0 && z.navDir !== undefined) return false;
	z.navCd = Sense.decisionInterval(distP) * (0.75 + ((z.id * 7) % 10) / 20);
	return true;
}

/**
 * Is this zombie actually getting anywhere? Its path cost to the survivor is exact (the flow field computed
 * it), so "has it dropped since last time?" is free and cannot be fooled by a body pushing it around. When it
 * has NOT dropped for Flank.JAM_PATIENCE seconds and there is a crowd around, this one is the twelfth in the queue
 * at a door: it commits to walking round the building for Flank.ORBIT_TIME instead (shared/sim/ai/flank.ts).
 *
 * A zombie that is making progress — including one chewing through a barricade, which resets the timer when
 * it lands a hit — never leaves its lane.
 */
function updateJam(z: ZombieState, distP: number, dt: number): void {
	if ((z.orbit ?? 0) > 0 || distP < Flank.JAM_MIN_DIST || !flow.contains(z.x, z.y)) {
		z.jamT = 0;
		z.bestCells = undefined;
		return;
	}
	const cells = flow.pathCells(z.x, z.y);
	if (cells >= 1e8) {
		z.jamT = 0;
		return;
	}
	const best = z.bestCells;
	if (best === undefined || cells < best - Flank.JAM_PROGRESS) {
		z.bestCells = cells;
		z.jamT = 0;
		return;
	}
	z.jamT = (z.jamT ?? 0) + dt;
	if ((z.jamT ?? 0) >= Flank.JAM_PATIENCE && crowd.around(z.x, z.y) > Flank.FLANK_FREE_LANE) {
		z.jamT = 0;
		z.bestCells = undefined;
		z.orbit = Flank.ORBIT_TIME;
		z.orbitSide = flankBias(z) >= 0 ? 1 : -1;
	}
}

/**
 * Heading towards the survivor: straight when close, else along the flow field (doors!), with crowded
 * lanes priced so part of the horde peels off to another entrance (shared/sim/ai/flank.ts).
 */
function chaseHeading(refs: GameRefs, z: ZombieState, p: PlayerState, r: number, distP: number, dt: number): number {
	if (!navDue(z, distP, dt)) return z.navDir ?? 0;
	const direct = math.atan2(p.y - z.y, p.x - z.x);
	let h: number | undefined;
	if (distP < 72 && segmentClear(refs.world, z.x, z.y, p.x, p.y, blocksMovement)) {
		h = direct;
	} else if ((z.orbit ?? 0) > 0) {
		// walking round the building instead of queueing: follow the tangent, not the field
		h = steer(refs.world, z, r, direct + (math.pi / 2) * (z.orbitSide ?? 1));
	} else {
		if (flow.contains(z.x, z.y)) h = flow.heading(z.x, z.y);
		if (h === undefined) {
			h = steer(refs.world, z, r, direct);
		} else {
			probeWorld = refs.world;
			probeR = r;
			h = Flank.flankHeading(flow, crowd, z.x, z.y, h, flankBias(z), probeFree);
		}
	}
	z.navDir = h;
	return h;
}

/** heading towards a remembered place (last known position, search point): local steering only */
function gotoHeading(
	refs: GameRefs,
	z: ZombieState,
	r: number,
	tx: number,
	ty: number,
	distP: number,
	dt: number,
): number {
	if (!navDue(z, distP, dt)) return z.navDir ?? 0;
	const h = steer(refs.world, z, r, math.atan2(ty - z.y, tx - z.x));
	z.navDir = h;
	return h;
}

// --- crowd separation (spatial hash, §3.4) ------------------------------------------------------

const SEP_CELL = 64;
const sepBuckets = new Map<number, Array<number>>();
const bucketPool: Array<Array<number>> = [];
let bucketsUsed = 0;

function sepKey(x: number, y: number): number {
	const gx = math.floor(x / SEP_CELL) + 4096;
	const gy = math.floor(y / SEP_CELL) + 4096;
	return gy * 8192 + gx;
}

function bucketFor(key: number): Array<number> {
	let b = sepBuckets.get(key);
	if (b !== undefined) return b;
	if (bucketsUsed < bucketPool.size()) {
		b = bucketPool[bucketsUsed];
		b.clear();
	} else {
		b = [];
		bucketPool.push(b);
	}
	bucketsUsed++;
	sepBuckets.set(key, b);
	return b;
}

/**
 * Bodies push each other apart. The original's O(n²) pass cost 11k pair tests with 150 zombies; a 64 u
 * hash (wider than two big bodies) tests only real neighbours, which is what keeps the horde affordable.
 */
function computeSeparation(refs: GameRefs): void {
	const zs = refs.zombies;
	const n = zs.size();
	sepX.clear();
	sepY.clear();
	sepBuckets.clear();
	bucketsUsed = 0;
	for (let i = 0; i < n; i++) {
		sepX.push(0);
		sepY.push(0);
		const a = zs[i];
		if (a.jumping === true) continue;
		bucketFor(sepKey(a.x, a.y)).push(i);
	}
	for (let i = 0; i < n; i++) {
		const a = zs[i];
		if (a.jumping === true) continue;
		const ra = zombieRadius(a);
		const gx = math.floor(a.x / SEP_CELL) + 4096;
		const gy = math.floor(a.y / SEP_CELL) + 4096;
		for (let ox = -1; ox <= 1; ox++) {
			for (let oy = -1; oy <= 1; oy++) {
				const b = sepBuckets.get((gy + oy) * 8192 + gx + ox);
				if (b === undefined) continue;
				for (const j of b) {
					if (j <= i) continue;
					const o = zs[j];
					const min = ra + zombieRadius(o);
					const dx = o.x - a.x;
					const dy = o.y - a.y;
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
	}
}

/** crowd map of the zombies that are hunting: the flanking probes price the busy lanes with it */
function updateCrowd(refs: GameRefs): void {
	crowd.begin(refs.player.x, refs.player.y);
	for (const z of refs.zombies) {
		if (z.detect && z.hp > 0) crowd.add(z.x, z.y);
	}
}

// --- perception and the pack ---------------------------------------------------------------------

/**
 * Can this zombie perceive its target right now? Touch and the night/rain smell are free; sight needs the
 * target inside the range AND the cone AND a clear line. The line is a raycast, so it is spent from a
 * per-frame budget and cached for Sense.losInterval(dist) seconds — a horde never pays 150 rays in one frame.
 */
function perceive(refs: GameRefs, z: ZombieState, p: PlayerState, distP: number, dt: number): boolean {
	if (distP < Sense.TOUCH_RANGE) return true;
	if (distP < senses.smell) return true;
	if (!Sense.inSightCone(distP, z.angleSlow, math.atan2(p.y - z.y, p.x - z.x), senses)) {
		// out of the cone: drop the cached answer so it re-tests the moment the target comes back into it
		z.losClear = false;
		z.losCd = 0;
		return false;
	}
	z.losCd = (z.losCd ?? 0) - dt;
	if ((z.losCd ?? 0) <= 0 && losBudget > 0) {
		losBudget--;
		z.losCd = Sense.losInterval(distP) * (0.8 + ((z.id * 7) % 10) / 25);
		z.losClear = segmentClear(refs.world, z.x, z.y, p.x, p.y, blocksMovement);
	}
	return z.losClear === true;
}

/**
 * The zombie screams and the ones around it answer (shared/sim/ai/alert.ts). They are told the place the
 * shouter saw the survivor, not where the survivor is now, so they converge on it and search.
 */
function shout(refs: GameRefs, z: ZombieState, p: PlayerState): void {
	if (shoutsLeft <= 0 || (z.alertCd ?? 0) > 0) return;
	shoutsLeft--;
	z.alertCd = Alert.ALERT_COOLDOWN;
	z.shout = Alert.ALERT_SHOUT_TIME;
	const n = Alert.hearers(refs.zombies, z.x, z.y, z.id, alertOut);
	for (let k = 0; k < n; k++) {
		const o = refs.zombies[alertOut[k]];
		// woken zombies also get the cooldown: an alert cannot relay itself across the map
		o.alertCd = Alert.ALERT_COOLDOWN;
		o.detectShow = DETECT_SHOW_TIME;
		Mind.report(o, p.x, p.y);
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

/** seconds of sidestep, picking a side that keeps it inside the world it knows */
function startStrafe(z: ZombieState, seconds: number): void {
	if ((z.strafe ?? 0) > 0) return;
	z.strafe = seconds;
	z.strafeSide = (z.id + math.floor(frameNo / 17)) % 2 === 0 ? 1 : -1;
}

function strafeHeading(z: ZombieState, p: PlayerState): number {
	return math.atan2(p.y - z.y, p.x - z.x) + (math.pi / 2) * (z.strafeSide ?? 1);
}

function fireSpit(refs: GameRefs, z: ZombieState, p: PlayerState): void {
	const tx = z.aimX ?? p.x;
	const ty = z.aimY ?? p.y;
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

/** spitter: stays at range, winds its head back, spits where its target WILL be, then repositions */
function thinkSpitter(
	refs: GameRefs,
	z: ZombieState,
	p: PlayerState,
	hunting: boolean,
	dt: number,
	distP: number,
): void {
	z.attackCd = (z.attackCd ?? 0) - dt;
	const canSpit =
		hunting &&
		z.stunned <= 0 &&
		(z.stagger ?? 0) <= 0 &&
		distP < SPIT_RANGE &&
		(z.attackCd ?? 0) <= 0 &&
		((z.headX ?? 0) > 0 || segmentClear(refs.world, z.x, z.y, p.x, p.y, blocksShots));
	if (canSpit) {
		const t = trackOf(p);
		z.aimX = p.x + t.vx * SPIT_LEAD;
		z.aimY = p.y + t.vy * SPIT_LEAD;
		z.headX = (z.headX ?? 0) + 0.8 * SPEED_SCALE * dt;
		if ((z.headX ?? 0) >= 10) {
			z.headX = 0;
			z.attackCd = SPIT_COOLDOWN;
			fireSpit(refs, z, p);
			// never a turret: it slides to a new firing spot right after the shot
			z.strafe = SPIT_REPOSITION;
			z.strafeSide = (z.id + math.floor(frameNo / 13)) % 2 === 0 ? 1 : -1;
		}
	} else {
		z.headX = 0;
		// in range but the line is blocked: sidestep until it has one again
		if (hunting && distP < SPIT_RANGE && (z.attackCd ?? 0) <= 0) startStrafe(z, STRAFE_TIME);
	}
}

/**
 * Exploder: the original walks straight at you and only matters when it dies. Here it looks for the
 * juiciest thing to die NEXT TO — a player construction it can breach, or the middle of a group of
 * survivors — and heads for that instead. It keeps its identity (it never detonates on purpose).
 */
function thinkExploder(refs: GameRefs, z: ZombieState, p: PlayerState, dt: number, distP: number): void {
	z.attackCd = (z.attackCd ?? 0) - dt;
	if ((z.attackCd ?? 0) > 0) return;
	z.attackCd = 0.6;
	z.aimX = undefined;
	z.aimY = undefined;
	if (distP > EXPLODER_NEAR_TARGET) return;
	// two survivors standing together are worth more than either of them
	for (const a of refs.players) {
		if (a.dead) continue;
		for (const b of refs.players) {
			if (b === a || b.dead) continue;
			if (actorDist(a.x, a.y, b.x, b.y) > EXPLODER_CLUSTER) continue;
			z.aimX = (a.x + b.x) / 2;
			z.aimY = (a.y + b.y) / 2;
			return;
		}
	}
	// otherwise: the construction between it and the survivor
	seekSolids.clear();
	querySolids(
		refs.world,
		z.x - EXPLODER_SEEK,
		z.y - EXPLODER_SEEK,
		z.x + EXPLODER_SEEK,
		z.y + EXPLODER_SEEK,
		seekSolids,
	);
	let best: Solid | undefined;
	let bestD = math.huge;
	for (const s of seekSolids) {
		if (!isPlayerBuilt(s) || !s.destructible || s.removed === true || !isBlocking(s)) continue;
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		if (actorDist(cx, cy, z.x, z.y) > EXPLODER_SEEK) continue;
		const d = actorDist(cx, cy, p.x, p.y);
		if (d < bestD) {
			bestD = d;
			best = s;
		}
	}
	if (best !== undefined && bestD < distP) {
		z.aimX = best.x + best.w / 2;
		z.aimY = best.y + best.h / 2;
	}
}

function endRush(z: ZombieState): void {
	z.rush = false;
	z.rushReady = false;
	z.rushCd = RUSH_COOLDOWN;
	z.rushSpeed = RUSH_SPEED_MIN;
	z.rushTime = 0;
}

/**
 * Charger: keeps ~110 px away, then charges in a straight line when it has a clear run. Better than the
 * original: after a couple of attempts with no clear lane it stops shuffling into the wall and slides
 * sideways looking for one.
 */
function thinkCharger(
	refs: GameRefs,
	z: ZombieState,
	p: PlayerState,
	hunting: boolean,
	dt: number,
	distP: number,
): boolean {
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
	if (!hunting || z.stunned > 0 || (z.stagger ?? 0) > 0) return false;
	const losCheck = (frameNo + z.id) % 6 === 0; // the long LOS ray is checked ~10×/s, not every frame
	if (z.rushReady === true && distP > RUSH_MIN_DIST && losCheck) {
		if (segmentClear(refs.world, z.x, z.y, p.x, p.y, blocksMovement)) {
			z.rush = true;
			z.rushReady = false;
			z.rushFail = 0;
			z.rushTime = 0;
			z.rushSpeed = RUSH_SPEED_MIN;
			z.rushDir = math.atan2(p.y - z.y, p.x - z.x);
			z.angle = z.rushDir;
			z.angleSlow = z.rushDir;
			return true;
		}
		z.rushFail = (z.rushFail ?? 0) + 1;
		if ((z.rushFail ?? 0) >= RUSH_FAIL_MAX) {
			z.rushFail = 0;
			startStrafe(z, STRAFE_TIME);
		}
	}
	if (distP < RUSH_MIN_DIST + 10) z.backstep = true;
	return false;
}

const JUMP_TRIES_LEN: Array<number> = [JUMP_LENGTH, 150, 100];
const JUMP_TRIES_ANG: Array<number> = [0, 0.35, -0.35, 0.7, -0.7];

/** low enough for a leaping body to clear: a car bonnet, a wheelie bin. Never a wall or a barricade. */
function isLowObstacle(s: Solid): boolean {
	return s.tags === "car" || s.tags === "trash";
}

/** stops a jump in flight: everything that stops a body, except what a body can clear */
function blocksJump(s: Solid): boolean {
	return isBlocking(s) && !isLowObstacle(s);
}

/**
 * Take off towards `dir`, landing only on free ground with a clear flight line (the original jumper flew
 * through walls). Better than the original in the other direction too: the leap now CLEARS cars and bins,
 * and a hunting jumper only spends it when the landing actually shortens its path (flow-field cells), so
 * the jump reads as a shortcut over the traffic instead of a twitch.
 */
function startJump(refs: GameRefs, z: ZombieState, r: number, dir: number, hunting: boolean): boolean {
	const here = hunting && flow.contains(z.x, z.y) ? flow.pathCells(z.x, z.y) : undefined;
	for (const len of JUMP_TRIES_LEN) {
		for (const off of JUMP_TRIES_ANG) {
			const a = dir + off;
			const tx = z.x + math.cos(a) * len;
			const ty = z.y + math.sin(a) * len;
			if (circleBlocked(refs.world, tx, ty, r) !== undefined) continue;
			if (!segmentClear(refs.world, z.x, z.y, tx, ty, blocksJump)) continue;
			if (here !== undefined && here < 1e8) {
				// only worth it when it really cuts the corner
				if (!flow.contains(tx, ty)) continue;
				if (flow.pathCells(tx, ty) > here - JUMP_GAIN) continue;
			}
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

function thinkJumper(
	refs: GameRefs,
	z: ZombieState,
	p: PlayerState,
	r: number,
	hunting: boolean,
	dt: number,
	distP: number,
): void {
	z.jumpCd = (z.jumpCd ?? 0) - dt;
	if ((z.jumpCd ?? 0) > 0 || z.stunned > 0 || (z.stagger ?? 0) > 0) return;
	let dir: number | undefined;
	if (hunting) {
		dir = chaseHeading(refs, z, p, r, distP, dt);
	} else if (z.wanderPause !== true) {
		dir = z.wanderDir;
	}
	if (dir === undefined) return;
	if (!startJump(refs, z, r, dir, hunting)) {
		z.jumpCd = 0.5;
		if (!hunting) z.wanderDir = rnd() * math.pi * 2;
	}
}

function jumperPoison(refs: GameRefs, z: ZombieState, r: number): void {
	for (const p of refs.players) {
		if (actorDist(z.x, z.y, p.x, p.y) < r + PLAYER_RADIUS + 6 && p.buffs.poison < POISON_TIME) {
			p.buffs.poison = POISON_TIME;
		}
	}
}

// --- contact with the player ----------------------------------------------------------------------

function cancelWindup(z: ZombieState): void {
	z.windup = undefined;
	z.windupMax = undefined;
}

function bite(refs: GameRefs, z: ZombieState, p: PlayerState): void {
	const rushing = z.rush === true;
	const dmg = rushing ? (z.damageRush ?? z.damage) : z.damage;
	if (damageToPlayer(p, refs.save, dmg)) {
		p.reactionDir = math.atan2(p.y - z.y, p.x - z.x);
		if (rushing) p.reactionSpeed = math.max(p.reactionSpeed, DESIGN.REACTION_MAX + 4);
		fxBlood(refs, p.x, p.y, 4, "player");
		fxShake(refs, p, p.buffs.pain > 0 ? 3 : 5, 0.18);
		// obj_player_body: the zombie that landed the hit is stunned for stunned_time
		z.stunned = STUN_TIME;
	}
	if (rushing) {
		endRush(z);
		z.stunned = math.max(z.stunned, 0.5);
	}
}

/**
 * The bite. The original hits the frame the bodies touch, so there is nothing to read and nothing to dodge.
 * Here a walker pulls back for WINDUP_TIME first (the view leans it back with `windup`/`windupMax`) and the
 * bite only lands if the survivor is still there — step out and it whiffs and has to recover. A charge and
 * a leap keep biting on contact: the charge and the leap ARE their telegraph.
 */
function contactAttack(refs: GameRefs, z: ZombieState, p: PlayerState, dt: number): void {
	const rushing = z.rush === true;
	if ((z.stunned > 0 && !rushing) || (z.stagger ?? 0) > 0) {
		// a stunned or staggered zombie loses the bite it was winding up
		cancelWindup(z);
		return;
	}
	if (rushing || z.jumping === true) {
		bite(refs, z, p);
		return;
	}
	if (z.windup === undefined) {
		z.windup = WINDUP_TIME;
		z.windupMax = WINDUP_TIME;
		return;
	}
	z.windup = (z.windup ?? 0) - dt;
	if ((z.windup ?? 0) <= 0) {
		cancelWindup(z);
		bite(refs, z, p);
	}
}

// --- main -------------------------------------------------------------------------------------

function faceAndAnimate(
	z: ZombieState,
	p: PlayerState,
	movedX: number,
	movedY: number,
	dt: number,
	distP: number,
): void {
	const speed = dt > 0 ? math.sqrt(movedX * movedX + movedY * movedY) / dt : 0;
	const walking = speed > SPEED_SCALE;
	if (walking) z.angle = math.atan2(movedY, movedX);
	if (z.backstep === true) z.angle = math.atan2(p.y - z.y, p.x - z.x);
	if (z.detect && distP < 100) z.angle = math.atan2(p.y - z.y, p.x - z.x);
	if (z.type === 2 && (z.headX ?? 0) > 0 && z.aimX !== undefined && z.aimY !== undefined) {
		z.angle = math.atan2(z.aimY - z.y, z.aimX - z.x);
		z.angleSlow = z.angle;
	}
	if ((z.windup ?? 0) > 0) {
		// a wind-up faces its victim: the lean-back has to be readable
		z.angle = math.atan2(p.y - z.y, p.x - z.x);
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

/**
 * Senses + memory for one zombie: what it perceives now, what it remembers, and the shout when it is the
 * first to spot the survivor. Returns what the body should do this frame.
 */
function updateMind(refs: GameRefs, z: ZombieState, p: PlayerState, distP: number, dt: number): Mind.MindAction {
	if (z.hp <= 0) return "chase"; // a lit exploder walks at you whatever it can Mind.see
	const wasDetect = z.detect;
	const perceived = perceive(refs, z, p, distP, dt);
	const action = Mind.think(z, dt, perceived, p.x, p.y, z.x, z.y);
	if (perceived && !wasDetect) {
		z.detectShow = DETECT_SHOW_TIME;
		shout(refs, z, p);
	}
	// original leash: a plain ambient walker gives up 2000 px from where it spawned
	if (action !== "idle" && z.type === 1 && !z.wave) {
		const fromSpawn = actorDist(z.x, z.y, z.spawnX, z.spawnY);
		if (fromSpawn > LEASH_SPAWN && distP > LEASH_PLAYER) {
			Mind.forget(z);
			return "idle";
		}
	}
	return action;
}

/** returns true when the zombie must be removed */
function updateOne(refs: GameRefs, z: ZombieState, idx: number, dt: number): boolean {
	const world = refs.world;
	// the nearest living survivor is this zombie's target (a single survivor: always it)
	const p = nearestPlayer(refs, z.x, z.y);
	z.hitFlash = math.max(0, (z.hitFlash ?? 0) - dt);
	if (z.detectShow > 0) z.detectShow = math.max(0, z.detectShow - dt);
	if ((z.shout ?? 0) > 0) z.shout = math.max(0, (z.shout ?? 0) - dt);
	if ((z.alertCd ?? 0) > 0) z.alertCd = math.max(0, (z.alertCd ?? 0) - dt);
	if ((z.stagger ?? 0) > 0) z.stagger = math.max(0, (z.stagger ?? 0) - dt);
	if ((z.strafe ?? 0) > 0) z.strafe = math.max(0, (z.strafe ?? 0) - dt);
	if ((z.orbit ?? 0) > 0) z.orbit = math.max(0, (z.orbit ?? 0) - dt);

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
	const action = updateMind(refs, z, p, distP, dt);
	const hunting = action !== "idle";
	const seeing = action === "chase";
	if (seeing) {
		updateJam(z, distP, dt);
	} else {
		z.jamT = 0;
		z.bestCells = undefined;
	}
	const drawn = Sense.visibleToSomeone(distP);

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
		if (distP <= r + PLAYER_RADIUS + 2) contactAttack(refs, z, p, dt);
		faceAndAnimate(z, p, movedX, movedY, dt, distP);
		if (drawn) updateAlpha(refs, z, dt);
		return false;
	}

	// ---- decide the voluntary velocity (px/s) --------------------------------------------------
	let heading = 0;
	let speed = 0;
	let wandering = false;
	const dying = z.hp <= 0;
	const frozen = z.stunned > 0 || (z.stagger ?? 0) > 0;
	if (z.type === 2) thinkSpitter(refs, z, p, hunting, dt, distP);
	else if (z.type === 3) thinkExploder(refs, z, p, dt, distP);
	const rushing = z.type === 4 && thinkCharger(refs, z, p, hunting, dt, distP);

	if (rushing) {
		heading = z.rushDir ?? 0;
		speed = (z.rushSpeed ?? RUSH_SPEED_MIN) * SPEED_SCALE;
	} else if (z.type === 5) {
		thinkJumper(refs, z, p, r, hunting, dt, distP);
		jumperPoison(refs, z, r);
		// the jumper never walks: it only moves by jumping
	} else if ((z.windup ?? 0) > 0) {
		// winding up: it pulls back, so the bite is something you can Mind.see coming and step out of
		heading = math.atan2(z.y - p.y, z.x - p.x);
		speed = WINDUP_BACK * SPEED_SCALE;
	} else if (!frozen || dying) {
		// (a dying exploder ignores the stun: it keeps walking at you with its fuse lit)
		if (z.type === 2 && hunting) {
			// spitter kiting: give ground when crowded, hold still to spit, slide otherwise
			if (distP < SPIT_BACK) {
				heading = steer(world, z, r, math.atan2(z.y - p.y, z.x - p.x));
				speed = z.moveSpeed * SPEED_SCALE;
			} else if ((z.headX ?? 0) > 0) {
				speed = 0;
			} else if ((z.strafe ?? 0) > 0 || distP < SPIT_KEEP) {
				startStrafe(z, STRAFE_TIME);
				heading = steer(world, z, r, strafeHeading(z, p));
				speed = z.moveSpeed * STRAFE_SPEED * SPEED_SCALE;
			} else {
				heading = chaseHeading(refs, z, p, r, distP, dt);
				speed = z.moveSpeed * SPEED_SCALE;
			}
		} else if (z.type === 4 && hunting && (z.strafe ?? 0) > 0 && !rushing) {
			// charger with no clear lane: slide sideways looking for one instead of grinding a wall
			heading = steer(world, z, r, strafeHeading(z, p));
			speed = z.moveSpeed * STRAFE_SPEED * SPEED_SCALE;
		} else if (hunting && z.backstep === true) {
			heading = steer(world, z, r, math.atan2(z.y - p.y, z.x - p.x));
			speed = z.moveSpeed * SPEED_SCALE;
		} else if (seeing || dying) {
			// the exploder aims at the wall or the group it wants to die next to
			if (z.type === 3 && z.aimX !== undefined && z.aimY !== undefined) {
				heading = gotoHeading(refs, z, r, z.aimX, z.aimY, distP, dt);
			} else {
				heading = chaseHeading(refs, z, p, r, distP, dt);
			}
			speed = z.moveSpeed * SPEED_SCALE;
		} else if (action === "goto") {
			heading = gotoHeading(refs, z, r, z.lastSeenX ?? p.x, z.lastSeenY ?? p.y, distP, dt);
			speed = z.moveSpeed * SPEED_SCALE;
		} else if (action === "search") {
			const phase = (z.id * 2.399) % (math.pi * 2);
			heading = gotoHeading(refs, z, r, Mind.searchPointX(z, phase), Mind.searchPointY(z, phase), distP, dt);
			speed = z.moveSpeed * SEARCH_SPEED * SPEED_SCALE;
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
				// breaking the way in IS progress: it does not count as being stuck in a queue
				z.jamT = 0;
				z.stunned = STUN_TIME;
				if (rushing) endRush(z);
			}
		} else if (rushing) {
			// obj_zombie4: a rush that meets a wall ends in a crash
			endRush(z);
			z.stunned = math.max(z.stunned, 0.5);
			if (distP < 800) fxShake(refs, p, 4, 0.2);
		}
		if (wandering) z.wanderDir = rnd() * math.pi * 2;
		// a sidestep into a wall turns round instead of grinding along it
		if ((z.strafe ?? 0) > 0) z.strafeSide = -(z.strafeSide ?? 1);
	}

	// ---- the player is a solid body: stop at contact distance, wind up, bite --------------------
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
	if (distP <= minD + 3 || ((z.windup ?? 0) > 0 && distP <= minD + BITE_KEEP)) {
		contactAttack(refs, z, p, dt);
	} else if (z.windup !== undefined) {
		// the survivor stepped out of the wind-up: the bite whiffs and it has to recover
		cancelWindup(z);
		z.stunned = math.max(z.stunned, WHIFF_RECOVER);
	}

	// ---- floor trap: 40%/frame chance of a short stun (frame-rate independent) ------------------
	if (z.stunned <= 0 && findTrap(world, z.x, z.y) !== undefined) {
		if (rnd() < 1 - math.pow(0.6, dt * 30)) z.stunned = STUN_TIME / 4;
	}

	faceAndAnimate(z, p, movedX, movedY, dt, distP);
	if (drawn) updateAlpha(refs, z, dt);
	return false;
}

/**
 * Zombie AI + physics for one frame: noise, puddles, blasts, the flow field, crowd map, crowd separation
 * and each zombie's senses, memory and behaviour (walker, spitter, exploder, charger, jumper).
 */
export function updateZombies(refs: GameRefs, dt: number): void {
	syncWorld(refs);
	frameNo++;
	losBudget = LOS_BUDGET;
	shoutsLeft = Alert.ALERT_SHOUTS_PER_TICK;
	const dn = refs.daynight;
	senses = Sense.senseRanges(
		{ darkness: dn.darkAlpha, night: dn.isNight, raining: dn.isRaining },
		refs.save.skillLevels[15] > 0,
	);
	// 7:00 — zombies that did not come with a night wave lose the trail (and the memory with it)
	if (dn.morningCount !== seenMorning) {
		seenMorning = dn.morningCount;
		for (const z of refs.zombies) {
			if (!z.wave) Mind.forget(z);
		}
	}
	decayShakes(refs, dt);
	collectLights(refs);
	updateNoise(refs, dt);
	updatePuddles(refs, dt);
	updateExplosions(refs, dt);
	updateFlow(refs, dt);
	updateCrowd(refs);
	computeSeparation(refs);
	for (let i = refs.zombies.size() - 1; i >= 0; i--) {
		const z = refs.zombies[i];
		if (updateOne(refs, z, i, dt)) {
			refs.zombies.remove(i);
		}
	}
}

/** a zombie that spawns already hunting knows where the survivor was when it arrived, not for ever */
export function seedHunt(z: ZombieState, x: number, y: number): void {
	Mind.see(z, x, y);
}
