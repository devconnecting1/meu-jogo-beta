/*
 * Where a survivor plays: the server's kind, the fresh-town offer (P0-1), Play solo (P0-2) and the matchmaking
 * attributes (docs/MULTIPLAYER.md §7.4, docs/DESIGN_RULES.md MP-24). SERVER ONLY: the one file of server/match/ that
 * touches Roblox -- TeleportService, MatchmakingService, the Match remote, Player:GetJoinData -- and hands every
 * decision to the pure modules beside it (rules.ts, travel.ts, matchmaking.ts).
 *
 * server/main.server.ts starts it once, after the sessions and the MP host, and lends it what only it knows: the
 * session (loaded? its status and live save), the world's day, who stands in the city and the save-before-teleport.
 * It never reads or writes the DataStore itself, and it never moves anybody the player did not ask to move.
 *
 * APIs (Context7 `/websites/create_roblox`, read 2026-09-24; types from @rbxts/types):
 *   - DataModel.PrivateServerId / PrivateServerOwnerId: "" and 0 on a public server; a reserved server has an id and
 *     owner 0; a private (VIP) one has its owner's UserId ("Detecting Server Type").
 *   - TeleportService:ReserveServerAsync(placeId) -> (accessCode, privateServerId); TeleportAsync(placeId, players,
 *     TeleportOptions) with ReservedServerAccessCode (mutually exclusive with ShouldReserveServer and
 *     ServerInstanceId); server only; pcall and retry, and TeleportInitFailed for what fails after the call returned
 *     ("Handle failed teleports", the SafeTeleport module); TeleportService does not run in a Studio playtest.
 *   - TeleportOptions:SetTeleportData -> Player:GetJoinData().TeleportData on arrival, with SourcePlaceId: verify the
 *     source place, and never trust it with anything of value (it passes through the client).
 *   - MatchmakingService:SetServerAttribute(name, value) -> (success, errorMessage); InitializeServerAttributesForStudio
 *     for a playtest.
 */
import { GAME_NAME } from "shared/module";
import { NET_FOLDER } from "shared/net/net";
import type { PlayerSaveData } from "shared/game/save";
import {
	MatchNotice,
	REMOTE_MATCH,
	SERVER_KIND_ATTRIBUTE,
	ServerKind,
	TripRefusal,
	readMatchRequest,
	serverKindOf,
} from "shared/match/matchWire";
import * as Analytics from "../analytics/events";
import { MessageGate, OFFER_TTL_S, TownTicket, TripAudit, TripAuditRow, freshTownOffer, readTicket } from "./rules";
import { TownTravel, TravelPort } from "./travel";
import { ATTR_SURVIVORS, ATTR_WORLD_DAY, MatchmakingAttributes } from "./matchmaking";

const Players = game.GetService("Players");
const RunService = game.GetService("RunService");
const Workspace = game.GetService("Workspace");
const HttpService = game.GetService("HttpService");
const ReplicatedStorage = game.GetService("ReplicatedStorage");

/** how often the host looks at who finished loading (the offer, the arrival) and at the matchmaking numbers (s) */
const SCAN_S = 0.5;
const MATCHMAKING_S = 1;

/** what server/main.server.ts lends the host */
export interface MatchHostOptions {
	/** a connected player's session: undefined while it does not exist; `loaded` false while the save is read */
	sessionOf: (player: Player) => { loaded: boolean; status: string; save: PlayerSaveData } | undefined;
	/** the world's day, or undefined when no world runs (MP_PHASE 0) */
	worldDay: () => number | undefined;
	/** survivors standing, alive, in the city */
	survivors: () => number;
	/** the player has a body in the city (the lobby is where a trip may start) */
	inWorld: (player: Player) => boolean;
	/** dead as far as the server knows (MP-21: the choice is made here, before any trip) */
	isDead: (player: Player, save: PlayerSaveData) => boolean;
	/** banks the body and writes the save now, KEEPING the session lock (it yields) */
	prepare: (player: Player) => void;
}

export interface MatchHost {
	kind: ServerKind;
	/** the trips' audit ring (oldest first) and the remote's counters */
	audit(): ReadonlyArray<TripAuditRow>;
	counters(): { dropped: number; malformed: number; mmSent: number; mmRefused: number };
	/** the pure trip machine, for the tests */
	travel: TownTravel;
	stop(): void;
}

/** MatchmakingService:SetServerAttribute as the engine returns it (two values; @rbxts/types says `unknown`) */
interface MatchmakingCalls {
	SetServerAttribute(this: MatchmakingCalls, name: string, value: unknown): LuaTuple<[boolean, string | undefined]>;
	InitializeServerAttributesForStudio(this: MatchmakingCalls, attributes: object): LuaTuple<[boolean, unknown]>;
}

/** TeleportService:ReserveServerAsync returns (accessCode, privateServerId); @rbxts/types says `unknown` */
interface ReserveCall {
	ReserveServerAsync(this: ReserveCall, placeId: number): LuaTuple<[string, string]>;
}

function netFolder(): Folder {
	const existing = ReplicatedStorage.FindFirstChild(NET_FOLDER);
	if (existing !== undefined && existing.IsA("Folder")) return existing;
	if (existing !== undefined) existing.Destroy();
	const created = new Instance("Folder");
	created.Name = NET_FOLDER;
	created.Parent = ReplicatedStorage;
	return created;
}

function matchRemote(): RemoteEvent {
	const folder = netFolder();
	const existing = folder.FindFirstChild(REMOTE_MATCH);
	if (existing !== undefined && existing.IsA("RemoteEvent")) return existing;
	if (existing !== undefined) existing.Destroy();
	const created = new Instance("RemoteEvent");
	created.Name = REMOTE_MATCH;
	created.Parent = folder;
	return created;
}

/** the server's kind, read once (a read that fails reads as public: the conservative answer for every rule here) */
function readKind(): ServerKind {
	const [studioOk, studio] = pcall(() => RunService.IsStudio());
	const [idOk, id] = pcall(() => game.PrivateServerId);
	const [ownerOk, owner] = pcall(() => game.PrivateServerOwnerId);
	return serverKindOf(
		idOk && typeIs(id, "string") ? id : "",
		ownerOk && typeIs(owner, "number") ? owner : 0,
		studioOk && studio === true,
	);
}

/** TeleportService behind the port a trip uses, or undefined when it cannot be had */
function teleportPort(): { port: TravelPort; service: TeleportService } | undefined {
	const [ok, svc] = pcall(() => game.GetService("TeleportService"));
	if (!ok || svc === undefined) return undefined;
	const service = svc as TeleportService;
	const port: TravelPort = {
		reserve() {
			const [done, result] = pcall(() => {
				const [accessCode, serverId] = (service as unknown as ReserveCall).ReserveServerAsync(game.PlaceId);
				return { accessCode, serverId };
			});
			if (!done) return { ok: false, err: tostring(result) };
			const code = result.accessCode;
			if (!typeIs(code, "string") || code === "") return { ok: false, err: "no access code" };
			// the reserved server's id is only logged (the audit never carries the access code)
			print(`[${GAME_NAME}] reserved a town (private server ${tostring(result.serverId)})`);
			return { ok: true, code };
		},
		teleport(player: Player, code: string, ticket: TownTicket) {
			const [done, err] = pcall(() => {
				const options = new Instance("TeleportOptions");
				options.ReservedServerAccessCode = code;
				options.SetTeleportData(ticket);
				service.TeleportAsync(game.PlaceId, [player], options);
			});
			return done ? { ok: true } : { ok: false, err: tostring(err) };
		},
	};
	return { port, service };
}

export function startMatch(options: MatchHostOptions): MatchHost {
	const kind = readKind();
	pcall(() => Workspace.SetAttribute(SERVER_KIND_ATTRIBUTE, kind));
	const remote = matchRemote();
	const audit = new TripAudit(line => print(line));
	const messages = new MessageGate();
	const tp = teleportPort();

	const notify = (player: Player, notice: MatchNotice): void => {
		if (player.Parent === undefined) return;
		pcall(() => remote.FireClient(player, notice));
	};

	/** why this player may not leave now: the save still loading, a body in the city, a death to answer first */
	const blocker = (player: Player): TripRefusal | undefined => {
		const s = options.sessionOf(player);
		if (s === undefined || !s.loaded) return "loading";
		if (options.inWorld(player)) return "inWorld";
		if (options.isDead(player, s.save)) return "dead";
		return undefined;
	};

	const travel = new TownTravel({
		kind,
		port: tp?.port,
		clock: () => os.clock(),
		delay: (seconds, fn) => {
			task.delay(seconds, fn);
		},
		newId: () => HttpService.GenerateGUID(false),
		blocker,
		connected: player => player.Parent !== undefined,
		prepare: player => options.prepare(player),
		notify,
		audit,
		warn: (what, detail) => {
			warn(`[${GAME_NAME}] ${what}`);
			print(`[${GAME_NAME}] ${detail}`);
		},
		events: {
			asked(player, trip) {
				const s = options.sessionOf(player);
				if (s !== undefined) Analytics.townTrip(player, 1, trip.id, trip.route, options.worldDay(), s.save);
			},
			sent(player, trip) {
				Analytics.townTrip(player, 2, trip.id, trip.route);
			},
			failed(player, trip, stage, why) {
				Analytics.tripFailed(player, stage, why, trip.route, trip.attempts);
			},
		},
	});

	const conns = new Array<RBXScriptConnection>();
	if (tp !== undefined) {
		// what fails AFTER TeleportAsync returned (the docs: "the process can still fail at the last moment")
		conns.push(
			tp.service.TeleportInitFailed.Connect((player, result, message) =>
				travel.initFailed(player, result, message),
			),
		);
	}

	// ------------------------------------------------------------ the offer and the arrival, once per Player

	/** the players already looked at, and the offers standing (answered by the Match remote) */
	const examined = new Set<Player>();
	const offers = new Map<Player, { at: number; worldDay: number }>();

	const examine = (player: Player): void => {
		const s = options.sessionOf(player);
		if (s === undefined || !s.loaded) return;
		examined.add(player);
		const now = os.clock();
		if (kind === "solo") {
			// P0-2: a survivor arriving in a town of their own -- the funnel's last step, for the ticket's own player
			const [ok, join] = pcall(() => player.GetJoinData());
			const reading = readTicket(ok ? join : undefined, game.PlaceId, player.UserId, kind);
			if (reading.ok) {
				audit.add({ t: now, userId: player.UserId, route: reading.route, what: "arrived", detail: "" });
				Analytics.townTrip(player, 3, reading.trip, reading.route);
			} else {
				audit.add({ t: now, userId: player.UserId, route: "-", what: "ticket", detail: reading.why });
			}
			return;
		}
		const [followOk, follow] = pcall(() => player.FollowUserId);
		const worldDay = options.worldDay();
		const offered = freshTownOffer({
			kind,
			status: s.status,
			bestDay: s.save.bestDay,
			runOver: s.save.runOver,
			worldDay,
			followed: followOk && typeIs(follow, "number") && follow !== 0,
		});
		if (!offered || worldDay === undefined) return;
		const day = math.floor(worldDay);
		offers.set(player, { at: now, worldDay: day });
		audit.add({ t: now, userId: player.UserId, route: "offer", what: "offered", detail: `day ${day}` });
		Analytics.townOffered(player, day, s.save, s.status === "new");
		notify(player, { k: "offer", worldDay: day, bestDay: s.save.bestDay });
	};

	// ------------------------------------------------------------ what the client asks

	conns.push(
		remote.OnServerEvent.Connect((player, raw) => {
			const now = os.clock();
			if (!messages.take(player.UserId, now)) return;
			const req = readMatchRequest(raw);
			if (req === undefined) {
				messages.malformed += 1;
				return;
			}
			if (req.k === "solo") {
				travel.request(player, "solo");
				return;
			}
			const offer = offers.get(player);
			if (offer === undefined || now - offer.at > OFFER_TTL_S) {
				offers.delete(player);
				audit.add({ t: now, userId: player.UserId, route: "offer", what: "refused", detail: "noOffer" });
				notify(player, { k: "refused", why: "noOffer" });
				return;
			}
			if (!req.yes) {
				offers.delete(player);
				audit.add({ t: now, userId: player.UserId, route: "offer", what: "stayed", detail: "" });
				return;
			}
			// the offer stands until it lapses, so a failed trip can be tried again from the same card
			travel.request(player, "offer");
		}),
	);

	// ------------------------------------------------------------ matchmaking (public servers only)

	let mm: MatchmakingAttributes | undefined;
	if (kind === "public" || kind === "studio") {
		const [ok, svc] = pcall(() => game.GetService("MatchmakingService"));
		if (ok && svc !== undefined) {
			const calls = svc as unknown as MatchmakingCalls;
			if (kind === "studio") {
				// the docs: a playtest has no schema unless this sets one (it does nothing outside Studio)
				pcall(() => calls.InitializeServerAttributesForStudio({ [ATTR_WORLD_DAY]: 1, [ATTR_SURVIVORS]: 0 }));
			}
			mm = new MatchmakingAttributes(
				{
					set(name, value) {
						const [done, result] = pcall(() => {
							const [success, err] = calls.SetServerAttribute(name, value);
							return { success, err };
						});
						if (!done) return [false, tostring(result)];
						return [result.success === true, typeIs(result.err, "string") ? result.err : undefined];
					},
				},
				err => {
					// once per server: the attributes have to exist in the Creator Hub first (docs/CREATOR_HUB.md)
					warn(`[${GAME_NAME}] the matchmaking attributes were refused`);
					print(`[${GAME_NAME}] SetServerAttribute: ${err}`);
				},
			);
		}
	}

	// ------------------------------------------------------------ the loop and the leave

	let scanAcc = 0;
	let mmAcc = 0;
	conns.push(
		RunService.Heartbeat.Connect(dt => {
			scanAcc += dt;
			mmAcc += dt;
			if (scanAcc >= SCAN_S) {
				scanAcc = 0;
				for (const player of Players.GetPlayers()) {
					if (examined.has(player)) continue;
					const [ok, err] = pcall(() => examine(player));
					if (!ok) {
						examined.add(player);
						warn(`[${GAME_NAME}] looking at a new arrival failed`);
						print(`[${GAME_NAME}] match examine: ${tostring(err)}`);
					}
				}
			}
			if (mmAcc >= MATCHMAKING_S && mm !== undefined) {
				mmAcc = 0;
				const m = mm;
				pcall(() => m.update(os.clock(), options.worldDay(), options.survivors()));
			}
		}),
	);
	conns.push(
		Players.PlayerRemoving.Connect(player => {
			travel.playerLeft(player);
			examined.delete(player);
			offers.delete(player);
			messages.forget(player.UserId);
		}),
	);

	print(
		`[${GAME_NAME}] match: a ${kind} server` +
			`${tp === undefined ? " (no TeleportService)" : ""}${mm !== undefined ? ", matchmaking attributes on" : ""}`,
	);

	return {
		kind,
		travel,
		audit() {
			return audit.rows;
		},
		counters() {
			return {
				dropped: messages.dropped,
				malformed: messages.malformed,
				mmSent: mm?.sent ?? 0,
				mmRefused: mm?.refused ?? 0,
			};
		},
		stop() {
			for (const c of conns) c.Disconnect();
			conns.clear();
		},
	};
}
