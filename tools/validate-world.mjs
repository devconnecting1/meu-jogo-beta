#!/usr/bin/env node
/*
 * World validator: generates the procedural town for several seeds and checks every [auto] rule of
 * docs/DESIGN_RULES.md. Each failure is printed with its rule ID; the exit code is 1 on any failure.
 *
 *   npm run validate:world                   # DESIGN.TOWN_SEED + 4 fixed seeds
 *   node tools/validate-world.mjs 7331 42    # specific seeds
 *   node tools/validate-world.mjs --all      # every failure (default: the first 12 per rule and seed)
 *   node tools/validate-world.mjs --marks out.json   # also dump failures as [{rule, x, y, seed}]
 *   PZ_SRC=path/to/src node tools/validate-world.mjs  # validate another source tree
 *
 * Besides the [auto] rules, INT-01 checks generator integrity (no overlapping solids, spatial grid in
 * sync, 5 wall segments per building, boss plazas clear); EDI-01 also walks into every door with
 * physics.moveActor.
 *
 * Pure Node (>= 18) + the project's TypeScript (devDependency) to transpile src/shared on the fly,
 * with small shims for the Luau / roblox-ts globals the shared code uses (math, Color3, Array#size...).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
	random: (a, b) =>
		a === undefined
			? Math.random()
			: b === undefined
				? 1 + Math.floor(Math.random() * a)
				: a + Math.floor(Math.random() * (b - a + 1)),
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

// "shared/x" → SRC/shared/x.ts, transpiled with the project's TypeScript
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

const W = require(join(SRC, "shared/game/world.ts"));
const { DESIGN, TOWN } = require(join(SRC, "shared/engine/constants.ts"));
const physics = require(join(SRC, "shared/game/physics.ts"));
const { BUILDING_SPAWNS } = require(join(SRC, "shared/data/spawns.ts"));
const { USABLES } = require(join(SRC, "shared/data/usables.ts"));
const { ETC_ITEMS } = require(join(SRC, "shared/data/etcItems.ts"));

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const SHOW_ALL = args.includes("--all");
const marksIdx = args.indexOf("--marks");
const MARKS_FILE = marksIdx >= 0 ? args[marksIdx + 1] : undefined;
const seeds = args.filter((a, i) => /^-?\d+$/.test(a) && (marksIdx < 0 || i !== marksIdx + 1)).map(Number);
if (seeds.length === 0) seeds.push(DESIGN.TOWN_SEED, 1, 42, 99991, 123456);
const PER_RULE = 12;

// ---------------------------------------------------------------- constants (docs/DESIGN_RULES.md)

const SW = TOWN.SIDEWALK;
const VERGE = TOWN.VERGE ?? 0;
const BODY_R = 18;
const CORNER = TOWN.CORNER_CLEAR ?? 200;
const PITCH_MIN = 440;
const PITCH_MAX = 660;
const LANE_FREE = TOWN.LANE_FREE ?? 150;
/** ESC-01 table (world units) and tolerance */
const SCALE = {
	trunk: 44,
	canopyMin: 150,
	canopyMax: 172,
	carL: 200,
	carW: 100,
	trash: 36,
	door: 112,
	street: 384,
	sidewalk: 128,
};
const TOL = 0.3;
const TYPE_TAG = {
	1: "house",
	2: "house",
	3: "school",
	4: "hospital",
	5: "gas",
	6: "pharmacy",
	7: "market",
	8: "market",
	9: "gunshop",
	10: "cloth",
	11: "restaurant",
};
const SHOPS = [6, 7, 8, 9, 10, 11];

// ---------------------------------------------------------------- geometry helpers

const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const inside = (a, b, eps = 0.01) =>
	a.x >= b.x - eps && a.y >= b.y - eps && a.x + a.w <= b.x + b.w + eps && a.y + a.h <= b.y + b.h + eps;
const rectDist = (a, b) =>
	Math.hypot(Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w)), Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h)));
const ptRectDist = (x, y, r) => Math.hypot(Math.max(r.x - x, 0, x - r.x - r.w), Math.max(r.y - y, 0, y - r.y - r.h));
const cx = s => s.x + s.w / 2;
const cy = s => s.y + s.h / 2;
const alongX = side => side === "top" || side === "bottom";
const NORMAL = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
const fmt = v => Math.round(v);
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

function edgeRect(e, u0, u1, v0, v1) {
	const p0 = e.curb + e.inward * v0;
	const p1 = e.curb + e.inward * v1;
	const lo = Math.min(p0, p1);
	const hi = Math.max(p0, p1);
	const a = Math.min(u0, u1);
	const b = Math.max(u0, u1);
	return alongX(e.side) ? { x: a, y: lo, w: b - a, h: hi - lo } : { x: lo, y: a, w: hi - lo, h: b - a };
}
/** (u along, v inward from the curb) of a point relative to an edge */
const edgeUV = (e, x, y) =>
	alongX(e.side) ? { u: x, v: (y - e.curb) * e.inward } : { u: y, v: (x - e.curb) * e.inward };

/** lot edges; derived from lot vs yard when the generator does not export them */
function lotEdges(w, lot) {
	if (lot.edges) return lot.edges;
	const out = [];
	const y = lot.yard;
	const ca = y.x > lot.x;
	const cb = y.x + y.w < lot.x + lot.w;
	const ra = y.y > lot.y;
	const rb = y.y + y.h < lot.y + lot.h;
	if (ra) out.push({ side: "top", curb: lot.y, inward: 1, a: lot.x, b: lot.x + lot.w, cornerA: ca, cornerB: cb });
	if (rb) {
		out.push({
			side: "bottom",
			curb: lot.y + lot.h,
			inward: -1,
			a: lot.x,
			b: lot.x + lot.w,
			cornerA: ca,
			cornerB: cb,
		});
	}
	if (ca) out.push({ side: "left", curb: lot.x, inward: 1, a: lot.y, b: lot.y + lot.h, cornerA: ra, cornerB: rb });
	if (cb) {
		out.push({
			side: "right",
			curb: lot.x + lot.w,
			inward: -1,
			a: lot.y,
			b: lot.y + lot.h,
			cornerA: ra,
			cornerB: rb,
		});
	}
	return out;
}

function junctionsOf(w) {
	if (w.junctions) return w.junctions;
	const out = [];
	const vs = w.roads.filter(r => r.h > r.w);
	const hs = w.roads.filter(r => r.w >= r.h);
	for (const v of vs) for (const h of hs) out.push({ x: v.x, y: h.y, w: v.w, h: h.h });
	return out;
}

const isVertical = r => (r.vertical !== undefined ? r.vertical : r.h > r.w);

// ---------------------------------------------------------------- reachability raster (CID-05)

function reachability(w, start) {
	const C = 8;
	const cols = Math.ceil(w.width / C);
	const rows = Math.ceil(w.height / C);
	const blocked = new Uint8Array(cols * rows);
	const r = BODY_R;
	for (const s of w.solids) {
		if (!W.isBlocking(s)) continue;
		const c0 = Math.max(0, Math.floor((s.x - r) / C));
		const c1 = Math.min(cols - 1, Math.floor((s.x + s.w + r) / C));
		const r0 = Math.max(0, Math.floor((s.y - r) / C));
		const r1 = Math.min(rows - 1, Math.floor((s.y + s.h + r) / C));
		for (let j = r0; j <= r1; j++) {
			const py = j * C + C / 2;
			const dy = Math.max(s.y - py, 0, py - s.y - s.h);
			for (let i = c0; i <= c1; i++) {
				const px = i * C + C / 2;
				const dx = Math.max(s.x - px, 0, px - s.x - s.w);
				if (dx * dx + dy * dy < r * r) blocked[j * cols + i] = 1;
			}
		}
	}
	const seen = new Uint8Array(cols * rows);
	const queue = new Int32Array(cols * rows);
	let head = 0;
	let tail = 0;
	const si = Math.floor(start.x / C);
	const sj = Math.floor(start.y / C);
	if (!blocked[sj * cols + si]) {
		seen[sj * cols + si] = 1;
		queue[tail++] = sj * cols + si;
	}
	while (head < tail) {
		const k = queue[head++];
		const i = k % cols;
		const j = (k - i) / cols;
		const nb = [i > 0 ? k - 1 : -1, i < cols - 1 ? k + 1 : -1, j > 0 ? k - cols : -1, j < rows - 1 ? k + cols : -1];
		for (const n of nb) {
			if (n < 0 || seen[n] || blocked[n]) continue;
			seen[n] = 1;
			queue[tail++] = n;
		}
	}
	const at = (x, y) => {
		const i = Math.floor(x / C);
		const j = Math.floor(y / C);
		if (i < 0 || j < 0 || i >= cols || j >= rows) return { blocked: true, reached: false };
		return { blocked: blocked[j * cols + i] === 1, reached: seen[j * cols + i] === 1 };
	};
	return { at, reachedCells: tail };
}

// ---------------------------------------------------------------- interiors (EDI-08..EDI-14)

/** the doors a type is meant to have (front + back / service / exits), EDI-09 */
const DOOR_TARGET = { 1: 2, 2: 2, 3: 3, 4: 3, 5: 2, 6: 2, 7: 3, 8: 2, 9: 2, 10: 2, 11: 2 };
/** share of a type's buildings that must reach DOOR_TARGET (a secondary door is dropped where the ground is taken) */
const DOOR_SHARE = 0.6;
/** rooms that never get a window (EDI-10): a bathroom, a hall, the back rooms, the gun shop's secure room */
const NO_WINDOW = new Set(["bath", "hall", "stock", "cold", "secure", "corridor", "treatment", "galley"]);
/** walker speed (u/s): 3 px/frame at 30 fps, shared/data/zombies.ts */
const WALKER_SPEED = 90;
/**
 * EDI-11: the longest a walker takes, from the nearest outside point, to reach any spot of any room (climbing a
 * window counted at its real slowness). 12 s: under the ~13 s it takes the night's first wave to walk from its
 * spawn ring (720–1080 u, MP-09) to a survivor standing on the street, so hiding deep inside never buys more
 * than the walk across a yard.
 */
const REACH_BOUND_S = 12;

/** raster of one building's surroundings: blocked for a body of radius r, window vault zones, the footprint */
function buildingRaster(w, b, r, margin) {
	const C = 8;
	const x0 = b.x - margin;
	const y0 = b.y - margin;
	const cols = Math.ceil((b.w + margin * 2) / C);
	const rows = Math.ceil((b.h + margin * 2) / C);
	const blocked = new Uint8Array(cols * rows);
	const vault = new Uint8Array(cols * rows);
	const inside = new Uint8Array(cols * rows);
	const parts = b.parts ?? [b];
	for (let j = 0; j < rows; j++) {
		const py = y0 + j * C + C / 2;
		for (let i = 0; i < cols; i++) {
			const px = x0 + i * C + C / 2;
			if (parts.some(p => px >= p.x && px <= p.x + p.w && py >= p.y && py <= p.y + p.h)) inside[j * cols + i] = 1;
		}
	}
	for (const s of W.querySolids(w, x0, y0, x0 + cols * C, y0 + rows * C)) {
		const window = s.kind === "window";
		if (!window && !W.isBlocking(s)) continue;
		const pad = window ? physics.VAULT_REACH + C : r;
		const c0 = Math.max(0, Math.floor((s.x - pad - x0) / C));
		const c1 = Math.min(cols - 1, Math.floor((s.x + s.w + pad - x0) / C));
		const r0 = Math.max(0, Math.floor((s.y - pad - y0) / C));
		const r1 = Math.min(rows - 1, Math.floor((s.y + s.h + pad - y0) / C));
		for (let j = r0; j <= r1; j++) {
			const py = y0 + j * C + C / 2;
			const dy = Math.max(s.y - py, 0, py - s.y - s.h);
			for (let i = c0; i <= c1; i++) {
				const px = x0 + i * C + C / 2;
				if (window) {
					if (physics.inVaultZone(s, px, py)) vault[j * cols + i] = 1;
					continue;
				}
				const dx = Math.max(s.x - px, 0, px - s.x - s.w);
				if (dx * dx + dy * dy < r * r) blocked[j * cols + i] = 1;
			}
		}
	}
	const idx = (x, y) => {
		const i = Math.floor((x - x0) / C);
		const j = Math.floor((y - y0) / C);
		return i < 0 || j < 0 || i >= cols || j >= rows ? -1 : j * cols + i;
	};
	return { C, x0, y0, cols, rows, blocked, vault, inside, idx };
}

/**
 * Cheapest path from `starts` over the free cells `allowed` lets through (8-neighbour, no corner cutting), in
 * world units; a step inside a window's vault zone costs 1 / VAULT_SLOW of its length (the climb, EDI-10).
 */
function pathField(ras, starts, allowed) {
	const { cols, rows, blocked, vault, C } = ras;
	const n = cols * rows;
	const dist = new Float64Array(n).fill(Infinity);
	const heap = [];
	const push = (k, d) => {
		heap.push([d, k]);
		let i = heap.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (heap[p][0] <= heap[i][0]) break;
			[heap[p], heap[i]] = [heap[i], heap[p]];
			i = p;
		}
	};
	const pop = () => {
		const top = heap[0];
		const last = heap.pop();
		if (heap.length > 0) {
			heap[0] = last;
			let i = 0;
			for (;;) {
				const l = i * 2 + 1;
				const r = l + 1;
				let m = i;
				if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
				if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
				if (m === i) break;
				[heap[m], heap[i]] = [heap[i], heap[m]];
				i = m;
			}
		}
		return top;
	};
	for (const k of starts) {
		if (k < 0 || blocked[k]) continue;
		dist[k] = 0;
		push(k, 0);
	}
	const slow = 1 / physics.VAULT_SLOW;
	while (heap.length > 0) {
		const [d, k] = pop();
		if (d > dist[k]) continue;
		const i = k % cols;
		const j = (k - i) / cols;
		for (let dj = -1; dj <= 1; dj++) {
			for (let di = -1; di <= 1; di++) {
				if (di === 0 && dj === 0) continue;
				const ni = i + di;
				const nj = j + dj;
				if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
				const nk = nj * cols + ni;
				if (blocked[nk] || !allowed(nk)) continue;
				if (di !== 0 && dj !== 0 && (blocked[j * cols + ni] || blocked[nj * cols + i])) continue;
				const step = (di !== 0 && dj !== 0 ? Math.SQRT2 : 1) * C * (vault[nk] || vault[k] ? slow : 1);
				if (d + step < dist[nk]) {
					dist[nk] = d + step;
					push(nk, d + step);
				}
			}
		}
	}
	return dist;
}

/** the free cells of the raster lying in a rect */
function cellsIn(ras, q) {
	const out = [];
	for (let y = q.y + ras.C / 2; y < q.y + q.h; y += ras.C) {
		for (let x = q.x + ras.C / 2; x < q.x + q.w; x += ras.C) {
			const k = ras.idx(x, y);
			if (k >= 0 && !ras.blocked[k] && ras.inside[k]) out.push(k);
		}
	}
	return out;
}

/**
 * EDI-08..EDI-14 for every building: rooms reachable from every entrance (a body of 18, through the inside),
 * every entrance with a free approach, nothing in front of an opening, loot spots reachable, windows only where
 * a real building has them, entrance counts per type, non-rectangular footprints, and no safe spot: a walker
 * reaches every free spot of every room from outside within REACH_BOUND_S.
 */
function interiorChecks(w, buildings, kidsOf, reach, fail, stats) {
	const byType = {};
	let compound = 0;
	let worst = { s: 0 };
	for (const b of buildings) {
		if ((b.parts?.length ?? 1) > 1) compound++;
		const openings = b.openings ?? [];
		const doors = openings.filter(o => o.kind === "door");
		const windows = openings.filter(o => o.kind === "window");
		const t = b.buildingType;
		const tt = (byType[t] ??= { n: 0, target: 0, doors: 0, windows: 0 });
		tt.n++;
		tt.doors += doors.length;
		tt.windows += windows.length;
		if (doors.length >= (DOOR_TARGET[t] ?? 2)) tt.target++;
		if (doors.filter(o => o.main).length !== 1) fail("EDI-09", `${b.tags} #${b.id}: ${doors.filter(o => o.main).length} main doors`, cx(b), cy(b));
		// a second way out always: another door or a window (no single-exit building)
		if (doors.length + windows.length < 2) fail("EDI-09", `${b.tags} #${b.id}: a single way in`, cx(b), cy(b));
		const rooms = b.rooms ?? [];
		const roomAt = (x, y) => rooms.find(q => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h);
		const kids = kidsOf.get(b.id) ?? [];
		const furniture = kids.filter(s => s.kind === "furniture");
		// EDI-10: windows only where a real building has them, and wide enough for the biggest walker
		for (const o of windows) {
			const n = NORMAL[o.side];
			const r = roomAt(o.x + o.w / 2 - n[0] * 30, o.y + o.h / 2 - n[1] * 30);
			if (r !== undefined && NO_WINDOW.has(r.kind)) {
				fail("EDI-10", `${b.tags} #${b.id}: a window in the ${r.kind}`, o.x + o.w / 2, o.y + o.h / 2);
			}
			if (Math.max(o.w, o.h) < physics.ZOMBIE_RADIUS * 1.4 * 2 + 8) {
				fail("EDI-10", `${b.tags} #${b.id}: window too narrow for a big walker`, o.x, o.y);
			}
		}
		// EDI-12: nothing in front of a doorway (two bodies deep) or a window (one body deep)
		for (const o of openings) {
			const along = o.w >= o.h;
			const d = o.kind === "window" ? 36 : 64;
			const zones = along
				? [
						{ x: o.x, y: o.y - d, w: o.w, h: d },
						{ x: o.x, y: o.y + o.h, w: o.w, h: d },
					]
				: [
						{ x: o.x - d, y: o.y, w: d, h: o.h },
						{ x: o.x + o.w, y: o.y, w: d, h: o.h },
					];
			for (const z of zones) {
				const hit = furniture.find(f => overlap(f, z));
				if (hit) fail("EDI-12", `${b.tags} #${b.id}: ${hit.tags} blocks a ${o.kind}`, cx(hit), cy(hit));
			}
		}
		// EDI-09: every door opens onto free ground (a body walks 120 u straight out) that the town reaches
		for (const o of doors) {
			const n = NORMAL[o.side];
			const ox = o.x + o.w / 2;
			const oy = o.y + o.h / 2;
			let blocked;
			for (let t2 = TOWN.WALL_T / 2 + BODY_R + 2; t2 <= TOWN.WALL_T / 2 + 120 - BODY_R; t2 += 6) {
				const hit = physics.circleBlocked(w, ox + n[0] * t2, oy + n[1] * t2, BODY_R);
				if (hit) {
					blocked = hit;
					break;
				}
			}
			if (blocked) {
				fail("EDI-09", `${b.tags} #${b.id}: ${o.main ? "main" : "secondary"} door blocked outside by ${blocked.kind}/${blocked.tags}`, ox, oy);
			} else if (!reach.at(ox + n[0] * 100, oy + n[1] * 100).reached) {
				fail("EDI-09", `${b.tags} #${b.id}: a door opens onto ground the town does not reach`, ox, oy);
			}
		}
		if (rooms.length === 0) continue;
		// EDI-08: from every door, through the inside, a body of 18 reaches every room and every loot spot
		const ras = buildingRaster(w, b, BODY_R, 160);
		for (const o of doors) {
			const n = NORMAL[o.side];
			const sx = o.x + o.w / 2 + n[0] * (TOWN.WALL_T / 2 + 20);
			const sy = o.y + o.h / 2 + n[1] * (TOWN.WALL_T / 2 + 20);
			const start = ras.idx(sx, sy);
			const dist = pathField(ras, [start], k => ras.inside[k] === 1 || k === start || Math.hypot(((k % ras.cols) * ras.C + ras.x0) - sx, (Math.floor(k / ras.cols) * ras.C + ras.y0) - sy) < 40);
			const seen = new Set();
			for (const q of rooms) {
				if (seen.has(q.room)) continue;
				const cells = rooms.filter(p => p.room === q.room).flatMap(p => cellsIn(ras, p));
				if (cells.length === 0) {
					fail("EDI-08", `${b.tags} #${b.id}: the ${q.kind} has no free floor for a body`, cx(q), cy(q));
					seen.add(q.room);
					continue;
				}
				if (!cells.some(k => dist[k] < Infinity)) {
					fail("EDI-08", `${b.tags} #${b.id}: the ${q.kind} cannot be reached from the ${o.main ? "main" : "secondary"} door`, cx(q), cy(q));
				}
				seen.add(q.room);
			}
			if (o.main) {
				for (const s of b.lootSpots ?? []) {
					const k = ras.idx(s.x, s.y);
					if (k < 0 || !(dist[k] < Infinity)) fail("EDI-03", `${b.tags} #${b.id}: loot spot not reachable`, s.x, s.y);
				}
			}
		}
		if ((b.lootSpots ?? []).length === 0) fail("EDI-03", `${b.tags} #${b.id}: no loot spot`, cx(b), cy(b));
		// EDI-11: no safe spot -- from the nearest reachable outside point, a walker (16) gets everywhere, fast
		const zr = buildingRaster(w, b, physics.ZOMBIE_RADIUS, 160);
		const starts = [];
		for (let k = 0; k < zr.cols * zr.rows; k++) {
			if (zr.inside[k] || zr.blocked[k]) continue;
			const px = (k % zr.cols) * zr.C + zr.x0 + zr.C / 2;
			const py = Math.floor(k / zr.cols) * zr.C + zr.y0 + zr.C / 2;
			if (reach.at(px, py).reached) starts.push(k);
		}
		const zd = pathField(zr, starts, () => true);
		const seenZ = new Set();
		for (const q of rooms) {
			if (seenZ.has(q.room)) continue;
			seenZ.add(q.room);
			const cells = rooms.filter(p => p.room === q.room).flatMap(p => cellsIn(zr, p));
			let far = 0;
			for (const k of cells) {
				if (!(zd[k] < Infinity)) {
					far = Infinity;
					break;
				}
				far = Math.max(far, zd[k]);
			}
			const s = far / WALKER_SPEED;
			if (s > worst.s) worst = { s, b, room: q.kind };
			if (far === Infinity) {
				fail("EDI-11", `${b.tags} #${b.id}: a spot of the ${q.kind} no walker can reach (a safe spot)`, cx(q), cy(q));
			} else if (s > REACH_BOUND_S) {
				fail("EDI-11", `${b.tags} #${b.id}: the ${q.kind} is ${s.toFixed(1)} s from outside for a walker (> ${REACH_BOUND_S})`, cx(q), cy(q));
			}
		}
	}
	for (const [t, tt] of Object.entries(byType)) {
		const share = tt.target / tt.n;
		if (share < DOOR_SHARE) {
			fail("EDI-09", `${TYPE_TAG[t]}: only ${(share * 100).toFixed(0)}% have their ${DOOR_TARGET[t]} doors (< ${DOOR_SHARE * 100}%)`, 0, 0);
		}
	}
	if (buildings.length > 0 && compound / buildings.length < 0.5) {
		fail("EDI-14", `only ${compound}/${buildings.length} footprints are not a plain box (< 50%)`, 0, 0);
	}
	stats.compound = compound;
	stats.worstReach = worst.s;
	stats.worstRoom = worst.b ? `${worst.b.tags} #${worst.b.id} ${worst.room}` : "-";
	stats.doorsByType = Object.fromEntries(
		Object.entries(byType).map(([t, tt]) => [TYPE_TAG[t], `${(tt.doors / tt.n).toFixed(1)}d/${(tt.windows / tt.n).toFixed(1)}w`]),
	);
}

/** gameLoop.findSpawnPoint, replayed with a seeded Math.random */
function spawnPoints(w, n) {
	const out = [];
	const cxw = w.width / 2;
	const cyw = w.height / 2;
	for (let k = 0; k < n; k++) {
		let found;
		for (let i = 0; i < 200 && !found; i++) {
			const p = W.randomOpenPoint(w, cxw - 1400, cyw - 1400, cxw + 1400, cyw + 1400);
			if (
				W.isOnRoad(w, p.x, p.y) &&
				W.buildingAt(w, p.x, p.y) === undefined &&
				W.rectHitsSolid(w, p.x, p.y, 80, 80) === undefined
			) {
				found = p;
			}
		}
		out.push(found ?? W.randomOpenPoint(w, cxw - 800, cyw - 800, cxw + 800, cyw + 800));
	}
	return out;
}

// ---------------------------------------------------------------- loot categories (EDI-03)

const itemName = (kind, index) =>
	(kind === 3 ? USABLES[index]?.name : kind === 4 ? ETC_ITEMS[index]?.name : undefined) ?? "";
const CATEGORY = {
	medical: /first aid|pain killer|bandage|adrenaline|sedative/i,
	ammo: /ammo|gunpowder/i,
	food: /bread|canned|meat|potato|pizza|meal|mushroom|apple|berry|soup/i,
	oil: /^oil$/i,
	cloth: /cloth|leather/i,
};
const REQUIRED = { 4: "medical", 6: "medical", 9: "ammo", 7: "food", 8: "food", 11: "food", 5: "oil", 10: "cloth" };

function emblemTypes() {
	// the town's drawing moved out of the game loop into client/view/worldView.ts (the run and the menus' flyover
	// share it, DESIGN_RULES UI-10); an older checkout still has it in gameLoop.ts
	const moved = join(SRC, "client/view/worldView.ts");
	const f = existsSync(moved) ? moved : join(SRC, "client/gameLoop.ts");
	if (!existsSync(f)) return undefined;
	const src = readFileSync(f, "utf8");
	// the method definition (not the call in drawBuilding), up to its closing brace
	const def = /drawEmblem\([^)]*\)\s*:\s*void\s*\{/.exec(src);
	if (!def) return undefined;
	const body = src.slice(def.index, src.indexOf("\n\t}\n", def.index));
	return new Set([...body.matchAll(/bt === (\d+)/g)].map(m => Number(m[1])));
}

// ---------------------------------------------------------------- the checks

function validate(seed) {
	const t0 = performance.now();
	const w = W.generateTown(seed);
	const genMs = performance.now() - t0;
	const fails = [];
	const fail = (rule, msg, x, y) => fails.push({ rule, msg, x: Math.round(x), y: Math.round(y), seed });
	const S = w.solids;
	const buildings = S.filter(s => s.kind === "building");
	const trees = S.filter(s => s.kind === "tree");
	const cars = S.filter(s => s.tags === "car");
	const trash = S.filter(s => s.tags === "trash");
	const pumps = S.filter(s => s.tags === "pump");
	const juncs = junctionsOf(w);
	const crossings = w.crossings ?? [];
	const medians = w.roads.flatMap(r => r.medians ?? []);
	const allEdges = [];
	for (const lot of w.lots) for (const e of lotEdges(w, lot)) allEdges.push({ lot, e });
	const bandOf = e => edgeRect(e, e.a, e.b, 0, SW);
	const vergeOf = e => edgeRect(e, e.a, e.b, 0, VERGE);
	const clearOf = e => edgeRect(e, e.a, e.b, VERGE, SW);
	const parkingLots = w.lots.flatMap(l => (l.ground ?? []).filter(g => g.kind === "parking"));
	const drives = w.lots.flatMap(l => (l.ground ?? []).filter(g => g.kind === "drive" || g.kind === "apron"));
	const onCarriageway = r => w.roads.some(road => overlap(r, road)) && !medians.some(m => inside(r, m));

	// door approach per building: the corridor from the door to the curb, and the curb in front of it
	const doors = [];
	for (const b of buildings) {
		const n = NORMAL[b.doorSide];
		let reach;
		for (let d = 0; d <= 1200; d += 4) {
			if (W.isOnRoad(w, b.doorX + n[0] * d, b.doorY + n[1] * d)) {
				reach = d;
				break;
			}
		}
		const half = TOWN.DOOR_W / 2 + 24;
		let corridor;
		if (reach !== undefined) {
			const x0 = Math.min(b.doorX, b.doorX + n[0] * reach);
			const y0 = Math.min(b.doorY, b.doorY + n[1] * reach);
			corridor =
				n[0] === 0
					? { x: b.doorX - half, y: y0, w: half * 2, h: Math.abs(n[1] * reach) }
					: { x: x0, y: b.doorY - half, w: Math.abs(n[0] * reach), h: half * 2 };
		}
		doors.push({ b, n, reach, corridor });
	}

	// --- INT-01 (generator integrity): no overlapping blocking solids, spatial grid in sync,
	// every building = passable record + 5 wall segments inside its footprint
	for (const a of S) {
		if (!W.isBlocking(a)) continue;
		for (const b of W.querySolids(w, a.x, a.y, a.x + a.w, a.y + a.h)) {
			if (b.id <= a.id || !W.isBlocking(b) || !overlap(a, b)) continue;
			fail("INT-01", `${a.kind}/${a.tags} #${a.id} overlaps ${b.kind}/${b.tags} #${b.id}`, cx(a), cy(a));
		}
		if (!W.querySolids(w, a.x + 1, a.y + 1, a.x + 2, a.y + 2).includes(a)) {
			fail("INT-01", `spatial grid misses #${a.id}`, cx(a), cy(a));
		}
	}
	// a building is its record + walls (outside walls and partitions), windows and furniture, all inside the
	// footprint: the union of its parts, which tile the record's box without overlapping (EDI-14)
	const partsOf = b => b.parts ?? [b];
	const inFootprint = (b, r) => {
		// every corner (pulled 0.5 in) inside some part: a piece may straddle two parts, never the outside
		for (const [px, py] of [
			[r.x + 0.5, r.y + 0.5],
			[r.x + r.w - 0.5, r.y + 0.5],
			[r.x + 0.5, r.y + r.h - 0.5],
			[r.x + r.w - 0.5, r.y + r.h - 0.5],
		]) {
			if (!partsOf(b).some(p => px >= p.x && px <= p.x + p.w && py >= p.y && py <= p.y + p.h)) return false;
		}
		return true;
	};
	const kidsOf = new Map();
	for (const s of S) if (s.parentId !== undefined) kidsOf.set(s.parentId, [...(kidsOf.get(s.parentId) ?? []), s]);
	for (const b of buildings) {
		const kids = kidsOf.get(b.id) ?? [];
		const ws = kids.filter(s => s.tags === "bwall");
		if (ws.length < 4) fail("INT-01", `${b.tags} #${b.id} has ${ws.length} wall segments (< 4)`, cx(b), cy(b));
		for (const x of kids) {
			if (!inside(x, b) || !inFootprint(b, x)) {
				fail("INT-01", `${x.kind}/${x.tags} #${x.id} outside ${b.tags} #${b.id}'s footprint`, cx(x), cy(x));
			}
		}
		const parts = partsOf(b);
		let area = 0;
		for (let i = 0; i < parts.length; i++) {
			area += parts[i].w * parts[i].h;
			if (!inside(parts[i], b)) fail("EDI-14", `${b.tags} #${b.id}: a part leaves its box`, cx(b), cy(b));
			for (let k = i + 1; k < parts.length; k++) {
				if (overlap(parts[i], parts[k])) fail("EDI-14", `${b.tags} #${b.id}: two parts overlap`, cx(b), cy(b));
			}
		}
		if (area > b.w * b.h + 1) fail("EDI-14", `${b.tags} #${b.id}: parts larger than the box`, cx(b), cy(b));
		const mid = b.mainWing ?? parts[0];
		if (W.buildingAt(w, cx(mid), cy(mid)) !== b) {
			fail("INT-01", `buildingAt misses ${b.tags} #${b.id}`, cx(mid), cy(mid));
		}
	}

	// boss plazas keep their BOSS_CLEAR radius free of anything solid
	for (const a of w.bossAnchors) {
		const R = TOWN.BOSS_CLEAR;
		for (const s of W.querySolids(w, a.x - R, a.y - R, a.x + R, a.y + R)) {
			if (s.tags === "border" || ptRectDist(a.x, a.y, s) >= R - 1) continue;
			fail("INT-01", `boss ${a.type} plaza (r ${R}) holds ${s.kind}/${s.tags} #${s.id}`, cx(s), cy(s));
		}
	}

	// --- CID-01: continuous clear path on every sidewalk (a body of radius 18 walks it end to end)
	const mid = (VERGE + SW) / 2;
	for (const { e } of allEdges) {
		let last = -1e9;
		for (let u = e.a + BODY_R; u <= e.b - BODY_R; u += 8) {
			const p = alongX(e.side) ? { x: u, y: e.curb + e.inward * mid } : { x: e.curb + e.inward * mid, y: u };
			const hit = physics.circleBlocked(w, p.x, p.y, BODY_R);
			if (hit && u - last > 200) {
				fail("CID-01", `sidewalk clear path blocked by ${hit.kind}/${hit.tags} #${hit.id}`, p.x, p.y);
				last = u;
			}
		}
	}

	// --- CID-02 / VEG-01 / MOB-01: furniture on sidewalks only in the service strip
	for (const s of [...trees, ...trash]) {
		for (const { e } of allEdges) {
			if (!overlap(s, bandOf(e))) continue;
			if (inside(s, vergeOf(e))) continue;
			if (overlap(s, clearOf(e))) {
				if (s.kind === "tree") fail("VEG-01", `tree #${s.id} trunk in the sidewalk clear path`, cx(s), cy(s));
				else fail("CID-02", `bin #${s.id} in the sidewalk clear path (not in the service strip)`, cx(s), cy(s));
			} else {
				fail("CID-02", `${s.tags} #${s.id} straddles the sidewalk band`, cx(s), cy(s));
			}
		}
	}

	// --- CID-03: a crossing on every arm; nothing parked/planted within one car length of a corner
	for (const j of juncs) {
		const arms = [
			{ x: j.x, y: j.y - SW, w: j.w, h: SW },
			{ x: j.x, y: j.y + j.h, w: j.w, h: SW },
			{ x: j.x - SW, y: j.y, w: SW, h: j.h },
			{ x: j.x + j.w, y: j.y, w: SW, h: j.h },
		];
		for (const a of arms) {
			if (!w.roads.some(r => inside(a, r))) continue;
			if (!crossings.some(c => overlap(c, a) && c.w * c.h >= a.w * a.h * 0.6)) {
				fail("CID-03", "intersection arm without a zebra crossing", cx(a), cy(a));
			}
		}
	}
	const inParking = s => parkingLots.some(p => inside(s, p));
	for (const s of cars) {
		if (inParking(s)) continue;
		for (const j of juncs) {
			if (rectDist(s, j) < CORNER) {
				fail(
					"CID-03",
					`car #${s.id} parked ${fmt(rectDist(s, j))} u from an intersection (< ${CORNER})`,
					cx(s),
					cy(s),
				);
				break;
			}
		}
	}
	for (const s of trees) {
		for (const j of juncs) {
			const d = ptRectDist(cx(s), cy(s), j);
			if (d < CORNER) {
				fail("VEG-01", `tree #${s.id} ${fmt(d)} u from a street corner (< ${CORNER})`, cx(s), cy(s));
				break;
			}
		}
	}

	// --- CID-05 / APO-02: every street, yard and building reachable on foot from the spawn point
	const spawns = spawnPoints(w, 12);
	const reach = reachability(w, spawns[0]);
	for (const road of w.roads) {
		const v = isVertical(road);
		const lanes = road.avenue ? [0.18, 0.82] : [0.25, 0.75];
		for (const f of lanes) {
			let reported = false;
			for (
				let t = (v ? road.y : road.x) + 64;
				t < (v ? road.y + road.h : road.x + road.w) - 64 && !reported;
				t += 128
			) {
				const x = v ? road.x + road.w * f : t;
				const y = v ? t : road.y + road.h * f;
				const q = reach.at(x, y);
				if (!q.blocked && !q.reached) {
					fail("CID-05", "street unreachable from the spawn point (route cut off: APO-02)", x, y);
					reported = true;
				}
			}
		}
	}
	for (const lot of w.lots) {
		let reported = false;
		for (let y = lot.y + 32; y < lot.y + lot.h && !reported; y += 64) {
			for (let x = lot.x + 32; x < lot.x + lot.w && !reported; x += 64) {
				const q = reach.at(x, y);
				if (!q.blocked && !q.reached) {
					const b = W.buildingAt(w, x, y);
					fail(
						"CID-05",
						`sealed pocket${b ? ` inside ${b.tags} #${b.id}` : " in a lot"} (not reachable on foot)`,
						x,
						y,
					);
					reported = true;
				}
			}
		}
	}

	// --- EDI-01: door faces a street; a body walks from the curb through the doorway
	for (const d of doors) {
		const b = d.b;
		if (d.reach === undefined) {
			fail("EDI-01", `${b.tags} #${b.id}: door (${b.doorSide}) does not face a street`, b.doorX, b.doorY);
			continue;
		}
		for (let t = d.reach - BODY_R - 2; t >= -(TOWN.WALL_T / 2 + 72 - BODY_R); t -= 4) {
			const x = b.doorX + d.n[0] * t;
			const y = b.doorY + d.n[1] * t;
			const hit = physics.circleBlocked(w, x, y, BODY_R);
			if (hit) {
				fail("EDI-01", `${b.tags} #${b.id}: door approach blocked by ${hit.kind}/${hit.tags} #${hit.id}`, x, y);
				break;
			}
		}
		// the game's own physics: walk in from 150 u outside the door until a body is past the wall (a house with a
		// back door straight behind the front one lets you walk on out of the other side: that is a way through)
		let px = b.doorX + d.n[0] * 150;
		let py = b.doorY + d.n[1] * 150;
		let walkedIn = false;
		for (let i = 0; i < 120 && !walkedIn; i++) {
			const m = physics.moveActor(w, px, py, BODY_R, -d.n[0] * 5, -d.n[1] * 5);
			px = m.x;
			py = m.y;
			const deep = (px - b.doorX) * -d.n[0] + (py - b.doorY) * -d.n[1];
			if (deep > TOWN.WALL_T / 2 + BODY_R + 8 && W.buildingAt(w, px, py) === b) walkedIn = true;
		}
		if (!walkedIn) {
			fail("EDI-01", `${b.tags} #${b.id}: moveActor cannot walk in through the door`, b.doorX, b.doorY);
		}
		if (!reach.at(cx(b), cy(b)).reached && !reach.at(b.doorX - d.n[0] * 48, b.doorY - d.n[1] * 48).reached) {
			fail("EDI-01", `${b.tags} #${b.id}: interior not reachable from the spawn point`, cx(b), cy(b));
		}
	}

	// --- EDI-02: setback by type; gas on a corner with an open forecourt; civic with yard/parking
	for (const d of doors) {
		const b = d.b;
		if (d.reach === undefined) continue;
		// the setback is the street FACE's (the box's edge); a door recessed into a porch or a courtyard sits deeper
		const T2 = TOWN.WALL_T / 2;
		const recess = {
			top: b.doorY - T2 - b.y,
			bottom: b.y + b.h - (b.doorY + T2),
			left: b.doorX - T2 - b.x,
			right: b.x + b.w - (b.doorX + T2),
		}[b.doorSide];
		const front = d.reach - TOWN.WALL_T / 2 - SW - recess;
		const t = b.buildingType;
		if ((t === 1 || t === 2) && recess > 200) {
			fail("EDI-02", `house #${b.id}: door ${fmt(recess)} u deep in its porch (> 200)`, b.doorX, b.doorY);
		}
		const lot = w.lots.find(l => b.x >= l.x && b.x < l.x + l.w && b.y >= l.y && b.y < l.y + l.h);
		if (
			(t === 1 || t === 2) &&
			(front < (TOWN.SETBACK_HOUSE_MIN ?? 96) - 8 || front > (TOWN.SETBACK_HOUSE_MAX ?? 200) + 8)
		) {
			fail(
				"EDI-02",
				`house #${b.id}: front yard ${fmt(front)} u (expected ${TOWN.SETBACK_HOUSE_MIN}–${TOWN.SETBACK_HOUSE_MAX})`,
				b.doorX,
				b.doorY,
			);
		}
		if (SHOPS.includes(t) && front > (TOWN.SETBACK_SHOP_MAX ?? 32) + 8) {
			fail(
				"EDI-02",
				`${b.tags} #${b.id}: shop ${fmt(front)} u behind the sidewalk (should stand at it)`,
				b.doorX,
				b.doorY,
			);
		}
		if (t === 5) {
			if (front < (TOWN.FORECOURT ?? 280) - 8) {
				fail("EDI-02", `gas #${b.id}: forecourt only ${fmt(front)} u deep`, b.doorX, b.doorY);
			}
			const edges = lot ? lotEdges(w, lot) : [];
			const nearStreets = edges.filter(e => {
				const r = edgeRect(e, e.a, e.b, 0, SW + (TOWN.FORECOURT ?? 320) + 16);
				return overlap(r, b) || rectDist(r, b) < 96;
			});
			if (nearStreets.length < 2 || !edges.some(e => !alongX(e.side)) || !edges.some(e => alongX(e.side))) {
				fail("EDI-02", `gas #${b.id}: not on a street corner`, cx(b), cy(b));
			}
			const court =
				d.n[0] === 0
					? { x: b.x, y: Math.min(b.y, b.y + d.n[1] * front) + (d.n[1] > 0 ? b.h : 0), w: b.w, h: front }
					: { x: Math.min(b.x, b.x + d.n[0] * front) + (d.n[0] > 0 ? b.w : 0), y: b.y, w: front, h: b.h };
			const stuff = W.querySolids(
				w,
				court.x + 1,
				court.y + 1,
				court.x + court.w - 1,
				court.y + court.h - 1,
			).filter(s => W.isBlocking(s) && s.tags !== "pump" && s.parentId !== b.id);
			if (stuff.length > 0) {
				fail(
					"EDI-02",
					`gas #${b.id}: forecourt obstructed by ${stuff[0].kind}/${stuff[0].tags}`,
					cx(stuff[0]),
					cy(stuff[0]),
				);
			}
			if (!pumps.some(p => overlap(p, court))) {
				fail("EDI-02", `gas #${b.id}: no pump island on the forecourt`, cx(court), cy(court));
			}
		}
		if (t === 3 || t === 4) {
			if (b.w * b.h < 700000) {
				fail("EDI-02", `${b.tags} #${b.id}: too small for a civic building (${b.w}×${b.h})`, cx(b), cy(b));
			}
			const yardish = (lot?.ground ?? []).filter(
				g => g.kind === "playground" || g.kind === "parking" || g.kind === "apron",
			);
			if (!yardish.some(g => g.w * g.h >= 60000)) {
				fail("EDI-02", `${b.tags} #${b.id}: no school yard / parking lot on its lot`, cx(b), cy(b));
			}
		}
	}

	// --- EDI-03: type ↔ tag ↔ loot table ↔ roof colour ↔ rooftop emblem
	const emblems = emblemTypes();
	const roofByType = new Map();
	for (const b of buildings) {
		const t = b.buildingType;
		if (TYPE_TAG[t] !== b.tags) {
			fail("EDI-03", `building #${b.id}: type ${t} tagged "${b.tags}" (expected "${TYPE_TAG[t]}")`, cx(b), cy(b));
		}
		const table = BUILDING_SPAWNS[t];
		if (!table) {
			fail("EDI-03", `building #${b.id}: no loot table for type ${t}`, cx(b), cy(b));
		} else if (REQUIRED[t] && !table.some(e => CATEGORY[REQUIRED[t]].test(itemName(e.kind, e.index)))) {
			fail("EDI-03", `${b.tags} #${b.id}: loot table has no ${REQUIRED[t]}`, cx(b), cy(b));
		}
		if (t >= 3 && b.roofColor) {
			const key = `${b.roofColor.R.toFixed(3)},${b.roofColor.G.toFixed(3)},${b.roofColor.B.toFixed(3)}`;
			if (roofByType.has(t) && roofByType.get(t) !== key) {
				fail("EDI-03", `${b.tags} #${b.id}: roof colour differs from other ${b.tags}s`, cx(b), cy(b));
			}
			roofByType.set(t, key);
		}
		if (emblems && t >= 3 && !emblems.has(t)) {
			fail("EDI-03", `${b.tags} (type ${t}) has no rooftop emblem in worldView.drawEmblem`, cx(b), cy(b));
		}
	}
	const seenRoof = new Map();
	for (const [t, key] of roofByType) {
		const other = seenRoof.get(key);
		if (other !== undefined && !(TYPE_TAG[other] === "market" && TYPE_TAG[t] === "market")) {
			fail("EDI-03", `types ${other} and ${t} share a roof colour`, 0, 0);
		}
		seenRoof.set(key, t);
	}

	// --- EDI-05: buildings off sidewalks and roads, alleys of at least BUILDING_GAP
	for (const b of buildings) {
		if (w.roads.some(r => overlap(b, r))) fail("EDI-05", `${b.tags} #${b.id} on a road`, cx(b), cy(b));
		for (const { e } of allEdges) {
			if (overlap(b, bandOf(e))) fail("EDI-05", `${b.tags} #${b.id} on the sidewalk`, cx(b), cy(b));
		}
		for (const o of W.querySolids(
			w,
			b.x - TOWN.BUILDING_GAP,
			b.y - TOWN.BUILDING_GAP,
			b.x + b.w + TOWN.BUILDING_GAP,
			b.y + b.h + TOWN.BUILDING_GAP,
		)) {
			if (o.kind !== "building" || o.id <= b.id) continue;
			const d = rectDist(b, o);
			if (d < TOWN.BUILDING_GAP - 0.01) {
				fail(
					"EDI-05",
					`${b.tags} #${b.id} and ${o.tags} #${o.id}: alley ${fmt(d)} u (< ${TOWN.BUILDING_GAP})`,
					cx(b),
					cy(b),
				);
			}
		}
	}

	// --- EDI-08..EDI-14: interiors, entrances, windows, furniture, no safe spot
	const interior = {};
	interiorChecks(w, buildings, kidsOf, reach, fail, interior);

	// --- VEG-01 (rest): trunk on a carriageway, in front of a door or on a driveway
	for (const s of trees) {
		if (onCarriageway(s)) fail("VEG-01", `tree #${s.id} on the carriageway`, cx(s), cy(s));
		for (const d of doors) {
			if (d.corridor && overlap(s, d.corridor)) {
				fail("VEG-01", `tree #${s.id} in front of ${d.b.tags} #${d.b.id}'s door`, cx(s), cy(s));
			}
		}
		for (const g of drives) {
			if (overlap(s, g)) fail("VEG-01", `tree #${s.id} on a driveway/forecourt`, cx(s), cy(s));
		}
	}

	// --- VEG-02: street trees in the service strip / median, aligned, regularly spaced
	const groups = new Map();
	for (const s of trees) {
		const m = medians.find(q => inside(s, q));
		if (m) {
			const key = `m${m.x},${m.y}`;
			const v = m.w < m.h;
			const off = v ? Math.abs(cx(s) - cx(m)) : Math.abs(cy(s) - cy(m));
			if (off > 2) fail("VEG-02", `median tree #${s.id} off the median axis by ${fmt(off)} u`, cx(s), cy(s));
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(v ? cy(s) : cx(s));
			continue;
		}
		for (const { e } of allEdges) {
			if (!inside(s, vergeOf(e))) continue;
			const uv = edgeUV(e, cx(s), cy(s));
			if (Math.abs(uv.v - VERGE / 2) > 2) {
				fail("VEG-02", `street tree #${s.id} not on the pit line (${fmt(uv.v)} u from the curb)`, cx(s), cy(s));
			}
			const key = `${e.side}${e.curb},${e.a}`;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(uv.u);
		}
	}
	let streetTrees = 0;
	for (const [key, us] of groups) {
		streetTrees += us.length;
		if (us.length < 2) continue;
		us.sort((a, b) => a - b);
		const gaps = us.slice(1).map((u, i) => u - us[i]);
		// one pitch in [440, 660] must explain every gap (an empty pit = a multiple of it)
		const minGap = Math.min(...gaps);
		const multipleOf = p => gaps.every(gp => Math.abs(gp / p - Math.round(gp / p)) <= 0.03);
		let pitch;
		for (let k = 1; k <= 6 && pitch === undefined; k++) {
			const p = minGap / k;
			if (p >= PITCH_MIN && p <= PITCH_MAX && multipleOf(p)) pitch = p;
		}
		if (minGap < PITCH_MIN) {
			fail("VEG-02", `street trees only ${fmt(minGap)} u apart (< ${PITCH_MIN}) [${key}]`, 0, 0);
		} else if (pitch === undefined) {
			fail("VEG-02", `irregular street-tree spacing (gaps ${gaps.map(fmt).join(", ")}) [${key}]`, 0, 0);
		}
	}

	// --- VEG-04 / COL-02: only the trunk collides; roofs, canopies and ground marks never do
	for (const s of trees) {
		if (s.w > SCALE.trunk * (1 + TOL) || s.h > SCALE.trunk * (1 + TOL)) {
			fail("VEG-04", `tree #${s.id} collides ${s.w}×${s.h} (trunk only)`, cx(s), cy(s));
		}
		if (!(s.canopyR > 0)) fail("VEG-04", `tree #${s.id} without a canopy`, cx(s), cy(s));
	}
	for (const b of buildings) {
		if (b.passable !== true) fail("COL-02", `${b.tags} #${b.id}: footprint/roof record collides`, cx(b), cy(b));
	}
	for (const m of medians) {
		for (const s of W.querySolids(w, m.x, m.y, m.x + m.w, m.y + m.h)) {
			if (s.kind !== "tree" && overlap(s, m)) {
				fail("COL-02", `${s.kind}/${s.tags} #${s.id} on a median`, cx(s), cy(s));
			}
		}
	}

	// --- VEI-01 / VEI-02 / VEI-03: cars
	const parked = [];
	const abandoned = [];
	for (const s of cars) {
		if (inParking(s)) continue;
		const road = w.roads.find(r => inside(s, r));
		if (!road) {
			fail("VEI-02", `car #${s.id} off the road (sidewalk/yard)`, cx(s), cy(s));
			continue;
		}
		const v = isVertical(road);
		const long = v ? s.h : s.w;
		const lo = v ? s.x - road.x : s.y - road.y;
		const hi = v ? road.x + road.w - (s.x + s.w) : road.y + road.h - (s.y + s.h);
		const gap = TOWN.CURB_GAP ?? 12;
		const atLow = Math.abs(lo - gap) <= 8;
		const atHigh = Math.abs(hi - gap) <= 8;
		// parked = against a curb and aligned with the road; anything else stopped in a lane is abandoned
		const axis = v ? Math.PI / 2 : 0;
		const aligned =
			s.heading === undefined || angDiff(s.heading, axis) < 0.05 || angDiff(s.heading, axis + Math.PI) < 0.05;
		if ((atLow || atHigh) && aligned && long >= s.w + s.h - long) {
			const want = v ? (atHigh ? -Math.PI / 2 : Math.PI / 2) : atHigh ? 0 : Math.PI;
			if (s.heading === undefined) {
				fail("VEI-01", `car #${s.id} has no heading (direction of traffic unknown)`, cx(s), cy(s));
			} else if (angDiff(s.heading, want) > 0.05) {
				fail("VEI-01", `car #${s.id} parked against the traffic (right-hand)`, cx(s), cy(s));
			}
			parked.push({ s, road, high: atHigh });
		} else {
			abandoned.push({ s, road });
		}
		for (const j of juncs) if (overlap(s, j)) fail("VEI-02", `car #${s.id} in an intersection`, cx(s), cy(s));
		for (const c of crossings) if (overlap(s, c)) fail("VEI-02", `car #${s.id} on a zebra crossing`, cx(s), cy(s));
		for (const d of doors) {
			if (!d.corridor || d.reach === undefined) continue;
			const n = d.n;
			const curbX = d.b.doorX + n[0] * d.reach;
			const curbY = d.b.doorY + n[1] * d.reach;
			const depth = gap + TOWN.CAR_W;
			const zone =
				n[0] === 0
					? { x: d.b.doorX - 100, y: n[1] > 0 ? curbY : curbY - depth, w: 200, h: depth }
					: { x: n[0] > 0 ? curbX : curbX - depth, y: d.b.doorY - 100, w: depth, h: 200 };
			if (overlap(s, zone)) {
				fail("VEI-02", `car #${s.id} parked in front of ${d.b.tags} #${d.b.id}'s door`, cx(s), cy(s));
			}
		}
	}
	// spacing between parked cars on the same curb
	for (let i = 0; i < parked.length; i++) {
		for (let k = i + 1; k < parked.length; k++) {
			const a = parked[i];
			const b = parked[k];
			if (a.road !== b.road || a.high !== b.high) continue;
			const d = rectDist(a.s, b.s);
			if (d < 40) {
				fail(
					"VEI-01",
					`cars #${a.s.id} and #${b.s.id} parked ${fmt(d)} u apart (no stall gap)`,
					cx(a.s),
					cy(a.s),
				);
			}
		}
	}
	const streetCars = parked.length + abandoned.length;
	if (streetCars > 0 && abandoned.length / streetCars > 0.15) {
		fail("VEI-03", `${abandoned.length}/${streetCars} street cars are abandoned in the lanes (> 15%)`, 0, 0);
	}
	for (const { s } of abandoned) {
		if (s.heading === undefined) fail("VEI-03", `abandoned car #${s.id} without a heading`, cx(s), cy(s));
	}
	// one lane always free across every carriageway
	for (const road of w.roads) {
		const v = isVertical(road);
		const ms = road.medians ?? [];
		const t0 = v ? road.y : road.x;
		const t1 = v ? road.y + road.h : road.x + road.w;
		const q = W.querySolids(w, road.x, road.y, road.x + road.w, road.y + road.h).filter(
			s => W.isBlocking(s) && overlap(s, road),
		);
		let reported = false;
		for (let t = t0; t < t1 && !reported; t += 16) {
			if (juncs.some(j => (v ? t >= j.y && t <= j.y + j.h : t >= j.x && t <= j.x + j.w) && overlap(j, road))) {
				continue;
			}
			const base = v ? road.x : road.y;
			const size = v ? road.w : road.h;
			const med = ms.find(m => (v ? t >= m.y && t <= m.y + m.h : t >= m.x && t <= m.x + m.w));
			const carriages = med
				? [
						[base, v ? med.x : med.y],
						[v ? med.x + med.w : med.y + med.h, base + size],
					]
				: [[base, base + size]];
			for (const [c0, c1] of carriages) {
				const spans = [];
				for (const s of q) {
					if (v ? t < s.y || t > s.y + s.h : t < s.x || t > s.x + s.w) continue;
					const a = v ? s.x : s.y;
					const b = v ? s.x + s.w : s.y + s.h;
					if (b > c0 && a < c1) spans.push([Math.max(a, c0), Math.min(b, c1)]);
				}
				spans.sort((p, r) => p[0] - r[0]);
				let best = 0;
				let at = c0;
				for (const sp of spans) {
					if (sp[0] > at) best = Math.max(best, sp[0] - at);
					at = Math.max(at, sp[1]);
				}
				best = Math.max(best, c1 - at);
				if (best < LANE_FREE && !reported) {
					fail(
						"VEI-03",
						`road blocked: only ${fmt(best)} u free across the carriageway (< ${LANE_FREE})`,
						v ? (c0 + c1) / 2 : t,
						v ? t : (c0 + c1) / 2,
					);
					reported = true;
				}
			}
		}
	}

	// --- MOB-01: bins at the curb near an entrance, or behind/between buildings
	for (const s of trash) {
		let ok = false;
		// (a) in the service strip, within 400 u of a door that opens onto the same sidewalk
		for (const { e } of allEdges) {
			if (!inside(s, vergeOf(e))) continue;
			const bin = edgeUV(e, cx(s), cy(s));
			for (const d of doors) {
				if (d.b.doorSide !== e.side) continue;
				const door = edgeUV(e, d.b.doorX, d.b.doorY);
				if (
					door.u >= e.a &&
					door.u <= e.b &&
					door.v > SW &&
					door.v < SW + 480 &&
					Math.abs(door.u - bin.u) <= 400
				) {
					ok = true;
				}
			}
		}
		// (b) against a building wall other than its door wall (back of the lot, alley)
		if (!ok) {
			for (const b of buildings) {
				const d = rectDist(s, b);
				if (d > 24) continue;
				const doorWall = {
					top: { x: b.x, y: b.y - 40, w: b.w, h: 40 },
					bottom: { x: b.x, y: b.y + b.h, w: b.w, h: 40 },
					left: { x: b.x - 40, y: b.y, w: 40, h: b.h },
					right: { x: b.x + b.w, y: b.y, w: 40, h: b.h },
				}[b.doorSide];
				if (!overlap(s, doorWall)) ok = true;
			}
		}
		if (!ok) {
			fail("MOB-01", `bin #${s.id} neither at the curb near an entrance nor behind a building`, cx(s), cy(s));
		}
		for (const d of doors) {
			if (d.corridor && overlap(s, d.corridor)) {
				fail("MOB-01", `bin #${s.id} in front of ${d.b.tags} #${d.b.id}'s door`, cx(s), cy(s));
			}
		}
	}

	// --- ESC-01: proportions against the scale table (±30%)
	const within = (v, ref) => v >= ref * (1 - TOL) && v <= ref * (1 + TOL);
	for (const s of trees) {
		if (!within(s.w, SCALE.trunk)) fail("ESC-01", `tree #${s.id} trunk ${s.w} u`, cx(s), cy(s));
		const d = (s.canopyR ?? 0) * 2;
		if (d < SCALE.canopyMin * (1 - TOL) || d > SCALE.canopyMax * (1 + TOL)) {
			fail("ESC-01", `tree #${s.id} canopy ${fmt(d)} u`, cx(s), cy(s));
		}
	}
	for (const s of cars) {
		const long = Math.max(s.w, s.h);
		const short = Math.min(s.w, s.h);
		if (!within(long, SCALE.carL) || !within(short, SCALE.carW)) {
			fail("ESC-01", `car #${s.id} ${s.w}×${s.h} u`, cx(s), cy(s));
		}
	}
	for (const s of trash) {
		if (!within(s.w, SCALE.trash) || !within(s.h, SCALE.trash)) {
			fail("ESC-01", `bin #${s.id} ${s.w}×${s.h} u`, cx(s), cy(s));
		}
	}
	if (TOWN.DOOR_W !== SCALE.door) fail("ESC-01", `door ${TOWN.DOOR_W} u (ESC-02 exception is ${SCALE.door})`, 0, 0);
	if (!within(TOWN.ROAD_W, SCALE.street)) fail("ESC-01", `street ${TOWN.ROAD_W} u wide`, 0, 0);
	if (!within(SW, SCALE.sidewalk)) fail("ESC-01", `sidewalk ${SW} u wide`, 0, 0);

	// --- COL-03: the player never spawns inside a solid; open-point helper keeps its promise
	for (const p of spawns) {
		const hit = physics.circleBlocked(w, p.x, p.y, BODY_R);
		if (hit) fail("COL-03", `player spawn inside ${hit.kind}/${hit.tags} #${hit.id}`, p.x, p.y);
		if (W.buildingAt(w, p.x, p.y)) fail("COL-03", "player spawn inside a building", p.x, p.y);
	}
	for (let i = 0; i < 40; i++) {
		const x0 = 800 + Math.random() * (w.width - 3000);
		const y0 = 800 + Math.random() * (w.height - 3000);
		const p = W.randomOpenPoint(w, x0, y0, x0 + 1200, y0 + 1200);
		if (W.pointInSolid(w, p.x, p.y, 0)) fail("COL-03", "randomOpenPoint returned a point inside a solid", p.x, p.y);
	}

	const ms = performance.now() - t0;
	const types = {};
	for (const b of buildings) types[b.tags] = (types[b.tags] ?? 0) + 1;
	const stats = {
		genMs,
		ms,
		solids: S.length,
		buildings: buildings.length,
		types,
		trees: trees.length,
		streetTrees,
		cars: cars.length,
		parked: parked.length,
		abandoned: abandoned.length,
		lotCars: cars.length - parked.length - abandoned.length,
		trash: trash.length,
		crossings: crossings.length,
		interior,
	};
	return { fails, stats };
}

// ---------------------------------------------------------------- run

let seedState = 12345;
Math.random = () => (seedState = (seedState * 48271) % 2147483647) / 2147483647;
const all = [];
let total = 0;
const t0 = performance.now();
for (const seed of seeds) {
	const { fails, stats } = validate(seed);
	all.push(...fails);
	total += fails.length;
	const byRule = new Map();
	for (const f of fails) {
		if (!byRule.has(f.rule)) byRule.set(f.rule, []);
		byRule.get(f.rule).push(f);
	}
	const tp = Object.entries(stats.types)
		.map(([k, v]) => `${k} ${v}`)
		.join(", ");
	console.log(
		`seed ${seed}: ${fails.length === 0 ? "OK" : `${fails.length} failure(s)`} | gen ${fmt(stats.genMs)} ms, checks ${fmt(stats.ms - stats.genMs)} ms | ` +
			`${stats.solids} solids, ${stats.buildings} buildings (${tp}) | trees ${stats.trees} (street ${stats.streetTrees}) | ` +
			`cars ${stats.cars} (parked ${stats.parked}, abandoned ${stats.abandoned}, in lots ${stats.lotCars}) | bins ${stats.trash} | crossings ${stats.crossings}`,
	);
	const it = stats.interior;
	console.log(
		`  interiors: ${it.compound}/${stats.buildings} footprints not a box | worst walker reach ${it.worstReach.toFixed(1)} s (${it.worstRoom}) | doors/windows per building: ` +
			Object.entries(it.doorsByType)
				.map(([k, v]) => `${k} ${v}`)
				.join(", "),
	);
	for (const [rule, list] of [...byRule].sort((a, b) => a[0].localeCompare(b[0]))) {
		console.log(`  ${rule}: ${list.length}`);
		for (const f of SHOW_ALL ? list : list.slice(0, PER_RULE)) {
			console.log(`    ${f.rule} ${f.msg} at (${f.x},${f.y})`);
		}
		if (!SHOW_ALL && list.length > PER_RULE) console.log(`    … ${list.length - PER_RULE} more (--all)`);
	}
}
if (MARKS_FILE) writeFileSync(MARKS_FILE, JSON.stringify(all));
console.log(
	`${total === 0 ? "PASS" : "FAIL"}: ${seeds.length} seed(s), ${total} failure(s), ${fmt(performance.now() - t0)} ms`,
);
process.exit(total === 0 ? 0 : 1);
