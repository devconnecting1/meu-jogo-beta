#!/usr/bin/env node
/*
 * Save v3 and the rewards the SERVER pays (F3, docs/MULTIPLAYER.md §3.6, §6.1, §6.3, §6.4, §8.3).
 *
 *   node tools/test-save.mjs
 *   PZ_SRC=path/to/src node tools/test-save.mjs
 *
 * Two things are checked here, and both of them are the kind that is expensive to get wrong.
 *
 * 1. THE MIGRATION. v3 adds `runHp` and `runHunger` to a document that already exists in production, in the
 *    same DataStore, for real players. A migration that loses a field loses somebody's hundred hours. So the
 *    test starts from a save with the PRODUCTION SHAPE — `version: 2`, a populated `settings` (including
 *    `mirror`, which only a real save has), full inventories, packs, costumes, achievements and skills — and
 *    asserts, field by field, that reading it as v3 changes exactly two things and nothing else. It also
 *    checks the way back: a v3 document read by v2 code (unknown keys dropped) still yields the same save,
 *    so a rollback is safe, and the v1 legacy path (`shopHave`) still migrates.
 *
 *    v4 (MON-04) does the same for the cosmetic slots: the single `equipDeco` of a v2/v3 document becomes
 *    `equipOutfit` or `equipPet` by what it is, a rollback to v3 forgets only WHICH cosmetic was worn (never one
 *    that was bought), and a client report can never wear a cosmetic the server does not know it owns. The
 *    wardrobe's purchase (server/save/costumes.ts) is the one way coins become a costume: unknown ids, too few
 *    coins and a costume already owned are refused with the save untouched, and a purchase takes exactly the
 *    catalogue price.
 *
 * 2. THE COINS. Since F2 pinned `day` and `bossKills` in the client report (`stripClientProgress`), the
 *    payment in server/main.server.ts — which only fired when a report MOVED those fields — became
 *    unreachable, and a day survived silently paid nothing. The fix moves the payment next to the event, so
 *    the test pins the behaviour that was missing: a day pays once, a milestone pays once ever, an assisted
 *    run pays nothing, a run at DAY_MAX pays nothing, and a boss pays its coins too.
 *
 * Pure Node (>= 18) + the project's TypeScript, through tools/luau-shim.mjs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installShims } from "./luau-shim.mjs";

const { SRC, require } = installShims({ seed: 1 });

const SAVE = require(join(SRC, "shared/game/save.ts"));
const { ECONOMY } = require(join(SRC, "shared/data/shop.ts"));
const { SKILLS } = require(join(SRC, "shared/data/skills.ts"));
const { ACHIEVEMENTS } = require(join(SRC, "shared/data/achievements.ts"));
const { WEAPONS } = require(join(SRC, "shared/data/weapons.ts"));
const { EQUIPS } = require(join(SRC, "shared/data/equips.ts"));
const { USABLES } = require(join(SRC, "shared/data/usables.ts"));
const { ETC_ITEMS } = require(join(SRC, "shared/data/etcItems.ts"));
const { SHOP_PACKS, COSTUMES } = require(join(SRC, "shared/data/shop.ts"));
const COS = require(join(SRC, "shared/data/cosmetics.ts"));
const { EquipSlot } = require(join(SRC, "shared/data/equips.ts"));
const PLAYER = require(join(SRC, "shared/game/player.ts"));
const { ServerCraft } = require(join(SRC, "server/sim/craft.ts"));
const PROG = require(join(SRC, "server/sim/progress.ts"));
const { ServerSimulation } = require(join(SRC, "server/sim/simulation.ts"));
const { WorldClock } = require(join(SRC, "server/sim/waves.ts"));
const { createServerPlayer, ingestInput } = require(join(SRC, "server/sim/players.ts"));
const P = require(join(SRC, "shared/net/protocol.ts"));
const { createWorld } = require(join(SRC, "shared/game/world.ts"));

// ---------------------------------------------------------------- tiny harness

let failures = 0;
let checks = 0;

function check(ok, what, detail) {
	checks += 1;
	if (ok) {
		console.log(`  ok    ${what}${detail !== undefined ? `  (${detail})` : ""}`);
		return true;
	}
	failures += 1;
	console.log(`  FALHA ${what}${detail !== undefined ? `  (${detail})` : ""}`);
	return false;
}

function checkEq(got, want, what) {
	return check(got === want, what, got === want ? undefined : `esperado ${want}, veio ${got}`);
}

function checkArrayEq(got, want, what) {
	const same = Array.isArray(got) && got.length === want.length && got.every((v, i) => v === want[i]);
	return check(same, what, same ? undefined : `${JSON.stringify(got)} != ${JSON.stringify(want)}`);
}

function section(title) {
	console.log(`\n${title}`);
}

/** a plain array of `n` entries, filled by `fn` — the production save has one per definition */
function filled(n, fn) {
	const a = [];
	for (let i = 0; i < n; i++) a.push(fn(i));
	return a;
}

// ---------------------------------------------------------------- the production save shape
/*
 * What a live v2 document looks like: every field the v2 schema writes, with values that are all DIFFERENT
 * from the defaults, so a field silently falling back to its default is a failure and not a coincidence.
 * `settings.mirror` is here because the real save read through Open Cloud has it — a save written by the
 * current client, not a hand-made fixture.
 */
function productionV2() {
	return {
		version: 2,
		level: 37,
		exp: 214,
		skillPoint: 3,
		skillLevels: filled(SKILLS.size(), i => (i % 4 === 0 ? Math.min(2, SKILLS[i].maxLevel) : 0)),
		money: 1843,
		day: 41,
		bestDay: 58,
		deathCount: 2,
		bossKills: 6,
		firstInstall: false,
		tutorialDone: true,
		achievements: filled(ACHIEVEMENTS.size(), i => (i % 3 === 0 ? Math.min(4, ACHIEVEMENTS[i].max) : 0)),
		packsBought: filled(SHOP_PACKS.size(), i => i + 1),
		packsOpened: filled(SHOP_PACKS.size(), i => i),
		costumes: filled(COSTUMES.size(), i => (i % 2 === 0 ? 1 : 0)),
		runOver: false,
		runRev: 9,
		settings: {
			soundEffect: 0.8,
			bgm: 0.15,
			uiSize: 0.62,
			leftSize: 0.4,
			leftPos: 0.33,
			leftRelative: false,
			rightSize: 0.7,
			rightPos: 0.9,
			mirror: true,
			langType: 2,
		},
		invenWeapon: filled(WEAPONS.size(), i => (i % 5 === 0 ? 1 : 0)),
		invenEquip: filled(EQUIPS.size(), i => (i % 7 === 0 ? 1 : 0)),
		invenUse: filled(USABLES.size(), i => (i % 2 === 0 ? 3 : 0)),
		invenEtc: filled(ETC_ITEMS.size(), i => (i < 40 ? i * 2 : 0)),
		ammoNormal: 312,
		ammoShotgun: 44,
		ammoMachinegun: 901,
		ammoArrow: 17,
		oil: 65,
		electric: 8,
		equipWeapon: 0,
		equipCloth: -1,
		equipHand: -1,
		equipGun: -1,
		equipDeco: -1,
	};
}

/** the v2 fields, by name, that must survive the migration untouched */
const V2_SCALARS = [
	"level",
	"exp",
	"skillPoint",
	"money",
	"day",
	"bestDay",
	"deathCount",
	"bossKills",
	"firstInstall",
	"tutorialDone",
	"runOver",
	"runRev",
	"ammoNormal",
	"ammoShotgun",
	"ammoMachinegun",
	"ammoArrow",
	"oil",
	"electric",
	"equipWeapon",
	"equipCloth",
	"equipHand",
	"equipGun",
	// `equipDeco` is not here on purpose: v4 replaced it with `equipOutfit` / `equipPet`, and section 12 checks
	// that its value lands in the right one of the two
];
const V2_ARRAYS = [
	"skillLevels",
	"achievements",
	"packsBought",
	"packsOpened",
	"costumes",
	"invenWeapon",
	"invenEquip",
	"invenUse",
	"invenEtc",
];

function assertSameAsV2(doc, save, label) {
	let bad = 0;
	for (const key of V2_SCALARS) {
		if (save[key] !== doc[key]) {
			bad += 1;
			console.log(`        ${key}: esperado ${doc[key]}, veio ${save[key]}`);
		}
	}
	for (const key of V2_ARRAYS) {
		const a = save[key];
		const b = doc[key];
		if (!Array.isArray(a) || a.length !== b.length || !a.every((v, i) => v === b[i])) {
			bad += 1;
			console.log(`        ${key}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
		}
	}
	for (const [key, value] of Object.entries(doc.settings)) {
		if (save.settings[key] !== value) {
			bad += 1;
			console.log(`        settings.${key}: esperado ${value}, veio ${save.settings[key]}`);
		}
	}
	check(bad === 0, label, bad === 0 ? `${V2_SCALARS.length + V2_ARRAYS.length + 10} campos` : `${bad} divergiram`);
}

// ---------------------------------------------------------------- 1. migration v2 -> v3

section("1) migracao v2 -> v3 de um save com a forma de producao");
{
	const doc = productionV2();
	const save = SAVE.sanitizeStoredSave(doc);
	checkEq(SAVE.storedVersion(doc), 2, "o documento lido se declara v2");
	checkEq(save.version, SAVE.SAVE_VERSION, "e sai na versao atual");
	checkEq(SAVE.SAVE_VERSION, 4, "SAVE_VERSION e 4 (dois slots cosmeticos, MON-04)");
	assertSameAsV2(doc, save, "nenhum campo v2 mudou de valor");
	checkEq(save.equipOutfit, -1, "equipDeco -1 do v2 -> nenhum traje");
	checkEq(save.equipPet, -1, "e nenhum pet");
	check(!("equipDeco" in save), "equipDeco nao existe mais no save v4");
	checkEq(save.runHp, 0, "runHp nasce em 0 (= nao registrado, entra com a vida cheia)");
	checkEq(save.runHunger, 0, "runHunger nasce em 0 (= cheio)");
	check(save.settings.mirror === true, "settings.mirror (canhoto) sobreviveu");

	// the real path: the document goes to the DataStore as JSON and comes back
	const roundTrip = SAVE.sanitizeStoredSave(JSON.parse(JSON.stringify(doc)));
	assertSameAsV2(doc, roundTrip, "JSON ida e volta preserva tudo");
}

section("2) o save v3 gravado volta inteiro, e um rollback para v2 e seguro");
{
	const doc = productionV2();
	const save = SAVE.sanitizeStoredSave(doc);
	save.runHp = 73;
	save.runHunger = 412;
	// what the server writes back to the DataStore
	const stored = JSON.parse(JSON.stringify(save));
	checkEq(SAVE.storedVersion(stored), SAVE.SAVE_VERSION, "o documento gravado se declara na versao atual");
	const again = SAVE.sanitizeStoredSave(stored);
	checkEq(again.runHp, 73, "runHp voltou");
	checkEq(again.runHunger, 412, "runHunger voltou");
	assertSameAsV2(doc, again, "e o resto continua igual ao v2 original");

	// a server rolled back to v2 code drops the unknown keys; nothing else is lost
	const rolledBack = JSON.parse(JSON.stringify(stored));
	delete rolledBack.runHp;
	delete rolledBack.runHunger;
	rolledBack.version = 2;
	const back = SAVE.sanitizeStoredSave(rolledBack);
	assertSameAsV2(doc, back, "rollback v3 -> v2 -> v3 nao perde nada");
	checkEq(back.runHp, 0, "so a barra de vida da run e esquecida");
}

section("3) o save v1 legado (shopHave) continua migrando");
{
	const v1 = {
		level: 12,
		exp: 30,
		skillPoint: 1,
		money: 240,
		day: 9,
		deathCount: 1,
		bossKills: 2,
		shopHave: filled(SHOP_PACKS.size(), i => (i === 0 ? 3 : 0)),
		invenUse: filled(USABLES.size(), i => (i === 0 ? 5 : 0)),
		ammoNormal: 20,
	};
	const save = SAVE.sanitizeStoredSave(v1);
	checkEq(SAVE.storedVersion(v1), 0, "um documento v1 nao declara versao");
	checkEq(save.version, SAVE.SAVE_VERSION, "e sobe direto para a versao atual");
	checkEq(save.level, 12, "o nivel veio");
	checkEq(save.money, 240, "as moedas vieram");
	checkEq(save.day, 9, "o dia veio");
	checkEq(save.packsBought[0], 3, "shopHave virou packsBought");
	checkEq(save.packsOpened[0], 0, "e nada foi entregue ainda");
	checkEq(save.invenUse[0], 5, "o inventario veio");
	checkEq(save.runHp, 0, "runHp nasce zerado");
}

section("4) o relatorio do cliente nao move o corpo da run nem as moedas");
{
	const base = SAVE.sanitizeStoredSave(productionV2());
	base.runHp = 55;
	base.runHunger = 100;
	const forged = JSON.parse(JSON.stringify(base));
	forged.runHp = SAVE.SAVE_LIMITS.RUN_HP_MAX;
	forged.runHunger = 0;
	forged.money = SAVE.SAVE_LIMITS.MONEY_MAX;
	const upd = SAVE.sanitizeClientReport(forged, base);
	checkEq(upd.runHp, 55, "runHp forjado foi ignorado");
	checkEq(upd.runHunger, 100, "runHunger forjado foi ignorado");
	checkEq(upd.money, base.money, "as moedas forjadas foram ignoradas");
}

section("5) copySaveInto mantem a identidade da tabela viva");
{
	const live = SAVE.sanitizeStoredSave(productionV2());
	const skills = live.skillLevels;
	const other = SAVE.sanitizeStoredSave(productionV2());
	other.money = 99;
	other.level = 40;
	other.skillLevels[0] = 1;
	const returned = SAVE.copySaveInto(live, other);
	check(returned === live, "devolve a mesma tabela");
	check(live.skillLevels === skills, "e os arrays tambem sao os mesmos objetos");
	checkEq(live.money, 99, "os valores foram copiados");
	checkEq(live.level, 40, "inclusive o nivel");
	checkEq(live.skillLevels[0], other.skillLevels[0], "e o conteudo dos arrays");

	/*
	 * The bug this exists to kill: the server credits coins into the live table while a client report is
	 * being processed. With `session.save = updated` the credit lands on an orphan. With a copy in place it
	 * cannot, because there is only one table.
	 */
	/*
	 * The one way this function can lose a save: somebody adds a field to PlayerSaveData and forgets to add
	 * a line here. It would not fail to compile and it would not fail any other test -- the field would
	 * simply stop being written to the DataStore, quietly, for everybody. So: every key of a real save has
	 * to arrive, and the check is by reflection rather than by a list somebody also has to remember.
	 */
	const target = SAVE.sanitizeStoredSave(productionV2());
	const source = SAVE.sanitizeStoredSave(productionV2());
	source.version = 3;
	const missed = [];
	for (const key of Object.keys(source)) {
		const value = source[key];
		if (typeof value === "number") source[key] = value + 1;
		else if (typeof value === "boolean") source[key] = !value;
		else if (Array.isArray(value)) source[key] = value.map(v => v + 1);
		else if (typeof value === "object") source[key] = { ...value, langType: 3 };
	}
	SAVE.copySaveInto(target, source);
	for (const key of Object.keys(source)) {
		const a = target[key];
		const b = source[key];
		const same = Array.isArray(b) ? a.length === b.length && a.every((v, i) => v === b[i]) : a === b;
		const sameObject = typeof b === "object" && !Array.isArray(b) && a === b;
		if (!same && !sameObject) missed.push(key);
	}
	check(
		missed.length === 0,
		"TODO campo do save e copiado (um campo novo esquecido aqui some do DataStore em silencio)",
		missed.length === 0 ? `${Object.keys(source).length} campos` : `faltaram: ${missed.join(", ")}`,
	);

	const session = SAVE.sanitizeStoredSave(productionV2());
	const heldByTheSimulation = session; // ServerPlayer.save
	const report = SAVE.sanitizeClientReport(JSON.parse(JSON.stringify(session)), session);
	PROG.creditDaySurvived(heldByTheSimulation); // midnight, mid-report
	const moneyAfterCredit = heldByTheSimulation.money;
	report.money = session.money; // what applyProgressLimits computes when payHere is false
	SAVE.copySaveInto(session, report);
	checkEq(session.money, moneyAfterCredit, "as moedas creditadas no meio do relatorio sobreviveram");
	check(heldByTheSimulation === session, "e a simulacao continua olhando para a tabela certa");
}

// ---------------------------------------------------------------- coins

section("6) moedas por dia: pagas uma vez, no instante em que o dia e creditado");
{
	const save = SAVE.defaultSave();
	save.day = 1;
	save.bestDay = 1;
	save.money = 0;
	const first = PROG.creditDaySurvived(save);
	checkEq(save.day, 2, "o dia da vida subiu");
	checkEq(first.coins, ECONOMY.COINS_PER_DAY, "e pagou COINS_PER_DAY");
	checkEq(save.money, ECONOMY.COINS_PER_DAY, "direto na carteira");
	checkEq(first.milestone, 0, "sem marco ainda");

	const second = PROG.creditDaySurvived(save);
	checkEq(save.day, 3, "outro dia");
	checkEq(second.coins, ECONOMY.COINS_PER_DAY, "outro pagamento, do mesmo tamanho");
	checkEq(save.money, ECONOMY.COINS_PER_DAY * 2, "a carteira soma, nao dobra");
}

section("7) o bonus de marco e pago uma vez na vida, nao a cada run");
{
	const save = SAVE.defaultSave();
	save.day = ECONOMY.MILESTONE_EVERY - 1;
	save.bestDay = ECONOMY.MILESTONE_EVERY - 1;
	save.money = 0;
	const hit = PROG.creditDaySurvived(save);
	checkEq(save.day, ECONOMY.MILESTONE_EVERY, `chegou ao dia ${ECONOMY.MILESTONE_EVERY}`);
	checkEq(hit.milestone, ECONOMY.MILESTONE_BONUS, "e o marco pagou");
	checkEq(hit.coins, ECONOMY.COINS_PER_DAY + ECONOMY.MILESTONE_BONUS, "dia + marco");

	// a new run: back to day 1, up to the same milestone again — the record did not move, so no bonus
	save.day = ECONOMY.MILESTONE_EVERY - 1;
	const moneyBefore = save.money;
	const again = PROG.creditDaySurvived(save);
	checkEq(again.milestone, 0, "a segunda vez no mesmo dia recorde nao paga marco");
	checkEq(again.coins, ECONOMY.COINS_PER_DAY, "so o dia");
	checkEq(save.money, moneyBefore + ECONOMY.COINS_PER_DAY, "e a carteira confere");
}

section("8) quem nao deve receber, nao recebe");
{
	const assisted = SAVE.defaultSave();
	assisted.money = 100;
	const credit = PROG.creditDaySurvived(assisted, false);
	checkEq(credit.coins, 0, "uma run assistida por admin nao paga (§9.3)");
	checkEq(assisted.money, 100, "a carteira nao se mexeu");
	checkEq(assisted.day, 2, "mas o dia passou, porque o mundo passou");

	const maxed = SAVE.defaultSave();
	maxed.day = SAVE.SAVE_LIMITS.DAY_MAX;
	maxed.bestDay = SAVE.SAVE_LIMITS.DAY_MAX;
	maxed.money = 0;
	const none = PROG.creditDaySurvived(maxed);
	checkEq(none.advanced, false, "no teto de dias nao ha dia novo");
	checkEq(none.coins, 0, "e nada e pago");
	checkEq(maxed.money, 0, "a carteira fica parada");
}

section("9) um chefe tambem paga as moedas dele");
{
	const save = SAVE.defaultSave();
	save.money = 0;
	const paid = PROG.creditBossKill(save);
	checkEq(save.bossKills, 1, "o contador subiu");
	checkEq(paid, ECONOMY.COINS_PER_BOSS, "e pagou COINS_PER_BOSS");
	checkEq(save.money, ECONOMY.COINS_PER_BOSS, "na carteira");
	const assisted = PROG.creditBossKill(save, false);
	checkEq(assisted, 0, "um chefe de run assistida nao paga");
	checkEq(save.bossKills, 2, "mas conta");
}

// ---------------------------------------------------------------- the whole wiring

/**
 * One tick of the world with every survivor AT THE CONTROLS. Since the security review of Sep 2026 midnight pays
 * only who is alive, was in the world for half the day and is not AFK (server/sim/progress.ts `dayRefusal`), so
 * the survivors here send a real command with an edge every tick, through the real C→S path, and are kept fed (a
 * whole game day on an empty stomach starves them, and the dead are not paid). The simulation is built without a
 * horde, so it does not drive the clock: the clock is stepped right after it, and what is under test is the
 * midnight hook, not the horde.
 */
function playTick(sim, clock, dt) {
	for (const sp of sim.players()) {
		sp.state.hungry = sp.state.hungryMax;
		const cmd = P.makeCommand((sp.lastSeq + 1) % 65536, 0, 0, 0, 0, 1);
		ingestInput(sp, P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [cmd] }), sim.tick * dt);
	}
	sim.step();
	clock.step(dt);
}

section("10) a meia-noite do mundo paga cada sobrevivente uma unica vez");
{
	const world = createWorld(4000, 4000);
	const clock = new WorldClock({ day: 3, dayTime: 23.9 });
	const sim = new ServerSimulation({ world, clock, zombies: false });
	const saves = [];
	const credits = [];
	sim.onDayCredit = (sp, credit) => credits.push({ slot: sp.slot, coins: credit.coins, day: credit.day });
	for (let slot = 0; slot < 3; slot++) {
		const save = SAVE.defaultSave();
		save.day = 10 + slot;
		save.bestDay = 10 + slot;
		save.money = 0;
		saves.push(save);
		sim.add(createServerPlayer({ slot, userId: 100 + slot, name: `p${slot}` }, save, 100, 100, 0, 60));
	}
	const dt = 1 / 60;
	for (let i = 0; i < 60 * 60; i++) playTick(sim, clock, dt);
	checkEq(clock.day, 4, "o mundo virou o dia");
	checkEq(credits.length, 3, "e cada sobrevivente foi creditado exatamente uma vez");
	for (let slot = 0; slot < 3; slot++) {
		checkEq(saves[slot].day, 11 + slot, `slot ${slot}: o dia da vida subiu 1`);
		checkEq(saves[slot].money, ECONOMY.COINS_PER_DAY, `slot ${slot}: recebeu as moedas do dia, uma vez`);
	}

	// the same survivors, one more world day: a second midnight, a second payment, never a third. The loop
	// stops AT the roll rather than after a fixed number of ticks — a game day is ~9 real minutes, and a
	// test that guesses that number is a test that measures TIME_SPEED instead of the payment.
	let guard = 60 * 60 * 30;
	while (clock.day < 5 && guard > 0) {
		playTick(sim, clock, dt);
		guard -= 1;
	}
	check(guard > 0, "o mundo virou outro dia dentro do orcamento de ticks");
	checkEq(clock.day, 5, "outro dia do mundo");
	checkEq(credits.length, 6, "outra rodada de creditos, uma por sobrevivente");
	checkEq(saves[0].money, ECONOMY.COINS_PER_DAY * 2, "duas meia-noites, dois pagamentos");
	checkEq(saves[0].day, 12, "e dois dias de vida, nao um por tick");

	// an admin skipping hours credits nobody (§3.6 "Horas puladas por admin: 0")
	const before = credits.length;
	clock.setClock(1, clock.day + 3);
	checkEq(credits.length, before, "pular horas com o admin nao paga ninguem");
}

section("11) uma run assistida por admin nao recebe as moedas da meia-noite");
{
	const world = createWorld(4000, 4000);
	const clock = new WorldClock({ day: 1, dayTime: 23.9 });
	const sim = new ServerSimulation({ world, clock, zombies: false });
	const save = SAVE.defaultSave();
	save.money = 0;
	sim.paysRewards = () => false;
	sim.add(createServerPlayer({ slot: 0, userId: 1, name: "admin-assisted" }, save, 100, 100, 0, 60));
	for (let i = 0; i < 60 * 60; i++) playTick(sim, clock, 1 / 60);
	checkEq(save.day, 2, "o dia passou");
	checkEq(save.money, 0, "e nao pagou nada");
}

// ---------------------------------------------------------------- v4: two cosmetic slots (MON-04)

const equipId = name => {
	const e = EQUIPS.find(x => x.name === name);
	if (e === undefined) throw new Error(`no equipment "${name}"`);
	return e.id;
};
const costumeOf = name => {
	const c = COSTUMES.find(x => x.name === name);
	if (c === undefined) throw new Error(`no costume "${name}"`);
	return c.id;
};
const SANTA = equipId("Santa");
const ZOMBIE = equipId("Zombie");
const COWBOY = equipId("Cowboy");
const PIGEON = equipId("Pigeon");
const EAGLE = equipId("Eagle");
const CAROLINA = equipId("Carolina");

/** the production v2 document, as a v3 server last wrote it, wearing `deco` in the one old slot */
function productionV3(deco) {
	const doc = productionV2();
	doc.version = 3;
	doc.runHp = 60;
	doc.runHunger = 210;
	doc.equipDeco = deco;
	return doc;
}

section("12) migracao v3 -> v4: o equipDeco vai para o slot certo, e so se for possuido");
{
	// the fixture owns the even costumes (Pigeon, Eagle, Malamute, Santa, Cowboy) and, in the inventory, every
	// 7th equipment -- id 21 is Carolina, so Carolina is owned through a pack, not a costume
	const fixture = productionV2();
	check(fixture.costumes[costumeOf("Santa")] === 1, "fixture: o traje Santa foi comprado");
	check(fixture.costumes[costumeOf("Zombie")] === 0, "fixture: o traje Zombie nao");
	check(
		fixture.invenEquip[CAROLINA] > 0 && fixture.costumes[costumeOf("Carolina")] === 0,
		"fixture: Carolina so no inventario",
	);

	const santa = SAVE.sanitizeStoredSave(productionV3(SANTA));
	checkEq(santa.version, SAVE.SAVE_VERSION, "o v3 sobe para v4");
	checkEq(santa.equipOutfit, SANTA, "um traje (Santa) no equipDeco vira equipOutfit");
	checkEq(santa.equipPet, -1, "e o slot de pet fica vazio");
	checkEq(santa.runHp, 60, "o corpo da run (v3) atravessa a migracao");
	assertSameAsV2(productionV3(SANTA), santa, "nenhum outro campo mudou");

	const eagle = SAVE.sanitizeStoredSave(productionV3(EAGLE));
	checkEq(eagle.equipPet, EAGLE, "um pet (Eagle) no equipDeco vira equipPet");
	checkEq(eagle.equipOutfit, -1, "e o slot de traje fica vazio");

	const carolina = SAVE.sanitizeStoredSave(productionV3(CAROLINA));
	checkEq(carolina.equipPet, CAROLINA, "um pet que veio num pacote (inventario) tambem migra");

	const zombie = SAVE.sanitizeStoredSave(productionV3(ZOMBIE));
	checkEq(zombie.equipOutfit, -1, "um traje NAO possuido no equipDeco nao e vestido depois da migracao");
	checkEq(zombie.equipPet, -1, "nem vai parar no slot de pet");

	const json = SAVE.sanitizeStoredSave(JSON.parse(JSON.stringify(santa)));
	checkEq(json.equipOutfit, SANTA, "o v4 gravado (JSON) volta com o traje");
	checkEq(json.equipPet, -1, "e sem pet");

	// a v4 document never falls back to a stray legacy key: the new fields win
	const mixed = JSON.parse(JSON.stringify(santa));
	mixed.equipOutfit = COWBOY;
	mixed.equipPet = -1;
	mixed.equipDeco = EAGLE;
	const read = SAVE.sanitizeStoredSave(mixed);
	checkEq(read.equipOutfit, COWBOY, "um documento que ja fala v4 e lido como v4");
	checkEq(read.equipPet, -1, "e um equipDeco esquecido nele e ignorado");
}

section("13) rollback v4 -> v3 -> v4: esquece QUAL cosmetico estava vestido, nunca o que foi comprado");
{
	const v4 = SAVE.sanitizeStoredSave(productionV3(SANTA));
	v4.equipPet = EAGLE;
	SAVE.enforceSaveInvariants(v4);
	checkEq(v4.equipPet, EAGLE, "v4 com traje e pet ao mesmo tempo");
	const stored = JSON.parse(JSON.stringify(v4));
	// what a v3 server does with it: unknown keys dropped, and its own `equipDeco` read as missing (-1) and written
	const v3 = JSON.parse(JSON.stringify(stored));
	delete v3.equipOutfit;
	delete v3.equipPet;
	v3.equipDeco = -1;
	v3.version = 3;
	const back = SAVE.sanitizeStoredSave(v3);
	checkEq(back.equipOutfit, -1, "de volta ao v4: nenhum traje vestido");
	checkEq(back.equipPet, -1, "nenhum pet");
	checkArrayEq(back.costumes, v4.costumes, "mas todos os trajes comprados continuam comprados");
	checkArrayEq(back.invenEquip, v4.invenEquip, "e o inventario (pets de pacote) intacto");
	check(SAVE.ownsCosmetic(back, SANTA) && SAVE.ownsCosmetic(back, EAGLE), "e os dois continuam vestiveis");
	assertSameAsV2(productionV3(SANTA), back, "e todo o resto igual");
}

section("14) posse no servidor: o cliente nunca declara o que possui");
{
	const base = SAVE.defaultSave();
	base.money = 500;
	const forged = JSON.parse(JSON.stringify(base));
	forged.equipOutfit = SANTA;
	forged.equipPet = EAGLE;
	forged.costumes = forged.costumes.map(() => 1);
	const upd = SAVE.sanitizeClientReport(forged, base);
	checkEq(upd.equipOutfit, -1, "relatorio vestindo um traje nao comprado -> corrigido para nenhum");
	checkEq(upd.equipPet, -1, "relatorio com um pet nao comprado -> nenhum");
	check(
		upd.costumes.every(v => v === 0),
		"e o `costumes` forjado no relatorio e ignorado (e do servidor)",
	);

	// owned, but in the wrong slot
	const owner = SAVE.defaultSave();
	owner.costumes[costumeOf("Eagle")] = 1;
	owner.costumes[costumeOf("Cowboy")] = 1;
	const wrong = JSON.parse(JSON.stringify(owner));
	wrong.equipOutfit = EAGLE;
	wrong.equipPet = COWBOY;
	const w = SAVE.sanitizeClientReport(wrong, owner);
	checkEq(w.equipOutfit, -1, "um pet no slot de traje nao e aceito");
	checkEq(w.equipPet, -1, "nem um traje no slot de pet");
	const right = JSON.parse(JSON.stringify(owner));
	right.equipOutfit = COWBOY;
	right.equipPet = EAGLE;
	const ok = SAVE.sanitizeClientReport(right, owner);
	checkEq(ok.equipOutfit, COWBOY, "o traje comprado e aceito");
	checkEq(ok.equipPet, EAGLE, "e o pet comprado tambem -- os dois ao mesmo tempo");

	// the pack path: a pigeon in the inventory only exists if a pack the SERVER counted delivered it
	const smuggle = JSON.parse(JSON.stringify(base));
	smuggle.invenEquip[PIGEON] = 1;
	smuggle.equipPet = PIGEON;
	const s = SAVE.sanitizeClientReport(smuggle, base);
	checkEq(s.invenEquip[PIGEON], 0, "um pombo que nenhum pacote entregou nao entra no inventario");
	checkEq(s.equipPet, -1, "e portanto nao e vestido");
	const pigeonPack = SHOP_PACKS.find(p => p.items.some(it => it.index === PIGEON && it.kind === 2));
	check(pigeonPack !== undefined, "existe um pacote que entrega o Pigeon");
	const bought = SAVE.defaultSave();
	bought.packsBought[pigeonPack.id] = 1;
	const opened = JSON.parse(JSON.stringify(bought));
	opened.packsOpened[pigeonPack.id] = 1;
	opened.invenEquip[PIGEON] = 1;
	opened.equipPet = PIGEON;
	const o = SAVE.sanitizeClientReport(opened, bought);
	checkEq(o.equipPet, PIGEON, "com o pacote comprado (servidor) e aberto, o pombo pode ser vestido");

	// what goes on the wire asks ownership again, even of a live table somebody wrote into directly
	const raw = SAVE.defaultSave();
	raw.equipOutfit = SANTA;
	raw.equipPet = EAGLE;
	checkEq(SAVE.outfitLookOf(raw), COS.OutfitLook.None, "outfitLookOf nao desenha um traje nao possuido");
	checkEq(SAVE.petLookOf(raw), COS.PetLook.None, "petLookOf nao desenha um pet nao possuido");
	raw.costumes[costumeOf("Santa")] = 1;
	raw.costumes[costumeOf("Eagle")] = 1;
	checkEq(SAVE.outfitLookOf(raw), COS.OutfitLook.Santa, "possuido: o traje e desenhado");
	checkEq(SAVE.petLookOf(raw), COS.PetLook.Eagle, "possuido: o pet e desenhado");

	// an admin taking a costume back takes it off
	raw.costumes[costumeOf("Santa")] = 0;
	SAVE.enforceSaveInvariants(raw);
	checkEq(raw.equipOutfit, -1, "trancar o traje (admin) tira ele do corpo");
	checkEq(raw.equipPet, EAGLE, "sem mexer no pet");
}

section("15) os dois slots: quem vai onde, equipar pelo servidor, e o New game");
{
	for (const c of COSTUMES) {
		const want = ["Santa", "Zombie", "Cowboy"].includes(c.name) ? EquipSlot.Outfit : EquipSlot.Pet;
		checkEq(
			SAVE.equipSlotOf(c.equipId),
			want,
			`${c.name} vai no slot ${want === EquipSlot.Outfit ? "Outfit" : "Pet"}`,
		);
	}
	const kind4 = EQUIPS.filter(e => e.kind === 4);
	check(
		kind4.every(e => SAVE.equipSlotOf(e.id) !== 0),
		"todo equipamento kind 4 tem um slot (nada vendido fica sem desenho)",
	);
	check(
		kind4.every(e => COS.outfitLookOfEquip(e.id) !== 0 || COS.petLookOfEquip(e.id) !== 0),
		"e todo kind 4 tem um visual (traje ou pet)",
	);

	const craft = new ServerCraft({ world: undefined, build: undefined });
	const save = SAVE.defaultSave();
	checkEq(craft.equip(save, SANTA).kind, "refused", "o servidor recusa vestir um traje nao possuido");
	checkEq(save.equipOutfit, -1, "e nada muda");
	save.costumes[costumeOf("Santa")] = 1;
	save.costumes[costumeOf("Eagle")] = 1;
	const e1 = craft.equip(save, SANTA);
	checkEq(e1.kind === "equipped" ? e1.slot : 0, EquipSlot.Outfit, "Santa vai para o slot 4 (Outfit)");
	const e2 = craft.equip(save, EAGLE);
	checkEq(e2.kind === "equipped" ? e2.slot : 0, EquipSlot.Pet, "Eagle vai para o slot 5 (Pet)");
	checkEq(save.equipOutfit, SANTA, "e o traje continua vestido: os dois ao mesmo tempo");
	checkEq(craft.unequip(save, EquipSlot.Pet).kind, "unequipped", "tirar o pet (slot 5)");
	checkEq(save.equipPet, -1, "o pet saiu");
	checkEq(save.equipOutfit, SANTA, "o traje ficou");
	checkEq(craft.unequip(save, 6).kind, "refused", "slot 6 nao existe");

	// New game: a costume is forever, a pack's pigeon lived in the inventory the starter kit replaces
	const run = SAVE.defaultSave();
	run.costumes[costumeOf("Santa")] = 1;
	run.invenEquip[PIGEON] = 1;
	run.equipOutfit = SANTA;
	run.equipPet = PIGEON;
	SAVE.resetRun(run);
	checkEq(run.equipOutfit, SANTA, "New game mantem o traje comprado");
	checkEq(run.equipPet, -1, "e larga o pombo que veio num pacote (o inventario recomecou)");
}

section("16) MON-01: um cosmetico nao muda nada numa noite (defesa e velocidade)");
{
	const save = SAVE.defaultSave();
	const p = PLAYER.createPlayer(save, 0, 0);
	const def0 = PLAYER.playerEquipDefence(save);
	const speed0 = PLAYER.recalcMoveSpeed(p, save);
	save.costumes = save.costumes.map(() => 1);
	save.equipOutfit = COWBOY;
	save.equipPet = EAGLE;
	// even a data row that forgot MON-01 must not leak into the numbers
	const cowboy = EQUIPS[COWBOY];
	const was = { def: cowboy.def, speed: cowboy.speed };
	cowboy.def = 5;
	cowboy.speed = 3;
	checkEq(PLAYER.playerEquipDefence(save), def0, "traje + pet: defesa igual");
	checkEq(PLAYER.recalcMoveSpeed(p, save), speed0, "traje + pet: velocidade igual");
	cowboy.def = was.def;
	cowboy.speed = was.speed;
}

section("17) o guarda-roupa: so o servidor transforma moedas em traje (server/save/costumes.ts, MON-04)");
{
	const { buyCostume } = require(join(SRC, "server/save/costumes.ts"));
	const santa = costumeOf("Santa");
	const eagle = costumeOf("Eagle");
	const PRICE = COSTUMES[santa].price;
	const snapshot = s => JSON.stringify({ money: s.money, costumes: s.costumes, equipOutfit: s.equipOutfit });

	// unknown ids: nothing is read from the catalogue, nothing moves
	const rich = SAVE.defaultSave();
	rich.money = 1000;
	const before = snapshot(rich);
	const junk = [COSTUMES.length, 99, -1, 1.5, NaN, Infinity, -Infinity, "6", undefined, null, {}, [6], true];
	const refusals = junk.map(id => buyCostume(rich, id));
	check(
		refusals.every(r => r.ok === false && r.reason === "invalid"),
		"id desconhecido (fora do catalogo, negativo, fracao, NaN, infinito, texto, tabela) -> recusado como invalid",
		refusals
			.filter(r => r.ok !== false || r.reason !== "invalid")
			.map(r => JSON.stringify(r))
			.join(" ") || `${junk.length} ids`,
	);
	checkEq(snapshot(rich), before, "e o save nao mudou nada (moedas, trajes)");

	// not enough coins
	const poor = SAVE.defaultSave();
	poor.money = PRICE - 1;
	const funds = buyCostume(poor, santa);
	checkEq(
		funds.ok === false ? funds.reason : "ok",
		"funds",
		`moedas insuficientes (${PRICE - 1} < ${PRICE}) -> funds`,
	);
	checkEq(poor.money, PRICE - 1, "nenhuma moeda sai");
	checkEq(poor.costumes[santa], 0, "e o traje continua bloqueado");

	// a successful purchase: the catalogue price, exactly, and the costume is theirs
	const buyer = SAVE.defaultSave();
	buyer.money = 100;
	checkEq(
		new ServerCraft({ world: undefined, build: undefined }).equip(buyer, SANTA).kind,
		"refused",
		"antes da compra o servidor recusa vestir o Santa",
	);
	const bought = buyCostume(buyer, santa);
	check(bought.ok === true && bought.price === PRICE, "compra aceita, ao preco do catalogo", JSON.stringify(bought));
	checkEq(buyer.money, 100 - PRICE, "desconta exatamente o preco");
	checkEq(buyer.costumes[santa], 1, "e o traje passa a ser dele (costumes)");
	check(SAVE.ownsCostume(buyer, santa) && SAVE.ownsEquip(buyer, SANTA), "ownsCostume / ownsEquip dizem que e dele");
	checkEq(buyer.costumes[eagle], 0, "so aquele traje: os outros continuam bloqueados");

	// already owned: a double click or a replayed request never charges twice
	const again = buyCostume(buyer, santa);
	checkEq(again.ok === false ? again.reason : "ok", "owned", "comprar de novo -> owned");
	checkEq(buyer.money, 100 - PRICE, "e nada e cobrado de novo");

	// the exact amount is enough, and the balance can reach zero, never below
	const exact = SAVE.defaultSave();
	exact.money = COSTUMES[eagle].price;
	check(buyCostume(exact, eagle).ok === true && exact.money === 0, "com o valor exato compra e fica com 0");

	// a catalogue row that does not resolve to a drawable cosmetic is not sold (MON-04: bought = drawn)
	const row = COSTUMES[santa];
	const was = row.equipId;
	row.equipId = -1;
	const broken = SAVE.defaultSave();
	broken.money = 1000;
	const orphan = buyCostume(broken, santa);
	row.equipId = was;
	check(
		orphan.ok === false && orphan.reason === "invalid" && broken.money === 1000,
		"traje sem cosmetico desenhavel nao e vendido",
	);

	// wearing what was bought, and nothing else, on both server paths
	const craft = new ServerCraft({ world: undefined, build: undefined });
	checkEq(
		craft.equip(buyer, SANTA).kind,
		"equipped",
		"depois da compra o servidor aceita vestir o Santa (intent Equip)",
	);
	checkEq(craft.equip(buyer, EAGLE).kind, "refused", "mas nao a Eagle, que nao foi comprada");
	checkEq(buyer.equipPet, -1, "e o slot do pet fica vazio");
	const report = JSON.parse(JSON.stringify(buyer));
	report.equipOutfit = SANTA;
	report.equipPet = EAGLE;
	report.money = 99999;
	report.costumes = report.costumes.map(() => 1);
	const upd = SAVE.sanitizeClientReport(report, buyer);
	checkEq(upd.equipOutfit, SANTA, "relatorio vestindo o traje comprado: aceito");
	checkEq(upd.equipPet, -1, "relatorio vestindo um pet nao comprado: corrigido para nenhum");
	checkEq(upd.money, buyer.money, "e as moedas do relatorio sao ignoradas");
	checkEq(upd.costumes[eagle], 0, "assim como os trajes que o relatorio diz ter");

	// the wiring: handleAction hands the raw id to buyCostume and never reads a price from the request
	const main = readFileSync(join(SRC, "server/main.server.ts"), "utf8");
	const branch = main.slice(main.indexOf('req.kind === "buyCostume"'), main.indexOf('req.kind === "rebirth"'));
	check(
		/buyCostume\(save, req\.costumeId\)/.test(branch) && !/req\.price|COSTUMES\[/.test(branch),
		"main.server.ts: o pedido buyCostume vai inteiro para buyCostume(save, req.costumeId), sem ler preco do cliente",
	);
}

// ---------------------------------------------------------------- verdict

console.log("");
if (failures > 0) {
	console.log(`${failures} de ${checks} verificacao(oes) falharam`);
	process.exit(1);
}
console.log(`${checks} verificacoes, 0 falhas`);
