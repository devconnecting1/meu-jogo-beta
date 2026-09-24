/*
 * The worlds that ended (docs/DESIGN_RULES.md MP-22: "o mundo que acabou fica registrado com quantos dias durou").
 * SERVER ONLY.
 *
 * One small, bounded document: key "ended" of the "ProjectZ_Worlds" store (suffixed in Studio, server/save/stores.ts)
 * holds the last WORLD_LOG_KEEP worlds that ended on ANY server — seed, days lasted, when it began and ended, why, how
 * many fell, which server — oldest first. This server also keeps the last WORLD_LOG_MEMORY it saw itself, in memory.
 *
 * Written the way the admin audit log is (server/admin/adminServer.ts): best effort and never on the reset's own
 * thread. `record` returns at once; a spawned thread does the UpdateAsync with the save path's retries, and a write
 * that still fails keeps the record for the next world's write and for the shutdown flush. A world that ends while
 * the DataStore is down is therefore late in the document, never in the game. UpdateAsync (not SetAsync) because
 * every server appends to the same document: each append is read-modify-write on whatever the others left.
 *
 * Known limits, accepted (review of f851ad2, L5) — the record is a statistic, not a save, and none of this can touch
 * the game:
 *   - a write still retrying when the server shuts down makes the BindToClose flush return at once (`writing`), and
 *     if that last attempt fails its records are lost with the server;
 *   - a write that went through but came back as an error (a timeout after the commit) is appended again by the next
 *     write: the document may hold a world twice. `appendEnded` does not dedupe; a reader can, by (job, endedAt);
 *   - every server appends to the SAME key, so the per-key write limits are shared by all of them. A world ends
 *     rarely (every survivor on the server dead, then the decision window), far below the limit today; many servers
 *     at once would want one key per server;
 *   - a failed write can never block or break the reset: it runs on its own thread, inside pcall, after the new town
 *     is already up (server/net/mpHost.ts `onWorldWiped`).
 */
import { GAME_NAME } from "shared/module";
import { EndedWorld, WORLD_LOG_KEEP, WORLD_LOG_MEMORY, appendEnded, readEndedList } from "../sim/worldReset";
import { WORLD_LOG_STORE } from "./stores";

const DataStoreService = game.GetService("DataStoreService");

const WORLD_LOG_KEY = "ended";
/** waits between the attempts of one write (4 attempts), as the save path does */
const RETRY_DELAYS = [1, 2, 4];
/** at shutdown BindToClose has 30 s for everything: one quick retry */
const SHUTDOWN_DELAYS = [0.5];

export interface WorldLog {
	/** keep this world's record: in memory now, in the DataStore as soon as a write goes through */
	record(entry: EndedWorld): void;
	/**
	 * keep it in this server's memory only (the admin panel's list): a keeper's restart (MP-26), which is not a world
	 * the players lost and must not push MP-22's records out of the shared document (review of 0b44458, M4)
	 */
	remember(entry: EndedWorld): void;
	/** the worlds this server saw end, oldest first (at most WORLD_LOG_MEMORY) */
	recent(): ReadonlyArray<EndedWorld>;
	/** "ok", "unavailable (…)" or "write failed (…)" — for the admin panel */
	status(): string;
}

export function startWorldLog(): WorldLog {
	const [storeOk, storeValue] = pcall((): unknown => DataStoreService.GetDataStore(WORLD_LOG_STORE));
	const store = storeOk ? (storeValue as DataStore) : undefined;
	const recent = new Array<EndedWorld>();
	/** records not in the DataStore yet, oldest first (bounded like the document itself) */
	const unsaved = new Array<EndedWorld>();
	let writing = false;
	let status = store !== undefined ? "ok" : `unavailable (${tostring(storeValue)})`;

	/** one append of everything unsaved, with retries; the batch goes back into `unsaved` if it never lands */
	function flush(delays: Array<number>): void {
		if (store === undefined || writing || unsaved.size() === 0) return;
		writing = true;
		const batch = new Array<EndedWorld>();
		for (const e of unsaved) batch.push(e);
		unsaved.clear();
		let lastErr: unknown;
		let written = false;
		for (let attempt = 0; attempt <= delays.size(); attempt++) {
			const [ok, err] = pcall(() => {
				store.UpdateAsync<unknown, unknown>(WORLD_LOG_KEY, old => {
					const list = readEndedList(old);
					for (const e of batch) appendEnded(list, e, WORLD_LOG_KEEP);
					return $tuple(list);
				});
			});
			if (ok) {
				written = true;
				break;
			}
			lastErr = err;
			if (attempt < delays.size()) task.wait(delays[attempt]);
		}
		writing = false;
		if (written) {
			status = "ok";
			// a world that ended while this write was retrying is still waiting its turn
			if (unsaved.size() > 0) flush(delays);
			return;
		}
		// keep them, oldest first, for the next write
		for (let i = batch.size() - 1; i >= 0; i--) unsaved.unshift(batch[i]);
		while (unsaved.size() > WORLD_LOG_KEEP) unsaved.remove(0);
		status = `write failed (${tostring(lastErr)})`;
		// one Error Report row however many wait (docs/ANALYTICS.md §10): the count is the log line after it
		warn(`[${GAME_NAME}] world record not saved yet: ${tostring(lastErr)}`);
		print(`[${GAME_NAME}] world records waiting: ${unsaved.size()}`);
	}

	// a write already in flight makes this a no-op (`writing`): its own retries decide those records (L5 above)
	game.BindToClose(() => flush(SHUTDOWN_DELAYS));

	return {
		record(entry) {
			appendEnded(recent, entry, WORLD_LOG_MEMORY);
			if (store === undefined) return;
			unsaved.push(entry);
			while (unsaved.size() > WORLD_LOG_KEEP) unsaved.remove(0);
			// never on the caller's thread: the world has already moved on, and a DataStore call yields
			task.spawn(() => flush(RETRY_DELAYS));
		},
		remember(entry) {
			appendEnded(recent, entry, WORLD_LOG_MEMORY);
		},
		recent() {
			return recent;
		},
		status() {
			return status;
		},
	};
}
