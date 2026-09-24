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
 *  10. an ally put 2000 u away (a stand-up at daybreak, a Rebirth) appears there fading in, never sliding (N3).
 *   9. an ally who puts the weapon away (DESIGN_RULES ITM-06, protocol decision 20) arrives as the reserved weapon
 *      byte, discrete (never a blend, never a flicker back), with the walk untouched, and is drawn empty-handed.
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
/** the camera scale the game runs at (shared/engine/camera.ts): 1 world unit is 1 pixel */
const ZOOM = 1;
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
			if (states.length > 0) {
				drawn.push({ t: nextFrame, dt: frameDt, x: states[0].x, y: states[0].y, alpha: states[0].alpha ?? 1 });
			}
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

// ---------------------------------------------------------------- 6: all the way to the pixel

/*
 * Cases 1-5 measure WORLD units, and that was the hole: the buffer can be perfectly continuous while what
 * reaches the screen is not. The renderer rounds every sprite to a whole pixel
 * (shared/engine/renderer.ts: math.floor(scr.x + 0.5)), and the camera is locked to the LOCAL survivor --
 * so the local body never moves on screen at all, and every bit of rounding error lands on the ally.
 *
 * The case that matters in co-op is walking BESIDE someone: the relative motion on screen is near zero, so
 * the rounded position sits on a boundary and can flip back and forth. A pixel that moves backwards while
 * the survivor is walking forwards is what an eye reads as stutter.
 */
const ROUND = v => Math.floor(v + 0.5);
const VIEW_W = 1120;

function drawnPixels(drawn, camAt) {
	const px = [];
	// skip the warm-up: before the buffer holds two samples the position is legitimately still, and
	// counting those frames would invent a stutter that is not there (the mistake that cost a false
	// report of a 1890 u/s teleport earlier)
	for (const d of drawn.slice(30)) px.push(ROUND((d.x - camAt(d.t)) * ZOOM + VIEW_W / 2));
	return px;
}

/** frames where the drawn pixel went BACKWARDS, and the longest run of frames it did not move at all */
function pixelFaults(px) {
	let back = 0;
	let stillRun = 0;
	let worstStill = 0;
	for (let i = 1; i < px.length; i++) {
		const d = px[i] - px[i - 1];
		if (d < 0) back += 1;
		if (d === 0) {
			stillRun += 1;
			if (stillRun > worstStill) worstStill = stillRun;
		} else stillRun = 0;
	}
	return { back, worstStill };
}

console.log("");
console.log("6) ate o pixel: camera travada no jogador local + arredondamento do renderer");
{
	const { drawn } = run({ rtt: 0.06, jitter: 0.008, path: straight });

	// (a) voce parado, o aliado passando: a unica leitura em que o pixel DEVE avancar todo quadro.
	// E o caso que pegaria uma interpolacao que anda em degraus.
	const parado = pixelFaults(drawnPixels(drawn, () => 1000));
	check("parado: nenhum pixel para tras", parado.back === 0, parado.back + " quadros");
	check(
		"parado: nenhum congelamento longo",
		parado.worstStill <= 1,
		"maior parada " + parado.worstStill + " quadros",
	);

	/*
	 * (b) voces dois andando JUNTOS, mesma velocidade e direcao.
	 *
	 * Aqui a expectativa certa e o contrario da (a): o que se desenha e a posicao RELATIVA, e ela e
	 * constante -- o aliado tem que ficar PARADO na tela. Uma versao anterior deste teste exigia
	 * "nenhum pixel para tras" tambem neste caso, o que e exigir movimento onde nao deve haver: ele
	 * falhava com 23 quadros e o defeito era do teste, nao do jogo.
	 *
	 * O que realmente importa medir e a AMPLITUDE: a interpolacao do aliado corre em segmentos de reta
	 * entre amostras de 20 Hz, entao a posicao relativa oscila uma fracao de unidade e o arredondamento
	 * a transforma em pixel. Dentro de uma faixa de 1 px isso e o arredondamento fazendo o trabalho dele.
	 * Se um dia passar disso, virou tremor visivel, e ai e regressao.
	 */
	const juntos = drawnPixels(drawn, t => 1000 + WALK * t);
	let lo = juntos[0];
	let hi = juntos[0];
	for (const p of juntos) {
		if (p < lo) lo = p;
		if (p > hi) hi = p;
	}
	let maxStep = 0;
	for (let i = 1; i < juntos.length; i++) {
		const d = Math.abs(juntos[i] - juntos[i - 1]);
		if (d > maxStep) maxStep = d;
	}
	/*
	 * O guarda certo e o TAMANHO DO PASSO, nao a faixa. Medido: a faixa e de 4 px, mas ela e percorrida
	 * 1 px de cada vez, com umas cinco inversoes por segundo -- e o atraso do buffer se adaptando ao
	 * intervalo medido, e a 60 fps num boneco de 32 px isso nao se le como movimento. O que se leria e um
	 * pulo: 2 px ou mais de uma vez, ou seja, o desenho corrigindo de supetao algo que deveria ter
	 * acompanhado. E isso que este check proibe.
	 */
	check(
		"junto: o aliado nunca pula",
		maxStep <= 1,
		"maior passo " + maxStep + " px (faixa total " + (hi - lo) + " px)",
	);
}
// ---------------------------------------------------------------- 7: the meter the live game prints

/*
 * client/net/hitchMeter.ts counts, on the real client, the jolts an eye calls a stutter, and prints them in the
 * [PZ-NET] line. A meter nobody has checked is a second source of false reports, so it is held to the same
 * standard here: silent on the real buffer, exact on the four shapes it has to tell apart.
 */
const { HitchMeter } = require(join(SRC, "client/net/hitchMeter.ts"));

console.log("");
console.log("7) o medidor de tranco que o jogo imprime no [PZ-NET]");
{
	const feed = frames => {
		const m = new HitchMeter();
		for (const f of frames) {
			m.beginFrame(f.dt);
			m.observe(1, f.x, f.y, f.dt);
		}
		return m.take();
	};
	/** 4 s of walking along x, `stepAt(i)` world units on frame i, every frame lasting `dtAt(i)` */
	const walk = (stepAt, dtAt = () => FRAME_DT) => {
		const frames = [];
		let x = 1000;
		for (let i = 0; i < 240; i++) {
			x += stepAt(i);
			frames.push({ dt: dtAt(i), x, y: 1000 });
		}
		return frames;
	};
	const step = WALK * FRAME_DT;

	// (a) the real buffer on a jittery, lossy line: what the game must print when nothing is wrong
	const { drawn } = run({ rtt: 0.06, jitter: 0.008, loss: 0.02, path: straight });
	const real = feed(drawn);
	check(
		"buffer real: nenhum tranco",
		real.jolts === 0,
		real.jolts + " em " + real.walkingS.toFixed(1) + " s andando",
	);

	// (b) one frozen frame and then on as before: the stutter the playtest described
	const freeze = feed(walk(i => (i === 120 ? 0 : step)));
	check("congela 1 quadro e segue: 1 tranco", freeze.jolts === 1, freeze.jolts + " trancos");

	// (c) a jump to catch up
	const jump = feed(walk(i => (i === 120 ? step * 3 : step)));
	check("pula 3 passos de uma vez: 1 tranco", jump.jolts === 1, jump.jolts + " trancos");

	// (d) a real stop is the player letting go of the key, not a stutter, and is not walking time either
	const stop = feed(walk(i => (i >= 120 ? 0 : step)));
	check("parada de verdade: nenhum tranco", stop.jolts === 0, stop.jolts + " trancos");
	check("o tempo parado nao conta como andando", stop.walkingS < 2.1, stop.walkingS.toFixed(2) + " s de 4");

	// (e) the machine hitching: a 100 ms frame covers 100 ms of walk. Speed is distance over THAT frame's dt,
	// so this is no jolt -- the mistake that once invented a 1890 u/s teleport in case 5.
	const longFrame = feed(
		walk(
			i => (i === 120 ? WALK * 0.1 : step),
			i => (i === 120 ? 0.1 : FRAME_DT),
		),
	);
	check("quadro longo proporcional: nenhum tranco", longFrame.jolts === 0, longFrame.jolts + " trancos");

	// (f) starting to walk from standing is not a jump
	const start = feed(walk(i => (i < 60 ? 0 : step)));
	check("comecar a andar: nenhum tranco", start.jolts === 0, start.jolts + " trancos");
}

// ---------------------------------------------------------------- 8: the delay's lock after a reset

/*
 * Review of 2026-09-23, #5: after `reset()` (a new run, a rebirth, a world reset) the delay locked on the FIRST
 * snapshot's lateness, and from then on only eased at ±5 % of real time. A first snapshot that sat in the link --
 * a straggler 150 ms later than the rest -- set a delay 150 ms too long, for three seconds. It now locks on the
 * median of the first few (snapshotBuffer.ts LOCK_SAMPLES).
 */
console.log("");
console.log("8) depois de um reset, o atraso trava na mediana das primeiras chegadas, nao na primeira");
{
	const buf = new SnapshotBuffer();
	buf.setRate(CFG.SIM_HZ);
	buf.reset();
	const partAt = tick => ({
		tick: tick % 65536,
		part: 0,
		parts: 1,
		players: [
			{ slot: 1, x: 1000 + tick, y: 1000, aim: 0, flags: 0, weapon: 0, swing: 0, hp: 1, revive: 0, feetCycle: 0 },
		],
		zombies: [],
		bosses: [],
		extras: [],
	});
	// the first snapshot after the reset sat 200 ms in the link; every one after it takes the honest 50 ms
	const lateS = [0.2, 0.05, 0.05, 0.05, 0.05];
	let clockTick = 600;
	let t = 0;
	for (const late of lateS) {
		buf.receive(partAt(Math.round(clockTick - late * CFG.SIM_HZ)), clockTick, 1000 + t);
		for (let f = 0; f < 3; f++) {
			buf.advance(FRAME_DT, clockTick, 1000 + t);
			clockTick += 1;
			t += FRAME_DT;
		}
	}
	const s = buf.stats();
	check(
		"a latencia travada e a das chegadas honestas, nao a da primeira",
		Math.abs(s.lateness - 0.05) <= 0.02,
		`${(s.lateness * 1000).toFixed(0)} ms (a primeira: 200 ms, as outras: 50 ms)`,
	);
	check(
		"o atraso nao carrega os 150 ms a mais da primeira chegada",
		buf.delay() <= 0.05 + CFG.INTERP_MIN_S + 0.03,
		`${(buf.delay() * 1000).toFixed(0)} ms`,
	);
}

// ---------------------------------------------------------------- 10: an ally put somewhere new (N3)

console.log(
	"\n10) um aliado posto em outro lugar (levantou ao amanhecer, Rebirth): aparece la, sem deslizar pela cidade",
);
{
	/*
	 * The review of 577c729, N3: a survivor stood up at daybreak or by a Rebirth at a safe spot 2000 u from where they
	 * fell. Interpolated, the ally slid across the town between the two samples. Now the track starts again at the new
	 * spot and the body fades in there (client/net/snapshotBuffer.ts `allyJumped`, client/view/playersView.ts).
	 */
	const jump = t => (t < 3 ? { x: 1000 + WALK * t, y: 1000 } : { x: 3000 + WALK * (t - 3), y: 2400 });
	const res = run({ seconds: 5, rtt: 0.08, jitter: 0.005, path: jump });
	let fast = 0;
	let worst = 0;
	let dip = 1;
	let back = -1;
	for (let i = 31; i < res.drawn.length; i++) {
		const a = res.drawn[i - 1];
		const b = res.drawn[i];
		const d = Math.hypot(b.x - a.x, b.y - a.y);
		dip = Math.min(dip, b.alpha);
		if (b.alpha < 1) back = b.t;
		// a step drawn visibly (alpha over 0.1) is at most the walk, with the §5.1 margin
		if (b.alpha > 0.1) {
			worst = Math.max(worst, d);
			if (d > WALK * b.dt * 1.25 + 4) fast += 1;
		}
	}
	const jumps = res.stats.allyJumps ?? 0;
	console.log(
		`   o salto: ${jumps} trilha(s) recomecada(s), alfa minimo ${dip.toFixed(2)}, de volta a 1 aos ${back.toFixed(2)} s; ` +
			`pior passo desenhado ${worst.toFixed(1)} u`,
	);
	check(
		"o aliado nunca e desenhado deslizando de um lugar ao outro (nenhum passo visivel alem da caminhada)",
		fast === 0,
		`${fast} quadros`,
	);
	check(
		"a trilha recomeca no lugar novo e o corpo aparece aos poucos (alfa de 0 a 1 em menos de meio segundo)",
		jumps === 1 && dip <= 0.1 && back > 3 && back < 3.6,
		`${jumps} recomeco(s), alfa minimo ${dip.toFixed(2)}, de volta aos ${back.toFixed(2)} s`,
	);
	// and a plain walk never trips it
	const plain = run({ seconds: 5, rtt: 0.08, jitter: 0.02, loss: 0.1, path: straight });
	check(
		"uma caminhada com jitter e 10 % de perda nunca recomeca a trilha",
		(plain.stats.allyJumps ?? 0) === 0,
		`${plain.stats.allyJumps ?? 0}`,
	);
}

// ---------------------------------------------------------------- 9: an ally whose weapon is put away (ITM-06)

/*
 * DESIGN_RULES ITM-06 (protocol decision 20): a survivor who puts the weapon away reaches the others as the reserved
 * WEAPON_HOLSTERED byte in the record's weapon field. It is a DISCRETE field: the buffer must hand the view either the
 * weapon or the empty hands -- never a blend, never a flicker back -- and the walk it rides must stay smooth across
 * the change. Then the view draws them empty-handed (client/view/playersView.ts -> survivorView.ts `holstered`).
 */
console.log("");
console.log("9) ITM-06: um aliado que guarda a arma chega de maos vazias, sem piscar, e e desenhado sem arma");
{
	// protocol.ts builds a scratch NetWriter when it loads; this suite never encodes, so a stand-in buffer will do
	globalThis.buffer ??= { create: n => new Uint8Array(n) };
	const P = require(join(SRC, "shared/net/protocol.ts"));
	const AXE = 2;
	const every = CFG.SNAP_NEAR_EVERY_TICKS;
	/** the same ally walking for 4 s, putting the weapon away 1.5 s in (`flipAt`), or never */
	const walkWith = flipAt => {
		const buf = new SnapshotBuffer();
		buf.setRate(CFG.SIM_HZ);
		buf.reset();
		const partAt = tick => ({
			tick: tick % 65536,
			part: 0,
			parts: 1,
			players: [
				{
					slot: 1,
					x: 1000 + (tick - 600) * WALK * SIM_DT,
					y: 1000,
					aim: 0,
					flags: 1,
					weapon: tick >= flipAt ? P.WEAPON_HOLSTERED : AXE,
					swing: 0,
					hp: 1,
					revive: 0,
					moveAng: 0,
				},
			],
			zombies: [],
			bosses: [],
			extras: [],
		});
		let clockTick = 600;
		let t = 0;
		const seen = [];
		const xs = [];
		for (let tick = 600; tick < 600 + 240; tick += 1) {
			if ((tick - 600) % every === 0) buf.receive(partAt(tick), clockTick, 1000 + t);
			buf.advance(FRAME_DT, clockTick, 1000 + t);
			const s = buf.states().find(p => p.slot === 1);
			if (s !== undefined) {
				seen.push(s.weapon);
				xs.push(s.x);
			}
			clockTick += 1;
			t += FRAME_DT;
		}
		return { seen, xs };
	};
	const { seen, xs } = walkWith(600 + 90);
	const control = walkWith(Infinity);
	const values = [...new Set(seen)];
	let flips = 0;
	for (let i = 1; i < seen.length; i++) if (seen[i] !== seen[i - 1]) flips += 1;
	check(
		"o byte e discreto: so a arma ou as maos vazias, nunca outro valor",
		values.every(v => v === AXE || v === P.WEAPON_HOLSTERED) && values.length === 2,
		values.join(", "),
	);
	check(
		"troca uma vez so, da arma para as maos vazias (sem piscar de volta)",
		flips === 1 && seen.at(-1) === P.WEAPON_HOLSTERED,
	);
	let worst = 0;
	for (let i = 0; i < xs.length; i++) worst = Math.max(worst, Math.abs(xs[i] - (control.xs[i] ?? Infinity)));
	check(
		"e a caminhada que ela carrega e a mesma, quadro a quadro, de quem nunca guardou a arma (nenhum tranco)",
		xs.length === control.xs.length && worst === 0,
		`${xs.length} quadros; maior diferenca ${worst} u`,
	);

	// the drawing: the very drawSurvivor every survivor goes through, on a renderer that only records -- in both of its
	// looks (ART-01 / ART-09): the flat drawing (no ids) and the pixel art of the uploaded sheets
	const SV = require(join(SRC, "client/view/survivorView.ts"));
	const WA = require(join(SRC, "client/view/worldArt.ts"));
	const { WORLD_ART } = require(join(SRC, "client/view/worldArtAssets.ts"));
	const { Camera } = require(join(SRC, "shared/engine/camera.ts"));
	const { COLORS } = require(join(SRC, "shared/engine/colors.ts"));
	/** every texture with an id (`on`: a stand-in where none is uploaded yet), or none at all */
	const artIds = on => {
		const ids = {};
		for (const [name, tex] of Object.entries(WORLD_ART)) ids[name] = on ? tex.id || `local:${name}` : "";
		return ids;
	};
	const calls = [];
	const rec = {
		drawRect: (cam, x, y, o) => calls.push({ x, y, ...o }),
		drawCircle: (cam, x, y, d, o) => calls.push({ x, y, w: d, h: d, circle: true, ...o }),
		drawSegment: (cam, x1, y1, x2, y2, o) =>
			calls.push({ x: (x1 + x2) / 2, y: (y1 + y2) / 2, segment: true, ...o }),
	};
	const cam = new Camera();
	cam.setView(800, 600);
	const draw = (weaponByte, ids) => {
		const look = SV.createLook();
		// what client/view/playersView.ts fills from the interpolated state
		look.weapon = SV.weaponById(weaponByte);
		look.holstered = weaponByte === P.WEAPON_HOLSTERED;
		calls.length = 0;
		SV.drawSurvivor(rec, cam, look, SV.createSwingTrail());
		const inHand = calls.filter(
			c => c.zIndex === look.z && (c.color === COLORS.blade || c.color === COLORS.weapon),
		);
		const hands = calls.filter(c => c.circle === true && c.w === 10);
		const weaponCells = ids === undefined ? 0 : calls.filter(c => c.image === ids.weapons).length;
		return { inHand: inHand.length, hands: hands.length, weaponCells };
	};
	WA.overrideWorldArt(artIds(false));
	const armed = draw(AXE);
	const empty = draw(P.WEAPON_HOLSTERED);
	check("desenho liso, com a arma: o Axe e desenhado na mao", armed.inHand > 0, `${armed.inHand} partes`);
	check(
		"desenho liso, com as maos vazias (WEAPON_HOLSTERED): nenhuma arma desenhada, as duas maos em repouso",
		empty.inHand === 0 && empty.hands === 2,
		`${empty.inHand} partes de arma, ${empty.hands} maos`,
	);
	const lit = artIds(true);
	WA.overrideWorldArt(lit);
	const armedArt = draw(AXE, lit);
	const emptyArt = draw(P.WEAPON_HOLSTERED, lit);
	const armedAgain = draw(AXE, lit);
	check(
		"pixel art: armado, a celula da arma; de maos vazias, nenhuma -- logo depois de desenhar alguem armado",
		armedArt.weaponCells === 1 && emptyArt.weaponCells === 0 && armedAgain.weaponCells === 1,
		`${armedArt.weaponCells} / ${emptyArt.weaponCells} / ${armedAgain.weaponCells} celulas de arma`,
	);
	WA.overrideWorldArt(undefined);
}
console.log("");
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
}
console.log("OK: linha limpa, jitter com perda, curva e anel medio — o desenho do aliado e continuo");
