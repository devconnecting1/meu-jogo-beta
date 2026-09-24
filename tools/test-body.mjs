#!/usr/bin/env node
/*
 * The body is the server's (docs/MULTIPLAYER.md §6.1, §7.1–§7.3; DESIGN_RULES MP-21 as the owner rewrote it on
 * 23 Sep 2026; server/sim/life.ts).
 *
 *   npm run test:body                  # everything (exit code 1 on any failure)
 *   node tools/test-body.mjs --verbose # with the server's own print/warn lines
 *   PZ_SRC=path/to/src node tools/test-body.mjs
 *
 * The security review of Sep 2026 found that being in the world was the only thing that made a survivor's body
 * the server's. A dead survivor sent `Intent LeaveWorld` + `Intent EnterWorld` (or reconnected) and came back
 * alive, healed, fed, with a free magazine, at a safe spawn point; alive, the same trick was a teleport, a heal
 * and a reload. `newRun` stood a LIVING survivor up somewhere safe for free, a SaveRequest could say
 * `runOver: false`, and nothing ever wrote `runOver`, `runHp` or `runHunger`.
 *
 * Nothing in this file is a transcription. It boots the REAL server — server/main.server.ts, which starts
 * server/net/mpHost.ts, the admin server and the proximity chat — on a fake Roblox (Players, RunService's
 * Heartbeat, remotes, an in-memory DataStore that outlives a server "process"), and talks to it only the way a
 * client can: PlayerAdded / PlayerRemoving, the Intent, Input and SaveRequest remotes, and the ShopAction
 * RemoteFunction. What it asserts is what a client would see and what the DataStore would keep.
 *
 *   1. LEAVE / ENTER        a dead body comes back dead where it fell; a living one comes back with the hp,
 *                           hunger, position and magazine it left with — no heal, no teleport, no reload.
 *   2. RECONNECT            the same through PlayerRemoving + PlayerAdded (the 5 min memory of §7.2), after it
 *                           (the body rebuilt from runHp/runHunger/runOver), across a server hop, and on a new
 *                           server with a death carried in the save.
 *   3. THE MAGAZINE         a fresh body's magazine is paid out of the reserve; leaving the server pays it back.
 *   4. THE REPORT           a SaveRequest saying `runOver: false` does not revive anybody.
 *   5. THE WAYS BACK UP     a living survivor gets neither Rebirth nor New game; a dead one pays for a Rebirth on
 *                           a PUBLIC server too; without coins the server stands them up at daybreak on public AND
 *                           private servers; New game starts a new life that still waits for daybreak.
 *   6. THE WORLD WIPE       nobody alive and nobody paying inside 30 s (or everybody declining) fires the one
 *                           hook, once; a Rebirth inside the window keeps the world going.
 *   7. THE DEAD STAY PUT    moving commands from a dead survivor, through the Input remote, move nothing.
 *   8. SHUTDOWN             BindToClose banks every body into the save before it is written.
 *  10. THE WARDROBE         MON-04's purchase through the real ShopAction: unknown ids, too few coins and a costume
 *                           already owned are refused; a request naming its own price pays the catalogue's; what
 *                           was bought can be worn, what was not is taken off; the DataStore gets both.
 *  11. THE XP PUSH          the XP the server credits reaches the client in a pushed wallet (level and XP).
 *  12. THE TITLES           MON-05 through the real server: a title nobody earned cannot be shown (ShopAction nor
 *                           report), a report cannot grant one or count a kill, the server's own killing blow makes a
 *                           Horde Breaker and tells that player alone, and the title record brings back what a server
 *                           rolled back to v4 wrote the save without -- forgetting only which title was shown.
 *  13. THE RECORD'S COST    one attempt to read the title record, one to write it: a failing store never stalls the
 *                           LoadAck or a leave.
 *  14. RESET AND WIPE       the title record never undoes an admin reset (even when this session could not read it,
 *                           or its write failed) nor a save key deleted on purpose.
 *  15. RECORD UNDER LOCK    leaving writes the title record BEFORE the save write that releases the session lock.
 *  16. RECORD BUDGET       no record write for a survivor who earned nothing; a title store that failed to open
 *                           is asked again a minute later instead of never.
 *  17. ADMIN DAY EDIT      an admin who sets a life's day has assisted the run (no coins, no titles) and counted
 *                           no night toward Week One.
 *  18. LOCK LOST UNAWARE    a server that lost the lock without knowing it (another took it, an admin reset the
 *                           player there) leaves without writing its old titles over the reset's record.
 *  19. RECORD OUT OF THE WAY a low request budget, a slow or failing title store, or BindToClose: the leave writes
 *                           its save alone (the record never stands in front of the lock's release), and the next
 *                           session writes the record from the save.
 *  20–25. A THROW ON THE WAY OUT (F5, F6)  a step that throws -- banking the body, the last report, the encode, the title
 *                           record, stopping the simulation, settling a body, the load itself -- never costs the last
 *                           write, the lock's release or the cleanup after it (session, `releasing` mark, BindToClose's
 *                           count, the autosave loop), and the log gets the error WITH its traceback. Threads here run as
 *                           Roblox runs them: an error kills its own thread only.
 *  26–28. THE F5 REVIEW     a read-only session (a load that threw after taking the lock, a save that is not JSON) and
 *                           a save too large to write hand their lock back on the way out; a Rebirth whose stand-up
 *                           throws is not sold (refunded, then paid once) unless the body stood; a New game whose new
 *                           life throws keeps the death in the save; one body that cannot be banked at shutdown leaves
 *                           the others banked.
 *  30. EVERY REMOTE COUNTS   (audit M2, L4) SaveRequest, LoadRequest, ShopAction and the admin remotes count toward the
 *                           §8.2 flood kick, in the world and out of it; 30 s of an honest client is never kicked; a
 *                           storm of rejected reports is answered once a second; every automatic kick is in the stored
 *                           admin audit log by UserId.
 *  31. THE LOBBY'S PING      (S3 NIT 3) the filtered ping the rewind ceiling uses survives five minutes in the lobby
 *                           (a throttled re-entry is filtered, not taken raw), and goes when life.ts lets the body go.
 *  32. SAV-01               saving is automatic: a minute of progress reports writes nothing (only the autosave carries
 *                           them); ten levels in five seconds are one write in the burst and one a gap (15 s) later; a
 *                           purchase and a death are written within the delay; a leave never waits for the gap; an
 *                           unchanged save is not rewritten (only the lock refresh); an event save waits under the budget
 *                           floor and is not dropped; an outage costs one UpdateAsync per write, backing off 15, 30, 60 s,
 *                           is announced once ("failing") and taken back ("saved") when a write lands or the save is back
 *                           to what landed; the leave still retries in place; a save that cannot be encoded or is too
 *                           large backs off too; a notice that cannot be sent never costs a write; a refresh is silent;
 *                           a lost lock is announced ("stopped") and never written over (the review of a454292).
 *  33. THE FIRST FRAME       (the owner's report of 2026-09-24: "entering the world, the player spawns in one place, and
 *                           a few ms later appears in another") the client pieces netClient.ts runs, on the packets the
 *                           real server sent: nothing is drawn until the first self block, then the first 30 frames are
 *                           all at the server's spot, the survivor and the camera -- a fresh body, a kept one, a corpse;
 *                           and a daybreak stand-up cuts the camera instead of panning it (client/net/entryHold.ts).
 *  34. NOBODY IS THE HOST    the first player (slot 0, a private server's owner) leaving, dying and going Home, or being
 *                           replaced by a newcomer in the same slot: the tick, the clock, the town, the snapshots, the
 *                           horde and the night's wave around the others, the roster and the scoreboard all go on.
 *
 * Pure Node (>= 18) + the project's TypeScript, through tools/luau-shim.mjs, plus the small fake Roblox below.
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

// ================================================================ 1: leave / enter

section("1) LeaveWorld + EnterWorld revive nobody, heal nobody, move nobody, reload nothing", () => {
	const s = bootServer();
	const a = s.join(newUser(), "fallen");
	const b = s.join(newUser(), "witness");
	s.immortal.add(b);
	s.enter(b);
	const spA = s.enter(a);
	check(spA !== undefined && !spA.state.dead, "a survivor enters the world alive");
	s.kill(a);
	const where = { x: spA.state.x, y: spA.state.y };
	check(s.body(a)?.state.dead === true, "…and dies through the server's own damage path");
	s.exit(a);
	s.clearWorldLog();
	const back = s.enter(a);
	check(back !== undefined, "the dead survivor can walk back into the world (to wait, or to pay)");
	check(back?.state.dead === true, "…but comes back DEAD", `dead ${back?.state.dead}, hp ${f1(back?.state.hp)}`);
	check(back !== undefined && back.state.hp <= 0, "…with no hp");
	check(
		back !== undefined && near(back.state.x, where.x, 1) && near(back.state.y, where.y, 1),
		"…lying where it fell, not at a safe spawn point",
		back !== undefined ? `${f1(back.state.x)},${f1(back.state.y)} vs ${f1(where.x)},${f1(where.y)}` : "no body",
	);
	check(
		s.lifeEventsOf(a).includes(s.P.LifeState.Dead),
		"…and the client is TOLD it is dead on the way in (a directed PlayerLife after its PlayerJoined)",
		`PlayerLife ${JSON.stringify(s.lifeEventsOf(a))}`,
	);

	// alive: the same trick must not be a heal, a teleport or a reload
	const c = s.join(newUser(), "hurt");
	armPistol(s.save(c), 30);
	const spC = s.enter(c);
	s.immortal.add(c);
	spC.state.hp = 37;
	spC.state.hungry = 41;
	spC.state.weapon.ammoCount = 3;
	s.beat();
	const before = {
		x: spC.state.x,
		y: spC.state.y,
		hp: spC.state.hp,
		hungry: spC.state.hungry,
		mag: spC.state.weapon.ammoCount,
		reserve: spC.save.ammoNormal,
	};
	s.exit(c);
	const again = s.enter(c);
	const now = again.state;
	check(
		now.hp < before.hp + 1 && now.hp < now.hpMax,
		"Leave/Enter is not a heal",
		`hp ${f1(before.hp)} → ${f1(now.hp)} of ${now.hpMax}`,
	);
	check(now.hungry <= before.hungry + 0.01, "…nor a meal", `hunger ${f1(before.hungry)} → ${f1(now.hungry)}`);
	check(
		near(now.x, before.x, 1) && near(now.y, before.y, 1),
		"…nor a teleport: back exactly where it left",
		`${f1(before.x)},${f1(before.y)} → ${f1(now.x)},${f1(now.y)}`,
	);
	check(now.weapon.ammoCount === before.mag, "…nor a reload", `magazine ${before.mag} → ${now.weapon.ammoCount}`);
	check(
		again.save.ammoNormal === before.reserve,
		"…and the reserve did not move either",
		`${before.reserve} → ${again.save.ammoNormal}`,
	);
	check(!s.sim.spawnShielded(again), "…and a resumed body gets no spawn shield to hide behind");
});

// ================================================================ 2: reconnect

section(
	"2) a reconnect is not a revive or a heal either (§7.2: the body is kept 5 min, then rebuilt from the save)",
	() => {
		const s = bootServer();
		const witness = s.join(newUser(), "witness");
		s.immortal.add(witness);
		s.enter(witness);

		const idA = newUser();
		let a = s.join(idA, "dead");
		s.enter(a);
		s.kill(a);
		s.quit(a);
		const doc = s.stored(idA);
		check(
			doc?.runOver === true,
			"dying wrote runOver = true, and disconnecting kept it in the DataStore",
			`runOver ${doc?.runOver}`,
		);
		a = s.join(idA, "dead");
		const back = s.enter(a);
		check(
			back?.state.dead === true,
			"reconnecting within 5 min and entering: still dead",
			`dead ${back?.state.dead}`,
		);
		s.exit(a);
		s.quit(a);
		s.run(301, 0.5);
		a = s.join(idA, "dead");
		const later = s.enter(a);
		check(
			later?.state.dead === true,
			"…and after the 5 min memory is gone, the save alone still says dead",
			`dead ${later?.state.dead}`,
		);

		// alive and hurt: the save carries the body when the memory is gone
		const idB = newUser();
		let b = s.join(idB, "hurt");
		armPistol(s.save(b), 30);
		let spB = s.enter(b);
		s.immortal.add(b);
		spB.state.hp = 43.8;
		spB.state.hungry = 50.2;
		spB.state.weapon.ammoCount = 7;
		const reserveIn = spB.save.ammoNormal;
		const kept = { x: spB.state.x, y: spB.state.y };
		// Roblox fires the two PlayerRemoving handlers (main.server.ts, mpHost.ts) in no guaranteed order: mpHost's first
		s.quit(b, true);
		const docB = s.stored(idB);
		check(
			docB?.runHp === 43,
			"disconnecting wrote runHp (floored: rounding never favours the player)",
			`runHp ${docB?.runHp}`,
		);
		check(
			docB !== undefined && docB.runHunger === Math.ceil(100 - 50.2),
			"…and runHunger (what was eaten away, ceiled)",
			`runHunger ${docB?.runHunger}`,
		);
		check(
			docB?.ammoNormal === reserveIn + 7,
			"…and the magazine went back into the reserve (§6.1)",
			`reserve ${reserveIn} + 7 in the magazine → ${docB?.ammoNormal}`,
		);
		b = s.join(idB, "hurt");
		s.immortal.add(b);
		spB = s.enter(b);
		check(
			spB !== undefined && spB.state.hp < 45,
			"reconnecting within 5 min: the kept body, not a full one",
			`hp ${f1(spB?.state.hp)}`,
		);
		check(
			spB !== undefined && near(spB.state.x, kept.x, 1) && near(spB.state.y, kept.y, 1),
			"…standing where it left",
		);
		check(
			spB !== undefined &&
				spB.state.weapon.ammoCount === 10 &&
				spB.state.weapon.ammoCount + spB.save.ammoNormal === reserveIn + 7,
			"…with the magazine loaded again FROM the reserve: not one round more than it left with",
			`magazine ${spB?.state.weapon.ammoCount} + reserve ${spB?.save.ammoNormal} = ${reserveIn} + 7`,
		);
		spB.state.hp = 31.2;
		spB.state.hungry = 62.4;
		s.quit(b);
		const docB2 = s.stored(idB);
		s.run(301, 0.5);
		b = s.join(idB, "hurt");
		spB = s.enter(b);
		// the enter itself runs 0.6 s of simulation, and a fed body regenerates 1.2 hp/s (shared/sim/playerMove.ts)
		check(
			spB !== undefined && docB2?.runHp === 31 && spB.state.hp >= 31 && spB.state.hp < 32.5,
			"after the 5 min: the body is rebuilt from runHp, not handed out full",
			`runHp ${docB2?.runHp} → hp ${f1(spB?.state.hp)} of ${spB?.state.hpMax}`,
		);
		check(
			spB !== undefined && docB2?.runHunger === 38 && spB.state.hungry <= 62 && spB.state.hungry > 61,
			"…and from runHunger",
			`runHunger ${docB2?.runHunger} → hunger ${f1(spB?.state.hungry)}`,
		);

		// a server hop: the save moved elsewhere while this server still kept the body
		const idC = newUser();
		let c = s.join(idC, "hopper");
		s.enter(c);
		s.quit(c);
		s.storeDoc(idC, d => {
			d.runHp = 12; // another server hurt them meanwhile
		});
		c = s.join(idC, "hopper");
		const hop = s.enter(c);
		check(
			hop !== undefined && hop.state.hp >= 12 && hop.state.hp < 13.5,
			"a server hop inside the 5 min: the newer save wins over the body kept here (no heal by hopping back)",
			`hp ${f1(hop?.state.hp)}`,
		);

		// a new server process, and a death carried in the save. Made here, on the way out: while the others were tested
		// the daybreak stood this survivor up, and SAV-01's event save wrote that stand-up (a server that never wrote
		// between a join and a leave is what used to leave the old death in the DataStore)
		if (s.body(a) !== undefined && !s.body(a).state.dead) s.kill(a);
		s.quit(a);
		check(s.stored(idA)?.runOver === true, "…a survivor who leaves dead leaves a death in the DataStore");
		const fresh = bootServer();
		const w2 = fresh.join(newUser(), "witness");
		fresh.immortal.add(w2);
		fresh.enter(w2);
		a = fresh.join(idA, "dead");
		const carried = fresh.enter(a);
		check(
			carried?.state.dead === true,
			"another server: a death carried in the save enters DEAD, to wait for this world's daybreak",
		);
	},
);

// ================================================================ 3: the magazine

section("3) the first magazine is paid out of the reserve, never conjured (§7.1)", () => {
	const s = bootServer();
	const a = s.join(newUser(), "full");
	armPistol(s.save(a), 30);
	const spA = s.enter(a);
	check(
		spA.state.weapon.ammoCount === 10 && spA.save.ammoNormal === 20,
		"a pistol (mag 10) with 30 in reserve enters with 10 loaded and 20 left",
		`magazine ${spA.state.weapon.ammoCount}, reserve ${spA.save.ammoNormal}`,
	);
	const b = s.join(newUser(), "short");
	armPistol(s.save(b), 4);
	const spB = s.enter(b);
	check(
		spB.state.weapon.ammoCount === 4 && spB.save.ammoNormal === 0,
		"with 4 in reserve it enters with 4 loaded and none left",
		`magazine ${spB.state.weapon.ammoCount}, reserve ${spB.save.ammoNormal}`,
	);
	const c = s.join(newUser(), "dry");
	armPistol(s.save(c), 0);
	const spC = s.enter(c);
	check(
		spC.state.weapon.ammoCount === 0,
		"with an empty reserve the magazine is empty",
		`magazine ${spC.state.weapon.ammoCount}`,
	);
});

// ================================================================ 4: the report

section("4) a SaveRequest saying `runOver: false` revives nobody (§8.3)", () => {
	const s = bootServer();
	const w = s.join(newUser(), "witness");
	s.immortal.add(w);
	s.enter(w);
	const a = s.join(newUser(), "liar");
	s.enter(a);
	s.kill(a);
	const ack = s.report(a, { runOver: false });
	check(ack?.ok === true, "the report itself is accepted (it is not an attack on its own: the field is pinned)");
	check(s.save(a).runOver === true, "…and runOver stays true", `runOver ${s.save(a).runOver}`);
	s.exit(a);
	const back = s.enter(a);
	check(back?.state.dead === true, "…so Leave/Enter after it still finds the body dead");
});

// ================================================================ 5: the ways back up

for (const privateServer of [false, true]) {
	const kind = privateServer ? "PRIVATE" : "PUBLIC";
	section(
		`5${privateServer ? "b" : "a"}) the ways back up on a ${kind} server: Rebirth for coins, daybreak for free`,
		() => {
			const s = bootServer({ privateServer });
			const w = s.join(newUser(), "witness");
			s.immortal.add(w);
			s.enter(w);

			// alive: neither Rebirth nor New game
			const alive = s.join(newUser(), "alive");
			const spAlive = s.enter(alive);
			s.immortal.add(alive);
			spAlive.state.hp = 20;
			const saveAlive = s.save(alive);
			saveAlive.money = 1000;
			saveAlive.day = 7;
			const pos = { x: spAlive.state.x, y: spAlive.state.y };
			const reb = s.shop(alive, { kind: "rebirth", runRev: saveAlive.runRev });
			check(
				reb.ok === false && reb.reason === "invalid",
				"a LIVING survivor cannot buy a Rebirth",
				JSON.stringify(reb.reason),
			);
			check(saveAlive.money === 1000, "…and pays nothing");
			const nr = s.shop(alive, { kind: "newRun", runRev: saveAlive.runRev });
			check(
				nr.ok === false && nr.reason === "invalid",
				"…nor take a New game (a free heal and teleport)",
				JSON.stringify(nr.reason),
			);
			const still = s.body(alive);
			check(
				saveAlive.day === 7 &&
					still.state.hp < 25 &&
					near(still.state.x, pos.x, 1) &&
					near(still.state.y, pos.y, 1),
				"…the run, the hp and the position are untouched",
				`day ${saveAlive.day}, hp ${f1(still.state.hp)}`,
			);

			// dead with coins: Rebirth right away — on a public server too, since the owner's rule
			const rich = s.join(newUser(), "rich");
			s.enter(rich);
			const saveRich = s.save(rich);
			saveRich.money = 100;
			s.kill(rich);
			const price = require(join(SRC, "shared/data/shop.ts")).rebirthPrice(saveRich.deathCount);
			const paid = s.shop(rich, { kind: "rebirth", runRev: saveRich.runRev });
			check(
				paid.ok === true,
				`a dead survivor with the coins is reborn on a ${kind} server`,
				JSON.stringify(paid.reason ?? "ok"),
			);
			check(
				saveRich.money === 100 - price,
				"…for rebirthPrice(deathCount)",
				`${100 - saveRich.money} of ${price}`,
			);
			const reborn = s.body(rich);
			check(
				reborn !== undefined && !reborn.state.dead && reborn.state.hp === reborn.state.hpMax,
				"…standing, at full health, right now",
			);
			check(saveRich.runOver === false, "…and the save says the run goes on");

			// dead without coins: the server stands them up at daybreak
			const poor = s.join(newUser(), "poor");
			s.enter(poor);
			const savePoor = s.save(poor);
			savePoor.money = 0;
			s.nightLeft(3);
			s.kill(poor);
			const broke = s.shop(poor, { kind: "rebirth", runRev: savePoor.runRev });
			check(
				broke.ok === false && broke.reason === "funds",
				"without the coins the Rebirth is refused",
				JSON.stringify(broke.reason),
			);
			const upIn = s.runUntil(() => s.body(poor)?.state.dead === false, 10);
			check(
				upIn >= 0,
				`…and the ${kind} server stands them up at daybreak, for free`,
				upIn >= 0 ? `after ${upIn.toFixed(2)} s` : "never",
			);
			check(savePoor.runOver === false, "…with the save agreeing");

			// New game: a new LIFE, not a new body
			const quitter = s.join(newUser(), "quitter");
			s.enter(quitter);
			const saveQ = s.save(quitter);
			saveQ.day = 9;
			s.sim.clock.setClock(21);
			s.kill(quitter);
			const reset = s.shop(quitter, { kind: "newRun", runRev: saveQ.runRev });
			check(reset.ok === true, "a dead survivor may start a New game", JSON.stringify(reset.reason ?? "ok"));
			check(saveQ.day === 1, "…the life day goes back to 1 (MP-20)", `day ${saveQ.day}`);
			check(s.body(quitter)?.state.dead === true, "…but the body is still dead: New game is never a free revive");
			check(saveQ.runOver === true, "…and the save still says so (a reconnect reads it)");
			s.exit(quitter);
			check(s.enter(quitter)?.state.dead === true, "…Leave/Enter does not change that either");
			const cheap = require(join(SRC, "shared/data/shop.ts")).rebirthPrice(saveQ.deathCount);
			saveQ.money = cheap;
			const after = s.shop(quitter, { kind: "rebirth", runRev: saveQ.runRev });
			check(
				after.ok === true && s.body(quitter)?.state.dead === false,
				"…a Rebirth (at the new life's price) is the only way up before daybreak",
				`${JSON.stringify(after.reason ?? "ok")}, price ${cheap}`,
			);
		},
	);
}

// ================================================================ 6: the world wipe

section("6) nobody alive and nobody paying: the world is lost, once (the owner's rule 3)", () => {
	const { WIPE_DECISION_S } = require(join(SRC, "server/sim/life.ts"));
	{
		const s = bootServer();
		const wipes = s.wipes();
		const a = s.join(newUser(), "last");
		s.enter(a);
		s.save(a).money = 0;
		s.sim.clock.setClock(20);
		s.kill(a);
		check(s.host.lives.wipeWindowOpen(), "the last survivor falls: the decision window opens");
		s.run(WIPE_DECISION_S - 1);
		check(wipes.length === 0, `…and nothing is decided before ${WIPE_DECISION_S} s`);
		s.run(1.5);
		check(
			wipes.length === 1 && wipes[0].reason === "timeout",
			"…nobody paid: onWorldWiped fires, once",
			JSON.stringify(wipes),
		);
		s.run(5);
		check(wipes.length === 1, "…and not again while they lie there");
		info("the world then ends and a new town begins on day 1 (MP-22): tools/test-reset.mjs");
	}
	{
		const s = bootServer();
		const wipes = s.wipes();
		const a = s.join(newUser(), "payer");
		const b = s.join(newUser(), "waiter");
		s.enter(a);
		s.enter(b);
		s.save(a).money = 100;
		s.sim.clock.setClock(20);
		s.kill(a);
		s.kill(b);
		s.run(10);
		const res = s.shop(a, { kind: "rebirth", runRev: s.save(a).runRev });
		check(res.ok === true, "two down, one pays a Rebirth ten seconds in");
		s.run(WIPE_DECISION_S + 5);
		check(wipes.length === 0, "…so there is somebody alive again and the world goes on", `${wipes.length} wipe(s)`);
	}
	{
		const s = bootServer();
		const wipes = s.wipes();
		const a = s.join(newUser(), "quitter");
		const b = s.join(newUser(), "leaver");
		s.enter(a);
		s.enter(b);
		s.sim.clock.setClock(20);
		s.kill(a);
		s.kill(b);
		s.run(2);
		s.shop(a, { kind: "newRun", runRev: s.save(a).runRev });
		s.beat();
		check(wipes.length === 0, "one of the dead chose New game: the window still waits for the other");
		s.exit(b);
		s.beat();
		check(
			wipes.length === 1 && wipes[0].reason === "declined",
			"…the other went Home: every dead survivor declined, so the world is lost at once, not in 30 s",
			JSON.stringify(wipes),
		);
	}
	{
		const s = bootServer();
		const wipes = s.wipes();
		const a = s.join(newUser(), "standing");
		const b = s.join(newUser(), "fallen");
		s.immortal.add(a);
		s.enter(a);
		s.enter(b);
		s.kill(b);
		s.run(WIPE_DECISION_S + 2);
		check(
			wipes.length === 0 && !s.host.lives.wipeWindowOpen(),
			"with somebody still standing there is no window at all",
		);
	}
});

// ================================================================ 7: the dead stay put

section("7) a dead body does not walk, whatever the client sends (shared/sim/playerMove.ts)", () => {
	const s = bootServer();
	const w = s.join(newUser(), "witness");
	s.immortal.add(w);
	s.enter(w);
	const a = s.join(newUser(), "walker");
	const sp = s.enter(a);
	s.immortal.add(a);
	const x0 = sp.state.x;
	const y0 = sp.state.y;
	let best = 0;
	for (let i = 0; i < 16; i++) {
		// any direction that is not a wall: the living one must visibly move for the dead one to mean anything
		const ang = (i / 16) * Math.PI * 2;
		for (let k = 0; k < 30; k++) {
			s.walk(a, ang);
			s.beat();
		}
		best = Math.max(best, Math.hypot(s.body(a).state.x - x0, s.body(a).state.y - y0));
		if (best > 40) break;
	}
	check(best > 40, "alive, the Input remote moves the survivor", `${f1(best)} u`);
	s.immortal.delete(a);
	s.kill(a);
	const dead = s.body(a).state;
	const at = { x: dead.x, y: dead.y };
	const acked = s.body(a).ackSeq;
	for (let k = 0; k < 120; k++) {
		s.walk(a, (k / 20) % (Math.PI * 2));
		s.beat();
	}
	const moved = Math.hypot(dead.x - at.x, dead.y - at.y);
	check(moved === 0, "dead, two seconds of walking commands move the body not one unit", `${f1(moved)} u`);
	check(s.body(a).ackSeq !== acked, "…while the commands are still consumed and acknowledged (no backlog for later)");
	check(dead.hp <= 0, "…and it does not regenerate either", `hp ${f1(dead.hp)}`);
});

// ================================================================ 8: shutdown

section("8) a shutting-down server banks every body before it writes (§7.2)", () => {
	const s = bootServer();
	const id = newUser();
	const a = s.join(id, "late");
	armPistol(s.save(a), 30);
	const sp = s.enter(a);
	s.immortal.add(a);
	sp.state.hp = 55.5;
	sp.state.weapon.ammoCount = 6;
	const reserve = sp.save.ammoNormal;
	s.shutdown();
	const doc = s.stored(id);
	check(doc?.runHp === 55, "BindToClose: runHp is the body's", `runHp ${doc?.runHp}`);
	check(
		doc?.ammoNormal === reserve + 6,
		"…and the magazine is back in the reserve",
		`${reserve} + 6 → ${doc?.ammoNormal}`,
	);
	check(doc?.runOver === false, "…and a living survivor is saved alive");
});

// ================================================================ 9: the corners a review found

section("9) the corners: a pending death, a save that moved on another server, a late removal, a late remote", () => {
	{
		// a bite lands in the horde's half of a tick and the death is flagged in the next one: leaving in between
		const s = bootServer();
		const w = s.join(newUser(), "witness");
		s.immortal.add(w);
		s.enter(w);
		const a = s.join(newUser(), "slipper");
		const sp = s.enter(a);
		sp.state.godMode = false;
		sp.state.hp = -5;
		s.exit(a);
		const back = s.enter(a);
		check(
			back?.state.dead === true,
			"hp ≤ 0 but not flagged yet, then LeaveWorld: the body comes back dead, not saved",
		);
		const id = newUser();
		const b = s.join(id, "slipper2");
		const spB = s.enter(b);
		spB.state.godMode = false;
		spB.state.hp = -5;
		s.quit(b);
		check(s.stored(id)?.runOver === true, "…and a disconnect in that same gap is saved as the death it is");
	}
	{
		// dead here, a Rebirth PAID on another server, back here inside the 5 min: the Rebirth stands
		const s = bootServer();
		const w = s.join(newUser(), "witness");
		s.immortal.add(w);
		s.enter(w);
		const id = newUser();
		let a = s.join(id, "payer");
		s.enter(a);
		s.kill(a);
		s.quit(a);
		s.storeDoc(id, d => {
			d.runOver = false;
			d.runRev += 1;
			d.runHp = 0;
			d.deathCount += 1;
		});
		a = s.join(id, "payer");
		const back = s.enter(a);
		check(back?.state.dead === false, "a Rebirth paid on another server is not taken back by the corpse kept here");
	}
	{
		// alive here, killed on another server, back here and gone again without entering: the kept body must not
		// be banked over the newer save
		const s = bootServer();
		const id = newUser();
		let a = s.join(id, "hopper");
		s.enter(a);
		s.quit(a);
		s.storeDoc(id, d => {
			d.runOver = true;
			d.runHp = 0;
		});
		a = s.join(id, "hopper");
		s.quit(a);
		check(s.stored(id)?.runOver === true, "a death on another server survives a reconnect-and-leave here");
	}
	{
		// dead, went Home, and the daybreak came while in the lobby: a Rebirth now costs nothing
		const s = bootServer();
		const w = s.join(newUser(), "witness");
		s.immortal.add(w);
		s.enter(w);
		const a = s.join(newUser(), "patient");
		s.enter(a);
		const save = s.save(a);
		save.money = 0;
		s.nightLeft(1.5);
		s.kill(a);
		s.exit(a);
		s.run(3);
		const deaths = save.deathCount;
		const res = s.shop(a, { kind: "rebirth", runRev: save.runRev });
		check(
			res.ok === true && res.price === 0 && save.money === 0 && save.deathCount === deaths,
			"daybreak already came in the lobby: the Rebirth is free and is not counted as a continue",
			JSON.stringify({ ok: res.ok, reason: res.reason, price: res.price }),
		);
		const up = s.enter(a);
		check(up !== undefined && !up.state.dead, "…and the survivor walks back in standing");
	}
	{
		// main.server.ts may run its PlayerRemoving up to 60 s late (it waits for a load): by then the same user
		// can be back in the world with a new Player instance
		const s = bootServer();
		const id = newUser();
		const first = s.join(id, "twice");
		s.enter(first);
		const oldSave = s.save(first);
		s.quit(first);
		const second = s.join(id, "twice");
		const sp = s.enter(second);
		s.host.release(first, oldSave);
		check(
			sp !== undefined && s.body(second) === sp && s.sim.get(sp.slot) === sp,
			"a removal that arrives after the rejoin leaves the new session's body in the world",
		);
	}
	{
		// a remote still in flight from a Player that already left must not keep its body from expiring
		const s = bootServer();
		const id = newUser();
		const gone = s.join(id, "ghost");
		s.enter(gone);
		s.quit(gone);
		s.intent(gone, s.P.IntentKind.EnterWorld);
		s.run(301, 0.5);
		check(
			s.host.lives.keptBody(id) === undefined && s.host.playerOf(gone) === undefined,
			"a late remote from a departed Player neither brings it back nor stops its body expiring after 5 min",
		);
	}
});

// ================================================================ 10: the wardrobe's purchase, end to end

section("10) the wardrobe: coins become a costume only through ShopAction, at the catalogue's price (MON-04)", () => {
	const s = bootServer();
	const { COSTUMES } = require(join(SRC, "shared/data/shop.ts"));
	const { EQUIPS } = require(join(SRC, "shared/data/equips.ts"));
	const costume = name => COSTUMES.find(c => c.name === name);
	const equipOf = name => EQUIPS.find(e => e.name === name).id;
	const santa = costume("Santa");
	const p = s.join(newUser(), "shopper");
	const save = s.save(p);
	const start = save.money;
	info(`a new survivor starts with ${start} coins; Santa costs ${santa.price}`);

	// refusals, each with the save untouched (the action bucket holds 6, so the calls are paced)
	const refused = [99, -1, 1.5, "6", undefined].map(id => s.shop(p, { kind: "buyCostume", costumeId: id }));
	check(
		refused.every(r => r.ok === false && r.reason === "invalid"),
		"an unknown costume id (out of range, negative, fraction, text, missing) is refused as invalid",
		refused.map(r => r.reason).join(","),
	);
	s.run(3);
	save.money = santa.price - 1;
	const poor = s.shop(p, { kind: "buyCostume", costumeId: santa.id });
	check(poor.ok === false && poor.reason === "funds", "one coin short: refused as funds", JSON.stringify(poor));
	check(save.money === santa.price - 1 && save.costumes[santa.id] === 0, "…and nothing moved");
	check(
		poor.wallet !== undefined && poor.wallet.money === santa.price - 1,
		"…and the refusal carries the wallet back",
	);

	// a request that names its own price is charged the catalogue's anyway
	save.money = 100;
	const ok = s.shop(p, { kind: "buyCostume", costumeId: santa.id, price: 0 });
	check(
		ok.ok === true && ok.price === santa.price,
		"a request carrying `price: 0` pays the catalogue price",
		JSON.stringify({ ok: ok.ok, price: ok.price }),
	);
	check(save.money === 100 - santa.price, "exactly that is taken from the live save", `${save.money}`);
	check(
		save.costumes[santa.id] === 1 && ok.wallet?.costumes[santa.id] === 1,
		"the costume is theirs, and the wallet says so",
	);
	const twice = s.shop(p, { kind: "buyCostume", costumeId: santa.id });
	check(twice.ok === false && twice.reason === "owned", "buying it again is refused as owned");
	check(save.money === 100 - santa.price, "…and charges nothing");

	// wearing (F3, §4.8): the wardrobe's Equip is a verb the server applies out of the world, cosmetics only; a report
	// no longer moves the slots at all, so neither a bought outfit nor a pet nobody paid for comes from one
	const ack = s.report(p, { equipOutfit: equipOf("Santa"), equipPet: equipOf("Eagle") });
	check(ack?.ok === true, "a report that tries to wear them is still accepted (and corrected in silence)");
	check(save.equipOutfit === -1 && save.equipPet === -1, "…and wears nothing: the slots are the server's");
	s.verb(p, s.P.IntentKind.Equip, equipOf("Santa"), 0, 1);
	s.verb(p, s.P.IntentKind.Equip, equipOf("Eagle"), 0, 2);
	check(save.equipOutfit === equipOf("Santa"), "the wardrobe's Equip puts on the bought outfit");
	check(save.equipPet === -1, "…but not the Eagle nobody paid for", `equipPet ${save.equipPet}`);

	// and it reaches the DataStore with the coins it cost
	s.quit(p);
	const stored = s.stored(p.UserId);
	check(
		stored?.money === 100 - santa.price &&
			stored?.costumes[santa.id] === 1 &&
			stored?.equipOutfit === equipOf("Santa"),
		"the save written on leaving has the costume, the coins it cost and the outfit worn",
		stored === undefined ? "no document" : `money ${stored.money}, costume ${stored.costumes[santa.id]}`,
	);
});

// ================================================================ 11: the XP wallet push (PR #8)

section("11) the XP the server credits reaches the client: its wallet is pushed with level and XP in it", () => {
	// the owner's playtest (2026-09-23): the HUD's XP bar sat at "LV 1 · 0 / 120" through a whole run. From
	// MP_PHASE 2 the server credits every kill into the live save (server/sim/progress.ts), and nothing carried it
	// back: the only wallet the client heard came in its next report's ack, and that wallet had no XP in it
	const s = bootServer();
	const { applyWallet, defaultSave, expMaxInit } = require(join(SRC, "shared/game/save.ts"));
	const net = s.env.services.ReplicatedStorage.FindFirstChild("Net");
	const acks = p => net.FindFirstChild("SaveAck").sent.filter(e => e.to === p);
	// the WALLET pushes: SAV-01's news about a write of the save rides SaveAck too (`store`), and is section 32's
	const pushes = p => acks(p).filter(e => e.args[0]?.push === true && e.args[0]?.store === undefined);
	const p = s.join(newUser(), "hunter");
	const sp = s.enter(p);
	const save = s.save(p);
	s.run(1);
	check(pushes(p).length === 0, "nothing is pushed while nothing changed (the LoadAck already had it all)");

	// one kill, credited by the server exactly as combat does
	const need = expMaxInit(save.level);
	s.sim.progress.zombieKilled(900001, 10, sp.slot, 0);
	s.run(0.5);
	const first = pushes(p).pop()?.args[0];
	check(first !== undefined, "a kill the server credited pushes the wallet within half a second");
	check(
		first?.wallet?.exp === save.exp && first?.wallet?.level === save.level && save.exp === 10,
		"…carrying the level and the XP of the live save",
		JSON.stringify({ exp: first?.wallet?.exp, level: first?.wallet?.level, live: save.exp }),
	);

	// the client side: the real applyWallet on the client's own copy
	const mine = defaultSave();
	mine.skillLevels[1] = 0;
	applyWallet(mine, first.wallet);
	check(mine.exp === 10 && mine.level === 1, "the client's save now reads 10 XP (the HUD bar moves)");

	// enough for a level: the level, the XP left over and the skill point all reach the client
	s.sim.progress.zombieKilled(900002, need, sp.slot, 0);
	s.run(0.5);
	const second = pushes(p).pop()?.args[0];
	applyWallet(mine, second.wallet);
	check(
		mine.level === 2 && mine.exp === save.exp && mine.skillPoint === 1,
		"a level-up arrives with its skill point (level - 1 - skills learned)",
		JSON.stringify({ level: mine.level, exp: mine.exp, points: mine.skillPoint }),
	);
	// a skill learned on the client a moment before the next push is not handed back as a free point
	mine.skillLevels[1] = 1;
	mine.skillPoint = 0;
	applyWallet(mine, second.wallet);
	check(mine.skillPoint === 0, "a point already spent here stays spent when the same wallet lands again");

	// the pushes are paced and only on change: a quiet minute sends nothing
	const before = pushes(p).length;
	s.run(60);
	check(pushes(p).length === before, "a quiet minute pushes nothing", `${pushes(p).length - before} pushes`);
	// a wallet from an older server, without level or XP, moves neither
	const older = { ...second.wallet };
	delete older.level;
	delete older.exp;
	const keep = { level: mine.level, exp: mine.exp };
	applyWallet(mine, older);
	check(mine.level === keep.level && mine.exp === keep.exp, "a wallet without level or XP leaves them alone");

	// MON-05: what the wardrobe reads is pushed too, each on its own. A killing blow that pays no XP still counts a
	// zombie put down (the Horde Breaker line), and nothing else in the wallet moved with it
	const pushed = () => pushes(p).length;
	let count = pushed();
	const kills = save.zombieKills;
	s.sim.progress.zombieKilled(900003, 0, sp.slot, 0);
	s.run(0.5);
	const kill = pushes(p).pop()?.args[0];
	check(
		save.zombieKills === kills + 1 && pushed() === count + 1 && kill?.wallet?.zombieKills === kills + 1,
		"a killing blow worth 0 XP still pushes the wallet, with the kill count in it",
		JSON.stringify({ kills: save.zombieKills, pushes: pushed() - count, wallet: kill?.wallet?.zombieKills }),
	);
	applyWallet(mine, kill.wallet);
	check(mine.zombieKills === kills + 1, "…and the client's copy counts it (Zombies put down: n / 100)");
	// a title granted by the server, and nothing else
	count = pushed();
	save.titles[0] = 1;
	s.run(0.5);
	const titled = pushes(p).pop()?.args[0];
	check(pushed() === count + 1 && titled?.wallet?.titles?.[0] === 1, "a title granted pushes the wallet");
	// a midnight credited while the run pays no coins (§9.3): the life's day and nights move, the money does not
	count = pushed();
	save.day += 1;
	save.lifeNights += 1;
	s.run(0.5);
	const night = pushes(p).pop()?.args[0];
	check(
		pushed() === count + 1 && night?.wallet?.day === save.day && night?.wallet?.lifeNights === save.lifeNights,
		"a day credited to the life pushes the wallet, with the day and the nights in it",
		JSON.stringify({ pushes: pushed() - count, day: night?.wallet?.day, nights: night?.wallet?.lifeNights }),
	);
	mine.day = 1;
	mine.lifeNights = 0;
	applyWallet(mine, night.wallet);
	check(
		mine.day === save.day && mine.lifeNights === save.lifeNights,
		"…and the client's copy takes both from the server (HUD life day, Week One progress)",
		JSON.stringify({ day: mine.day, nights: mine.lifeNights }),
	);
	s.quit(p);
});

section(
	"11b) the achievements are the server's: its entry, its kill credit, its deaths; a report moves none (CON-04)",
	() => {
		const s = bootServer();
		const { applyWallet, defaultSave } = require(join(SRC, "shared/game/save.ts"));
		const { AchievementId: AID, ACHIEVEMENTS } = require(join(SRC, "shared/data/achievements.ts"));
		const net = s.env.services.ReplicatedStorage.FindFirstChild("Net");
		const pushes = p => net.FindFirstChild("SaveAck").sent.filter(e => e.to === p && e.args[0]?.push === true);
		const w = s.join(newUser(), "witness");
		s.immortal.add(w);
		s.enter(w);
		const p = s.join(newUser(), "rookie");
		const save = s.save(p);
		s.run(0.5);
		check(save.achievements[AID.FirstSteps] === 0, "in the lobby: no First steps yet");
		const sp = s.enter(p);
		check(save.achievements[AID.FirstSteps] === 1, "the server stood the first body in the town: First steps");

		// the kill credit, as combat calls it (a Charger, a blade in hand): pushed to the client with the counters
		s.sim.progress.zombieKilled(910001, 10, sp.slot, 0, 2, 7);
		s.run(0.5);
		const pushed = pushes(p).pop()?.args[0];
		const mine = defaultSave();
		applyWallet(mine, pushed?.wallet);
		check(
			mine.achievements[AID.ZombieSlayer] === 1 &&
				mine.achievements[AID.SpecialZombieSlayer] === 1 &&
				mine.achievements[AID.MeleeExpert] === 1 &&
				mine.achievements[AID.FirstSteps] === 1,
			"the pushed wallet carries the counters the server moved, and the client's copy takes them",
			JSON.stringify(pushed?.wallet?.achievements),
		);

		// a report claiming every achievement (and every title): accepted as a report, and not one counter moves
		const before = JSON.stringify(save.achievements);
		const titlesBefore = JSON.stringify(save.titles);
		const ack = s.report(p, {
			achievements: ACHIEVEMENTS.map(a => a.max),
			lifeDeaths: 0,
			titles: save.titles.map(() => 1),
		});
		check(
			ack?.ok === true &&
				JSON.stringify(save.achievements) === before &&
				JSON.stringify(save.titles) === titlesBefore,
			"a report with every achievement complete moves none, and grants no title (save v6, MON-05)",
		);
		check(
			JSON.stringify(ack?.wallet?.achievements) === before &&
				JSON.stringify(ack?.wallet?.titles) === titlesBefore,
			"...and the wallet it answers with carries the server's counters, not the claim",
		);

		// ACH-4: a death answered by WAITING for daybreak is a death of this life (deathCount only counts paid Rebirths)
		s.nightLeft(3);
		s.kill(p);
		check(
			save.lifeDeaths === 1 && save.deathCount === 0,
			"the server counts the death in lifeDeaths (deathCount 0)",
		);
		const up = s.runUntil(() => s.body(p)?.state.dead === false, 10);
		check(up >= 0 && save.lifeDeaths === 1, "…stood up at daybreak for free, the death still counts for Never die");
		s.immortal.add(p);
		s.report(p, { lifeDeaths: 0 });
		s.run(8); // past the report window: a report held back is processed by now
		check(save.lifeDeaths === 1, "…and a report cannot wipe it");
		s.immortal.delete(p);
		s.kill(p);
		const reset = s.shop(p, { kind: "newRun", runRev: save.runRev });
		check(reset.ok === true && save.lifeDeaths === 0, "a New game is a new life: no death in it yet");
		s.quit(p);
	},
);

// ================================================================ 12: titles, end to end (MON-05)

section(
	"12) titles: only what the server granted is shown, and a rollback cannot erase what was earned (MON-05)",
	() => {
		const s = bootServer();
		const TIT = require(join(SRC, "shared/data/titles.ts"));
		const { createZombie } = require(join(SRC, "shared/game/entities.ts"));
		const { TITLE_STORE } = require(join(SRC, "server/save/stores.ts"));
		const HB = TIT.TitleId.HordeBreaker;
		/** every World event this player's client received, in order (directed to it, or to everybody) */
		const worldTo = (srv, p) => {
			const out = [];
			for (const e of srv.env.services.ReplicatedStorage.FindFirstChild("Net").FindFirstChild("World").sent) {
				if (e.to !== undefined && e.to !== p) continue;
				const batch = srv.P.decodeWorld(e.args[0]);
				if (batch !== undefined) out.push(...batch.events);
			}
			return out;
		};
		const userId = newUser();
		const p = s.join(userId, "titled");
		const save = s.save(p);

		// the wardrobe asks to show a title nobody granted: refused, through the real ShopAction
		const refused = s.shop(p, { kind: "equipTitle", titleId: HB });
		check(
			refused.ok === false && refused.reason === "invalid",
			"showing an unearned title is refused",
			JSON.stringify(refused),
		);
		const junk = [9, -2, 0.5, "1", undefined].map(id => s.shop(p, { kind: "equipTitle", titleId: id }));
		check(
			junk.every(r => r.ok === false && r.reason === "invalid"),
			"and so is any id that is not a title",
		);
		check(save.equipTitle === -1, "…and the save shows nothing");
		// a report claiming every title, a pile of kills and a title shown: none of it sticks
		const ack = s.report(p, { titles: [1, 1, 1], zombieKills: 5000, equipTitle: HB });
		check(ack?.ok === true, "the report itself is accepted (the rest of it is honest)");
		check(
			save.titles.every(v => v === 0) && save.zombieKills === 0 && save.equipTitle === -1,
			"…but grants no title, counts no kill and shows nothing",
			`titles ${JSON.stringify(save.titles)}, kills ${save.zombieKills}, shown ${save.equipTitle}`,
		);

		// the server's own killing blow: 99 in the save, and the 100th through the host's combat
		s.run(3);
		save.zombieKills = TIT.HORDE_BREAKER_KILLS - 1;
		s.immortal.add(p);
		const sp = s.enter(p);
		check(sp !== undefined, "the survivor is in the world");
		const z = createZombie(1, sp.state.x + 40, sp.state.y, 1);
		z.hp = 1;
		z.hpMax = 1;
		s.sim.horde.zombies.push(z);
		s.sim.combat.hitZombieWith(sp, z, 10, 0, 0);
		s.run(0.3);
		const notes = worldTo(s, p).filter(
			e => e.t === s.P.WorldEv.Announce && e.msg === s.P.AnnounceKind.TitleUnlocked,
		);
		check(
			save.zombieKills === TIT.HORDE_BREAKER_KILLS && save.titles[HB] === 1,
			"the 100th zombie makes a Horde Breaker",
		);
		check(
			notes.length === 1 && TIT.titleFromWire(notes[0].arg) === HB,
			"and the player is told, once, on the reliable channel",
			JSON.stringify(notes),
		);
		// now it can be shown, and the profile carries it to every client
		const shown = s.shop(p, { kind: "equipTitle", titleId: HB });
		check(shown.ok === true && save.equipTitle === HB, "showing the earned title is accepted");
		s.run(0.3);
		const mine = worldTo(s, p).filter(e => e.t === s.P.WorldEv.PlayerProfile && e.slot === sp.slot);
		check(
			mine.length > 0 && mine[mine.length - 1].title === TIT.titleToWire(HB),
			"a PlayerProfile puts it under the name",
		);

		// leaving writes the save, and the title record beside it
		s.quit(p);
		const stored = s.stored(userId);
		check(
			stored?.titles[HB] === 1 && stored?.zombieKills === TIT.HORDE_BREAKER_KILLS && stored?.equipTitle === HB,
			"the save written on leaving has the title, the kills and the title shown",
		);
		const record = fakeStore(TITLE_STORE).data.get(String(userId));
		check(
			record?.titles[HB] === 1 && record?.zombieKills === TIT.HORDE_BREAKER_KILLS,
			"and the title record has what was earned",
			JSON.stringify(record),
		);
		// right to erasure: both documents say whose data they hold, in the key's own UserIds (stores.ts ownerTag)
		const { SAVE_STORE } = require(join(SRC, "server/save/stores.ts"));
		const tags = [SAVE_STORE, TITLE_STORE].map(n => JSON.stringify(fakeStore(n).userIds.get(String(userId))));
		check(
			tags.every(t => t === JSON.stringify([userId])),
			"the save and the title record are both tagged with the player's UserId",
			tags.join(" / "),
		);

		// a server rolled back to v4 code rewrites the save without the three v5 keys
		s.storeDoc(userId, d => {
			delete d.titles;
			delete d.zombieKills;
			delete d.equipTitle;
			d.version = 4;
		});
		// ...and the next v5 session, on another server, brings back all that was earned
		const s2 = bootServer();
		const p2 = s2.join(userId, "titled");
		const back = s2.save(p2);
		check(
			back.titles[HB] === 1 && back.zombieKills === TIT.HORDE_BREAKER_KILLS,
			"a v5 load after the rollback restores it all",
		);
		check(back.equipTitle === -1, "forgetting only WHICH title was shown");
		s2.quit(p2);
		const again = s2.stored(userId);
		check(
			again?.titles[HB] === 1 && again?.zombieKills === TIT.HORDE_BREAKER_KILLS,
			"and the save is written whole again",
		);
	},
);

// ================================================================ 13: the title record, under faults (MON-05 review)

section("13) the title record never stalls the save path: one attempt to read it, one to write it (MON-05)", () => {
	const s = bootServer();
	const { TITLE_STORE } = require(join(SRC, "server/save/stores.ts"));
	const record = fakeStore(TITLE_STORE);
	// a record that cannot be read: the load goes on without it (it used to wait and retry for up to 7 s, in front
	// of the LoadAck -- here a wait abandons the thread, exactly as a stall would feel to the player)
	record.fail.get = 1;
	const u = newUser();
	const p = s.join(u, "unlucky");
	check(record.fail.get === 0, "the record was read at load, and the read failed");
	check(s.save(p) !== undefined, "…and the LoadAck went out anyway: one attempt, no waits in front of it");
	// after that failure this server does not put the record in front of a leave's save for a while (§19)
	s.save(p).zombieKills = 11;
	record.fail.update = 1;
	s.quit(p);
	check(record.fail.update === 1 && s.stored(u)?.zombieKills === 11, "…and that leave wrote its save alone");
	// a record that cannot be written, on a server whose store had answered: the leave goes on (the next save tries
	// again)
	const s2 = bootServer();
	const p2 = s2.join(u, "unlucky");
	s2.save(p2).zombieKills = 12;
	s2.quit(p2);
	check(record.fail.update === 0, "the record write on leaving was tried, and failed");
	check(s2.stored(u)?.zombieKills === 12, "…and the save itself was written");
	const again = s2.join(u, "unlucky");
	check(s2.save(again)?.zombieKills === 12, "…and the leave finished: the same player loads again on this server");
	s2.quit(again);
});

// ================================================================ 14: the record never undoes a reset or a wipe

/** the admin of shared/admin/config.ts, and its panel's one remote */
const ADMIN_ID = 8013052784;
function adminRequest(srv, caller, req) {
	const net = srv.env.services.ReplicatedStorage.FindFirstChild("PZAdminNet");
	return net.FindFirstChild("AdminRequest").OnServerInvoke(caller, req);
}

section("14) what was earned never comes back from the title record after an admin reset or a wipe (MON-05)", () => {
	const HB = 1;
	/** a survivor who earned Horde Breaker, saved and gone: the save and the title record both hold it */
	function earner(name) {
		const srv = bootServer();
		const u = newUser();
		const p = srv.join(u, name);
		const save = srv.save(p);
		save.titles[HB] = 1;
		save.zombieKills = 100;
		srv.quit(p);
		return u;
	}
	const earned = save => save !== undefined && (save.titles[HB] === 1 || save.zombieKills > 0);
	const describe = save =>
		save === undefined ? "no save" : `titles ${JSON.stringify(save.titles)}, kills ${save.zombieKills}`;
	/** the next session anywhere, as the player would get it */
	function nextLoad(u, name) {
		const srv = bootServer();
		const p = srv.join(u, name);
		const save = srv.save(p);
		const out = save === undefined ? undefined : { titles: [...save.titles], zombieKills: save.zombieKills };
		srv.quit(p);
		return out;
	}

	// R1: this session could not read the record; the admin resets the save; the player leaves
	{
		const u = earner("r1");
		const srv = bootServer();
		const { TITLE_STORE } = require(join(SRC, "server/save/stores.ts"));
		fakeStore(TITLE_STORE).fail.get = 1;
		const p = srv.join(u, "r1");
		check(earned(srv.save(p)), "R1: the survivor loads with the title earned");
		const admin = srv.join(ADMIN_ID, "admin");
		const reset = adminRequest(srv, admin, { kind: "resetSave", userId: u });
		check(reset?.ok === true, "…an admin resets the save", JSON.stringify(reset?.error));
		srv.quit(p);
		srv.quit(admin);
		const after = nextLoad(u, "r1");
		check(
			after !== undefined && !earned(after),
			"…and the next load has no title and no kills, though this session never read the record",
			describe(after),
		);
	}

	// R2: the reset's session read the record, but its write of the record fails
	{
		const u = earner("r2");
		const srv = bootServer();
		const { TITLE_STORE } = require(join(SRC, "server/save/stores.ts"));
		const p = srv.join(u, "r2");
		const admin = srv.join(ADMIN_ID, "admin");
		adminRequest(srv, admin, { kind: "resetSave", userId: u });
		fakeStore(TITLE_STORE).fail.update = 1;
		srv.quit(p);
		srv.quit(admin);
		const after = nextLoad(u, "r2");
		check(
			after !== undefined && !earned(after),
			"R2: a reset whose record write failed is not undone by the old record at the next load",
			describe(after),
		);
	}

	// R3: the save key deleted on purpose (Open Cloud, a manual wipe, an erasure request); the record is left behind
	{
		const u = earner("r3");
		const { SAVE_STORE, TITLE_STORE } = require(join(SRC, "server/save/stores.ts"));
		fakeStore(SAVE_STORE).data.delete(String(u));
		const first = nextLoad(u, "r3");
		check(
			first !== undefined && !earned(first),
			"R3: a deleted save comes back as a new player's, record ignored",
			describe(first),
		);
		const later = nextLoad(u, "r3");
		check(later !== undefined && !earned(later), "…and stays that way on the load after", describe(later));
		const rec = fakeStore(TITLE_STORE).data.get(String(u));
		check(
			rec === undefined || (rec.titles.every(v => v === 0) && rec.zombieKills === 0),
			"…because the record without a save was replaced at the first write",
			JSON.stringify(rec),
		);
	}
});

// ================================================================ 15: the record is written under the lock

section("15) leaving writes the title record while the session still holds the save's lock (MON-05)", () => {
	const HB = 1;
	const { SAVE_STORE, TITLE_STORE } = require(join(SRC, "server/save/stores.ts"));
	const srv = bootServer();
	const u = newUser();
	const key = String(u);
	const p = srv.join(u, "leaver");
	const save = srv.save(p);
	save.titles[HB] = 1;
	save.zombieKills = 100;
	// the save document's lock at each write of this player's record: once it is released, another server may load
	// the player and own both documents, and a late record write from here would land on top of that session's
	const titles = fakeStore(TITLE_STORE);
	const original = titles.UpdateAsync;
	const lockAtWrite = [];
	titles.UpdateAsync = (k, transform) => {
		if (k === key) lockAtWrite.push(fakeStore(SAVE_STORE).data.get(k)?.lock ?? null);
		return original(k, transform);
	};
	const from = storeLog.length;
	srv.quit(p);
	titles.UpdateAsync = original;
	const writes = storeLog.slice(from).filter(e => e.key === key && e.op === "update");
	const order = JSON.stringify(writes.map(e => e.store));
	const recordAt = writes.findIndex(e => e.store === TITLE_STORE);
	const releaseAt = writes.findLastIndex(e => e.store === SAVE_STORE);
	check(recordAt >= 0 && releaseAt >= 0, "leaving wrote the save and the title record", order);
	check(recordAt < releaseAt, "…the record FIRST, then the save write that releases the lock", order);
	check(
		lockAtWrite.length > 0 && lockAtWrite.every(lock => lock !== null),
		"…so the lock was held at every write of the record",
		JSON.stringify(lockAtWrite),
	);
	const doc = fakeStore(SAVE_STORE).data.get(key);
	check(doc !== undefined && doc.lock === undefined, "the save was released");
	const stored = srv.stored(u);
	const rec = titles.data.get(key);
	check(
		stored?.zombieKills === 100 && stored.titles[HB] === 1 && rec?.zombieKills === 100 && rec.titles[HB] === 1,
		"…and both documents hold what was earned",
		`save ${stored?.zombieKills}, record ${JSON.stringify(rec)}`,
	);
});

// ================================================================ 16: the record costs a write only when it matters

section("16) the title record is written only when something was earned, and its store is asked again (MON-05)", () => {
	const { TITLE_STORE } = require(join(SRC, "server/save/stores.ts"));
	const recordWrites = (from, key) =>
		storeLog.slice(from).filter(e => e.store === TITLE_STORE && e.op === "update" && e.key === key).length;

	// a survivor who earned nothing: one session, a save written on leaving, and no record at all
	{
		const srv = bootServer();
		const u = newUser();
		const from = storeLog.length;
		const p = srv.join(u, "nothing");
		srv.save(p).money += 5;
		srv.quit(p);
		const writes = recordWrites(from, String(u));
		check(writes === 0, "a survivor who earned nothing costs no record write", `${writes} write(s)`);
		const none = fakeStore(TITLE_STORE).data.get(String(u));
		check(none === undefined, "…and has no record", JSON.stringify(none));
		srv.quit(srv.join(u, "nothing"));
		check(recordWrites(from, String(u)) === 0, "…not on the next session either");
	}

	// the store could not be opened when the first player came in: it is asked again, not given up for good
	{
		const srv = bootServer();
		openFailures.set(TITLE_STORE, 1);
		const u = newUser();
		const p = srv.join(u, "late store");
		check(openFailures.get(TITLE_STORE) === 0, "the title store failed to open at the first load");
		const save = srv.save(p);
		save.titles[1] = 1;
		save.zombieKills = 100;
		srv.run(61, 1 / 10);
		const from = storeLog.length;
		srv.quit(p);
		const late = recordWrites(from, String(u));
		check(late === 1, "a minute later, leaving opens it and writes the record", `${late} write(s)`);
		const rec = fakeStore(TITLE_STORE).data.get(String(u));
		check(rec?.zombieKills === 100 && rec.titles[1] === 1, "…with what was earned", JSON.stringify(rec));
	}
});

// ================================================================ 17: an admin who moves the day assists the run

section("17) an admin who moves a life's day has assisted that run: no coins, no title from it (§9.3, MON-05)", () => {
	const srv = bootServer();
	const u = newUser();
	const p = srv.join(u, "helped");
	const admin = srv.join(ADMIN_ID, "admin");
	const pays = () => srv.sim.paysRewards({ userId: u });
	check(pays(), "a run nobody helped pays");
	const money = adminRequest(srv, admin, {
		kind: "edit",
		userId: u,
		ops: [{ op: "stat", field: "money", value: 500 }],
	});
	check(
		money?.ok === true && pays(),
		"an admin setting the coins does not make it assisted",
		JSON.stringify(money?.error),
	);
	const day = adminRequest(srv, admin, { kind: "edit", userId: u, ops: [{ op: "stat", field: "day", value: 8 }] });
	check(day?.ok === true, "the admin sets the life's day to 8", JSON.stringify(day?.error));
	check(!pays(), "…and from then the run is assisted: it pays no coins and earns no title");
	check(srv.save(p).lifeNights === 0, "…nor did the day edit count a single night toward Week One");
	srv.quit(p);
	srv.quit(admin);
});

// ================================================================ 18: a server that lost the lock without knowing it

section(
	"18) a server that lost the lock without knowing it never writes the title record over a reset (MON-05)",
	() => {
		const HB = 1;
		const { SAVE_STORE, TITLE_STORE } = require(join(SRC, "server/save/stores.ts"));
		const u = newUser();
		const key = String(u);
		// a Horde Breaker, saved and gone: the save and the record both hold it
		{
			const srv = bootServer();
			const p = srv.join(u, "hopper");
			const save = srv.save(p);
			save.titles[HB] = 1;
			save.zombieKills = 100;
			srv.quit(p);
		}
		const earnedEpoch = fakeStore(TITLE_STORE).data.get(key)?.epoch;
		// server A loads the player (and holds the lock)...
		const a = bootServer();
		const onA = a.join(u, "hopper");
		check(a.save(onA)?.titles[HB] === 1, "server A loads the survivor, title and all");
		// ...who turns up on server B while A still thinks it has them: B takes the lock once A's is past waiting for
		// (LOCK_WAIT; here the lock is simply made old enough), and an admin resets the player there
		fakeStore(SAVE_STORE).data.get(key).lock.t -= 1000;
		const b = bootServer();
		const onB = b.join(u, "hopper");
		const admin = b.join(ADMIN_ID, "admin");
		const reset = adminRequest(b, admin, { kind: "resetSave", userId: u });
		check(reset?.ok === true, "on server B, an admin resets the save", JSON.stringify(reset?.error));
		b.quit(onB);
		b.quit(admin);
		const afterReset = fakeStore(TITLE_STORE).data.get(key);
		check(
			afterReset !== undefined && afterReset.epoch > earnedEpoch && afterReset.zombieKills === 0,
			"B's leave wrote the reset's record: a later history, nothing earned",
			JSON.stringify(afterReset),
		);
		// the player finally leaves A, which never learned it lost the lock -- and which counted one more kill meanwhile,
		// so it has something new to write
		a.save(onA).zombieKills += 1;
		a.quit(onA);
		const rec = fakeStore(TITLE_STORE).data.get(key);
		check(
			rec?.epoch === afterReset.epoch && rec.zombieKills === 0 && rec.titles.every(v => v === 0),
			"A's leave did not write its old titles over the reset's record",
			JSON.stringify(rec),
		);
		const doc = fakeStore(SAVE_STORE).data.get(key);
		const stored = typeof doc.data === "string" ? JSON.parse(doc.data) : doc.data;
		check(
			stored.zombieKills === 0 && stored.titles.every(v => v === 0),
			"and A's save write was refused (lock lost)",
		);
		// a server rolled back to v4 in this window: the save loses its epoch, and the record must not hand anything back
		b.storeDoc(u, d => {
			delete d.titles;
			delete d.zombieKills;
			delete d.equipTitle;
			delete d.titleEpoch;
			d.version = 4;
		});
		const c = bootServer();
		const onC = c.join(u, "hopper");
		const back = c.save(onC);
		check(
			back.titles.every(v => v === 0) && back.zombieKills === 0,
			"a v4 rollback right after brings back none of the reset titles",
			`titles ${JSON.stringify(back.titles)}, kills ${back.zombieKills}`,
		);
		c.quit(onC);
	},
);

// ================================================================ 19: the record never stands in front of the save

section("19) a slow, failing or starved title store never holds up the save that releases the lock (MON-05)", () => {
	const HB = 1;
	const { SAVE_STORE, TITLE_STORE } = require(join(SRC, "server/save/stores.ts"));
	const titleStore = fakeStore(TITLE_STORE);
	/** the writes of one leave, in order, for one key */
	const writesOf = (from, key) =>
		storeLog
			.slice(from)
			.filter(e => e.key === key && e.op === "update")
			.map(e => (e.store === TITLE_STORE ? "record" : e.store === SAVE_STORE ? "save" : e.store));
	/** a survivor who earns Horde Breaker in this session, and leaves: what the leave wrote */
	function earnAndLeave(srv, u, before) {
		const p = srv.join(u, `s${u}`);
		const save = srv.save(p);
		save.titles[HB] = 1;
		save.zombieKills = 100;
		before?.();
		const from = storeLog.length;
		srv.quit(p);
		return writesOf(from, String(u));
	}
	const released = u => {
		const doc = fakeStore(SAVE_STORE).data.get(String(u));
		const data = typeof doc?.data === "string" ? JSON.parse(doc.data) : doc?.data;
		return doc !== undefined && doc.lock === undefined && data?.zombieKills === 100;
	};

	// the request budget is nearly spent: a queued record write would wait in front of the save
	{
		const srv = bootServer();
		const u = newUser();
		const w = earnAndLeave(srv, u, () => {
			srv.env.services.DataStoreService.GetRequestBudgetForRequestType = () => 2;
		});
		check(
			JSON.stringify(w) === '["save"]',
			"a low UpdateAsync budget: the leave writes the save alone",
			JSON.stringify(w),
		);
		check(released(u), "…which lands, with what was earned, and releases the lock");
	}

	// the title store answered slowly at this server (here: a read that took 5 s at the load)
	{
		const srv = bootServer();
		const u = newUser();
		const read = titleStore.GetAsync;
		titleStore.GetAsync = key => {
			clockNow += 5;
			return read(key);
		};
		let w;
		try {
			w = earnAndLeave(srv, u);
		} finally {
			titleStore.GetAsync = read;
		}
		check(JSON.stringify(w) === '["save"]', "a slow title store: the leave does not wait on it", JSON.stringify(w));
		check(released(u), "…the save lands and releases the lock");
		// the next session, on a server whose store answers, writes the record from the save
		const next = bootServer();
		const p = next.join(u, "again");
		next.quit(p);
		const rec = titleStore.data.get(String(u));
		check(
			rec?.zombieKills === 100 && rec.titles[HB] === 1,
			"the next session writes the record from the save",
			JSON.stringify(rec),
		);
	}

	// a record write that failed: the next leaves on this server do not try again in front of their saves
	{
		const srv = bootServer();
		const first = newUser();
		titleStore.fail.update = 1;
		const w1 = earnAndLeave(srv, first);
		check(released(first), "a leave whose record write failed still writes its save", JSON.stringify(w1));
		const second = newUser();
		const w2 = earnAndLeave(srv, second);
		check(
			JSON.stringify(w2) === '["save"]',
			"…and the next leave, a moment later, writes the save alone",
			JSON.stringify(w2),
		);
		check(released(second), "…which lands and releases the lock");
	}

	// the server is closing: every save shares BindToClose's budget, and the record is not one of them
	{
		const srv = bootServer();
		const u = newUser();
		const p = srv.join(u, "closing");
		const save = srv.save(p);
		save.titles[HB] = 1;
		save.zombieKills = 100;
		const from = storeLog.length;
		srv.shutdown();
		const w = writesOf(from, String(u));
		check(JSON.stringify(w) === '["save"]', "BindToClose writes the save alone", JSON.stringify(w));
		check(released(u), "…which lands and releases the lock");
	}
});

// ================================================================ 20–25: a throw on the way out (F5, F6)

/**
 * Runs `run` the way Roblox runs threads: every signal connection and every task.spawn is a thread of its own, and an
 * error kills that thread alone (kept in the answer). The fake's runThread passes it on to the caller instead, which
 * would hide exactly what these sections are about: what the OTHER threads -- and the rest of the server -- do next.
 */
function asRoblox(run) {
	const died = [];
	const thread = (fn, args) => {
		try {
			return runThread(fn, args);
		} catch (e) {
			died.push(e?.message ?? String(e));
			return undefined;
		}
	};
	const spawn = task.spawn;
	const fire = Signal.prototype.Fire;
	task.spawn = (fn, ...args) => thread(fn, args);
	Signal.prototype.Fire = function (...args) {
		for (const h of [...this.handlers]) if (h.on) thread(h.fn, args);
	};
	try {
		thread(run, []);
	} finally {
		task.spawn = spawn;
		Signal.prototype.Fire = fire;
	}
	return died;
}

/** every warn line while `run` runs (still passed on to the suite's own warn) */
function warnsDuring(run) {
	const warn = globalThis.warn;
	const lines = [];
	globalThis.warn = (...a) => {
		lines.push(a.join(" "));
		warn(...a);
	};
	try {
		run();
	} finally {
		globalThis.warn = warn;
	}
	return lines;
}

/** `run` with a task.wait that passes (moving the clock) instead of parking the thread: how long it waited, in s */
function waitedDuring(run) {
	const wait = task.wait;
	let waited = 0;
	task.wait = (sec = 0) => {
		waited += sec;
		clockNow += sec;
		return sec;
	};
	try {
		run();
	} finally {
		task.wait = wait;
	}
	return waited;
}

/** main.server.ts AUTOSAVE_INTERVAL */
const AUTOSAVE_S = 60;

/**
 * A server whose autosave loop can be run one round at a time. The loop (main.server.ts) parks at its first task.wait
 * on this fake, so it is caught as it is spawned at boot and run again for each round: the interval passes once, every
 * wait inside the round passes too, and the next interval parks it again. Answers the threads that died in the round.
 */
function bootWithAutosave() {
	const spawn = task.spawn;
	let loop;
	task.spawn = (fn, ...args) => {
		if (loop === undefined && String(fn).includes("AUTOSAVE_INTERVAL")) loop = fn;
		return spawn(fn, ...args);
	};
	let srv;
	try {
		srv = bootServer();
	} finally {
		task.spawn = spawn;
	}
	if (loop === undefined) throw new Error("main.server.ts spawned no autosave loop");
	srv.autosave = () => {
		let intervals = 1;
		const wait = task.wait;
		task.wait = (sec = 0) => {
			if (sec >= AUTOSAVE_S && intervals-- <= 0) throw new Yield();
			clockNow += sec;
			return sec;
		};
		try {
			return asRoblox(loop);
		} finally {
			task.wait = wait;
		}
	};
	return srv;
}

/** HttpService.JSONEncode throws the next `n` times on this server (a save the engine cannot encode) */
function failEncode(srv, n = 1) {
	const http = srv.env.services.HttpService;
	const encode = http.JSONEncode;
	http.JSONEncode = v => {
		if (n > 0) {
			n -= 1;
			throw new Error("injected: JSONEncode failed");
		}
		return encode(v);
	};
}

/**
 * `obj[name]` throws the next `n` times it is called: a module the server reads through its exports, or an object's
 * method (called with its own `this`). Answers the undo.
 */
function failNext(obj, name, message, n = 1) {
	const own = Object.prototype.hasOwnProperty.call(obj, name);
	const real = obj[name];
	obj[name] = function (...a) {
		if (n > 0) {
			n -= 1;
			throw new Error(message);
		}
		return real.apply(this, a);
	};
	return () => {
		if (own) obj[name] = real;
		else delete obj[name];
	};
}

/** the stored save document (data and lock) of `userId` */
function saveDocOf(userId) {
	const { SAVE_STORE } = require(join(SRC, "server/save/stores.ts"));
	return fakeStore(SAVE_STORE).data.get(String(userId));
}
const lockFree = userId => saveDocOf(userId) !== undefined && saveDocOf(userId).lock === undefined;
/** a warn that carries `what` AND a traceback (xpcall + debug.traceback, F6) */
const traced = (lines, what) => lines.some(l => l.includes(what) && l.includes("stack traceback"));
const firstLine = s => (s === undefined ? "none" : String(s).split("\n")[0]);

section(
	"20) a leave whose banking of the body or last report throws still writes, and cleans up after itself (F5)",
	() => {
		// banking the body (mpHost.release) throws
		{
			const srv = bootServer();
			const admin = srv.join(ADMIN_ID, "admin");
			const u = newUser();
			const p = srv.join(u, "unbanked");
			srv.enter(p);
			const save = srv.save(p);
			save.money += 7;
			srv.host.release = () => {
				throw new Error("injected: banking the body failed");
			};
			let warns = [];
			const died = asRoblox(() => {
				warns = warnsDuring(() => srv.quit(p));
			});
			check(
				srv.stored(u)?.money === save.money,
				"banking the body throws on the way out: the final write lands all the same",
				`stored ${srv.stored(u)?.money}, live ${save.money}`,
			);
			check(lockFree(u), "…and hands the session lock back", JSON.stringify(saveDocOf(u)?.lock));
			check(died.length === 0, "…and no thread died of it", died.join(" | "));
			check(
				traced(warns, "injected: banking the body failed"),
				"…the failure is in the log, with its traceback (F6)",
				firstLine(warns.find(l => l.includes("banking"))),
			);
			const info = adminRequest(srv, admin, { kind: "serverInfo" });
			check(
				/\(1\/1 sessions/.test(info?.data?.dataStore ?? ""),
				"…the session is gone: only the admin's is left",
				info?.data?.dataStore,
			);
			const again = srv.join(u, "unbanked");
			check(
				srv.save(again)?.money === save.money,
				"…and so is its `releasing` mark: the player joins this server again and loads at once",
				`money ${srv.save(again)?.money}`,
			);
		}
		// the last report, still pending when the player leaves, throws
		{
			const srv = bootServer();
			const u = newUser();
			const p = srv.join(u, "reporter");
			const save = srv.save(p);
			srv.report(p, {});
			// inside SAVE_MIN_INTERVAL: kept as the pending report, processed by the leave
			srv.report(p, {});
			save.money += 3;
			const restore = failNext(
				require(join(SRC, "shared/game/save.ts")),
				"sanitizeClientReport",
				"injected: the last report failed",
			);
			let died;
			try {
				died = asRoblox(() => srv.quit(p));
			} finally {
				restore();
			}
			check(
				srv.stored(u)?.money === save.money && lockFree(u),
				"a pending report that throws on the way out: the final write lands and the lock is handed back",
				`stored ${srv.stored(u)?.money}, live ${save.money}`,
			);
			check(died.length === 0, "…and no thread died of it", died.join(" | "));
		}
	},
);

section("21) a save that cannot be encoded never blocks the session's later writes, nor keeps its lock (F5)", () => {
	// an autosave whose encode throws once: the writing flag comes back down and the next round writes
	{
		const srv = bootWithAutosave();
		const u = newUser();
		const p = srv.join(u, "autosaved");
		const save = srv.save(p);
		save.money += 11;
		failEncode(srv);
		let died1 = [];
		const warns = warnsDuring(() => {
			died1 = srv.autosave();
		});
		save.money += 1;
		const died2 = srv.autosave();
		check(
			srv.stored(u)?.money === save.money,
			"an autosave whose encode throws: the next round writes the save (the writing flag came back down)",
			`stored ${srv.stored(u)?.money}, live ${save.money}`,
		);
		check(died1.length === 0 && died2.length === 0, "…and no thread died of it", [...died1, ...died2].join(" | "));
		check(
			traced(warns, "injected: JSONEncode failed"),
			"…the failure is in the log, with its traceback (F6)",
			firstLine(warns.find(l => l.includes("JSONEncode"))),
		);
	}
	// a leave whose encode throws: nothing new can be written, but the lock goes back over the last save that landed
	{
		const u = newUser();
		{
			const first = bootServer();
			const p = first.join(u, "encoded");
			first.save(p).money = 1234;
			first.quit(p);
		}
		const srv = bootServer();
		const p = srv.join(u, "encoded");
		srv.save(p).money = 4321;
		failEncode(srv);
		let warns = [];
		const died = asRoblox(() => {
			warns = warnsDuring(() => srv.quit(p));
		});
		check(
			lockFree(u) && srv.stored(u)?.money === 1234,
			"a leave whose encode throws: the lock is handed back all the same, over the last save that landed",
			`lock ${JSON.stringify(saveDocOf(u)?.lock)}, stored ${srv.stored(u)?.money}`,
		);
		check(died.length === 0, "…and no thread died of it", died.join(" | "));
		check(traced(warns, "injected: JSONEncode failed"), "…the failure is in the log, with its traceback (F6)");
		const next = bootServer();
		const q = next.join(u, "encoded");
		check(
			next.save(q)?.money === 1234,
			"…so the player's next server loads that save at once, instead of waiting out the lock",
			`money ${next.save(q)?.money}`,
		);
		next.quit(q);
	}
});

section("22) a title record step that throws never costs the save it rides with (F5)", () => {
	const HB = 1;
	const { TITLE_STORE } = require(join(SRC, "server/save/stores.ts"));
	// in an autosave, right after the save write
	{
		const srv = bootWithAutosave();
		const REC = require(join(SRC, "server/save/titleRecord.ts"));
		const u = newUser();
		const p = srv.join(u, "titled");
		const save = srv.save(p);
		save.titles[HB] = 1;
		save.zombieKills = 100;
		const restore = failNext(REC, "titleRecordDue", "injected: the title record step failed");
		let landed = false;
		let died = [];
		try {
			died = srv.autosave();
			landed = srv.stored(u)?.zombieKills === 100;
			save.money += 5;
			// nothing is dirty after a write that landed: the next round writes because the lock refresh is due
			clockNow += 150;
			died.push(...srv.autosave());
		} finally {
			restore();
		}
		check(landed, "an autosave whose title record step throws: the save write it follows stands");
		check(
			srv.stored(u)?.money === save.money,
			"…and the next round writes again (the writing flag came back down)",
			`stored ${srv.stored(u)?.money}, live ${save.money}`,
		);
		const rec = fakeStore(TITLE_STORE).data.get(String(u));
		check(rec?.titles[HB] === 1, "…and brings the record it missed up to date", JSON.stringify(rec));
		check(died.length === 0, "…and no thread died of it", died.join(" | "));
	}
	// on the way out, in front of the save write that releases the lock
	{
		const srv = bootServer();
		const REC = require(join(SRC, "server/save/titleRecord.ts"));
		const u = newUser();
		const p = srv.join(u, "titled leaver");
		const save = srv.save(p);
		save.titles[HB] = 1;
		save.zombieKills = 100;
		save.money += 9;
		const restore = failNext(REC, "titleRecordDue", "injected: the title record step failed");
		let died;
		try {
			died = asRoblox(() => srv.quit(p));
		} finally {
			restore();
		}
		check(
			srv.stored(u)?.money === save.money && srv.stored(u)?.titles[HB] === 1 && lockFree(u),
			"the title record step throws on the way out: the save is written without it, and the lock handed back",
			`stored ${srv.stored(u)?.money}, live ${save.money}, lock ${JSON.stringify(saveDocOf(u)?.lock)}`,
		);
		check(died.length === 0, "…and no thread died of it", died.join(" | "));
		const next = bootServer();
		next.quit(next.join(u, "titled leaver"));
		const rec = fakeStore(TITLE_STORE).data.get(String(u));
		check(
			rec?.titles[HB] === 1,
			"…and the player's next session writes the record from the save",
			JSON.stringify(rec),
		);
	}
});

section("23) BindToClose: a save or a simulation that throws never holds the shutdown, nor anybody's save (F5)", () => {
	// two survivors; the first save written at shutdown (join order) cannot be encoded
	{
		const srv = bootServer();
		const u1 = newUser();
		const u2 = newUser();
		const a = srv.join(u1, "first");
		const b = srv.join(u2, "second");
		srv.save(a).money += 5;
		const sb = srv.save(b);
		sb.money += 6;
		failEncode(srv);
		let waited = 0;
		const died = asRoblox(() => {
			waited = waitedDuring(() => srv.shutdown());
		});
		check(
			waited < 1,
			"a save that throws at shutdown: BindToClose does not sit out its whole 25 s budget",
			`waited ${waited.toFixed(1)} s`,
		);
		check(
			srv.stored(u2)?.money === sb.money,
			"…the other survivor's save lands",
			`stored ${srv.stored(u2)?.money}`,
		);
		check(lockFree(u1) && lockFree(u2), "…and both locks are handed back");
		check(died.length === 0, "…and no thread died of it", died.join(" | "));
	}
	// the simulation throws as it is stopped (it banks every body on the way)
	{
		const srv = bootServer();
		const u = newUser();
		const p = srv.join(u, "stopped");
		const save = srv.save(p);
		save.money += 4;
		srv.host.stop = () => {
			throw new Error("injected: the simulation would not stop");
		};
		const died = asRoblox(() => srv.shutdown());
		check(
			srv.stored(u)?.money === save.money && lockFree(u),
			"the simulation throws as it stops: BindToClose still writes every save and hands the lock back",
			`stored ${srv.stored(u)?.money}, live ${save.money}`,
		);
		check(died.length === 0, "…and no thread died of it", died.join(" | "));
	}
});

section(
	"24) the autosave loop outlives a body that cannot be settled, and a load that throws is not stuck (F5)",
	() => {
		// settling a body throws in the loop: every save of the round is still written
		{
			const srv = bootWithAutosave();
			const u1 = newUser();
			const u2 = newUser();
			const sa = srv.save(srv.join(u1, "settled a"));
			const sb = srv.save(srv.join(u2, "settled b"));
			sa.money += 2;
			sb.money += 3;
			srv.host.settle = () => {
				throw new Error("injected: settling the body failed");
			};
			const died = srv.autosave();
			check(
				srv.stored(u1)?.money === sa.money && srv.stored(u2)?.money === sb.money,
				"settling a body throws in an autosave round: every save of the round is still written " +
					"(the loop used to die there, and every autosave on the server with it)",
				`stored ${srv.stored(u1)?.money}/${srv.stored(u2)?.money}, live ${sa.money}/${sb.money}`,
			);
			check(died.length === 0, "…and no thread died of it", died.join(" | "));
		}
		// the load itself throws (here, reading the title record): a read-only session the client can retry, not a
		// session stuck "loading" that answers nothing, refuses every Retry and keeps its lock
		{
			const u = newUser();
			{
				const first = bootServer();
				const p = first.join(u, "loader");
				first.save(p).money = 777;
				first.quit(p);
			}
			const srv = bootServer();
			const restore = failNext(
				require(join(SRC, "server/save/titleRecord.ts")),
				"loadTitleRecord",
				"injected: the load failed",
			);
			let p;
			let died;
			try {
				died = asRoblox(() => {
					p = srv.join(u, "loader");
				});
			} finally {
				restore();
			}
			// the client's LoadRequest found a failed load and asked for the retry, which runs after LOAD_RETRY_COOLDOWN
			srv.run(11, 0.5);
			const acks = srv.env.services.ReplicatedStorage.FindFirstChild("Net")
				.FindFirstChild("LoadAck")
				.sent.filter(e => e.to === p);
			const last = acks[acks.length - 1]?.args[0];
			check(
				last?.status === "ok" && last.save.money === 777,
				"a load that throws: the client's Retry loads the save",
				`status ${last?.status}, money ${last?.save?.money}`,
			);
			check(died.length === 0, "…and no thread died of it", died.join(" | "));
			srv.quit(p);
			check(lockFree(u) && srv.stored(u)?.money === 777, "…and the leave hands the lock back");
		}
	},
);

section("25) a simulation tick that throws is logged with its traceback (F6)", () => {
	const srv = bootServer();
	const advance = srv.sim.advance;
	srv.sim.advance = () => {
		throw new Error("injected: the tick failed");
	};
	let message = "";
	try {
		srv.beat();
	} catch (e) {
		message = String(e?.message ?? e);
	} finally {
		srv.sim.advance = advance;
	}
	check(
		message.includes("injected: the tick failed") && message.includes("stack traceback"),
		"the tick's failure reaches the log with its traceback",
		firstLine(message),
	);
});

section(
	"25b) every phase of the tick is a MicroProfiler label that closes, even on a throw; the counts reach the admin (F6)",
	() => {
		const srv = bootServer();
		const admin = srv.join(ADMIN_ID, "admin");
		const p = srv.join(newUser(), "profiled");
		srv.immortal.add(p);
		srv.enter(p);
		debug.profileLabels.clear();
		const unbalanced = debug.profileUnbalanced;
		srv.run(1.2);
		check(
			debug.profileOpen === 0 && debug.profileUnbalanced === unbalanced,
			"every label a tick opened, it closed",
			`${debug.profileOpen} open, ${debug.profileUnbalanced - unbalanced} ends without a begin`,
		);
		const want = ["PZ.step", "PZ.players", "PZ.horde", "PZ.horde.field", "PZ.horde.zombies", "PZ.world"];
		want.push("PZ.replication", "PZ.repl.collect", "PZ.repl.snap");
		const missing = want.filter(label => !debug.profileLabels.has(label));
		check(
			missing.length === 0,
			"the tick's phases are MicroProfiler bars (PZ.step, PZ.horde.field, PZ.repl.snap…)",
			missing,
		);
		check(debug.memoryCategory === undefined, "the heartbeat leaves the memory category as it found it (PZ.sim)");
		const ws = srv.env.services.Workspace;
		const costs = ["players", "field", "zombies", "replication"].map(n => ws.GetAttribute(`pz_cost_${n}_ms`));
		check(
			costs.every(v => typeof v === "number"),
			"each phase's cost is an attribute (pz_cost_<phase>_ms)",
			costs,
		);
		check(
			ws.GetAttribute("pz_tick_errors") === 0,
			"pz_tick_errors is published, at 0",
			ws.GetAttribute("pz_tick_errors"),
		);
		const info = adminRequest(srv, admin, { kind: "serverInfo" });
		const sim = info?.data?.sim;
		check(
			sim !== undefined && sim.phases.length === 12 && sim.phases[0].name === "players" && sim.tickErrors === 0,
			"...and the admin panel's Server info carries the same numbers",
			JSON.stringify(sim?.phases?.map(x => x.name)),
		);
		// a tick that throws inside the horde, three heartbeats running: the labels it was inside are closed for it, and
		// every failure is counted though the repeated message is logged once
		const horde = srv.sim.horde;
		const step = horde.step;
		horde.step = () => {
			throw new Error("injected: the horde failed");
		};
		for (let i = 0; i < 3; i++) {
			try {
				srv.beat();
			} catch {
				// the harness throws on the logged failure (the first one): that is the point here
			}
		}
		horde.step = step;
		check(
			debug.profileOpen === 0,
			"a tick that threw inside PZ.horde left no label open",
			`${debug.profileOpen} open`,
		);
		check(srv.host.metrics().tickErrors === 3, "each failed heartbeat is counted", srv.host.metrics().tickErrors);
		check(
			ws.GetAttribute("pz_tick_errors") >= 1,
			"...and pz_tick_errors goes out while every tick fails",
			ws.GetAttribute("pz_tick_errors"),
		);
		srv.run(1.1);
		check(
			ws.GetAttribute("pz_tick_errors") === 3,
			"once it runs again, the count stands at 3",
			ws.GetAttribute("pz_tick_errors"),
		);
	},
);

// ================================================================ 26–28: the review of the F5 fix

/** a returning survivor: one session that stored `money` and left */
function returning(money, name) {
	const u = newUser();
	const first = bootServer();
	const p = first.join(u, name);
	first.save(p).money = money;
	first.quit(p);
	return u;
}

/** the player's next server: how long its join waited for the lock (s), and the money its LoadAck carried */
function nextServerJoin(u, name) {
	const next = bootServer();
	let q;
	const waited = waitedDuring(() => {
		q = next.join(u, name);
	});
	const money = next.save(q)?.money;
	next.quit(q);
	return { waited, money };
}

section("26) a read-only session, and a save too large to write, hand the lock back on the way out (F5 review)", () => {
	// a load that throws after loadWithLock took the lock, and the player leaves without a Retry (review R1)
	{
		const u = returning(555, "leaker");
		const srv = bootServer();
		const restore = failNext(
			require(join(SRC, "server/save/titleRecord.ts")),
			"loadTitleRecord",
			"injected: the load failed",
		);
		let p;
		try {
			asRoblox(() => {
				p = srv.join(u, "leaker");
			});
		} finally {
			restore();
		}
		const held = saveDocOf(u)?.lock !== undefined;
		srv.quit(p);
		check(
			held && lockFree(u) && srv.stored(u)?.money === 555,
			"a load that threw after taking the lock: its read-only session hands the lock back on the way out",
			`held ${held}, lock after ${JSON.stringify(saveDocOf(u)?.lock)}, stored ${srv.stored(u)?.money}`,
		);
		const next = nextServerJoin(u, "leaker");
		check(
			next.waited < 1 && next.money === 555,
			"…so the next server loads the save at once",
			`waited ${next.waited.toFixed(1)} s, money ${next.money}`,
		);
	}
	// the stored save is not valid JSON (read-only from the start)
	{
		const { SAVE_STORE } = require(join(SRC, "server/save/stores.ts"));
		const u = returning(1, "unreadable");
		fakeStore(SAVE_STORE).data.get(String(u)).data = "{not json";
		const srv = bootServer();
		const p = srv.join(u, "unreadable");
		const held = saveDocOf(u)?.lock !== undefined;
		srv.quit(p);
		check(
			held && lockFree(u) && saveDocOf(u)?.data === "{not json",
			"a stored save that is not JSON: the read-only session hands the lock back, the stored data untouched",
			`held ${held}, lock after ${JSON.stringify(saveDocOf(u)?.lock)}, data ${JSON.stringify(saveDocOf(u)?.data)}`,
		);
		const next = nextServerJoin(u, "unreadable");
		check(next.waited < 1, "…so the next server does not wait out the lock", `waited ${next.waited.toFixed(1)} s`);
	}
	// a save too large to store, on the way out
	{
		const u = returning(1234, "hoarder");
		const srv = bootServer();
		const p = srv.join(u, "hoarder");
		srv.save(p).money = 4321;
		const http = srv.env.services.HttpService;
		const encode = http.JSONEncode;
		let big = 1;
		http.JSONEncode = v => (big-- > 0 ? "x".repeat(3_900_001) : encode(v));
		srv.quit(p);
		check(
			lockFree(u) && srv.stored(u)?.money === 1234,
			"a save too large to store on the way out: not written, and the lock handed back over the last save that landed",
			`lock ${JSON.stringify(saveDocOf(u)?.lock)}, stored ${srv.stored(u)?.money}`,
		);
		const next = nextServerJoin(u, "hoarder");
		check(
			next.waited < 1 && next.money === 1234,
			"…so the next server loads that save at once",
			`waited ${next.waited.toFixed(1)} s, money ${next.money}`,
		);
	}
});

section(
	"27) a Rebirth or a New game whose simulation step throws: nothing sold twice, no free revive (F5 review)",
	() => {
		const { rebirthPrice } = require(join(SRC, "shared/data/shop.ts"));
		/** a survivor down in the world with 1000 coins, and a witness standing so the world does not end */
		function fallen(s, name) {
			const w = s.join(newUser(), "witness");
			s.immortal.add(w);
			s.enter(w);
			const u = newUser();
			const p = s.join(u, name);
			s.enter(p);
			const save = s.save(p);
			save.money = 1000;
			s.kill(p);
			return { u, p, save };
		}
		/** the ShopAction answer, or what it threw */
		function ask(s, p, req) {
			try {
				return s.shop(p, req);
			} catch (e) {
				return { threw: e?.message ?? String(e) };
			}
		}
		// the stand-up throws before the body is up (review R2)
		{
			const s = bootServer();
			const { p, save } = fallen(s, "payer");
			const rev = save.runRev;
			const deaths = save.deathCount;
			const price = rebirthPrice(deaths);
			const restore = failNext(s.host, "rebirth", "injected: the rebirth failed");
			let res;
			try {
				res = ask(s, p, { kind: "rebirth", runRev: rev });
			} finally {
				restore();
			}
			check(
				res?.ok === false && res.reason === "network" && res.wallet?.money === 1000,
				"a Rebirth whose stand-up throws is not sold: refused, and the wallet shows nothing taken",
				JSON.stringify(res),
			);
			check(
				save.money === 1000 &&
					save.deathCount === deaths &&
					save.runRev === rev &&
					save.runOver === true &&
					s.body(p)?.state.dead === true,
				"…the save is as it was (coins, continues, run) and the body is still down",
				`money ${save.money}, deaths ${save.deathCount}, runRev ${save.runRev}/${rev}, runOver ${save.runOver}, ` +
					`dead ${s.body(p)?.state.dead}`,
			);
			const again = ask(s, p, { kind: "rebirth", runRev: save.runRev });
			check(
				again?.ok === true &&
					again.price === price &&
					save.money === 1000 - price &&
					save.deathCount === deaths + 1 &&
					s.body(p)?.state.dead === false,
				"…and the client's next Rebirth stands the body up for ONE charge",
				`${JSON.stringify({ ok: again?.ok, price: again?.price })}, charged ${1000 - save.money} of ${price}, ` +
					`deaths ${save.deathCount}`,
			);
		}
		// the stand-up throws after the body is up (review R2b)
		{
			const s = bootServer();
			const { p, save } = fallen(s, "late thrower");
			const price = rebirthPrice(save.deathCount);
			const real = s.host.rebirth;
			s.host.rebirth = (...a) => {
				real(...a);
				throw new Error("injected: after the stand-up");
			};
			let res;
			try {
				res = ask(s, p, { kind: "rebirth", runRev: save.runRev });
			} finally {
				s.host.rebirth = real;
			}
			check(
				res?.ok === true &&
					res.price === price &&
					save.money === 1000 - price &&
					save.runOver === false &&
					s.body(p)?.state.dead === false,
				"a Rebirth that throws after the body stood up is sold, once: the body up, one charge, the save agrees",
				`${JSON.stringify(res)}, money ${save.money}, runOver ${save.runOver}, dead ${s.body(p)?.state.dead}`,
			);
		}
		// New game from the lobby, and the new life throws (review R3)
		{
			const s = bootWithAutosave();
			const { u, p, save } = fallen(s, "quitter");
			s.exit(p);
			save.day = 5;
			const rev = save.runRev;
			const restore = failNext(s.host, "newLife", "injected: the new life failed");
			let res;
			try {
				res = ask(s, p, { kind: "newRun", runRev: rev });
			} finally {
				restore();
			}
			check(
				res?.ok === true && save.day === 1 && save.runRev === rev + 1,
				"a New game whose new life throws: the new life is given (life day 1, a new run), as the client is told",
				`${JSON.stringify(res)}, day ${save.day}, runRev ${save.runRev}/${rev}`,
			);
			check(
				save.runOver === true && s.host.isDead(p, save) === true,
				"…and the death stands, in the save as in the keeper",
				`runOver ${save.runOver}, keeper dead ${s.host.isDead(p, save)}`,
			);
			s.autosave();
			check(
				s.stored(u)?.runOver === true,
				"…so the DataStore never says alive for a survivor the server keeps dead (a crash would revive them)",
				`stored runOver ${s.stored(u)?.runOver}`,
			);
			const back = s.enter(p);
			check(
				back?.state.dead === true,
				"…nor does the next entry stand them up for free",
				`dead ${back?.state.dead}`,
			);
		}
	},
);

section("28) at shutdown, one body that cannot be banked leaves the others banked (F5 review)", () => {
	const srv = bootServer();
	const u1 = newUser();
	const u2 = newUser();
	const a = srv.join(u1, "first");
	const b = srv.join(u2, "second");
	for (const p of [a, b]) {
		armPistol(srv.save(p), 30);
		srv.immortal.add(p);
	}
	srv.enter(a);
	const sp = srv.enter(b);
	sp.state.hp = 55.5;
	sp.state.weapon.ammoCount = 6;
	const reserve = sp.save.ammoNormal;
	// the first body banked (join order) throws
	const restore = failNext(srv.host.lives, "disconnect", "injected: banking one body failed");
	let died;
	try {
		died = asRoblox(() => srv.shutdown());
	} finally {
		restore();
	}
	const doc = srv.stored(u2);
	check(
		doc?.runHp === 55 && doc?.ammoNormal === reserve + 6,
		"one body that cannot be banked at shutdown: the next one is banked all the same (runHp, magazine back)",
		`runHp ${doc?.runHp}, reserve ${reserve} + 6 → ${doc?.ammoNormal}`,
	);
	check(
		srv.stored(u1) !== undefined && lockFree(u1) && lockFree(u2),
		"…and every save is written, every lock handed back",
	);
	check(died.length === 0, "…and no thread died of it", died.join(" | "));
});

// ================================================================ 29: the admin audit log, through the real remote

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

section("29) the admin audit log: UserIds and filtered text only, one key per server per day (F5, F10, F12)", () => {
	const s = bootServer();
	const { ADMIN_LOG_STORE } = require(join(SRC, "server/save/stores.ts"));
	const LOG = require(join(SRC, "server/admin/auditLog.ts"));
	const { ADMIN_USER_IDS } = require(join(SRC, "shared/admin/config.ts"));
	// the Luau the admin server's text handling needs, only for this section
	const savedMatch = globalThis.string.match;
	globalThis.string.match = (str, pat) => {
		const m = new RegExp(luaPattern(pat).source).exec(str);
		return m === null ? [undefined] : [m[1] ?? m[0]];
	};
	Object.defineProperty(String.prototype, "gsub", {
		value(pat, repl) {
			let n = 0;
			const out = this.replace(luaPattern(pat), () => {
				n += 1;
				return repl;
			});
			return [out, n];
		},
		configurable: true,
		writable: true,
	});
	globalThis.error ??= v => {
		throw v instanceof Error ? v : new Error(String(v));
	};
	try {
		const { Players, TextService, ReplicatedStorage } = s.env.services;
		// the Roblox text filter: masks one word and, like the real one, long digit runs (a phone number -- or a UserId);
		// `down` makes it unavailable, as an outage does
		const filter = { down: false };
		TextService.FilterStringAsync = text => {
			if (filter.down) throw new Error("filter unavailable");
			const masked = text.replace(/badword/g, "#######").replace(/\d{5,}/g, m => "#".repeat(m.length));
			return { GetNonChatStringForBroadcastAsync: () => masked, GetNonChatStringForUserAsync: () => masked };
		};
		const bans = [];
		Players.BanAsync = cfg => bans.push(cfg);
		Players.UnbanAsync = () => {};
		Players.GetBanHistoryAsync = () => ({
			IsFinished: true,
			GetCurrentPage: () =>
				bans.map(b => ({
					Ban: true,
					StartTime: "t",
					Duration: b.Duration,
					DisplayReason: b.DisplayReason,
					PrivateReason: b.PrivateReason,
					PlaceId: 1,
				})),
			AdvanceToNextPageAsync: () => {},
		});
		Players.GetNameFromUserIdAsync = id => `user${id}`;
		Players.GetUserIdFromNameAsync = () => {
			throw new Error("not found");
		};
		const store = fakeStore(ADMIN_LOG_STORE);
		store.ListKeysAsync = prefix => ({
			GetCurrentPage: () => [...store.data.keys()].filter(k => k.startsWith(prefix)).map(k => ({ KeyName: k })),
		});
		// an old single-key log, written by the code before this change: a name, a label, the raw reason
		store.data.set(LOG.LEGACY_AUDIT_KEY, [
			{
				t: 5,
				adminId: ADMIN_USER_IDS[0],
				admin: "OwnerName",
				action: "kick",
				target: "Victim (4242)",
				details: "raw words",
				ok: true,
			},
		]);

		const admin = s.join(ADMIN_USER_IDS[0], "OwnerName");
		const target = s.join(newUser(), "VictimName");
		target.LocaleId = "en-us";
		const bystander = s.join(newUser(), "BystanderName");
		const request = ReplicatedStorage.FindFirstChild("PZAdminNet").FindFirstChild("AdminRequest");
		const ask = req => request.OnServerInvoke(admin, req);

		let kickedWith;
		target.Kick = msg => {
			target.kicked = true;
			kickedWith = msg;
		};
		const kick = ask({ kind: "kick", userId: target.UserId, reason: "you badword" });
		check(kick.ok === true, "an admin kicks through the real remote", JSON.stringify(kick));
		check(
			kickedWith === "You were kicked by an administrator: you #######",
			"the kicked player reads the lang.ts line and the reason as the filter returned it",
			kickedWith,
		);
		const ban = ask({
			kind: "ban",
			target: String(bystander.UserId),
			duration: "1d",
			displayReason: "badword exploiting",
			privateReason: "private raw note badword",
			applyToUniverse: true,
			excludeAlts: false,
		});
		check(ban.ok === true && bans.length === 1, "a ban goes to BanAsync", JSON.stringify(ban));
		check(
			bans[0].DisplayReason === "####### exploiting. The rules and how to appeal are on this experience's page.",
			"the banned player reads the filtered reason and where the rules and the appeal are",
			bans[0].DisplayReason,
		);
		check(
			bans[0].PrivateReason.endsWith(`| by admin ${admin.UserId}`) &&
				!bans[0].PrivateReason.includes("OwnerName"),
			"the private note names the admin by UserId, not by name",
			bans[0].PrivateReason,
		);
		filter.down = true;
		const failed = ask({ kind: "announce", text: "secret badword text" });
		check(failed.ok === false, "an announcement the filter cannot check is refused");
		filter.down = false;
		const history = ask({ kind: "banHistory", target: String(bystander.UserId) });
		const entry = history.data?.entries?.[0];
		check(
			entry !== undefined && !entry.privateReason.includes("badword") && !entry.displayReason.includes("badword"),
			"the ban history is shown back to the admin through the filter (F12)",
			entry?.privateReason,
		);
		check(
			entry?.privateReason === `private raw note ####### | by admin ${admin.UserId}`,
			"...only what the admin typed: the game's ' | by admin <UserId>' stays readable (the filter would hash it)",
			entry?.privateReason,
		);

		// what reaches the DataStore: this server's key of today, and nothing of the typed text or of anyone's name
		s.shutdown();
		const key = LOG.auditKey(os.time(), globalThis.game.JobId);
		const doc = store.data.get(key);
		const json = JSON.stringify(doc ?? null);
		check(Array.isArray(doc) && doc.length === 3, "the entries land in this server's key of the day", key);
		check(
			!/badword|secret|raw|OwnerName|VictimName|BystanderName/.test(json) && !json.includes('"admin"'),
			"no name and no unfiltered text is stored (the failed announcement neither)",
			json,
		);
		check(
			doc?.some(e => e.action === "kick" && e.targetId === target.UserId && e.details === "you #######") &&
				doc?.some(
					e =>
						e.action === "ban" &&
						e.targetId === bystander.UserId &&
						e.details.includes('"####### exploiting"'),
				),
			"the kick and the ban are stored by UserId, with the reason as players saw it",
		);
		check(!store.data.get(LOG.LEGACY_AUDIT_KEY).some(e => e.t > 5), "nothing is appended to the old single key");

		// the panel reads it back: names looked up now, the old key scrubbed in place
		const log = ask({ kind: "auditLog" });
		const shown = log.data ?? [];
		check(
			shown.some(
				e => e.action === "kick" && e.target === `VictimName (${target.UserId})` && e.admin === "OwnerName",
			),
			"the panel shows names, looked up when it asks (never stored)",
			JSON.stringify(shown.slice(0, 2)),
		);
		check(
			shown.some(e => e.t === 5 && e.target === "user4242 (4242)" && e.details === ""),
			"the old entry shows too, without its raw reason",
		);
		const legacy = JSON.stringify(store.data.get(LOG.LEGACY_AUDIT_KEY));
		check(!/OwnerName|Victim|raw words/.test(legacy), "and the old key was scrubbed in place", legacy);
	} finally {
		globalThis.string.match = savedMatch;
		delete String.prototype.gsub;
	}
});

// ================================================================ 30: every remote counts toward the flood kick

section(
	"30) every remote a client can fire counts toward the §8.2 flood kick, and the kick is audited (M2, L4)",
	() => {
		const s = bootServer();
		const { ADMIN_LOG_STORE } = require(join(SRC, "server/save/stores.ts"));
		const LOG = require(join(SRC, "server/admin/auditLog.ts"));
		const CFG = require(join(SRC, "shared/net/mpConfig.ts"));
		const { ReplicatedStorage } = s.env.services;
		const net = ReplicatedStorage.FindFirstChild("Net");
		const fire = (name, p, ...args) => net.FindFirstChild(name).OnServerEvent.Fire(p, ...args);
		const admin = ReplicatedStorage.FindFirstChild("PZAdminNet");
		const saveAcks = p => net.FindFirstChild("SaveAck").sent.filter(e => e.to === p).length;

		// junk SaveRequests from the lobby (a player not in the world has no ServerPlayer: the link counts them)
		const junk = s.join(newUser(), "junkSaver");
		for (let i = 0; i <= CFG.FLOOD_MALFORMED; i++) fire("SaveRequest", junk, 7, { huge: true });
		check(junk.kicked, `${CFG.FLOOD_MALFORMED + 1} malformed SaveRequests in the lobby are a flood kick`);

		// a LoadRequest storm from a survivor in the world
		const loader = s.join(newUser(), "loadStorm");
		s.immortal.add(loader);
		s.enter(loader);
		for (let i = 0; i <= CFG.FLOOD_MESSAGES; i++) fire("LoadRequest", loader);
		check(loader.kicked, `${CFG.FLOOD_MESSAGES + 1} LoadRequests in an instant, in the world, are a flood kick`);

		// ShopAction: the token bucket refuses, and past the flood line the link kicks
		const shopper = s.join(newUser(), "shopStorm");
		let rate = 0;
		for (let i = 0; i <= CFG.FLOOD_MESSAGES; i++)
			if (s.shop(shopper, { kind: "buyPack", packId: 0 })?.reason === "rate") rate++;
		check(
			rate > 0 && shopper.kicked,
			"a ShopAction storm is refused by its bucket and then kicked",
			`${rate} "rate"`,
		);

		// the verification of 2026-09-24: 300 purchases in a few seconds were all answered "rate" -- each with a whole
		// wallet -- and never kicked: 300 is far under the connection's 500-in-2-s line. ShopAction has its own §8.2 line
		// now ("> 3× the limit for 5 s": SHOP_FLOOD_CALLS), and "rate" carries no wallet
		const SG = require(join(SRC, "shared/net/shopGuard.ts"));
		const buyer = s.join(newUser(), "buyStorm");
		const replies = [];
		for (let i = 0; i < 300 && !buyer.kicked; i++) {
			replies.push(s.shop(buyer, { kind: "buyPack", packId: 0 }));
			if (i % 10 === 9) s.run(0.1);
		}
		check(
			buyer.kicked && replies.length === SG.SHOP_FLOOD_CALLS + 1,
			`300 purchases in 3 s: kicked at the ${SG.SHOP_FLOOD_CALLS + 1}st, inside one 5 s window (§8.2)`,
			`${replies.length} sent, kicked ${buyer.kicked === true}`,
		);
		const rated = replies.filter(r => r?.reason === "rate");
		check(
			rated.length > 0 && rated.every(r => r.wallet === undefined),
			'...and no "rate" answer carries a wallet (a refusal is not a reflector)',
			`${rated.filter(r => r.wallet !== undefined).length} of ${rated.length} with one`,
		);

		// an honest client clicking Buy ten times a second for ten seconds: its own copy of the bucket
		// (client/systems/saveClient.ts) holds back what the server would refuse -- the server never says "rate" to it,
		// and never comes near the line
		const clicker = s.join(newUser(), "fastClicker");
		s.save(clicker).money = 100000;
		const mine = SG.newShopBucket(os.clock());
		let sent = 0;
		let serverRate = 0;
		for (let i = 0; i < 100; i++) {
			if (SG.takeShopToken(mine, os.clock())) {
				sent += 1;
				if (s.shop(clicker, { kind: "buyPack", packId: 1 + (i % 6) })?.reason === "rate") serverRate += 1;
			}
			s.run(0.1);
		}
		check(
			!clicker.kicked && serverRate === 0 && sent > 20 && sent <= CFG.SHOP_BURST + CFG.SHOP_RATE * 10 + 1,
			'an honest client clicking Buy 10 times a second for 10 s: what it sends is never "rate" and never a kick',
			`${sent} sent of 100 clicks, ${serverRate} "rate"`,
		);

		// viewShop is a kind this server knows (it was counted malformed: > 50 opens in 10 s was a kick)
		const opener = s.join(newUser(), "shopOpener");
		for (let i = 0; i < 60; i++) {
			s.shop(opener, { kind: "viewShop", screen: 0 });
			s.run(1 / 6);
		}
		check(!opener.kicked, "opening the shop 60 times in 10 s is no flood: viewShop is not a malformed ShopAction");

		// the admin remote, from somebody who is not an admin: every call is a malformed one
		const intruder = s.join(newUser(), "notAnAdmin");
		for (let i = 0; i <= CFG.FLOOD_MALFORMED; i++)
			admin.FindFirstChild("AdminRequest").OnServerInvoke(intruder, { kind: "kick" });
		check(intruder.kicked, `${CFG.FLOOD_MALFORMED + 1} admin requests from a non-admin are a flood kick`);
		const acker = s.join(newUser(), "ackStorm");
		for (let i = 0; i <= CFG.FLOOD_MALFORMED; i++)
			admin.FindFirstChild("AdminPatchAck").OnServerEvent.Fire(acker, "x");
		check(acker.kicked, "and malformed AdminPatchAcks too");

		// a rejected report is answered at most once a second: a stale-token storm is not reflected one for one. The
		// newest one inside the second is not dropped either: it is answered when the second ends (the security review of
		// the net hardening, L5), so a client whose last report was refused always hears why
		const stale = s.join(newUser(), "staleSaver");
		const before = saveAcks(stale);
		for (let i = 0; i < 100; i++) fire("SaveRequest", stale, "not-the-token", "{}");
		const within = saveAcks(stale) - before;
		s.run(1.1);
		const held = saveAcks(stale) - before;
		s.run(3);
		const later = saveAcks(stale) - before;
		check(
			within === 1 && held === 2 && later === 2,
			"100 rejected reports in an instant: one SaveAck at once, and the newest when the second ends (once)",
			`${within}, then ${held}, then ${later}`,
		);
		check(!stale.kicked, "(100 messages is under the flood line: no kick)");

		// an honest client: 30 s of Input, time probes, a report every 10 s, a load, a few purchases -- never kicked
		const honest = s.join(newUser(), "honest");
		s.immortal.add(honest);
		s.enter(honest);
		const P = s.P;
		for (let t = 0; t < 30 * 60; t++) {
			s.walk(honest, (t / 60) % (2 * Math.PI));
			if (t % 30 === 0) fire("TimeSync", honest, P.encodeTimePing({ seq: t % 65536, clientTime: 0 }));
			if (t % 600 === 0) s.report(honest, {});
			if (t % 900 === 0) fire("LoadRequest", honest);
			if (t % 400 === 0) s.shop(honest, { kind: "buyPack", packId: 0 });
			s.beat();
		}
		check(
			!honest.kicked,
			"an honest client over 30 s (Input 60/s, probes, reports, a load, purchases) is never kicked",
		);

		// L4: each automatic kick is in the admin audit log, by UserId only, with the reason the server wrote
		s.shutdown();
		const doc = fakeStore(ADMIN_LOG_STORE).data.get(LOG.auditKey(os.time(), globalThis.game.JobId)) ?? [];
		const kicks = doc.filter(e => e.action === "auto:flood");
		const kicked = [junk, loader, shopper, buyer, intruder, acker];
		check(
			kicked.every(p => kicks.some(e => e.targetId === p.UserId && e.adminId === 0 && e.ok === true)),
			"every flood kick is in the stored audit log (adminId 0 = the server), once per player",
			JSON.stringify(kicks.map(e => [e.targetId, e.details])),
		);
		check(kicks.length === kicked.length, "one entry per kick", `${kicks.length}`);
		const json = JSON.stringify(kicks);
		check(
			!/junkSaver|loadStorm|shopStorm|buyStorm|notAnAdmin|ackStorm/.test(json),
			"with UserIds only: no name is stored",
			json,
		);

		// L6 (the security review of the net hardening): an automatic entry is cheap to cause, so it trims like a tool
		// entry and repeats collapse per UserId -- a flood of kicks never pushes an admin's action out of the key
		const entry = (action, targetId, t) => ({
			t,
			adminId: action.startsWith("auto:") ? 0 : 42,
			action,
			targetId,
			target: "",
			details: "",
			ok: true,
		});
		const actions = [];
		for (let i = 0; i < LOG.AUDIT_PER_KEY; i++) actions.push(entry("kick", 9000 + i, i));
		const storm = [];
		for (let i = 0; i < 400; i++) storm.push(entry("auto:flood", 1 + (i % 3), 1000 + i));
		const after = LOG.appendAudit(actions, storm);
		check(
			after.filter(e => e.action === "kick").length === LOG.AUDIT_PER_KEY,
			`${storm.length} automatic kicks on a full key push out no admin's kick`,
			`${after.filter(e => e.action === "kick").length} kicks left`,
		);
		const repeats = LOG.appendAudit([], storm);
		check(
			repeats.length === 3 && repeats.every(e => e.t >= 1000 + 400 - 3),
			"and the same UserId kicked again and again is one line: the newest",
			`${repeats.length} lines`,
		);
	},
);

// ================================================================ 31: the ping of a survivor waiting in the lobby

section(
	"31) the rewind ceiling's ping stays while its survivor waits in the lobby, and goes with the body (S3 NIT 3)",
	() => {
		/*
		 * The simulation keeps each survivor's filtered ping across a leave/enter (ServerSimulation.setPing), so a link
		 * throttled at the moment of re-entry does not set the rewind ceiling at once (the review of dee095a, N4). It went
		 * KEEP_AFTER_LEAVE_S after its last SAMPLE -- and nothing samples a survivor in the lobby, whose body life.ts keeps
		 * for as long as they are connected: five minutes there, and the first sample of the next entry was taken raw.
		 */
		const { KEEP_AFTER_LEAVE_S } = require(join(SRC, "server/sim/life.ts"));
		const s = bootServer();
		const p = s.join(newUser(), "waiter");
		s.immortal.add(p);
		p.GetNetworkPing = () => 0.05;
		s.enter(p);
		s.run(5);
		s.exit(p);
		// six minutes in the lobby, connected the whole time. A heartbeat at 30 Hz owes 2 ticks and pays both (§3.1):
		// a slower one drops the surplus, and six real minutes would be two of ticks -- inside the old sample window
		s.run(KEEP_AFTER_LEAVE_S + 60, 1 / 30);
		check(s.sim.pings.has(p.UserId), "after six minutes in the lobby the server still has the survivor's ping");
		// back in, on a link throttled for the occasion
		p.GetNetworkPing = () => 0.3;
		const sp = s.enter(p);
		s.run(1.1);
		const ping = sp === undefined ? -1 : s.sim.combat.pingOf(sp.slot);
		check(
			ping > 0 && ping < 0.15,
			"the re-entry's 300 ms sample moves the rewind ceiling a tenth of the way, not all of it",
			`${(ping * 1000).toFixed(0)} ms`,
		);
		// the body's memory is the ping's: gone from the server for KEEP_AFTER_LEAVE_S, both go
		s.quit(p);
		s.run(KEEP_AFTER_LEAVE_S + 5, 1 / 10);
		check(
			!s.sim.pings.has(p.UserId),
			"KEEP_AFTER_LEAVE_S after they left the server, the body and its ping are gone",
		);
	},
);

// ================================================================ 32: SAV-01, saving is automatic

section("32) SAV-01: no client-chosen write, coalesced event saves, the budget floor, and the player told", () => {
	const Cad = require(join(SRC, "server/save/saveCadence.ts"));
	const { expMaxInit } = require(join(SRC, "shared/game/save.ts"));
	/** the save store (stores.ts reads the fake game, so only once a server has booted) */
	let store;
	/** the clock of every save write of `userId` from now on (answers the list, and the undo) */
	const watch = userId => {
		store = fakeStore(require(join(SRC, "server/save/stores.ts")).SAVE_STORE);
		const times = [];
		const original = store.UpdateAsync;
		store.UpdateAsync = (k, transform) => {
			if (k === String(userId)) times.push(clockNow);
			return original(k, transform);
		};
		return [times, () => (store.UpdateAsync = original)];
	};
	const netOf = srv => srv.env.services.ReplicatedStorage.FindFirstChild("Net");
	/** what the player was told about the writes of their save, in order */
	const told = (srv, p) =>
		netOf(srv)
			.FindFirstChild("SaveAck")
			.sent.filter(e => e.to === p && e.args[0]?.store !== undefined)
			.map(e => e.args[0].store);
	/** one level for this survivor, credited by the server exactly as combat does */
	let killId = 930000;
	const levelUp = (srv, sp) => srv.sim.progress.zombieKilled(++killId, expMaxInit(sp.save.level), sp.slot, 0);
	const gaps = times => times.slice(1).map((t, i) => t - times[i]);

	// (a) the client cannot pick the moment of a write: a minute of reports, every one a different state
	{
		const srv = bootWithAutosave();
		const u = newUser();
		const p = srv.join(u, "reporter");
		const [times, undo] = watch(u);
		try {
			for (let i = 1; i <= 12; i++) {
				srv.report(p, { settings: { ...srv.save(p).settings, bgm: i / 20 } });
				srv.run(5, 0.25);
			}
			check(
				times.length === 0,
				"a minute of progress reports (12, each a new state) writes the DataStore not once",
				`${times.length} write(s)`,
			);
			const remotes = netOf(srv)
				.GetChildren()
				.map(r => r.Name);
			check(
				remotes
					.filter(n => /save/i.test(n))
					.sort()
					.join(",") === "SaveAck,SaveRequest",
				"…and no remote asks for a write: SaveRequest is the progress report, SaveAck its answer",
				remotes.join(","),
			);
			srv.autosave();
			check(
				times.length === 1 && srv.stored(u)?.settings?.bgm === srv.save(p).settings.bgm,
				"…the next autosave carries them: one write, with the last report's settings",
				`${times.length} write(s), bgm ${srv.stored(u)?.settings?.bgm}`,
			);
		} finally {
			undo();
		}
	}

	// (b) coalescing: ten levels in five seconds
	{
		const srv = bootServer();
		const u = newUser();
		const p = srv.join(u, "climber");
		srv.immortal.add(p);
		const sp = srv.enter(p);
		// the load's own write (it took the lock) is more than a gap ago
		srv.run(Cad.EVENT_SAVE_GAP + 1, 0.25);
		const [times, undo] = watch(u);
		const t0 = clockNow;
		try {
			for (let i = 0; i < 10; i++) {
				levelUp(srv, sp);
				srv.run(0.5, 0.25);
			}
			const inBurst = times.filter(t => t <= t0 + 5).length;
			const first = times[0] === undefined ? undefined : times[0] - t0;
			srv.run(Cad.EVENT_SAVE_GAP + 10, 0.25);
			check(
				inBurst === 1,
				`10 level-ups in 5 s: ONE write inside the burst, ${Cad.EVENT_SAVE_DELAY} s after the first (the rest ride with it)`,
				`${inBurst} write(s) in the burst, the first ${first?.toFixed(2)} s in`,
			);
			check(
				times.length === 2 && gaps(times).every(g => g >= Cad.EVENT_SAVE_GAP),
				`…and ONE more for what came after it, no sooner than ${Cad.EVENT_SAVE_GAP} s later: 2 writes for 10 events`,
				`${times.length} write(s), gaps ${gaps(times)
					.map(g => g.toFixed(1))
					.join(", ")} s`,
			);
			check(
				srv.stored(u)?.level === sp.save.level && sp.save.level === 11,
				"…and the DataStore holds the last level",
				`stored ${srv.stored(u)?.level}, live ${sp.save.level}`,
			);
			check(
				JSON.stringify(told(srv, p)) === '["saving","saved","saving","saved"]',
				'…and the player was told each write: "saving", then "saved" when it landed',
				JSON.stringify(told(srv, p)),
			);

			// a purchase, a gap after the last write: on the DataStore within the delay
			srv.run(Cad.EVENT_SAVE_GAP, 0.25);
			sp.save.money += 500;
			const bought = clockNow;
			const res = srv.shop(p, { kind: "buyPack", packId: 0 });
			srv.run(Cad.EVENT_SAVE_DELAY + 1.5, 0.25);
			const after = times.filter(t => t > bought);
			check(
				res?.ok === true && after.length === 1 && after[0] - bought <= Cad.EVENT_SAVE_DELAY + 1.01,
				`a purchase is written ${Cad.EVENT_SAVE_DELAY} s later (the scan's second at most on top)`,
				`${JSON.stringify(res?.reason ?? res?.ok)}, ${after.map(t => (t - bought).toFixed(2)).join(", ")} s`,
			);
			check(
				srv.stored(u)?.packsBought[0] === sp.save.packsBought[0] && srv.stored(u)?.money === sp.save.money,
				"…with the pack and the coins it cost, together",
			);

			// a death, then a leave one second after the write it caused: the final save never waits for the gap
			srv.run(Cad.EVENT_SAVE_GAP, 0.25);
			srv.immortal.delete(p);
			const died = clockNow;
			srv.kill(p);
			srv.run(Cad.EVENT_SAVE_DELAY + 1.5, 0.25);
			const deathWrite = times.filter(t => t > died);
			check(
				deathWrite.length === 1 && srv.stored(u)?.runOver === true,
				"a death is on the DataStore within the delay (runOver, the body)",
				`${deathWrite.length} write(s), runOver ${srv.stored(u)?.runOver}`,
			);
			sp.save.money += 3;
			const left = clockNow;
			srv.quit(p);
			check(
				times.filter(t => t >= left).length === 1 && srv.stored(u)?.money === sp.save.money && lockFree(u),
				"…and a leave a moment later writes at once, gap or not, and releases the lock",
				`money ${srv.stored(u)?.money} of ${sp.save.money}`,
			);
		} finally {
			undo();
		}
	}

	// (c) nothing new, nothing written: a report of the very save the server has, then the autosave
	{
		const srv = bootWithAutosave();
		const u = newUser();
		const p = srv.join(u, "idle");
		srv.autosave();
		const [times, undo] = watch(u);
		const toldBefore = told(srv, p).length;
		try {
			srv.report(p, {});
			srv.autosave();
			check(
				times.length === 0,
				"a report that changes nothing makes the session dirty, and the autosave writes nothing (same JSON)",
				`${times.length} write(s)`,
			);
			clockNow += 150;
			srv.autosave();
			check(times.length === 1, "…until the lock wants its refresh (LOCK_REFRESH): then it is rewritten");
			check(
				toldBefore === 2 && told(srv, p).length === toldBefore,
				"…and the player hears only of the write that carried progress (the first), not of a refresh",
				JSON.stringify(told(srv, p)),
			);
		} finally {
			undo();
		}
	}

	// (d) the budget floor: an event save waits while the server's UpdateAsync budget is low
	{
		const srv = bootServer();
		const DSS = srv.env.services.DataStoreService;
		const u = newUser();
		const p = srv.join(u, "patient");
		srv.immortal.add(p);
		const sp = srv.enter(p);
		srv.run(Cad.EVENT_SAVE_GAP + 1, 0.25);
		const [times, undo] = watch(u);
		const budget = DSS.GetRequestBudgetForRequestType;
		try {
			DSS.GetRequestBudgetForRequestType = () => Cad.EVENT_SAVE_MIN_BUDGET - 1;
			levelUp(srv, sp);
			srv.run(30, 0.25);
			check(
				times.length === 0,
				`an event save never runs under EVENT_SAVE_MIN_BUDGET (${Cad.EVENT_SAVE_MIN_BUDGET}): 30 s at ${Cad.EVENT_SAVE_MIN_BUDGET - 1}, no write`,
				`${times.length} write(s)`,
			);
			DSS.GetRequestBudgetForRequestType = budget;
			srv.run(1.5, 0.25);
			check(
				times.length === 1 && srv.stored(u)?.level === sp.save.level,
				"…it waited, it was not dropped: the budget back, it runs within the next scan",
				`${times.length} write(s), stored level ${srv.stored(u)?.level}`,
			);
		} finally {
			DSS.GetRequestBudgetForRequestType = budget;
			undo();
		}
	}

	// (e) an outage (review M1): every write fails for three minutes while the save keeps changing. A write that is not the
	// last makes ONE attempt, and the next waits 15, 30, then 60 s; the player is told once; the first to land says so
	{
		const srv = bootServer();
		const u = newUser();
		const p = srv.join(u, "unlucky");
		srv.immortal.add(p);
		const sp = srv.enter(p);
		srv.run(Cad.EVENT_SAVE_GAP + 1, 0.25);
		const [times, undo] = watch(u);
		try {
			store.fail.update = 1e9;
			let waited = 0;
			// a level every 10 s: each one an event, for the whole outage
			for (let i = 0; i < 18; i++) {
				levelUp(srv, sp);
				waited += waitedDuring(() => srv.run(10, 0.25));
			}
			const g = gaps(times);
			const expected = [15, 30, 60, 60];
			check(
				times.length === 5 && expected.every((e, i) => g[i] >= e - 0.01 && g[i] <= e + 1.01),
				"an outage of 3 min, 18 levels: 5 attempts, backing off 15, 30, 60, 60 s (the autosave's retries cost 4 a minute)",
				`${times.length} attempts, gaps ${g.map(x => x.toFixed(1)).join(", ")} s`,
			);
			check(
				waited === 0,
				"…each one a single UpdateAsync: no retry sleeps inside the writing window (the cadence retries)",
				`${waited} s waited`,
			);
			check(
				JSON.stringify(told(srv, p)) === '["saving","failing"]',
				'…and the player was told ONCE: "Progress not saved — retrying" stays up, no flicker back to "Saving..."',
				JSON.stringify(told(srv, p)),
			);
			store.fail.update = 0;
			const back = clockNow;
			srv.run(Cad.AUTOSAVE_INTERVAL + 2, 0.25);
			const landed = times.filter(t => t > back);
			check(
				landed.length === 1 && srv.stored(u)?.level === sp.save.level,
				"…the DataStore back, the next attempt (at most a minute later) lands with every level of the outage",
				`${landed.length} write(s), stored level ${srv.stored(u)?.level} of ${sp.save.level}`,
			);
			check(
				JSON.stringify(told(srv, p)) === '["saving","failing","saved"]',
				'…and the red chip turns into "saved"',
				JSON.stringify(told(srv, p)),
			);
			// the back-off is over: the next event is served at the ordinary gap again
			srv.run(Cad.EVENT_SAVE_GAP, 0.25);
			const next = clockNow;
			levelUp(srv, sp);
			srv.run(Cad.EVENT_SAVE_DELAY + 1.5, 0.25);
			check(
				times.filter(t => t > next).length === 1,
				`…and once one lands the back-off is forgotten: the next level is written ${Cad.EVENT_SAVE_DELAY} s later`,
			);
		} finally {
			store.fail.update = 0;
			undo();
		}
	}

	// (e2) the final write keeps its retries (it gets no other try): an outage that ends on the third attempt of a leave
	{
		const srv = bootServer();
		const u = newUser();
		const p = srv.join(u, "leaver");
		srv.save(p).money += 77;
		const [times, undo] = watch(u);
		let waited = 0;
		try {
			store.fail.update = 2;
			waited = waitedDuring(() => srv.quit(p));
		} finally {
			store.fail.update = 0;
			undo();
		}
		check(
			times.length === 3 && waited >= 3 && srv.stored(u)?.money === srv.save(p).money && lockFree(u),
			"the leave's write retries in place (1 s, 2 s): the third attempt lands and releases the lock",
			`${times.length} attempts, ${waited} s of retries`,
		);
	}

	// (e3) a save that cannot be encoded (review L1): the attempt counts -- it backs off like a failed write instead of
	// being asked for again at every scan -- and the player is told once
	{
		const srv = bootServer();
		const u = newUser();
		const p = srv.join(u, "unencodable");
		srv.immortal.add(p);
		const sp = srv.enter(p);
		srv.run(Cad.EVENT_SAVE_GAP + 1, 0.25);
		const http = srv.env.services.HttpService;
		const encode = http.JSONEncode;
		let broken = true;
		let tries = 0;
		http.JSONEncode = v => {
			if (broken && v === sp.save) {
				tries += 1;
				throw new Error("injected: JSONEncode failed");
			}
			return encode(v);
		};
		try {
			warnsDuring(() => {
				levelUp(srv, sp);
				srv.run(60, 0.25);
			});
			check(
				tries === 3,
				"a save the engine cannot encode is tried 3 times in a minute (at 0, 15 and 45 s), not once a second",
				`${tries} attempts`,
			);
			check(
				JSON.stringify(told(srv, p)) === '["failing"]',
				'…and the player is told once: "Progress not saved — retrying"',
				JSON.stringify(told(srv, p)),
			);
			broken = false;
			srv.run(Cad.AUTOSAVE_INTERVAL + 2, 0.25);
			check(
				srv.stored(u)?.level === sp.save.level && told(srv, p).at(-1) === "saved",
				"…and when it can be encoded again it lands, and says so",
				`stored level ${srv.stored(u)?.level}, told ${JSON.stringify(told(srv, p))}`,
			);
		} finally {
			http.JSONEncode = encode;
		}
	}

	// (e4) a save too large to store (review L1): no UpdateAsync is spent on it, the attempts back off, the player is told
	{
		const srv = bootServer();
		const u = newUser();
		const p = srv.join(u, "hoarder");
		srv.immortal.add(p);
		const sp = srv.enter(p);
		srv.run(Cad.EVENT_SAVE_GAP + 1, 0.25);
		const http = srv.env.services.HttpService;
		const encode = http.JSONEncode;
		let huge = true;
		let tries = 0;
		const big = "x".repeat(3_900_001);
		http.JSONEncode = v => {
			if (huge && v === sp.save) {
				tries += 1;
				return big;
			}
			return encode(v);
		};
		const [times, undo] = watch(u);
		try {
			warnsDuring(() => {
				levelUp(srv, sp);
				srv.run(60, 0.25);
			});
			check(
				times.length === 0 && tries === 3 && JSON.stringify(told(srv, p)) === '["failing"]',
				"a save too large to store: no UpdateAsync, 3 attempts in a minute (backing off), and the player told once",
				`${times.length} writes, ${tries} attempts, told ${JSON.stringify(told(srv, p))}`,
			);
		} finally {
			http.JSONEncode = encode;
			huge = false;
			undo();
		}
	}

	// (e5) a failed write, then the live save goes back to exactly what landed (review L2): nothing is left to write, and
	// the chip must not stay red for good -- the player is told "saved"
	{
		const srv = bootWithAutosave();
		const u = newUser();
		const p = srv.join(u, "undecided");
		srv.autosave();
		const bgm0 = srv.save(p).settings.bgm;
		srv.report(p, { settings: { ...srv.save(p).settings, bgm: 0.77 } });
		const [times, undo] = watch(u);
		try {
			store.fail.update = 1;
			srv.autosave();
			store.fail.update = 0;
			const failed = told(srv, p).at(-1);
			srv.run(11, 0.25);
			srv.report(p, { settings: { ...srv.save(p).settings, bgm: bgm0 } });
			srv.run(Cad.EVENT_SAVE_GAP + 2, 0.25);
			check(
				failed === "failing" && times.length === 1 && told(srv, p).at(-1) === "saved",
				'the settings put back as they were stored: no write, and "Progress not saved" becomes "saved"',
				`${times.length} attempt(s), told ${JSON.stringify(told(srv, p))}, stored bgm ${srv.stored(u)?.settings?.bgm}`,
			);
		} finally {
			store.fail.update = 0;
			undo();
		}
	}

	// (e6) a notice that cannot be sent (review L3: FireClient throws, a Player being torn down) never costs a write
	{
		const srv = bootServer();
		const u = newUser();
		const p = srv.join(u, "unreachable");
		srv.immortal.add(p);
		const sp = srv.enter(p);
		srv.run(Cad.EVENT_SAVE_GAP + 1, 0.25);
		const ack = netOf(srv).FindFirstChild("SaveAck");
		const fire = ack.FireClient;
		ack.FireClient = function (player, payload) {
			if (payload?.store !== undefined) throw new Error("injected: FireClient failed");
			return fire.call(this, player, payload);
		};
		const http = srv.env.services.HttpService;
		const encode = http.JSONEncode;
		let breakNext = false;
		http.JSONEncode = v => {
			if (breakNext && v === sp.save) {
				breakNext = false;
				throw new Error("injected: JSONEncode failed");
			}
			return encode(v);
		};
		try {
			const died = asRoblox(() =>
				warnsDuring(() => {
					// a write whose notices cannot be sent, then one that throws (its "failing" cannot be sent either)
					levelUp(srv, sp);
					srv.run(Cad.EVENT_SAVE_DELAY + 1.5, 0.25);
					const first = srv.stored(u)?.level === sp.save.level;
					breakNext = true;
					levelUp(srv, sp);
					srv.run(Cad.EVENT_SAVE_GAP + 2, 0.25);
					levelUp(srv, sp);
					srv.run(Cad.EVENT_SAVE_GAP * 2 + 2, 0.25);
					check(
						first && !breakNext && srv.stored(u)?.level === sp.save.level,
						"notices that throw: the writes still land, and a throwing one does not keep `writing` up",
						`stored level ${srv.stored(u)?.level} of ${sp.save.level}`,
					);
				}),
			);
			check(died.length === 0, "…and no thread died of it", died.join(" | "));
		} finally {
			ack.FireClient = fire;
			http.JSONEncode = encode;
		}
	}

	// (e7) the lock's refresh of a session that changed nothing is silent (review L6): a returning player idles
	{
		const u = newUser();
		{
			const first = bootServer();
			first.quit(first.join(u, "idler"));
		}
		const srv = bootWithAutosave();
		const p = srv.join(u, "idler");
		const [times, undo] = watch(u);
		try {
			clockNow += 150;
			srv.autosave();
			check(
				times.length === 1 && told(srv, p).length === 0,
				"a returning player who changed nothing: the lock refresh writes, and the player hears nothing of it",
				`${times.length} write(s), told ${JSON.stringify(told(srv, p))}`,
			);
		} finally {
			undo();
		}
	}

	// (f) another server took the lock: this one never writes again, and says so
	{
		const srv = bootServer();
		const u = newUser();
		const p = srv.join(u, "elsewhere");
		srv.immortal.add(p);
		const sp = srv.enter(p);
		srv.run(Cad.EVENT_SAVE_GAP + 1, 0.25);
		const doc = store.data.get(String(u));
		doc.lock = { job: "another-server", sid: "their-session", t: Math.floor(1_700_000_000 + clockNow) };
		store.data.set(String(u), doc);
		levelUp(srv, sp);
		srv.run(Cad.EVENT_SAVE_DELAY + 1.5, 0.25);
		const said = told(srv, p);
		check(
			said[said.length - 1] === "stopped" && store.data.get(String(u)).lock.job === "another-server",
			'a server that lost the lock tells the player "stopped" (Progress not saved) and writes nothing over the other',
			JSON.stringify(said),
		);
		const [times, undo] = watch(u);
		try {
			levelUp(srv, sp);
			srv.run(Cad.EVENT_SAVE_GAP + 5, 0.25);
			check(times.length === 0, "…and no event save tries again from here", `${times.length} write(s)`);
		} finally {
			undo();
		}
	}
});

// ================================================================ 33: the first frame is the server's

/**
 * The client of one player, as client/net/netClient.ts and client/gameLoop.ts run it, on the packets the REAL server sent
 * it (Snap and World, `oneWay` seconds later): the handshake (InitBegin, its own PlayerJoined), the bind, the reconcile of
 * every self block, the prediction, the entry hold (client/net/entryHold.ts) and the camera. `guess` is where
 * `GameLoop.init` put the survivor before the server said anything (its own street near the centre). `hold: false` plays
 * the client as it was before the hold (for the "before" numbers): drawn from the first frame, the camera eased.
 */
function entryClient(s, p, guess, { hold = true, oneWay = 0.04 } = {}) {
	const P = s.P;
	const { ClockSync } = require(join(SRC, "client/net/clockSync.ts"));
	const { CommandStream } = require(join(SRC, "client/net/commands.ts"));
	const { Prediction } = require(join(SRC, "client/net/prediction.ts"));
	const { SnapshotBuffer } = require(join(SRC, "client/net/snapshotBuffer.ts"));
	const { Camera } = require(join(SRC, "shared/engine/camera.ts"));
	const { createPlayer } = require(join(SRC, "shared/game/player.ts"));
	const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
	let EntryHold;
	try {
		EntryHold = require(join(SRC, "client/net/entryHold.ts")).EntryHold;
	} catch {
		EntryHold = undefined; // an older src: no hold at all
	}
	const save = defaultSave();
	const player = createPlayer(save, guess.x, guess.y);
	const cam = new Camera();
	cam.setView(1920, 1080);
	cam.x = guess.x;
	cam.y = guess.y;
	const gate = hold && EntryHold !== undefined ? new EntryHold() : undefined;
	gate?.begin(true, 0);
	const c = {
		clock: new ClockSync(),
		commands: new CommandStream(),
		prediction: new Prediction(),
		snapshots: new SnapshotBuffer(),
		inbox: [],
		queue: [],
		hasEpoch: false,
		mySlot: -1,
		bound: false,
		lastSelfTick: -Infinity,
		raw: { moveX: 0, moveY: 0, magnitude: 0, aim: 0, held: 0 },
		sampled: [],
		player,
		cam,
		/** every frame the run drew: where the survivor and the camera were */
		drawn: [],
		held: 0,
		/** after each server beat: what the server sent since (`drive` drains the remotes once for every client) */
		collect(snaps, worlds) {
			for (const e of snaps) {
				if (e.to === p) c.inbox.push({ at: clockNow + oneWay, kind: "snap", payload: e.args[0] });
			}
			for (const e of worlds) {
				if (e.to === undefined || e.to === p)
					c.inbox.push({ at: clockNow + oneWay, kind: "world", payload: e.args[0] });
			}
		},
		/** one client frame at `clockNow` */
		frame(dt) {
			const due = c.inbox.filter(m => m.at <= clockNow);
			c.inbox = c.inbox.filter(m => m.at > clockNow);
			for (const m of due) {
				if (m.kind === "snap") {
					const part = P.decodeSnapshotPart(m.payload);
					if (part !== undefined) c.queue.push(part);
					continue;
				}
				const batch = P.decodeWorld(m.payload);
				if (batch === undefined) continue;
				for (const ev of batch.events) {
					if (ev.t === P.WorldEv.InitBegin) {
						c.clock.setEpoch(ev.tick0Time, ev.simHz);
						c.snapshots.setRate(ev.simHz);
						c.hasEpoch = true;
					} else if (ev.t === P.WorldEv.PlayerJoined && ev.userId === p.UserId) {
						c.mySlot = ev.slot;
					} else if (ev.t === P.WorldEv.PlayerLife && ev.slot === c.mySlot) {
						player.dead = ev.state === P.LifeState.Dead;
					}
				}
			}
			const active = c.hasEpoch && c.mySlot >= 0;
			if (active) {
				if (!c.bound) {
					// netClient `bind`: the prediction takes the survivor where the loop put it
					c.bound = true;
					c.prediction.attach(s.host.world, player, save);
					c.commands.reset();
					c.snapshots.reset();
				}
				const tick = c.clock.update(dt, clockNow);
				const refTick = c.clock.tickNow();
				for (const part of c.queue) {
					const pt = unwrap(P, part.tick, refTick);
					c.snapshots.receive(part, refTick, clockNow);
					const block = part.self;
					if (block === undefined || pt <= c.lastSelfTick) continue;
					c.lastSelfTick = pt;
					c.commands.ack(block.ackSeq);
					c.prediction.reconcile(block, c.commands.unacked(), clockNow);
				}
				c.queue.length = 0;
				c.sampled.length = 0;
				c.commands.sample(dt, c.raw, c.sampled);
				for (const cmd of c.sampled) c.prediction.step(cmd);
				c.snapshots.advance(dt, tick, clockNow, s.host.world);
				c.prediction.present(dt, c.commands.phase(), c.commands.newest());
			}
			// client/gameLoop.ts: the entry hold, then the camera (cut or eased)
			const placed = active && (c.prediction.placed?.() ?? true);
			const snaps = c.prediction.snapCount?.() ?? 0;
			if (gate !== undefined) {
				if (gate.frame(dt, placed, snaps)) {
					cam.x = player.x;
					cam.y = player.y;
				} else if (!gate.holding()) cam.follow(player.x, player.y, Math.min(1, dt * 8));
			} else cam.follow(player.x, player.y, Math.min(1, dt * 8));
			if (gate?.holding() === true) {
				c.held += 1;
				return;
			}
			c.drawn.push({ t: clockNow, x: player.x, y: player.y, cx: cam.x, cy: cam.y });
		},
	};
	return c;
}

/** a u16 wire tick unwrapped next to a reference tick (shared/net/codec.ts `unwrapTick`) */
function unwrap(P, tick16, ref) {
	const codec = require(join(SRC, "shared/net/codec.ts"));
	return codec.unwrapTick(tick16, Math.floor(ref));
}

/** the server's heartbeats and the client's frames side by side, at 60 Hz both */
function drive(s, clients, seconds) {
	const net = s.env.services.ReplicatedStorage.FindFirstChild("Net");
	const snapRemote = net.FindFirstChild(s.P.REMOTE_SNAP);
	const worldRemote = net.FindFirstChild(s.P.REMOTE_WORLD);
	const n = Math.round(seconds * 60);
	for (let i = 0; i < n; i++) {
		s.beat();
		const snaps = snapRemote.sent.splice(0);
		const worlds = worldRemote.sent.splice(0);
		for (const c of clients) {
			c.collect(snaps, worlds);
			c.frame(1 / 60);
		}
	}
}

/** the first `n` drawn frames against the server's spot: the worst distance of the survivor and of the camera */
function firstFrames(c, at, n = 30) {
	const frames = c.drawn.slice(0, n);
	let body = 0;
	let camera = 0;
	for (const f of frames) {
		body = Math.max(body, Math.hypot(f.x - at.x, f.y - at.y));
		camera = Math.max(camera, Math.hypot(f.cx - at.x, f.cy - at.y));
	}
	return { frames: frames.length, body, camera, first: frames[0] };
}

section("33) the first frame of a run is drawn where the server put the survivor (entry hold, the camera cut)", () => {
	const s = bootServer();
	// the client's own guess (GameLoop.findSpawnPoint: a street near the centre), far from wherever the server puts us
	const guessFor = sp => ({ x: sp.state.x + 900, y: sp.state.y - 500 });
	const EPS = 1;
	const N = 30;

	// (a) a fresh body at the server's safe spawn, (b) a kept one back where it left, (c) a corpse where it fell
	const cases = [];
	{
		const a = s.join(newUser(), "fresh");
		s.immortal.add(a);
		s.intent(a, s.P.IntentKind.EnterWorld);
		// the client starts drawing the moment it asks (mountRun): its guess is where the server will NOT put it
		const probe = { x: 0, y: 0 };
		const ca = entryClient(s, a, probe);
		const cb = entryClient(s, a, probe, { hold: false });
		// the guess is only known relative to the spawn once the server chose it: re-seat both clients' guess then (the
		// admission's welcome and snapshots wait in the remotes meanwhile, as if they had taken that long to arrive)
		s.run(0.6);
		const sp = s.body(a);
		const g = guessFor(sp);
		for (const c of [ca, cb]) {
			c.player.x = g.x;
			c.player.y = g.y;
			c.cam.x = g.x;
			c.cam.y = g.y;
		}
		// the welcome went out with the admission: hand it to both clients as it is still in the remotes
		drive(s, [ca, cb], 1.2);
		cases.push({ name: "(a) a fresh body", at: { x: sp.state.x, y: sp.state.y }, hold: ca, before: cb });
	}
	{
		const b = s.join(newUser(), "kept");
		s.immortal.add(b);
		s.enter(b);
		for (let i = 0; i < 90; i++) {
			s.walk(b, 0.3);
			s.beat();
		}
		s.exit(b);
		s.run(1.2);
		const kept = s.host.lives.keptBody(b.UserId);
		const g = { x: (kept?.x ?? 0) - 700, y: (kept?.y ?? 0) + 400 };
		// drop what the first stay sent: this client is a new run
		s.env.services.ReplicatedStorage.FindFirstChild("Net").FindFirstChild(s.P.REMOTE_SNAP).sent.length = 0;
		s.env.services.ReplicatedStorage.FindFirstChild("Net").FindFirstChild(s.P.REMOTE_WORLD).sent.length = 0;
		const cb = entryClient(s, b, g);
		const cbOld = entryClient(s, b, g, { hold: false });
		s.intent(b, s.P.IntentKind.EnterWorld);
		drive(s, [cb, cbOld], 1.8);
		const sp = s.body(b);
		cases.push({ name: "(b) a kept body", at: { x: sp.state.x, y: sp.state.y }, hold: cb, before: cbOld });
	}
	{
		const d = s.join(newUser(), "corpse");
		s.enter(d);
		const sp0 = s.kill(d);
		const where = { x: sp0.state.x, y: sp0.state.y };
		s.exit(d);
		s.run(1.2);
		s.env.services.ReplicatedStorage.FindFirstChild("Net").FindFirstChild(s.P.REMOTE_SNAP).sent.length = 0;
		s.env.services.ReplicatedStorage.FindFirstChild("Net").FindFirstChild(s.P.REMOTE_WORLD).sent.length = 0;
		const g = { x: where.x + 650, y: where.y + 380 };
		const cd = entryClient(s, d, g);
		const cdOld = entryClient(s, d, g, { hold: false });
		s.intent(d, s.P.IntentKind.EnterWorld);
		drive(s, [cd, cdOld], 1.8);
		cases.push({ name: "(c) a corpse waiting for daybreak", at: where, hold: cd, before: cdOld });
	}

	for (const k of cases) {
		const now = firstFrames(k.hold, k.at, N);
		const old = firstFrames(k.before, k.at, N);
		const settle = k.before.drawn.findIndex(f => Math.hypot(f.cx - k.at.x, f.cy - k.at.y) <= 8);
		const wrong = k.before.drawn.filter(f => Math.hypot(f.x - k.at.x, f.y - k.at.y) > EPS).length;
		info(
			`${k.name}: before the hold the first frame was drawn ${f1(old.first ? Math.hypot(old.first.x - k.at.x, old.first.y - k.at.y) : NaN)} u ` +
				`from the server's spot (${wrong} frame(s) drew the survivor elsewhere), the camera ${f1(old.camera)} u off at worst ` +
				`in the first ${N} frames and within 8 u of it only from frame ${settle} (${Math.round((settle * 1000) / 60)} ms) on; ` +
				`now ${k.hold.held} frame(s) held (${Math.round((k.hold.held * 1000) / 60)} ms), then drawn there`,
		);
		check(
			now.frames === N && now.body <= EPS && now.camera <= EPS,
			`${k.name}: the first ${N} drawn frames are all at the server's spot (the survivor and the camera, ±${EPS} u)`,
			`${now.frames} frames; survivor ${f1(now.body)} u, camera ${f1(now.camera)} u off at worst`,
		);
		check(
			k.hold.held > 0 && k.hold.held <= 45,
			`${k.name}: …after holding a few frames (the welcome's trip, never the ${3} s give-up)`,
			`${k.hold.held} frame(s)`,
		);
	}

	// (d) daybreak stands the corpse up at a safe spot, in the world: the camera is CUT there, never panned across
	{
		const w = s.join(newUser(), "dawn");
		s.enter(w);
		s.env.services.ReplicatedStorage.FindFirstChild("Net").FindFirstChild(s.P.REMOTE_SNAP).sent.length = 0;
		s.env.services.ReplicatedStorage.FindFirstChild("Net").FindFirstChild(s.P.REMOTE_WORLD).sent.length = 0;
		const sp0 = s.body(w);
		const cw = entryClient(s, w, { x: sp0.state.x, y: sp0.state.y });
		const cwOld = entryClient(s, w, { x: sp0.state.x, y: sp0.state.y }, { hold: false });
		// the welcome of this entry already went out: seed the clients as a live session does (epoch + slot)
		for (const c of [cw, cwOld]) {
			c.clock.setEpoch(s.host.replicator.options?.tick0Time ?? 1000, 60);
			c.hasEpoch = true;
			c.mySlot = sp0.slot;
		}
		drive(s, [cw, cwOld], 0.5);
		s.nightLeft(1.5);
		s.kill(w);
		const corpse = { x: s.body(w).state.x, y: s.body(w).state.y };
		drive(s, [cw, cwOld], 2.5);
		const up = s.body(w);
		const spot = { x: up.state.x, y: up.state.y };
		drive(s, [cw, cwOld], 1.0);
		const moved = Math.hypot(spot.x - corpse.x, spot.y - corpse.y);
		const between = c => {
			let worst = 0;
			for (const f of c.drawn) {
				const off = Math.min(
					Math.hypot(f.cx - corpse.x, f.cy - corpse.y),
					Math.hypot(f.cx - spot.x, f.cy - spot.y),
				);
				worst = Math.max(worst, off);
			}
			return worst;
		};
		info(
			`(d) daybreak moved the body ${f1(moved)} u; before, the camera passed ${f1(between(cwOld))} u away from both ` +
				`spots on its way across; now ${f1(between(cw))} u`,
		);
		check(
			up.state.dead === false && moved > 64,
			"(d) the dead survivor stood up at daybreak somewhere else (the case being tested)",
			`dead ${up.state.dead}, moved ${f1(moved)} u`,
		);
		check(
			between(cw) <= 64,
			"(d) the camera is cut from the corpse to the new spot, never drawn panning across the town in between",
			`${f1(between(cw))} u off both spots at worst`,
		);
	}
});

// ================================================================ 34: nobody is the host

/*
 * "Suppose the server's main player (the first one to join) and then others join. That main player dies or leaves: does
 * the server die/stop working?" (the owner, 2026-09-24). The real server with the first player -- slot 0, the first
 * readable load, the owner of a private server -- leaving, dying, being replaced; what the others must keep: the tick,
 * their snapshots, the clock, the town, the horde and its night waves around THEM, the roster and the scoreboard, and a
 * world that ends only by MP-22's rule (tools/test-reset.mjs 19 has the world's end when everybody goes).
 */
section(
	"34) nobody is the host: the first player leaving, dying or being replaced changes nothing for the others",
	() => {
		const net = s => s.env.services.ReplicatedStorage.FindFirstChild("Net");
		const snapsTo = (s, p) =>
			net(s)
				.FindFirstChild(s.P.REMOTE_SNAP)
				.sent.filter(e => e.to === p).length;
		const clearSnaps = s => {
			net(s).FindFirstChild(s.P.REMOTE_SNAP).sent.length = 0;
		};
		const zombiesNear = (s, sp, r = 1600) =>
			s.sim.horde.zombies.filter(z => Math.hypot(z.x - sp.state.x, z.y - sp.state.y) <= r);
		/** the World events one client was sent (its own and the broadcast ones), decoded, in order */
		const worldTo = (s, p) => {
			const out = [];
			for (const e of net(s).FindFirstChild(s.P.REMOTE_WORLD).sent) {
				if (e.to !== undefined && e.to !== p) continue;
				const batch = s.P.decodeWorld(e.args[0]);
				if (batch !== undefined) for (const ev of batch.events) out.push(ev);
			}
			return out;
		};

		// (a) the first player leaves the server while the others play -- by day, and through a night's wave
		{
			const s = bootServer();
			const wipes = s.wipes();
			const a = s.join(newUser(), "first");
			const b = s.join(newUser(), "second");
			const c = s.join(newUser(), "third");
			for (const p of [a, b, c]) s.immortal.add(p);
			s.enter(a);
			s.enter(b);
			s.enter(c);
			check(
				s.body(a)?.slot === 0,
				"(a) the first player is in slot 0 (the case being tested)",
				`slot ${s.body(a)?.slot}`,
			);
			s.sim.clock.setClock(12, 3);
			s.run(2);
			const seed = s.host.seed;
			const tick0 = s.sim.tick;
			const hour0 = s.sim.clock.dayTime;
			s.quit(a);
			clearSnaps(s);
			// the horde the first player saw goes (a clean slate): what comes back is spawned around whoever is left
			s.sim.horde.zombies.length = 0;
			const spawned0 = s.sim.horde.population.spawned;
			s.run(20);
			const spB = s.body(b);
			const spC = s.body(c);
			check(
				s.sim.tick - tick0 >= 20 * 60 - 2 && s.sim.clock.dayTime > hour0 && s.host.seed === seed,
				"(a) the first leaves: the tick and the clock go on, in the same town",
				`${s.sim.tick - tick0} ticks in 20 s, ${f1(hour0)} h -> ${f1(s.sim.clock.dayTime)} h`,
			);
			check(
				snapsTo(s, a) === 0 && snapsTo(s, b) >= 350 && snapsTo(s, c) >= 350,
				"(a) …the others keep their snapshots (20 Hz), the one who left gets none",
				`first ${snapsTo(s, a)}, second ${snapsTo(s, b)}, third ${snapsTo(s, c)} parts`,
			);
			check(
				s.sim.horde.population.spawned > spawned0 &&
					zombiesNear(s, spB).length + zombiesNear(s, spC).length > 0,
				"(a) …the horde spawns again, around THEM",
				`${s.sim.horde.population.spawned - spawned0} spawned, ${zombiesNear(s, spB).length} near the second, ` +
					`${zombiesNear(s, spC).length} near the third`,
			);
			// the night's waves are the clock's and the clusters', not the first player's (the dusk's fill, as an admin forces it)
			s.sim.clock.fillNight();
			s.sim.clock.setClock(19.02, 3);
			s.run(15);
			const waves = s.sim.horde.zombies.filter(z => z.wave === true);
			check(
				waves.length > 0 &&
					waves.every(
						z =>
							Math.min(
								Math.hypot(z.x - spB.state.x, z.y - spB.state.y),
								Math.hypot(z.x - spC.state.x, z.y - spC.state.y),
							) <= 1650,
					),
				"(a) …and the night's wave comes for the two who stayed",
				`${waves.length} wave zombie(s) at ${f1(s.sim.clock.dayTime)} h`,
			);
			check(
				wipes.length === 0 && !spB.state.dead && !spC.state.dead,
				"(a) …with no world's end in sight",
				`wipes ${wipes.length}`,
			);
		}

		// (b) the first player dies and walks home while the other lives
		{
			const s = bootServer();
			const wipes = s.wipes();
			const a = s.join(newUser(), "first");
			const b = s.join(newUser(), "second");
			s.immortal.add(b);
			s.enter(a);
			s.enter(b);
			s.sim.clock.setClock(12, 3);
			s.kill(a);
			s.exit(a);
			const spawned0 = s.sim.horde.population.spawned;
			s.run(40, 0.25);
			const spB = s.body(b);
			check(
				wipes.length === 0 && !s.host.lives.wipeWindowOpen() && spB !== undefined && !spB.state.dead,
				"(b) the first dies and goes Home, the second lives: no window, no world's end (somebody is alive)",
				`wipes ${wipes.length}, window ${s.host.lives.wipeWindowOpen()}`,
			);
			check(
				s.sim.horde.population.spawned > spawned0 && zombiesNear(s, spB).length > 0,
				"(b) …the horde keeps coming for the one standing",
				`${s.sim.horde.population.spawned - spawned0} spawned, ${zombiesNear(s, spB).length} near`,
			);
			check(
				s.host.isDead(a, s.save(a)) === true,
				"(b) …and the first is still dead in the lobby (daybreak or Rebirth)",
			);
			const back = s.enter(a);
			check(back !== undefined && back.state.dead === true, "(b) …and walks back in dead, to wait for daybreak");
		}

		// (c) the first player leaves and a new one joins: the slot is reused, nothing of the first comes with it
		{
			const s = bootServer();
			const a = s.join(newUser(), "first");
			const b = s.join(newUser(), "second");
			for (const p of [a, b]) s.immortal.add(p);
			s.enter(a);
			s.enter(b);
			const saveA = s.save(a);
			saveA.day = 9;
			saveA.zombieKills = 57;
			s.run(2);
			const slotA = s.body(a).slot;
			s.quit(a);
			s.run(1);
			s.clearWorldLog();
			clearSnaps(s);
			const d = s.join(newUser(), "newcomer");
			s.immortal.add(d);
			const spD = s.enter(d);
			s.run(1);
			const mine = worldTo(s, d);
			const init = mine.find(ev => ev.t === s.P.WorldEv.InitBegin);
			const tallies = mine.filter(ev => ev.t === s.P.WorldEv.PlayerTally && ev.slot === spD?.slot);
			const tally = tallies[tallies.length - 1];
			check(
				spD !== undefined && spD.slot === slotA && !spD.state.dead,
				"(c) the newcomer takes the slot the first left (0), standing",
				`slot ${spD?.slot}`,
			);
			check(
				init !== undefined && init.seed === s.host.seed,
				"(c) …is told the server's town (InitBegin: the seed the others play in)",
				`seed ${init?.seed} vs ${s.host.seed}`,
			);
			check(
				mine.some(ev => ev.t === s.P.WorldEv.PlayerJoined && ev.userId === b.UserId) &&
					worldTo(s, b).some(ev => ev.t === s.P.WorldEv.PlayerJoined && ev.userId === d.UserId),
				"(c) …the roster: the newcomer learns of the second, and the second of the newcomer",
			);
			check(
				tally !== undefined && tally.lifeDay === s.save(d).day && tally.kills === 0,
				"(c) …and the scoreboard shows the newcomer's own numbers, not the first player's (day 9, 57 kills)",
				tally === undefined ? "no PlayerTally" : `life day ${tally.lifeDay}, kills ${tally.kills}`,
			);
			check(
				snapsTo(s, d) > 0 && snapsTo(s, a) === 0,
				"(c) …and the snapshots go to the newcomer",
				`${snapsTo(s, d)} parts`,
			);
		}

		// (e) a private server: its owner (PrivateServerOwnerId) leaves while a guest plays, then comes back
		{
			const s = bootServer({ privateServer: true });
			const wipes = s.wipes();
			const owner = s.join(7, "owner");
			const guest = s.join(newUser(), "guest");
			s.immortal.add(owner);
			s.immortal.add(guest);
			s.enter(owner);
			s.enter(guest);
			s.sim.clock.setClock(12, 3);
			for (let i = 0; i < 60; i++) {
				s.walk(owner, 1.1);
				s.beat();
			}
			s.run(1);
			const kept = { x: s.body(owner).state.x, y: s.body(owner).state.y, hp: s.body(owner).state.hp };
			const seed = s.host.seed;
			s.quit(owner);
			clearSnaps(s);
			s.run(15, 0.25);
			check(
				wipes.length === 0 && snapsTo(s, guest) > 0 && s.host.seed === seed && !s.body(guest).state.dead,
				"(e) a private server's owner leaves: the guest plays on in the same town",
				`guest ${snapsTo(s, guest)} parts, wipes ${wipes.length}`,
			);
			const owner2 = s.join(7, "owner");
			const back = s.enter(owner2);
			check(
				back !== undefined &&
					Math.hypot(back.state.x - kept.x, back.state.y - kept.y) < 1 &&
					back.state.hp <= kept.hp,
				"(e) …and the owner, back, gets the body they left (no teleport, no heal): nothing on the server is the owner's",
				back === undefined
					? "no body"
					: `${f1(Math.hypot(back.state.x - kept.x, back.state.y - kept.y))} u off`,
			);
			// the solo case: the only survivor of a reserved server leaves and comes back to it
			s.quit(guest);
			s.quit(owner2);
			s.run(10, 0.25);
			const owner3 = s.join(7, "owner");
			const again = s.enter(owner3);
			check(
				again !== undefined && !again.state.dead && s.host.seed === seed && wipes.length === 0,
				"(e) alone on it, the owner leaves and rejoins: the same world, the same body (the server kept both 5 min)",
				again === undefined
					? "no body"
					: `seed ${s.host.seed === seed ? "same" : "new"}, wipes ${wipes.length}`,
			);
		}
	},
);

// ================================================================

console.log("");
if (failures > 0) {
	console.log(`${failures} of ${checks} check(s) failed`);
	process.exit(1);
}
console.log(`all ${checks} checks passed`);
