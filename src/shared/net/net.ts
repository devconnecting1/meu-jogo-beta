import type { PlayerSaveData, Wallet } from "shared/game/save";

/*
 * Network protocol (ReplicatedStorage/Net). The server is the source of truth for coins and purchases;
 * the client simulates the game and REPORTS its progress, which the server validates.
 *
 *   LoadRequest  C→S  RemoteEvent     ()                       ask for (or re-try) the session save
 *   LoadAck      S→C  RemoteEvent     (LoadResult)             sent once the save is read (and on re-requests)
 *   SaveRequest  C→S  RemoteEvent     (token, json)            progress report, JSON of PlayerSaveData. It is NOT a
 *                                                              request to write: the server alone decides when the
 *                                                              DataStore is written (SAV-01, server/save/saveCadence.ts)
 *   SaveAck      S→C  RemoteEvent     (SaveAckPayload)         result + coins earned + wallet; pushes: wallet, store
 *   ShopAction   C→S  RemoteFunction  (ShopActionRequest) → ShopActionResult
 */
export const NET_FOLDER = "Net";
export const REMOTE_LOAD_REQUEST = "LoadRequest";
export const REMOTE_LOAD_ACK = "LoadAck";
export const REMOTE_SAVE_REQUEST = "SaveRequest";
export const REMOTE_SAVE_ACK = "SaveAck";
export const REMOTE_SHOP_ACTION = "ShopAction";

/** the server processes at most one progress report per player in this window (seconds) */
export const SAVE_MIN_INTERVAL = 10;
/**
 * Maximum JSON length of a progress report. From WORLD_SERVER_PHASE the report moves only the settings, the
 * achievements and a few flags, and the whole save with every counter at its ceiling is ~2.2 KB (+ ≤ 1 KB of
 * settings; tools/test-save.mjs measures it): 8 KB keeps more than 2× headroom and stops a 100 KB junk report
 * being parsed at all (security review of 5967a18, #12).
 */
export const MAX_SAVE_PAYLOAD = 8192;

/**
 * ok          existing save loaded; progress is persisted
 * new         no save yet (new player); progress is persisted
 * unavailable DataStore not reachable on this server (e.g. Studio without API access):
 *             reports are accepted in memory, nothing is written
 * error       the save exists but could not be read: read-only session, nothing is accepted or written
 *             (the client may send LoadRequest again to retry)
 */
export type LoadStatus = "ok" | "new" | "unavailable" | "error";

export interface LoadResult {
	status: LoadStatus;
	/** must accompany every SaveRequest of this session */
	token: string;
	/** progress will be written to the DataStore */
	persist: boolean;
	/** the server accepts progress reports (false = read-only session) */
	acceptsReports: boolean;
	save: PlayerSaveData;
}

/**
 * readonly  session does not accept reports (load error / lock lost)
 * stale     wrong session token (e.g. a report from before a re-load)
 * outdated  report captured before the last rebirth / new run (runRev mismatch): resend a newer one
 * invalid   not a JSON object / too large
 * loading   the save is still being read
 */
export type SaveRejectReason = "readonly" | "stale" | "outdated" | "invalid" | "loading";

export interface SaveAckPayload {
	ok: boolean;
	reason?: SaveRejectReason;
	/**
	 * coins granted by this report (days survived, milestones, bosses) -- or, on a `push`, the coins the simulation paid
	 * since the last push (a midnight, a boss: server/sim/progress.ts `onIncome`), told once
	 */
	earned: number;
	earnedDays: number;
	earnedBosses: number;
	/** of `earned`, the record milestones paid (a new best day that is a multiple of ECONOMY.MILESTONE_EVERY) */
	earnedRecords?: number;
	/** part of the progress was held back by the server's time limits: report again later */
	clamped: boolean;
	wallet?: Wallet;
	/**
	 * Not an answer to a report: the server pushed the wallet because the simulation changed it (XP, a level,
	 * midnight's coins), or tells what happened to a write of the save (`store`). The client applies the wallet and
	 * nothing else -- no retry -- except the coin toast when it says coins were `earned` (MON-06).
	 */
	push?: boolean;
	/** SAV-01: a push about the DataStore write of this player's save (client/ui/saveIndicator.ts) */
	store?: StoreState;
	/**
	 * BEM-04: this `store` push answers the dawn's ask -- a write of the save encoded after 06:00 landed ("saved", or the
	 * DataStore already held the live save), or the lock went ("stopped"). The dawn card says "Progress saved" only on
	 * one of these, never on an older write's news (server/main.server.ts `dawnAsks`). Absent on every other push.
	 */
	answersDawn?: boolean;
}

/**
 * SAV-01 (docs/DESIGN_RULES.md): what the server tells a player about the writes of their save, pushed on SaveAck.
 * Only a write that carries something new is announced (a lock refresh of an unchanged save is not).
 *
 * saving   a write of new progress started
 * saved    it landed in the DataStore
 * failing  it failed after its retries (the DataStore is down): it is tried again, and the player is told
 * stopped  this server lost the session lock (another server holds the player): it will never write again
 */
export type StoreState = "saving" | "saved" | "failing" | "stopped";

export type ShopActionRequest =
	/**
	 * `nonce` (shared/net/shopGuard.ts): the same nonce again is answered as the first time and never charged twice.
	 * client/systems/saveClient.ts `invokeShopAction` numbers every purchase; a request that carries none is a purchase
	 * of its own each time.
	 */
	| { kind: "buyPack"; packId: number; nonce?: number }
	| { kind: "buyCostume"; costumeId: number }
	/**
	 * The same costume for Robux (docs/SHOP.md "Robux: decisões e desenho"): the SERVER opens Roblox's prompt, and only
	 * for a costume it verified, not owned (server/save/robux.ts). The answer says the prompt opened, or why not; the
	 * costume itself arrives with ProcessReceipt, on the pushed wallet -- never with this answer.
	 */
	| { kind: "robuxCostume"; costumeId: number }
	/** MON-05: show an EARNED title under the name (-1 = none); the server checks it (server/save/titles.ts) */
	| { kind: "equipTitle"; titleId: number }
	| { kind: "rebirth"; runRev: number }
	| { kind: "newRun"; runRev: number }
	/**
	 * The shop (screen 0) or the wardrobe (1) just opened: no decision, nothing charged -- only the first step of the
	 * Shop funnel (server/analytics/events.ts `shopViewed`, rate-limited there). Fired and forgotten by the client.
	 */
	| { kind: "viewShop"; screen: number };

/**
 * "pending": a Robux prompt for this costume is open (or its receipt is on the way), so it is not sold for coins
 * meanwhile, and a second Robux prompt does not open over it (server/save/robux.ts PROMPT_HOLD_S)
 */
export type ShopActionReason =
	"funds" | "owned" | "limit" | "invalid" | "rate" | "loading" | "readonly" | "outdated" | "network" | "pending";

export interface ShopActionResult {
	ok: boolean;
	reason?: ShopActionReason;
	/** coins charged */
	price?: number;
	/**
	 * current server wallet (also sent with most refusals, so the client re-syncs). Never with "rate", "loading" or
	 * "readonly": a refusal that costs the server nothing to make must not cost it a wallet to answer (§8.2)
	 */
	wallet?: Wallet;
}

export interface NetRemotes {
	loadRequest: RemoteEvent;
	loadAck: RemoteEvent;
	saveRequest: RemoteEvent;
	saveAck: RemoteEvent;
	shopAction: RemoteFunction;
}

function ensureRemote<C extends "RemoteEvent" | "RemoteFunction">(
	folder: Folder,
	name: string,
	className: C,
): Instances[C] {
	const existing = folder.FindFirstChild(name);
	if (existing !== undefined) {
		if (existing.IsA(className)) return existing as Instances[C];
		existing.Destroy();
	}
	const created = new Instance(className);
	created.Name = name;
	created.Parent = folder;
	return created as unknown as Instances[C];
}

/** SERVER ONLY: creates (or reuses) the remotes */
export function createRemotes(): NetRemotes {
	const storage = game.GetService("ReplicatedStorage");
	let folder = storage.FindFirstChild(NET_FOLDER);
	if (folder === undefined || !folder.IsA("Folder")) {
		if (folder !== undefined) folder.Destroy();
		const created = new Instance("Folder");
		created.Name = NET_FOLDER;
		created.Parent = storage;
		folder = created;
	}
	const net = folder as Folder;
	return {
		loadRequest: ensureRemote(net, REMOTE_LOAD_REQUEST, "RemoteEvent"),
		loadAck: ensureRemote(net, REMOTE_LOAD_ACK, "RemoteEvent"),
		saveRequest: ensureRemote(net, REMOTE_SAVE_REQUEST, "RemoteEvent"),
		saveAck: ensureRemote(net, REMOTE_SAVE_ACK, "RemoteEvent"),
		shopAction: ensureRemote(net, REMOTE_SHOP_ACTION, "RemoteFunction"),
	};
}

/** CLIENT: waits for the server's remotes (undefined when they do not show up within `timeout` s) */
export function waitRemotes(timeout: number): NetRemotes | undefined {
	const storage = game.GetService("ReplicatedStorage");
	const folder = storage.WaitForChild(NET_FOLDER, timeout);
	if (folder === undefined) return undefined;
	const get = <C extends "RemoteEvent" | "RemoteFunction">(name: string, className: C): Instances[C] | undefined => {
		const child = folder.WaitForChild(name, timeout);
		return child !== undefined && child.IsA(className) ? (child as Instances[C]) : undefined;
	};
	const loadRequest = get(REMOTE_LOAD_REQUEST, "RemoteEvent");
	const loadAck = get(REMOTE_LOAD_ACK, "RemoteEvent");
	const saveRequest = get(REMOTE_SAVE_REQUEST, "RemoteEvent");
	const saveAck = get(REMOTE_SAVE_ACK, "RemoteEvent");
	const shopAction = get(REMOTE_SHOP_ACTION, "RemoteFunction");
	if (
		loadRequest === undefined ||
		loadAck === undefined ||
		saveRequest === undefined ||
		saveAck === undefined ||
		shopAction === undefined
	) {
		return undefined;
	}
	return { loadRequest, loadAck, saveRequest, saveAck, shopAction };
}
