/*
 * "The survivor picked something up": the pickup sound (client/audio/gameAudio.ts) and the "Pick something up" lesson
 * (client/onboarding/objectives.ts) both hang on this count, and on nothing else.
 *
 * They used to watch the backpack grow. From WORLD_SERVER_PHASE the backpack is the server's and this client's copy
 * is its bag plus the predictions it has not answered yet (client/net/backpackSync.ts), and that copy grows for other
 * reasons than a pickup: a Chef's or a Dwarf's double coming back after the predicted single, a prediction the server
 * refused or that timed out being undone, a construction handed back on a cancel, a shop pack delivered. Each one
 * played the pickup sound, and each one could tick the lesson off.
 *
 * Nothing on the wire says "you picked X up" (docs/MULTIPLAYER.md §8.1: the E press rides the input command, and the
 * server answers with the world and the bag), so a pickup is read off what the server DID send, three facts that
 * only a pickup of this survivor's own gives together within PICKUP_WINDOW_S:
 *   1. this survivor's E press reached a ground item, or a building flagged as holding loot (`pressed`, from
 *      client/systems/interaction.ts: what the same target query answers here);
 *   2. the server then took a ground item within reach of where they pressed out of the world (`itemGone`, the
 *      ItemRemove delta), or took that building's loot flag down (`lootGone`, the LootFlag delta) -- client/net/
 *      worldMirror.ts;
 *   3. and the server's own bag grew, bag to bag, never the predicted copy (`bagGrew`, client/net/backpackSync.ts).
 * A refund, a bonus or an undone prediction has no (2); somebody else's pickup of the same item has no (3).
 *
 * Offline (no MP host, or below WORLD_SERVER_PHASE) the client's own interaction takes the item and says so directly
 * (`took`). Pure: no Instances, no services but os.clock.
 */
import { ItemKind } from "shared/data/kinds";
import { useSoundOf } from "shared/data/usables";
import { DESIGN } from "shared/engine/constants";

/** how long after the press the server's answer may take to arrive (a pickup on a 1 s round trip still counts) */
const PICKUP_WINDOW_S = 2;
/** how far from the press point an item the server removed may have lain: the server's reach, plus the drift */
const PICKUP_REACH = DESIGN.ITEM_GET_DISTANCE + 60;

/**
 * What the last pickup was, for its sound (client/audio/gameAudio.ts): ammo (and arrows and oil), food, a material,
 * or anything else -- gear, a device, a medicine, a searched building's mixed loot.
 */
export type PickupKind = "item" | "ammo" | "food" | "material";

/** ETC items 44..48: normal, shotgun and machine-gun ammo, arrows, oil (shared/sim/inventory.ts keeps them apart) */
const ETC_AMMO_FIRST = 44;
const ETC_AMMO_LAST = 48;
/** ETC items 23..37, 41 and 43: wood, stone, steel, gold, parts, battery, bulb, gunpowder, cloth, chip, leather... */
const ETC_MATERIAL_FIRST = 23;
const ETC_MATERIAL_LAST = 37;
const ETC_LEATHER = 41;
const ETC_RADIOACTIVE = 43;

/** what a ground item of `kind` / `itemId` sounds like when it goes into the bag */
export function pickupKindOf(kind: number | undefined, itemId: number | undefined): PickupKind {
	if (kind === undefined || itemId === undefined) return "item";
	if (kind === ItemKind.Use) return useSoundOf(itemId) === "useEat" ? "food" : "item";
	if (kind !== ItemKind.Etc) return "item";
	if (itemId >= ETC_AMMO_FIRST && itemId <= ETC_AMMO_LAST) return "ammo";
	if (itemId >= ETC_MATERIAL_FIRST && itemId <= ETC_MATERIAL_LAST) return "material";
	if (itemId === ETC_LEATHER || itemId === ETC_RADIOACTIVE) return "material";
	return "item";
}

let count = 0;
let lastKind: PickupKind = "item";
/** the E press waiting for the server's answer: "item", "loot", or "" for none */
let waiting = "";
let pressAt = 0;
let pressX = 0;
let pressY = 0;
let gone = false;
let grew = false;
/** what the ground item the server took away was (ItemRemove), until the pickup settles */
let goneKind: PickupKind = "item";

/** pickups so far, this session: a reader compares it with the value it last saw */
export function pickupCount(): number {
	return count;
}

/** what the last counted pickup was (read together with pickupCount) */
export function lastPickupKind(): PickupKind {
	return lastKind;
}

/**
 * The client's own game took something from the ground or a building (offline: nobody else decides). `kind` /
 * `itemId`: the ground item's, for its sound; a building's loot is a mix and says nothing.
 */
export function took(kind?: number, itemId?: number): void {
	count += 1;
	lastKind = pickupKindOf(kind, itemId);
}

/**
 * The survivor pressed E at (x, y) and, as far as this client sees, it reached a ground item (`kind` "item") or a
 * building that holds loot ("loot"). Server-owned world only: the answer comes back as world deltas and a bag.
 */
export function pressed(kind: "item" | "loot", x: number, y: number): void {
	waiting = kind;
	pressAt = os.clock();
	pressX = x;
	pressY = y;
	gone = false;
	grew = false;
	goneKind = "item";
}

/**
 * The server took the ground item that lay at (x, y) out of the world (ItemRemove). `kind` / `itemId`: what it was, so
 * the pickup is heard as what it is (ammo, food, a material).
 */
export function itemGone(x: number, y: number, kind?: number, itemId?: number): void {
	if (waiting !== "item" || !fresh()) return;
	const dx = x - pressX;
	const dy = y - pressY;
	if (dx * dx + dy * dy > PICKUP_REACH * PICKUP_REACH) return;
	gone = true;
	goneKind = pickupKindOf(kind, itemId);
	settle();
}

/** the server took down the loot flag of the building this survivor stands in (LootFlag, hasLoot false) */
export function lootGone(): void {
	if (waiting !== "loot" || !fresh()) return;
	gone = true;
	goneKind = "item";
	settle();
}

/** the server's bag arrived bigger than the one before it (the predicted copy is not asked) */
export function bagGrew(): void {
	if (waiting === "" || !fresh()) return;
	grew = true;
	settle();
}

function fresh(): boolean {
	if (os.clock() - pressAt <= PICKUP_WINDOW_S) return true;
	waiting = "";
	return false;
}

function settle(): void {
	if (!gone || !grew) return;
	count += 1;
	lastKind = goneKind;
	waiting = "";
}
