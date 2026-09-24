/*
 * Where a survivor plays (docs/MULTIPLAYER.md §7.4, docs/DESIGN_RULES.md MP-25): the server kind, and the one remote
 * that moves a survivor to a town of their own. Shared by server/match/* and client/net/matchClient.ts; pure.
 *
 *   Match  RemoteEvent in ReplicatedStorage/Net
 *     C→S  { k: "solo" }                     Play solo (the Survivor screen): a town of my own
 *          { k: "offer", yes: boolean }       the answer to the server's fresh-town offer (P0-1)
 *     S→C  { k: "offer", worldDay, bestDay }  "This town is on Day N": the lobby card
 *          { k: "trip", s, why? }             where the trip stands: start, going, retry, failed
 *          { k: "refused", why }              why the request was not even started
 *
 * What the client may say is TWO things, both a yes/no: it never names a place, a server, an access code, a day or a
 * seed -- the server picks the place (its own), reserves the server itself and keeps the access code to itself (MP-00).
 * A message that is not exactly one of those shapes is dropped and counted (server/match/matchHost.ts).
 */

/** the remote, inside the Net folder of shared/net/net.ts */
export const REMOTE_MATCH = "Match";

/**
 * The kind of server this is, read ONCE at boot from DataModel.PrivateServerId / PrivateServerOwnerId (the engine
 * reference, "Detecting Server Type"): the kind of a server never changes while it exists (MP-20).
 *   public   matchmaking fills it (PrivateServerId "")
 *   solo     a reserved server: only a teleport with its access code gets in -- Play solo, the fresh-town offer
 *   private  a private (VIP) server: PrivateServerOwnerId is the owner's UserId
 *   studio   a Studio playtest (PrivateServerId "" like a public one, and no TeleportService there)
 */
export type ServerKind = "public" | "solo" | "private" | "studio";
export const SERVER_KINDS: ReadonlyArray<ServerKind> = ["public", "solo", "private", "studio"];

/** the Workspace attribute the server publishes its kind under, for the lobby (it replicates on its own) */
export const SERVER_KIND_ATTRIBUTE = "pz_server_kind";

export function serverKindOf(privateServerId: string, privateServerOwnerId: number, studio: boolean): ServerKind {
	if (studio) return "studio";
	if (privateServerId === "") return "public";
	return privateServerOwnerId !== 0 ? "private" : "solo";
}

/** the attribute's value as a kind (anything else -- an older server, no attribute -- is undefined) */
export function readServerKind(v: unknown): ServerKind | undefined {
	if (!typeIs(v, "string")) return undefined;
	for (const k of SERVER_KINDS) if (k === v) return k;
	return undefined;
}

/**
 * Play solo is offered from every server but a solo town itself (you are already alone there). In Studio the button
 * is there too: pressing it explains that Studio cannot teleport (the engine: TeleportService does not run in a
 * playtest), instead of the button silently missing.
 */
export function playSoloFrom(kind: ServerKind | undefined): boolean {
	return kind === "public" || kind === "private" || kind === "studio";
}

// ---------------------------------------------------------------- C→S

export type MatchRequest = { k: "solo" } | { k: "offer"; yes: boolean };

/** the only two shapes the server reads; anything else is undefined (dropped and counted) */
export function readMatchRequest(raw: unknown): MatchRequest | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const t = raw as Record<string, unknown>;
	if (t.k === "solo") return { k: "solo" };
	if (t.k === "offer" && typeIs(t.yes, "boolean")) return { k: "offer", yes: t.yes };
	return undefined;
}

// ---------------------------------------------------------------- S→C

/** why a trip ended without the player leaving (the lobby's words: client/net/matchClient.ts) */
export type TripFailure = "reserve" | "teleport" | "full" | "flooded" | "denied" | "timeout" | "cancelled";
export const TRIP_FAILURES: ReadonlyArray<TripFailure> = [
	"reserve",
	"teleport",
	"full",
	"flooded",
	"denied",
	"timeout",
	"cancelled",
];

/**
 * Why a request was not started at all. `danger`: this server keeps the survivor's LIVING body where they left the
 * city, and that spot is not safe -- a zombie within the safe-spawn radius, or a hit taken moments before leaving
 * (server/net/mpHost.ts `keptInDanger`). A trip then would be a free, instant escape from a fight (review H1).
 */
export type TripRefusal =
	| "studio"
	| "unavailable"
	| "rate"
	| "busy"
	| "dead"
	| "danger"
	| "inWorld"
	| "solo"
	| "loading"
	| "noOffer"
	| "joining";
export const TRIP_REFUSALS: ReadonlyArray<TripRefusal> = [
	"studio",
	"unavailable",
	"rate",
	"busy",
	"dead",
	"danger",
	"inWorld",
	"solo",
	"loading",
	"noOffer",
	// a join from the lobby's Servers list is in flight (MP-26, server/match/serverList.ts): one teleport at a time
	"joining",
];

export type TripStage = "start" | "going" | "retry" | "failed";
const TRIP_STAGES: ReadonlyArray<TripStage> = ["start", "going", "retry", "failed"];

export type MatchNotice =
	| { k: "offer"; worldDay: number; bestDay: number }
	| { k: "trip"; s: TripStage; why?: TripFailure }
	| { k: "refused"; why: TripRefusal };

function oneOf<T extends string>(v: unknown, set: ReadonlyArray<T>): T | undefined {
	if (!typeIs(v, "string")) return undefined;
	for (const s of set) if (s === v) return s;
	return undefined;
}

function wholeDay(v: unknown): number | undefined {
	return typeIs(v, "number") && v === v && v % 1 === 0 && v >= 1 && v <= 65535 ? v : undefined;
}

/** the client's reading of a server notice (the server is trusted, but a shape it does not know is ignored) */
export function readMatchNotice(raw: unknown): MatchNotice | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const t = raw as Record<string, unknown>;
	if (t.k === "offer") {
		const worldDay = wholeDay(t.worldDay);
		const bestDay = wholeDay(t.bestDay);
		return worldDay !== undefined && bestDay !== undefined ? { k: "offer", worldDay, bestDay } : undefined;
	}
	if (t.k === "trip") {
		const s = oneOf(t.s, TRIP_STAGES);
		if (s === undefined) return undefined;
		const why = oneOf(t.why, TRIP_FAILURES);
		return why !== undefined ? { k: "trip", s, why } : { k: "trip", s };
	}
	if (t.k === "refused") {
		const why = oneOf(t.why, TRIP_REFUSALS);
		return why !== undefined ? { k: "refused", why } : undefined;
	}
	return undefined;
}
