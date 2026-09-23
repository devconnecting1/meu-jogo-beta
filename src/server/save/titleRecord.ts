/*
 * The title record: what a survivor EARNED (MON-05), kept a second time where a rolled-back server cannot drop it.
 * SERVER ONLY.
 *
 * Why a second document. v5 put `titles` and `zombieKills` in the save, and every earlier version of the server
 * rebuilds the save from the fields IT knows (`sanitizeStoredSave`) and writes that back. So a rollback to v4 code
 * -- a bad deploy undone -- would silently erase every title and every kill counted, for everybody who played on
 * it, and the roll-forward would find nothing to bring back. A migration that loses what a player earned is the
 * failure test:save exists to prevent; the same rule held for v3 and v4 because their new fields were only ever
 * a CHOICE (which outfit is worn), never something earned.
 *
 * So each session also keeps `{ titles, zombieKills, epoch }` under the player's UserId in the "ProjectZ_Titles"
 * store (suffixed in Studio, server/save/stores.ts), a document v4 code never opens:
 *   - on load, the session reads it and takes the LARGER of the two for each flag and for the kill count
 *     (`mergeTitleRecord`) -- after a rollback, the save has nothing and the record has everything;
 *   - after every successful save write that changed what was earned, the session writes it again. It REPLACES the
 *     record when the load read it (the session then knows everything the record held), and MERGES into it when
 *     that read failed (a replace could then lower a record it has never seen). It is written by the session that
 *     believes it holds the save's lock: right after a save write, and on leaving right BEFORE the save write that
 *     releases the lock. "Believes": a server can lose the lock without knowing it (another server took it once
 *     this one stopped refreshing it) and only learns so from that save write. So no write lands over a record of
 *     a LATER history (`nextTitleRecord`): whatever that server did, it cannot undo a reset made where the lock went.
 *
 * What the record must NEVER do is undo a reset or a deletion made on purpose. The `epoch` says which title history
 * a save and a record belong to (PlayerSaveData.titleEpoch): a new save starts a new one, and an admin reset starts
 * a new one. A record of an OLDER epoch than the save is never merged into it, and a merge into such a record
 * replaces it. A save that went through v4 code lost its epoch with its titles and reads 0, so the rollback case
 * above still restores. A missing save (status "new": a first visit, or a key deleted on purpose -- a wipe, an
 * erasure request) never takes anything from the record: the session replaces it at its first write.
 * Erasing a player therefore means deleting their key from THIS store as well as from the save stores
 * (docs/MULTIPLAYER.md §6.6); a record left behind alone brings nothing back, but it is still their data.
 *
 * What a rollback still loses is the CHOICE, `equipTitle` -- which title was shown -- because that is a choice and
 * not something earned. One click in the wardrobe.
 *
 * Best effort by design: a failed read only means this session cannot restore a rollback (it merges on its next
 * write instead of replacing), and a failed write is retried on the next flush. The save stays the source of truth.
 *
 * And cheap: every write is an UpdateAsync out of the same per-server budget the saves use, so the record is not
 * rewritten at every autosave that carries a kill (`titleRecordDue`). An autosave writes it when a title was earned,
 * when the history changed (a reset) or when the kill count crosses a multiple of TITLE_RECORD_KILL_STEP (Horde
 * Breaker's 100 is one of them); leaving writes it exactly. A survivor who has earned nothing never gets one.
 */
import { GAME_NAME } from "shared/module";
import { TITLES } from "shared/data/titles";
import { PlayerSaveData, SAVE_LIMITS } from "shared/game/save";
import { TITLE_STORE } from "./stores";

/** what the record keeps: the grow-only half of the v5 save, and which title history it belongs to */
export interface TitleRecord {
	titles: Array<number>;
	zombieKills: number;
	/** PlayerSaveData.titleEpoch of the save it mirrors (0 = a history that began before v5 or went through v4) */
	epoch: number;
}

// ---------------------------------------------------------------- pure

function flagOf(v: unknown): number {
	return typeIs(v, "number") && v > 0 ? 1 : 0;
}

/** a non-negative integer no larger than `max`; 0 for anything else (NaN included) */
function countOf(v: unknown, max: number): number {
	return typeIs(v, "number") && v === v && v > 0 ? math.min(math.floor(v), max) : 0;
}

/** a stored record read defensively; undefined when there is nothing usable (never written, or not a table) */
export function readTitleRecord(raw: unknown): TitleRecord | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const r = raw as Record<string, unknown>;
	const list = typeIs(r.titles, "table") ? (r.titles as Array<unknown>) : [];
	const titles = new Array<number>();
	for (let i = 0; i < TITLES.size(); i++) titles.push(flagOf(list[i]));
	return {
		titles,
		zombieKills: countOf(r.zombieKills, SAVE_LIMITS.COUNTER_MAX),
		epoch: countOf(r.epoch, SAVE_LIMITS.EPOCH_MAX),
	};
}

/** the record a save holds right now (fresh arrays: it is handed to a DataStore) */
export function titleRecordOf(save: PlayerSaveData): TitleRecord {
	const titles = new Array<number>();
	for (let i = 0; i < TITLES.size(); i++) titles.push(flagOf(save.titles[i]));
	return { titles, zombieKills: math.max(0, save.zombieKills), epoch: save.titleEpoch };
}

/** an autosave rewrites the record when the kill count reaches the next multiple of this (`titleRecordStep`) */
export const TITLE_RECORD_KILL_STEP = 10;

/** nothing earned, in the history `epoch`: what "no record stored" means to a session that read the store */
export function emptyTitleRecord(epoch: number): TitleRecord {
	const titles = new Array<number>();
	for (let i = 0; i < TITLES.size(); i++) titles.push(0);
	return { titles, zombieKills: 0, epoch };
}

function flagsMark(rec: TitleRecord): string {
	let mark = "";
	for (const v of rec.titles) mark += v > 0 ? "1" : "0";
	return mark;
}

/** a fingerprint of the earned half of a save or a record, so a flush only rewrites the record when it changed */
export function titleRecordMark(rec: TitleRecord): string {
	return `${rec.epoch}:${rec.zombieKills}:${flagsMark(rec)}`;
}

/** the same fingerprint with the kill count in steps of TITLE_RECORD_KILL_STEP: what an autosave compares */
export function titleRecordStep(rec: TitleRecord): string {
	return `${rec.epoch}:${math.floor(rec.zombieKills / TITLE_RECORD_KILL_STEP)}:${flagsMark(rec)}`;
}

/**
 * Should this flush write the record? `knownMark` / `knownStep` fingerprint what the store holds as far as this
 * session knows (undefined = its load could not read it); `replace` = the session must replace it (a new history);
 * `final` = the session is leaving, and the record must end exactly where the save does.
 */
export function titleRecordDue(
	save: PlayerSaveData,
	knownMark: string | undefined,
	knownStep: string | undefined,
	replace: boolean,
	final: boolean,
): boolean {
	const mine = titleRecordOf(save);
	// a record this session never read, and nothing earned to add to it: nothing to write
	if (knownMark === undefined && !replace && mine.zombieKills <= 0 && !mine.titles.includes(1)) return false;
	return final ? titleRecordMark(mine) !== knownMark : titleRecordStep(mine) !== knownStep;
}

/** true when `after` holds less than `before` of what was earned (a flag gone, fewer kills): a new title history */
export function lowersEarned(before: PlayerSaveData, after: PlayerSaveData): boolean {
	if (after.zombieKills < before.zombieKills) return true;
	for (let i = 0; i < TITLES.size(); i++) {
		if ((before.titles[i] ?? 0) > 0 && (after.titles[i] ?? 0) <= 0) return true;
	}
	return false;
}

/**
 * The larger of the two, flag by flag and for the kill count, INTO the save, when the record belongs to the save's
 * title history or a later one (the save then joins it); nothing from an OLDER history, which was reset or deleted
 * on purpose. True when the save changed (it must then be written again). Never takes anything away.
 */
export function mergeTitleRecord(save: PlayerSaveData, rec: TitleRecord): boolean {
	if (rec.epoch < save.titleEpoch) return false;
	let changed = false;
	if (rec.epoch > save.titleEpoch) {
		save.titleEpoch = rec.epoch;
		changed = true;
	}
	for (let i = 0; i < TITLES.size(); i++) {
		if ((rec.titles[i] ?? 0) > 0 && (save.titles[i] ?? 0) <= 0) {
			save.titles[i] = 1;
			changed = true;
		}
	}
	if (rec.zombieKills > save.zombieKills) {
		save.zombieKills = rec.zombieKills;
		changed = true;
	}
	return changed;
}

/**
 * How a session writes the record:
 *   "merge"    its load could not read it: the larger of the stored one and its own, in the later history;
 *   "replace"  its load read it: its own -- but a record of a LATER history is left exactly as it is (a reset or a
 *              new save made by a session this one knows nothing of: this one lost the lock without knowing it);
 *   "restart"  its save starts a new history (a missing save, an admin reset): its own, in an epoch after whatever
 *              is stored, even one a clock ahead of this server's stamped -- the save then adopts that epoch.
 */
export type TitleRecordWrite = "merge" | "replace" | "restart";

/** the record to store over `old`, the way `mode` says (see TitleRecordWrite) */
export function nextTitleRecord(old: unknown, mine: TitleRecord, mode: TitleRecordWrite): TitleRecord {
	const prev = readTitleRecord(old);
	if (prev === undefined) return mine;
	if (mode === "restart") {
		if (prev.epoch < mine.epoch) return mine;
		const titles = new Array<number>();
		for (const v of mine.titles) titles.push(v);
		return { titles, zombieKills: mine.zombieKills, epoch: math.min(prev.epoch + 1, SAVE_LIMITS.EPOCH_MAX) };
	}
	if (prev.epoch < mine.epoch) return mine;
	if (mode === "replace") return prev.epoch > mine.epoch ? prev : mine;
	const titles = new Array<number>();
	for (let i = 0; i < TITLES.size(); i++) titles.push((mine.titles[i] ?? 0) > 0 || prev.titles[i] > 0 ? 1 : 0);
	return { titles, zombieKills: math.max(mine.zombieKills, prev.zombieKills), epoch: prev.epoch };
}

// ---------------------------------------------------------------- the store

/** after GetDataStore fails, how long before the store is asked for again (it is not asked at every flush) */
const STORE_RETRY_S = 60;
/** a read or a write of the record that took longer than this (seconds) marks the store slow */
const SLOW_S = 2;
let store: DataStore | undefined;
let storeFailedAt: number | undefined;
/** the last time a read or write of the record failed or was slow (os.clock), for `titleStoreHealthy` */
let troubleAt: number | undefined;

/** notes how a call that began at `started` went: a failure or a slow answer is trouble for STORE_RETRY_S */
function noteCall(started: number, ok: boolean): void {
	if (!ok || os.clock() - started > SLOW_S) troubleAt = os.clock();
}

/**
 * Is the store answering well enough to be asked on the way OUT, in front of the save write that releases the
 * session lock (server/main.server.ts `flush`)? False for STORE_RETRY_S after a read or a write of the record
 * failed or took longer than SLOW_S, and while the store cannot be opened: every second spent there is a second
 * the player's next server waits for the lock (and may give up waiting, leaving this save "lost").
 */
export function titleStoreHealthy(): boolean {
	const now = os.clock();
	if (troubleAt !== undefined && now - troubleAt < STORE_RETRY_S) return false;
	return storeFailedAt === undefined || now - storeFailedAt >= STORE_RETRY_S;
}

/**
 * Opened on first use, so the pure half of this module loads anywhere (tools/test-save.mjs has no
 * DataStoreService). A failure to open is not remembered for the server's whole life -- a store that was not ready
 * a minute after boot would otherwise leave every session of this server without a record -- it is asked again
 * after STORE_RETRY_S.
 */
function titleStore(): DataStore | undefined {
	if (store !== undefined) return store;
	if (storeFailedAt !== undefined && os.clock() - storeFailedAt < STORE_RETRY_S) return undefined;
	const [ok, value] = pcall((): unknown => game.GetService("DataStoreService").GetDataStore(TITLE_STORE));
	if (ok) {
		store = value as DataStore;
		storeFailedAt = undefined;
	} else {
		storeFailedAt = os.clock();
		warn(`[${GAME_NAME}] title record store unavailable (asked again in ${STORE_RETRY_S} s): ${tostring(value)}`);
	}
	return store;
}

/** what a load found: the record (undefined = none stored yet), or `ok: false` when it could not be read */
export type TitleRecordRead = { ok: true; record: TitleRecord | undefined } | { ok: false };

/**
 * Reads the record of `key`: ONE attempt, no wait. It sits in front of the LoadAck, and a failure costs little -- the
 * session then only MERGES into the record instead of replacing it (see the header) -- so a retry loop there would
 * make every DataStore hiccup a stall at the door for nothing.
 */
export function loadTitleRecord(key: string): TitleRecordRead {
	const s = titleStore();
	if (s === undefined) return { ok: false };
	const started = os.clock();
	const [ok, value] = pcall((): unknown => s.GetAsync<unknown>(key)[0]);
	noteCall(started, ok);
	if (ok) return { ok: true, record: readTitleRecord(value) };
	warn(`[${GAME_NAME}] ${key}: title record not read (${tostring(value)}); this session merges it instead`);
	return { ok: false };
}

/**
 * Writes `save`'s earned half as the record of `key` (`mode`: see TitleRecordWrite), and answers the record that
 * landed -- after a merge it may hold MORE than the save, and a later history may have been kept or a new epoch
 * stamped, all of which the caller then takes into the save. ONE attempt, no wait: it runs inside the session's save,
 * and the next save simply tries again. undefined = not written (logged).
 */
export function storeTitleRecord(key: string, save: PlayerSaveData, mode: TitleRecordWrite): TitleRecord | undefined {
	const s = titleStore();
	if (s === undefined) return undefined;
	const mine = titleRecordOf(save);
	// set inside the transform (the closure hides the assignment from the narrowing, hence the cast)
	let written = undefined as TitleRecord | undefined;
	const started = os.clock();
	const [ok, err] = pcall(() => {
		s.UpdateAsync<unknown, unknown>(key, old => {
			written = nextTitleRecord(old, mine, mode);
			return $tuple(written);
		});
	});
	noteCall(started, ok);
	if (ok && written !== undefined) return written;
	warn(`[${GAME_NAME}] ${key}: title record not saved (${tostring(err)}); retried on the next save`);
	return undefined;
}
