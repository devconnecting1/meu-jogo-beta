/*
 * What a container gives, decided in ONE place for both sides (docs/MULTIPLAYER.md §8.1): the client's MP_PHASE 2
 * path (client/systems/interaction.ts) and the server's (server/sim/items.ts) both roll here, from the same tables
 * (shared/data/spawns.ts BUILDING_SPAWNS and MAP_ITEM_LOOT). Before this each side had its own copy of the map-item
 * tables and its own roll, and they had drifted (QA L1).
 *
 *   rollBuildingLoot   a building's slots, rolled once and shared by whoever searches first (MP-05)
 *   rollPumpLoot       a gas station's pump island: the same, from its own table (EDI-16)
 *   isContainer        what the two sides' lazy sweeps roll: a building or a pump island
 *   thiefFind          the Thief skill's extra: one more slot of the building's table, for the searcher alone
 *   rollMapItemDrop    one hit (or E) on a tree, a car or a bin
 *
 * Pure: no Instances, no services; every roll goes through the shared rng (a test seeds it and replays it).
 */
import {
	BUILDING_SPAWNS,
	MAP_ITEM_LOOT,
	MapLootEntry,
	PUMP_LOOT,
	PUMP_LOOT_SLOTS,
	SpawnEntry,
} from "shared/data/spawns";
import { DESIGN } from "shared/engine/constants";
import { chance, choose, rndInt } from "shared/engine/rng";
import type { PlayerSaveData } from "shared/game/save";
import type { Solid } from "shared/game/world";

/** one thing a roll produced (the shape a building's `lootItems` holds) */
export interface LootDrop {
	kind: number;
	id: number;
	count: number;
}

/** skill id of Thief ("Find more items") */
export const SKILL_THIEF = 10;
/** ETC index of wood: what a chopping tool gets out of a tree */
const WOOD_INDEX = 23;

/** the table a building of type `bt` rolls from (the general table for a type that has none) */
export function buildingLootRows(bt: number): Array<SpawnEntry> {
	return bt >= 0 && bt < BUILDING_SPAWNS.size() ? BUILDING_SPAWNS[bt] : BUILDING_SPAWNS[0];
}

/** one slot: a line of the table, then its chance (min = max < 1) or its range (min..max); undefined = empty */
function rollSlot(rows: Array<SpawnEntry>): LootDrop | undefined {
	const e = choose(rows);
	if (e.max < 1) return chance(e.max * 100) ? { kind: e.kind, id: e.index, count: 1 } : undefined;
	return { kind: e.kind, id: e.index, count: rndInt(e.min, e.max) };
}

/** `slots` rolls of `rows` (an empty roll is an empty slot) */
function rollSlots(rows: Array<SpawnEntry>, slots: number): Array<LootDrop> {
	const out = new Array<LootDrop>();
	for (let i = 0; i < slots; i++) {
		const d = rollSlot(rows);
		if (d !== undefined) out.push(d);
	}
	return out;
}

/** the original's lazy loot: `slots` rolls of the building's table (an empty roll is an empty slot) */
export function rollBuildingLoot(bt: number, slots: number): Array<LootDrop> {
	return rollSlots(buildingLootRows(bt), slots);
}

/** a pump island's fuel (shared/data/spawns.ts PUMP_LOOT): one slot, rolled like a building's (EDI-16) */
export function rollPumpLoot(): Array<LootDrop> {
	return rollSlots(PUMP_LOOT, PUMP_LOOT_SLOTS);
}

/**
 * Is this solid a container the lazy sweeps roll (the client's MP_PHASE 2 one and the server's): a building, or a gas
 * station's pump island (`rollPumpLoot`), as opposed to anything else in reach?
 */
export function isContainer(s: Solid): boolean {
	return (s.kind === "building" || s.tags === "pump") && s.lootItems !== undefined;
}

/**
 * Thief ("Find more items"): a survivor with the skill who searches a building finds one more slot of that
 * building's table, rolled for them alone at the moment of the search -- the building's own loot is shared (MP-05)
 * and stays exactly what everyone else would have found. The original's Thief put one extra parcel on the map per
 * level; this is the same "more to find" where this game keeps its loot. Undefined: no skill, or the slot was empty.
 */
export function thiefFind(save: PlayerSaveData, bt: number): LootDrop | undefined {
	if ((save.skillLevels[SKILL_THIEF] ?? 0) <= 0) return undefined;
	return rollSlot(buildingLootRows(bt));
}

/** the table of a tree, a car or a bin; undefined for anything else */
export function mapItemLoot(s: Solid): Array<MapLootEntry> | undefined {
	if (s.kind === "tree") return MAP_ITEM_LOOT.tree;
	if (s.tags === "car") return MAP_ITEM_LOOT.car;
	if (s.tags === "trash") return MAP_ITEM_LOOT.trash;
	return undefined;
}

/**
 * What one hit on a map item drops (the hit cooldown is the caller's): the original's MAP_ITEM_PERCENT gate first,
 * then a chopping tool on a tree gets 2-3 wood, anything else one line of the table (its chance, or its amount).
 * Undefined: nothing came out.
 */
export function rollMapItemDrop(
	s: Solid,
	choppingTool: boolean,
): { kind: number; index: number; count: number } | undefined {
	const rows = mapItemLoot(s);
	if (rows === undefined) return undefined;
	if (!chance(DESIGN.MAP_ITEM_PERCENT)) return undefined;
	if (choppingTool && s.kind === "tree") return { kind: 4, index: WOOD_INDEX, count: 2 + (chance(50) ? 1 : 0) };
	const e = choose(rows);
	if (e.amount < 1) return chance(e.amount * 100) ? { kind: e.kind, index: e.index, count: 1 } : undefined;
	return { kind: e.kind, index: e.index, count: math.floor(e.amount) };
}
