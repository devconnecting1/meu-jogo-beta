/*
 * The wardrobe's costumes for Robux, decided by the SERVER (docs/SHOP.md "Robux: decisões e desenho"; DESIGN_RULES
 * MON-01, MON-04, MON-07, BEM-02). Sources: creator-docs developer-products.md, player-data-purchasing.md,
 * MarketplaceService.yaml, roblox-plus.md, regional-pricing.md (Context7, 2026-09-24).
 *
 *   THE PRODUCTS  one developer product per costume (shared/data/robuxProducts.ts): the ProductId alone names the item,
 *                 so a receipt that comes late -- after a crash, on another server, from outside the game -- grants the
 *                 right costume or nothing, never the wrong one. At boot (and every VERIFY_EVERY_S) each configured id is
 *                 checked with GetProductInfoAsync: for sale, at its tier's price. Only those are offered; the offer is
 *                 published on the Net folder (`pz_robux_products`). A read that fails keeps what the product last was
 *                 and is tried again in VERIFY_RETRY_S; every change of a product's state is warned. No id: no offer, no
 *                 Robux button, the coin path as it was.
 *   THE PROMPT    the client asks (ShopAction `robuxCostume`, the costume id and nothing else); THIS server opens
 *                 Roblox's prompt, and only for a costume offered, not owned, not held (below), on a session that can
 *                 record a purchase, with no other Robux prompt open for that player.
 *   THE HOLDS     a costume a Robux payment may be on its way for is sold neither for coins nor in a second prompt
 *                 ("pending"), so nobody pays twice for one costume:
 *                   - its prompt is open (at most PROMPT_HOLD_S, or until it closes unbought);
 *                   - its prompt closed PURCHASED: held until its receipt is granted or the player leaves -- no timer, a
 *                     receipt can take its time;
 *                   - its receipt was answered NotProcessedYet while the player was here (the save not loaded, read-only,
 *                     or the write failing): held for the rest of the session -- Roblox asks again only at their next
 *                     join, and a load retried from the lobby would otherwise show the costume unowned and sellable.
 *                 The last two are published on the Player (`pz_robux_pending`): the wardrobe says Pending.
 *   THE RECEIPT   ProcessReceipt, the recipe of player-data-purchasing.md on our session lock: the player must be in this
 *                 server (else NotProcessedYet: Roblox tries again at their next join) with a save loaded and writable
 *                 (a load in progress is waited for while they stay, up to RECEIPT_LOAD_WAIT_S: the load's own worst
 *                 case); the PurchaseId is looked up in the save (`robuxReceipts`, save v8) -- already granted:
 *                 PurchaseGranted once a write holding it has landed; new: the costume and the PurchaseId go into the
 *                 save and the save is WRITTEN NOW (UpdateAsync under the lock, outside the coalesced cadence: SAV-01's
 *                 documented exception), and only a write that landed answers PurchaseGranted. Any failure answers
 *                 NotProcessedYet; the grant stays in the session (the trade-off the docs accept: "free for the duration
 *                 of the session") and the next call finds the PurchaseId and tries the write again.
 *                 PromptProductPurchaseFinished's `isPurchased` never grants.
 *   OWNED ALREADY never offered, and the prompt is refused. A receipt that still comes (a purchase outside the game, if the
 *                 owner ever lists the products) is acknowledged with nothing new to grant -- Roblox has no refund API --
 *                 and reported (`RobuxOwned`, a `[PZ-ROBUX]` line) for the owner to make good by hand. Never coins: that
 *                 would sell coins for Robux (MON-01).
 */
import { GAME_NAME } from "shared/module";
import { COSTUMES, CostumeDef } from "shared/data/shop";
import { cosmeticSlotOf } from "shared/data/cosmetics";
import {
	ROBUX_OFFER_ATTR,
	ROBUX_PENDING_ATTR,
	costumeOfProduct,
	encodeCostumeList,
	encodeRobuxOffer,
	productIdOf,
	robuxPriceOf,
} from "shared/data/robuxProducts";
import { PURCHASE_ID_MAX, PlayerSaveData, isPurchaseId, robuxReceiptOf, trimReceipts } from "shared/game/save";
import { ShopActionReason } from "shared/net/net";
import * as Analytics from "../analytics/events";

/** an OPEN Robux prompt keeps its costume from being bought with coins at most this long (s), or until it closes */
export const PROMPT_HOLD_S = 120;
/**
 * ProcessReceipt waits at most this long for the buyer's save to load (s), and only while they are here. The load's own
 * worst case (server/main.server.ts `readSession`): a same-server rejoin waits for the last session's write (20 s), then
 * the other server's lock (LOCK_WAIT, 22 s, polled every 2 s), the UpdateAsync attempts and their backoff (1 + 2 + 4 s),
 * the legacy store's (1 + 2 + 4 s), and each call's own latency -- about 60 s, with room to spare.
 */
export const RECEIPT_LOAD_WAIT_S = 90;
/** the offer is checked against Roblox's prices again this often (s): a price changed in the Creator Hub is caught */
export const VERIFY_EVERY_S = 600;
/** a product whose info could not be read is asked again this soon (s); what it last was stands meanwhile */
export const VERIFY_RETRY_S = 60;

/** what ProcessReceipt made of a receipt (the log, analytics and the tests read it) */
export type ReceiptOutcome =
	/** a new costume, granted and written */
	| "granted"
	/** a PurchaseId already in the save, now known to be in the DataStore */
	| "replayed"
	/** the costume was already owned: acknowledged, nothing new (reported) */
	| "owned"
	/** not a receipt this game can read (no PlayerId / PurchaseId) */
	| "invalid"
	/** a ProductId no costume is configured for */
	| "unknown"
	/** the buyer is not in this server, or left while it was handled */
	| "absent"
	/** the buyer's save did not load in time */
	| "loading"
	/** the session cannot record a purchase (a read-only load, no DataStore, the lock lost) */
	| "readonly"
	/** granted in the session, but the write did not land: asked again later */
	| "unsaved";

/** the NotProcessedYet answers given to a buyer who is HERE: their costume is held for the rest of the session */
const HELD_OUTCOMES = new Set<ReceiptOutcome>(["loading", "readonly", "unsaved"]);

export interface ReceiptResult {
	granted: boolean;
	outcome: ReceiptOutcome;
	userId?: number;
	costumeId?: number;
	purchaseId?: string;
}

/** what the session layer (server/main.server.ts) answers for a player */
export type SessionState = "ok" | "loading" | "closed" | "readonly";

export interface RobuxSession {
	readonly save: PlayerSaveData;
	readonly state: () => SessionState;
	/** writes the live save NOW under the session lock: true when the DataStore holds it as it is now */
	readonly commit: () => boolean;
}

export interface RobuxDeps {
	/** the live session of a player in this server (undefined: none) */
	readonly session: (player: Player) => RobuxSession | undefined;
	/** where the verified offer is published for the clients (ReplicatedStorage.Net) */
	net: Instance | undefined;
}

/** a product's state at its last successful check (a failed read changes nothing) */
type ProductState = "ok" | "price" | "offsale" | "twice";

const STATE_WORDS: { [K in ProductState]: string } = {
	ok: "offered",
	price: "not offered: its price is not the one docs/SHOP.md sets",
	offsale: "not offered: it is off sale",
	twice: "not offered: its id is configured for two costumes",
};

function isIndex(v: unknown, size: number): v is number {
	return typeIs(v, "number") && v === v && v % 1 === 0 && v >= 0 && v < size;
}

/** pure: puts COSTUMES[costumeId] and its receipt into `save`; "owned" when the costume was already owned */
export function grantRobuxCostume(save: PlayerSaveData, costumeId: number, purchaseId: string): "granted" | "owned" {
	const owned = (save.costumes[costumeId] ?? 0) > 0;
	save.costumes[costumeId] = 1;
	save.robuxReceipts.push({ c: costumeId, p: purchaseId });
	trimReceipts(save.robuxReceipts);
	return owned ? "owned" : "granted";
}

/**
 * pure: why a Robux prompt for `costumeId` is refused, or undefined when it may open. `offered`: the costume's product
 * passed the price check; `writable`: the session can record a purchase; `held`: a prompt is open, or this costume is
 * held (its payment may be on its way).
 */
export function robuxPromptRefusal(
	save: PlayerSaveData,
	costumeId: unknown,
	offered: boolean,
	writable: boolean,
	held: boolean,
): ShopActionReason | undefined {
	if (!isIndex(costumeId, COSTUMES.size())) return "invalid";
	const c = COSTUMES[costumeId];
	if (c.equipId < 0 || cosmeticSlotOf(c.equipId) === 0 || !offered) return "invalid";
	if (!writable) return "readonly";
	if ((save.costumes[costumeId] ?? 0) > 0) return "owned";
	if (held) return "pending";
	return undefined;
}

interface OpenPrompt {
	costumeId: number;
	at: number;
}

/** a purchase granted here whose first write failed: its analytics go out with the next write of the session that lands */
interface Unlogged {
	player: Player;
	costumeId: number;
	spent: number;
	channel: unknown;
	fresh: boolean;
}

function addTo(map: Map<number, Set<number>>, userId: number, costumeId: number): void {
	let set = map.get(userId);
	if (set === undefined) {
		set = new Set<number>();
		map.set(userId, set);
	}
	set.add(costumeId);
}

export class RobuxShop {
	/** costume id -> Robux price, for the products that passed the check (all the client is ever told) */
	private readonly offer = new Map<number, number>();
	/** product id -> its state at the last check that could read it */
	private readonly states = new Map<number, ProductState>();
	/** product ids whose last read failed (warned once per streak), and those with a retry scheduled */
	private readonly unread = new Set<number>();
	private readonly retrying = new Set<number>();
	/** user id -> the prompt open now (unconfirmed) */
	private readonly prompts = new Map<number, OpenPrompt>();
	/** user id -> costumes whose prompt closed purchased: held until the receipt is granted or the player leaves */
	private readonly awaiting = new Map<number, Set<number>>();
	/** user id -> costumes whose receipt was answered NotProcessedYet while they were here: held for the session */
	private readonly unanswered = new Map<number, Set<number>>();
	/** PurchaseId -> a grant whose event waits for a write that lands (once) */
	private readonly unlogged = new Map<string, Unlogged>();
	/** the last receipts handled, newest last (the admin log and the tests) */
	readonly results = new Array<ReceiptResult>();

	constructor(
		private readonly market: MarketplaceService,
		private readonly deps: RobuxDeps,
	) {}

	// ------------------------------------------------------------ the offer

	/** checks every configured product against Roblox's own price and sale state, and publishes what passed */
	verify(): void {
		for (const c of COSTUMES) this.check(c);
		this.publish();
	}

	/** the Robux price this server sells COSTUMES[costumeId] at, or undefined */
	priceOf(costumeId: number): number | undefined {
		return this.offer.get(costumeId);
	}

	private check(c: CostumeDef): void {
		const productId = productIdOf(c.id);
		const price = robuxPriceOf(c.id);
		if (productId === 0 || price === undefined) {
			this.offer.delete(c.id);
			return;
		}
		if (costumeOfProduct(productId) !== c.id) {
			this.settle(c, productId, "twice", price);
			return;
		}
		const [ok, info] = pcall(() => this.market.GetProductInfoAsync(productId, Enum.InfoType.Product));
		if (!ok || !typeIs(info, "table")) {
			// a failed or throttled read says nothing new: what this product last was stands, and it is asked again soon
			if (!this.unread.has(productId)) {
				this.unread.add(productId);
				this.warnLine(productId, "its info could not be read; it stays as it was, and is asked again shortly");
			}
			this.retry(c, productId);
			return;
		}
		this.unread.delete(productId);
		const read = info as Record<string, unknown>;
		const state: ProductState = read.IsForSale === false ? "offsale" : read.PriceInRobux !== price ? "price" : "ok";
		this.settle(c, productId, state, price);
	}

	/** records a product's state; every change is warned (the first "offered" is the normal case, and is not) */
	private settle(c: CostumeDef, productId: number, state: ProductState, price: number): void {
		const before = this.states.get(productId);
		this.states.set(productId, state);
		if (state === "ok") this.offer.set(c.id, price);
		else this.offer.delete(c.id);
		if (before !== state && !(before === undefined && state === "ok")) this.warnLine(productId, STATE_WORDS[state]);
	}

	private retry(c: CostumeDef, productId: number): void {
		if (this.retrying.has(productId)) return;
		this.retrying.add(productId);
		task.delay(VERIFY_RETRY_S, () => {
			this.retrying.delete(productId);
			const [ok, err] = pcall(() => {
				this.check(c);
				this.publish();
			});
			if (!ok) warn(`[${GAME_NAME}] Robux: a product check failed: ${tostring(err)}`);
		});
	}

	private publish(): void {
		// nothing verified: no attribute at all (the client then shows no Robux button, and the coin path is as it was)
		const text = this.offer.size() > 0 ? encodeRobuxOffer(this.offer) : undefined;
		const net = this.deps.net;
		if (net !== undefined && net.GetAttribute(ROBUX_OFFER_ATTR) !== text) net.SetAttribute(ROBUX_OFFER_ATTR, text);
	}

	// ------------------------------------------------------------ the prompt and the holds

	/** the prompt open for this player now, or undefined (an open prompt lapses after PROMPT_HOLD_S) */
	private openPrompt(userId: number): OpenPrompt | undefined {
		const p = this.prompts.get(userId);
		if (p === undefined) return undefined;
		if (os.clock() - p.at > PROMPT_HOLD_S) {
			this.prompts.delete(userId);
			return undefined;
		}
		return p;
	}

	/** is COSTUMES[costumeId] held for this player: its prompt open, its payment confirmed, or its receipt unanswered */
	holds(userId: number, costumeId: unknown): boolean {
		if (!typeIs(costumeId, "number")) return false;
		if (this.openPrompt(userId)?.costumeId === costumeId) return true;
		return (
			this.awaiting.get(userId)?.has(costumeId) === true || this.unanswered.get(userId)?.has(costumeId) === true
		);
	}

	/** the costumes held for this player past their prompt (what the wardrobe shows as Pending), in COSTUMES order */
	heldCostumes(userId: number): Array<number> {
		const out: Array<number> = [];
		for (const c of COSTUMES) {
			if (this.awaiting.get(userId)?.has(c.id) === true || this.unanswered.get(userId)?.has(c.id) === true) {
				out.push(c.id);
			}
		}
		return out;
	}

	private publishHeld(userId: number): void {
		const player = game.GetService("Players").GetPlayerByUserId(userId);
		if (player === undefined) return;
		const held = this.heldCostumes(userId);
		const text = held.size() > 0 ? encodeCostumeList(held) : undefined;
		if (player.GetAttribute(ROBUX_PENDING_ATTR) !== text) player.SetAttribute(ROBUX_PENDING_ATTR, text);
	}

	/** ShopAction `robuxCostume`: opens Roblox's prompt, or says why not */
	prompt(player: Player, save: PlayerSaveData, costumeId: unknown, writable: boolean): ShopActionReason | undefined {
		const held = this.openPrompt(player.UserId) !== undefined || this.holds(player.UserId, costumeId);
		const offered = typeIs(costumeId, "number") && this.offer.has(costumeId);
		const refusal = robuxPromptRefusal(save, costumeId, offered, writable, held);
		if (refusal !== undefined) return refusal;
		const id = costumeId as number;
		const productId = productIdOf(id);
		const [ok, err] = pcall(() => this.market.PromptProductPurchase(player, productId));
		if (!ok) {
			warn(`[${GAME_NAME}] a Robux prompt could not open: ${tostring(err)}`);
			return "network";
		}
		this.prompts.set(player.UserId, { costumeId: id, at: os.clock() });
		return undefined;
	}

	/**
	 * The prompt closed. Cancelled (or errored): the costume is free for coins again. Purchased: it is held until its
	 * receipt is granted or the player leaves, however long that takes -- and `isPurchased` itself grants nothing (the
	 * docs: it proves no purchase). A receipt granted before this arrives already closed the prompt: nothing is held.
	 */
	promptFinished(userId: unknown, productId: unknown, isPurchased: unknown): void {
		if (!typeIs(userId, "number")) return;
		const p = this.prompts.get(userId);
		if (p === undefined || productIdOf(p.costumeId) !== productId) return;
		this.prompts.delete(userId);
		if (isPurchased !== true) return;
		const player = game.GetService("Players").GetPlayerByUserId(userId);
		const session = player !== undefined ? this.deps.session(player) : undefined;
		if (session !== undefined && (session.save.costumes[p.costumeId] ?? 0) > 0) return;
		addTo(this.awaiting, userId, p.costumeId);
		this.publishHeld(userId);
	}

	/** is this player still in this server (a hold is for their session; one who left takes nothing with them) */
	private present(userId: number): boolean {
		const player = game.GetService("Players").GetPlayerByUserId(userId);
		return player !== undefined && player.Parent !== undefined;
	}

	/** the player left: everything held for them goes (a receipt still reaches them at their next join) */
	forget(userId: number): void {
		this.prompts.delete(userId);
		this.awaiting.delete(userId);
		this.unanswered.delete(userId);
	}

	/** the receipt of this costume was granted: only ITS holds go (another costume's confirmed payment stays held) */
	private release(userId: number, costumeId: number): void {
		if (this.prompts.get(userId)?.costumeId === costumeId) this.prompts.delete(userId);
		this.awaiting.get(userId)?.delete(costumeId);
		this.unanswered.get(userId)?.delete(costumeId);
		this.publishHeld(userId);
	}

	// ------------------------------------------------------------ the receipt

	/** MarketplaceService.ProcessReceipt */
	processReceipt(raw: unknown): Enum.ProductPurchaseDecision {
		const result = this.decide(raw);
		this.results.push(result);
		if (this.results.size() > 32) this.results.remove(0);
		const { userId, costumeId } = result;
		if (userId !== undefined && costumeId !== undefined && costumeId >= 0) {
			if (result.granted) {
				this.release(userId, costumeId);
			} else if (HELD_OUTCOMES.has(result.outcome) && this.present(userId)) {
				addTo(this.unanswered, userId, costumeId);
				this.publishHeld(userId);
			}
		}
		if (!result.granted && result.outcome !== "absent") {
			print(`[PZ-ROBUX] ${result.outcome} ${result.purchaseId ?? "?"} costume ${result.costumeId ?? -1}`);
		}
		return result.granted
			? Enum.ProductPurchaseDecision.PurchaseGranted
			: Enum.ProductPurchaseDecision.NotProcessedYet;
	}

	private decide(raw: unknown): ReceiptResult {
		if (!typeIs(raw, "table")) return { granted: false, outcome: "invalid" };
		const info = raw as Record<string, unknown>;
		const userId = info.PlayerId;
		const purchaseId = info.PurchaseId;
		if (!typeIs(userId, "number") || !isPurchaseId(purchaseId)) {
			// never expected from Roblox: said out loud, the id's length only (no id, no name)
			const size = typeIs(purchaseId, "string") ? purchaseId.size() : -1;
			// the Error Report groups by message: a fixed sentence, the detail in the log line after it (ANALYTICS.md §10)
			warn(`[${GAME_NAME}] Robux: a receipt was refused: its PlayerId or PurchaseId cannot be kept`);
			print(`[PZ-ROBUX] refused receipt: PurchaseId length ${size} (max ${PURCHASE_ID_MAX})`);
			return { granted: false, outcome: "invalid" };
		}
		const costumeId = costumeOfProduct(info.ProductId);
		const base = { userId, purchaseId, costumeId };
		if (costumeId < 0) {
			if (typeIs(info.ProductId, "number")) {
				this.warnLine(info.ProductId, "a receipt names a product no costume has");
			}
			return { ...base, granted: false, outcome: "unknown" };
		}
		const Players = game.GetService("Players");
		const player = Players.GetPlayerByUserId(userId);
		if (player === undefined) return { ...base, granted: false, outcome: "absent" };
		// a join brings its pending receipts before the save is in: wait for it while they stay (never for one who left)
		let session = this.deps.session(player);
		const started = os.clock();
		while (session === undefined || session.state() === "loading") {
			if (player.Parent === undefined) return { ...base, granted: false, outcome: "absent" };
			if (os.clock() - started >= RECEIPT_LOAD_WAIT_S) return { ...base, granted: false, outcome: "loading" };
			task.wait(0.25);
			session = this.deps.session(player);
		}
		const state = session.state();
		if (state === "closed") return { ...base, granted: false, outcome: "absent" };
		if (state !== "ok") return { ...base, granted: false, outcome: "readonly" };
		const save = session.save;
		const spent = typeIs(info.CurrencySpent, "number") ? info.CurrencySpent : 0;
		const channel = info.ProductPurchaseChannel;
		if (robuxReceiptOf(save, purchaseId) !== undefined) {
			// granted before (in this session, or a session whose write landed): PurchaseGranted once it is in the store
			if (!session.commit()) return { ...base, granted: false, outcome: "unsaved" };
			this.logPending(purchaseId);
			return { ...base, granted: true, outcome: "replayed" };
		}
		const result = grantRobuxCostume(save, costumeId, purchaseId);
		if (!session.commit()) {
			// the costume stays in the session; its event goes out with the next write that lands (`landed`), and the
			// next call finds the PurchaseId and writes again
			this.unlogged.set(purchaseId, { player, costumeId, spent, channel, fresh: result === "granted" });
			return { ...base, granted: false, outcome: "unsaved" };
		}
		this.log(player, costumeId, purchaseId, spent, channel, result === "granted");
		return { ...base, granted: true, outcome: result };
	}

	/**
	 * A write of this player's session landed (server/main.server.ts `writeSession`): every grant of theirs whose own write
	 * failed is in it -- the grant went into the live save before that failed write, so any later write carries it -- and
	 * its event goes out now, once. (A player who left before any write landed takes it with them: the purchase is in the
	 * save, only the event is lost.)
	 */
	landed(player: Player): void {
		for (const [purchaseId, u] of this.unlogged) {
			if (u.player === player) this.logPending(purchaseId);
		}
	}

	private logPending(purchaseId: string): void {
		const u = this.unlogged.get(purchaseId);
		if (u === undefined) return;
		this.unlogged.delete(purchaseId);
		this.log(u.player, u.costumeId, purchaseId, u.spent, u.channel, u.fresh);
	}

	private log(
		player: Player,
		costumeId: number,
		purchaseId: string,
		spent: number,
		channel: unknown,
		fresh: boolean,
	): void {
		Analytics.robuxPurchase(player, costumeId, spent, channel, fresh);
		// the owner makes it good by hand (docs/SHOP.md, Robux item 4): the PurchaseId, never a name
		if (!fresh) print(`[PZ-ROBUX] owned ${purchaseId}: costume ${costumeId} was already owned (no refund API)`);
	}

	private warnLine(productId: number, message: string): void {
		// a fixed sentence for the Error Report, the product in the log line after it (docs/ANALYTICS.md §10)
		warn(`[${GAME_NAME}] Robux: a product changed state: ${message}`);
		print(`[PZ-ROBUX] product ${productId}: ${message}`);
	}
}

let active: RobuxShop | undefined;

/** the Robux shop running on this server (the tests); undefined before `startRobuxShop`, or without MarketplaceService */
export function activeRobuxShop(): RobuxShop | undefined {
	return active;
}

/**
 * Starts the Robux shop on this server: the price check (now and every VERIFY_EVERY_S), ProcessReceipt (set once, by
 * this one script -- the engine allows no second) and the prompt's close. Undefined where there is no
 * MarketplaceService (a test's fake Roblox): the coin shop goes on alone.
 */
export function startRobuxShop(deps: RobuxDeps): RobuxShop | undefined {
	const [found, service] = pcall(() => game.GetService("MarketplaceService"));
	if (!found || service === undefined) return undefined;
	const market = service as MarketplaceService;
	const shop = new RobuxShop(market, deps);
	active = shop;
	market.ProcessReceipt = info => shop.processReceipt(info);
	market.PromptProductPurchaseFinished.Connect((userId, productId, isPurchased) =>
		shop.promptFinished(userId, productId, isPurchased),
	);
	game.GetService("Players").PlayerRemoving.Connect(player => shop.forget(player.UserId));
	task.spawn(() => {
		for (;;) {
			const [ok, err] = pcall(() => shop.verify());
			if (!ok) warn(`[${GAME_NAME}] Robux: the price check failed: ${tostring(err)}`);
			task.wait(VERIFY_EVERY_S);
		}
	});
	return shop;
}
