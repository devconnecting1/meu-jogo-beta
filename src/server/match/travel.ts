/*
 * One survivor's trip to a town of their own (docs/MULTIPLAYER.md §7.4, the P0-2 "Play solo" and the P0-1 offer's
 * "New town"): a reserved server, reserved HERE, and a teleport the platform may refuse. Pure: TeleportService is the
 * `TravelPort` server/match/matchHost.ts plugs in, and every wait is a `delay` (task.delay in the game, a timer list
 * in tools/test-match.mjs), so the whole state machine runs under Node.
 *
 *   request ── refused? (Studio, a solo town, loading, in the city, dead, one in flight, the gates) ──> "refused"
 *      │
 *      ▼  (next frame: the remote's thread returns at once)
 *   prepare ── the body banked, the save written with its lock KEPT (server/main.server.ts): the destination's load
 *      │        waits for the lock that the leave releases; a teleport that fails leaves a session that still owns it
 *      ▼
 *   reserve ── TeleportService:ReserveServerAsync(game.PlaceId), up to RESERVE_TRIES; the access code stays here
 *      │
 *      ▼
 *   teleport ─ TeleportService:TeleportAsync(game.PlaceId, {player}, ReservedServerAccessCode + the ticket), in pcall,
 *      │        up to TELEPORT_TRIES a second apart (the docs' SafeTeleport)
 *      ▼
 *   sent ───── TeleportInitFailed: Flooded waits 15 s, Failure 1 s, a server that ended gets a new reservation, the rest
 *               fail -- at most INIT_ROUNDS rounds; no word within ARRIVE_TIMEOUT_S fails it too. Leaving is success.
 *
 * NEVER MID-RUN WITHOUT CONSENT: a trip starts only from the player's own request, only from the lobby, and every retry
 * asks again whether the player is still in the lobby -- one who walked into the city meanwhile has their trip called
 * off ("cancelled"), never a teleport out of a fight.
 */
import type { MatchNotice, ServerKind, TripFailure, TripRefusal } from "shared/match/matchWire";
import {
	InitAnswer,
	ReserveBudget,
	TownTicket,
	TripAudit,
	TripGate,
	TripRoute,
	initAnswer,
	makeTicket,
	resultName,
} from "./rules";

/** ReserveServerAsync attempts per reservation, and the waits between them (s) */
export const RESERVE_TRIES = 3;
export const RESERVE_WAITS = [1, 2];
/** TeleportAsync attempts per round, a second apart (the docs' SafeTeleport: pcall and retry) */
export const TELEPORT_TRIES = 3;
export const TELEPORT_WAIT_S = 1;
/** TeleportInitFailed rounds a trip may take before it gives up */
export const INIT_ROUNDS = 3;
/** a trip sent this long ago whose player is still here, with no TeleportInitFailed, is given up (s) */
export const ARRIVE_TIMEOUT_S = 45;

/** TeleportService, as far as a trip needs it (server/match/matchHost.ts wraps each call in pcall) */
export interface TravelPort {
	/** ReserveServerAsync(game.PlaceId): the access code, or why not */
	reserve(): { ok: true; code: string } | { ok: false; err: string };
	/** TeleportAsync(game.PlaceId, {player}, options: ReservedServerAccessCode = code, SetTeleportData(ticket)) */
	teleport(player: Player, code: string, ticket: TownTicket): { ok: true } | { ok: false; err: string };
}

/** what a trip reports, for analytics (server/analytics/events.ts) */
export interface TravelEvents {
	/** a request accepted: the NewTown funnel's step 1 */
	asked(player: Player, trip: TripView): void;
	/** TeleportAsync went through: step 2 */
	sent(player: Player, trip: TripView): void;
	/** the trip ended with the player still here */
	failed(player: Player, trip: TripView, stage: "Reserve" | "Teleport" | "Init", why: TripFailure): void;
}

export interface TripView {
	id: string;
	route: TripRoute;
	/** TeleportAsync calls and init rounds so far */
	attempts: number;
}

export interface TravelHost {
	kind: ServerKind;
	/** undefined: TeleportService could not be had */
	port: TravelPort | undefined;
	clock: () => number;
	/** task.delay */
	delay: (seconds: number, fn: () => void) => void;
	/** a funnel id (HttpService:GenerateGUID) */
	newId: () => string;
	/** why this player may not leave right now: still loading, in the city, dead -- or undefined */
	blocker: (player: Player) => TripRefusal | undefined;
	/** the player is still connected to this server */
	connected: (player: Player) => boolean;
	/** banks the body and writes the save, keeping the lock (it yields in the game) */
	prepare: (player: Player) => void;
	notify: (player: Player, notice: MatchNotice) => void;
	events: TravelEvents;
	audit: TripAudit;
	/** a fixed sentence for the Error Report, the details in the log line after it (docs/ANALYTICS.md §10) */
	warn: (what: string, detail: string) => void;
}

type TripState = "preparing" | "reserving" | "teleporting" | "sent" | "waiting";

interface Trip extends TripView {
	player: Player;
	userId: number;
	state: TripState;
	/** the access code of the reserved town (never sent anywhere but TeleportAsync) */
	code?: string;
	reserves: number;
	tries: number;
	rounds: number;
	/** bumped by every transition, so a timer set for an earlier one does nothing */
	serial: number;
	/** when the gate counted it (a trip the platform never sent gives the gap back) */
	gateAt: number;
	everSent: boolean;
	/** a TeleportInitFailed that arrived while TeleportAsync was still yielding: answered as soon as it returns */
	earlyInit?: { result: string; message: unknown };
}

/** the TeleportInitFailed kept while TeleportAsync yielded, taken (once) */
function takeEarlyInit(trip: Trip): { result: string; message: unknown } | undefined {
	const early = trip.earlyInit;
	trip.earlyInit = undefined;
	return early;
}

/** what leaves this module about a trip: never the access code */
function viewOf(trip: Trip): TripView {
	return { id: trip.id, route: trip.route, attempts: trip.attempts };
}

export class TownTravel {
	private readonly host: TravelHost;
	private readonly trips = new Map<Player, Trip>();
	private readonly gate = new TripGate();
	private readonly budget = new ReserveBudget();

	constructor(host: TravelHost) {
		this.host = host;
	}

	/** a trip in flight for this player */
	inFlight(player: Player): boolean {
		return this.trips.has(player);
	}

	/**
	 * The player asked for a town of their own (`route`: the Play solo button, or the offer's New town). Answers the
	 * refusal, or undefined when the trip started (it goes on in its own thread from the next frame).
	 */
	request(player: Player, route: TripRoute): TripRefusal | undefined {
		const host = this.host;
		const refusal = this.refusalOf(player);
		if (refusal !== undefined) {
			this.refuse(player, route, refusal);
			return refusal;
		}
		const now = host.clock();
		if (!this.gate.take(player.UserId, now)) {
			this.refuse(player, route, "rate");
			return "rate";
		}
		// the whole server's reservations (a trip's own retries are bounded by RESERVE_TRIES and INIT_ROUNDS)
		if (!this.budget.take(now)) {
			this.gate.release(player.UserId, now);
			this.refuse(player, route, "rate");
			return "rate";
		}
		const trip: Trip = {
			id: host.newId(),
			route,
			attempts: 0,
			player,
			userId: player.UserId,
			state: "preparing",
			reserves: 0,
			tries: 0,
			rounds: 0,
			serial: 0,
			gateAt: now,
			everSent: false,
		};
		this.trips.set(player, trip);
		this.row(trip, "asked", "");
		host.events.asked(player, viewOf(trip));
		host.notify(player, { k: "trip", s: "start" });
		const serial = trip.serial;
		host.delay(0, () => this.begin(trip, serial));
		return undefined;
	}

	private refusalOf(player: Player): TripRefusal | undefined {
		const host = this.host;
		if (host.kind === "studio") return "studio";
		if (host.kind === "solo") return "solo";
		if (host.port === undefined) return "unavailable";
		if (this.trips.has(player)) return "busy";
		return host.blocker(player);
	}

	private refuse(player: Player, route: TripRoute, why: TripRefusal): void {
		this.host.audit.add({ t: this.host.clock(), userId: player.UserId, route, what: "refused", detail: why });
		this.host.notify(player, { k: "refused", why });
	}

	private row(trip: Trip, what: string, detail: string): void {
		this.host.audit.add({ t: this.host.clock(), userId: trip.userId, route: trip.route, what, detail });
	}

	/** still the live trip, at the same step it was when the timer was set */
	private current(trip: Trip, serial: number): boolean {
		return this.trips.get(trip.player) === trip && trip.serial === serial;
	}

	/** the player walked into the city (or left) since the request: nobody is teleported out of a run */
	private stillHere(trip: Trip): boolean {
		if (!this.host.connected(trip.player)) return false;
		const blocker = this.host.blocker(trip.player);
		return blocker === undefined;
	}

	private begin(trip: Trip, serial: number): void {
		if (!this.current(trip, serial)) return;
		if (!this.stillHere(trip)) {
			this.fail(trip, "Teleport", "cancelled", "left the lobby");
			return;
		}
		// the save goes out first, with the lock kept (server/main.server.ts `prepare`): a throw there is the session's
		// problem, never the trip's -- the leave's own final write still runs
		const [ok, err] = pcall(() => this.host.prepare(trip.player));
		if (!ok) this.host.warn("a save before a teleport failed", tostring(err));
		if (!this.current(trip, serial)) return;
		this.reserve(trip);
	}

	private reserve(trip: Trip): void {
		const host = this.host;
		const port = host.port;
		if (port === undefined) {
			this.fail(trip, "Reserve", "reserve", "no TeleportService");
			return;
		}
		trip.state = "reserving";
		trip.serial += 1;
		trip.reserves += 1;
		const reserving = trip.serial;
		const res = port.reserve();
		// ReserveServerAsync yields: the player may have left meanwhile
		if (!this.current(trip, reserving)) return;
		if (!res.ok) {
			this.row(trip, "reserve failed", `attempt ${trip.reserves}`);
			if (trip.reserves < RESERVE_TRIES) {
				const serial = trip.serial;
				host.delay(RESERVE_WAITS[trip.reserves - 1] ?? 2, () => {
					if (this.current(trip, serial)) this.reserve(trip);
				});
				return;
			}
			this.fail(trip, "Reserve", "reserve", res.err);
			return;
		}
		trip.code = res.code;
		trip.tries = 0;
		this.row(trip, "reserved", "");
		this.teleport(trip);
	}

	private teleport(trip: Trip): void {
		const host = this.host;
		const port = host.port;
		const code = trip.code;
		if (port === undefined || code === undefined) {
			this.fail(trip, "Teleport", "teleport", "no access code");
			return;
		}
		if (!this.stillHere(trip)) {
			this.fail(trip, "Teleport", "cancelled", "left the lobby");
			return;
		}
		trip.state = "teleporting";
		trip.serial += 1;
		trip.tries += 1;
		trip.attempts += 1;
		trip.earlyInit = undefined;
		const res = port.teleport(trip.player, code, makeTicket(trip.route, trip.id, trip.userId));
		if (!res.ok) {
			this.row(trip, "teleport failed", `attempt ${trip.tries}`);
			if (trip.tries < TELEPORT_TRIES) {
				const serial = trip.serial;
				host.delay(TELEPORT_WAIT_S, () => {
					if (this.current(trip, serial)) this.teleport(trip);
				});
				return;
			}
			this.fail(trip, "Teleport", "teleport", res.err);
			return;
		}
		trip.state = "sent";
		trip.serial += 1;
		this.row(trip, "sent", `attempt ${trip.attempts}`);
		if (!trip.everSent) {
			trip.everSent = true;
			host.events.sent(trip.player, viewOf(trip));
		}
		host.notify(trip.player, { k: "trip", s: "going" });
		const serial = trip.serial;
		// (read through a function: TypeScript cannot know TeleportAsync's yield let `initFailed` write it)
		const early = takeEarlyInit(trip);
		if (early !== undefined) {
			// the platform answered while TeleportAsync was still yielding: that answer counts now
			this.initFailed(trip.player, early.result, early.message);
			return;
		}
		host.delay(ARRIVE_TIMEOUT_S, () => {
			// still here, no TeleportInitFailed, nothing else happened since: it is not going to happen
			if (this.current(trip, serial) && this.host.connected(trip.player)) {
				this.fail(trip, "Init", "timeout", "no arrival and no TeleportInitFailed");
			}
		});
	}

	/** TeleportService.TeleportInitFailed for `player` (result: an Enum.TeleportResult or its name) */
	initFailed(player: Player, result: unknown, message: unknown): void {
		const trip = this.trips.get(player);
		const name = resultName(result);
		if (trip !== undefined && trip.state === "teleporting") {
			// TeleportAsync has not returned yet (it yields): keep the answer for when it does
			trip.earlyInit = { result: name, message };
			return;
		}
		if (trip === undefined || trip.state !== "sent") {
			// a teleport this module did not send (or one it already gave up on): noted, nothing else
			this.host.audit.add({
				t: this.host.clock(),
				userId: player.UserId,
				route: "-",
				what: "init",
				detail: name,
			});
			return;
		}
		const answer: InitAnswer = initAnswer(name);
		this.row(trip, "init failed", name);
		if (answer.kind === "ignore") return;
		trip.rounds += 1;
		if (answer.kind === "fail") {
			this.fail(trip, "Init", answer.why, `${name}: ${tostring(message)}`);
			return;
		}
		if (trip.rounds > INIT_ROUNDS) {
			this.fail(trip, "Init", name === "Flooded" ? "flooded" : "teleport", `${name} after ${INIT_ROUNDS} rounds`);
			return;
		}
		trip.state = "waiting";
		trip.serial += 1;
		const serial = trip.serial;
		this.row(trip, "retry", name);
		this.host.notify(player, { k: "trip", s: "retry" });
		this.host.delay(answer.wait, () => {
			if (!this.current(trip, serial)) return;
			trip.tries = 0;
			if (answer.reserve) {
				trip.code = undefined;
				trip.reserves = 0;
				this.reserve(trip);
			} else {
				this.teleport(trip);
			}
		});
	}

	/** the player left this server: a trip that was sent arrived (as far as this server can tell) */
	playerLeft(player: Player): void {
		const trip = this.trips.get(player);
		if (trip === undefined) return;
		this.trips.delete(player);
		this.row(trip, trip.everSent ? "left" : "left before the teleport", "");
	}

	private fail(trip: Trip, stage: "Reserve" | "Teleport" | "Init", why: TripFailure, detail: string): void {
		if (this.trips.get(trip.player) !== trip) return;
		this.trips.delete(trip.player);
		trip.serial += 1;
		// a trip the platform never sent anywhere does not count against the player's gap (they may try again at once)
		if (!trip.everSent) this.gate.release(trip.userId, trip.gateAt);
		this.row(trip, "failed", why);
		if (why !== "cancelled") {
			this.host.warn("a trip to a town of one's own failed", `${why} at ${stage}: ${detail}`);
		}
		this.host.events.failed(trip.player, viewOf(trip), stage, why);
		if (this.host.connected(trip.player)) this.host.notify(trip.player, { k: "trip", s: "failed", why });
	}
}
