#!/usr/bin/env node
/*
 * Enemy AI tests (docs/DESIGN_RULES.md P2 / MP-09, docs/MULTIPLAYER.md §3.3, §3.4).
 *
 *   npm run test:ai                       # everything (exit code 1 on any failure)
 *   node tools/test-ai.mjs --seed 42      # another seed for the scripted scenarios
 *   node tools/test-ai.mjs --bench        # only the cost measurement
 *   PZ_SRC=path/to/older/src node tools/test-ai.mjs --bench
 *                                         # same benchmark against another checkout (before/after numbers)
 *
 * What it proves, on hand-built worlds and on the generated town:
 *
 *   1. SIGHT     a survivor behind a wall is not seen, one in the open is (a glimpse first, then a sighting), one
 *                behind the zombie is not, a parked car hides nobody; at night the survivor's own light decides it
 *                (glow < torch < flashlight, and a beam on a zombie's back gives you away) — no blanket night alert;
 *  1b. EARS      noise by action (a gun by class, building, running, walking, a blow), day and night, masked by the
 *                rain; a noise makes a zombie suspicious and walk to the SOURCE, and the server grades real shots;
 *   2. STATES    chasing → loses sight → suspicious (walks to the LAST KNOWN POSITION) → searching (hops and looks)
 *                → gives up; a place it cannot reach is searched from where it got stuck;
 *   3. ALERT     a groan wakes at most ALERT_MAX_WAKE zombies, suspicious, and cannot relay itself (no cascade);
 *  3b. WAVES     a night-wave zombie is always chasing, behind walls, and never turns into a search party;
 *  3c. STORY     wander → gunshot → investigate → spot → groan → chase → lose sight → search → give up, timed;
 *  3d. MOTION    gaits vary within today's speeds, the body turns instead of snapping, no stacking, no flicker;
 *   4. FLANK     20 zombies against a building with two doors use both, instead of queueing at one;
 *   5. DIRECTOR  intensity peaks are followed by a mandatory quiet stretch, and the wave queues are never cut;
 *   6. MP-09     nothing is ever placed within 720 u of a survivor, and the horde never passes 150;
 *   7. DETERM.   same seed → same state hash (the AI may move to the server without drifting from the client);
 *   8. BITE      the bite is telegraphed, can be stepped out of, and a heavy hit staggers;
 *   9. COST      average µs per zombie per frame with 150 zombies, near and far (the §3.4 LOD);
 *  10. SERVER    one authoritative horde for everyone: the multi-source field owns each cell by the survivor
 *                it can really reach first (§3.3), MP-09 holds against ALL survivors, netIds are stable and
 *                recycled (§4.4), deaths come out once — and the client stops simulating at MP_PHASE >= 2;
 *  11. TICK      the §3.2 measurement: cost of a whole server tick with 150 zombies and 6 survivors.
 *
 * Pure Node (>= 18) + the project's TypeScript (devDependency) to transpile src on the fly, with the same
 * Luau / roblox-ts shims tools/test-sim.mjs uses. `math.random` is replaced by a seeded generator, so every
 * run is reproducible and the determinism check means something.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(process.env.PZ_SRC ?? join(ROOT, "src"));
const require = createRequire(import.meta.url);
const Module = require("node:module");
const ts = require("typescript");

// ---------------------------------------------------------------- seeded randomness

/** mulberry32: the whole suite runs on this, never on Math.random */
let rngState = 1;
function setSeed(s) {
	rngState = s >>> 0;
}
function nextRandom() {
	rngState = (rngState + 0x6d2b79f5) >>> 0;
	let t = rngState;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

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
	round: x => (x < 0 ? -Math.round(-x) : Math.round(x)),
	random: (a, b) =>
		a === undefined
			? nextRandom()
			: b === undefined
				? 1 + Math.floor(nextRandom() * a)
				: a + Math.floor(nextRandom() * (b - a + 1)),
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
shim("insert", function (i, v) {
	this.splice(i, 0, v);
});
// roblox-ts Map/Set expose size() as a method, and a string knows its own length the same way
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size").get;
Object.defineProperty(Map.prototype, "size", {
	value: function () {
		return mapSize.call(this);
	},
	configurable: true,
	writable: true,
});
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, "size").get;
Object.defineProperty(Set.prototype, "size", {
	value: function () {
		return setSize.call(this);
	},
	configurable: true,
	writable: true,
});
Object.defineProperty(String.prototype, "size", {
	value: function () {
		return Buffer.byteLength(this.valueOf(), "utf8");
	},
	configurable: true,
	writable: true,
});
const jsSort = AP.sort;
shim("sort", function (cmp) {
	if (!cmp) return jsSort.call(this);
	return jsSort.call(this, (a, b) => {
		const r = cmp(a, b);
		if (typeof r !== "boolean") return r;
		return r ? -1 : cmp(b, a) ? 1 : 0;
	});
});

// Luau `buffer` and `typeIs`, the same strict shims tools/test-server-sim.mjs uses: the server modules
// reach shared/net/protocol.ts, which builds packets at load time.
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

// "shared/x" → SRC/shared/x.ts, transpiled with the project's TypeScript
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
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const { createPlayer } = require(join(SRC, "shared/game/player.ts"));
const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
const { createZombie, resetEntityIds } = require(join(SRC, "shared/game/entities.ts"));
const zombieAI = require(join(SRC, "client/systems/zombieAI.ts"));
const { Spawner } = require(join(SRC, "client/systems/spawner.ts"));
const { DayNight } = require(join(SRC, "client/systems/daynight.ts"));

/** the shared/sim/ai modules only exist after the AI work: an older src runs the measurements only */
function optional(path) {
	try {
		return require(join(SRC, path));
	} catch (err) {
		if (process.env.PZ_DEBUG) console.log("optional failed:", path, String(err).slice(0, 300));
		return undefined;
	}
}
const simulationMod = optional("server/sim/simulation.ts");
const serverPlayers = optional("server/sim/players.ts");
const flowFieldMod = optional("server/sim/flowField.ts");
const zombiesMod = optional("server/sim/zombies.ts");
const mpConfig = optional("shared/net/mpConfig.ts");
/*
 * These tests drive the shared AI through the CLIENT adapter (client/systems/zombieAI.ts), and that adapter
 * is deliberately inert from MP_PHASE 2 on — the server owns the horde, so a client that still stepped it
 * would be simulating a second one. The behaviour under test is the same in both phases (one `updateZombies`
 * in shared/sim/ai), so the harness pins the phase to 1 and the one test that is ABOUT the phase (see
 * "MP_PHASE >= 2 the client does not move a single zombie") flips it around itself.
 */
if (mpConfig !== undefined) mpConfig.MP_PHASE = 1;
const SERVER = simulationMod !== undefined && flowFieldMod !== undefined && zombiesMod !== undefined;
const perception = optional("shared/sim/ai/perception.ts");
const memoryMod = optional("shared/sim/ai/memory.ts");
const alertMod = optional("shared/sim/ai/alert.ts");
const directorMod = optional("shared/sim/ai/director.ts");
const noiseMod = optional("shared/sim/ai/noise.ts");
const tuning = optional("shared/sim/ai/zombieTuning.ts");
const lightMod = optional("shared/sim/survivorLight.ts");
/** the senses, states and ears of DESIGN_RULES IA-01..04; an older src (PZ_SRC) runs the measurements only */
const MODERN =
	perception !== undefined &&
	memoryMod !== undefined &&
	alertMod !== undefined &&
	noiseMod !== undefined &&
	lightMod !== undefined;

// ---------------------------------------------------------------- CLI / reporting

const args = process.argv.slice(2);
const numArg = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};
const SEED = numArg("--seed", 20260922);
const BENCH_ONLY = args.includes("--bench");
/** only the §3.2 server-tick measurement: a clean process, so the numbers are not a previous test's GC */
const TICK_ONLY = args.includes("--tick");

let failures = 0;
const fail = msg => {
	failures++;
	console.log(`  FAIL  ${msg}`);
};
const ok = msg => console.log(`  ok    ${msg}`);
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
const info = msg => console.log(`        ${msg}`);

// ---------------------------------------------------------------- scaffolding

const DT = 1 / 60;

function wall(world, x, y, w, h) {
	return W.addSolid(world, {
		kind: w >= h ? "wall_h" : "wall_v",
		x,
		y,
		w,
		h,
		hp: 1000,
		hpMax: 1000,
		destructible: false,
		tags: "bwall",
		rot: 0,
	});
}

/** a GameRefs good enough for zombieAI / spawner: no Instances, no view, effects collected in an array */
function makeRefs(world, px, py, opts = {}) {
	const save = defaultSave();
	const player = createPlayer(save, px, py);
	const daynight = new DayNight(save);
	daynight.day = opts.day ?? 1;
	daynight.dayTime = opts.hour ?? 12;
	daynight.isRaining = opts.raining ?? false;
	daynight.update(0);
	daynight.isNight = opts.night ?? daynight.isNight;
	daynight.darkAlpha = opts.darkness ?? (opts.night ? 0.85 : 0);
	return {
		world,
		players: [player],
		player,
		save,
		input: {},
		zombies: [],
		bosses: [],
		bullets: [],
		daynight,
		pendingPlace: 0,
		fx: [],
		onMessage: () => {},
		onExp: () => {},
	};
}

/** a zombie of `type` at (x, y) facing `angle`, added to refs */
function addZombie(refs, type, x, y, angle = 0) {
	const z = createZombie(type, x, y, refs.daynight.day, false);
	z.detect = false;
	z.angle = angle;
	z.angleSlow = angle;
	refs.zombies.push(z);
	return z;
}

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

function run(refs, frames, onFrame) {
	for (let f = 0; f < frames; f++) {
		if (onFrame !== undefined) onFrame(f);
		zombieAI.updateZombies(refs, DT);
	}
}

// ---------------------------------------------------------------- 1. sight and light

const AWARE_NAMES = ["idle", "suspicious", "searching", "chasing"];
const awareOf = z => z.aware ?? 0;

/** a zombie that stands where it is put, facing where it is put (no wander leg turns it away mid-test) */
function still(z) {
	z.wanderPause = true;
	z.wanderTimer = 999;
	return z;
}

/** frames until `pred()` holds (running the AI each frame), or -1 */
function framesUntil(refs, maxFrames, pred, onFrame) {
	for (let f = 0; f < maxFrames; f++) {
		if (onFrame !== undefined) onFrame(f);
		zombieAI.updateZombies(refs, DT);
		if (pred()) return f + 1;
	}
	return -1;
}

/** the survivor's light: 13 = flashlight, 15 = torch, -1 = only their own glow */
function holdLight(refs, equip) {
	refs.save.equipHand = equip;
}

function parkedCar(world, x, y) {
	return W.addSolid(world, {
		kind: "car",
		x,
		y,
		w: 200,
		h: 100,
		hp: 1000,
		hpMax: 1000,
		destructible: false,
		tags: "car",
		rot: 0,
	});
}

function testSight() {
	console.log("\n[1] eyes: range, cone, walls, darkness and the survivor's own light (perception.ts)");
	const S = perception;
	const day = S.senseRanges({ darkness: 0, night: false, raining: false });
	// the beacons as the brain fills them, from the ONE light rule (shared/sim/survivorLight.ts, LUZ-04)
	const L = lightMod;
	const saveWith = (hand, gun = 0, nocturnal = 0) => ({
		skillLevels: { 16: nocturnal },
		equipHand: hand,
		equipGun: gun,
	});
	const beaconOf = save => {
		const cone = L.survivorCone(save);
		const beam = cone !== undefined ? cone.radius : 0;
		return { range: S.beaconSight(Math.max(L.survivorGlowRadius(save), beam)), beam, beamAngle: 0 };
	};
	const glow = beaconOf(saveWith(-1));
	const torch = beaconOf(saveWith(15));
	const lamp = beaconOf(saveWith(13));
	check(
		glow.range === S.GLOW_SIGHT &&
			lamp.beam === L.survivorCone(saveWith(13)).radius &&
			S.BEAM_HALF === L.CONE_HALF_ANGLE,
		`the eyes read the light map's own rule: glow ${glow.range} u, torch ${torch.range}, flashlight ${lamp.range}, ` +
			`its beam ${lamp.beam} u at ±${math.deg(S.BEAM_HALF).toFixed(0)}° (LUZ-04)`,
	);
	check(
		beaconOf(saveWith(-1, 6)).range === glow.range && beaconOf(saveWith(-1, 0, 1)).range === glow.range,
		"night vision and Nocturnal are eyes, not light: they give nobody away",
	);
	const night = { darkness: 0.85, night: true, raining: false };
	const nEye = S.senseRanges(night);
	const nGlow = S.senseRanges(night, glow);
	const nTorch = S.senseRanges(night, torch);
	const nLamp = S.senseRanges(night, lamp);
	const dusk = S.senseRanges({ darkness: 0.5, night: false, raining: false }, glow);
	const rain = S.senseRanges({ darkness: 0, night: false, raining: true }, glow);
	const stealth = S.senseRanges(night, glow, true);
	info(
		`sight: day ${day.sight.toFixed(0)} u (±${math.deg(day.cone).toFixed(0)}°) · dusk ${dusk.sight.toFixed(0)} · ` +
			`rain ${rain.sight.toFixed(0)} · night: bare eyes ${nEye.sight.toFixed(0)}, own glow ${nGlow.sight.toFixed(0)}, ` +
			`torch ${nTorch.sight.toFixed(0)}, flashlight ${nLamp.sight.toFixed(0)} (beam ${nLamp.beam.toFixed(0)}) · ` +
			`glow + Stealth ${stealth.sight.toFixed(0)} · touch ${S.TOUCH_RANGE}`,
	);
	check(nEye.sight < day.sight && rain.sight < day.sight, "darkness and rain shorten the eyes");
	check(
		nEye.sight < nGlow.sight && nGlow.sight < nTorch.sight && nTorch.sight < nLamp.sight,
		"at night the survivor's own light is what gives them away: glow < torch < flashlight",
	);
	check(nLamp.sight > day.sight, "a flashlight in the dark is seen from further than a body in daylight");
	check(stealth.sight < nGlow.sight, "Stealth still makes a survivor harder to make out");
	check(
		S.noticeTime(100, 520) === 0 && S.noticeTime(500, 520) > S.noticeTime(300, 520),
		`certainty: instant up close, ${S.noticeTime(300, 520).toFixed(2)} s at 300 u, ${S.noticeTime(510, 520).toFixed(2)} s at the edge`,
	);

	// (a) daylight, open ground, 300 u straight ahead: a glimpse first, then a sighting
	{
		setSeed(SEED);
		const world = W.createWorld(3000, 3000);
		const refs = makeRefs(world, 1500, 1500);
		const z = still(addZombie(refs, 1, 1500, 1200, Math.PI / 2));
		let firstSusp = -1;
		const chase = framesUntil(
			refs,
			120,
			() => awareOf(z) === 3,
			f => {
				if (firstSusp < 0 && awareOf(z) === 1) firstSusp = f;
			},
		);
		info(
			`300 u ahead by day: suspicious after ${(firstSusp * DT).toFixed(2)} s, chasing after ${(chase * DT).toFixed(2)} s`,
		);
		check(chase > 0 && chase * DT <= 1.0, "open ground, 300 u straight ahead → chasing within a second");
		check(firstSusp >= 0 && firstSusp < chase, "...after a glimpse: the gold '?' comes before the red '!'");
	}
	// (b) close: instant
	{
		setSeed(SEED);
		const world = W.createWorld(3000, 3000);
		const refs = makeRefs(world, 1500, 1500);
		const z = still(addZombie(refs, 1, 1500, 1350, Math.PI / 2));
		const chase = framesUntil(refs, 60, () => awareOf(z) === 3);
		check(chase > 0 && chase * DT <= 0.15, `150 u ahead → chasing at once (${(chase * DT).toFixed(2)} s)`);
	}
	// (c) the same 300 u with a wall in between
	{
		setSeed(SEED);
		const world = W.createWorld(3000, 3000);
		wall(world, 1000, 1340, 1000, 32);
		const refs = makeRefs(world, 1500, 1500);
		const z = still(addZombie(refs, 1, 1500, 1200, Math.PI / 2));
		run(refs, 180);
		check(awareOf(z) === 0 && z.detect !== true, "same 300 u, a wall in between → never sees them (3 s)");
	}
	// (d) behind its back
	{
		setSeed(SEED);
		const world = W.createWorld(3000, 3000);
		const refs = makeRefs(world, 1500, 1500);
		const z = still(addZombie(refs, 1, 1500, 1100, -Math.PI / 2));
		run(refs, 180);
		check(awareOf(z) === 0, "400 u behind its back (outside the cone) → never sees them (3 s)");
	}
	// (e) a parked car is not a hiding place: a standing body is taller than a bonnet
	{
		setSeed(SEED);
		const world = W.createWorld(3000, 3000);
		parkedCar(world, 1400, 1340);
		const refs = makeRefs(world, 1500, 1500);
		const z = still(addZombie(refs, 1, 1500, 1200, Math.PI / 2));
		const chase = framesUntil(refs, 120, () => awareOf(z) === 3);
		check(chase > 0, "a parked car between them does not hide the survivor (it sees over the bonnet)");
	}
	// (f) at night the survivor's light decides it: 450 u is past their glow, inside a flashlight's reach
	{
		const at450 = equip => {
			setSeed(SEED);
			const world = W.createWorld(3000, 3000);
			const refs = makeRefs(world, 1500, 1500, { night: true });
			holdLight(refs, equip);
			refs.player.angle = 0; // the beam points east, away from the zombie
			const z = still(addZombie(refs, 1, 1500, 1050, Math.PI / 2));
			run(refs, 150);
			return awareOf(z);
		};
		const bare = at450(-1);
		const withTorch = at450(15);
		const withLamp = at450(13);
		info(
			`night, 450 u ahead: own glow → ${AWARE_NAMES[bare]}, torch → ${AWARE_NAMES[withTorch]}, flashlight → ${AWARE_NAMES[withLamp]}`,
		);
		check(bare === 0, "at night, 450 u ahead, only their own glow → not seen (the dark hides them)");
		check(
			withTorch === 3 && withLamp === 3,
			"...with a torch or a flashlight in hand → seen: the light is a beacon",
		);
	}
	// (g) the original's blanket night alert is gone: behind a wall and facing away, it does not know
	{
		setSeed(SEED);
		const world = W.createWorld(3000, 3000);
		wall(world, 1000, 1340, 1000, 32);
		const refs = makeRefs(world, 1500, 1500, { night: true });
		const z = still(addZombie(refs, 1, 1500, 1200, -Math.PI / 2));
		run(refs, 120);
		check(awareOf(z) === 0, "at night, behind a wall and facing away → it does NOT know (no blanket night alert)");
		zombieAI.emitSound(refs, 1500, 1500, 800, true);
		run(refs, 60);
		check(awareOf(z) === 1, "...but a gunshot at night still brings it (suspicious: it goes to look)");
	}
	// (h) the beam: a zombie standing in a flashlight's beam sees the light whatever way it faces
	{
		const beamed = aimAt => {
			setSeed(SEED);
			const world = W.createWorld(3000, 3000);
			const refs = makeRefs(world, 1500, 1500, { night: true });
			holdLight(refs, 13);
			refs.player.angle = aimAt;
			const z = still(addZombie(refs, 1, 1500, 1200, -Math.PI / 2)); // facing AWAY from the survivor
			run(refs, 120);
			return awareOf(z);
		};
		const pointed = beamed(-Math.PI / 2);
		const aside = beamed(0);
		info(
			`night, zombie facing away 300 u north: beam on it → ${AWARE_NAMES[pointed]}, beam aside → ${AWARE_NAMES[aside]}`,
		);
		check(
			pointed !== 0 && aside === 0,
			"shining a flashlight on a zombie's back gives you away; pointing it elsewhere does not",
		);
	}
	// (i) touch: this close, whatever it faces
	{
		setSeed(SEED);
		const world = W.createWorld(3000, 3000);
		const refs = makeRefs(world, 1500, 1500);
		const z = still(addZombie(refs, 1, 1500, 1445, -Math.PI / 2));
		const chase = framesUntil(refs, 10, () => awareOf(z) === 3);
		check(chase > 0 && chase <= 2, `55 u behind its back → chasing at once (touch, ${S.TOUCH_RANGE} u)`);
	}
}

// ---------------------------------------------------------------- 1b. ears

function testHearing() {
	console.log("\n[1b] ears: noise by action, day and night, and what a noise makes a zombie do (noise.ts)");
	const N = noiseMod;
	const WK = { Pistol: 2, Rifle: 1, Shotgun: 4, MG: 3, Sniper: 5 };
	const table = [
		["pistol", N.gunshotRadius(WK.Pistol, 10, false)],
		["pistol + silencer", N.gunshotRadius(WK.Pistol, 10, true)],
		["rifle", N.gunshotRadius(WK.Rifle, 13, false)],
		["shotgun", N.gunshotRadius(WK.Shotgun, 16, false)],
		["machine gun", N.gunshotRadius(WK.MG, 18, false)],
		["sniper", N.gunshotRadius(WK.Sniper, 20, false)],
		["building", N.BUILD],
		["barricade hit / broken", `${N.STRUCT_HIT} / ${N.STRUCT_BREAK}`],
		["running", N.footstepRadius(210, false)],
		["walking (slowed)", N.footstepRadius(150, false)],
		["running + Stealth", N.footstepRadius(210, true)],
		["a blow landing", N.HIT],
	];
	info(table.map(([k, v]) => `${k} ${typeof v === "number" ? v.toFixed(0) : v}`).join(" · "));
	check(
		N.gunshotRadius(WK.Pistol, 10, false) === 800,
		"a pistol is heard exactly as far as the original's shot (800 u)",
	);
	check(
		N.gunshotRadius(WK.Sniper, 20, false) > N.gunshotRadius(WK.Rifle, 13, false) &&
			N.gunshotRadius(WK.Rifle, 13, false) > N.gunshotRadius(WK.Pistol, 10, false),
		"guns are graded by class: sniper > rifle > pistol",
	);
	check(
		N.footstepRadius(210, false) > N.footstepRadius(150, false) && N.footstepRadius(150, false) > N.HIT * 0.5,
		"running is louder than walking",
	);
	check(
		N.gunshotRadius(WK.Pistol, 10, false) > 3 * N.HIT,
		"the trade-off: a gun is heard several times further than a blade",
	);

	/** one zombie `d` u north of the survivor, facing away; returns its state after a noise of `r` at the survivor */
	const hears = (d, r, opts = {}) => {
		setSeed(SEED);
		const world = W.createWorld(4000, 4000);
		const refs = makeRefs(world, 2000, 2000, opts);
		const z = still(addZombie(refs, 1, 2000, 2000 - d, -Math.PI / 2));
		zombieAI.emitSound(refs, 2000, 2000, r, true);
		run(refs, 60 * 4);
		return z;
	};
	check(awareOf(hears(700, 800)) !== 0, "a pistol shot reaches a zombie 700 u away");
	check(awareOf(hears(900, 800)) === 0, "...not one 900 u away");
	check(awareOf(hears(1100, N.gunshotRadius(WK.Rifle, 13, false))) !== 0, "a rifle shot reaches 1100 u");
	check(awareOf(hears(700, 800, { night: true })) !== 0, "noise works at night too (the original dropped it)");
	check(
		awareOf(hears(450, 800, { raining: true })) !== 0 && awareOf(hears(700, 800, { raining: true })) === 0,
		`the rain masks it: ${(800 * perception.RAIN_HEARING).toFixed(0)} u instead of 800`,
	);
	// what a noise makes it do: suspicious, walking to the SOURCE, never a chase by itself
	{
		setSeed(SEED);
		const world = W.createWorld(4000, 4000);
		wall(world, 1500, 1700, 1000, 32); // it cannot see the survivor from where it stands
		const refs = makeRefs(world, 2000, 2000);
		const z = still(addZombie(refs, 1, 2000, 1400, -Math.PI / 2));
		zombieAI.emitSound(refs, 2000, 2000, 800, true);
		const d0 = dist(z.x, z.y, 2000, 2000);
		let chased = false;
		for (let f = 0; f < 60 * 3; f++) {
			zombieAI.updateZombies(refs, DT);
			if (awareOf(z) === 3) chased = true;
		}
		check(awareOf(z) === 1 && !chased, "a noise makes it SUSPICIOUS (gold '?'), never a chase by itself");
		check(
			z.lastSeenX === 2000 && z.lastSeenY === 2000 && dist(z.x, z.y, 2000, 2000) < d0,
			"...and it walks towards where the noise came from",
		);
	}
	// footsteps: a running survivor is heard at 180 u, a slowed one is not
	{
		const steps = speed => {
			setSeed(SEED);
			const world = W.createWorld(4000, 4000);
			const refs = makeRefs(world, 2000, 2000);
			const z = still(addZombie(refs, 1, 2000, 1820, -Math.PI / 2));
			// pacing east and west in front of the survivor's own spot, at `speed` u/s
			for (let f = 0; f < 150; f++) {
				refs.player.x += (Math.floor(f / 20) % 2 === 0 ? 1 : -1) * speed * DT;
				zombieAI.updateZombies(refs, DT);
			}
			return awareOf(z);
		};
		check(steps(210) !== 0, "a survivor running 180 u behind a zombie is heard (running: 220 u)");
		check(steps(150) === 0, "...one dragging their feet (slowed: 110 u) is not");
	}
	// the server grades a real shot by the gun in hand (simulation.ts gunNoise)
	if (SERVER) {
		setSeed(SEED);
		const world = W.createWorld(4000, 4000);
		const sim = new simulationMod.ServerSimulation({ world, zombies: true });
		const sp = serverPlayers.createServerPlayer(
			{ slot: 0, userId: 1, name: "bot" },
			defaultSave(),
			2000,
			2000,
			sim.tick,
			sim.simHz,
		);
		sim.add(sp);
		sp.state.weapon.pointer = 10;
		const pistol = sim.gunNoise(2000, 2000, 800);
		sp.state.weapon.pointer = 20;
		const sniper = sim.gunNoise(2000, 2000, 800);
		const nobody = sim.gunNoise(100, 100, 800);
		info(`server: a shot fired with a pistol is heard ${pistol} u away, with a sniper rifle ${sniper} u`);
		check(
			pistol === 800 && sniper === 1400 && nobody === 800,
			"the server grades each shot by the gun its shooter holds",
		);
	}
}
// ---------------------------------------------------------------- 2. states and memory

function testMemory() {
	console.log("\n[2] states: chasing → lose sight → suspicious (last seen) → searching → gives up (memory.ts)");
	setSeed(SEED);
	const world = W.createWorld(4000, 4000);
	const refs = makeRefs(world, 1500, 1500);
	const z = still(addZombie(refs, 1, 1500, 1150, Math.PI / 2));
	if (framesUntil(refs, 120, () => awareOf(z) === 3) < 0) {
		fail("the zombie never saw the survivor (setup)");
		return;
	}
	const seenX = z.lastSeenX;
	const seenY = z.lastSeenY;
	check(
		seenX !== undefined && dist(seenX, seenY, 1500, 1500) < 1,
		`remembers where it saw them: (${seenX?.toFixed(0)}, ${seenY?.toFixed(0)})`,
	);

	// the survivor is gone the moment it sees them: out of range, out of sight
	refs.player.x = 1500;
	refs.player.y = 3400;
	const at = { 1: -1, 2: -1, 0: -1 };
	let closest = Infinity;
	let hops = 0;
	let standing = 0;
	for (let f = 0; f < 60 * 25; f++) {
		zombieAI.updateZombies(refs, DT);
		const a = awareOf(z);
		if (a !== 3 && at[a] < 0) at[a] = f;
		closest = Math.min(closest, dist(z.x, z.y, seenX, seenY));
		if (a === 2) {
			hops = Math.max(hops, z.searchHop ?? 0);
			if ((z.lookT ?? 0) > 0) standing++;
		}
	}
	const t = k => (at[k] * DT).toFixed(1);
	info(
		`lost them at 0 s: suspicious at ${t(1)} s, searching at ${t(2)} s, idle at ${t(0)} s · ` +
			`${hops} hops, ${(standing * DT).toFixed(1)} s spent standing and looking round`,
	);
	check(
		at[1] >= 0 && at[1] * DT >= memoryMod.LOST_GRACE - 0.05,
		"it keeps closing in for LOST_GRACE before it turns suspicious",
	);
	check(closest < memoryMod.SEARCH_ARRIVE, `walks to the LAST KNOWN POSITION (got within ${closest.toFixed(0)} u)`);
	check(at[2] > at[1], "...then searches around it");
	check(hops >= 2 && standing > 30, "the search is hops and stops to look round, not a spin on the spot");
	const searched = (at[0] - at[2]) * DT;
	check(
		at[0] > at[2] && Math.abs(searched - memoryMod.SEARCH_TIME) < 0.5,
		`gives up after searching ${searched.toFixed(1)} s (SEARCH_TIME ${memoryMod.SEARCH_TIME} s) and wanders again`,
	);
	check(z.lastSeenX === undefined && z.detect === false, "the memory is cleared when it gives up");

	// a place it cannot reach is searched from where it got stuck, not ground into a wall for ever
	{
		setSeed(SEED);
		const world2 = W.createWorld(4000, 4000);
		wall(world2, 1000, 1700, 2000, 32); // a long wall between the zombie and the place it heard
		const refs2 = makeRefs(world2, 2000, 3500);
		const zz = still(addZombie(refs2, 1, 2000, 1500, Math.PI / 2));
		zombieAI.emitSound(refs2, 2000, 1900, 600, true);
		let suspAt = -1;
		const searchAt = framesUntil(
			refs2,
			60 * 10,
			() => awareOf(zz) === 2,
			f => {
				if (suspAt < 0 && awareOf(zz) === 1) suspAt = f;
			},
		);
		check(
			suspAt >= 0 && searchAt > 0 && (searchAt - suspAt) * DT < memoryMod.GOTO_STALL + 4,
			`a place behind a long wall: it searches where it got stuck after ${((searchAt - suspAt) * DT).toFixed(1)} s`,
		);
	}
}

// ---------------------------------------------------------------- 3. group alert

function testAlert() {
	console.log("\n[3] the groan and its budget (alert.ts)");
	setSeed(SEED);
	const world = W.createWorld(4000, 4000);
	const refs = makeRefs(world, 1500, 1500);
	// one zombie looking straight at the survivor
	const spotter = still(addZombie(refs, 1, 1500, 1350, Math.PI / 2));
	// twelve within earshot of the spotter, all facing away and too far to see anything themselves
	const crowd = [];
	for (let i = 0; i < 12; i++) {
		const a = -Math.PI / 2 + (i / 11 - 0.5) * 1.6;
		crowd.push(still(addZombie(refs, 1, 1500 + Math.cos(a) * 390, 1350 + Math.sin(a) * 390, -Math.PI / 2)));
	}
	const tooClose = crowd.filter(z => dist(z.x, z.y, 1500, 1500) < perception.SIGHT_DAY * 0.4).length;
	if (tooClose > 0) fail(`${tooClose} of the crowd could spot the survivor at once by themselves (setup)`);
	run(refs, 12);
	const woken = crowd.filter(z => awareOf(z) !== 0);
	check(awareOf(spotter) === 3 && (spotter.shout ?? 0) > 0, "the spotter sees the survivor and groans");
	check(
		woken.length > 0 && woken.length <= alertMod.ALERT_MAX_WAKE,
		`the groan woke ${woken.length} of 12 (cap ${alertMod.ALERT_MAX_WAKE})`,
	);
	check(
		woken.every(z => awareOf(z) === 1),
		"the woken turn SUSPICIOUS (gold '?'): told where to look, not where the survivor is",
	);
	check(
		woken.every(z => (z.alertCd ?? 0) > 0),
		"every woken zombie is on cooldown: an alert cannot relay itself",
	);
	const reported = woken.filter(z => z.lastSeenX !== undefined && dist(z.lastSeenX, z.lastSeenY, 1500, 1500) < 1);
	check(reported.length === woken.length, "they are told WHERE the survivor was seen, not where the survivor is now");
	check(crowd.filter(z => awareOf(z) === 0).length >= 12 - alertMod.ALERT_MAX_WAKE, "no cascade across the crowd");
	// the spotter's own cooldown: losing and re-finding the survivor within ALERT_COOLDOWN is no second groan
	const cd = spotter.alertCd ?? 0;
	check(cd > alertMod.ALERT_COOLDOWN - 1, `the spotter itself cannot groan again for ${alertMod.ALERT_COOLDOWN} s`);
}

// ---------------------------------------------------------------- 3b. night waves

function testWaves() {
	console.log("\n[3b] night waves still hunt like the original: always chasing, never a search party");
	setSeed(SEED);
	const world = W.createWorld(4000, 4000);
	wall(world, 1000, 1700, 2000, 32);
	const refs = makeRefs(world, 2000, 2400, { night: true });
	const zw = createZombie(1, 2000, 1400, 5, true);
	zw.detect = true; // as population.ts spawns it
	zw.angle = -Math.PI / 2;
	zw.angleSlow = zw.angle;
	refs.zombies.push(zw);
	let notChasing = 0;
	for (let f = 0; f < 60 * 20; f++) {
		zombieAI.updateZombies(refs, DT);
		if (awareOf(zw) !== 3) notChasing++;
	}
	check(notChasing === 0, "a wave zombie behind a wall, facing away, at night: chasing on every tick for 20 s");
	check(zw.lastSeenX !== undefined || zw.detect, "...it knows where the survivor is (the original's tide)");
	check(dist(zw.x, zw.y, 2000, 2400) < 1000 - 200, "...and it closes in around the wall");
}

// ---------------------------------------------------------------- 3c. the whole sequence

/**
 * wander → hears a gunshot → investigates → spots → groans for a neighbour → chases → loses sight → searches →
 * gives up. The scenario the owner asked for, scripted end to end; tools/test-awareness.mjs renders the same one.
 * Returns the timeline (what happened when) so both suites describe the same story.
 */
function sequenceScenario() {
	setSeed(SEED);
	resetEntityIds();
	const world = W.createWorld(4000, 4000);
	// a house wall the survivor can run behind
	wall(world, 2300, 1300, 32, 900);
	const refs = makeRefs(world, 2000, 1800, { day: 3 });
	const scout = addZombie(refs, 1, 2000, 1080, Math.PI); // 720 u north, facing west: cannot see the survivor
	// out of the gunshot's reach (840 u from it), facing away, but within a groan of where the scout will spot them
	const neighbour = still(addZombie(refs, 1, 2040, 960, -Math.PI / 2));
	const events = [];
	const last = new Map();
	let t = 0;
	const tick = () => {
		zombieAI.updateZombies(refs, DT);
		t += DT;
		for (const z of [scout, neighbour]) {
			const a = awareOf(z);
			if (last.get(z.id) !== a) {
				events.push({
					t,
					who: z === scout ? "scout" : "neighbour",
					aware: a,
					at: `(${z.x.toFixed(0)}, ${z.y.toFixed(0)}), ${dist(z.x, z.y, refs.player.x, refs.player.y).toFixed(0)} u from the survivor`,
					shout: (z.shout ?? 0) > 0,
				});
				last.set(z.id, a);
			}
		}
	};
	for (let f = 0; f < 60 * 2; f++) tick();
	events.push({ t, who: "survivor", what: "gunshot" });
	zombieAI.emitSound(refs, refs.player.x, refs.player.y, 800, true);
	for (let f = 0; f < 60 * 12 && awareOf(scout) !== 3; f++) tick();
	for (let f = 0; f < 60; f++) tick();
	events.push({ t, who: "survivor", what: "runs behind the house" });
	// the survivor sprints east round the house and away
	for (let f = 0; f < 60 * 4; f++) {
		refs.player.x = Math.min(3400, refs.player.x + 4.2);
		tick();
	}
	for (let f = 0; f < 60 * 30 && !(awareOf(scout) === 0 && awareOf(neighbour) === 0); f++) tick();
	return { events, refs, scout, neighbour };
}

function testSequence() {
	console.log(
		"\n[3c] the whole story: wander → gunshot → investigate → spot → groan → chase → lose → search → give up",
	);
	const { events } = sequenceScenario();
	for (const e of events) {
		const where = e.at !== undefined ? ` at ${e.at}${e.shout ? ", groans" : ""}` : "";
		info(`${e.t.toFixed(2).padStart(6)} s  ${e.who.padEnd(9)} ${e.what ?? AWARE_NAMES[e.aware]}${where}`);
	}
	const of = who => events.filter(e => e.who === who && e.aware !== undefined).map(e => e.aware);
	const scout = of("scout").join(",");
	check(
		scout.startsWith("0,1,3") && scout.includes("3,1,2") && scout.endsWith("2,0"),
		`the scout goes idle → suspicious → chasing → suspicious → searching → idle (${scout})`,
	);
	const shotAt = events.find(e => e.what === "gunshot").t;
	const chaseAt = events.find(e => e.who === "scout" && e.aware === 3).t;
	const wokeAt = events.find(e => e.who === "neighbour" && e.aware === 1)?.t;
	check(chaseAt > shotAt, "it chases only after it walked over and saw the survivor");
	check(wokeAt !== undefined && Math.abs(wokeAt - chaseAt) < 0.1, "its groan woke the neighbour at that moment");
	check(of("neighbour").at(-1) === 0, "...and the neighbour gives up too once there is nothing to find");
}

// ---------------------------------------------------------------- 3d. natural motion

function testMotion() {
	console.log("\n[3d] natural motion: varied gaits within today's speeds, sway, turning, no stacking, no flicker");
	setSeed(SEED);
	resetEntityIds();
	const world = W.createWorld(4000, 4000);
	const refs = makeRefs(world, 2000, 2000, { day: 3 });
	const zs = [];
	for (let i = 0; i < 30; i++) {
		const a = (i / 30) * Math.PI * 2;
		const r = 350 + (i % 5) * 60;
		zs.push(addZombie(refs, 1, 2000 + Math.cos(a) * r, 2000 + Math.sin(a) * r, a + Math.PI));
	}
	const p = refs.player;
	p.hpMax = 1e6;
	p.hp = p.hpMax;
	let overSpeed = 0;
	let maxTurn = 0;
	const paces = new Map();
	const changes = new Map();
	let bursts = 0;
	const prevDir = new Map();
	for (let f = 0; f < 60 * 20; f++) {
		// the survivor strolls in a slow circle, so the horde keeps turning
		p.x = 2000 + Math.cos(f / 240) * 300;
		p.y = 2000 + Math.sin(f / 240) * 300;
		p.attacked = false;
		zombieAI.updateZombies(refs, DT);
		for (const z of zs) {
			const cap = z.moveSpeed * 30 + 1e-6;
			if ((z.pace ?? 0) > cap) overSpeed++;
			const d = dist(z.x, z.y, p.x, p.y);
			const was = prevDir.get(z.id);
			if (awareOf(z) === 3 && d > 260 && was !== undefined && z.walkDir !== undefined && (z.pace ?? 0) > 0) {
				const turn = Math.abs(Math.atan2(Math.sin(z.walkDir - was), Math.cos(z.walkDir - was)));
				maxTurn = Math.max(maxTurn, turn);
			}
			prevDir.set(z.id, z.walkDir);
			if (awareOf(z) === 3 && d > 260 && (z.pace ?? 0) > 0) paces.set(z.id, (z.pace ?? 0) / (z.moveSpeed * 30));
			const log = changes.get(z.id) ?? [];
			if (log.at(-1)?.a !== awareOf(z)) log.push({ f, a: awareOf(z) });
			changes.set(z.id, log);
		}
	}
	for (const log of changes.values()) {
		for (let i = 3; i < log.length; i++) if (log[i].f - log[i - 3].f < 60) bursts++;
	}
	const ratios = [...paces.values()];
	const lo = Math.min(...ratios);
	const hi = Math.max(...ratios);
	info(
		`chase pace ${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)} % of each one's speed · ` +
			`sharpest turn in a chase ${(maxTurn / DT).toFixed(1)} rad/s`,
	);
	check(overSpeed === 0, "no zombie ever walks faster than its own speed (today's limit)");
	check(hi - lo > 0.03 && lo >= 0.85, "chasing gaits vary between zombies, never below 85 % of the speed");
	check(
		maxTurn <= tuning.TURN_CHASE * DT + 0.1 * 2 + 1e-6,
		"in a chase beyond arm's reach the body swings round, it does not snap",
	);
	check(bursts === 0, "no zombie flickers: never three state changes inside one second");
	let worst = Infinity;
	for (let i = 0; i < zs.length; i++) {
		for (let j = i + 1; j < zs.length; j++) {
			const a = zs[i];
			const b = zs[j];
			worst = Math.min(worst, dist(a.x, a.y, b.x, b.y) / (16 * (a.scale ?? 1) + 16 * (b.scale ?? 1)));
		}
	}
	check(worst > 0.6, `bodies do not stack: the closest pair is ${(worst * 100).toFixed(0)} % of touching distance`);
}
// ---------------------------------------------------------------- 4. flanking: two doors

const BLD = { x0: 1600, y0: 1600, x1: 2400, y1: 2400, t: 32, door: 128 };

/** a walled box with a doorway in the north wall and another in the east wall, both barricaded */
function twoDoorWorld() {
	const world = W.createWorld(4000, 4000);
	const { x0, y0, x1, y1, t, door } = BLD;
	const dnx = (x0 + x1) / 2; // north doorway centre
	const dey = (y0 + y1) / 2; // east doorway centre
	wall(world, x0, y0, dnx - door / 2 - x0, t);
	wall(world, dnx + door / 2, y0, x1 - (dnx + door / 2), t);
	wall(world, x0, y1 - t, x1 - x0, t);
	wall(world, x0, y0, t, y1 - y0);
	wall(world, x1 - t, y0, t, dey - door / 2 - y0);
	wall(world, x1 - t, dey + door / 2, t, y1 - (dey + door / 2));
	// the survivor barricaded both ways in (an iron barricade, 1500 hp): the siege the original never handles
	const barricade = (x, y, w, h) =>
		W.addSolid(world, {
			kind: "barricade",
			x,
			y,
			w,
			h,
			hp: 1500,
			hpMax: 1500,
			destructible: true,
			tags: "barricade",
			rot: 0,
		});
	barricade(dnx - door / 2, y0, door, t);
	barricade(x1 - t, dey - door / 2, t, door);
	return { world, north: { x: dnx, y: y0 + t / 2 }, east: { x: x1 - t / 2, y: dey } };
}

/**
 * 20 zombies staged in one tight column DUE NORTH of a barricaded building. The north way in is the obvious
 * one for every single zombie, and only four or five bodies fit against the barricade: a horde that cannot
 * tell it is in a queue grinds that one plank with its whole strength and never touches the east one.
 */
function runSiege(frames = 60 * 60) {
	setSeed(SEED);
	resetEntityIds();
	const { world, north, east } = twoDoorWorld();
	const refs = makeRefs(world, 2000, 2000);
	for (let i = 0; i < 20; i++) {
		const a = -Math.PI / 2 + ((i % 5) / 4 - 0.5) * 0.12;
		const r = 820 + Math.floor(i / 5) * 45;
		const z = addZombie(refs, 1, 2000 + Math.cos(a) * r, 2000 + Math.sin(a) * r, Math.PI / 2);
		// they KNOW a survivor is in there; the question is HOW they get in. Since IA-01 an ambient zombie has to see
		// or hear to know anything, and the one that knows without either is the night tide: a wave zombie
		z.detect = true;
		z.wave = true;
	}
	const atNorth = new Set();
	const atEast = new Set();
	for (let f = 0; f < frames; f++) {
		zombieAI.updateZombies(refs, DT);
		for (const z of refs.zombies) {
			if (dist(z.x, z.y, north.x, north.y) < 110) atNorth.add(z.id);
			if (dist(z.x, z.y, east.x, east.y) < 110) atEast.add(z.id);
		}
	}
	// Map/Set expose size() as a METHOD here (the roblox-ts shim above), not as a property
	return { north: atNorth.size(), east: atEast.size(), total: refs.zombies.length };
}

function testFlank() {
	console.log("\n[4] 20 zombies against a barricaded building with two ways in (flank.ts)");
	const r = runSiege();
	const doors = (r.north > 0 ? 1 : 0) + (r.east > 0 ? 1 : 0);
	info(`north barricade worked by ${r.north} zombies · east barricade worked by ${r.east} (of ${r.total})`);
	check(doors >= 2, `the horde used ${doors} distinct ways in (single file would use 1)`);
	check(r.east >= 3, `${r.east} of ${r.total} gave up on the queue and came round to the other side (≥ 3)`);
}

// ---------------------------------------------------------------- 5. pacing director

function testDirector() {
	console.log("\n[5] pacing director: peak → relief → build (director.ts)");
	const d = new directorMod.PaceDirector();
	const step = 0.25;
	const phases = [];
	let reliefRuns = 0;
	let inRelief = false;
	let maxQuietGap = 0;
	let quiet = 0;
	// 6 minutes: two fights of 25 s, quiet in between
	for (let t = 0; t < 360; t += step) {
		const fighting = (t > 30 && t < 55) || (t > 200 && t < 225);
		d.update(
			{
				damage: fighting ? 1.6 : 0,
				kills: fighting ? 0.5 : 0,
				near: fighting ? 8 : 1,
				health: fighting ? 0.5 : 0.9,
			},
			step,
		);
		phases.push(d.phase);
		if (d.relieving()) {
			if (!inRelief) reliefRuns++;
			inRelief = true;
			quiet += step;
			maxQuietGap = Math.max(maxQuietGap, quiet);
		} else {
			inRelief = false;
			quiet = 0;
		}
	}
	const peaked = phases.includes("peak");
	info(
		`peaks ${d.peaks} · relief runs ${reliefRuns} · longest quiet stretch ${maxQuietGap.toFixed(1)} s · ` +
			`total relief ${d.reliefTime.toFixed(1)} s`,
	);
	check(peaked, "a fight drives the intensity into a peak");
	check(reliefRuns >= 2, `each peak is followed by a relief (${reliefRuns} of them)`);
	check(
		maxQuietGap >= directorMod.RELAX_MIN,
		`the quiet stretch lasts at least RELAX_MIN (${directorMod.RELAX_MIN} s)`,
	);
	check(
		d.ambientScale >= directorMod.MIN_SCALE && d.ambientScale <= directorMod.MAX_SCALE,
		`the spawn multiplier stays inside [${directorMod.MIN_SCALE}, ${directorMod.MAX_SCALE}]`,
	);
	check(
		d.waveScale >= directorMod.WAVE_MIN && d.waveScale <= directorMod.WAVE_MAX,
		`a night wave is only ever paced, never cut (waveScale ∈ [${directorMod.WAVE_MIN}, ${directorMod.WAVE_MAX}])`,
	);

	// the wave queues themselves are the original's: the director never touches them
	setSeed(SEED);
	const world = W.generateTown(DESIGN.TOWN_SEED);
	const refs = makeRefs(world, world.width / 2, world.height / 2, { day: 5, hour: 18.2 });
	const spawner = new Spawner();
	spawner.director.phase = "relax";
	spawner.director.ambientScale = directorMod.MIN_SCALE;
	refs.daynight.update(0);
	const queued = refs.daynight.waveQueues.reduce((a, b) => a + b, 0);
	check(queued > 0, `the 18:00 fill queued ${queued} wave zombies (the original's table)`);
	spawner.update(refs, DT);
	const after = refs.daynight.waveQueues.reduce((a, b) => a + b, 0);
	check(after === queued, "a relief does not remove anything from the wave queues");
}

// ---------------------------------------------------------------- 6. MP-09

function testSpawnRules() {
	console.log("\n[6] MP-09: nothing spawns within 720 u, never more than 150 alive");
	setSeed(SEED);
	resetEntityIds();
	const world = W.generateTown(DESIGN.TOWN_SEED);
	const refs = makeRefs(world, world.width / 2, world.height / 2, { day: 20, hour: 18.2, night: true });
	const spawner = new Spawner();
	const last = new Map();
	let placed = 0;
	let worst = Infinity;
	let peak = 0;
	let violations = 0;
	// 3 simulated minutes of a night at day 20 (the heaviest wave table), with the survivor moving
	for (let f = 0; f < 60 * 180; f++) {
		refs.player.x += Math.cos(f / 240) * 1.4;
		refs.player.y += Math.sin(f / 300) * 1.4;
		refs.daynight.update(DT);
		spawner.update(refs, DT);
		zombieAI.updateZombies(refs, DT);
		peak = Math.max(peak, refs.zombies.length);
		for (const z of refs.zombies) {
			const prev = last.get(z.id);
			const jumped = prev === undefined || Math.hypot(z.x - prev.x, z.y - prev.y) > 300;
			last.set(z.id, { x: z.x, y: z.y });
			if (!jumped) continue;
			placed++;
			let d = Infinity;
			for (const p of refs.players) d = Math.min(d, dist(z.x, z.y, p.x, p.y));
			worst = Math.min(worst, d);
			if (d < 720) violations++;
		}
	}
	info(`${placed} placements · closest to a survivor ${worst.toFixed(0)} u · peak population ${peak}`);
	check(placed > 20, `the night actually spawned (${placed} placements)`);
	check(violations === 0, "no zombie was ever placed within 720 u of a survivor");
	check(peak <= 150, `the population never passed the 150 ceiling (peak ${peak})`);
}

// ---------------------------------------------------------------- 7. determinism

function zombieHash(h, z) {
	const fields = [
		z.id,
		z.x,
		z.y,
		z.hp,
		z.angle,
		z.angleSlow,
		z.stunned,
		z.detect ? 1 : 0,
		z.aware ?? 0,
		z.lastSeenX ?? 0,
		z.lastSeenY ?? 0,
		z.searchTimer ?? 0,
		z.windup ?? 0,
		z.navDir ?? 0,
	];
	const buf = new ArrayBuffer(8);
	const view = new DataView(buf);
	for (const v of fields) {
		view.setFloat64(0, v === 0 ? 0 : v, true);
		for (let i = 0; i < 8; i++) {
			h ^= view.getUint8(i);
			h = Math.imul(h, 0x01000193) >>> 0;
		}
	}
	return h;
}

/** a full scenario: town, spawner, night wave, a survivor walking a fixed path */
function scenario(seed, frames = 60 * 30) {
	setSeed(seed);
	resetEntityIds();
	zombieAI.takeKills?.();
	const world = W.generateTown(DESIGN.TOWN_SEED);
	const refs = makeRefs(world, world.width / 2, world.height / 2, { day: 6, hour: 18.2, night: true });
	const spawner = new Spawner();
	const sx = refs.player.x;
	const sy = refs.player.y;
	let h = 2166136261 >>> 0;
	for (let f = 0; f < frames; f++) {
		refs.player.x = sx + Math.cos(f / 180) * 260;
		refs.player.y = sy + Math.sin(f / 140) * 260;
		refs.daynight.update(DT);
		spawner.update(refs, DT);
		zombieAI.updateZombies(refs, DT);
		for (const z of refs.zombies) h = zombieHash(h, z);
	}
	return { hash: (h >>> 0).toString(16).padStart(8, "0"), count: refs.zombies.length };
}

function testDeterminism() {
	console.log("\n[7] determinism: same seed → same world");
	const a = scenario(SEED);
	const b = scenario(SEED);
	const c = scenario(SEED + 1);
	info(`seed ${SEED}: hash ${a.hash} (${a.count} zombies) · seed ${SEED + 1}: hash ${c.hash}`);
	check(a.hash === b.hash, `the same seed replays to the same state (${a.hash})`);
	check(a.hash !== c.hash, "a different seed gives a different run (the test is not hashing nothing)");
}

// ---------------------------------------------------------------- 8. telegraphed bite

function testBite() {
	console.log("\n[8] the bite is telegraphed and can be stepped out of");
	// (a) it still bites
	{
		setSeed(SEED);
		const world = W.createWorld(3000, 3000);
		const refs = makeRefs(world, 1500, 1500);
		const z = addZombie(refs, 1, 1500, 1546, -Math.PI / 2);
		let sawWindup = false;
		for (let f = 0; f < 60 * 4; f++) {
			zombieAI.updateZombies(refs, DT);
			if ((z.windup ?? 0) > 0) sawWindup = true;
		}
		check(sawWindup, "the walker pulls back before biting (windup / windupMax for the view)");
		check(refs.player.hp < refs.player.hpMax, `the bite still lands (hp ${refs.player.hp.toFixed(0)})`);
	}
	// (b) step out during the wind-up and it whiffs
	{
		setSeed(SEED);
		const world = W.createWorld(3000, 3000);
		const refs = makeRefs(world, 1500, 1500);
		const z = addZombie(refs, 1, 1500, 1546, -Math.PI / 2);
		let dodged = false;
		let hpAtDodge = refs.player.hp;
		for (let f = 0; f < 60 * 4 && !dodged; f++) {
			zombieAI.updateZombies(refs, DT);
			if ((z.windup ?? 0) > 0) {
				refs.player.y += 300; // the survivor steps out of reach mid wind-up
				hpAtDodge = refs.player.hp;
				dodged = true;
			}
		}
		for (let f = 0; f < 6; f++) zombieAI.updateZombies(refs, DT);
		check(dodged && z.windup === undefined, "stepping out cancels the wind-up");
		check(refs.player.hp >= hpAtDodge, "the bite whiffs: no damage from a wind-up the survivor left");
		check((z.stunned ?? 0) > 0, "the whiff costs the zombie a moment of recovery");
	}
	// (c) a heavy hit staggers and kills the wind-up
	{
		setSeed(SEED);
		const world = W.createWorld(3000, 3000);
		const refs = makeRefs(world, 1500, 1500);
		const z = addZombie(refs, 1, 1500, 1546, -Math.PI / 2);
		for (let f = 0; f < 60; f++) zombieAI.updateZombies(refs, DT);
		zombieAI.reactToHit(z, Math.PI / 2, 9); // a melee / headshot / blast
		check((z.stagger ?? 0) > 0, "a heavy hit staggers (stagger, for the view to flinch)");
		check(z.windup === undefined, "…and kills the bite it was winding up");
	}
	// (d) LEG-04: surrounded is deadlier than alone, and no bite is drawn without blood (owner's playtest,
	// 2026-09-23: "with more than 2 zombies only 2 attacked me, the others 'attack' but I take no damage")
	{
		const one = crowdBites(1);
		const six = crowdBites(6);
		info(
			`10 s standing still: 1 walker ${one.hp.toFixed(0)} hp in ${one.hits} hits · ` +
				`6 walkers ${six.hp.toFixed(0)} hp in ${six.hits} hits`,
		);
		check(
			six.hp >= 2 * one.hp,
			`six walkers take at least twice what one does (${six.hp.toFixed(0)} vs ${one.hp.toFixed(0)})`,
		);
		check(six.empty === 0, `no walker finishes a bite that draws no blood (${six.empty} empty bites)`);
		check(one.empty === 0, `…nor a lone one (${one.empty})`);
		const gap = DESIGN.IFRAMES - DT / 2;
		check(
			six.minGap >= gap,
			`a crowd's bites are spaced by the guard (${six.minGap.toFixed(2)} s ≥ ${DESIGN.IFRAMES} s)`,
		);
	}
}

/**
 * `n` walkers in a ring around a survivor who stands still for 10 s (hp raised so nobody dies mid-count).
 * An EMPTY bite is a wind-up that ends with the walker neither stunned by a bite that landed (STUN_TIME) nor
 * recovering from a whiff — exactly what the survivor saw: a bite animation and no damage.
 */
function crowdBites(n) {
	setSeed(SEED);
	const world = W.createWorld(3000, 3000);
	const refs = makeRefs(world, 1500, 1500);
	const p = refs.player;
	p.hpMax = 100000;
	p.hp = p.hpMax;
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2;
		const z = addZombie(refs, 1, 1500 + Math.cos(a) * 60, 1500 + Math.sin(a) * 60, a + Math.PI);
		z.detect = true;
	}
	const wound = refs.zombies.map(() => false);
	let hits = 0;
	let empty = 0;
	let lastHit = -Infinity;
	let minGap = Infinity;
	for (let f = 0; f < 60 * 10; f++) {
		// stepPlayer is not in this harness: run its i-frame bookkeeping by hand, and keep them standing
		if (p.attacked) {
			p.iframe -= DT;
			if (p.iframe <= 0) {
				p.attacked = false;
				p.iframe = 0;
			}
		}
		p.x = 1500;
		p.y = 1500;
		p.reactionSpeed = 0;
		const before = p.hp;
		zombieAI.updateZombies(refs, DT);
		if (p.hp < before) {
			hits += 1;
			const t = f * DT;
			minGap = Math.min(minGap, t - lastHit);
			lastHit = t;
		}
		refs.zombies.forEach((z, i) => {
			const now = z.windup !== undefined;
			if (wound[i] && !now && (z.stunned ?? 0) <= 0) empty += 1;
			wound[i] = now;
		});
	}
	return { hp: p.hpMax - p.hp, hits, empty, minGap };
}

// ---------------------------------------------------------------- 9. cost

/** `count` zombies packed around the survivor at `radius`, all hunting */
function benchScene(count, radius) {
	setSeed(SEED);
	resetEntityIds();
	const world = W.generateTown(DESIGN.TOWN_SEED);
	const refs = makeRefs(world, world.width / 2, world.height / 2, { day: 20, hour: 18.2, night: true });
	for (let i = 0; i < count; i++) {
		const a = (i / count) * Math.PI * 2 + (i % 7) * 0.13;
		const r = radius * (0.75 + ((i * 37) % 50) / 100);
		const x = refs.player.x + Math.cos(a) * r;
		const y = refs.player.y + Math.sin(a) * r;
		const z = addZombie(refs, i % 11 === 0 ? 2 + (i % 4) : 1, x, y, a + Math.PI);
		z.detect = true;
	}
	return refs;
}

/** best of three passes: the JIT and the GC make a single pass swing by 30 % */
function bench(label, count, radius, frames) {
	let best = Infinity;
	let alive = 0;
	for (let pass = 0; pass < 3; pass++) {
		const refs = benchScene(count, radius);
		// warm-up: builds the flow field and lets the JIT settle, not part of the average
		for (let f = 0; f < 120; f++) zombieAI.updateZombies(refs, DT);
		const t0 = process.hrtime.bigint();
		for (let f = 0; f < frames; f++) zombieAI.updateZombies(refs, DT);
		const t1 = process.hrtime.bigint();
		best = Math.min(best, Number(t1 - t0) / 1e6 / frames);
		alive = refs.zombies.length;
	}
	const us = (best * 1000) / math.max(1, alive);
	info(`${label}: ${best.toFixed(3)} ms/frame · ${us.toFixed(2)} µs per zombie per frame (${alive} alive)`);
	return { ms: best, us };
}

/** hp a single walker takes off a standing survivor in 10 s — the wind-up must not gut the horde */
function biteRate() {
	setSeed(SEED);
	const world = W.createWorld(3000, 3000);
	const refs = makeRefs(world, 1500, 1500);
	addZombie(refs, 1, 1500, 1546, -Math.PI / 2);
	const p = refs.player;
	for (let f = 0; f < 60 * 10; f++) {
		// stepPlayer is not in this harness: run its i-frame bookkeeping by hand
		if (p.attacked) {
			p.iframe -= DT;
			if (p.iframe <= 0) {
				p.attacked = false;
				p.iframe = 0;
			}
		}
		zombieAI.updateZombies(refs, DT);
	}
	return refs.player.hpMax - refs.player.hp;
}

function testCost() {
	console.log("\n[9] cost (Node, transpiled TS — relative numbers, not Luau timings)");
	info(`one walker on a standing survivor: ${biteRate().toFixed(0)} hp in 10 s (bite cadence)`);
	const near = bench("150 zombies, all within 800 u (30 Hz ring)", 150, 500, 400);
	const mid = bench("150 zombies spread over 2000 u (mixed LOD)", 150, 1500, 400);
	const far = bench("150 zombies beyond 1600 u (5–10 Hz ring)", 150, 2400, 400);
	check(near.ms > 0 && mid.ms > 0 && far.ms > 0, "the benchmark ran");
	info(`LOD saving, far vs near: ${(100 - (far.ms / near.ms) * 100).toFixed(0)} % of the per-frame cost`);
}

// ---------------------------------------------------------------- 10. the authoritative horde

/** a server simulation with the horde on, `n` survivors placed `spread` apart, and `zeds` walkers injected */
function serverScene(n, spread, zeds, hour = 18.2, day = 20) {
	setSeed(SEED);
	resetEntityIds();
	const world = W.generateTown(DESIGN.TOWN_SEED);
	const sim = new simulationMod.ServerSimulation({ world, zombies: true });
	const horde = sim.horde;
	horde.clock.setClock(hour, day);
	const cx = world.width / 2;
	const cy = world.height / 2;
	for (let i = 0; i < n; i++) {
		const a = (i / Math.max(1, n)) * Math.PI * 2;
		const around = spread > 0 ? { x: cx + Math.cos(a) * spread, y: cy + Math.sin(a) * spread } : { x: cx, y: cy };
		const spot = serverPlayers.findSpawnPoint(world, { allies: [around] });
		const sp = serverPlayers.createServerPlayer(
			{ slot: i, userId: 1000 + i, name: `bot${i}` },
			defaultSave(),
			spot.x,
			spot.y,
			sim.tick,
			sim.simHz,
		);
		// the §3.2 measurement wants six survivors ALIVE for the whole run, and MP-09 is about where a zombie
		// may appear, not about whether a bot can fight: godMode keeps the roster standing without touching
		// the horde's behaviour (it still hunts, bites and crowds them).
		sp.state.godMode = true;
		sim.add(sp);
	}
	// the §3.2 scenario spawns the horde the way the admin panel does, instead of waiting for a whole night
	const players = sim.players();
	for (let i = 0; i < zeds; i++) {
		const p = players[i % players.length].state;
		const a = (i / zeds) * Math.PI * 2 + (i % 7) * 0.13;
		const r = 300 + ((i * 37) % 500);
		const z = createZombie(i % 11 === 0 ? 2 + (i % 4) : 1, p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, day, true);
		z.detect = true;
		horde.zombies.push(z);
	}
	return { world, sim, horde };
}

/**
 * A placement is sampled at the END of the tick it happened in, and by then the zombie has already taken one
 * step towards its target (a charger at full speed covers 12 u). MP-09 is about where the server may PUT a
 * body, so the sample gives that one step back.
 */
const CLOSING = 16;

function testServerHorde() {
	console.log("\n[10] the server owns the horde: one for everyone (§3.3, §3.5, §4.4)");

	// (a) the field's OWNER is the survivor a zombie can really reach first, not the nearest in a line
	{
		setSeed(SEED);
		const world = W.createWorld(3000, 3000);
		wall(world, 1500, 0, 32, 1400); // a wall whose only way round is at the bottom
		const field = new flowFieldMod.MultiFlowField();
		field.rebuild(world, [
			{ x: 600, y: 200, index: 0, seed: 0 },
			{ x: 1800, y: 200, index: 1, seed: 0 },
		]);
		const owner = field.targetOf(1400, 200);
		const straight = dist(1400, 200, 600, 200) < dist(1400, 200, 1800, 200) ? 0 : 1;
		info("a body at (1400, 200): 800 u from survivor 0, 400 u from survivor 1 through a wall");
		check(straight === 1, "the nearest survivor in a STRAIGHT line is the one behind the wall");
		check(owner === 0, "...but the field hands the cell to the one it can actually walk to (targetOf = 0)");
		check(field.targetOf(1900, 200) === 1, "a body on the other side belongs to the survivor on that side");
		check(field.contains(1400, 200) && field.pathCells(1400, 200) < 1e8, "the cell is inside the field");
	}

	// (b) MP-09 with SIX survivors, not just the local one
	{
		const { sim, horde } = serverScene(6, 1200, 0);
		const last = new Map();
		let placed = 0;
		let worst = Infinity;
		let peak = 0;
		let violations = 0;
		for (let t = 0; t < 60 * 120; t++) {
			sim.step();
			peak = Math.max(peak, horde.zombies.length);
			for (const z of horde.zombies) {
				const prev = last.get(z.id);
				const jumped = prev === undefined || Math.hypot(z.x - prev.x, z.y - prev.y) > 300;
				last.set(z.id, { x: z.x, y: z.y });
				if (!jumped) continue;
				placed++;
				let d = Infinity;
				for (const sp of sim.players()) d = Math.min(d, dist(z.x, z.y, sp.state.x, sp.state.y));
				worst = Math.min(worst, d);
				if (d < 720 - CLOSING) violations++;
			}
		}
		info(`${placed} placements . closest to ANY of the 6 survivors ${worst.toFixed(0)} u . peak ${peak}`);
		info(`cluster scales S(k) in play: ${horde.population.scales().join(", ")}`);
		check(placed > 20, `the server night actually spawned (${placed} placements)`);
		check(violations === 0, "no zombie was ever placed within 720 u of ANY survivor (MP-09)");
		check(peak <= 150, `the horde never passed the 150 ceiling (peak ${peak})`);
	}

	// (c) identity: every zombie has a netId, it never changes while it lives, and a death is announced once
	{
		const { sim, horde } = serverScene(2, 400, 40);
		sim.step();
		const seen = new Map();
		let zero = 0;
		for (const z of horde.zombies) {
			const id = horde.netIdOf(z);
			if (id === 0) zero++;
			seen.set(z.id, id);
		}
		check(zero === 0, `every zombie got a netId (${horde.zombies.length} of them)`);
		check(new Set(seen.values()).size() === seen.size(), "no two zombies share a netId");
		for (let t = 0; t < 30; t++) sim.step();
		let moved = 0;
		for (const z of horde.zombies) {
			if (seen.get(z.id) !== horde.netIdOf(z)) moved++;
		}
		check(moved === 0, "a netId never changes under a living zombie");

		const victim = horde.zombies[0];
		const victimNet = horde.netIdOf(victim);
		const vx = victim.x;
		const vy = victim.y;
		victim.hp = 0;
		sim.step();
		const deaths = horde.takeDeaths([]);
		const row = deaths.find(d => d.netId === victimNet);
		check(row !== undefined, "a zombie that dies is reported once, by netId");
		if (row !== undefined) {
			check(
				row.cause === zombiesMod.DeathCause.Killed,
				"...with the cause the client needs (blood, corpse, drop)",
			);
			check(dist(row.x, row.y, vx, vy) < 40, "...at the place it fell");
		}
		check(horde.takeDeaths([]).length === 0, "and never twice");
	}

	// (d) the client must not simulate a horde it does not own
	{
		setSeed(SEED);
		const world = W.createWorld(3000, 3000);
		const refs = makeRefs(world, 1500, 1500);
		const z = addZombie(refs, 1, 1500, 1200, Math.PI / 2);
		z.detect = true;
		const phase = mpConfig.MP_PHASE;
		mpConfig.MP_PHASE = 2;
		const x0 = z.x;
		const y0 = z.y;
		for (let f = 0; f < 60; f++) zombieAI.updateZombies(refs, DT);
		const still = dist(z.x, z.y, x0, y0) === 0;
		mpConfig.MP_PHASE = phase;
		check(still, "with MP_PHASE >= 2 the client does not move a single zombie (the server owns them)");
		for (let f = 0; f < 60; f++) zombieAI.updateZombies(refs, DT);
		check(dist(z.x, z.y, x0, y0) > 0, "...and with MP_PHASE < 2 the old single-player path still runs");
	}
}

// ---------------------------------------------------------------- 11. the §3.2 tick budget

function testTickCost() {
	console.log("\n[11] cost of a server tick with 150 zombies and 6 survivors (§3.2: p95 <= 6 ms in Luau)");
	const runs = [
		{ label: "6 survivors together (one cluster)", spread: 300 },
		{ label: "6 survivors spread out (worst case for the field)", spread: 3000 },
	];
	for (const run of runs) {
		const { sim, horde } = serverScene(6, run.spread, 150);
		// §12.2 wants the cost per STEP, not only per tick: the same hook the live server gives os.clock
		horde.nowMs = () => performance.now();
		for (let t = 0; t < 120; t++) sim.step(); // warm-up: the first field and the JIT
		const N = 1800;
		const samples = new Float64Array(N);
		const phases = { clock: 0, population: 0, field: 0, zombies: 0, bosses: 0, book: 0 };
		const peaks = { clock: 0, population: 0, field: 0, zombies: 0, bosses: 0, book: 0 };
		for (let t = 0; t < N; t++) {
			const t0 = performance.now();
			sim.step();
			samples[t] = performance.now() - t0;
			const c = horde.cost;
			phases.clock += c.clock;
			phases.population += c.population;
			phases.field += c.field;
			phases.zombies += c.zombies;
			phases.bosses += c.bosses;
			phases.book += c.book;
			for (const k in peaks) if (c[k] > peaks[k]) peaks[k] = c[k];
		}
		const sorted = Float64Array.from(samples).sort();
		let total = 0;
		for (const v of samples) total += v;
		const avg = total / N;
		const p95 = sorted[Math.floor(N * 0.95)];
		const p99 = sorted[Math.floor(N * 0.99)];
		info(
			`${run.label}: avg ${avg.toFixed(3)} ms . p95 ${p95.toFixed(3)} ms . p99 ${p99.toFixed(3)} ms ` +
				`(${horde.zombies.length} zombies)`,
		);
		info(
			`   field: ${horde.field.lastTiles} active tiles . ${horde.field.lastCells} cells per rebuild . ` +
				`${horde.field.cachedTiles()} tiles cached`,
		);
		info(
			"   per step (avg ms): " +
				Object.keys(phases)
					.map(k => `${k} ${(phases[k] / N).toFixed(3)}`)
					.join(" . "),
		);
		info(
			"   worst step (ms):   " +
				Object.keys(peaks)
					.map(k => `${k} ${peaks[k].toFixed(3)}`)
					.join(" . "),
		);
		check(avg > 0, "the measurement ran");
		// a regression guard, not the Luau verdict: Node is faster than a Roblox server, so this only has to
		// catch an accidental O(n^2) or an allocation storm. The real number comes from a Studio playtest.
		check(p95 < 16.7, `p95 stays inside one 60 Hz tick under Node (${p95.toFixed(3)} ms)`);
	}
}

// ---------------------------------------------------------------- run

const started = Date.now();
console.log(`[test-ai] src ${SRC}`);
console.log(`[test-ai] seed ${SEED}${MODERN ? "" : " · older src: only the measurements run"}`);

if (TICK_ONLY) {
	if (SERVER) testTickCost();
} else if (!BENCH_ONLY) {
	if (MODERN) {
		testSight();
		testHearing();
		testMemory();
		testAlert();
		testWaves();
		testSequence();
		testMotion();
	}
	testFlank();
	if (MODERN) {
		testDirector();
		testSpawnRules();
	}
	testDeterminism();
	if (MODERN) testBite();
	if (SERVER) testServerHorde();
}
if (!TICK_ONLY) {
	testCost();
	if (SERVER) testTickCost();
}

console.log(`\n[test-ai] ${failures === 0 ? "all good" : `${failures} failure(s)`} in ${Date.now() - started} ms`);
process.exit(failures === 0 ? 0 : 1);
