/*
 * The Robux side of the wardrobe (docs/SHOP.md "Robux: decisões e desenho"; DESIGN_RULES MON-01, MON-04, MON-07).
 *
 * The owner's decision of 2026-09-24 (delegated to the orchestrator): the SAME outfits and pets the wardrobe sells for
 * coins can also be bought with Robux -- cosmetics only, never coins, packs, a Rebirth, XP or time. ONE developer product
 * per costume: a receipt carries nothing but its ProductId (and who, and a PurchaseId), so the product itself must name
 * the item -- a product per tier would need the server to REMEMBER which costume was asked for, and that memory is gone
 * exactly when a receipt comes late (a crash, a rejoin on another server, a purchase made outside the game).
 *
 * WHERE THE OWNER PASTES THE IDS: `ROBUX_PRODUCT_IDS` below, by the costume's name, once each product exists in the
 * Creator Hub (Monetization > Developer Products; name, price, description and settings in docs/SHOP.md). 0 = not
 * created: no Robux button for that costume, and the coin path unchanged. The price of each is its tier's
 * (shared/data/shop.ts `ROBUX_TIER_PRICE`), and the server checks it against Roblox's own at boot
 * (server/save/robux.ts): a product whose price or sale state differs is not offered.
 */
import { COSTUMES, ROBUX_TIER_PRICE } from "./shop";

/**
 * The attribute on ReplicatedStorage.Net where the server publishes what it verified: "costumeId=price;…" (only the
 * costumes whose product is for sale at its tier's price). Absent or empty: nothing is sold for Robux.
 */
export const ROBUX_OFFER_ATTR = "pz_robux_products";

/** developer product id of each costume, by its COSTUMES name; 0 = not created yet */
export const ROBUX_PRODUCT_IDS: { [costumeName: string]: number } = {
	Pigeon: 0,
	"White pigeon": 0,
	Carolina: 0,
	Malamute: 0,
	Doberman: 0,
	Santa: 0,
	Cowboy: 0,
	Eagle: 0,
	Zombie: 0,
};

/** the Robux price of COSTUMES[costumeId] (its tier's), or undefined for none */
export function robuxPriceOf(costumeId: number): number | undefined {
	const c = COSTUMES[costumeId];
	return c !== undefined ? ROBUX_TIER_PRICE[c.tier] : undefined;
}

function isProductId(v: unknown): v is number {
	return typeIs(v, "number") && v === v && v % 1 === 0 && v > 0;
}

/** the product id configured for COSTUMES[costumeId], or 0 */
export function productIdOf(costumeId: number): number {
	const c = COSTUMES[costumeId];
	if (c === undefined) return 0;
	const id = ROBUX_PRODUCT_IDS[c.name];
	return isProductId(id) ? id : 0;
}

/**
 * The costume a product id grants, or -1: an id nobody configured, or one two costumes claim (a paste error sells
 * neither: a receipt must never be able to mean two things).
 */
export function costumeOfProduct(productId: unknown): number {
	if (!isProductId(productId)) return -1;
	let found = -1;
	for (const c of COSTUMES) {
		if (productIdOf(c.id) !== productId) continue;
		if (found >= 0) return -1;
		found = c.id;
	}
	return found;
}

/** "0=49;7=349" -- the offer the server verified, for the attribute */
export function encodeRobuxOffer(offer: ReadonlyMap<number, number>): string {
	const parts: Array<string> = [];
	for (const c of COSTUMES) {
		const price = offer.get(c.id);
		if (price !== undefined) parts.push(`${c.id}=${price}`);
	}
	return parts.join(";");
}

/** the attribute back into costume id -> Robux price; anything malformed is left out */
export function decodeRobuxOffer(raw: unknown): Map<number, number> {
	const out = new Map<number, number>();
	if (!typeIs(raw, "string") || raw.size() === 0 || raw.size() > 400) return out;
	for (const part of raw.split(";")) {
		const kv = part.split("=");
		if (kv.size() !== 2) continue;
		const id = tonumber(kv[0]);
		const price = tonumber(kv[1]);
		if (id === undefined || price === undefined || COSTUMES[id] === undefined || id % 1 !== 0) continue;
		if (price !== robuxPriceOf(id)) continue;
		out.set(id, price);
	}
	return out;
}
