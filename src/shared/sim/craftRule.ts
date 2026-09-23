/*
 * THE craft rule, one copy for both sides (docs/MULTIPLAYER.md §8.1): which station a recipe needs, whether a solid
 * IS that station right now, how near "near" is, and what a craft yields.
 *
 * The client's Bag (client/systems/craftSystem.ts: the greyed-out button and the MP_PHASE 2 craft) and the server's
 * craft (server/sim/craft.ts, which the F3 intents call) used to carry a copy each, and the copies had drifted: the
 * client measured the distance to a desk as a box (Chebyshev) and the server as a true distance, so 150 u off a
 * corner on both axes (212 u) the Bag offered a craft the server refused (QA D2, 2026-09-23). Now both import this.
 *
 * Stations:
 *   desk   a craft desk or a pro craft desk (a pro desk does everything a desk does)
 *   pro    a pro craft desk
 *   fire   smelting (item_fire): a LIT brazier, or the electric furnace
 *   cook   cooking (item_cook): a LIT campfire or brazier, or a WORKING cooker
 *
 * Why the brazier cooks too (the original only smelted on it): it is an open fire, and a fire that smelts steel
 * but will not warm a potato contradicts what the player sees (P3). Why the campfire does not smelt: a pile of
 * burning wood on the ground does not get hot enough for metal -- that is what the brazier's stone basket is for,
 * and it is the only reason to build a brazier over a campfire. The cooker is the electric stove: it cooks when the
 * power stage says it is working (`isWorkingCooker`, the one hook it needs).
 *
 * Pure: no Instances, no services. The one random roll (the skill doubles) goes through the shared rng, so the
 * server and a test can replay it.
 */
import type { CraftRecipe } from "shared/data/crafts";
import { chance } from "shared/engine/rng";
import type { PlayerSaveData } from "shared/game/save";
import { querySolids, Solid, WorldData } from "shared/game/world";

/** reach to a station: the TRUE distance from the survivor's centre to the station's rectangle (the original's 180) */
export const STATION_RANGE = 180;

export type CraftStation = "desk" | "pro" | "fire" | "cook";

/** what a recipe does with heat: cooking, smelting, or nothing (hand, desk, pro desk) */
export type CraftHeat = "cook" | "smelt" | undefined;

/** skill ids whose level doubles a heated craft: Chef (item_cook) and Dwarf (item_fire) */
export const SKILL_CHEF = 11;
export const SKILL_DWARF = 12;

/** a campfire or a brazier, burning (E lights it; it goes out when its wood is spent) */
export function isLitFire(s: Solid): boolean {
	return (s.tags === "campfire" || s.tags === "brazier") && s.powered === true;
}

/**
 * A cooker that can cook right now. The hook of the power stage: a cooker counts while its `powered` flag is set,
 * and whatever feeds it (a generator, a battery box) decides that by writing `powered` -- cooking at it then goes
 * through the same recipes as a fire, with nothing else to change here.
 */
export function isWorkingCooker(s: Solid): boolean {
	return s.tags === "cooker" && s.powered === true;
}

/** an electric furnace that can smelt right now (today: always; the power stage may ask for `powered`) */
export function isWorkingFurnace(s: Solid): boolean {
	return s.tags === "furnace";
}

/** is this solid, as it stands now, a station of that kind? */
export function matchesStation(s: Solid, station: CraftStation): boolean {
	if (s.removed === true) return false;
	if (station === "desk") return s.tags === "craftdesk" || s.tags === "craftdesk_pro";
	if (station === "pro") return s.tags === "craftdesk_pro";
	if (station === "cook") return isLitFire(s) || isWorkingCooker(s);
	return (s.tags === "brazier" && s.powered === true) || isWorkingFurnace(s);
}

/** squared true distance from (x, y) to the rectangle of `s` (0 inside it) */
function distance2(s: Solid, x: number, y: number): number {
	const dx = x - math.clamp(x, s.x, s.x + s.w);
	const dy = y - math.clamp(y, s.y, s.y + s.h);
	return dx * dx + dy * dy;
}

/**
 * The nearest station of that kind within STATION_RANGE of (x, y), or undefined. `buf` is a scratch array the
 * caller may reuse between calls (it is cleared here); without one, a fresh array is used.
 */
export function stationNear(
	world: WorldData,
	x: number,
	y: number,
	station: CraftStation,
	buf?: Array<Solid>,
): Solid | undefined {
	const found = buf ?? new Array<Solid>();
	found.clear();
	querySolids(world, x - STATION_RANGE, y - STATION_RANGE, x + STATION_RANGE, y + STATION_RANGE, found);
	let best: Solid | undefined;
	let bestD2 = STATION_RANGE * STATION_RANGE;
	for (const s of found) {
		if (!matchesStation(s, station)) continue;
		const d2 = distance2(s, x, y);
		if (d2 <= bestD2) {
			bestD2 = d2;
			best = s;
		}
	}
	found.clear();
	return best;
}

/** the one station a recipe asks for (a pro desk before a desk), or undefined for a hand recipe */
export function recipeStation(r: CraftRecipe): CraftStation | undefined {
	if (r.needsPro) return "pro";
	if (r.needsDesk) return "desk";
	if (r.needsCook === true) return "cook";
	if (r.needsFire === true) return "fire";
	return undefined;
}

/** is the station `r` needs within reach of a survivor at (x, y)? (true for a hand recipe) */
export function stationOk(world: WorldData, x: number, y: number, r: CraftRecipe, buf?: Array<Solid>): boolean {
	const station = recipeStation(r);
	return station === undefined || stationNear(world, x, y, station, buf) !== undefined;
}

/** cooking, smelting or neither */
export function craftHeat(r: CraftRecipe): CraftHeat {
	if (r.needsCook === true) return "cook";
	if (r.needsFire === true) return "smelt";
	return undefined;
}

/**
 * How many a craft makes: MAKES ×N, doubled now and then by the skill of its heat -- Chef on cooking (item_cook),
 * Dwarf on smelting (item_fire): 15 % at level 1, 30 % at level 2, as in the original.
 */
export function craftYield(r: CraftRecipe, save: PlayerSaveData): number {
	const heat = craftHeat(r);
	if (heat === undefined) return r.resultCount;
	const level = save.skillLevels[heat === "cook" ? SKILL_CHEF : SKILL_DWARF] ?? 0;
	if (level > 0 && chance(level >= 2 ? 30 : 15)) return r.resultCount * 2;
	return r.resultCount;
}
