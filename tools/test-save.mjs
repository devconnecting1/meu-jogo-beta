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
 *    v5 (MON-05) adds the titles: `titles` and `zombieKills` (server-owned, earned) and `equipTitle` (the one shown).
 *    A v4 document becomes v5 with nothing earned and nothing else changed; a rollback to v4 code forgets only WHICH
 *    title was shown, because what was earned comes back from the title record (server/save/titleRecord.ts); what
 *    was earned survives a death, a New game and the end of a world; and nobody but the server grants a title or
 *    moves the kill count -- neither a report nor the wardrobe's equip request (server/save/titles.ts). The record
 *    never undoes a reset or a deletion made on purpose: `titleEpoch` says which title history a save is, and a
 *    record of an older one is never merged back.
 *
 *    v7 (MON-05, section 34) adds `titleStats`, the counters only titles read: a v6 document becomes v7 with every
 *    counter at 0 and nothing else changed, junk is read defensively (a set of bits never past its own bits), a report
 *    can never move them, a wallet only raises them, and the documented cost of a rollback to v6 (the titles past the
 *    first three) is pinned -- with the kill titles coming back at the next kill.
 *
 * 2. THE COINS. Since F2 pinned `day` and `bossKills` in the client report (`stripClientProgress`), the
 *    payment in server/main.server.ts — which only fired when a report MOVED those fields — became
 *    unreachable, and a day survived silently paid nothing. The fix moves the payment next to the event, so
 *    the test pins the behaviour that was missing: a day pays once, a milestone pays once ever, an assisted
 *    run pays nothing, a run at DAY_MAX pays nothing, and a boss pays its coins too.
 *
 * Pure Node (>= 18) + the project's TypeScript, through tools/luau-shim.mjs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
	checkEq(SAVE.SAVE_VERSION, 7, "SAVE_VERSION e 7 (os contadores dos titulos, titleStats, MON-05)");
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

section('18) "Nao" ao tutorial desliga o tutorial inteiro, inclusive as licoes da partida (bug do dono, 2026-09-23)');
{
	// the lobby's "No" set only `tutorialDone`; the in-run coach (client/onboarding/index.ts) runs off
	// `firstInstall`, so the lessons appeared in the first match anyway
	const fresh = SAVE.defaultSave();
	check(fresh.firstInstall === true && fresh.tutorialDone === false, "um save novo ainda nao respondeu");
	SAVE.declineTutorial(fresh);
	check(fresh.tutorialDone === true, "declineTutorial: a pergunta foi respondida");
	check(fresh.firstInstall === false, "declineTutorial: o coach da primeira partida nao comeca");

	// the source: whoever answers "No" goes through declineTutorial, and only the "Yes" card (tutorial.ts) marks
	// the question answered by hand -- that path wants the coach, so it must leave `firstInstall` alone
	const { readdirSync, statSync } = await import("node:fs");
	const offenders = [];
	let callers = 0;
	(function walk(dir) {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (p.endsWith(".ts")) {
				const text = readFileSync(p, "utf8");
				if (/declineTutorial\(/.test(text)) callers++;
				if (/tutorialDone\s*=\s*true/.test(text) && !p.endsWith(join("ui", "tutorial.ts"))) offenders.push(p);
			}
		}
	})(join(SRC, "client"));
	check(callers > 0, "o cliente responde 'Nao' por declineTutorial");
	check(
		offenders.length === 0,
		"nenhum arquivo do cliente marca tutorialDone a mao fora do cartao do 'Sim'",
		offenders.join(", "),
	);
	const coachGate = readFileSync(join(SRC, "client/onboarding/index.ts"), "utf8");
	check(
		/if \(ctx\.save\.firstInstall\)/.test(coachGate),
		"o coach continua ligado a firstInstall (o que o 'Nao' desliga)",
	);
}

// ---------------------------------------------------------------- v5: titles (MON-05)

const TIT = require(join(SRC, "shared/data/titles.ts"));
const TITLES_N = TIT.TITLES.length;
const { equipTitle, grantTitle, creditZombieKill, creditLifeNight } = require(join(SRC, "server/save/titles.ts"));
// the title record's pure half; its module reaches the store names (server/save/stores.ts), which ask RunService
// whether this is Studio -- the one thing of Roblox it needs to load
globalThis.game ??= { GetService: () => ({ IsStudio: () => false }) };
const REC = require(join(SRC, "server/save/titleRecord.ts"));

/** the production save as a v4 server last wrote it: Santa worn, no v5 field at all */
function productionV4() {
	const v4 = JSON.parse(JSON.stringify(SAVE.sanitizeStoredSave(productionV3(SANTA))));
	delete v4.titles;
	delete v4.zombieKills;
	delete v4.equipTitle;
	delete v4.titleEpoch;
	delete v4.lifeNights;
	v4.version = 4;
	return v4;
}

section("19) migracao v4 -> v5: nada ganho, nada mostrado, e nenhum outro campo muda");
{
	const doc = productionV4();
	checkEq(SAVE.storedVersion(doc), 4, "o documento lido se declara v4");
	const save = SAVE.sanitizeStoredSave(doc);
	checkEq(save.version, SAVE.SAVE_VERSION, "e sai na versao atual");
	checkArrayEq(save.titles, new Array(TITLES_N).fill(0), "nenhum titulo: nenhum servidor contou nada antes do v5");
	checkEq(save.zombieKills, 0, "e nenhum abate contado");
	checkEq(save.lifeNights, 0, "nem noite creditada pelo servidor (Week One conta a partir do v5)");
	checkEq(save.equipTitle, -1, "e nenhum titulo mostrado");
	assertSameAsV2(productionV3(SANTA), save, "nenhum campo v2 mudou");
	check(save.equipOutfit === SANTA && save.runHp === 60, "nem os do v3 e do v4 (corpo da run, traje vestido)");

	// the v5 document round trip: what was earned and what is shown come back as they went
	save.titles[TIT.TitleId.Survivor] = 1;
	save.titles[TIT.TitleId.WeekOne] = 1;
	save.zombieKills = 37;
	save.equipTitle = TIT.TitleId.WeekOne;
	const again = SAVE.sanitizeStoredSave(JSON.parse(JSON.stringify(save)));
	checkArrayEq(again.titles, save.titles, "o v5 gravado (JSON) volta com os titulos");
	checkEq(again.zombieKills, 37, "com a contagem de abates");
	checkEq(again.equipTitle, TIT.TitleId.WeekOne, "e com o titulo mostrado");

	// a document with junk in the new fields is read defensively
	const junk = JSON.parse(JSON.stringify(save));
	// (one entry per title, and two past the end of the table: the excess falls)
	junk.titles = [5, "x", -1, ...new Array(TITLES_N - 3).fill(1), 1, 1];
	junk.zombieKills = -40;
	junk.equipTitle = TIT.TitleId.HordeBreaker;
	const read = SAVE.sanitizeStoredSave(junk);
	checkArrayEq(read.titles, [1, 0, 0, ...new Array(TITLES_N - 3).fill(1)], "titulos lixo viram 0/1 e o excesso cai");
	checkEq(read.zombieKills, 0, "abates negativos viram 0");
	checkEq(read.equipTitle, -1, "e um titulo mostrado que nao foi ganho e tirado");
}

section("20) rollback v5 -> v4 -> v5: esquece QUAL titulo estava mostrado, nunca um titulo ou um abate");
{
	const v5 = SAVE.sanitizeStoredSave(productionV4());
	v5.titles[TIT.TitleId.Survivor] = 1;
	v5.titles[TIT.TitleId.HordeBreaker] = 1;
	v5.zombieKills = 120;
	v5.equipTitle = TIT.TitleId.HordeBreaker;
	// what a v5 session keeps in the second document (server/save/titleRecord.ts), as the DataStore returns it
	const record = JSON.parse(JSON.stringify(REC.nextTitleRecord(undefined, REC.titleRecordOf(v5), "replace")));
	// what a v4 server does with the save: the three unknown keys dropped, and that is what it writes
	const v4 = JSON.parse(JSON.stringify(v5));
	delete v4.titles;
	delete v4.zombieKills;
	delete v4.equipTitle;
	delete v4.titleEpoch;
	delete v4.lifeNights;
	v4.version = 4;
	const back = SAVE.sanitizeStoredSave(v4);
	checkEq(back.zombieKills, 0, "o save que o v4 escreveu nao tem mais nada ganho (o risco)");
	check(REC.mergeTitleRecord(back, REC.readTitleRecord(record)), "a carga v5 traz de volta o registro de titulos");
	checkArrayEq(back.titles, v5.titles, "todos os titulos ganhos voltaram");
	checkEq(back.zombieKills, 120, "e a contagem de abates");
	checkEq(back.equipTitle, -1, "so o titulo MOSTRADO foi esquecido (um clique no guarda-roupa)");
	assertSameAsV2(productionV3(SANTA), back, "e todo o resto igual");
	check(back.equipOutfit === SANTA, "inclusive o traje vestido");

	// the record never takes anything away, and a merge-write keeps the larger of the two
	const ahead = SAVE.sanitizeStoredSave(productionV4());
	ahead.zombieKills = 200;
	ahead.titles[TIT.TitleId.WeekOne] = 1;
	check(REC.mergeTitleRecord(ahead, REC.readTitleRecord(record)), "mesclar traz os titulos que o save nao tinha");
	checkEq(ahead.titles[TIT.TitleId.HordeBreaker], 1, "(Horde Breaker, do registro)");
	checkEq(ahead.zombieKills, 200, "mas nunca abaixa: a contagem maior fica");
	checkEq(ahead.titles[TIT.TitleId.WeekOne], 1, "e o titulo que o registro nao tinha tambem");
	const merged = REC.nextTitleRecord(record, REC.titleRecordOf(SAVE.sanitizeStoredSave(productionV4())), "merge");
	checkEq(merged.zombieKills, 120, "gravar sem ter lido o registro MESCLA: nada que ele tinha se perde");
	checkEq(merged.titles[TIT.TitleId.HordeBreaker], 1, "nem um titulo");
	const replaced = REC.nextTitleRecord(record, REC.titleRecordOf(SAVE.sanitizeStoredSave(productionV4())), "replace");
	checkEq(replaced.zombieKills, 0, "quem leu o registro o SUBSTITUI (um reset do admin o baixa)");
	checkEq(REC.readTitleRecord("lixo"), undefined, "um registro que nao e tabela e ignorado");
	checkEq(
		REC.readTitleRecord({ titles: [9], zombieKills: 1e12 }).zombieKills,
		SAVE.SAVE_LIMITS.COUNTER_MAX,
		"e com teto",
	);
}

section("21) o que foi ganho atravessa a morte, o New game e o fim do mundo (MP-21, MP-22)");
{
	const LIFE = require(join(SRC, "server/sim/life.ts"));
	const save = SAVE.defaultSave();
	for (let i = 0; i < TITLES_N; i++) save.titles[i] = 1;
	save.zombieKills = 150;
	save.lifeNights = 8;
	save.equipTitle = TIT.TitleId.WeekOne;
	save.day = 9;
	// death: the server writes the body into the save (server/sim/life.ts `writeRunBody`)
	const body = PLAYER.createPlayer(save, 0, 0);
	body.dead = true;
	body.hp = 0;
	LIFE.writeRunBody(save, body);
	check(save.runOver, "a morte foi escrita no save");
	check(save.titles.every(v => v === 1) && save.zombieKills === 150, "a morte nao toca nos titulos nem nos abates");
	checkEq(save.equipTitle, TIT.TitleId.WeekOne, "nem no titulo mostrado");
	// New game, and the end of a world: both are `resetRun` (the newRun action; life.ts `restartWorld`)
	const lifeSrc = readFileSync(join(SRC, "server/sim/life.ts"), "utf8");
	const restart = lifeSrc.slice(lifeSrc.indexOf("restartWorld("));
	check(/resetRun\(save\)/.test(restart), "o fim do mundo (life.ts restartWorld) da a vida nova por resetRun");
	SAVE.resetRun(save);
	checkEq(save.day, 1, "New game: a vida volta ao dia 1");
	checkEq(save.lifeNights, 0, "e a contagem de noites da vida (Week One) volta a 0");
	check(
		save.titles.every(v => v === 1),
		"e os titulos ficam",
	);
	checkEq(save.zombieKills, 150, "e os abates");
	checkEq(save.equipTitle, TIT.TitleId.WeekOne, "e o titulo mostrado continua mostrado");
	const report = SAVE.sanitizeClientReport(JSON.parse(JSON.stringify(save)), save);
	check(report.titles.every(v => v === 1) && report.zombieKills === 150, "e o relatorio seguinte os mantem");
	const stored = SAVE.sanitizeStoredSave(JSON.parse(JSON.stringify(save)));
	check(stored.titles.every(v => v === 1) && stored.equipTitle === TIT.TitleId.WeekOne, "e o DataStore tambem");
}

section("22) so o servidor concede: nem o relatorio nem o pedido de equipar (server/save/titles.ts)");
{
	// a report declaring titles, kills and a title shown, on a survivor who earned nothing
	const base = SAVE.defaultSave();
	const forged = JSON.parse(JSON.stringify(base));
	forged.titles = new Array(TITLES_N).fill(1);
	forged.zombieKills = 999999;
	forged.lifeNights = 99;
	forged.equipTitle = TIT.TitleId.HordeBreaker;
	const upd = SAVE.sanitizeClientReport(forged, base);
	check(
		upd.titles.every(v => v === 0),
		"os titulos de um relatorio sao ignorados (sao do servidor)",
	);
	checkEq(upd.zombieKills, 0, "a contagem de abates tambem");
	checkEq(upd.lifeNights, 0, "e a de noites da vida");
	checkEq(upd.equipTitle, -1, "e o titulo mostrado nao ganho e corrigido para nenhum");
	checkEq(SAVE.titleWireOf(upd), 0, "e nada vai para o fio");
	// earned: the report may choose it, and nothing else
	const earned = SAVE.defaultSave();
	earned.titles[TIT.TitleId.Survivor] = 1;
	const pick = JSON.parse(JSON.stringify(earned));
	pick.equipTitle = TIT.TitleId.Survivor;
	checkEq(
		SAVE.sanitizeClientReport(pick, earned).equipTitle,
		TIT.TitleId.Survivor,
		"um titulo ganho pode ser escolhido",
	);
	pick.equipTitle = TIT.TitleId.WeekOne;
	checkEq(SAVE.sanitizeClientReport(pick, earned).equipTitle, -1, "um nao ganho, no mesmo relatorio, nao");

	// the server Equip path: the wardrobe's request, as handleAction hands it over
	const save = SAVE.defaultSave();
	const refused = equipTitle(save, TIT.TitleId.HordeBreaker);
	check(
		refused.ok === false && refused.reason === "invalid",
		"equipar um titulo nao ganho pelo servidor -> recusado",
	);
	checkEq(save.equipTitle, -1, "e o save nao muda");
	const junk = [TITLES_N, 99, -2, 1.5, NaN, Infinity, "1", undefined, null, {}, [1], true];
	check(
		junk.every(id => equipTitle(save, id).ok === false) && save.equipTitle === -1,
		"id desconhecido (fora da tabela, fracao, NaN, texto, tabela) -> recusado, nada muda",
	);
	checkEq(grantTitle(save, TIT.TitleId.HordeBreaker), true, "o servidor concede (a primeira vez)");
	checkEq(grantTitle(save, TIT.TitleId.HordeBreaker), false, "e so uma vez: o aviso nunca se repete");
	check(equipTitle(save, TIT.TitleId.HordeBreaker).ok, "ganho, o pedido de equipar e aceito");
	checkEq(SAVE.titleWireOf(save), TIT.titleToWire(TIT.TitleId.HordeBreaker), "e o fio leva o titulo");
	check(equipTitle(save, -1).ok && save.equipTitle === -1, "-1 tira o titulo");
	checkEq(SAVE.titleWireOf(save), 0, "e o fio leva nenhum");

	// the kill count: only `creditZombieKill` moves it, and Horde Breaker comes at the 100th
	// (v7: every credit answers the LIST of titles it unlocked -- one event may unlock two -- and an empty one otherwise)
	const killer = SAVE.defaultSave();
	let unlocked = [];
	for (let i = 0; i < TIT.HORDE_BREAKER_KILLS - 1; i++) unlocked.push(...creditZombieKill(killer));
	check(unlocked.length === 0 && !SAVE.ownsTitle(killer, TIT.TitleId.HordeBreaker), "99 abates: ainda nao");
	checkArrayEq([...creditZombieKill(killer)], [TIT.TitleId.HordeBreaker], "o 100o abate desbloqueia Horde Breaker");
	checkArrayEq([...creditZombieKill(killer)], [], "o 101o nao desbloqueia de novo");
	checkEq(killer.zombieKills, 101, "e a contagem segue");

	// Week One: the nights the server credited to the life, never the day the save says
	const life = SAVE.defaultSave();
	life.day = 30;
	unlocked = [];
	for (let i = 0; i < TIT.WEEK_ONE_NIGHTS - 1; i++) unlocked.push(...creditLifeNight(life));
	check(
		unlocked.length === 0 && !SAVE.ownsTitle(life, TIT.TitleId.WeekOne),
		"dia 30 no save e 6 noites creditadas: ainda nao",
	);
	checkArrayEq([...creditLifeNight(life)], [TIT.TitleId.WeekOne], "a 7a noite creditada desbloqueia Week One");
	checkArrayEq([...creditLifeNight(life)], [], "a 8a nao desbloqueia de novo");

	// the wallet carries both halves to the client, and no copy shows a title its save does not hold
	killer.equipTitle = TIT.TitleId.HordeBreaker;
	const wallet = SAVE.walletOf(killer);
	checkEq(wallet.zombieKills, 101, "a carteira leva a contagem de abates");
	checkEq(wallet.titles[TIT.TitleId.HordeBreaker], 1, "e os titulos ganhos");
	const client = SAVE.defaultSave();
	client.equipTitle = TIT.TitleId.WeekOne;
	SAVE.applyWallet(client, wallet);
	check(SAVE.ownsTitle(client, TIT.TitleId.HordeBreaker) && client.zombieKills === 101, "a copia do cliente espelha");
	checkEq(client.equipTitle, -1, "e deixa de mostrar um titulo que o servidor nao lista");
	// the life's day and its credited nights: the server's (the HUD's life day, the wardrobe's Week One progress)
	const alive = SAVE.defaultSave();
	alive.day = 8;
	alive.lifeNights = 2;
	const lifeWallet = SAVE.walletOf(alive);
	check(lifeWallet.day === 8 && lifeWallet.lifeNights === 2, "a carteira leva o dia da vida e as noites creditadas");
	const mirror = SAVE.defaultSave();
	mirror.day = 9;
	SAVE.applyWallet(mirror, lifeWallet);
	check(mirror.day === 8 && mirror.lifeNights === 2, "e a copia do cliente fica com os do servidor");
	const olderServer = { ...lifeWallet };
	delete olderServer.day;
	delete olderServer.lifeNights;
	SAVE.applyWallet(mirror, olderServer);
	check(mirror.day === 8 && mirror.lifeNights === 2, "uma carteira sem eles (servidor antigo) nao os mexe");
	// a wallet of an OLDER life, landing after the new one (a push and a ShopAction reply travel on different
	// remotes): it may not hand the old life's day back
	const newLife = SAVE.defaultSave();
	newLife.runRev = 5;
	newLife.day = 1;
	newLife.lifeNights = 0;
	const oldLife = SAVE.walletOf(alive);
	oldLife.runRev = 4;
	SAVE.applyWallet(newLife, oldLife);
	check(
		newLife.day === 1 && newLife.lifeNights === 0 && newLife.runRev === 5,
		"uma carteira de uma vida ANTERIOR (runRev menor) nao devolve o dia nem as noites dela",
		`day ${newLife.day}, nights ${newLife.lifeNights}, runRev ${newLife.runRev}`,
	);
	const sameLife = SAVE.walletOf(alive);
	sameLife.runRev = 5;
	SAVE.applyWallet(newLife, sameLife);
	check(newLife.day === 8 && newLife.lifeNights === 2, "uma da mesma vida, sim");
	const later = SAVE.walletOf(alive);
	later.runRev = 6;
	later.day = 1;
	later.lifeNights = 0;
	SAVE.applyWallet(newLife, later);
	check(
		newLife.day === 1 && newLife.lifeNights === 0 && newLife.runRev === 6,
		"e uma de uma vida mais NOVA (New game no servidor) tambem",
	);
	killer.titles[TIT.TitleId.HordeBreaker] = 0;
	SAVE.enforceSaveInvariants(killer);
	checkEq(killer.equipTitle, -1, "um save que nao tem o titulo (documento editado a mao) nao o mostra");

	// the wiring: handleAction hands the raw id to equipTitle and nothing else
	const main = readFileSync(join(SRC, "server/main.server.ts"), "utf8");
	const branch = main.slice(main.indexOf('req.kind === "equipTitle"'), main.indexOf('req.kind === "rebirth"'));
	check(
		/equipTitle\(save, req\.titleId\)/.test(branch) && !/titles\[/.test(branch),
		"main.server.ts: o pedido equipTitle vai inteiro para equipTitle(save, req.titleId), sem escrever titulos",
	);
}

section(
	"23) a epoca do registro: um reset ou uma exclusao de proposito nunca voltam dele (server/save/titleRecord.ts)",
);
{
	const E1 = 1_700_000_000;
	const E2 = E1 + 3600;
	const earned = () => {
		const save = SAVE.sanitizeStoredSave(productionV4());
		save.titleEpoch = E1;
		save.titles[TIT.TitleId.HordeBreaker] = 1;
		save.zombieKills = 100;
		return save;
	};
	checkEq(SAVE.sanitizeStoredSave(productionV4()).titleEpoch, 0, "um save vindo do v4 tem epoca 0");
	checkEq(
		SAVE.sanitizeStoredSave(JSON.parse(JSON.stringify(earned()))).titleEpoch,
		E1,
		"o v5 gravado volta com a epoca",
	);
	const forged = JSON.parse(JSON.stringify(earned()));
	forged.titleEpoch = E2 * 10;
	checkEq(SAVE.sanitizeClientReport(forged, earned()).titleEpoch, E1, "o relatorio do cliente nao move a epoca");
	const record = JSON.parse(JSON.stringify(REC.titleRecordOf(earned())));
	checkEq(REC.readTitleRecord(record).epoch, E1, "o registro guarda a epoca do save que espelha");
	checkEq(REC.readTitleRecord({ titles: [1], epoch: "x" }).epoch, 0, "uma epoca lixo vira 0");
	checkEq(REC.readTitleRecord({ epoch: 1e15 }).epoch, SAVE.SAVE_LIMITS.EPOCH_MAX, "e com teto");

	// the rollback still restores: v4 dropped the epoch with the titles, the record is of a later history
	const back = SAVE.sanitizeStoredSave(productionV4());
	check(REC.mergeTitleRecord(back, REC.readTitleRecord(record)), "rollback (save de epoca 0): o registro volta");
	check(back.zombieKills === 100 && back.titleEpoch === E1, "com os abates, e o save volta a historia do registro");

	// an admin reset: a later epoch; the old record never flows back into it
	const reset = SAVE.defaultSave();
	reset.titleEpoch = E2;
	check(
		!REC.mergeTitleRecord(reset, REC.readTitleRecord(record)),
		"reset (epoca maior): o registro antigo nao e mesclado",
	);
	check(reset.zombieKills === 0 && reset.titles.every(v => v === 0) && reset.titleEpoch === E2, "e nada muda");
	const over = REC.nextTitleRecord(record, REC.titleRecordOf(reset), "merge");
	check(
		over.zombieKills === 0 && over.titles.every(v => v === 0) && over.epoch === E2,
		"gravar MESCLANDO sobre um registro de epoca menor o substitui",
		JSON.stringify(over),
	);
	// the session that could not read a later record (after a rollback) merges into it and joins its history
	const lost = SAVE.sanitizeStoredSave(productionV4());
	const joined = REC.nextTitleRecord(record, REC.titleRecordOf(lost), "merge");
	check(joined.zombieKills === 100 && joined.epoch === E1, "mesclar sobre um registro de epoca maior o mantem");
	// a server that lost the lock without knowing it (it read the record at its load: "replace") never writes over a
	// reset made where the lock went
	const resetRecord = JSON.parse(JSON.stringify(REC.titleRecordOf(reset)));
	const stale = REC.nextTitleRecord(resetRecord, REC.titleRecordOf(earned()), "replace");
	check(
		stale.epoch === E2 && stale.zombieKills === 0 && stale.titles.every(v => v === 0),
		"substituir sobre um registro de historia POSTERIOR o deixa como esta",
		JSON.stringify(stale),
	);
	// a new history (missing save, admin reset) over a record stamped later than this server's clock: one after it
	const early = SAVE.defaultSave();
	early.titleEpoch = E1 - 50;
	const restarted = REC.nextTitleRecord(resetRecord, REC.titleRecordOf(early), "restart");
	check(
		restarted.epoch === E2 + 1 && restarted.zombieKills === 0,
		"recomecar sobre um registro de epoca igual ou maior carimba a seguinte (o save a adota)",
		JSON.stringify(restarted),
	);
	check(REC.mergeTitleRecord(early, restarted) && early.titleEpoch === E2 + 1, "…e o save adota essa epoca");
	check(
		REC.nextTitleRecord(record, REC.titleRecordOf(reset), "restart").epoch === E2,
		"recomecar sobre um registro mais antigo: a epoca do proprio save",
	);

	// what starts a new history: taking away anything earned (the admin reset does)
	const e = earned();
	check(!REC.lowersEarned(e, earned()), "nada tirado: a mesma historia");
	const fewer = earned();
	fewer.zombieKills = 99;
	check(REC.lowersEarned(e, fewer), "menos abates: outra historia");
	const noFlag = earned();
	noFlag.titles[TIT.TitleId.HordeBreaker] = 0;
	check(REC.lowersEarned(e, noFlag), "um titulo a menos: outra historia");
	check(REC.lowersEarned(e, SAVE.defaultSave()), "um save novo: outra historia");

	// the wiring: a missing save and an admin reset each start a history; only the server writes the epoch
	const main = readFileSync(join(SRC, "server/main.server.ts"), "utf8");
	const load = main.slice(main.indexOf("function loadSession("), main.indexOf("function newSession("));
	check(
		/status === "new"/.test(load) &&
			/save\.titleEpoch = /.test(load) &&
			/titleReplace = !read\.ok \|\| record !== undefined/.test(load),
		"main.server.ts loadSession: um save que falta comeca uma historia nova e substitui o registro",
	);
	const edit = main.slice(main.indexOf("function adminEdit("), main.indexOf("admin = startAdminServer("));
	check(
		/ops === undefined \|\| TitleRecord\.lowersEarned\(before, edited\)/.test(edit) &&
			/s\.titleReplace = true/.test(edit),
		"main.server.ts adminEdit: um reset comeca uma historia nova e substitui o registro",
	);
}

section("24) o registro custa uma escrita so quando importa: titulo, historia nova, degrau de abates, saida");
{
	const E = 1_700_000_000;
	const save = SAVE.defaultSave();
	save.titleEpoch = E;
	const empty = REC.emptyTitleRecord(E);
	const mark = REC.titleRecordMark(empty);
	const step = REC.titleRecordStep(empty);
	const due = (final, known = [mark, step], replace = false) =>
		REC.titleRecordDue(save, known[0], known[1], replace, final);
	check(!due(false) && !due(true), "nada ganho: nenhuma escrita, nem no autosave nem na saida");
	check(!due(true, [undefined, undefined]), "nem num registro que a carga nao leu (nada a acrescentar)");
	check(due(true, [undefined, undefined], true), "mas uma historia nova substitui mesmo sem nada ganho");
	const autosaves = [];
	let known = [mark, step];
	for (let k = 1; k <= 25; k++) {
		save.zombieKills = k;
		if (!due(false, known)) continue;
		autosaves.push(k);
		const written = REC.titleRecordOf(save);
		known = [REC.titleRecordMark(written), REC.titleRecordStep(written)];
	}
	checkArrayEq(
		autosaves,
		[10, 20],
		`o autosave so escreve a cada ${REC.TITLE_RECORD_KILL_STEP} abates (1..25 sem gravar)`,
	);
	save.zombieKills = 3;
	check(!due(false) && due(true), "3 abates: nao no autosave, sim na saida (exato)");
	save.zombieKills = 0;
	save.titles[TIT.TitleId.Survivor] = 1;
	check(due(false), "um titulo ganho escreve no primeiro autosave");
	save.titles[TIT.TitleId.Survivor] = 0;
	save.titleEpoch = E + 1;
	check(due(false), "e uma historia nova (reset) tambem");
	save.titleEpoch = E;
	// after a write, the session fingerprints what it wrote: the same save is not written again
	save.zombieKills = 10;
	const wrote = REC.titleRecordOf(save);
	const after = [REC.titleRecordMark(wrote), REC.titleRecordStep(wrote)];
	check(!due(false, after) && !due(true, after), "o que acabou de ser escrito nao e escrito de novo");
	save.zombieKills = 19;
	check(!due(false, after) && due(true, after), "19 abates depois de gravar 10: so na saida");

	const main = readFileSync(join(SRC, "server/main.server.ts"), "utf8");
	const flush = main.slice(
		main.indexOf("function flush("),
		main.indexOf("// ---------------------------------------------------------------- load"),
	);
	check(
		/if \(release && recordBeforeRelease\(\)\) syncTitleRecord\(s, true\)/.test(flush) &&
			/!release\) syncTitleRecord\(s, false\)/.test(flush),
		"main.server.ts flush: exato na saida (antes do save que solta a trava), por degraus no autosave",
	);
}

// ---------------------------------------------------------------- v6: achievements are the server's (CON-04)

const ACHV = require(join(SRC, "server/save/achievements.ts"));
const { CRAFT_RECIPES } = require(join(SRC, "shared/data/crafts.ts"));
const { AchievementId: AID } = require(join(SRC, "shared/data/achievements.ts"));
const { WeaponKind, ItemKind } = require(join(SRC, "shared/data/kinds.ts"));
const TITLESRV = require(join(SRC, "server/save/titles.ts"));

section("25) v6 (CON-04, ACH-2): um relatorio nao move conquista nenhuma, e a migracao v5 -> v6 nao perde nada");
{
	// a v5 document: counters the client used to report, and no lifeDeaths
	const v5 = JSON.parse(JSON.stringify(SAVE.sanitizeStoredSave(productionV4())));
	v5.version = 5;
	v5.achievements = ACHIEVEMENTS.map(a => Math.min(3, a.max));
	delete v5.lifeDeaths;
	const save = SAVE.sanitizeStoredSave(v5);
	checkEq(save.version, SAVE.SAVE_VERSION, "o v5 sobe para v6");
	checkArrayEq(
		save.achievements,
		v5.achievements,
		"os contadores gravados voltam como estavam (nada ganho se perde)",
	);
	checkEq(
		save.lifeDeaths,
		v5.deathCount > 0 || v5.runOver ? 1 : 0,
		"lifeDeaths ausente no v5: 1 se a vida ja morreu pelo que o documento sabe, 0 senao",
	);
	// a v5 life that already died must not start Never die again: a paid Rebirth (`deathCount`, where the old rule
	// stopped) or a body lying dead (`runOver`) is a death of this life. A death answered by waiting for daybreak left no
	// record in v5 -- that life counts again, as it did under the old rule
	const v5life = (deathCount, runOver) => {
		const doc = JSON.parse(JSON.stringify(v5));
		doc.deathCount = deathCount;
		doc.runOver = runOver;
		doc.lifeNights = 4;
		doc.achievements[AID.NeverDie] = 3;
		const migrated = SAVE.sanitizeStoredSave(doc);
		TITLESRV.creditLifeNight(migrated);
		return migrated;
	};
	for (const [what, deathCount, runOver] of [
		["um Rebirth pago (deathCount 2)", 2, false],
		["o corpo caido esperando (runOver)", 0, true],
	]) {
		const m = v5life(deathCount, runOver);
		check(
			m.lifeDeaths === 1 && m.achievements[AID.NeverDie] === 3,
			`v5 com ${what}: lifeDeaths 1, e a meia-noite seguinte nao move o Never die`,
			`lifeDeaths ${m.lifeDeaths}, Never die ${m.achievements[AID.NeverDie]}`,
		);
	}
	const clean = v5life(0, false);
	check(
		clean.lifeDeaths === 0 && clean.achievements[AID.NeverDie] === 5,
		"v5 sem morte registrada: lifeDeaths 0, e o Never die segue (5 noites nesta vida)",
		`lifeDeaths ${clean.lifeDeaths}, Never die ${clean.achievements[AID.NeverDie]}`,
	);
	const v6junk = JSON.parse(JSON.stringify(save));
	v6junk.lifeDeaths = 0;
	v6junk.deathCount = 3;
	checkEq(
		SAVE.sanitizeStoredSave(v6junk).lifeDeaths,
		0,
		"(um documento v6 guarda o proprio lifeDeaths: o deathCount so decide quando o campo falta)",
	);
	const junk = JSON.parse(JSON.stringify(save));
	junk.achievements = ACHIEVEMENTS.map(() => 1e9);
	junk.achievements[0] = -5;
	junk.lifeDeaths = "x";
	const read = SAVE.sanitizeStoredSave(junk);
	check(
		read.achievements.every((v, i) => v === (i === 0 ? 0 : ACHIEVEMENTS[i].max)),
		"um contador gravado com lixo fica entre 0 e a meta de cada linha",
	);
	checkEq(
		read.lifeDeaths,
		save.deathCount > 0 || save.runOver ? 1 : 0,
		"e lifeDeaths lixo cai na regra do campo ausente (nunca abaixo do que o documento sabe)",
	);

	// the report: every counter at its goal and a life with no death -- the server keeps its own
	const base = SAVE.sanitizeStoredSave(productionV4());
	base.lifeDeaths = 2;
	const forged = JSON.parse(JSON.stringify(base));
	forged.achievements = ACHIEVEMENTS.map(a => a.max);
	forged.lifeDeaths = 0;
	const upd = SAVE.sanitizeClientReport(forged, base);
	checkArrayEq(
		upd.achievements,
		base.achievements,
		"um relatorio com todas as conquistas completas nao muda nenhuma",
	);
	checkEq(upd.lifeDeaths, 2, "nem apaga as mortes desta vida");
	check(upd.achievements !== base.achievements, "(a copia do relatorio e outra tabela: a viva nao e tocada)");

	// the report path's own pin (server/main.server.ts processReport, beside stripClientProgress / stripClientLife):
	// even a report that got past the sanitizer with forged counters -- a regression there -- is put back, titles too
	const bypass = JSON.parse(JSON.stringify(base));
	bypass.achievements = ACHIEVEMENTS.map(a => a.max);
	bypass.titles = bypass.titles.map(() => 1);
	bypass.lifeDeaths = 0;
	check(
		ACHV.stripClientAchievements(base, bypass),
		"stripClientAchievements aponta o relatorio que tentou (sinal de relatorio velho, §9.3)",
	);
	check(
		JSON.stringify(bypass.achievements) === JSON.stringify(base.achievements) &&
			JSON.stringify(bypass.titles) === JSON.stringify(base.titles) &&
			bypass.lifeDeaths === 2,
		"...e devolve as conquistas, os titulos e as mortes desta vida do servidor",
	);
	check(
		bypass.achievements !== base.achievements && bypass.titles !== base.titles,
		"(copias: a tabela confiavel nao fica compartilhada com o relatorio)",
	);
	check(
		!ACHV.stripClientAchievements(base, SAVE.sanitizeClientReport(JSON.parse(JSON.stringify(base)), base)),
		"um relatorio que so espelha o servidor nao e apontado",
	);
	// the real path: the sanitizer has already put the trusted values into `upd`, so the claim is only visible in the
	// report as decoded -- that is what `processReport` hands over, and what makes the staleness signal work
	const claim = JSON.parse(JSON.stringify(base));
	claim.achievements = ACHIEVEMENTS.map(a => a.max);
	const sanitized = SAVE.sanitizeClientReport(claim, base);
	check(
		ACHV.stripClientAchievements(base, sanitized, claim),
		"...e o relatorio forjado que o sanitizador ja limpou E apontado, pelo relatorio decodificado (claimed)",
	);
	const mirror = JSON.parse(JSON.stringify(base));
	check(
		!ACHV.stripClientAchievements(base, SAVE.sanitizeClientReport(mirror, base), mirror) &&
			!ACHV.stripClientAchievements(base, SAVE.sanitizeClientReport({ day: base.day }, base), { day: base.day }),
		"...um espelho fiel nao e, nem um relatorio sem esses campos (cliente antigo)",
	);
	const titled = JSON.parse(JSON.stringify(base));
	titled.titles = titled.titles.map(() => 1);
	const dead = JSON.parse(JSON.stringify(base));
	dead.lifeDeaths = 0;
	check(
		ACHV.stripClientAchievements(base, SAVE.sanitizeClientReport(titled, base), titled) &&
			ACHV.stripClientAchievements(base, SAVE.sanitizeClientReport(dead, base), dead),
		"...e e apontado tambem o que so pede os titulos, e o que so apaga as mortes desta vida",
	);

	// the wallet carries them, and the client's copy only ever raises them
	const w = SAVE.walletOf(base);
	checkArrayEq(w.achievements, base.achievements, "a carteira leva os contadores do servidor");
	const client = SAVE.sanitizeStoredSave(productionV4());
	client.achievements.fill(0);
	const pushed = JSON.parse(JSON.stringify(w));
	pushed.achievements[AID.ZombieSlayer] = 42;
	SAVE.applyWallet(client, pushed);
	checkEq(client.achievements[AID.ZombieSlayer], 42, "o cliente adota o contador que o servidor empurrou");
	const stale = JSON.parse(JSON.stringify(pushed));
	stale.achievements[AID.ZombieSlayer] = 7;
	stale.achievements[AID.GoodDay] = 99;
	SAVE.applyWallet(client, stale);
	checkEq(client.achievements[AID.ZombieSlayer], 42, "uma carteira atrasada nao tira um contador");
	checkEq(client.achievements[AID.GoodDay], 1, "e um valor acima da meta fica na meta");
	const older = JSON.parse(JSON.stringify(w));
	delete older.achievements;
	SAVE.applyWallet(client, older);
	checkEq(
		client.achievements[AID.ZombieSlayer],
		42,
		"uma carteira de servidor antigo (sem o campo) nao mexe em nada",
	);
}

section("26) quem move cada conquista: so os eventos do servidor (server/save/achievements.ts)");
{
	const s = SAVE.defaultSave();
	ACHV.creditKillAchievements(s, 1, WeaponKind.Pistol);
	check(
		s.achievements[AID.ZombieSlayer] === 1 &&
			s.achievements[AID.SpecialZombieSlayer] === 0 &&
			s.achievements[AID.MeleeExpert] === 0,
		"um Walker a tiro: Zombie slayer",
	);
	ACHV.creditKillAchievements(s, 2, WeaponKind.Melee);
	check(
		s.achievements[AID.ZombieSlayer] === 2 &&
			s.achievements[AID.SpecialZombieSlayer] === 1 &&
			s.achievements[AID.MeleeExpert] === 1,
		"um Charger na faca: Zombie slayer, Special zombie slayer e Melee weapons expert",
	);
	ACHV.creditKillAchievements(s, 1, WeaponKind.Bow);
	ACHV.creditKillAchievements(s, 1, WeaponKind.Sniper);
	check(
		s.achievements[AID.BowExpert] === 1 &&
			s.achievements[AID.Sniper] === 1 &&
			s.achievements[AID.ZombieSlayer] === 4,
		"uma flecha e um tiro de sniper: Bow expert e Sniper (armas que funcionam, CON-03)",
	);
	ACHV.creditBossAchievement(s, 3);
	for (const bad of [0, 5, -1, 1.5, Number.NaN]) ACHV.creditBossAchievement(s, bad);
	check(
		s.achievements[AID.GiantSlayer] === 1 &&
			s.achievements[AID.CentipedeSlayer] === 0 &&
			s.achievements[AID.RafflesiaSlayer] === 0 &&
			s.achievements[AID.HedgehogSlayer] === 0,
		"o chefe do tipo 3 e o Giant slayer; um tipo fora de 1..4 nao move nada",
	);
	check(!ACHV.raiseAchievement(s, AID.Collector, 1), "e nenhuma linha desligada e creditada");
	checkEq(s.achievements[AID.Collector], 0, "(o contador salvo dela fica como estava)");
	s.achievements[AID.ZombieSlayer] = ACHIEVEMENTS[AID.ZombieSlayer].max - 1;
	check(ACHV.addAchievement(s, AID.ZombieSlayer, 1), "o abate que chega a meta completa a conquista");
	check(!ACHV.addAchievement(s, AID.ZombieSlayer, 1), "e o seguinte nao completa de novo");
	checkEq(s.achievements[AID.ZombieSlayer], ACHIEVEMENTS[AID.ZombieSlayer].max, "(nunca passa da meta)");
	check(
		!ACHV.addAchievement(s, AID.WoodsCollector, -3) &&
			!ACHV.addAchievement(s, AID.WoodsCollector, 0.5) &&
			!ACHV.raiseAchievement(s, AID.WoodsCollector, Number.NaN),
		"quantidade negativa, fracionaria ou NaN nao move nada",
	);

	// the nights: Good day, and Never die while this life has not died once
	const life = SAVE.defaultSave();
	TITLESRV.creditLifeNight(life);
	TITLESRV.creditLifeNight(life);
	check(
		life.achievements[AID.GoodDay] === 1 && life.achievements[AID.NeverDie] === 2,
		"duas meias-noites creditadas: Good day, e Never die em 2",
	);
	ACHV.countLifeDeath(life);
	checkEq(life.lifeDeaths, 1, "uma morte (qualquer uma: Rebirth, espera do amanhecer) conta para esta vida");
	TITLESRV.creditLifeNight(life);
	checkEq(life.achievements[AID.NeverDie], 2, "ACH-4: depois de uma morte, Never die para de contar nesta vida");
	life.deathCount = 0; // the old rule's test: only a paid Rebirth moved deathCount
	TITLESRV.creditLifeNight(life);
	checkEq(life.achievements[AID.NeverDie], 2, "...mesmo com deathCount 0 (a morte esperada ate o amanhecer)");
	SAVE.resetRun(life);
	checkEq(life.lifeDeaths, 0, "uma vida nova (New game, fim do mundo) comeca sem morte");
	checkEq(life.achievements[AID.NeverDie], 2, "e guarda o melhor Never die, como toda conquista");
	TITLESRV.creditLifeNight(life);
	TITLESRV.creditLifeNight(life);
	TITLESRV.creditLifeNight(life);
	checkEq(life.achievements[AID.NeverDie], 3, "a vida nova sobe o recorde quando o passa");

	// the rest: first steps, cooking and smelting (ITM-01's heat), wood
	const s2 = SAVE.defaultSave();
	ACHV.creditFirstSteps(s2);
	ACHV.creditFirstSteps(s2);
	checkEq(s2.achievements[AID.FirstSteps], 1, "First steps: o primeiro corpo na cidade");
	ACHV.creditCraft(s2, "cook", 2);
	ACHV.creditCraft(s2, "smelt", 1);
	ACHV.creditCraft(s2, undefined, 5);
	ACHV.creditCraft(s2, "cook", -4);
	const wood = ETC_ITEMS.findIndex(e => e.name === "Wood");
	ACHV.creditTaken(s2, ItemKind.Etc, wood, 4);
	ACHV.creditTaken(s2, ItemKind.Etc, wood === 0 ? 1 : 0, 9);
	ACHV.creditTaken(s2, ItemKind.Use, wood, 9);
	check(
		s2.achievements[AID.Chef] === 2 &&
			s2.achievements[AID.Blacksmith] === 1 &&
			s2.achievements[AID.WoodsCollector] === 4,
		"cozinhar vai para o Chef, fundir para o Blacksmith, o craft frio para nenhum; so madeira vai para o Woods collector",
		`${s2.achievements[AID.Chef]} / ${s2.achievements[AID.Blacksmith]} / ${s2.achievements[AID.WoodsCollector]}`,
	);
	// Rider (VEI-05): whole points only, never down, never past the goal
	ACHV.creditRide(s2, 7);
	for (const bad of [-3, 0, 1.5, Number.NaN, Infinity]) ACHV.creditRide(s2, bad);
	checkEq(
		s2.achievements[AID.Rider],
		7,
		"Rider: pontos inteiros do odometro do servidor; negativo, fracao e NaN nao movem",
	);
	ACHV.creditRide(s2, 1e9);
	checkEq(s2.achievements[AID.Rider], ACHIEVEMENTS[AID.Rider].max, "(e para na meta)");
}

section("27) os caminhos reais do servidor chamam o credito (craft, madeira, morte, entrada, abate)");
{
	// crafting through the server's own ServerCraft (the craft intent's path), beside a lit brazier -- it cooks (a
	// lit fire) and it smelts: the recipe's heat (ITM-01) says whose the craft is
	const { addSolid } = require(join(SRC, "shared/game/world.ts"));
	const world = createWorld(4000, 4000);
	addSolid(world, {
		kind: "structure",
		x: 1040,
		y: 970,
		w: 96,
		h: 64,
		hp: 200,
		hpMax: 200,
		destructible: true,
		tags: "brazier",
		powered: true,
	});
	const craft = new ServerCraft({ world, build: { placing: () => false, hold: () => {} } });
	const s = SAVE.defaultSave();
	const plain = r => r.craftKind !== 1 && !r.needsDesk && !r.needsPro;
	const cold = CRAFT_RECIPES.find(r => plain(r) && r.needsCook !== true && r.needsFire !== true);
	const cook = CRAFT_RECIPES.find(r => plain(r) && r.needsCook === true);
	const smelt = CRAFT_RECIPES.find(r => plain(r) && r.needsFire === true && r.needsCook !== true);
	const state = PLAYER.createPlayer(s, 1000, 1000);
	const outs = [cold, cook, smelt].map(recipe => {
		for (const ing of recipe.ingredients) {
			if (ing.kind === ItemKind.Etc) s.invenEtc[ing.index] = ing.count;
			if (ing.kind === ItemKind.Weapon) s.invenWeapon[ing.index] = ing.count;
			if (ing.kind === ItemKind.Use) s.invenUse[ing.index] = ing.count;
			if (ing.kind === ItemKind.Equip) s.invenEquip[ing.index] = ing.count;
		}
		craft.step(1);
		return craft.craft(0, state, s, recipe.id);
	});
	check(
		outs.every(o => o.kind === "crafted") &&
			outs[0].heat === undefined &&
			s.achievements[AID.Chef] === outs[1].count &&
			s.achievements[AID.Blacksmith] === outs[2].count &&
			outs[1].count > 0 &&
			outs[2].count > 0,
		`ServerCraft.craft: ${cold.id} (frio) para ninguem, ${cook.id} (cozinhar) para o Chef, ${smelt.id} (fundir) para o Blacksmith`,
		`${outs.map(o => o.kind).join(",")}, Chef ${s.achievements[AID.Chef]}, Blacksmith ${s.achievements[AID.Blacksmith]}`,
	);
	// the source of the other callers: one line each, where the server decides
	const src = f => readFileSync(join(SRC, f), "utf8");
	check(
		// a pickup credits what went INTO the backpack: all of it, or what fitted under the save's ceiling (ITM-07)
		/creditTaken\(save, item\.kind, item\.itemId, take\)/.test(src("server/sim/items.ts")) &&
			/creditTaken\(save, drop\.kind, drop\.id, drop\.count\)/.test(src("server/sim/items.ts")) &&
			/creditTaken\(save, extra\.kind, extra\.id, extra\.count\)/.test(src("server/sim/items.ts")),
		"ServerItems: o que o servidor poe na mochila (pegar, revistar, o achado do Thief) passa pelo creditTaken",
	);
	check(/countLifeDeath\(sp\.save\)/.test(src("server/sim/life.ts")), "LifeKeeper.died conta TODA morte desta vida");
	check(
		/creditFirstSteps\(save\)/.test(src("server/net/mpHost.ts")),
		"o host credita First steps ao admitir o corpo",
	);
	check(
		/const kind = weaponKind \?\? Wp\.WEAPONS\[st\.weaponId\]\?\.kind \?\? -1;/.test(src("server/sim/combat.ts")) &&
			/zombieKilled\(z\.id, z\.exp, sp\.slot, this\.nowS, z\.type, kind\)/.test(src("server/sim/combat.ts")) &&
			/bossKilled\(b\.id, b\.exp, b\.hpMax, sp\.slot, b\.type\)/.test(src("server/sim/combat.ts")),
		"o combate do servidor passa o tipo do zumbi e o da arma (a que lancou, ou a da mao) ao credito; o do chefe tambem",
	);
	check(
		/achievements = save\.achievements\.join/.test(src("server/main.server.ts")),
		"a carteira empurrada muda quando uma conquista muda (walletSignature)",
	);
	check(
		/stripClientLife\(prev, upd\)[^]*stripClientAchievements\(prev, upd, decoded\)[^]*applyProgressLimits\(s, prev, upd/.test(
			src("server/main.server.ts"),
		),
		"processReport fixa as conquistas antes de juntar o relatorio, com o relatorio decodificado (stripClientAchievements)",
	);
}

section("28) devolver ou entregar itens nao credita conquista (sem farm de Woods collector: revisao de seguranca)");
{
	// the build-cancel refund (server/sim/build.ts `cancel`, and `remove` on the way out of the world): the ingredients
	// come back through addItem, never through creditTaken -- a credited refund would farm Woods collector (craft a
	// wooden placeable, cancel, repeat), and a refunded cooking would farm Chef the same way
	const { ServerBuild } = require(join(SRC, "server/sim/build.ts"));
	const { WorldOut } = require(join(SRC, "server/sim/worldOut.ts"));
	const world = createWorld(4000, 4000);
	const build = new ServerBuild({ world, out: new WorldOut() });
	const craft = new ServerCraft({ world, build });
	const wood = ETC_ITEMS.findIndex(e => e.name === "Wood");
	const recipe = CRAFT_RECIPES.find(
		r =>
			r.craftKind === 1 &&
			!r.needsDesk &&
			!r.needsPro &&
			r.needsCook !== true &&
			r.needsFire !== true &&
			r.ingredients.some(i => i.kind === ItemKind.Etc && i.index === wood),
	);
	const s = SAVE.defaultSave();
	for (const ing of recipe.ingredients) {
		if (ing.kind === ItemKind.Etc) s.invenEtc[ing.index] = ing.count;
		if (ing.kind === ItemKind.Weapon) s.invenWeapon[ing.index] = ing.count;
		if (ing.kind === ItemKind.Use) s.invenUse[ing.index] = ing.count;
		if (ing.kind === ItemKind.Equip) s.invenEquip[ing.index] = ing.count;
	}
	const woodBefore = s.invenEtc[wood];
	const state = PLAYER.createPlayer(s, 1000, 1000);
	let rounds = 0;
	for (let i = 0; i < 5; i++) {
		craft.step(1);
		build.step(1);
		const made = craft.craft(0, state, s, recipe.id);
		const back = build.cancel(0, s);
		if (made.kind === "holding" && back.kind === "cancelled" && back.refunded === true) rounds += 1;
	}
	craft.step(1);
	const last = craft.craft(0, state, s, recipe.id);
	build.remove(0, s); // leaving the world with it still on the cursor: the same refund
	check(
		rounds === 5 &&
			last.kind === "holding" &&
			s.invenEtc[wood] === woodBefore &&
			s.achievements.every(v => v === 0),
		`receita ${recipe.id} (madeira): seis vezes fazer e devolver (cancelar, sair do mundo) -- a madeira volta toda e nenhuma conquista anda`,
		`${rounds} cancelamentos, madeira ${s.invenEtc[wood]}/${woodBefore}, Woods collector ${s.achievements[AID.WoodsCollector]}`,
	);

	// who may call the two "what came into the backpack" credits at all -- an allowlist, so a new road that fills the
	// backpack (a refund, a pack, a dropped item picked back up) is added here on purpose, by someone who read why
	// (creditRide too: only the server's own odometer of a ride it granted, VEI-05)
	const ALLOWED = {
		creditTaken: ["server/sim/items.ts"],
		creditCraft: ["server/sim/craft.ts"],
		creditRide: ["server/sim/vehicles.ts"],
	};
	const found = { creditTaken: [], creditCraft: [], creditRide: [] };
	const walk = d => {
		for (const f of readdirSync(d)) {
			const full = join(d, f);
			if (statSync(full).isDirectory()) walk(full);
			else if (full.endsWith(".ts") && !full.endsWith(join("save", "achievements.ts"))) {
				const text = readFileSync(full, "utf8");
				const rel = full
					.slice(SRC.length + 1)
					.split("\\")
					.join("/");
				for (const name of Object.keys(found))
					if (new RegExp(`\\b${name}\\(`).test(text)) found[name].push(rel);
			}
		}
	};
	walk(join(SRC, "server"));
	check(
		JSON.stringify(found) === JSON.stringify(ALLOWED),
		"so o ServerItems (pegar, revistar, o Thief) chama creditTaken, so o ServerCraft chama creditCraft e so o ServerVehicles chama creditRide -- build.ts nao",
		JSON.stringify(found),
	);

	// PACK_DELIVERY_HOOK: the server's pack delivery (server/sim/backpack.ts `deliverPacks`, on the backpack branch) must
	// not credit anything either -- a pack of wood is not wood collected. Until that module is on this branch the hook
	// only says it is waiting; once it is, it runs for real (and the allowlist above keeps creditTaken out of it)
	const backpackFile = join(SRC, "server/sim/backpack.ts");
	const BP = existsSync(backpackFile) ? require(backpackFile) : undefined;
	if (BP?.deliverPacks === undefined) {
		console.log("  PENDENTE  PACK_DELIVERY_HOOK: server/sim/backpack.ts deliverPacks ainda nao esta nesta branch");
	} else {
		const packs = SAVE.defaultSave();
		for (const pack of SHOP_PACKS) packs.packsBought[pack.id] = 1;
		const opened = BP.deliverPacks(packs);
		check(
			opened > 0 && packs.achievements.every(v => v === 0),
			"PACK_DELIVERY_HOOK: o servidor entregar todos os pacotes da loja nao move conquista nenhuma",
			`${opened} pacote(s), Woods collector ${packs.achievements[AID.WoodsCollector]}`,
		);
	}
}

section("29) o maior relatorio honesto cabe com folga em MAX_SAVE_PAYLOAD (revisao de seguranca de 5967a18, #12)");
{
	const { MAX_SAVE_PAYLOAD } = require(join(SRC, "shared/net/net.ts"));
	// the client reports its whole save (client/systems/saveClient.ts): every counter at a width no save can pass --
	// 8 digits in every array, 11 digits and a fraction in every number, 17 significant digits in every setting
	const worst = JSON.parse(JSON.stringify(SAVE.defaultSave()));
	for (const k of Object.keys(worst)) {
		const v = worst[k];
		if (Array.isArray(v)) worst[k] = v.map(() => 10000000);
		else if (typeof v === "number") worst[k] = -12345678901.5;
	}
	for (const k of Object.keys(worst.settings)) {
		if (typeof worst.settings[k] === "number") worst.settings[k] = 0.12345678901234567;
	}
	const size = JSON.stringify(worst).length;
	check(
		size * 2 <= MAX_SAVE_PAYLOAD,
		`o pior relatorio possivel tem ${size} B: mais de 2x de folga em ${MAX_SAVE_PAYLOAD} B`,
	);
	check(MAX_SAVE_PAYLOAD <= 8192, "e o teto nao passa de 8 KB (antes 100 KB de lixo eram lidos inteiros)");
}

section("30) o log de auditoria do admin: UserIds e texto filtrado, uma chave por servidor por dia (F5, chave quente)");
{
	globalThis.tostring ??= v => String(v);
	globalThis.tonumber ??= v => (v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
	const LOG = require(join(SRC, "server/admin/auditLog.ts"));
	// the day of a key is the UTC calendar day, without os.date: checked against JS's own calendar
	let wrong = 0;
	let t = 0;
	for (let i = 0; i < 3000; i++) {
		t = Math.floor(i * 1_451_234.5 + (i % 7) * 86399);
		const d = new Date(t * 1000);
		const want = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
		if (LOG.utcDay(t) !== want) wrong += 1;
	}
	check(wrong === 0, "utcDay = o dia UTC do calendario, em 3000 instantes de 1970 a 2107", `${wrong} errados`);
	checkArrayEq(
		[LOG.utcDay(951_782_400), LOG.utcDay(1_700_000_000), LOG.utcDay(4_102_444_799)],
		["20000229", "20231114", "20991231"],
		"bissexto, hoje, fim de seculo",
	);
	const job = "8f14e45f-ceea-467a-9b1c-3c8e6b0a1f2d";
	const key = LOG.auditKey(1_700_000_000, job);
	checkEq(key, "log_20231114_8f14e45fceea467a9b1c3c8e6b0a1f2d", "a chave: dia UTC + o JobId so com letras e digitos");
	const worst = LOG.auditKey(1_700_000_000, "x".repeat(400));
	check(worst.length <= 50, "nenhuma chave passa de 50 caracteres (o limite do DataStore)", `${worst.length}`);
	checkEq(LOG.jobTag(""), "studio", "sem JobId (Studio): 'studio'");
	check(
		key.startsWith(LOG.auditDayPrefix(1_700_000_000)),
		"a chave comeca pelo prefixo do dia (o que o painel lista)",
	);
	check(
		LOG.auditKey(1_700_000_000, "other-server") !== key && LOG.auditKey(1_700_000_000 + 86400, job) !== key,
		"outro servidor ou outro dia: outra chave (cada chave tem UM escritor)",
	);

	// what the single old key "recent" held, in the old shape: names, labels and raw text
	const legacy = [
		{
			t: 1,
			adminId: 7,
			admin: "Owner",
			action: "ban",
			target: "Griefer (123)",
			details: '7 days, universe=true, excludeAlts=false, reason="raw insult", private="raw note"',
			ok: true,
		},
		{
			t: 2,
			adminId: 7,
			admin: "Owner",
			action: "kick",
			target: "Other (456)",
			details: "raw kick words",
			ok: true,
		},
		{
			t: 3,
			adminId: 7,
			admin: "Owner",
			action: "announce",
			target: "all",
			details: 'FAILED text filter: "raw"',
			ok: false,
		},
		{ t: 4, adminId: 7, admin: "Owner", action: "edit", target: "Other (456)", details: "level=5", ok: true },
		{ t: 5, adminId: 7, admin: "Owner", action: "ban", target: "#789", details: "refused: self", ok: false },
		{
			t: 6,
			adminId: 7,
			admin: "Owner",
			action: "local:spawn",
			target: "own world",
			details: "spawn walker",
			ok: true,
		},
		"not an entry",
	];
	check(LOG.auditNeedsScrub(legacy), "o documento antigo precisa de limpeza");
	const clean = LOG.readAuditList(legacy);
	const json = JSON.stringify(clean);
	check(
		!/Owner|Griefer|Other|raw/.test(json) && !json.includes('"admin"'),
		"lido pelo sanitizador: nenhum nome e nenhum texto cru sobra",
		json,
	);
	checkArrayEq(
		clean.map(e => e.targetId),
		[123, 456, 0, 456, 789, 0],
		"o UserId de cada alvo sai do rotulo antigo ('Nome (id)', '#id')",
	);
	checkArrayEq(
		clean.map(e => e.details),
		["7 days, universe=true, excludeAlts=false", "", "", "level=5", "refused: self", "spawn walker"],
		"ficam as opcoes do ban, a edicao e as ferramentas; somem o motivo digitado e o anuncio",
	);
	check(!LOG.auditNeedsScrub(clean), "e o limpo nao precisa de outra limpeza (nenhuma escrita a toa)");
	checkEq(JSON.stringify(LOG.readAuditList(clean)), json, "ler o limpo de novo nao muda nada");

	const [kept, removed] = LOG.eraseAuditUser(legacy, 456);
	check(
		removed === 2 && kept.every(e => e.targetId !== 456 && e.adminId !== 456),
		"apagar o 456: somem as entradas em que ele e o alvo",
		`${removed} removidas`,
	);
	const [keptAdmin, removedAdmin] = LOG.eraseAuditUser(clean, 7);
	check(removedAdmin === 6 && keptAdmin.length === 0, "...e as em que ele e o admin");
	const [nobody, none] = LOG.eraseAuditUser(legacy, 0);
	check(none === 0 && !LOG.auditNeedsScrub(nobody), "UserId 0 so limpa, nao apaga ninguem");

	const many = [];
	for (let i = 0; i < LOG.AUDIT_PER_KEY + 25; i++)
		many.push({ t: i, adminId: 7, action: "edit", targetId: 1, target: "", details: "", ok: true });
	// an afternoon of world tools never pushes a ban out: tool entries (local:*, assist) are evicted first
	const mixed = [];
	for (let i = 0; i < 40; i++)
		mixed.push({
			t: i,
			adminId: 7,
			action: i % 2 === 0 ? "ban" : "kick",
			targetId: 100 + i,
			target: "",
			details: "",
			ok: true,
		});
	for (let i = 0; i < LOG.AUDIT_PER_KEY; i++)
		mixed.push({
			t: 100 + i,
			adminId: 7,
			action: "local:spawn",
			targetId: 0,
			target: "own world",
			details: "",
			ok: true,
		});
	const trimmed = LOG.appendAudit(undefined, mixed);
	const moderations = trimmed.filter(e => e.action === "ban" || e.action === "kick").length;
	check(
		trimmed.length === LOG.AUDIT_PER_KEY && moderations === 40 && trimmed.at(-1).t === 100 + LOG.AUDIT_PER_KEY - 1,
		"cheia de ferramentas, a chave corta as ferramentas mais velhas e guarda todo kick e ban",
		`${moderations} de 40 moderacoes`,
	);
	checkArrayEq(
		[
			...LOG.splitBanNote("cheating again | by admin 8013052784"),
			...LOG.splitBanNote("typed | by admin notanid"),
			...LOG.splitBanNote("made in the Creator Hub"),
		],
		["cheating again", " | by admin 8013052784", "typed | by admin notanid", "", "made in the Creator Hub", ""],
		"a nota privada separa o que o admin digitou do sufixo que o jogo escreveu",
	);
	const adminSrc = readFileSync(join(SRC, "server/admin/adminServer.ts"), "utf8");
	const patchEv = adminSrc.slice(
		adminSrc.indexOf("function sendPatch("),
		adminSrc.indexOf("remotes.event.FireClient(target, ev)"),
	);
	check(
		!/\bby\b/.test(patchEv) && !/\.Name\b/.test(patchEv),
		"a edicao que chega ao jogador nao leva o nome do admin",
	);
	const capped = LOG.appendAudit(undefined, many);
	check(
		capped.length === LOG.AUDIT_PER_KEY && capped[0].t === 25,
		"uma chave guarda as ultimas AUDIT_PER_KEY entradas",
		`${capped.length}`,
	);

	// `npm run cloud -- erase` scrubs the same keys with the same filter (tools/rtbf.mjs is plain JS: checked here)
	const RTBF = await import("./rtbf.mjs");
	const agree = [456, 7, 123, 789, 999].every(uid => {
		const [a, na] = LOG.eraseAuditUser(legacy, uid);
		const [b, nb] = RTBF.eraseAuditEntries(legacy, uid);
		return na === nb && JSON.stringify(a) === JSON.stringify(b);
	});
	check(agree, "cloud.mjs erase e o servidor apagam as mesmas entradas e guardam o mesmo resto");
	const plan = RTBF.erasePlan(4242);
	const stores = plan.map(s => s.store);
	check(
		["ProjectZ_Save_v2", "ProjectZ_Save_v1", "ProjectZ_Titles"].every(
			s => stores.includes(s) && stores.includes(`${s}_studio`),
		) &&
			plan.filter(s => s.kind === "delete").every(s => s.key === "4242") &&
			stores.includes("ProjectZ_AdminLog") &&
			stores.includes("ProjectZ_AdminLog_studio"),
		"o erase cobre save v2, save v1, titulos e o log de admin, cada um tambem com _studio",
		stores.join(", "),
	);
	const storesTs = readFileSync(join(SRC, "server/save/stores.ts"), "utf8");
	const perPlayer = [...storesTs.matchAll(/storeName\("([^"]+)"\)/g)].map(m => m[1]);
	check(
		perPlayer.every(
			s =>
				s === "ProjectZ_Worlds" ||
				s === "ProjectZ_PrivateTowns" ||
				RTBF.PLAYER_STORES.includes(s) ||
				s === RTBF.ADMIN_LOG_STORE,
		),
		"todo store de stores.ts esta no erase (ProjectZ_Worlds e ProjectZ_PrivateTowns nao guardam dado de jogador)",
		perPlayer.join(", "),
	);

	// a destructive command never guesses: one numeric UserId, only the known flags, and --yes for the real run
	const parse = RTBF.parseEraseArgs;
	const ok1 = parse(["4242"]);
	check(
		ok1.userId === 4242 &&
			!ok1.dryRun &&
			!ok1.yes &&
			parse(["4242", "--dry-run"]).dryRun &&
			parse(["--yes", "4242"]).yes,
		"erase 4242 [--dry-run | --yes] e lido",
	);
	const refused = [
		["4242", "--dryrun"],
		["12", "34"],
		[],
		["someName"],
		["0"],
		["-5"],
		["4242", "--yes", "--dry-run"],
		["4242", "--yes", "--yes"],
		["4242", "--force"],
		["1234567890123456"],
	];
	const accepted = refused.filter(a => parse(a).error === undefined);
	check(
		accepted.length === 0,
		"recusa: opcao com erro de digitacao, dois UserIds, nenhum, um nome, 0, negativo, --dry-run com --yes, repetida, desconhecida, 16 digitos",
		accepted.map(a => a.join(" ")).join(" | ") || `${refused.length} casos`,
	);
	checkArrayEq(
		[
			RTBF.listedKey({ id: "global/log_x" }),
			RTBF.listedKey({ path: "universes/1/data-stores/S/scopes/global/entries/log_y", id: "log_y" }),
			RTBF.listedKey({ id: "log_z" }),
		],
		["log_x", "log_y", "log_z"],
		"a chave de uma linha da listagem, com ou sem o escopo na frente",
	);

	// the command itself, spawned: EVERY run points PZ_CLOUD_ENV at a throwaway (or missing) file and preloads the fake
	// Open Cloud -- the repo's .env on the owner's PC holds a real key, and nothing here may ever reach it or Roblox
	{
		const { spawnSync } = await import("node:child_process");
		const { createHash } = await import("node:crypto");
		const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const TOOLS = join(SRC, "..", "tools");
		const cloud = join(TOOLS, "cloud.mjs");
		const FAKE = join(TOOLS, "fake-open-cloud.mjs");
		const tmp = mkdtempSync(join(tmpdir(), "pz-erase-"));
		const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ROBLOX_")));
		try {
			const general = "sk-test-GENERAL-never-print";
			const eraseKey = "sk-test-ERASE-never-print";
			const hash = k => createHash("sha256").update(k).digest("hex").slice(0, 12);
			const envFile = join(tmp, "fake.env");
			writeFileSync(
				envFile,
				`ROBLOX_API_KEY=${general}\nROBLOX_ERASE_API_KEY=${eraseKey}\nROBLOX_UNIVERSE_ID=99\nROBLOX_PLACE_ID=1\n`,
			);
			const missingEnv = join(tmp, "missing.env");
			const statePath = join(tmp, "state.json");
			const someoneElse = {
				t: 9,
				adminId: 7,
				action: "edit",
				targetId: 555,
				target: "",
				details: "level=2",
				ok: true,
			};
			const aboutHim = {
				t: 8,
				adminId: 7,
				action: "kick",
				targetId: 4242,
				target: "",
				details: "#####",
				ok: true,
			};
			const seed = (withHim = true) =>
				writeFileSync(
					statePath,
					JSON.stringify({
						ProjectZ_Save_v2: withHim
							? { 4242: { data: "{}", lock: null }, 555: { data: "{}", lock: null } }
							: { 555: { data: "{}", lock: null } },
						ProjectZ_Titles: withHim ? { 4242: { titles: [1, 0, 0], zombieKills: 3, epoch: 1 } } : {},
						ProjectZ_Titles_studio: withHim
							? { 4242: { titles: [0, 0, 0], zombieKills: 0, epoch: 1 } }
							: {},
						ProjectZ_AdminLog: {
							recent: [
								{
									t: 1,
									adminId: 7,
									admin: "Owner",
									action: "ban",
									target: "Him (4242)",
									details: "x",
									ok: true,
								},
							],
							log_20231114_jobA: [aboutHim, someoneElse],
							log_20231114_jobB: [someoneElse, aboutHim],
						},
					}),
				);
			const run = (args, { envPath = missingEnv, fake = true, extra = {} } = {}) => {
				const r = spawnSync(process.execPath, [...(fake ? ["--import", FAKE] : []), cloud, ...args], {
					encoding: "utf8",
					env: { ...baseEnv, PZ_CLOUD_ENV: envPath, PZ_FAKE_CLOUD_STATE: statePath, ...extra },
				});
				const after = fake ? JSON.parse(readFileSync(statePath, "utf8")) : { state: undefined, requests: [] };
				return { status: r.status, out: `${r.stdout}\n${r.stderr}`, ...after };
			};

			seed();
			const dry = run(["erase", "4242", "--dry-run"]);
			check(
				dry.status === 0 &&
					/nenhuma chave foi lida/.test(dry.out) &&
					(dry.out.match(/apagar a chave 4242/g) ?? []).length === 6 &&
					/FORA do jogo/.test(dry.out) &&
					dry.requests.length === 0,
				"`erase <userId> --dry-run`: o plano (com o aviso de tirar o jogador do jogo antes), sem ler chave nem chamar nada",
				dry.status === 0 ? `${dry.requests.length} chamadas` : dry.out.trim(),
			);
			// a refused command does nothing -- even with a real-looking .env right there to use
			const refusals = [
				["erase", "4242", "--dryrun"],
				["erase", "12", "34"],
				["erase", "someName"],
				["erase", "4242"],
			].map(args => {
				seed();
				const r = run(args, { envPath: envFile });
				return { args, ok: r.status === 1 && r.requests.length === 0 && "4242" in r.state.ProjectZ_Save_v2, r };
			});
			check(
				refusals.every(x => x.ok) &&
					/--yes/.test(refusals[3].r.out) &&
					/Nada foi feito/i.test(refusals[3].r.out),
				"`--dryrun` (erro de digitacao), `12 34`, um nome e a falta de --yes: sai com erro e nada e feito",
				refusals
					.filter(x => !x.ok)
					.map(x => x.args.join(" "))
					.join(" | ") || "4 casos",
			);
			// the guard: under test, without the fake preloaded, the command stops before any request
			const bare = run(["erase", "4242", "--yes"], { envPath: envFile, fake: false });
			check(
				bare.status === 1 && /sem o Open Cloud falso/.test(bare.out),
				"sob teste e sem o Open Cloud falso, o comando para antes de qualquer chamada (nunca o apis.roblox.com)",
			);

			seed();
			const real = run(["erase", "4242", "--yes"], { envPath: envFile, extra: { PZ_FAKE_CLOUD_CONFLICTS: "1" } });
			check(
				real.status === 0,
				"`erase 4242 --yes` contra o Open Cloud falso termina bem",
				real.status === 0 ? undefined : real.out,
			);
			check(
				!("4242" in real.state.ProjectZ_Save_v2) &&
					"555" in real.state.ProjectZ_Save_v2 &&
					!("4242" in real.state.ProjectZ_Titles) &&
					!("4242" in real.state.ProjectZ_Titles_studio),
				"apaga a chave dele no save e nos titulos (e _studio), e so a dele",
			);
			const log = real.state.ProjectZ_AdminLog;
			check(
				log.recent.length === 0 &&
					JSON.stringify(log.log_20231114_jobA) === JSON.stringify([someoneElse]) &&
					JSON.stringify(log.log_20231114_jobB) === JSON.stringify([someoneElse]),
				"tira do log de admin so as entradas sobre ele (a chave antiga e as do dia), mesmo com uma corrida de escrita",
				JSON.stringify(log),
			);
			const patches = real.requests.filter(r => r.method === "PATCH").length;
			check(
				patches === 4,
				"regrava as chaves que mudaram, e de novo a que outro servidor escreveu no meio",
				`${patches} PATCH`,
			);
			const entryCalls = real.requests.filter(r => !r.path.endsWith("/entries"));
			check(
				entryCalls.length > 0 && entryCalls.every(r => r.path.includes("/scopes/global/entries/")),
				"toda leitura, gravacao e exclusao usa o caminho com escopo (o falso recusa o sem escopo)",
			);
			check(
				real.requests.every(r => r.keyed && r.keyHash === hash(eraseKey)) &&
					!real.out.includes(general) &&
					!real.out.includes(eraseKey),
				"usa a chave propria do erase (ROBLOX_ERASE_API_KEY), no cabecalho, e nenhuma chave aparece na saida",
			);

			seed(false);
			const none = run(["erase", "4242", "--yes"], { envPath: envFile });
			check(
				none.status === 1 &&
					/nenhuma das seis chaves/.test(none.out) &&
					none.state.ProjectZ_AdminLog.recent.length === 0,
				"nenhuma das seis chaves existia: sai com erro (confira o UserId), e o log de admin e limpo mesmo assim",
			);

			seed();
			const broken = run(["erase", "4242", "--yes"], {
				envPath: envFile,
				extra: { PZ_FAKE_CLOUD_FAIL: "ProjectZ_AdminLog/log_20231114_jobA" },
			});
			check(
				broken.status === 1 &&
					/FALHOU/.test(broken.out) &&
					JSON.stringify(broken.state.ProjectZ_AdminLog.log_20231114_jobB) ===
						JSON.stringify([someoneElse]) &&
					broken.state.ProjectZ_AdminLog.recent.length === 0,
				"uma chave do log que falha nao para as outras: cada uma e limpa, a falha e dita e o comando sai com erro",
			);

			seed();
			const saved = run(["save", "4242"], { envPath: envFile });
			check(
				saved.status === 0 &&
					/save de 4242/.test(saved.out) &&
					saved.requests.every(r => r.path.includes("/scopes/global/entries/")),
				"`save <userId>` tambem le pelo caminho com escopo",
				saved.status === 0 ? undefined : saved.out.trim(),
			);

			// through a symlink (or a Windows junction) the command still runs: no "am I the main module?" check left
			const link = join(tmp, "cloud-link.mjs");
			symlinkSync(cloud, link);
			const viaLink = spawnSync(process.execPath, ["--import", FAKE, link], {
				encoding: "utf8",
				env: { ...baseEnv, PZ_CLOUD_ENV: missingEnv },
			});
			check(
				viaLink.status === 0 && /uso: npm run cloud/.test(viaLink.stdout),
				"chamado por um link simbolico, o cloud.mjs responde (antes ficava mudo)",
				viaLink.stdout.trim().slice(0, 60),
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}

	// the server writes each entry to ITS day key, never to the old one, and stores no name
	const admin = readFileSync(join(SRC, "server/admin/adminServer.ts"), "utf8");
	const flush = admin.slice(admin.indexOf("function flushAudit("), admin.indexOf("function readKey("));
	check(
		/auditKey\(e\.t, host\.jobId\)/.test(flush) && !flush.includes("LEGACY_AUDIT_KEY"),
		"adminServer flushAudit: cada entrada na chave do seu dia DESTE servidor; a antiga so e lida e limpa",
	);
	const records = [...admin.matchAll(/\brecord\(([\s\S]*?)\);/g)].map(m => m[1]);
	const rawText = records.filter(r =>
		/\b(reason|display|privateReason|text)\b(?![^"`]*["`]\s*[,)])|\.Name\b|DisplayName/.test(
			r.replace(/"[^"]*"/g, '""'),
		),
	);
	check(
		records.length >= 15 && rawText.length === 0,
		"nenhum record() recebe texto digitado sem filtro nem nome de jogador",
		rawText.join(" | ") || `${records.length} chamadas`,
	);
	check(
		!/\$\{(display|privateReason|reason|text)\}/.test(admin),
		"e nenhum texto de detalhe e montado com o texto digitado (motivo, nota privada, anuncio)",
	);
}

section("31) regras e mensagens de moderacao: pela lang.ts, e o ban aponta para as regras (F3, F10)");
{
	const RULES = require(join(SRC, "shared/data/rules.ts"));
	const { LANG_TABLE } = require(join(SRC, "shared/data/lang.ts"));
	const LANG = new Set(LANG_TABLE);
	check(LANG.has(RULES.RULES_TEXT) && LANG.has("Rules"), "as regras estao na lang.ts (vao para o CSV do locale)");
	check(
		RULES.RULES_TEXT.split("#").some(l => l.startsWith("Appeals:")),
		"e dizem como recorrer (as diretrizes de ban do Roblox pedem)",
	);
	const kick = RULES.kickMessage(0, undefined);
	const kickWhy = RULES.kickMessage(0, "####### spam");
	const flood = RULES.floodKickMessage(0);
	const cut = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
	const ban = RULES.banMessage(0, "", 400, cut);
	const banWhy = RULES.banMessage(0, "Exploiting.", 400, cut);
	const banLong = RULES.banMessage(0, "x".repeat(400), 400, cut);
	checkEq(kick, "You were kicked by an administrator.", "kick sem motivo");
	checkEq(kickWhy, "You were kicked by an administrator: ####### spam", "kick com o motivo como o filtro devolveu");
	check(
		ban.endsWith("The rules and how to appeal are on this experience's page.") &&
			banWhy.startsWith("Exploiting. The rules"),
		"o ban aponta para as regras e o recurso na pagina da experiencia",
		banWhy,
	);
	check(
		banLong.length <= 400 && banLong.endsWith("experience's page."),
		"um motivo de 400 caracteres e cortado, o ponteiro nunca",
		`${banLong.length}`,
	);
	for (const k of [
		"You were kicked by an administrator",
		"You are banned from this experience for breaking its rules",
		"The rules and how to appeal are on this experience's page",
		"Disconnected for sending too many network messages",
	])
		check(LANG.has(k), `lang.ts: "${k}"`);
	check(flood.startsWith("Disconnected for sending"), "o kick automatico por flood tambem sai da lang.ts", flood);
	checkArrayEq(
		["en-us", "ko-kr", "zh-cn", "ja-jp", "pt-br", undefined].map(RULES.langTypeOfLocale),
		[0, 1, 2, 3, 0, 0],
		"a lingua do jogador sai do LocaleId da conta",
	);
	const sources = ["server/admin/adminServer.ts", "server/net/mpHost.ts", "server/net/backpackIntents.ts"].map(f =>
		readFileSync(join(SRC, f), "utf8"),
	);
	check(
		sources.every(s => !/\.Kick\(\s*"/.test(s) && !/You were kicked|You are banned|Network flood"/.test(s)),
		"nenhum Kick com texto em ingles fixo no servidor",
	);
}

// ---------------------------------------------------------------- SAV-01: saving is automatic

section(
	"32) SAV-01: so o servidor escolhe quando gravar -- eventos coalescidos, o piso do orcamento, nada sem mudanca",
);
{
	const CAD = require(join(SRC, "server/save/saveCadence.ts"));
	const { CRAFT_RECIPES } = require(join(SRC, "shared/data/crafts.ts"));
	const { ItemKind: IK } = require(join(SRC, "shared/data/kinds.ts"));
	const src = f => readFileSync(join(SRC, f), "utf8");

	/**
	 * The server's two loops over a pretend clock: `events` (s) ask for an early write (the event save), the scan runs
	 * every EVENT_SCAN_S and starts the write that is due, and -- `autosave` -- the autosave comes every AUTOSAVE_INTERVAL
	 * under the same gap. `changes` (s) only make the session dirty (XP, ammo: no event). The load's write happened at
	 * `loadAt`. Answers when each write started.
	 */
	function simulate(events, horizon, { loadAt = -1000, autosave = false, changes = [] } = {}) {
		const c = CAD.newCadence(loadAt);
		const writes = [];
		let next = 0;
		let nextChange = 0;
		let dirty = false;
		const queue = [...events].sort((a, b) => a - b);
		for (let t = 0; t <= horizon + 1e-9; t = Math.round((t + 0.05) * 100) / 100) {
			while (next < queue.length && queue[next] <= t) {
				CAD.scheduleSave(c, t, "level");
				dirty = true;
				next++;
			}
			while (nextChange < changes.length && changes[nextChange] <= t) {
				dirty = true;
				nextChange++;
			}
			if (autosave && t > 0 && Math.abs(t % CAD.AUTOSAVE_INTERVAL) < 1e-6) {
				if (CAD.tooSoon(c, t)) {
					if (dirty) CAD.scheduleSave(c, t, "auto");
				} else if (dirty) {
					CAD.writeStarted(c, t);
					writes.push(t);
					dirty = false;
				}
			}
			if (Math.abs((t / CAD.EVENT_SCAN_S) % 1) < 1e-6 && CAD.saveDue(c, t)) {
				CAD.writeStarted(c, t);
				writes.push(t);
				dirty = false;
			}
		}
		return writes;
	}
	const gapsOf = w => w.slice(1).map((t, i) => t - w[i]);

	// 10 events in 5 s: one write inside the burst, one more a gap later for what came after it
	const burst = Array.from({ length: 10 }, (_, i) => i * 0.5);
	const w1 = simulate(burst, 60);
	check(
		w1.filter(t => t <= 5).length === 1 && w1.length === 2 && w1[1] - w1[0] >= CAD.EVENT_SAVE_GAP,
		`10 eventos em 5 s: 1 gravacao dentro deles (${CAD.EVENT_SAVE_DELAY} s depois do primeiro) e 1 so depois, ${CAD.EVENT_SAVE_GAP} s adiante`,
		`gravacoes em ${w1.join(", ")} s`,
	);
	// a burst shorter than the delay is ONE write
	const w2 = simulate(
		Array.from({ length: 10 }, (_, i) => i * 0.25),
		60,
	);
	check(
		w2.length === 1,
		`10 eventos em 2,5 s (menos que o atraso de ${CAD.EVENT_SAVE_DELAY} s): 1 gravacao`,
		`${w2}`,
	);
	// a flood: an event every 0.1 s for 10 minutes (a client that spams whatever it can, a horde of level-ups)
	const flood = Array.from({ length: 6000 }, (_, i) => i * 0.1);
	const w3 = simulate(flood, 600, { autosave: true });
	check(
		w3.length <= Math.ceil(600 / CAD.EVENT_SAVE_GAP) + 1 && gapsOf(w3).every(g => g >= CAD.EVENT_SAVE_GAP - 1e-6),
		`uma enxurrada (6000 eventos em 10 min, com o autosave): no maximo 1 gravacao a cada ${CAD.EVENT_SAVE_GAP} s`,
		`${w3.length} gravacoes, menor intervalo ${Math.min(...gapsOf(w3)).toFixed(2)} s`,
	);
	// the autosave obeys the gap too: an event write 3 s before it leaves what came after for the gap's end
	const w4 = simulate([54], 130, { autosave: true, loadAt: 0, changes: [58] });
	checkArrayEq(
		w4,
		[57, 72],
		"o autosave obedece ao mesmo intervalo: um evento gravou aos 57 s, o que mudou depois vai aos 72 s, nao aos 60",
	);
	// the load's own write counts: an event right after joining waits for the gap
	const w5 = simulate([1], 40, { loadAt: 0 });
	check(
		w5.length === 1 && w5[0] === CAD.EVENT_SAVE_GAP,
		"a carga (que pegou a trava) conta como gravacao: um evento 1 s depois de entrar grava aos 15 s",
		`${w5}`,
	);
	check(
		CAD.EVENT_SAVE_MIN_BUDGET >
			Number(/const AUTOSAVE_MIN_BUDGET = (\d+);/.exec(src("server/main.server.ts"))?.[1]),
		"o piso de orcamento dos eventos fica acima do do autosave (que guarda as entradas e saidas)",
		`${CAD.EVENT_SAVE_MIN_BUDGET}`,
	);
	// failures back off (review M1): 15 s after the first, 30 s after the second, then AUTOSAVE_INTERVAL; a landing resets
	{
		const c = CAD.newCadence(0);
		const seq = [];
		for (let f = 0; f <= 5; f++) {
			seq.push(CAD.gapOf(c));
			CAD.writeFailed(c);
		}
		checkArrayEq(
			seq,
			[15, 15, 30, 60, 60, 60],
			"o intervalo recua com as falhas: 15 s, 15 s depois da 1a, 30 s depois da 2a, 60 s (AUTOSAVE_INTERVAL) dai em diante",
		);
		CAD.writeStarted(c, 100);
		check(CAD.tooSoon(c, 159) && !CAD.tooSoon(c, 160), "tooSoon respeita o recuo: 60 s depois de varias falhas");
		CAD.scheduleSave(c, 101, "retry");
		check(c.due === 160, "...e o pedido de gravacao tambem", `due ${c.due}`);
		CAD.writeLanded(c, "{}");
		check(
			c.failures === 0 && CAD.gapOf(c) === CAD.EVENT_SAVE_GAP && c.lastJson === "{}",
			"uma gravacao que chega zera o recuo",
		);
	}
	// an outage in the pretend clock: every attempt fails, the save changes every 5 s, the autosave comes every minute
	{
		const c = CAD.newCadence(-1000);
		let attempts = 0;
		let dirty = false;
		for (let t = 0; t <= 600; t = Math.round((t + 0.25) * 100) / 100) {
			if (t % 5 === 0) {
				dirty = true;
				if (t % 10 === 0) CAD.scheduleSave(c, t, "level");
			}
			const auto = t > 0 && t % CAD.AUTOSAVE_INTERVAL === 0;
			if (auto && CAD.tooSoon(c, t) && dirty) CAD.scheduleSave(c, t, "auto");
			const run = (auto && !CAD.tooSoon(c, t) && dirty) || (t % CAD.EVENT_SCAN_S === 0 && CAD.saveDue(c, t));
			if (!run) continue;
			attempts++;
			CAD.writeStarted(c, t);
			CAD.writeFailed(c);
			CAD.scheduleSave(c, t, "retry");
		}
		check(
			attempts <= 12,
			"uma queda de 10 min: no maximo ~1 tentativa por minuto por jogador (o autosave com 3 retentativas fazia 4)",
			`${attempts} tentativas em 10 min`,
		);
	}
	// the worst case, as the rule states it
	const eventLoss = CAD.EVENT_SAVE_GAP + CAD.EVENT_SCAN_S;
	const otherLoss = CAD.AUTOSAVE_INTERVAL + CAD.EVENT_SCAN_S;
	console.log(
		`        pior janela de perda numa queda sem BindToClose: ${eventLoss} s depois de um evento da lista, ` +
			`${otherLoss} s para o resto (+ a latencia da escrita)`,
	);

	// which change of the save is an event, and which is not
	const base = SAVE.defaultSave();
	const marks = CAD.milestonesOf(base);
	const moved = edit => {
		const s = JSON.parse(JSON.stringify(base));
		edit(s);
		return CAD.milestoneEvent(marks, CAD.milestonesOf(s));
	};
	checkArrayEq(
		[
			moved(s => (s.level += 1)),
			moved(s => (s.skillLevels[0] += 1)),
			moved(s => (s.day += 1)),
			moved(s => (s.bestDay += 1)),
			moved(s => (s.titles[0] = 1)),
			moved(s => (s.lifeDeaths += 1)),
			moved(s => (s.runOver = true)),
			moved(s => (s.runRev += 1)),
		],
		["level", "skill", "day", "day", "title", "death", "death", "life"],
		"nivel, skill, dia, recorde, titulo, morte e vida nova sao eventos",
	);
	const dead = JSON.parse(JSON.stringify(base));
	dead.runOver = true;
	check(
		CAD.milestoneEvent(CAD.milestonesOf(dead), CAD.milestonesOf(base)) === "revive",
		"levantar (amanhecer, Rebirth) e evento",
	);
	checkArrayEq(
		[
			moved(s => (s.exp += 5)),
			moved(s => (s.money += 5)),
			moved(s => (s.ammoNormal += 5)),
			moved(s => (s.settings.bgm = 0.1)),
			moved(s => (s.zombieKills += 1)),
			CAD.milestoneEvent(undefined, marks),
		],
		[undefined, undefined, undefined, undefined, undefined, undefined],
		"XP, moedas, municao, ajustes e abates esperam o autosave; a primeira olhada so anota",
	);

	// a rare craft: a weapon or an armour made at a workbench -- not the hands' stick, ammunition, smelting, a meal, a
	// bandage or a build
	const rare = CRAFT_RECIPES.filter(r => CAD.isRareCraft(r.id));
	const gear = r => r.resultKind === IK.Weapon || r.resultKind === IK.Equip;
	const cooking = CRAFT_RECIPES.filter(r => r.needsCook === true);
	check(
		rare.length > 0 &&
			rare.every(r => gear(r) && (r.needsDesk || r.needsPro) && r.craftKind !== 1) &&
			CRAFT_RECIPES.filter(r => gear(r) && (r.needsDesk || r.needsPro)).length === rare.length &&
			CRAFT_RECIPES.filter(r => r.needsCook || r.needsFire || r.craftKind === 1 || !gear(r)).every(
				r => !CAD.isRareCraft(r.id),
			),
		"craft raro: arma ou equipamento de bancada; nunca comida, fundicao, municao, bandagem nem construcao",
		`${rare.length} de ${CRAFT_RECIPES.length} receitas`,
	);
	const byHand = CRAFT_RECIPES.filter(r => gear(r) && !r.needsDesk && !r.needsPro);
	check(
		byHand.length > 0 && byHand.every(r => !CAD.isRareCraft(r.id)),
		"...e o que se faz a mao com madeira e pedra (o graveto, o machado de pedra) espera o autosave",
		`${byHand.length} receitas a mao`,
	);
	checkArrayEq(
		[
			CAD.backpackEvent({ kind: "learned", skill: 0, level: 1 }),
			CAD.backpackEvent({ kind: "crafted", recipe: rare[0].id, count: 1, heat: undefined }),
			CAD.backpackEvent({ kind: "crafted", recipe: cooking[0].id, count: 1, heat: "cook" }),
			CAD.backpackEvent({ kind: "used", item: 0 }),
			CAD.backpackEvent({ kind: "switched", weapon: 0 }),
		],
		["skill", "craft", undefined, undefined, undefined],
		"da mochila: skill aprendida e craft raro pedem gravacao; o resto espera",
	);

	// no manual save, anywhere: the client never asks for a write
	const main = src("server/main.server.ts");
	const between = (from, to) => main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from)));
	const reportPath =
		between("function processReport(", "function processPending(") +
		between(
			"remotes.saveRequest.OnServerEvent.Connect(",
			"// ---------------------------------------------------------------- shop",
		);
	check(
		reportPath.length > 500 && !/flush\(|saveSoon\(|scheduleSave\(|UpdateAsync/.test(reportPath),
		"o relatorio do cliente (SaveRequest) nunca grava nem pede gravacao: so marca a sessao suja",
	);
	// the review of a454292, in the code: one attempt for a write that is not the last (M1), an attempt that throws or
	// is too large counts (L1), a notice never in the way of the write (L3), no retry sleep once the player is leaving (L4)
	const flushFn = between("function flush(", "function writeSession(");
	const writeFn = between(
		"function writeSession(",
		"// ---------------------------------------------------------------- load",
	);
	const lockFn = between("function writeWithLock(", "function handBackLock(");
	const notifyFn = between("function notifyStore(", "function resetCredits(");
	check(
		/const tries = release \? delays : NO_RETRIES;/.test(flushFn) &&
			/const NO_RETRIES: Array<number> = \[\];/.test(main),
		"so a gravacao final repete no lugar; as outras fazem UMA tentativa (a cadencia repete, recuando) -- M1",
	);
	check(
		/if \(!release\) Cadence\.writeStarted\(s\.cadence, os\.clock\(\)\);[^]*s\.writing = false;[^]*if \(!ran && !release\) writeFailedFor\(s, true\);/.test(
			flushFn,
		) &&
			/MAX_STORED_LENGTH\)[^]*Cadence\.writeStarted\(c, os\.clock\(\)\);\s*writeFailedFor\(s, true\);/.test(
				writeFn,
			),
		"a tentativa que lanca (encode) ou e grande demais conta: limpa o pedido e recua -- L1; o aviso vem depois de `writing` baixar -- L3",
	);
	check(
		/pcall\(\(\) => remotes\.saveAck\.FireClient\(s\.player, push\)\)/.test(notifyFn),
		"o aviso ao jogador nunca atrapalha a gravacao: FireClient dentro de pcall -- L3",
	);
	check(
		/if \(!release && \(s\.closed \|\| shuttingDown\)\) return "failed";\s*task\.wait\(delays\[attempt\]\);/.test(
			lockFn,
		),
		"uma gravacao que nao e a ultima desiste antes de dormir se o jogador sai ou o servidor fecha -- L4",
	);
	check(
		/if \(c\.failingShown \|\| asked\) notifyStore\(s, "saved", answer\);/.test(writeFn) &&
			/const told = !release && changed && wasDirty;/.test(writeFn),
		'"Progress not saved" sai quando o save volta ao que o DataStore tem (L2) -- e o amanhecer que perguntou ouve "saved" (BEM-04, dawnAsks); o refresh da trava nao e anunciado (L6)',
	);
	// the events the server names where they happen (the others are found by `noteMilestones`, test:body 32)
	check(
		/Cadence\.backpackEvent\(outcome\)[^]*?saveSoon\(s, ev\)/.test(main) &&
			/sim\.onDayCredit = [^]*?saveSoon\(s, "day"\)/.test(main) &&
			/saveSoon\(s, req\.kind === "rebirth" \? "revive" : req\.kind === "newRun" \? "life" : "purchase"\)/.test(
				main,
			) &&
			/Cadence\.noteMilestones\(s\.cadence, s\.save\)/.test(
				between("function serveEventSaves(", "const WALLET_PUSH_S"),
			),
		"os eventos ligados: compra / Rebirth / New game na loja, dia na meia-noite, skill e craft raro na mochila, o resto pela olhada de 1 s",
	);
	check(
		/export function createRemotes\(\)[^]*?return \{\s*loadRequest[^}]*shopAction[^}]*\};/.test(
			src("shared/net/net.ts"),
		) && (src("shared/net/net.ts").match(/ensureRemote\(net, /g) ?? []).length === 5,
		"nenhum remote novo de salvar: os cinco de sempre (o SaveRequest e o relatorio)",
	);
	const pause = src("client/ui/pauseMenu.ts");
	const client = src("client/main.client.ts") + src("client/systems/saveClient.ts");
	check(
		/key: "Back to game"/.test(pause) &&
			!/key: "Save"|onSave\s*[?:(]|handlers\.onSave/.test(pause) &&
			!/"manual"|manualQueued|manualInFlight|onSave\s*:/.test(client),
		'sem o botao "Save" no menu da partida, sem o motivo "manual" e sem o handler no cliente',
	);
	const LANG = new Set(require(join(SRC, "shared/data/lang.ts")).LANG_TABLE);
	check(
		!LANG.has("Save") &&
			["Saving...", "Saved", "Progress not saved — retrying", "Progress not saved"].every(k => LANG.has(k)),
		'lang.ts: "Save" saiu; os textos do indicador estao la',
	);
	// "Progress saved" was the Save button's toast, and it lied (a report, not a write). It came back in ONE place only
	// (DESIGN_RULES BEM-04): the dawn card's line for the server's "saved" push -- a write that landed -- and nowhere else
	const said = [];
	/** the code of a file without its comments: a comment may talk about the line, only code can show it */
	const code = text => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
	(function walk(dir) {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (
				p.endsWith(".ts") &&
				!p.endsWith("lang.ts") &&
				code(readFileSync(p, "utf8")).includes('"Progress saved"')
			)
				said.push(p.slice(SRC.length + 1));
		}
	})(SRC);
	const card = src("client/ui/dawnCard.ts");
	check(
		said.length === 1 &&
			said[0] === join("client", "ui", "dawnCard.ts") &&
			/saved: \{ key: "Progress saved"/.test(card) &&
			/const older = state === "saved" && !answersDawn;/.test(card) &&
			/if \(shown === "saved"\) this\.savedAt = now;/.test(card),
		'"Progress saved" so no cartao do amanhecer, e so no "saved" que responde a pergunta do amanhecer (answersDawn, BEM-04)',
		said.join(", "),
	);
	// BEM-04: the dawn is an event of the list -- the server asks for the write for each survivor standing at 06:00,
	// through the same coalesced saveSoon (the real server does it in test:body)
	const cadenceSrc = src("server/save/saveCadence.ts");
	const simSrc = src("server/sim/simulation.ts");
	const mainSrc = src("server/main.server.ts");
	check(
		/\| "dawn"/.test(cadenceSrc) &&
			/for \(const sp of this\.roster\) \{\s*if \(sp\.state\.dead\) continue;[^}]*this\.onDawn\(sp, /.test(
				simSrc,
			) &&
			/sim\.onDawn = \(sp, livedNight\) => \{[^}]*s\.dawnAsks \+= 1;\s*saveSoon\(s, "dawn"\);/.test(mainSrc) &&
			/const answer = !release && s\.dawnAsks > s\.dawnAnswered \? s\.dawnAsks : undefined;[^]*?const json = HttpService\.JSONEncode\(s\.save\);/.test(
				src("server/main.server.ts"),
			),
		'o amanhecer vivo e um save por evento ("dawn"): a simulacao avisa quem esta de pe, o main.server pede o saveSoon e a resposta dele (dawnAsks), lida ANTES de codificar o save',
	);
}

section(
	"33) uma run assistida (§9.3) nao ganha Camp Cook, Metalworker nem Woodpile: a comida, o lingote e a madeira sim",
);
{
	// the verification of 2026-09-24: the kill, the night, the boss and the lamp asked `paysRewards`, and these did not --
	// an admin-assisted run still counted Chef (Camp Cook), Blacksmith (Metalworker) and Woods collector (Woodpile).
	// Through the REAL simulation: its ServerCraft and its ServerInteraction (pickup, search) get the same check
	const W2 = require(join(SRC, "shared/game/world.ts"));
	const wood = ETC_ITEMS.findIndex(e => e.name === "Wood");
	const plain = r => r.craftKind !== 1 && !r.needsDesk && !r.needsPro;
	const cook = CRAFT_RECIPES.find(r => plain(r) && r.needsCook === true);
	const smelt = CRAFT_RECIPES.find(r => plain(r) && r.needsFire === true && r.needsCook !== true);
	const give = (s, recipe) => {
		for (const ing of recipe.ingredients) {
			if (ing.kind === ItemKind.Etc) s.invenEtc[ing.index] = ing.count;
			if (ing.kind === ItemKind.Weapon) s.invenWeapon[ing.index] = ing.count;
			if (ing.kind === ItemKind.Use) s.invenUse[ing.index] = ing.count;
			if (ing.kind === ItemKind.Equip) s.invenEquip[ing.index] = ing.count;
		}
	};
	const runOnce = assisted => {
		const world = W2.serverWorld(createWorld(4000, 4000));
		const clock = new WorldClock({ day: 1, dayTime: 12 });
		const sim = new ServerSimulation({ world, clock, zombies: false, interactive: true });
		sim.paysRewards = () => !assisted;
		// a lit brazier beside the cook (it cooks and it smelts), a house with wood in it for the searcher
		W2.addSolid(world, {
			kind: "structure",
			x: 1040,
			y: 970,
			w: 96,
			h: 64,
			hp: 200,
			hpMax: 200,
			destructible: false,
			tags: "brazier",
			powered: true,
		});
		W2.addSolid(world, {
			kind: "building",
			x: 2600,
			y: 2600,
			w: 400,
			h: 400,
			hp: 100,
			hpMax: 100,
			destructible: false,
			tags: "house",
			buildingType: 0,
			passable: true,
			lootSlots: 1,
			lootItems: [{ kind: ItemKind.Etc, id: wood, count: 4 }],
			lootTimer: 0,
		});
		const add = (slot, x, y) => {
			const sp = createServerPlayer(
				{ slot, userId: 900 + slot, name: `p${slot}` },
				SAVE.defaultSave(),
				x,
				y,
				0,
				60,
			);
			sim.add(sp);
			sp.state.x = x;
			sp.state.y = y;
			return sp;
		};
		const chef = add(0, 1000, 1000);
		const picker = add(1, 3500, 1000);
		const searcher = add(2, 2700, 2700);
		const outs = [cook, smelt].map(recipe => {
			give(chef.save, recipe);
			sim.craft.step(1);
			return sim.craft.craft(0, chef.state, chef.save, recipe.id);
		});
		W2.spawnGroundItem(world, ItemKind.Etc, wood, 3, 3510, 1000);
		const act = sp =>
			sim.interaction.act({ slot: sp.slot, state: sp.state, save: sp.save, players: [], zombies: [], hours: 12 });
		const picked = act(picker);
		const searched = act(searcher);
		const a = s => s.achievements;
		return {
			got:
				outs.every(o => o.kind === "crafted" && o.count > 0) &&
				picked.kind === "item" &&
				searched.kind === "search" &&
				picker.save.invenEtc[wood] === 3 &&
				searcher.save.invenEtc[wood] === 4,
			chef: a(chef.save)[AID.Chef],
			smith: a(chef.save)[AID.Blacksmith],
			woods: a(picker.save)[AID.WoodsCollector] + a(searcher.save)[AID.WoodsCollector],
			detail: `${outs.map(o => o.kind).join(",")} / ${picked.kind} / ${searched.kind}`,
		};
	};
	const paid = runOnce(false);
	const helped = runOnce(true);
	check(
		paid.got && paid.chef > 0 && paid.smith > 0 && paid.woods === 7,
		"uma run que paga: cozinhar, fundir, pegar e revistar madeira movem Camp Cook, Metalworker e Woodpile",
		`${paid.detail}; Chef ${paid.chef}, Blacksmith ${paid.smith}, Woods ${paid.woods}`,
	);
	check(
		helped.got && helped.chef === 0 && helped.smith === 0 && helped.woods === 0,
		"uma run assistida: a comida, o lingote e a madeira entram na mochila, e nenhuma dessas conquistas anda",
		`${helped.detail}; Chef ${helped.chef}, Blacksmith ${helped.smith}, Woods ${helped.woods}`,
	);
}

section(
	"34) v7 (MON-05): os contadores dos titulos -- migracao v6 -> v7, so o servidor os move, a carteira so os aumenta",
);
{
	const TS = TIT.TitleStat;
	const N = TIT.TITLE_STAT_COUNT;
	// a v6 document with every field that matters populated (the production shape through v4, then v5 and v6's)
	const v6 = SAVE.sanitizeStoredSave(productionV4());
	v6.titles[TIT.TitleId.Survivor] = 1;
	v6.titles[TIT.TitleId.HordeBreaker] = 1;
	v6.zombieKills = 1234;
	v6.lifeNights = 9;
	v6.lifeDeaths = 1;
	v6.equipTitle = TIT.TitleId.HordeBreaker;
	v6.titleEpoch = 1790000000;
	const doc = JSON.parse(JSON.stringify(v6));
	doc.version = 6;
	delete doc.titleStats;
	doc.titles = doc.titles.slice(0, 3);
	const migrated = SAVE.sanitizeStoredSave(doc);
	checkEq(SAVE.storedVersion(doc), 6, "o documento se declara v6");
	checkEq(migrated.version, 7, "e sai v7");
	checkArrayEq(migrated.titleStats, new Array(N).fill(0), "titleStats ausente no v6: tudo 0 (ninguem contou antes)");
	checkEq(migrated.titles.length, TIT.TITLES.length, "a lista de titulos cresce ate a tabela (os novos em 0)");
	const strip = s => {
		const o = JSON.parse(JSON.stringify(s));
		delete o.titleStats;
		delete o.version;
		o.titles = o.titles.slice(0, 3);
		return JSON.stringify(o);
	};
	check(
		strip(migrated) === strip(v6),
		"e nenhum campo do v6 muda de valor (titulos, abates, noites, epoca, escolha)",
	);

	// the v7 document round trip, and junk read defensively
	migrated.titleStats[TS.NightsSurvived] = 12;
	migrated.titleStats[TS.ZombieKinds] = 0b10101;
	migrated.titleStats[TS.GunKills] = 77;
	const again = SAVE.sanitizeStoredSave(JSON.parse(JSON.stringify(migrated)));
	checkArrayEq(again.titleStats, migrated.titleStats, "o v7 gravado (JSON) volta com os contadores");
	const junk = JSON.parse(JSON.stringify(migrated));
	junk.titleStats = [-5, 999, 99, 1.7, "x", 1e12, null, 4, 4];
	const read = SAVE.sanitizeStoredSave(junk);
	checkArrayEq(
		read.titleStats,
		[0, 31, 15, 1, 0, SAVE.SAVE_LIMITS.COUNTER_MAX, 0],
		"lixo: negativo 0, bits no maximo deles (5 tipos de zumbi, 4 chefes), fracao para baixo, texto 0, teto e excesso cai",
	);
	junk.titleStats = "nope";
	checkArrayEq(SAVE.sanitizeStoredSave(junk).titleStats, new Array(N).fill(0), "e uma lista que nao e lista vira 0");

	// a report cannot write them: the sanitizer copies the trusted ones, and the report's pin flags the try
	const base = SAVE.defaultSave();
	base.titleStats[TS.Builds] = 3;
	const forged = JSON.parse(JSON.stringify(base));
	forged.titleStats = [25, 31, 15, 500, 100, 25, 50];
	const upd = SAVE.sanitizeClientReport(forged, base);
	checkArrayEq(upd.titleStats, base.titleStats, "um relatorio com titleStats forjado nao move nada");
	const ACH = require(join(SRC, "server/save/achievements.ts"));
	const upd2 = SAVE.sanitizeClientReport(forged, base);
	upd2.titleStats[TS.Builds] = 24; // a regression in the sanitizer, simulated: the pin still holds
	const tried = ACH.stripClientAchievements(base, upd2, forged);
	check(
		tried && upd2.titleStats[TS.Builds] === 3 && upd2.titleStats !== base.titleStats,
		"o pin do relatorio (stripClientAchievements) ve a tentativa e fixa os contadores do servidor (copia, nao alias)",
	);

	// lifetime: a New game, a copy in place and the end of a world keep them
	const life = SAVE.defaultSave();
	life.titleStats[TS.Crafts] = 40;
	SAVE.resetRun(life);
	checkEq(life.titleStats[TS.Crafts], 40, "o New game guarda os contadores (sao da pessoa, nao da vida)");
	const live = SAVE.defaultSave();
	const liveStats = live.titleStats;
	SAVE.copySaveInto(live, life);
	check(
		live.titleStats === liveStats && live.titleStats[TS.Crafts] === 40,
		"copySaveInto copia no lugar (a identidade fica)",
	);

	// the wallet: carried, and only ever raised on the client (a count the larger, a set of bits the union)
	const server = SAVE.defaultSave();
	server.titleStats[TS.GunKills] = 120;
	server.titleStats[TS.ZombieKinds] = 0b00011;
	const w = SAVE.walletOf(server);
	checkArrayEq(w.titleStats, server.titleStats, "a carteira leva os contadores");
	const client = SAVE.defaultSave();
	client.titleStats[TS.GunKills] = 130; // a newer wallet already landed
	client.titleStats[TS.ZombieKinds] = 0b01100;
	SAVE.applyWallet(client, JSON.parse(JSON.stringify(w)));
	check(
		client.titleStats[TS.GunKills] === 130 && client.titleStats[TS.ZombieKinds] === 0b01111,
		"uma carteira atrasada nao baixa a contagem, e os tipos se unem (nenhum bit volta atras)",
		JSON.stringify(client.titleStats),
	);
	const older = SAVE.defaultSave();
	SAVE.applyWallet(older, { money: 0, titles: [] });
	checkArrayEq(
		older.titleStats,
		new Array(N).fill(0),
		"uma carteira de um servidor antigo (sem titleStats) nao muda nada",
	);

	// ROLLBACK v7 -> v6 -> v7, documented (DESIGN_RULES MON-05 "Save v7"): v6 code keeps the first three titles and the
	// kill count (and the record holds them), and drops the rest; the kill titles come back at the next kill by
	// themselves, since their goal is `zombieKills`
	const vet = SAVE.defaultSave();
	for (let i = 0; i < TIT.EXTERMINATOR_KILLS; i++) creditZombieKill(vet);
	check(SAVE.ownsTitle(vet, TIT.TitleId.Exterminator), "(1.000 abates: Exterminator)");
	const v6doc = JSON.parse(JSON.stringify(vet));
	delete v6doc.titleStats;
	v6doc.titles = v6doc.titles.slice(0, 3);
	const back = SAVE.sanitizeStoredSave(v6doc);
	check(
		SAVE.ownsTitle(back, TIT.TitleId.HordeBreaker) && !SAVE.ownsTitle(back, TIT.TitleId.Exterminator),
		"depois de um rollback para v6: Horde Breaker e os abates ficam, o Exterminator se perdeu",
	);
	checkArrayEq(
		[...creditZombieKill(back)],
		[TIT.TitleId.Exterminator],
		"e o proximo abate o devolve (o objetivo dele e a contagem, que sobreviveu)",
	);
}

// ---------------------------------------------------------------- verdict

console.log("");
if (failures > 0) {
	console.log(`${failures} de ${checks} verificacao(oes) falharam`);
	process.exit(1);
}
console.log(`${checks} verificacoes, 0 falhas`);
