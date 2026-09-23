/*
 * The backpack verbs, decided by the SERVER (docs/MULTIPLAYER.md §2.4, §4.8, §8.1, §8.4; the QA sweep's NET-1..5).
 *
 * Under MP_PHASE 2 the server already owned the body and the combat, but the backpack still lived on the client and
 * reached the server only inside a save report, once a minute. So eating fed nobody (NET-2), a switched weapon was
 * the old one on the server (NET-1), the ammunition refilled itself (NET-3), armour and skills arrived a minute late
 * (NET-4), and a report could write any backpack at all (NET-5). This module is the server half of the fix:
 *
 *   - the VERBS (shared/net/intentWire.ts): SwitchWeapon, UseItem, Equip, Unequip, LearnSkill and Craft, queued per
 *     survivor and applied in the tick, right BEFORE the command they were made during is simulated (§2.4 `atSeq`):
 *     its movement, its weapon machine and its edges all see the change, as the client's prediction did;
 *   - the RULES of §8.1, each checked against the server's own save and body, never a number from the client:
 *       SwitchWeapon  alive, the weapon is owned (`ownsWeapon`), no construction on the cursor, ≥ 0.1 s since the
 *                     last switch (held, not refused, while it runs)
 *       UseItem       alive, owned, would do something (`itemUseEffect`), one every 0.25 s (held while it runs)
 *       Equip         alive, owned (`ownsEquip`, costumes included), fits the slot (`equipSlotOf`)
 *       Unequip       alive, a real slot 1..5
 *       LearnSkill    alive, a point to spend, below the skill's maximum
 *       Craft         alive, the recipe exists, the station is near the SERVER's position, every ingredient is
 *                     there (checked for all before any is taken), no construction already on the cursor, 4 a
 *                     second (held while it runs)
 *   - the ACK: the nonce of the last verb handled — applied or refused — per UserId, which the wallet push hands
 *     back (`bag.ack`) so the client stops replaying that prediction;
 *   - the PACKS: a pack bought in the shop is delivered HERE, into the server's save, while the survivor is in the
 *     world (`deliverPacks`); the client's own delivery used to reach the server only through the report;
 *   - the REPORT: `stripClientBackpack` pins every backpack field of a report to the server's copy, the way
 *     `stripClientProgress` pins the XP. A report can no longer add an item, a round, a skill or a pack (NET-5).
 *
 * Pure module: no Instances, no services, no os.clock. Time is the simulation tick.
 */
import { EQUIP_SLOT_MAX } from "shared/data/equips";
import { SHOP_PACKS } from "shared/data/shop";
import { seqDiff } from "shared/net/codec";
import {
	INTENT_HOLD_TICKS,
	INTENT_QUEUE_MAX,
	INPUT_SEQ_WINDOW,
	MP_PHASE,
	WORLD_SERVER_PHASE,
} from "shared/net/mpConfig";
import { InputCommand, IntentKind, IntentMessage } from "shared/net/protocol";
import { addItem } from "shared/sim/inventory";
import { ownsWeapon, pendingPacks, PlayerSaveData } from "shared/game/save";
import { BackpackOutcome, ServerCraft } from "./craft";
import { ServerPlayer } from "./players";

/** §8.1 `switchWeapon`: at least this long between two switches (a faster one waits in the queue) */
export const SWITCH_COOLDOWN_S = 0.1;
/** how often a survivor in the world is checked for bought packs that were never delivered */
const PACK_CHECK_TICKS = 30;

/**
 * Does the SERVER own the backpack? From WORLD_SERVER_PHASE on it does (shared/net/mpConfig.ts): every road that
 * fills it — a pickup, a search, a craft, a refunded build, a pack — runs here, so a report has nothing left to say
 * about it. Below that phase the client still loots on its own copy and the report is how that reaches the server.
 */
export function serverOwnsBackpack(): boolean {
	return MP_PHASE >= WORLD_SERVER_PHASE;
}

/** the backpack fields a report may no longer move once the server owns the backpack (§8.4) */
export const SERVER_BACKPACK_FIELDS: ReadonlyArray<string> = [
	"invenWeapon",
	"invenEquip",
	"invenUse",
	"invenEtc",
	"ammoNormal",
	"ammoShotgun",
	"ammoMachinegun",
	"ammoArrow",
	"oil",
	"electric",
	"equipWeapon",
	"equipCloth",
	"equipHand",
	"equipGun",
	"equipOutfit",
	"equipPet",
	"skillLevels",
	"skillPoint",
	"packsOpened",
];

function sameArray(a: Array<number>, b: Array<number>): boolean {
	if (a.size() !== b.size()) return false;
	for (let i = 0; i < a.size(); i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function copyArray(src: Array<number>): Array<number> {
	const out = new Array<number>();
	for (const v of src) out.push(v);
	return out;
}

/**
 * NET-5: overwrites every backpack field of a sanitized client report with the trusted copy, and answers whether the
 * report had tried to move any of them. With the backpack the server's, a report carrying a different one is stale,
 * not suspicious — corrected in silence (§9.2 level 0); the answer is only a number for the admin panel (§9.3).
 *
 * WIRING (server/main.server.ts `processReport`), next to its sibling:
 *
 *   const upd = sanitizeClientReport(decoded, prev);
 *   stripClientProgress(prev, upd);   // the XP, levels and days
 *   stripClientBackpack(prev, upd);   // ← the inventory, ammo, equipped slots, skills and packs
 *
 * `sanitizeClientReport` already ran `enforceSaveInvariants` on the report's values; the pinned copy is the server's
 * own, which satisfied them when it was written, so nothing here has to be re-checked.
 */
export function stripClientBackpack(prev: PlayerSaveData, upd: PlayerSaveData): boolean {
	if (!serverOwnsBackpack()) return false;
	return pinBackpack(prev, upd);
}

/** the pin itself, whatever the phase (tools/ call it directly); true when `upd` had tried to move a field */
export function pinBackpack(prev: PlayerSaveData, upd: PlayerSaveData): boolean {
	let changed = false;
	const arrays: Array<[Array<number>, Array<number>]> = [
		[upd.invenWeapon, prev.invenWeapon],
		[upd.invenEquip, prev.invenEquip],
		[upd.invenUse, prev.invenUse],
		[upd.invenEtc, prev.invenEtc],
		[upd.skillLevels, prev.skillLevels],
		[upd.packsOpened, prev.packsOpened],
	];
	for (const [mine, trusted] of arrays) {
		if (!sameArray(mine, trusted)) changed = true;
	}
	if (
		upd.ammoNormal !== prev.ammoNormal ||
		upd.ammoShotgun !== prev.ammoShotgun ||
		upd.ammoMachinegun !== prev.ammoMachinegun ||
		upd.ammoArrow !== prev.ammoArrow ||
		upd.oil !== prev.oil ||
		upd.electric !== prev.electric ||
		upd.equipWeapon !== prev.equipWeapon ||
		upd.equipCloth !== prev.equipCloth ||
		upd.equipHand !== prev.equipHand ||
		upd.equipGun !== prev.equipGun ||
		upd.equipOutfit !== prev.equipOutfit ||
		upd.equipPet !== prev.equipPet ||
		upd.skillPoint !== prev.skillPoint
	) {
		changed = true;
	}
	upd.invenWeapon = copyArray(prev.invenWeapon);
	upd.invenEquip = copyArray(prev.invenEquip);
	upd.invenUse = copyArray(prev.invenUse);
	upd.invenEtc = copyArray(prev.invenEtc);
	upd.skillLevels = copyArray(prev.skillLevels);
	upd.packsOpened = copyArray(prev.packsOpened);
	upd.ammoNormal = prev.ammoNormal;
	upd.ammoShotgun = prev.ammoShotgun;
	upd.ammoMachinegun = prev.ammoMachinegun;
	upd.ammoArrow = prev.ammoArrow;
	upd.oil = prev.oil;
	upd.electric = prev.electric;
	upd.equipWeapon = prev.equipWeapon;
	upd.equipCloth = prev.equipCloth;
	upd.equipHand = prev.equipHand;
	upd.equipGun = prev.equipGun;
	upd.equipOutfit = prev.equipOutfit;
	upd.equipPet = prev.equipPet;
	upd.skillPoint = prev.skillPoint;
	return changed;
}

/**
 * Every pack bought and not yet delivered goes into the backpack — the server's copy (MON-03). Returns how many
 * packs were opened. `packsBought` only ever moves in the shop (server/main.server.ts), so `packsOpened` catching
 * up with it is the whole ledger: a pack is delivered once because it can only be opened once.
 */
export function deliverPacks(save: PlayerSaveData): number {
	let opened = 0;
	for (const p of SHOP_PACKS) {
		const n = pendingPacks(save, p.id);
		if (n <= 0) continue;
		for (const item of p.items) {
			if (item.index >= 0) addItem(save, item.kind, item.index, item.count * n);
		}
		save.packsOpened[p.id] = save.packsBought[p.id];
		opened += n;
	}
	return opened;
}

/** one verb waiting for its command (§2.4) */
interface Queued {
	msg: IntentMessage;
	/** the tick it arrived on: past INTENT_HOLD_TICKS it no longer waits for `atSeq` */
	at: number;
}

export interface ServerBackpackOptions {
	/** the current town's ServerCraft (it is rebuilt with the town, MP-22): use, equip, learn and craft */
	craft: () => ServerCraft | undefined;
	/** is there a construction on this slot's cursor? (the weapon stays in the holster meanwhile) */
	placing: (slot: number) => boolean;
	/** ticks per second, for the switch cooldown */
	simHz: number;
	/** does this server deliver packs itself? (it owns the backpack; the client delivers below WORLD_SERVER_PHASE) */
	deliversPacks: boolean;
}

export class ServerBackpack {
	/** what a verb did, for the session layer (the save is dirty) and the tests */
	onOutcome?: (sp: ServerPlayer, msg: IntentMessage, outcome: BackpackOutcome) => void;
	/** packs were delivered into this survivor's save */
	onPacks?: (sp: ServerPlayer, opened: number) => void;

	private readonly queues = new Map<number, Array<Queued>>();
	/** the last nonce handled per UserId (the wallet's `bag.ack`); kept across a trip to the lobby */
	private readonly acks = new Map<number, number>();
	/** the tick of the last weapon switch, per slot */
	private readonly switchedAt = new Map<number, number>();

	constructor(private readonly options: ServerBackpackOptions) {}

	/**
	 * A backpack verb from the survivor in `sp.slot` (the wire already range-checked it). False when it was not
	 * taken — a presence verb, or a queue already holding INTENT_QUEUE_MAX — in which case it is acknowledged as
	 * handled at once, so the client's prediction is undone by the next push instead of lingering.
	 */
	queue(sp: ServerPlayer, msg: IntentMessage, tick: number): boolean {
		if (msg.kind === IntentKind.EnterWorld || msg.kind === IntentKind.LeaveWorld) return false;
		let list = this.queues.get(sp.slot);
		if (list === undefined) {
			list = new Array<Queued>();
			this.queues.set(sp.slot, list);
		}
		if (list.size() >= INTENT_QUEUE_MAX) {
			this.handled(sp.userId, msg.nonce);
			this.onOutcome?.(sp, msg, { kind: "refused", why: "full" });
			return false;
		}
		list.push({ msg, at: tick });
		return true;
	}

	/**
	 * §2.4, once per survivor per tick, right BEFORE `cmd` is simulated: every verb whose command has come (its
	 * `atSeq` is this command or an older one) is applied, in the order it arrived. A verb for a command that has not
	 * arrived yet waits for it — at most INTENT_HOLD_TICKS — and holds the ones behind it (the channel is ordered, and
	 * so is the backpack). A dead survivor's verbs are dropped, not held: they would all land on the tick they are
	 * revived.
	 */
	beforeCommand(sp: ServerPlayer, cmd: InputCommand, tick: number): void {
		if (this.options.deliversPacks && (tick + sp.slot) % PACK_CHECK_TICKS === 0) {
			const opened = deliverPacks(sp.save);
			if (opened > 0) this.onPacks?.(sp, opened);
		}
		const list = this.queues.get(sp.slot);
		if (list === undefined || list.size() === 0) return;
		if (sp.state.dead) {
			for (const q of list) {
				this.handled(sp.userId, q.msg.nonce);
				this.onOutcome?.(sp, q.msg, { kind: "refused", why: "dead" });
			}
			list.clear();
			return;
		}
		while (list.size() > 0) {
			const head = list[0];
			if (!this.due(head, cmd, tick) || this.cooling(sp, head.msg, tick)) break;
			list.shift();
			const outcome = this.apply(sp, head.msg, tick);
			this.handled(sp.userId, head.msg.nonce);
			this.onOutcome?.(sp, head.msg, outcome);
		}
	}

	/** the nonce of the last verb this user's client sent that the server has handled (0 = none yet) */
	ackOf(userId: number): number {
		return this.acks.get(userId) ?? 0;
	}

	/** a verb answered OUTSIDE the simulation (server/net/backpackIntents.ts: the lobby's wardrobe, a rate drop) */
	handled(userId: number, nonce: number): void {
		if (nonce !== 0) this.acks.set(userId, nonce);
	}

	/** the survivor left the world: their queue goes (unanswered verbs are answered by the next push's state) */
	remove(slot: number): void {
		this.queues.delete(slot);
		this.switchedAt.delete(slot);
	}

	/** the player left the server */
	forget(userId: number): void {
		this.acks.delete(userId);
	}

	/** a new town (MP-22): nothing queued in the old one is still meaningful */
	clear(): void {
		this.queues.clear();
		this.switchedAt.clear();
	}

	// ---------------------------------------------------------------- internals

	/** has this verb's command come? (or waited long enough, or named a command no honest client would) */
	private due(q: Queued, cmd: InputCommand, tick: number): boolean {
		const at = q.msg.atSeq;
		if (at === 0) return true;
		if (tick - q.at >= INTENT_HOLD_TICKS) return true;
		const d = seqDiff(at, cmd.seq);
		// `atSeq` is this command or an older one (a late verb lands on the next tick), or it is so far from the
		// stream that waiting for it would only be waiting for the hold to run out
		return d <= 0 || d > INPUT_SEQ_WINDOW;
	}

	/** a limit of §8.1 is still running: the verb waits for it rather than being refused (the queue caps the wait) */
	private cooling(sp: ServerPlayer, msg: IntentMessage, tick: number): boolean {
		if (msg.kind === IntentKind.SwitchWeapon) {
			const last = this.switchedAt.get(sp.slot);
			return last !== undefined && tick - last < SWITCH_COOLDOWN_S * this.options.simHz;
		}
		const craft = this.options.craft();
		if (craft === undefined) return false;
		if (msg.kind === IntentKind.UseItem) return craft.cooling(sp.slot, "use");
		if (msg.kind === IntentKind.Craft) return craft.cooling(sp.slot, "craft");
		return false;
	}

	private apply(sp: ServerPlayer, msg: IntentMessage, tick: number): BackpackOutcome {
		const save = sp.save;
		if (msg.kind === IntentKind.SwitchWeapon) return this.switchWeapon(sp, msg.arg, tick);
		if (msg.kind === IntentKind.Unequip && (msg.arg < 1 || msg.arg > EQUIP_SLOT_MAX)) {
			return { kind: "refused", why: "unknown" };
		}
		const craft = this.options.craft();
		if (craft === undefined) return { kind: "refused", why: "unknown" };
		if (msg.kind === IntentKind.UseItem) return craft.useItem(sp.slot, sp.state, save, msg.arg);
		if (msg.kind === IntentKind.Equip) return craft.equip(save, msg.arg);
		if (msg.kind === IntentKind.Unequip) return craft.unequip(save, msg.arg);
		if (msg.kind === IntentKind.LearnSkill) return craft.learnSkill(save, msg.arg);
		if (msg.kind === IntentKind.Craft) return craft.craft(sp.slot, sp.state, save, msg.arg);
		return { kind: "refused", why: "unknown" };
	}

	/**
	 * §8.1 `switchWeapon`: owned, and not while a construction is on the cursor. The save's `equipWeapon` is all it
	 * writes: server/sim/combat.ts reads it every tick (`weaponOf`) and does the rest — the rounds left in the old
	 * magazine go back to their pool, cadence, reload and swing start over — in THIS tick, because the verb is
	 * applied before the command's weapon machine runs.
	 */
	private switchWeapon(sp: ServerPlayer, weaponId: number, tick: number): BackpackOutcome {
		if (this.options.placing(sp.slot)) return { kind: "refused", why: "busy" };
		if (!ownsWeapon(sp.save, weaponId)) return { kind: "refused", why: "owned" };
		this.switchedAt.set(sp.slot, tick);
		sp.save.equipWeapon = weaponId;
		return { kind: "switched", weapon: weaponId };
	}
}
