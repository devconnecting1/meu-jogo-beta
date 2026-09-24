/*
 * `Intent` (C→S, reliable and ordered RemoteEvent): what a client may ASK for (docs/MULTIPLAYER.md §2.4, §4.1,
 * §8.1, §8.2). Re-exported by shared/net/protocol.ts, which is where every caller imports it from; it lives in a
 * file of its own because it is the smallest surface a client can push on and is reviewed on its own, and because
 * its range checks need the data tables, which protocol.ts has no registers left for (tools/check-registers.mjs).
 *
 * Two lengths, one header byte (PacketKind.Intent = 6 in the high nibble, as every binary packet but Input):
 *
 *   presence   2 B   kind, verb                                   EnterWorld, LeaveWorld
 *   backpack   8 B   kind, verb, atSeq u16, arg u16, nonce u16    Craft, UseItem, Equip, Unequip, LearnSkill,
 *                                                                 SwitchWeapon
 *
 * A decoder tells them apart by size, and anything else is malformed: a Craft packed as 2 bytes, an EnterWorld
 * padded to 8, a verb above SwitchWeapon, an `arg` outside the verb's table (`intentArgMax`), a trailing byte.
 *
 * Note what is NOT here. There is no `pickup(itemId)`, no `interact(solidId)`, no `place(x, y)` and no `reload`:
 * those ride the input command's own edges (§2.2 `edges`: attack, action, reload) and the server picks the target
 * itself, at the position it simulated (server/sim/interaction.ts, server/sim/build.ts). A verb that names a
 * target is a verb that can name the wrong one.
 *
 * Pure module: no Instances, no services. Both sides import it, so tools/test-net.mjs fuzzes it in Node.
 */
import { CRAFT_RECIPES } from "shared/data/crafts";
import * as Equips from "shared/data/equips";
import { SKILLS } from "shared/data/skills";
import { USABLES } from "shared/data/usables";
import { WEAPONS } from "shared/data/weapons";
import { NetReader, NetWriter, isFiniteNumber, wrapU16 } from "./codec";

/** the first byte of every Intent: PacketKind.Intent (6, shared/net/protocol.ts) in the high nibble */
export const INTENT_HEADER = 6 * 16;

export const IntentKind = {
	EnterWorld: 1,
	LeaveWorld: 2,
	/** F3, §8.1: arg = CRAFT_RECIPES id */
	Craft: 3,
	/** F3, §8.1: arg = USABLES id */
	UseItem: 4,
	/** F3, §8.1: arg = EQUIPS id */
	Equip: 5,
	/** F3, §8.1: arg = equipment slot 1..5 (`EquipSlot`: cloth, hand, gun, outfit, pet) */
	Unequip: 6,
	/** F3, §8.1: arg = SKILLS id */
	LearnSkill: 7,
	/** §8.1 `switchWeapon`: arg = WEAPONS id (the number keys, the hotbar, the Bag's Equip on a weapon) */
	SwitchWeapon: 8,
} as const;
export type IntentKind = (typeof IntentKind)[keyof typeof IntentKind];
const INTENT_KIND_MAX = 8;

/** presence verbs: kind + verb */
export const INTENT_BYTES = 2;
/** backpack verbs: kind, verb, atSeq u16, arg u16, nonce u16 */
export const INTENT_ARGS_BYTES = 8;
/** the first verb that carries arguments */
const INTENT_ARGS_FROM = 3;

/** a decoded intent: `arg`, `atSeq` and `nonce` are 0 for the two presence verbs */
export interface IntentMessage {
	kind: IntentKind;
	/**
	 * The `seq` of the FIRST command simulated with this change (§2.4): the server applies the verb right before it
	 * steps that command, so a switch and the shot after it land in the order the client predicted them. 0 when the
	 * sender did not say (applied on the next tick).
	 */
	atSeq: number;
	/** the verb's single argument — a recipe, a usable, an equipment, a slot, a skill or a weapon */
	arg: number;
	/**
	 * The client's own number for this ask (u16, wraps; 0 = none). The server hands the last one it HANDLED —
	 * applied or refused — back in the wallet's `bag.ack` (shared/game/save.ts), which is how the client knows which
	 * of its predictions to keep replaying and which the server has answered. It is only ever echoed: nothing on the
	 * server is decided by it.
	 */
	nonce: number;
}

/** is this one of the backpack verbs (as opposed to the two presence verbs)? */
export function isBackpackIntent(kind: number): boolean {
	return kind >= INTENT_ARGS_FROM && kind <= INTENT_KIND_MAX;
}

/**
 * The range of `arg` each backpack verb can mean, as [min, max], or undefined for a verb that takes none. The
 * decoder refuses anything outside it (§8.1: the argument is an index into a table the client does not own), so
 * the simulation never looks up an id that does not exist; ownership, counts and cooldowns are the server's next
 * question (server/sim/backpack.ts).
 */
export function intentArgRange(kind: number): [number, number] | undefined {
	if (kind === IntentKind.Craft) {
		// the recipe table is dense today; the range does not assume it
		let max = 0;
		for (const r of CRAFT_RECIPES) max = math.max(max, r.id);
		return [0, max];
	}
	if (kind === IntentKind.UseItem) return [0, USABLES.size() - 1];
	if (kind === IntentKind.Equip) return [0, Equips.EQUIPS.size() - 1];
	if (kind === IntentKind.Unequip) return [1, Equips.EQUIP_SLOT_MAX];
	if (kind === IntentKind.LearnSkill) return [0, SKILLS.size() - 1];
	if (kind === IntentKind.SwitchWeapon) return [0, WEAPONS.size() - 1];
	return undefined;
}

function argInRange(kind: number, arg: number): boolean {
	const range = intentArgRange(kind);
	return range !== undefined && arg >= range[0] && arg <= range[1];
}

export function encodeIntent(kind: IntentKind): buffer | undefined {
	if (isBackpackIntent(kind)) return undefined;
	const w = new NetWriter(INTENT_BYTES, INTENT_BYTES);
	w.u8(INTENT_HEADER);
	w.u8(kind);
	return w.finish();
}

/**
 * One of the backpack verbs, with its argument, the command it belongs to (§2.4) and the client's nonce.
 * Undefined for a presence verb or an argument outside the verb's range: the encoder refuses what the decoder
 * would refuse, so a bad call fails where it is made.
 */
export function encodeIntentArgs(kind: IntentKind, atSeq: number, arg: number, nonce = 0): buffer | undefined {
	if (!isBackpackIntent(kind)) return undefined;
	if (!isFiniteNumber(arg) || arg % 1 !== 0 || !argInRange(kind, arg)) return undefined;
	const w = new NetWriter(INTENT_ARGS_BYTES, INTENT_ARGS_BYTES);
	w.u8(INTENT_HEADER);
	w.u8(kind);
	w.u16(wrapU16(atSeq));
	w.u16(arg);
	w.u16(wrapU16(nonce));
	return w.finish();
}

/**
 * Undefined for anything that is not exactly one of the intents above (§8.1: never trust the client). Takes
 * `unknown` — whatever the remote handed over — and never throws.
 */
export function decodeIntentMessage(payload: unknown): IntentMessage | undefined {
	if (!typeIs(payload, "buffer")) return undefined;
	const len = buffer.len(payload);
	if (len !== INTENT_BYTES && len !== INTENT_ARGS_BYTES) return undefined;
	const r = new NetReader(payload);
	if (r.u8() !== INTENT_HEADER) return undefined;
	const kind = r.u8();
	if (kind < 1 || kind > INTENT_KIND_MAX) return undefined;
	if (len === INTENT_BYTES) {
		if (isBackpackIntent(kind) || !r.done()) return undefined;
		return { kind: kind as IntentKind, atSeq: 0, arg: 0, nonce: 0 };
	}
	if (!isBackpackIntent(kind)) return undefined;
	const atSeq = r.u16();
	const arg = r.u16();
	const nonce = r.u16();
	if (!r.done() || !argInRange(kind, arg)) return undefined;
	return { kind: kind as IntentKind, atSeq, arg, nonce };
}

/** the presence half of `decodeIntentMessage`, kept for server/net/mpHost.ts's EnterWorld/LeaveWorld handler */
export function decodeIntent(payload: unknown): IntentKind | undefined {
	const msg = decodeIntentMessage(payload);
	if (msg === undefined) return undefined;
	if (msg.kind !== IntentKind.EnterWorld && msg.kind !== IntentKind.LeaveWorld) return undefined;
	return msg.kind;
}
