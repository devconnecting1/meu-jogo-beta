/*
 * Buying a costume with coins: the wardrobe's purchase, decided by the SERVER (DESIGN_RULES MON-04, MP-00).
 *
 * The wardrobe (client/ui/wardrobe.ts) only ever sends `{ kind: "buyCostume", costumeId }` through the ShopAction
 * RemoteFunction; server/main.server.ts `handleAction` hands the session's live save and that raw id to
 * `buyCostume` below, and it is the only code that turns coins into a costume. Everything the client could lie
 * about is decided here instead:
 *
 *   - WHICH costume: the id must be a whole index of COSTUMES (shared/data/shop.ts). A number out of range, a
 *     fraction, NaN, a string, a table -- all "invalid", before anything is read from the catalogue.
 *   - WHAT it is: the costume must unlock a cosmetic this game draws (an outfit or a pet, `cosmeticSlotOf`). A
 *     catalogue row whose item did not resolve is not sold: MON-04 is "what was bought is drawn", and a row that
 *     cannot be drawn would be coins for nothing.
 *   - THE PRICE: read from COSTUMES, never from the request. A request carrying `price: 0` is charged the
 *     catalogue price like any other; there is no field it could set.
 *   - OWNERSHIP: a costume already bought is refused ("owned"), so a double click or a replayed request never
 *     charges twice. Ownership is `save.costumes`, which only this function (and the admin panel) writes.
 *   - THE COINS: not enough is refused ("funds") and nothing moves; enough is taken in the same step that grants
 *     the costume. There is no yield between the check and the write, so the two cannot be separated by another
 *     request of the same player: the RemoteFunction handler runs this synchronously on the session's one save
 *     table, and the next autosave (or the player leaving) carries both changes to the DataStore together.
 *
 * Pure: no Instances, no services, so tools/test-save.mjs drives it directly, and tools/test-body.mjs through the
 * real ShopAction remote of a booted server.
 */
import { COSTUMES } from "shared/data/shop";
import { cosmeticSlotOf } from "shared/data/cosmetics";
import { PlayerSaveData } from "shared/game/save";
import { ShopActionReason } from "shared/net/net";

export type CostumePurchase = { ok: true; costumeId: number; price: number } | { ok: false; reason: ShopActionReason };

/** a whole index into a list of `size` entries (the id travels through a RemoteFunction: it may be anything) */
function isIndex(v: unknown, size: number): v is number {
	return typeIs(v, "number") && v === v && v % 1 === 0 && v >= 0 && v < size;
}

/** the catalogue price, when it is one a purchase can charge (a whole, non-negative number of coins) */
function priceOf(costumeId: number): number | undefined {
	const price = COSTUMES[costumeId].price;
	if (!typeIs(price, "number") || price !== price || price % 1 !== 0 || price < 0) return undefined;
	return price;
}

/**
 * Buys costume `costumeId` for the owner of `save`, or explains why not. On success the coins are already taken
 * and the costume is already the player's; on a refusal `save` is untouched.
 */
export function buyCostume(save: PlayerSaveData, costumeId: unknown): CostumePurchase {
	if (!isIndex(costumeId, COSTUMES.size())) return { ok: false, reason: "invalid" };
	const costume = COSTUMES[costumeId];
	if (costume.equipId < 0 || cosmeticSlotOf(costume.equipId) === 0) return { ok: false, reason: "invalid" };
	const price = priceOf(costumeId);
	if (price === undefined) return { ok: false, reason: "invalid" };
	if ((save.costumes[costumeId] ?? 0) > 0) return { ok: false, reason: "owned" };
	if (save.money < price) return { ok: false, reason: "funds" };
	save.money -= price;
	save.costumes[costumeId] = 1;
	return { ok: true, costumeId, price };
}
