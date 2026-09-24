/*
 * What THIS player pays for a costume's Robux product, for the wardrobe to show (docs/SHOP.md "Robux"; the review of the
 * Robux work, L3). Roblox Plus subscribers pay 10-20% less and Managed (regional) Pricing can change a price too, so the
 * tier's number (shared/data/shop.ts ROBUX_TIER_PRICE) is not necessarily what Roblox's prompt will ask of them: the
 * docs' own warning ("if you hard-code prices, your in-game UI might display incorrect pricing to Plus subscribers").
 * So the price is asked from the client, where GetProductInfoAsync answers for this user, and while it is not known
 * the wardrobe shows no number at all. Display only: the server decides what is offered (server/save/robux.ts) and the
 * prompt is what charges.
 */
import { productIdOf } from "shared/data/robuxProducts";

/** a failed or throttled read is asked again no sooner than this (s), and only when a screen wants it again */
const RETRY_S = 30;

/** costume id -> what this player pays in Robux */
const prices = new Map<number, number>();
const asking = new Set<number>();
const listeners = new Set<() => void>();

/** what this player pays for COSTUMES[costumeId] in Robux, or undefined while it is not known */
export function robuxPriceShown(costumeId: number): number | undefined {
	return prices.get(costumeId);
}

/** asks Roblox for that price once (in the background); `onRobuxPrice` listeners hear when it comes */
export function askRobuxPrice(costumeId: number): void {
	if (prices.has(costumeId) || asking.has(costumeId)) return;
	const productId = productIdOf(costumeId);
	if (productId === 0) return;
	asking.add(costumeId);
	// its own thread (the read yields), started on the next resumption: the screen that asked is never held up
	task.defer(() => {
		const [ok, info] = pcall(() =>
			game.GetService("MarketplaceService").GetProductInfoAsync(productId, Enum.InfoType.Product),
		);
		const price = ok && typeIs(info, "table") ? (info as Record<string, unknown>).PriceInRobux : undefined;
		if (typeIs(price, "number") && price === price && price >= 0 && price % 1 === 0) {
			prices.set(costumeId, price);
			asking.delete(costumeId);
			for (const fn of listeners) task.defer(fn);
			return;
		}
		task.delay(RETRY_S, () => asking.delete(costumeId));
	});
}

/** `fn` runs when a price becomes known; returns the unsubscribe */
export function onRobuxPrice(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}
