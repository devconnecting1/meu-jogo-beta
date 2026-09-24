/*
 * The rules of moving a survivor to a town of their own (docs/MULTIPLAYER.md §7.4, docs/DESIGN_RULES.md MP-24). Pure:
 * no Instance, no service, no clock of its own -- server/match/travel.ts and server/match/matchHost.ts feed it, and
 * tools/test-match.mjs drives it directly.
 *
 *   1. THE OFFER (P0-1). Difficulty follows the WORLD's day (server/sim/waves.ts `refreshPopulation`, MP-20), so a new
 *      player dropped by matchmaking into a public town on day 23 meets day 23's horde with a starter knife. The server
 *      offers them, once, a town of their own on day 1 -- never moves them without the answer (`freshTownOffer`).
 *   2. THE TICKET. What travels with the teleport (TeleportOptions:SetTeleportData) is read back by the destination
 *      through Player:GetJoinData(), which the docs warn comes THROUGH THE CLIENT: nothing in it may decide anything
 *      of value. It carries only the route and the analytics funnel's id; the destination checks the source place and
 *      the owner before it even logs the arrival (`readTicket`). No day, no seed, no access code, ever.
 *   3. THE GATES. A teleport costs a ReserveServerAsync and a TeleportAsync: one trip in flight per player, a gap
 *      between two, a few per ten minutes (`TripGate`), and a budget of reservations for the whole server
 *      (`ReserveBudget`). The remote itself is flood-guarded (`MessageGate`).
 *   4. THE AUDIT. Every request, refusal, attempt, retry and outcome is a row of a bounded ring (`TripAudit`) and a
 *      line of the server log -- ids and fixed words only, like the admin's log.
 */
import type { ServerKind, TripFailure } from "shared/match/matchWire";

// ---------------------------------------------------------------- 1. the offer

/** a town on these days is gentle for anyone (the first four nights never rain, day 5 is still the early table) */
export const OFFER_MIN_DAY = 5;
/** how far past the player's own record a town may be before it is "far harder than anything you survived" */
export const OFFER_MARGIN = 4;
/** an offer is answered within this long, or it lapses (seconds) */
export const OFFER_TTL_S = 600;

export interface OfferInput {
	kind: ServerKind;
	/** the session's load status (server/main.server.ts): "ok", "new", "unavailable" or "error" */
	status: string;
	/** the player's record, in days of one life (`save.bestDay`, ≥ 1) */
	bestDay: number;
	/** the save says this life is over (MP-21): the choice comes first, and it is made here */
	runOver: boolean;
	/** the world's day right now (undefined: no world is running) */
	worldDay: number | undefined;
	/** the player followed a friend in (Player.FollowUserId ≠ 0): they came for that town, not for any town */
	followed: boolean;
}

/**
 * The threshold of the offer: a town strictly past max(OFFER_MIN_DAY, bestDay + OFFER_MARGIN). A new save's record is
 * day 1, so a new player is asked in any town past day 5; a survivor whose record is day 30 is never asked below 35.
 */
export function offerThreshold(bestDay: number): number {
	return math.max(OFFER_MIN_DAY, math.max(1, math.floor(bestDay)) + OFFER_MARGIN);
}

/**
 * Should this player be offered a fresh town of their own, as they join (P0-1)? Only on a public server (a solo town
 * is theirs already; a private server is somebody's chosen company; Studio counts as public so a playtest can show
 * the card), only for a save the server really read (a read-only session's blank save would ask a veteran), never to
 * a dead survivor (MP-21's choice is made where the death is) nor to one who followed a friend in.
 */
export function freshTownOffer(input: OfferInput): boolean {
	if (input.kind !== "public" && input.kind !== "studio") return false;
	if (input.status === "error") return false;
	if (input.runOver || input.followed) return false;
	const day = input.worldDay;
	if (day === undefined || !(day > 0)) return false;
	return day > offerThreshold(input.bestDay);
}

// ---------------------------------------------------------------- 2. the ticket (TeleportData)

export type TripRoute = "solo" | "offer";

/** the version of the ticket's shape; a destination only reads its own */
export const TICKET_VERSION = 1;

/** what goes into TeleportOptions:SetTeleportData: a table of four plain fields */
export interface TownTicket {
	pz: number;
	route: TripRoute;
	/** the NewTown funnel's session id (a GUID drawn by the origin server) */
	trip: string;
	/** the UserId the ticket was issued to */
	owner: number;
}

export function makeTicket(route: TripRoute, trip: string, owner: number): TownTicket {
	return { pz: TICKET_VERSION, route, trip, owner };
}

/** a GUID as HttpService:GenerateGUID writes it (with or without braces): 8-64 of [0-9A-Za-z-{}] */
export function isTripId(v: unknown): v is string {
	if (!typeIs(v, "string")) return false;
	const n = v.size();
	if (n < 8 || n > 64) return false;
	for (let i = 1; i <= n; i++) {
		const c = v.sub(i, i);
		const ok =
			(c >= "0" && c <= "9") ||
			(c >= "a" && c <= "z") ||
			(c >= "A" && c <= "Z") ||
			c === "-" ||
			c === "{" ||
			c === "}";
		if (!ok) return false;
	}
	return true;
}

export type TicketReading =
	| { ok: true; route: TripRoute; trip: string }
	| { ok: false; why: "none" | "foreign" | "malformed" | "owner" | "server" };

/**
 * The destination's reading of Player:GetJoinData() (only the fields it needs). The engine reference: check the source
 * place against the ones you trust before reading TeleportData, and never use it for anything of value (it passes
 * through the client). Here it can only ever do one thing -- log the NewTown funnel's arrival for its own player -- and
 * even that needs: a teleport from THIS place, into a solo town, a ticket of our shape and version, issued to the
 * player who carries it. `joinData` is whatever GetJoinData returned (a table, or nothing).
 */
export function readTicket(joinData: unknown, placeId: number, userId: number, kind: ServerKind): TicketReading {
	if (!typeIs(joinData, "table")) return { ok: false, why: "none" };
	const join = joinData as Record<string, unknown>;
	const data = join.TeleportData;
	if (data === undefined) return { ok: false, why: "none" };
	if (join.SourcePlaceId !== placeId) return { ok: false, why: "foreign" };
	if (!typeIs(data, "table")) return { ok: false, why: "malformed" };
	const t = data as Record<string, unknown>;
	if (t.pz !== TICKET_VERSION) return { ok: false, why: "malformed" };
	const route = t.route === "solo" ? "solo" : t.route === "offer" ? "offer" : undefined;
	if (route === undefined || !isTripId(t.trip)) return { ok: false, why: "malformed" };
	if (!typeIs(t.owner, "number") || t.owner !== userId) return { ok: false, why: "owner" };
	// a ticket is only ever issued for a reserved town: carried anywhere else it is somebody's stale join data
	if (kind !== "solo") return { ok: false, why: "server" };
	return { ok: true, route, trip: t.trip };
}

// ---------------------------------------------------------------- 3. the gates

/** shortest gap between two accepted trips of one player (s) */
export const TRIP_GAP_S = 10;
/** at most this many accepted trips per player in TRIP_WINDOW_S */
export const TRIPS_PER_WINDOW = 4;
export const TRIP_WINDOW_S = 600;

/** per player (by UserId, so a rejoin does not reset it): spacing and a windowed count of ACCEPTED trips */
export class TripGate {
	private readonly times = new Map<number, Array<number>>();

	/** true (and counted) when `userId` may start a trip at `now` */
	take(userId: number, now: number): boolean {
		const list = this.times.get(userId) ?? [];
		const kept = list.filter(t => now - t < TRIP_WINDOW_S && t <= now);
		const last = kept.size() > 0 ? kept[kept.size() - 1] : -math.huge;
		if (now - last < TRIP_GAP_S || kept.size() >= TRIPS_PER_WINDOW) {
			this.times.set(userId, kept);
			return false;
		}
		kept.push(now);
		this.times.set(userId, kept);
		return true;
	}

	/** a trip that never reached a teleport (refused by the platform before it left) gives its gap back */
	release(userId: number, at: number): void {
		const list = this.times.get(userId);
		if (list === undefined) return;
		const i = list.indexOf(at);
		if (i >= 0) list.remove(i);
	}
}

/** reservations the whole server may make: a burst, refilled per minute (a coordinated flood stops here) */
export const RESERVE_BURST = 10;
export const RESERVES_PER_MINUTE = 20;

export class ReserveBudget {
	private tokens = RESERVE_BURST;
	private at: number | undefined;

	take(now: number): boolean {
		if (this.at !== undefined && now > this.at) {
			this.tokens = math.min(RESERVE_BURST, this.tokens + ((now - this.at) * RESERVES_PER_MINUTE) / 60);
		}
		this.at = now;
		if (this.tokens < 1) return false;
		this.tokens -= 1;
		return true;
	}
}

/** Match messages a player may send in MESSAGE_WINDOW_S; past it every message is dropped (and counted) */
export const MESSAGES_PER_WINDOW = 8;
export const MESSAGE_WINDOW_S = 10;

export class MessageGate {
	private readonly seen = new Map<number, { start: number; count: number }>();
	/** messages dropped by the gate or malformed, since boot (the audit's counters) */
	dropped = 0;
	malformed = 0;

	take(userId: number, now: number): boolean {
		let w = this.seen.get(userId);
		if (w === undefined || now - w.start >= MESSAGE_WINDOW_S || now < w.start) {
			w = { start: now, count: 0 };
			this.seen.set(userId, w);
		}
		w.count += 1;
		if (w.count > MESSAGES_PER_WINDOW) {
			this.dropped += 1;
			return false;
		}
		return true;
	}

	forget(userId: number): void {
		this.seen.delete(userId);
	}
}

// ---------------------------------------------------------------- 4. the audit

/** one row: ids and fixed words only (never a name, never the access code) */
export interface TripAuditRow {
	/** the server clock (os.clock) */
	t: number;
	userId: number;
	route: TripRoute | "-";
	/** "asked", "refused", "reserved", "sent", "retry", "failed", "left", "offered", "stayed", "arrived", "ticket" */
	what: string;
	/** a refusal, a failure, a TeleportResult's name or a ticket's reading */
	detail: string;
}

export const AUDIT_ROWS = 100;

/** the last AUDIT_ROWS rows, oldest first; each one is also a line of the server log (`log`) */
export class TripAudit {
	readonly rows = new Array<TripAuditRow>();
	private readonly log: (line: string) => void;

	constructor(log: (line: string) => void) {
		this.log = log;
	}

	add(row: TripAuditRow): void {
		this.rows.push(row);
		while (this.rows.size() > AUDIT_ROWS) this.rows.remove(0);
		const detail = row.detail !== "" ? ` ${row.detail}` : "";
		this.log(`[PZ-MATCH] ${row.userId} ${row.route} ${row.what}${detail}`);
	}

	count(what: string): number {
		let n = 0;
		for (const r of this.rows) if (r.what === what) n += 1;
		return n;
	}
}

// ---------------------------------------------------------------- the platform's answers

/** Enum.TeleportResult by name (an EnumItem's Name, or the string a test passes): the last dotted part */
export function resultName(v: unknown): string {
	let s: string;
	if (typeIs(v, "EnumItem")) s = v.Name;
	else if (typeIs(v, "string")) s = v;
	else return "Unknown";
	let at = 0;
	for (let i = 1; i <= s.size(); i++) if (s.sub(i, i) === ".") at = i;
	const name = at > 0 ? s.sub(at + 1) : s;
	return name !== "" ? name : "Unknown";
}

/** how a TeleportInitFailed is answered (the docs' SafeTeleport pattern, plus a new reservation for a dead server) */
export type InitAnswer =
	{ kind: "ignore" } | { kind: "retry"; wait: number; reserve: boolean } | { kind: "fail"; why: TripFailure };

/** the docs' own waits: 15 s after Flooded, 1 s after Failure */
export const FLOOD_WAIT_S = 15;
export const RETRY_WAIT_S = 1;

export function initAnswer(result: string): InitAnswer {
	if (result === "IsTeleporting") return { kind: "ignore" };
	if (result === "Flooded") return { kind: "retry", wait: FLOOD_WAIT_S, reserve: false };
	if (result === "Failure") return { kind: "retry", wait: RETRY_WAIT_S, reserve: false };
	// the reserved server is gone before the player got there: a new one, once
	if (result === "GameEnded" || result === "GameNotFound") {
		return { kind: "retry", wait: RETRY_WAIT_S, reserve: true };
	}
	if (result === "GameFull") return { kind: "fail", why: "full" };
	if (result === "Unauthorized") return { kind: "fail", why: "denied" };
	return { kind: "fail", why: "teleport" };
}
