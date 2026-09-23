#!/usr/bin/env node
/*
 * Network protocol tests (F0A, docs/MULTIPLAYER.md §2.2, §4, §8): round trip, defensive decoding, fuzz,
 * packet sizes and modular tick comparison for shared/net/{codec,protocol,mpConfig}.ts.
 *
 *   npm ci && node tools/test-net.mjs        # everything (exit code 1 on any failure)
 *   node tools/test-net.mjs --seed 12345     # another fuzz seed (default 1)
 *   node tools/test-net.mjs --fuzz 50000     # more fuzz iterations per decoder (default 10000)
 *   PZ_SRC=path/to/src node tools/test-net.mjs
 *
 * Pure Node (>= 18) + the project's TypeScript (devDependency) to transpile src/shared on the fly, like
 * tools/validate-world.mjs. The Luau globals the codec uses are shimmed here:
 *   - `buffer`: a STRICT version of the Luau library — out-of-bounds access throws (as in Luau) and an
 *     integer write outside the field range throws too (Luau would wrap silently), so a missing clamp in
 *     the codec fails the test instead of corrupting a neighbouring field.
 *   - `math`, `typeIs`, Array#size(), String#size() (byte length, like Luau's `#s`).
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
const FUZZ_N = argValue("--fuzz", 10000);

// ---------------------------------------------------------------- Luau shims

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
	pi: Math.PI,
	huge: Infinity,
	clamp: (v, a, b) => Math.min(Math.max(v, a), b),
};
globalThis.print = (...a) => console.log(...a);
globalThis.warn = (...a) => console.warn(...a);

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
defineMethod(Array.prototype, "clear", function () {
	this.length = 0;
});
defineMethod(String.prototype, "size", function () {
	return Buffer.byteLength(this.valueOf(), "utf8");
});

// "shared/x" → SRC/shared/x.ts, transpiled with the project's TypeScript (same loader as validate-world.mjs)
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

const codec = require(join(SRC, "shared/net/codec.ts"));
const P = require(join(SRC, "shared/net/protocol.ts"));
const CFG = require(join(SRC, "shared/net/mpConfig.ts"));
const legacyNet = require(join(SRC, "shared/net/net.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const { ZOMBIES } = require(join(SRC, "shared/data/zombies.ts"));
const { ItemKind } = require(join(SRC, "shared/data/kinds.ts"));
const { WEAPONS } = require(join(SRC, "shared/data/weapons.ts"));
const COS = require(join(SRC, "shared/data/cosmetics.ts"));
const TIT = require(join(SRC, "shared/data/titles.ts"));
const POW = require(join(SRC, "shared/data/power.ts"));
const SAVE = require(join(SRC, "shared/game/save.ts"));

// ---------------------------------------------------------------- tiny harness

const TAU = Math.PI * 2;
const failures = [];
let checks = 0;
let currentTest = "";
const sizes = [];

function fail(msg) {
	failures.push(`${currentTest}: ${msg}`);
}
function ok(cond, msg) {
	checks += 1;
	if (!cond) fail(msg);
}
function eq(name, got, want) {
	checks += 1;
	if (got !== want) fail(`${name}: got ${String(got)}, want ${String(want)}`);
}
function near(name, got, want, tol) {
	checks += 1;
	if (!(Math.abs(got - want) <= tol)) fail(`${name}: got ${got}, want ${want} (±${tol})`);
}
function angNear(name, got, want, tol) {
	checks += 1;
	const d = Math.abs((((got - want) % TAU) + TAU + Math.PI) % TAU) - Math.PI;
	if (!(Math.abs(d) <= tol)) fail(`${name}: got ${got} rad, want ${want} rad (±${tol})`);
}
function test(name, fn) {
	currentTest = name;
	const before = failures.length;
	const t0 = process.hrtime.bigint();
	try {
		fn();
	} catch (e) {
		fail(`threw ${(e && e.stack) || e}`);
	}
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	const n = failures.length - before;
	const mark = n === 0 ? "ok  " : "FAIL";
	console.log(`${mark} ${name}  (${ms.toFixed(0)} ms)${n > 0 ? ` — ${n} failure(s)` : ""}`);
}

/** deterministic PRNG so a failure is reproducible with --seed */
function mulberry32(a) {
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
let rnd = mulberry32(SEED);
const rint = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const rfloat = (lo, hi) => lo + rnd() * (hi - lo);
const rbool = () => rnd() < 0.5;
const pick = list => list[rint(0, list.length - 1)];

const bytesOf = b => Array.from(b.bytes);
const bufOf = arr => {
	const b = buffer.create(arr.length);
	for (let i = 0; i < arr.length; i++) buffer.writeu8(b, i, arr[i] & 0xff);
	return b;
};
const randBuf = len => {
	const b = buffer.create(len);
	for (let i = 0; i < len; i++) buffer.writeu8(b, i, rint(0, 255));
	return b;
};

// tolerances implied by the quantization of §4.2
const POS_TOL = 0.25 + 1e-9;
const ANG8_TOL = TAU / 512 + 1e-6;
const ANG16_TOL = TAU / 131072 + 1e-6;
const FRAC8_TOL = 1 / 510 + 1e-9;
const FRAC16_TOL = 1 / 131070 + 1e-9;

const WORLD_X = DESIGN.WORLD_W;
const WORLD_Y = DESIGN.WORLD_H;
const rx = () => rfloat(0, WORLD_X);
const ry = () => rfloat(0, WORLD_Y);
const rang = () => rfloat(-Math.PI, Math.PI);

// ---------------------------------------------------------------- 1. codec: numbers, ticks, quantization

test("codec: modular tick comparison (u16 wrap)", () => {
	eq("seqDiff(0, 65535)", codec.seqDiff(0, 65535), 1);
	eq("seqDiff(65535, 0)", codec.seqDiff(65535, 0), -1);
	eq("seqDiff(32767, 0)", codec.seqDiff(32767, 0), 32767);
	eq("seqDiff(32768, 0)", codec.seqDiff(32768, 0), -32768);
	eq("seqDiff(5, 5)", codec.seqDiff(5, 5), 0);
	ok(codec.seqNewer(0, 65535), "0 must be newer than 65535 (wrap)");
	ok(!codec.seqNewer(65535, 0), "65535 must not be newer than 0");
	ok(codec.seqNewer(1, 0) && !codec.seqNewer(0, 1) && !codec.seqNewer(7, 7), "basic ordering");
	eq("wrapU16(-1)", codec.wrapU16(-1), 65535);
	eq("wrapU16(65536)", codec.wrapU16(65536), 0);
	eq("wrapU16(NaN)", codec.wrapU16(NaN), 0);
	eq("wrapU16(inf)", codec.wrapU16(Infinity), 0);
	eq("wrapU16(-70000.7)", codec.wrapU16(-70000.7), codec.wrapU16(-70001 + 65536 * 2));
	for (let i = 0; i < 20000; i++) {
		const a = rint(0, 65535);
		const d = rint(-32767, 32767);
		const b = codec.wrapU16(a + d);
		if (codec.seqDiff(b, a) !== d) fail(`seqDiff(wrap(${a}+${d}), ${a}) = ${codec.seqDiff(b, a)}`);
		if (d !== 0 && codec.seqNewer(b, a) !== d > 0) fail(`seqNewer(${b}, ${a}) wrong for d=${d}`);
		checks += 2;
	}
	// a u16 tick wraps every ~18 min at 60 Hz: rebuilding the full tick must survive it
	for (let i = 0; i < 20000; i++) {
		const full = rint(0, 10000000);
		const d = rint(-30000, 30000);
		const got = codec.unwrapTick(codec.wrapU16(full + d), full);
		if (got !== full + d) fail(`unwrapTick: got ${got}, want ${full + d}`);
		checks += 1;
	}
});

test("codec: quantization ranges and clamping", () => {
	ok(WORLD_X * codec.POS_SCALE <= 65535, `world width ${WORLD_X} must fit u16 at 0.5 u`);
	ok(WORLD_Y * codec.POS_SCALE <= 65535, `world height ${WORLD_Y} must fit u16 at 0.5 u`);
	eq("quantPos(-5)", codec.quantPos(-5), 0);
	eq("quantPos(1e9)", codec.quantPos(1e9), 65535);
	eq("quantPos(NaN)", codec.quantPos(NaN), 0);
	eq("quantAngle8(NaN)", codec.quantAngle8(NaN), 0);
	eq("quantFrac8(-1)", codec.quantFrac8(-1), 0);
	eq("quantFrac8(5)", codec.quantFrac8(5), 255);
	for (let i = 0; i < 20000; i++) {
		const x = rfloat(0, WORLD_X);
		near("pos", codec.dequantPos(codec.quantPos(x)), x, POS_TOL);
		const a = rfloat(-20, 20);
		angNear("angle8", codec.dequantAngle8(codec.quantAngle8(a)), a, ANG8_TOL);
		angNear("angle16", codec.dequantAngle16(codec.quantAngle16(a)), a, ANG16_TOL);
		const r = rfloat(-Math.PI, Math.PI) * 0.98;
		angNear("relAngle8", codec.dequantRelAngle8(codec.quantRelAngle8(r)), r, ANG8_TOL);
		const f = rnd();
		near("frac8", codec.dequantFrac8(codec.quantFrac8(f)), f, FRAC8_TOL);
		near("frac16", codec.dequantFrac16(codec.quantFrac16(f)), f, FRAC16_TOL);
	}
	// the 8 keyboard directions land on exact u8 steps (§2.2)
	for (let k = 0; k < 8; k++) {
		const a = (k * Math.PI) / 4;
		const q = codec.quantAngle8(Math.atan2(Math.sin(a), Math.cos(a)));
		eq(`keyboard direction ${k}`, q % 32, 0);
	}
	// quantized values survive a second round trip unchanged (decode → encode is stable)
	for (let i = 0; i < 5000; i++) {
		const q = rint(0, 65535);
		eq("pos requant", codec.quantPos(codec.dequantPos(q)), q);
		const q8 = rint(0, 255);
		eq("angle8 requant", codec.quantAngle8(codec.dequantAngle8(q8)), q8);
		eq("frac8 requant", codec.quantFrac8(codec.dequantFrac8(q8)), q8);
	}
});

test("codec: writer clamps, grows and latches overflow", () => {
	const w = new codec.NetWriter(1, 8);
	w.u8(300);
	w.u8(-7);
	w.u8(NaN);
	w.u16(70000);
	w.i8(-500);
	w.i8(500);
	eq("length after 6 B", w.length(), 7);
	const b = w.finish();
	eq("u8 clamp high", buffer.readu8(b, 0), 255);
	eq("u8 clamp low", buffer.readu8(b, 1), 0);
	eq("u8 NaN", buffer.readu8(b, 2), 0);
	eq("u16 clamp", buffer.readu16(b, 3), 65535);
	eq("i8 clamp low", buffer.readi8(b, 5), -128);
	eq("i8 clamp high", buffer.readi8(b, 6), 127);
	w.u16(1); // 2 more bytes do not fit in 8
	ok(w.failed(), "writer must latch the overflow");
	eq("finish() after overflow", w.finish(), undefined);
	w.rollback(4);
	ok(!w.failed() && w.length() === 4, "rollback clears the latch and rewinds");
	const grow = new codec.NetWriter(2, 4096);
	for (let i = 0; i < 4096; i++) grow.u8(i % 256);
	ok(!grow.failed(), "writer must grow up to maxBytes");
	eq("grown length", buffer.len(grow.finish()), 4096);
	const f = new codec.NetWriter(16, 16);
	f.f32(NaN);
	f.f32(1e40);
	const fb = f.finish();
	eq("f32(NaN) → 0", buffer.readf32(fb, 0), 0);
	ok(buffer.readf32(fb, 4) > 3.4e38 && Number.isFinite(buffer.readf32(fb, 4)), "f32(1e40) → largest f32");
});

test("codec: reader never reads past the end", () => {
	const b = bufOf([1, 2, 3]);
	const r = new codec.NetReader(b);
	eq("u8", r.u8(), 1);
	eq("remaining", r.remaining(), 2);
	eq("u32 over the edge", r.u32(), 0);
	ok(!r.ok(), "reader must latch the failure");
	eq("further reads", r.u32(), 0);
	const empty = new codec.NetReader(buffer.create(0));
	eq("u8 on empty", empty.u8(), 0);
	ok(!empty.ok(), "empty buffer latches");
	// NaN float from a hostile payload
	const nan = buffer.create(4);
	buffer.writeu32(nan, 0, 0x7fc00000);
	const rn = new codec.NetReader(nan);
	rn.f32();
	ok(!rn.ok(), "NaN f32 must latch the failure");
	// strict bool and capped string
	const bad = bufOf([2]);
	const rb = new codec.NetReader(bad);
	rb.bool();
	ok(!rb.ok(), "bool accepts only 0/1");
	const s = new codec.NetWriter(64, 64);
	s.str("hello", 32);
	const rs = new codec.NetReader(s.finish());
	eq("str round trip", rs.str(32), "hello");
	const rs2 = new codec.NetReader(bufOf([200, 1, 2]));
	rs2.str(8);
	ok(!rs2.ok(), "a length above the cap must latch");
});

test("codec: strings are cut on a UTF-8 boundary", () => {
	const w = new codec.NetWriter(128, 128);
	const accented = "é".repeat(30); // 60 bytes
	w.str(accented, 25);
	const got = new codec.NetReader(w.finish()).str(25);
	eq("truncated to whole characters", got, "é".repeat(12));
	ok(!got.includes("�"), "must not cut a character in half");
	const w2 = new codec.NetWriter(128, 128);
	const emoji = "🧟".repeat(10); // 4 bytes each
	w2.str(emoji, 10);
	const got2 = new codec.NetReader(w2.finish()).str(10);
	eq("emoji truncation", got2, "🧟".repeat(2));
	const w3 = new codec.NetWriter(128, 128);
	w3.str("ProjectZ", 80);
	eq("short string untouched", new codec.NetReader(w3.finish()).str(80), "ProjectZ");
});

// ---------------------------------------------------------------- 2. mpConfig / protocol constants

test("mpConfig: values match the doc and the game data", () => {
	// Pinned on purpose: the phase decides how much of the game the server owns, so it must never move by
	// accident. Bump this together with docs/MULTIPLAYER.md S11.3 when a phase actually lands. F1 (server
	// owns player movement; zombies still local per client) is on for internal testing.
	eq("MP_PHASE", CFG.MP_PHASE, 2);
	eq("SIM_HZ", CFG.SIM_HZ, 60);
	near("TICK_DT", CFG.TICK_DT, 1 / 60, 1e-12);
	eq("MAX_PLAYERS", CFG.MAX_PLAYERS, 6);
	eq("MAX_ZOMBIES", CFG.MAX_ZOMBIES, 150);
	eq("MAX_BOSSES", CFG.MAX_BOSSES, 2);
	eq("INPUT_MAX_BYTES", CFG.INPUT_MAX_BYTES, 28);
	eq("INPUT_RATE", CFG.INPUT_RATE, 120);
	eq("INPUT_BURST", CFG.INPUT_BURST, 40);
	eq("INPUT_BUFFER_TARGET", CFG.INPUT_BUFFER_TARGET, 2);
	eq("INPUT_BUFFER_MAX", CFG.INPUT_BUFFER_MAX, 4);
	eq("snapshot divisor at 60 Hz", CFG.SNAP_NEAR_EVERY_TICKS, 3);
	eq("mid ring divisor at 60 Hz", CFG.SNAP_MID_EVERY_TICKS, 6);
	eq("divisor at the 30 Hz fallback", CFG.ticksPer(20, CFG.SIM_HZ_FALLBACK), 2);
	eq("mid divisor at 30 Hz", CFG.ticksPer(10, CFG.SIM_HZ_FALLBACK), 3);
	eq("ticksPer(0) is safe", CFG.ticksPer(0), 1);
	ok(CFG.SNAP_MAX_BYTES <= CFG.UNRELIABLE_PAYLOAD_LIMIT, "the Snap ceiling must stay under the engine limit");
	ok(CFG.FX_MAX_BYTES <= CFG.UNRELIABLE_PAYLOAD_LIMIT, "the Fx ceiling must stay under the engine limit");
	eq("ZOMBIE_TYPE_MAX vs data/zombies.ts", CFG.ZOMBIE_TYPE_MAX, ZOMBIES.length);
	ok(
		ZOMBIES.every(z => z.id >= 1 && z.id <= CFG.ZOMBIE_TYPE_MAX && CFG.ZOMBIE_TYPE_MAX <= 7),
		"zombie type ids must fit the 3 bits of the snapshot meta byte",
	);
	const maxItemKind = Math.max(...Object.values(ItemKind));
	eq("ITEM_KIND_MAX vs data/kinds.ts", P.ITEM_KIND_MAX, maxItemKind);
	ok(
		WEAPONS.every(w => w.id >= 0 && w.id <= 255 && w.mag <= 255),
		"weapon ids and magazines must fit the u8 fields of the self block",
	);
	const names = P.MP_REMOTES.map(r => r.name);
	eq("no duplicate remote name", new Set(names).size, names.length);
	const legacy = [
		legacyNet.REMOTE_LOAD_REQUEST,
		legacyNet.REMOTE_LOAD_ACK,
		legacyNet.REMOTE_SAVE_REQUEST,
		legacyNet.REMOTE_SAVE_ACK,
		legacyNet.REMOTE_SHOP_ACTION,
	];
	ok(!names.some(n => legacy.includes(n)), "new remotes must not collide with the ones in net.ts");
});

// ---------------------------------------------------------------- 3. Input (C→S)

function randCommand(seq) {
	return P.makeCommand(seq, rfloat(-1, 1), rfloat(-1, 1), rang(), rint(0, 7), rint(0, 255));
}
function randInputPacket(n = 3, seq = rint(0, 65535)) {
	const cmds = [];
	for (let i = 0; i < n; i++) cmds.push(randCommand(codec.wrapU16(seq - i)));
	return { viewTick: rint(0, 65535), viewFrac: rint(0, 255), cmds };
}

test("Input: round trip, quantization and exact sizes", () => {
	eq("3 commands = 28 B (§2.2)", P.inputPacketBytes(3), 28);
	for (let i = 0; i < 5000; i++) {
		const n = rint(1, 3);
		const p = randInputPacket(n);
		const buf = P.encodeInput(p);
		ok(buf !== undefined, "encodeInput must accept a valid packet");
		eq("packet size", buffer.len(buf), 4 + 8 * n);
		const d = P.decodeInput(buf);
		ok(d !== undefined, "decodeInput must accept what encodeInput produced");
		eq("viewTick", d.viewTick, p.viewTick);
		eq("viewFrac", d.viewFrac, p.viewFrac);
		eq("command count", d.cmds.length, n);
		for (let k = 0; k < n; k++) {
			const a = p.cmds[k];
			const b = d.cmds[k];
			eq("seq", b.seq, a.seq);
			eq("moveAng", b.moveAng, a.moveAng);
			eq("moveMag", b.moveMag, a.moveMag);
			eq("aim", b.aim, a.aim);
			eq("held", b.held, a.held);
			eq("edges", b.edges, a.edges);
		}
	}
	sizes.push(["Input (3 commands, 60/s)", buffer.len(P.encodeInput(randInputPacket(3))), "28 B (§2.2)"]);
	sizes.push(["Input (1 command)", buffer.len(P.encodeInput(randInputPacket(1))), "12 B"]);
});

test("Input: quantized command = what the server reads", () => {
	// the 8 keyboard directions survive quantization exactly, magnitude 1
	const dirs = [
		[1, 0],
		[1, 1],
		[0, 1],
		[-1, 1],
		[-1, 0],
		[-1, -1],
		[0, -1],
		[1, -1],
	];
	for (const [dx, dy] of dirs) {
		const len = Math.hypot(dx, dy);
		const cmd = P.makeCommand(1, dx / len, dy / len, 0, 0, 0);
		eq("moveMag full", cmd.moveMag, 255);
		eq("direction on an exact step", cmd.moveAng % 32, 0);
		const v = P.commandMove(cmd);
		near("move x", v.x, dx / len, 1e-6);
		near("move y", v.y, dy / len, 1e-6);
	}
	const still = P.makeCommand(1, 0, 0, 1.2, 0, 0);
	eq("standing still: moveMag", still.moveMag, 0);
	eq("standing still: moveAng", still.moveAng, 0);
	eq("standing still: vector x", P.commandMove(still).x, 0);
	// an over-long analog vector is clamped, never amplified
	const over = P.makeCommand(1, 5, 5, 0, 0, 0);
	eq("clamped magnitude", over.moveMag, 255);
	const nanCmd = P.makeCommand(1, NaN, 2, NaN, NaN, NaN);
	eq("NaN move", nanCmd.moveMag, 0);
	eq("NaN aim", nanCmd.aim, 0);
	eq("NaN held", nanCmd.held, 0);
	for (let i = 0; i < 2000; i++) {
		const a = rang();
		angNear("aim round trip", P.commandAim(P.makeCommand(0, 0, 0, a, 0, 0)), a, ANG16_TOL);
	}
	const edges = P.packEdges(3, 2, 1, 0);
	eq("attack presses", P.edgeCount(edges, P.EdgeShift.AttackPress), 3);
	eq("attack releases", P.edgeCount(edges, P.EdgeShift.AttackRelease), 2);
	eq("action presses", P.edgeCount(edges, P.EdgeShift.ActionPress), 1);
	eq("reloads", P.edgeCount(edges, P.EdgeShift.Reload), 0);
	eq("counters are clamped to 3", P.edgeCount(P.packEdges(9, 0, 0, 0), P.EdgeShift.AttackPress), 3);
	// viewTick rebuilt across the u16 wrap
	const vp = { viewTick: codec.wrapU16(65534), viewFrac: 128, cmds: [randCommand(0)] };
	near("viewTime across the wrap", P.viewTime(vp, 65540), 65534.5, 1e-9);
});

test("Input: hostile payloads are refused", () => {
	const valid = P.encodeInput(randInputPacket(3));
	const bytes = bytesOf(valid);
	for (const bad of [undefined, null, 0, 1.5, "buffer", {}, [], true, NaN]) {
		eq(`decodeInput(${String(bad)})`, P.decodeInput(bad), undefined);
	}
	eq("empty buffer", P.decodeInput(buffer.create(0)), undefined);
	eq("header only", P.decodeInput(buffer.create(4)), undefined);
	eq("length not 4+8n", P.decodeInput(bufOf(bytes.slice(0, 13))), undefined);
	eq("4 commands (36 B)", P.decodeInput(bufOf(bytes.concat(bytes.slice(4, 12)))), undefined);
	const wrongCount = bytes.slice();
	wrongCount[0] = 2;
	eq("count field lying", P.decodeInput(bufOf(wrongCount)), undefined);
	const reservedHeld = bytes.slice();
	reservedHeld[10] = 0xff; // held of the first command
	eq("reserved held bits", P.decodeInput(bufOf(reservedHeld)), undefined);
	const gap = bytes.slice();
	gap[12] = (gap[12] + 7) & 0xff; // seq of the second command
	eq("non-consecutive seqs", P.decodeInput(bufOf(gap)), undefined);
	const trailing = bytes.concat([0]);
	eq("trailing byte", P.decodeInput(bufOf(trailing)), undefined);
	// the encoder refuses to build an invalid packet
	eq("encode without commands", P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [] }), undefined);
	eq(
		"encode with 4 commands",
		P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [0, 1, 2, 3].map(i => randCommand(100 - i)) }),
		undefined,
	);
	eq(
		"encode with a gap in the seqs",
		P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [randCommand(100), randCommand(98)] }),
		undefined,
	);
	// the redundancy works across the wrap: seq 1 carries 0 and 65535
	const wrapPacket = { viewTick: 0, viewFrac: 0, cmds: [randCommand(1), randCommand(0), randCommand(65535)] };
	ok(P.decodeInput(P.encodeInput(wrapPacket)) !== undefined, "redundancy must survive the u16 wrap");
});

// ---------------------------------------------------------------- 4. Snapshot (S→C)

function randSelf() {
	return {
		x: rx(),
		y: ry(),
		ackSeq: rint(0, 65535),
		bufDepth: rint(0, 4),
		reactionSpeed: rfloat(0, 10),
		reactionDir: rang(),
		hp: rfloat(0, 200),
		hunger: rint(0, 100),
		flags: rint(0, 255),
		iframe: rfloat(0, 2.5),
		mag: rint(0, 120),
		reload: rnd(),
		spread: rfloat(0, 60),
		draw: rnd(),
		bleed: rnd(),
		modFlags: rint(0, 7),
		weapon: rint(0, 29),
	};
}
function randPlayer(slot) {
	return {
		slot,
		x: rx(),
		y: ry(),
		aim: rang(),
		flags: rint(0, 255),
		weapon: rint(0, 29),
		swing: rfloat(-3, 3),
		hp: rnd(),
		revive: rnd(),
		moveAng: rang(),
	};
}
function randZombie(netId, withExtra = rbool(), mid = rbool()) {
	const z = {
		netId,
		x: rx(),
		y: ry(),
		angle: rang(),
		flags: rint(0, 127),
		type: rint(1, CFG.ZOMBIE_TYPE_MAX),
		big: rbool(),
		mid,
	};
	if (withExtra) z.extra = rint(0, 255);
	return z;
}
function randBoss(netId) {
	return {
		netId,
		type: rint(1, CFG.BOSS_TYPE_MAX),
		x: rx(),
		y: ry(),
		angle: rang(),
		hp: rnd(),
		flags: rint(0, 255),
		phase: rint(0, 255),
		extra: rint(0, 255),
	};
}
function randSnapshot(nPlayers, nZombies, nBosses, withSelf = true, extrasFirst = false) {
	const players = [];
	for (let i = 0; i < nPlayers; i++) players.push(randPlayer(i % CFG.MAX_PLAYERS));
	const zombies = [];
	for (let i = 0; i < nZombies; i++) zombies.push(randZombie(i + 1, extrasFirst ? i < 9 : rbool()));
	const bosses = [];
	for (let i = 0; i < nBosses; i++) bosses.push(randBoss(i + 1));
	return { tick: rint(0, 65535), self: withSelf ? randSelf() : undefined, players, zombies, bosses };
}

/** decodes every part and merges them back (what the client does) */
function decodeParts(parts) {
	const merged = { tick: undefined, self: undefined, players: [], zombies: [], bosses: [] };
	for (let i = 0; i < parts.length; i++) {
		const d = P.decodeSnapshotPart(parts[i]);
		if (d === undefined) {
			fail(`part ${i} did not decode`);
			return undefined;
		}
		eq("part index", d.part, i);
		eq("part count", d.parts, parts.length);
		ok(
			buffer.len(parts[i]) <= CFG.SNAP_MAX_BYTES,
			`part ${i} is ${buffer.len(parts[i])} B > ${CFG.SNAP_MAX_BYTES}`,
		);
		if (merged.tick === undefined) merged.tick = d.tick;
		else eq("same tick in every part", d.tick, merged.tick);
		if (d.self !== undefined) merged.self = d.self;
		for (const p of d.players) merged.players.push(p);
		for (const z of d.zombies) merged.zombies.push(z);
		for (const b of d.bosses) merged.bosses.push(b);
	}
	return merged;
}

function compareSnapshot(sent, got) {
	eq("tick", got.tick, sent.tick);
	if (sent.self !== undefined) {
		const a = sent.self;
		const b = got.self;
		if (b === undefined) return fail("the self block did not come back");
		near("self.x", b.x, Math.fround(a.x), 1e-9); // f32: exact reconciliation
		near("self.y", b.y, Math.fround(a.y), 1e-9);
		eq("self.ackSeq", b.ackSeq, a.ackSeq);
		eq("self.bufDepth", b.bufDepth, a.bufDepth);
		near("self.reactionSpeed", b.reactionSpeed, a.reactionSpeed, 1 / 50 + 1e-9);
		angNear("self.reactionDir", b.reactionDir, a.reactionDir, ANG8_TOL);
		near("self.hp", b.hp, a.hp, 1 / 200 + 1e-9);
		eq("self.hunger", b.hunger, a.hunger);
		eq("self.flags", b.flags, a.flags);
		near("self.iframe", b.iframe, a.iframe, 1 / 200 + 1e-9);
		eq("self.mag", b.mag, a.mag);
		near("self.reload", b.reload, a.reload, FRAC8_TOL);
		near("self.spread", b.spread, a.spread, 1 / 8 + 1e-9);
		near("self.draw", b.draw, a.draw, FRAC8_TOL);
		near("self.bleed", b.bleed, a.bleed, FRAC8_TOL);
		eq("self.modFlags", b.modFlags, a.modFlags);
		eq("self.weapon", b.weapon, a.weapon);
	}
	eq("player count", got.players.length, sent.players.length);
	for (let i = 0; i < sent.players.length; i++) {
		const a = sent.players[i];
		const b = got.players[i];
		eq("slot", b.slot, a.slot);
		near("player x", b.x, a.x, POS_TOL);
		near("player y", b.y, a.y, POS_TOL);
		angNear("player aim", b.aim, a.aim, ANG8_TOL);
		eq("player flags", b.flags, a.flags);
		eq("player weapon", b.weapon, a.weapon);
		angNear("player swing", b.swing, a.swing, ANG8_TOL);
		near("player hp", b.hp, a.hp, FRAC8_TOL);
		near("player revive", b.revive, a.revive, FRAC8_TOL);
		angNear("player moveAng", b.moveAng, a.moveAng, ANG8_TOL);
	}
	eq("boss count", got.bosses.length, sent.bosses.length);
	for (let i = 0; i < sent.bosses.length; i++) {
		const a = sent.bosses[i];
		const b = got.bosses[i];
		eq("boss netId", b.netId, a.netId);
		eq("boss type", b.type, a.type);
		near("boss x", b.x, a.x, POS_TOL);
		near("boss y", b.y, a.y, POS_TOL);
		angNear("boss angle", b.angle, a.angle, ANG8_TOL);
		near("boss hp", b.hp, a.hp, FRAC16_TOL);
		eq("boss flags", b.flags, a.flags);
		eq("boss phase", b.phase, a.phase);
		eq("boss extra", b.extra, a.extra);
	}
	for (let i = 0; i < got.zombies.length; i++) {
		const a = sent.zombies[i];
		const b = got.zombies[i];
		eq("zombie netId", b.netId, a.netId);
		near("zombie x", b.x, a.x, POS_TOL);
		near("zombie y", b.y, a.y, POS_TOL);
		angNear("zombie angle", b.angle, a.angle, ANG8_TOL);
		eq("zombie flags", b.flags, a.flags);
		eq("zombie type", b.type, a.type);
		eq("zombie big", b.big, a.big);
		eq("zombie mid ring", b.mid, a.mid);
		eq("zombie extra", b.extra, a.extra);
	}
}

test("Snap: round trip, parts and quantization", () => {
	for (let i = 0; i < 400; i++) {
		const sent = randSnapshot(rint(0, 5), rint(0, 120), rint(0, 2), rbool());
		const res = P.encodeSnapshot(sent);
		eq("nothing dropped", res.dropped, 0);
		ok(res.parts.length >= 1 && res.parts.length <= CFG.SNAP_MAX_PARTS, "part count out of range");
		const got = decodeParts(res.parts);
		if (got === undefined) continue;
		eq("zombie count", got.zombies.length, sent.zombies.length);
		compareSnapshot(sent, got);
	}
	// a snapshot without a self block (dead player spectating) and without entities
	const bare = { tick: 7, players: [], zombies: [], bosses: [] };
	const only = P.encodeSnapshot(bare);
	eq("single part", only.parts.length, 1);
	eq("header only", buffer.len(only.parts[0]), P.SNAP_HEADER_BYTES);
	const d = P.decodeSnapshotPart(only.parts[0]);
	eq("tick", d.tick, 7);
	eq("no self block", d.self, undefined);
});

test("Snap: worst case of the doc fits 900 B per packet", () => {
	// §4.2: 6 players (self + 5), 60 near zombies + 30 of the mid ring, 2 bosses ≈ 934 B → 2 parts
	rnd = mulberry32(SEED + 1);
	const worst = randSnapshot(5, 90, 2, true, true);
	const res = P.encodeSnapshot(worst);
	eq("nothing dropped in the worst case", res.dropped, 0);
	eq("parts in the worst case", res.parts.length, 2);
	let total = 0;
	for (const part of res.parts) {
		ok(buffer.len(part) <= CFG.SNAP_MAX_BYTES, `part of ${buffer.len(part)} B above the ceiling`);
		ok(buffer.len(part) <= CFG.UNRELIABLE_PAYLOAD_LIMIT, "part above the engine limit");
		total += buffer.len(part);
	}
	const got = decodeParts(res.parts);
	compareSnapshot(worst, got);
	sizes.push([
		"Snap worst case (self + 5 players + 90 zombies + 2 bosses, 9 extras)",
		`${total} B in ${res.parts.length} parts (${res.parts.map(p => buffer.len(p)).join(" + ")})`,
		"≈934 B + 8 B of the 2nd header (§4.2)",
	]);
	// no extras: exactly the doc's number plus the extra header
	const plain = randSnapshot(5, 90, 2, true, false);
	for (const z of plain.zombies) delete z.extra;
	const plainRes = P.encodeSnapshot(plain);
	let plainTotal = 0;
	for (const p of plainRes.parts) plainTotal += buffer.len(p);
	eq("worst case without extras", plainTotal, 934 + P.SNAP_HEADER_BYTES);
	sizes.push(["Snap worst case without extras", `${plainTotal} B in ${plainRes.parts.length} parts`, "934 B (§4.2)"]);
	// typical case (§4.7): day, 3 players, 25 visible zombies
	const typical = randSnapshot(2, 25, 0, true, false);
	for (const z of typical.zombies) delete z.extra;
	const typRes = P.encodeSnapshot(typical);
	eq("typical case in a single part", typRes.parts.length, 1);
	sizes.push([
		"Snap typical (self + 2 players + 25 zombies)",
		`${buffer.len(typRes.parts[0])} B`,
		"8 + 28 + 24 + 225 = 285 B",
	]);
	// the admin cap (250 zombies) still fits in the 4 parts
	const admin = randSnapshot(5, CFG.MAX_ZOMBIES_ADMIN, 2, true, false);
	const adminRes = P.encodeSnapshot(admin);
	let adminTotal = 0;
	for (const p of adminRes.parts) {
		adminTotal += buffer.len(p);
		ok(buffer.len(p) <= CFG.SNAP_MAX_BYTES, "part above the ceiling with 250 zombies");
	}
	sizes.push([
		`Snap with the admin cap (${CFG.MAX_ZOMBIES_ADMIN} zombies)`,
		`${adminTotal} B in ${adminRes.parts.length} parts, ${adminRes.dropped} dropped`,
		"4 parts max (§4.2, decision 1)",
	]);
	// beyond that the extra entities are dropped, never truncated mid-packet
	const flood = randSnapshot(5, 500, 2, true, false);
	const floodRes = P.encodeSnapshot(flood);
	eq("parts capped", floodRes.parts.length, CFG.SNAP_MAX_PARTS);
	ok(floodRes.dropped > 0, "zombies past the last part must be counted as dropped");
	const floodGot = decodeParts(floodRes.parts);
	eq("dropped accounting", floodGot.zombies.length + floodRes.dropped, flood.zombies.length);
	// players/bosses above the caps are dropped and counted too
	const many = randSnapshot(9, 0, 5, true, false);
	const manyRes = P.encodeSnapshot(many);
	eq("extra players and bosses dropped", manyRes.dropped, 9 - CFG.MAX_PLAYERS + (5 - CFG.MAX_BOSSES));
	rnd = mulberry32(SEED);
});

test("Snap: snapshotBytes() matches the encoder", () => {
	for (let i = 0; i < 200; i++) {
		const nPlayers = rint(0, 5);
		const nZombies = rint(0, 150);
		const nBosses = rint(0, 2);
		const withSelf = rbool();
		const extras = Math.min(nZombies, rint(0, 12));
		const snap = randSnapshot(nPlayers, nZombies, nBosses, withSelf, false);
		for (let k = 0; k < snap.zombies.length; k++) {
			if (k < extras) snap.zombies[k].extra = 1;
			else delete snap.zombies[k].extra;
		}
		const res = P.encodeSnapshot(snap);
		let total = 0;
		for (const p of res.parts) total += buffer.len(p);
		eq(
			`snapshotBytes(${withSelf}, ${nPlayers}, ${nBosses}, ${nZombies}, ${extras})`,
			P.snapshotBytes(withSelf, nPlayers, nBosses, nZombies, extras),
			total,
		);
	}
});

test("Snap: malformed parts are refused", () => {
	const res = P.encodeSnapshot(randSnapshot(3, 20, 1, true));
	const good = bytesOf(res.parts[0]);
	for (const bad of [undefined, null, 0, "x", {}, [], true]) eq("non-buffer", P.decodeSnapshotPart(bad), undefined);
	eq("empty", P.decodeSnapshotPart(buffer.create(0)), undefined);
	eq("truncated header", P.decodeSnapshotPart(bufOf(good.slice(0, 7))), undefined);
	const wrongKind = good.slice();
	wrongKind[0] = (9 << 4) | (good[0] & 0x0f);
	eq("unknown packet kind", P.decodeSnapshotPart(bufOf(wrongKind)), undefined);
	const badPart = good.slice();
	badPart[0] = (1 << 4) | (3 << 2) | 0; // part 3 of 1
	eq("part >= parts", P.decodeSnapshotPart(bufOf(badPart)), undefined);
	const manyPlayers = good.slice();
	manyPlayers[3] = 7;
	eq("7 players", P.decodeSnapshotPart(bufOf(manyPlayers)), undefined);
	const manyBosses = good.slice();
	manyBosses[5] = 3;
	eq("3 bosses", P.decodeSnapshotPart(bufOf(manyBosses)), undefined);
	const unknownFlag = good.slice();
	unknownFlag[6] = 0xff;
	eq("unknown flag bits", P.decodeSnapshotPart(bufOf(unknownFlag)), undefined);
	eq("trailing byte", P.decodeSnapshotPart(bufOf(good.concat([0]))), undefined);
	eq("cut in the middle", P.decodeSnapshotPart(bufOf(good.slice(0, good.length - 3))), undefined);
	// a self block outside part 0
	const p1 = bytesOf(P.encodeSnapshot(randSnapshot(0, 400, 0, true)).parts[1]);
	p1[6] = P.SnapFlag.Self;
	eq("self block in part 1", P.decodeSnapshotPart(bufOf(p1)), undefined);
	// invalid zombie type / reserved meta bits: build one part by hand
	const one = P.encodeSnapshot({ tick: 1, players: [], zombies: [randZombie(5, false, false)], bosses: [] });
	const zb = bytesOf(one.parts[0]);
	const metaAt = zb.length - 1;
	const type0 = zb.slice();
	type0[metaAt] = 0;
	eq("zombie type 0", P.decodeSnapshotPart(bufOf(type0)), undefined);
	const type6 = zb.slice();
	type6[metaAt] = CFG.ZOMBIE_TYPE_MAX + 1;
	eq("zombie type above the data", P.decodeSnapshotPart(bufOf(type6)), undefined);
	const reserved = zb.slice();
	reserved[metaAt] = 32 | 1;
	eq("reserved meta bit", P.decodeSnapshotPart(bufOf(reserved)), undefined);
	const netId0 = zb.slice();
	netId0[metaAt - 8] = 0;
	netId0[metaAt - 7] = 0;
	eq("netId 0", P.decodeSnapshotPart(bufOf(netId0)), undefined);
});

// ---------------------------------------------------------------- 5. Fx (S→C)

function randFxEvent() {
	const kind = rint(1, 10);
	if (kind === P.FxType.Shot) {
		const hits = [];
		const n = rint(0, 5);
		for (let i = 0; i < n; i++) hits.push({ x: rx(), y: ry(), hit: rint(0, 4) });
		return { t: P.FxType.Shot, slot: rbool() ? rint(0, 5) : CFG.SLOT_NONE, weapon: rint(0, 29), hits };
	}
	if (kind === P.FxType.ProjSpawn) {
		return {
			t: P.FxType.ProjSpawn,
			projId: rint(0, 65535),
			kind: rint(1, 5),
			owner: rbool() ? rint(0, 5) : CFG.SLOT_NONE,
			x: rx(),
			y: ry(),
			angle: rang(),
			speed: rint(0, 255) * P.PROJ_SPEED_STEP,
		};
	}
	if (kind === P.FxType.ProjEnd) {
		return { t: P.FxType.ProjEnd, projId: rint(0, 65535), x: rx(), y: ry(), how: rint(0, 4) };
	}
	if (kind === P.FxType.Blood) {
		return { t: P.FxType.Blood, x: rx(), y: ry(), angle: rang(), amount: rint(0, 255), kind: rint(0, 1) };
	}
	if (kind === P.FxType.Debris) {
		return { t: P.FxType.Debris, x: rx(), y: ry(), angle: rang(), material: rint(0, 255), count: rint(0, 255) };
	}
	if (kind === P.FxType.SolidShake) {
		return { t: P.FxType.SolidShake, solidId: rint(1, 2000000), angle: rang(), strength: rnd() };
	}
	if (kind === P.FxType.Explosion) {
		return { t: P.FxType.Explosion, x: rx(), y: ry(), radius: rint(0, 255) * 4, kind: rint(0, 255) };
	}
	if (kind === P.FxType.Shake) {
		return {
			t: P.FxType.Shake,
			slot: rint(0, CFG.MAX_PLAYERS - 1),
			magnitude: rint(0, 255) * P.SHAKE_MAG_STEP,
			duration: rint(0, 255) * P.FX_TIME_STEP,
		};
	}
	if (kind === P.FxType.Tracer) {
		return {
			t: P.FxType.Tracer,
			x1: rx(),
			y1: ry(),
			x2: rx(),
			y2: ry(),
			kind: rint(1, P.TRACER_KIND_MAX),
			life: rint(0, 255) * P.FX_TIME_STEP,
		};
	}
	return { t: P.FxType.Sound, sound: rint(0, 255), x: rx(), y: ry(), volume: rnd() };
}

function compareFxEvent(a, b) {
	eq("fx type", b.t, a.t);
	switch (a.t) {
		case P.FxType.Shot:
			eq("shot slot", b.slot, a.slot);
			eq("shot weapon", b.weapon, a.weapon);
			eq("pellet count", b.hits.length, a.hits.length);
			for (let i = 0; i < a.hits.length; i++) {
				near("pellet x", b.hits[i].x, a.hits[i].x, POS_TOL);
				near("pellet y", b.hits[i].y, a.hits[i].y, POS_TOL);
				eq("pellet hit", b.hits[i].hit, a.hits[i].hit);
			}
			break;
		case P.FxType.ProjSpawn:
			eq("proj id", b.projId, a.projId);
			eq("proj kind", b.kind, a.kind);
			eq("proj owner", b.owner, a.owner);
			near("proj x", b.x, a.x, POS_TOL);
			near("proj y", b.y, a.y, POS_TOL);
			angNear("proj angle", b.angle, a.angle, ANG16_TOL);
			eq("proj speed", b.speed, a.speed);
			break;
		case P.FxType.ProjEnd:
			eq("proj id", b.projId, a.projId);
			near("end x", b.x, a.x, POS_TOL);
			eq("how", b.how, a.how);
			break;
		case P.FxType.Blood:
			near("blood x", b.x, a.x, POS_TOL);
			angNear("blood angle", b.angle, a.angle, ANG8_TOL);
			eq("blood amount", b.amount, a.amount);
			eq("blood kind", b.kind, a.kind);
			break;
		case P.FxType.Debris:
			near("debris y", b.y, a.y, POS_TOL);
			eq("material", b.material, a.material);
			eq("debris count", b.count, a.count);
			break;
		case P.FxType.SolidShake:
			eq("solid id", b.solidId, a.solidId);
			near("strength", b.strength, a.strength, FRAC8_TOL);
			break;
		case P.FxType.Explosion:
			near("explosion x", b.x, a.x, POS_TOL);
			eq("radius", b.radius, a.radius);
			eq("explosion kind", b.kind, a.kind);
			break;
		case P.FxType.Sound:
			eq("sound", b.sound, a.sound);
			near("volume", b.volume, a.volume, FRAC8_TOL);
			break;
		case P.FxType.Shake:
			eq("shake slot", b.slot, a.slot);
			near("shake magnitude", b.magnitude, a.magnitude, P.SHAKE_MAG_STEP);
			near("shake duration", b.duration, a.duration, P.FX_TIME_STEP);
			break;
		case P.FxType.Tracer:
			near("tracer x1", b.x1, a.x1, POS_TOL);
			near("tracer y2", b.y2, a.y2, POS_TOL);
			eq("tracer kind", b.kind, a.kind);
			near("tracer life", b.life, a.life, P.FX_TIME_STEP);
			break;
	}
}

test("Fx: round trip, batching and sizes", () => {
	for (let i = 0; i < 400; i++) {
		const events = [];
		const n = rint(0, 40);
		for (let k = 0; k < n; k++) events.push(randFxEvent());
		const batch = { tick: rint(0, 65535), events };
		const res = P.encodeFx(batch);
		eq("nothing dropped", res.dropped, 0);
		const got = [];
		for (const pkt of res.packets) {
			ok(buffer.len(pkt) <= CFG.FX_MAX_BYTES, `Fx packet of ${buffer.len(pkt)} B above the ceiling`);
			const d = P.decodeFx(pkt);
			if (d === undefined) {
				fail(`an Fx packet did not decode (${bytesOf(pkt).join(",")})`);
				break;
			}
			eq("Fx tick", d.tick, batch.tick);
			for (const e of d.events) got.push(e);
		}
		eq("event count", got.length, events.length);
		for (let k = 0; k < Math.min(events.length, got.length); k++) compareFxEvent(events[k], got[k]);
	}
	// a shotgun ShotResult: 3 + 5n bytes of payload (§4.2) + the type tag
	const shot = {
		t: P.FxType.Shot,
		slot: 0,
		weapon: 12,
		hits: [0, 1, 2, 3, 4].map(() => ({ x: rx(), y: ry(), hit: 2 })),
	};
	const one = P.encodeFx({ tick: 1, events: [shot] });
	sizes.push([
		"Fx ShotResult (shotgun, 5 pellets)",
		`${buffer.len(one.packets[0])} B with the 4 B header`,
		"3 + 5×5 = 28 B + tag (§4.2)",
	]);
	const proj = P.encodeFx({ tick: 1, events: [randFxEvent(), randFxEvent()] });
	ok(proj.packets.length === 1, "two small events fit a single packet");
	// a batch above 900 B is split, never truncated
	const big = [];
	for (let i = 0; i < 300; i++) {
		big.push({
			t: P.FxType.Shot,
			slot: 1,
			weapon: 3,
			hits: new Array(16).fill(0).map(() => ({ x: rx(), y: ry(), hit: 1 })),
		});
	}
	const split = P.encodeFx({ tick: 5, events: big });
	eq("nothing dropped when splitting", split.dropped, 0);
	ok(split.packets.length > 1, "a big batch must be split");
	let count = 0;
	for (const pkt of split.packets) {
		ok(buffer.len(pkt) <= CFG.FX_MAX_BYTES, "packet above the ceiling while splitting");
		count += P.decodeFx(pkt).events.length;
	}
	eq("events preserved while splitting", count, big.length);
	eq("empty batch", P.encodeFx({ tick: 1, events: [] }).packets.length, 0);
});

test("Fx: malformed packets are refused", () => {
	const pkt = P.encodeFx({ tick: 3, events: [randFxEvent(), randFxEvent()] }).packets[0];
	const good = bytesOf(pkt);
	for (const bad of [undefined, null, 5, "fx", {}, []]) eq("non-buffer", P.decodeFx(bad), undefined);
	eq("truncated header", P.decodeFx(bufOf(good.slice(0, 3))), undefined);
	const wrongKind = good.slice();
	wrongKind[0] = 0x70;
	eq("wrong kind", P.decodeFx(bufOf(wrongKind)), undefined);
	const lying = good.slice();
	lying[3] = 200;
	eq("count above the payload", P.decodeFx(bufOf(lying)), undefined);
	eq("trailing byte", P.decodeFx(bufOf(good.concat([0]))), undefined);
	const unknownEvent = good.slice();
	unknownEvent[4] = 99;
	eq("unknown event type", P.decodeFx(bufOf(unknownEvent)), undefined);
});

// ---------------------------------------------------------------- 6. World (S→C, reliable)

function randWorldEvent(kind = rint(1, 19)) {
	const dynId = () => CFG.DYNAMIC_ID_BASE + rint(0, 100000);
	switch (kind) {
		case P.WorldEv.SolidAdd:
			return {
				t: kind,
				id: dynId(),
				placeable: rint(0, 40),
				x: rx(),
				y: ry(),
				rot: rint(0, 3),
				hp: rnd(),
				state: rint(0, 7),
				owner: rbool() ? rint(0, 5) : CFG.SLOT_NONE,
			};
		case P.WorldEv.SolidRemove:
			return { t: kind, id: rint(1, 2000000) };
		case P.WorldEv.DoorSet:
			return { t: kind, id: rint(1, 2000000), state: rint(0, 7) };
		case P.WorldEv.SolidHp: {
			const entries = [];
			for (let i = 0; i < rint(1, 20); i++) entries.push({ id: rint(1, 2000000), hp: rnd() });
			return { t: kind, entries };
		}
		case P.WorldEv.LightSet:
			return { t: kind, id: rint(1, 2000000), powered: rbool() };
		case P.WorldEv.PowerSet: {
			// ELE-01..08: working, a level 0..3, a drone in the air -- which alone names the survivor it escorts
			const state = rint(0, POW.POWER_STATE_MASK);
			return { t: kind, id: dynId(), state, pilot: POW.powerFlying(state) ? rint(0, 5) : CFG.SLOT_NONE };
		}
		case P.WorldEv.ItemAdd:
			return {
				t: kind,
				id: dynId(),
				kind: rint(1, P.ITEM_KIND_MAX),
				itemId: rint(0, 200),
				count: rint(1, 99),
				x: rx(),
				y: ry(),
				vx: rint(-1200, 1200) / 8,
				vy: rint(-1200, 1200) / 8,
			};
		case P.WorldEv.ItemRemove:
			return { t: kind, id: dynId() };
		case P.WorldEv.LootFlag:
			return { t: kind, buildingId: rint(0, 65535), hasLoot: rbool() };
		case P.WorldEv.Clock:
			return {
				t: kind,
				worldDay: rint(1, 400),
				dayTime: rfloat(0, 23.99),
				tick: rint(0, 65535),
				rain: rbool(),
				waveFlags: rint(0, 255),
			};
		case P.WorldEv.Announce: {
			// MON-05: a TitleUnlocked names a title that exists; every other kind carries any u16
			const msg = rint(1, P.AnnounceKind.TitleUnlocked);
			const arg = msg === P.AnnounceKind.TitleUnlocked ? rint(1, TIT.TITLE_WIRE_MAX) : rint(0, 65535);
			return { t: kind, msg, arg };
		}
		case P.WorldEv.ZombieDied:
			return { t: kind, netId: rint(1, 65535), x: rx(), y: ry(), cause: rint(0, 7) };
		case P.WorldEv.PlayerJoined:
			return {
				t: kind,
				slot: rint(0, 5),
				userId: rbool() ? rint(1, 9000000000) : -rint(1, 8),
				name: pick(["Builder", "Zé do Caixão", "🧟 survivor", "", "x".repeat(40)]),
				level: rint(1, 999),
				outfit: rint(0, COS.OUTFIT_LOOK_MAX),
				pet: rint(0, COS.PET_LOOK_MAX),
				title: rint(0, TIT.TITLE_WIRE_MAX),
			};
		case P.WorldEv.PlayerProfile:
			return {
				t: kind,
				slot: rint(0, 5),
				level: rint(1, 999),
				outfit: rint(0, COS.OUTFIT_LOOK_MAX),
				pet: rint(0, COS.PET_LOOK_MAX),
				title: rint(0, TIT.TITLE_WIRE_MAX),
			};
		case P.WorldEv.PlayerLeft:
			return { t: kind, slot: rint(0, 5) };
		case P.WorldEv.PlayerTally:
			// MP-23: the scoreboard's numbers -- this life's day (u16) and the zombies put down (u32, the save's ceiling)
			return { t: kind, slot: rint(0, 5), lifeDay: rint(1, P.TALLY_DAY_MAX), kills: rint(0, P.TALLY_KILLS_MAX) };
		case P.WorldEv.PlayerLife:
			return { t: kind, slot: rint(0, 5), state: rint(0, 3) };
		case P.WorldEv.WorldReset: {
			// MP-22: the new town's seed, the day the old one fell on, and the lives the server reset — each with the
			// runRev its save is on now (the client takes it, never its own + 1)
			const lives = [];
			for (let i = rint(0, 6); i > 0; i--) {
				lives.push({ userId: rbool() ? rint(1, 9000000000) : -rint(1, 8), runRev: rint(0, 10000000) });
			}
			return { t: kind, seed: rint(1, CFG.TOWN_SEED_MAX), endedDay: rint(1, 400), lives };
		}
		default:
			return {
				t: P.WorldEv.InitBegin,
				mapHash: rint(0, 4294967295),
				seed: rint(1, CFG.TOWN_SEED_MAX),
				tick0Time: rfloat(0, 1e9),
				simHz: pick([30, 60]),
				chunk: 0,
				chunks: rint(1, 8),
			};
	}
}

function compareWorldEvent(a, b) {
	eq("world event type", b.t, a.t);
	switch (a.t) {
		case P.WorldEv.SolidAdd:
			eq("solid id", b.id, a.id);
			eq("placeable", b.placeable, a.placeable);
			near("solid x", b.x, a.x, POS_TOL);
			near("solid y", b.y, a.y, POS_TOL);
			eq("rot", b.rot, a.rot);
			near("solid hp", b.hp, a.hp, FRAC8_TOL);
			eq("state", b.state, a.state);
			eq("owner", b.owner, a.owner);
			break;
		case P.WorldEv.SolidRemove:
		case P.WorldEv.ItemRemove:
			eq("id", b.id, a.id);
			break;
		case P.WorldEv.DoorSet:
			eq("door id", b.id, a.id);
			eq("door state", b.state, a.state);
			break;
		case P.WorldEv.SolidHp:
			eq("entries", b.entries.length, a.entries.length);
			for (let i = 0; i < a.entries.length; i++) {
				eq("entry id", b.entries[i].id, a.entries[i].id);
				near("entry hp", b.entries[i].hp, a.entries[i].hp, FRAC8_TOL);
			}
			break;
		case P.WorldEv.LightSet:
			eq("light id", b.id, a.id);
			eq("powered", b.powered, a.powered);
			break;
		case P.WorldEv.PowerSet:
			eq("power id", b.id, a.id);
			eq("power state", b.state, a.state);
			eq("power pilot", b.pilot, a.pilot);
			break;
		case P.WorldEv.ItemAdd:
			eq("item id", b.id, a.id);
			eq("item kind", b.kind, a.kind);
			eq("itemId", b.itemId, a.itemId);
			eq("count", b.count, a.count);
			near("item x", b.x, a.x, POS_TOL);
			near("item vx", b.vx, a.vx, 1 / 16 + 1e-9);
			near("item vy", b.vy, a.vy, 1 / 16 + 1e-9);
			break;
		case P.WorldEv.LootFlag:
			eq("buildingId", b.buildingId, a.buildingId);
			eq("hasLoot", b.hasLoot, a.hasLoot);
			break;
		case P.WorldEv.Clock:
			eq("worldDay", b.worldDay, a.worldDay);
			near("dayTime", b.dayTime, a.dayTime, 1 / P.CLOCK_HOUR_SCALE + 1e-9);
			eq("clock tick", b.tick, a.tick);
			eq("rain", b.rain, a.rain);
			eq("waveFlags", b.waveFlags, a.waveFlags);
			break;
		case P.WorldEv.Announce:
			eq("msg", b.msg, a.msg);
			eq("arg", b.arg, a.arg);
			break;
		case P.WorldEv.ZombieDied:
			eq("netId", b.netId, a.netId);
			near("death x", b.x, a.x, POS_TOL);
			eq("cause", b.cause, a.cause);
			break;
		case P.WorldEv.PlayerJoined:
			eq("slot", b.slot, a.slot);
			eq("userId", b.userId, a.userId);
			eq("name", b.name, a.name);
			eq("level", b.level, a.level);
			eq("outfit", b.outfit, a.outfit);
			eq("pet", b.pet, a.pet);
			eq("title", b.title, a.title);
			break;
		case P.WorldEv.PlayerProfile:
			eq("profile slot", b.slot, a.slot);
			eq("profile level", b.level, a.level);
			eq("profile outfit", b.outfit, a.outfit);
			eq("profile pet", b.pet, a.pet);
			eq("profile title", b.title, a.title);
			break;
		case P.WorldEv.PlayerLeft:
			eq("slot", b.slot, a.slot);
			break;
		case P.WorldEv.PlayerTally:
			eq("tally slot", b.slot, a.slot);
			eq("tally life day", b.lifeDay, a.lifeDay);
			eq("tally kills", b.kills, a.kills);
			break;
		case P.WorldEv.PlayerLife:
			eq("slot", b.slot, a.slot);
			eq("life state", b.state, a.state);
			break;
		case P.WorldEv.WorldReset:
			eq("reset seed", b.seed, a.seed);
			eq("reset endedDay", b.endedDay, a.endedDay);
			eq("reset lives", JSON.stringify(b.lives), JSON.stringify(a.lives));
			break;
		case P.WorldEv.InitBegin:
			eq("mapHash", b.mapHash, a.mapHash);
			eq("town seed", b.seed, a.seed);
			near("tick0Time", b.tick0Time, a.tick0Time, 1e-9);
			eq("simHz", b.simHz, a.simHz);
			eq("chunk", b.chunk, a.chunk);
			eq("chunks", b.chunks, a.chunks);
			break;
	}
}

test("World: round trip of every delta", () => {
	for (let i = 0; i < 400; i++) {
		const events = [];
		for (let k = 0; k < rint(0, 30); k++) events.push(randWorldEvent());
		const batch = { tick: rint(0, 65535), events };
		const res = P.encodeWorld(batch);
		eq("nothing dropped", res.dropped, 0);
		const got = [];
		for (const pkt of res.packets) {
			ok(buffer.len(pkt) <= CFG.WORLD_MAX_BYTES, "World packet above 16 KB");
			const d = P.decodeWorld(pkt);
			if (d === undefined) {
				fail("a World packet did not decode");
				continue;
			}
			eq("World tick", d.tick, batch.tick);
			for (const e of d.events) got.push(e);
		}
		eq("event count", got.length, events.length);
		for (let k = 0; k < events.length; k++) compareWorldEvent(events[k], got[k]);
	}
	const one = kind => buffer.len(P.encodeWorld({ tick: 0, events: [randWorldEvent(kind)] }).packets[0]);
	sizes.push(["World SolidAdd (with the 5 B header)", `${one(P.WorldEv.SolidAdd)} B`, "13 B + tag (§4.5)"]);
	sizes.push(["World DoorSet", `${one(P.WorldEv.DoorSet)} B`, "id + open (§4.5)"]);
	sizes.push(["World ItemAdd", `${one(P.WorldEv.ItemAdd)} B`, "id, kind, itemId, count, x, y, vx, vy (§4.5)"]);
	sizes.push(["World ZombieDied", `${one(P.WorldEv.ZombieDied)} B`, "netId, x, y, cause (§4.4)"]);
	sizes.push(["World Clock", `${one(P.WorldEv.Clock)} B`, "worldDay, dayTime, tick, rain, waveFlags (§4.5)"]);
	sizes.push([
		"World PlayerProfile",
		`${one(P.WorldEv.PlayerProfile)} B`,
		"slot, level, outfit, pet, title (MON-04/05)",
	]);
	const reset2 = {
		t: P.WorldEv.WorldReset,
		seed: 12345,
		endedDay: 9,
		lives: [
			{ userId: 1, runRev: 4 },
			{ userId: 2, runRev: 9 },
		],
	};
	const resetBytes = buffer.len(P.encodeWorld({ tick: 0, events: [reset2] }).packets[0]);
	eq("WorldReset with 2 lives", resetBytes, 5 + 1 + 4 + 2 + 1 + 2 * (8 + 4));
	sizes.push(["World WorldReset (2 new lives)", `${resetBytes} B`, "seed, endedDay, lives (MP-22)"]);
});

test("World: the roster carries outfit and pet, and refuses looks that do not exist (MON-04)", () => {
	const joined = {
		t: P.WorldEv.PlayerJoined,
		slot: 2,
		userId: 123456789,
		name: "Cowboy Joe",
		level: 17,
		outfit: COS.OutfitLook.Cowboy,
		pet: COS.PetLook.Eagle,
		title: 0,
	};
	const profile = {
		t: P.WorldEv.PlayerProfile,
		slot: 2,
		level: 18,
		outfit: COS.OutfitLook.Santa,
		pet: COS.PetLook.None,
		title: 0,
	};
	const pkt = P.encodeWorld({ tick: 5, events: [joined, profile] }).packets[0];
	const d = P.decodeWorld(pkt);
	ok(d !== undefined, "the roster pair did not decode");
	if (d === undefined) return;
	eq("joined outfit", d.events[0].outfit, COS.OutfitLook.Cowboy);
	eq("joined pet", d.events[0].pet, COS.PetLook.Eagle);
	eq("profile type", d.events[1].t, P.WorldEv.PlayerProfile);
	eq("profile level", d.events[1].level, 18);
	eq("profile outfit", d.events[1].outfit, COS.OutfitLook.Santa);
	eq("profile pet", d.events[1].pet, COS.PetLook.None);
	// an encoder handed a look out of range writes the nearest valid one instead of an unknown byte
	const clamped = P.decodeWorld(P.encodeWorld({ tick: 1, events: [{ ...profile, outfit: 99, pet: -4 }] }).packets[0]);
	eq("out-of-range outfit clamped on encode", clamped.events[0].outfit, COS.OUTFIT_LOOK_MAX);
	eq("negative pet clamped on encode", clamped.events[0].pet, 0);
	// the decoder refuses a byte that names no look (a hostile or corrupt packet)
	const pb = bytesOf(P.encodeWorld({ tick: 1, events: [profile] }).packets[0]);
	// header 5 B, tag 1 B, slot 1 B, level 2 B, outfit 1 B, pet 1 B, title 1 B (MON-05)
	const badOutfit = pb.slice();
	badOutfit[9] = COS.OUTFIT_LOOK_MAX + 1;
	eq("profile with an unknown outfit", P.decodeWorld(bufOf(badOutfit)), undefined);
	const badPet = pb.slice();
	badPet[10] = COS.PET_LOOK_MAX + 1;
	eq("profile with an unknown pet", P.decodeWorld(bufOf(badPet)), undefined);
	const badSlot = pb.slice();
	badSlot[6] = 6;
	eq("profile for slot 6", P.decodeWorld(bufOf(badSlot)), undefined);
	const jb = bytesOf(P.encodeWorld({ tick: 1, events: [joined] }).packets[0]);
	// PlayerJoined ends with outfit, pet, title (MON-05): the pet is the second-to-last byte, the outfit before it
	const badJoinPet = jb.slice();
	badJoinPet[jb.length - 2] = 200;
	eq("PlayerJoined with an unknown pet", P.decodeWorld(bufOf(badJoinPet)), undefined);
	const badJoinOutfit = jb.slice();
	badJoinOutfit[jb.length - 3] = 200;
	eq("PlayerJoined with an unknown outfit", P.decodeWorld(bufOf(badJoinOutfit)), undefined);
	eq("PlayerProfile size", buffer.len(P.encodeWorld({ tick: 1, events: [profile] }).packets[0]), 5 + 7);
});

test("World: the roster carries the title under the name, and nothing but a real title (MON-05)", () => {
	const HB = TIT.titleToWire(TIT.TitleId.HordeBreaker);
	const joined = {
		t: P.WorldEv.PlayerJoined,
		slot: 1,
		userId: 42,
		name: "Breaker",
		level: 9,
		outfit: 0,
		pet: 0,
		title: HB,
	};
	const profile = { t: P.WorldEv.PlayerProfile, slot: 1, level: 9, outfit: 0, pet: 0, title: 0 };
	const d = P.decodeWorld(P.encodeWorld({ tick: 3, events: [joined, profile] }).packets[0]);
	ok(d !== undefined, "the roster pair with a title did not decode");
	if (d === undefined) return;
	eq("joined title", d.events[0].title, HB);
	eq("profile takes the title off (0 = none)", d.events[1].title, 0);
	eq("wire byte -> title id", TIT.titleFromWire(d.events[0].title), TIT.TitleId.HordeBreaker);
	eq("0 -> no title", TIT.titleFromWire(0), -1);
	eq("a byte past the table -> no title", TIT.titleFromWire(TIT.TITLE_WIRE_MAX + 1), -1);
	// an encoder handed a title out of range writes the nearest valid byte, never an unknown one
	const clamped = P.decodeWorld(P.encodeWorld({ tick: 1, events: [{ ...profile, title: 99 }] }).packets[0]);
	eq("out-of-range title clamped on encode", clamped.events[0].title, TIT.TITLE_WIRE_MAX);
	// the decoder refuses a byte that names no title, in both events (a hostile or corrupt packet)
	const jb = bytesOf(P.encodeWorld({ tick: 1, events: [joined] }).packets[0]);
	const badJoin = jb.slice();
	badJoin[jb.length - 1] = TIT.TITLE_WIRE_MAX + 1;
	eq("PlayerJoined with a title that does not exist", P.decodeWorld(bufOf(badJoin)), undefined);
	const pb = bytesOf(P.encodeWorld({ tick: 1, events: [profile] }).packets[0]);
	const badProfile = pb.slice();
	badProfile[pb.length - 1] = 255;
	eq("PlayerProfile with a title that does not exist", P.decodeWorld(bufOf(badProfile)), undefined);

	// the unlock notice: Announce{TitleUnlocked, arg = title byte}, and only a real title
	const note = { t: P.WorldEv.Announce, msg: P.AnnounceKind.TitleUnlocked, arg: HB };
	const nb = P.encodeWorld({ tick: 7, events: [note] }).packets[0];
	const got = P.decodeWorld(nb);
	eq("TitleUnlocked decodes", got?.events[0].msg, P.AnnounceKind.TitleUnlocked);
	eq("…with its title", got?.events[0].arg, HB);
	eq("Announce size is unchanged", buffer.len(nb), 5 + 4);
	const raw = bytesOf(nb);
	for (const bad of [0, TIT.TITLE_WIRE_MAX + 1, 65535]) {
		const b = raw.slice();
		// header 5 B, tag 1 B, msg 1 B, arg u16 (little-endian)
		b[7] = bad & 255;
		b[8] = (bad >> 8) & 255;
		eq(`TitleUnlocked naming title byte ${bad}`, P.decodeWorld(bufOf(b)), undefined);
	}
	const bogusKind = raw.slice();
	bogusKind[6] = P.AnnounceKind.TitleUnlocked + 1;
	eq("an Announce kind past TitleUnlocked", P.decodeWorld(bufOf(bogusKind)), undefined);
	// a boss kill keeps carrying any u16: the check is for titles only
	const boss = P.decodeWorld(
		P.encodeWorld({ tick: 1, events: [{ t: P.WorldEv.Announce, msg: 5, arg: 900 }] }).packets[0],
	);
	eq("other Announce kinds are untouched", boss?.events[0].arg, 900);
});

test("World: PlayerTally carries the scoreboard's two numbers, and refuses what cannot be (MP-23)", () => {
	const tally = { t: P.WorldEv.PlayerTally, slot: 3, lifeDay: 12, kills: 137 };
	const pkt = P.encodeWorld({ tick: 9, events: [tally] }).packets[0];
	// header 5 B + tag 1 B + slot 1 B + lifeDay u16 + kills u32
	eq("PlayerTally size", buffer.len(pkt), 5 + 8);
	sizes.push(["World PlayerTally", `${buffer.len(pkt) - 5} B`, "slot, life day, zombies put down (MP-23)"]);
	const d = P.decodeWorld(pkt);
	ok(d !== undefined, "the tally did not decode");
	if (d === undefined) return;
	eq("tally type", d.events[0].t, P.WorldEv.PlayerTally);
	eq("tally life day", d.events[0].lifeDay, 12);
	eq("tally kills", d.events[0].kills, 137);
	eq("the kill ceiling is the save's", P.TALLY_KILLS_MAX, SAVE.SAVE_LIMITS.COUNTER_MAX);
	// an encoder handed out-of-range numbers writes the nearest valid ones, never a byte the decoder refuses
	const clamped = P.decodeWorld(
		P.encodeWorld({ tick: 1, events: [{ ...tally, lifeDay: 99999, kills: 1e12 }] }).packets[0],
	);
	eq("a life day past the u16 is clamped on encode", clamped?.events[0].lifeDay, P.TALLY_DAY_MAX);
	eq("a kill count past the ceiling is clamped on encode", clamped?.events[0].kills, P.TALLY_KILLS_MAX);
	const zero = P.decodeWorld(P.encodeWorld({ tick: 1, events: [{ ...tally, lifeDay: 0, kills: -5 }] }).packets[0]);
	eq("day 0 is written as day 1", zero?.events[0].lifeDay, 1);
	eq("negative kills are written as 0", zero?.events[0].kills, 0);
	// the decoder refuses what no server writes (a hostile or corrupt packet)
	const raw = bytesOf(pkt);
	const badSlot = raw.slice();
	badSlot[6] = 6;
	eq("tally for slot 6", P.decodeWorld(bufOf(badSlot)), undefined);
	const dayZero = raw.slice();
	dayZero[7] = 0;
	dayZero[8] = 0;
	eq("tally for life day 0", P.decodeWorld(bufOf(dayZero)), undefined);
	const tooMany = raw.slice();
	// kills u32 little-endian at bytes 9..12: 0xFFFFFFFF is past the save's ceiling
	tooMany[9] = 255;
	tooMany[10] = 255;
	tooMany[11] = 255;
	tooMany[12] = 255;
	eq("tally with more kills than a save can hold", P.decodeWorld(bufOf(tooMany)), undefined);
	eq("a truncated tally", P.decodeWorld(bufOf(raw.slice(0, raw.length - 1))), undefined);
});

test("World: PowerSet carries a machine's state, and refuses what the grid never publishes (ELE-01..08)", () => {
	const docked = {
		t: P.WorldEv.PowerSet,
		id: CFG.DYNAMIC_ID_BASE + 7,
		state: POW.packPowerState(true, 2, false),
		pilot: CFG.SLOT_NONE,
	};
	const flying = {
		t: P.WorldEv.PowerSet,
		id: CFG.DYNAMIC_ID_BASE + 8,
		state: POW.packPowerState(true, 3, true),
		pilot: 4,
	};
	const pkt = P.encodeWorld({ tick: 3, events: [docked, flying] }).packets[0];
	// header 5 B + 2 × (tag 1 B + id u32 + state u8 + pilot u8)
	eq("PowerSet size", buffer.len(pkt), 5 + 2 * 7);
	sizes.push(["World PowerSet", "7 B", "id, state (working, level, flying, on), pilot (ELE-01..08)"]);
	const d = P.decodeWorld(pkt);
	ok(d !== undefined, "the PowerSet pair did not decode");
	if (d === undefined) return;
	eq("docked state", d.events[0].state, docked.state);
	eq("docked pilot", d.events[0].pilot, CFG.SLOT_NONE);
	eq("flying pilot", d.events[1].pilot, 4);
	ok(POW.powerFlying(d.events[1].state) && POW.powerLevel(d.events[1].state) === 3, "flying, level 3");
	// the encoder never writes a byte the decoder refuses: a pilot without the Flying bit is dropped, reserved bits masked
	const fixed = P.decodeWorld(
		P.encodeWorld({ tick: 1, events: [{ ...docked, pilot: 2, state: 0xf0 | docked.state }] }).packets[0],
	);
	eq("reserved bits masked on encode", fixed?.events[0].state, docked.state | POW.PowerBit.On);
	ok(POW.powerOn(fixed?.events[0].state ?? 0), "the switch bit survives the round trip");
	eq("a pilot without the Flying bit is written as none", fixed?.events[0].pilot, CFG.SLOT_NONE);
	const noPilot = P.decodeWorld(P.encodeWorld({ tick: 1, events: [{ ...flying, pilot: 9 }] }).packets[0]);
	eq("a flying drone with a bogus pilot does not decode (its pilot is written as none)", noPilot, undefined);
	// the decoder refuses what no server writes (a hostile or corrupt packet)
	const raw = bytesOf(P.encodeWorld({ tick: 1, events: [flying] }).packets[0]);
	// header 5 B, tag 1 B (byte 5), id u32 (6..9), state (10), pilot (11)
	const staticId = raw.slice();
	staticId[6] = 5;
	staticId[7] = 0;
	staticId[8] = 0;
	staticId[9] = 0;
	eq("a PowerSet for a map solid (id 5, not dynamic)", P.decodeWorld(bufOf(staticId)), undefined);
	const reserved = raw.slice();
	reserved[10] = raw[10] | 32;
	eq("a PowerSet with a reserved bit", P.decodeWorld(bufOf(reserved)), undefined);
	const grounded = raw.slice();
	grounded[10] = raw[10] & ~POW.PowerBit.Flying;
	eq("a pilot for something that is not in the air", P.decodeWorld(bufOf(grounded)), undefined);
	const lost = raw.slice();
	lost[11] = CFG.SLOT_NONE;
	eq("a drone in the air escorting nobody", P.decodeWorld(bufOf(lost)), undefined);
	const badSlot = raw.slice();
	badSlot[11] = 6;
	eq("a drone escorting slot 6", P.decodeWorld(bufOf(badSlot)), undefined);
	eq("a truncated PowerSet", P.decodeWorld(bufOf(raw.slice(0, raw.length - 1))), undefined);
});

test("World: WorldInit in blocks of ≤ 16 KB", () => {
	const events = [randWorldEvent(P.WorldEv.InitBegin)];
	for (let i = 0; i < 2000; i++) events.push(randWorldEvent(P.WorldEv.SolidAdd));
	for (let i = 0; i < 300; i++) events.push(randWorldEvent(P.WorldEv.ItemAdd));
	events.push(randWorldEvent(P.WorldEv.Clock));
	const res = P.encodeWorld({ tick: 100, events });
	eq("nothing dropped", res.dropped, 0);
	ok(res.packets.length > 1, "a WorldInit of 2300 deltas must be split into blocks");
	let total = 0;
	const got = [];
	for (const pkt of res.packets) {
		total += buffer.len(pkt);
		ok(buffer.len(pkt) <= CFG.WORLD_MAX_BYTES, `block of ${buffer.len(pkt)} B above 16 KB`);
		for (const e of P.decodeWorld(pkt).events) got.push(e);
	}
	eq("every delta survived", got.length, events.length);
	for (let i = 0; i < events.length; i++) compareWorldEvent(events[i], got[i]);
	sizes.push([
		"WorldInit (2000 constructions + 300 items)",
		`${total} B in ${res.packets.length} blocks`,
		"blocks of ≤ 16 KB (§4.5)",
	]);
});

test("World: malformed deltas are refused", () => {
	const pkt = P.encodeWorld({ tick: 1, events: [randWorldEvent(P.WorldEv.PlayerLeft)] }).packets[0];
	const good = bytesOf(pkt);
	for (const bad of [undefined, null, 7, "w", {}, []]) eq("non-buffer", P.decodeWorld(bad), undefined);
	eq("truncated header", P.decodeWorld(bufOf(good.slice(0, 4))), undefined);
	const wrongKind = good.slice();
	wrongKind[0] = 0x10;
	eq("wrong kind", P.decodeWorld(bufOf(wrongKind)), undefined);
	const lying = good.slice();
	lying[3] = 0xff;
	lying[4] = 0xff;
	eq("count above the payload", P.decodeWorld(bufOf(lying)), undefined);
	eq("trailing byte", P.decodeWorld(bufOf(good.concat([0]))), undefined);
	const unknown = good.slice();
	unknown[5] = 200;
	eq("unknown delta", P.decodeWorld(bufOf(unknown)), undefined);
	// semantic ranges
	const badSlot = good.slice();
	badSlot[6] = 6;
	eq("slot 6", P.decodeWorld(bufOf(badSlot)), undefined);
	const solid = bytesOf(P.encodeWorld({ tick: 1, events: [randWorldEvent(P.WorldEv.SolidAdd)] }).packets[0]);
	const staticId = solid.slice();
	staticId[6] = 10;
	staticId[7] = 0;
	staticId[8] = 0;
	staticId[9] = 0;
	eq("construction with a static id", P.decodeWorld(bufOf(staticId)), undefined);
	const badRot = solid.slice();
	badRot[15] = 9;
	eq("rotation above 3", P.decodeWorld(bufOf(badRot)), undefined);
	const clock = bytesOf(P.encodeWorld({ tick: 1, events: [randWorldEvent(P.WorldEv.Clock)] }).packets[0]);
	const hour24 = clock.slice();
	hour24[8] = 0x00;
	hour24[9] = 0xff; // 65280 / 2048 = 31.9 h
	eq("hour above 24", P.decodeWorld(bufOf(hour24)), undefined);
	const day0 = clock.slice();
	day0[6] = 0;
	day0[7] = 0;
	eq("world day 0", P.decodeWorld(bufOf(day0)), undefined);
});

// ---------------------------------------------------------------- 7. clock sync

test("TimeSync: ping/pong and the tick timeline (§4.6)", () => {
	for (let i = 0; i < 2000; i++) {
		const ping = { seq: rint(0, 65535), clientTime: rfloat(0, 1e6) };
		const pb = P.encodeTimePing(ping);
		eq("ping size", buffer.len(pb), P.TIME_PING_BYTES);
		const dp = P.decodeTimePing(pb);
		eq("ping seq", dp.seq, ping.seq);
		near("ping clientTime", dp.clientTime, ping.clientTime, 1e-12);
		const pong = {
			seq: ping.seq,
			clientTime: ping.clientTime,
			serverTime: ping.clientTime + rfloat(0, 0.3),
			serverTick: rint(0, 4294967295),
		};
		const gb = P.encodeTimePong(pong);
		eq("pong size", buffer.len(gb), P.TIME_PONG_BYTES);
		const dg = P.decodeTimePong(gb);
		eq("pong seq", dg.seq, pong.seq);
		near("pong serverTime", dg.serverTime, pong.serverTime, 1e-12);
		eq("pong serverTick", dg.serverTick, pong.serverTick);
	}
	sizes.push(["TimeSync ping / pong", `${P.TIME_PING_BYTES} B / ${P.TIME_PONG_BYTES} B`, "decision 9 (§4.6)"]);
	// a pong of a 120 ms round trip with a perfectly synchronized clock
	const sent = 1000;
	const received = 1000.12;
	const p = { seq: 1, clientTime: sent, serverTime: 1000.06, serverTick: 10 };
	near("rtt", P.pongRtt(p, received), 0.12, 1e-9);
	near("clock offset", P.pongClockOffset(p, received), 0, 1e-9);
	// timeline: tick ↔ GetServerTimeNow
	near("serverTickAt", P.serverTickAt(1000 + 2, 1000, 60), 120, 1e-9);
	near("serverTimeOfTick", P.serverTimeOfTick(120, 1000, 60), 1002, 1e-9);
	near("inverse", P.serverTickAt(P.serverTimeOfTick(777, 500, 30), 500, 30), 777, 1e-9);
	for (const bad of [undefined, null, 3, "t", {}, buffer.create(0), buffer.create(11)]) {
		eq("bad pong", P.decodeTimePong(bad), undefined);
	}
	eq("pong decoded as ping", P.decodeTimePing(P.encodeTimePong(p)), undefined);
	eq("ping decoded as pong", P.decodeTimePong(P.encodeTimePing({ seq: 1, clientTime: 0 })), undefined);
});

// ---------------------------------------------------------------- 7b. Intent (C→S, §2.4, §8.1, QA NET-1..6)

const BACKPACK_VERBS = [
	P.IntentKind.Craft,
	P.IntentKind.UseItem,
	P.IntentKind.Equip,
	P.IntentKind.Unequip,
	P.IntentKind.LearnSkill,
	P.IntentKind.SwitchWeapon,
];
const PRESENCE_VERBS = [P.IntentKind.EnterWorld, P.IntentKind.LeaveWorld];
/** a valid backpack intent with random fields, for the fuzz below */
function randIntent() {
	const kind = pick(BACKPACK_VERBS);
	const [lo, hi] = P.intentArgRange(kind);
	return P.encodeIntentArgs(kind, rint(0, 65535), rint(lo, hi), rint(0, 65535));
}

test("Intent: presence (2 B) and backpack verbs (8 B), round trip and exact sizes", () => {
	eq("the header is PacketKind.Intent in the high nibble", P.INTENT_HEADER, P.PacketKind.Intent * 16);
	eq("SwitchWeapon is the new verb 8", P.IntentKind.SwitchWeapon, 8);
	for (const kind of PRESENCE_VERBS) {
		const b = P.encodeIntent(kind);
		eq(`presence ${kind}: size`, buffer.len(b), P.INTENT_BYTES);
		const d = P.decodeIntentMessage(b);
		eq(`presence ${kind}: kind`, d?.kind, kind);
		eq(`presence ${kind}: no atSeq/arg/nonce`, `${d?.atSeq},${d?.arg},${d?.nonce}`, "0,0,0");
		eq(`presence ${kind}: decodeIntent`, P.decodeIntent(b), kind);
		ok(!P.isBackpackIntent(kind), `presence ${kind} is not a backpack verb`);
		eq(`presence ${kind}: has no long form`, P.encodeIntentArgs(kind, 1, 0, 1), undefined);
	}
	for (const kind of BACKPACK_VERBS) {
		ok(P.isBackpackIntent(kind), `verb ${kind} is a backpack verb`);
		eq(`verb ${kind}: has no short form`, P.encodeIntent(kind), undefined);
		const [lo, hi] = P.intentArgRange(kind);
		for (const arg of [lo, hi, rint(lo, hi)]) {
			const atSeq = rint(0, 65535);
			const nonce = rint(0, 65535);
			const b = P.encodeIntentArgs(kind, atSeq, arg, nonce);
			eq(`verb ${kind} arg ${arg}: size`, buffer.len(b), P.INTENT_ARGS_BYTES);
			const d = P.decodeIntentMessage(b);
			eq(`verb ${kind} arg ${arg}: round trip`, JSON.stringify(d), JSON.stringify({ kind, atSeq, arg, nonce }));
			eq(`verb ${kind}: decodeIntent (presence only) ignores it`, P.decodeIntent(b), undefined);
		}
		// the encoder refuses what the decoder would refuse
		eq(`verb ${kind}: arg below the range`, P.encodeIntentArgs(kind, 0, lo - 1, 0), undefined);
		eq(`verb ${kind}: arg above the range`, P.encodeIntentArgs(kind, 0, hi + 1, 0), undefined);
		eq(`verb ${kind}: fractional arg`, P.encodeIntentArgs(kind, 0, lo + 0.5, 0), undefined);
		eq(`verb ${kind}: NaN arg`, P.encodeIntentArgs(kind, 0, NaN, 0), undefined);
		// …and a hand-built packet with an argument outside the table is malformed
		for (const bad of [hi + 1, 65535]) {
			eq(
				`verb ${kind}: decoded arg ${bad} out of range`,
				P.decodeIntentMessage(bufOf([96, kind, 1, 0, bad & 255, bad >> 8, 0, 0])),
				undefined,
			);
		}
		if (lo > 0)
			eq(
				`verb ${kind}: decoded arg 0 below range`,
				P.decodeIntentMessage(bufOf([96, kind, 1, 0, 0, 0, 0, 0])),
				undefined,
			);
	}
	// the ranges are the data tables' (§8.1: the argument is an index the server looks up)
	eq("SwitchWeapon range", P.intentArgRange(P.IntentKind.SwitchWeapon).join(","), `0,${WEAPONS.length - 1}`);
	eq("Unequip range: the equipment slots", P.intentArgRange(P.IntentKind.Unequip).join(","), "1,5");
	eq("no range for a presence verb", P.intentArgRange(P.IntentKind.EnterWorld), undefined);
	// seq and nonce are u16 and wrap like every sequence number on the wire
	const w = P.decodeIntentMessage(P.encodeIntentArgs(P.IntentKind.SwitchWeapon, 65536 + 5, 0, -1));
	eq("atSeq wraps", w.atSeq, 5);
	eq("nonce wraps", w.nonce, 65535);
	sizes.push([
		"Intent: presence / backpack verb",
		`${P.INTENT_BYTES} B / ${P.INTENT_ARGS_BYTES} B`,
		"≤ 20/s (§4.1, §8.2)",
	]);
});

test("Intent: hostile payloads are refused (§8.1)", () => {
	for (const bad of [undefined, null, 0, 8, "x", {}, [], true, [96, 4, 0, 0, 0, 0, 0, 0]]) {
		eq(`decodeIntentMessage(${JSON.stringify(bad)})`, P.decodeIntentMessage(bad), undefined);
	}
	// every length but 2 and 8 is malformed, whatever the bytes
	for (let len = 0; len <= 16; len++) {
		if (len === P.INTENT_BYTES || len === P.INTENT_ARGS_BYTES) continue;
		const b = buffer.create(len);
		if (len > 0) buffer.writeu8(b, 0, 96);
		if (len > 1) buffer.writeu8(b, 1, P.IntentKind.UseItem);
		eq(`length ${len}`, P.decodeIntentMessage(b), undefined);
	}
	// every header but Intent's, every kind outside 1..8, and each form with the other form's verbs
	let accepted = 0;
	for (let head = 0; head < 256; head++) {
		for (let kind = 0; kind < 256; kind++) {
			const short = P.decodeIntentMessage(bufOf([head, kind]));
			const long = P.decodeIntentMessage(bufOf([head, kind, 7, 0, 1, 0, 9, 0]));
			const shortOk = head === 96 && (kind === 1 || kind === 2);
			const longOk = head === 96 && kind >= 3 && kind <= 8;
			if ((short !== undefined) !== shortOk)
				fail(`short form head ${head} kind ${kind}: ${JSON.stringify(short)}`);
			// arg = 1 is inside every backpack verb's range
			if ((long !== undefined) !== longOk) fail(`long form head ${head} kind ${kind}: ${JSON.stringify(long)}`);
			if (short !== undefined) accepted += 1;
			if (long !== undefined) accepted += 1;
			checks += 2;
		}
	}
	eq("exactly the 2 presence and 6 backpack verbs decode", accepted, 8);
});

test("Intent gate: the §8.2 bucket, the malformed window, and presence left to mpHost", () => {
	const G = require(join(SRC, "server/net/intentGate.ts"));
	const good = () => randIntent();
	// a burst of INTENT_BURST at one instant is accepted; the next one is dropped, still decoded (its nonce is acked)
	let g = G.newIntentGate(0);
	for (let i = 0; i < CFG.INTENT_BURST; i++)
		eq(`burst ${i}`, G.ingestBackpackIntent(g, good(), 0).verdict, G.IntentVerdict.Ok);
	const over = G.ingestBackpackIntent(g, good(), 0);
	eq("past the burst: Rate", over.verdict, G.IntentVerdict.Rate);
	ok(over.msg !== undefined, "a rate-dropped verb is still decoded, so its nonce can be answered");
	eq("counted", g.rateDropped, 1);
	// it refills at INTENT_RATE per second
	eq(
		"a second later, one more",
		G.ingestBackpackIntent(g, good(), 1 / CFG.INTENT_RATE + 1e-9).verdict,
		G.IntentVerdict.Ok,
	);
	// a client at exactly the rate is never dropped; one at twice the rate loses about half after the burst
	g = G.newIntentGate(0);
	let dropped = 0;
	for (let i = 1; i <= 2000; i++)
		if (G.ingestBackpackIntent(g, good(), i / CFG.INTENT_RATE).verdict !== G.IntentVerdict.Ok) dropped += 1;
	eq("a steady INTENT_RATE per second is never dropped", dropped, 0);
	g = G.newIntentGate(0);
	dropped = 0;
	for (let i = 1; i <= 2000; i++)
		if (G.ingestBackpackIntent(g, good(), i / (2 * CFG.INTENT_RATE)).verdict === G.IntentVerdict.Rate) dropped += 1;
	near("twice the rate: half is dropped", dropped, 1000 - CFG.INTENT_BURST, 3);
	// the presence verbs are mpHost's: never counted, never a token
	g = G.newIntentGate(0);
	for (let i = 0; i < 500; i++)
		eq(
			"presence",
			G.ingestBackpackIntent(g, P.encodeIntent(pick(PRESENCE_VERBS)), 0).verdict,
			G.IntentVerdict.Presence,
		);
	eq("presence took no token", g.tokens, CFG.INTENT_BURST);
	// malformed payloads take a token and are counted in a window; past FLOOD_MALFORMED the gate says so
	g = G.newIntentGate(0);
	for (let i = 0; i <= CFG.FLOOD_MALFORMED; i++) {
		const t = i * 0.05;
		eq(`junk ${i}`, G.ingestBackpackIntent(g, randBuf(rint(0, 12)), t).verdict === G.IntentVerdict.Ok, false);
	}
	ok(G.malformedFlood(g), "more than FLOOD_MALFORMED junk payloads inside the window is a flood");
	g = G.newIntentGate(0);
	for (let i = 0; i < CFG.FLOOD_MALFORMED; i++)
		G.ingestBackpackIntent(g, "junk", i * (CFG.FLOOD_MALFORMED_WINDOW_S / 10));
	ok(!G.malformedFlood(g), "the same count spread over several windows is not");
	// a clock that goes backwards neither throws nor mints tokens
	g = G.newIntentGate(100);
	for (let i = 0; i < CFG.INTENT_BURST; i++) G.ingestBackpackIntent(g, good(), 100);
	eq("backwards clock: no refill", G.ingestBackpackIntent(g, good(), 50).verdict, G.IntentVerdict.Rate);
	// fuzz: hostile payloads of every shape, at hostile times; never a throw, the bucket stays in [0, burst]
	g = G.newIntentGate(0);
	let t = 0;
	for (let i = 0; i < FUZZ_N; i++) {
		t += rnd() < 0.1 ? -rfloat(0, 5) : rfloat(0, 0.2);
		const kind = rint(0, 5);
		const payload =
			kind === 0
				? randBuf(rint(0, 20))
				: kind === 1
					? good()
					: kind === 2
						? pick([undefined, 7, "x", {}, [], NaN])
						: kind === 3
							? P.encodeIntent(pick(PRESENCE_VERBS))
							: bufOf([
									96,
									rint(0, 255),
									rint(0, 255),
									rint(0, 255),
									rint(0, 255),
									rint(0, 255),
									rint(0, 255),
									rint(0, 255),
								]);
		let res;
		try {
			res = G.ingestBackpackIntent(g, payload, t);
		} catch (e) {
			fail(`the gate threw: ${(e && e.message) || e}`);
			return;
		}
		if (res.verdict === G.IntentVerdict.Ok && (res.msg === undefined || !P.isBackpackIntent(res.msg.kind)))
			fail(`Ok without a backpack verb: ${JSON.stringify(res)}`);
		if (!(g.tokens >= 0 && g.tokens <= CFG.INTENT_BURST)) fail(`bucket out of range: ${g.tokens}`);
		checks += 1;
	}
});

test("Intent gate: out of the world only a cosmetic slot moves, and only to something owned (MON-04)", () => {
	const G = require(join(SRC, "server/net/intentGate.ts"));
	const { EQUIPS, EquipSlot } = require(join(SRC, "shared/data/equips.ts"));
	const { COSTUMES } = require(join(SRC, "shared/data/shop.ts"));
	const msg = (kind, arg) => P.decodeIntentMessage(P.encodeIntentArgs(kind, 0, arg, 1));
	const outfit = COSTUMES.find(c => COS.cosmeticSlotOf(c.equipId) === EquipSlot.Outfit);
	const save = SAVE.defaultSave();
	eq("an outfit not owned is refused", G.applyOutOfWorld(save, msg(P.IntentKind.Equip, outfit.equipId)), false);
	eq("and nothing is worn", save.equipOutfit, -1);
	save.costumes[outfit.id] = 1;
	eq("owned: worn", G.applyOutOfWorld(save, msg(P.IntentKind.Equip, outfit.equipId)), true);
	eq("in the outfit slot", save.equipOutfit, outfit.equipId);
	eq("cleared", G.applyOutOfWorld(save, msg(P.IntentKind.Unequip, EquipSlot.Outfit)), true);
	eq("nothing worn again", save.equipOutfit, -1);
	// armour, a hand item, a gun gadget: never out of the world, owned or not
	const armour = EQUIPS.find(e => e.kind === EquipSlot.Cloth);
	save.invenEquip[armour.id] = 1;
	eq("armour out of the world is refused", G.applyOutOfWorld(save, msg(P.IntentKind.Equip, armour.id)), false);
	eq("the cloth slot is untouched", save.equipCloth, -1);
	eq(
		"unequip of a non-cosmetic slot is refused",
		G.applyOutOfWorld(save, msg(P.IntentKind.Unequip, EquipSlot.Cloth)),
		false,
	);
	for (const kind of [P.IntentKind.UseItem, P.IntentKind.LearnSkill, P.IntentKind.Craft, P.IntentKind.SwitchWeapon]) {
		eq(`verb ${kind} out of the world is refused`, G.applyOutOfWorld(save, msg(kind, 1)), false);
	}
	eq(
		"no use, no learn, no switch happened",
		`${save.invenUse.join(",")}|${save.skillLevels.join(",")}|${save.equipWeapon}`,
		`${SAVE.defaultSave().invenUse.join(",")}|${SAVE.defaultSave().skillLevels.join(",")}|${SAVE.defaultSave().equipWeapon}`,
	);
});

// ---------------------------------------------------------------- 7c. the backpack mirror (S→C wallet `bag`, F3)

test("Wallet bag: the server's backpack round trips into the client's copy, and junk is clamped", () => {
	const server = SAVE.defaultSave();
	server.invenWeapon[3] = 2;
	server.invenEtc[23] = 41;
	server.ammoNormal = 120;
	server.oil = 7;
	server.equipWeapon = 3;
	server.equipCloth = 1;
	server.skillLevels[7] = 2;
	server.skillPoint = 3;
	const bag = SAVE.bagOf(server, 10, 777, 65000);
	const client = SAVE.defaultSave();
	const read = SAVE.readBag(JSON.parse(JSON.stringify(bag)));
	ok(read !== undefined, "a bag the server wrote reads back");
	SAVE.applyBag(client, read);
	for (const f of ["invenWeapon", "invenEquip", "invenUse", "invenEtc", "skillLevels"]) {
		eq(`bag ${f}`, client[f].join(","), server[f].join(","));
	}
	for (const f of ["ammoNormal", "ammoShotgun", "ammoMachinegun", "ammoArrow", "oil", "electric"])
		eq(`bag ${f}`, client[f], server[f]);
	for (const f of ["equipWeapon", "equipCloth", "equipHand", "equipGun", "equipOutfit", "equipPet", "skillPoint"])
		eq(`bag ${f}`, client[f], server[f]);
	eq("bag place", read.place, 10);
	eq("bag ack", read.ack, 777);
	eq("bag seq", read.seq, 65000);
	// the signature moves with every field that can change, and not with seq
	const sig = SAVE.bagSignature(server, 10, 777);
	eq("same bag, same signature", SAVE.bagSignature(server, 10, 777), sig);
	server.ammoArrow += 1;
	ok(SAVE.bagSignature(server, 10, 777) !== sig, "ammo moves the signature");
	ok(SAVE.bagSignature(server, 11, 777) !== SAVE.bagSignature(server, 10, 777), "place moves it");
	ok(SAVE.bagSignature(server, 10, 778) !== SAVE.bagSignature(server, 10, 777), "ack moves it");
	// hostile or broken tables: not a bag, or clamped to what a save allows
	for (const bad of [undefined, 3, "bag", {}, { ...bag, invenUse: 7 }, { ...bag, equip: undefined }]) {
		eq(`readBag(${JSON.stringify(bad)?.slice(0, 40)})`, SAVE.readBag(bad), undefined);
	}
	const junk = SAVE.readBag({
		...JSON.parse(JSON.stringify(bag)),
		invenWeapon: [1e12, -5, NaN, "x"],
		ammo: [-1, 1e12, NaN],
		equip: [9999, -7, 1.5],
		skillLevels: [99, -1],
		skillPoint: -3,
		place: 1e9,
		ack: -1,
		seq: 1e9,
	});
	eq("a count is capped at ITEM_MAX", junk.invenWeapon[0], SAVE.SAVE_LIMITS.ITEM_MAX);
	eq("a negative count reads 0", junk.invenWeapon[1], 0);
	eq("the array keeps the table's size", junk.invenWeapon.length, WEAPONS.length);
	eq("ammo is capped", junk.ammo[1], SAVE.SAVE_LIMITS.AMMO_MAX);
	eq("the weapon slot is capped to a real weapon", junk.equip[0], WEAPONS.length - 1);
	eq("-1 stays 'nothing equipped'", junk.equip[1], -1);
	eq("a skill never passes its maximum", junk.skillLevels[0] <= 5, true);
	eq("skill points never go negative", junk.skillPoint, 0);
	eq("ack stays a u16", junk.ack, 0);
	eq("seq stays a u16", junk.seq, 65535);
});

// ---------------------------------------------------------------- 8. fuzz

const DECODERS = [
	["decodeInput", P.decodeInput],
	["decodeSnapshotPart", P.decodeSnapshotPart],
	["decodeFx", P.decodeFx],
	["decodeWorld", P.decodeWorld],
	["decodeTimePing", P.decodeTimePing],
	["decodeTimePong", P.decodeTimePong],
	["decodeIntentMessage", P.decodeIntentMessage],
];

test(`fuzz: ${FUZZ_N} random/truncated buffers per decoder never throw`, () => {
	let decoded = 0;
	for (const [name, decode] of DECODERS) {
		for (let i = 0; i < FUZZ_N; i++) {
			const len = rnd() < 0.5 ? rint(0, 64) : rint(0, 1100);
			const b = randBuf(len);
			try {
				const out = decode(b);
				if (out !== undefined) decoded += 1;
			} catch (e) {
				fail(`${name} threw on random bytes (len ${len}): ${(e && e.message) || e}`);
				return;
			}
			checks += 1;
		}
		// non-buffer values from a hostile client
		for (const bad of [undefined, null, 0, -1, NaN, Infinity, "x", {}, [], true, () => 0]) {
			try {
				eq(`${name}(${String(bad)})`, decode(bad), undefined);
			} catch (e) {
				fail(`${name} threw on ${String(bad)}: ${(e && e.message) || e}`);
				return;
			}
		}
	}
	console.log(`     (${decoded} random buffers happened to be valid packets — all handled)`);
});

test(`fuzz: ${FUZZ_N} mutations of valid packets never throw`, () => {
	const samples = [];
	for (let i = 0; i < 40; i++) {
		samples.push(["decodeInput", P.encodeInput(randInputPacket(rint(1, 3))), P.decodeInput]);
		for (const part of P.encodeSnapshot(randSnapshot(rint(0, 5), rint(0, 60), rint(0, 2), rbool())).parts) {
			samples.push(["decodeSnapshotPart", part, P.decodeSnapshotPart]);
		}
		const fx = P.encodeFx({ tick: rint(0, 65535), events: [randFxEvent(), randFxEvent(), randFxEvent()] });
		for (const pkt of fx.packets) samples.push(["decodeFx", pkt, P.decodeFx]);
		const world = P.encodeWorld({ tick: rint(0, 65535), events: [randWorldEvent(), randWorldEvent()] });
		for (const pkt of world.packets) samples.push(["decodeWorld", pkt, P.decodeWorld]);
		samples.push([
			"decodeTimePing",
			P.encodeTimePing({ seq: rint(0, 65535), clientTime: rfloat(0, 1e6) }),
			P.decodeTimePing,
		]);
		samples.push(["decodeIntentMessage", randIntent(), P.decodeIntentMessage]);
		samples.push(["decodeIntentMessage", P.encodeIntent(pick(PRESENCE_VERBS)), P.decodeIntentMessage]);
	}
	let survivors = 0;
	for (let i = 0; i < FUZZ_N; i++) {
		const [name, base, decode] = pick(samples);
		let bytes = bytesOf(base);
		const mode = rint(0, 3);
		if (mode === 0) {
			const at = rint(0, bytes.length - 1);
			bytes[at] = rint(0, 255);
		} else if (mode === 1) {
			bytes = bytes.slice(0, rint(0, bytes.length));
		} else if (mode === 2) {
			for (let k = 0; k < rint(1, 6); k++) bytes.push(rint(0, 255));
		} else {
			for (let k = 0; k < rint(1, 4); k++) bytes[rint(0, bytes.length - 1)] = rint(0, 255);
		}
		const mutated = bufOf(bytes);
		try {
			const out = decode(mutated);
			if (out !== undefined) survivors += 1;
		} catch (e) {
			fail(`${name} threw on a mutated packet: ${(e && e.message) || e}\n  bytes: ${bytes.join(",")}`);
			return;
		}
		checks += 1;
	}
	console.log(`     (${survivors} mutations still decoded as valid packets — all handled)`);
});

test("stability: decode → encode → decode gives the same content", () => {
	for (let i = 0; i < 300; i++) {
		const input = P.encodeInput(randInputPacket(rint(1, 3)));
		const d1 = P.decodeInput(input);
		const d2 = P.decodeInput(P.encodeInput(d1));
		eq("input is stable", JSON.stringify(d2), JSON.stringify(d1));
		const snap = randSnapshot(rint(0, 5), rint(0, 80), rint(0, 2), rbool());
		const first = decodeParts(P.encodeSnapshot(snap).parts);
		if (first === undefined) continue;
		const again = decodeParts(P.encodeSnapshot(first).parts);
		eq("snapshot is stable", JSON.stringify(again), JSON.stringify(first));
		const fx = { tick: rint(0, 65535), events: [randFxEvent(), randFxEvent()] };
		const fx1 = P.decodeFx(P.encodeFx(fx).packets[0]);
		if (fx1 === undefined) {
			fail("an Fx batch did not decode");
			continue;
		}
		const fx2 = P.decodeFx(P.encodeFx(fx1).packets[0]);
		eq("Fx is stable", JSON.stringify(fx2), JSON.stringify(fx1));
		const world = { tick: rint(0, 65535), events: [randWorldEvent(), randWorldEvent()] };
		const w1 = P.decodeWorld(P.encodeWorld(world).packets[0]);
		if (w1 === undefined) {
			fail("a World batch did not decode");
			continue;
		}
		const w2 = P.decodeWorld(P.encodeWorld(w1).packets[0]);
		eq("World is stable", JSON.stringify(w2), JSON.stringify(w1));
	}
});

// ---------------------------------------------------------------- 9. bandwidth (measured vs the doc)

test("bandwidth: measured sizes vs the estimates of §4.7", () => {
	rnd = mulberry32(SEED + 2);
	const worst = randSnapshot(5, 90, 2, true, true);
	const worstBytes = P.encodeSnapshot(worst).parts.reduce((a, p) => a + buffer.len(p), 0);
	const snapBps = worstBytes * CFG.SNAP_NEAR_HZ;
	const docSnapBps = 720 + 1200 + 10800 + 5400 + 180 + 560; // §4.7 rows without Fx/deltas/overhead
	sizes.push([
		"Downstream, snapshots only, worst case",
		`${(snapBps / 1000).toFixed(1)} kB/s (${worstBytes} B × ${CFG.SNAP_NEAR_HZ} Hz)`,
		`${(docSnapBps / 1000).toFixed(1)} kB/s (§4.7)`,
	]);
	ok(snapBps < CFG.BANDWIDTH_WORST_BPS, `snapshots alone (${snapBps} B/s) must stay under the worst-case budget`);
	// what the server ACTUALLY sends from F2 on: the replicator sorts by distance and cuts at SNAP_ZOMBIE_CAP,
	// which is the knob that keeps a 150-strong horde inside two packets and inside the §4.7 budget
	const capped = randSnapshot(5, CFG.SNAP_ZOMBIE_CAP, 2, true, true);
	const cappedRes = P.encodeSnapshot(capped);
	const cappedBytes = cappedRes.parts.reduce((a, p) => a + buffer.len(p), 0);
	eq("nothing is dropped at the replicator's own cap", cappedRes.dropped, 0);
	ok(cappedRes.parts.length <= 2, `the cap holds a snapshot to 2 parts (${cappedRes.parts.length})`);
	sizes.push([
		`Downstream, snapshots at SNAP_ZOMBIE_CAP (${CFG.SNAP_ZOMBIE_CAP})`,
		`${((cappedBytes * CFG.SNAP_NEAR_HZ) / 1000).toFixed(1)} kB/s (${cappedBytes} B in ${cappedRes.parts.length} parts)`,
		"measured end to end in tools/test-replication.mjs",
	]);
	const typical = randSnapshot(2, 25, 0, true, false);
	for (const z of typical.zombies) delete z.extra;
	const typBytes = P.encodeSnapshot(typical).parts.reduce((a, p) => a + buffer.len(p), 0);
	sizes.push([
		"Downstream, snapshots only, typical case",
		`${((typBytes * CFG.SNAP_NEAR_HZ) / 1000).toFixed(1)} kB/s`,
		"7–8 kB/s with everything (§4.7)",
	]);
	const upBps = 28 * CFG.INPUT_HZ;
	sizes.push([
		"Upstream, Input at 60/s",
		`${(upBps / 1000).toFixed(2)} kB/s (28 B × 60)`,
		"≈3 kB/s with the overhead (§4.7)",
	]);
	// the mid-ring-at-5-Hz lever of §4.7: half the mid zombies per snapshot
	const lever = randSnapshot(5, 75, 2, true, true);
	const leverBytes = P.encodeSnapshot(lever).parts.reduce((a, p) => a + buffer.len(p), 0);
	sizes.push([
		"Same case with the mid ring at 5 Hz (lever of §4.7)",
		`${((leverBytes * CFG.SNAP_NEAR_HZ) / 1000).toFixed(1)} kB/s`,
		"−2.7 kB/s (§4.7)",
	]);
	rnd = mulberry32(SEED);
});

test("throughput: encode/decode cost (indicative only — Node JIT, not Luau)", () => {
	const snap = randSnapshot(5, 90, 2, true, true);
	const rounds = 2000;
	let t0 = process.hrtime.bigint();
	let parts;
	for (let i = 0; i < rounds; i++) parts = P.encodeSnapshot(snap).parts;
	const encUs = Number(process.hrtime.bigint() - t0) / 1000 / rounds;
	t0 = process.hrtime.bigint();
	for (let i = 0; i < rounds; i++) for (const p of parts) P.decodeSnapshotPart(p);
	const decUs = Number(process.hrtime.bigint() - t0) / 1000 / rounds;
	sizes.push([
		"Worst-case snapshot: encode / decode",
		`${encUs.toFixed(1)} µs / ${decUs.toFixed(1)} µs per snapshot (Node)`,
		"budget of 1 ms for 6 clients per tick (§3.2)",
	]);
	ok(encUs > 0 && decUs > 0, "measurement failed");
});

// ---------------------------------------------------------------- report

console.log("");
console.log("Packet sizes (measured vs the doc)");
const w0 = Math.max(...sizes.map(s => String(s[0]).length));
const w1 = Math.max(...sizes.map(s => String(s[1]).length));
for (const [what, got, expected] of sizes) {
	console.log(`  ${String(what).padEnd(w0)}  ${String(got).padEnd(w1)}  | ${expected}`);
}
console.log("");
if (failures.length > 0) {
	console.log(`FAILED: ${failures.length} of ${checks} checks (seed ${SEED})`);
	for (const f of failures.slice(0, 40)) console.log(`  - ${f}`);
	if (failures.length > 40) console.log(`  … and ${failures.length - 40} more`);
	process.exit(1);
}
console.log(`OK: ${checks} checks passed (seed ${SEED}, fuzz ${FUZZ_N} per decoder)`);
