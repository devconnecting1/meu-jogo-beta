/*
 * The backpack on THIS client from WORLD_SERVER_PHASE (docs/MULTIPLAYER.md §4.8, §6.3): the server owns it, this
 * client predicts its own verbs and reconciles with the server's bag. The Roblox glue around the pure rules of
 * client/net/bagPrediction.ts.
 *
 *   a verb      the Bag's Use / Equip / Unequip / Learn, a craft, the number keys: predicted at once on `ctx.save`
 *               (the same rule the server applies) and sent as an intent with a nonce (client/net/netClient.ts);
 *   a bag       the wallet's `bag` (client/systems/saveClient.ts hook): laid over `ctx.save`, and every prediction
 *               the server has not answered yet replayed on top (`rebase`);
 *   the cursor  a build edge takes the construction off the local cursor at once, and a bag written before the
 *               server consumed that command does not put it back;
 *   the reserve a predicted reload spends the local copy of the ammunition; for RESERVE_HOLD_S an older bag may
 *               lower it, never raise it back (the rounds are in the magazine already).
 *
 * Below WORLD_SERVER_PHASE, or with no MP host (single player, Studio without the host), every entry point falls back
 * to the local rule the game always had, and the systems never ask (client/net/authority.ts answers "no").
 */
import { MP_PHASE, WORLD_SERVER_PHASE } from "shared/net/mpConfig";
import { IntentKind } from "shared/net/protocol";
import { BagMirror, PlayerSaveData, readBag, setEquipped } from "shared/game/save";
import { itemUseEffect, PlayerState } from "shared/game/player";
import { setWorldAuthority } from "./authority";
import { BagCursor, BagEntry, EDGE_ENTRY, predictVerb, rebase } from "./bagPrediction";
import { netHosted, netNextSeq, netRefs, netSendBackpackIntent } from "./netClient";
import { currentSave, setBagHook } from "../systems/saveClient";

/** a predicted reload's rounds stay spent this long against a bag that does not have the server's reload yet */
const RESERVE_HOLD_S = 1;
/** how often the time-outs are looked at (a prediction the server never answered, a reserve hold running out) */
const EXPIRE_EVERY_S = 0.5;
/** predictions kept at most (the wire rate caps them far below this) */
const MAX_ENTRIES = 64;

const entries = new Array<BagEntry>();
/** the cursor when no run is bound (the lobby's wardrobe): nothing draws it */
const lobbyCursor: BagCursor = { pendingPlace: -1 };
let nonce = 0;
let lastBag: BagMirror | undefined;
let reserveHoldUntil = 0;
let started = false;

/** does the server own the backpack for this client right now? */
export function owned(): boolean {
	return MP_PHASE >= WORLD_SERVER_PHASE && netHosted();
}

function cursorFor(save: PlayerSaveData): BagCursor {
	const refs = netRefs();
	return refs !== undefined && refs.save === save ? refs : lobbyCursor;
}

/** one verb on the wire, remembered until the server answers it (the caller predicted it by the same rule) */
function transmit(kind: IntentKind, arg: number): boolean {
	nonce = (nonce % 65535) + 1;
	if (!netSendBackpackIntent(kind, netNextSeq(), arg, nonce)) return false;
	entries.push({ kind, arg, nonce, seq: 0, at: os.clock() });
	if (entries.size() > MAX_ENTRIES) entries.remove(0);
	return true;
}

/** predicted on `save` and sent; false (and nothing sent) when it would do nothing */
function predictAndSend(kind: IntentKind, arg: number, body?: PlayerState): boolean {
	const save = currentSave() ?? netRefs()?.save;
	if (save === undefined) return false;
	if (!predictVerb(save, cursorFor(save), kind, arg, body ?? netRefs()?.player)) return false;
	transmit(kind, arg);
	return true;
}

/** the server's bag over `save`, then what it has not answered yet */
function adopt(save: PlayerSaveData, now: number): void {
	const bag = lastBag;
	if (bag === undefined) return;
	const hold = now < reserveHoldUntil;
	const n = save.ammoNormal;
	const s = save.ammoShotgun;
	const m = save.ammoMachinegun;
	const a = save.ammoArrow;
	rebase(save, cursorFor(save), bag, entries, now);
	if (!hold) return;
	save.ammoNormal = math.min(save.ammoNormal, n);
	save.ammoShotgun = math.min(save.ammoShotgun, s);
	save.ammoMachinegun = math.min(save.ammoMachinegun, m);
	save.ammoArrow = math.min(save.ammoArrow, a);
}

// ---------------------------------------------------------------- the Bag's verbs (client/main.client.ts)

/** Use / Eat: predicted (one fewer; the hp and hunger come from the server's snapshot) and sent, or eaten locally */
export function useItem(body: PlayerState, save: PlayerSaveData, usableId: number): boolean {
	if (owned()) return predictAndSend(IntentKind.UseItem, usableId, body);
	return itemUseEffect(body, save, usableId);
}

/** Equip (the Bag and the wardrobe): the caller checked it is owned */
export function equip(save: PlayerSaveData, equipId: number, slot: number): boolean {
	if (owned()) return predictAndSend(IntentKind.Equip, equipId);
	return setEquipped(save, slot, equipId);
}

export function unequip(save: PlayerSaveData, slot: number): boolean {
	if (owned()) return predictAndSend(IntentKind.Unequip, slot);
	return setEquipped(save, slot, -1);
}

/** the Bag's Learn already applied the rule to `ctx.save` (client/ui/backpack.ts): only the server is left to tell */
export function learned(skillId: number): void {
	if (owned()) transmit(IntentKind.LearnSkill, skillId);
}

// ---------------------------------------------------------------- boot

/** once, at boot: the systems learn who owns the world, and the wallet's bag has somewhere to go */
export function start(): void {
	if (started) return;
	started = true;
	setWorldAuthority({
		owned,
		send: (kind, arg) => predictAndSend(kind as IntentKind, arg),
		buildEdge: () => {
			entries.push({ kind: EDGE_ENTRY, arg: 0, nonce: 0, seq: netNextSeq(), at: os.clock() });
			if (entries.size() > MAX_ENTRIES) entries.remove(0);
		},
		reserveSpent: () => {
			reserveHoldUntil = os.clock() + RESERVE_HOLD_S;
		},
	});
	setBagHook((save, raw) => {
		if (!owned()) return;
		const bag = readBag(raw);
		if (bag === undefined) return;
		lastBag = bag;
		adopt(save, os.clock());
	});
	// a prediction the server never answered, or a reserve hold that ran out, must not outlive its time-out when no
	// new bag comes to replace it: the last bag is laid down again
	let acc = 0;
	let held = false;
	game.GetService("RunService").Heartbeat.Connect(dt => {
		acc += dt;
		if (acc < EXPIRE_EVERY_S) return;
		acc = 0;
		const now = os.clock();
		const holding = now < reserveHoldUntil;
		const due = entries.size() > 0 || (held && !holding);
		held = holding;
		if (!due || lastBag === undefined || !owned()) return;
		const save = currentSave();
		if (save !== undefined) adopt(save, now);
	});
}
