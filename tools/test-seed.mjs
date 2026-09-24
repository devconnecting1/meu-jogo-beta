#!/usr/bin/env node
/*
 * One seed, one town, on every machine (docs/DESIGN_RULES.md MP-26, docs/MULTIPLAYER.md §4.9).
 *
 *   npm run test:seed                       # 24 seeds (exit code 1 on any failure)
 *   node tools/test-seed.mjs --seeds 60     # more seeds
 *   PZ_SRC=<another checkout>/src node tools/test-seed.mjs   (measures that version)
 *
 * The owner (2026-09-24): the town is the SERVER's, as a seed. That only works if the seed is ALL a town is made of:
 * the server generates its copy (server/net/mpHost.ts at boot, server/sim/worldReset.ts at a world's end, a slice per
 * frame) and every client generates its own from the same number (client/boot/townCache.ts: the lobby's, a slice per
 * frame; the match takes it) -- and they must agree to the last solid, or every prediction, every door and every
 * wall the client collides with is a different world from the server's (§4.5: only the deltas travel). This suite
 * runs the REAL generator under Node, seed after seed, and checks:
 *
 *   1. SERVER = CLIENT     the server's boot town (serverWorld(generateTown(seed))), its world-reset town (sliced
 *                          through a yielding `pace`), the lobby's town (townCache.requestTown: the slices of a frame)
 *                          and the match's (townCache.takeTown) are the SAME town: every solid with every field, every
 *                          lot, road, crossing and ground rect, both spatial grids cell by cell, the id counter, the
 *                          map hash of §4.5 and the hand-over fingerprint. Only `nextDynamicId` differs, on purpose
 *                          (the server's own ids start there).
 *   2. SLICED = WHOLE      a pace that yields everywhere, one that allocates and draws math.random in between, and one
 *                          that generates ANOTHER town in the same VM while this one waits (the client does exactly that
 *                          when a match needs a town while the lobby's is half made): the same town.
 *   3. ONLY THE SEED       during generateTown(seed) the engine's clocks, random numbers and services are poisoned
 *                          (a read throws): none is read. Map and Set iterate in reverse and every sort breaks ties the
 *                          other way (Luau's pairs() order is the VM's, and its table.sort is not stable): the same town.
 *   4. ANY LIBM            sin, cos, atan2, tan, exp, log and pow one ulp above or below (another platform's libm),
 *                          and 1e-3 off for every angle-sized argument: the SOLIDS stay the same to the bit -- only
 *                          what each client draws reads them (a car's paint and heading, a roof's colour, a canopy's
 *                          radius). The abandoned cars' collision rects used to be floored from math.cos/sin
 *                          (world.ts smallSin/smallCos now). The one solid decision left on math.sin -- a car at a gas
 *                          pump (EDI-16), through hash01 -- is measured: its nearest hash to the threshold, against
 *                          what a one-ulp libm difference can move it by.
 *
 * Pure Node (>= 18) plus the project's TypeScript, on the shims of tools/ui-shim.mjs.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { installUiShims } from "./ui-shim.mjs";

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};
const N_SEEDS = Math.max(4, argValue("--seeds", 24));

const ui = installUiShims({ seed: 1, viewport: [1920, 1080] });
const { SRC, require, flush, service } = ui;
globalThis.print = () => {};

const W = require(join(SRC, "shared/game/world.ts"));
const Cache = require(join(SRC, "client/boot/townCache.ts"));
const { mapHashOf } = require(join(SRC, "server/net/replication.ts"));
const { pickTownSeed } = require(join(SRC, "server/sim/worldReset.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const CFG = require(join(SRC, "shared/net/mpConfig.ts"));
flush();
const RunService = service("RunService");
const frame = () => {
	RunService.RenderStepped.Fire(1 / 60);
	flush();
};

// ---------------------------------------------------------------- checks

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
	checks += 1;
	const tail = detail === undefined ? "" : `  (${detail})`;
	if (ok) console.log(`  ok    ${name}${tail}`);
	else {
		failures += 1;
		console.error(`  FALHA ${name}${tail}`);
	}
	return ok;
}
function section(title) {
	console.log(`\n${title}\n`);
}

// ---------------------------------------------------------------- a town, in canonical form

/** fields a client DRAWS and nothing reads for a rule: they may take the platform's libm (world.ts hash01) */
const VISUAL = new Set(["tint", "roofColor", "canopyR", "canopyAlpha", "heading"]);
/** bookkeeping of the spatial grids' queries (world.ts querySolids): only grows, never changes an answer */
const BOOKKEEPING = new Set(["gridStamp"]);

function sortedValue(v, drop) {
	if (v === null || typeof v !== "object") return v;
	if (v instanceof Color3) return { R: v.R, G: v.G, B: v.B };
	if (Array.isArray(v)) return v.map(x => sortedValue(x, drop));
	const out = {};
	for (const k of Object.keys(v).sort()) if (!drop.has(k)) out[k] = sortedValue(v[k], drop);
	return out;
}

function gridOf(g) {
	return { cell: g.cell, cols: g.cols, rows: g.rows, count: g.count, cells: g.cells.map(c => c.map(s => s.id)) };
}

/**
 * Every part of a town as one string: the solids (every field but the bookkeeping, and the visual ones unless
 * `visual`), the ground (lots, roads, junctions, crossings), the boss anchors, the items, the id counter and both
 * spatial grids as cell -> ids. `nextDynamicId` is left out: the server's own counter, set after generation.
 */
function canon(w, { visual = true } = {}) {
	const drop = new Set(BOOKKEEPING);
	if (!visual) for (const k of VISUAL) drop.add(k);
	return JSON.stringify({
		width: w.width,
		height: w.height,
		nextId: w.nextId,
		solids: w.solids.map(s => sortedValue(s, drop)),
		items: sortedValue(w.items, drop),
		roads: sortedValue(w.roads, drop),
		lots: sortedValue(w.lots, drop),
		junctions: sortedValue(w.junctions, drop),
		crossings: sortedValue(w.crossings, drop),
		bossAnchors: sortedValue(w.bossAnchors, drop),
		grid: gridOf(w.grid),
		fine: gridOf(w.fine),
	});
}
const digest = s => createHash("sha1").update(s).digest("hex").slice(0, 12);
/** the first place two canonical strings part, for a failure worth reading */
function firstDiff(a, b) {
	if (a === b) return "igual";
	let i = 0;
	while (i < a.length && a[i] === b[i]) i++;
	return `difere no caractere ${i}: …${a.slice(Math.max(0, i - 80), i + 60)}… vs …${b.slice(Math.max(0, i - 80), i + 60)}…`;
}

/** runs `fn` with the given globals swapped in, and always puts them back */
function withGlobals(patch, fn) {
	const saved = [];
	for (const [obj, key, value] of patch) {
		saved.push([obj, key, Object.getOwnPropertyDescriptor(obj, key)]);
		Object.defineProperty(obj, key, { value, configurable: true, writable: true, enumerable: false });
	}
	try {
		return fn();
	} finally {
		for (const [obj, key, desc] of saved.reverse()) {
			if (desc === undefined) delete obj[key];
			else Object.defineProperty(obj, key, desc);
		}
	}
}

// ---------------------------------------------------------------- the seeds

const FIXED = [DESIGN.TOWN_SEED, 1, 2, 3, 42, 99991, 424242, 1234567, CFG.TOWN_SEED_MAX, CFG.TOWN_SEED_MAX - 1];
const SEEDS = [...FIXED];
let prev = 0;
while (SEEDS.length < N_SEEDS) {
	// drawn as the server draws them (server/sim/worldReset.ts pickTownSeed: any whole 1 … TOWN_SEED_MAX)
	prev = pickTownSeed(prev);
	if (!SEEDS.includes(prev)) SEEDS.push(prev);
}
console.log(`Semente = cidade: ${SEEDS.length} sementes (${SEEDS.slice(0, 12).join(", ")}, …); fonte ${SRC}`);

// ================================================================ 1. server = client

section("1) servidor = cliente: a mesma semente e a mesma cidade, solido por solido, grade por grade");
{
	let same = 0;
	let hashes = 0;
	let prints = 0;
	let paced = 0;
	const bad = [];
	for (const seed of SEEDS) {
		// the server: boot (serverWorld after generateTown) and a world's end (generateTown sliced by a yielding pace)
		const boot = W.serverWorld(W.generateTown(seed));
		let slices = 0;
		const reset = W.generateTown(seed, () => {
			slices += 1;
		});
		// the client: the lobby's town a slice per frame, and the match taking it; then a match with nothing cached
		Cache.requestTown(seed);
		frame();
		const lobby = Cache.readyTown(seed);
		const match = Cache.takeTown(seed);
		const cold = Cache.takeTown(seed);
		const ref = canon(boot);
		const all = [
			["reset", reset],
			["lobby", lobby],
			["match", match],
			["cold", cold],
		];
		let ok = lobby !== undefined && match === lobby && slices > 0;
		for (const [name, w] of all) {
			if (w === undefined) {
				ok = false;
				bad.push(`${seed} ${name}: nenhuma`);
				continue;
			}
			const c = canon(w);
			if (c !== ref) {
				ok = false;
				bad.push(`${seed} ${name}: ${firstDiff(ref, c)}`);
			}
		}
		if (ok) same += 1;
		const h = mapHashOf(boot);
		if ([reset, lobby, cold].every(w => w !== undefined && mapHashOf(w) === h)) hashes += 1;
		if (
			[reset, lobby, cold].every(w => w !== undefined && Cache.townFingerprint(w) === Cache.townFingerprint(cold))
		)
			prints += 1;
		if (boot.nextDynamicId === Math.max(CFG.DYNAMIC_ID_BASE, boot.nextId + 1) && lobby?.nextDynamicId === 0)
			paced += 1;
	}
	check(
		"boot do servidor, reset do servidor (em fatias), lobby do cliente (em fatias) e partida do cliente: a MESMA cidade",
		same === SEEDS.length,
		`${same}/${SEEDS.length} sementes${bad.length > 0 ? `; ${bad.slice(0, 2).join(" | ")}` : ""}`,
	);
	check(
		"...o mesmo mapHash do §4.5 (o que o cliente confere ao entrar)",
		hashes === SEEDS.length,
		`${hashes}/${SEEDS.length}`,
	);
	check(
		"...a mesma impressao digital da entrega (townCache.townFingerprint)",
		prints === SEEDS.length,
		`${prints}/${SEEDS.length}`,
	);
	check(
		"...e so o contador dinamico difere, de proposito: o do servidor comeca em DYNAMIC_ID_BASE, o do cliente fica em 0",
		paced === SEEDS.length,
		`${paced}/${SEEDS.length}`,
	);
	// two seeds, two towns (the seed IS the town): not a generator that ignores its input
	const distinct = new Set(SEEDS.slice(0, 8).map(s => digest(canon(W.generateTown(s)))));
	check("sementes diferentes dao cidades diferentes", distinct.size() === 8, `${distinct.size()} de 8`);
}

// ================================================================ 2. sliced = whole

section("2) em fatias = inteira: ceder, trabalhar e ate gerar OUTRA cidade entre duas fatias nao muda nada");
{
	let yieldEverywhere = 0;
	let noisy = 0;
	let interleaved = 0;
	const bad = [];
	for (const seed of SEEDS) {
		const whole = canon(W.generateTown(seed));
		// yields at every pace point: what a very slow frame would do
		const y0 = globalThis.coroutine.yields;
		let calls = 0;
		const everywhere = W.generateTown(seed, () => {
			calls += 1;
			globalThis.coroutine.yield();
		});
		if (canon(everywhere) === whole && globalThis.coroutine.yields - y0 === calls) yieldEverywhere += 1;
		else bad.push(`${seed} yield`);
		// work between the slices: allocations, math.random draws, a sort, a Map -- the rest of the client's frame
		const junk = [];
		const busy = W.generateTown(seed, () => {
			for (let i = 0; i < 20; i++) junk.push({ r: math.random(), m: new Map([[i, {}]]) });
			junk.sort((a, b) => a.r < b.r);
			if (junk.length > 400) junk.length = 0;
		});
		if (canon(busy) === whole) noisy += 1;
		else bad.push(`${seed} ruido: ${firstDiff(whole, canon(busy))}`);
		// ANOTHER town generated whole while this one waits between two buildings (a match needing its town while the
		// lobby's is half made; interiors.ts shares its scratch grids between planners, one building at a time)
		const other = SEEDS[(SEEDS.indexOf(seed) + 1) % SEEDS.length];
		let n = 0;
		const wait = W.generateTown(seed, () => {
			n += 1;
			if (n === 40 || n === 200) W.generateTown(other);
		});
		if (canon(wait) === whole) interleaved += 1;
		else bad.push(`${seed} intercalada: ${firstDiff(whole, canon(wait))}`);
	}
	check(
		"cedendo em todo ponto de pausa: a mesma cidade",
		yieldEverywhere === SEEDS.length,
		`${yieldEverywhere}/${SEEDS.length}`,
	);
	check(
		"com trabalho entre as fatias (alocacao, math.random, sort, Map): a mesma cidade",
		noisy === SEEDS.length,
		`${noisy}/${SEEDS.length}${bad.length > 0 ? `; ${bad[0]}` : ""}`,
	);
	check(
		"com OUTRA cidade gerada inteira no meio desta (duas vezes): a mesma cidade -- nenhum estado vaza entre elas",
		interleaved === SEEDS.length,
		`${interleaved}/${SEEDS.length}`,
	);
	// and the same town again after every other generation of this run: nothing accumulates in the modules
	check(
		"gerar de novo depois de tudo isso: a mesma de antes (nada se acumula nos modulos)",
		canon(W.generateTown(SEEDS[0])) === canon(W.serverWorld(W.generateTown(SEEDS[0]))),
	);
}

// ================================================================ 3. only the seed

section("3) so a semente: relogio, sorteio e servicos envenenados; Map e sort ao contrario");
{
	const poison = what => () => {
		throw new Error(`generateTown read ${what}`);
	};
	let clean = 0;
	const bad = [];
	for (const seed of SEEDS) {
		const whole = canon(W.generateTown(seed));
		let got;
		try {
			got = withGlobals(
				[
					[globalThis.math, "random", poison("math.random")],
					[globalThis.os, "clock", poison("os.clock")],
					[globalThis.os, "time", poison("os.time")],
					[globalThis, "tick", poison("tick()")],
					[globalThis, "time", poison("time()")],
					[globalThis, "Random", poison("Random")],
					[globalThis, "game", { GetService: poison("game:GetService") }],
					[globalThis, "workspace", undefined],
				],
				() => W.generateTown(seed),
			);
		} catch (e) {
			bad.push(`${seed}: ${e.message}`);
			continue;
		}
		if (canon(got) === whole) clean += 1;
		else bad.push(`${seed}: outra cidade`);
	}
	check(
		"nenhum relogio (os.clock, os.time, tick, time), nenhum sorteio (math.random, Random) e nenhum servico e lido",
		clean === SEEDS.length,
		`${clean}/${SEEDS.length}${bad.length > 0 ? `; ${bad[0]}` : ""}`,
	);
	// the seed 0 IS a random town: that one does draw (and the server never asks for it)
	let drew = false;
	try {
		withGlobals([[globalThis.math, "random", poison("math.random")]], () => W.generateTown(0));
	} catch {
		drew = true;
	}
	check("...a nao ser a semente 0 (cidade aleatoria), que sorteia -- e que ninguem pede mais", drew);

	// Map / Set iteration in reverse (pairs() order is the VM's), sort ties the other way (table.sort is not stable)
	const reversedIter = proto => {
		const entries = proto.entries;
		const values = proto.values;
		const keys = proto.keys;
		const forEach = proto.forEach;
		return [
			[
				proto,
				Symbol.iterator,
				function () {
					return [...entries.call(this)].reverse()[Symbol.iterator]();
				},
			],
			[
				proto,
				"entries",
				function () {
					return [...entries.call(this)].reverse()[Symbol.iterator]();
				},
			],
			[
				proto,
				"values",
				function () {
					return [...values.call(this)].reverse()[Symbol.iterator]();
				},
			],
			[
				proto,
				"keys",
				function () {
					return [...keys.call(this)].reverse()[Symbol.iterator]();
				},
			],
			[
				proto,
				"forEach",
				function (fn, self) {
					const all = [];
					forEach.call(this, (v, k) => all.push([v, k]));
					for (const [v, k] of all.reverse()) fn.call(self, v, k, this);
				},
			],
		];
	};
	const setIter = () => {
		const values = Set.prototype.values;
		const it = function () {
			return [...values.call(this)].reverse()[Symbol.iterator]();
		};
		return [
			[Set.prototype, Symbol.iterator, it],
			[Set.prototype, "values", it],
			[Set.prototype, "keys", it],
		];
	};
	const shimSort = Array.prototype.sort;
	const tiesReversed = [
		[
			Array.prototype,
			"sort",
			function (cmp) {
				// a stable sort of the reversed array: every run of equal elements comes out in the other order
				Array.prototype.reverse.call(this);
				return shimSort.call(this, cmp);
			},
		],
	];
	let orderFree = 0;
	let sortFree = 0;
	const orderBad = [];
	for (const seed of SEEDS) {
		const whole = canon(W.generateTown(seed));
		const mapsBack = withGlobals([...reversedIter(Map.prototype), ...setIter()], () => W.generateTown(seed));
		if (canon(mapsBack) === whole) orderFree += 1;
		else orderBad.push(`${seed} Map: ${firstDiff(whole, canon(mapsBack))}`);
		const tiesBack = withGlobals(tiesReversed, () => W.generateTown(seed));
		if (canon(tiesBack) === whole) sortFree += 1;
		else orderBad.push(`${seed} sort: ${firstDiff(whole, canon(tiesBack))}`);
	}
	check(
		"Map e Set iterados ao contrario: a mesma cidade (a ordem de pairs() do Luau nao entra)",
		orderFree === SEEDS.length,
		`${orderFree}/${SEEDS.length}${orderBad.length > 0 ? `; ${orderBad[0]}` : ""}`,
	);
	check(
		"empates de sort na ordem contraria: a mesma cidade (o table.sort do Luau nao e estavel)",
		sortFree === SEEDS.length,
		`${sortFree}/${SEEDS.length}${orderBad.length > 0 ? `; ${orderBad[orderBad.length - 1]}` : ""}`,
	);
}

// ================================================================ 4. any libm

section(
	"4) qualquer libm: seno, cosseno & cia. de outra plataforma so mudam o que cada cliente desenha, nunca um solido",
);
{
	/** the next / previous double: one ulp, the most two IEEE-754 libms of the same function honestly disagree by */
	const f64 = new Float64Array(1);
	const i64 = new BigInt64Array(f64.buffer);
	const ulp = (x, dir) => {
		if (!Number.isFinite(x) || x === 0) return x + dir * Number.MIN_VALUE;
		f64[0] = x;
		i64[0] += x > 0 === dir > 0 ? 1n : -1n;
		return f64[0];
	};
	const oneUlp =
		dir =>
		f =>
		(...args) =>
			ulp(f(...args), dir);
	/**
	 * Far off (1e-3) -- but only for an ANGLE-sized argument (|x| ≤ 8 rad): what a rect could be floored from. hash01's
	 * arguments are thousands of radians (a position times 12.9898 + 78.233): those take the one-ulp error of item (a).
	 */
	const farOnAngles =
		f =>
		(...args) => {
			const r = f(...args);
			return Math.abs(args[0]) <= 8 ? r + r * 1e-3 + 1e-9 : ulp(r, 1);
		};
	const log = (x, b) => (b === undefined ? Math.log(x) : Math.log(x) / Math.log(b));
	const libmWith = wrap => [
		[globalThis.math, "sin", wrap(Math.sin)],
		[globalThis.math, "cos", wrap(Math.cos)],
		[globalThis.math, "tan", wrap(Math.tan)],
		[globalThis.math, "atan2", wrap(Math.atan2)],
		[globalThis.math, "exp", wrap(Math.exp)],
		[globalThis.math, "log", wrap(log)],
		[globalThis.math, "pow", wrap(Math.pow)],
	];
	const variants = [
		["(a) outra plataforma: toda funcao da libm um ulp acima", libmWith(oneUlp(1))],
		["(a') ...e um ulp abaixo", libmWith(oneUlp(-1))],
		["(b) angulos 1e-3 fora (o que um retangulo poderia ler)", libmWith(farOnAngles)],
	];
	let abandoned = 0;
	for (const [name, libm] of variants) {
		let solidSame = 0;
		let visualMoved = 0;
		const bad = [];
		for (const seed of SEEDS) {
			const ref = W.generateTown(seed);
			const other = withGlobals(libm, () => W.generateTown(seed));
			const a = canon(ref, { visual: false });
			const b = canon(other, { visual: false });
			if (a === b) solidSame += 1;
			else bad.push(`${seed}: ${firstDiff(a, b)}`);
			if (canon(ref) !== canon(other)) visualMoved += 1;
			if (name.startsWith("(b)")) {
				// the cars askew in a lane: the ones whose collision rect is computed from an angle
				abandoned += ref.solids.filter(s => {
					if (s.kind !== "car" || s.tags !== "car") return false;
					const k = s.heading / (Math.PI / 2);
					return Math.abs(k - Math.round(k)) * (Math.PI / 2) > 0.05;
				}).length;
			}
		}
		check(
			`${name}: TODO solido, lote, rua e celula de grade identicos, bit a bit`,
			solidSame === SEEDS.length,
			`${solidSame}/${SEEDS.length}${bad.length > 0 ? `; ${bad[0]}` : ""}`,
		);
		if (name.startsWith("(b)")) {
			check(
				"...e a troca valeu mesmo (o rumo dos carros, desenhado, mudou)",
				visualMoved === SEEDS.length,
				`${visualMoved}/${SEEDS.length}`,
			);
		}
	}
	check(
		"...inclusive os carros abandonados de lado, cujo retangulo de colisao vem do angulo (smallSin/smallCos)",
		abandoned > SEEDS.length,
		`${abandoned} carros de lado em ${SEEDS.length} cidades`,
	);
	// smallSin / smallCos are the real sin / cos where the generator uses them (0.1-0.24 rad), to the last bits: the
	// town they build is the one the libm built before (npm run test:world-art pins its drawing to a golden)
	let worst = 0;
	for (let i = 0; i <= 1000; i++) {
		const x = (i / 1000) * 0.5;
		worst = Math.max(worst, Math.abs(W.smallSin(x) - Math.sin(x)), Math.abs(W.smallCos(x) - Math.cos(x)));
	}
	check(
		"...e smallSin/smallCos sao o seno e o cosseno de verdade em 0-0,5 rad (a 1e-15)",
		worst < 1e-15,
		`${worst.toExponential(2)}`,
	);

	/*
	 * The one place a SOLID still reads math.sin (EDI-16, main's gas station, kept byte for byte): hash01 of a pump
	 * island decides whether a car stands at it (PUMP_CAR_SHARE) and whether it is filling (PUMP_FILLING_SHARE). A
	 * libm one ulp apart moves sin by at most 2^-53, so hash01 by at most 43758.5453 x 2^-52 ~ 1e-11 (the argument is
	 * exact: IEEE-754 products and sums); the decision flips only if the hash lies closer than that to its threshold. Measured here on every island of every seed: the
	 * nearest one, and how many of those errors would fit in the gap (accepted limit, docs/MULTIPLAYER.md §4.9).
	 */
	const src = require("node:fs").readFileSync(join(SRC, "shared/game/world.ts"), "utf8");
	const share = name => Number(new RegExp(`const ${name} = ([0-9.]+);`).exec(src)?.[1]);
	const carShare = share("PUMP_CAR_SHARE");
	const fillShare = share("PUMP_FILLING_SHARE");
	let islands = 0;
	let nearest = 1;
	for (const seed of SEEDS) {
		for (const s of W.generateTown(seed).solids) {
			if (s.tags !== "pump") continue;
			islands += 1;
			nearest = Math.min(
				nearest,
				Math.abs(W.hash01(s.x, s.y, 83) - carShare),
				Math.abs(W.hash01(s.x, s.y, 84) - fillShare),
			);
		}
	}
	const oneUlpShift = 43758.5453 * 2 ** -52;
	check(
		"o posto (EDI-16): as decisoes do carro na bomba passam pelo hash01, e nenhuma fica a menos de 1e-6 do limiar",
		Number.isFinite(carShare) && Number.isFinite(fillShare) && islands > SEEDS.length && nearest > 1e-6,
		`${islands} ilhas; a mais perto a ${nearest.toExponential(2)} do limiar, ${(nearest / oneUlpShift).toExponential(1)}` +
			" vezes o que um ulp move o hash (limite aceito, MULTIPLAYER.md §4.9)",
	);
}

// ================================================================ verdict

console.log("");
if (failures > 0) {
	console.error(`${failures} de ${checks} verificacao(oes) falharam`);
	process.exit(1);
}
console.log(
	`OK: ${checks} verificacoes em ${SEEDS.length} sementes -- a semente do servidor e a cidade, a mesma em todo lugar, em fatias ou inteira, com qualquer libm`,
);
