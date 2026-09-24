import type { PlayerSaveData, Wallet } from "shared/game/save";

/*
 * Network protocol (ReplicatedStorage/Net). The server is the source of truth for coins and purchases;
 * the client simulates the game and REPORTS its progress, which the server validates.
 *
 *   LoadRequest  C→S  RemoteEvent     ()                       ask for (or re-try) the session save
 *   LoadAck      S→C  RemoteEvent     (LoadResult)             sent once the save is read (and on re-requests)
 *   SaveRequest  C→S  RemoteEvent     (token, json)            progress report, JSON of PlayerSaveData
 *   SaveAck      S→C  RemoteEvent     (SaveAckPayload)         result + coins earned + wallet
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
	/** coins granted by this report (days survived, milestones, bosses) */
	earned: number;
	earnedDays: number;
	earnedBosses: number;
	/** part of the progress was held back by the server's time limits: report again later */
	clamped: boolean;
	wallet?: Wallet;
	/**
	 * Not an answer to a report: the server pushed the wallet because the simulation changed it (XP, a level,
	 * midnight's coins). The client applies the wallet and nothing else -- no retry, no "saved" toast.
	 */
	push?: boolean;
}

export type ShopActionRequest =
	| { kind: "buyPack"; packId: number }
	| { kind: "buyCostume"; costumeId: number }
	/** MON-05: show an EARNED title under the name (-1 = none); the server checks it (server/save/titles.ts) */
	| { kind: "equipTitle"; titleId: number }
	| { kind: "rebirth"; runRev: number }
	| { kind: "newRun"; runRev: number }
	/**
	 * The shop (screen 0) or the wardrobe (1) just opened: no decision, nothing charged -- only the first step of the
	 * Shop funnel (server/analytics/events.ts `shopViewed`, rate-limited there). Fired and forgotten by the client.
	 */
	| { kind: "viewShop"; screen: number };

export type ShopActionReason =
	"funds" | "owned" | "limit" | "invalid" | "rate" | "loading" | "readonly" | "outdated" | "network";

export interface ShopActionResult {
	ok: boolean;
	reason?: ShopActionReason;
	/** coins charged */
	price?: number;
	/** current server wallet (also sent with most refusals, so the client re-syncs) */
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
