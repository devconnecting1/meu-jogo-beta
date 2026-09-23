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

		// a new server process, and a death carried in the save
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
	const pushes = p => acks(p).filter(e => e.args[0]?.push === true);
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

// ================================================================ 20: the admin audit log, through the real remote

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

section("20) the admin audit log: UserIds and filtered text only, one key per server per day (F5, F10, F12)", () => {
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

// ================================================================

console.log("");
if (failures > 0) {
	console.log(`${failures} of ${checks} check(s) failed`);
	process.exit(1);
}
console.log(`all ${checks} checks passed`);
