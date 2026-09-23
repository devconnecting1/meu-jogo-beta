#!/usr/bin/env node
/*
 * Every item, row by row: weapons, equipment, usables, recipes, skills, loot and the shop.
 *
 *   npm run test:items                    # everything (exit code 1 on any failure)
 *   node tools/test-items.mjs --verbose   # with the per-row measurements
 *   PZ_SRC=path/to/src node tools/test-items.mjs
 *
 * The owner asked (2026-09-23): "Já testou todas as funcionalidades das configurações? dos itens? equipamentos?".
 * The other suites each walk the ONE item they were written for (the pistol of test-combat, the wood of test-world,
 * the Santa of test-save). This one loops over EVERY row of shared/data -- WEAPONS, EQUIPS, USABLES, ETC_ITEMS,
 * CRAFT_RECIPES, SKILLS, BUILDING_SPAWNS, SHOP_PACKS and COSTUMES -- through the code the game really runs, so a row
 * added tomorrow is covered the day it lands:
 *
 *   A. WEAPONS     the number keys pick it (shared/game/weaponSlots.ts + client/systems/combat.ts); the SERVER's
 *                  weapon machine (server/sim/combat.ts) deals the data's damage, at the data's cadence, out to the
 *                  data's range (a melee blade to its reach + the latency margin); a gun reloads from ITS pool, an
 *                  empty reserve fires nothing; the item card (client/ui/itemInfo.ts) says the same numbers.
 *   B. EQUIPMENT   every row fits one slot; the server's equip / unequip (server/sim/craft.ts) and the save's own
 *                  guard (`enforceSaveInvariants`, `sanitizeClientReport`) refuse what is not owned or not that
 *                  slot's; defence and speed come on and go off with the item, through the server's damage path and
 *                  its `stepPlayer`; a cosmetic changes neither, even if its data row said otherwise (MON-01).
 *   C. USABLES     every row eaten through the server's `useItem`: hp, hunger and the three buffs exactly as the
 *                  data says, one fewer in the backpack, "None left" refused, the 0.25 s cooldown; Eat vs Use.
 *   D. CRAFTING    every recipe, through the client's craft (the path MP_PHASE 2 ships) AND the server's: the
 *                  station holds, the ingredients go exactly, MAKES ×N comes out, nothing without ingredients or
 *                  station, no double craft from a double click; every placeable is placed by the server world.
 *   E. SKILLS      every skill: one point per level, never past its maximum, points = level − 1 − spent; and the
 *                  effect each one promises is measured where the game applies it.
 *   F. LOOT        every building type's table (EDI-03) and every roll lands in the backpack.
 *   G. SHOP        the REAL server (server/main.server.ts on the fake Roblox of test-body): every pack charges its
 *                  price and delivers what it declares (MON-03); a pack pet stays until a New game; a report
 *                  cannot conjure a pet; every costume is sold at the catalogue's price.
 *
 * KNOWN BUGS. Some findings are too big to fix here (another front's files, or a design question): each is a
 * `knownBug(id, reproduces, ...)` line. While the bug reproduces it prints `BUG` and does not fail the suite; the day
 * it stops reproducing it FAILS, so whoever fixed it turns the line into a plain check. The ids are the ones of the
 * QA report (items-qa, 2026-09-23).
 *
 * Pure Node (>= 18) + the project's TypeScript, on the shared shims (tools/ui-shim.mjs, which carries
 * tools/luau-shim.mjs), plus test-body's fake Roblox for part G.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installUiShims } from "./ui-shim.mjs";

const VERBOSE = process.argv.includes("--verbose");
const ui = installUiShims({ seed: 1, viewport: [1120, 630] });
const { SRC, require, setSeed } = ui;

// ---------------------------------------------------------------- reporting

let failures = 0;
let checks = 0;
const bugs = [];
function check(ok, what, detail) {
	checks += 1;
	const tail = detail === undefined ? "" : `  (${detail})`;
	if (ok) {
		if (VERBOSE) console.log(`  ok    ${what}${tail}`);
	} else {
		failures += 1;
		console.log(`  FAIL  ${what}${tail}`);
	}
	return ok;
}
function checkEq(got, want, what) {
	return check(got === want, what, got === want ? undefined : `expected ${want}, got ${got}`);
}
function near(a, b, tol) {
	return Math.abs(a - b) <= tol;
}
/** a check over many rows: one line per area, every failing row named */
function checkRows(what, rows, fn) {
	const bad = [];
	for (const row of rows) {
		let why;
		try {
			why = fn(row);
		} catch (e) {
			why = `threw ${e?.message ?? e}`;
		}
		if (why !== undefined && why !== true) bad.push(`${row.name ?? row.id}: ${why === false ? "no" : why}`);
	}
	checks += 1;
	if (bad.length === 0) {
		console.log(`  ok    ${what} (${rows.length}/${rows.length})`);
	} else {
		failures += 1;
		console.log(`  FAIL  ${what} (${rows.length - bad.length}/${rows.length})`);
		for (const b of bad.slice(0, 12)) console.log(`          - ${b}`);
		if (bad.length > 12) console.log(`          ... and ${bad.length - 12} more`);
	}
	return bad.length === 0;
}
/**
 * A bug this suite found and reported instead of fixing (see the header). `reproduces` is the measurement: true
 * prints BUG and moves on, false fails -- the bug is gone and the line must become a check.
 */
function knownBug(id, reproduces, what, detail) {
	checks += 1;
	const tail = detail === undefined ? "" : `  (${detail})`;
	if (reproduces) {
		bugs.push(id);
		console.log(`  BUG   [${id}] ${what}${tail}`);
	} else {
		failures += 1;
		console.log(`  FAIL  [${id}] no longer reproduces -- fixed? make it a check: ${what}${tail}`);
	}
}
const info = msg => {
	if (VERBOSE) console.log(`        ${msg}`);
};
function section(title, fn) {
	console.log(`\n${title}`);
	try {
		fn();
	} catch (e) {
		failures += 1;
		console.log(`  FAIL  the section threw: ${e?.stack?.split("\n").slice(0, 4).join(" | ") ?? e}`);
	}
}
/** the source of a file under src/, for the few guards that are about what code exists */
const source = rel => readFileSync(join(SRC, rel), "utf8");

// ---------------------------------------------------------------- the modules under test

const { WEAPONS, MELEE_REACH, meleeReach, usesMagazine, isChoppingTool } = require(join(SRC, "shared/data/weapons.ts"));
const { EQUIPS, EquipSlot, EQUIP_SLOT_MAX } = require(join(SRC, "shared/data/equips.ts"));
const { USABLES } = require(join(SRC, "shared/data/usables.ts"));
const { ETC_ITEMS } = require(join(SRC, "shared/data/etcItems.ts"));
const { SKILLS } = require(join(SRC, "shared/data/skills.ts"));
const { CRAFT_RECIPES } = require(join(SRC, "shared/data/crafts.ts"));
const { ItemKind, WeaponKind, AmmoPool } = require(join(SRC, "shared/data/kinds.ts"));
const { BUILDING_SPAWNS } = require(join(SRC, "shared/data/spawns.ts"));
const { BuildingType } = require(join(SRC, "shared/data/buildings.ts"));
const { SHOP_PACKS, COSTUMES, ECONOMY } = require(join(SRC, "shared/data/shop.ts"));
const COS = require(join(SRC, "shared/data/cosmetics.ts"));
const { iconOf } = require(join(SRC, "shared/data/itemIcons.ts"));
const { LANG_TABLE } = require(join(SRC, "shared/data/lang.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const SAVE = require(join(SRC, "shared/game/save.ts"));
const Ply = require(join(SRC, "shared/game/player.ts"));
const W = require(join(SRC, "shared/game/world.ts"));
const { createZombie, zombieRadius } = require(join(SRC, "shared/game/entities.ts"));
const { weaponKeyOrder, WEAPON_KEY_COUNT } = require(join(SRC, "shared/game/weaponSlots.ts"));
const INV = require(join(SRC, "shared/sim/inventory.ts"));
const { stepPlayer } = require(join(SRC, "shared/sim/playerMove.ts"));
const { SPEED_SCALE } = require(join(SRC, "shared/sim/types.ts"));
const { PLACEABLES } = require(join(SRC, "shared/sim/placement.ts"));
const CFG = require(join(SRC, "shared/net/mpConfig.ts"));
const P = require(join(SRC, "shared/net/protocol.ts"));
const PL = require(join(SRC, "server/sim/players.ts"));
const { ServerCombat } = require(join(SRC, "server/sim/combat.ts"));
const { PositionHistory } = require(join(SRC, "server/sim/history.ts"));
const { ServerSimulation } = require(join(SRC, "server/sim/simulation.ts"));
const { WorldClock } = require(join(SRC, "server/sim/waves.ts"));
const SCRAFT = require(join(SRC, "server/sim/craft.ts"));
const { InputState } = require(join(SRC, "shared/engine/input.ts"));
const CCombat = require(join(SRC, "client/systems/combat.ts"));
const CCraft = require(join(SRC, "client/systems/craftSystem.ts"));
const Info = require(join(SRC, "client/ui/itemInfo.ts"));

const TICK_DT = 1 / CFG.SIM_HZ;
const nameOf = (kind, id) => (kind === 1 ? WEAPONS : kind === 2 ? EQUIPS : kind === 3 ? USABLES : ETC_ITEMS)[id]?.name;
/** the string is registered in lang.ts (UI-03: every string the player reads may be translated) */
const LANG_KEYS = new Set(LANG_TABLE);
const inLang = key => LANG_KEYS.has(key);

/** a save that owns exactly what the test gives it: the dagger (every survivor's) and nothing else */
function bareSave() {
	const s = SAVE.defaultSave();
	for (let i = 0; i < s.invenUse.length; i++) s.invenUse[i] = 0;
	return s;
}

// ================================================================ A. weapons

/** the server half of a tick for one survivor (test-combat's fixture): zombies are an array, the RNG is 0.5 */
function weaponFixture(weaponId, tune = {}) {
	const world = W.createWorld(8000, 8000);
	const zombies = [];
	const shots = [];
	const projectiles = [];
	let tick = 0;
	const combat = new ServerCombat({
		world,
		targets: { zombies: () => zombies, bosses: () => [] },
		history: new PositionHistory(),
		// 0.5: the spread roll is exactly 0 and damage_cal(n) is exactly n, so every number below is the data's
		random: () => 0.5,
		hooks: {
			fx: e => {
				if (e.t === P.FxType.Shot) shots.push({ tick, e });
			},
			projectile: r => projectiles.push({ tick, r }),
		},
	});
	const save = bareSave();
	save.invenWeapon[weaponId] = 1;
	save.equipWeapon = weaponId;
	save.ammoNormal = tune.normal ?? 1000;
	save.ammoShotgun = tune.shotgun ?? 2000;
	save.ammoMachinegun = tune.mg ?? 3000;
	save.ammoArrow = tune.arrow ?? 400;
	save.oil = tune.oil ?? 500;
	save.electric = tune.electric ?? 600;
	if (tune.skills) for (const [id, lv] of Object.entries(tune.skills)) save.skillLevels[Number(id)] = lv;
	const sp = PL.createServerPlayer({ slot: 0, userId: 1, name: "p" }, save, 1000, 1000, 0);
	if (tune.mag !== undefined) sp.state.weapon.ammoCount = tune.mag;
	const fx = {
		world,
		zombies,
		shots,
		projectiles,
		combat,
		save,
		sp,
		get tick() {
			return tick;
		},
		/** one tick: `held` (attack button), `press` / `release` edges, `reload` edge, aiming at (tx, ty) */
		step(o = {}) {
			tick += 1;
			const tx = o.tx ?? sp.state.x + 100;
			const ty = o.ty ?? sp.state.y;
			const aim = Math.atan2(ty - sp.state.y, tx - sp.state.x);
			const cmd = P.makeCommand(
				tick,
				0,
				0,
				aim,
				o.held ? P.HeldBit.Attack : 0,
				P.packEdges(o.press ?? 0, o.release ?? 0, 0, o.reload ?? 0),
			);
			stepPlayer(world, sp.state, sp.save, cmd, TICK_DT);
			// a survivor who never eats would starve in a long measurement: the belly is not what is measured here
			sp.state.hungry = sp.state.hungryMax;
			combat.stepPlayer(sp, cmd, tick, TICK_DT);
			combat.afterWorld(tick);
		},
		run(seconds, o) {
			const n = Math.round(seconds * CFG.SIM_HZ);
			for (let i = 0; i < n; i++) this.step(typeof o === "function" ? o(i) : o);
		},
		zombie(x, y, hp = 1e9) {
			const z = createZombie(1, x, y, 1);
			z.hp = hp;
			z.hpMax = hp;
			zombies.push(z);
			return z;
		},
	};
	return fx;
}

const MELEE = WEAPONS.filter(w => w.kind === WeaponKind.Melee);
const GUNS = WEAPONS.filter(w => w.kind !== WeaponKind.Melee);
const CHAINSAW = 5;
const FLAMETHROWER = 25;
const STUN_GUN = 26;
const CROSSBOW = 23;
const isDrawBow = w => w.kind === WeaponKind.Bow && !usesMagazine(w);
const isFuel = w => w.id === FLAMETHROWER || w.id === STUN_GUN;
const isHitscan = w => !isFuel(w) && w.kind !== WeaponKind.Bow && w.kind !== WeaponKind.Melee;
const POOL_FIELD = {
	[AmmoPool.Normal]: "ammoNormal",
	[AmmoPool.Shotgun]: "ammoShotgun",
	[AmmoPool.MG]: "ammoMachinegun",
	[AmmoPool.Arrow]: "ammoArrow",
	[AmmoPool.Oil]: "oil",
};
const ALL_POOLS = ["ammoNormal", "ammoShotgun", "ammoMachinegun", "ammoArrow", "oil", "electric"];
/** what the weapon really burns (shared/game/player.ts weaponReserve): the chainsaw and the flamethrower oil, the stun gun charge */
const fuelField = w =>
	w.id === CHAINSAW || w.id === FLAMETHROWER ? "oil" : w.id === STUN_GUN ? "electric" : POOL_FIELD[w.ammoPool];
const ticksOf = s => Math.round(s * CFG.SIM_HZ);

section("A1. every weapon row is coherent: kind, pool, magazine, reach", () => {
	checkRows("ids are the row's index", WEAPONS, w => WEAPONS[w.id] === w || `row ${WEAPONS.indexOf(w)}`);
	checkRows("every melee weapon has its own reach in MELEE_REACH (not the 70 u fallback)", MELEE, w =>
		MELEE_REACH[w.id] !== undefined ? true : "falls back to 70",
	);
	checkRows(
		"a melee weapon has no magazine and no reload",
		MELEE,
		w => (w.mag === 0 && w.reload === 0) || `mag ${w.mag}`,
	);
	checkRows(
		"every non-melee weapon has a magazine, a cadence, a range and pellets",
		GUNS,
		w =>
			(w.mag > 0 && w.cooldown > 0 && w.range > 0 && w.pellets >= 1) ||
			`mag ${w.mag} cd ${w.cooldown} range ${w.range}`,
	);
	checkRows(
		"a magazine weapon reloads in a positive time",
		GUNS.filter(usesMagazine),
		w => w.reload > 0 || "reload 0",
	);
	checkRows(
		"the ammo pool is a real pool",
		WEAPONS,
		w => POOL_FIELD[w.ammoPool] !== undefined || `pool ${w.ammoPool}`,
	);
	checkRows(
		"the chopping tools are blades (axes and saws)",
		WEAPONS.filter(isChoppingTool),
		w => w.kind === WeaponKind.Melee || "not melee",
	);
});

section("A2. keys 1–5 pick every weapon, the hotbar lists it, and a switch banks the magazine (client)", () => {
	// the client refs Combat.update needs to handle a key: MP_PHASE 2, so the predicted path (updatePredicted)
	function clientRefs(save) {
		const player = Ply.createPlayer(save, 1000, 1000);
		return {
			world: W.createWorld(4000, 4000),
			players: [player],
			player,
			save,
			input: new InputState(),
			zombies: [],
			bosses: [],
			bullets: [],
			pendingPlace: -1,
			fx: [],
			onMessage: () => {},
			onExp: () => {},
		};
	}
	checkRows("owning a weapon puts it on a number key (dagger + it), and pressing that key holds it", WEAPONS, w => {
		const save = bareSave();
		save.invenWeapon[w.id] = 1;
		const refs = clientRefs(save);
		const combat = new CCombat.Combat();
		const list = weaponKeyOrder(save, refs.player.weapon.pointer);
		const k = list.indexOf(w.id);
		if (k < 0) return "not in weaponKeyOrder";
		if (k >= WEAPON_KEY_COUNT) return `key ${k + 1}`;
		refs.input.weaponSlotPressed = k;
		combat.update(refs, 1 / 60);
		if (refs.player.weapon.pointer !== w.id) return `key ${k + 1} left ${refs.player.weapon.pointer} in hand`;
		if (save.equipWeapon !== w.id) return `save.equipWeapon ${save.equipWeapon}`;
		// the hotbar tile under key k is the same list (shared/game/weaponSlots.ts), with the new weapon in hand
		const again = weaponKeyOrder(save, refs.player.weapon.pointer);
		return again[k] === w.id || `the hotbar shows ${again[k]} under key ${k + 1}`;
	});
	{
		// everything owned: keys 1..5 are the first five ids, and the rest are reachable only from the Bag (UI-09)
		const save = bareSave();
		for (const w of WEAPONS) save.invenWeapon[w.id] = 1;
		const refs = clientRefs(save);
		const combat = new CCombat.Combat();
		const got = [];
		for (let k = 0; k < WEAPON_KEY_COUNT; k++) {
			refs.input.weaponSlotPressed = k;
			combat.update(refs, 1 / 60);
			got.push(refs.player.weapon.pointer);
		}
		checkEq(got.join(","), "0,1,2,3,4", "with every weapon owned, keys 1–5 hold ids 0–4 in order");
		// the 6th weapon on is the Bag's (UI-09): the keyboard has exactly five weapon keys
		const keys = /const WEAPON_KEYS[^=]*=\s*\[([^\]]*)\]/.exec(source("client/bootstrap.ts"));
		check(
			keys !== null && keys[1].split(",").filter(s => s.trim() !== "").length === WEAPON_KEY_COUNT,
			"bootstrap binds exactly five weapon keys",
			keys?.[1],
		);
	}
	checkRows(
		"switching away from a loaded gun puts its rounds back in ITS pool (and the new one comes in empty)",
		GUNS.filter(w => usesMagazine(w) && !isFuel(w)),
		w => {
			const save = bareSave();
			save.invenWeapon[w.id] = 1;
			for (const f of ALL_POOLS) save[f] = 50;
			const refs = clientRefs(save);
			CCombat.switchWeapon(refs, w.id);
			refs.player.weapon.ammoCount = 1;
			CCombat.switchWeapon(refs, 0);
			const field = POOL_FIELD[w.ammoPool];
			for (const f of ALL_POOLS) if (save[f] !== (f === field ? 51 : 50)) return `${f} ${save[f]}`;
			return refs.player.weapon.ammoCount === 0 || `the dagger came in with ${refs.player.weapon.ammoCount}`;
		},
	);
});

section("A3. the SERVER's weapon machine: the data's damage, cadence and range for every weapon (§2.3)", () => {
	const hitscan = WEAPONS.filter(isHitscan);
	/** one pull of the trigger at (tx, ty): a bolt-action sniper fires on release, everything else on a press */
	const pull = (w, tx, ty) =>
		w.kind === WeaponKind.Sniper && !w.auto ? { release: 1, tx, ty } : { held: true, press: 1, tx, ty };
	checkRows("a hitscan shot deals damage × pellets, all on the one zombie in its line", hitscan, w => {
		const fx = weaponFixture(w.id);
		const z = fx.zombie(1000 + Math.min(200, w.range / 2), 1000);
		fx.step(pull(w, z.x, z.y));
		const lost = 1e9 - z.hp;
		return lost === w.dmg * w.pellets || `lost ${lost}, data ${w.dmg} x${w.pellets}`;
	});
	checkRows("a hitscan shot reaches its range and not a unit further", hitscan, w => {
		const r = 16;
		const hit = weaponFixture(w.id);
		const zi = hit.zombie(1000 + w.range - 5 + r, 1000);
		hit.step(pull(w, zi.x, zi.y));
		const miss = weaponFixture(w.id);
		const zo = miss.zombie(1000 + w.range + 5 + r, 1000);
		miss.step(pull(w, zo.x, zo.y));
		if (zombieRadius(zi) !== r) return `walker radius ${zombieRadius(zi)}`;
		if (zi.hp === 1e9) return `a zombie ${w.range - 5} u away was not hit`;
		return zo.hp === 1e9 || `a zombie ${w.range + 5} u away was hit`;
	});
	checkRows(
		"a gun fires at its cooldown (the gap between the first two shots, to the tick; a 1-round magazine adds its reload)",
		GUNS.filter(w => !isDrawBow(w)),
		w => {
			const fx = weaponFixture(w.id);
			const z = fx.zombie(1300, 1000);
			const fired = [];
			let before = 0;
			for (let i = 0; i < ticksOf(Math.max(3, w.cooldown * 3 + w.reload)) && fired.length < 2; i++) {
				// a spamming client: a press every tick (a bolt-action sniper, a release every tick)
				fx.step(pull(w, z.x, z.y));
				const n = fx.combat.statsOf(0).shots;
				if (n > before) fired.push(fx.tick);
				before = n;
			}
			if (fired.length < 2) return `fired ${fired.length} time(s)`;
			const gap = (fired[1] - fired[0]) / CFG.SIM_HZ;
			// the crossbow holds one bolt: the next shot waits for the cooldown AND the reload the cooldown holds back
			const want = w.mag >= 2 ? Math.max(w.cooldown, 1 / CFG.SIM_HZ) : w.cooldown + w.reload;
			info(`${w.name}: ${gap.toFixed(3)} s between shots, data ${w.cooldown.toFixed(3)} s`);
			return near(gap, want, 1.51 / CFG.SIM_HZ) || `${gap.toFixed(3)} s, wanted ${want.toFixed(3)} s`;
		},
	);
	checkRows(
		"a melee blade hits for its damage, to its reach + the latency margin, and not past it",
		MELEE.filter(w => w.id !== CHAINSAW),
		w => {
			const reach = meleeReach(w) + CFG.MELEE_RANGE_MARGIN;
			const inFx = weaponFixture(w.id);
			const zi = inFx.zombie(0, 1000);
			zi.x = 1000 + reach - 2 + zombieRadius(zi);
			inFx.run(1, { held: true, press: 1, tx: 2000, ty: 1000 });
			const outFx = weaponFixture(w.id);
			const zo = outFx.zombie(0, 1000);
			zo.x = 1000 + reach + 2 + zombieRadius(zo);
			outFx.run(1, { held: true, press: 1, tx: 2000, ty: 1000 });
			const first = inFx.combat.statsOf(0).melee > 0 ? 1e9 - zi.hp : 0;
			if (first === 0)
				return `nothing hit at ${reach - 2} u (reach ${meleeReach(w)} + ${CFG.MELEE_RANGE_MARGIN})`;
			const hits = inFx.combat.statsOf(0).melee;
			if ((1e9 - zi.hp) % w.dmg !== 0) return `${1e9 - zi.hp} dealt over ${hits} hit(s), data ${w.dmg} each`;
			return zo.hp === 1e9 || `hit at ${reach + 2} u`;
		},
	);
	checkRows(
		"a melee blade swings again after its cooldown (swing time + cooldown between hits)",
		MELEE.filter(w => w.id !== CHAINSAW),
		w => {
			const fx = weaponFixture(w.id);
			const z = fx.zombie(1040, 1000);
			const hitAt = [];
			let before = 0;
			for (let i = 0; i < ticksOf(4) && hitAt.length < 3; i++) {
				fx.step({ held: true, tx: 2000, ty: 1000 });
				const n = fx.combat.statsOf(0).melee;
				if (n > before) hitAt.push(fx.tick);
				before = n;
			}
			if (hitAt.length < 2) return `${hitAt.length} hit(s) in 4 s`;
			const gap = (hitAt[1] - hitAt[0]) / CFG.SIM_HZ;
			info(`${w.name}: a hit every ${gap.toFixed(3)} s (cooldown ${w.cooldown.toFixed(3)} s + the swing)`);
			return (
				(gap >= w.cooldown - 1e-9 && gap < w.cooldown + 1.5) ||
				`${gap.toFixed(3)} s, cooldown ${w.cooldown.toFixed(3)} s`
			);
		},
	);
	{
		// the chainsaw: rev (1.5 s of warm-up), then it cuts everything in front while oil lasts, at 3 oil/s
		const w = WEAPONS[CHAINSAW];
		const fx = weaponFixture(CHAINSAW, { oil: 100 });
		const z = fx.zombie(1040, 1000);
		fx.run(1.4, { held: true, tx: 2000, ty: 1000 });
		checkEq(z.hp, 1e9, "the chainsaw does not cut before its 1.5 s warm-up");
		fx.run(1, { held: true, tx: 2000, ty: 1000 });
		const perSecond = 1e9 - z.hp;
		info(
			`chainsaw: ${perSecond.toFixed(0)} damage in its first second of cutting, ${100 - fx.save.oil} oil burnt in 2.4 s`,
		);
		check(
			near(perSecond, w.dmg * SPEED_SCALE * (0.9 + 1 / 60), w.dmg * SPEED_SCALE * 0.15),
			"then cuts damage_cal(10) every frame (~300/s)",
			`${perSecond.toFixed(0)}`,
		);
		check(near(100 - fx.save.oil, 3 * 2.4, 1.01), "and burns 3 oil a second while held", `${100 - fx.save.oil}`);
		const reach = meleeReach(w) + CFG.MELEE_RANGE_MARGIN;
		const far = weaponFixture(CHAINSAW, { oil: 100 });
		const zf = far.zombie(0, 1000);
		zf.x = 1000 + reach + 2 + zombieRadius(zf);
		far.run(3, { held: true, tx: 2000, ty: 1000 });
		checkEq(zf.hp, 1e9, `past its reach (${meleeReach(w)} + ${CFG.MELEE_RANGE_MARGIN}) the chainsaw cuts nothing`);
		const dry = weaponFixture(CHAINSAW, { oil: 0 });
		const zd = dry.zombie(1040, 1000);
		dry.run(3, { held: true, tx: 2000, ty: 1000 });
		checkEq(zd.hp, 1e9, "with no oil the chainsaw never cuts");
	}
	checkRows(
		"a draw-bow looses an arrow of its damage and range after a full draw, and none before",
		WEAPONS.filter(isDrawBow),
		w => {
			const fx = weaponFixture(w.id, { arrow: 5 });
			fx.run(w.cooldown / 2, { held: true });
			fx.step({ release: 1 });
			if (fx.projectiles.length !== 0 || fx.save.ammoArrow !== 5) return "a half draw loosed an arrow";
			fx.run(w.cooldown + 2 / 60, { held: true });
			fx.step({ release: 1 });
			const p = fx.projectiles[0];
			if (p === undefined) return "a full draw loosed nothing";
			if (p.r.kind !== P.ProjKind.Arrow) return `projectile kind ${p.r.kind}`;
			if (p.r.damage !== w.dmg || p.r.range !== w.range) return `damage ${p.r.damage} range ${p.r.range}`;
			return fx.save.ammoArrow === 4 || `arrows ${fx.save.ammoArrow}`;
		},
	);
	{
		const w = WEAPONS[CROSSBOW];
		const fx = weaponFixture(CROSSBOW, { arrow: 5 });
		fx.step({ held: true, press: 1 });
		const p = fx.projectiles[0];
		check(
			p !== undefined && p.r.kind === P.ProjKind.Arrow && p.r.damage === w.dmg && p.r.range === w.range,
			"the crossbow shoots an arrow of its damage and range",
			p && `${p.r.damage}/${p.r.range}`,
		);
	}
	{
		const w = WEAPONS[FLAMETHROWER];
		const fx = weaponFixture(FLAMETHROWER, { oil: 10 });
		fx.run(1, { held: true, press: 1 });
		const p = fx.projectiles[0];
		check(
			p !== undefined && p.r.kind === P.ProjKind.Fire && p.r.damage === w.dmg && p.r.range === w.range,
			"the flamethrower throws fire of its damage and range",
			p && `${p.r.damage}/${p.r.range}`,
		);
		const flames = fx.projectiles.length;
		check(near(flames, 1 / w.cooldown, 1.01), `at its cadence (${flames} flames in 1 s)`);
		check(
			near(10 - fx.save.oil, Math.floor(flames * 0.1), 1),
			"burning 0.1 oil per flame",
			`${10 - fx.save.oil} oil for ${flames}`,
		);
		const dry = weaponFixture(FLAMETHROWER, { oil: 0 });
		dry.run(1, { held: true, press: 1 });
		checkEq(dry.projectiles.length, 0, "and throws nothing with no oil");
	}
	{
		const w = WEAPONS[STUN_GUN];
		const fx = weaponFixture(STUN_GUN, { electric: 5 });
		const a = fx.zombie(1200, 1000);
		const b = fx.zombie(1300, 1000);
		fx.step({ held: true, press: 1, tx: a.x, ty: a.y });
		checkEq(1e9 - a.hp, w.dmg, "the stun gun zaps the nearest zombie in its cone for its damage");
		checkEq(1e9 - b.hp, w.dmg, "and chains to the next one");
		const alone = weaponFixture(STUN_GUN, { electric: 5 });
		const far = alone.zombie(1000 + w.range + 5, 1000);
		alone.step({ held: true, press: 1, tx: far.x, ty: far.y });
		checkEq(far.hp, 1e9, "but reaches nothing past its range");
		const dry = weaponFixture(STUN_GUN, { electric: 0 });
		const zd = dry.zombie(1200, 1000);
		dry.run(1, { held: true, press: 1, tx: zd.x, ty: zd.y });
		checkEq(zd.hp, 1e9, "and zaps nothing with no charge");
	}
});

section("A4. ammunition: the right pool, the reload, an empty reserve (server)", () => {
	const magGuns = GUNS.filter(w => usesMagazine(w) && !isFuel(w));
	checkRows(
		"an empty magazine reloads from ITS pool, in the data's reload time, and no other pool moves",
		magGuns,
		w => {
			const fx = weaponFixture(w.id, {
				mag: 0,
				normal: 500,
				shotgun: 600,
				mg: 700,
				arrow: 800,
				oil: 900,
				electric: 950,
			});
			const before = Object.fromEntries(ALL_POOLS.map(f => [f, fx.save[f]]));
			let t = 0;
			while (fx.sp.state.weapon.ammoCount === 0 && t < ticksOf(5)) {
				fx.step({});
				t += 1;
			}
			const secs = t / CFG.SIM_HZ;
			const perLoad = w.kind === WeaponKind.Shotgun ? 1 : w.mag;
			const field = POOL_FIELD[w.ammoPool];
			if (fx.sp.state.weapon.ammoCount !== perLoad)
				return `magazine ${fx.sp.state.weapon.ammoCount}, wanted ${perLoad}`;
			for (const f of ALL_POOLS) {
				const want = f === field ? before[f] - perLoad : before[f];
				if (fx.save[f] !== want) return `${f} ${before[f]} -> ${fx.save[f]}`;
			}
			info(
				`${w.name}: reloaded ${perLoad} from ${field} in ${secs.toFixed(3)} s (data ${w.reload.toFixed(3)} s)`,
			);
			return (
				near(secs, w.reload, 1.01 / CFG.SIM_HZ) || `reload ${secs.toFixed(3)} s, data ${w.reload.toFixed(3)} s`
			);
		},
	);
	checkRows("with nothing in the magazine and nothing in reserve it neither fires nor reloads", magGuns, w => {
		const fx = weaponFixture(w.id, { mag: 0, normal: 0, shotgun: 0, mg: 0, arrow: 0 });
		const z = fx.zombie(1200, 1000);
		fx.run(2, i => ({ held: true, press: 1, release: i % 2, reload: i % 30 === 0 ? 1 : 0, tx: z.x, ty: z.y }));
		const st = fx.combat.statsOf(0);
		if (st.shots !== 0 || z.hp !== 1e9) return `${st.shots} shot(s)`;
		if (fx.sp.state.weapon.reloading) return "stuck reloading";
		return st.blockedAmmo > 0 || w.kind === WeaponKind.Sniper || "the empty trigger was not counted";
	});
	checkRows("a reserve smaller than a magazine loads what there is and leaves the pool at 0", magGuns, w => {
		const pool = POOL_FIELD[w.ammoPool];
		const fx = weaponFixture(w.id, { mag: 0, normal: 1, shotgun: 1, mg: 1, arrow: 1 });
		fx.run(Math.max(2, w.reload * 3), {});
		return (
			(fx.sp.state.weapon.ammoCount === 1 && fx.save[pool] === 0) ||
			`magazine ${fx.sp.state.weapon.ammoCount}, ${pool} ${fx.save[pool]}`
		);
	});
	checkRows("every round fired comes out of the magazine the pool paid for (none invented)", magGuns, w => {
		const pool = POOL_FIELD[w.ammoPool];
		const start = w.mag * 2 + 3;
		const fx = weaponFixture(w.id, { mag: 0, normal: start, shotgun: start, mg: start, arrow: start });
		const z = fx.zombie(1200, 1000);
		const bolt = w.kind === WeaponKind.Sniper && !w.auto;
		fx.run(12, i => (bolt ? { release: 1, tx: z.x, ty: z.y } : { held: true, press: 1, tx: z.x, ty: z.y }));
		const shots = fx.combat.statsOf(0).shots;
		const left = fx.save[pool] + fx.sp.state.weapon.ammoCount;
		return shots + left === start || `${shots} fired + ${left} left != ${start}`;
	});
	{
		// Quick reload (skill 4): the original counts frames × (1 + level/4) → a reload 1.25× faster
		const w = WEAPONS[10];
		const fx = weaponFixture(10, { mag: 0, skills: { 4: 1 } });
		let t = 0;
		while (fx.sp.state.weapon.ammoCount === 0 && t < 600) {
			fx.step({});
			t += 1;
		}
		check(
			near(t / CFG.SIM_HZ, w.reload / 1.25, 1.01 / CFG.SIM_HZ),
			"Quick reload reloads the pistol 1.25× faster",
			`${(t / 60).toFixed(3)} s`,
		);
	}
	checkRows("a draw-bow with no arrows never draws", WEAPONS.filter(isDrawBow), w => {
		const fx = weaponFixture(w.id, { arrow: 0 });
		fx.run(w.cooldown + 0.2, { held: true });
		fx.step({ release: 1 });
		return fx.projectiles.length === 0 || "an arrow came out of nothing";
	});
});

section("A5. the item card says what the server does (client/ui/itemInfo.ts, UI-08)", () => {
	const statsOf = w => {
		const card = Info.describeItem(bareSave(), ItemKind.Weapon, w.id);
		const m = new Map();
		for (const s of card.stats) m.set(s.label, s.value);
		return { card, m };
	};
	checkRows("the card's damage is the data's (× pellets for a shotgun)", WEAPONS, w => {
		const { m } = statsOf(w);
		const want = w.pellets > 1 ? `${w.dmg} x${w.pellets}` : `${w.dmg}`;
		return m.get("Damage") === want || `card "${m.get("Damage")}"`;
	});
	checkRows(
		"the card's cooldown (or a draw-bow's draw time) is the data's",
		WEAPONS.filter(w => w.id !== CHAINSAW),
		w => {
			const { m } = statsOf(w);
			const label = isDrawBow(w) ? "Draw time" : "Cooldown";
			const shown = Number(String(m.get(label) ?? "").replace(" s", ""));
			return near(shown, w.cooldown, 0.006) || `card "${m.get(label)}", data ${w.cooldown}`;
		},
	);
	checkRows("a blade's card gives its reach (MELEE_REACH), a gun's its range", WEAPONS, w => {
		const { m } = statsOf(w);
		if (Info.isMelee(w)) return m.get("Reach") === `${meleeReach(w)}` || `Reach "${m.get("Reach")}"`;
		return m.get("Range") === `${w.range}` || `Range "${m.get("Range")}"`;
	});
	checkRows("a magazine weapon's card gives its magazine and reload", GUNS.filter(usesMagazine), w => {
		const { m } = statsOf(w);
		const reload = Number(String(m.get("Reload") ?? "").replace(" s", ""));
		return (
			(m.get("Magazine") === `${w.mag}` && near(reload, w.reload, 0.006)) ||
			`"${m.get("Magazine")}" / "${m.get("Reload")}"`
		);
	});
	checkRows(
		"the card names what feeds the weapon: the ammo of its pool, oil, or charge",
		WEAPONS.filter(Info.showsReserve),
		w => {
			const { m } = statsOf(w);
			const want =
				w.id === CHAINSAW || w.id === FLAMETHROWER
					? "Oil"
					: w.id === STUN_GUN
						? "Charge"
						: ETC_ITEMS[{ 1: 44, 2: 45, 3: 46, 4: 47, 5: 48 }[w.ammoPool]].name;
			return m.has(want) || `no "${want}" line (${[...m.keys()].join(", ")})`;
		},
	);
});

section("A6. the HUD and the Bag draw every weapon with its own name and a pixel icon", () => {
	checkRows("every weapon has an icon (its own or its category's), never the generic box", WEAPONS, w => {
		const ref = iconOf(ItemKind.Weapon, w.id);
		return (ref !== undefined && ref.key !== "cat_item") || `icon ${ref?.key}`;
	});
	checkRows("every weapon name is in lang.ts (the HUD writes tr(w.name))", WEAPONS, w => inLang(w.name) || "missing");
});

/**
 * Everything the game can put in a backpack, as (kind, index): every building's loot, the trees, cars and bins (both
 * tables: the client's that MP_PHASE 2 runs and the server's of F3), every recipe's result and every pack's content.
 */
function itemSources() {
	const out = [];
	for (const table of BUILDING_SPAWNS)
		for (const e of table) out.push({ kind: e.kind, index: e.index, from: "loot" });
	for (const r of CRAFT_RECIPES) out.push({ kind: r.resultKind, index: r.resultIndex, from: `recipe ${r.id}` });
	for (const p of SHOP_PACKS) for (const it of p.items) out.push({ kind: it.kind, index: it.index, from: p.name });
	for (const rel of ["client/systems/interaction.ts", "server/sim/items.ts"]) {
		for (const m of source(rel).matchAll(/\{ kind: (\d), index: (\d+), amount: [\d.]+ \}/g)) {
			out.push({ kind: Number(m[1]), index: Number(m[2]), from: rel });
		}
	}
	return out;
}

section("A7. every weapon can be fed in play: its ammo, oil or charge comes from somewhere", () => {
	const sources = itemSources();
	/** the save fields an item source can raise, through the one door every source goes through (addItem) */
	const raised = new Set();
	for (const s of sources) {
		const save = bareSave();
		const before = Object.fromEntries(ALL_POOLS.map(f => [f, save[f]]));
		INV.addItem(save, s.kind, s.index, 1);
		for (const f of ALL_POOLS) if (save[f] !== before[f]) raised.add(f);
	}
	const fed = GUNS.concat([WEAPONS[CHAINSAW]]);
	const starved = fed.filter(w => !raised.has(fuelField(w)));
	checkRows(
		"every gun but the stun gun has a source for its feed",
		fed.filter(w => w.id !== STUN_GUN),
		w => raised.has(fuelField(w)) || `nothing in play gives ${fuelField(w)}`,
	);
	knownBug(
		"W2",
		starved.length === 1 && starved[0].id === STUN_GUN,
		"the Stun gun can be crafted but never fired: nothing in play ever adds `save.electric` (its charge)",
		`starved: ${starved.map(w => w.name).join(", ") || "none"}`,
	);
});

// ---------------------------------------------------------------- verdict

console.log("");
if (bugs.length > 0) console.log(`${bugs.length} known bug(s) reproduced (reported, not failing): ${bugs.join(", ")}`);
if (failures > 0) {
	console.log(`${failures} of ${checks} check(s) FAILED`);
	process.exit(1);
}
console.log(`${checks} checks, 0 failures`);
