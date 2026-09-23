#!/usr/bin/env node
/*
 * F2 acceptance: the server's horde, on every client's screen (docs/MULTIPLAYER.md §4.2, §4.3, §4.4, §4.7,
 * §11.3 F2, §12.2). It runs the REAL server pipeline — ServerSimulation → Replicator → the wire — and the
 * REAL client one — decodeSnapshotPart → SnapshotBuffer → interpolation — with nothing in between but bytes.
 *
 *   node tools/test-replication.mjs                 # everything (exit code 1 on any failure)
 *   node tools/test-replication.mjs --seconds 30    # longer bandwidth window (default 20 s of game)
 *   PZ_SRC=path/to/src node tools/test-replication.mjs
 *
 * What it proves, and why each line is in §11.3's acceptance list:
 *
 *   a. THREE CLIENTS SEE THE SAME ZOMBIES. Three survivors standing together receive the same `netId`s and
 *      draw them within ±4 u of one another after interpolation, and within ±4 u of the server's own
 *      positions. That is the one thing F2 exists for: before it, every client made up its own horde.
 *   b. INTEREST AND THE DARK (§4.3). A zombie past the hysteresis band is not sent; at night one outside
 *      every light is not sent either, unless it is within DARK_SENSE_RANGE — which is what stops the wire
 *      being a wallhack, and is measured here rather than asserted in a comment.
 *   c. DEATH IS RELIABLE (§4.4). A killed zombie leaves through `ZombieDied` with its position, and the
 *      client's interpolation drops it at once instead of letting it walk on for another 300 ms.
 *   d. BANDWIDTH (§4.7, §12.2). Six survivors, night, the horde at its ceiling, everybody shooting: the
 *      per-second downstream of each client is measured and its p95 compared with the 23 kB/s budget.
 *   e. XP COMES FROM THE SERVER (§3.6, §11.3 F2). The kill pays the killer and the assist, into the live
 *      save, and a client report can no longer move any of those fields.
 *   f. TICK COST (§3.2). 150 zombies and 6 survivors, measured per tick. In Node this is a comparison and a
 *      regression guard, never the verdict — Luau on a Roblox server is slower.
 *
 * Pure Node (>= 18) + the project's TypeScript, with the Luau shims of tools/test-sim.mjs and the STRICT
 * `buffer` of tools/test-net.mjs (an out-of-range write throws instead of silently corrupting a neighbour).
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
const BENCH_TICKS = argValue("--bench", 3600);

// ---------------------------------------------------------------- deterministic RNG (never math.random)

/** mulberry32: the spawn search must give the same answer on every run */
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
defineMethod(Array.prototype, "pop", function () {
	// roblox-ts pop() is Luau's table.remove(t): the LAST element, and undefined on an empty table
	return this.length === 0 ? undefined : this.splice(this.length - 1, 1)[0];
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
const { stepPlayer } = require(join(SRC, "shared/sim/playerMove.ts"));
const CFG = require(join(SRC, "shared/net/mpConfig.ts"));
const P = require(join(SRC, "shared/net/protocol.ts"));
const { seqDiff } = require(join(SRC, "shared/net/codec.ts"));
const PL = require(join(SRC, "server/sim/players.ts"));
const { ServerSimulation } = require(join(SRC, "server/sim/simulation.ts"));
const { Replicator, mapHashOf, wirePosition } = require(join(SRC, "server/net/replication.ts"));

const TICK_DT = 1 / CFG.SIM_HZ;

// ---------------------------------------------------------------- reporting

let failures = 0;
const fail = msg => {
	failures++;
	console.log(`  FAIL  ${msg}`);
};
const ok = msg => console.log(`  ok    ${msg}`);
const info = msg => console.log(`        ${msg}`);
const section = title => console.log(`\n${title}`);

function check(cond, msg) {
	if (cond) ok(msg);
	else fail(msg);
	return cond;
}

function checkEq(actual, expected, msg) {
	return check(actual === expected, `${msg} (got ${actual}, expected ${expected})`);
}

function checkNear(actual, expected, tol, msg) {
	const d = Math.abs(actual - expected);
	return check(d <= tol, `${msg} (|${actual} − ${expected}| = ${d.toFixed(6)} ≤ ${tol})`);
}
// ---------------------------------------------------------------- the modules this test adds

/** the town both sides generate from the same seed (§4.5: one map, checked by its hash) */
const world = generateTown(DESIGN.TOWN_SEED);

const { createZombie, resetEntityIds } = require(join(SRC, "shared/game/entities.ts"));
const PROG = require(join(SRC, "server/sim/progress.ts"));
const { SnapshotBuffer } = require(join(SRC, "client/net/snapshotBuffer.ts"));

const SECONDS = argValue("--seconds", 20);

// ---------------------------------------------------------------- the fake server and its clients

/** everything the transport recorded, per slot, with the tick it was recorded at */
function recordingTransport() {
	const snaps = new Map();
	const fxs = new Map();
	const worlds = new Map();
	const broadcasts = [];
	const push = (map, slot, packet) => {
		let list = map.get(slot);
		if (list === undefined) {
			list = [];
			map.set(slot, list);
		}
		list.push(packet);
	};
	return {
		snaps,
		fxs,
		worlds,
		broadcasts,
		snap(slot, part) {
			push(snaps, slot, part);
		},
		fx(slot, packet) {
			push(fxs, slot, packet);
		},
		world(slot, packet) {
			push(worlds, slot, packet);
		},
		worldAll(packet) {
			broadcasts.push(packet);
		},
	};
}

/**
 * The whole pipeline with no Roblox in it: the same ServerSimulation the host drives, the same Replicator,
 * and one real client-side SnapshotBuffer per slot fed with the very bytes the transport recorded.
 */
function newWorldServer() {
	resetEntityIds();
	const sim = new ServerSimulation({ world, zombies: true });
	const transport = recordingTransport();
	const replicator = new Replicator(sim, transport, { tick0Time: 0, mapHash: mapHashOf(world) });
	sim.onTick = tick => replicator.afterTick(tick);
	sim.onFx = event => replicator.queueFx(event);
	const clients = new Map();
	return { sim, transport, replicator, clients, now: 0 };
}

/**
 * Downstream latency of each client, in ticks: 0, 50 ms and 100 ms. Without it the three clients would be
 * handed identical bytes at identical moments and would interpolate to identical positions — a comparison
 * that proves the encoder is deterministic and nothing else. §11.3's ±4 u is about three clients at three
 * different distances from the server, which is what this models.
 */
const CLIENT_LAG_TICKS = [0, 3, 6];
/**
 * And a different loss rate each, the 1–2 % §12.1 asks the Studio runs to simulate. Loss is what actually
 * pulls the three drawings apart: a client missing a snapshot interpolates across a longer gap, and one
 * missing two in a row has to extrapolate. §11.3's ±4 u is the promise that neither of those shows.
 */
const CLIENT_LOSS = [0, 0.01, 0.02];

function addSurvivor(server, slot, x, y) {
	const save = defaultSave();
	const sp = PL.createServerPlayer(
		{ slot, userId: 1000 + slot, name: `p${slot}` },
		save,
		x,
		y,
		server.sim.tick,
		CFG.SIM_HZ,
	);
	server.sim.add(sp);
	server.replicator.welcome(sp);
	const buffer = new SnapshotBuffer();
	buffer.setRate(CFG.SIM_HZ);
	server.clients.set(slot, {
		buffer,
		/** packets still in flight towards this client: [releaseTick, part] */
		inbox: [],
		lag: CLIENT_LAG_TICKS[slot % CLIENT_LAG_TICKS.length],
		loss: CLIENT_LOSS[slot % CLIENT_LOSS.length],
		parts: 0,
		fxEvents: 0,
		fxByType: new Map(),
		deaths: [],
		/** how many snapshots carried each netId: the mid ring must arrive at half the near ring's rate */
		counts: new Map(),
		snapshots: 0,
		/** slots named by every `Shake` this client received: all of them must be this client's own */
		shakeSlots: new Set(),
	});
	return sp;
}

/** one command per tick for every survivor, so the input queue never runs dry (§2.2) */
function feedInput(server, edges = 0) {
	for (const sp of server.sim.players()) {
		const seq = (sp.lastSeq ?? 0) + 1;
		const packet = {
			viewTick: Math.max(0, server.sim.tick - 6),
			viewFrac: 0,
			cmds: [{ seq: seq % 65536, moveAng: 0, moveMag: 0, aim: 0, held: 0, edges }],
		};
		const payload = P.encodeInput(packet);
		PL.ingestInput(sp, payload, server.now);
	}
}

/**
 * One tick of the server, then every recorded packet handed to the client it was addressed to — the client
 * side runs the real decoder, so a byte the server writes wrongly fails here and not in a playtest.
 */
function tickServer(server, opts = {}) {
	server.now += TICK_DT;
	feedInput(server, opts.edges ?? 0);
	const started = process.hrtime.bigint();
	server.sim.step();
	const ms = Number(process.hrtime.bigint() - started) / 1e6;
	const t = server.transport;
	for (const [slot, list] of t.snaps) {
		const client = server.clients.get(slot);
		for (const raw of list) {
			const part = P.decodeSnapshotPart(raw);
			if (part === undefined) {
				fail(`a Snap part did not decode for slot ${slot}`);
				continue;
			}
			// an unreliable packet that is lost is simply never handed over (§4.1: the next one supersedes it)
			if (client.loss > 0 && nextRandom() < client.loss) continue;
			client.inbox.push([server.sim.tick + client.lag, part]);
		}
		list.length = 0;
	}
	// everything whose flight time is up is handed to the real client-side buffer, with the clock estimate
	// that client would have: the server's tick minus its own latency (§4.6 gives it the same anchor)
	for (const [, client] of server.clients) {
		while (client.inbox.length > 0 && client.inbox[0][0] <= server.sim.tick) {
			const part = client.inbox.shift()[1];
			client.buffer.receive(part, server.sim.tick, server.now);
			client.parts += 1;
			if (part.part === 0) client.snapshots += 1;
			for (const z of part.zombies) client.counts.set(z.netId, (client.counts.get(z.netId) ?? 0) + 1);
		}
	}
	for (const [slot, list] of t.fxs) {
		const client = server.clients.get(slot);
		for (const raw of list) {
			const batch = P.decodeFx(raw);
			if (batch === undefined) {
				fail(`an Fx batch did not decode for slot ${slot}`);
				continue;
			}
			client.fxEvents += batch.events.length;
			for (const e of batch.events) {
				client.fxByType.set(e.t, (client.fxByType.get(e.t) ?? 0) + 1);
				if (e.t === P.FxType.Shake) client.shakeSlots.add(e.slot);
			}
		}
		list.length = 0;
	}
	const reliable = [];
	for (const packet of t.broadcasts) reliable.push([undefined, packet]);
	t.broadcasts.length = 0;
	for (const [slot, list] of t.worlds) {
		for (const packet of list) reliable.push([slot, packet]);
		list.length = 0;
	}
	for (const [slot, packet] of reliable) {
		const batch = P.decodeWorld(packet);
		if (batch === undefined) {
			fail("a World batch did not decode");
			continue;
		}
		for (const e of batch.events) {
			if (e.t !== P.WorldEv.ZombieDied) continue;
			const client = server.clients.get(slot);
			if (client === undefined) continue;
			client.deaths.push(e);
			// exactly what client/net/netClient.ts does with it: the body leaves the interpolation NOW
			client.buffer.forgetZombie(e.netId);
		}
	}
	return ms;
}

/** advances every client's interpolation the way a frame would, and returns their drawn hordes */
function drawClients(server, dt = TICK_DT) {
	const out = new Map();
	for (const [slot, client] of server.clients) {
		client.buffer.advance(dt, server.sim.tick, server.now, world);
		const byId = new Map();
		for (const z of client.buffer.zombieStates()) byId.set(z.netId, z);
		out.set(slot, byId);
	}
	return out;
}

/** drops `n` zombies in a ring around a point, exactly as an admin spawn would (§10) */
function seedHorde(server, n, cx, cy, radius) {
	const horde = server.sim.horde;
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2;
		const r = radius * (0.35 + 0.65 * ((i * 37) % 100) / 100);
		const z = createZombie(1, cx + Math.cos(a) * r, cy + Math.sin(a) * r, 5, false);
		z.alpha = 1;
		horde.zombies.push(z);
	}
	return horde.zombies.length;
}

function percentile(values, p) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

// ================================================================ (a) three clients, one horde

section("(a) three clients see the SAME zombies (§11.3 F2: same netIds, ±4 u after interpolation)");
{
	const server = newWorldServer();
	const cx = world.width / 2;
	const cy = world.height / 2;
	// standing together, so the three interest sets are the same set and the comparison is about the WIRE
	// and not about who can see what
	addSurvivor(server, 0, cx, cy);
	addSurvivor(server, 1, cx + 40, cy);
	addSurvivor(server, 2, cx - 40, cy + 30);
	seedHorde(server, 60, cx, cy, 600);
	// the horde needs a few ticks to be registered (netIds) and a few more to fill the interpolation buffer
	for (let i = 0; i < 90; i++) {
		tickServer(server);
		drawClients(server);
	}
	const drawn = drawClients(server);
	const a = drawn.get(0);
	const b = drawn.get(1);
	const c = drawn.get(2);
	// note: the Luau shims turn Map.size into a METHOD, so every count in this file is `size()`
	check(a.size() > 40, `client 0 is drawing the horde (${a.size()} zombies)`);
	checkEq(b.size(), a.size(), "client 1 draws the same number of zombies");
	checkEq(c.size(), a.size(), "client 2 draws the same number of zombies");
	let missing = 0;
	let worst = 0;
	let worstServer = 0;
	const horde = server.sim.horde;
	const serverById = new Map();
	for (const z of horde.zombies) serverById.set(horde.netIdOf(z), z);
	for (const [netId, za] of a) {
		const zb = b.get(netId);
		const zc = c.get(netId);
		if (zb === undefined || zc === undefined) {
			missing += 1;
			continue;
		}
		worst = Math.max(worst, Math.hypot(za.x - zb.x, za.y - zb.y), Math.hypot(za.x - zc.x, za.y - zc.y));
		const truth = serverById.get(netId);
		if (truth !== undefined) worstServer = Math.max(worstServer, Math.hypot(za.x - truth.x, za.y - truth.y));
	}
	checkEq(missing, 0, "every netId one client draws, the other two draw too");
	check(
		worst <= 4,
		`the same zombie is within 4 u on every screen, at 0/50/100 ms and 0/1/2 % loss ` +
			`(worst ${worst.toFixed(2)} u)`,
	);
	info(`worst distance from the server's own position: ${worstServer.toFixed(2)} u (interpolation delay)`);
	// the same body, the same type: a client must never be shown a different creature
	let sameType = true;
	for (const [netId, za] of a) {
		const zb = b.get(netId);
		if (zb !== undefined && zb.type !== za.type) sameType = false;
	}
	check(sameType, "and it is the same archetype on every screen");
}

// ================================================================ (b) interest, walls and the dark

section("(b) interest rings and the anti-wallhack rules of §4.3");
{
	const server = newWorldServer();
	const cx = world.width / 2;
	const cy = world.height / 2;
	addSurvivor(server, 0, cx, cy);
	const horde = server.sim.horde;
	// one far away (past INTEREST_EXIT), one close and lit, one close and in the dark
	const far = createZombie(1, cx + CFG.INTEREST_EXIT + 400, cy, 5, false);
	const lit = createZombie(1, cx + 400, cy, 5, false);
	const dark = createZombie(1, cx, cy + 400, 5, false);
	const near = createZombie(1, cx + 100, cy, 5, false);
	for (const z of [far, lit, dark, near]) horde.zombies.push(z);
	// broad daylight first: everything in the rings is visible (§4.3 rule 3)
	server.sim.clock.setClock(12);
	for (let i = 0; i < 12; i++) {
		for (const z of [far, lit, dark, near]) z.alpha = 1;
		tickServer(server);
	}
	let seen = drawClients(server).get(0);
	check(seen.has(horde.netIdOf(lit)), "by day a zombie inside the ring is sent");
	check(!seen.has(horde.netIdOf(far)), "and one past the hysteresis band is not");
	// now night, with the two close ones outside every light
	server.sim.clock.setClock(23);
	for (let i = 0; i < 40; i++) {
		lit.alpha = 1;
		dark.alpha = 0;
		near.alpha = 0;
		tickServer(server);
	}
	seen = drawClients(server).get(0);
	check(seen.has(horde.netIdOf(lit)), "at night a zombie standing in a light is still sent");
	check(
		!seen.has(horde.netIdOf(dark)),
		"one outside every light, past DARK_SENSE_RANGE, is NOT sent (§4.3: no wallhack in the dark)",
	);
	check(
		seen.has(horde.netIdOf(near)),
		`one in the dark but within ${CFG.DARK_SENSE_RANGE} u IS sent (you hear it)`,
	);
}

// ================================================================ (c) a death is reliable

section("(c) a killed zombie leaves through the reliable channel (§4.4)");
{
	const server = newWorldServer();
	const cx = world.width / 2;
	const cy = world.height / 2;
	addSurvivor(server, 0, cx, cy);
	const horde = server.sim.horde;
	const victim = createZombie(1, cx + 200, cy, 5, false);
	victim.alpha = 1;
	horde.zombies.push(victim);
	for (let i = 0; i < 30; i++) tickServer(server);
	const netId = horde.netIdOf(victim);
	check(drawClients(server).get(0).has(netId), "the client is drawing it");
	victim.hp = 0;
	for (let i = 0; i < 6; i++) tickServer(server);
	const client = server.clients.get(0);
	const died = client.deaths.filter(d => d.netId === netId);
	checkEq(died.length, 1, "exactly one ZombieDied reached the client");
	if (died.length > 0) {
		checkNear(died[0].x, victim.x, 1, "and it carries the place the body fell");
	}
	check(!drawClients(server).get(0).has(netId), "the body left the client's horde at once");
}

// ================================================================ (c2) the mid ring costs half as much

section("(c2) the mid ring arrives at half the near ring's rate (§4.3 'em rodízio')");
{
	const server = newWorldServer();
	const cx = world.width / 2;
	const cy = world.height / 2;
	addSurvivor(server, 0, cx, cy);
	const horde = server.sim.horde;
	const near = createZombie(1, cx + 300, cy, 5, false);
	// between INTEREST_NEAR (800 u) and the population's recycle radius (1080 u of every survivor), so the
	// test measures the SEND RATE of the mid ring and not the horde being cleaned up behind its back
	const mid = createZombie(1, cx + 950, cy, 5, false);
	for (const z of [near, mid]) horde.zombies.push(z);
	server.sim.clock.setClock(12);
	// hold them still: this measures the SEND RATE, not how far anything walked
	const freeze = () => {
		near.x = cx + 300;
		near.y = cy;
		near.alpha = 1;
		mid.x = cx + 950;
		mid.y = cy;
		mid.alpha = 1;
	};
	for (let i = 0; i < 20; i++) {
		freeze();
		tickServer(server);
	}
	const client = server.clients.get(0);
	client.counts.clear();
	client.snapshots = 0;
	const rounds = 40;
	for (let i = 0; i < rounds * CFG.SNAP_NEAR_EVERY_TICKS; i++) {
		freeze();
		tickServer(server);
	}
	check(horde.netIdOf(mid) > 0, "the mid-ring zombie is still in the world");
	const nearCount = client.counts.get(horde.netIdOf(near)) ?? 0;
	const midCount = client.counts.get(horde.netIdOf(mid)) ?? 0;
	info(`over ${client.snapshots} snapshots: near ring ${nearCount}, mid ring ${midCount}`);
	checkEq(nearCount, client.snapshots, "the near ring is in every snapshot (20 Hz)");
	check(
		midCount > 0 && Math.abs(midCount - client.snapshots / 2) <= 1,
		`the mid ring is in half of them (${midCount} of ${client.snapshots}, i.e. ${CFG.SNAP_MID_HZ} Hz)`,
	);
}

// ================================================================ (d) bandwidth (§4.7, §12.2)

section(`(d) bandwidth per client: 6 survivors, night, the horde at its ceiling, ${SECONDS} s of game`);
{
	const server = newWorldServer();
	const cx = world.width / 2;
	const cy = world.height / 2;
	for (let slot = 0; slot < CFG.MAX_PLAYERS; slot++) {
		addSurvivor(server, slot, cx + (slot % 3) * 60 - 60, cy + Math.floor(slot / 3) * 60 - 30);
	}
	server.sim.clock.setClock(22);
	const live = seedHorde(server, CFG.MAX_ZOMBIES, cx, cy, 900);
	info(`${live} zombies alive, ${server.sim.count()} survivors, hour ${server.sim.clock.dayTime.toFixed(1)}`);
	const perSecond = new Map();
	for (const slot of server.clients.keys()) perSecond.set(slot, []);
	const ticks = Math.floor(SECONDS * CFG.SIM_HZ);
	let maxParts = 0;
	for (let i = 0; i < ticks; i++) {
		// everybody keeps the light on and keeps firing: the Fx channel is part of the budget (§4.7)
		for (const z of server.sim.horde.zombies) z.alpha = 1;
		tickServer(server, { edges: P.packEdges(1, 0, 0, 0) });
		if ((i + 1) % CFG.SIM_HZ === 0) {
			for (const [slot, list] of perSecond) list.push(server.replicator.takeBytes(slot));
		}
	}
	for (const [, client] of server.clients) maxParts = Math.max(maxParts, client.parts);
	let worstP95 = 0;
	for (const [slot, list] of perSecond) {
		const p95 = percentile(list, 0.95);
		worstP95 = Math.max(worstP95, p95);
		info(`slot ${slot}: p95 ${(p95 / 1000).toFixed(2)} kB/s · max ${(Math.max(...list) / 1000).toFixed(2)} kB/s`);
	}
	const st = server.replicator.stats;
	info(
		`snapshot parts ${st.snapParts} (${(st.snapBytes / st.snapParts).toFixed(0)} B each) · ` +
			`Fx packets ${st.fxPackets} (${st.fxBytes} B) · World ${st.worldPackets} (${st.worldBytes} B)`,
	);
	info(`zombies cut by the per-snapshot cap: ${st.droppedEntities} (SNAP_ZOMBIE_CAP = ${CFG.SNAP_ZOMBIE_CAP})`);
	check(
		worstP95 <= CFG.BANDWIDTH_WORST_BPS,
		`the worst client's p95 is inside the §4.7 budget (${(worstP95 / 1000).toFixed(2)} kB/s ≤ ` +
			`${CFG.BANDWIDTH_WORST_BPS / 1000} kB/s)`,
	);
	checkEq(st.droppedEvents, 0, "no World or Fx event was too big to send");
	// the Fx channel is not decoration: the blood, the shakes and the shots of a firefight travel on it
	let fxTotal = 0;
	let strayShakes = 0;
	for (const [slot, client] of server.clients) {
		fxTotal += client.fxEvents;
		// §4.2: a Shake is addressed to ONE survivor, so it must never appear in anybody else's batch
		for (const shaken of client.shakeSlots) {
			if (shaken !== slot) strayShakes += 1;
		}
	}
	check(fxTotal > 0, `the Fx channel carried the fight (${fxTotal} events across the clients)`);
	checkEq(strayShakes, 0, "and a camera shake never reached a survivor it was not meant for");
	// the parts a client received must never exceed what a 900 B unreliable packet can hold
	let oversize = 0;
	for (const [, client] of server.clients) {
		if (client.parts === 0) oversize += 1;
	}
	checkEq(oversize, 0, "every client actually received snapshots");
}

// ================================================================ (e) XP comes from the server

section("(e) the XP is the server's (§3.6, §11.3 F2)");
{
	const server = newWorldServer();
	const cx = world.width / 2;
	const cy = world.height / 2;
	const killer = addSurvivor(server, 0, cx, cy);
	const helper = addSurvivor(server, 1, cx + 20, cy);
	const horde = server.sim.horde;
	const victim = createZombie(1, cx + 60, cy, 5, false);
	victim.alpha = 1;
	horde.zombies.push(victim);
	for (let i = 0; i < 4; i++) tickServer(server);
	const expBefore = killer.save.exp;
	const helperBefore = helper.save.exp;
	const progress = server.sim.progress;
	// the helper softened it up, the killer finished it: §3.6 pays 100 % and 60 %
	progress.noteZombieDamage(victim.id, helper.slot, victim.hpMax / 2, server.sim.tick / CFG.SIM_HZ);
	server.sim.combat.hitZombieWith(killer, victim, victim.hp + 10, 0, 0, 0);
	check(killer.save.exp > expBefore, `the killer was paid by the server (+${killer.save.exp - expBefore} xp)`);
	check(helper.save.exp > helperBefore, `and the assist too (+${helper.save.exp - helperBefore} xp)`);
	check(
		helper.save.exp - helperBefore < killer.save.exp - expBefore,
		"the assist is worth less than the kill (ASSIST_SHARE)",
	);
	// §3.6: the world rolling past midnight is what moves a survivor's OWN day, now that a report cannot. Midnight
	// pays only a survivor at the controls (server/sim/progress.ts `dayRefusal`: a real command with movement or an
	// edge in the last 3 min), so these ticks carry a reload press — harmless in the killer's hands
	const dayBefore = killer.save.day;
	server.sim.clock.setClock(23.999);
	for (let i = 0; i < 20; i++) tickServer(server, { edges: 1 << P.EdgeShift.Reload });
	checkEq(killer.save.day, dayBefore + 1, "the night that passed credited the survivor a day");
	check(killer.save.bestDay >= killer.save.day, "and the record follows it");
	// and a client report can no longer move any of it (§11.3 F2 acceptance line)
	const prev = defaultSave();
	const forged = defaultSave();
	forged.exp = prev.exp + 100000;
	forged.level = prev.level + 20;
	forged.day = prev.day + 5;
	const moved = PROG.stripClientProgress(prev, forged);
	checkEq(CFG.MP_PHASE >= PROG.PROGRESS_SERVER_PHASE, true, "MP_PHASE is at the phase where the server owns progress");
	checkEq(moved, true, "a report that tries to move progress is noticed");
	checkEq(forged.exp, prev.exp, "and its xp is pinned to the trusted copy");
	checkEq(forged.level, prev.level, "its level too");
	checkEq(forged.day, prev.day, "and its day");
}

// ================================================================ (f) tick cost (§3.2)

section("(f) the cost of a tick with 150 zombies and 6 survivors (§3.2 budget: avg ≤ 3 ms, p95 ≤ 6 ms)");
{
	const server = newWorldServer();
	const cx = world.width / 2;
	const cy = world.height / 2;
	for (let slot = 0; slot < CFG.MAX_PLAYERS; slot++) {
		addSurvivor(server, slot, cx + (slot % 3) * 300 - 300, cy + Math.floor(slot / 3) * 300 - 150);
	}
	server.sim.clock.setClock(22);
	seedHorde(server, CFG.MAX_ZOMBIES, cx, cy, 1200);
	const samples = [];
	const ticks = Math.floor(10 * CFG.SIM_HZ);
	for (let i = 0; i < ticks; i++) {
		for (const z of server.sim.horde.zombies) z.alpha = 1;
		samples.push(tickServer(server, { edges: P.packEdges(1, 0, 0, 0) }));
	}
	const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
	const p95 = percentile(samples, 0.95);
	info(`${ticks} ticks, ${server.sim.horde.count()} zombies, ${server.sim.count()} survivors, Node ${process.version}`);
	info(`tick cost (simulation + replication): avg ${avg.toFixed(3)} ms · p95 ${p95.toFixed(3)} ms`);
	info("Luau on a Roblox server is slower than Node: this is a regression guard, not the §3.2 verdict");
	check(p95 < 1000 / CFG.SIM_HZ, `p95 stays under the tick period (${p95.toFixed(3)} ms < ${(1000 / CFG.SIM_HZ).toFixed(1)} ms)`);
	checkEq(server.sim.stats.droppedTicks, 0, "no tick was dropped");
}

// ---------------------------------------------------------------- verdict

console.log("");
if (failures > 0) {
	console.log(`${failures} replication check(s) FAILED`);
	process.exit(1);
}
console.log("all replication tests passed");
