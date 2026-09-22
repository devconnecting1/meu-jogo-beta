import { DESIGN } from "shared/engine/constants";
import { chance, choose, rndInt } from "shared/engine/rng";
import { randomRingPoint, spawnGroundItem, WorldData } from "shared/game/world";
import { circleBlocked } from "shared/game/physics";
import { createBoss, createZombie, ZombieState, ZombieType } from "shared/game/entities";
import { BUILDING_SPAWNS, getDayPopulation } from "shared/data/spawns";
import { GameRefs, nearestPlayer } from "./types";

/*
 * Population: ambient walkers, specials, night waves, ground items and the bosses. Zombies and items live around the
 * survivors — they are only recycled when they are far from ALL of them (docs/MULTIPLAYER.md §3.5 adds the S(k)
 * cluster scaling in F2; with a single survivor this is the game as it was).
 */

const SPECIAL_TYPES: Array<number> = [2, 3, 4, 5];
/** free radius required around a spawn point (original: 40×40 box free of solids) */
const SPAWN_CLEARANCE = 24;
/** ambient walkers added per spawn tick (the original filled the whole quota in one alarm) */
const AMBIENT_BATCH = 3;

function ringOpen(
	world: WorldData,
	cx: number,
	cy: number,
	minR: number,
	maxR: number,
): { x: number; y: number } | undefined {
	for (let i = 0; i < 12; i++) {
		const p = randomRingPoint(cx, cy, minR, maxR);
		if (p.x < 0 || p.y < 0 || p.x > world.width || p.y > world.height) continue;
		if (circleBlocked(world, p.x, p.y, SPAWN_CLEARANCE) === undefined) {
			return p;
		}
	}
	return undefined;
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

	private spawnZombie(refs: GameRefs, zType: ZombieType, wave: boolean): boolean {
		// F0: the ring of the local survivor (F2: round-robin over the cluster's survivors, §3.5)
		const p = refs.player;
		const pos = ringOpen(refs.world, p.x, p.y, DESIGN.ZOMBIE_SPAWN_MIN, DESIGN.ZOMBIE_SPAWN_MAX);
		if (pos === undefined) return false;
		const z = createZombie(zType, pos.x, pos.y, refs.daynight.day, wave);
		if (wave) z.detect = true;
		refs.zombies.push(z);
		return true;
	}

	private spawnAmbient(refs: GameRefs): void {
		const pop = getDayPopulation(refs.daynight.day);
		let walkers = countWalkers(refs.zombies);
		for (let i = 0; i < AMBIENT_BATCH && walkers < pop.ambient; i++) {
			if (!this.spawnZombie(refs, 1, false)) break;
			walkers++;
		}
	}

	private spawnAmbientSpecial(refs: GameRefs): void {
		const pop = getDayPopulation(refs.daynight.day);
		const specials = countSpecials(refs.zombies);
		if (specials >= pop.ambientSpecial || specials >= DESIGN.ZOMBIE_SPECIAL_NUMBER_MAX) return;
		this.spawnZombie(refs, pickSpecialType(refs.zombies), false);
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
		const pos = ringOpen(refs.world, p.x, p.y, DESIGN.ITEM_SPAWN_MIN, DESIGN.ITEM_SPAWN_MAX);
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
				const pos = ringOpen(refs.world, p.x, p.y, DESIGN.ZOMBIE_SPAWN_MIN, DESIGN.ZOMBIE_SPAWN_MAX);
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
		this.ambientTimer += dt;
		if (this.ambientTimer >= DESIGN.ZOMBIE_SPAWN_TIME) {
			this.ambientTimer = 0;
			this.spawnAmbient(refs);
		}
		this.specialTimer += dt;
		if (this.specialTimer >= DESIGN.ZOMBIE_SPAWN_TIME) {
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
		if (this.waveTimer >= DESIGN.ZOMBIE_WAVE_SPAWN_TIME) {
			this.waveTimer = 0;
			this.spawnWave(refs);
		}
		this.specialWaveTimer += dt;
		if (this.specialWaveTimer >= DESIGN.ZOMBIE_WAVE_SPAWN_TIME) {
			this.specialWaveTimer = 0;
			this.spawnSpecialWave(refs);
		}
		this.cleanup(refs);
		this.spawnBoss(refs);
	}
}
