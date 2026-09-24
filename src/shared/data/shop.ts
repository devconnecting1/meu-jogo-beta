import { ItemKind } from "./kinds";
import { WEAPONS } from "./weapons";
import { EQUIPS } from "./equips";
import { USABLES } from "./usables";
import { ETC_ITEMS } from "./etcItems";

/**
 * Economy rules. The SERVER is the only place where coins change (see src/server/main.server.ts);
 * the client imports these numbers only to display prices and rewards.
 */
export const ECONOMY = {
	/** coins for every in-game day survived (validated by the server against real session time) */
	COINS_PER_DAY: 3,
	/** extra coins the first time the player reaches a day that is a multiple of MILESTONE_EVERY */
	MILESTONE_EVERY: 5,
	MILESTONE_BONUS: 10,
	/** coins for each boss killed */
	COINS_PER_BOSS: 8,
	/** one-time gift for a brand-new save so the shop can be tried right away */
	STARTING_COINS: 20,
	/** pending (bought but not yet delivered) packs of the same kind */
	MAX_PENDING_PACKS: 20,
} as const;

/** price of the n-th continue after a game over (deathCount = continues already bought) */
export function rebirthPrice(deathCount: number): number {
	const d = math.max(0, math.floor(deathCount));
	return d * d * 10 + 10;
}

export interface PackItem {
	kind: ItemKind;
	index: number;
	count: number;
}

export interface ShopPack {
	id: number;
	name: string;
	contents: string;
	price: number;
	/** what the pack delivers at the start of the next game (resolved by item name) */
	items: Array<PackItem>;
}

function findIndex(kind: ItemKind, name: string): number {
	const list: Array<{ id: number; name: string }> =
		kind === ItemKind.Weapon
			? WEAPONS
			: kind === ItemKind.Equip
				? EQUIPS
				: kind === ItemKind.Use
					? USABLES
					: ETC_ITEMS;
	for (const def of list) {
		if (def.name === name) return def.id;
	}
	warn(`[shop] item not found: kind ${kind} "${name}"`);
	return -1;
}

function item(kind: ItemKind, name: string, count: number): PackItem {
	return { kind, index: findIndex(kind, name), count };
}

export const SHOP_PACKS: Array<ShopPack> = [
	{
		id: 0,
		name: "First Night Kit",
		contents: "1 × Cotton clothes#1 × Axe#1 × Flashlight",
		price: 20,
		items: [
			item(ItemKind.Equip, "Cotton clothes", 1),
			item(ItemKind.Weapon, "Axe", 1),
			item(ItemKind.Equip, "Flashlight", 1),
		],
	},
	{
		id: 1,
		name: "Pantry Crate",
		contents: "3 × Cooked meat#3 × Pizza#3 × Cooked meal",
		price: 20,
		items: [
			item(ItemKind.Use, "Cooked meat", 3),
			item(ItemKind.Use, "Pizza", 3),
			item(ItemKind.Use, "Cooked meal", 3),
		],
	},
	{
		id: 2,
		name: "Medic Bag",
		contents: "2 × First aid kit#3 × Bandage#2 × Adrenaline",
		price: 30,
		items: [
			item(ItemKind.Use, "First aid kit", 2),
			item(ItemKind.Use, "Bandage", 3),
			item(ItemKind.Use, "Adrenaline", 2),
		],
	},
	{
		id: 3,
		name: "Builder's Basics",
		contents: "20 × Wood#10 × Cloth#20 × Stone",
		price: 10,
		items: [item(ItemKind.Etc, "Wood", 20), item(ItemKind.Etc, "Cloth", 10), item(ItemKind.Etc, "Stone", 20)],
	},
	{
		id: 4,
		name: "Workshop Supplies",
		contents: "5 × Blueprint#20 × Steel#10 × Machine parts",
		price: 20,
		items: [
			item(ItemKind.Etc, "Blueprint", 5),
			item(ItemKind.Etc, "Steel", 20),
			item(ItemKind.Etc, "Machine parts", 10),
		],
	},
	{
		id: 5,
		name: "Electronics Box",
		contents: "5 × Battery#2 × Computer chip#2 × Bulb",
		price: 20,
		items: [
			item(ItemKind.Etc, "Battery", 5),
			item(ItemKind.Etc, "Computer chip", 2),
			item(ItemKind.Etc, "Bulb", 2),
		],
	},
	{
		id: 6,
		name: "Ammo Makings",
		contents: "10 × Steel#10 × Gunpowder",
		price: 20,
		items: [item(ItemKind.Etc, "Steel", 10), item(ItemKind.Etc, "Gunpowder", 10)],
	},
	{
		id: 7,
		name: "Pet Pigeon",
		contents: "1 × Pigeon",
		price: 10,
		items: [item(ItemKind.Equip, "Pigeon", 1)],
	},
	{
		id: 8,
		name: "Pet Carolina",
		contents: "1 × Carolina",
		price: 10,
		items: [item(ItemKind.Equip, "Carolina", 1)],
	},
];

export interface CostumeDef {
	id: number;
	name: string;
	/** coin price (the original sold these for real money; here they are unlocked with coins earned in game) */
	price: number;
	/**
	 * the cosmetic this costume unlocks permanently (EQUIPS index, kind 4): an outfit or a pet, by
	 * shared/data/cosmetics.ts `cosmeticSlotOf` (MON-04)
	 */
	equipId: number;
}

function costume(id: number, name: string, price: number): CostumeDef {
	return { id, name, price, equipId: findIndex(ItemKind.Equip, name) };
}

export const COSTUMES: Array<CostumeDef> = [
	costume(0, "Pigeon", 30),
	costume(1, "White pigeon", 30),
	costume(2, "Eagle", 50),
	costume(3, "Carolina", 30),
	costume(4, "Malamute", 30),
	costume(5, "Doberman", 30),
	costume(6, "Santa", 30),
	costume(7, "Zombie", 30),
	costume(8, "Cowboy", 30),
];

/** costume that permanently unlocks the given deco equipment, if any */
export function costumeForEquip(equipId: number): CostumeDef | undefined {
	for (const c of COSTUMES) {
		if (c.equipId === equipId) return c;
	}
	return undefined;
}
