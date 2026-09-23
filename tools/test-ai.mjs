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
 *   1. SIGHT     a survivor behind a wall is not detected, one in the open is, and one behind the zombie is not;
 *   2. MEMORY    a zombie that loses its target walks to the LAST KNOWN POSITION, searches around it and gives up;
 *   3. ALERT     a shout wakes at most ALERT_MAX_WAKE zombies and cannot relay itself (no cascade);
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
const MODERN = perception !== undefined && memoryMod !== undefined && alertMod !== undefined;

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

// ---------------------------------------------------------------- 1. sight

function testSight() {
	console.log("\n[1] line of sight, range and cone (perception.ts)");
	const ranges = perception.senseRanges({ darkness: 0, night: false, raining: false }, false);
	info(`daylight: ${ranges.sight.toFixed(0)} u of sight, ±${math.deg(ranges.cone).toFixed(0)}°, no smell`);

	// (a) open ground, straight ahead: seen
	{
		setSeed(SEED);
		const world = W.createWorld(3000, 3000);
		const refs = makeRefs(world, 1500, 1500);
		const z = addZombie(refs, 1, 1500, 1200, Math.PI / 2);
		run(refs, 40);
		check(z.detect === true, "open ground, 300 u straight ahead → detected");
	}
	// (b) same, with a wall in between: not seen
	{
		setSeed(SEED);
		const world = W.createWorld(3000, 3000);
		wall(world, 1000, 1340, 1000, 32);
		const refs = makeRefs(world, 1500, 1500);
		const z = addZombie(refs, 1, 1500, 1200, Math.PI / 2);
		run(refs, 40);
		check(z.detect !== true, "same 300 u, wall in between → NOT detected");
	}
	// (c) in range, but behind its back
	{
		setSeed(SEED);
		const world = W.createWorld(3000, 3000);
		const refs = makeRefs(world, 1500, 1500);
		const z = addZombie(refs, 1, 1500, 1200, -Math.PI / 2);
		z.wanderPause = true;
		z.wanderTimer = 999;
		run(refs, 20);
		check(z.detect !== true, "400 u behind its back (outside the cone) → NOT detected");
	}
	// (d) rain/night: the original's blanket smell is untouched
	{
		setSeed(SEED);
		const world = W.createWorld(3000, 3000);
		wall(world, 1000, 1340, 1000, 32);
		const refs = makeRefs(world, 1500, 1500, { night: true });
		const z = addZombie(refs, 1, 1500, 1200, -Math.PI / 2);
		run(refs, 10);
		check(z.detect === true, "at night, behind a wall and facing away → still detected (original smell)");
	}
	// (e) darkness and rain shorten the eyes
	{
		const dusk = perception.senseRanges({ darkness: 0.5, night: false, raining: false }, false);
		const rain = perception.senseRanges({ darkness: 0, night: false, raining: true }, false);
		info(`dusk (darkness 0.5): ${dusk.sight.toFixed(0)} u · rain: ${rain.sight.toFixed(0)} u`);
		check(dusk.sight < ranges.sight && rain.sight < ranges.sight, "darkness and rain shorten the sight range");
	}
}

// ---------------------------------------------------------------- 2. memory

function testMemory() {
	console.log("\n[2] memory and investigation (memory.ts)");
	setSeed(SEED);
	const world = W.createWorld(4000, 4000);
	const refs = makeRefs(world, 1500, 1500);
	const z = addZombie(refs, 1, 1500, 1200, Math.PI / 2);
	run(refs, 40);
	if (z.detect !== true) {
		fail("the zombie never saw the survivor (setup)");
		return;
	}
	const seenX = z.lastSeenX;
	const seenY = z.lastSeenY;
	check(
		seenX !== undefined && dist(seenX, seenY, 1500, 1500) < 1,
		`remembers where it saw them: (${seenX?.toFixed(0)}, ${seenY?.toFixed(0)})`,
	);

	// the survivor is gone: out of range, out of sight
	refs.player.x = 1500;
	refs.player.y = 3200;
	let closest = Infinity;
	let searched = 0;
	let gaveUpAt = -1;
	for (let f = 0; f < 60 * 20; f++) {
		zombieAI.updateZombies(refs, DT);
		closest = Math.min(closest, dist(z.x, z.y, seenX, seenY));
		if (z.searchTimer !== undefined) searched++;
		if (gaveUpAt < 0 && z.detect !== true) gaveUpAt = f;
	}
	check(closest < memoryMod.SEARCH_ARRIVE, `walks to the last known position (got within ${closest.toFixed(0)} u)`);
	check(searched > 0, `searches around it (${(searched * DT).toFixed(1)} s of sweeping)`);
	check(gaveUpAt > 0, `gives up and goes back to wandering after ${(gaveUpAt * DT).toFixed(1)} s`);
	check(z.lastSeenX === undefined, "the memory is cleared when it gives up");
}

// ---------------------------------------------------------------- 3. group alert

function testAlert() {
	console.log("\n[3] the shout and its budget (alert.ts)");
	setSeed(SEED);
	const world = W.createWorld(4000, 4000);
	const refs = makeRefs(world, 1500, 1500);
	// one zombie looking straight at the survivor
	const spotter = addZombie(refs, 1, 1500, 1300, Math.PI / 2);
	// twelve within earshot of the spotter, all facing away and too far to see anything themselves
	const crowd = [];
	for (let i = 0; i < 12; i++) {
		const a = -Math.PI / 2 + (i / 11 - 0.5) * 1.6;
		const zz = addZombie(refs, 1, 1500 + Math.cos(a) * 390, 1300 + Math.sin(a) * 390, -Math.PI / 2);
		zz.wanderPause = true;
		zz.wanderTimer = 999;
		crowd.push(zz);
	}
	const tooClose = crowd.filter(z => dist(z.x, z.y, 1500, 1500) < perception.SIGHT_DAY).length;
	if (tooClose > 0) fail(`${tooClose} of the crowd could see the survivor by themselves (setup)`);
	run(refs, 12);
	const woken = crowd.filter(z => z.detect === true);
	check(spotter.detect === true, "the spotter sees the survivor and shouts");
	check(
		woken.length > 0 && woken.length <= alertMod.ALERT_MAX_WAKE,
		`the shout woke ${woken.length} of 12 (cap ${alertMod.ALERT_MAX_WAKE})`,
	);
	check(
		woken.every(z => (z.alertCd ?? 0) > 0),
		"every woken zombie is on cooldown: an alert cannot relay itself",
	);
	const reported = woken.filter(z => z.lastSeenX !== undefined && dist(z.lastSeenX, z.lastSeenY, 1500, 1500) < 1);
	check(reported.length === woken.length, "they are told WHERE the survivor was seen, not where the survivor is now");
	// and it does not snowball: the far half of the crowd is still unaware
	check(crowd.filter(z => z.detect !== true).length >= 12 - alertMod.ALERT_MAX_WAKE, "no cascade across the crowd");
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
		z.detect = true; // they know a survivor is in there; the question is HOW they get in
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
		testMemory();
		testAlert();
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
