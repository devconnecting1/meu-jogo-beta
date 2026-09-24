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
import { DESIGN } from "shared/engine/constants";

/** how long after the press the server's answer may take to arrive (a pickup on a 1 s round trip still counts) */
const PICKUP_WINDOW_S = 2;
/** how far from the press point an item the server removed may have lain: the server's reach, plus the drift */
const PICKUP_REACH = DESIGN.ITEM_GET_DISTANCE + 60;

let count = 0;
/** the E press waiting for the server's answer: "item", "loot", or "" for none */
let waiting = "";
let pressAt = 0;
let pressX = 0;
let pressY = 0;
let gone = false;
let grew = false;

/** pickups so far, this session: a reader compares it with the value it last saw */
export function pickupCount(): number {
	return count;
}

/** the client's own game took something from the ground or a building (offline: nobody else decides) */
export function took(): void {
	count += 1;
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
}

/** the server took the ground item that lay at (x, y) out of the world (ItemRemove) */
export function itemGone(x: number, y: number): void {
	if (waiting !== "item" || !fresh()) return;
	const dx = x - pressX;
	const dy = y - pressY;
	if (dx * dx + dy * dy > PICKUP_REACH * PICKUP_REACH) return;
	gone = true;
	settle();
}

/** the server took down the loot flag of the building this survivor stands in (LootFlag, hasLoot false) */
export function lootGone(): void {
	if (waiting !== "loot" || !fresh()) return;
	gone = true;
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
	waiting = "";
}
