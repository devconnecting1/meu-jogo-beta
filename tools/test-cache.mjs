#!/usr/bin/env node
/*
 * What the client caches, and what that saves (the owner, 2026-09-23: "does Roblox have a cache system, and would
 * caching make the game better?").
 *
 *   npm run test:cache
 *   PZ_SRC=<another checkout>/src node tools/test-cache.mjs    (measures that version)
 *
 * The engine already caches every downloaded asset on disk, and the project already caches a lot (the Renderer's
 * Frame pool, the item icons, every UI built once and rewritten in place, the lobby flyover's pool, the per-session
 * save on the server). This suite checks the three caches added on top of those, on the REAL modules under Node,
 * over the counted fake Instance tree of tools/ui-shim.mjs:
 *
 *   1. THE TOWN, LOBBY -> MATCH   client/boot/townCache.ts. The match takes the town the lobby's flyover already
 *                                 generated for the same seed (the same object: no second generateTown); the flyover
 *                                 lets go of it first and the next menu draws a freshly generated copy, never a street
 *                                 the match changed; a new seed (MP-22's new town) or a seed of 0 never reuses it; a
 *                                 town the flyover drew is field for field the one generateTown returns, and a copy that
 *                                 changed anyway (its fingerprint) is refused. Reports the generation time saved.
 *                                 The menus' town is generated a slice per frame (`requestTown`, MP-26): a slice is
 *                                 TOWN_SLICE_S of work; asked for, it is ready a frame later; a match that wants it
 *                                 before its last slice FINISHES it in place (one generation, never two); another
 *                                 seed abandons it; a generator that throws is not asked for again every frame.
 *   2. ONE PRELOAD PLAN           client/boot/preloadPlan.ts, over a fake ContentProvider that records every request:
 *                                 nothing waits for it; the skin, then the icon atlas and the lobby's town (signs last),
 *                                 then the character sheets and worldArt.ts's own pass, then the sounds bus by bus; only
 *                                 ids the game uses; one [PZ-LOAD] line; worldArt.ts's fallbacks still work behind it
 *                                 (every texture lost: flat town; one sheet lost: its group flat; the atlas: Frames).
 *   3. IDLE-TIME WARM-UP          client/boot/warmup.ts. The Bag built out of sight a few tiles per frame after a run
 *                                 mounts (Backpack.warmStep), never visible, never heard; then its first open and the
 *                                 first visit of every tab create NO Instance (with Frames icons and with the atlas); a B
 *                                 press in the middle still works; the frame cost under a cost model (each Instance
 *                                 COST_S of os.clock); the lobby's Survivor page built in lobby idle, START then free.
 *
 * Pure Node (>= 18) plus the project's TypeScript.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installUiShims } from "./ui-shim.mjs";

const ui = installUiShims({ seed: 1, viewport: [1920, 1080] });
const { SRC, require, flush, service, makeInstance, stats } = ui;

const logged = [];
globalThis.print = (...a) => logged.push(a.join(" "));

const World = require(join(SRC, "shared/game/world.ts"));
const Cache = require(join(SRC, "client/boot/townCache.ts"));
const Fly = require(join(SRC, "client/view/townFlyover.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
flush();

const RunService = service("RunService");

// ---------------------------------------------------------------- checks

let failures = 0;
function check(name, ok, detail) {
	const tail = detail === undefined ? "" : `  (${detail})`;
	if (ok) console.log(`  ok    ${name}${tail}`);
	else {
		console.error(`  FALHA ${name}${tail}`);
		failures++;
	}
}
function section(title) {
	console.log(`\n${title}\n`);
}
const frame = (dt = 1 / 60) => {
	ui.setClock(ui.getClock() + dt);
	RunService.RenderStepped.Fire(dt);
	RunService.Heartbeat.Fire(dt);
	flush();
};
/** counted Instances alive right now */
function alive() {
	let n = 0;
	for (const e of stats.log) n += e.kind === "new" ? 1 : -1;
	return n;
}

/**
 * Field-for-field equality of two towns, the way a player would notice a difference: every solid, lot, road, item...
 * Two fields are bookkeeping and left out: a solid's `gridStamp` and the grid's `stamp`, the de-duplication counters
 * of world.ts querySolids -- the stamp only grows, so a grid that answered queries before (the flyover's walkers)
 * answers the next query exactly as a fresh one does.
 */
function sameTown(a, b) {
	const diffs = [];
	const walk = (x, y, path) => {
		if (diffs.length > 5) return;
		if (x === y) return;
		if (x instanceof Color3 || y instanceof Color3) {
			if (!(x instanceof Color3 && y instanceof Color3 && x.R === y.R && x.G === y.G && x.B === y.B))
				diffs.push(path);
			return;
		}
		if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) {
			if (!(Number.isNaN(x) && Number.isNaN(y))) diffs.push(`${path}: ${x} != ${y}`);
			return;
		}
		if (Array.isArray(x) !== Array.isArray(y)) return void diffs.push(`${path}: array vs object`);
		const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
		for (const k of keys) {
			if (k === "gridStamp" || (k === "stamp" && path.endsWith(".grid"))) continue;
			walk(x[k], y[k], `${path}.${k}`);
		}
	};
	walk(a, b, "world");
	return diffs;
}
/** a town and a freshly generated one share no object (the menus' copy and the match's are two towns) */
function shareNothing(a, b) {
	const seen = new Set();
	// the spatial grids share ONE empty cell (solidGrid.ts EMPTY_CELL: an insert swaps it for a fresh array, a remove from it
	// finds nothing), so an empty array inside a grid's `cells` is that read-only sentinel, not town data
	const sentinel = (x, key) => key === "cells" && Array.isArray(x) && x.length === 0;
	const collect = (x, key) => {
		if (typeof x !== "object" || x === null || x instanceof Color3 || seen.has(x) || sentinel(x, key)) return;
		seen.add(x);
		const inCells = Array.isArray(x) && key === "cells";
		for (const [k, v] of Object.entries(x)) collect(v, inCells ? "cells" : k);
	};
	collect(a);
	let shared = 0;
	const probe = (x, key, visited = new Set()) => {
		if (typeof x !== "object" || x === null || x instanceof Color3 || visited.has(x) || sentinel(x, key)) return;
		visited.add(x);
		if (seen.has(x)) shared++;
		const inCells = Array.isArray(x) && key === "cells";
		for (const [k, v] of Object.entries(x)) probe(v, inCells ? "cells" : k, visited);
	};
	probe(b);
	return shared === 0;
}

const S = DESIGN.TOWN_SEED;
const T = 424242;
const gen0 = () => Cache.townCacheStats().generated;

// ================================================================ 1. the town, lobby -> match

section("1) a cidade do lobby vai para a partida (client/boot/townCache.ts)");

const host = makeInstance("Frame", false);
host.Name = "Host";
let g = gen0();
Fly.prewarmTown(S);
const lobbyTown = Fly.townFor(S);
check(
	"atras do logo a cidade e gerada uma vez; o lobby a reusa",
	gen0() === g + 1 && Fly.townFor(S) === lobbyTown && gen0() === g + 1,
	`${gen0() - g} geracao(oes)`,
);
let fly = Fly.pinFlyover(host, S);
for (let i = 0; i < 600; i++) frame();
check(
	"o voo desenha a cidade 600 quadros (camera, zumbis a toa) sem mudar nada nela: campo a campo, e a de generateTown",
	fly.shows(lobbyTown) && sameTown(lobbyTown, World.generateTown(S)).length === 0,
	sameTown(lobbyTown, World.generateTown(S)).join("; ") || "igual",
);
const aliveWithFly = alive();
const flownPrint = Cache.townFingerprint(lobbyTown);

// Enter the city: GameLoop.init -> takeTown(netTownSeed())
g = gen0();
logged.length = 0;
const t0 = performance.now();
const matchTown = Cache.takeTown(S);
const takeMs = performance.now() - t0;
check(
	"entrar na cidade: a partida recebe O MESMO objeto, sem gerar a cidade de novo",
	matchTown === lobbyTown && gen0() === g,
	`${gen0() - g} geracao(oes), ${takeMs.toFixed(3)} ms`,
);
check(
	"...e o voo que a desenhava a solta antes: nenhum Frame dele fica vivo, nenhuma conexao",
	Fly.activeFlyover() === undefined && host.FindFirstChild("TownBackdrop") === undefined && alive() < aliveWithFly,
	`${aliveWithFly - alive()} Instances soltas`,
);
check(
	"...e o Output diz [PZ-LOAD] que a cidade veio do lobby",
	logged.some(l => l.startsWith(`[PZ-LOAD] town ${S}: taken from the lobby`)),
	logged.join(" | "),
);

// the match plays: solids added and removed, a door opened, damage, an item dropped
const barricade = World.addSolid(matchTown, {
	kind: "barricade",
	x: 5000,
	y: 5000,
	w: 60,
	h: 20,
	hp: 50,
	hpMax: 50,
	destructible: true,
	tags: "",
});
const car = matchTown.solids.find(s => s.kind === "car");
World.removeSolid(matchTown, car);
const door = matchTown.solids.find(s => s.kind === "door");
if (door !== undefined) door.open = true;
const tree = matchTown.solids.find(s => s.kind === "tree");
tree.hp -= 7;
World.spawnGroundItem(matchTown, 1, 3, 1, 4000, 4000);
check(
	"a partida mexe na SUA cidade (uma barricada, um carro a menos, uma porta aberta, dano, um item no chao)",
	matchTown.solids.includes(barricade) &&
		!matchTown.solids.includes(car) &&
		sameTown(matchTown, lobbyTown).length === 0,
);

// back to the lobby (Home): the next menu needs a town
g = gen0();
fly = Fly.pinFlyover(host, S);
frame();
const lobbyTown2 = Fly.townFor(S);
check(
	"de volta ao lobby: o voo desenha uma copia NOVA, nao a cidade que a partida mudou",
	!fly.shows(matchTown) && fly.shows(lobbyTown2) && lobbyTown2 !== matchTown && gen0() === g + 1,
	`${gen0() - g} geracao(oes)`,
);
check(
	"...sem a barricada, com o carro, com a porta fechada e a arvore inteira: campo a campo a de generateTown",
	!lobbyTown2.solids.some(s => s.kind === "barricade" && s.x === 5000 && s.y === 5000) &&
		lobbyTown2.solids.some(s => s.id === car.id) &&
		sameTown(lobbyTown2, World.generateTown(S)).length === 0 &&
		sameTown(lobbyTown2, matchTown).length > 0,
);
check("...e as duas cidades nao dividem nenhum objeto", shareNothing(lobbyTown2, matchTown));
check("a partida suspensa (Continue) segue com a dela", matchTown.solids.includes(barricade));

// New game from the lobby: GameLoop.init again
g = gen0();
const matchTown2 = Cache.takeTown(S);
check(
	"um jogo novo pega a copia nova do lobby (a mesma), nunca a cidade velha da partida",
	matchTown2 === lobbyTown2 && matchTown2 !== matchTown && gen0() === g && Fly.activeFlyover() === undefined,
);

// ---- a new seed never reuses the old town
g = gen0();
let abandoned0 = Cache.townCacheStats().abandoned;
Fly.prewarmTown(S);
const other = Cache.takeTown(T);
check(
	"outra semente (o InitBegin corrigiu o palpite): a partida gera a cidade DELA, nao pega a do lobby",
	other !== Fly.townFor(S) && sameTown(other, World.generateTown(T)).length === 0 && gen0() === g + 2,
	`${gen0() - g} geracoes: a da partida e a do lobby de novo`,
);
check(
	"...e a cidade do lobby que ainda estava sendo gerada em fatias e abandonada, nao terminada a toa atras da partida",
	Cache.townCacheStats().abandoned === abandoned0 + 1 && Cache.pendingTown() === undefined,
	`${Cache.townCacheStats().abandoned - abandoned0} abandonada(s)`,
);

// ---- MP-22: the world ends
// (a) in the street: the rebuild asks for the new seed; the cache holds nothing (the match took it) -> a new town
g = gen0();
Cache.takeTown(S); // what the lobby held goes to a match
const reset1 = Cache.takeTown(T);
check(
	"fim do mundo na rua: a partida reconstruida gera a cidade nova (semente nova), nada vem da velha",
	reset1 !== matchTown2 && sameTown(reset1, World.generateTown(T)).length === 0 && gen0() === g + 1,
);
// (b) in the lobby: the lobby shows S, a WorldReset names T; the lobby's refresh pins T (lobby.ts refresh -> pinFlyover,
// or client/boot/serverTown.ts -> followTown): the SAME flyover cross-fades to it, in its own pool
Fly.townFor(S);
fly = Fly.pinFlyover(host, S);
frame();
const oldFly = fly;
const townS = Fly.townFor(S);
g = gen0();
fly = Fly.pinFlyover(host, T);
check(
	"fim do mundo no lobby: a cidade nova e pedida em fatias; a velha continua na tela enquanto isso",
	fly === oldFly && fly.shows(townS) && Cache.pendingTown() === T && gen0() === g,
);
for (let i = 0; i < 180; i++) frame();
const lobbyT = Cache.readyTown(T);
check(
	"...pronta, o MESMO voo troca para ela (gerada uma vez), sem soltar o voo nem o pool",
	oldFly === fly && oldFly.layer.Parent === host && lobbyT !== undefined && fly.shows(lobbyT) && gen0() === g + 1,
	`${gen0() - g} geracao(oes)`,
);
const enterT = Cache.takeTown(T);
check("...e a proxima entrada pega essa cidade nova", enterT === lobbyT && gen0() === g + 1);
// (c) A -> B -> A: the cache only ever holds towns nobody played in
g = gen0();
const againS = Fly.townFor(S);
check(
	"A -> B -> A: a volta a uma semente antiga gera uma cidade limpa, nunca a que uma partida mexeu",
	againS !== matchTown && againS !== matchTown2 && sameTown(againS, World.generateTown(S)).length === 0,
);
Fly.releaseFlyover();

// ---- seed 0 is a random town: never cached
g = gen0();
const r1 = Fly.townFor(0);
const r2 = Fly.townFor(0);
const r3 = Cache.takeTown(0);
check("semente 0 (cidade aleatoria) nunca vai para o cache", r1 !== r2 && r3 !== r2 && gen0() === g + 3);

// ---- the fingerprint: a menus' copy that changed anyway (a bug somewhere) is never handed over
{
	const warned = [];
	const realWarn = globalThis.warn;
	globalThis.warn = (...a) => warned.push(a.join(" "));
	const menus = Fly.townFor(S);
	const printed = Cache.townFingerprint(menus);
	menus.solids.find(s => s.kind === "tree").hp -= 1;
	g = gen0();
	const refused0 = Cache.townCacheStats().refused;
	const taken = Cache.takeTown(S);
	globalThis.warn = realWarn;
	check(
		"a copia do lobby que mudou depois de gerada (impressao digital diferente) nao vai para a partida: ela gera a sua",
		Cache.townFingerprint(menus) !== printed &&
			taken !== menus &&
			gen0() === g + 1 &&
			Cache.townCacheStats().refused === refused0 + 1 &&
			sameTown(taken, World.generateTown(S)).length === 0 &&
			warned.some(w => w.includes("changed since it was generated")),
		warned.join(" | "),
	);
	check(
		"...e a impressao digital de uma cidade que o voo desenhou 600 quadros e a de generateTown",
		flownPrint === Cache.townFingerprint(World.generateTown(S)),
		flownPrint,
	);
}

// ================================================================ 1b. a slice per frame (MP-26, UI-10)

section("1b) a cidade do lobby e gerada em fatias, um pedaco por quadro, e a partida a pega sem gerar de novo");
{
	const stats = () => Cache.townCacheStats();
	const renderConns = () => RunService.RenderStepped.conns.length;
	Fly.releaseFlyover();
	Cache.takeTown(S); // an empty cache, no job: a match took whatever the menus held
	const conns0 = renderConns();

	// (a) the cadence: a slice is a few ms of work -- TOWN_SLICE_IDLE_S with nothing on screen (the logo, the menus over
	// the page colour), TOWN_SLICE_S with a town gliding (the next one generated behind it, MP-22). The generator's clock
	// here moves 1 ms per call of os.clock, so it must yield about every budget-in-ms pace points -- and the yields never
	// change the town
	const cadence = (seed, host) => {
		const realClock = globalThis.os.clock;
		let fake = 5000;
		globalThis.os.clock = () => (fake += 0.001);
		let paces = 0;
		const realGen = World.generateTown;
		World.generateTown = (sd, pace) =>
			realGen(sd, () => {
				paces += 1;
				pace?.();
			});
		const y0 = globalThis.coroutine.yields;
		Cache.requestTown(seed);
		frame();
		const yields = globalThis.coroutine.yields - y0;
		World.generateTown = realGen;
		globalThis.os.clock = realClock;
		return { paces, yields, perSlice: paces / Math.max(1, yields), host };
	};
	{
		const idle = cadence(T);
		const idleMs = Cache.TOWN_SLICE_IDLE_S * 1000;
		check(
			`nada na tela: uma fatia = TOWN_SLICE_IDLE_S (${idleMs} ms) de trabalho -- com 1 ms por leitura do relogio, ~${idleMs} pontos por fatia`,
			idle.yields > 20 && Math.abs(idle.perSlice - idleMs) <= 2,
			`${idle.paces} pontos de pausa, ${idle.yields} cessoes, ${idle.perSlice.toFixed(1)} pontos por fatia`,
		);
		check(
			"...e a cidade em fatias e a de generateTown, campo a campo",
			sameTown(Cache.readyTown(T), World.generateTown(T)).length === 0,
			sameTown(Cache.readyTown(T), World.generateTown(T)).join("; ") || "igual",
		);
		// a town gliding on screen (the flyover draws T) while the next one (S) is generated: the smaller slice
		const flying = Fly.pinFlyover(host, T);
		frame();
		const busy = cadence(S);
		const busyMs = Cache.TOWN_SLICE_S * 1000;
		check(
			`com uma cidade deslizando na tela: a fatia menor, TOWN_SLICE_S (${busyMs} ms), para o desenho dela caber no quadro`,
			flying.drawingTown() && busy.yields > 40 && Math.abs(busy.perSlice - busyMs) <= 1.5,
			`${busy.paces} pontos de pausa, ${busy.yields} cessoes, ${busy.perSlice.toFixed(1)} pontos por fatia`,
		);
		Fly.releaseFlyover();
		Cache.takeTown(S);
	}

	// (b) asked for, then ready a frame later: nothing is generated in the call, the frame does it
	let g1 = gen0();
	const paced0 = stats().paced;
	Cache.requestTown(S);
	check(
		"pedir a cidade nao gera nada na hora: fica pendente, com um driver no quadro",
		gen0() === g1 && Cache.pendingTown() === S && Cache.readyTown(S) === undefined && renderConns() === conns0 + 1,
		`pendente ${Cache.pendingTown()}, ${renderConns() - conns0} conexao(oes)`,
	);
	Cache.requestTown(S);
	check("pedir de novo a mesma nao recomeca nada", Cache.pendingTown() === S && gen0() === g1);
	frame();
	const readyS = Cache.readyTown(S);
	check(
		"no quadro seguinte ela fica pronta (o Node nao suspende a corrotina: a fatia vai ao fim), e o driver se desliga",
		readyS !== undefined &&
			gen0() === g1 + 1 &&
			stats().paced === paced0 + 1 &&
			Cache.pendingTown() === undefined &&
			renderConns() === conns0,
		`${renderConns() - conns0} conexao(oes) sobrando`,
	);
	logged.length = 0;
	const tookS = Cache.takeTown(S);
	check(
		"entrar na cidade: a partida pega ESSA copia, geracao zero",
		tookS === readyS && gen0() === g1 + 1 && logged.some(l => l.includes("taken from the lobby")),
		`${gen0() - g1} geracao(oes)`,
	);

	// (c) the match wants the town before its last slice: it is finished in place, never started over
	g1 = gen0();
	const rushed0 = stats().rushed;
	Cache.requestTown(T);
	const tookT = Cache.takeTown(T);
	check(
		"a partida pede a cidade ainda em fatias: ela e TERMINADA ali (uma geracao so), nao gerada de novo",
		gen0() === g1 + 1 && stats().rushed === rushed0 + 1 && sameTown(tookT, World.generateTown(T)).length === 0,
		`${gen0() - g1} geracao(oes), ${stats().rushed - rushed0} terminada(s) na hora`,
	);
	check(
		"...e nada continua sendo gerado atras da partida (nem job, nem driver)",
		Cache.pendingTown() === undefined && renderConns() === conns0,
	);
	g1 = gen0();
	Cache.requestTown(S);
	const forS = Cache.townFor(S);
	check(
		"townFor (quem nao pode esperar) tambem termina a que esta em fatias, sem gerar outra",
		gen0() === g1 + 1 && Cache.readyTown(S) === forS && Cache.pendingTown() === undefined,
	);

	// (d) another seed asked for: the unfinished one is given up; a seed of 0 is never asked for
	Cache.takeTown(S);
	abandoned0 = stats().abandoned;
	Cache.requestTown(S);
	Cache.requestTown(T);
	check(
		"outra semente pedida no meio: a anterior e abandonada, a nova segue",
		stats().abandoned === abandoned0 + 1 && Cache.pendingTown() === T,
	);
	Cache.requestTown(0);
	check("semente 0 (aleatoria) nunca e pedida em fatias", Cache.pendingTown() === T);
	Cache.takeTown(S);

	// (e) a generator that throws: one warning, nothing kept, and the menus do not ask for it again every frame
	{
		const warned = [];
		const realWarn = globalThis.warn;
		globalThis.warn = (...a) => warned.push(a.join(" "));
		const realGen = World.generateTown;
		World.generateTown = () => {
			throw new Error("boom");
		};
		Cache.requestTown(99);
		frame();
		World.generateTown = realGen;
		Cache.requestTown(99);
		const again = Cache.pendingTown();
		for (let i = 0; i < 5; i++) frame();
		globalThis.warn = realWarn;
		check(
			"um gerador que lanca erro: uma linha [PZ-LOAD], nada no cache, e nenhum pedido de novo a cada quadro",
			warned.filter(w => w.includes("the lobby's town could not be generated")).length === 1 &&
				logged.some(l => l.includes("town 99: generation failed")) &&
				Cache.readyTown(99) === undefined &&
				again === undefined &&
				renderConns() === conns0,
			warned.join(" | "),
		);
	}
}

// ---- source guards: where the towns come from
/** a source file without its comments (a header may name generateTown; only a call counts) */
const read = rel =>
	readFileSync(join(SRC, rel), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");
const loopSrc = read("client/gameLoop.ts");
check(
	"GameLoop.init pega a cidade com takeTown(this.townSeed) e nao chama mais generateTown",
	/this\.world = takeTown\(this\.townSeed\)/.test(loopSrc) && !/generateTown\(/.test(loopSrc),
);
check(
	"o voo nao gera cidade por conta propria (so pelo cache)",
	!/generateTown\(/.test(read("client/view/townFlyover.ts")),
);
check(
	"o servidor continua gerando a SUA copia (boot e fim do mundo), sem o cache do cliente",
	/generateTown\(/.test(read("server/net/mpHost.ts")) &&
		/generateTown\(seed[,)]/.test(read("server/sim/worldReset.ts")) &&
		!/townCache/.test(read("server/net/mpHost.ts") + read("server/sim/worldReset.ts")),
);

// ---- what it saves: generateTown measured here, per seed
{
	const rows = [];
	for (const seed of [S, 1, 42, 99991, 2024]) {
		const times = [];
		for (let i = 0; i < 7; i++) {
			const a = performance.now();
			World.generateTown(seed);
			times.push(performance.now() - a);
		}
		times.sort((x, y) => x - y);
		rows.push(`${seed}: ${times[3].toFixed(1)} ms`);
	}
	console.log(`\n  generateTown no Node (mediana de 7, JIT quente): ${rows.join(", ")}`);
	console.log(
		`  takeTown com a cidade do lobby: ${takeMs.toFixed(3)} ms (a geracao inteira que a entrada deixa de pagar)`,
	);
}

// ================================================================ 2. one ordered preload plan

section("2) um plano so de preload, na ordem em que o jogador precisa (client/boot/preloadPlan.ts)");

// the engine's side: PreloadAsync records what it was asked for, in order, and answers each id
const calls = [];
let failing = new Set();
const CP = service("ContentProvider");
CP.PreloadAsync = (list, cb) => {
	const ids = list.map(p => (p.ClassName === "Sound" ? p.SoundId : p.Image));
	calls.push(ids);
	for (const id of ids) cb?.(id, failing.has(id) ? Enum.AssetFetchStatus.Failure : Enum.AssetFetchStatus.Success);
};
globalThis.pairs ??= o => (o instanceof Map ? [...o.entries()] : Object.entries(o));
// task.spawn runs its function at once, as the engine does until the first yield (worldArt.ts's own pass); only the
// plan's own thread is held, to show that startPreload hands it to the scheduler and returns
const spawned = [];
let holdSpawn = false;
const realTask = { ...globalThis.task };
globalThis.task.spawn = fn => (holdSpawn ? spawned.push(fn) : fn());
globalThis.task.wait = () => {};

const { WORLD_ART, WORLD_ART_NAMES } = require(join(SRC, "client/view/worldArtAssets.ts"));
const { SKIN_TEXTURES, SKIN_TEXTURE_NAMES } = require(join(SRC, "client/ui/skinAssets.ts"));
const { soundDef, soundNames } = require(join(SRC, "shared/data/sounds.ts"));
/** what the catalogue plays NOW: our bank where it has an id (the CI uploads them on main), the library otherwise */
const playing = () =>
	soundNames()
		.map(soundDef)
		.filter(d => d !== undefined);
const Plan = require(join(SRC, "client/boot/preloadPlan.ts"));
const WorldArt = require(join(SRC, "client/view/worldArt.ts"));

// a texture with no id yet (a character sheet, the icon atlas, before the owner uploads it) gets a fake id for this
// section, so the plan is seen with every step in it (put back afterwards; section 3 measures the Bag both ways)
const pendingUpload = WORLD_ART_NAMES.filter(n => WORLD_ART[n].id === "");
pendingUpload.forEach((n, i) => (WORLD_ART[n].id = `rbxassetid://900000${i}`));
const skinIds = SKIN_TEXTURE_NAMES.map(n => SKIN_TEXTURES[n].id).filter(id => id !== "");
const artIds = WORLD_ART_NAMES.map(n => WORLD_ART[n].id).filter(id => id !== "");
const laterNames = WORLD_ART_NAMES.filter(n => Plan.laterArt(n));
const laterIds = laterNames.map(n => WORLD_ART[n].id).filter(id => id !== "");
const signIds = WORLD_ART_NAMES.filter(n => n.startsWith("sign") || n === "helipad").map(n => WORLD_ART[n].id);
const busRank = { ui: 0, sfx: 1, bgm: 2 };
/** the earliest bus a sound id is used on (the same file can be a click and an effect) */
const rankOf = id =>
	Math.min(
		...playing()
			.filter(d => d.id === id)
			.map(d => busRank[d.bus]),
	);

let soundAsk;
logged.length = 0;
holdSpawn = true;
Plan.startPreload(ids => {
	soundAsk = [...ids];
	calls.push(["<sounds>", ...ids]);
	return 0;
});
holdSpawn = false;
check(
	"nada espera o plano: startPreload so entrega uma thread ao agendador (task.spawn) e volta; nenhum download ainda",
	spawned.length === 1 && calls.length === 0,
);
spawned.shift()();
check(
	"1o a skin da UI (as chapas do lobby), inteira e so ela",
	JSON.stringify(calls[0]) === JSON.stringify(skinIds),
	`${calls[0]?.length} texturas`,
);
const town = calls[1] ?? [];
check(
	"...depois o atlas dos icones (a hotbar da HUD, o Bag) e as texturas da cidade que o voo desenha e a partida pega",
	town[0] === WORLD_ART.itemIcons.id &&
		town.length > 60 &&
		["asphalt", "grass", "roofShingleH", "canopy0", "car0"].every(n => town.includes(WORLD_ART[n].id)) &&
		laterIds.every(id => !town.includes(id)),
	`${town.length} texturas`,
);
check(
	"...com os letreiros (ART-07) e o heliponto no fim dela: pequenos, nas fachadas",
	JSON.stringify(town.slice(-signIds.length)) === JSON.stringify(signIds),
	`${signIds.length} letreiros`,
);
check(
	"2o as folhas dos personagens (charSheets.ts: sobreviventes, armas, zumbis, cachorros, passaros e os chefes, ART-14)",
	laterNames.length === 24 &&
		["survivorsA", "weapons", "zombies", "dogs", "birds", "bossGiant", "bossCentipedeRim"].every(n =>
			laterNames.includes(n),
		) &&
		JSON.stringify(calls[2]) === JSON.stringify(laterIds),
	`${calls[2]?.length}: ${laterNames.join(", ")}`,
);
check(
	"...e entao a passada do proprio worldArt.ts (os fallbacks dele), com tudo ja no cache",
	JSON.stringify([...(calls[3] ?? [])].sort()) === JSON.stringify([...artIds].sort()),
	`${calls[3]?.length} texturas`,
);
const soundsAt = calls.findIndex(c => c[0] === "<sounds>");
const ranks = (soundAsk ?? []).map(rankOf);
check(
	"3o os sons, por ultimo: a interface (cliques do lobby), depois a luta, depois a noite",
	soundsAt === 4 &&
		calls.length === 5 &&
		ranks.length > 10 &&
		ranks.every((r, i) => i === 0 || r >= ranks[i - 1]) &&
		[...new Set(soundAsk)].length === soundAsk.length,
	`${soundAsk?.length} sons, cada um uma vez, na ordem dos buses (0 ui, 1 sfx, 2 bgm): ${ranks.join("")}`,
);
{
	const everyId = new Set([
		...skinIds,
		...artIds,
		...playing()
			.map(d => d.id)
			.filter(id => id !== ""),
	]);
	const asked = calls.flat().filter(id => id !== "<sounds>");
	check(
		"so o que o jogo usa: nenhum id vazio, nenhum id fora da skin, da arte da cidade e do catalogo de sons",
		asked.every(id => id !== "" && everyId.has(id)),
	);
	const twice = asked.filter((id, i) => asked.indexOf(id) !== i);
	check(
		"nada pedido duas vezes, fora a passada do worldArt (que ja acha tudo no cache)",
		twice.length === artIds.length && twice.every(id => artIds.includes(id)),
		`${twice.length} repetidos`,
	);
}
const loadLine = logged.filter(l => l.startsWith("[PZ-LOAD] preload"));
check(
	"uma linha so no Output: [PZ-LOAD] preload com as tres etapas",
	loadLine.length === 1 && /1\) skin \+ icons \+ town \d+ .*2\) characters \d+ .*3\) sounds \d+/.test(loadLine[0]),
	loadLine[0],
);
check(
	"com tudo no ar, a arte da cidade vale (artId com id)",
	WorldArt.artId("asphalt") === WORLD_ART.asphalt.id && WorldArt.artId("signSchool") === WORLD_ART.signSchool.id,
);
check(
	"o relatorio do plano: quantos em cada etapa",
	Plan.preloadReport().done &&
		Plan.preloadReport().counts[0] === skinIds.length + town.length &&
		Plan.preloadReport().counts[1] === laterIds.length &&
		Plan.preloadReport().counts[2] === soundAsk.length,
	JSON.stringify(Plan.preloadReport().counts),
);

/** the plan once more on fresh copies of worldArt.ts and the plan, with `fail` never arriving */
function planWithFailures(fail) {
	const keys = ["client/view/worldArt.ts", "client/boot/preloadPlan.ts"].map(rel => require.resolve(join(SRC, rel)));
	const saved = keys.map(k => require.cache[k]);
	for (const k of keys) delete require.cache[k];
	const art = require(keys[0]);
	const plan = require(keys[1]);
	failing = new Set(fail);
	calls.length = 0;
	const report = plan.runPreloadPlan(() => 0);
	failing = new Set();
	// the rest of the suite (and every module that already holds them) keeps the first copies
	keys.forEach((k, i) => (require.cache[k] = saved[i]));
	return [art, report];
}
// the fallbacks are worldArt.ts's own, and they still run behind the plan
{
	const [art, rep] = planWithFailures([WORLD_ART.signSchool.id]);
	check(
		"um letreiro que nao chega nao desliga a arte: a cidade continua texturizada (o worldArt.ts tenta de novo e segue)",
		art.artId("asphalt") === WORLD_ART.asphalt.id && rep.missed === 1 && calls.some(c => c.length === 1),
		`${rep.missed} faltando; ${calls.length} pedidos`,
	);
}
{
	const [art] = planWithFailures(artIds);
	check(
		"se NENHUMA textura da cidade chega (upload moderado), o fallback do worldArt.ts liga: a cidade lisa",
		art.artId("asphalt") === undefined && art.artId("signSchool") === undefined,
	);
}
{
	const [art] = planWithFailures([WORLD_ART.zombies.id, WORLD_ART.itemIcons.id]);
	check(
		"uma folha que nao chega (zumbis) cai sozinha para o desenho liso, e o atlas para os Frames; o resto da arte fica",
		art.artId("zombies") === undefined &&
			art.artId("itemIcons") === undefined &&
			art.artId("dogs") === WORLD_ART.dogs.id &&
			art.artId("asphalt") === WORLD_ART.asphalt.id,
	);
}
for (const n of pendingUpload) WORLD_ART[n].id = "";
{
	const mainSrc = read("client/main.client.ts");
	check(
		"main.client.ts comeca o plano (Boot.startPreload) e nao chama mais preloadWorldArt por fora",
		/Boot\.startPreload\(/.test(mainSrc) && !/preloadWorldArt\(/.test(mainSrc),
	);
	check(
		"o mixer nao busca os sons sozinho no start (o plano entrega na ordem)",
		!/this\.preload\(\)/.test(read("client/audio/audio.ts")) &&
			/preloadSounds\(/.test(read("client/audio/audio.ts")),
	);
	check(
		"a skin nao dispara uma busca propria ao carregar o modulo: e o passo 1 do plano",
		/export function preloadSkin\(/.test(read("client/ui/skin.ts")) &&
			!/^if \(skinOn\) \{\s*task\.spawn/m.test(read("client/ui/skin.ts")),
	);
}
Object.assign(globalThis.task, realTask);

// ================================================================ 3. warm-up in idle time

section("3) aquecimento no ocioso: o Bag na partida, a tela Survivor no lobby (client/boot/warmup.ts)");

const boot = require(join(SRC, "client/bootstrap.ts"));
const { Backpack } = require(join(SRC, "client/ui/backpack.ts"));
const { showLobby } = require(join(SRC, "client/ui/lobby.ts"));
const Warm = require(join(SRC, "client/boot/warmup.ts"));
const { defaultSave, ownsWeapon } = require(join(SRC, "shared/game/save.ts"));
const { WEAPONS } = require(join(SRC, "shared/data/weapons.ts"));
const { EQUIPS } = require(join(SRC, "shared/data/equips.ts"));
const { USABLES } = require(join(SRC, "shared/data/usables.ts"));
const { ETC_ITEMS } = require(join(SRC, "shared/data/etcItems.ts"));
flush();

const ctx = boot.getCtx();
ctx.phase = "playing";
// a survivor a few days in (the save of test:backpack): weapons, gear, food and medicine, materials, 2 points
const save = defaultSave();
for (let id = 1; id <= 8 && id < WEAPONS.length; id++) save.invenWeapon[id] = id % 3 === 0 ? 2 : 1;
save.invenWeapon[10] = 1;
save.ammoNormal = 41;
for (let id = 0; id < 6 && id < EQUIPS.length; id++) save.invenEquip[id] = 1;
for (let id = 0; id < 8 && id < USABLES.length; id++) save.invenUse[id] = 3;
for (let id = 23; id < 23 + 14 && id < ETC_ITEMS.length; id++) save.invenEtc[id] = 6;
save.skillPoint = 2;
ctx.save = save;
const layer = ctx.uiLayer;

const newPack = () => {
	const p = new Backpack(ctx);
	p.craftCheck = () => undefined;
	return p;
};
const created = r => r.created;
const measure = ui.measure;

/** the uploads as they are, with the item icon atlas's id set to `id` ("" = none: the icons are Frames) */
function setIconAtlas(id) {
	const ids = {};
	for (const name of WORLD_ART_NAMES) ids[name] = WORLD_ART[name].id;
	ids.itemIcons = id;
	WorldArt.overrideWorldArt(ids);
}
// the Bag with its icons drawn as Frames, whatever has been uploaded; the atlas is measured further down
setIconAtlas("");

// ---- before: the Bag of today, built on the first B press
const control = newPack();
const firstOpen = measure(() => control.open());
const tabCosts = [];
for (let i = 1; i < 6; i++) {
	tabCosts.push(
		measure(() => {
			control.selectCat(i);
		}).created,
	);
}
control.close();
const beforeTotal = firstOpen.created + tabCosts.reduce((a, b) => a + b, 0);
console.log(
	`  antes: 1a abertura ${firstOpen.created} Instances; 1a visita de Gear/Usables/Materials/Craft/Skills ` +
		`${tabCosts.join(" / ")}; ${beforeTotal} no total, tudo no quadro do clique`,
);
control.root?.Destroy();
flush();

// ---- the warm-up, frame by frame, under a cost model: each Instance created costs COST_S of os.clock
const COST_S = 10e-6;
let modelClock = 0;
const createdSoFar = () => stats.log.reduce((n, e) => n + (e.kind === "new" ? 1 : 0), 0);
const modelNow = () => modelClock + createdSoFar() * COST_S;
// each step alone (a queue with no budget runs one step per frame): what the biggest piece of work is
const stepSizes = [];
{
	const probe = newPack();
	const one = new Warm.WarmQueue(0, modelNow);
	one.add({ name: "Backpack", step: () => probe.warmStep(Warm.BAG_TILES_PER_STEP) });
	for (let f = 0; f < 2000 && one.pending() > 0; f++) stepSizes.push(measure(() => one.frame()).created);
	probe.root?.Destroy();
	flush();
	console.log(`  passos do aquecimento do Bag (Instances cada): ${stepSizes.join(" ")}`);
}
const pack = newPack();
const queue = new Warm.WarmQueue(Warm.WARM_BUDGET_S, modelNow);
queue.add({ name: "Backpack", step: () => pack.warmStep(Warm.BAG_TILES_PER_STEP) });
const addedVisible = [];
const guiService = service("GuiService");
const selectedBefore = guiService.SelectedObject;
let focusMoved = false;
const watchAdd = layer.ChildAdded.Connect(c => addedVisible.push([c.Name, c.Visible]));
/** per frame: Instances created and steps run */
const perFrame = [];
const stepsPerFrame = [];
let everShown = false;
for (let f = 0; f < 2000 && queue.pending() > 0; f++) {
	const st0 = queue.stats.steps;
	const r = measure(() => queue.frame());
	perFrame.push(r.created);
	stepsPerFrame.push(queue.stats.steps - st0);
	modelClock += 1 / 60;
	if (pack.root?.Visible === true) everShown = true;
	if (guiService.SelectedObject !== selectedBefore) focusMoved = true;
}
watchAdd.Disconnect();
const s = queue.stats;
const maxFrame = Math.max(...perFrame);
check(
	"o aquecimento termina, espalhado em quadros",
	queue.pending() === 0 && perFrame.length > 5,
	`${perFrame.length} quadros, ${s.steps} passos, ${perFrame.reduce((a, b) => a + b, 0)} Instances`,
);
check(
	`cada quadro fica no orcamento: no maximo ${Warm.WARM_BUDGET_S * 1000} ms de trabalho, ou um passo so quando o passo e maior`,
	perFrame.every((n, i) => n * COST_S <= Warm.WARM_BUDGET_S + 1e-12 || stepsPerFrame[i] === 1),
	`pior quadro ${maxFrame} Instances = ${(maxFrame * COST_S * 1000).toFixed(2)} ms a ${COST_S * 1e6} us/Instance; media ${(
		perFrame.reduce((a, b) => a + b, 0) / perFrame.length
	).toFixed(0)} Instances/quadro`,
);
check(
	"nada aparece: o Bag entra na camada da UI ja invisivel (o audio da interface nao ouve uma tela abrindo) e nunca e mostrado",
	!everShown && addedVisible.every(([name, vis]) => name !== "Backpack" || vis === false),
	JSON.stringify(addedVisible),
);
check("o Bag continua fechado, e a selecao do controle nunca saiu de onde estava", !pack.isOpen() && !focusMoved);
const open1 = measure(() => pack.open());
check(
	"a 1a abertura NA PARTIDA depois do aquecimento nao cria nenhuma Instance",
	open1.created === 0 && open1.destroyed === 0,
	`${open1.created} criadas, ${open1.destroyed} destruidas (antes: ${firstOpen.created})`,
);
const visits = [];
for (let i = 1; i < 6; i++) visits.push(measure(() => pack.selectCat(i)));
check(
	"...nem a 1a visita de cada aba (Gear, Usables, Materials, Craft, Skills)",
	visits.every(r => r.created === 0 && r.destroyed === 0),
	visits.map(created).join(" / "),
);
{
	const grid = pack.grids[0];
	pack.selectCat(0);
	const shown = grid.itemTiles().filter(t => t.button.Visible).length;
	const owned = WEAPONS.filter(w => ownsWeapon(save, w.id)).length;
	check("e mostra o que o save diz (as armas da mochila)", shown === owned, `${shown} de ${owned}`);
}
check("aberto, o aquecimento nao mexe em nada", measure(() => pack.warmStep(5)).created === 0);
pack.close();

// ---- with the icon atlas uploaded (client/ui/itemIcon.ts: an icon is one ImageLabel): what the warm-up still saves
let atlasLine = "";
{
	// the uploaded atlas (a stand-in id while it has none)
	const atlasId = WORLD_ART.itemIcons.id !== "" ? WORLD_ART.itemIcons.id : "rbxassetid://1";
	setIconAtlas(atlasId);
	const coldA = newPack();
	const openA = measure(() => coldA.open()).created;
	const tabsA = [];
	for (let i = 1; i < 6; i++) tabsA.push(measure(() => coldA.selectCat(i)).created);
	coldA.close();
	coldA.root?.Destroy();
	flush();
	const warmA = newPack();
	const qA = new Warm.WarmQueue(Warm.WARM_BUDGET_S, modelNow);
	qA.add({ name: "Backpack", step: () => warmA.warmStep(Warm.BAG_TILES_PER_STEP) });
	const framesA = [];
	for (let f = 0; f < 2000 && qA.pending() > 0; f++) {
		framesA.push(measure(() => qA.frame()).created);
		modelClock += 1 / 60;
	}
	const firstA = measure(() => {
		warmA.open();
		for (let i = 1; i < 6; i++) warmA.selectCat(i);
	});
	warmA.close();
	warmA.root?.Destroy();
	flush();
	setIconAtlas("");
	const beforeA = openA + tabsA.reduce((a, b) => a + b, 0);
	atlasLine =
		`com o atlas${atlasId === WORLD_ART.itemIcons.id ? " enviado" : ""}: antes ${beforeA} Instances no clique ` +
		`(abertura ${openA} + abas ${tabsA.join("/")}); depois ${firstA.created}, em ${framesA.length} quadros ` +
		`(pior ${Math.max(...framesA)} Instances/quadro)`;
	check(
		"com o atlas dos icones no ar (um ImageLabel por icone) o aquecimento tambem deixa a 1a abertura sem Instance",
		firstA.created === 0 && firstA.destroyed === 0 && beforeA < beforeTotal,
		atlasLine,
	);
}

// ---- a B press in the middle of the warm-up: the Bag builds what is missing, as before
{
	const mid = newPack();
	const q = new Warm.WarmQueue(Warm.WARM_BUDGET_S, modelNow);
	q.add({ name: "Backpack", step: () => mid.warmStep(Warm.BAG_TILES_PER_STEP) });
	for (let f = 0; f < 6; f++) {
		q.frame();
		modelClock += 1 / 60;
	}
	const early = measure(() => mid.open());
	mid.selectCat(4);
	mid.close();
	let frames = 0;
	while (q.pending() > 0 && frames < 2000) {
		q.frame();
		frames++;
	}
	const later = measure(() => {
		mid.open();
		for (let i = 0; i < 6; i++) mid.selectCat(i);
	});
	check(
		"B no meio do aquecimento: abre na hora (so constroi o que falta), e o resto termina depois",
		early.created < firstOpen.created && q.pending() === 0 && later.created === 0,
		`${early.created} criadas na abertura antecipada; ${later.created} depois`,
	);
	mid.close();
	mid.root?.Destroy();
	flush();
}

// ---- warmRun: the Heartbeat path main.client.ts mountRun uses
{
	const p = newPack();
	let mounted = true;
	logged.length = 0;
	const hb0 = RunService.Heartbeat.conns.length;
	Warm.warmRun(p, () => mounted);
	const hbWarm = RunService.Heartbeat.conns.length;
	for (let i = 0; i < 30; i++) frame(1 / 60);
	check("warmRun espera o 1o segundo da partida (o mais pesado)", p.root === undefined);
	for (let i = 0; i < 60 * 30 && !logged.some(l => l.includes("warm-up: the Bag")); i++) frame(1 / 60);
	const line = logged.find(l => l.includes("warm-up: the Bag"));
	check("...depois constroi o Bag e diz [PZ-LOAD] uma vez quando termina", line !== undefined, line);
	check(
		"...e se desliga do Heartbeat",
		hbWarm === hb0 + 1 && RunService.Heartbeat.conns.length === hb0,
		`${hbWarm - hb0} -> ${RunService.Heartbeat.conns.length - hb0}`,
	);
	logged.length = 0;
	const again = newPack();
	Warm.warmRun(again, () => mounted);
	for (let i = 0; i < 60 * 30 && again.root === undefined; i++) frame(1 / 60);
	for (let i = 0; i < 60 * 30 && RunService.Heartbeat.conns.length > hb0; i++) frame(1 / 60);
	check("a 2a partida aquece tambem, sem repetir a linha do Output", again.root !== undefined && logged.length === 0);
	again.root?.Destroy();
	const p2 = newPack();
	Warm.warmRun(p2, () => mounted);
	const before = RunService.Heartbeat.conns.length;
	mounted = false;
	frame();
	check(
		"a partida sai (Home): o aquecimento para junto, sem conexao sobrando",
		RunService.Heartbeat.conns.length === before - 1,
	);
	p.root?.Destroy();
	p2.root?.Destroy();
	flush();
}

// ---- the lobby: the Survivor page START opens
{
	const noop = () => {};
	const handlers = {
		onPlay: noop,
		onRebirth: noop,
		onWaitDawn: noop,
		onNewRun: noop,
		onShop: noop,
		onWardrobe: noop,
		onSettings: noop,
		onCredits: noop,
		onTutorial: noop,
		onPage: noop,
	};
	const status = { loading: false, run: "fresh", hosted: false, seed: S };
	ctx.phase = "lobby";
	// before: START builds the page
	const a = showLobby(ctx, handlers, status, "menu");
	flush();
	const startCold = measure(() => a.show("survivor"));
	a.close();
	flush();
	// after: built in lobby idle time
	const b = showLobby(ctx, handlers, status, "menu");
	flush();
	const gui = service("GuiService");
	const focusBefore = gui.SelectedObject;
	const pre = measure(() => b.prebuild());
	const page = layer
		.FindFirstChild("Lobby")
		?.GetDescendants()
		.find(d => d.Name === "Survivor");
	check(
		"no ocioso do lobby a tela Survivor e montada escondida: o menu segue na tela, o foco nao sai do START",
		pre.created > 0 && page !== undefined && page.Visible === false && gui.SelectedObject === focusBefore,
		`${pre.created} Instances no ocioso`,
	);
	const startWarm = measure(() => b.show("survivor"));
	check(
		"START so mostra a pagina: nenhuma Instance no clique",
		startWarm.created === 0 && b.page() === "survivor",
		`${startWarm.created} (antes: ${startCold.created})`,
	);
	check("prebuild de novo nao faz nada", b.prebuild() === false);
	b.close();
	flush();
	check("depois de fechado tambem nao", b.prebuild() === false);
	// warmLobby: task.delay -> prebuild
	let delayed;
	globalThis.task.delay = (t, fn) => {
		delayed = [t, fn];
	};
	const c = showLobby(ctx, handlers, status, "menu");
	flush();
	Warm.warmLobby(c);
	check("warmLobby espera um instante no menu (task.delay)", delayed?.[0] === Warm.LOBBY_WARM_DELAY_S);
	logged.length = 0;
	delayed[1]();
	check(
		"...e entao monta a tela Survivor, com uma linha [PZ-LOAD]",
		measure(() => c.show("survivor")).created === 0 && logged.some(l => l.includes("Survivor page is built")),
	);
	c.close();
	flush();
	globalThis.task.delay = realTask.delay;
	console.log(
		`\n  tela Survivor: ${startCold.created} Instances no clique do START antes; 0 depois (${pre.created} no ocioso)`,
	);
}

{
	const mainSrc = read("client/main.client.ts");
	check(
		"main.client.ts: mountRun aquece o Bag, goLobby aquece a tela Survivor (um gancho de uma linha cada)",
		/Boot\.warmRun\(pack, /.test(mainSrc) && /Boot\.warmLobby\(handle\)/.test(mainSrc),
	);
}
console.log(`\n  Bag ${atlasLine}`);
console.log(
	`  Bag sem atlas: antes ${beforeTotal} Instances no clique (abertura ${firstOpen.created} + abas ${tabCosts.join("/")}); ` +
		`depois 0, construidas em ${perFrame.length} quadros ociosos (pior ${maxFrame} Instances/quadro)`,
);

console.log("");
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
}
console.log(
	"OK: a cidade do lobby vai para a partida sem segunda geracao, o preload tem uma ordem so, e o Bag e a tela Survivor nascem no ocioso",
);
