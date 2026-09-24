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
/** the everyday town's layout module (EDI-18..EDI-22), on a checkout that has it */
const TL_FILE = join(SRC, "shared/game/townLots.ts");
const TL = existsSync(TL_FILE) ? require(TL_FILE) : undefined;
const physics = require(join(SRC, "shared/game/physics.ts"));
const SPAWNS = require(join(SRC, "shared/data/spawns.ts"));
const { BUILDING_SPAWNS, PUMP_LOOT } = SPAWNS;
/** the table a building type searches (spawns.ts `spawnRows`: the everyday town's types are in their own record) */
const spawnRows = t => (SPAWNS.spawnRows !== undefined ? SPAWNS.spawnRows(t) : BUILDING_SPAWNS[t]);
const { USABLES } = require(join(SRC, "shared/data/usables.ts"));
const { ETC_ITEMS } = require(join(SRC, "shared/data/etcItems.ts"));
/** the campus (EDI-17): its planner, when this checkout has one (an older one, through PZ_SRC, has no campus) */
const CAMPUS_MODULE = join(SRC, "shared/game/campus.ts");
const CAMPUS = existsSync(CAMPUS_MODULE) ? require(CAMPUS_MODULE) : undefined;

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const SHOW_ALL = args.includes("--all");
const marksIdx = args.indexOf("--marks");
const MARKS_FILE = marksIdx >= 0 ? args[marksIdx + 1] : undefined;
const sweepIdx = args.indexOf("--sweep");
const baseIdx = args.indexOf("--sweep-base");
const valueAt = new Set([marksIdx, sweepIdx, baseIdx].filter(i => i >= 0).map(i => i + 1));
const seeds = args.filter((a, i) => /^-?\d+$/.test(a) && !valueAt.has(i)).map(Number);
if (seeds.length === 0) seeds.push(DESIGN.TOWN_SEED, 1, 42, 99991, 123456);
/**
 * --sweep N: N more towns from seeds drawn the way server/sim/worldReset.ts draws them (any of 1 … 2^31 - 2), by a
 * MINSTD stream from --sweep-base (default 20260923): a world reset can land on any seed, so CI walks a spread of
 * them -- the same ones every run (a failure is reproducible: the seed is printed), another base for another spread.
 */
const SWEEP = sweepIdx >= 0 ? Number(args[sweepIdx + 1]) : 0;
if (SWEEP > 0) {
	let st = baseIdx >= 0 ? Number(args[baseIdx + 1]) % 2147483647 : 20260923;
	if (st <= 0) st = 1;
	for (let i = 0; i < SWEEP; i++) {
		st = (st * 48271) % 2147483647;
		seeds.push(st % 2147483646 || 1);
	}
}
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
	12: "college",
	13: "library",
	14: "lab",
	15: "dorm",
	// the everyday town (EDI-18)
	16: "hardware",
	17: "autorepair",
	18: "electronics",
	19: "bakery",
	20: "pawn",
	21: "postoffice",
	22: "bank",
	23: "church",
	24: "firestation",
	25: "police",
	26: "office",
};
/**
 * the buildings that stand at the sidewalk (EDI-02): the shops, and Main Street's offices and police station -- not
 * the bank, which stands back behind its steps (EDI-23)
 */
const SHOPS = [6, 7, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 25, 26];
/** the campus's four buildings (EDI-17): the main hall, the library, the science lab, the dorm */
const CAMPUS_TYPES = [12, 13, 14, 15];
const isCampus = t => CAMPUS_TYPES.includes(t);

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
const DOOR_TARGET = {
	1: 2,
	2: 2,
	3: 3,
	4: 3,
	5: 2,
	6: 2,
	7: 3,
	8: 2,
	9: 2,
	10: 2,
	11: 2,
	// the campus (EDI-17)
	12: 3,
	13: 2,
	14: 2,
	15: 2,
	// the everyday town (EDI-18): the front and a back or side door; the church a side door each way
	16: 2,
	17: 2,
	18: 2,
	19: 2,
	20: 2,
	21: 2,
	22: 2,
	23: 3,
	24: 2,
	25: 2,
	26: 2,
};
/**
 * share of a type's buildings that must reach DOOR_TARGET (a secondary door is dropped where the ground outside is
 * taken), over all the towns of a run: per town it is noise (3-9 pharmacies or gun shops a town)
 */
const DOOR_SHARE = 0.6;
/** type → buildings and those with all their doors, summed over every seed of the run */
const DOOR_RUN = {};
/** rooms that never get a window (EDI-10): a bathroom, a hall, the back rooms, the gun shop's secure room */
const NO_WINDOW = new Set([
	"bath",
	"hall",
	"stock",
	"cold",
	"secure",
	"corridor",
	"treatment",
	"galley",
	"chemstore",
	"foyer",
	// the everyday town's back rooms (EDI-18): a workshop or engine bay, a holding cell; the bank's vault (EDI-23)
	"garage",
	"cell",
	"vault",
]);
/** a secondary door's free ground: two bodies deep (shared/game/interiors.ts APPROACH_DEPTH), enough for an alley */
const APPROACH = 80;
/** walker speed (u/s): 3 px/frame at 30 fps, shared/data/zombies.ts */
const WALKER_SPEED = 90;
/**
 * EDI-11: the longest a walker takes, from the nearest outside point, to reach any spot of any room (climbing a
 * window counted at its real slowness). 12 s: under the ~13 s it takes the night's first wave to walk from its
 * spawn ring (720–1080 u, MP-09) to a survivor standing on the street, so hiding deep inside never buys more
 * than the walk across a yard.
 */
const REACH_BOUND_S = 12;

/** the piece(s) that say what a room is (EDI-08): a room of that kind without any of them fails */
const DEFINING = {
	living: ["sofa", "armchair"],
	kitchen: ["counter", "stove", "fridge"],
	dining: ["table"],
	bedroom: ["bed"],
	bath: ["toilet", "tub", "basin"],
	sales: ["shelf", "gondola", "gunrack", "clothesrack", "display", "coldcase", "checkout"],
	stock: ["rack"],
	cold: ["coldcase"],
	secure: ["safe", "gunrack"],
	office: ["desk"],
	classroom: ["schooldesk", "teacherdesk"],
	ward: ["hospbed"],
	treatment: ["optable"],
	diner: ["table", "booth"],
	galley: ["stove", "counter", "prep"],
	lobby: ["reception", "bench", "cabinet"],
	// the campus (EDI-17)
	lecture: ["seats"],
	stacks: ["bookcase"],
	reading: ["reception", "table"],
	lab: ["labbench", "fumehood"],
	chemstore: ["chemshelf"],
	dormroom: ["bunk"],
	common: ["sofa", "table", "tv"],
	// the everyday town (EDI-18): a nave its pews, a workshop or engine bay its racks, lockers or bench, a cell its bench
	nave: ["bench"],
	garage: ["rack", "lockers", "counter"],
	cell: ["bench", "toilet"],
	// the bank's vault (EDI-23): its deposit boxes are a container of their own, not a piece (checked by bankChecks)
	vault: [],
};

/**
 * The last stretch of a chase is a straight line, not the field (zombieBrain `chaseHeading`: DIRECT_CHASE =
 * 200 u with a clear segment); 160 u keeps a margin under it.
 */
const DIRECT_CHASE_MARGIN = 160;

/**
 * The horde's own view of a building (server/sim/flowField.ts, shared/game/physics.ts FlowField): 32 u cells on
 * the world grid, every blocking solid inflated by 4 u and HARD, a window's sill passable (stampWindow); from
 * every free cell outside the footprint, which cells can the field reach (8 neighbours, no corner cutting)?
 * `near(x, y)`: a zombie the field brought to a reached cell sees (x, y) down a clear line, close enough to
 * chase straight there.
 */
function fieldReach(w, b) {
	const CELL = 32;
	const INFLATE = 4;
	const M = 256;
	const ox = Math.floor((b.x - M) / CELL) * CELL;
	const oy = Math.floor((b.y - M) / CELL) * CELL;
	const cols = Math.ceil((b.x + b.w + M - ox) / CELL);
	const rows = Math.ceil((b.y + b.h + M - oy) / CELL);
	const size = Math.max(cols, rows);
	const HARD = 2;
	const grid = new Uint8Array(size * size);
	for (const s of W.querySolids(w, ox, oy, ox + size * CELL, oy + size * CELL)) {
		if (s.kind === "window") {
			physics.stampWindow(s, ox, oy, CELL, size, (gx, gy) => {
				if (grid[gy * size + gx] < 1) grid[gy * size + gx] = 1;
			});
			continue;
		}
		if (!W.isBlocking(s)) continue;
		const gx0 = Math.max(0, Math.floor((s.x - INFLATE - ox) / CELL));
		const gy0 = Math.max(0, Math.floor((s.y - INFLATE - oy) / CELL));
		const gx1 = Math.min(size - 1, Math.floor((s.x + s.w + INFLATE - ox) / CELL));
		const gy1 = Math.min(size - 1, Math.floor((s.y + s.h + INFLATE - oy) / CELL));
		for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) grid[gy * size + gx] = HARD;
	}
	const seen = new Uint8Array(size * size);
	const queue = [];
	for (let k = 0; k < size * size; k++) {
		if (grid[k] === HARD) continue;
		const x = ox + (k % size) * CELL + CELL / 2;
		const y = oy + Math.floor(k / size) * CELL + CELL / 2;
		if (W.buildingAt(w, x, y) === b) continue;
		seen[k] = 1;
		queue.push(k);
	}
	for (let head = 0; head < queue.length; head++) {
		const k = queue[head];
		const cx = k % size;
		const cy = (k - cx) / size;
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (dx === 0 && dy === 0) continue;
				const gx = cx + dx;
				const gy = cy + dy;
				if (gx < 0 || gy < 0 || gx >= size || gy >= size) continue;
				const nk = gy * size + gx;
				if (seen[nk] || grid[nk] === HARD) continue;
				if (dx !== 0 && dy !== 0 && (grid[cy * size + gx] === HARD || grid[gy * size + cx] === HARD)) continue;
				seen[nk] = 1;
				queue.push(nk);
			}
		}
	}
	return {
		cells: queue.length,
		near(x, y) {
			// a reached cell within DIRECT_CHASE_MARGIN, with a straight clear line from its centre to (x, y)
			const gx = Math.floor((x - ox) / CELL);
			const gy = Math.floor((y - oy) / CELL);
			const R = Math.ceil(DIRECT_CHASE_MARGIN / CELL);
			// ring by ring from the spot's own cell: the nearest reached cell is almost always the answer
			for (let ring = 0; ring <= R; ring++) {
				for (let dy = -ring; dy <= ring; dy++) {
					for (let dx = -ring; dx <= ring; dx++) {
						if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
						const ax = gx + dx;
						const ay = gy + dy;
						if (ax < 0 || ay < 0 || ax >= size || ay >= size || !seen[ay * size + ax]) continue;
						const px = ox + ax * CELL + CELL / 2;
						const py = oy + ay * CELL + CELL / 2;
						if (Math.hypot(px - x, py - y) > DIRECT_CHASE_MARGIN) continue;
						if (physics.segmentClear(w, px, py, x, y, physics.blocksMovement)) return true;
					}
				}
			}
			return false;
		},
	};
}

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
	let fieldCells = 0;
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
		if (doors.filter(o => o.main).length !== 1)
			fail("EDI-09", `${b.tags} #${b.id}: ${doors.filter(o => o.main).length} main doors`, cx(b), cy(b));
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
		// EDI-09: every door opens onto free ground (a body walks APPROACH u straight out) that the town reaches
		for (const o of doors) {
			const n = NORMAL[o.side];
			const ox = o.x + o.w / 2;
			const oy = o.y + o.h / 2;
			let blocked;
			for (let t2 = TOWN.WALL_T / 2 + BODY_R + 2; t2 <= TOWN.WALL_T / 2 + APPROACH - BODY_R; t2 += 6) {
				const hit = physics.circleBlocked(w, ox + n[0] * t2, oy + n[1] * t2, BODY_R);
				if (hit) {
					blocked = hit;
					break;
				}
			}
			if (blocked) {
				fail(
					"EDI-09",
					`${b.tags} #${b.id}: ${o.main ? "main" : "secondary"} door blocked outside by ${blocked.kind}/${blocked.tags}`,
					ox,
					oy,
				);
			} else if (!reach.at(ox + n[0] * (TOWN.WALL_T / 2 + 40), oy + n[1] * (TOWN.WALL_T / 2 + 40)).reached) {
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
			const dist = pathField(
				ras,
				[start],
				k =>
					ras.inside[k] === 1 ||
					k === start ||
					Math.hypot((k % ras.cols) * ras.C + ras.x0 - sx, Math.floor(k / ras.cols) * ras.C + ras.y0 - sy) <
						40,
			);
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
					fail(
						"EDI-08",
						`${b.tags} #${b.id}: the ${q.kind} cannot be reached from the ${o.main ? "main" : "secondary"} door`,
						cx(q),
						cy(q),
					);
				}
				seen.add(q.room);
			}
			if (o.main) {
				for (const s of b.lootSpots ?? []) {
					const k = ras.idx(s.x, s.y);
					if (k < 0 || !(dist[k] < Infinity))
						fail("EDI-03", `${b.tags} #${b.id}: loot spot not reachable`, s.x, s.y);
				}
			}
		}
		if ((b.lootSpots ?? []).length === 0) fail("EDI-03", `${b.tags} #${b.id}: no loot spot`, cx(b), cy(b));
		// EDI-11: no safe spot -- from the nearest reachable outside point, a walker (16) gets to every spot a survivor
		// (18) can stand on, fast. The two rasters share their grid (same box, same margin), so a cell index is the
		// same spot in both.
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
			const cells = rooms.filter(p => p.room === q.room).flatMap(p => cellsIn(ras, p));
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
				fail(
					"EDI-11",
					`${b.tags} #${b.id}: a spot of the ${q.kind} no walker can reach (a safe spot)`,
					cx(q),
					cy(q),
				);
			} else if (s > REACH_BOUND_S) {
				fail(
					"EDI-11",
					`${b.tags} #${b.id}: the ${q.kind} is ${s.toFixed(1)} s from outside for a walker (> ${REACH_BOUND_S})`,
					cx(q),
					cy(q),
				);
			}
		}
		// EDI-11, as the horde really walks: the server's flow field (32 u cells, solids inflated 4 u, a window's
		// sill passable) reaches, from outside, a cell next to every spot a survivor can stand on -- the last few
		// metres are the straight chase (DIRECT_CHASE, 200 u), not the field
		const field = fieldReach(w, b);
		for (let k = 0; k < ras.cols * ras.rows; k++) {
			if (!ras.inside[k] || ras.blocked[k]) continue;
			const px = (k % ras.cols) * ras.C + ras.x0 + ras.C / 2;
			const py = Math.floor(k / ras.cols) * ras.C + ras.y0 + ras.C / 2;
			if (!field.near(px, py)) {
				fail("EDI-11", `${b.tags} #${b.id}: the horde's flow field reaches nothing near this spot`, px, py);
				break;
			}
		}
		fieldCells += field.cells;
		// EDI-08: every room has the piece that says what it is (a bedroom its bed, a ward its beds...)
		const seenD = new Set();
		for (const q of rooms) {
			if (seenD.has(q.room)) continue;
			seenD.add(q.room);
			const want = DEFINING[q.kind];
			if (want === undefined || want.length === 0) continue;
			const rects = rooms.filter(p => p.room === q.room);
			const has = furniture.some(
				f => want.includes(f.tags) && rects.some(r => inside({ x: cx(f), y: cy(f), w: 0, h: 0 }, r)),
			);
			if (!has) fail("EDI-08", `${b.tags} #${b.id}: the ${q.kind} has none of ${want.join("/")}`, cx(q), cy(q));
		}
	}
	// the share of each type that has all its doors is judged over the whole run (below the seeds' loop): a town
	// holds only 3-9 buildings of most types, and one yard taken by a tree moves a single town's share by 15-30 %
	for (const [t, tt] of Object.entries(byType)) {
		const run = (DOOR_RUN[t] ??= { n: 0, target: 0 });
		run.n += tt.n;
		run.target += tt.target;
	}
	if (buildings.length > 0 && compound / buildings.length < 0.5) {
		fail("EDI-14", `only ${compound}/${buildings.length} footprints are not a plain box (< 50%)`, 0, 0);
	}
	stats.compound = compound;
	stats.fieldCells = fieldCells;
	stats.worstReach = worst.s;
	stats.worstRoom = worst.b ? `${worst.b.tags} #${worst.b.id} ${worst.room}` : "-";
	stats.doorsByType = Object.fromEntries(
		Object.entries(byType).map(([t, tt]) => [
			TYPE_TAG[t],
			`${(tt.doors / tt.n).toFixed(1)}d/${(tt.windows / tt.n).toFixed(1)}w`,
		]),
	);
}

// ---------------------------------------------------------------- the everyday town's mix (EDI-18, EDI-19)

/** the kinds every town has at least one of (EDI-18): medicine, food, ammunition, tools, the law, the fire engine */
const ESSENTIAL = [
	["pharmacy", [6]],
	["a food store", [7, 8]],
	["gun shop", [9]],
	["hardware store", [16]],
	["police station", [25]],
	["fire station", [24]],
	["hospital", [4]],
	["school", [3]],
];

/** the everyday town's fixtures (shared/game/townLots.ts), by where they belong */
const STREET_TAGS = ["streetlight", "hydrant", "mailbox", "postbox", "busstop"];
const PLAY_TAGS = ["swings", "slide", "climber", "springer"];
const YARD_THING_TAGS = ["shed", "pool", "trampoline", "grill"];
const MARKET_TAGS = ["stall", "crates", "foodtruck"];
const SITE_TAGS = ["fence", "studs", "scaffold", "pile", "portapotty", "mixer", "dumpster"];

/**
 * EDI-20 (the street market), EDI-21 (a house going up), MOB-04 (the street furniture, CID-02/CID-03 for it), MOB-05
 * (the parks' playgrounds and courts, the public parking lot), MOB-06 (the backyards), and EDI-11 outdoors for every
 * one of these fixtures: between two standing things there is no slot one body fits in and two do not -- unless a third
 * thing fills that gap right across (townLots.ts `pinches`, `gapBetween`, `cutAcross`: the generator's own rule).
 * Every searchable fixture is a container of a known table, with a static id the LootFlag's u16 carries.
 */
function everydayChecks(w, buildings, reach, fail) {
	if (TL === undefined || TL.pinches === undefined) return undefined;
	const S = w.solids;
	const stats = { markets: 0, stalls: 0, stocked: 0, sites: 0, piles: 0, street: 0, playgrounds: 0, courts: 0 };
	stats.parking = 0;
	stats.yard = 0;
	stats.sheds = 0;
	const lotOf = s => w.lots.find(l => cx(s) >= l.x && cx(s) < l.x + l.w && cy(s) >= l.y && cy(s) < l.y + l.h);
	const standing = s =>
		s.removed !== true &&
		s.kind !== "canopy" &&
		s.kind !== "window" &&
		s.parentId === undefined &&
		(s.kind === "building" || s.passable !== true);
	const campusLots = new Set(buildings.filter(b => isCampus(b.buildingType)).map(b => lotOf(b)));
	const parks = w.lots.filter(l => l.kind === "park");
	const mine = S.filter(
		s =>
			s.kind === "prop" &&
			s.bankId === undefined &&
			!campusLots.has(lotOf(s)) &&
			[
				...STREET_TAGS,
				...PLAY_TAGS,
				...YARD_THING_TAGS,
				...MARKET_TAGS,
				...SITE_TAGS,
				"bench",
				"hoop",
				"picnic",
			].includes(s.tags),
	);
	const mineSet = new Set(mine);
	// --- EDI-11 outdoors
	for (const p of mine) {
		const near = W.querySolids(w, p.x - 88, p.y - 88, p.x + p.w + 88, p.y + p.h + 88).filter(
			s => s !== p && standing(s),
		);
		for (const s of near) {
			if (mineSet.has(s) && s.id < p.id) continue;
			if (!TL.pinches(p, s)) continue;
			const g = TL.gapBetween(p, s);
			const alongY = Math.max(0, s.x - (p.x + p.w), p.x - (s.x + s.w)) > 0;
			if (g !== undefined && near.some(o => o !== s && TL.cutAcross(g, o, alongY))) continue;
			const gap = Math.max(
				Math.max(0, s.x - (p.x + p.w), p.x - (s.x + s.w)),
				Math.max(0, s.y - (p.y + p.h), p.y - (s.y + s.h)),
			);
			fail(
				"EDI-11",
				`${p.tags} #${p.id} and ${s.kind}/${s.tags} #${s.id}: a ${fmt(gap)} u slot outdoors`,
				cx(p),
				cy(p),
			);
		}
	}
	// --- containers: a known table, a small static id
	for (const s of S) {
		if (s.kind !== "prop" || s.lootSlots === undefined) continue;
		const key = s.tags === "vault" ? undefined : SPAWNS.yardLootKey(s.tags, s.variant);
		const rows = s.tags === "vault" ? SPAWNS.VAULT_LOOT : SPAWNS.YARD_LOOT[key];
		if (!(SPAWNS.YARD_TAGS ?? []).includes(s.tags) || rows === undefined || rows.length === 0) {
			fail("EDI-03", `${s.tags} #${s.id}: a container with no table (${key})`, cx(s), cy(s));
		}
		if (s.id >= 65536) fail("EDI-03", `${s.tags} #${s.id}: its id does not fit the LootFlag's u16`, cx(s), cy(s));
	}
	/** is some point just round the rect, on the side it faces (or any side), reached on foot? */
	const reachable = s => {
		const n = s.face !== undefined ? NORMAL[s.face] : undefined;
		const pts = [];
		if (n !== undefined) pts.push([cx(s) + n[0] * (s.w / 2 + 26), cy(s) + n[1] * (s.h / 2 + 26)]);
		for (const m of Object.values(NORMAL)) pts.push([cx(s) + m[0] * (s.w / 2 + 26), cy(s) + m[1] * (s.h / 2 + 26)]);
		return pts.some(([x, y]) => reach.at(x, y).reached);
	};
	// --- EDI-20: the street market
	const markets = w.lots.filter(l => l.program === "market");
	stats.markets = markets.length;
	if (markets.length > 1)
		fail("EDI-20", `${markets.length} street markets in one town (one)`, cx(markets[1]), cy(markets[1]));
	for (const lot of markets) {
		const inLot = s => lotOf(s) === lot;
		const stalls = mine.filter(s => s.tags === "stall" && inLot(s));
		const stocked = stalls.filter(s => s.lootSlots !== undefined);
		const tents = S.filter(s => s.kind === "canopy" && s.tags === "tent" && inLot(s));
		const trucks = mine.filter(s => s.tags === "foodtruck" && inLot(s));
		stats.stalls += stalls.length;
		stats.stocked += stocked.length;
		if (buildings.some(b => overlap(b, lot.yard)))
			fail("EDI-20", "a building on the market's block", cx(lot), cy(lot));
		if (stalls.length < 8) fail("EDI-20", `the market has ${stalls.length} stalls (8 at least)`, cx(lot), cy(lot));
		if (stocked.length === 0 || stocked.length > (TL.MARKET_STOCKED_MAX ?? 8)) {
			fail(
				"EDI-20",
				`${stocked.length} of ${stalls.length} stalls hold something (1 to ${TL.MARKET_STOCKED_MAX ?? 8})`,
				cx(lot),
				cy(lot),
			);
		}
		for (const s of stalls) {
			if (!tents.some(t => cx(s) >= t.x && cx(s) <= t.x + t.w && cy(s) >= t.y && cy(s) <= t.y + t.h)) {
				fail("EDI-20", `stall #${s.id} has no tent over it`, cx(s), cy(s));
			}
		}
		if (trucks.length !== 1) fail("EDI-20", `${trucks.length} food trucks at the market (one)`, cx(lot), cy(lot));
		for (const c of [...stocked, ...trucks]) {
			if (!reachable(c)) fail("EDI-20", `${c.tags} #${c.id} cannot be reached on foot`, cx(c), cy(c));
		}
	}
	// --- EDI-21: a house going up
	const sites = w.lots.filter(l => l.program === "construction");
	stats.sites = sites.length;
	if (sites.length > 1)
		fail("EDI-21", `${sites.length} building sites in one town (one)`, cx(sites[1]), cy(sites[1]));
	for (const lot of sites) {
		const inLot = s => lotOf(s) === lot;
		const fences = mine.filter(s => s.tags === "fence" && inLot(s));
		const piles = mine.filter(s => s.tags === "pile" && inLot(s));
		const pad = (lot.ground ?? []).find(g => g.kind === "pad");
		stats.piles += piles.length;
		if (fences.length < 4) fail("EDI-21", `the site's fence has ${fences.length} runs`, cx(lot), cy(lot));
		if (piles.length === 0 || piles.some(p => p.lootSlots === undefined)) {
			fail("EDI-21", "the site has no pile of material to search", cx(lot), cy(lot));
		}
		if (pad === undefined) fail("EDI-21", "the site has no slab", cx(lot), cy(lot));
		else if (!reach.at(cx(pad), cy(pad)).reached)
			fail("EDI-21", "the slab cannot be reached on foot", cx(pad), cy(pad));
		for (const p of piles)
			if (!reachable(p)) fail("EDI-21", `pile #${p.id} cannot be reached on foot`, cx(p), cy(p));
	}
	// --- MOB-04: the street furniture, in the service strip (CID-02), off every cut, a car's length from a corner (CID-03)
	const street = [
		...mine.filter(s => STREET_TAGS.includes(s.tags)),
		...mine.filter(s => s.tags === "bench" && lotOf(s)?.kind !== "park"),
	];
	stats.street = street.length;
	for (const s of street) {
		const lot = lotOf(s);
		const edges = lot === undefined ? [] : lotEdges(w, lot);
		const e = edges.find(q => inside(s, edgeRect(q, q.a, q.b, 0, VERGE), 1));
		if (e === undefined) {
			fail("MOB-04", `${s.tags} #${s.id} outside the sidewalk's service strip`, cx(s), cy(s));
			continue;
		}
		const cuts = (lot.ground ?? []).filter(
			g => (g.kind === "walk" || g.kind === "drive") && overlap(g, edgeRect(e, e.a, e.b, 0, SW)),
		);
		if (cuts.some(g => overlap(g, s)))
			fail("MOB-04", `${s.tags} #${s.id} on a footpath or a driveway`, cx(s), cy(s));
		const u0 = alongX(e.side) ? s.x : s.y;
		const u1 = u0 + (alongX(e.side) ? s.w : s.h);
		if ((e.cornerA && u0 < e.a + TOWN.CORNER_CLEAR) || (e.cornerB && u1 > e.b - TOWN.CORNER_CLEAR)) {
			fail("CID-03", `${s.tags} #${s.id} within a car length of a street corner`, cx(s), cy(s));
		}
	}
	for (const sh of S.filter(s => s.kind === "canopy" && s.tags === "shelter")) {
		const lot = lotOf(sh);
		const ok = lot !== undefined && lotEdges(w, lot).some(q => inside(sh, edgeRect(q, q.a, q.b, 0, SW), 1));
		if (!ok || sh.passable !== true) fail("MOB-04", `bus shelter #${sh.id} off its sidewalk`, cx(sh), cy(sh));
	}
	// --- MOB-05: the parks' playgrounds and courts; the public parking lot
	for (const lot of parks) {
		const sand = (lot.ground ?? []).filter(g => g.kind === "sandbox");
		if (sand.length === 0) {
			fail("MOB-05", "a park without a playground", cx(lot), cy(lot));
			continue;
		}
		stats.playgrounds += sand.length;
		for (const g of sand) {
			const kit = mine.filter(s => PLAY_TAGS.includes(s.tags) && inside(s, g, 1));
			if (kit.length < 3)
				fail("MOB-05", `a playground with ${kit.length} pieces of equipment (3 at least)`, cx(g), cy(g));
		}
		for (const g of (lot.ground ?? []).filter(q => q.kind === "court")) {
			stats.courts++;
			if (!mine.some(s => s.tags === "hoop" && inside(s, g, 1)))
				fail("MOB-05", "a court without a hoop", cx(g), cy(g));
		}
	}
	const parking = w.lots.filter(l => l.program === "parking");
	stats.parking = parking.length;
	if (parking.length > 1)
		fail("MOB-05", `${parking.length} public parking lots (one)`, cx(parking[1]), cy(parking[1]));
	for (const lot of parking) {
		if (!(lot.ground ?? []).some(g => g.kind === "parking"))
			fail("MOB-05", "a public parking lot with no stalls", cx(lot), cy(lot));
		if (buildings.some(b => overlap(b, lot.yard)))
			fail("MOB-05", "a building on the public parking lot", cx(lot), cy(lot));
	}
	// --- MOB-06: the backyards
	const yardThings = mine.filter(
		s => YARD_THING_TAGS.includes(s.tags) || (s.tags === "swings" && lotOf(s)?.kind !== "park"),
	);
	stats.yard = yardThings.length;
	for (const s of yardThings) {
		const lot = lotOf(s);
		if (lot === undefined || lot.kind !== "block" || lot.zone !== "residential" || !inside(s, lot.yard, 1)) {
			fail("MOB-06", `${s.tags} #${s.id} outside a residential block's yards`, cx(s), cy(s));
			continue;
		}
		const b = buildings.find(q => rectDist(q, s) < 96 - 1);
		if (b !== undefined)
			fail("MOB-06", `${s.tags} #${s.id} ${fmt(rectDist(b, s))} u from ${b.tags} #${b.id} (96)`, cx(s), cy(s));
		if (s.tags === "shed") {
			stats.sheds++;
			if (s.lootSlots === undefined) fail("MOB-06", `shed #${s.id} holds nothing to search`, cx(s), cy(s));
			else if (!reachable(s)) fail("MOB-06", `shed #${s.id} cannot be reached on foot`, cx(s), cy(s));
		}
	}
	return stats;
}

/**
 * The body-of-18 floor of one building's box (8 u cells), flooded from just outside its main door with the doors as
 * they are: which points a survivor walking in could reach. EDI-23 asks it with the vault door shut.
 */
function reachInside(w, b) {
	const C = 8;
	const pad = 64;
	const x0 = b.x - pad;
	const y0 = b.y - pad;
	const cols = Math.ceil((b.w + pad * 2) / C);
	const rows = Math.ceil((b.h + pad * 2) / C);
	const blocked = new Uint8Array(cols * rows);
	const r = BODY_R;
	for (const s of W.querySolids(w, x0, y0, x0 + cols * C, y0 + rows * C)) {
		if (!W.isBlocking(s)) continue;
		for (let j = 0; j < rows; j++) {
			const py = y0 + j * C + C / 2;
			const dy = Math.max(s.y - py, 0, py - s.y - s.h);
			if (dy >= r) continue;
			for (let i = 0; i < cols; i++) {
				const px = x0 + i * C + C / 2;
				const dx = Math.max(s.x - px, 0, px - s.x - s.w);
				if (dx * dx + dy * dy < r * r) blocked[j * cols + i] = 1;
			}
		}
	}
	const n = NORMAL[b.doorSide];
	const sx = Math.floor((b.doorX + n[0] * 40 - x0) / C);
	const sy = Math.floor((b.doorY + n[1] * 40 - y0) / C);
	const seen = new Uint8Array(cols * rows);
	const queue = [];
	if (sx >= 0 && sy >= 0 && sx < cols && sy < rows && !blocked[sy * cols + sx]) {
		seen[sy * cols + sx] = 1;
		queue.push(sy * cols + sx);
	}
	for (let h = 0; h < queue.length; h++) {
		const k = queue[h];
		const i = k % cols;
		const j = (k - i) / cols;
		for (const m of [
			i > 0 ? k - 1 : -1,
			i < cols - 1 ? k + 1 : -1,
			j > 0 ? k - cols : -1,
			j < rows - 1 ? k + cols : -1,
		]) {
			if (m < 0 || seen[m] || blocked[m]) continue;
			seen[m] = 1;
			queue.push(m);
		}
	}
	return (x, y) => {
		const i = Math.floor((x - x0) / C);
		const j = Math.floor((y - y0) / C);
		return i >= 0 && j >= 0 && i < cols && j < rows && seen[j * cols + i] === 1;
	};
}

/**
 * EDI-23, the bank: at most BANKS a town; on a downtown block, facing an avenue; its steps across the whole facade;
 * the portico over at least four columns, two bodies between two columns and a sealed gap behind them; the vault a
 * leaf behind ONE door -- one opening, the vault door in it, shut as the town is made, no way round it (a body from
 * the main door does not reach the vault's floor with the door shut) -- its deposit boxes inside it, a container of
 * their own; and never a gun or a round in the boxes. Run with the vault doors as generated (shut): the walk checks
 * that follow see them open, the vault reachable once it is cracked (EDI-08, EDI-11, CID-05).
 */
function bankChecks(w, buildings, fail) {
	const S = w.solids;
	const banks = buildings.filter(b => b.buildingType === 22);
	const most = W.BANKS ?? 1;
	if (banks.length > most)
		fail("EDI-23", `${banks.length} banks in one town (at most ${most})`, cx(banks[0]), cy(banks[0]));
	for (const e of SPAWNS.VAULT_LOOT ?? []) {
		if (e.kind === 1 || (e.kind === 4 && e.index >= 44 && e.index <= 47)) {
			fail("EDI-23", `the vault's boxes hold a gun or rounds (${e.kind}/${e.index})`, 0, 0);
		}
	}
	const PATH = 88;
	const SEALED = 30;
	for (const b of banks) {
		const where = `bank #${b.id}`;
		const lot = w.lots.find(l => cx(b) >= l.x && cx(b) < l.x + l.w && cy(b) >= l.y && cy(b) < l.y + l.h);
		if (lot?.zone !== "commercial")
			fail("EDI-23", `${where}: not on a downtown block (${lot?.zone})`, cx(b), cy(b));
		// the street in front of the main door is an avenue
		const n = NORMAL[b.doorSide];
		let road;
		for (let d = 0; d <= 600 && road === undefined; d += 8) {
			const px = b.doorX + n[0] * d;
			const py = b.doorY + n[1] * d;
			road = w.roads.find(r => px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h);
		}
		if (road === undefined || !road.avenue)
			fail("EDI-23", `${where}: its door does not face an avenue`, b.doorX, b.doorY);
		// the steps, the portico and its columns
		const ax = alongX(b.doorSide);
		const steps = (lot?.ground ?? []).filter(g => g.kind === "steps" && rectDist(g, b) < 1);
		if (steps.length !== 1)
			fail("EDI-23", `${where}: ${steps.length} flights of steps before it`, b.doorX, b.doorY);
		else if (Math.abs((ax ? steps[0].w : steps[0].h) - (ax ? b.w : b.h)) > 1) {
			fail("EDI-23", `${where}: the steps do not span the facade`, b.doorX, b.doorY);
		}
		const portico = S.find(s => s.kind === "canopy" && s.tags === "portico" && s.bankId === b.id);
		const cols = S.filter(s => s.kind === "prop" && s.tags === "column" && s.bankId === b.id);
		if (portico === undefined) fail("EDI-23", `${where}: no portico`, b.doorX, b.doorY);
		if (cols.length < 4) fail("EDI-23", `${where}: ${cols.length} columns (at least 4)`, b.doorX, b.doorY);
		cols.sort((p, q) => (ax ? p.x - q.x : p.y - q.y));
		for (let i = 0; i < cols.length; i++) {
			const c = cols[i];
			if (portico !== undefined && !overlap(c, portico))
				fail("EDI-23", `${where}: a column outside the portico`, cx(c), cy(c));
			if (rectDist(c, b) >= SEALED) fail("EDI-23", `${where}: a body fits behind a column`, cx(c), cy(c));
			const next = cols[i + 1];
			if (next !== undefined && rectDist(c, next) < PATH) {
				fail(
					"EDI-23",
					`${where}: ${fmt(rectDist(c, next))} u between two columns (two bodies: ${PATH})`,
					cx(c),
					cy(c),
				);
			}
		}
		// the vault: one room, one opening, the door in it, the boxes inside
		const vault = (b.rooms ?? []).filter(r => r.kind === "vault");
		if (vault.length === 0) {
			fail("EDI-23", `${where}: no vault`, cx(b), cy(b));
			continue;
		}
		const grown = o => ({ x: o.x - 4, y: o.y - 4, w: o.w + 8, h: o.h + 8 });
		const opens = (b.openings ?? []).filter(o => vault.some(r => overlap(grown(o), r)));
		const doors = S.filter(s => s.kind === "iron_door" && s.tags === "vault" && s.bankId === b.id);
		if (opens.length !== 1 || opens[0].kind !== "inner") {
			fail(
				"EDI-23",
				`${where}: the vault has ${opens.length} openings (one doorway, the vault door's)`,
				cx(vault[0]),
				cy(vault[0]),
			);
		}
		if (doors.length !== 1) fail("EDI-23", `${where}: ${doors.length} vault doors`, cx(vault[0]), cy(vault[0]));
		for (const d of doors) {
			if (d.open === true) fail("EDI-23", `${where}: the vault door stands open in a new town`, cx(d), cy(d));
			if (d.parentId !== undefined)
				fail("EDI-23", `${where}: the vault door is a part of the bank (E cannot reach it)`, cx(d), cy(d));
			if (!opens.some(o => overlap(o, d)))
				fail("EDI-23", `${where}: the vault door is not in the vault's doorway`, cx(d), cy(d));
		}
		const boxes = S.filter(s => s.kind === "prop" && s.tags === "vault" && s.bankId === b.id);
		if (boxes.length !== 1)
			fail("EDI-23", `${where}: ${boxes.length} walls of deposit boxes`, cx(vault[0]), cy(vault[0]));
		for (const x of boxes) {
			if (!vault.some(r => inside(x, r, 1)))
				fail("EDI-23", `${where}: the deposit boxes stand outside the vault`, cx(x), cy(x));
			if (x.lootSlots === undefined || x.lootItems === undefined)
				fail("EDI-23", `${where}: the boxes are no container`, cx(x), cy(x));
		}
		// sealed: with the door shut, nobody walks into the vault
		const reached = reachInside(w, b);
		for (const r of vault) {
			if (reached(cx(r), cy(r)))
				fail("EDI-23", `${where}: the vault can be walked into with its door shut`, cx(r), cy(r));
		}
	}
	return banks.length;
}

/**
 * EDI-18: no kind past its quota (world.ts SHOP_QUOTA, SCHOOLS, HOSPITALS, GAS_STATIONS; two churches, one fire
 * station) and none of the essentials missing. EDI-19: two of a kind at least their `apart` blocks apart (Chebyshev,
 * on the grid of lots), never two on one block or facing each other across a street, never more than GAS_PER_AVENUE
 * gas stations on one avenue. Answers a summary for the seed's line.
 */
function mixChecks(w, buildings, fail) {
	const quota = W.SHOP_QUOTA;
	if (quota === undefined) return { shops: 0 };
	const cap = { 3: W.SCHOOLS ?? 2, 4: W.HOSPITALS ?? 2, 5: W.GAS_STATIONS ?? 4, 22: W.BANKS ?? 1, 23: 2, 24: 1 };
	const apart = { 3: 3, 4: 3, 5: 2, 22: 1, 23: 3, 24: 1 };
	for (const q of quota) {
		cap[q.type] = q.cap;
		apart[q.type] = Math.max(1, q.apart);
	}
	const xs = [...new Set(w.lots.map(l => l.x))].sort((a, b) => a - b);
	const ys = [...new Set(w.lots.map(l => l.y))].sort((a, b) => a - b);
	const lotOf = b => w.lots.find(l => cx(b) >= l.x && cx(b) < l.x + l.w && cy(b) >= l.y && cy(b) < l.y + l.h);
	const byType = new Map();
	for (const b of buildings) {
		const t = b.buildingType;
		if (t <= 2) continue;
		if (!byType.has(t)) byType.set(t, []);
		byType.get(t).push({ b, lot: lotOf(b) });
	}
	for (const [t, list] of byType) {
		if (cap[t] !== undefined && list.length > cap[t]) {
			fail(
				"EDI-18",
				`${list.length} ${TYPE_TAG[t]} buildings in town (at most ${cap[t]})`,
				cx(list[0].b),
				cy(list[0].b),
			);
		}
	}
	for (const [what, types] of ESSENTIAL) {
		if (!types.some(t => (byType.get(t) ?? []).length > 0)) fail("EDI-18", `no ${what} in town`, 0, 0);
	}
	const opposite = { top: "bottom", bottom: "top", left: "right", right: "left" };
	let pairs = 0;
	for (const [t, list] of byType) {
		for (let i = 0; i < list.length; i++) {
			for (let k = i + 1; k < list.length; k++) {
				pairs++;
				const a = list[i];
				const o = list[k];
				if (a.lot === undefined || o.lot === undefined) continue;
				const blocks = Math.max(
					Math.abs(xs.indexOf(a.lot.x) - xs.indexOf(o.lot.x)),
					Math.abs(ys.indexOf(a.lot.y) - ys.indexOf(o.lot.y)),
				);
				const need = apart[t] ?? 1;
				if (a.lot === o.lot) {
					fail("EDI-19", `two ${TYPE_TAG[t]} on one block (#${a.b.id}, #${o.b.id})`, cx(a.b), cy(a.b));
				} else if (blocks < need) {
					fail(
						"EDI-19",
						`${TYPE_TAG[t]} #${a.b.id} and #${o.b.id} ${blocks} block(s) apart (at least ${need})`,
						cx(a.b),
						cy(a.b),
					);
				}
				// facing each other across one street: neighbouring blocks, the doors looking at each other, close along it
				if (blocks === 1 && o.b.doorSide === opposite[a.b.doorSide]) {
					const along = alongX(a.b.doorSide);
					const du = along ? Math.abs(a.b.doorX - o.b.doorX) : Math.abs(a.b.doorY - o.b.doorY);
					if (du < 700) {
						fail(
							"EDI-19",
							`${TYPE_TAG[t]} #${a.b.id} and #${o.b.id} face each other across a street`,
							cx(a.b),
							cy(a.b),
						);
					}
				}
			}
		}
	}
	// gas stations: at most GAS_PER_AVENUE on each avenue (the street their forecourt opens onto)
	const perRoad = new Map();
	for (const { b, lot } of byType.get(5) ?? []) {
		const e = lot === undefined ? undefined : lotEdges(w, lot).find(x => x.side === b.doorSide);
		if (e === undefined || e.road === undefined) continue;
		perRoad.set(e.road, (perRoad.get(e.road) ?? 0) + 1);
	}
	for (const [road, n] of perRoad) {
		if (w.roads[road]?.avenue && n > (W.GAS_PER_AVENUE ?? 2)) {
			fail("EDI-19", `${n} gas stations on one avenue (at most ${W.GAS_PER_AVENUE ?? 2})`, 0, 0);
		}
	}
	let shops = 0;
	for (const [t, list] of byType) if (t >= 3) shops += list.length;
	return { shops, kinds: byType.size, pairs };
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
	// the campus (EDI-17): paper (plans, maps), cells for the lamps, the lab's "tech"
	paper: /blueprint/i,
	battery: /battery/i,
	tech: /computer chip|voltage circuit|machine parts/i,
	// the everyday town's (EDI-18): building material, electrical parts, pieces of gold
	materials: /^wood$|^stone$|piece of steel/i,
	parts: /battery|bulb|computer chip|machine parts|voltage circuit/i,
	gold: /piece of gold/i,
};
/** what a type's table must hold (EDI-03); the campus: the hall and the library paper, the library cells too, the
 * lab its tech and its first aid, the dorm its food and clothes; the everyday town: EDI-18 */
const REQUIRED = {
	4: "medical",
	6: "medical",
	9: "ammo",
	7: "food",
	8: "food",
	11: "food",
	5: "oil",
	10: "cloth",
	12: ["paper"],
	13: ["paper", "battery"],
	14: ["tech", "medical"],
	15: ["food", "cloth"],
	// EDI-18: what each of the everyday town's buildings held before the outbreak
	16: "materials",
	17: "oil",
	18: "parts",
	19: "food",
	20: "gold",
	21: "cloth",
	22: "gold",
	23: "food",
	24: "medical",
	25: "ammo",
	26: "parts",
};

/**
 * How each type says what it is from outside (EDI-03): the storefront signs of shared/data/buildingSigns.ts
 * (ART-07), one per type, each its own texture and its own picture -- or, on an older checkout (PZ_SRC), the
 * types worldView.drawEmblem draws a rooftop emblem for. { types, own } where `own` lists what is not distinct.
 */
function signTypes() {
	const data = join(SRC, "shared/data/buildingSigns.ts");
	if (!existsSync(data)) {
		const old = emblemTypes();
		return old === undefined ? undefined : { types: old, own: [], what: "rooftop emblem in worldView.drawEmblem" };
	}
	const { BUILDING_SIGNS } = require(data);
	const types = new Set();
	const own = [];
	const byTexture = new Map();
	const byPicture = new Map();
	for (const [key, sign] of Object.entries(BUILDING_SIGNS)) {
		const t = Number(key);
		types.add(t);
		const picture = sign.rows.join("/");
		if (byTexture.has(sign.texture)) own.push(`types ${byTexture.get(sign.texture)} and ${t} share a sign texture`);
		if (byPicture.has(picture)) own.push(`types ${byPicture.get(picture)} and ${t} share a sign picture`);
		byTexture.set(sign.texture, t);
		byPicture.set(picture, t);
	}
	return { types, own, what: "storefront sign in shared/data/buildingSigns.ts" };
}

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

// ---------------------------------------------------------------- the campus (EDI-17)

/** two standing things leave a gap one body fits in and two do not (EDI-11, outdoors): diagonal neighbours never do */
function pinches(a, b) {
	const du = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
	const dv = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
	if (du > 0 && dv > 0) return false;
	const gap = Math.max(du, dv);
	return gap >= 30 && gap < 88;
}

/**
 * The block the generator would have given a campus (world.ts placeCampus), asked again of a town that has none:
 * a whole residential block (four streets, none an avenue) with only houses on it, two blocks from any school or
 * hospital, where some way round of the campus plan (shared/game/campus.ts) fits clear of the boss plazas.
 */
function campusBlock(w, buildings) {
	if (CAMPUS === undefined) return undefined;
	const civic = buildings.filter(b => b.buildingType === 3 || b.buildingType === 4);
	const pitch = TOWN.LOT_TARGET + TOWN.ROAD_W;
	for (const lot of w.lots) {
		if (lot.kind !== "block" || lot.zone !== "residential" || lotEdges(w, lot).length !== 4) continue;
		if (lotEdges(w, lot).some(e => w.roads[e.road]?.avenue)) continue;
		if (buildings.some(b => b.buildingType > 2 && overlap(b, lot))) continue;
		const lx = lot.x + lot.w / 2;
		const ly = lot.y + lot.h / 2;
		if (civic.some(c => Math.max(Math.abs(cx(c) - lx), Math.abs(cy(c) - ly)) / pitch < 1.5)) continue;
		for (const side of CAMPUS.CAMPUS_SIDES) {
			for (const cw of [true, false]) {
				const plan = CAMPUS.campusLayout(lot.yard, side, cw, false);
				if (plan === undefined) continue;
				const clear = plan.buildings.every(b =>
					w.bossAnchors.every(a => ptRectDist(a.x, a.y, b.rect) >= TOWN.BOSS_CLEAR),
				);
				if (clear) return `the block at (${fmt(lot.x)},${fmt(lot.y)})`;
			}
		}
	}
	return undefined;
}

/**
 * EDI-17: at most one campus a town -- a main hall, a library, a science lab and a dorm, one of each, on one whole
 * block, each facing its own street -- where a block can hold one; its quad reached on foot, with one centrepiece
 * (a fountain or a statue), and whatever stands on it (the centrepiece, benches, trees) a body's path from the
 * buildings (their back doors and windows open onto it) and pinching no slot (EDI-11, outdoors). Rooms, doors,
 * windows, loot and the no-safe-spot rule are every building's (EDI-03, EDI-08..EDI-14 above).
 */
function campusChecks(w, buildings, reach, fail, stats) {
	const campus = buildings.filter(b => isCampus(b.buildingType));
	stats.present = campus.length > 0;
	if (campus.length === 0) {
		const block = campusBlock(w, buildings);
		if (block !== undefined) fail("EDI-17", `no campus, though ${block} could hold one`, 0, 0);
		return;
	}
	for (const t of CAMPUS_TYPES) {
		const n = campus.filter(b => b.buildingType === t).length;
		if (n !== 1) fail("EDI-17", `${n} ${TYPE_TAG[t]} building(s): one campus a town, one of each`, 0, 0);
	}
	const hall = campus.find(b => b.buildingType === 12) ?? campus[0];
	const lot = w.lots.find(l => inside(hall, l.yard));
	if (lot === undefined) {
		fail("EDI-17", `the campus hall #${hall.id} is not inside a block's yard`, cx(hall), cy(hall));
		return;
	}
	stats.block = `${fmt(lot.x)},${fmt(lot.y)}`;
	if (lotEdges(w, lot).length !== 4)
		fail("EDI-17", "the campus block is not a whole block (four streets)", cx(hall), cy(hall));
	for (const b of campus) {
		if (!inside(b, lot.yard)) fail("EDI-17", `${b.tags} #${b.id} is off the campus block`, cx(b), cy(b));
	}
	if (new Set(campus.map(b => b.doorSide)).size !== campus.length) {
		fail("EDI-17", "two campus buildings face the same street", cx(hall), cy(hall));
	}
	for (const o of buildings) {
		if (!isCampus(o.buildingType) && overlap(o, lot)) {
			fail("EDI-17", `${o.tags} #${o.id} is left on the campus block`, cx(o), cy(o));
		}
	}
	// the quad and what stands on it
	const props = w.solids.filter(s => s.kind === "prop" && overlap(s, lot.yard));
	const trees = w.solids.filter(s => s.kind === "tree" && inside(s, lot.yard));
	const centre = props.filter(p => p.tags === "fountain" || p.tags === "statue");
	if (centre.length !== 1)
		fail("EDI-17", `${centre.length} centrepieces on the quad (a fountain or a statue)`, cx(hall), cy(hall));
	const standing = [...props, ...trees];
	for (const p of standing) {
		for (const b of campus) {
			const d = rectDist(p, b);
			if (d < 88)
				fail(
					"EDI-17",
					`${p.tags} #${p.id} ${fmt(d)} u from the ${b.tags} (< 88: its doors and windows)`,
					cx(p),
					cy(p),
				);
		}
		for (const q of standing) {
			if (q.id > p.id && pinches(p, q))
				fail("EDI-17", `${p.tags} #${p.id} and ${q.tags} #${q.id} pinch a slot`, cx(p), cy(p));
		}
		if (p.kind === "prop" && p.tags !== "statue" && p.low !== true)
			fail("EDI-17", `the ${p.tags} #${p.id} stops bullets`, cx(p), cy(p));
	}
	// on foot from the spawn: the ground round the centrepiece
	for (const c of centre) {
		const round = [
			[cx(c), c.y - 40],
			[cx(c), c.y + c.h + 40],
			[c.x - 40, cy(c)],
			[c.x + c.w + 40, cy(c)],
		];
		if (!round.some(([x, y]) => reach.at(x, y).reached))
			fail("EDI-17", "the quad is not reachable on foot", cx(c), cy(c));
	}
	stats.props = props.map(p => p.tags).join("+");
	stats.trees = trees.length;
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
	// a gas station's forecourt furniture (EDI-16): the canopy, the price sign's footing, the cars at the pumps
	const aprons = w.lots.flatMap(l => (l.ground ?? []).filter(g => g.kind === "apron"));
	// a gas station's canopy (tags "canopy"); a market stall's tent and a bus shelter are canopies of their own (EDI-20, MOB-04)
	const canopies = S.filter(s => s.kind === "canopy" && s.tags === "canopy");
	const gasSigns = S.filter(s => s.tags === "gas_sign");
	const pumpCars = cars.filter(s => s.variant !== undefined && aprons.some(a => inside(s, a)));
	const forecourtProp = s => s.tags === "pump" || s.tags === "gas_sign" || pumpCars.includes(s);
	const onCarriageway = r => w.roads.some(road => overlap(r, road)) && !medians.some(m => inside(r, m));

	// EDI-23: the bank, its vault shut as the town is made; every walk below sees the vault door open (cracked)
	const bank = bankChecks(w, buildings, fail);
	for (const s of S) if (s.kind === "iron_door" && s.tags === "vault") s.open = true;

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
		// the bank stands back behind its broad stone steps (EDI-23)
		const steps = TL?.BANK_STEPS ?? 96;
		if (t === 22 && Math.abs(front - steps) > 8) {
			fail(
				"EDI-02",
				`bank #${b.id}: ${fmt(front)} u behind the sidewalk (its steps are ${steps})`,
				b.doorX,
				b.doorY,
			);
		}
		// the church keeps a front lawn like the houses beside it (EDI-18)
		if (t === 23 && (front < TOWN.SETBACK_HOUSE_MIN - 8 || front > TOWN.SETBACK_HOUSE_MAX + 8)) {
			fail("EDI-02", `church #${b.id}: front lawn ${fmt(front)} u`, b.doorX, b.doorY);
		}
		// the fire station stands behind its apron, clear of everything (EDI-22)
		if (t === 24) {
			const apronDepth = TL?.FIRE_APRON ?? 256;
			if (front < apronDepth - 8)
				fail("EDI-22", `firestation #${b.id}: apron only ${fmt(front)} u deep`, b.doorX, b.doorY);
			const court =
				d.n[0] === 0
					? { x: b.x, y: Math.min(b.y, b.y + d.n[1] * front) + (d.n[1] > 0 ? b.h : 0), w: b.w, h: front }
					: { x: Math.min(b.x, b.x + d.n[0] * front) + (d.n[0] > 0 ? b.w : 0), y: b.y, w: front, h: b.h };
			if (!aprons.some(a => overlap(a, court) && a.w * a.h >= court.w * court.h * 0.9)) {
				fail("EDI-22", `firestation #${b.id}: no apron in front of its bay`, cx(court), cy(court));
			}
			const stuff = W.querySolids(
				w,
				court.x + 1,
				court.y + 1,
				court.x + court.w - 1,
				court.y + court.h - 1,
			).filter(s => W.isBlocking(s) && s.parentId !== b.id);
			if (stuff.length > 0) {
				fail(
					"EDI-22",
					`firestation #${b.id}: apron obstructed by ${stuff[0].kind}/${stuff[0].tags}`,
					cx(stuff[0]),
					cy(stuff[0]),
				);
			}
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
			).filter(s => W.isBlocking(s) && !forecourtProp(s) && s.parentId !== b.id);
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
		// the campus (EDI-17): a strip of lawn between the sidewalk and every facade, like a civic building
		if (isCampus(t) && (front < 32 || front > 112)) {
			fail("EDI-02", `${b.tags} #${b.id}: campus lawn ${fmt(front)} u deep (expected 32–112)`, b.doorX, b.doorY);
		}
	}

	// --- EDI-03: type ↔ tag ↔ loot table ↔ roof colour ↔ storefront sign (ART-07)
	const signs = signTypes();
	if (signs === undefined) fail("EDI-03", "no storefront signs (shared/data/buildingSigns.ts) and no emblems", 0, 0);
	for (const msg of signs?.own ?? []) fail("EDI-03", msg, 0, 0);
	const signed = new Set();
	const roofByType = new Map();
	for (const b of buildings) {
		const t = b.buildingType;
		if (TYPE_TAG[t] !== b.tags) {
			fail("EDI-03", `building #${b.id}: type ${t} tagged "${b.tags}" (expected "${TYPE_TAG[t]}")`, cx(b), cy(b));
		}
		const table = spawnRows(t);
		if (!table) {
			fail("EDI-03", `building #${b.id}: no loot table for type ${t}`, cx(b), cy(b));
		} else {
			for (const cat of [REQUIRED[t] ?? []].flat()) {
				if (!table.some(e => CATEGORY[cat].test(itemName(e.kind, e.index))))
					fail("EDI-03", `${b.tags} #${b.id}: loot table has no ${cat}`, cx(b), cy(b));
			}
			// a campus never held a gun or a round (EDI-17): those come from the gun shop and the dead
			if (isCampus(t) && table.some(e => e.kind === 1 || (e.kind === 4 && e.index >= 44 && e.index <= 47)))
				fail("EDI-03", `${b.tags} #${b.id}: a campus table holds a gun or ammunition`, cx(b), cy(b));
		}
		if (t >= 3 && b.roofColor) {
			const key = `${b.roofColor.R.toFixed(3)},${b.roofColor.G.toFixed(3)},${b.roofColor.B.toFixed(3)}`;
			if (roofByType.has(t) && roofByType.get(t) !== key) {
				fail("EDI-03", `${b.tags} #${b.id}: roof colour differs from other ${b.tags}s`, cx(b), cy(b));
			}
			roofByType.set(t, key);
		}
		// every type that is not a house says what it is from the street, and a house has no sign (once per type)
		if (signs && !signed.has(t)) {
			if (t >= 3 && !signs.types.has(t))
				fail("EDI-03", `${b.tags} (type ${t}) has no ${signs.what}`, cx(b), cy(b));
			if (t < 3 && signs.types.has(t))
				fail("EDI-03", `a ${b.tags} (type ${t}) has a ${signs.what}`, cx(b), cy(b));
			signed.add(t);
		}
	}
	const seenRoof = new Map();
	for (const [t, key] of roofByType) {
		const other = seenRoof.get(key);
		// the two food stores share their roof, and so do the campus's four buildings (one institution, EDI-17)
		const family = (TYPE_TAG[other] === "market" && TYPE_TAG[t] === "market") || (isCampus(other) && isCampus(t));
		if (other !== undefined && !family) {
			fail("EDI-03", `types ${other} and ${t} share a roof colour`, 0, 0);
		}
		seenRoof.set(key, t);
	}

	// --- EDI-16: every town has its gas stations, and each forecourt reads as one and pays out as one
	const gasStations = buildings.filter(b => b.buildingType === 5);
	const GAS_MIN = W.GAS_MIN ?? 2;
	if (gasStations.length < GAS_MIN) {
		fail("EDI-16", `only ${gasStations.length} gas station(s) in town (at least ${GAS_MIN})`, 0, 0);
	}
	if (!(PUMP_LOOT ?? []).some(e => CATEGORY.oil.test(itemName(e.kind, e.index)) && e.min >= 1)) {
		fail("EDI-16", "the pump islands' table (spawns.ts PUMP_LOOT) gives no Oil", 0, 0);
	}
	const islandsSeen = new Set();
	for (const b of gasStations) {
		const n = NORMAL[b.doorSide];
		// the forecourt: the apron the station's front wall opens onto (it runs past the shop to the street corner)
		const apron = aprons.find(a => rectDist(a, b) < 2);
		if (apron === undefined) {
			fail("EDI-16", `gas #${b.id}: no forecourt apron in front of the shop`, cx(b), cy(b));
			continue;
		}
		const islands = pumps.filter(p => inside(p, apron));
		if (islands.length < 2)
			fail("EDI-16", `gas #${b.id}: ${islands.length} pump island(s) (2)`, cx(apron), cy(apron));
		for (const p of islands) {
			islandsSeen.add(p);
			// a container of oil (MP-05), flagged to a client by its id on the wire's u16 (LootFlag)
			if (!(p.lootSlots >= 1) || !Array.isArray(p.lootItems)) {
				fail("EDI-16", `pump #${p.id}: not a container (lootSlots/lootItems)`, cx(p), cy(p));
			}
			if (p.id >= 65536) fail("EDI-16", `pump #${p.id}: id past the LootFlag's u16`, cx(p), cy(p));
			// a survivor gets to it: the ground in front of its shop-side face is walkable from the spawn point
			const m = NORMAL[p.face] ?? n;
			const fx = cx(p) - m[0] * (Math.min(p.w, p.h) / 2 + 30);
			const fy = cy(p) - m[1] * (Math.min(p.w, p.h) / 2 + 30);
			if (!reach.at(fx, fy).reached) fail("EDI-16", `pump #${p.id}: nobody can walk up to it`, fx, fy);
		}
		// one canopy over every island, inside the forecourt, clear of the shop's front (its doors and windows)
		const cover = canopies.filter(c => overlap(c, apron));
		if (cover.length !== 1) {
			fail("EDI-16", `gas #${b.id}: ${cover.length} canopies over the forecourt (1)`, cx(apron), cy(apron));
		} else {
			const c = cover[0];
			if (c.passable !== true || W.isBlocking(c))
				fail("EDI-16", `canopy #${c.id} collides (COL-02)`, cx(c), cy(c));
			if (!inside(c, apron)) fail("EDI-16", `canopy #${c.id} reaches out of its forecourt`, cx(c), cy(c));
			for (const p of islands) {
				if (!inside(p, c)) fail("EDI-16", `pump #${p.id} not under the canopy #${c.id}`, cx(p), cy(p));
			}
			if (rectDist(c, b) < 80) {
				fail(
					"EDI-16",
					`canopy #${c.id} ${fmt(rectDist(c, b))} u from the shop (< 80: its facade)`,
					cx(c),
					cy(c),
				);
			}
		}
		// the price sign on its footing, in the forecourt, at the street corner (within 64 u of the cross street's side)
		const signs = gasSigns.filter(s => inside(s, apron));
		if (signs.length !== 1) {
			fail("EDI-16", `gas #${b.id}: ${signs.length} price signs on the forecourt (1)`, cx(apron), cy(apron));
		} else {
			const s = signs[0];
			const corner = alongX(b.doorSide)
				? Math.min(s.x - apron.x, apron.x + apron.w - (s.x + s.w))
				: Math.min(s.y - apron.y, apron.y + apron.h - (s.y + s.h));
			if (corner > 64)
				fail("EDI-16", `price sign #${s.id} ${fmt(corner)} u from the corner (> 64)`, cx(s), cy(s));
		}
		// a car at a pump: one per island at most, alongside it on its street side, PUMP_CAR_GAP off its curb, square
		// to it, and never in the door's approach (EDI-01 walks it; this names the culprit)
		const gap = W.PUMP_CAR_GAP ?? 12;
		for (const car of pumpCars.filter(c => inside(c, apron))) {
			const p = islands.find(q => rectDist(q, car) <= gap + 0.5);
			const m = p !== undefined ? NORMAL[p.face] : undefined;
			const long = car.w >= car.h;
			const street =
				m !== undefined &&
				(m[0] === 0 ? Math.sign(cy(car) - cy(p)) === m[1] : Math.sign(cx(car) - cx(p)) === m[0]);
			if (p === undefined || Math.abs(rectDist(p, car) - gap) > 0.5 || !street) {
				fail(
					"EDI-16",
					`car #${car.id} at the forecourt but not alongside an island's street side`,
					cx(car),
					cy(car),
				);
				continue;
			}
			if (long !== p.w >= p.h || Math.abs(long ? cx(car) - cx(p) : cy(car) - cy(p)) > 1) {
				fail("EDI-16", `car #${car.id} not square to and centred on pump #${p.id}`, cx(car), cy(car));
			}
			if (car.variant !== (W.PUMP_CAR_PARKED ?? 1) && car.variant !== (W.PUMP_CAR_FILLING ?? 2)) {
				fail("EDI-16", `car #${car.id}: unknown pump state ${car.variant}`, cx(car), cy(car));
			}
			if (pumpCars.filter(o => o !== car && rectDist(o, p) <= gap + 0.5).length > 0) {
				fail("EDI-16", `pump #${p.id} has two cars`, cx(p), cy(p));
			}
			for (const d of doors) {
				if (d.corridor && overlap(car, d.corridor)) {
					fail("EDI-16", `car #${car.id} in front of ${d.b.tags} #${d.b.id}'s door`, cx(car), cy(car));
				}
			}
		}
	}
	for (const p of pumps) {
		if (!islandsSeen.has(p)) fail("EDI-16", `pump #${p.id} is on no gas station's forecourt`, cx(p), cy(p));
	}
	for (const c of canopies) {
		if (!aprons.some(a => inside(c, a))) fail("EDI-16", `canopy #${c.id} over no forecourt`, cx(c), cy(c));
	}

	// --- EDI-18 / EDI-19: the everyday town's mix, and no kind repeated on every corner
	const mix = mixChecks(w, buildings, fail);

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

	// --- EDI-17: the college campus
	const campus = {};
	campusChecks(w, buildings, reach, fail, campus);

	// --- EDI-20, EDI-21, MOB-04..MOB-06: the market, the building site, the streets, the parks, the backyards
	const everyday = everydayChecks(w, buildings, reach, fail);

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
		// a car at a gas pump has its own rule (EDI-16, below): pulled up alongside an island, not parked on a street
		if (inParking(s) || pumpCars.includes(s)) continue;
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
				// the entrance where it meets the street face (the box's edge): a door set back into a porch or an
				// entrance court (EDI-14) is still the entrance of that stretch of sidewalk
				const b = d.b;
				const T2 = TOWN.WALL_T / 2;
				const fx = b.doorSide === "left" ? b.x + T2 : b.doorSide === "right" ? b.x + b.w - T2 : b.doorX;
				const fy = b.doorSide === "top" ? b.y + T2 : b.doorSide === "bottom" ? b.y + b.h - T2 : b.doorY;
				const door = edgeUV(e, fx, fy);
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
		mix,
		campus,
		bank,
		everyday,
	};
	return { fails, stats };
}

// ---------------------------------------------------------------- run

/** EDI-17 over the run: towns with a campus */
const CAMPUS_RUN = { towns: 0, campus: 0 };
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
	if (stats.campus?.present) {
		console.log(`  campus: block ${stats.campus.block} | quad: ${stats.campus.props}, ${stats.campus.trees} trees`);
	}
	CAMPUS_RUN.towns++;
	if (stats.campus?.present) CAMPUS_RUN.campus++;
	const ev = stats.everyday;
	if (ev !== undefined) {
		console.log(
			`  everyday: bank ${stats.bank ?? 0} | market ${ev.markets} (${ev.stalls} stalls, ${ev.stocked} stocked) | ` +
				`site ${ev.sites} (${ev.piles} piles) | public parking ${ev.parking} | playgrounds ${ev.playgrounds}, courts ${ev.courts} | ` +
				`street furniture ${ev.street} | backyard things ${ev.yard} (${ev.sheds} sheds)`,
		);
	}
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
// EDI-09 over the run: each type's share of buildings with all its doors
const shares = [];
for (const [t, run] of Object.entries(DOOR_RUN)) {
	const share = run.target / run.n;
	shares.push(`${TYPE_TAG[t]} ${(share * 100).toFixed(0)}% of ${run.n}`);
	if (share < DOOR_SHARE) {
		const msg = `${TYPE_TAG[t]}: only ${(share * 100).toFixed(0)}% of ${run.n} have their ${DOOR_TARGET[t]} doors (< ${DOOR_SHARE * 100}%)`;
		all.push({ rule: "EDI-09", msg, x: 0, y: 0 });
		total++;
		console.log(`  EDI-09 (run) ${msg}`);
	}
}
console.log(`  doors over the run (EDI-09, >= ${DOOR_SHARE * 100}% with all their doors): ${shares.join(", ")}`);
if (CAMPUS !== undefined) console.log(`  campus (EDI-17): in ${CAMPUS_RUN.campus} of ${CAMPUS_RUN.towns} towns`);
if (MARKS_FILE) writeFileSync(MARKS_FILE, JSON.stringify(all));
console.log(
	`${total === 0 ? "PASS" : "FAIL"}: ${seeds.length} seed(s), ${total} failure(s), ${fmt(performance.now() - t0)} ms`,
);
process.exit(total === 0 ? 0 : 1);
