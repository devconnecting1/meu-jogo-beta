import type { WorldSound } from "shared/sim/types";

/**
 * Consumables. `hp` heals (negative hurts), `hunger` refills the stomach; speed/calm/pain are buff
 * lengths in minutes. (tools/fix-usables.cjs swapped the columns once but skipped negative numbers,
 * which left Rotten meat as "heals 20 / starves 10"; it is "fills 20 / hurts 10" like the original.)
 */
export interface UsableDef {
	id: number;
	name: string;
	hp: number;
	hunger: number;
	speed: number;
	calm: number;
	pain: number;
	cook: number;
}

export const USABLES: Array<UsableDef> = [
	{ id: 0, name: "Raw meat", hp: 5, hunger: 20, speed: 0, calm: 0, pain: 0, cook: 1 },
	{ id: 1, name: "Cooked meat", hp: 5, hunger: 30, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 2, name: "Potato", hp: 0, hunger: 10, speed: 0, calm: 0, pain: 0, cook: 3 },
	{ id: 3, name: "Baked potato", hp: 0, hunger: 20, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 4, name: "Bread", hp: 5, hunger: 20, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 5, name: "First aid kit", hp: 50, hunger: 0, speed: 0, calm: 0, pain: 2, cook: -1 },
	{ id: 6, name: "Pain killer", hp: 0, hunger: 0, speed: 0, calm: 0, pain: 4, cook: -1 },
	{ id: 7, name: "Adrenaline", hp: 0, hunger: 0, speed: 4, calm: 0, pain: 0, cook: -1 },
	{ id: 8, name: "Sedative", hp: 0, hunger: 0, speed: 0, calm: 4, pain: 0, cook: -1 },
	{ id: 9, name: "Canned food", hp: 5, hunger: 25, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 10, name: "Frozen pizza", hp: 0, hunger: 15, speed: 0, calm: 0, pain: 0, cook: 11 },
	{ id: 11, name: "Pizza", hp: 5, hunger: 30, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 12, name: "Bandage", hp: 20, hunger: 0, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 13, name: "Frozen meal", hp: 0, hunger: 20, speed: 0, calm: 0, pain: 0, cook: 14 },
	{ id: 14, name: "Cooked meal", hp: 0, hunger: 30, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 15, name: "Mushroom", hp: 0, hunger: 10, speed: 0, calm: 0, pain: 0, cook: 16 },
	{ id: 16, name: "Mushroom soup", hp: 0, hunger: 20, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 17, name: "Apple", hp: 0, hunger: 20, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 18, name: "Berry", hp: 0, hunger: 15, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 19, name: "Rotten meat", hp: -10, hunger: 20, speed: 0, calm: 0, pain: 0, cook: -1 },
];

/** USABLES ids that are not food: the first aid kit, the two pills, the adrenaline shot and the bandage */
const FIRST_AID_KIT = 5;
const PAIN_KILLER = 6;
const ADRENALINE = 7;
const SEDATIVE = 8;
const BANDAGE = 12;

/**
 * What using a usable sounds like (P0-4), by what it IS (P3): the kit's bag is unzipped, a bandage is torn, pills
 * rattle, adrenaline is a shot (a silent slot until the library has one: shared/data/sounds.ts `useInject`), and
 * everything else is eaten. The server plays it when it accepted the use (server/sim/simulation.ts).
 */
export function useSoundOf(id: number): WorldSound {
	if (id === FIRST_AID_KIT) return "useMedkit";
	if (id === BANDAGE) return "useBandage";
	if (id === PAIN_KILLER || id === SEDATIVE) return "usePills";
	if (id === ADRENALINE) return "useInject";
	return "useEat";
}

/*
 * Quick use (DESIGN_RULES ITM-08, UI-09): what the HUD's HEAL and EAT plates -- H / F, the D-pad's up / down, a tap --
 * may use without opening the Bag, as TIERS: the pick (shared/game/quickUse.ts `quickPick`) takes the first tier that
 * holds something, and inside it the smallest item that fills the bar without waste, or the biggest when none does.
 * A tie goes to the first in the tier. One list for every client, and the server applies whatever it sends by the
 * rule of any use (server/sim/craft.ts `useItem`): the quick path is the Bag's UseItem verb, not a new one.
 *
 * Never here: what neither heals nor feeds (Pain killer, Adrenaline, Sedative). Their timed effect is the point of
 * using them, and a plate that spent one to "heal" would burn a rare item for nothing -- they stay in the Bag.
 */

/** HEAL: the medicine that restores health, smallest first */
export const QUICK_HEAL: ReadonlyArray<ReadonlyArray<number>> = [[BANDAGE, FIRST_AID_KIT]];

/**
 * EAT, in three tiers: (1) ready food; (2) raw food, only when there is nothing ready -- a fire makes it worth more
 * (ITM-01: raw meat 20 -> cooked 30); (3) rotten meat, only when it is the last food, and never when its 10 hp of
 * damage would end the survivor.
 */
export const QUICK_EAT: ReadonlyArray<ReadonlyArray<number>> = [
	[1, 3, 4, 9, 11, 14, 16, 17, 18],
	[0, 2, 10, 13, 15],
	[19],
];

/** the icon a plate shows with none of its kind in the backpack (Bandage; Canned food): Núcleo 1, their own drawing */
export const QUICK_ICON: ReadonlyArray<number> = [BANDAGE, 9];
