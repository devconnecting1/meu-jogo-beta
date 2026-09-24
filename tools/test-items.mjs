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
 *                  price and the server delivers what it declares (MON-03); a pack pet stays until a New game; a
 *                  report cannot conjure a pet; every costume is sold at the catalogue's price and worn through the
 *                  wardrobe's Equip verb. And the seams of MP_PHASE 2, closed by F3 (docs/MULTIPLAYER.md §4.8): the
 *                  backpack and the constructions are the server's, a verb lands in the tick of the command it was
 *                  made during, and a report can no longer write any of it (NET-1..6); the client's prediction and
 *                  the server's bag laid over it (G5).
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
const VEH = require(join(SRC, "shared/sim/vehicle.ts"));

const TICK_DT = 1 / CFG.SIM_HZ;

/**
 * VEI-05: a vehicle kit `id` parked by the SERVER's world, a survivor with `oil` pressing E beside it and then holding
 * the stick east for `seconds` (two by default), every command through the real wire. What happened: mounted, and how
 * far they went (the world's edge stops a long ride; the throttle stays open against it).
 */
function rideOnServer(id, oil = 20, seconds = 2) {
	const world = W.serverWorld(W.createWorld(8000, 4000));
	const sim = new ServerSimulation({
		world,
		clock: new WorldClock({ day: 1, dayTime: 12 }),
		zombies: false,
		interactive: true,
	});
	const save = SAVE.defaultSave();
	save.oil = oil;
	const sp = PL.createServerPlayer({ slot: 0, userId: 1, name: "rider" }, save, 1000, 2000, sim.tick, sim.simHz);
	sim.add(sp);
	sp.state.x = 1000;
	sp.state.y = 2000;
	const vdef = VEH.vehicleDef(VEH.vehicleKindOfItem(id));
	const r = VEH.parkedRect(vdef, 1000, 2040, 0);
	W.addSolid(world, { ...placedSolidOf(PLACEABLES[id], r, 0), placeable: id, owner: 0 });
	let seq = 1;
	const tick = (mx, edges) => {
		const cmd = P.makeCommand(seq++, mx, 0, 0, 0, edges);
		PL.ingestInput(sp, P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [cmd] }), sim.tick / 60);
		sim.step();
	};
	tick(0, P.packEdges(0, 0, 1, 0));
	const mounted = sim.vehicles.riding(0);
	const x0 = sp.state.x;
	for (let i = 0; i < seconds * CFG.SIM_HZ; i++) tick(1, 0);
	return { mounted, ran: sp.state.x - x0, oilLeft: save.oil, def: vdef, stillRiding: sim.vehicles.riding(0) };
}
const placedSolidOf = (def, r, rot) => require(join(SRC, "shared/sim/placement.ts")).placedSolid(def, r, rot);
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
 * Everything the game can put in a backpack, as (kind, index): every building's loot, the trees, cars and bins (the
 * one shared table, QA L1), a boss's trophy, a zombie's own drop (rotten meat, leather), every recipe's result, every
 * pack's content and every costume.
 */
function itemSources() {
	const { MAP_ITEM_LOOT, BOSS_TROPHIES } = require(join(SRC, "shared/data/spawns.ts"));
	const out = [];
	for (const table of BUILDING_SPAWNS)
		for (const e of table) out.push({ kind: e.kind, index: e.index, from: "loot" });
	for (const r of CRAFT_RECIPES) out.push({ kind: r.resultKind, index: r.resultIndex, from: `recipe ${r.id}` });
	for (const p of SHOP_PACKS) for (const it of p.items) out.push({ kind: it.kind, index: it.index, from: p.name });
	for (const [what, table] of Object.entries(MAP_ITEM_LOOT))
		for (const e of table) out.push({ kind: e.kind, index: e.index, from: what });
	for (const [boss, list] of Object.entries(BOSS_TROPHIES))
		for (const t of list) out.push({ kind: t.kind, index: t.index, from: `boss ${boss}` });
	// a zombie's own table (shared/sim/ai/zombieBrain.ts dropLoot): rotten meat or leather
	const brain = source("shared/sim/ai/zombieBrain.ts");
	for (const m of brain.matchAll(/spawnGroundItem\(w, (\d), (\d+), 1, z\.x, z\.y/g))
		out.push({ kind: Number(m[1]), index: Number(m[2]), from: "zombie" });
	for (const c of COSTUMES) out.push({ kind: ItemKind.Equip, index: c.equipId, from: `costume ${c.name}` });
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
	// the stun gun's charge has no item: it is poured in at a battery box with E (server/sim/power.ts, ELE-07)
	{
		const { ServerPower } = require(join(SRC, "server/sim/power.ts"));
		const w = W.serverWorld(W.createWorld(2000, 2000));
		const save = bareSave();
		save.invenWeapon[STUN_GUN] = 1;
		const body = Ply.createPlayer(save, 1000, 1060);
		const power = new ServerPower({ world: w, clock: { dayTime: 12, isRaining: false, darkAlpha: 0 } });
		const box = W.addSolid(w, {
			kind: "structure",
			x: 1000,
			y: 1000,
			w: 40,
			h: 40,
			hp: 300,
			hpMax: 300,
			destructible: true,
			tags: "battery",
			placeable: 6,
		});
		power.note(box, true);
		const out = power.act(0, body, save, box);
		if (save.electric > 0) raised.add("electric");
		check(
			out?.kind === "charged" && save.electric === 100,
			"a battery box charges the stun gun with E: 100 a press (ELE-07; was W2)",
			JSON.stringify(out?.kind),
		);
	}
	const fed = GUNS.concat([WEAPONS[CHAINSAW]]);
	checkRows(
		"every gun has a source for its feed (ammo and oil in loot, the stun gun's charge at a battery box)",
		fed,
		w => raised.has(fuelField(w)) || `nothing in play gives ${fuelField(w)}`,
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
			check(litAt(NIGHT_VISION, 0, 400), "night vision: the horde is made out 400 u all round (E2)");
			check(!litAt(NIGHT_VISION, 0, 440), "and not past its 420 u");

			// ---- E1 (fixed 2026-09-23): the SCREEN lights exactly what the server lights. The client's light map
			// and the horde's visibility read ONE rule (shared/sim/survivorLight.ts) and ONE table (EQUIP_LIGHTS)
			const Light = require(join(SRC, "shared/sim/survivorLight.ts"));
			const { LightMap } = require(join(SRC, "shared/engine/renderer.ts"));
			const { Camera } = require(join(SRC, "shared/engine/camera.ts"));
			const { COLORS } = require(join(SRC, "shared/engine/colors.ts"));
			const draw = source("client/gameLoop.ts");
			const body = draw.slice(draw.indexOf("private drawLight("), draw.indexOf("hideWorld(): void"));
			const shape = source("client/view/lightList.ts");
			check(
				/SurvivorLight\.survivorLightRadius\(save\)/.test(body) &&
					/SurvivorLight\.survivorCone\(save\)/.test(body) &&
					/addSurvivorLight\(lights, p\.x, p\.y, p\.angle, radius, cone\?\.radius\)/.test(body) &&
					/lights\.cone\(x, y, cone, FLASHLIGHT_INNER, aim, SurvivorLight\.CONE_HALF_ANGLE\)/.test(shape) &&
					!/PLAYER_LIGHT_R/.test(draw),
				"the client's light map draws the survivor's light by the shared rule: the circle, and the flashlight's cone along the aim",
			);
			const LL = require(join(SRC, "client/view/lightList.ts"));
			check(
				/Light\.survivorLightRadius\(save\)/.test(source("shared/sim/ai/zombieBrain.ts")) &&
					/Light\.survivorCone\(save\)/.test(source("shared/sim/ai/zombieBrain.ts")) &&
					/> Light\.CONE_HALF_ANGLE/.test(source("shared/sim/ai/zombieBrain.ts")),
				"and the server's horde visibility by the same rule, cone angle included",
			);
			/** the lights the client draws for a survivor at (px, py) aiming at `aim` (gameLoop drawLight, the real shape) */
			const clientLights = (save, px, py, aim) => {
				const list = new LL.LightList();
				LL.addSurvivorLight(
					list,
					px,
					py,
					aim,
					Light.survivorLightRadius(save),
					Light.survivorCone(save)?.radius,
				);
				return list.items;
			};
			const hands = [
				["bare hands", -1, -1, 0],
				["the flashlight", FLASHLIGHT, -1, 0],
				["the torchlight", TORCH, -1, 0],
				["night vision", -1, NIGHT_VISION, 0],
				["Nocturnal", -1, -1, 1],
				["the flashlight and night vision", FLASHLIGHT, NIGHT_VISION, 0],
			];
			const wearing = (hand, gun, nocturnal) => {
				const save = bareSave();
				save.equipHand = hand;
				save.equipGun = gun;
				if (hand >= 0) save.invenEquip[hand] = 1;
				if (gun >= 0) save.invenEquip[gun] = 1;
				save.skillLevels[16] = nocturnal;
				return save;
			};
			// the server's own isLit, for a survivor at (4000, 4000) aiming at `aim`, sampled at world points
			const serverLit = (save, aim) => {
				const world = W.createWorld(8000, 8000);
				const sim = new ServerSimulation({
					world,
					clock: new WorldClock({ day: 1, dayTime: 0 }),
					zombies: true,
					interactive: false,
				});
				const sp = PL.createServerPlayer(
					{ slot: 0, userId: 1, name: "p" },
					save,
					4000,
					4000,
					sim.tick,
					sim.simHz,
				);
				sim.add(sp);
				// the aim reaches the server the only way it can: in the survivor's input commands
				let seq = 0;
				const feed = () =>
					PL.ingestInput(
						sp,
						P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [P.makeCommand(++seq, 0, 0, aim, 0, 0)] }),
						0,
					);
				for (let i = 0; i < 3; i++) {
					feed();
					sim.step();
				}
				sp.state.x = 4000;
				sp.state.y = 4000;
				feed();
				sim.step();
				return (x, y) => Brain.spawnAlpha(sim.horde.refs, x, y) === 1;
			};
			const AIMS = [0, 0.7, 2.2, -1.9];
			checkRows(
				"the rule is the server's: lit exactly where the horde is lit (24 bearings × 30 distances, 4 aims)",
				hands.map(([name, hand, gun, noc]) => ({ name, hand, gun, noc })),
				h => {
					const save = wearing(h.hand, h.gun, h.noc);
					for (const aim of AIMS) {
						const lit = serverLit(save, aim);
						for (let b = 0; b < 24; b++) {
							// off the exact edges by half a degree, so the rounding of a boundary point is not what is measured
							const a = aim + ((b * 15 + 0.5) * Math.PI) / 180;
							for (let d = 20; d <= 600; d += 20) {
								const x = 4000 + Math.cos(a) * (d + 0.5);
								const y = 4000 + Math.sin(a) * (d + 0.5);
								const rule = Light.survivorLights(save, 4000, 4000, aim, x, y);
								if (rule !== lit(x, y))
									return `aim ${aim}, bearing ${b * 15}°, ${d} u: rule ${rule}, server ${lit(x, y)}`;
							}
						}
					}
					return true;
				},
			);
			// and the screen: the REAL light map, fed what drawLight feeds it, sampled on its own lattice
			checkRows(
				"the screen's light map: nothing looks lit where the horde is dark, and all the horde's lit ground shows light (bar the fading rim)",
				hands.map(([name, hand, gun, noc]) => ({ name, hand, gun, noc })),
				h => {
					const save = wearing(h.hand, h.gun, h.noc);
					for (const aim of AIMS) {
						const frame = ui.makeInstance("Frame", false);
						const lm = new LightMap(frame, COLORS.overlayNight);
						const cam = new Camera();
						cam.setView(1400, 1400);
						cam.zoom = 1;
						cam.x = 4000;
						cam.y = 4000;
						lm.update(cam, 0.85, clientLights(save, 4000, 4000, aim));
						const cols = lm.sx.length;
						for (let r = 0; r < lm.sy.length; r++) {
							for (let c = 0; c < cols; c++) {
								const wx = 4000 + lm.sx[c] - 700;
								const wy = 4000 + lm.sy[r] - 700;
								const light = lm.samples[r * cols + c];
								const inRule = Light.survivorLights(save, 4000, 4000, aim, wx, wy);
								if (light > 0.001 && !inRule)
									return `aim ${aim}: light ${light.toFixed(3)} at (${wx - 4000}, ${wy - 4000}), dark for the horde`;
								if (inRule && light <= 0) {
									// only the last stretch of the falloff (radius) or of the cone's edge (angle) may read 0
									const d = Math.hypot(wx - 4000, wy - 4000);
									const circle = Light.survivorLightRadius(save);
									const cone = Light.survivorCone(save);
									const off = Math.abs(
										Math.atan2(
											Math.sin(Math.atan2(wy - 4000, wx - 4000) - aim),
											Math.cos(Math.atan2(wy - 4000, wx - 4000) - aim),
										),
									);
									const rim =
										d > circle - 4 &&
										(cone === undefined ||
											d > cone.radius - 4 ||
											off > Light.CONE_HALF_ANGLE - 0.02);
									if (!rim)
										return `aim ${aim}: dark at (${wx - 4000}, ${wy - 4000}), lit for the horde`;
								}
							}
						}
					}
					return true;
				},
			);
			{
				// the cone turns with the aim for 600 frames: the light map creates nothing (LUZ-04, ART-06's rule)
				const frame = ui.makeInstance("Frame", false);
				const lm = new LightMap(frame, COLORS.overlayNight);
				const cam = new Camera();
				cam.setView(1120, 630);
				cam.x = 4000;
				cam.y = 4000;
				const save = wearing(FLASHLIGHT, -1, 0);
				lm.update(cam, 0.85, clientLights(save, 4000, 4000, 0));
				const turning = ui.measure(() => {
					for (let f = 0; f < 600; f++) {
						const aim = f * 0.05;
						lm.setColor(f % 200 < 100 ? COLORS.overlayNight : COLORS.overlayNightVision);
						lm.update(cam, 0.85, clientLights(save, 4000 + f * 0.3, 4000, aim));
					}
				});
				checkEq(
					turning.created,
					0,
					"600 frames of a turning flashlight (and night vision on and off): 0 Instances created",
				);
			}
			{
				// ---- LUZ-04, the allies (2026-09-24): an ally's flashlight rides the wire (PlayerFlag.Flashlight, set by the
				// server from the rule the horde is lit by) and is drawn with the local survivor's own shape
				const REP = require(join(SRC, "server/net/replication.ts"));
				const { PlayersView } = require(join(SRC, "client/view/playersView.ts"));
				const flagOf = (hand, gun, dead) => {
					const sp = PL.createServerPlayer(
						{ slot: 1, userId: 2, name: "a" },
						wearing(hand, gun, 0),
						4000,
						4000,
						0,
						60,
					);
					sp.state.dead = dead;
					return (REP.playerBlockOf(sp).flags & P.PlayerFlag.Flashlight) !== 0;
				};
				check(
					flagOf(FLASHLIGHT, -1, false) &&
						!flagOf(-1, -1, false) &&
						!flagOf(TORCH, -1, false) &&
						!flagOf(-1, NIGHT_VISION, false) &&
						!flagOf(FLASHLIGHT, -1, true),
					"the server sets PlayerFlag.Flashlight exactly when the rule gives the survivor a cone, and never on a body",
				);
				const view = new PlayersView();
				const allyLights = (flashlight, aim, extra = {}) => {
					const list = new LL.LightList();
					view.collectLights(
						[{ x: 4000, y: 4000, angle: aim, flashlight, downed: false, dead: false, ...extra }],
						list,
					);
					return list.items;
				};
				const KEYS = ["x", "y", "r", "inner", "k", "angle", "cone"];
				const same = (a, b) => a.length === b.length && a.every((l, i) => KEYS.every(k => l[k] === b[i][k]));
				check(
					same(allyLights(true, 0.7), clientLights(wearing(FLASHLIGHT, -1, 0), 4000, 4000, 0.7)) &&
						same(allyLights(false, 0.7), clientLights(wearing(-1, -1, 0), 4000, 4000, 0.7)),
					"on my screen an ally's light is the local survivor's shape: the circle, and the flashlight's cone along their aim when the flag says so",
				);
				check(
					allyLights(true, 0, { dead: true }).length === 0 &&
						allyLights(true, 0, { downed: true }).length === 2,
					"a dead ally lights nothing; a downed one still holds their light (carriesLight, as on the server)",
				);
				// the zombies' awareness marks are dimmed by renderer.lightAt over this same list (GameLoop.markNight)
				const { lightAt } = require(join(SRC, "shared/engine/renderer.ts"));
				const beam = allyLights(true, 0);
				check(
					lightAt(beam, 4300, 4000) > 0.5 &&
						lightAt(beam, 3700, 4000) === 0 &&
						lightAt(allyLights(false, 0), 4300, 4000) === 0 &&
						/lights: this\.lights\.items/.test(draw),
					"and the zombies' marks read that very list: lit 300 u along an ally's beam, dark behind them and without it",
				);
				// what the wire cannot say yet: the torch, night vision and Nocturnal widen the circle on the server
				const wider = [
					["the torchlight", TORCH, -1, 0],
					["night vision", -1, NIGHT_VISION, 0],
					["Nocturnal", -1, -1, 1],
				].filter(([, h, g, n]) => Light.survivorLightRadius(wearing(h, g, n)) !== allyLights(false, 0)[0].r);
				knownBug(
					"LUZ-04-ally-radius",
					wider.length > 0,
					"an ally's wider circle: the server lights (and sends) the zombies out to it, my map draws their 250 u -- the player record has no bit left for it (a wire change)",
					wider.map(w => w[0]).join(", "),
				);
			}

			// ---- E2 (fixed 2026-09-23): night vision brightens the wearer's night
			check(
				Light.wearsNightVision(wearing(-1, NIGHT_VISION, 0)) &&
					!Light.wearsNightVision(wearing(FLASHLIGHT, -1, 0)),
				"night vision is known by its data row (EQUIP_LIGHTS sight), in the gun slot",
			);
			check(
				/SurvivorLight\.wearsNightVision\(save\)/.test(body) &&
					/setColor\(nightVision \? COLORS\.overlayNightVision : COLORS\.overlayNight\)/.test(body) &&
					/darkAlpha \* \(nightVision \? SurvivorLight\.NIGHT_VISION_DARK : 1\)/.test(body),
				`and on the wearer's screen the night is ${((1 - Light.NIGHT_VISION_DARK) * 100).toFixed(0)} % lighter, in phosphor green (gameLoop drawLight)`,
			);
		}
		{
			// ---- E2 (fixed 2026-09-23): the compass and the GPS show the way on the HUD (client/ui/hudNav.ts)
			const Nav = require(join(SRC, "client/ui/hudNav.ts"));
			const deep = (inst, name) => inst.GetDescendants().find(c => c.Name === name);
			const root = ui.makeInstance("Frame", false);
			const nav = new Nav.HudNav(root, k => k, 1);
			const world = W.createWorld(8000, 8000);
			const holding = hand => {
				const s = bareSave();
				s.equipHand = hand;
				if (hand >= 0) s.invenEquip[hand] = 1;
				return s;
			};
			let t = 0;
			const tick = (save, x = 4000, y = 4000) => {
				t += 1.1;
				nav.update(world, x, y, save, t);
			};
			tick(holding(-1));
			check(!nav.compass.Visible && !nav.map.Visible, "nothing that shows the way in hand: no plate");
			tick(holding(COMPASS));
			check(nav.compass.Visible && !nav.map.Visible, "the Compass in hand: the compass plate");
			const needle = deep(nav.compass, "Needle");
			const title = deep(nav.compass, "Target");
			const dist = deep(nav.compass, "Distance");
			check(
				Math.abs(needle.Rotation) < 1e-6 && title.Text === "North" && dist.Text === "No camp yet",
				"no camp in town: a plain compass, the needle on north",
				`${needle.Rotation}° "${title.Text}" "${dist.Text}"`,
			);
			// a campfire 1100 u east and 1100 u south: the needle turns to 135° (clockwise from north), 28 m away
			station(world, "campfire", 4000 + 1100 - 40 - 48, 4000 + 1100 + 30 - 32);
			tick(holding(COMPASS));
			check(
				Math.abs(needle.Rotation - 135) < 1 && title.Text === "Camp" && dist.Text === "28 m",
				"a campfire standing south-east: the needle points at it, and says how far (1 m = 55 u)",
				`${needle.Rotation.toFixed(1)}° "${title.Text}" "${dist.Text}"`,
			);
			tick(holding(GPS));
			check(nav.map.Visible && !nav.compass.Visible, "the GPS machine in hand: the map plate instead");
			const campMark = deep(nav.map, "Camp");
			const u = campMark.Position.X.Scale + campMark.Size.X.Scale / 2;
			const v = campMark.Position.Y.Scale + campMark.Size.Y.Scale / 2;
			check(
				campMark.Visible &&
					near(u, 0.5 + 1100 / (2 * Nav.MAP_RANGE), 0.01) &&
					near(v, 0.5 + 1100 / (2 * Nav.MAP_RANGE), 0.01),
				"the map marks the camp where it stands (north up, the survivor in the middle)",
				`at ${u.toFixed(3)}, ${v.toFixed(3)}`,
			);
			// a block of the town on the map: a building record 400 u north-west of the survivor
			W.addSolid(world, {
				kind: "building",
				x: 3500,
				y: 3500,
				w: 300,
				h: 200,
				hp: 1,
				hpMax: 1,
				destructible: false,
				tags: "house",
				passable: true,
			});
			const draws = ui.measure(() => {
				for (let f = 0; f < 600; f++) tick(holding(f % 300 < 150 ? GPS : COMPASS), 4000 + f, 4000 - f * 0.5);
			});
			tick(holding(GPS));
			const blocks = deep(nav.map, "Map")
				.GetChildren()
				.filter(c => c.Name === "Block" && c.Visible);
			check(
				blocks.length >= 1,
				"the buildings round the survivor are drawn on the map",
				`${blocks.length} block(s)`,
			);
			checkEq(
				draws.created,
				0,
				"600 frames of the compass and the GPS (walking, switching): 0 Instances created",
			);
			check(
				/hud\.updateNav\(refs\.world, p\.x, p\.y, save\)/.test(source("client/main.client.ts")) &&
					/this\.nav = new HudNav\(root, tr, k\)/.test(source("client/ui/hud.ts")),
				"the HUD mounts the plate and feeds it every frame of a run (main.client pushHud)",
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
		checkRows("a dead survivor eats nothing (refused as `dead`)", USABLES, u => {
			const { save, p } = holder(u);
			p.dead = true;
			craft.remove(0);
			const out = craft.useItem(0, p, save, u.id);
			return (out.kind === "refused" && out.why === "dead" && save.invenUse[u.id] === 2) || JSON.stringify(out);
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

section("C4. cooking: every raw food at a fire, as the card and How to play promise (fixed QA C1, 2026-09-23)", () => {
	const raw = USABLES.filter(u => u.cook >= 0);
	check(raw.length === 5, "five raw foods have a `cook` column", raw.map(u => u.name).join(", "));
	/** THE cooking recipe of a raw usable: one raw in, one cooked out, at a fire */
	const recipeOf = u =>
		CRAFT_RECIPES.filter(
			r =>
				r.needsCook === true &&
				r.resultKind === ItemKind.Use &&
				r.resultIndex === u.cook &&
				r.ingredients.length === 1 &&
				r.ingredients[0].kind === ItemKind.Use &&
				r.ingredients[0].index === u.id &&
				r.ingredients[0].count === 1 &&
				r.resultCount === 1 &&
				!r.needsDesk &&
				!r.needsPro &&
				r.needsFire !== true,
		);
	checkRows("each raw food has exactly one recipe: one raw → one cooked, at a fire", raw, u =>
		recipeOf(u).length === 1 ? true : `${recipeOf(u).length} recipe(s)`,
	);
	checkRows(
		"and nothing else is cooked: every cooking recipe is one of those (the data's `cook` column, nothing invented)",
		CRAFT_RECIPES.filter(r => r.needsCook === true),
		r => raw.some(u => recipeOf(u)[0] === r) || "not from a `cook` column",
	);
	const Rule = require(join(SRC, "shared/sim/craftRule.ts"));
	/** cook `u` once, next to `kind`, on the client (craftSystem) and on the server (ServerCraft) */
	const cookBoth = (u, kind, skills = {}) => {
		const r = recipeOf(u)[0];
		const out = {};
		for (const side of ["client", "server"]) {
			const save = stocked(r);
			for (const [id, lv] of Object.entries(skills)) save.skillLevels[Number(id)] = lv;
			if (side === "client") {
				const refs = craftRefs(save, kind);
				out.client = CCraft.craft(refs, r.id) ? INV.countItem(save, ItemKind.Use, u.cook) : -1;
			} else {
				const world = W.createWorld(4000, 4000);
				if (kind !== undefined) station(world, kind, 1000, 1000);
				const c = new SCRAFT.ServerCraft({ world, build: { placing: () => false, hold: () => {} } });
				const res = c.craft(0, Ply.createPlayer(save, 1000, 1000), save, r.id);
				out.server = res.kind === "crafted" ? INV.countItem(save, ItemKind.Use, u.cook) : -1;
				out.outcome = res;
			}
		}
		return out;
	};
	for (const [kind, what] of [
		["campfire", "a lit campfire"],
		["fire", "a lit brazier (it is a fire: it cooks as well as smelts)"],
		["cooker", "a working cooker (the power stage's hook: `powered`)"],
	]) {
		checkRows(`cooks next to ${what}, on the client and on the server`, raw, u => {
			const o = cookBoth(u, kind);
			return (o.client === 1 && o.server === 1) || `client ${o.client}, server ${o.server}`;
		});
	}
	for (const [kind, what] of [
		[undefined, "with no fire near"],
		["coldcampfire", "next to a campfire gone out"],
		["cold", "next to a cold brazier"],
		["coldcooker", "next to a cooker with no power"],
		["desk", "at a craft desk"],
		["furnace", "at the electric furnace (it smelts; it is not a stove)"],
	]) {
		checkRows(`refused ${what}, on both sides, and the raw food kept`, raw, u => {
			const o = cookBoth(u, kind);
			return (o.client === -1 && o.server === -1) || `client ${o.client}, server ${o.server}`;
		});
	}
	{
		// the server's outcome names the heat: the event the Chef and Blacksmith achievements count
		const o = cookBoth(raw[0], "campfire");
		check(
			o.outcome.kind === "crafted" && o.outcome.heat === "cook" && o.outcome.count === 1,
			'the server says what happened: { kind: "crafted", heat: "cook", count } (the Chef achievement\'s event)',
			JSON.stringify(o.outcome),
		);
		const smelt = CRAFT_RECIPES.find(r => r.needsFire === true);
		const world = W.createWorld(4000, 4000);
		station(world, "fire", 1000, 1000);
		const save = stocked(smelt);
		const res = new SCRAFT.ServerCraft({ world, build: { placing: () => false, hold: () => {} } }).craft(
			0,
			Ply.createPlayer(save, 1000, 1000),
			save,
			smelt.id,
		);
		check(res.heat === "smelt", 'and a smelting says heat: "smelt" (the Blacksmith\'s)', JSON.stringify(res));
		check(Rule.craftHeat(CRAFT_RECIPES[0]) === undefined, "a plain craft carries no heat");
	}
	{
		// Chef (skill 11): cooking now and then yields double -- 15 % at level 1, 30 % at level 2 (item_cook), on
		// the client's prediction and on the server, by the one shared rule (craftRule.craftYield)
		for (const lv of [0, 1, 2]) {
			const N = 2000;
			let clientDoubles = 0;
			let serverDoubles = 0;
			setSeed(200 + lv);
			for (let i = 0; i < N; i++) if (cookBoth(raw[0], "campfire", { 11: lv }).client === 2) clientDoubles++;
			setSeed(300 + lv);
			for (let i = 0; i < N; i++) if (cookBoth(raw[0], "campfire", { 11: lv }).server === 2) serverDoubles++;
			const want = [0, 0.15, 0.3][lv];
			check(
				near(clientDoubles / N, want, 0.03) && near(serverDoubles / N, want, 0.03),
				`Chef ${lv}: ${(want * 100).toFixed(0)} % of cookings come out double (client and server)`,
				`client ${((clientDoubles / N) * 100).toFixed(1)} %, server ${((serverDoubles / N) * 100).toFixed(1)} %`,
			);
		}
	}
	{
		// what the player reads agrees with it: the card, How to play and the Bag's Craft tab
		checkRows('the card says "Cooks into <cooked>" and where to cook it', raw, u => {
			const card = Info.describeItem(bareSave(), ItemKind.Use, u.id);
			const row = card.stats.find(s => s.label === "Cooks into");
			if (row === undefined || row.value !== USABLES[u.cook].name) return `row ${row?.value}`;
			return card.notes.includes("Cook it at a lit fire, from the Craft tab.") || `notes "${card.notes}"`;
		});
		check(
			source("client/ui/tutorial.ts").includes("cooks what you find") &&
				inLang("Fire lights the night and cooks what you find. Build one when you can."),
			'How to play and the coach say a fire "cooks what you find" -- now true',
		);
		checkRows('the Bag lists each cooking recipe; away from a fire: "Need fire", next to one: Craft', raw, u => {
			const r = recipeOf(u)[0];
			const save = stocked(r);
			const bag = bagFor(save);
			const [away] = bag.recipePanel(r);
			if (away.action.text !== "Need fire" || away.action.enabled) return `away: "${away.action.text}"`;
			if (away.station.text !== "Need a lit fire") return `station "${away.station.text}"`;
			bag.nearbyCook = true;
			const [near] = bag.recipePanel(r);
			if (near.action.text !== "Craft" || !near.action.enabled) return `near: "${near.action.text}"`;
			return near.station.text === "Lit fire nearby" || `station "${near.station.text}"`;
		});
		// the Bag's flags come from the same rule: main.client refreshDeskFlags asks stationNear(refs, "cook")
		check(
			/pack\.nearbyCook = stationNear\(refs, "cook"\) !== undefined/.test(source("client/main.client.ts")),
			'the Bag learns "a fire is near" from the shared rule (main.client refreshDeskFlags)',
		);
	}
});

// ================================================================ D. crafting

const INV_FIELD = { 1: "invenWeapon", 2: "invenEquip", 3: "invenUse", 4: "invenEtc" };
/**
 * A station of `kind` next to (x, y): "desk", "pro", "fire" (a lit brazier), "cold" (an unlit brazier), "furnace",
 * "campfire" (lit), "coldcampfire" (out), "cooker" (working: powered) and "coldcooker" (no power).
 */
function station(world, kind, x, y) {
	const tags = {
		desk: "craftdesk",
		pro: "craftdesk_pro",
		fire: "brazier",
		cold: "brazier",
		furnace: "furnace",
		campfire: "campfire",
		coldcampfire: "campfire",
		cooker: "cooker",
		coldcooker: "cooker",
	}[kind];
	const lit = { fire: true, campfire: true, cooker: true, cold: false, coldcampfire: false, coldcooker: false };
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
		powered: lit[kind],
	});
}
/** the one station a recipe asks for (cooking: a lit campfire; smelting: a lit brazier), or undefined for a hand recipe */
const stationOf = r =>
	r.needsPro
		? "pro"
		: r.needsDesk
			? "desk"
			: r.needsCook === true
				? "campfire"
				: r.needsFire === true
					? "fire"
					: undefined;
/** a station of the WRONG kind for a recipe that needs one: a plain desk for a pro desk, a fire gone out, a campfire to smelt */
const wrongStationOf = r =>
	r.needsPro ? "desk" : r.needsCook === true ? "coldcampfire" : r.needsFire === true ? "campfire" : undefined;
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
		"a recipe asks for one station at most (hand, desk, pro desk, fire to cook or brazier to smelt)",
		CRAFT_RECIPES,
		r =>
			[r.needsDesk, r.needsPro, r.needsFire === true, r.needsCook === true].filter(Boolean).length <= 1 ||
			"two stations",
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
			"with a station of the WRONG kind it is refused too (a desk is not a pro desk, a fire gone out cooks nothing, a campfire smelts nothing)",
			CRAFT_RECIPES.filter(r => wrongStationOf(r) !== undefined),
			r => {
				const save = stocked(r);
				const refs = craftRefs(save, wrongStationOf(r));
				return !CCraft.craft(refs, r.id) || `crafted next to a ${wrongStationOf(r)}`;
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
			// "near a desk" (fixed QA D2): ONE rule for the Bag and the server (shared/sim/craftRule.ts), the TRUE distance
			// to the station's rectangle. It used to be a box on the client, so 150 u off a corner on both axes (212 u)
			// the Bag offered a craft the server refused.
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
			const both = (x, y) => [
				CCraft.stationNear({ world, player: { x, y } }, "desk") !== undefined,
				SCRAFT.stationNear(world, x, y, "desk") !== undefined,
			];
			const corner = both(1000 + 96 + 150, 1000 + 64 + 150);
			check(
				!corner[0] && !corner[1],
				'"near a desk" is the true distance on both sides: 150 u off a corner on both axes (212 u) is too far for the Bag AND the server',
				`client ${corner[0]}, server ${corner[1]}`,
			);
			const edge = both(1000 + 96 + 175, 1032);
			check(edge[0] && edge[1], "175 u straight off an edge is near on both sides", `${edge}`);
			let disagree = 0;
			for (let i = 0; i < 45; i++)
				for (let j = 0; j < 45; j++) {
					const [c, s] = both(1048 - 450 + i * 20 + 3, 1032 - 450 + j * 20 + 7);
					if (c !== s) disagree++;
				}
			checkEq(disagree, 0, "2025 spots on a 20 u grid round a desk: the Bag and the server never disagree");
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
			bag.nearbyCook = true;
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
				const want =
					r.needsCook === true
						? "Need fire"
						: r.needsFire === true
							? "Need brazier"
							: r.needsPro
								? "Need pro desk"
								: "Need craft desk";
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
		// a placed lamp starts dark; E switches it on, and then -- fed by a battery box in reach of its cable (ELE-03, an
		// electric lamp) -- it lights the night for the horde's visibility
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
		// its battery box, 100 u away (out of E's reach, inside the 300 u of the cable)
		W.addSolid(world, {
			kind: "structure",
			x: 3130,
			y: 2980,
			w: 40,
			h: 40,
			hp: 300,
			hpMax: 300,
			destructible: true,
			tags: "battery",
			placeable: 6,
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
		// (chooseWeapon: from F3 the switch is also the server's SwitchWeapon verb; offline it is switchWeapon itself)
		check(
			/!ownsWeapon\(ctx\.save, refs\.player\.weapon\.pointer\)\) (switchWeapon|chooseWeapon)\(refs, 0\)/.test(
				body,
			),
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
	const POW = require(join(SRC, "shared/data/power.ts"));
	const { ServerPower } = require(join(SRC, "server/sim/power.ts"));
	const { ServerTurrets } = require(join(SRC, "server/sim/turrets.ts"));
	/**
	 * What an electric build does, MEASURED through the server's grid and turrets (server/sim/power.ts, turrets.ts;
	 * DESIGN_RULES ELE-01..08): placed next to a half-charged battery box at noon, with its survivor beside it.
	 * Undefined when it is not a machine, or when it did nothing.
	 */
	const machineDoes = id => {
		const def = PLACEABLES[id];
		const m = POW.MACHINES[def.tag];
		if (m === undefined) return undefined;
		const w = W.serverWorld(W.createWorld(3000, 3000));
		const save = bareSave();
		save.invenWeapon[POW.STUN_GUN_ID] = 1;
		const body = Ply.createPlayer(save, 1000, 1300);
		const power = new ServerPower({
			world: w,
			clock: { dayTime: 12, isRaining: false, darkAlpha: 0 },
			saveOf: () => save,
			bodyOf: () => body,
		});
		w.onSolidAdd = (_, s) => power.note(s, true);
		const put = (pid, x, y) => {
			const d = PLACEABLES[pid];
			return W.addSolid(w, { ...placedSolid(d, { x, y, w: d.w, h: d.h }, 0), placeable: pid, owner: 0 });
		};
		const s = put(id, 1000, 1000);
		const box = m.role === "battery" ? s : put(6, 1150, 1000);
		const bs = power.stateOf(box);
		if (m.role !== "battery") bs.store /= 2;
		const before = bs.store;
		power.settle(1);
		if (m.role === "battery") {
			const e0 = save.electric;
			power.act(0, body, save, s);
			return save.electric > e0 ? "stores power, charges the stun gun" : undefined;
		}
		if (m.role === "generator") return bs.store > before ? "charges its battery box" : undefined;
		if (m.role === "drone") {
			power.act(0, body, save, s);
			power.step(1 / 60, 1);
			if (power.stateOf(s).pilot !== 0) return undefined;
			return m.light ? "flies with its survivor, lighting the night" : "flies with its survivor, armed";
		}
		if (m.weapon !== undefined) {
			const z = createZombie(1, 1032 + 150, 1032, 1);
			z.hp = z.hpMax = 1e6;
			const combat = new ServerCombat({ world: w, targets: { zombies: () => [z], bosses: () => [] } });
			const turrets = new ServerTurrets({
				world: w,
				power,
				zombiesNear: (x, y, r, t, out) => (Math.hypot(z.x - x, z.y - y) <= r ? out.push(z) : 0, out),
				bosses: () => [],
				damage: combat,
			});
			for (let t = 0; t < 60 && z.hp === 1e6; t++) turrets.step(t, TICK_DT);
			return z.hp < 1e6 ? "shoots zombies on the server" : undefined;
		}
		if (!m.switched) return undefined;
		power.act(0, body, save, s);
		power.settle(0.25);
		// the one craft rule (shared/sim/craftRule.ts): the cooker is the "cook" station beside it once the grid feeds it
		if (def.tag === "cooker")
			return SCRAFT.stationNear(w, s.x + s.w / 2, s.y + s.h + 60, "cook") === s ? "cooking heat" : undefined;
		return s.powered === true ? (def.tag === "gps" ? "a beacon home" : "lights, on the grid") : undefined;
	};
	/** what a standing build of ETC index `id` does in the shipped game, or undefined */
	const does = id => {
		const def = PLACEABLES[id];
		const machine = machineDoes(id);
		if (machine !== undefined) return machine;
		const solid = placedSolid(def, { x: 1000, y: 1000, w: def.w, h: def.h }, 0);
		if (IQ.isLight(solid)) return "E lights it";
		// VEI-05, measured and not grepped: E at it on the SERVER's world puts the survivor on it (D8 rides it)
		if (VEH.vehicleKindOfSolid(solid) !== 0 && rideOnServer(id).mounted) return "E rides it";
		const w = W.createWorld(3000, 3000);
		W.addSolid(w, solid);
		for (const st of ["desk", "pro", "fire", "cook"])
			if (SCRAFT.stationNear(w, 1000 + def.w / 2, 1000 + def.h / 2, st) !== undefined) return `a ${st} station`;
		if (["barricade", "door", "iron_barricade", "iron_door"].includes(def.kind)) return "it blocks the way";
		if (new RegExp(`"${def.tag}"`).test(horde)) return "the horde reacts to it";
		return undefined;
	};
	const builds = Object.keys(PLACEABLES).map(Number);
	for (const id of builds) info(`${ETC_ITEMS[id].name}: ${does(id) ?? "nothing"}`);
	// fixed (ELE-01..08): the turrets, drones, battery box, generators, signal generator and cooker all have a job now,
	// measured above through the server's grid and turrets -- the lamp and the lamp drone included
	const machines = builds.filter(id => POW.MACHINES[PLACEABLES[id].tag] !== undefined);
	checkRows(
		"every electric build does its job once placed, on the server (ELE-01..08; was P1)",
		machines.map(id => ({ id, name: ETC_ITEMS[id].name })),
		row => machineDoes(row.id) !== undefined || "nothing",
	);
	// and the rest: stations, walls and doors, lights, and the vehicles (VEI-05, D8 rides them) -- P1 is fixed, and a build
	// that stops doing anything fails here instead of reappearing as a known bug
	checkRows(
		"every build does something once placed (was BUG [P1]: the machines and the vehicles did nothing)",
		builds.map(id => ({ id, name: ETC_ITEMS[id].name })),
		row => does(row.id) !== undefined || "nothing",
	);
	// CON-03, as the owner decided it on 2026-09-23 ("Faz todos os itens, equipamentos, consumíveis, receitas e skills
	// funcionarem"): no content lock hides anything -- every recipe of the data is live on both sides
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
	check(
		onClient && onServer,
		"CON-03 (owner, 2026-09-23): nothing in the data is hidden -- a Heavy machine gun crafts on the client and on the server, as every recipe does (D2, D3)",
	);
});

section(
	"D8. the bicycle and the motorcycle are ridden (VEI-05; was BUG [P1]: crafted and placed, then nothing)",
	() => {
		const vehicles = Object.keys(PLACEABLES)
			.map(Number)
			.filter(id => VEH.vehicleKindOfItem(id) !== 0);
		checkEq(
			vehicles.map(id => ETC_ITEMS[id].name).join(", "),
			"Bicycle, Motorcycle",
			"the placeables that are vehicles",
		);
		const walk = DESIGN.MOVE_SPEED * SPEED_SCALE * 2;
		checkRows(
			"server: E at the parked kit rides it, and two seconds on it outrun two seconds of walking",
			vehicles.map(id => ETC_ITEMS[id]),
			row => {
				const out = rideOnServer(row.id);
				if (!out.mounted) return "E did not mount it";
				return out.ran > walk || `${out.ran.toFixed(0)} u vs ${walk} on foot`;
			},
		);
		checkRows(
			"the recipe that makes it puts a kit the server can place (craftKind 1, a PLACEABLES row, rotatable, passable)",
			vehicles.map(id => ETC_ITEMS[id]),
			row => {
				const r = CRAFT_RECIPES.find(x => x.craftKind === 1 && x.resultIndex === row.id);
				const def = PLACEABLES[row.id];
				const vdef = VEH.vehicleDef(VEH.vehicleKindOfItem(row.id));
				if (r === undefined) return "no recipe";
				if (!def.rotatable || def.passable !== true) return "not rotatable / passable";
				return (def.w === vdef.length && def.h === vdef.width) || `footprint ${def.w}×${def.h}`;
			},
		);
		// full throttle burns oilIdle + oilFull = 1/60 + 1/10 a second: a whole unit leaves the backpack every ~8.6 s
		const moto = rideOnServer(22, 20, 15);
		check(
			moto.oilLeft < 20 && moto.oilLeft >= 18,
			"the motorcycle burns the rider's oil, a unit every ~9 s at full throttle",
			`${20 - moto.oilLeft} in 15 s`,
		);
		checkEq(rideOnServer(22, 0).mounted, false, "...and with none it will not start: E refuses it");
		const bike = rideOnServer(21, 0);
		check(bike.mounted && bike.oilLeft === 0 && bike.ran > walk, "the bicycle needs no oil");
		checkEq(inLang("Bicycle") && inLang("Motorcycle"), true, "both names are in lang.ts");
	},
);

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
	// 10 Thief: searching a building finds one more slot of its table, for the searcher alone (shared/sim/loot.ts),
	// on the client's MP_PHASE 2 search and on the server's; the building's own (shared) loot is untouched
	effect[10] = () => {
		const { ServerItems } = require(join(SRC, "server/sim/items.ts"));
		const { WorldOut } = require(join(SRC, "server/sim/worldOut.ts"));
		const CInter = require(join(SRC, "client/systems/interaction.ts"));
		const house = world2 =>
			W.addSolid(world2, {
				kind: "building",
				x: 1000,
				y: 1000,
				w: 400,
				h: 400,
				hp: 1,
				hpMax: 1,
				destructible: false,
				tags: "house",
				buildingType: BuildingType.Market,
				passable: true,
				lootSlots: 3,
				// one line of the table, as if rolled: what everyone would find
				lootItems: [{ kind: 3, id: 9, count: 1 }],
				lootTimer: 0,
			});
		/** every unit in the backpack's usable and material counters (the market's table gives nothing else) */
		const units = save => save.invenUse.reduce((a, b) => a + b, 0) + save.invenEtc.reduce((a, b) => a + b, 0);
		const N = 400;
		const per = { server: [0, 0], client: [0, 0] };
		for (const thief of [0, 1]) {
			setSeed(500 + thief);
			for (let i = 0; i < N; i++) {
				const world2 = W.serverWorld(W.createWorld(3000, 3000));
				house(world2);
				const s = withSkill(10, thief);
				const s0 = units(s);
				new ServerItems({ world: world2, out: new WorldOut() }).search(s, 1200, 1200, 0);
				per.server[thief] += units(s) - s0;
				const world3 = W.createWorld(3000, 3000);
				house(world3);
				const c = withSkill(10, thief);
				const c0 = units(c);
				const player = Ply.createPlayer(c, 1200, 1200);
				new CInter.Interaction().tryInteract({
					world: world3,
					players: [player],
					player,
					save: c,
					zombies: [],
					pendingPlace: -1,
					fx: [],
					daynight: { day: 1, dayTime: 12 },
				});
				per.client[thief] += units(c) - c0;
			}
		}
		const gain = side => (per[side][1] - per[side][0]) / N;
		return (
			(per.server[0] === N && per.client[0] === N && gain("server") > 0.5 && gain("client") > 0.5) ||
			`items per search: server ${per.server[0] / N} -> ${per.server[1] / N}, client ${per.client[0] / N} -> ${per.client[1] / N}`
		);
	};
	// 11 Chef: measured in C4 (15 % / 30 % double cookings, client and server)
	effect[11] = () => true;
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
	// 13 Robotics and 14 Engineering: the machines their maker builds (server/sim/power.ts, turrets.ts; ELE-08)
	{
		const POW = require(join(SRC, "shared/data/power.ts"));
		const { ServerPower } = require(join(SRC, "server/sim/power.ts"));
		const { ServerTurrets } = require(join(SRC, "server/sim/turrets.ts"));
		const { placedSolid } = require(join(SRC, "shared/sim/placement.ts"));
		/** a grid of one maker (slot 0), with `ids` placed in a row; returns the states */
		const grid = (s, ids) => {
			const w = W.serverWorld(W.createWorld(3000, 3000));
			const power = new ServerPower({
				world: w,
				clock: { dayTime: 12, isRaining: false, darkAlpha: 0 },
				saveOf: slot => (slot === 0 ? s : undefined),
			});
			w.onSolidAdd = (_, solid) => power.note(solid, true);
			const placed = ids.map((pid, i) => {
				const d = PLACEABLES[pid];
				return W.addSolid(w, {
					...placedSolid(d, { x: 1000 + i * 110, y: 1000, w: d.w, h: d.h }, 0),
					placeable: pid,
					owner: 0,
				});
			});
			return { w, power, placed, st: placed.map(solid => power.stateOf(solid)) };
		};
		/** one turret shot at its mean roll (random 0.5): the damage it deals */
		const turretShot = s => {
			const g = grid(s, [2, 6]);
			g.power.settle(0.25);
			const z = createZombie(1, 1032 + 150, 1032, 1);
			z.hp = z.hpMax = 1e6;
			const combat = new ServerCombat({
				world: g.w,
				targets: { zombies: () => [z], bosses: () => [] },
				random: () => 0.5,
			});
			const turrets = new ServerTurrets({
				world: g.w,
				power: g.power,
				zombiesNear: (x, y, r, t, out) => (Math.hypot(z.x - x, z.y - y) <= r ? out.push(z) : 0, out),
				bosses: () => [],
				damage: combat,
				random: () => 0.5,
			});
			for (let t = 0; t < 12 && z.hp === 1e6; t++) turrets.step(t, TICK_DT);
			return 1e6 - z.hp;
		};
		effect[13] = lv => {
			const a = turretShot(bareSave());
			const b = turretShot(withSkill(13, lv));
			const dA = grid(bareSave(), [3]).st[0].store;
			const dB = grid(withSkill(13, lv), [3]).st[0].store;
			return (
				(a === POW.TURRET_DAMAGE &&
					b === Math.floor(POW.TURRET_DAMAGE * POW.ROBOTICS_DAMAGE) &&
					dB === dA * 1.5) ||
				`turret shot ${a} -> ${b}, drone battery ${dA} -> ${dB}`
			);
		};
		/** a reactor's output a second into an empty box, and the box's capacity */
		const reactor = s => {
			const g = grid(s, [6, 8]);
			const cap = g.st[0].store;
			g.st[0].store = 0;
			g.power.settle(1);
			return { out: g.st[0].store, cap };
		};
		effect[14] = lv => {
			const a = reactor(bareSave());
			const b = reactor(withSkill(14, lv));
			return (
				(a.out === 6 && b.out === 9 && a.cap === 1000 && b.cap === 1200) ||
				`generator ${a.out}/s -> ${b.out}/s, battery ${a.cap} -> ${b.cap}`
			);
		};
	}
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
			"shared/sim/craftRule.ts",
			"shared/sim/loot.ts",
			"shared/sim/survivorLight.ts",
			"shared/game/player.ts",
			"client/systems/craftSystem.ts",
			"client/systems/interaction.ts",
			"client/systems/daynight.ts",
			// the electric grid and its turrets (Robotics, Engineering: ELE-08)
			"shared/data/power.ts",
			"server/sim/power.ts",
			"server/sim/turrets.ts",
		].map(rel => source(rel));
		const reads = id => running.some(src => new RegExp(`skillLevels\\[${id}\\]|SKILL_[A-Z_]+ = ${id};`).test(src));
		check(
			reads(10) && reads(11),
			"Thief and Chef are read by the code that runs (shared/sim/loot.ts SKILL_THIEF, shared/sim/craftRule.ts SKILL_CHEF; fixed 2026-09-23)",
		);
		// fixed: Robotics and Engineering are the grid's and the turrets' (their effect is measured above)
		check(
			reads(13) && reads(14),
			"Robotics (13) and Engineering (14) are read by the running server: the grid and its turrets (ELE-08; was K1)",
		);
		const dead = SKILLS.filter(k => !reads(k.id));
		// fixed K1 (the power stage, 2026-09-23): every skill that costs a point is read by code that runs
		check(
			dead.length === 0,
			"[K1] every skill that costs a point is read by the code the shipped game runs",
			dead.map(k => `${k.name} (${k.detail})`).join("; "),
		);
	}
	{
		// Health bought mid-life (fixed QA K2): stepPlayer recomputes the bar every step, like the original's hp_max
		const craft = new SCRAFT.ServerCraft({ world, build: { placing: () => false } });
		const s = bareSave();
		s.level = 5;
		s.skillPoint = 4;
		const p = Ply.createPlayer(s, 1000, 1000);
		p.hp = 80;
		craft.learnSkill(s, 0);
		stepPlayer(world, p, s, P.makeCommand(1, 0, 0, 0, 0, 0), TICK_DT);
		check(
			p.hpMax === 110 && p.hp < 81,
			"Health learnt mid-life raises max hp on the very next step (the hp is not topped up: regeneration fills it)",
			`hpMax ${p.hpMax}, hp ${p.hp.toFixed(2)}`,
		);
		craft.learnSkill(s, 0);
		stepPlayer(world, p, s, P.makeCommand(2, 0, 0, 0, 0, 0), TICK_DT);
		checkEq(p.hpMax, 120, "and Health 2 makes it 120");
		// a report that takes the level away (the admin's reset) lowers it, and the hp with it
		s.skillLevels[0] = 0;
		p.hp = 119;
		stepPlayer(world, p, s, P.makeCommand(3, 0, 0, 0, 0, 0), TICK_DT);
		check(
			p.hpMax === 100 && p.hp <= 100,
			"and a skill taken away lowers the bar and clips the hp",
			`${p.hp}/${p.hpMax}`,
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

section(
	"F4. trees, cars and bins drop the same things on the client and on the server (fixed QA L1, 2026-09-23)",
	() => {
		const { MAP_ITEM_LOOT } = require(join(SRC, "shared/data/spawns.ts"));
		const LOOT = require(join(SRC, "shared/sim/loot.ts"));
		// ONE table (shared/data/spawns.ts MAP_ITEM_LOOT) and ONE roll (shared/sim/loot.ts): neither side keeps a copy
		for (const rel of ["client/systems/interaction.ts", "server/sim/items.ts"]) {
			const src = source(rel);
			check(
				!/(TREE|CAR|TRASH)_LOOT/.test(src) && /rollMapItemDrop\(/.test(src) && /rollBuildingLoot\(/.test(src),
				`${rel} keeps no loot table of its own: it rolls the shared ones`,
			);
		}
		check(
			Object.keys(MAP_ITEM_LOOT).join() === "tree,car,trash",
			"the three map items have one table each",
			Object.keys(MAP_ITEM_LOOT).join(),
		);
		const all = [...MAP_ITEM_LOOT.tree, ...MAP_ITEM_LOOT.car, ...MAP_ITEM_LOOT.trash];
		check(
			!all.some(e => e.kind === ItemKind.Etc && (e.index === 26 || e.index === 28)),
			"Steel and Gold never drop from a map item: they are only ever smelted (crafts.ts)",
		);
		check(
			MAP_ITEM_LOOT.tree.every(e => (e.kind === ItemKind.Etc && e.index === 23) || e.kind === ItemKind.Use),
			"a tree gives wood and fruit, nothing else (P1: a blueprint does not grow on a tree)",
		);
		// the same seed gives the same drops on both sides, hit after hit
		const { ServerItems } = require(join(SRC, "server/sim/items.ts"));
		const { WorldOut } = require(join(SRC, "server/sim/worldOut.ts"));
		const CInter = require(join(SRC, "client/systems/interaction.ts"));
		const kinds = [
			{ name: "tree", kind: "tree", tags: "tree" },
			{ name: "car", kind: "structure", tags: "car" },
			{ name: "bin", kind: "structure", tags: "trash" },
		];
		checkRows(
			"300 hits on the same seed: the client's MP_PHASE 2 drops and the server's are the same, one by one",
			kinds,
			k => {
				const drops = side => {
					setSeed(77);
					const world =
						side === "server" ? W.serverWorld(W.createWorld(4000, 4000)) : W.createWorld(4000, 4000);
					const out = [];
					for (let i = 0; i < 300; i++) {
						const s = W.addSolid(world, {
							kind: k.kind,
							x: 1000 + (i % 20) * 120,
							y: 1000 + Math.floor(i / 20) * 120,
							w: 60,
							h: 60,
							hp: 1,
							hpMax: 1,
							destructible: false,
							tags: k.tags,
						});
						const before = world.items.length;
						if (side === "server")
							new ServerItems({ world, out: new WorldOut() }).hitMapItem(s, false, s.x - 30, s.y);
						else
							CInter.hitMapItem({ world, player: { x: s.x - 30, y: s.y } }, s, false, {
								x: s.x - 30,
								y: s.y,
							});
						const it = world.items[before];
						out.push(it === undefined ? "-" : `${it.kind}:${it.itemId}x${it.count}`);
					}
					return out;
				};
				const c = drops("client");
				const s = drops("server");
				const first = c.findIndex((d, i) => d !== s[i]);
				return first < 0 || `hit ${first}: client ${c[first]}, server ${s[first]}`;
			},
		);
		check(typeof LOOT.rollMapItemDrop === "function", "shared/sim/loot.ts exports the roll both sides use");
	},
);

// ================================================================ F5. every row: a way in, and a use

section("F5. every row of the data can be had in play, and every material is used (row audit, 2026-09-23)", () => {
	const sources = itemSources();
	const has = (kind, id) =>
		sources.some(s => s.kind === kind && s.index === id) || (kind === ItemKind.Weapon && id === 0);
	const rows = [
		...WEAPONS.map(w => ({ ...w, kind: ItemKind.Weapon, name: w.name })),
		...EQUIPS.map(e => ({ id: e.id, kind: ItemKind.Equip, name: e.name })),
		...USABLES.map(u => ({ id: u.id, kind: ItemKind.Use, name: u.name })),
		...ETC_ITEMS.map(e => ({ id: e.id, kind: ItemKind.Etc, name: e.name })),
	];
	// the Flamethrower and the Plastic armor had none: they are the original's boss trophies (BOSS_TROPHIES)
	checkRows(
		"every weapon, equipment, usable and material has a source (loot, map, boss, zombie, recipe, pack, costume)",
		rows,
		r => has(r.kind, r.id) || "no source in play",
	);
	// the materials: not a build (PLACEABLES, the night desks included), not ammunition or fuel (44..48)
	const MATERIALS = ETC_ITEMS.filter(e => e.id < 44 && PLACEABLES[e.id] === undefined);
	checkRows(
		"every material (wood .. radioactive) is an ingredient of some recipe",
		MATERIALS,
		m =>
			CRAFT_RECIPES.some(r => r.ingredients.some(i => i.kind === ItemKind.Etc && i.index === m.id)) ||
			"used by nothing",
	);
	checkRows(
		"every usable does something (health, hunger or a timed effect)",
		USABLES,
		u => u.hp !== 0 || u.hunger !== 0 || u.speed > 0 || u.calm > 0 || u.pain > 0 || "no effect",
	);
	// every piece of equipment is read by what it claims to do: clothing by the damage and the walk (B4), the watches by
	// the HUD clock, the gun gadgets by the server's combat, the lights by the light rule, the way-finders by the HUD's
	// nav plate, a cosmetic by the view (MON-04)
	const { EQUIP_LIGHTS, EQUIP_NAV, EquipSlot: Slot } = require(join(SRC, "shared/data/equips.ts"));
	const combat = source("server/sim/combat.ts");
	const readerOf = e => {
		if (e.kind === Slot.Cloth) return e.def !== 0 || e.speed !== 0 ? "defence/speed" : undefined;
		if (e.kind === 4)
			return COSTUMES.some(c => c.equipId === e.id) ||
				SHOP_PACKS.some(p => p.items.some(i => i.kind === ItemKind.Equip && i.index === e.id))
				? "cosmetic"
				: undefined;
		if (EQUIP_LIGHTS[e.id] !== undefined) return "light";
		if (EQUIP_NAV[e.id] !== undefined) return "nav";
		if (source("client/main.client.ts").includes(`"${e.name}"`)) return "clock";
		if ((e.id === 7 && /LASER_SIGHT_ID = 7/.test(combat)) || (e.id === 12 && /SILENCER_ID = 12/.test(combat)))
			return "combat";
		return undefined;
	};
	checkRows(
		"every piece of equipment is read by something (P3: it does what it looks like)",
		EQUIPS,
		e => readerOf(e) !== undefined || "read by nothing",
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
			/** one backpack verb on the Intent remote, as client/net/netClient.ts sends it (§4.8) */
			verb(p, kind, arg, atSeq = 0, nonce = 0) {
				remote("Intent").OnServerEvent.Fire(p, P.encodeIntentArgs(kind, atSeq, arg, nonce));
			},
			/** the last bag the server pushed to `p` in its wallet (§4.8), or undefined */
			lastBag(p) {
				const pushes = remote("SaveAck").sent.filter(e => e.to === p && e.args[0]?.wallet?.bag !== undefined);
				return pushes[pushes.length - 1]?.args[0].wallet.bag;
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
		// one "count × item" line per item, the item by its own name (compliance F6: our format, not the original's)
		const lines = p.contents.split("#").map(l => {
			const m = /^(\d+) × (.*)$/.exec(l.trim());
			return m && { name: m[2], count: Number(m[1]) };
		});
		if (lines.some(l => l === null) || lines.length !== p.items.length)
			return `"${p.contents}" vs ${p.items.length} item(s)`;
		for (let i = 0; i < p.items.length; i++) {
			const it = p.items[i];
			const real = nameOf(it.kind, it.index);
			if (it.index < 0 || real === undefined) return `item ${i} does not resolve`;
			if (lines[i].count !== it.count || lines[i].name !== real)
				return `"${lines[i].count} × ${lines[i].name}" vs ${real} x${it.count}`;
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
			// F3 (§4.8): the SERVER opens it into its own save once the survivor is in the world, and the report of a
			// client that opened it on its own copy as well (the pre-F3 client) adds nothing on top: exactly once
			const client = clone(save);
			deliverPacksLikeTheClient(client, INV2.addItem);
			const before = p.items.map(it => INV2.countItem(save, it.kind, it.index));
			s.immortal.add(pl);
			s.enter(pl);
			s.run(0.6);
			const ack = s.report(pl, reportOf(client));
			s.immortal.delete(pl);
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
	const SAVE2 = require(join(SRC, "shared/game/save.ts"));
	const pack = SHOP_PACKS.find(p => p.items.some(it => it.kind === ItemKind.Equip && COSMETIC(EQUIPS[it.index])));
	const pet = pack.items.find(it => it.kind === ItemKind.Equip).index;
	const pl = s.join(newUser(), "petowner");
	s.immortal.add(pl);
	const save = s.save(pl);
	save.money = 1000;
	check(s.shop(pl, { kind: "buyPack", packId: pack.id }).ok, `the ${pack.name} is bought`);
	// F3 (§4.8): the server opens the pack when the survivor enters the world, and the Bag's Equip is a verb
	s.enter(pl);
	s.run(0.6);
	s.verb(pl, s.P.IntentKind.Equip, pet, 0, 1);
	s.beat();
	check(
		save.invenEquip[pet] === 1 && save.equipPet === pet,
		`delivered and worn: the server says ${EQUIPS[pet].name} is theirs and on`,
	);
	check(SAVE2.petLookOf(save) !== 0, "and it is what goes on the wire (petLookOf)");
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
	// the wardrobe (MON-04) is out of the world: its Equip is the one verb the server applies there, cosmetics only
	s.verb(pl, s.P.IntentKind.Equip, outfit.equipId, 0, 1);
	s.verb(pl, s.P.IntentKind.Equip, pet.equipId, 0, 2);
	check(
		save.equipOutfit === outfit.equipId && save.equipPet === pet.equipId,
		`the wardrobe's Equip puts on the bought ${outfit.name} and ${pet.name} (out of the world, on the session's save)`,
	);
	const client = clone(save);
	client.equipOutfit = -1;
	client.equipPet = -1;
	s.report(pl, reportOf(client));
	check(
		save.equipOutfit === outfit.equipId && save.equipPet === pet.equipId,
		"and a report no longer moves them: the slots are the server's (§4.8), Unequip is the verb that does",
	);
});

section(
	"G4. the MP_PHASE 2 seams, closed by F3: the backpack and the constructions are the server's (NET-1..6)",
	() => {
		const s = Roblox.bootServer();
		const P2 = s.P;
		const IK = P2.IntentKind;
		const SIM2 = require(join(SRC, "server/sim/simulation.ts"));
		const BPK = require(join(SRC, "server/sim/backpack.ts"));
		const Ply2 = require(join(SRC, "shared/game/player.ts"));
		const INV2 = require(join(SRC, "shared/sim/inventory.ts"));
		const SAVE2 = require(join(SRC, "shared/game/save.ts"));
		const CFG2 = require(join(SRC, "shared/net/mpConfig.ts"));
		const W2 = require(join(SRC, "shared/game/world.ts"));
		const PHYS2 = require(join(SRC, "shared/game/physics.ts"));
		const PLC2 = require(join(SRC, "shared/sim/placement.ts"));
		const RULE2 = require(join(SRC, "shared/sim/craftRule.ts"));
		const { EQUIP_LIGHTS } = require(join(SRC, "shared/data/equips.ts"));
		const Mirror = require(join(SRC, "client/net/worldMirror.ts"));
		let seq = 0;
		let nonce = 0;
		/** one Input command from `pl`: nothing else of a key press can travel (§2.2) */
		const press = (pl, held, edges) => {
			seq += 1;
			const cmds = [];
			for (let k = 0; k < 3 && seq - k >= 1; k++) cmds.push(P2.makeCommand(seq - k, 0, 0, 0, held, edges));
			s.env.services.ReplicatedStorage.FindFirstChild("Net")
				.FindFirstChild("Input")
				.OnServerEvent.Fire(pl, P2.encodeInput({ viewTick: 0, viewFrac: 0, cmds }));
		};
		/** a Bag click: a verb made during the NEXT command (its atSeq) with a fresh nonce, as client/net/backpackSync.ts */
		const verb = (pl, kind, arg) => {
			nonce += 1;
			s.verb(pl, kind, arg, seq + 1, nonce);
			return nonce;
		};
		/** beats until the server consumed `pl`'s command `want`; `each` looks at the survivor before every beat */
		const untilConsumed = (sp, want, each) => {
			for (let i = 0; i < 90 && sp.ackSeq < want; i++) {
				each?.();
				s.beat();
			}
			return sp.ackSeq >= want;
		};
		const clientSrc = ["client/net/netClient.ts", "client/systems/combat.ts"].map(source).join("\n");
		info(`MP_PHASE ${CFG2.MP_PHASE}; WORLD_SERVER_PHASE ${CFG2.WORLD_SERVER_PHASE}`);
		check(
			CFG2.MP_PHASE === 2 && CFG2.WORLD_SERVER_PHASE === 2 && SIM2.WORLD_SERVER_PHASE === 2,
			"the shipped phase: the server owns the body, the combat, the interactive world AND the backpack (F3)",
		);

		{
			// NET-1: keys 1-5, the hotbar and the Bag's Equip are a SwitchWeapon verb for the command they were pressed
			// during, and the server's weapon machine switches in the very tick that consumes that command
			check(
				/encodeIntentArgs\(/.test(clientSrc) &&
					/sendBagVerb\(IntentKind\.SwitchWeapon/.test(clientSrc) &&
					/chooseWeapon\(refs, id\)/.test(clientSrc),
				"[NET-1] the client sends the switch: the keys, the hotbar and the Bag go through chooseWeapon -> SwitchWeapon",
			);
			const pl = s.join(newUser(), "switcher");
			s.immortal.add(pl);
			const save = s.save(pl);
			save.invenWeapon[10] = 1;
			save.ammoNormal = 30;
			save.equipWeapon = 0;
			const sp = s.enter(pl);
			press(pl, 0, 0);
			untilConsumed(sp, seq);
			const n = verb(pl, IK.SwitchWeapon, 10);
			press(pl, P2.HeldBit.Attack, P2.packEdges(1, 0, 0, 0));
			const before = [];
			const consumed = untilConsumed(sp, seq, () => before.push(sp.state.weapon.pointer));
			check(
				consumed && sp.state.weapon.pointer === 10 && before.every(w => w === 0),
				"[NET-1] the switch lands in the tick that consumes its command: not one before, not at a report",
				`consumed ${consumed}; held ${[...new Set(before)].join(",")} before, ${WEAPONS[sp.state.weapon.pointer]?.name} after`,
			);
			for (let i = 0; i < 120; i++) {
				press(pl, P2.HeldBit.Attack, P2.packEdges(1, 0, 0, 0));
				s.beat();
			}
			const shots = s.sim.combat.statsOf(sp.slot).shots;
			check(
				shots > 0 && save.ammoNormal < 30,
				"...and the server's combat fires the pistol, from the server's reserve",
				`${shots} shot(s), reserve 30 -> ${save.ammoNormal}`,
			);
			s.run(0.3);
			const bag = s.lastBag(pl);
			check(
				bag?.ack === n && bag?.equip?.[0] === 10 && bag?.ammo?.[0] === save.ammoNormal,
				"the wallet's bag answers the verb (its nonce), with the pistol in hand and the reserve the server spent",
				JSON.stringify(bag && { ack: bag.ack, weapon: bag.equip[0], ammo: bag.ammo[0] }),
			);
			s.quit(pl);
		}
		{
			// NET-2: the Bag's Use / Eat is a UseItem verb: the SERVER's body heals and eats, the server's backpack pays
			const pl = s.join(newUser(), "eater");
			s.immortal.add(pl);
			const save = s.save(pl);
			const BANDAGE = USABLES.find(u => u.name === "Bandage").id;
			const CAN = USABLES.find(u => u.name === "Canned food").id;
			save.invenUse[BANDAGE] = 3;
			save.invenUse[CAN] = 3;
			const sp = s.enter(pl);
			s.immortal.delete(pl);
			sp.state.godMode = false;
			sp.state.hp = 40;
			sp.state.hungry = 30;
			const client = clone(save);
			verb(pl, IK.UseItem, BANDAGE);
			verb(pl, IK.UseItem, CAN);
			press(pl, 0, 0);
			s.run(0.6);
			check(
				sp.state.hp > 55 && sp.state.hungry > 45 && save.invenUse[BANDAGE] === 2 && save.invenUse[CAN] === 2,
				"[NET-2] eating on the server: the bandage heals and the can feeds the server's body, one of each is gone",
				`${sp.state.hp.toFixed(0)} hp / ${sp.state.hungry.toFixed(0)} food; bandages ${save.invenUse[BANDAGE]}, cans ${save.invenUse[CAN]}`,
			);
			s.report(pl, reportOf(client));
			check(
				save.invenUse[BANDAGE] === 2 && save.invenUse[CAN] === 2,
				"a report still holding the bandage and the can does not give them back",
			);
			s.quit(pl);
		}
		{
			// NET-3: the client's predicted reloads spend its own copy of the reserve, the server spends its own, and a report
			// cannot write an unspent number back over the server's
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
			check(
				client.ammoNormal < clientStart,
				"[NET-3] the client's predicted reloads spend its copy of the reserve: the HUD's number drops",
				`client ${clientStart} -> ${client.ammoNormal}`,
			);
			for (let i = 0; i < 600; i++) {
				press(pl, P2.HeldBit.Attack, P2.packEdges(1, 0, 0, 0));
				s.beat();
			}
			const fired = s.sim.combat.statsOf(sp.slot).shots;
			const serverLeft = save.ammoNormal;
			const unspent = clone(client);
			unspent.ammoNormal = clientStart;
			s.report(pl, reportOf(unspent));
			check(
				fired > 10 && serverLeft < clientStart && save.ammoNormal === serverLeft,
				"[NET-3] the server spends its own reserve, and a report of the unspent number changes nothing",
				`server fired ${fired}, its reserve ${clientStart} -> ${serverLeft} -> ${save.ammoNormal} after the report`,
			);
			s.quit(pl);
		}
		{
			// NET-4: armour, gadgets (a light) and skills are verbs too: the server's damage, walk and light rule see them
			// from the tick of the click
			const pl = s.join(newUser(), "armoured");
			s.immortal.add(pl);
			const save = s.save(pl);
			const STEEL = EQUIPS.find(e => e.name === "Steel armor").id;
			const LIGHT = Object.keys(EQUIP_LIGHTS)
				.map(Number)
				.find(id => SAVE2.equipSlotOf(id) !== SAVE2.equipSlotOf(STEEL));
			save.invenEquip[STEEL] = 1;
			save.invenEquip[LIGHT] = 1;
			save.level = 4;
			save.skillPoint = 3;
			const sp = s.enter(pl);
			const defBefore = Ply2.playerEquipDefence(save);
			verb(pl, IK.Equip, STEEL);
			verb(pl, IK.Equip, LIGHT);
			verb(pl, IK.LearnSkill, 7);
			press(pl, 0, 0);
			const consumed = untilConsumed(sp, seq);
			check(
				consumed &&
					defBefore === 0 &&
					Ply2.playerEquipDefence(save) === EQUIPS[STEEL].def &&
					SAVE2.equippedIn(save, SAVE2.equipSlotOf(LIGHT)) === LIGHT &&
					save.skillLevels[7] === 1 &&
					save.skillPoint === 2,
				`[NET-4] the Steel armor protects, the ${EQUIPS[LIGHT].name} is on and Trot counts from the tick of the click`,
				`defence ${defBefore} -> ${Ply2.playerEquipDefence(save)}, light ${SAVE2.equippedIn(save, SAVE2.equipSlotOf(LIGHT))}, Trot ${save.skillLevels[7]}, points ${save.skillPoint}`,
			);
			s.quit(pl);
		}
		{
			// NET-5 (the network audit's H1): a report can no longer write ANY of the backpack
			const pl = s.join(newUser(), "forger");
			s.immortal.add(pl);
			const save = s.save(pl);
			const sp = s.enter(pl);
			const HMG = WEAPONS.find(w => w.name === "Heavy machine gun").id;
			const STEEL = EQUIPS.find(e => e.name === "Steel armor").id;
			const trusted = clone(save);
			const client = clone(save);
			client.invenWeapon[HMG] = 1;
			client.equipWeapon = HMG;
			client.ammoMachinegun = 99999;
			client.ammoNormal = 99999;
			client.oil = 99999;
			client.invenEtc[29] = 999;
			client.invenUse[0] = 999;
			client.invenEquip[STEEL] = 1;
			client.equipCloth = STEEL;
			client.skillLevels[3] = 3;
			client.packsOpened[0] = 5;
			s.report(pl, { ...reportOf(client), skillPoint: 40 });
			s.beat();
			const moved = BPK.SERVER_BACKPACK_FIELDS.filter(
				k => JSON.stringify(save[k]) !== JSON.stringify(trusted[k]),
			);
			check(
				moved.length === 0 && sp.state.weapon.pointer !== HMG,
				"[NET-5] a forged report writes nothing of the backpack: no weapon, round, fuel, material, usable, armour, skill or pack",
				moved.map(k => `${k}: ${JSON.stringify(trusted[k])} -> ${JSON.stringify(save[k])}`).join(" | "),
			);
			s.quit(pl);
		}
		{
			// NET-6: a construction is the server's: crafted by a verb, placed by the click (the command's attack edge) where
			// the SERVER says the survivor aims, solid for the server's horde, and on every screen through the World channel
			check(
				s.sim.build !== undefined && /serverOwnsWorld\(\)/.test(source("client/systems/build.ts")),
				"[NET-6] the server runs the constructions, and the client's build mode defers to it",
			);
			const recipe = CRAFT_RECIPES.find(
				r =>
					r.craftKind === 1 &&
					RULE2.recipeStation(r) === undefined &&
					PLC2.PLACEABLES[r.resultIndex] !== undefined,
			);
			const pl = s.join(newUser(), "builder");
			const other = s.join(newUser(), "neighbour");
			s.immortal.add(pl);
			s.immortal.add(other);
			const save = s.save(pl);
			for (const ing of recipe.ingredients) INV2.addItem(save, ing.kind, ing.index, ing.count);
			const sp = s.enter(pl);
			s.enter(other);
			// an open patch of street, so the only thing the test measures is the server's rule, not a car in the way
			const world = s.sim.world;
			const def = PLC2.PLACEABLES[recipe.resultIndex];
			const bodies = s.sim.players().map(q => q.state);
			const clear = (x, y) =>
				x > 400 &&
				y > 400 &&
				x < world.width - 400 &&
				y < world.height - 400 &&
				W2.querySolids(world, x - 260, y - 260, x + 260, y + 260, []).every(q => q.passable === true) &&
				(s.sim.horde?.zombies ?? []).every(z => Math.hypot(z.x - x, z.y - y) > 500) &&
				PLC2.placementValid(world, PLC2.ghostRect(def, x, y, 0, 0), [...bodies, { x, y }], []);
			let spot;
			for (let r = 1; r < 60 && spot === undefined; r++) {
				for (let a = 0; a < 8 && spot === undefined; a++) {
					const x = Math.round(sp.state.x + Math.cos((a * Math.PI) / 4) * r * 160);
					const y = Math.round(sp.state.y + Math.sin((a * Math.PI) / 4) * r * 160);
					if (clear(x, y)) spot = [x, y];
				}
			}
			sp.state.x = spot[0];
			sp.state.y = spot[1];
			s.clearWorldLog();
			verb(pl, IK.Craft, recipe.id);
			press(pl, 0, 0);
			untilConsumed(sp, seq);
			check(
				s.sim.build.pendingOf(sp.slot) === recipe.resultIndex &&
					recipe.ingredients.every(ing => INV2.countItem(save, ing.kind, ing.index) === 0),
				"the Craft verb puts the construction on the SERVER's cursor and takes the ingredients from its backpack",
				`cursor ${s.sim.build.pendingOf(sp.slot)}`,
			);
			press(pl, 0, P2.packEdges(1, 0, 0, 0));
			untilConsumed(sp, seq);
			// the World batch goes out on the snapshot's cadence (audit M3)
			for (let i = 0; i < (CFG2.WORLD_FLUSH_EVERY_TICKS ?? 1); i++) s.beat();
			const built = world.solids.find(q => q.placeable === recipe.resultIndex && q.owner === sp.slot);
			check(
				built !== undefined && built.id >= CFG2.DYNAMIC_ID_BASE && s.sim.build.pendingOf(sp.slot) === -1,
				"[NET-6] the click places it in the SERVER's world, with a server id, and frees the cursor",
				built === undefined
					? `nothing placed: survivor (${sp.state.x.toFixed(0)}, ${sp.state.y.toFixed(0)}) aim ${sp.state.angle.toFixed(2)}, ` +
							`spot ${spot}, cursor ${s.sim.build.pendingOf(sp.slot)}, ghost valid ${PLC2.placementValid(
								world,
								PLC2.ghostRect(def, sp.state.x, sp.state.y, sp.state.angle, 0),
								s.sim.players().map(q => q.state),
								s.sim.horde?.zombies ?? [],
							)}, acked ${sp.ackSeq}/${seq}`
					: `id ${built.id} at (${built.x}, ${built.y})`,
			);
			if (built === undefined) return;
			const r = 14;
			const from = built.x - r - 40;
			const moved = PHYS2.moveActor(world, from, built.y + built.h / 2, r, 200, 0);
			check(
				PHYS2.blocksMovement(built) && moved.x + r <= built.x + 0.5,
				"[NET-6] the server's zombies collide with it: a body walked into it stops at its face",
				`x ${from} -> ${moved.x.toFixed(1)}, the wall at ${built.x}`,
			);
			const addsTo = who => {
				const out = [];
				for (const e of s.remote("World").sent) {
					if (e.to !== undefined && e.to !== who) continue;
					const batch = P2.decodeWorld(e.args[0]);
					for (const ev of batch?.events ?? [])
						if (ev.t === P2.WorldEv.SolidAdd && ev.id === built.id) out.push(ev);
				}
				return out;
			};
			const seenByOther = addsTo(other);
			check(
				seenByOther.length === 1 && addsTo(pl).length === 1,
				"[NET-6] ...and every survivor in the world is told, the builder and the neighbour alike (one SolidAdd each)",
				`neighbour ${seenByOther.length}, builder ${addsTo(pl).length}`,
			);
			// the neighbour's client lays it over its own town: the same wall, the same id, the same rect
			const theirs = W2.createWorld(world.width, world.height);
			if (seenByOther[0] !== undefined) Mirror.applyMirrorEvent(theirs, seenByOther[0]);
			const mirrored = theirs.solids.find(q => q.id === built.id);
			check(
				mirrored !== undefined &&
					mirrored.x === built.x &&
					mirrored.y === built.y &&
					mirrored.w === built.w &&
					mirrored.h === built.h &&
					PHYS2.blocksMovement(mirrored),
				"the neighbour's mirror (client/net/worldMirror.ts) builds the same solid wall, same id, same rect",
				mirrored === undefined ? "missing" : `(${mirrored.x}, ${mirrored.y}, ${mirrored.w}x${mirrored.h})`,
			);
			// and whoever enters later finds it in the WorldInit
			s.clearWorldLog();
			const late = s.join(newUser(), "latecomer");
			s.immortal.add(late);
			s.enter(late);
			check(addsTo(late).length >= 1, "a survivor who enters later gets it in the WorldInit");
			for (const q of [pl, other, late]) s.quit(q);
		}
	},
);

section(
	"G5. the client's half of §4.8: its prediction, and the server's bag laid over it (client/net/bagPrediction.ts)",
	() => {
		const s = Roblox.bootServer();
		const IK = s.P.IntentKind;
		const BP = require(join(SRC, "client/net/bagPrediction.ts"));
		const SAVE2 = require(join(SRC, "shared/game/save.ts"));
		const Ply2 = require(join(SRC, "shared/game/player.ts"));
		const INV2 = require(join(SRC, "shared/sim/inventory.ts"));
		const RULE2 = require(join(SRC, "shared/sim/craftRule.ts"));
		const CAN = USABLES.find(u => u.name === "Canned food").id;
		const STEEL = EQUIPS.find(e => e.name === "Steel armor").id;
		const pl = s.join(newUser(), "predictor");
		s.immortal.add(pl);
		const save = s.save(pl);
		save.invenUse[CAN] = 5;
		const sp = s.enter(pl);
		sp.state.hungry = 10;
		s.run(0.3);
		const client = clone(save);
		const body = Ply2.createPlayer(client, 0, 0);
		body.hungry = 10;
		const cursor = { pendingPlace: -1 };
		const entries = [];

		// 1. a verb the server takes: predicted at once, kept over an older bag, retired by the bag that answers it
		check(
			BP.predictVerb(client, cursor, IK.UseItem, CAN, body) && client.invenUse[CAN] === 4,
			"a Use is predicted at once, by the server's rule: one can fewer on the client's copy",
		);
		entries.push({ kind: IK.UseItem, arg: CAN, nonce: 1, seq: 0, at: 0 });
		const older = SAVE2.readBag(SAVE2.bagOf(save, -1, 0, 0));
		s.verb(pl, IK.UseItem, CAN, 0, 1);
		BP.rebase(client, cursor, older, entries, 0.1);
		check(
			client.invenUse[CAN] === 4 && entries.length === 1,
			"a bag the server wrote before it had the verb keeps the prediction on top",
		);
		s.run(0.5);
		const answer = SAVE2.readBag(s.lastBag(pl));
		check(answer?.ack === 1 && answer.invenUse[CAN] === 4, "the server ate it too, and its bag answers nonce 1");
		BP.rebase(client, cursor, answer, entries, 0.2);
		check(
			client.invenUse[CAN] === 4 && entries.length === 0,
			"that bag retires the prediction: the server's count stands and nothing is eaten twice",
		);

		// 2. a verb the server refuses: predicted, then undone by the bag that answers it
		client.invenEquip[STEEL] = 1; // a client that believes it owns the armour; the server knows it does not
		check(
			BP.predictVerb(client, cursor, IK.Equip, STEEL) && client.equipCloth === STEEL,
			"an Equip is predicted at once",
		);
		entries.push({ kind: IK.Equip, arg: STEEL, nonce: 2, seq: 0, at: 0.3 });
		s.verb(pl, IK.Equip, STEEL, 0, 2);
		s.run(0.5);
		const refused = SAVE2.readBag(s.lastBag(pl));
		BP.rebase(client, cursor, refused, entries, 0.8);
		check(
			refused?.ack === 2 && client.equipCloth === -1 && client.invenEquip[STEEL] === 0 && entries.length === 0,
			"the server refused it (not owned): the bag that answers it takes the armour off again",
		);

		// 3. an answer that never comes: dropped after PENDING_TTL_S, and the server's bag stands
		check(
			BP.predictVerb(client, cursor, IK.UseItem, CAN, body) && client.invenUse[CAN] === 3,
			"another can, predicted",
		);
		entries.push({ kind: IK.UseItem, arg: CAN, nonce: 3, seq: 0, at: 1 });
		BP.rebase(client, cursor, refused, entries, 1 + BP.PENDING_TTL_S / 2);
		check(client.invenUse[CAN] === 3 && entries.length === 1, "still waiting for the server: the prediction holds");
		BP.rebase(client, cursor, refused, entries, 1 + BP.PENDING_TTL_S + 0.1);
		check(
			client.invenUse[CAN] === 4 && entries.length === 0,
			`never answered: after PENDING_TTL_S (${BP.PENDING_TTL_S} s) the server's count comes back`,
		);

		// 4. a construction: the Craft puts it on the cursor at once, and the click (a build edge on command 40) frees it
		const recipe = CRAFT_RECIPES.find(r => r.craftKind === 1 && RULE2.recipeStation(r) === undefined);
		for (const ing of recipe.ingredients) INV2.addItem(client, ing.kind, ing.index, ing.count);
		check(
			BP.predictVerb(client, cursor, IK.Craft, recipe.id) && cursor.pendingPlace === recipe.resultIndex,
			"a construction's Craft puts it on the cursor at once",
		);
		check(
			!BP.predictVerb(client, cursor, IK.Craft, recipe.id),
			"and a second one is not predicted while the first is on the cursor (the server says `busy`)",
		);
		const held = { ...refused, ack: 4, place: recipe.resultIndex, seq: 38 };
		entries.push({ kind: IK.Craft, arg: recipe.id, nonce: 4, seq: 0, at: 2 });
		cursor.pendingPlace = -1; // client/systems/build.ts: the click leaves the cursor at once...
		entries.push({ kind: BP.EDGE_ENTRY, arg: 0, nonce: 0, seq: 40, at: 2.1 }); // ...and notes the edge
		BP.rebase(client, cursor, held, entries, 2.2);
		check(
			cursor.pendingPlace === -1 && entries.length === 1,
			"a bag written before the server consumed command 40 does not put the construction back on the cursor",
		);
		BP.rebase(client, cursor, { ...held, seq: 40 }, entries, 2.3);
		check(
			cursor.pendingPlace === recipe.resultIndex && entries.length === 0,
			"one written after it says what the server did: here it refused the spot, so it is back on the cursor",
		);
		BP.rebase(client, cursor, { ...held, seq: 44, place: -1 }, entries, 2.4);
		check(cursor.pendingPlace === -1, "and once the server placed it, it is gone from the cursor for good");
		s.quit(pl);
	},
);

section(
	"G6. the owner's report (2026-09-23): the Food bar fills, a bandage heals, a buff runs -- server, self block, HUD",
	() => {
		// "using an item to raise the Food bar does nothing": at MP_PHASE 2 the self block owns hp, hunger and the buffs
		// (client/net/prediction.ts `applyVitals`), so an effect applied only on the client was undone by the next
		// snapshot while the report still took the item away. From F3 the Bag's Use is the server's verb: the client
		// predicts the COUNT only, and the vitals come back in the self block. Here the whole path: the real server, its
		// real snapshots decoded off the wire, and the client's real prediction adopting them.
		const s = Roblox.bootServer();
		const P2 = s.P;
		const IK = P2.IntentKind;
		const BP = require(join(SRC, "client/net/bagPrediction.ts"));
		const { Prediction } = require(join(SRC, "client/net/prediction.ts"));
		const SAVE2 = require(join(SRC, "shared/game/save.ts"));
		const Ply2 = require(join(SRC, "shared/game/player.ts"));
		const W2 = require(join(SRC, "shared/game/world.ts"));
		const byName = n => USABLES.find(u => u.name === n).id;
		const CAN = byName("Canned food");
		const BANDAGE = byName("Bandage");
		const APPLE = byName("Apple");
		const RUSH = USABLES.find(u => u.speed > 0 && u.hp === 0 && u.hunger === 0).id;
		const pl = s.join(newUser(), "hungry");
		s.immortal.add(pl); // no bites: every hp and food point below is the item's
		const save = s.save(pl);
		for (const id of [CAN, BANDAGE, APPLE, RUSH]) save.invenUse[id] = 3;
		const sp = s.enter(pl);
		sp.state.hp = 40;
		sp.state.hungry = 30;
		// the client: its copy of the backpack, its survivor, and the prediction that adopts every self block
		const client = clone(save);
		const body = Ply2.createPlayer(client, sp.state.x, sp.state.y);
		const pred = new Prediction();
		pred.attach(W2.createWorld(s.sim.world.width, s.sim.world.height), body, client);
		const cursor = { pendingPlace: -1 };
		const entries = [];
		const snapRemote = s.remote("Snap");
		let nonce = 0;
		let now = 0;
		/** every self block the server sent this client since the last call, adopted in order (netClient's `reconcile`) */
		const drain = () => {
			const selves = [];
			for (const e of snapRemote.sent) {
				if (e.to !== pl) continue;
				const part = P2.decodeSnapshotPart(e.args[0]);
				if (part?.self !== undefined) selves.push(part.self);
			}
			snapRemote.sent.length = 0;
			for (const self of selves) {
				now += 0.05;
				pred.reconcile(self, [], now);
			}
			return selves;
		};
		/** the Bag's Use as client/net/backpackSync.ts makes it: predicted on the client's copy, then sent with a nonce */
		const use = id => {
			if (!BP.predictVerb(client, cursor, IK.UseItem, id, body)) return false;
			nonce += 1;
			entries.push({ kind: IK.UseItem, arg: id, nonce, seq: 0, at: now });
			s.verb(pl, IK.UseItem, id, 0, nonce);
			return true;
		};
		/** the server's time passes: its snapshots reach the client's survivor, then its last bag the client's backpack */
		const play = seconds => {
			const trail = [];
			for (let t = 0; t < seconds; t += 0.05) {
				s.run(0.05);
				for (const self of drain()) {
					trail.push({ hp: body.hp, hungry: body.hungry, speed: body.buffs.speed, flags: self.flags });
				}
			}
			const bag = SAVE2.readBag(s.lastBag(pl));
			if (bag !== undefined) BP.rebase(client, cursor, bag, entries, now);
			return trail;
		};
		play(0.4);
		check(
			Math.abs(body.hungry - 30) <= 1 && Math.abs(body.hp - 40) <= 1,
			"the client's bars are the server's body (the self block): 40 hp, 30 food",
			`${body.hp.toFixed(1)} hp / ${body.hungry.toFixed(1)} food`,
		);

		// 1. food
		const food0 = body.hungry;
		check(
			use(CAN) && client.invenUse[CAN] === 2 && body.hungry === food0,
			"Eat: one can fewer on the client at once, and the bar is NOT moved locally (the snapshot owns it)",
		);
		let trail = play(1);
		const fedAt = trail.findIndex(t => t.hungry >= food0 + 20);
		check(
			sp.state.hungry >= food0 + 20 && fedAt >= 0 && Math.abs(body.hungry - sp.state.hungry) <= 1.5,
			"[food] the SERVER's body ate the can, and the self block brought its hunger to the client's bar",
			`server ${sp.state.hungry.toFixed(1)}, client ${body.hungry.toFixed(1)} (from ${food0.toFixed(1)})`,
		);
		check(
			fedAt >= 0 && trail.slice(fedAt).every(t => t.hungry >= food0 + 19) && trail.length >= 10,
			"[food] and the bar stays up through every later snapshot: nothing reverts it",
			trail.map(t => t.hungry.toFixed(0)).join(" "),
		);
		check(
			save.invenUse[CAN] === 2 && client.invenUse[CAN] === 2 && entries.length === 0,
			"one can gone on each side, exactly once, and the server's bag retired the prediction",
			`server ${save.invenUse[CAN]}, client ${client.invenUse[CAN]}, pending ${entries.length}`,
		);

		// 2. hp
		const hp0 = body.hp;
		check(use(BANDAGE) && body.hp === hp0, "a Bandage: predicted as one fewer, the hp left to the snapshot");
		trail = play(1);
		const healedAt = trail.findIndex(t => t.hp >= hp0 + 19);
		check(
			healedAt >= 0 &&
				trail.slice(healedAt).every(t => t.hp >= hp0 + 19) &&
				Math.abs(body.hp - sp.state.hp) <= 0.5,
			"[hp] the server's body healed 20, the self block carries it, and no later snapshot takes it back",
			trail.map(t => t.hp.toFixed(0)).join(" "),
		);

		// 3. a buff: the flag travels, the client keeps its own timer running while it is set
		check(use(RUSH), `${USABLES[RUSH].name}: predicted`);
		trail = play(1);
		const onAt = trail.findIndex(t => (t.flags & P2.SelfFlag.Speed) !== 0);
		check(
			sp.state.buffs.speed > 0 &&
				onAt >= 0 &&
				trail.slice(onAt).every(t => (t.flags & P2.SelfFlag.Speed) !== 0 && t.speed > 0) &&
				body.buffs.speed > 0,
			`[buff] ${USABLES[RUSH].name} runs on the server; its flag is on the wire and the client's timer runs with it`,
			`server ${sp.state.buffs.speed.toFixed(1)} s, client ${body.buffs.speed.toFixed(2)}, flagged from snapshot ${onAt}`,
		);

		// 4. a full bar: refused on the client itself -- nothing predicted, sent or eaten on either side
		sp.state.hp = sp.state.hpMax;
		sp.state.hungry = sp.state.hungryMax;
		play(0.3);
		const cans = client.invenUse[CAN];
		const serverCans = save.invenUse[CAN];
		const sentBefore = nonce;
		check(
			!use(CAN) && nonce === sentBefore && client.invenUse[CAN] === cans,
			"[full] at full hp and food the Bag refuses the can on the client: nothing predicted, nothing sent",
			`client ${body.hp.toFixed(0)} hp / ${body.hungry.toFixed(0)} food`,
		);
		// ...and a verb that reaches a full server anyway (a client a snapshot behind) is refused there, and eats nothing
		const apples = save.invenUse[APPLE];
		sp.state.hungry = sp.state.hungryMax;
		nonce += 1;
		s.verb(pl, IK.UseItem, APPLE, 0, nonce);
		s.beat();
		play(0.4);
		check(
			save.invenUse[APPLE] === apples && save.invenUse[CAN] === serverCans && s.lastBag(pl)?.ack === nonce,
			"[full] the server refuses it too: no apple eaten, and its bag answers the verb all the same",
			`apples ${apples} -> ${save.invenUse[APPLE]}, ack ${s.lastBag(pl)?.ack}/${nonce}`,
		);

		// 5. a verb the server refuses rolls the client's prediction back
		save.invenUse[RUSH] = 0; // the server's copy has none left; the client, a bag behind, believes it has
		const believed = client.invenUse[RUSH];
		sp.state.buffs.speed = 0;
		check(
			believed > 0 && use(RUSH) && client.invenUse[RUSH] === believed - 1,
			"a Use the client believes in: predicted",
		);
		trail = play(0.5);
		check(
			client.invenUse[RUSH] === 0 && entries.length === 0 && sp.state.buffs.speed === 0,
			"[refused] the server had none: its bag rolls the client back to its count, and no buff started anywhere",
			`client ${client.invenUse[RUSH]}, server buff ${sp.state.buffs.speed}`,
		);
		s.quit(pl);
	},
);

section(
	"G7. the reviews of 5967a18, on the real server: a held build through death and New game, the refused spot, floods",
	() => {
		const s = Roblox.bootServer();
		const P2 = s.P;
		const IK = P2.IntentKind;
		const INV2 = require(join(SRC, "shared/sim/inventory.ts"));
		const W2 = require(join(SRC, "shared/game/world.ts"));
		const PLC2 = require(join(SRC, "shared/sim/placement.ts"));
		const RULE2 = require(join(SRC, "shared/sim/craftRule.ts"));
		const BP = require(join(SRC, "client/net/bagPrediction.ts"));
		const recipe = CRAFT_RECIPES.find(
			r =>
				r.craftKind === 1 &&
				RULE2.recipeStation(r) === undefined &&
				PLC2.PLACEABLES[r.resultIndex] !== undefined,
		);
		let seq = 0;
		let nonce = 0;
		const press = (pl, edges) => {
			seq += 1;
			const cmds = [];
			for (let k = 0; k < 3 && seq - k >= 1; k++) cmds.push(P2.makeCommand(seq - k, 0, 0, 0, 0, edges));
			s.remote("Input").OnServerEvent.Fire(pl, P2.encodeInput({ viewTick: 0, viewFrac: 0, cmds }));
		};
		const untilConsumed = (sp, want) => {
			for (let i = 0; i < 90 && sp.ackSeq < want; i++) s.beat();
			return sp.ackSeq >= want;
		};
		// a survivor who stays up, so a death does not end the world (MP-22)
		const friend = s.join(newUser(), "friend");
		s.immortal.add(friend);
		s.enter(friend);

		{
			// R1 (security review): a construction held through a death and a New game
			const pl = s.join(newUser(), "carrier");
			const save = s.save(pl);
			const cnt = () => recipe.ingredients.map(i => INV2.countItem(save, i.kind, i.index)).join(",");
			for (const ing of recipe.ingredients) INV2.addItem(save, ing.kind, ing.index, ing.count);
			s.immortal.add(pl);
			const sp = s.enter(pl);
			const paid = cnt();
			s.verb(pl, IK.Craft, recipe.id, 0, ++nonce);
			s.run(0.2);
			const held = s.sim.build.pendingOf(sp.slot) === recipe.resultIndex;
			const spent = cnt();
			s.immortal.delete(pl);
			s.kill(pl);
			check(
				held && spent !== paid && s.sim.build.pendingOf(sp.slot) === -1 && cnt() === paid,
				"[R1] a death with a construction on the cursor refunds it into the DYING run (the body keeps its backpack through a Rebirth)",
				`held ${held}; ingredients ${paid} -> ${spent} -> ${cnt()}`,
			);
			s.run(0.6);
			const fresh = s.shop(pl, { kind: "newRun", runRev: save.runRev });
			const newLife = cnt();
			s.exit(pl); // Home: sim.remove -> build.remove(slot, save), which used to refund into the NEW life
			s.run(1);
			s.quit(pl);
			const stored = s.stored(pl.UserId);
			const persisted = recipe.ingredients.map(i => INV2.countItem(stored, i.kind, i.index)).join(",");
			check(
				fresh.ok === true && cnt() === newLife && persisted === newLife,
				"[R1] ...and New game + Home refund nothing into the new life (nor into the DataStore)",
				`new life ${newLife}, after Home ${cnt()}, stored ${persisted}`,
			);
		}
		{
			// A (correctness review): a refused spot is ANSWERED by a bag at once, with the construction still held
			const pl = s.join(newUser(), "mason");
			s.immortal.add(pl);
			const save = s.save(pl);
			for (const ing of recipe.ingredients) INV2.addItem(save, ing.kind, ing.index, ing.count);
			const sp = s.enter(pl);
			press(pl, 0);
			untilConsumed(sp, seq);
			s.verb(pl, IK.Craft, recipe.id, seq + 1, ++nonce);
			press(pl, 0);
			untilConsumed(sp, seq);
			// a rock where the ghost is (the client's drawn zombie had moved; the server's had not)
			const ghost = s.sim.build.ghost(sp.slot, sp.state);
			W2.addSolid(s.sim.world, {
				...ghost,
				kind: "structure",
				hp: 1,
				hpMax: 1,
				destructible: false,
				tags: "rock",
			});
			s.run(0.5);
			const bagsBefore = s.remote("SaveAck").sent.filter(e => e.to === pl && e.args[0]?.wallet?.bag).length;
			press(pl, P2.packEdges(1, 0, 0, 0));
			const edge = seq;
			untilConsumed(sp, edge);
			s.run(0.5);
			const bags = s.remote("SaveAck").sent.filter(e => e.to === pl && e.args[0]?.wallet?.bag);
			const answer = bags[bags.length - 1]?.args[0].wallet.bag;
			check(
				bags.length > bagsBefore &&
					answer.place === recipe.resultIndex &&
					answer.seq >= edge &&
					s.sim.build.pendingOf(sp.slot) === recipe.resultIndex,
				"[A] the refused click is answered within 0.5 s: a bag past that command, the construction still on the cursor",
				`${bags.length - bagsBefore} new bag(s); place ${answer?.place}, seq ${answer?.seq} >= ${edge}`,
			);
			s.quit(pl);
		}
		{
			// R6 (security review): a pack bought on the death screen waits for a body, and survives the New game
			const { SHOP_PACKS: PACKS } = require(join(SRC, "shared/data/shop.ts"));
			const pack = PACKS[0];
			const pl = s.join(newUser(), "buyer");
			const save = s.save(pl);
			save.money = 100000;
			s.enter(pl);
			s.kill(pl);
			s.run(0.6);
			const bought = s.shop(pl, { kind: "buyPack", packId: pack.id });
			s.run(1);
			const whileDead = save.packsOpened[pack.id];
			s.run(0.6);
			s.shop(pl, { kind: "newRun", runRev: save.runRev });
			check(
				bought.ok === true && whileDead === 0 && save.packsBought[pack.id] - save.packsOpened[pack.id] === 1,
				"[R6] bought while dead: not delivered into the run the New game wipes -- still owed to the new life",
				`opened while dead ${whileDead}, pending after New game ${save.packsBought[pack.id] - save.packsOpened[pack.id]}`,
			);
			s.quit(pl);
		}
		{
			// R5 (security review): the presence verbs of a survivor in the world count toward the flood kick too
			const pl = s.join(newUser(), "presenceSpam");
			s.immortal.add(pl);
			s.enter(pl);
			for (let i = 0; i < 5000; i++) s.intent(pl, IK.EnterWorld);
			s.beat();
			check(pl.kicked === true, "[R5] 5000 EnterWorld from a survivor in the world: kicked (§8.2)");
		}
		{
			// the client's half (client/net/bagPrediction.ts, backpackSync.ts, main.client.ts), by the rule and by the source
			const save = SAVE.defaultSave();
			save.invenWeapon[10] = 1;
			const body = Ply.createPlayer(save, 0, 0);
			check(
				!BP.predictVerb(save, { pendingPlace: 10 }, IK.SwitchWeapon, 10, body) &&
					BP.predictVerb(save, { pendingPlace: -1 }, IK.SwitchWeapon, 10, body),
				"[E] a switch is not predicted with a construction on the cursor (the server says `busy`)",
			);
			body.dead = true;
			check(
				!BP.predictVerb(save, { pendingPlace: -1 }, IK.SwitchWeapon, 0, body),
				"[E] nor for a dead body (the server says `dead`)",
			);
			const sync = source("client/net/backpackSync.ts");
			check(
				/inFlight\(\) >= INTENT_QUEUE_MAX\) return false/.test(sync),
				"[C] the client never has more verbs in flight than the server queues (INTENT_QUEUE_MAX)",
			);
			check(
				/save !== bagSave \|\| save\.runRev !== bagRunRev/.test(sync),
				"[F] a replaced save, or a run that ended, drops the last bag and its predictions",
			);
			const main = source("client/main.client.ts");
			const onUse = main.slice(main.indexOf("pack.onUse = "), main.indexOf("pack.onCraft = "));
			check(
				/Bag\.useItem\(/.test(onUse) &&
					!/itemUseEffect/.test(main) &&
					/if \(owned\(\)\) return predictAndSend\(IntentKind\.UseItem/.test(sync),
				"[L] the Bag's Use goes through backpackSync (a server verb when owned), never the local itemUseEffect",
			);
			check(
				/SERVER_WORLD/.test(source("client/admin/world.ts")),
				"[K] the admin's item and structure spawns refuse while the server owns the world",
			);
		}
		s.quit(friend);
	},
);

section('G8. the pickup sound and the "Pick something up" lesson hear pickups, not a backpack that grew', () => {
	// client/systems/pickups.ts, fed as the client feeds it: the E press (interaction.ts), the server's world deltas
	// through the real mirror (worldMirror.ts), the server's bag growing bag to bag (backpackSync.ts)
	const PK = require(join(SRC, "client/systems/pickups.ts"));
	const Mirror = require(join(SRC, "client/net/worldMirror.ts"));
	const world = W.createWorld(4000, 4000);
	Mirror.forgetMirrorIndex();
	let id = 900;
	const drop = (x, y) => {
		id += 1;
		Mirror.applyMirrorEvent(world, {
			t: P.WorldEv.ItemAdd,
			id,
			kind: ItemKind.Etc,
			itemId: 23,
			count: 1,
			x,
			y,
			vx: 0,
			vy: 0,
		});
		return id;
	};
	const gone = itemId => Mirror.applyMirrorEvent(world, { t: P.WorldEv.ItemRemove, id: itemId });
	// a clock of this section's own (the server harness above installed its os.clock)
	const hadOs = globalThis.os;
	let t = 5000;
	globalThis.os = { ...hadOs, clock: () => t };
	const at = dt => (t += dt);
	const heard = fn => {
		const before = PK.pickupCount();
		fn();
		return PK.pickupCount() - before;
	};
	const cases = [
		[
			"my E on an item, the server takes it out of the world and my bag grows: one pickup",
			1,
			() => {
				const it = drop(1000, 1000);
				at(0.1);
				PK.pressed("item", 1010, 1000);
				at(0.15);
				gone(it);
				at(0.1);
				PK.bagGrew();
			},
		],
		[
			"...in the other order (the bag first, then the ItemRemove): one pickup",
			1,
			() => {
				const it = drop(1200, 1000);
				PK.pressed("item", 1200, 1010);
				at(0.2);
				PK.bagGrew();
				at(0.1);
				gone(it);
			},
		],
		[
			"a Chef's / Dwarf's double coming back, or a construction handed back: the bag grows, nothing left the world",
			0,
			() => {
				at(3);
				PK.bagGrew();
				PK.pressed("item", 1300, 1000);
				at(0.2);
				PK.bagGrew();
			},
		],
		[
			"a prediction undone grows only the predicted copy, which is never asked; with no press, a grown bag is nothing",
			0,
			() => {
				at(3);
				PK.bagGrew();
				gone(drop(1400, 1000));
			},
		],
		[
			"somebody else takes the item I pressed on: it leaves the world, my bag does not grow",
			0,
			() => {
				at(3);
				const it = drop(1500, 1000);
				PK.pressed("item", 1500, 1000);
				at(0.1);
				gone(it);
			},
		],
		[
			"an item that left the world far from where I pressed is not mine",
			0,
			() => {
				at(3);
				PK.pressed("item", 2000, 2000);
				gone(drop(1600, 1000));
				PK.bagGrew();
			},
		],
		[
			"an answer later than the window is not the press's",
			0,
			() => {
				at(3);
				const it = drop(1700, 1000);
				PK.pressed("item", 1700, 1000);
				at(2.5);
				gone(it);
				PK.bagGrew();
			},
		],
	];
	checkRows(
		"each case counts exactly what the server did for this survivor",
		cases.map(([name, want, fn]) => ({ name, want, fn })),
		c => {
			const n = heard(c.fn);
			return n === c.want ? true : `${c.name}: ${n} pickup(s), want ${c.want}`;
		},
	);
	// a search: the flag of the building I stand in goes down, and my bag grows
	const house = W.addSolid(world, { kind: "building", tags: "house", x: 100, y: 100, w: 400, h: 400 });
	house.id = 77;
	Mirror.forgetMirrorIndex();
	Mirror.applyMirrorEvent(world, { t: P.WorldEv.LootFlag, buildingId: 77, hasLoot: true });
	at(3);
	const searched = heard(() => {
		PK.pressed("loot", 300, 300);
		at(0.2);
		Mirror.applyMirrorEvent(world, { t: P.WorldEv.LootFlag, buildingId: 77, hasLoot: false });
		PK.bagGrew();
	});
	check(searched === 1, "a search: the building's flag goes down and my bag grows, one pickup", `${searched}`);
	globalThis.os = hadOs;
	// offline the game's own interaction takes it
	check(heard(() => PK.took()) === 1, "offline (no MP host) the client's own pickup and search count directly");
	// the readers and the feeders, by their source
	const audioSrc = source("client/audio/gameAudio.ts");
	const lesson = source("client/onboarding/objectives.ts");
	const inter = source("client/systems/interaction.ts");
	const sync = source("client/net/backpackSync.ts");
	check(
		/if \(pickups > this\.prevPickups\) audio\.play\("pickupItem"\)/.test(audioSrc) &&
			!/inventoryCount/.test(audioSrc) &&
			/return pickupCount\(\) > mem\.items;/.test(lesson) &&
			!/totalItems/.test(lesson),
		"the pickup sound and the lesson read the pickup count, not the backpack's size",
	);
	check(
		/if \(target\.kind === "item"\) pressed\("item", by\.x, by\.y\)/.test(inter) &&
			/takeItem\(refs, target\.item\);\s*took\(\);/.test(inter) &&
			/bagTotal\(bag\) > bagTotal\(lastBag\)/.test(sync),
		"fed by the E press, the offline pickup and the server's bag against its last one (never the predicted copy)",
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
