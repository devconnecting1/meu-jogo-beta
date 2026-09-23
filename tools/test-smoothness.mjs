#!/usr/bin/env node
/*
 * Is another survivor DRAWN smoothly? (docs/MULTIPLAYER.md §5.1, §11.3 F1)
 *
 *   npm run test:smoothness
 *   node tools/test-smoothness.mjs --hz 20 --rtt 60 --jitter 8 --loss 0
 *
 * A playtest reported an ally moving "almost like teleporting". Delay and stutter are different faults: a
 * 100 ms interpolation buffer is MEANT to render slightly behind, and is meant to look perfectly smooth
 * doing it. Snapshots arrive 20 times a second and the screen draws 60, so two of every three frames are
 * pure interpolation -- if those frames do not move, the survivor walks in steps no matter how healthy the
 * network is.
 *
 * This drives the real SnapshotBuffer (client/net/snapshotBuffer.ts is pure) with a synthetic server: a
 * survivor walking at the game's own speed, snapshots at SNAP_NEAR_HZ, delivered with latency, jitter and
 * loss. Then it measures the DRAWN position frame by frame, which is the thing the eye complains about.
 *
 * What it proves:
 *   1. on a clean line every rendered frame moves, and by about the same amount (no steps);
 *   2. with jitter and 10% loss it still never freezes and never jumps;
 *   3. the delay stays inside INTERP_MIN_S..INTERP_MAX_S and follows the measured interval;
 *   4. a turn is rounded, not cut: the path never leaves the corridor the server actually walked;
 *   5. the mid ring (10 Hz, the rate a FAR ally is sent at) is the honest worst case, and is reported.
 *
 * Pure Node (>= 18) plus the project's TypeScript, same shims as the other tools.
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
};
globalThis.os = { clock: () => now };
globalThis.typeIs = (v, t) => (t === "number" ? typeof v === "number" : typeof v === t);

// mesmos shims de Luau/roblox-ts que tools/test-sim.mjs usa (Color3, metodos de Array)
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
// roblox-ts calls Map.size() as a METHOD; in JS it is an accessor, so swap it for one that returns the
// same number (these modules never read `.size` as a property)
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
	// roblox-ts comparators return a boolean ("a before b")
	return jsSort.call(this, (a, b) => {
		const r = cmp(a, b);
		if (typeof r !== "boolean") return r;
		return r ? -1 : cmp(b, a) ? 1 : 0;
	});
});

let now = 1000;
/** GetServerTimeNow() of server tick 0, as InitBegin reports it (§4.5) */
const EPOCH = 5000;

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
	if (req.startsWith("shared/") || req.startsWith("client/")) return join(SRC, req + ".ts");
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

const { SnapshotBuffer } = require(join(SRC, "client/net/snapshotBuffer.ts"));
const { ClockSync } = require(join(SRC, "client/net/clockSync.ts"));
const CFG = require(join(SRC, "shared/net/mpConfig.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const { SPEED_SCALE } = require(join(SRC, "shared/sim/types.ts"));

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const num = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};

/** a survivor's own walking speed: what an ally is actually seen doing */
const WALK = DESIGN.MOVE_SPEED * SPEED_SCALE;
const FPS = 60;
const FRAME_DT = 1 / FPS;
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

/** deterministic noise, so a failure is always the same failure */
let seed = 12345;
function rand() {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
}

/**
 * Runs one survivor past the buffer and returns what was DRAWN each frame.
 *
 * `path(t)` is the server's truth at time t. The server ticks at SIM_HZ and emits a snapshot every
 * `everyTicks`; each one is delivered `rtt/2 + jitter` later, or dropped.
 */
function run({
	seconds = 6,
	everyTicks = CFG.SNAP_NEAR_EVERY_TICKS,
	rtt = 0.06,
	jitter = 0,
	loss = 0,
	path,
	clock,
	hitch,
}) {
	const buf = new SnapshotBuffer();
	buf.setRate(CFG.SIM_HZ);
	now = 1000;

	const inFlight = [];
	const drawn = [];
	let serverTick = 0;
	let serverTime = 0;
	let nextFrame = 0;

	const totalTicks = Math.round(seconds / SIM_DT);
	for (let t = 0; t <= totalTicks; t++) {
		serverTick = t;
		serverTime = t * SIM_DT;

		if (t % everyTicks === 0 && rand() >= loss) {
			const at = path(serverTime);
			const wobble = jitter > 0 ? (rand() * 2 - 1) * jitter : 0;
			inFlight.push({
				arriveAt: serverTime + rtt / 2 + wobble,
				part: {
					tick: serverTick % 65536,
					part: 0,
					parts: 1,
					players: [
						{
							slot: 1,
							x: at.x,
							y: at.y,
							aim: 0,
							flags: 0,
							weapon: 0,
							swing: 0,
							hp: 1,
							revive: 0,
							feetCycle: 0,
						},
					],
					zombies: [],
					bosses: [],
					extras: [],
				},
			});
		}

		// the client draws at FPS while the server ticks at SIM_HZ
		while (nextFrame <= serverTime) {
			now = 1000 + nextFrame;
			for (let i = inFlight.length - 1; i >= 0; i--) {
				if (inFlight[i].arriveAt <= nextFrame) {
					buf.receive(inFlight[i].part, serverTick, now);
					inFlight.splice(i, 1);
				}
			}
			// the client's own estimate of the server tick (a perfect clock: the clock is tested elsewhere)
			const frameDt = hitch !== undefined ? hitch(nextFrame) : FRAME_DT;
			const tick = clock !== undefined ? clock.update(frameDt, EPOCH + nextFrame) : nextFrame / SIM_DT;
			buf.advance(frameDt, tick, now);
			const states = buf.states();
			if (states.length > 0) drawn.push({ t: nextFrame, dt: frameDt, x: states[0].x, y: states[0].y });
			nextFrame += hitch !== undefined ? hitch(nextFrame) : FRAME_DT;
		}
	}
	return { drawn, stats: buf.stats(), delay: buf.delay() };
}

/** per-frame displacement of what was drawn, ignoring the first frames before the buffer has two samples */
function motion(drawn, skip = 30) {
	const steps = [];
	for (let i = skip + 1; i < drawn.length; i++) {
		const dx = drawn[i].x - drawn[i - 1].x;
		const dy = drawn[i].y - drawn[i - 1].y;
		steps.push(Math.sqrt(dx * dx + dy * dy));
	}
	const still = steps.filter(s => s < 0.01).length;
	const max = steps.reduce((a, b) => Math.max(a, b), 0);
	const mean = steps.reduce((a, b) => a + b, 0) / Math.max(1, steps.length);
	return { steps, still, max, mean };
}

const straight = t => ({ x: 1000 + WALK * t, y: 1000 });
/** a right-angle turn at 3 s: the case where a cut corner would show */
const corner = t => (t < 3 ? { x: 1000 + WALK * t, y: 1000 } : { x: 1000 + WALK * 3, y: 1000 + WALK * (t - 3) });

const expected = WALK * FRAME_DT;
console.log(
	`sobrevivente a ${WALK} u/s, tela a ${FPS} fps, snapshot a ${CFG.SNAP_NEAR_HZ} Hz ` +
		`-> ${expected.toFixed(2)} u por quadro desenhado, 1 snapshot a cada ${(FPS / CFG.SNAP_NEAR_HZ).toFixed(0)} quadros`,
);

// ---------------------------------------------------------------- 1: clean line

console.log("\n1) linha limpa: todo quadro anda, e anda igual");
{
	const { drawn, stats, delay } = run({ rtt: 0.06, path: straight });
	const m = motion(drawn);
	check("nenhum quadro parado", m.still === 0, `${m.still} de ${m.steps.length} quadros sem movimento`);
	check("nenhum salto", m.max < expected * 1.6, `maior ${m.max.toFixed(2)} u vs ${expected.toFixed(2)} esperado`);
	check("passo medio bate com a velocidade", Math.abs(m.mean - expected) < 0.2, `${m.mean.toFixed(2)} u/quadro`);
	check("nenhuma travada", stats.stalls === 0, `${stats.stalls} travadas`);
	check(
		"atraso dentro da faixa",
		delay >= CFG.INTERP_MIN_S - 1e-9 && delay <= CFG.INTERP_MAX_S,
		`${(delay * 1000).toFixed(0)} ms`,
	);
}

// ---------------------------------------------------------------- 2: jitter and loss

console.log("\n2) com jitter de 15 ms e 10% de perda");
{
	const { drawn, stats } = run({ rtt: 0.12, jitter: 0.015, loss: 0.1, path: straight });
	const m = motion(drawn);
	check("nunca congela", m.still === 0, `${m.still} quadros parados`);
	check("nunca teleporta", m.max < expected * 3, `maior ${m.max.toFixed(2)} u (limite ${(expected * 3).toFixed(2)})`);
	check("nao perde o passo", Math.abs(m.mean - expected) < 0.3, `${m.mean.toFixed(2)} u/quadro`);
	console.log(
		`        (aceitos ${stats.accepted}, descartados ${stats.dropped}, travadas ${stats.stalls}, ` +
			`intervalo ${(stats.interval * 1000).toFixed(0)} ms, jitter ${(stats.jitter * 1000).toFixed(0)} ms)`,
	);
}

// ---------------------------------------------------------------- 3: the turn

console.log("\n3) a curva e arredondada, nao cortada");
{
	const { drawn } = run({ seconds: 6, rtt: 0.06, path: corner });
	const m = motion(drawn);
	check("nenhum quadro parado na curva", m.still === 0, `${m.still} quadros`);
	check("sem salto na curva", m.max < expected * 1.8, `maior ${m.max.toFixed(2)} u`);
	// the interpolated path may cut the corner, but never by more than one snapshot of travel
	const budget = WALK / CFG.SNAP_NEAR_HZ;
	let worst = 0;
	for (const d of drawn) {
		const dxFromL = Math.min(Math.abs(d.y - 1000), Math.abs(d.x - (1000 + WALK * 3)));
		if (d.x > 1000 && d.y > 1000) worst = Math.max(worst, dxFromL);
	}
	check(
		"nao sai do corredor do servidor",
		worst <= budget,
		`${worst.toFixed(1)} u (orcamento ${budget.toFixed(1)} u)`,
	);
}

// ---------------------------------------------------------------- 4: the mid ring

console.log("\n4) anel medio (10 Hz): o pior caso honesto de um aliado distante");
{
	const { drawn, stats, delay } = run({ everyTicks: CFG.SNAP_MID_EVERY_TICKS, rtt: 0.06, path: straight });
	const m = motion(drawn);
	check("ainda sem quadro parado", m.still === 0, `${m.still} quadros`);
	check("ainda sem teleporte", m.max < expected * 2, `maior ${m.max.toFixed(2)} u`);
	console.log(
		`        (atraso ${(delay * 1000).toFixed(0)} ms, intervalo medido ${(stats.interval * 1000).toFixed(0)} ms, travadas ${stats.stalls})`,
	);
}

// ---------------------------------------------------------------- 5: the real clock, on a stuttering client

console.log("");
console.log("5) relogio real (ClockSync) num cliente engasgando");
{
	const clock = new ClockSync();
	clock.setEpoch(EPOCH, CFG.SIM_HZ);
	// one frame in twenty takes 150 ms: a loaded machine running a server and two clients at once
	const hitch = t => (Math.floor(t * 60) % 20 === 0 ? 0.15 : FRAME_DT);
	const { drawn, stats } = run({ rtt: 0.06, jitter: 0.01, path: straight, clock, hitch });
	const steps = [];
	for (let i = 31; i < drawn.length; i++) {
		const dx = drawn[i].x - drawn[i - 1].x;
		const dy = drawn[i].y - drawn[i - 1].y;
		// the displacement of frame i belongs to frame i's own dt, not to the gap before it: a 150 ms frame
		// is SUPPOSED to move nine times as far, and dividing by the wrong dt invents a teleport
		const dt = drawn[i].dt;
		// compare SPEED, not displacement: a 150 ms frame is supposed to move further
		steps.push(dt > 0 ? Math.sqrt(dx * dx + dy * dy) / dt : 0);
	}
	const maxSpeed = steps.reduce((a, b) => Math.max(a, b), 0);
	const still = steps.filter(v => v < 1).length;
	check("nenhum quadro parado", still === 0, still + " quadros abaixo de 1 u/s");
	check(
		"velocidade desenhada nunca dispara",
		maxSpeed < WALK * 1.6,
		maxSpeed.toFixed(0) + " u/s vs " + WALK + " real",
	);
	check("o relogio nao deu salto", stats.stalls === 0, stats.stalls + " travadas");
}

console.log("");
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
}
console.log("OK: linha limpa, jitter com perda, curva e anel medio — o desenho do aliado e continuo");
