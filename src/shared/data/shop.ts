import { ItemKind } from "./kinds";
import { WEAPONS } from "./weapons";
import { EQUIPS } from "./equips";
import { USABLES } from "./usables";
import { ETC_ITEMS } from "./etcItems";
import { petLookOfEquip } from "./cosmetics";
import { DAY_REAL_SECONDS, NIGHT_REAL_SECONDS } from "shared/sim/clock";

/*
 * The whole economy in one place (docs/SHOP.md): what the SERVER pays, what everything costs, and the model the prices
 * are set against. The server is the only place where coins change (server/main.server.ts, server/sim/progress.ts,
 * server/save/costumes.ts); every screen that shows a price or a reward imports it from here, and so does
 * tools/test-shop.mjs, which fails when a price leaves the band of play its tier promises, or when a screen shows a
 * number the server does not charge.
 *
 * Coins are only ever EARNED BY PLAYING (MON-01): nothing here is sold for Robux (docs/SHOP.md has the Robux plan and
 * why it is only a plan).
 */

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
	/** one-time gift for a brand-new save so the shop can be tried right away (it buys a starter pack) */
	STARTING_COINS: 20,
	/** pending (bought but not yet delivered) packs of the same kind */
	MAX_PENDING_PACKS: 20,
} as const;

// ---------------------------------------------------------------- the model (docs/SHOP.md "O modelo")

/**
 * Real seconds of one game day: 06:00 → 19:00 at day speed plus 19:00 → 06:00 at night speed (shared/sim/clock.ts,
 * ~605 s). Midnight pays COINS_PER_DAY once per game day to whoever lived it (server/sim/progress.ts `dayRefusal`).
 */
export const GAME_DAY_SECONDS = DAY_REAL_SECONDS + NIGHT_REAL_SECONDS;

/**
 * How a kind of player earns, per hour spent in the city. Assumptions, written down so they can be argued with (and
 * checked against the Economy dashboard once the game is public: docs/ANALYTICS.md, "Day survived" / "Boss" sources):
 */
export interface IncomeProfile {
	/**
	 * The share of midnights that pay: alive at midnight, in the world half the day, not AFK (`dayRefusal`). A death
	 * between 19:00 and midnight lies through it, so the day is not paid.
	 */
	paidDays: number;
	/** bosses this player helps bring down per hour (MP-15: every participant is paid COINS_PER_BOSS) */
	bossesPerHour: number;
	/** new record days that are a multiple of MILESTONE_EVERY, per hour, averaged over the first ~30 hours */
	recordsPerHour: number;
	/**
	 * Hours of play one LIFE lasts: from its day 1 to a New game or the end of its town (MP-22: everybody down and nobody
	 * paying). A pet pack's pet lives exactly that long (`resetRun` takes it), which is what a rental is priced against.
	 */
	lifeHours: number;
}

export const INCOME_PROFILES = {
	/** dies most nights in waves 1-2 (so the midnight is lost), never near a boss, reaches day 5 in the first ~7 h */
	new: { paidDays: 0.4, bossesPerHour: 0, recordsPerHour: 0.15, lifeHours: 1.5 },
	/** lives most nights, helps with a boss every other hour, a record of ~30 days after ~30 h */
	average: { paidDays: 0.7, bossesPerHour: 0.5, recordsPerHour: 0.2, lifeHours: 4 },
	/** nearly never misses a midnight, hunts bosses (they wake from world day 5, every 3 days), ~45 days in ~30 h */
	strong: { paidDays: 0.95, bossesPerHour: 1.5, recordsPerHour: 0.3, lifeHours: 10 },
} as const;
export type IncomeProfileName = keyof typeof INCOME_PROFILES;

/** coins an hour of play earns a player of this profile, from the SAME numbers the server pays with */
export function coinsPerHour(profile: IncomeProfile): number {
	const days = 3600 / GAME_DAY_SECONDS;
	return (
		days * profile.paidDays * ECONOMY.COINS_PER_DAY +
		profile.recordsPerHour * ECONOMY.MILESTONE_BONUS +
		profile.bossesPerHour * ECONOMY.COINS_PER_BOSS
	);
}

/** hours of play `coins` cost a player of this profile (the average player by default) */
export function hoursOfPlay(coins: number, profile: IncomeProfile = INCOME_PROFILES.average): number {
	return coins / coinsPerHour(profile);
}

/**
 * The tiers every price belongs to, and the hours of AVERAGE play each one must cost (inclusive band). The owner's
 * direction (2026-09-24): "the values must make sense and be challenging" -- a common cosmetic ~3-5 h, a rare one
 * ~10-15 h, the top ones 25 h and more; the first purchase within the first session or two.
 *
 *   starter  the packs a new survivor can buy first: the welcome gift pays for one (STARTING_COINS)
 *   supply   the other packs: consumables and materials, a few hours of play each (MON-01 note in MON-03)
 *   rental   a pet pack: the pet for THIS LIFE -- until a New game or the end of the town (MP-22), both of which start a
 *            new life (`resetRun`) -- at a fraction of what keeping it for good costs (PET_RENTAL_SHARE)
 *   common / rare / top   the wardrobe's outfits and pets, kept for good (MON-04)
 */
export type PriceTier = "starter" | "supply" | "rental" | "common" | "rare" | "top";

export interface HoursBand {
	min: number;
	max: number;
}

export const PRICE_TIERS: { readonly [K in PriceTier]: HoursBand } = {
	starter: { min: 0.5, max: 1.5 },
	supply: { min: 1.5, max: 4 },
	rental: { min: 0.5, max: 1.5 },
	common: { min: 3, max: 5 },
	rare: { min: 10, max: 15 },
	top: { min: 25, max: 40 },
};

/**
 * A pet pack costs at most this share of keeping the same pet for good. It lasts one life (a New game or the town's end
 * takes it), so renting it life after life costs more than buying it from the third life on (1 / 0.35 ≈ 2.9) -- the
 * wardrobe's is the better deal for anyone who keeps the pet, the pack a cheap way to try one for a life.
 */
export const PET_RENTAL_SHARE = 0.35;

/**
 * Robux, the owner's decision of 2026-09-24 (delegated to the orchestrator; docs/SHOP.md "Robux: decisões e desenho"):
 * the SAME outfits and pets the wardrobe sells for coins can also be bought with Robux, one developer product per costume
 * (src/shared/data/robuxProducts.ts), at the price of its tier. Only cosmetics: never coins, packs, a Rebirth, XP or time
 * (MON-01). ~11-13 Robux per hour of average play the coin price asks (tools/test-shop.mjs checks the band).
 */
export const ROBUX_TIER_PRICE: { readonly [K in PriceTier]?: number } = {
	common: 49,
	rare: 149,
	top: 349,
};

/** the model's promises about the early game and the long tail (tools/test-shop.mjs checks each) */
export const ECONOMY_TARGETS = {
	/** a new player buys a starter pack from their play alone (the gift aside) within this many hours */
	newPlayerFirstPackHours: 2,
	/** a top-tier cosmetic costs even a strong player at least this many hours */
	topTierStrongHours: 15,
	/** Rebirth, in hours of average play: the first continue of a life (a first mistake is not a paywall, BEM-08) */
	firstRebirth: { min: 0.25, max: 1.5 },
	/** …the third continue of the same life: a real decision */
	thirdRebirthMinHours: 2,
	/** …the fifth: more than most of a rare cosmetic */
	fifthRebirthMinHours: 8,
	/** a pet pack costs at most this share of the average LIFE it lasts, in hours of play (earned back within it) */
	rentalShareOfLife: 0.5,
	/** Robux per hour of average play a cosmetic's coin price asks: the Robux price never undercuts play, nor gouges */
	robuxPerHour: { min: 8, max: 16 },
} as const;

// ---------------------------------------------------------------- Rebirth

/**
 * Price of the n-th continue after a game over (deathCount = continues already bought IN THIS LIFE: `resetRun` puts it
 * back to 0). Dead Town's own curve, kept: 10, 20, 50, 100, 170, 260… -- half an hour of average play for the first,
 * about nine for the fifth (docs/SHOP.md). The free way back is the wait for daybreak (MP-21).
 */
export function rebirthPrice(deathCount: number): number {
	const d = math.max(0, math.floor(deathCount));
	return d * d * 10 + 10;
}

/**
 * The Player attribute (true, or absent) where the server says this survivor's daybreak already came while they waited
 * in the lobby (server/sim/life.ts `daybreakDue`): the next entry stands them up for nothing, so a Rebirth asked now is
 * not charged (server/main.server.ts). The lobby shows that price -- 0 -- instead of one the server would not take.
 */
export const REBIRTH_FREE_ATTR = "pz_rebirth_free";

/** what a Rebirth costs right now: nothing when the daybreak already came (`free`), else the continue's price */
export function rebirthCharge(deathCount: number, free: boolean): number {
	return free ? 0 : rebirthPrice(deathCount);
}

// ---------------------------------------------------------------- packs

export interface PackItem {
	kind: ItemKind;
	index: number;
	count: number;
}

export interface ShopPack {
	id: number;
	name: string;
	/** "count × item" lines, "#"-separated -- written from `items`, never by hand (one source for the contents) */
	contents: string;
	price: number;
	/** the band of play this price is set in (PRICE_TIERS) */
	tier: PriceTier;
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

/** one line of a pack: the item by its catalogue name, and the name kept for the contents line */
interface NamedItem {
	item: PackItem;
	name: string;
}

function item(kind: ItemKind, name: string, count: number): NamedItem {
	return { item: { kind, index: findIndex(kind, name), count }, name };
}

function pack(id: number, name: string, price: number, tier: PriceTier, lines: Array<NamedItem>): ShopPack {
	const items: Array<PackItem> = [];
	const contents: Array<string> = [];
	for (const l of lines) {
		items.push(l.item);
		contents.push(`${l.item.count} × ${l.name}`);
	}
	return { id, name, contents: contents.join("#"), price, tier, items };
}

/** prices: docs/SHOP.md, "Por que cada preço" */
export const SHOP_PACKS: Array<ShopPack> = [
	pack(0, "First Night Kit", 20, "starter", [
		item(ItemKind.Equip, "Cotton clothes", 1),
		item(ItemKind.Weapon, "Axe", 1),
		item(ItemKind.Equip, "Flashlight", 1),
	]),
	pack(1, "Pantry Crate", 30, "supply", [
		item(ItemKind.Use, "Cooked meat", 3),
		item(ItemKind.Use, "Pizza", 3),
		item(ItemKind.Use, "Cooked meal", 3),
	]),
	pack(2, "Medic Bag", 45, "supply", [
		item(ItemKind.Use, "First aid kit", 2),
		item(ItemKind.Use, "Bandage", 3),
		item(ItemKind.Use, "Adrenaline", 2),
	]),
	pack(3, "Builder's Basics", 15, "starter", [
		item(ItemKind.Etc, "Wood", 20),
		item(ItemKind.Etc, "Cloth", 10),
		item(ItemKind.Etc, "Stone", 20),
	]),
	pack(4, "Workshop Supplies", 60, "supply", [
		item(ItemKind.Etc, "Blueprint", 5),
		item(ItemKind.Etc, "Steel", 20),
		item(ItemKind.Etc, "Machine parts", 10),
	]),
	pack(5, "Electronics Box", 60, "supply", [
		item(ItemKind.Etc, "Battery", 5),
		item(ItemKind.Etc, "Computer chip", 2),
		item(ItemKind.Etc, "Bulb", 2),
	]),
	pack(6, "Ammo Makings", 40, "supply", [item(ItemKind.Etc, "Steel", 10), item(ItemKind.Etc, "Gunpowder", 10)]),
	pack(7, "Pet Pigeon", 20, "rental", [item(ItemKind.Equip, "Pigeon", 1)]),
	pack(8, "Pet Carolina", 20, "rental", [item(ItemKind.Equip, "Carolina", 1)]),
];

/** the pet a pack delivers (EQUIPS id; MON-04 `petLookOfEquip`), or -1 when it is not a pet pack */
export function petOfPack(p: ShopPack): number {
	for (const it of p.items) {
		if (it.kind === ItemKind.Equip && petLookOfEquip(it.index) !== 0) return it.index;
	}
	return -1;
}

// ---------------------------------------------------------------- the wardrobe

export interface CostumeDef {
	id: number;
	name: string;
	/** coin price (the original sold these for real money; here they are unlocked with coins earned in game) */
	price: number;
	/** the band of play this price is set in (PRICE_TIERS: common, rare or top) */
	tier: PriceTier;
	/**
	 * the cosmetic this costume unlocks permanently (EQUIPS index, kind 4): an outfit or a pet, by
	 * shared/data/cosmetics.ts `cosmeticSlotOf` (MON-04)
	 */
	equipId: number;
}

function costume(id: number, name: string, price: number, tier: PriceTier): CostumeDef {
	return { id, name, price, tier, equipId: findIndex(ItemKind.Equip, name) };
}

/** prices: docs/SHOP.md, "Por que cada preço" */
export const COSTUMES: Array<CostumeDef> = [
	costume(0, "Pigeon", 70, "common"),
	costume(1, "White pigeon", 90, "common"),
	costume(2, "Eagle", 600, "top"),
	costume(3, "Carolina", 70, "common"),
	costume(4, "Malamute", 220, "rare"),
	costume(5, "Doberman", 220, "rare"),
	costume(6, "Santa", 250, "rare"),
	costume(7, "Zombie", 600, "top"),
	costume(8, "Cowboy", 250, "rare"),
];

/** costume that permanently unlocks the given deco equipment, if any */
export function costumeForEquip(equipId: number): CostumeDef | undefined {
	for (const c of COSTUMES) {
		if (c.equipId === equipId) return c;
	}
	return undefined;
}
