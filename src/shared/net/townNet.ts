/*
 * The town's own remotes (ReplicatedStorage/PZTownNet), docs/DESIGN_RULES.md MP-26 and docs/MULTIPLAYER.md §4.10:
 * the lobby's Servers list, the join from it, and the keeper's "Restart town".
 *
 *   TownRequest  C→S  RemoteFunction  (TownRequest) → TownResponse
 *                     servers   the public towns this player may join, as the server read them (MemoryStore)
 *                     join      go to one of them: the server checks the entry and teleports (TeleportAsync)
 *                     restart   a new town now: only this private server's owner, or an admin
 *   TownNotice   S→C  RemoteEvent     (TownNoticeMsg)
 *                     a join that failed AFTER TeleportAsync returned (TeleportInitFailed): the player is still here
 *
 * Nothing a client sends is trusted: every request is re-read here (`readTownRequest`), checked against the server's
 * own state there (server/match/townServices.ts), and rate-limited per player. The server's answers are re-read by
 * the client too (`readServerRows`): a remote is a boundary both ways.
 */

export const TOWN_NET_FOLDER = "PZTownNet";
export const REMOTE_TOWN_REQUEST = "TownRequest";
export const REMOTE_TOWN_NOTICE = "TownNotice";

/**
 * Player attribute the server sets on who may restart THIS server's town (the private server's owner, an admin): the
 * lobby shows "Restart town" only to them. A client that forces it on itself gets a button the server refuses.
 */
export const TOWN_KEEPER_ATTR = "pz_town_keeper";

/** a JobId is a GUID (36 characters); anything longer, or with other characters, is not one */
export const JOB_ID_MAX = 64;
/** rows one Servers answer carries at most */
export const SERVER_ROWS_MAX = 20;

export type TownRequest = { kind: "servers" } | { kind: "join"; jobId: string } | { kind: "restart" };

/**
 * Why a request did not go through (the client words each one, shared/data/lang.ts):
 *   rate         too soon after the last one
 *   invalid      not a request this remote takes
 *   studio       Studio: no server list, no teleport (both only work in the published game)
 *   unavailable  the MemoryStore or TeleportService could not be reached, or there is no town to restart
 *   forbidden    only the private server's owner (or an admin) may restart its town
 *   busy         a join of this player is already under way / a new town is already being made
 *   inWorld      join from the lobby only: never a teleport out of the city
 *   loading      the save is still being read
 *   same         that is this server
 *   gone         that server is no longer listed (it closed, or stopped publishing)
 *   full         that server has no free slot
 *   failed       the teleport failed (the platform said no)
 */
export type TownRefusal =
	| "rate"
	| "invalid"
	| "studio"
	| "unavailable"
	| "forbidden"
	| "busy"
	| "inWorld"
	| "loading"
	| "dead"
	| "danger"
	| "trip"
	| "same"
	| "gone"
	| "full"
	| "failed";

const REFUSALS: ReadonlyArray<TownRefusal> = [
	"rate",
	"invalid",
	"studio",
	"unavailable",
	"forbidden",
	"busy",
	"inWorld",
	"loading",
	"dead",
	"danger",
	"trip",
	"same",
	"gone",
	"full",
	"failed",
];

/** one public town of the list: what its server last published (server/match/serverList.ts) */
export interface ServerRow {
	jobId: string;
	/** its town's seed (the client names it: shared/data/townNames.ts) */
	seed: number;
	/** its world day */
	day: number;
	/** players connected to it, and its capacity */
	players: number;
	max: number;
}

export interface TownResponse {
	ok: boolean;
	reason?: TownRefusal;
	/** `servers` only: best first (not full, then the day closest to this player's best day) */
	servers?: Array<ServerRow>;
}

export type TownNoticeMsg = { k: "joinFailed"; why: TownRefusal };

function wholeIn(v: unknown, min: number, max: number): v is number {
	return typeIs(v, "number") && v === v && v % 1 === 0 && v >= min && v <= max;
}

/** the characters of a GUID (and of nothing that could break a log line or a key) */
const JOB_CHARS = new Set<string>();
{
	const all = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-";
	for (let i = 1; i <= all.size(); i++) JOB_CHARS.add(all.sub(i, i));
}

/** a JobId as Roblox makes them (a GUID): ASCII letters, digits and dashes, 1 … JOB_ID_MAX of them */
export function isJobId(v: unknown): v is string {
	if (!typeIs(v, "string") || v.size() < 1 || v.size() > JOB_ID_MAX) return false;
	for (let i = 1; i <= v.size(); i++) {
		if (!JOB_CHARS.has(v.sub(i, i))) return false;
	}
	return true;
}

/** a request as the server takes it, or undefined (anything else is "invalid") */
export function readTownRequest(raw: unknown): TownRequest | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const r = raw as Record<string, unknown>;
	if (r.kind === "servers") return { kind: "servers" };
	if (r.kind === "restart") return { kind: "restart" };
	if (r.kind === "join" && isJobId(r.jobId)) return { kind: "join", jobId: r.jobId };
	return undefined;
}

export function readRefusal(v: unknown): TownRefusal | undefined {
	return REFUSALS.find(r => r === v);
}

/** the rows of a server answer, as the client takes them: anything malformed is dropped */
export function readServerRows(raw: unknown): Array<ServerRow> {
	const out = new Array<ServerRow>();
	if (!typeIs(raw, "table")) return out;
	for (const item of raw as Array<unknown>) {
		if (out.size() >= SERVER_ROWS_MAX) break;
		if (!typeIs(item, "table")) continue;
		const r = item as Record<string, unknown>;
		if (!isJobId(r.jobId) || !wholeIn(r.seed, 1, 2147483646) || !wholeIn(r.day, 1, 1e6)) continue;
		if (!wholeIn(r.max, 1, 100) || !wholeIn(r.players, 0, r.max)) continue;
		out.push({ jobId: r.jobId, seed: r.seed, day: r.day, players: r.players, max: r.max });
	}
	return out;
}

/** a server answer as the client takes it */
export function readTownResponse(raw: unknown): TownResponse {
	if (!typeIs(raw, "table")) return { ok: false, reason: "failed" };
	const r = raw as Record<string, unknown>;
	const out: TownResponse = { ok: r.ok === true, reason: readRefusal(r.reason) };
	if (r.servers !== undefined) out.servers = readServerRows(r.servers);
	if (!out.ok && out.reason === undefined) out.reason = "failed";
	return out;
}

export interface TownRemotes {
	request: RemoteFunction;
	notice: RemoteEvent;
}

function ensure<C extends "RemoteEvent" | "RemoteFunction">(folder: Folder, name: string, className: C): Instances[C] {
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

/** SERVER ONLY: creates (or reuses) the town remotes */
export function createTownRemotes(): TownRemotes {
	const storage = game.GetService("ReplicatedStorage");
	let folder = storage.FindFirstChild(TOWN_NET_FOLDER);
	if (folder === undefined || !folder.IsA("Folder")) {
		folder?.Destroy();
		const created = new Instance("Folder");
		created.Name = TOWN_NET_FOLDER;
		created.Parent = storage;
		folder = created;
	}
	const f = folder as Folder;
	return {
		request: ensure(f, REMOTE_TOWN_REQUEST, "RemoteFunction"),
		notice: ensure(f, REMOTE_TOWN_NOTICE, "RemoteEvent"),
	};
}

/** CLIENT: waits for the town remotes (undefined when they do not show up within `timeout` s). Yields. */
export function waitTownRemotes(timeout: number): TownRemotes | undefined {
	const storage = game.GetService("ReplicatedStorage");
	const folder = storage.WaitForChild(TOWN_NET_FOLDER, timeout);
	if (folder === undefined) return undefined;
	const request = folder.WaitForChild(REMOTE_TOWN_REQUEST, timeout);
	const notice = folder.WaitForChild(REMOTE_TOWN_NOTICE, timeout);
	if (request === undefined || notice === undefined || !request.IsA("RemoteFunction") || !notice.IsA("RemoteEvent")) {
		return undefined;
	}
	return { request, notice };
}
