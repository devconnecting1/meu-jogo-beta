import { applyWallet, PlayerSaveData, sanitizeStoredSave } from "shared/game/save";
import {
	LoadStatus,
	MAX_SAVE_PAYLOAD,
	NET_FOLDER,
	NetRemotes,
	SAVE_MIN_INTERVAL,
	SaveAckPayload,
	SaveRejectReason,
	ShopActionReason,
	ShopActionRequest,
	ShopActionResult,
	StoreState,
	waitRemotes,
} from "shared/net/net";
import { newShopBucket, SHOP_NONCE_MAX, takesShopToken, takeShopToken } from "shared/net/shopGuard";
import { REBIRTH_FREE_ATTR, rebirthCharge } from "shared/data/shop";
import {
	decodeCostumeList,
	decodeRobuxOffer,
	ROBUX_OFFER_ATTR,
	ROBUX_PENDING_ATTR,
	ROBUX_REJOIN_ATTR,
} from "shared/data/robuxProducts";

/*
 * Client side of the save protocol (see shared/net/net.ts).
 * - nothing is reported until a LoadAck was ADOPTED (activate), so a client that started on the
 *   8 s fallback save can never overwrite the real one
 * - reports are throttled to the server window, coalesced (latest state wins) and skipped when unchanged
 * - coins are display-only here: wallets from the server replace the local copy
 * - a report is NOT a save: the server alone decides when the DataStore is written (DESIGN_RULES SAV-01: saving is
 *   automatic, there is no Save button), and says so with a `store` push (`onStoreState`, client/ui/saveIndicator.ts)
 */

const HttpService = game.GetService("HttpService");

const REMOTE_TIMEOUT = 30;
const SEND_INTERVAL = SAVE_MIN_INTERVAL + 0.5;

/**
 * Why a report is sent (the server treats them all alike: dirty, never an immediate write). "equip": an outfit or a pet
 * changed — what the other survivors see (MON-04), so it should not wait a minute.
 */
export type SaveReason = "auto" | "death" | "lobby" | "day" | "boss" | "packs" | "menu" | "equip";

export interface LoadInfo {
	status: LoadStatus;
	token: string;
	persist: boolean;
	acceptsReports: boolean;
	save: PlayerSaveData;
}

let remotes: NetRemotes | undefined;
let remotesFailed = false;
let getSave: (() => PlayerSaveData) | undefined;

let activeToken: string | undefined;
let reportsEnabled = false;
let persistEnabled = false;
let lastSentAt = -math.huge;
let lastSentJson = "";
let sendScheduled = false;
let retryScheduled = false;
/** what the last report was asked for (the log line of a report too large to send) */
let lastReason: SaveReason = "auto";

/** progress the server held back (time limits) or a stale report: report the current state again later */
const RETRY_CLAMPED_SEC = 45;
const RETRY_OUTDATED_SEC = 1;

const loadListeners = new Set<(info: LoadInfo) => void>();
const ackListeners = new Set<(ack: SaveAckPayload) => void>();
const walletListeners = new Set<() => void>();
const activateListeners = new Set<() => void>();
const storeListeners = new Set<(state: StoreState, answersDawn: boolean) => void>();
const STORE_STATES = new Set<string>(["saving", "saved", "failing", "stopped"]);

function subscribe<T>(set: Set<T>, fn: T): () => void {
	set.add(fn);
	return () => set.delete(fn);
}

export function onLoad(fn: (info: LoadInfo) => void): () => void {
	return subscribe(loadListeners, fn);
}

/**
 * The server's answer to a report (coins earned, a refusal) -- and ALSO a pushed wallet that says coins were earned
 * (`push` with `earned` > 0: a midnight's or a boss's pay, MON-06), so a listener must not read every ack as the answer
 * to a report it sent. Other pushes (XP, the bag, a write's news) never reach these listeners.
 */
export function onSaveAck(fn: (ack: SaveAckPayload) => void): () => void {
	return subscribe(ackListeners, fn);
}

/**
 * SAV-01: what happened to a DataStore write of this player's save, as the server tells it; `answersDawn` (BEM-04): the
 * push is the answer to the dawn's ask (shared/net/net.ts `SaveAckPayload.answersDawn`), the only "saved" the dawn card
 * takes
 */
export function onStoreState(fn: (state: StoreState, answersDawn: boolean) => void): () => void {
	return subscribe(storeListeners, fn);
}

/** coins / packs / costumes changed (server wallet applied to the local save) */
export function onWalletChanged(fn: () => void): () => void {
	return subscribe(walletListeners, fn);
}

function notifyWallet(): void {
	for (const fn of walletListeners) task.spawn(fn);
}

/**
 * F3 (§4.8): the server's backpack rides the wallet as `bag`. client/net/backpackSync.ts lays it over the local copy
 * and replays the predictions the server has not answered yet — synchronously, right after the wallet, so no frame
 * ever sees the bag without them.
 */
let bagHook: ((save: PlayerSaveData, bag: unknown) => void) | undefined;

export function setBagHook(fn: (save: PlayerSaveData, bag: unknown) => void): void {
	bagHook = fn;
}

/** the save the reports are made of (ctx.save), or undefined before the game handed it over */
export function currentSave(): PlayerSaveData | undefined {
	return getSave?.();
}

function applyServerWallet(wallet: unknown): void {
	if (getSave === undefined || wallet === undefined) return;
	const save = getSave();
	const changed = applyWallet(save, wallet);
	const bag = typeIs(wallet, "table") ? (wallet as Record<string, unknown>).bag : undefined;
	if (bag !== undefined && bagHook !== undefined) bagHook(save, bag);
	if (changed) notifyWallet();
}

const LOAD_STATUSES = new Set<string>(["ok", "new", "unavailable", "error"]);

function parseLoad(raw: unknown): LoadInfo | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const r = raw as Record<string, unknown>;
	if (!typeIs(r.status, "string") || !LOAD_STATUSES.has(r.status) || !typeIs(r.token, "string")) return undefined;
	return {
		status: r.status as LoadStatus,
		token: r.token,
		persist: r.persist === true,
		acceptsReports: r.acceptsReports === true,
		save: sanitizeStoredSave(r.save),
	};
}

function parseAck(raw: unknown): SaveAckPayload | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const r = raw as Record<string, unknown>;
	if (!typeIs(r.ok, "boolean")) return undefined;
	const num = (v: unknown): number => (typeIs(v, "number") ? v : 0);
	return {
		ok: r.ok,
		reason: typeIs(r.reason, "string") ? (r.reason as SaveRejectReason) : undefined,
		earned: num(r.earned),
		earnedDays: num(r.earnedDays),
		earnedBosses: num(r.earnedBosses),
		earnedRecords: num(r.earnedRecords),
		clamped: r.clamped === true,
		wallet: r.wallet as SaveAckPayload["wallet"],
		push: r.push === true,
		store: typeIs(r.store, "string") && STORE_STATES.has(r.store) ? (r.store as StoreState) : undefined,
		answersDawn: r.answersDawn === true,
	};
}

/** provides the save object to report (ctx.save — it may be replaced, so it is read on every send) */
export function setSaveSource(fn: () => PlayerSaveData): void {
	getSave = fn;
}

/** connects to the server and sends the first LoadRequest (non-blocking) */
export function startNet(): void {
	task.spawn(() => {
		const r = waitRemotes(REMOTE_TIMEOUT);
		if (r === undefined) {
			remotesFailed = true;
			warn("[saveClient] server remotes not found; playing without saving");
			return;
		}
		remotes = r;
		r.loadAck.OnClientEvent.Connect((raw: unknown) => {
			const info = parseLoad(raw);
			if (info === undefined) {
				warn("[saveClient] malformed LoadAck ignored");
				return;
			}
			for (const fn of loadListeners) task.spawn(fn, info);
		});
		r.saveAck.OnClientEvent.Connect((raw: unknown) => {
			const ack = parseAck(raw);
			if (ack === undefined) return;
			// the server pushed its wallet on its own (XP, a level, midnight's coins), or news of a write of the save
			// (SAV-01): no report is being answered
			if (ack.push === true) {
				if (ack.wallet !== undefined) applyServerWallet(ack.wallet);
				const store = ack.store;
				const answersDawn = ack.answersDawn === true;
				if (store !== undefined) for (const fn of storeListeners) task.spawn(fn, store, answersDawn);
				// MON-06: coins the server paid on its own (a midnight, a boss) are told like a report's: the coin toast
				if (ack.ok && ack.earned > 0) for (const fn of ackListeners) task.spawn(fn, ack);
				return;
			}
			if (ack.wallet !== undefined) applyServerWallet(ack.wallet);
			if (!ack.ok) {
				if (ack.reason === "readonly" || ack.reason === "stale") {
					// the server will not take reports from this session any more
					reportsEnabled = false;
				} else {
					lastSentJson = ""; // resend the next time
					// outdated: the wallet above carried the current runRev, so a new report will be accepted
					if (ack.reason === "outdated") scheduleRetry(RETRY_OUTDATED_SEC);
				}
			} else if (ack.clamped) {
				lastSentJson = "";
				scheduleRetry(RETRY_CLAMPED_SEC);
			}
			for (const fn of ackListeners) task.spawn(fn, ack);
		});
		r.loadRequest.FireServer();
	});
}

/** true when the server remotes could not be found at all */
export function netUnavailable(): boolean {
	return remotesFailed;
}

/** asks the server for the session save again (used to retry after a load error) */
export function requestLoad(): void {
	remotes?.loadRequest.FireServer();
}

/** arms reporting with the token of an adopted LoadAck */
export function activate(info: LoadInfo): void {
	activeToken = info.token;
	reportsEnabled = info.acceptsReports;
	persistEnabled = info.persist;
	lastSentJson = "";
	lastSentAt = -math.huge;
	// deferred: the caller finishes adopting the save (ctx.save = info.save) before listeners run
	for (const fn of activateListeners) task.defer(fn);
}

/** a LoadAck was just adopted as ctx.save (e.g. admin patches that arrived earlier are applied then) */
export function onActivate(fn: () => void): () => void {
	return subscribe(activateListeners, fn);
}

/** a LoadAck was adopted (the local save mirrors the server's) */
export function sessionReady(): boolean {
	return activeToken !== undefined;
}

/** progress reports are accepted by the server for this session */
export function savingEnabled(): boolean {
	return activeToken !== undefined && reportsEnabled && remotes !== undefined;
}

/** progress is also written to the DataStore */
export function savingPersistent(): boolean {
	return savingEnabled() && persistEnabled;
}

/**
 * A report's JSON: the whole save but its Robux receipts (save v8). Those are the server's alone -- no report moves them
 * (shared/game/save.ts `readProgress` keeps the server's) -- so they are not sent, and never count against
 * MAX_SAVE_PAYLOAD. The live table lends its field for the encode and gets it back at once (nothing yields between).
 */
export function reportJson(save: PlayerSaveData): string {
	const receipts = save.robuxReceipts;
	save.robuxReceipts = [];
	const [ok, json] = pcall(() => HttpService.JSONEncode(save));
	save.robuxReceipts = receipts;
	if (!ok) throw json;
	return json;
}

function sendNow(): void {
	const r = remotes;
	const token = activeToken;
	if (!savingEnabled() || r === undefined || token === undefined || getSave === undefined) return;
	const json = reportJson(getSave());
	// nothing new since the last report: the server already has it
	if (json === lastSentJson) return;
	if (json.size() > MAX_SAVE_PAYLOAD) {
		warn("[saveClient] save too large to report");
		print(`[saveClient] the report is ${json.size()} chars (last asked for: ${lastReason})`);
		return;
	}
	lastSentJson = json;
	lastSentAt = os.clock();
	r.saveRequest.FireServer(token, json);
}

function scheduleRetry(delay: number): void {
	if (retryScheduled) return;
	retryScheduled = true;
	task.delay(delay, () => {
		retryScheduled = false;
		requestSave("auto");
	});
}

/**
 * Report progress to the server. Throttled to one report per server window; calls inside the
 * window are merged into one report of the latest state. Returns false when saving is off.
 * (The name is historical: this REPORTS; the server writes the DataStore on its own schedule, SAV-01.)
 */
export function requestSave(reason: SaveReason): boolean {
	if (!savingEnabled()) return false;
	lastReason = reason;
	const wait = lastSentAt + SEND_INTERVAL - os.clock();
	if (wait <= 0) {
		sendNow();
	} else if (!sendScheduled) {
		sendScheduled = true;
		task.delay(wait, () => {
			sendScheduled = false;
			sendNow();
		});
	}
	return true;
}

/**
 * What a Rebirth costs right now, as the server will charge it: nothing once this survivor's daybreak came while they
 * waited in the lobby (the server says so on the Player, REBIRTH_FREE_ATTR), else the continue's price.
 */
export function rebirthPriceNow(deathCount: number): number {
	return rebirthCharge(deathCount, rebirthShownFree());
}

/** does the server say this survivor's Rebirth is free right now (what the lobby shows, and the request says it expects) */
export function rebirthShownFree(): boolean {
	const me = game.GetService("Players").LocalPlayer as Player | undefined;
	return me !== undefined && me.GetAttribute(REBIRTH_FREE_ATTR) === true;
}

/**
 * The costumes a Robux payment of this player's may be on its way for (the server's ROBUX_PENDING_ATTR on the Player):
 * the wardrobe shows them as Pending, and the server sells them neither for coins nor in a second prompt meanwhile.
 */
export function robuxPending(): Set<number> {
	const me = game.GetService("Players").LocalPlayer as Player | undefined;
	return decodeCostumeList(me?.GetAttribute(ROBUX_PENDING_ATTR));
}

/** of those, the ones only a rejoin can settle (ROBUX_REJOIN_ATTR): the wardrobe says "Rejoin to receive it" */
export function robuxRejoin(): Set<number> {
	const me = game.GetService("Players").LocalPlayer as Player | undefined;
	return decodeCostumeList(me?.GetAttribute(ROBUX_REJOIN_ATTR));
}

/** `fn` runs when either list changes */
export function onRobuxPendingChanged(fn: () => void): () => void {
	const me = game.GetService("Players").LocalPlayer as Player | undefined;
	if (me === undefined) return () => {};
	const a = me.GetAttributeChangedSignal(ROBUX_PENDING_ATTR).Connect(fn);
	const b = me.GetAttributeChangedSignal(ROBUX_REJOIN_ATTR).Connect(fn);
	return () => {
		a.Disconnect();
		b.Disconnect();
	};
}

/**
 * The costumes this server sells for Robux, and at what price (costume id -> Robux): what server/save/robux.ts checked
 * against Roblox's own and published on the Net folder. Empty = none: the wardrobe shows no Robux button at all.
 */
export function robuxOffer(): Map<number, number> {
	const folder = game.GetService("ReplicatedStorage").FindFirstChild(NET_FOLDER);
	return decodeRobuxOffer(folder?.GetAttribute(ROBUX_OFFER_ATTR));
}

/** `fn` runs when the server publishes a new offer (its price check runs at boot and every few minutes) */
export function onRobuxOfferChanged(fn: () => void): () => void {
	const folder = game.GetService("ReplicatedStorage").FindFirstChild(NET_FOLDER);
	if (folder === undefined) return () => {};
	const conn = folder.GetAttributeChangedSignal(ROBUX_OFFER_ATTR).Connect(fn);
	return () => conn.Disconnect();
}

const ACTION_REASONS = new Set<string>([
	"funds",
	"owned",
	"limit",
	"invalid",
	"rate",
	"loading",
	"readonly",
	"outdated",
	"network",
	"pending",
	"price",
]);

/**
 * The server's ShopAction bucket, kept here too (shared/net/shopGuard.ts): what it would only refuse is refused here
 * without being sent, so a player clicking Buy as fast as they can never reaches the §8.2 flood line.
 */
const shopBucket = newShopBucket(os.clock());
/** the last purchase nonce handed out (shared/net/shopGuard.ts): the server charges one nonce once */
let buyNonce = 0;

/**
 * shop purchase / rebirth. YIELDS until the server answers; call from a click handler or task. A pack purchase is
 * numbered here (`nonce`): the same request again -- replayed, or sent twice -- is answered as the first, charged once.
 */
export function invokeShopAction(request: ShopActionRequest): ShopActionResult {
	const r = remotes;
	if (r === undefined) return { ok: false, reason: "network" };
	if (takesShopToken(request.kind) && !takeShopToken(shopBucket, os.clock())) return { ok: false, reason: "rate" };
	let sent = request;
	if (request.kind === "buyPack" && request.nonce === undefined) {
		buyNonce = buyNonce >= SHOP_NONCE_MAX ? 1 : buyNonce + 1;
		sent = { kind: "buyPack", packId: request.packId, nonce: buyNonce };
	}
	const [ok, raw] = pcall(() => r.shopAction.InvokeServer(sent));
	if (!ok || !typeIs(raw, "table")) return { ok: false, reason: "network" };
	const res = raw as Record<string, unknown>;
	if (res.wallet !== undefined) applyServerWallet(res.wallet);
	const reason = typeIs(res.reason, "string") && ACTION_REASONS.has(res.reason) ? res.reason : undefined;
	return {
		ok: res.ok === true,
		reason: reason as ShopActionReason | undefined,
		price: typeIs(res.price, "number") ? res.price : undefined,
	};
}
