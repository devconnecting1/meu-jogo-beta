#!/usr/bin/env node
/*
 * Where a survivor plays (docs/MULTIPLAYER.md §7.4, docs/DESIGN_RULES.md MP-25): the fresh-town offer (P0-1), Play solo
 * (P0-2), the server's kind and the matchmaking attributes.
 *
 *   npm run test:match                   # everything (exit code 1 on any failure)
 *   node tools/test-match.mjs --verbose  # with the server's own print/warn lines
 *   PZ_SRC=path/to/src node tools/test-match.mjs
 *
 *   1. THE RULES        the server kind from PrivateServerId / PrivateServerOwnerId / Studio; the offer's threshold
 *                       (a new player past day 5, a record of 30 not below 35) and who is never asked (a solo or a
 *                       private town, a read-only save, a dead survivor, one who followed a friend); the ticket read
 *                       back from GetJoinData (source place, version, route, id, owner, server kind) and nothing else
 *                       in it read; the gates (gap, window, the server's reservations, the remote's flood); the answer
 *                       to each TeleportResult; the two request shapes and nothing else.
 *   2. THE TRIP         the state machine with a fake TeleportService: reserve, TeleportAsync with the access code and
 *                       the ticket, sent, left; every refusal; ReserveServerAsync and TeleportAsync failing and retried
 *                       (and given up with a message); TeleportInitFailed -- Flooded waits 15 s, Failure 1 s, a server
 *                       that ended gets a new reservation, GameFull / Unauthorized fail, IsTeleporting is ignored, the
 *                       rounds run out; no word in 45 s; NEVER MID-RUN: a player who walked into the city meanwhile has
 *                       the trip called off, before the first teleport and before a retry; the access code in nothing
 *                       but TeleportAsync.
 *   3. THE REAL SERVER  server/main.server.ts with mpHost, on a fake Roblox with TeleportService, MatchmakingService and
 *                       AnalyticsService: the kind attribute and the remote; WorldDay / Survivors published on change;
 *                       the offer to a new player in a day-23 town (not to a veteran, a follower, a day-5 town), New
 *                       town and Play solo teleporting with the save written first and its lock KEPT; Stay; an offer
 *                       that was never made; in the city, dead, twice; a teleport that keeps failing leaves a session
 *                       that plays on; Studio explains itself and never reserves; a flood of junk moves nothing; the
 *                       NewTown funnel, TownOffered and TripFailed with their closed fields.
 *   4. THE SOLO TOWN    a reserved server: the kind "solo", no matchmaking, no offer, no Play solo; the owner's ticket
 *                       logs the funnel's arrival with the SAME id, a forged or foreign one logs nothing; the town
 *                       opens on the OWNER's life day (MP-13; a fresh save: day 1) -- the first READABLE load's, a
 *                       ticket stripped or naming another owner changes nothing, an unreadable load settles nothing
 *                       and holds the admission until its Retry --, and a world that ends there is followed by a new
 *                       town on day 1 whose record counts the days it lasted; a private (VIP) server opens on its
 *                       owner's day read at boot whoever loads first, on day 1 when that read fails and a guest loads
 *                       first, and an unreadable guest settles nothing.
 *   6. THE REVIEWS      of f25727a: a living body kept in danger (a zombie near, a hit a moment ago) cannot buy a trip
 *                       (H1); a trip the player called off keeps its place in the gate (M1); nobody is admitted into
 *                       the city while their trip is in flight (M2); no second offer on a rejoin, a read-only load is
 *                       looked at again after its retry (joined as the real client joins), a repeated refusal is one
 *                       counted row, a solo town writes the shared world log at most once per gap (LOW 1, 2, 4, 5).
 *                       Of 0634b43: refusals counted per player and reason, interleaved or not (LOW 5); the Match
 *                       remote in the connection's flood kick (LOW 3); a world that ends while a trip is in flight
 *                       still counts the traveller and keeps their body (LOW 2).
 *
 * Pure Node (>= 18) plus the project's TypeScript through tools/luau-shim.mjs, with the fake Roblox of
 * tools/test-analytics.mjs (copied: each suite carries its own) plus the two services this needs.
 */
import { join } from "node:path";
import { installShims } from "./luau-shim.mjs";

const { SRC, require } = installShims({ seed: 1 });
const VERBOSE = process.argv.includes("--verbose");

// ---------------------------------------------------------------- reporting

let failures = 0;
let checks = 0;
function check(ok, what, detail) {
	checks += 1;
	const tail = detail === undefined ? "" : `  (${detail})`;
	if (ok) console.log(`  ok    ${what}${tail}`);
	else {
		failures += 1;
		console.log(`  FAIL  ${what}${tail}`);
	}
	return ok;
}
function section(title, fn) {
	console.log(`\n${title}`);
	try {
		fn();
	} catch (e) {
		failures += 1;
		console.log(`  FAIL  the section threw: ${e?.stack?.split("\n").slice(0, 5).join(" | ") ?? e}`);
	}
}

// ---------------------------------------------------------------- the fake Roblox (tools/test-analytics.mjs)

class Yield extends Error {}
function runThread(fn, args) {
	try {
		return fn(...args);
	} catch (e) {
		if (e instanceof Yield) return undefined;
		throw e;
	}
}

let clockNow = 1000;
const timers = [];
const tickErrors = [];
const warnings = [];
const prints = [];
globalThis.print = (...a) => {
	prints.push(a.join(" "));
	if (VERBOSE) console.log("        [print]", ...a);
};
globalThis.warn = (...a) => {
	const line = a.join(" ");
	warnings.push(line);
	if (line.includes("tick failed")) tickErrors.push(line);
	if (VERBOSE) console.log("        [warn]", line);
};
const TIME0 = 1_800_000_000;
globalThis.os = { clock: () => clockNow, time: () => Math.floor(TIME0 + clockNow) };
globalThis.task = {
	spawn: (fn, ...args) => runThread(fn, args),
	defer: (fn, ...args) => runThread(fn, args),
	delay: (s, fn, ...args) => timers.push({ at: clockNow + s, fn: () => runThread(fn, args) }),
	wait: () => {
		throw new Yield();
	},
};
globalThis.pcall = (fn, ...args) => {
	try {
		return [true, fn(...args)];
	} catch (e) {
		if (e instanceof Yield) throw e;
		return [false, e instanceof Error ? e.message : e];
	}
};
globalThis.tostring = v => String(v);
globalThis.tonumber = v => (Number.isFinite(Number(v)) ? Number(v) : undefined);
globalThis.$tuple = (...a) => a[0];
globalThis.utf8 = { len: s => [Array.from(String(s)).length], offset: (s, n) => n };
globalThis.string = {
	char: (...codes) => String.fromCharCode(...codes),
	match: () => [undefined],
	format: (fmt, ...args) => {
		let i = 0;
		return fmt.replace(/%([-0]*)(\d+)?(?:\.(\d+))?([dsfixq%])/g, (m, flags, width, prec, conv) => {
			if (conv === "%") return "%";
			const v = args[i++];
			let s;
			if (conv === "d" || conv === "i") s = String(Math.trunc(Number(v)));
			else if (conv === "f") s = Number(v).toFixed(prec === undefined ? 6 : Number(prec));
			else s = String(v);
			if (width !== undefined && s.length < Number(width))
				s = s.padStart(Number(width), flags.includes("0") ? "0" : " ");
			return s;
		});
	},
};
globalThis.Enum = new Proxy({}, { get: (_, a) => new Proxy({}, { get: (__, b) => `${String(a)}.${String(b)}` }) });

class Signal {
	constructor() {
		this.handlers = [];
	}
	Connect(fn) {
		const h = { fn, on: true };
		this.handlers.push(h);
		return {
			Connected: true,
			Disconnect: () => {
				h.on = false;
				this.handlers = this.handlers.filter(x => x !== h);
			},
		};
	}
	Fire(...args) {
		for (const h of [...this.handlers]) if (h.on) runThread(h.fn, args);
	}
	Wait() {
		throw new Yield();
	}
}

class Inst {
	constructor(className) {
		this.ClassName = className;
		this.Name = className;
		this._children = [];
		this._parent = undefined;
		this._attrs = new Map();
		this.ChildAdded = new Signal();
		if (className.endsWith("RemoteEvent")) {
			this.OnServerEvent = new Signal();
			this.OnClientEvent = new Signal();
			this.sent = [];
		}
		if (className === "TeleportOptions") {
			this.ReservedServerAccessCode = "";
			this.ShouldReserveServer = false;
			this.ServerInstanceId = "";
			this._data = undefined;
		}
	}
	get Parent() {
		return this._parent;
	}
	set Parent(p) {
		if (this._parent !== undefined) this._parent._children = this._parent._children.filter(c => c !== this);
		this._parent = p;
		if (p !== undefined) {
			p._children.push(this);
			p.ChildAdded.Fire(this);
		}
	}
	FindFirstChild(name) {
		return this._children.find(c => c.Name === name);
	}
	WaitForChild(name) {
		return this.FindFirstChild(name);
	}
	GetChildren() {
		return [...this._children];
	}
	IsA(className) {
		return this.ClassName === className || className === "Instance";
	}
	Destroy() {
		this.Parent = undefined;
	}
	SetAttribute(k, v) {
		this._attrs.set(k, v);
	}
	GetAttribute(k) {
		return this._attrs.get(k);
	}
	SetTeleportData(d) {
		this._data = JSON.parse(JSON.stringify(d));
	}
	GetTeleportData() {
		return this._data;
	}
	FireClient(player, ...args) {
		this.sent.push({ to: player, args });
		if (this.sent.length > 4000) this.sent.splice(0, 2000);
	}
	FireAllClients(...args) {
		this.sent.push({ to: undefined, args });
		if (this.sent.length > 4000) this.sent.splice(0, 2000);
	}
}
globalThis.Instance = Inst;

const stores = new Map();
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const writes = [];
function fakeStore(name) {
	let s = stores.get(name);
	if (s !== undefined) return s;
	const data = new Map();
	s = {
		data,
		UpdateAsync(key, transform) {
			const next = transform(clone(data.get(key)));
			if (next !== undefined) {
				data.set(key, clone(next));
				writes.push({ store: name, key, t: clockNow, doc: clone(next) });
			}
			return [next];
		},
		/** GetAsync throws this many more times (the private server's boot read of its owner's save) */
		failGet: 0,
		GetAsync(key) {
			if (s.failGet > 0) {
				s.failGet -= 1;
				throw new Error("HTTP 502 (DataStore)");
			}
			return [clone(data.get(key))];
		},
		SetAsync: (key, v) => data.set(key, clone(v)),
	};
	stores.set(name, s);
	return s;
}

/** every analytics row of the whole run, with the player's name beside it (section 5) */
const EVERY_ROW = [];

/** the recorder standing in for AnalyticsService (every call, decoded) */
function makeAnalyticsService(log) {
	const row = (player, r) => {
		const out = { ...r, userId: player?.UserId, t: clockNow };
		log.push(out);
		EVERY_ROW.push({ ...out, playerName: player?.Name });
	};
	return {
		LogOnboardingFunnelStepEvent: (player, step, name, fields) =>
			row(player, { kind: "onboarding", step, name, fields }),
		LogFunnelStepEvent: (player, funnel, session, step, name, fields) =>
			row(player, { kind: "funnel", funnel, session, step, name, fields }),
		LogEconomyEvent: (player, flow, currency, amount, balance, tx, sku, fields) =>
			row(player, { kind: "economy", flow, currency, amount, balance, tx, sku, fields }),
		LogCustomEvent: (player, name, value, fields) => row(player, { kind: "custom", name, value, fields }),
	};
}

/**
 * TeleportService: ReserveServerAsync hands out "code-N" / "psid-N" (or throws while `failReserve` > 0),
 * TeleportAsync records every call (or throws while `failTeleport` > 0), TeleportInitFailed is a signal the test fires.
 */
function makeTeleportService() {
	const tp = {
		reserves: 0,
		failReserve: 0,
		failTeleport: 0,
		calls: [],
		TeleportInitFailed: new Signal(),
		ReserveServerAsync(placeId) {
			if (tp.failReserve > 0) {
				tp.failReserve -= 1;
				throw new Error("HTTP 500 (reservation service)");
			}
			tp.reserves += 1;
			tp.lastPlace = placeId;
			return [`code-${tp.reserves}-secret`, `psid-${tp.reserves}`];
		},
		TeleportAsync(placeId, players, options) {
			if (tp.failTeleport > 0) {
				tp.failTeleport -= 1;
				throw new Error("Teleport failed: HTTP 503");
			}
			tp.calls.push({
				placeId,
				players: [...players],
				code: options?.ReservedServerAccessCode,
				reserve: options?.ShouldReserveServer,
				instance: options?.ServerInstanceId,
				data: options?.GetTeleportData?.(),
				t: clockNow,
			});
			return new Inst("TeleportAsyncResult");
		},
	};
	return tp;
}

/** MatchmakingService: SetServerAttribute records (and refuses while `refuse`), the Studio schema is noted */
function makeMatchmakingService() {
	const mm = {
		refuse: false,
		sets: [],
		studio: undefined,
		SetServerAttribute(name, value) {
			if (mm.refuse) return [false, "attribute not defined for this experience"];
			mm.sets.push({ name, value, t: clockNow });
			return [true, undefined];
		},
		InitializeServerAttributesForStudio(attrs) {
			mm.studio = { ...attrs };
			return [true, undefined];
		},
	};
	return mm;
}

let guid = 0;
function makeGame({ studio = false, privateServerId = "", ownerId = 0, teleport = true, matchmaking = true } = {}) {
	const ReplicatedStorage = new Inst("ReplicatedStorage");
	const Workspace = new Inst("Workspace");
	Workspace.GetServerTimeNow = () => clockNow;
	const Players = {
		list: [],
		PlayerAdded: new Signal(),
		PlayerRemoving: new Signal(),
		MaxPlayers: 6,
		CharacterAutoLoads: true,
		GetPlayers() {
			return [...this.list];
		},
		GetPlayerByUserId(id) {
			return this.list.find(p => p.UserId === id);
		},
	};
	const RunService = { Heartbeat: new Signal(), IsStudio: () => studio, IsServer: () => true, IsClient: () => false };
	const HttpService = {
		GenerateGUID: () => `{${(++guid).toString(16).padStart(8, "0")}-feed-beef}`,
		JSONEncode: v => JSON.stringify(v),
		JSONDecode: s => JSON.parse(s),
	};
	const DataStoreService = {
		GetDataStore: name => fakeStore(name),
		GetRequestBudgetForRequestType: () => 100,
	};
	const log = [];
	const services = {
		ReplicatedStorage,
		Workspace,
		Players,
		RunService,
		HttpService,
		DataStoreService,
		TextChatService: new Inst("TextChatService"),
		TextService: {},
		AnalyticsService: makeAnalyticsService(log),
	};
	const tp = teleport ? makeTeleportService() : undefined;
	if (tp !== undefined) services.TeleportService = tp;
	const mm = matchmaking ? makeMatchmakingService() : undefined;
	if (mm !== undefined) services.MatchmakingService = mm;
	const closers = [];
	globalThis.game = {
		GetService(name) {
			const s = services[name];
			if (s === undefined) throw new Error(`the fake Roblox has no ${name}`);
			return s;
		},
		JobId: `job-${++guid}`,
		PrivateServerId: privateServerId,
		PrivateServerOwnerId: ownerId,
		PlaceId: 4242,
		PlaceVersion: 1,
		BindToClose: fn => closers.push(fn),
	};
	return { services, closers, log, tp, mm };
}

function makePlayer(userId, name, extra = {}) {
	const p = new Inst("Player");
	p.Name = name;
	p.UserId = userId;
	p.DisplayName = name;
	p.FollowUserId = 0;
	p.Kick = () => {};
	p.GetNetworkPing = () => 0.05;
	p._join = {};
	p.GetJoinData = () => p._join;
	Object.assign(p, extra);
	return p;
}

// ---------------------------------------------------------------- a server "process"

function bootServer(opts = {}) {
	for (const k of Object.keys(require.cache)) if (k.startsWith(SRC)) delete require.cache[k];
	timers.length = 0;
	const env = makeGame(opts);
	require(join(SRC, "server/main.server.ts"));
	const host = require(join(SRC, "server/net/mpHost.ts")).activeMpHost();
	if (host === undefined) throw new Error("main.server.ts did not start the MP host (MP_PHASE < 1?)");
	const P = require(join(SRC, "shared/net/protocol.ts"));
	const { SAVE_STORE } = require(join(SRC, "server/save/stores.ts"));
	const { Players, RunService, ReplicatedStorage, Workspace } = env.services;
	const net = ReplicatedStorage.FindFirstChild("Net");
	const remote = name => {
		const r = net.FindFirstChild(name);
		if (r === undefined) throw new Error(`no remote ${name}`);
		return r;
	};
	const server = {
		env,
		host,
		P,
		Workspace,
		sim: host.simulation,
		tp: env.tp,
		mm: env.mm,
		match: remote("Match"),
		saveStore: () => fakeStore(SAVE_STORE),
		join(userId, name = `p${userId}`, extra = {}) {
			const p = makePlayer(userId, name, extra);
			p._parent = Players;
			Players.list.push(p);
			Players.PlayerAdded.Fire(p);
			remote("LoadRequest").OnServerEvent.Fire(p);
			return p;
		},
		/**
		 * A join as the real client makes it: PlayerAdded starts the load, and the client's LoadRequest comes later
		 * (`retry`). The server can look at the player while the load it has is read-only (review of 0634b43, LOW 6).
		 */
		joinQuiet(userId, name = `p${userId}`, extra = {}) {
			const p = makePlayer(userId, name, extra);
			p._parent = Players;
			Players.list.push(p);
			Players.PlayerAdded.Fire(p);
			return p;
		},
		/** the client's LoadRequest: on a read-only session, the Retry */
		retry(p) {
			remote("LoadRequest").OnServerEvent.Fire(p);
		},
		quit(p) {
			Players.list = Players.list.filter(x => x !== p);
			Players.PlayerRemoving.Fire(p);
			p._parent = undefined;
		},
		save(p) {
			const acks = remote("LoadAck").sent.filter(e => e.to === p);
			return acks[acks.length - 1]?.args[0]?.save;
		},
		intent(p, kind) {
			remote("Intent").OnServerEvent.Fire(p, P.encodeIntent(kind));
		},
		enter(p) {
			server.intent(p, P.IntentKind.EnterWorld);
			server.run(0.6);
			return host.playerOf(p);
		},
		leave(p) {
			server.intent(p, P.IntentKind.LeaveWorld);
			server.run(1.2);
		},
		/** what the client sends on the Match remote */
		ask(p, req) {
			server.match.OnServerEvent.Fire(p, req);
		},
		/** every notice the Match remote sent to `p` */
		notices(p) {
			return server.match.sent.filter(e => e.to === p).map(e => e.args[0]);
		},
		lastNotice(p) {
			const n = server.notices(p);
			return n[n.length - 1];
		},
		storeSave(userId, data) {
			fakeStore(SAVE_STORE).data.set(String(userId), { data: JSON.stringify(data), lock: undefined });
		},
		stored(userId) {
			return fakeStore(SAVE_STORE).data.get(String(userId));
		},
		beat(dt = 1 / 60) {
			clockNow += dt;
			for (let i = timers.length - 1; i >= 0; i--) {
				if (timers[i].at <= clockNow) {
					const t = timers.splice(i, 1)[0];
					t.fn();
				}
			}
			RunService.Heartbeat.Fire(dt);
			if (tickErrors.length > 0)
				throw new Error(`the simulation tick failed: ${tickErrors.splice(0).join(" | ")}`);
		},
		run(seconds, dt = 1 / 30) {
			const n = Math.round(seconds / dt);
			for (let i = 0; i < n; i++) server.beat(dt);
		},
		rows(userId, kind) {
			return env.log.filter(r => r.userId === userId && (kind === undefined || r.kind === kind));
		},
		shop(p, req) {
			return remote("ShopAction").OnServerInvoke(p, req);
		},
		/** a death through the server's own damage path, then the ticks that notice it */
		kill(p) {
			const sp = host.playerOf(p);
			sp.state.godMode = false;
			server.sim.combat.damageActor(sp.slot, sp.state, sp.save, sp.state.hpMax * 10, true);
			server.beat();
			server.beat();
			return sp;
		},
		/** the world-log store's document (ProjectZ_Worlds, key "ended") */
		worldLog() {
			const { WORLD_LOG_STORE } = require(join(SRC, "server/save/stores.ts"));
			return fakeStore(WORLD_LOG_STORE).data.get("ended");
		},
	};
	return server;
}

let nextUser = 91000;
const newUser = () => ++nextUser;
const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
/** every string anywhere in `v` (deep) */
function strings(v, out = []) {
	if (typeof v === "string") out.push(v);
	else if (Array.isArray(v)) for (const x of v) strings(x, out);
	else if (v !== null && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
	return out;
}

// ================================================================ 1: the rules (pure)

const W = require(join(SRC, "shared/match/matchWire.ts"));
const R = require(join(SRC, "server/match/rules.ts"));

section("1) the rules: the server kind, the offer, the ticket, the gates, the platform's answers", () => {
	check(
		W.serverKindOf("", 0, false) === "public" &&
			W.serverKindOf("psid", 0, false) === "solo" &&
			W.serverKindOf("psid", 555, false) === "private" &&
			W.serverKindOf("", 0, true) === "studio" &&
			W.serverKindOf("psid", 0, true) === "studio",
		"the kind: '' = public, an id with owner 0 = solo (reserved), an owner = private (VIP), Studio = studio",
	);
	check(
		W.readServerKind("solo") === "solo" &&
			W.readServerKind("vip") === undefined &&
			W.readServerKind(3) === undefined,
		"the attribute reads back as a kind, anything else as unknown",
	);
	check(
		W.playSoloFrom("public") &&
			W.playSoloFrom("private") &&
			W.playSoloFrom("studio") &&
			!W.playSoloFrom("solo") &&
			!W.playSoloFrom(undefined),
		"Play solo from a public, private or Studio server; never from a solo town or an unknown server",
	);

	const base = { kind: "public", status: "new", bestDay: 1, runOver: false, worldDay: 6, followed: false };
	const offer = over => R.freshTownOffer({ ...base, ...over });
	check(
		!offer({ worldDay: 5 }) && offer({ worldDay: 6 }) && offer({ worldDay: 23 }),
		"a new player (record day 1) is offered a fresh town past day 5 (the task's max(5, best + 4)), never on 1-5",
	);
	check(
		!offer({ status: "ok", bestDay: 5, worldDay: 9 }) && offer({ status: "ok", bestDay: 5, worldDay: 10 }),
		"a record of day 5 (still a new player): not in a day-9 town, yes in a day-10 one (max(5, best + 4))",
		`threshold ${R.offerThreshold(5)}`,
	);
	check(
		!offer({ status: "ok", bestDay: R.NEW_PLAYER_MAX_BEST + 1, worldDay: 40 }) &&
			!offer({ status: "ok", bestDay: 30, worldDay: 60 }),
		"NEW players only: a record past day 5 is never offered anything, however far the town is (M3)",
	);
	check(
		!offer({ kind: "solo", worldDay: 40 }) &&
			!offer({ kind: "private", worldDay: 40 }) &&
			offer({ kind: "studio", worldDay: 40 }),
		"never in a solo town nor a private one (the player's own company); Studio behaves as public",
	);
	check(
		!offer({ status: "error", worldDay: 40 }) &&
			!offer({ runOver: true, worldDay: 40 }) &&
			!offer({ followed: true, worldDay: 40 }) &&
			!offer({ worldDay: undefined }),
		"never on a read-only blank save, to a dead survivor, to one who followed a friend in, or with no world",
	);

	const ticket = R.makeTicket("solo", "{0000abcd-feed-beef}", 77);
	const join = (data, from = 4242) => ({ SourcePlaceId: from, TeleportData: data });
	const ok = R.readTicket(join(ticket), 4242, 77, "solo");
	check(
		ok.ok === true && ok.route === "solo" && ok.trip === "{0000abcd-feed-beef}",
		"the ticket reads back on the destination: route and trip id",
		JSON.stringify(ok),
	);
	const why = (jd, userId = 77, kind = "solo") => {
		const r = R.readTicket(jd, 4242, userId, kind);
		return r.ok ? "ok" : r.why;
	};
	check(why(undefined) === "none" && why({}) === "none", "no join data, no ticket: 'none'");
	check(why(join(ticket, 1)) === "foreign", "a teleport from another place is not read at all (the docs' check)");
	check(
		why(join({ ...ticket, pz: 2 })) === "malformed" &&
			why(join({ ...ticket, route: "vip" })) === "malformed" &&
			why(join({ ...ticket, trip: "a b c d e f g h" })) === "malformed" &&
			why(join({ ...ticket, trip: "x".repeat(65) })) === "malformed" &&
			why(join("solo")) === "malformed",
		"another version, an unknown route, an id that is not a GUID or a ticket that is not a table: malformed",
	);
	check(why(join(ticket), 78) === "owner", "a ticket issued to somebody else: 'owner' (nothing logged for it)");
	check(
		why(join(ticket), 77, "public") === "server",
		"a ticket carried into a server that is not a solo town: ignored",
	);
	const forged = R.readTicket(join({ ...ticket, day: 99, seed: 1, money: 1e9, code: "x" }), 4242, 77, "solo");
	check(
		forged.ok === true && Object.keys(forged).sort().join(",") === "ok,route,trip",
		"extra fields (a day, a seed, coins, a code) are never read: the reading carries the route and the id only",
		Object.keys(forged).join(","),
	);

	const gate = new R.TripGate();
	const a = [gate.take(1, 0), gate.take(1, 5), gate.take(1, 10), gate.take(1, 20), gate.take(1, 30)];
	check(
		a.join() === "true,false,true,true,true" && !gate.take(1, 40) && gate.take(1, 601) && gate.take(2, 40),
		"a trip every 10 s at most, 4 per 10 min per player (another player has their own)",
		a.join(),
	);
	gate.release(1, 601);
	check(gate.take(1, 602), "a trip that never left gives its place back");
	const budget = new R.ReserveBudget();
	let granted = 0;
	for (let i = 0; i < 30; i++) if (budget.take(0)) granted++;
	check(
		granted === R.RESERVE_BURST && !budget.take(1) && budget.take(4),
		"the server's reservations: a burst of 10, then 20 a minute",
	);
	const mg = new R.MessageGate();
	let passed = 0;
	for (let i = 0; i < 20; i++) if (mg.take(5, 0)) passed++;
	check(
		passed === 8 && mg.dropped === 12 && mg.take(5, 10),
		"the remote: 8 messages per 10 s per player, the rest dropped and counted",
	);

	const ans = n => R.initAnswer(R.resultName(n));
	check(
		ans("TeleportResult.Flooded").kind === "retry" &&
			ans("TeleportResult.Flooded").wait === 15 &&
			ans("TeleportResult.Failure").wait === 1 &&
			ans("TeleportResult.GameEnded").reserve === true &&
			ans("TeleportResult.GameNotFound").reserve === true &&
			ans("TeleportResult.GameFull").why === "full" &&
			ans("TeleportResult.Unauthorized").why === "denied" &&
			ans("TeleportResult.IsTeleporting").kind === "ignore" &&
			ans("Something new").why === "teleport",
		"each TeleportResult: Flooded 15 s, Failure 1 s, a server that ended re-reserves, full / denied fail, IsTeleporting waits",
	);

	check(
		W.readMatchRequest({ k: "solo" })?.k === "solo" &&
			W.readMatchRequest({ k: "offer", yes: true })?.yes === true &&
			W.readMatchRequest({ k: "offer", yes: false })?.yes === false,
		"the two requests the server reads",
	);
	const junk = [undefined, "solo", 3, [], { k: "offer" }, { k: "offer", yes: "true" }, { k: "teleport", place: 1 }];
	check(
		junk.every(j => W.readMatchRequest(j) === undefined),
		"anything else is nothing (dropped and counted)",
	);
	const extra = W.readMatchRequest({ k: "solo", place: 1, code: "x", day: 99, seed: 5 });
	check(
		extra !== undefined && Object.keys(extra).join() === "k",
		"a request naming a place, a code, a day or a seed: those fields do not survive the reading",
	);
	check(
		W.readMatchNotice({ k: "offer", worldDay: 23, bestDay: 1 })?.worldDay === 23 &&
			W.readMatchNotice({ k: "trip", s: "failed", why: "full" })?.why === "full" &&
			W.readMatchNotice({ k: "refused", why: "studio" })?.why === "studio" &&
			W.readMatchNotice({ k: "trip", s: "boom" }) === undefined &&
			W.readMatchNotice({ k: "offer", worldDay: 0.5, bestDay: 1 }) === undefined,
		"the client's reading of a notice: the known shapes, nothing else",
	);
});

// ================================================================ 2: the trip (pure, a fake port)

const T = require(join(SRC, "server/match/travel.ts"));

/** a TownTravel on a fake port, clock and timer list of its own */
function trip(opts = {}) {
	const t = { now: 0, timers: [], notices: [], events: [], prepared: 0, reserves: 0, teleports: [], lines: [] };
	t.failReserve = opts.failReserve ?? 0;
	t.failTeleport = opts.failTeleport ?? 0;
	t.block = new Map();
	t.gone = new Set();
	const player = { UserId: 501, Name: "tripper" };
	t.player = player;
	const audit = new R.TripAudit(line => t.lines.push(line));
	t.audit = audit;
	const port = {
		reserve() {
			if (t.failReserve > 0) {
				t.failReserve--;
				return { ok: false, err: "HTTP 500" };
			}
			t.reserves++;
			return { ok: true, code: `secret-${t.reserves}` };
		},
		teleport(p, code, ticket) {
			if (t.failTeleport > 0) {
				t.failTeleport--;
				return { ok: false, err: "HTTP 503" };
			}
			t.teleports.push({ p, code, ticket: { ...ticket }, at: t.now });
			// TeleportAsync yields in the engine: a TeleportInitFailed may land before it returns
			const early = t.duringTeleport;
			t.duringTeleport = undefined;
			early?.();
			return { ok: true };
		},
	};
	t.travel = new T.TownTravel({
		kind: opts.kind ?? "public",
		port: opts.noPort ? undefined : port,
		clock: () => t.now,
		delay: (s, fn) => t.timers.push({ at: t.now + s, fn }),
		newId: () => "{000000aa-feed-beef}",
		blocker: p => t.block.get(p),
		connected: p => !t.gone.has(p),
		prepare: () => t.prepared++,
		notify: (p, n) => t.notices.push(n),
		events: {
			asked: (p, v) => t.events.push(["asked", { ...v }]),
			sent: (p, v) => t.events.push(["sent", { ...v }]),
			failed: (p, v, stage, why) => t.events.push(["failed", stage, why, { ...v }]),
		},
		audit,
		warn: (what, detail) => t.lines.push(`WARN ${what} | ${detail}`),
	});
	t.advance = seconds => {
		const end = t.now + seconds;
		for (;;) {
			const due = t.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0];
			if (due === undefined) break;
			t.timers.splice(t.timers.indexOf(due), 1);
			t.now = Math.max(t.now, due.at);
			due.fn();
		}
		t.now = end;
	};
	t.last = () => t.notices[t.notices.length - 1];
	return t;
}

section(
	"2) the trip: reserve, teleport with the code and the ticket, every refusal, the retries, never mid-run",
	() => {
		// the happy path
		let t = trip();
		const refusal = t.travel.request(t.player, "solo");
		check(
			refusal === undefined && t.last()?.s === "start",
			"a request accepted: 'start', and nothing else happens in that frame",
			JSON.stringify(t.notices),
		);
		check(
			t.reserves === 0 && t.prepared === 0,
			"...the remote's thread returns at once (the work is the next frame's)",
		);
		t.advance(0.1);
		const call = t.teleports[0];
		check(
			t.prepared === 1 && t.reserves === 1 && call !== undefined && call.code === "secret-1",
			"next frame: the save written first, one reservation, TeleportAsync with its access code",
		);
		check(
			JSON.stringify(call.ticket) ===
				JSON.stringify({ pz: 1, route: "solo", trip: "{000000aa-feed-beef}", owner: 501 }),
			"the ticket: version, route, the funnel's trip id and the owner -- nothing else",
			JSON.stringify(call.ticket),
		);
		check(
			t.last()?.s === "going" && t.events.map(e => e[0]).join() === "asked,sent",
			"'going', and the funnel's asked + sent",
		);
		t.travel.playerLeft(t.player);
		check(
			!t.travel.inFlight(t.player) && t.audit.count("left") === 1,
			"the player left: the trip is done (audited)",
		);
		const everything = [...t.notices, ...t.events, ...t.audit.rows, ...t.lines];
		check(
			!strings(everything).some(s => s.includes("secret")),
			"the access code is in no notice, no analytics event, no audit row and no log line",
		);

		// refusals
		const refuse = (opts, prep) => {
			const x = trip(opts);
			prep?.(x);
			const r = x.travel.request(x.player, "solo");
			x.advance(60);
			return { r, reserves: x.reserves, teleports: x.teleports.length, last: x.last() };
		};
		const studio = refuse({ kind: "studio" });
		check(
			studio.r === "studio" && studio.reserves === 0 && studio.last?.why === "studio",
			"Studio: refused with its own word, nothing reserved",
		);
		check(refuse({ kind: "solo" }).r === "solo", "a solo town: refused ('this is already a town of your own')");
		check(refuse({ noPort: true }).r === "unavailable", "no TeleportService: 'unavailable'");
		for (const b of ["loading", "inWorld", "dead"]) {
			const x = refuse({}, y => y.block.set(y.player, b));
			check(x.r === b && x.teleports === 0, `blocked (${b}): refused, never teleported`);
		}
		t = trip();
		t.travel.request(t.player, "solo");
		check(t.travel.request(t.player, "solo") === "busy", "a second request while one is in flight: 'busy'");
		t.travel.playerLeft(t.player);
		t.now = 5;
		check(t.travel.request(t.player, "offer") === "rate", "another trip 5 s after the last: 'rate'");

		// ReserveServerAsync failing
		t = trip({ failReserve: 2 });
		t.travel.request(t.player, "solo");
		t.advance(0.1);
		check(t.reserves === 0 && t.teleports.length === 0, "a reservation that fails is not a teleport");
		t.advance(1);
		t.advance(2);
		check(
			t.reserves === 1 && t.teleports.length === 1,
			"...retried 1 s and 2 s later, and the third one goes through",
		);
		t = trip({ failReserve: 5 });
		t.travel.request(t.player, "solo");
		t.advance(10);
		const rf = t.events.find(e => e[0] === "failed");
		check(
			t.last()?.s === "failed" &&
				t.last()?.why === "reserve" &&
				rf?.[1] === "Reserve" &&
				t.teleports.length === 0,
			"three failed reservations: 'failed / reserve' to the player, TripFailed at Reserve",
			JSON.stringify(t.last()),
		);
		check(
			t.travel.request(t.player, "solo") === undefined,
			"...and the player may try again at once (the trip never left)",
		);

		// TeleportAsync failing
		t = trip({ failTeleport: 2 });
		t.travel.request(t.player, "solo");
		t.advance(0.1);
		t.advance(2.5);
		check(
			t.teleports.length === 1 && t.last()?.s === "going",
			"TeleportAsync throwing twice: retried a second apart, then sent",
		);
		t = trip({ failTeleport: 9 });
		t.travel.request(t.player, "solo");
		t.advance(10);
		check(
			t.last()?.why === "teleport" && t.events.some(e => e[0] === "failed" && e[1] === "Teleport"),
			"TeleportAsync failing three times: 'failed / teleport'",
		);

		// TeleportInitFailed
		const sent = () => {
			const x = trip();
			x.travel.request(x.player, "solo");
			x.advance(0.1);
			return x;
		};
		t = sent();
		t.travel.initFailed(t.player, "TeleportResult.Flooded", "too many");
		check(t.last()?.s === "retry", "Flooded: 'retry' to the player");
		t.advance(14.5);
		check(t.teleports.length === 1, "...nothing for 15 s (the docs' FLOOD_DELAY)");
		t.advance(1);
		check(
			t.teleports.length === 2 && t.teleports[1].code === "secret-1",
			"...then the SAME town again (the code kept: ReserveServerAsync, not a new one)",
		);
		t = sent();
		t.travel.initFailed(t.player, "TeleportResult.Failure", "");
		t.advance(1.1);
		check(t.teleports.length === 2, "Failure: again 1 s later");
		t = sent();
		t.travel.initFailed(t.player, "TeleportResult.GameEnded", "");
		t.advance(1.1);
		check(
			t.reserves === 2 && t.teleports[1]?.code === "secret-2",
			"GameEnded: the reserved town is gone, a new one is reserved",
		);
		for (const [result, why] of [
			["TeleportResult.GameFull", "full"],
			["TeleportResult.Unauthorized", "denied"],
		]) {
			t = sent();
			t.travel.initFailed(t.player, result, "");
			check(
				t.last()?.why === why && !t.travel.inFlight(t.player),
				`${result.split(".")[1]}: 'failed / ${why}' at once`,
			);
		}
		t = sent();
		t.travel.initFailed(t.player, "TeleportResult.IsTeleporting", "");
		check(
			t.travel.inFlight(t.player) && t.last()?.s === "going",
			"IsTeleporting: already on the way, nothing to do",
		);
		t = sent();
		for (let i = 0; i < 4; i++) {
			t.travel.initFailed(t.player, "TeleportResult.Failure", "");
			t.advance(1.1);
		}
		check(
			t.last()?.why === "teleport" && !t.travel.inFlight(t.player),
			"the rounds run out after 3: 'failed'",
			JSON.stringify(t.last()),
		);
		t = trip();
		t.duringTeleport = () => t.travel.initFailed(t.player, "TeleportResult.Failure", "");
		t.travel.request(t.player, "solo");
		t.advance(0.1);
		check(
			t.last()?.s === "retry",
			"a TeleportInitFailed that lands while TeleportAsync still yields is answered when it returns (not lost)",
		);
		t.advance(1.1);
		check(t.teleports.length === 2, "...and the retry goes 1 s later, as for one that came after");
		t = sent();
		t.advance(44);
		check(t.travel.inFlight(t.player), "sent, still here at 44 s: still waiting");
		t.advance(2);
		check(t.last()?.why === "timeout", "...45 s without a word and still here: 'failed / timeout'");
		t.travel.initFailed(t.player, "TeleportResult.Failure", "");
		check(t.teleports.length === 1, "a TeleportInitFailed for a trip already given up moves nothing");

		// never mid-run
		t = trip();
		t.travel.request(t.player, "solo");
		t.block.set(t.player, "inWorld");
		t.advance(0.1);
		check(
			t.teleports.length === 0 && t.reserves === 0 && t.last()?.why === "cancelled",
			"the player walked into the city before the first teleport: called off, nothing reserved, nothing sent",
		);
		t = sent();
		t.travel.initFailed(t.player, "TeleportResult.Flooded", "");
		t.block.set(t.player, "inWorld");
		t.advance(16);
		check(
			t.teleports.length === 1 && t.last()?.why === "cancelled",
			"...and before a retry: the retry is called off (nobody is teleported out of a run)",
		);
		check(
			!t.lines.some(l => l.startsWith("WARN") && l.includes("cancelled")),
			"a trip the player called off by playing is not an error (no warning)",
		);
		t = trip();
		t.travel.request(t.player, "solo");
		t.gone.add(t.player);
		t.advance(0.1);
		check(t.reserves === 0, "a player who left before the next frame: nothing reserved");
	},
);

// ================================================================ 3: the real server

section("3) the real server: attributes, the offer, New town and Play solo, refusals, failures, Studio", () => {
	let s = bootServer();
	check(s.Workspace.GetAttribute("pz_server_kind") === "public", "a public server says so (pz_server_kind)");
	check(s.match !== undefined && s.match.ClassName === "RemoteEvent", "the Match remote is in ReplicatedStorage/Net");
	s.run(1.2);
	const sets = () => s.mm.sets.map(x => `${x.name}=${x.value}`);
	check(
		sets().includes("WorldDay=1") && sets().includes("Survivors=0"),
		"the matchmaking attributes go out: WorldDay 1, Survivors 0",
		sets().join(","),
	);
	const before = s.mm.sets.length;
	s.run(12);
	check(s.mm.sets.length === before, "nothing is sent again while nothing changes");
	s.sim.clock.setClock(7, 23);
	s.run(1.2);
	check(sets().includes("WorldDay=23"), "a new world day goes out (WorldDay 23)");

	// the offer
	const newbie = newUser();
	const pN = s.join(newbie, "newbie");
	s.run(1);
	const offer = s.notices(pN).find(n => n.k === "offer");
	check(
		offer?.worldDay === 23 && offer?.bestDay === 1,
		"a new player in a day-23 town is offered a town of their own",
		JSON.stringify(offer),
	);
	const offered = s.rows(newbie, "custom").find(r => r.name === "TownOffered");
	check(
		offered?.value === 23 &&
			offered?.fields?.CustomField01 === "World day - 15-29" &&
			offered?.fields?.CustomField02 === "Best day - 1" &&
			offered?.fields?.CustomField03 === "Visit - First",
		"TownOffered: the day, and fixed buckets",
		JSON.stringify(offered?.fields),
	);
	s.run(3);
	check(s.notices(pN).filter(n => n.k === "offer").length === 1, "the offer is made once");
	const vet = newUser();
	const vs = defaultSave();
	Object.assign(vs, { level: 20, day: 25, bestDay: 30, tutorialDone: true, firstInstall: false });
	s.storeSave(vet, vs);
	const pV = s.join(vet, "veteran");
	const follower = newUser();
	const pF = s.join(follower, "follower", { FollowUserId: vet });
	s.run(1);
	check(
		s.notices(pV).length === 0 && s.notices(pF).length === 0,
		"not to a veteran (record 30), not to a player who followed a friend in",
	);

	// Stay, and an offer that was never made
	s.ask(pN, { k: "offer", yes: false });
	check(s.tp.reserves === 0, "Stay: nothing happens");
	s.ask(pV, { k: "offer", yes: true });
	check(
		s.lastNotice(pV)?.why === "noOffer" && s.tp.reserves === 0,
		"a New town for an offer never made: refused ('noOffer')",
	);

	// New town (a second new player, answered yes)
	const yes = newUser();
	const pY = s.join(yes, "yes");
	s.run(1);
	check(
		s.notices(pY).some(n => n.k === "offer"),
		"another new player, another offer",
	);
	const writesBefore = writes.filter(w => w.key === String(yes)).length;
	s.ask(pY, { k: "offer", yes: true });
	check(
		s.lastNotice(pY)?.s === "start" && s.tp.calls.length === 0,
		"New town: 'start', the teleport in the next frame",
	);
	s.run(0.2);
	const call = s.tp.calls.find(c => c.players[0] === pY);
	check(
		call !== undefined &&
			call.placeId === 4242 &&
			call.code === "code-1-secret" &&
			call.reserve === false &&
			call.instance === "" &&
			s.tp.lastPlace === 4242,
		"ReserveServerAsync(PlaceId), then TeleportAsync(PlaceId, {player}) with ReservedServerAccessCode (and not ShouldReserveServer)",
		JSON.stringify(call && { ...call, players: call.players.map(p => p.Name) }),
	);
	check(
		call?.data?.pz === 1 &&
			call?.data?.route === "offer" &&
			call?.data?.owner === yes &&
			typeof call?.data?.trip === "string",
		"the ticket in SetTeleportData: route 'offer', owner, trip id",
		JSON.stringify(call?.data),
	);
	const yesWrites = writes.filter(w => w.key === String(yes));
	const flushed = yesWrites[yesWrites.length - 1];
	check(
		yesWrites.length > writesBefore && flushed?.doc?.lock !== undefined && flushed?.t < call.t + 1e-9,
		"the save was written BEFORE the teleport, and its lock kept (a failed teleport must still own it)",
	);
	check(s.lastNotice(pY)?.s === "going", "'going'");
	const funnel = s.rows(yes, "funnel").filter(r => r.funnel === "NewTown");
	check(
		funnel.map(r => r.step).join() === "1,2" &&
			funnel[0].session === call.data.trip &&
			funnel[0].fields?.CustomField01 === "Route - Offer" &&
			funnel[0].fields?.CustomField02 === "World day - 15-29" &&
			funnel[0].fields?.CustomField03 === "Life day - 1" &&
			funnel[1].fields === undefined,
		"NewTown: 1 Asked (route, world day, life day) and 2 Teleported, one session = the ticket's trip id",
		JSON.stringify(funnel.map(r => [r.step, r.name, r.fields])),
	);
	s.quit(pY);
	const released = s.stored(yes);
	check(
		released?.lock === undefined,
		"the leave that follows the teleport releases the lock (the destination's load waits for it)",
	);

	// Play solo, refused in the city and dead; twice
	const solo = newUser();
	const pS = s.join(solo, "loner");
	s.run(1);
	s.enter(pS);
	s.ask(pS, { k: "solo" });
	check(
		s.lastNotice(pS)?.why === "inWorld",
		"Play solo from the city: refused ('inWorld') -- a trip starts in the lobby only",
	);
	s.leave(pS);
	s.ask(pS, { k: "solo" });
	s.ask(pS, { k: "solo" });
	check(s.lastNotice(pS)?.why === "busy", "twice in a row: the second one is 'busy'");
	s.run(0.2);
	check(s.tp.calls.filter(c => c.players[0] === pS).length === 1, "...and one teleport");
	const soloFunnel = s.rows(solo, "funnel").find(r => r.funnel === "NewTown" && r.step === 1);
	// the half second between EnterWorld and the admission: a player who asked to enter the city is not in the lobby
	const racer = newUser();
	const pR = s.join(racer, "racer");
	s.run(1);
	s.run(10.5);
	s.enter(pR);
	// out of the city, and back in less than a second: the intent's cooldown defers the admission to the host's next pass
	s.intent(pR, s.P.IntentKind.LeaveWorld);
	// the body it keeps stands where no zombie is (a kept body in danger is section 6's: H1)
	s.sim.horde.zombies.length = 0;
	s.ask(pR, { k: "solo" });
	const acceptedR = s.lastNotice(pR)?.s === "start";
	s.intent(pR, s.P.IntentKind.EnterWorld);
	const notYet = s.host.playerOf(pR) === undefined;
	s.run(0.2);
	check(
		acceptedR && notYet && s.tp.calls.every(c => c.players[0] !== pR) && s.lastNotice(pR)?.why === "cancelled",
		"asked to enter the city right after Play solo (not admitted yet): the trip is called off, nobody is teleported",
		JSON.stringify({ acceptedR, notYet, last: s.lastNotice(pR) }),
	);
	check(soloFunnel?.fields?.CustomField01 === "Route - Play solo", "Route - Play solo");

	// dead
	const dead = newUser();
	const ds = defaultSave();
	Object.assign(ds, { day: 3, bestDay: 3, runOver: true, tutorialDone: true, firstInstall: false });
	s.storeSave(dead, ds);
	const pD = s.join(dead, "dead");
	s.run(1);
	s.ask(pD, { k: "solo" });
	check(
		s.lastNotice(pD)?.why === "dead" && s.notices(pD).every(n => n.k !== "offer"),
		"a dead survivor: refused ('dead'), and never offered",
	);

	// a teleport that keeps failing
	const unlucky = newUser();
	const pU = s.join(unlucky, "unlucky");
	s.run(1);
	s.tp.failTeleport = 99;
	s.ask(pU, { k: "solo" });
	s.run(5);
	const fail = s.lastNotice(pU);
	const tf = s.rows(unlucky, "custom").find(r => r.name === "TripFailed");
	check(
		fail?.s === "failed" && fail?.why === "teleport",
		"TeleportAsync failing every time: 'failed / teleport' to the player",
		JSON.stringify(fail),
	);
	check(
		tf?.value === 3 &&
			tf?.fields?.CustomField01 === "Stage - Teleport" &&
			tf?.fields?.CustomField02 === "Result - teleport" &&
			tf?.fields?.CustomField03 === "Route - Play solo",
		"TripFailed: stage, result, route, and the attempts as its value",
		JSON.stringify(tf),
	);
	check(
		warnings.some(w => w.includes("a trip to a town of one's own failed")),
		"...and one fixed warning for the Error Report",
	);
	s.tp.failTeleport = 0;
	const body = s.enter(pU);
	check(
		body !== undefined && !body.state.dead,
		"the session plays on: the player enters the city as if nothing happened",
	);
	s.leave(pU);
	s.sim.horde.zombies.length = 0; // no zombie by the body it left (H1 is section 6's)
	s.ask(pU, { k: "solo" });
	s.run(0.2);
	check(
		s.tp.calls.some(c => c.players[0] === pU),
		"...and Try again works at once (a trip that never left gave its place back)",
	);
	// TeleportInitFailed on the real signal
	const calls = s.tp.calls.filter(c => c.players[0] === pU).length;
	s.tp.TeleportInitFailed.Fire(pU, "TeleportResult.Flooded", "too many teleports", 4242, undefined);
	check(s.lastNotice(pU)?.s === "retry", "TeleportInitFailed(Flooded) on the real signal: 'retry'");
	s.run(16);
	const again = s.tp.calls.filter(c => c.players[0] === pU);
	check(
		again.length === calls + 1 && again[again.length - 1].code === again[0].code,
		"...15 s later, the same town again",
		JSON.stringify({ calls, again: again.map(c => c.code), notices: s.notices(pU).slice(-4) }),
	);

	// a flood of junk
	const flooder = newUser();
	const pJ = s.join(flooder, "flooder");
	s.run(1);
	const reservesBefore = s.tp.reserves;
	for (let i = 0; i < 50; i++) s.ask(pJ, i % 2 === 0 ? "teleport me" : { k: "solo", place: 999, code: "abc" });
	s.run(1);
	check(
		s.tp.reserves - reservesBefore <= 1,
		"50 messages of junk and forged fields: at most the one real request went through",
	);
	const everyNotice = s.match.sent.map(e => e.args);
	const everyRow = s.env.log;
	check(
		!strings(everyNotice).some(x => x.includes("secret")) && !strings(everyRow).some(x => x.includes("secret")),
		"the access code never reaches a client (no Match notice) nor analytics",
	);

	// Studio
	s = bootServer({ studio: true });
	check(s.Workspace.GetAttribute("pz_server_kind") === "studio", "Studio says so (pz_server_kind = studio)");
	check(
		s.mm.studio?.WorldDay === 1 && s.mm.studio?.Survivors === 0,
		"InitializeServerAttributesForStudio sets the playtest's schema",
	);
	const st = newUser();
	const pSt = s.join(st, "studio");
	s.run(1);
	s.ask(pSt, { k: "solo" });
	s.run(1);
	check(
		s.lastNotice(pSt)?.why === "studio" && s.tp.reserves === 0,
		"Play solo in Studio: 'studio' (the client explains), nothing reserved",
	);

	// no TeleportService, a refusing matchmaking
	s = bootServer({ teleport: false });
	s.mm.refuse = true;
	const nt = newUser();
	const pNt = s.join(nt, "noteleport");
	s.run(1.5);
	s.ask(pNt, { k: "solo" });
	check(
		s.lastNotice(pNt)?.why === "unavailable",
		"no TeleportService: 'unavailable' (the server boots and plays anyway)",
	);
	s.run(40);
	const refusedWarnings = warnings.filter(w => w.includes("matchmaking attributes were refused")).length;
	check(
		refusedWarnings >= 1 && s.mm.sets.length === 0,
		"matchmaking attributes not created in the Creator Hub: warned, the game goes on",
	);
});

// ================================================================ 4: the solo town

section(
	"4) the solo town: its own kind, the arrival, the owner's life day from a readable save, no offer; a private server",
	() => {
		const owner = newUser();
		let s = bootServer({ privateServerId: "psid-7", ownerId: 0 });
		check(s.Workspace.GetAttribute("pz_server_kind") === "solo", "a reserved server says 'solo'");
		const os23 = defaultSave();
		Object.assign(os23, { level: 9, day: 23, bestDay: 23, tutorialDone: true, firstInstall: false });
		s.storeSave(owner, os23);
		const id = "{00000fff-feed-beef}";
		const pO = s.join(owner, "owner", {
			_join: { SourcePlaceId: 4242, TeleportData: { pz: 1, route: "solo", trip: id, owner } },
		});
		s.run(1.2);
		const arrived = s.rows(owner, "funnel").filter(r => r.funnel === "NewTown");
		check(
			arrived.length === 1 && arrived[0].step === 3 && arrived[0].name === "Arrived" && arrived[0].session === id,
			"the owner's ticket: NewTown step 3 'Arrived', the SAME session id as the origin's steps 1 and 2",
			JSON.stringify(arrived),
		);
		check(
			s.mm.sets.length === 0,
			"no matchmaking attribute (the platform never matchmakes into a reserved server)",
		);
		s.sim.clock.setClock(7, 30);
		const late = newUser();
		const pL = s.join(late, "late");
		s.run(1);
		check(s.notices(pL).length === 0 && s.notices(pO).length === 0, "no offer in a solo town, whatever its day");
		s.ask(pO, { k: "solo" });
		check(s.lastNotice(pO)?.why === "solo", "Play solo from a solo town: 'this is already a town of your own'");

		// forged tickets
		s = bootServer({ privateServerId: "psid-8", ownerId: 0 });
		const forge = (join, name) => {
			const u = newUser();
			const p = s.join(u, name, { _join: join });
			s.run(1);
			return s.rows(u, "funnel").filter(r => r.funnel === "NewTown").length;
		};
		const good = { pz: 1, route: "solo", trip: "{00000abc-feed-beef}" };
		check(
			forge({ SourcePlaceId: 1, TeleportData: { ...good, owner: nextUser + 1 } }, "foreign") === 0,
			"a ticket from another place: nothing logged",
		);
		check(
			forge({ SourcePlaceId: 4242, TeleportData: { ...good, owner: 1 } }, "stolen") === 0,
			"a ticket issued to someone else: nothing logged",
		);
		check(
			forge({ SourcePlaceId: 4242, TeleportData: "solo please" }, "string") === 0,
			"a ticket that is not a table: nothing logged",
		);
		check(forge({}, "plain") === 0, "no ticket at all (a rejoin by link): nothing logged");
		const tickets =
			s.host !== undefined ? prints.filter(l => l.includes("[PZ-MATCH]") && l.includes(" ticket ")) : [];
		check(tickets.length >= 4, "each one is an audit line ('ticket <why>')", tickets.slice(-4).join(" | "));

		// the owner's life day (MP-13), the same rules
		s = bootServer({ privateServerId: "psid-9", ownerId: 0 });
		const o2 = newUser();
		const save = defaultSave();
		Object.assign(save, { level: 9, day: 23, bestDay: 23, tutorialDone: true, firstInstall: false });
		s.storeSave(o2, save);
		const p2 = s.join(o2, "owner2", {
			_join: {
				SourcePlaceId: 4242,
				TeleportData: { pz: 1, route: "offer", trip: "{00000eee-feed-beef}", owner: o2 },
			},
		});
		s.run(1.2);
		const sp = s.enter(p2);
		check(
			s.sim.clock.day === 23 && s.save(p2)?.day === 23 && sp !== undefined && !sp.state.dead,
			"the solo town opens on the OWNER's life day (MP-13): world day 23 for a life on day 23, 07:00",
			`world ${s.sim.clock.day} at ${s.sim.clock.dayTime.toFixed(2)}, life ${s.save(p2)?.day}`,
		);
		check(
			s.Workspace.GetAttribute("pz_world_day") === 23 &&
				prints.some(l => l.includes("[PZ-MATCH]") && l.includes("town day 23")),
			"...says so to the lobby (pz_world_day 23), and the audit says why ('the owner's life day')",
		);
		check(
			s.host.startTownOn(5) === false && s.sim.clock.day === 23,
			"once a body stood in the town its day is settled: nothing restarts it",
		);
		// a world that ends here: a new town on day 1 (MP-22), and the record counts the days it LASTED
		s.sim.clock.setClock(7, 24);
		s.kill(p2);
		s.shop(p2, { kind: "newRun", runRev: s.save(p2)?.runRev ?? s.host.playerOf(p2)?.save.runRev });
		s.run(3);
		const ended = s.worldLog();
		const last = Array.isArray(ended) ? ended[ended.length - 1] : undefined;
		check(
			s.sim.clock.day === 1 && last !== undefined && last.days === 2,
			"New game in the solo town ends it (MP-22): the next town is on day 1, and the record says it lasted 2 days (23 -> 24), not 24",
			JSON.stringify({ day: s.sim.clock.day, record: last && { days: last.days, reason: last.reason } }),
		);

		// a fresh save's owner: day 1
		s = bootServer({ privateServerId: "psid-10", ownerId: 0 });
		const o3 = newUser();
		s.join(o3, "fresh-owner", {
			_join: {
				SourcePlaceId: 4242,
				TeleportData: { pz: 1, route: "offer", trip: "{00000ddd-feed-beef}", owner: o3 },
			},
		});
		s.run(1.2);
		check(s.sim.clock.day === 1, "a fresh save's town opens on day 1 (a new player's life day)");

		// the ticket passes through the client: the day NEVER rides on it (review of 0634b43, MEDIUM). Only the trip's
		// player can be teleported into a reservation, so the first readable load is the owner's
		const { SAVE_STORE } = require(join(SRC, "server/save/stores.ts"));
		const lifeOn = day => {
			const v = defaultSave();
			Object.assign(v, { level: 9, day, bestDay: day, tutorialDone: true, firstInstall: false });
			return v;
		};
		const byTicket = [];
		for (const [label, join, day] of [
			["stripped", { SourcePlaceId: 4242 }, 23],
			[
				"another owner",
				{
					SourcePlaceId: 4242,
					TeleportData: { pz: 1, route: "solo", trip: "{0000abcd-feed-beef}", owner: 1 },
				},
				30,
			],
		]) {
			s = bootServer({ privateServerId: `psid-r1-${byTicket.length}`, ownerId: 0 });
			const u = newUser();
			s.storeSave(u, lifeOn(day));
			const p = s.join(u, label, { _join: join });
			s.run(1.2);
			const sp = s.enter(p);
			byTicket.push({
				label,
				life: day,
				world: s.sim.clock.day,
				inCity: sp !== undefined,
				arrived: s.rows(u, "funnel").some(r => r.funnel === "NewTown"),
			});
		}
		check(
			byTicket.every(r => r.world === r.life && r.inCity && !r.arrived),
			"a ticket stripped, or naming another owner: the town still opens on the life day of the first readable load (23, 30), never day 1 -- the ticket only closes the funnel, and a bad one closes nothing",
			JSON.stringify(byTicket),
		);

		// an unreadable first load settles nothing: nobody is admitted until a readable one says the day (LOW 1)
		s = bootServer({ privateServerId: "psid-r2", ownerId: 0 });
		const ro = newUser();
		fakeStore(SAVE_STORE).data.set(String(ro), { data: "{not json", lock: undefined });
		const pRo = s.joinQuiet(ro, "unreadable-owner", {
			_join: {
				SourcePlaceId: 4242,
				TeleportData: { pz: 1, route: "solo", trip: "{000002aa-feed-beef}", owner: ro },
			},
		});
		s.run(1.2);
		const heldRo = s.enter(pRo) === undefined; // "Play without saving": the town's day is not known yet
		const unsettled = !prints.some(l => l.includes(`[PZ-MATCH] ${ro} - town`));
		s.leave(pRo);
		fakeStore(SAVE_STORE).data.set(String(ro), { data: JSON.stringify(lifeOn(23)), lock: undefined });
		s.run(10);
		s.retry(pRo);
		s.run(12);
		const spRo = s.enter(pRo);
		check(
			heldRo && unsettled && s.sim.clock.day === 23 && spRo !== undefined && spRo.save.day === 23,
			"the owner's save unreadable on arrival: not admitted and nothing settled; the Retry reads the day-23 life and the town opens on day 23",
			JSON.stringify({ heldRo, unsettled, world: s.sim.clock.day, inCity: spRo !== undefined }),
		);

		// a private (VIP) server: the owner first -> the owner's day
		const vipOwner = newUser();
		s = bootServer({ privateServerId: "vip-0", ownerId: vipOwner });
		const vs = defaultSave();
		Object.assign(vs, { day: 12, bestDay: 14, tutorialDone: true, firstInstall: false });
		s.storeSave(vipOwner, vs);
		s.join(vipOwner, "vip-owner");
		s.run(1.2);
		check(s.sim.clock.day === 12, "a private server whose owner loads first opens on the owner's life day (12)");
		// ...a guest first: the owner's save is read at boot, without the lock, so it is still the owner's day (LOW 4)
		const vipO = newUser();
		fakeStore(SAVE_STORE).data.set(String(vipO), { data: JSON.stringify(lifeOn(17)), lock: undefined });
		s = bootServer({ privateServerId: "vip-4", ownerId: vipO });
		const g4 = newUser();
		s.storeSave(g4, lifeOn(30));
		const pG4 = s.join(g4, "first-guest");
		s.run(1.5);
		const g4In = s.enter(pG4) !== undefined;
		check(
			s.sim.clock.day === 17 &&
				g4In &&
				prints.some(l => l.includes(`[PZ-MATCH] ${vipO} - town day 17 (the owner's life day, read at boot)`)) &&
				fakeStore(SAVE_STORE).data.get(String(vipO))?.lock === undefined,
			"a guest who loads first: the town opens on the OWNER's life day (17, read at boot, the owner's lock untouched), never the guest's (30)",
			`world ${s.sim.clock.day}`,
		);
		// ...the boot read fails: as before, the first readable load -- a guest's -- opens it on day 1
		fakeStore(SAVE_STORE).failGet = 1;
		s = bootServer({ privateServerId: "vip-1", ownerId: vipO });
		check(s.Workspace.GetAttribute("pz_server_kind") === "private", "a private (VIP) server says 'private'");
		const early = newUser();
		s.storeSave(early, lifeOn(30));
		s.join(early, "early-guest");
		s.run(1.5);
		check(
			s.sim.clock.day === 1,
			"...the owner's save not read at boot: a guest who loads first opens it on day 1, never on the guest's day",
		);
		// ...and an unreadable guest first settles nothing: the next readable player does -- here the owner (LOW 1)
		fakeStore(SAVE_STORE).failGet = 1;
		const s6 = bootServer({ privateServerId: "vip-6", ownerId: vipO });
		const g6 = newUser();
		fakeStore(SAVE_STORE).data.set(String(g6), { data: "{not json", lock: undefined });
		const pG6 = s6.joinQuiet(g6, "unreadable-guest");
		s6.run(1.5);
		const g6Held = s6.enter(pG6) === undefined;
		const g6Silent = !prints.some(l => l.includes(`[PZ-MATCH] ${g6} - town`));
		s6.join(vipO, "vip-owner-6");
		s6.run(1.5);
		check(
			g6Held && g6Silent && s6.sim.clock.day === 17,
			"an unreadable guest first: held, nothing settled; the owner's readable load then opens it on their day (17)",
			JSON.stringify({ g6Held, g6Silent, world: s6.sim.clock.day }),
		);
		s = bootServer({ privateServerId: "vip-7", ownerId: 555 });
		check(s.mm.sets.length === 0, "...publishes no matchmaking attribute");
		s.sim.clock.setClock(7, 40);
		const guest = newUser();
		const pG = s.join(guest, "guest");
		s.run(1);
		check(
			s.notices(pG).every(n => n.k !== "offer"),
			"...never offers (the owner chose this company)",
		);
		s.ask(pG, { k: "solo" });
		s.run(0.2);
		check(
			s.tp.calls.some(c => c.players[0] === pG),
			"...and Play solo works from it",
		);
	},
);

// ================================================================ 6: the review of f25727a

section("6) the reviews: danger (H1), the cancel loop (M1), admission in flight (M2), the LOWs of both", () => {
	const { createZombie } = require(join(SRC, "shared/game/entities.ts"));
	const KEPT_HURT_S = require(join(SRC, "server/net/mpHost.ts")).KEPT_HURT_S;

	// H1: a living body kept where the horde is
	let s = bootServer();
	s.run(12);
	const u1 = newUser();
	const p1 = s.join(u1, "escaper");
	s.run(1.5);
	const sp1 = s.enter(p1);
	const z = createZombie(990001, sp1.state.x + 300, sp1.state.y, 1);
	s.sim.horde.zombies.push(z);
	s.intent(p1, s.P.IntentKind.LeaveWorld); // instant: the body is kept, frozen where it stood
	s.ask(p1, { k: "solo" });
	check(
		s.lastNotice(p1)?.why === "danger" && s.tp.calls.length === 0,
		"a kept LIVING body with a zombie 300 u away (the safe-spawn radius is 900): Play solo refused 'danger', nothing reserved",
		JSON.stringify(s.lastNotice(p1)),
	);
	z.x += 5000;
	z.y += 5000;
	s.run(12);
	s.ask(p1, { k: "solo" });
	s.run(0.2);
	check(
		s.tp.calls.some(c => c.players[0] === p1),
		"...the zombie gone and the body untouched for a while: the trip is allowed",
	);

	// H1: a hit a moment ago
	s = bootServer();
	s.run(12);
	const u2 = newUser();
	const p2 = s.join(u2, "hurt");
	s.run(1.5);
	const sp2 = s.enter(p2);
	s.sim.combat.damageActor(sp2.slot, sp2.state, sp2.save, 5, true);
	s.run(0.1);
	s.intent(p2, s.P.IntentKind.LeaveWorld);
	s.run(3);
	s.ask(p2, { k: "solo" });
	check(
		s.lastNotice(p2)?.why === "danger",
		`hit, left, asked 3 s later: 'danger' (a hit less than ${KEPT_HURT_S} s ago)`,
	);
	s.run(KEPT_HURT_S);
	s.ask(p2, { k: "solo" });
	s.run(0.2);
	check(
		s.tp.calls.some(c => c.players[0] === p2),
		`...${KEPT_HURT_S} s later, with nothing near: allowed`,
	);
	// ...judged at the request: a zombie wandering by the frozen body during a Flooded wait does not call the trip off
	const tries2 = s.tp.calls.filter(c => c.players[0] === p2).length;
	s.tp.TeleportInitFailed.Fire(p2, "TeleportResult.Flooded", "too many teleports", 4242, undefined);
	const kept2 = s.host.lives.keptBody(u2);
	s.sim.horde.zombies.push(createZombie(990002, kept2.x + 200, kept2.y, 1));
	check(s.host.keptInDanger(p2), "(a zombie now stands 200 u from the frozen body)");
	s.run(16);
	check(
		s.tp.calls.filter(c => c.players[0] === p2).length === tries2 + 1,
		"a trip asked in the clear goes on after its Flooded wait even if a zombie wandered by the frozen body meanwhile",
		JSON.stringify(s.notices(p2).slice(-3)),
	);

	// M1: the cancel loop (Leave, Play solo, Enter while the reservation yields) keeps the gate's count
	s = bootServer();
	s.run(12);
	const u3 = newUser();
	const p3 = s.join(u3, "looper");
	s.run(1.5);
	const origReserve = s.tp.ReserveServerAsync.bind(s.tp);
	s.tp.ReserveServerAsync = placeId => {
		s.intent(p3, s.P.IntentKind.EnterWorld);
		return origReserve(placeId);
	};
	let accepted = 0;
	let rate = 0;
	for (let i = 0; i < 12; i++) {
		s.ask(p3, { k: "solo" });
		const n = s.lastNotice(p3);
		if (n?.s === "start") accepted++;
		else if (n?.why === "rate") rate++;
		s.run(0.3);
		s.intent(p3, s.P.IntentKind.LeaveWorld);
		s.run(11); // past the 10 s gap each round
	}
	s.tp.ReserveServerAsync = origReserve;
	check(
		accepted === 4 && rate === 8 && s.tp.calls.length === 0,
		"12 rounds of Leave / Play solo / Enter-during-the-reservation: 4 accepted (the window's 4), 8 'rate', no teleport",
		JSON.stringify({ accepted, rate, reserves: s.tp.reserves }),
	);
	const pB = s.join(newUser(), "bystander");
	s.run(1.5);
	s.ask(pB, { k: "solo" });
	s.run(0.2);
	check(
		s.tp.calls.some(c => c.players[0] === pB),
		"...and a bystander still gets their trip (the server's reservations were not drained by one client)",
	);

	// M2: nobody is admitted while their trip is in flight
	s = bootServer();
	s.run(12);
	const u4 = newUser();
	const p4 = s.join(u4, "yanked");
	s.run(1.5);
	s.tp.failTeleport = 99; // every TeleportAsync fails: the trip lives through its three tries
	const origTp = s.tp.TeleportAsync.bind(s.tp);
	let entered = false;
	s.tp.TeleportAsync = (placeId, players, options) => {
		if (!entered) {
			entered = true;
			s.intent(p4, s.P.IntentKind.EnterWorld); // Enter pressed while TeleportAsync yields
		}
		return origTp(placeId, players, options);
	};
	s.ask(p4, { k: "solo" });
	s.run(0.2);
	check(
		s.host.playerOf(p4) === undefined,
		"EnterWorld while TeleportAsync yields: not admitted while the trip is in flight",
	);
	s.run(4);
	check(
		s.lastNotice(p4)?.why === "cancelled" || s.lastNotice(p4)?.why === "teleport",
		"...the trip ends (the retry sees the wish to enter and calls it off, or the tries run out)",
		JSON.stringify(s.lastNotice(p4)),
	);
	s.run(1);
	check(s.host.playerOf(p4) !== undefined, "...and only then the body is admitted");

	// LOW 1: no second offer on a rejoin
	s = bootServer();
	s.sim.clock.setClock(7, 23);
	s.run(1.2);
	const u5 = newUser();
	let p5 = s.join(u5, "rejoiner");
	s.run(1);
	s.ask(p5, { k: "offer", yes: false });
	s.quit(p5);
	s.run(1);
	p5 = s.join(u5, "rejoiner");
	s.run(1);
	check(
		s.notices(p5).filter(n => n.k === "offer").length === 0,
		"Stay, leave and rejoin the same server: not asked again",
	);

	// LOW 2: a read-only first load is looked at again once its retry reads the real save
	s = bootServer();
	s.sim.clock.setClock(7, 23);
	s.run(1.2);
	const u6 = newUser();
	const { SAVE_STORE } = require(join(SRC, "server/save/stores.ts"));
	fakeStore(SAVE_STORE).data.set(String(u6), { data: "{not json", lock: undefined });
	// as the real client joins (review of 0634b43, LOW 6): PlayerAdded loads, and the scans look at the player WHILE
	// the session is read-only -- the LoadRequest (the Retry) comes later. An immediate LoadRequest queued the retry
	// and hid the player from the scans, so the old test passed with the fix reverted
	const p6 = s.joinQuiet(u6, "unreadable");
	s.run(1.2);
	const lookedAtReadOnly = s.env.services.Players.list.includes(p6);
	const before = s.notices(p6).filter(n => n.k === "offer").length;
	const fresh = defaultSave();
	fakeStore(SAVE_STORE).data.set(String(u6), { data: JSON.stringify(fresh), lock: undefined });
	s.retry(p6);
	s.run(12);
	const after = s.notices(p6).filter(n => n.k === "offer").length;
	check(
		lookedAtReadOnly && before === 0 && after === 1,
		"a read-only load (the save unreadable), scanned as such, is not offered; after the Retry reads the real save, it is",
		JSON.stringify({ before, after }),
	);

	// LOW 4: the same refusal again and again is one counted row
	s = bootServer();
	s.run(1.2);
	const u7 = newUser();
	const p7 = s.join(u7, "presser");
	s.run(1);
	s.enter(p7);
	const lines0 = prints.filter(l => l.includes(`[PZ-MATCH] ${u7} solo refused inWorld`)).length;
	for (let i = 0; i < 6; i++) s.ask(p7, { k: "solo" });
	const lines = prints.filter(l => l.includes(`[PZ-MATCH] ${u7} solo refused inWorld`)).length - lines0;
	check(lines === 1, "six identical refusals: one log line (the audit row counts the rest)", `${lines} lines`);

	// ---- the review of 0634b43

	// LOW 5: the same refusal of two players pressing in turn: one row per player and reason, not one per press
	const u7b = newUser();
	const p7b = s.join(u7b, "presser-b");
	s.run(1);
	s.enter(p7b);
	s.run(11); // a fresh message window for both
	const refusedLines = () => prints.filter(l => l.includes("[PZ-MATCH]") && l.includes("solo refused inWorld"));
	const i0 = refusedLines().length;
	for (let i = 0; i < 6; i++) {
		s.ask(p7, { k: "solo" });
		s.ask(p7b, { k: "solo" });
	}
	const interleaved = refusedLines().length - i0;
	const rowOf = u => refusedLines().filter(l => l.includes(`] ${u} `)).length;
	check(
		interleaved === 1 && rowOf(u7b) === 1,
		"two players pressing in turn, 12 refusals: one line per player and reason (the rows count the rest)",
		`${interleaved} new lines`,
	);
	const { REFUSAL_WINDOW_S } = require(join(SRC, "server/match/rules.ts"));
	s.run(REFUSAL_WINDOW_S + 1);
	s.ask(p7b, { k: "solo" });
	check(
		refusedLines().length - i0 === 2,
		"...and a refusal that goes on past the window is a new line (the log still shows it)",
	);

	// LOW 3: the Match remote is in the connection's flood kick, like every other remote (§8.2)
	s = bootServer();
	s.run(1.2);
	const u8 = newUser();
	let kicked = 0;
	const p8 = s.join(u8, "match-flooder", { Kick: () => (kicked += 1) });
	s.run(1);
	const reserves8 = s.tp.reserves;
	for (let i = 0; i < 60; i++) s.ask(p8, i % 2 === 0 ? "teleport me" : 42);
	check(
		kicked === 1 && s.tp.reserves === reserves8,
		"60 malformed Match messages in a moment: the automatic kick ('network flood'), once, and nothing reserved",
		`kicks ${kicked}`,
	);
	s.ask(p8, { k: "solo" });
	s.run(0.2);
	check(s.tp.reserves === reserves8, "...and what the kicked player still sends is dropped before it is read");

	// LOW 2: a world that ends while a living survivor's trip is in flight -- the hold is at the admission only, so
	// rule 6 still sees the traveller (the save is not hidden) and the kept body is not lost
	const worldEndsWith = travel => {
		const w = bootServer();
		w.run(12);
		const a = newUser();
		const b = newUser();
		const pA = w.join(a, "falls");
		const pB = w.join(b, "travels");
		w.run(1.5);
		w.enter(pA);
		w.enter(pB);
		w.intent(pB, w.P.IntentKind.LeaveWorld); // B waits in the lobby, the living body kept
		w.sim.horde.zombies.length = 0;
		w.run(1);
		w.kill(pA);
		if (travel) {
			w.tp.failTeleport = 99; // every TeleportAsync fails: the trip stays in flight through its tries
			w.ask(pB, { k: "solo" });
			w.run(0.1);
		}
		const world0 = w.host.simulation.world;
		w.intent(pA, w.P.IntentKind.LeaveWorld); // the dead one walks home: declined (rule 6)
		w.run(0.6);
		const inFlight = w.notices(pB).some(n => n.s === "start") && !w.notices(pB).some(n => n.s === "failed");
		w.run(5);
		return {
			inFlight,
			ended: w.host.simulation.world !== world0,
			bKept: w.host.lives.keptBody(b) !== undefined,
		};
	};
	const stay = worldEndsWith(false);
	const trip = worldEndsWith(true);
	check(
		trip.inFlight && trip.ended === stay.ended && !trip.ended && trip.bKept,
		"a trip in flight changes nothing about the world's end: a living traveller in the lobby keeps it going, and their kept body stays",
		JSON.stringify({ stay, trip }),
	);

	// LOW 5: a solo town writes the shared world log at most once per gap, the town that lasted longest
	const G = require(join(SRC, "server/match/soloWorldLog.ts"));
	let now = 0;
	const written = [];
	const timersG = [];
	let closer;
	const inner = { record: e => written.push(e.days), recent: () => [], status: () => "ok" };
	const log = G.soloWorldLog(inner, {
		clock: () => now,
		delay: (sec, fn) => timersG.push({ at: now + sec, fn }),
		onClose: fn => (closer = fn),
	});
	const world = days => ({ seed: 1, days, startedAt: 0, endedAt: 0, reason: "declined", fallen: 1, job: "" });
	log.record(world(3));
	now = 10;
	log.record(world(1));
	now = 20;
	log.record(world(5));
	now = 30;
	log.record(world(2));
	check(
		written.join() === "3" && log.dropped() === 2,
		"the first world goes at once; three more inside the gap: only the longest (5) is kept, 2 dropped",
		JSON.stringify({ written, dropped: log.dropped() }),
	);
	now = G.SOLO_WORLD_LOG_GAP_S;
	for (const t of timersG.splice(0)) if (t.at <= now) t.fn();
	check(written.join() === "3,5", "...and it goes out when the gap is over");
	now += 5;
	log.record(world(7));
	closer();
	check(written.join() === "3,5,7", "a world kept at shutdown still goes out (BindToClose)");
	const main = require("node:fs").readFileSync(join(SRC, "server/main.server.ts"), "utf8");
	check(
		/readKind\(\) === "solo"\s*\?\s*soloWorldLog\(startWorldLog\(\)/.test(main),
		"the server wraps its world log this way on a solo server only (source guard)",
	);
});

// ================================================================ 5: what reached analytics

section("5) analytics: the NewTown funnel, TownOffered and TripFailed within the catalogue, no PII", () => {
	const A = require(join(SRC, "server/analytics/events.ts"));
	const mine = EVERY_ROW.filter(
		r => r.funnel === A.TOWN_FUNNEL || r.name === A.EVENT.TownOffered || r.name === A.EVENT.TripFailed,
	);
	check(mine.length >= 10, "this run logged the new events", `${mine.length} rows`);
	const town = mine.filter(r => r.funnel === A.TOWN_FUNNEL);
	check(
		town.every(r => A.TOWN_STEPS[r.step - 1] === r.name) &&
			town.every(r => (r.step === 1) === (r.fields !== undefined)) &&
			town.every(r => typeof r.session === "string" && r.session.length >= 8),
		"NewTown: steps 1-3 by name, fields on step 1 only (the docs: breakdowns read step 1), a GUID session each",
	);
	const bucket = "(1|2-3|4-7|8-14|15-29|30\\+)";
	const allowed = [
		"Route - (Play solo|Offer)",
		`World day - ${bucket}`,
		`Life day - ${bucket}`,
		`Best day - ${bucket}`,
		"Visit - (First|Returning)",
		`Stage - (${A.TRIP_STAGES.join("|")})`,
		`Result - (${A.TRIP_RESULTS.join("|")})`,
	].map(x => new RegExp(`^${x}$`));
	const values = mine.flatMap(r => Object.values(r.fields ?? {}));
	const strays = values.filter(v => !allowed.some(re => re.test(v)));
	check(strays.length === 0, "every field value is one of the catalogue's fixed strings", strays.join(" | "));
	const pii = [];
	for (const r of mine) {
		const texts = [r.name, r.funnel, r.session, ...Object.values(r.fields ?? {})].filter(
			v => typeof v === "string",
		);
		for (const x of texts) {
			const named = typeof r.playerName === "string" && r.playerName.length >= 4 && x.includes(r.playerName);
			if (x.includes(String(r.userId)) || named || x.includes("secret")) pii.push(`${r.kind}:${x}`);
		}
	}
	check(pii.length === 0, "no UserId, no name and no access code in any of them", pii.slice(0, 4).join(" | "));
	check(
		EVERY_ROW.filter(r => r.kind === "custom").every(r => Object.values(A.EVENT).includes(r.name)),
		"every custom event of the run is the catalogue's (TownOffered and TripFailed are in it)",
	);
});

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
