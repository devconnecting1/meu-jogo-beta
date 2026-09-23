#!/usr/bin/env node
/*
 * Server simulation tests (F1, docs/MULTIPLAYER.md §2.2, §3.1, §4.2, §4.3, §8): the authoritative tick, the
 * input queue and the snapshots of server/sim/* and server/net/* — running the very same TypeScript the live
 * server runs, with the Roblox layer (server/net/mpHost.ts) replaced by this file's clock and transport.
 *
 *   node tools/test-server-sim.mjs                  # everything (exit code 1 on any failure)
 *   node tools/test-server-sim.mjs --seed 7         # another spawn seed (default 1)
 *   node tools/test-server-sim.mjs --bench 6000     # longer §3.2 cost measurement (default 3600 ticks)
 *   PZ_SRC=path/to/src node tools/test-server-sim.mjs
 *
 * What it proves, on the generated town (fixed seed), with 3 fake players whose packets go through
 * encodeInput → ingestInput (token bucket, decodeInput, counters) exactly like a real client's:
 *
 *   a. the position the server simulates is BIT-IDENTICAL to the one the client's prediction reaches with the
 *      same commands through `stepPlayer` (§2.2: one implementation, so prediction and server cannot drift);
 *   b. a client that sends TWICE as many commands per second does not move one unit further and shows up in
 *      `inputOverflow` (§2.2, §9.1 "speedhack: impossível por construção"); a 4× client also hits the token
 *      bucket (§8.2);
 *   c. duplicated (the §2.2 redundancy) and out-of-order commands move the survivor exactly once, in order;
 *   d. with an empty queue the survivor STOPS instead of coasting, and the filled tick WAITS: it spends no seq
 *      and acknowledges nothing, so a command that arrives late is still simulated — the delayed walker ends
 *      bit for bit where the punctual one does (§2.2) — while a lag switch banks at most INPUT_BUFFER_MAX
 *      ticks, a stalled client simply carries on, a numbering that jumped past the window or restarted is
 *      re-anchored, and copies of simulated commands never re-anchor (nothing is simulated twice);
 *   e. the snapshots the replicator produces decode back (decodeSnapshotPart) with the right positions,
 *      `lastSeq`/`ackSeq` for the reconciliation, and the three interest rings of §4.3 (near in every
 *      snapshot, mid in half of them, nothing past the hysteresis band); the reliable World batch carries
 *      InitBegin + the roster on join and PlayerLeft on leave (§4.4, §4.5);
 *   f. malicious payloads (strings, numbers, tables, truncated and oversized buffers) never throw, never move
 *      anyone, and are counted as malformed (§8.1, §8.3);
 *   g. the cost of a full tick (simulation + replication) with 6 players, as the §3.2 budget wants it measured.
 *
 * Pure Node (>= 18) + the project's TypeScript (devDependency) to transpile src/ on the fly, with the Luau
 * shims of tools/test-sim.mjs (math, Color3, Array methods) and tools/test-net.mjs (a STRICT `buffer`: an
 * out-of-bounds or out-of-range write throws instead of silently corrupting a neighbouring field).
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
	// roblox-ts pop() is Luau's table.remove(t): the last element, and undefined on an empty table
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

// ---------------------------------------------------------------- the fake server

const world = generateTown(DESIGN.TOWN_SEED);

/** a transport that keeps every byte, so the test decodes exactly what a client would receive */
function recordingTransport() {
	const snaps = new Map();
	const worlds = new Map();
	const fxs = new Map();
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
		worlds,
		fxs,
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

/** the server host of mpHost.ts minus Roblox: the same simulation, replicator and clock discipline */
function newServer(options = {}) {
	const sim = new ServerSimulation({ world });
	const transport = recordingTransport();
	const replicator = new Replicator(sim, transport, { tick0Time: 0, mapHash: mapHashOf(world) });
	if (options.replicate !== false) sim.onTick = tick => replicator.afterTick(tick);
	const lives = [];
	sim.onDeath = sp => lives.push(sp.slot);
	return { sim, replicator, transport, lives, now: 0 };
}

let userIdSeed = 1000;

function enter(server, x, y, name = `tester${userIdSeed}`) {
	const slot = server.sim.freeSlot();
	if (slot === undefined) throw new Error("no free slot");
	const save = defaultSave();
	const sp = PL.createServerPlayer(
		{ slot, userId: userIdSeed++, name },
		save,
		x,
		y,
		server.sim.tick,
		server.sim.simHz,
	);
	server.sim.add(sp);
	server.replicator.welcome(sp);
	return { sp, save, history: [], seq: 1 + slot * 1000 };
}

/** one Input packet, built exactly like the client's (newest command first + the 2 previous ones, §2.2) */
function packetOf(cmds, viewTick = 0, viewFrac = 0) {
	const payload = P.encodeInput({ viewTick, viewFrac, cmds: cmds.slice() });
	if (payload === undefined) throw new Error("encodeInput refused a packet the test built");
	return payload;
}

/** quantised command for a direction in radians (what the client predicts with, §2.2) */
function commandAt(seq, angle, aim = angle) {
	return P.makeCommand(seq, Math.cos(angle), Math.sin(angle), aim, 0, 0);
}

/** sends one command through the real C→S path (token bucket → decodeInput → queue) */
function send(server, client, cmd) {
	client.history.unshift(cmd);
	while (client.history.length > CFG.INPUT_REDUNDANCY) client.history.pop();
	return PL.ingestInput(client.sp, packetOf(client.history), server.now);
}

function tick(server) {
	server.sim.step();
	server.now += TICK_DT;
}

/** the client's prediction of the same commands: one `stepPlayer` per command, same dt, same world */
function predict(x, y, save, cmds) {
	const p = createPlayer(save, x, y);
	for (const cmd of cmds) stepPlayer(world, p, save, cmd, TICK_DT);
	return p;
}

// ---------------------------------------------------------------- spawn points (§7.1, MP-04)

section("spawn (§7.1, MP-04)");

const spawnA = PL.findSpawnPoint(world, {});
check(
	PL.spawnPointOk(world, spawnA.x, spawnA.y, [], PL.SPAWN_MIN_ZOMBIE),
	`lone spawn is outside every building and on free ground (${spawnA.x.toFixed(0)}, ${spawnA.y.toFixed(0)})`,
);

const spawnB = PL.findSpawnPoint(world, { allies: [{ x: spawnA.x, y: spawnA.y }] });
const allyDist = Math.hypot(spawnB.x - spawnA.x, spawnB.y - spawnA.y);
check(
	allyDist >= PL.SPAWN_ALLY_MIN - 1 && allyDist <= PL.SPAWN_ALLY_MAX + 1,
	`ally spawn lands in the 150–400 u ring (${allyDist.toFixed(0)} u)`,
);

// MP-04: a zombie within 900 u of the whole ring pushes the spawn away from it (or relaxes it, §7.1)
const crowded = PL.findSpawnPoint(world, {
	allies: [{ x: spawnA.x, y: spawnA.y }],
	zombies: [{ x: spawnA.x, y: spawnA.y }],
	attempts: 40,
});
check(
	Math.hypot(crowded.x - spawnA.x, crowded.y - spawnA.y) >= PL.SPAWN_RELAXED_ZOMBIE || crowded.relaxed,
	"a zombie on top of the ally forces the spawn out of MP-04's radius (or reports `relaxed`)",
);

// ---------------------------------------------------------------- pick a direction with room to walk

/** the compass direction that travels the furthest from (x, y) in `ticks`, so the tests really move */
function bestDirection(x, y, ticks) {
	let best = { angle: 0, dist: -1 };
	for (let i = 0; i < 16; i++) {
		const angle = (i / 16) * Math.PI * 2;
		const save = defaultSave();
		const cmds = [];
		for (let t = 0; t < ticks; t++) cmds.push(commandAt(1 + t, angle));
		const p = predict(x, y, save, cmds);
		const dist = Math.hypot(p.x - x, p.y - y);
		if (dist > best.dist) best = { angle, dist };
	}
	return best;
}

const RUN_TICKS = 180;
const run = bestDirection(spawnA.x, spawnA.y, RUN_TICKS);
info(
	`open run from the spawn: ${run.dist.toFixed(1)} u in ${RUN_TICKS} ticks at ${((run.angle * 180) / Math.PI).toFixed(0)}°`,
);

// ---------------------------------------------------------------- (a) server == client prediction

section("(a) the server's position is the client's prediction, bit for bit (§2.2)");

{
	const server = newServer({ replicate: false });
	const clients = [];
	const starts = [
		{ x: spawnA.x, y: spawnA.y },
		{ x: spawnB.x, y: spawnB.y },
		{ x: spawnA.x, y: spawnA.y },
	];
	for (const s of starts) clients.push({ ...enter(server, s.x, s.y), start: s, sent: [] });

	for (let t = 0; t < RUN_TICKS; t++) {
		for (const c of clients) {
			// a stream that wobbles around the open direction, with a separate aim (the aim never moves anyone)
			const angle = run.angle + 0.6 * Math.sin((t + c.sp.slot * 7) / 23);
			const cmd = commandAt(c.seq + t, angle, angle + 1.1);
			c.sent.push(cmd);
			send(server, c, cmd);
		}
		tick(server);
	}

	let moved = 0;
	for (const c of clients) {
		const predicted = predict(c.start.x, c.start.y, c.save, c.sent);
		checkEq(c.sp.state.x, predicted.x, `slot ${c.sp.slot}: x matches the prediction exactly`);
		checkEq(c.sp.state.y, predicted.y, `slot ${c.sp.slot}: y matches the prediction exactly`);
		checkEq(c.sp.state.hp, predicted.hp, `slot ${c.sp.slot}: hp matches the prediction exactly`);
		checkEq(c.sp.state.hungry, predicted.hungry, `slot ${c.sp.slot}: hunger matches the prediction exactly`);
		checkEq(c.sp.counters.consumed, RUN_TICKS, `slot ${c.sp.slot}: consumed exactly one command per tick`);
		checkEq(c.sp.counters.filled, 0, `slot ${c.sp.slot}: no tick had to be filled`);
		moved = Math.max(moved, Math.hypot(c.sp.state.x - c.start.x, c.sp.state.y - c.start.y));
	}
	check(moved > 50, `the survivors really moved (${moved.toFixed(1)} u), so the comparison means something`);
	// the §2.2 redundancy re-sends each command twice more: those copies must be refused, never re-applied
	check(clients[0].sp.counters.late >= RUN_TICKS, "the redundant copies of every command are refused as late");
}

// ---------------------------------------------------------------- (b) twice the commands is not twice the speed

section("(b) a client sending 2× the commands does not move faster (§2.2, §9.1)");

{
	const server = newServer({ replicate: false });
	const honest = enter(server, spawnA.x, spawnA.y, "honest");
	const cheat = enter(server, spawnA.x, spawnA.y, "cheater");
	const TICKS = 240;
	for (let t = 0; t < TICKS; t++) {
		send(server, honest, commandAt(honest.seq + t, run.angle));
		// the speedhack: two brand-new commands per tick, i.e. 120 packets/s — the queue, not the bucket, stops it
		send(server, cheat, commandAt(cheat.seq + 2 * t, run.angle));
		send(server, cheat, commandAt(cheat.seq + 2 * t + 1, run.angle));
		tick(server);
	}
	const dHonest = Math.hypot(honest.sp.state.x - spawnA.x, honest.sp.state.y - spawnA.y);
	const dCheat = Math.hypot(cheat.sp.state.x - spawnA.x, cheat.sp.state.y - spawnA.y);
	info(`honest walked ${dHonest.toFixed(2)} u, the 2× client walked ${dCheat.toFixed(2)} u in ${TICKS} ticks`);
	check(dHonest > 20, "the honest client actually walked");
	checkEq(cheat.sp.state.x, honest.sp.state.x, "the 2× client ends on the very same x");
	checkEq(cheat.sp.state.y, honest.sp.state.y, "the 2× client ends on the very same y");
	checkEq(cheat.sp.counters.consumed, TICKS, "the 2× client still had exactly one command consumed per tick");
	check(
		cheat.sp.counters.inputOverflow > 0,
		`the 2× client shows up in inputOverflow (${cheat.sp.counters.inputOverflow})`,
	);
	checkEq(honest.sp.counters.inputOverflow, 0, "the honest client never overflows");
	check(cheat.sp.queue.length <= CFG.INPUT_BUFFER_MAX, `the queue never grows past ${CFG.INPUT_BUFFER_MAX}`);
	checkEq(cheat.sp.counters.rateDropped, 0, "at exactly 2× the queue alone stops it: the token bucket did not fire");

	// 4× (240 packets/s) is over the 120/s bucket: the surplus is dropped and counted (§8.2)
	const flood = enter(server, spawnA.x, spawnA.y, "flooder");
	for (let t = 0; t < 120; t++) {
		for (let k = 0; k < 4; k++) send(server, flood, commandAt(flood.seq + 4 * t + k, run.angle));
		tick(server);
	}
	check(
		flood.sp.counters.rateDropped > 0,
		`a 4× client hits the token bucket (${flood.sp.counters.rateDropped} dropped)`,
	);
	check(
		Math.hypot(flood.sp.state.x - spawnA.x, flood.sp.state.y - spawnA.y) <= dHonest + 1e-9,
		"and it is still not ahead of the honest client",
	);
}

// ---------------------------------------------------------------- (c) duplicates and out-of-order

section("(c) duplicated and out-of-order commands move the survivor once, in order (§2.2)");

{
	const server = newServer({ replicate: false });
	const c = enter(server, spawnA.x, spawnA.y);
	const base = c.seq;
	const cmds = [];
	for (let i = 0; i < 6; i++) cmds.push(commandAt(base + i, run.angle + i * 0.2));

	// arrival order: 1, 1 again (redundancy), then 3 before 2, then 4, then a stale copy of 2
	PL.ingestInput(c.sp, packetOf([cmds[0]]), server.now);
	PL.ingestInput(c.sp, packetOf([cmds[0]]), server.now);
	PL.ingestInput(c.sp, packetOf([cmds[2], cmds[1]]), server.now);
	PL.ingestInput(c.sp, packetOf([cmds[3], cmds[2], cmds[1]]), server.now);
	checkEq(c.sp.queue.length, 4, "the queue holds the four distinct commands, in order");
	checkEq(c.sp.queue[0].seq, cmds[0].seq, "the oldest command is at the head");
	checkEq(c.sp.queue[3].seq, cmds[3].seq, "the newest command is at the tail");
	check(c.sp.counters.duplicate >= 2, `the duplicates were counted (${c.sp.counters.duplicate})`);

	for (let i = 0; i < 4; i++) tick(server);
	const predicted = predict(spawnA.x, spawnA.y, c.save, cmds.slice(0, 4));
	checkEq(c.sp.state.x, predicted.x, "x equals four in-order steps, not five");
	checkEq(c.sp.state.y, predicted.y, "y equals four in-order steps, not five");
	checkEq(c.sp.counters.consumed, 4, "exactly four commands were consumed");

	// a command for a tick that was already simulated is refused, and moves nobody
	const lateBefore = c.sp.counters.late;
	const x = c.sp.state.x;
	const y = c.sp.state.y;
	PL.ingestInput(c.sp, packetOf([cmds[1]]), server.now);
	tick(server);
	check(c.sp.counters.late > lateBefore, "a command for an already simulated tick is refused as late");
	checkEq(c.sp.state.x, x, "and the survivor did not move again on x");
	checkEq(c.sp.state.y, y, "and the survivor did not move again on y");

	// §8.1: a seq outside ±64 of the last consumed one never enters the queue
	const seqBefore = c.sp.counters.seqWindow;
	PL.ingestInput(c.sp, packetOf([commandAt(c.sp.lastSeq + CFG.INPUT_SEQ_WINDOW + 5, run.angle)]), server.now);
	check(c.sp.counters.seqWindow > seqBefore, "a seq outside ±64 is refused (§8.1)");
	checkEq(c.sp.queue.length, 0, "and nothing was queued");
}

// ---------------------------------------------------------------- (d) an empty queue stops the survivor and WAITS

section("(d) with an empty queue the survivor stops and WAITS: a late command is simulated, not discarded (§2.2)");

/*
 * This case used to assert the opposite: "the filled slots advanced lastSeq" and "the real command for a filled
 * tick is discarded". That was the F1 rule, and tools/test-input-buffer.mjs measured what it costs: a client that
 * hitches once locks into it (each fill spends the real command's number, the real command is refused, the queue
 * cannot refill), 30 filled ticks a second of the body stopping in everyone else's world. The rule is now that a
 * filled tick WAITS: it stands the survivor still, spends no seq and acknowledges nothing, so the delayed command
 * is still welcome when it lands. What must still hold, and is checked here: the silence stops the survivor, one
 * command per tick, the ack only names what was simulated, and a lag switch banks at most INPUT_BUFFER_MAX ticks.
 */
{
	const server = newServer({ replicate: false });
	// the same walk twice: once on time, once with the packets delayed by a silence in the middle of it
	const punctual = enter(server, spawnA.x, spawnA.y, "punctual");
	const delayed = enter(server, spawnA.x, spawnA.y, "delayed");
	const WALK = 60;
	const AFTER = 30;
	const TOTAL = WALK + AFTER;
	// shorter than RESYNC_IDLE_TICKS, so no safety net is involved: this is the plain rule
	const SILENCE = PL.RESYNC_IDLE_TICKS - 5;
	const angleAt = t => run.angle + 0.3 * Math.sin(t / 9);
	const cmdP = [];
	const cmdD = [];
	for (let t = 0; t < TOTAL; t++) {
		cmdP.push(commandAt(punctual.seq + t, angleAt(t)));
		cmdD.push(commandAt(delayed.seq + t, angleAt(t)));
	}

	for (let t = 0; t < WALK; t++) {
		send(server, punctual, cmdP[t]);
		send(server, delayed, cmdD[t]);
		tick(server);
	}
	const movedBefore = Math.hypot(delayed.sp.state.x - spawnA.x, delayed.sp.state.y - spawnA.y);
	check(movedBefore > 10, `the survivor was walking before the packets stopped (${movedBefore.toFixed(1)} u)`);
	const x = delayed.sp.state.x;
	const y = delayed.sp.state.y;
	const filledBefore = delayed.sp.counters.filled;
	const lastSeq = delayed.sp.lastSeq;
	const ackSeq = delayed.sp.ackSeq;

	// the delayed client's packets stop arriving; the punctual one keeps walking
	for (let t = WALK; t < WALK + SILENCE; t++) {
		send(server, punctual, cmdP[t]);
		tick(server);
	}
	checkEq(delayed.sp.state.x, x, "x did not move during the silence");
	checkEq(delayed.sp.state.y, y, "y did not move during the silence");
	checkEq(delayed.sp.counters.filled - filledBefore, SILENCE, `every silent tick was filled (${SILENCE})`);
	checkEq(delayed.sp.lastSeq, lastSeq, "a filled tick spends no sequence number: lastSeq did not move");
	checkEq(delayed.sp.ackSeq, ackSeq, "and it acknowledges nothing: no command was simulated");

	// the command that was due during the silence finally lands: it is NOT late, it is queued (§2.2)
	const lateBefore = delayed.sp.counters.late;
	send(server, delayed, cmdD[WALK]);
	checkEq(delayed.sp.queue.length, 1, "the delayed command enters the queue");
	checkEq(delayed.sp.queue[0].seq, cmdD[WALK].seq, "and it is the one that was due, not a newer one");
	// its packet also carries the two commands before it (the redundancy): those ran already, so THEY are late
	checkEq(delayed.sp.counters.late - lateBefore, 2, "only the redundant copies of simulated commands are late");
	send(server, punctual, cmdP[WALK + SILENCE]);
	tick(server);
	checkEq(delayed.sp.ackSeq, cmdD[WALK].seq, "the next tick simulates it, and the snapshot acknowledges it");
	check(Math.hypot(delayed.sp.state.x - x, delayed.sp.state.y - y) > 0, "the survivor walks again at once");

	// the rest of the delayed stream arrives one per tick, SILENCE ticks behind the punctual one
	for (let t = WALK + SILENCE + 1; t < TOTAL + SILENCE; t++) {
		if (t < TOTAL) send(server, punctual, cmdP[t]);
		send(server, delayed, cmdD[t - SILENCE]);
		tick(server);
	}
	checkEq(delayed.sp.counters.consumed, TOTAL, `every command the delayed client sent was simulated (${TOTAL})`);
	checkEq(punctual.sp.counters.consumed, TOTAL, "and so was every command of the punctual one");
	checkEq(delayed.sp.counters.filled, SILENCE, "the delayed survivor stood still for the silence and no longer");
	// waiting cost the silence, not the commands: the late walker ends bit for bit where the punctual one does,
	// and where the client's own prediction put both -- so the owner is never corrected for a delay
	const predicted = predict(spawnA.x, spawnA.y, delayed.save, cmdD);
	checkEq(
		delayed.sp.state.x,
		punctual.sp.state.x,
		"the delayed survivor ends exactly where the punctual one does (x)",
	);
	checkEq(
		delayed.sp.state.y,
		punctual.sp.state.y,
		"the delayed survivor ends exactly where the punctual one does (y)",
	);
	checkEq(delayed.sp.state.x, predicted.x, "which is the client's own prediction of those commands (x)");
	checkEq(delayed.sp.state.y, predicted.y, "which is the client's own prediction of those commands (y)");
	checkEq(
		delayed.sp.ackSeq,
		cmdD[TOTAL - 1].seq,
		"and the last ack names the last command, the one really simulated",
	);
}

// a lag switch: hold every packet, keep making commands, release them all at once
{
	const server = newServer({ replicate: false });
	const c = enter(server, spawnA.x, spawnA.y, "lagger");
	const WALK = 30;
	// well past the queue's depth, well inside the ±64 window: the switch every guide describes
	const LAG = 20;
	for (let t = 0; t < WALK; t++) {
		send(server, c, commandAt(c.seq + t, run.angle));
		tick(server);
	}
	const x = c.sp.state.x;
	const y = c.sp.state.y;
	const held = [];
	const lagged = [];
	for (let t = WALK; t < WALK + LAG; t++) {
		const cmd = commandAt(c.seq + t, run.angle);
		lagged.push(cmd);
		c.history.unshift(cmd);
		while (c.history.length > CFG.INPUT_REDUNDANCY) c.history.pop();
		held.push(packetOf(c.history));
		tick(server);
	}
	checkEq(c.sp.state.x, x, "while the switch is on the survivor stands still (x)");
	checkEq(c.sp.state.y, y, "while the switch is on the survivor stands still (y)");
	const overflowBefore = c.sp.counters.inputOverflow;
	const consumedBefore = c.sp.counters.consumed;
	for (const payload of held) PL.ingestInput(c.sp, payload, server.now);
	check(c.sp.queue.length <= CFG.INPUT_BUFFER_MAX, `the burst never grows the queue past ${CFG.INPUT_BUFFER_MAX}`);
	checkEq(
		c.sp.counters.inputOverflow - overflowBefore,
		LAG - CFG.INPUT_BUFFER_MAX,
		"everything older than the newest INPUT_BUFFER_MAX commands overflowed",
	);
	for (let t = 0; t < CFG.INPUT_BUFFER_MAX + 3; t++) tick(server);
	checkEq(c.sp.counters.consumed - consumedBefore, CFG.INPUT_BUFFER_MAX, "one command per tick, and only those");
	// the whole switch bought exactly INPUT_BUFFER_MAX steps of the LAG it was held for
	const banked = predict(x, y, c.save, lagged.slice(LAG - CFG.INPUT_BUFFER_MAX));
	checkEq(
		c.sp.state.x,
		banked.x,
		`a ${LAG}-tick lag switch banks exactly ${CFG.INPUT_BUFFER_MAX} ticks of movement (x)`,
	);
	checkEq(
		c.sp.state.y,
		banked.y,
		`a ${LAG}-tick lag switch banks exactly ${CFG.INPUT_BUFFER_MAX} ticks of movement (y)`,
	);
}

// a stalled client (alt-tab, a long hitch) keeps its own numbering: the server waited, so it simply carries on
{
	const server = newServer({ replicate: false });
	const c = enter(server, spawnA.x, spawnA.y);
	const STALL = 90;
	for (let t = 0; t < 30; t++) {
		send(server, c, commandAt(c.seq + t, run.angle));
		tick(server);
	}
	// the client freezes: it stops sampling (so its seq stops) while the server fills every tick
	const clientSeq = c.sp.lastSeq;
	for (let t = 0; t < STALL; t++) tick(server);
	check(c.sp.idleFills >= STALL, `the server filled the whole stall (${c.sp.idleFills} ticks)`);
	checkEq(c.sp.lastSeq, clientSeq, "without moving its sequence: it waited for this client");

	const x = c.sp.state.x;
	const y = c.sp.state.y;
	const consumed = c.sp.counters.consumed;
	for (let t = 0; t < 10; t++) {
		send(server, c, commandAt(clientSeq + 1 + t, run.angle));
		tick(server);
	}
	checkEq(c.sp.counters.resync, 0, "the client's own numbering is accepted as it is: nothing to re-anchor");
	check(Math.hypot(c.sp.state.x - x, c.sp.state.y - y) > 0, "and the survivor walks again at once");
	checkEq(c.sp.counters.consumed - consumed, 10, "still exactly one command per tick");
}

// numbering that JUMPED past the window (commands.ts skips a backlog longer than INPUT_SEQ_WINDOW) or RESTARTED
// (netReset) is the safety net's job: re-anchored once the queue has been idle, never frozen out for good
{
	const server = newServer({ replicate: false });
	const c = enter(server, spawnA.x, spawnA.y);
	for (let t = 0; t < 100; t++) {
		send(server, c, commandAt(c.seq + t, run.angle));
		tick(server);
	}
	const STALL = CFG.INPUT_SEQ_WINDOW + 30;
	const clientSeq = c.sp.lastSeq;
	for (let t = 0; t < STALL; t++) tick(server);
	// the stall was longer than the window, and the client skipped its backlog to stay on the clock
	const x = c.sp.state.x;
	const y = c.sp.state.y;
	const consumed = c.sp.counters.consumed;
	c.history.length = 0;
	for (let t = 0; t < 10; t++) {
		send(server, c, commandAt(clientSeq + STALL + 1 + t, run.angle));
		tick(server);
	}
	checkEq(c.sp.counters.resync, 1, "a numbering past the window is re-anchored exactly once");
	check(Math.hypot(c.sp.state.x - x, c.sp.state.y - y) > 0, "and the survivor is not frozen out of its own session");
	checkEq(c.sp.counters.consumed - consumed, 10, "still exactly one command per tick");

	// a new run (netReset): the numbering restarts far behind the server's
	for (let t = 0; t < PL.RESYNC_IDLE_TICKS; t++) tick(server);
	c.history.length = 0;
	const restartAt = c.sp.counters.consumed;
	for (let t = 0; t < 10; t++) {
		send(server, c, commandAt(1 + t, run.angle));
		tick(server);
	}
	checkEq(c.sp.counters.resync, 2, "a restarted numbering is re-anchored too");
	checkEq(c.sp.counters.consumed - restartAt, 10, "and consumed one command per tick from its first");
}

// after an outage, the first packet carries copies of commands already simulated: they must NOT re-anchor
{
	const server = newServer({ replicate: false });
	const c = enter(server, spawnA.x, spawnA.y);
	const cmds = [];
	for (let t = 0; t < 40; t++) cmds.push(commandAt(c.seq + t, run.angle + 0.2 * Math.sin(t / 5)));
	for (let t = 0; t < 30; t++) {
		send(server, c, cmds[t]);
		tick(server);
	}
	// the link goes quiet for longer than RESYNC_IDLE_TICKS, then the next packet lands: [30, 29, 28]
	for (let t = 0; t < PL.RESYNC_IDLE_TICKS + 5; t++) tick(server);
	const ackBefore = c.sp.ackSeq;
	const x = c.sp.state.x;
	const y = c.sp.state.y;
	const lateBefore = c.sp.counters.late;
	send(server, c, cmds[30]);
	checkEq(c.sp.counters.resync, 0, "copies of simulated commands never re-anchor the window");
	checkEq(c.sp.counters.late - lateBefore, 2, "they are refused as late, as redundant copies are");
	checkEq(c.sp.queue.length, 1, "and only the new command is queued");
	tick(server);
	checkEq(seqDiff(c.sp.ackSeq, ackBefore), 1, "the ack moves forward by one, never backwards");
	const oneStep = predict(x, y, c.save, [cmds[30]]);
	checkEq(c.sp.state.x, oneStep.x, "nothing was simulated twice: exactly one step (x)");
	checkEq(c.sp.state.y, oneStep.y, "nothing was simulated twice: exactly one step (y)");
}

// ---------------------------------------------------------------- (e) snapshots decode back (§4.2, §4.3)

section("(e) the snapshots decode back with the right positions, ackSeq and rings (§4.2, §4.3, §4.4)");

{
	const server = newServer();
	const a = enter(server, spawnA.x, spawnA.y, "Alpha");
	const b = enter(server, spawnB.x, spawnB.y, "Bravo");
	// a third survivor parked far outside the mid ring (1500 u) + the hysteresis band (1650 u)
	const far = enter(server, spawnA.x, spawnA.y, "Foxtrot");
	far.sp.state.x = Math.min(world.width - 60, spawnA.x + CFG.INTEREST_EXIT + 400);
	far.sp.state.y = spawnA.y;

	// the reliable welcome batch goes out on the first flush (§4.5)
	tick(server);
	const welcome = (server.transport.worlds.get(a.sp.slot) ?? []).map(p => P.decodeWorld(p));
	check(
		welcome.every(w => w !== undefined),
		"every World packet of the welcome batch decodes",
	);
	const events = welcome.flatMap(w => w.events);
	const init = events.find(e => e.t === P.WorldEv.InitBegin);
	check(init !== undefined, "the newcomer gets InitBegin (§4.5)");
	if (init !== undefined) {
		checkEq(init.mapHash, mapHashOf(world), "InitBegin carries the map hash the client will compare");
		checkEq(init.simHz, CFG.SIM_HZ, "InitBegin carries SIM_HZ");
	}
	const joined = events.filter(e => e.t === P.WorldEv.PlayerJoined);
	checkEq(joined.length, 3, "the roster names every survivor, the newcomer included (§4.4)");
	check(
		joined.some(e => e.slot === a.sp.slot && e.name === "Alpha"),
		"and each entry carries slot and display name",
	);

	// the replicator builds a snapshot at the END of a tick whose number divides SNAP_NEAR_EVERY_TICKS, so the
	// run stops on such a tick: the last snapshot then describes exactly the state the assertions compare with.
	// Both allies walk the SAME way for a third of the open run, which bounds their separation at
	// SPAWN_ALLY_MAX + run.dist / 3 < INTEREST_NEAR whatever the seed and whatever a wall does to one of them.
	const RUN = Math.floor(RUN_TICKS / 3);
	for (let t = 0; t < RUN || server.sim.tick % CFG.SNAP_NEAR_EVERY_TICKS !== 0; t++) {
		send(server, a, commandAt(a.seq + t, run.angle));
		send(server, b, commandAt(b.seq + t, run.angle));
		tick(server);
	}

	const parts = server.transport.snaps.get(a.sp.slot) ?? [];
	check(parts.length > 0, `slot ${a.sp.slot} received ${parts.length} Snap parts`);
	checkEq(
		parts.length,
		Math.floor(server.sim.tick / CFG.SNAP_NEAR_EVERY_TICKS),
		`snapshots went out every ${CFG.SNAP_NEAR_EVERY_TICKS} ticks (${CFG.SNAP_NEAR_HZ} Hz)`,
	);
	const decoded = parts.map(p => P.decodeSnapshotPart(p));
	check(
		decoded.every(d => d !== undefined),
		"every Snap part decodes",
	);
	const last = decoded[decoded.length - 1];
	checkEq(last.part, 0, "F1 never needs more than one part");
	checkEq(last.parts, 1, "and says so in the header");
	check(last.self !== undefined, "part 0 carries the self block (§4.2)");
	checkEq(last.self.x, Math.fround(a.sp.state.x), "self.x is the authoritative x (f32, exact for reconciliation)");
	checkEq(last.self.y, Math.fround(a.sp.state.y), "self.y is the authoritative y");
	checkEq(last.self.ackSeq, a.sp.ackSeq, "self.ackSeq is the last command the server consumed (lastSeq)");
	checkEq(last.self.bufDepth, a.sp.queue.length, "self.bufDepth reports the queue depth for the ±2% dilation");
	checkEq(last.tick, server.sim.tick, "the snapshot carries the tick it was built on");

	const bBlock = last.players.find(p => p.slot === b.sp.slot);
	check(bBlock !== undefined, "the ally inside the near ring is in the snapshot");
	if (bBlock !== undefined) {
		checkEq(bBlock.x, wirePosition(b.sp.state.x), "the ally's x round-trips through the 0.5 u quantisation");
		checkEq(bBlock.y, wirePosition(b.sp.state.y), "the ally's y round-trips through the 0.5 u quantisation");
		checkNear(bBlock.x, b.sp.state.x, 0.25, "and stays within half a quantisation step of the truth");
	}
	check(
		decoded.every(d => d.players.every(p => p.slot !== far.sp.slot)),
		`the survivor beyond ${CFG.INTEREST_EXIT} u is never sent (§4.3 interest)`,
	);

	const dist = Math.hypot(b.sp.state.x - a.sp.state.x, b.sp.state.y - a.sp.state.y);
	check(
		dist <= CFG.INTEREST_NEAR,
		`the two allies stayed inside the near ring (${dist.toFixed(0)} of ${CFG.INTEREST_NEAR} u)`,
	);

	// leaving is reliable and global (§4.4)
	const before = server.transport.broadcasts.length;
	const snapsBefore = (server.transport.snaps.get(a.sp.slot) ?? []).length;
	server.sim.remove(b.sp.slot);
	server.replicator.left(b.sp.slot);
	// one tick flushes the reliable batch; the next snapshot is up to SNAP_NEAR_EVERY_TICKS ticks away
	do {
		tick(server);
	} while ((server.transport.snaps.get(a.sp.slot) ?? []).length === snapsBefore);
	const leftEvents = server.transport.broadcasts
		.slice(before)
		.map(p => P.decodeWorld(p))
		.flatMap(w => (w === undefined ? [] : w.events))
		.filter(e => e.t === P.WorldEv.PlayerLeft);
	checkEq(leftEvents.length, 1, "PlayerLeft is broadcast once, reliably");
	checkEq(leftEvents[0].slot, b.sp.slot, "and names the slot that left");

	const aParts = server.transport.snaps.get(a.sp.slot) ?? [];
	const afterLeave = P.decodeSnapshotPart(aParts[aParts.length - 1]);
	check(
		afterLeave.players.every(p => p.slot !== b.sp.slot),
		"and the slot stops appearing in the snapshots",
	);
	checkEq(server.replicator.stats.droppedEntities, 0, "no entity was dropped for lack of room");
	checkEq(server.replicator.stats.droppedEvents, 0, "no World event was dropped");
}

// the three rings, measured on survivors that do not move (§4.3: near 20 Hz, mid 10 Hz, out nothing)
{
	const server = newServer();
	const viewer = enter(server, spawnA.x, spawnA.y, "Viewer");
	const rings = [
		{ name: "near", offset: CFG.INTEREST_NEAR - 100 },
		{ name: "mid", offset: (CFG.INTEREST_NEAR + CFG.INTEREST_MID) / 2 },
		{ name: "out", offset: CFG.INTEREST_EXIT + 100 },
	].map(r => {
		const c = enter(server, spawnA.x, spawnA.y, r.name);
		c.sp.state.x = spawnA.x + r.offset;
		c.sp.state.y = spawnA.y;
		return { ...r, slot: c.sp.slot };
	});

	const SNAPS = 20;
	for (let t = 0; t < SNAPS * CFG.SNAP_NEAR_EVERY_TICKS; t++) tick(server);
	const seen = new Map(rings.map(r => [r.slot, 0]));
	const decoded = (server.transport.snaps.get(viewer.sp.slot) ?? []).map(p => P.decodeSnapshotPart(p));
	for (const snap of decoded) {
		for (const p of snap.players) seen.set(p.slot, (seen.get(p.slot) ?? 0) + 1);
	}
	checkEq(decoded.length, SNAPS, `${SNAPS} snapshots at ${CFG.SNAP_NEAR_HZ} Hz`);
	checkEq(seen.get(rings[0].slot), SNAPS, `the near ring (≤ ${CFG.INTEREST_NEAR} u) is in every snapshot`);
	checkEq(
		seen.get(rings[1].slot),
		SNAPS / 2,
		`the mid ring (≤ ${CFG.INTEREST_MID} u) rotates into half of them (${CFG.SNAP_MID_HZ} Hz per entity)`,
	);
	checkEq(seen.get(rings[2].slot), 0, `beyond ${CFG.INTEREST_EXIT} u nothing is sent (MP-07)`);
}

// ---------------------------------------------------------------- (f) hostile payloads never throw (§8.1, §8.3)

section("(f) a malicious payload is refused, never thrown, never moved (§8.1, §8.3)");

{
	const server = newServer({ replicate: false });
	const c = enter(server, spawnA.x, spawnA.y);
	// walk one command so the survivor has a position that must NOT change below
	send(server, c, commandAt(c.seq, run.angle));
	tick(server);
	const x = c.sp.state.x;
	const y = c.sp.state.y;

	const hostile = [
		undefined,
		"a string",
		1234,
		true,
		{ seq: 1, moveAng: 0, moveMag: 255 },
		[1, 2, 3],
		// a position, which is exactly what the protocol refuses to have (MP-00)
		{ x: 99999, y: 99999 },
		buffer.create(0),
		buffer.create(1),
		buffer.create(CFG.INPUT_HEADER_BYTES), // header only: zero commands
		buffer.create(CFG.INPUT_HEADER_BYTES + CFG.CMD_BYTES - 1), // truncated command
		buffer.create(CFG.INPUT_MAX_BYTES + 1), // one byte over the §8.1 ceiling
		buffer.create(CFG.UNRELIABLE_PAYLOAD_LIMIT),
	];
	// plus a packet whose header lies about how many commands follow
	const lying = buffer.create(CFG.INPUT_HEADER_BYTES + CFG.CMD_BYTES);
	buffer.writeu8(lying, 0, 3);
	hostile.push(lying);
	// and 300 random blobs
	const noise = mulberry32(0x9e3779b9);
	for (let i = 0; i < 300; i++) {
		const len = Math.floor(noise() * 40);
		const b = buffer.create(len);
		for (let k = 0; k < len; k++) buffer.writeu8(b, k, Math.floor(noise() * 256));
		hostile.push(b);
	}

	const malformedBefore = c.sp.counters.malformed;
	let threw = 0;
	let accepted = 0;
	for (const payload of hostile) {
		try {
			// a fresh bucket each time: this measures the decoder, not the rate limit
			c.sp.tokens = CFG.INPUT_BURST;
			if (PL.ingestInput(c.sp, payload, server.now) === PL.InputVerdict.Ok) accepted++;
		} catch (err) {
			threw++;
			if (threw === 1) fail(`a hostile payload threw: ${err}`);
		}
	}
	checkEq(threw, 0, `no hostile payload threw (${hostile.length} tried)`);
	check(
		c.sp.counters.malformed - malformedBefore >= hostile.length - accepted,
		`every refused payload was counted as malformed (+${c.sp.counters.malformed - malformedBefore})`,
	);
	info(`${accepted} of the ${hostile.length} blobs happened to be valid commands (random bytes sometimes are)`);
	for (let t = 0; t < 10; t++) tick(server);
	checkEq(c.sp.state.x, x, "the survivor's x is untouched by the hostile traffic");
	checkEq(c.sp.state.y, y, "the survivor's y is untouched by the hostile traffic");

	// the flood thresholds of §8.2 are what mpHost kicks on
	const fresh = enter(server, spawnA.x, spawnA.y);
	checkEq(PL.floodReason(fresh.sp), undefined, "a quiet player is never a flood");
	for (let i = 0; i < CFG.FLOOD_MESSAGES + 1; i++) PL.noteMessage(fresh.sp, server.now);
	check(
		PL.floodReason(fresh.sp) !== undefined,
		`> ${CFG.FLOOD_MESSAGES} messages in ${CFG.FLOOD_MESSAGES_WINDOW_S}s is a kick (§8.2)`,
	);
}

// ---------------------------------------------------------------- (g) cost per tick (§3.2, §12.2)

section("(g) cost of a full tick with 6 players (§3.2 budget: avg ≤ 3 ms, p95 ≤ 6 ms)");

{
	const server = newServer();
	const clients = [];
	for (let i = 0; i < CFG.MAX_PLAYERS; i++) {
		const spot = i === 0 ? spawnA : PL.findSpawnPoint(world, { allies: [{ x: spawnA.x, y: spawnA.y }] });
		clients.push(enter(server, spot.x, spot.y, `bot${i}`));
	}
	checkEq(server.sim.count(), CFG.MAX_PLAYERS, `${CFG.MAX_PLAYERS} survivors in the world`);
	checkEq(server.sim.freeSlot(), undefined, "and the server reports itself full");

	const samples = new Float64Array(BENCH_TICKS);
	for (let t = 0; t < BENCH_TICKS; t++) {
		for (const c of clients) send(server, c, commandAt(c.seq + t, run.angle + c.sp.slot));
		const t0 = process.hrtime.bigint();
		server.sim.step(); // step + onTick → the replicator (snapshots at 20 Hz, World batch per tick)
		samples[t] = Number(process.hrtime.bigint() - t0) / 1e6;
		server.now += TICK_DT;
	}
	const sorted = Float64Array.from(samples).sort();
	let total = 0;
	for (const v of samples) total += v;
	const avg = total / BENCH_TICKS;
	const p95 = sorted[Math.floor(BENCH_TICKS * 0.95)];
	const p99 = sorted[Math.floor(BENCH_TICKS * 0.99)];
	const seconds = BENCH_TICKS * TICK_DT;
	const perClient = server.replicator.takeBytes(clients[0].sp.slot) / seconds;
	info(
		`${BENCH_TICKS} ticks (${seconds.toFixed(1)} s of game) with ${CFG.MAX_PLAYERS} players, Node ${process.version}`,
	);
	info(`tick cost: avg ${avg.toFixed(4)} ms · p95 ${p95.toFixed(4)} ms · p99 ${p99.toFixed(4)} ms`);
	info(
		`downstream: ${(perClient / 1024).toFixed(2)} KB/s per client with the ambient horde ` +
			`(${server.sim.horde?.count() ?? 0} zombies); the worst case is measured in tools/test-replication.mjs`,
	);
	info(
		`upstream: ${((CFG.INPUT_MAX_BYTES + 20) * CFG.INPUT_HZ) / 1024} KB/s per client at ${CFG.INPUT_HZ} packets/s (§11.3 F1: ≤ 3 KB/s)`,
	);
	info("Luau on a Roblox server is slower than Node: these numbers are a regression guard, not the §3.2 verdict");
	// A guard against an accidental O(n²) or a per-tick allocation storm, not a Luau budget. The numbers are
	// the §3.2 ones because from MP_PHASE 2 this tick is the WHOLE world (clock, population, flow field,
	// horde, combat) and not only the six survivors it was when the thresholds were first written.
	check(avg < CFG.TICK_BUDGET_AVG_MS, `the average tick stays inside the §3.2 budget (${avg.toFixed(4)} ms)`);
	check(p95 < CFG.TICK_BUDGET_P95_MS, `p95 stays inside the §3.2 budget (${p95.toFixed(4)} ms)`);
	checkEq(server.sim.stats.droppedTicks, 0, "no tick was dropped");
	for (const c of clients) {
		if (c.sp.counters.inputOverflow > 0) fail(`slot ${c.sp.slot} overflowed while sending exactly 1 command/tick`);
	}
	ok("no honest client overflowed over the whole run");
}

// ---------------------------------------------------------------- catch-up discipline (§3.1)

section("catch-up: at most 2 ticks per heartbeat, the surplus is dropped (§3.1)");

{
	const server = newServer({ replicate: false });
	enter(server, spawnA.x, spawnA.y);
	checkEq(server.sim.advance(TICK_DT), 1, "a normal heartbeat runs one tick");
	checkEq(server.sim.advance(TICK_DT * 2.5), CFG.MAX_CATCHUP_TICKS, "a late heartbeat catches up at most 2 ticks");
	const dropped = server.sim.stats.droppedTicks;
	server.sim.advance(1); // a whole second of hitch
	check(
		server.sim.stats.droppedTicks > dropped,
		`the surplus time is dropped and counted (${server.sim.stats.droppedTicks})`,
	);
	checkEq(server.sim.advance(0), 0, "a zero delta runs nothing");
	checkEq(server.sim.advance(Number.NaN), 0, "a NaN delta runs nothing");
	checkEq(server.sim.advance(-1), 0, "a negative delta runs nothing");
}

// ---------------------------------------------------------------- verdict

console.log("");
if (failures > 0) {
	console.log(`${failures} failure(s)`);
	process.exit(1);
}
console.log("all server simulation tests passed");
