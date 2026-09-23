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
 *     that read failed (a replace could then lower a record it has never seen). Only the holder of the session lock
 *     writes it: right after a save write, and on leaving right BEFORE the save write that releases the lock.
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

/** a fingerprint of the earned half of a save or a record, so a flush only rewrites the record when it changed */
export function titleRecordMark(rec: TitleRecord): string {
	let mark = `${rec.epoch}:${rec.zombieKills}:`;
	for (const v of rec.titles) mark += v > 0 ? "1" : "0";
	return mark;
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
 * The record to store: `mine` when replacing, or over a record of an older title history; otherwise (`old` never
 * read by this session) the larger of `old` and `mine`, in the later of the two histories.
 */
export function nextTitleRecord(old: unknown, mine: TitleRecord, replace: boolean): TitleRecord {
	const prev = replace ? undefined : readTitleRecord(old);
	if (prev === undefined || prev.epoch < mine.epoch) return mine;
	const titles = new Array<number>();
	for (let i = 0; i < TITLES.size(); i++) titles.push((mine.titles[i] ?? 0) > 0 || prev.titles[i] > 0 ? 1 : 0);
	return { titles, zombieKills: math.max(mine.zombieKills, prev.zombieKills), epoch: prev.epoch };
}

// ---------------------------------------------------------------- the store

let store: DataStore | undefined;
let storeTried = false;

/** opened on first use, so the pure half of this module loads anywhere (tools/test-save.mjs has no DataStoreService) */
function titleStore(): DataStore | undefined {
	if (!storeTried) {
		storeTried = true;
		const [ok, value] = pcall((): unknown => game.GetService("DataStoreService").GetDataStore(TITLE_STORE));
		if (ok) store = value as DataStore;
		else warn(`[${GAME_NAME}] title record store unavailable: ${tostring(value)}`);
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
	const [ok, value] = pcall((): unknown => s.GetAsync<unknown>(key)[0]);
	if (ok) return { ok: true, record: readTitleRecord(value) };
	warn(`[${GAME_NAME}] ${key}: title record not read (${tostring(value)}); this session merges it instead`);
	return { ok: false };
}

/**
 * Writes `save`'s earned half as the record of `key` (see the header for `replace`), and answers the record that
 * landed -- after a merge it may hold MORE than the save, which the caller then takes back. ONE attempt, no wait:
 * it runs inside the session's save (on leave and at shutdown too), and the next save simply tries again.
 * undefined = not written (logged).
 */
export function storeTitleRecord(key: string, save: PlayerSaveData, replace: boolean): TitleRecord | undefined {
	const s = titleStore();
	if (s === undefined) return undefined;
	const mine = titleRecordOf(save);
	// set inside the transform (the closure hides the assignment from the narrowing, hence the cast)
	let written = undefined as TitleRecord | undefined;
	const [ok, err] = pcall(() => {
		s.UpdateAsync<unknown, unknown>(key, old => {
			written = nextTitleRecord(old, mine, replace);
			return $tuple(written);
		});
	});
	if (ok && written !== undefined) return written;
	warn(`[${GAME_NAME}] ${key}: title record not saved (${tostring(err)}); retried on the next save`);
	return undefined;
}
