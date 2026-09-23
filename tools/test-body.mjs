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
function section(title, fn) {
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
function fakeStore(name) {
	let s = stores.get(name);
	if (s !== undefined) return s;
	const data = new Map();
	s = {
		data,
		UpdateAsync(key, transform) {
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
		info("until the reset to day 1 exists, the daybreak wait still stands them up (see 5a/5b)");
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

	// wearing: the bought outfit is accepted from a report, a pet nobody bought is taken off
	const ack = s.report(p, { equipOutfit: equipOf("Santa"), equipPet: equipOf("Eagle") });
	check(ack?.ok === true, "the report that wears it is accepted");
	check(save.equipOutfit === equipOf("Santa"), "the server wears the bought outfit");
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

// ================================================================

console.log("");
if (failures > 0) {
	console.log(`${failures} of ${checks} check(s) failed`);
	process.exit(1);
}
console.log(`all ${checks} checks passed`);
