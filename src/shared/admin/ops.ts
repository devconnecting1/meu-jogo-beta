import { enforceSaveInvariants, PlayerSaveData, SAVE_LIMITS } from "shared/game/save";
import { WEAPONS } from "shared/data/weapons";
import { EQUIPS } from "shared/data/equips";
import { USABLES } from "shared/data/usables";
import { ETC_ITEMS } from "shared/data/etcItems";
import { COSTUMES } from "shared/data/shop";

/*
 * Admin save edits as operations. The SAME function applies them on the server (its copy of the save) and on
 * the edited player's client (ctx.save), so both copies end up identical for the touched fields while every
 * field the admin did not touch keeps the client's newer value.
 */

export type StatField = "level" | "exp" | "skillPoint" | "money" | "day";

/** inventory groups; "ammo" indexes AMMO_FIELDS (the ETC ids 44–48 are the ammo pools, not inventory slots) */
export type ItemGroup = "weapon" | "equip" | "use" | "etc" | "ammo";

export type AdminOp =
	| { op: "stat"; field: StatField; value: number }
	/**
	 * mode "set" (default): the count becomes exactly `count`; "min": at least `count` (never lowers it). "min" is
	 * applied by each side to its OWN copy, so bulk "give" buttons never overwrite newer counts with an old snapshot.
	 */
	| { op: "item"; group: ItemGroup; index: number; count: number; mode?: "set" | "min" }
	| { op: "costume"; id: number; owned: boolean }
	/** takes every spent skill point back (the skill levels go to 0, the points return to skillPoint) */
	| { op: "resetSkills" };

export type AmmoField = "ammoNormal" | "ammoShotgun" | "ammoMachinegun" | "ammoArrow" | "oil" | "electric";

export const AMMO_FIELDS: Array<AmmoField> = [
	"ammoNormal",
	"ammoShotgun",
	"ammoMachinegun",
	"ammoArrow",
	"oil",
	"electric",
];
export const AMMO_LABELS: Array<string> = [
	"Normal ammo",
	"Shotgun ammo",
	"Machinegun ammo",
	"Arrows",
	"Oil",
	"Electricity",
];

/** ETC_ITEMS ids stored in the ammo fields instead of invenEtc (see client/systems/items.ts) */
export function isAmmoEtcId(index: number): boolean {
	return index >= 44 && index <= 48;
}

const STAT_FIELDS = new Set<string>(["level", "exp", "skillPoint", "money", "day"]);
const ITEM_GROUPS = new Set<string>(["weapon", "equip", "use", "etc", "ammo"]);

export function statRange(field: StatField): [number, number] {
	const L = SAVE_LIMITS;
	if (field === "level") return [1, L.LEVEL_MAX];
	if (field === "exp") return [0, 1000000];
	if (field === "skillPoint") return [0, L.LEVEL_MAX];
	if (field === "money") return [0, L.MONEY_MAX];
	return [1, L.DAY_MAX];
}

export function itemGroupSize(group: ItemGroup): number {
	if (group === "weapon") return WEAPONS.size();
	if (group === "equip") return EQUIPS.size();
	if (group === "use") return USABLES.size();
	if (group === "etc") return ETC_ITEMS.size();
	return AMMO_FIELDS.size();
}

export function itemMax(group: ItemGroup): number {
	return group === "ammo" ? SAVE_LIMITS.AMMO_MAX : SAVE_LIMITS.ITEM_MAX;
}

export function itemCount(save: PlayerSaveData, group: ItemGroup, index: number): number {
	if (group === "weapon") return save.invenWeapon[index] ?? 0;
	if (group === "equip") return save.invenEquip[index] ?? 0;
	if (group === "use") return save.invenUse[index] ?? 0;
	if (group === "etc") return save.invenEtc[index] ?? 0;
	const f = AMMO_FIELDS[index];
	return f !== undefined ? save[f] : 0;
}

function isInt(v: unknown): v is number {
	return typeIs(v, "number") && v === v && v % 1 === 0 && v > -math.huge && v < math.huge;
}

/** one untrusted op → a valid op (clamped), or undefined */
function readOp(raw: unknown): AdminOp | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const r = raw as Record<string, unknown>;
	if (r.op === "stat") {
		if (!typeIs(r.field, "string") || !STAT_FIELDS.has(r.field) || !isInt(r.value)) return undefined;
		const field = r.field as StatField;
		const [lo, hi] = statRange(field);
		return { op: "stat", field, value: math.clamp(r.value, lo, hi) };
	}
	if (r.op === "item") {
		if (!typeIs(r.group, "string") || !ITEM_GROUPS.has(r.group) || !isInt(r.index) || !isInt(r.count)) {
			return undefined;
		}
		const group = r.group as ItemGroup;
		if (r.index < 0 || r.index >= itemGroupSize(group)) return undefined;
		if (group === "etc" && isAmmoEtcId(r.index)) return undefined;
		if (r.mode !== undefined && r.mode !== "set" && r.mode !== "min") return undefined;
		const count = math.clamp(r.count, 0, itemMax(group));
		return { op: "item", group, index: r.index, count, mode: r.mode === "min" ? "min" : "set" };
	}
	if (r.op === "costume") {
		if (!isInt(r.id) || r.id < 0 || r.id >= COSTUMES.size() || !typeIs(r.owned, "boolean")) return undefined;
		return { op: "costume", id: r.id, owned: r.owned };
	}
	if (r.op === "resetSkills") return { op: "resetSkills" };
	return undefined;
}

/** validates an untrusted op list (undefined when it is not a list, too long, or has an invalid op) */
export function readAdminOps(raw: unknown, maxOps: number): Array<AdminOp> | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const list = raw as Array<unknown>;
	const n = list.size();
	if (n === 0 || n > maxOps) return undefined;
	const out: Array<AdminOp> = [];
	for (let i = 0; i < n; i++) {
		const op = readOp(list[i]);
		if (op === undefined) return undefined;
		out.push(op);
	}
	return out;
}

function setItem(save: PlayerSaveData, group: ItemGroup, index: number, count: number): void {
	if (group === "weapon") {
		save.invenWeapon[index] = count;
	} else if (group === "equip") {
		save.invenEquip[index] = count;
	} else if (group === "use") {
		save.invenUse[index] = count;
	} else if (group === "etc") {
		save.invenEtc[index] = count;
	} else {
		const f = AMMO_FIELDS[index];
		if (f !== undefined) save[f] = count;
	}
}

/**
 * Applies validated ops to `save` in place, then the save invariants (skills ≤ levels, owned equipment...).
 * Setting the level also grants (or takes back) one skill point per level crossed, like levelling up;
 * an explicit skillPoint op later in the list overrides it.
 */
export function applyAdminOps(save: PlayerSaveData, ops: Array<AdminOp>): void {
	for (const o of ops) {
		if (o.op === "stat") {
			if (o.field === "level") {
				// like levelling up / down: +1 skill point per level gained; when the new level cannot pay for the
				// skills already learnt, every skill is refunded instead of being wiped with its points
				const d = o.value - save.level;
				save.level = o.value;
				const earned = o.value - 1;
				let spent = 0;
				for (const v of save.skillLevels) spent += v;
				if (spent > earned) {
					for (let i = 0; i < save.skillLevels.size(); i++) save.skillLevels[i] = 0;
					save.skillPoint = earned;
				} else {
					save.skillPoint = math.clamp(save.skillPoint + d, 0, earned - spent);
				}
			} else if (o.field === "exp") {
				save.exp = o.value;
			} else if (o.field === "skillPoint") {
				save.skillPoint = o.value;
			} else if (o.field === "money") {
				save.money = o.value;
			} else {
				save.day = o.value;
				save.bestDay = math.max(save.bestDay, o.value);
			}
		} else if (o.op === "item") {
			const now = itemCount(save, o.group, o.index);
			setItem(save, o.group, o.index, o.mode === "min" ? math.max(now, o.count) : o.count);
		} else if (o.op === "costume") {
			save.costumes[o.id] = o.owned ? 1 : 0;
		} else {
			let spent = 0;
			for (let i = 0; i < save.skillLevels.size(); i++) {
				spent += save.skillLevels[i];
				save.skillLevels[i] = 0;
			}
			save.skillPoint += spent;
		}
	}
	enforceSaveInvariants(save);
}

/** short human description of an op list (audit log) */
export function describeOps(ops: Array<AdminOp>): string {
	const parts: Array<string> = [];
	for (const o of ops) {
		if (o.op === "stat") parts.push(`${o.field}=${o.value}`);
		else if (o.op === "item") parts.push(`${o.group}[${o.index}]${o.mode === "min" ? ">=" : "="}${o.count}`);
		else if (o.op === "costume") parts.push(`costume[${o.id}]=${o.owned ? "on" : "off"}`);
		else parts.push("resetSkills");
	}
	return safeText(parts.join(", "), 200);
}

const HIGH_BYTES = `[${string.char(128)}-${string.char(255)}]`;

/**
 * Text that is always valid UTF-8 and at most `maxChars` characters (cut on a character boundary, never inside a
 * multi-byte one). Invalid byte sequences become "?". JSON / DataStore writes fail on invalid UTF-8.
 */
export function safeText(text: string, maxChars: number): string {
	let t = text;
	if (!typeIs(utf8.len(t)[0], "number")) t = t.gsub(HIGH_BYTES, "?")[0];
	const [n] = utf8.len(t);
	if (!typeIs(n, "number") || n <= maxChars) return t;
	const cut = utf8.offset(t, maxChars);
	return cut !== undefined ? `${t.sub(1, cut - 1)}…` : t.sub(1, maxChars);
}
