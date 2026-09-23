#!/usr/bin/env node
/*
 * How often does the server's input queue run DRY? (docs/MULTIPLAYER.md §2.2)
 *
 *   npm run test:input
 *   node tools/test-input-buffer.mjs --seconds 20
 *
 * Why this test exists. A playtest reported an ally hitching "as if he had lag, all the time, naturally, and
 * short -- one step", while the person moving felt perfectly smooth themselves. That asymmetry is the whole
 * clue: whatever it is, the client's own prediction hides it from its owner and shows it to everyone else.
 *
 * server/sim/players.ts:23 documents a decision that has exactly that shape. When the queue is empty the tick
 * is FILLED: the survivor STANDS STILL for that tick, and the real command that was meant for it is discarded
 * as late when it finally lands. The comment says this "costs at most one tick of smoothness on a lost packet,
 * which the client's own prediction hides" -- true for the owner, and only for the owner. For every other
 * player that tick is the body genuinely stopping in the world, and the interpolation reproduces the stop
 * faithfully, because a stop is what the server actually sent.
 *
 * tools/test-server-sim.mjs already proves the mechanism works as designed (its case d). Nobody ever asked the
 * question this file asks: with the REAL client sender on one end and the REAL queue on the other, over a link
 * with ordinary jitter, HOW OFTEN does it happen? A fill per minute is a decision. A fill per second is a bug
 * wearing a decision's clothes.
 *
 * So this wires client/net/commands.ts (sampling, the +-2% dilation steered by bufDepth, the 3x redundancy,
 * the token bucket) to server/sim/players.ts (acceptInput, takeCommand, bufferDepth) across a delayed, jittery,
 * lossy link, and counts. Nothing is mocked but the wire and the clock.
 *
 * WHAT IT FOUND (keep this, it is the reason cases 4-6 exist).
 *
 * On a clean link the queue is healthy: depth sits at ~2.9 against a target of 2 and it never runs dry, even
 * at 120 ms with 25 ms of jitter and 2% loss. A playtest log agreed from the other side -- one prediction
 * correction a MINUTE, zero client drops -- so this was NOT the hitch that playtest reported.
 *
 * What it did find is a lock that only a hitching CLIENT triggers. A long frame makes at most
 * MAX_COMMANDS_PER_FRAME commands, the server queue empties, and the fill that follows ADVANCES THE SEQUENCE:
 * so the real command for that tick lands and is refused as late, the queue stays empty, the next tick
 * fills again, and the next real command is refused too. One 150 ms hitch becomes ~14 ticks of the body
 * standing still for everyone watching, and 1638 real commands refused in 19 s. A hitching SERVER cannot do
 * this: it catches up at most MAX_CATCHUP_TICKS and drops the rest, so a late heartbeat consumes less, never
 * more -- the queue overflows instead, which is the harmless direction.
 *
 * Cases 4-6 are reported, not checked, until that lock is fixed; then they become guards.
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

let seed = 987654321;
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
 * each tick consumes one command. `clientDt(i)` / `serverDt(i)` give the length of frame / heartbeat i, so a
 * hitch on either side is simply a long one. Every SNAP_NEAR_EVERY_TICKS the server answers with the queue depth
 * and the ack, which is what closes the dilation loop.
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
	let ticksSteady = 0;
	let fillsSteady = 0;
	let lateSteady = 0;
	let overflowSteady = 0;
	let depthSum = 0;
	let depthMin = 99;
	let worstRun = 0;
	let currentRun = 0;
	let droppedTicks = 0;
	/** counters at the end of the warm-up: late/overflow/seqWindow are counted where a packet LANDS, not per tick */
	let atWarmup;

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
			for (let i = down.size() - 1; i >= 0; i--) {
				if (down[i].at <= t) {
					client.noteBufDepth(down[i].depth);
					client.ack(down[i].ack);
					down.unorderedRemove(i);
				}
			}
			out.clear();
			client.sample(dt, raw, out);
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
			for (let i = up.size() - 1; i >= 0; i--) {
				if (up[i].at <= t) {
					PL.acceptInput(sp, up[i].pkt, now);
					up.unorderedRemove(i);
				}
			}
			if (atWarmup === undefined && t >= WARMUP_S) atWarmup = { ...sp.counters };
			acc += Math.min(dt, 1);
			let ran = 0;
			while (acc >= SIM_DT - 1e-9 && ran < CFG.MAX_CATCHUP_TICKS) {
				acc -= SIM_DT;
				ran += 1;
				const c = sp.counters;
				const before = { filled: c.filled };
				const depth = PL.bufferDepth(sp);
				PL.takeCommand(sp);
				const filled = c.filled - before.filled;
				if (t >= WARMUP_S) {
					ticksSteady += 1;
					fillsSteady += filled;
					depthSum += depth;
					if (depth < depthMin) depthMin = depth;
					if (filled > 0) {
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

	const n = Math.max(1, ticksSteady);
	const c = sp.counters;
	const w = atWarmup ?? c;
	lateSteady = c.late - w.late;
	overflowSteady = c.inputOverflow - w.inputOverflow;
	const seqWindow = c.seqWindow - w.seqWindow;
	const resync = c.resync - w.resync;
	return {
		fillsPerSecond: (fillsSteady / n) * CFG.SIM_HZ,
		lateSteady,
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

const CASES = [
	// the clean links are the regression guard: the queue must never run dry on them
	{ name: "1) LAN: 20 ms, sem jitter, sem perda", rtt: 0.02, jitter: 0, loss: 0, guard: true },
	{ name: "2) tipico: 60 ms, 8 ms de jitter", rtt: 0.06, jitter: 0.008, loss: 0, guard: true },
	{ name: "3) ruim: 120 ms, 25 ms de jitter, 2% de perda", rtt: 0.12, jitter: 0.025, loss: 0.02, guard: true },
	/*
	 * The loaded machine. Studio playtests run the server and every client on ONE computer, and the playtest
	 * that reported the hitch was exactly that. These three separate WHICH side's hitch empties the queue: the
	 * server's cannot by construction (it runs at most MAX_CATCHUP_TICKS and drops the rest of the time, so a
	 * late heartbeat consumes less, never more), the client's can (a long frame makes at most
	 * MAX_COMMANDS_PER_FRAME commands and drops the others).
	 */
	{ name: "4) cliente engasga: 1 quadro em 20 leva 150 ms", rtt: 0.06, jitter: 0.008, clientDt: hitchEvery20(150) },
	{
		name: "5) servidor engasga: 1 heartbeat em 20 leva 100 ms",
		rtt: 0.06,
		jitter: 0.008,
		serverDt: hitchEvery20(100),
	},
	{
		name: "6) os dois: Studio com servidor e clientes no mesmo PC",
		rtt: 0.02,
		jitter: 0.004,
		clientDt: hitchEvery20(120),
		serverDt: hitchEvery20(80),
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
		`        ${r.fillsPerSecond.toFixed(2)} preench./s (pior sequencia ${r.worstRun}), ${r.lateSteady} atrasados, ` +
			`${r.overflowSteady} transbordos, ${r.stallDropped} descartados no cliente, ${r.droppedTicks} ticks perdidos no servidor, ${r.seqWindow} fora da janela, ${r.resync} reancoragens`,
	);
	if (!c.guard) continue;
	/*
	 * The budget. A fill is not free: the body stops for a tick in the world everyone else is watching, AND the
	 * real command for that tick is thrown away, so the owner's prediction has to be corrected for a step the
	 * server simply refused. Once every few seconds is an event; several a second is a texture, and a texture is
	 * what "all the time, naturally" describes.
	 */
	check("a fila nao seca repetidamente", r.fillsPerSecond < 1, r.fillsPerSecond.toFixed(2) + " por segundo");
	check("nunca seca por varios ticks seguidos", r.worstRun <= 2, "pior sequencia " + r.worstRun + " ticks");
}

console.log("");
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
}
console.log("OK: a fila de input se mantem cheia -- o corpo nao para para quem olha de fora");
