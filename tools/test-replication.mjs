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
 *   a2. CROSSING 800 U (the review of dee095a, S3). Hunters closing in change ring on every screen; the server
 *      judges a shot at each where the client drew it all through the second the client takes to ease its extra
 *      delay, and a body hovering on the border does not flip its ring (INTEREST_NEAR_EXIT).
 *   a3. COMING BACK (the second review of the zombie-motion branch, S3). A body not sent for longer than its ring's
 *      client timeout (the dark, a building, the snapshot cap) is a new track when it is sent again, drawn at its
 *      ring's delay at once, and judged there; a shorter gap keeps easing on both sides.
 *  a5. A STALLED SERVER (the review of the zombie-motion branch, S3 NIT 1, 2). The client retires a track by real
 *      time; the server's idea of it now does too, so a body the client dropped during a 0.9 s stall is a new track on
 *      both sides, and a body shown for one snapshot is retired within a frame of each other on both sides.
 *  a6. A PART OVER THE LIMIT (S3 NIT 4). It never goes out, what it carried counts as dropped entity by entity, and the
 *      bodies of the parts after it are still the ones taken as drawn.
 *   b. INTEREST AND THE DARK (§4.3). A zombie past the hysteresis band is not sent; at night one outside
 *      every light is not sent either, unless it is within DARK_SENSE_RANGE — which is what stops the wire
 *      being a wallhack, and is measured here rather than asserted in a comment.
 *   c. DEATH IS RELIABLE (§4.4). A killed zombie leaves through `ZombieDied` with its position, and the
 *      client's interpolation drops it when the drawing reaches the death (audit M3) instead of letting it walk on
 *      for another 300 ms -- or taking it away while it is still walking to the spot it fell on.
 *  c3. DEATH IS FINAL (audit M1). With the Snap parts late and reordered by jitter and the deaths overtaking them,
 *      no part from before a death stands the body up again on the client.
 *  c4. THE EFFECTS WAIT FOR THE DRAWING (audit M3). An ally's shots, the blood and the deaths are played when the
 *      render time reaches their tick, not the moment they land ~130-160 ms ahead of the bodies; the shooter's own
 *      shot at once. World and Fx go out on the snapshot's cadence, not every tick.
 *  l2. WHAT THE DARK HIDES STAYS HIDDEN (audit L2). A zombie's blood, the hits on it, its death and a drop that just
 *      fell reach only the viewers who could see the spot; a projectile's end only those who saw it fly.
 *   d. BANDWIDTH (§4.7, §12.2). Six survivors, night, the horde at its ceiling, everybody shooting: the
 *      per-second downstream of each client is measured and its p95 compared with the 23 kB/s budget -- and the
 *      largest Snap part and Fx packet against the unreliable ceiling, with the headroom printed (audit L1).
 *   e. XP COMES FROM THE SERVER (§3.6, §11.3 F2). The kill pays the killer and the assist, into the live
 *      save, and a client report can no longer move any of those fields.
 *   f. TICK COST (§3.2). 150 zombies and 6 survivors, measured per tick. In Node this is a comparison and a
 *      regression guard, never the verdict — Luau on a Roblox server is slower.
 *  ia. THE AWARENESS (IA-03 / IA-05, protocol decision 17). The state the server decided for each zombie (idle,
 *      suspicious, searching, chasing) reaches every screen in 2 bits of the record, and a screen only ever draws a
 *      state the server really had for that zombie within the interpolation window; the record stays 9 bytes.
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
const { defaultSave, sanitizeClientReport, copySaveInto } = require(join(SRC, "shared/game/save.ts"));
const COS = require(join(SRC, "shared/data/cosmetics.ts"));
const TIT = require(join(SRC, "shared/data/titles.ts"));
const { COSTUMES } = require(join(SRC, "shared/data/shop.ts"));
const { createPlayer } = require(join(SRC, "shared/game/player.ts"));
const { stepPlayer } = require(join(SRC, "shared/sim/playerMove.ts"));
const CFG = require(join(SRC, "shared/net/mpConfig.ts"));
const P = require(join(SRC, "shared/net/protocol.ts"));
const { seqDiff, unwrapTick } = require(join(SRC, "shared/net/codec.ts"));
const PL = require(join(SRC, "server/sim/players.ts"));
const { ServerSimulation } = require(join(SRC, "server/sim/simulation.ts"));
const { Replicator, mapHashOf, wirePosition, PROFILE_EVERY_TICKS, TALLY_EVERY_TICKS, TALLY_AFTER_JOIN_TICKS } = require(
	join(SRC, "server/net/replication.ts"),
);

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
/**
 * The client's effect timeline (client/net/fxTimeline.ts, audit M3). A tree from before it played every effect the
 * frame it landed and dropped a dead body the moment its ZombieDied did: that is what the harness does without it, so
 * the same checks run against the old code and fail there.
 */
const FXT_PATH = join(SRC, "client/net/fxTimeline.ts");
const FXT = existsSync(FXT_PATH) ? require(FXT_PATH) : undefined;
/** every effect a client received -> { tick: its batch's (full), arrived: the server tick it landed at } */
const FX_META = new WeakMap();

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
	const clients = new Map();
	/** where every zombie was at each recent tick (netId -> {x, y}), to judge a screen against its own render tick */
	const hist = new Map();
	/** (audit L1) the largest packet of each unreliable kind, and how many snapshots needed more than one part */
	const wire = { snapMax: 0, fxMax: 0, snapshots: 0, split: 0 };
	const server = { sim, transport, replicator: undefined, clients, hist, wire, now: 0 };
	// the host's os.clock: the harness's real time, which a stall (a5) moves without a tick
	server.replicator = new Replicator(sim, transport, {
		tick0Time: 0,
		mapHash: mapHashOf(world),
		now: () => server.now,
	});
	sim.onTick = tick => server.replicator.afterTick(tick);
	sim.onFx = event => server.replicator.queueFx(event);
	return server;
}

/** does the server take `slot`'s client as holding a track for `netId`? (an older src asks in ticks) */
function serverHasTrack(server, slot, netId) {
	const rings = server.replicator.hordeRings;
	return rings.hasTrack.length === 3
		? rings.hasTrack(slot, netId, server.now)
		: rings.hasTrack(slot, netId, server.sim.tick, server.sim.simHz);
}

/** the server's position of `netId` at a fractional tick, from the recent history, or undefined */
function serverAt(server, netId, tick) {
	const k = Math.floor(tick);
	const a = server.hist.get(k)?.get(netId);
	const b = server.hist.get(k + 1)?.get(netId);
	if (a === undefined || b === undefined) return a;
	const f = tick - k;
	return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
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

function addSurvivor(server, slot, x, y, save = defaultSave()) {
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
		/** extra random delay per Snap part, 0..jitter ticks: parts overtake one another (0 = in order) */
		jitter: 0,
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
		/** remote events received, and the ticks any arrived at (audit M3: on the snapshot's cadence, not every tick) */
		fxPackets: 0,
		worldPackets: 0,
		fxTicks: 0,
		worldTicks: 0,
		/** (audit M3) the effects waiting for the drawing, exactly as client/net/netClient.ts keeps them */
		fx: FXT !== undefined ? new FXT.FxTimeline() : undefined,
		/** a tree without the timeline: the effects that landed, played by the next frame (its old `fxQueue`) */
		fxQueue: [],
		/** every effect the view played: { e, tick, arrived, render (the frame's render tick), frame (server tick) } */
		played: [],
		/** ZombieDied waiting for the buffer to let the body go, and those it let go ({ ...death, render, frame }) */
		pendingDeaths: new Map(),
		released: [],
		/** ids of the ItemAdd deltas received (§4.5) */
		itemAdds: [],
		/** set to an array to keep every Fx event received, in order */
		fxLog: undefined,
		/** the reliable roster, kept exactly as client/net/netClient.ts keeps it (§4.4, MON-04) */
		roster: new Map(),
		/** PlayerProfile deltas received */
		profiles: [],
		/** Announce events received (MON-05: a title unlock is one, addressed to its owner alone) */
		announces: [],
		/** PlayerTally deltas received (MP-23), and those for a slot this client did not know yet (dropped) */
		tallies: [],
		tallyDrops: 0,
		/** (ELE-01..08) SolidAdd and PowerSet deltas received, in order */
		machines: [],
	});
	return sp;
}

/** what client/net/netClient.ts `applyWorldEvent` does with the roster events, for one client */
function applyRoster(client, e) {
	if (e.t === P.WorldEv.PlayerJoined) {
		client.roster.set(e.slot, {
			userId: e.userId,
			name: e.name,
			level: e.level,
			outfit: e.outfit,
			pet: e.pet,
			title: e.title,
		});
	} else if (e.t === P.WorldEv.PlayerProfile) {
		client.profiles.push(e);
		const entry = client.roster.get(e.slot);
		if (entry === undefined) return;
		entry.level = e.level;
		entry.outfit = e.outfit;
		entry.pet = e.pet;
		entry.title = e.title;
	} else if (e.t === P.WorldEv.PlayerTally) {
		client.tallies.push(e);
		const entry = client.roster.get(e.slot);
		if (entry === undefined) {
			client.tallyDrops += 1;
			return;
		}
		entry.lifeDay = e.lifeDay;
		entry.kills = e.kills;
	} else if (e.t === P.WorldEv.PlayerLeft) {
		client.roster.delete(e.slot);
	}
}

/**
 * one command per tick for every survivor, so the input queue never runs dry (§2.2); `shooters`: who gets `edges`
 * (everybody when undefined), and they hold `held` too
 */
function feedInput(server, edges = 0, shooters = undefined, held = 0) {
	for (const sp of server.sim.players()) {
		const shooting = shooters === undefined || shooters.includes(sp.slot);
		const seq = (sp.lastSeq ?? 0) + 1;
		const packet = {
			viewTick: Math.max(0, server.sim.tick - 6),
			viewFrac: 0,
			cmds: [
				{
					seq: seq % 65536,
					moveAng: 0,
					moveMag: 0,
					aim: 0,
					held: shooting ? held : 0,
					edges: shooting ? edges : 0,
				},
			],
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
	feedInput(server, opts.edges ?? 0, opts.shooters, opts.held ?? 0);
	const started = process.hrtime.bigint();
	server.sim.step();
	const ms = Number(process.hrtime.bigint() - started) / 1e6;
	const horde = server.sim.horde;
	if (horde !== undefined) {
		const at = new Map();
		for (const z of horde.zombies) at.set(horde.netIdOf(z), { x: z.x, y: z.y });
		server.hist.set(server.sim.tick, at);
		server.hist.delete(server.sim.tick - 180);
	}
	const t = server.transport;
	for (const [slot, list] of t.snaps) {
		const client = server.clients.get(slot);
		for (const raw of list) {
			const part = P.decodeSnapshotPart(raw);
			if (part === undefined) {
				fail(`a Snap part did not decode for slot ${slot}`);
				continue;
			}
			server.wire.snapMax = Math.max(server.wire.snapMax, buffer.len(raw));
			if (part.part === 0) {
				server.wire.snapshots += 1;
				if (part.parts > 1) server.wire.split += 1;
			}
			// an unreliable packet that is lost is simply never handed over (§4.1: the next one supersedes it)
			if (client.loss > 0 && nextRandom() < client.loss) continue;
			const late = client.jitter > 0 ? Math.floor(nextRandom() * (client.jitter + 1)) : 0;
			client.inbox.push([server.sim.tick + client.lag + late, part]);
		}
		list.length = 0;
	}
	// everything whose flight time is up is handed to the real client-side buffer, with the clock estimate
	// that client would have: the server's tick minus its own latency (§4.6 gives it the same anchor). With jitter
	// the inbox is out of order, and so is the delivery: exactly the unordered channel §1.1 describes
	for (const [, client] of server.clients) {
		const due = [];
		const kept = [];
		for (const entry of client.inbox) (entry[0] <= server.sim.tick ? due : kept).push(entry);
		client.inbox = kept;
		for (const [, part] of due) {
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
			server.wire.fxMax = Math.max(server.wire.fxMax, buffer.len(raw));
			if (client.fxPackets === 0 || client.fxAt !== server.sim.tick) client.fxTicks += 1;
			client.fxAt = server.sim.tick;
			client.fxPackets += 1;
			client.fxEvents += batch.events.length;
			// what client/net/netClient.ts `onFx` does: each effect keeps its batch's tick, unwrapped on the client's clock
			const tick = unwrapTick(batch.tick, server.sim.tick);
			for (const e of batch.events) {
				client.fxByType.set(e.t, (client.fxByType.get(e.t) ?? 0) + 1);
				if (e.t === P.FxType.Shake) client.shakeSlots.add(e.slot);
				FX_META.set(e, { tick, arrived: server.sim.tick });
				if (client.fxLog !== undefined) client.fxLog.push(e);
				if (client.fx !== undefined) client.fx.push(e, tick, server.now);
				else client.fxQueue.push(e);
			}
		}
		list.length = 0;
	}
	const reliable = [];
	for (const packet of t.broadcasts) {
		reliable.push([undefined, packet]);
		for (const [, c] of server.clients) noteWorld(server, c);
	}
	t.broadcasts.length = 0;
	for (const [slot, list] of t.worlds) {
		for (const packet of list) {
			reliable.push([slot, packet]);
			const c = server.clients.get(slot);
			if (c !== undefined) noteWorld(server, c);
		}
		list.length = 0;
	}
	for (const [slot, packet] of reliable) {
		const batch = P.decodeWorld(packet);
		if (batch === undefined) {
			fail("a World batch did not decode");
			continue;
		}
		for (const e of batch.events) {
			if (
				e.t === P.WorldEv.PlayerJoined ||
				e.t === P.WorldEv.PlayerProfile ||
				e.t === P.WorldEv.PlayerLeft ||
				e.t === P.WorldEv.PlayerTally
			) {
				if (slot === undefined) for (const [, c] of server.clients) applyRoster(c, e);
				else if (server.clients.has(slot)) applyRoster(server.clients.get(slot), e);
				continue;
			}
			if (e.t === P.WorldEv.Announce) {
				if (slot === undefined) for (const [, c] of server.clients) c.announces.push(e);
				else server.clients.get(slot)?.announces.push(e);
				continue;
			}
			if (e.t === P.WorldEv.ItemAdd) {
				if (slot === undefined) for (const [, c] of server.clients) c.itemAdds.push(e.id);
				else server.clients.get(slot)?.itemAdds.push(e.id);
				continue;
			}
			if (e.t === P.WorldEv.SolidAdd || e.t === P.WorldEv.PowerSet) {
				if (slot === undefined) for (const [, c] of server.clients) c.machines.push(e);
				else server.clients.get(slot)?.machines.push(e);
				continue;
			}
			if (e.t !== P.WorldEv.ZombieDied) continue;
			const client = server.clients.get(slot);
			if (client === undefined) continue;
			const death = { ...e, at: server.sim.tick, tick: unwrapTick(batch.tick, server.sim.tick) };
			client.deaths.push(death);
			// exactly what client/net/netClient.ts does with it: the batch's tick buries the netId against older parts
			// still in flight (audit M1), and the body leaves when the drawing reaches that tick (audit M3). A tree
			// from before M3 took it away at once
			if (client.buffer.zombieDied !== undefined) client.buffer.zombieDied(e.netId, batch.tick, server.now);
			else client.buffer.forgetZombie(e.netId, batch.tick);
			client.pendingDeaths.set(e.netId, death);
		}
	}
	return ms;
}

/** one World packet reached `client` (and, if it is the first this tick, one more tick with a World batch) */
function noteWorld(server, client) {
	if (client.worldPackets === 0 || client.worldAt !== server.sim.tick) client.worldTicks += 1;
	client.worldAt = server.sim.tick;
	client.worldPackets += 1;
}

/**
 * advances every client's interpolation the way a frame would, and returns their drawn hordes; the deaths the buffer
 * let go and the effects due are handed to the "view" exactly as client/net/netClient.ts `netUpdate` and
 * `takeNetFx` hand them (audit M3), and recorded with the frame's render tick
 */
function drawClients(server, dt = TICK_DT) {
	const out = new Map();
	for (const [slot, client] of server.clients) {
		client.buffer.advance(dt, server.sim.tick, server.now, world);
		const render = client.buffer.renderNow();
		const frame = server.sim.tick;
		if (client.buffer.takeDied !== undefined) {
			for (const netId of client.buffer.takeDied([])) {
				const d = client.pendingDeaths.get(netId);
				if (d === undefined) continue;
				client.pendingDeaths.delete(netId);
				client.released.push({ ...d, render, frame });
			}
		} else {
			for (const [, d] of client.pendingDeaths) client.released.push({ ...d, render, frame });
			client.pendingDeaths.clear();
		}
		const due = client.fx !== undefined ? client.fx.take([], render, server.now, slot) : client.fxQueue.splice(0);
		for (const e of due) {
			const meta = FX_META.get(e);
			client.played.push({ e, tick: meta.tick, arrived: meta.arrived, render, frame });
		}
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
		const r = radius * (0.35 + (0.65 * ((i * 37) % 100)) / 100);
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

section("(a) three clients see the SAME zombies (§11.3 F2: same netIds, ±4 u of the server at the tick each draws)");
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
	// and ten in the MID ring (800-1800 u, §4.3): drawn a near interval further back, and judged there (review #2)
	for (let i = 0; i < 10; i++) {
		const ang = (i / 10) * Math.PI * 2 + 0.3;
		const z = createZombie(1, cx + Math.cos(ang) * (950 + 15 * i), cy + Math.sin(ang) * (950 + 15 * i), 5, false);
		z.alpha = 1;
		server.sim.horde.zombies.push(z);
	}
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
	let worstJudged = 0;
	let across = 0;
	let acrossOver = -Infinity;
	let compared = 0;
	let expected = 0;
	// the server's own bodies by netId: where it would judge a shot at each, for each viewer (§2.3)
	const horde = server.sim.horde;
	const byNetId = new Map();
	for (const z of horde.zombies) byNetId.set(horde.netIdOf(z), z);
	/** the zombie's own speed on the server over the last 10 ticks, u/tick */
	const speedOf = netId => {
		let fastest = 0;
		for (let t = server.sim.tick - 10; t < server.sim.tick; t++) {
			const p = server.hist.get(t)?.get(netId);
			const q = server.hist.get(t + 1)?.get(netId);
			if (p !== undefined && q !== undefined) fastest = Math.max(fastest, Math.hypot(q.x - p.x, q.y - p.y));
		}
		return fastest;
	};
	const lagOf = slot => server.clients.get(slot).lag;
	for (const [netId, za] of a) {
		const zb = b.get(netId);
		const zc = c.get(netId);
		if (zb === undefined || zc === undefined) {
			missing += 1;
			continue;
		}
		/*
		 * Every screen draws the server's own path, each at the tick it is drawing. A client 100 ms further away
		 * draws that path 100 ms later (§5.1: the delay is the measured lateness plus the buffer), so two screens
		 * side by side differ by the zombie's walk in that time -- which is the truth, not an error. The version of
		 * this check that compared the three screens with each other held because the far client EXTRAPOLATED over
		 * its latency, drawing zombies where the server never had them (tools/test-zombie-motion.mjs).
		 */
		const onServer = byNetId.get(netId);
		for (const [slot, z] of [
			[0, za],
			[1, zb],
			[2, zc],
		]) {
			// a body the server already let go (a far one despawned, §4.4) is still drawn until its ring's timeout
			if (onServer === undefined) continue;
			expected += 1;
			const truth = serverAt(server, netId, z.tick);
			if (truth === undefined) continue;
			compared += 1;
			worst = Math.max(worst, Math.hypot(z.x - truth.x, z.y - truth.y));
			// review #2: where the server JUDGES a shot this viewer fires at it -- the declared view (the buffer's
			// render time) minus the ring's extra delay (server/net/replication.ts `viewLagOf`) -- is where it is drawn
			const view = server.clients.get(slot).buffer.renderNow();
			const lag = onServer !== undefined ? (server.replicator.viewLagOf?.(slot, onServer, view) ?? 0) : 0;
			const judged = serverAt(server, netId, view - lag);
			if (judged !== undefined) worstJudged = Math.max(worstJudged, Math.hypot(z.x - judged.x, z.y - judged.y));
		}
		// review #8: two screens differ by the zombie's walk over their latency difference, and by little else
		const walk = speedOf(netId);
		for (const [slot, z] of [
			[1, zb],
			[2, zc],
		]) {
			const gap = Math.hypot(za.x - z.x, za.y - z.y);
			across = Math.max(across, gap);
			acrossOver = Math.max(acrossOver, gap - (walk * Math.abs(lagOf(slot) - lagOf(0)) + 4));
		}
	}
	checkEq(missing, 0, "every netId one client draws, the other two draw too");
	check(
		expected >= 3 * (a.size() - 1) && compared === expected,
		`every body the server still has, on every screen, has its position at the tick it is drawn ` +
			`(${compared} of ${expected}; ${3 * a.size() - expected} drawn after the server let them go)`,
	);
	check(
		worst <= 4,
		`every screen draws each zombie within 4 u of the server at the tick it draws, at 0/50/100 ms and ` +
			`0/1/2 % loss (worst ${worst.toFixed(2)} u over ${compared} bodies)`,
	);
	check(
		worstJudged <= 4,
		`…and within 4 u of where the server judges a shot at it: the declared view minus its ring's extra delay ` +
			`(worst ${worstJudged.toFixed(2)} u)`,
	);
	check(
		acrossOver <= 0,
		`two screens differ by no more than the zombie's walk over their latency difference + 4 u ` +
			`(widest gap ${across.toFixed(2)} u, ${acrossOver > 0 ? "+" : ""}${acrossOver.toFixed(2)} u against that bound)`,
	);
	// the same body, the same type: a client must never be shown a different creature
	let sameType = true;
	for (const [netId, za] of a) {
		const zb = b.get(netId);
		if (zb !== undefined && zb.type !== za.type) sameType = false;
	}
	check(sameType, "and it is the same archetype on every screen");
}

// ================================================================ (a2) crossing the near ring's border

section("(a2) a zombie crossing 800 u is judged where it is drawn, all through the crossing (review of dee095a, S3)");
{
	/*
	 * A body that changes ring changes how far back its viewer draws it: the client eases its `extra` over a second
	 * from the `mid` flag it received (client/net/snapshotBuffer.ts), and the server switched it at once with the
	 * ring. For about a second after each crossing a shot was judged up to 3 ticks away from the body on screen -- the
	 * error review #2 fixed for the steady mid ring -- and every chasing zombie crosses 800 u once, inside the 800 u
	 * and 1200 u rifle ranges. Here 24 hunters close in on three survivors from 950-1150 u, and on every frame of
	 * every client each body is compared with where the server would judge a shot at it: the declared view (the
	 * buffer's render time) minus `viewLagOf` at that view. The ring switched at once is measured next to it.
	 */
	const server = newWorldServer();
	const cx = world.width / 2;
	const cy = world.height / 2;
	addSurvivor(server, 0, cx, cy);
	addSurvivor(server, 1, cx + 40, cy);
	addSurvivor(server, 2, cx - 40, cy + 30);
	const horde = server.sim.horde;
	for (let i = 0; i < 24; i++) {
		const ang = (i / 24) * Math.PI * 2 + 0.1;
		const r = 950 + 8 * i;
		const z = createZombie(1, cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, 5, false);
		z.alpha = 1;
		z.detect = true;
		horde.zombies.push(z);
	}
	const midExtra = CFG.midViewExtraTicks(CFG.SIM_HZ);
	let worstNew = 0;
	let worstOld = 0;
	let worstNewEasing = 0;
	let worstOldEasing = 0;
	let easingFrames = 0;
	let frames = 0;
	const crossed = new Set();
	/** the ring each (viewer, netId) was last SENT in, to count the crossings the clients actually saw */
	const lastMid = new Map();
	for (let i = 0; i < 60 * 8; i++) {
		tickServer(server);
		const drawn = drawClients(server);
		if (i < 60) continue;
		const byNetId = new Map();
		for (const z of horde.zombies) byNetId.set(horde.netIdOf(z), z);
		for (const [slot, bodies] of drawn) {
			const client = server.clients.get(slot);
			const view = client.buffer.renderNow();
			for (const [netId, z] of bodies) {
				const onServer = byNetId.get(netId);
				if (onServer === undefined) continue;
				const truth = serverAt(server, netId, z.tick);
				if (truth === undefined) continue;
				const key = slot * 65536 + netId;
				const track = client.buffer.zombies.get(netId);
				if (track !== undefined) {
					if (lastMid.has(key) && lastMid.get(key) !== track.mid) crossed.add(key);
					lastMid.set(key, track.mid);
				}
				// where the server judges a shot this viewer fires at it now, and where it did with the ring switched at once
				const judged = serverAt(server, netId, view - server.replicator.viewLagOf(slot, onServer, view));
				const ring = server.replicator.hordeRings.ring(slot, netId);
				const old = serverAt(server, netId, view - (ring === 1 ? midExtra : 0));
				if (judged === undefined || old === undefined) continue;
				// against the server's own body at the tick this screen drew it: the drawing's own error (a lost
				// snapshot, extrapolation) is (a)'s business, this is only the instant the shot is judged at
				frames += 1;
				const errNew = Math.hypot(truth.x - judged.x, truth.y - judged.y);
				const errOld = Math.hypot(truth.x - old.x, truth.y - old.y);
				worstNew = Math.max(worstNew, errNew);
				worstOld = Math.max(worstOld, errOld);
				const extra = view - z.tick;
				if (extra > 0.05 && extra < midExtra - 0.05) {
					easingFrames += 1;
					worstNewEasing = Math.max(worstNewEasing, errNew);
					worstOldEasing = Math.max(worstOldEasing, errOld);
				}
			}
		}
	}
	info(
		`${crossed.size()} crossings seen by the three clients, ${easingFrames} of ${frames} body-frames drawn while ` +
			`easing; judged vs drawn: worst ${worstNew.toFixed(2)} u (while easing ${worstNewEasing.toFixed(2)} u), ` +
			`with the ring switched at once ${worstOld.toFixed(2)} u (${worstOldEasing.toFixed(2)} u)`,
	);
	check(
		crossed.size() >= 24,
		`the hunters crossed the near ring's border on the clients' screens (${crossed.size()})`,
	);
	check(
		worstNew <= 1,
		`every body is judged within 1 u of the instant it is drawn at, through the crossing (worst ` +
			`${worstNew.toFixed(2)} u; ${worstOld.toFixed(2)} u with the ring switched at once)`,
	);

	// and a body hovering on the border does not flip it: the near ring is left only past INTEREST_NEAR_EXIT
	const { ActorInterest, Ring } = require(join(SRC, "server/net/interest.ts"));
	const rings = new ActorInterest();
	let flips = 0;
	let was = Ring.Out;
	for (let round = 0; round < 200; round++) {
		const d = CFG.INTEREST_NEAR + 40 * Math.cos(round / 3);
		const ring = rings.update(0, 7, d * d, round);
		if (was !== Ring.Out && ring !== was) flips += 1;
		was = ring;
	}
	checkEq(flips, 1, `a body swinging ±40 u across ${CFG.INTEREST_NEAR} u changes ring once, not every swing`);
	checkEq(rings.update(0, 7, (CFG.INTEREST_NEAR_EXIT + 1) ** 2, 201), Ring.Mid, "and past the exit band it is mid");
}

// ================================================================ (a3) a body that comes back after its track was retired

section(
	"(a3) a body hidden past its ring's timeout comes back as a NEW track, judged where it is drawn (second review, S3)",
);
{
	/*
	 * The client retires a zombie track that stops arriving -- 0.3 s near, 0.6 s mid, then a 0.15 s fade -- and a body
	 * carried again after that is a new track, drawn at its ring's extra delay from the very first frame. The server's
	 * easing is per (viewer, zombie) and lives as long as the body stays in INTEREST, and a body in interest is often
	 * not sent: at night outside every light, inside a building, past SNAP_ZOMBIE_CAP in a horde. Eased on from the old
	 * ring, a zombie lit at 1000 u that walked up in the dark and was lit again inside 800 u was judged up to 3 ticks
	 * off the body on screen for most of a second.
	 *
	 * Here one zombie, at night, three survivors watching (0/50/100 ms, 0/1/2 % loss): lit and running across their
	 * view at 200 u/s, then outside every light while it walks across 800 u, then lit again in the other ring and
	 * running again. On every frame of every client after it is lit again, the tick the body is drawn at is compared
	 * with the tick a shot at it is judged at, on the server's own path (as in a2). The third case is the other side
	 * of the line: a gap SHORTER than the ring's timeout leaves the track alive and easing on the client, and the
	 * server has to keep easing with it rather than start over.
	 */
	const SPEED = 200 / CFG.SIM_HZ;
	const LIT_TICKS = 90;
	const cases = [
		{
			label: "mid at 1000 u, 1 s in the dark, lit again near at 700 u",
			from: 1000,
			to: 700,
			dark: 60,
			retired: true,
		},
		{
			label: "near at 700 u, 1 s in the dark, lit again mid at 1000 u",
			from: 700,
			to: 1000,
			dark: 60,
			retired: true,
		},
		{
			label: "mid at 880 u, 0.4 s in the dark, lit again near at 740 u",
			from: 880,
			to: 740,
			dark: 24,
			retired: false,
		},
	];
	for (const c of cases) {
		const server = newWorldServer();
		const cx = world.width / 2;
		const cy = world.height / 2;
		addSurvivor(server, 0, cx, cy);
		addSurvivor(server, 1, cx + 40, cy);
		addSurvivor(server, 2, cx - 40, cy + 30);
		server.sim.clock.setClock(23);
		const horde = server.sim.horde;
		const z = createZombie(1, cx + c.from, cy, 5, false);
		z.alpha = 1;
		horde.zombies.push(z);
		let ang = 0;
		let r = c.from;
		let worst = 0;
		let worstFirst = 0;
		let frames = 0;
		/** the clients that had no track for it at some point in the dark: a retired track */
		const retiredBy = new Set();
		let sentAgain = -1;
		for (let i = 0; i < LIT_TICKS + c.dark + LIT_TICKS; i++) {
			const dark = i >= LIT_TICKS && i < LIT_TICKS + c.dark;
			// straight across 800 u in the dark, round the survivors at 200 u/s in the light
			if (dark) r += (c.to - c.from) / c.dark;
			else ang += SPEED / r;
			z.x = cx + Math.cos(ang) * r;
			z.y = cy + Math.sin(ang) * r;
			// outside every light (§4.3 rule 2): at most one tick of the horde's own 3/s fade, never above LIT_ALPHA_MIN
			z.alpha = dark ? 0 : 1;
			tickServer(server);
			const drawn = drawClients(server);
			const netId = horde.netIdOf(z);
			if (dark) {
				for (const [slot, client] of server.clients) if (!client.buffer.zombies.has(netId)) retiredBy.add(slot);
				continue;
			}
			if (i < LIT_TICKS) continue;
			if (sentAgain < 0) sentAgain = i;
			for (const [slot, bodies] of drawn) {
				const b = bodies.get(netId);
				if (b === undefined) continue;
				const view = server.clients.get(slot).buffer.renderNow();
				const truth = serverAt(server, netId, b.tick);
				const judged = serverAt(server, netId, view - server.replicator.viewLagOf(slot, z, view));
				if (truth === undefined || judged === undefined) continue;
				frames += 1;
				const err = Math.hypot(truth.x - judged.x, truth.y - judged.y);
				worst = Math.max(worst, err);
				// the first half second back in the light: where the old ring's easing was furthest off
				if (i - sentAgain < 30) worstFirst = Math.max(worstFirst, err);
			}
		}
		info(
			`${c.label}: ${frames} body-frames after it is lit again, judged vs drawn worst ${worst.toFixed(2)} u ` +
				`(first 0.5 s ${worstFirst.toFixed(2)} u); retired on ${retiredBy.size()} of 3 clients in the dark`,
		);
		check(
			c.retired ? retiredBy.size() === 3 : retiredBy.size() === 0,
			c.retired
				? `${c.label}: every client retired the track in the dark (${retiredBy.size()} of 3)`
				: `${c.label}: no client retired the track in the dark (${retiredBy.size()} of 3)`,
		);
		check(frames >= 3 * 60, `${c.label}: the three clients draw it again once it is lit (${frames} body-frames)`);
		check(worst <= 1, `${c.label}: judged within 1 u of the instant it is drawn at (worst ${worst.toFixed(2)} u)`);
	}
}

// ================================================================ (a4) what the server notes as sent is what went out

section("(a4) the server takes a body as drawn only if a part that went out carried it (second review, NIT 2)");
{
	/*
	 * Which bodies a viewer has a track for, and in which ring, is what `viewLagOf` judges its shots by. It was noted
	 * as the snapshot was BUILT, before the encoder, which drops whatever does not fit its four parts: a body cut there
	 * was marked sent -- with a ring -- to a client that never had a track for it. SNAP_ZOMBIE_CAP keeps the live horde
	 * well inside four parts, so it is lifted here to let the encoder do the cutting: 600 zombies within 800 u of one
	 * survivor at noon, and after a few snapshots every body the server marks sent must be one the client decoded,
	 * and the other way round.
	 */
	const cap = CFG.SNAP_ZOMBIE_CAP;
	CFG.SNAP_ZOMBIE_CAP = 1000;
	try {
		const server = newWorldServer();
		const cx = world.width / 2;
		const cy = world.height / 2;
		addSurvivor(server, 0, cx, cy);
		server.sim.clock.setClock(12);
		seedHorde(server, 600, cx, cy, 780);
		for (let i = 0; i < 12; i++) tickServer(server);
		const client = server.clients.get(0);
		const horde = server.sim.horde;
		let inInterest = 0;
		let carried = 0;
		let notedNotCarried = 0;
		let carriedNotNoted = 0;
		for (const z of horde.zombies) {
			const netId = horde.netIdOf(z);
			// slot 0's half of the (viewer, netId) table: its keys are the netIds themselves
			const pair = server.replicator.hordeRings.rings.get(netId);
			if (pair === undefined) continue;
			inInterest += 1;
			const got = client.counts.has(netId);
			if (got) carried += 1;
			if (pair.sent && !got) notedNotCarried += 1;
			if (!pair.sent && got) carriedNotNoted += 1;
		}
		info(
			`${inInterest} zombies in interest, ${carried} carried by the parts that went out, ` +
				`${server.replicator.stats.droppedEntities} cut on the way`,
		);
		check(
			carried > 0 && carried < inInterest,
			`the encoder's ${CFG.SNAP_MAX_PARTS} parts carried some of the horde and not all of it (${carried} of ${inInterest})`,
		);
		checkEq(notedNotCarried, 0, "no body the parts left out is taken as drawn by the client");
		checkEq(carriedNotNoted, 0, "and every body they carried is");
	} finally {
		CFG.SNAP_ZOMBIE_CAP = cap;
	}
}

// ================================================================ (a5) a stalled server, and a body shown once

section("(a5) a stalled server knows its client retired a body, by the client's clock: real time (S3 NIT 1, 2)");
{
	/*
	 * The client retires a zombie track 0.3/0.6 s after the last part that carried it (then a 0.15 s fade), by its REAL
	 * clock. The server counted that in ticks, and ticks are not real time on a server that stalls: past the
	 * Heartbeat's debt ceiling the surplus is dropped (§3.1). Here the server stops for 0.9 s while its client keeps
	 * drawing: the client retires the mid-ring body; the server, with no tick run, eased it on as the same track, and
	 * a shot at the body running in the near ring after the stall was judged its old ring's 3 ticks off it.
	 */
	const server = newWorldServer();
	const cx = world.width / 2;
	const cy = world.height / 2;
	addSurvivor(server, 0, cx, cy);
	const client = server.clients.get(0);
	client.lag = 0;
	client.loss = 0;
	server.sim.clock.setClock(12);
	const horde = server.sim.horde;
	const SPEED = 200 / CFG.SIM_HZ;
	let r = 1000;
	let ang = 0;
	const z = createZombie(1, cx + r, cy, 5, false);
	z.alpha = 1;
	horde.zombies.push(z);
	const place = () => {
		z.x = cx + Math.cos(ang) * r;
		z.y = cy + Math.sin(ang) * r;
		z.alpha = 1;
	};
	for (let i = 0; i < 90; i++) {
		ang += SPEED / r;
		place();
		tickServer(server);
		drawClients(server);
	}
	const netId = horde.netIdOf(z);
	const drawnBefore = client.buffer.zombies.has(netId);
	// the stall: 0.9 s of the client's frames, and not one tick on the server
	r = 700;
	for (let i = 0; i < 54; i++) {
		server.now += TICK_DT;
		drawClients(server);
	}
	check(
		drawnBefore && !client.buffer.zombies.has(netId),
		"the client drew the mid-ring body, and retired it in the stall",
	);
	check(
		!serverHasTrack(server, 0, netId),
		"the server knows: no track, by the 0.9 s that passed, not the 0 ticks that ran",
	);
	let worst = 0;
	let frames = 0;
	for (let i = 0; i < 90; i++) {
		ang += SPEED / r;
		place();
		tickServer(server);
		const b = drawClients(server).get(0).get(netId);
		if (b === undefined) continue;
		const view = client.buffer.renderNow();
		const truth = serverAt(server, netId, b.tick);
		const judged = serverAt(server, netId, view - server.replicator.viewLagOf(0, z, view));
		if (truth === undefined || judged === undefined) continue;
		frames += 1;
		worst = Math.max(worst, Math.hypot(truth.x - judged.x, truth.y - judged.y));
	}
	info(
		`after the stall, running in the near ring: ${frames} body-frames, judged vs drawn worst ${worst.toFixed(2)} u`,
	);
	check(frames >= 60, `the client draws it again after the stall (${frames} body-frames)`);
	check(worst <= 1, `a shot at it is judged within 1 u of where it is drawn (worst ${worst.toFixed(2)} u)`);
}
{
	/*
	 * S3 NIT 2: a track's fade out starts from the alpha its fade-in reached, and a body sent once never reached 1. The
	 * server took the longest fade for every track. The fade-in keeps running through the ring's timeout, though, so a
	 * near body sent once is at 0.95 when it starts to fade and the gap was 15 ms, under a frame at 60 Hz: the server's
	 * model is now the client's own (`retiredAfterS`), and this pins it. Lag 0, so the client's `lastSeen` is the
	 * server's send: a near body lit for one snapshot, then dark, and one lit for a second, leave the client and the
	 * server's idea of it within a frame of each other (the frame they land on is a question of rounding at 1/60 s).
	 */
	for (const shown of [1, CFG.SNAP_NEAR_HZ]) {
		const server = newWorldServer();
		const cx = world.width / 2;
		const cy = world.height / 2;
		addSurvivor(server, 0, cx, cy);
		const client = server.clients.get(0);
		client.lag = 0;
		client.loss = 0;
		server.sim.clock.setClock(23);
		const horde = server.sim.horde;
		const z = createZombie(1, cx + 500, cy, 5, false);
		horde.zombies.push(z);
		let netId = -1;
		let lit = 0;
		let clientGone = -1;
		let serverGone = -1;
		for (let i = 0; i < shown * CFG.SNAP_NEAR_EVERY_TICKS + 120 && (clientGone < 0 || serverGone < 0); i++) {
			z.x = cx + 500;
			z.y = cy;
			// lit until `shown` snapshots carried it, then outside every light (§4.3 rule 2) past DARK_SENSE_RANGE
			z.alpha = lit < shown ? 1 : 0;
			tickServer(server);
			drawClients(server);
			netId = horde.netIdOf(z);
			const has = client.buffer.zombies.has(netId);
			if (lit < shown) {
				lit = client.counts.get(netId) ?? 0;
				continue;
			}
			if (clientGone < 0 && !has) clientGone = i;
			if (serverGone < 0 && !serverHasTrack(server, 0, netId)) serverGone = i;
		}
		info(
			`shown in ${shown} snapshot(s): the client retired it on frame ${clientGone}, the server on ${serverGone}`,
		);
		check(
			clientGone > 0 && serverGone > 0 && Math.abs(clientGone - serverGone) <= 1,
			`shown in ${shown} snapshot(s), the track goes within a frame on both sides`,
		);
	}
}

// ================================================================ (a6) a part over the unreliable limit

section("(a6) a Snap part over the limit never goes out, and what it carried is counted, entity by entity (S3 NIT 4)");
{
	/*
	 * The encoder keeps every part under SNAP_MAX_BYTES, so the replicator's own guard never fired and no test reached
	 * it; it also counted a dropped part as ONE dropped entity. Here the encoder's output is tampered with: part 0 of
	 * every other snapshot and part 1 of the rest go over the limit. The a4 horde (600 zombies, the cap lifted) fills
	 * four parts.
	 */
	const cap = CFG.SNAP_ZOMBIE_CAP;
	const encode = P.encodeSnapshot;
	CFG.SNAP_ZOMBIE_CAP = 1000;
	let tampered = 0;
	let expected = 0;
	try {
		const server = newWorldServer();
		const cx = world.width / 2;
		const cy = world.height / 2;
		addSurvivor(server, 0, cx, cy);
		server.sim.clock.setClock(12);
		seedHorde(server, 600, cx, cy, 780);
		for (let i = 0; i < 6; i++) tickServer(server);
		const client = server.clients.get(0);
		client.counts.clear();
		server.replicator.hordeRings.clear();
		const stats = server.replicator.stats;
		const dropped0 = stats.droppedEntities;
		P.encodeSnapshot = snap => {
			const res = encode(snap);
			const k = tampered % 2 === 0 ? 0 : 1;
			if (res.parts.length > 2) {
				expected += res.dropped + res.partZombies[k];
				if (k === 0)
					expected +=
						Math.min(snap.players.length, CFG.MAX_PLAYERS) + Math.min(snap.bosses.length, CFG.MAX_BOSSES);
				res.parts[k] = buffer.create(CFG.SNAP_MAX_BYTES + 1);
				tampered += 1;
			} else {
				expected += res.dropped;
			}
			return res;
		};
		for (let i = 0; i < 12; i++) tickServer(server);
		P.encodeSnapshot = encode;
		const horde = server.sim.horde;
		let notedNotCarried = 0;
		let carriedNotNoted = 0;
		let carried = 0;
		for (const z of horde.zombies) {
			const netId = horde.netIdOf(z);
			const pair = server.replicator.hordeRings.rings.get(netId);
			const got = client.counts.has(netId);
			if (got) carried += 1;
			if (pair?.sent === true && !got) notedNotCarried += 1;
			if (pair?.sent !== true && got) carriedNotNoted += 1;
		}
		info(
			`${tampered} snapshots with a part over the limit; ${server.wire.snapMax} B the largest part the client got; ` +
				`${stats.droppedEntities - dropped0} entities counted dropped (expected ${expected})`,
		);
		check(tampered >= 3, `the guard was reached (${tampered} parts over the limit)`);
		check(server.wire.snapMax <= CFG.SNAP_MAX_BYTES, "no part over SNAP_MAX_BYTES reached the client");
		checkEq(stats.droppedParts ?? 0, tampered, "each is counted as a dropped part");
		checkEq(
			stats.droppedEntities - dropped0,
			expected,
			"and everything it carried as dropped entities, one by one",
		);
		check(carried > 0, `the parts around it still went out (${carried} bodies)`);
		checkEq(notedNotCarried, 0, "no body of a dropped part is taken as drawn");
		checkEq(carriedNotNoted, 0, "and every body of the parts after it is (the offset skips the dropped part)");
	} finally {
		P.encodeSnapshot = encode;
		CFG.SNAP_ZOMBIE_CAP = cap;
	}
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
	check(seen.has(horde.netIdOf(near)), `one in the dark but within ${CFG.DARK_SENSE_RANGE} u IS sent (you hear it)`);
}

// ================================================================ (c) a death is reliable

section(
	"(c) a killed zombie leaves through the reliable channel (§4.4), when the drawing reaches its death (audit M3)",
);
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
	const client = server.clients.get(0);
	let left;
	for (let i = 0; i < 2 * CFG.SIM_HZ && left === undefined; i++) {
		tickServer(server);
		if (!drawClients(server).get(0).has(netId)) left = { tick: server.sim.tick, render: client.buffer.renderNow() };
	}
	const died = client.deaths.filter(d => d.netId === netId);
	checkEq(died.length, 1, "exactly one ZombieDied reached the client");
	if (died.length > 0) {
		checkNear(died[0].x, victim.x, 1, "and it carries the place the body fell");
	}
	check(left !== undefined, "the body left the client's horde");
	if (left !== undefined && died.length > 0) {
		const d = died[0];
		info(
			`ZombieDied of tick ${d.tick} landed at tick ${d.at}; the body left at tick ${left.tick}, ` +
				`drawing tick ${left.render.toFixed(2)}`,
		);
		check(
			left.render >= d.tick,
			`it stays drawn until the drawing reaches its death (render ${left.render.toFixed(2)} ≥ ${d.tick}): ` +
				"not taken away while still walking to the spot it fell on",
		);
		check(left.render < d.tick + 1.5, "and it leaves on the frame the drawing gets there, not later");
		const rel = client.released.filter(r => r.netId === netId);
		checkEq(rel.length, 1, "the corpse, the blood and the drop go to the view once");
		check(rel.length === 1 && rel[0].frame === left.tick, "on the very frame the body leaves");
	}
}

// ================================================================ (c3) a death overtaken by nothing (audit M1)

section("(c3) under jitter and reordering, a late Snap part never stands a dead zombie up again (§4.4, audit M1)");
{
	/*
	 * `ZombieDied` is reliable and `Snap` is not, and the two are not ordered against each other (§1.1): a part that
	 * carried the zombie alive, from a tick before the death, can land after the death did. It used to build a new
	 * track, and the body stood up for its ring's despawn timeout (300/600 ms). Here the deaths land at once and every
	 * part is 50 ms late plus 0-133 ms of jitter, which reorders them: exactly the Network Simulator case of §12.1.
	 * While the body is still drawn (its death waits for the drawing, audit M3) a late part only smooths it; once it
	 * went, no part from before the death brings it back.
	 */
	const server = newWorldServer();
	const cx = world.width / 2;
	const cy = world.height / 2;
	addSurvivor(server, 0, cx, cy);
	const client = server.clients.get(0);
	client.lag = 3;
	client.jitter = 8;
	client.loss = 0;
	const horde = server.sim.horde;
	server.sim.clock.setClock(12);
	const bodies = [];
	for (let i = 0; i < 24; i++) {
		const a = (i / 24) * Math.PI * 2;
		const z = createZombie(1, cx + Math.cos(a) * 260, cy + Math.sin(a) * 260, 5, false);
		z.alpha = 1;
		horde.zombies.push(z);
		bodies.push(z);
	}
	for (let i = 0; i < 40; i++) {
		tickServer(server);
		drawClients(server);
	}
	const drawnBefore = drawClients(server).get(0).size();
	let ghostFrames = 0;
	const ghostIds = new Set();
	let killed = 0;
	// every part the client takes in, how many carried a body its ZombieDied had already buried, and how many were
	// played again right after their body went
	const log = [];
	let replayed = 0;
	let lateAfterDeath = 0;
	const receive = client.buffer.receive.bind(client.buffer);
	client.buffer.receive = (part, tick, now) => {
		log.push(part);
		for (const z of part.zombies) {
			const d = client.deaths.find(x => x.netId === z.netId);
			if (d !== undefined && unwrapTick(part.tick, server.sim.tick) <= d.tick) lateAfterDeath += 1;
		}
		return receive(part, tick, now);
	};
	for (let i = 0; i < 24 * 9 + 60; i++) {
		// one kill every 9 ticks: always something in flight around a death
		if (i % 9 === 0 && killed < bodies.length) bodies[killed++].hp = 0;
		tickServer(server);
		const gone = client.released.length;
		let drawn = drawClients(server).get(0);
		// the worst late part of all: the newest one from before a death, landing just after its body went
		for (const d of client.released.slice(gone)) {
			let stale;
			for (let k = log.length - 1; k >= 0 && stale === undefined; k--) {
				const p = log[k];
				if (unwrapTick(p.tick, server.sim.tick) <= d.tick && p.zombies.some(z => z.netId === d.netId))
					stale = p;
			}
			if (stale === undefined) continue;
			replayed += 1;
			receive(stale, server.sim.tick, server.now);
		}
		if (client.released.length > gone) drawn = drawClients(server, 0).get(0);
		// once the body went (when the drawing reached its death, audit M3) nothing brings it back
		for (const d of client.released) {
			// the netId is only handed out again NET_ID_REUSE_DELAY_S later: until then it is the dead body
			if (server.sim.tick - d.at > CFG.NET_ID_REUSE_DELAY_S * CFG.SIM_HZ) continue;
			if (drawn.has(d.netId)) {
				ghostFrames += 1;
				ghostIds.add(d.netId);
			}
		}
	}
	info(
		`${drawnBefore} drawn, ${killed} killed, ${client.deaths.length} ZombieDied received; ` +
			`${lateAfterDeath} samples of a body landed after its death did; ${replayed} parts from before a death ` +
			`replayed once its body went: ${client.buffer.stats().ghosts} samples refused`,
	);
	checkEq(client.deaths.length, killed, "every kill reached the client as one ZombieDied");
	checkEq(client.released.length, killed, "and every body left the drawing");
	checkEq(ghostFrames, 0, `no frame draws a zombie after it left (${ghostIds.size()} ghost netIds)`);
	check(lateAfterDeath > 0, "and the late parts were really there: samples from before a death landed after it");
	check(
		replayed > 0 && client.buffer.stats().ghosts >= replayed,
		"and a part from before each death, replayed the frame its body went, was refused (the tomb of audit M1)",
	);
	client.buffer.receive = receive;
}

// ================================================================ (c4) the effects wait for the drawing (audit M3)

section(
	"(c4) an ally's shots, blood and kills play when the drawing reaches them; the shooter's own shot at once (M3)",
);
{
	/*
	 * Everybody else is drawn `delay` behind the clock (§5.1, ~130-160 ms). An effect played the moment it landed was
	 * that far ahead of the bodies it belongs to: blood on a spot the zombie had not reached yet, a body gone while it
	 * was still walking. Slot 0 fires east into a crowd; slot 1 stands beside them and watches. Both links are 50 ms.
	 */
	const server = newWorldServer();
	const cx = world.width / 2;
	const cy = world.height / 2;
	const RIFLE = 13; // the semi-auto rifle of tools/test-server-sim.mjs: every shot is a ShotResult the server resolves
	const armed = defaultSave();
	armed.invenWeapon[RIFLE] = 1;
	armed.equipWeapon = RIFLE;
	armed.ammoNormal = 5000;
	const gunner = addSurvivor(server, 0, cx, cy, armed);
	const buddy = addSurvivor(server, 1, cx, cy + 60);
	for (const sp of [gunner, buddy]) sp.state.godMode = true;
	for (const [, c] of server.clients) {
		c.lag = 3;
		c.loss = 0;
	}
	server.sim.clock.setClock(12);
	const horde = server.sim.horde;
	for (let i = 0; i < 24; i++) {
		const z = createZombie(1, cx + 160 + (i % 8) * 30, cy - 40 + Math.floor(i / 8) * 40, 5, false);
		z.alpha = 1;
		z.hp = 1;
		horde.zombies.push(z);
	}
	for (let i = 0; i < 40; i++) {
		tickServer(server);
		drawClients(server);
	}
	const shooter = server.clients.get(0);
	const watcher = server.clients.get(1);
	// what is measured is the fight
	for (const [, c] of server.clients) {
		c.played.length = 0;
		c.released.length = 0;
		c.fxPackets = 0;
		c.worldPackets = 0;
		c.fxTicks = 0;
		c.worldTicks = 0;
	}
	const seconds = 4;
	/** where the watcher drew each body the frame before, and how far that was from where its ZombieDied says it fell */
	const lastDrawn = new Map();
	const fell = [];
	for (let i = 0; i < seconds * CFG.SIM_HZ; i++) {
		gunner.state.weapon.ammoCount = 20;
		// and a heavier fight's worth of news on both channels, every tick: the batches still leave at 20 Hz
		server.replicator.queueFx({
			t: P.FxType.Blood,
			x: cx + 30,
			y: cy + 60,
			angle: 0,
			amount: 1,
			kind: P.BloodKind.Red,
		});
		server.replicator.queue(server.sim.clock.clockEventNow(server.sim.tick));
		tickServer(server, { edges: P.packEdges(1, 0, 0, 0), held: P.HeldBit.Attack, shooters: [0] });
		const before = watcher.released.length;
		const drawn = drawClients(server).get(1);
		for (const d of watcher.released.slice(before)) {
			const at = lastDrawn.get(d.netId);
			if (at !== undefined) fell.push(Math.hypot(at.x - d.x, at.y - d.y));
		}
		lastDrawn.clear();
		for (const [netId, z] of drawn) lastDrawn.set(netId, { x: z.x, y: z.y });
	}
	const kinds = new Map();
	for (const p of watcher.played) kinds.set(p.e.t, (kinds.get(p.e.t) ?? 0) + 1);
	const names = Object.fromEntries(Object.entries(P.FxType).map(([k, v]) => [v, k]));
	info(
		`the watcher played ${watcher.played.length} effects (` +
			[...kinds].map(([t, n]) => `${names[t]} ${n}`).join(", ") +
			`) and saw ${watcher.released.length} bodies fall`,
	);
	const remote = watcher.played.filter(p => p.e.t !== P.FxType.Shake);
	check(
		remote.some(p => p.e.t === P.FxType.Shot) && remote.some(p => p.e.t === P.FxType.Blood),
		"the watcher was sent the ally's shots and the blood",
	);
	const ahead = remote.map(p => p.tick - p.render);
	const worstAhead = Math.max(...ahead);
	checkEq(
		ahead.filter(a => a > 1e-6).length,
		0,
		`no effect of the fight plays before the drawing reaches its tick (worst ${worstAhead.toFixed(2)} ticks ahead)`,
	);
	const behind = Math.max(...remote.map(p => p.render - p.tick));
	check(behind < 1.5, `and none waits past the frame it gets there (worst ${behind.toFixed(2)} ticks behind)`);
	// the shooter: the confirmation of their own shot at once (their client drew the line when they pulled the trigger)
	const own = shooter.played.filter(p => p.e.t === P.FxType.Shot && p.e.slot === 0);
	check(own.length > 0, `the shooter got their own ShotResults (${own.length})`);
	checkEq(own.filter(p => p.frame !== p.arrived).length, 0, "each played the frame it landed, not held");
	const theirBlood = shooter.played.filter(p => p.e.t === P.FxType.Blood);
	checkEq(
		theirBlood.filter(p => p.tick > p.render + 1e-6).length,
		0,
		"the blood of their hits waits for the zombie it belongs to, like everybody's",
	);
	// the deaths
	check(watcher.released.length > 0, `bodies fell in front of the watcher (${watcher.released.length})`);
	checkEq(
		watcher.released.filter(d => d.render < d.tick).length,
		0,
		"every body stayed drawn until the drawing reached its death",
	);
	const kills = watcher.played.filter(p => p.e.t === P.FxType.Blood && p.e.amount >= 10);
	let paired = 0;
	for (const d of watcher.released) {
		if (kills.some(p => p.frame === d.frame && Math.hypot(p.e.x - d.x, p.e.y - d.y) < 24)) paired += 1;
	}
	info(
		`the kill's blood played on the frame its body left for ${paired} of ${watcher.released.length} deaths; ` +
			`last drawn spot to where it fell: median ${percentile(fell, 0.5).toFixed(1)} u, ` +
			`p95 ${percentile(fell, 0.95).toFixed(1)} u`,
	);
	check(
		paired === watcher.released.length,
		"the kill's blood and the body leaving land on the same frame (client/view/fxView.ts pours one pool for both)",
	);
	// the cadence: both channels on the snapshot's, 20 batches a second at most (a World flush can be two remote
	// events: the broadcast and the directed half)
	const cadence = CFG.SIM_HZ / CFG.SNAP_NEAR_EVERY_TICKS;
	const fxRate = watcher.fxTicks / seconds;
	const worldRate = watcher.worldTicks / seconds;
	info(
		`to the watcher, per second: Fx ${fxRate.toFixed(1)} batches (${(watcher.fxPackets / seconds).toFixed(1)} ` +
			`remote events), World ${worldRate.toFixed(1)} batches (${(watcher.worldPackets / seconds).toFixed(1)})`,
	);
	check(fxRate <= cadence, `Fx goes out on the snapshot's cadence (${fxRate.toFixed(1)}/s ≤ ${cadence}/s)`);
	check(worldRate <= cadence, `and so does World (${worldRate.toFixed(1)}/s ≤ ${cadence}/s)`);
}

// ================================================================ (l2) what the dark hides stays hidden (audit L2)

section(
	"(l2) at night a zombie's blood, the hits on it, its death and its fresh drop reach only who could see it (L2)",
);
{
	/*
	 * The snapshot withholds a zombie in the dark past DARK_SENSE_RANGE (§4.3, section b). Its blood, a shot's hit on
	 * it, its death and the drop it left did not: each carried its position to every client in range. Slot 0 watches
	 * from the middle of town at 23:00; slot 1 shoots from 500 u west. `hidden` stands 400 u east of the watcher,
	 * outside every light; `heard` 100 u east, close enough to be heard.
	 */
	const W = require(join(SRC, "shared/game/world.ts"));
	// the town is shared by every section: the drops of the fights before would share ids with this server's
	W.clearGroundItems(world);
	const server = newWorldServer();
	const cx = world.width / 2;
	const cy = world.height / 2;
	addSurvivor(server, 0, cx, cy);
	addSurvivor(server, 1, cx - 500, cy);
	for (const [, c] of server.clients) {
		c.lag = 0;
		c.loss = 0;
		c.fxLog = [];
	}
	server.sim.clock.setClock(23);
	const horde = server.sim.horde;
	const hidden = createZombie(1, cx + 400, cy, 5, false);
	const heard = createZombie(1, cx + 100, cy, 5, false);
	for (const z of [hidden, heard]) horde.zombies.push(z);
	const hold = () => {
		for (const [z, dx] of [
			[hidden, 400],
			[heard, 100],
		]) {
			z.x = cx + dx;
			z.y = cy;
			z.alpha = 0;
		}
	};
	const run = n => {
		for (let i = 0; i < n; i++) {
			hold();
			tickServer(server);
			drawClients(server);
		}
	};
	run(40);
	const watcher = server.clients.get(0);
	const shooter = server.clients.get(1);
	const hiddenId = horde.netIdOf(hidden);
	const heardId = horde.netIdOf(heard);
	const drawn = drawClients(server).get(0);
	check(!drawn.has(hiddenId) && drawn.has(heardId), "the snapshot withholds `hidden` and sends `heard` (section b)");
	for (const [, c] of server.clients) c.fxLog.length = 0;
	const R = server.replicator;
	const G = P.BloodKind.Green;
	R.queueFx({ t: P.FxType.Blood, x: hidden.x, y: hidden.y, angle: 0, amount: 3, kind: G });
	R.queueFx({ t: P.FxType.Blood, x: heard.x, y: heard.y, angle: 0, amount: 3, kind: G });
	// a survivor's blood: a survivor is sent in range whatever the light, and so is theirs
	R.queueFx({ t: P.FxType.Blood, x: cx + 380, y: cy, angle: 0, amount: 3, kind: P.BloodKind.Red });
	const hits = [
		{ x: hidden.x, y: hidden.y, hit: P.HitKind.Zombie },
		{ x: heard.x, y: heard.y, hit: P.HitKind.Zombie },
		{ x: cx + 450, y: cy + 30, hit: P.HitKind.Solid },
	];
	R.queueFx({ t: P.FxType.Shot, slot: 1, weapon: 1, hits });
	R.queueFx({
		t: P.FxType.ProjSpawn,
		projId: 900,
		kind: P.ProjKind.Spit,
		owner: CFG.SLOT_NONE,
		x: hidden.x,
		y: hidden.y,
		angle: Math.PI,
		speed: 200,
	});
	R.queueFx({
		t: P.FxType.ProjSpawn,
		projId: 901,
		kind: P.ProjKind.Arrow,
		owner: 1,
		x: cx - 480,
		y: cy,
		angle: 0,
		speed: 600,
	});
	run(CFG.SNAP_NEAR_EVERY_TICKS);
	R.queueFx({ t: P.FxType.ProjEnd, projId: 900, x: cx + 150, y: cy, how: P.ProjEndHow.Fell });
	R.queueFx({ t: P.FxType.ProjEnd, projId: 901, x: cx + 300, y: cy, how: P.ProjEndHow.Fell });
	run(CFG.SNAP_NEAR_EVERY_TICKS);
	const near = (e, z) => Math.hypot(e.x - z.x, e.y - z.y) < 1;
	const wl = watcher.fxLog;
	const greenAt = (log, z) => log.some(e => e.t === P.FxType.Blood && e.kind === G && near(e, z));
	check(!greenAt(wl, hidden), "the watcher is not sent the blood of the zombie it cannot see");
	check(greenAt(wl, heard), "but is sent the blood of the one it hears");
	check(
		wl.some(e => e.t === P.FxType.Blood && e.kind === P.BloodKind.Red),
		"and a survivor's blood in range",
	);
	const shots = wl.filter(e => e.t === P.FxType.Shot);
	checkEq(shots.length, 1, "the ally's shot reaches the watcher");
	if (shots.length === 1) {
		checkEq(shots[0].hits.length, 2, "without its hit on the hidden zombie (the wall and the heard one stay)");
		check(!shots[0].hits.some(h => near(h, hidden)), "no hit names the hidden zombie's spot");
	}
	const theirs = shooter.fxLog.filter(e => e.t === P.FxType.Shot);
	check(theirs.length === 1 && theirs[0].hits.length === 3, "the shooter gets their own shot whole");
	const spawned = id => wl.some(e => e.t === P.FxType.ProjSpawn && e.projId === id);
	const ended = id => wl.some(e => e.t === P.FxType.ProjEnd && e.projId === id);
	check(!spawned(900) && !ended(900), "a spit in the dark: neither its flight nor its end reach the watcher");
	check(spawned(901) && ended(901), "an arrow it saw fly: both do");
	check(
		shooter.fxLog.some(e => e.t === P.FxType.ProjEnd && e.projId === 901),
		"and to the archer, who saw it too",
	);
	// the deaths, and what they drop
	const items = server.sim.items;
	check(items !== undefined, "the server keeps the ground items (phase ≥ 2)");
	const dropHidden = W.spawnGroundItem(server.sim.world, 4, 23, 1, hidden.x, hidden.y);
	const dropHeard = W.spawnGroundItem(server.sim.world, 4, 23, 1, heard.x, heard.y);
	hidden.hp = 0;
	heard.hp = 0;
	run(2 * CFG.SNAP_NEAR_EVERY_TICKS);
	const diedFor = (c, id) => c.deaths.some(d => d.netId === id);
	check(!diedFor(watcher, hiddenId), "no ZombieDied for a zombie the watcher was never sent");
	check(diedFor(watcher, heardId), "one for the zombie it was drawing");
	check(!watcher.itemAdds.includes(dropHidden.id), "a drop that just fell in the dark is not told to the watcher");
	check(watcher.itemAdds.includes(dropHeard.id), "one that fell within earshot is");
	// news goes stale: past ITEM_NEWS_S the drop is litter, told in range like any other
	const staleTicks = Math.ceil(((CFG.ITEM_NEWS_S ?? 0) + 1) * CFG.SIM_HZ);
	for (let i = 0; i < staleTicks; i++) {
		tickServer(server);
		if (watcher.itemAdds.includes(dropHidden.id)) break;
	}
	check(watcher.itemAdds.includes(dropHidden.id), `past ITEM_NEWS_S (${CFG.ITEM_NEWS_S} s) it is litter, and told`);
	W.removeGroundItem(server.sim.world, dropHidden);
	W.removeGroundItem(server.sim.world, dropHeard);
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
	// audit L1: the engine drops an unreliable payload over 1000 B after ITS encoding, so ours stay under a raw ceiling
	const w = server.wire;
	const limit = CFG.UNRELIABLE_PAYLOAD_LIMIT;
	info(
		`largest Snap part ${w.snapMax} B, largest Fx packet ${w.fxMax} B: headroom to the engine's ${limit} B ` +
			`${limit - Math.max(w.snapMax, w.fxMax)} B; ${w.split} of ${w.snapshots} snapshots went out in two parts`,
	);
	check(
		w.snapMax <= CFG.UNRELIABLE_MAX_BYTES,
		`every Snap part is ≤ UNRELIABLE_MAX_BYTES (${CFG.UNRELIABLE_MAX_BYTES} B)`,
	);
	check(
		w.fxMax <= CFG.UNRELIABLE_MAX_BYTES,
		`every Fx packet is ≤ UNRELIABLE_MAX_BYTES (${CFG.UNRELIABLE_MAX_BYTES} B)`,
	);
	// and the last guard before the engine checks that ceiling, not the engine's own 1000
	const saved = globalThis.game;
	globalThis.game = { GetService: () => ({}) };
	const remotes = require(join(SRC, "server/net/remotes.ts"));
	globalThis.game = saved;
	let fired = 0;
	const remote = {
		FireClient() {
			fired += 1;
		},
	};
	const fits = remotes.sendUnreliable(remote, {}, buffer.create(CFG.UNRELIABLE_MAX_BYTES));
	const over = remotes.sendUnreliable(remote, {}, buffer.create(CFG.UNRELIABLE_MAX_BYTES + 1));
	check(
		fits && !over && fired === 1,
		`sendUnreliable refuses ${CFG.UNRELIABLE_MAX_BYTES + 1} B (over our ceiling, under the engine's ${limit})`,
	);
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
	checkEq(
		CFG.MP_PHASE >= PROG.PROGRESS_SERVER_PHASE,
		true,
		"MP_PHASE is at the phase where the server owns progress",
	);
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
	info(
		`${ticks} ticks, ${server.sim.horde.count()} zombies, ${server.sim.count()} survivors, Node ${process.version}`,
	);
	info(`tick cost (simulation + replication): avg ${avg.toFixed(3)} ms · p95 ${p95.toFixed(3)} ms`);
	info("Luau on a Roblox server is slower than Node: this is a regression guard, not the §3.2 verdict");
	check(
		p95 < 1000 / CFG.SIM_HZ,
		`p95 stays under the tick period (${p95.toFixed(3)} ms < ${(1000 / CFG.SIM_HZ).toFixed(1)} ms)`,
	);
	checkEq(server.sim.stats.droppedTicks, 0, "no tick was dropped");
}

// ================================================================ (g) what a survivor wears (MON-04, §4.4)

section("(g) the roster carries outfit and pet, and a change mid-session reaches everybody (MON-04, §4.4)");
{
	const equipOf = name => COSTUMES.find(c => c.name === name).equipId;
	const costumeOf = name => COSTUMES.find(c => c.name === name).id;
	const server = newWorldServer();
	const cx = world.width / 2;
	const cy = world.height / 2;
	// slot 0 walks in already wearing what it bought: the Cowboy outfit and the Eagle
	const dressed = defaultSave();
	dressed.costumes[costumeOf("Cowboy")] = 1;
	dressed.costumes[costumeOf("Eagle")] = 1;
	dressed.equipOutfit = equipOf("Cowboy");
	dressed.equipPet = equipOf("Eagle");
	const a = addSurvivor(server, 0, cx, cy, dressed);
	const b = addSurvivor(server, 1, cx + 40, cy);
	for (let i = 0; i < 3; i++) tickServer(server);
	const ca = server.clients.get(0);
	const cb = server.clients.get(1);
	checkEq(cb.roster.get(0)?.outfit, COS.OutfitLook.Cowboy, "the ally's PlayerJoined carries the outfit it wears");
	checkEq(cb.roster.get(0)?.pet, COS.PetLook.Eagle, "and the pet at its heel");
	checkEq(ca.roster.get(0)?.outfit, COS.OutfitLook.Cowboy, "its own client is told the same (the server's word)");
	checkEq(cb.roster.get(1)?.outfit, COS.OutfitLook.None, "a survivor with nothing bought wears nothing");
	checkEq(ca.profiles.length + cb.profiles.length, 0, "and nothing changed, so no PlayerProfile was sent");

	// mid-session: slot 1 buys Santa and the Doberman in the shop (the server writes `costumes`), then equips
	// them in the backpack -- which reaches the server as a save report, exactly the processReport path
	b.save.costumes[costumeOf("Santa")] = 1;
	b.save.costumes[costumeOf("Doberman")] = 1;
	const report = JSON.parse(JSON.stringify(b.save));
	report.equipOutfit = equipOf("Santa");
	report.equipPet = equipOf("Doberman");
	copySaveInto(b.save, sanitizeClientReport(report, b.save));
	for (let i = 0; i < 12; i++) tickServer(server);
	checkEq(
		ca.roster.get(1)?.outfit,
		COS.OutfitLook.Santa,
		"the other client sees the new outfit, in the same session",
	);
	checkEq(ca.roster.get(1)?.pet, COS.PetLook.Doberman, "and the new pet");
	checkEq(cb.roster.get(1)?.outfit, COS.OutfitLook.Santa, "the owner's client hears what the server accepted");
	checkEq(ca.profiles.length, 1, "one change, one PlayerProfile (not one per tick)");
	check(ca.profiles.length > 0 && ca.profiles[0].slot === 1, "and it names the survivor who changed (slot 1)");

	// a report wearing something NOT bought is corrected on the server and never reaches the wire
	const forged = JSON.parse(JSON.stringify(b.save));
	forged.equipOutfit = equipOf("Zombie");
	forged.equipPet = equipOf("Malamute");
	forged.costumes = forged.costumes.map(() => 1);
	copySaveInto(b.save, sanitizeClientReport(forged, b.save));
	for (let i = 0; i < 12; i++) tickServer(server);
	checkEq(ca.roster.get(1)?.outfit, COS.OutfitLook.None, "a forged outfit is taken off, not shown to anyone");
	checkEq(ca.roster.get(1)?.pet, COS.PetLook.None, "and so is a forged pet");
	// even a live table somebody wrote into directly is checked again before it is replicated
	b.save.equipOutfit = equipOf("Zombie");
	for (let i = 0; i < 12; i++) tickServer(server);
	checkEq(ca.roster.get(1)?.outfit, COS.OutfitLook.None, "an unowned outfit in the live save never goes on the wire");

	// the level on the plate is part of the same profile: before this it never changed inside a session
	const before = ca.roster.get(1)?.level;
	b.save.level += 1;
	for (let i = 0; i < 12; i++) tickServer(server);
	checkEq(ca.roster.get(1)?.level, before + 1, "a level-up reaches the allies' plates mid-session");

	// someone joining in the same tick as a change still reads the current look. The worst case is pinned: the
	// very next tick is a periodic profile pass, whose PlayerProfile goes out in the BROADCAST half of the flush
	// -- before the newcomer's own PlayerJoined for that survivor, so the newcomer would drop it as "unknown
	// slot" and keep the stale look for good. `welcome` refreshing the profiles first is what prevents that.
	while ((server.sim.tick + 1) % PROFILE_EVERY_TICKS !== 0) tickServer(server);
	b.save.equipOutfit = equipOf("Santa");
	const c = addSurvivor(server, 2, cx - 40, cy);
	for (let i = 0; i < 3; i++) tickServer(server);
	const cc = server.clients.get(2);
	checkEq(cc.roster.get(1)?.outfit, COS.OutfitLook.Santa, "a newcomer's roster has the outfit worn NOW");
	checkEq(cc.roster.get(0)?.pet, COS.PetLook.Eagle, "and every other survivor's pet");
	checkEq(cc.roster.get(2)?.outfit, COS.OutfitLook.None, "and its own plain look");
	check(c.outfit === COS.OutfitLook.None && a.pet === COS.PetLook.Eagle, "the server's profile fields agree");
}

// ================================================================ (h) the title under the name (MON-05, §4.4)

section("(h) the title under the name reaches the others only when the server says it was EARNED (MON-05, §4.4)");
{
	const { equipTitle } = require(join(SRC, "server/save/titles.ts"));
	const wire = id => TIT.titleToWire(id);
	const HB = TIT.TitleId.HordeBreaker;
	const server = newWorldServer();
	// the host's wiring (server/net/mpHost.ts): an unlock is told to its owner on the reliable channel
	server.sim.onTitleUnlocked = (sp, titleId) => server.replicator.titleUnlocked(sp.slot, titleId);
	const cx = world.width / 2;
	const cy = world.height / 2;
	// slot 0 walks in showing a title it earned (Survivor); slot 1 has earned nothing
	const survivor = defaultSave();
	survivor.titles[TIT.TitleId.Survivor] = 1;
	survivor.equipTitle = TIT.TitleId.Survivor;
	const a = addSurvivor(server, 0, cx, cy, survivor);
	const b = addSurvivor(server, 1, cx + 40, cy);
	for (let i = 0; i < 3; i++) tickServer(server);
	const ca = server.clients.get(0);
	const cb = server.clients.get(1);
	checkEq(cb.roster.get(0)?.title, wire(TIT.TitleId.Survivor), "the ally's PlayerJoined carries the title it shows");
	checkEq(ca.roster.get(0)?.title, wire(TIT.TitleId.Survivor), "and its own client is told the same");
	checkEq(ca.roster.get(1)?.title, 0, "a survivor with nothing earned shows nothing");

	// a report that claims every title and shows one: corrected on the server, never on the wire
	const forged = JSON.parse(JSON.stringify(b.save));
	forged.titles = forged.titles.map(() => 1);
	forged.zombieKills = 5000;
	forged.equipTitle = TIT.TitleId.WeekOne;
	copySaveInto(b.save, sanitizeClientReport(forged, b.save));
	for (let i = 0; i < 12; i++) tickServer(server);
	checkEq(ca.roster.get(1)?.title, 0, "a title a report claims is never shown to anyone");
	checkEq(b.save.zombieKills, 0, "and the kills it claims are not counted");
	// even a live table somebody wrote into directly is checked again before it is replicated
	b.save.equipTitle = TIT.TitleId.WeekOne;
	for (let i = 0; i < 12; i++) tickServer(server);
	checkEq(ca.roster.get(1)?.title, 0, "an unearned title in the live save never goes on the wire");
	b.save.equipTitle = -1;

	// the server's own kill credit makes slot 1 a Horde Breaker: the killing blow that reaches the goal
	b.save.zombieKills = TIT.HORDE_BREAKER_KILLS - 1;
	const announcesA = ca.announces.length;
	server.sim.progress.zombieKilled(999001, 10, 1, server.now);
	for (let i = 0; i < 12; i++) tickServer(server);
	const unlocks = list => list.filter(e => e.msg === P.AnnounceKind.TitleUnlocked);
	checkEq(unlocks(cb.announces).length, 1, "the survivor who earned it hears it once, on the reliable channel");
	checkEq(unlocks(cb.announces)[0]?.arg, wire(HB), "naming the title (Horde Breaker)");
	checkEq(ca.announces.length - announcesA, 0, "and nobody else is told");
	checkEq(ca.roster.get(1)?.title, 0, "earning is not showing: the others see it only once it is chosen");
	const profilesBefore = ca.profiles.length;

	// the wardrobe's Equip, as the server applies it (server/save/titles.ts through ShopAction)
	check(equipTitle(b.save, HB).ok, "the server accepts showing a title it granted");
	for (let i = 0; i < 12; i++) tickServer(server);
	checkEq(ca.roster.get(1)?.title, wire(HB), "the others see it under the name, in the same session");
	checkEq(cb.roster.get(1)?.title, wire(HB), "and its owner hears what the server accepted");
	checkEq(ca.profiles.length - profilesBefore, 1, "one change, one PlayerProfile");
	// a newcomer reads the current title in its PlayerJoined
	addSurvivor(server, 2, cx - 40, cy);
	for (let i = 0; i < 3; i++) tickServer(server);
	checkEq(server.clients.get(2).roster.get(1)?.title, wire(HB), "a newcomer's roster has the title shown NOW");
	// and taken off
	check(equipTitle(b.save, -1).ok, "and to take it off");
	for (let i = 0; i < 12; i++) tickServer(server);
	checkEq(ca.roster.get(1)?.title, 0, "which everybody sees too");
	check(a.title === wire(TIT.TitleId.Survivor) && b.title === 0, "the server's profile fields agree");
}

// ================================================================ (i) the scoreboard's numbers (MP-23, §4.4)

section(
	"(i) the scoreboard: every survivor's life day and zombies put down, the server's, only when they move (MP-23)",
);
{
	const server = newWorldServer();
	const cx = world.width / 2;
	const cy = world.height / 2;
	const veteran = defaultSave();
	veteran.day = 9;
	veteran.zombieKills = 137;
	const a = addSurvivor(server, 0, cx, cy, veteran);
	const b = addSurvivor(server, 1, cx + 40, cy);
	const ca = server.clients.get(0);
	const cb = server.clients.get(1);
	// the round goes out with the World batch after it (on the snapshot's cadence, audit M3)
	for (let i = 0; i < TALLY_AFTER_JOIN_TICKS + CFG.WORLD_FLUSH_EVERY_TICKS; i++) tickServer(server);
	checkEq(cb.roster.get(0)?.lifeDay, 9, "an ally's scoreboard has the veteran's day of life (the server's save)");
	checkEq(cb.roster.get(0)?.kills, 137, "and the zombies it put down");
	checkEq(ca.roster.get(0)?.kills, 137, "its own client is told the same numbers (one source for every row)");
	checkEq(ca.roster.get(1)?.lifeDay, 1, "a new life is day 1");
	checkEq(ca.roster.get(1)?.kills, 0, "with nothing put down");
	checkEq(ca.tallyDrops + cb.tallyDrops, 0, "no tally ever reached a client before the PlayerJoined of its slot");

	// quiet: nothing moved, nothing is sent (a steady server costs the scoreboard nothing)
	const quietFrom = ca.tallies.length;
	for (let i = 0; i < TALLY_EVERY_TICKS * 3; i++) tickServer(server);
	checkEq(ca.tallies.length - quietFrom, 0, `3 s with nothing moving: no PlayerTally at all`);

	// a fight: slot 1 puts down 12 zombies in half a second -- the others hear it within a second, in ONE delta
	while (server.sim.tick % TALLY_EVERY_TICKS !== 1) tickServer(server);
	const fightFrom = ca.tallies.length;
	for (let k = 0; k < 12; k++) {
		server.sim.progress.zombieKilled(990000 + k, 10, 1, server.now);
		tickServer(server);
		tickServer(server);
	}
	for (let i = 0; i < TALLY_EVERY_TICKS; i++) tickServer(server);
	checkEq(
		ca.roster.get(1)?.kills,
		12,
		"the other client sees the 12 kills (the server's kill credit, MON-05's counter)",
	);
	checkEq(cb.roster.get(1)?.kills, b.save.zombieKills, "and the killer's own row agrees with its save");
	const fightTallies = ca.tallies.slice(fightFrom).filter(e => e.slot === 1).length;
	check(
		fightTallies >= 1 && fightTallies <= 2,
		`12 kills in 24 ticks cost ${fightTallies} PlayerTally (at most one a second per survivor, TALLY_EVERY_TICKS = ${TALLY_EVERY_TICKS})`,
	);

	// the midnight that credits a day (server/sim/progress.ts writes the save): the day moves on everybody's board
	b.save.day += 1;
	for (let i = 0; i < TALLY_EVERY_TICKS; i++) tickServer(server);
	checkEq(ca.roster.get(1)?.lifeDay, 2, "a credited midnight moves the life day on the others' scoreboard");
	// a New game (resetRun) takes it back to 1 -- also just the save
	b.save.day = 1;
	for (let i = 0; i < TALLY_EVERY_TICKS; i++) tickServer(server);
	checkEq(ca.roster.get(1)?.lifeDay, 1, "a new life goes back to day 1 on every board");

	// a report can never move either number: the kills are the server's (MON-05, `sanitizeClientReport`) and so is the
	// day from PROGRESS_SERVER_PHASE on (`stripClientProgress`, which server/main.server.ts runs on every report)
	const forged = JSON.parse(JSON.stringify(b.save));
	forged.day = 400;
	forged.zombieKills = 9000;
	const upd = sanitizeClientReport(forged, b.save);
	PROG.stripClientProgress(b.save, upd);
	copySaveInto(b.save, upd);
	for (let i = 0; i < TALLY_EVERY_TICKS; i++) tickServer(server);
	check(
		ca.roster.get(1)?.lifeDay === 1 && ca.roster.get(1)?.kills === 12,
		"a forged report (day 400, 9000 kills) moves neither number on anyone's board",
	);

	// the worst join: a change is pending and the very next tick is a tally pass. The newcomer still ends with the
	// numbers of NOW for everybody, and never drops a tally for a slot it did not know yet
	while ((server.sim.tick + 1) % TALLY_EVERY_TICKS !== 0) tickServer(server);
	a.save.zombieKills += 1;
	addSurvivor(server, 2, cx - 40, cy);
	const cc = server.clients.get(2);
	// the round goes out with the World batch after it (on the snapshot's cadence, audit M3)
	for (let i = 0; i < TALLY_AFTER_JOIN_TICKS + CFG.WORLD_FLUSH_EVERY_TICKS; i++) tickServer(server);
	checkEq(cc.roster.get(0)?.kills, 138, "a newcomer's scoreboard has the kills of NOW");
	checkEq(cc.roster.get(1)?.lifeDay, 1, "and every other survivor's day");
	checkEq(cc.roster.get(2)?.lifeDay, 1, "and its own");
	checkEq(cc.tallyDrops, 0, "and it never dropped a tally for a slot it did not know");
	checkEq(ca.roster.get(2)?.kills, 0, "the others hear the newcomer's numbers too");
	check(a.kills === 138 && b.lifeDay === 1, "the server's last-told fields agree");
}

section(
	"(j) the grid reaches every client: after the SolidAdds in a WorldInit, then only on a change, globally (ELE-01..08)",
);
{
	resetEntityIds();
	const W = require(join(SRC, "shared/game/world.ts"));
	const { PLACEABLES, placedSolid } = require(join(SRC, "shared/sim/placement.ts"));
	const POW = require(join(SRC, "shared/data/power.ts"));
	const pworld = W.serverWorld(W.createWorld(6000, 6000));
	const sim = new ServerSimulation({ world: pworld, zombies: true, interactive: true });
	const transport = recordingTransport();
	const replicator = new Replicator(sim, transport, { tick0Time: 0, mapHash: mapHashOf(pworld) });
	sim.onTick = tick => replicator.afterTick(tick);
	sim.onFx = event => replicator.queueFx(event);
	const server = {
		sim,
		transport,
		replicator,
		clients: new Map(),
		hist: new Map(),
		wire: { snapMax: 0, fxMax: 0, snapshots: 0, split: 0 },
		now: 0,
	};
	const place = (id, x, y) => {
		const d = PLACEABLES[id];
		return W.addSolid(pworld, { ...placedSolid(d, { x, y, w: d.w, h: d.h }, 0), placeable: id, owner: 0 });
	};
	addSurvivor(server, 0, 1000, 1000);
	addSurvivor(server, 1, 5000, 5000);
	const box = place(6, 1150, 980);
	const lamp = place(4, 1020, 976);
	for (let i = 0; i < 20; i++) tickServer(server);
	const far = server.clients.get(1);
	const boxSet = far.machines.find(e => e.t === P.WorldEv.PowerSet && e.id === box.id);
	check(boxSet !== undefined, "a survivor 5600 u away hears the new battery box's state (PowerSet is global)");
	check(
		boxSet !== undefined && POW.powerWorking(boxSet.state) && POW.powerLevel(boxSet.state) === 3,
		"a charged box: working, level 3",
		JSON.stringify(boxSet),
	);
	const quiet = far.machines.length;
	for (let i = 0; i < 120; i++) tickServer(server);
	checkEq(far.machines.length - quiet, 0, "2 s of nothing changing: no PowerSet at all");
	// a late joiner: every construction, and then every machine's state, in that order
	addSurvivor(server, 2, 3000, 3000);
	tickServer(server);
	const late = server.clients.get(2).machines;
	const order = late.map(e => `${e.t === P.WorldEv.SolidAdd ? "add" : "power"}:${e.id === box.id ? "box" : "lamp"}`);
	check(
		order.join(",") === "add:box,add:lamp,power:box,power:lamp",
		"the newcomer's WorldInit: the SolidAdds, then each machine's PowerSet",
		order.join(","),
	);
	// the survivor at the base switches the lamp on: everyone hears it, the far ones included
	const before = far.machines.length;
	tickServer(server, { edges: P.packEdges(0, 0, 1, 0) });
	// the World batch goes out on the snapshot's cadence (audit M3)
	for (let i = 0; i < CFG.WORLD_FLUSH_EVERY_TICKS; i++) tickServer(server);
	const lampSet = far.machines.slice(before).find(e => e.t === P.WorldEv.PowerSet && e.id === lamp.id);
	check(
		lampSet !== undefined && POW.powerWorking(lampSet.state),
		"E switched the lamp on: a PowerSet, working, to everybody",
		JSON.stringify(lampSet),
	);
	check(lamp.powered === true, "and on the server it lights (fed by the box 130 u away)");
}

// ================================================================ the zombies' awareness (IA-03 / IA-05)

section("(ia) every client draws the awareness state the SERVER decided (2 bits of the record, protocol decision 17)");
{
	const server = newWorldServer();
	const cx = world.width / 2;
	const cy = world.height / 2;
	addSurvivor(server, 0, cx, cy);
	addSurvivor(server, 1, cx + 40, cy);
	seedHorde(server, 40, cx, cy, 700);
	const horde = server.sim.horde;
	// what each zombie was, tick by tick: the client draws a sample up to its interpolation delay old
	const history = new Map();
	const RECENT = 30;
	const seenAware = new Set();
	let compared = 0;
	let wrong = 0;
	let disagree = 0;
	for (let t = 0; t < 60 * 8; t++) {
		// the second survivor fires a gun now and then: noise, so the horde goes through every state
		if (t % 90 === 45)
			server.sim.horde.refs.sounds.push({ x: cx + 40, y: cy, r: 0, rMax: 800, shot: true, id: 9000 + t });
		tickServer(server);
		for (const z of horde.zombies) {
			const id = horde.netIdOf(z);
			let h = history.get(id);
			if (h === undefined) {
				h = [];
				history.set(id, h);
			}
			h.push(z.aware ?? 0);
			if (h.length > RECENT) h.shift();
			seenAware.add(z.aware ?? 0);
		}
		const drawn = drawClients(server);
		if (t < 60) continue;
		const a = drawn.get(0);
		const b = drawn.get(1);
		for (const [netId, za] of a) {
			const h = history.get(netId);
			if (h === undefined) continue;
			compared += 1;
			if (!h.includes(za.aware)) wrong += 1;
			const zb = b.get(netId);
			if (zb !== undefined && !h.includes(zb.aware)) disagree += 1;
		}
	}
	info(
		`${compared} drawn zombie-frames compared · states seen on the server: ${[...seenAware].sort().join(", ")} ` +
			`(0 idle, 1 suspicious, 2 searching, 3 chasing)`,
	);
	check(seenAware.size() >= 3, "the horde went through the states (the check is not comparing idle with idle)");
	checkEq(wrong, 0, "every drawn state is one the server really had for that zombie in the last half second");
	checkEq(disagree, 0, "...on the second screen too: two screens never draw a state the server did not have");
	// the wire costs nothing more: the state rides the meta byte F0 reserved
	const one = P.encodeSnapshot({
		tick: 1,
		players: [],
		zombies: [{ netId: 5, x: 10, y: 10, angle: 0, flags: 0, type: 1, big: false, mid: false, aware: 3 }],
		bosses: [],
	});
	checkEq(buffer.len(one.parts[0]), 8 + 9, "a zombie record is still 9 bytes with its state (header 8 + 9)");
}

// ---------------------------------------------------------------- verdict

console.log("");
if (failures > 0) {
	console.log(`${failures} replication check(s) FAILED`);
	process.exit(1);
}
console.log("all replication tests passed");
