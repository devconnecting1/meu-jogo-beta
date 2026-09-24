#!/usr/bin/env node
/*
 * The interactive world, owned by the server (F3, docs/MULTIPLAYER.md §2.4, §4.5, §8.1, §8.3;
 * acceptance in §11.3 F3).
 *
 *   node tools/test-world.mjs
 *   node tools/test-world.mjs --seed 7
 *   PZ_SRC=path/to/src node tools/test-world.mjs
 *
 * It runs the REAL modules — server/sim/{items,interaction,build,craft,simulation}.ts and
 * server/net/replication.ts — on a small hand-built world where every distance is known, driving them the
 * way a client does: `encodeInput` → `ingestInput` → `sim.step()`. Nothing calls a server function directly
 * on behalf of a player, because the whole question is what a PACKET can make the server do.
 *
 * What it proves, in the order of the §11.3 F3 acceptance list:
 *
 *   a. TWO CLIENTS, ONE ITEM: both press E on the same can in the same tick; one walks away with it and the
 *      other walks away with nothing, and the item leaves the world exactly once (§8.3 "atomicidade");
 *   b. TWO CLIENTS, ONE HOUSE: both search the same building in the same tick; the first takes everything,
 *      the second is told it is empty — the loot is not rolled twice and the content never travels (§4.3);
 *   c. ONE DOOR FOR EVERYBODY: opening it is one global `DoorSet`, the solid itself changed (there is one
 *      world, not six), and closing it on a body is refused (§8.1);
 *   d. NO DUPLICATION FROM A FORGED PACKET: a client that claims three action presses in every command, for
 *      hundreds of ticks, at an item and at a looted house, ends with exactly what one press earns;
 *   e. DISTANCE IS THE SERVER'S: a client pressing E from across the street picks up nothing, whatever it
 *      believes about its own position (§8.3 — and there is no position field to lie in);
 *   f. CONSTRUCTION: a craft puts a placeable on the cursor, the attack edge places it where the SERVER says
 *      the survivor is aiming, the flow field is told which tiles changed (§3.3), the §8.1 caps hold, and a
 *      cancel gives the ingredients back;
 *   g. CRAFTING: a forged recipe id, a missing ingredient and a missing station are all refused, and a
 *      refused craft costs nothing (the client's version consumed before it checked);
 *   h. THE DELTAS REACH THE WIRE: everything the tick produced encodes through `encodeWorld` and decodes
 *      back through `decodeWorld` with the same ids, and a late joiner's WorldInit carries the constructions
 *      and the open doors that were made before they arrived (§4.5).
 *   w. THE GROUND IS NOT A WAREHOUSE (security review of 5967a18, #3): items rot after GROUND_ITEM_LIFE_S, the town
 *      holds GROUND_ITEM_CAP (the oldest go first, every client told), the sweep and the E press read the item grid
 *      and give the scan's answers, and the population's cleanup no longer leaves a ghost on a client.
 *   x. CONSTRUCTIONS (MP-24): the per-player cap follows the account through a leave and a rejoin; an abandoned
 *      construction rots after the grace and falls, and whoever repairs it while it rots takes it over; the piece that
 *      would close a ring around a living survivor (the builder too) is refused, a door in the same gap is not.
 *
 * MP_PHASE is NOT changed (tools/test-net.mjs pins it): the simulation is built with `interactive: true`,
 * the switch `zombies: true` already uses for the horde.
 */
import { join } from "node:path";
import { installShims, setSeed } from "./luau-shim.mjs";

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};
const SEED = argValue("--seed", 1);

const { SRC, require } = installShims({ seed: SEED });

const W = require(join(SRC, "shared/game/world.ts"));
const SAVE = require(join(SRC, "shared/game/save.ts"));
const P = require(join(SRC, "shared/net/protocol.ts"));
const CFG = require(join(SRC, "shared/net/mpConfig.ts"));
const PL = require(join(SRC, "server/sim/players.ts"));
const { ServerSimulation } = require(join(SRC, "server/sim/simulation.ts"));
const { WorldClock } = require(join(SRC, "server/sim/waves.ts"));
const { Replicator, mapHashOf } = require(join(SRC, "server/net/replication.ts"));
const { PLACEABLES } = require(join(SRC, "shared/sim/placement.ts"));
const { CRAFT_RECIPES } = require(join(SRC, "shared/data/crafts.ts"));
const { countItem, addItem } = require(join(SRC, "shared/sim/inventory.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const PH = require(join(SRC, "shared/game/physics.ts"));

// ---------------------------------------------------------------- tiny harness

let failures = 0;
let checks = 0;

function check(ok, what, detail) {
	checks += 1;
	console.log(`  ${ok ? "ok   " : "FALHA"} ${what}${detail !== undefined ? `  (${detail})` : ""}`);
	if (!ok) failures += 1;
	return ok;
}

function checkEq(got, want, what) {
	return check(got === want, what, got === want ? undefined : `esperado ${want}, veio ${got}`);
}

function section(title) {
	console.log(`\n${title}`);
}

// ---------------------------------------------------------------- a world, and clients that only send packets

/** an empty field with a floor of solid ground: every distance below is deliberate */
function emptyWorld() {
	const world = W.createWorld(8000, 8000);
	return W.serverWorld(world);
}

/** the simulation under test: the interactive world on, no horde (this suite is not about zombies) */
function newSim(world, clock) {
	return new ServerSimulation({
		world,
		clock: clock ?? new WorldClock({ day: 1, dayTime: 12 }),
		zombies: false,
		interactive: true,
	});
}

/** a survivor with a known backpack, standing exactly where the test puts them */
function addPlayer(sim, slot, x, y, save) {
	const s = save ?? SAVE.defaultSave();
	const sp = PL.createServerPlayer({ slot, userId: 900 + slot, name: `p${slot}` }, s, x, y, sim.tick, sim.simHz);
	sim.add(sp);
	// createServerPlayer places the body; pin it, so a test's distances are the test's
	sp.state.x = x;
	sp.state.y = y;
	return sp;
}

/**
 * Sends one command through the REAL wire: encode → the token bucket and the decoder of `ingestInput`.
 * `edges` is `packEdges(attackPress, attackRelease, actionPress, reload)`.
 */
function send(sp, seq, aim, edges, now) {
	const cmd = P.makeCommand(seq, 0, 0, aim, 0, edges);
	const packet = { viewTick: 0, viewFrac: 0, cmds: [cmd] };
	const payload = P.encodeInput(packet);
	return PL.ingestInput(sp, payload, now ?? 0);
}

/** presses E once, this tick */
const PRESS_E = P.packEdges(0, 0, 1, 0);
/** the forged packet: three of every edge, every single command */
const PRESS_ALL_X3 = P.packEdges(3, 0, 3, 3);

/** runs `n` ticks and collects every world delta the simulation produced */
function run(sim, n = 1) {
	const seen = [];
	sim.onInteract = (sp, outcome) => seen.push({ slot: sp.slot, outcome });
	for (let i = 0; i < n; i++) sim.step();
	return seen;
}

/** the deltas waiting in the simulation's outbox, drained (what server/net/replication.ts would send) */
function drain(sim) {
	const out = [];
	sim.worldOut.take(out);
	return out;
}

function countDeltas(pending, tag) {
	return pending.filter(p => p.ev.t === tag).length;
}

/**
 * Rolls a building's loot until the roll produces something, walking the seed.
 *
 * Every slot of the original's table may come up empty -- most entries are "a 15 % chance of exactly one" --
 * so a fixed seed sometimes rolls three blanks and the test would be measuring the dice. The search is
 * deterministic (it always starts at the same seed and always walks the same way), and the seed it lands on
 * is printed, so a failure is still reproducible.
 */
function rollLootUntilFilled(sim, building, fromSeed) {
	for (let seed = fromSeed; seed < fromSeed + 64; seed++) {
		setSeed(seed);
		sim.items.rollLoot(building);
		if (building.lootItems.size() > 0) return seed;
	}
	return -1;
}

// ================================================================ a. two clients, one item

section("a) dois clientes disputam o mesmo item: um leva, o outro nao (§8.3, aceite F3)");
{
	const world = emptyWorld();
	const sim = newSim(world);
	const a = addPlayer(sim, 0, 1000, 1000);
	const b = addPlayer(sim, 1, 1010, 1000);
	// wood, right between them and inside everybody's reach
	const item = W.spawnGroundItem(world, 4, 23, 7, 1005, 1000);
	drain(sim);

	const beforeA = countItem(a.save, 4, 23);
	const beforeB = countItem(b.save, 4, 23);
	send(a, 1, 0, PRESS_E);
	send(b, 1, 0, PRESS_E);
	run(sim, 1);

	const gotA = countItem(a.save, 4, 23) - beforeA;
	const gotB = countItem(b.save, 4, 23) - beforeB;
	checkEq(gotA + gotB, 7, "a madeira foi parar em exatamente uma mochila, inteira");
	check(gotA === 0 || gotB === 0, "e a outra mochila nao recebeu nada", `A +${gotA}, B +${gotB}`);
	checkEq(world.items.size(), 0, "o item saiu do mundo");
	const pending = drain(sim);
	// one removal, told to each client that had been told about the item (a ghost otherwise stays on a screen)
	const removes = pending.filter(d => d.ev.t === P.WorldEv.ItemRemove);
	checkEq([...new Set(removes.map(d => d.ev.id))].length, 1, "e sumiu do mundo UMA vez (um so id removido)");
	checkEq(
		removes
			.map(d => d.slot)
			.sort()
			.join(","),
		"0,1",
		"avisado uma vez a cada cliente que o via",
	);

	// the loser presses again, at an item that is gone
	const again = countItem(gotA > 0 ? b.save : a.save, 4, 23);
	send(gotA > 0 ? b : a, 2, 0, PRESS_E);
	run(sim, 1);
	checkEq(countItem(gotA > 0 ? b.save : a.save, 4, 23), again, "e insistir no item que ja foi nao rende nada");
	checkEq(item.id >= CFG.DYNAMIC_ID_BASE, true, "o item nasceu com id dinamico (§4.5)");
}

// ================================================================ b. two clients, one house

section("b) dois clientes revistam o mesmo predio: so um recebe (aceite F3)");
{
	const world = emptyWorld();
	const sim = newSim(world);
	const b = W.addSolid(world, {
		kind: "building",
		x: 900,
		y: 900,
		w: 400,
		h: 400,
		hp: 100,
		hpMax: 100,
		destructible: false,
		tags: "house",
		buildingType: 0,
		passable: true,
		lootSlots: 3,
		lootItems: [],
		lootTimer: 0,
	});
	const p0 = addPlayer(sim, 0, 1000, 1000);
	const p1 = addPlayer(sim, 1, 1100, 1100);
	// roll the loot once, exactly as the proximity sweep would
	const usedSeed = rollLootUntilFilled(sim, b, SEED + 1);
	const rolled = b.lootItems.map(d => ({ ...d }));
	check(rolled.length > 0, "o predio tem loot", `${rolled.length} entrada(s), seed ${usedSeed}`);
	drain(sim);

	const before0 = rolled.map(d => countItem(p0.save, d.kind, d.id));
	const before1 = rolled.map(d => countItem(p1.save, d.kind, d.id));
	send(p0, 1, 0, PRESS_E);
	send(p1, 1, 0, PRESS_E);
	const seen = run(sim, 1);

	const got0 = rolled.reduce((n, d, i) => n + (countItem(p0.save, d.kind, d.id) - before0[i]), 0);
	const got1 = rolled.reduce((n, d, i) => n + (countItem(p1.save, d.kind, d.id) - before1[i]), 0);
	const total = rolled.reduce((n, d) => n + d.count, 0);
	checkEq(got0 + got1, total, "o loot inteiro foi para uma mochila");
	check(got0 === 0 || got1 === 0, "e a outra ficou vazia", `p0 +${got0}, p1 +${got1}`);
	checkEq(b.lootItems.size(), 0, "o predio ficou vazio");
	check(
		b.lootTimer > 0,
		"e so volta a ter loot depois do respawn em horas de jogo",
		`lootTimer ${b.lootTimer.toFixed(1)} h`,
	);
	const searches = seen.filter(s => s.outcome.kind === "search");
	checkEq(searches.length, 1, "houve exatamente um saque na tick, nao dois");
	/*
	 * Why the second player's press is a "none" and not a refusal: `interactTarget` only offers a building
	 * that still HAS loot, so once the first survivor emptied it there is nothing to press E on — which is
	 * also why the second one's HUD stops showing "E: Search". `search()` still double-checks, because the
	 * ordering that makes this safe is a property of the tick and not something to rely on by accident.
	 */
	const secondTry = sim.items.search(p1.save, p1.state.x, p1.state.y, 12);
	checkEq(secondTry.building, b, "o segundo pedido ainda encontra o predio");
	checkEq(secondTry.taken.size(), 0, "e recebe vazio (§8.1: o primeiro pedido leva tudo)");
}

// ================================================================ c. one door for everybody

section("c) a porta e a mesma para todo mundo (§4.5, aceite F3)");
{
	const world = emptyWorld();
	const sim = newSim(world);
	const door = W.addSolid(world, {
		kind: "door",
		x: 1000,
		y: 1000,
		w: 128,
		h: 32,
		hp: 200,
		hpMax: 200,
		destructible: true,
		tags: "door",
		rot: 0,
		open: false,
		placeable: 11,
		owner: 0,
	});
	const a = addPlayer(sim, 0, 1064, 980);
	const b = addPlayer(sim, 1, 1064, 1500);
	drain(sim);

	send(a, 1, 0, PRESS_E);
	run(sim, 1);
	checkEq(door.open, true, "a porta abriu");
	const pending = drain(sim);
	const doorSets = pending.filter(p => p.ev.t === P.WorldEv.DoorSet);
	checkEq(doorSets.length, 1, "um unico DoorSet foi enfileirado");
	checkEq(doorSets[0].slot, CFG.SLOT_NONE, "para TODO MUNDO, nao por interesse (todos preveem colisao nela)");
	checkEq(doorSets[0].ev.state, P.SolidState.Open, "dizendo que ela esta aberta");
	// b is 500 u away, out of reach, and reads the very same solid: there is one world
	checkEq(W.querySolids(world, 1000, 1000, 1128, 1032).find(s => s.id === door.id).open, true, "b ve a mesma porta");

	// §8.1: a door cannot be closed on a body (a press per PRESS_COOLDOWN_S, a door change per TOGGLE_COOLDOWN_S)
	run(sim, 20);
	b.state.x = 1064;
	b.state.y = 1016;
	send(a, 2, 0, PRESS_E);
	const seen = run(sim, 1);
	checkEq(door.open, true, "fechar a porta em cima de alguem e recusado");
	checkEq(seen[0].outcome.kind, "refused", "e o servidor diz por que");
	checkEq(seen[0].outcome.why, "blocked", "'blocked'");

	// move the body out of the way and it closes
	run(sim, 20);
	b.state.y = 1500;
	send(a, 3, 0, PRESS_E);
	run(sim, 1);
	checkEq(door.open, false, "com o caminho livre, fecha");

	// and a client standing across the street cannot touch it at all
	const far = addPlayer(sim, 2, 3000, 3000);
	send(far, 1, 0, PRESS_E);
	run(sim, 1);
	checkEq(door.open, false, "quem esta longe nao abre porta nenhuma (§8.1: alcance do SERVIDOR)");
}

// ================================================================ d. the forged packet

section("d) pacote forjado: 3 pressoes por comando, centenas de ticks, e nada duplica (§8.1, §9.1)");
{
	const world = emptyWorld();
	const sim = newSim(world);
	const p = addPlayer(sim, 0, 1000, 1000);
	W.spawnGroundItem(world, 4, 23, 5, 1005, 1000);
	drain(sim);

	const before = countItem(p.save, 4, 23);
	// the hostile client: every command claims the maximum number of every edge, for 300 ticks
	for (let seq = 1; seq <= 300; seq++) send(p, seq, 0, PRESS_ALL_X3, seq / CFG.SIM_HZ);
	run(sim, 300);
	checkEq(countItem(p.save, 4, 23) - before, 5, "a madeira entrou exatamente uma vez");
	checkEq(world.items.size(), 0, "e o mundo nao tem itens fantasma");
	const pending = drain(sim);
	checkEq(countDeltas(pending, P.WorldEv.ItemRemove), 1, "um unico ItemRemove");

	// the same client, on a building it already emptied
	const b = W.addSolid(world, {
		kind: "building",
		x: 900,
		y: 900,
		w: 400,
		h: 400,
		hp: 100,
		hpMax: 100,
		destructible: false,
		tags: "house",
		buildingType: 0,
		passable: true,
		lootSlots: 2,
		lootItems: [],
		lootTimer: 1e9,
	});
	rollLootUntilFilled(sim, b, SEED + 2);
	const loot = b.lootItems.map(d => ({ ...d }));
	check(loot.length > 0, "o predio tem loot para roubar", `${loot.length} entrada(s)`);
	const had = loot.map(d => countItem(p.save, d.kind, d.id));
	for (let seq = 301; seq <= 600; seq++) send(p, seq, 0, PRESS_ALL_X3, seq / CFG.SIM_HZ);
	run(sim, 300);
	const gained = loot.reduce((n, d, i) => n + (countItem(p.save, d.kind, d.id) - had[i]), 0);
	checkEq(
		gained,
		loot.reduce((n, d) => n + d.count, 0),
		"o predio pagou o saque uma unica vez",
	);
	checkEq(b.lootItems.size(), 0, "e continua vazio");
}

// ================================================================ e. the distance is the server's

section("e) a distancia e medida na posicao do SERVIDOR (§8.3)");
{
	const world = emptyWorld();
	const sim = newSim(world);
	const p = addPlayer(sim, 0, 1000, 1000);
	// just past the allowance: DESIGN.ITEM_GET_DISTANCE is also what `nearestGroundItem` uses to FIND it
	const far = DESIGN.ITEM_GET_DISTANCE + 60;
	W.spawnGroundItem(world, 4, 23, 3, 1000 + far, 1000);
	drain(sim);
	const before = countItem(p.save, 4, 23);
	for (let seq = 1; seq <= 60; seq++) send(p, seq, 0, PRESS_E, seq / CFG.SIM_HZ);
	run(sim, 60);
	checkEq(countItem(p.save, 4, 23), before, `um item a ${far} u nao entra na mochila`);
	checkEq(world.items.size(), 1, "e continua no chao");
}

// ================================================================ f. construction

section("f) construcao: o servidor coloca, conta e devolve os ingredientes (§4.5, §8.1)");
{
	const world = emptyWorld();
	const sim = newSim(world);
	const p = addPlayer(sim, 0, 2000, 2000);
	p.state.angle = 0;
	drain(sim);

	// a barricade recipe: whatever craftKind 1 makes, taken straight from the data
	const recipe = CRAFT_RECIPES.find(r => r.craftKind === 1 && PLACEABLES[r.resultIndex] !== undefined);
	check(recipe !== undefined, "existe uma receita de construcao nos dados");
	for (const ing of recipe.ingredients) addItem(p.save, ing.kind, ing.index, ing.count * 4);
	const spent = recipe.ingredients.map(ing => countItem(p.save, ing.kind, ing.index));

	checkEq(sim.craft.craft(0, p.state, p.save, recipe.id).kind, "holding", "craftar um placeavel poe no cursor");
	checkEq(sim.build.placing(0), true, "e o servidor sabe que ele esta posicionando");
	for (let i = 0; i < recipe.ingredients.size(); i++) {
		const ing = recipe.ingredients[i];
		checkEq(countItem(p.save, ing.kind, ing.index), spent[i] - ing.count, `o ingrediente ${ing.index} foi gasto`);
	}

	const solidsBefore = world.solids.size();
	send(p, 1, 0, P.packEdges(1, 0, 0, 0));
	run(sim, 1);
	checkEq(world.solids.size(), solidsBefore + 1, "a construcao entrou no mundo");
	const built = world.solids[world.solids.size() - 1];
	check(built.id >= CFG.DYNAMIC_ID_BASE, "com id dinamico (§4.5)", `id ${built.id}`);
	checkEq(built.owner, 0, "e com dono");
	checkEq(sim.build.countOf(0), 1, "que conta para o teto por jogador");
	checkEq(sim.build.placing(0), false, "o cursor ficou livre");
	const pending = drain(sim);
	const adds = pending.filter(d => d.ev.t === P.WorldEv.SolidAdd);
	checkEq(adds.length, 1, "um SolidAdd foi enfileirado");
	checkEq(adds[0].slot, CFG.SLOT_NONE, "global: todo mundo colide com ela");
	checkEq(adds[0].ev.id, built.id, "com o id certo");
	checkEq(adds[0].ev.placeable, recipe.resultIndex, "e o placeavel certo");

	// the ghost lands where the SERVER says the survivor is aiming, on the grid
	check(
		Math.abs(built.x - p.state.x) < 400 && Math.abs(built.y - p.state.y) < 400,
		"e ela nasceu junto do sobrevivente, na direcao da mira",
		`(${built.x}, ${built.y}) vs (${p.state.x}, ${p.state.y})`,
	);

	// a cancel gives the ingredients back
	const before = recipe.ingredients.map(ing => countItem(p.save, ing.kind, ing.index));
	sim.craft.craft(0, p.state, p.save, recipe.id);
	send(p, 2, 0, P.packEdges(0, 0, 1, 0));
	run(sim, 1);
	checkEq(sim.build.placing(0), false, "cancelar tira do cursor");
	for (let i = 0; i < recipe.ingredients.size(); i++) {
		const ing = recipe.ingredients[i];
		checkEq(countItem(p.save, ing.kind, ing.index), before[i], `o ingrediente ${ing.index} voltou`);
	}

	// a destroyed construction gives its cap slot back and announces itself
	W.removeSolid(world, built);
	checkEq(sim.build.countOf(0), 0, "derrubar a construcao devolve a vaga do teto");
	checkEq(countDeltas(drain(sim), P.WorldEv.SolidRemove), 1, "e manda um SolidRemove");
}

section("f2) uma construcao suja exatamente os tiles dela no flow field (§3.3)");
{
	const world = emptyWorld();
	const clock = new WorldClock({ day: 1, dayTime: 12 });
	// with the horde on, so the hook the build system calls is the horde's real one
	const sim = new ServerSimulation({ world, clock, zombies: true, interactive: true });
	const p = addPlayer(sim, 0, 3000, 3000);
	p.state.angle = 0;
	const dirtied = [];
	const real = sim.horde.refs.onSolidChanged;
	sim.horde.refs.onSolidChanged = (x, y, w, h) => {
		dirtied.push({ x, y, w, h });
		real(x, y, w, h);
	};
	sim.build.hold(0, 10, undefined);
	const placed = sim.build.place(0, p.state, [p.state], []);
	checkEq(placed.kind, "placed", "a construcao entrou");
	checkEq(dirtied.length, 1, "e o flow field foi avisado uma vez");
	checkEq(dirtied[0].x, placed.solid.x, "com o x da construcao");
	checkEq(dirtied[0].w, placed.solid.w, "e a largura dela (nao o mundo inteiro)");

	W.removeSolid(world, placed.solid);
	checkEq(dirtied.length, 2, "derruba-la tambem avisa");
}

section("f3) abrir uma porta com E suja o flow field da horda, e o caminho passa a ser por ela (§3.3)");
{
	const world = emptyWorld();
	const clock = new WorldClock({ day: 1, dayTime: 12 });
	const sim = new ServerSimulation({ world, clock, zombies: true, interactive: true });
	// a wall across the whole map, and ONE way through it: the door
	const wallAt = (x, w) =>
		W.addSolid(world, {
			kind: "wall_h",
			x,
			y: 1000,
			w,
			h: 32,
			hp: 1000,
			hpMax: 1000,
			destructible: false,
			tags: "bwall",
			rot: 0,
		});
	wallAt(0, 1000);
	wallAt(1128, world.width - 1128);
	const door = W.addSolid(world, {
		kind: "door",
		x: 1000,
		y: 1000,
		w: 128,
		h: 32,
		hp: 200,
		hpMax: 200,
		destructible: true,
		tags: "door",
		rot: 0,
		open: false,
		placeable: 11,
		owner: 0,
	});
	const a = addPlayer(sim, 0, 1064, 980);
	const dirtied = [];
	const real = sim.horde.refs.onSolidChanged;
	sim.horde.refs.onSolidChanged = (x, y, w, h) => {
		dirtied.push({ x, y, w, h });
		real(x, y, w, h);
	};
	run(sim, 90);
	const field = sim.horde.field;
	const closed = field.pathCells(1064, 1200);
	const r0 = field.rebuilds;
	run(sim, 60);
	checkEq(field.rebuilds, r0, "com todo mundo parado, o campo nao e reconstruido (nada mudou)");
	send(a, 1, 0, PRESS_E);
	run(sim, 1);
	checkEq(door.open, true, "a porta abriu");
	checkEq(dirtied.length, 1, "e o flow field foi avisado");
	checkEq(dirtied[0].x, door.x, "no retangulo da porta");
	run(sim, 120);
	check(field.rebuilds > r0, "o campo foi reconstruido", `${field.rebuilds - r0} vez(es)`);
	const open = field.pathCells(1064, 1200);
	check(open < closed, "e o caminho pela porta aberta ficou mais barato", `${closed} -> ${open} celulas`);
}

section("g) os tetos de construcao do §8.1 valem");
{
	const world = emptyWorld();
	const sim = newSim(world);
	const p = addPlayer(sim, 0, 4000, 4000);
	// fill the player's quota straight into the world (the cap counts constructions, not placements)
	for (let i = 0; i < CFG.MAX_BUILDS_PER_PLAYER; i++) {
		W.addSolid(world, {
			kind: "barricade",
			x: 10 + (i % 50) * 130,
			y: 10 + Math.floor(i / 50) * 130,
			w: 64,
			h: 64,
			hp: 100,
			hpMax: 100,
			destructible: true,
			tags: "barricade",
			placeable: 10,
			owner: 0,
		});
	}
	checkEq(sim.build.countOf(0), CFG.MAX_BUILDS_PER_PLAYER, `o jogador ja tem ${CFG.MAX_BUILDS_PER_PLAYER}`);
	sim.build.hold(0, 10, undefined);
	const refused = sim.build.place(0, p.state, [p.state], []);
	checkEq(refused.kind, "refused", "a proxima e recusada");
	checkEq(refused.why, "capPlayer", "pelo teto por jogador");
	checkEq(sim.build.placing(0), true, "e ela continua no cursor (nao se perde)");
}

// ================================================================ h. crafting

section("h) craft: receita forjada, ingrediente faltando e bancada ausente sao recusados (§8.1)");
{
	const world = emptyWorld();
	const sim = newSim(world);
	const p = addPlayer(sim, 0, 5000, 5000);

	checkEq(sim.craft.craft(0, p.state, p.save, 99999).kind, "refused", "um id de receita inventado e recusado");
	checkEq(sim.craft.craft(0, p.state, p.save, -1).kind, "refused", "um id negativo tambem");

	const needsDesk = CRAFT_RECIPES.find(r => r.needsDesk && r.craftKind !== 1);
	check(needsDesk !== undefined, "existe uma receita que precisa de bancada");
	for (const ing of needsDesk.ingredients) addItem(p.save, ing.kind, ing.index, ing.count * 2);
	const stock = needsDesk.ingredients.map(ing => countItem(p.save, ing.kind, ing.index));
	const noDesk = sim.craft.craft(0, p.state, p.save, needsDesk.id);
	checkEq(noDesk.kind, "refused", "sem bancada por perto, recusado");
	checkEq(noDesk.why, "station", "por 'station'");
	for (let i = 0; i < needsDesk.ingredients.size(); i++) {
		const ing = needsDesk.ingredients[i];
		checkEq(countItem(p.save, ing.kind, ing.index), stock[i], `e o ingrediente ${ing.index} NAO foi gasto`);
	}

	// put a desk next to them and it works
	W.addSolid(world, {
		kind: "structure",
		x: 5050,
		y: 5000,
		w: 96,
		h: 64,
		hp: 200,
		hpMax: 200,
		destructible: true,
		tags: "craftdesk_pro",
		placeable: 1,
		owner: 0,
	});
	const made = sim.craft.craft(0, p.state, p.save, needsDesk.id);
	checkEq(made.kind, "crafted", "com bancada, sai");
	checkEq(countItem(p.save, needsDesk.resultKind, needsDesk.resultIndex) > 0, true, "e o resultado entrou");

	// the rate limit, and an empty backpack
	sim.craft.step(1);
	const empty = SAVE.defaultSave();
	const q = addPlayer(sim, 1, 5000, 5000, empty);
	q.state.x = 5000;
	q.state.y = 5000;
	const broke = sim.craft.craft(1, q.state, q.save, needsDesk.id);
	checkEq(broke.kind, "refused", "sem ingredientes, recusado");
	checkEq(broke.why, "ingredients", "por 'ingredients'");
}

section("i) aprender skill e equipar passam pelas mesmas regras");
{
	const world = emptyWorld();
	const sim = newSim(world);
	const p = addPlayer(sim, 0, 6000, 6000);
	p.save.skillPoint = 0;
	checkEq(sim.craft.learnSkill(p.save, 0).kind, "refused", "sem ponto de skill, nao aprende");
	p.save.skillPoint = 2;
	const learned = sim.craft.learnSkill(p.save, 0);
	checkEq(learned.kind, "learned", "com ponto, aprende");
	checkEq(p.save.skillPoint, 1, "e o ponto foi gasto");
	checkEq(sim.craft.learnSkill(p.save, 99999).kind, "refused", "uma skill inventada e recusada");
	checkEq(sim.craft.equip(p.save, 99999).kind, "refused", "um equipamento inventado e recusado");
	checkEq(sim.craft.equip(p.save, 0).kind === "refused", true, "e um que nao se possui tambem");
}

section("m) o LootFlag vai para o SLOT certo, nao para a posicao na lista (§4.3)");
{
	const world = emptyWorld();
	const sim = newSim(world);
	const b = W.addSolid(world, {
		kind: "building",
		x: 900,
		y: 900,
		w: 400,
		h: 400,
		hp: 100,
		hpMax: 100,
		destructible: false,
		tags: "house",
		buildingType: 0,
		passable: true,
		lootSlots: 3,
		lootItems: [],
		lootTimer: 0,
	});
	// slots 0 and 3, deliberately NOT 0 and 1: the roster index and the slot are different numbers, and
	// sending a directed delta to the index is a bug that only shows up when they differ
	const outside = addPlayer(sim, 0, 5000, 5000);
	const inside = addPlayer(sim, 3, 1100, 1100);
	rollLootUntilFilled(sim, b, SEED + 5);
	drain(sim);

	run(sim, 1);
	const flags = drain(sim).filter(d => d.ev.t === P.WorldEv.LootFlag);
	checkEq(flags.length, 1, "um unico LootFlag");
	checkEq(flags[0].slot, 3, "para o slot 3, que e quem esta dentro");
	checkEq(flags[0].ev.hasLoot, true, "dizendo que ha o que revistar");
	checkEq(flags[0].ev.buildingId, b.id, "naquele predio");
	check(outside.slot === 0 && inside.slot === 3, "os slots do teste sao mesmo 0 e 3");

	// emptying it turns the hint off, for whoever is inside
	send(inside, 1, 0, PRESS_E);
	run(sim, 2);
	const off = drain(sim).filter(d => d.ev.t === P.WorldEv.LootFlag && d.ev.hasLoot === false);
	checkEq(off.length, 1, "e esvaziar apaga a dica");
	checkEq(off[0].slot, 3, "para o mesmo slot");

	// walking out of the building does not send a second "off"
	inside.state.x = 6000;
	inside.state.y = 6000;
	run(sim, 2);
	checkEq(drain(sim).filter(d => d.ev.t === P.WorldEv.LootFlag).length, 0, "sair nao repete o aviso");
}

section("n) as construcoes de quem sai param de contar para o slot (§4.4)");
{
	const world = emptyWorld();
	const sim = newSim(world);
	const p = addPlayer(sim, 0, 7000, 7000);
	for (let i = 0; i < 3; i++) {
		W.addSolid(world, {
			kind: "barricade",
			x: 100 + i * 200,
			y: 100,
			w: 64,
			h: 64,
			hp: 100,
			hpMax: 100,
			destructible: true,
			tags: "barricade",
			placeable: 10,
			owner: 0,
		});
	}
	checkEq(sim.build.countOf(0), 3, "o jogador construiu 3");
	checkEq(sim.build.count(), 3, "e o servidor conta 3");
	sim.remove(p.slot);
	checkEq(sim.build.countOf(0), 0, "ele saiu: o slot 0 volta limpo para quem chegar");
	checkEq(sim.build.count(), 3, "mas as paredes continuam de pe, e contam para o teto do servidor");
	checkEq(world.solids.size(), 3, "o mundo nao perdeu a base");
}

section("o) as consultas de item continuam corretas, e param de custar caro");
{
	const world = emptyWorld();
	const IQ = require(join(SRC, "shared/sim/interactQuery.ts"));
	const reach = DESIGN.ITEM_GET_DISTANCE;
	// one just inside reach, one just outside, one far away: the box+quadrado tem de dar a MESMA resposta
	const inside = W.spawnGroundItem(world, 4, 23, 1, 1000 + reach - 1, 1000);
	W.spawnGroundItem(world, 4, 23, 1, 1000 + reach + 1, 1000);
	W.spawnGroundItem(world, 4, 23, 1, 4000, 4000);
	checkEq(IQ.nearestGroundItem(world, 1000, 1000), inside, "pega o que esta dentro do alcance");
	checkEq(IQ.nearestGroundItem(world, 1000, 1000 + reach + 5), undefined, "e nenhum quando nada esta perto");
	// the nearest wins, not the first in the list
	const nearer = W.spawnGroundItem(world, 4, 23, 1, 1005, 1000);
	checkEq(IQ.nearestGroundItem(world, 1000, 1000), nearer, "e escolhe o mais proximo, nao o primeiro");
	// exactly at the limit is out, as it always was (strictly less than)
	const edgeWorld = emptyWorld();
	W.spawnGroundItem(edgeWorld, 4, 23, 1, 1000 + reach, 1000);
	checkEq(IQ.nearestGroundItem(edgeWorld, 1000, 1000), undefined, `exatamente a ${reach} u fica de fora`);

	// items at rest are not integrated any more; the ones in flight still are
	const moving = emptyWorld();
	const still = W.spawnGroundItem(moving, 4, 23, 1, 2000, 2000);
	const thrown = W.spawnGroundItem(moving, 4, 23, 1, 2000, 2000, 120, 0);
	W.updateGroundItems(moving, 1 / 60);
	checkEq(still.x, 2000, "o item parado nao se moveu");
	check(thrown.x > 2000, "e o que foi arremessado se moveu", `x ${thrown.x.toFixed(1)}`);
	for (let i = 0; i < 300; i++) W.updateGroundItems(moving, 1 / 60);
	checkEq(thrown.vx, 0, "o arremessado acabou parando");
	check(thrown.life === undefined && still.life === undefined, "e nenhum item carrega um 'life' morto");

	// a scavenged town: 4000 items lying around, the per-frame cost of the two things that touch them all
	const heavy = emptyWorld();
	for (let i = 0; i < 4000; i++) {
		W.spawnGroundItem(heavy, 4, 23, 1, 200 + (i % 80) * 90, 200 + Math.floor(i / 80) * 90);
	}
	const FRAMES = 600;
	let t0 = performance.now();
	for (let f = 0; f < FRAMES; f++) W.updateGroundItems(heavy, 1 / 60);
	const physMs = (performance.now() - t0) / FRAMES;
	t0 = performance.now();
	for (let f = 0; f < FRAMES; f++) IQ.nearestGroundItem(heavy, 3000, 3000);
	const queryMs = (performance.now() - t0) / FRAMES;
	console.log(
		`        4000 itens no chao: fisica ${physMs.toFixed(4)} ms/quadro . busca do E ${queryMs.toFixed(4)} ms/quadro`,
	);
	check(physMs < 0.5, "a fisica de 4000 itens parados custa quase nada", `${physMs.toFixed(4)} ms`);
	check(queryMs < 0.5, "e a busca do E tambem", `${queryMs.toFixed(4)} ms`);
}

// ================================================================ the wire

section("j) tudo isso chega ao fio: encodeWorld -> decodeWorld sem perder um id (§4.5)");
{
	const world = emptyWorld();
	const sim = newSim(world);
	const p = addPlayer(sim, 0, 1000, 1000);
	const door = W.addSolid(world, {
		kind: "door",
		x: 1000,
		y: 1040,
		w: 128,
		h: 32,
		hp: 200,
		hpMax: 200,
		destructible: true,
		tags: "door",
		rot: 0,
		open: false,
		placeable: 11,
		owner: 0,
	});
	W.spawnGroundItem(world, 4, 23, 2, 1010, 1000);
	send(p, 1, 0, PRESS_E);
	run(sim, 1);
	const pending = drain(sim);
	const events = pending.map(d => d.ev);
	check(events.length > 0, "a tick produziu deltas", `${events.length}`);
	const encoded = P.encodeWorld({ tick: 7, events });
	checkEq(encoded.dropped, 0, "nenhum delta foi grande demais para o pacote");
	let decoded = 0;
	const ids = [];
	for (const packet of encoded.packets) {
		const batch = P.decodeWorld(packet);
		check(batch !== undefined, "o pacote decodifica");
		for (const e of batch.events) {
			decoded += 1;
			if (e.id !== undefined) ids.push(e.id);
		}
	}
	checkEq(decoded, events.length, "e volta com a mesma quantidade de eventos");
	check(
		ids.every(id => id >= CFG.DYNAMIC_ID_BASE || id === door.id),
		"todo id dinamico sobreviveu a viagem",
		ids.join(", "),
	);
}

section("k) quem entra depois recebe o mundo que ja existia (WorldInit, §4.5)");
{
	const world = emptyWorld();
	const sim = newSim(world);
	const first = addPlayer(sim, 0, 1000, 1000);
	first.state.angle = 0;
	// something built, a door somebody opened, and an item on the ground
	const built = W.addSolid(world, {
		kind: "barricade",
		x: 1200,
		y: 1000,
		w: 64,
		h: 64,
		hp: 100,
		hpMax: 100,
		destructible: true,
		tags: "barricade",
		placeable: 10,
		owner: 0,
	});
	const door = W.addSolid(world, {
		kind: "door",
		x: 1400,
		y: 1000,
		w: 128,
		h: 32,
		hp: 200,
		hpMax: 200,
		destructible: true,
		tags: "door",
		rot: 0,
		open: true,
		placeable: 11,
		owner: 0,
	});
	// a door that is part of the generated map (no `placeable`): it has no SolidAdd to ride, so its open
	// state is the one thing about it the mirror could not have generated for itself
	const mapDoor = W.addSolid(world, {
		kind: "door",
		x: 1600,
		y: 1000,
		w: 128,
		h: 32,
		hp: 200,
		hpMax: 200,
		destructible: true,
		tags: "door",
		rot: 0,
		open: true,
	});
	const item = W.spawnGroundItem(world, 4, 23, 1, 1100, 1000);
	drain(sim);

	const sent = [];
	const replicator = new Replicator(
		sim,
		{
			snap: () => {},
			fx: () => {},
			world: (slot, packet) => sent.push({ slot, packet }),
			worldAll: packet => sent.push({ slot: CFG.SLOT_NONE, packet }),
		},
		{ tick0Time: 0, mapHash: mapHashOf(world) },
	);
	const late = addPlayer(sim, 1, 1000, 1000);
	replicator.welcome(late);
	replicator.afterTick(1);

	const mine = sent.filter(s => s.slot === 1);
	check(mine.length > 0, "o recem-chegado recebeu um lote reliable", `${mine.length} pacote(s)`);
	const got = [];
	for (const s of mine) {
		const batch = P.decodeWorld(s.packet);
		check(batch !== undefined, "que decodifica");
		for (const e of batch.events) got.push(e);
	}
	checkEq(got[0].t, P.WorldEv.InitBegin, "comecando por InitBegin");
	check(
		got.some(e => e.t === P.WorldEv.SolidAdd && e.id === built.id),
		"a construcao que ja existia veio",
	);
	// a BUILT door is a construction: its open state rides its own SolidAdd, not a separate DoorSet
	const doorAdd = got.find(e => e.t === P.WorldEv.SolidAdd && e.id === door.id);
	check(doorAdd !== undefined, "a porta construida veio como construcao");
	check(doorAdd !== undefined && (doorAdd.state & P.SolidState.Open) !== 0, "e ja veio aberta, como alguem a deixou");
	check(
		got.some(e => e.t === P.WorldEv.DoorSet && e.id === mapDoor.id && e.state === P.SolidState.Open),
		"uma porta do mapa gerado que alguem abriu vem como DoorSet",
	);
	check(
		got.some(e => e.t === P.WorldEv.ItemAdd && e.id === item.id),
		"e o item no chao, que esta dentro do interesse",
	);
}

section("l) itens fora do interesse nao viajam, e o que cada cliente viu e seguido ate sumir (§4.3, §4.5)");
{
	const world = emptyWorld();
	const sim = newSim(world);
	const near = addPlayer(sim, 0, 1000, 1000);
	const far = addPlayer(sim, 1, 1000 + CFG.ITEM_INTEREST + 500, 1000);
	// one tick, so the simulation knows where its survivors stand
	run(sim, 1);
	drain(sim);
	// 100 u off the survivor: a supply under the body would be walked up (ITM-07), and this is about who is told
	const item = W.spawnGroundItem(world, 4, 23, 1, 1100, 1000);
	const pending = drain(sim);
	const adds = pending.filter(d => d.ev.t === P.WorldEv.ItemAdd);
	checkEq(adds.length, 1, "um ItemAdd foi enfileirado");
	checkEq(adds[0].slot, near.slot, "so para quem esta perto dele");
	check(near.slot === 0 && far.slot === 1, "com um jogador perto e um longe");
	check(Math.abs(far.state.x - item.x) > CFG.ITEM_INTEREST, "e o jogador distante esta fora do raio");

	// the far survivor walks up to it: the sweep tells them, once
	far.state.x = 1200;
	run(sim, 40);
	const late = drain(sim).filter(d => d.ev.t === P.WorldEv.ItemAdd && d.ev.id === item.id);
	checkEq(late.length, 1, "quem chega perto depois recebe o ItemAdd (a varredura de interesse)");
	checkEq(late[0]?.slot, far.slot, "so ele");
	run(sim, 40);
	checkEq(countDeltas(drain(sim), P.WorldEv.ItemAdd), 0, "e so uma vez");

	// the first survivor walks far away; somebody takes the item: they are still told it is gone
	near.state.x = 1000 + CFG.ITEM_INTEREST + 200; // past ITEM_INTEREST, inside the exit hysteresis
	run(sim, 40);
	drain(sim);
	W.removeGroundItem(world, item);
	const gone = drain(sim).filter(d => d.ev.t === P.WorldEv.ItemRemove && d.ev.id === item.id);
	checkEq(gone.length, 2, "o ItemRemove vai para os DOIS que o viram, perto ou longe (sem item fantasma)");

	// an item left behind past the exit radius leaves that screen, and comes back with the survivor
	const kept = W.spawnGroundItem(world, 4, 23, 1, 1200, 1000);
	drain(sim);
	far.state.x = 1200 + 2600;
	run(sim, 40);
	const left = drain(sim).filter(d => d.ev.t === P.WorldEv.ItemRemove && d.ev.id === kept.id);
	checkEq(left.length, 1, "longe demais, o item sai da tela de quem se afastou");
	far.state.x = 1300;
	run(sim, 40);
	const back = drain(sim).filter(d => d.ev.t === P.WorldEv.ItemAdd && d.ev.id === kept.id);
	checkEq(back.length, 1, "e volta quando ele volta");
}

// ================================================================ p. the backpack verbs (QA NET-1..4)

section("p) os verbos da mochila: validados pelo servidor, aplicados ANTES do comando deles, confirmados pelo nonce");
{
	const WEAPONS = require(join(SRC, "shared/data/weapons.ts")).WEAPONS;
	const { USABLES } = require(join(SRC, "shared/data/usables.ts"));
	const { EQUIPS } = require(join(SRC, "shared/data/equips.ts"));
	const Ply = require(join(SRC, "shared/game/player.ts"));
	const PISTOL = WEAPONS.find(w => w.name === "Pistol").id;
	const AXE = WEAPONS.find(w => w.name === "Axe").id;
	const BANDAGE = USABLES.find(u => u.name === "Bandage").id;
	const CAN = USABLES.find(u => u.name === "Canned food").id;
	const STEEL = EQUIPS.find(e => e.name === "Steel armor").id;
	const world = emptyWorld();
	const sim = new ServerSimulation({
		world,
		clock: new WorldClock({ day: 1, dayTime: 12 }),
		zombies: true,
		interactive: true,
	});
	const save = SAVE.defaultSave();
	save.invenWeapon[PISTOL] = 1;
	save.invenWeapon[AXE] = 1;
	save.ammoNormal = 40;
	save.equipWeapon = 0;
	const p = addPlayer(sim, 0, 3000, 3000, save);
	p.state.godMode = true;
	const seen = [];
	sim.onBackpack = (sp, o) => seen.push(o);
	const verb = (kind, atSeq, arg, nonce) => P.decodeIntentMessage(P.encodeIntentArgs(kind, atSeq, arg, nonce));
	let seq = 0;
	/** one real command through the wire, then the tick that consumes it */
	const tick = (edges = 0, held = 0) => {
		seq += 1;
		const cmd = P.makeCommand(seq, 0, 0, 0, held, edges);
		PL.ingestInput(p, P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [cmd] }), sim.tick);
		sim.step();
	};
	for (let i = 0; i < 5; i++) tick();
	checkEq(p.state.weapon.pointer, 0, "comeca com a adaga");

	// NET-1: the switch is made during command 6, which also presses attack. It arrives BEFORE its command (the
	// reliable channel won the race): the empty tick in between must not apply it early...
	check(sim.queueIntent(0, verb(P.IntentKind.SwitchWeapon, seq + 1, PISTOL, 1)), "o SwitchWeapon entra na fila");
	sim.step();
	checkEq(p.state.weapon.pointer, 0, "um tick sem o comando dele: a troca espera o comando (atSeq)");
	checkEq(sim.backpack.ackOf(p.userId), 0, "e ainda nao foi confirmada");
	// ...and the command's own weapon machine is the PISTOL's: the dagger never swings on that press
	tick(P.packEdges(1, 0, 0, 0), P.HeldBit.Attack);
	checkEq(p.state.weapon.pointer, PISTOL, "no MESMO tick do comando dela a maquina da arma ja e a pistola");
	checkEq(p.save.equipWeapon, PISTOL, "e o save do servidor diz pistola");
	checkEq(p.state.swingerActive, false, "a adaga nao golpeou com o toque desse comando");
	checkEq(p.state.weapon.reloading, true, "a pistola (pente vazio na troca) ja comecou a recarregar");
	checkEq(sim.backpack.ackOf(p.userId), 1, "confirmada pelo nonce 1");
	checkEq(seen.at(-1)?.kind, "switched", "e o resultado foi 'switched'");

	// NET-3: the reload that follows spends the SERVER's reserve
	for (let i = 0; i < 180; i++) tick();
	checkEq(p.state.weapon.ammoCount, WEAPONS[PISTOL].mag, "o pente encheu");
	checkEq(p.save.ammoNormal, 40 - WEAPONS[PISTOL].mag, "tirando da reserva do SERVIDOR");

	// a second switch 1 tick later waits out the 0.1 s cooldown instead of being refused
	seen.length = 0;
	sim.queueIntent(0, verb(P.IntentKind.SwitchWeapon, seq + 1, AXE, 2));
	tick();
	sim.queueIntent(0, verb(P.IntentKind.SwitchWeapon, seq + 1, PISTOL, 3));
	tick();
	checkEq(p.state.weapon.pointer, AXE, "a segunda troca espera o intervalo de 0,1 s");
	for (let i = 0; i < 8; i++) tick();
	checkEq(p.state.weapon.pointer, PISTOL, "e entra depois dele, sem ser recusada");
	checkEq(seen.filter(o => o.kind === "refused").length, 0, "nenhuma recusa");
	checkEq(sim.backpack.ackOf(p.userId), 3, "ack 3");
	// a weapon they do not own: refused, and still acknowledged (the client's prediction is undone)
	sim.queueIntent(0, verb(P.IntentKind.SwitchWeapon, 0, WEAPONS.length - 1, 4));
	// (it waits out the cooldown of the switch before it, like any switch)
	for (let i = 0; i < 8; i++) tick();
	checkEq(p.state.weapon.pointer, PISTOL, "uma arma que ele nao tem: recusada");
	checkEq(seen.at(-1)?.why, "owned", "por 'owned'");
	checkEq(sim.backpack.ackOf(p.userId), 4, "e mesmo assim confirmada");

	// NET-2: eating heals and feeds the SERVER's body, and a double click is two, a cooldown apart
	p.state.godMode = false;
	p.state.hp = 40;
	p.state.hungry = 30;
	const bandages = p.save.invenUse[BANDAGE];
	const cans = p.save.invenUse[CAN];
	sim.queueIntent(0, verb(P.IntentKind.UseItem, 0, BANDAGE, 5));
	sim.queueIntent(0, verb(P.IntentKind.UseItem, 0, CAN, 6));
	tick();
	check(
		p.state.hp >= 40 + USABLES[BANDAGE].hp - 1,
		"a atadura curou o corpo do SERVIDOR",
		`hp ${p.state.hp.toFixed(1)}`,
	);
	checkEq(p.save.invenUse[BANDAGE], bandages - 1, "e saiu uma atadura do save do servidor");
	checkEq(p.save.invenUse[CAN], cans, "a lata espera o intervalo de 0,25 s (nao e recusada)");
	for (let i = 0; i < 16; i++) tick();
	check(p.state.hungry >= 30 + USABLES[CAN].hunger - 2, "a lata alimentou", `fome ${p.state.hungry.toFixed(1)}`);
	checkEq(p.save.invenUse[CAN], cans - 1, "e saiu do save");
	checkEq(sim.backpack.ackOf(p.userId), 6, "as duas confirmadas");
	p.state.godMode = true;

	// NET-4: armour and a skill reach the server's damage and speed on the next command, not at the next report
	p.save.invenEquip[STEEL] = 1;
	p.save.level = 4;
	p.save.skillPoint = 3;
	const speed0 = Ply.recalcMoveSpeed(p.state, p.save);
	sim.queueIntent(0, verb(P.IntentKind.Equip, 0, STEEL, 7));
	sim.queueIntent(0, verb(P.IntentKind.LearnSkill, 0, 7, 8));
	tick();
	checkEq(Ply.playerEquipDefence(p.save), EQUIPS[STEEL].def, "a armadura de aco ja protege no servidor");
	checkEq(p.save.skillLevels[7], 1, "Trot aprendido no servidor");
	checkEq(p.save.skillPoint, 2, "gastando um ponto");
	check(
		Math.abs(Ply.recalcMoveSpeed(p.state, p.save) - (speed0 + EQUIPS[STEEL].speed + 0.3)) < 1e-9,
		"e a velocidade do servidor ja soma a armadura e o Trot",
	);
	sim.queueIntent(0, verb(P.IntentKind.Unequip, 0, 1, 9));
	tick();
	checkEq(p.save.equipCloth, -1, "Unequip do slot 1 (roupa) tira a armadura");
	checkEq(sim.craft.equip(p.save, STEEL).kind, "equipped", "(e ela volta pela mesma regra)");

	// an intent that arrives LATE (its command already ran) lands on the next tick
	sim.queueIntent(0, verb(P.IntentKind.SwitchWeapon, seq - 3, AXE, 10));
	for (let i = 0; i < 8; i++) tick();
	checkEq(p.state.weapon.pointer, AXE, "um atSeq atrasado entra no tick seguinte");
	// one for a command that never comes waits at most INTENT_HOLD_TICKS
	sim.queueIntent(0, verb(P.IntentKind.SwitchWeapon, seq + 20, PISTOL, 11));
	for (let i = 0; i < CFG.INTENT_HOLD_TICKS - 2; i++) sim.step();
	checkEq(p.state.weapon.pointer, AXE, "um atSeq no futuro espera o comando dele...");
	for (let i = 0; i < 4; i++) sim.step();
	checkEq(p.state.weapon.pointer, PISTOL, `...no maximo ${CFG.INTENT_HOLD_TICKS} ticks`);

	// the queue is bounded, and a full queue answers at once
	for (let i = 0; i < CFG.INTENT_QUEUE_MAX; i++)
		sim.queueIntent(0, verb(P.IntentKind.LearnSkill, seq + 30, 0, 20 + i));
	check(!sim.queueIntent(0, verb(P.IntentKind.LearnSkill, seq + 30, 0, 99)), "a fila tem teto");
	checkEq(sim.backpack.ackOf(p.userId), 99, "e o pedido que nao coube e confirmado na hora (recusado)");
	checkEq(seen.at(-1)?.why, "full", "por 'full'");

	// a dead survivor's verbs are dropped (and answered), never held for the revive
	const deadBefore = seen.filter(o => o.kind === "refused" && o.why === "dead").length;
	p.state.dead = true;
	sim.step();
	checkEq(
		seen.filter(o => o.kind === "refused" && o.why === "dead").length - deadBefore,
		CFG.INTENT_QUEUE_MAX,
		"morto: a fila e descartada e cada pedido respondido",
	);
	// ...and the ack never goes BACK: 99 (refused on arrival) is newer than the queued 20..27 answered after it, and a
	// client told 27 now would replay the refused 99 for PENDING_TTL_S (revisao de correcao de 5967a18, C)
	checkEq(sim.backpack.ackOf(p.userId), 99, "o ack so anda para a frente (u16)");
	check(
		seen.slice(-CFG.INTENT_QUEUE_MAX).every(o => o.why === "dead"),
		"tudo recusado por 'dead'",
	);
	checkEq(p.save.skillLevels[0], 0, "nada foi aplicado");
	p.state.dead = false;

	// a pack bought in the shop is delivered into the SERVER's save while the survivor is in the world
	const { SHOP_PACKS } = require(join(SRC, "shared/data/shop.ts"));
	const pack = SHOP_PACKS[0];
	const before = pack.items.map(it => countItem(p.save, it.kind, it.index));
	p.save.packsBought[pack.id] = 1;
	for (let i = 0; i < 40; i++) sim.step();
	checkEq(p.save.packsOpened[pack.id], 1, "o pacote foi aberto pelo servidor");
	check(
		pack.items.every((it, i) => countItem(p.save, it.kind, it.index) === before[i] + it.count),
		"e o que ele traz esta no save do servidor, uma vez",
	);
	for (let i = 0; i < 40; i++) sim.step();
	checkEq(p.save.packsOpened[pack.id], 1, "e nao e aberto de novo");

	// crafting a build through the verb puts it on the cursor, and the weapon is holstered meanwhile
	const recipe = CRAFT_RECIPES.find(
		r =>
			r.craftKind === 1 &&
			PLACEABLES[r.resultIndex] !== undefined &&
			!r.needsDesk &&
			!r.needsPro &&
			r.needsFire !== true,
	);
	for (const ing of recipe.ingredients) addItem(p.save, ing.kind, ing.index, ing.count);
	sim.queueIntent(0, verb(P.IntentKind.SwitchWeapon, 0, AXE, 40));
	for (let i = 0; i < 8; i++) tick();
	sim.queueIntent(0, verb(P.IntentKind.Craft, 0, recipe.id, 41));
	tick();
	checkEq(sim.build.pendingOf(0), recipe.resultIndex, "o Craft de uma construcao a poe no cursor do servidor");
	sim.queueIntent(0, verb(P.IntentKind.SwitchWeapon, 0, PISTOL, 42));
	tick();
	checkEq(seen.at(-1)?.why, "busy", "com uma construcao no cursor, trocar de arma e recusado");
	// the ambient horde is out there: keep it off the ghost, so the placement is about the build, not the dice
	for (const z of sim.horde.zombies) {
		z.x = 200;
		z.y = 200;
	}
	const solids = world.solids.length;
	tick(P.packEdges(1, 0, 0, 0), P.HeldBit.Attack);
	checkEq(world.solids.length, solids + 1, "o toque de ataque coloca a construcao");
	checkEq(p.state.swingerActive, false, "e o machado NAO golpeou com ele (arma no coldre durante a construcao)");
}

section("q) NET-5: um relatorio forjado nao escreve a mochila (pinBackpack)");
{
	const BP = require(join(SRC, "server/sim/backpack.ts"));
	const WEAPONS = require(join(SRC, "shared/data/weapons.ts")).WEAPONS;
	const HMG = WEAPONS.find(w => w.name === "Heavy machine gun").id;
	const trusted = SAVE.defaultSave();
	trusted.ammoNormal = 12;
	trusted.level = 3;
	trusted.skillPoint = 2;
	const forged = SAVE.sanitizeClientReport(
		{
			...JSON.parse(JSON.stringify(trusted)),
			invenWeapon: trusted.invenWeapon.map((v, i) => (i === HMG ? 1 : v)),
			equipWeapon: HMG,
			ammoMachinegun: 99999,
			ammoNormal: 500,
			invenEtc: trusted.invenEtc.map((v, i) => (i === 29 ? 999 : v)),
			invenUse: trusted.invenUse.map(v => v + 50),
			skillLevels: trusted.skillLevels.map((v, i) => (i === 7 ? 1 : v)),
			packsOpened: trusted.packsOpened.map(() => 1),
		},
		trusted,
	);
	check(
		forged.invenWeapon[HMG] === 1 && forged.ammoMachinegun > 0,
		"o relatorio forjado passa pelo sanitize (sao numeros validos)",
	);
	checkEq(BP.pinBackpack(trusted, forged), true, "pinBackpack percebe que ele tentou mexer na mochila");
	for (const f of BP.SERVER_BACKPACK_FIELDS) {
		checkEq(JSON.stringify(forged[f]), JSON.stringify(trusted[f]), `${f} fica o do servidor`);
	}
	const honest = SAVE.sanitizeClientReport(JSON.parse(JSON.stringify(trusted)), trusted);
	checkEq(BP.pinBackpack(trusted, honest), false, "um relatorio honesto nao conta como tentativa");
	checkEq(
		BP.serverOwnsBackpack(),
		CFG.MP_PHASE >= CFG.WORLD_SERVER_PHASE,
		"stripClientBackpack vale a partir de WORLD_SERVER_PHASE (a mesma chave do mundo interativo)",
	);
}

section("r) revisao de 5967a18: o E tem ritmo, porta e luz tem recarga, parede para o item, luz/reparo/hp para todos");
{
	const INTER = require(join(SRC, "server/sim/interaction.ts"));
	const world = emptyWorld();
	const sim = newSim(world);
	const door = W.addSolid(world, {
		kind: "door",
		x: 1000,
		y: 1000,
		w: 128,
		h: 32,
		hp: 200,
		hpMax: 200,
		destructible: true,
		tags: "door",
		rot: 0,
		open: false,
		placeable: 11,
		owner: 0,
	});
	const a = addPlayer(sim, 0, 1064, 980);
	const b = addPlayer(sim, 1, 1064, 1054);
	drain(sim);
	// R3: a modified client puts the action edge on EVERY command for a second
	let flips = 0;
	let last = door.open === true;
	for (let seq = 1; seq <= 60; seq++) {
		send(a, seq, 0, PRESS_E);
		sim.step();
		if ((door.open === true) !== last) {
			flips += 1;
			last = door.open === true;
		}
	}
	const sets = countDeltas(drain(sim), P.WorldEv.DoorSet);
	check(
		flips >= 2 && flips <= 1 / INTER.PRESS_COOLDOWN_S && sets === flips,
		`E em todo comando por 1 s: a porta troca ${flips} vezes (no maximo ${1 / INTER.PRESS_COOLDOWN_S}), um DoorSet por troca`,
		`${sets} DoorSet`,
	);
	// two survivors hammering the same door: the door has its own recharge, whoever presses
	run(sim, 30);
	flips = 0;
	last = door.open === true;
	for (let seq = 61; seq <= 120; seq++) {
		send(a, seq, 0, PRESS_E);
		send(b, seq - 60, 0, PRESS_E);
		sim.step();
		if ((door.open === true) !== last) {
			flips += 1;
			last = door.open === true;
		}
	}
	drain(sim);
	check(
		flips >= 2 && flips <= 1 / INTER.TOGGLE_COOLDOWN_S,
		`dois sobreviventes na mesma porta: ${flips} trocas em 1 s (no maximo ${1 / INTER.TOGGLE_COOLDOWN_S})`,
	);

	// #8: an item on the other side of a wall is out of reach, however close
	const w2 = emptyWorld();
	const sim2 = newSim(w2);
	const p2 = addPlayer(sim2, 0, 2000, 2000);
	W.addSolid(w2, {
		kind: "structure",
		x: 2014,
		y: 1900,
		w: 8,
		h: 200,
		hp: 100,
		hpMax: 100,
		destructible: false,
		tags: "wall",
	});
	const behind = W.spawnGroundItem(w2, 4, 23, 3, 2030, 2000);
	const got = sim2.items.pickup(p2.save, p2.state.x, p2.state.y, behind);
	check(
		!got.ok && got.why === "blocked",
		"um item a 30 u, atras de uma parede, nao entra na mochila",
		JSON.stringify(got),
	);
	const open = W.spawnGroundItem(w2, 4, 23, 3, 1970, 2000);
	checkEq(
		sim2.items.pickup(p2.save, p2.state.x, p2.state.y, open).ok,
		true,
		"e um do lado livre, na mesma distancia, entra",
	);
	// re-review of f8ccaf0: a drop slides with no wall collision and can come to rest INSIDE a wall or a door (~28 % of a
	// zombie's drops at a base wall). Its own wall is no wall between it and the survivor: it is picked up, and E is free
	// for the door beside it again
	W.addSolid(w2, {
		kind: "structure",
		x: 1960,
		y: 2040,
		w: 80,
		h: 20,
		hp: 100,
		hpMax: 100,
		destructible: false,
		tags: "wall",
	});
	const inWall = W.spawnGroundItem(w2, 4, 23, 3, 2000, 2045);
	const gotInWall = sim2.items.pickup(p2.save, p2.state.x, p2.state.y, inWall);
	check(
		gotInWall.ok,
		"um item que parou DENTRO de uma parede, a 45 u, entra na mochila (a propria parede nao o esconde)",
		JSON.stringify(gotInWall),
	);

	// B: a lamp switched, a barricade repaired and a wall chewed by the horde reach EVERYBODY, far or near
	const w3 = emptyWorld();
	const sim3 = newSim(w3);
	const builder = addPlayer(sim3, 0, 3000, 3000);
	addPlayer(sim3, 1, 7000, 7000); // far away: the one who used to miss it
	builder.state.angle = 0;
	sim3.build.hold(0, 4, undefined);
	const lamp = sim3.build.place(0, builder.state, [builder.state], []).solid;
	builder.state.x = lamp.x + lamp.w / 2;
	builder.state.y = lamp.y + lamp.h + 16;
	drain(sim3);
	send(builder, 1, 0, PRESS_E);
	run(sim3, 1);
	// the lamp is electric (DESIGN_RULES ELE-03): its switch is the grid's, and it travels as the lamp's PowerSet --
	// working, level, the switch -- which sets `powered` on every client (client/systems/powerMirror.ts); a fire's
	// switch is still a LightSet. Either way, one delta, to everybody
	const lights = drain(sim3).filter(
		d => d.ev.t === P.WorldEv.LightSet || (d.ev.t === P.WorldEv.PowerSet && d.ev.id === lamp.id),
	);
	check(
		lamp.powered !== undefined && lights.length === 1 && lights[0].slot === CFG.SLOT_NONE,
		"o interruptor de um lampiao (o PowerSet dele, ELE-03) vai para TODO MUNDO (quem estava longe volta e ve a luz certa)",
		JSON.stringify(lights.map(d => [d.ev.t, d.slot])),
	);
	run(sim3, 40);
	builder.state.x = 3000;
	builder.state.y = 3400;
	sim3.build.hold(0, 10, undefined);
	const wall = sim3.build.place(0, builder.state, [builder.state], []).solid;
	wall.hp = wall.hpMax * 0.5;
	addItem(builder.save, 4, 23, 5);
	builder.state.x = wall.x + wall.w / 2;
	builder.state.y = wall.y + wall.h + 16;
	drain(sim3);
	send(builder, 2, 0, PRESS_E);
	run(sim3, 1);
	const repairs = drain(sim3).filter(d => d.ev.t === P.WorldEv.SolidHp && d.slot === CFG.SLOT_NONE);
	check(wall.hp > wall.hpMax * 0.5 && repairs.length >= 1, "o reparo manda o SolidHp para todo mundo");
	// D: a zombie's bite (shared/sim/ai/zombieBrain.ts writes hp and nothing else) is told at SOLID_HP_HZ
	run(sim3, 30);
	drain(sim3);
	wall.hp -= 100;
	run(sim3, Math.ceil(CFG.SIM_HZ / CFG.SOLID_HP_HZ) + 1);
	const bites = drain(sim3).filter(d => d.ev.t === P.WorldEv.SolidHp && d.slot === CFG.SLOT_NONE);
	const told = bites.flatMap(d => d.ev.entries).find(e => e.id === wall.id);
	check(
		told !== undefined && Math.abs(told.hp - wall.hp / wall.hpMax) < 0.01,
		`a mordida numa parede chega a todos em ate 1/${CFG.SOLID_HP_HZ} s (antes a parede parecia inteira ate sumir)`,
		JSON.stringify(told),
	);
	run(sim3, 30);
	checkEq(countDeltas(drain(sim3), P.WorldEv.SolidHp), 0, "e uma parede parada nao manda nada");

	// A: a refused placement is ANSWERED: the edge counts, and the construction stays on the cursor unturned
	const w4 = emptyWorld();
	const sim4 = newSim(w4);
	const mason = addPlayer(sim4, 0, 4000, 4000);
	mason.state.angle = 0;
	sim4.build.hold(0, 10, undefined);
	sim4.build.rotate(0);
	const turned = sim4.build.ghost(0, mason.state);
	// something in the way of the ghost
	W.addSolid(w4, { ...turned, kind: "structure", hp: 1, hpMax: 1, destructible: false, tags: "rock" });
	const turns = sim4.build.turnsOf(0);
	const refused = sim4.build.place(0, mason.state, [mason.state], []);
	const after = sim4.build.ghost(0, mason.state);
	check(
		refused.kind === "refused" &&
			sim4.build.pendingOf(0) === 10 &&
			sim4.build.turnsOf(0) === turns + 1 &&
			turned.w !== turned.h &&
			after.w === PLACEABLES[10].w &&
			after.h === PLACEABLES[10].h,
		"um lugar recusado: continua no cursor, SEM giro (o cliente o redesenha do giro 0), e o bag e empurrado",
		`${JSON.stringify(refused)} turns ${turns} -> ${sim4.build.turnsOf(0)}, ${turned.w}x${turned.h} -> ${after.w}x${after.h}`,
	);

	// #11: the backpack's cooldowns decay whether or not this server owns the interactive world
	const { USABLES } = require(join(SRC, "shared/data/usables.ts"));
	const CAN = USABLES.find(u => u.name === "Canned food").id;
	const simNo = new ServerSimulation({
		world: emptyWorld(),
		clock: new WorldClock({ day: 1, dayTime: 12 }),
		zombies: false,
		interactive: false,
	});
	const eater = addPlayer(simNo, 0, 3000, 3000);
	eater.save.invenUse[CAN] = 3;
	eater.state.hungry = 10;
	checkEq(
		simNo.craft.useItem(0, eater.state, eater.save, CAN).kind,
		"used",
		"sem o mundo interativo, comer funciona",
	);
	for (let i = 0; i < 30; i++) simNo.step();
	checkEq(simNo.craft.cooling(0, "use"), false, "e a recarga de 0,25 s acaba (antes ficava presa para sempre)");

	// R4: a body at 0 hp is dead, even before `stepPlayer` flags it: no bandage revives it
	eater.state.hp = -3;
	checkEq(simNo.craft.useItem(0, eater.state, eater.save, CAN).kind, "refused", "comer com 0 hp e recusado (morto)");
}

section(
	"s) revisao de 5967a18: pacote so num corpo vivo, a fila respondida ao sair, e o relatorio 'velho' nao e tentativa",
);
{
	const BP = require(join(SRC, "server/sim/backpack.ts"));
	const PROG = require(join(SRC, "server/sim/progress.ts"));
	const LIFE = require(join(SRC, "server/sim/life.ts"));
	const { SHOP_PACKS } = require(join(SRC, "shared/data/shop.ts"));
	const world = emptyWorld();
	const sim = newSim(world);
	const p = addPlayer(sim, 0, 3000, 3000);
	const pack = SHOP_PACKS[0];
	// R6: bought on the death screen, it waits for a body: a New game would wipe a dead run's backpack
	p.save.packsBought[pack.id] = 1;
	p.state.dead = true;
	for (let i = 0; i < 90; i++) sim.step();
	checkEq(p.save.packsOpened[pack.id], 0, "morto: o pacote comprado nao e entregue na partida que vai acabar");
	p.state.dead = false;
	p.state.hp = p.state.hpMax;
	for (let i = 0; i < 90; i++) sim.step();
	checkEq(p.save.packsOpened[pack.id], 1, "vivo: entregue");

	// G: a survivor leaving with verbs still queued gets every one answered
	const verb = (kind, atSeq, arg, nonce) => P.decodeIntentMessage(P.encodeIntentArgs(kind, atSeq, arg, nonce));
	for (let i = 0; i < 3; i++) sim.queueIntent(0, verb(P.IntentKind.LearnSkill, 60000, 0, 41 + i));
	sim.remove(0);
	checkEq(sim.backpack.ackOf(p.userId), 43, "sair do mundo responde a fila inteira (o ack do ultimo)");

	// #10: a report that is merely BEHIND is not an attempt; one that claims more is
	const trusted = SAVE.defaultSave();
	trusted.ammoNormal = 12;
	trusted.invenUse[0] = 3;
	trusted.level = 3;
	trusted.exp = 40;
	trusted.runOver = true;
	trusted.runHp = 0;
	const report = edit => {
		const raw = JSON.parse(JSON.stringify(trusted));
		edit(raw);
		return SAVE.sanitizeClientReport(raw, trusted);
	};
	checkEq(
		BP.pinBackpack(
			trusted,
			report(r => ((r.ammoNormal = 10), (r.invenUse[0] = 2))),
		),
		false,
		"mochila atrasada (dois tiros e uma lata a menos): corrigida em silencio, nao conta",
	);
	checkEq(
		BP.pinBackpack(
			trusted,
			report(r => (r.ammoNormal = 13)),
		),
		true,
		"um tiro a MAIS que o servidor: conta",
	);
	checkEq(
		PROG.stripClientProgress(
			trusted,
			report(r => (r.exp = 10)),
		),
		false,
		"XP atrasado: nao conta",
	);
	checkEq(
		PROG.stripClientProgress(
			trusted,
			report(r => (r.exp = 90)),
		),
		true,
		"XP a mais: conta",
	);
	checkEq(
		LIFE.stripClientLife(
			trusted,
			report(r => (r.runHp = 77)),
		),
		false,
		"o hp do corpo que o cliente nunca recebe: nao conta",
	);
	checkEq(
		LIFE.stripClientLife(
			trusted,
			report(r => (r.runOver = false)),
		),
		true,
		"`runOver: false` sobre uma morte: conta",
	);
}

section("t) fortificar: barricada ou porta mirada numa janela ou num vao de predio o preenche (EDI-13)");
{
	// the generated town: its buildings have doorways and windows (shared/game/interiors.ts)
	const world = W.serverWorld(W.generateTown(DESIGN.TOWN_SEED));
	const sim = newSim(world);
	const house = world.solids.find(
		s =>
			s.kind === "building" &&
			(s.openings ?? []).some(o => o.kind === "window") &&
			(s.openings ?? []).some(o => o.kind === "door" && !o.main),
	);
	check(house !== undefined, "a cidade tem predio com janela e porta dos fundos");
	const NORMAL = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
	/**
	 * The CLIENT's ghost (client/systems/build.ts BuildSystem, the drawing the survivor aims with) for a survivor
	 * standing where `fortify` puts one: builds become the server's (ServerBuild.hold / place) while the client keeps
	 * drawing its own ghost, so both must land on the same rect
	 */
	const { BuildSystem } = require(join(SRC, "client/systems/build.ts"));
	const clientGhost = (o, placeable) => {
		const n = NORMAL[o.side];
		const player = {
			x: o.x + o.w / 2 - n[0] * 64,
			y: o.y + o.h / 2 - n[1] * 64,
			angle: Math.atan2(n[1], n[0]),
		};
		const refs = { world, player, players: [], zombies: [], pendingPlace: placeable, save: SAVE.defaultSave() };
		const bs = new BuildSystem();
		bs.handleInput(refs, {});
		bs.update(refs);
		return bs.getGhost();
	};
	const sameRect = (a, b) =>
		a !== undefined && b !== undefined && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
	/** a survivor inside, 64 u in from the opening, aiming at it; then the server's ServerBuild.hold / place */
	const fortify = (o, slot, placeable) => {
		const n = NORMAL[o.side];
		const cx = o.x + o.w / 2 - n[0] * 64;
		const cy = o.y + o.h / 2 - n[1] * 64;
		const p = addPlayer(sim, slot, cx, cy);
		p.state.angle = Math.atan2(n[1], n[0]);
		sim.build.hold(slot, placeable, undefined);
		return { p, out: sim.build.place(slot, p.state, [p.state], []) };
	};
	const win = house.openings.find(o => o.kind === "window");
	/**
	 * A body `radius` wide, 40 u in from the opening, walks straight out through it (60 steps of 4 u) with the one
	 * moveActor the server, the client's prediction and every zombie move by: how far past the opening's middle it
	 * ends, outwards (negative: still inside)
	 */
	const walkOut = (o, radius, inWorld = world) => {
		const n = NORMAL[o.side];
		const mx = o.x + o.w / 2;
		const my = o.y + o.h / 2;
		let x = mx - n[0] * 40;
		let y = my - n[1] * 40;
		for (let i = 0; i < 60; i++) {
			const r = PH.moveActor(inWorld, x, y, radius, n[0] * 4, n[1] * 4);
			x = r.x;
			y = r.y;
		}
		return (x - mx) * n[0] + (y - my) * n[1];
	};
	const openBefore = walkOut(win, PH.PLAYER_RADIUS);
	check(
		openBefore > 60,
		"antes: um sobrevivente sai pela janela (pulando, EDI-10)",
		`${openBefore.toFixed(0)} u para fora`,
	);
	const a = fortify(win, 0, 10);
	checkEq(a.out.kind, "placed", "a barricada mirada na janela entra");
	const s = a.out.solid;
	check(
		s !== undefined && s.x === win.x && s.y === win.y && s.w === win.w && s.h === win.h,
		"e preenche exatamente o vao da janela, na grossura da parede",
		s !== undefined ? `${s.x},${s.y} ${s.w}x${s.h} vs ${win.x},${win.y} ${win.w}x${win.h}` : "nada",
	);
	check(
		s !== undefined && s.destructible === true && s.hp > 0 && s.kind === "barricade",
		"com os pontos de vida dela: a horda derruba (o flow field a ve como SOFT, zombieBrain bate nela)",
		s !== undefined ? `${s.kind} hp ${s.hp}` : "nada",
	);
	check(s !== undefined && W.isBlocking(s), "e bloqueia o corpo: ninguem pula a janela barricada");
	// placed by the SERVER's build path (ServerBuild.hold / place, the same snapToOpening as the client's ghost): the
	// server's own movement stops at it, a survivor's and a zombie's alike
	const survivorAfter = walkOut(win, PH.PLAYER_RADIUS);
	const zombieAfter = walkOut(win, PH.ZOMBIE_RADIUS);
	check(
		survivorAfter < 0 && zombieAfter < 0,
		"depois: o movimento do servidor para na barricada -- nem sobrevivente nem zumbi atravessa",
		`sobrevivente ${survivorAfter.toFixed(0)} u, zumbi ${zombieAfter.toFixed(0)} u`,
	);
	// the building's entrances, the main one first (world.ts entrancesOf, the API the facade signs read)
	const entrances = W.entrancesOf(house, []);
	check(
		entrances.length >= 2 && entrances[0].main && entrances.slice(1).every(o => !o.main && o.kind === "door"),
		"entrancesOf: a entrada principal primeiro, depois as outras portas",
		`${entrances.length} entradas`,
	);
	const back = entrances[1];
	const b = fortify(back, 1, 11);
	checkEq(b.out.kind, "placed", "uma porta construida no vao dos fundos entra");
	const d = b.out.solid;
	check(
		d !== undefined && d.x === back.x && d.y === back.y && d.w === back.w && d.h === back.h && d.open === false,
		"e preenche o vao, fechada (abre com E, como toda porta construida)",
		d !== undefined ? `${d.x},${d.y} ${d.w}x${d.h} open ${d.open}` : "nada",
	);
	// the same opening twice: the second one lands on the first and is refused
	const cg = clientGhost(win, 10);
	check(
		sameRect(cg, s),
		"o fantasma do cliente cai no mesmo retangulo que o servidor colocou (a mesma snapToOpening dos dois lados)",
		cg ? `${cg.x},${cg.y} ${cg.w}x${cg.h}` : "nada",
	);
	const c = fortify(win, 2, 12);
	checkEq(c.out.kind, "refused", "uma segunda barricada na mesma janela e recusada (o vao ja esta tomado)");
	// an interior opening is not fortified (review of ea5cf71): an open-plan side can be 300 u wide, and one barricade
	// would seal it. A ghost aimed at one, with no door or window near, keeps the grid rect
	const fortifiable = o => o.kind === "door" || o.kind === "window";
	let inner;
	let innerHouse;
	for (const b of world.solids) {
		if (b.kind !== "building" || inner !== undefined) continue;
		for (const o of b.openings ?? []) {
			if (o.kind !== "inner") continue;
			const cx = o.x + o.w / 2;
			const cy = o.y + o.h / 2;
			const clear = world.solids.every(
				q =>
					q.kind !== "building" ||
					(q.openings ?? []).every(
						e =>
							!fortifiable(e) ||
							Math.max(Math.abs(e.x + e.w / 2 - cx), Math.abs(e.y + e.h / 2 - cy)) > 240,
					),
			);
			if (clear) {
				inner = o;
				innerHouse = b;
				break;
			}
		}
	}
	check(inner !== undefined, "a cidade tem um vao interno longe de portas e janelas", innerHouse?.id);
	if (inner !== undefined) {
		const n = NORMAL[inner.side];
		const q = addPlayer(sim, 4, inner.x + inner.w / 2 - n[0] * 64, inner.y + inner.h / 2 - n[1] * 64);
		q.state.angle = Math.atan2(n[1], n[0]);
		sim.build.hold(4, 10, undefined);
		const gi = sim.build.ghost(4, q.state);
		const cgi = clientGhost(inner, 10);
		check(
			sameRect(cgi, gi),
			"e o fantasma do cliente fica na mesma celula da grade que o do servidor",
			cgi ? `${cgi.w}x${cgi.h}` : "nada",
		);
		check(
			gi !== undefined && !(gi.x === inner.x && gi.y === inner.y && gi.w === inner.w && gi.h === inner.h),
			"uma barricada mirada num vao interno fica na grade (so portas e janelas se preenchem)",
			gi ? `${gi.x},${gi.y} ${gi.w}x${gi.h} vs vao ${inner.w}x${inner.h}` : "-",
		);
	}
	// away from any opening, the grid as before
	const field = addPlayer(sim, 3, 60, 60);
	field.state.angle = 0;
	sim.build.hold(3, 10, undefined);
	const g = sim.build.ghost(3, field.state);
	check(
		g !== undefined && g.w === 128 && g.h === 32,
		"longe de qualquer vao, a grade de sempre",
		g ? `${g.w}x${g.h}` : "-",
	);

	// ---- the whole F3 path as it runs now (WORLD_SERVER_PHASE, docs/MULTIPLAYER.md §11.3): a craft puts the barricade
	// on the SERVER's cursor, the click rides an input command through the real wire, the server places it from its own
	// position and aim, the SolidAdd crosses the wire, and a client's mirror of the same town (client/net/worldMirror.ts)
	// rebuilds it -- in the window, not as the grid-sized plank the row describes
	check(
		CFG.MP_PHASE >= CFG.WORLD_SERVER_PHASE,
		"nesta fase o servidor e dono das construcoes",
		`MP_PHASE ${CFG.MP_PHASE}, WORLD_SERVER_PHASE ${CFG.WORLD_SERVER_PHASE}`,
	);
	const { applyMirrorEvent, isMirrorEvent } = require(join(SRC, "client/net/worldMirror.ts"));
	const { fortifies } = require(join(SRC, "shared/sim/placement.ts"));
	const serverTown = W.serverWorld(W.generateTown(DESIGN.TOWN_SEED));
	// no `interactive` flag: the simulation owns the world by the phase, as the live server does
	const live = new ServerSimulation({
		world: serverTown,
		clock: new WorldClock({ day: 1, dayTime: 12 }),
		zombies: false,
	});
	const recipe = CRAFT_RECIPES.find(
		r => r.craftKind === 1 && PLACEABLES[r.resultIndex] && fortifies(PLACEABLES[r.resultIndex]),
	);
	check(recipe !== undefined, "existe uma receita de barricada nos dados");
	const n = NORMAL[win.side];
	const aim = Math.atan2(n[1], n[0]);
	const builder = addPlayer(live, 0, win.x + win.w / 2 - n[0] * 64, win.y + win.h / 2 - n[1] * 64);
	builder.state.angle = aim;
	// on the cursor the way a craft puts it there (server/sim/craft.ts hands a placeable to ServerBuild.hold; the craft
	// itself wants a work desk near, which is not what this is about)
	live.build.hold(0, recipe.resultIndex, recipe.id);
	check(live.build.placing(0), "a barricada esta no cursor do SERVIDOR");
	drain(live);
	send(builder, 1, aim, P.packEdges(1, 0, 0, 0));
	run(live, 1);
	const placed = live.world.solids.find(q => q.owner === 0 && q.placeable === recipe.resultIndex);
	check(
		sameRect(placed, win),
		"o clique chega pelo fio e o SERVIDOR a poe exatamente no vao da janela",
		placed ? `${placed.x},${placed.y} ${placed.w}x${placed.h} vs ${win.w}x${win.h}` : "nada",
	);
	const events = drain(live).map(d => d.ev);
	const encoded = P.encodeWorld({ tick: 1, events });
	const clientTown = W.generateTown(DESIGN.TOWN_SEED);
	for (const packet of encoded.packets) {
		for (const e of P.decodeWorld(packet)?.events ?? []) if (isMirrorEvent(e)) applyMirrorEvent(clientTown, e);
	}
	const mirrored = placed !== undefined ? clientTown.solids.find(q => q.id === placed.id) : undefined;
	check(
		sameRect(mirrored, win),
		"e o espelho do cliente, com o SolidAdd do fio, a reconstroi no mesmo vao (nao na tabua de 128 u da grade)",
		mirrored ? `${mirrored.x},${mirrored.y} ${mirrored.w}x${mirrored.h}` : "nada",
	);
	const clientOut = walkOut(win, PH.PLAYER_RADIUS, clientTown);
	check(
		clientOut < 0,
		"e a predicao do cliente tambem para nela: cliente e servidor colidem com a mesma barricada",
		`${clientOut.toFixed(0)} u`,
	);
}

section("u) a cidade gerada em fatias e a mesma: o servidor cede entre dois predios num reset (MP-22)");
{
	// server/net/mpHost.ts generates a world reset's town a slice per frame through `pace`; the town must not know
	let calls = 0;
	const sliced = W.generateTown(DESIGN.TOWN_SEED, () => {
		calls += 1;
	});
	const whole = W.generateTown(DESIGN.TOWN_SEED);
	const buildings = whole.solids.filter(s => s.kind === "building").length;
	checkEq(calls, buildings, "pace e chamado uma vez por predio, depois do interior dele");
	const key = w => w.solids.map(s => `${s.kind}:${s.x}:${s.y}:${s.w}:${s.h}:${s.parentId}`).join("|");
	check(key(sliced) === key(whole), "e a cidade e a mesma, solido por solido", `${sliced.solids.length} solidos`);
	checkEq(mapHashOf(sliced), mapHashOf(whole), "o mesmo mapHash (o que o cliente confere ao entrar)");
}

section("v) o objetivo 'Search a house' aponta para onde a busca responde (EDI-03, review of ea5cf71)");
{
	// the onboarding's arrow (client/onboarding/objectives.ts) must lead to a loot spot -- the search only answers
	// within arm's reach of one (interactQuery.ts nearLootSpot) -- not to the middle of the house or its door
	const IQ = require(join(SRC, "shared/sim/interactQuery.ts"));
	const { OBJECTIVES, newMemory } = require(join(SRC, "client/onboarding/objectives.ts"));
	const world = W.serverWorld(W.generateTown(DESIGN.TOWN_SEED));
	const house = world.solids.find(s => s.kind === "building" && s.tags === "house" && (s.lootSpots ?? []).length > 0);
	house.lootItems = [{ kind: 0, id: 1, count: 1 }];
	const loot = OBJECTIVES.find(o => o.id === "loot");
	const refs = { world, player: { x: house.doorX, y: house.doorY } };
	const t = loot.target(refs, newMemory());
	check(
		t !== undefined && house.lootSpots.some(q => q.x === t.x && q.y === t.y),
		"da porta, a seta aponta para um ponto de busca da casa",
		t ? `${t.x.toFixed(0)},${t.y.toFixed(0)}` : "nada",
	);
	check(
		t !== undefined && IQ.buildingToSearch(world, t.x, t.y) === house,
		"e ali a busca responde (dentro da casa, ao alcance do movel)",
	);
	check(!/door-side/.test(loot.hint), "o texto nao manda mais usar o prompt da porta", loot.hint);
	// WORLD_SERVER_PHASE: the client knows only what the flag of the building it stands in says (worldMirror's
	// resetMirror empties every other). Any house may still hold loot, so the arrow still leads to a loot spot; and the
	// house the survivor stands in with no flag is known empty, so the arrow leaves it for the next one
	const mirror = W.generateTown(DESIGN.TOWN_SEED);
	for (const b of mirror.solids) if (b.kind === "building") b.lootItems = [];
	const spotOf = (w, x, y) =>
		w.solids.find(b => b.kind === "building" && (b.lootSpots ?? []).some(q => q.x === x && q.y === y));
	const same = mirror.solids.find(b => b.id === house.id);
	const u = loot.target({ world: mirror, player: { x: same.doorX, y: same.doorY } }, newMemory());
	check(
		u !== undefined && spotOf(mirror, u.x, u.y) !== undefined,
		"sem saber o loot de nenhuma casa (o servidor so conta a de dentro), a seta ainda leva a um ponto de busca",
		u ? `${u.x.toFixed(0)},${u.y.toFixed(0)}` : "nada",
	);
	const at = same.lootSpots[0];
	const w2 = loot.target({ world: mirror, player: { x: at.x, y: at.y } }, newMemory());
	const next = w2 !== undefined ? spotOf(mirror, w2.x, w2.y) : undefined;
	check(
		next !== undefined && next !== same,
		"e dentro de uma casa sem o sinal de loot (vazia), a seta aponta para a proxima",
		next ? `${next.tags} #${next.id}` : "nada",
	);
}

// ================================================================ w. the ground is not a warehouse

section("w) itens no chao apodrecem, tem teto e sao achados pela grade (revisao de seguranca de 5967a18, #3)");
{
	const IQ = require(join(SRC, "shared/sim/interactQuery.ts"));
	const LIFE = CFG.GROUND_ITEM_LIFE_S;
	const CAP = CFG.GROUND_ITEM_CAP;

	// 1. the lifetime, through the simulation's own tick
	{
		const world = emptyWorld();
		const sim = newSim(world);
		addPlayer(sim, 0, 1000, 1000);
		const old = W.spawnGroundItem(world, 4, 23, 1, 1100, 1000);
		const young = W.spawnGroundItem(world, 4, 23, 1, 1120, 1000);
		drain(sim);
		// the oldest was dropped a whole lifetime ago; the other a minute ago
		old.born -= LIFE;
		young.born -= 60;
		run(sim, 1);
		check(!world.items.includes(old), `um item com mais de ${LIFE} s apodrece no tick do servidor`);
		check(world.items.includes(young), "e um de um minuto continua no chao");
		const removes = drain(sim).filter(d => d.ev.t === P.WorldEv.ItemRemove);
		check(
			removes.length === 1 && removes[0].ev.id === old.id && removes[0].slot === 0,
			"e quem o via recebe o ItemRemove (nenhum fantasma)",
			`${removes.length} ItemRemove`,
		);
		checkEq(sim.items.expired.rotted, 1, "contado como apodrecido");
	}

	// 2. the cap, and 10 000 items from a farm: the oldest go first, and every client hears it
	{
		const world = emptyWorld();
		const sim = newSim(world);
		const farmer = addPlayer(sim, 0, 4000, 4000);
		drain(sim);
		const made = [];
		for (let i = 0; i < 10000; i++) {
			made.push(W.spawnGroundItem(world, 4, 23, 1, 3900 + (i % 200), 3900 + Math.floor(i / 200) * 4));
		}
		checkEq(world.items.size(), CAP, `10 000 itens de uma fazenda: o mundo guarda ${CAP}`);
		check(
			world.items[0] === made[10000 - CAP] && world.items[CAP - 1] === made[9999],
			"os mais antigos sairam primeiro (ficam os ultimos que cairam)",
		);
		checkEq(sim.items.expired.capped, 10000 - CAP, "e o teto conta os que tirou");
		const out = drain(sim);
		const adds = out.filter(d => d.ev.t === P.WorldEv.ItemAdd && d.slot === farmer.slot).length;
		const removes = out.filter(d => d.ev.t === P.WorldEv.ItemRemove && d.slot === farmer.slot).length;
		checkEq(adds - removes, CAP, "o espelho do cliente termina com exatamente os que existem (adds - removes)");
		// the grid holds what the world holds, and nothing more
		const g = world.itemGrid;
		let filed = 0;
		for (const [, list] of g.cells) filed += list.length;
		checkEq(filed, CAP, "e a grade tem os mesmos itens, nenhum a mais");
		checkEq(g.at.size(), CAP, "cada um arquivado uma vez");
	}

	// 3. the sweep reads what is NEAR: 10 000 items spread over the town, six survivors
	{
		const time = (n, reps) => {
			const world = emptyWorld();
			const sim = newSim(world);
			for (let s = 0; s < 6; s++) addPlayer(sim, s, 800 + s * 1300, 800 + ((s * 2900) % 6400));
			let seed = 7;
			const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
			for (let i = 0; i < n; i++) W.spawnGroundItem(world, 4, 23, 1, rnd() * 8000, rnd() * 8000);
			sim.items.sweepInterest(1); // the first sweep tells everybody what is near them
			drain(sim);
			const t0 = process.hrtime.bigint();
			for (let k = 0; k < reps; k++) sim.items.sweepInterest(1);
			const ms = Number(process.hrtime.bigint() - t0) / 1e6 / reps;
			return { ms, held: world.items.size() };
		};
		time(2000, 50); // warm the JIT
		const small = time(100, 400);
		const big = time(10000, 400);
		console.log(
			`        uma varredura de interesse (6 sobreviventes): ${small.ms.toFixed(3)} ms com ${small.held} itens, ` +
				`${big.ms.toFixed(3)} ms depois de 10 000 (o mundo guarda ${big.held})`,
		);
		checkEq(big.held, CAP, "10 000 itens espalhados: o teto vale");
		check(
			big.ms < small.ms * 30,
			"e a varredura cresce com o que esta perto, nao com a cidade (<30x a de 100 itens; o laco antigo: ~100x)",
			`${(big.ms / small.ms).toFixed(1)}x`,
		);
	}

	// 4. the grid answers what the scan answered: a moving item is re-filed, every E press finds the same item
	{
		const world = emptyWorld();
		const sim = newSim(world);
		addPlayer(sim, 0, 2000, 2000);
		const flying = W.spawnGroundItem(world, 4, 23, 1, 2040, 2000, 900, 0);
		for (let i = 0; i < 90; i++) W.updateGroundItems(world, 1 / 60);
		check(
			flying.x > W.ITEM_GRID_CELL * 8 + 60,
			"o item deslizou para outra celula da grade",
			`x ${flying.x.toFixed(0)}`,
		);
		checkEq(IQ.nearestGroundItem(world, flying.x + 5, flying.y), flying, "e o E o acha onde ele parou");
		let seed = 3;
		const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
		for (let i = 0; i < 400; i++) W.spawnGroundItem(world, 4, 23, 1, 1500 + rnd() * 1000, 1500 + rnd() * 1000);
		let same = 0;
		for (let k = 0; k < 500; k++) {
			const x = 1500 + rnd() * 1000;
			const y = 1500 + rnd() * 1000;
			let best;
			let bestD2 = DESIGN.ITEM_GET_DISTANCE * DESIGN.ITEM_GET_DISTANCE;
			for (const it of world.items) {
				const d2 = (it.x - x) ** 2 + (it.y - y) ** 2;
				if (d2 < bestD2 || (d2 === bestD2 && best !== undefined && it.id < best.id)) {
					bestD2 = d2;
					best = it;
				}
			}
			if (IQ.nearestGroundItem(world, x, y) === best) same += 1;
		}
		checkEq(same, 500, "500 pressoes de E: a grade escolhe o mesmo item que a lista inteira");
	}

	// 5. the population's cleanup tells the clients (it used to splice the list: a ghost on every screen)
	{
		const world = emptyWorld();
		const sim = new ServerSimulation({
			world,
			clock: new WorldClock({ day: 1, dayTime: 12 }),
			zombies: true,
			interactive: true,
		});
		const p = addPlayer(sim, 0, 3000, 3000);
		const item = W.spawnGroundItem(world, 4, 23, 1, 3100, 3000);
		check(
			drain(sim).some(d => d.ev.t === P.WorldEv.ItemAdd && d.ev.id === item.id && d.slot === 0),
			"o cliente foi avisado do item",
		);
		// now 1850 u away on one axis: past the population's square (ITEM_SPAWN_MAX, 1800) but inside the item
		// interest's exit (ITEM_INTEREST_EXIT, 2100): the sweep keeps it on the screen, only the cleanup takes it away
		p.state.x = 3100 - 1850;
		run(sim, 2);
		check(!world.items.includes(item), "a limpeza da populacao tira o item longe de todos (1800 u no eixo)");
		check(
			drain(sim).some(d => d.ev.t === P.WorldEv.ItemRemove && d.ev.id === item.id && d.slot === 0),
			"e o cliente que o via recebe o ItemRemove (antes: fantasma para sempre)",
		);
	}
}

// ================================================================ w2. the cap makes room where the junk is

section("w2) o teto de itens tira o mais velho em volta do item novo, nao o mais velho da cidade (revisao, L4)");
{
	/*
	 * A farm of junk in one corner used to push a fresh drop out of the other: past GROUND_ITEM_CAP the town's oldest
	 * went, and 900 items of old litter were only a head start. Now the item that makes room is the oldest around the
	 * new one (its grid cell and the ones next to it); only with nothing there does the town's oldest go.
	 */
	const world = emptyWorld();
	const sim = newSim(world);
	const items = sim.items;
	for (let i = 0; i < 900; i++) {
		W.spawnGroundItem(world, 4, 1, 1, 1000 + (i % 30) * 20, 1000 + Math.floor(i / 30) * 20, 0, 0);
		items.upkeep(0.1);
	}
	const trophy = W.spawnGroundItem(world, 1, 99, 1, 6000, 6000, 0, 0);
	let t = 0;
	for (; t < 300 && world.items.includes(trophy); t++) {
		for (let k = 0; k < 6; k++) W.spawnGroundItem(world, 4, 1, 1, 7000, 1000, 0, 0);
		items.upkeep(1);
	}
	check(
		world.items.includes(trophy),
		`uma fazenda de 6 itens/s por ${t} s longe dele nao tira um drop novo`,
		`t=${t}`,
	);
	checkEq(world.items.length, CFG.GROUND_ITEM_CAP, "e a cidade continua no teto");
	check(
		world.items.filter(i => i.x < 2000 && i.y < 2000).length === 900,
		"o lixo velho de outro canto tambem fica (a fazenda come o proprio lixo)",
	);
	// (NIT) a position that is not a number files in cell 0 instead of a NaN key (Luau refuses a NaN table key)
	const bad = W.spawnGroundItem(world, 4, 1, 1, NaN, Infinity, 0, 0);
	checkEq(world.itemGrid.at.get(bad), 0, "um item em (NaN, inf) vai para a celula 0, nunca uma chave NaN");
	W.removeGroundItem(world, bad);
}

// ================================================================ x. whose construction, for how long, and nobody penned in

section("x) construcoes: teto por UserId, obra abandonada apodrece, e nenhuma prende um sobrevivente (MP-24)");
{
	const ENC = require(join(SRC, "server/sim/enclosure.ts"));
	const GRACE = CFG.BUILD_ABANDON_GRACE_S;
	const DECAY = CFG.BUILD_ABANDON_DECAY_S;
	/** a survivor with an explicit UserId (addPlayer derives it from the slot) */
	const join2 = (sim, slot, userId, x, y) => {
		const sp = PL.createServerPlayer(
			{ slot, userId, name: `u${userId}` },
			SAVE.defaultSave(),
			x,
			y,
			sim.tick,
			sim.simHz,
		);
		sim.add(sp);
		sp.state.x = x;
		sp.state.y = y;
		return sp;
	};
	const wall = (world, x, y, owner) =>
		W.addSolid(world, {
			kind: "barricade",
			x,
			y,
			w: 64,
			h: 64,
			hp: 700,
			hpMax: 700,
			destructible: true,
			tags: "barricade",
			placeable: 10,
			owner,
		});

	// 1. the cap belongs to the account: leaving and coming back in another slot does not reset it
	{
		const world = emptyWorld();
		const sim = newSim(world);
		const a = join2(sim, 0, 7001, 4000, 4000);
		for (let i = 0; i < CFG.MAX_BUILDS_PER_PLAYER; i++)
			wall(world, 10 + (i % 50) * 130, 10 + Math.floor(i / 50) * 130, 0);
		checkEq(sim.build.countOfUser(7001), CFG.MAX_BUILDS_PER_PLAYER, "o jogador 7001 ergueu o teto inteiro");
		sim.remove(a.slot);
		checkEq(sim.build.countOf(0), 0, "ele saiu: o slot 0 volta limpo para quem chegar");
		const back = join2(sim, 2, 7001, 4000, 4000);
		checkEq(sim.build.countOf(2), CFG.MAX_BUILDS_PER_PLAYER, "e de volta, noutro slot, o teto e o dele de novo");
		sim.build.hold(2, 10, undefined);
		const refused = sim.build.place(2, back.state, [back.state], []);
		checkEq(refused.why, "capPlayer", "sair e voltar nao zera o teto por jogador");
		const other = join2(sim, 0, 7002, 5000, 5050);
		sim.build.hold(0, 10, undefined);
		checkEq(sim.build.place(0, other.state, [other.state], []).kind, "placed", "e outra conta no slot 0 constroi");
		check(
			world.solids.filter(s => s.placeable !== undefined && s.builder === 7001 && s.owner === 2).length ===
				CFG.MAX_BUILDS_PER_PLAYER,
			"as obras dele voltam a ter o slot dele (a torreta credita quem a fez)",
		);
	}

	// 2. an abandoned construction rots: the builder's absence past the grace, then the decay
	{
		const world = emptyWorld();
		const sim = newSim(world);
		const a = join2(sim, 0, 7101, 3000, 3000);
		const walls = [];
		for (let i = 0; i < 4; i++) walls.push(wall(world, 3200 + i * 100, 3000, 0));
		sim.remove(a.slot);
		drain(sim);
		sim.build.step(GRACE - 1);
		check(
			walls.every(w => w.hp === w.hpMax && world.solids.includes(w)),
			`${GRACE - 1} s depois de o construtor sair, a base continua inteira`,
		);
		sim.build.step(2);
		check(
			walls.every(w => w.hp < w.hpMax),
			"passado o prazo, ela comeca a apodrecer",
		);
		// the builder comes back: the rot stops where it was (the hp lost stays; E: Repair fixes it)
		const back = join2(sim, 1, 7101, 3000, 3000);
		const hp = walls[0].hp;
		sim.build.step(30);
		checkEq(walls[0].hp, hp, "o construtor voltou: a obra para de apodrecer");
		sim.remove(back.slot);
		sim.build.step(GRACE + DECAY + 1);
		check(
			walls.every(w => !world.solids.includes(w)),
			`abandonada ${GRACE} s + ${DECAY} s, cai (e devolve as vagas dos tetos)`,
		);
		checkEq(sim.build.count(), 0, "o teto do servidor esta livre de novo");
		checkEq(sim.build.countOfUser(7101), 0, "e o do construtor tambem");
		checkEq(countDeltas(drain(sim), P.WorldEv.SolidRemove), 4, "e todo cliente recebe o SolidRemove");
	}

	// 3. whoever keeps it standing keeps it: a repair of a rotting construction adopts it
	{
		const world = emptyWorld();
		const sim = newSim(world);
		const gone = join2(sim, 0, 7201, 2000, 2000);
		const w = wall(world, 2000, 2080, 0);
		sim.remove(gone.slot);
		sim.build.step(GRACE + 30);
		check(w.hp < w.hpMax, "a obra de quem saiu esta apodrecendo");
		const keeper = join2(sim, 1, 7202, 2032, 2050);
		addItem(keeper.save, 4, 23, 5); // wood: what a barricade is repaired with
		send(keeper, 1, Math.PI / 2, PRESS_E);
		run(sim, 1);
		checkEq(w.builder, 7202, "quem a conserta passa a ser o dono (MP-24)");
		checkEq(sim.build.countOfUser(7202), 1, "e ela conta no teto dele");
		const after = w.hp;
		sim.build.step(DECAY);
		checkEq(w.hp, after, "e com o novo dono no mundo ela nao apodrece mais");
	}

	// 4. nobody is penned in: the piece that would close a ring around a survivor is refused
	{
		const ring = world => {
			// a closed box 1880..2280 x 1780..2088, with one 128 u gap in its top wall at x 2048..2176
			for (const [x, y, w, h] of [
				[1880, 1780, 40, 308],
				[2176, 1780, 104, 308],
				[1880, 2048, 400, 40],
				[1880, 1792, 168, 32],
			]) {
				W.addSolid(world, { kind: "wall_h", x, y, w, h, hp: 999, hpMax: 999, destructible: false, tags: "" });
			}
		};
		const setup = (victimAt, builderAt) => {
			const world = emptyWorld();
			ring(world);
			const sim = newSim(world);
			const builder = join2(sim, 0, 7301, builderAt[0], builderAt[1]);
			builder.state.angle = builderAt[2];
			const victim = victimAt !== undefined ? join2(sim, 1, 7302, victimAt[0], victimAt[1]) : undefined;
			return { world, sim, builder, victim, bodies: sim.players().map(sp => sp.state) };
		};
		const OUTSIDE = [2112, 1740, Math.PI / 2];
		const INSIDE_V = [2048, 1936];

		let t = setup(INSIDE_V, OUTSIDE);
		check(ENC.canEscape(t.world, INSIDE_V[0], INSIDE_V[1]), "com a fresta aberta, quem esta dentro pode sair");
		t.sim.build.hold(0, 10, undefined);
		const shut = t.sim.build.place(0, t.builder.state, t.bodies, []);
		checkEq(shut.why, "sealed", "a barricada que fecharia o anel com alguem dentro e recusada");
		checkEq(t.sim.build.placing(0), true, "e continua no cursor");
		checkEq(
			t.sim.build.place(0, t.builder.state, t.bodies, []).why,
			"rate",
			"e a tentativa seguinte espera o ritmo",
		);

		t = setup(INSIDE_V, OUTSIDE);
		t.sim.build.hold(0, 11, undefined);
		checkEq(
			t.sim.build.place(0, t.builder.state, t.bodies, []).kind,
			"placed",
			"uma PORTA no mesmo vao: e base, nao cela",
		);

		t = setup(undefined, OUTSIDE);
		t.sim.build.hold(0, 10, undefined);
		checkEq(
			t.sim.build.place(0, t.builder.state, t.bodies, []).kind,
			"placed",
			"o mesmo anel sem ninguem dentro fecha",
		);

		t = setup(undefined, [2112, 1900, -Math.PI / 2]);
		t.sim.build.hold(0, 10, undefined);
		checkEq(
			t.sim.build.place(0, t.builder.state, t.bodies, []).why,
			"sealed",
			"e o construtor nao se tranca sem porta (nao ha como derrubar a propria parede)",
		);

		// a survivor penned in already (by the map) does not stop a piece that changes nothing for them: the gap is
		// walled up, and the builder puts a barricade against the outside of the box
		t = setup(INSIDE_V, [2368, 1740, Math.PI / 2]);
		W.addSolid(t.world, {
			kind: "wall_h",
			x: 2048,
			y: 1780,
			w: 128,
			h: 44,
			hp: 9,
			hpMax: 9,
			destructible: false,
			tags: "",
		});
		check(!ENC.canEscape(t.world, INSIDE_V[0], INSIDE_V[1]), "(o sobrevivente la dentro ja esta preso pelo mapa)");
		t.sim.build.hold(0, 10, undefined);
		checkEq(
			t.sim.build.place(0, t.builder.state, t.bodies, []).kind,
			"placed",
			"quem ja estava preso pelo mapa nao impede uma peca que nao muda nada para ele",
		);

		// 5. (revisao de seguranca do endurecimento da rede, M1) o corpo guardado de quem esperava no lobby: a regra so
		// ve os corpos NO mundo, entao o anel fecha em volta do lugar dele -- e na volta ele e posto onde pode sair
		{
			const { LifeKeeper } = require(join(SRC, "server/sim/life.ts"));
			t = setup(undefined, OUTSIDE);
			const lives = new LifeKeeper(t.sim, { welcome() {}, left() {}, life() {} });
			const info = { userId: 7303, name: "waiter" };
			const save = SAVE.defaultSave();
			const waiter = lives.enter(info, save);
			waiter.state.x = INSIDE_V[0];
			waiter.state.y = INSIDE_V[1];
			lives.leave(info.userId);
			t.sim.build.hold(0, 10, undefined);
			const closed = t.sim.build.place(
				0,
				t.builder.state,
				t.sim.players().map(sp => sp.state),
				[],
			);
			checkEq(closed.kind, "placed", "com ele no lobby o anel fecha (o corpo guardado nao esta no mundo)");
			check(!ENC.canEscape(t.world, INSIDE_V[0], INSIDE_V[1]), "(o lugar onde o corpo dele ficou virou cela)");
			const back = lives.enter(info, save);
			check(
				back !== undefined && ENC.canEscape(t.world, back.state.x, back.state.y),
				"na volta ele e posto onde consegue sair (placeKept: chao livre E saida), nao dentro da cela",
				back === undefined ? "nao entrou" : `(${back.state.x.toFixed(0)}, ${back.state.y.toFixed(0)})`,
			);
		}

		// 6. (M2) o passeio custa: no maximo SEALED_CHECKS_PER_TICK por tick no servidor inteiro; os outros ouvem "rate"
		{
			const BUILD = require(join(SRC, "server/sim/build.ts"));
			const budget = 1;
			checkEq(BUILD.SEALED_CHECKS_PER_TICK, budget, "(o orcamento do servidor: um passeio por tick)");
			t = setup(INSIDE_V, OUTSIDE);
			const walk = ENC.boxesIn;
			let walks = 0;
			ENC.boxesIn = (...a) => {
				walks += 1;
				return walk(...a);
			};
			try {
				const answers = [];
				for (let slot = 0; slot < 12; slot++) {
					t.sim.build.hold(slot, 10, undefined);
					answers.push(t.sim.build.place(slot, t.builder.state, t.bodies, []).why);
				}
				console.log(`        12 tentativas no mesmo tick: ${walks} passeio(s); respostas ${answers.join(",")}`);
				check(
					walks <= budget,
					`12 tentativas no mesmo tick custam no maximo ${budget} passeio (custaram ${walks})`,
				);
				checkEq(answers.filter(a => a === "rate").length, 12 - walks, "e as outras ouvem 'rate'");
				t.sim.build.step(1 / 60);
				walks = 0;
				checkEq(
					t.sim.build.place(5, t.builder.state, t.bodies, []).why,
					"sealed",
					"no tick seguinte, a proxima e checada",
				);
				checkEq(walks, 1, "(com um passeio)");
				t.sim.build.hold(11, 11, undefined);
				walks = 0;
				checkEq(
					t.sim.build.place(11, t.builder.state, t.bodies, []).kind,
					"placed",
					"uma porta nao precisa de passeio",
				);
				checkEq(walks, 0, "e nao gasta o orcamento");
			} finally {
				ENC.boxesIn = walk;
			}
		}

		// 7. (L1) uma armadilha nao bloqueia ninguem (world.ts isBlocking): na fresta de 64 u de um anel, com alguem
		// dentro, ela entra -- a regra dizia que ela fecharia o anel
		{
			const trap = Number(Object.keys(PLACEABLES).find(k => PLACEABLES[k].tag === "trap"));
			const world = emptyWorld();
			for (const [x, y, w, h] of [
				[1880, 1780, 40, 308],
				[2112, 1780, 168, 308],
				[1880, 2048, 400, 40],
				[1880, 1792, 168, 32],
			]) {
				W.addSolid(world, { kind: "wall_h", x, y, w, h, hp: 999, hpMax: 999, destructible: false, tags: "" });
			}
			const sim = newSim(world);
			const builder = join2(sim, 0, 7311, 2080, 1740);
			builder.state.angle = Math.PI / 2;
			join2(sim, 1, 7312, INSIDE_V[0], INSIDE_V[1]);
			sim.build.hold(0, trap, undefined);
			const out = sim.build.place(
				0,
				builder.state,
				sim.players().map(sp => sp.state),
				[],
			);
			checkEq(
				out.kind,
				"placed",
				"a armadilha na unica fresta do anel, com um aliado dentro, e posta (nao prende)",
			);
			check(
				out.solid !== undefined && out.solid.x <= 2048 && out.solid.x + out.solid.w >= 2112,
				"(e ela cobre a fresta inteira: uma parede ali fecharia o anel)",
				out.solid === undefined ? "" : `${out.solid.x}..${out.solid.x + out.solid.w}`,
			);
		}

		// 8. (L2) o corpo do passeio e o do sobrevivente: uma fresta de 35 u, onde um corpo de 36 u nao passa, e fechada
		{
			const world = emptyWorld();
			for (const [x, y, w, h] of [
				[1880, 1780, 40, 308],
				[2211, 1780, 69, 308],
				[1880, 2048, 400, 40],
				[1880, 1792, 133, 32],
			]) {
				W.addSolid(world, { kind: "wall_h", x, y, w, h, hp: 999, hpMax: 999, destructible: false, tags: "" });
			}
			const piece = { x: 2048, y: 1792, w: 128, h: 32 };
			const victim = { x: 2048, y: 1936, dead: false };
			check(
				ENC.boxesIn(world, piece, true, [victim]) === victim,
				`a peca que deixa uma fresta de ${2211 - 2176} u (menos que 2 x ${PH.PLAYER_RADIUS}) conta como fechar o anel`,
			);
		}

		// 9. (L3, limite aceito na MP-24) um patio maior que 2 x ESCAPE_RANGE nao e cela para a regra
		{
			const world = emptyWorld();
			const x0 = 3000;
			const y0 = 3000;
			const S = 1200;
			for (const [x, y, w, h] of [
				[x0, y0, 536, 32],
				[x0 + 664, y0, S - 664, 32],
				[x0, y0 + S - 32, S, 32],
				[x0, y0, 32, S],
				[x0 + S - 32, y0, 32, S],
			]) {
				W.addSolid(world, { kind: "wall_h", x, y, w, h, hp: 999, hpMax: 999, destructible: false, tags: "" });
			}
			const piece = { x: x0 + 536, y: y0, w: 128, h: 32 };
			check(
				ENC.boxesIn(world, piece, true, [{ x: x0 + S / 2, y: y0 + S / 2, dead: false }]) === undefined,
				`um patio de ${S} u fecha com alguem no meio: limite aceito (MP-24), a busca fica em ${2 * ENC.ESCAPE_RANGE} u`,
			);
		}
	}
}

section("z) andar por cima (ITM-07): o servidor pega o suprimento sob o corpo, sem mensagem do cliente, e todos sabem");
{
	const RULE = require(join(SRC, "shared/sim/pickupRule.ts"));
	const world = emptyWorld();
	const sim = newSim(world);
	const save = SAVE.defaultSave();
	const walker = addPlayer(sim, 0, 2000, 2000, save);
	const watcher = addPlayer(sim, 1, 2600, 2000);
	run(sim, 1);
	drain(sim);
	const wood = W.spawnGroundItem(world, 4, 23, 4, 2006, 2000);
	const pistol = W.spawnGroundItem(world, 1, 10, 1, 2004, 2008);
	drain(sim);
	const had = countItem(save, 4, 23);
	const seen = run(sim, Math.ceil((RULE.WALK_PICKUP_DELAY_S + 0.3) * 60));
	checkEq(countItem(save, 4, 23) - had, 4, "a madeira sob o corpo entrou na mochila sem nenhum comando");
	check(world.items.includes(pistol) && !world.items.includes(wood), "a pistola ficou no chao (arma e com E)");
	const gone = drain(sim).filter(d => d.ev.t === P.WorldEv.ItemRemove && d.ev.id === wood.id);
	checkEq(gone.length, 2, "o ItemRemove foi para os dois que viram o item (quem pegou e quem olhava)");
	check(
		seen.length === 1 && seen[0].slot === walker.slot && seen[0].outcome.kind === "item",
		"e o servidor avisou uma vez, como um E: o save de quem pegou fica sujo para salvar",
	);
	check(
		watcher.save !== save && countItem(watcher.save, 4, 23) === countItem(SAVE.defaultSave(), 4, 23),
		"o outro nao recebeu nada",
	);
	// E still takes the pistol
	send(walker, 1, 0, PRESS_E, 0);
	run(sim, 1);
	check(!world.items.includes(pistol) && save.invenWeapon[10] >= 1, "o E pega a pistola");
}

// ---------------------------------------------------------------- verdict

console.log("");
section(
	"y) a bomba do posto e um conteiner de oleo: rola perto, avisa pelo LootFlag, o primeiro E leva, volta em 12 h (EDI-16)",
);
{
	const { PUMP_LOOT } = require(join(SRC, "shared/data/spawns.ts"));
	const { gameHours } = require(join(SRC, "shared/sim/clock.ts"));
	const IQ = require(join(SRC, "shared/sim/interactQuery.ts"));
	const Mirror = require(join(SRC, "client/net/worldMirror.ts"));
	const CInter = require(join(SRC, "client/systems/interaction.ts"));
	const OIL = 48;
	const island = extra => ({
		kind: "wall_h",
		x: 1000,
		y: 1000,
		w: 150,
		h: 40,
		hp: 999999,
		hpMax: 999999,
		destructible: false,
		tags: "pump",
		face: "top",
		lootSlots: 1,
		lootItems: [],
		lootTimer: 0,
		...extra,
	});
	// a static island (its id small, as a generated town's: the LootFlag carries it in a u16), then the server's world
	const world = W.createWorld(8000, 8000);
	const pump = W.addSolid(world, island());
	W.serverWorld(world);
	const clock = new WorldClock({ day: 1, dayTime: 12 });
	const sim = newSim(world, clock);
	const sweep = Math.ceil(sim.simHz * 0.6);
	// two survivors on its shop side (the street is "top"), both within reach of its edge
	const a = addPlayer(sim, 0, 1060, 1062);
	const b = addPlayer(sim, 1, 1100, 1064);
	check(IQ.interactTarget(world, a.state.x, a.state.y)?.kind === "pump", "o alvo do E ali e a bomba");
	run(sim, sweep);
	const oil = pump.lootItems.reduce((n, d) => n + (d.kind === 4 && d.id === OIL ? d.count : 0), 0);
	check(
		pump.lootItems.length === 1 && oil >= PUMP_LOOT[0].min && oil <= PUMP_LOOT[0].max,
		"a bomba rolou o combustivel quando alguem chegou perto: um slot de oleo, na faixa da tabela",
		`${oil} Oil (${PUMP_LOOT[0].min}-${PUMP_LOOT[0].max})`,
	);
	const on = drain(sim).filter(d => d.ev.t === P.WorldEv.LootFlag && d.ev.buildingId === pump.id && d.ev.hasLoot);
	checkEq(
		on
			.map(d => d.slot)
			.sort()
			.join(","),
		"0,1",
		"o LootFlag da bomba foi para quem esta nela (o conteudo nunca viaja)",
	);
	{
		// the same message, the same u16: the island's id survives the wire
		const enc = P.encodeWorld({ tick: 3, events: [on[0].ev] });
		const back = P.decodeWorld(enc.packets[0]);
		checkEq(back?.events[0]?.buildingId, pump.id, "e o id da bomba atravessa o fio no LootFlag de sempre");
	}
	const before = [countItem(a.save, 4, OIL), countItem(b.save, 4, OIL)];
	send(a, 1, 0, PRESS_E);
	send(b, 1, 0, PRESS_E);
	const seen = run(sim, 1);
	const got = [countItem(a.save, 4, OIL) - before[0], countItem(b.save, 4, OIL) - before[1]];
	checkEq(got[0] + got[1], oil, "todo o oleo foi para uma mochila");
	check(got[0] === 0 || got[1] === 0, "e so para uma (o primeiro E leva tudo, MP-05)", `A +${got[0]}, B +${got[1]}`);
	checkEq(seen.filter(s => s.outcome.kind === "pump").length, 1, "um so dreno na tick");
	check(
		seen.some(s => s.outcome.kind === "refused" && s.outcome.why === "empty"),
		"e o segundo ouve do servidor por que nao levou nada: vazia",
	);
	checkEq(pump.lootItems.length, 0, "a bomba ficou seca");
	check(
		Math.abs(pump.lootTimer - (gameHours(1, 12) + DESIGN.ITEM_RESPAWN_HOURS)) < 0.05,
		"e so volta depois de ITEM_RESPAWN_HOURS de jogo",
		`lootTimer ${pump.lootTimer.toFixed(2)} h`,
	);
	run(sim, 1);
	const off = drain(sim).filter(d => d.ev.t === P.WorldEv.LootFlag && d.ev.buildingId === pump.id && !d.ev.hasLoot);
	checkEq(off.length, 2, "o aviso cai para os dois, na tick seguinte");
	const loser = got[0] > 0 ? b : a;
	const had = countItem(loser.save, 4, OIL);
	// past the press cooldown (PRESS_COOLDOWN_S), the loser tries again
	run(sim, Math.ceil(sim.simHz * 0.3));
	send(loser, 2, 0, PRESS_E);
	const again = run(sim, 1);
	checkEq(countItem(loser.save, 4, OIL), had, "E na bomba seca nao rende nada");
	check(
		again.some(s => s.outcome.kind === "refused" && s.outcome.why === "empty"),
		"e o servidor diz por que: vazia",
	);
	// the respawn: once the world clock has passed it, the next sweep rolls the island again
	run(sim, sweep);
	checkEq(pump.lootItems.length, 0, "antes da hora, nada rola de novo");
	clock.day = 2;
	clock.dayTime = 1;
	run(sim, sweep);
	checkEq(pump.lootItems.length, 1, "12 h de jogo depois, a bomba tem combustivel de novo");
	// reach is the server's: from across the forecourt, nothing
	{
		const far = W.createWorld(8000, 8000);
		const p2 = W.addSolid(far, island({ lootItems: [{ kind: 4, id: OIL, count: 7 }] }));
		W.serverWorld(far);
		const sim2 = newSim(far);
		const c = addPlayer(sim2, 0, 1075, 1200);
		const had2 = countItem(c.save, 4, OIL);
		send(c, 1, 0, PRESS_E);
		run(sim2, 1);
		checkEq(countItem(c.save, 4, OIL), had2, "a 160 u da bomba, o E nao drena nada (a distancia e a do servidor)");
		checkEq(p2.lootItems.length, 1, "e a bomba continua cheia");
	}
	// the client: the flag leaves the placeholder the pill reads, the pill says what E does (LEG-01), a dry one says
	// nothing, and a reset of the mirror dries every island again (the next flag names the one the survivor is at)
	{
		const cw = W.createWorld(8000, 8000);
		const cp = W.addSolid(cw, island());
		Mirror.forgetMirrorIndex();
		const refs = { world: cw, pendingPlace: -1, save: SAVE.defaultSave(), players: [], zombies: [] };
		const by = { x: 1060, y: 1062 };
		checkEq(CInter.interactHint(refs, by), undefined, "bomba seca: nenhuma pilula");
		Mirror.applyMirrorEvent(cw, { t: P.WorldEv.LootFlag, buildingId: cp.id, hasLoot: true });
		check(IQ.holdsLoot(cp), "o LootFlag da bomba chega ao espelho do cliente");
		checkEq(CInter.interactHint(refs, by), "E: Siphon Oil", "e a pilula diz o que o E faz");
		Mirror.resetMirror(cw);
		check(!IQ.holdsLoot(cp), "um WorldInit novo seca a bomba no espelho ate o proximo aviso");
		Mirror.forgetMirrorIndex();
	}
}

section(
	"zb) o cofre do banco: pe de cabra, E segurado 10 s, barulho, a porta abre para todos, o alarme toca e chama a horda, e o cofre so enche uma vez (EDI-23)",
);
{
	const V = require(join(SRC, "shared/sim/vault.ts"));
	const IQ = require(join(SRC, "shared/sim/interactQuery.ts"));
	const { VAULT_LOOT } = require(join(SRC, "shared/data/spawns.ts"));
	const { gameHours } = require(join(SRC, "shared/sim/clock.ts"));
	const Mirror = require(join(SRC, "client/net/worldMirror.ts"));
	const world = W.serverWorld(W.generateTown(7331));
	const bank = world.solids.find(s => s.kind === "building" && s.buildingType === 22);
	check(bank !== undefined, "a cidade 7331 tem um banco");
	const door = world.solids.find(s => V.isVaultDoor(s) && s.bankId === bank?.id);
	const box = world.solids.find(s => V.isVaultBox(s) && s.bankId === bank?.id);
	const portico = world.solids.find(s => V.isPortico(s) && s.bankId === bank?.id);
	check(door !== undefined && box !== undefined && portico !== undefined, "com a porta do cofre, as caixas e o portico");
	checkEq(door?.open, false, "a porta do cofre nasce fechada");
	const vault = bank.rooms.find(r => r.kind === "vault");
	// the hall side of the door: away from the vault's floor
	const alongXDoor = door.w >= door.h;
	const hallSign = alongXDoor
		? Math.sign(door.y + door.h / 2 - (vault.y + vault.h / 2))
		: Math.sign(door.x + door.w / 2 - (vault.x + vault.w / 2));
	const at = {
		x: alongXDoor ? door.x + door.w / 2 : door.x + door.w / 2 + hallSign * (door.w / 2 + 20),
		y: alongXDoor ? door.y + door.h / 2 + hallSign * (door.h / 2 + 20) : door.y + door.h / 2,
	};
	const clock = new WorldClock({ day: 1, dayTime: 12 });
	const sim = newSim(world, clock);
	const rings = [];
	sim.interaction.vaults.noise = (x, y, r, shot) => rings.push({ x, y, r, shot });
	const fx = [];
	sim.onFx = e => fx.push(e);
	const a = addPlayer(sim, 0, at.x, at.y);
	const b = addPlayer(sim, 1, at.x + 2000, at.y);
	checkEq(IQ.interactTarget(world, a.state.x, a.state.y)?.solid, door, "o alvo do E ali e a porta do cofre");
	drain(sim);
	const HOLD = P.HeldBit.Action;
	let seq = 1;
	/** one command a tick: E held (and pressed on the first), for `secs` seconds */
	const hold = (sp, secs, press = true) => {
		const n = Math.round(secs * sim.simHz);
		const seen = [];
		for (let i = 0; i < n; i++) {
			const cmd = P.makeCommand(seq, 0, 0, 0, HOLD, press && i === 0 ? PRESS_E : 0);
			PL.ingestInput(sp, P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [cmd] }), sim.tick / sim.simHz);
			seq += 1;
			seen.push(...run(sim, 1));
		}
		return seen;
	};

	// no crowbar: nothing starts
	const bare = hold(a, 1);
	check(
		bare.some(s => s.outcome.kind === "refused" && s.outcome.why === "material"),
		"sem pe de cabra, o servidor recusa ('material', como um reparo sem madeira)",
	);
	check(!sim.interaction.vaults.working(0), "e ninguem esta trabalhando a porta");
	checkEq(door.open, false, "a porta segue fechada");

	// with one: half the work, then let go -- the bolts seat again
	addItem(a.save, V.VAULT_TOOL_KIND, V.VAULT_TOOL_INDEX, 1);
	rings.length = 0;
	fx.length = 0;
	hold(a, V.VAULT_CRACK_S / 2);
	check(sim.interaction.vaults.working(0), "com o pe de cabra e E segurado, o trabalho anda");
	const half = sim.interaction.vaults.progressOf(door);
	check(Math.abs(half - V.VAULT_CRACK_S / 2) < 0.2, "o servidor conta o tempo do E segurado", `${half.toFixed(2)} s`);
	checkEq(door.open, false, "na metade, a porta ainda nao cede");
	const clanks = rings.filter(r => r.r === V.VAULT_WORK_NOISE && r.shot);
	check(
		clanks.length >= V.VAULT_CRACK_S / 2 / V.VAULT_WORK_PERIOD - 1,
		"cada segundo de trabalho e um barulho que a horda ouve (IA-02)",
		`${clanks.length} aneis de ${V.VAULT_WORK_NOISE}`,
	);
	check(
		fx.filter(e => e.t === P.FxType.Sound).length >= clanks.length,
		"e um som de aco para quem esta perto (o Fx de uma porta de ferro)",
	);
	// let go for longer than the grace (commands without the held bit)
	for (let i = 0; i < Math.round((V.VAULT_GRACE_S + 0.3) * sim.simHz); i++) {
		send(a, seq++, 0, 0, sim.tick / sim.simHz);
		run(sim, 1);
	}
	checkEq(sim.interaction.vaults.progressOf(door), 0, "soltou o E: o trabalho recomeca do zero");
	check(!sim.interaction.vaults.working(0), "e ninguem trabalha mais a porta");

	// walking off stops it as well
	hold(a, 1);
	a.state.x += 400;
	hold(a, 0.2, false);
	check(!sim.interaction.vaults.working(0), "quem se afasta da porta para de trabalhar");
	a.state.x = at.x;
	a.state.y = at.y;
	for (let i = 0; i < Math.round((V.VAULT_GRACE_S + 0.3) * sim.simHz); i++) run(sim, 1);

	// the whole crack
	drain(sim);
	rings.length = 0;
	hold(a, V.VAULT_CRACK_S + 0.3);
	checkEq(door.open, true, `${V.VAULT_CRACK_S} s de E segurado com o pe de cabra: a porta do cofre cede`);
	const out = drain(sim);
	const doorSets = out.filter(p => p.ev.t === P.WorldEv.DoorSet && p.ev.id === door.id);
	checkEq(doorSets.length, 1, "um DoorSet da porta do cofre");
	checkEq(doorSets[0]?.slot, CFG.SLOT_NONE, "para todo mundo, como qualquer porta (§4.5)");
	checkEq(doorSets[0]?.ev.state, P.SolidState.Open, "aberta");
	const bells = out.filter(p => p.ev.t === P.WorldEv.LightSet && p.ev.id === portico.id);
	checkEq(bells.length, 1, "e o LightSet do portico: o alarme tocando");
	check(bells[0]?.ev.powered === true && bells[0]?.slot === CFG.SLOT_NONE, "ligado, para todo mundo");
	checkEq(portico.powered, true, "o sino do portico esta tocando");
	check(
		rings.some(r => r.r === V.VAULT_OPEN_NOISE && r.shot),
		"a porta cedendo e um estrondo (um tiro de pistola)",
	);
	const alarmRing = rings.find(r => r.r === V.VAULT_ALARM_RADIUS);
	check(
		alarmRing !== undefined &&
			Math.abs(alarmRing.x - (portico.x + portico.w / 2)) < 1 &&
			Math.abs(alarmRing.y - (portico.y + portico.h / 2)) < 1,
		`o alarme chama a horda num raio de ${V.VAULT_ALARM_RADIUS} u, a partir da frente do banco`,
	);
	// the client: the DoorSet opens its copy, a WorldInit shuts it again until told
	{
		const cw = W.generateTown(7331);
		const cd = cw.solids.find(s => s.id === door.id);
		const cpo = cw.solids.find(s => s.id === portico.id);
		Mirror.forgetMirrorIndex();
		check(cd !== undefined && V.isVaultDoor(cd) && cd.open === false, "o cliente gera a mesma porta, com o mesmo id, fechada");
		Mirror.applyMirrorEvent(cw, doorSets[0].ev);
		Mirror.applyMirrorEvent(cw, bells[0].ev);
		check(cd?.open === true && cpo?.powered === true, "o DoorSet e o LightSet de sempre abrem a copia dele e tocam o sino");
		Mirror.resetMirror(cw);
		check(cd?.open === false && cpo?.powered !== true, "um WorldInit novo fecha a porta e cala o sino ate ser avisado");
		Mirror.forgetMirrorIndex();
	}
	// E at the open door: nothing -- it hangs open for good
	run(sim, Math.ceil(sim.simHz * 0.3));
	send(a, seq++, 0, PRESS_E, sim.tick / sim.simHz);
	run(sim, 1);
	checkEq(door.open, true, "E na porta aberta nao a fecha (cofre arrombado fica aberto)");

	// a late joiner is told: the door open, the bell ringing
	{
		const sent = [];
		const replicator = new Replicator(
			sim,
			{
				snap: () => {},
				fx: () => {},
				world: (slot, packet) => sent.push({ slot, packet }),
				worldAll: packet => sent.push({ slot: CFG.SLOT_NONE, packet }),
			},
			{ tick0Time: 0, mapHash: mapHashOf(world) },
		);
		const late = addPlayer(sim, 2, at.x, at.y + 600);
		replicator.welcome(late);
		replicator.afterTick(1);
		const got = [];
		for (const s of sent.filter(q => q.slot === 2)) for (const e of P.decodeWorld(s.packet).events) got.push(e);
		check(
			got.some(e => e.t === P.WorldEv.DoorSet && e.id === door.id && e.state === P.SolidState.Open),
			"quem entra depois recebe a porta do cofre aberta (o WorldInit das portas do mapa)",
		);
		check(
			got.some(e => e.t === P.WorldEv.LightSet && e.id === portico.id && e.powered === true),
			"e o sino tocando, enquanto toca",
		);
	}

	// the alarm keeps calling, then stops
	rings.length = 0;
	drain(sim);
	for (let i = 0; i < Math.ceil((V.VAULT_ALARM_S + 1) * sim.simHz); i++) run(sim, 1);
	const pulses = rings.filter(r => r.r === V.VAULT_ALARM_RADIUS).length;
	check(
		pulses >= Math.floor(V.VAULT_ALARM_S / V.VAULT_ALARM_PERIOD) - 2,
		`o alarme chama de novo a cada ${V.VAULT_ALARM_PERIOD} s enquanto toca`,
		`${pulses} aneis`,
	);
	const off = drain(sim).filter(p => p.ev.t === P.WorldEv.LightSet && p.ev.id === portico.id);
	check(off.length === 1 && off[0].ev.powered === false, `depois de ${V.VAULT_ALARM_S} s o sino cala (LightSet desligado)`);
	checkEq(portico.powered, false, "e o portico fica em silencio");

	// the boxes: inside the vault, the flag is theirs; E takes everything; once a town
	const n = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }[box.face];
	a.state.x = box.x + box.w / 2 + n[0] * (box.w / 2 + 26);
	a.state.y = box.y + box.h / 2 + n[1] * (box.h / 2 + 26);
	check(V.inVault(bank, a.state.x, a.state.y), "dentro do cofre");
	for (let i = 0; i < Math.ceil(sim.simHz * 0.6); i++) run(sim, 1);
	check(box.lootItems.length > 0, "as caixas rolaram quando alguem chegou perto");
	const flags = drain(sim).filter(p => p.ev.t === P.WorldEv.LootFlag && p.slot === 0);
	check(
		flags.some(p => p.ev.buildingId === box.id && p.ev.hasLoot),
		"dentro do cofre, o LootFlag e o das caixas, nao o do banco",
	);
	checkEq(IQ.interactTarget(world, a.state.x, a.state.y)?.kind, "pump", "o E ali abre as caixas (um conteiner, como a barraca)");
	const inBox = box.lootItems.map(d => `${d.kind}/${d.id}`);
	check(
		box.lootItems.every(d => VAULT_LOOT.some(e => e.kind === d.kind && e.index === d.id)) &&
			!box.lootItems.some(d => d.kind === 1 || (d.kind === 4 && d.id >= 44 && d.id <= 47)),
		"so o que a tabela do cofre tem, e nunca arma ou municao",
		inBox.join(" "),
	);
	check(box.lootItems.some(d => d.kind === 4 && d.id === 27), "ouro sempre (2 a 4 pedacos)");
	const gold = countItem(a.save, 4, 27);
	send(a, seq++, 0, PRESS_E, sim.tick / sim.simHz);
	const took = run(sim, 1);
	check(took.some(s => s.outcome.kind === "pump"), "o E leva tudo");
	check(countItem(a.save, 4, 27) > gold, "o ouro foi para a mochila");
	checkEq(box.lootItems.length, 0, "as caixas ficaram vazias");
	checkEq(box.lootTimer, Infinity, "e nao enchem de novo nesta cidade (uma vez por mundo)");
	clock.day = 30;
	for (let i = 0; i < Math.ceil(sim.simHz * 0.6); i++) run(sim, 1);
	checkEq(box.lootItems.length, 0, "30 dias depois, continuam vazias");
	check(gameHours(30, 12) > 0, "(o relogio andou)");
	void b;

	// the real wiring: the work's clank reaches the horde's ears (zombieBrain's emitSound), not only a test hook
	{
		const w2 = W.serverWorld(W.generateTown(7331));
		const d2 = w2.solids.find(s => V.isVaultDoor(s));
		const sim2 = new ServerSimulation({ world: w2, clock: new WorldClock({ day: 1, dayTime: 12 }), zombies: true, interactive: true });
		const c = addPlayer(sim2, 0, at.x, at.y);
		addItem(c.save, V.VAULT_TOOL_KIND, V.VAULT_TOOL_INDEX, 1);
		for (let i = 0; i < Math.round(sim2.simHz * 1.2); i++) {
			const cmd = P.makeCommand(seq, 0, 0, 0, HOLD, i === 0 ? PRESS_E : 0);
			PL.ingestInput(c, P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [cmd] }), sim2.tick / sim2.simHz);
			seq += 1;
			sim2.step();
		}
		const heard = (sim2.horde?.refs.sounds ?? []).some(
			r => Math.hypot(r.x - (d2.x + d2.w / 2), r.y - (d2.y + d2.h / 2)) < 1 && r.rMax > 0,
		);
		check(heard, "o barulho do trabalho chega aos ouvidos da horda (emitSound, IA-02)");
	}
	// the pill: what the door needs, what E does
	{
		const CInter = require(join(SRC, "client/systems/interaction.ts"));
		const cw = W.generateTown(7331);
		const refs = {
			world: cw,
			pendingPlace: -1,
			save: SAVE.defaultSave(),
			players: [],
			zombies: [],
			player: { x: at.x, y: at.y, dead: false },
			input: { keyE: false },
		};
		checkEq(CInter.interactHint(refs, at), "Vault: needs Crowbar", "a pilula diz o que falta: um pe de cabra");
		addItem(refs.save, V.VAULT_TOOL_KIND, V.VAULT_TOOL_INDEX, 1);
		checkEq(CInter.interactHint(refs, at), "E: Crack vault (hold)", "com ele: segurar E arromba");
	}
}

if (failures > 0) {
	console.log(`${failures} de ${checks} verificacao(oes) falharam`);
	process.exit(1);
}
console.log(`${checks} verificacoes, 0 falhas`);
