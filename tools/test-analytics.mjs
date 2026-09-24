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
 *                            stood is not a second life), WorldEnded once per world.
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
function section(title, fn) {
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
 * The recorder standing in for AnalyticsService: every call, decoded into one row with the clock it was made at.
 * `userId` is the Player's; a row never carries a Player further than that.
 */
function makeAnalyticsService(log) {
	const row = (player, r) => {
		const out = { ...r, userId: player?.UserId, t: clockNow };
		log.push(out);
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

let guid = 0;
function makeGame({ studio = false, analytics = true } = {}) {
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
		GenerateGUID: () => `guid-${++guid}`,
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
		quit(p) {
			Players.list = Players.list.filter(x => x !== p);
			Players.PlayerRemoving.Fire(p);
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
		/** a zombie put down by this survivor, through the server's kill credit (XP `exp`) */
		killZombie(p, exp = 0) {
			const sp = server.body(p);
			server.zombieId = (server.zombieId ?? 900000) + 1;
			server.sim.progress.zombieKilled(server.zombieId, exp, sp.slot, clockNow);
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
	Object.assign(vet, { level: 12, exp: 5, day: 4, bestDay: 4, money: 50, tutorialDone: true, firstInstall: false });
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
		start: { [decliner]: 0, [late]: 0, [lobby]: 0, [killer]: 0, [veteran]: 50, [returning]: 26 },
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
			died[0].fields.CustomField03 === "Survivors - Group",
		"Died: the life's day as the value, its bucket, night or day, alone or in a group",
		JSON.stringify(died.map(r => [r.value, r.fields])),
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
	// phase 2: 300 more each over 30 s
	for (let t = 0; t < 30; t++) {
		for (let k = 0; k < 10; k++) for (const pl of ps) s.killZombie(pl, 0);
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
			rows.push({ ...ev, userId: ev.player.UserId, player: undefined, t: now });
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
	for (let t = 0; t < 3600; t++) {
		h.advance(1);
		const inDay = t % DAY_S;
		for (const { save } of players) {
			save.zombieKills += 2;
			awardExp(save, 20);
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
				h.core.death(save, 1, 6);
				// (the coins for it are not the point here: the count of events is)
				const price = rebirthPrice(save.deathCount);
				save.deathCount += 1;
				save.runRev += 1;
				h.core.shopAction(pl, { kind: "rebirth" }, price);
			}
		}
		if (t % 180 === 90) {
			const id = t % SHOP_PACKS.length;
			for (const { pl } of players) h.core.shopAction(pl, { kind: "buyPack", packId: id }, SHOP_PACKS[id].price);
		}
		if (t === 2000) {
			for (const { save } of players) {
				h.core.death(save, 23, 6);
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
	const perMinute = maxPerMinute(h.rows);
	const cap = h.core.capNow();
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

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
