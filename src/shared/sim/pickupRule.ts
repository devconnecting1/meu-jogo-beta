/*
 * What a survivor takes off the ground, and how (docs/DESIGN_RULES.md ITM-07). ONE rule, read by the server
 * (server/sim/items.ts: the E press and the walk-over sweep), by the client's own world offline
 * (client/systems/interaction.ts), by the "E: …" hint and by the ground items' look (client/view/groundItemsView.ts).
 *
 *   - Supplies are WALKED UP: usables (food, medicine) and materials (ammunition, oil, wood, parts, kits) -- the Bag's
 *     Usables and Materials tabs. The body over the item takes it (WALK_PICKUP_RANGE), once it has been on the ground
 *     WALK_PICKUP_DELAY_S (a drop is seen landing before it is gone), at most one item per survivor every
 *     WALK_PICKUP_RATE_S. The server decides, with the E press's own checks (reach, a clear line, first come).
 *   - Weapons and equipment take E -- the Bag's Weapons and Gear tabs. A weapon is a choice: it takes a place on keys
 *     1-5 (shared/game/weaponSlots.ts orders them by id, so a new pistol moves the axe from 3 to 4), the game has no
 *     drop verb to give it back, and in co-op the rifle on the floor is not whoever runs past first's by accident.
 *   - E still takes anything in reach, supplies included: one button never stops working.
 *
 * And the ceiling: the save keeps at most SAVE_LIMITS.ITEM_MAX of an item (AMMO_MAX of the five counters the ammo
 * and the oil live in). Anything past it was lost at the next load, silently; a pickup now takes only what fits
 * (`pickupRoom`), leaves the rest on the ground, and the hint says the item is full.
 *
 * Pure: no Instances, no services, no clock.
 */
import { ItemKind } from "shared/data/kinds";
import { BOSS_TROPHIES } from "shared/data/spawns";
import { WEAPONS } from "shared/data/weapons";
import { PLAYER_RADIUS } from "shared/game/physics";
import { PlayerSaveData, SAVE_LIMITS } from "shared/game/save";
import { GroundItem, queryGroundItems, WorldData } from "shared/game/world";
import { countItem } from "./inventory";

/** the body over the item: its centre within the survivor's radius and a hand's breadth (18 + 8 u) */
export const WALK_PICKUP_RANGE = PLAYER_RADIUS + 8;
/** a drop lies this long before a body takes it (its bounce is seen; a zombie's drop is not gone before it lands) */
export const WALK_PICKUP_DELAY_S = 0.5;
/** one walked-up item per survivor per this many seconds (10 a second: a pile of wood goes in a blink, not a frame) */
export const WALK_PICKUP_RATE_S = 0.1;

/** is an item of this kind walked up (supplies), rather than taken with E (weapons, equipment)? */
export function walkPickup(kind: number): boolean {
	return kind === ItemKind.Use || kind === ItemKind.Etc;
}

/** the save's ceiling for one item: ammunition, arrows and oil have their own counters (inventory.ts) */
export function itemCap(kind: number, id: number): number {
	if (kind === ItemKind.Etc && id >= 44 && id <= 48) return SAVE_LIMITS.AMMO_MAX;
	return SAVE_LIMITS.ITEM_MAX;
}

/** how many more of this item the save can hold (0: full) */
export function pickupRoom(save: PlayerSaveData, kind: number, id: number): number {
	return math.max(0, itemCap(kind, id) - countItem(save, kind, id));
}

/** reused by every `walkPickupTarget` (the server asks ten times a second per survivor): no table per answer */
const NEAR = new Array<GroundItem>();

/**
 * The supply a body at (x, y) walks up now: the nearest walk-up item within WALK_PICKUP_RANGE that `ready` allows
 * (it has lain long enough) and that the save has room for. Ties go to the oldest id, as the E target's do. Only the
 * items in the reach's box are read -- on the server the item grid's cells under the body (shared/game/world.ts
 * `queryGroundItems`), on a client its own short list.
 */
export function walkPickupTarget(
	world: WorldData,
	x: number,
	y: number,
	save: PlayerSaveData,
	ready: (item: GroundItem) => boolean,
): GroundItem | undefined {
	const reach = WALK_PICKUP_RANGE;
	let best: GroundItem | undefined;
	let bestD2 = reach * reach;
	const found = NEAR;
	found.clear();
	queryGroundItems(world, x - reach, y - reach, x + reach, y + reach, found);
	for (const it of found) {
		const dx = it.x - x;
		if (dx > reach || dx < -reach) continue;
		const dy = it.y - y;
		if (dy > reach || dy < -reach) continue;
		const d2 = dx * dx + dy * dy;
		if (d2 > bestD2 || (d2 === bestD2 && best !== undefined && it.id > best.id)) continue;
		if (!walkPickup(it.kind) || !ready(it) || pickupRoom(save, it.kind, it.itemId) <= 0) continue;
		bestD2 = d2;
		best = it;
	}
	found.clear();
	return best;
}

/**
 * How an item on the ground marks itself (client/view/groundItemsView.ts):
 *   "rare"    a boss's trophy or a golden weapon: a gold ring and the glint;
 *   "gear"    a weapon or equipment, taken with E: a pale ring and the glint;
 *   "supply"  walked up: no ring, a smaller glint half as often -- a street of wood stays a street.
 */
export type GroundTier = "rare" | "gear" | "supply";

/** kind and id as one number (ids stay far below 1000), so the per-frame lookup builds no string */
const rareKey = (kind: number, id: number): number => kind * 1000 + id;
const RARE = new Set<number>();
// the four bosses of shared/sim/ai/bossBrain.ts (1..4); a key the table does not have is skipped
for (let boss = 1; boss <= 4; boss++) {
	for (const t of BOSS_TROPHIES[boss] ?? []) RARE.add(rareKey(t.kind, t.index));
}
for (let i = 0; i < WEAPONS.size(); i++) {
	if (WEAPONS[i].name.sub(1, 7) === "Golden ") RARE.add(rareKey(ItemKind.Weapon, i));
}

export function groundTier(kind: number, id: number): GroundTier {
	if (RARE.has(rareKey(kind, id))) return "rare";
	return walkPickup(kind) ? "supply" : "gear";
}
