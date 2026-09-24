#!/usr/bin/env node
/*
 * What the town generator makes, counted over the towns validate:world walks (docs/DESIGN_RULES.md EDI-19..EDI-23):
 * how many of each kind of building, house footprint, special lot, ground feature and street prop a town holds, and
 * how the non-house buildings repeat -- how far each one is from the nearest of its own kind, and how often two of a
 * kind share a block, a block face, a street across or a street corner (the owner, 2026-09-24: "Evitar repetições de
 * mercados, hospitais, etc em cada esquina").
 *
 *   node tools/town-census.mjs                     # the 5 fixed towns + the 20 of the CI sweep (validate:world --sweep 20)
 *   node tools/town-census.mjs 7331 42             # given seeds only
 *   node tools/town-census.mjs --sweep 20 --json out.json
 *   PZ_SRC=<another checkout>/src node tools/town-census.mjs   # the same count on another version (before / after)
 *
 * Read-only: it generates towns and counts; nothing is checked here (the rules are in validate-world.mjs).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { installShims } from "./luau-shim.mjs";

const { SRC, require } = installShims({ seed: 1 });
const W = require(join(SRC, "shared/game/world.ts"));
const { DESIGN, TOWN } = require(join(SRC, "shared/engine/constants.ts"));
const SP = require(join(SRC, "shared/data/spawns.ts"));
const { USABLES } = require(join(SRC, "shared/data/usables.ts"));
const { ETC_ITEMS } = require(join(SRC, "shared/data/etcItems.ts"));

/** the table a building type rolls (spawns.ts `spawnRows` where the version has it) */
const rowsOf = bt => (SP.spawnRows !== undefined ? SP.spawnRows(bt) : SP.BUILDING_SPAWNS[bt]) ?? SP.BUILDING_SPAWNS[0];
/** what a searchable fixture rolls (shared/data/spawns.ts YARD_LOOT: a stall's by what it sells, a pile's by what it is) */
const yardRows = (tag, variant) =>
	SP.YARD_LOOT?.[SP.yardLootKey !== undefined ? SP.yardLootKey(tag, variant) : tag] ?? SP.YARD_LOOT?.[tag];
const nameOf = (kind, index) => (kind === 3 ? USABLES[index]?.name : kind === 4 ? ETC_ITEMS[index]?.name : "") ?? "";
/** the loot categories of the economy (EDI-19): what a line of a table is */
function categoryOf(e) {
	const n = nameOf(e.kind, e.index);
	if (e.kind === 1) return "weapons";
	if (e.kind === 2) return "gear";
	if (e.kind === 3) return /first aid|pain killer|bandage|adrenaline|sedative/i.test(n) ? "medical" : "food";
	if (e.index >= 44 && e.index <= 47) return "ammo";
	if (e.index === 33) return "ammo";
	if (e.index === 48) return "oil";
	if ([23, 24, 25, 26, 27, 28, 34, 41].includes(e.index)) return "materials";
	return "parts";
}
/** expected items of each category from one slot of `rows` (a line is picked at random, then its chance or range) */
function perSlot(rows) {
	const out = {};
	for (const e of rows) {
		const n = e.max < 1 ? e.max : (e.min + e.max) / 2;
		const c = categoryOf(e);
		out[c] = (out[c] ?? 0) + n / rows.length;
	}
	return out;
}

const args = process.argv.slice(2);
const at = k => args.indexOf(k);
const valueAt = new Set([at("--sweep"), at("--sweep-base"), at("--json")].filter(i => i >= 0).map(i => i + 1));
const seeds = args.filter((a, i) => /^-?\d+$/.test(a) && !valueAt.has(i)).map(Number);
const explicit = seeds.length > 0;
if (!explicit) seeds.push(DESIGN.TOWN_SEED, 1, 42, 99991, 123456);
const SWEEP = at("--sweep") >= 0 ? Number(args[at("--sweep") + 1]) : explicit ? 0 : 20;
if (SWEEP > 0) {
	// the seeds validate-world.mjs --sweep draws (MINSTD from 20260923): the same towns
	let st = at("--sweep-base") >= 0 ? Number(args[at("--sweep-base") + 1]) % 2147483647 : 20260923;
	if (st <= 0) st = 1;
	for (let i = 0; i < SWEEP; i++) {
		st = (st * 48271) % 2147483647;
		seeds.push(st % 2147483646 || 1);
	}
}
const JSON_OUT = at("--json") >= 0 ? args[at("--json") + 1] : undefined;

const cx = s => s.x + s.w / 2;
const cy = s => s.y + s.h / 2;
const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
/** a building's kind for the census: its tag, the corner grocery apart from the supermarket (both "market") */
const kindOf = b => (b.buildingType === 8 ? "grocery" : b.tags);
const median = a => {
	if (a.length === 0) return NaN;
	const s = [...a].sort((p, q) => p - q);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** a house's footprint class, by its box (the generator's HOUSE_DEFS, either way round) */
function houseClass(b) {
	const a = Math.max(b.w, b.h);
	const c = Math.min(b.w, b.h);
	if (a >= 1000) return "house XL (1068²)";
	if (a >= 800) return "house large (808×684)";
	if (a >= 680 && c >= 540) return "house medium (684×556)";
	if (c >= 420) return "house small (428×552)";
	return `house ${a}×${c}`;
}

function census(seed) {
	const w = W.generateTown(seed);
	const S = w.solids;
	const buildings = S.filter(s => s.kind === "building");
	const out = { seed, types: {}, houses: {}, lots: {}, ground: {}, props: {}, rep: {}, loot: {}, vault: {} };
	const bump = (o, k, n = 1) => (o[k] = (o[k] ?? 0) + n);
	// the loot a whole town holds at once (every building searched, every pump drained: one respawn, 12 game hours)
	for (const s of S) {
		let rows;
		const slots = s.lootSlots ?? 0;
		// the bank's vault (EDI-24): every box once, and once a world -- counted apart, not in the respawn's loot
		if (s.kind === "prop" && s.tags === "vault") {
			for (const e of SP.VAULT_LOOT ?? []) {
				bump(out.vault, categoryOf(e), e.max < 1 ? e.max : (e.min + e.max) / 2);
			}
			continue;
		}
		if (s.kind === "building") rows = rowsOf(s.buildingType ?? 0);
		else if (s.tags === "pump") rows = SP.PUMP_LOOT;
		else if (s.lootSlots !== undefined) rows = yardRows(s.tags, s.variant);
		if (rows === undefined || slots <= 0) continue;
		const per = perSlot(rows);
		for (const [c, n] of Object.entries(per)) bump(out.loot, c, n * slots);
	}
	// the lot grid (column / row of every lot: Chebyshev "blocks" between two buildings)
	const xs = [...new Set(w.lots.map(l => l.x))].sort((a, b) => a - b);
	const ys = [...new Set(w.lots.map(l => l.y))].sort((a, b) => a - b);
	const lotOf = b => w.lots.find(l => inside({ x: cx(b), y: cy(b) }, l));
	const cell = l => ({ c: xs.indexOf(l.x), r: ys.indexOf(l.y) });
	for (const b of buildings) {
		bump(out.types, kindOf(b));
		if (b.buildingType === 1 || b.buildingType === 2) bump(out.houses, houseClass(b));
	}
	for (const l of w.lots) {
		const program = l.program ?? (l.kind === "block" ? l.zone : l.kind);
		bump(out.lots, program);
		for (const g of l.ground ?? []) bump(out.ground, g.kind);
	}
	for (const s of S) {
		if (s.kind === "building" || s.parentId !== undefined || s.tags === "border") continue;
		let key = s.tags;
		if (s.kind === "tree") key = "tree";
		else if (s.tags === "car") {
			const askew =
				s.heading !== undefined &&
				Math.abs(s.heading / (Math.PI / 2) - Math.round(s.heading / (Math.PI / 2))) > 0.01;
			key = askew ? "car (abandoned askew)" : "car";
		}
		bump(out.props, key);
	}
	// repetition, per non-house type
	const juncs = w.junctions;
	const nearestJunction = b => {
		let best;
		let bd = Infinity;
		for (const j of juncs) {
			const d = Math.hypot(
				Math.max(j.x - cx(b), 0, cx(b) - j.x - j.w),
				Math.max(j.y - cy(b), 0, cy(b) - j.y - j.h),
			);
			if (d < bd) {
				bd = d;
				best = j;
			}
		}
		return { j: best, d: bd };
	};
	const byType = new Map();
	for (const b of buildings) {
		if (b.buildingType <= 2) continue;
		if (!byType.has(kindOf(b))) byType.set(kindOf(b), []);
		byType.get(kindOf(b)).push(b);
	}
	for (const [tag, list] of byType) {
		const r = {
			n: list.length,
			nearest: [],
			nearestBlocks: [],
			sameBlock: 0,
			sameFace: 0,
			across: 0,
			sameCorner: 0,
		};
		const info = list.map(b => ({ b, lot: lotOf(b), jn: nearestJunction(b) }));
		for (let i = 0; i < info.length; i++) {
			let nd = Infinity;
			let nb = Infinity;
			for (let k = 0; k < info.length; k++) {
				if (k === i) continue;
				const a = info[i];
				const o = info[k];
				nd = Math.min(nd, Math.hypot(cx(a.b) - cx(o.b), cy(a.b) - cy(o.b)));
				if (a.lot && o.lot) {
					const p = cell(a.lot);
					const q = cell(o.lot);
					nb = Math.min(nb, Math.max(Math.abs(p.c - q.c), Math.abs(p.r - q.r)));
				}
				if (k < i) continue;
				if (a.lot && a.lot === o.lot) {
					r.sameBlock++;
					if (a.b.doorSide === o.b.doorSide) r.sameFace++;
				}
				// across the street: the doors face each other over one road, close along it
				const opp = { top: "bottom", bottom: "top", left: "right", right: "left" }[a.b.doorSide];
				if (o.b.doorSide === opp && a.lot !== o.lot) {
					const alongX = opp === "top" || opp === "bottom";
					const du = alongX ? Math.abs(a.b.doorX - o.b.doorX) : Math.abs(a.b.doorY - o.b.doorY);
					const dv = alongX ? Math.abs(a.b.doorY - o.b.doorY) : Math.abs(a.b.doorX - o.b.doorX);
					if (du < 700 && dv < TOWN.AVENUE_W + TOWN.SIDEWALK * 2 + 700) r.across++;
				}
				// the same street corner: both next to the same crossing
				if (a.jn.j === o.jn.j && a.jn.d < 700 && o.jn.d < 700) r.sameCorner++;
			}
			if (nd < Infinity) r.nearest.push(nd);
			if (nb < Infinity) r.nearestBlocks.push(nb);
		}
		out.rep[tag] = r;
	}
	return out;
}

const all = [];
for (const seed of seeds) all.push(census(seed));

// ---------------------------------------------------------------- the report
const keysOf = f => [...new Set(all.flatMap(c => Object.keys(f(c))))].sort();
const stats = (f, k) => {
	const v = all.map(c => f(c)[k] ?? 0);
	const mean = v.reduce((a, b) => a + b, 0) / v.length;
	return { mean, min: Math.min(...v), max: Math.max(...v) };
};
const fmtS = s => `${s.mean.toFixed(1).padStart(6)}  (${s.min}–${s.max})`;
console.log(`town census: ${all.length} towns (src ${SRC})\n`);
for (const [title, f] of [
	["buildings per town", c => c.types],
	["house footprints per town", c => c.houses],
	["lots per town (program)", c => c.lots],
	["ground features per town", c => c.ground],
	["props per town (not buildings)", c => c.props],
]) {
	console.log(title);
	for (const k of keysOf(f)) console.log(`  ${k.padEnd(28)} ${fmtS(stats(f, k))}`);
	console.log("");
}
console.log("loot a town holds per respawn (expected items: every building searched, every container drained)");
for (const k of keysOf(c => c.loot)) {
	const s = stats(c => c.loot, k);
	console.log(`  ${k.padEnd(28)} ${s.mean.toFixed(1).padStart(6)}  (${s.min.toFixed(1)}–${s.max.toFixed(1)})`);
}
console.log("");
if (keysOf(c => c.vault).length > 0) {
	console.log("the bank's vault, once a world (expected items: every box rolled once, EDI-24)");
	for (const k of keysOf(c => c.vault)) {
		const s = stats(c => c.vault, k);
		console.log(`  ${k.padEnd(28)} ${s.mean.toFixed(2).padStart(6)}`);
	}
	console.log("");
}
console.log("repetition of the non-house buildings (over every town; distances centre to centre, in world units)");
console.log(
	"  type          n/town   nearest same min  median   blocks min/med   same block  same face  across street  same corner",
);
const repKeys = keysOf(c => c.rep);
const summary = {};
for (const k of repKeys) {
	const rs = all.map(c => c.rep[k]).filter(Boolean);
	const near = rs.flatMap(r => r.nearest);
	const blocks = rs.flatMap(r => r.nearestBlocks);
	const sum = f => rs.reduce((a, r) => a + r[f], 0);
	const n = rs.reduce((a, r) => a + r.n, 0) / all.length;
	const row = {
		perTown: n,
		nearestMin: near.length ? Math.min(...near) : NaN,
		nearestMedian: median(near),
		blocksMin: blocks.length ? Math.min(...blocks) : NaN,
		blocksMedian: median(blocks),
		sameBlock: sum("sameBlock"),
		sameFace: sum("sameFace"),
		across: sum("across"),
		sameCorner: sum("sameCorner"),
	};
	summary[k] = row;
	console.log(
		`  ${k.padEnd(12)} ${n.toFixed(1).padStart(6)}   ${String(Math.round(row.nearestMin)).padStart(8)}  ${String(Math.round(row.nearestMedian)).padStart(6)}   ${String(row.blocksMin).padStart(6)} / ${String(row.blocksMedian).padEnd(4)}  ${String(row.sameBlock).padStart(10)}  ${String(row.sameFace).padStart(9)}  ${String(row.across).padStart(13)}  ${String(row.sameCorner).padStart(11)}`,
	);
}
console.log(`\n(pairs are summed over all ${all.length} towns)`);
if (JSON_OUT) {
	const flat = f => Object.fromEntries(keysOf(f).map(k => [k, stats(f, k)]));
	writeFileSync(
		JSON_OUT,
		`${JSON.stringify(
			{
				towns: all.length,
				seeds,
				buildings: flat(c => c.types),
				houses: flat(c => c.houses),
				lots: flat(c => c.lots),
				ground: flat(c => c.ground),
				props: flat(c => c.props),
				loot: flat(c => c.loot),
				repetition: summary,
			},
			undefined,
			"\t",
		)}\n`,
	);
	console.log(`wrote ${JSON_OUT}`);
}
