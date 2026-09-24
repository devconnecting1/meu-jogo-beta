/*
 * "The survivor picked something up": the pickup sound (client/audio/gameAudio.ts), the "Pick something up" lesson
 * (client/onboarding/objectives.ts) and the pickup feedback -- the "+12 Shotgun ammo" chip over the prompt and the Bag
 * button's flash (client/ui/pickupToast.ts, DESIGN_RULES ITM-07) -- all hang on this module, and on nothing else.
 *
 * They used to watch the backpack grow. From WORLD_SERVER_PHASE the backpack is the server's and this client's copy
 * is its bag plus the predictions it has not answered yet (client/net/backpackSync.ts), and that copy grows for other
 * reasons than a pickup: a Chef's or a Dwarf's double coming back after the predicted single, a prediction the server
 * refused or that timed out being undone, a construction handed back on a cancel, a shop pack delivered. Each one
 * played the pickup sound, and each one could tick the lesson off.
 *
 * Nothing on the wire says "you picked X up" (docs/MULTIPLAYER.md §8.1: the E press rides the input command, the
 * walk-over is the server's own sweep, and the server answers with the world and the bag), so a pickup is read off
 * what the server DID send, facts that only a pickup of this survivor's own gives together within PICKUP_WINDOW_S:
 *   1. the item was THIS survivor's to take: their E press reached a ground item or a building flagged as holding loot
 *      (`pressed`, from client/systems/interaction.ts: what the same target query answers here), or it was a supply
 *      under their feet (shared/sim/pickupRule.ts `walkPickup`, within WALK_PICKUP_RANGE and the drift of where this
 *      client draws them, `survivorAt`);
 *   2. the server then took that ground item out of the world, or some of it (`itemGone`, from the ItemRemove delta,
 *      or an ItemAdd that lowered its count -- client/net/worldMirror.ts), or took that building's loot flag down
 *      (`lootGone`, the LootFlag delta);
 *   3. and the server's own bag grew, bag to bag, never the predicted copy (`bagGrew`, client/net/backpackSync.ts) --
 *      in THAT item, by the two bags: the "+12" is what the server put in, not what lay on the ground.
 * A refund, a bonus or an undone prediction has no (2); somebody else's pickup of the same item has no (3).
 *
 * Offline (no MP host, or below WORLD_SERVER_PHASE) the client's own interaction takes the item and says so directly
 * (`took`). Pure: no Instances, no services but os.clock.
 */
import { DESIGN } from "shared/engine/constants";
import type { BagMirror } from "shared/game/save";
import { walkPickup, WALK_PICKUP_RANGE } from "shared/sim/pickupRule";

/** how long after the press the server's answer may take to arrive (a pickup on a 1 s round trip still counts) */
const PICKUP_WINDOW_S = 2;
/** how far from the press point an item the server removed may have lain: the server's reach, plus the drift */
const PICKUP_REACH = DESIGN.ITEM_GET_DISTANCE + 60;
/** how far from where this client draws the survivor a walked-up supply may have lain: its reach, plus the drift */
const WALK_REACH = WALK_PICKUP_RANGE + 60;
/** at most this many items waiting for the bag, and feedback lines waiting for the HUD */
const PENDING_MAX = 8;
const FEEDBACK_MAX = 8;

/** one line of feedback: what came into the backpack */
export interface PickupNote {
	kind: number;
	itemId: number;
	count: number;
}

/** an item that left the world for this survivor, waiting for the bag that proves it */
interface Pending {
	kind: number;
	itemId: number;
	count: number;
	at: number;
}

let count = 0;
/** the E press waiting for the server's answer: "item", "loot", or "" for none */
let waiting = "";
let pressAt = 0;
let pressX = 0;
let pressY = 0;
/** where this client draws the survivor now (interaction.ts, every frame): the walk-over's owner */
let meX = math.huge;
let meY = math.huge;
/** items gone for this survivor, oldest first */
const pending = new Array<Pending>();
/** the loot flag went down for this survivor's search: the whole next growth of the bag is the search's */
let lootAt = -math.huge;
/**
 * The last growth of the server's bag, for an ItemRemove that comes after it: per item, what came in and is not yet
 * claimed ("any": a caller that did not hand the bags over, which counts every item it meets).
 */
let grownAt = -math.huge;
let grown: Map<number, number> | "any" = "any";
const notes = new Array<PickupNote>();

/** pickups so far, this session: a reader compares it with the value it last saw */
export function pickupCount(): number {
	return count;
}

/** the feedback lines since the last call, oldest first, moved into `out` (the HUD drains it every frame) */
export function takePickupNotes(out: Array<PickupNote>): Array<PickupNote> {
	for (const n of notes) out.push(n);
	notes.clear();
	return out;
}

function note(kind: number, itemId: number, n: number): void {
	if (n <= 0) return;
	// the same item twice in a row is one line: a pile of wood walked up is "+12 Wood", not twelve lines
	const last = notes[notes.size() - 1];
	if (last !== undefined && last.kind === kind && last.itemId === itemId) {
		last.count += n;
		return;
	}
	if (notes.size() >= FEEDBACK_MAX) notes.remove(0);
	notes.push({ kind, itemId, count: n });
}

/**
 * The client's own game took something from the ground or a building (offline: nobody else decides). With the item,
 * its feedback line too.
 */
export function took(kind?: number, itemId?: number, n = 1): void {
	count += 1;
	if (kind !== undefined && itemId !== undefined) note(kind, itemId, n);
}

/** a line of feedback without a pickup of its own: the rest of an offline search (one search is one pickup) */
export function gained(kind: number, itemId: number, n: number): void {
	note(kind, itemId, n);
}

/** where this client draws the local survivor (interaction.ts, every frame) */
export function survivorAt(x: number, y: number): void {
	meX = x;
	meY = y;
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
}

function near(x: number, y: number, ax: number, ay: number, r: number): boolean {
	const dx = x - ax;
	const dy = y - ay;
	return dx * dx + dy * dy <= r * r;
}

/**
 * The server took `n` of the ground item that lay at (x, y) out of the world (ItemRemove, or an ItemAdd that lowered
 * its count: the save's ceiling let only part of it in). Whose it was: the E press's, or this survivor's feet's.
 */
export function itemGone(x: number, y: number, kind = -1, itemId = -1, n = 1): void {
	const now = os.clock();
	const byPress = waiting === "item" && now - pressAt <= PICKUP_WINDOW_S && near(x, y, pressX, pressY, PICKUP_REACH);
	const byFeet = kind >= 0 && walkPickup(kind, itemId) && near(x, y, meX, meY, WALK_REACH);
	if (!byPress && !byFeet) {
		if (waiting !== "" && now - pressAt > PICKUP_WINDOW_S) waiting = "";
		return;
	}
	if (byPress) waiting = "";
	// the bag may have come first (the other order): what it brought for this item settles it now
	if (now - grownAt <= PICKUP_WINDOW_S && claim(kind, itemId, n)) return;
	if (pending.size() >= PENDING_MAX) pending.remove(0);
	pending.push({ kind, itemId, count: n, at: now });
}

/** the server took down the loot flag of the building this survivor stands in (LootFlag, hasLoot false) */
export function lootGone(): void {
	const now = os.clock();
	if (waiting !== "loot" || now - pressAt > PICKUP_WINDOW_S) return;
	waiting = "";
	// the bag may have come first: then that growth was the search
	if (now - grownAt <= PICKUP_WINDOW_S && grown !== "any" && grown.size() > 0) {
		count += 1;
		for (const [key, v] of grown) noteKey(key, v);
		grown.clear();
		return;
	}
	if (now - grownAt <= PICKUP_WINDOW_S && grown === "any") {
		count += 1;
		grownAt = -math.huge;
		return;
	}
	lootAt = now;
}

/** the key of an item in the bags' diff: kind and id as one number (ids stay far below 1000) */
function keyOf(kind: number, itemId: number): number {
	return kind * 1000 + itemId;
}

function noteKey(key: number, n: number): void {
	note(math.floor(key / 1000), key % 1000, n);
}

/** an item gone for this survivor meets the bag's growth: true (and counted) when the bag holds some of it */
function claim(kind: number, itemId: number, n: number): boolean {
	if (grown === "any") {
		count += 1;
		note(kind, itemId, n);
		return true;
	}
	const key = keyOf(kind, itemId);
	const got = grown.get(key) ?? 0;
	if (got <= 0) return false;
	const taken = math.min(got, math.max(n, 1));
	if (got - taken > 0) grown.set(key, got - taken);
	else grown.delete(key);
	count += 1;
	note(kind, itemId, taken);
	return true;
}

/** what `after` holds of each item more than `before` (ammunition and oil by their ETC ids, 44-48) */
function diff(before: BagMirror, after: BagMirror): Map<number, number> {
	const out = new Map<number, number>();
	const each = (kind: number, a: ReadonlyArray<number>, b: ReadonlyArray<number>): void => {
		for (let i = 0; i < b.size(); i++) {
			const d = (b[i] ?? 0) - (a[i] ?? 0);
			if (d > 0) out.set(keyOf(kind, i), d);
		}
	};
	each(1, before.invenWeapon, after.invenWeapon);
	each(2, before.invenEquip, after.invenEquip);
	each(3, before.invenUse, after.invenUse);
	each(4, before.invenEtc, after.invenEtc);
	for (let i = 0; i < 5; i++) {
		const d = (after.ammo[i] ?? 0) - (before.ammo[i] ?? 0);
		if (d > 0) out.set(keyOf(4, 44 + i), d);
	}
	return out;
}

/**
 * The server's bag arrived bigger than the one before it (the predicted copy is not asked). With the two bags, what
 * grew in which item; without them (an older caller), any item gone for this survivor counts whole.
 */
export function bagGrew(before?: BagMirror, after?: BagMirror): void {
	const now = os.clock();
	grown = before !== undefined && after !== undefined ? diff(before, after) : "any";
	grownAt = now;
	// a search whose flag already went down: this growth is what it found
	if (now - lootAt <= PICKUP_WINDOW_S) {
		lootAt = -math.huge;
		count += 1;
		if (grown !== "any") {
			for (const [key, v] of grown) noteKey(key, v);
			grown.clear();
		} else {
			grownAt = -math.huge;
		}
		return;
	}
	// the items already gone for this survivor, oldest first
	let i = 0;
	while (i < pending.size()) {
		const p = pending[i];
		if (now - p.at > PICKUP_WINDOW_S) {
			pending.remove(i);
			continue;
		}
		if (claim(p.kind, p.itemId, p.count)) {
			pending.remove(i);
			if (grown === "any") grownAt = -math.huge;
			continue;
		}
		i += 1;
	}
}
