#!/usr/bin/env node
/*
 * How often does the server's input queue run DRY? (docs/MULTIPLAYER.md §2.2)
 *
 *   npm run test:input
 *   node tools/test-input-buffer.mjs --seconds 20 --seed 7
 *
 * Why this test exists. A playtest reported an ally hitching "as if he had lag, all the time, naturally, and
 * short -- one step", while the person moving felt perfectly smooth themselves. That asymmetry is the whole
 * clue: whatever it is, the client's own prediction hides it from its owner and shows it to everyone else.
 *
 * server/sim/players.ts documented a decision that had exactly that shape. When the queue was empty the tick
 * was FILLED: the survivor STOOD STILL for that tick, and the real command that was meant for it was discarded
 * as late when it finally landed. The comment said this "costs at most one tick of smoothness on a lost packet,
 * which the client's own prediction hides" -- true for the owner, and only for the owner. For every other
 * player that tick is the body genuinely stopping in the world, and the interpolation reproduces the stop
 * faithfully, because a stop is what the server actually sent.
 *
 * tools/test-server-sim.mjs proved the mechanism worked as designed (its case d). Nobody had asked the question
 * this file asks: with the REAL client sender on one end and the REAL queue on the other, over a link with
 * ordinary jitter, HOW OFTEN does it happen? A fill per minute is a decision. A fill per second is a bug wearing
 * a decision's clothes.
 *
 * So this wires client/net/commands.ts (sampling, the +-2% dilation steered by bufDepth, the 3x redundancy,
 * the token bucket) to server/sim/players.ts (acceptInput, takeCommand, bufferDepth) across a delayed, jittery,
 * lossy link, and counts. Nothing is mocked but the wire and the clock. Every `late` refusal is also sorted into
 * what it threw away -- a redundant COPY of a command already simulated (three copies of everything travel, so
 * most refusals are this, and harmless) or a REAL command that will now never run -- because the raw counter
 * cannot tell them apart and read "1638 refused" where 204 real commands had been lost.
 *
 * WHAT IT FOUND (keep this, it is the reason cases 4-6 exist).
 *
 * On a clean link the queue is healthy: depth sits at ~2.9 against a target of 2 and it never runs dry, even
 * at 120 ms with 25 ms of jitter and 2% loss. A playtest log agreed from the other side -- one prediction
 * correction a MINUTE, zero client drops -- so this was NOT the hitch that playtest reported.
 *
 * What it did find is a lock that only a hitching CLIENT triggers. A long frame makes at most
 * MAX_COMMANDS_PER_FRAME commands, the server queue empties, and the fill that follows ADVANCED THE SEQUENCE:
 * so the real command for that tick landed and was refused as late, the queue stayed empty, the next tick
 * filled again, and the next real command was refused too. In case 4 (one frame in twenty takes 150 ms):
 * 29.8 fills a second, runs of 11 ticks, 13.8 filled ticks per hitch where the hitch itself starves at most 10,
 * and 204 real commands thrown away in 19 s. A hitching SERVER cannot do this: it catches up at most
 * MAX_CATCHUP_TICKS and drops the rest, so a late heartbeat consumes less, never more -- the queue overflows
 * instead, which is the harmless direction.
 *
 * THE FIX (players.ts header, MULTIPLAYER.md §2.2): a filled tick WAITS. It still stands the survivor still, but
 * it spends no sequence number and acknowledges nothing, so the real command is not late when it lands -- it is
 * queued and consumed on the next tick, and each fill buys the queue one tick of depth instead of locking it
 * empty. Case 4 after it: 0 real commands thrown away, the worst stop is 9 ticks (the 150 ms hitch), 8.9 fills
 * per hitch. The lock is gone; cases 4-6 are now guards. What a hitch still costs is the hitch: the client
 * really sent nothing for that long.
 *
 * WHAT IT FOUND NEXT: TAPS (cases 7-11, and a tap on every frame of every case). The server was right; the
 * SENDER lost commands at low frame rates. One packet per frame holds 3 commands, and a 15 FPS frame builds 4:
 * the oldest -- the one carrying the frame's taps -- never went on the wire, and the server jumped over its
 * number. At 15 FPS: 0 of 270 taps reached the simulation, 3 commands in 4 were simulated (17.35 fills/s, 322
 * predicted and never simulated). At 20 FPS the dilation's occasional 4th cost 21 of 360 taps, a lone 70 ms
 * frame lost its taps, and a hitch threw away the commands of the frame that ended it (`skipBacklog` cleared
 * the unacked queue before the send: case 4, 156 predicted and never simulated, 38 of 776 taps). Now one packet
 * goes out per command (commands.ts `flush`), a hitch drops time and not numbers (`dropBacklog`), the frame's
 * taps ride its newest command, and the queue's ceiling carries a dropped command's taps to the new head
 * (players.ts `enqueue`). Every tap of every case lands, exactly once.
 *
 * WHAT IT FOUND LAST: A SERVER THAT CANNOT KEEP UP (cases 12-16, the review of dee095a, B1). dee095a raised the
 * queue's ceiling by one command for every tick the Heartbeat owed, so that the repayment of a hitch finds the commands
 * that landed during it. Below 30 Hz a heartbeat owes more than it may run, the debt sits at its cap for good, and
 * the queues sat as deep as the debt: 352 ms from input to simulation at a 25 Hz heartbeat against 80 ms with the
 * fixed ceiling, 313 against 69 with Studio at 28 fps. Now only a debt that is being REPAID earns grace, at the pace
 * it is repaid (server/sim/heartbeat.ts): 80 and 69 ms, the fixed ceiling's, and cases 5 and 6 keep their gains.
 * `--debt-grace` replays dee095a's rule.
 *
 * Pure Node (>= 18) plus the project TypeScript, same shims as tools/test-smoothness.mjs.
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

let now = 1000;

globalThis.math = {
	floor: Math.floor,
	ceil: Math.ceil,
	abs: Math.abs,
	sqrt: Math.sqrt,
	sin: Math.sin,
	cos: Math.cos,
	atan2: Math.atan2,
	min: Math.min,
	max: Math.max,
	huge: Infinity,
	pi: Math.PI,
	clamp: (v, lo, hi) => Math.min(Math.max(v, lo), hi),
	round: Math.round,
	fmod: (a, b) => a % b,
	random: () => 0.5,
};
globalThis.os = { clock: () => now, time: () => now };
globalThis.typeIs = (v, t) => (t === "number" ? typeof v === "number" : typeof v === t);
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
	Lerp(o, k) {
		return new Color3(this.R + (o.R - this.R) * k, this.G + (o.G - this.G) * k, this.B + (o.B - this.B) * k);
	}
}
globalThis.Color3 = Color3;

// protocol.ts builds a NetWriter at load time, so the Luau `buffer` library has to exist before anything is
// required. This is the STRICT shim of tools/test-server-sim.mjs, copied verbatim: an out-of-bounds or
// out-of-range write throws instead of silently corrupting a neighbouring field.
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

const AP = Array.prototype;
const shim = (name, fn) => Object.defineProperty(AP, name, { value: fn, configurable: true, writable: true });
shim("size", function () {
	return this.length;
});
shim("remove", function (i) {
	return this.splice(i, 1)[0];
});
shim("unorderedRemove", function (i) {
	const v = this[i];
	const last = this.pop();
	if (i < this.length) this[i] = last;
	return v;
});
shim("clear", function () {
	this.length = 0;
});
for (const C of [Map, Set]) {
	const getter = Object.getOwnPropertyDescriptor(C.prototype, "size").get;
	Object.defineProperty(C.prototype, "size", {
		value: function () {
			return getter.call(this);
		},
		configurable: true,
		writable: true,
	});
}
const jsSort = AP.sort;
shim("sort", function (cmp) {
	if (!cmp) return jsSort.call(this);
	return jsSort.call(this, (a, b) => {
		const r = cmp(a, b);
		if (typeof r !== "boolean") return r;
		return r ? -1 : cmp(b, a) ? 1 : 0;
	});
});

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

const { CommandStream } = require(join(SRC, "client/net/commands.ts"));
const PL = require(join(SRC, "server/sim/players.ts"));
const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
const CFG = require(join(SRC, "shared/net/mpConfig.ts"));
const { seqDiff } = require(join(SRC, "shared/net/codec.ts"));
/**
 * The server's Heartbeat rule, the SHIPPED one (ServerSimulation.advance runs exactly this, and mpHost asks it for
 * the queue's grace). This file used to carry its own copy -- "at most MAX_CATCHUP_TICKS, drop the rest" -- and kept
 * it when the server started carrying a debt instead: repaying it ate two commands a heartbeat from a queue capped
 * below what had landed, and nothing here saw it (the review of 2026-09-23 measured case 5 at 0 -> 3.91 waits a
 * second on the server's real rule).
 */
const HEARTBEAT = join(SRC, "server/sim/heartbeat.ts");
if (!existsSync(HEARTBEAT)) {
	console.error(
		"this src has no server/sim/heartbeat.ts (it predates the shipped-rule module): replay an older rule with " +
			"--backlog-ticks N --no-grace instead (0 = 7fb3e89's drop rule, 15 = 097f484's debt)",
	);
	process.exit(2);
}
const { TickAccumulator } = require(HEARTBEAT);

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const num = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};

const SIM_DT = 1 / CFG.SIM_HZ;
/**
 * The server's debt ceiling and the queue's grace, as shipped. `--backlog-ticks 15 --no-grace` replays commit
 * 097f484 (the debt, and the queue still capped at INPUT_BUFFER_MAX: what the review measured); `--backlog-ticks 0
 * --no-grace` replays 7fb3e89 (no debt: every hitch past two ticks dropped); `--debt-grace` replays dee095a (grace
 * for every tick owed, repaid or not: the rule the review of dee095a measured keeping the queues debt-deep, B1).
 */
const BACKLOG_S = args.includes("--backlog-ticks") ? num("--backlog-ticks", 0) * SIM_DT : CFG.MAX_BACKLOG_S;
const RULE = args.includes("--no-grace") ? "fixed" : args.includes("--debt-grace") ? "debt" : "shipped";

/**
 * The queue's grace `sinceBeat` seconds after the last heartbeat, by rule. "shipped" is the server's own
 * (server/sim/heartbeat.ts `grace`: only a debt being repaid, at the pace it is repaid); "fixed" is none at all, the
 * ceiling INPUT_BUFFER_MAX; "debt" is dee095a's -- one command for every tick owed, whether or not the server ever
 * runs it -- kept here only so the slow-server cases can show what it did.
 */
function graceOf(rule, beat, sinceBeat) {
	if (rule === "fixed") return 0;
	if (rule === "debt") {
		const due = Math.floor((beat.owed() + Math.min(sinceBeat, 1)) / SIM_DT + 1e-7) - 1;
		return Math.max(0, Math.min(due, CFG.INPUT_GRACE_MAX));
	}
	return beat.grace(sinceBeat);
}

let failures = 0;
function check(name, ok, detail) {
	const tail = detail === undefined ? "" : "  (" + detail + ")";
	if (ok) console.log("  ok    " + name + tail);
	else {
		console.error("  FALHA " + name + tail);
		failures += 1;
	}
}

let seed = num("--seed", 987654321);
function rand() {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
}

/** all four 2-bit one-shot counters of a command (§2.2 `edges`): attack press, release, E, reload */
const edgeTotal = e => (e & 3) + ((e >> 2) & 3) + ((e >> 4) & 3) + ((e >> 6) & 3);

/** the frame's send step, as netClient.send does it: one packet per command the frame built (commands.ts `flush`) */
const outbound = [];
function sendFrame(client, viewTick, t, deliver) {
	outbound.length = 0;
	client.flush(viewTick, 0, t, outbound);
	for (const pkt of outbound) deliver(pkt);
}

/**
 * One survivor walking, for `seconds`, with the real sender talking to the real queue.
 *
 * Client frames and server heartbeats run on their OWN clocks, the way they do on a real machine. A client
 * frame samples `dt` worth of commands (at most MAX_COMMANDS_PER_FRAME; the surplus is dropped, as
 * commands.ts does) and sends one packet per command it built, each with its two predecessors (`flush`). A server
 * heartbeat first takes every packet that landed, in the order it landed, then runs the fixed ticks it owes -- at
 * most MAX_CATCHUP_TICKS, the rest of the time DROPPED, exactly like ServerSimulation.advance -- and each tick
 * consumes one command or, with the queue dry, waits (a fill). `clientDt(i)` / `serverDt(i)` give the length of
 * frame / heartbeat i, so a hitch on either side is simply a long one. Every SNAP_NEAR_EVERY_TICKS the server
 * answers with the queue depth and the ack, which is what closes the dilation loop.
 *
 * The link: every packet is lost on its own with probability `loss`, and every FRAME's packets are delayed by
 * half the RTT plus one jitter draw -- they leave in the same instant, in one burst, and a burst keeps its order.
 * Drawing the jitter per packet would have the network reorder packets sent in the same microsecond by up to
 * twice the jitter, which is not what a link does to a burst; `burstReorder` does exactly that anyway, as the
 * pessimistic bound (Roblox promises no order for unreliable events at all).
 *
 * With `taps`, every client frame inside the tap window also makes ONE one-shot input (attack press, attack
 * release, E, reload, in turn) through `addEdges`, exactly where netClient.predict makes it: before `sample`.
 * Every command then carries a tap, so any command that never reaches the simulation shows up as taps lost; and
 * the taps are followed through the whole path -- made, packed into a command, put on the wire, consumed by
 * `takeCommand` -- so a loss can be pinned on the stage that caused it.
 */
function run({
	seconds = 20,
	rtt = 0.06,
	jitter = 0.008,
	loss = 0,
	clientDt = () => SIM_DT,
	serverDt = () => SIM_DT,
	taps = false,
	burstReorder = false,
	rule = RULE,
}) {
	const client = new CommandStream();
	client.reset(0);
	const sp = PL.createServerPlayer({ slot: 0, userId: 7, name: "tester" }, defaultSave(), 1000, 1000, 0, CFG.SIM_HZ);

	const up = [];
	const down = [];
	const raw = { moveX: 1, moveY: 0, magnitude: 1, aim: 0, held: 0 };
	const out = [];

	// the first second is the queue filling up and the dilation settling: honest, but not the steady state
	const WARMUP_S = 1;
	// the last half second is still in flight or queued when the run stops: unfinished, not lost
	const TAIL_S = 0.5;
	// taps stop a full second before the end, so every one of them has landed and been consumed by then: a tap
	// still in flight when the run stops would read as lost when it is only unfinished
	const TAP_QUIET_S = 1;
	/** one-shot inputs made by the player (one per frame inside the window) */
	let tapsMade = 0;
	/** ...packed into a command by `build` (a counter holds 0..3 per command, §2.2) */
	let tapsBuilt = 0;
	/** ...carried by a command that went on the wire at least once */
	let tapsSent = 0;
	/** ...in a command `takeCommand` consumed: what the server's simulation actually saw */
	let tapsConsumed = 0;
	/** edges per built seq, and the seqs that left in at least one packet */
	const edgesOf = new Map();
	const sentSeqs = new Set();
	let ticksSteady = 0;
	let fillsSteady = 0;
	let lateSteady = 0;
	let overflowSteady = 0;
	let depthSum = 0;
	let depthMin = 99;
	let worstRun = 0;
	let currentRun = 0;
	let fillEpisodes = 0;
	let droppedTicks = 0;
	let hitches = 0;
	/** counters at the end of the warm-up: late/overflow/seqWindow are counted where a packet LANDS, not per tick */
	let atWarmup;
	/**
	 * Per seq: when the client PREDICTED it (the owner's screen moved), whether it ever reached the server, and
	 * whether the server SIMULATED it. The `late` counter cannot tell a redundant copy of a command already
	 * simulated (the §2.2 redundancy doing its job, three copies of everything) from a real command thrown away;
	 * these sets can.
	 */
	const predictedAt = new Map();
	const arrived = new Set();
	const simulated = new Set();
	/**
	 * Input-to-simulation latency of every command predicted inside the steady window: from the client frame that
	 * built it to the heartbeat whose tick simulated it -- half the RTT, the jitter, and every tick it waited in the
	 * queue. A queue kept deep for nothing shows up here and nowhere else (the review of dee095a, B1).
	 */
	let latencySum = 0;
	let latencyMax = 0;
	let latencyN = 0;
	/** every seq that ever sat in the server's queue: one that left it without being simulated hit the ceiling */
	const queued = new Set();
	/**
	 * Every `late` refusal, sorted by what it threw away: a COPY of a command already simulated (the redundancy
	 * working), a copy of a command the queue's ceiling already dropped (its fate was sealed when it overflowed --
	 * that loss is `realLost`, bounded by the server-hitch check), or a REAL command that will now never run: the
	 * one that never made it into the queue at all, which is what the old fill rule did to every late command. The
	 * rule is enqueue's own (not newer than lastSeq, inside the window), applied just before the packet lands;
	 * `lateMismatch` proves it agrees with the server's counter.
	 */
	let lateCopies = 0;
	let lateOverflowed = 0;
	let lateReal = 0;
	const lateRealSeqs = new Set();
	let lateMismatch = 0;

	let clientAt = 0;
	let clientFrame = 0;
	/** send order, to break ties between packets that land at the same instant */
	let sentCount = 0;
	let serverAt = 0;
	let serverBeat = 0;
	let serverTick = 0;
	const beat = new TickAccumulator(SIM_DT, BACKLOG_S);
	/** heartbeats that ran more ticks than one: the server paying back time, two commands at a time */
	let catchupBeats = 0;
	/** ticks the last heartbeat ran */
	let lastRan = 1;

	while (clientAt < seconds || serverAt < seconds) {
		if (clientAt <= serverAt) {
			// ---- client frame: read what came down, then sample and send
			const dt = clientDt(clientFrame++, clientAt);
			clientAt += dt;
			const t = clientAt;
			now = 1000 + t;
			if (dt > 2 * SIM_DT && t >= WARMUP_S) hitches += 1;
			for (let i = down.size() - 1; i >= 0; i--) {
				if (down[i].at <= t) {
					client.noteBufDepth(down[i].depth);
					client.ack(down[i].ack);
					down.unorderedRemove(i);
				}
			}
			if (taps && t >= WARMUP_S && t < seconds - TAP_QUIET_S) {
				const k = clientFrame % 4;
				client.addEdges(k === 0, k === 1, k === 2, k === 3);
				tapsMade += 1;
			}
			out.clear();
			client.sample(dt, raw, out);
			for (const cmd of out) {
				predictedAt.set(cmd.seq, t);
				const e = edgeTotal(cmd.edges);
				edgesOf.set(cmd.seq, e);
				tapsBuilt += e;
			}
			// one jitter draw for the frame's burst (see the link above), unless the case asks for the worst
			let delay = rtt / 2 + (rand() * 2 - 1) * jitter;
			sendFrame(client, serverTick, t, pkt => {
				for (const cmd of pkt.cmds) {
					if (sentSeqs.has(cmd.seq)) continue;
					sentSeqs.add(cmd.seq);
					tapsSent += edgesOf.get(cmd.seq) ?? 0;
				}
				if (burstReorder) delay = rtt / 2 + (rand() * 2 - 1) * jitter;
				if (rand() >= loss) up.push({ at: t + delay, pkt, order: sentCount++ });
			});
		} else {
			// ---- server heartbeat: packets that landed meanwhile, then the ticks it owes (a heartbeat's length may
			// depend on how many the last one ran: a tick that costs half a heartbeat makes a catch-up one twice as long)
			const dt = serverDt(serverBeat++, serverAt, lastRan);
			serverAt += dt;
			const t = serverAt;
			now = 1000 + t;
			if (atWarmup === undefined && t >= WARMUP_S) atWarmup = { ...sp.counters };
			// in the order they LANDED, as OnServerEvent hands them over, all before the heartbeat's ticks
			const landed = [];
			for (let i = up.size() - 1; i >= 0; i--) {
				if (up[i].at <= t) landed.push(up.unorderedRemove(i));
			}
			landed.sort((a, b) => a.at - b.at || a.order - b.order);
			for (const { pkt } of landed) {
				const c = sp.counters;
				const before = { late: c.late, resync: c.resync };
				let copies = 0;
				let overflowed = 0;
				let real = 0;
				const entering = [];
				for (const cmd of pkt.cmds) {
					arrived.add(cmd.seq);
					const d = seqDiff(cmd.seq, sp.lastSeq);
					if (sp.started && d > CFG.INPUT_SEQ_WINDOW) continue;
					if (!sp.started || d > 0) {
						entering.push(cmd.seq);
						continue;
					}
					if (d < -CFG.INPUT_SEQ_WINDOW) continue;
					if (simulated.has(cmd.seq)) copies += 1;
					else if (queued.has(cmd.seq)) overflowed += 1;
					else {
						real += 1;
						if (t >= WARMUP_S) lateRealSeqs.add(cmd.seq);
					}
				}
				// server/net/mpHost.ts: the grace is how many ticks the server owes `dt` after its last heartbeat
				PL.acceptInput(sp, pkt, now, graceOf(rule, beat, dt));
				// everything newer than lastSeq entered the queue, if only for the instant before it overflowed
				for (const seq of entering) queued.add(seq);
				// a re-anchor inside the packet moves lastSeq mid-way: the prediction above no longer applies
				const late = c.late - before.late;
				if (c.resync === before.resync && late !== copies + overflowed + real) lateMismatch += 1;
				if (t >= WARMUP_S) {
					lateCopies += copies;
					lateOverflowed += overflowed;
					lateReal += real;
				}
			}
			const droppedBefore = beat.droppedTicks;
			const owed = beat.take(dt);
			lastRan = owed;
			if (t >= WARMUP_S) {
				droppedTicks += beat.droppedTicks - droppedBefore;
				if (owed > 1) catchupBeats += 1;
			}
			for (let ran = 0; ran < owed; ran++) {
				const c = sp.counters;
				const before = { filled: c.filled, consumed: c.consumed };
				const depth = PL.bufferDepth(sp);
				const cmd = PL.takeCommand(sp);
				const consumed = c.consumed - before.consumed;
				const filled = c.filled - before.filled;
				// one command per tick, ALWAYS (§2.2): the whole speedhack argument rests on it
				if (consumed + filled > 1) throw new Error("takeCommand used more than one command in one tick");
				if (consumed > 0) {
					simulated.add(cmd.seq);
					tapsConsumed += edgeTotal(cmd.edges);
					const at = predictedAt.get(cmd.seq);
					if (at !== undefined && at >= WARMUP_S && at < seconds - TAIL_S) {
						const lat = t - at;
						latencySum += lat;
						latencyN += 1;
						if (lat > latencyMax) latencyMax = lat;
					}
				}
				if (t >= WARMUP_S) {
					ticksSteady += 1;
					fillsSteady += filled;
					depthSum += depth;
					if (depth < depthMin) depthMin = depth;
					if (filled > 0) {
						if (currentRun === 0) fillEpisodes += 1;
						currentRun += 1;
						if (currentRun > worstRun) worstRun = currentRun;
					} else currentRun = 0;
				}
				if (serverTick % CFG.SNAP_NEAR_EVERY_TICKS === 0) {
					down.push({ at: t + rtt / 2, depth: PL.bufferDepth(sp), ack: sp.ackSeq });
				}
				serverTick += 1;
			}
		}
	}

	// real commands the server never simulated, once per seq, predicted inside the steady window
	let realLost = 0;
	let predictedLost = 0;
	for (const [seq, at] of predictedAt) {
		if (at < WARMUP_S || at >= seconds - TAIL_S || simulated.has(seq)) continue;
		predictedLost += 1;
		if (arrived.has(seq)) realLost += 1;
	}

	const n = Math.max(1, ticksSteady);
	const c = sp.counters;
	const w = atWarmup ?? c;
	lateSteady = c.late - w.late;
	overflowSteady = c.inputOverflow - w.inputOverflow;
	const seqWindow = c.seqWindow - w.seqWindow;
	const resync = c.resync - w.resync;
	return {
		fillsPerSecond: (fillsSteady / n) * CFG.SIM_HZ,
		fills: fillsSteady,
		fillEpisodes,
		hitches,
		lateSteady,
		lateCopies,
		lateOverflowed,
		lateReal,
		lateRealDistinct: lateRealSeqs.size(),
		lateMismatch,
		realLost,
		predictedLost,
		overflowSteady,
		droppedTicks,
		catchupBeats,
		avgDepth: depthSum / n,
		depthMin,
		worstRun,
		hz: client.sampleHz(),
		stallDropped: client.stats().stallDropped,
		seqWindow,
		resync,
		tapsMade,
		tapsBuilt,
		tapsSent,
		tapsConsumed,
		latencyMean: latencySum / Math.max(1, latencyN),
		latencyMax,
		simulatedSteady: latencyN,
	};
}

console.log(
	`fila do servidor: alvo ${CFG.INPUT_BUFFER_TARGET}, teto ${CFG.INPUT_BUFFER_MAX}, ` +
		`redundancia ${CFG.INPUT_REDUNDANCY}x, dilatacao +-${(CFG.INPUT_DILATION * 100).toFixed(0)}%, ` +
		`recuperacao do servidor ate ${CFG.MAX_CATCHUP_TICKS} ticks por heartbeat, divida ate ` +
		`${Math.round(BACKLOG_S / SIM_DT)} ticks, ` +
		(RULE === "shipped"
			? "teto da fila acrescido dos ticks de uma divida que o servidor esta pagando"
			: RULE === "debt"
				? "teto da fila acrescido de todo tick devido, pago ou nao (--debt-grace, a regra de dee095a)"
				: "teto da fila fixo (--no-grace)"),
);

/*
 * The grace rule itself (server/sim/heartbeat.ts `grace`), heartbeat by heartbeat, before the runs that measure what
 * it does to a queue: a hitch opens a repayment and earns its ticks, a server that cannot keep time earns nothing.
 */
{
	console.log("");
	console.log("0) a regra da folga, heartbeat a heartbeat (server/sim/heartbeat.ts)");
	const beats = (acc, n, dt) => {
		for (let i = 0; i < n; i++) acc.take(dt);
	};
	// a 100 ms hitch on a 60 Hz server: 6 ticks owed, 2 run at once, 4 repaid one a heartbeat
	const hitch = new TickAccumulator(SIM_DT);
	beats(hitch, 120, SIM_DT);
	const during = hitch.grace(0.1);
	hitch.take(0.1);
	const after = [hitch.grace(0)];
	for (let i = 0; i < 4; i++) {
		hitch.take(SIM_DT);
		after.push(hitch.grace(0));
	}
	check(
		"um engasgo de 100 ms guarda os comandos que o pagamento vai consumir, e so eles",
		during === 5 && after.join(",") === "3,2,1,0,0",
		`durante ${during}, depois ${after.join(", ")}`,
	);
	// Below 30 Hz the debt only grows to its cap and drops: nothing is ever repaid. The first heartbeats of the
	// slowdown cannot know that yet (a tick or two, for as long as the debt stays within half a tick of where it
	// started): from the tenth on, nothing.
	const slow = new TickAccumulator(SIM_DT);
	beats(slow, 120, SIM_DT);
	let slowMax = 0;
	for (let i = 0; i < 100; i++) {
		slow.take(0.04);
		if (i >= 10) slowMax = Math.max(slowMax, slow.grace(0), slow.grace(0.02), slow.grace(0.04));
	}
	check(
		"um heartbeat a 25 Hz sustentado nao da folga nenhuma",
		slowMax === 0 && slow.droppedTicks > 0,
		`maior folga ${slowMax}, ${slow.droppedTicks} ticks descartados`,
	);
	// a second hitch in the middle of a repayment: the debt climbs past what the first left -- not being repaid
	const twice = new TickAccumulator(SIM_DT);
	beats(twice, 120, SIM_DT);
	twice.take(0.15);
	twice.take(SIM_DT);
	const before = twice.grace(0);
	twice.take(0.1);
	const behind = twice.grace(0);
	beats(twice, 10, SIM_DT);
	const back = twice.grace(0.1);
	check(
		"um engasgo por cima de um pagamento fecha a folga ate o servidor ficar em dia",
		before > 0 && behind === 0 && back === 5,
		`antes ${before}, depois do segundo ${behind}, em dia de novo ${back}`,
	);
	// a tick that costs half a heartbeat: each catch-up heartbeat is 1.9 ticks long and repays a tenth of a tick
	const crawl = new TickAccumulator(SIM_DT);
	beats(crawl, 120, SIM_DT);
	crawl.take(0.25);
	let crawlMax = 0;
	for (let i = 0; i < 30; i++) {
		crawl.take(1.9 * SIM_DT);
		crawlMax = Math.max(crawlMax, crawl.grace(0));
	}
	check(
		"um pagamento que se arrasta so guarda o que paga em INPUT_GRACE_MAX heartbeats",
		crawlMax <= Math.ceil(0.1 * CFG.INPUT_GRACE_MAX) && crawl.owed() > 5 * SIM_DT,
		`maior folga ${crawlMax}, divida ainda ${(crawl.owed() / SIM_DT).toFixed(1)} ticks`,
	);
}

/** one frame in twenty takes `ms`: a machine that is busy with something else now and then */
const hitchEvery20 = ms => i => (i % 20 === 19 ? ms / 1000 : SIM_DT);
/** one frame every two seconds takes `ms`, the rest run at 60 FPS: each long frame is on its own */
const isolatedHitch = ms => i => (i % 120 === 119 ? ms / 1000 : SIM_DT);

/**
 * How many ticks a client hitch of `ms` leaves the server with NOTHING to simulate, at most: the hitch itself.
 * The frame that ends it sends what it builds at once (commands.ts `dropBacklog` drops the backlog's TIME and
 * `flush` sends every command), and the queue the server was holding covers part of it; nothing can cover more.
 * It was one tick more while the frame that ended a hitch cleared its unacked queue and sent nothing.
 */
const starvedTicks = ms => Math.ceil((ms / 1000) * CFG.SIM_HZ);

/** `fastS` seconds at 60 FPS, then `slowS` seconds at `slowFps`, over and over: by the clock of the side it paces */
const phased = (fastS, slowS, slowFps) => (_i, at) => (at % (fastS + slowS) < fastS ? SIM_DT : 1 / slowFps);

/**
 * tools/test-zombie-motion.mjs's Studio profile, from the owner's [PZ-NET] log of 2026-09-23: mostly 60 fps,
 * stretches of 22-40 ms frames for 0.5-2 s, single hitches of 50-160 ms. Drawn once, from a generator of its own (the
 * link's draws stay the link's), and shared by the server's heartbeat and the client's frames: one process.
 */
function studioFrames(seconds, seedValue) {
	let s = seedValue;
	const random = () => {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		return s / 0x7fffffff;
	};
	const out = [];
	let t = 0;
	let slowLeft = 0;
	while (t < seconds) {
		let dt;
		if (random() < 0.012) {
			dt = 0.05 + random() * 0.11;
		} else {
			if (slowLeft <= 0 && random() < 0.006) slowLeft = 0.5 + random() * 1.5;
			if (slowLeft > 0) {
				dt = 0.022 + random() * 0.018;
				slowLeft -= dt;
			} else {
				dt = SIM_DT * (0.95 + random() * 0.1);
			}
		}
		out.push(dt);
		t += dt;
	}
	return out;
}
const STUDIO = studioFrames(num("--seconds", 20) + 5, 20260923);
const studioDt = i => STUDIO[i % STUDIO.length];

/**
 * A server whose tick costs about half a 60 Hz heartbeat: a heartbeat that runs one tick is on time, one that runs
 * two takes `catchupTicks` ticks' worth -- so a debt is repaid by a sliver a heartbeat -- and one heartbeat in
 * `everyBeats` is a hitch of `hitchMs` that leaves one.
 */
const crawling = (catchupTicks, everyBeats, hitchMs) => (i, _at, lastRan) =>
	i % everyBeats === everyBeats - 1 ? hitchMs / 1000 : lastRan >= 2 ? catchupTicks * SIM_DT : SIM_DT;

const CASES = [
	// the clean links are the regression guard: the queue must never run dry on them
	{ name: "1) LAN: 20 ms, sem jitter, sem perda", rtt: 0.02, jitter: 0, loss: 0, clean: true, tapGuard: true },
	{ name: "2) tipico: 60 ms, 8 ms de jitter", rtt: 0.06, jitter: 0.008, loss: 0, clean: true, tapGuard: true },
	// 2% loss may legitimately take all three copies of a command, taps and all: reported, not guarded
	{ name: "3) ruim: 120 ms, 25 ms de jitter, 2% de perda", rtt: 0.12, jitter: 0.025, loss: 0.02, clean: true },
	/*
	 * The loaded machine. Studio playtests run the server and every client on ONE computer, and the playtest
	 * that reported the hitch was exactly that. These three separate WHICH side's hitch empties the queue. The
	 * client's can (a long frame makes at most MAX_COMMANDS_PER_FRAME commands and drops the others). The server's
	 * must not: it repays its debt at MAX_CATCHUP_TICKS a heartbeat, and the commands those ticks consume are the
	 * ones that landed during its hitch -- which the queue keeps for it (players.ts `grace`). Capped at
	 * INPUT_BUFFER_MAX instead, they were thrown away and every repaid tick waited (commit 097f484, the review of
	 * 2026-09-23: case 5 at 3.91 waits a second, case 6 at 11.94).
	 */
	{
		name: "4) cliente engasga: 1 quadro em 20 leva 150 ms",
		rtt: 0.06,
		jitter: 0.008,
		clientDt: hitchEvery20(150),
		clientHitchMs: 150,
		tapGuard: true,
	},
	/*
	 * A hitching server within its debt loses nothing: no tick, no command, no wait. Past its debt it drops time,
	 * and the commands for that time with it at the ceiling -- their movement, by design; their taps are carried to
	 * the new head (players.ts `enqueue`), so those are guarded here too.
	 */
	{
		name: "5) servidor engasga: 1 heartbeat em 20 leva 100 ms",
		rtt: 0.06,
		jitter: 0.008,
		serverDt: hitchEvery20(100),
		serverHitch: true,
		tapGuard: true,
	},
	{
		name: "6) os dois: Studio com servidor e clientes no mesmo PC",
		rtt: 0.02,
		jitter: 0.004,
		clientDt: hitchEvery20(120),
		serverDt: hitchEvery20(80),
		clientHitchMs: 120,
		serverHitch: true,
		tapGuard: true,
	},
	/*
	 * The client's FRAME RATE, with a tap on every frame. A phone or a weak PC runs at 15-30 FPS, and a frame of
	 * 1/15 s is worth four commands. The criterion is absolute: no tap may be lost because of the rhythm of the
	 * client's frames -- not at a steady low FPS, not on the one long frame of an otherwise smooth game. The link
	 * is kept clean (no loss, no jitter) so that whatever is lost here is lost by the frame rate and nothing else;
	 * every other case carries taps too, on its own link.
	 *
	 * Before commands.ts sent one packet per command (one per frame, 3 commands, taps on the frame's oldest):
	 * 15 fps 0 of 270 taps, 20 fps 339 of 360, the 70 ms frame 1043 of 1052, the 150 ms frame 1008 of 1016.
	 */
	{ name: "7) 15 fps: cada quadro vale 4 comandos", rtt: 0.06, jitter: 0, clientDt: () => 1 / 15, tapGuard: true },
	{
		name: "8) 20 fps: 3 comandos por quadro, 4 quando a dilatacao acelera",
		rtt: 0.06,
		jitter: 0,
		clientDt: () => 1 / 20,
		tapGuard: true,
	},
	{
		name: "9) um quadro isolado de 70 ms (1 a cada 2 s, o resto a 60 fps)",
		rtt: 0.06,
		jitter: 0,
		clientDt: isolatedHitch(70),
		clientHitchMs: 70,
		tapGuard: true,
	},
	{
		name: "10) um quadro isolado de 150 ms (1 a cada 2 s, o resto a 60 fps)",
		rtt: 0.06,
		jitter: 0,
		clientDt: isolatedHitch(150),
		clientHitchMs: 150,
		tapGuard: true,
	},
	/*
	 * The worst the network may do to it: the packets of one frame REORDERED among themselves (a jitter draw per
	 * packet), at 15 FPS -- four packets a frame -- with a 150 ms frame every two seconds to leave the queue dry
	 * right when a burst lands. A 3-command packet cannot carry a whole 4-command frame, so when {c4, c3, c2}
	 * overtakes the three packets that carry c1 by a tick, the server jumps over c1: one tick of MOVEMENT, which
	 * the reconciliation corrects. The frame's TAPS ride c4, which nothing sent in its own frame can overtake, so
	 * they must all still land.
	 */
	{
		name: "11) pior caso: pacotes do mesmo quadro reordenados (15 fps, 8 ms por pacote, 150 ms a cada 2 s)",
		rtt: 0.06,
		jitter: 0.008,
		burstReorder: true,
		clientDt: i => (i % 30 === 29 ? 0.15 : 1 / 15),
		tapGuard: true,
	},
	/*
	 * The server that CANNOT keep up (the review of dee095a, B1). Below 30 Hz a heartbeat is longer than the
	 * MAX_CATCHUP_TICKS it may run, so the debt only grows, sits at MAX_BACKLOG_S and drops the rest, heartbeat after
	 * heartbeat: the ticks it "owes" are never run. dee095a granted the queue one command per tick owed and kept every
	 * queue about as deep as the debt for as long as the slowdown lasted: 352 ms from input to simulation at 25 Hz
	 * where the fixed ceiling gives 80 ms, 313 ms against 69 ms with Studio at 28 fps -- and every honest shot clamped,
	 * since the rewind counts at most INPUT_BUFFER_MAX ticks of queue. Grace is for a debt that is being REPAID
	 * (server/sim/heartbeat.ts): these must look like the fixed ceiling (`slowServer`: against the same run with no
	 * grace, and dee095a's rule printed next to it).
	 */
	{
		name: "12) servidor lento: heartbeat a 25 Hz sustentado",
		rtt: 0.06,
		jitter: 0.008,
		serverDt: () => 1 / 25,
		slowServer: true,
		tapGuard: true,
	},
	{
		name: "13) Studio a 28 fps: servidor e cliente no mesmo quadro",
		rtt: 0.02,
		jitter: 0.004,
		clientDt: () => 1 / 28,
		serverDt: () => 1 / 28,
		slowServer: true,
		tapGuard: true,
	},
	/*
	 * Both regimes in turn: 3 s at 60 FPS, 3 s at 28, server and client on the same frames. The slow half builds a
	 * debt of ~12 ticks that the fast half repays in a fifth of a second -- but WHILE it builds, nothing tells it from
	 * case 13, whose debt is never repaid: the commands that repayment will want are the client's surplus over a
	 * server running at 56 ticks a second, and keeping them for it is exactly the latency case 13 must not pay. So
	 * the slow half gets the fixed ceiling, and this case is held to it; what dee095a's rule bought here is printed.
	 */
	{
		name: "14) misto: 3 s a 60 fps, 3 s a 28 fps (servidor e cliente no mesmo quadro)",
		rtt: 0.02,
		jitter: 0.004,
		clientDt: phased(3, 3, 28),
		serverDt: phased(3, 3, 28),
		slowServer: true,
		tapGuard: true,
	},
	/*
	 * The Studio playtest itself (tools/test-zombie-motion.mjs `studio`): hitches of 50-160 ms that the next frames
	 * repay, and slow stretches of 22-40 ms frames -- under two ticks each, so the server does keep up, barely. Here
	 * grace is for the hitches: fewer waits than the fixed ceiling, and still no queue kept deep.
	 */
	{
		name: "15) quadros do Studio (perfil de test:zombie-motion): servidor e cliente no mesmo quadro",
		rtt: 0.02,
		jitter: 0.004,
		clientDt: studioDt,
		serverDt: studioDt,
		slowServer: true,
		repays: true,
		tapGuard: true,
	},
	/*
	 * The review's slow case: a tick that costs about half a heartbeat, so a heartbeat that catches up takes 1.9 ticks
	 * and repays a tenth of a tick. A 250 ms hitch every ~4 s leaves 13 ticks that take seconds to clear; granting them
	 * all kept the queues debt-deep for those seconds. Grace follows the pace of the repayment instead.
	 */
	{
		name: "16) divida paga devagar: um tick custa meio heartbeat, 250 ms de engasgo a cada ~4 s",
		rtt: 0.06,
		jitter: 0.008,
		serverDt: crawling(1.9, 150, 250),
		slowServer: true,
		tapGuard: true,
	},
];

for (const c of CASES) {
	console.log("");
	console.log(c.name);
	const seconds = num("--seconds", 20);
	const seedBefore = seed;
	const r = run({ ...c, taps: true, seconds });
	/*
	 * A case whose SERVER hitches is also run without that hitch -- the same client, the same link, the same draws
	 * (only client frames draw from the generator) -- so that what the server's hitch itself costs can be told
	 * apart from what the client's own hitches cost.
	 */
	let twin;
	if (c.serverHitch) {
		const seedAfter = seed;
		seed = seedBefore;
		twin = run({ ...c, serverDt: undefined, taps: true, seconds });
		seed = seedAfter;
	}
	console.log(
		`        profundidade media ${r.avgDepth.toFixed(2)} (minima ${r.depthMin}), envio a ${r.hz.toFixed(2)} Hz`,
	);
	console.log(
		`        ${r.fillsPerSecond.toFixed(2)} preench./s (pior sequencia ${r.worstRun}, ${r.fillEpisodes} episodios ` +
			`em ${r.hitches} engasgos do cliente), ${r.overflowSteady} transbordos, ${r.stallDropped} descartados no ` +
			`cliente, ${r.droppedTicks} ticks perdidos no servidor (${r.catchupBeats} heartbeats pagando atraso), ` +
			`${r.seqWindow} fora da janela, ${r.resync} reancoragens`,
	);
	console.log(
		`        ${r.lateSteady} atrasados = ${r.lateCopies} copias de comandos ja simulados + ${r.lateOverflowed} ` +
			`copias de comandos que o teto da fila ja descartou + ${r.lateReal} comandos reais jogados fora ` +
			`(${r.lateRealDistinct} distintos)`,
	);
	console.log(
		`        ${r.realLost} comandos reais chegaram e nunca foram simulados; ` +
			`${r.predictedLost} previstos pelo dono e nunca simulados`,
	);
	console.log(
		`        toques: ${r.tapsMade} feitos, ${r.tapsBuilt} empacotados, ${r.tapsSent} enviados, ` +
			`${r.tapsConsumed} simulados pelo servidor`,
	);
	console.log(
		`        do input a simulacao: media ${(r.latencyMean * 1000).toFixed(0)} ms, ` +
			`pior ${(r.latencyMax * 1000).toFixed(0)} ms (${r.simulatedSteady} comandos)`,
	);

	// the harness's own sorting of the refusals must agree with the server's counter, or the lines below lie
	check(
		"a classificacao dos atrasados bate com o contador do servidor",
		r.lateMismatch === 0,
		`${r.lateMismatch} pacotes divergentes`,
	);

	if (c.clean) {
		/*
		 * The budget. A fill is not free: the body stops for a tick in the world everyone else is watching. Once
		 * every few seconds is an event; several a second is a texture, and a texture is what "all the time,
		 * naturally" describes.
		 */
		check("a fila nao seca repetidamente", r.fillsPerSecond < 1, r.fillsPerSecond.toFixed(2) + " por segundo");
		check("nunca seca por varios ticks seguidos", r.worstRun <= 2, "pior sequencia " + r.worstRun + " ticks");
		// 25 ms of jitter reorders packets now and then: a command overtaken by a newer one after all three of its
		// copies were late is the one legitimate way to lose a real command on a link that does not hitch
		check(
			"um comando real so e jogado fora quando as tres copias perdem a corrida",
			r.lateRealDistinct <= (c.jitter > 0.02 ? 3 : 0),
			`${r.lateRealDistinct} distintos`,
		);
	}

	if (c.clientHitchMs !== undefined) {
		/*
		 * The lock this file found, as a guard. A hitching client really leaves the server without commands for a
		 * while, and those ticks are filled: that part is the hitch, not a bug. What must never come back is the
		 * CASCADE -- a fill spending the real command's number, the real command refused as late, the queue unable
		 * to refill, the next tick filling again (29.8 fills/s, runs of 11, 197 real commands thrown away in case 4
		 * before the fix). So: no real command is ever thrown away as late, no stop lasts longer than the ticks the
		 * hitch starved, and the fills add up to no more than the hitches explain.
		 */
		const starved = starvedTicks(c.clientHitchMs);
		check(
			"nenhum comando real e recusado como atrasado: so copias ja simuladas",
			r.lateRealDistinct === 0,
			`${r.lateRealDistinct} reais, ${r.lateCopies} copias`,
		);
		check(
			`nenhuma parada dura mais que o engasgo (${starved} ticks sem nada para simular)`,
			r.worstRun <= starved,
			"pior sequencia " + r.worstRun + " ticks",
		);
		check(
			"sem cascata: os preenchimentos cabem nos engasgos que os causaram",
			r.fills <= r.hitches * starved,
			`${r.fills} preenchimentos para ${r.hitches} engasgos, ` +
				`${(r.fills / Math.max(1, r.hitches)).toFixed(2)} por engasgo, teto ${starved}`,
		);
	}

	if (c.serverHitch) {
		/*
		 * What the SERVER's hitch costs, against the same run without it (`twin`). Within its debt it simulates
		 * every tick, each with the command meant for it: it may not wait more often than the client's own hitches
		 * already make it wait, and it may not throw away a command for any tick it did not drop itself. This used to
		 * read "commands lost <= ticks dropped", on this file's own copy of the old drop rule -- which could not see a
		 * rule that drops nothing and starves the queue instead (097f484: 0 ticks dropped, 90 commands lost, 3.91
		 * waits a second).
		 */
		console.log(
			`        sem o engasgo do servidor: ${twin.fillsPerSecond.toFixed(2)} preench./s, ` +
				`${twin.realLost} comandos reais nunca simulados`,
		);
		check(
			"o engasgo do servidor nao faz a fila esperar mais que os engasgos do proprio cliente",
			r.fills <= twin.fills,
			`${r.fillsPerSecond.toFixed(2)}/s contra ${twin.fillsPerSecond.toFixed(2)}/s sem ele`,
		);
		check(
			"o servidor so descarta comandos dos ticks que ele mesmo perdeu",
			r.realLost <= twin.realLost + r.droppedTicks,
			`${r.realLost} comandos, ${twin.realLost} sem o engasgo + ${r.droppedTicks} ticks perdidos`,
		);
		if (c.clientHitchMs === undefined) {
			check("o engasgo do servidor sozinho nunca seca a fila", r.fills === 0, r.fills + " preenchimentos");
		}
	}

	if (c.slowServer) {
		/*
		 * The same run with the queue's ceiling fixed at INPUT_BUFFER_MAX (no grace) and with dee095a's grace for
		 * every tick owed: same client, same link, same draws. Grace may buy a repayment its commands; it may not buy
		 * a queue that is deep for good, nor for the seconds a crawling repayment takes.
		 */
		const seedAfter = seed;
		const twinOf = rule => {
			seed = seedBefore;
			return run({ ...c, taps: true, seconds, rule });
		};
		const fixed = twinOf("fixed");
		const debt = twinOf("debt");
		seed = seedAfter;
		const line = (label, x) =>
			console.log(
				`        ${label}: media ${(x.latencyMean * 1000).toFixed(0)} ms, pior ` +
					`${(x.latencyMax * 1000).toFixed(0)} ms, profundidade ${x.avgDepth.toFixed(2)}, ` +
					`${x.fillsPerSecond.toFixed(2)} preench./s, ${x.realLost} comandos reais nunca simulados`,
			);
		line("com a folga    ", r);
		line("com o teto fixo", fixed);
		line("regra de dee095a", debt);
		check(
			`a fila de um servidor lento nao passa de INPUT_BUFFER_MAX + 1 em media`,
			r.avgDepth <= CFG.INPUT_BUFFER_MAX + 1,
			`${r.avgDepth.toFixed(2)} contra ${fixed.avgDepth.toFixed(2)} com o teto fixo e ${debt.avgDepth.toFixed(2)} ` +
				`com a regra de dee095a`,
		);
		check(
			"a folga nao atrasa o input mais que 1 tick alem do teto fixo",
			r.latencyMean <= fixed.latencyMean + SIM_DT,
			`${(r.latencyMean * 1000).toFixed(0)} ms contra ${(fixed.latencyMean * 1000).toFixed(0)} ms com o teto ` +
				`fixo e ${(debt.latencyMean * 1000).toFixed(0)} ms com a regra de dee095a`,
		);
		check(
			"nem espera nem perde mais que o teto fixo",
			r.fills <= fixed.fills && r.realLost <= fixed.realLost,
			`${r.fills} preenchimentos e ${r.realLost} perdidos contra ${fixed.fills} e ${fixed.realLost}`,
		);
		if (c.repays) {
			// where the server repays its hitches, grace is what keeps the repayment fed: it must show
			check(
				"onde o servidor paga os engasgos, a folga espera menos que o teto fixo",
				r.fills < fixed.fills,
				`${r.fills} preenchimentos contra ${fixed.fills}`,
			);
		}
	}

	if (c.tapGuard) {
		/*
		 * A tap is the one input prediction cannot paper over: a lost step is corrected, a lost shot, reload or E is
		 * simply gone. Every tap made has to reach the server's simulation -- once: more would be a replayed action.
		 */
		check(
			"todo toque feito chega a simulacao do servidor, uma vez so",
			r.tapsMade > 0 && r.tapsConsumed === r.tapsMade,
			`${r.tapsConsumed} de ${r.tapsMade} simulados; ${r.tapsBuilt} empacotados, ${r.tapsSent} enviados`,
		);
	}
}

console.log("");
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
}
console.log(
	"OK: a fila de input nao trava -- um engasgo custa os ticks que durou, nenhum comando real e recusado, " +
		"e nenhum toque se perde pelo ritmo de quadros do cliente",
);
