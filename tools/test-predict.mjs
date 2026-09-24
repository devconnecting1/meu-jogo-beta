#!/usr/bin/env node
/*
 * Prediction / reconciliation / interpolation self-test of the F1 client net layer
 * (docs/MULTIPLAYER.md §2.2, §4.4, §5.1, §5.2; acceptance in §11.3 F1 and §12.2).
 *
 *   node tools/test-predict.mjs                      # 50 / 100 / 200 ms RTT at 2 % loss
 *   node tools/test-predict.mjs --seconds 30         # longer runs
 *   node tools/test-predict.mjs --seed 7 --loss 0.05
 *   PZ_SRC=path/to/src node tools/test-predict.mjs
 *
 * It stands a REAL server-shaped simulation next to a REAL client: `shared/sim/playerMove.ts` on both sides, the
 * server's own §2.2 input queue -- `server/sim/players.ts` itself (ingestInput → token bucket, decodeInput, the
 * window, the queue; takeCommand; bufferDepth; ackSeq), not a model of it -- and
 * `client/net/{clockSync,commands,prediction,snapshotBuffer}.ts` unmodified on the client. Everything between them
 * goes through the actual wire format — `encodeInput`/`decodeInput` and `encodeSnapshot`/`decodeSnapshotPart` — so
 * the f32 self block, the 0.5 u position quantisation and the u16 tick wrap are all exercised, over a link that
 * delays, jitters, drops, duplicates and reorders packets.
 *
 * It used to carry its own model of that queue, and the model drifted: it kept the F1 rule (a filled tick spends
 * the seq and discards the real command, one tick of coasting) after players.ts moved to WAITING. A test of the
 * prediction against a server that no longer exists proves nothing about the one that does.
 *
 * What it proves:
 *
 *   1. divergence p99 < 1 u between what the client predicted for a command and what the server computed for it
 *      (§12.2), at 50, 100 and 200 ms RTT with 2 % loss;
 *   2. no correction above 16 u in normal conditions (§11.3 F1: fewer than one a minute, outside knockback) —
 *      here, none at all;
 *   3. the interpolation of the other survivors only ever moves FORWARD, including on a link that reorders and
 *      duplicates packets (§4.4: duplicates and stale packets are dropped, §5.1: the render time is monotonic);
 *   4. the unacked command queue stays bounded: it sits at about one RTT of commands, never reaches the
 *      MAX_PENDING ceiling even through a total upstream blackout, and comes back down afterwards (§2.2);
 *   5. a hit the SERVER lands lights the local survivor's hit flash (the HUD vignette, the HP bar's relief, the
 *      sprite): a bite, a bite the armour absorbed whole, an explosion inside the i-frames, a bite the tick the
 *      i-frames ran out; contact damage re-lights it at most every HIT_ALARM.GAP_S (2,5/s); poison and hunger
 *      never light it, not even across a 4 s blackout; nothing else does either. The self block is the server's
 *      own (`server/net/replication.ts` selfBlockOf), not a copy;
 *   6. [vitals] DESIGN_RULES VIT-01: with the server biting and poisoning through its own damage entry point, and
 *      the wait before healing on nobody's wire, the HP the client draws is the server's: through a fight it never
 *      rises between hits, once healing it never falls back, per command it is never above the server's (but for
 *      one step of healing per command the server skipped, until the next ack), at a walker's rhythm, into the food
 *      gate, with Recovery 3, under a crowd that bites the tick each guard ends, and on a link past the server's
 *      input queue.
 *
 * Exit code 1 on any failure. Pure Node (>= 18) + the project's TypeScript (devDependency) to transpile src on the
 * fly, with the Luau / roblox-ts shims of tools/test-sim.mjs and the strict `buffer` of tools/test-net.mjs.
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
	random: () => 0.5,
};
globalThis.print = (...a) => console.log(...a);
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

// strict Luau `buffer`: out-of-bounds throws, and an out-of-range integer write throws instead of wrapping, so a
// missing clamp in the codec fails the test rather than corrupting a neighbouring field (same rule as test-net)
class LuauBuffer {
	constructor(size) {
		this.bytes = new Uint8Array(size);
		this.view = new DataView(this.bytes.buffer);
	}
}
function bcheck(b, offset, n) {
	if (!(b instanceof LuauBuffer)) throw new TypeError("buffer expected");
	if (!Number.isInteger(offset)) throw new TypeError(`offset ${offset} not an integer`);
	if (offset < 0 || offset + n > b.bytes.length) {
		throw new RangeError(`buffer access out of bounds (offset ${offset}, ${n} B, len ${b.bytes.length})`);
	}
}
function icheck(v, lo, hi, what) {
	if (!Number.isInteger(v) || v < lo || v > hi) {
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
		b.view.setFloat32(o, v, true);
	},
	writef64(b, o, v) {
		bcheck(b, o, 8);
		b.view.setFloat64(o, v, true);
	},
	readstring(b, o, count) {
		bcheck(b, o, count);
		return Buffer.from(b.bytes.subarray(o, o + count)).toString("utf8");
	},
	writestring(b, o, value, count) {
		const bytes = Buffer.from(String(value), "utf8");
		const n = count === undefined ? bytes.length : count;
		bcheck(b, o, n);
		b.bytes.set(bytes.subarray(0, n), o);
	},
	copy(target, targetOffset, source, sourceOffset = 0, count) {
		const n = count === undefined ? source.bytes.length - sourceOffset : count;
		bcheck(source, sourceOffset, n);
		bcheck(target, targetOffset, n);
		target.bytes.set(source.bytes.subarray(sourceOffset, sourceOffset + n), targetOffset);
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

const AP = Array.prototype;
const shim = (name, fn) => Object.defineProperty(AP, name, { value: fn, configurable: true, writable: true });
shim("size", function () {
	return this.length;
});
shim("remove", function (i) {
	return this.splice(i, 1)[0];
});
shim("clear", function () {
	this.length = 0;
});
const jsSort = AP.sort;
shim("sort", function (cmp) {
	if (!cmp) return jsSort.call(this);
	// roblox-ts comparators return a boolean ("a before b")
	return jsSort.call(this, (a, b) => {
		const r = cmp(a, b);
		if (typeof r !== "boolean") return r;
		return r ? -1 : cmp(b, a) ? 1 : 0;
	});
});
Object.defineProperty(String.prototype, "size", {
	value: function () {
		return Buffer.byteLength(this.valueOf(), "utf8");
	},
	configurable: true,
	writable: true,
});
// roblox-ts Map/Set expose size() as a method (client/net/snapshotBuffer.ts counts its tombs and pending deaths with
// it every frame); keep the native count behind it
for (const C of [Map, Set]) {
	const nativeSize = Object.getOwnPropertyDescriptor(C.prototype, "size").get;
	Object.defineProperty(C.prototype, "size", {
		value: function () {
			return nativeSize.call(this);
		},
		configurable: true,
		writable: true,
	});
}

// "shared/x" / "client/x" / "server/x" → SRC/x.ts, transpiled with the project's TypeScript
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

const W = require(join(SRC, "shared/game/world.ts"));
const physics = require(join(SRC, "shared/game/physics.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const Ply = require(join(SRC, "shared/game/player.ts"));
const { applyPlayerDamage, createPlayer } = Ply;
const VIT = require(join(SRC, "shared/sim/vitals.ts"));
const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
const { stepPlayer } = require(join(SRC, "shared/sim/playerMove.ts"));
const SIM = require(join(SRC, "shared/sim/types.ts"));
const codec = require(join(SRC, "shared/net/codec.ts"));
const P = require(join(SRC, "shared/net/protocol.ts"));
const CFG = require(join(SRC, "shared/net/mpConfig.ts"));
const PL = require(join(SRC, "server/sim/players.ts"));
const REP = require(join(SRC, "server/net/replication.ts"));
const { HIT_ALARM } = require(join(SRC, "client/ui/hitAlarm.ts"));
const { ClockSync } = require(join(SRC, "client/net/clockSync.ts"));
const { CommandStream, MAX_PENDING } = require(join(SRC, "client/net/commands.ts"));
const PR = require(join(SRC, "client/net/prediction.ts"));
const { Prediction, CORRECTION_DIST } = PR;
const { SnapshotBuffer } = require(join(SRC, "client/net/snapshotBuffer.ts"));

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const numArg = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};
const SEED = numArg("--seed", 1);
const SECONDS = numArg("--seconds", 20);
const LOSS = numArg("--loss", 0.02);

/** §12.2: the divergence between predicted and authoritative, 99th percentile */
const P99_LIMIT = 1;
/** a step backwards this big in an interpolated ally is a visible rubber band, whatever caused it */
const BACKWARD_LIMIT = 1;
/** and at most this fraction of frames may step back at all (extrapolation after 2+ lost packets in a row) */
const BACKWARD_RATE = 0.005;
/** how far an ally has to walk for "the interpolation moves forward" to mean anything */
const MIN_TRAVEL = 400;
/**
 * One tick of movement at full speed (about 210 u/s at 60 Hz): the smallest divergence a command the server never
 * simulates (all its copies lost, or dropped at the queue's ceiling) can leave behind.
 */
const ONE_TICK_U = 4;
/** above this loss the knockback scenario only reports: the pile-up it causes is the link's, not the client's */
const STRICT_LOSS = 0.03;
/** the unacked queue should sit at one RTT of commands; this is the slack on top of it */
const PENDING_SLACK = 24;
/** the client's clock runs this much fast, so the ±2 % sampling dilation has something to correct */
const CLIENT_CLOCK_SKEW = 1.003;
/** GetServerTimeNow() is a sampled clock: ± this many seconds of noise on every read (§4.6) */
const CLOCK_NOISE_S = 0.002;
/** simulation time of tick 0 */
const T0 = 1000;
/** the local survivor's walk is steered towards a waypoint this often (seconds) */
const TURN_EVERY_S = 1.7;
/**
 * One-way jitter of the three RTT scenarios: a fraction of the RTT, capped.
 *
 * The cap is not cosmetic. The server's input queue is INPUT_BUFFER_TARGET = 2 commands deep, i.e. 33 ms, so
 * one-way jitter above about 16 ms makes the gap between two arrivals longer than the queue can cover; the queue
 * empties and the tick WAITS (2.2): the survivor stands still for that tick in everyone else's world, the command
 * is simulated one tick later, and the queue is one tick deeper until the dilation drains it -- a server-side
 * buffering question, not a prediction one. The [jitter] scenario below covers it on purpose.
 */
const JITTER_FRACTION = 0.15;
/** 2 x 15 ms still fits inside the 33 ms the depth-2 input queue holds */
const JITTER_CAP_S = 0.015;

const SIM_HZ = CFG.SIM_HZ;
const TICK = CFG.TICK_DT;
const SNAP_EVERY = CFG.SNAP_NEAR_EVERY_TICKS;

let failures = 0;
const fail = msg => {
	failures++;
	console.log(`  FAIL  ${msg}`);
};
const ok = msg => console.log(`  ok    ${msg}`);

/** deterministic PRNG (mulberry32) — nothing in the test may depend on Math.random */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---------------------------------------------------------------- the link (§1.1: unreliable, unordered)

/**
 * One direction of the connection. A packet is delayed by half the RTT plus jitter, dropped with probability
 * `loss`, optionally duplicated, and delivered in the order its arrival time elapses — which, with jitter, is
 * genuinely out of order. `blackout` is a window during which nothing at all gets through.
 */
class Link {
	constructor(opts) {
		this.oneWay = opts.rtt / 2;
		this.jitter = opts.jitter ?? 0;
		this.name = opts.name ?? "link";
		this.loss = opts.loss ?? 0;
		this.dup = opts.dup ?? 0;
		this.blackout = opts.blackout; // { from, to } in simulation seconds
		this.random = opts.random;
		this.queue = [];
		this.sent = 0;
		this.dropped = 0;
		this.duplicated = 0;
		this.reordered = 0;
		this.order = 0;
		this.lastDelivered = -1;
	}

	send(now, payload) {
		this.sent += 1;
		if (this.blackout !== undefined && now >= this.blackout.from && now < this.blackout.to) {
			this.dropped += 1;
			return;
		}
		if (this.random() < this.loss) {
			this.dropped += 1;
			return;
		}
		this.push(now, payload);
		if (this.random() < this.dup) {
			this.duplicated += 1;
			this.push(now, payload);
		}
	}

	push(now, payload, at = now + this.oneWay + (this.random() - 0.5) * 2 * this.jitter) {
		this.queue.push({ at, payload, order: this.order++ });
	}

	/**
	 * The packets of one client frame, which leave in the same instant: each is lost (or duplicated) on its own,
	 * but they share one delay and so keep their order, as a burst does (tools/test-input-buffer.mjs says why).
	 */
	sendBurst(now, payloads) {
		const at = now + this.oneWay + (this.random() - 0.5) * 2 * this.jitter;
		for (const payload of payloads) {
			this.sent += 1;
			if (this.blackout !== undefined && now >= this.blackout.from && now < this.blackout.to) {
				this.dropped += 1;
				continue;
			}
			if (this.random() < this.loss) {
				this.dropped += 1;
				continue;
			}
			this.push(now, payload, at);
			if (this.random() < this.dup) {
				this.duplicated += 1;
				this.push(now, payload, at);
			}
		}
	}

	/** everything that has arrived by `now`, in arrival order (jitter is what makes that differ from send order) */
	poll(now) {
		const out = [];
		let i = 0;
		while (i < this.queue.length) {
			if (this.queue[i].at <= now) out.push(this.queue.splice(i, 1)[0]);
			else i++;
		}
		out.sort((a, b) => a.at - b.at);
		const payloads = [];
		for (const item of out) {
			// out of order = it left after something that has already been delivered, and arrives behind it
			if (item.order < this.lastDelivered) this.reordered += 1;
			else this.lastDelivered = item.order;
			payloads.push(item.payload);
		}
		return payloads;
	}
}

// ---------------------------------------------------------------- the world and the two survivors

/** the town, plus a long clear stretch of road an ally can walk down in a straight line */
function buildScene(seed) {
	const world = W.generateTown(seed);
	const clear = (x, y) => physics.circleBlocked(world, x, y, physics.PLAYER_RADIUS + 6) === undefined;
	let lane;
	for (const road of world.roads) {
		if (road.vertical || road.w < 1400) continue;
		const y = road.y + road.h * 0.5;
		for (let x = road.x + 120; x < road.x + road.w - 1200; x += 60) {
			let free = true;
			for (let d = 0; d <= 1100 && free; d += 40) free = clear(x + d, y);
			if (free) {
				lane = { x, y };
				break;
			}
		}
		if (lane !== undefined) break;
	}
	if (lane === undefined) throw new Error("no clear stretch of road for the ally to walk down");
	// the local survivor starts a few metres off the same lane, with walls and cars within reach
	let start = { x: lane.x + 40, y: lane.y - 90 };
	if (!clear(start.x, start.y)) start = { x: lane.x + 40, y: lane.y };
	return { world, lane, start };
}

// ---------------------------------------------------------------- the server (§2.2 input queue, §3.1 tick)

/** the server's own survivor entity and input queue (server/sim/players.ts), exactly as mpHost creates it */
function makeServerPlayer(slot, x, y) {
	return PL.createServerPlayer({ slot, userId: 100 + slot, name: `p${slot}` }, defaultSave(), x, y, 0, SIM_HZ);
}

/** one tick of one survivor: the shared step both sides run, and the feet bookkeeping the snapshot reads */
function serverStep(world, sp, cmd) {
	const res = stepPlayer(world, sp.state, sp.save, cmd, TICK);
	PL.noteStep(sp, cmd, res.walking);
}

/** the only thing the self block asks the simulation (the spawn shield): nobody here just spawned */
const NO_SHIELD = { spawnShielded: () => false };

/** the server's own self block (server/net/replication.ts), not a copy of it: hp, the i-frames and the flags included */
function selfBlockOf(sp) {
	return REP.selfBlockOf(NO_SHIELD, sp);
}

function playerBlockOf(sp) {
	const p = sp.state;
	return {
		slot: sp.slot,
		x: p.x,
		y: p.y,
		aim: p.angle,
		flags: sp.walking ? P.PlayerFlag.Walking : 0,
		weapon: 0,
		swing: 0,
		hp: p.hpMax > 0 ? Math.min(1, Math.max(0, p.hp / p.hpMax)) : 0,
		revive: 0,
		moveAng: sp.moveAng,
	};
}

// ---------------------------------------------------------------- the client (the netClient frame order)

function makeClient(scene) {
	const save = defaultSave();
	const state = createPlayer(save, scene.start.x, scene.start.y);
	const client = {
		world: scene.world,
		save,
		state,
		clock: new ClockSync(),
		commands: new CommandStream(),
		prediction: new Prediction(),
		snapshots: new SnapshotBuffer(),
		queue: [],
		lastSelfTick: -Infinity,
		staleSelf: 0,
		raw: { moveX: 0, moveY: 0, magnitude: 0, aim: 0, held: 0 },
		sampled: [],
		outbound: [],
		malformed: 0,
	};
	client.clock.setEpoch(T0, SIM_HZ);
	client.snapshots.setRate(SIM_HZ);
	client.prediction.attach(scene.world, state, save);
	return client;
}

/** one render frame, in the order client/net/netClient.ts runs it */
function clientFrame(cl, dt, now, down, up, serverNow) {
	for (const payload of down.poll(now)) {
		const part = P.decodeSnapshotPart(payload);
		if (part === undefined) {
			cl.malformed += 1;
			continue;
		}
		cl.queue.push(part);
	}
	const tick = cl.clock.update(dt, serverNow);
	for (const part of cl.queue) {
		const partTick = codec.unwrapTick(part.tick, Math.floor(cl.clock.tickNow()));
		cl.snapshots.receive(part, cl.clock.tickNow(), now);
		const block = part.self;
		if (block === undefined) continue;
		// unordered delivery: a self block from an older tick would rewind the survivor to where the server had
		// them two snapshots ago and replay only what the NEWER ack left unacked (netClient does the same)
		if (partTick <= cl.lastSelfTick) {
			cl.staleSelf += 1;
			continue;
		}
		cl.lastSelfTick = partTick;
		cl.commands.ack(block.ackSeq);
		cl.commands.noteBufDepth(block.bufDepth);
		cl.prediction.reconcile(block, cl.commands.unacked(), now);
	}
	cl.queue.length = 0;

	cl.sampled.length = 0;
	cl.commands.sample(dt, cl.raw, cl.sampled);
	for (const cmd of cl.sampled) {
		cl.prediction.step(cmd);
		cl.onStep?.(cmd);
	}

	cl.snapshots.advance(dt, tick, now, cl.world);

	const render = cl.snapshots.renderNow();
	const viewTick = Math.floor(render);
	const viewFrac = Math.min(255, Math.max(0, Math.floor((render - viewTick) * 256)));
	// one packet per command this frame built (commands.ts `flush`), leaving together
	cl.outbound.length = 0;
	cl.commands.flush(viewTick, viewFrac, now, cl.outbound);
	const burst = [];
	for (const packet of cl.outbound) {
		const payload = P.encodeInput(packet);
		if (payload !== undefined) burst.push(payload);
	}
	if (burst.length > 0) up.sendBurst(now, burst);

	cl.prediction.present(dt, cl.commands.phase(), cl.commands.newest());
}

// ---------------------------------------------------------------- one scenario

/**
 * Runs `SECONDS` (or `opts.seconds`) of a two-player session: the local survivor (predicted, reconciled) and one ally walking down a
 * clear lane (interpolated). Returns everything the assertions need.
 */
function run(opts) {
	const scene = buildScene(opts.seed ?? DESIGN.TOWN_SEED);
	const random = rng(opts.seed ?? SEED);
	// its own stream for the downstream link, so how many Input packets go up can never reshuffle the snapshots
	const randomDown = rng((opts.seed ?? SEED) ^ 0x2545f491);
	const noise = rng((opts.seed ?? SEED) ^ 0x9e3779b9);
	const steer = rng((opts.seed ?? SEED) ^ 0x51ed270b);

	const me = makeServerPlayer(0, scene.start.x, scene.start.y);
	const ally = makeServerPlayer(1, scene.lane.x, scene.lane.y);
	const client = makeClient(scene);
	// VIT-01: both bodies start from the same vitals (a join sends nothing else: the first snapshot is the truth)
	const vit = opts.vitals;
	/** VIT-01, per command seq: the hp the client FIRST drew for it, and the server's once it simulated it */
	const clientFirst = new Map();
	const serverBySeq = new Map();
	if (vit !== undefined) {
		for (const [p, save] of [
			[me.state, me.save],
			[client.state, client.save],
		]) {
			for (const [id, lv] of Object.entries(vit.skills ?? {})) save.skillLevels[Number(id)] = lv;
			p.hp = vit.hp;
			p.hungry = vit.hunger;
		}
		client.onStep = cmd => {
			if (!clientFirst.has(cmd.seq)) clientFirst.set(cmd.seq, client.state.hp);
		};
	}

	const up = new Link({
		name: "up",
		rtt: opts.rtt,
		jitter: opts.upJitter ?? opts.jitter,
		loss: opts.loss,
		random,
		blackout: opts.upBlackout,
	});
	const down = new Link({
		name: "down",
		rtt: opts.rtt,
		jitter: opts.downJitter ?? opts.jitter,
		loss: opts.loss,
		dup: opts.dup,
		random: randomDown,
		blackout: opts.downBlackout,
	});

	const allyStart = ally.state.x;
	const report = {
		scene,
		frames: 0,
		maxPending: 0,
		endPending: 0,
		pendingDuringOutage: 0,
		backwardSteps: 0,
		worstBackward: 0,
		stalledAt: 0,
		beforeStall: undefined,
		afterStall: undefined,
		lateAfterStall: 0,
		consumedAtStall: undefined,
		consumedAfterStall: 0,
		allyTravel: 0,
		allySeen: 0,
		knockbacks: 0,
		/** VIT-01: [wall time, hp] of the server's body after each tick, and of what the client drew each frame */
		serverHp: [],
		clientHp: [],
		hungerGap: 0,
		/** VIT-01: [server time, commands] the server's queue jumped over (every copy of them came too late) */
		skipped: [],
		/** client time of every hit flash the reconciliation started */
		flashAt: [],
		/** the scenario's own bookkeeping (`hurt`) */
		hits: [],
		up,
		down,
		me,
		ally,
		client,
	};

	let now = T0;
	let serverTick = 0;
	let allySeq = 0;
	let lastAllyX = -Infinity;
	let waypointAt = 0;
	let heading = 0;
	const frames = Math.round((opts.seconds ?? SECONDS) / TICK);
	// the last tenth of the run is quiet, so "did the client converge back" is a question about the
	// reconciliation and not about whichever bite happened to land on the final snapshot
	const quietFrom = Math.floor(frames * 0.9);

	// a stall (alt-tab, a long hitch): the wall clock and the server jump forward, and the client's next frame
	// arrives with one huge dt. Nothing else about the run changes.
	const stallFrame = opts.stallS === undefined ? -1 : Math.floor(frames * 0.4);

	for (let frame = 0; frame < frames; frame++) {
		let frameDt = TICK * CLIENT_CLOCK_SKEW;
		if (frame === stallFrame) {
			now += opts.stallS;
			frameDt = opts.stallS;
			report.stalledAt = now;
			report.beforeStall = { x: me.state.x, y: me.state.y };
		}
		now += TICK;

		// ---- server: catch up to the wall clock, one command per player per tick (§3.1)
		const wantTick = Math.floor((now - T0) * SIM_HZ);
		while (serverTick < wantTick) {
			// the live server's C→S path, whole: token bucket, decodeInput, the window, the queue (mpHost.ts)
			for (const payload of up.poll(now)) PL.ingestInput(me, payload, now);
			// the ally is a bot: a perfect 60 Hz stream walking +x, so a step backwards on the client can only
			// ever come from the interpolation itself
			allySeq = (allySeq + 1) % 65536;
			serverStep(scene.world, ally, SIM.makeCommand(allySeq, 1, 0, 1, 0, 0, 0));
			const ackBefore = me.ackSeq;
			serverStep(scene.world, me, PL.takeCommand(me));
			// a command the queue jumped over (every copy of it came too late): the body ran one step fewer for it
			const jump = (me.ackSeq - ackBefore + 65536) % 65536;
			if (me.counters.consumed > 1 && jump > 1 && jump < 1000)
				report.skipped.push([T0 + serverTick / SIM_HZ, jump - 1]);
			// the horde's half of the tick (§3.1): whatever the scenario lands on the survivor, through the server's
			// own entry point (`applyPlayerDamage`, what ServerCombat.damageActor calls)
			opts.hurt?.(me, serverTick, report);
			const biting = opts.knockbackEvery !== undefined && serverTick > 0 && serverTick < quietFrom;
			if (biting && serverTick % opts.knockbackEvery === 0) {
				// a bite the client cannot possibly have predicted: it only learns about it from the snapshot
				me.state.reactionSpeed = 8;
				me.state.reactionDir = (serverTick % 7) * 0.9;
				report.knockbacks += 1;
			}
			if (vit !== undefined) {
				// the body after the whole tick (the scenario's `hurt` included)
				const t = serverTick / SIM_HZ;
				report.serverHp.push([T0 + t, me.state.hp]);
				// the tick that CONSUMED a command (a filled tick repeats the ack: the first one is that command's)
				if (!serverBySeq.has(me.ackSeq)) serverBySeq.set(me.ackSeq, { hp: me.state.hp, t: T0 + t });
			}
			serverTick += 1;
			if (serverTick % SNAP_EVERY === 0) {
				const snap = {
					tick: serverTick,
					self: selfBlockOf(me),
					players: [playerBlockOf(ally)],
					zombies: [],
					bosses: [],
				};
				opts.onSnap?.(snap.self, serverTick, report);
				const res = P.encodeSnapshot(snap);
				for (const part of res.parts) down.send(now, part);
			}
		}

		// ---- client: a fresh waypoint now and then, so the run is not a straight line
		if (now - waypointAt >= TURN_EVERY_S) {
			waypointAt = now;
			heading = steer() * Math.PI * 2;
		}
		const moving = frame % 53 !== 0; // a few idle frames
		client.raw.moveX = moving ? Math.cos(heading) : 0;
		client.raw.moveY = moving ? Math.sin(heading) : 0;
		client.raw.magnitude = moving ? 1 : 0;
		client.raw.aim = heading + 0.3;
		const serverNow = now + (noise() - 0.5) * 2 * CLOCK_NOISE_S;
		const flashBefore = client.state.hitFlash ?? 0;
		clientFrame(client, frameDt, now, down, up, serverNow);
		// the hit flash went UP this frame: the reconciliation lit it (nothing else on this client can); then it fades
		// the way client/systems/combat.ts fades it, once a frame, after netUpdate
		if ((client.state.hitFlash ?? 0) > flashBefore) report.flashAt.push(now);
		client.state.hitFlash = Math.max(0, (client.state.hitFlash ?? 0) - frameDt);
		if (vit !== undefined) {
			report.clientHp.push([now, client.state.hp]);
			if (now - T0 > 2)
				report.hungerGap = Math.max(report.hungerGap, Math.abs(client.state.hungry - me.state.hungry));
		}
		if (report.stalledAt > 0 && report.consumedAtStall === undefined) report.consumedAtStall = me.counters.consumed;
		if (report.stalledAt > 0 && now >= report.stalledAt + 1 && report.afterStall === undefined) {
			report.afterStall = { x: me.state.x, y: me.state.y };
			report.lateAfterStall = me.counters.late;
			report.consumedAfterStall = me.counters.consumed - report.consumedAtStall;
		}

		// ---- measurements
		report.frames += 1;
		const pending = client.commands.stats().pending;
		report.maxPending = Math.max(report.maxPending, pending);
		report.endPending = pending;
		const outage = opts.downBlackout ?? opts.upBlackout;
		if (outage !== undefined && now >= outage.from && now < outage.to) {
			report.pendingDuringOutage = Math.max(report.pendingDuringOutage, pending);
		}
		for (const remote of client.snapshots.states()) {
			if (remote.slot !== 1) continue;
			report.allySeen += 1;
			if (lastAllyX > -Infinity) {
				const step = remote.x - lastAllyX;
				if (step < 0) {
					report.backwardSteps += 1;
					report.worstBackward = Math.max(report.worstBackward, -step);
				}
			}
			lastAllyX = remote.x;
		}
	}

	report.allyTravel = ally.state.x - allyStart;
	report.clientFirst = clientFirst;
	report.serverBySeq = serverBySeq;
	report.predictionStats = client.prediction.stats(now);
	report.commandStats = client.commands.stats();
	report.interpDelay = client.snapshots.delay();
	report.serverTick = serverTick;
	return report;
}

function pct(n, d) {
	return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—";
}

// ---------------------------------------------------------------- run

const started = Date.now();
console.log(
	`[test-predict] ${SECONDS}s per scenario · seed ${SEED} · ${(LOSS * 100).toFixed(1)}% loss · ` +
		`${SIM_HZ} Hz sim, snapshots every ${SNAP_EVERY} ticks`,
);

// ---- (1)(2)(3)(4) the three round trips of §11.3 F1 / §1.1 ("most players have 100–300 ms")
for (const rtt of [0.05, 0.1, 0.2]) {
	const jitter = Math.min(rtt * JITTER_FRACTION, JITTER_CAP_S);
	console.log(`\n[rtt ${Math.round(rtt * 1000)} ms] jitter ±${Math.round(jitter * 1000)} ms, loss ${pct(LOSS, 1)}`);
	const r = run({ rtt, jitter, loss: LOSS, seed: SEED });
	const p = r.predictionStats;
	console.log(
		`  ${r.frames} frames · ${r.serverTick} server ticks · ${r.up.sent} input packets ` +
			`(${r.up.dropped} lost) · ${r.down.sent} snapshot parts (${r.down.dropped} lost, ` +
			`${r.down.reordered} out of order) · filled ticks ${r.me.counters.filled} · ` +
			`late/dup/overflow ${r.me.counters.late}/${r.me.counters.duplicate}/${r.me.counters.inputOverflow} · ` +
			`interp delay ${(r.interpDelay * 1000).toFixed(0)} ms`,
	);

	if (p.samples < 10) fail(`only ${p.samples} divergence samples: the session never really started`);
	else if (p.p99 < P99_LIMIT)
		ok(`divergence p50 ${p.p50.toFixed(4)} u, p99 ${p.p99.toFixed(4)} u (< ${P99_LIMIT} u)`);
	else
		fail(`divergence p99 ${p.p99.toFixed(3)} u ≥ ${P99_LIMIT} u (p50 ${p.p50.toFixed(3)} u, ${p.samples} samples)`);

	if (p.corrections === 0) ok(`no correction above ${CORRECTION_DIST} u (${p.replays} rewinds, ${p.snaps} snaps)`);
	else fail(`${p.corrections} correction(s) above ${CORRECTION_DIST} u in normal conditions`);

	// the unacked queue is one RTT of commands plus the snapshot interval: bounded, and not growing
	const bound = Math.ceil(rtt * SIM_HZ) + PENDING_SLACK;
	if (r.maxPending <= bound && r.endPending <= bound) {
		ok(`unacked queue peaked at ${r.maxPending} commands (≤ ${bound}), ended at ${r.endPending}`);
	} else {
		fail(`unacked queue peaked at ${r.maxPending} / ended at ${r.endPending} commands (bound ${bound})`);
	}

	if (r.allyTravel < MIN_TRAVEL) {
		fail(`the ally only walked ${r.allyTravel.toFixed(0)} u: the monotonicity check would prove nothing`);
	} else if (r.backwardSteps === 0) {
		ok(`ally interpolation never stepped back over ${r.allySeen} frames (${r.allyTravel.toFixed(0)} u walked)`);
	} else {
		fail(`ally interpolation stepped back ${r.backwardSteps}× (worst ${r.worstBackward.toFixed(3)} u)`);
	}

	// nothing hurt the survivor, so nothing may light the hit flash (regeneration, a replay, the hunger's u8)
	if (r.flashAt.length === 0 && p.flashes === 0) ok(`no hit, no hit flash`);
	else fail(`${r.flashAt.length} hit flash(es) without a hit (the prediction counted ${p.flashes})`);
}

// ---- (3) the adversarial link: heavy reordering and duplicates on top of the loss
console.log(
	`\n[adversarial] 100 ms RTT, ±45 ms jitter downstream, ${pct(LOSS, 1)} loss, 20% duplicated snapshot parts`,
);
{
	const r = run({ rtt: 0.1, upJitter: 0.008, downJitter: 0.045, loss: LOSS, dup: 0.2, seed: SEED + 11 });
	console.log(
		`  ${r.down.sent} parts sent · ${r.down.duplicated} duplicated · ${r.down.reordered} delivered out of ` +
			`order · ${r.down.dropped} lost · ally walked ${r.allyTravel.toFixed(0)} u`,
	);
	if (r.down.reordered < 10) fail(`only ${r.down.reordered} out-of-order deliveries: the link was too kind`);
	if (r.down.duplicated < 10) fail(`only ${r.down.duplicated} duplicates: the link was too kind`);
	const rate = r.allySeen > 0 ? r.backwardSteps / r.allySeen : 1;
	if (r.backwardSteps === 0) {
		ok(`ally interpolation never stepped back, with duplicates and reordering`);
	} else if (r.worstBackward <= BACKWARD_LIMIT && rate <= BACKWARD_RATE) {
		ok(
			`ally interpolation stepped back ${r.backwardSteps}/${r.allySeen} frames ` +
				`(${pct(r.backwardSteps, r.allySeen)}, worst ${r.worstBackward.toFixed(3)} u) — inside the ` +
				`extrapolation budget`,
		);
	} else {
		fail(
			`ally interpolation stepped back ${r.backwardSteps}/${r.allySeen} frames ` +
				`(${pct(r.backwardSteps, r.allySeen)}, worst ${r.worstBackward.toFixed(3)} u)`,
		);
	}
	const p = r.predictionStats;
	if (p.p99 < P99_LIMIT) ok(`divergence p99 ${p.p99.toFixed(4)} u under reordering and duplicates`);
	else fail(`divergence p99 ${p.p99.toFixed(3)} u ≥ ${P99_LIMIT} u under reordering and duplicates`);
}

// ---- (4) no snapshot reaches the client at all: no acks, so the unacked queue is on its own
//
// This is the direction that can actually run away. Downstream nothing acks anything, so the queue grows at 60/s
// until MAX_PENDING caps it - which is exactly the bound being tested. (An upstream outage also acks nothing, as a
// waiting tick consumes no command, but the snapshots keep coming and drain the queue the moment the stream lands.)
const OUTAGE_S = 4;
console.log(`
[blackout] 100 ms RTT, no snapshot reaches the client for ${OUTAGE_S} s (no acks at all)`);
{
	const from = T0 + Math.max(2, SECONDS * 0.3);
	const r = run({ rtt: 0.1, jitter: 0.01, loss: LOSS, seed: SEED + 23, downBlackout: { from, to: from + OUTAGE_S } });
	console.log(
		`  ${r.down.sent} snapshot parts, ${r.down.dropped} of them into the void, filled ticks ` +
			`${r.me.counters.filled}, unacked peak during the outage ${r.pendingDuringOutage}`,
	);
	const grew = Math.min(MAX_PENDING, Math.floor(OUTAGE_S * SIM_HZ * 0.6));
	if (r.pendingDuringOutage < grew) {
		fail(`the outage only backed up ${r.pendingDuringOutage} commands (expected >= ${grew}): it never bit`);
	} else if (r.maxPending <= MAX_PENDING) {
		ok(`unacked queue capped at ${r.maxPending} commands (ceiling ${MAX_PENDING}) through a ${OUTAGE_S} s outage`);
	} else {
		fail(`unacked queue reached ${r.maxPending} commands, past the ${MAX_PENDING} ceiling`);
	}
	const settled = Math.ceil(0.1 * SIM_HZ) + PENDING_SLACK;
	if (r.endPending <= settled) ok(`and came back down to ${r.endPending} commands afterwards (<= ${settled})`);
	else fail(`the queue stayed at ${r.endPending} commands after the outage (expected <= ${settled})`);
}

// ---- jitter past what the server's input queue can hold: the waits are the server's, the recovery is ours
//
// 35 ms of one-way jitter against a 33 ms queue: the queue empties and the tick waits. A wait costs no command
// (it is simulated a tick later) and leaves the queue a tick deeper, so the waits thin out as the queue settles
// deeper -- against the old model of a server whose every fill discarded the predicted command, the same link
// starved 148 ticks, the real server a couple of dozen. What still diverges is a command whose three copies all
// arrived after a newer one was simulated (35 ms of jitter reorders packets two frames apart). That is not the
// prediction's to avoid, so this scenario does NOT assert the 1 u p99 - it asserts the client notices, corrects,
// and converges back without teleporting.
console.log(`
[jitter] 100 ms RTT with +/-35 ms one-way jitter: past the depth-2 input queue`);
{
	const r = run({ rtt: 0.1, jitter: 0.035, loss: LOSS, seed: SEED + 41 });
	const p = r.predictionStats;
	console.log(
		`  filled ticks ${r.me.counters.filled}/${r.serverTick}, ${p.replays} rewinds, ` +
			`divergence p50 ${p.p50.toFixed(3)} u / p99 ${p.p99.toFixed(3)} u`,
	);
	// the scenario has to bite to prove anything: some ticks must have found the queue dry
	if (r.me.counters.filled < 5) fail(`only ${r.me.counters.filled} filled ticks: the jitter never starved anything`);
	else ok(`${r.me.counters.filled} ticks found the queue dry and waited, as the depth-2 buffer predicts`);
	if (p.corrections === 0) ok(`and the client still never needed a correction above ${CORRECTION_DIST} u`);
	else fail(`${p.corrections} correction(s) above ${CORRECTION_DIST} u from the jitter alone`);
	if (p.last < P99_LIMIT) ok(`the client ends within ${p.last.toFixed(3)} u of the server`);
	else fail(`the client ends ${p.last.toFixed(3)} u away from the server`);
}

// ---- a stall: the client is away for 600 ms and the server waits through every tick it missed
//
// This is the liveness case of 2.2. The client drops the backlog it could never send -- its TIME, not its numbers
// (commands.ts `dropBacklog`) -- and the server WAITED through the stall without spending a number, so the next
// command is simply the next one: no jump, nothing late, nothing outside the window, no re-anchor. (The rule
// before this advanced the client's seq by the dropped count to chase a server that spent a number per filled
// tick; the model of that server lived here, and it is gone -- this runs server/sim/players.ts.)
const STALL_S = 0.6;
console.log(`
[stall] 100 ms RTT, the client is away for ${STALL_S * 1000} ms`);
{
	const r = run({ rtt: 0.1, jitter: 0.01, loss: LOSS, seed: SEED + 53, stallS: STALL_S });
	const c = r.client.commands.stats();
	const k = r.me.counters;
	const moved =
		r.afterStall === undefined || r.beforeStall === undefined
			? 0
			: Math.hypot(r.afterStall.x - r.beforeStall.x, r.afterStall.y - r.beforeStall.y);
	console.log(
		`  ${c.stalls} stall(s), ${c.stallDropped} command intervals dropped, ${k.filled} filled ticks, ` +
			`${k.late} late copies refused, ${k.seqWindow} outside the window, ${k.resync} re-anchors, ` +
			`${r.consumedAfterStall} commands simulated and ${moved.toFixed(0)} u walked in the second after`,
	);
	// liveness is the server SIMULATING the stream again, one command a tick; how far that walks depends on the
	// walls the random waypoints steer into, so the distance is reported, not judged
	const live = Math.floor(0.9 * SIM_HZ);
	if (c.stalls < 1) fail(`the stall never reached the command stream (${c.stallDropped} dropped)`);
	else if (r.consumedAfterStall >= live)
		ok(`the stream carried on: ${r.consumedAfterStall} commands simulated in the second after the stall`);
	else fail(`only ${r.consumedAfterStall} commands simulated in the second after the stall (>= ${live} expected)`);
	if (k.seqWindow === 0 && k.resync === 0) ok(`without leaving the sequence window or re-anchoring it`);
	else fail(`the stall pushed ${k.seqWindow} commands outside the window and re-anchored ${k.resync} times`);
	const p = r.predictionStats;
	if (p.last <= ONE_TICK_U) ok(`and the prediction is back within ${p.last.toFixed(3)} u of the server`);
	else fail(`the prediction is ${p.last.toFixed(3)} u away from the server after the stall`);
}

// ---- knockback: the one divergence the client cannot predict (§2.2 "fontes de divergência")
console.log(`\n[knockback] 200 ms RTT, a bite every 0.5 s — the correction the client cannot predict`);
{
	const r = run({ rtt: 0.2, jitter: 0.03, loss: LOSS, seed: SEED + 31, knockbackEvery: 30 });
	const p = r.predictionStats;
	console.log(
		`  ${r.knockbacks} knockbacks · divergence p50 ${p.p50.toFixed(3)} u, p99 ${p.p99.toFixed(3)} u · ` +
			`${p.corrections} correction(s) above ${CORRECTION_DIST} u · ${p.snaps} visual snap(s)`,
	);
	// this is the documented exception to (2): the peak is measured, not required to be zero. What must hold is
	// that the client is in sync BETWEEN bites, back on the server's position once they stop, and never teleports.
	if (p.p50 < P99_LIMIT) ok(`the median divergence stays at ${p.p50.toFixed(3)} u between bites`);
	else fail(`the median divergence is ${p.p50.toFixed(3)} u: the client is not tracking the server at all`);
	// one filled slot may still sit on the very last snapshot: that is the server starving its queue, not the
	// prediction drifting, and it is exactly one tick of movement wide
	if (p.last <= ONE_TICK_U) {
		ok(`the client is back within ${p.last.toFixed(3)} u of the server once the bites stop (<= ${ONE_TICK_U} u)`);
	} else {
		fail(`the client is still ${p.last.toFixed(3)} u away from the server after the bites stopped`);
	}
	if (p.snaps === 0) ok(`the visual offset was always eased, never snapped (< ${CFG.VISUAL_SNAP_DIST} u)`);
	else if (LOSS > STRICT_LOSS) console.log(`  note  ${p.snaps} visual snap(s) at ${pct(LOSS, 1)} loss (reported)`);
	else fail(`${p.snaps} visual snap(s): a correction above ${CFG.VISUAL_SNAP_DIST} u had to teleport the survivor`);
}

// ---- dead: the prediction goes nowhere, exactly like the server's body (shared/sim/playerMove.ts)
//
// The server consumes a dead survivor's commands and moves nothing (security review, Sep 2026: a corpse walked,
// invulnerable, scouting for its team). The prediction runs the same `stepPlayer`, so it must stop with it — or
// the client would draw its own corpse strolling off and be yanked back by every snapshot.
console.log(`\n[dead] a dead survivor's prediction stands still, like the server's body`);
{
	const scene = buildScene(SEED);
	const save = defaultSave();
	const p = createPlayer(save, scene.lane.x, scene.lane.y);
	const prediction = new Prediction();
	prediction.attach(scene.world, p, save);
	for (let s = 1; s <= 30; s++) prediction.step(SIM.makeCommand(s, 1, 0, 1, 0, 0, 0));
	const walked = prediction.exact().x - scene.lane.x;
	if (walked > 20) ok(`alive, 30 commands down the clear lane walk ${walked.toFixed(1)} u`);
	else fail(`alive, the prediction only walked ${walked.toFixed(1)} u down a clear lane`);
	p.dead = true;
	const at = prediction.exact();
	for (let s = 31; s <= 150; s++) prediction.step(SIM.makeCommand(s, 1, 0, 1, 0.3 * s, 0, 0));
	const after = prediction.exact();
	const moved = Math.hypot(after.x - at.x, after.y - at.y);
	if (moved === 0) ok("dead, 120 more commands move the predicted body by 0 u");
	else fail(`dead, the predicted body still walked ${moved.toFixed(2)} u`);
	// the render lead (§5.2: up to one tick of the live input drawn ahead) must not slide the corpse either
	prediction.present(1 / 60, 0.9, SIM.makeCommand(151, 1, 0, 1, 0, 0, 0));
	const drawn = Math.hypot(p.x - after.x, p.y - after.y);
	if (drawn === 0) ok("…and the render lead draws it where it lies");
	else fail(`the render lead draws the corpse ${drawn.toFixed(2)} u ahead of where it lies`);
}

// ---- the hit flash: from F2 the server lands every hit, and the client reads it back from the self block
//
// `applyPlayerDamage` is what sets `hitFlash` -- the HUD's damage vignette, the HP bar's relief and the survivor's
// sprite all read it -- and from MP_PHASE 2 it runs on the server alone. Before the fix the local survivor's flash
// never fired in a server session. The block already says a hit landed, twice: the i-frame timer restarts, and HP
// falls faster than the slow drains can take it. At most one new flash every HIT_ALARM.GAP_S (< 3/s, WCAG 2.3.1).

/** the last server tick of a snapshot interval, near `s` seconds in: whatever lands on it is in the very next block */
const tickBefore = s => Math.floor((s * SIM_HZ) / SNAP_EVERY) * SNAP_EVERY + SNAP_EVERY - 1;
/** the steel armour (shared/data/equips.ts): def 6, so a 5-point bite is absorbed whole */
const STEEL = 4;
/** one render frame, at the skewed clock the harness runs */
const FRAME_S = TICK * CLIENT_CLOCK_SKEW;
const flashesIn = (r, from, to) => r.flashAt.filter(t => t >= from && t <= to);
/** the shortest time between two flashes the reconciliation started */
function minFlashGap(r) {
	let gap = Infinity;
	for (let i = 1; i < r.flashAt.length; i++) gap = Math.min(gap, r.flashAt[i] - r.flashAt[i - 1]);
	return gap;
}
/** the most flashes started inside any one second */
function flashesPerSecond(r) {
	let most = 0;
	for (const t of r.flashAt) most = Math.max(most, flashesIn(r, t, t + 1 - 1e-9).length);
	return most;
}

console.log(
	`\n[hit flash] 100 ms RTT, a clean link: every kind of hit the server lands lights the local survivor's flash`,
);
{
	const RTT = 0.1;
	/** a block leaves on the tick after the hit, flies RTT/2 and waits for the next client frame */
	const LATENCY = RTT / 2 + SNAP_EVERY / SIM_HZ + 2 * FRAME_S;
	const plan = {
		// a bite: the i-frames start
		bite: tickBefore(2),
		// an explosion 0,45 s later, INSIDE those i-frames (bypassDef): they do not restart, only HP says it
		blast: tickBefore(2) + 27,
		// a bite the steel armour absorbs whole: HP does not move, the i-frames do (the local path flashed for it too)
		armour: tickBefore(4),
		// a bite, and another the very tick its i-frames run out: no block ever sees the Hit bit clear in between
		first: tickBefore(6),
		// a body that keeps touching (bypassDef, 2 HP every snapshot interval) for a whole second
		burstFrom: tickBefore(12),
		burstTo: tickBefore(13),
	};
	let rebite = false;
	let firstAt = -1;
	let hitClearBetween = 0;
	const r = run({
		// the plan above runs to 13 s, and the last tenth of a run is quiet
		seconds: Math.max(SECONDS, 16),
		rtt: RTT,
		jitter: 0,
		loss: 0,
		seed: SEED + 61,
		hurt(me, t, report) {
			const hit = (kind, raw, bypass) => {
				const before = me.state.hp;
				const during = me.state.attacked;
				const landed = applyPlayerDamage(me.state, me.save, raw, bypass);
				report.hits.push({
					kind,
					tick: t,
					at: T0 + (t + 1) / SIM_HZ,
					landed,
					during,
					lost: before - me.state.hp,
				});
			};
			if (t === plan.bite) hit("bite", 10, false);
			else if (t === plan.blast) hit("blast", 15, true);
			else if (t === plan.armour) {
				// worn for the bite alone, so the walk the client predicts (armour slows it) stays the server's
				me.save.equipCloth = STEEL;
				hit("armour", 5, false);
				me.save.equipCloth = -1;
			} else if (t === plan.first) {
				hit("first", 10, false);
				rebite = true;
				firstAt = t;
			} else if (rebite && !me.state.attacked) {
				hit("rebite", 10, false);
				rebite = false;
			} else if (t >= plan.burstFrom && t < plan.burstTo && (t - plan.burstFrom) % SNAP_EVERY === 0) {
				hit("burst", 2, true);
			}
		},
		onSnap(self, t) {
			if (firstAt >= 0 && t > firstAt && rebite && (self.flags & P.SelfFlag.Hit) === 0) hitClearBetween += 1;
		},
	});
	const hits = r.hits;
	const singles = hits.filter(h => h.kind !== "burst");
	const burst = hits.filter(h => h.kind === "burst");
	const one = kind => singles.find(h => h.kind === kind);
	console.log(
		`  ${hits.length} hits landed on the server (${singles.map(h => h.kind).join(", ")}, ${burst.length} burst) · ` +
			`${r.flashAt.length} flashes on the client · HP ${r.me.state.hp.toFixed(1)} at the end`,
	);
	const shaped =
		singles.length === 5 &&
		singles.every(h => h.landed) &&
		one("blast")?.during === true &&
		one("armour")?.lost === 0 &&
		one("rebite") !== undefined &&
		one("rebite").tick - one("first").tick <= Math.ceil(DESIGN.IFRAMES * SIM_HZ) + 1 &&
		burst.length >= 15 &&
		r.me.state.hp > 0;
	if (shaped) ok(`the scenario bit: a blast inside the i-frames, a bite absorbed whole, a bite as they ran out`);
	else fail(`the scenario did not happen as planned: ${JSON.stringify(singles)}`);

	for (const h of singles) {
		const lit = flashesIn(r, h.at, h.at + LATENCY);
		const what = {
			bite: "a bite (the i-frames restart)",
			blast: "an explosion inside the i-frames (HP alone says it)",
			armour: "a bite the armour absorbed whole (HP unchanged)",
			first: "a bite",
			rebite: "the bite the tick its i-frames ran out",
		}[h.kind];
		if (lit.length === 1) ok(`${what}: one flash, ${((lit[0] - h.at) * 1000).toFixed(0)} ms after the server tick`);
		else fail(`${what}: ${lit.length} flashes within ${(LATENCY * 1000).toFixed(0)} ms (expected 1)`);
	}
	if (hitClearBetween === 0)
		ok(`no block between those two bites had the Hit bit clear: the bit alone would miss one`);
	else fail(`${hitClearBetween} block(s) saw the Hit bit clear between the two bites: the case never happened`);

	const inBurst = flashesIn(r, burst[0]?.at ?? Infinity, (burst.at(-1)?.at ?? -Infinity) + LATENCY).length;
	const burstS = burst.length > 0 ? burst.at(-1).at - burst[0].at : 0;
	const most = Math.ceil(burstS / HIT_ALARM.GAP_S) + 1;
	if (inBurst >= 2 && inBurst <= most) {
		ok(`a second of contact damage re-lights it ${inBurst}× (≤ ${most}), not once per block`);
	} else fail(`a second of contact damage lit it ${inBurst}× (expected 2..${most})`);

	const stray = r.flashAt.filter(t => !hits.some(h => t >= h.at && t <= h.at + LATENCY));
	if (stray.length === 0) ok(`every flash answers a hit (${r.flashAt.length} flashes, none without one)`);
	else
		fail(
			`${stray.length} flash(es) with no hit behind them, at ${stray.map(t => (t - T0).toFixed(2)).join(", ")} s`,
		);

	// WCAG 2.3.1 fails MORE than three flashes in any one second; one every 0,4 s is 2,5/s, and fits three into the
	// window that opens on one of them (0, 0,4, 0,8 s) -- never four
	const gap = minFlashGap(r);
	const perS = flashesPerSecond(r);
	if (gap >= HIT_ALARM.GAP_S - 1e-9 && perS <= 3) {
		ok(`never two flashes closer than ${gap.toFixed(3)} s, at most ${perS} in any second (WCAG 2.3.1: ≤ 3)`);
	} else
		fail(`two flashes ${gap.toFixed(3)} s apart, ${perS} in one second (the cap is ${HIT_ALARM.GAP_S} s, ≤ 3/s)`);

	if (r.predictionStats.flashes === r.flashAt.length) ok(`the prediction's stats count the same ${r.flashAt.length}`);
	else
		fail(
			`the prediction's stats count ${r.predictionStats.flashes} flashes, the survivor showed ${r.flashAt.length}`,
		);
}

console.log(`\n[slow drains] poisoned and starving for the whole run, through a 4 s snapshot blackout`);
{
	// room for the blackout and for the blocks after it
	const seconds = Math.max(SECONDS, 12);
	const from = T0 + Math.max(2, seconds * 0.3);
	const r = run({
		seconds,
		rtt: 0.1,
		jitter: 0.01,
		loss: LOSS,
		seed: SEED + 67,
		downBlackout: { from, to: from + OUTAGE_S },
		hurt(me, t) {
			if (t !== 0) return;
			me.state.buffs.poison = 1e9;
			me.state.hungry = 0;
		},
	});
	const lost = 100 - r.me.state.hp;
	console.log(
		`  HP ${r.me.state.hp.toFixed(1)} at the end (${lost.toFixed(1)} drained) · ${r.down.dropped} parts lost`,
	);
	// 2,4 HP/s for the whole run: at least half of it
	if (lost < seconds) fail(`only ${lost.toFixed(1)} HP drained: the drains never bit`);
	else if (r.flashAt.length === 0)
		ok(`${lost.toFixed(1)} HP of poison and hunger, not one flash (a drain is not a hit)`);
	else
		fail(
			`${r.flashAt.length} flash(es) from the slow drains, at ${r.flashAt.map(t => (t - T0).toFixed(2)).join(", ")} s`,
		);
}

console.log(`\n[hit flash, lossy] 200 ms RTT, ±30 ms jitter, ${pct(LOSS, 1)} loss: a bite every 2 s`);
{
	const EVERY = 2 * SIM_HZ;
	/** a lost block costs one snapshot interval; allow a few of them in a row */
	const LATENCY = 0.1 + 0.03 + 4 * (SNAP_EVERY / SIM_HZ) + 2 * FRAME_S;
	// enough bites to mean something (one every 2 s, the last tenth quiet)
	const seconds = Math.max(SECONDS, 14);
	const quiet = Math.floor(seconds * SIM_HZ * 0.9);
	const r = run({
		seconds,
		rtt: 0.2,
		jitter: 0.03,
		loss: LOSS,
		seed: SEED + 71,
		hurt(me, t, report) {
			if (t === 0 || t % EVERY !== 0 || t >= quiet || me.state.hp < 20) return;
			if (applyPlayerDamage(me.state, me.save, 6, false))
				report.hits.push({ tick: t, at: T0 + (t + 1) / SIM_HZ });
		},
	});
	const late = [];
	for (const h of r.hits) {
		const lit = flashesIn(r, h.at, h.at + LATENCY);
		if (lit.length !== 1) late.push(`${(h.at - T0).toFixed(2)} s: ${lit.length}`);
	}
	const worst = r.hits.reduce((w, h) => {
		const f = r.flashAt.find(t => t >= h.at);
		return f === undefined ? w : Math.max(w, f - h.at);
	}, 0);
	console.log(
		`  ${r.hits.length} bites · ${r.flashAt.length} flashes · ${r.down.dropped} parts lost, ${r.down.reordered} ` +
			`out of order · slowest flash ${(worst * 1000).toFixed(0)} ms after its bite`,
	);
	if (r.hits.length < 5) fail(`only ${r.hits.length} bites: the scenario never bit`);
	else if (late.length === 0 && r.flashAt.length === r.hits.length) {
		ok(`each of the ${r.hits.length} bites lit exactly one flash, within ${(LATENCY * 1000).toFixed(0)} ms`);
	} else fail(`bites without exactly one flash in time: ${late.join("; ")} (${r.flashAt.length} flashes in all)`);
}

// ---- a new survivor is compared with nothing: attach() forgets the last block, so a lower HP is no hit
console.log(`\n[hit flash, attach] a new body's first block is no hit, whatever the last body's HP was`);
{
	const scene = buildScene(SEED);
	const save = defaultSave();
	const p = createPlayer(save, scene.lane.x, scene.lane.y);
	const prediction = new Prediction();
	prediction.attach(scene.world, p, save);
	const sp = makeServerPlayer(0, scene.lane.x, scene.lane.y);
	const block = () =>
		P.decodeSnapshotPart(
			P.encodeSnapshot({ tick: 3, self: selfBlockOf(sp), players: [], zombies: [], bosses: [] }).parts[0],
		).self;
	prediction.reconcile(block(), [], 1);
	// the next life: another body, much lower (a corpse carried over at 30, MP-21), the next frame
	const p2 = createPlayer(save, scene.lane.x, scene.lane.y);
	prediction.attach(scene.world, p2, save);
	sp.state.hp = 30;
	prediction.reconcile(block(), [], 1.02);
	if ((p2.hitFlash ?? 0) === 0 && prediction.stats().flashes === 0) ok(`100 HP, then a new body at 30: no flash`);
	else fail(`the new body's first block lit the flash (${p2.hitFlash}): it was compared with the old body`);
	// and from there on it is compared as usual
	applyPlayerDamage(sp.state, sp.save, 10, false);
	prediction.reconcile(block(), [], 1.07);
	if (p2.hitFlash === 1) ok(`…and its first bite lights it`);
	else fail(`the new body's first bite did not light the flash (${p2.hitFlash})`);
}

// ---- VIT-01: the HP bar the client draws is the server's -- no healing it has to take back, none held back
//
// The server bites (through `applyPlayerDamage`, as the horde does, in the scenario's `hurt`) and poisons; the wait
// before healing is on nobody's wire: the client derives it from the self block (client/net/prediction.ts). What must
// hold, per COMMAND, is that the hp the client drew first for it is never above what the server then computed for it --
// a drawn hp above the server's is one the next snapshot takes back -- except for a bite it could not know about yet.
// On the screen: the bar never rises in a fight, and never falls while it heals. (The flash those bites light is the
// [hit flash] sections' above.)
console.log(`\n[vitals] VIT-01: the client draws the server's HP -- no healing to take back, none held back`);
{
	/**
	 * The scenario's hits, on the server's tick (`run`'s `hurt`): bites at `biteAt` seconds, a crowd (LEG-04) that
	 * tries every tick of `crowd` and so lands the tick each guard ends, and poison from `poisonAt` for `poisonS`
	 */
	const vitalsHurt = vit => (me, tick, report) => {
		const t = tick / SIM_HZ;
		const crowd = vit.crowd !== undefined && t >= vit.crowd[0] && t < vit.crowd[1];
		if (crowd || vit.biteAt?.some(b => Math.abs(b - t) < TICK / 2)) {
			if (applyPlayerDamage(me.state, me.save, vit.bite ?? 10, false)) report.hits.push({ tick, at: T0 + t });
		}
		if (vit.poisonAt !== undefined && Math.abs(vit.poisonAt - t) < TICK / 2) me.state.buffs.poison = vit.poisonS;
	};
	const OVER_EPS = 0.02;
	const runs = [
		{ label: "a walker's bites, 100 ms RTT", rtt: 0.1, vitals: { hp: 70, hunger: 90, biteAt: [2, 3.4, 4.8, 6.2] } },
		{
			label: "bites then poison, 200 ms RTT ±35 ms (the server fills and skips commands)",
			rtt: 0.2,
			jitter: 0.035,
			vitals: { hp: 70, hunger: 90, biteAt: [2, 3.4, 4.8], poisonAt: 5.5, poisonS: 1.5 },
		},
		{
			label: `healing into the food gate (FOOD ${VIT.REGEN_FOOD_MIN} -> ${VIT.REGEN_FOOD_MIN - 1}), 150 ms RTT`,
			rtt: 0.15,
			vitals: { hp: 40, hunger: VIT.REGEN_FOOD_MIN + 0.4 },
		},
		{
			label: "a crowd biting the tick each guard ends (the Hit flag never drops), 100 ms RTT",
			rtt: 0.1,
			vitals: { hp: 100, hunger: 90, crowd: [2, 5.2] },
		},
		{
			label: "Recovery 3 (6 hp/s) after bites, 150 ms RTT",
			rtt: 0.15,
			vitals: { hp: 30, hunger: 90, biteAt: [2, 3.4], skills: { 1: 3 } },
		},
	];
	for (const v of runs) {
		const jitter = v.jitter ?? Math.min(v.rtt * JITTER_FRACTION, JITTER_CAP_S);
		const vit = v.vitals;
		const r = run({ rtt: v.rtt, jitter, loss: LOSS, seed: SEED + 71, vitals: vit, hurt: vitalsHurt(vit) });
		const bites = r.hits.map(h => h.at);
		// a command the server jumped over (every copy of it came too late) is one step of healing its body never did
		// for that seq: until the next ack the client, which did it, is that far ahead. The only excuse accepted
		const skipStep = VIT.regenRate(r.client.save) * TICK;
		const skippedNear = t => r.skipped.some(([ts]) => t >= ts - TICK && t <= ts + 0.6);
		console.log(
			`  [${v.label}] ${bites.length} hits · filled ticks ${r.me.counters.filled} · ` +
				`commands the server skipped ${r.skipped.reduce((a, [, n]) => a + n, 0)}`,
		);
		const poisonEnd = vit.poisonAt !== undefined ? T0 + vit.poisonAt + vit.poisonS : -Infinity;
		if (vit.crowd !== undefined) {
			const gaps = bites.slice(1).map((b, i) => b - bites[i]);
			const tight = gaps.every(g => g <= DESIGN.IFRAMES + 1.5 * TICK);
			if (bites.length >= 5 && tight) {
				ok(`the crowd landed ${bites.length} bites, each the tick the last one's guard ended`);
			} else fail(`the crowd landed ${bites.length} bites, gaps ${gaps.map(g => g.toFixed(3)).join(", ")} s`);
		}
		const hurtUntil = Math.max(bites.length > 0 ? bites[bites.length - 1] : -Infinity, poisonEnd);
		// a hit the client could not know about yet: for about a round trip it drew the hp from before it
		const unforeseen = t =>
			bites.some(b => t >= b - TICK && t <= b + 0.6) ||
			(vit.poisonAt !== undefined && t >= T0 + vit.poisonAt - TICK && t <= poisonEnd + 0.6);

		// (1) per command: never above the server, outside the hits it could not foresee
		let compared = 0;
		let over = 0;
		let worstOver = 0;
		let skipOver = 0;
		let worstSkip = 0;
		let lastGap = 0;
		for (const [seq, s] of r.serverBySeq) {
			const c = r.clientFirst.get(seq);
			if (c === undefined || s.t - T0 < 1) continue;
			lastGap = c - s.hp;
			if (unforeseen(s.t)) continue;
			compared += 1;
			const e = c - s.hp;
			if (e <= OVER_EPS) continue;
			if (skippedNear(s.t) && e <= 2 * skipStep + OVER_EPS) {
				skipOver += 1;
				worstSkip = Math.max(worstSkip, e);
			} else {
				over += 1;
				worstOver = Math.max(worstOver, e);
			}
		}
		if (compared < 300) fail(`only ${compared} commands compared: the run never got going`);
		else if (over === 0) {
			const skips =
				skipOver > 0
					? ` -- but ${skipOver}, by ${worstSkip.toFixed(3)} at most, right after a command the server skipped`
					: "";
			ok(
				`${compared} commands: the hp the client drew first was never above the server's (by > ${OVER_EPS})${skips}`,
			);
		} else fail(`${over}/${compared} commands drawn above the server's hp (worst +${worstOver.toFixed(3)} hp)`);

		// (2) on the screen: flat through the fight, then only up while it heals
		let fightRises = 0;
		let healDrops = 0;
		let worstDrop = 0;
		let firstRise;
		let learned = bites.length === 0;
		for (let i = 1; i < r.clientHp.length; i++) {
			const [t, hp] = r.clientHp[i];
			const d = hp - r.clientHp[i - 1][1];
			if (!learned && d < -1) learned = true;
			if (learned && t <= hurtUntil + v.rtt + 0.3 && d > 1e-9) fightRises += 1;
			if (t > hurtUntil && firstRise === undefined && d > 1e-9) firstRise = t;
			if (firstRise !== undefined && d < -1e-6) {
				healDrops += 1;
				worstDrop = Math.max(worstDrop, -d);
			}
		}
		if (bites.length > 0) {
			if (fightRises === 0)
				ok("through the fight the bar never rose between hits (the wait, derived client-side)");
			else fail(`the bar rose on ${fightRises} frames in the middle of the fight`);
		}
		if (firstRise === undefined) fail("the client never drew the body healing");
		else if (healDrops === 0) {
			const after = bites.length > 0 ? `, ${(firstRise - hurtUntil).toFixed(2)} s after the last hp lost` : "";
			ok(`once healing, the bar only went up: not one frame pulled back${after}`);
		} else fail(`while healing the bar fell back on ${healDrops} frames (worst ${worstDrop.toFixed(4)} hp)`);

		// (3) and it ends where the server is: at the last command both simulated, and the stomach with it
		if (Math.abs(lastGap) <= 0.2)
			ok(`the last command: client ${lastGap >= 0 ? "+" : ""}${lastGap.toFixed(3)} hp from the server`);
		else fail(`the last command: the client is ${lastGap.toFixed(3)} hp from the server`);
		if (r.hungerGap <= 0.5)
			ok(`the stomach tracks the server within ${r.hungerGap.toFixed(3)} food (a u8 on the wire)`);
		else fail(`the client's stomach wandered ${r.hungerGap.toFixed(3)} food from the server's`);
	}
	// the u8 of hunger: the prediction at the ack is moved as little as the rounding allows, keeping its fraction
	const cases = [
		[40.3, 40, 100, 40.3],
		[40.7, 40, 100, 40.499],
		[39.2, 40, 100, 39.5],
		[20.3, 45, 100, 45.3],
		[90.3, 100, 100, 100],
		[0.8, 0, 100, 0.499],
	];
	const bad = cases.filter(([p, w, m, want]) => Math.abs(PR.hungerAtAck(p, w, m) - want) > 1e-9);
	if (bad.length === 0) {
		ok("the self block's hunger: nudged into its rounding, a meal shifted by whole numbers (the fraction kept)");
	} else
		fail(`hungerAtAck: ${bad.map(([p, w, m, want]) => `${p}/${w} -> ${PR.hungerAtAck(p, w, m)} (want ${want})`)}`);
	const gate = VIT.REGEN_FOOD_MIN - 0.5;
	if (VIT.fedEnough(gate) && !VIT.fedEnough(gate - 0.001))
		ok(`the food gate is the rounding the bar and the wire use: ${gate} reads ${VIT.REGEN_FOOD_MIN}`);
	else fail("the food gate is not the FOOD bar's rounding");
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
if (failures > 0) {
	console.log(`\n[test-predict] ${failures} failure(s) in ${secs}s`);
	process.exit(1);
}
console.log(`\n[test-predict] all checks passed in ${secs}s`);
