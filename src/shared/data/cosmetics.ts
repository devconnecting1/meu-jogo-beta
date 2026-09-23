/*
 * The cosmetics a survivor wears (docs/DESIGN_RULES.md MON-04, docs/MONETIZATION.md).
 *
 * Every EQUIPS row of kind 4 is bought in the shop (`COSTUMES`, shared/data/shop.ts) and changes NOTHING that
 * happens in a night (MON-01): no defence, no speed, no collision. What it changes is what everybody SEES, and it
 * goes in one of two slots, worn at the same time (decision of the owner, 2026-09-23):
 *
 *   OUTFIT  changes the body itself: Santa, Zombie, Cowboy
 *   PET     a small companion that follows the survivor: the two pigeons, the eagle, the three dogs
 *
 * The split is by what each one IS in the game, read off its name and its shop entry: a costume you wear is an
 * outfit, an animal that walks or flies after you is a pet. Nothing in the catalogue is ambiguous today; a new
 * kind-4 row that is not listed here fits NO slot (`cosmeticSlotOf` answers 0) and cannot be equipped, which is
 * the safe failure — better unsellable than drawn as the wrong thing.
 *
 * The LOOK numbers below are what travels on the wire (shared/net/protocol.ts `PlayerJoined` / `PlayerProfile`)
 * and what the view draws (client/view/cosmeticsView.ts). They are deliberately not EQUIPS indices: the wire says
 * what to draw, never which inventory row it came from, and reordering EQUIPS can never change a drawing. 0 is
 * always "nothing worn".
 */
import { EQUIPS, EquipSlot } from "./equips";

/** what an outfit looks like; 0 = the plain survivor */
export const OutfitLook = {
	None: 0,
	Santa: 1,
	Zombie: 2,
	Cowboy: 3,
} as const;
export type OutfitLook = (typeof OutfitLook)[keyof typeof OutfitLook];
export const OUTFIT_LOOK_MAX = 3;

/** which animal follows the survivor; 0 = none */
export const PetLook = {
	None: 0,
	Pigeon: 1,
	WhitePigeon: 2,
	Eagle: 3,
	Carolina: 4,
	Malamute: 5,
	Doberman: 6,
} as const;
export type PetLook = (typeof PetLook)[keyof typeof PetLook];
export const PET_LOOK_MAX = 6;

function equipIdOf(name: string): number {
	for (const e of EQUIPS) {
		if (e.name === name) return e.id;
	}
	warn(`[cosmetics] equipment not found: "${name}"`);
	return -1;
}

/** EQUIPS id of each look, by look number (index 0 = none); resolved by NAME so a reorder of EQUIPS is harmless */
const OUTFIT_EQUIP: Array<number> = [-1, equipIdOf("Santa"), equipIdOf("Zombie"), equipIdOf("Cowboy")];
const PET_EQUIP: Array<number> = [
	-1,
	equipIdOf("Pigeon"),
	equipIdOf("White pigeon"),
	equipIdOf("Eagle"),
	equipIdOf("Carolina"),
	equipIdOf("Malamute"),
	equipIdOf("Doberman"),
];

/** the outfit look an EQUIPS row gives, or OutfitLook.None when it is not an outfit */
export function outfitLookOfEquip(equipId: number): number {
	if (equipId < 0) return OutfitLook.None;
	for (let look = 1; look <= OUTFIT_LOOK_MAX; look++) {
		if (OUTFIT_EQUIP[look] === equipId) return look;
	}
	return OutfitLook.None;
}

/** the pet look an EQUIPS row gives, or PetLook.None when it is not a pet */
export function petLookOfEquip(equipId: number): number {
	if (equipId < 0) return PetLook.None;
	for (let look = 1; look <= PET_LOOK_MAX; look++) {
		if (PET_EQUIP[look] === equipId) return look;
	}
	return PetLook.None;
}

/** the EQUIPS id behind an outfit look (-1 for none or out of range) — the wardrobe preview goes this way */
export function outfitEquipOf(look: number): number {
	return OUTFIT_EQUIP[look] ?? -1;
}

/** the EQUIPS id behind a pet look (-1 for none or out of range) */
export function petEquipOf(look: number): number {
	return PET_EQUIP[look] ?? -1;
}

/** EquipSlot.Outfit, EquipSlot.Pet, or 0 when the row is not a cosmetic this game knows how to draw */
export function cosmeticSlotOf(equipId: number): number {
	if (outfitLookOfEquip(equipId) !== OutfitLook.None) return EquipSlot.Outfit;
	if (petLookOfEquip(equipId) !== PetLook.None) return EquipSlot.Pet;
	return 0;
}

/** birds fly after the survivor and land when they stop; dogs walk at their heel */
export function petFlies(look: number): boolean {
	return look === PetLook.Pigeon || look === PetLook.WhitePigeon || look === PetLook.Eagle;
}
