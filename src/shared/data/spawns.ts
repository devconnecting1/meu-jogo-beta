import type { ItemKind } from "./kinds";

export interface SpawnEntry {
	building: number;
	kind: ItemKind;
	index: number;
	min: number;
	max: number;
}

/** one line of a map item's table (tree, car, bin) */
export interface MapLootEntry {
	kind: ItemKind;
	index: number;
	/** < 1: the probability of getting exactly one. Otherwise the quantity. */
	amount: number;
}

/**
 * What hitting or searching a tree, a car or a bin can give: ONE table, read by the client's MP_PHASE 2 path
 * (client/systems/interaction.ts) and by the server's (server/sim/items.ts) through shared/sim/loot.ts.
 *
 * Until 2026-09-23 each side had its own copy and they had drifted (QA L1): the client's was the original's, the
 * server's had been rewritten (a blueprint from a tree, a Steel bar and gold out of a car, although Steel is only
 * ever smelted), so moving the map items to the server at F3 would have silently changed what the town gives.
 * These are the original's (obj_tree1, obj_car, obj_trash), which make sense as they are: a tree gives wood and
 * the odd fruit, a wreck gives scrap to smelt and a few parts, a bin gives scraps of everything.
 */
export const MAP_ITEM_LOOT: { tree: Array<MapLootEntry>; car: Array<MapLootEntry>; trash: Array<MapLootEntry> } = {
	tree: [
		{ kind: 4, index: 23, amount: 2 },
		{ kind: 3, index: 17, amount: 0.1 },
		{ kind: 3, index: 18, amount: 0.1 },
	],
	car: [
		{ kind: 4, index: 25, amount: 1 },
		{ kind: 4, index: 30, amount: 0.1 },
		{ kind: 4, index: 36, amount: 0.05 },
	],
	trash: [
		{ kind: 4, index: 23, amount: 1 },
		{ kind: 4, index: 24, amount: 1 },
		{ kind: 4, index: 25, amount: 0.1 },
		{ kind: 4, index: 29, amount: 0.1 },
		{ kind: 4, index: 30, amount: 0.1 },
	],
};

/**
 * What each boss leaves besides its six rolls of the general table: its trophy, as in the original
 * (obj_boss_rewards). The centipede the Flamethrower, the rafflesia a Robot suit, the giant the Plastic armor, the
 * hedgehog three voltage circuits and three radioactive materials. Without this the Flamethrower and the Plastic
 * armor had no source at all -- no loot table, no recipe, no pack (QA row audit, 2026-09-23) -- and the item a boss
 * dropped was the same handful of scrap a walker drops. By boss type (1..4, shared/game/entities.ts createBoss).
 */
export const BOSS_TROPHIES: Record<number, Array<{ kind: ItemKind; index: number; count: number }>> = {
	1: [{ kind: 1, index: 25, count: 1 }],
	2: [{ kind: 2, index: 14, count: 1 }],
	3: [{ kind: 2, index: 5, count: 1 }],
	4: [
		{ kind: 4, index: 36, count: 3 },
		{ kind: 4, index: 43, count: 3 },
	],
};

export interface DayPopulation {
	ambient: number;
	ambientSpecial: number;
	wave1: number;
	wave2: number;
	wave3: number;
	specialWave1: number;
	specialWave2: number;
	specialWave3: number;
}

export const DAY_POPULATION: Array<DayPopulation> = [
	{ ambient: 5, ambientSpecial: 0, wave1: 3, wave2: 3, wave3: 6, specialWave1: 0, specialWave2: 0, specialWave3: 0 },
	{ ambient: 8, ambientSpecial: 0, wave1: 5, wave2: 5, wave3: 10, specialWave1: 0, specialWave2: 0, specialWave3: 0 },
	{
		ambient: 10,
		ambientSpecial: 2,
		wave1: 12,
		wave2: 12,
		wave3: 20,
		specialWave1: 2,
		specialWave2: 2,
		specialWave3: 2,
	},
	{
		ambient: 12,
		ambientSpecial: 2,
		wave1: 20,
		wave2: 20,
		wave3: 40,
		specialWave1: 3,
		specialWave2: 3,
		specialWave3: 3,
	},
	{
		ambient: 14,
		ambientSpecial: 3,
		wave1: 30,
		wave2: 30,
		wave3: 50,
		specialWave1: 4,
		specialWave2: 4,
		specialWave3: 4,
	},
];

export function difficultyForDay(day: number): number {
	return math.min(2, math.floor(day / 15));
}

export function getDayPopulation(day: number): DayPopulation {
	if (day < 2) {
		return DAY_POPULATION[0];
	}
	if (day < 4) {
		return DAY_POPULATION[1];
	}
	if (day < 10) {
		return DAY_POPULATION[2];
	}
	if (day < 20) {
		return DAY_POPULATION[3];
	}
	return DAY_POPULATION[4];
}

export const BUILDING_SPAWNS: Array<Array<SpawnEntry>> = [
	[
		{ building: 0, kind: 4, index: 23, min: 2, max: 5 },
		{ building: 0, kind: 4, index: 24, min: 1, max: 3 },
		{ building: 0, kind: 4, index: 25, min: 2, max: 5 },
		{ building: 0, kind: 4, index: 29, min: 0.4, max: 0.4 },
		{ building: 0, kind: 4, index: 30, min: 1, max: 2 },
		{ building: 0, kind: 4, index: 31, min: 0.3, max: 0.3 },
		{ building: 0, kind: 4, index: 44, min: 5, max: 10 },
		{ building: 0, kind: 4, index: 45, min: 5, max: 10 },
		{ building: 0, kind: 4, index: 46, min: 15, max: 25 },
		{ building: 0, kind: 4, index: 47, min: 1, max: 2 },
		{ building: 0, kind: 4, index: 48, min: 7, max: 12 },
		{ building: 0, kind: 4, index: 38, min: 0.1, max: 0.1 },
		{ building: 0, kind: 4, index: 34, min: 0.5, max: 0.5 },
		{ building: 0, kind: 4, index: 37, min: 0.15, max: 0.15 },
		{ building: 0, kind: 4, index: 27, min: 0.1, max: 0.1 },
		{ building: 0, kind: 4, index: 33, min: 0.3, max: 0.3 },
		{ building: 0, kind: 3, index: 17, min: 0.25, max: 0.25 },
		{ building: 0, kind: 3, index: 18, min: 0.25, max: 0.25 },
	],
	[
		{ building: 1, kind: 4, index: 23, min: 2, max: 3 },
		{ building: 1, kind: 4, index: 24, min: 2, max: 3 },
		{ building: 1, kind: 4, index: 25, min: 1, max: 2 },
		{ building: 1, kind: 4, index: 27, min: 0.1, max: 0.1 },
		{ building: 1, kind: 4, index: 29, min: 1, max: 1 },
		{ building: 1, kind: 4, index: 31, min: 0.2, max: 0.2 },
		{ building: 1, kind: 4, index: 32, min: 0.4, max: 0.4 },
		{ building: 1, kind: 4, index: 34, min: 1, max: 1 },
		{ building: 1, kind: 4, index: 41, min: 1, max: 1 },
		{ building: 1, kind: 4, index: 48, min: 10, max: 15 },
		{ building: 1, kind: 3, index: 0, min: 1, max: 1 },
		{ building: 1, kind: 3, index: 4, min: 1, max: 1 },
		{ building: 1, kind: 3, index: 9, min: 1, max: 1 },
	],
	[
		{ building: 2, kind: 4, index: 25, min: 2, max: 3 },
		{ building: 2, kind: 4, index: 27, min: 0.1, max: 0.1 },
		{ building: 2, kind: 4, index: 29, min: 1, max: 1 },
		{ building: 2, kind: 4, index: 31, min: 0.2, max: 0.2 },
		{ building: 2, kind: 4, index: 32, min: 0.4, max: 0.4 },
		{ building: 2, kind: 4, index: 34, min: 1, max: 1 },
		{ building: 2, kind: 4, index: 41, min: 1, max: 1 },
		{ building: 2, kind: 4, index: 48, min: 10, max: 15 },
		{ building: 2, kind: 4, index: 30, min: 1, max: 3 },
		{ building: 2, kind: 4, index: 35, min: 0.2, max: 0.2 },
		{ building: 2, kind: 4, index: 36, min: 0.1, max: 0.1 },
		{ building: 2, kind: 4, index: 38, min: 0.1, max: 0.1 },
		{ building: 2, kind: 4, index: 41, min: 1, max: 2 },
		{ building: 2, kind: 4, index: 48, min: 10, max: 15 },
		{ building: 2, kind: 4, index: 42, min: 0.5, max: 0.5 },
		{ building: 2, kind: 4, index: 43, min: 0.5, max: 0.5 },
	],
	[
		{ building: 3, kind: 4, index: 23, min: 2, max: 3 },
		{ building: 3, kind: 4, index: 24, min: 2, max: 3 },
		{ building: 3, kind: 4, index: 25, min: 1, max: 2 },
		{ building: 3, kind: 4, index: 27, min: 0.1, max: 0.1 },
		{ building: 3, kind: 4, index: 29, min: 2, max: 5 },
		{ building: 3, kind: 4, index: 31, min: 0.5, max: 0.5 },
		{ building: 3, kind: 4, index: 32, min: 0.5, max: 0.5 },
		{ building: 3, kind: 4, index: 34, min: 1, max: 1 },
		{ building: 3, kind: 4, index: 41, min: 1, max: 1 },
		{ building: 3, kind: 4, index: 48, min: 1, max: 5 },
		{ building: 3, kind: 3, index: 12, min: 1, max: 1 },
		{ building: 3, kind: 3, index: 4, min: 1, max: 2 },
		{ building: 3, kind: 3, index: 9, min: 1, max: 2 },
	],
	[
		{ building: 4, kind: 4, index: 34, min: 2, max: 3 },
		{ building: 4, kind: 3, index: 5, min: 0.1, max: 0.1 },
		{ building: 4, kind: 3, index: 6, min: 0.2, max: 0.2 },
		{ building: 4, kind: 3, index: 7, min: 0.2, max: 0.2 },
		{ building: 4, kind: 3, index: 8, min: 0.2, max: 0.2 },
		{ building: 4, kind: 3, index: 12, min: 0.5, max: 0.5 },
	],
	[
		{ building: 5, kind: 4, index: 32, min: 1, max: 1 },
		{ building: 5, kind: 4, index: 38, min: 0.1, max: 0.1 },
		{ building: 5, kind: 3, index: 0, min: 1, max: 1 },
		{ building: 5, kind: 3, index: 2, min: 1, max: 1 },
		{ building: 5, kind: 3, index: 4, min: 1, max: 1 },
		{ building: 5, kind: 3, index: 9, min: 1, max: 1 },
		{ building: 5, kind: 3, index: 10, min: 1, max: 1 },
		{ building: 5, kind: 3, index: 13, min: 1, max: 1 },
		{ building: 5, kind: 3, index: 15, min: 1, max: 1 },
		{ building: 5, kind: 3, index: 17, min: 1, max: 1 },
		{ building: 5, kind: 3, index: 18, min: 1, max: 1 },
		{ building: 5, kind: 4, index: 48, min: 20, max: 30 },
		// not in the original DB: the gas station's garage gives scrap to smelt (steel is otherwise slow to get)
		{ building: 5, kind: 4, index: 25, min: 2, max: 4 },
		{ building: 5, kind: 4, index: 30, min: 0.3, max: 0.3 },
	],
	[
		{ building: 6, kind: 3, index: 5, min: 0.1, max: 0.1 },
		{ building: 6, kind: 3, index: 6, min: 0.1, max: 0.1 },
		{ building: 6, kind: 3, index: 7, min: 0.1, max: 0.1 },
		{ building: 6, kind: 3, index: 8, min: 0.1, max: 0.1 },
		{ building: 6, kind: 3, index: 12, min: 0.5, max: 0.5 },
		{ building: 6, kind: 4, index: 34, min: 1, max: 2 },
		{ building: 6, kind: 4, index: 41, min: 1, max: 1 },
	],
	[
		{ building: 7, kind: 4, index: 32, min: 1, max: 1 },
		{ building: 7, kind: 4, index: 38, min: 0.1, max: 0.1 },
		{ building: 7, kind: 3, index: 0, min: 1, max: 1 },
		{ building: 7, kind: 3, index: 2, min: 1, max: 2 },
		{ building: 7, kind: 3, index: 4, min: 1, max: 1 },
		{ building: 7, kind: 3, index: 9, min: 1, max: 2 },
		{ building: 7, kind: 3, index: 10, min: 1, max: 1 },
		{ building: 7, kind: 3, index: 13, min: 1, max: 1 },
		{ building: 7, kind: 3, index: 15, min: 1, max: 1 },
		{ building: 7, kind: 3, index: 17, min: 1, max: 1 },
		{ building: 7, kind: 3, index: 18, min: 1, max: 1 },
		{ building: 7, kind: 3, index: 5, min: 0.05, max: 0.05 },
		{ building: 7, kind: 3, index: 6, min: 0.05, max: 0.05 },
		{ building: 7, kind: 3, index: 7, min: 0.05, max: 0.05 },
		{ building: 7, kind: 3, index: 8, min: 0.05, max: 0.05 },
		{ building: 7, kind: 3, index: 12, min: 0.5, max: 0.5 },
		{ building: 7, kind: 4, index: 35, min: 0.5, max: 0.5 },
		{ building: 7, kind: 4, index: 36, min: 0.5, max: 0.5 },
	],
	[
		{ building: 8, kind: 3, index: 0, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 2, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 4, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 9, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 10, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 13, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 15, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 17, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 18, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 12, min: 0.5, max: 0.5 },
	],
	[
		{ building: 9, kind: 4, index: 33, min: 3, max: 5 },
		{ building: 9, kind: 4, index: 44, min: 10, max: 20 },
		{ building: 9, kind: 4, index: 45, min: 10, max: 20 },
		{ building: 9, kind: 4, index: 46, min: 20, max: 50 },
		{ building: 9, kind: 1, index: 10, min: 0.1, max: 0.1 },
		{ building: 9, kind: 1, index: 13, min: 0.1, max: 0.1 },
		// gunsmith scrap (not in the original DB): steel pieces and the odd gold piece to smelt
		{ building: 9, kind: 4, index: 25, min: 1, max: 3 },
		{ building: 9, kind: 4, index: 27, min: 0.25, max: 0.25 },
	],
	[
		{ building: 10, kind: 4, index: 34, min: 5, max: 10 },
		{ building: 10, kind: 4, index: 41, min: 1, max: 3 },
		{ building: 10, kind: 2, index: 0, min: 0.1, max: 0.1 },
		{ building: 10, kind: 2, index: 1, min: 0.1, max: 0.1 },
	],
	[
		{ building: 11, kind: 3, index: 11, min: 1, max: 2 },
		{ building: 11, kind: 3, index: 14, min: 1, max: 2 },
		{ building: 11, kind: 3, index: 16, min: 1, max: 2 },
		{ building: 11, kind: 3, index: 1, min: 1, max: 2 },
	],
	// --- the college campus (docs/DESIGN_RULES.md EDI-17): what each building held the week before (EDI-03), never a
	// gun or a round. Nine slots over four buildings (3 + 2 + 2 + 2) come to about six items in all, one school's
	// worth (a school search gives 6.2), where the two or three houses of the block gave some fifteen, mostly raw
	// materials: a good run spread over four searches, never a jackpot. What the campus has instead is aim -- the
	// lab's chip turns up in one lab search in fourteen (7.4 %), between a big house's 3.7 % and a supermarket's 10.7 %.
	// 12, the main hall: the lecture rooms' and the faculty office's drawers (plans, cells, bulbs), the lockers of
	// the back hall (a sweater, a can, a lost watch), the first aid box
	[
		{ building: 12, kind: 4, index: 29, min: 1, max: 2 },
		{ building: 12, kind: 4, index: 31, min: 0.5, max: 0.5 },
		{ building: 12, kind: 4, index: 32, min: 0.4, max: 0.4 },
		{ building: 12, kind: 4, index: 34, min: 1, max: 2 },
		{ building: 12, kind: 3, index: 9, min: 1, max: 1 },
		{ building: 12, kind: 3, index: 12, min: 0.5, max: 0.5 },
		{ building: 12, kind: 3, index: 6, min: 0.2, max: 0.2 },
		{ building: 12, kind: 2, index: 10, min: 0.1, max: 0.1 },
	],
	// 13, the library: plans and maps in the archive (blueprints), the reading lamps' batteries and bulbs, the lost
	// and found, a compass from the geography shelves, a can in the front desk's drawer
	[
		{ building: 13, kind: 4, index: 29, min: 1, max: 3 },
		{ building: 13, kind: 4, index: 31, min: 0.6, max: 0.6 },
		{ building: 13, kind: 4, index: 32, min: 0.5, max: 0.5 },
		{ building: 13, kind: 4, index: 34, min: 1, max: 1 },
		{ building: 13, kind: 2, index: 8, min: 0.1, max: 0.1 },
		{ building: 13, kind: 3, index: 9, min: 0.25, max: 0.25 },
	],
	// 14, the science lab: the "tech" (chips, circuits, parts, cells), the chemistry stockroom's makings of gunpowder,
	// the lab's first aid kit, and the physics lab's sealed teaching source (radioactive, rare)
	[
		{ building: 14, kind: 4, index: 35, min: 0.3, max: 0.3 },
		{ building: 14, kind: 4, index: 36, min: 0.2, max: 0.2 },
		{ building: 14, kind: 4, index: 30, min: 1, max: 2 },
		{ building: 14, kind: 4, index: 31, min: 0.5, max: 0.5 },
		{ building: 14, kind: 4, index: 33, min: 0.25, max: 0.25 },
		{ building: 14, kind: 3, index: 5, min: 0.1, max: 0.1 },
		{ building: 14, kind: 3, index: 12, min: 0.5, max: 0.5 },
		{ building: 14, kind: 4, index: 43, min: 0.05, max: 0.05 },
	],
	// 15, the dorm: the students' food (cans, bread, a frozen pizza, last night's pizza, an apple) and clothes
	[
		{ building: 15, kind: 3, index: 9, min: 1, max: 2 },
		{ building: 15, kind: 3, index: 4, min: 1, max: 2 },
		{ building: 15, kind: 3, index: 10, min: 1, max: 1 },
		{ building: 15, kind: 3, index: 11, min: 0.3, max: 0.3 },
		{ building: 15, kind: 3, index: 17, min: 1, max: 1 },
		{ building: 15, kind: 4, index: 34, min: 1, max: 3 },
		{ building: 15, kind: 2, index: 0, min: 0.2, max: 0.2 },
		{ building: 15, kind: 2, index: 1, min: 0.1, max: 0.1 },
		{ building: 15, kind: 3, index: 6, min: 0.2, max: 0.2 },
	],
];
