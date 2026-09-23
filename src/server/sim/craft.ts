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
import { countItem, addItem, removeItem, unequipGone } from "shared/sim/inventory";
import * as Rule from "shared/sim/craftRule";
import type { CraftHeat } from "shared/sim/craftRule";
import { Solid, WorldData } from "shared/game/world";
import { equipSlotOf, ownsEquip, PlayerSaveData, SAVE_LIMITS, setEquipped } from "shared/game/save";
import { itemUseEffect, PlayerState } from "shared/game/player";
import { creditCraft } from "../save/achievements";
import { ServerBuild } from "./build";

/** the original's desk/fire reach: the shared rule's (shared/sim/craftRule.ts) */
export const STATION_RANGE = Rule.STATION_RANGE;
/** §8.1: up to 4 crafts per second */
export const CRAFT_RATE = 4;
/** §8.1: a usable item every 0.25 s */
export const USE_COOLDOWN = 0.25;

export type CraftStation = Rule.CraftStation;

/**
 * Why an ask was refused, or what it produced.
 *
 * A `crafted` outcome carries `heat`: "cook" for a cooking recipe (item_cook), "smelt" for a smelting one
 * (item_fire), undefined otherwise. It is the server-side event the Chef and Blacksmith achievements count
 * (`count` is what came out, Chef's or Dwarf's double included).
 */
export type BackpackOutcome =
	| { kind: "crafted"; recipe: number; count: number; heat: CraftHeat }
	| { kind: "holding"; placeable: number }
	| { kind: "used"; item: number }
	| { kind: "equipped"; equip: number; slot: number }
	| { kind: "unequipped"; slot: number }
	| { kind: "learned"; skill: number; level: number }
	| { kind: "switched"; weapon: number }
	| { kind: "delivered"; packs: number }
	| {
			kind: "refused";
			why:
				"unknown" | "rate" | "station" | "ingredients" | "busy" | "owned" | "points" | "noop" | "dead" | "full";
	  };

/**
 * The station a survivor at (x, y) is standing near, or undefined: the shared rule (shared/sim/craftRule.ts), the
 * true distance to the station's rectangle -- the same answer the client's Bag gets (QA D2). A fresh scratch array
 * per call: the server asks for several survivors.
 */
export function stationNear(world: WorldData, x: number, y: number, station: CraftStation): Solid | undefined {
	return Rule.stationNear(world, x, y, station);
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
	/**
	 * Where a craftKind-1 recipe's result goes: onto the cursor, not into the backpack. Undefined while the server
	 * does not own the interactive world (there is no world to place it in): the backpack verbs still work then
	 * (server/sim/backpack.ts), and a build recipe is refused before anything is spent.
	 */
	build?: ServerBuild;
}

export class ServerCraft {
	private readonly world: WorldData;
	private readonly build?: ServerBuild;
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

	/**
	 * Is this survivor's craft / use limit (§8.1: 4 crafts a second, a usable every 0.25 s) still running? The
	 * backpack asks BEFORE handing an intent over, and holds it until the limit has passed instead of refusing it:
	 * a double click on Eat is two cans, a quarter of a second apart, not one can and a prediction to undo.
	 */
	cooling(slot: number, what: "craft" | "use"): boolean {
		const l = this.limits.get(slot);
		if (l === undefined) return false;
		return (what === "craft" ? l.craft : l.use) > 0;
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
		// what the recipe ate may have been in the survivor's hands or on their back: it comes off in the same step
		// (the combat then finds the default blade in `weaponOf`, and banks the old magazine itself)
		unequipGone(save);
		l.craft = 1 / CRAFT_RATE;
		if (r.craftKind === 1 && this.build !== undefined) {
			// a placeable goes on the cursor; server/sim/build.ts places it and refunds a cancel
			this.build.hold(slot, r.resultIndex, r.id);
			return { kind: "holding", placeable: r.resultIndex };
		}
		// Chef now and then doubles a cooking, Dwarf a smelting: the shared rule, the client's prediction's too
		const count = Rule.craftYield(r, save);
		addItem(save, r.resultKind, r.resultIndex, count);
		const heat = Rule.craftHeat(r);
		// CON-04 / ITM-01: what a cooking made is Chef's, what a smelting made Blacksmith's -- counted where the server
		// crafts, from the recipe's own heat
		creditCraft(save, heat, count);
		return { kind: "crafted", recipe: r.id, count, heat };
	}

	// ---------------------------------------------------------------- use, equip, learn (§8.1)

	useItem(slot: number, state: PlayerState, save: PlayerSaveData, usableId: number): BackpackOutcome {
		const l = this.limitsOf(slot);
		if (l.use > 0) return { kind: "refused", why: "rate" };
		// a body at 0 hp IS dead, even before the next `stepPlayer` flags it (the rule of life.ts `writeRunBody`): a
		// bite lands in the horde's half of a tick, and a bandage queued for the next one must not revive the corpse
		if (state.dead || state.hp <= 0) return { kind: "refused", why: "dead" };
		// `itemUseEffect` is the ownership check AND the "would this do anything?" check, and it is the same
		// function the single-player game used, applied to the SERVER's body
		if (!itemUseEffect(state, save, usableId)) return { kind: "refused", why: "noop" };
		l.use = USE_COOLDOWN;
		return { kind: "used", item: usableId };
	}

	/** MON-04 included: an outfit or a pet is equipped only if `ownsEquip` (costume bought, or pack-delivered) */
	equip(save: PlayerSaveData, equipId: number): BackpackOutcome {
		if (!ownsEquip(save, equipId)) return { kind: "refused", why: "owned" };
		const slotOf = equipSlotOf(equipId);
		if (!setEquipped(save, slotOf, equipId)) return { kind: "refused", why: "unknown" };
		return { kind: "equipped", equip: equipId, slot: slotOf };
	}

	unequip(save: PlayerSaveData, equipSlot: number): BackpackOutcome {
		if (!setEquipped(save, equipSlot, -1)) return { kind: "refused", why: "unknown" };
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
		// a construction needs a world to be placed in: without the server's (below WORLD_SERVER_PHASE) it is refused
		// here, before anything is spent
		if (r.craftKind === 1 && this.build === undefined) return "station";
		// one construction at a time, exactly like the client's `craftBlocker`
		if (this.build?.placing(slot) === true) return "busy";
		if (!this.stationOk(state, r)) return "station";
		for (const ing of r.ingredients) {
			if (countItem(save, ing.kind, ing.index) < ing.count) return "ingredients";
		}
		return undefined;
	}

	// ---------------------------------------------------------------- internals

	/** §8.1: the station is checked at the SERVER's position, never at one the client claimed */
	private stationOk(state: PlayerState, r: CraftRecipe): boolean {
		return Rule.stationOk(this.world, state.x, state.y, r);
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
