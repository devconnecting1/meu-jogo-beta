import { GAME_NAME } from "shared/module";
import {
	bagOf,
	bagSignature,
	copySaveInto,
	defaultSave,
	enforceSaveInvariants,
	PlayerSaveData,
	resetRun,
	SAVE_LIMITS,
	sanitizeClientReport,
	sanitizeStoredSave,
	walletOf,
} from "shared/game/save";
import { ECONOMY, rebirthPrice, SHOP_PACKS } from "shared/data/shop";
import {
	createRemotes,
	LoadResult,
	LoadStatus,
	MAX_SAVE_PAYLOAD,
	SAVE_MIN_INTERVAL,
	SaveAckPayload,
	SaveRejectReason,
	ShopActionReason,
	ShopActionResult,
} from "shared/net/net";
import { isAdminUserId } from "shared/admin/config";
import { AdminOp, applyAdminOps } from "shared/admin/ops";
import { MP_PHASE } from "shared/net/mpConfig";
import { startBackpackIntents } from "./net/backpackIntents";
import { AdminEditOutcome, AdminLiveView, AdminServer, startAdminServer } from "./admin/adminServer";
import { MpHost, startMpHost } from "./net/mpHost";
import { LEGACY_STORE, ownerTag, SAVE_STORE } from "./save/stores";
import { buyCostume } from "./save/costumes";
import { equipTitle } from "./save/titles";
import * as TitleRecord from "./save/titleRecord";
import { serverOwnsProgress, stripClientProgress } from "./sim/progress";
import { serverOwnsBackpack, stripClientBackpack } from "./sim/backpack";
import { runActionRefusal, stripClientLife } from "./sim/life";
import { stripClientAchievements } from "./save/achievements";
import { startProximityChat } from "./chat/proximityChat";
import { startWorldLog } from "./save/worldLog";
import * as Analytics from "./analytics/events";

/*
 * Server = source of truth for the economy and for what reaches the DataStore.
 * - coins only change here (shop purchases, rebirth, rewards computed from validated progress)
 * - progress reports from the client are schema-checked, clamped and rate/plausibility limited
 * - DataStore: UpdateAsync with a session lock, autosave every 60 s, save on leave and on shutdown,
 *   retries with backoff, and a read error NEVER turns into an overwrite (read-only session)
 */

const Players = game.GetService("Players");
const DataStoreService = game.GetService("DataStoreService");
const HttpService = game.GetService("HttpService");
const RunService = game.GetService("RunService");

Players.CharacterAutoLoads = false;

/**
 * v2/v3 documents ({ data, lock }) live in their own store: a server still running the v1 code expects a
 * raw string there and would overwrite anything else with a blank save. In Studio both names carry a
 * suffix, so a playtest can never write over a live player's save (server/save/stores.ts).
 */
const DATA_STORE_NAME = SAVE_STORE;
/** v1 store (raw JSON strings, written by the client-trusting server): read to migrate a first v2 session */
const LEGACY_STORE_NAME = LEGACY_STORE;
/** v1 balances were written by the client (free "+5" buttons / exploit): cap what is carried over */
const LEGACY_MONEY_CAP = 500;
const AUTOSAVE_INTERVAL = 60;
/** waits between attempts of a DataStore call (4 attempts in total) */
const RETRY_DELAYS = [1, 2, 4];
const SHUTDOWN_RETRY_DELAYS = [0.5, 1];
const SHUTDOWN_BUDGET = 25;
/** a DataStore value may hold up to 4 MB */
const MAX_STORED_LENGTH = 3900000;
/** keep at least this many UpdateAsync requests for joins/leaves before autosaving */
const AUTOSAVE_MIN_BUDGET = 4;

/** session lock: another server's lock is honoured while it is fresher than this (s) */
const LOCK_STALE = 300;
/** rewrite (refreshing the lock) at least this often even without changes (s) */
const LOCK_REFRESH = 150;
/** how long a join waits for another server to release the lock before taking it over (s) */
const LOCK_WAIT = 15;
const JOB_ID = game.JobId !== "" ? game.JobId : `studio-${HttpService.GenerateGUID(false)}`;

/** client can re-request a failed load at most this often (s) */
const LOAD_RETRY_COOLDOWN = 10;

// Plausibility of client-simulated progress, as credits refilled by real session time.
// A real in-game day takes ~8-11 min, so +1 day / 3 min never limits an honest player.
const DAY_SECONDS = 180;
const DAY_CREDIT_MAX = 5;
const BOSS_SECONDS = 90;
const BOSS_CREDIT_MAX = 4;
/** 0: a fresh session (e.g. after reconnecting) never starts with reward credit */
const BOSS_CREDIT_START = 0;
const LEVEL_SECONDS = 20;
const LEVEL_CREDIT_MAX = 15;
const LEVEL_CREDIT_START = 5;

/** shop/rebirth requests: token bucket */
const ACTION_BURST = 6;
const ACTION_PER_SECOND = 2;
/** the ShopAction kinds this server knows: anything else is a malformed request (§8.2) */
const SHOP_KINDS = new Set<string>(["buyPack", "buyCostume", "equipTitle", "rebirth", "newRun"]);
/**
 * A REJECTED report is answered at most this often (s; audit M2). An honest client reports once per
 * SAVE_MIN_INTERVAL and retries an "outdated" one after 1 s, so it never sees this; a stream of junk SaveRequests
 * used to be reflected one SaveAck (with a wallet) per message.
 */
const REJECT_ACK_INTERVAL = 1;

/**
 * After an admin edit the player's reports are refused until their client confirms the patch (AdminPatchAck),
 * at most this long (s). runRev is bumped by the edit, so a report captured before it is refused anyway; the
 * gate only covers a report that learnt the new runRev from a wallet before the patch itself was applied.
 */
const PATCH_ACK_TIMEOUT = 20;
/** while the gate refuses reports, the patch is re-sent at most this often, and the gate only opens by timeout
 * after this many re-sends went unanswered (a client that missed the patch gets it again instead) */
const PATCH_RESEND_INTERVAL = 5;
const PATCH_MIN_RESENDS = 3;

interface Credits {
	day: number;
	boss: number;
	level: number;
	at: number;
}

interface Session {
	player: Player;
	key: string;
	sid: string;
	loaded: boolean;
	loading: boolean;
	status: LoadStatus;
	/** another server took the lock over: stop writing */
	lockLost: boolean;
	token: string;
	save: PlayerSaveData;
	dirty: boolean;
	writing: boolean;
	released: boolean;
	lastWrite: number;
	ackRequested: boolean;
	lastAck: number;
	/** os.clock() of the last rejection answered (REJECT_ACK_INTERVAL) */
	lastRejectAck: number;
	lastReport: number;
	pending: string | undefined;
	pendingToken: string | undefined;
	pendingScheduled: boolean;
	/** end of the last load attempt */
	lastLoadAttempt: number;
	retryQueued: boolean;
	credits: Credits;
	actionTokens: number;
	actionAt: number;
	closed: boolean;
	/** os.clock() when the player joined (admin panel) */
	joinedAt: number;
	/** admin patch waiting for the client's AdminPatchAck (undefined = none) */
	patchRev: number | undefined;
	patchDeadline: number;
	/** re-sends the pending admin patch (set by adminServer) */
	patchResend: (() => void) | undefined;
	patchResentAt: number;
	patchResends: number;
	/** runRev of a run in which an admin used world tools: it earns no coins / achievements / records */
	assistedRunRev: number | undefined;
	/**
	 * Reports that tried to move a progress field the SERVER owns from MP_PHASE 2 on (§11.3 F2). It is not an
	 * accusation — an honest client still mirrors what it thinks its XP is — only a number for the admin
	 * panel (§9.3), so a client that is genuinely out of date can be told apart from one that never listens.
	 */
	staleProgressReports: number;
	/**
	 * MON-05: the fingerprint of what the title record (server/save/titleRecord.ts) holds for this player (nothing
	 * stored = an empty record of this save's history), so a flush rewrites it only when something was earned.
	 * undefined = the load could not read it: the next write MERGES into the record instead of replacing it, because
	 * this session never saw what is there.
	 */
	titleMark: string | undefined;
	/** the same, with the kills in steps (`titleRecordStep`): what an autosave compares against */
	titleStep: string | undefined;
	/**
	 * MON-05: the next record write REPLACES the record whatever this session read of it -- the save is a new title
	 * history (a missing save, an admin reset) that nothing in the record may flow back into. Cleared by the first
	 * write that lands.
	 */
	titleReplace: boolean;
}

interface StoredLock {
	job: string;
	sid: string;
	t: number;
}

interface StoredDoc {
	data: unknown;
	lock: StoredLock | undefined;
}

const remotes = createRemotes();
// before any session loads: the Economy / Funnel / Custom dashboards (docs/ANALYTICS.md); off when there is no service
Analytics.start();
const [storeOk, storeValue] = pcall((): unknown => DataStoreService.GetDataStore(DATA_STORE_NAME));
const dataStore = storeOk ? (storeValue as DataStore) : undefined;
if (dataStore === undefined) {
	warn(`[${GAME_NAME}] DataStore unavailable: ${tostring(storeValue)} — progress will not be saved`);
}
const [legacyOk, legacyValue] = pcall((): unknown => DataStoreService.GetDataStore(LEGACY_STORE_NAME));
const legacyStore = legacyOk ? (legacyValue as DataStore) : undefined;

const sessions = new Map<Player, Session>();
/** users whose previous session on this server is still writing its final save */
const releasing = new Set<number>();
let shuttingDown = false;
/** admin panel (server/admin/adminServer.ts), started at the end of this script */
let admin: AdminServer | undefined;
let adminPatchSerial = 0;
/** authoritative simulation (server/net/mpHost.ts); undefined while MP_PHASE = 0 (docs/MULTIPLAYER.md §11.1) */
let mpHost: MpHost | undefined;

// ---------------------------------------------------------------- session state helpers

function persists(s: Session): boolean {
	return (s.status === "ok" || s.status === "new") && !s.lockLost && dataStore !== undefined;
}

function isReadOnly(s: Session): boolean {
	return s.status === "error" || s.lockLost;
}

/** the session of a `ServerPlayer` (the simulation only knows UserIds); at most MAX_PLAYERS entries */
function sessionOfUserId(userId: number): Session | undefined {
	for (const [player, s] of sessions) {
		if (player.UserId === userId) return s;
	}
	return undefined;
}

/**
 * §8.2 for the remotes this file owns (audit M2): every SaveRequest, LoadRequest, ShopAction and admin message counts
 * toward the same flood limits as the MP channels, per connection (server/net/mpHost.ts `noteRemote`); `malformed`
 * when the payload is not what the remote takes. True when the message must be dropped (the player is being kicked,
 * or has left). With MP_PHASE 0 there is no host and nothing is counted: the old per-remote limits stand alone.
 */
function floodDrop(player: Player, malformed: boolean): boolean {
	return mpHost?.noteRemote(player, malformed) === true;
}

/** the server just wrote into this survivor's save: the next autosave must carry it */
function markDirty(userId: number): void {
	const s = sessionOfUserId(userId);
	if (s !== undefined && !s.closed) s.dirty = true;
}

function resetCredits(s: Session): void {
	s.credits = { day: 0, boss: BOSS_CREDIT_START, level: LEVEL_CREDIT_START, at: os.clock() };
}

function refillCredits(s: Session): void {
	const now = os.clock();
	const dt = math.max(0, now - s.credits.at);
	s.credits.at = now;
	s.credits.day = math.min(DAY_CREDIT_MAX, s.credits.day + dt / DAY_SECONDS);
	s.credits.boss = math.min(BOSS_CREDIT_MAX, s.credits.boss + dt / BOSS_SECONDS);
	s.credits.level = math.min(LEVEL_CREDIT_MAX, s.credits.level + dt / LEVEL_SECONDS);
}

function waitUntil(check: () => boolean, timeout: number): boolean {
	const t0 = os.clock();
	while (!check()) {
		if (os.clock() - t0 >= timeout) return false;
		task.wait(0.1);
	}
	return true;
}

/** xpcall's handler: the error with the stack it was raised on, for the log and the Error Report (F6) */
function traceback(err: unknown): string {
	return debug.traceback(tostring(err), 2);
}

/**
 * Runs `fn`, reporting a throw (with its traceback) instead of passing it on, so whatever follows still runs: a
 * leave's final write, the cleanup after it, the autosave of everybody else (F5). undefined when it threw.
 */
function guarded<T>(what: string, fn: () => T): T | undefined {
	const [ok, value] = xpcall(fn, traceback);
	if (ok) return value as T;
	warn(`[${GAME_NAME}] ${what} failed: ${tostring(value)}`);
	return undefined;
}

// ---------------------------------------------------------------- DataStore documents

function readLock(v: unknown): StoredLock | undefined {
	if (!typeIs(v, "table")) return undefined;
	const l = v as Record<string, unknown>;
	if (!typeIs(l.job, "string") || !typeIs(l.sid, "string") || !typeIs(l.t, "number")) return undefined;
	return { job: l.job, sid: l.sid, t: l.t };
}

/** v1 stored the raw JSON string; v2 stores { data = json, lock = {job, sid, t} } */
function readDoc(old: unknown): StoredDoc | undefined {
	if (old === undefined) return undefined;
	if (typeIs(old, "string")) return { data: old, lock: undefined };
	if (typeIs(old, "table")) {
		const t = old as Record<string, unknown>;
		return { data: t.data, lock: readLock(t.lock) };
	}
	return { data: undefined, lock: undefined };
}

/** [ok, value]: a stored value that is not valid JSON is reported as a failure (never replaced by a blank save) */
function decodeData(data: unknown): [boolean, unknown] {
	if (typeIs(data, "string")) {
		const [ok, value] = pcall((): unknown => HttpService.JSONDecode(data));
		if (ok && typeIs(value, "table")) return [true, value];
		return [false, undefined];
	}
	return [typeIs(data, "table"), data];
}

type LoadOutcome = { kind: "found"; data: unknown } | { kind: "empty" } | { kind: "failed"; err: string };

/** reads the save and takes the session lock in one UpdateAsync (retries with backoff) */
function loadWithLock(s: Session): LoadOutcome {
	const store = dataStore;
	if (store === undefined) return { kind: "failed", err: "no DataStore" };
	const deadline = os.clock() + LOCK_WAIT;
	let attempt = 0;
	while (true) {
		let result = "empty" as "found" | "empty" | "locked";
		let data: unknown;
		const [ok, err] = pcall(() => {
			store.UpdateAsync<unknown, unknown>(s.key, old => {
				const doc = readDoc(old);
				const now = os.time();
				const lock = doc?.lock;
				const foreign =
					lock !== undefined &&
					(lock.job !== JOB_ID || (lock.sid !== s.sid && releasing.has(s.player.UserId)));
				if (lock !== undefined && foreign && now - lock.t < LOCK_STALE && os.clock() < deadline) {
					result = "locked";
					return $tuple(undefined);
				}
				data = doc?.data;
				result = data === undefined ? "empty" : "found";
				// tagged with its owner's UserId (GDPR tooling reads it from the key: server/save/stores.ts ownerTag)
				return $tuple({ data, lock: { job: JOB_ID, sid: s.sid, t: now } }, ownerTag(s.player.UserId));
			});
		});
		if (ok) {
			if (result === "locked") {
				// another server is still writing this player's last session: give it time to release
				task.wait(2);
				continue;
			}
			return result === "found" ? { kind: "found", data } : { kind: "empty" };
		}
		if (attempt >= RETRY_DELAYS.size()) return { kind: "failed", err: tostring(err) };
		warn(`[${GAME_NAME}] load ${s.key} failed (attempt ${attempt + 1}): ${tostring(err)}`);
		task.wait(RETRY_DELAYS[attempt]);
		attempt++;
	}
}

type WriteOutcome = "ok" | "lost" | "failed";

/** `json` undefined: only the lock changes, the stored data stays (a leave whose own write could not be made, F5) */
function writeWithLock(s: Session, json: string | undefined, release: boolean, delays: Array<number>): WriteOutcome {
	const store = dataStore;
	if (store === undefined) return "failed";
	for (let attempt = 0; ; attempt++) {
		let lost = false as boolean;
		const [ok, err] = pcall(() => {
			store.UpdateAsync<unknown, unknown>(s.key, old => {
				const doc = readDoc(old);
				const lock = doc?.lock;
				if (lock === undefined || lock.job !== JOB_ID || lock.sid !== s.sid) {
					// lock released or owned by another session (here or on another server): this copy is stale
					lost = true;
					return $tuple(undefined);
				}
				lost = false;
				const nextLock = release ? undefined : { job: JOB_ID, sid: s.sid, t: os.time() };
				return $tuple({ data: json ?? doc?.data, lock: nextLock }, ownerTag(s.player.UserId));
			});
		});
		if (ok) return lost ? "lost" : "ok";
		if (attempt >= delays.size()) {
			warn(`[${GAME_NAME}] save ${s.key} failed: ${tostring(err)}`);
			return "failed";
		}
		task.wait(delays[attempt]);
	}
}

/**
 * A session on its way out whose own write cannot be made (it threw, it is too large, the session is read-only): its
 * lock at least goes back -- only while it is still this session's, the stored data untouched -- so the player's next
 * server loads the last save that landed without waiting LOCK_WAIT for this one (F5)
 */
function handBackLock(s: Session, delays: Array<number>): void {
	if (writeWithLock(s, undefined, true, delays) !== "failed") s.released = true;
}

/**
 * The title record (server/save/titleRecord.ts) brought up to date with the save when it is due (`titleRecordDue`:
 * a title, a new history, a step of kills -- or, `final`, anything at all on leaving).
 */
function syncTitleRecord(s: Session, final: boolean): void {
	// never in the way of the save it rides with (F5): a throw is reported and the save is written without the record,
	// which the next save (or the player's next session) brings up to date from it (`titleRecordDue`)
	guarded(`${s.key}: title record`, () => writeTitleRecord(s, final));
}

function writeTitleRecord(s: Session, final: boolean): void {
	if (!TitleRecord.titleRecordDue(s.save, s.titleMark, s.titleStep, s.titleReplace, final)) return;
	// start a new history over whatever is there (a missing save, an admin reset); replace a record this session
	// has read; merge into one it never saw
	const mode = s.titleReplace ? "restart" : s.titleMark !== undefined ? "replace" : "merge";
	const written = TitleRecord.storeTitleRecord(s.key, s.save, mode, s.player.UserId);
	if (written === undefined) return;
	s.titleReplace = false;
	// what landed goes back into the save (which is then written again): what a merge found and the load could not
	// read, the epoch a restart stamped, or a LATER history this session was not told of (it lost the lock without
	// knowing: its save write is about to be refused anyway). From here on replacing can never lower the record
	if (TitleRecord.mergeTitleRecord(s.save, written)) s.dirty = true;
	s.titleMark = TitleRecord.titleRecordMark(written);
	s.titleStep = TitleRecord.titleRecordStep(written);
}

/**
 * May a leave write the title record BEFORE its save (review S2)? That save releases the session lock, and every
 * second in front of it is a second the player's next server waits for the lock (LOCK_WAIT) -- past that, it takes
 * the lock and this save comes back "lost", with up to a minute of play. So the record stays out of the way:
 *   - at shutdown: BindToClose shares SHUTDOWN_BUDGET among every save and its retries;
 *   - on a low UpdateAsync budget (the autosave's own floor): a queued request waits in front of the save;
 *   - while the title store is slow or failing (server/save/titleRecord.ts `titleStoreHealthy`).
 * Nothing is lost by skipping it: the save has what was earned, and the player's next session writes the record
 * from it (`titleRecordDue` sees the difference).
 */
function recordBeforeRelease(): boolean {
	if (shuttingDown || !TitleRecord.titleStoreHealthy()) return false;
	return (
		DataStoreService.GetRequestBudgetForRequestType(Enum.DataStoreRequestType.UpdateAsync) >= AUTOSAVE_MIN_BUDGET
	);
}

/**
 * Writes the session to the DataStore when needed. Calls are serialized per session.
 * `release` also drops the session lock (player left / server closing).
 */
function flush(s: Session, release: boolean, delays: Array<number> = RETRY_DELAYS): boolean {
	if (!s.loaded || s.released) return true;
	if (!persists(s)) {
		// a read-only session may still hold the lock its load took (a load that threw after it, a stored save that is
		// not JSON): on the way out it goes back all the same
		if (release && s.status === "error" && !s.lockLost && dataStore !== undefined) handBackLock(s, delays);
		return false;
	}
	if (!waitUntil(() => !s.writing, 30)) return false;
	if (s.released) return true;
	const refreshDue = os.clock() - s.lastWrite >= LOCK_REFRESH;
	if (!release && !s.dirty && !refreshDue) return true;
	s.writing = true;
	// the window runs protected, so `writing` always comes back down: a throw in it (the encode, say) used to leave it
	// up for good, and every later flush of the session then waited 30 s and gave up -- never saved again (F5)
	const [ran, written] = xpcall(() => writeSession(s, release, delays), traceback);
	if (!ran) {
		warn(`[${GAME_NAME}] save ${s.key} failed: ${tostring(written)}`);
		s.dirty = true;
		// a session on its way out gets no other try
		if (release && !s.released) handBackLock(s, delays);
	}
	s.writing = false;
	return ran && written === true;
}

/** the writing window of `flush`, which holds `s.writing` around it */
function writeSession(s: Session, release: boolean, delays: Array<number>): boolean {
	// MON-05: what was earned also goes to the title record a rolled-back server cannot drop, by the session that
	// believes it holds the lock and inside the same writing window. On release it goes FIRST: the save write below
	// drops the lock, and from then on another server may load this player and own both documents -- a record
	// written after that could land on top of theirs. (Anything the record hands back is in the save encoded below.)
	// A server that already lost the lock without knowing it still gets here; `nextTitleRecord` never lets its write
	// land over a later history (a reset made where the lock went).
	if (release && recordBeforeRelease()) syncTitleRecord(s, true);
	const json = HttpService.JSONEncode(s.save);
	if (json.size() > MAX_STORED_LENGTH) {
		warn(`[${GAME_NAME}] save ${s.key} too large (${json.size()} chars), not written`);
		if (release) handBackLock(s, delays);
		return false;
	}
	const wasDirty = s.dirty;
	s.dirty = false;
	const outcome = writeWithLock(s, json, release, delays);
	// every other write: right after the save, which just proved this session still holds the lock
	if (outcome === "ok" && !release) syncTitleRecord(s, false);
	if (outcome === "ok") {
		s.lastWrite = os.clock();
		if (release) s.released = true;
		return true;
	}
	if (outcome === "lost") {
		s.lockLost = true;
		warn(`[${GAME_NAME}] ${s.key}: session lock taken by another session; this copy is now read-only`);
		return false;
	}
	s.dirty = s.dirty || wasDirty;
	return false;
}

// ---------------------------------------------------------------- load

function sendLoadAck(s: Session): void {
	if (s.closed || !s.loaded) return;
	s.lastAck = os.clock();
	const result: LoadResult = {
		status: s.status,
		token: s.token,
		persist: persists(s),
		acceptsReports: !isReadOnly(s),
		save: s.save,
	};
	remotes.loadAck.FireClient(s.player, result);
}

function freshSave(withGift: boolean): PlayerSaveData {
	const save = defaultSave();
	if (withGift) save.money = ECONOMY.STARTING_COINS;
	return save;
}

/** reads a v1 save (raw JSON string) from the legacy store, with retries */
function readLegacy(key: string): LoadOutcome {
	const store = legacyStore;
	if (store === undefined) return { kind: "failed", err: "no legacy DataStore" };
	for (let attempt = 0; ; attempt++) {
		const [ok, value] = pcall((): unknown => store.GetAsync<unknown>(key)[0]);
		if (ok) return value === undefined ? { kind: "empty" } : { kind: "found", data: value };
		if (attempt >= RETRY_DELAYS.size()) return { kind: "failed", err: tostring(value) };
		task.wait(RETRY_DELAYS[attempt]);
	}
}

function loadSession(s: Session): void {
	if (s.loading) return;
	s.loading = true;
	// protected like flush's window (F5): a throw in the load used to leave `loading` up and `loaded` down for good --
	// no LoadAck, every Retry refused, and a leave that waited a minute for a load that never came
	const [ran, err] = xpcall(() => readSession(s), traceback);
	s.loading = false;
	if (ran) return;
	warn(`[${GAME_NAME}] ${s.key}: load failed: ${tostring(err)}`);
	if (s.loaded) return; // it threw after the load was done (the ack): what was loaded stands
	// what a read that failed gives: a read-only session on a blank save, never written, that the client may retry
	s.status = "error";
	s.save = defaultSave();
	s.lockLost = false;
	s.token = HttpService.GenerateGUID(false);
	s.pending = undefined;
	s.pendingToken = undefined;
	s.lastLoadAttempt = os.clock();
	s.loaded = true;
	if (s.ackRequested) sendLoadAck(s);
}

function readSession(s: Session): void {
	// a second load in one session is always the retry of a failed one: until now the player had the blank,
	// read-only table below, and "Play without saving" may have played a life on it
	const retried = s.lastLoadAttempt !== -math.huge;
	const blank = s.save;
	waitUntil(() => !releasing.has(s.player.UserId), 20);
	let status: LoadStatus;
	let save: PlayerSaveData;
	let migrated = false;
	let outcome: LoadOutcome = dataStore === undefined ? { kind: "failed", err: "no DataStore" } : loadWithLock(s);
	if (outcome.kind === "empty") {
		// no v2 save yet: migrate the v1 one if there is one (a failed read must NOT look like a new player)
		outcome = readLegacy(s.key);
		migrated = outcome.kind === "found";
	}
	if (dataStore === undefined) {
		status = "unavailable";
		save = freshSave(true);
	} else if (outcome.kind === "found") {
		const [decoded, value] = decodeData(outcome.data);
		if (decoded) {
			status = "ok";
			save = sanitizeStoredSave(value);
			if (migrated && save.money > LEGACY_MONEY_CAP) {
				warn(`[${GAME_NAME}] ${s.key}: v1 balance ${save.money} capped to ${LEGACY_MONEY_CAP} on migration`);
				save.money = LEGACY_MONEY_CAP;
			}
		} else {
			// unreadable data is still the player's data: never replace it with a blank save
			warn(`[${GAME_NAME}] ${s.key}: stored save is not valid JSON; read-only session`);
			status = "error";
			save = defaultSave();
		}
	} else if (outcome.kind === "empty") {
		status = "new";
		save = freshSave(true);
	} else if (RunService.IsStudio()) {
		// Studio without API access: play normally in memory, never write
		warn(`[${GAME_NAME}] Studio: DataStore read failed (${outcome.err}); progress will not be saved`);
		status = "unavailable";
		save = freshSave(true);
	} else {
		// the save exists but could not be read: do NOT start a fresh one that would overwrite it
		warn(`[${GAME_NAME}] ${s.key}: load failed after retries (${outcome.err}); read-only session`);
		status = "error";
		save = defaultSave();
	}
	// MON-05: a server rolled back to v4 code rewrites the save without what was earned; the title record it never
	// opens still has it (server/save/titleRecord.ts). Only for a save this session will write.
	let restored = false;
	let titleMark: string | undefined;
	let titleStep: string | undefined;
	let titleReplace = false;
	if (status === "ok" || status === "new") {
		const read = TitleRecord.loadTitleRecord(s.key);
		const record = read.ok ? read.record : undefined;
		if (status === "new") {
			// no save: a first visit, or a key deleted on purpose. Whatever the record holds is a history that ended
			// -- never merged, replaced at the first write (as is one that could not be read), and this save starts
			// a later one
			const recordEpoch = record !== undefined ? record.epoch : 0;
			save.titleEpoch = math.min(math.max(os.time(), recordEpoch + 1), SAVE_LIMITS.EPOCH_MAX);
			titleReplace = !read.ok || record !== undefined;
		} else if (record !== undefined) {
			restored = TitleRecord.mergeTitleRecord(save, record);
			// a record of a history this save ended (an admin reset whose record write failed): replaced at once
			titleReplace = record.epoch < save.titleEpoch;
		}
		if (read.ok) {
			// nothing stored reads as nothing earned in this save's history: no write until something is
			const known = record ?? TitleRecord.emptyTitleRecord(save.titleEpoch);
			titleMark = TitleRecord.titleRecordMark(known);
			titleStep = TitleRecord.titleRecordStep(known);
		}
	}
	s.status = status;
	s.save = save;
	s.titleMark = titleMark;
	s.titleStep = titleStep;
	s.titleReplace = titleReplace;
	s.dirty = status === "new" || (status === "ok" && migrated) || restored;
	s.lockLost = false;
	s.token = HttpService.GenerateGUID(false);
	s.pending = undefined;
	s.pendingToken = undefined;
	s.lastReport = -math.huge;
	s.lastWrite = os.clock();
	resetCredits(s);
	s.lastLoadAttempt = os.clock();
	// a real save replaced the blank one: whatever the body lived through on the blank table (a death, a kept
	// body) happened to nobody's save, and must not carry into this one (server/sim/life.ts `forgetUnsaved`;
	// review of de4ba1e, R3b). A retry that failed again keeps playing, unsaved, on the next blank table
	if (retried && status !== "error") mpHost?.forgetUnsaved(s.player, blank);
	// a stored save meets the body this server kept, BEFORE the LoadAck shows it to the client: a reconnect is
	// reconciled, and a new life that a world which ended while they were away owes them is granted now (MP-22,
	// server/sim/life.ts `adopt`). Only a real stored save: a read-only session's blank one is nobody's truth.
	// Guarded (F5): what the keeper already did with this save -- an owed new life granted on it, which it will not
	// grant twice -- stays with the session that keeps the save, instead of going down with a load thrown away
	const adopted = status === "ok" && guarded(`${s.key}: meeting the kept body`, () => mpHost?.adopt(s.player, save));
	if (adopted === true) s.dirty = true;
	Analytics.sessionLoaded(s.player, status, save);
	s.loaded = true;
	s.loading = false;
	if (s.closed) {
		// the player left while we were loading: drop the lock we just took
		flush(s, true);
		return;
	}
	if (s.ackRequested) sendLoadAck(s);
}

function newSession(player: Player): Session {
	return {
		player,
		key: tostring(player.UserId),
		sid: HttpService.GenerateGUID(false),
		loaded: false,
		loading: false,
		status: "error",
		lockLost: false,
		token: "",
		save: defaultSave(),
		dirty: false,
		writing: false,
		released: false,
		lastWrite: 0,
		ackRequested: false,
		lastAck: -math.huge,
		lastRejectAck: -math.huge,
		lastReport: -math.huge,
		pending: undefined,
		pendingToken: undefined,
		pendingScheduled: false,
		lastLoadAttempt: -math.huge,
		retryQueued: false,
		credits: { day: 0, boss: 0, level: 0, at: os.clock() },
		actionTokens: ACTION_BURST,
		actionAt: os.clock(),
		closed: false,
		joinedAt: os.clock(),
		patchRev: undefined,
		patchDeadline: 0,
		patchResend: undefined,
		patchResentAt: 0,
		patchResends: 0,
		staleProgressReports: 0,
		assistedRunRev: undefined,
		titleMark: undefined,
		titleStep: undefined,
		titleReplace: false,
	};
}

function onPlayerAdded(player: Player): void {
	if (sessions.has(player)) return;
	const s = newSession(player);
	sessions.set(player, s);
	loadSession(s);
}

remotes.loadRequest.OnServerEvent.Connect(player => {
	if (floodDrop(player, false)) return;
	const s = sessions.get(player);
	if (s === undefined || s.closed) return;
	s.ackRequested = true;
	if (!s.loaded) return; // the ack goes out as soon as the load finishes
	if (s.status === "error") {
		// the player asked to retry a failed load: run it once the cooldown has passed
		if (s.loading || s.retryQueued) return;
		// never under a body in the world (review of de4ba1e, R3b/N4): it was built on the blank table, and the real
		// save must not be swapped in beneath it — its death, or its being alive, would become the real save's. The
		// client offers Retry only from the lobby; from the street the request is dropped, and can be sent again there
		if (mpHost?.playerOf(s.player) !== undefined) return;
		s.retryQueued = true;
		const wait = math.max(0, LOAD_RETRY_COOLDOWN - (os.clock() - s.lastLoadAttempt));
		task.delay(wait, () => {
			s.retryQueued = false;
			if (s.closed || s.status !== "error") return;
			// (the queued retry holds admission, see `saveOf` below, so nobody walked in meanwhile)
			if (mpHost?.playerOf(s.player) !== undefined) return;
			s.loaded = false;
			loadSession(s);
		});
		return;
	}
	if (os.clock() - s.lastAck >= 1) sendLoadAck(s);
});

// ---------------------------------------------------------------- progress reports

interface Reward {
	coins: number;
	days: number;
	bosses: number;
	/** part of the report was held back by the plausibility limits (the client should report again later) */
	clamped: boolean;
}

/**
 * time-based plausibility + coin rewards. Mutates `upd` (the sanitized report), `prev` is the trusted copy.
 * `trusted` (admins, see shared/admin/config.ts): the time limits are skipped — admin world tools (skip to night,
 * spawn bosses...) legitimately advance faster than real time. Schema checks and save invariants still apply.
 * `assisted` (a run in which an admin used world tools): the day may advance, but the run pays no coins and keeps
 * the previous achievements and boss kills; the record (bestDay) only moves when the save invariant (bestDay ≥ day)
 * forces it, and then without its milestone bonus.
 */
function applyProgressLimits(
	s: Session,
	prev: PlayerSaveData,
	upd: PlayerSaveData,
	trusted: boolean,
	assisted: boolean,
): Reward {
	refillCredits(s);
	const reward: Reward = { coins: 0, days: 0, bosses: 0, clamped: false };
	const credit = (c: number): number => (trusted ? math.huge : math.floor(c));
	/*
	 * Who pays. From MP_PHASE 2 on the server counts the day and the boss itself and pays for them the
	 * moment they happen (server/sim/progress.ts), so this path must not pay again. `stripClientProgress`
	 * has already pinned `day` and `bossKills` to `prev`, which makes the windows below unreachable — but
	 * "unreachable" is a property of another function, and if the pin ever moves, silently paying twice is
	 * the worst possible failure. The flag makes it a rule.
	 */
	const payHere = !serverOwnsProgress();

	// days: at most the credited amount; each new day pays, each new record multiple of 5 pays a bonus
	if (upd.day > prev.day) {
		const gained = math.min(upd.day - prev.day, credit(s.credits.day));
		if (gained < upd.day - prev.day) reward.clamped = true;
		s.credits.day = math.max(0, s.credits.day - gained);
		upd.day = prev.day + gained;
		reward.days = gained;
		if (payHere) reward.coins += gained * ECONOMY.COINS_PER_DAY;
	}
	if (payHere && upd.day > prev.bestDay) {
		for (let d = prev.bestDay + 1; d <= upd.day; d++) {
			if (d % ECONOMY.MILESTONE_EVERY === 0) reward.coins += ECONOMY.MILESTONE_BONUS;
		}
	}
	upd.bestDay = math.max(prev.bestDay, upd.day);

	// bosses: lifetime counter, never decreases, limited per real minute
	if (upd.bossKills < prev.bossKills) {
		upd.bossKills = prev.bossKills;
	} else if (upd.bossKills > prev.bossKills) {
		const gained = math.min(upd.bossKills - prev.bossKills, credit(s.credits.boss));
		if (gained < upd.bossKills - prev.bossKills) reward.clamped = true;
		s.credits.boss = math.max(0, s.credits.boss - gained);
		upd.bossKills = prev.bossKills + gained;
		reward.bosses = gained;
		if (payHere) reward.coins += gained * ECONOMY.COINS_PER_BOSS;
	}

	// levels: limited per real minute (the rest is accepted by later reports as credit refills)
	if (upd.level > prev.level) {
		const gained = math.min(upd.level - prev.level, credit(s.credits.level));
		s.credits.level = math.max(0, s.credits.level - gained);
		if (gained < upd.level - prev.level) {
			reward.clamped = true;
			upd.level = prev.level + gained;
			upd.exp = 0;
		}
	}

	if (assisted) {
		reward.coins = 0;
		reward.days = 0;
		reward.bosses = 0;
		upd.bossKills = prev.bossKills;
		upd.achievements = [...prev.achievements];
		upd.bestDay = math.max(prev.bestDay, upd.day);
	}

	upd.money = math.min(prev.money + reward.coins, SAVE_LIMITS.MONEY_MAX);
	enforceSaveInvariants(upd, prev);
	return reward;
}

function sendSaveAck(s: Session, ack: SaveAckPayload): void {
	if (!s.closed) remotes.saveAck.FireClient(s.player, ack);
}

function rejectReport(s: Session, reason: SaveRejectReason, withWallet = false): void {
	// at most one answer per REJECT_ACK_INTERVAL: a rejection must not be a reflector (audit M2)
	const now = os.clock();
	if (now - s.lastRejectAck < REJECT_ACK_INTERVAL && now >= s.lastRejectAck) return;
	s.lastRejectAck = now;
	sendSaveAck(s, {
		ok: false,
		reason,
		earned: 0,
		earnedDays: 0,
		earnedBosses: 0,
		clamped: false,
		wallet: withWallet ? walletOf(s.save) : undefined,
	});
}

/**
 * An admin edit the client has not confirmed yet: its reports may predate it, so they are refused ("outdated": the
 * client resends later) and the patch is re-sent. The gate only opens by timeout after several unanswered re-sends.
 */
function patchGateHolds(s: Session): boolean {
	if (s.patchRev === undefined) return false;
	const now = os.clock();
	if (now >= s.patchDeadline && s.patchResends >= PATCH_MIN_RESENDS) {
		warn(`[${GAME_NAME}] ${s.key}: admin patch ${s.patchRev} was never confirmed; accepting reports again`);
		s.patchRev = undefined;
		s.patchResend = undefined;
		return false;
	}
	if (s.patchResend !== undefined && now - s.patchResentAt >= PATCH_RESEND_INTERVAL) {
		s.patchResentAt = now;
		s.patchResends += 1;
		s.patchResend();
	}
	return true;
}

function processReport(s: Session, json: string): void {
	s.lastReport = os.clock();
	const [ok, decoded] = pcall((): unknown => HttpService.JSONDecode(json));
	if (!ok) {
		rejectReport(s, "invalid");
		return;
	}
	const prev = s.save;
	if (typeIs(decoded, "table") && (decoded as Record<string, unknown>).runRev !== prev.runRev) {
		// captured before the last rebirth / new run / admin edit: it would bring the old state back
		rejectReport(s, "outdated", true);
		return;
	}
	if (patchGateHolds(s)) {
		rejectReport(s, "outdated", true);
		return;
	}
	const upd = sanitizeClientReport(decoded, prev);
	if (upd === undefined) {
		rejectReport(s, "invalid");
		return;
	}
	// §11.3 F2, "o XP só vem do servidor": from MP_PHASE 2 on the server counted the kills, the levels and
	// the days itself (server/sim/progress.ts), so a report carrying different numbers is not suspicious,
	// it is simply stale — pinned to the trusted copy in silence (§9.2 level 0). With those fields frozen
	// the credit windows below have nothing left to clamp and the coins follow the server's own events.
	if (stripClientProgress(prev, upd)) s.staleProgressReports += 1;
	// NET-5: ...and from WORLD_SERVER_PHASE the backpack too (server/sim/backpack.ts): a report can no longer add an
	// item, a round, a skill or a pack. The server wrote those itself -- a pickup, a craft, a reload, a delivery
	if (stripClientBackpack(prev, upd)) s.staleProgressReports += 1;
	// …and the death is the server's too: `runOver: false` in a report was a one-line revive (server/sim/life.ts)
	if (stripClientLife(prev, upd)) s.staleProgressReports += 1;
	// …and so are the achievements and what they could stand for (CON-04, MON-05): counted on its own events only
	if (stripClientAchievements(prev, upd, decoded)) s.staleProgressReports += 1;
	const assisted = s.assistedRunRev !== undefined && s.assistedRunRev === prev.runRev;
	const reward = applyProgressLimits(s, prev, upd, isAdminUserId(s.player.UserId), assisted);
	// IN PLACE, never `s.save = upd` (§6.3). From F2 on the simulation writes into this very table —
	// XP the moment a zombie dies, coins at midnight — and it holds the reference through
	// `ServerPlayer.save`. Swapping the table would orphan it and lose every server-side write made
	// between the swap and mpHost's next `adoptSave` pass.
	copySaveInto(s.save, upd);
	s.dirty = true;
	sendSaveAck(s, {
		ok: true,
		earned: reward.coins,
		earnedDays: reward.days,
		earnedBosses: reward.bosses,
		clamped: reward.clamped,
		wallet: walletOf(upd),
	});
	admin?.onReport(s.player);
}

function processPending(s: Session): void {
	const json = s.pending;
	const token = s.pendingToken;
	s.pending = undefined;
	s.pendingToken = undefined;
	if (json === undefined || !s.loaded || isReadOnly(s) || token !== s.token) return;
	processReport(s, json);
}

remotes.saveRequest.OnServerEvent.Connect((player, token, json) => {
	const bad = !typeIs(token, "string") || !typeIs(json, "string") || json.size() > MAX_SAVE_PAYLOAD;
	if (floodDrop(player, bad)) return;
	const s = sessions.get(player);
	if (s === undefined || s.closed) return;
	if (!s.loaded) {
		rejectReport(s, "loading");
		return;
	}
	if (!typeIs(token, "string") || !typeIs(json, "string") || json.size() > MAX_SAVE_PAYLOAD) {
		rejectReport(s, "invalid");
		return;
	}
	if (isReadOnly(s)) {
		rejectReport(s, "readonly");
		return;
	}
	if (token !== s.token) {
		rejectReport(s, "stale");
		return;
	}
	if (patchGateHolds(s)) {
		// refused on receipt too: a report queued now would otherwise be processed after the confirmation
		rejectReport(s, "outdated", true);
		return;
	}
	const since = os.clock() - s.lastReport;
	if (since < SAVE_MIN_INTERVAL) {
		// rate limit: keep only the latest report and process it when the window opens
		s.pending = json;
		s.pendingToken = token;
		if (!s.pendingScheduled) {
			s.pendingScheduled = true;
			task.delay(SAVE_MIN_INTERVAL - since, () => {
				s.pendingScheduled = false;
				if (!s.closed) processPending(s);
			});
		}
		return;
	}
	processReport(s, json);
});

// ---------------------------------------------------------------- shop / rebirth

function isIndex(v: unknown, size: number): v is number {
	return typeIs(v, "number") && v % 1 === 0 && v >= 0 && v < size;
}

function takeActionToken(s: Session): boolean {
	const now = os.clock();
	s.actionTokens = math.min(ACTION_BURST, s.actionTokens + (now - s.actionAt) * ACTION_PER_SECOND);
	s.actionAt = now;
	if (s.actionTokens < 1) return false;
	s.actionTokens -= 1;
	return true;
}

function fail(reason: ShopActionReason, s?: Session): ShopActionResult {
	return { ok: false, reason, wallet: s !== undefined && s.loaded ? walletOf(s.save) : undefined };
}

function handleAction(player: Player, raw: unknown): ShopActionResult {
	const s = sessions.get(player);
	if (s === undefined || s.closed || !s.loaded) return fail("loading");
	if (!takeActionToken(s)) return fail("rate", s);
	if (isReadOnly(s)) return fail("readonly");
	if (!typeIs(raw, "table")) return fail("invalid", s);
	const req = raw as Record<string, unknown>;
	const save = s.save;
	let price: number;
	if (req.kind === "buyPack") {
		if (!isIndex(req.packId, SHOP_PACKS.size())) return fail("invalid", s);
		const id = req.packId;
		const pending = (save.packsBought[id] ?? 0) - (save.packsOpened[id] ?? 0);
		if (pending >= ECONOMY.MAX_PENDING_PACKS) return fail("limit", s);
		price = SHOP_PACKS[id].price;
		if (save.money < price) return fail("funds", s);
		save.money -= price;
		save.packsBought[id] = (save.packsBought[id] ?? 0) + 1;
	} else if (req.kind === "buyCostume") {
		// the wardrobe (MON-04): id, price, ownership and coins are all decided in server/save/costumes.ts -- the
		// request carries nothing but the id, and a `price` field in it is never read
		const bought = buyCostume(save, req.costumeId);
		if (!bought.ok) return fail(bought.reason, s);
		price = bought.price;
	} else if (req.kind === "equipTitle") {
		// the wardrobe's Titles tab (MON-05): only a title the SERVER granted can be shown (server/save/titles.ts);
		// the replicator's profile pass then puts it under the name for everybody
		const shown = equipTitle(save, req.titleId);
		if (!shown.ok) return fail(shown.reason, s);
		price = 0;
	} else if (req.kind === "rebirth" || req.kind === "newRun") {
		/*
		 * The two ways out of a death, decided HERE and not by the client (server/sim/life.ts rule 5, the owner's
		 * rule of 23 Sep 2026 — the same on every server kind):
		 *   - rebirth: continue the run NOW, for rebirthPrice(deathCount) coins (the price grows with every
		 *     continue). It used to be refused on public servers (63f8458); now it is legal everywhere, and only
		 *     for a death the SERVER decided — a living body buying one was a heal and a teleport for coins;
		 *   - newRun: give up the run — day 1 with the starter kit (level, skills, coins and packs stay, MP-20).
		 *     A new LIFE, not a new body: it still waits for daybreak (or a Rebirth), and a living survivor may
		 *     not use it at all — it was a free heal and teleport.
		 * The request names the run it acts on: a stale or duplicated one is refused (idempotent by runRev).
		 * `dead` is asked BEFORE anything is reset: resetRun clears the very `runOver` it may be read from.
		 */
		const dead = mpHost !== undefined ? mpHost.isDead(player, save) : save.runOver;
		// the daybreak already came while they waited in the lobby: the next entry stands them up for nothing, so a
		// Rebirth asked now is not charged for it (nor counted as a continue)
		const due = req.kind === "rebirth" && mpHost !== undefined && mpHost.lives.daybreakDue(player.UserId, save);
		const refusal = runActionRefusal(req.kind, save, req.runRev, dead, due);
		if (refusal !== undefined) return fail(refusal, s);
		const host = mpHost;
		if (req.kind === "rebirth") {
			// what the sale changes, to take back if the body does not stand (F5). Nothing yields in here, so nobody
			// (a report, a wallet push) can have seen the new runRev before it goes back
			const before = {
				money: save.money,
				deathCount: save.deathCount,
				runOver: save.runOver,
				runRev: save.runRev,
				assisted: s.assistedRunRev,
			};
			price = due ? 0 : rebirthPrice(save.deathCount);
			save.money -= price;
			if (!due) save.deathCount += 1;
			save.runOver = false;
			// a rebirth continues the same run: an assisted run stays assisted
			if (s.assistedRunRev === save.runRev) s.assistedRunRev = save.runRev + 1;
			save.runRev += 1;
			// the SAVE says the run continues; this is what makes the simulated survivor agree (§7.1). Without
			// it the coins were gone and the body stayed dead, so the button looked like it did nothing.
			const stood =
				host === undefined ||
				guarded(`${s.key}: rebirth`, () => {
					host.rebirth(player, save);
					return true;
				}) === true ||
				// it threw: sold only if the body stood up all the same (a throw after that point keeps the Rebirth)
				guarded(`${s.key}: rebirth check`, () => host.isDead(player, save)) === false;
			if (!stood) {
				// nothing was sold: the charge, the continue and the run go back, so the client's next Rebirth pays once
				// (whatever the keeper moved before it threw, the corpse's rounds into the reserve, goes with the save)
				save.money = before.money;
				save.deathCount = before.deathCount;
				save.runOver = before.runOver;
				save.runRev = before.runRev;
				s.assistedRunRev = before.assisted;
				s.dirty = true;
				return fail("network", s);
			}
		} else {
			price = 0;
			resetRun(save);
			save.runRev += 1;
			s.assistedRunRev = undefined;
			const renewed =
				host === undefined ||
				guarded(`${s.key}: new life`, () => {
					host.newLife(player, save);
					return true;
				}) === true;
			if (!renewed) {
				// the new life stands, and so does the death (F5): resetRun cleared what newLife writes back. A save
				// saying "alive" under a body the keeper holds dead is the free revive rule 5 forbids (a crash would
				// hand it out on the next join)
				save.runOver = true;
				save.runHp = 0;
				save.runHunger = 0;
			}
		}
	} else {
		return fail("invalid", s);
	}
	Analytics.shopAction(player, req, price);
	s.dirty = true;
	return { ok: true, price, wallet: walletOf(save) };
}

remotes.shopAction.OnServerInvoke = (player, request) => {
	const kind = typeIs(request, "table") ? (request as Record<string, unknown>).kind : undefined;
	if (floodDrop(player, !typeIs(kind, "string") || !SHOP_KINDS.has(kind))) return fail("rate");
	return handleAction(player, request);
};

// ---------------------------------------------------------------- lifecycle

Players.PlayerAdded.Connect(onPlayerAdded);
for (const player of Players.GetPlayers()) {
	task.spawn(onPlayerAdded, player);
}

Players.PlayerRemoving.Connect(player => {
	const s = sessions.get(player);
	if (s === undefined) return;
	s.closed = true;
	const userId = player.UserId;
	releasing.add(userId);
	waitUntil(() => s.loaded, 60);
	// every step is guarded (F5): none may cost the session its last write, nor skip the cleanup below
	if (s.pending !== undefined) guarded(`${s.key}: last report`, () => processPending(s));
	// §7.2 "Desconectar": the body goes into the save — runHp, runHunger, runOver, the magazine back into the
	// reserve — BEFORE the final write. mpHost's own PlayerRemoving handler does the same, but the two handlers
	// run in no guaranteed order, and this write is the last one the session gets.
	if (s.loaded) guarded(`${s.key}: banking the body`, () => mpHost?.release(player, s.save));
	guarded(`${s.key}: final save`, () => flush(s, true));
	// still writing: flush stopped waiting (30 s) for an autosave that is still in flight. The final write goes after
	// it, and the mark below stays until then
	if (s.writing && waitUntil(() => !s.writing, 60)) guarded(`${s.key}: final save`, () => flush(s, true));
	// only now, the last write returned (made, or given up after its retries): the `releasing` mark is what keeps this
	// user's next session here from taking the lock under that write. Left behind, it held every later join 20-35 s
	sessions.delete(player);
	releasing.delete(userId);
});

game.BindToClose(() => {
	shuttingDown = true;
	// §7.2 "Servidor desligando": stop the simulation and bank every body into its save before the writes below
	// capture them (a second BindToClose would race this one, so the host is stopped here, first). Guarded (F5): a
	// simulation that cannot stop must not keep a single save from being written
	guarded("stopping the simulation", () => mpHost?.stop());
	const all: Array<Session> = [];
	for (const [, s] of sessions) all.push(s);
	let remaining = all.size();
	for (const s of all) {
		task.spawn(() => {
			waitUntil(() => s.loaded, 10);
			if (s.pending !== undefined) guarded(`${s.key}: last report`, () => processPending(s));
			// no report may land after the final state is captured
			s.closed = true;
			guarded(`${s.key}: final save`, () => flush(s, true, SHUTDOWN_RETRY_DELAYS));
			// counted whatever happened above: a save that threw held the shutdown for the whole budget
			remaining -= 1;
		});
	}
	waitUntil(() => remaining <= 0, SHUTDOWN_BUDGET);
});

task.spawn(() => {
	while (!shuttingDown) {
		task.wait(AUTOSAVE_INTERVAL);
		if (shuttingDown) break;
		const due: Array<Session> = [];
		for (const [, s] of sessions) {
			if (!s.closed && s.loaded && persists(s)) due.push(s);
		}
		for (const s of due) {
			if (shuttingDown || s.closed) continue;
			const budget = DataStoreService.GetRequestBudgetForRequestType(Enum.DataStoreRequestType.UpdateAsync);
			if (budget < AUTOSAVE_MIN_BUDGET) break; // keep the budget for joins/leaves; retry next round
			// the body's hp and hunger as they are now (§6.1), so a crash does not hand out a heal on the next join.
			// Guarded (F5): a throw here ended this loop, and every autosave on the server with it
			if (guarded(`${s.key}: settling the body`, () => mpHost?.settle(s.player, s.save)) === true) s.dirty = true;
			task.spawn(() => flush(s, false));
			task.wait(0.2);
		}
	}
});

/*
 * The simulation writes XP, levels and midnight's coins straight into the live save (server/sim/progress.ts),
 * and before this nothing carried them back: the client only heard its wallet in the ack of its next report,
 * and that wallet had no XP in it at all -- the HUD's XP bar sat at 0 for a whole run (owner's playtest,
 * 2026-09-23). The wallet is pushed as soon as it changes, at most WALLET_PUSH_S apart. This stands in for the
 * reliable `Self` channel of docs/MULTIPLAYER.md §4.1 until that lands.
 */
const WALLET_PUSH_S = 0.25;
const pushedWallet = new Map<Player, string>();
/** the bag each player was last sent (server/sim/backpack.ts owns the backpack from WORLD_SERVER_PHASE) */
const pushedBag = new Map<Player, string>();

interface BagNow {
	sig: string;
	seq: number;
	place: number;
	ack: number;
}

/**
 * F3 (§4.8): the backpack as the server holds it, with the construction on its cursor, the nonce of the last verb it
 * answered and the last command it consumed -- or undefined below WORLD_SERVER_PHASE, where the client still owns it.
 * `sig` is what the push compares: it leaves `seq` out, which moves every tick.
 */
function bagFor(player: Player, save: PlayerSaveData): BagNow | undefined {
	if (!serverOwnsBackpack() || mpHost === undefined) return undefined;
	const sp = mpHost.playerOf(player);
	const sim = mpHost.simulation;
	const place = sp !== undefined ? (sim.build?.pendingOf(sp.slot) ?? -1) : -1;
	const ack = sim.backpack.ackOf(player.UserId);
	// every build edge the cursor answered moves the signature, so a REFUSED placement is answered by a bag too
	const turns = sp !== undefined ? (sim.build?.turnsOf(sp.slot) ?? 0) : 0;
	const sig = `${bagSignature(save, place, ack)}|${turns}`;
	return { sig, seq: sp !== undefined ? sp.ackSeq : -1, place, ack };
}

/**
 * Everything in the wallet the simulation can move on its own: a change in any of them is pushed. The achievement
 * counters (CON-04) ride here too: this push is how they -- and the "Achievement unlocked" toast -- reach the client.
 */
function walletSignature(save: PlayerSaveData): string {
	let titles = "";
	for (const v of save.titles) titles += v > 0 ? "1" : "0";
	const achievements = save.achievements.join(",");
	return `${save.money}|${save.level}|${save.exp}|${save.bestDay}|${save.bossKills}|${save.day}|${save.lifeNights}|${save.zombieKills}|${titles}|${achievements}`;
}

function pushWallets(): void {
	for (const [player] of pushedWallet) {
		if (!sessions.has(player)) {
			pushedWallet.delete(player);
			pushedBag.delete(player);
		}
	}
	for (const [player, s] of sessions) {
		if (s.closed || !s.loaded) continue;
		const sig = walletSignature(s.save);
		const last = pushedWallet.get(player);
		pushedWallet.set(player, sig);
		const bag = bagFor(player, s.save);
		const lastBag = pushedBag.get(player);
		if (bag !== undefined) pushedBag.set(player, bag.sig);
		// the first look only takes note: the LoadAck already carried the whole save
		const walletMoved = last !== undefined && last !== sig;
		const bagMoved = bag !== undefined && lastBag !== undefined && lastBag !== bag.sig;
		if (!walletMoved && !bagMoved) continue;
		const wallet = walletOf(s.save);
		// the bag only rides when IT moved: an XP tick in a firefight must not resend 150 numbers (§4.8)
		if (bag !== undefined && bagMoved) wallet.bag = bagOf(s.save, bag.place, bag.ack, bag.seq);
		sendSaveAck(s, {
			ok: true,
			push: true,
			earned: 0,
			earnedDays: 0,
			earnedBosses: 0,
			clamped: false,
			wallet,
		});
	}
}

let walletPushAcc = 0;
RunService.Heartbeat.Connect(dt => {
	walletPushAcc += dt;
	if (walletPushAcc < WALLET_PUSH_S || shuttingDown) return;
	walletPushAcc = 0;
	pushWallets();
});

// ---------------------------------------------------------------- admin panel host

/**
 * Admin save edit (authorization is done by adminServer before this is called). `ops` undefined = reset to a new
 * player's save (settings kept). The edit bumps runRev, so every report captured before it is refused as
 * "outdated", drops a queued report, and arms the patch gate until the client confirms it applied the patch.
 */
function adminEdit(player: Player, ops: Array<AdminOp> | undefined): AdminEditOutcome {
	const s = sessions.get(player);
	const none = { ok: false, runRev: 0, rev: 0, persist: false };
	if (s === undefined || s.closed) return { ...none, error: "that player is not in this server" };
	if (!s.loaded) return { ...none, error: "that player's save is still loading" };
	if (isReadOnly(s)) {
		return { ...none, error: "read-only session (the save could not be loaded or the session lock was lost)" };
	}
	const before = s.save;
	let edited: PlayerSaveData;
	if (ops === undefined) {
		edited = freshSave(true);
		edited.settings = before.settings;
	} else {
		edited = sanitizeStoredSave(before);
		applyAdminOps(edited, ops);
	}
	enforceSaveInvariants(edited);
	// MON-05: a reset (or an edit that takes away something earned) starts a new title history, and the title record
	// is replaced by it at the next write that lands -- it can never hand the old one back (server/save/titleRecord.ts)
	if (ops === undefined || TitleRecord.lowersEarned(before, edited)) {
		edited.titleEpoch = math.min(math.max(before.titleEpoch + 1, os.time()), SAVE_LIMITS.EPOCH_MAX);
		s.titleReplace = true;
	}
	edited.runRev = math.min(before.runRev + 1, SAVE_LIMITS.COUNTER_MAX);
	// an edit keeps the run (still assisted if it was); a reset starts a new one. An edit that moves the life's DAY
	// is an admin living days for the player (§9.3, MP-13): from here the run is assisted, like a world tool's
	const dayMoved = ops !== undefined && edited.day !== before.day;
	const assisted = ops !== undefined && (s.assistedRunRev === before.runRev || dayMoved);
	s.assistedRunRev = assisted ? edited.runRev : undefined;
	Analytics.adminEdit(s.save, edited);
	// same reason as processReport: one table per session, for its whole life
	copySaveInto(s.save, edited);
	s.dirty = true;
	s.pending = undefined;
	s.pendingToken = undefined;
	adminPatchSerial += 1;
	s.patchRev = adminPatchSerial;
	s.patchDeadline = os.clock() + PATCH_ACK_TIMEOUT;
	s.patchResend = undefined;
	s.patchResentAt = os.clock();
	s.patchResends = 0;
	// the LIVE table, not the scratch copy: whoever reads it next must see what the session now holds
	return { ok: true, runRev: s.save.runRev, rev: adminPatchSerial, persist: persists(s), save: s.save };
}

/** §9.3: the body in the town, as the simulation has it, for the admin's players table (read-only) */
function liveViewOf(player: Player): AdminLiveView | undefined {
	const sp = mpHost?.playerOf(player);
	if (mpHost === undefined || sp === undefined) return undefined;
	return {
		dead: sp.state.dead,
		hp: sp.state.hp,
		hpMax: sp.state.hpMax,
		idleS: mpHost.simulation.idleSeconds(sp),
	};
}

admin = startAdminServer({
	jobId: JOB_ID,
	noteRemote: (player, malformed) => floodDrop(player, malformed),
	session(player) {
		const s = sessions.get(player);
		if (s === undefined) return undefined;
		return {
			loaded: s.loaded,
			status: s.status,
			persist: s.loaded && persists(s),
			readOnly: isReadOnly(s),
			dirty: s.dirty,
			save: s.save,
			lastReport: s.lastReport,
			joinedAt: s.joinedAt,
			patchPending: s.patchRev !== undefined,
			live: liveViewOf(player),
		};
	},
	edit(player, ops) {
		return adminEdit(player, ops);
	},
	ackPatch(player, rev) {
		const s = sessions.get(player);
		if (s === undefined || s.patchRev !== rev) return;
		s.patchRev = undefined;
		s.patchResend = undefined;
		// a report queued while the gate was closed may predate the patch
		s.pending = undefined;
		s.pendingToken = undefined;
	},
	setPatchResend(player, rev, resend) {
		const s = sessions.get(player);
		if (s !== undefined && s.patchRev === rev) s.patchResend = resend;
	},
	markAssisted(player) {
		const s = sessions.get(player);
		if (s === undefined || !s.loaded || s.assistedRunRev === s.save.runRev) return false;
		s.assistedRunRev = s.save.runRev;
		return true;
	},
	dataStoreStatus() {
		if (dataStore === undefined) return "unavailable (GetDataStore failed)";
		let loaded = 0;
		let persisted = 0;
		for (const [, s] of sessions) {
			if (!s.loaded) continue;
			loaded++;
			if (persists(s)) persisted++;
		}
		if (loaded > 0 && persisted === 0) return `reachable, but no session is persisted (${loaded} in memory only)`;
		return `ok (${persisted}/${loaded} sessions persisted)`;
	},
});

// ---------------------------------------------------------------- authoritative simulation (§11.3 F1)

/*
 * MP_PHASE = 0 (today's build): nothing below runs, no MP remote exists and every client keeps simulating its
 * own world — the save, economy, shop and admin code above is untouched either way.
 * MP_PHASE >= 1: the host creates the remotes, admits each player at a safe spawn point once THIS file has
 * loaded their save, runs the 60 Hz tick and replicates (snapshots at 20/10 Hz, reliable World deltas per tick).
 * The host never reads or writes the DataStore: it only borrows the live save table of a loaded session, which
 * is what `stepPlayer` reads the skill levels from.
 */
if (MP_PHASE >= 1) {
	// the worlds that ended and how many days each lasted (MP-22): a small bounded DataStore document
	const worldLog = startWorldLog();
	mpHost = startMpHost({
		saveOf: player => {
			const s = sessions.get(player);
			// a read-only session (status "error", lock lost) still plays; it just never persists, exactly as
			// in single player. A session that is still loading, or already closing, is not admitted yet — nor one
			// whose retry is queued: the save it is about to load is the one its next body must come from (R3b)
			if (s === undefined || s.closed || !s.loaded || s.retryQueued) return undefined;
			return s.save;
		},
		// a death, a stand-up or a body banked on the way out wrote `runOver` / `runHp` / `runHunger` (§6.1) — and a
		// world that ended gave its fallen a new life (MP-22): `resetRun` and a new `runRev` in the live save
		saveChanged: userId => markDirty(userId),
		// MP-22: everybody in the world died and nobody paid inside the window (server/sim/life.ts rule 6), so the
		// host has already built a new town on day 1 (server/sim/worldReset.ts). What is left for the session layer
		// is the record of the world that ended — persisted off this thread, the reset never waits for it
		onWorldWiped: (report, outcome) => worldLog.record(outcome.ended),
		// §8.2 "registrado" (audit L4): every automatic kick into the admin audit log, by UserId
		onFloodKick: (player, reason) => admin?.floodKick(player, reason),
	});
	const sim = mpHost.simulation;
	// §9.3: a run an admin helped along keeps playing and stops paying. The simulation has no notion of an
	// admin; this file owns `assistedRunRev`, so the rule is wired in from here.
	sim.paysRewards = sp => {
		const s = sessionOfUserId(sp.userId);
		return s === undefined || s.assistedRunRev === undefined || s.assistedRunRev !== s.save.runRev;
	};
	// §3.6: midnight already paid the day and its coins straight into the live save. All that is left is to
	// make sure the DataStore learns about it. (The new balance reaches the client on the next report ack;
	// when the `Self` channel of §4.1 lands it should be pushed here instead.)
	sim.onDayCredit = (sp, credit) => {
		const s = sessionOfUserId(sp.userId);
		if (s === undefined || s.closed) return;
		s.dirty = true;
		if (credit.coins > 0) admin?.onReport(s.player);
	};
	// the server changed the backpack, so the DataStore has to hear about it (§6.3: the save is no longer
	// something the client reports, it is something the server writes)
	sim.onBackpack = (sp, outcome) => {
		markDirty(sp.userId);
		Analytics.backpack(sp.save, outcome);
	};
	sim.onInteract = sp => markDirty(sp.userId);
	// VEI-05: a ride writes the save -- the motorcycle's oil, the Rider odometer -- and says so at least once a second
	sim.onRide = sp => markDirty(sp.userId);
	// the backpack verbs (§4.8, §8.4): rate-limited and flood-counted here, validated and applied by the simulation
	// (server/sim/backpack.ts); out of the world only a cosmetic slot, on the session's save (the lobby's wardrobe)
	startBackpackIntents({
		intent: mpHost.remotes.intent,
		backpack: sim.backpack,
		playerOf: player => mpHost?.playerOf(player),
		queue: (slot, msg) => sim.queueIntent(slot, msg),
		saveOf: player => {
			const s = sessions.get(player);
			return s !== undefined && s.loaded && !s.closed ? s.save : undefined;
		},
		changed: player => {
			const s = sessions.get(player);
			if (s !== undefined && !s.closed) s.dirty = true;
		},
	});
	// the host is stopped by the BindToClose above, BEFORE the final writes: it banks every body into its save
}

// ---------------------------------------------------------------- proximity chat (§4.3, §9.1)

/*
 * Chat is range-limited on the server for the same reason a zombie in the dark is not replicated (§4.3): what
 * the client is never told, a modified client cannot read. The body below is the MP host's authoritative
 * entity, which only exists between EnterWorld and LeaveWorld — whoever is in the lobby has no position, and
 * shared/chat/chatRules.ts answers "no" for them. With MP_PHASE = 0 there is no host, nobody has a position
 * at all, and the same rule falls back to delivering every line to everyone.
 */
startProximityChat({
	bodyOf: player => mpHost?.playerOf(player)?.state,
});

print(`[${GAME_NAME}] server ready (job ${JOB_ID}${MP_PHASE >= 1 ? `, MP phase ${MP_PHASE}` : ""})`);
