#!/usr/bin/env node
/*
 * The night is delivered (docs/MULTIPLAYER.md §3.5, §4.3; docs/DESIGN_RULES.md MP-21).
 *
 *   npm run test:waves                    # everything (exit code 1 on any failure)
 *   node tools/test-waves.mjs --seed 7    # another spawn seed (default 1)
 *   node tools/test-waves.mjs --hard 10   # also measure section 4 on the night of day 10 (default: off)
 *   PZ_SRC=path/to/src node tools/test-waves.mjs
 *
 * A playtest reported "no zombies in the night waves". Neither the clock nor the queues were wrong — both were
 * covered and both were right (tools/test-clock.mjs). What nothing had ever run end to end was the one link
 * between them and the street: queue → the REAL spawner → a zombie in the world. tools/test-clock.mjs drains
 * the queues with a stand-in that decrements them without calling the population, so it could not see that
 * `rebuildClusters` (shared/sim/ai/population.ts) groups only the LIVING: with the only survivor dead there is
 * no cluster, the spawn loop never runs, and the queues filled at 18:00 are never drained — nothing is born,
 * ambient or wave, for as long as the body lies there.
 *
 * This file runs the chain the live server runs — `new ServerSimulation({ world })` exactly as
 * server/net/mpHost.ts builds it → WorldClock → ZombieWorld → ServerPopulation → Population — with the real
 * `createServerPlayer`, the real Replicator and the generated town, deterministically:
 *
 *   1. THE NIGHT IS DELIVERED   a living survivor from 07:00 of day 1 to the evening of day 2 (~1.6 game days
 *                               at 1/60 s): at 18:00 the queues are the day's table, every zombie they promised
 *                               is born with `wave === true` before 06:00, and the queues are empty at daybreak.
 *   2. THE STERILE WORLD        the same run, the survivor dead from 09:00 and nobody to stand them up: no
 *                               cluster, nothing born, the queues untouched all night. Since the owner's rule of
 *                               23 Sep 2026 every server stands its dead up at daybreak (MP-21) and a world with
 *                               nobody alive ENDS 30 s after the fall and a new town begins (MP-22,
 *                               server/sim/worldReset.ts); this harness has no LifeKeeper, so this case pins what
 *                               a world with only the dead in it does while it lasts — and the population's stall
 *                               counter has to say so.
 *   3. DAYBREAK UNLOCKS IT      dead at 19:30, stood back up at 06:00 the way the server does it
 *                               (`daybreakWaitSeconds`, then the stand-up: a fresh body at a safe
 *                               spawn point and LifeState.Up on the wire): the spawn comes back and the NEXT
 *                               night is delivered whole.
 *   4. WHAT THE WIRE CARRIES    reported, not checked. §4.3 sends a zombie in the dark only when it stands in
 *                               some light or within DARK_SENSE_RANGE, and wave zombies are born 720–1080 u
 *                               away: how many of them does a survivor who stands still, and one who runs,
 *                               actually receive during the night? By design (anti-ESP) — but it is the risk of
 *                               a player concluding "the wave never came", so the number is printed.
 *   6. THE WEATHER (LUZ-05)     the same server in fog and in a storm: walkers that see the survivor down a clear
 *                               street see nothing in the thickest fog (and the screen's fog covers them alike),
 *                               and a shot fired right after a thunderclap turns nobody the same shot turned before.
 *
 * The living survivors are immortal on purpose (the admin's god mode, and fed every tick): a survivor killed
 * by the wave would turn case 1 into case 2. The only deaths are the ones a case scripts, and they go through
 * the server's own damage path (ServerCombat.damageActor → stepPlayer → onDeath).
 *
 * Pure Node (>= 18) + the project's TypeScript (devDependency) to transpile src/ on the fly, with the shims of
 * tools/test-server-sim.mjs copied in (a STRICT `buffer` included: the replicator encodes real snapshots here).
 * `math.random` is a seeded generator, reseeded per server, so every run is the same run.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(process.env.PZ_SRC ?? join(ROOT, "src"));
const require = createRequire(import.meta.url);
const Module = require("node:module");
const ts = require("typescript");

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};
const SEED = argValue("--seed", 1);
const HARD_DAY = argValue("--hard", 0);

// ---------------------------------------------------------------- deterministic RNG (never Math.random)

/** mulberry32: every spawn ring, every rain roll and every tie-break must give the same answer on every run */
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

let nextRandom = mulberry32(SEED);

// ---------------------------------------------------------------- Luau / roblox-ts shims

globalThis.math = {
	floor: Math.floor,
	ceil: Math.ceil,
	abs: Math.abs,
	sqrt: Math.sqrt,
	sin: Math.sin,
	cos: Math.cos,
	tan: Math.tan,
	atan2: Math.atan2,
	asin: Math.asin,
	acos: Math.acos,
	exp: Math.exp,
	pow: Math.pow,
	min: Math.min,
	max: Math.max,
	sign: Math.sign,
	pi: Math.PI,
	huge: Infinity,
	log: (x, b) => (b === undefined ? Math.log(x) : Math.log(x) / Math.log(b)),
	clamp: (v, a, b) => Math.min(Math.max(v, a), b),
	rad: d => (d * Math.PI) / 180,
	deg: r => (r * 180) / Math.PI,
	// Luau rounds halves away from zero (JS rounds them towards +∞)
	round: x => (x < 0 ? -Math.round(-x) : Math.round(x)),
	random: (a, b) =>
		a === undefined
			? nextRandom()
			: b === undefined
				? 1 + Math.floor(nextRandom() * a)
				: a + Math.floor(nextRandom() * (b - a + 1)),
};
globalThis.print = () => {};
globalThis.warn = (...a) => console.warn(...a);

class Color3 {
	constructor(r = 0, g = 0, b = 0) {
		this.R = r;
		this.G = g;
		this.B = b;
	}
	static fromRGB(r, g, b) {
		return new Color3(r / 255, g / 255, b / 255);
	}
	static fromHSV(h, s, v) {
		const i = Math.floor(h * 6);
		const f = h * 6 - i;
		const p = v * (1 - s);
		const q = v * (1 - f * s);
		const t = v * (1 - (1 - f) * s);
		const m = [
			[v, t, p],
			[q, v, p],
			[p, v, t],
			[p, q, v],
			[t, p, v],
			[v, p, q],
		][((i % 6) + 6) % 6];
		return new Color3(m[0], m[1], m[2]);
	}
	Lerp(o, k) {
		return new Color3(this.R + (o.R - this.R) * k, this.G + (o.G - this.G) * k, this.B + (o.B - this.B) * k);
	}
}
globalThis.Color3 = Color3;

class LuauBuffer {
	constructor(size) {
		this.bytes = new Uint8Array(size);
		this.view = new DataView(this.bytes.buffer);
	}
}

function bcheck(b, offset, n) {
	if (!(b instanceof LuauBuffer)) throw new TypeError("buffer expected");
	if (typeof offset !== "number" || !Number.isInteger(offset)) throw new TypeError(`offset ${offset} not an integer`);
	if (offset < 0 || offset + n > b.bytes.length) {
		throw new RangeError(`buffer access out of bounds (offset ${offset}, ${n} B, len ${b.bytes.length})`);
	}
}

function icheck(v, lo, hi, what) {
	if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
		throw new RangeError(`${what}: ${v} is not an integer in [${lo}, ${hi}] (Luau would wrap it)`);
	}
}

globalThis.buffer = {
	create(size) {
		if (!Number.isInteger(size) || size < 0) throw new RangeError(`buffer.create(${size})`);
		return new LuauBuffer(size);
	},
	len(b) {
		if (!(b instanceof LuauBuffer)) throw new TypeError("buffer expected");
		return b.bytes.length;
	},
	readu8: (b, o) => (bcheck(b, o, 1), b.view.getUint8(o)),
	readi8: (b, o) => (bcheck(b, o, 1), b.view.getInt8(o)),
	readu16: (b, o) => (bcheck(b, o, 2), b.view.getUint16(o, true)),
	readi16: (b, o) => (bcheck(b, o, 2), b.view.getInt16(o, true)),
	readu32: (b, o) => (bcheck(b, o, 4), b.view.getUint32(o, true)),
	readi32: (b, o) => (bcheck(b, o, 4), b.view.getInt32(o, true)),
	readf32: (b, o) => (bcheck(b, o, 4), b.view.getFloat32(o, true)),
	readf64: (b, o) => (bcheck(b, o, 8), b.view.getFloat64(o, true)),
	writeu8(b, o, v) {
		bcheck(b, o, 1);
		icheck(v, 0, 255, "writeu8");
		b.view.setUint8(o, v);
	},
	writei8(b, o, v) {
		bcheck(b, o, 1);
		icheck(v, -128, 127, "writei8");
		b.view.setInt8(o, v);
	},
	writeu16(b, o, v) {
		bcheck(b, o, 2);
		icheck(v, 0, 65535, "writeu16");
		b.view.setUint16(o, v, true);
	},
	writei16(b, o, v) {
		bcheck(b, o, 2);
		icheck(v, -32768, 32767, "writei16");
		b.view.setInt16(o, v, true);
	},
	writeu32(b, o, v) {
		bcheck(b, o, 4);
		icheck(v, 0, 4294967295, "writeu32");
		b.view.setUint32(o, v, true);
	},
	writef32(b, o, v) {
		bcheck(b, o, 4);
		if (typeof v !== "number") throw new TypeError("writef32 expects a number");
		b.view.setFloat32(o, v, true);
	},
	writef64(b, o, v) {
		bcheck(b, o, 8);
		if (typeof v !== "number") throw new TypeError("writef64 expects a number");
		b.view.setFloat64(o, v, true);
	},
	readstring(b, o, count) {
		bcheck(b, o, count);
		return Buffer.from(b.bytes.subarray(o, o + count)).toString("utf8");
	},
	writestring(b, o, value, count) {
		const bytes = Buffer.from(String(value), "utf8");
		const n = count === undefined ? bytes.length : count;
		if (!Number.isInteger(n) || n < 0 || n > bytes.length) throw new RangeError(`writestring count ${n}`);
		bcheck(b, o, n);
		b.bytes.set(bytes.subarray(0, n), o);
	},
	copy(target, targetOffset, source, sourceOffset = 0, count) {
		const n = count === undefined ? buffer.len(source) - sourceOffset : count;
		bcheck(source, sourceOffset, n);
		bcheck(target, targetOffset, n);
		target.bytes.set(source.bytes.subarray(sourceOffset, sourceOffset + n), targetOffset);
	},
	fill(b, offset, value, count) {
		const n = count === undefined ? buffer.len(b) - offset : count;
		bcheck(b, offset, n);
		icheck(value, 0, 255, "fill");
		b.bytes.fill(value, offset, offset + n);
	},
};

globalThis.typeIs = (v, t) => {
	switch (t) {
		case "buffer":
			return v instanceof LuauBuffer;
		case "number":
			return typeof v === "number";
		case "string":
			return typeof v === "string";
		case "boolean":
			return typeof v === "boolean";
		case "nil":
			return v === undefined || v === null;
		case "function":
			return typeof v === "function";
		case "table":
			return typeof v === "object" && v !== null && !(v instanceof LuauBuffer);
		default:
			return false;
	}
};

const defineMethod = (proto, name, fn) =>
	Object.defineProperty(proto, name, { value: fn, configurable: true, writable: true });
defineMethod(Array.prototype, "size", function () {
	return this.length;
});
defineMethod(Array.prototype, "remove", function (i) {
	return this.splice(i, 1)[0];
});
defineMethod(Array.prototype, "unorderedRemove", function (i) {
	const v = this[i];
	const last = this.pop();
	if (i < this.length) this[i] = last;
	return v;
});
defineMethod(Array.prototype, "clear", function () {
	this.length = 0;
});
defineMethod(Array.prototype, "insert", function (i, v) {
	this.splice(i, 0, v);
});
const jsPop = Array.prototype.pop;
defineMethod(Array.prototype, "pop", function () {
	// roblox-ts pop() is Luau's table.remove(t): the last element, and undefined on an empty table — which is
	// the native pop exactly. This file runs ~200 000 ticks and the flow field's heap pops on every one of
	// them, so it calls the native one instead of test-server-sim.mjs's splice (14% of the whole run).
	return jsPop.call(this);
});
defineMethod(String.prototype, "size", function () {
	return Buffer.byteLength(this.valueOf(), "utf8");
});
const jsSort = Array.prototype.sort;
defineMethod(Array.prototype, "sort", function (cmp) {
	if (!cmp) return jsSort.call(this);
	// roblox-ts comparators return a boolean ("a before b")
	return jsSort.call(this, (a, b) => {
		const r = cmp(a, b);
		if (typeof r !== "boolean") return r;
		return r ? -1 : cmp(b, a) ? 1 : 0;
	});
});
// roblox-ts Map/Set expose size() as a method; keep the native count behind it
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size").get;
defineMethod(Map.prototype, "size", function () {
	return mapSize.call(this);
});
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, "size").get;
defineMethod(Set.prototype, "size", function () {
	return setSize.call(this);
});

// "shared/x" / "server/x" → SRC/..., transpiled with the project's TypeScript (loader of test-sim.mjs)
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
	if (req.startsWith("shared/") || req.startsWith("client/") || req.startsWith("server/")) {
		return join(SRC, req + ".ts");
	}
	if (req.startsWith(".") && parent?.filename?.endsWith(".ts")) {
		const p = resolve(dirname(parent.filename), req);
		if (existsSync(p + ".ts")) return p + ".ts";
	}
	return resolveFilename.call(this, req, parent, ...rest);
};
Module._extensions[".ts"] = function (m, filename) {
	const out = ts.transpileModule(readFileSync(filename, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	});
	m._compile(out.outputText, filename);
};

// ---------------------------------------------------------------- the modules under test

const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const { generateTown } = require(join(SRC, "shared/game/world.ts"));
const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
const { createPlayer } = require(join(SRC, "shared/game/player.ts"));
const { resetEntityIds } = require(join(SRC, "shared/game/entities.ts"));
const { getDayPopulation } = require(join(SRC, "shared/data/spawns.ts"));
const CLOCK = require(join(SRC, "shared/sim/clock.ts"));
const CFG = require(join(SRC, "shared/net/mpConfig.ts"));
const P = require(join(SRC, "shared/net/protocol.ts"));
const { MP09_SAFE_RADIUS } = require(join(SRC, "shared/sim/ai/population.ts"));
const { PLAYER_LIGHT_R } = require(join(SRC, "shared/sim/ai/zombieTuning.ts"));
const PL = require(join(SRC, "server/sim/players.ts"));
const { ServerSimulation } = require(join(SRC, "server/sim/simulation.ts"));
const { WorldClock } = require(join(SRC, "server/sim/waves.ts"));
const { Replicator, mapHashOf } = require(join(SRC, "server/net/replication.ts"));
const { worldIsDark } = require(join(SRC, "server/net/interest.ts"));

const TICK_DT = 1 / CFG.SIM_HZ;
const HOURS = CLOCK.HOURS_PER_DAY;
/**
 * How long the population may take to notice that the world changed: the clusters are rebuilt every
 * CLUSTER_TICK (1 s, shared/sim/ai/population.ts), plus the tick the change happened in.
 */
const CLUSTER_LAG_S = 1 + 2 * TICK_DT;
const CLUSTER_LAG_TICKS = Math.ceil(CLUSTER_LAG_S / TICK_DT);
/**
 * A zombie is born with alpha 1 (shared/game/entities.ts) and fades at 3/s in the dark (zombieBrain
 * `updateAlpha`), so for its first (1 − 0.05) / 3 ≈ 0.32 s it counts as "lit" for §4.3 and travels on the wire
 * wherever it stands. Section 4 counts that birth flash apart from a real sighting.
 */
const BIRTH_FLASH_S = (1 - 0.05) / 3 + 2 * TICK_DT;

// ---------------------------------------------------------------- reporting

let failures = 0;
function check(name, ok, detail) {
	const tail = detail === undefined ? "" : `  (${detail})`;
	if (ok) {
		console.log(`  ok    ${name}${tail}`);
	} else {
		console.error(`  FAIL  ${name}${tail}`);
		failures += 1;
	}
	return ok;
}
const info = msg => console.log(`        ${msg}`);
const section = title => console.log(`\n${title}`);

// ---------------------------------------------------------------- time and small helpers

const absOf = (day, hour) => day * HOURS + hour;
const clockAbs = c => c.day * HOURS + c.dayTime;
const pad2 = n => String(n).padStart(2, "0");
/** "d2 06:00" for an absolute game hour */
function stamp(abs) {
	const day = Math.floor(abs / HOURS);
	const hour = abs - day * HOURS;
	const h = Math.floor(hour);
	const m = Math.floor((hour - h) * 60);
	return `d${day} ${pad2(h)}:${pad2(m)}`;
}
const sum = a => a.reduce((s, v) => s + v, 0);
const slash = a => a.join("/");
const pct = (n, d) => (d > 0 ? `${((100 * n) / d).toFixed(0)}%` : "n/a");
const tableOf = day => {
	const pop = getDayPopulation(day);
	return {
		walkers: [pop.wave1, pop.wave2, pop.wave3],
		specials: [pop.specialWave1, pop.specialWave2, pop.specialWave3],
	};
};
function median(values) {
	if (values.length === 0) return NaN;
	const s = [...values].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

// ---------------------------------------------------------------- the host (server/net/mpHost.ts minus Roblox)

/**
 * What mpHost builds, one fixed tick at a time: `new ServerSimulation({ world })` (mpHost.ts:164), the real
 * Replicator wired to `onTick`/`onFx`, and the MP-21 bookkeeping of server/sim/life.ts (`LifeKeeper`) —
 * `onDeath` sends LifeState.Dead and arms `downFor = daybreakWaitSeconds(clock.dayTime)`; the heartbeat runs
 * the simulation THEN counts the wait down, and the stand-up puts the survivor back on the street. `shared`
 * (the option's old name) now only says whether this harness stands its dead up at daybreak: the live server
 * does on every server kind since the owner's rule of 23 Sep 2026, and case 2 turns it off on purpose, to
 * look at the night in between. The death rules themselves are tools/test-body.mjs's, on the real host.
 *
 * Everything else is observation: every zombie is recorded the tick it is born, every queue decrement the
 * tick it happens, and the fill is watched by wrapping `onWaveFill` AROUND the population's split, which
 * still runs first and untouched.
 *
 * Each host is a fresh server process as far as module state goes: the entity id counter
 * (shared/game/entities.ts `nextId`) starts at 1 again, because the horde's brains stagger their decisions
 * by `z.id` — two identical runs that inherit different ids are two different runs.
 */
function newHost(label, options = {}) {
	resetEntityIds();
	nextRandom = mulberry32((SEED * 7919 + (options.seed ?? 0)) >>> 0);
	const world = generateTown(DESIGN.TOWN_SEED);
	const sim = new ServerSimulation(options.clock !== undefined ? { world, clock: options.clock() } : { world });
	const host = {
		label,
		world,
		sim,
		shared: options.shared === true,
		/** real seconds since boot: the token bucket's clock for a runner's input */
		now: 0,
		/** slots kept alive by the harness (god mode + fed), so the only deaths are the scripted ones */
		immortal: new Set(),
		/** MP-21 countdowns, slot → real seconds left (mpHost's `link.downFor`) */
		downFor: new Map(),
		deaths: [],
		revives: [],
		/** PlayerLife events as a client decodes them off the reliable World channel */
		life: [],
		births: [],
		seen: new WeakSet(),
		/** zombie → the tick it was born */
		bornTick: new WeakMap(),
		pours: [],
		fills: [],
		hourly: [],
		lastHour: -1,
		prevWalkers: [...sim.clock.waveQueues],
		prevSpecials: [...sim.clock.specialWaveQueues],
		beforeStep: undefined,
		afterStep: undefined,
		snapTap: undefined,
	};
	const readLife = packet => {
		const batch = P.decodeWorld(packet);
		if (batch === undefined) return;
		for (const e of batch.events) {
			if (e.t !== P.WorldEv.PlayerLife) continue;
			host.life.push({ slot: e.slot, state: e.state, tick: sim.tick });
		}
	};
	const replicator = new Replicator(
		sim,
		{
			snap(slot, part) {
				if (host.snapTap !== undefined) host.snapTap(slot, part);
			},
			fx() {},
			world(slot, packet) {
				readLife(packet);
			},
			worldAll(packet) {
				readLife(packet);
			},
		},
		{ tick0Time: 0, mapHash: mapHashOf(world) },
	);
	host.replicator = replicator;
	sim.onTick = t => replicator.afterTick(t);
	sim.onFx = event => replicator.queueFx(event);
	sim.onDeath = sp => {
		replicator.life(sp.slot, P.LifeState.Dead);
		// LifeKeeper.died arms the daybreak wait (on every server kind); case 2 switches it off to watch the night
		const wait = host.shared ? CLOCK.daybreakWaitSeconds(sim.clock.dayTime) : undefined;
		host.deaths.push({ slot: sp.slot, abs: clockAbs(sim.clock), tick: sim.tick, wait });
		if (wait !== undefined) host.downFor.set(sp.slot, wait);
	};
	const split = sim.clock.onWaveFill;
	if (split === undefined) throw new Error("the clock has no onWaveFill: is the horde on this server?");
	sim.clock.onWaveFill = fill => {
		split(fill);
		host.fills.push({
			day: fill.day,
			abs: clockAbs(sim.clock),
			walkers: [...sim.clock.waveQueues],
			specials: [...sim.clock.specialWaveQueues],
		});
	};
	return host;
}

/** §7.1 as mpHost's `admit` does it: a safe point away from the living and the horde, then the welcome */
function enter(host, name) {
	const sim = host.sim;
	const slot = sim.freeSlot();
	if (slot === undefined) throw new Error("no free slot");
	const allies = [];
	for (const o of sim.players()) if (!o.state.dead) allies.push({ x: o.state.x, y: o.state.y });
	const spawn = PL.findSpawnPoint(host.world, { allies, zombies: sim.horde?.zombies ?? [] });
	const sp = PL.createServerPlayer(
		{ slot, userId: 1000 + slot, name },
		defaultSave(),
		spawn.x,
		spawn.y,
		sim.tick,
		sim.simHz,
	);
	sim.add(sp);
	host.replicator.welcome(sp);
	return sp;
}

/**
 * LifeKeeper's stand-up (server/sim/life.ts `standUp`) minus the magazine bookkeeping, which a starter dagger does
 * not have: safe point, a fresh full state, LifeState.Up
 */
function revive(host, slot) {
	const sim = host.sim;
	const sp = sim.get(slot);
	if (sp === undefined) return false;
	host.downFor.delete(slot);
	const allies = [];
	for (const o of sim.players()) if (o.slot !== slot && !o.state.dead) allies.push({ x: o.state.x, y: o.state.y });
	const spawn = PL.findSpawnPoint(host.world, { allies, zombies: sim.horde?.zombies ?? [] });
	sp.state = createPlayer(sp.save, spawn.x, spawn.y);
	host.replicator.life(slot, P.LifeState.Up);
	host.revives.push({ slot, abs: clockAbs(sim.clock), tick: sim.tick });
	return true;
}

/** LifeKeeper.step's daybreak half: every wait loses `dt`, and the ones that ran out are stood up */
function stepDaybreak(host, dt) {
	for (const [slot, left] of [...host.downFor]) {
		if (left > dt) {
			host.downFor.set(slot, left - dt);
			continue;
		}
		host.downFor.delete(slot);
		revive(host, slot);
	}
}

/** a death through the server's own damage path: ServerCombat.damageActor now, stepPlayer's `died` next tick */
function kill(host, sp) {
	host.immortal.delete(sp.slot);
	sp.state.godMode = false;
	return host.sim.combat.damageActor(sp.slot, sp.state, sp.save, sp.state.hpMax * 10, true);
}

function nearestLiving(sim, x, y) {
	let best = Infinity;
	for (const sp of sim.players()) {
		if (sp.state.dead) continue;
		best = Math.min(best, Math.hypot(sp.state.x - x, sp.state.y - y));
	}
	return best;
}

/** stall counter of the shared Population (PopulationStall), through a server accessor if one exists */
function stallOf(host) {
	const serverPop = host.sim.horde.population;
	const exposed = serverPop.stall;
	if (typeof exposed === "function") return exposed.call(serverPop);
	if (exposed !== undefined) return exposed;
	// ServerPopulation keeps the shared Population in a TypeScript-private field: plain JS can still read it
	return serverPop.population?.stall;
}

const clustersOf = host => host.sim.horde.population.scales().length;

function observe(host) {
	const sim = host.sim;
	const clock = sim.clock;
	const abs = clockAbs(clock);
	for (const z of sim.horde.zombies) {
		if (host.seen.has(z)) continue;
		host.seen.add(z);
		host.bornTick.set(z, sim.tick);
		host.births.push({
			z,
			wave: z.wave === true,
			special: z.special === true,
			abs,
			tick: sim.tick,
			dist: nearestLiving(sim, z.x, z.y),
		});
	}
	const active = [clock.wave1Active, clock.wave2Active, clock.wave3Active];
	for (let i = 0; i < 3; i++) {
		const w = clock.waveQueues[i];
		if (w < host.prevWalkers[i]) {
			host.pours.push({ wave: i + 1, special: false, n: host.prevWalkers[i] - w, abs, active: active[i] });
		}
		host.prevWalkers[i] = w;
		const s = clock.specialWaveQueues[i];
		if (s < host.prevSpecials[i]) {
			host.pours.push({ wave: i + 1, special: true, n: host.prevSpecials[i] - s, abs, active: active[i] });
		}
		host.prevSpecials[i] = s;
	}
	const hour = Math.floor(abs);
	if (hour !== host.lastHour) {
		host.lastHour = hour;
		const st = stallOf(host);
		host.hourly.push({
			abs,
			zombies: sim.horde.zombies.length,
			walkers: [...clock.waveQueues],
			specials: [...clock.specialWaveQueues],
			clusters: clustersOf(host),
			stall: st === undefined ? undefined : { ...st },
		});
	}
}

/** one heartbeat of mpHost at a fixed dt: the harness's care, the tick, the daybreak countdown */
function tick(host) {
	const sim = host.sim;
	for (const sp of sim.players()) {
		if (!host.immortal.has(sp.slot)) continue;
		sp.state.godMode = true;
		sp.state.hungry = sp.state.hungryMax;
	}
	if (host.beforeStep !== undefined) host.beforeStep(host);
	sim.step();
	host.now += TICK_DT;
	// mpHost's heartbeat: `sim.advance(dt)`, THEN `stepDaybreak(dt)` — the wait runs in the sim's real seconds
	stepDaybreak(host, TICK_DT);
	observe(host);
	if (host.afterStep !== undefined) host.afterStep(host);
}

function runUntil(host, day, hour) {
	const target = absOf(day, hour);
	while (clockAbs(host.sim.clock) < target) tick(host);
}

const bornBetween = (host, from, to) => host.births.filter(b => b.abs > from && b.abs <= to);
const waveWalkers = births => births.filter(b => b.wave && !b.special).length;
const waveSpecials = births => births.filter(b => b.wave && b.special).length;
const pouredBetween = (host, from, to, special) =>
	host.pours.filter(p => p.special === special && p.abs > from && p.abs <= to);

/** the same world at the same instant reads the same: births, the horde, and where it stands */
function fingerprint(host) {
	let sx = 0;
	let sy = 0;
	for (const z of host.sim.horde.zombies) {
		sx += z.x;
		sy += z.y;
	}
	return `${host.births.length} born, ${host.sim.horde.zombies.length} alive, Σx ${sx.toFixed(3)}, Σy ${sy.toFixed(3)}`;
}

/** the night's queue history, one line per game hour (what a playtest would have wanted on screen) */
function timeline(host, from, to) {
	for (const h of host.hourly) {
		if (h.abs < from || h.abs > to) continue;
		const st = h.stall;
		const stall = st === undefined ? "?" : st.active ? `STALLED ${st.current.toFixed(0)} s` : "spawning";
		info(
			`${stamp(h.abs)}  zombies ${String(h.zombies).padStart(3)}  queues ${slash(h.walkers)}` +
				`${sum(h.specials) > 0 ? ` +${slash(h.specials)} specials` : ""}  clusters ${h.clusters}  ${stall}`,
		);
	}
}

const started = Date.now();

// ================================================================ 0: the chain under test

section("0) the chain under test (server/net/mpHost.ts → ServerSimulation → WorldClock → ZombieWorld → Population)");

const probe = new ServerSimulation({ world: generateTown(DESIGN.TOWN_SEED) });
if (
	!check(
		"MP_PHASE ≥ 2: `new ServerSimulation({ world })` owns the horde, so its spawner is the only one",
		CFG.MP_PHASE >= 2 && probe.horde !== undefined,
		`MP_PHASE = ${CFG.MP_PHASE}`,
	)
) {
	console.error("\nno server horde to test: nothing below would mean anything");
	process.exit(1);
}
check(
	"the population exposes the stall counter (PopulationStall)",
	stallOf({ sim: probe }) !== undefined,
	"shared/sim/ai/population.ts `stall`",
);
check(
	"the horde and its AI read the SAME clock the waves are filled on",
	probe.horde.clock === probe.clock && probe.horde.refs.clock === probe.clock,
);
info(
	`wave zombies are born ${DESIGN.ZOMBIE_SPAWN_MIN}–${DESIGN.ZOMBIE_SPAWN_MAX} u out (MP-09 keeps ${MP09_SAFE_RADIUS} u); ` +
		`one pours every ${DESIGN.ZOMBIE_WAVE_SPAWN_TIME.toFixed(3)} s; daybreak is ${CLOCK.DAY_BREAK_HOUR}:00; ` +
		`a whole night is ${CLOCK.NIGHT_REAL_SECONDS.toFixed(0)} s`,
);

// ================================================================ 1: the night is delivered

section("1) the night is delivered: queue → the real spawner → a zombie in the world (§3.5)");

const one = newHost("alive", { seed: 1 });
const a1 = enter(one, "survivor");
one.immortal.add(a1.slot);
const t1 = Date.now();
runUntil(one, 1, 9);
/** case 2 and case 3 are this very run until their deaths: this is what they must match */
const at9 = fingerprint(one);
const fp1930 = { value: "" };
one.afterStep = h => {
	if (fp1930.value === "" && clockAbs(h.sim.clock) >= absOf(1, 19.5)) fp1930.value = fingerprint(h);
};
runUntil(one, 1, 18.6);
{
	const table = tableOf(1);
	const fills = one.fills.filter(f => f.day === 1);
	const fill = fills[0];
	check(
		"the queues were filled once on day 1, inside 18:00–18:30",
		fills.length === 1 && fill.abs > absOf(1, CLOCK.WAVE_FILL_FROM) && fill.abs < absOf(1, CLOCK.WAVE_FILL_TO),
		fills.map(f => stamp(f.abs)).join(", ") || "never",
	);
	check(
		"…with the day's table, untouched (one survivor is one cluster, S(1) = 1)",
		fill !== undefined &&
			slash(fill.walkers) === slash(table.walkers) &&
			slash(fill.specials) === slash(table.specials),
		fill !== undefined
			? `walkers ${slash(fill.walkers)} vs table ${slash(table.walkers)}, specials ${slash(fill.specials)}`
			: "no fill",
	);
}
runUntil(one, 2, CLOCK.DAY_BREAK_HOUR);
{
	const fill = one.fills.find(f => f.day === 1);
	const dawn = absOf(2, CLOCK.DAY_BREAK_HOUR);
	const night = bornBetween(one, fill.abs, dawn);
	const walkers = waveWalkers(night);
	const specials = waveSpecials(night);
	check(
		"every walker the queues promised was born, with wave === true, before 06:00",
		walkers === sum(fill.walkers),
		`${walkers} born of ${sum(fill.walkers)} promised`,
	);
	check("…and every special", specials === sum(fill.specials), `${specials} born of ${sum(fill.specials)} promised`);
	const perWave = [1, 2, 3].map(w =>
		sum(
			pouredBetween(one, fill.abs, dawn, false)
				.filter(p => p.wave === w)
				.map(p => p.n),
		),
	);
	const offDuty = one.pours.filter(p => p.abs > fill.abs && p.abs <= dawn && !p.active).length;
	check(
		"each wave poured its own queue, and only while that wave was on (19:00, 22:00, 01:00)",
		slash(perWave) === slash(fill.walkers) && offDuty === 0,
		`poured ${slash(perWave)}, ${offDuty} pour(s) outside the wave's hours`,
	);
	const clock = one.sim.clock;
	check(
		"the queues are empty at daybreak",
		sum(clock.waveQueues) === 0 && sum(clock.specialWaveQueues) === 0,
		`walkers ${slash(clock.waveQueues)}, specials ${slash(clock.specialWaveQueues)} at ${stamp(clockAbs(clock))}`,
	);
	const closest = Math.min(...night.filter(b => b.wave).map(b => b.dist));
	check(
		`MP-09: no wave zombie was born within ${MP09_SAFE_RADIUS} u of the survivor`,
		closest >= MP09_SAFE_RADIUS - 5,
		`closest birth ${closest.toFixed(0)} u`,
	);
	const st = stallOf(one);
	check(
		"a living world never stalls (the stall counter never moved)",
		st !== undefined && st.episodes === 0 && st.seconds === 0 && !st.active,
		st !== undefined ? `${st.episodes} episode(s), ${st.seconds.toFixed(1)} s` : "no counter",
	);
	timeline(one, absOf(1, 18), dawn);
}
runUntil(one, 2, 21);
{
	const table = tableOf(2);
	const fill = one.fills.find(f => f.day === 2);
	check(
		"the next dusk fills the queues again, with day 2's table",
		fill !== undefined &&
			slash(fill.walkers) === slash(table.walkers) &&
			slash(fill.specials) === slash(table.specials),
		fill !== undefined
			? `${slash(fill.walkers)} at ${stamp(fill.abs)} vs table ${slash(table.walkers)}`
			: "no fill",
	);
	const wave1 = fill !== undefined ? sum(pouredBetween(one, fill.abs, absOf(2, 21), false).map(p => p.n)) : -1;
	check(
		"…and wave 1 of the second night is on the street by 21:00",
		fill !== undefined && wave1 === fill.walkers[0] && one.sim.clock.waveQueues[0] === 0,
		`poured ${wave1} of ${fill?.walkers[0]}, queues now ${slash(one.sim.clock.waveQueues)}`,
	);
	const ticks = one.sim.tick;
	const daySeconds = CLOCK.NIGHT_REAL_SECONDS + CLOCK.secondsUntilHour(CLOCK.DAY_BREAK_HOUR, 19);
	info(
		`ran ${stamp(absOf(1, 7))} → ${stamp(clockAbs(one.sim.clock))}: ${ticks} ticks at 1/${CFG.SIM_HZ} s, ` +
			`${((ticks * TICK_DT) / daySeconds).toFixed(2)} game days, ${((Date.now() - t1) / 1000).toFixed(1)} s of wall time`,
	);
}

// ================================================================ 2: the sterile world

section(
	"2) the sterile world: the only survivor dead from 09:00 and nobody to stand them up (the night before daybreak)",
);

{
	const two = newHost("dead at 09:00", { seed: 1, shared: false });
	const a2 = enter(two, "survivor");
	two.immortal.add(a2.slot);
	runUntil(two, 1, 9);
	check("it is case 1's run up to 09:00 (same seed, same town, same horde)", fingerprint(two) === at9, at9);
	kill(two, a2);
	let clusteredTicks = 0;
	let stallBackwards = 0;
	let lastStallSeconds = -1;
	let flags = 0;
	two.afterStep = h => {
		const death = h.deaths[0];
		if (death === undefined) return;
		if (h.sim.tick - death.tick > CLUSTER_LAG_TICKS && clustersOf(h) > 0) clusteredTicks += 1;
		const st = stallOf(h);
		if (st !== undefined) {
			if (st.seconds < lastStallSeconds) stallBackwards += 1;
			lastStallSeconds = st.seconds;
		}
		const c = h.sim.clock;
		if (c.wave1Active) flags |= 1;
		if (c.wave2Active) flags |= 2;
		if (c.wave3Active) flags |= 4;
	};
	runUntil(two, 2, CLOCK.DAY_BREAK_HOUR);
	const atDawn = [...two.sim.clock.waveQueues];
	const aliveAtDawn = two.sim.horde.zombies.length;
	runUntil(two, 2, 8);
	const death = two.deaths[0];
	const hour = death !== undefined ? death.abs - absOf(1, 0) : NaN;
	check(
		"the survivor died once, at 09:00, through the server's own damage path",
		two.deaths.length === 1 && Math.abs(hour - 9) < 0.01,
		death !== undefined ? stamp(death.abs) : "no death",
	);
	check(
		"with the harness's revive off: nobody armed a daybreak revive, nobody was stood up",
		// (the shims make Map.size a method, the way roblox-ts spells it)
		death !== undefined && death.wait === undefined && two.revives.length === 0 && two.downFor.size() === 0,
	);
	check(
		`from the first cluster rebuild after the death (≤ ${CLUSTER_LAG_S.toFixed(2)} s) there was never a cluster again`,
		clusteredTicks === 0,
		`${clusteredTicks} tick(s) with a cluster`,
	);
	const after = two.births.filter(b => b.tick > death.tick);
	check(
		"nothing was born after the death: no ambient walker, no special, no wave",
		after.length === 0,
		`${after.length} born (${waveWalkers(after)} of them wave walkers)`,
	);
	const fill = two.fills.find(f => f.day === 1);
	const table = tableOf(1);
	check(
		"the clock still did its part: the 18:00 fill promised the day's table",
		fill !== undefined && slash(fill.walkers) === slash(table.walkers),
		fill !== undefined ? `${slash(fill.walkers)} at ${stamp(fill.abs)}` : "no fill",
	);
	check("…and switched waves 1, 2 and 3 on, with nobody left to pour them", flags === 7, `wave flags seen ${flags}`);
	check(
		"the queues are intact at daybreak: the whole night is still owed",
		fill !== undefined && slash(atDawn) === slash(fill.walkers),
		`${slash(atDawn)} at ${stamp(absOf(2, CLOCK.DAY_BREAK_HOUR))}`,
	);
	check(
		"…and at 08:00: nothing drains them until a survivor stands up",
		fill !== undefined && slash(two.sim.clock.waveQueues) === slash(fill.walkers),
		slash(two.sim.clock.waveQueues),
	);
	const st = stallOf(two);
	const elapsed = (two.sim.tick - death.tick) * TICK_DT;
	check(
		"the stall counter says so: one episode, still going",
		st !== undefined && st.active && st.episodes === 1,
		st !== undefined ? `active ${st.active}, ${st.episodes} episode(s)` : "no counter",
	);
	check(
		"…as long as the death, give or take one cluster rebuild",
		st !== undefined &&
			elapsed - st.seconds >= 0 &&
			elapsed - st.seconds <= CLUSTER_LAG_S &&
			st.current === st.seconds,
		st !== undefined
			? `stalled ${st.seconds.toFixed(2)} s of ${elapsed.toFixed(2)} s dead (current ${st.current.toFixed(2)} s)`
			: "no counter",
	);
	check("…and it grew every tick of it, never back", stallBackwards === 0 && lastStallSeconds > 0);
	info(
		`the horde froze at ${aliveAtDawn} zombies (born before 09:00; cleanup measures against every survivor, ` +
			`the dead included, so the ones near the body are never recycled)`,
	);
	timeline(two, absOf(1, 18), absOf(2, 8));
	info(
		"RULE (MP-21 and MP-22, the owner's rules of 23 Sep 2026): every server stands its dead up at daybreak (case " +
			"3), and a world with nobody alive ENDS 30 s after its last survivor falls and a new town begins on day 1 " +
			"(server/sim/worldReset.ts, tools/test-reset.mjs). This harness has no LifeKeeper, so it shows what a " +
			"world with only the dead in it does for as long as it lasts: nothing.",
	);
}

// ================================================================ 3: daybreak unlocks it

section("3) daybreak unlocks it: dead at 19:30, stood up at 06:00 the way the server does it");

{
	const three = newHost("shared", { seed: 1, shared: true });
	const a3 = enter(three, "survivor");
	three.immortal.add(a3.slot);
	runUntil(three, 1, 19.5);
	check("it is case 1's run up to 19:30", fingerprint(three) === fp1930.value, fp1930.value);
	const fill1 = three.fills.find(f => f.day === 1);
	const wave1 = waveWalkers(bornBetween(three, fill1.abs, clockAbs(three.sim.clock)));
	check(
		"wave 1 was already on the street when the survivor fell",
		wave1 === fill1.walkers[0],
		`${wave1} of ${fill1.walkers[0]}`,
	);
	kill(three, a3);
	let clusterBack;
	three.afterStep = h => {
		const rev = h.revives[0];
		if (rev !== undefined && clusterBack === undefined && clustersOf(h) > 0) clusterBack = h.sim.tick;
	};
	runUntil(three, 2, CLOCK.DAY_BREAK_HOUR - 0.01);
	const death = three.deaths[0];
	const owedBefore = [...three.sim.clock.waveQueues];
	const bornWhileDown = three.births.filter(b => b.tick > death.tick);
	const stallDown = stallOf(three);
	check(
		"the death armed the MP-21 wait: daybreakWaitSeconds at the hour of death",
		death !== undefined &&
			death.wait !== undefined &&
			Math.abs(death.wait - CLOCK.daybreakWaitSeconds(death.abs - absOf(1, 0))) < 1e-9,
		death !== undefined ? `${stamp(death.abs)}, wait ${death.wait?.toFixed(1)} s` : "no death",
	);
	check(
		"while the body lay there the world was sterile and said so",
		bornWhileDown.length === 0 && stallDown !== undefined && stallDown.active,
		`${bornWhileDown.length} born, queues ${slash(owedBefore)} still owed, stall ${stallDown?.current.toFixed(0)} s`,
	);
	runUntil(three, 2, CLOCK.DAY_BREAK_HOUR + 0.05);
	const rev = three.revives[0];
	check(
		"the survivor was stood back up once, at 06:00 of day 2",
		three.revives.length === 1 && Math.abs(rev.abs - absOf(2, CLOCK.DAY_BREAK_HOUR)) < 0.002,
		rev !== undefined ? `${stamp(rev.abs)} (${(rev.abs - absOf(2, CLOCK.DAY_BREAK_HOUR)).toFixed(5)} h)` : "never",
	);
	check(
		"…after exactly the wait the host armed (±1 tick)",
		rev !== undefined && Math.abs((rev.tick - death.tick) * TICK_DT - death.wait) <= 1.5 * TICK_DT,
		rev !== undefined ? `${((rev.tick - death.tick) * TICK_DT).toFixed(3)} s vs ${death.wait.toFixed(3)} s` : "n/a",
	);
	const sp3 = three.sim.get(a3.slot);
	check(
		"…standing, at full health, at a safe point (a fresh createPlayer)",
		sp3 !== undefined && !sp3.state.dead && sp3.state.hp === sp3.state.hpMax,
		sp3 !== undefined ? `hp ${sp3.state.hp}/${sp3.state.hpMax}` : "gone",
	);
	// from the death on: the welcome also tells a newcomer its own state (an Up on the way in, since MP-22)
	const lifeSeq = three.life.filter(e => e.slot === a3.slot && e.tick >= death.tick).map(e => e.state);
	const collapsed = lifeSeq.filter((s, i) => i === 0 || s !== lifeSeq[i - 1]);
	check(
		"the clients were told on the reliable World channel: Dead, then Up",
		slash(collapsed) === slash([P.LifeState.Dead, P.LifeState.Up]),
		`PlayerLife ${slash(lifeSeq)} (Dead = ${P.LifeState.Dead}, Up = ${P.LifeState.Up})`,
	);
	// back among the living at daybreak: from here the harness keeps them there, like case 1
	three.immortal.add(a3.slot);
	runUntil(three, 2, 7);
	const stAfter = stallOf(three);
	check(
		"the population noticed within one cluster rebuild: a cluster again, the stall over",
		clusterBack !== undefined &&
			clusterBack - rev.tick <= CLUSTER_LAG_TICKS &&
			stAfter !== undefined &&
			!stAfter.active,
		clusterBack !== undefined
			? `cluster back ${((clusterBack - rev.tick) * TICK_DT).toFixed(2)} s after the revive`
			: "never",
	);
	check(
		"…one episode in all, as long as the wait (give or take one rebuild)",
		stAfter !== undefined && stAfter.episodes === 1 && Math.abs(stAfter.seconds - death.wait) <= CLUSTER_LAG_S,
		stAfter !== undefined
			? `${stAfter.episodes} episode(s), ${stAfter.seconds.toFixed(2)} s vs ${death.wait.toFixed(2)} s`
			: "n/a",
	);
	const reborn = three.births.filter(b => b.tick > rev.tick);
	const firstBack = reborn[0];
	check(
		"the spawn came back: the town fills again after daybreak",
		firstBack !== undefined && (firstBack.tick - rev.tick) * TICK_DT <= 5,
		firstBack !== undefined
			? `first zombie ${((firstBack.tick - rev.tick) * TICK_DT).toFixed(2)} s after, ${reborn.length} by 07:00`
			: "nothing born",
	);
	runUntil(three, 3, CLOCK.DAY_BREAK_HOUR);
	const fill2 = three.fills.find(f => f.day === 2);
	const dawn3 = absOf(3, CLOCK.DAY_BREAK_HOUR);
	check(
		"the next dusk promised a night again (18:00–18:30 of day 2)",
		fill2 !== undefined && fill2.abs > absOf(2, CLOCK.WAVE_FILL_FROM) && fill2.abs < absOf(2, CLOCK.WAVE_FILL_TO),
		fill2 !== undefined ? `${slash(fill2.walkers)} at ${stamp(fill2.abs)}` : "no fill",
	);
	const night2 = fill2 !== undefined ? bornBetween(three, fill2.abs, dawn3) : [];
	check(
		"…and delivered it whole: every walker in the queues was born before 06:00",
		fill2 !== undefined && waveWalkers(night2) === sum(fill2.walkers),
		fill2 !== undefined ? `${waveWalkers(night2)} born of ${sum(fill2.walkers)} promised` : "n/a",
	);
	check(
		"…every special too",
		fill2 !== undefined && waveSpecials(night2) === sum(fill2.specials),
		fill2 !== undefined ? `${waveSpecials(night2)} of ${sum(fill2.specials)}` : "n/a",
	);
	const clock = three.sim.clock;
	check(
		"…and the queues are empty at daybreak",
		sum(clock.waveQueues) === 0 && sum(clock.specialWaveQueues) === 0,
		`${slash(clock.waveQueues)} at ${stamp(clockAbs(clock))}`,
	);
	// the decision (server/sim/waves.ts fillNight): every night gets the table of ITS OWN day, always -- the
	// stalled night's leftovers (`owedBefore`, still queued when this dusk's fill overwrote them) are discarded,
	// never added to the new promise and never left standing in for it.
	const table2 = tableOf(2);
	check(
		"the new night promised day 2's table, not the stalled night's leftovers",
		fill2 !== undefined &&
			slash(fill2.walkers) === slash(table2.walkers) &&
			slash(fill2.specials) === slash(table2.specials),
		fill2 !== undefined
			? `promised ${slash(fill2.walkers)} = ${sum(fill2.walkers)}, day 2's table ${slash(table2.walkers)} = ` +
					`${sum(table2.walkers)}, the stalled night had left ${slash(owedBefore)} in the queues`
			: "no fill",
	);
	timeline(three, absOf(1, 19), absOf(2, 7));
}

// ================================================================ 4: what the wire carries

section(
	"4) what the wire carries at night: the wave zombies a survivor actually RECEIVES (§4.3 — reported, not checked)",
);

/**
 * A survivor who keeps running, fed through the real C→S path (encodeInput → ingestInput, one command per tick
 * with the §2.2 redundancy): full speed, a new heading every 3–8 s, and a sharp turn whenever a wall stops them.
 * Its own generator, so the route does not depend on how many dice the horde happened to roll.
 */
function runner(sp, seed) {
	const rr = mulberry32(seed);
	const st = {
		heading: rr() * Math.PI * 2,
		turnIn: 3,
		lastX: sp.state.x,
		lastY: sp.state.y,
		seq: 1,
		history: [],
		peak: 0,
		travelled: 0,
		blocked: 0,
	};
	return {
		st,
		step(h) {
			const p = sp.state;
			const moved = Math.hypot(p.x - st.lastX, p.y - st.lastY);
			st.lastX = p.x;
			st.lastY = p.y;
			st.travelled += moved;
			st.peak = Math.max(st.peak, moved);
			st.turnIn -= TICK_DT;
			if (st.seq > 2 && moved < st.peak * 0.3) {
				st.heading += Math.PI / 2 + (rr() - 0.5) * (Math.PI / 2);
				st.blocked += 1;
			} else if (st.turnIn <= 0) {
				st.heading += (rr() - 0.5) * ((Math.PI * 2) / 3);
				st.turnIn = 3 + rr() * 5;
			}
			const cmd = P.makeCommand(st.seq, Math.cos(st.heading), Math.sin(st.heading), st.heading, 0, 0);
			st.seq += 1;
			st.history.unshift(cmd);
			while (st.history.length > CFG.INPUT_REDUNDANCY) st.history.pop();
			PL.ingestInput(sp, P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: st.history.slice() }), h.now);
		},
	};
}

/**
 * Decodes every snapshot part the real Replicator addresses to `slot` and resolves its zombie netIds back to
 * the simulation's objects, so "received" means exactly what a client would hold — the rings, the mid-ring
 * rotation, the building rule, the dark rule (ActorInterest + visibleInDark) and SNAP_ZOMBIE_CAP, all applied
 * by the code that applies them live.
 *
 * A wave zombie that is on the wire only during its birth flash (BIRTH_FLASH_S) is counted as FLASHED, not as
 * seen: the client gets a body that fades out in a third of a second, 720+ u away, which nobody reads as "the
 * wave came".
 */
function watchWaves(host, slot) {
	const bucket = () => ({ rounds: 0, alive: 0, ring: 0, sent: 0, withAny: 0 });
	const m = { ...bucket(), dark: bucket(), firstSeen: new Map(), flashed: new Set(), malformed: 0 };
	let byNet = new Map();
	let roundTick = -1;
	const round = new Set();
	const ring2 = CFG.INTEREST_MID * CFG.INTEREST_MID;
	host.snapTap = (s, part) => {
		if (s !== slot) return;
		const sim = host.sim;
		if (roundTick !== sim.tick) {
			roundTick = sim.tick;
			round.clear();
			byNet = new Map();
			for (const z of sim.horde.zombies) {
				const id = sim.horde.netIdOf(z);
				if (id > 0) byNet.set(id, z);
			}
		}
		const snap = P.decodeSnapshotPart(part);
		if (snap === undefined) {
			m.malformed += 1;
			return;
		}
		for (const zs of snap.zombies) {
			const z = byNet.get(zs.netId);
			if (z !== undefined && z.wave) round.add(z);
		}
	};
	const previous = host.afterStep;
	host.afterStep = h => {
		if (previous !== undefined) previous(h);
		const sim = h.sim;
		const clock = sim.clock;
		if (sim.tick % CFG.SNAP_NEAR_EVERY_TICKS !== 0) return;
		if (!CLOCK.isNightAt(clock.dayTime)) return;
		const v = sim.get(slot).state;
		const dark = worldIsDark(clock.darkAlpha);
		let alive = 0;
		let ring = 0;
		for (const z of sim.horde.zombies) {
			if (!z.wave || z.hp <= 0) continue;
			alive += 1;
			const dx = z.x - v.x;
			const dy = z.y - v.y;
			if (dx * dx + dy * dy <= ring2) ring += 1;
		}
		let sent = 0;
		if (roundTick === sim.tick) {
			for (const z of round) {
				const age = (sim.tick - (h.bornTick.get(z) ?? sim.tick)) * TICK_DT;
				if (age < BIRTH_FLASH_S) {
					if (dark) m.flashed.add(z);
					continue;
				}
				sent += 1;
				if (!m.firstSeen.has(z)) m.firstSeen.set(z, { tick: sim.tick, dark });
			}
		}
		for (const b of dark ? [m, m.dark] : [m]) {
			b.rounds += 1;
			b.alive += alive;
			b.ring += ring;
			b.sent += sent;
			if (sent > 0) b.withAny += 1;
		}
	};
	return m;
}

function measureNight(label, day, move) {
	const host = newHost(label, {
		seed: 40 + day,
		// the night alone, from two hours before dusk; no rain, so the dark is the night's own
		clock: () => new WorldClock({ day, dayTime: 17, rollRain: () => false }),
	});
	const sp = enter(host, label);
	host.immortal.add(sp.slot);
	let run;
	if (move) {
		run = runner(sp, 9000 + day);
		host.beforeStep = h => run.step(h);
	}
	const m = watchWaves(host, sp.slot);
	runUntil(host, day + 1, CLOCK.DAY_BREAK_HOUR);
	const waves = host.births.filter(b => b.wave);
	const seen = waves.filter(b => m.firstSeen.has(b.z));
	const bornDark = waves.filter(b => worldIsDark(CLOCK.darkAlphaAt(b.abs % HOURS, false, false)));
	const seenBornDark = bornDark.filter(b => m.firstSeen.has(b.z));
	const waits = seen.map(b => (m.firstSeen.get(b.z).tick - b.tick) * TICK_DT);
	const waitsDark = seenBornDark.map(b => (m.firstSeen.get(b.z).tick - b.tick) * TICK_DT);
	const never = waves.filter(b => !m.firstSeen.has(b.z));
	const neverAlive = never.filter(b => host.sim.horde.zombies.includes(b.z)).length;
	const avg = (b, key) => (b.rounds > 0 ? (b[key] / b.rounds).toFixed(1) : "n/a");
	const share = b => pct(b.sent, b.alive);
	const spread = xs =>
		xs.length > 0 ? `${median(xs).toFixed(1)} s median, ${Math.max(...xs).toFixed(1)} s worst` : "—";
	info(
		`— a survivor who ${move ? "RUNS" : "STANDS STILL"}, night of day ${day} (19:00 → 06:00, ${m.rounds} snapshots):`,
	);
	info(
		`  wave zombies born: ${waves.length} (${bornDark.length} of them in the dark), ` +
			`${Math.min(...waves.map(b => b.dist)).toFixed(0)}–${Math.max(...waves.map(b => b.dist)).toFixed(0)} u away`,
	);
	const fill = host.fills.find(f => f.day === day);
	const clock = host.sim.clock;
	const owed = sum(clock.waveQueues) + sum(clock.specialWaveQueues);
	if (fill !== undefined) {
		info(
			`  promised at dusk: ${slash(fill.walkers)} walkers + ${slash(fill.specials)} specials = ` +
				`${sum(fill.walkers) + sum(fill.specials)}; still owed at dawn: ${slash(clock.waveQueues)} + ` +
				`${slash(clock.specialWaveQueues)} = ${owed}` +
				(owed > 0
					? ` (held back by the tide's ceilings around the cluster — 40·S(k) walkers, 4 + k − 1 specials — ` +
						`while nobody kills; waves 1–2 stop pouring at midnight and what they owe carries over to the next dusk)`
					: ""),
		);
	}
	info(
		`  really received (after the birth flash): ${seen.length} of ${waves.length} (${pct(seen.length, waves.length)}), ` +
			`first sight ${spread(waits)}`,
	);
	info(
		`    of the ${bornDark.length} born in the dark: ${seenBornDark.length} (${pct(seenBornDark.length, bornDark.length)}), ` +
			`first sight ${spread(waitsDark)}`,
	);
	info(
		`  never received: ${never.length} (${neverAlive} still alive at dawn, ${never.length - neverAlive} gone before it)`,
	);
	info(
		`  birth flash: ${m.flashed.size()} were on the wire in the dark for their first ~${(BIRTH_FLASH_S * 1000).toFixed(0)} ms ` +
			`only because they are born with alpha 1, wherever they stood`,
	);
	info(
		`  per snapshot, whole night: ${avg(m, "alive")} wave zombies alive, ${avg(m, "ring")} inside the ` +
			`${CFG.INTEREST_MID} u ring, ${avg(m, "sent")} on the wire (${share(m)} of their time); ` +
			`${pct(m.withAny, m.rounds)} of the snapshots carried one`,
	);
	info(
		`  per snapshot, DARK part only (${m.dark.rounds} snapshots): ${avg(m.dark, "alive")} alive, ` +
			`${avg(m.dark, "ring")} in the ring, ${avg(m.dark, "sent")} on the wire (${share(m.dark)} of their time); ` +
			`${pct(m.dark.withAny, m.dark.rounds)} carried one`,
	);
	if (run !== undefined) {
		info(
			`  (ran ${run.st.travelled.toFixed(0)} u in ${(host.sim.tick * TICK_DT).toFixed(0)} s, ` +
				`turned at a wall ${run.st.blocked} times)`,
		);
	}
	if (m.malformed > 0) info(`  ${m.malformed} snapshot part(s) did not decode`);
}

info(
	`§4.3: in the dark (world ambient < 0.4, ~19:16 → 04:44) a zombie is sent only when lit (alpha > 0.05; the ` +
		`survivor's own light is ${PLAYER_LIGHT_R} u) or within DARK_SENSE_RANGE = ${CFG.DARK_SENSE_RANGE} u`,
);
measureNight("stand", 1, false);
measureNight("run", 1, true);
if (HARD_DAY > 0) {
	measureNight("stand", HARD_DAY, false);
	measureNight("run", HARD_DAY, true);
}

// ================================================================ 5: no safe spot inside a building (EDI-11)

section(
	"5) no safe spot: the night's horde reaches a survivor hiding in the deepest room of the largest building, " +
		"as it reaches one in the open (EDI-10, EDI-11)",
);

const PH = require(join(SRC, "shared/game/physics.ts"));
const { buildingAt: buildingAtW } = require(join(SRC, "shared/game/world.ts"));
const { zombieRadius } = require(join(SRC, "shared/game/entities.ts"));

/**
 * The hiding spot: in the town's largest building, the place a survivor (radius 18) can stand that is the longest
 * walk for a walker (radius 16) from anywhere outside -- a Dijkstra on an 8 u grid over the building and 200 u
 * round it, through doorways and (at their slowness, 1 / VAULT_SLOW) through windows. And the open spot to
 * compare with: out of the main door, on the street in front of the same building.
 */
function hidingSpots(type) {
	const town = generateTown(DESIGN.TOWN_SEED);
	let b;
	for (const s of town.solids) {
		if (s.kind !== "building" || s.rooms === undefined) continue;
		if (type !== undefined && s.buildingType !== type) continue;
		if (b === undefined || s.w * s.h > b.w * b.h || (s.w * s.h === b.w * b.h && s.id < b.id)) b = s;
	}
	const C = 8;
	const M = 200;
	const x0 = b.x - M;
	const y0 = b.y - M;
	const cols = Math.ceil((b.w + 2 * M) / C);
	const rows = Math.ceil((b.h + 2 * M) / C);
	const n = cols * rows;
	const at = k => [x0 + (k % cols) * C + C / 2, y0 + Math.floor(k / cols) * C + C / 2];
	const walk = new Uint8Array(n);
	const stand = new Uint8Array(n);
	const inside = new Uint8Array(n);
	const slow = new Float64Array(n);
	for (let k = 0; k < n; k++) {
		const [x, y] = at(k);
		walk[k] = PH.circleBlocked(town, x, y, PH.ZOMBIE_RADIUS) === undefined ? 1 : 0;
		stand[k] = PH.circleBlocked(town, x, y, PH.PLAYER_RADIUS) === undefined ? 1 : 0;
		inside[k] = buildingAtW(town, x, y) === b ? 1 : 0;
		slow[k] = 1 / PH.vaultFactor(town, x, y);
	}
	const dist = new Float64Array(n).fill(Infinity);
	const heap = [];
	const push = (k, d) => {
		heap.push([d, k]);
		let i = heap.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (heap[p][0] <= heap[i][0]) break;
			[heap[p], heap[i]] = [heap[i], heap[p]];
			i = p;
		}
	};
	const pop = () => {
		const top = heap[0];
		const last = heap.pop();
		if (heap.length > 0) {
			heap[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let m = i;
				if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
				if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
				if (m === i) break;
				[heap[m], heap[i]] = [heap[i], heap[m]];
				i = m;
			}
		}
		return top;
	};
	for (let k = 0; k < n; k++) {
		if (walk[k] && !inside[k]) {
			dist[k] = 0;
			push(k, 0);
		}
	}
	while (heap.length > 0) {
		const [d, k] = pop();
		if (d > dist[k]) continue;
		const i = k % cols;
		const j = (k - i) / cols;
		for (let dj = -1; dj <= 1; dj++) {
			for (let di = -1; di <= 1; di++) {
				if (di === 0 && dj === 0) continue;
				const ni = i + di;
				const nj = j + dj;
				if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
				const nk = nj * cols + ni;
				if (!walk[nk]) continue;
				if (di !== 0 && dj !== 0 && (!walk[j * cols + ni] || !walk[nj * cols + i])) continue;
				const step = (di !== 0 && dj !== 0 ? Math.SQRT2 : 1) * C * Math.max(slow[k], slow[nk]);
				if (d + step < dist[nk]) {
					dist[nk] = d + step;
					push(nk, d + step);
				}
			}
		}
	}
	let deep = -1;
	for (let k = 0; k < n; k++) {
		if (!inside[k] || !stand[k] || !(dist[k] < Infinity)) continue;
		if (deep < 0 || dist[k] > dist[deep]) deep = k;
	}
	const [hx, hy] = at(deep);
	const room = (b.rooms ?? []).find(q => hx >= q.x && hx <= q.x + q.w && hy >= q.y && hy <= q.y + q.h);
	// the open spot: 300 u out of the main door, on the street side, the nearest free point
	const nrm = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }[b.doorSide];
	let open;
	for (let r = 0; r < 200 && open === undefined; r += 8) {
		for (let a = 0; a < 16 && open === undefined; a++) {
			const x = b.doorX + nrm[0] * 300 + Math.cos((a / 16) * Math.PI * 2) * r;
			const y = b.doorY + nrm[1] * 300 + Math.sin((a / 16) * Math.PI * 2) * r;
			if (PH.circleBlocked(town, x, y, PH.PLAYER_RADIUS + 12) === undefined) open = { x, y };
		}
	}
	return { b, hide: { x: hx, y: hy }, room: room?.kind ?? "?", walk: dist[deep], open };
}

/**
 * One night from 18:30 of day 1 with an immortal survivor held at (x, y), no input, for 90 s from the first wave
 * zombie's birth: when zombies -- the night's waves and whatever walked the town before -- first come within
 * biting reach of the survivor (a walker bites from its contact distance plus BITE_KEEP), how many distinct ones
 * have, and the share of that time a zombie stands in reach. Also the average tick cost of the run.
 */
function hordeReach(label, spot) {
	const host = newHost(label, {
		seed: 77,
		clock: () => new WorldClock({ day: 1, dayTime: 18.5, rollRain: () => false }),
	});
	const sp = enter(host, label);
	host.immortal.add(sp.slot);
	sp.spawnShieldUntil = 0;
	host.beforeStep = () => {
		sp.state.x = spot.x;
		sp.state.y = spot.y;
	};
	// the shims give Map a Luau-style size(): a plain object and a counter keep this independent of them
	const reached = new Map();
	let count = 0;
	let firstWave;
	let ticks = 0;
	let ms = 0;
	let window = 0;
	let pressed = 0;
	const span = Math.ceil(90 / TICK_DT);
	for (let guard = 0; guard < 400000; guard++) {
		const t0 = process.hrtime.bigint();
		tick(host);
		ms += Number(process.hrtime.bigint() - t0) / 1e6;
		ticks++;
		if (firstWave === undefined) {
			const w = host.births.find(b => b.wave);
			if (w === undefined) continue;
			firstWave = w.tick;
			// the horde from outside only: whatever walked up to the spot before nightfall (an ambient walker that
			// happened to be born next to it) is taken out -- the server turns a vanished zombie into a silent
			// despawn -- so both runs start from the same empty ground round the survivor
			const zs = host.sim.horde.zombies;
			for (let i = zs.length - 1; i >= 0; i--) if (!zs[i].wave) zs.splice(i, 1);
			continue;
		}
		let inReach = 0;
		for (const z of host.sim.horde.zombies) {
			if (z.hp <= 0) continue;
			const bite = PH.PLAYER_RADIUS + zombieRadius(z) + 16;
			if (Math.hypot(z.x - spot.x, z.y - spot.y) > bite) continue;
			inReach++;
			if (!reached.has(z)) {
				reached.set(z, host.sim.tick);
				count++;
			}
		}
		if (count > 0) {
			window++;
			if (inReach > 0) pressed++;
		}
		if (host.sim.tick - firstWave > span) break;
	}
	const since = [...reached.values()].map(t => (t - firstWave) * TICK_DT).sort((a, b) => a - b);
	return {
		first: since.length > 0 ? since[0] : Infinity,
		third: since.length >= 3 ? since[2] : Infinity,
		count,
		pressed: window > 0 ? pressed / window : 0,
		msPerTick: ms / ticks,
	};
}

/**
 * The largest building (a supermarket or a big house: open floors) and the school (classrooms off a corridor, the
 * most walls between the street and its deepest room), each against the open street in front of it.
 */
for (const [which, type] of [
	["the largest building", undefined],
	["the school", 3],
]) {
	const spots = hidingSpots(type);
	const b = spots.b;
	info(
		`${which}: ${b.tags} #${b.id} (${b.w} x ${b.h}, ${b.openings.filter(o => o.kind === "door").length} doors, ` +
			`${b.openings.filter(o => o.kind === "window").length} windows); its deepest spot: the ${spots.room} at ` +
			`(${spots.hide.x.toFixed(0)}, ${spots.hide.y.toFixed(0)}), ${spots.walk.toFixed(0)} u of walking from ` +
			`outside for a walker (${(spots.walk / 90).toFixed(1)} s at 90 u/s)`,
	);
	const inside = hordeReach("hide", spots.hide);
	const open = hordeReach("open", spots.open);
	const f = v => (Number.isFinite(v) ? `${v.toFixed(1)} s` : "never");
	for (const [label, r] of [
		["  hidden inside", inside],
		["  in the open  ", open],
	]) {
		info(
			`${label}: a zombie in biting reach ${f(r.first)} after the first wave birth, three ${f(r.third)}; ` +
				`${r.count} zombies reached the body in 90 s; a zombie in reach ${(r.pressed * 100).toFixed(0)}% of the ` +
				`time since the first; ${r.msPerTick.toFixed(3)} ms a tick`,
		);
	}
	/*
	 * The bound: hiding may cost the horde the walk in from the building's edge -- tools/validate-world.mjs caps the
	 * worst room at REACH_BOUND_S = 12 s for a walker -- and never more. And the horde must keep up the pressure in
	 * there (several ways in, not one queue): three zombies within the open's time for three plus the same 12 s,
	 * and one in reach at least half as much of the time as in the open.
	 */
	check(
		`${which}, hidden in its deepest room: a zombie reaches the survivor within the open's time + 12 s`,
		inside.first <= open.first + 12,
		`${f(inside.first)} vs ${f(open.first)} in the open`,
	);
	check(
		`${which}: three do within the open's time for three + 12 s, and one stays in reach at least half as much`,
		inside.third <= open.third + 12 && inside.pressed >= open.pressed * 0.5,
		`${f(inside.third)} vs ${f(open.third)}; ${(inside.pressed * 100).toFixed(0)}% vs ${(open.pressed * 100).toFixed(0)}% of the time`,
	);
}

// ================================================================ 6: the weather on the server (LUZ-05)

section(
	"6) the weather on the server (LUZ-05): the real ServerSimulation's horde in fog and in a storm -- the eyes and " +
		"the ears the survivor's screen and speakers promise",
);

{
	const W = require(join(SRC, "shared/sim/weather.ts"));
	const Brain = require(join(SRC, "shared/sim/ai/zombieBrain.ts"));
	const { createZombie } = require(join(SRC, "shared/game/entities.ts"));
	const K = W.Weather;
	// the longest plain street of the town: the survivor on its centre line, the walkers along it
	const town = generateTown(DESIGN.TOWN_SEED);
	const road = [...town.roads]
		.filter(r => !r.avenue)
		.sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || a.x - b.x || a.y - b.y)[0];
	const along = road.vertical ? [0, 1] : [1, 0];
	const spot = { x: road.x + road.w / 2, y: road.y + road.h / 2 };

	/**
	 * A server on world day `day` at `hour` of weather `kind`, one immortal survivor held on the street, and walkers held
	 * at `dist` u along it (both ways, four lanes each), facing the survivor (`facing`) or away from it. The horde is
	 * only these walkers: everything the spawner adds is taken out each tick. Returns what they became after `seconds`
	 * -- and, with `shotAtHour`, a pistol's shot from the survivor's spot at that hour of the clock (the moment it is fired).
	 */
	function street({ kind, day, hour, dist, facing, seconds, shotAtHour }) {
		const host = newHost(`weather-${kind}-${dist}`, {
			seed: 606,
			clock: () => new WorldClock({ day, dayTime: hour, rollWeather: () => kind }),
		});
		const sp = enter(host, "wx");
		host.immortal.add(sp.slot);
		sp.spawnShieldUntil = 0;
		const horde = host.sim.horde;
		const mine = [];
		for (const sign of [-1, 1]) {
			for (const lane of [-60, -20, 20, 60]) {
				const x = spot.x + along[0] * sign * dist + along[1] * lane;
				const y = spot.y + along[1] * sign * dist + along[0] * lane;
				const z = createZombie(1, x, y, day, false);
				z.detect = false;
				const toward = Math.atan2(spot.y - y, spot.x - x);
				mine.push({ z, x, y, angle: facing ? toward : toward + Math.PI });
			}
		}
		const hold = () => {
			sp.state.x = spot.x;
			sp.state.y = spot.y;
			for (let k = horde.zombies.length - 1; k >= 0; k--) {
				if (!mine.some(m => m.z === horde.zombies[k])) horde.zombies.splice(k, 1);
			}
			for (const m of mine) {
				if (!horde.zombies.includes(m.z)) horde.zombies.push(m.z);
				m.z.x = m.x;
				m.z.y = m.y;
				m.z.angle = m.angle;
			}
		};
		host.beforeStep = hold;
		if (shotAtHour !== undefined) host.sim.clock.setClock(shotAtHour);
		hold();
		const clock = host.sim.clock;
		const state = { fog: clock.fog, mask: clock.thunderMask, dark: clock.darkAlpha };
		if (shotAtHour !== undefined) Brain.emitSound(horde.refs, spot.x, spot.y, 800, true);
		for (let i = 0; i < Math.round(seconds / TICK_DT); i++) tick(host);
		const aware = mine.filter(m => (m.z.aware ?? 0) >= 1).length;
		return { aware, of: mine.length, ...state };
	}

	// ---- the eyes: 380 u down a clear street by day is well inside 520 u; in the thickest fog it is past 260 u
	const clearDay = street({ kind: K.Clear, day: 9, hour: 6.2, dist: 380, facing: true, seconds: 1.5 });
	const foggy = street({ kind: K.DawnFog, day: 9, hour: 6.2, dist: 380, facing: true, seconds: 1.5 });
	const close = street({ kind: K.DawnFog, day: 9, hour: 6.2, dist: 200, facing: true, seconds: 1.5 });
	info(
		`walkers looking at the survivor from 380 u: ${clearDay.aware}/${clearDay.of} noticed on a clear morning, ` +
			`${foggy.aware}/${foggy.of} in the dawn fog (density ${foggy.fog.toFixed(2)}); from 200 u in the fog ${close.aware}/${close.of}`,
	);
	check(
		"on a clear morning the horde down the street sees the survivor (380 u, inside the day's 520 u)",
		clearDay.aware >= 6,
		`${clearDay.aware}/${clearDay.of}`,
	);
	check(
		"in the thickest fog the same walkers see nothing (380 u is past the fog's 260 u) -- and the survivor's screen fogs them alike",
		foggy.fog > 0.99 &&
			foggy.aware === 0 &&
			W.fogScreenAt(foggy.fog, 380) > 0.2 &&
			W.fogScreenAt(foggy.fog, 260) < 0.05,
		`${foggy.aware}/${foggy.of}; on screen ${Math.round(W.fogScreenAt(foggy.fog, 380) * 100)} % fog at 380 u, ` +
			`${Math.round(W.fogScreenAt(foggy.fog, 260) * 100)} % at 260 u`,
	);
	check(
		"...but the fog is not blindness: at 200 u they see the survivor",
		close.aware >= 6,
		`${close.aware}/${close.of}`,
	);

	// ---- the ears: a pistol's shot from the survivor, 400 u from walkers facing away, in a storm by day
	const day = 11;
	const strike = W.strikesOfDay(day).find(s => s.hour > 8 && s.hour < 16);
	const speed = CLOCK.clockSpeed(strike.hour);
	const onset = strike.hour + strike.delay * speed;
	const before = street({
		kind: K.Storm,
		day,
		hour: 8,
		dist: 400,
		facing: false,
		seconds: 3,
		shotAtHour: onset - 1.2 * speed,
	});
	const after = street({
		kind: K.Storm,
		day,
		hour: 8,
		dist: 400,
		facing: false,
		seconds: 3,
		shotAtHour: onset + 0.4 * speed,
	});
	info(
		`a strike at ${strike.hour.toFixed(3)} h, its thunder ${strike.delay.toFixed(2)} s later: a shot 1.2 s before the ` +
			`clap reaches ${(800 * 0.6 * before.mask).toFixed(0)} u (${before.aware}/${before.of} walkers turn), 0.4 s after it ` +
			`${(800 * 0.6 * after.mask).toFixed(0)} u (${after.aware}/${after.of})`,
	);
	check(
		"in the rain of a storm, a shot is heard 480 u away (the rain's 60 %): the walkers at 400 u turn to it",
		before.mask === 1 && before.aware >= 6,
		`${before.aware}/${before.of}`,
	);
	check(
		"...fired right after the thunder it carries 40 % of that (192 u): nobody turns -- the storm's window",
		after.mask === W.THUNDER_HEARING && after.aware === 0,
		`${after.aware}/${after.of}`,
	);
}

// ---------------------------------------------------------------- verdict

console.log(`\n${((Date.now() - started) / 1000).toFixed(1)} s`);
if (failures > 0) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("all wave delivery tests passed");
