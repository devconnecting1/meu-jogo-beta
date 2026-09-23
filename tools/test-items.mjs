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
 *                  cannot conjure a pet; every costume is sold at the catalogue's price. And the seams of
 *                  MP_PHASE 2, where the server already owns the body and the combat but the backpack is still
 *                  the client's and reaches the server only in a save report (NET-1..6).
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
/** how a failing row is named: its name, or a recipe by its id and what it makes */
function labelOf(row) {
	if (row.name !== undefined) return row.name;
	if (row.resultKind !== undefined) return `recipe #${row.id} (${nameOf(row.resultKind, row.resultIndex)})`;
	return String(row.id ?? JSON.stringify(row));
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
		if (why !== undefined && why !== true) bad.push(`${labelOf(row)}: ${why === false ? "no" : why}`);
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

// ================================================================ B. equipment

/** the EQUIPS row of every slot, and the save field it lives in */
const SLOT_FIELD = ["", "equipCloth", "equipHand", "equipGun", "equipOutfit", "equipPet"];
const COSMETIC = e => e.kind === 4;
const costumeOf = id => COSTUMES.find(c => c.equipId === id);
/** a save that owns `id` the way the game hands it out: in the backpack, or (a costume) bought in the shop */
function owning(id, via = "backpack") {
	const s = bareSave();
	if (via === "costume") s.costumes[costumeOf(id).id] = 1;
	else s.invenEquip[id] = 1;
	return s;
}

section("B1. every equipment row fits exactly one slot, and wears there", () => {
	checkRows("ids are the row's index", EQUIPS, e => EQUIPS[e.id] === e || `row ${EQUIPS.indexOf(e)}`);
	checkRows("every row has a slot (cloth, hand, gun, outfit or pet), never 0", EQUIPS, e => {
		const slot = SAVE.equipSlotOf(e.id);
		if (slot < 1 || slot > EQUIP_SLOT_MAX) return `slot ${slot}`;
		if (!COSMETIC(e)) return slot === e.kind || `kind ${e.kind} in slot ${slot}`;
		return slot === EquipSlot.Outfit || slot === EquipSlot.Pet || `cosmetic in slot ${slot}`;
	});
	checkRows(
		"every cosmetic is sold as a costume (MON-04: the wardrobe is where it comes from)",
		EQUIPS.filter(COSMETIC),
		e => costumeOf(e.id) !== undefined || "no COSTUMES row",
	);
	checkRows("the card names the slot the row really goes in", EQUIPS, e => {
		const card = Info.describeItem(bareSave(), ItemKind.Equip, e.id);
		const slot = card.stats.find(s => s.label === "Slot");
		return slot?.value === Info.SLOT_NAMES[SAVE.equipSlotOf(e.id)] || `card "${slot?.value}"`;
	});
});

section("B2. equip and unequip, per slot, on the server (server/sim/craft.ts: the F3 intents)", () => {
	const craft = new SCRAFT.ServerCraft({ world: W.createWorld(2000, 2000), build: { placing: () => false } });
	checkRows("not owned: refused, and the slot is untouched", EQUIPS, e => {
		const s = bareSave();
		const out = craft.equip(s, e.id);
		return (
			(out.kind === "refused" && out.why === "owned" && s[SLOT_FIELD[SAVE.equipSlotOf(e.id)]] === -1) ||
			JSON.stringify(out)
		);
	});
	checkRows("owned: into its own slot, and off again", EQUIPS, e => {
		const slot = SAVE.equipSlotOf(e.id);
		for (const via of COSMETIC(e) ? ["backpack", "costume"] : ["backpack"]) {
			const s = owning(e.id, via);
			const on = craft.equip(s, e.id);
			if (on.kind !== "equipped" || on.slot !== slot || SAVE.equippedIn(s, slot) !== e.id)
				return `${via}: ${JSON.stringify(on)}`;
			for (let other = 1; other <= EQUIP_SLOT_MAX; other++) {
				if (other !== slot && SAVE.equippedIn(s, other) !== -1) return `${via}: slot ${other} moved too`;
			}
			const off = craft.unequip(s, slot);
			if (off.kind !== "unequipped" || SAVE.equippedIn(s, slot) !== -1)
				return `${via}: unequip ${JSON.stringify(off)}`;
		}
		return true;
	});
	check(
		[0, EQUIP_SLOT_MAX + 1, -1, 1.5].every(slot => craft.unequip(bareSave(), slot).kind === "refused"),
		"an unequip of a slot that does not exist is refused",
	);
	{
		// a second item of the same slot replaces the first (one armour at a time)
		const s = bareSave();
		s.invenEquip[1] = 1;
		s.invenEquip[4] = 1;
		craft.equip(s, 1);
		craft.equip(s, 4);
		checkEq(s.equipCloth, 4, "a second armour replaces the first in the cloth slot");
	}
});

section(
	"B3. the save's guard: a report can wear only what it owns, in that thing's slot (enforceSaveInvariants)",
	() => {
		checkRows("in every slot, each row is kept only when it is that slot's AND owned", EQUIPS, e => {
			const own = SAVE.equipSlotOf(e.id);
			for (let slot = 1; slot <= EQUIP_SLOT_MAX; slot++) {
				for (const owned of [false, true]) {
					const s = owned ? owning(e.id) : bareSave();
					s[SLOT_FIELD[slot]] = e.id;
					SAVE.enforceSaveInvariants(s);
					const kept = s[SLOT_FIELD[slot]] === e.id;
					if (kept !== (owned && slot === own)) return `slot ${slot}, owned ${owned}: kept ${kept}`;
				}
			}
			return true;
		});
		checkRows("through the server's reading of a client report (sanitizeClientReport) too", EQUIPS, e => {
			const base = bareSave();
			const field = SLOT_FIELD[SAVE.equipSlotOf(e.id)];
			const forged = SAVE.sanitizeClientReport({ ...base, [field]: e.id }, base);
			if (forged[field] !== -1) return "worn without owning it";
			const mine = owning(e.id);
			const honest = SAVE.sanitizeClientReport({ ...mine, [field]: e.id }, mine);
			return honest[field] === e.id || "owned, and still taken off";
		});
		checkRows(
			"a report cannot conjure a cosmetic into the backpack (it is the shop's)",
			EQUIPS.filter(COSMETIC),
			e => {
				const base = bareSave();
				const inv = [...base.invenEquip];
				inv[e.id] = 5;
				const upd = SAVE.sanitizeClientReport(
					{ ...base, invenEquip: inv, [SLOT_FIELD[SAVE.equipSlotOf(e.id)]]: e.id },
					base,
				);
				return (
					(upd.invenEquip[e.id] === 0 && upd[SLOT_FIELD[SAVE.equipSlotOf(e.id)]] === -1) ||
					`kept ${upd.invenEquip[e.id]}`
				);
			},
		);
	},
);

section("B4. defence and speed: on with the item, off without it (server damage path and stepPlayer)", () => {
	const world = W.createWorld(8000, 8000);
	const combat = new ServerCombat({ world, targets: { zombies: () => [], bosses: () => [] }, random: () => 0.5 });
	/** a 10-point bite through the server's only way to hurt a survivor (§2.3), on a fresh body */
	const bite = save => {
		const sp = PL.createServerPlayer({ slot: 0, userId: 1, name: "p" }, save, 1000, 1000, 0);
		combat.damageActor(0, sp.state, save, 10);
		return sp.state.hpMax - sp.state.hp;
	};
	/** world units walked in one second through the server's stepPlayer */
	const walk = save => {
		const p = Ply.createPlayer(save, 1000, 1000);
		const cmd = P.makeCommand(1, 1, 0, 0, 0, 0);
		for (let i = 0; i < CFG.SIM_HZ; i++) stepPlayer(world, p, save, cmd, TICK_DT);
		return p.x - 1000;
	};
	const baseBite = bite(bareSave());
	const baseWalk = walk(bareSave());
	checkEq(baseBite, 10, "with nothing worn a 10-point bite takes 10");
	check(
		near(baseWalk, DESIGN.MOVE_SPEED * SPEED_SCALE, 0.5),
		"and the survivor walks MOVE_SPEED",
		`${baseWalk.toFixed(1)} u/s`,
	);
	checkRows(
		"each piece of clothing takes its defence off a bite, and adds its speed to a walk",
		EQUIPS.filter(e => e.kind === EquipSlot.Cloth),
		e => {
			const s = owning(e.id);
			s.equipCloth = e.id;
			const took = bite(s);
			const walked = walk(s);
			if (took !== Math.max(0, 10 - e.def)) return `a bite took ${took}, def ${e.def}`;
			if (!near(walked, (DESIGN.MOVE_SPEED + e.speed) * SPEED_SCALE, 0.5))
				return `walked ${walked.toFixed(1)} u/s, speed ${e.speed}`;
			s.equipCloth = -1;
			return (
				(bite(s) === 10 && near(walk(s), baseWalk, 0.01)) || "taking it off did not restore the plain survivor"
			);
		},
	);
	checkRows(
		"hand, gun and cosmetic items change neither (only clothing is armour)",
		EQUIPS.filter(e => e.kind !== EquipSlot.Cloth),
		e => {
			const s = owning(e.id);
			s[SLOT_FIELD[SAVE.equipSlotOf(e.id)]] = e.id;
			return (bite(s) === 10 && near(walk(s), baseWalk, 0.01)) || `bite ${bite(s)}, walk ${walk(s).toFixed(1)}`;
		},
	);
	{
		// MON-01 by construction: even a cosmetic row that SAID it had defence and speed changes nothing
		const touched = EQUIPS.filter(COSMETIC).map(e => [e, e.def, e.speed]);
		for (const [e] of touched) {
			e.def = 5;
			e.speed = 3;
		}
		try {
			checkRows(
				"MON-01: a cosmetic whose row claimed def 5 / speed 3 still changes nothing when worn",
				EQUIPS.filter(COSMETIC),
				e => {
					const s = owning(e.id, "costume");
					s[SLOT_FIELD[SAVE.equipSlotOf(e.id)]] = e.id;
					return (
						(bite(s) === 10 && near(walk(s), baseWalk, 0.01)) ||
						`bite ${bite(s)}, walk ${walk(s).toFixed(1)}`
					);
				},
			);
		} finally {
			for (const [e, def, speed] of touched) {
				e.def = def;
				e.speed = speed;
			}
		}
	}
	checkRows("the card shows the defence and speed the survivor gets", EQUIPS, e => {
		const card = Info.describeItem(bareSave(), ItemKind.Equip, e.id);
		const m = new Map(card.stats.map(s => [s.label, s.value]));
		const def = e.def !== 0 ? `+${e.def}` : undefined;
		const spd = e.speed === 0 ? undefined : e.speed > 0 ? `+${e.speed}` : `${e.speed}`;
		if (m.get("Defense") !== def) return `Defense "${m.get("Defense")}"`;
		return m.get("Speed") === spd || `Speed "${m.get("Speed")}"`;
	});
});

section(
	"B5. what the gadgets do: laser sight, silencer, watches, flashlight, torch, night vision, compass, GPS",
	() => {
		const FLASHLIGHT = 13;
		const TORCH = 15;
		const NIGHT_VISION = 6;
		const COMPASS = 8;
		const GPS = 16;
		{
			// the laser sight narrows the server's spread roll; the silencer divides the shot's noise ring by 3
			const spread = equipGun => {
				const rolls = [];
				let r = 0;
				const values = [0.9, 0.1, 0.7, 0.3, 0.95, 0.05, 0.6, 0.4, 0.99, 0.01, 0.8];
				const world = W.createWorld(4000, 4000);
				const noise = [];
				const combat = new ServerCombat({
					world,
					targets: { zombies: () => [], bosses: () => [] },
					random: () => values[r++ % values.length],
					hooks: {
						noise: (x, y, radius) => noise.push(radius),
						fx: e => {
							if (e.t === P.FxType.Shot) rolls.push(Math.abs(e.hits[0].y - 1000));
						},
					},
				});
				const save = bareSave();
				save.invenWeapon[10] = 1;
				save.equipWeapon = 10;
				save.ammoNormal = 100;
				if (equipGun >= 0) {
					save.invenEquip[equipGun] = 1;
					save.equipGun = equipGun;
				}
				const sp = PL.createServerPlayer({ slot: 0, userId: 1, name: "p" }, save, 1000, 1000, 0);
				for (let t = 1; t <= 600; t++) {
					const cmd = P.makeCommand(t, 0, 0, 0, P.HeldBit.Attack, P.packEdges(1, 0, 0, 0));
					stepPlayer(world, sp.state, save, cmd, TICK_DT);
					sp.state.weapon.angleRange = 0; // no recoil build-up: the roll alone is measured
					combat.stepPlayer(sp, cmd, t, TICK_DT);
				}
				return {
					spread: rolls.reduce((a, b) => a + b, 0) / Math.max(1, rolls.length),
					noise: noise[0],
					n: rolls.length,
				};
			};
			const plain = spread(-1);
			const laser = spread(7);
			const quiet = spread(12);
			check(
				laser.spread < plain.spread,
				"the laser sight tightens the server's spread",
				`${plain.spread.toFixed(1)} -> ${laser.spread.toFixed(1)} u`,
			);
			check(
				near(quiet.noise, plain.noise / 3, 1e-6),
				"the gun silencer makes a shot heard a third as far",
				`${plain.noise} -> ${quiet.noise}`,
			);
		}
		{
			// the watches put the clock on the HUD (client/main.client.ts showClock): by hand name, so the names must hold
			const hud = source("client/main.client.ts");
			for (const id of [9, 10, 11])
				check(
					hud.includes(`"${EQUIPS[id].name}"`),
					`the HUD shows the clock with the ${EQUIPS[id].name} in hand`,
				);
		}
		{
			// at night the SERVER lights a survivor's surroundings for the horde's visibility (zombieBrain isLit):
			// the flashlight a 45° cone out to 560 u ahead, the torch 400 u all round, bare hands 250 u
			const Brain = require(join(SRC, "shared/sim/ai/zombieBrain.ts"));
			const litAt = (hand, dx, dy) => {
				const world = W.createWorld(8000, 8000);
				const sim = new ServerSimulation({
					world,
					clock: new WorldClock({ day: 1, dayTime: 0 }),
					zombies: true,
					interactive: false,
				});
				const save = bareSave();
				if (hand >= 0) {
					save.invenEquip[hand] = 1;
					save.equipHand = hand;
				}
				const sp = PL.createServerPlayer(
					{ slot: 0, userId: 1, name: "p" },
					save,
					4000,
					4000,
					sim.tick,
					sim.simHz,
				);
				sim.add(sp);
				sp.state.angle = 0;
				for (let i = 0; i < 3; i++) sim.step();
				sp.state.x = 4000;
				sp.state.y = 4000;
				sp.state.angle = 0;
				sim.step();
				return Brain.spawnAlpha(sim.horde.refs, sp.state.x + dx, sp.state.y + dy) === 1;
			};
			check(!litAt(-1, 400, 0), "bare hands: 400 u ahead is dark at midnight");
			check(litAt(FLASHLIGHT, 400, 0), "the flashlight lights 400 u ahead for the horde's visibility");
			check(!litAt(FLASHLIGHT, -400, 0), "and not 400 u behind (it is a cone)");
			check(!litAt(-1, 0, 350), "bare hands: 350 u to the side is dark");
			check(litAt(TORCH, 0, 350), "the torchlight lights 350 u all round");
			// what the PLAYER sees is the client's light map (client/gameLoop.ts drawLight): its survivor light is a
			// fixed PLAYER_LIGHT_R, whatever is in the hand
			const draw = source("client/gameLoop.ts");
			const body = draw.slice(draw.indexOf("private drawLight("), draw.indexOf("hideWorld(): void"));
			knownBug(
				"E1",
				body.length > 0 && !/equipHand/.test(body),
				"the flashlight and the torchlight never light the SCREEN at night: the light map draws the survivor's plain 250 u whatever is in hand, while the server lights zombies in the cone (they glow in the dark)",
			);
		}
		{
			// a gadget is worth its slot only if some code reads it: search every system for its id
			const readers = id => {
				const hits = [];
				for (const rel of [
					"client/gameLoop.ts",
					"client/main.client.ts",
					"client/systems/daynight.ts",
					"client/systems/combat.ts",
					"server/sim/combat.ts",
					"shared/sim/ai/zombieBrain.ts",
					"shared/game/player.ts",
				]) {
					const src = source(rel);
					if (
						new RegExp(`equip(Hand|Gun|Cloth)\\s*===\\s*${id}\\b`).test(src) ||
						src.includes(`"${EQUIPS[id].name}"`)
					)
						hits.push(rel);
				}
				if (id === 7 || id === 12) hits.push("server/sim/combat.ts (LASER_SIGHT_ID / SILENCER_ID)");
				return hits;
			};
			const dead = [NIGHT_VISION, COMPASS, GPS].filter(id => readers(id).length === 0);
			knownBug(
				"E2",
				dead.length > 0,
				"gadgets that nothing reads: equipping them changes nothing anywhere (P3)",
				dead.map(id => EQUIPS[id].name).join(", "),
			);
		}
	},
);

// ================================================================ C. usables

/** the Bag itself (client/ui/backpack.ts), on the ui-shim tree: its labels are read off its own detail builders */
const { Backpack } = require(join(SRC, "client/ui/backpack.ts"));
function bagFor(save) {
	const gui = ui.makeInstance("ScreenGui", false);
	const layer = ui.makeInstance("Frame", false);
	layer.Parent = gui;
	return new Backpack({ phase: "playing", save, uiLayer: layer, screen: gui });
}

section(
	"C1. every usable, eaten through the server's useItem: exactly what the data says (server/sim/craft.ts)",
	() => {
		const craft = new SCRAFT.ServerCraft({ world: W.createWorld(2000, 2000), build: { placing: () => false } });
		/** a hungry, hurt survivor holding two of `u` */
		const holder = u => {
			const save = bareSave();
			save.invenUse[u.id] = 2;
			const p = Ply.createPlayer(save, 1000, 1000);
			p.hp = u.hp < 0 ? p.hpMax : p.hpMax - 60;
			p.hungry = 40;
			return { save, p };
		};
		checkRows(
			"hp, hunger, speed, calm and pain change by the data's numbers, and one leaves the backpack",
			USABLES,
			u => {
				const { save, p } = holder(u);
				const hp = p.hp;
				craft.remove(0); // a fresh survivor: no cooldown carried over from the previous row
				const out = craft.useItem(0, p, save, u.id);
				if (out.kind !== "used") return JSON.stringify(out);
				if (p.hp !== Math.min(p.hpMax, hp + u.hp)) return `hp ${hp} -> ${p.hp}, data ${u.hp}`;
				if (p.hungry !== Math.min(p.hungryMax, 40 + u.hunger))
					return `hunger 40 -> ${p.hungry}, data ${u.hunger}`;
				if (p.buffs.speed !== u.speed * 60 || p.buffs.calm !== u.calm * 60 || p.buffs.pain !== u.pain * 60) {
					return `buffs ${p.buffs.speed}/${p.buffs.calm}/${p.buffs.pain} s, data ${u.speed}/${u.calm}/${u.pain} min`;
				}
				return save.invenUse[u.id] === 1 || `count ${save.invenUse[u.id]}`;
			},
		);
		checkRows(
			"the 0.25 s cooldown holds: a second use at once is refused, and goes through after it",
			USABLES,
			u => {
				const { save, p } = holder(u);
				craft.remove(0);
				craft.useItem(0, p, save, u.id);
				const again = craft.useItem(0, p, save, u.id);
				if (again.kind !== "refused" || again.why !== "rate" || save.invenUse[u.id] !== 1)
					return `at once: ${JSON.stringify(again)}`;
				craft.step(SCRAFT.USE_COOLDOWN - 0.01);
				if (craft.useItem(0, p, save, u.id).kind !== "refused") return "went through before 0.25 s";
				craft.step(0.02);
				p.hp = u.hp < 0 ? p.hpMax : 1;
				p.hungry = 1;
				const later = craft.useItem(0, p, save, u.id);
				return (
					(later.kind === "used" && save.invenUse[u.id] === 0) ||
					`after the cooldown: ${JSON.stringify(later)}`
				);
			},
		);
		checkRows('with none left it is refused and nothing changes (the Bag\'s "None left")', USABLES, u => {
			const save = bareSave();
			const p = Ply.createPlayer(save, 1000, 1000);
			p.hp = 10;
			p.hungry = 10;
			craft.remove(0);
			const out = craft.useItem(0, p, save, u.id);
			return (
				(out.kind === "refused" && p.hp === 10 && p.hungry === 10 && save.invenUse[u.id] === 0) ||
				JSON.stringify(out)
			);
		});
		checkRows("a dead survivor eats nothing", USABLES, u => {
			const { save, p } = holder(u);
			p.dead = true;
			craft.remove(0);
			const out = craft.useItem(0, p, save, u.id);
			return (out.kind === "refused" && out.why === "busy" && save.invenUse[u.id] === 2) || JSON.stringify(out);
		});
		checkRows(
			"food with nothing to fill and no buff is not wasted when full (itemUseEffect's no-op rule)",
			USABLES.filter(u => u.hp >= 0 && u.speed === 0 && u.calm === 0 && u.pain === 0),
			u => {
				const save = bareSave();
				save.invenUse[u.id] = 1;
				const p = Ply.createPlayer(save, 1000, 1000);
				craft.remove(0);
				const out = craft.useItem(0, p, save, u.id);
				return (
					(out.kind === "refused" && out.why === "noop" && save.invenUse[u.id] === 1) || JSON.stringify(out)
				);
			},
		);
		checkRows(
			"a medicine with a timed effect is used even at full health (the buff is the point)",
			USABLES.filter(u => u.speed > 0 || u.calm > 0 || u.pain > 0),
			u => {
				const save = bareSave();
				save.invenUse[u.id] = 1;
				const p = Ply.createPlayer(save, 1000, 1000);
				craft.remove(0);
				return craft.useItem(0, p, save, u.id).kind === "used" || "refused at full health";
			},
		);
		{
			// Rotten meat hurts: at 5 hp it kills, through the server's own stepPlayer
			const rotten = USABLES.find(u => u.hp < 0);
			const save = bareSave();
			save.invenUse[rotten.id] = 1;
			const p = Ply.createPlayer(save, 1000, 1000);
			p.hp = 5;
			craft.remove(0);
			craft.useItem(0, p, save, rotten.id);
			stepPlayer(W.createWorld(2000, 2000), p, save, P.makeCommand(1, 0, 0, 0, 0, 0), TICK_DT);
			check(p.dead, `${rotten.name} at 5 hp kills (${rotten.hp} hp)`, `hp ${p.hp}`);
		}
	},
);

section(
	"C2. the three timed effects do what the card says, and wear off (shared/game/player.ts, server/sim/combat.ts)",
	() => {
		const world = W.createWorld(8000, 8000);
		const walk = (p, save) => {
			const x = p.x;
			const cmd = P.makeCommand(1, 1, 0, 0, 0, 0);
			for (let i = 0; i < CFG.SIM_HZ; i++) stepPlayer(world, p, save, cmd, TICK_DT);
			return p.x - x;
		};
		checkRows(
			"speed: +2 walking speed for its minutes, then gone",
			USABLES.filter(u => u.speed > 0),
			u => {
				const save = bareSave();
				save.invenUse[u.id] = 1;
				const p = Ply.createPlayer(save, 1000, 1000);
				const plain = walk(p, save);
				Ply.itemUseEffect(p, save, u.id);
				const fast = walk(p, save);
				if (!near(fast - plain, 2 * SPEED_SCALE, 0.5)) return `${plain.toFixed(0)} -> ${fast.toFixed(0)} u/s`;
				p.buffs.speed = 0.5;
				walk(p, save);
				return near(walk(p, save), plain, 0.5) || "still fast after it ran out";
			},
		);
		checkRows(
			"pain relief: a bite no longer slows the survivor down while it lasts",
			USABLES.filter(u => u.pain > 0),
			u => {
				const save = bareSave();
				save.invenUse[u.id] = 1;
				const p = Ply.createPlayer(save, 1000, 1000);
				p.attacked = true;
				p.iframe = 100;
				const slowed = Ply.recalcMoveSpeed(p, save);
				Ply.itemUseEffect(p, save, u.id);
				return Ply.recalcMoveSpeed(p, save) === slowed + 1.5 || `${slowed} -> ${Ply.recalcMoveSpeed(p, save)}`;
			},
		);
		checkRows(
			"steady aim: the server's recoil settles faster while it lasts",
			USABLES.filter(u => u.calm > 0),
			u => {
				const settle = calm => {
					const fx = weaponFixture(15);
					fx.sp.state.weapon.angleRange = 30;
					if (calm) {
						fx.save.invenUse[u.id] = 1;
						Ply.itemUseEffect(fx.sp.state, fx.save, u.id);
					}
					fx.run(0.25, {});
					return fx.sp.state.weapon.angleRange;
				};
				const plain = settle(false);
				const steady = settle(true);
				return (
					steady < plain || `recoil left after 0.25 s: ${plain.toFixed(2)} plain, ${steady.toFixed(2)} steady`
				);
			},
		);
	},
);

section('C3. the Bag says Eat for food and Use for medicine, and "None left" at zero (client/ui/backpack.ts)', () => {
	const MEDICINE = u => u.pain > 0 || u.speed > 0 || u.calm > 0 || (u.hunger <= 0 && u.hp > 0);
	checkRows("the card's type: Medicine for what treats or heals without feeding, Food for the rest", USABLES, u => {
		const card = Info.describeItem(bareSave(), ItemKind.Use, u.id);
		return card.type === (MEDICINE(u) ? "Medicine" : "Food") || `card "${card.type}"`;
	});
	checkRows('the button: Eat on food, Use on medicine, disabled "None left" at zero', USABLES, u => {
		const save = bareSave();
		save.invenUse[u.id] = 1;
		const bag = bagFor(save);
		const one = bag.usableDetail(u.id);
		const want = MEDICINE(u) ? "Use" : "Eat";
		if (one.act.text !== want || !one.act.enabled) return `with one: "${one.act.text}" enabled ${one.act.enabled}`;
		save.invenUse[u.id] = 0;
		const none = bag.usableDetail(u.id);
		return (
			(none.act.text === "None left" && !none.act.enabled) ||
			`with none: "${none.act.text}" enabled ${none.act.enabled}`
		);
	});
	checkRows("the card lists what the data says: health, hunger and each timed effect in minutes", USABLES, u => {
		const card = Info.describeItem(bareSave(), ItemKind.Use, u.id);
		const m = new Map(card.stats.map(s => [s.label, s.value]));
		const sign = v => (v > 0 ? `+${v}` : `${v}`);
		if (m.get("Health recovery") !== (u.hp !== 0 ? sign(u.hp) : undefined))
			return `hp "${m.get("Health recovery")}"`;
		if (m.get("Hunger recovery") !== (u.hunger !== 0 ? sign(u.hunger) : undefined))
			return `hunger "${m.get("Hunger recovery")}"`;
		for (const [label, v] of [
			["Speed boost", u.speed],
			["Steady aim", u.calm],
			["Pain relief", u.pain],
		]) {
			if (m.get(label) !== (v > 0 ? `${v} min` : undefined)) return `${label} "${m.get(label)}"`;
		}
		return true;
	});
});

section("C4. cooking: what the card and the How to play promise (Núcleo 1: raw meat → cooked, CON-03)", () => {
	const raw = USABLES.filter(u => u.cook >= 0);
	const card = Info.describeItem(bareSave(), ItemKind.Use, raw[0].id);
	check(
		card.stats.some(s => s.label === "Cooks into"),
		`the ${raw[0].name} card says "Cooks into ${USABLES[raw[0].cook].name}"`,
	);
	const tip = source("client/ui/tutorial.ts").includes("cooks what you find");
	// every way a cooked row could come out of a raw one: a recipe taking it, or any code reading `.cook`
	const cooked = raw.filter(u =>
		CRAFT_RECIPES.some(
			r =>
				r.resultKind === ItemKind.Use &&
				r.resultIndex === u.cook &&
				r.ingredients.some(i => i.kind === ItemKind.Use && i.index === u.id),
		),
	);
	const readers = [
		"client/systems/interaction.ts",
		"server/sim/interaction.ts",
		"client/systems/craftSystem.ts",
		"server/sim/craft.ts",
		"client/main.client.ts",
		"client/gameLoop.ts",
	].filter(rel => /\.cook\b/.test(source(rel)));
	knownBug(
		"C1",
		cooked.length === 0 && readers.length === 0,
		`nothing cooks: ${raw.length} usables have a "Cooks into" row on their card${tip ? ' and How to play says fire "cooks what you find"' : ""}, but no recipe or code turns raw into cooked`,
		raw.map(u => `${u.name} → ${USABLES[u.cook].name}`).join(", "),
	);
});

// ================================================================ D. crafting

const INV_FIELD = { 1: "invenWeapon", 2: "invenEquip", 3: "invenUse", 4: "invenEtc" };
/** a station of `kind` ("desk", "pro", "fire", "furnace", "cold", "campfire") next to (x, y) */
function station(world, kind, x, y) {
	const tags = {
		desk: "craftdesk",
		pro: "craftdesk_pro",
		fire: "brazier",
		cold: "brazier",
		furnace: "furnace",
		campfire: "campfire",
	}[kind];
	return W.addSolid(world, {
		kind: "structure",
		x: x + 40,
		y: y - 30,
		w: 96,
		h: 64,
		hp: 200,
		hpMax: 200,
		destructible: true,
		tags,
		powered: kind === "fire" || kind === "campfire" ? true : kind === "cold" ? false : undefined,
	});
}
/** the one station a recipe asks for, or undefined for a hand recipe */
const stationOf = r => (r.needsPro ? "pro" : r.needsDesk ? "desk" : r.needsFire === true ? "fire" : undefined);
/** a save holding exactly `times` × the recipe's ingredients and nothing else of them */
function stocked(r, times = 1) {
	const s = bareSave();
	for (let i = 0; i < s.invenWeapon.length; i++) s.invenWeapon[i] = 0;
	for (const ing of r.ingredients) INV.addItem(s, ing.kind, ing.index, ing.count * times);
	return s;
}
/** the client refs `craft` / `craftBlocker` read (client/systems/craftSystem.ts: the path MP_PHASE 2 ships) */
function craftRefs(save, stationKind) {
	const world = W.createWorld(4000, 4000);
	const player = Ply.createPlayer(save, 1000, 1000);
	if (stationKind !== undefined) station(world, stationKind, 1000, 1000);
	return { world, players: [player], player, save, pendingPlace: -1, fx: [], onMessage: () => {} };
}
const ingredientsLeft = (save, r) => r.ingredients.map(i => INV.countItem(save, i.kind, i.index)).join(",");

section("D1. every recipe is coherent: real ingredients, a real result, and a placeable for every build", () => {
	checkRows(
		"ids are the row's index",
		CRAFT_RECIPES,
		r => CRAFT_RECIPES[r.id] === r || `row ${CRAFT_RECIPES.indexOf(r)}`,
	);
	checkRows("every ingredient and every result is a real item, counted above zero", CRAFT_RECIPES, r => {
		for (const i of r.ingredients)
			if (nameOf(i.kind, i.index) === undefined || !(i.count > 0))
				return `ingredient ${i.kind}:${i.index} x${i.count}`;
		if (nameOf(r.resultKind, r.resultIndex) === undefined) return `result ${r.resultKind}:${r.resultIndex}`;
		return r.resultCount > 0 || `makes ${r.resultCount}`;
	});
	checkRows(
		"a build recipe (craftKind 1) makes something the world can place",
		CRAFT_RECIPES.filter(r => r.craftKind === 1),
		r =>
			(r.resultKind === ItemKind.Etc && PLACEABLES[r.resultIndex] !== undefined) ||
			`result ${r.resultKind}:${r.resultIndex}`,
	);
	checkRows(
		"every placeable has a recipe",
		Object.keys(PLACEABLES).map(k => ({ id: Number(k), name: ETC_ITEMS[Number(k)].name })),
		p => CRAFT_RECIPES.some(r => r.craftKind === 1 && r.resultIndex === p.id) || "no recipe builds it",
	);
	checkRows(
		"a recipe asks for one station at most (hand, desk, pro desk or fire)",
		CRAFT_RECIPES,
		r => [r.needsDesk, r.needsPro, r.needsFire === true].filter(Boolean).length <= 1 || "two stations",
	);
});

section(
	"D2. every recipe through the client's craft (MP_PHASE 2): station, exact ingredients, MAKES ×N, no double",
	() => {
		setSeed(11);
		checkRows(
			"without its station it is refused and nothing is spent",
			CRAFT_RECIPES.filter(r => stationOf(r) !== undefined),
			r => {
				const save = stocked(r);
				const refs = craftRefs(save, undefined);
				const before = ingredientsLeft(save, r);
				if (CCraft.craft(refs, r.id)) return "crafted with no station";
				return ingredientsLeft(save, r) === before || `spent: ${before} -> ${ingredientsLeft(save, r)}`;
			},
		);
		checkRows(
			"with a station of the WRONG kind it is refused too (a desk is not a pro desk, an unlit brazier no fire)",
			CRAFT_RECIPES.filter(r => r.needsPro || r.needsFire === true),
			r => {
				const save = stocked(r);
				const refs = craftRefs(save, r.needsPro ? "desk" : "cold");
				return !CCraft.craft(refs, r.id) || `crafted next to a ${r.needsPro ? "plain desk" : "cold brazier"}`;
			},
		);
		checkRows("without its ingredients it is refused and nothing is spent", CRAFT_RECIPES, r => {
			for (let k = 0; k < r.ingredients.length; k++) {
				const save = stocked(r);
				const ing = r.ingredients[k];
				INV.removeItem(save, ing.kind, ing.index, 1);
				const refs = craftRefs(save, stationOf(r));
				const before = ingredientsLeft(save, r);
				if (CCraft.craft(refs, r.id)) return `crafted one ${nameOf(ing.kind, ing.index)} short`;
				if (ingredientsLeft(save, r) !== before) return "spent on a refusal";
			}
			return true;
		});
		checkRows(
			"with them: every ingredient goes exactly, and MAKES ×N comes out (a build goes on the cursor)",
			CRAFT_RECIPES,
			r => {
				const save = stocked(r);
				const refs = craftRefs(save, stationOf(r));
				const had = INV.countItem(save, r.resultKind, r.resultIndex);
				if (!CCraft.craft(refs, r.id)) return `refused: ${CCraft.craftBlocker(refs, r)}`;
				if (ingredientsLeft(save, r) !== r.ingredients.map(() => 0).join(","))
					return `left over ${ingredientsLeft(save, r)}`;
				if (r.craftKind === 1)
					return (
						(refs.pendingPlace === r.resultIndex && refs.pendingRecipe === r.id) ||
						`cursor ${refs.pendingPlace}`
					);
				const got = INV.countItem(save, r.resultKind, r.resultIndex) - had;
				return got === r.resultCount || `made ${got}, MAKES ×${r.resultCount}`;
			},
		);
		checkRows("a double click with ingredients for one crafts once", CRAFT_RECIPES, r => {
			const save = stocked(r);
			const refs = craftRefs(save, stationOf(r));
			const had = INV.countItem(save, r.resultKind, r.resultIndex);
			const first = CCraft.craft(refs, r.id);
			const second = CCraft.craft(refs, r.id);
			if (!first || second) return `first ${first}, second ${second}`;
			return (
				r.craftKind === 1 ||
				INV.countItem(save, r.resultKind, r.resultIndex) - had === r.resultCount ||
				"made twice"
			);
		});
		checkRows(
			"a desk recipe also works at a pro desk, and smelting at the electric furnace",
			CRAFT_RECIPES.filter(r => (r.needsDesk && !r.needsPro) || r.needsFire === true),
			r => {
				const save = stocked(r);
				const refs = craftRefs(save, r.needsFire === true ? "furnace" : "pro");
				return CCraft.craft(refs, r.id) || CCraft.craftBlocker(refs, r);
			},
		);
		{
			// Dwarf (skill 12): smelting sometimes yields double -- 15 % at level 1, 30 % at level 2 (item_fire)
			const smelt = CRAFT_RECIPES.find(r => r.needsFire === true);
			for (const lv of [0, 1, 2]) {
				setSeed(100 + lv);
				let doubles = 0;
				const N = 2000;
				for (let i = 0; i < N; i++) {
					const save = stocked(smelt);
					save.skillLevels[12] = lv;
					CCraft.craft(craftRefs(save, "fire"), smelt.id);
					if (INV.countItem(save, smelt.resultKind, smelt.resultIndex) === 2 * smelt.resultCount) doubles++;
				}
				const want = [0, 0.15, 0.3][lv];
				check(
					near(doubles / N, want, 0.03),
					`Dwarf ${lv}: ${(want * 100).toFixed(0)} % of smelts come out double`,
					`${((doubles / N) * 100).toFixed(1)} %`,
				);
			}
		}
	},
);

section(
	"D3. every recipe through the server's craft (F3's intent): the same rules, one transaction, 4 per second",
	() => {
		const build = { placing: () => false, hold: () => {} };
		const serverCraft = (r, stationKind, save) => {
			const world = W.createWorld(4000, 4000);
			if (stationKind !== undefined) station(world, stationKind, 1000, 1000);
			const c = new SCRAFT.ServerCraft({ world, build });
			return { c, p: Ply.createPlayer(save, 1000, 1000) };
		};
		checkRows(
			"refused without its station, and nothing spent",
			CRAFT_RECIPES.filter(r => stationOf(r) !== undefined),
			r => {
				const save = stocked(r);
				const before = ingredientsLeft(save, r);
				const { c, p } = serverCraft(r, undefined, save);
				const out = c.craft(0, p, save, r.id);
				return (
					(out.kind === "refused" && out.why === "station" && ingredientsLeft(save, r) === before) ||
					JSON.stringify(out)
				);
			},
		);
		checkRows("refused one ingredient short, and nothing spent", CRAFT_RECIPES, r => {
			const save = stocked(r);
			const ing = r.ingredients[r.ingredients.length - 1];
			INV.removeItem(save, ing.kind, ing.index, 1);
			const before = ingredientsLeft(save, r);
			const { c, p } = serverCraft(r, stationOf(r), save);
			const out = c.craft(0, p, save, r.id);
			return (
				(out.kind === "refused" && out.why === "ingredients" && ingredientsLeft(save, r) === before) ||
				JSON.stringify(out)
			);
		});
		checkRows(
			"with them: exact ingredients out, MAKES ×N in (a build is held for the cursor)",
			CRAFT_RECIPES,
			r => {
				const save = stocked(r);
				const { c, p } = serverCraft(r, stationOf(r), save);
				const had = INV.countItem(save, r.resultKind, r.resultIndex);
				const out = c.craft(0, p, save, r.id);
				if (ingredientsLeft(save, r) !== r.ingredients.map(() => 0).join(","))
					return `left over ${ingredientsLeft(save, r)}`;
				if (r.craftKind === 1)
					return (out.kind === "holding" && out.placeable === r.resultIndex) || JSON.stringify(out);
				const got = INV.countItem(save, r.resultKind, r.resultIndex) - had;
				return (
					(out.kind === "crafted" && got === r.resultCount && out.count === r.resultCount) ||
					`${JSON.stringify(out)}, made ${got}`
				);
			},
		);
		checkRows(
			"two crafts in the same tick with ingredients for two: the second waits for the 4/s limit",
			CRAFT_RECIPES,
			r => {
				const save = stocked(r, 2);
				const { c, p } = serverCraft(r, stationOf(r), save);
				c.craft(0, p, save, r.id);
				const second = c.craft(0, p, save, r.id);
				if (second.kind !== "refused" || second.why !== "rate") return `second: ${JSON.stringify(second)}`;
				c.step(1 / SCRAFT.CRAFT_RATE);
				return c.craft(0, p, save, r.id).kind !== "refused" || "still refused after 0.25 s";
			},
		);
		check(
			[99999, -1, 0.5, CRAFT_RECIPES.length].every(
				id =>
					new SCRAFT.ServerCraft({ world: W.createWorld(100, 100), build }).craft(
						0,
						Ply.createPlayer(bareSave(), 50, 50),
						bareSave(),
						id,
					).kind === "refused",
			),
			"a recipe id that does not exist is refused",
		);
		{
			// "near a desk": the client (and so the Bag's Craft button) measures the box distance, the server the true one
			const world = W.createWorld(4000, 4000);
			W.addSolid(world, {
				kind: "structure",
				x: 1000,
				y: 1000,
				w: 96,
				h: 64,
				hp: 200,
				hpMax: 200,
				destructible: true,
				tags: "craftdesk",
			});
			const x = 1000 + 96 + 150;
			const y = 1000 + 64 + 150; // 150 u off the corner on both axes: 212 u away
			const clientNear = CCraft.stationNear({ world, player: { x, y } }, "desk") !== undefined;
			const serverNear = SCRAFT.stationNear(world, x, y, "desk") !== undefined;
			knownBug(
				"D2",
				clientNear && !serverNear,
				'client and server disagree on "near a desk" off a corner (box vs true distance): from F3 the Bag would offer a craft the server refuses',
				`client ${clientNear}, server ${serverNear} at 212 u`,
			);
		}
	},
);

section(
	"D4. the Bag's craft panel: MAKES ×N, the counts it shows and the station it asks for (client/ui/backpack.ts)",
	() => {
		checkRows("the panel says MAKES ×resultCount and shows the backpack's real counts", CRAFT_RECIPES, r => {
			const save = stocked(r);
			const bag = bagFor(save);
			bag.nearbyDesk = true;
			bag.nearbyPro = true;
			bag.nearbyFire = true;
			const [m] = bag.recipePanel(r);
			if (m.state !== `MAKES ×${r.resultCount}`) return `"${m.state}"`;
			for (let k = 0; k < r.ingredients.length; k++) {
				const ing = r.ingredients[k];
				const want = `${INV.countItem(save, ing.kind, ing.index)} / ${ing.count}`;
				if (m.ingredients[k].count !== want)
					return `${nameOf(ing.kind, ing.index)}: "${m.ingredients[k].count}", backpack ${want}`;
			}
			return (m.action.enabled && m.action.text === "Craft") || `"${m.action.text}" enabled ${m.action.enabled}`;
		});
		checkRows(
			"away from its station the button names what is missing, and is off",
			CRAFT_RECIPES.filter(r => stationOf(r) !== undefined),
			r => {
				const bag = bagFor(stocked(r));
				const [m] = bag.recipePanel(r);
				const want = r.needsFire === true ? "Need fire" : r.needsPro ? "Need pro desk" : "Need craft desk";
				return (
					(m.action.text === want && !m.action.enabled) || `"${m.action.text}" enabled ${m.action.enabled}`
				);
			},
		);
	},
);

section("D5. every build recipe, placed through the SERVER world (server/sim/build.ts, as test:world)", () => {
	const PRESS_ATTACK = P.packEdges(1, 0, 0, 0);
	const PRESS_E = P.packEdges(0, 0, 1, 0);
	checkRows(
		"craft → cursor → the attack places it, with the placeable's tag, owner and hp; E cancels and refunds",
		CRAFT_RECIPES.filter(r => r.craftKind === 1),
		r => {
			const world = W.serverWorld(W.createWorld(8000, 8000));
			const sim = new ServerSimulation({
				world,
				clock: new WorldClock({ day: 1, dayTime: 12 }),
				zombies: false,
				interactive: true,
			});
			const save = stocked(r, 2);
			const sp = PL.createServerPlayer(
				{ slot: 0, userId: 900, name: "p0" },
				save,
				3000,
				3000,
				sim.tick,
				sim.simHz,
			);
			sim.add(sp);
			sp.state.x = 3000;
			sp.state.y = 3000;
			const s = stationOf(r);
			if (s !== undefined) station(world, s, 3000, 2800);
			let seq = 0;
			const send = edges =>
				PL.ingestInput(
					sp,
					P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [P.makeCommand(++seq, 0, 0, 0, 0, edges)] }),
					0,
				);
			const held = sim.craft.craft(0, sp.state, save, r.id);
			if (held.kind !== "holding") return `craft: ${JSON.stringify(held)}`;
			const solids = world.solids.length;
			send(PRESS_ATTACK);
			sim.step();
			if (world.solids.length !== solids + 1) return "the attack placed nothing";
			const built = world.solids[world.solids.length - 1];
			const def = PLACEABLES[r.resultIndex];
			if (built.tags !== def.tag || built.hp !== def.hp || built.owner !== 0)
				return `placed ${built.tags} hp ${built.hp} owner ${built.owner}`;
			// the second one: on the cursor, then cancelled -- the ingredients come back
			sim.craft.step(1);
			sim.craft.craft(0, sp.state, save, r.id);
			const spent = ingredientsLeft(save, r);
			send(PRESS_E);
			sim.step();
			if (sim.build.placing(0)) return "E did not cancel";
			const back = ingredientsLeft(save, r);
			return back === r.ingredients.map(i => i.count).join(",") || `after the cancel: ${spent} -> ${back}`;
		},
	);
	{
		// a placed lamp starts dark; E switches it on, and then it lights the night for the horde's visibility
		const Brain = require(join(SRC, "shared/sim/ai/zombieBrain.ts"));
		const world = W.serverWorld(W.createWorld(8000, 8000));
		const sim = new ServerSimulation({
			world,
			clock: new WorldClock({ day: 1, dayTime: 0 }),
			zombies: true,
			interactive: true,
		});
		const save = bareSave();
		const sp = PL.createServerPlayer({ slot: 0, userId: 900, name: "p0" }, save, 3000, 3000, sim.tick, sim.simHz);
		sim.add(sp);
		const lamp = W.addSolid(world, {
			kind: "structure",
			x: 3030,
			y: 2980,
			w: 48,
			h: 48,
			hp: 400,
			hpMax: 400,
			destructible: true,
			tags: "lamp",
			powered: false,
			placeable: 4,
			owner: 0,
		});
		const spot = () => {
			sp.state.x = 3000;
			sp.state.y = 3000;
			for (let i = 0; i < 4; i++) sim.step();
			return Brain.spawnAlpha(sim.horde.refs, 3054 + 330, 3004) === 1;
		};
		check(!spot(), "a placed lamp starts off: 330 u from it is dark");
		PL.ingestInput(
			sp,
			P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [P.makeCommand(1, 0, 0, 0, 0, P.packEdges(0, 0, 1, 0))] }),
			0,
		);
		sim.step();
		check(lamp.powered === true, "E switches it on (server interaction)");
		check(spot(), "and then it lights 330 u around it at midnight");
	}
});

section("D6. crafting with the item in your hands: what the recipe ate comes off (fixed, QA 2026-09-23)", () => {
	// a recipe that eats a weapon or a piece of equipment the survivor has EQUIPPED: the pistol that becomes an auto
	// pistol, the steel armour that becomes a robot suit, the flashlight inside a laser sight. Before the fix the
	// slot kept the eaten item: the armour went on protecting and the pistol stayed in the client's hands.
	const eating = CRAFT_RECIPES.filter(r =>
		r.ingredients.some(i => i.kind === ItemKind.Weapon || i.kind === ItemKind.Equip),
	);
	const stale = save => {
		const out = [];
		if (save.equipWeapon >= 0 && !SAVE.ownsWeapon(save, save.equipWeapon))
			out.push(`weapon ${WEAPONS[save.equipWeapon].name}`);
		for (let slot = 1; slot <= EQUIP_SLOT_MAX; slot++) {
			const id = SAVE.equippedIn(save, slot);
			if (id >= 0 && !SAVE.ownsEquip(save, id)) out.push(`${SLOT_FIELD[slot]} ${EQUIPS[id].name}`);
		}
		return out;
	};
	const wearAll = (save, r) => {
		for (const i of r.ingredients) {
			if (i.kind === ItemKind.Weapon) save.equipWeapon = i.index;
			if (i.kind === ItemKind.Equip) SAVE.setEquipped(save, SAVE.equipSlotOf(i.index), i.index);
		}
	};
	checkRows("client craft: nothing stays equipped that the backpack no longer has", eating, r => {
		const save = stocked(r);
		wearAll(save, r);
		const refs = craftRefs(save, stationOf(r));
		if (!CCraft.craft(refs, r.id)) return `refused: ${CCraft.craftBlocker(refs, r)}`;
		const left = stale(save);
		return left.length === 0 || `still equipped: ${left.join(", ")}`;
	});
	{
		// ...and the hands: main.client's pack.onCraft puts the blade back and the magazine in its pool
		const onCraft = source("client/main.client.ts");
		const body = onCraft.slice(onCraft.indexOf("pack.onCraft = "), onCraft.indexOf("pack.craftCheck = "));
		check(
			/!ownsWeapon\(ctx\.save, refs\.player\.weapon\.pointer\)\) switchWeapon\(refs, 0\)/.test(body),
			"main.client's pack.onCraft swaps an eaten weapon for the blade",
		);
		checkRows(
			"client: craft, then that swap -- the blade in hand, the eaten gun's magazine back in its pool",
			eating.filter(r => r.ingredients.some(i => i.kind === ItemKind.Weapon)),
			r => {
				const eaten = r.ingredients.find(i => i.kind === ItemKind.Weapon).index;
				const save = stocked(r);
				save.equipWeapon = eaten;
				const refs = craftRefs(save, stationOf(r));
				CCombat.switchWeapon(refs, 0);
				CCombat.switchWeapon(refs, eaten);
				const w = WEAPONS[eaten];
				const field = POOL_FIELD[w.ammoPool];
				const rounds = usesMagazine(w) ? 1 : 0;
				refs.player.weapon.ammoCount = rounds;
				const pool = save[field];
				if (!CCraft.craft(refs, r.id)) return "refused";
				if (!SAVE.ownsWeapon(save, refs.player.weapon.pointer)) CCombat.switchWeapon(refs, 0);
				if (refs.player.weapon.pointer !== 0 || save.equipWeapon !== 0)
					return `in hand ${refs.player.weapon.pointer}`;
				return save[field] === pool + rounds || `${field} ${pool} -> ${save[field]}`;
			},
		);
	}
	checkRows("server craft: the same, in the same step", eating, r => {
		const save = stocked(r);
		wearAll(save, r);
		const world = W.createWorld(4000, 4000);
		const s = stationOf(r);
		if (s !== undefined) station(world, s, 1000, 1000);
		const c = new SCRAFT.ServerCraft({ world, build: { placing: () => false, hold: () => {} } });
		const out = c.craft(0, Ply.createPlayer(save, 1000, 1000), save, r.id);
		if (out.kind === "refused") return JSON.stringify(out);
		const left = stale(save);
		return left.length === 0 || `still equipped: ${left.join(", ")}`;
	});
	{
		// on the server the combat then holds the blade and banks the eaten pistol's rounds (weaponOf)
		const r = CRAFT_RECIPES.find(
			x =>
				x.resultKind === ItemKind.Weapon &&
				x.ingredients.some(i => i.kind === ItemKind.Weapon && i.index === 10),
		);
		const fx = weaponFixture(10, { normal: 30 });
		for (const ing of r.ingredients)
			INV.addItem(fx.save, ing.kind, ing.index, ing.kind === ItemKind.Weapon ? 0 : ing.count);
		fx.step({});
		const mag = fx.sp.state.weapon.ammoCount;
		station(fx.world, stationOf(r), fx.sp.state.x, fx.sp.state.y);
		const out = new SCRAFT.ServerCraft({ world: fx.world, build: { placing: () => false, hold: () => {} } }).craft(
			0,
			fx.sp.state,
			fx.save,
			r.id,
		);
		fx.step({});
		check(
			out.kind === "crafted" && fx.sp.state.weapon.pointer === 0,
			`server: after crafting the ${WEAPONS[r.resultIndex].name} the survivor holds the blade`,
			`pointer ${fx.sp.state.weapon.pointer}`,
		);
		checkEq(fx.save.ammoNormal, 30 + mag, `and the pistol's ${mag} rounds went back to the pool`);
	}
});

section("D7. what each build does once it stands, and whether the content stage (CON-03) is switched on", () => {
	const IQ = require(join(SRC, "shared/sim/interactQuery.ts"));
	const { placedSolid } = require(join(SRC, "shared/sim/placement.ts"));
	const horde = [
		"shared/sim/ai/zombieBrain.ts",
		"server/sim/zombies.ts",
		"server/sim/combat.ts",
		"server/sim/projectiles.ts",
		"server/sim/interaction.ts",
	]
		.map(source)
		.join("\n");
	/** what a standing build of ETC index `id` does in the shipped game, or undefined */
	const does = id => {
		const def = PLACEABLES[id];
		const solid = placedSolid(def, { x: 1000, y: 1000, w: def.w, h: def.h }, 0);
		if (IQ.isLight(solid)) return "E lights it";
		const w = W.createWorld(3000, 3000);
		W.addSolid(w, solid);
		for (const st of ["desk", "pro", "fire"])
			if (SCRAFT.stationNear(w, 1000 + def.w / 2, 1000 + def.h / 2, st) !== undefined) return `a ${st} station`;
		if (["barricade", "door", "iron_barricade", "iron_door"].includes(def.kind)) return "it blocks the way";
		if (new RegExp(`"${def.tag}"`).test(horde)) return "the horde reacts to it";
		return undefined;
	};
	const builds = Object.keys(PLACEABLES).map(Number);
	for (const id of builds) info(`${ETC_ITEMS[id].name}: ${does(id) ?? "nothing"}`);
	const idle = builds.filter(id => does(id) === undefined);
	knownBug(
		"P1",
		idle.length > 0,
		"builds that cost a recipe and do nothing once placed (the turrets fire only in the pre-F2 client path; nothing reads generators, vehicles, the cooker or the signal generator; a lamp drone cannot be switched on)",
		idle.map(id => ETC_ITEMS[id].name).join(", "),
	);
	// CON-03: "Receita e pacote de loja se ligam sozinhos ... e a trava vale no servidor" -- is anything outside Núcleo 1 off?
	const hmg = CRAFT_RECIPES.find(
		r => r.resultKind === ItemKind.Weapon && WEAPONS[r.resultIndex].name === "Heavy machine gun",
	);
	const save = stocked(hmg);
	const onClient = CCraft.craft(craftRefs(save, stationOf(hmg)), hmg.id);
	const world = W.createWorld(4000, 4000);
	station(world, stationOf(hmg), 1000, 1000);
	const save2 = stocked(hmg);
	const onServer =
		new SCRAFT.ServerCraft({ world, build: { placing: () => false } }).craft(
			0,
			Ply.createPlayer(save2, 1000, 1000),
			save2,
			hmg.id,
		).kind === "crafted";
	knownBug(
		"CON-3",
		onClient && onServer,
		"CON-03's content stage is not implemented: nothing outside Núcleo 1 is switched off (a Heavy machine gun crafts on the client and on the server; every pack and recipe is live)",
	);
});

// ================================================================ E. skills

section("E1. learning: a point a level, never past the maximum, on the server and in the Bag", () => {
	checkRows(
		"ids are the row's index, and every skill has a maximum and a kind",
		SKILLS,
		k =>
			(SKILLS[k.id] === k && k.maxLevel >= 1 && [1, 2, 3].includes(k.kind)) || `max ${k.maxLevel} kind ${k.kind}`,
	);
	const craft = new SCRAFT.ServerCraft({ world: W.createWorld(100, 100), build: { placing: () => false } });
	checkRows(
		"server (F3's learnSkill): no point, no skill; each level costs one; the maximum refuses and keeps the point",
		SKILLS,
		k => {
			const s = bareSave();
			s.skillPoint = 0;
			if (craft.learnSkill(s, k.id).kind !== "refused" || s.skillLevels[k.id] !== 0)
				return "learnt with no point";
			s.skillPoint = k.maxLevel + 2;
			for (let lv = 1; lv <= k.maxLevel; lv++) {
				const out = craft.learnSkill(s, k.id);
				if (out.kind !== "learned" || out.level !== lv || s.skillPoint !== k.maxLevel + 2 - lv)
					return `level ${lv}: ${JSON.stringify(out)} sp ${s.skillPoint}`;
			}
			const over = craft.learnSkill(s, k.id);
			return (
				(over.kind === "refused" && s.skillLevels[k.id] === k.maxLevel && s.skillPoint === 2) ||
				`past the max: ${JSON.stringify(over)}`
			);
		},
	);
	checkRows(
		"client (the Bag's Learn, MP_PHASE 2): the same, and its button says Learn / No skill points / Max level",
		SKILLS,
		k => {
			const s = bareSave();
			s.level = 30;
			s.skillPoint = 0;
			const bag = bagFor(s);
			let [m, run] = bag.skillPanel(k);
			if (m.action.text !== "No skill points" || m.action.enabled) return `with no point: "${m.action.text}"`;
			run();
			if (s.skillLevels[k.id] !== 0) return "learnt with no point";
			s.skillPoint = k.maxLevel + 1;
			for (let lv = 1; lv <= k.maxLevel; lv++) {
				[m, run] = bag.skillPanel(k);
				if (m.action.text !== "Learn" || !m.action.enabled) return `level ${lv - 1}: "${m.action.text}"`;
				run();
				if (s.skillLevels[k.id] !== lv || s.skillPoint !== k.maxLevel + 1 - lv)
					return `level ${lv}: ${s.skillLevels[k.id]}, sp ${s.skillPoint}`;
			}
			[m, run] = bag.skillPanel(k);
			run();
			return (
				(m.action.text === "Max level" &&
					!m.action.enabled &&
					s.skillLevels[k.id] === k.maxLevel &&
					s.skillPoint === 1) ||
				`at max: "${m.action.text}", sp ${s.skillPoint}`
			);
		},
	);
	checkRows("the Bag's skill has a glyph and its detail text is in lang.ts", SKILLS, k =>
		inLang(k.name) && inLang(k.detail) ? true : "missing from lang.ts",
	);
});

section("E2. points come from levels: skillPoint = level − 1 − spent (server/sim/progress.ts, save.ts)", () => {
	const PROG = require(join(SRC, "server/sim/progress.ts"));
	{
		const s = bareSave();
		let levels = 0;
		for (let i = 0; i < 40; i++) levels += PROG.awardExp(s, SAVE.expMaxInit(s.level));
		checkEq(s.level, 1 + levels, `the server's XP took the survivor to level ${s.level}`);
		checkEq(s.skillPoint, s.level - 1, "with one skill point per level gained");
	}
	checkRows("after learning, the wallet's rule gives back exactly level − 1 − spent (applyWallet)", SKILLS, k => {
		const s = bareSave();
		s.level = 12;
		s.skillLevels[k.id] = k.maxLevel;
		SAVE.applyWallet(s, { ...SAVE.walletOf(s), level: 12, exp: 0 });
		return s.skillPoint === 12 - 1 - k.maxLevel || `sp ${s.skillPoint}`;
	});
	checkRows(
		"a report cannot learn past the maximum, spend points it has not got, or keep a point it spent",
		SKILLS,
		k => {
			const base = bareSave();
			base.level = 3;
			base.skillPoint = 2;
			const over = SAVE.sanitizeClientReport(
				{ ...base, skillLevels: base.skillLevels.map((v, i) => (i === k.id ? k.maxLevel + 5 : v)) },
				base,
			);
			if (over.skillLevels[k.id] > k.maxLevel) return `level ${over.skillLevels[k.id]} past max ${k.maxLevel}`;
			const spree = SAVE.sanitizeClientReport(
				{ ...base, skillLevels: base.skillLevels.map(() => 1), skillPoint: 99 },
				base,
			);
			const spent = spree.skillLevels.reduce((a, b) => a + b, 0);
			if (spent > base.level - 1) return `spent ${spent} of ${base.level - 1}`;
			const learnt = SAVE.sanitizeClientReport(
				{ ...base, skillLevels: base.skillLevels.map((v, i) => (i === k.id ? 1 : v)), skillPoint: 2 },
				base,
			);
			return learnt.skillPoint === 1 || `learnt one and kept ${learnt.skillPoint} points`;
		},
	);
});

section("E3. every skill's effect, measured where the game applies it", () => {
	const world = W.createWorld(8000, 8000);
	const withSkill = (id, lv) => {
		const s = bareSave();
		s.skillLevels[id] = lv;
		return s;
	};
	const effect = {};
	// 0 Health: +10 max hp a level, on the body the server builds (createPlayer)
	effect[0] = lv =>
		Ply.createPlayer(withSkill(0, lv), 0, 0).hpMax === 100 + 10 * lv ||
		`hpMax ${Ply.createPlayer(withSkill(0, lv), 0, 0).hpMax}`;
	// 1 Recovery: regeneration × (1 + level) (stepPlayer)
	effect[1] = lv => {
		const regen = s => {
			const p = Ply.createPlayer(s, 1000, 1000);
			p.hp = 10;
			for (let i = 0; i < CFG.SIM_HZ; i++) stepPlayer(world, p, s, P.makeCommand(1, 0, 0, 0, 0, 0), TICK_DT);
			return p.hp - 10;
		};
		const a = regen(bareSave());
		const b = regen(withSkill(1, lv));
		return near(b / a, 1 + lv, 0.01) || `${a.toFixed(2)} -> ${b.toFixed(2)} hp/s`;
	};
	/** one blade hit on a zombie through the server's weapon machine: its damage and its knockback */
	const bladeHit = s => {
		const fx = weaponFixture(6, { skills: Object.fromEntries(s.skillLevels.map((v, i) => [i, v])) });
		const z = fx.zombie(1040, 1000);
		for (let i = 0; i < 30 && fx.combat.statsOf(0).melee === 0; i++) fx.step({ held: true, tx: 2000, ty: 1000 });
		return { dmg: 1e9 - z.hp, knock: z.reactionSpeed };
	};
	// 2 Knockback: +3 a level on a blade's push (server melee)
	effect[2] = lv => {
		const a = bladeHit(bareSave()).knock;
		const b = bladeHit(withSkill(2, lv)).knock;
		return near(b - a, Math.min(9, a + 3 * lv) - a, 0.01) || `knock ${a} -> ${b}`;
	};
	// 3 Melee damage: × (1 + level / 4)
	effect[3] = lv => {
		const a = bladeHit(bareSave()).dmg;
		const b = bladeHit(withSkill(3, lv)).dmg;
		return b === Math.floor(a * (1 + lv / 4)) || `${a} -> ${b}`;
	};
	// 4 Quick reload: reload / (1 + level / 4)
	effect[4] = lv => {
		const fx = weaponFixture(10, { mag: 0, skills: { 4: lv } });
		let t = 0;
		while (fx.sp.state.weapon.ammoCount === 0 && t < 600) {
			fx.step({});
			t++;
		}
		return near(t / CFG.SIM_HZ, WEAPONS[10].reload / (1 + lv / 4), 1.01 / CFG.SIM_HZ) || `${(t / 60).toFixed(3)} s`;
	};
	/** mean miss distance of 200 rifle shots at 600 u, with the spread roll on a fixed sequence (no recoil) */
	const scatter = (s, moving) => {
		const values = [0.9, 0.1, 0.7, 0.3, 0.95, 0.05, 0.6, 0.4, 0.99, 0.01, 0.8];
		let r = 0;
		const miss = [];
		const combat = new ServerCombat({
			world,
			targets: { zombies: () => [], bosses: () => [] },
			random: () => values[r++ % values.length],
			hooks: { fx: e => e.t === P.FxType.Shot && miss.push(Math.abs(e.hits[0].y - 4000)) },
		});
		s.invenWeapon[13] = 1;
		s.equipWeapon = 13;
		s.ammoNormal = 1000;
		const sp = PL.createServerPlayer({ slot: 0, userId: 1, name: "p" }, s, 1000, 4000, 0);
		for (let t = 1; t <= 600; t++) {
			// running (if `moving`) along the line of fire: the miss is still the y off the survivor's row
			const cmd = P.makeCommand(t, moving ? 1 : 0, 0, 0, P.HeldBit.Attack, P.packEdges(1, 0, 0, 0));
			stepPlayer(world, sp.state, s, cmd, TICK_DT);
			sp.state.weapon.angleRange = 0;
			combat.stepPlayer(sp, cmd, t, TICK_DT);
		}
		return miss.reduce((a, b) => a + b, 0) / Math.max(1, miss.length);
	};
	// 5 Shooting skill: a narrower spread roll
	effect[5] = lv => scatter(withSkill(5, lv), false) < scatter(bareSave(), false) || "no tighter";
	// 6 Robin Hood: arrows fly at 40 px/frame instead of 25, with half the spread
	effect[6] = lv => {
		const speed = s => {
			const fx = weaponFixture(22, { arrow: 5, skills: { 6: s } });
			fx.run(1.1, { held: true });
			fx.step({ release: 1 });
			return fx.projectiles[0]?.r.speed;
		};
		return near(speed(lv) / speed(0), 40 / 25, 1e-6) || `${speed(0)} -> ${speed(lv)}`;
	};
	// 7 Trot: +0.3 walking speed a level
	effect[7] = lv => {
		const p = Ply.createPlayer(withSkill(7, lv), 0, 0);
		return (
			near(Ply.recalcMoveSpeed(p, withSkill(7, lv)), DESIGN.MOVE_SPEED + 0.3 * lv, 1e-9) ||
			`${Ply.recalcMoveSpeed(p, withSkill(7, lv))}`
		);
	};
	// 8 Patience: hunger drains × (1 − level / 3)
	effect[8] = lv => {
		const drain = s => {
			const p = Ply.createPlayer(s, 1000, 1000);
			for (let i = 0; i < CFG.SIM_HZ * 10; i++) stepPlayer(world, p, s, P.makeCommand(1, 0, 0, 0, 0, 0), TICK_DT);
			return p.hungryMax - p.hungry;
		};
		return (
			near(drain(withSkill(8, lv)) / drain(bareSave()), 1 - lv / 3, 0.001) ||
			`${drain(bareSave()).toFixed(2)} -> ${drain(withSkill(8, lv)).toFixed(2)}`
		);
	};
	// 12 Dwarf: measured in D2 (15 % / 30 % double smelts)
	effect[12] = () => true;
	// 16 Nocturnal: the survivor's own light, 1.5× wider for the horde's visibility (the screen: daynight darkAlpha)
	effect[16] = lv => {
		const Brain = require(join(SRC, "shared/sim/ai/zombieBrain.ts"));
		const lit = s => {
			const w = W.createWorld(8000, 8000);
			const sim = new ServerSimulation({
				world: w,
				clock: new WorldClock({ day: 1, dayTime: 0 }),
				zombies: true,
				interactive: false,
			});
			const sp = PL.createServerPlayer({ slot: 0, userId: 1, name: "p" }, s, 4000, 4000, sim.tick, sim.simHz);
			sim.add(sp);
			for (let i = 0; i < 3; i++) sim.step();
			sp.state.x = 4000;
			sp.state.y = 4000;
			sim.step();
			return Brain.spawnAlpha(sim.horde.refs, sp.state.x + 330, sp.state.y) === 1;
		};
		return (!lit(bareSave()) && lit(withSkill(16, lv))) || "330 u is not lit by the wider light";
	};
	// 17 Repairman: a repair restores half the hp instead of a quarter (server interaction)
	effect[17] = lv => {
		const repaired = s => {
			const w = W.serverWorld(W.createWorld(8000, 8000));
			const sim = new ServerSimulation({
				world: w,
				clock: new WorldClock({ day: 1, dayTime: 12 }),
				zombies: false,
				interactive: true,
			});
			s.invenEtc[23] = 5;
			const sp = PL.createServerPlayer({ slot: 0, userId: 1, name: "p" }, s, 3000, 3000, sim.tick, sim.simHz);
			sim.add(sp);
			sp.state.x = 3000;
			sp.state.y = 3000;
			const b = W.addSolid(w, {
				kind: "barricade",
				x: 2950,
				y: 3025,
				w: 128,
				h: 32,
				hp: 100,
				hpMax: 700,
				destructible: true,
				tags: "barricade",
				placeable: 10,
				owner: 0,
			});
			PL.ingestInput(
				sp,
				P.encodeInput({
					viewTick: 0,
					viewFrac: 0,
					cmds: [P.makeCommand(1, 0, 0, 0, 0, P.packEdges(0, 0, 1, 0))],
				}),
				0,
			);
			sim.step();
			return (b.hp - 100) / b.hpMax;
		};
		const a = repaired(bareSave());
		const b = repaired(withSkill(17, lv));
		return (near(a, 0.25, 1e-9) && near(b, 0.5, 1e-9)) || `${a} -> ${b} of the hp`;
	};
	// 18 Move shooting: running adds no spread
	effect[18] = lv => {
		const runPlain = scatter(bareSave(), true);
		const runSkilled = scatter(withSkill(18, lv), true);
		return runSkilled < runPlain || `running: ${runPlain.toFixed(1)} -> ${runSkilled.toFixed(1)}`;
	};
	// 19 Head shooter: a shot within 2° of the body centre, 10 % of the time, deals +50 %
	effect[19] = lv => {
		const hit = s => {
			const world2 = W.createWorld(4000, 4000);
			const z = createZombie(1, 1200, 1000, 1);
			z.hp = 1e9;
			const combat = new ServerCombat({
				world: world2,
				targets: { zombies: () => [z], bosses: () => [] },
				random: () => 0.05,
			});
			s.invenWeapon[10] = 1;
			s.equipWeapon = 10;
			s.ammoNormal = 10;
			const sp = PL.createServerPlayer({ slot: 0, userId: 1, name: "p" }, s, 1000, 1000, 0);
			const cmd = P.makeCommand(1, 0, 0, 0, P.HeldBit.Attack, P.packEdges(1, 0, 0, 0));
			stepPlayer(world2, sp.state, s, cmd, TICK_DT);
			combat.stepPlayer(sp, cmd, 1, TICK_DT);
			return 1e9 - z.hp;
		};
		const a = hit(bareSave());
		const b = hit(withSkill(19, lv));
		return b === a + Math.floor(a / 2) || `${a} -> ${b}`;
	};
	// 20 Poison immunity: half the poison damage
	effect[20] = lv => {
		// an empty belly on both sides, so no regeneration muddies it: starving costs the same with or without the skill
		const poisoned = (s, poison) => {
			const p = Ply.createPlayer(s, 1000, 1000);
			p.buffs.poison = poison ? 100 : 0;
			const hp = p.hp;
			for (let i = 0; i < CFG.SIM_HZ; i++) {
				p.hungry = 0;
				stepPlayer(world, p, s, P.makeCommand(1, 0, 0, 0, 0, 0), TICK_DT);
			}
			return hp - p.hp;
		};
		const starving = poisoned(bareSave(), false);
		const a = poisoned(bareSave(), true) - starving;
		const b = poisoned(withSkill(20, lv), true) - starving;
		return (a > 0 && near(b, a / 2, 0.01)) || `poison ${a.toFixed(2)} -> ${b.toFixed(2)} hp/s`;
	};
	const measured = SKILLS.filter(k => effect[k.id] !== undefined);
	checkRows("each measurable skill does what it says at every level", measured, k => {
		for (let lv = 1; lv <= k.maxLevel; lv++) {
			const out = effect[k.id](lv);
			if (out !== true) return `level ${lv}: ${out === false ? "no effect" : out}`;
		}
		return true;
	});
	// the rest act inside the horde (server): read, at least, by the code that runs at MP_PHASE 2
	const brain = source("shared/sim/ai/zombieBrain.ts");
	check(
		/skillLevels\[9\]/.test(brain),
		"Pickpocket (9) is read where a zombie's drop is rolled (zombieBrain dropLoot)",
	);
	check(/skillLevels\[15\]/.test(brain), "Cat (15) is read where footsteps make noise (zombieBrain)");
	{
		// who reads each skill id, in the modules the shipped phase runs (the client's non-predicted combat does not)
		const running = [
			"server/sim/combat.ts",
			"server/sim/craft.ts",
			"server/sim/interaction.ts",
			"server/sim/items.ts",
			"shared/sim/playerMove.ts",
			"shared/sim/ai/zombieBrain.ts",
			"shared/game/player.ts",
			"client/systems/craftSystem.ts",
			"client/systems/interaction.ts",
			"client/systems/daynight.ts",
		].map(rel => source(rel));
		const reads = id => running.some(src => new RegExp(`skillLevels\\[${id}\\]|SKILL_[A-Z_]+ = ${id};`).test(src));
		const dead = SKILLS.filter(k => !reads(k.id));
		knownBug(
			"K1",
			dead.length > 0,
			"skills that cost a point and do nothing in the shipped game (read by no running code)",
			dead.map(k => `${k.name} (${k.detail})`).join("; "),
		);
	}
	{
		// Health bought mid-life: the body keeps the max hp it was built with until the next body (death, new life)
		const craft = new SCRAFT.ServerCraft({ world, build: { placing: () => false } });
		const s = bareSave();
		s.level = 5;
		s.skillPoint = 4;
		const p = Ply.createPlayer(s, 1000, 1000);
		craft.learnSkill(s, 0);
		for (let i = 0; i < CFG.SIM_HZ; i++) stepPlayer(world, p, s, P.makeCommand(1, 0, 0, 0, 0, 0), TICK_DT);
		knownBug(
			"K2",
			p.hpMax === 100,
			"Health learnt mid-life gives no max hp until the next body (hpMax is set only by createPlayer)",
			`hpMax ${p.hpMax} after learning Health 1`,
		);
	}
});

// ================================================================ F. loot

section("F1. every building type has a well-formed loot table", () => {
	const types = Object.entries(BuildingType).map(([name, id]) => ({ id, name }));
	checkRows("every building type has a table, and every line of it is a real item", types, t => {
		const table = BUILDING_SPAWNS[t.id];
		if (table === undefined || table.length === 0) return "no table";
		for (const e of table) {
			if (nameOf(e.kind, e.index) === undefined) return `line ${e.kind}:${e.index}`;
			if (e.building !== t.id) return `a line of table ${t.id} says building ${e.building}`;
		}
		return true;
	});
	checkRows("each line is either a chance of one (min = max < 1) or a whole range 1 ≤ min ≤ max", types, t => {
		for (const e of BUILDING_SPAWNS[t.id]) {
			const chanceOfOne = e.max < 1 && e.min === e.max && e.max > 0;
			const range = e.min >= 1 && e.max >= e.min && Number.isInteger(e.min) && Number.isInteger(e.max);
			if (!chanceOfOne && !range) return `${nameOf(e.kind, e.index)} [${e.min}, ${e.max}]`;
		}
		return true;
	});
});

section("F2. EDI-03: what each kind of building holds is what it sold (DESIGN_RULES EDI-03)", () => {
	const name = e => nameOf(e.kind, e.index);
	const is = {
		medicine: e => e.kind === ItemKind.Use && /first aid|pain killer|bandage|adrenaline|sedative/i.test(name(e)),
		food: e => e.kind === ItemKind.Use && !/first aid|pain killer|bandage|adrenaline|sedative/i.test(name(e)),
		ammo: e => e.kind === ItemKind.Etc && e.index >= 44 && e.index <= 47,
		gunpowder: e => e.kind === ItemKind.Etc && /gunpowder/i.test(name(e)),
		oil: e => e.kind === ItemKind.Etc && e.index === 48,
		cloth: e =>
			(e.kind === ItemKind.Etc && /cloth|leather/i.test(name(e))) ||
			(e.kind === ItemKind.Equip && EQUIPS[e.index].kind === EquipSlot.Cloth),
		weapon: e => e.kind === ItemKind.Weapon,
	};
	const need = [
		[BuildingType.Hospital, ["medicine"]],
		[BuildingType.Pharmacy, ["medicine"]],
		[BuildingType.GunShop, ["ammo", "gunpowder"]],
		[BuildingType.Market, ["food"]],
		[BuildingType.SmallMarket, ["food"]],
		[BuildingType.Restaurant, ["food"]],
		[BuildingType.GasStation, ["oil"]],
		[BuildingType.ClothShop, ["cloth"]],
	].map(([id, cats]) => ({ id, cats, name: Object.keys(BuildingType).find(k => BuildingType[k] === id) }));
	checkRows(
		"each shop holds what its sign says (medicine, ammo AND gunpowder, food, oil, cloth)",
		need,
		t =>
			t.cats.every(c => BUILDING_SPAWNS[t.id].some(is[c])) ||
			`missing ${t.cats.filter(c => !BUILDING_SPAWNS[t.id].some(is[c])).join(", ")}`,
	);
	const shops = need.map(t => t.id);
	checkRows(
		"guns and ammunition come only from the gun shop (and zombies), never a pharmacy or a restaurant",
		need.filter(t => t.id !== BuildingType.GunShop),
		t => !BUILDING_SPAWNS[t.id].some(e => is.weapon(e) || is.ammo(e)) || "sells guns or ammo",
	);
	checkRows(
		"a restaurant is all food",
		[{ id: BuildingType.Restaurant, name: "Restaurant" }],
		t => BUILDING_SPAWNS[t.id].every(is.food) || "not only food",
	);
	check(shops.length === 8, "the eight shop types are all checked");
});

section("F3. rolled loot comes from the table, in its ranges, and lands in the backpack (server/sim/items.ts)", () => {
	const { ServerItems } = require(join(SRC, "server/sim/items.ts"));
	const { WorldOut } = require(join(SRC, "server/sim/worldOut.ts"));
	const types = Object.entries(BuildingType).map(([name, id]) => ({ id, name }));
	setSeed(21);
	checkRows(
		"500 rolls per building type: only table lines, counts within [min, max], a chance line gives exactly one",
		types,
		t => {
			const world = W.serverWorld(W.createWorld(4000, 4000));
			const items = new ServerItems({ world, out: new WorldOut() });
			const b = W.addSolid(world, {
				kind: "building",
				x: 1000,
				y: 1000,
				w: 400,
				h: 400,
				hp: 1,
				hpMax: 1,
				destructible: false,
				tags: "house",
				buildingType: t.id,
				passable: true,
				lootSlots: 3,
				lootItems: [],
				lootTimer: 0,
			});
			const table = BUILDING_SPAWNS[t.id];
			let got = 0;
			for (let i = 0; i < 500; i++) {
				items.rollLoot(b);
				for (const d of b.lootItems) {
					const line = table.find(
						e =>
							e.kind === d.kind &&
							e.index === d.id &&
							(e.max < 1 ? d.count === 1 : d.count >= e.min && d.count <= e.max),
					);
					if (line === undefined) return `rolled ${nameOf(d.kind, d.id)} x${d.count}`;
					got++;
				}
			}
			return got > 0 || "500 rolls, nothing";
		},
	);
	checkRows(
		"searching gives the backpack exactly what was rolled, ammo and oil into their own counters",
		types,
		t => {
			const world = W.serverWorld(W.createWorld(4000, 4000));
			const items = new ServerItems({ world, out: new WorldOut() });
			const b = W.addSolid(world, {
				kind: "building",
				x: 1000,
				y: 1000,
				w: 400,
				h: 400,
				hp: 1,
				hpMax: 1,
				destructible: false,
				tags: "house",
				buildingType: t.id,
				passable: true,
				lootSlots: 3,
				lootItems: [],
				lootTimer: 0,
			});
			// every line of the table, once, as if it had been rolled
			b.lootItems = BUILDING_SPAWNS[t.id].map(e => ({ kind: e.kind, id: e.index, count: Math.max(1, e.min) }));
			const save = bareSave();
			const before = b.lootItems.map(d => INV.countItem(save, d.kind, d.id));
			const out = items.search(save, 1200, 1200, 0);
			if (out.taken.length !== b.lootItems.length && b.lootItems.length !== 0) return "not everything was taken";
			const want = new Map();
			for (const d of out.taken) want.set(`${d.kind}:${d.id}`, (want.get(`${d.kind}:${d.id}`) ?? 0) + d.count);
			for (const [key, n] of want) {
				const [k, i] = key.split(":").map(Number);
				const had = before[out.taken.findIndex(d => d.kind === k && d.id === i)];
				if (INV.countItem(save, k, i) - had !== n)
					return `${nameOf(k, i)}: +${INV.countItem(save, k, i) - had}, rolled ${n}`;
			}
			return b.lootItems.length === 0 || "the building still holds it";
		},
	);
	checkRows(
		"a ground item of every kind a table can drop is picked up into the right counter (client pickup, MP_PHASE 2)",
		itemSources().filter(s => s.from === "loot"),
		s => {
			const CInter = require(join(SRC, "client/systems/interaction.ts"));
			const world = W.createWorld(4000, 4000);
			const save = bareSave();
			const player = Ply.createPlayer(save, 1000, 1000);
			W.spawnGroundItem(world, s.kind, s.index, 3, 1010, 1000);
			const had = INV.countItem(save, s.kind, s.index);
			new CInter.Interaction().tryInteract({
				world,
				players: [player],
				player,
				save,
				zombies: [],
				pendingPlace: -1,
				fx: [],
				daynight: { day: 1, dayTime: 12 },
			});
			return (
				(INV.countItem(save, s.kind, s.index) - had === 3 && world.items.length === 0) ||
				`+${INV.countItem(save, s.kind, s.index) - had}`
			);
		},
	);
});

section("F4. trees, cars and bins drop the same things on the client and on the server", () => {
	const tables = rel => {
		const src = source(rel);
		const out = {};
		for (const m of src.matchAll(/const (TREE|CAR|TRASH)_LOOT[^=]*=\s*\[([\s\S]*?)\];/g)) {
			out[m[1]] = [...m[2].matchAll(/kind: (\d), index: (\d+), amount: ([\d.]+)/g)]
				.map(x => `${nameOf(Number(x[1]), Number(x[2]))} ${x[3]}`)
				.sort();
		}
		return out;
	};
	const client = tables("client/systems/interaction.ts");
	const server = tables("server/sim/items.ts");
	const differ = ["TREE", "CAR", "TRASH"].filter(k => JSON.stringify(client[k]) !== JSON.stringify(server[k]));
	check(
		Object.keys(client).length === 3 && Object.keys(server).length === 3,
		"both sides have the three map-item tables",
	);
	// L1 (fixed with NET-6, when the server took the world over): the server rolls the tables the game has always
	// rolled, so switching phases changes nothing a tree, a car or a bin gives
	check(
		differ.length === 0,
		"[L1] the server's tree, car and bin tables are the ones the game has always rolled (the client's)",
		differ.map(k => `${k}: client [${client[k].join(", ")}] vs server [${server[k].join(", ")}]`).join(" | "),
	);
});

// ================================================================ G. the real server: shop, packs, wardrobe, and the MP_PHASE 2 seams

/*
 * Everything above ran the server's MODULES. This part boots the server itself -- server/main.server.ts with its
 * MP host, on test-body's fake Roblox (Players, Heartbeat, remotes, an in-memory DataStore) -- and talks to it only
 * the way a client can: PlayerAdded, the Intent / Input / SaveRequest remotes and the ShopAction RemoteFunction.
 * It installs its own globals over the UI shims, so it runs last.
 */
function fakeRoblox() {
	/** a thread that yields (task.wait, Signal:Wait) is abandoned there: nothing under test needs it resumed */
	class Yield extends Error {}
	function runThread(fn, args) {
		try {
			return fn(...args);
		} catch (e) {
			if (e instanceof Yield) return undefined;
			throw e;
		}
	}

	let clockNow = 1000;
	const timers = [];
	const tickErrors = [];
	globalThis.print = (...a) => {
		if (VERBOSE) console.log("        [print]", ...a);
	};
	globalThis.warn = (...a) => {
		const line = a.join(" ");
		if (line.includes("tick failed")) tickErrors.push(line);
		if (VERBOSE) console.log("        [warn]", line);
	};
	globalThis.os = { clock: () => clockNow, time: () => Math.floor(1_700_000_000 + clockNow) };
	globalThis.task = {
		spawn: (fn, ...args) => runThread(fn, args),
		defer: (fn, ...args) => runThread(fn, args),
		delay: (s, fn, ...args) => timers.push({ at: clockNow + s, fn: () => runThread(fn, args) }),
		wait: () => {
			throw new Yield();
		},
	};
	globalThis.pcall = (fn, ...args) => {
		try {
			return [true, fn(...args)];
		} catch (e) {
			if (e instanceof Yield) throw e;
			return [false, e instanceof Error ? e.message : e];
		}
	};
	globalThis.tostring = v => String(v);
	globalThis.tonumber = v => (Number.isFinite(Number(v)) ? Number(v) : undefined);
	globalThis.$tuple = (...a) => a[0];
	globalThis.utf8 = { len: s => [Array.from(String(s)).length], offset: (s, n) => n };
	globalThis.string = {
		char: (...codes) => String.fromCharCode(...codes),
		match: () => [undefined],
		format: (fmt, ...args) => {
			let i = 0;
			return fmt.replace(/%([-0]*)(\d+)?(?:\.(\d+))?([dsfixq%])/g, (m, flags, width, prec, conv) => {
				if (conv === "%") return "%";
				const v = args[i++];
				let s;
				if (conv === "d" || conv === "i") s = String(Math.trunc(Number(v)));
				else if (conv === "f") s = Number(v).toFixed(prec === undefined ? 6 : Number(prec));
				else if (conv === "x") s = (Number(v) >>> 0).toString(16);
				else s = String(v);
				if (width !== undefined && s.length < Number(width))
					s = s.padStart(Number(width), flags.includes("0") ? "0" : " ");
				return s;
			});
		},
	};
	const enumProxy = new Proxy({}, { get: (_, a) => new Proxy({}, { get: (__, b) => `${String(a)}.${String(b)}` }) });
	globalThis.Enum = enumProxy;

	class Signal {
		constructor() {
			this.handlers = [];
		}
		Connect(fn) {
			const h = { fn, on: true };
			this.handlers.push(h);
			return {
				Connected: true,
				Disconnect: () => {
					h.on = false;
					this.handlers = this.handlers.filter(x => x !== h);
				},
			};
		}
		Fire(...args) {
			for (const h of [...this.handlers]) if (h.on) runThread(h.fn, args);
		}
		/** Roblox guarantees no order between connections: this fires them the other way round */
		FireReversed(...args) {
			for (const h of [...this.handlers].reverse()) if (h.on) runThread(h.fn, args);
		}
		Wait() {
			throw new Yield();
		}
	}

	class Inst {
		constructor(className) {
			this.ClassName = className;
			this.Name = className;
			this._children = [];
			this._parent = undefined;
			this._attrs = new Map();
			// Roblox fires ChildAdded on every parent change; shared/chat/channelWait.ts listens to it (2d622b7)
			this.ChildAdded = new Signal();
			if (className.endsWith("RemoteEvent")) {
				this.OnServerEvent = new Signal();
				this.OnClientEvent = new Signal();
				this.sent = [];
			}
		}
		get Parent() {
			return this._parent;
		}
		set Parent(p) {
			if (this._parent !== undefined) this._parent._children = this._parent._children.filter(c => c !== this);
			this._parent = p;
			if (p !== undefined) {
				p._children.push(this);
				p.ChildAdded.Fire(this);
			}
		}
		FindFirstChild(name) {
			return this._children.find(c => c.Name === name);
		}
		WaitForChild(name) {
			return this.FindFirstChild(name);
		}
		GetChildren() {
			return [...this._children];
		}
		IsA(className) {
			return this.ClassName === className || className === "Instance";
		}
		Destroy() {
			this.Parent = undefined;
		}
		SetAttribute(k, v) {
			this._attrs.set(k, v);
		}
		GetAttribute(k) {
			return this._attrs.get(k);
		}
		FireClient(player, ...args) {
			this.sent.push({ to: player, args });
			if (this.sent.length > 4000) this.sent.splice(0, 2000);
		}
		FireAllClients(...args) {
			this.sent.push({ to: undefined, args });
			if (this.sent.length > 4000) this.sent.splice(0, 2000);
		}
	}
	globalThis.Instance = Inst;

	/** Roblox's DataStores outlive a server: one map per store name for the whole run */
	const stores = new Map();
	const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
	/** every DataStore call that went through, in order: { store, op, key } (the tests read the order of writes) */
	const storeLog = [];
	/** GetDataStore(name) throws this many more times per store name (a store the service cannot open yet) */
	const openFailures = new Map();
	function fakeStore(name) {
		let s = stores.get(name);
		if (s !== undefined) return s;
		const data = new Map();
		s = {
			data,
			/** fault injection: how many of the next calls of each kind throw, as a DataStore outage does */
			fail: { get: 0, update: 0 },
			UpdateAsync(key, transform) {
				if (s.fail.update > 0) {
					s.fail.update -= 1;
					throw new Error(`injected UpdateAsync failure on ${name}`);
				}
				const next = transform(clone(data.get(key)));
				if (next !== undefined) data.set(key, clone(next));
				storeLog.push({ store: name, op: "update", key });
				return [next];
			},
			GetAsync(key) {
				if (s.fail.get > 0) {
					s.fail.get -= 1;
					throw new Error(`injected GetAsync failure on ${name}`);
				}
				storeLog.push({ store: name, op: "get", key });
				return [clone(data.get(key))];
			},
			SetAsync: (key, v) => data.set(key, clone(v)),
		};
		stores.set(name, s);
		return s;
	}

	let guid = 0;
	function makeGame(privateServer) {
		const ReplicatedStorage = new Inst("ReplicatedStorage");
		const Workspace = new Inst("Workspace");
		Workspace.GetServerTimeNow = () => clockNow;
		const Players = {
			list: [],
			PlayerAdded: new Signal(),
			PlayerRemoving: new Signal(),
			MaxPlayers: 6,
			CharacterAutoLoads: true,
			GetPlayers() {
				return [...this.list];
			},
			GetPlayerByUserId(id) {
				return this.list.find(p => p.UserId === id);
			},
		};
		const RunService = {
			Heartbeat: new Signal(),
			IsStudio: () => false,
			IsServer: () => true,
			IsClient: () => false,
		};
		const HttpService = {
			GenerateGUID: () => `guid-${++guid}`,
			JSONEncode: v => JSON.stringify(v),
			JSONDecode: s => JSON.parse(s),
		};
		const DataStoreService = {
			GetDataStore: name => {
				const left = openFailures.get(name) ?? 0;
				if (left > 0) {
					openFailures.set(name, left - 1);
					throw new Error(`injected GetDataStore failure on ${name}`);
				}
				return fakeStore(name);
			},
			GetRequestBudgetForRequestType: () => 100,
		};
		const services = {
			ReplicatedStorage,
			Workspace,
			Players,
			RunService,
			HttpService,
			DataStoreService,
			TextChatService: new Inst("TextChatService"),
			TextService: {},
		};
		const closers = [];
		globalThis.game = {
			GetService(name) {
				const s = services[name];
				if (s === undefined) throw new Error(`the fake Roblox has no ${name}`);
				return s;
			},
			JobId: `job-${++guid}`,
			PrivateServerId: privateServer ? "vip-server" : "",
			PrivateServerOwnerId: privateServer ? 7 : 0,
			PlaceId: 1,
			PlaceVersion: 1,
			BindToClose: fn => closers.push(fn),
		};
		return { services, closers };
	}

	function makePlayer(userId, name) {
		const p = new Inst("Player");
		p.Name = name;
		p.UserId = userId;
		p.DisplayName = name;
		p.kicked = false;
		p.Kick = () => {
			p.kicked = true;
		};
		p.GetNetworkPing = () => 0.05;
		return p;
	}

	// ---------------------------------------------------------------- a server "process"

	/**
	 * Boots server/main.server.ts from scratch: every module under src is loaded again, so a second boot is a second
	 * server process (its own JobId, its own world, its own memory) that shares nothing with the first but the
	 * DataStore — exactly what a server hop is.
	 */
	function bootServer({ privateServer = false } = {}) {
		for (const k of Object.keys(require.cache)) if (k.startsWith(SRC)) delete require.cache[k];
		const env = makeGame(privateServer);
		require(join(SRC, "server/main.server.ts"));
		const host = require(join(SRC, "server/net/mpHost.ts")).activeMpHost();
		if (host === undefined) throw new Error("main.server.ts did not start the MP host (MP_PHASE < 1?)");
		const P = require(join(SRC, "shared/net/protocol.ts"));
		const { SAVE_STORE } = require(join(SRC, "server/save/stores.ts"));
		const { Players, RunService, ReplicatedStorage } = env.services;
		const net = ReplicatedStorage.FindFirstChild("Net");
		const remote = name => {
			const r = net.FindFirstChild(name);
			if (r === undefined) throw new Error(`no remote ${name}`);
			return r;
		};
		const seqs = new Map();
		const server = {
			env,
			host,
			P,
			sim: host.simulation,
			privateServer,
			/** PlayerAdded (the session loads at once: the DataStore is in memory) and the client's LoadRequest */
			join(userId, name = `p${userId}`) {
				const p = makePlayer(userId, name);
				// a connected Player is parented to the Players service; a removed one is not (Roblox sets it to nil)
				p._parent = Players;
				Players.list.push(p);
				Players.PlayerAdded.Fire(p);
				remote("LoadRequest").OnServerEvent.Fire(p);
				return p;
			},
			/** the player leaves the SERVER; `reversed` fires the PlayerRemoving handlers the other way round */
			quit(p, reversed = false) {
				Players.list = Players.list.filter(x => x !== p);
				if (reversed) Players.PlayerRemoving.FireReversed(p);
				else Players.PlayerRemoving.Fire(p);
				p._parent = undefined;
			},
			/** the live session save, as the LoadAck handed it to the client */
			save(p) {
				const acks = remote("LoadAck").sent.filter(e => e.to === p);
				return acks[acks.length - 1]?.args[0]?.save;
			},
			token(p) {
				const acks = remote("LoadAck").sent.filter(e => e.to === p);
				return acks[acks.length - 1]?.args[0]?.token;
			},
			intent(p, kind) {
				remote("Intent").OnServerEvent.Fire(p, P.encodeIntent(kind));
			},
			/** EnterWorld, then long enough for the admit pass (ADMIT_INTERVAL) whatever the cooldown said */
			enter(p) {
				server.intent(p, P.IntentKind.EnterWorld);
				server.run(0.6);
				return server.body(p);
			},
			exit(p) {
				server.intent(p, P.IntentKind.LeaveWorld);
				server.beat();
			},
			/** one Input packet, newest command first with the §2.2 redundancy, walking along `angle` */
			walk(p, angle) {
				const seq = (seqs.get(p) ?? 0) + 1;
				seqs.set(p, seq);
				const cmds = [];
				for (let k = 0; k < 3 && seq - k >= 1; k++)
					cmds.push(P.makeCommand(seq - k, Math.cos(angle), Math.sin(angle), 0, 0, 0));
				remote("Input").OnServerEvent.Fire(p, P.encodeInput({ viewTick: 0, viewFrac: 0, cmds }));
			},
			/** the live session save's client-visible remotes, for a suite that sends its own packets */
			remote,
			shop(p, req) {
				return remote("ShopAction").OnServerInvoke(p, req);
			},
			/** a client progress report (SaveRequest) of the live save with `fields` overridden */
			report(p, fields) {
				const json = JSON.stringify({ ...server.save(p), ...fields });
				remote("SaveRequest").OnServerEvent.Fire(p, server.token(p), json);
				return remote("SaveAck")
					.sent.filter(e => e.to === p)
					.pop()?.args[0];
			},
			body(p) {
				return host.playerOf(p);
			},
			/** the survivor's own view of the life states on the reliable World channel, in order */
			lifeEventsOf(p) {
				const out = [];
				let mySlot = -1;
				for (const e of remote("World").sent) {
					if (e.to !== undefined && e.to !== p) continue;
					const batch = P.decodeWorld(e.args[0]);
					if (batch === undefined) continue;
					for (const ev of batch.events) {
						if (ev.t === P.WorldEv.PlayerJoined && ev.userId === p.UserId) mySlot = ev.slot;
						if (ev.t === P.WorldEv.PlayerLife && ev.slot === mySlot) out.push(ev.state);
					}
				}
				return out;
			},
			clearWorldLog() {
				remote("World").sent.length = 0;
			},
			/** a death through the server's own damage path, then the tick that notices it */
			kill(p) {
				const sp = server.body(p);
				sp.state.godMode = false;
				server.sim.combat.damageActor(sp.slot, sp.state, sp.save, sp.state.hpMax * 10, true);
				server.beat();
				server.beat();
				return sp;
			},
			/** the stored document, as the next session anywhere would load it */
			stored(userId) {
				const doc = fakeStore(SAVE_STORE).data.get(String(userId));
				if (doc === undefined) return undefined;
				return typeof doc.data === "string" ? JSON.parse(doc.data) : doc.data;
			},
			storeDoc(userId, edit) {
				const store = fakeStore(SAVE_STORE);
				const doc = store.data.get(String(userId));
				const data = JSON.parse(doc.data);
				edit(data);
				doc.data = JSON.stringify(data);
				store.data.set(String(userId), doc);
			},
			/** keep these survivors out of the horde's teeth, so the only deaths are the scripted ones */
			immortal: new Set(),
			beat(dt = 1 / 60) {
				clockNow += dt;
				for (let i = timers.length - 1; i >= 0; i--) {
					if (timers[i].at <= clockNow) {
						const t = timers.splice(i, 1)[0];
						t.fn();
					}
				}
				for (const p of server.immortal) {
					const sp = host.playerOf(p);
					if (sp !== undefined && !sp.state.dead) {
						sp.state.godMode = true;
						sp.state.hungry = Math.max(sp.state.hungry, 1);
					}
				}
				RunService.Heartbeat.Fire(dt);
				if (tickErrors.length > 0)
					throw new Error(`the simulation tick failed: ${tickErrors.splice(0).join(" | ")}`);
			},
			run(seconds, dt = 1 / 60) {
				const n = Math.round(seconds / dt);
				for (let i = 0; i < n; i++) server.beat(dt);
			},
			/** real seconds until `pred` holds, or -1 when it did not within `limit` */
			runUntil(pred, limit, dt = 1 / 60) {
				let t = 0;
				while (t < limit) {
					if (pred()) return t;
					server.beat(dt);
					t += dt;
				}
				return pred() ? t : -1;
			},
			/** the world clock `seconds` of real time before daybreak (night runs at 1.2× TIME_SPEED) */
			nightLeft(seconds) {
				const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
				const hours = seconds * DESIGN.TIME_SPEED * 1.2;
				server.sim.clock.setClock(6 - hours);
			},
			shutdown() {
				for (const fn of env.closers) runThread(fn, []);
			},
			/** every `onWorldWiped` report, through the keeper's own hook (chained, the host still logs) */
			wipes() {
				const lives = host.lives;
				if (lives.__wipes === undefined) {
					lives.__wipes = [];
					const prev = lives.onWorldWiped;
					lives.onWorldWiped = r => {
						lives.__wipes.push(r);
						prev?.(r);
					};
				}
				return lives.__wipes;
			},
		};
		return server;
	}

	return { bootServer };
}

const Roblox = fakeRoblox();
let nextUser = 7000;
const newUser = () => ++nextUser;
/** what client/main.client.ts deliverPacks does to the client's copy: every pending pack's items, × how many */
function deliverPacksLikeTheClient(save, addItem) {
	for (const p of SHOP_PACKS) {
		const n = Math.max(0, (save.packsBought[p.id] ?? 0) - (save.packsOpened[p.id] ?? 0));
		if (n <= 0) continue;
		for (const item of p.items) if (item.index >= 0) addItem(save, item.kind, item.index, item.count * n);
		save.packsOpened[p.id] = save.packsBought[p.id];
	}
}
/** the backpack fields a client report carries, from the client's own copy */
const reportOf = c => ({
	invenWeapon: c.invenWeapon,
	invenEquip: c.invenEquip,
	invenUse: c.invenUse,
	invenEtc: c.invenEtc,
	ammoNormal: c.ammoNormal,
	ammoShotgun: c.ammoShotgun,
	ammoMachinegun: c.ammoMachinegun,
	ammoArrow: c.ammoArrow,
	oil: c.oil,
	electric: c.electric,
	packsOpened: c.packsOpened,
	equipWeapon: c.equipWeapon,
	equipCloth: c.equipCloth,
	equipHand: c.equipHand,
	equipGun: c.equipGun,
	equipOutfit: c.equipOutfit,
	equipPet: c.equipPet,
	skillLevels: c.skillLevels,
});
const clone = v => JSON.parse(JSON.stringify(v));

section("G1. every pack: its declared contents, its price charged by the server, delivered exactly (MON-03)", () => {
	checkRows("the contents line a player reads names exactly the items the pack delivers", SHOP_PACKS, p => {
		const lines = p.contents.split("#").map(l => {
			const m = /^(.*) X (\d+)$/.exec(l.trim());
			return m && { name: m[1], count: Number(m[2]) };
		});
		if (lines.some(l => l === null) || lines.length !== p.items.length)
			return `"${p.contents}" vs ${p.items.length} item(s)`;
		for (let i = 0; i < p.items.length; i++) {
			const it = p.items[i];
			const real = nameOf(it.kind, it.index);
			if (it.index < 0 || real === undefined) return `item ${i} does not resolve`;
			if (lines[i].count !== it.count || !(lines[i].name === real || lines[i].name.startsWith(`${real} the `)))
				return `"${lines[i].name} X ${lines[i].count}" vs ${real} x${it.count}`;
		}
		return true;
	});
	checkRows("MON-03 / MON-01: a pack is fixed, and sells no weapon or ammunition", SHOP_PACKS, p =>
		p.items.every(it => it.count > 0) &&
		!p.items.some(it => it.kind === ItemKind.Etc && it.index >= 44 && it.index <= 48)
			? true
			: "sells ammunition",
	);
	const s = Roblox.bootServer();
	const INV2 = require(join(SRC, "shared/sim/inventory.ts"));
	const SHOP2 = require(join(SRC, "shared/data/shop.ts"));
	checkRows(
		"bought through ShopAction: exactly its price, one more bought, refused when short or at the pending cap",
		SHOP_PACKS,
		p => {
			const pl = s.join(newUser(), `pack${p.id}`);
			const save = s.save(pl);
			save.money = p.price + 7;
			const ok = s.shop(pl, { kind: "buyPack", packId: p.id, price: 0 });
			if (!ok.ok || ok.price !== p.price)
				return `buy: ${JSON.stringify({ ok: ok.ok, price: ok.price, reason: ok.reason })}`;
			if (save.money !== 7 || save.packsBought[p.id] !== 1)
				return `money ${save.money}, bought ${save.packsBought[p.id]}`;
			s.run(0.6);
			const poor = s.shop(pl, { kind: "buyPack", packId: p.id });
			if (poor.ok || poor.reason !== "funds" || save.money !== 7 || save.packsBought[p.id] !== 1)
				return `short: ${poor.reason}`;
			s.run(0.6);
			save.money = 10000;
			save.packsBought[p.id] = SHOP2.ECONOMY.MAX_PENDING_PACKS;
			const capped = s.shop(pl, { kind: "buyPack", packId: p.id });
			if (capped.ok || capped.reason !== "limit" || save.money !== 10000) return `pending cap: ${capped.reason}`;
			save.packsBought[p.id] = 1;
			s.run(0.6);
			// the client delivers it at the next run's start and reports: the server takes exactly the pack's items
			const client = clone(save);
			deliverPacksLikeTheClient(client, INV2.addItem);
			const before = p.items.map(it => INV2.countItem(save, it.kind, it.index));
			const ack = s.report(pl, reportOf(client));
			if (ack?.ok !== true) return `report ${JSON.stringify(ack)}`;
			for (let i = 0; i < p.items.length; i++) {
				const it = p.items[i];
				if (INV2.countItem(save, it.kind, it.index) !== before[i] + it.count)
					return `${nameOf(it.kind, it.index)}: ${before[i]} -> ${INV2.countItem(save, it.kind, it.index)}`;
			}
			s.quit(pl);
			return save.packsOpened[p.id] === 1 || `opened ${save.packsOpened[p.id]}`;
		},
	);
	checkRows(
		"a report cannot open a pack it did not buy, nor take a pack pet twice",
		SHOP_PACKS.filter(p => p.items.some(it => it.kind === ItemKind.Equip && COSMETIC(EQUIPS[it.index]))),
		p => {
			const pl = s.join(newUser(), `cheat${p.id}`);
			const save = s.save(pl);
			const pet = p.items.find(it => it.kind === ItemKind.Equip).index;
			const client = clone(save);
			client.packsOpened[p.id] = 3;
			client.invenEquip[pet] = 3;
			s.report(pl, reportOf(client));
			const unbought = save.invenEquip[pet];
			s.quit(pl);
			return (
				(unbought === 0 && save.packsOpened[p.id] === 0) ||
				`unbought: ${nameOf(ItemKind.Equip, pet)} x${unbought}, opened ${save.packsOpened[p.id]}`
			);
		},
	);
});

section("G2. a pack pet stays through death and Rebirth, and goes with a New game; a bought one stays (MON-04)", () => {
	const s = Roblox.bootServer();
	const INV2 = require(join(SRC, "shared/sim/inventory.ts"));
	const SAVE2 = require(join(SRC, "shared/game/save.ts"));
	const pack = SHOP_PACKS.find(p => p.items.some(it => it.kind === ItemKind.Equip && COSMETIC(EQUIPS[it.index])));
	const pet = pack.items.find(it => it.kind === ItemKind.Equip).index;
	const pl = s.join(newUser(), "petowner");
	s.immortal.add(pl);
	const save = s.save(pl);
	save.money = 1000;
	check(s.shop(pl, { kind: "buyPack", packId: pack.id }).ok, `the ${pack.name} is bought`);
	const client = clone(save);
	deliverPacksLikeTheClient(client, INV2.addItem);
	client.equipPet = pet;
	s.report(pl, reportOf(client));
	check(
		save.invenEquip[pet] === 1 && save.equipPet === pet,
		`delivered and worn: the server says ${EQUIPS[pet].name} is theirs and on`,
	);
	check(SAVE2.petLookOf(save) !== 0, "and it is what goes on the wire (petLookOf)");
	s.enter(pl);
	s.immortal.delete(pl);
	s.kill(pl);
	s.run(0.6);
	const reborn = s.shop(pl, { kind: "rebirth", runRev: save.runRev });
	s.run(0.6);
	check(reborn.ok === true, "a Rebirth is bought", reborn.reason);
	check(
		save.invenEquip[pet] === 1 && save.equipPet === pet,
		"the pack pet is still theirs and on after a death and a Rebirth",
	);
	s.kill(pl);
	s.run(0.6);
	const fresh = s.shop(pl, { kind: "newRun", runRev: save.runRev });
	check(fresh.ok === true, "a New game is started", fresh.reason);
	check(
		save.invenEquip[pet] === 0 && save.equipPet === -1,
		'a New game takes the pack pet away ("it stays until a New game")',
		`owned ${save.invenEquip[pet]}, worn ${save.equipPet}`,
	);
	// a pet bought as a costume is forever
	const bought = COSTUMES.find(c => c.equipId !== pet && COS.cosmeticSlotOf(c.equipId) === EquipSlot.Pet);
	s.run(0.6);
	check(s.shop(pl, { kind: "buyCostume", costumeId: bought.id }).ok, `the ${bought.name} costume is bought`);
	save.equipPet = bought.equipId;
	s.kill(pl);
	s.run(0.6);
	s.shop(pl, { kind: "newRun", runRev: save.runRev });
	check(
		save.costumes[bought.id] === 1 && save.equipPet === bought.equipId,
		"a costume pet survives a New game, still worn",
	);
});

section("G3. every costume: sold at the catalogue's price, once, and wearable (MON-04)", () => {
	const s = Roblox.bootServer();
	const pl = s.join(newUser(), "wardrobe");
	const save = s.save(pl);
	checkRows("ShopAction buyCostume charges exactly the price, marks it owned, refuses a second one", COSTUMES, c => {
		s.run(0.6);
		save.money = c.price + 3;
		const ok = s.shop(pl, { kind: "buyCostume", costumeId: c.id, price: 1 });
		if (!ok.ok || ok.price !== c.price || save.money !== 3 || save.costumes[c.id] !== 1)
			return `${JSON.stringify({ ok: ok.ok, price: ok.price })}, money ${save.money}`;
		s.run(0.6);
		const again = s.shop(pl, { kind: "buyCostume", costumeId: c.id });
		return (again.ok === false && again.reason === "owned" && save.money === 3) || `second: ${again.reason}`;
	});
	const outfit = COSTUMES.find(c => COS.cosmeticSlotOf(c.equipId) === EquipSlot.Outfit);
	const pet = COSTUMES.find(c => COS.cosmeticSlotOf(c.equipId) === EquipSlot.Pet);
	const client = clone(save);
	client.equipOutfit = outfit.equipId;
	client.equipPet = pet.equipId;
	s.report(pl, reportOf(client));
	check(
		save.equipOutfit === outfit.equipId && save.equipPet === pet.equipId,
		`wearing the bought ${outfit.name} and ${pet.name} is accepted from the report`,
	);
});

section("G4. the MP_PHASE 2 seams: what the server owns now, and what still only reaches it in a report", () => {
	const s = Roblox.bootServer();
	const P2 = s.P;
	const SIM2 = require(join(SRC, "server/sim/simulation.ts"));
	const Ply2 = require(join(SRC, "shared/game/player.ts"));
	const INV2 = require(join(SRC, "shared/sim/inventory.ts"));
	const CFG2 = require(join(SRC, "shared/net/mpConfig.ts"));
	let seq = 0;
	/** one Input command from `pl`: nothing else of a key press or a Bag click can travel (§2.2) */
	const press = (pl, held, edges) => {
		seq += 1;
		const cmds = [];
		for (let k = 0; k < 3 && seq - k >= 1; k++) cmds.push(P2.makeCommand(seq - k, 0, 0, 0, held, edges));
		s.env.services.ReplicatedStorage.FindFirstChild("Net")
			.FindFirstChild("Input")
			.OnServerEvent.Fire(pl, P2.encodeInput({ viewTick: 0, viewFrac: 0, cmds }));
	};
	const clientSrc = [
		"client/main.client.ts",
		"client/net/netClient.ts",
		"client/ui/backpack.ts",
		"client/systems/combat.ts",
	]
		.map(source)
		.join("\n");
	const intentArgsSent = /encodeIntentArgs\(/.test(clientSrc);
	const autosave = Number(/const AUTOSAVE_SEC = (\d+)/.exec(source("client/main.client.ts"))?.[1]);
	info(
		`MP_PHASE ${CFG2.MP_PHASE}; WORLD_SERVER_PHASE ${SIM2.WORLD_SERVER_PHASE}; client autosave every ${autosave} s`,
	);
	check(
		CFG2.MP_PHASE === 2 && SIM2.WORLD_SERVER_PHASE === 3,
		"the shipped phase: the server owns the body and the combat, not yet the backpack",
	);

	{
		// NET-1: keys 1-5 / the Bag's Equip change the CLIENT's save; the server's weapon machine reads its own
		const pl = s.join(newUser(), "switcher");
		s.immortal.add(pl);
		const save = s.save(pl);
		save.invenWeapon[10] = 1;
		save.ammoNormal = 30;
		save.equipWeapon = 0;
		const sp = s.enter(pl);
		const client = clone(save);
		client.equipWeapon = 10; // what switchWeapon writes on the client when key 2 is pressed
		for (let i = 0; i < 120; i++) {
			press(pl, P2.HeldBit.Attack, P2.packEdges(1, 0, 0, 0));
			s.beat();
		}
		const held = sp.state.weapon.pointer;
		const shots = s.sim.combat.statsOf(sp.slot).shots;
		knownBug(
			"NET-1",
			held === 0 && shots === 0 && !intentArgsSent,
			`a weapon switch (keys 1–5, the hotbar, the Bag) never reaches the server: 2 s after pressing 2 for the pistol the server still swings the ${WEAPONS[held]?.name}, until the next save report (autosave ${autosave} s)`,
			`server holds ${WEAPONS[held]?.name}, ${shots} shot(s) fired`,
		);
		s.report(pl, reportOf(client));
		s.beat();
		check(sp.state.weapon.pointer === 10, "the report is the only road: after it the server holds the pistol");
		s.quit(pl);
	}
	{
		// NET-2: the Bag's Use / Eat runs itemUseEffect on the client's copy of the body; the server owns hp and hunger
		const pl = s.join(newUser(), "eater");
		s.immortal.add(pl);
		const save = s.save(pl);
		const BANDAGE = USABLES.find(u => u.name === "Bandage").id;
		const CAN = USABLES.find(u => u.name === "Canned food").id;
		const sp = s.enter(pl);
		s.immortal.delete(pl);
		sp.state.godMode = false;
		sp.state.hp = 40;
		sp.state.hungry = 30;
		const client = clone(save);
		const body = Ply2.createPlayer(client, 0, 0);
		body.hp = 40;
		body.hungry = 30;
		const ateB = Ply2.itemUseEffect(body, client, BANDAGE);
		const ateC = Ply2.itemUseEffect(body, client, CAN);
		s.report(pl, reportOf(client));
		s.run(0.5);
		knownBug(
			"NET-2",
			ateB &&
				ateC &&
				save.invenUse[BANDAGE] === client.invenUse[BANDAGE] &&
				sp.state.hp < 55 &&
				sp.state.hungry < 50,
			"eating and using items does nothing: the effect lands on the client's copy of the body (overwritten by the next snapshot), the server's hp and hunger never move, and the report then takes the item away",
			`client ${body.hp.toFixed(0)} hp / ${body.hungry.toFixed(0)} food; server ${sp.state.hp.toFixed(0)} hp / ${sp.state.hungry.toFixed(0)} food; bandages left on the server ${save.invenUse[BANDAGE]}`,
		);
		s.quit(pl);
	}
	{
		// NET-3: the server spends the reserve on its reloads; the client's predicted reload never does, and its report
		// carries the unspent number back
		const pl = s.join(newUser(), "shooter");
		s.immortal.add(pl);
		const save = s.save(pl);
		save.invenWeapon[10] = 1;
		save.equipWeapon = 10;
		save.ammoNormal = 40;
		const sp = s.enter(pl);
		// the client's own copy, through the client's real predicted weapon machine: fire and reload for 10 s
		const client = clone(save);
		const clientStart = client.ammoNormal;
		const cRefs = {
			world: W.createWorld(4000, 4000),
			players: [],
			player: Ply.createPlayer(client, 1000, 1000),
			save: client,
			input: new InputState(),
			zombies: [],
			bosses: [],
			bullets: [],
			pendingPlace: -1,
			fx: [],
			onMessage: () => {},
			onExp: () => {},
		};
		cRefs.players.push(cRefs.player);
		const cCombat = new CCombat.Combat();
		for (let i = 0; i < 600; i++) {
			cRefs.input.attackHeld = true;
			cRefs.input.attackPressed = true;
			cCombat.update(cRefs, 1 / 60);
		}
		for (let i = 0; i < 600; i++) {
			press(pl, P2.HeldBit.Attack, P2.packEdges(1, 0, 0, 0));
			s.beat();
		}
		const fired = s.sim.combat.statsOf(sp.slot).shots;
		const serverLeft = save.ammoNormal;
		s.report(pl, reportOf(client));
		knownBug(
			"NET-3",
			fired > 10 &&
				client.ammoNormal === clientStart &&
				serverLeft < clientStart &&
				save.ammoNormal === clientStart,
			"ammunition refills itself: the client's predicted reloads never spend its copy of the reserve (the HUD's reserve never drops), and each report writes that unspent number over the server's",
			`server fired ${fired}, its reserve ${serverLeft} -> ${save.ammoNormal} after the report; client reserve ${client.ammoNormal}`,
		);
		s.quit(pl);
	}
	{
		// NET-4: armour and skills too -- chosen in the Bag, they reach the server's damage and movement at the report
		const pl = s.join(newUser(), "armoured");
		s.immortal.add(pl);
		const save = s.save(pl);
		const STEEL = EQUIPS.find(e => e.name === "Steel armor").id;
		save.invenEquip[STEEL] = 1;
		save.level = 4;
		save.skillPoint = 3;
		s.enter(pl);
		const client = clone(save);
		client.equipCloth = STEEL; // the Bag's Equip
		client.skillLevels[7] = 1; // the Bag's Learn: Trot
		client.skillPoint = 2;
		s.run(1);
		const defBefore = Ply2.playerEquipDefence(save);
		const trotBefore = save.skillLevels[7];
		s.report(pl, reportOf(client));
		knownBug(
			"NET-4",
			defBefore === 0 &&
				trotBefore === 0 &&
				Ply2.playerEquipDefence(save) === EQUIPS[STEEL].def &&
				save.skillLevels[7] === 1,
			`armour, gadgets and skills chosen in the Bag reach the server's damage and speed only with the next report (autosave ${autosave} s): until then the Steel armor protects nothing and Trot adds nothing`,
			`defence ${defBefore} -> ${Ply2.playerEquipDefence(save)}, Trot ${trotBefore} -> ${save.skillLevels[7]} at the report`,
		);
		s.quit(pl);
	}
	{
		// NET-5: the report is also a way to write any backpack at all (F3 takes the inventory away from it)
		const pl = s.join(newUser(), "forger");
		s.immortal.add(pl);
		const save = s.save(pl);
		const sp = s.enter(pl);
		const HMG = WEAPONS.find(w => w.name === "Heavy machine gun").id;
		const client = clone(save);
		client.invenWeapon[HMG] = 1;
		client.equipWeapon = HMG;
		client.ammoMachinegun = 99999;
		client.invenEtc[29] = 999;
		s.report(pl, reportOf(client));
		s.beat();
		knownBug(
			"NET-5",
			save.invenWeapon[HMG] === 1 && save.ammoMachinegun === 99999 && sp.state.weapon.pointer === HMG,
			"a save report can write any weapon, ammunition or material into the backpack, and the server's combat then fires it (only cosmetics, coins and progress are guarded)",
			`after one forged report: ${WEAPONS[HMG].name} in hand, ${save.ammoMachinegun} MG rounds, ${save.invenEtc[29]} blueprints`,
		);
		s.quit(pl);
	}
	{
		// NET-6: what the survivor builds at MP_PHASE 2 lives only in the builder's client
		const build = source("client/systems/build.ts");
		const local = /addSolid\(refs\.world/.test(build) && !/FireServer|sendIntent|net\./.test(build);
		knownBug(
			"NET-6",
			s.sim.build === undefined && local,
			"a barricade, door, campfire or desk built at MP_PHASE 2 exists only in the builder's client: the server's zombies walk through it and the other players never see it",
			`server build system: ${s.sim.build === undefined ? "off" : "on"}`,
		);
	}
});

// ---------------------------------------------------------------- verdict

console.log("");
if (bugs.length > 0) console.log(`${bugs.length} known bug(s) reproduced (reported, not failing): ${bugs.join(", ")}`);
if (failures > 0) {
	console.log(`${failures} of ${checks} check(s) FAILED`);
	process.exit(1);
}
console.log(`${checks} checks, 0 failures`);
