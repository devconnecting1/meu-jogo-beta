import { CRAFT_RECIPES, CraftRecipe } from "shared/data/crafts";
import { ETC_ITEMS } from "shared/data/etcItems";
import { EQUIPS } from "shared/data/equips";
import { USABLES } from "shared/data/usables";
import { WEAPONS } from "shared/data/weapons";
import { chance } from "shared/engine/rng";
import { querySolids, Solid } from "shared/game/world";
import type { PlayerState } from "shared/game/player";
import { addItem, countItem, removeItem, unequipGone } from "shared/sim/inventory";
import { fxMessage, GameRefs } from "./types";

/** how close (edge distance) a desk / fire must be */
const DESK_RANGE = 180;

export type CraftStation = "desk" | "pro" | "fire";

const stationBuf: Array<Solid> = [];

function matchesStation(s: Solid, station: CraftStation): boolean {
	if (s.removed === true) return false;
	if (station === "desk") return s.tags === "craftdesk" || s.tags === "craftdesk_pro";
	if (station === "pro") return s.tags === "craftdesk_pro";
	// smelting: a lit brazier (E toggles it) or the electric furnace
	return (s.tags === "brazier" && s.powered === true) || s.tags === "furnace";
}

/** nearest construction of that kind within DESK_RANGE of the survivor (edge distance) */
export function stationNear(refs: GameRefs, station: CraftStation, by: PlayerState = refs.player): Solid | undefined {
	const p = by;
	const pad = DESK_RANGE + 160;
	stationBuf.clear();
	querySolids(refs.world, p.x - pad, p.y - pad, p.x + pad, p.y + pad, stationBuf);
	let best: Solid | undefined;
	let bestD = DESK_RANGE;
	for (const s of stationBuf) {
		if (!matchesStation(s, station)) continue;
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const d = math.max(math.abs(cx - p.x) - s.w / 2, math.abs(cy - p.y) - s.h / 2);
		if (d < bestD) {
			bestD = d;
			best = s;
		}
	}
	return best;
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

/**
 * Why this recipe cannot be crafted right now (undefined = it can). Used for the message shown
 * when a craft fails, and by the UI to explain a greyed-out recipe.
 */
export function craftBlocker(refs: GameRefs, r: CraftRecipe): string | undefined {
	if (refs.pendingPlace >= 0) return "Finish the current build first";
	if (r.needsPro) {
		if (stationNear(refs, "pro") === undefined) return "Needs a pro craft desk nearby";
	} else if (r.needsDesk) {
		if (stationNear(refs, "desk") === undefined) return "Needs a craft desk nearby";
	}
	if (r.needsFire === true && stationNear(refs, "fire") === undefined) {
		return "Needs a lit fire nearby";
	}
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
 * Smelting honours "Dwarf" (skill 12): 15% / 30% chance of double metal, like item_fire.
 */
export function craft(refs: GameRefs, recipeId: number): boolean {
	const r = recipeById(recipeId);
	if (r === undefined) return false;
	const why = craftBlocker(refs, r);
	if (why !== undefined) {
		fxMessage(refs, why, refs.player);
		return false;
	}
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
		let count = r.resultCount;
		if (r.needsFire === true) {
			const dwarf = refs.save.skillLevels[12] ?? 0;
			if (dwarf > 0 && chance(dwarf >= 2 ? 30 : 15)) count *= 2;
		}
		addItem(refs.save, r.resultKind, r.resultIndex, count);
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
