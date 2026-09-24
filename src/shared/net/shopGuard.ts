/*
 * The ShopAction's own rules (docs/MULTIPLAYER.md §8.1, §8.2), in one pure module both sides load:
 *
 *   the bucket    2 a second, a burst of 6 (SHOP_RATE / SHOP_BURST). The server refuses past it ("rate", with no
 *                 wallet: a refusal must not be a reflector); the client keeps the SAME bucket and answers "rate"
 *                 itself (client/systems/saveClient.ts), so an honest client never sends what the server would only
 *                 refuse -- and never comes near the flood line below, however fast Buy is clicked. `viewShop` (the
 *                 shop opened: analytics only, nothing charged) takes no token on either side.
 *   the flood     §8.2 "> 3× o limite por 5 s": more than SHOP_FLOOD_CALLS token-taking ShopActions in one
 *                 FLOOD_RATE_WINDOW_S window is the automatic kick (server/net/mpHost.ts `noteRemote`). The bucket
 *                 lets at most SHOP_BURST + SHOP_RATE × FLOOD_RATE_WINDOW_S = 16 through in that time.
 *   the receipt   a pack purchase carries a client nonce (a whole number, 1..SHOP_NONCE_MAX). The server keeps the
 *                 receipts of the last SHOP_RECEIPTS purchases it accepted in the session, and the same nonce again is
 *                 answered as the first time, never charged twice. The rest of the shop is idempotent by what it
 *                 does: a costume answers "owned", a title is shown or not, a Rebirth / New game names its runRev.
 *
 * No Instances, no services: tools/test-net.mjs fuzzes it, and tools/test-body.mjs drives it through the real server.
 */
import { FLOOD_RATE_MULT, FLOOD_RATE_WINDOW_S, SHOP_BURST, SHOP_RATE } from "./mpConfig";

/** token-taking ShopActions in one FLOOD_RATE_WINDOW_S window past which the connection is kicked (§8.2) */
export const SHOP_FLOOD_CALLS = SHOP_RATE * FLOOD_RATE_MULT * FLOOD_RATE_WINDOW_S;
/** the largest purchase nonce (a whole number from 1): the client counts up from 1 in each session */
export const SHOP_NONCE_MAX = 2147483647;
/** accepted purchases remembered per session: an honest client has one purchase in flight at a time */
export const SHOP_RECEIPTS = 8;

/** one side's copy of the ShopAction token bucket */
export interface ShopBucket {
	tokens: number;
	at: number;
}

export function newShopBucket(now: number): ShopBucket {
	return { tokens: SHOP_BURST, at: now };
}

/** one ShopAction against the bucket: false = refuse it ("rate") */
export function takeShopToken(bucket: ShopBucket, now: number): boolean {
	const elapsed = now - bucket.at;
	if (elapsed > 0) bucket.tokens = math.min(SHOP_BURST, bucket.tokens + elapsed * SHOP_RATE);
	// a clock that went backwards restarts the bucket rather than stalling it
	bucket.at = now;
	if (bucket.tokens < 1) return false;
	bucket.tokens -= 1;
	return true;
}

/** does a ShopAction of this kind take a token (and count toward the flood line)? Everything but `viewShop` */
export function takesShopToken(kind: unknown): boolean {
	return kind !== "viewShop";
}

/** a purchase nonce as the wire must carry it: a whole number in 1..SHOP_NONCE_MAX */
export function isShopNonce(v: unknown): v is number {
	return typeIs(v, "number") && v % 1 === 0 && v >= 1 && v <= SHOP_NONCE_MAX;
}

/** an accepted pack purchase, as the server remembers it */
export interface ShopReceipt {
	nonce: number;
	packId: number;
	price: number;
}

/** the kept receipt of `nonce`, or undefined (a purchase not seen, or older than the last SHOP_RECEIPTS) */
export function receiptOf(receipts: ReadonlyArray<ShopReceipt>, nonce: number): ShopReceipt | undefined {
	for (const r of receipts) {
		if (r.nonce === nonce) return r;
	}
	return undefined;
}

/** keeps the receipt of a purchase the server just accepted: the newest SHOP_RECEIPTS stay */
export function keepReceipt(receipts: Array<ShopReceipt>, receipt: ShopReceipt): void {
	receipts.push(receipt);
	while (receipts.size() > SHOP_RECEIPTS) receipts.shift();
}
