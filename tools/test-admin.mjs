#!/usr/bin/env node
/*
 * The admin panel's world tools, on the world the SERVER owns (docs/MULTIPLAYER.md §10, F6-6B; the admin audit of
 * 2026-09-24).
 *
 *   npm run test:admin                  # everything (exit code 1 on any failure)
 *   node tools/test-admin.mjs --verbose # with the server's own print/warn lines
 *   PZ_BODY_ONLY=7 node tools/test-admin.mjs   # only the sections whose title starts with "7"
 *
 * The audit found that from MP_PHASE 2 every world tool of the panel edited the admin's own copy of a world the
 * server owned: spawns wiped by the next snapshot, the clock snapping back, a teleport rubber-banding, and god mode
 * drawing a full HP bar while the server killed the body -- each one toasting success, writing an audit line and
 * marking the run assisted. Now each tool is an `AdminRequest { kind: "world", op }` that the server authorizes,
 * validates, runs, audits and answers (server/admin/adminWorld.ts). This suite boots the REAL server -- main.server.ts
 * with its admin server, MP host and simulation -- on the fake Roblox of tools/test-body.mjs and talks to it only
 * through its remotes, as a client (an admin's, or anybody else's) can.
 *
 *   1. WHO                every world tool from a non-admin is "forbidden" and changes nothing; a non-admin who
 *                         floods the admin remote (ADMIN_RATE / ADMIN_BURST) is kicked once, with one audit entry.
 *   2. WHAT               malformed tools (types, ranges, unknown names, NaN, huge coordinates) are refused with a reason
 *                         and change nothing.
 *   3. SPAWN              zombies and bosses appear in the server's horde, capped (MAX_ZOMBIES_ADMIN, MAX_BOSSES), near
 *                         a survivor, chasing or wandering; a spawn pays nobody (no XP, kill, boss credit, loot).
 *   4. KILL ALL           removes the horde (in a radius or everywhere), pays nothing, assists every run in the world.
 *   5. CLOCK              set / night / dawn / wave move the SERVER's clock (sent to everybody), pay no skipped day,
 *                         assist every run; rain assists nobody; the dead's daybreak follows the new hour.
 *   6. HEAL               self or a target in the world; the healed run is the assisted one; the dead and the absent
 *                         are refused.
 *   7. SWITCHES           god (no bite, no starvation, no poison), noclip (through walls, out of them when it ends),
 *                         infinite ammo (magazine full, pools untouched, nothing refunded) live on the server body, in
 *                         the snapshot's modFlags, across new bodies, and end when the admin leaves.
 *   8. TELEPORT           to a walkable point (moved out of a wall, clamped into the town); the dead and the absent are
 *                         refused.
 *   9. CLEAR              the server's acid, and every client told to drop its blood and bodies.
 *  10. ITEMS, STRUCTURES  through the server world (ItemAdd / SolidAdd to the clients), validated, capped.
 *  11. FREE CAMERA        the admin's interest follows the camera (a boss 2500 u away reaches their snapshot), kept
 *                         within FREECAM_MAX_RANGE, lapsing when not refreshed, on its own rate bucket.
 *  12. AUDIT              every tool leaves one line (an identical repeat merged), refusals included; DENIED stays
 *                         throttled.
 *  13. RATE               world tools share the admin's token bucket.
 *  14. BUG-1              a save reset drops the body the keeper held: no old hp or death banked into it, no magazine
 *                         refunded into the new reserve, a fresh body at a spawn point, alive.
 *  15. BUG-3              Studio messages: a negative UserId, and the ban history (production servers only).
 *  16. THE PANEL          (client) AdminWorldHost's answers ARE the server's: a refusal is never a success, a success
 *                         carries the server's words, nothing is logged twice, the switches show the server's state.
 *  17-26. THE REVIEW      the independent review of 8f50bc5, one section per finding, each check a repro that failed
 *                         before its fix (the probes of the review, turned into assertions of the right behaviour):
 *                         17 HIGH-1 switches shed by a body leaving the world (P1, P2, P5); 18 MEDIUM-2 a new run
 *                         under a switch stays assisted (P3); 19 MEDIUM-3 Dawn stands the dead up (P4); 20 MEDIUM-4
 *                         flooders never push an admin's action out of the log (P9); 21 L1 the lobby's runs are
 *                         assisted by a clock tool (P10); 22 L2 an admin's drop pays its taker nothing, no cosmetics;
 *                         23 L3 a line keeps what it says, a stored one is never rewritten; 24 L4 noclip stays in the
 *                         town (P11) and always ends on free ground; 25 L5 the two boss caps; 26 L6 forced waves at
 *                         ΣS(k), and "Remove structure".
 *
 * Pure Node (>= 18) + the project's TypeScript, through tools/luau-shim.mjs, plus the fake Roblox of test-body.
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
const info = msg => console.log(`        ${msg}`);
/** a section that throws (an API missing on an older source tree, say) is a failure, not a crash of the suite */
/** PZ_BODY_ONLY=20 runs only the sections whose title starts with it (a quicker loop while working on one) */
const ONLY = process.env.PZ_BODY_ONLY;
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
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const f1 = v => (typeof v === "number" ? v.toFixed(1) : String(v));

// ---------------------------------------------------------------- the fake Roblox

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
globalThis.print = (...a) => {
	if (VERBOSE) console.log("        [print]", ...a);
};
globalThis.warn = (...a) => {
	const line = a.join(" ");
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
/** what an UpdateAsync transform returned after the value (userIds, metadata): the fake store keeps the userIds */
let tupleRest = [];
globalThis.$tuple = (...a) => {
	tupleRest = a.slice(1);
	return a[0];
};
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
const enumProxy = new Proxy({}, { get: (_, a) => new Proxy({}, { get: (__, b) => `${String(a)}.${String(b)}` }) });
globalThis.Enum = enumProxy;

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
		// Roblox fires ChildAdded on every parent change; shared/chat/channelWait.ts listens to it (2d622b7)
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
		if (this.sent.length > 4000) this.sent.splice(0, 2000);
	}
	FireAllClients(...args) {
		this.sent.push({ to: undefined, args });
		if (this.sent.length > 4000) this.sent.splice(0, 2000);
	}
}
globalThis.Instance = Inst;

/** Roblox's DataStores outlive a server: one map per store name for the whole run */
const stores = new Map();
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
/** every DataStore call that went through, in order: { store, op, key } (the tests read the order of writes) */
const storeLog = [];
/** GetDataStore(name) throws this many more times per store name (a store the service cannot open yet) */
const openFailures = new Map();
function fakeStore(name) {
	let s = stores.get(name);
	if (s !== undefined) return s;
	const data = new Map();
	s = {
		data,
		/** the UserIds each key was tagged with by its last write (GlobalDataStore: "for GDPR tracking") */
		userIds: new Map(),
		/** fault injection: how many of the next calls of each kind throw, as a DataStore outage does */
		fail: { get: 0, update: 0 },
		UpdateAsync(key, transform) {
			if (s.fail.update > 0) {
				s.fail.update -= 1;
				throw new Error(`injected UpdateAsync failure on ${name}`);
			}
			tupleRest = [];
			const next = transform(clone(data.get(key)));
			if (next !== undefined) {
				data.set(key, clone(next));
				s.userIds.set(key, clone(tupleRest[0]));
			}
			storeLog.push({ store: name, op: "update", key });
			return [next];
		},
		GetAsync(key) {
			if (s.fail.get > 0) {
				s.fail.get -= 1;
				throw new Error(`injected GetAsync failure on ${name}`);
			}
			storeLog.push({ store: name, op: "get", key });
			return [clone(data.get(key))];
		},
		SetAsync: (key, v) => data.set(key, clone(v)),
	};
	stores.set(name, s);
	return s;
}

let guid = 0;
function makeGame(privateServer) {
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
	const DataStoreService = {
		GetDataStore: name => {
			const left = openFailures.get(name) ?? 0;
			if (left > 0) {
				openFailures.set(name, left - 1);
				throw new Error(`injected GetDataStore failure on ${name}`);
			}
			return fakeStore(name);
		},
		GetRequestBudgetForRequestType: () => 100,
	};
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
		PrivateServerId: privateServer ? "vip-server" : "",
		PrivateServerOwnerId: privateServer ? 7 : 0,
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
	p.kicked = false;
	p.Kick = () => {
		p.kicked = true;
	};
	p.GetNetworkPing = () => 0.05;
	return p;
}

// ---------------------------------------------------------------- a server "process"

/**
 * Boots server/main.server.ts from scratch: every module under src is loaded again, so a second boot is a second
 * server process (its own JobId, its own world, its own memory) that shares nothing with the first but the
 * DataStore — exactly what a server hop is.
 */
function bootServer({ privateServer = false } = {}) {
	for (const k of Object.keys(require.cache)) if (k.startsWith(SRC)) delete require.cache[k];
	const env = makeGame(privateServer);
	require(join(SRC, "server/main.server.ts"));
	const host = require(join(SRC, "server/net/mpHost.ts")).activeMpHost();
	if (host === undefined) throw new Error("main.server.ts did not start the MP host (MP_PHASE < 1?)");
	const P = require(join(SRC, "shared/net/protocol.ts"));
	const { SAVE_STORE } = require(join(SRC, "server/save/stores.ts"));
	const { Players, RunService, ReplicatedStorage } = env.services;
	const net = ReplicatedStorage.FindFirstChild("Net");
	const remote = name => {
		const r = net.FindFirstChild(name);
		if (r === undefined) throw new Error(`no remote ${name}`);
		return r;
	};
	const seqs = new Map();
	const server = {
		env,
		host,
		P,
		sim: host.simulation,
		privateServer,
		/** PlayerAdded (the session loads at once: the DataStore is in memory) and the client's LoadRequest */
		join(userId, name = `p${userId}`) {
			const p = makePlayer(userId, name);
			// a connected Player is parented to the Players service; a removed one is not (Roblox sets it to nil)
			p._parent = Players;
			Players.list.push(p);
			Players.PlayerAdded.Fire(p);
			remote("LoadRequest").OnServerEvent.Fire(p);
			return p;
		},
		/** the player leaves the SERVER; `reversed` fires the PlayerRemoving handlers the other way round */
		quit(p, reversed = false) {
			Players.list = Players.list.filter(x => x !== p);
			if (reversed) Players.PlayerRemoving.FireReversed(p);
			else Players.PlayerRemoving.Fire(p);
			p._parent = undefined;
		},
		/** the live session save, as the LoadAck handed it to the client */
		save(p) {
			const acks = remote("LoadAck").sent.filter(e => e.to === p);
			return acks[acks.length - 1]?.args[0]?.save;
		},
		token(p) {
			const acks = remote("LoadAck").sent.filter(e => e.to === p);
			return acks[acks.length - 1]?.args[0]?.token;
		},
		intent(p, kind) {
			remote("Intent").OnServerEvent.Fire(p, P.encodeIntent(kind));
		},
		/** one backpack verb on the Intent remote, as client/net/netClient.ts sends it (docs/MULTIPLAYER.md §4.8) */
		verb(p, kind, arg, atSeq = 0, nonce = 0) {
			remote("Intent").OnServerEvent.Fire(p, P.encodeIntentArgs(kind, atSeq, arg, nonce));
		},
		/** EnterWorld, then long enough for the admit pass (ADMIT_INTERVAL) whatever the cooldown said */
		enter(p) {
			server.intent(p, P.IntentKind.EnterWorld);
			server.run(0.6);
			return server.body(p);
		},
		exit(p) {
			server.intent(p, P.IntentKind.LeaveWorld);
			server.beat();
		},
		/** one Input packet, newest command first with the §2.2 redundancy, walking along `angle` */
		walk(p, angle) {
			const seq = (seqs.get(p) ?? 0) + 1;
			seqs.set(p, seq);
			const cmds = [];
			for (let k = 0; k < 3 && seq - k >= 1; k++)
				cmds.push(P.makeCommand(seq - k, Math.cos(angle), Math.sin(angle), 0, 0, 0));
			remote("Input").OnServerEvent.Fire(p, P.encodeInput({ viewTick: 0, viewFrac: 0, cmds }));
		},
		shop(p, req) {
			return remote("ShopAction").OnServerInvoke(p, req);
		},
		/** a client progress report (SaveRequest) of the live save with `fields` overridden */
		report(p, fields) {
			const json = JSON.stringify({ ...server.save(p), ...fields });
			remote("SaveRequest").OnServerEvent.Fire(p, server.token(p), json);
			return remote("SaveAck")
				.sent.filter(e => e.to === p)
				.pop()?.args[0];
		},
		body(p) {
			return host.playerOf(p);
		},
		/** the survivor's own view of the life states on the reliable World channel, in order */
		lifeEventsOf(p) {
			const out = [];
			let mySlot = -1;
			for (const e of remote("World").sent) {
				if (e.to !== undefined && e.to !== p) continue;
				const batch = P.decodeWorld(e.args[0]);
				if (batch === undefined) continue;
				for (const ev of batch.events) {
					if (ev.t === P.WorldEv.PlayerJoined && ev.userId === p.UserId) mySlot = ev.slot;
					if (ev.t === P.WorldEv.PlayerLife && ev.slot === mySlot) out.push(ev.state);
				}
			}
			return out;
		},
		clearWorldLog() {
			remote("World").sent.length = 0;
		},
		/** a death through the server's own damage path, then the tick that notices it */
		kill(p) {
			const sp = server.body(p);
			sp.state.godMode = false;
			server.sim.combat.damageActor(sp.slot, sp.state, sp.save, sp.state.hpMax * 10, true);
			server.beat();
			server.beat();
			return sp;
		},
		/** the stored document, as the next session anywhere would load it */
		stored(userId) {
			const doc = fakeStore(SAVE_STORE).data.get(String(userId));
			if (doc === undefined) return undefined;
			return typeof doc.data === "string" ? JSON.parse(doc.data) : doc.data;
		},
		storeDoc(userId, edit) {
			const store = fakeStore(SAVE_STORE);
			const doc = store.data.get(String(userId));
			const data = JSON.parse(doc.data);
			edit(data);
			doc.data = JSON.stringify(data);
			store.data.set(String(userId), doc);
		},
		/** keep these survivors out of the horde's teeth, so the only deaths are the scripted ones */
		immortal: new Set(),
		beat(dt = 1 / 60) {
			clockNow += dt;
			for (let i = timers.length - 1; i >= 0; i--) {
				if (timers[i].at <= clockNow) {
					const t = timers.splice(i, 1)[0];
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
		/** real seconds until `pred` holds, or -1 when it did not within `limit` */
		runUntil(pred, limit, dt = 1 / 60) {
			let t = 0;
			while (t < limit) {
				if (pred()) return t;
				server.beat(dt);
				t += dt;
			}
			return pred() ? t : -1;
		},
		/** the world clock `seconds` of real time before daybreak (night runs at 1.2× TIME_SPEED) */
		nightLeft(seconds) {
			const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
			const hours = seconds * DESIGN.TIME_SPEED * 1.2;
			server.sim.clock.setClock(6 - hours);
		},
		shutdown() {
			for (const fn of env.closers) runThread(fn, []);
		},
		/** every `onWorldWiped` report, through the keeper's own hook (chained, the host still logs) */
		wipes() {
			const lives = host.lives;
			if (lives.__wipes === undefined) {
				lives.__wipes = [];
				const prev = lives.onWorldWiped;
				lives.onWorldWiped = r => {
					lives.__wipes.push(r);
					prev?.(r);
				};
			}
			return lives.__wipes;
		},
	};
	return server;
}

const PISTOL = 10;
/** arms a survivor's live save with a pistol and `reserve` normal rounds (before they enter the world) */
function armPistol(save, reserve) {
	save.invenWeapon[PISTOL] = 1;
	save.equipWeapon = PISTOL;
	save.ammoNormal = reserve;
}

let nextUser = 5000;
const newUser = () => ++nextUser;

// ================================================================ the admin's world tools

/** check(ok, what, detail), with the claim first (it reads better in the sections below) */
const verify = (what, ok, detail) => check(ok, what, detail);
const WO = require(join(SRC, "shared/admin/worldOps.ts"));
const CFG = require(join(SRC, "shared/net/mpConfig.ts"));
const { circleBlocked, PLAYER_RADIUS } = require(join(SRC, "shared/game/physics.ts"));
const { defaultSave } = require(join(SRC, "shared/game/save.ts"));

/** a Lua pattern (the few classes server/admin/adminServer.ts uses) as a JS RegExp */
function luaPattern(p) {
	const cls = { c: "\\x00-\\x1f\\x7f", s: "\\s", d: "0-9", w: "A-Za-z0-9", a: "A-Za-z" };
	let out = "";
	let inSet = false;
	for (let i = 0; i < p.length; i++) {
		const c = p[i];
		if (c === "%") {
			const n = p[++i];
			if (cls[n] !== undefined) out += inSet ? cls[n] : n === "s" ? "\\s" : `[${cls[n]}]`;
			else out += `\\${n}`;
		} else {
			if (c === "[") inSet = true;
			if (c === "]") inSet = false;
			out += c;
		}
	}
	return new RegExp(out, "g");
}
// the Luau string functions the admin server's text handling needs (as test-body section 29 installs them)
globalThis.string.match = (str, pat) => {
	const m = new RegExp(luaPattern(pat).source).exec(str);
	return m === null ? [undefined] : [m[1] ?? m[0]];
};
Object.defineProperty(String.prototype, "gsub", {
	value(pat, repl) {
		let n = 0;
		const res = this.replace(luaPattern(pat), () => {
			n += 1;
			return repl;
		});
		return [res, n];
	},
	configurable: true,
	writable: true,
});
globalThis.error ??= v => {
	throw v instanceof Error ? v : new Error(String(v));
};

const J = v => {
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** a server with the admin and one other survivor ("bob", kept alive by the harness) in the world */
function town() {
	const s = bootServer();
	const { ADMIN_LOG_STORE } = require(join(SRC, "server/save/stores.ts"));
	const logStore = fakeStore(ADMIN_LOG_STORE);
	// every town starts with an empty stored log (the fake store outlives a server): no section reads another's lines
	logStore.data.clear();
	logStore.ListKeysAsync = prefix => ({
		GetCurrentPage: () => [...logStore.data.keys()].filter(k => k.startsWith(prefix)).map(k => ({ KeyName: k })),
	});
	// a fresh admin per server: a server of an earlier section may still hold a session lock on the last one
	const adminId = newUser();
	require(join(SRC, "shared/admin/config.ts")).ADMIN_USER_IDS.push(adminId);
	const admin = s.join(adminId, "Owner");
	admin.LocaleId = "en-us";
	const bob = s.join(newUser(), "Bob");
	bob.LocaleId = "en-us";
	s.immortal.add(bob);
	const net = s.env.services.ReplicatedStorage.FindFirstChild("PZAdminNet");
	const RF = net.FindFirstChild("AdminRequest");
	const EV = net.FindFirstChild("AdminEvent");
	const ACK = net.FindFirstChild("AdminPatchAck");
	const spA = s.enter(admin);
	const spB = s.enter(bob);
	/** one request, a little later than the last (the admin's bucket refills 4/s) */
	const ask = (who, req) => {
		clockNow += 0.3;
		return RF.OnServerInvoke(who, req);
	};
	const tool = (who, op) => ask(who, { kind: "world", ...op });
	const audit = () => ask(admin, { kind: "auditLog" }).data ?? [];
	const pays = p => s.sim.paysRewards(s.body(p));
	return { s, admin, bob, spA, spB, RF, EV, ACK, ask, tool, audit, pays, logStore };
}

/** enough ticks for the World deltas to go out: they are batched on the snapshot's cadence (WORLD_FLUSH_EVERY_TICKS) */
function flushWorld(t) {
	for (let i = 0; i <= CFG.WORLD_FLUSH_EVERY_TICKS; i++) t.s.beat();
}

/** a point near `sp`, towards the middle of the town, where a circle of radius r fits (undefined when none) */
function freeNear(s, sp, offset, r = 24) {
	const w = s.sim.world;
	const dx = w.width / 2 - sp.state.x;
	const dy = w.height / 2 - sp.state.y;
	const l = Math.hypot(dx, dy) || 1;
	return WO.freePointIn(w, sp.state.x + (dx / l) * offset, sp.state.y + (dy / l) * offset, r, 600);
}

/**
 * A spot INSIDE a building, where a survivor's circle is blocked: the middle of the first big building whose middle
 * is solid. MP-26: the harness's server draws its own town, like the published game, so "the middle of the first big
 * building" can be an open room in one town and a wall in another -- the tests below need a spot that is blocked in
 * whatever town the server drew.
 */
function insideBuilding(world) {
	const b = world.solids.find(
		s =>
			s.kind === "building" &&
			s.w > 200 &&
			s.h > 200 &&
			circleBlocked(world, s.x + s.w / 2, s.y + s.h / 2, PLAYER_RADIUS) !== undefined,
	);
	if (b !== undefined) return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
	// no big building with a solid middle: the middle of a wall of one
	for (const s of world.solids) {
		if (s.kind === "building" || s.w < PLAYER_RADIUS || s.h < PLAYER_RADIUS) continue;
		const x = s.x + s.w / 2;
		const y = s.y + s.h / 2;
		if (circleBlocked(world, x, y, PLAYER_RADIUS) !== undefined) return { x, y };
	}
	return undefined;
}

/** the admin's last snapshot part 0 (the self block and the bosses), after a few ticks */
function lastSnapOf(s, who) {
	const snap = s.env.services.ReplicatedStorage.FindFirstChild("Net").FindFirstChild("Snap");
	snap.sent.length = 0;
	for (let i = 0; i < 4; i++) s.beat();
	const mine = snap.sent.filter(e => e.to === who);
	for (let i = mine.length - 1; i >= 0; i--) {
		const part = s.P.decodeSnapshotPart(mine[i].args[0]);
		if (part !== undefined && part.part === 0) return part;
	}
	return undefined;
}

/** every valid world tool, with arguments that would do something */
function everyTool(t) {
	const a = t.spA.state;
	return [
		{ op: "state" },
		{ op: "spawn", spawn: "walker", count: 5, x: a.x + 150, y: a.y, chase: true },
		{ op: "spawn", spawn: "boss1", count: 1, x: a.x + 300, y: a.y, chase: false },
		{ op: "killAll", radius: 0, x: 0, y: 0 },
		{ op: "clock", hour: 20 },
		{ op: "night" },
		{ op: "dawn" },
		{ op: "wave" },
		{ op: "rain", on: true },
		{ op: "weather", weather: 2 },
		{ op: "heal", userId: t.bob.UserId },
		{ op: "god", on: true },
		{ op: "noclip", on: true },
		{ op: "ammo", on: true },
		{ op: "teleport", x: a.x + 100, y: a.y },
		{ op: "clearFx" },
		{ op: "spawnItem", group: "weapon", index: 10, count: 1, x: a.x + 60, y: a.y },
		{ op: "spawnStructure", structure: "barricade", x: a.x + 200, y: a.y + 200 },
		{ op: "removeStructure", x: a.x + 200, y: a.y + 200 },
		{ op: "freecam", on: true, x: a.x + 500, y: a.y },
	];
}

/** what a tool could have changed, as a string (a non-admin's request must leave it exactly the same) */
function worldPrint(t) {
	const h = t.s.sim.horde;
	const c = t.s.sim.clock;
	const bodies = [t.spA, t.spB].map(sp => {
		const st = t.s.body(sp === t.spA ? t.admin : t.bob)?.state;
		return st === undefined
			? "none"
			: `${Math.round(st.x)},${Math.round(st.y)},${st.hp},${st.godMode},${st.noclip},${st.infiniteAmmo}`;
	});
	return J({
		zombies: h.zombies.length,
		bosses: h.bossRoster.list.length,
		day: c.day,
		hour: c.dayTime.toFixed(3),
		rain: c.isRaining,
		weather: c.weather,
		items: t.s.sim.world.items.length,
		solids: t.s.sim.world.solids.length,
		bodies,
		pays: [t.pays(t.admin), t.pays(t.bob)],
		view: J(t.s.host.replicator.viewCenter(t.s.body(t.admin))),
	});
}

// ================================================================ 1: who

section(
	"1) a non-admin gets 'forbidden' for every world tool and changes nothing; a flood of the remote is kicked once",
	() => {
		const t = town();
		const eve = t.s.join(newUser(), "Eve");
		eve.LocaleId = "en-us";
		t.s.enter(eve);
		const before = worldPrint(t);
		const evBefore = t.EV.sent.length;
		const leaks = [];
		for (const op of everyTool(t)) {
			const res = t.tool(eve, op);
			if (!(res.ok === false && res.error === "forbidden" && res.data === undefined))
				leaks.push(`${op.op}: ${J(res)}`);
		}
		verify(
			`all ${everyTool(t).length} world tools answer "forbidden" to a non-admin, with no data`,
			leaks.length === 0,
			leaks.join(" | "),
		);
		verify(
			"...and the world is exactly as it was (horde, clock, rain, items, solids, bodies, switches, runs, view)",
			worldPrint(t) === before,
			`${before} -> ${worldPrint(t)}`,
		);
		verify("...and no AdminEvent went out (no clear-blood broadcast)", t.EV.sent.length === evBefore);
		verify("...and Eve, who asked slowly, was not kicked", eve.kicked === false);

		// the flood: ADMIN_BURST requests in the same instant are refused; the next one is a flood
		const mallory = t.s.join(newUser(), "Mallory");
		mallory.LocaleId = "en-us";
		let kicks = 0;
		let kickText;
		mallory.Kick = m => {
			kicks += 1;
			kickText = m;
			mallory.kicked = true;
		};
		for (let i = 0; i < CFG.ADMIN_BURST; i++) t.RF.OnServerInvoke(mallory, { kind: "world", op: "state" });
		verify(`${CFG.ADMIN_BURST} requests at once from a non-admin: refused, not yet a flood`, kicks === 0);
		const res = t.RF.OnServerInvoke(mallory, { kind: "world", op: "god", on: true });
		verify(
			"one more in the same instant: kicked (and still refused)",
			kicks === 1 && res.error === "forbidden",
			`kicks ${kicks}`,
		);
		verify(
			"...with the account-language flood line of shared/data/rules.ts",
			String(kickText).includes("too many network messages"),
			kickText,
		);
		for (let i = 0; i < 30; i++) t.RF.OnServerInvoke(mallory, { kind: "players" });
		verify("...kicked ONCE however much more arrives before they are gone", kicks === 1, `kicks ${kicks}`);
		// back on the server and flooding again: kicked again, but the log already has its one line for them
		t.s.quit(mallory);
		const again = t.s.join(mallory.UserId, "Mallory");
		again.LocaleId = "en-us";
		let kicksAgain = 0;
		again.Kick = () => {
			kicksAgain += 1;
			again.kicked = true;
		};
		clockNow += 5;
		for (let i = 0; i <= CFG.ADMIN_BURST; i++) t.RF.OnServerInvoke(again, { kind: "world", op: "state" });
		verify("rejoined and flooding again: kicked again", kicksAgain === 1, `kicks ${kicksAgain}`);
		const log = t.audit();
		const autos = log.filter(e => e.action === "auto:flood");
		verify(
			"ONE audit entry for the automatic kick per player per server, the flooder as its TARGET and the server as who did it",
			autos.length === 1 &&
				autos[0].target.includes(String(mallory.UserId)) &&
				autos[0].adminId === 0 &&
				autos[0].admin === "server",
			J(autos),
		);
		verify(
			"the refused calls themselves stay throttled: one DENIED line per caller and visit (Eve, Mallory twice)",
			log.filter(e => e.action === "DENIED").length === 3,
			J(log.filter(e => e.action === "DENIED").map(e => e.admin)),
		);
		t.s.shutdown();
		const stored = [...t.logStore.data.values()].flat();
		verify(
			"the automatic kick reaches the stored log; DENIED does not",
			stored.some(e => e.action === "auto:flood") && !stored.some(e => e.action === "DENIED"),
		);
	},
);

// ================================================================ 2: what

section("2) malformed world tools are refused with a reason, and change nothing", () => {
	const t = town();
	const a = t.spA.state;
	const bad = [
		[{ op: "nope" }, "unknown world tool"],
		[{ op: 5 }, "unknown world tool"],
		[{}, "unknown world tool"],
		[{ op: "spawn", spawn: "walker", count: 0, x: a.x, y: a.y, chase: false }, "count"],
		[{ op: "spawn", spawn: "walker", count: 21, x: a.x, y: a.y, chase: false }, "count"],
		[{ op: "spawn", spawn: "walker", count: 1.5, x: a.x, y: a.y, chase: false }, "count"],
		[{ op: "spawn", spawn: "walker", count: "5", x: a.x, y: a.y, chase: false }, "count"],
		[{ op: "spawn", spawn: "walker", count: NaN, x: a.x, y: a.y, chase: false }, "count"],
		[{ op: "spawn", spawn: "walker", count: 1, x: NaN, y: a.y, chase: false }, "invalid point"],
		[{ op: "spawn", spawn: "walker", count: 1, x: Infinity, y: a.y, chase: false }, "invalid point"],
		[{ op: "spawn", spawn: "walker", count: 1, x: 1e9, y: a.y, chase: false }, "invalid point"],
		[{ op: "spawn", spawn: "tank", count: 1, x: a.x, y: a.y, chase: false }, "unknown zombie"],
		[{ op: "spawn", spawn: "walker", count: 1, x: a.x, y: a.y, chase: "yes" }, "invalid options"],
		[{ op: "killAll", radius: -1, x: 0, y: 0 }, "radius"],
		[{ op: "killAll", radius: 7000, x: 0, y: 0 }, "radius"],
		[{ op: "killAll", radius: 10, x: "a", y: 0 }, "invalid point"],
		[{ op: "clock", hour: 24 }, "hour"],
		[{ op: "clock", hour: -0.1 }, "hour"],
		[{ op: "clock", hour: "12" }, "hour"],
		[{ op: "rain", on: "true" }, "invalid options"],
		[{ op: "weather", weather: 5 }, "weather"],
		[{ op: "weather", weather: 1.5 }, "weather"],
		[{ op: "weather", weather: "fog" }, "weather"],
		[{ op: "god", on: 1 }, "invalid options"],
		[{ op: "noclip" }, "invalid options"],
		[{ op: "heal", userId: 0 }, "invalid player"],
		[{ op: "heal", userId: 1.5 }, "invalid player"],
		[{ op: "heal", userId: "x" }, "invalid player"],
		[{ op: "teleport", x: a.x }, "invalid point"],
		[{ op: "spawnItem", group: "gold", index: 0, count: 1, x: a.x, y: a.y }, "unknown item group"],
		[{ op: "spawnItem", group: "weapon", index: -1, count: 1, x: a.x, y: a.y }, "unknown item"],
		[{ op: "spawnItem", group: "weapon", index: 9999, count: 1, x: a.x, y: a.y }, "unknown item"],
		[{ op: "spawnItem", group: "etc", index: 44, count: 1, x: a.x, y: a.y }, "unknown item"],
		[{ op: "spawnItem", group: "ammo", index: 5, count: 1, x: a.x, y: a.y }, "electricity"],
		[{ op: "spawnItem", group: "weapon", index: 10, count: 0, x: a.x, y: a.y }, "count"],
		[{ op: "spawnItem", group: "weapon", index: 10, count: 10000, x: a.x, y: a.y }, "count"],
		[{ op: "spawnStructure", structure: "castle", x: a.x, y: a.y }, "unknown structure"],
		[{ op: "freecam", on: "yes", x: a.x, y: a.y }, "invalid options"],
		[{ op: "freecam", on: true, x: a.x }, "invalid point"],
	];
	const before = worldPrint(t);
	const leaks = [];
	for (const [op, why] of bad) {
		const res = t.tool(t.admin, op);
		if (res.ok !== false || !String(res.error).includes(why)) leaks.push(`${J(op)} -> ${J(res)}`);
	}
	verify(`${bad.length} malformed tools refused, each with its reason`, leaks.length === 0, leaks.join(" | "));
	verify("...and nothing in the world moved", worldPrint(t) === before, `${before} -> ${worldPrint(t)}`);
	const refusals = t.audit().filter(e => e.action.startsWith("world:") && !e.ok);
	verify(
		"...and the refusals are in the audit log, as refused",
		refusals.length > 0,
		`${refusals.length} refused lines`,
	);
});

// ================================================================ 3: spawn

section(
	"3) spawned zombies and bosses are the server's, capped, and pay nobody (no XP, kill, boss credit, loot)",
	() => {
		const t = town();
		const h = t.s.sim.horde;
		const at = freeNear(t.s, t.spA, 220);
		const n0 = h.zombies.length;
		let res = t.tool(t.admin, { op: "spawn", spawn: "walker", count: 5, x: at.x, y: at.y, chase: true });
		const mine = h.zombies.slice(n0);
		verify(
			"5 chasing walkers: OK, and five more zombies in the SERVER's horde",
			res.ok && mine.length === 5,
			`${res.message ?? res.error} (${mine.length})`,
		);
		verify(
			"...every one an admin spawn (unpaid), chasing",
			mine.every(z => z.unpaid === true && z.aware === 3 && z.detect === true),
		);
		verify(
			"...near where the admin clicked",
			mine.every(z => dist(z, at) < 200),
		);
		verify(
			"...and the answer says what the server holds for the admin (switches) and no assisted run",
			res.data?.state?.god === false && res.data?.assisted === false,
			J(res.data),
		);
		t.s.beat();
		verify(
			"...registered by the horde (netIds), so every client in range gets them",
			mine.every(z => h.netIdOf(z) > 0),
		);
		res = t.tool(t.admin, { op: "spawn", spawn: "fast", count: 3, x: at.x, y: at.y, chase: false });
		const fast = h.zombies.slice(-3);
		verify(
			"3 wandering fast walkers: not hunting",
			res.ok && fast.every(z => z.detect === false && z.unpaid === true),
			res.message ?? res.error,
		);

		// killing one pays nothing
		const save = t.s.save(t.admin);
		const before = { exp: save.exp, level: save.level, kills: save.zombieKills, items: t.s.sim.world.items.length };
		const statsBefore = t.s.sim.progress.statsOf(t.spA.slot).kills;
		const victim = mine[0];
		t.s.sim.combat.hitZombieWith(t.spA, victim, 1e6, 0, 0);
		for (let i = 0; i < 3; i++) t.s.beat();
		const near = t.s.sim.world.items.filter(it => Math.hypot(it.x - victim.x, it.y - victim.y) < 120).length;
		verify(
			"killing an admin's zombie: no XP, no level, no lifetime kill, no kill in the session",
			save.exp === before.exp &&
				save.level === before.level &&
				save.zombieKills === before.kills &&
				t.s.sim.progress.statsOf(t.spA.slot).kills === statsBefore,
			`exp ${before.exp}->${save.exp} kills ${before.kills}->${save.zombieKills}`,
		);
		verify("...and no loot where it fell", near === 0, `${near} items`);

		res = t.tool(t.admin, {
			op: "spawn",
			spawn: "walker",
			count: 1,
			x: t.spA.state.x + 9000,
			y: t.spA.state.y,
			chase: false,
		});
		verify(
			"a zombie far from every survivor is refused (the population would recycle it at once)",
			!res.ok && /too far/.test(res.error),
			res.error,
		);

		// the admin cap: MAX_ZOMBIES_ADMIN, whatever the natural horde is
		const { createZombie } = require(join(SRC, "shared/game/entities.ts"));
		while (h.zombies.length < CFG.MAX_ZOMBIES_ADMIN - 3) h.zombies.push(createZombie(1, at.x, at.y, 1, false));
		res = t.tool(t.admin, { op: "spawn", spawn: "walker", count: 5, x: at.x, y: at.y, chase: false });
		verify(
			`the horde at ${CFG.MAX_ZOMBIES_ADMIN - 3}: a spawn of 5 places 3 and says so`,
			res.ok && h.zombies.length === CFG.MAX_ZOMBIES_ADMIN && /Spawned 3/.test(res.message),
			`${res.message} (${h.zombies.length})`,
		);
		res = t.tool(t.admin, { op: "spawn", spawn: "walker", count: 1, x: at.x, y: at.y, chase: false });
		verify(
			`...and at ${CFG.MAX_ZOMBIES_ADMIN} it is refused`,
			!res.ok && res.error.includes(String(CFG.MAX_ZOMBIES_ADMIN)),
			res.error,
		);
		verify(
			"spawning never made anybody's run assisted (a spawn only adds danger)",
			t.pays(t.admin) && t.pays(t.bob),
		);
		// the test's own horde goes the way a vanished body goes (silent despawns): Kill all would assist every run
		h.zombies.splice(0);
		t.s.beat();

		// bosses: MAX_BOSSES at once (the snapshot carries that many), and one killed pays nothing
		const bat = freeNear(t.s, t.spA, 500, 60);
		const b0 = h.bossRoster.list.length;
		res = t.tool(t.admin, { op: "spawn", spawn: "boss3", count: 3, x: bat.x, y: bat.y, chase: false });
		verify(
			`3 giants asked: ${CFG.MAX_BOSSES - b0} placed (MAX_BOSSES ${CFG.MAX_BOSSES})`,
			res.ok && h.bossRoster.list.length === CFG.MAX_BOSSES,
			`${res.message} (${h.bossRoster.list.length})`,
		);
		res = t.tool(t.admin, { op: "spawn", spawn: "boss2", count: 1, x: bat.x, y: bat.y, chase: false });
		verify(
			"...and one more is refused",
			!res.ok && res.error.includes(`${CFG.MAX_BOSSES} admin bosses`),
			res.error,
		);
		const boss = h.bossRoster.list.find(b => b.unpaid === true);
		const money = save.money;
		const bossKills = save.bossKills;
		const itemsNear = () => t.s.sim.world.items.filter(it => Math.hypot(it.x - boss.x, it.y - boss.y) < 150).length;
		const nearBefore = itemsNear();
		t.s.sim.combat.hitBossWith(t.spA, boss, 1e9, boss.x, boss.y);
		for (let i = 0; i < 3; i++) t.s.beat();
		verify(
			"killing an admin's boss: no coins, no boss kill, no loot or trophy",
			save.money === money &&
				save.bossKills === bossKills &&
				itemsNear() === nearBefore &&
				!h.bossRoster.list.includes(boss),
			`money ${money}->${save.money} bossKills ${bossKills}->${save.bossKills} items ${nearBefore}->${itemsNear()}`,
		);
		verify("...nor did the bosses", t.pays(t.admin) && t.pays(t.bob));
	},
);

// ================================================================ 4: kill all

section(
	"4) kill all removes the horde on the server, in a radius or everywhere, and assists every run in the world",
	() => {
		const t = town();
		const h = t.s.sim.horde;
		const at = freeNear(t.s, t.spA, 300);
		t.tool(t.admin, { op: "spawn", spawn: "walker", count: 10, x: at.x, y: at.y, chase: false });
		t.s.beat();
		const far = freeNear(t.s, t.spA, 900);
		t.tool(t.admin, { op: "spawn", spawn: "spitter", count: 4, x: far.x, y: far.y, chase: false });
		t.s.beat();
		verify("before: nobody's run is assisted", t.pays(t.admin) && t.pays(t.bob));
		const inside = h.zombies.filter(z => dist(z, at) <= 150).length;
		const total = h.zombies.length;
		let res = t.tool(t.admin, { op: "killAll", radius: 150, x: at.x, y: at.y });
		verify(
			`radius 150 around the first group: removed ${inside}, the rest stands`,
			res.ok && h.zombies.length === total - inside && res.message === `Removed ${inside} enemies`,
			`${res.message} (${h.zombies.length}/${total})`,
		);
		verify("...the admin is told their own run is now assisted", res.data?.assisted === true, J(res.data));
		res = t.tool(t.admin, { op: "killAll", radius: 0, x: 0, y: 0 });
		verify(
			"radius 0: every zombie and boss on the server",
			res.ok && h.zombies.length === 0 && h.bossRoster.list.length === 0,
			res.message,
		);
		verify(
			"...and EVERY run in the world is now assisted (a horde cleared is a night nobody had to survive)",
			!t.pays(t.admin) && !t.pays(t.bob),
		);
		const lines = t.audit().filter(e => e.action === "world:killAll" && e.ok);
		verify(
			"...one audit line each (never merged), the first saying it assisted both runs",
			lines.length === 2 &&
				lines.some(e => /within 150 u/.test(e.details) && /2 runs now assisted/.test(e.details)),
			J(lines.map(e => e.details)),
		);
	},
);

// ================================================================ 5: clock

section("5) the clock tools move the SERVER's clock for everybody, pay no skipped day, and assist every run", () => {
	let t = town();
	const c = t.s.sim.clock;
	const World = t.s.env.services.ReplicatedStorage.FindFirstChild("Net").FindFirstChild("World");
	const bobSave = t.s.save(t.bob);
	const bobBefore = { day: bobSave.day, money: bobSave.money };
	World.sent.length = 0;
	let res = t.tool(t.admin, { op: "rain", on: true });
	verify("rain on: the server's clock rains", res.ok && c.isRaining === true, res.message);
	verify("...and rain assists nobody", t.pays(t.admin) && t.pays(t.bob));
	res = t.tool(t.admin, { op: "rain", on: false });
	verify("rain off", res.ok && c.isRaining === false);
	// LUZ-05: any of the five weathers, for everyone at once (the next Clock delta), assisting nobody like the rain
	res = t.tool(t.admin, { op: "weather", weather: 4 });
	verify(
		"weather fog: the server's clock has the day's fog, and it assists nobody",
		res.ok && c.weather === 4 && c.isRaining === false && t.pays(t.admin) && t.pays(t.bob),
		res.message,
	);
	res = t.tool(t.admin, { op: "weather", weather: 2 });
	verify("weather storm: a storm rains", res.ok && c.weather === 2 && c.isRaining === true, res.message);
	res = t.tool(t.admin, { op: "weather", weather: 0 });
	verify("weather clear", res.ok && c.weather === 0 && c.isRaining === false);
	res = t.tool(t.admin, { op: "clock", hour: 13.5 });
	verify(
		"clock 13:30: the server's clock is at 13:30",
		res.ok && Math.abs(c.dayTime - 13.5) < 1e-6,
		`${res.message} (${c.dayTime})`,
	);
	flushWorld(t);
	const clocks = [];
	for (const e of World.sent) {
		if (e.to !== undefined) continue;
		const batch = t.s.P.decodeWorld(e.args[0]);
		for (const ev of batch?.events ?? []) if (ev.t === t.s.P.WorldEv.Clock) clocks.push(ev);
	}
	verify(
		"...sent to EVERY client at once (a Clock delta on the broadcast)",
		clocks.some(ev => Math.abs(ev.dayTime - 13.5) < 0.05),
		J(clocks.map(e => e.dayTime)),
	);
	verify(
		"...and every run in the world is assisted (a skip back across midnight would pay a day twice)",
		!t.pays(t.admin) && !t.pays(t.bob),
	);
	res = t.tool(t.admin, { op: "night" });
	verify(
		"night from 13:30: 18:59, and the night's horde promised",
		res.ok && Math.abs(c.dayTime - 18.99) < 1e-6 && c.waveQueues[0] > 0,
		`${res.message} ${c.dayTime} ${J(c.waveQueues)}`,
	);
	t.s.run(1.5);
	res = t.tool(t.admin, { op: "night" });
	verify("night at night: refused", !res.ok && /already night/.test(res.error), res.error);
	const day = c.day;
	t.tool(t.admin, { op: "clock", hour: 23 });
	res = t.tool(t.admin, { op: "dawn" });
	verify(
		"dawn from 23:00: 06:59 of the NEXT day",
		res.ok && c.day === day + 1 && Math.abs(c.dayTime - 6.99) < 1e-6,
		`${res.message} day ${day}->${c.day} ${c.dayTime}`,
	);
	verify(
		"...and the midnight it skipped paid nobody (life day and coins unchanged)",
		bobSave.day === bobBefore.day && bobSave.money === bobBefore.money,
		`day ${bobBefore.day}->${bobSave.day} money ${bobBefore.money}->${bobSave.money}`,
	);
	t.s.run(1);
	res = t.tool(t.admin, { op: "dawn" });
	verify("dawn by day: refused", !res.ok && /already day/.test(res.error), res.error);
	t.tool(t.admin, { op: "clock", hour: 12 });
	res = t.tool(t.admin, { op: "wave" });
	verify(
		"wave at noon: wave 1 at 18:59",
		res.ok && Math.abs(c.dayTime - 18.99) < 1e-6 && res.message === "Wave 1 incoming",
		res.message,
	);
	t.tool(t.admin, { op: "clock", hour: 20 });
	res = t.tool(t.admin, { op: "wave" });
	verify(
		"wave at 20:00: wave 2 at 21:59",
		res.ok && Math.abs(c.dayTime - 21.99) < 1e-6 && res.message === "Wave 2 incoming",
		res.message,
	);
	const d2 = c.day;
	t.tool(t.admin, { op: "clock", hour: 23 });
	res = t.tool(t.admin, { op: "wave" });
	verify(
		"wave at 23:00: wave 3 at 00:59 of the next day",
		res.ok && c.day === d2 + 1 && Math.abs(c.dayTime - 0.99) < 1e-6,
		`${res.message} ${c.day} ${c.dayTime}`,
	);
	t.tool(t.admin, { op: "clock", hour: 3 });
	c.waveQueues[2] = 0;
	res = t.tool(t.admin, { op: "wave" });
	verify(
		"wave at 03:00: wave 3 refilled, the hands stay",
		res.ok && Math.abs(c.dayTime - 3) < 1e-6 && c.waveQueues[2] > 0 && res.message === "Wave 3 refilled",
		`${res.message} ${c.dayTime}`,
	);
	// a slider dragged: three DIFFERENT sets are three lines (a line keeps what it says: L3 of the review)
	const clockLines = () => t.audit().filter(e => e.action === "world:clock");
	const c0 = clockLines().length;
	t.tool(t.admin, { op: "clock", hour: 10 });
	t.tool(t.admin, { op: "clock", hour: 10.5 });
	t.tool(t.admin, { op: "clock", hour: 11 });
	verify(
		"three different clock sets in a row: three audit lines, each with its own value",
		clockLines().length === c0 + 3 && /set to 11:00/.test(clockLines()[0]?.details),
		J(clockLines().map(e => e.details)),
	);

	// the dead wait for the 06:00 the clock shows now
	t = town();
	t.s.sim.clock.setClock(22);
	t.s.immortal.delete(t.bob);
	t.s.kill(t.bob);
	const waitNight = t.s.host.lives.daybreakIn(t.bob.UserId);
	t.tool(t.admin, { op: "clock", hour: 5.9 });
	const waitDawn = t.s.host.lives.daybreakIn(t.bob.UserId);
	verify(
		"a dead survivor's wait follows the moved clock (22:00 -> 05:54: much shorter)",
		waitNight > 0 && waitDawn > 0 && waitDawn < waitNight / 3,
		`${waitNight?.toFixed(1)} s -> ${waitDawn?.toFixed(1)} s`,
	);
});

// ================================================================ 6: heal

section(
	"6) heal: the admin or another survivor in the world, on the server; the healed run is the assisted one",
	() => {
		const t = town();
		const b = t.s.body(t.bob).state;
		b.hp = 10;
		b.hungry = 5;
		b.buffs.poison = 3;
		let res = t.tool(t.admin, { op: "heal", userId: t.bob.UserId });
		verify(
			"heal Bob: full hp and stomach, no poison, on the SERVER's body",
			res.ok && b.hp === b.hpMax && b.hungry === b.hungryMax && b.buffs.poison === 0,
			`${res.message} hp ${b.hp}/${b.hpMax}`,
		);
		verify("...Bob's run is assisted, the admin's is not", !t.pays(t.bob) && t.pays(t.admin));
		const line = t.audit().find(e => e.action === "world:heal" && e.ok);
		verify(
			"...one audit line naming Bob",
			line !== undefined && line.target.includes(String(t.bob.UserId)),
			J(line),
		);
		const a = t.s.body(t.admin).state;
		a.hp = 20;
		res = t.tool(t.admin, { op: "heal", userId: t.admin.UserId });
		verify(
			"heal yourself: full, and now your own run is assisted",
			res.ok && a.hp === a.hpMax && !t.pays(t.admin) && res.data?.assisted === true,
			J(res),
		);
		res = t.tool(t.admin, { op: "heal", userId: 424242 });
		verify("heal somebody not on this server: refused", !res.ok && /not in this server/.test(res.error), res.error);
		const lobby = t.s.join(newUser(), "Lobby");
		res = t.tool(t.admin, { op: "heal", userId: lobby.UserId });
		verify("heal somebody in the lobby: refused", !res.ok && /not in the world/.test(res.error), res.error);
		t.s.immortal.delete(t.bob);
		t.s.kill(t.bob);
		res = t.tool(t.admin, { op: "heal", userId: t.bob.UserId });
		verify(
			"heal the dead: refused (a heal is not a revive)",
			!res.ok && /dead/.test(res.error) && t.s.body(t.bob).state.dead === true,
			res.error,
		);
	},
);

// ================================================================ 7: switches

section(
	"7) god, noclip and infinite ammo live on the server body, reach the snapshot, outlive a new body, end on leaving",
	() => {
		const t = town();
		const combat = t.s.sim.combat;
		verify("before: the admin's run is not assisted", t.pays(t.admin));
		let res = t.tool(t.admin, { op: "god", on: true });
		let a = t.s.body(t.admin).state;
		verify(
			"god on: the SERVER's body is a god, the answer says so, the run is assisted",
			res.ok && a.godMode === true && res.data?.state?.god === true && !t.pays(t.admin),
			J(res.data),
		);
		let snap = lastSnapOf(t.s, t.admin);
		verify(
			"...and the admin's own snapshot carries it (modFlags God): the HUD shows the server's truth",
			snap !== undefined && (snap.self.modFlags & t.s.P.ModFlag.God) !== 0,
			J(snap?.self?.modFlags),
		);
		const hp0 = a.hp;
		combat.damageActor(t.spA.slot, a, t.s.save(t.admin), 500, true);
		verify("a lethal blow does nothing to a god", a.hp === hp0 && !a.dead, `hp ${a.hp}`);
		a.hungry = 0;
		a.buffs.poison = 60;
		t.s.run(8);
		a = t.s.body(t.admin).state;
		verify(
			"8 s starving and poisoned: alive and full (topped up before every step, a step can never take a god to 0)",
			!a.dead && a.hp > a.hpMax - 0.5 && a.buffs.poison === 0,
			`hp ${a.hp}/${a.hpMax} dead ${a.dead}`,
		);

		res = t.tool(t.admin, { op: "noclip", on: true });
		a = t.s.body(t.admin).state;
		snap = lastSnapOf(t.s, t.admin);
		verify(
			"noclip on: on the server body and in modFlags (the prediction uses the same flag)",
			res.ok && a.noclip === true && (snap.self.modFlags & t.s.P.ModFlag.Noclip) !== 0,
		);
		// stand the body inside a building's wall, then noclip off: out to free ground
		const wall = insideBuilding(t.s.sim.world);
		a.x = wall.x;
		a.y = wall.y;
		const inside = circleBlocked(t.s.sim.world, a.x, a.y, PLAYER_RADIUS) !== undefined;
		res = t.tool(t.admin, { op: "noclip", on: false });
		a = t.s.body(t.admin).state;
		verify(
			"noclip off inside a building: carried out to free ground",
			res.ok &&
				inside &&
				a.noclip === false &&
				circleBlocked(t.s.sim.world, a.x, a.y, PLAYER_RADIUS) === undefined,
			`inside ${inside}, now at ${Math.round(a.x)},${Math.round(a.y)}`,
		);

		// god outlives a new body: an admin reset of the admin's own save builds one
		t.ask(t.admin, { kind: "resetSave", userId: t.admin.UserId });
		const ev = t.EV.sent.filter(e => e.to === t.admin && e.args[0]?.kind === "patch").pop()?.args[0];
		t.ACK.OnServerEvent.Fire(t.admin, ev?.rev);
		t.s.beat();
		const fresh = t.s.body(t.admin).state;
		verify(
			"a new body (the admin's save reset): still a god -- the switch is the person's, not the body's",
			fresh !== a && fresh.godMode === true,
			`godMode ${fresh.godMode}`,
		);
		res = t.tool(t.admin, { op: "state" });
		verify(
			"state: the server says god on, noclip off, ammo off",
			res.ok && res.data.state.god === true && res.data.state.noclip === false && res.data.state.ammo === false,
			J(res.data),
		);
		res = t.tool(t.admin, { op: "god", on: false });
		t.s.beat();
		const b = t.s.body(t.admin).state;
		combat.damageActor(t.spA.slot, b, t.s.save(t.admin), 10, true);
		verify("god off: a blow lands again", res.ok && b.godMode === false && b.hp < b.hpMax, `hp ${b.hp}/${b.hpMax}`);

		// infinite ammo: a survivor armed with a pistol and 30 rounds
		const u = newUser();
		const t2 = town();
		const PISTOL_MAG = require(join(SRC, "shared/data/weapons.ts")).WEAPONS[PISTOL].mag;
		armPistol(t2.s.save(t2.admin), 30);
		t2.s.exit(t2.admin);
		t2.s.enter(t2.admin);
		let sp = t2.s.body(t2.admin);
		sp.state.weapon.ammoCount = 0;
		const reserve = t2.s.save(t2.admin).ammoNormal;
		res = t2.tool(t2.admin, { op: "ammo", on: true });
		t2.s.beat();
		sp = t2.s.body(t2.admin);
		verify(
			"infinite ammo on: the magazine is full at the next tick, and nothing came out of the reserve",
			res.ok &&
				sp.state.infiniteAmmo === true &&
				sp.state.weapon.ammoCount === PISTOL_MAG &&
				t2.s.save(t2.admin).ammoNormal === reserve,
			`mag ${sp.state.weapon.ammoCount}/${PISTOL_MAG} reserve ${reserve}->${t2.s.save(t2.admin).ammoNormal}`,
		);
		res = t2.tool(t2.admin, { op: "ammo", on: false });
		sp = t2.s.body(t2.admin);
		verify(
			"off: the free magazine is emptied (it never becomes real rounds)",
			res.ok && sp.state.infiniteAmmo === false && sp.state.weapon.ammoCount === 0,
		);
		t2.s.exit(t2.admin);
		verify(
			"...and leaving refunds nothing of it",
			t2.s.save(t2.admin).ammoNormal === reserve,
			`${reserve} -> ${t2.s.save(t2.admin).ammoNormal}`,
		);
		void u;

		// they end with the admin's session
		t2.tool(t2.admin, { op: "god", on: true });
		t2.s.quit(t2.admin);
		const back = t2.s.join(t2.admin.UserId, "Owner");
		res = t2.tool(back, { op: "state" });
		verify(
			"the admin leaves the server and comes back: every switch is off",
			res.ok && res.data.state.god === false && res.data.state.noclip === false,
			J(res.data),
		);
	},
);

// ================================================================ 8: teleport

section("8) teleport moves the admin's SERVER body to a walkable point", () => {
	const t = town();
	verify("before: not assisted", t.pays(t.admin));
	const to = freeNear(t.s, t.spA, 700);
	let res = t.tool(t.admin, { op: "teleport", x: to.x, y: to.y });
	let a = t.s.body(t.admin).state;
	verify(
		"to free ground: the server's body is there, and the answer says where",
		res.ok && Math.abs(a.x - to.x) < 1 && Math.abs(a.y - to.y) < 1 && Math.abs(res.data.x - a.x) < 1e-6,
		`${res.message} ${Math.round(a.x)},${Math.round(a.y)}`,
	);
	verify("...the admin's run is assisted", !t.pays(t.admin) && t.pays(t.bob));
	const wall = t.s.sim.world.solids.find(s => s.kind === "building" && s.w > 200 && s.h > 200);
	res = t.tool(t.admin, { op: "teleport", x: wall.x + wall.w / 2, y: wall.y + wall.h / 2 });
	a = t.s.body(t.admin).state;
	verify(
		"into a building's wall: the nearest point a body fits",
		res.ok && circleBlocked(t.s.sim.world, a.x, a.y, PLAYER_RADIUS) === undefined,
		`${Math.round(a.x)},${Math.round(a.y)}`,
	);
	res = t.tool(t.admin, { op: "teleport", x: 0, y: 0 });
	a = t.s.body(t.admin).state;
	const [x0, y0] = WO.townBounds(t.s.sim.world, PLAYER_RADIUS);
	verify(
		"to (0, 0): kept inside the town (the border forest is the map's edge)",
		res.ok && a.x >= x0 - 1 && a.y >= y0 - 1,
		`${Math.round(a.x)},${Math.round(a.y)}`,
	);
	const line = t.audit().find(e => e.action === "world:teleport" && e.ok);
	verify("...audited", line !== undefined && line.target === "own run", J(line));
	t.s.exit(t.admin);
	res = t.tool(t.admin, { op: "teleport", x: to.x, y: to.y });
	verify("from the lobby: refused", !res.ok && /not in the world/.test(res.error), res.error);
});

// ================================================================ 9: clear

section("9) clear bodies & blood: the server's acid, and every client told to drop its decals", () => {
	const t = town();
	const refs = t.s.sim.horde.refs;
	refs.puddles = refs.puddles ?? [];
	refs.puddles.push({ x: 1, y: 1, r: 30, life: 5, lifeMax: 5 }, { x: 2, y: 2, r: 30, life: 5, lifeMax: 5 });
	const before = t.EV.sent.length;
	const res = t.tool(t.admin, { op: "clearFx" });
	verify("the acid puddles are gone on the server", res.ok && refs.puddles.length === 0, res.message);
	const sent = t.EV.sent.slice(before);
	verify(
		"...and ONE clearFx went to every client (FireAllClients)",
		sent.length === 1 && sent[0].to === undefined && sent[0].args[0]?.kind === "clearFx",
		J(sent.map(e => e.args[0])),
	);
	verify("...no run assisted", t.pays(t.admin) && t.pays(t.bob));
});

// ================================================================ 10: items and structures

section("10) items and structures through the server world: announced to the clients, validated, capped", () => {
	const t = town();
	const World = t.s.env.services.ReplicatedStorage.FindFirstChild("Net").FindFirstChild("World");
	const at = freeNear(t.s, t.spA, 80, 12);
	const n0 = t.s.sim.world.items.length;
	World.sent.length = 0;
	let res = t.tool(t.admin, { op: "spawnItem", group: "weapon", index: 10, count: 1, x: at.x, y: at.y });
	const item = t.s.sim.world.items.find(
		it => it.kind === 1 && it.itemId === 10 && Math.hypot(it.x - at.x, it.y - at.y) < 40,
	);
	verify(
		"a pistol dropped: in the SERVER's items, where it was asked",
		res.ok && t.s.sim.world.items.length >= n0 + 1 && item !== undefined,
		`${res.message} ${J(item)}`,
	);
	flushWorld(t);
	const adds = [];
	for (const e of World.sent) {
		if (e.to !== t.admin) continue;
		for (const ev of t.s.P.decodeWorld(e.args[0])?.events ?? []) if (ev.t === t.s.P.WorldEv.ItemAdd) adds.push(ev);
	}
	verify(
		"...and announced to the admin's client (ItemAdd with the server's id)",
		item !== undefined && adds.some(ev => ev.id === item.id),
		`${adds.length} ItemAdd`,
	);
	verify("...the admin's run is assisted (free loot), Bob's is not", !t.pays(t.admin) && t.pays(t.bob));
	res = t.tool(t.admin, { op: "spawnItem", group: "ammo", index: 0, count: 250, x: at.x, y: at.y });
	const ammo = t.s.sim.world.items.find(it => it.kind === 4 && it.itemId === 44 && it.count === 250);
	verify("250 normal rounds: the ETC ammo item 44", res.ok && ammo !== undefined, res.message ?? res.error);
	res = t.tool(t.admin, {
		op: "spawnItem",
		group: "weapon",
		index: 10,
		count: 1,
		x: t.spA.state.x + 9000,
		y: t.spA.state.y,
	});
	verify("an item far from every survivor is refused", !res.ok && /too far/.test(res.error), res.error);

	const spot = freeNear(t.s, t.spA, 260, 90);
	const solids = t.s.sim.world.solids.length;
	World.sent.length = 0;
	res = t.tool(t.admin, { op: "spawnStructure", structure: "barricade", x: spot.x, y: spot.y });
	const wall = t.s.sim.world.solids[t.s.sim.world.solids.length - 1];
	verify(
		"a barricade: a construction of the server's world, built by the ADMIN's account (MP-24: its cap, its rot)",
		res.ok &&
			t.s.sim.world.solids.length === solids + 1 &&
			wall.placeable === 10 &&
			wall.builder === t.admin.UserId &&
			wall.owner === t.spA.slot &&
			t.s.sim.build.countOfUser(t.admin.UserId) === 1,
		`${res.message ?? res.error} ${J({ placeable: wall.placeable, owner: wall.owner, builder: wall.builder })}`,
	);
	flushWorld(t);
	const solidAdds = [];
	for (const e of World.sent) {
		if (e.to !== undefined) continue;
		for (const ev of t.s.P.decodeWorld(e.args[0])?.events ?? [])
			if (ev.t === t.s.P.WorldEv.SolidAdd) solidAdds.push(ev);
	}
	verify(
		"...broadcast to every client (SolidAdd)",
		solidAdds.some(ev => ev.id === wall.id),
		`${solidAdds.length} SolidAdd`,
	);
	res = t.tool(t.admin, { op: "spawnStructure", structure: "barricade", x: spot.x, y: spot.y });
	verify(
		"another one on top of it: refused (something is in the way)",
		!res.ok && /blocked/.test(res.error),
		res.error,
	);
	const house = t.s.sim.world.solids.find(s => s.kind === "building");
	res = t.tool(t.admin, { op: "spawnStructure", structure: "lamp", x: house.x + house.w / 2, y: house.y + 4 });
	verify("on a building's wall: refused", !res.ok, res.error);
});

// ================================================================ 11: free camera

section(
	"11) free camera: the admin's interest follows the camera, within FREECAM_MAX_RANGE, lapsing, on its own bucket",
	() => {
		const t = town();
		const rep = t.s.host.replicator;
		const a = t.s.body(t.admin).state;
		// a giant ~2500 u away, towards the middle of the town (bosses are never recycled)
		const bat = freeNear(t.s, t.spA, 2500, 60);
		let res = t.tool(t.admin, { op: "spawn", spawn: "boss3", count: 1, x: bat.x, y: bat.y, chase: false });
		const boss = t.s.sim.horde.bossRoster.list.find(b => b.unpaid === true);
		verify(
			"a giant spawned far from the admin",
			res.ok && boss !== undefined && dist(boss, a) > 1800,
			`${res.message ?? res.error} at ${boss ? Math.round(dist(boss, a)) : "?"} u`,
		);
		let snap = lastSnapOf(t.s, t.admin);
		verify(
			"without the free camera the admin is NOT sent it (interest is around the body)",
			snap !== undefined && snap.bosses.length === 0,
			`${snap?.bosses.length} bosses`,
		);
		res = t.tool(t.admin, { op: "freecam", on: true, x: boss.x, y: boss.y });
		verify(
			"free camera on at the giant: OK, the admin's run assisted (it is scouting)",
			res.ok && res.data.state.freecam === true && !t.pays(t.admin),
			J(res.data),
		);
		snap = lastSnapOf(t.s, t.admin);
		verify(
			"...now the giant IS in the admin's snapshots",
			snap !== undefined && snap.bosses.length === 1,
			`${snap?.bosses.length} bosses`,
		);
		const bobSnap = lastSnapOf(t.s, t.bob);
		verify(
			"...and only in theirs (Bob's interest did not move)",
			bobSnap !== undefined && bobSnap.bosses.length === 0,
			`${bobSnap?.bosses.length}`,
		);
		res = t.tool(t.admin, { op: "freecam", on: true, x: a.x + 5000, y: a.y });
		verify(
			"a camera 5000 u away: the interest is held at FREECAM_MAX_RANGE (3000 u) from the body",
			res.ok && Math.abs(Math.hypot(res.data.x - a.x, res.data.y - a.y) - CFG.FREECAM_MAX_RANGE) < 1,
			J(res.data),
		);
		t.s.run(5);
		const c = rep.viewCenter(t.s.body(t.admin));
		verify(
			"not refreshed for 5 s: the interest lapses back to the body",
			Math.abs(c.x - t.s.body(t.admin).state.x) < 1e-6,
			`${Math.round(c.x)} vs ${Math.round(t.s.body(t.admin).state.x)}`,
		);
		t.tool(t.admin, { op: "freecam", on: true, x: boss.x, y: boss.y });
		res = t.tool(t.admin, { op: "freecam", on: false, x: 0, y: 0 });
		const c2 = rep.viewCenter(t.s.body(t.admin));
		verify(
			"off: back to the body at once",
			res.ok && res.data.state.freecam === false && Math.abs(c2.x - t.s.body(t.admin).state.x) < 1e-6,
		);
		const cams = t.audit().filter(e => e.action === "world:freecam");
		verify(
			"the audit logs the on/off edges only, never the moves",
			cams.length >= 1 && cams.length <= 3,
			J(cams.map(e => e.details)),
		);
		// its own bucket: five moves in one instant pass, the sixth waits; a panel request at that instant still passes
		clockNow += 5;
		let passed = 0;
		for (let i = 0; i < 6; i++) {
			const r = t.RF.OnServerInvoke(t.admin, { kind: "world", op: "freecam", on: true, x: a.x, y: a.y });
			if (r.ok) passed += 1;
		}
		const other = t.RF.OnServerInvoke(t.admin, { kind: "serverInfo" });
		verify(
			`${WO.ADMIN_WORLD_LIMITS.FREECAM_HZ} camera updates at once pass, the next is refused; the panel's own bucket is untouched`,
			passed === WO.ADMIN_WORLD_LIMITS.FREECAM_HZ && other.ok === true,
			`${passed} passed, serverInfo ${other.ok}`,
		);
	},
);

// ================================================================ 12, 13: audit and rate

section("12) every world tool leaves one audit line (world:*), refusals included, as a tool entry", () => {
	const t = town();
	const at = freeNear(t.s, t.spA, 200);
	t.tool(t.admin, { op: "spawn", spawn: "walker", count: 2, x: at.x, y: at.y, chase: false });
	t.tool(t.admin, { op: "god", on: true });
	t.tool(t.admin, { op: "god", on: false });
	t.tool(t.admin, { op: "clock", hour: 25 });
	t.tool(t.admin, { op: "state" });
	const log = t.audit();
	const world = log.filter(e => e.action.startsWith("world:"));
	verify(
		"spawn and god are logged as done",
		world.some(e => e.action === "world:spawn" && e.ok) && world.some(e => e.action === "world:god" && e.ok),
		J(world.map(e => `${e.action}:${e.ok}`)),
	);
	verify(
		"the refused clock is logged as refused",
		world.some(e => e.action === "world:clock" && !e.ok && /hour/.test(e.details)),
	);
	verify("reading the switches (state) is not logged", !world.some(e => e.action === "world:state"));
	verify("nothing is logged as a local tool any more", !log.some(e => e.action.startsWith("local:")));
	t.s.shutdown();
	const stored = [...t.logStore.data.values()].flat();
	verify(
		"...and the lines reach the stored log",
		stored.some(e => e.action === "world:spawn"),
	);
});

section("13) world tools share the admin's token bucket (burst 12, then 'too many requests')", () => {
	const t = town();
	clockNow += 10;
	let refused = 0;
	for (let i = 0; i < 20; i++) {
		const res = t.RF.OnServerInvoke(t.admin, { kind: "world", op: "state" });
		if (!res.ok && String(res.error).includes("too many")) refused += 1;
	}
	verify("20 at once: 12 pass, 8 refused", refused === 8, `${refused} refused`);
});

// ================================================================ 14: BUG-1

section("14) an admin reset drops the body the keeper held (BUG-1): no old hp, death or magazine comes back", () => {
	const t = town();
	/** reset while in the world, then what the client does (ack, lobby = LeaveWorld), then Play again */
	const resetCycle = p => {
		const res = t.ask(t.admin, { kind: "resetSave", userId: p.UserId });
		const ev = t.EV.sent.filter(e => e.to === p && e.args[0]?.kind === "patch").pop()?.args[0];
		t.ACK.OnServerEvent.Fire(p, ev?.rev);
		const body = t.s.body(p)?.state;
		const afterReset = { ammo: t.s.save(p).ammoNormal, runOver: t.s.save(p).runOver, runHp: t.s.save(p).runHp };
		t.s.exit(p);
		const afterLeave = { ammo: t.s.save(p).ammoNormal, runOver: t.s.save(p).runOver, runHp: t.s.save(p).runHp };
		const sp = t.s.enter(p);
		return {
			res,
			body,
			afterReset,
			afterLeave,
			sp,
			afterEnter: { ammo: t.s.save(p).ammoNormal, runOver: t.s.save(p).runOver },
		};
	};
	const fresh = defaultSave();
	const alive = t.s.join(newUser(), "alive");
	t.s.immortal.add(alive);
	armPistol(t.s.save(alive), 30);
	const spA = t.s.enter(alive);
	const old = spA.state;
	const posBefore = { x: old.x, y: old.y };
	old.hp = 37;
	const r1 = resetCycle(alive);
	verify("the reset is accepted", r1.res.ok === true, J(r1.res.error));
	verify(
		"the body in the world is replaced at once: a new, full body (not the old one where it stood)",
		r1.body !== undefined && r1.body !== old && r1.body.hp === r1.body.hpMax && dist(r1.body, posBefore) > 1,
		`hp ${r1.body?.hp}/${r1.body?.hpMax} moved ${r1.body ? Math.round(dist(r1.body, posBefore)) : "?"} u`,
	);
	verify(
		"LeaveWorld does not bank the OLD body's hp into the reset save",
		r1.afterLeave.runHp === 0 || r1.afterLeave.runHp >= 100,
		`runHp after leave ${r1.afterLeave.runHp}`,
	);
	verify(
		"re-entering does not pay the OLD magazine into the reset save",
		r1.afterEnter.ammo === fresh.ammoNormal,
		`reserve ${r1.afterReset.ammo} -> ${r1.afterEnter.ammo} (fresh ${fresh.ammoNormal})`,
	);
	verify(
		"...and the survivor comes back alive, in the new body",
		r1.sp !== undefined && r1.sp.state.dead === false && r1.sp.state !== old,
	);

	const d = t.s.join(newUser(), "dead");
	t.s.enter(d);
	t.s.kill(d);
	verify("the survivor is dead before the reset", t.s.save(d).runOver === true, `runOver ${t.s.save(d).runOver}`);
	const r2 = resetCycle(d);
	verify(
		"right after the reset the save is a new life",
		r2.afterReset.runOver === false,
		`runOver ${r2.afterReset.runOver}`,
	);
	verify(
		"...and the body standing in the world is alive now (the death belonged to the old save)",
		r2.body !== undefined && r2.body.dead === false,
	);
	verify(
		"LeaveWorld does not write the OLD death into the reset save",
		r2.afterLeave.runOver === false,
		`runOver after leave ${r2.afterLeave.runOver}`,
	);
	verify(
		"the reset survivor enters ALIVE",
		r2.sp?.state.dead === false,
		`body dead=${r2.sp?.state.dead} runOver ${r2.afterEnter.runOver}`,
	);
	verify("...and nobody is waiting on a daybreak for them", t.s.host.lives.daybreakIn(d.UserId) === undefined);

	// out of the world: the kept body is dropped too
	const k = t.s.join(newUser(), "kept");
	armPistol(t.s.save(k), 30);
	const spK = t.s.enter(k);
	spK.state.hp = 25;
	t.s.exit(k);
	verify("a body kept in the lobby (hp 25, a loaded pistol)", t.s.host.lives.keptBody(k.UserId) !== undefined);
	t.ask(t.admin, { kind: "resetSave", userId: k.UserId });
	verify("...is forgotten by the reset", t.s.host.lives.keptBody(k.UserId) === undefined);
	const back = t.s.enter(k);
	verify(
		"...and the next entry builds a fresh, full body with nothing refunded",
		back !== undefined && back.state.hp === back.state.hpMax && t.s.save(k).ammoNormal === fresh.ammoNormal,
		`hp ${back?.state.hp} reserve ${t.s.save(k).ammoNormal}`,
	);
});

// ================================================================ 15: BUG-3

section("15) the Studio messages say what is true (BUG-3)", () => {
	const t = town();
	const { Players, RunService } = t.s.env.services;
	RunService.IsStudio = () => true;
	Players.GetBanHistoryAsync = () => {
		throw new Error("GetBanHistoryAsync only works on production servers");
	};
	Players.BanAsync = () => {
		throw new Error("Players.BanningEnabled is false");
	};
	Players.GetNameFromUserIdAsync = id => `user${id}`;
	let res = t.ask(t.admin, { kind: "banHistory", target: "12345" });
	verify(
		"ban history in Studio: 'only on a live server', and never 'publish'",
		!res.ok && /live server/.test(res.error) && !/publish/i.test(res.error),
		res.error,
	);
	const ban = {
		kind: "ban",
		target: "-5",
		duration: "1h",
		displayReason: "",
		privateReason: "",
		applyToUniverse: true,
		excludeAlts: false,
	};
	res = t.ask(t.admin, ban);
	verify(
		"a negative UserId: 'a Studio test player', not 'invalid username'",
		!res.ok && /negative UserId/.test(res.error) && !/username/.test(res.error),
		res.error,
	);
	res = t.ask(t.admin, { kind: "unban", target: "-7", applyToUniverse: true });
	verify("...the same for an unban", !res.ok && /negative UserId/.test(res.error), res.error);
	res = t.ask(t.admin, { ...ban, target: "12345" });
	verify(
		"a ban that fails in Studio: points at Players.BanningEnabled (and not at publishing)",
		!res.ok && /BanningEnabled/.test(res.error) && !/publish/i.test(res.error),
		res.error,
	);
});

// ================================================================ 16: the panel (client) against the real server

section(
	"16) the panel's world (client/admin/serverWorld.ts) says what the SERVER said: never a success it refused",
	() => {
		const t = town();
		// the little of the Roblox value types the client modules build at load (the renderer's constants)
		globalThis.Vector2 ??= class {
			constructor(x = 0, y = 0) {
				this.X = x;
				this.Y = y;
			}
		};
		globalThis.UDim ??= class {
			constructor(scale = 0, offset = 0) {
				this.Scale = scale;
				this.Offset = offset;
			}
		};
		globalThis.UDim2 ??= {
			fromScale: (x, y) => ({ x, y }),
			fromOffset: (x, y) => ({ x, y }),
			new: (a, b, c, d) => ({ a, b, c, d }),
		};
		const auth = require(join(SRC, "client/net/authority.ts"));
		const net = require(join(SRC, "client/admin/net.ts"));
		const { AdminWorldHost } = require(join(SRC, "client/admin/serverWorld.ts"));
		let owned = true;
		auth.setWorldAuthority({ owned: () => owned, send: () => false, buildEdge() {}, reserveSpent() {} });
		// the panel's requests go to the REAL admin remote, as the admin; the answer comes back as net.ts shapes it
		const sent = [];
		net.adminRequest = req => {
			sent.push(req);
			clockNow += 0.3;
			const raw = t.RF.OnServerInvoke(t.admin, req);
			return { ok: raw.ok === true, error: raw.error, message: raw.message, data: raw.data };
		};
		net.adminRequestAsync = (req, done) => {
			const res = net.adminRequest(req);
			done?.(res);
		};
		const body = t.s.body(t.admin).state;
		// the client's mirror: its own survivor where the server has it, the server's town
		const player = {
			x: body.x,
			y: body.y,
			dead: false,
			hp: 100,
			hpMax: 100,
			godMode: undefined,
			noclip: undefined,
		};
		const refs = {
			player,
			world: t.s.sim.world,
			zombies: [],
			bosses: [],
			daynight: t.s.sim.clock,
			save: t.s.save(t.admin),
		};
		const cam = {
			x: body.x,
			y: body.y,
			zoom: 1,
			detached: false,
			setDetached(on) {
				this.detached = on;
			},
		};
		const ctx = { phase: "playing", cam };
		const loop = { getRefs: () => refs, admin: { noclip: false, frozen: false }, clearEffects() {} };
		const host = new AdminWorldHost(ctx, loop, new Instance("Frame"), t.admin.UserId);
		const toasts = [];
		host.notify = (text, kind) => toasts.push({ text, kind });
		let assistedTold = 0;
		host.onServerAssist = () => (assistedTold += 1);

		verify("with the server owning the world, the panel says so", host.serverWorld() === true);
		const h = t.s.sim.horde;
		const n0 = h.zombies.length;
		let res = host.spawnZombies("walker", 4, body.x + 9000, body.y, false);
		verify(
			"a spawn the server refuses: NOT ok, with the server's reason, and marked as already audited",
			res.ok === false && /too far/.test(res.message) && res.audited === true && h.zombies.length === n0,
			J(res),
		);
		const at = freeNear(t.s, t.spA, 220);
		res = host.spawnZombies("walker", 4, at.x, at.y, true);
		verify(
			"a spawn it runs: ok, in the server's words, and the server's horde has them",
			res.ok && res.message === "Spawned 4" && res.audited === true && h.zombies.length === n0 + 4,
			J(res),
		);
		verify(
			"...sent as ONE world request, nothing to the local log",
			sent.filter(r => r.kind === "logLocal").length === 0 &&
				sent.at(-1).kind === "world" &&
				sent.at(-1).op === "spawn",
		);

		res = host.setGod(true);
		verify(
			"god on: ok, and the switch shows what the SERVER now holds",
			res.ok && host.god() === true && t.s.body(t.admin).state.godMode === true,
			J(res),
		);
		verify("...the admin is told their run is assisted, once", assistedTold === 1, `${assistedTold}`);
		player.godMode = false;
		host.beforeUpdate();
		host.afterUpdate();
		verify(
			"...and the client never fakes it: the frame hooks leave the body's god flag to the snapshot",
			player.godMode === false && player.hp === 100,
		);
		res = host.setNoclip(true);
		verify(
			"noclip on: the prediction's switch follows the server's answer",
			res.ok && loop.admin.noclip === true && host.noclip() === true,
		);
		res = host.setNoclip(false);
		verify("noclip off: back off", res.ok && loop.admin.noclip === false && host.noclip() === false);

		// a server that refuses a switch: the switch does not stay on
		t.s.exit(t.admin);
		res = host.teleport(at.x, at.y);
		verify(
			"a teleport from the lobby: refused by the server, NOT a success",
			res.ok === false && /not in the world/.test(res.message),
			J(res),
		);
		res = host.setRain(true);
		verify(
			"rain (the lobby does not matter to the clock): ok, and the server's clock rains",
			res.ok && t.s.sim.clock.isRaining === true,
			J(res),
		);
		t.s.enter(t.admin);

		// the clock slider: paced, the last value always sent, a refusal toasted (never a success)
		const clockReqs = () => sent.filter(r => r.kind === "world" && r.op === "clock").length;
		const before = clockReqs();
		host.setClock(10);
		host.setClock(11);
		host.setClock(12);
		for (let i = 0; i < 60; i++) t.s.beat();
		verify(
			"three slider moves inside the pace: at most two requests, the last hour wins",
			clockReqs() - before <= 2 && Math.abs(t.s.sim.clock.dayTime - 12) < 0.05,
			`${clockReqs() - before} requests, clock ${t.s.sim.clock.dayTime.toFixed(2)}`,
		);
		verify("...and nothing was toasted for them (only a refusal would be)", toasts.length === 0, J(toasts));

		// the free camera: the server's interest follows it; a refusal is told, once
		host.setFreeCam(true);
		verify(
			"free camera on: the camera detaches, the body stands still, the server looks where it looks",
			cam.detached === true &&
				loop.admin.frozen === true &&
				t.s.host.replicator.viewCenter(t.s.body(t.admin)).x === cam.x,
		);
		verify("...and the body is NOT made invulnerable by it on this screen", player.godMode === false);
		cam.x += 400;
		clockNow += 1;
		// (the overlays are not drawn outside a run: this fake has no renderer, and the camera's refresh does not care)
		ctx.phase = "lobby";
		host.afterRender(1 / 60);
		ctx.phase = "playing";
		verify(
			"moving it sends the new point (paced)",
			Math.abs(t.s.host.replicator.viewCenter(t.s.body(t.admin)).x - cam.x) < 1e-6,
		);
		host.setFreeCam(false);
		verify(
			"off: the server's interest is back on the body",
			t.s.host.replicator.viewCenter(t.s.body(t.admin)).x === t.s.body(t.admin).state.x,
		);

		verify("the pathfinding overlay is not offered: the field is the server's", host.hasFlowField() === false);

		// offline (no server world): the local tools, exactly as before -- nothing goes to the server
		owned = false;
		const n1 = sent.length;
		res = host.setGod(false);
		verify(
			"offline: the local world's tools, nothing sent",
			res.ok && res.audited !== true && sent.length === n1 && host.serverWorld() === false,
		);
		auth.setWorldAuthority(undefined);
	},
);

// ================================================================ 17-26: the independent review of 8f50bc5

/** reset `p`'s save as an admin, and the client's ack of the patch (what the panel does) */
function resetAndAck(t, p) {
	t.ask(t.admin, { kind: "resetSave", userId: p.UserId });
	const ev = t.EV.sent.filter(e => e.to === p && e.args[0]?.kind === "patch").pop()?.args[0];
	t.ACK.OnServerEvent.Fire(p, ev?.rev);
	t.s.beat();
}

/** walks `who` in circles, a tick at a time, until `pred` holds (or `limit` seconds): the seconds it took, or -1 */
function walkUntil(t, who, pred, limit) {
	let s = 0;
	while (s < limit) {
		if (pred()) return s;
		t.s.walk(who, (s * 0.7) % (Math.PI * 2));
		t.s.beat();
		s += 1 / 60;
	}
	return pred() ? s : -1;
}

/** the flush the admin server runs every AUDIT_FLUSH_INTERVAL (its BindToClose hook), run now */
function flushAuditNow(t) {
	const fn = t.s.env.closers.find(f => String(f).includes("flushAudit"));
	if (fn === undefined) throw new Error("the admin server's audit flush was not found");
	fn();
}

/** every entry of the stored audit log */
function storedAudit(t) {
	let out = [];
	for (const [k, v] of t.logStore.data) if (k.startsWith("log_")) out = out.concat(Array.isArray(v) ? v : []);
	return out;
}

section(
	"17) review HIGH-1: a switch turned off from the lobby, or by leaving the server, is off on the BODY, and mints no rounds",
	() => {
		// P1: god on, to the lobby, god off there, back in
		let t = town();
		t.tool(t.admin, { op: "god", on: true });
		t.tool(t.admin, { op: "noclip", on: true });
		t.s.run(1.2);
		t.s.exit(t.admin);
		let res = t.tool(t.admin, { op: "god", on: false });
		t.tool(t.admin, { op: "noclip", on: false });
		verify("god off from the lobby: answered off", res.ok && res.data?.state?.god === false, J(res));
		t.s.run(1.2);
		let sp = t.s.enter(t.admin);
		t.s.beat();
		let a = sp.state;
		verify(
			"P1: back in the world, the resumed BODY is no god and walks into walls again (the kept body shed the switches)",
			a.godMode === false && a.noclip === false,
			`godMode ${a.godMode} noclip ${a.noclip}`,
		);
		const snap = lastSnapOf(t.s, t.admin);
		verify(
			"...and the self block says so (no God, no Noclip in modFlags)",
			snap !== undefined && (snap.self.modFlags & (t.s.P.ModFlag.God | t.s.P.ModFlag.Noclip)) === 0,
			J(snap?.self?.modFlags),
		);
		t.s.sim.combat.damageActor(sp.slot, a, t.s.save(t.admin), 5000, true);
		verify("...a lethal blow lands", a.hp < a.hpMax && (a.dead || a.hp <= 0), `hp ${a.hp} dead ${a.dead}`);

		// the other way: a switch still ON is put back on the body that comes back
		t = town();
		t.tool(t.admin, { op: "god", on: true });
		t.s.run(1.2);
		t.s.exit(t.admin);
		t.s.run(1.2);
		sp = t.s.enter(t.admin);
		t.s.beat();
		verify(
			"a switch left ON through the lobby: the body that comes back is a god again",
			sp.state.godMode === true,
		);

		// P2: the admin leaves the server and comes back within the 5 min the keeper holds the body
		t = town();
		t.tool(t.admin, { op: "god", on: true });
		t.tool(t.admin, { op: "noclip", on: true });
		t.s.run(1.2);
		t.s.quit(t.admin);
		t.s.run(3);
		const back = t.s.join(t.admin.UserId, "Owner");
		back.LocaleId = "en-us";
		t.s.run(1.5);
		sp = t.s.enter(back);
		t.s.beat();
		res = t.ask(back, { kind: "world", op: "state" });
		verify(
			"P2: rejoined within 5 min: the server says off AND the kept body is no god and no noclip",
			sp !== undefined &&
				res.data?.state?.god === false &&
				sp.state.godMode === false &&
				sp.state.noclip === false,
			`state ${J(res.data?.state)} godMode ${sp?.state.godMode} noclip ${sp?.state.noclip}`,
		);

		// P5: infinite ammo on, to the lobby, off there, back in, another switch: no free magazine is ever banked
		t = town();
		armPistol(t.s.save(t.admin), 0);
		t.s.run(1.2);
		t.s.exit(t.admin);
		t.s.run(1.2);
		t.s.enter(t.admin);
		const save = t.s.save(t.admin);
		const r0 = save.ammoNormal;
		const m0 = t.s.body(t.admin).state.weapon.ammoCount;
		t.tool(t.admin, { op: "ammo", on: true });
		t.s.beat();
		const full = t.s.body(t.admin).state.weapon.ammoCount;
		t.s.run(1.2);
		t.s.exit(t.admin);
		t.tool(t.admin, { op: "ammo", on: false });
		t.s.run(1.2);
		t.s.enter(t.admin);
		t.s.beat();
		a = t.s.body(t.admin).state;
		const cameBack = { inf: a.infiniteAmmo, mag: a.weapon.ammoCount };
		t.tool(t.admin, { op: "god", on: true });
		t.s.beat();
		t.s.run(1.2);
		t.s.exit(t.admin);
		t.s.run(0.5);
		t.s.quit(t.admin);
		verify(
			"P5: the free magazine (full on the server) never reaches the reserve: not through the lobby, a switch or leaving",
			full > 0 && cameBack.inf === false && cameBack.mag === 0 && save.ammoNormal <= r0 + m0,
			`free magazine ${full}; back in: infinite ${cameBack.inf} magazine ${cameBack.mag}; reserve ${r0}+${m0} -> ${save.ammoNormal}`,
		);

		// any switch that finds an infinite magazine it does not hold empties it (whatever was toggled)
		t = town();
		a = t.s.body(t.admin).state;
		a.infiniteAmmo = true;
		a.weapon.ammoCount = 10;
		t.tool(t.admin, { op: "god", on: true });
		verify(
			"a stale infinite magazine on the body: toggling GOD empties it, and the flag goes",
			a.infiniteAmmo === false && a.weapon.ammoCount === 0,
			`infinite ${a.infiniteAmmo} magazine ${a.weapon.ammoCount}`,
		);
	},
);

section("18) review MEDIUM-2: a switch or the free camera left on across a NEW run keeps that run assisted", () => {
	let t = town();
	t.tool(t.admin, { op: "god", on: true });
	verify("god on: the admin's run is assisted", !t.pays(t.admin));
	resetAndAck(t, t.admin);
	t.s.beat();
	const b = t.s.body(t.admin).state;
	verify(
		"P3: the admin's own save reset (a new run) with god still on: the new body is a god, and the new run does NOT pay",
		b.godMode === true && t.pays(t.admin) === false,
		`godMode ${b.godMode} pays ${t.pays(t.admin)}`,
	);
	t = town();
	const a = t.s.body(t.admin).state;
	t.tool(t.admin, { op: "freecam", on: true, x: a.x + 400, y: a.y });
	resetAndAck(t, t.admin);
	t.s.beat();
	verify("the same with the free camera on", t.pays(t.admin) === false);
	t.tool(t.admin, { op: "freecam", on: false, x: 0, y: 0 });
	resetAndAck(t, t.admin);
	t.s.beat();
	verify("...and a new run with everything off pays again", t.pays(t.admin) === true);
});

section("19) review MEDIUM-3: Dawn stands the dead up, it never makes them wait longer", () => {
	let t = town();
	t.s.sim.clock.setClock(23);
	t.s.immortal.delete(t.bob);
	t.s.kill(t.bob);
	const w0 = t.s.host.lives.daybreakIn(t.bob.UserId);
	const res = t.tool(t.admin, { op: "dawn" });
	const w1 = t.s.host.lives.daybreakIn(t.bob.UserId);
	verify(
		"P4: dead at 23:00, then Dawn (06:59): the wait is over at once, not a whole day longer",
		res.ok && w0 > 0 && w1 === 0,
		`before ${w0?.toFixed(1)} s, after ${w1?.toFixed(1)} s`,
	);
	t.s.run(0.5);
	verify("...and the daybreak stands Bob up", t.s.body(t.bob).state.dead === false);
	t = town();
	t.s.sim.clock.setClock(2);
	t.s.immortal.delete(t.bob);
	t.s.kill(t.bob);
	t.tool(t.admin, { op: "clock", hour: 6.5 });
	verify(
		"the clock slider into 06:00-07:00 is a daybreak too",
		t.s.host.lives.daybreakIn(t.bob.UserId) === 0,
		`${t.s.host.lives.daybreakIn(t.bob.UserId)}`,
	);
});

section(
	"20) review MEDIUM-4: flooders cannot push an admin's action out of the log, nor break an admin's merge",
	() => {
		// P9: one admin kick, then 320 different flooders
		let t = town();
		const carl = t.s.join(newUser(), "Carl");
		carl.LocaleId = "en-us";
		const kr = t.ask(t.admin, { kind: "kick", userId: carl.UserId, reason: "" });
		verify("the admin kicks Carl", kr.ok === true, J(kr));
		for (let i = 0; i < 320; i++) {
			const u = t.s.join(newUser(), `flooder${i}`);
			u.LocaleId = "en-us";
			for (let k = 0; k < 12; k++) t.RF.OnServerInvoke(u, { kind: "players" });
			t.s.quit(u);
		}
		const mem = t.audit();
		verify(
			"P9: after 320 auto-kicks the admin's kick is still in the panel's log",
			mem.some(e => e.action === "kick") && mem.some(e => e.action === "auto:flood"),
			`${mem.length} entries, ${mem.filter(e => e.action === "auto:flood").length} auto-kick`,
		);
		t.s.shutdown();
		const stored = storedAudit(t);
		verify(
			"...and in the stored log (an automatic kick is trimmed before any admin action)",
			stored.some(e => e.action === "kick"),
			`${stored.length} stored, ${stored.filter(e => e.action === "auto:flood").length} auto-kick`,
		);
		verify(
			"...where each auto-kick names the flooder as its target, never as its admin",
			stored.filter(e => e.action === "auto:flood").every(e => e.adminId === 0 && e.targetId > 0),
		);

		// a non-admin's refused call between two identical admin lines does not break their merge
		t = town();
		const at = freeNear(t.s, t.spA, 80, 12);
		const drop = { op: "spawnItem", group: "use", index: 0, count: 1, x: at.x, y: at.y };
		t.tool(t.admin, drop);
		const eve = t.s.join(newUser(), "Eve");
		eve.LocaleId = "en-us";
		t.RF.OnServerInvoke(eve, { kind: "players" });
		t.tool(t.admin, drop);
		const lines = t.audit().filter(e => e.action === "world:spawnItem");
		verify(
			"the same drop twice with a stranger's DENIED between them: one line ×2",
			lines.length === 1 && /\(×2\)/.test(lines[0].details),
			J(lines.map(e => e.details)),
		);
	},
);

section("21) review L1: a clock tool marks the runs waiting in the lobby too", () => {
	const t = town();
	const c = t.s.sim.clock;
	const sv = t.s.save(t.bob);
	c.setClock(23.97);
	const d0 = c.day;
	walkUntil(t, t.bob, () => c.day > d0, 30);
	t.s.run(1.2);
	t.s.exit(t.bob);
	const res = t.tool(t.admin, { op: "clock", hour: 23.7 });
	verify(
		"P10: the clock rewound across midnight with Bob in the lobby: Bob's kept run is assisted",
		res.ok &&
			t.s.sim.paysRewards({ userId: t.bob.UserId }) === false &&
			/2 runs now assisted/.test(t.audit()[0]?.details),
		`pays(bob) ${t.s.sim.paysRewards({ userId: t.bob.UserId })}; ${t.audit()[0]?.details}`,
	);
	t.s.run(1.2);
	t.s.enter(t.bob);
	const d1 = c.day;
	const money1 = sv.money;
	walkUntil(t, t.bob, () => c.day > d1, 30);
	verify(
		"...so the midnight he crosses again pays him no coins",
		c.day > d1 && sv.money === money1,
		`${money1} -> ${sv.money}`,
	);
});

section(
	"22) review L2: an admin's drop pays its taker nothing but the item, is logged, and is never a cosmetic",
	() => {
		const t = town();
		const { ETC_ITEMS } = require(join(SRC, "shared/data/etcItems.ts"));
		const { EQUIPS } = require(join(SRC, "shared/data/equips.ts"));
		const WOOD = ETC_ITEMS.findIndex(e => e.name === "Wood");
		const WOODS = require(join(SRC, "shared/data/achievements.ts")).AchievementId.WoodsCollector;
		const b = t.s.body(t.bob);
		const bsave = t.s.save(t.bob);
		const at = freeNear(t.s, b, 20, 12);
		let res = t.tool(t.admin, { op: "spawnItem", group: "etc", index: WOOD, count: 5, x: at.x, y: at.y });
		const wood = t.s.sim.world.items.find(it => it.kind === 4 && it.itemId === WOOD && it.count === 5);
		verify(
			"5 wood dropped by the admin, next to Bob, tagged as an admin's",
			res.ok && wood?.unpaid === true,
			J(wood),
		);
		const ach0 = bsave.achievements[WOODS] ?? 0;
		const inv0 = bsave.invenEtc[WOOD] ?? 0;
		const got = t.s.sim.items.pickup(bsave, wood.x, wood.y, wood, b.slot);
		verify(
			"Bob picks it up: the wood is his, the Woods collector credit is not",
			got.ok && (bsave.invenEtc[WOOD] ?? 0) === inv0 + 5 && (bsave.achievements[WOODS] ?? 0) === ach0,
			`inventory ${inv0}->${bsave.invenEtc[WOOD]} achievement ${ach0}->${bsave.achievements[WOODS]}`,
		);
		const taken = t.audit().find(e => e.action === "world:taken");
		verify(
			"...and the log says who took it (the server's line, Bob as its target)",
			taken !== undefined && taken.target.includes(String(t.bob.UserId)) && taken.admin === "server",
			J(taken),
		);
		const { spawnGroundItem } = require(join(SRC, "shared/game/world.ts"));
		const found = spawnGroundItem(t.s.sim.world, 4, WOOD, 3, at.x, at.y);
		t.s.sim.items.pickup(bsave, found.x, found.y, found, b.slot);
		verify(
			"a wood the town dropped still credits the collector (control)",
			(bsave.achievements[WOODS] ?? 0) === ach0 + 3,
			`${ach0} -> ${bsave.achievements[WOODS]}`,
		);
		const cosmetic = EQUIPS.findIndex(e => e.kind >= 4);
		const n0 = t.s.sim.world.items.length;
		res = t.tool(t.admin, { op: "spawnItem", group: "equip", index: cosmetic, count: 1, x: at.x, y: at.y });
		verify(
			`an outfit or a pet (EQUIPS ${cosmetic}): refused, nothing on the ground`,
			cosmetic >= 0 && !res.ok && /shop/.test(res.error) && t.s.sim.world.items.length === n0,
			res.error,
		);
	},
);

section("23) review L3: an audit line keeps what it says, and a stored line is never rewritten", () => {
	const t = town();
	const at = freeNear(t.s, t.spA, 80, 12);
	const drop = { op: "spawnItem", group: "use", index: 0, count: 1, x: at.x, y: at.y };
	const lines = () => t.audit().filter(e => e.action === "world:spawnItem");
	t.tool(t.admin, drop);
	t.tool(t.admin, { ...drop, x: at.x + 30 });
	verify(
		"two drops at different points: two lines, each with its own point",
		lines().length === 2 && lines()[0].details !== lines()[1].details,
		J(lines().map(e => e.details)),
	);
	t.tool(t.admin, { ...drop, x: at.x + 30 });
	verify(
		"the same drop again: one line ×2",
		lines().length === 2 && /\(×2\)/.test(lines()[0].details),
		J(lines().map(e => e.details)),
	);
	flushAuditNow(t);
	t.tool(t.admin, { ...drop, x: at.x + 30 });
	const stored = storedAudit(t).filter(e => e.action === "world:spawnItem");
	verify(
		"the line written to the DataStore is never merged into again: the next repeat is a new line",
		lines().length === 3 && !/\(×3\)/.test(lines()[1].details) && stored.some(e => /\(×2\)/.test(e.details)),
		`memory ${J(lines().map(e => e.details))} stored ${J(stored.map(e => e.details))}`,
	);
});

section(
	"24) review L4: noclip stays inside the town, and ending it deep inside a building always frees the body",
	() => {
		const t = town();
		const { TOWN } = require(join(SRC, "shared/engine/constants.ts"));
		t.tool(t.admin, { op: "noclip", on: true });
		const sp = t.s.body(t.admin);
		sp.state.x = TOWN.BORDER + 30;
		for (let i = 0; i < 60 * 6; i++) {
			t.s.walk(t.admin, Math.PI);
			t.s.beat();
		}
		const x = t.s.body(t.admin).state.x;
		verify(
			"P11: walking west with noclip for 6 s: held at the town's edge, out of the border forest",
			x >= TOWN.BORDER + PLAYER_RADIUS - 1e-6,
			`x ${x.toFixed(0)} border ${TOWN.BORDER}`,
		);
		// no free ground within UNSTICK_SEARCH (a very big building): the body goes to a spawn point, never stays stuck
		const wall = insideBuilding(t.s.sim.world);
		const a = t.s.body(t.admin).state;
		a.x = wall.x;
		a.y = wall.y;
		const real = WO.freePointIn;
		WO.freePointIn = () => undefined;
		let res;
		try {
			res = t.tool(t.admin, { op: "noclip", on: false });
		} finally {
			WO.freePointIn = real;
		}
		verify(
			"noclip off with no free ground in reach: moved to a spawn point, standing free, and the answer says so",
			res.ok &&
				a.noclip === false &&
				circleBlocked(t.s.sim.world, a.x, a.y, PLAYER_RADIUS) === undefined &&
				/free ground/.test(res.message),
			`${res.message} at ${Math.round(a.x)},${Math.round(a.y)}`,
		);
	},
);

section("25) review L5: an admin's bosses do not keep the town's asleep, and each side keeps its own cap", () => {
	const t = town();
	const h = t.s.sim.horde;
	const a = t.s.body(t.admin).state;
	const bat = freeNear(t.s, t.spA, 500, 60);
	let res = t.tool(t.admin, { op: "spawn", spawn: "boss3", count: 2, x: bat.x, y: bat.y, chase: false });
	verify(
		"two admin bosses",
		res.ok && h.bossRoster.list.filter(b => b.unpaid).length === 2,
		res.message ?? res.error,
	);
	// an anchor due, next to the admin: the town's own boss wakes (population.ts spawnBoss)
	const anchor = t.s.sim.world.bossAnchors[0];
	anchor.x = a.x + 200;
	anchor.y = a.y;
	anchor.nextDay = 0;
	h.population.population.spawnBoss(h.refs);
	const natural = h.bossRoster.list.filter(b => b.unpaid !== true).length;
	verify("P-L5: the town's boss still wakes beside two admin bosses", natural === 1, `${natural} natural`);
	res = t.tool(t.admin, { op: "spawn", spawn: "boss2", count: 1, x: bat.x, y: bat.y, chase: false });
	verify("...and a third admin boss is still refused", !res.ok && /admin bosses/.test(res.error), res.error);
	const snap = lastSnapOf(t.s, t.admin);
	verify(
		`three bosses near the admin: the snapshot carries the nearest ${CFG.MAX_BOSSES} (and decodes)`,
		snap !== undefined && snap.bosses.length === CFG.MAX_BOSSES,
		`${snap?.bosses.length}`,
	);
});

section(
	"26) review L6: a forced wave 2 or 3 is as big as the natural one; an admin can take a construction down",
	() => {
		const t = town();
		const h = t.s.sim.horde;
		const c = t.s.sim.clock;
		// two survivors apart: more than one survivor in the groups, ΣS(k) > 1
		const b = t.s.body(t.bob).state;
		const far = WO.freePointIn(t.s.sim.world, t.s.sim.world.width - b.x, t.s.sim.world.height - b.y, 30, 2000);
		b.x = far.x;
		b.y = far.y;
		for (let i = 0; i < 30; i++) t.s.beat();
		const total = h.population.scales().reduce((s, k) => s + k, 0);
		const { getDayPopulation } = require(join(SRC, "shared/data/spawns.ts"));
		t.tool(t.admin, { op: "clock", hour: 20 });
		c.waveQueues[1] = 0;
		c.specialWaveQueues[1] = 0;
		let res = t.tool(t.admin, { op: "wave" });
		const pop = getDayPopulation(c.day);
		verify(
			"P-L6: ΣS(k) > 1: the forced wave 2 queues the day table × ΣS(k), like a natural night",
			res.ok &&
				total > 1 &&
				c.waveQueues[1] === Math.floor(pop.wave2 * total + 0.5) &&
				c.waveQueues[1] > pop.wave2,
			`ΣS ${total} queue ${c.waveQueues[1]} table ${pop.wave2}`,
		);

		// remove structure: an admin's barricade, then a survivor's, then nothing
		const World = t.s.env.services.ReplicatedStorage.FindFirstChild("Net").FindFirstChild("World");
		const spot = freeNear(t.s, t.spA, 260, 90);
		t.tool(t.admin, { op: "spawnStructure", structure: "barricade", x: spot.x, y: spot.y });
		const wall = t.s.sim.world.solids.find(s => s.placeable === 10 && Math.abs(s.x + s.w / 2 - spot.x) < 1);
		const count0 = t.s.sim.build.count();
		World.sent.length = 0;
		res = t.tool(t.admin, { op: "removeStructure", x: spot.x + 10, y: spot.y });
		flushWorld(t);
		const removes = [];
		for (const e of World.sent) {
			if (e.to !== undefined) continue;
			for (const ev of t.s.P.decodeWorld(e.args[0])?.events ?? [])
				if (ev.t === t.s.P.WorldEv.SolidRemove) removes.push(ev);
		}
		verify(
			"remove at the admin's own barricade: gone from the server's world, the cap counts it back, every client told",
			res.ok &&
				wall !== undefined &&
				!t.s.sim.world.solids.includes(wall) &&
				t.s.sim.build.count() === count0 - 1 &&
				removes.some(ev => ev.id === wall.id),
			`${res.message ?? res.error} count ${count0}->${t.s.sim.build.count()} removes ${removes.length}`,
		);
		const { addSolid } = require(join(SRC, "shared/game/world.ts"));
		const { PLACEABLES, placedSolid } = require(join(SRC, "shared/sim/placement.ts"));
		const def = PLACEABLES[10];
		const bobs = addSolid(t.s.sim.world, {
			...placedSolid(def, { x: spot.x - def.w / 2, y: spot.y - def.h / 2, w: def.w, h: def.h }, 0),
			placeable: 10,
			owner: t.s.body(t.bob).slot,
		});
		res = t.tool(t.admin, { op: "removeStructure", x: spot.x, y: spot.y });
		verify(
			"...and a survivor's construction too",
			res.ok && !t.s.sim.world.solids.includes(bobs),
			res.message ?? res.error,
		);
		const n = t.s.sim.world.solids.length;
		res = t.tool(t.admin, { op: "removeStructure", x: spot.x, y: spot.y });
		verify(
			"nothing built there: refused, nothing removed",
			!res.ok && /no construction/.test(res.error) && t.s.sim.world.solids.length === n,
			res.error,
		);
		const house = t.s.sim.world.solids.find(s => s.kind === "building");
		res = t.tool(t.admin, { op: "removeStructure", x: house.x + house.w / 2, y: house.y + house.h / 2 });
		verify(
			"the town's own building is never a construction",
			!res.ok && t.s.sim.world.solids.includes(house),
			res.error,
		);
		verify(
			"one audit line per removal",
			t.audit().filter(e => e.action === "world:removeStructure").length === 4,
			J(
				t
					.audit()
					.filter(e => e.action === "world:removeStructure")
					.map(e => `${e.ok}:${e.details}`),
			),
		);
		res = t.tool(t.bob, { op: "removeStructure", x: spot.x, y: spot.y });
		verify("a non-admin: forbidden", !res.ok && res.error === "forbidden", J(res));
	},
);

// ================================================================

console.log("");
if (failures > 0) {
	console.log(`${failures} of ${checks} check(s) failed`);
	process.exit(1);
}
console.log(`all ${checks} checks passed`);
