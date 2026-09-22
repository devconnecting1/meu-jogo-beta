import { applyWallet, PlayerSaveData, sanitizeStoredSave } from "shared/game/save";
import {
	LoadStatus,
	MAX_SAVE_PAYLOAD,
	NetRemotes,
	SAVE_MIN_INTERVAL,
	SaveAckPayload,
	SaveRejectReason,
	ShopActionReason,
	ShopActionRequest,
	ShopActionResult,
	waitRemotes,
} from "shared/net/net";

/*
 * Client side of the save protocol (see shared/net/net.ts).
 * - nothing is reported until a LoadAck was ADOPTED (activate), so a client that started on the
 *   8 s fallback save can never overwrite the real one
 * - reports are throttled to the server window, coalesced (latest state wins) and skipped when unchanged
 * - coins are display-only here: wallets from the server replace the local copy
 */

const HttpService = game.GetService("HttpService");

const REMOTE_TIMEOUT = 30;
const SEND_INTERVAL = SAVE_MIN_INTERVAL + 0.5;

export type SaveReason = "auto" | "manual" | "death" | "lobby" | "day" | "boss" | "packs" | "menu";

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
let manualQueued = false;
let manualInFlight = false;
let retryScheduled = false;

/** progress the server held back (time limits) or a stale report: report the current state again later */
const RETRY_CLAMPED_SEC = 45;
const RETRY_OUTDATED_SEC = 1;

const loadListeners = new Set<(info: LoadInfo) => void>();
const ackListeners = new Set<(ack: SaveAckPayload, manual: boolean) => void>();
const walletListeners = new Set<() => void>();

function subscribe<T>(set: Set<T>, fn: T): () => void {
	set.add(fn);
	return () => set.delete(fn);
}

export function onLoad(fn: (info: LoadInfo) => void): () => void {
	return subscribe(loadListeners, fn);
}

/** `manual` = the ack answers a report the player asked for (pause → Save) */
export function onSaveAck(fn: (ack: SaveAckPayload, manual: boolean) => void): () => void {
	return subscribe(ackListeners, fn);
}

/** coins / packs / costumes changed (server wallet applied to the local save) */
export function onWalletChanged(fn: () => void): () => void {
	return subscribe(walletListeners, fn);
}

function notifyWallet(): void {
	for (const fn of walletListeners) task.spawn(fn);
}

function applyServerWallet(wallet: unknown): void {
	if (getSave === undefined || wallet === undefined) return;
	if (applyWallet(getSave(), wallet)) notifyWallet();
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
		clamped: r.clamped === true,
		wallet: r.wallet as SaveAckPayload["wallet"],
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
			const manual = manualInFlight;
			manualInFlight = false;
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
			for (const fn of ackListeners) task.spawn(fn, ack, manual);
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

function sendNow(): void {
	const r = remotes;
	const token = activeToken;
	if (!savingEnabled() || r === undefined || token === undefined || getSave === undefined) {
		manualQueued = false;
		return;
	}
	const json = HttpService.JSONEncode(getSave());
	const manual = manualQueued;
	manualQueued = false;
	if (json === lastSentJson) {
		// nothing new since the last report: the server already has it
		if (manual) {
			const ack: SaveAckPayload = { ok: true, earned: 0, earnedDays: 0, earnedBosses: 0, clamped: false };
			for (const fn of ackListeners) task.spawn(fn, ack, true);
		}
		return;
	}
	if (json.size() > MAX_SAVE_PAYLOAD) {
		warn(`[saveClient] save too large to report (${json.size()} chars)`);
		return;
	}
	lastSentJson = json;
	lastSentAt = os.clock();
	manualInFlight = manualInFlight || manual;
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
 */
export function requestSave(reason: SaveReason): boolean {
	if (!savingEnabled()) return false;
	if (reason === "manual") manualQueued = true;
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
]);

/** shop purchase / rebirth. YIELDS until the server answers; call from a click handler or task. */
export function invokeShopAction(request: ShopActionRequest): ShopActionResult {
	const r = remotes;
	if (r === undefined) return { ok: false, reason: "network" };
	const [ok, raw] = pcall(() => r.shopAction.InvokeServer(request));
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
