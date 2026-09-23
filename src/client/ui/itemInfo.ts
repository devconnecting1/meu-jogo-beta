/*
 * What an item card says (client/ui/itemCard.ts, DESIGN_RULES UI-08), read from the shared data -- and only the
 * fields an item really has. The card never invents a stat: a weapon has damage, cooldown and range, and a gun a
 * magazine, a reload and an ammo pool; food and medicine have health, hunger and three timed effects; clothing
 * has defense and speed; a material has the recipes that use it. There is no durability, weight, warmth or stack
 * size in the data, so the card shows none. What an item does in CODE rather than in data (a compass, a watch)
 * is not a stat either: such an item shows its name, its type and how to equip it.
 *
 * Also the helpers the Bag's lists share with the card (names, weapon kinds, damage text, which recipes use a
 * material), so both say the same thing about the same item.
 *
 * Every string goes through lang.ts (UI-03). The usage hint speaks the player's device (tutorial.ts
 * currentScheme) with the keys of tutorial.ts SCHEMES, the real bindings of client/bootstrap.ts, so a card
 * never promises a key the game does not listen to.
 */
import { CRAFT_RECIPES, CraftRecipe } from "shared/data/crafts";
import { EQUIPS, EquipSlot } from "shared/data/equips";
import { ETC_ITEMS } from "shared/data/etcItems";
import { AmmoPool, ItemKind, WeaponKind } from "shared/data/kinds";
import { langGet } from "shared/data/lang";
import { USABLES, UsableDef } from "shared/data/usables";
import { WEAPONS, WeaponDef, isChoppingTool, meleeReach, usesMagazine } from "shared/data/weapons";
import { weaponReserve } from "shared/game/player";
import { PlayerSaveData, equipSlotOf } from "shared/game/save";
import { CardHint, CardStat, ItemCardModel, StatTone } from "./itemCard";
import { THEME } from "./theme";
import { SCHEMES, SCHEME_GAMEPAD, SCHEME_TOUCH, currentScheme } from "./tutorial";
import { fmtInt, fmtNum, fmtSeconds } from "./widgets";

/** ETC_ITEMS below this index are buildables (placed from the build menu), not materials */
export const MAT_START = 23;

/**
 * The three weapons whose rules are their own in both combat loops (server/sim/combat.ts, and the reserve in
 * shared/game/player.ts weaponReserve): the chainsaw cuts while held and burns oil, the flamethrower burns oil, the
 * stun gun spends charge. The table cannot say it for two of them (the chainsaw's and the stun gun's ammoPool is
 * "Normal"), so the card names them here.
 */
const CHAINSAW = 5;
const FLAMETHROWER = 25;
const STUN_GUN = 26;

/** ETC_ITEMS rows that are the ammo of each pool (their names are the ammo's names) */
const AMMO_ITEM: Record<number, number> = {
	[AmmoPool.Normal]: 44,
	[AmmoPool.Shotgun]: 45,
	[AmmoPool.MG]: 46,
	[AmmoPool.Arrow]: 47,
	[AmmoPool.Oil]: 48,
};

/** by EquipSlot: 4 and 5 are the two cosmetic slots worn at once (MON-04) */
export const SLOT_NAMES = ["-", "Cloth", "Hand", "Gun", "Outfit", "Pet"];
/** the card's type of an equipment slot */
const SLOT_TYPES = ["Equipment", "Clothing", "Tool", "Gear", "Outfit", "Pet"];

/** how a player presses the button of a screen, by SCHEMES index: a click, a tap, the pad's A on the selection */
const PRESS = ["Click", "Tap", "A"];

/** most recipe names the notes of a material list before "+N" */
const MAX_USES_NAMED = 5;

// ---------------------------------------------------------------- shared with the Bag's lists

export function nameOf(kind: number, index: number): string {
	if (kind === ItemKind.Weapon) return index >= 0 && index < WEAPONS.size() ? WEAPONS[index].name : "?";
	if (kind === ItemKind.Equip) return index >= 0 && index < EQUIPS.size() ? EQUIPS[index].name : "?";
	if (kind === ItemKind.Use) return index >= 0 && index < USABLES.size() ? USABLES[index].name : "?";
	return index >= 0 && index < ETC_ITEMS.size() ? ETC_ITEMS[index].name : "?";
}

export function weaponKindName(kind: number): string {
	if (kind === WeaponKind.Rifle) return "Rifle";
	if (kind === WeaponKind.Pistol) return "Pistol";
	if (kind === WeaponKind.MG) return "Machine gun";
	if (kind === WeaponKind.Shotgun) return "Shotgun";
	if (kind === WeaponKind.Sniper) return "Sniper rifle";
	if (kind === WeaponKind.Bow) return "Bow";
	if (kind === WeaponKind.Melee) return "Melee";
	if (kind === WeaponKind.Special) return "Special";
	return "Weapon";
}

export function isMelee(w: WeaponDef): boolean {
	return w.kind === WeaponKind.Melee || w.mag <= 0;
}

export function damageText(w: WeaponDef): string {
	return w.pellets > 1 ? `${fmtInt(w.dmg)} x${w.pellets}` : fmtInt(w.dmg);
}

export function signed(v: number): string {
	return v > 0 ? `+${fmtNum(v)}` : fmtNum(v);
}

/** the recipes that take the material `etcId` */
export function recipesUsing(etcId: number): Array<CraftRecipe> {
	const out: Array<CraftRecipe> = [];
	for (const r of CRAFT_RECIPES) {
		for (const ing of r.ingredients) {
			if (ing.kind === ItemKind.Etc && ing.index === etcId) {
				out.push(r);
				break;
			}
		}
	}
	return out;
}

/**
 * Medicine rather than food: what treats (a timed effect) or heals without feeding. The same split the ground
 * items are drawn with (client/gameLoop.ts isMedicine), so the card and the street agree on what a thing is.
 */
function isMedicine(u: UsableDef): boolean {
	return u.pain > 0 || u.speed > 0 || u.calm > 0 || (u.hunger <= 0 && u.hp > 0);
}

// ---------------------------------------------------------------- the card

type Tr = (key: string) => string;

function stat(label: string, value: string, tone: StatTone): CardStat {
	return { label, value, tone };
}

/** a number that adds (green) or takes away (red) */
function gain(tr: Tr, label: string, v: number): CardStat {
	return stat(tr(label), signed(v), v > 0 ? "bonus" : "penalty");
}

/** a timed status effect, in minutes (orange) */
function effect(tr: Tr, label: string, minutes: number): CardStat {
	return stat(tr(label), `${fmtNum(minutes)} min`, "effect");
}

/** the key of `scheme` that does `what`, from the real bindings (tutorial.ts SCHEMES); "" when it has none */
function keyFor(scheme: number, what: string): string {
	const s = SCHEMES[scheme];
	if (s === undefined) return "";
	for (const [chip, does] of s.rows) if (does === what) return chip;
	return "";
}

/** a hint line, or nothing when the device has no such key */
function hint(out: Array<CardHint>, key: string, text: string): void {
	if (key !== "") out.push({ key, text });
}

interface Parts {
	type: string;
	stats: Array<CardStat>;
	notes: Array<string>;
	hints: Array<CardHint>;
}

/** the name of what feeds `w` (shared/game/player.ts weaponReserve): its ammo, oil, or the stun gun's charge */
function reserveName(w: WeaponDef): string {
	if (w.id === CHAINSAW || w.id === FLAMETHROWER) return ETC_ITEMS[AMMO_ITEM[AmmoPool.Oil]].name;
	if (w.id === STUN_GUN) return "Charge";
	const ammo = ETC_ITEMS[AMMO_ITEM[w.ammoPool] ?? -1];
	return ammo !== undefined ? ammo.name : "Ammo";
}

/**
 * How the trigger works, from the rules both combat loops apply (server/sim/combat.ts, client/systems/combat.ts):
 * every melee weapon swings while held, the chainsaw cuts while held and burns oil, a draw-bow fires on release
 * after a full draw, a bolt-action sniper fires on release, and a gun fires while held only when it is automatic.
 */
function triggerNote(w: WeaponDef): string {
	if (w.id === CHAINSAW) return "Runs on oil while you hold it.";
	if (w.kind === WeaponKind.Melee) return "Hold to keep swinging.";
	if (w.kind === WeaponKind.Bow && !usesMagazine(w)) return "Hold to draw, let go to shoot.";
	if (w.kind === WeaponKind.Sniper && !w.auto) return "Fires when you let go.";
	return w.auto ? "Hold to keep firing." : "One shot per press.";
}

function weaponParts(save: PlayerSaveData, w: WeaponDef, tr: Tr, scheme: number): Parts {
	const melee = isMelee(w);
	const drawBow = w.kind === WeaponKind.Bow && !usesMagazine(w);
	const stats = [stat(tr("Damage"), damageText(w), "value")];
	// the chainsaw has no cadence: it cuts every frame it runs. A draw-bow's cooldown is its draw.
	if (w.id !== CHAINSAW) stats.push(stat(tr(drawBow ? "Draw time" : "Cooldown"), fmtSeconds(w.cooldown), "value"));
	// a melee weapon's `range` is its swing speed, not a distance: its reach is weapons.ts MELEE_REACH
	if (melee) stats.push(stat(tr("Reach"), fmtInt(meleeReach(w)), "value"));
	else stats.push(stat(tr("Range"), fmtNum(w.range), "value"));
	if (usesMagazine(w)) {
		stats.push(stat(tr("Magazine"), fmtInt(w.mag), "value"));
		stats.push(stat(tr("Reload"), fmtSeconds(w.reload), "value"));
	}
	// what it fires or burns, by that thing's own name, and how much the survivor carries
	if (!melee || w.id === CHAINSAW) stats.push(stat(tr(reserveName(w)), fmtInt(weaponReserve(save, w)), "value"));
	const notes = [tr(triggerNote(w))];
	if (isChoppingTool(w)) notes.push(tr("Chops trees for extra wood."));
	// fighting with it, on this device: the attack (on touch, the aim is the same gesture) and the reload
	const hints: Array<CardHint> = [];
	if (scheme === SCHEME_TOUCH) {
		hint(hints, keyFor(scheme, "Drag to aim"), tr("Drag to aim, let go to attack"));
	} else {
		hint(hints, keyFor(scheme, "Attack / shoot"), tr("Attack / shoot"));
	}
	if (usesMagazine(w)) hint(hints, keyFor(scheme, "Reload"), tr("Reload"));
	return { type: `${tr("Weapon")} · ${tr(weaponKindName(w.kind))}`, stats, notes, hints };
}

function usableParts(u: UsableDef, tr: Tr): Parts {
	const stats: Array<CardStat> = [];
	if (u.hp !== 0) stats.push(gain(tr, "Health recovery", u.hp));
	if (u.hunger !== 0) stats.push(gain(tr, "Hunger recovery", u.hunger));
	// what the timers do is in shared/game/player.ts: +2 walking speed, a steadier aim, no slowdown when hit
	const notes: Array<string> = [];
	if (u.speed > 0) {
		stats.push(effect(tr, "Speed boost", u.speed));
		notes.push(tr("Walk faster while it lasts."));
	}
	if (u.calm > 0) {
		stats.push(effect(tr, "Steady aim", u.calm));
		notes.push(tr("Your aim settles faster while it lasts."));
	}
	if (u.pain > 0) {
		stats.push(effect(tr, "Pain relief", u.pain));
		notes.push(tr("Hits don't slow you down while it lasts."));
	}
	const cooked = u.cook >= 0 ? USABLES[u.cook] : undefined;
	if (cooked !== undefined) stats.push(stat(tr("Cooks into"), tr(cooked.name), "text"));
	return { type: tr(isMedicine(u) ? "Medicine" : "Food"), stats, notes, hints: [] };
}

function equipParts(id: number, tr: Tr): Parts {
	const e = EQUIPS[id];
	const slot = equipSlotOf(id);
	const stats = [stat(tr("Slot"), tr(SLOT_NAMES[slot] ?? "-"), "text")];
	if (e.def !== 0) stats.push(gain(tr, "Defense", e.def));
	if (e.speed !== 0) stats.push(gain(tr, "Speed", e.speed));
	// MON-01 / MON-04: say what a cosmetic does, and what it does not -- the old catalogue promised pets that
	// "collect items" and "attack zombies", and a pet here only ever keeps you company
	let note = "";
	if (slot === EquipSlot.Outfit) note = "Everyone sees it on your survivor. It changes nothing else.";
	else if (slot === EquipSlot.Pet) note = "It follows you and everyone sees it. It never fights or collects.";
	const notes = note !== "" ? [tr(note)] : [];
	return { type: tr(SLOT_TYPES[slot] ?? "Equipment"), stats, notes, hints: [] };
}

function etcParts(id: number, tr: Tr): Parts {
	let what = "Material";
	if (id < MAT_START) what = "Buildable";
	else if (id === AMMO_ITEM[AmmoPool.Oil]) what = "Fuel";
	else if (id >= AMMO_ITEM[AmmoPool.Normal] && id < AMMO_ITEM[AmmoPool.Oil]) what = "Ammo";
	const uses = recipesUsing(id);
	const stats: Array<CardStat> = [];
	const notes: Array<string> = [];
	if (uses.size() > 0) {
		stats.push(stat(tr("Used in recipes"), fmtInt(uses.size()), "value"));
		const names: Array<string> = [];
		const named = math.min(uses.size(), MAX_USES_NAMED);
		for (let i = 0; i < named; i++) names.push(tr(nameOf(uses[i].resultKind, uses[i].resultIndex)));
		const more = uses.size() - named;
		notes.push(`${tr("Used to craft")} ${names.join(", ")}${more > 0 ? ` +${more}` : ""}.`);
	} else if (what === "Material") {
		notes.push(tr("Not used in any recipe."));
	}
	return { type: tr(what), stats, notes, hints: [] };
}

export interface DescribeOpts {
	/**
	 * The action the screen offers on the item now ("Equip", "Use", "Open Craft"), shown as the first hint with the
	 * device's way of pressing it; omitted = none
	 */
	action?: string;
	/** the header's tag (the count, "EQUIPPED"); default none */
	tag?: string;
	tagColor?: Color3;
}

/** the card of item `kind` / `id` for the survivor of `save` (undefined: no such item) */
export function describeItem(
	save: PlayerSaveData,
	kind: number,
	id: number,
	opts?: DescribeOpts,
): ItemCardModel | undefined {
	const lang = save.settings.langType;
	const tr: Tr = (key: string): string => langGet(key, lang);
	const scheme = currentScheme();
	let parts: Parts;
	if (kind === ItemKind.Weapon && WEAPONS[id] !== undefined) parts = weaponParts(save, WEAPONS[id], tr, scheme);
	else if (kind === ItemKind.Equip && EQUIPS[id] !== undefined) parts = equipParts(id, tr);
	else if (kind === ItemKind.Use && USABLES[id] !== undefined) parts = usableParts(USABLES[id], tr);
	else if (kind === ItemKind.Etc && ETC_ITEMS[id] !== undefined) parts = etcParts(id, tr);
	else return undefined;

	const hints: Array<CardHint> = [];
	const action = opts?.action;
	if (action !== undefined && action !== "") {
		const press = PRESS[scheme] ?? PRESS[0];
		hints.push({ key: scheme === SCHEME_GAMEPAD ? press : tr(press), text: tr(action) });
	}
	for (const h of parts.hints) hints.push(h);
	return {
		kind,
		name: tr(nameOf(kind, id)),
		type: parts.type,
		tag: opts?.tag ?? "",
		tagColor: opts?.tagColor ?? THEME.mutedForeground,
		stats: parts.stats,
		notes: parts.notes.join(" "),
		hints,
	};
}
