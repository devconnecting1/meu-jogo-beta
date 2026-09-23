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
 *                                 town the flyover drew is field for field the one generateTown returns. Reports the
 *                                 generation time saved, measured here.
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
	const collect = x => {
		if (typeof x !== "object" || x === null || x instanceof Color3 || seen.has(x)) return;
		seen.add(x);
		for (const v of Object.values(x)) collect(v);
	};
	collect(a);
	let shared = 0;
	const probe = (x, visited = new Set()) => {
		if (typeof x !== "object" || x === null || x instanceof Color3 || visited.has(x)) return;
		visited.add(x);
		if (seen.has(x)) shared++;
		for (const v of Object.values(x)) probe(v, visited);
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
Fly.prewarmTown(S);
const other = Cache.takeTown(T);
check(
	"outra semente (o InitBegin corrigiu o palpite): a partida gera a cidade DELA, nao pega a do lobby",
	other !== Fly.townFor(S) && sameTown(other, World.generateTown(T)).length === 0 && gen0() === g + 3,
	`${gen0() - g} geracoes: a do lobby, a da partida e a do lobby de novo`,
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
// (b) in the lobby: the lobby shows S, a WorldReset names T; the lobby's refresh pins T (lobby.ts refresh -> pinFlyover)
fly = Fly.pinFlyover(host, S);
frame();
const oldFly = fly;
g = gen0();
fly = Fly.pinFlyover(host, T);
frame();
const lobbyT = Fly.townFor(T);
check(
	"fim do mundo no lobby: o voo troca para a cidade nova (gerada uma vez) e solta a velha",
	oldFly !== fly && oldFly.layer.Parent === undefined && fly.shows(lobbyT) && gen0() === g + 1,
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
		/generateTown\(seed\)/.test(read("server/sim/worldReset.ts")) &&
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

console.log("");
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
}
console.log("OK: a cidade do lobby vai para a partida sem segunda geracao, e nenhum menu desenha uma cidade mexida");
