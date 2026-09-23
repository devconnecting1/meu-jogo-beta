/*
 * The backpack, decided by the SERVER: crafting, using, equipping and learning (docs/MULTIPLAYER.md §2.1,
 * §6.1, §6.3, §8.1).
 *
 * These four are what is left of the client's authority over the save. Crafting was `removeItem` × n then
 * `addItem` — in the client's own copy, with the client's own idea of what was in the backpack and what was
 * standing nearby. "Craft a rifle out of nothing" was one line of a modified client, and so was "learn every
 * skill". With F3 the client asks and the server answers; `ctx.save` becomes a mirror (§6.3).
 *
 * Each entry point below is the §8.1 row for it, in order:
 *   craft(recipeId)  the recipe exists, the station is near THE SERVER's position, the ingredients are
 *                    there and the skills allow it. Up to 4/s.
 *   useItem(id)      the item is owned and would do something (`itemUseEffect` decides both). 0.25 s apart.
 *   equip/unequip    `ownsEquip` and the right slot (`equipSlotOf`).
 *   learnSkill(id)   `skillPoint > 0` and the skill is below its maximum.
 *
 * The ingredient consumption is one transaction: everything is CHECKED first, then taken, with no yield in
 * between (§8.3). The client's version took the ingredients one by one and had no rollback, so a recipe that
 * failed halfway simply ate what it had already taken.
 *
 * Pure module: no Instances, no services, no os.clock. `dt` drives the cooldowns.
 */
import { CRAFT_RECIPES, CraftRecipe } from "shared/data/crafts";
import { SKILLS } from "shared/data/skills";
import { chance } from "shared/engine/rng";
import { countItem, addItem, removeItem } from "shared/sim/inventory";
import { querySolids, Solid, WorldData } from "shared/game/world";
import { equipSlotOf, ownsEquip, PlayerSaveData, SAVE_LIMITS } from "shared/game/save";
import { itemUseEffect, PlayerState } from "shared/game/player";
import { ServerBuild } from "./build";

/** the original's desk/fire reach (client/systems/craftSystem.ts) */
export const STATION_RANGE = 180;
/** §8.1: up to 4 crafts per second */
export const CRAFT_RATE = 4;
/** §8.1: a usable item every 0.25 s */
export const USE_COOLDOWN = 0.25;
/** skill index of "dwarf": a smelt sometimes yields double */
const SKILL_DWARF = 12;

export type CraftStation = "desk" | "pro" | "fire";

/** why an ask was refused, or what it produced */
export type BackpackOutcome =
	| { kind: "crafted"; recipe: number; count: number }
	| { kind: "holding"; placeable: number }
	| { kind: "used"; item: number }
	| { kind: "equipped"; equip: number; slot: number }
	| { kind: "unequipped"; slot: number }
	| { kind: "learned"; skill: number; level: number }
	| { kind: "refused"; why: "unknown" | "rate" | "station" | "ingredients" | "busy" | "owned" | "points" | "noop" };

function matchesStation(s: Solid, station: CraftStation): boolean {
	if (s.removed === true) return false;
	if (station === "desk") return s.tags === "craftdesk" || s.tags === "craftdesk_pro";
	if (station === "pro") return s.tags === "craftdesk_pro";
	return (s.tags === "brazier" && s.powered === true) || s.tags === "furnace";
}

/**
 * The station a survivor at (x, y) is standing near, or undefined. A pure version of the client's
 * `stationNear`, with its own scratch buffer per call rather than a module-level one — the client could get
 * away with a shared buffer because it had one player.
 */
export function stationNear(world: WorldData, x: number, y: number, station: CraftStation): Solid | undefined {
	const found = querySolids(
		world,
		x - STATION_RANGE,
		y - STATION_RANGE,
		x + STATION_RANGE,
		y + STATION_RANGE,
		new Array<Solid>(),
	);
	for (const s of found) {
		if (!matchesStation(s, station)) continue;
		const cx = math.clamp(x, s.x, s.x + s.w);
		const cy = math.clamp(y, s.y, s.y + s.h);
		const dx = x - cx;
		const dy = y - cy;
		if (dx * dx + dy * dy <= STATION_RANGE * STATION_RANGE) return s;
	}
	return undefined;
}

/** the recipe of an id (the array is dense, but never trust an index from the wire) */
export function recipeById(recipeId: number): CraftRecipe | undefined {
	const direct = CRAFT_RECIPES[recipeId];
	if (direct !== undefined && direct.id === recipeId) return direct;
	for (const r of CRAFT_RECIPES) {
		if (r.id === recipeId) return r;
	}
	return undefined;
}

/** one survivor's cooldowns */
interface Limits {
	craft: number;
	use: number;
}

export interface ServerCraftOptions {
	world: WorldData;
	/** where a craftKind-1 recipe's result goes: onto the cursor, not into the backpack */
	build: ServerBuild;
}

export class ServerCraft {
	private readonly world: WorldData;
	private readonly build: ServerBuild;
	private readonly limits = new Map<number, Limits>();

	constructor(options: ServerCraftOptions) {
		this.world = options.world;
		this.build = options.build;
	}

	/** decays the per-survivor cooldowns */
	step(dt: number): void {
		for (const [, l] of this.limits) {
			if (l.craft > 0) l.craft = math.max(0, l.craft - dt);
			if (l.use > 0) l.use = math.max(0, l.use - dt);
		}
	}

	remove(slot: number): void {
		this.limits.delete(slot);
	}

	// ---------------------------------------------------------------- craft (§8.1)

	craft(slot: number, state: PlayerState, save: PlayerSaveData, recipeId: number): BackpackOutcome {
		const l = this.limitsOf(slot);
		if (l.craft > 0) return { kind: "refused", why: "rate" };
		const r = recipeById(recipeId);
		if (r === undefined) return { kind: "refused", why: "unknown" };
		const blocked = this.blocker(slot, state, save, r);
		if (blocked !== undefined) return { kind: "refused", why: blocked };
		// nothing is consumed until `blocker` has said yes to ALL of it. Taking ingredient by ingredient and
		// giving up halfway is how the client's version ate a backpack for a craft that never happened.
		for (const ing of r.ingredients) removeItem(save, ing.kind, ing.index, ing.count);
		l.craft = 1 / CRAFT_RATE;
		if (r.craftKind === 1) {
			// a placeable goes on the cursor; server/sim/build.ts places it and refunds a cancel
			this.build.hold(slot, r.resultIndex, r.id);
			return { kind: "holding", placeable: r.resultIndex };
		}
		let count = r.resultCount;
		if (r.needsFire === true) {
			const dwarf = save.skillLevels[SKILL_DWARF] ?? 0;
			if (dwarf > 0 && chance(dwarf >= 2 ? 30 : 15)) count *= 2;
		}
		addItem(save, r.resultKind, r.resultIndex, count);
		return { kind: "crafted", recipe: r.id, count };
	}

	// ---------------------------------------------------------------- use, equip, learn (§8.1)

	useItem(slot: number, state: PlayerState, save: PlayerSaveData, usableId: number): BackpackOutcome {
		const l = this.limitsOf(slot);
		if (l.use > 0) return { kind: "refused", why: "rate" };
		if (state.dead) return { kind: "refused", why: "busy" };
		// `itemUseEffect` is the ownership check AND the "would this do anything?" check, and it is the same
		// function the single-player game used, applied to the SERVER's body
		if (!itemUseEffect(state, save, usableId)) return { kind: "refused", why: "noop" };
		l.use = USE_COOLDOWN;
		return { kind: "used", item: usableId };
	}

	equip(save: PlayerSaveData, equipId: number): BackpackOutcome {
		if (!ownsEquip(save, equipId)) return { kind: "refused", why: "owned" };
		const slotOf = equipSlotOf(equipId);
		if (slotOf === 1) save.equipCloth = equipId;
		else if (slotOf === 2) save.equipHand = equipId;
		else if (slotOf === 3) save.equipGun = equipId;
		else if (slotOf === 4) save.equipDeco = equipId;
		else return { kind: "refused", why: "unknown" };
		return { kind: "equipped", equip: equipId, slot: slotOf };
	}

	unequip(save: PlayerSaveData, equipSlot: number): BackpackOutcome {
		if (equipSlot === 1) save.equipCloth = -1;
		else if (equipSlot === 2) save.equipHand = -1;
		else if (equipSlot === 3) save.equipGun = -1;
		else if (equipSlot === 4) save.equipDeco = -1;
		else return { kind: "refused", why: "unknown" };
		return { kind: "unequipped", slot: equipSlot };
	}

	learnSkill(save: PlayerSaveData, skillId: number): BackpackOutcome {
		const def = SKILLS[skillId];
		if (def === undefined) return { kind: "refused", why: "unknown" };
		if (save.skillPoint <= 0) return { kind: "refused", why: "points" };
		const level = save.skillLevels[skillId] ?? 0;
		if (level >= def.maxLevel) return { kind: "refused", why: "noop" };
		save.skillLevels[skillId] = level + 1;
		save.skillPoint = math.clamp(save.skillPoint - 1, 0, SAVE_LIMITS.LEVEL_MAX);
		return { kind: "learned", skill: skillId, level: level + 1 };
	}

	/**
	 * THE single place that decides whether a recipe may be crafted (§8.1). Everything that can refuse a
	 * craft lives here and nowhere else — the rate limit above is the only exception, because it is about
	 * the client rather than the recipe.
	 *
	 * Keeping it one predicate is deliberate: a per-stage content lock ("this recipe is not unlocked yet")
	 * is then one line in this function, applying everywhere a craft can happen, instead of a check to
	 * remember in each caller. The client's `craftBlocker` is the same shape, for the same reason — it draws
	 * the greyed-out button; this one is what actually refuses.
	 *
	 * Returns the reason, or undefined when the craft may go ahead.
	 */
	blocker(
		slot: number,
		state: PlayerState,
		save: PlayerSaveData,
		r: CraftRecipe,
	): "busy" | "station" | "ingredients" | undefined {
		// one construction at a time, exactly like the client's `craftBlocker`
		if (this.build.placing(slot)) return "busy";
		if (!this.stationOk(state, r)) return "station";
		for (const ing of r.ingredients) {
			if (countItem(save, ing.kind, ing.index) < ing.count) return "ingredients";
		}
		return undefined;
	}

	// ---------------------------------------------------------------- internals

	/** §8.1: the station is checked at the SERVER's position, never at one the client claimed */
	private stationOk(state: PlayerState, r: CraftRecipe): boolean {
		if (r.needsPro) return stationNear(this.world, state.x, state.y, "pro") !== undefined;
		if (r.needsDesk) return stationNear(this.world, state.x, state.y, "desk") !== undefined;
		if (r.needsFire === true) return stationNear(this.world, state.x, state.y, "fire") !== undefined;
		return true;
	}

	private limitsOf(slot: number): Limits {
		let l = this.limits.get(slot);
		if (l === undefined) {
			l = { craft: 0, use: 0 };
			this.limits.set(slot, l);
		}
		return l;
	}
}
