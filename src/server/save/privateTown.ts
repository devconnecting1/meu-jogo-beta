/*
 * A private server's town, kept across its sessions (docs/DESIGN_RULES.md MP-24; docs/MULTIPLAYER.md §4.9, §7.5).
 * SERVER ONLY.
 *
 * A private (VIP) server closes when its last player leaves, and the next time its owner and friends join it, Roblox
 * starts a new instance. Without this, every session of "the server of my clan" was a new town on day 1. The server
 * is still the one authority on its town (MP-24); this only lets the NEXT instance of the SAME private server pick up
 * where the last one stopped: the same seed (the same streets), the same world day. What stood on those streets --
 * constructions, doors, ground items -- was never kept across instances on any server (§6.1) and is not kept now.
 *
 *   - Only a private server with an owner (`PrivateServerId` ≠ "" and `PrivateServerOwnerId` ≠ 0). A public server
 *     never reads or writes this store: a public town lives and dies with its instance (MP-24). A reserved server
 *     (Play solo, owner 0) is one-off, and is not kept either.
 *   - One key per private server (its PrivateServerId, `ProjectZ_PrivateTowns`, suffixed in Studio): the seed, the
 *     world day and when that world began. No UserId, no name: nothing here is anybody's personal data.
 *   - Read ONCE, at boot, before the town is generated, with a bounded wait (`LOAD_WAIT_S`): the town must never swap
 *     under the players, so a read that has not answered in time (or failed) means a fresh town for this session --
 *     and this session then never writes, so it cannot overwrite a town it did not manage to read.
 *   - Written off the game's threads: when the town or the day changes (checked every `CHECK_EVERY_S`; MP-22's new
 *     town at once, through `note`) and at shutdown (BindToClose). A day restored starts at 07:00: the instance that
 *     closed mid-night took its horde with it, and a night without its waves is not a night.
 *   - MP-22 still ends it: everybody in the world dead and nobody paying, the town is replaced by a new one on day 1
 *     -- and that is what the next session gets.
 */
import { GAME_NAME } from "shared/module";
import { TOWN_SEED_MAX } from "shared/net/mpConfig";
import { PRIVATE_TOWN_STORE } from "./stores";

const DataStoreService = game.GetService("DataStoreService");

/** the record's shape version */
export const PRIVATE_TOWN_VERSION = 1;
/** the most a boot waits for the read (seconds): past it the session opens on a fresh town and never writes */
export const LOAD_WAIT_S = 6;
/** how often the running town is compared with what was written (seconds) */
export const CHECK_EVERY_S = 15;
/** a PrivateServerId longer than this is not one (Roblox's are GUIDs, 36 characters; a DataStore key takes 50) */
const KEY_MAX = 50;
/** waits between the attempts of one write (3 attempts); one quick retry at shutdown */
const RETRY_DELAYS = [1, 3];
const SHUTDOWN_DELAYS = [0.5];

/** what is kept of a private server's town */
export interface PrivateTown {
	seed: number;
	/** the world day it was on (≥ 1) */
	day: number;
	/** os.time() when this world began (the record of MP-22 says how long it lasted) */
	startedAt: number;
}

function wholeIn(v: unknown, min: number, max: number): v is number {
	return typeIs(v, "number") && v === v && v % 1 === 0 && v >= min && v <= max;
}

/**
 * The DataStore key of THIS server's town, or undefined when it is not a server whose town is kept: a public server
 * (no PrivateServerId), a reserved one (no owner) or an id that is not one.
 */
export function privateTownKey(privateServerId: unknown, ownerId: unknown): string | undefined {
	if (!typeIs(privateServerId, "string") || privateServerId === "" || privateServerId.size() > KEY_MAX) {
		return undefined;
	}
	if (!typeIs(ownerId, "number") || ownerId === 0) return undefined;
	return privateServerId;
}

/** a stored record, checked like any DataStore document: anything malformed is no town */
export function readPrivateTown(v: unknown): PrivateTown | undefined {
	if (!typeIs(v, "table")) return undefined;
	const r = v as Record<string, unknown>;
	if (!wholeIn(r.seed, 1, TOWN_SEED_MAX) || !wholeIn(r.day, 1, 1e6) || !wholeIn(r.startedAt, 0, 1e12)) {
		return undefined;
	}
	return { seed: r.seed, day: r.day, startedAt: r.startedAt };
}

function sameTown(a: PrivateTown | undefined, b: PrivateTown | undefined): boolean {
	return a !== undefined && b !== undefined && a.seed === b.seed && a.day === b.day && a.startedAt === b.startedAt;
}

export interface PrivateTownKeeper {
	/** the town the last session left (undefined: none kept, or the read did not answer in time) */
	readonly initial: PrivateTown | undefined;
	/** this session writes the town (false: the read failed or timed out, so it must not overwrite what is there) */
	readonly persists: boolean;
	/** the town changed (MP-22's new one): written now, off this thread */
	readonly note: (town: PrivateTown | undefined) => void;
	/** "ok", "not kept (…)" or "write failed (…)" -- for the log and the admin panel */
	readonly status: () => string;
}

/**
 * On a private server with an owner: reads the town its last session left (bounded by `LOAD_WAIT_S`), then keeps the
 * running one written -- `current` is asked every CHECK_EVERY_S and at shutdown. Anywhere else: undefined, and nothing
 * is read or written.
 */
export function keepPrivateTown(current: () => PrivateTown | undefined): PrivateTownKeeper | undefined {
	const found = privateTownKey(game.PrivateServerId, game.PrivateServerOwnerId);
	if (found === undefined) return undefined;
	const key: string = found;
	const [storeOk, storeValue] = pcall((): unknown => DataStoreService.GetDataStore(PRIVATE_TOWN_STORE));
	if (!storeOk) {
		warn(`[${GAME_NAME}] private town store unavailable (${tostring(storeValue)}): a fresh town, not kept`);
		return { initial: undefined, persists: false, note: () => {}, status: () => "not kept (store unavailable)" };
	}
	const store = storeValue as DataStore;

	// ---- the read, bounded: the town must be known before it is generated, and never swapped afterwards
	let answered = false;
	let readOk = false;
	let initial: PrivateTown | undefined;
	let readErr: unknown;
	task.spawn(() => {
		const [ok, value] = pcall(() => {
			const [stored] = store.GetAsync<unknown>(key);
			return stored;
		});
		readOk = ok;
		if (ok) initial = readPrivateTown(value);
		else readErr = value;
		answered = true;
	});
	const t0 = os.clock();
	while (!answered && os.clock() - t0 < LOAD_WAIT_S) task.wait(0.05);
	// a late answer is ignored from here on: this session already opened its own town
	const persists = answered && readOk;
	let status = persists ? "ok" : `not kept (${answered ? tostring(readErr) : "the read did not answer in time"})`;
	if (!persists) {
		warn(`[${GAME_NAME}] private town could not be read: ${status}; this session opens a fresh town`);
	} else if (initial !== undefined) {
		print(`[${GAME_NAME}] private server: its town is back (seed ${initial.seed}, day ${initial.day})`);
	}

	// ---- the writes: the latest town wins; one write at a time, off the caller's thread
	let written: PrivateTown | undefined = initial;
	let pending: PrivateTown | undefined;
	let writing = false;
	function write(delays: Array<number>): void {
		if (writing) return;
		writing = true;
		while (pending !== undefined) {
			const town = pending;
			pending = undefined;
			if (sameTown(town, written)) continue;
			let lastErr: unknown;
			let ok = false;
			for (let attempt = 0; attempt <= delays.size() && !ok; attempt++) {
				const [done, err] = pcall(() => {
					store.UpdateAsync<unknown, unknown>(key, () =>
						$tuple({
							v: PRIVATE_TOWN_VERSION,
							seed: town.seed,
							day: town.day,
							startedAt: town.startedAt,
							savedAt: os.time(),
						}),
					);
				});
				ok = done;
				lastErr = err;
				if (!ok && attempt < delays.size()) task.wait(delays[attempt]);
			}
			if (ok) {
				written = town;
				status = "ok";
			} else {
				status = `write failed (${tostring(lastErr)})`;
				warn(`[${GAME_NAME}] private town not saved: ${tostring(lastErr)}`);
				// the next check (or the shutdown) tries the latest town again
				break;
			}
		}
		writing = false;
	}
	function note(town: PrivateTown | undefined): void {
		if (!persists || town === undefined || sameTown(town, written)) return;
		pending = town;
		task.spawn(() => write(RETRY_DELAYS));
	}

	if (persists) {
		let closing = false;
		// the day the instance closes on is the one the next session opens on (a write in flight picks it up)
		game.BindToClose(() => {
			closing = true;
			const town = current();
			if (town === undefined || sameTown(town, written)) return;
			pending = town;
			write(SHUTDOWN_DELAYS);
		});
		task.spawn(() => {
			while (!closing) {
				task.wait(CHECK_EVERY_S);
				if (!closing) note(current());
			}
		});
	}
	return {
		initial,
		persists,
		note,
		status: () => status,
	};
}
