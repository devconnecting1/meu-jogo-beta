/*
 * The pure half of the backpack verbs' C→S path (docs/MULTIPLAYER.md §4.8, §8.1, §8.2): the token bucket, the
 * malformed window and the one thing the server does with a verb out of the world. No Instances, no services and no
 * server/sim imports — tools/test-net.mjs loads it with the protocol and fuzzes it; server/net/backpackIntents.ts is
 * the Roblox glue around it.
 */
import { EquipSlot } from "shared/data/equips";
import { FLOOD_MALFORMED, FLOOD_MALFORMED_WINDOW_S, INTENT_BURST, INTENT_RATE } from "shared/net/mpConfig";
import { IntentKind, IntentMessage, decodeIntentMessage, isBackpackIntent } from "shared/net/protocol";
import { equipSlotOf, ownsEquip, PlayerSaveData, setEquipped } from "shared/game/save";

/** one connection's limits for the backpack verbs (§8.2), and its counters for the admin panel (§9.3) */
export interface IntentGate {
	tokens: number;
	at: number;
	/** malformed payloads in the current window (a player not in the world has no ServerPlayer to count them) */
	badStart: number;
	badCount: number;
	accepted: number;
	rateDropped: number;
	malformed: number;
}

export function newIntentGate(now: number): IntentGate {
	return { tokens: INTENT_BURST, at: now, badStart: now, badCount: 0, accepted: 0, rateDropped: 0, malformed: 0 };
}

export const IntentVerdict = {
	/** decoded, inside the bucket: hand it over */
	Ok: 0,
	/** the bucket is empty: dropped (the nonce, if it decoded, is still acknowledged) */
	Rate: 1,
	/** not an intent at all (§8.1) */
	Malformed: 2,
	/** EnterWorld / LeaveWorld: server/net/mpHost.ts's, not ours */
	Presence: 3,
} as const;
export type IntentVerdict = (typeof IntentVerdict)[keyof typeof IntentVerdict];

export interface IntentResult {
	verdict: IntentVerdict;
	/** the decoded verb (Ok, and Rate when it decoded) */
	msg?: IntentMessage;
}

/**
 * The whole C→S check of one Intent payload, with no Roblox in it. `payload` is whatever the remote handed over —
 * a table, a string, a 1000-byte blob — and this never throws. A presence verb is left alone (and costs nothing
 * here: mpHost has its own limit for it); everything else takes a token first, so a flood costs one subtraction a
 * message whatever it carries.
 */
export function ingestBackpackIntent(gate: IntentGate, payload: unknown, now: number): IntentResult {
	const msg = decodeIntentMessage(payload);
	if (msg !== undefined && !isBackpackIntent(msg.kind)) return { verdict: IntentVerdict.Presence };
	const elapsed = now - gate.at;
	if (elapsed > 0) gate.tokens = math.min(INTENT_BURST, gate.tokens + elapsed * INTENT_RATE);
	// a clock that went backwards restarts the bucket rather than stalling it
	gate.at = now;
	if (gate.tokens < 1) {
		gate.rateDropped += 1;
		return { verdict: IntentVerdict.Rate, msg };
	}
	gate.tokens -= 1;
	if (msg === undefined) {
		gate.malformed += 1;
		if (now - gate.badStart >= FLOOD_MALFORMED_WINDOW_S || now < gate.badStart) {
			gate.badStart = now;
			gate.badCount = 0;
		}
		gate.badCount += 1;
		return { verdict: IntentVerdict.Malformed };
	}
	gate.accepted += 1;
	return { verdict: IntentVerdict.Ok, msg };
}

/** §8.2's malformed limit, for a connection that has no ServerPlayer to count it (not in the world) */
export function malformedFlood(gate: IntentGate): boolean {
	return gate.badCount > FLOOD_MALFORMED;
}

/**
 * The lobby's wardrobe (MON-04), out of the world: a cosmetic slot equipped or cleared on the session's save. Only
 * the outfit and the pet — they change what the others SEE and nothing that happens in a night (MON-01) — and only
 * with something the server says is theirs (`ownsEquip`: a bought costume, or a pack's pet in the server's
 * inventory). True when the save changed. Anything else (armour, a gadget, a skill, a meal, a craft, a weapon) needs
 * the body in the world, and is refused.
 */
export function applyOutOfWorld(save: PlayerSaveData, msg: IntentMessage): boolean {
	if (msg.kind === IntentKind.Equip) {
		const slot = equipSlotOf(msg.arg);
		if (slot !== EquipSlot.Outfit && slot !== EquipSlot.Pet) return false;
		if (!ownsEquip(save, msg.arg)) return false;
		return setEquipped(save, slot, msg.arg);
	}
	if (msg.kind === IntentKind.Unequip) {
		if (msg.arg !== EquipSlot.Outfit && msg.arg !== EquipSlot.Pet) return false;
		return setEquipped(save, msg.arg, -1);
	}
	return false;
}
