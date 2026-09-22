import { DESIGN } from "shared/engine/constants";
import { chance, choose, rndInt } from "shared/engine/rng";
import { randomRingPoint, spawnGroundItem, WorldData } from "shared/game/world";
import { circleBlocked } from "shared/game/physics";
import { createBoss, createZombie, ZombieState, ZombieType } from "shared/game/entities";
import { BUILDING_SPAWNS, getDayPopulation } from "shared/data/spawns";
import { DIRECTOR_NEAR, PaceDirector } from "shared/sim/ai/director";
import { GameRefs, nearestPlayer } from "./types";
import { seedHunt, takeKills } from "./zombieAI";

/*
 * Population: ambient walkers, specials, night waves, ground items and the bosses. Zombies and items live around the
 * survivors — they are only recycled when they are far from ALL of them (docs/MULTIPLAYER.md §3.5 adds the S(k)
 * cluster scaling in F2; with a single survivor this is the game as it was).
 *
 * On top of the original's day table (sys_spawn_time_light: a fixed quota per day and nothing else) sits the pacing
 * director (shared/sim/ai/director.ts). It only scales the AMBIENT quota and the spawn intervals inside its own
 * limits; the 19h/22h/1h wave queues are the original's, untouched — a relief paces a wave, it never shortens it.
 * MP-09 is enforced here and only here: 150 zombies alive at most, and nothing ever appears within 720 u of any
 * survivor.
 */

const SPECIAL_TYPES: Array<number> = [2, 3, 4, 5];
/** free radius required around a spawn point (original: 40×40 box free of solids) */
const SPAWN_CLEARANCE = 24;
/** ambient walkers added per spawn tick (the original filled the whole quota in one alarm) */
const AMBIENT_BATCH = 3;
/** MP-09: nothing spawns within this of ANY survivor, and never more than this many alive */
const MP09_SAFE_RADIUS = 720;
const MP09_ZOMBIE_CAP = 150;
/** the director is sampled at 4 Hz: counting the horde around the survivors every frame is pointless */
const DIRECTOR_TICK = 0.25;
/** however hot the director runs, the ambient quota never drops under this (the town is never empty) */
const AMBIENT_FLOOR = 3;

/**
 * A point on the spawn ring of `cx, cy` that is free of solids and — MP-09 — at least MP09_SAFE_RADIUS from
 * EVERY survivor, not just the one the ring is drawn around.
 */
function ringOpen(
	refs: GameRefs,
	cx: number,
	cy: number,
	minR: number,
	maxR: number,
	safe = false,
): { x: number; y: number } | undefined {
	const world: WorldData = refs.world;
	for (let i = 0; i < 12; i++) {
		const p = randomRingPoint(cx, cy, minR, maxR);
		if (p.x < 0 || p.y < 0 || p.x > world.width || p.y > world.height) continue;
		if (circleBlocked(world, p.x, p.y, SPAWN_CLEARANCE) !== undefined) continue;
		if (safe && !farFromEveryone(refs, p.x, p.y)) continue;
		return p;
	}
	return undefined;
}

/** MP-09: no zombie ever appears in anyone's face */
function farFromEveryone(refs: GameRefs, x: number, y: number): boolean {
	for (const p of refs.players) {
		if (p.dead) continue;
		const dx = p.x - x;
		const dy = p.y - y;
		if (dx * dx + dy * dy < MP09_SAFE_RADIUS * MP09_SAFE_RADIUS) return false;
	}
	return true;
}

function countWalkers(zombies: Array<ZombieState>): number {
	let n = 0;
	for (const z of zombies) {
		if (!z.special) n++;
	}
	return n;
}

function countSpecials(zombies: Array<ZombieState>): number {
	let n = 0;
	for (const z of zombies) {
		if (z.special) n++;
	}
	return n;
}

/** original Alarm 2: while there are fewer than 4 specials, prefer a type that is not on the map */
function pickSpecialType(zombies: Array<ZombieState>): ZombieType {
	let specialCount = 0;
	const present: Array<number> = [];
	for (const z of zombies) {
		if (z.special) {
			specialCount++;
			present.push(z.type);
		}
	}
	if (specialCount < DESIGN.ZOMBIE_SPECIAL_NUMBER_MAX) {
		const missing: Array<number> = [];
		for (const t of SPECIAL_TYPES) {
			if (!present.includes(t)) missing.push(t);
		}
		if (missing.size() > 0) {
			return choose(missing) as ZombieType;
		}
	}
	return choose(SPECIAL_TYPES) as ZombieType;
}

function rollGroundLoot(): { kind: number; index: number; count: number } {
	const lootTable = BUILDING_SPAWNS[0];
	const e = choose(lootTable);
	if (e.max < 1) {
		if (chance(e.max * 100)) {
			return { kind: e.kind, index: e.index, count: 1 };
		}
		return { kind: 4, index: 23, count: rndInt(1, 3) };
	}
	return { kind: e.kind, index: e.index, count: rndInt(e.min, e.max) };
}

/**
 * Zombie population (sys_spawn_time_light). Walkers and specials are separate channels like the
 * original: ambient walkers fill up to the day's quota, wave walkers stream in from the night
 * queues up to ZOMBIE_NUMBER_MAX walkers; specials have their own ambient quota and wave queues
 * and never exceed ZOMBIE_SPECIAL_NUMBER_MAX (4) at once.
 */
export class Spawner {
	private ambientTimer = 0;
	private specialTimer = 0;
	private itemTimer = 0;
	private waveTimer = 0;
	private specialWaveTimer = 0;
	/** peak → relief → build: scales the ambient quota and the spawn intervals, never the wave queues */
	readonly director = new PaceDirector();
	private directorTimer = 0;
	private lastHp = -1;

	private spawnZombie(refs: GameRefs, zType: ZombieType, wave: boolean): boolean {
		// MP-09: hard ceiling on what one server simulates
		if (refs.zombies.size() >= MP09_ZOMBIE_CAP) return false;
		// F0: the ring of the local survivor (F2: round-robin over the cluster's survivors, §3.5)
		const p = refs.player;
		const pos = ringOpen(refs, p.x, p.y, DESIGN.ZOMBIE_SPAWN_MIN, DESIGN.ZOMBIE_SPAWN_MAX, true);
		if (pos === undefined) return false;
		const z = createZombie(zType, pos.x, pos.y, refs.daynight.day, wave);
		if (wave) {
			// a wave zombie is the original's tide: it comes and it does not stop coming
			z.detect = true;
		} else if (z.detect) {
			// obj_zombie's 10% that spawn already hunting: they arrive knowing where the survivor WAS,
			// so they can lose the trail like anything else instead of homing for ever
			seedHunt(z, p.x, p.y);
		}
		refs.zombies.push(z);
		return true;
	}

	/** the day's ambient quota after the director's adjustment (MP-09's ceiling still wins) */
	private ambientQuota(base: number): number {
		if (base <= 0) return 0;
		const scaled = math.floor(base * this.director.ambientScale + 0.5);
		return math.clamp(scaled, math.min(AMBIENT_FLOOR, base), MP09_ZOMBIE_CAP);
	}

	private spawnAmbient(refs: GameRefs): void {
		const pop = getDayPopulation(refs.daynight.day);
		const quota = this.ambientQuota(pop.ambient);
		let walkers = countWalkers(refs.zombies);
		for (let i = 0; i < AMBIENT_BATCH && walkers < quota; i++) {
			if (!this.spawnZombie(refs, 1, false)) break;
			walkers++;
		}
	}

	private spawnAmbientSpecial(refs: GameRefs): void {
		const pop = getDayPopulation(refs.daynight.day);
		const quota = this.ambientQuota(pop.ambientSpecial);
		const specials = countSpecials(refs.zombies);
		if (specials >= quota || specials >= DESIGN.ZOMBIE_SPECIAL_NUMBER_MAX) return;
		this.spawnZombie(refs, pickSpecialType(refs.zombies), false);
	}

	/**
	 * Feed the director: hp the survivors lost, zombies killed, how many are on top of them and how hurt
	 * they are. Sampled at DIRECTOR_TICK so counting the horde costs nothing per frame.
	 */
	private updateDirector(refs: GameRefs, dt: number): void {
		this.directorTimer += dt;
		if (this.directorTimer < DIRECTOR_TICK) return;
		const step = this.directorTimer;
		this.directorTimer = 0;
		let hp = 0;
		let hpMax = 0;
		let alive = 0;
		for (const p of refs.players) {
			if (p.dead) continue;
			alive++;
			hp += math.max(0, p.hp);
			hpMax += p.hpMax;
		}
		if (this.lastHp < 0) this.lastHp = hp;
		// only losses count: healing and respawning are not the survivors having a bad time
		const damage = math.max(0, this.lastHp - hp);
		this.lastHp = hp;
		let near = 0;
		for (const z of refs.zombies) {
			if (z.hp <= 0) continue;
			const p = nearestPlayer(refs, z.x, z.y);
			const dx = p.x - z.x;
			const dy = p.y - z.y;
			if (dx * dx + dy * dy < DIRECTOR_NEAR * DIRECTOR_NEAR) near++;
		}
		this.director.update(
			{ damage, kills: takeKills(), near, health: alive > 0 && hpMax > 0 ? hp / hpMax : 1 },
			step,
		);
	}

	/** index of the first active wave (0..2) whose queue still has entries, or -1 */
	private activeWave(refs: GameRefs, queues: Array<number>): number {
		const dn = refs.daynight;
		if (dn.wave1Active && queues[0] > 0) return 0;
		if (dn.wave2Active && queues[1] > 0) return 1;
		if (dn.wave3Active && queues[2] > 0) return 2;
		return -1;
	}

	private spawnWave(refs: GameRefs): void {
		const dn = refs.daynight;
		if (countWalkers(refs.zombies) >= DESIGN.ZOMBIE_NUMBER_MAX) return;
		const i = this.activeWave(refs, dn.waveQueues);
		if (i < 0) return;
		if (this.spawnZombie(refs, 1, true)) {
			dn.waveQueues[i] = dn.waveQueues[i] - 1;
		}
	}

	private spawnSpecialWave(refs: GameRefs): void {
		const dn = refs.daynight;
		if (countSpecials(refs.zombies) >= DESIGN.ZOMBIE_SPECIAL_NUMBER_MAX) return;
		const i = this.activeWave(refs, dn.specialWaveQueues);
		if (i < 0) return;
		if (this.spawnZombie(refs, choose(SPECIAL_TYPES) as ZombieType, true)) {
			dn.specialWaveQueues[i] = dn.specialWaveQueues[i] - 1;
		}
	}

	private spawnGroundItem(refs: GameRefs): void {
		const p = refs.player;
		const pos = ringOpen(refs, p.x, p.y, DESIGN.ITEM_SPAWN_MIN, DESIGN.ITEM_SPAWN_MAX);
		if (pos === undefined) return;
		const loot = rollGroundLoot();
		spawnGroundItem(refs.world, loot.kind, loot.index, loot.count, pos.x, pos.y);
	}

	/** inside the spawn square of at least one survivor */
	private nearAnyPlayer(refs: GameRefs, x: number, y: number, range: number): boolean {
		for (const p of refs.players) {
			if (math.abs(x - p.x) <= range && math.abs(y - p.y) <= range) return true;
		}
		return false;
	}

	/**
	 * Zombies that fell out of the spawn square: plain walkers vanish; wave walkers and specials are
	 * moved back onto the spawn ring (original deactive/respawn), so a night wave or a rare special
	 * is not lost just because the player ran.
	 */
	private cleanup(refs: GameRefs): void {
		for (let i = refs.zombies.size() - 1; i >= 0; i--) {
			const z = refs.zombies[i];
			if (this.nearAnyPlayer(refs, z.x, z.y, DESIGN.ZOMBIE_SPAWN_MAX)) continue;
			if (z.hp <= 0) continue; // a lit exploder finishes its fuse
			if (z.wave || z.special) {
				// wave walkers and specials are not lost: back onto the ring of the nearest survivor
				const p = nearestPlayer(refs, z.x, z.y);
				const pos = ringOpen(refs, p.x, p.y, DESIGN.ZOMBIE_SPAWN_MIN, DESIGN.ZOMBIE_SPAWN_MAX, true);
				if (pos !== undefined) {
					z.x = pos.x;
					z.y = pos.y;
					z.spawnX = pos.x;
					z.spawnY = pos.y;
					z.jumping = false;
					z.jumpHeight = 0;
					z.rush = false;
					z.reactionSpeed = 0;
					z.stunned = 0;
				} else {
					refs.zombies.remove(i);
				}
			} else {
				refs.zombies.remove(i);
			}
		}
		for (let i = refs.world.items.size() - 1; i >= 0; i--) {
			const it = refs.world.items[i];
			if (!this.nearAnyPlayer(refs, it.x, it.y, DESIGN.ITEM_SPAWN_MAX)) {
				refs.world.items.remove(i);
			}
		}
	}

	private spawnBoss(refs: GameRefs): void {
		if (refs.bosses.size() > 0) return;
		const day = refs.daynight.day;
		for (const anchor of refs.world.bossAnchors) {
			if (day < anchor.nextDay) continue;
			// any survivor coming close to the anchor wakes it up
			let near = false;
			for (const p of refs.players) {
				const dx = anchor.x - p.x;
				const dy = anchor.y - p.y;
				if (math.sqrt(dx * dx + dy * dy) < DESIGN.BOSS_LENGTH) {
					near = true;
					break;
				}
			}
			if (!near) continue;
			refs.bosses.push(createBoss(anchor.type, anchor.x, anchor.y));
			anchor.nextDay = day + DESIGN.BOSS_RESPAWN_DAY;
			break;
		}
	}

	update(refs: GameRefs, dt: number): void {
		this.updateDirector(refs, dt);
		// the director stretches the intervals instead of touching the queues: a relief makes the town
		// fill up slowly, a build-up makes it fill up faster, and the night still delivers every zombie
		const ambientEvery = DESIGN.ZOMBIE_SPAWN_TIME / this.director.ambientScale;
		const waveEvery = DESIGN.ZOMBIE_WAVE_SPAWN_TIME / this.director.waveScale;
		this.ambientTimer += dt;
		if (this.ambientTimer >= ambientEvery) {
			this.ambientTimer = 0;
			this.spawnAmbient(refs);
		}
		this.specialTimer += dt;
		if (this.specialTimer >= ambientEvery) {
			this.specialTimer = 0;
			this.spawnAmbientSpecial(refs);
		}
		this.itemTimer += dt;
		if (this.itemTimer >= 1) {
			this.itemTimer = 0;
			if (refs.world.items.size() < DESIGN.ITEM_NUMBER) {
				this.spawnGroundItem(refs);
			}
		}
		this.waveTimer += dt;
		if (this.waveTimer >= waveEvery) {
			this.waveTimer = 0;
			this.spawnWave(refs);
		}
		this.specialWaveTimer += dt;
		if (this.specialWaveTimer >= waveEvery) {
			this.specialWaveTimer = 0;
			this.spawnSpecialWave(refs);
		}
		this.cleanup(refs);
		this.spawnBoss(refs);
	}
}
