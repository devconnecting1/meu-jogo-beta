#!/usr/bin/env node
/*
 * Electricity and automated defence, on the SERVER (docs/DESIGN_RULES.md §10A ELE-01..ELE-09).
 *
 *   npm run test:power
 *   node tools/test-power.mjs --verbose
 *   PZ_SRC=path/to/src node tools/test-power.mjs
 *
 * The owner asked (2026-09-23): "Faz todos os itens, equipamentos, consumíveis, receitas e skills funcionarem e que
 * faça sentido". The QA sweep (test:items P1, W2, K1) found twelve builds that did nothing once placed, a stun gun
 * nothing could charge and two skills nothing read. This suite measures what each of them does now, through the
 * REAL modules — server/sim/{power,turrets,combat,interaction,simulation}.ts — never through a copy:
 *
 *   A. the grid       a machine plugs into the nearest box within 300 u; generators fill it (the sun by day, rain
 *                     halves it, the reactor always, the oil engine while it has fuel and its box has room);
 *                     consumers draw from it and go dark when it is empty; Engineering ×1.5 / ×1.2;
 *   B. E on machines  through the server's E (encoded input → interaction): a switch, a refuel, the stun gun charged
 *                     at a box — and then FIRED by the server's weapon machine, which spends that charge;
 *   C. drones         a pad launches its drone with E; it escorts its survivor on the shared orbit, drinks its own
 *                     battery, lights the night for the horde (the lamp drone), and comes home empty, recalled, or
 *                     when its survivor leaves; the pad refills it from the grid; Robotics ×1.5 battery;
 *   D. turrets        a fed turret kills a zombie ON THE SERVER, pays its builder the XP (not the kill count), pays
 *                     for its shots, stops at walls, never targets or hurts a survivor; the electric turret holds
 *                     what it shocks and jumps twice; the turret drone fires from its orbit; Robotics ×1.5 damage;
 *   E. the cost       ten turrets and a full horde: the searches per tick are bounded and staggered;
 *   F. stations       a working cooker is cooking heat (the cooking rule's other half), a cold one is not;
 *   G. the wire       only what changed is published, with the level of each store;
 *   H. end to end     crafted with the backpack verb, placed by the server's build, and it shoots;
 *   I. the drawing    (client/view/machinesView.ts) every grid is well formed and its flat runs repaint it; working
 *                     and dead look different; a turret turns to its shot; a lamp drone lights where the server's
 *                     orbit puts it; cables and the beacon's arrow; 600 frames without an Instance, flat and with art.
 *
 * Pure Node (>= 18) + the project's TypeScript, on tools/luau-shim.mjs (and tools/fake-gui.mjs for section I).
 */
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { installShims, setSeed } from "./luau-shim.mjs";
import { installFakeGui } from "./fake-gui.mjs";

const VERBOSE = process.argv.includes("--verbose");
const { SRC, require } = installShims({ seed: 1 });

const W = require(join(SRC, "shared/game/world.ts"));
const SAVE = require(join(SRC, "shared/game/save.ts"));
const P = require(join(SRC, "shared/net/protocol.ts"));
const CFG = require(join(SRC, "shared/net/mpConfig.ts"));
const PL = require(join(SRC, "server/sim/players.ts"));
const POW = require(join(SRC, "shared/data/power.ts"));
const { ServerPower } = require(join(SRC, "server/sim/power.ts"));
const { ServerTurrets, SEARCH_BUDGET, SEARCH_EVERY } = require(join(SRC, "server/sim/turrets.ts"));
const { ServerCombat } = require(join(SRC, "server/sim/combat.ts"));
const { Progress } = require(join(SRC, "server/sim/progress.ts"));
const { ServerSimulation } = require(join(SRC, "server/sim/simulation.ts"));
const { WorldClock } = require(join(SRC, "server/sim/waves.ts"));
const { PLACEABLES, placedSolid } = require(join(SRC, "shared/sim/placement.ts"));
const { createZombie } = require(join(SRC, "shared/game/entities.ts"));
const { isLight } = require(join(SRC, "shared/sim/interactQuery.ts"));
const CR = require(join(SRC, "shared/sim/craftRule.ts"));
const { CRAFT_RECIPES } = require(join(SRC, "shared/data/crafts.ts"));
const Brain = require(join(SRC, "shared/sim/ai/zombieBrain.ts"));

const TICK_DT = 1 / CFG.SIM_HZ;
const SLOT_NONE = CFG.SLOT_NONE;

// ---------------------------------------------------------------- reporting

let failures = 0;
let checks = 0;
function check(ok, what, detail) {
	checks += 1;
	const tail = detail === undefined ? "" : `  (${detail})`;
	if (ok) {
		if (VERBOSE) console.log(`  ok    ${what}${tail}`);
		else console.log(`  ok    ${what}`);
	} else {
		failures += 1;
		console.log(`  FAIL  ${what}${tail}`);
	}
	return ok;
}
function near(a, b, tol) {
	return Math.abs(a - b) <= tol;
}
function checkNear(got, want, tol, what) {
	return check(near(got, want, tol), what, `expected ${want} ± ${tol}, got ${Math.round(got * 1000) / 1000}`);
}
function section(title, fn) {
	console.log(`\n${title}`);
	try {
		fn();
	} catch (e) {
		failures += 1;
		console.log(`  FAIL  the section threw: ${e?.stack?.split("\n").slice(0, 5).join(" | ") ?? e}`);
	}
}

// ---------------------------------------------------------------- fixtures

/** PLACEABLES ids of the machines */
const ID = {
	turret: 2,
	turretDrone: 3,
	lamp: 4,
	lampDrone: 5,
	battery: 6,
	solar: 7,
	reactor: 8,
	oil: 9,
	shock: 16,
	beacon: 18,
	cooker: 19,
};

/** a bare save (everything at 0) with the given skills */
function saveWith(skills = {}) {
	const s = SAVE.defaultSave();
	for (const [id, lv] of Object.entries(skills)) s.skillLevels[Number(id)] = lv;
	return s;
}

/**
 * A server world with the grid alone (no simulation): the tests below drive `settle` by hand. The world's hooks feed
 * the grid, as server/sim/build.ts does in the real simulation.
 */
function gridFixture(opts = {}) {
	const world = W.serverWorld(W.createWorld(6000, 6000));
	const clock = { dayTime: opts.dayTime ?? 12, isRaining: opts.rain ?? false, darkAlpha: 0 };
	const saves = new Map();
	const bodies = new Map();
	const published = [];
	const power = new ServerPower({
		world,
		clock,
		saveOf: slot => saves.get(slot),
		bodyOf: slot => bodies.get(slot),
		publish: (s, state, pilot) => published.push({ id: s.id, state, pilot }),
	});
	world.onSolidAdd = (w, s) => power.note(s, true);
	world.onSolidRemove = (w, s) => power.note(s, false);
	return {
		world,
		clock,
		saves,
		bodies,
		published,
		power,
		/** places PLACEABLES `id` with its top-left at (x, y), built by `owner` */
		place(id, x, y, owner = SLOT_NONE) {
			const def = PLACEABLES[id];
			return W.addSolid(world, { ...placedSolid(def, { x, y, w: def.w, h: def.h }, 0), placeable: id, owner });
		},
		st(s) {
			return power.stateOf(s);
		},
		/** settles `seconds` in POWER_STEP_S steps, the way the tick does */
		run(seconds) {
			const n = Math.round(seconds / POW.POWER_STEP_S);
			for (let i = 0; i < n; i++) power.settle(POW.POWER_STEP_S);
		},
	};
}

/** the full server simulation with the interactive world AND the horde (as F3 will run it) */
function simFixture(opts = {}) {
	setSeed(opts.seed ?? 7);
	const world = W.serverWorld(W.createWorld(8000, 8000));
	const clock = new WorldClock({ day: 1, dayTime: opts.dayTime ?? 12, rollRain: () => false });
	const sim = new ServerSimulation({ world, clock, zombies: true, interactive: true });
	const fx = [];
	sim.onFx = e => fx.push(e);
	return {
		world,
		clock,
		sim,
		fx,
		player(slot, x, y, save) {
			const sp = PL.createServerPlayer(
				{ slot, userId: 900 + slot, name: `p${slot}` },
				save ?? saveWith(),
				x,
				y,
				sim.tick,
				sim.simHz,
			);
			sim.add(sp);
			sp.state.x = x;
			sp.state.y = y;
			// a survivor who never eats would starve in a long measurement
			sp.state.hungry = sp.state.hungryMax;
			return sp;
		},
		place(id, x, y, owner = SLOT_NONE) {
			const def = PLACEABLES[id];
			return W.addSolid(world, { ...placedSolid(def, { x, y, w: def.w, h: def.h }, 0), placeable: id, owner });
		},
		zombie(x, y, hp = 100) {
			const z = createZombie(1, x, y, 1);
			z.hp = hp;
			z.hpMax = hp;
			sim.horde.zombies.push(z);
			return z;
		},
		/**
		 * One E press from `sp`, through the real wire. Unless `now`, it waits out the §8.1 cooldowns first (one press
		 * per survivor per PRESS_COOLDOWN_S, one change per machine per TOGGLE_COOLDOWN_S), as a finger would.
		 */
		pressE(sp, now = false) {
			const ix = sim.interaction;
			const cooling = () => ix.pressCd.size() > 0 || ix.toggleCd.size() > 0;
			for (let i = 0; !now && i < CFG.SIM_HZ && cooling(); i++) {
				sim.step();
			}
			const cmd = P.makeCommand(sim.tick + 1, 0, 0, 0, 0, P.packEdges(0, 0, 1, 0));
			PL.ingestInput(sp, P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [cmd] }), 0);
			let out;
			sim.onInteract = (who, o) => {
				if (who === sp) out = o;
			};
			sim.step();
			sim.onInteract = undefined;
			return out;
		},
		run(seconds, each) {
			const n = Math.round(seconds * CFG.SIM_HZ);
			for (let i = 0; i < n; i++) {
				for (const sp of sim.players()) sp.state.hungry = sp.state.hungryMax;
				sim.step();
				if (each !== undefined && each(i) === true) return i;
			}
			return n;
		},
	};
}

// ================================================================ A. the grid

section("A1. every machine is a build, and every electric build is a machine", () => {
	for (const [name, id] of Object.entries(ID)) {
		const def = PLACEABLES[id];
		check(POW.MACHINES[def.tag] !== undefined, `${name} (PLACEABLES ${id}, "${def.tag}") is a machine of the grid`);
	}
	check(isLight({ tags: "lamp_drone" }), "the lamp drone is a light (isLight): E switches it");
	check(
		POW.POWER_LINK_RANGE === 300,
		"the link range is the original's line_length (300 u, ~5.5 m)",
		`${POW.POWER_LINK_RANGE}`,
	);
});

section("A2. a machine plugs into the NEAREST battery box within 300 u, and only there", () => {
	const g = gridFixture();
	const far = g.place(ID.battery, 1000, 1000);
	const nearBox = g.place(ID.battery, 1500, 1000);
	const lamp = g.place(ID.lamp, 1700, 1000);
	const lonely = g.place(ID.lamp, 3000, 3000);
	g.run(0.25);
	check(g.st(lamp).link?.solid === nearBox, "the lamp is plugged into the box 200 u away, not the one 700 u away");
	check(g.st(lonely).link === undefined, "a lamp 300+ u from every box is plugged into nothing");
	// the near box goes: the lamp falls back to nothing (the far one is out of range)
	W.removeSolid(g.world, nearBox);
	g.run(0.25);
	check(g.st(lamp).link === undefined, "its box destroyed, the lamp is unplugged (the far box is 700 u away)");
	void far;
});

section("A3. generators: the sun by day (half in the rain), the reactor always, Engineering ×1.5", () => {
	const measure = (id, opts, skills) => {
		const g = gridFixture(opts);
		g.saves.set(0, saveWith(skills));
		const box = g.place(ID.battery, 1000, 1000);
		g.place(id, 1100, 1000, skills !== undefined ? 0 : SLOT_NONE);
		g.st(box).store = 0;
		g.run(10);
		return g.st(box).store / 10;
	};
	checkNear(
		measure(ID.solar, { dayTime: 12 }),
		POW.GENERATOR_OUTPUT,
		0.01,
		"a solar generator at noon: 6 charge a second",
	);
	checkNear(measure(ID.solar, { dayTime: 23 }), 0, 0.001, "at 23:00: nothing");
	checkNear(measure(ID.solar, { dayTime: 12, rain: true }), 3, 0.01, "at noon in the rain: half (3/s)");
	checkNear(measure(ID.reactor, { dayTime: 23 }), 6, 0.01, "the nuclear reactor at 23:00: 6/s, always");
	checkNear(
		measure(ID.reactor, { dayTime: 12 }, { [POW.SKILL_ENGINEERING]: 1 }),
		9,
		0.01,
		"Engineering (its maker's): the reactor makes 9/s (×1.5, obj_generator: +electric_generate/2 a level)",
	);
	const g = gridFixture();
	g.saves.set(0, saveWith({ [POW.SKILL_ENGINEERING]: 1 }));
	const box = g.place(ID.battery, 1000, 1000, 0);
	const plain = g.place(ID.battery, 3000, 3000);
	check(
		g.st(box).store === 1200 && g.st(plain).store === 1000,
		"a box holds 1000, 1200 built with Engineering (obj_bettery ×1.2)",
		`${g.st(box).store} / ${g.st(plain).store}`,
	);
	check(g.st(plain).store === POW.BATTERY_CAPACITY, "and a new box comes charged (five charged cells)");
});

section(
	"A4. the oil generator: burns 3 oil-units a second while its box has room, starts below 95 %, refuels with E",
	() => {
		const g = gridFixture();
		const box = g.place(ID.battery, 1000, 1000);
		const gen = g.place(ID.oil, 1100, 1000);
		const bs = g.st(box);
		const gs = g.st(gen);
		check(gs.store === POW.OIL_TANK, "it comes with a full tank (obj_generator_oil: oil = 1000)");
		g.run(2);
		check(
			gs.store === POW.OIL_TANK && !gs.working,
			"a FULL box: the engine stays off and burns nothing",
			`tank ${gs.store}`,
		);
		bs.store = 500;
		g.run(10);
		checkNear(POW.OIL_TANK - gs.store, 30, 0.01, "half-empty box: 10 s burn 30 of tank (0.1 a frame)");
		checkNear(bs.store, 560, 0.01, "…and pour 60 of charge into the box (6/s)");
		check(gs.working, "and it is running (the Working bit)");
		// run until full: it stops by itself, and only restarts under 95 %
		g.run(80);
		check(!gs.working && bs.store === POW.BATTERY_CAPACITY, "a full box stops it", `box ${bs.store}`);
		bs.store = 960;
		g.run(1);
		check(!gs.working, "at 96 % it stays off (auto-start below 95 %: no flicker at the top)");
		bs.store = 940;
		g.run(0.25);
		check(gs.working, "at 94 % it starts again");
		gs.store = 0;
		g.run(1);
		check(!gs.working, "an empty tank: it stops");
	},
);

section("A5. consumers draw from their box and go dark when it is empty (and come back only with some margin)", () => {
	const g = gridFixture();
	const box = g.place(ID.battery, 1000, 1000);
	const lamp = g.place(ID.lamp, 1100, 1000);
	const cooker = g.place(ID.cooker, 1000, 1100);
	const beacon = g.place(ID.beacon, 900, 1000);
	const turret = g.place(ID.turret, 1000, 900);
	const bs = g.st(box);
	g.run(1);
	checkNear(
		POW.BATTERY_CAPACITY - bs.store,
		POW.TURRET_STANDBY,
		0.01,
		"switched off: the lamp, beacon and cooker draw nothing; the armed turret idles at 1/s",
	);
	check(!lamp.powered && !cooker.powered && !beacon.powered, "…and none of the three is working");
	check(turret.powered === true, "the turret is armed as soon as it has power (no switch)");
	for (const s of [lamp, cooker, beacon]) g.st(s).on = true;
	bs.store = 1000;
	g.run(10);
	checkNear(
		1000 - bs.store,
		10 * (POW.LAMP_DRAW + POW.COOKER_DRAW + POW.BEACON_DRAW + POW.TURRET_STANDBY),
		0.01,
		"switched on: lamp 1 + cooker 2 + beacon 1 + turret 1 = 5 a second",
	);
	check(lamp.powered && cooker.powered && beacon.powered, "…and all of them are working (Solid.powered)");
	bs.store = 1;
	g.run(0.5);
	check(!lamp.powered && !cooker.powered && !turret.powered, "the box empty: everything goes dark");
	bs.store = 3;
	g.run(0.25);
	check(
		!lamp.powered,
		"3 of charge is not enough to come back (POWER_RESTART_MIN 5): no flicker at the edge of empty",
	);
	bs.store = 50;
	g.run(0.25);
	check(lamp.powered && turret.powered, "with 50 it comes back");
});

// ================================================================ B. E on machines, through the server's E

section("B1. E on a lamp, a beacon, a cooker: a switch; on without power it stays dark", () => {
	const f = simFixture();
	const sp = f.player(0, 2000, 2000);
	const lamp = f.place(ID.lamp, 2020, 1976);
	const out = f.pressE(sp);
	check(
		out?.kind === "machine" && out.machine.kind === "switched" && out.machine.on === true,
		"E on a lamp: switched on",
		JSON.stringify(out?.machine ?? out),
	);
	check(lamp.powered !== true, "…but with no battery box in range it stays dark (P3: an electric lamp)");
	const box = f.place(ID.battery, 2150, 1980);
	f.run(0.5);
	check(lamp.powered === true, "a battery box placed 130 u away: it lights");
	f.pressE(sp);
	check(lamp.powered !== true, "E again: off, at once");
	// §8.1: a machine changes at most once per TOGGLE_COOLDOWN_S, whoever presses (a switch is a reliable PowerSet
	// to every client), and each survivor's E has its PRESS_COOLDOWN_S -- the door's and the lamp's rule
	const sp2 = f.player(1, 2000, 2010);
	const first = f.pressE(sp);
	const rushed = f.pressE(sp2, true);
	const later = f.pressE(sp2);
	check(
		first?.machine?.kind === "switched" &&
			rushed?.kind === "refused" &&
			rushed.why === "cooldown" &&
			later?.machine?.kind === "switched",
		"a second press on the same machine in the next tick is refused (cooldown), and heard once it has passed",
		`${first?.machine?.kind}, ${JSON.stringify(rushed)}, ${later?.machine?.kind}`,
	);
	void box;
});

section("B1b. the achievements the grid earns: Thomas Edison (a lamp lit on the grid) and Turret (CON-04)", () => {
	const { AchievementId } = require(join(SRC, "shared/data/achievements.ts"));
	const f = simFixture();
	const save = saveWith();
	const sp = f.player(0, 2000, 2000, save);
	const lamp = f.place(ID.lamp, 2020, 1976);
	f.pressE(sp);
	check(
		(save.achievements[AchievementId.ThomasEdison] ?? 0) === 0,
		"a lamp switched on with no power stays dark: no Thomas Edison",
	);
	f.pressE(sp);
	f.place(ID.battery, 2150, 1980);
	f.run(0.5);
	f.pressE(sp);
	check(
		lamp.powered === true && save.achievements[AchievementId.ThomasEdison] === 1,
		"switched on and lit by a battery box: Thomas Edison",
		`lamp ${lamp.powered}, ${save.achievements[AchievementId.ThomasEdison]}`,
	);
	// the Turret: a zombie a turret this survivor built brings down -- and no kill counter moves (MON-05)
	const turret = f.place(ID.turret, 2600, 2000, 0);
	f.place(ID.battery, 2750, 2000);
	f.run(0.5);
	const kills0 = save.zombieKills;
	const slayer0 = save.achievements[AchievementId.ZombieSlayer] ?? 0;
	const z = f.zombie(2630, 2230, 60);
	z.test = true;
	for (let i = 0; i < 200 && z.hp > 0; i++) f.sim.step();
	check(
		z.hp <= 0 &&
			save.achievements[AchievementId.Turret] === 1 &&
			save.zombieKills === kills0 &&
			(save.achievements[AchievementId.ZombieSlayer] ?? 0) === slayer0,
		"its turret brings a zombie down: Turret, and neither the kill count nor Zombie slayer moves",
		`hp ${z.hp}, turret ${save.achievements[AchievementId.Turret]}, kills ${save.zombieKills}`,
	);
	void turret;
});

section("B2. the oil generator refuels with E: 5 oil for 100 of tank; no oil, refused", () => {
	const f = simFixture();
	const save = saveWith();
	save.oil = 7;
	const sp = f.player(0, 2000, 2000, save);
	const gen = f.place(ID.oil, 2020, 1970);
	f.sim.power.stateOf(gen).store = 500;
	const out = f.pressE(sp);
	check(
		out?.machine?.kind === "refueled",
		"E with oil in the backpack: refuelled",
		JSON.stringify(out?.machine ?? out),
	);
	check(
		save.oil === 2 && f.sim.power.stateOf(gen).store === 600,
		"5 oil out of the backpack, +100 in the tank",
		`oil ${save.oil}, tank ${f.sim.power.stateOf(gen).store}`,
	);
	const again = f.pressE(sp);
	check(
		again?.machine?.kind === "refused" && again.machine.why === "material",
		"2 oil left: refused, nothing taken",
		JSON.stringify(again?.machine ?? again),
	);
	check(save.oil === 2, "and the 2 are still there");
});

section("B3. the stun gun: charged at a battery box with E (100 a press), then FIRED by the server (W2)", () => {
	const f = simFixture();
	const save = saveWith();
	save.invenWeapon[POW.STUN_GUN_ID] = 1;
	save.equipWeapon = POW.STUN_GUN_ID;
	save.electric = 0;
	const sp = f.player(0, 2000, 2000, save);
	const box = f.place(ID.battery, 2020, 1976);
	const out = f.pressE(sp);
	check(
		out?.machine?.kind === "charged" && out.machine.amount === 100,
		"E at the box, owning a stun gun: charged 100",
		JSON.stringify(out?.machine ?? out),
	);
	check(
		save.electric === 100 && f.sim.power.stateOf(box).store === 900,
		"the charge moved: the gun 0 → 100, the box 1000 → 900",
		`gun ${save.electric}, box ${f.sim.power.stateOf(box).store}`,
	);
	// now it fires: a zombie 200 u ahead (held still), the trigger held, through the server's weapon machine; 0.1 a
	// shot is paid in whole units, so 4 s (12 shots) spend one
	const z = f.zombie(2200, 2000, 1e6);
	z.stunned = 1e6;
	let seq = f.sim.tick + 1;
	const aim = Math.atan2(z.y - sp.state.y, z.x - sp.state.x);
	for (let i = 0; i < 240; i++) {
		const cmd = P.makeCommand(seq++, 0, 0, aim, P.HeldBit.Attack, i === 0 ? P.packEdges(1, 0, 0, 0) : 0);
		PL.ingestInput(sp, P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [cmd] }), 0);
		f.sim.step();
	}
	check(z.hp < 1e6, "the charged stun gun shocks the zombie (server combat)", `hp lost ${1e6 - z.hp}`);
	check(save.electric < 100, "and spends the charge it was given", `charge ${save.electric}`);
	// without a stun gun, E at the box does its ordinary job: nothing to repair here, so nothing happens
	const other = saveWith();
	const sp2 = f.player(1, 3000, 3000, other);
	f.place(ID.battery, 3020, 2976);
	const none = f.pressE(sp2);
	check(
		none?.kind !== "machine",
		"no stun gun in the backpack: E at a box does not pretend to charge anything",
		JSON.stringify(none),
	);
});

// ================================================================ C. drones

section("C1. the lamp drone: E launches it, it escorts its survivor on the shared orbit and lights the night", () => {
	const f = simFixture({ dayTime: 0 });
	const sp = f.player(0, 3000, 3000);
	const pad = f.place(ID.lampDrone, 3024, 2980, 0);
	const st = f.sim.power.stateOf(pad);
	check(st.store === POW.DRONE_BATTERY, "a new drone comes charged (400)");
	const out = f.pressE(sp);
	check(
		out?.machine?.kind === "launched" && st.pilot === 0,
		"E at its pad: launched, escorting slot 0",
		JSON.stringify(out?.machine ?? out),
	);
	// the survivor walks away; the drone keeps to its orbit around them
	sp.state.x = 4000;
	sp.state.y = 3500;
	f.run(1);
	const at = f.sim.power.positionOf(st, { x: 0, y: 0 });
	const off = POW.droneOffset(pad.id, true, f.sim.tick / f.sim.simHz, { x: 0, y: 0 });
	check(
		near(at.x, 4000 + off.x, 0.01) && near(at.y, 3500 + off.y, 0.01),
		"it is where droneOffset says, beside its survivor (the client computes the same)",
		`${at.x.toFixed(1)},${at.y.toFixed(1)}`,
	);
	checkNear(Math.hypot(at.x - 4000, at.y - 3500), POW.LAMP_DRONE_ORBIT, 0.01, "at the lamp drone's orbit (180 u)");
	check(pad.powered !== true, "its pad does not light anything (the drone does)");
	check(f.sim.power.lights.length === 1, "it carries one light");
	// the horde sees by it at midnight: a spot 330 u from the survivor on the drone's side is lit
	const lx = at.x + ((at.x - 4000) / POW.LAMP_DRONE_ORBIT) * 150;
	const ly = at.y + ((at.y - 3500) / POW.LAMP_DRONE_ORBIT) * 150;
	check(
		Brain.spawnAlpha(f.sim.horde.refs, lx, ly) === 1,
		"at midnight a zombie 330 u out on the drone's side is lit (horde's visibility, MP-07)",
	);
	const dark = Brain.spawnAlpha(
		f.sim.horde.refs,
		4000 - ((at.x - 4000) / POW.LAMP_DRONE_ORBIT) * 340,
		3500 - ((at.y - 3500) / POW.LAMP_DRONE_ORBIT) * 340,
	);
	check(dark === 0, "…and one 340 u out on the other side is not");
	const before = st.store;
	f.run(10);
	checkNear(before - st.store, 10 * POW.DRONE_FLIGHT_DRAW, 0.3, "flying costs its battery 1 a second");
});

section("C2. drones come home: recalled with E, when their survivor leaves, or empty; the pad refills them", () => {
	const f = simFixture({ dayTime: 0 });
	const sp = f.player(0, 3000, 3000);
	const pad = f.place(ID.turretDrone, 3024, 2980, 0);
	const box = f.place(ID.battery, 3200, 2980);
	const st = f.sim.power.stateOf(pad);
	f.pressE(sp);
	check(st.pilot === 0, "launched");
	const out = f.pressE(sp);
	check(
		out?.machine?.kind === "recalled" && st.pilot === SLOT_NONE,
		"E at its pad again: called back",
		JSON.stringify(out?.machine ?? out),
	);
	st.store = 100;
	f.run(5);
	checkNear(st.store, 150, 1, "on its pad it drinks 10 a second from the box");
	checkNear(f.sim.power.stateOf(box).store, 950, 1, "…which the box pays");
	st.store = 10;
	const low = f.pressE(sp);
	check(
		low?.machine?.kind === "refused" && low.machine.why === "charging",
		"under 10 % it will not take off",
		JSON.stringify(low?.machine ?? low),
	);
	st.store = 300;
	f.pressE(sp);
	f.sim.remove(0);
	f.run(0.5);
	check(st.pilot === SLOT_NONE, "its survivor left the world: it flew home");
	const sp2 = f.player(1, 3000, 3000);
	f.pressE(sp2);
	check(st.pilot === 1, "anyone can take it out (co-op)");
	st.store = 1;
	f.run(2);
	check(st.pilot === SLOT_NONE, "its battery ran out: it came home");
});

section("C3. at most three drones escort one survivor (LEG-03); Robotics gives the drones 1.5× battery", () => {
	const f = simFixture({ dayTime: 0 });
	const save = saveWith({ [POW.SKILL_ROBOTICS]: 1 });
	const sp = f.player(0, 3000, 3000, save);
	const pads = [];
	for (let i = 0; i < 4; i++) pads.push(f.place(ID.lampDrone, 3000 + i * 400, 3200, 0));
	check(f.sim.power.stateOf(pads[0]).store === 600, "built by a roboticist: 600 of battery (×1.5)");
	const outcomes = [];
	for (const pad of pads) {
		sp.state.x = pad.x + 24;
		sp.state.y = pad.y - 22;
		outcomes.push(f.pressE(sp)?.machine?.kind);
	}
	check(outcomes.join(",") === "launched,launched,launched,refused", "the fourth is refused", outcomes.join(","));
});

// ================================================================ D. turrets

section("D1. a fed turret kills a zombie ON THE SERVER, pays its builder the XP — not the kill count", () => {
	const f = simFixture();
	const save = saveWith();
	const builder = f.player(0, 2000, 2400, save);
	const turret = f.place(ID.turret, 2000, 2000, 0);
	f.place(ID.battery, 2150, 2000);
	f.run(0.5);
	check(turret.powered === true, "plugged into a charged box: armed");
	const z = f.zombie(2032 + 250, 2032, 100);
	const exp0 = save.exp;
	const kills0 = save.zombieKills;
	const tracer = f.fx.length;
	f.run(6, () => z.hp <= 0);
	check(z.hp <= 0, "the walker 250 u away is dead", `hp ${z.hp}`);
	check(
		save.exp - exp0 === z.exp,
		"its builder got the walker's XP (§3.6: the builder, 100 %)",
		`+${save.exp - exp0} of ${z.exp}`,
	);
	check(save.zombieKills === kills0, "…but it is not a zombie THEY put down (MON-05, the scoreboard)");
	const shots = f.fx.slice(tracer).filter(e => e.t === P.FxType.Tracer && e.kind === 1);
	check(shots.length >= 1, "each shot is a tracer on the Fx channel", `${shots.length}`);
	const first = shots[0];
	check(
		first !== undefined && Math.hypot(first.x1 - 2032, first.y1 - 2032) <= POW.TURRET_MUZZLE + 0.01,
		"…drawn from the turret's muzzle",
	);
	void builder;
});

section("D2. no power, no shot; each shot costs 2 and standing armed 1 a second", () => {
	const f = simFixture();
	f.player(0, 2000, 2400);
	const turret = f.place(ID.turret, 2000, 2000, 0);
	const z = f.zombie(2032 + 200, 2032, 1e6);
	f.run(3);
	check(turret.powered !== true && z.hp === 1e6, "no battery box: the turret is dark and does not fire");
	const box = f.place(ID.battery, 2150, 2000);
	const bs = f.sim.power.stateOf(box);
	f.run(0.5);
	const before = bs.store;
	const shots0 = f.sim.turrets.stats.shots;
	f.run(4);
	const shots = f.sim.turrets.stats.shots - shots0;
	check(shots >= 5, "with power it fires every 2/3 s", `${shots} shots in 4 s`);
	checkNear(
		before - bs.store,
		4 * POW.TURRET_STANDBY + shots * POW.TURRET_SHOT_COST,
		1.01,
		"the box paid 1/s standing + 2 a shot",
	);
});

section("D3. a turret never targets a survivor, never hurts one in its line, and stops at walls (MP-01)", () => {
	const f = simFixture();
	const a = f.player(0, 2200, 2032);
	const b = f.player(1, 2032, 2150);
	f.place(ID.turret, 2000, 2000, 0);
	f.place(ID.battery, 1850, 2000);
	f.run(3);
	check(
		f.sim.turrets.stats.shots === 0,
		"two survivors inside its range and no zombie: it never fires",
		`${f.sim.turrets.stats.shots} shots`,
	);
	// a zombie behind survivor A, in the same line: the bullet passes through A (not in the trace at all)
	const hpA = a.state.hp;
	const z = f.zombie(2290, 2032, 1e6);
	// held still, so what could hurt the survivor is the turret alone
	z.stunned = 1e6;
	f.run(3);
	check(z.hp < 1e6, "the zombie behind the survivor is hit");
	check(a.state.hp === hpA, "and the survivor it flew past lost nothing", `${hpA} → ${a.state.hp}`);
	void b;
	// a wall between the turret and a zombie: no shot
	const g = simFixture();
	g.player(0, 1000, 1400);
	g.place(ID.turret, 1000, 1000, 0);
	g.place(ID.battery, 850, 1000);
	W.addSolid(g.world, {
		kind: "wall_v",
		x: 1120,
		y: 900,
		w: 16,
		h: 300,
		hp: 1e9,
		hpMax: 1e9,
		destructible: false,
		tags: "bwall",
	});
	const hidden = g.zombie(1250, 1032, 1e6);
	g.run(3);
	check(
		hidden.hp === 1e6 && g.sim.turrets.stats.shots === 0,
		"a zombie behind a wall: never shot",
		`${g.sim.turrets.stats.shots} shots`,
	);
});

section("D4. the electric turret shocks the nearest zombie, holds it and jumps to two more", () => {
	const f = simFixture();
	f.player(0, 2000, 2600);
	f.place(ID.shock, 2000, 2000, 0);
	f.place(ID.battery, 2150, 2000);
	f.run(0.5);
	const z1 = f.zombie(2032 + 150, 2032, 1e6);
	const z2 = f.zombie(2032 + 230, 2032, 1e6);
	const z3 = f.zombie(2032 + 300, 2032, 1e6);
	const zFar = f.zombie(2032 + 450, 2032, 1e6);
	f.run(1, () => z1.hp < 1e6);
	check(z1.hp < 1e6, "the nearest (150 u) is shocked");
	check(z1.stunned > 0, "and held (stunned)", `${z1.stunned}`);
	check(z2.hp < 1e6 && z3.hp < 1e6, "the arc jumped to the next two (80 u and 70 u further)");
	check(zFar.hp === 1e6, "…and no further (a third jump would be too far and too many)");
	const arcs = f.fx.filter(e => e.t === P.FxType.Tracer && e.kind === 2);
	check(arcs.length >= 3, "three arcs on the Fx channel (electric tracers)", `${arcs.length}`);
});

section("D5. the turret drone fires from its orbit, at what is near IT", () => {
	const f = simFixture({ dayTime: 0 });
	const sp = f.player(0, 3000, 3000);
	const pad = f.place(ID.turretDrone, 3024, 2980, 0);
	f.pressE(sp);
	sp.state.x = 4000;
	sp.state.y = 4000;
	const st = f.sim.power.stateOf(pad);
	const z = f.zombie(4000, 4200, 1e6);
	const fx0 = f.fx.length;
	f.run(2, () => z.hp < 1e6);
	check(z.hp < 1e6, "the zombie 200 u from its survivor is shot");
	const t = f.fx.slice(fx0).find(e => e.t === P.FxType.Tracer && e.kind === 1);
	const at = f.sim.power.positionOf(st, { x: 0, y: 0 });
	check(
		t !== undefined && Math.hypot(t.x1 - 4000, t.y1 - 4000) < POW.TURRET_DRONE_ORBIT + POW.TURRET_MUZZLE + 1,
		"the tracer starts at the drone, on its 100 u orbit",
		t ? `${t.x1.toFixed(0)},${t.y1.toFixed(0)}` : "no tracer",
	);
	check(st.store < POW.DRONE_BATTERY, "and the shot came out of the drone's own battery");
	void at;
});

section("D6. Robotics (its maker's) makes a turret hit 1.5× harder (obj_turret: +turret_damage/2 a level)", () => {
	/** one turret shot at a zombie in the open, the damage roll pinned to its mean (random 0.5) */
	const hit = skills => {
		const world = W.serverWorld(W.createWorld(4000, 4000));
		const save = saveWith(skills);
		const zombies = [];
		const progress = new Progress({ saveOf: slot => (slot === 0 ? save : undefined) });
		const combat = new ServerCombat({
			world,
			targets: { zombies: () => zombies, bosses: () => [] },
			progress,
			random: () => 0.5,
		});
		const power = new ServerPower({
			world,
			clock: { dayTime: 12, isRaining: false, darkAlpha: 0 },
			saveOf: slot => (slot === 0 ? save : undefined),
		});
		world.onSolidAdd = (w, s) => power.note(s, true);
		const def = PLACEABLES[ID.turret];
		W.addSolid(world, {
			...placedSolid(def, { x: 1000, y: 1000, w: def.w, h: def.h }, 0),
			placeable: ID.turret,
			owner: 0,
		});
		const bdef = PLACEABLES[ID.battery];
		W.addSolid(world, {
			...placedSolid(bdef, { x: 1150, y: 1000, w: bdef.w, h: bdef.h }, 0),
			placeable: ID.battery,
		});
		power.settle(0.25);
		const z = createZombie(1, 1032 + 200, 1032, 1);
		z.hp = 1e6;
		zombies.push(z);
		const turrets = new ServerTurrets({
			world,
			power,
			zombiesNear: (x, y, r, tick, out) => {
				for (const q of zombies) if (Math.hypot(q.x - x, q.y - y) <= r) out.push(q);
				return out;
			},
			bosses: () => [],
			damage: combat,
			random: () => 0.5,
		});
		for (let t = 0; t < SEARCH_EVERY && z.hp === 1e6; t++) turrets.step(t, TICK_DT);
		return 1e6 - z.hp;
	};
	const plain = hit({});
	const skilled = hit({ [POW.SKILL_ROBOTICS]: 1 });
	check(plain === 25, "a turret's shot: 25 (damage_cal at its mean)", `${plain}`);
	check(skilled === 37, "built by a roboticist: 37 (25 × 1.5, rolled)", `${skilled}`);
});

// ================================================================ E. the cost

section("E1. ten turrets and a full horde: searches bounded and staggered (§3.2)", () => {
	const f = simFixture({ dayTime: 0 });
	f.player(0, 4000, 4600);
	for (let i = 0; i < 10; i++) {
		const x = 3400 + (i % 5) * 300;
		const y = 3800 + Math.floor(i / 5) * 400;
		f.place(ID.turret, x, y, 0);
		f.place(ID.battery, x + 120, y);
	}
	for (let i = 0; i < 150; i++) f.zombie(3300 + (i % 15) * 100, 3500 + Math.floor(i / 15) * 90, 1e9);
	f.run(0.5);
	const stats = f.sim.turrets.stats;
	stats.maxSearchesInTick = 0;
	const s0 = stats.searches;
	// the turrets' own share of the tick, timed around their step
	const live = f.sim.turrets;
	const step = live.step.bind(live);
	let turretMs = 0;
	live.step = (t, dt) => {
		const a = performance.now();
		step(t, dt);
		turretMs += performance.now() - a;
	};
	const t0 = performance.now();
	const ticks = f.run(5);
	const ms = performance.now() - t0;
	live.step = step;
	const searches = stats.searches - s0;
	check(
		stats.maxSearchesInTick <= Math.ceil(10 / SEARCH_EVERY),
		`at most ${Math.ceil(10 / SEARCH_EVERY)} searches in any tick (one turret in ${SEARCH_EVERY})`,
		`max ${stats.maxSearchesInTick}`,
	);
	check(
		searches <= (ticks * 10) / SEARCH_EVERY + 10,
		"never more than one search per turret per 1/10 s",
		`${searches} in ${ticks} ticks`,
	);
	console.log(
		`        (10 turrets, 150 zombies: the turrets ${(turretMs / ticks).toFixed(3)} ms a tick, the whole simulation ${(ms / ticks).toFixed(2)} ms, Node)`,
	);
	check(
		turretMs / ticks < 0.5,
		"the turrets' share of a tick stays small (< 0.5 ms in Node; §3.2 gives combat 0.3 ms)",
		`${(turretMs / ticks).toFixed(3)} ms`,
	);
	// 600 turrets (the server's build cap): the budget holds
	const g = gridFixture();
	for (let i = 0; i < 300; i++) {
		g.place(ID.turret, 200 + (i % 20) * 130, 200 + Math.floor(i / 20) * 130);
		g.place(ID.battery, 260 + (i % 20) * 130, 260 + Math.floor(i / 20) * 130);
	}
	g.run(0.25);
	const zs = [];
	for (let i = 0; i < 150; i++) {
		const z = createZombie(1, 250 + (i % 20) * 130, 250 + Math.floor(i / 20) * 130, 1);
		z.hp = 1e9;
		zs.push(z);
	}
	const combat = new ServerCombat({ world: g.world, targets: { zombies: () => zs, bosses: () => [] } });
	const turrets = new ServerTurrets({
		world: g.world,
		power: g.power,
		zombiesNear: (x, y, r, tick, out) => {
			for (const q of zs) if (Math.hypot(q.x - x, q.y - y) <= r) out.push(q);
			return out;
		},
		bosses: () => [],
		damage: combat,
	});
	for (let t = 0; t < 120; t++) turrets.step(t, TICK_DT);
	check(
		turrets.stats.maxSearchesInTick <= SEARCH_BUDGET,
		`300 turrets: never more than ${SEARCH_BUDGET} searches in a tick (the server's budget)`,
		`max ${turrets.stats.maxSearchesInTick}`,
	);
});

// ================================================================ F. stations

section("F1. a working cooker is heat to cook on; a cold one is not (the cooking rule's other half)", () => {
	const g = gridFixture();
	const box = g.place(ID.battery, 1000, 1000);
	const cooker = g.place(ID.cooker, 1100, 1000);
	// the one craft rule both sides read (shared/sim/craftRule.ts): a cooking recipe next to the cooker, no fire
	const recipe = CRAFT_RECIPES.find(r => r.needsCook === true);
	const nearX = cooker.x + cooker.w + 60;
	const nearY = cooker.y + cooker.h / 2;
	const cooks = () => CR.matchesStation(cooker, "cook") && CR.stationOk(g.world, nearX, nearY, recipe);
	g.run(0.25);
	check(recipe !== undefined && !cooks(), "switched off: cold (a cooking recipe beside it is refused)");
	g.st(cooker).on = true;
	g.run(0.25);
	check(
		CR.isWorkingCooker(cooker) && cooks(),
		"switched on with power: cooking heat (the recipe's station is met by the cooker alone)",
	);
	g.st(box).store = 0;
	g.run(0.5);
	check(!cooks(), "its box empty: cold again (an electric cooker without electricity)");
});

section("F2. the signal generator: switched on and fed, it is a beacon (the client draws the way home to it)", () => {
	const g = gridFixture();
	g.place(ID.battery, 1000, 1000);
	const beacon = g.place(ID.beacon, 1100, 1000);
	g.st(beacon).on = true;
	g.run(0.25);
	check(beacon.powered === true, "working (the Working bit every client draws the arrow from)");
	const bits = g.published.filter(p => p.id === beacon.id).at(-1)?.state ?? 0;
	check(POW.powerWorking(bits), "and published as such", `state ${bits}`);
});

// ================================================================ G. what is published

section("G1. the grid publishes only what changed, with the level of each store", () => {
	const g = gridFixture();
	const box = g.place(ID.battery, 1000, 1000);
	g.place(ID.reactor, 1100, 1000);
	g.run(0.25);
	const n0 = g.published.length;
	g.run(5);
	check(
		g.published.length === n0,
		"nothing changed in 5 s (a full box, a reactor running): nothing published",
		`${g.published.length - n0}`,
	);
	g.st(box).store = 10;
	g.run(0.25);
	const last = g.published.filter(p => p.id === box.id).at(-1);
	check(
		last !== undefined && POW.powerLevel(last.state) === 0,
		"the box at 1 %: published at level 0 (empty)",
		JSON.stringify(last),
	);
	for (const [f, prev, want] of [
		[0.5, 1, 2],
		[0.34, 2, 2],
		[0.3, 2, 1],
		[0.36, 1, 1],
		[0.37, 1, 2],
	]) {
		check(
			POW.levelOf(f, prev) === want,
			`levelOf(${f}, ${prev}) = ${want} (3 % of hysteresis at each edge)`,
			`${POW.levelOf(f, prev)}`,
		);
	}
	// a lamp switched on with no box in reach: published ON and not working (the HUD says "E: Turn off")
	const dark = g.place(ID.lamp, 4000, 4000);
	g.power.act(0, { dead: false }, saveWith(), dark);
	const darkBits = g.published.filter(p => p.id === dark.id).at(-1)?.state ?? 0;
	check(
		POW.powerOn(darkBits) && !POW.powerWorking(darkBits),
		"a lamp switched on with no power: published on, not working",
		`state ${darkBits}`,
	);
	const bits = POW.packPowerState(true, 2, true);
	check(
		POW.powerWorking(bits) && POW.powerLevel(bits) === 2 && POW.powerFlying(bits) && bits <= POW.POWER_STATE_MASK,
		"the state bits round-trip (working, level, flying)",
	);
});

// ================================================================ H. the real path: crafted and placed on the server

section(
	"H1. crafted with the backpack verb and placed by the server's build: a battery box and a turret that shoots",
	() => {
		const { addItem } = require(join(SRC, "shared/sim/inventory.ts"));
		const f = simFixture();
		const save = saveWith();
		const sp = f.player(0, 3000, 3000, save);
		sp.state.godMode = true;
		// a pro desk within reach (both recipes need one)
		W.addSolid(f.world, {
			kind: "structure",
			x: 2800,
			y: 2970,
			w: 112,
			h: 80,
			hp: 400,
			hpMax: 400,
			destructible: true,
			tags: "craftdesk_pro",
		});
		const box = CRAFT_RECIPES.find(r => r.craftKind === 1 && r.resultIndex === ID.battery);
		const gun = CRAFT_RECIPES.find(r => r.craftKind === 1 && r.resultIndex === ID.turret);
		for (const r of [box, gun]) for (const ing of r.ingredients) addItem(save, ing.kind, ing.index, ing.count);
		// the ambient horde is out there: keep it away from the ghosts and the test zombie
		const park = () => {
			for (const z of f.sim.horde.zombies) {
				if (z.test === true) continue;
				z.x = 200;
				z.y = 200;
			}
		};
		let seq = f.sim.tick;
		const verb = (kind, arg, nonce) => P.decodeIntentMessage(P.encodeIntentArgs(kind, 0, arg, nonce));
		/** one real command through the wire (aim, held, edges), then the tick that consumes it */
		const tick = (aim = 0, edges = 0, held = 0) => {
			seq += 1;
			const cmd = P.makeCommand(seq, 0, 0, aim, held, edges);
			PL.ingestInput(sp, P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [cmd] }), f.sim.tick);
			park();
			f.sim.step();
		};
		const place = (recipe, aim, nonce) => {
			f.sim.queueIntent(0, verb(P.IntentKind.Craft, recipe.id, nonce));
			for (let i = 0; i < 20; i++) tick(aim);
			const before = f.world.solids.length;
			tick(aim, P.packEdges(1, 0, 0, 0), P.HeldBit.Attack);
			for (let i = 0; i < 10; i++) tick(aim);
			return f.world.solids.length === before + 1 ? f.world.solids[f.world.solids.length - 1] : undefined;
		};
		const placedBox = place(box, 0, 1);
		check(
			placedBox?.tags === "battery",
			"the battery box: crafted (verb), on the server's cursor, placed by the attack edge",
			placedBox?.tags,
		);
		const placedGun = place(gun, Math.PI / 2, 2);
		check(
			placedGun?.tags === "turret" && placedGun.owner === 0,
			"the turret: the same, built by slot 0",
			placedGun?.tags,
		);
		if (placedBox === undefined || placedGun === undefined) return;
		const st = f.sim.power.stateOf(placedGun);
		check(st?.link?.solid === placedBox, "the grid plugged the turret into the new box (ServerBuild.onSolid)");
		for (let i = 0; i < 20; i++) tick(Math.PI / 2);
		check(placedGun.powered === true, "and it is armed");
		const cx = placedGun.x + placedGun.w / 2;
		const cy = placedGun.y + placedGun.h / 2;
		const z = f.zombie(cx + 40, cy + 220, 100);
		z.test = true;
		const exp0 = save.exp;
		for (let i = 0; i < 360 && z.hp > 0; i++) tick(Math.PI / 2);
		check(z.hp <= 0, "a walker 225 u from it is shot dead by the server", `hp ${z.hp}`);
		check(save.exp > exp0, "and its builder was paid the XP", `+${save.exp - exp0}`);
	},
);

// ================================================================ I. the drawing

section("I. the drawing: a sprite per machine, its states on it, drones that fly and light, no churn (ELE-09)", () => {
	// the client's view, on the fake GUI tree (installed here: nothing above draws)
	const gui = installFakeGui();
	const { Camera } = require(join(SRC, "shared/engine/camera.ts"));
	const { Renderer } = require(join(SRC, "shared/engine/renderer.ts"));
	const { Z } = require(join(SRC, "shared/engine/colors.ts"));
	const MV = require(join(SRC, "client/view/machinesView.ts"));
	const PM = require(join(SRC, "client/systems/powerMirror.ts"));
	const WA = require(join(SRC, "client/view/worldArt.ts"));
	const { WORLD_ART } = require(join(SRC, "client/view/worldArtAssets.ts"));
	const ART = require(join(SRC, "shared/data/machineArt.ts"));
	const rgb = c =>
		c === undefined ? "-" : `${Math.round(c.R * 255)},${Math.round(c.G * 255)},${Math.round(c.B * 255)}`;

	// ---- the grids: well formed, in the pipeline, and the flat drawing IS the grid
	const MAX_LAYER = 4;
	const counts = [];
	for (const [key, sp] of Object.entries(ART.MACHINE_SPRITES)) {
		const cols = sp.rows[0].length;
		const inks = new Set([...ART.MACHINE_ART_ORDER, "."]);
		const shaped = sp.rows.every(row => row.length === cols && [...row].every(ch => inks.has(ch)));
		const tex = WORLD_ART[sp.texture];
		const runs = MV.decomposeGrid(sp.rows, ART.MACHINE_ART_ORDER);
		// paint the runs the way the renderer stacks them (ZIndex, then order), texel by texel
		const paint = sp.rows.map(row => [...row].map(() => undefined));
		runs.map((q, i) => ({ q, i }))
			.sort((a, b) => a.q.z - b.q.z || a.i - b.i)
			.forEach(({ q }) => {
				for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) paint[y][x] = q.color;
			});
		let wrong = 0;
		sp.rows.forEach((row, y) =>
			[...row].forEach((ch, x) => {
				const want = ch === "." ? undefined : ART.MACHINE_ART[ch];
				if (rgb(paint[y][x]) !== rgb(want)) wrong += 1;
			}),
		);
		counts.push(`${key} ${runs.length}`);
		check(
			shaped &&
				tex !== undefined &&
				tex.w === cols &&
				tex.h === sp.rows.length &&
				wrong === 0 &&
				MV.machineRunLayers(key) <= MAX_LAYER,
			`${key}: a ${cols}×${sp.rows.length} grid, its texture in the pipeline, the flat runs repaint it texel for texel, ≤ ${MAX_LAYER} layers`,
			`texture ${sp.texture} ${tex === undefined ? "missing" : `${tex.w}×${tex.h}`}, ${wrong} texels wrong, ${MV.machineRunLayers(key)} layers`,
		);
	}
	if (VERBOSE) console.log(`        runs drawn flat: ${counts.join(", ")}`);

	// ---- a client world with every machine and a box, the way the WorldInit leaves it
	PM.resetPowerMirror();
	const world = W.serverWorld(W.createWorld(6000, 6000));
	const put = (id, x, y) => {
		const d = PLACEABLES[id];
		return W.addSolid(world, { ...placedSolid(d, { x, y, w: d.w, h: d.h }, 0), placeable: id, owner: 0 });
	};
	const box = put(ID.battery, 2000, 2000);
	const m = {};
	const spots = [
		["turret", ID.turret],
		["shock", ID.shock],
		["solar", ID.solar],
		["reactor", ID.reactor],
		["oil", ID.oil],
		["lamp", ID.lamp],
		["beacon", ID.beacon],
		["cooker", ID.cooker],
		["turretDrone", ID.turretDrone],
		["lampDrone", ID.lampDrone],
	];
	spots.forEach(([name, id], i) => {
		const a = (i / spots.length) * 2 * Math.PI;
		m[name] = put(id, 2000 + Math.cos(a) * 220, 2000 + Math.sin(a) * 220);
	});
	const barricade = put(0, 1500, 1500);
	const root = gui.make("Frame");
	const r = new Renderer(root, "Sprites");
	const cam = new Camera();
	cam.setView(1600, 1200);
	r.setView(1600, 1200);
	cam.x = 2050;
	cam.y = 2050;
	const view = new MV.MachinesView(() => ({ x: 0, y: 0 }));
	const set = (s, state, pilot = SLOT_NONE) =>
		PM.applyPowerSet(world, { t: P.WorldEv.PowerSet, id: s.id, state, pilot });
	const on = (level = 3) => POW.packPowerState(true, level, false, true);
	const off = () => POW.packPowerState(false, 0, false, false);

	// capture what a call draws: the renderer's own entry point, recorded
	const calls = [];
	let capturing = false;
	const drawRect = Renderer.prototype.drawRect;
	Renderer.prototype.drawRect = function (c, wx, wy, o) {
		if (capturing) {
			calls.push({
				x: wx,
				y: wy,
				w: o.w,
				h: o.h,
				z: o.zIndex,
				color: rgb(o.color),
				alpha: o.alpha,
				rotation: o.rotation ?? 0,
				image: o.image,
				circle: o.circle === true,
			});
		}
		return drawRect.call(this, c, wx, wy, o);
	};
	const capture = fn => {
		calls.length = 0;
		capturing = true;
		r.beginFrame();
		fn();
		r.endFrame();
		capturing = false;
		return calls.map(c => ({ ...c }));
	};
	const key = cs => JSON.stringify(cs.map(c => [c.z, c.color, Math.round(c.alpha * 100), c.circle]));
	const body = { x: 2600, y: 2300 };
	let t = 0;
	const frame = (tracers = [], me = undefined, dt = 1 / 60) => {
		t += dt;
		view.learn(world, tracers, t, t, dt);
		return capture(() => {
			for (const s of world.solids) view.draw(r, cam, s);
			view.drawAir(r, cam, cam.viewRect(32), dt, slot => (slot === 0 ? body : undefined), me);
		});
	};

	// ---- every machine has its own drawing; anything else keeps the old one
	view.learn(world, [], 0.2, 0.2, 0);
	const tags = Object.keys(POW.MACHINES);
	const drawn = tags.filter(tag => {
		const s = world.solids.find(o => o.tags === tag);
		return s !== undefined && capture(() => view.draw(r, cam, s)).length > 0;
	});
	let claimed = true;
	capture(() => {
		claimed = view.draw(r, cam, barricade);
	});
	check(
		drawn.length === tags.length && !claimed,
		"every electric build is drawn by the machines view, and a barricade is left to the old drawing",
		`${drawn.length}/${tags.length}`,
	);
	// its body on the structures' layers, its states over them, all under the zombies (a walker beside a turret is
	// never under its head); everything at once: every state lit, the turret aimed, a drone docked
	for (const s of world.solids) if (POW.machineOf(s) !== undefined) set(s, on());
	const layersOf = cs => cs.map(c => c.z);
	const standing = world.solids.filter(s => POW.machineOf(s) !== undefined);
	const zs = layersOf(capture(() => standing.forEach(s => view.draw(r, cam, s)))).filter(z => z !== Z.shadow);
	check(
		zs.length > 0 && Math.min(...zs) >= Z.structure && Math.max(...zs) < Z.zombie,
		"a machine draws between the structures' layer and the zombies' (its shadow apart)",
		`z ${Math.min(...zs)}..${Math.max(...zs)}, zombies at ${Z.zombie}`,
	);

	// ---- powered and unpowered look different, on every machine (ELE-09)
	const look = (s, state) => {
		set(s, state);
		view.learn(world, [], 0.2, 0.2, 0);
		return key(capture(() => view.draw(r, cam, s)));
	};
	const same = [];
	for (const s of [box, ...Object.values(m)]) {
		const dark = look(s, off());
		const lit = look(s, on());
		if (dark === lit) same.push(s.tags);
	}
	check(
		same.length === 0,
		"working and dead look different on every machine (the status lamp, the lens, the plates, the bars, the core)",
		same.join(", "),
	);

	// ---- the turret's head turns to its last shot, and the muzzle flashes while the tracer burns
	set(m.turret, on());
	const tc = { x: m.turret.x + m.turret.w / 2, y: m.turret.y + m.turret.h / 2 };
	const aim = 2.2;
	const tracer = {
		x1: tc.x + Math.cos(aim) * POW.TURRET_MUZZLE,
		y1: tc.y + Math.sin(aim) * POW.TURRET_MUZZLE,
		x2: tc.x + Math.cos(aim) * 280,
		y2: tc.y + Math.sin(aim) * 280,
		life: 0.08,
	};
	view.learn(world, [tracer], t, t, 1 / 60);
	const shooting = capture(() => view.draw(r, cam, m.turret));
	const turned = shooting.filter(c => Math.abs(c.rotation - aim) < 1e-9);
	const flashes = cs => cs.filter(c => c.w === 14 && c.h === 10).length;
	view.learn(world, [], t, t, 0.2);
	const after = capture(() => view.draw(r, cam, m.turret));
	const stillTurned = after.filter(c => Math.abs(c.rotation - aim) < 1e-9).length;
	check(
		turned.length > 1 && flashes(shooting) === 1 && flashes(after) === 0 && stillTurned === turned.length - 1,
		"a turret's head turns to where its shot went (the server's tracer names it), the muzzle flashes, then stops",
		`${turned.length} parts turned, flash ${flashes(shooting)} then ${flashes(after)}, head still aimed ${stillTurned}`,
	);

	// ---- a lamp drone flies beside its survivor on the server's orbit, lights the night there, and comes home
	set(m.lampDrone, POW.packPowerState(true, 3, true), 0);
	for (let i = 0; i < 120; i++) frame();
	const orbit = POW.droneOffset(m.lampDrone.id, true, t, { x: 0, y: 0 });
	const lights = [];
	view.collectLights(lights);
	const light = lights[0];
	check(
		lights.length === 1 &&
			light.r === POW.LAMP_DRONE_LIGHT &&
			near(light.x, body.x + orbit.x, 1e-6) &&
			near(light.y, body.y + orbit.y, 1e-6),
		"the lamp drone in the air lights 320 u exactly where the server's orbit puts it (droneOffset, one function)",
		light === undefined
			? "no light"
			: `(${light.x.toFixed(1)}, ${light.y.toFixed(1)}) vs (${(body.x + orbit.x).toFixed(1)}, ${(body.y + orbit.y).toFixed(1)})`,
	);
	const inAir = frame().filter(c => c.z >= Z.projectile - 1 && c.z <= Z.projectile + 8).length;
	set(m.lampDrone, POW.packPowerState(false, 2, false), SLOT_NONE);
	for (let i = 0; i < 120; i++) frame();
	const home = [];
	view.collectLights(home);
	check(
		inAir > 0 && home.length === 0,
		"called back, it flies home to its pad and its light goes out",
		`${inAir} parts in the air`,
	);

	// ---- the cables: yellow while the box holds charge, grey when it is dry
	const cables = cs => cs.filter(c => c.z === Z.decal && c.h === 3);
	set(box, on());
	const fed = cables(frame());
	set(box, off());
	const dry = cables(frame());
	check(
		fed.length === Object.keys(m).length &&
			fed.every(c => c.color === rgb(ART.MACHINE_ART.y)) &&
			dry.length === fed.length &&
			dry.every(c => c.color !== rgb(ART.MACHINE_ART.y)),
		"a cable from each machine to its box: yellow while it holds charge (LEG-02), grey when it is dry",
		`${fed.length} cables`,
	);

	// ---- the beacon's arrow: only a working beacon, only once you are away from it
	const arrow = cs => cs.filter(c => c.z === Z.uiWorld && c.color === rgb(ART.MACHINE_ART.c));
	const bc = { x: m.beacon.x + m.beacon.w / 2, y: m.beacon.y + m.beacon.h / 2 };
	set(m.beacon, on());
	const far = arrow(frame([], { x: bc.x + 1500, y: bc.y }));
	const close = arrow(frame([], { x: bc.x + 200, y: bc.y }));
	set(m.beacon, POW.packPowerState(false, 0, false, true));
	const unfed = arrow(frame([], { x: bc.x + 1500, y: bc.y }));
	check(
		far.length === 2 && far.every(c => c.x < bc.x + 1500) && close.length === 0 && unfed.length === 0,
		"the signal generator: an arrow home when you are far, none beside it, none when it has no power",
		`far ${far.length}, close ${close.length}, unfed ${unfed.length}`,
	);

	// ---- no churn: everything moving (shots, a drone out and back, the beacon blinking), flat and with art
	const churn = art => {
		WA.overrideWorldArt(art);
		for (const s of [box, ...Object.values(m)]) set(s, on());
		const cycle = i => {
			const k = i % 240;
			if (k === 0) set(m.turretDrone, POW.packPowerState(true, 3, true), 0);
			if (k === 120) set(m.turretDrone, POW.packPowerState(true, 2, false), SLOT_NONE);
			body.x = 2600 + Math.sin(i / 30) * 200;
			frame(i % 10 === 0 ? [{ ...tracer, life: 0.08 }] : [], {
				x: bc.x + 1500,
				y: bc.y + Math.cos(i / 40) * 300,
			});
		};
		for (let i = 0; i < 480; i++) cycle(i);
		const before = gui.stats.created;
		for (let i = 0; i < 600; i++) cycle(i);
		return gui.stats.created - before;
	};
	const flatChurn = churn({});
	const ids = {};
	for (const sp of Object.values(ART.MACHINE_SPRITES)) {
		ids[sp.texture] = `rbxassetid://${Object.keys(ids).length + 700000}`;
	}
	const artChurn = churn(ids);
	check(
		flatChurn === 0 && artChurn === 0,
		"600 frames of it create no Instance after warm-up, flat and with art",
		`flat ${flatChurn}, art ${artChurn}`,
	);

	// ---- with art, a machine is a picture: one ImageLabel for its body, the states over it
	const machines = [box, ...Object.values(m)];
	const withArt = machines.map(s => {
		const cs = capture(() => view.draw(r, cam, s));
		return { tag: s.tags, images: cs.filter(c => c.image !== undefined).length, all: cs.length };
	});
	WA.overrideWorldArt({});
	const flat = machines.map(s => capture(() => view.draw(r, cam, s)).length);
	check(
		withArt.every((a, i) => a.images >= 1 && a.all <= 8 && a.all < flat[i]),
		"with its texture uploaded each machine is one picture (≤ 8 sprites with its states), fewer than flat",
		withArt.map((a, i) => `${a.tag} ${a.all}/${flat[i]}`).join(", "),
	);
	Renderer.prototype.drawRect = drawRect;
	WA.overrideWorldArt(undefined);
	PM.resetPowerMirror();
});

// ---------------------------------------------------------------- verdict

console.log(`\n${checks} checks, ${failures} failure(s)`);
if (failures > 0) process.exit(1);
console.log("all power and defence tests passed");
