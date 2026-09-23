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
 * So each session also keeps `{ titles, zombieKills }` under the player's UserId in the "ProjectZ_Titles" store
 * (suffixed in Studio, server/save/stores.ts), a document v4 code never opens:
 *   - on load, the session reads it and takes the LARGER of the two for each flag and for the kill count
 *     (`mergeTitleRecord`) -- after a rollback, the save has nothing and the record has everything;
 *   - after every successful save write that changed what was earned, the session writes it again. It REPLACES the
 *     record when the load read it (the session then knows everything the record held, so a lower value is a
 *     deliberate admin edit), and MERGES into it when that read failed (a replace could then lower a record it has
 *     never seen). Only the holder of the session lock writes it, right after the save itself.
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

/** what the record keeps: the grow-only half of the v5 save */
export interface TitleRecord {
	titles: Array<number>;
	zombieKills: number;
}

// ---------------------------------------------------------------- pure

function flagOf(v: unknown): number {
	return typeIs(v, "number") && v > 0 ? 1 : 0;
}

/** a stored record read defensively; undefined when there is nothing usable (never written, or not a table) */
export function readTitleRecord(raw: unknown): TitleRecord | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const r = raw as Record<string, unknown>;
	const list = typeIs(r.titles, "table") ? (r.titles as Array<unknown>) : [];
	const titles = new Array<number>();
	for (let i = 0; i < TITLES.size(); i++) titles.push(flagOf(list[i]));
	const kills = r.zombieKills;
	const zombieKills =
		typeIs(kills, "number") && kills === kills && kills > 0
			? math.min(math.floor(kills), SAVE_LIMITS.COUNTER_MAX)
			: 0;
	return { titles, zombieKills };
}

/** the record a save holds right now (fresh arrays: it is handed to a DataStore) */
export function titleRecordOf(save: PlayerSaveData): TitleRecord {
	const titles = new Array<number>();
	for (let i = 0; i < TITLES.size(); i++) titles.push(flagOf(save.titles[i]));
	return { titles, zombieKills: math.max(0, save.zombieKills) };
}

/** a fingerprint of the earned half of a save or a record, so a flush only rewrites the record when it changed */
export function titleRecordMark(rec: TitleRecord): string {
	let mark = tostring(rec.zombieKills);
	for (const v of rec.titles) mark += v > 0 ? "1" : "0";
	return mark;
}

/**
 * The larger of the two, flag by flag and for the kill count, INTO the save. True when the record brought something
 * back (the save must then be written again). Never takes anything away.
 */
export function mergeTitleRecord(save: PlayerSaveData, rec: TitleRecord): boolean {
	let changed = false;
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

/** the record to store: `mine`, or, when `old` was never read by this session, the larger of `old` and `mine` */
export function nextTitleRecord(old: unknown, mine: TitleRecord, replace: boolean): TitleRecord {
	const prev = replace ? undefined : readTitleRecord(old);
	if (prev === undefined) return mine;
	const titles = new Array<number>();
	for (let i = 0; i < TITLES.size(); i++) titles.push((mine.titles[i] ?? 0) > 0 || prev.titles[i] > 0 ? 1 : 0);
	return { titles, zombieKills: math.max(mine.zombieKills, prev.zombieKills) };
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

/** reads the record of `key`, retrying after each of `delays` (seconds) */
export function loadTitleRecord(key: string, delays: ReadonlyArray<number>): TitleRecordRead {
	const s = titleStore();
	if (s === undefined) return { ok: false };
	for (let attempt = 0; ; attempt++) {
		const [ok, value] = pcall((): unknown => s.GetAsync<unknown>(key)[0]);
		if (ok) return { ok: true, record: readTitleRecord(value) };
		if (attempt >= delays.size()) {
			warn(`[${GAME_NAME}] ${key}: title record not read (${tostring(value)}); this session merges it instead`);
			return { ok: false };
		}
		task.wait(delays[attempt]);
	}
}

/**
 * Writes `save`'s earned half as the record of `key` (see the header for `replace`), and answers the record that
 * landed -- after a merge it may hold MORE than the save, which the caller then takes back. undefined = not written:
 * only logged, and the caller tries again on its next flush.
 */
export function storeTitleRecord(
	key: string,
	save: PlayerSaveData,
	replace: boolean,
	delays: ReadonlyArray<number>,
): TitleRecord | undefined {
	const s = titleStore();
	if (s === undefined) return undefined;
	const mine = titleRecordOf(save);
	for (let attempt = 0; ; attempt++) {
		// set inside the transform (the closure hides the assignment from the narrowing, hence the cast)
		let written = undefined as TitleRecord | undefined;
		const [ok, err] = pcall(() => {
			s.UpdateAsync<unknown, unknown>(key, old => {
				written = nextTitleRecord(old, mine, replace);
				return $tuple(written);
			});
		});
		if (ok && written !== undefined) return written;
		if (attempt >= delays.size()) {
			warn(`[${GAME_NAME}] ${key}: title record not saved (${tostring(err)}); retried on the next save`);
			return undefined;
		}
		task.wait(delays[attempt]);
	}
}
