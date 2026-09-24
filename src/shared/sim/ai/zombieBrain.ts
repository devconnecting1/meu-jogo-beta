//!native
import { DESIGN } from "shared/engine/constants";
import { chance, choose, damageCal, rnd, rndRange } from "shared/engine/rng";
import { angleDiff } from "shared/engine/vec2";
import { PlayerState } from "shared/game/player";
import { isBlocking, querySolids, removeSolid, Solid, spawnGroundItem, WorldData } from "shared/game/world";
import * as Phys from "shared/game/physics";
import { ZombieState, zombieRadius } from "shared/game/entities";
import { zombieDef } from "shared/data/zombies";
import { BUILDING_SPAWNS } from "shared/data/spawns";
import { SPEED_SCALE } from "shared/sim/types";
// Namespace imports on purpose: roblox-ts emits ONE Luau local per named binding, and a module chunk may hold
// at most 200 locals. These modules are ~90 names between them and this file is the biggest in the game, which
// the compiler cannot see: it is a Luau LOAD-time limit, so the build stays green and the client fails to boot
// instead. Keep them qualified, and count the top-level locals (npm run check:registers) before adding one.
import * as Alert from "shared/sim/ai/alert";
import * as Ctx from "shared/sim/ai/context";
import * as Flank from "shared/sim/ai/flank";
import * as Mind from "shared/sim/ai/memory";
import * as Noise from "shared/sim/ai/noise";
import * as Sense from "shared/sim/ai/perception";
import * as T from "shared/sim/ai/zombieTuning";
import * as Light from "shared/sim/survivorLight";
import { SpatialHash } from "shared/sim/ai/spatialHash";
import { LIT_AMBIENT } from "shared/sim/weather";

/*
 * Zombie AI and physics, for ONE world — the client's own (MP_PHASE < 2) or the server's authoritative one
 * (docs/MULTIPLAYER.md §3.1, §3.3, §3.4). Everything it needs comes through AiRefs: the survivors, their saves,
 * the clock, the chase field and an Fx sink. Nothing here touches a camera, an Instance or a particle system,
 * and nothing here reads "the local player" — every survivor in refs.players is a possible target, and the one
 * a zombie hunts is the one the flow field routes its cell to (§3.3 `targetOf`).
 *
 * What the original (obj_zombie / par_zombie) does NOT have, and lives in shared/sim/ai/*:
 *   - eyes: by day it only notices you inside 50 px, and at night or in the rain every zombie on the map turns
 *     hostile at once (perception.ts gives it a range, a cone and a line of sight through the walls, day and
 *     night: darkness shortens it and your own light lengthens it; a glimpse at the edge of its eyes makes it
 *     suspicious before it is sure);
 *   - ears graded by what made the noise (noise.ts: a gun by class, building, breaking things, running, walking);
 *   - memory and a visible state: `detect` homes on your LIVE position for ever, through walls, until 7:00 clears
 *     it (memory.ts: idle → suspicious → searching → chasing, walking to the last place it had a reason to
 *     believe in and searching around it before giving up; the state goes to every client as 2 bits);
 *   - a pack: no code ever writes another zombie's `detect` (alert.ts makes the first one to spot you shout, with
 *     a hard wake budget so it can never cascade);
 *   - a gait of its own: speed, sway and turning vary per zombie, always at or below the original's speed;
 *   - a second route: mp_potential_step_object queues everyone on one line (flank.ts prices crowded lanes so part
 *     of the horde comes round the other side);
 *   - a wind-up: it bites the frame it touches you (here a short, readable lean-back you can step out of).
 */

// --- per-call scratch (never meaningful across calls; the per-world state lives in refs.ai) ------
const sepX: Array<number> = [];
const sepY: Array<number> = [];
/** each body's radius this tick: `zombieRadius` scans the type table, and the pair loop asked it per PAIR */
const sepR: Array<number> = [];
/** the stride `alongContacts` hands back */
const stride = { x: 0, y: 0 };
const sepHash = new SpatialHash();
const sepNear: Array<number> = [];
const nearSolids: Array<Solid> = [];
const seekSolids: Array<Solid> = [];
const alertOut: Array<number> = [];
/** which zombies of this tick's pass died (removed once the pass is over) */
const goneAt: Array<boolean> = [];
/** line-of-sight rays left this frame, and shouts left this frame */
let losBudget = T.LOS_BUDGET;
let shoutsLeft = Alert.ALERT_SHOUTS_PER_TICK;

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
 * Every light that matters this frame: the survivors' own, plus the lit structures around them. The array is
 * a POOL — entries are overwritten, never re-created — because this is rebuilt 60 times a second with six
 * survivors in it, and a table per light per tick is the kind of churn that shows up as a GC spike in the
 * §3.2 budget rather than as a cost in any one function.
 */
const lights: Array<Light> = [];
let lightCount = 0;

function addLight(x: number, y: number, r: number, kind: number, angle: number): void {
	const l = lights[lightCount];
	if (l === undefined) {
		lights.push({ x, y, r, kind, angle });
	} else {
		l.x = x;
		l.y = y;
		l.r = r;
		l.kind = kind;
		l.angle = angle;
	}
	lightCount += 1;
}

/** lit structures found by the sweep; double-buffered so a half-finished cycle never dims anything */
let structureLights: Array<Light> = [];
let structureBuild: Array<Light> = [];
/** Light records a cleared sweep list gave back, for the next sweep to fill (no table per lamp per sweep) */
const spareLights: Array<Light> = [];

function takeLight(x: number, y: number, r: number): Light {
	const l = spareLights.pop();
	if (l === undefined) return { x, y, r, kind: 1, angle: 0 };
	l.x = x;
	l.y = y;
	l.r = r;
	l.kind = 1;
	l.angle = 0;
	return l;
}

/** empties a sweep list, its records back to `spareLights` (nothing else holds them: `addLight` copies) */
function releaseLights(list: Array<Light>): void {
	for (const l of list) spareLights.push(l);
	list.clear();
}

/** kills since the last call, then resets: the pacing director's "they are winning" signal */
export function takeKills(ai: Ctx.BrainState): number {
	const n = ai.killCount;
	ai.killCount = 0;
	return n;
}

/**
 * The "!" of obj_zombie, and the groan with it: up for DETECT_SHOW_TIME from the tick a zombie starts CHASING
 * (the wire's Detect bit, which the client's audio listens to). The state itself (`aware`) is what the awareness
 * marks draw; this is only the moment it changed.
 */
function showDetect(z: ZombieState): void {
	z.detectShow = T.DETECT_SHOW_TIME;
}

/**
 * Knockback: the zombie is pushed along `fromAngle` (away from the attacker) at `power` px/frame,
 * stacking up to reaction_speed_max (9). Walls stop it (moveActor), stun does not cancel it.
 */
export function applyKnockback(z: ZombieState, fromAngle: number, power: number): void {
	if (z.jumping === true || z.rush === true) return;
	z.reactionDir = fromAngle;
	z.reactionSpeed = math.min(T.REACTION_MAX, z.reactionSpeed + power);
}

/**
 * Everything a zombie does when struck (bullet, arrow, blade, fire, shock): 1 s stun, flash,
 * knockback and it turns towards the attacker. Damage itself is applied by the caller.
 *
 * Better than the original, which never links being shot to `detect` at all: the zombie turns SUSPICIOUS
 * towards WHERE THE SHOT CAME FROM (`fromAngle` points away from the attacker) instead of magically knowing
 * where the shooter stands — so a shot from cover pulls the horde to the cover, not onto you. One already
 * chasing keeps chasing. A heavy hit (melee, headshot, blast) also staggers it and kills any bite it was
 * winding up.
 */
export function reactToHit(z: ZombieState, knockAngle: number, knockPower: number, stun = T.STUN_TIME): void {
	if (z.rush !== true) z.stunned = math.max(z.stunned, stun);
	z.hitFlash = 1;
	Mind.report(z, z.x - math.cos(knockAngle) * Mind.SHOT_MEMORY, z.y - math.sin(knockAngle) * Mind.SHOT_MEMORY);
	if (knockPower >= T.STAGGER_KNOCK) {
		z.stagger = math.max(z.stagger ?? 0, T.STAGGER_TIME);
		cancelWindup(z);
	}
	applyKnockback(z, knockAngle, knockPower);
}

// --- noise (shared/sim/ai/noise.ts) --------------------------------------------------------------

/**
 * Emit a noise ring (obj_sound / obj_sound_shot). Zombies reached by the growing ring go and look where it came
 * from (suspicious). Day and night, now that the night no longer turns every zombie at once; the rain masks it, and
 * so does a storm's thunderclap while it rolls (shared/sim/weather.ts `thunderMaskAt`).
 * `shot`: a bang, whose front races out and slows down (the original's shot ring) instead of spreading at a
 * walking pace.
 *
 * A ring from (nearly) the same place as a young one of the same kind merges into it — a machine-gun burst, a
 * shotgun's pellets landing, six blows on one barricade are ONE noise that carries as far as the loudest — so
 * the rings a tick has to walk stay few however much is going on. `unique` (the original kept one shot ring at
 * a time) merges a shot into any young shot ring.
 */
export function emitSound(refs: Ctx.AiRefs, x: number, y: number, rMax: number, shot: boolean, unique = false): void {
	// the rain muffles every ring, and a rolling thunderclap covers it further for a few seconds (LUZ-05)
	const clock = refs.clock;
	const heard = rMax * (clock.isRaining ? Sense.RAIN_HEARING : 1) * clock.thunderMask;
	if (heard <= 0) return;
	refs.sounds ??= [];
	const merge2 = Noise.MERGE_DIST * Noise.MERGE_DIST;
	for (const s of refs.sounds) {
		if (s.shot !== shot || s.r >= s.rMax * 0.5) continue;
		const dx = s.x - x;
		const dy = s.y - y;
		if ((unique && shot) || dx * dx + dy * dy <= merge2) {
			s.rMax = math.max(s.rMax, heard);
			return;
		}
	}
	refs.ai.ringSeq += 1;
	refs.sounds.push({ x, y, r: 0, rMax: heard, shot, id: refs.ai.ringSeq });
}

function updateNoise(refs: Ctx.AiRefs, dt: number): void {
	// a survivor who left (a leave, a rejoin: a new body is a new PlayerState) takes their footstep track with
	// them; kept, the map grew by one per rejoin and held every old body alive until the next world
	const tracks = refs.ai.tracks;
	if (tracks.size() > refs.players.size()) {
		for (const [p] of tracks) {
			if (!refs.players.includes(p)) tracks.delete(p);
		}
	}
	for (const p of refs.players) {
		const t = Ctx.trackOf(refs, p);
		let moved = 0;
		if (t.lastX !== undefined && dt > 0) {
			const dx = p.x - t.lastX;
			const dy = p.y - t.lastY;
			moved = math.sqrt(dx * dx + dy * dy);
			// ignore teleports (respawn, boss grab) when estimating the running velocity
			if (moved < 600 * dt + 50) {
				t.vx = dx / dt;
				t.vy = dy / dt;
			} else {
				moved = 0;
			}
		}
		t.lastX = p.x;
		t.lastY = p.y;
		if (p.dead) {
			t.walkAccum = 0;
			t.walkTimer = 0;
			continue;
		}
		// footsteps, flushed every walk_tempo like sys_sound_view, but graded by the gait over that window: the
		// survivor's run is the original's ring, a slowed survivor's walk half of it (noise.ts)
		t.walkAccum += moved;
		t.walkTimer += dt;
		if (t.walkTimer >= Noise.STEP_TEMPO) {
			// Stealth (skill 15) is the survivor's OWN: a quiet player is quiet for everyone
			const r = Noise.footstepRadius(t.walkAccum / t.walkTimer, refs.saveOf(p).skillLevels[15] > 0);
			if (r > 0) emitSound(refs, p.x, p.y, r, false);
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
			s.r += T.WALK_RING_SPEED * dt;
		}
		const r = math.min(s.r, s.rMax);
		const r2 = r * r;
		const id = s.id ?? 0;
		for (const z of refs.zombies) {
			const dx = z.x - s.x;
			const dy = z.y - s.y;
			if (dx * dx + dy * dy >= r2) continue;
			// a chasing zombie has better than a noise to go on, a wave zombie always knows, one walking round a
			// building to another way in is committed to it (flank.ts orbit), and a ring is heard once. Ring ids only
			// grow, so "once" is "not one older than the last it heard": inside two overlapping rings it answers the
			// newer, instead of the two taking turns every tick and renewing the walk there for ever
			if (
				z.hp <= 0 ||
				z.wave ||
				(id !== 0 && id <= (z.heardRing ?? 0)) ||
				Mind.chasing(z) ||
				(z.orbit ?? 0) > 0
			) {
				continue;
			}
			// a noise says WHERE IT CAME FROM, not where the survivor is now: it goes and looks
			z.heardRing = id;
			Mind.report(z, s.x, s.y);
		}
		if (s.r > s.rMax) sounds.remove(i);
	}
}

// --- puddles / explosions ----------------------------------------------------------------------

/** spitter acid lands: a puddle that halves a survivor's speed while they stand in it */
export function addPuddle(refs: Ctx.AiRefs, x: number, y: number): void {
	refs.puddles ??= [];
	refs.puddles.push({ x, y, r: T.PUDDLE_RADIUS, life: T.PUDDLE_LIFE, lifeMax: T.PUDDLE_LIFE });
}

function updatePuddles(refs: Ctx.AiRefs, dt: number): void {
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
			if (Ctx.actorDist(p.x, p.y, pd.x, pd.y) < pd.r) {
				p.puddleSlow = 0.2;
			}
		}
	}
}

/**
 * Loot rolled with the SCAVENGER skill of the survivor the drop is for. §3.6 gives the kill (and the drop
 * table) to whoever landed the final blow; combat lives on the server in F2-2C, so until it hands the killer
 * over, the nearest survivor is who the table is rolled for — which is exactly who it was before F2.
 */
function dropLoot(refs: Ctx.AiRefs, z: ZombieState, pi: number): void {
	// an admin's spawn pays nobody (docs/MULTIPLAYER.md §10): no drop either
	if (z.unpaid === true) return;
	const save = refs.saveOf(refs.players[pi < 0 ? 0 : pi]);
	const rate = DESIGN.ZOMBIE_ITEM_PERCENT + save.skillLevels[9] * 10;
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

function killZombie(refs: Ctx.AiRefs, z: ZombieState, pi: number): void {
	refs.onExp(z.exp, z.x, z.y);
	refs.ai.killCount += 1;
	Ctx.fxBlood(refs, z.x, z.y, 10);
	dropLoot(refs, z, pi);
}

function explode(refs: Ctx.AiRefs, z: ZombieState, pi: number): void {
	refs.explosions ??= [];
	refs.explosions.push({ x: z.x, y: z.y, r: 0, rMax: T.BLAST_RADIUS, life: 0.4 });
	refs.onExp(z.exp, z.x, z.y);
	refs.ai.killCount += 1;
	dropLoot(refs, z, pi);
	Ctx.fxBlood(refs, z.x, z.y, 12);
	Ctx.fxDebris(refs, z.x, z.y, 18, "exploder");
	for (let i = 0; i < refs.players.size(); i++) {
		const p = refs.players[i];
		if (Ctx.actorDist(p.x, p.y, z.x, z.y) < 800) Ctx.fxShake(refs, i, 7, 0.3);
	}
	emitSound(refs, z.x, z.y, Noise.EXPLOSION, true);
	// better than the original: the blast also throws and hurts the zombies around it
	for (const o of refs.zombies) {
		if (o === z || o.hp <= 0) continue;
		const d = Ctx.actorDist(o.x, o.y, z.x, z.y);
		if (d < T.BLAST_RADIUS) {
			o.hp -= T.BLAST_ZOMBIE_DAMAGE * (1 - d / T.BLAST_RADIUS);
			reactToHit(o, math.atan2(o.y - z.y, o.x - z.x), 9);
		}
	}
}

function updateExplosions(refs: Ctx.AiRefs, dt: number): void {
	const list = refs.explosions;
	if (list === undefined) return;
	for (let i = list.size() - 1; i >= 0; i--) {
		const e = list[i];
		if (e.r < e.rMax) {
			e.r = math.min(e.rMax, e.r + T.BLAST_GROW * dt);
			// obj_zombie3_boom: −6 hp every frame a survivor is inside the growing blast, ignoring i-frames
			for (const p of refs.players) {
				if (Ctx.actorDist(p.x, p.y, e.x, e.y) >= e.r + Phys.PLAYER_RADIUS * 0.5) continue;
				const wasHit = p.attacked;
				Ctx.hurtPlayer(refs, p, refs.saveOf(p), T.BLAST_DPS * dt, true);
				if (!wasHit) {
					p.reactionDir = math.atan2(p.y - e.y, p.x - e.x);
					// thrown away from the blast (ART-15: the spatter runs from the attacker through the target)
					Ctx.fxBlood(refs, p.x, p.y, 4, "player", p.reactionDir);
				}
			}
		} else {
			e.life -= dt;
			if (e.life <= 0) list.remove(i);
		}
	}
}

// --- constructions ----------------------------------------------------------------------------

/**
 * A zombie (or blast) hits a player construction; destroyed ones leave the world for real. Every blow is a bang
 * the street hears and the collapse a louder one (noise.ts): a siege calls the neighbourhood, so a barricade
 * buys time, never silence.
 */
export function damageStructure(refs: Ctx.AiRefs, s: Solid, dmg: number): void {
	if (!s.destructible || s.removed === true) return;
	s.hp -= dmg;
	s.hitShake = math.max(s.hitShake ?? 0, 8 / 30);
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	Ctx.fxDebris(refs, cx, cy, 3, "structure");
	emitSound(refs, cx, cy, s.hp <= 0 ? Noise.STRUCT_BREAK : Noise.STRUCT_HIT, true);
	if (s.hp <= 0) {
		Ctx.fxDebris(refs, cx, cy, 14, "structure");
		removeSolid(refs.world, s);
		// the way in just opened: the navigation owner has to re-rasterise that patch (§3.3 dirty tiles)
		if (refs.onSolidChanged !== undefined) refs.onSolidChanged(s.x, s.y, s.w, s.h);
	}
}

/** keeps `refs.ai.anyTrap` true to the world: recounted only when a solid (or an item) came or went */
function scanTraps(refs: Ctx.AiRefs): void {
	const w = refs.world;
	const key = w.solids.size() * 7919 + w.nextId * 31 + w.nextDynamicId;
	if (key === refs.ai.trapKey) return;
	refs.ai.trapKey = key;
	refs.ai.anyTrap = false;
	for (const s of w.solids) {
		if (s.tags === "trap" || s.tags === "trap_electric") {
			refs.ai.anyTrap = true;
			return;
		}
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

// --- lighting (image_alpha of obj_zombie) ------------------------------------------------------

/**
 * Lit structures and shaking solids around ONE survivor, in turn: lamps do not move, so sweeping every
 * survivor's window every frame would pay six spatial queries a frame for nothing. With a single survivor
 * this is the window that was swept every frame before F2; with six it is one of them per frame, and the
 * shake decay is scaled by how many frames that solid waited.
 */
function sweepAround(refs: Ctx.AiRefs, p: PlayerState, dt: number, decayMult: number): void {
	nearSolids.clear();
	querySolids(
		refs.world,
		p.x - T.LIGHT_WINDOW,
		p.y - T.LIGHT_WINDOW,
		p.x + T.LIGHT_WINDOW,
		p.y + T.LIGHT_WINDOW,
		nearSolids,
	);
	const dark = refs.clock.darkAlpha > 0.05;
	for (const s of nearSolids) {
		const t = s.hitShake;
		if (t !== undefined && t > 0) s.hitShake = math.max(0, t - dt * decayMult);
		if (!dark || s.powered !== true) continue;
		const lr = T.STRUCTURE_LIGHT_R[s.tags];
		if (lr !== undefined) structureBuild.push(takeLight(s.x + s.w / 2, s.y + s.h / 2, lr));
	}
}

function collectLights(refs: Ctx.AiRefs, dt: number): void {
	const n = refs.players.size();
	const slot = refs.ai.frameNo % n;
	if (slot === 0) releaseLights(structureBuild);
	// one survivor's window per frame: with a single survivor this is exactly the sweep of every frame
	// before F2, and with six the cost stays at one spatial query per tick (§3.2). The shake decays by the
	// frames that solid waited, so a struck car settles at the same rate whoever is standing next to it.
	sweepAround(refs, refs.players[slot], dt, n);
	if (slot === n - 1) {
		// a full cycle is complete: publish it in one go, so nothing ever reads a half-swept list
		const done = structureBuild;
		structureBuild = structureLights;
		structureLights = done;
	}

	lightCount = 0;
	for (const p of refs.players) {
		// a corpse holds no torch: a dead survivor lit the zombies round their body, and so put them on the wire
		// to everyone in range (MP-07) while every screen drew that spot dark
		if (!Light.carriesLight(p)) continue;
		const save = refs.saveOf(p);
		// the survivor's own light, by the ONE rule the client's light map draws too (shared/sim/survivorLight.ts,
		// LUZ-04): Nocturnal, the torch and night vision widen the circle; the flashlight adds its cone along the aim,
		// or, riding a motorcycle, the headlight along the ride (VEI-05)
		addLight(p.x, p.y, Light.survivorLightRadius(save), 1, 0);
		const beam = Light.survivorBeamReach(p, save);
		if (beam > 0) addLight(p.x, p.y, beam, 2, Light.survivorBeamAngle(p));
	}
	if (refs.clock.darkAlpha <= 0.05) return;
	for (const l of structureLights) addLight(l.x, l.y, l.r, l.kind, l.angle);
	// a lamp drone in the air (ELE-05): lit like a lamp, where it flies this tick
	const carried = refs.carriedLights;
	if (carried !== undefined) for (const l of carried) addLight(l.x, l.y, l.r, 1, 0);
}

/**
 * obj_zombie image_alpha's own rule, and `server/net/interest.ts` `visibleInDark`'s: lit while ambient light
 * ≥ 0.4 (day, dusk) or standing inside someone's light — the same DARK_LIT_AMBIENT / light loop the interest
 * table has to agree with to the letter (§4.3), factored out so a zombie being BORN (`spawnAlpha` below) and
 * a zombie already alive (`updateAlpha`) never answer differently for the same spot.
 */
function isLit(refs: Ctx.AiRefs, x: number, y: number): boolean {
	if (1 - refs.clock.darkAlpha >= LIT_AMBIENT) return true;
	for (let i = 0; i < lightCount; i++) {
		const l = lights[i];
		const dx = x - l.x;
		const dy = y - l.y;
		if (dx * dx + dy * dy > l.r * l.r) continue;
		if (l.kind === 2 && math.abs(angleDiff(l.angle, math.atan2(dy, dx))) > Light.CONE_HALF_ANGLE) continue;
		return true;
	}
	return false;
}

/**
 * The same question for any spot, for the server's interest rules (§4.3; audit L2): an effect, a death or a ground
 * item there is sent to a viewer in the dark only if the spot is lit -- the very test a zombie standing there would
 * be sent by. It reads the lights of the horde's last step (`collectLights`), so ask it after that step.
 */
export function positionLit(refs: Ctx.AiRefs, x: number, y: number): boolean {
	return isLit(refs, x, y);
}

/**
 * obj_zombie image_alpha: fully visible while ambient light ≥ 0.4 (day, dusk) or when inside a
 * light; otherwise it fades out in the dark (3/s), like the original.
 */
function updateAlpha(refs: Ctx.AiRefs, z: ZombieState, dt: number): void {
	const target = isLit(refs, z.x, z.y) ? 1 : 0;
	if (z.alpha < target) z.alpha = math.min(target, z.alpha + 3 * dt);
	else if (z.alpha > target) z.alpha = math.max(target, z.alpha - 3 * dt);
}

/**
 * The alpha a zombie should be BORN with (anti-ESP, docs/MULTIPLAYER.md §4.3 + §9.1, F2-2D). Without this every
 * zombie spawns at alpha 1 and `updateAlpha` fades it down over ~(1 − LIT_ALPHA_MIN) / 3 s ≈ 0.32 s
 * (server/net/interest.ts `LIT_ALPHA_MIN`, `visibleInDark`); during that window `alpha > LIT_ALPHA_MIN` is
 * true and the interest rules hand its exact spawn point to anyone within replication range, whether or not
 * anyone could actually see it — a wave zombie born 720-1080 u away, off screen, was leaking its birthplace to
 * a wallhack for a third of a second before ever being noticed by a light. A zombie born already lit (day, or
 * standing in a torch's radius) is untouched: this is exactly the alpha it would have eased towards on its
 * first tick anyway, so daytime spawns and spawns inside a light still appear at once, as before.
 */
export function spawnAlpha(refs: Ctx.AiRefs, x: number, y: number): number {
	return isLit(refs, x, y) ? 1 : 0;
}

// --- navigation ------------------------------------------------------------------------------

function syncWorld(refs: Ctx.AiRefs): void {
	if (refs.ai.boundWorld !== refs.world) {
		refs.ai.boundWorld = refs.world;
		// the frame counter is per WORLD, not per session: it phases the staggered checks (which zombie
		// re-plans this tick, which way a sidestep goes), so a world that starts with it at some leftover
		// value plays differently from the same world started again. That is a difference the determinism
		// autotest of §12.2 exists to catch, and the only place it can be fixed is here.
		refs.ai.frameNo = 0;
		refs.ai.scanFrom = -1;
		refs.ai.tracks.clear();
		refs.ai.seenMorning = refs.clock.morningCount;
		releaseLights(structureLights);
		releaseLights(structureBuild);
	}
}

const PROBE_OFFSETS: Array<number> = [0, 0.5, -0.5, 1, -1, 1.6, -1.6];

/** local steering when there is no flow field: first free heading around the wanted one */
function steer(world: WorldData, z: ZombieState, r: number, wanted: number): number {
	const probe = r + 14;
	for (const off of PROBE_OFFSETS) {
		const a = wanted + off;
		if (Phys.circleBlocked(world, z.x + math.cos(a) * probe, z.y + math.sin(a) * probe, r) === undefined) {
			return a;
		}
	}
	return wanted;
}

/** world and body radius the flanking probes test against (module level: no closure per call) */
let probeWorld: WorldData | undefined;
let probeR = 16;
const probeFree = (px: number, py: number): boolean =>
	probeWorld === undefined || Phys.circleBlocked(probeWorld, px, py, probeR) === undefined;

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
 * it lands a hit — never leaves its lane. Nor does one that is MOVING without getting nearer: a quick walker
 * jostling past a slow one in a stream of bodies (every zombie has its own gait, IA-04) is not a queue. A queue
 * is standing still: more than JAM_STILL from where it last made progress, and it starts counting again.
 */
function updateJam(refs: Ctx.AiRefs, z: ZombieState, distP: number, dt: number): void {
	const field = refs.field;
	if ((z.orbit ?? 0) > 0 || distP < Flank.JAM_MIN_DIST || !field.contains(z.x, z.y)) {
		z.jamT = 0;
		z.bestCells = undefined;
		return;
	}
	const cells = field.pathCells(z.x, z.y);
	if (cells >= 1e8) {
		z.jamT = 0;
		return;
	}
	const best = z.bestCells;
	const ax = z.jamX ?? z.x;
	const ay = z.jamY ?? z.y;
	const moved = (z.x - ax) * (z.x - ax) + (z.y - ay) * (z.y - ay) > T.JAM_STILL * T.JAM_STILL;
	if (best === undefined || cells < best - Flank.JAM_PROGRESS || moved) {
		z.bestCells = best === undefined || cells < best ? cells : best;
		z.jamX = z.x;
		z.jamY = z.y;
		z.jamT = 0;
		return;
	}
	z.jamT = (z.jamT ?? 0) + dt;
	if ((z.jamT ?? 0) >= Flank.JAM_PATIENCE && refs.ai.crowd.around(z.x, z.y) > Flank.FLANK_FREE_LANE) {
		z.jamT = 0;
		z.bestCells = undefined;
		z.orbit = Flank.ORBIT_TIME;
		z.orbitSide = flankBias(z) >= 0 ? 1 : -1;
	}
}

/**
 * Heading towards the survivor: straight when close, else along the flow field (doors!), with crowded
 * lanes priced so part of the horde peels off to another entrance (shared/sim/ai/flank.ts).
 *
 * §3.3 widens the straight-line case to DIRECT_CHASE (200 u): the multi-source field can be a quarter of a
 * second old, and the last few metres of a chase must not lag behind the body it is chasing.
 *
 * `gx, gy`: where the straight last stretch heads — the survivor itself in a chase, the remembered PLACE for a
 * suspicious zombie that takes the field's way there (`fieldGoto`).
 */
function chaseHeading(
	refs: Ctx.AiRefs,
	z: ZombieState,
	p: PlayerState,
	r: number,
	distP: number,
	dt: number,
	gx = p.x,
	gy = p.y,
): number {
	if (!navDue(z, distP, dt)) return z.navDir ?? 0;
	const direct = math.atan2(gy - z.y, gx - z.x);
	let h: number | undefined;
	if (
		Ctx.actorDist(z.x, z.y, gx, gy) < T.DIRECT_CHASE &&
		Phys.segmentClear(refs.world, z.x, z.y, gx, gy, Phys.blocksMovement)
	) {
		h = direct;
	} else if ((z.orbit ?? 0) > 0) {
		// walking round the building instead of queueing: follow the tangent, not the field
		h = steer(refs.world, z, r, direct + (math.pi / 2) * (z.orbitSide ?? 1));
	} else {
		if (refs.field.contains(z.x, z.y)) h = refs.field.heading(z.x, z.y);
		if (h === undefined) {
			h = steer(refs.world, z, r, direct);
		} else {
			probeWorld = refs.world;
			probeR = r;
			h = Flank.flankHeading(refs.field, refs.ai.crowd, z.x, z.y, h, flankBias(z), probeFree);
		}
	}
	z.navDir = h;
	return h;
}

/**
 * Does this suspicious zombie take the chase field's way to its remembered place? Only when that place is where a
 * survivor still is (within FIELD_GOTO): the field is a map of the ways to them, so it walks through the door and
 * round the building instead of into the wall — it knows roughly where you are and takes the way a body would.
 * A survivor who moved on leaves it local steering to an old place, which it gives up if it cannot reach.
 */
function fieldGoto(refs: Ctx.AiRefs, z: ZombieState, p: PlayerState): boolean {
	const lx = z.lastSeenX;
	const ly = z.lastSeenY;
	if (p.dead || lx === undefined || ly === undefined || !refs.field.contains(z.x, z.y)) return false;
	return Ctx.actorDist(lx, ly, p.x, p.y) < T.FIELD_GOTO && Ctx.actorDist(z.x, z.y, lx, ly) > T.DIRECT_CHASE;
}

/** heading towards a remembered place (last known position, search point): local steering only */
function gotoHeading(
	refs: Ctx.AiRefs,
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

/**
 * Bodies push each other apart. The original's O(n²) pass cost 11k pair tests with 150 zombies; the 64 u
 * hash (wider than two big bodies) tests only real neighbours, which is what keeps the horde affordable.
 */
function computeSeparation(refs: Ctx.AiRefs): void {
	const zs = refs.zombies;
	const n = zs.size();
	sepX.clear();
	sepY.clear();
	sepR.clear();
	sepHash.begin();
	// the contact slots are kept between ticks and only ever grow: resetting a count is all a tick costs
	while (contactN.size() < n) contactN.push(0);
	while (contactK.size() < n * MAX_CONTACTS * 3) contactK.push(0);
	for (let i = 0; i < n; i++) {
		sepX.push(0);
		sepY.push(0);
		contactN[i] = 0;
		const a = zs[i];
		sepR.push(zombieRadius(a));
		if (a.jumping === true) continue;
		sepHash.insert(i, a.x, a.y);
	}
	for (let i = 0; i < n; i++) {
		const a = zs[i];
		if (a.jumping === true) continue;
		const ra = sepR[i];
		sepNear.clear();
		sepHash.neighbours(a.x, a.y, sepNear);
		for (const j of sepNear) {
			if (j <= i) continue;
			const o = zs[j];
			const min = ra + sepR[j];
			const reach = min + T.CONTACT_MARGIN;
			const dx = o.x - a.x;
			const dy = o.y - a.y;
			if (math.abs(dx) >= reach || math.abs(dy) >= reach) continue;
			const d2 = dx * dx + dy * dy;
			if (d2 >= reach * reach) continue;
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
			// both touch each other (LEG-05): each remembers which way the other one is, for `alongContacts`
			const k = math.min(1, (reach - d) / T.CONTACT_MARGIN);
			addContact(i, -nx, -ny, k);
			addContact(j, nx, ny, k);
			if (d >= min) continue;
			// each gets half of the overlap (capped so a pile resolves over a few frames, no jitter)
			const push = math.min(6, (min - d) * 0.5);
			sepX[i] -= nx * push;
			sepY[i] -= ny * push;
			sepX[j] += nx * push;
			sepY[j] += ny * push;
		}
	}
}

/**
 * The bodies each zombie touches this tick (LEG-05), recorded by `computeSeparation` while it visits the pairs
 * anyway: `contactN[i]` of them, each as (nx, ny, k) in `contactK` from `i * MAX_CONTACTS * 3` -- the unit normal
 * pointing away from the other body and how firmly it touches (0 at T.CONTACT_MARGIN away, 1 touching). Flat and
 * reused: a second neighbour query per zombie made the horde's step 70 % dearer in tools/test-ai.mjs [11].
 */
const contactN: Array<number> = [];
const contactK: Array<number> = [];
/** equal bodies round one body touch it six at a time; a seventh is a pile the separation is already resolving */
const MAX_CONTACTS = 6;

function addContact(i: number, nx: number, ny: number, k: number): void {
	const c = contactN[i];
	if (c >= MAX_CONTACTS || k <= 0) return;
	const at = (i * MAX_CONTACTS + c) * 3;
	contactK[at] = nx;
	contactK[at + 1] = ny;
	contactK[at + 2] = k;
	contactN[i] = c + 1;
}

/** removes from `stride` the part of it that walks into the unit normal (nx, ny), weighted by `k` */
function slideOff(nx: number, ny: number, k: number): void {
	const into = stride.x * nx + stride.y * ny;
	if (into >= 0) return;
	stride.x -= into * nx * k;
	stride.y -= into * ny * k;
}

/**
 * LEG-05: a body does not walk into what it is already touching. Writes into `stride` the voluntary step
 * (mx, my) without its components that point into the survivor it is pressed against or into the bodies around
 * it, and keeps the rest -- so a zombie slides along a crowd, or stands, instead of shoving. The component into a
 * body fades out over the last T.CONTACT_MARGIN units before touching (a switch at one distance chattered: in on
 * one tick, out on the next), and a body wedged between the ones it touches simply stands.
 *
 * Why it exists (tools/test-zombie-motion.mjs, scenario b): a ring of walkers round a survivor kept walking
 * INTO them every tick. The contact rule put each one back at arm's length and the separation shoved its
 * neighbours aside, so the whole ring slid sideways and kicked (1.3-2.9 u in one tick), and their faces swung
 * with it. The bite is untouched: contact is still "within 3 u of touching", and a walker settles inside that.
 *
 * The other bodies are the ones `computeSeparation` found touching at the start of the tick (`contactK`), the
 * same positions the separation itself resolves; a body moves a unit or two in a tick, well inside the margin.
 */
function alongContacts(
	z: ZombieState,
	p: PlayerState,
	idx: number,
	r: number,
	distP: number,
	mx: number,
	my: number,
): void {
	stride.x = mx;
	stride.y = my;
	// the survivor it is pressed against: read NOW, it is the one body the whole bite is about
	const touch = r + Phys.PLAYER_RADIUS;
	const pk = distP > 0.01 ? math.clamp((touch + T.CONTACT_MARGIN - distP) / T.CONTACT_MARGIN, 0, 1) : 0;
	const pnx = pk > 0 ? (z.x - p.x) / distP : 0;
	const pny = pk > 0 ? (z.y - p.y) / distP : 0;
	const n = contactN[idx] ?? 0;
	if (pk <= 0 && n === 0) return;
	const base = idx * MAX_CONTACTS * 3;
	// twice: sliding off one body can point the stride into another
	for (let pass = 0; pass < 2; pass++) {
		if (pk > 0) slideOff(pnx, pny, pk);
		for (let c = 0; c < n; c++) {
			const at = base + c * 3;
			slideOff(contactK[at], contactK[at + 1], contactK[at + 2]);
		}
	}
	// still walking into a body it TOUCHES after that: it is wedged, and a wedged body stands
	let wedged = pk >= 1 && stride.x * pnx + stride.y * pny < -1e-3;
	for (let c = 0; c < n && !wedged; c++) {
		const at = base + c * 3;
		wedged = contactK[at + 2] >= 1 && stride.x * contactK[at] + stride.y * contactK[at + 1] < -1e-3;
	}
	if (wedged) {
		stride.x = 0;
		stride.y = 0;
	}
}

/**
 * Crowd map of the zombies that are hunting: the flanking probes price the busy lanes with it. The window is
 * centred on the middle of the living survivors, which for a single one (or a group, §3.5) is where the
 * queueing happens; a zombie outside it simply reads 0 and follows the field, as it always did.
 */
function updateCrowd(refs: Ctx.AiRefs): void {
	let cx = 0;
	let cy = 0;
	let n = 0;
	for (const p of refs.players) {
		if (p.dead) continue;
		cx += p.x;
		cy += p.y;
		n += 1;
	}
	if (n === 0) {
		const p = refs.players[0];
		cx = p.x;
		cy = p.y;
		n = 1;
	}
	refs.ai.crowd.begin(cx / n, cy / n);
	for (const z of refs.zombies) {
		if (z.aware === Mind.Aware.Chasing && z.hp > 0) refs.ai.crowd.add(z.x, z.y);
	}
}

// --- perception and the pack ---------------------------------------------------------------------

/** pooled light and weather of this tick (updateSenses) */
const senseCond: Sense.SenseConditions = { darkness: 0, night: false, raining: false, fog: 0 };

/**
 * Per survivor, once per tick: the light they carry or stand in, and so how far each sense reaches against them
 * (perception.ts). Their own glow, a torch or a flashlight; standing in a lamp's or a fire's light counts as
 * daylight. Pooled: six survivors, sixty ticks a second.
 */
function updateSenses(refs: Ctx.AiRefs): void {
	const clock = refs.clock;
	senseCond.darkness = clock.darkAlpha;
	senseCond.night = clock.isNight;
	senseCond.raining = clock.isRaining;
	senseCond.fog = clock.fog;
	const senses = refs.ai.senses;
	const beacons = refs.ai.beacons;
	const n = refs.players.size();
	for (let i = 0; i < n; i++) {
		const p = refs.players[i];
		const save = refs.saveOf(p);
		let b = beacons[i];
		if (b === undefined) {
			b = { range: 0, beam: 0, beamAngle: 0 };
			beacons[i] = b;
		}
		// the light they give off, by the ONE rule the light map and `isLit` read (shared/sim/survivorLight.ts,
		// LUZ-04): the glow or a torch all round, and a flashlight's cone along the aim -- or a motorcycle's headlight
		// along the ride: the light that lets a rider see the road is the light that gives them away (IA-01)
		b.beam = Light.survivorBeamReach(p, save);
		b.beamAngle = Light.survivorBeamAngle(p);
		b.range = Sense.beaconSight(math.max(Light.survivorGlowRadius(save), b.beam));
		if (b.range < Sense.LAMP_SIGHT) {
			for (const l of structureLights) {
				const dx = p.x - l.x;
				const dy = p.y - l.y;
				if (dx * dx + dy * dy <= l.r * l.r) {
					b.range = Sense.LAMP_SIGHT;
					break;
				}
			}
		}
		const s = senses[i];
		const stealthy = save.skillLevels[15] > 0;
		if (s === undefined) senses[i] = Sense.senseRanges(senseCond, b, stealthy);
		else Sense.senseRanges(senseCond, b, stealthy, s);
	}
	while (senses.size() > n) senses.pop();
}

/**
 * One LOOK at the target (staggered: perception.ts `senseInterval`). In view = inside the eye cone (or standing
 * in the survivor's flashlight beam) AND a clear line through the walls (`blocksSight`). The line is a raycast,
 * spent from a per-tick budget; a zombie the budget could not serve keeps its last answer and looks again on the
 * next tick, so a horde never pays 150 rays in one tick. Returns false when it had to wait for the budget.
 */
function look(refs: Ctx.AiRefs, z: ZombieState, p: PlayerState, pi: number, distP: number): boolean {
	const senses = Ctx.sensesOf(refs, pi);
	const toP = math.atan2(p.y - z.y, p.x - z.x);
	const seen = Sense.inSightCone(distP, z.angleSlow, toP, senses);
	if (!p.dead && (seen || (distP <= senses.sight && Sense.inBeam(distP, toP + math.pi, senses)))) {
		if (losBudget <= 0) return false;
		losBudget--;
		z.losClear = Phys.segmentClear(refs.world, z.x, z.y, p.x, p.y, Sense.blocksSight);
	} else {
		z.losClear = false;
	}
	z.sightK = senses.sight > 0 ? distP / senses.sight : 1;
	return true;
}

/**
 * The zombie groans and the ones around it answer (shared/sim/ai/alert.ts). They are told the place the
 * shouter saw the survivor, not where the survivor is now: they turn suspicious and converge on it.
 */
function shout(refs: Ctx.AiRefs, z: ZombieState, p: PlayerState): void {
	if (shoutsLeft <= 0 || (z.alertCd ?? 0) > 0) return;
	shoutsLeft--;
	z.alertCd = Alert.ALERT_COOLDOWN;
	z.shout = Alert.ALERT_SHOUT_TIME;
	const n = Alert.hearers(refs.zombies, z.x, z.y, z.id, alertOut);
	for (let k = 0; k < n; k++) {
		const o = refs.zombies[alertOut[k]];
		// woken zombies also get the cooldown: an alert cannot relay itself across the map
		o.alertCd = Alert.ALERT_COOLDOWN;
		Mind.report(o, p.x, p.y);
	}
}

// --- natural motion (DESIGN_RULES IA-04) ----------------------------------------------------------

/** a per-zombie constant in [0, 1), hashed from its id: its gait, its sway's phase */
function trait(z: ZombieState, salt: number): number {
	return ((((z.id + salt) * 0.6180339887) % 1) + 1) % 1;
}

/**
 * Random walk with pauses (random_move / alarm[2]), made to read as a shamble: each leg turns from the last
 * instead of picking a brand-new bearing, the legs and the stops are longer and uneven, and half the stops are a
 * look around — the body turns, and its eye cone sweeps the street with it.
 */
function wander(z: ZombieState, dt: number): number {
	z.wanderTimer -= dt;
	if (z.wanderTimer <= 0) {
		if (z.wanderPause === true) {
			z.wanderPause = false;
			z.wanderTimer = rndRange(T.WANDER_LEG_MIN, T.WANDER_LEG_MAX);
			z.wanderDir += rndRange(-T.WANDER_TURN, T.WANDER_TURN);
		} else {
			z.wanderPause = true;
			z.wanderTimer = rndRange(T.WANDER_PAUSE_MIN, T.WANDER_PAUSE_MAX);
			if (rnd() < T.WANDER_LOOK) z.angle = z.angleSlow + rndRange(-1.6, 1.6);
		}
	}
	if (z.wanderPause === true) return 0;
	return ((z.moveSpeed * 2) / 3) * SPEED_SCALE * (T.AMBLE_MIN + (1 - T.AMBLE_MIN) * trait(z, 3));
}

/**
 * The body walks the way the brain wants, but like a body: never faster than it did (a gait of its own in
 * [GAIT_MIN, 1] of its speed while chasing), swaying a little in time with its steps, swinging round at a
 * turn rate instead of snapping, and getting up to speed instead of teleporting its velocity. None of it applies
 * in the last DIRECT_CHASE of a chase: the approach and the bite stay exactly on line.
 *
 * The result is `z.walkDir` (the heading it walks) and `z.pace` (u/s).
 */
function naturalMotion(
	z: ZombieState,
	heading: number,
	speed: number,
	chase: boolean,
	distP: number,
	dt: number,
): void {
	const close = chase && distP < T.DIRECT_CHASE;
	let want = heading;
	let target = speed;
	if (chase) target *= T.GAIT_MIN + (1 - T.GAIT_MIN) * trait(z, 7);
	if (target > 0 && !(chase && distP < T.WOBBLE_NEAR)) {
		const amp = chase ? T.WOBBLE_CHASE : T.WOBBLE_CALM;
		want += math.sin((z.feetCycle ?? 0) * 0.5 + trait(z, 11) * math.pi * 2) * amp;
	}
	const cur = z.walkDir;
	if (close || cur === undefined || target <= 0) {
		z.walkDir = want;
	} else {
		const turn = (chase ? T.TURN_CHASE : z.aware === Mind.Aware.Idle ? T.TURN_WANDER : T.TURN_ALERT) * dt;
		const d = angleDiff(cur, want);
		z.walkDir = math.abs(d) <= turn ? want : cur + (d > 0 ? turn : -turn);
	}
	const pace = z.pace ?? target;
	const step = T.PACE_ACCEL * dt;
	z.pace = close ? target : math.abs(target - pace) <= step ? target : pace + (target > pace ? step : -step);
}

/** seconds of sidestep, picking a side that keeps it inside the world it knows */
function startStrafe(refs: Ctx.AiRefs, z: ZombieState, seconds: number): void {
	if ((z.strafe ?? 0) > 0) return;
	z.strafe = seconds;
	z.strafeSide = (z.id + math.floor(refs.ai.frameNo / 17)) % 2 === 0 ? 1 : -1;
}

function strafeHeading(z: ZombieState, p: PlayerState): number {
	return math.atan2(p.y - z.y, p.x - z.x) + (math.pi / 2) * (z.strafeSide ?? 1);
}

function fireSpit(refs: Ctx.AiRefs, z: ZombieState, p: PlayerState): void {
	const tx = z.aimX ?? p.x;
	const ty = z.aimY ?? p.y;
	const ang = math.atan2(ty - z.y, tx - z.x);
	refs.bullets.push({
		id: -(1 + (z.id % 90000)),
		x: z.x,
		y: z.y,
		angle: ang,
		range: Ctx.actorDist(z.x, z.y, tx, ty),
		travel: 0,
		damage: 0,
		speed: T.SPIT_SPEED,
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
	refs: Ctx.AiRefs,
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
		distP < T.SPIT_RANGE &&
		(z.attackCd ?? 0) <= 0 &&
		((z.headX ?? 0) > 0 || Phys.segmentClear(refs.world, z.x, z.y, p.x, p.y, Phys.blocksShots));
	if (canSpit) {
		const t = Ctx.trackOf(refs, p);
		z.aimX = p.x + t.vx * T.SPIT_LEAD;
		z.aimY = p.y + t.vy * T.SPIT_LEAD;
		z.headX = (z.headX ?? 0) + 0.8 * SPEED_SCALE * dt;
		if ((z.headX ?? 0) >= 10) {
			z.headX = 0;
			z.attackCd = T.SPIT_COOLDOWN;
			fireSpit(refs, z, p);
			// never a turret: it slides to a new firing spot right after the shot
			z.strafe = T.SPIT_REPOSITION;
			z.strafeSide = (z.id + math.floor(refs.ai.frameNo / 13)) % 2 === 0 ? 1 : -1;
		}
	} else {
		z.headX = 0;
		// in range but the line is blocked: sidestep until it has one again
		if (hunting && distP < T.SPIT_RANGE && (z.attackCd ?? 0) <= 0) startStrafe(refs, z, T.STRAFE_TIME);
	}
}

/**
 * Exploder: the original walks straight at you and only matters when it dies. Here it looks for the
 * juiciest thing to die NEXT TO — a player construction it can breach, or the middle of a group of
 * survivors — and heads for that instead. It keeps its identity (it never detonates on purpose).
 */
function thinkExploder(refs: Ctx.AiRefs, z: ZombieState, p: PlayerState, dt: number, distP: number): void {
	z.attackCd = (z.attackCd ?? 0) - dt;
	if ((z.attackCd ?? 0) > 0) return;
	z.attackCd = 0.6;
	z.aimX = undefined;
	z.aimY = undefined;
	if (distP > T.EXPLODER_NEAR_TARGET) return;
	// two survivors standing together are worth more than either of them
	for (const a of refs.players) {
		if (a.dead) continue;
		for (const b of refs.players) {
			if (b === a || b.dead) continue;
			if (Ctx.actorDist(a.x, a.y, b.x, b.y) > T.EXPLODER_CLUSTER) continue;
			z.aimX = (a.x + b.x) / 2;
			z.aimY = (a.y + b.y) / 2;
			return;
		}
	}
	// otherwise: the construction between it and the survivor
	seekSolids.clear();
	querySolids(
		refs.world,
		z.x - T.EXPLODER_SEEK,
		z.y - T.EXPLODER_SEEK,
		z.x + T.EXPLODER_SEEK,
		z.y + T.EXPLODER_SEEK,
		seekSolids,
	);
	let best: Solid | undefined;
	let bestD = math.huge;
	for (const s of seekSolids) {
		if (!Phys.isPlayerBuilt(s) || !s.destructible || s.removed === true || !isBlocking(s)) continue;
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		if (Ctx.actorDist(cx, cy, z.x, z.y) > T.EXPLODER_SEEK) continue;
		const d = Ctx.actorDist(cx, cy, p.x, p.y);
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
	z.rushCd = T.RUSH_COOLDOWN;
	z.rushSpeed = T.RUSH_SPEED_MIN;
	z.rushTime = 0;
}

/**
 * Charger: keeps ~110 px away, then charges in a straight line when it has a clear run. Better than the
 * original: after a couple of attempts with no clear lane it stops shuffling into the wall and slides
 * sideways looking for one.
 */
function thinkCharger(
	refs: Ctx.AiRefs,
	z: ZombieState,
	p: PlayerState,
	hunting: boolean,
	dt: number,
	distP: number,
): boolean {
	if (z.rush === true) {
		z.rushTime = (z.rushTime ?? 0) + dt;
		z.rushSpeed = math.min(T.RUSH_SPEED_MAX, (z.rushSpeed ?? T.RUSH_SPEED_MIN) + T.RUSH_ACCEL * dt);
		z.reactionSpeed = 0;
		if ((z.rushTime ?? 0) >= T.RUSH_TIME) endRush(z);
		return z.rush === true;
	}
	z.backstep = false;
	z.holdGround = false;
	if (z.rushReady !== true) {
		z.rushCd = (z.rushCd ?? 0) - dt;
		if ((z.rushCd ?? 0) <= 0) z.rushReady = true;
	}
	if (!hunting || z.stunned > 0 || (z.stagger ?? 0) > 0) return false;
	// the long LOS ray is checked ~10×/s, not every frame
	const losCheck = (refs.ai.frameNo + z.id) % 6 === 0;
	if (z.rushReady === true && distP > T.RUSH_MIN_DIST && losCheck) {
		if (Phys.segmentClear(refs.world, z.x, z.y, p.x, p.y, Phys.blocksMovement)) {
			z.rush = true;
			z.rushReady = false;
			z.rushFail = 0;
			z.rushTime = 0;
			z.rushSpeed = T.RUSH_SPEED_MIN;
			z.rushDir = math.atan2(p.y - z.y, p.x - z.x);
			z.angle = z.rushDir;
			z.angleSlow = z.rushDir;
			return true;
		}
		z.rushFail = (z.rushFail ?? 0) + 1;
		if ((z.rushFail ?? 0) >= T.RUSH_FAIL_MAX) {
			z.rushFail = 0;
			startStrafe(refs, z, T.STRAFE_TIME);
		}
	}
	// It keeps its distance (~110 px) with a band, not a line (LEG-05): with a single threshold it stepped out on
	// one tick and back in on the next, for ever -- a 30 Hz shiver of 1.25 u that the 20 Hz snapshot turned into a
	// 10 Hz wobble on every screen (tools/test-zombie-motion.mjs, 13 reversals a second). Now it backs off below the
	// band, walks in above it, and stands its ground, facing the target, inside it.
	const keep = T.RUSH_MIN_DIST + 10;
	if (distP < keep - T.KEEP_BAND) z.backstep = true;
	else if (distP < keep + T.KEEP_BAND) z.holdGround = true;
	return false;
}

const JUMP_TRIES_LEN: Array<number> = [T.JUMP_LENGTH, 150, 100];
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
function startJump(refs: Ctx.AiRefs, z: ZombieState, r: number, dir: number, hunting: boolean): boolean {
	const field = refs.field;
	const here = hunting && field.contains(z.x, z.y) ? field.pathCells(z.x, z.y) : undefined;
	for (const len of JUMP_TRIES_LEN) {
		for (const off of JUMP_TRIES_ANG) {
			const a = dir + off;
			const tx = z.x + math.cos(a) * len;
			const ty = z.y + math.sin(a) * len;
			if (Phys.circleBlocked(refs.world, tx, ty, r) !== undefined) continue;
			if (!Phys.segmentClear(refs.world, z.x, z.y, tx, ty, blocksJump)) continue;
			if (here !== undefined && here < 1e8) {
				// only worth it when it really cuts the corner
				if (!field.contains(tx, ty)) continue;
				if (field.pathCells(tx, ty) > here - T.JUMP_GAIN) continue;
			}
			z.jumping = true;
			z.jumpReady = false;
			z.jumpCd = T.JUMP_COOLDOWN;
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

/**
 * The jumper only moves by leaping: at the survivor it sees (`hunting`), at the place it has a reason to look
 * (`goal`, suspicious or searching), or along its wander.
 */
function thinkJumper(
	refs: Ctx.AiRefs,
	z: ZombieState,
	p: PlayerState,
	r: number,
	hunting: boolean,
	goal: number | undefined,
	dt: number,
	distP: number,
): void {
	z.jumpCd = (z.jumpCd ?? 0) - dt;
	if ((z.jumpCd ?? 0) > 0 || z.stunned > 0 || (z.stagger ?? 0) > 0) return;
	let dir: number | undefined;
	if (hunting) {
		dir = chaseHeading(refs, z, p, r, distP, dt);
	} else if (goal !== undefined) {
		dir = goal;
	} else if (z.wanderPause !== true) {
		dir = z.wanderDir;
	}
	if (dir === undefined) return;
	if (!startJump(refs, z, r, dir, hunting)) {
		z.jumpCd = 0.5;
		if (!hunting) z.wanderDir = rnd() * math.pi * 2;
	}
}

function jumperPoison(refs: Ctx.AiRefs, z: ZombieState, r: number): void {
	for (const p of refs.players) {
		if (Ctx.actorDist(z.x, z.y, p.x, p.y) < r + Phys.PLAYER_RADIUS + 6 && p.buffs.poison < T.POISON_TIME) {
			p.buffs.poison = T.POISON_TIME;
		}
	}
}

// --- contact with the player ----------------------------------------------------------------------

function cancelWindup(z: ZombieState): void {
	z.windup = undefined;
	z.windupMax = undefined;
}

function bite(refs: Ctx.AiRefs, z: ZombieState, p: PlayerState, pi: number): void {
	const rushing = z.rush === true;
	const dmg = rushing ? (z.damageRush ?? z.damage) : z.damage;
	if (Ctx.hurtPlayer(refs, p, refs.saveOf(p), dmg)) {
		p.reactionDir = math.atan2(p.y - z.y, p.x - z.x);
		if (rushing) p.reactionSpeed = math.max(p.reactionSpeed, DESIGN.REACTION_MAX + 4);
		// from the biter through the bitten (ART-15)
		Ctx.fxBlood(refs, p.x, p.y, 4, "player", p.reactionDir);
		Ctx.fxShake(refs, pi, p.buffs.pain > 0 ? 3 : 5, 0.18);
		// the bite is heard where it landed, by everyone near (P0-4): only a bite that drew blood, never the lean
		Ctx.fxSound(refs, "bite", p.x, p.y);
		// obj_player_body: the zombie that landed the hit is stunned for stunned_time
		z.stunned = T.STUN_TIME;
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
function contactAttack(refs: Ctx.AiRefs, z: ZombieState, p: PlayerState, pi: number, dt: number): void {
	const rushing = z.rush === true;
	if ((z.stunned > 0 && !rushing) || (z.stagger ?? 0) > 0) {
		// a stunned or staggered zombie loses the bite it was winding up
		cancelWindup(z);
		return;
	}
	if (rushing || z.jumping === true) {
		bite(refs, z, p, pi);
		return;
	}
	if (z.windup === undefined) {
		z.windup = T.WINDUP_TIME;
		z.windupMax = T.WINDUP_TIME;
		return;
	}
	z.windup = (z.windup ?? 0) - dt;
	if ((z.windup ?? 0) <= 0) {
		// the survivor is inside the last bite's guard: hold the lean and bite the moment it ends. Biting into
		// the guard was a bite with no blood — a crowd "attacking" for nothing (LEG-04)
		if (p.attacked) {
			z.windup = 0;
			return;
		}
		cancelWindup(z);
		bite(refs, z, p, pi);
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
	if (z.backstep === true || z.holdGround === true) z.angle = math.atan2(p.y - z.y, p.x - z.x);
	if (z.aware === Mind.Aware.Chasing && distP < 100) z.angle = math.atan2(p.y - z.y, p.x - z.x);
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
	const turn = T.TURN_RATE * dt;
	if (math.abs(diff) <= turn) z.angleSlow = z.angle;
	else z.angleSlow += diff > 0 ? turn : -turn;
	if (walking) {
		z.feetCycle =
			((z.feetCycle ?? 0) + T.FEET_RATE * dt * math.clamp(speed / (3 * SPEED_SCALE), 0.5, 2)) % (math.pi * 2);
	} else {
		z.feetCycle = 0;
	}
}

/**
 * Is it sure it sees the survivor? Touch (every tick, free, through anything); otherwise the staggered look
 * (`look`) and the certainty it builds: instant up close, a fraction of a second more the further and the
 * darker, twice as fast for a zombie already looking for someone, and fading once the survivor is out of view.
 * In view but not yet sure is a GLIMPSE: the zombie walks to where it saw something (suspicious).
 */
function senseTarget(
	refs: Ctx.AiRefs,
	z: ZombieState,
	p: PlayerState,
	pi: number,
	distP: number,
	dt: number,
	was: number,
): boolean {
	if (z.sensedFor !== pi) {
		// the field handed it another survivor: what it saw of the last one (in view, how sure) says nothing about
		// this one, so it starts from nothing and looks now. A chase goes on through the grace meanwhile, and one
		// clear look at the new survivor keeps it going (a chase is kept by any clear look). A newborn's first
		// target keeps its staggered first look (createZombie)
		if ((z.sensedFor ?? -1) >= 0) z.senseCd = 0;
		z.sensedFor = pi;
		z.losClear = false;
		z.notice = 0;
	}
	if (!p.dead && distP < Sense.TOUCH_RANGE) {
		z.notice = 1;
		z.losClear = true;
		return true;
	}
	// a newcomer's first look lands somewhere inside its first interval, so a batch born together never looks
	// in the same tick again
	if (z.senseCd === undefined) z.senseCd = Sense.senseInterval(distP) * trait(z, 5);
	z.senseCd = (z.senseCd ?? 0) - dt;
	if ((z.senseCd ?? 0) <= 0) {
		const interval = Sense.senseInterval(distP) * (0.8 + trait(z, 5) * 0.4);
		if (look(refs, z, p, pi, distP)) {
			z.senseCd = interval;
			if (z.losClear === true) {
				let t = Sense.noticeTime(distP, Ctx.sensesOf(refs, pi).sight);
				if (was === Mind.Aware.Suspicious || was === Mind.Aware.Searching) t /= Sense.NOTICE_ALERT;
				// a chase is kept by any clear look: certainty is what it takes to START one
				z.notice = was === Mind.Aware.Chasing || t <= 0 ? 1 : math.min(1, (z.notice ?? 0) + interval / t);
			} else {
				z.notice = math.max(0, (z.notice ?? 0) - Sense.NOTICE_DECAY * interval);
			}
		} else if (z.losClear === true && (z.senseCd ?? 0) < -T.LOS_STALE) {
			// the tick's rays ran out before its turn, tick after tick: an "in view" this old is not trusted (the
			// survivor may have gone behind a wall since), and it counts as out of view until it gets its look
			z.losClear = false;
		}
	} else if (z.losClear === true && (p.dead || distP > Ctx.sensesOf(refs, pi).sight)) {
		// between looks the last answer stands, but never for a survivor who is now out of range (a respawn, a
		// teleport): it would "see" them wherever they went
		z.losClear = false;
	}
	return z.losClear === true && (z.notice ?? 0) >= 1;
}

/**
 * Senses + memory for one zombie: what it perceives now, what it remembers, the state the players are shown,
 * and the groan when it is the first to spot the survivor. Returns what the body should do this frame.
 */
function updateMind(
	refs: Ctx.AiRefs,
	z: ZombieState,
	p: PlayerState,
	pi: number,
	distP: number,
	dt: number,
): Mind.MindAction {
	const was = z.aware ?? Mind.Aware.Idle;
	if (z.hp <= 0 || z.wave) {
		// a lit exploder walks at you whatever it can see; a night-wave zombie is the original's tide — it knows
		// where you are and does not stop knowing, so a wave never breaks up into a search party
		z.aware = Mind.Aware.Chasing;
		if (z.wave && !z.detect) Mind.see(z, p.x, p.y);
		z.lostFor = 0;
		if (was !== Mind.Aware.Chasing) showDetect(z);
		return "chase";
	}
	const sure = senseTarget(refs, z, p, pi, distP, dt, was);
	if (!sure && z.losClear === true && !p.dead) Mind.report(z, p.x, p.y); // a glimpse
	let action = Mind.think(z, dt, sure, p.x, p.y, z.x, z.y);
	// original leash: a plain ambient walker gives up 2000 px from where it spawned
	if (action !== "idle" && z.type === 1) {
		const fromSpawn = Ctx.actorDist(z.x, z.y, z.spawnX, z.spawnY);
		if (fromSpawn > T.LEASH_SPAWN && distP > T.LEASH_PLAYER) {
			Mind.forget(z);
			action = "idle";
		}
	}
	const now = Mind.awareOf(action);
	z.aware = now;
	if (now === Mind.Aware.Chasing && was !== Mind.Aware.Chasing) {
		showDetect(z);
		// only a zombie that saw the survivor with its own eyes groans for the others
		if (sure) shout(refs, z, p);
	} else if (now === Mind.Aware.Idle && was !== Mind.Aware.Idle) {
		// it gave up: a moment standing where the trail went cold, then it wanders off from there
		z.notice = 0;
		z.wanderPause = true;
		z.wanderTimer = T.GIVE_UP_PAUSE;
	}
	return action;
}

/** returns true when the zombie must be removed */
function updateOne(refs: Ctx.AiRefs, z: ZombieState, idx: number, dt: number): boolean {
	const world = refs.world;
	// §3.3: the survivor the field routes this cell to — the nearest one along a REAL path, which behind a
	// wall is not the nearest one in a straight line. Everyone down: it keeps milling around the bodies.
	let pi = Ctx.targetIndexFor(refs, z.x, z.y);
	if (pi < 0) pi = 0;
	const p = refs.players[pi];
	z.hitFlash = math.max(0, (z.hitFlash ?? 0) - dt);
	if (z.detectShow > 0) z.detectShow = math.max(0, z.detectShow - dt);
	if ((z.shout ?? 0) > 0) z.shout = math.max(0, (z.shout ?? 0) - dt);
	if ((z.alertCd ?? 0) > 0) z.alertCd = math.max(0, (z.alertCd ?? 0) - dt);
	if ((z.stagger ?? 0) > 0) z.stagger = math.max(0, (z.stagger ?? 0) - dt);
	if ((z.strafe ?? 0) > 0) z.strafe = math.max(0, (z.strafe ?? 0) - dt);
	if ((z.orbit ?? 0) > 0) z.orbit = math.max(0, (z.orbit ?? 0) - dt);

	if (z.hp <= 0) {
		if (z.type !== 3) {
			killZombie(refs, z, pi);
			return true;
		}
		// the exploder keeps walking with a lit fuse, then blows up
		if ((z.fuse ?? -1) < 0) {
			z.fuse = T.FUSE_TIME;
			z.detect = true;
			z.hitFlash = 1;
		}
		z.fuse = (z.fuse ?? 0) - dt;
		if ((z.fuse ?? 0) <= 0) {
			explode(refs, z, pi);
			return true;
		}
	}

	const r = sepR[idx] ?? zombieRadius(z);
	let distP = Ctx.actorDist(z.x, z.y, p.x, p.y);
	if (z.stunned > 0) z.stunned = math.max(0, z.stunned - dt);
	z.reactionSpeed = math.min(T.REACTION_MAX, z.reactionSpeed);
	if (z.reactionSpeed > 0) z.reactionSpeed = math.max(0, z.reactionSpeed - DESIGN.REACTION_FRICTION * dt);
	const action = updateMind(refs, z, p, pi, distP, dt);
	// the specials only fight what they SEE: a suspicious spitter walks to the place, it does not spit at it
	const seeing = action === "chase";
	const fielded = action === "goto" && fieldGoto(refs, z, p);
	if (seeing || fielded) {
		const before = z.bestCells;
		updateJam(refs, z, distP, dt);
		// on the field's way, getting nearer along the path IS progress, and so is walking round the building to
		// another way in (flank.ts orbit): neither is a place it cannot reach (memory GOTO_STALL)
		const after = z.bestCells;
		if (fielded && ((z.orbit ?? 0) > 0 || (after !== undefined && (before === undefined || after < before)))) {
			z.gotoT = 0;
			z.gotoBest = undefined;
		}
	} else {
		z.jamT = 0;
		z.bestCells = undefined;
	}
	const drawn = Sense.visibleToSomeone(distP);

	// ---- airborne jumper: flies its planned line, lands early on a wall -------------------------
	if (z.type === 5 && z.jumping === true) {
		const step = T.JUMP_SPEED * dt;
		const dir = z.jumpDir ?? 0;
		const res = Phys.moveActor(world, z.x, z.y, r, math.cos(dir) * step, math.sin(dir) * step);
		const movedX = res.x - z.x;
		const movedY = res.y - z.y;
		z.x = res.x;
		z.y = res.y;
		z.jumpTravel = (z.jumpTravel ?? 0) + step;
		z.jumpAir = (z.jumpAir ?? 0) + dt;
		const len = z.jumpLength ?? T.JUMP_LENGTH;
		const t = math.clamp((z.jumpTravel ?? 0) / len, 0, 1);
		z.jumpHeight = math.sin(t * math.pi) * T.JUMP_LIFT;
		if (res.hit !== undefined || t >= 1 || (z.jumpAir ?? 0) >= T.JUMP_AIR_MAX) {
			z.jumping = false;
			z.jumpHeight = 0;
		}
		distP = Ctx.actorDist(z.x, z.y, p.x, p.y);
		jumperPoison(refs, z, r);
		if (distP <= r + Phys.PLAYER_RADIUS + 2) contactAttack(refs, z, p, pi, dt);
		faceAndAnimate(z, p, movedX, movedY, dt, distP);
		if (drawn) updateAlpha(refs, z, dt);
		return false;
	}

	// ---- decide the voluntary velocity (px/s) --------------------------------------------------
	let heading = 0;
	let speed = 0;
	let wandering = false;
	/** a walk the natural-motion pass shapes (chase, goto, search, wander), and whether it is a chase */
	let natural = false;
	let chaseWalk = false;
	const dying = z.hp <= 0;
	const frozen = z.stunned > 0 || (z.stagger ?? 0) > 0;
	const phase = (z.id * 2.399) % (math.pi * 2);
	if (z.type === 2) thinkSpitter(refs, z, p, seeing, dt, distP);
	else if (z.type === 3) thinkExploder(refs, z, p, dt, distP);
	const rushing = z.type === 4 && thinkCharger(refs, z, p, seeing, dt, distP);

	if (rushing) {
		heading = z.rushDir ?? 0;
		speed = (z.rushSpeed ?? T.RUSH_SPEED_MIN) * SPEED_SCALE;
	} else if (z.type === 5) {
		let goal: number | undefined;
		if (action === "goto") {
			goal = math.atan2((z.lastSeenY ?? p.y) - z.y, (z.lastSeenX ?? p.x) - z.x);
		} else if (action === "search" && Mind.searchWalk(z, phase, dt, z.x, z.y)) {
			goal = math.atan2(Mind.searchPointY(z, phase) - z.y, Mind.searchPointX(z, phase) - z.x);
		}
		thinkJumper(refs, z, p, r, seeing, goal, dt, distP);
		jumperPoison(refs, z, r);
		// the jumper never walks: it only moves by jumping
	} else if ((z.windup ?? 0) > 0) {
		// winding up: it pulls back, so the bite is something you can see coming and step out of
		heading = math.atan2(z.y - p.y, z.x - p.x);
		speed = T.WINDUP_BACK * SPEED_SCALE;
	} else if (!frozen || dying) {
		// (a dying exploder ignores the stun: it keeps walking at you with its fuse lit)
		if (z.type === 2 && seeing) {
			// spitter kiting: give ground when crowded, hold still to spit, slide otherwise
			if (distP < T.SPIT_BACK) {
				heading = steer(world, z, r, math.atan2(z.y - p.y, z.x - p.x));
				speed = z.moveSpeed * SPEED_SCALE;
			} else if ((z.headX ?? 0) > 0) {
				speed = 0;
			} else if ((z.strafe ?? 0) > 0 || distP < T.SPIT_KEEP) {
				startStrafe(refs, z, T.STRAFE_TIME);
				heading = steer(world, z, r, strafeHeading(z, p));
				speed = z.moveSpeed * T.STRAFE_SPEED * SPEED_SCALE;
			} else {
				heading = chaseHeading(refs, z, p, r, distP, dt);
				speed = z.moveSpeed * SPEED_SCALE;
			}
		} else if (z.type === 4 && seeing && (z.strafe ?? 0) > 0 && !rushing) {
			// charger with no clear lane: slide sideways looking for one instead of grinding a wall
			heading = steer(world, z, r, strafeHeading(z, p));
			speed = z.moveSpeed * T.STRAFE_SPEED * SPEED_SCALE;
		} else if (seeing && z.backstep === true) {
			heading = steer(world, z, r, math.atan2(z.y - p.y, z.x - p.x));
			speed = z.moveSpeed * SPEED_SCALE;
		} else if (seeing && z.holdGround === true) {
			// the charger at the distance it keeps: it waits for its lane (speed stays 0)
		} else if (seeing || dying) {
			// the exploder aims at the wall or the group it wants to die next to
			if (z.type === 3 && z.aimX !== undefined && z.aimY !== undefined) {
				heading = gotoHeading(refs, z, r, z.aimX, z.aimY, distP, dt);
			} else {
				heading = chaseHeading(refs, z, p, r, distP, dt);
			}
			speed = z.moveSpeed * SPEED_SCALE;
			natural = true;
			chaseWalk = true;
		} else if (action === "goto") {
			const gx = z.lastSeenX ?? p.x;
			const gy = z.lastSeenY ?? p.y;
			heading = fielded
				? chaseHeading(refs, z, p, r, distP, dt, gx, gy)
				: gotoHeading(refs, z, r, gx, gy, distP, dt);
			speed = z.moveSpeed * T.SUSPICIOUS_SPEED * SPEED_SCALE;
			natural = true;
		} else if (action === "search") {
			if (Mind.searchWalk(z, phase, dt, z.x, z.y)) {
				heading = gotoHeading(refs, z, r, Mind.searchPointX(z, phase), Mind.searchPointY(z, phase), distP, dt);
				speed = z.moveSpeed * T.SEARCH_SPEED * SPEED_SCALE;
			} else {
				// standing and looking round: the body turns, and the eye cone sweeps with it
				heading = z.walkDir ?? z.angle;
				z.angle = Mind.lookAngle(z, phase);
			}
			natural = true;
		} else {
			speed = wander(z, dt);
			heading = z.wanderDir;
			wandering = true;
			natural = true;
		}
	}
	if (natural) {
		naturalMotion(z, heading, speed, chaseWalk, distP, dt);
		heading = z.walkDir ?? heading;
		speed = z.pace ?? speed;
	} else {
		// anything else (a rush, a leap, a wind-up, a kite, a stun) is exact: the next walk starts from it
		if (speed > 0) z.walkDir = heading;
		z.pace = speed;
	}

	// ---- move: intent + knockback + crowd separation, through real collision ------------------
	let mx = math.cos(heading) * speed * dt;
	let my = math.sin(heading) * speed * dt;
	if (speed > 0 && !rushing && (z.orbit ?? 0) <= 0 && distP < T.DIRECT_CHASE) {
		// only the WALK stops at a body it touches (LEG-05), and only in the last metres of a chase, where the
		// crowd round a survivor forms and is on screen. A charge is a battering ram, and a knockback and the
		// separation are pushes, not steps. A queue at a barricade keeps shoving as it always did: that is what
		// tells flank.ts it is a queue, and a zombie peeling off it (`orbit`) has to shoulder its way out
		// (test:ai [4] counts exactly that)
		alongContacts(z, p, idx, r, distP, mx, my);
		mx = stride.x;
		my = stride.y;
	}
	if (z.reactionSpeed > 0 && !rushing) {
		mx += math.cos(z.reactionDir) * z.reactionSpeed * SPEED_SCALE * dt;
		my += math.sin(z.reactionDir) * z.reactionSpeed * SPEED_SCALE * dt;
	}
	mx += sepX[idx] ?? 0;
	my += sepY[idx] ?? 0;
	const res = Phys.moveActor(world, z.x, z.y, r, mx, my);
	let movedX = res.x - z.x;
	let movedY = res.y - z.y;
	z.x = res.x;
	z.y = res.y;

	const hit = res.hit;
	if (hit !== undefined) {
		if (speed > 0 && Phys.isPlayerBuilt(hit) && hit.destructible && (z.stunned <= 0 || rushing)) {
			// par_action collision: hit the construction in the way (only near the player)
			if (distP < T.STRUCT_ATTACK_RANGE) {
				const dmg = rushing ? (z.damageRush ?? z.damage) : z.damage;
				damageStructure(refs, hit, damageCal(dmg));
				// breaking the way in IS progress: it does not count as being stuck in a queue, nor as a place it
				// cannot reach (a suspicious zombie at your barricade keeps at it)
				z.jamT = 0;
				z.gotoT = 0;
				z.stunned = T.STUN_TIME;
				if (rushing) endRush(z);
			}
		} else if (rushing) {
			// obj_zombie4: a rush that meets a wall ends in a crash
			endRush(z);
			z.stunned = math.max(z.stunned, 0.5);
			if (distP < 800) Ctx.fxShake(refs, pi, 4, 0.2);
		}
		if (wandering) z.wanderDir = rnd() * math.pi * 2;
		// a sidestep into a wall turns round instead of grinding along it
		if ((z.strafe ?? 0) > 0) z.strafeSide = -(z.strafeSide ?? 1);
	}

	// ---- the player is a solid body: stop at contact distance, wind up, bite --------------------
	const minD = r + Phys.PLAYER_RADIUS;
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
		const back = Phys.moveActor(world, z.x, z.y, r, nx * (minD - distP), ny * (minD - distP));
		movedX += back.x - z.x;
		movedY += back.y - z.y;
		z.x = back.x;
		z.y = back.y;
		distP = Ctx.actorDist(z.x, z.y, p.x, p.y);
	}
	if (distP <= minD + 3 || ((z.windup ?? 0) > 0 && distP <= minD + T.BITE_KEEP)) {
		contactAttack(refs, z, p, pi, dt);
	} else if (z.windup !== undefined) {
		// the survivor stepped out of the wind-up: the bite whiffs and it has to recover
		cancelWindup(z);
		z.stunned = math.max(z.stunned, T.WHIFF_RECOVER);
	}

	// ---- floor trap: 40%/frame chance of a short stun (frame-rate independent) ------------------
	if (refs.ai.anyTrap && z.stunned <= 0 && findTrap(world, z.x, z.y) !== undefined) {
		if (rnd() < 1 - math.pow(0.6, dt * 30)) z.stunned = T.STUN_TIME / 4;
	}

	faceAndAnimate(z, p, movedX, movedY, dt, distP);
	if (drawn) updateAlpha(refs, z, dt);
	return false;
}

/**
 * Zombie AI + physics for one frame: noise, puddles, blasts, the crowd map, crowd separation and each
 * zombie's senses, memory and behaviour (walker, spitter, exploder, charger, jumper).
 *
 * The chase field is NOT rebuilt here: its owner (the client loop, or server/sim/zombies.ts with the
 * multi-source field of §3.3) refreshes it before calling, and the AI only ever queries it.
 */
export function updateZombies(refs: Ctx.AiRefs, dt: number): void {
	// nobody in the world: nothing to hunt and nobody to see it (an empty server pays nothing)
	if (refs.players.size() === 0) return;
	syncWorld(refs);
	refs.ai.frameNo += 1;
	losBudget = T.LOS_BUDGET;
	shoutsLeft = Alert.ALERT_SHOUTS_PER_TICK;
	const clock = refs.clock;
	// 7:00 — zombies that did not come with a night wave lose the trail (and the memory with it)
	if (clock.morningCount !== refs.ai.seenMorning) {
		refs.ai.seenMorning = clock.morningCount;
		for (const z of refs.zombies) {
			if (!z.wave) {
				Mind.forget(z);
				z.aware = Mind.Aware.Idle;
				z.notice = 0;
			}
		}
	}
	collectLights(refs, dt);
	scanTraps(refs);
	// sight is shortened by the light and the weather and lengthened by the TARGET's own light, and its Stealth
	// skill is its own, so it is computed once per survivor, not once per world (§4.3 does the same per player)
	updateSenses(refs);
	updateNoise(refs, dt);
	updatePuddles(refs, dt);
	updateExplosions(refs, dt);
	updateCrowd(refs);
	computeSeparation(refs);
	const zs = refs.zombies;
	const n = zs.size();
	// Newest first, but starting where the last tick's rays ran out: the tick's budgets (rays, shouts) are spent in
	// this order, and one fixed order served the newest zombies every tick while the oldest waited behind them for
	// a ray they never got, keeping a stale "in view" (the review of 66f6373). Uncontended, it is newest first.
	const from = refs.ai.scanFrom >= 0 && refs.ai.scanFrom < n ? refs.ai.scanFrom : n - 1;
	let cut = -1;
	for (let i = 0; i < n; i++) goneAt[i] = false;
	for (let k = 0; k < n; k++) {
		const i = (from - k + n) % n;
		if (cut < 0 && losBudget <= 0) cut = i;
		goneAt[i] = updateOne(refs, zs[i], i, dt);
	}
	refs.ai.scanFrom = cut;
	// the dead leave after the pass, so every index above stayed the one the separation was computed for
	for (let i = n - 1; i >= 0; i--) {
		if (!goneAt[i]) continue;
		const z = zs[i];
		// everything removed HERE died (the population recycles the living ones, and says so itself)
		if (refs.onZombieGone !== undefined) refs.onZombieGone(z, true);
		zs.remove(i);
	}
}

/**
 * A zombie that spawns already on the trail (obj_zombie's 10% "random detect") arrives SUSPICIOUS of where the
 * survivor was when it spawned: it walks there and searches, and only a sighting turns it into a chase. It never
 * homes on the live position it could not know.
 */
export function seedHunt(z: ZombieState, x: number, y: number): void {
	Mind.report(z, x, y);
	z.aware = Mind.Aware.Suspicious;
}
