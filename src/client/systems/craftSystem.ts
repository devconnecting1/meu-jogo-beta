import { CRAFT_RECIPES, CraftRecipe } from "shared/data/crafts";
import { ETC_ITEMS } from "shared/data/etcItems";
import { EQUIPS } from "shared/data/equips";
import { USABLES } from "shared/data/usables";
import { WEAPONS } from "shared/data/weapons";
import type { Solid, WorldData } from "shared/game/world";
import type { PlayerState } from "shared/game/player";
import { addItem, countItem, removeItem, unequipGone } from "shared/sim/inventory";
import { IntentKind } from "shared/net/intentWire";
import * as Rule from "shared/sim/craftRule";
import { sendBagVerb, serverOwnsWorld } from "../net/authority";
import { fxMessage, GameRefs } from "./types";

export type CraftStation = Rule.CraftStation;

/** one scratch buffer: the client has one survivor asking */
const stationBuf: Array<Solid> = [];

/**
 * Nearest station of that kind within reach of the survivor: the SHARED rule (shared/sim/craftRule.ts), the one the
 * server refuses with, so the Bag never offers a craft the server would refuse (QA D2).
 */
export function stationNear(
	refs: { world: WorldData; player: PlayerState },
	station: CraftStation,
	by: PlayerState = refs.player,
): Solid | undefined {
	return Rule.stationNear(refs.world, by.x, by.y, station, stationBuf);
}

/** display name of an inventory item (kind 1 weapon, 2 equip, 3 usable, 4 etc) */
export function itemName(kind: number, index: number): string {
	if (kind === 1) return WEAPONS[index]?.name ?? `weapon ${index}`;
	if (kind === 2) return EQUIPS[index]?.name ?? `equip ${index}`;
	if (kind === 3) return USABLES[index]?.name ?? `item ${index}`;
	return ETC_ITEMS[index]?.name ?? `item ${index}`;
}

function recipeById(recipeId: number): CraftRecipe | undefined {
	const direct = CRAFT_RECIPES[recipeId];
	if (direct !== undefined && direct.id === recipeId) return direct;
	for (const r of CRAFT_RECIPES) {
		if (r.id === recipeId) return r;
	}
	return undefined;
}

/** what the survivor is told when the station a recipe needs is not in reach */
const STATION_MISSING: Record<CraftStation, string> = {
	pro: "Needs a pro craft desk nearby",
	desk: "Needs a craft desk nearby",
	cook: "Needs a lit fire nearby",
	fire: "Needs a lit brazier nearby",
};

/**
 * Why this recipe cannot be crafted right now (undefined = it can). Used for the message shown
 * when a craft fails, and by the UI to explain a greyed-out recipe.
 */
export function craftBlocker(refs: GameRefs, r: CraftRecipe): string | undefined {
	if (refs.pendingPlace >= 0) return "Finish the current build first";
	const station = Rule.recipeStation(r);
	if (station !== undefined && stationNear(refs, station) === undefined) return STATION_MISSING[station];
	const missing: Array<string> = [];
	for (const ing of r.ingredients) {
		const have = countItem(refs.save, ing.kind, ing.index);
		if (have < ing.count) missing.push(`${itemName(ing.kind, ing.index)} ${math.floor(have)}/${ing.count}`);
	}
	if (missing.size() > 0) return `Missing: ${missing.join(", ")}`;
	return undefined;
}

export function canCraft(refs: GameRefs, r: CraftRecipe): boolean {
	return craftBlocker(refs, r) === undefined;
}

/**
 * Craft a recipe. On failure tells the player why (refs.onMessage) instead of failing silently.
 * Placeables go to build mode (pendingPlace + pendingRecipe so cancelling refunds them).
 * Cooking honours "Chef" (skill 11) and smelting "Dwarf" (skill 12): 15% / 30% chance of double, like item_cook /
 * item_fire (shared/sim/craftRule.ts craftYield, the server's rule too).
 */
export function craft(refs: GameRefs, recipeId: number): boolean {
	const r = recipeById(recipeId);
	if (r === undefined) return false;
	const why = craftBlocker(refs, r);
	if (why !== undefined) {
		fxMessage(refs, why, refs.player);
		return false;
	}
	// F3: the server crafts (server/sim/craft.ts); this client predicts the same rule on its copy and sends the verb
	if (serverOwnsWorld()) return sendBagVerb(IntentKind.Craft, recipeId);
	for (const ing of r.ingredients) {
		removeItem(refs.save, ing.kind, ing.index, ing.count);
	}
	// the recipe may have eaten what the survivor held or wore (a pistol, the steel armour): it comes off. The weapon
	// in HAND is swapped for the blade by the caller (main.client pack.onCraft), which owns the weapon switch
	unequipGone(refs.save);
	if (r.craftKind === 1) {
		refs.pendingPlace = r.resultIndex;
		refs.pendingRecipe = r.id;
	} else {
		addItem(refs.save, r.resultKind, r.resultIndex, Rule.craftYield(r, refs.save));
	}
	return true;
}

export function craftableList(refs: GameRefs): Array<number> {
	const out: Array<number> = [];
	for (const r of CRAFT_RECIPES) {
		if (canCraft(refs, r)) out.push(r.id);
	}
	return out;
}
