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
 * 2. THE COINS. Since F2 pinned `day` and `bossKills` in the client report (`stripClientProgress`), the
 *    payment in server/main.server.ts — which only fired when a report MOVED those fields — became
 *    unreachable, and a day survived silently paid nothing. The fix moves the payment next to the event, so
 *    the test pins the behaviour that was missing: a day pays once, a milestone pays once ever, an assisted
 *    run pays nothing, a run at DAY_MAX pays nothing, and a boss pays its coins too.
 *
 * Pure Node (>= 18) + the project's TypeScript, through tools/luau-shim.mjs.
 */
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
const PROG = require(join(SRC, "server/sim/progress.ts"));
const { ServerSimulation } = require(join(SRC, "server/sim/simulation.ts"));
const { WorldClock } = require(join(SRC, "server/sim/waves.ts"));
const { createServerPlayer } = require(join(SRC, "server/sim/players.ts"));
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
	"equipDeco",
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
	checkEq(save.version, SAVE.SAVE_VERSION, "e sai como v3");
	checkEq(SAVE.SAVE_VERSION, 3, "SAVE_VERSION e 3");
	assertSameAsV2(doc, save, "nenhum campo v2 mudou de valor");
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
	checkEq(SAVE.storedVersion(stored), 3, "o documento gravado se declara v3");
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
	checkEq(save.version, 3, "e sobe direto para v3");
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

section("10) a meia-noite do mundo paga cada sobrevivente uma unica vez");
{
	const world = createWorld(4000, 4000);
	const clock = new WorldClock({ day: 3, dayTime: 23.9 });
	const sim = new ServerSimulation({ world, clock });
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
	// the clock is stepped directly: with no horde the simulation does not drive it, and what is under test
	// is the midnight hook, not the horde
	const dt = 1 / 60;
	for (let i = 0; i < 60 * 60; i++) clock.step(dt);
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
		clock.step(dt);
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
	const sim = new ServerSimulation({ world, clock });
	const save = SAVE.defaultSave();
	save.money = 0;
	sim.paysRewards = () => false;
	sim.add(createServerPlayer({ slot: 0, userId: 1, name: "admin-assisted" }, save, 100, 100, 0, 60));
	for (let i = 0; i < 60 * 60; i++) clock.step(1 / 60);
	checkEq(save.day, 2, "o dia passou");
	checkEq(save.money, 0, "e nao pagou nada");
}

// ---------------------------------------------------------------- verdict

console.log("");
if (failures > 0) {
	console.log(`${failures} de ${checks} verificacao(oes) falharam`);
	process.exit(1);
}
console.log(`${checks} verificacoes, 0 falhas`);
