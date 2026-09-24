#!/usr/bin/env node
/*
 * Analytics (docs/ANALYTICS.md, server/analytics/events.ts): what reaches AnalyticsService, and when.
 *
 *   npm run test:analytics                  # everything (exit code 1 on any failure)
 *   node tools/test-analytics.mjs --verbose # with the server's own print/warn lines and every event
 *   PZ_SRC=path/to/src node tools/test-analytics.mjs
 *
 * Nothing here is a transcription. Sections 1-6 boot the REAL server -- server/main.server.ts with mpHost, the
 * simulation, the horde and the admin server -- on a fake Roblox whose AnalyticsService only records the calls,
 * and play it the way clients do (PlayerAdded, SaveRequest, Intent, Input, ShopAction). Sections 7-8 drive the
 * module's own class for what a Node run cannot afford at 60 Hz: an hour of six players, and a purchase flood.
 *
 *   1. OFF AND STUDIO        no AnalyticsService: every hook is inert and the game plays on; in Studio every rule
 *                            runs but nothing is sent (the docs: events only leave a published game's server).
 *   2. THE ONBOARDING FUNNEL a new player's five steps, each ONCE and IN ORDER: Joined, Tutorial answered, Entered
 *                            the city, First kill, First night survived -- with the tutorial answer arriving before
 *                            or after the entry, a step skipped (a night survived without a kill), a player who never
 *                            enters, a veteran (nothing) and a new player's second session (only what is new).
 *   3. THE NIGHT             the NightSurvival funnel (one session per life) and the Levels funnel, the day's coins
 *                            and the record milestone at midnight, the titles at 06:00.
 *   4. THE ECONOMY BALANCES  every coin the server moved (welcome gift, day, boss, pack, costume, Rebirth) is one
 *                            economy event whose amounts add up to the change in `money`, balance after balance.
 *   5. LIVES AND WORLDS      Died with its fields, LifeEnded on New game and on a world's end (a New game that never
 *                            stood is not a second life), WorldEnded once per world -- 5b: also for a world its dead
 *                            walked out of, on whoever is here, and never on an empty server (review of 577c729, L1).
 *   6. NO PER-KILL SPAM      6 survivors x 400 killing blows: the kills are one SessionKills each, on leaving.
 *   7. THE BACKPACK AND ADMIN  crafts, cooks and uses are session counts; an admin's coins balance, and an admin's
 *                            level is not a level reached.
 *   8. UNDER THE CAP         an hour of six players at the game's own cadence, and a purchase flood: never more than
 *                            RATE_SHARE of 120 + 20 x CCU in any 60 s window, the coins intact.
 *
 * Pure Node (>= 18) + the project's TypeScript, through tools/luau-shim.mjs, plus the fake Roblox of
 * tools/test-body.mjs (copied: each suite carries its own).
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
/** PZ_ANALYTICS_ONLY=5b runs only the sections whose title starts with it (a quicker loop while working on one) */
const ONLY = process.env.PZ_ANALYTICS_ONLY;
function section(title, fn) {
	if (ONLY !== undefined && !title.startsWith(ONLY)) return;
	console.log(`\n${title}`);
	try {
		fn();
	} catch (e) {
		failures += 1;
		console.log(`  FAIL  the section threw: ${e?.stack?.split("\n").slice(0, 4).join(" | ") ?? e}`);
	}
}

// ---------------------------------------------------------------- the fake Roblox (tools/test-body.mjs)

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
globalThis.print = (...a) => {
	if (VERBOSE) console.log("        [print]", ...a);
};
globalThis.warn = (...a) => {
	const line = a.join(" ");
	warnings.push(line);
	if (line.includes("tick failed")) tickErrors.push(line);
	if (VERBOSE) console.log("        [warn]", line);
};
// after ONBOARDING_SINCE (2026-09-23): a save born in this run is a new player's
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
		GetAsync(key) {
			return [clone(data.get(key))];
		},
		SetAsync: (key, v) => data.set(key, clone(v)),
	};
	stores.set(name, s);
	return s;
}

/**
 * Every row any recorder of this run saw (the real servers' and the pure cores'), with the player's name beside it:
 * what section 14 checks the catalogue's limits, the fields' cardinality and the absence of PII against.
 */
const EVERY_ROW = [];

/**
 * The recorder standing in for AnalyticsService: every call, decoded into one row with the clock it was made at.
 * `userId` is the Player's; a row never carries a Player further than that.
 */
function makeAnalyticsService(log) {
	const row = (player, r) => {
		const out = { ...r, userId: player?.UserId, t: clockNow };
		log.push(out);
		EVERY_ROW.push({ ...out, playerName: player?.Name });
		if (VERBOSE) console.log(`        [analytics] ${JSON.stringify(out)}`);
	};
	return {
		LogOnboardingFunnelStepEvent: (player, step, name, fields) =>
			row(player, { kind: "onboarding", step, name, fields }),
		LogFunnelStepEvent: (player, funnel, session, step, name, fields) =>
			row(player, { kind: "funnel", funnel, session, step, name, fields }),
		LogEconomyEvent: (player, flow, currency, amount, balance, tx, sku, fields) =>
			row(player, {
				kind: "economy",
				flow: String(flow).endsWith("Source")
					? "Source"
					: String(flow).endsWith("Sink")
						? "Sink"
						: String(flow),
				currency,
				amount,
				balance,
				tx,
				sku,
				fields,
			}),
		LogCustomEvent: (player, name, value, fields) => row(player, { kind: "custom", name, value, fields }),
	};
}

/**
 * A ConfigService whose player snapshots read `values` (a key -> value map, or a function of the player), counting
 * every snapshot asked for and every GetValue -- the call that enrolls a player in an experiment. `throws`: the
 * snapshot cannot be had (configs.md "Error handling").
 */
function makeConfigService({ values = {}, throws = false } = {}) {
	const calls = { snapshots: 0, reads: [] };
	return {
		calls,
		GetConfigForPlayerAsync(player) {
			calls.snapshots += 1;
			if (throws) throw new Error("ConfigService is unavailable");
			const table = typeof values === "function" ? values(player) : values;
			return {
				GetValue(key) {
					calls.reads.push({ userId: player.UserId, key });
					return table[key];
				},
			};
		},
		GetConfigAsync() {
			throw new Error("the game must never read an experiment through GetConfigAsync");
		},
	};
}

let guid = 0;
function makeGame({ studio = false, analytics = true, config } = {}) {
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
		// GUID-shaped and hex, so no decimal UserId can hide in one (section 13's PII check)
		GenerateGUID: () => `{${(++guid).toString(16).padStart(8, "0")}-feed-beef}`,
		JSONEncode: v => JSON.stringify(v),
		JSONDecode: s => JSON.parse(s),
	};
	const DataStoreService = {
		GetDataStore: name => fakeStore(name),
		GetRequestBudgetForRequestType: () => 100,
	};
	const log = [];
	const serviceCalls = { count: 0 };
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
	if (config !== undefined) services.ConfigService = config;
	if (analytics) {
		const svc = makeAnalyticsService(log);
		// every call, even one the recorder does not decode, is counted: Studio must make none
		services.AnalyticsService = new Proxy(svc, {
			get: (target, k) => {
				const v = target[k];
				if (typeof v !== "function") return v;
				return (...a) => {
					serviceCalls.count += 1;
					// `analytics: "throw"`: a service that fails every call (an outage, a changed API)
					if (analytics === "throw") throw new Error(`AnalyticsService:${String(k)} is failing`);
					return v(...a);
				};
			},
		});
	}
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
	return { services, closers, log, serviceCalls };
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

function bootServer(opts = {}) {
	for (const k of Object.keys(require.cache)) if (k.startsWith(SRC)) delete require.cache[k];
	const env = makeGame(opts);
	require(join(SRC, "server/main.server.ts"));
	const host = require(join(SRC, "server/net/mpHost.ts")).activeMpHost();
	if (host === undefined) throw new Error("main.server.ts did not start the MP host (MP_PHASE < 1?)");
	const A = require(join(SRC, "server/analytics/events.ts"));
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
		A,
		P,
		log: env.log,
		sim: host.simulation,
		core: A.current(),
		join(userId, name = `p${userId}`) {
			const p = makePlayer(userId, name);
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
		enter(p) {
			server.intent(p, P.IntentKind.EnterWorld);
			server.run(0.6);
			return server.body(p);
		},
		/** one Input packet whose newest command presses Reload: a REAL command (MP-13's AFK rule counts edges) */
		press(p) {
			const seq = (seqs.get(p) ?? 0) + 1;
			seqs.set(p, seq);
			const cmds = [];
			for (let k = 0; k < 3 && seq - k >= 1; k++)
				cmds.push(P.makeCommand(seq - k, 0, 0, 0, 0, 1 << P.EdgeShift.Reload));
			remote("Input").OnServerEvent.Fire(p, P.encodeInput({ viewTick: 0, viewFrac: 0, cmds }));
		},
		shop(p, req) {
			return remote("ShopAction").OnServerInvoke(p, req);
		},
		/** a client's SaveRequest of the live save with `fields` overridden (only the tutorial flags matter here) */
		report(p, fields) {
			const json = JSON.stringify({ ...server.save(p), ...fields });
			remote("SaveRequest").OnServerEvent.Fire(p, server.token(p), json);
		},
		body(p) {
			return host.playerOf(p);
		},
		live(p) {
			return host.playerOf(p)?.save ?? server.save(p);
		},
		/** a death through the server's own damage path, then the ticks that notice it */
		kill(p) {
			const sp = server.body(p);
			server.immortal.delete(p);
			sp.state.godMode = false;
			server.sim.combat.damageActor(sp.slot, sp.state, sp.save, sp.state.hpMax * 10, true);
			server.beat();
			server.beat();
			return sp;
		},
		/**
		 * A zombie put down by this survivor, through the server's kill credit (XP `exp`), with the WeaponKind the
		 * credit names (-1: not known) or by one of their machines.
		 */
		killZombie(p, exp = 0, weaponKind = -1, byMachine = false) {
			const sp = server.body(p);
			server.zombieId = (server.zombieId ?? 900000) + 1;
			server.sim.progress.zombieKilled(server.zombieId, exp, sp.slot, clockNow, -1, weaponKind, byMachine);
		},
		/** the client's `viewShop`: the shop (0) or the wardrobe (1) opened */
		viewShop(p, screen) {
			return remote("ShopAction").OnServerInvoke(p, { kind: "viewShop", screen });
		},
		/** a boss down with `ps` in the fight (each did a tenth of its hp) */
		killBoss(ps) {
			server.bossId = (server.bossId ?? 800000) + 1;
			for (const p of ps) server.sim.progress.noteBossDamage(server.bossId, server.body(p).slot, 1000, clockNow);
			return server.sim.progress.bossKilled(server.bossId, 100, 10000, server.body(ps[0]).slot);
		},
		storeSave(userId, data) {
			fakeStore(SAVE_STORE).data.set(String(userId), { data: JSON.stringify(data), lock: undefined });
		},
		immortal: new Set(),
		/** these press a real command every beat */
		active: new Set(),
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
					sp.state.hungry = Math.max(sp.state.hungry, sp.state.hungryMax);
				}
			}
			for (const p of server.active) if (host.playerOf(p) !== undefined) server.press(p);
			RunService.Heartbeat.Fire(dt);
			if (tickErrors.length > 0)
				throw new Error(`the simulation tick failed: ${tickErrors.splice(0).join(" | ")}`);
		},
		run(seconds, dt = 1 / 60) {
			const n = Math.round(seconds / dt);
			for (let i = 0; i < n; i++) server.beat(dt);
		},
		runUntil(pred, limit, dt = 1 / 60) {
			let t = 0;
			while (t < limit) {
				if (pred()) return t;
				server.beat(dt);
				t += dt;
			}
			return pred() ? t : -1;
		},
		shutdown() {
			for (const fn of env.closers) runThread(fn, []);
		},
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
		/** rows of one user, optionally of one kind */
		of(userId, kind) {
			return env.log.filter(r => r.userId === userId && (kind === undefined || r.kind === kind));
		},
	};
	return server;
}

/** the most rows any 60 s window of `log` holds */
function maxPerMinute(log) {
	let best = 0;
	let lo = 0;
	for (let hi = 0; hi < log.length; hi++) {
		while (log[hi].t - log[lo].t >= 60) lo++;
		best = Math.max(best, hi - lo + 1);
	}
	return best;
}

/** the rows of the busiest 60 s window of `log` */
function busiestMinute(log) {
	let best = [0, 0];
	let lo = 0;
	for (let hi = 0; hi < log.length; hi++) {
		while (log[hi].t - log[lo].t >= 60) lo++;
		if (hi - lo + 1 > best[1] - best[0]) best = [lo, hi + 1];
	}
	return log.slice(best[0], best[1]);
}

/** the economy of one user: [sum of sources - sum of sinks, every row's balance follows from the previous one] */
function economyOf(log, userId, start) {
	let money = start;
	let chained = true;
	let net = 0;
	for (const r of log) {
		if (r.userId !== userId || r.kind !== "economy") continue;
		const signed = r.flow === "Source" ? r.amount : -r.amount;
		net += signed;
		money += signed;
		if (r.balance !== money) chained = false;
	}
	return { net, chained, money };
}

/** (the Luau shim turns Array#sort and Set#size into their roblox-ts shapes: plain loops here) */
function increasing(steps) {
	for (let i = 1; i < steps.length; i++) if (!(steps[i] > steps[i - 1])) return false;
	return true;
}
const distinct = arr => arr.filter((v, i) => arr.indexOf(v) === i).length;
const onboardSteps = (s, userId) => s.of(userId, "onboarding").map(r => r.step);
const customs = (s, userId, name) => s.of(userId, "custom").filter(r => r.name === name);

let nextUser = 7000;
const newUser = () => ++nextUser;

// ================================================================ 1: off, and Studio

section("1) no AnalyticsService: every hook is inert; Studio: every rule runs, nothing is sent", () => {
	const off = bootServer({ analytics: false });
	check(off.core === undefined, "without the service analytics is off (current() undefined)");
	const a = off.join(newUser(), "offline");
	off.immortal.add(a);
	const sp = off.enter(a);
	off.killZombie(a, 10);
	off.run(2);
	off.shop(a, { kind: "buyPack", packId: 2 });
	off.quit(a);
	off.run(1);
	check(sp !== undefined && off.log.length === 0, "…and the game plays on: a join, an entry, a kill, a purchase");

	const studio = bootServer({ studio: true });
	check(studio.core !== undefined, "in Studio the module runs (the rules are exercised by a playtest)");
	const b = studio.join(newUser(), "studio");
	studio.immortal.add(b);
	studio.enter(b);
	studio.killZombie(b, 10);
	studio.run(2);
	check(
		studio.env.serviceCalls.count === 0 && studio.log.length === 0,
		"…but AnalyticsService is never called (events only leave a published game)",
		`${studio.env.serviceCalls.count} calls`,
	);
	check(
		studio.core.stats.sent >= 4,
		"…every event is counted by the dry sink instead",
		`sent ${studio.core.stats.sent}`,
	);
	const attr = studio.env.services.Workspace.GetAttribute("pz_analytics_sent");
	check(attr === studio.core.stats.sent, "…and the count is on the Workspace for a playtest to read", `${attr}`);
	check(
		debug.profileLabels.has("PZ.analytics") && debug.profileOpen === 0 && debug.profileUnbalanced === 0,
		"the once-a-second read is its own MicroProfiler bar (PZ.analytics), opened and closed in balance",
	);

	// every AnalyticsService call throws: the game does not notice
	const broken = bootServer({ analytics: "throw" });
	const c = broken.join(newUser(), "unlucky");
	broken.immortal.add(c);
	const body = broken.enter(c);
	broken.killZombie(c, 10);
	broken.run(2);
	const bought = broken.shop(c, { kind: "buyPack", packId: 3 });
	broken.quit(c);
	broken.run(1);
	check(
		body !== undefined && bought.ok && broken.env.serviceCalls.count >= 4 && broken.core.stats.faults >= 4,
		"a service that throws on every call: the entry, the kill, the purchase and the leave all go through",
		`${broken.env.serviceCalls.count} failed calls, ${broken.core.stats.faults} faults counted`,
	);
	check(
		warnings.filter(w => w.includes("analytics:")).length === 1,
		"…and the failure is warned once a minute, not once a call",
		`${warnings.filter(w => w.includes("analytics:")).length} warnings`,
	);
});

// ================================================================ 2-3: the onboarding funnel and the night

section("2) the onboarding funnel: each step once, in the game's order; veterans never enter it", () => {
	const s = bootServer();
	const A = s.A;
	// the town at 23:00 of day 1: the midnight and the 06:00 after it are one continuous stretch (~20 s + ~2 min),
	// and everybody who enters in the first seconds is in the world for well over half of that day (MP-13)
	s.sim.clock.setClock(23);
	const decliner = newUser();
	const late = newUser();
	const lobby = newUser();
	const veteran = newUser();
	const returning = newUser();
	const killer = newUser();
	// a veteran: an old save (before analytics: titleEpoch 0), level 12, day 4 of a life, a record of day 4
	const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
	const vet = defaultSave();
	// enough for section 4's Eagle and two Builder's Basics, whatever docs/SHOP.md prices them at
	const SHOPDATA = require(join(SRC, "shared/data/shop.ts"));
	const VET_START =
		SHOPDATA.COSTUMES.find(c => c.name === "Eagle").price +
		2 * SHOPDATA.SHOP_PACKS.find(x => x.name === "Builder's Basics").price +
		50;
	Object.assign(vet, {
		level: 12,
		exp: 5,
		day: 4,
		bestDay: 4,
		money: VET_START,
		tutorialDone: true,
		firstInstall: false,
	});
	vet.titleEpoch = 0;
	s.storeSave(veteran, vet);
	// a new player's second session: born after analytics, answered, entered and killed before; no Survivor yet
	const back = defaultSave();
	Object.assign(back, { money: 26, tutorialDone: true, firstInstall: false, zombieKills: 3, runHp: 80, exp: 30 });
	back.titleEpoch = TIME0 + 10;
	s.storeSave(returning, back);

	const pD = s.join(decliner, "decliner");
	const pL = s.join(late, "late");
	const pO = s.join(lobby, "lobby");
	const pV = s.join(veteran, "veteran");
	const pR = s.join(returning, "returning");
	const pK = s.join(killer, "killer");
	for (const p of [pD, pL, pO, pV, pR, pK]) s.immortal.add(p);
	check(
		JSON.stringify(onboardSteps(s, decliner)) === "[1]" && JSON.stringify(onboardSteps(s, lobby)) === "[1]",
		"a first visit logs Joined at once",
	);
	check(
		onboardSteps(s, veteran).length === 0 && onboardSteps(s, returning).length === 0,
		"a veteran's session and a new player's second session log no Joined",
	);
	// "No": both flags go in the report (declineTutorial), before the entry
	s.report(pD, { tutorialDone: true, firstInstall: false });
	s.report(pO, { tutorialDone: true, firstInstall: false });
	s.run(1.2);
	check(JSON.stringify(onboardSteps(s, decliner)) === "[1,2]", "the answer read from the save: Tutorial answered");
	const dChoice = customs(s, decliner, A.EVENT.TutorialChoice);
	check(
		dChoice.length === 1 && dChoice[0].fields?.CustomField01 === "Choice - Declined",
		"…and TutorialChoice says Declined",
		JSON.stringify(dChoice.map(r => r.fields)),
	);
	for (const p of [pD, pL, pV, pR, pK]) {
		s.enter(p);
		s.active.add(p);
	}
	check(JSON.stringify(onboardSteps(s, decliner)) === "[1,2,3]", "entering the city: Entered the city");
	check(
		JSON.stringify(onboardSteps(s, late)) === "[1,2,3]",
		"a player whose answer has not landed yet: Tutorial answered is implied by the entry, then Entered",
	);
	// "Yes": the report lands after the entry (the client's report window), with the coach still to run
	s.report(pL, { tutorialDone: true, firstInstall: true });
	s.run(1.2);
	const lChoice = customs(s, late, A.EVENT.TutorialChoice);
	check(
		lChoice.length === 1 && lChoice[0].fields?.CustomField01 === "Choice - Accepted",
		"…its answer arrives later as TutorialChoice Accepted, and step 2 is not sent again",
		`${JSON.stringify(onboardSteps(s, late))}`,
	);
	s.killZombie(pD, 10);
	s.killZombie(pK, 10);
	for (let i = 0; i < 40; i++) s.killZombie(pK, 10);
	s.killZombie(pV, 10);
	s.killZombie(pR, 10);
	s.run(1.2);
	check(JSON.stringify(onboardSteps(s, decliner)) === "[1,2,3,4]", "a killing blow: First kill");
	check(JSON.stringify(onboardSteps(s, killer)) === "[1,2,3,4]", "…once, however many follow (41 here)");
	check(onboardSteps(s, veteran).length === 0, "a veteran's first counted kill is not a new player's first kill");
	check(onboardSteps(s, returning).length === 0, "…nor a second session's kill after the first one");
	s.log.__beforeNight = s.log.length;

	// ---- the night: 23:00 -> midnight -> 06:00, everybody alive and at the controls
	const t0 = clockNow;
	const done = s.runUntil(() => s.sim.clock.day === 2 && s.sim.clock.dayTime >= 6.05, 400);
	check(done >= 0, `the world lived through midnight and 06:00 of day 2`, `${(clockNow - t0).toFixed(0)} s`);
	const { ownsTitle } = require(join(SRC, "shared/game/save.ts"));
	check(ownsTitle(s.live(pD), 0), "…and the decliner is a Survivor (the server's own title)");
	check(
		JSON.stringify(onboardSteps(s, decliner)) === "[1,2,3,4,5]",
		"First night survived: the funnel complete, every step once, in order",
		JSON.stringify(onboardSteps(s, decliner)),
	);
	check(
		JSON.stringify(onboardSteps(s, late)) === "[1,2,3,5]",
		"a new player who survived the night without a kill: step 5 alone (the funnel counts 4 as done)",
		JSON.stringify(onboardSteps(s, late)),
	);
	check(JSON.stringify(onboardSteps(s, returning)) === "[5]", "the second session sends only what is new: 5");
	check(onboardSteps(s, veteran).length === 0, "the veteran survived too, and is still no part of the funnel");
	check(
		JSON.stringify(onboardSteps(s, lobby)) === "[1,2]",
		"a new player who answered and stayed in the lobby stops at step 2",
	);
	check(
		[decliner, late, lobby, returning, killer].every(u => increasing(onboardSteps(s, u))),
		"every onboarding sequence is strictly increasing: no step twice, none out of order",
	);

	// ================================================================ 3 (same night)
	console.log("\n3) the night: NightSurvival and Levels funnels, the day's coins, the titles");
	const nights = u => s.of(u, "funnel").filter(r => r.funnel === A.NIGHT_FUNNEL);
	const dN = nights(decliner);
	check(
		dN.length === 2 && dN[0].step === 1 && dN[1].step === 2 && dN[0].session === dN[1].session,
		"a life enters NightSurvival when it stands in the city (step 1), and the credited midnight is Night 1 (step 2)",
		JSON.stringify(dN.map(r => [r.session, r.step, r.name])),
	);
	check(dN[0]?.session === "life-0", "…one funnel session per life: `life-<runRev - deathCount>`");
	check(nights(lobby).length === 0, "a player who never entered starts no life in the funnel");
	const vN = nights(veteran);
	check(
		vN.length === 2 && vN[1].step === 2,
		"the veteran's life at day 4 had no night the server counted (lifeNights 0): Night 1 now",
		JSON.stringify(vN.map(r => r.step)),
	);
	const levels = u => s.of(u, "funnel").filter(r => r.funnel === A.LEVEL_FUNNEL);
	check(
		levels(veteran).length === 1 && levels(veteran)[0].name === "Level 10",
		"Levels: the level a player has is logged once per session (a one-time funnel: the platform dedupes)",
		JSON.stringify(levels(veteran).map(r => r.name)),
	);
	const kLevels = levels(killer).map(r => r.name);
	check(
		kLevels[0] === "Level 1" && kLevels.length >= 2 && distinct(kLevels) === kLevels.length,
		"…and each threshold crossed afterwards once (41 kills of 10 XP)",
		JSON.stringify(kLevels),
	);
	const dayCoins = u => s.of(u, "economy").filter(r => r.sku === A.SKU.DaySurvived);
	check(
		[decliner, late, veteran, returning, killer].every(
			u => dayCoins(u).length === 1 && dayCoins(u)[0].amount === 3,
		),
		"midnight paid everybody alive and present: one Day survived source of 3 coins each (Gameplay)",
	);
	const vMil = s.of(veteran, "economy").filter(r => r.sku === A.SKU.Milestone);
	check(
		vMil.length === 1 && vMil[0].amount === 10 && vMil[0].tx === "Gameplay",
		"the veteran's day 5 is a new record on a multiple of 5: a Record milestone source of 10",
	);
	const titles = u => customs(s, u, A.EVENT.TitleEarned).map(r => r.fields.CustomField01);
	check(
		titles(decliner).includes("Title - Survivor") && titles(veteran).includes("Title - Survivor"),
		"06:00: TitleEarned [Survivor], for the new player and the veteran alike",
	);
	check(
		s.log.filter(
			r => r.kind === "custom" && r.name === A.EVENT.TitleEarned && r.fields.CustomField01 === "Title - Survivor",
		).length === 5,
		"…once for each of the five who lived the night",
	);
	const perMinute = maxPerMinute(s.log);
	check(
		perMinute <= s.core.limitNow() && perMinute < s.core.capNow(),
		"six players, a night of play: no 60 s window near the cap",
		`max ${perMinute} events in a minute; limit ${s.core.limitNow()}, cap ${s.core.capNow()}`,
	);
	info(`the whole night logged ${s.log.length - s.log.__beforeNight} events for 6 players`);
	globalThis.__night = {
		s,
		p: { decliner: pD, late: pL, lobby: pO, veteran: pV, returning: pR, killer: pK },
		/** the coins each had before this server moved any (a new save: 0, and the gift is its first source) */
		start: { [decliner]: 0, [late]: 0, [lobby]: 0, [killer]: 0, [veteran]: VET_START, [returning]: 26 },
	};
});

// ================================================================ 4: the economy balances

section("4) every coin the server moved is one economy event, and they add up to the balance", () => {
	const night = globalThis.__night;
	if (night === undefined) throw new Error("section 2 did not leave its server");
	const { s, p, start } = night;
	const A = s.A;
	const { SHOP_PACKS, COSTUMES, rebirthPrice } = require(join(SRC, "shared/data/shop.ts"));
	const packId = name => SHOP_PACKS.findIndex(x => x.name === name);
	const costumeId = name => COSTUMES.findIndex(x => x.name === name);
	const money = pl => s.live(pl).money;
	const economy = u => s.of(u, "economy");

	// the gift of a first visit
	const gift = economy(p.decliner.UserId)[0];
	check(
		gift?.sku === A.SKU.WelcomeGift && gift.tx === "Onboarding" && gift.amount === 20 && gift.balance === 20,
		"a first visit's welcome gift: a Source of 20, Onboarding",
		JSON.stringify(gift),
	);
	check(
		economy(p.veteran.UserId).every(r => r.sku !== A.SKU.WelcomeGift),
		"…never for a save that already existed",
	);

	// a pack from the street and one from the lobby
	const n0 = s.log.length;
	const craftKit = packId("Builder's Basics");
	const r1 = s.shop(p.decliner, { kind: "buyPack", packId: craftKit });
	const r2 = s.shop(p.lobby, { kind: "buyPack", packId: packId("Pet Pigeon") });
	const buys = s.log.slice(n0).filter(r => r.kind === "economy");
	check(
		r1.ok && r2.ok && buys.length === 2 && buys.every(r => r.flow === "Sink" && r.tx === "Shop"),
		"a pack bought (in the city or the lobby): a Sink, Shop",
		JSON.stringify(buys.map(r => [r.sku, r.amount, r.balance])),
	);
	check(
		buys[0]?.sku === SHOP_PACKS[craftKit].name && buys[0].amount === SHOP_PACKS[craftKit].price,
		"…the SKU is the pack's catalogue name and the amount its catalogue price",
	);
	// a purchase replayed (the same client nonce, shared/net/shopGuard.ts): answered as the first, charged once -- and
	// logged once, or the sinks would add up to more than the coins that left
	s.run(1.2);
	const nr = s.log.length;
	const moneyBefore = s.live(p.veteran).money;
	const once = s.shop(p.veteran, { kind: "buyPack", packId: craftKit, nonce: 41 });
	s.run(1.2);
	const replay = s.shop(p.veteran, { kind: "buyPack", packId: craftKit, nonce: 41 });
	const replaySinks = s.log.slice(nr).filter(r => r.kind === "economy");
	check(
		once.ok &&
			replay.ok &&
			replay.price === once.price &&
			s.live(p.veteran).money === moneyBefore - SHOP_PACKS[craftKit].price &&
			replaySinks.length === 1 &&
			replaySinks[0].amount === SHOP_PACKS[craftKit].price,
		"a replayed purchase (the same nonce): answered ok, charged once, one Sink",
		JSON.stringify(replaySinks.map(r => [r.sku, r.amount, r.balance])),
	);
	// a costume: bought, refused for funds, refused as owned
	const eagle = costumeId("Eagle");
	const r3 = s.shop(p.veteran, { kind: "buyCostume", costumeId: eagle, price: 0 });
	const n1 = s.log.length;
	const r4 = s.shop(p.decliner, { kind: "buyCostume", costumeId: eagle });
	const r5 = s.shop(p.veteran, { kind: "buyCostume", costumeId: eagle });
	check(
		r3.ok && economy(p.veteran.UserId).some(r => r.sku === "Eagle" && r.amount === COSTUMES[eagle].price),
		"a costume: a Sink of its catalogue price (a `price` in the request is never read), SKU the costume",
	);
	check(
		!r4.ok && !r5.ok && s.log.length === n1,
		"a purchase the server refused (funds, owned) logs nothing",
		`${r4.reason}, ${r5.reason}`,
	);
	// a boss, two in the fight
	const n2 = s.log.length;
	s.killBoss([p.killer, p.late]);
	const boss = s.log.slice(n2).filter(r => r.kind === "economy");
	check(
		boss.length === 2 && boss.every(r => r.sku === A.SKU.Boss && r.amount === 8 && r.tx === "Gameplay"),
		"a boss down: a Boss source of 8 for each survivor who fought it",
		JSON.stringify(boss.map(r => [r.userId, r.amount])),
	);
	// a Rebirth: the continue's price, as a contextual purchase
	s.run(1.2);
	s.kill(p.late);
	const price = rebirthPrice(s.live(p.late).deathCount);
	const r6 = s.shop(p.late, { kind: "rebirth", runRev: s.live(p.late).runRev });
	const reb = economy(p.late.UserId).filter(r => r.sku === A.SKU.Rebirth);
	check(
		r6.ok && reb.length === 1 && reb[0].amount === price && reb[0].tx === "ContextualPurchase",
		"a Rebirth: a Sink of rebirthPrice(deathCount), ContextualPurchase (the docs' 'extra lives')",
		JSON.stringify(reb.map(r => [r.amount, r.fields])),
	);
	check(reb[0]?.fields?.CustomField01 === "Continue - 1", "…and which continue it was: Continue - 1");
	const rf = s.of(p.late.UserId, "funnel").filter(r => r.funnel === A.REBIRTH_FUNNEL);
	check(
		rf.length === 2 &&
			rf[0].step === 1 &&
			rf[1].step === 2 &&
			rf[1].name === "Rebirth bought" &&
			rf[0].session === rf[1].session &&
			rf[1].fields === undefined,
		"the paid Rebirth closes its death's funnel: step 2 in the same session (only step 1 carries fields)",
		JSON.stringify(rf.map(r => [r.session, r.step, r.fields])),
	);
	const sinks = s.log.filter(r => r.kind === "economy" && r.tx === "Shop");
	check(
		sinks.length >= 3 &&
			sinks.every(
				r =>
					r.fields?.CustomField01 ===
					(COSTUMES.some(c => c.name === r.sku) ? "Category - Costume" : "Category - Pack"),
			),
		"every shop sink says what it bought: Category - Pack or Category - Costume, one breakdown for both",
		JSON.stringify(sinks.map(r => [r.sku, r.fields?.CustomField01])),
	);
	s.run(1.2);

	for (const [name, pl] of Object.entries(p)) {
		const u = pl.UserId;
		const e = economyOf(s.log, u, start[u]);
		check(
			e.chained && e.net === money(pl) - start[u],
			`${name}: the sources less the sinks are the change in coins, and each balance follows the last`,
			`${start[u]} + ${e.net} = ${money(pl)}; ${economy(u).length} events`,
		);
	}
	check(
		s.log.filter(r => r.kind === "economy").every(r => r.currency === A.CURRENCY && r.amount > 0 && r.balance >= 0),
		"every economy event: currency Coins, a positive amount, a balance ≥ 0 (the API's rules)",
	);
	const txs = s.log.filter(r => r.kind === "economy").map(r => r.tx);
	check(
		txs.every(t => ["Onboarding", "Gameplay", "Shop", "ContextualPurchase", "Admin"].includes(t)),
		"transaction types are the built-in names (and Admin)",
		txs.filter((t, i) => txs.indexOf(t) === i).join(", "),
	);
});

// ================================================================ 5: lives and worlds

section("5) Died, LifeEnded (New game, the world's end) and WorldEnded, once each", () => {
	const s = bootServer();
	const A = s.A;
	s.sim.clock.setClock(21);
	const a = s.join(newUser(), "a");
	const b = s.join(newUser(), "b");
	for (const pl of [a, b]) {
		s.immortal.add(pl);
		s.enter(pl);
	}
	s.run(1.2);
	s.kill(a);
	const died = customs(s, a.UserId, A.EVENT.Died);
	check(
		died.length === 1 &&
			died[0].value === 1 &&
			died[0].fields.CustomField01 === "Life day - 1" &&
			died[0].fields.CustomField02 === "Time - Night" &&
			died[0].fields.CustomField03 === "Cause - Horde",
		"Died: the life's day as the value, its bucket, night or day, and the cause (no hunger, no poison, no boss)",
		JSON.stringify(died.map(r => [r.value, r.fields])),
	);
	// the Rebirth funnel of that death: step 1 with what the price is weighed against
	const reb = s.of(a.UserId, "funnel").filter(r => r.funnel === A.REBIRTH_FUNNEL);
	check(
		reb.length === 1 &&
			reb[0].step === 1 &&
			reb[0].name === "Died" &&
			reb[0].session === A.deathKeyOf(s.live(a)) &&
			reb[0].fields.CustomField01 === "Continue - 1" &&
			/^Afford - (Yes|No)$/.test(reb[0].fields.CustomField02) &&
			reb[0].fields.CustomField03 === "Life day - 1",
		"…and the Rebirth funnel opens on it: Died, keyed by the death, with the continue, the coins and the life's day",
		JSON.stringify(reb.map(r => [r.session, r.step, r.fields])),
	);
	// New game: the life that ends is the one that died (day 1, no Rebirth), and the new one has not stood yet
	const r = s.shop(a, { kind: "newRun", runRev: s.live(a).runRev });
	const ended = customs(s, a.UserId, A.EVENT.LifeEnded);
	check(
		r.ok &&
			ended.length === 1 &&
			ended[0].value === 1 &&
			ended[0].fields.CustomField01 === "End - New game" &&
			ended[0].fields.CustomField03 === "Rebirths - 0",
		"New game: LifeEnded, value the day the life reached, End - New game",
		JSON.stringify(ended.map(x => [x.value, x.fields])),
	);
	check(
		s.of(a.UserId, "funnel").filter(x => x.funnel === A.REBIRTH_FUNNEL && x.step === 2).length === 0,
		"…and a New game is the Rebirth funnel's drop-off: no Rebirth bought",
	);
	// the last one standing falls: 30 s, nobody pays, the world ends
	s.kill(b);
	const wipes = s.wipes();
	s.run(31);
	check(wipes.length === 1, "the world ended (MP-22: nobody alive, nobody paid in 30 s)");
	const worlds = s.log.filter(x => x.kind === "custom" && x.name === A.EVENT.WorldEnded);
	check(
		worlds.length === 1 &&
			worlds[0].value === 1 &&
			worlds[0].fields.CustomField01 === "Reason - Timeout" &&
			worlds[0].fields.CustomField02 === "Fallen - 2",
		"WorldEnded once for the world: the days it lasted, why, how many fell",
		JSON.stringify(worlds.map(x => [x.userId, x.value, x.fields])),
	);
	const bEnded = customs(s, b.UserId, A.EVENT.LifeEnded);
	check(
		bEnded.length === 1 && bEnded[0].fields.CustomField01 === "End - World end",
		"the survivor who fell with it: LifeEnded, End - World end",
		JSON.stringify(bEnded.map(x => x.fields)),
	);
	check(
		customs(s, a.UserId, A.EVENT.LifeEnded).length === 1,
		"the New game life that never stood is not a second life ended by the world",
		`${customs(s, a.UserId, A.EVENT.LifeEnded).length}`,
	);
	s.run(1.2);
	const lifeFunnel = s.of(b.UserId, "funnel").filter(x => x.funnel === A.NIGHT_FUNNEL);
	const sessions = lifeFunnel.map(x => x.session);
	check(
		distinct(sessions) === 2 && lifeFunnel[lifeFunnel.length - 1].step === 1,
		"the new life in the new town opens a new NightSurvival session at step 1",
		JSON.stringify(lifeFunnel.map(x => [x.session, x.step])),
	);

	// a solo world: New game IS the refusal that ends it (MP-21), and it is still one life ended
	const solo = bootServer();
	const c = solo.join(newUser(), "solo");
	solo.immortal.add(c);
	solo.enter(c);
	solo.run(1.2);
	solo.kill(c);
	const soloWipes = solo.wipes();
	solo.shop(c, { kind: "newRun", runRev: solo.live(c).runRev });
	solo.run(2);
	check(soloWipes.length === 1 && soloWipes[0].reason === "declined", "solo: New game ends the world at once");
	const cEnded = customs(solo, c.UserId, A.EVENT.LifeEnded);
	check(
		cEnded.length === 1 && cEnded[0].fields.CustomField01 === "End - New game",
		"…and logs ONE life ended (New game), not a second for the world's end",
		JSON.stringify(cEnded.map(x => x.fields.CustomField01)),
	);
	const cWorld = customs(solo, c.UserId, A.EVENT.WorldEnded);
	check(
		cWorld.length === 1 && cWorld[0].fields.CustomField01 === "Reason - Declined",
		"…with the world's own WorldEnded (Reason - Declined)",
		JSON.stringify(cWorld.map(x => x.fields.CustomField01)),
	);
});

// ================================================================ 5b: a world its dead walked out of

/*
 * MP-22 and the review of 577c729, L1: every survivor dies and every one of them leaves the server during the window.
 * Leaving is declining, so the world is lost -- and it ends only with somebody connected (with a loaded save) to see
 * the next one: in the lobby at that moment, or the next player to connect. The fallen have all left, so the world's
 * one WorldEnded goes on whoever is here; it used to be dropped (it looked for a fallen survivor still connected).
 */
section("5b) the world its dead walked out of: it ends with somebody here, and WorldEnded is still logged", () => {
	// (a) somebody sits in the lobby while the two in the city die and walk out
	{
		const s = bootServer();
		const A = s.A;
		const lobby = s.join(newUser(), "lobby");
		const a = s.join(newUser(), "a");
		const b = s.join(newUser(), "b");
		s.enter(a);
		s.enter(b);
		s.run(1.2);
		const wipes = s.wipes();
		s.kill(a);
		s.kill(b);
		s.quit(a);
		s.quit(b);
		s.run(1);
		const worlds = s.log.filter(x => x.kind === "custom" && x.name === A.EVENT.WorldEnded);
		check(
			wipes.length === 1 && wipes[0].reason === "declined",
			"(a) the last of the dead walks out with a player in the lobby: the world ends at once (declined)",
			`wipes ${wipes.length} (${wipes[0]?.reason})`,
		);
		check(
			worlds.length === 1 &&
				worlds[0].userId === lobby.UserId &&
				worlds[0].fields.CustomField01 === "Reason - Declined" &&
				worlds[0].fields.CustomField02 === "Fallen - 2",
			"(a) …and its WorldEnded is logged once, on the player who is here (the fallen are gone)",
			JSON.stringify(worlds.map(x => [x.userId === lobby.UserId ? "lobby" : x.userId, x.fields])),
		);
	}
	// (b) nobody is left on the server: the world stays lost until the next player's save loads, then ends
	{
		const s = bootServer();
		const A = s.A;
		const a = s.join(newUser(), "a");
		const b = s.join(newUser(), "b");
		s.enter(a);
		s.enter(b);
		s.run(1.2);
		const wipes = s.wipes();
		s.kill(a);
		s.kill(b);
		s.quit(a);
		s.quit(b);
		s.run(40, 0.25);
		const quiet = s.log.filter(x => x.kind === "custom" && x.name === A.EVENT.WorldEnded).length;
		check(
			wipes.length === 0 && quiet === 0,
			"(b) everybody gone: the lost world does not end on an empty server (nobody to see it, no WorldEnded)",
			`wipes ${wipes.length}, WorldEnded ${quiet}`,
		);
		const c = s.join(newUser(), "next");
		s.run(0.5);
		const worlds = s.log.filter(x => x.kind === "custom" && x.name === A.EVENT.WorldEnded);
		check(
			wipes.length === 1 && worlds.length === 1 && worlds[0].userId === c.UserId,
			"(b) the next player's save loads: the world ends before they can enter it, its WorldEnded on them",
			`wipes ${wipes.length}, WorldEnded ${JSON.stringify(worlds.map(x => (x.userId === c.UserId ? "next" : x.userId)))}`,
		);
	}
});

// ================================================================ 6: kills and the backpack

section("6) 6 survivors x 400 killing blows: no event per kill, one SessionKills each on leaving", () => {
	const s = bootServer();
	const A = s.A;
	const ps = [];
	for (let i = 0; i < 6; i++) {
		const pl = s.join(newUser(), `k${i}`);
		s.immortal.add(pl);
		ps.push(pl);
	}
	for (const pl of ps) s.enter(pl);
	s.run(2);
	const n0 = s.log.length;
	// phase 1: 100 each over 20 s (the first kills, and Horde Breaker at the 100th)
	for (let t = 0; t < 20; t++) {
		for (let k = 0; k < 5; k++) for (const pl of ps) s.killZombie(pl, 0);
		s.run(1);
	}
	const phase1 = s.log.slice(n0);
	const n1 = s.log.length;
	// phase 2: 300 more each over 30 s -- the first survivor's with a melee weapon, the second's with a pistol, the
	// credit naming the kind as combat does (server/sim/combat.ts); and the third's turret puts down 5 of its own
	const { WeaponKind } = require(join(SRC, "shared/data/kinds.ts"));
	for (let t = 0; t < 30; t++) {
		for (let k = 0; k < 10; k++) {
			for (let i = 0; i < ps.length; i++) {
				s.killZombie(ps[i], 0, i === 0 ? WeaponKind.Melee : i === 1 ? WeaponKind.Pistol : -1);
			}
		}
		if (t < 5) s.killZombie(ps[2], 0, -1, true);
		s.run(1);
	}
	const phase2 = s.log.slice(n1);
	const names = phase1.map(r => r.name);
	info(`phase 1 (600 kills): ${phase1.length} events: ${names.filter((v, i) => names.indexOf(v) === i).join(", ")}`);
	check(
		phase1.length <= 12 &&
			phase1.every(r => r.name === "First kill" || (r.kind === "custom" && r.name === A.EVENT.TitleEarned)),
		"the first 600 kills: only each new player's First kill and each Horde Breaker title (≤ 2 per player)",
	);
	check(phase2.length === 0, "the next 1800 kills: not one event", `${phase2.length}`);
	// the backpack's decisions, through the simulation's own hook (server/main.server.ts wires it)
	const sp0 = s.body(ps[0]);
	const n2 = s.log.length;
	for (let i = 0; i < 3; i++) s.sim.onBackpack(sp0, { kind: "crafted", recipe: 1, count: 1, heat: "cook" });
	for (let i = 0; i < 2; i++) s.sim.onBackpack(sp0, { kind: "crafted", recipe: 2, count: 1, heat: undefined });
	s.sim.onBackpack(sp0, { kind: "crafted", recipe: 3, count: 1, heat: "smelt" });
	for (let i = 0; i < 4; i++) s.sim.onBackpack(sp0, { kind: "used", item: 3 });
	s.sim.onBackpack(sp0, { kind: "equipped", equip: 1, slot: 1 });
	s.run(1.2);
	check(s.log.length === n2, "crafting, cooking and using log nothing on the spot");
	for (const pl of ps) s.quit(pl);
	s.run(2);
	const kills = s.log.filter(r => r.kind === "custom" && r.name === A.EVENT.SessionKills);
	check(
		kills.length === 6 && kills.every(r => r.value === 400 && r.fields.CustomField01 === "Kills - 200+"),
		"leaving: one SessionKills per session, value 400, bucket 200+",
		JSON.stringify(kills.map(r => r.value)),
	);
	const crafted = customs(s, ps[0].UserId, A.EVENT.Crafted).map(r => `${r.fields.CustomField01}=${r.value}`);
	const used = customs(s, ps[0].UserId, A.EVENT.ItemsUsed).map(r => r.value);
	check(
		JSON.stringify(crafted) === JSON.stringify(["Kind - Crafted=2", "Kind - Cooked=3", "Kind - Smelted=1"]) &&
			JSON.stringify(used) === "[4]",
		"…and the backpack's session counts: Crafted by kind (crafted, cooked, smelted), ItemsUsed",
		`${JSON.stringify(crafted)} ${JSON.stringify(used)}`,
	);
	check(customs(s, ps[1].UserId, A.EVENT.Crafted).length === 0, "a session that crafted nothing sends no Crafted");
	const weapons = pl =>
		customs(s, pl.UserId, A.EVENT.WeaponKills)
			.map(r => `${r.fields.CustomField01}=${r.value}`)
			.join(",");
	check(
		weapons(ps[0]) === "Weapon - Other=100,Weapon - Melee=300" &&
			weapons(ps[1]) === "Weapon - Other=100,Weapon - Pistol=300" &&
			weapons(ps[2]) === "Weapon - Other=400,Weapon - Machine=5" &&
			weapons(ps[3]) === "Weapon - Other=400",
		"…and WeaponKills: one per kind the session used, its killing blows as the value (a turret's too), never one per kill",
		`${weapons(ps[0])} | ${weapons(ps[1])} | ${weapons(ps[2])} | ${weapons(ps[3])}`,
	);
	const ended = s.log.filter(r => r.kind === "custom" && r.name === A.EVENT.SessionEnded);
	check(
		ended.length === 6 &&
			ended.every(
				r =>
					r.fields.CustomField01 === "Where - City" &&
					r.fields.CustomField03 === "Visit - First" &&
					/^Time - (Night|Day)$/.test(r.fields.CustomField02) &&
					r.value >= 0.8 &&
					r.value <= 1.2,
			),
		"SessionEnded once per session: quit from the city, on a first visit, at the world's hour, ~1 minute played",
		JSON.stringify(ended.map(r => [r.value, r.fields])),
	);
});

// ================================================================ the module's own class, for 7 and 8

const AN = require(join(SRC, "server/analytics/events.ts"));
const { defaultSave: blankSave, resetRun } = require(join(SRC, "shared/game/save.ts"));
const { rebirthPrice, SHOP_PACKS } = require(join(SRC, "shared/data/shop.ts"));
const { awardExp } = require(join(SRC, "server/sim/progress.ts"));

/** a core with its own clock and a recording sink */
function makeCore() {
	const rows = [];
	let now = 0;
	const sink = {
		deliver(ev) {
			const row = { ...ev, userId: ev.player.UserId, player: undefined, t: now };
			rows.push(row);
			EVERY_ROW.push({ ...row, playerName: ev.player.Name });
		},
	};
	const core = new AN.ServerAnalytics(sink, { clock: () => now });
	return {
		core,
		rows,
		advance(dt) {
			now += dt;
		},
	};
}
const connected = {};
/** stands in for a Player: the core reads UserId, and Parent to notice a removal it missed */
const fakePlayer = (userId, name) => ({ UserId: userId, Name: name, Parent: connected });

section("7) an admin's coins balance, an admin's level is not a level reached; a failing sink breaks nothing", () => {
	const h = makeCore();
	const pl = fakePlayer(501, "edited");
	const save = blankSave();
	save.money = 20;
	h.core.sessionLoaded(pl, "new", save);
	h.core.enteredWorld(pl);
	h.core.poll();
	const edited = blankSave();
	Object.assign(edited, { money: 500, level: 40 });
	h.core.adminEdit(save, edited);
	Object.assign(save, edited);
	h.advance(1);
	h.core.poll();
	const admin = h.rows.filter(r => r.kind === "economy" && r.tx === "Admin");
	check(
		admin.length === 1 && admin[0].flow === "Source" && admin[0].amount === 480 && admin[0].balance === 500,
		"an admin who sets 500 coins: a Source of 480, Admin -- so the balances still add up",
	);
	check(
		!h.rows.some(r => r.kind === "funnel" && r.funnel === AN.LEVEL_FUNNEL && r.name === "Level 40"),
		"…and the level 40 the admin set is not logged as reached",
	);
	awardExp(save, 100000);
	h.advance(1);
	h.core.poll();
	check(
		h.rows.some(r => r.kind === "funnel" && r.funnel === AN.LEVEL_FUNNEL && r.step > 9),
		"a level the player then earns past it is",
		JSON.stringify(h.rows.filter(r => r.funnel === AN.LEVEL_FUNNEL).map(r => r.name)),
	);

	const bad = new AN.ServerAnalytics(
		{
			deliver() {
				throw new Error("AnalyticsService is down");
			},
		},
		{ clock: () => 0 },
	);
	let threw = false;
	const origWarn = globalThis.warn;
	globalThis.warn = () => {};
	try {
		const s2 = blankSave();
		bad.sessionLoaded(fakePlayer(502, "x"), "new", s2);
		bad.poll();
		bad.dayCoins(s2, 3, 0);
	} catch {
		threw = true;
	}
	globalThis.warn = origWarn;
	check(!threw && bad.stats.faults >= 2, "a sink that throws is contained and counted", `${bad.stats.faults}`);
});

// ================================================================ 8: the cap

section("8) under the cap: an hour of six players, and a purchase flood", () => {
	// (a) an hour at the game's own cadence, pessimistic: all six at the controls all hour, two kills a second each,
	// dying every night and paying a Rebirth for it, shopping every 3 minutes, a boss every night, levels climbing, a
	// world ending once, two players leaving and coming back. A game day is 605 real seconds (shared/sim/clock.ts).
	const h = makeCore();
	const players = [];
	for (let i = 0; i < 6; i++) {
		const pl = fakePlayer(600 + i, `h${i}`);
		const save = blankSave();
		save.money = 20;
		h.core.sessionLoaded(pl, "new", save);
		h.core.enteredWorld(pl);
		players.push({ pl, save });
	}
	const DAY_S = 605;
	const MIDNIGHT_AT = 400;
	// the world clock of that hour (00:00 at MIDNIGHT_AT, a day every DAY_S), every survivor standing in it: the Night
	// funnel runs for all six, every night
	let tNow = 0;
	h.core.bindWorld({
		dayTime: () => ((((tNow % DAY_S) - MIDNIGHT_AT) / DAY_S) * 24 + 48) % 24,
		day: () => Math.floor((tNow + DAY_S - MIDNIGHT_AT) / DAY_S) + 1,
		bodyOf: () => ({ dead: false }),
		standing: () => 6,
	});
	const body = { x: 0, y: 0, hungry: 50, buffs: { poison: 0 } };
	for (let t = 0; t < 3600; t++) {
		tNow = t;
		h.advance(1);
		const inDay = t % DAY_S;
		for (const { save } of players) {
			save.zombieKills += 2;
			awardExp(save, 20);
			// the credit names a weapon for each (counted, never sent per kill)
			h.core.kill(save, 7);
			h.core.kill(save, t % 3 === 0 ? 2 : 7);
		}
		if (inDay === MIDNIGHT_AT) {
			for (const { save } of players) {
				save.day += 1;
				save.lifeNights += 1;
				const milestone = save.day > save.bestDay && save.day % 5 === 0 ? 10 : 0;
				save.bestDay = Math.max(save.bestDay, save.day);
				save.money += 3 + milestone;
				h.core.dayCoins(save, 3 + milestone, milestone);
			}
		}
		if (inDay === MIDNIGHT_AT + 60) {
			for (const { pl, save } of players) {
				save.money += 8;
				h.core.bossCoins(save, 8);
				save.lifeDeaths += 1;
				h.core.death(save, 1, 6, body);
				// (the coins for it are not the point here: the count of events is)
				const price = rebirthPrice(save.deathCount);
				save.deathCount += 1;
				save.runRev += 1;
				h.core.shopAction(pl, { kind: "rebirth" }, price);
			}
		}
		if (t % 180 === 90) {
			const id = t % SHOP_PACKS.length;
			for (const { pl } of players) {
				// a visit each: opened, asked, bought (the Shop funnel's three steps)
				const req = { kind: "buyPack", packId: id };
				h.core.shopViewed(pl, 0);
				h.core.shopRequest(pl, req);
				h.core.shopAction(pl, req, SHOP_PACKS[id].price);
			}
		}
		if (t === 2000) {
			for (const { save } of players) {
				save.lifeDeaths += 1;
				h.core.death(save, 23, 6, body);
				resetRun(save);
				save.runRev += 1;
			}
			h.core.worldEnded(
				{ day: 4, reason: "timeout", dead: players.map(x => x.pl.UserId) },
				{
					lives: players.map(x => ({ userId: x.pl.UserId, runRev: x.save.runRev })),
					ended: { days: 4, fallen: 6 },
				},
			);
		}
		if (t === 1500 || t === 2500) {
			const { pl, save } = players[t === 1500 ? 0 : 1];
			h.core.playerLeft(pl);
			h.advance(20);
			h.core.poll();
			h.core.sessionLoaded(pl, "ok", save);
			h.core.enteredWorld(pl);
		}
		h.core.poll();
	}
	// the hour ends with the server: every session's summaries at once (SessionEnded, SessionKills, WeaponKills)
	h.core.shutdown();
	const perMinute = maxPerMinute(h.rows);
	const cap = h.core.capNow();
	const hourNames = h.rows.map(r => r.funnel ?? r.name ?? r.sku);
	const counted = name => hourNames.filter(n => n === name).length;
	info(
		`…of which Night ${counted(AN.NIGHT_PHASE_FUNNEL)}, Rebirth ${counted(AN.REBIRTH_FUNNEL)}, Shop ` +
			`${counted(AN.SHOP_FUNNEL)}, SessionEnded ${counted(AN.EVENT.SessionEnded)}, WeaponKills ` +
			`${counted(AN.EVENT.WeaponKills)}`,
	);
	check(
		counted(AN.NIGHT_PHASE_FUNNEL) > 0 &&
			counted(AN.REBIRTH_FUNNEL) > 0 &&
			counted(AN.SHOP_FUNNEL) > 0 &&
			counted(AN.EVENT.WeaponKills) > 0 &&
			counted(AN.EVENT.SessionEnded) === 8,
		"the hour includes every new event (a SessionEnded per session: 6 + the 2 that left and came back)",
	);
	check(
		perMinute <= h.core.limitNow() && h.core.stats.maxInWindow <= h.core.limitNow(),
		"an hour of six players never spends more than the module's share of the cap in a minute",
		`peak ${perMinute}/min (limit ${h.core.limitNow()}, documented cap ${cap}); ${h.rows.length} events in the hour`,
	);
	check(h.core.stats.dropped === 0 && h.core.stats.deferredPeak === 0, "…nothing dropped, nothing even waited");
	info(`rate estimate: ${h.rows.length} events/hour = ${(h.rows.length / 60).toFixed(1)}/min on average, 6 players`);
	info(`busiest minute: ${perMinute} events = ${((perMinute / cap) * 100).toFixed(0)}% of the cap of ${cap}/min`);
	const busiest = busiestMinute(h.rows);
	const kinds = {};
	for (const r of busiest) {
		const k = r.kind === "custom" || r.kind === "funnel" ? `${r.kind} ${r.name}` : `${r.kind} ${r.sku ?? ""}`;
		kinds[k] = (kinds[k] ?? 0) + 1;
	}
	info(`…made of: ${JSON.stringify(kinds)}`);
	check(perMinute <= cap / 3, "…the busiest minute within a third of the documented cap", `${perMinute} of ${cap}`);

	// (b) a flood: six rich players buying 150 packs each in 10 s -- far past the ShopAction bucket (2 a second, a
	// burst of 6). The window holds, and not one coin goes missing.
	const f = makeCore();
	const rich = [];
	for (let i = 0; i < 6; i++) {
		const pl = fakePlayer(700 + i, `r${i}`);
		const save = blankSave();
		save.money = 100000;
		f.core.sessionLoaded(pl, "ok", save);
		rich.push({ pl, save, spent: 0 });
	}
	for (let k = 0; k < 150; k++) {
		for (const r of rich) {
			const id = k % SHOP_PACKS.length;
			r.save.money -= SHOP_PACKS[id].price;
			r.spent += SHOP_PACKS[id].price;
			f.core.shopAction(r.pl, { kind: "buyPack", packId: id }, SHOP_PACKS[id].price);
		}
		if (k % 15 === 0) {
			f.advance(1);
			f.core.poll();
		}
	}
	const queued = f.core.stats.deferredPeak;
	for (let t = 0; t < 600; t++) {
		f.advance(1);
		f.core.poll();
	}
	check(
		maxPerMinute(f.rows) <= f.core.limitNow(),
		"a flood of 900 purchases: no minute past the module's share of the cap",
		`peak ${maxPerMinute(f.rows)}/min, limit ${f.core.limitNow()}, queue peak ${queued}, merged ${f.core.stats.merged}`,
	);
	check(f.core.stats.dropped === 0 && f.core.stats.deferred === 0, "…nothing dropped, the queue drained");
	check(
		rich.every(r => {
			const e = economyOf(f.rows, r.pl.UserId, 100000);
			return e.chained && -e.net === r.spent && e.money === r.save.money;
		}),
		"…and every coin is there: merged purchases add their amounts, each balance follows from the last",
	);
	const batched = f.rows.filter(x => x.kind === "economy" && x.sku === AN.SKU.Batched).length;
	info(`${f.rows.length} economy events for 900 purchases (${batched} of them batches of different packs)`);
});

// ================================================================ 9: the Night funnel

section(
	"9) the Night funnel: one session per night lived in the city, each hour once, in order; a death closes it",
	() => {
		const s = bootServer();
		const A = s.A;
		s.sim.clock.setClock(18.8);
		const survivor = s.join(newUser(), "survivor");
		const mortal = s.join(newUser(), "mortal");
		const walker = s.join(newUser(), "walker");
		const late = s.join(newUser(), "late");
		for (const p of [survivor, mortal, walker, late]) s.immortal.add(p);
		for (const p of [survivor, mortal, walker]) {
			s.enter(p);
			s.active.add(p);
		}
		const night = p => s.of(p.UserId, "funnel").filter(r => r.funnel === A.NIGHT_PHASE_FUNNEL);
		const steps = p => JSON.stringify(night(p).map(r => r.step));
		check(
			s.runUntil(() => s.sim.clock.dayTime >= 19.2 && s.sim.clock.dayTime < 21, 200) >= 0,
			"the world clock reached 19:00",
		);
		// a survivor who walks in after nightfall: that night was not theirs from its start
		s.enter(late);
		s.active.add(late);
		check(
			s.runUntil(() => s.sim.clock.dayTime >= 22.2, 200) >= 0 &&
				steps(survivor) === "[1,2]" &&
				steps(mortal) === "[1,2]" &&
				steps(walker) === "[1,2]",
			"19:00 and 22:00: step 1 (Wave 1) and step 2 (Wave 2) for whoever stood in the city at nightfall",
			`${steps(survivor)} ${steps(mortal)} ${steps(walker)}`,
		);
		const first = night(survivor)[0];
		check(
			first?.name === "Wave 1 (19:00)" &&
				first.fields?.CustomField01 === "World day - 1" &&
				first.fields?.CustomField02 === "Life day - 1" &&
				first.fields?.CustomField03 === "Survivors - Group" &&
				night(survivor)[1].fields === undefined,
			"step 1 carries the breakdown (world day, life day, solo or group); the later steps carry none",
			JSON.stringify(night(survivor).map(r => [r.name, r.fields])),
		);
		check(steps(late) === "[]", "the one who walked in at 20:00 is in no session of this night (no skipped steps)");
		// 22:30: one dies and pays a Rebirth at once; one goes back to the lobby and stays there
		s.kill(mortal);
		const reborn = s.shop(mortal, { kind: "rebirth", runRev: s.live(mortal).runRev });
		s.immortal.add(mortal);
		s.intent(walker, s.P.IntentKind.LeaveWorld);
		s.active.delete(walker);
		check(
			s.runUntil(() => s.sim.clock.day === 2 && s.sim.clock.dayTime >= 6.1, 400) >= 0,
			"the world lived through midnight and 06:00",
		);
		const all = night(survivor);
		check(
			steps(survivor) === "[1,2,3,4,5]" &&
				all.every(r => r.session === all[0].session) &&
				JSON.stringify(all.map(r => r.name)) === JSON.stringify(A.NIGHT_PHASE_NAMES),
			"the survivor who stood all night: Wave 1, Wave 2, Midnight, Wave 3, Dawn -- once each, one session",
			JSON.stringify(all.map(r => [r.step, r.name])),
		);
		check(
			reborn.ok && s.body(mortal) !== undefined && !s.body(mortal).state.dead && steps(mortal) === "[1,2]",
			"the one who died at 22:30 stops at Wave 2: a Rebirth before midnight is a new body, not the night lived through",
			steps(mortal),
		);
		check(steps(walker) === "[1,2]", "the one who went to the lobby stops where they left the city");
		check(steps(late) === "[]", "…and the latecomer never enters this night's funnel, even at dawn");
		// the next evening: a jump of the clock lives through nothing, the next nightfall is a NEW session
		s.sim.clock.setClock(18.9);
		s.run(1.2);
		check(night(survivor).length === 5, "a clock that jumps (an admin's, a new town) crosses no hour");
		s.runUntil(() => s.sim.clock.dayTime >= 19.2, 100);
		const next = night(survivor).slice(5);
		check(
			next.length === 1 &&
				next[0].step === 1 &&
				next[0].session !== all[0].session &&
				next[0].fields.CustomField01 === "World day - 2-3" &&
				next[0].fields.CustomField02 === "Life day - 2-3",
			"the next nightfall opens a new session (a GUID of its own), world day 2 and life day 2",
			JSON.stringify(next.map(r => [r.session, r.step, r.fields])),
		);
		check(
			night(late).length === 1 && night(late)[0].step === 1,
			"…and the latecomer, standing at this nightfall, is in this one",
		);
		info(`a whole night of 4 players: ${s.log.filter(r => r.funnel === A.NIGHT_PHASE_FUNNEL).length} Night rows`);
	},
);

// ================================================================ 10: the Shop funnel

section("10) the Shop funnel: opened by the client, its buy asked for and bought, each once a visit; the guard", () => {
	const s = bootServer();
	const A = s.A;
	const { SHOP_PACKS, COSTUMES } = require(join(SRC, "shared/data/shop.ts"));
	const kit = SHOP_PACKS.findIndex(x => x.name === "First Night Kit");
	const dear = SHOP_PACKS.reduce((best, x, i) => (x.price > SHOP_PACKS[best].price ? i : best), 0);
	const a = s.join(newUser(), "shopper");
	s.run(1.2);
	const shopRows = () => s.of(a.UserId, "funnel").filter(r => r.funnel === A.SHOP_FUNNEL);
	// a purchase with no visit open starts no funnel (it would count "Opened" as done)
	const blind = s.shop(a, { kind: "buyPack", packId: kit });
	check(blind.ok && shopRows().length === 0, "a purchase with no visit open: no Shop row (never a skipped step 1)");
	// a visit in the lobby with no coins left: opened, a buy asked for and refused
	const opened = s.viewShop(a, 0);
	check(
		opened.ok === true && opened.wallet === undefined && opened.price === undefined,
		"viewShop is answered at once, with nothing charged and nothing decided",
	);
	s.shop(a, { kind: "buyPack", packId: dear });
	const v1 = shopRows();
	check(
		JSON.stringify(v1.map(r => r.step)) === "[1,2]" &&
			v1[0].name === "Opened" &&
			v1[1].name === "Tried to buy" &&
			v1[0].session === v1[1].session &&
			v1[0].fields.CustomField01 === "Screen - Packs" &&
			v1[0].fields.CustomField02 === "Coins - 0-9" &&
			v1[0].fields.CustomField03 === "Where - Lobby",
		"a visit whose buy was refused for coins: Opened (screen, the server's coins, lobby) then Tried to buy -- no Bought",
		JSON.stringify(v1.map(r => [r.step, r.name, r.fields])),
	);
	// the guard: a second open in the same second, and (later) screens that do not exist
	s.viewShop(a, 1);
	s.run(1.2);
	for (const bad of [2, -1, 0.5, "0", undefined]) s.viewShop(a, bad);
	check(shopRows().length === 2, "a second open within SHOP_OPEN_MIN_S, and unknown screens: nothing");
	// the wardrobe from the city, with coins: bought, and a second purchase in the same visit adds nothing
	s.live(a).money = 5000;
	s.immortal.add(a);
	s.enter(a);
	s.run(1.2);
	s.viewShop(a, 1);
	const byPrice = COSTUMES.map((c, i) => [c.price, i]).sort((x, y) => x[0] - y[0]);
	const [cheap, other] = [byPrice[0][1], byPrice[1][1]];
	const r1 = s.shop(a, { kind: "buyCostume", costumeId: cheap });
	const r2 = s.shop(a, { kind: "buyCostume", costumeId: other });
	const v2 = shopRows().slice(2);
	check(
		r1.ok &&
			r2.ok &&
			JSON.stringify(v2.map(r => r.step)) === "[1,2,3]" &&
			v2.every(r => r.session === v2[0].session) &&
			v2[0].session !== v1[0].session &&
			v2[0].fields.CustomField01 === "Screen - Wardrobe" &&
			v2[0].fields.CustomField02 === "Coins - 200+" &&
			v2[0].fields.CustomField03 === "Where - City" &&
			v2[2].name === "Bought",
		"a wardrobe visit from the city: Opened, Tried to buy, Bought -- once each, however many it buys",
		JSON.stringify(v2.map(r => [r.step, r.name, r.fields])),
	);
	// viewShop never takes a purchase token: 5 opens and then the whole burst of 6 purchases, at the same instant
	for (let i = 0; i < 5; i++) s.viewShop(a, 0);
	s.run(3.5);
	const burst = [];
	for (let i = 0; i < 6; i++) burst.push(s.shop(a, { kind: "buyPack", packId: kit }).reason ?? "ok");
	check(!burst.includes("rate"), "…and opening the shop never costs a purchase its token", burst.join(","));
	// a flood of opens, one a second for a minute: at most SHOP_VISITS_MAX visits a session
	for (let i = 0; i < 60; i++) {
		s.viewShop(a, 0);
		s.run(1.05);
	}
	const visits = shopRows().filter(r => r.step === 1).length;
	check(
		visits === A.SHOP_VISITS_MAX,
		"a client opening the shop every second for a minute: SHOP_VISITS_MAX visits, then nothing",
		`${visits} visits`,
	);
	// a visit is over SHOP_VISIT_S after it opened: a buy after that is no step of it (the module's own clock)
	const h = makeCore();
	const slowPlayer = fakePlayer(611, "slowshopper");
	const slowSave = blankSave();
	slowSave.money = 20;
	h.core.sessionLoaded(slowPlayer, "ok", slowSave);
	h.core.shopViewed(slowPlayer, 0);
	h.advance(A.SHOP_VISIT_S + 5);
	h.core.shopRequest(slowPlayer, { kind: "buyPack", packId: kit });
	check(
		JSON.stringify(h.rows.filter(r => r.funnel === A.SHOP_FUNNEL).map(r => r.step)) === "[1]",
		"a buy 10 minutes after the shop opened is no step of that visit",
	);
});

// ================================================================ 11: quit points and causes of death

section("11) SessionEnded: where and when each session quit; Died: the cause, read from the body", () => {
	const s = bootServer();
	const A = s.A;
	s.sim.clock.setClock(12);
	const lobby = s.join(newUser(), "lobbyist");
	const dead = s.join(newUser(), "deadquit");
	const hungry = s.join(newUser(), "hungry");
	const poisoned = s.join(newUser(), "poisoned");
	const bitten = s.join(newUser(), "bitten");
	for (const p of [dead, hungry, poisoned, bitten]) {
		s.immortal.add(p);
		s.enter(p);
	}
	// past the entry's spawn shield (server/sim/players.ts SPAWN_SHIELD_S)
	s.run(3.5);
	/** the body left to its own vitals: no god mode, and the hunger `immortal` refills no more */
	const mortal = p => {
		s.immortal.delete(p);
		const st = s.body(p).state;
		st.godMode = false;
		return st;
	};
	// L8 of the review of ca9494a: the cause is the LETHAL damage's source. The empty stomach takes the last hp...
	const h = mortal(hungry);
	h.hungry = 0;
	h.hp = 0.005;
	// ...the poison takes the last hp of a fed body...
	const q = mortal(poisoned);
	q.hungry = q.hungryMax;
	q.buffs.poison = 5;
	q.hp = 0.01;
	s.run(0.2);
	// ...and a starving body a blow finishes was killed by the blow
	const b = mortal(bitten);
	b.hungry = 0;
	s.run(0.5);
	const starvingWhenBitten = b.lastHurt;
	s.kill(bitten);
	s.kill(dead);
	const cause = p => customs(s, p.UserId, A.EVENT.Died)[0]?.fields.CustomField03;
	check(
		cause(hungry) === "Cause - Hunger" &&
			cause(poisoned) === "Cause - Poison" &&
			cause(dead) === "Cause - Horde" &&
			cause(bitten) === "Cause - Horde" &&
			starvingWhenBitten === 2,
		"the stomach's last tick is Hunger, the poison's Poison; a blow with no boss about is the Horde -- a starving body's too",
		`${cause(hungry)}, ${cause(poisoned)}, ${cause(dead)}, ${cause(bitten)} (lastHurt before the blow ${starvingWhenBitten})`,
	);
	s.run(1.2);
	s.quit(lobby);
	s.quit(dead);
	s.run(1.2);
	const ended = p => customs(s, p.UserId, A.EVENT.SessionEnded)[0];
	check(
		ended(lobby)?.fields.CustomField01 === "Where - Lobby" &&
			ended(lobby).fields.CustomField02 === "Time - Day" &&
			ended(lobby).fields.CustomField03 === "Visit - First" &&
			customs(s, lobby.UserId, A.EVENT.SessionKills).length === 0,
		"a new player who quits from the lobby: SessionEnded Where - Lobby (and no SessionKills: never entered)",
		JSON.stringify(ended(lobby)),
	);
	check(
		ended(dead)?.fields.CustomField01 === "Where - Dead",
		"one who quits while dead: Where - Dead -- the death screen as a quit point",
		JSON.stringify(ended(dead)),
	);
	// a second session of the same player, at night
	s.sim.clock.setClock(21);
	const again = s.join(lobby.UserId, "lobbyist");
	s.run(1.2);
	s.quit(again);
	s.run(1.2);
	const second = customs(s, lobby.UserId, A.EVENT.SessionEnded)[1];
	check(
		second?.fields.CustomField03 === "Visit - Returning" && second.fields.CustomField02 === "Time - Night",
		"the same player back at night: Visit - Returning, Time - Night",
		JSON.stringify(second),
	);
	// the cause's rule on its own: a blow is a boss's within a needle's reach (a dead or a far boss does not count); the
	// stomach's or the poison's last tick is theirs whoever stands near; rotten meat is nobody's to name
	const body = { x: 0, y: 0, lastHurt: 1 };
	const near = [{ x: 10, y: 0, hp: 10 }];
	check(
		A.causeOfDeath(body, [{ x: A.BOSS_REACH - 1, y: 0, hp: 10 }]) === "Cause - Boss" &&
			A.causeOfDeath(body, [{ x: A.BOSS_REACH + 1, y: 0, hp: 10 }]) === "Cause - Horde" &&
			A.causeOfDeath(body, [{ x: 10, y: 0, hp: 0 }]) === "Cause - Horde" &&
			A.causeOfDeath({ x: 0, y: 0 }, undefined) === "Cause - Horde" &&
			A.causeOfDeath({ x: 0, y: 0, lastHurt: 2 }, near) === "Cause - Hunger" &&
			A.causeOfDeath({ x: 0, y: 0, lastHurt: 3 }, near) === "Cause - Poison" &&
			A.causeOfDeath({ x: 0, y: 0, lastHurt: 4 }, near) === "Cause - Unknown" &&
			A.causeOfDeath(undefined, undefined) === "Cause - Unknown",
		"causeOfDeath: the lethal damage's source -- a blow near a living boss is Boss, else Horde; hunger and poison are theirs",
	);
});

// ================================================================ 11b: a death in the combat-log guard

/*
 * The review of 6e6dfa0: a survivor who quits mid-bite leaves the body 5 s in the fight (§7.2, the combat-log guard),
 * and it can die there -- after the session ended. Events are logged only while the Player is here (BEM-04,
 * `playerLeft`), so the session is summed up at the departure as always (SessionEnded "Where - City": where it left
 * the body), and the death in the guard is NOT logged after it: no Died, no Rebirth funnel for somebody gone. It is in
 * the save (runOver). Whichever PlayerRemoving handler runs first (Roblox sets no order). Before: a Died (and its
 * Rebirth funnel step) came in after SessionEnded, for a Player already gone.
 */
section("11b) a death in the combat-log guard: nothing logged after SessionEnded for a player who left", () => {
	const { createZombie } = require(join(SRC, "shared/game/entities.ts"));
	/** the stored document, as the next session anywhere would load it */
	const stored = userId => {
		const doc = fakeStore(require(join(SRC, "server/save/stores.ts")).SAVE_STORE).data.get(String(userId));
		return doc === undefined ? undefined : typeof doc.data === "string" ? JSON.parse(doc.data) : doc.data;
	};
	for (const reversed of [false, true]) {
		const s = bootServer();
		const A = s.A;
		s.sim.clock.setClock(12);
		const w = s.join(newUser(), "witness");
		s.immortal.add(w);
		s.enter(w);
		const p = s.join(newUser(), "quits mid-bite");
		const sp = s.enter(p);
		s.run(1.2);
		s.sim.horde.zombies.length = 0;
		for (let i = 0; i < 4; i++) {
			const z = createZombie(1, sp.state.x + 32 * Math.cos(i * 1.6), sp.state.y + 32 * Math.sin(i * 1.6), 5);
			z.detect = true;
			s.sim.horde.zombies.push(z);
		}
		sp.state.godMode = false;
		s.run(0.3);
		sp.state.hp = 3;
		s.quit(p, reversed);
		const atQuit = s.of(p.UserId).length;
		const lingering = s.host.lingering(p.UserId);
		s.run(7);
		const rows = s.of(p.UserId);
		const after = rows.slice(atQuit);
		const ended = customs(s, p.UserId, A.EVENT.SessionEnded);
		const order = reversed ? "analytics' handler first" : "the host's handler first";
		check(
			lingering &&
				sp.state.dead &&
				ended.length === 1 &&
				ended[0].fields.CustomField01 === "Where - City" &&
				after.length === 0 &&
				stored(p.UserId)?.runOver === true,
			`(${order}) quit mid-bite, died in the guard: SessionEnded at the departure, nothing after it; the death is in ` +
				"the save",
			`dead ${sp.state.dead}; SessionEnded ${ended.length} (${ended[0]?.fields.CustomField01}); after the departure: ` +
				`${after.map(r => r.name ?? r.kind).join(", ") || "nothing"}; stored runOver ${stored(p.UserId)?.runOver}`,
		);
	}
});

// ================================================================ 12: experiments (server/config/experiments.ts)

section("12) experiments: the welcome pack is read from the player's snapshot, once per new save, safely", () => {
	const { SHOP_PACKS } = require(join(SRC, "shared/data/shop.ts"));
	const kit = SHOP_PACKS.findIndex(x => x.name === "First Night Kit");
	// the variant: a First Night Kit for every new save
	const config = makeConfigService({ values: { pz_welcome_pack: kit } });
	const s = bootServer({ config });
	const A = s.A;
	const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
	const vet = newUser();
	const old = defaultSave();
	old.titleEpoch = 0;
	s.storeSave(vet, old);
	const fresh = s.join(newUser(), "fresh");
	const veteran = s.join(vet, "veteran");
	s.run(1.2);
	const joined = s.of(fresh.UserId, "onboarding")[0];
	check(
		s.live(fresh).packsBought[kit] === 1 &&
			joined?.fields?.CustomField01 === "Welcome pack - First Night Kit" &&
			s.live(fresh).money === 20,
		"a new save in the variant is given the pack (coins untouched), and Joined carries the arm",
		JSON.stringify({ bought: s.live(fresh).packsBought, joined }),
	);
	check(
		config.calls.snapshots === 1 &&
			config.calls.reads.length === 1 &&
			config.calls.reads[0].userId === fresh.UserId &&
			config.calls.reads[0].key === "pz_welcome_pack",
		"GetValue -- the call that enrolls -- ran once, for the new save only: the veteran is never enrolled",
		JSON.stringify(config.calls),
	);
	check(s.live(veteran).packsBought[kit] === 0, "…and the veteran is given nothing");
	s.immortal.add(fresh);
	s.enter(fresh);
	s.run(2);
	check(
		s.live(fresh).packsOpened[kit] === 1,
		"the pack is delivered in the city like a bought one (server/sim/backpack.ts)",
		JSON.stringify(s.live(fresh).packsOpened),
	);
	// a second session of that player: the save exists, nothing is read or given again
	s.quit(fresh);
	s.run(1.2);
	const back = s.join(fresh.UserId, "fresh");
	s.run(1.2);
	check(
		config.calls.reads.length === 1 && s.live(back).packsBought[kit] === 1,
		"the same player's next session: no read, no second pack",
	);

	// whatever the Creator Hub holds that is not a whole number in range is the game as it was
	const bad = ["0", 1.5, SHOP_PACKS.length, -2, true, { id: 0 }];
	let i = 0;
	const odd = makeConfigService({ values: () => ({ pz_welcome_pack: bad[i++] }) });
	const t = bootServer({ config: odd });
	const got = [];
	for (let k = 0; k < bad.length; k++) {
		const p = t.join(newUser(), `odd${k}`);
		got.push(
			`${t.live(p).packsBought.reduce((x, y) => x + y, 0)}:${t.of(p.UserId, "onboarding")[0]?.fields?.CustomField01}`,
		);
	}
	check(
		got.every(g => g === "0:Welcome pack - None"),
		"a string, a fraction, an index past the catalogue, -2, a boolean, a table: the fallback, no pack",
		got.join(" | "),
	);
	// a ConfigService that throws: the join goes on, the fallback holds, the warning is one fixed sentence
	const before = warnings.length;
	const u = bootServer({ config: makeConfigService({ throws: true }) });
	const p = u.join(newUser(), "unlucky");
	const w = warnings.slice(before).filter(l => l.includes("config:"));
	check(
		u.save(p) !== undefined &&
			u.live(p).packsBought.every(x => x === 0) &&
			u.of(p.UserId, "onboarding")[0]?.fields?.CustomField01 === "Welcome pack - None",
		"a snapshot that cannot be had: the save loads, no pack, the arm says None",
	);
	check(
		w.length === 1 && !w[0].includes(String(p.UserId)) && !w[0].includes(p.Name),
		"…and one warning, with no UserId or name in it",
		w.join(" | "),
	);
	// no ConfigService at all (every other boot of this suite): None
	const n = bootServer();
	const q = n.join(newUser(), "plain");
	check(
		n.of(q.UserId, "onboarding")[0]?.fields?.CustomField01 === "Welcome pack - None",
		"no ConfigService: Welcome pack - None",
	);
	const X = require(join(SRC, "server/config/experiments.ts"));
	const knob = { key: "k", fallback: -1, min: -1, max: 3 };
	check(
		X.knobValue(knob, 3) === 3 &&
			X.knobValue(knob, -1) === -1 &&
			X.knobValue(knob, 4) === -1 &&
			X.knobValue(knob, 0.5) === -1 &&
			X.knobValue(knob, Number.NaN) === -1 &&
			X.knobValue(knob, Infinity) === -1 &&
			X.knobValue(knob, undefined) === -1 &&
			X.WELCOME_PACK.fallback === -1 &&
			X.WELCOME_PACK.max === SHOP_PACKS.length - 1,
		"knobValue: a whole number inside the range, anything else the fallback (-1 = no pack, the game as it was)",
	);
});

// ================================================================ 13: the catalogue within the documented limits

section("12c) the wellbeing guards (DESIGN_RULES BEM-07, docs/ANALYTICS.md §15): the tail, the dawn, the break", () => {
	const W = require(join(SRC, "shared/data/wellbeing.ts"));
	const { readFileSync } = require("node:fs");
	// the buckets of the tail: a percentile is not on the dashboard, so the share past 2 h / 3 h is counted by bucket
	const cuts = [0, 14.9, 15, 59.9, 60, 119.9, 120, 179.9, 180, 600].map(m => AN.lengthBucket(m));
	check(
		JSON.stringify(cuts) ===
			JSON.stringify([
				"0-14 min",
				"0-14 min",
				"15-59 min",
				"15-59 min",
				"1-2 h",
				"1-2 h",
				"2-3 h",
				"2-3 h",
				"3 h+",
				"3 h+",
			]),
		"SessionLength's buckets: 0-14 min, 15-59 min, 1-2 h, 2-3 h, 3 h+ (the edges where they belong)",
		JSON.stringify(cuts),
	);
	// a town whose clock the test drives: noon for the first 95 minutes, then a night that runs to 06:30 in 200 s
	const h = makeCore();
	let t = 0;
	const NIGHT_AT = 95 * 60;
	const hour = () => (t < NIGHT_AT ? 12 : Math.min(6.5, 1 + ((t - NIGHT_AT) / 200) * 5.5));
	const bodies = new Map();
	h.core.bindWorld({
		dayTime: hour,
		day: () => (t < NIGHT_AT ? 1 : 2),
		bodyOf: pl => bodies.get(pl.UserId),
		standing: () => 1,
	});
	const load = (id, name) => {
		const pl = fakePlayer(id, name);
		h.core.sessionLoaded(pl, "ok", blankSave());
		h.core.enteredWorld(pl);
		bodies.set(id, { dead: false });
		return pl;
	};
	const leaver = load(1501, "leaver");
	const stayer = load(1502, "stayer");
	const risen = load(1503, "risen");
	let fresh;
	let dawnAt;
	let leftAt;
	const step = () => {
		t += 1;
		h.advance(1);
		h.core.poll();
	};
	while (t < NIGHT_AT + 400) {
		// a short session: it joins 30 minutes before the night
		if (t === NIGHT_AT - 30 * 60) fresh = load(1504, "short");
		step();
		if (dawnAt === undefined && t > NIGHT_AT && hour() >= 6) {
			dawnAt = t;
			// the server's decision at 06:00 (server/main.server.ts `sim.onDawn`, tested end to end in 12d): the line went
			// to the leaver and the stayer; the others did not earn it. A second call is the same session's: ignored
			h.core.breakNudge(leaver);
			h.core.breakNudge(stayer);
			h.core.breakNudge(stayer);
		}
		// the leaver goes 30 s after the dawn, the dawn window still open (06:00-07:30)
		if (dawnAt !== undefined && leftAt === undefined && t === dawnAt + 30) {
			leftAt = t;
			leaver.Parent = undefined;
			h.core.playerLeft(leaver);
		}
	}
	const nudges = id => h.rows.filter(r => r.userId === id && r.kind === "custom" && r.name === AN.EVENT.BreakNudge);
	const ended = id => h.rows.find(r => r.userId === id && r.name === AN.EVENT.SessionEnded);
	const length = id => h.rows.find(r => r.userId === id && r.name === AN.EVENT.SessionLength);
	check(
		nudges(1501).length === 1 &&
			nudges(1501)[0].fields.CustomField01 === "Left - Yes" &&
			nudges(1501)[0].t === leftAt,
		"told the line and left 30 s after it: one BreakNudge, Left - Yes -- logged AT the leave, while the Player is still there",
		JSON.stringify(nudges(1501).map(r => [r.fields, r.t - leftAt])),
	);
	check(
		nudges(1502).length === 1 &&
			nudges(1502)[0].fields.CustomField01 === "Left - No" &&
			nudges(1502)[0].t - dawnAt > W.BREAK_NUDGE_LEFT_S &&
			nudges(1502)[0].t - dawnAt <= W.BREAK_NUDGE_LEFT_S + 2,
		"one that stayed: Left - No, sent when the 2 minutes ran out (and only once, told twice or not)",
		JSON.stringify(nudges(1502).map(r => [r.fields.CustomField01, r.t - dawnAt])),
	);
	check(
		nudges(1503).length === 0 && nudges(1504).length === 0,
		"no BreakNudge for a session the server did not give the line to: analytics decides nothing of its own",
	);
	check(
		ended(1501)?.fields.CustomField02 === "Time - Dawn" &&
			length(1501)?.fields.CustomField01 === "Length - 1-2 h" &&
			length(1501)?.value === ended(1501)?.value,
		"the leaver's SessionEnded says Time - Dawn (06:00-07:30), and its SessionLength is the same minutes, Length - 1-2 h",
		JSON.stringify([ended(1501)?.fields, length(1501)?.fields, length(1501)?.value]),
	);
	// the others leave later in the day: after the dawn window it is Day again
	t += 1;
	const late = () => {
		for (const pl of [stayer, risen, fresh]) {
			pl.Parent = undefined;
			h.core.playerLeft(pl);
		}
		h.core.poll();
	};
	const hourBefore = hour();
	late();
	check(
		hourBefore >= 6 &&
			hourBefore < W.DAWN_END_HOUR &&
			ended(1502)?.fields.CustomField02 === "Time - Dawn" &&
			length(1504)?.fields.CustomField01 === "Length - 15-59 min",
		"still in the dawn window: Time - Dawn for the others too; the short session is Length - 15-59 min",
		JSON.stringify([hourBefore, ended(1502)?.fields, length(1504)?.fields]),
	);
	check(
		W.isDawnAt(6) && W.isDawnAt(7.49) && !W.isDawnAt(7.5) && !W.isDawnAt(5.99) && !W.isDawnAt(12),
		"the dawn window is 06:00 to 07:30 of the world clock (shared/data/wellbeing.ts isDawnAt)",
	);
	check(
		W.BREAK_NUDGE_MIN === 90 &&
			readFileSync(join(SRC, "shared/data/lang.ts"), "utf8").includes(
				'"You\'ve played for over 90 minutes. Dawn is a good time for a break."',
			),
		"the line the player reads says the number the rule uses (BREAK_NUDGE_MIN = 90)",
	);

	// how they left (L7 of the reviews of ca9494a and 440af66): the verdict is logged AT the leave (PlayerRemoving: the
	// Player is still there), and only a leave of their own is a Yes -- a kick, a teleport to another server of this
	// game, a close or a restart under way, a leave noticed late: `Left - Unknown`
	{
		const c = makeCore();
		const ids = [2101, 2102, 2103, 2104, 2105, 2106, 2107];
		const pl = new Map(
			ids.map(id => {
				const p = fakePlayer(id, `leave${id}`);
				c.core.sessionLoaded(p, "ok", blankSave());
				c.core.enteredWorld(p);
				return [id, p];
			}),
		);
		c.core.poll();
		for (const p of pl.values()) c.core.breakNudge(p);
		c.advance(10);
		// 2104 asked for a teleport (Play solo, the Servers list) that went through; 2105 asked for one that failed, and
		// only left 90 s later -- a leave of its own
		c.core.teleporting(pl.get(2104));
		c.core.teleporting(pl.get(2105));
		c.advance(5);
		const leave = (id, how) => {
			pl.get(id).Parent = undefined;
			c.core.playerLeft(pl.get(id), how);
		};
		leave(2101, "left");
		leave(2103, "kicked");
		leave(2104, "left");
		c.advance(85);
		leave(2105, "left");
		// 2106 is gone without a PlayerRemoving this module saw: the poll notices it, late
		pl.get(2106).Parent = undefined;
		c.core.poll();
		const left = id =>
			c.rows.filter(r => r.userId === id && r.name === AN.EVENT.BreakNudge).map(r => r.fields.CustomField01);
		const got = Object.fromEntries(ids.map(id => [id, left(id).join()]));
		check(
			got[2101] === "Left - Yes" &&
				got[2103] === "Left - Unknown" &&
				got[2104] === "Left - Unknown" &&
				got[2105] === "Left - Yes" &&
				got[2106] === "Left - Unknown" &&
				got[2102] === "" &&
				got[2107] === "",
			"a leave of their own is Yes; a kick (admin, flood), a teleport's leave, a leave the poll found late: Unknown; a teleport that failed long before is not",
			JSON.stringify(got),
		);
		// then the platform schedules a restart: 2107 leaves after it -- the restart's; 2102 is still here at the close
		c.core.restartScheduled();
		leave(2107, "left");
		c.core.shutdown();
		check(
			left(2107).join() === "Left - Unknown" && left(2102).join() === "Left - Unknown" && left(2101).length === 1,
			"a leave once a restart is scheduled, and a player the close finds here: Unknown -- nothing logged twice",
			JSON.stringify([left(2107), left(2102), left(2101)]),
		);
		check(
			AN.exitHow(Enum.PlayerExitReason.CreatorKick) === "kicked" &&
				AN.exitHow(Enum.PlayerExitReason.PlatformKick) === "kicked" &&
				AN.exitHow(Enum.PlayerExitReason.Unknown) === "left" &&
				AN.exitHow(undefined) === "left",
			"PlayerExitReason: CreatorKick (Player:Kick -- the admin's and the flood kick) and PlatformKick are kicks; Unknown, the catch-all, is a leave",
		);
		const src = readFileSync(join(SRC, "server/analytics/events.ts"), "utf8");
		const hosts = ["server/match/matchHost.ts", "server/match/serverList.ts"].map(f =>
			readFileSync(join(SRC, f), "utf8"),
		);
		check(
			/Players\.PlayerRemoving\.Connect\(\(player, reason\) =>\s*guard\(c => c\.playerLeft\(player, exitHow\(reason\)\)\),?\s*\);/.test(
				src,
			) &&
				/game\.ServerRestartScheduled\.Connect\(\(\) => guard\(c => c\.restartScheduled\(\)\)\)/.test(src) &&
				hosts.every(h =>
					/Analytics\.teleporting\(player\);[^]{0,400}TeleportAsync\(game\.PlaceId, \[player\]/.test(h),
				),
			"wired: PlayerRemoving hands its exit reason in, a scheduled restart is heard, and both teleports (Play solo, the Servers list) are marked BEFORE TeleportAsync",
		);
	}
});

section("12d) the break line is ONE decision, the server's: the line a player gets and the event counted agree", () => {
	const s = bootServer();
	const W = require(join(SRC, "shared/data/wellbeing.ts"));
	// every Announce{BreakNudge} a client receives, counted as it goes out (the fake remote keeps only its last 4000
	// sends, fewer than three nights of World batches)
	const world = s.env.services.ReplicatedStorage.FindFirstChild("Net").FindFirstChild("World");
	const nudged = new Map();
	const fireClient = world.FireClient.bind(world);
	world.FireClient = (player, ...args) => {
		const batch = s.P.decodeWorld(args[0]);
		for (const e of batch?.events ?? []) {
			if (e.t === s.P.WorldEv.Announce && e.msg === s.P.AnnounceKind.BreakNudge) {
				nudged.set(player, (nudged.get(player) ?? 0) + 1);
			}
		}
		return fireClient(player, ...args);
	};
	const fireAll = world.FireAllClients.bind(world);
	let broadcast = 0;
	world.FireAllClients = (...args) => {
		const batch = s.P.decodeWorld(args[0]);
		for (const e of batch?.events ?? []) {
			if (e.t === s.P.WorldEv.Announce && e.msg === s.P.AnnounceKind.BreakNudge) broadcast += 1;
		}
		return fireAll(...args);
	};
	const told = p => nudged.get(p) ?? 0;
	const counted = p => customs(s, p.UserId, s.A.EVENT.BreakNudge).map(r => r.fields.CustomField01);
	/**
	 * From `hour` (before midnight) the world runs to the next 06:00; `during(clock)` runs every beat after midnight.
	 * 30 beats a second: the simulation runs at most MAX_CATCHUP_TICKS (2) ticks a heartbeat, so the night is real time.
	 */
	const toDawn = (hour, during) => {
		s.sim.clock.setClock(hour);
		let wrapped = false;
		return s.runUntil(
			() => {
				const c = s.sim.clock;
				if (c.dayTime < hour - 1) wrapped = true;
				if (wrapped) during?.(c);
				return wrapped && c.dayTime >= 6;
			},
			400,
			1 / 30,
		);
	};
	s.sim.clock.setClock(12);
	const long = s.join(newUser(), "long");
	const away = s.join(newUser(), "away");
	const kicked = s.join(newUser(), "kicked");
	for (const p of [long, away, kicked]) {
		s.immortal.add(p);
		s.enter(p);
	}
	s.run(1.2);
	// BREAK_NUDGE_MIN of session go by on the server's clock (the world's is set below)
	clockNow += (W.BREAK_NUDGE_MIN + 1) * 60;
	const short = s.join(newUser(), "short");
	s.immortal.add(short);
	s.enter(short);
	// `away` is in the lobby at midnight and walks back in at 03:00: it did not live this night
	s.intent(away, s.P.IntentKind.LeaveWorld);
	s.run(0.6);
	let backIn = false;
	const first = toDawn(23.9, c => {
		if (!backIn && c.dayTime >= 3) {
			backIn = true;
			s.enter(away);
		}
	});
	s.run(0.5);
	check(
		first >= 0 &&
			backIn &&
			told(long) === 1 &&
			told(kicked) === 1 &&
			told(short) === 0 &&
			told(away) === 0 &&
			broadcast === 0,
		`at 06:00 the line goes to each ${W.BREAK_NUDGE_MIN}-minute session that lived the night standing, to it alone (Announce{BreakNudge}, directed)`,
		JSON.stringify({ first, long: told(long), kicked: told(kicked), short: told(short), away: told(away) }),
	);
	// `kicked` is kicked 10 s later (an admin's kick, the flood kick: Player:Kick is PlayerExitReason.CreatorKick),
	// through the module's own PlayerRemoving handler
	s.run(10, 0.25);
	{
		const { Players } = s.env.services;
		Players.list = Players.list.filter(x => x !== kicked);
		Players.PlayerRemoving.Fire(kicked, Enum.PlayerExitReason.CreatorKick);
		kicked._parent = undefined;
	}
	// the long one reads it and goes, 30 s after it
	s.run(20, 0.25);
	s.quit(long);
	const longAt = counted(long);
	s.run(7, 0.25);
	check(
		JSON.stringify(longAt) === '["Left - Yes"]' &&
			JSON.stringify(counted(long)) === '["Left - Yes"]' &&
			JSON.stringify(counted(kicked)) === '["Left - Unknown"]' &&
			counted(short).length === 0 &&
			counted(away).length === 0,
		"...and the event counts exactly those told: Left - Yes logged at the leave itself; the kicked one's Unknown; none for the others",
		JSON.stringify({ long: counted(long), kicked: counted(kicked), short: counted(short), away: counted(away) }),
	);
	// the next night `away` lives standing: its line then -- and it stays past the 2 minutes (Left - No)
	const second = toDawn(23.9);
	s.run(0.5);
	const awayAfterSecond = told(away);
	s.run(W.BREAK_NUDGE_LEFT_S + 2, 0.25);
	// `short` is a long session by the third night; `away` already had its line this session
	clockNow += (W.BREAK_NUDGE_MIN + 1) * 60;
	const third = toDawn(23.9);
	s.run(0.5);
	check(
		second >= 0 &&
			third >= 0 &&
			awayAfterSecond === 1 &&
			JSON.stringify(counted(away)) === '["Left - No"]' &&
			told(away) === 1 &&
			told(short) === 1,
		"a session that lives the next night gets its line then (and stayed: Left - No); once a session -- the third dawn tells it nothing, and tells the now-long one",
		JSON.stringify({
			second,
			third,
			awayAfterSecond,
			away: told(away),
			short: told(short),
			counted: counted(away),
		}),
	);
	// the server closes (an update) inside the 2 minutes after `short`'s line: nobody can say it chose to go
	const sent = new Map([long, away, short, kicked].map(p => [p, told(p)]));
	s.shutdown();
	check(
		JSON.stringify(counted(short)) === '["Left - Unknown"]' && JSON.stringify(counted(away)) === '["Left - No"]',
		"a close inside the 2 minutes: Left - Unknown, never Yes",
		JSON.stringify({ away: counted(away), short: counted(short) }),
	);
	const disagree = [long, away, short, kicked].filter(p => sent.get(p) !== counted(p).length);
	check(
		disagree.length === 0,
		"every line counted is a line sent, and every line sent is counted (told = BreakNudge rows, per player)",
		disagree.map(p => `${p.Name}: told ${sent.get(p)}, counted ${counted(p).length}`).join("; "),
	);
});

section(
	"12b) MP-26: JoinedFromList is counted where the player ARRIVES (review of 0b44458, L5), once a session",
	() => {
		const h = makeCore();
		const pl = fakePlayer(611, "traveller");
		const save = blankSave();
		save.bestDay = 9;
		// the join data is read when the player joins, before the save is here: the event waits for it
		h.core.arrivedFromList(pl, 6, 3);
		const before = h.rows.filter(r => r.name === "JoinedFromList").length;
		h.core.sessionLoaded(pl, "ok", save);
		const rows = h.rows.filter(r => r.name === "JoinedFromList");
		check(
			before === 0 &&
				rows.length === 1 &&
				rows[0].value === 6 &&
				rows[0].fields?.CustomField01 === "Players - 2-3" &&
				rows[0].fields?.CustomField02 === "World day - 4-7" &&
				rows[0].fields?.CustomField03 === "Best day - 8-14",
			"an arrival waits for the save, then ONE JoinedFromList: this town's day, how full it was, the player's best day",
			JSON.stringify(rows.map(r => ({ value: r.value, fields: r.fields }))),
		);
		// a retry loads the session again: still one
		h.core.sessionLoaded(pl, "ok", save);
		check(
			h.rows.filter(r => r.name === "JoinedFromList").length === 1,
			"...once a session, even when the save loads again",
		);
		// somebody who leaves before their save is here is never counted, and is not remembered
		const gone = fakePlayer(612, "gone");
		h.core.arrivedFromList(gone, 2, 1);
		h.core.playerLeft(gone);
		h.core.sessionLoaded(gone, "ok", blankSave());
		check(
			h.rows.filter(r => r.name === "JoinedFromList" && r.userId === 612).length === 0,
			"...and an arrival that left before its save loaded is forgotten, never counted later",
		);
	},
);

section("12e) MON-07: the Supporter subscription seen starting or ending in a session, one event per flip", () => {
	const h = makeCore();
	const pl = fakePlayer(631, "supporter");
	const save = blankSave();
	// before the session is here there is no entry: nothing
	h.core.supporterChanged(pl, true);
	check(h.rows.filter(r => r.name === "Supporter").length === 0, "no session yet: no Supporter event");
	h.core.sessionLoaded(pl, "ok", save);
	h.core.supporterChanged(pl, true);
	h.core.enteredWorld(pl);
	h.core.poll();
	h.core.supporterChanged(pl, false);
	const rows = h.rows.filter(r => r.name === "Supporter");
	check(
		rows.length === 2 &&
			rows.every(r => r.kind === "custom" && r.value === undefined) &&
			rows[0].fields?.CustomField01 === "Status - Started" &&
			rows[0].fields?.CustomField02 === "Where - Lobby" &&
			rows[1].fields?.CustomField01 === "Status - Ended" &&
			rows[1].fields?.CustomField02 === "Where - City",
		"a subscription started in the lobby and ended in the city: two events, no value, the status and where",
		JSON.stringify(rows.map(r => [r.kind, r.value, r.fields])),
	);
	check(
		h.rows.filter(r => r.kind === "economy").length === 0,
		"and no economy event: a subscription moves no coin (MON-07; its revenue is the platform's dashboard)",
	);
	h.core.playerLeft(pl);
	h.core.supporterChanged(pl, true);
	check(h.rows.filter(r => r.name === "Supporter").length === 2, "after leaving: nothing more");
});

section("13) every row of this run: within the documented limits, low cardinality, no PII", () => {
	const A = require(join(SRC, "server/analytics/events.ts"));
	const rows = EVERY_ROW;
	const distinctOf = arr => arr.filter((v, i) => arr.indexOf(v) === i);
	const funnels = distinctOf(rows.filter(r => r.kind === "funnel").map(r => r.funnel));
	// the onboarding funnel is one of the dashboard's ten tabs too
	check(funnels.length + 1 <= 10, "funnels: at most 10 (event-types.md)", `${funnels.join(", ")} + Onboarding`);
	let stepsOk = true;
	const names = new Map();
	for (const r of rows) {
		if (r.kind !== "funnel" && r.kind !== "onboarding") continue;
		if (!(Number.isInteger(r.step) && r.step >= 1 && r.step <= 100)) stepsOk = false;
		const k = `${r.funnel ?? "Onboarding"}#${r.step}`;
		if (names.has(k) && names.get(k) !== r.name) stepsOk = false;
		names.set(k, r.name);
	}
	check(stepsOk, "every step a whole number in 1-100, one name per step of a funnel (the dashboard's labels)");
	check(
		rows.filter(r => r.kind === "funnel" && r.session === undefined).every(r => r.funnel === A.LEVEL_FUNNEL),
		"only the one-time Levels funnel goes without a funnelSessionId",
	);
	const events = distinctOf(rows.filter(r => r.kind === "custom").map(r => r.name));
	check(
		events.length <= 100 && events.every(e => Object.values(A.EVENT).includes(e)),
		"custom events: the catalogue's",
		events.join(", "),
	);
	const eco = rows.filter(r => r.kind === "economy");
	const tx = distinctOf(eco.map(r => r.tx));
	const skus = distinctOf(eco.map(r => r.sku));
	// (a pure core's rows are the module's own events: the currency is added by the AnalyticsService sink)
	const currencies = distinctOf(eco.map(r => r.currency ?? A.CURRENCY));
	check(
		currencies.length === 1 && tx.length <= 20 && skus.length <= 100,
		"economy: 1 currency (5 allowed), transaction types ≤ 20, SKUs ≤ 100",
		`${tx.length} types, ${skus.length} SKUs`,
	);
	// every value a field ever held, against the catalogue's closed sets
	const bucket = "(1|2-3|4-7|8-14|15-29|30\\+)";
	const allowed = [
		`Life day - ${bucket}`,
		`World day - ${bucket}`,
		"Time - (Night|Dawn|Day)",
		"Length - (0-14 min|15-59 min|1-2 h|2-3 h|3 h\\+)",
		"Left - (Yes|No|Unknown)",
		"Survivors - (Solo|Group)",
		"Cause - (Hunger|Poison|Boss|Horde|Unknown)",
		"Choice - (Accepted|Declined)",
		"End - (New game|World end)",
		"Rebirths - (0|1|2|3\\+)",
		"Continue - (1|2|3|4\\+)",
		"Afford - (Yes|No)",
		"Reason - (Timeout|Declined|Restarted)",
		"Fallen - (0|1|2|3\\+)",
		// MP-26: JoinedFromList (docs/ANALYTICS.md §5)
		"Players - (1|2-3|4\\+)",
		`Best day - ${bucket}`,
		"Kills - (0|1-9|10-49|50-199|200\\+)",
		"Kind - (Crafted|Cooked|Smelted)",
		"Category - (Pack|Costume)",
		"Screen - (Packs|Wardrobe)",
		"Coins - (0-9|10-49|50-199|200\\+)",
		"Where - (Lobby|City|Dead)",
		"Visit - (First|Returning)",
		`Weapon - (${A.WEAPON_KIND_NAMES.join("|")}|Machine|Other)`,
		"Title - .+",
		// MON-07: the Supporter subscription's flips (docs/ANALYTICS.md §5)
		"Status - (Started|Ended)",
		"Welcome pack - .+",
		// where a survivor plays (server/match/*, tools/test-match.mjs): the NewTown funnel, TownOffered, TripFailed
		"Route - (Play solo|Offer)",
		`Best day - ${bucket}`,
		`Stage - (${A.TRIP_STAGES.join("|")})`,
		`Result - (${A.TRIP_RESULTS.join("|")})`,
	].map(p => new RegExp(`^${p}$`));
	const values = [];
	const combos = [];
	let keysOk = true;
	for (const r of rows) {
		if (r.fields === undefined) continue;
		for (const [k, v] of Object.entries(r.fields)) {
			if (!["CustomField01", "CustomField02", "CustomField03"].includes(k) || typeof v !== "string")
				keysOk = false;
			values.push(v);
		}
		combos.push(`${r.fields.CustomField01}|${r.fields.CustomField02}|${r.fields.CustomField03}`);
	}
	const strays = distinctOf(values).filter(v => !allowed.some(re => re.test(v)));
	check(keysOk, "fields: only CustomField01-03, strings only (custom-fields.md)");
	check(strays.length === 0, "every field value is one of the catalogue's fixed strings", strays.join(" | "));
	// the ceiling by construction: each field's closed set multiplied per event, summed (titles: 3, packs: 9 + None)
	const { TITLES } = require(join(SRC, "shared/data/titles.ts"));
	const { SHOP_PACKS } = require(join(SRC, "shared/data/shop.ts"));
	const B = 6;
	const ceiling =
		2 + // TutorialChoice
		B * 2 * 5 + // Died: life day x time x cause
		2 * B * 4 + // LifeEnded
		3 * 4 * B + // WorldEnded: reason (MP-26: Restarted too) x fallen (0 to 3+) x days
		TITLES.length + // TitleEarned
		2 * 2 + // Supporter (MON-07): started / ended x lobby / city
		5 + // SessionKills
		3 + // Crafted
		3 * 3 * 2 + // SessionEnded: where x time (night, dawn, day) x visit (+ its combos without the hour)
		3 * 2 +
		5 + // SessionLength: the length bucket
		3 + // BreakNudge: left, stayed, or a close nobody can read
		(A.WEAPON_KIND_NAMES.length + 2) + // WeaponKills
		4 + // Rebirth economy: Continue
		2 + // Shop economy: Category
		(SHOP_PACKS.length + 1) + // onboarding: Welcome pack
		B * B * 2 + // Night step 1
		4 * 2 * B + // Rebirth step 1
		2 * 4 * 2 + // Shop step 1
		B * B * 2 + // TownOffered: world day x record x visit
		A.TRIP_STAGES.length * A.TRIP_RESULTS.length * 2 + // TripFailed: stage x result x route
		2 * B * B + // NewTown step 1: route x world day x life day
		3 * B * B; // JoinedFromList (MP-26): players x world day x record
	check(
		ceiling < 8000 && distinctOf(combos).length <= ceiling,
		"unique combinations of the three fields: bounded by the catalogue far below 8,000 (the experience's limit)",
		`ceiling ${ceiling}, seen ${distinctOf(combos).length}`,
	);
	// no PII: nothing a player could be found by -- no UserId, no name -- in any string that leaves the server
	let pii = [];
	for (const r of rows) {
		const strings = [r.name, r.funnel, r.session, r.sku, r.tx, ...Object.values(r.fields ?? {})].filter(
			x => typeof x === "string",
		);
		for (const x of strings) {
			// (names of 4+ letters: "a" is in half the catalogue's words)
			const named = typeof r.playerName === "string" && r.playerName.length >= 4 && x.includes(r.playerName);
			if ((r.userId !== undefined && x.includes(String(r.userId))) || named) {
				pii.push(`${r.kind}:${x}`);
			}
		}
	}
	check(
		pii.length === 0,
		`no UserId and no name in any of the ${rows.length} rows' strings`,
		pii.slice(0, 5).join(" | "),
	);
});

// ================================================================ 14: the Error Report

section("14) the Error Report: every warning is a fixed sentence (ids, names and counts go to the log line)", () => {
	// error-report.md: grouped by MESSAGE, 500 unique a 6 h window -- "Player 12345 failed to load" is a row per player
	const { readdirSync, readFileSync, statSync } = require("node:fs");
	const files = [];
	const walk = d => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			if (statSync(p).isDirectory()) walk(p);
			else if (p.endsWith(".ts")) files.push(p);
		}
	};
	walk(SRC);
	// interpolations that are the same on every occurrence of a warning: constants, the fixed name of a step or a
	// hook, a data key of the catalogue, and the error text itself (the engine's or ours, with its traceback)
	const stable = [
		/^GAME_NAME$/,
		/^LOG_PREFIX$/,
		/^WHISPER_COMMAND$/,
		/^STORE_RETRY_S$/,
		/^HANDSHAKE_WARN_S$/,
		/^tostring\((err|value|result|res|storeValue|lastErr|written|raw)\)$/,
		/^outcome\.err$/,
		/^(what|where|hook|message|why|failure|name|kind)$/,
	];
	const offenders = [];
	let calls = 0;
	for (const f of files) {
		const src = readFileSync(f, "utf8");
		let at = 0;
		while ((at = src.indexOf("warn(", at)) >= 0) {
			const before = src[at - 1];
			at += 5;
			if (before !== undefined && /[\w.]/.test(before)) continue;
			// the argument, to its closing parenthesis
			let depth = 1;
			let end = at;
			while (end < src.length && depth > 0) {
				if (src[end] === "(") depth++;
				else if (src[end] === ")") depth--;
				end++;
			}
			const arg = src.slice(at, end - 1);
			if (arg.includes("...")) continue; // a shim's own `warn(...a)`, not a message
			calls += 1;
			for (const m of arg.matchAll(/\$\{([^}]*)\}/g)) {
				const expr = m[1].trim();
				if (!stable.some(re => re.test(expr))) {
					offenders.push(`${f.slice(SRC.length + 1)}: \${${expr}}`);
				}
			}
		}
	}
	check(
		offenders.length === 0,
		`the ${calls} warn() calls of src/ interpolate nothing that changes between occurrences`,
		offenders.join(" | "),
	);
	// and at run time: two analytics faults a minute apart are the same row
	let now = 0;
	const lines = [];
	const origWarn = globalThis.warn;
	globalThis.warn = (...a) => lines.push(a.join(" "));
	try {
		const bad = new AN.ServerAnalytics(
			{
				deliver() {
					throw new Error("AnalyticsService is down");
				},
			},
			{ clock: () => now },
		);
		const s1 = blankSave();
		bad.sessionLoaded(fakePlayer(901, "faulty"), "new", s1);
		now = 61;
		bad.dayCoins(s1, 3, 0);
	} finally {
		globalThis.warn = origWarn;
	}
	check(
		lines.length === 2 && lines[0] === lines[1] && !lines[0].includes("so far"),
		"two analytics faults a minute apart: the very same message (the count is the log line after it)",
		lines.join(" | "),
	);
});

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
