#!/usr/bin/env node
/*
 * The titles past the first three, and the Supporter subscription (docs/DESIGN_RULES.md MON-05, MON-07).
 *
 *   node tools/test-titles.mjs
 *   PZ_SRC=path/to/src node tools/test-titles.mjs
 *
 * 1. THE TABLE (shared/data/titles.ts): ids are their index and never move (the save keeps a flag per id, the wire
 *    carries id + 1 in a byte), every rarity is one of five and all five are used, a secret is a few and not all, every
 *    counter a title reads is one the server keeps, and every word a screen shows is in lang.ts.
 * 2. EVERY TRIGGER, on the pure credits (server/save/titles.ts): each title at its goal and not one short, exactly once,
 *    with junk ignored and every counter bounded -- and the thousands of events that unlock nothing allocate nothing.
 * 3. THE SERVER'S OWN PATHS: the kill credit (server/sim/progress.ts: kinds, firearms, a turret's kill, a boss), a
 *    whole night through the REAL ServerSimulation (the storm the town rolled, the tally of kills and hurts, four who
 *    lived it together, the secret ones, an assisted run that earns none), the craft the backpack reports, a
 *    construction placed and a vault cracked -- each announced once, for the one who earned it.
 * 4. NOBODY ELSE GRANTS ONE: only server/save/titles.ts writes a flag or a counter (a scan of src/).
 * 5. THE SUPPORTER (server/supporter/supporter.ts, client/systems/supporterClient.ts) against a fake MarketplaceService
 *    and fake Players: no id configured = nothing asked, nothing marked; an active subscription marks the Player, a
 *    lapsed one takes the mark off; a status event only makes the server ask; a failing ask retries and keeps the last
 *    answer; a prompt that tried is checked again; a flip is counted, a first answer is not; a client's own mark never
 *    reaches the server's answer; nothing is kept for a player who left; and the mark is NEVER a title.
 *
 * Pure Node (>= 18) + the project's TypeScript, through tools/luau-shim.mjs.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { installShims } from "./luau-shim.mjs";

const { SRC, require } = installShims({ seed: 1 });

// Luau's pcall, and the one yield the supporter's status call makes (none, here: the fake answers at once)
globalThis.pcall ??= (fn, ...a) => {
	try {
		return [true, fn(...a)];
	} catch (e) {
		return [false, e instanceof Error ? e.message : e];
	}
};
// Luau's string.char, which shared/admin/ops.ts reads at load (its safeText)
globalThis.string ??= {};
globalThis.string.char ??= (...codes) => String.fromCharCode(...codes);

const TIT = require(join(SRC, "shared/data/titles.ts"));
const SAVE = require(join(SRC, "shared/game/save.ts"));
const SRV = require(join(SRC, "server/save/titles.ts"));
const { LANG_TABLE } = require(join(SRC, "shared/data/lang.ts"));
const { WeaponKind } = require(join(SRC, "shared/data/kinds.ts"));
const { Weather } = require(join(SRC, "shared/sim/weather.ts"));
const { Progress } = require(join(SRC, "server/sim/progress.ts"));
const { ServerSimulation } = require(join(SRC, "server/sim/simulation.ts"));
const { WorldClock } = require(join(SRC, "server/sim/waves.ts"));
const { createServerPlayer, ingestInput } = require(join(SRC, "server/sim/players.ts"));
const P = require(join(SRC, "shared/net/protocol.ts"));
const { createWorld } = require(join(SRC, "shared/game/world.ts"));
const SUP = require(join(SRC, "shared/data/supporter.ts"));
const SUPSRV = require(join(SRC, "server/supporter/supporter.ts"));
const { applyPlayerDamage } = require(join(SRC, "shared/game/player.ts"));
const { ServerVaults } = require(join(SRC, "server/sim/vault.ts"));
const VAULT = require(join(SRC, "shared/sim/vault.ts"));
const OPS = require(join(SRC, "shared/admin/ops.ts"));

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

function same(a, b) {
	return JSON.stringify([...a]) === JSON.stringify([...b]);
}

function section(title) {
	console.log(`\n${title}`);
}

const ID = TIT.TitleId;
const TS = TIT.TitleStat;
const LANG = new Set(LANG_TABLE);

// ---------------------------------------------------------------- 1. the table

section("1) a tabela: ids fixos, raridades, segredos, contadores do servidor e todo texto na lang.ts");
{
	check(
		TIT.TITLES.every((t, i) => t.id === i),
		"cada id e o indice da linha (o save guarda uma marca por id: reordenar trocaria os titulos de todos)",
	);
	check(
		TIT.TITLES[ID.Survivor].name === "Survivor" &&
			TIT.TITLES[ID.HordeBreaker].name === "Horde Breaker" &&
			TIT.TITLES[ID.WeekOne].name === "Week One",
		"os tres primeiros continuam onde estavam (0, 1, 2)",
	);
	checkEq(TIT.TITLES.length, 25, "25 titulos: os 3 de antes e 22 novos");
	check(TIT.TITLE_WIRE_MAX === TIT.TITLES.length && TIT.TITLE_WIRE_MAX <= 255, "o byte do fio (id + 1) cabe num u8");
	check(new Set(TIT.TITLES.map(t => t.name)).size() === TIT.TITLES.length, "nenhum nome repetido");
	const rarities = new Set(TIT.TITLE_RARITIES);
	check(
		TIT.TITLES.every(t => rarities.has(t.rarity)) &&
			TIT.TITLE_RARITIES.every(r => TIT.TITLES.some(t => t.rarity === r)),
		"cada titulo tem uma das cinco raridades, e as cinco sao usadas",
		TIT.TITLE_RARITIES.map(r => `${r} ${TIT.TITLES.filter(t => t.rarity === r).length}`).join(", "),
	);
	const secrets = TIT.TITLES.filter(t => t.secret === true);
	check(
		secrets.length >= 2 && secrets.length <= 4,
		"uns poucos segredos (2 a 4)",
		secrets.map(t => t.name).join(", "),
	);
	check(
		TIT.TITLES.every(t => {
			const needsStat = t.track === "stat" || t.track === "bits";
			if (needsStat !== (t.stat !== undefined)) return false;
			if (needsStat && (t.stat < 0 || t.stat >= TIT.TITLE_STAT_COUNT)) return false;
			if (t.track === "bits" && !TIT.titleStatIsBits(t.stat)) return false;
			if (t.track === "stat" && TIT.titleStatIsBits(t.stat)) return false;
			return Number.isInteger(t.goal) && t.goal >= 1 && (t.track !== "none" || t.goal === 1);
		}),
		"o progresso de cada um le um contador que o servidor mantem, com a meta inteira (1 para um titulo de uma vez so)",
	);
	check(
		TIT.TITLES.every(t => t.track === "none" || (t.progressLabel !== "" && LANG.has(t.progressLabel))),
		"o rotulo do progresso de cada um esta na lang.ts",
	);
	const missing = [];
	for (const t of TIT.TITLES) {
		for (const k of [t.name, t.howTo, TIT.rarityName(t.rarity), TIT.rarityKeyName(t.rarity)]) {
			if (!LANG.has(k)) missing.push(k);
		}
	}
	check(
		missing.length === 0,
		"nome, como ganhar e a raridade (e a tecla em maiusculas) de todos na lang.ts",
		missing.join(" | "),
	);
	const ordered = TIT.titlesInOrder();
	check(
		ordered.length === TIT.TITLES.length &&
			new Set(ordered.map(t => t.id)).size() === TIT.TITLES.length &&
			ordered.every((t, i) => i === 0 || TIT.rarityRank(ordered[i - 1].rarity) <= TIT.rarityRank(t.rarity)),
		"o guarda-roupa os lista do comum ao lendario, todos, uma vez cada",
	);
	check(
		!TIT.TITLES.some(t => /support/i.test(t.name)) &&
			!/from "shared\/data\/titles"/.test(readFileSync(join(SRC, "shared/data/supporter.ts"), "utf8")),
		"a marca Supporter NAO e um titulo: nenhuma linha dela na tabela, e a assinatura nao importa os titulos",
	);
	// the bits helpers, in plain arithmetic (Luau has no JS bit operators)
	check(
		TIT.withBit(0, 4) === 16 &&
			TIT.withBit(16, 4) === 16 &&
			TIT.hasBit(0b10100, 2) &&
			!TIT.hasBit(0b10100, 1) &&
			TIT.bitCount(0b10111, 5) === 4 &&
			TIT.unionBits(0b0011, 0b0110, 8) === 0b0111,
		"os bits: marcar e idempotente, contar e unir sem operadores de bit",
	);
}

// ---------------------------------------------------------------- 2. the pure credits

section("2) cada gatilho na meta e nao um antes, uma vez so, lixo ignorado, contadores limitados, sem alocar");
{
	const fresh = () => SAVE.defaultSave();
	// kills: 100 / 1,000 / 10,000
	const k = fresh();
	const got = [];
	for (let i = 0; i < TIT.ZOMBIE_BANE_KILLS; i++) got.push(...SRV.creditZombieKill(k));
	check(
		same(got, [ID.HordeBreaker, ID.Exterminator, ID.ZombieBane]),
		"abates: Horde Breaker, Exterminator e Zombie Bane, nessa ordem, uma vez cada",
		JSON.stringify(got),
	);
	const kk = fresh();
	for (let i = 0; i < TIT.EXTERMINATOR_KILLS - 1; i++) SRV.creditZombieKill(kk);
	check(!SAVE.ownsTitle(kk, ID.Exterminator), "999 abates: ainda nao Exterminator");
	check(
		SRV.creditZombieKill(fresh()) === SRV.creditZombieKill(fresh()),
		"um abate que nao desbloqueia nada devolve a MESMA lista vazia (nenhuma alocacao por abate)",
	);
	// Tracker: every kind, and only real kinds
	const tr = fresh();
	for (const junk of [0, 6, 1.5, NaN, "1", -1, undefined]) SRV.creditZombieKill(tr, junk);
	checkEq(tr.titleStats[TS.ZombieKinds], 0, "tipos lixo (0, 6, fracao, NaN, texto) nao marcam nada");
	let tracked = [];
	for (const t of [1, 1, 2, 3, 4]) tracked.push(...SRV.creditZombieKill(tr, t));
	check(
		tracked.length === 0 && TIT.bitCount(tr.titleStats[TS.ZombieKinds], 5) === 4,
		"quatro tipos: ainda nao Tracker",
	);
	tracked = [...SRV.creditZombieKill(tr, 5)];
	check(same(tracked, [ID.Tracker]), "o quinto tipo (Jumper) faz o Tracker");
	check(SRV.creditZombieKill(tr, 5).length === 0, "e so uma vez");
	// Sharpshooter: firearms only
	const sh = fresh();
	for (const kind of [WeaponKind.Melee, WeaponKind.Bow, WeaponKind.Special, -1, undefined])
		SRV.creditZombieKill(sh, 1, kind);
	checkEq(
		sh.titleStats[TS.GunKills],
		0,
		"faca, arco, lanca-chamas e o desconhecido (um atropelo) nao contam como arma de fogo",
	);
	const guns = [WeaponKind.Rifle, WeaponKind.Pistol, WeaponKind.MG, WeaponKind.Shotgun, WeaponKind.Sniper];
	for (const kind of guns) SRV.creditZombieKill(sh, 1, kind);
	checkEq(sh.titleStats[TS.GunKills], 5, "as cinco armas de fogo contam");
	for (let i = 5; i < TIT.SHARPSHOOTER_KILLS - 1; i++) SRV.creditZombieKill(sh, 1, WeaponKind.Pistol);
	check(!SAVE.ownsTitle(sh, ID.Sharpshooter), "499: ainda nao Sharpshooter");
	check(
		SRV.creditZombieKill(sh, 1, WeaponKind.Rifle).includes(ID.Sharpshooter),
		"o 500o com arma de fogo: Sharpshooter",
	);
	// Sentry, Boss Hunter, Apex Hunter
	const se = fresh();
	let sentry = [];
	for (let i = 0; i < TIT.SENTRY_KILLS; i++) sentry.push(...SRV.creditMachineTitles(se));
	check(
		same(sentry, [ID.Sentry]) && se.zombieKills === 0,
		"100 abates de torreta: Sentry (e nenhum abate SEU, MON-05)",
	);
	const bo = fresh();
	check(
		SRV.creditBossTitles(bo, 0).length === 0 &&
			SRV.creditBossTitles(bo, 5).length === 0 &&
			SRV.creditBossTitles(bo, "1").length === 0,
		"chefe lixo nao conta",
	);
	check(same(SRV.creditBossTitles(bo, 3), [ID.BossHunter]), "o primeiro chefe: Boss Hunter");
	check(
		SRV.creditBossTitles(bo, 3).length === 0 && SRV.creditBossTitles(bo, 1).length === 0,
		"o mesmo, e um segundo tipo: nada novo",
	);
	check(
		same(SRV.creditBossTitles(bo, 2), []) && same(SRV.creditBossTitles(bo, 4), [ID.ApexHunter]),
		"os quatro tipos: Apex Hunter",
	);
	checkEq(bo.titleStats[TS.BossKinds], 15, "os quatro bits dos chefes");
	// the nights of one life
	const li = fresh();
	const nights = [];
	for (let n = 1; n <= TIT.CENTURION_NIGHTS; n++) for (const t of SRV.creditLifeNight(li)) nights.push([n, t]);
	check(
		JSON.stringify(nights) ===
			JSON.stringify([
				[7, ID.WeekOne],
				[10, ID.Unbroken],
				[25, ID.Seasoned],
				[50, ID.OldGuard],
				[100, ID.Centurion],
			]),
		"uma vida sem morte: Week One (7), Unbroken (10), Seasoned (25), Old Guard (50), Centurion (100)",
		JSON.stringify(nights),
	);
	const died = fresh();
	died.lifeDeaths = 1;
	for (let n = 1; n <= 30; n++) SRV.creditLifeNight(died);
	check(
		!SAVE.ownsTitle(died, ID.Unbroken) && SAVE.ownsTitle(died, ID.Seasoned),
		"uma vida que ja morreu: Seasoned sim, Unbroken nao",
	);
	// a night lived, and what it had
	const night = over => ({
		kills: 0,
		otherKills: 0,
		hurt: true,
		lowestShare: 0.5,
		weather: Weather.Clear,
		rolledWeather: Weather.Clear,
		worldDay: 3,
		livedTogether: 1,
		...over,
	});
	const lived = (over, save = fresh()) => [...SRV.creditNightLived(save, night(over))];
	check(same(lived({}), [ID.Survivor]), "uma noite inteira, nada mais: Survivor");
	check(
		same(lived({ hurt: false, kills: 10 }), [ID.Survivor, ID.Untouched]),
		"sem perder vida, 10 abates: Untouched",
	);
	check(
		!lived({ hurt: false, kills: 9 }).includes(ID.Untouched) &&
			!lived({ hurt: true, kills: 40 }).includes(ID.Untouched),
		"9 abates, ou um arranhao: nao",
	);
	check(
		lived({ kills: 25 }).includes(ID.BladeDancer) && !lived({ kills: 25, otherKills: 1 }).includes(ID.BladeDancer),
		"25 abates so de corpo a corpo: Blade Dancer; um tiro no meio: nao",
	);
	check(
		lived({ weather: Weather.Storm, rolledWeather: Weather.Storm }).includes(ID.Stormborn),
		"a tempestade da cidade: Stormborn",
	);
	check(
		!lived({ weather: Weather.Storm, rolledWeather: Weather.Clear }).includes(ID.Stormborn),
		"uma tempestade posta pelo admin: nao (nao e o ceu da cidade)",
	);
	check(
		lived({ weather: Weather.Fog, rolledWeather: Weather.Fog }).includes(ID.FogWalker) &&
			lived({ weather: Weather.DawnFog, rolledWeather: Weather.DawnFog }).includes(ID.FogWalker) &&
			!lived({ weather: Weather.Rain, rolledWeather: Weather.Rain }).includes(ID.FogWalker),
		"neblina (o dia inteiro ou ao amanhecer): Fog Walker; chuva: nao",
	);
	check(
		lived({ livedTogether: 4 }).includes(ID.SafetyInNumbers) &&
			!lived({ livedTogether: 3 }).includes(ID.SafetyInNumbers),
		"quatro que viveram a mesma noite: Safety in Numbers; tres: nao",
	);
	check(
		lived({ worldDay: 10, kills: 0, hurt: false }).includes(ID.Ghost) &&
			!lived({ worldDay: 9, kills: 0, hurt: false }).includes(ID.Ghost) &&
			!lived({ worldDay: 12, kills: 1, hurt: false }).includes(ID.Ghost) &&
			!lived({ worldDay: 12, kills: 0, hurt: true }).includes(ID.Ghost),
		"Ghost (segredo): do dia 10 do mundo em diante, nenhum abate, nenhum arranhao -- e nada disso no dia 9, com um abate ou ferido",
	);
	check(
		lived({ lowestShare: 0.1 }).includes(ID.CloseCall) && !lived({ lowestShare: 0.11 }).includes(ID.CloseCall),
		"Close Call (segredo): a vida a um decimo ou menos, e a noite vivida",
	);
	const nw = fresh();
	const watch = [];
	for (let n = 1; n <= TIT.NIGHTWATCH_NIGHTS; n++) watch.push(...SRV.creditNightLived(nw, night({})));
	check(
		same(watch, [ID.Survivor, ID.Nightwatch]) && nw.titleStats[TS.NightsSurvived] === 25,
		"25 noites inteiras: Nightwatch (e o Survivor da primeira), uma vez cada",
	);
	// the verbs
	const bu = fresh();
	const built = [];
	for (let i = 0; i < TIT.BUILDER_BUILDS; i++) built.push(...SRV.creditBuilt(bu));
	check(same(built, [ID.Builder]), "25 construcoes: Builder");
	const cr = fresh();
	check(
		SRV.creditCrafted(cr, 0).length === 0 &&
			SRV.creditCrafted(cr, -3).length === 0 &&
			SRV.creditCrafted(cr, NaN).length === 0 &&
			SRV.creditCrafted(cr, "9").length === 0,
		"craft lixo nao conta",
	);
	for (let i = 0; i < 24; i++) SRV.creditCrafted(cr, 2);
	check(
		!SAVE.ownsTitle(cr, ID.Tinkerer) && same(SRV.creditCrafted(cr, 2), [ID.Tinkerer]),
		"48 itens (um Chef dobrado conta dois): nao; 50: Tinkerer",
	);
	const va = fresh();
	check(
		same(SRV.creditVault(va), [ID.Safecracker]) && SRV.creditVault(va).length === 0,
		"um cofre arrombado: Safecracker, uma vez",
	);
	// bounded
	const cap = fresh();
	cap.titleStats[TS.GunKills] = SAVE.SAVE_LIMITS.COUNTER_MAX;
	SRV.creditZombieKill(cap, 1, WeaponKind.Pistol);
	checkEq(cap.titleStats[TS.GunKills], SAVE.SAVE_LIMITS.COUNTER_MAX, "um contador no teto fica no teto");
}

// ---------------------------------------------------------------- 3. the server's own paths

section(
	"3) pelos caminhos do servidor: o credito de abate, a noite inteira na simulacao real, o craft, a obra, o cofre",
);
{
	// (a) the kill credit (server/sim/progress.ts), killer and assists, turrets, bosses, an assisted run
	const saves = new Map([
		[0, SAVE.defaultSave()],
		[1, SAVE.defaultSave()],
	]);
	const told = [];
	const nightKills = [];
	let pays = true;
	const prog = new Progress({
		saveOf: slot => saves.get(slot),
		paysRewards: () => pays,
		titleUnlocked: (slot, t) => told.push([slot, t]),
		killCredited: (slot, type, kind) => nightKills.push([slot, type, kind]),
	});
	let zid = 1;
	for (const type of [1, 2, 3, 4, 5]) {
		prog.noteZombieDamage(zid, 1, 10, 0);
		prog.zombieKilled(zid++, 10, 0, 1, type, WeaponKind.Melee);
	}
	check(
		same(told, [[0, ID.Tracker]]),
		"cinco tipos pelo golpe final do slot 0: Tracker, anunciado so para ele",
		JSON.stringify(told),
	);
	check(
		saves.get(1).titleStats[TS.ZombieKinds] === 0 && saves.get(1).zombieKills === 0,
		"a assistencia (slot 1) nao marca tipo nem abate",
	);
	check(
		nightKills.length === 5 && nightKills.every(([s, , k]) => s === 0 && k === WeaponKind.Melee),
		"a noite conta os cinco golpes finais do slot 0, com a arma",
	);
	for (let i = 0; i < TIT.SENTRY_KILLS; i++) prog.zombieKilled(zid++, 10, 1, 1, 1, -1, true);
	check(
		told.some(([s, t]) => s === 1 && t === ID.Sentry) && saves.get(1).zombieKills === 0,
		"100 abates de torreta do slot 1: Sentry, e nenhum abate dele",
	);
	prog.noteBossDamage(900, 0, 500, 1);
	prog.noteBossDamage(900, 1, 500, 1);
	prog.bossKilled(900, 100, 1000, 0, 2);
	check(
		told.filter(([, t]) => t === ID.BossHunter).length === 2,
		"um chefe com os dois na luta: Boss Hunter para os dois",
	);
	pays = false;
	const before = told.length;
	const helped = SAVE.defaultSave();
	saves.set(0, helped);
	for (const type of [1, 2, 3, 4, 5]) prog.zombieKilled(zid++, 10, 0, 1, type, WeaponKind.Pistol);
	prog.noteBossDamage(901, 0, 500, 1);
	prog.bossKilled(901, 100, 1000, 0, 1);
	check(
		told.length === before && helped.titleStats.every(v => v === 0),
		"uma run assistida (§9.3): nenhum titulo, nenhum contador",
	);

	// (b) a whole night, through the real ServerSimulation: 22:00 of world day 9 to 06:00 of day 10, the town's own
	// storm on day 10
	const world = createWorld(4000, 4000);
	const clock = new WorldClock({ day: 9, dayTime: 22, rollWeather: d => (d === 10 ? Weather.Storm : Weather.Clear) });
	const sim = new ServerSimulation({ world, clock, zombies: false });
	const unlocks = [];
	sim.onTitleUnlocked = (sp, t) => unlocks.push([sp.userId, t]);
	const ASSISTED = 505;
	sim.paysRewards = sp => sp.userId !== ASSISTED;
	const players = [];
	const arrive = (slot, userId) => {
		const save = SAVE.defaultSave();
		const sp = createServerPlayer(
			{ slot, userId, name: `n${slot}` },
			save,
			1000 + slot * 80,
			1400,
			sim.tick,
			sim.simHz,
		);
		sim.add(sp);
		players.push(sp);
		return sp;
	};
	const FIGHTER = arrive(0, 501); // 12 melee kills after midnight, never hurt: Untouched
	const HURT = arrive(1, 502); // drops to 8 % health at 02:00: Close Call
	const QUIET = arrive(2, 503); // no kill, no scratch, on world day 10: Ghost
	const OTHER = arrive(3, 504); // a gun kill and a scratch: only the night's shared ones
	arrive(4, ASSISTED); // an admin helped this run: nothing at all
	// LOW2 (review of 97cd734): bitten at 04:00 and healed back to full before the tick ends -- the hp the tick leaves
	// is what it was, and still that was a bite: no Ghost
	const HEALED = arrive(5, 506);
	const TICK_DT = 1 / sim.simHz;
	const RELOAD = 1 << P.EdgeShift.Reload;
	const press = sp => {
		const cmd = P.makeCommand((sp.lastSeq + 1) % 65536, 0, 0, 0, 0, RELOAD);
		ingestInput(sp, P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [cmd] }), sim.tick * TICK_DT);
	};
	let guard = 60 * 60 * 30;
	let killed = false;
	let hurt = false;
	let scratched = false;
	let bittenAndHealed = false;
	// every hurt through the server's own damage path (shared/game/player.ts), as a bite lands: the body counts it
	const done = () => clock.day === 10 && clock.dayTime >= 6;
	while (!done() && guard-- > 0) {
		for (const sp of players) {
			sp.state.hungry = sp.state.hungryMax;
			press(sp);
		}
		const night = clock.day === 10;
		if (night && clock.dayTime >= 1 && !killed) {
			killed = true;
			// the kill credit's hook, as progress.ts calls it for a killing blow in a run that pays
			for (let i = 0; i < 12; i++) sim.noteNightKill(FIGHTER.slot, WeaponKind.Melee);
			sim.noteNightKill(OTHER.slot, WeaponKind.Pistol);
		}
		if (night && clock.dayTime >= 2 && !hurt) {
			hurt = true;
			applyPlayerDamage(HURT.state, HURT.save, HURT.state.hp - HURT.state.hpMax * 0.08, true);
		}
		if (night && clock.dayTime >= 3 && !scratched) {
			scratched = true;
			applyPlayerDamage(OTHER.state, OTHER.save, 1, true);
		}
		if (night && clock.dayTime >= 4 && !bittenAndHealed) {
			bittenAndHealed = true;
			const hp0 = HEALED.state.hp;
			applyPlayerDamage(HEALED.state, HEALED.save, 30, true);
			HEALED.state.hp = hp0;
		}
		sim.step();
		clock.step(TICK_DT);
	}
	check(guard > 0 && done(), `a simulacao viveu a meia-noite e as 06:00 do dia 10 (${sim.tick} ticks)`);
	const of = sp => unlocks.filter(([u]) => u === sp.userId).map(([, t]) => t);
	const shared = [ID.Survivor, ID.Stormborn, ID.SafetyInNumbers];
	check(
		[FIGHTER, HURT, QUIET, OTHER].every(sp => shared.every(t => of(sp).includes(t))),
		"os quatro que viveram a noite: Survivor, Stormborn (a tempestade da cidade) e Safety in Numbers (4 juntos)",
		JSON.stringify(unlocks),
	);
	check(
		of(FIGHTER).includes(ID.Untouched) && !of(FIGHTER).includes(ID.Ghost),
		"12 abates e nenhum arranhao: Untouched (e nao Ghost)",
	);
	check(of(HURT).includes(ID.CloseCall) && !of(HURT).includes(ID.Untouched), "caiu a 8 % e viveu: Close Call");
	check(of(QUIET).includes(ID.Ghost), "nenhum abate, nenhum arranhao, no dia 10 do mundo: Ghost");
	check(
		!of(OTHER).includes(ID.Ghost) && !of(OTHER).includes(ID.Untouched) && !of(OTHER).includes(ID.CloseCall),
		"um tiro e um arranhao: nenhum dos titulos da noite limpa",
	);
	checkEq(unlocks.filter(([u]) => u === ASSISTED).length, 0, "a run assistida nao ganha titulo nenhum");
	check(
		of(HEALED).includes(ID.Survivor) && !of(HEALED).includes(ID.Ghost) && (HEALED.state.hurts ?? 0) >= 1,
		"LOW2: mordido e curado de volta no mesmo tick (o hp nao caiu entre dois ticks): o golpe conta, nada de Ghost",
		JSON.stringify(of(HEALED)),
	);
	check(
		unlocks.length === new Set(unlocks.map(x => x.join(":"))).size(),
		"cada titulo anunciado uma vez por sobrevivente",
	);
	check(
		players.slice(0, 4).every(sp => sp.save.titleStats[TS.NightsSurvived] === 1),
		"a noite vivida conta para o Nightwatch (titleStats, no save vivo)",
	);

	// (c) the craft the backpack reports, a construction placed, a vault cracked: the simulation's own hooks
	const maker = players[0];
	const heard = unlocks.length;
	sim.backpack.onOutcome(
		maker,
		{ kind: 0, arg: 0, nonce: 1 },
		{ kind: "crafted", recipe: 0, count: TIT.TINKERER_CRAFTS, heat: "cold" },
	);
	check(
		unlocks.slice(heard).some(([u, t]) => u === maker.userId && t === ID.Tinkerer),
		"o craft que o servidor fez (a saida da mochila): Tinkerer",
	);
	for (let i = 0; i < TIT.BUILDER_BUILDS; i++) sim.creditPlaced(maker);
	check(
		unlocks.some(([u, t]) => u === maker.userId && t === ID.Builder),
		"25 obras postas pelo servidor: Builder",
	);
	sim.creditVaultCracked(maker.slot);
	check(
		unlocks.some(([u, t]) => u === maker.userId && t === ID.Safecracker),
		"o cofre que o trabalho dele abriu: Safecracker",
	);
	// LOW3 (review of 97cd734): two survivors at one vault door crack it together -- the real ServerVaults tells the
	// crack for EVERY worker on it, not only for the one its step happened to count; one who walked off gets nothing
	{
		const door = { id: 77, x: 0, y: 0, w: 20, h: 20, tag: VAULT.VAULT_TAG, bankId: 1 };
		const cracked = [];
		const vaults = new ServerVaults({
			world: { solids: [door] },
			out: { queue: () => {} },
			reach: body => body.near !== false,
			onCracked: (d, slot) => cracked.push([d.id, slot]),
		});
		const crowbar = () => {
			const s = SAVE.defaultSave();
			s.invenWeapon[VAULT.VAULT_TOOL_INDEX] = 1;
			return s;
		};
		const crew = [0, 1, 2].map(slot => ({ slot, save: crowbar(), body: { dead: false, near: true } }));
		for (const w of crew) vaults.press(w.slot, w.save, door);
		crew[2].body.near = false; // walked off at once: no longer working it
		for (let t = 0; t < VAULT.VAULT_CRACK_S + 1 && door.open !== true; t += 0.1) {
			for (const w of crew) vaults.hold(w.slot, w.body, w.save, true);
			vaults.step(0.1);
		}
		const slots = cracked.map(([, s]) => s).sort();
		check(
			door.open === true && cracked.every(([id]) => id === 77) && same(slots, [0, 1]),
			"LOW3: dois no mesmo cofre -- o cofre abre e o crack e contado para os DOIS (quem saiu antes, nao)",
			JSON.stringify(cracked),
		);
		const pair = [players[1], players[2]];
		for (const [, slot] of cracked) sim.creditVaultCracked(pair[slot].slot);
		check(
			pair.every(sp => unlocks.some(([u, t]) => u === sp.userId && t === ID.Safecracker)),
			"...e, pelo gancho do servidor, os dois ganham Safecracker",
		);
	}
	const helper = players[4];
	const n = unlocks.length;
	sim.backpack.onOutcome(
		helper,
		{ kind: 0, arg: 0, nonce: 1 },
		{ kind: "crafted", recipe: 0, count: 99, heat: "cold" },
	);
	for (let i = 0; i < 30; i++) sim.creditPlaced(helper);
	sim.creditVaultCracked(helper.slot);
	check(unlocks.length === n && helper.save.titleStats.every(v => v === 0), "a run assistida: nada disso conta");
	const simSrc = readFileSync(join(SRC, "server/sim/simulation.ts"), "utf8");
	check(
		/onVaultCracked: \(_door, slot\) => this\.creditVaultCracked\(slot\)/.test(simSrc) &&
			/if \(placed\.kind === "placed"\) this\.creditPlaced\(sp\);/.test(simSrc) &&
			/killCredited: \(slot, _zombieType, weaponKind\) => this\.noteNightKill\(slot, weaponKind\)/.test(simSrc),
		"e os ganchos estao ligados onde o servidor decide (o cofre da interacao, a obra do build, o golpe do Progress)",
	);
}

// ---------------------------------------------------------------- 3b. an admin's help makes the run assisted

section("3b) M1: a edicao do admin que ajuda a run (item, nivel, pontos, moedas) a torna assistida; baixar, nao");
{
	const base = () => {
		const s = SAVE.defaultSave();
		s.level = 10;
		s.money = 100;
		return s;
	};
	const edited = ops => {
		const before = base();
		const after = SAVE.sanitizeStoredSave(before);
		OPS.applyAdminOps(after, ops);
		return OPS.adminEditHelps(before, after);
	};
	const helps = [
		["moedas 100 -> 500", [{ op: "stat", field: "money", value: 500 }]],
		["nivel 10 -> 20", [{ op: "stat", field: "level", value: 20 }]],
		["XP", [{ op: "stat", field: "exp", value: 50 }]],
		["pontos de habilidade", [{ op: "stat", field: "skillPoint", value: 5 }]],
		["uma arma", [{ op: "item", group: "weapon", index: 3, count: 1, mode: "min" }]],
		["municao", [{ op: "item", group: "ammo", index: 0, count: 100, mode: "set" }]],
		["um material", [{ op: "item", group: "etc", index: 0, count: 10, mode: "min" }]],
		["um usavel", [{ op: "item", group: "use", index: 0, count: 3, mode: "min" }]],
	];
	const notHelp = [
		["moedas 100 -> 0", [{ op: "stat", field: "money", value: 0 }]],
		["nivel 10 -> 5", [{ op: "stat", field: "level", value: 5 }]],
		["um traje (so aparencia, MON-01)", [{ op: "costume", id: 0, owned: true }]],
		["o mesmo nivel", [{ op: "stat", field: "level", value: 10 }]],
	];
	const wrongHelp = helps.filter(([, ops]) => !edited(ops)).map(([w]) => w);
	const wrongNot = notHelp.filter(([, ops]) => edited(ops)).map(([w]) => w);
	check(wrongHelp.length === 0, `ajuda (run assistida): ${helps.map(([w]) => w).join(", ")}`, wrongHelp.join(", "));
	check(wrongNot.length === 0, `nao ajuda: ${notHelp.map(([w]) => w).join(", ")}`, wrongNot.join(", "));
	// a respec hands the same points back: not help; a cosmetic item (an outfit or a pet) is a look, not help
	const spent = base();
	spent.skillLevels[1] = 3;
	spent.skillPoint = 6;
	const respec = SAVE.sanitizeStoredSave(spent);
	OPS.applyAdminOps(respec, [{ op: "resetSkills" }]);
	const { EQUIPS } = require(join(SRC, "shared/data/equips.ts"));
	const { cosmeticSlotOf } = require(join(SRC, "shared/data/cosmetics.ts"));
	const pet = EQUIPS.findIndex((_, i) => cosmeticSlotOf(i) !== 0);
	check(
		respec.skillPoint === 9 &&
			!OPS.adminEditHelps(spent, respec) &&
			pet >= 0 &&
			!edited([{ op: "item", group: "equip", index: pet, count: 1 }]),
		"um resetSkills (os mesmos pontos de volta) e um item cosmetico (traje ou pet) nao sao ajuda",
		`skillPoint ${respec.skillPoint}, cosmetico ${pet}`,
	);
	// the server wires both: the edit in adminEdit, the pickup of an admin's drop in adminWorld
	const main = readFileSync(join(SRC, "server/main.server.ts"), "utf8");
	const world = readFileSync(join(SRC, "server/admin/adminWorld.ts"), "utf8");
	check(
		/const helped = ops !== undefined && adminEditHelps\(before, edited\);/.test(main) &&
			/s\.assistedRunRev === before\.runRev \|\| dayMoved \|\| helped/.test(main) &&
			/function taken\([\s\S]{0,400}deps\.markAssisted\(player\)/.test(world),
		"ligado no servidor: adminEdit marca a run assistida, e quem pega um item que o admin largou tambem (test:body 17, test:admin 22)",
	);
	// L-1 (review of b0174ed): an admin's drop is never walked into, and whoever takes it with E is told, in lang.ts's
	// words, what the assisted run loses -- nothing more
	const RULE = require(join(SRC, "shared/sim/pickupRule.ts"));
	const { ItemKind } = require(join(SRC, "shared/data/kinds.ts"));
	const { spawnGroundItem } = require(join(SRC, "shared/game/world.ts"));
	const wworld = createWorld(2000, 2000);
	const gift = spawnGroundItem(wworld, ItemKind.Etc, 0, 5, 1000, 1000);
	gift.unpaid = true;
	const street = spawnGroundItem(wworld, ItemKind.Etc, 0, 5, 1030, 1000);
	const bare = SAVE.defaultSave();
	check(
		RULE.walkPickupTarget(wworld, 1000, 1000, bare, () => true) === undefined &&
			RULE.walkPickupTarget(wworld, 1030, 1000, bare, () => true) === street,
		"L-1: o walk-over passa por cima do item do admin (so o E o pega), e pega o da cidade ao lado",
	);
	const net = readFileSync(join(SRC, "client/net/netClient.ts"), "utf8");
	const notice = readFileSync(join(SRC, "client/ui/titleNotice.ts"), "utf8");
	// (read from the source: the module draws UI when it loads)
	const ADMIN_ITEM_TEXT = notice.match(/export const ADMIN_ITEM_TEXT = "([^"]+)";/)?.[1] ?? "";
	check(
		/replicator\.adminItem\(slot\)/.test(world) &&
			/e\.msg === AnnounceKind\.AdminItem[\s\S]{0,200}adminItemListeners/.test(net) &&
			/netOnAdminItem\(\(\) => toast\(ctx, langGet\(ADMIN_ITEM_TEXT/.test(notice) &&
			LANG.has(ADMIN_ITEM_TEXT) &&
			/coins/.test(ADMIN_ITEM_TEXT) &&
			/titles/.test(ADMIN_ITEM_TEXT) &&
			/achievements/.test(ADMIN_ITEM_TEXT),
		"L-1: quem pega o item do admin ouve o aviso da lang.ts, so ele: a run nao ganha mais moedas, titulos nem conquistas",
		ADMIN_ITEM_TEXT,
	);
}

// ---------------------------------------------------------------- 3c. the life's deaths reach the wardrobe

section("3c) LOW1: a carteira leva as mortes da vida (o Unbroken do guarda-roupa), e so as da vida atual");
{
	const server = SAVE.defaultSave();
	server.runRev = 3;
	server.lifeDeaths = 2;
	const w = SAVE.walletOf(server);
	const client = SAVE.defaultSave();
	client.runRev = 3;
	SAVE.applyWallet(client, w);
	check(w.lifeDeaths === 2 && client.lifeDeaths === 2, "a carteira do servidor leva lifeDeaths, e o cliente o adota");
	const next = SAVE.defaultSave();
	next.runRev = 4;
	SAVE.applyWallet(next, w);
	check(next.lifeDeaths === 0, "a carteira da vida anterior, chegando atrasada, nao devolve as mortes a vida nova");
	const older = { ...w };
	delete older.lifeDeaths;
	const kept = SAVE.defaultSave();
	kept.runRev = 3;
	kept.lifeDeaths = 1;
	SAVE.applyWallet(kept, older);
	check(kept.lifeDeaths === 1, "a carteira de um servidor antigo (sem o campo) nao mexe em nada");
	const main = readFileSync(join(SRC, "server/main.server.ts"), "utf8");
	check(
		/const achievements = save\.achievements\.join\(","\) \+ `\|\$\{save\.lifeDeaths\}`;/.test(main),
		"a assinatura da carteira inclui lifeDeaths: uma morte empurra a carteira (main.server.ts walletSignature)",
	);
	const onboarding = readFileSync(join(SRC, "client/onboarding/index.ts"), "utf8");
	check(
		/deathsAtRun = ctx\.save\.lifeDeaths;/.test(onboarding) &&
			/\(deathsAtRun \?\? save\.lifeDeaths\) === 0/.test(onboarding),
		"e a tela de morte le as mortes 'como carregadas' (a do run), nao as que a carteira ja trouxe desta morte",
	);
}

// ---------------------------------------------------------------- 4. nobody else grants one

section("4) so server/save/titles.ts escreve um titulo ou um contador de titulo");
{
	const files = [];
	const walk = dir => {
		for (const f of readdirSync(dir)) {
			const p = join(dir, f);
			if (statSync(p).isDirectory()) walk(p);
			else if (p.endsWith(".ts")) files.push(p);
		}
	};
	walk(SRC);
	const writers = [];
	for (const f of files) {
		const rel = relative(SRC, f).replace(/\\/g, "/");
		const src = readFileSync(f, "utf8");
		if (
			/titleStats\[[^\]]+\]\s*=[^=]/.test(src) &&
			rel !== "server/save/titles.ts" &&
			rel !== "shared/game/save.ts"
		)
			writers.push(rel);
		if (/\bgrantTitle\(/.test(src) && rel !== "server/save/titles.ts") writers.push(`${rel} (grantTitle)`);
	}
	check(
		writers.length === 0,
		"nenhum outro arquivo escreve titleStats nem chama grantTitle (o save.ts so le e copia; o cliente so espelha a carteira)",
		writers.join(", ") || `${files.length} arquivos`,
	);
	const shop = readFileSync(join(SRC, "shared/data/shop.ts"), "utf8");
	check(
		!/\btitle(Id|s)?\b\s*:/.test(shop),
		"nenhum pacote nem traje da loja carrega um titulo (MON-05: nunca se vende)",
	);
}

// ---------------------------------------------------------------- 5. the Supporter

section("5) Supporter: so a palavra do servidor, perguntada ao MarketplaceService; nunca um titulo, nunca jogo");
{
	const ID_OK = "EXP-6823453917458686";
	check(
		SUP.isSubscriptionId(ID_OK) &&
			!SUP.isSubscriptionId("") &&
			!SUP.isSubscriptionId("EXP-") &&
			!SUP.isSubscriptionId("exp-123") &&
			!SUP.isSubscriptionId("EXP-12a") &&
			!SUP.isSubscriptionId(123),
		"um id de assinatura e 'EXP-' e digitos (o do Creator Hub); vazio, texto e numero nao",
	);
	checkEq(SUP.SUPPORTER_SUBSCRIPTION_ID, "", "hoje nenhuma assinatura configurada: tudo escondido");
	checkEq(SUP.SUPPORTER_ATTRIBUTE, "pz_supporter", "o atributo e um pz_* (nunca renomeado)");

	/** a fake Player: attributes as the server sees them */
	const player = userId => ({
		UserId: userId,
		attrs: new Map(),
		here: true,
		SetAttribute(name, value) {
			if (value === undefined) this.attrs.delete(name);
			else this.attrs.set(name, value);
		},
	});
	const world = (answer, id = ID_OK) => {
		const asked = [];
		const delays = [];
		const flips = [];
		const book = new SUPSRV.SupporterStatusBook(id, {
			status: (p, sub) => {
				asked.push([p.UserId, sub]);
				const a = answer(p);
				if (a instanceof Error) throw a;
				return a;
			},
			present: p => p.here,
			delay: (s, fn) => delays.push([s, fn]),
			changed: (p, active) => flips.push([p.UserId, active]),
		});
		return { book, asked, delays, flips };
	};

	// nothing configured: nothing asked, nothing marked
	const off = world(() => ({ IsSubscribed: true }), "");
	const p0 = player(1);
	off.book.check(p0, "join");
	off.book.statusChanged(p0, "");
	check(
		off.asked.length === 0 && p0.attrs.size() === 0 && !off.book.isSupporter(1),
		"sem id: nenhuma pergunta, nenhuma marca",
	);

	// active, then lapsed
	let active = new Map([[10, true]]);
	const on = world(p => ({ IsSubscribed: active.get(p.UserId) === true, IsRenewing: true }));
	const a = player(10);
	const b = player(11);
	on.book.check(a, "join");
	on.book.check(b, "join");
	check(
		on.asked.every(([, sub]) => sub === ID_OK) && on.asked.length === 2,
		"pergunta com o id da assinatura, uma vez por entrada",
	);
	check(
		a.attrs.get("pz_supporter") === true && on.book.isSupporter(10),
		"assinatura ativa: a marca no Player (true) e a resposta guardada",
	);
	check(
		!b.attrs.has("pz_supporter") && !on.book.isSupporter(11),
		"sem assinatura: nenhuma marca (nem um false largado)",
	);
	check(on.flips.length === 0, "a primeira resposta nao e uma virada (a plataforma ja conta assinantes)");
	// a client that marks itself: the server's answer never reads the attribute
	b.attrs.set("pz_supporter", true);
	check(
		!on.book.isSupporter(11),
		"um cliente que se marca sozinho nao muda a resposta do servidor (que nunca le o atributo)",
	);
	b.attrs.delete("pz_supporter");
	// a status event for another subscription is ignored; for ours, it only makes the server ask
	on.book.statusChanged(a, "EXP-1");
	checkEq(on.asked.length, 2, "evento de outra assinatura: nenhuma pergunta");
	active.set(10, false);
	on.book.statusChanged(a, ID_OK);
	check(
		on.asked.length === 3 && !a.attrs.has("pz_supporter") && !on.book.isSupporter(10),
		"o evento faz perguntar: venceu, a marca sai",
	);
	check(JSON.stringify(on.flips) === JSON.stringify([[10, false]]), "e a virada e contada (Status - Ended)");
	active.set(11, true);
	on.book.promptFinished(b, ID_OK, false);
	checkEq(on.delays.length, 0, "um prompt fechado sem tentar comprar: nada");
	on.book.promptFinished(b, ID_OK, true);
	check(
		on.delays.length === 1 && on.delays[0][0] === SUPSRV.SUPPORTER_PROMPT_RECHECK_S,
		"um prompt que tentou: pergunta de novo em 10 s",
	);
	on.delays.shift()[1]();
	check(
		b.attrs.get("pz_supporter") === true && JSON.stringify(on.flips.at(-1)) === JSON.stringify([11, true]),
		"e a compra registrada acende a marca (Status - Started)",
	);

	// failures: the last answer stands, the ask is retried a bounded number of times
	let failing = true;
	const flaky = world(() => (failing ? new Error("HTTP 500") : { IsSubscribed: true }));
	const c = player(12);
	flaky.book.check(c, "join");
	check(
		!c.attrs.has("pz_supporter") && flaky.delays.length === 1,
		"a pergunta falhou: nenhuma marca, e uma nova tentativa agendada",
	);
	flaky.delays.shift()[1]();
	flaky.delays.shift()[1]();
	flaky.delays.shift()[1]();
	check(flaky.delays.length === 0 && flaky.asked.length === 4, "tres novas tentativas no maximo, e para");
	failing = false;
	flaky.book.statusChanged(c, ID_OK);
	check(c.attrs.get("pz_supporter") === true, "a proxima pergunta que responde marca");
	failing = true;
	flaky.book.check(c, "refresh");
	check(
		c.attrs.get("pz_supporter") === true && flaky.book.isSupporter(12),
		"uma falha depois nao apaga a ultima resposta boa",
	);

	// a player who left while the platform answered keeps nothing; forget on leaving
	const gone = world(p => {
		p.here = false;
		return { IsSubscribed: true };
	});
	const d = player(13);
	gone.book.check(d, "join");
	check(
		!gone.book.isSupporter(13) && !d.attrs.has("pz_supporter"),
		"saiu durante a pergunta: nada guardado, nada marcado",
	);
	on.book.forget(a);
	on.book.forget(b);
	check(!on.book.isSupporter(11), "quem saiu e esquecido (a plataforma e o registro)");

	// the refresh sweep asks everybody, each on its own thread
	const sweep = world(() => ({ IsSubscribed: false }));
	const spawned = [];
	sweep.book.refreshAll([player(20), player(21)], fn => spawned.push(fn));
	spawned.forEach(fn => fn());
	checkEq(sweep.asked.length, 2, "a varredura periodica pergunta por todos");

	// the Script and the client: what they connect, and what the client reads
	const script = readFileSync(join(SRC, "server/supporter.server.ts"), "utf8");
	check(
		/if \(!supporterOffered\(SUPPORTER_SUBSCRIPTION_ID\)\) return;/.test(script) &&
			/GetUserSubscriptionStatusAsync\(player, id\)/.test(script) &&
			/Players\.UserSubscriptionStatusChanged\.Connect/.test(script) &&
			/Players\.PlayerRemoving\.Connect\(player => book\.forget\(player\)\)/.test(script) &&
			/for \(const player of Players\.GetPlayers\(\)\) join\(player\);/.test(script),
		"o Script: nada sem id; pergunta no servidor; ouve a mudanca de status; esquece na saida; cobre quem ja estava",
	);
	check(
		!/SetAttribute/.test(readFileSync(join(SRC, "client/systems/supporterClient.ts"), "utf8")) &&
			/PromptSubscriptionPurchase\(me, SUPPORTER_SUBSCRIPTION_ID\)/.test(
				readFileSync(join(SRC, "client/systems/supporterClient.ts"), "utf8"),
			),
		"o cliente so LE a marca (nunca a escreve) e so pede o prompt da propria plataforma",
	);
	// MON-01: the subscription touches nothing of the game -- no save, coins, XP, loot, title or achievement
	const serverSide = readFileSync(join(SRC, "server/supporter/supporter.ts"), "utf8") + script;
	check(
		!/save|money|coins|awardExp|grantTitle|achievement|titleStats|Rebirth/i.test(
			serverSide.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""),
		),
		"MON-01: o codigo do Supporter nao toca save, moedas, XP, titulo nem conquista (so pergunta e marca)",
	);
	// LOW4 (review of 97cd734): nothing else on the server -- nor in shared code the server runs -- reads the mark or
	// asks the book, so nothing of the game can come to depend on a subscription. The client reads it (the nameplate)
	const supporterFiles = new Set([
		"server/supporter/supporter.ts",
		"server/supporter.server.ts",
		"shared/data/supporter.ts",
	]);
	const readers = [];
	const scan = dir => {
		for (const f of readdirSync(dir)) {
			const p = join(dir, f);
			if (statSync(p).isDirectory()) scan(p);
			else if (p.endsWith(".ts")) {
				const rel = relative(SRC, p).replace(/\\/g, "/");
				if (supporterFiles.has(rel)) continue;
				const code = readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
				if (/pz_supporter|SUPPORTER_ATTRIBUTE|SupporterStatusBook|isSupporter\(|supporterBook/.test(code)) {
					readers.push(rel);
				}
			}
		}
	};
	scan(join(SRC, "server"));
	scan(join(SRC, "shared"));
	check(
		readers.length === 0 && !/export function supporterBook|setSupporterBook/.test(serverSide),
		"LOW4: fora dos arquivos do Supporter, nada no servidor (nem no codigo compartilhado) le a marca ou pergunta ao livro",
		readers.join(", "),
	);

	// the client's mirror: a fake Players with attribute signals; a server-set mark reaches isSupporterUser
	const signals = new Map();
	const fakePlayer = (userId, attrs) => ({
		UserId: userId,
		GetAttribute: n => attrs.get(n),
		GetAttributeChangedSignal: n => ({ Connect: fn => signals.set(`${userId}:${n}`, fn) }),
		attrs,
	});
	const me = fakePlayer(30, new Map([["pz_supporter", true]]));
	const ally = fakePlayer(31, new Map());
	globalThis.game = {
		GetService: name => {
			if (name === "Players") {
				return {
					LocalPlayer: me,
					GetPlayers: () => [me, ally],
					PlayerAdded: { Connect: () => {} },
					PlayerRemoving: { Connect: () => {} },
				};
			}
			throw new Error(`no ${name} here`);
		},
	};
	const CLIENT = require(join(SRC, "client/systems/supporterClient.ts"));
	check(
		!CLIENT.supporterOnOffer() && !CLIENT.isSupporterUser(30) && !CLIENT.localIsSupporter(),
		"sem id: o espelho nem liga, ninguem e Supporter",
	);
	SUP.SUPPORTER_SUBSCRIPTION_ID = ID_OK;
	let heard = 0;
	CLIENT.onSupporterChanged(() => heard++);
	check(
		CLIENT.isSupporterUser(30) && CLIENT.localIsSupporter() && !CLIENT.isSupporterUser(31),
		"com id: le a marca que o servidor pos em cada Player",
	);
	ally.attrs.set("pz_supporter", true);
	signals.get("31:pz_supporter")();
	check(CLIENT.isSupporterUser(31) && heard === 1, "a marca que chega depois (o atributo muda) e ouvida uma vez");
	SUP.SUPPORTER_SUBSCRIPTION_ID = "";
	delete globalThis.game;
}

// ---------------------------------------------------------------- verdict

console.log("");
if (failures > 0) {
	console.log(`${failures} de ${checks} verificacao(oes) falharam`);
	process.exit(1);
}
console.log(`${checks} verificacoes, 0 falhas`);
