#!/usr/bin/env node
/*
 * The Luau / roblox-ts shims every node test needs, in one place.
 *
 * `src/` is TypeScript compiled by `rbxtsc` for Luau, so it speaks a dialect Node does not: `math.clamp`,
 * `typeIs`, `buffer.*`, `Color3`, and Array/Map methods that are methods rather than properties (`size()`,
 * `remove(i)`). Running the REAL server modules under Node — which is the only reason these tests are worth
 * anything — means providing that dialect.
 *
 * The `buffer` here is STRICT on purpose: an out-of-bounds or out-of-range write throws instead of silently
 * wrapping, which is how a codec bug becomes a failing test rather than a corrupted neighbouring field.
 *
 * The older suites (test-sim, test-net, test-server-sim, test-combat, …) each carry their own copy of this
 * block; they were written before there were six of them. New suites import this module instead. Changing a
 * shim here does not change theirs, so if a behaviour matters to both, change both.
 *
 *   import { installShims } from "./luau-shim.mjs";
 *   const { SRC, require, setSeed } = installShims({ seed: 1 });
 *   const { createWorld } = require(join(SRC, "shared/game/world.ts"));
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

/** mulberry32: a test that rolls loot must roll the same loot on every run */
export function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

let nextRandom = mulberry32(1);
let installed = false;

/** re-seeds `math.random`; a test calls it before any section whose result must be reproducible */
export function setSeed(seed) {
	nextRandom = mulberry32(seed);
}

export { ROOT, SRC, require };

/**
 * Installs the globals and the `.ts` loader. Safe to call more than once (the second call only re-seeds),
 * and returns everything a suite needs to load the modules under test.
 */
export function installShims(options = {}) {
	if (options.seed !== undefined) setSeed(options.seed);
	if (installed) return { ROOT, SRC, require, setSeed };
	installed = true;
	install();
	return { ROOT, SRC, require, setSeed };
}

function install() {
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
	// Luau's xpcall on top of the SUITE's own `pcall`, looked up at call time (each suite's fake scheduler decides what
	// a yield inside one does), and a `debug.traceback` that only marks where Luau puts the stack: the server's save
	// path and tick report their errors through them (server/main.server.ts, server/net/mpHost.ts). A suite that adds
	// other `debug` members (profilebegin, …) extends this object instead of replacing it.
	globalThis.xpcall = (fn, handler, ...args) => {
		const [ok, value] =
			typeof globalThis.pcall === "function"
				? globalThis.pcall(fn, ...args)
				: (() => {
						try {
							return [true, fn(...args)];
						} catch (e) {
							return [false, e instanceof Error ? e.message : e];
						}
					})();
		if (ok) return [true, value];
		try {
			return [false, handler(value)];
		} catch {
			// Luau: a handler that errors makes xpcall answer false and a fixed message
			return [false, "error in error handling"];
		}
	};
	globalThis.debug = {
		traceback: message => `${message ?? ""}\nstack traceback:\n\t[luau-shim: no Luau stack under Node]`,
		// the client's MicroProfiler labels (client/gameLoop.ts, main.client.ts): no profiler under Node
		profilebegin: () => {},
		profileend: () => {},
	};

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
		if (typeof offset !== "number" || !Number.isInteger(offset))
			throw new TypeError(`offset ${offset} not an integer`);
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
	// roblox-ts `Array.insert(index, value)` (shared/sim/ai/alert.ts keeps its nearest-first list with it)
	defineMethod(Array.prototype, "insert", function (i, v) {
		this.splice(i, 0, v);
	});
	defineMethod(String.prototype, "size", function () {
		return Buffer.byteLength(this.valueOf(), "utf8");
	});
	// String.prototype.sub is a legacy JS method (it wraps the string in <sub>): replaced by Luau's string.sub
	// (client/view/buildingSigns.ts reads its grids with it, like client/ui/itemIcon.ts)
	defineMethod(String.prototype, "sub", function (i = 1, j = -1) {
		const n = this.length;
		const s = i < 0 ? Math.max(n + i + 1, 1) : Math.max(i, 1);
		const e = j < 0 ? n + j + 1 : Math.min(j, n);
		return s > e ? "" : this.slice(s - 1, e);
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
}
