#!/usr/bin/env node
/*
 * The world ends when nobody is left alive, and a new one begins on day 1 (docs/DESIGN_RULES.md MP-22, the owner's
 * decision of 23 Sep 2026; server/sim/worldReset.ts, server/sim/life.ts rule 6).
 *
 *   npm run test:reset                  # everything (exit code 1 on any failure)
 *   node tools/test-reset.mjs --verbose # with the server's own print/warn lines
 *   PZ_SRC=path/to/src node tools/test-reset.mjs
 *
 * "Se todos os jogadores sobreviventes do mundo morrerem, o mundo finaliza naquele dia específico pra resetar pro dia
 * 1. O objetivo do jogo é durar mais tempo vivo e explorar o mundo." Until this landed the detection existed and the
 * reset did not: a server whose survivors all died waited for daybreak like any other death.
 *
 * Like tools/test-body.mjs, this boots the REAL server — server/main.server.ts, which starts server/net/mpHost.ts and
 * the world log — on a fake Roblox (Players, RunService's Heartbeat, remotes, an in-memory DataStore), and talks to it
 * only the way a client can. What it asserts is what the clients are sent and what the DataStore keeps.
 *
 *   1. EVERYBODY DIES          after the 30 s window the world ends exactly once: a new seed, a new town, day 1 at
 *                              07:00, no zombie of the old horde; every client is told (WorldReset to all, then the
 *                              join message again with the new seed and hash); the fallen are alive again with a new
 *                              life (life day 1, starter kit) and keep level, skills, coins, packs and costumes; the
 *                              world that ended is in the DataStore with how many days it lasted.
 *   2. A REBIRTH IN THE WINDOW keeps the world: nothing is reset, and solo still works — alone, with coins, the
 *                              window is the time to pay.
 *   3. EVERYBODY DECLINED      New game + Home end the world at once; the one in the lobby comes back to the NEW town
 *                              alive, and the one who never entered this world keeps their life untouched.
 *   4. THE ONES WHO LEFT       a survivor who left the server before the end keeps their life but not their body:
 *                              they come back into the new town, never onto a spot of the old one.
 *   5. THE F3 WORLD            with the server owning the interactive world (ground items, constructions, doors,
 *                              the night's wave queues), none of the old world survives into the new one.
 *   6. THE WIRE AND THE RECORD WorldReset and InitBegin{seed} round-trip and refuse garbage; a new seed is never the
 *                              old one; the stored list of ended worlds is bounded and sanitised.
 *   7. THE CLIENT              source guards: the client builds the server's town (not always DESIGN.TOWN_SEED) and
 *                              listens for the news.
 *   8. NEW GAME IS A NEW LIFE  the owner's playtest ("spawns and dies at the same instant, every click"): the old
 *                              client's flow is reproduced against the real server, the new one never draws a living
 *                              survivor the server holds dead, a solo New game ends the world at once instead of
 *                              blocking it, the welcome always tells a newcomer its own state, and the dawn wait
 *                              does not give up on a live session (source guards pin main.client.ts to that flow).
 *   9. ONCE PER WIPE           a Rebirth closes the window, a new fall opens a new one: one wipe per fall of the last
 *                              survivor, never one per death.
 *
 * The review of f851ad2 (each of these fails on that commit):
 *
 *  10. STILL LOADING (B1)      a reconnect whose save is in flight when the world ends is not counted by rule 6 and
 *                              gets no free revive from the CLOSED session's table; the new life it is owed is granted
 *                              when its save loads, before the client sees it, and that is what the DataStore keeps.
 *  11. LEFT IN THE WINDOW (M1) a dead survivor who leaves during the window comes back to the same new life (day 1,
 *                              starter kit), standing in the new town — not to the old backpack and life day.
 *  12. THE NEWS, AT ONCE (B2)  the WorldReset goes out in the reset's own heartbeat, after the old town's last events
 *                              (L3) and ahead of the stand-ups, naming the runRev the server wrote; an old-life report
 *                              is refused with a wallet on that same runRev.
 *  13. ALL OR NOTHING (M2)     a generator or a system that throws half-way changes nothing: no failed tick, the old
 *                              world whole (clock hook included), a warning in the log; the time to generate is logged.
 *  14. THE CLIENT TAKES IT     source guards on main.client.ts / netClient.ts for B2, L1, L2, L4 and the snapshot guard.
 *
 * The review of de4ba1e (each of these fails on it):
 *
 *  15. PLAYED WITHOUT SAVING   the save cannot be read at join, the survivor plays on the blank read-only one, and a
 *      (N1, R3b, N4)           Retry loads the real save: a world that ended meanwhile owes that real save nothing
 *                              (N1, also with R3b's fix switched off), nothing the blank body lived through — its
 *                              death, or its being alive — carries into the real save (R3b), a pending retry holds
 *                              the entry, and a Retry from inside the world is not run under the body (N4).
 *  16. COMMITTED (N2)          closeTown or lives.restartWorld throwing after the switch: the clients still get the
 *                              WorldReset, the host's seed and attribute are the simulation's town, nobody is left
 *                              dead, the failure is logged, and rule 6 is armed again.
 *
 * The review of the F5 save-path fix:
 *
 *  18. OWED, THEN A THROW      the load step that meets the kept body (lives.adopt) grants the owed new life and then
 *                              throws: the new life stays on the save the session keeps (it is granted only once).
 *
 * The owner's question of 2026-09-24 ("the first player dies or leaves: does the server die?"):
 *
 *  19. NOBODY IS THE HOST      everybody leaving standing leaves the same world going on; everybody dying and then
 *                              leaving inside the window ends it at the last departure (leaving is declining, MP-22 --
 *                              it used to close the window as if the world were merely empty, and the lost world went
 *                              on for the next player); the first leaving standing with only a dead one left opens it.
 *
 * Pure Node (>= 18) + the project's TypeScript, through tools/luau-shim.mjs, plus the small fake Roblox below (the
 * same one tools/test-body.mjs uses).
 */
import { readFileSync } from "node:fs";
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
const info = msg => console.log(`        ${msg}`);
/** PZ_RESET_ONLY=19 runs only the sections whose title starts with it (a quicker loop while working on one) */
const ONLY = process.env.PZ_RESET_ONLY;
function section(title, fn) {
	if (ONLY !== undefined && !title.startsWith(ONLY)) return;
	console.log(`\n${title}`);
	try {
		fn();
	} catch (e) {
		failures += 1;
		console.log(`  FAIL  the section threw: ${e?.stack?.split("\n").slice(0, 3).join(" | ") ?? e}`);
	}
}
const f1 = v => (typeof v === "number" ? v.toFixed(1) : String(v));

// ---------------------------------------------------------------- the fake Roblox (as tools/test-body.mjs)

/** a thread that yields (task.wait, Signal:Wait) is abandoned there: nothing under test needs it resumed */
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
/** every line the server printed, so a test can read the log the owner reads in Studio */
const printed = [];
globalThis.print = (...a) => {
	printed.push(a.join(" "));
	if (printed.length > 4000) printed.splice(0, 2000);
	if (VERBOSE) console.log("        [print]", ...a);
};
/** every warning, for the same reason */
const warned = [];
globalThis.warn = (...a) => {
	const line = a.join(" ");
	warned.push(line);
	if (warned.length > 4000) warned.splice(0, 2000);
	if (line.includes("tick failed")) tickErrors.push(line);
	if (VERBOSE) console.log("        [warn]", line);
};
globalThis.os = { clock: () => clockNow, time: () => Math.floor(1_700_000_000 + clockNow) };
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
			else if (conv === "x") s = (Number(v) >>> 0).toString(16);
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
	/** Roblox guarantees no order between connections: this fires them the other way round */
	FireReversed(...args) {
		for (const h of [...this.handlers].reverse()) if (h.on) runThread(h.fn, args);
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
	FireClient(player, ...args) {
		this.sent.push({ to: player, args });
		if (this.sent.length > 20000) this.sent.splice(0, 10000);
	}
	FireAllClients(...args) {
		this.sent.push({ to: undefined, args });
		if (this.sent.length > 20000) this.sent.splice(0, 10000);
	}
}
globalThis.Instance = Inst;

/** key → what runs while the next UpdateAsync on it is "in flight" (see `holdLoad`) */
const loadHolds = new Map();

/** Roblox's DataStores outlive a server: one map per store name for the whole run */
const stores = new Map();
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function fakeStore(name) {
	let s = stores.get(name);
	if (s !== undefined) return s;
	const data = new Map();
	s = {
		data,
		UpdateAsync(key, transform) {
			// a load held open (`holdLoad`): the world goes on — heartbeats and all — while this request is in flight,
			// the way a real DataStore call yields; it completes, with what the store holds, when `during` returns
			const hold = loadHolds.get(key);
			if (hold !== undefined) {
				loadHolds.delete(key);
				hold();
			}
			const next = transform(clone(data.get(key)));
			if (next !== undefined) data.set(key, clone(next));
			return [next];
		},
		GetAsync: key => [clone(data.get(key))],
		SetAsync: (key, v) => data.set(key, clone(v)),
	};
	stores.set(name, s);
	return s;
}

let guid = 0;
function makeGame() {
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
	const RunService = { Heartbeat: new Signal(), IsStudio: () => false, IsServer: () => true, IsClient: () => false };
	const HttpService = {
		GenerateGUID: () => `guid-${++guid}`,
		JSONEncode: v => JSON.stringify(v),
		JSONDecode: s => JSON.parse(s),
	};
	const DataStoreService = { GetDataStore: name => fakeStore(name), GetRequestBudgetForRequestType: () => 100 };
	const services = {
		ReplicatedStorage,
		Workspace,
		Players,
		RunService,
		HttpService,
		DataStoreService,
		TextChatService: new Inst("TextChatService"),
		TextService: {},
	};
	const closers = [];
	globalThis.game = {
		GetService(name) {
			const s = services[name];
			if (s === undefined) throw new Error(`the fake Roblox has no ${name}`);
			return s;
		},
		JobId: `job-${++guid}`,
		PrivateServerId: "",
		PrivateServerOwnerId: 0,
		PlaceId: 1,
		PlaceVersion: 1,
		BindToClose: fn => closers.push(fn),
	};
	return { services, closers };
}

function makePlayer(userId, name) {
	const p = new Inst("Player");
	p.Name = name;
	p.UserId = userId;
	p.DisplayName = name;
	p.Kick = () => {};
	p.GetNetworkPing = () => 0.05;
	return p;
}

// ---------------------------------------------------------------- a server "process"

function bootServer() {
	for (const k of Object.keys(require.cache)) if (k.startsWith(SRC)) delete require.cache[k];
	const env = makeGame();
	require(join(SRC, "server/main.server.ts"));
	const host = require(join(SRC, "server/net/mpHost.ts")).activeMpHost();
	if (host === undefined) throw new Error("main.server.ts did not start the MP host (MP_PHASE < 1?)");
	const P = require(join(SRC, "shared/net/protocol.ts"));
	const { SAVE_STORE, WORLD_LOG_STORE } = require(join(SRC, "server/save/stores.ts"));
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
		get sim() {
			return host.simulation;
		},
		Workspace,
		join(userId, name = `p${userId}`) {
			const p = makePlayer(userId, name);
			p._parent = Players;
			Players.list.push(p);
			Players.PlayerAdded.Fire(p);
			remote("LoadRequest").OnServerEvent.Fire(p);
			return p;
		},
		/**
		 * A join whose save load stays in flight while `during()` runs — the world ticking on, the way a DataStore
		 * call yields in Roblox — and completes afterwards with what the store holds. mpHost's PlayerAdded handler
		 * runs FIRST here (Roblox promises no order), so the host knows the player before their save is here.
		 */
		joinLoading(userId, name, during) {
			loadHolds.set(String(userId), during);
			const p = makePlayer(userId, name);
			p._parent = Players;
			Players.list.push(p);
			Players.PlayerAdded.FireReversed(p);
			remote("LoadRequest").OnServerEvent.Fire(p);
			return p;
		},
		/**
		 * A join whose stored save cannot be read (not valid JSON): main.server.ts opens a READ-ONLY session on a
		 * blank save, status "error" — the "Progress not loaded" popup, with "Play without saving" and "Retry". The
		 * client's LoadRequest lands while the load is in flight, as it does in Roblox, so the LoadAck goes out.
		 */
		joinUnreadable(userId, name) {
			const store = fakeStore(SAVE_STORE).data;
			store.set(String(userId), { ...(store.get(String(userId)) ?? {}), data: "{not json" });
			const p = makePlayer(userId, name);
			loadHolds.set(String(userId), () => remote("LoadRequest").OnServerEvent.Fire(p));
			p._parent = Players;
			Players.list.push(p);
			Players.PlayerAdded.Fire(p);
			return p;
		},
		/** the DataStore holds `save` for this user from now on (the lock the session took is kept) */
		putStored(userId, save) {
			const store = fakeStore(SAVE_STORE).data;
			store.set(String(userId), { ...(store.get(String(userId)) ?? {}), data: JSON.stringify(save) });
		},
		/** "Retry" on the "Progress not loaded" popup: a LoadRequest; `during` runs while that load is in flight */
		retry(p, during) {
			if (during !== undefined) loadHolds.set(String(p.UserId), during);
			remote("LoadRequest").OnServerEvent.Fire(p);
		},
		/** the status of the last LoadAck `p` was sent ("ok", "new", "error", …) */
		loadStatus(p) {
			const acks = remote("LoadAck").sent.filter(e => e.to === p);
			return acks[acks.length - 1]?.args[0]?.status;
		},
		/** the World channel as sent so far (raw), for tests that care about WHEN something went out */
		worldSent() {
			return remote("World").sent;
		},
		snapSent() {
			return remote("Snap").sent;
		},
		printed,
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
		/** one raw Input payload from `p`, as the client's UnreliableRemoteEvent delivers it */
		input(p, payload) {
			remote("Input").OnServerEvent.Fire(p, payload);
		},
		/** a TimePing from `p`; returns the TimePongs the server has sent `p` so far, decoded */
		timeSync(p, payload) {
			if (payload !== undefined) remote("TimeSync").OnServerEvent.Fire(p, payload);
			return remote("TimeSync")
				.sent.filter(e => e.to === p)
				.map(e => P.decodeTimePong(e.args[0]))
				.filter(x => x !== undefined);
		},
		enter(p) {
			server.intent(p, P.IntentKind.EnterWorld);
			server.run(0.6);
			return server.body(p);
		},
		exit(p) {
			server.intent(p, P.IntentKind.LeaveWorld);
			server.beat();
		},
		shop(p, req) {
			return remote("ShopAction").OnServerInvoke(p, req);
		},
		/** a client progress report (SaveRequest) of the live save with `fields` overridden; returns the SaveAck */
		report(p, fields) {
			const acks = remote("LoadAck").sent.filter(e => e.to === p);
			const token = acks[acks.length - 1]?.args[0]?.token;
			remote("SaveRequest").OnServerEvent.Fire(p, token, JSON.stringify({ ...server.save(p), ...fields }));
			return remote("SaveAck")
				.sent.filter(e => e.to === p)
				.pop()?.args[0];
		},
		body(p) {
			return host.playerOf(p);
		},
		/** how far the World channel has got: pass it to `lifeSince` to read only what came after */
		mark() {
			return remote("World").sent.length;
		},
		/**
		 * The PlayerLife states `p`'s client reads about ITSELF from index `from` of the World channel, in order — its
		 * slot learnt from the PlayerJoined naming its UserId, exactly as client/net/netClient.ts learns it.
		 */
		lifeSince(p, from = 0) {
			const out = [];
			let mySlot = server.body(p)?.slot ?? -1;
			const sent = remote("World").sent;
			for (let i = from; i < sent.length; i++) {
				const e = sent[i];
				if (e.to !== undefined && e.to !== p) continue;
				const batch = P.decodeWorld(e.args[0]);
				if (batch === undefined) continue;
				for (const ev of batch.events) {
					if (ev.t === P.WorldEv.PlayerJoined && ev.userId === p.UserId) {
						mySlot = ev.slot;
						out.push("joined");
					}
					if (ev.t === P.WorldEv.PlayerLife && ev.slot === mySlot) {
						out.push(
							ev.state === P.LifeState.Dead ? "dead" : ev.state === P.LifeState.Up ? "up" : `${ev.state}`,
						);
					}
					if (ev.t === P.WorldEv.WorldReset) out.push("reset");
				}
			}
			return out;
		},
		/** every World batch sent so far, decoded, with who it went to (undefined = FireAllClients) */
		worldLog() {
			const out = [];
			for (const e of remote("World").sent) {
				const batch = P.decodeWorld(e.args[0]);
				if (batch !== undefined) out.push({ to: e.to, events: batch.events });
			}
			return out;
		},
		clearWorldLog() {
			remote("World").sent.length = 0;
		},
		kill(p) {
			const sp = server.body(p);
			sp.state.godMode = false;
			server.sim.combat.damageActor(sp.slot, sp.state, sp.save, sp.state.hpMax * 10, true);
			server.beat();
			server.beat();
			return sp;
		},
		stored(userId) {
			const doc = fakeStore(SAVE_STORE).data.get(String(userId));
			if (doc === undefined) return undefined;
			return typeof doc.data === "string" ? JSON.parse(doc.data) : doc.data;
		},
		/** the shared document of ended worlds (server/save/worldLog.ts) */
		endedWorlds() {
			return fakeStore(WORLD_LOG_STORE).data.get("ended");
		},
		immortal: new Set(),
		beat(dt = 1 / 60) {
			clockNow += dt;
			for (let i = timers.length - 1; i >= 0; i--) {
				// a timer may run the world on inside it (a load held open by `retry`), firing other timers meanwhile
				const t = timers[i];
				if (t !== undefined && t.at <= clockNow) {
					timers.splice(timers.indexOf(t), 1);
					t.fn();
				}
			}
			for (const p of server.immortal) {
				const sp = host.playerOf(p);
				if (sp !== undefined && !sp.state.dead) {
					sp.state.godMode = true;
					sp.state.hungry = Math.max(sp.state.hungry, 1);
				}
			}
			RunService.Heartbeat.Fire(dt);
			if (tickErrors.length > 0)
				throw new Error(`the simulation tick failed: ${tickErrors.splice(0).join(" | ")}`);
		},
		run(seconds, dt = 1 / 60) {
			const n = Math.round(seconds / dt);
			for (let i = 0; i < n; i++) server.beat(dt);
		},
		shutdown() {
			for (const fn of env.closers) runThread(fn, []);
		},
		/** every `onWorldWiped` the host passed on to main.server.ts, through the keeper's own hook (chained) */
		wipes() {
			const lives = host.lives;
			if (lives.__wipes === undefined) {
				lives.__wipes = [];
				const prev = lives.onWorldWiped;
				lives.onWorldWiped = r => {
					lives.__wipes.push(r);
					r.sentBefore = remote("World").sent.length;
					server.beforeReset?.(r);
					prev?.(r);
					// the clock the moment the new world began (the harness keeps ticking after it), and what the
					// World channel had sent by the time the hook returned — in the SAME heartbeat as the reset
					r.clockAfter = { day: host.simulation.clock.day, dayTime: host.simulation.clock.dayTime };
					r.sentAfter = remote("World").sent.length;
				};
			}
			return lives.__wipes;
		},
	};
	return server;
}

const W = () => require(join(SRC, "shared/game/world.ts"));
const R = () => require(join(SRC, "server/net/replication.ts"));
const PHYS = () => require(join(SRC, "shared/game/physics.ts"));
const SAVE = () => require(join(SRC, "shared/game/save.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));

let nextUser = 7000;
const newUser = () => ++nextUser;

/** the progression MP-22 says a player KEEPS across the end of a world */
function progressionOf(save) {
	return JSON.stringify({
		level: save.level,
		exp: save.exp,
		skillPoint: save.skillPoint,
		skillLevels: save.skillLevels,
		money: save.money,
		packsBought: save.packsBought,
		packsOpened: save.packsOpened,
		costumes: save.costumes,
		bestDay: save.bestDay,
		achievements: save.achievements,
	});
}

/** a veteran of the world about to end: levels, skills, coins, a costume, a pack, a full backpack, life day 9 */
function veteran(save) {
	save.level = 14;
	save.exp = 33;
	save.skillPoint = 2;
	save.skillLevels[0] = 3;
	save.skillLevels[4] = 1;
	save.money = 0; // no coins: the Rebirth is not an option, the window only waits
	save.costumes[0] = 1;
	save.packsBought[0] = 1;
	save.packsOpened[0] = 1;
	save.day = 9;
	save.bestDay = 9;
	save.invenWeapon[10] = 1; // the pistol
	save.equipWeapon = 10;
	save.ammoNormal = 40;
	save.invenEtc[0] = 12;
}

// ================================================================ 1: everybody dies

section("1) everybody dies: after the 30 s window the world ends ONCE and a new town begins on day 1", () => {
	const { WIPE_DECISION_S } = require(join(SRC, "server/sim/life.ts"));
	const s = bootServer();
	const wipes = s.wipes();
	const idA = newUser();
	const idB = newUser();
	const a = s.join(idA, "alma");
	const b = s.join(idB, "bento");
	veteran(s.save(a));
	veteran(s.save(b));
	s.save(b).money = 3; // coins, but not enough for a Rebirth: nobody pays
	s.enter(a);
	s.enter(b);
	s.immortal.add(a);
	s.immortal.add(b);
	// a few days into this world, with a horde walking it
	s.sim.clock.setClock(10, 4);
	s.run(20);
	const oldWorld = s.sim.world;
	const oldHorde = s.sim.horde;
	const oldZombies = [...(oldHorde?.zombies ?? [])];
	const oldSeed = s.host.seed;
	const oldDay = s.sim.clock.day;
	const keepA = progressionOf(s.save(a));
	const keepB = progressionOf(s.save(b));
	const revA = s.save(a).runRev;
	check(
		oldSeed === DESIGN.TOWN_SEED,
		"a server opens on the town every client knows (DESIGN.TOWN_SEED)",
		`${oldSeed}`,
	);
	check(
		s.Workspace.GetAttribute("pz_world_seed") === oldSeed,
		"…and says so in the replicated attribute a client reads before it enters",
	);
	info(`the old world: day ${oldDay}, ${oldZombies.length} zombies walking it`);

	s.immortal.clear();
	s.kill(a);
	s.kill(b);
	s.clearWorldLog();
	check(s.host.lives.wipeWindowOpen(), "the last survivor falls: the 30 s decision window opens");
	s.run(WIPE_DECISION_S - 1);
	check(wipes.length === 0 && s.sim.world === oldWorld, `…and nothing ends before ${WIPE_DECISION_S} s`);
	s.run(1.5);
	check(wipes.length === 1 && wipes[0].reason === "timeout", "nobody paid: the world ends", JSON.stringify(wipes));

	// ---- the new town
	const newSeed = s.host.seed;
	check(newSeed !== oldSeed && newSeed >= 1 && newSeed <= 2147483646, "…with a NEW seed", `${oldSeed} → ${newSeed}`);
	check(s.sim.world !== oldWorld && s.host.world === s.sim.world, "…and a new town, the one the host serves");
	const fresh = W().generateTown(newSeed);
	check(
		R().mapHashOf(s.sim.world) === R().mapHashOf(fresh),
		"…generated from that seed exactly as a client will generate it (same map hash)",
		`${R().mapHashOf(s.sim.world)}`,
	);
	check(
		s.Workspace.GetAttribute("pz_world_seed") === newSeed,
		"the replicated attribute names the new town for whoever presses Play next",
	);
	const reborn = wipes[0]?.clockAfter;
	check(
		reborn !== undefined && reborn.day === 1 && reborn.dayTime === 7,
		"the clock is back to day 1, 07:00 the moment the new world begins",
		reborn !== undefined ? `day ${reborn.day} ${reborn.dayTime} h` : "",
	);
	check(s.sim.horde !== oldHorde && s.sim.horde.world === s.sim.world, "a new horde, built around the new town");
	const survivors = oldZombies.filter(z => s.sim.horde.zombies.includes(z)).length;
	check(survivors === 0, "…and not one zombie of the old one walks into it", `${survivors} carried over`);
	check(
		s.sim.clock.waveQueues.every(q => q === 0) && s.sim.clock.specialWaveQueues.every(q => q === 0),
		"…nor a wave promised to the old one's night",
	);

	// ---- the lives
	for (const [p, keep, name] of [
		[a, keepA, "alma"],
		[b, keepB, "bento"],
	]) {
		const sp = s.body(p);
		const save = s.save(p);
		check(
			sp !== undefined && !sp.state.dead && sp.state.hp === sp.state.hpMax,
			`${name} stands in the new town, alive and at full health`,
			sp !== undefined ? `dead ${sp.state.dead}, hp ${f1(sp.state.hp)}/${sp.state.hpMax}` : "no body",
		);
		check(
			sp !== undefined && PHYS().circleBlocked(s.sim.world, sp.state.x, sp.state.y, 20) === undefined,
			"…on free ground of the NEW town (MP-04)",
			sp !== undefined ? `${f1(sp.state.x)}, ${f1(sp.state.y)}` : "",
		);
		check(sp !== undefined && s.sim.spawnShielded(sp), "…with the 3 s spawn shield");
		check(save.day === 1 && save.runOver === false, "…on day 1 of a new life (MP-20)", `day ${save.day}`);
		check(
			save.invenWeapon[10] === 0 && save.ammoNormal === 0 && save.invenEtc[0] === 0,
			"…with the starter kit, not the old life's backpack",
			`pistol ${save.invenWeapon[10]}, ammo ${save.ammoNormal}, etc ${save.invenEtc[0]}`,
		);
		check(progressionOf(save) === keep, "…and keeps level, skills, coins, packs, costumes and records");
	}
	check(s.save(a).runRev === revA + 1, "the run moved on (runRev), so a report of the old life is refused");
	s.run(2); // past SAVE_MIN_INTERVAL, so the report is judged now and not queued
	const ack = s.report(a, { runRev: revA, day: 9, invenWeapon: s.save(a).invenWeapon.map(() => 1), ammoNormal: 40 });
	check(
		ack?.ok === false &&
			ack?.reason === "outdated" &&
			s.save(a).invenWeapon[10] === 0 &&
			s.save(a).ammoNormal === 0,
		"…and it is: a report of the old backpack is refused as outdated, and nothing of it comes back",
		JSON.stringify({ ok: ack?.ok, reason: ack?.reason }),
	);

	// ---- the wire
	const log = s.worldLog();
	const events = log.flatMap(b => b.events.map(e => ({ to: b.to, e })));
	const resets = events.filter(x => x.e.t === s.P.WorldEv.WorldReset);
	check(
		resets.length === 1 && resets[0].to === undefined,
		"ONE WorldReset, to every connected client (FireAllClients: the lobby too)",
		`${resets.length}`,
	);
	const wr = resets[0]?.e;
	check(
		wr !== undefined && wr.seed === newSeed && wr.endedDay === oldDay,
		"…naming the new seed and the day the old town fell on",
		wr !== undefined ? `seed ${wr.seed}, fell on day ${wr.endedDay}` : "",
	);
	const livesOf = id => wr?.lives.find(l => l.userId === id);
	check(
		wr !== undefined && livesOf(idA) !== undefined && livesOf(idB) !== undefined && wr.lives.length === 2,
		"…and the survivors whose life starts over",
		wr !== undefined ? JSON.stringify(wr.lives) : "",
	);
	check(
		livesOf(idA)?.runRev === s.save(a).runRev && livesOf(idB)?.runRev === s.save(b).runRev,
		"…each with the runRev the server wrote into their save (B2: the client takes it, never its own + 1)",
		`${JSON.stringify(wr?.lives)} vs ${s.save(a).runRev}/${s.save(b).runRev}`,
	);
	const at = x => events.indexOf(x);
	const ups = events.filter(x => x.e.t === s.P.WorldEv.PlayerLife && x.e.state === s.P.LifeState.Up);
	check(
		ups.length >= 2 && ups.every(x => at(x) > at(resets[0])),
		"the stand-ups come AFTER it, so a client rebuilds the town before it hears it is alive",
	);
	const clock = events.find(x => x.e.t === s.P.WorldEv.Clock && at(x) > at(resets[0]));
	check(
		clock !== undefined && clock.e.worldDay === 1,
		"…and so does a day-1 Clock, which a rebuilt client jumps to",
		clock !== undefined ? `day ${clock.e.worldDay}` : "none",
	);
	for (const p of [a, b]) {
		const init = events.find(x => x.to === p && x.e.t === s.P.WorldEv.InitBegin && at(x) > at(resets[0]));
		check(
			init !== undefined && init.e.seed === newSeed && init.e.mapHash === R().mapHashOf(s.sim.world),
			`${p.Name} gets the join message again: InitBegin with the new seed and map hash`,
		);
	}

	// ---- the record
	const record = s.endedWorlds();
	const last = Array.isArray(record) ? record[record.length - 1] : undefined;
	check(
		Array.isArray(record) && record.length === 1,
		"the world that ended is recorded in the DataStore",
		JSON.stringify(record),
	);
	check(
		last !== undefined &&
			last.seed === oldSeed &&
			last.days === oldDay &&
			last.reason === "timeout" &&
			last.fallen === 2 &&
			last.endedAt >= last.startedAt,
		"…with its seed, how many days it lasted, when, why and how many fell",
	);

	// ---- and only once
	s.immortal.add(a);
	s.immortal.add(b);
	s.run(40);
	check(
		wipes.length === 1 && s.host.seed === newSeed,
		"the event fired once: the new world goes on",
		`${wipes.length}`,
	);
	s.quit(a);
	const doc = s.stored(idA);
	check(
		doc?.day === 1 && doc?.level === 14 && doc?.runOver === false,
		"what reaches the player's save: day 1 of a new life, the level kept",
		`day ${doc?.day}, level ${doc?.level}`,
	);
});

// ================================================================ 2: a Rebirth in the window

section("2) a Rebirth inside the window keeps the world — and solo still makes sense", () => {
	const { WIPE_DECISION_S } = require(join(SRC, "server/sim/life.ts"));
	{
		const s = bootServer();
		const wipes = s.wipes();
		const a = s.join(newUser(), "payer");
		const b = s.join(newUser(), "waiter");
		s.enter(a);
		s.enter(b);
		s.save(a).money = 100;
		s.sim.clock.setClock(20, 3);
		const world = s.sim.world;
		s.kill(a);
		s.kill(b);
		s.run(10);
		const res = s.shop(a, { kind: "rebirth", runRev: s.save(a).runRev });
		check(res.ok === true, "two down, one pays a Rebirth ten seconds in");
		s.run(WIPE_DECISION_S + 5);
		check(
			wipes.length === 0 && s.sim.world === world && s.host.seed === DESIGN.TOWN_SEED && s.sim.clock.day === 3,
			"…so the world goes on: same town, same day, no reset",
			`${wipes.length} wipe(s), day ${s.sim.clock.day}`,
		);
	}
	{
		const s = bootServer();
		const wipes = s.wipes();
		const solo = s.join(newUser(), "solo");
		s.enter(solo);
		const save = s.save(solo);
		save.money = 100;
		save.day = 6;
		s.sim.clock.setClock(21, 6);
		s.kill(solo);
		s.run(WIPE_DECISION_S - 5);
		check(wipes.length === 0, "alone and dead with coins: the window is still open after 25 s");
		const res = s.shop(solo, { kind: "rebirth", runRev: save.runRev });
		check(res.ok === true && s.body(solo)?.state.dead === false, "…the Rebirth goes through, and they stand");
		s.run(WIPE_DECISION_S + 5);
		check(
			wipes.length === 0 && s.host.seed === DESIGN.TOWN_SEED && save.day === 6,
			"…and the run and the world continue (the life day is kept)",
			`${wipes.length} wipe(s), life day ${save.day}`,
		);
	}
});

// ================================================================ 3: everybody declined

section(
	"3) New game + Home: the world ends at once; the lobby comes back to the NEW town; bystanders keep their life",
	() => {
		const s = bootServer();
		const wipes = s.wipes();
		const quitter = s.join(newUser(), "quitter");
		const leaver = s.join(newUser(), "leaver");
		const idle = s.join(newUser(), "idle");
		s.save(idle).day = 5;
		const idleRev = s.save(idle).runRev;
		s.enter(quitter);
		s.enter(leaver);
		s.save(leaver).day = 4;
		s.sim.clock.setClock(20, 2);
		s.kill(quitter);
		s.kill(leaver);
		s.run(2);
		s.shop(quitter, { kind: "newRun", runRev: s.save(quitter).runRev });
		s.beat();
		s.exit(leaver);
		s.beat();
		check(
			wipes.length === 1 && wipes[0].reason === "declined",
			"every dead survivor declined: the world ends at once, not in 30 s",
		);
		check(s.host.seed !== DESIGN.TOWN_SEED && s.sim.clock.day === 1, "…a new town on day 1");
		check(s.body(quitter)?.state.dead === false, "the one who chose New game is up in the new town");
		check(s.save(leaver).day === 1 && s.save(leaver).runOver === false, "the one who went Home has a new life too");
		check(s.host.lives.isDead(leaver.UserId, s.save(leaver)) === false, "…and the server knows them alive");
		const back = s.enter(leaver);
		check(
			back !== undefined && !back.state.dead && back.state.hp === back.state.hpMax,
			"…so Play puts them in the new town standing, at full health",
		);
		check(
			back !== undefined && PHYS().circleBlocked(s.sim.world, back.state.x, back.state.y, 20) === undefined,
			"…on free ground of the new town",
		);
		check(
			s.save(idle).day === 5 && s.save(idle).runRev === idleRev,
			"someone who never entered the old world keeps their life untouched",
			`day ${s.save(idle).day}`,
		);
		const inWorld = s.enter(idle);
		check(inWorld !== undefined && !inWorld.state.dead, "…and walks into the new town when they press Play");
	},
);

// ================================================================ 4: the ones who left

section("4) a survivor who left the server keeps their life, never a spot in a town that is gone", () => {
	const s = bootServer();
	const wipes = s.wipes();
	const idGone = newUser();
	let gone = s.join(idGone, "gone");
	const spGone = s.enter(gone);
	s.immortal.add(gone);
	s.save(gone).day = 3;
	spGone.state.hp = 61;
	s.beat();
	s.quit(gone);
	check(s.host.lives.keptBody(idGone) !== undefined, "they left alive: the body is kept for 5 min (§7.2)");
	const last = s.join(newUser(), "last");
	s.enter(last);
	s.kill(last);
	s.run(31);
	check(wipes.length === 1, "the one survivor still here falls: the world ends (the absent do not count)");
	check(s.host.lives.keptBody(idGone) === undefined, "the kept body is forgotten with the town it stood in");
	gone = s.join(idGone, "gone");
	const back = s.enter(gone);
	check(back !== undefined && !back.state.dead, "back on the server, they enter the new town alive");
	check(
		back !== undefined && Math.floor(back.state.hp) === 61,
		"…with the life they left with (hp from the save, rule 2)",
		`hp ${f1(back?.state.hp)}`,
	);
	check(s.save(gone).day === 3, "…and their own life day, since they did not fall with the world");
	check(
		back !== undefined && PHYS().circleBlocked(s.sim.world, back.state.x, back.state.y, 20) === undefined,
		"…on free ground of the NEW town",
	);
});

// ================================================================ 5: the F3 world

section("5) with the server owning the interactive world, nothing of the old world survives into the new one", () => {
	const { ServerSimulation } = require(join(SRC, "server/sim/simulation.ts"));
	const { LifeKeeper } = require(join(SRC, "server/sim/life.ts"));
	const { endWorld } = require(join(SRC, "server/sim/worldReset.ts"));
	const { Replicator, mapHashOf } = R();
	const { isDoor } = require(join(SRC, "shared/sim/interactQuery.ts"));
	const world = W().generateTown(DESIGN.TOWN_SEED);
	const sim = new ServerSimulation({ world, zombies: true, interactive: true });
	const sent = [];
	const replicator = new Replicator(
		sim,
		{ snap() {}, fx() {}, world: (slot, pkt) => sent.push({ slot, pkt }), worldAll: pkt => sent.push({ pkt }) },
		{ tick0Time: 0, mapHash: mapHashOf(world) },
	);
	sim.onTick = t => replicator.afterTick(t);
	const lives = new LifeKeeper(sim, { welcome: sp => replicator.welcome(sp), left() {}, life() {} });
	const save = SAVE().defaultSave();
	const sp = lives.enter({ userId: 42, name: "builder" }, save);
	for (let i = 0; i < 60; i++) sim.step();
	// the old world, lived in: an item on the ground, a construction, an open door, a night promised
	const item = W().spawnGroundItem(world, 1, 0, 1, sp.state.x + 40, sp.state.y);
	const tpl = world.solids.find(x => x.kind === "tree") ?? world.solids[0];
	const built = W().addSolid(world, { ...tpl, id: undefined, x: tpl.x + 3, placeable: 1, owner: sp.slot });
	const door = world.solids.find(x => isDoor(x));
	if (door !== undefined) door.open = true;
	sim.clock.setClock(18.2, 5);
	sim.clock.fillNight();
	const old = {
		items: sim.items,
		build: sim.build,
		craft: sim.craft,
		interaction: sim.interaction,
		horde: sim.horde,
	};
	check(
		world.items.includes(item) && world.solids.includes(built),
		"the old world has a ground item and a construction",
	);
	check(
		sim.clock.waveQueues.some(q => q > 0),
		"…and tonight's waves are promised",
	);

	const out = endWorld(
		{ sim, lives, replicator },
		{ day: 5, reason: "timeout", dead: [42] },
		{ seed: DESIGN.TOWN_SEED, startedAt: 100 },
		{ now: 200, job: "job-test", saveOf: () => save, seed: 12345 },
	);
	check(
		out.seed === 12345 && sim.world === out.world && sim.world !== world,
		"the simulation stands in the new town",
	);
	check(sim.world.items.length === 0, "no ground item of the old world", `${sim.world.items.length}`);
	check(
		sim.world.solids.every(x => x.placeable === undefined),
		"no construction (and so no campfire burning) of the old world",
	);
	check(
		sim.world.solids.filter(x => isDoor(x)).every(x => x.open !== true),
		"every door of the new town is shut",
	);
	check(
		sim.items !== old.items && sim.items.world === sim.world && sim.build !== old.build,
		"items, loot and constructions are new systems, built around the new town",
	);
	check(
		sim.craft !== old.craft && sim.interaction !== old.interaction && sim.horde !== old.horde,
		"…and so are crafting, interaction and the horde",
	);
	check(
		world.onItemAdd === undefined && world.onSolidAdd === undefined,
		"the old town no longer feeds the outbox (its hooks are detached)",
	);
	check(
		sim.world.nextDynamicId >= 1000000,
		"the new town is a SERVER world (its dynamic ids start at 1 000 000, §4.5)",
		`${sim.world.nextDynamicId}`,
	);
	check(
		sim.clock.day === 1 && sim.clock.waveQueues.every(q => q === 0) && !sim.clock.wave1Active,
		"day 1, and the night that was promised to the old world is not owed to the new one",
	);
	check(
		out.ended.seed === DESIGN.TOWN_SEED &&
			out.ended.days === 5 &&
			out.ended.startedAt === 100 &&
			out.ended.endedAt === 200 &&
			out.ended.job === "job-test",
		"the record says which world ended, when, and after how many days",
	);
	const newBody = sim.get(sp.slot);
	check(
		newBody !== undefined && !newBody.state.dead && save.day === 1,
		"the builder starts a new life in the new town",
	);
	for (let i = 0; i < 120; i++) sim.step();
	check(true, "…and the new world ticks on (two seconds of it without an error)");
});

// ================================================================ 6: the wire and the record

section("6) the wire and the record", () => {
	const P = require(join(SRC, "shared/net/protocol.ts"));
	const { pickTownSeed, appendEnded, readEndedWorld, readEndedList, WORLD_LOG_KEEP } = require(
		join(SRC, "server/sim/worldReset.ts"),
	);
	const reset = {
		t: P.WorldEv.WorldReset,
		seed: 2147483646,
		endedDay: 17,
		lives: [
			{ userId: 123456789, runRev: 12 },
			{ userId: -3, runRev: 0 },
			{ userId: 9000000001, runRev: 10000000 },
		],
	};
	const init = {
		t: P.WorldEv.InitBegin,
		mapHash: 4000000000,
		seed: 99,
		tick0Time: 12.5,
		simHz: 60,
		chunk: 0,
		chunks: 1,
	};
	const pkt = P.encodeWorld({ tick: 3, events: [reset, init] }).packets[0];
	const got = P.decodeWorld(pkt);
	check(
		got !== undefined && JSON.stringify(got.events[0]) === JSON.stringify(reset),
		"WorldReset round-trips: seed, the day it fell on, the new lives",
		got !== undefined ? JSON.stringify(got.events[0]) : "did not decode",
	);
	check(
		got !== undefined && got.events[1].seed === 99 && got.events[1].mapHash === 4000000000,
		"InitBegin carries the seed next to the map hash",
	);
	const bytes = pkt.bytes !== undefined ? Array.from(pkt.bytes) : undefined;
	if (bytes !== undefined) {
		const bufOf = arr => {
			const b = buffer.create(arr.length);
			for (let i = 0; i < arr.length; i++) buffer.writeu8(b, i, arr[i]);
			return b;
		};
		// header 5 B, tag 1 B, then the seed (u32 little-endian)
		const zeroSeed = bytes.slice();
		zeroSeed[6] = 0;
		zeroSeed[7] = 0;
		zeroSeed[8] = 0;
		zeroSeed[9] = 0;
		check(P.decodeWorld(bufOf(zeroSeed)) === undefined, "a WorldReset with seed 0 (no town) is refused");
		const noDay = bytes.slice();
		noDay[10] = 0;
		noDay[11] = 0;
		check(P.decodeWorld(bufOf(noDay)) === undefined, "…and one that fell on day 0");
		const tooMany = bytes.slice();
		tooMany[12] = 200;
		check(P.decodeWorld(bufOf(tooMany)) === undefined, "…and one that names more lives than it carries");
	}
	let same = 0;
	for (let i = 0; i < 2000; i++) if (pickTownSeed(7331) === 7331) same += 1;
	check(same === 0, "a new seed is never the old one (2000 draws)");
	check(pickTownSeed(5, () => 5) !== 5 && pickTownSeed(5, () => 5) >= 1, "…not even with a roll stuck on it");
	check(pickTownSeed(2147483646, () => 0) === 1, "…and it wraps inside 1 … TOWN_SEED_MAX");
	const list = [];
	for (let i = 0; i < WORLD_LOG_KEEP + 7; i++) {
		appendEnded(list, { seed: i + 1, days: 1, startedAt: 0, endedAt: 1, reason: "timeout", fallen: 1, job: "" });
	}
	check(list.length === WORLD_LOG_KEEP && list[0].seed === 8, "the stored list is bounded, oldest dropped first");
	check(
		readEndedWorld({ seed: 0, days: 1, startedAt: 0, endedAt: 0 }) === undefined,
		"a record with no town is dropped",
	);
	check(
		readEndedWorld("garbage") === undefined && readEndedList(42).length === 0,
		"garbage in the document is dropped",
	);
	const clean = readEndedWorld({ seed: 7, days: 3, startedAt: 1, endedAt: 2, reason: "?", fallen: -1, job: 5 });
	check(
		clean !== undefined && clean.reason === "timeout" && clean.fallen === 0 && clean.job === "",
		"…and a half-good one is cleaned, not trusted",
	);
});

// ================================================================ 7: the client

const ts = require("typescript");
/** a client source file, parsed (the client cannot load under Node: it talks to Roblox services) */
function parse(rel) {
	const file = join(SRC, rel);
	const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
	const printer = ts.createPrinter({ removeComments: true });
	return { sf, text: node => printer.printNode(ts.EmitHint.Unspecified, node, sf) };
}
/** the body statements of the top-level function `name` of a parsed file, or [] */
function bodyOf(file, name) {
	let found;
	const visit = node => {
		if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
		else ts.forEachChild(node, visit);
	};
	visit(file.sf);
	return found?.body?.statements ? [...found.body.statements] : [];
}
const isCall = (file, st, what) => ts.isExpressionStatement(st) && file.text(st.expression) === what;

section("7) the client builds the server's town and listens for the news (source guards)", () => {
	const loop = readFileSync(join(SRC, "client/gameLoop.ts"), "utf8");
	check(!/generateTown\(\s*DESIGN\.TOWN_SEED\s*\)/.test(loop), "GameLoop no longer always builds DESIGN.TOWN_SEED");
	// the town of that seed is taken from the lobby's flyover when it already generated it (client/boot/townCache.ts,
	// npm run test:cache: same seed = that copy, a new seed or a world reset = a new town)
	check(
		/(generateTown|takeTown)\(\s*this\.townSeed\s*\)/.test(loop) && /netTownSeed\(\)/.test(loop),
		"…it builds the server's seed",
	);
	const main = readFileSync(join(SRC, "client/main.client.ts"), "utf8");
	check(/netOnTown\(\s*onTown\s*\)/.test(main), "main.client.ts listens for InitBegin / WorldReset");
	check(/resetRun\(ctx\.save\)/.test(main.slice(main.indexOf("function onTown"))), "…and mirrors the new life");
	const net = readFileSync(join(SRC, "client/net/netClient.ts"), "utf8");
	check(/WorldEv\.WorldReset/.test(net), "netClient.ts handles WorldReset");
});

// ================================================================ 8: New game is a new life, not a new body

section("8) New game never draws a living survivor the server holds dead (the owner's playtest, 23 Sep 2026)", () => {
	/*
	 * The report: solo, dead, no coins, back from the lobby, New game — "the survivor spawns and dies at the same
	 * instant, every click", and the HUD stuck on day 2. The server was right: MP-21 makes New game a new LIFE whose
	 * body still waits for daybreak. The client was not: after the server accepted `newRun` it ran `newWorld()`,
	 * which builds a fresh STANDING survivor and walks it into the world (LeaveWorld + EnterWorld), and the
	 * PlayerLife the welcome carries struck it down. (a) and (b) below replay both flows against the real server;
	 * the source guards at the end pin which one main.client.ts runs.
	 */
	const { WIPE_DECISION_S } = require(join(SRC, "server/sim/life.ts"));

	// ---- the old client's flow, reproduced: a shared world, somebody still standing
	{
		const s = bootServer();
		const w = s.join(newUser(), "witness");
		s.immortal.add(w);
		s.enter(w);
		const b = s.join(newUser(), "old-client");
		s.enter(b);
		s.save(b).money = 0;
		s.sim.clock.setClock(21);
		s.kill(b);
		const res = s.shop(b, { kind: "newRun", runRev: s.save(b).runRev });
		check(res.ok === true, "(old flow) a dead survivor's New game is accepted");
		// what the old client did next: newWorld() drew a fresh, standing survivor, then Leave + Enter
		let drawnAlive = true;
		const mark = s.mark();
		s.exit(b);
		s.intent(b, s.P.IntentKind.EnterWorld);
		s.run(0.6);
		const seen = s.lifeSince(b, mark);
		if (seen.includes("dead")) drawnAlive = false;
		check(
			seen.includes("joined") && seen[seen.length - 1] === "dead" && !drawnAlive,
			"(reproduction) the welcome of that re-entry says Dead: the standing survivor the old client drew is struck " +
				"down at once — the spawn-and-die",
			JSON.stringify(seen),
		);
	}

	// ---- (b) the flow main.client.ts runs now, same world: stay on the wait, no Leave/Enter
	{
		const s = bootServer();
		const w = s.join(newUser(), "witness");
		s.immortal.add(w);
		s.enter(w);
		const b = s.join(newUser(), "waiter");
		s.enter(b);
		s.save(b).money = 0;
		s.sim.clock.setClock(21);
		s.kill(b);
		const mark = s.mark();
		const res = s.shop(b, { kind: "newRun", runRev: s.save(b).runRev });
		check(res.ok === true && s.save(b).day === 1, "(b) somebody is standing: New game gives a new life (day 1)");
		check(
			s.body(b)?.state.dead === true,
			"…whose body the server still holds dead (MP-21), so the client stays on the wait",
		);
		s.run(3);
		check(
			s.lifeSince(b, mark).length === 0,
			"…and the server says nothing that could stand a drawn survivor up or strike one down",
			JSON.stringify(s.lifeSince(b, mark)),
		);
		const upIn = (() => {
			for (let t = 0; t < 400; t += 1) {
				if (s.body(b)?.state.dead === false) return t;
				s.run(1);
			}
			return -1;
		})();
		const seen = s.lifeSince(b, mark);
		check(
			upIn >= 0 && seen.length === 1 && seen[0] === "up",
			"daybreak stands the new life up: ONE Up, nothing before it",
			`${JSON.stringify(seen)} after ${upIn} s`,
		);
	}

	// ---- (a) solo, or everybody dead: MP-22 does the rest
	{
		const s = bootServer();
		const wipes = s.wipes();
		const solo = s.join(newUser(), "solo");
		s.enter(solo);
		s.save(solo).money = 0;
		s.save(solo).day = 2;
		s.sim.clock.setClock(10, 2);
		s.kill(solo);
		s.run(WIPE_DECISION_S + 1);
		check(
			wipes.length === 1 && s.body(solo)?.state.dead === false && s.save(solo).day === 1,
			"(a) solo, dead, no coins, nothing clicked: after the window a new town, alive, life day 1",
		);
		check(s.sim.clock.day === 1, "…and the town's day is 1 (the HUD said 2 for ever)", `day ${s.sim.clock.day}`);
	}
	{
		const s = bootServer();
		const wipes = s.wipes();
		const solo = s.join(newUser(), "clicker");
		s.enter(solo);
		s.save(solo).money = 0;
		s.sim.clock.setClock(10, 2);
		s.kill(solo);
		s.run(10);
		const mark = s.mark();
		const res = s.shop(solo, { kind: "newRun", runRev: s.save(solo).runRev });
		check(res.ok === true, "(a) solo, New game clicked ten seconds into the window");
		s.run(0.5);
		const seen = s.lifeSince(solo, mark);
		check(
			wipes.length === 1 && wipes[0].reason === "declined",
			"…does not block the end of the world: the only survivor declined, so it ends at once",
			JSON.stringify(wipes.map(x => x.reason)),
		);
		check(
			s.body(solo)?.state.dead === false && s.save(solo).day === 1 && s.save(solo).runOver === false,
			"…and they stand in the new town, life day 1",
		);
		check(
			JSON.stringify(seen) === JSON.stringify(["reset", "up"]),
			"…told in that order, and never a Dead after an Up (no spawn-and-die)",
			JSON.stringify(seen),
		);
	}

	// ---- a New game from the lobby enters the world to wait: the welcome always says the newcomer's own state
	{
		const s = bootServer();
		const w = s.join(newUser(), "witness");
		s.immortal.add(w);
		s.enter(w);
		const b = s.join(newUser(), "lobby");
		s.enter(b);
		s.save(b).money = 0;
		s.sim.clock.setClock(21);
		s.kill(b);
		s.exit(b);
		s.shop(b, { kind: "newRun", runRev: s.save(b).runRev });
		let mark = s.mark();
		s.enter(b);
		check(
			JSON.stringify(s.lifeSince(b, mark)) === JSON.stringify(["joined", "dead"]),
			"entering to wait: the welcome says Dead, which the client already drew (never a standing survivor)",
			JSON.stringify(s.lifeSince(b, mark)),
		);
		s.exit(b);
		s.run(240, 0.25);
		mark = s.mark();
		const up = s.enter(b);
		check(
			up !== undefined &&
				!up.state.dead &&
				JSON.stringify(s.lifeSince(b, mark)) === JSON.stringify(["joined", "up"]),
			"daybreak came while in the lobby: the welcome says Up, so a client that entered expecting to wait is stood up",
			JSON.stringify(s.lifeSince(b, mark)),
		);
	}

	// ---- the client runs the new flow (source guards: main.client.ts cannot load under Node)
	const main = parse("client/main.client.ts");
	const newRun = bodyOf(main, "doNewRun");
	const firstNewWorld = newRun.findIndex(st => isCall(main, st, "newWorld()"));
	const hostedAt = newRun.findIndex(
		st =>
			ts.isIfStatement(st) &&
			/hosted/.test(main.text(st.expression)) &&
			/runOver = true/.test(main.text(st.thenStatement)) &&
			/return;/.test(main.text(st.thenStatement)) &&
			!/newWorld\(\)/.test(main.text(st.thenStatement)),
	);
	check(
		hostedAt >= 0 && (firstNewWorld < 0 || hostedAt < firstNewWorld),
		"doNewRun: where the server owns the death, the accepted New game keeps the death (runOver) and returns BEFORE " +
			"newWorld() could draw a living survivor",
		`if(hosted) at ${hostedAt}, newWorld() at ${firstNewWorld}`,
	);
	const wait = bodyOf(main, "enterToWait");
	const nw = wait.findIndex(st => isCall(main, st, "newWorld()"));
	const deadAt = wait.findIndex(st => /\.dead = true/.test(main.text(st)));
	check(
		nw >= 0 &&
			deadAt > nw &&
			wait.slice(nw + 1, deadAt).every(st => !ts.isExpressionStatement(st) || !/\(/.test(main.text(st))),
		"enterToWait: the survivor it walks in is dead from the statement after newWorld(), before any frame is drawn",
	);
	const dawn = bodyOf(main, "updateDawnWait");
	const liveAt = dawn.findIndex(st => ts.isIfStatement(st) && main.text(st.expression) === "netActive()");
	const fallAt = dawn.findIndex(st => /showRunSummary/.test(main.text(st)));
	check(
		liveAt >= 0 && fallAt > liveAt,
		"(c) the wait only falls back to the end-of-run choice once the session is gone, never while the server can " +
			"still send the revive (the client gave up 12 s before it in the playtest)",
		`netActive() check at ${liveAt}, fallback at ${fallAt}`,
	);
	const lang = readFileSync(join(SRC, "shared/data/lang.ts"), "utf8");
	const gameOver = readFileSync(join(SRC, "client/onboarding/gameOver.ts"), "utf8");
	// the death screen (UI-13) tells the two endings apart instead of hedging between them: somebody standing -> you
	// wake at first light; nobody -> the town falls unless somebody pays, and a new town begins at day 1
	check(
		/"Rebirth wakes you now\. New game starts a new life at day 1,#which wakes at first light\./.test(lang) &&
			/"You wake at first light\."/.test(lang) &&
			/"No Rebirth in time: a new town begins at day 1, with a new life for everyone who fell\."/.test(lang) &&
			/tr\("You wake at first light\."\)/.test(gameOver) &&
			/tr\("No Rebirth in time: a new town begins at day 1, with a new life for everyone who fell\."\)/.test(
				gameOver,
			),
		"the texts say what really happens: first light while somebody stands, a new town at day 1 when nobody does " +
			"(lang.ts, gameOver.ts)",
	);
	check(
		!/The town is not yours to restart/.test(gameOver),
		"…and the wait no longer says the town cannot be restarted (it can: MP-22)",
	);
	{
		// the death screen counts the town's fall itself (the server does not publish its window): the same 30 s. Read
		// from the source: the client module needs the UI shims this suite does not load
		const { WIPE_DECISION_S } = require(join(SRC, "server/sim/life.ts"));
		const WORLD_WIPE_S = Number(gameOver.match(/export const WORLD_WIPE_S = (\d+(?:\.\d+)?);/)?.[1]);
		check(
			WORLD_WIPE_S === WIPE_DECISION_S,
			"the death screen's count to the town's fall (gameOver.ts WORLD_WIPE_S) is the server's window (life.ts)",
			`${WORLD_WIPE_S} s / ${WIPE_DECISION_S} s`,
		);
	}
});

// ================================================================ 9: once per wipe

section("9) onWorldWiped fires once per wipe, not once per death", () => {
	const { WIPE_DECISION_S } = require(join(SRC, "server/sim/life.ts"));
	const s = bootServer();
	const wipes = s.wipes();
	const a = s.join(newUser(), "reviver");
	const b = s.join(newUser(), "other");
	s.enter(a);
	s.enter(b);
	s.save(a).money = 500;
	s.save(b).money = 0;
	s.sim.clock.setClock(20, 3);
	s.kill(a);
	s.kill(b);
	s.run(10);
	check(
		s.shop(a, { kind: "rebirth", runRev: s.save(a).runRev }).ok === true,
		"both fall; one pays a Rebirth at 10 s",
	);
	s.run(5);
	s.kill(a);
	check(s.host.lives.wipeWindowOpen(), "…and falls again at 15 s: a NEW window opens");
	s.run(WIPE_DECISION_S - 2);
	check(wipes.length === 0, "…the old window's time does not count: nothing yet 28 s later");
	s.run(3);
	check(wipes.length === 1, "…then exactly one wipe for that fall, not one per death", `${wipes.length}`);
	const seed1 = s.host.seed;
	s.run(10);
	check(wipes.length === 1, "…and nothing more while the new world goes on");
	s.kill(a);
	s.kill(b);
	s.run(WIPE_DECISION_S + 1);
	check(
		wipes.length === 2 && s.host.seed !== seed1,
		"everybody dies in the new world too: a second wipe, a third town — once per wipe",
		`${wipes.length} wipes, seeds ${seed1} → ${s.host.seed}`,
	);
	// the document is shared by every server this run booted (a DataStore outlives a server): the last two are ours
	const record = s.endedWorlds();
	const ours = Array.isArray(record) ? record.slice(-2) : [];
	check(
		ours.length === 2 &&
			ours[0].seed === DESIGN.TOWN_SEED &&
			ours[0].days === 3 &&
			ours[1].seed === seed1 &&
			ours[1].days === 1,
		"both ended worlds are on record (appended to what other servers wrote), the second after its single day",
		JSON.stringify(ours.map(r => ({ seed: r.seed, days: r.days }))),
	);
});

// ================================================================ 10–14: the review of f851ad2

const PISTOL = 10;
/** real seconds until `pred` holds (stepping the server), or -1 */
function waitFor(s, pred, limit, dt = 0.25) {
	for (let t = 0; t <= limit; t += dt) {
		if (pred()) return t;
		s.run(dt, dt);
	}
	return pred() ? limit : -1;
}

section("10) a reconnect still loading when the world ends gets no free revive (review of f851ad2, B1)", () => {
	const { WIPE_DECISION_S } = require(join(SRC, "server/sim/life.ts"));
	const s = bootServer();
	const wipes = s.wipes();
	const idA = newUser();
	let a = s.join(idA, "reconnecter");
	veteran(s.save(a)); // life day 9, a pistol and 40 rounds, no coins
	s.enter(a);
	const b = s.join(newUser(), "last");
	s.enter(b);
	s.save(b).money = 0;
	s.sim.clock.setClock(20, 3);
	s.kill(a);
	s.quit(a);
	const stored = s.stored(idA);
	check(
		stored?.runOver === true && stored?.day === 9 && stored?.invenWeapon[PISTOL] === 1,
		"the fallen survivor left the server dead: the DataStore holds runOver, life day 9 and the pistol",
	);
	s.kill(b);
	let endedWhileLoading = false;
	a = s.joinLoading(idA, "reconnecter", () => {
		// back on the server, the save still in flight: the last survivor's window runs out meanwhile
		s.run(WIPE_DECISION_S + 2);
		endedWhileLoading = wipes.length === 1;
	});
	check(endedWhileLoading, "the world ended while that reconnect's save was still loading");
	check(
		wipes[0] !== undefined && !wipes[0].dead.includes(idA),
		"…and rule 6 did not count a survivor whose save was not there (all it had was the CLOSED session's table)",
		JSON.stringify(wipes[0]?.dead),
	);
	const save = s.save(a); // the live session save, as the LoadAck showed it
	const sp = s.enter(a);
	const alive = sp !== undefined && !sp.state.dead;
	check(
		!alive || (save.day === 1 && save.invenWeapon[PISTOL] === 0 && save.ammoNormal === 0),
		"entering is never a free, full-health revive that keeps the old backpack and life day",
		`alive ${alive}, day ${save.day}, pistol ${save.invenWeapon[PISTOL]}, ammo ${save.ammoNormal}`,
	);
	check(
		alive && sp.state.hp === sp.state.hpMax && save.day === 1 && save.runOver === false,
		"…it is the new life the world owed them, granted the moment their save loaded: alive, life day 1, the " +
			"starter kit, and the save the client was shown says so",
	);
	s.quit(a);
	const doc = s.stored(idA);
	check(
		doc?.day === 1 && doc?.invenWeapon[PISTOL] === 0 && doc?.runOver === false && doc?.level === 14,
		"…and that is what reaches the DataStore (level kept)",
		`day ${doc?.day}, pistol ${doc?.invenWeapon[PISTOL]}, runOver ${doc?.runOver}`,
	);
});

section("11) leaving the server during the window does not dodge the new life (review of f851ad2, M1)", () => {
	const { WIPE_DECISION_S } = require(join(SRC, "server/sim/life.ts"));
	const s = bootServer();
	const wipes = s.wipes();
	const idA = newUser();
	let a = s.join(idA, "leaver");
	veteran(s.save(a));
	s.enter(a);
	const b = s.join(newUser(), "stayer");
	veteran(s.save(b));
	s.enter(b);
	s.sim.clock.setClock(20, 3);
	s.kill(a);
	s.kill(b);
	s.run(5);
	s.quit(a); // gone before the window closes
	s.run(WIPE_DECISION_S);
	check(wipes.length === 1, "the one who stayed waited the window out: the world ended");
	check(
		s.save(b).day === 1 && s.save(b).invenWeapon[PISTOL] === 0,
		"who stayed starts over: life day 1, the starter kit",
	);
	a = s.join(idA, "leaver"); // back within the 5 min
	const save = s.save(a);
	check(
		save.day === 1 && save.invenWeapon[PISTOL] === 0 && save.ammoNormal === 0 && save.runOver === false,
		"who left comes back to the SAME new life — not to the old backpack and life day 9 (MP-21: leaving buys " +
			"nothing a death costs)",
		`day ${save.day}, pistol ${save.invenWeapon[PISTOL]}, runOver ${save.runOver}`,
	);
	const sp = s.enter(a);
	check(
		sp !== undefined && !sp.state.dead && sp.state.hp === sp.state.hpMax,
		"…and walks into the new town standing",
	);
});

section("12) the news of a new world goes out at once, first, with the server's runRev (review B2, L3)", () => {
	const s = bootServer();
	const wipes = s.wipes();
	const idA = newUser();
	const a = s.join(idA, "reporter");
	s.enter(a);
	s.save(a).money = 0;
	s.sim.clock.setClock(20, 3);
	const slotA = s.body(a).slot;
	// an event of the old town still queued for one client when the world ends: it must not arrive after the news
	s.beforeReset = () =>
		s.host.replicator.queueFor(slotA, { t: s.P.WorldEv.ZombieDied, netId: 777, x: 100, y: 100, cause: 0 });
	const revBefore = s.save(a).runRev;
	s.kill(a);
	s.run(31);
	s.beforeReset = undefined;
	const w = wipes[0];
	check(w !== undefined, "the world ended");
	const batches = s
		.worldSent()
		.slice(w?.sentBefore ?? 0, w?.sentAfter ?? 0)
		.map(e => s.P.decodeWorld(e.args[0]));
	const has = (batch, pick) => batch?.events.some(pick) === true;
	const resetAt = batches.findIndex(bt => has(bt, e => e.t === s.P.WorldEv.WorldReset));
	check(
		resetAt >= 0,
		"the WorldReset went out in the SAME heartbeat as the reset — not at the next tick's flush, where a wallet " +
			"answered in between could overtake it",
		`${batches.length} batch(es) sent in that heartbeat`,
	);
	const oldAt = batches.findIndex(bt => has(bt, e => e.t === s.P.WorldEv.ZombieDied && e.netId === 777));
	check(
		oldAt >= 0 && oldAt < resetAt,
		"an old-town event still queued went out BEFORE it (L3)",
		`${oldAt} < ${resetAt}`,
	);
	const resetBatch = batches[resetAt];
	const order = resetBatch?.events.map(e => e.t) ?? [];
	check(
		order[0] === s.P.WorldEv.WorldReset && order.includes(s.P.WorldEv.PlayerLife),
		"…the news first, the stand-ups right behind it in the same batch",
		JSON.stringify(order),
	);
	const life = resetBatch?.events.find(e => e.t === s.P.WorldEv.WorldReset)?.lives.find(l => l.userId === idA);
	check(
		life !== undefined && life.runRev === s.save(a).runRev && life.runRev === revBefore + 1,
		"…naming the runRev the server wrote into the new life's save",
		`${life?.runRev} vs save ${s.save(a).runRev}`,
	);
	// a report the client captured in the old life, answered right after: the wallet carries the same number
	s.run(2);
	const ack = s.report(a, { runRev: revBefore });
	check(
		ack?.ok === false && ack?.reason === "outdated" && ack?.wallet?.runRev === life?.runRev,
		"a report of the old life is refused, and its wallet names that same runRev",
	);
	// whichever of the two reaches the client first, taking the server's number (never adding one) lands on it
	const serverRev = s.save(a).runRev;
	for (const first of ["wallet", "reset"]) {
		let rev = revBefore;
		for (const step of first === "wallet" ? ["wallet", "reset"] : ["reset", "wallet"]) {
			rev = Math.max(rev, step === "wallet" ? ack.wallet.runRev : life.runRev);
		}
		check(rev === serverRev, `wallet and reset applied ${first} first: the client is on the server's runRev`);
	}
	check(
		revBefore + 1 + 1 !== serverRev,
		"(the old rule, the wallet then +1, would sit one ahead and have every report refused as outdated)",
	);
});

section("13) a failure while making the new world changes nothing, and the old one goes on (review M2)", () => {
	const { WIPE_DECISION_S } = require(join(SRC, "server/sim/life.ts"));
	// (a) the generator itself fails
	{
		const s = bootServer();
		const wipes = s.wipes();
		const a = s.join(newUser(), "unlucky");
		s.enter(a);
		s.save(a).money = 0;
		s.sim.clock.setClock(22, 2);
		const before = { world: s.sim.world, horde: s.sim.horde, seed: s.host.seed };
		const recorded = (s.endedWorlds() ?? []).length;
		const world = W();
		const real = world.generateTown;
		world.generateTown = () => {
			throw new Error("generator failed (test)");
		};
		s.kill(a);
		let threw;
		try {
			s.run(WIPE_DECISION_S + 1);
		} catch (e) {
			threw = e;
		}
		world.generateTown = real;
		check(
			threw === undefined,
			"a failing generator does not escape the heartbeat as a failed tick",
			threw?.message,
		);
		check(
			wipes.length === 1 &&
				s.sim.world === before.world &&
				s.sim.horde === before.horde &&
				s.host.seed === before.seed &&
				s.sim.clock.day === 2,
			"the world ended on paper only: same town, same horde, same seed, same day",
		);
		check((s.endedWorlds() ?? []).length === recorded, "…and nothing is recorded as ended");
		check(
			warned.some(l => /the new town could not be made/.test(l) && /generator failed/.test(l)),
			"…and the log says why",
		);
		const up = waitFor(s, () => s.body(a)?.state.dead === false, 400);
		check(up >= 0, "the daybreak rule stands the survivor up in the old world", `after ${up} s`);
	}
	// (b) half-way: the horde is built and the combat is not
	{
		const s = bootServer();
		const wipes = s.wipes();
		const a = s.join(newUser(), "halfway");
		s.enter(a);
		s.save(a).money = 0;
		s.sim.clock.setClock(22, 2);
		const sim = s.sim;
		const before = {
			world: sim.world,
			horde: sim.horde,
			combat: sim.combat,
			progress: sim.progress,
			fill: sim.clock.onWaveFill,
			seed: s.host.seed,
		};
		const C = require(join(SRC, "server/sim/combat.ts"));
		const RealCombat = C.ServerCombat;
		C.ServerCombat = class {
			constructor() {
				throw new Error("combat refused (test)");
			}
		};
		s.kill(a);
		let threw;
		try {
			s.run(WIPE_DECISION_S + 1);
		} catch (e) {
			threw = e;
		}
		C.ServerCombat = RealCombat;
		check(threw === undefined && wipes.length === 1, "a failure half-way through building fails no tick");
		check(
			sim.world === before.world &&
				sim.horde === before.horde &&
				sim.combat === before.combat &&
				sim.progress === before.progress &&
				s.host.seed === before.seed &&
				sim.clock.day === 2,
			"the old world is whole: its town, horde, combat and kill credit, its day",
		);
		check(
			sim.clock.onWaveFill === before.fill,
			"…even the clock's wave subscription, which the half-built new horde had taken, is the old horde's again",
		);
		const up = waitFor(s, () => s.body(a)?.state.dead === false, 400);
		check(up >= 0, "daybreak stands the survivor up", `after ${up} s`);
		s.kill(a);
		s.run(WIPE_DECISION_S + 1);
		check(
			wipes.length === 2 && s.host.seed !== before.seed && s.body(a)?.state.dead === false,
			"the next fall tries again, and with the builder mended the new world comes",
		);
		check(
			s.printed.some(l => /generated in \d+ ms/.test(l)),
			"the server log says how long the generator took (the owner reads it in Studio)",
			s.printed.find(l => /generated in/.test(l)),
		);
	}
});

section("14) the client takes the server's word (source guards: review B2, L1, L2, L4)", () => {
	const main = parse("client/main.client.ts");
	const onTown = bodyOf(main, "onTown")
		.map(st => main.text(st))
		.join("\n");
	check(
		/notice\.runRev/.test(onTown) && !/runRev \+ 1/.test(onTown),
		"B2: onTown takes the runRev the WorldReset carries, and never adds one to its own",
	);
	const waitingCleared = bodyOf(main, "onTown").filter(st => /newLifeWaiting = false/.test(main.text(st)));
	check(
		waitingCleared.length > 0 &&
			waitingCleared.every(st => ts.isIfStatement(st) && /notice\.newLife/.test(main.text(st.expression))),
		"L4: only a WorldReset naming THIS client ends the wait for a new life it is owed",
	);
	const rebirth = bodyOf(main, "doRebirth");
	const guardAt = rebirth.findIndex(
		st => ts.isIfStatement(st) && /worldResets !== resets/.test(main.text(st.expression)),
	);
	const failAt = rebirth.findIndex(st => ts.isIfStatement(st) && main.text(st.expression) === "!res.ok");
	check(guardAt >= 0 && guardAt < failAt, "L2: a Rebirth that raced the end of the world shows no error");
	const alive = bodyOf(main, "aliveAfterAll")
		.map(st => main.text(st))
		.join("\n");
	check(
		/"invalid"/.test(alive) && /runOver = false/.test(alive) && /closeDawnWait\(\)/.test(alive),
		"L1: an 'invalid' (alive) answer to a run action clears the death and leaves the wait",
	);
	const users = ["doRebirth", "doNewRun"].filter(n =>
		bodyOf(main, n).some(st => /aliveAfterAll\(res\)/.test(main.text(st))),
	);
	check(users.length === 2, "…for Rebirth and New game both", users.join(", "));
	const net = readFileSync(join(SRC, "client/net/netClient.ts"), "utf8");
	check(
		/tick <= townGuard/.test(net),
		"the snapshot guard drops the reset's own tick too: its snapshots, sent before the reset, were the old town's",
	);
});

// ================================================================ 15–16: the review of de4ba1e

const raise = message => {
	throw new Error(message);
};

/** a real save as the DataStore holds it: the veteran of `veteran` (life day 9, a pistol, 40 rounds), alive */
function realSave(fields = {}) {
	const save = SAVE().defaultSave();
	veteran(save);
	save.runRev = 5;
	save.runOver = false;
	return Object.assign(save, fields);
}

section("15) a life played without saving never becomes the real save's (review of de4ba1e, N1, R3b, N4)", () => {
	const { WIPE_DECISION_S } = require(join(SRC, "server/sim/life.ts"));
	// N1, the reviewer's scenario: the save cannot be read at join; "Play without saving", a death, the lobby; Retry,
	// and while the real save loads everybody else dies and the world ends
	for (const alone of [false, true]) {
		const s = bootServer();
		// `alone`: with the blank record NOT forgotten (R3b's fix switched off), the owed life's own guard must hold
		// the line by itself — no departure banked, no new life (the reviewer's fix for N1)
		if (alone) s.host.lives.forgetUnsaved = () => false;
		const tag = alone ? " [the owed life's own guard alone]" : "";
		const wipes = s.wipes();
		const b = s.join(newUser(), "last");
		s.enter(b);
		s.save(b).money = 0;
		s.sim.clock.setClock(20, 3);
		const idA = newUser();
		const a = s.joinUnreadable(idA, "unsaved");
		check(
			s.loadStatus(a) === "error",
			`the save could not be read at join: a read-only session on a blank save${tag}`,
		);
		s.enter(a);
		s.kill(a);
		s.exit(a);
		check(s.host.lives.keptBody(idA)?.dead === true, `…played without saving, died on it, went to the lobby${tag}`);
		s.putStored(idA, realSave()); // the DataStore answers again
		let endedWhileLoading = false;
		s.retry(a, () => {
			s.kill(b);
			s.run(WIPE_DECISION_S + 2);
			endedWhileLoading = wipes.length === 1;
		});
		s.run(12); // the retry's cooldown, then the load
		check(endedWhileLoading, `the world ended while the retry was loading the real save${tag}`);
		const save = s.save(a);
		check(
			s.loadStatus(a) === "ok" &&
				save.day === 9 &&
				save.invenWeapon[PISTOL] === 1 &&
				save.ammoNormal === 40 &&
				save.runRev === 5 &&
				save.runOver === false,
			"N1: the real save comes back exactly as stored (alive, life day 9, the pistol, 40 rounds, runRev 5) — " +
				`not reset to a new life for a death that happened to the blank one${tag}`,
			`status ${s.loadStatus(a)}, day ${save.day}, pistol ${save.invenWeapon[PISTOL]}, ammo ${save.ammoNormal}, ` +
				`runRev ${save.runRev}, runOver ${save.runOver}`,
		);
		if (alone) continue; // (what the body is then is R3b's, below)
		const sp = s.enter(a);
		check(sp !== undefined && !sp.state.dead, "…and the survivor walks into the new town alive");
		s.quit(a);
		const doc = s.stored(idA);
		check(
			doc?.day === 9 && doc?.invenWeapon[PISTOL] === 1 && doc?.runOver === false && doc?.runRev === 5,
			"…which is what the DataStore keeps",
			`day ${doc?.day}, pistol ${doc?.invenWeapon[PISTOL]}, runOver ${doc?.runOver}, runRev ${doc?.runRev}`,
		);
	}
	// R3b, no world ending: what the blank save lived through stays with the blank save
	{
		const s = bootServer();
		const bystander = s.join(newUser(), "bystander");
		s.enter(bystander);
		s.immortal.add(bystander); // somebody stands: no world ends here
		s.sim.clock.setClock(20, 3);

		const idD = newUser();
		const d = s.joinUnreadable(idD, "died-unsaved");
		s.enter(d);
		s.kill(d);
		s.exit(d);
		s.putStored(idD, realSave());
		s.retry(d);
		s.run(12);
		const sd = s.enter(d);
		check(
			s.loadStatus(d) === "ok" && sd !== undefined && !sd.state.dead && s.save(d).runOver === false,
			"R3b: a death on the blank save does not carry into the real one — the survivor walks in alive",
			`status ${s.loadStatus(d)}, dead ${sd?.state.dead}, runOver ${s.save(d).runOver}`,
		);
		s.quit(d);
		check(s.stored(idD)?.runOver === false, "…and the DataStore never hears of that death");

		const idL = newUser();
		const l = s.joinUnreadable(idL, "alive-unsaved");
		s.enter(l);
		s.exit(l); // a living blank body, kept in the lobby
		s.putStored(idL, realSave({ runOver: true, runHp: 0 })); // …while the real survivor is dead
		s.retry(l);
		s.run(12);
		const sl = s.enter(l);
		check(
			sl !== undefined && sl.state.dead && s.save(l).runOver === true,
			"R3b: nor does a living blank body revive a real save that is dead (no free Rebirth)",
			`dead ${sl?.state.dead}, runOver ${s.save(l).runOver}`,
		);

		// the retry is pending (its cooldown): the next body must come from the save it is about to load
		const idP = newUser();
		const pl = s.joinUnreadable(idP, "impatient");
		s.putStored(idP, realSave({ runOver: true, runHp: 0 }));
		s.retry(pl);
		s.intent(pl, s.P.IntentKind.EnterWorld); // Play, straight away
		s.run(1);
		check(s.body(pl) === undefined, "a retry that is pending holds the entry: no body on the blank save meanwhile");
		s.run(12);
		const sp = s.body(pl);
		check(
			s.loadStatus(pl) === "ok" && sp !== undefined && sp.state.dead,
			"…the body that walks in, once it is loaded, is the real save's (dead here), never the blank one's",
			`status ${s.loadStatus(pl)}, body ${sp === undefined ? "none" : sp.state.dead ? "dead" : "alive"}`,
		);

		// N4: a retry asked from the street is not run under the body — a real save swapped in beneath it would make
		// its life (or its death) the real one's, and a dead body reloading would keep ending new worlds
		const idW = newUser();
		const w = s.joinUnreadable(idW, "in-the-street");
		const sw = s.enter(w); // alive, on the blank save
		s.putStored(idW, realSave({ runOver: true, runHp: 0 }));
		s.retry(w);
		s.run(12);
		check(
			sw !== undefined && s.loadStatus(w) === "error" && s.body(w) === sw,
			"N4: a Retry from inside the world is not run: the session stays read-only under that body",
			`status ${s.loadStatus(w)}`,
		);
		s.quit(w);
		check(
			s.stored(idW)?.runOver === true,
			"…so the blank body's life never reaches the real save, which is still dead",
			`runOver ${s.stored(idW)?.runOver}`,
		);
	}
});

section("16) once the new town stands, the reset is finished whatever fails after it (review of de4ba1e, N2)", () => {
	const { WIPE_DECISION_S } = require(join(SRC, "server/sim/life.ts"));
	for (const [what, breakIt] of [
		["closeTown", s => (s.host.replicator.closeTown = () => raise("closeTown failed (test)"))],
		["lives.restartWorld", s => (s.host.lives.restartWorld = () => raise("lives failed (test)"))],
	]) {
		const s = bootServer();
		const wipes = s.wipes();
		const a = s.join(newUser(), `unlucky-${what}`);
		veteran(s.save(a)); // life day 9, a pistol, no coins
		s.enter(a);
		s.sim.clock.setClock(22, 2);
		const before = { world: s.sim.world, seed: s.host.seed, rev: s.save(a).runRev };
		breakIt(s);
		s.kill(a);
		let threw;
		try {
			s.run(WIPE_DECISION_S + 1);
		} catch (e) {
			threw = e;
		}
		delete s.host.replicator.closeTown;
		delete s.host.lives.restartWorld;
		const w = wipes[0];
		check(
			threw === undefined && w !== undefined && s.sim.world !== before.world,
			`${what} throws: the world still ends, and the simulation stands in the new town`,
			threw?.message,
		);
		const reset = s
			.worldLog()
			.flatMap(bt => bt.events)
			.find(e => e.t === s.P.WorldEv.WorldReset);
		check(
			reset !== undefined && reset.seed === s.host.seed && s.host.seed !== before.seed,
			`${what} throws: the clients are told anyway — WorldReset with the new seed`,
			`${reset?.seed} vs host ${s.host.seed}`,
		);
		check(
			s.Workspace.GetAttribute("pz_world_seed") === s.host.seed &&
				R().mapHashOf(s.sim.world) === R().mapHashOf(W().generateTown(s.host.seed)),
			`${what} throws: the seed the host names (and the attribute a joining client builds from) is the town ` +
				`the simulation runs`,
		);
		const life = reset?.lives.find(l => l.userId === a.UserId);
		check(
			s.body(a)?.state.dead === false &&
				s.save(a).day === 1 &&
				s.save(a).invenWeapon[PISTOL] === 0 &&
				life !== undefined &&
				life.runRev === s.save(a).runRev &&
				life.runRev > before.rev,
			`${what} throws: nobody is left dead — the new life, standing, and the news names its runRev`,
			`dead ${s.body(a)?.state.dead}, day ${s.save(a).day}, runRev ${life?.runRev} / ${s.save(a).runRev}`,
		);
		check(
			warned.some(l => l.includes("went on past a failure") && l.includes("failed (test)")),
			`${what} throws: the log says what failed`,
		);
		s.kill(a);
		s.run(WIPE_DECISION_S + 1);
		check(wipes.length === 2, `${what} throws: rule 6 is armed again — the next fall ends the new world too`);
	}
});

section("17) the reset's own time is not the new world's to repay, and the clients' clocks follow it", () => {
	/*
	 * Review of 097f484 (#5) and the MP-22 reviewer: generating the new town takes 100-250 ms, all of it inside ONE
	 * heartbeat, so the NEXT heartbeat's delta carries it. Under the Heartbeat debt (§3.1) the new world opened by
	 * repaying it -- two ticks a heartbeat for a dozen heartbeats, off input queues the clients fill with one command
	 * each: every survivor stood still tick after tick in the first second of the new town. ServerSimulation now runs
	 * one tick for that heartbeat and forgets the rest (`restartWorld`, `advance`), which puts the tick behind
	 * tick0Time + tick / 60: the clients' clocks re-anchor on it from the TimePongs (client/net/clockSync.ts).
	 */
	const { WIPE_DECISION_S } = require(join(SRC, "server/sim/life.ts"));
	const { ClockSync } = require(join(SRC, "client/net/clockSync.ts"));
	const CFG = require(join(SRC, "shared/net/mpConfig.ts"));
	const s = bootServer();
	const wipes = s.wipes();
	const a = s.join(newUser(), "tempo");
	veteran(s.save(a));
	s.enter(a);
	const init = s
		.worldLog()
		.flatMap(bt => bt.events)
		.find(e => e.t === s.P.WorldEv.InitBegin);
	// the client: one command per frame, each Input carrying the two before it (§2.2), and a TimePing a second
	let seq = 500;
	const recent = [];
	const send = () => {
		seq += 1;
		recent.unshift({ seq, moveAng: 0, moveMag: 0, aim: 0, held: 0, edges: 0 });
		if (recent.length > 3) recent.pop();
		s.input(a, s.P.encodeInput({ viewTick: s.sim.tick % 65536, viewFrac: 0, cmds: recent }));
	};
	let pingSeq = 0;
	const clock = new ClockSync();
	clock.setEpoch(init?.tick0Time ?? 0, CFG.SIM_HZ);
	let seenPongs = 0;
	const frame = (dt = 1 / 60) => {
		send();
		if (Math.floor(s.Workspace.GetServerTimeNow() + dt) > Math.floor(s.Workspace.GetServerTimeNow())) {
			pingSeq += 1;
			s.timeSync(a, s.P.encodeTimePing({ seq: pingSeq, clientTime: s.Workspace.GetServerTimeNow() }));
		}
		s.beat(dt);
		const pongs = s.timeSync(a);
		for (; seenPongs < pongs.length; seenPongs++) {
			clock.noteServerTick?.(pongs[seenPongs].serverTime, pongs[seenPongs].serverTick);
		}
		clock.update(dt, s.Workspace.GetServerTimeNow());
	};
	for (let i = 0; i < 120; i++) frame();
	s.kill(a);
	for (let i = 0; i < (WIPE_DECISION_S + 2) * 60 && wipes.length === 0; i++) frame();
	check(wipes.length === 1, "the last survivor fell and nobody paid: the world ends");
	const sp = s.body(a);
	const filledBefore = sp?.counters.filled ?? 0;
	// the 200 ms the new town took: the client's frames of that time land, then the heartbeat whose delta carries it
	for (let i = 0; i < 12; i++) send();
	const tickBefore = s.sim.tick;
	s.beat(0.2 + 1 / 60);
	// (an older src has no `backlogS`: its debt shows in the ticks the next heartbeats run)
	const debt = s.sim.backlogS?.() ?? 0;
	check(
		s.sim.tick - tickBefore === 1 && debt < 1 / 60,
		"the heartbeat that carries the reset runs one tick and keeps no debt of it",
		`${s.sim.tick - tickBefore} tick(s), debt ${(debt * 1000).toFixed(0)} ms`,
	);
	let doubled = 0;
	for (let i = 0; i < 60; i++) {
		const t0 = s.sim.tick;
		frame();
		if (s.sim.tick - t0 > 1) doubled += 1;
	}
	check(doubled === 0, "…and no heartbeat of the new world's first second runs two ticks", `${doubled} did`);
	const waits = (sp?.counters.filled ?? 0) - filledBefore;
	check(waits === 0, "the survivor's input queue never runs dry in the new world's first second", `${waits} waits`);
	// the forgiven 200 ms are behind tick0Time + tick / 60 now: a client's clock follows them within a few pongs
	for (let i = 0; i < 5 * 60; i++) frame();
	const behind = s.sim.tick + 1 - clock.tickNow();
	check(
		Math.abs(behind) <= 2,
		"the clients' clock re-anchors on the tick the server actually runs (TimePong), within 2 ticks",
		`clock ${clock.tickNow().toFixed(1)}, server ${s.sim.tick}, epoch moved ${((clock.stats().epochShift ?? 0) * 1000).toFixed(0)} ms`,
	);
	// (not the reset's, but the same live host: the admin rows carry the rewind's MP-16 evidence, review #3)
	const row = s.host.anomalies().find(r => r.userId === a.UserId);
	check(
		row !== undefined && typeof row.rewindClamped === "number" && typeof row.shots === "number",
		"the admin view's row for a survivor carries the rewind clamps and the shots they are out of (MP-16)",
		row === undefined ? "no row" : `${row.rewindClamped} of ${row.shots}`,
	);
});

// ================================================================ 18: the review of the F5 save-path fix

section("18) an owed new life is not lost when the load step that grants it throws (F5 review)", () => {
	const { WIPE_DECISION_S } = require(join(SRC, "server/sim/life.ts"));
	const s = bootServer();
	const wipes = s.wipes();
	const idA = newUser();
	let a = s.join(idA, "owed");
	veteran(s.save(a));
	s.enter(a);
	const b = s.join(newUser(), "stayer");
	veteran(s.save(b));
	s.enter(b);
	s.sim.clock.setClock(20, 3);
	s.kill(a);
	s.kill(b);
	s.run(5);
	s.quit(a); // gone before the window closes: the world that ends owes them the new life
	s.run(WIPE_DECISION_S);
	check(wipes.length === 1, "the world ended while the fallen survivor was away");
	// back within the 5 min: the keeper grants the owed life on the loaded save, and then the step throws
	const adopt = s.host.adopt;
	s.host.adopt = (...args) => {
		adopt(...args);
		throw new Error("injected: adopt failed after granting");
	};
	try {
		a = s.join(idA, "owed");
	} finally {
		s.host.adopt = adopt;
	}
	// a load that was thrown away would be retried after LOAD_RETRY_COOLDOWN: give it the time
	s.run(11, 0.5);
	const save = s.save(a);
	check(
		save !== undefined && save.day === 1 && save.invenWeapon[PISTOL] === 0 && save.runOver === false,
		"the owed new life is on the save the session keeps: life day 1, the starter kit, alive",
		save === undefined
			? "no LoadAck"
			: `day ${save.day}, pistol ${save.invenWeapon[PISTOL]}, runOver ${save.runOver}`,
	);
	const sp = s.enter(a);
	check(sp !== undefined && !sp.state.dead, "…and the survivor walks into the new town standing");
	s.quit(a);
	const doc = s.stored(idA);
	check(
		doc?.day === 1 && doc?.runOver === false && doc?.level === 14,
		"…and that is what reaches the DataStore (level kept)",
		`day ${doc?.day}, runOver ${doc?.runOver}, level ${doc?.level}`,
	);
});

// ================================================================ 19: nobody is the server's (the owner's question)

/*
 * "Suppose the server's main player (the first one to join) and then others join. That main player dies or leaves: does
 * the server die/stop working?" (the owner, 2026-09-24). Nothing on the server belongs to whoever came first -- the town,
 * the clock, the horde, the waves and the world's end are the SERVER's (tools/test-body.mjs 34 has the rest). Here, the
 * world's life when EVERYBODY goes, by MP-22's rule: it ends when nobody is left alive, never because it is empty.
 *
 *   d1  everybody leaves standing, then somebody joins: the SAME world goes on (seed, day, the clock kept running), no
 *       wipe: an empty world is not a lost one. (On Roblox an empty server closes a moment later, and the next player
 *       gets a new server -- a new process, whose first town is DESIGN.TOWN_SEED on day 1: the "fresh world".)
 *   d2  everybody dies, then everybody leaves inside the 30 s window: leaving the server is declining (MP-22), so the
 *       world ends at the last departure; a newcomer finds the new town on day 1, and the dead who come back within the
 *       5 min are owed the new life. Before: the last dead walking out closed the window as if the world were merely
 *       empty, and a newcomer entered the LOST world on its old day, with its dead coming back dead into it.
 *   d3  the dead leave while somebody still stands, then that one leaves standing: the world was never lost, it goes on.
 *   d4  the first player leaves standing while the only other one is dead: nobody alive is left in the world, so the
 *       window opens and the world ends (the one who left is no survivor of it any more) -- the same as if the first had
 *       died: nobody is the host.
 */
section("19) nobody is the host: the world ends when nobody is left alive, never because the first player left", () => {
	// d1: everybody leaves standing
	{
		const s = bootServer();
		const wipes = s.wipes();
		const a = s.join(newUser(), "first");
		const b = s.join(newUser(), "second");
		s.immortal.add(a);
		s.immortal.add(b);
		s.enter(a);
		s.enter(b);
		s.sim.clock.setClock(12, 4);
		const seed = s.host.seed;
		const kept = { x: s.body(a).state.x, y: s.body(a).state.y };
		const zombies = s.sim.horde.zombies.length;
		s.quit(a);
		s.quit(b);
		const t0 = s.sim.clock.dayTime;
		s.run(40, 0.25);
		const frozen = s.sim.horde.zombies.length;
		const c = s.join(newUser(), "later");
		const spC = s.enter(c);
		s.immortal.add(c);
		s.run(12, 0.25);
		const near =
			spC === undefined
				? 0
				: s.sim.horde.zombies.filter(z => Math.hypot(z.x - spC.state.x, z.y - spC.state.y) <= 1600).length;
		check(
			wipes.length === 0 && s.host.seed === seed && s.sim.clock.day === 4,
			"(d1) everybody left standing: no wipe, the same town and day go on",
			`wipes ${wipes.length}, seed ${s.host.seed === seed ? "same" : "new"}, day ${s.sim.clock.day}`,
		);
		check(
			s.sim.clock.dayTime > t0,
			"(d1) …and the clock kept running while it was empty (§4.6)",
			`${f1(t0)} h -> ${f1(s.sim.clock.dayTime)} h`,
		);
		check(
			frozen === zombies,
			"(d1) …while the horde stood still, costing nothing (nobody to hunt or to see it)",
			`${zombies} -> ${frozen} zombies`,
		);
		check(
			spC !== undefined && !spC.state.dead && near > 0,
			"(d1) …the newcomer walks in standing, and the horde gathers around THEM",
			`dead ${spC?.state.dead}, ${near} zombie(s) within 1600 u after 12 s`,
		);
		const a2 = s.join(a.UserId, "first");
		const back = s.enter(a2);
		check(
			back !== undefined && Math.hypot(back.state.x - kept.x, back.state.y - kept.y) < 1,
			"(d1) …and the first player, back within the 5 min, gets their kept body where they left it",
			back !== undefined ? `${f1(Math.hypot(back.state.x - kept.x, back.state.y - kept.y))} u off` : "no body",
		);
	}
	// d2: everybody dies, then everybody leaves inside the window
	{
		const s = bootServer();
		const wipes = s.wipes();
		const a = s.join(newUser(), "first");
		const b = s.join(newUser(), "second");
		s.enter(a);
		s.enter(b);
		s.sim.clock.setClock(12, 4);
		const seed = s.host.seed;
		s.kill(a);
		s.kill(b);
		check(s.host.lives.wipeWindowOpen(), "(d2) both dead: the 30 s window is open (the case being tested)");
		s.quit(a);
		s.run(1);
		check(
			wipes.length === 0 && s.host.lives.wipeWindowOpen(),
			"(d2) the first walks out: one still waits, the window stays open",
			`wipes ${wipes.length}`,
		);
		s.quit(b);
		s.run(1);
		check(
			wipes.length === 1 && wipes[0].reason === "declined" && s.host.seed !== seed && s.sim.clock.day === 1,
			"(d2) the last of the dead walks out: everybody declined, the world ends at once (MP-22) -- a new town on day 1",
			`wipes ${wipes.length} (${wipes[0]?.reason}), seed ${s.host.seed === seed ? "same" : "new"}, day ${s.sim.clock.day}`,
		);
		check(
			wipes[0] !== undefined && wipes[0].dead.includes(a.UserId) && wipes[0].dead.includes(b.UserId),
			"(d2) …and both are counted among its fallen",
			JSON.stringify(wipes[0]?.dead),
		);
		const c = s.join(newUser(), "newcomer");
		const spC = s.enter(c);
		check(
			spC !== undefined && !spC.state.dead && s.sim.clock.day === 1,
			"(d2) a newcomer walks into the NEW town, standing, on day 1",
			`dead ${spC?.state.dead}, day ${s.sim.clock.day}`,
		);
		const a2 = s.join(a.UserId, "first");
		s.run(0.5);
		const back = s.enter(a2);
		const save = s.save(a2);
		check(
			back !== undefined && !back.state.dead && save?.day === 1 && save?.runOver === false,
			"(d2) the first player, back within the 5 min, gets the new life the world owed them (standing, life day 1)",
			`dead ${back?.state.dead}, life day ${save?.day}, runOver ${save?.runOver}`,
		);
	}
	// d3: the dead leave while somebody stands, then that one leaves standing
	{
		const s = bootServer();
		const wipes = s.wipes();
		const a = s.join(newUser(), "first");
		const b = s.join(newUser(), "second");
		s.immortal.add(b);
		s.enter(a);
		s.enter(b);
		s.sim.clock.setClock(12, 4);
		const seed = s.host.seed;
		s.kill(a);
		s.quit(a);
		s.run(1);
		s.quit(b);
		s.run(40, 0.25);
		check(
			wipes.length === 0 && s.host.seed === seed && s.sim.clock.day === 4,
			"(d3) the first died and left while the second stood; then the second left standing: the world was never lost",
			`wipes ${wipes.length}, seed ${s.host.seed === seed ? "same" : "new"}, day ${s.sim.clock.day}`,
		);
	}
	// d4: the first leaves standing while the only other one is dead
	{
		const s = bootServer();
		const wipes = s.wipes();
		const a = s.join(newUser(), "first");
		const b = s.join(newUser(), "second");
		s.immortal.add(a);
		s.enter(a);
		s.enter(b);
		s.sim.clock.setClock(12, 4);
		s.kill(b);
		s.run(2);
		check(!s.host.lives.wipeWindowOpen(), "(d4) one dead, the first standing: no window (somebody is alive)");
		s.quit(a);
		s.run(1);
		check(
			s.host.lives.wipeWindowOpen() && wipes.length === 0,
			"(d4) the first leaves the server: nobody alive is left in the world, so the window opens (nobody is the host)",
			`open ${s.host.lives.wipeWindowOpen()}, wipes ${wipes.length}`,
		);
		s.run(31, 0.25);
		const spB = s.body(b);
		check(
			wipes.length === 1 && wipes[0].reason === "timeout" && spB !== undefined && !spB.state.dead,
			"(d4) …and 30 s later the world ends as MP-22 says, the one left in it standing again in the new town",
			`wipes ${wipes.length} (${wipes[0]?.reason}), dead ${spB?.state.dead}, day ${s.sim.clock.day}`,
		);
	}
});

// ================================================================

console.log("");
if (failures > 0) {
	console.log(`${failures} of ${checks} check(s) failed`);
	process.exit(1);
}
console.log(`all ${checks} checks passed`);
