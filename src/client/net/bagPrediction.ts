/*
 * The client's prediction of its own backpack, and the rebase on the server's bag (docs/MULTIPLAYER.md §4.8, §6.3).
 *
 * From WORLD_SERVER_PHASE the backpack is the server's: a verb (switch, use, equip, unequip, learn, craft) goes out
 * as an intent and the server's copy comes back in the wallet's `bag`. The Bag would feel dead if every click waited
 * a round trip, so the client applies its own verb at once — the SAME rule the server will apply — and keeps it on a
 * list. Every bag that arrives is laid over the local copy, and what the server has not answered yet (its nonce is
 * newer than `bag.ack`) is replayed on top, in the order it was made. A verb the server refused simply is not in
 * the next bag and falls off the list with its nonce; one it never answers falls off after PENDING_TTL_S.
 *
 * The build edges get the same treatment keyed by COMMAND seq: placing or cancelling takes the construction off the
 * local cursor at once, and a bag written before the server consumed that command (`bag.seq`) does not put it back.
 *
 * Vitals are NOT predicted: eating predicts one fewer can, and the hp and hunger come from the snapshot's self block,
 * which is the server's every 50 ms — a predicted heal would only flicker between the two.
 *
 * Pure module: no Instances, no services. tools/test-items.mjs drives it against the real server.
 */
import { CRAFT_RECIPES, CraftRecipe } from "shared/data/crafts";
import { SKILLS } from "shared/data/skills";
import { seqDiff } from "shared/net/codec";
import { IntentKind } from "shared/net/intentWire";
import { applyBag, BagMirror, equipSlotOf, ownsEquip, ownsWeapon, PlayerSaveData, setEquipped } from "shared/game/save";
import { itemUseWouldWork, PlayerState } from "shared/game/player";
import { addItem, countItem, removeItem, unequipGone } from "shared/sim/inventory";

/** the build cursor the prediction writes: GameRefs' `pendingPlace` / `pendingRecipe` */
export interface BagCursor {
	pendingPlace: number;
	pendingRecipe?: number;
}

/** an entry that is not a verb: a build edge took the construction off the local cursor */
export const EDGE_ENTRY = 0;

/** one prediction still waiting for the server */
export interface BagEntry {
	/** IntentKind of a verb, or EDGE_ENTRY */
	kind: number;
	arg: number;
	/** the verb's nonce (0 for an edge) */
	nonce: number;
	/** the command an edge rode on (0 for a verb) */
	seq: number;
	/** when it was made (os.clock()), for PENDING_TTL_S */
	at: number;
}

/** a prediction the server never answered is dropped after this long, and the server's bag stands */
export const PENDING_TTL_S = 3;

function recipeById(id: number): CraftRecipe | undefined {
	const direct = CRAFT_RECIPES[id];
	if (direct !== undefined && direct.id === id) return direct;
	for (const r of CRAFT_RECIPES) {
		if (r.id === id) return r;
	}
	return undefined;
}

/**
 * One verb, applied to this client's copy the way the server will apply it (server/sim/backpack.ts, craft.ts).
 * False when it would do nothing — then the caller sends nothing. `body` is the survivor, for UseItem's "would it do
 * anything" (no vitals are touched). `replay` is a rebase: the checks that belong to the moment of the click (the
 * body, the station, the cursor being free) were made then and are not asked again of a later state.
 */
export function predictVerb(
	save: PlayerSaveData,
	cursor: BagCursor,
	kind: number,
	arg: number,
	body?: PlayerState,
	replay = false,
): boolean {
	if (kind === IntentKind.SwitchWeapon) {
		if (!ownsWeapon(save, arg)) return false;
		// the server refuses it (`busy`, `dead`): predicted, the hand would switch and then be switched back with an
		// empty magazine (correctness review of 5967a18, E)
		if (!replay && (cursor.pendingPlace >= 0 || (body !== undefined && (body.dead || body.hp <= 0)))) return false;
		save.equipWeapon = arg;
		return true;
	}
	if (kind === IntentKind.UseItem) {
		if ((save.invenUse[arg] ?? 0) <= 0) return false;
		if (!replay && body !== undefined && (body.dead || body.hp <= 0)) return false;
		if (!replay && body !== undefined && !itemUseWouldWork(body, save, arg)) return false;
		save.invenUse[arg] = (save.invenUse[arg] ?? 0) - 1;
		return true;
	}
	if (kind === IntentKind.Equip) {
		if (!ownsEquip(save, arg)) return false;
		return setEquipped(save, equipSlotOf(arg), arg);
	}
	if (kind === IntentKind.Unequip) return setEquipped(save, arg, -1);
	if (kind === IntentKind.LearnSkill) {
		const def = SKILLS[arg];
		const level = save.skillLevels[arg] ?? 0;
		if (def === undefined || save.skillPoint <= 0 || level >= def.maxLevel) return false;
		save.skillLevels[arg] = level + 1;
		save.skillPoint -= 1;
		return true;
	}
	if (kind === IntentKind.Craft) {
		const r = recipeById(arg);
		if (r === undefined) return false;
		if (!replay && r.craftKind === 1 && cursor.pendingPlace >= 0) return false;
		for (const ing of r.ingredients) {
			if (countItem(save, ing.kind, ing.index) < ing.count) return false;
		}
		for (const ing of r.ingredients) removeItem(save, ing.kind, ing.index, ing.count);
		unequipGone(save);
		if (r.craftKind === 1) {
			cursor.pendingPlace = r.resultIndex;
			cursor.pendingRecipe = r.id;
		} else {
			// (the Dwarf's double smelt is the server's dice: the bag brings it)
			addItem(save, r.resultKind, r.resultIndex, r.resultCount);
		}
		return true;
	}
	return false;
}

/** has the server answered this entry in `bag`? A verb by its nonce, an edge by the command it rode on */
export function answered(e: BagEntry, bag: BagMirror): boolean {
	if (e.kind === EDGE_ENTRY) return bag.seq >= 0 && seqDiff(e.seq, bag.seq) <= 0;
	return bag.ack !== 0 && seqDiff(e.nonce, bag.ack) <= 0;
}

/**
 * The server's bag over this client's copy, then every prediction it has not answered yet on top, in the order they
 * were made. `entries` loses what `bag` answered and what timed out.
 */
export function rebase(
	save: PlayerSaveData,
	cursor: BagCursor,
	bag: BagMirror,
	entries: Array<BagEntry>,
	now: number,
): void {
	applyBag(save, bag);
	cursor.pendingPlace = bag.place;
	cursor.pendingRecipe = undefined;
	for (let i = entries.size() - 1; i >= 0; i--) {
		const e = entries[i];
		if (answered(e, bag) || now - e.at > PENDING_TTL_S) entries.remove(i);
	}
	for (const e of entries) {
		if (e.kind === EDGE_ENTRY) {
			cursor.pendingPlace = -1;
			cursor.pendingRecipe = undefined;
		} else {
			predictVerb(save, cursor, e.kind, e.arg, undefined, true);
		}
	}
}
