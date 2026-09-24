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

/**
 * What a gas station's pump island holds (DESIGN_RULES EDI-16): the fuel left in its hoses and the line to the tank,
 * drained by hand -- Oil, the motorcycle's and the oil generator's fuel (VEI-05, ELE-02). ONE slot, rolled like a
 * building's (shared/sim/loot.ts `rollPumpLoot`, lazily when a survivor comes near), shared by whoever drains it first
 * and back after ITEM_RESPAWN_HOURS (MP-05). Not in the original: there the pumps were scenery and the oil sat in the
 * shop's table (still there, `BUILDING_SPAWNS[5]`).
 *
 * The amount is the economy's (VEI-05): the motorcycle burns 1 Oil a minute idling and 7 at full throttle, so an island
 * (5-10, 7.5 on average) is one to eight minutes of riding, a station (two islands) about four minutes at a mixed
 * pace, every half game day (~5 real minutes); an oil generator's refuel is 5 Oil. A house gives ~3 Oil on average
 * and the station's shop ~3.6: the pumps are where the fuel is (P3), not a tap that makes the rest pointless.
 */
export const PUMP_LOOT: Array<SpawnEntry> = [{ building: 5, kind: 4, index: 48, min: 5, max: 10 }];
/** slots a pump island rolls (one: the fuel in it) */
export const PUMP_LOOT_SLOTS = 1;

/**
 * The searchable fixtures out in the open (docs/DESIGN_RULES.md EDI-20, EDI-21, MOB-06), by tag: what a market
 * stall, the market's food truck, a pile of building material and a garden shed hold. Rolled like a pump island
 * (shared/sim/loot.ts `rollYardLoot`: lazily when a survivor comes near, one slot, shared by whoever takes it first,
 * back after ITEM_RESPAWN_HOURS -- MP-05), and told to the survivors outside by the same LootFlag. A stall's table is
 * picked by what it displays (`Solid.variant`: 0 produce, 1 bread and preserves, 2 cloth and leather goods), a pile's
 * by what it is (0 lumber, 1 bricks, 2 steel). `building` is -1: no building holds these.
 */
export const YARD_LOOT: Record<string, Array<SpawnEntry>> = {
	stall0: [
		{ building: -1, kind: 3, index: 17, min: 1, max: 2 },
		{ building: -1, kind: 3, index: 18, min: 1, max: 2 },
		{ building: -1, kind: 3, index: 2, min: 1, max: 2 },
		{ building: -1, kind: 3, index: 15, min: 0.5, max: 0.5 },
	],
	stall1: [
		{ building: -1, kind: 3, index: 4, min: 1, max: 2 },
		{ building: -1, kind: 3, index: 9, min: 1, max: 1 },
		{ building: -1, kind: 3, index: 18, min: 0.5, max: 0.5 },
	],
	stall2: [
		{ building: -1, kind: 4, index: 34, min: 1, max: 2 },
		{ building: -1, kind: 4, index: 41, min: 0.5, max: 0.5 },
		{ building: -1, kind: 2, index: 0, min: 0.05, max: 0.05 },
	],
	foodtruck: [
		{ building: -1, kind: 3, index: 14, min: 1, max: 1 },
		{ building: -1, kind: 3, index: 11, min: 1, max: 1 },
		{ building: -1, kind: 3, index: 4, min: 1, max: 2 },
	],
	pile0: [{ building: -1, kind: 4, index: 23, min: 2, max: 4 }],
	pile1: [{ building: -1, kind: 4, index: 24, min: 2, max: 4 }],
	pile2: [{ building: -1, kind: 4, index: 25, min: 1, max: 3 }],
	shed: [
		{ building: -1, kind: 4, index: 23, min: 1, max: 2 },
		{ building: -1, kind: 4, index: 25, min: 1, max: 1 },
		{ building: -1, kind: 4, index: 48, min: 2, max: 4 },
		{ building: -1, kind: 4, index: 30, min: 0.2, max: 0.2 },
		{ building: -1, kind: 1, index: 2, min: 0.04, max: 0.04 },
	],
};
/**
 * The bank vault's deposit boxes (docs/DESIGN_RULES.md EDI-23): the best of the bank, and once a town. Every line is
 * a box and is rolled once (shared/sim/loot.ts `rollVaultLoot`: a chance line comes or not, a range line gives its
 * amount) -- about 7.5 things, where the bank's own drawers give 2 to 3 a search -- and the boxes are never refilled
 * (loot.ts `lootRespawnHours`). What a town kept in its bank when it fell: gold, watches, a compass, the medicine
 * nobody could afford to lose, the batteries and chips of the bank's own systems. Never a gun or a round: the vault is
 * a reason to take a risk (a crowbar, ten noisy seconds, the alarm: shared/sim/vault.ts), not an armoury.
 */
export const VAULT_LOOT: Array<SpawnEntry> = [
	// piece of gold
	{ building: -1, kind: 4, index: 27, min: 2, max: 4 },
	// watch, digital watch, compass
	{ building: -1, kind: 2, index: 10, min: 0.5, max: 0.5 },
	{ building: -1, kind: 2, index: 11, min: 0.4, max: 0.4 },
	{ building: -1, kind: 2, index: 8, min: 0.25, max: 0.25 },
	// first aid kit, adrenaline
	{ building: -1, kind: 3, index: 5, min: 0.5, max: 0.5 },
	{ building: -1, kind: 3, index: 7, min: 0.35, max: 0.35 },
	// battery, computer chip, voltage circuit
	{ building: -1, kind: 4, index: 31, min: 1, max: 2 },
	{ building: -1, kind: 4, index: 35, min: 0.6, max: 0.6 },
	{ building: -1, kind: 4, index: 36, min: 0.35, max: 0.35 },
];
/** the tags of the searchable fixtures (their tables above are the tag, or the tag and the variant; the vault's is VAULT_LOOT) */
export const YARD_TAGS: ReadonlyArray<string> = ["stall", "foodtruck", "pile", "shed", "vault"];
/** a searchable fixture's table key: its tag, and for a stall or a pile the variant too */
export function yardLootKey(tags: string, variant: number | undefined): string {
	return tags === "stall" || tags === "pile" ? `${tags}${variant ?? 0}` : tags;
}

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

/**
 * The everyday town's buildings (docs/DESIGN_RULES.md EDI-18, EDI-03: what each held before the outbreak), by
 * building type (shared/data/buildings.ts BuildingType 16..26). A record beside BUILDING_SPAWNS, not more rows of it:
 * the ids jump past the college campus's (12-15, EDI-17), and a hole in an array is a hole in the Luau table. Read
 * through `spawnRows`. Only items that already exist, each line a small share of a 2-3 slot search: a hardware store is
 * wood and steel pieces with the odd tool, a pawn shop pieces of gold (never Gold: it is only smelted) and a watch, the
 * police station's armoury a few rounds -- guns stay the gun shop's (a pistol at 4 % of a line) -- and the fire station
 * the medic kit and the axe on the wall. The loot per town, category by category, is in EDI-18 (`tools/town-census.mjs`).
 */
export const TOWN_SPAWNS: Record<number, Array<SpawnEntry>> = {
	// hardware store: lumber, steel, stone, and the tools on the wall
	16: [
		{ building: 16, kind: 4, index: 23, min: 2, max: 4 },
		{ building: 16, kind: 4, index: 25, min: 1, max: 3 },
		{ building: 16, kind: 4, index: 24, min: 1, max: 2 },
		{ building: 16, kind: 4, index: 30, min: 0.3, max: 0.3 },
		{ building: 16, kind: 4, index: 31, min: 0.3, max: 0.3 },
		{ building: 16, kind: 4, index: 32, min: 0.4, max: 0.4 },
		{ building: 16, kind: 4, index: 34, min: 1, max: 2 },
		{ building: 16, kind: 1, index: 2, min: 0.08, max: 0.08 },
		{ building: 16, kind: 1, index: 3, min: 0.08, max: 0.08 },
		{ building: 16, kind: 1, index: 4, min: 0.08, max: 0.08 },
		// a small town's hardware store keeps a case of shotgun shells for the hunting season
		{ building: 16, kind: 4, index: 45, min: 2, max: 5 },
	],
	// auto repair: motor oil, spare parts, scrap steel; now and then an engine on the stand
	17: [
		{ building: 17, kind: 4, index: 48, min: 3, max: 6 },
		{ building: 17, kind: 4, index: 30, min: 1, max: 2 },
		{ building: 17, kind: 4, index: 25, min: 2, max: 3 },
		{ building: 17, kind: 4, index: 31, min: 0.4, max: 0.4 },
		{ building: 17, kind: 4, index: 32, min: 0.3, max: 0.3 },
		{ building: 17, kind: 4, index: 37, min: 0.05, max: 0.05 },
		{ building: 17, kind: 1, index: 3, min: 0.05, max: 0.05 },
	],
	// electronics: batteries, bulbs, chips; a flashlight or a watch off the shelf
	18: [
		{ building: 18, kind: 4, index: 31, min: 1, max: 2 },
		{ building: 18, kind: 4, index: 32, min: 1, max: 2 },
		{ building: 18, kind: 4, index: 35, min: 0.3, max: 0.3 },
		{ building: 18, kind: 4, index: 36, min: 0.1, max: 0.1 },
		{ building: 18, kind: 4, index: 42, min: 0.05, max: 0.05 },
		{ building: 18, kind: 2, index: 13, min: 0.1, max: 0.1 },
		{ building: 18, kind: 2, index: 11, min: 0.1, max: 0.1 },
		{ building: 18, kind: 2, index: 10, min: 0.05, max: 0.05 },
	],
	// bakery: bread, and what the counter sold with it
	19: [
		{ building: 19, kind: 3, index: 4, min: 1, max: 3 },
		{ building: 19, kind: 3, index: 18, min: 1, max: 2 },
		{ building: 19, kind: 3, index: 17, min: 0.5, max: 0.5 },
		{ building: 19, kind: 3, index: 14, min: 0.3, max: 0.3 },
	],
	// pawn shop: pieces of gold, watches, a compass, a bat or a club behind the counter -- no guns (they are the gun shop's)
	20: [
		{ building: 20, kind: 4, index: 27, min: 1, max: 2 },
		{ building: 20, kind: 2, index: 10, min: 0.25, max: 0.25 },
		{ building: 20, kind: 2, index: 11, min: 0.15, max: 0.15 },
		{ building: 20, kind: 2, index: 8, min: 0.1, max: 0.1 },
		{ building: 20, kind: 2, index: 13, min: 0.1, max: 0.1 },
		{ building: 20, kind: 2, index: 1, min: 0.1, max: 0.1 },
		{ building: 20, kind: 1, index: 6, min: 0.1, max: 0.1 },
		{ building: 20, kind: 1, index: 8, min: 0.1, max: 0.1 },
		{ building: 20, kind: 4, index: 31, min: 0.3, max: 0.3 },
		// a box of rounds pawned with a gun long sold
		{ building: 20, kind: 4, index: 44, min: 3, max: 6 },
	],
	// post office: the parcels nobody delivered -- a little of everything, rarely much
	21: [
		{ building: 21, kind: 4, index: 34, min: 1, max: 2 },
		{ building: 21, kind: 4, index: 41, min: 0.3, max: 0.3 },
		{ building: 21, kind: 3, index: 9, min: 0.4, max: 0.4 },
		{ building: 21, kind: 3, index: 12, min: 0.4, max: 0.4 },
		{ building: 21, kind: 4, index: 31, min: 0.3, max: 0.3 },
		{ building: 21, kind: 4, index: 32, min: 0.2, max: 0.2 },
		{ building: 21, kind: 2, index: 8, min: 0.05, max: 0.05 },
		{ building: 21, kind: 2, index: 10, min: 0.05, max: 0.05 },
	],
	// bank: the vault's pieces of gold, a watch in a safe-deposit box, the staff's first aid kit
	22: [
		{ building: 22, kind: 4, index: 27, min: 1, max: 2 },
		{ building: 22, kind: 2, index: 11, min: 0.1, max: 0.1 },
		{ building: 22, kind: 2, index: 10, min: 0.1, max: 0.1 },
		{ building: 22, kind: 3, index: 5, min: 0.1, max: 0.1 },
		{ building: 22, kind: 4, index: 34, min: 1, max: 1 },
	],
	// church: the food pantry's shelves, blankets, the parish first aid box
	23: [
		{ building: 23, kind: 3, index: 9, min: 1, max: 2 },
		{ building: 23, kind: 3, index: 4, min: 1, max: 2 },
		{ building: 23, kind: 3, index: 12, min: 0.5, max: 0.5 },
		{ building: 23, kind: 3, index: 5, min: 0.1, max: 0.1 },
		{ building: 23, kind: 4, index: 34, min: 1, max: 2 },
	],
	// fire station: the EMS bag, the axe on the truck, turnout leather, the generator's fuel
	24: [
		{ building: 24, kind: 3, index: 5, min: 0.3, max: 0.3 },
		{ building: 24, kind: 3, index: 12, min: 1, max: 2 },
		{ building: 24, kind: 3, index: 6, min: 0.2, max: 0.2 },
		{ building: 24, kind: 1, index: 2, min: 0.15, max: 0.15 },
		{ building: 24, kind: 2, index: 13, min: 0.15, max: 0.15 },
		{ building: 24, kind: 4, index: 41, min: 1, max: 1 },
		{ building: 24, kind: 4, index: 34, min: 1, max: 2 },
		{ building: 24, kind: 4, index: 48, min: 2, max: 4 },
	],
	// police station: a few rounds from the armoury, the stun gun and the flashlight off a belt, the first aid kit
	25: [
		{ building: 25, kind: 4, index: 44, min: 6, max: 12 },
		{ building: 25, kind: 4, index: 45, min: 3, max: 6 },
		{ building: 25, kind: 3, index: 12, min: 1, max: 1 },
		{ building: 25, kind: 3, index: 5, min: 0.2, max: 0.2 },
		{ building: 25, kind: 2, index: 13, min: 0.25, max: 0.25 },
		{ building: 25, kind: 1, index: 26, min: 0.05, max: 0.05 },
		{ building: 25, kind: 1, index: 10, min: 0.04, max: 0.04 },
	],
	// offices: the supply cupboard (batteries, bulbs, a chip), the kitchenette's can, a coat left on a hook
	26: [
		{ building: 26, kind: 4, index: 31, min: 0.4, max: 0.4 },
		{ building: 26, kind: 4, index: 32, min: 0.4, max: 0.4 },
		{ building: 26, kind: 4, index: 35, min: 0.15, max: 0.15 },
		{ building: 26, kind: 3, index: 9, min: 0.3, max: 0.3 },
		{ building: 26, kind: 4, index: 34, min: 1, max: 1 },
		{ building: 26, kind: 2, index: 10, min: 0.05, max: 0.05 },
	],
};

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

/**
 * The table a building of type `bt` searches: its row of BUILDING_SPAWNS, or the everyday town's (TOWN_SPAWNS), or
 * undefined for a type with neither (shared/sim/loot.ts `buildingLootRows` falls back to the general table).
 */
export function spawnRows(bt: number): Array<SpawnEntry> | undefined {
	const extra = TOWN_SPAWNS[bt];
	if (extra !== undefined) return extra;
	return bt >= 0 && bt < BUILDING_SPAWNS.size() ? BUILDING_SPAWNS[bt] : undefined;
}
