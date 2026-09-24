/*
 * The lobby's SERVERS list (docs/DESIGN_RULES.md MP-26, docs/MULTIPLAYER.md §4.10). SERVER ONLY.
 *
 * Every PUBLIC server says where it stands -- its town's seed, its world day, how many are on it -- in one MemoryStore
 * sorted map; a player in any lobby asks their own server for that list, picks a town and is teleported to THAT server
 * (TeleportOptions.ServerInstanceId). Nothing here is a player's data: no UserId, no name, only servers.
 *
 *   publish   `tick` (every TICK_S, from the wiring's loop) writes this server's entry when it changed -- at most once
 *             per PUBLISH_MIN_GAP_S -- and at least every PUBLISH_EVERY_S, with a TTL of ENTRY_TTL_S: a server that
 *             stops (a crash, a shutdown that could not say so) drops off the list on its own. A server with nobody
 *             on it removes its entry; so does the shutdown (`withdraw`), which also wins over a write still in
 *             flight. Only a public, live server publishes: a private or reserved server is not anybody's to join
 *             from a list, and Studio has no JobId. The entry names its place: another place of the experience is
 *             never listed nor joined.
 *   list      `list(player)`: GetRangeAsync over the map, at most READ_COUNT entries, cached READ_CACHE_S for the
 *             whole server (every lobby on it shares one read), and read only when somebody asks. The rows skip this
 *             server and anything stale or malformed, and come sorted: not full first, then the day closest to the
 *             player's best day, then the fuller town.
 *   join      `join(player, jobId)`: from the lobby only (never a teleport out of the city), one at a time per player
 *             and at most one per JOIN_GAP_S. The server does not take the client's word for the target: it reads the
 *             entry again (GetAsync) and refuses one that is gone, stale, full, not public or this very server, then
 *             TeleportAsync with ServerInstanceId -- retried TELEPORT_TRIES times a second apart while the player is
 *             still in the lobby (the docs' SafeTeleport). A failure after that arrives as TeleportInitFailed
 *             (`initFailed`): the player is told, and stays -- even when it comes while TeleportAsync still yields.
 *             The join is counted where it LANDS: the teleport carries SERVER_LIST_TELEPORT_DATA, and the destination
 *             logs JoinedFromList (`arrivedFromList`, server/match/townServices.ts).
 *
 * THE QUOTA (memory-stores index.md "Limits and quotas": 1000 + 120 × concurrent users request units a minute for the
 * whole experience; GetRangeAsync costs one unit per item returned, a write or a GetAsync one). Per server, at most:
 *   writes   60 / PUBLISH_MIN_GAP_S = 4 a minute (2 when nothing changes), plus one RemoveAsync at shutdown;
 *   reads    60 / READ_CACHE_S × READ_COUNT = 2 × 50 = 100 units a minute, and only while somebody has the list open;
 *   joins    one GetAsync per JOIN_GAP_S per player = 12 a minute for each player.
 * So a server with p players spends at most 104 + 12p ≤ 120p units a minute (p ≥ 1): the list never eats more than
 * the 120 each user adds, whatever the number of servers, and the base 1000 stays free. The single map is also held
 * to 100 000 units a minute per data structure: ~860 one-player servers all reading and joining at the worst rate at
 * once (`quotaPerMinute`), far past what the lazy reads make real.
 *
 * Pure: the MemoryStore map, the teleport and the clocks are ports (`startServerList` plugs the real services in), so
 * tools/test-serverlist.mjs runs all of it under Node against fakes, quota included.
 */
import { SERVER_ROWS_MAX, ServerRow, TownRefusal, TownResponse, isJobId } from "shared/net/townNet";

/** the sorted map every public server writes its entry to (memory stores are kept apart between Studio and live) */
export const SERVER_LIST_MAP = "ProjectZ_Servers";
/** the entry's shape version */
export const ENTRY_VERSION = 1;
/** how often the wiring calls `tick` (s): no request unless an entry is due */
export const TICK_S = 5;
/** an entry that changed is written at most this often (s) */
export const PUBLISH_MIN_GAP_S = 15;
/** an entry is written at least this often, changed or not (s) */
export const PUBLISH_EVERY_S = 30;
/** the entry's TTL (s): three missed writes and it is gone */
export const ENTRY_TTL_S = 90;
/** an entry published longer ago than this is not joined (s): the TTL, against a clock that drifted */
export const ENTRY_STALE_S = 90;
/** entries one read asks for (GetRangeAsync's own ceiling is 200) */
export const READ_COUNT = 50;
/** one read serves the whole server this long (s) -- a failed read too, so a broken store is not hammered */
export const READ_CACHE_S = 30;
/** a player's joins are this far apart at least (s) */
export const JOIN_GAP_S = 5;
/** TeleportAsync attempts per join, a second apart */
export const TELEPORT_TRIES = 3;
export const TELEPORT_WAIT_S = 1;
/** a join with no answer this long after TeleportAsync (the player is still here) is over (s) */
export const JOIN_TIMEOUT_S = 30;
/** the MemoryStore's own ceiling on one data structure (request units a minute) */
export const STRUCTURE_UNITS_PER_MINUTE = 100000;

/** what kind of server this is, for the list: only a public, live one publishes (and Studio does nothing at all) */
export type ServerKind = "public" | "private" | "reserved" | "studio";

/** DataModel's server identity → its kind (a private server with no owner is a reserved one: Play solo, §7.4) */
export function serverKindOf(isStudio: boolean, jobId: string, privateServerId: string, ownerId: number): ServerKind {
	if (isStudio || jobId === "") return "studio";
	if (privateServerId !== "") return ownerId !== 0 ? "private" : "reserved";
	return "public";
}

/** the MemoryStoreSortedMap, as far as the list needs it; every call may throw (the wiring does not catch) */
export interface ListStore {
	readonly set: (key: string, value: unknown, ttl: number, sortKey: number) => void;
	/** the entry's value, or undefined when there is none */
	readonly get: (key: string) => unknown;
	/** the first `count` entries, ascending by sort key (not full first) */
	readonly range: (count: number) => Array<{ key: string; value: unknown }>;
	readonly remove: (key: string) => void;
}

/** TeleportService:TeleportAsync(game.PlaceId, {player}, TeleportOptions{ServerInstanceId = jobId}); throws on failure */
export type Teleporter = (player: Player, jobId: string) => void;

export interface ServerListHost {
	kind: ServerKind;
	/** this server's JobId */
	jobId: string;
	/** game.PlaceId: an entry of another place of the experience is never listed nor joined (review of 0b44458, L6) */
	placeId: number;
	/** undefined: MemoryStoreService could not be had */
	store: ListStore | undefined;
	/** undefined: TeleportService could not be had */
	teleport: Teleporter | undefined;
	/** seconds, monotonic (os.clock) */
	clock: () => number;
	/** unix seconds (os.time): what an entry is stamped with, comparable between servers */
	now: () => number;
	/** waits (task.wait); a test's advances its clock */
	wait: (seconds: number) => void;
	/** the town this server runs */
	town: () => { seed: number; day: number };
	/** players connected, and the server's capacity */
	players: () => number;
	capacity: () => number;
	/** the player has a body in the city (a join is from the lobby only) */
	inWorld: (player: Player) => boolean;
	/** the player's save is still being read */
	loading: (player: Player) => boolean;
	/** the player is still connected to this server */
	connected: (player: Player) => boolean;
	/** the player's best day (the list sorts by the day closest to it); undefined while unknown */
	bestDay: (player: Player) => number | undefined;
	/** a line for the server log (ids only) */
	log: (line: string) => void;
	/** a fixed sentence for the Error Report, the detail in the log line after it (docs/ANALYTICS.md §10) */
	warn: (what: string, detail: string) => void;
}

/** one entry as it is stored (and read back from another server: checked, never trusted) */
interface Entry {
	v: number;
	kind: string;
	/** the place it runs (game.PlaceId) */
	place: number;
	seed: number;
	day: number;
	n: number;
	max: number;
	/** unix seconds when it was written */
	t: number;
}

function wholeIn(v: unknown, min: number, max: number): v is number {
	return typeIs(v, "number") && v === v && v % 1 === 0 && v >= min && v <= max;
}

/** an entry read from the map, or undefined when it is not one this code wrote */
export function readEntry(v: unknown): Entry | undefined {
	if (!typeIs(v, "table")) return undefined;
	const r = v as Record<string, unknown>;
	if (r.v !== ENTRY_VERSION || !typeIs(r.kind, "string") || !wholeIn(r.place, 0, 1e15)) return undefined;
	if (!wholeIn(r.seed, 1, 2147483646) || !wholeIn(r.day, 1, 1e6)) return undefined;
	if (!wholeIn(r.max, 1, 100) || !wholeIn(r.n, 0, r.max) || !wholeIn(r.t, 0, 1e12)) return undefined;
	return { v: r.v, kind: r.kind, place: r.place, seed: r.seed, day: r.day, n: r.n, max: r.max, t: r.t };
}

/** request units one minute can cost this server at most, with `players` on it (the header's arithmetic) */
export function quotaPerMinute(players: number): { writes: number; reads: number; joins: number; total: number } {
	const writes = 60 / PUBLISH_MIN_GAP_S;
	const reads = (60 / READ_CACHE_S) * READ_COUNT;
	const joins = (60 / JOIN_GAP_S) * math.max(0, players);
	return { writes, reads, joins, total: writes + reads + joins };
}

/** the MemoryStore requests this server made, by kind, and the units they cost */
export interface ListStats {
	writes: number;
	removes: number;
	reads: number;
	/** units the reads cost: one per entry returned, one for an empty answer */
	readUnits: number;
	gets: number;
	teleports: number;
}

interface Join {
	jobId: string;
	row: ServerRow;
	at: number;
	/** a TeleportInitFailed already came for it -- maybe while TeleportAsync was still yielding (review of 0b44458, L5) */
	failed?: TownRefusal;
}

export class ServerList {
	readonly stats: ListStats = { writes: 0, removes: 0, reads: 0, readUnits: 0, gets: 0, teleports: 0 };
	private readonly host: ServerListHost;
	/** what the last write said, and when (clock) */
	private published?: Entry;
	private publishedAt = -math.huge;
	/** the last read's entries, and when it was made (clock); `reading` while one is in flight */
	private cache?: Array<{ jobId: string; entry: Entry }>;
	private cacheAt = -math.huge;
	private cacheOk = false;
	private reading = false;
	/** the server is shutting down (`withdraw`): nothing more is published */
	private closed = false;
	private readonly joins = new Map<Player, Join>();
	private readonly lastJoin = new Map<Player, number>();

	constructor(host: ServerListHost) {
		this.host = host;
	}

	/** this server publishes its entry (public and live, with a store to write to) */
	publishes(): boolean {
		return this.host.kind === "public" && this.host.store !== undefined && this.host.jobId !== "";
	}

	/** the entry this server would write now */
	private entryNow(): Entry {
		const h = this.host;
		const town = h.town();
		const max = math.clamp(math.floor(h.capacity()), 1, 100);
		return {
			v: ENTRY_VERSION,
			kind: "public",
			place: h.placeId,
			seed: town.seed,
			day: math.max(1, math.floor(town.day)),
			n: math.clamp(math.floor(h.players()), 0, max),
			max,
			t: math.floor(h.now()),
		};
	}

	/** every TICK_S: writes the entry when it is due (changed and PUBLISH_MIN_GAP_S old, or PUBLISH_EVERY_S old) */
	tick(): void {
		if (!this.publishes() || this.closed) return;
		const h = this.host;
		const store = h.store!;
		const entry = this.entryNow();
		const since = h.clock() - this.publishedAt;
		const last = this.published;
		if (entry.n === 0) {
			// nobody here: nothing to join. The entry goes (once), and comes back with the next player
			if (last !== undefined) this.remove(store);
			return;
		}
		const changed =
			last === undefined ||
			last.seed !== entry.seed ||
			last.day !== entry.day ||
			last.n !== entry.n ||
			last.max !== entry.max;
		if (!(changed && since >= PUBLISH_MIN_GAP_S) && since < PUBLISH_EVERY_S) return;
		// the attempt counts as the write, failed or not: a store that fails is not retried faster than the cadence
		this.publishedAt = h.clock();
		this.stats.writes += 1;
		const [ok, err] = pcall(() => store.set(h.jobId, entry, ENTRY_TTL_S, entry.n >= entry.max ? 1 : 0));
		if (this.closed) {
			// the server began shutting down while this write was in flight (SetAsync yields): whatever order the two
			// requests land in, the entry must not outlive the server by a TTL -- it goes again, now
			if (ok) this.remove(store);
			return;
		}
		if (ok) {
			this.published = entry;
		} else {
			h.warn("the server list entry could not be written", tostring(err));
		}
	}

	private remove(store: ListStore): void {
		const h = this.host;
		this.published = undefined;
		this.publishedAt = h.clock();
		this.stats.removes += 1;
		const [ok, err] = pcall(() => store.remove(h.jobId));
		if (!ok) h.warn("the server list entry could not be removed", tostring(err));
	}

	/**
	 * The server is shutting down: its entry goes at once (the TTL would take ENTRY_TTL_S), and nothing is written
	 * after this -- a write already in flight removes it again when it returns (`tick`).
	 */
	withdraw(): void {
		if (!this.publishes()) return;
		const inFlight = this.closed;
		this.closed = true;
		if (this.published === undefined && !inFlight) return;
		this.remove(this.host.store!);
	}

	/** the entries of the last read, reading again when it is older than READ_CACHE_S; undefined: none could be had */
	private entries(): Array<{ jobId: string; entry: Entry }> | undefined {
		const h = this.host;
		const store = h.store;
		if (store === undefined) return undefined;
		// a read already in flight (another lobby asked a moment ago): wait for it rather than read twice
		const t0 = h.clock();
		while (this.reading && h.clock() - t0 < 10) h.wait(0.1);
		if (h.clock() - this.cacheAt < READ_CACHE_S) return this.cacheOk ? this.cache : undefined;
		this.reading = true;
		this.stats.reads += 1;
		const [ok, result] = pcall(() => store.range(READ_COUNT));
		this.reading = false;
		this.cacheAt = h.clock();
		if (!ok || !typeIs(result, "table")) {
			this.cacheOk = false;
			this.stats.readUnits += 1;
			h.warn("the server list could not be read", tostring(result));
			return undefined;
		}
		const items = result as Array<{ key: unknown; value: unknown }>;
		this.stats.readUnits += math.max(1, items.size());
		const out = new Array<{ jobId: string; entry: Entry }>();
		for (const item of items) {
			if (out.size() >= READ_COUNT) break;
			if (!typeIs(item, "table") || !isJobId(item.key)) continue;
			const entry = readEntry(item.value);
			if (entry !== undefined) out.push({ jobId: item.key, entry });
		}
		this.cache = out;
		this.cacheOk = true;
		return out;
	}

	/** the Servers list for `player`: best first, this server left out */
	list(player: Player): TownResponse {
		const h = this.host;
		if (h.kind === "studio") return { ok: false, reason: "studio" };
		const entries = this.entries();
		if (entries === undefined) return { ok: false, reason: "unavailable" };
		const now = h.now();
		const best = h.bestDay(player) ?? 1;
		const rows = new Array<ServerRow>();
		for (const { jobId, entry } of entries) {
			if (jobId === h.jobId || entry.kind !== "public" || entry.place !== h.placeId) continue;
			if (now - entry.t > ENTRY_STALE_S) continue;
			rows.push({ jobId, seed: entry.seed, day: entry.day, players: entry.n, max: entry.max });
		}
		rows.sort((a, b) => {
			const fullA = a.players >= a.max;
			const fullB = b.players >= b.max;
			if (fullA !== fullB) return !fullA;
			const da = math.abs(a.day - best);
			const db = math.abs(b.day - best);
			if (da !== db) return da < db;
			if (a.players !== b.players) return a.players > b.players;
			return a.jobId < b.jobId;
		});
		while (rows.size() > SERVER_ROWS_MAX) rows.pop();
		return { ok: true, servers: rows };
	}

	/** why `player` may not join `jobId` now, before anything is asked of the store; undefined: they may */
	private refusalOf(player: Player, jobId: string): TownRefusal | undefined {
		const h = this.host;
		if (h.kind === "studio") return "studio";
		if (h.store === undefined || h.teleport === undefined) return "unavailable";
		if (!isJobId(jobId)) return "invalid";
		if (jobId === h.jobId) return "same";
		if (h.loading(player)) return "loading";
		if (h.inWorld(player)) return "inWorld";
		const pending = this.joins.get(player);
		if (pending !== undefined) {
			if (h.clock() - pending.at < JOIN_TIMEOUT_S) return "busy";
			this.joins.delete(player);
		}
		const last = this.lastJoin.get(player);
		if (last !== undefined && h.clock() - last < JOIN_GAP_S) return "rate";
		return undefined;
	}

	/** the lobby's Join: checked against the server's own reading of the target, then TeleportAsync. Yields */
	join(player: Player, jobId: string): TownResponse {
		const h = this.host;
		const refusal = this.refusalOf(player, jobId);
		if (refusal !== undefined) return { ok: false, reason: refusal };
		this.lastJoin.set(player, h.clock());
		// the client named a server; what it IS comes from the map, read now -- never from the client, nor the cache
		this.stats.gets += 1;
		const [ok, value] = pcall(() => h.store!.get(jobId));
		if (!ok) {
			h.warn("the server list entry could not be read", tostring(value));
			return { ok: false, reason: "unavailable" };
		}
		const entry = readEntry(value);
		if (
			entry === undefined ||
			entry.kind !== "public" ||
			entry.place !== h.placeId ||
			h.now() - entry.t > ENTRY_STALE_S
		) {
			return { ok: false, reason: "gone" };
		}
		if (entry.n >= entry.max) return { ok: false, reason: "full" };
		const row: ServerRow = { jobId, seed: entry.seed, day: entry.day, players: entry.n, max: entry.max };
		const join: Join = { jobId, row, at: h.clock() };
		this.joins.set(player, join);
		let lastErr: unknown;
		for (let attempt = 1; attempt <= TELEPORT_TRIES; attempt++) {
			// every retry asks again: a player who walked into the city (or left) meanwhile is not teleported
			if (!h.connected(player) || h.inWorld(player) || this.joins.get(player) !== join) {
				this.joins.delete(player);
				return { ok: false, reason: h.inWorld(player) ? "inWorld" : "failed" };
			}
			this.stats.teleports += 1;
			const [sent, err] = pcall(() => h.teleport!(player, jobId));
			// the platform may already have said no while TeleportAsync yielded (TeleportInitFailed, `initFailed`): the
			// player stays, and the answer is that failure, never "sent"
			if (join.failed !== undefined) return { ok: false, reason: join.failed };
			if (sent) {
				join.at = h.clock();
				// the join is COUNTED where it lands (analytics' JoinedFromList, on the destination: `arrivedFromList`)
				h.log(`[server list] ${player.UserId} -> ${jobId} (seed ${entry.seed}, day ${entry.day}): sent`);
				return { ok: true };
			}
			lastErr = err;
			if (attempt < TELEPORT_TRIES) h.wait(TELEPORT_WAIT_S);
		}
		this.joins.delete(player);
		h.warn("a join from the server list could not be sent", tostring(lastErr));
		return { ok: false, reason: "failed" };
	}

	/**
	 * TeleportInitFailed for `player`: the teleport did not start and they are still here. Answers what to tell them
	 * (undefined: it was not a join of this list). `result` is Enum.TeleportResult's name.
	 */
	initFailed(player: Player, result: string): TownRefusal | undefined {
		const join = this.joins.get(player);
		if (join === undefined) return undefined;
		this.joins.delete(player);
		this.host.log(`[server list] ${player.UserId} -> ${join.jobId}: ${result}`);
		let why: TownRefusal = "failed";
		if (result === "GameFull") why = "full";
		else if (result === "GameEnded" || result === "GameNotFound") why = "gone";
		else if (result === "Flooded") why = "rate";
		join.failed = why;
		return why;
	}

	/** the player left the server (the teleport worked, or they quit): nothing of theirs is kept */
	forget(player: Player): void {
		this.joins.delete(player);
		this.lastJoin.delete(player);
	}

	/**
	 * A join of this player is waiting on the platform (at most JOIN_TIMEOUT_S: a teleport that never happens and never
	 * says so does not hold the player forever). The host does not stand them in the city meanwhile (mpHost `mayEnter`):
	 * never a teleport out of a fight.
	 */
	joining(player: Player): boolean {
		const join = this.joins.get(player);
		return join !== undefined && this.host.clock() - join.at < JOIN_TIMEOUT_S;
	}
}

// ---------------------------------------------------------------- the Roblox side

/** the host's pieces that are not a Roblox service (server/match/townServices.ts hands them over) */
export type ServerListGame = Omit<
	ServerListHost,
	"kind" | "jobId" | "placeId" | "store" | "teleport" | "clock" | "now" | "wait"
>;

/**
 * What a join from the list carries to the destination (TeleportOptions:SetTeleportData): a flag, and nothing else. It
 * passes through the client, so the destination trusts it for one thing only -- counting the join where it lands
 * (analytics' JoinedFromList) -- and only from this very place (`arrivedFromList`). Review of 0b44458, L5.
 */
export const SERVER_LIST_TELEPORT_DATA = { pz: "servers" };

/** Player:GetJoinData() of a player the Servers list of this place sent here (the docs: check SourcePlaceId first) */
export function arrivedFromList(joinData: unknown, placeId: number): boolean {
	if (!typeIs(joinData, "table")) return false;
	const d = joinData as Record<string, unknown>;
	if (d.SourcePlaceId !== placeId || !typeIs(d.TeleportData, "table")) return false;
	return (d.TeleportData as Record<string, unknown>).pz === SERVER_LIST_TELEPORT_DATA.pz;
}

/**
 * The real services plugged in: MemoryStoreService's sorted map and TeleportService, each got in pcall (a place where
 * they cannot be had lists nothing and joins nothing, and says so), the tick loop, the shutdown withdrawal, and
 * TeleportInitFailed answered through `notify`.
 */
export function startServerList(game_: ServerListGame, notify: (player: Player, why: TownRefusal) => void): ServerList {
	const [studioOk, studio] = pcall(() => game.GetService("RunService").IsStudio());
	const kind = serverKindOf(studioOk && studio === true, game.JobId, game.PrivateServerId, game.PrivateServerOwnerId);
	let store: ListStore | undefined;
	if (kind !== "studio") {
		const [ok, map] = pcall(() => game.GetService("MemoryStoreService").GetSortedMap(SERVER_LIST_MAP));
		if (ok) {
			const m = map as MemoryStoreSortedMap;
			store = {
				set: (key, value, ttl, sortKey) => {
					m.SetAsync(key, value, ttl, sortKey);
				},
				get: key => {
					const [value] = m.GetAsync(key);
					return value;
				},
				range: count => m.GetRangeAsync(Enum.SortDirection.Ascending, count),
				remove: key => m.RemoveAsync(key),
			};
		}
	}
	let teleport: Teleporter | undefined;
	let teleportService: TeleportService | undefined;
	if (kind !== "studio") {
		const [ok, service] = pcall(() => game.GetService("TeleportService"));
		if (ok) {
			const ts = service as TeleportService;
			teleportService = ts;
			teleport = (player, jobId) => {
				const options = new Instance("TeleportOptions");
				options.ServerInstanceId = jobId;
				options.SetTeleportData(SERVER_LIST_TELEPORT_DATA);
				ts.TeleportAsync(game.PlaceId, [player], options);
			};
		}
	}
	const list = new ServerList({
		...game_,
		kind,
		jobId: game.JobId,
		placeId: game.PlaceId,
		store,
		teleport,
		clock: () => os.clock(),
		now: () => os.time(),
		wait: s => {
			task.wait(s);
		},
	});
	game_.log(
		`[server list] ${kind} server: ${list.publishes() ? "publishing" : "not publishing"}` +
			`${store === undefined && kind !== "studio" ? " (no MemoryStore)" : ""}`,
	);
	teleportService?.TeleportInitFailed.Connect((player, result) => {
		const why = list.initFailed(player, result.Name);
		if (why !== undefined) notify(player, why);
	});
	if (list.publishes()) {
		let closing = false;
		game.BindToClose(() => {
			closing = true;
			list.withdraw();
		});
		task.spawn(() => {
			while (!closing) {
				// one bad tick (a store that throws past its own pcall, a host callback) never ends the loop (L4)
				const [ok, err] = pcall(() => list.tick());
				if (!ok) game_.warn("the server list tick failed", tostring(err));
				task.wait(TICK_S);
			}
		});
	}
	return list;
}
