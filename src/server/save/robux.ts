/*
 * The wardrobe's costumes for Robux, decided by the SERVER (docs/SHOP.md "Robux: decisões e desenho"; DESIGN_RULES
 * MON-01, MON-04, MON-07, BEM-02). Sources: creator-docs developer-products.md, player-data-purchasing.md,
 * MarketplaceService.yaml (Context7, 2026-09-24).
 *
 *   THE PRODUCTS  one developer product per costume (shared/data/robuxProducts.ts): the ProductId alone names the item,
 *                 so a receipt that comes late -- after a crash, on another server, from outside the game -- grants the
 *                 right costume or nothing, never the wrong one. At boot (and every VERIFY_EVERY_S) each configured id is
 *                 checked with GetProductInfo: for sale, at its tier's price. Only those are offered; the offer is
 *                 published on the Net folder (`pz_robux_products`) and is all the client knows. No id: no offer, no
 *                 Robux button, the coin path as it was.
 *   THE PROMPT    the client asks (ShopAction `robuxCostume`, the costume id and nothing else); THIS server opens
 *                 Roblox's prompt, and only for a costume offered, not owned, on a session that can record a purchase,
 *                 with no other Robux prompt open for that player. While one is open (PROMPT_HOLD_S), the COIN purchase of
 *                 the same costume is refused ("pending"): no race can make anyone pay twice for one costume.
 *   THE RECEIPT   ProcessReceipt, the recipe of player-data-purchasing.md on our session lock: the player must be in this
 *                 server (else NotProcessedYet: Roblox tries again at their next join) with a save loaded and writable
 *                 (a load in progress is waited for, RECEIPT_LOAD_WAIT_S); the PurchaseId is looked up in the save
 *                 (`robuxReceipts`, save v7) -- already granted: PurchaseGranted once a write holding it has landed;
 *                 new: the costume and the PurchaseId go into the save and the save is WRITTEN NOW (UpdateAsync under the
 *                 lock, outside the coalesced cadence: SAV-01's documented exception), and only a write that landed
 *                 answers PurchaseGranted. Any failure answers NotProcessedYet; the grant stays in the session (the
 *                 trade-off the docs accept: "free for the duration of the session") and the next call finds the
 *                 PurchaseId and tries the write again. PromptProductPurchaseFinished's `isPurchased` never grants.
 *   OWNED ALREADY never offered, and the prompt is refused. A receipt that still comes (a purchase outside the game, if the
 *                 owner ever lists the products) is acknowledged with nothing new to grant -- Roblox has no refund API --
 *                 and reported (`RobuxOwned`, a `[PZ-ROBUX]` line) for the owner to make good by hand. Never coins: that
 *                 would sell coins for Robux (MON-01).
 */
import { GAME_NAME } from "shared/module";
import { COSTUMES } from "shared/data/shop";
import { cosmeticSlotOf } from "shared/data/cosmetics";
import {
	ROBUX_OFFER_ATTR,
	costumeOfProduct,
	encodeRobuxOffer,
	productIdOf,
	robuxPriceOf,
} from "shared/data/robuxProducts";
import { PlayerSaveData, ROBUX_RECEIPTS_MAX, isPurchaseId, robuxReceiptOf } from "shared/game/save";
import { ShopActionReason } from "shared/net/net";
import * as Analytics from "../analytics/events";

/** a Robux prompt keeps its costume from being bought with coins this long (s), or until its receipt / its cancel */
export const PROMPT_HOLD_S = 120;
/** ProcessReceipt waits at most this long for the buyer's save to load (s): a join brings its pending receipts at once */
export const RECEIPT_LOAD_WAIT_S = 30;
/** the offer is checked against Roblox's prices again this often (s): a price changed in the Creator Hub is caught */
export const VERIFY_EVERY_S = 600;

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

function isIndex(v: unknown, size: number): v is number {
	return typeIs(v, "number") && v === v && v % 1 === 0 && v >= 0 && v < size;
}

/** pure: puts COSTUMES[costumeId] and its receipt into `save`; "owned" when the costume was already owned */
export function grantRobuxCostume(save: PlayerSaveData, costumeId: number, purchaseId: string): "granted" | "owned" {
	const owned = (save.costumes[costumeId] ?? 0) > 0;
	save.costumes[costumeId] = 1;
	save.robuxReceipts.push(`${costumeId}:${purchaseId}`);
	while (save.robuxReceipts.size() > ROBUX_RECEIPTS_MAX) save.robuxReceipts.remove(0);
	return owned ? "owned" : "granted";
}

/**
 * pure: why a Robux prompt for `costumeId` is refused, or undefined when it may open. `offered`: the costume's product
 * passed the price check; `writable`: the session can record a purchase; `open`: a Robux prompt is already open.
 */
export function robuxPromptRefusal(
	save: PlayerSaveData,
	costumeId: unknown,
	offered: boolean,
	writable: boolean,
	open: boolean,
): ShopActionReason | undefined {
	if (!isIndex(costumeId, COSTUMES.size())) return "invalid";
	const c = COSTUMES[costumeId];
	if (c.equipId < 0 || cosmeticSlotOf(c.equipId) === 0 || !offered) return "invalid";
	if (!writable) return "readonly";
	if ((save.costumes[costumeId] ?? 0) > 0) return "owned";
	if (open) return "pending";
	return undefined;
}

interface OpenPrompt {
	costumeId: number;
	at: number;
}

export class RobuxShop {
	/** costume id -> Robux price, for the products that passed the check (all the client is ever told) */
	private offer = new Map<number, number>();
	private readonly prompts = new Map<number, OpenPrompt>();
	/**
	 * PurchaseIds granted here whose first write failed, and whether the costume was new: their analytics go out with
	 * the write that lands (once -- a receipt replayed after that finds nothing here)
	 */
	private readonly unlogged = new Map<string, boolean>();
	/** product ids already warned about (one warning each, never a flood) */
	private readonly warned = new Set<number>();
	/** the last receipts handled, newest last (the admin log and the tests) */
	readonly results = new Array<ReceiptResult>();

	constructor(
		private readonly market: MarketplaceService,
		private readonly deps: RobuxDeps,
	) {}

	/** checks every configured product against Roblox's own price and sale state, and publishes what passed */
	verify(): void {
		const offer = new Map<number, number>();
		for (const c of COSTUMES) {
			const productId = productIdOf(c.id);
			const price = robuxPriceOf(c.id);
			if (productId === 0 || price === undefined) continue;
			if (costumeOfProduct(productId) !== c.id) {
				this.warnOnce(productId, "a product id is configured for two costumes; neither is sold");
				continue;
			}
			const [ok, info] = pcall(() => this.market.GetProductInfo(productId, Enum.InfoType.Product));
			if (!ok || !typeIs(info, "table")) {
				this.warnOnce(productId, "a product's info could not be read; it is not offered for now");
				continue;
			}
			const read = info as unknown as Record<string, unknown>;
			if (read.PriceInRobux !== price || read.IsForSale === false) {
				this.warnOnce(
					productId,
					"a product's price or sale state is not the one docs/SHOP.md sets; it is not offered",
				);
				continue;
			}
			offer.set(c.id, price);
		}
		this.offer = offer;
		// nothing verified: no attribute at all (the client then shows no Robux button, and the coin path is as it was)
		const text = offer.size() > 0 ? encodeRobuxOffer(offer) : undefined;
		const net = this.deps.net;
		if (net !== undefined && net.GetAttribute(ROBUX_OFFER_ATTR) !== text) net.SetAttribute(ROBUX_OFFER_ATTR, text);
	}

	/** the Robux price this server sells COSTUMES[costumeId] at, or undefined */
	priceOf(costumeId: number): number | undefined {
		return this.offer.get(costumeId);
	}

	/** the costume of the Robux prompt open for this player, or -1 */
	pendingFor(userId: number): number {
		const p = this.prompts.get(userId);
		if (p === undefined) return -1;
		if (os.clock() - p.at > PROMPT_HOLD_S) {
			this.prompts.delete(userId);
			return -1;
		}
		return p.costumeId;
	}

	/** ShopAction `robuxCostume`: opens Roblox's prompt, or says why not */
	prompt(player: Player, save: PlayerSaveData, costumeId: unknown, writable: boolean): ShopActionReason | undefined {
		const open = this.pendingFor(player.UserId) >= 0;
		const offered = typeIs(costumeId, "number") && this.offer.has(costumeId);
		const refusal = robuxPromptRefusal(save, costumeId, offered, writable, open);
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
	 * The prompt closed. Cancelled (or errored): the costume is free for coins again. Confirmed: it stays held until its
	 * receipt comes or PROMPT_HOLD_S more pass -- `isPurchased` itself grants nothing (the docs: it proves no purchase).
	 */
	promptFinished(userId: unknown, productId: unknown, isPurchased: unknown): void {
		if (!typeIs(userId, "number")) return;
		const p = this.prompts.get(userId);
		if (p === undefined || productIdOf(p.costumeId) !== productId) return;
		if (isPurchased === true) p.at = os.clock();
		else this.prompts.delete(userId);
	}

	/** the player left: their prompt goes (a receipt still reaches them at their next join) */
	forget(userId: number): void {
		this.prompts.delete(userId);
	}

	/** MarketplaceService.ProcessReceipt */
	processReceipt(raw: unknown): Enum.ProductPurchaseDecision {
		const result = this.decide(raw);
		this.results.push(result);
		if (this.results.size() > 32) this.results.remove(0);
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
		if (!typeIs(userId, "number") || !isPurchaseId(purchaseId)) return { granted: false, outcome: "invalid" };
		const costumeId = costumeOfProduct(info.ProductId);
		const base = { userId, purchaseId, costumeId };
		if (costumeId < 0) {
			if (typeIs(info.ProductId, "number")) {
				this.warnOnce(info.ProductId, "a receipt names a product no costume has");
			}
			return { ...base, granted: false, outcome: "unknown" };
		}
		const Players = game.GetService("Players");
		const player = Players.GetPlayerByUserId(userId);
		if (player === undefined) return { ...base, granted: false, outcome: "absent" };
		// a join brings its pending receipts before the save is in: wait for it (never for a player who left)
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
			const fresh = this.unlogged.get(purchaseId);
			if (fresh !== undefined) {
				this.unlogged.delete(purchaseId);
				this.log(player, costumeId, purchaseId, spent, channel, fresh);
			}
			this.prompts.delete(userId);
			return { ...base, granted: true, outcome: "replayed" };
		}
		const result = grantRobuxCostume(save, costumeId, purchaseId);
		if (!session.commit()) {
			// the costume stays in the session; the next call finds the PurchaseId and writes again
			this.unlogged.set(purchaseId, result === "granted");
			return { ...base, granted: false, outcome: "unsaved" };
		}
		this.log(player, costumeId, purchaseId, spent, channel, result === "granted");
		this.prompts.delete(userId);
		return { ...base, granted: true, outcome: result };
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

	private warnOnce(productId: number, message: string): void {
		if (this.warned.has(productId)) return;
		this.warned.add(productId);
		warn(`[${GAME_NAME}] Robux: ${message}`);
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
