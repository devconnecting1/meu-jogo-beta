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

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const num = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};

const SIM_DT = 1 / CFG.SIM_HZ;

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

/**
 * One survivor walking, for `seconds`, with the real sender talking to the real queue.
 *
 * Client frames and server heartbeats run on their OWN clocks, the way they do on a real machine. A client
 * frame samples `dt` worth of commands (at most MAX_COMMANDS_PER_FRAME; the surplus is dropped, as
 * commands.ts does) and sends the newest with its two predecessors. A server heartbeat runs the fixed ticks it
 * owes -- at most MAX_CATCHUP_TICKS, the rest of the time DROPPED, exactly like ServerSimulation.advance -- and
 * each tick consumes one command or, with the queue dry, waits (a fill). `clientDt(i)` / `serverDt(i)` give the
 * length of frame / heartbeat i, so a hitch on either side is simply a long one. Every SNAP_NEAR_EVERY_TICKS the
 * server answers with the queue depth and the ack, which is what closes the dilation loop.
 */
function run({ seconds = 20, rtt = 0.06, jitter = 0.008, loss = 0, clientDt = () => SIM_DT, serverDt = () => SIM_DT }) {
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
	 * Every `late` refusal, sorted by what it threw away: a COPY of a command already simulated (the redundancy
	 * working) or a REAL command that will now never run. The rule is enqueue's own (not newer than lastSeq, inside
	 * the window), applied just before the packet lands; `lateMismatch` proves it agrees with the server's counter.
	 */
	let lateCopies = 0;
	let lateReal = 0;
	const lateRealSeqs = new Set();
	let lateMismatch = 0;

	let clientAt = 0;
	let clientFrame = 0;
	let serverAt = 0;
	let serverBeat = 0;
	let serverTick = 0;
	let acc = 0;

	while (clientAt < seconds || serverAt < seconds) {
		if (clientAt <= serverAt) {
			// ---- client frame: read what came down, then sample and send
			const dt = clientDt(clientFrame++);
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
			out.clear();
			client.sample(dt, raw, out);
			for (const cmd of out) predictedAt.set(cmd.seq, t);
			if (out.size() > 0) {
				const pkt = client.packet(serverTick, 0);
				if (pkt !== undefined && client.trySend(t) && rand() >= loss) {
					up.push({ at: t + rtt / 2 + (rand() * 2 - 1) * jitter, pkt });
				}
			}
		} else {
			// ---- server heartbeat: packets that landed meanwhile, then the ticks it owes
			const dt = serverDt(serverBeat++);
			serverAt += dt;
			const t = serverAt;
			now = 1000 + t;
			if (atWarmup === undefined && t >= WARMUP_S) atWarmup = { ...sp.counters };
			for (let i = up.size() - 1; i >= 0; i--) {
				if (up[i].at <= t) {
					const pkt = up[i].pkt;
					const c = sp.counters;
					const before = { late: c.late, resync: c.resync };
					let copies = 0;
					let real = 0;
					for (const cmd of pkt.cmds) {
						arrived.add(cmd.seq);
						const d = seqDiff(cmd.seq, sp.lastSeq);
						if (!sp.started || d > 0 || d < -CFG.INPUT_SEQ_WINDOW) continue;
						if (simulated.has(cmd.seq)) copies += 1;
						else {
							real += 1;
							if (t >= WARMUP_S) lateRealSeqs.add(cmd.seq);
						}
					}
					PL.acceptInput(sp, pkt, now);
					up.unorderedRemove(i);
					// a re-anchor inside the packet moves lastSeq mid-way: the prediction above no longer applies
					if (c.resync === before.resync && c.late - before.late !== copies + real) lateMismatch += 1;
					if (t >= WARMUP_S) {
						lateCopies += copies;
						lateReal += real;
					}
				}
			}
			acc += Math.min(dt, 1);
			let ran = 0;
			while (acc >= SIM_DT - 1e-9 && ran < CFG.MAX_CATCHUP_TICKS) {
				acc -= SIM_DT;
				ran += 1;
				const c = sp.counters;
				const before = { filled: c.filled, consumed: c.consumed };
				const depth = PL.bufferDepth(sp);
				const cmd = PL.takeCommand(sp);
				const consumed = c.consumed - before.consumed;
				const filled = c.filled - before.filled;
				// one command per tick, ALWAYS (§2.2): the whole speedhack argument rests on it
				if (consumed + filled > 1) throw new Error("takeCommand used more than one command in one tick");
				if (consumed > 0) simulated.add(cmd.seq);
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
			if (acc >= SIM_DT) {
				const dropped = Math.floor(acc / SIM_DT);
				if (t >= WARMUP_S) droppedTicks += dropped;
				acc -= dropped * SIM_DT;
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
		lateReal,
		lateRealDistinct: lateRealSeqs.size(),
		lateMismatch,
		realLost,
		predictedLost,
		overflowSteady,
		droppedTicks,
		avgDepth: depthSum / n,
		depthMin,
		worstRun,
		hz: client.sampleHz(),
		stallDropped: client.stats().stallDropped,
		seqWindow,
		resync,
	};
}

console.log(
	`fila do servidor: alvo ${CFG.INPUT_BUFFER_TARGET}, teto ${CFG.INPUT_BUFFER_MAX}, ` +
		`redundancia ${CFG.INPUT_REDUNDANCY}x, dilatacao +-${(CFG.INPUT_DILATION * 100).toFixed(0)}%, ` +
		`recuperacao do servidor ate ${CFG.MAX_CATCHUP_TICKS} ticks por heartbeat`,
);

/** one frame in twenty takes `ms`: a machine that is busy with something else now and then */
const hitchEvery20 = ms => i => (i % 20 === 19 ? ms / 1000 : SIM_DT);

/**
 * How many ticks a client hitch of `ms` leaves the server with NOTHING to simulate, at most: the hitch itself
 * plus the frame after it, because the frame that ends a hitch makes more than MAX_COMMANDS_PER_FRAME commands,
 * drops its backlog (commands.ts `skipBacklog`) and so sends nothing -- the next packet leaves one frame later.
 * The queue the server was holding covers part of that; nothing can cover more.
 */
const starvedTicks = ms => Math.ceil((ms / 1000) * CFG.SIM_HZ) + 1;

const CASES = [
	// the clean links are the regression guard: the queue must never run dry on them
	{ name: "1) LAN: 20 ms, sem jitter, sem perda", rtt: 0.02, jitter: 0, loss: 0, clean: true },
	{ name: "2) tipico: 60 ms, 8 ms de jitter", rtt: 0.06, jitter: 0.008, loss: 0, clean: true },
	{ name: "3) ruim: 120 ms, 25 ms de jitter, 2% de perda", rtt: 0.12, jitter: 0.025, loss: 0.02, clean: true },
	/*
	 * The loaded machine. Studio playtests run the server and every client on ONE computer, and the playtest
	 * that reported the hitch was exactly that. These three separate WHICH side's hitch empties the queue: the
	 * server's cannot by construction (it runs at most MAX_CATCHUP_TICKS and drops the rest of the time, so a
	 * late heartbeat consumes less, never more), the client's can (a long frame makes at most
	 * MAX_COMMANDS_PER_FRAME commands and drops the others).
	 */
	{
		name: "4) cliente engasga: 1 quadro em 20 leva 150 ms",
		rtt: 0.06,
		jitter: 0.008,
		clientDt: hitchEvery20(150),
		clientHitchMs: 150,
	},
	{
		name: "5) servidor engasga: 1 heartbeat em 20 leva 100 ms",
		rtt: 0.06,
		jitter: 0.008,
		serverDt: hitchEvery20(100),
		serverHitch: true,
	},
	{
		name: "6) os dois: Studio com servidor e clientes no mesmo PC",
		rtt: 0.02,
		jitter: 0.004,
		clientDt: hitchEvery20(120),
		serverDt: hitchEvery20(80),
		clientHitchMs: 120,
		serverHitch: true,
	},
];

for (const c of CASES) {
	console.log("");
	console.log(c.name);
	const r = run({ ...c, seconds: num("--seconds", 20) });
	console.log(
		`        profundidade media ${r.avgDepth.toFixed(2)} (minima ${r.depthMin}), envio a ${r.hz.toFixed(2)} Hz`,
	);
	console.log(
		`        ${r.fillsPerSecond.toFixed(2)} preench./s (pior sequencia ${r.worstRun}, ${r.fillEpisodes} episodios ` +
			`em ${r.hitches} engasgos do cliente), ${r.overflowSteady} transbordos, ${r.stallDropped} descartados no ` +
			`cliente, ${r.droppedTicks} ticks perdidos no servidor, ${r.seqWindow} fora da janela, ${r.resync} reancoragens`,
	);
	console.log(
		`        ${r.lateSteady} atrasados = ${r.lateCopies} copias de comandos ja simulados + ${r.lateReal} comandos ` +
			`reais jogados fora (${r.lateRealDistinct} distintos)`,
	);
	console.log(
		`        ${r.realLost} comandos reais chegaram e nunca foram simulados; ` +
			`${r.predictedLost} previstos pelo dono e nunca simulados`,
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
		 * A hitching server loses time it will never simulate (MAX_CATCHUP_TICKS, the rest is dropped), so the
		 * commands for that time overflow the queue and are dropped: the harmless direction, and bounded. It must
		 * never throw away more commands than the ticks it lost, and on its own it must never empty the queue.
		 */
		check(
			"o servidor nao descarta mais comandos que os ticks que ele mesmo perdeu",
			r.realLost <= r.droppedTicks,
			`${r.realLost} comandos, ${r.droppedTicks} ticks perdidos`,
		);
		if (c.clientHitchMs === undefined) {
			check("o engasgo do servidor sozinho nunca seca a fila", r.fills === 0, r.fills + " preenchimentos");
		}
	}
}

console.log("");
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
}
console.log("OK: a fila de input nao trava -- um engasgo custa os ticks que durou, e nenhum comando real e recusado");
