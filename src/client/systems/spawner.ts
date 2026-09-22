import { DESIGN } from "shared/engine/constants";
import { chance, choose, rndInt } from "shared/engine/rng";
import { randomRingPoint, rectHitsSolid, spawnGroundItem, WorldData } from "shared/game/world";
import { createBoss, createZombie, ZombieState, ZombieType } from "shared/game/entities";
import { BUILDING_SPAWNS, getDayPopulation } from "shared/data/spawns";
import { GameRefs } from "./types";

const SPECIAL_TYPES: Array<number> = [2, 3, 4, 5];

function ringOpen(
	world: WorldData,
	cx: number,
	cy: number,
	minR: number,
	maxR: number,
): { x: number; y: number } | undefined {
	for (let i = 0; i < 8; i++) {
		const p = randomRingPoint(cx, cy, minR, maxR);
		if (!rectHitsSolid(world, p.x, p.y, 40, 40)) {
			return p;
		}
	}
	return undefined;
}

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

function countAmbientSpecials(zombies: Array<ZombieState>): number {
	let n = 0;
	for (const z of zombies) {
		if (z.special && !z.wave) n++;
	}
	return n;
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

export class Spawner {
	private ambientTimer = 0;
	private itemTimer = 0;
	private waveTimer = 0;

	private spawnAmbient(refs: GameRefs): void {
		const p = refs.player;
		const pos = ringOpen(refs.world, p.x, p.y, DESIGN.ZOMBIE_SPAWN_MIN, DESIGN.ZOMBIE_SPAWN_MAX);
		if (pos === undefined) return;
		const pop = getDayPopulation(refs.daynight.day);
		let zType: ZombieType = 1;
		const ambientSpecials = countAmbientSpecials(refs.zombies);
		if (ambientSpecials < pop.ambientSpecial) {
			zType = pickSpecialType(refs.zombies);
		}
		refs.zombies.push(createZombie(zType, pos.x, pos.y, refs.daynight.day, false));
	}

	private spawnWave(refs: GameRefs): void {
		const dn = refs.daynight;
		const p = refs.player;
		const active: Array<number> = [];
		if (dn.wave1Active) active.push(0);
		if (dn.wave2Active) active.push(1);
		if (dn.wave3Active) active.push(2);
		if (active.size() === 0) return;
		let waveIndex = -1;
		for (const i of active) {
			if (dn.waveQueues[i] > 0 || dn.specialWaveQueues[i] > 0) {
				waveIndex = i;
				break;
			}
		}
		if (waveIndex < 0) return;
		if (refs.zombies.size() >= DESIGN.ZOMBIE_NUMBER_MAX) return;
		const pos = ringOpen(refs.world, p.x, p.y, DESIGN.ZOMBIE_SPAWN_MIN, DESIGN.ZOMBIE_SPAWN_MAX);
		if (pos === undefined) return;
		let zType: ZombieType = 1;
		if (dn.specialWaveQueues[waveIndex] > 0) {
			dn.specialWaveQueues[waveIndex] = dn.specialWaveQueues[waveIndex] - 1;
			zType = choose(SPECIAL_TYPES) as ZombieType;
		} else {
			dn.waveQueues[waveIndex] = dn.waveQueues[waveIndex] - 1;
		}
		refs.zombies.push(createZombie(zType, pos.x, pos.y, dn.day, true));
	}

	private spawnGroundItem(refs: GameRefs): void {
		const p = refs.player;
		const pos = ringOpen(refs.world, p.x, p.y, DESIGN.ITEM_SPAWN_MIN, DESIGN.ITEM_SPAWN_MAX);
		if (pos === undefined) return;
		const loot = rollGroundLoot();
		spawnGroundItem(refs.world, loot.kind, loot.index, loot.count, pos.x, pos.y);
	}

	private cleanup(refs: GameRefs): void {
		const p = refs.player;
		const dn = refs.daynight;
		for (let i = refs.zombies.size() - 1; i >= 0; i--) {
			const z = refs.zombies[i];
			const dx = math.abs(z.x - p.x);
			const dy = math.abs(z.y - p.y);
			if (dx <= DESIGN.ZOMBIE_SPAWN_MAX && dy <= DESIGN.ZOMBIE_SPAWN_MAX) continue;
			if (z.wave) {
				let target = -1;
				if (dn.wave3Active) target = 2;
				else if (dn.wave2Active) target = 1;
				else if (dn.wave1Active) target = 0;
				if (target >= 0) dn.waveQueues[target] = dn.waveQueues[target] + 1;
				refs.zombies.remove(i);
			} else if (z.special) {
				const pos = ringOpen(refs.world, p.x, p.y, DESIGN.ZOMBIE_SPAWN_MIN, DESIGN.ZOMBIE_SPAWN_MAX);
				if (pos !== undefined) {
					z.x = pos.x;
					z.y = pos.y;
					z.spawnX = pos.x;
					z.spawnY = pos.y;
				} else {
					refs.zombies.remove(i);
				}
			} else {
				refs.zombies.remove(i);
			}
		}
		for (let i = refs.world.items.size() - 1; i >= 0; i--) {
			const it = refs.world.items[i];
			if (math.abs(it.x - p.x) > DESIGN.ITEM_SPAWN_MAX || math.abs(it.y - p.y) > DESIGN.ITEM_SPAWN_MAX) {
				refs.world.items.remove(i);
			}
		}
	}

	private spawnBoss(refs: GameRefs): void {
		if (refs.bosses.size() > 0) return;
		const p = refs.player;
		const day = refs.daynight.day;
		for (const anchor of refs.world.bossAnchors) {
			if (day < anchor.nextDay) continue;
			const dx = anchor.x - p.x;
			const dy = anchor.y - p.y;
			if (math.sqrt(dx * dx + dy * dy) >= 900) continue;
			refs.bosses.push(createBoss(anchor.type, anchor.x, anchor.y));
			anchor.nextDay = day + DESIGN.BOSS_RESPAWN_DAY;
			break;
		}
	}

	update(refs: GameRefs, dt: number): void {
		this.ambientTimer += dt;
		if (this.ambientTimer >= DESIGN.ZOMBIE_SPAWN_TIME) {
			this.ambientTimer = 0;
			if (refs.zombies.size() < refs.daynight.ambientTarget) {
				this.spawnAmbient(refs);
			}
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
		this.cleanup(refs);
		this.spawnBoss(refs);
	}
}
