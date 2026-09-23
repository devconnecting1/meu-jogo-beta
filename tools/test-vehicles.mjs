#!/usr/bin/env node
/*
 * The bicycle and the motorcycle, ridden (docs/DESIGN_RULES.md VEI-05, docs/MULTIPLAYER.md §2.2, §4.2).
 *
 *   npm run test:vehicles
 *   node tools/test-vehicles.mjs --verbose
 *   PZ_SRC=path/to/src node tools/test-vehicles.mjs
 *
 * It runs the REAL modules: shared/sim/vehicle.ts through `stepPlayer`, and from section B on the server's
 * vehicles (server/sim/vehicles.ts) inside a real ServerSimulation, driven the way a client drives it -- every
 * press goes through `encodeInput` → `ingestInput`, because the whole question is what a PACKET can make the
 * server do.
 *
 *   A. HANDLING: top speeds (bicycle faster than walking, motorcycle much faster), acceleration, the turn radius
 *      at speed, braking round, coasting, no oil no engine; a head-on crash stops the vehicle, a glancing hit
 *      slides; the state stays on the wire's grid, so two runs of the same commands agree to the bit.
 *   B. THE SERVER: getting on and off by E at the server's position (SolidRemove / SolidAdd); only a survivor the
 *      server mounted goes faster than a walk, and never faster than the vehicle; E floods are rate-limited; fuel
 *      from the rider's backpack; crashes wear the vehicle (never below 1 hp) and hurt the rider through armour;
 *      broken, it is repaired with steel; zombies ahead throw you off or stop you, riders get bitten; the engine
 *      and the horn are the noise event the horde hears; no weapon on a vehicle; leaving and dying leave the
 *      vehicle in town; the self block and the player block carry the ride through the real wire.
 *
 * Pure Node (>= 18) + the project's TypeScript, on the shared shims (tools/luau-shim.mjs).
 */
import { join } from "node:path";
import { installShims } from "./luau-shim.mjs";

const VERBOSE = process.argv.includes("--verbose");
const { SRC, require } = installShims({ seed: 1 });

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
function checkEq(got, want, what) {
	return check(got === want, what, got === want ? `${got}` : `expected ${want}, got ${got}`);
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
const f1 = n => (typeof n === "number" ? n.toFixed(1) : String(n));

// ---------------------------------------------------------------- the modules under test

const W = require(join(SRC, "shared/game/world.ts"));
const SAVE = require(join(SRC, "shared/game/save.ts"));
const Ply = require(join(SRC, "shared/game/player.ts"));
const { stepPlayer } = require(join(SRC, "shared/sim/playerMove.ts"));
const T = require(join(SRC, "shared/sim/types.ts"));
const V = require(join(SRC, "shared/sim/vehicle.ts"));
const { VEHICLES, VehicleKind, vehicleDef, vehicleKindOfItem } = require(join(SRC, "shared/data/buildings.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));

const DT = 1 / 60;
const BIKE = vehicleDef(VehicleKind.Bicycle);
const MOTO = vehicleDef(VehicleKind.Motorcycle);

/** a command of the shared simulation: stick (dx, dy), no buttons */
function stick(seq, dx, dy) {
	return T.makeCommand(seq, dx, dy, dx !== 0 || dy !== 0 ? 1 : 0, 0, 0, 0);
}

function fueled(oil = 50) {
	const s = SAVE.defaultSave();
	s.oil = oil;
	return s;
}

/** a survivor already on a vehicle of `kind`, at rest, pointing +x */
function rider(kind, x = 1000, y = 4000, save = fueled()) {
	const p = Ply.createPlayer(save, x, y);
	p.ride = { kind, heading: 0, speed: 0 };
	return { p, save };
}

/** runs `n` ticks of `cmdOf(i)` and returns the per-tick results */
function ride(world, r, n, cmdOf) {
	const out = [];
	for (let i = 0; i < n; i++) out.push(stepPlayer(world, r.p, r.save, cmdOf(i), DT));
	return out;
}

function wallWorld() {
	const world = W.createWorld(8000, 8000);
	// a long wall across the road at x = 2000
	W.addSolid(world, {
		kind: "wall_v",
		x: 2000,
		y: 2000,
		w: 16,
		h: 4000,
		hp: 1,
		hpMax: 1,
		destructible: false,
		tags: "bwall",
	});
	return world;
}

// ================================================================ A. handling

section("A1. top speeds: the bicycle beats the fastest walker, the motorcycle is much faster", () => {
	const world = W.createWorld(12000, 8000);
	const walker = Ply.createPlayer(fueled(), 1000, 4000);
	for (let i = 0; i < 60; i++) stepPlayer(world, walker, fueled(), stick(i, 1, 0), DT);
	const walk = walker.x - 1000;
	const fastest = (DESIGN.MOVE_SPEED + 3 * 0.3 + 2) * T.SPEED_SCALE;
	for (const def of VEHICLES) {
		const r = rider(def.kind);
		const x0 = r.p.x;
		let reached;
		ride(world, r, 300, i => {
			if (reached === undefined && V.rideSpeed(r.p.ride) >= def.topSpeed) reached = i / 60;
			return stick(i, 1, 0);
		});
		const perSecond = (r.p.x - x0 - (def.topSpeed * (reached ?? 0)) / 2) / (5 - (reached ?? 0));
		checkEq(V.rideSpeed(r.p.ride), def.topSpeed, `${def.name}: holds its top speed of ${def.topSpeed} u/s`);
		check(
			reached !== undefined && Math.abs(reached - def.topSpeed / def.accel) < 0.05,
			`${def.name}: 0 → top in ${f1(def.topSpeed / def.accel)} s`,
			`reached at ${reached?.toFixed(2)} s`,
		);
		check(Math.abs(perSecond - def.topSpeed) < 3, `${def.name}: the body really covers it`, `${f1(perSecond)} u/s`);
	}
	checkEq(Math.round(walk), 210, "walking is 210 u/s (DESIGN.MOVE_SPEED 7 × 30)");
	check(
		BIKE.topSpeed > fastest,
		"bicycle > the fastest walker (Trot 3 + a speed buff)",
		`${BIKE.topSpeed} > ${fastest}`,
	);
	check(MOTO.topSpeed >= 2.4 * 210, "motorcycle ≥ 2.4 × walking", `${MOTO.topSpeed}`);
	check(MOTO.topSpeed > BIKE.topSpeed * 1.35, "motorcycle ≥ 1.35 × bicycle", `${MOTO.topSpeed} / ${BIKE.topSpeed}`);
});

section("A2. steering: toward the stick at a limited yaw rate, wide at speed, tight when slow", () => {
	const world = W.createWorld(12000, 12000);
	for (const def of VEHICLES) {
		const r = rider(def.kind, 3000, 3000);
		r.p.ride.speed = V.topSteps(def);
		const x0 = r.p.x;
		const y0 = r.p.y;
		let ticks;
		let radius;
		ride(world, r, 240, i => {
			if (ticks === undefined && Math.abs(V.rideHeading(r.p.ride) - Math.PI / 2) < 0.002) {
				ticks = i;
				radius = (r.p.x - x0 + (r.p.y - y0)) / 2;
			}
			return stick(i, 0, 1);
		});
		const expect = (def.topSpeed * def.topSpeed) / def.grip;
		check(
			ticks !== undefined && ticks / 60 < 0.8,
			`${def.name}: a quarter turn at top speed in under 0.8 s`,
			`${ticks} ticks`,
		);
		check(
			radius !== undefined && Math.abs(radius - expect) < expect * 0.1,
			`${def.name}: ...on a radius of v²/grip = ${f1(expect)} u (${f1(expect / 55)} m): wide at speed`,
			`measured ${f1(radius)}`,
		);
		// at a standstill the rider walks the front wheel round: a half turn in about a second
		const s = rider(def.kind, 3000, 3000);
		let half;
		ride(world, s, 120, i => {
			if (half === undefined && Math.abs(V.rideHeading(s.p.ride) - Math.PI) < 0.01) half = i;
			return i < 1 ? stick(i, -1, 0) : stick(i, -1, 0);
		});
		check(
			half !== undefined && half / 60 <= Math.PI / def.standTurn + 0.1,
			`${def.name}: U-turn from a standstill`,
			`${half} ticks`,
		);
	}
});

section("A3. brakes, coasting, no reverse; the motorcycle needs oil, the bicycle does not", () => {
	const world = W.createWorld(12000, 8000);
	for (const def of VEHICLES) {
		const r = rider(def.kind, 3000, 4000);
		r.p.ride.speed = V.topSteps(def);
		let stopped;
		ride(world, r, 300, i => {
			if (stopped === undefined && r.p.ride.speed === 0) stopped = i;
			return stick(i, 0, 0);
		});
		check(
			stopped !== undefined && Math.abs(stopped / 60 - def.topSpeed / def.coast) < 0.05,
			`${def.name}: no stick, it coasts to a stop in ${f1(def.topSpeed / def.coast)} s`,
			`${stopped} ticks`,
		);
		const b = rider(def.kind, 3000, 4000);
		b.p.ride.speed = V.topSteps(def);
		const x0 = b.p.x;
		let low;
		ride(world, b, 30, i => {
			if (low === undefined && V.rideSpeed(b.p.ride) <= def.topSpeed / 2) low = i;
			return stick(i, -1, 0);
		});
		check(
			low !== undefined && low / 60 <= def.topSpeed / 2 / def.brake + 0.02,
			`${def.name}: stick behind brakes at ${def.brake} u/s²`,
			`half speed after ${low} ticks`,
		);
		check(b.p.x > x0, `${def.name}: no reverse (it brakes and turns, it never backs up)`);
	}
	const dry = rider(VehicleKind.Motorcycle, 1000, 4000, fueled(0));
	ride(world, dry, 60, i => stick(i, 1, 0));
	checkEq(dry.p.x, 1000, "motorcycle with no oil in the rider's backpack: the throttle does nothing");
	const pedal = rider(VehicleKind.Bicycle, 1000, 4000, fueled(0));
	ride(world, pedal, 60, i => stick(i, 1, 0));
	check(pedal.p.x > 1100, "bicycle with no oil: pedals", `${f1(pedal.p.x - 1000)} u in 1 s`);
	check(
		!V.engineRuns(MOTO, fueled(0)) && V.engineRuns(MOTO, fueled(1)) && V.engineRuns(BIKE, fueled(0)),
		"engineRuns",
	);
});

section("A4. crashes: head-on at speed stops dead and reports it; slow or glancing does not", () => {
	for (const def of VEHICLES) {
		const world = wallWorld();
		const r = rider(def.kind, 1000, 4000);
		r.p.ride.speed = V.topSteps(def);
		let hit;
		const res = ride(world, r, 240, i => stick(i, 1, 0));
		for (let i = 0; i < res.length; i++)
			if (res[i].crash !== undefined && hit === undefined) hit = { i, v: res[i].crash };
		check(
			hit !== undefined && hit.v === def.topSpeed,
			`${def.name}: into the wall at top speed is a crash`,
			JSON.stringify(hit),
		);
		checkEq(r.p.ride.speed, 0, `${def.name}: ...and the vehicle is stopped`);
		check(r.p.x <= 2000 - def.radius + 0.5, `${def.name}: ...outside the wall`, f1(r.p.x));
		// slow: a bump, no crash (from 60 u of run-up neither reaches its crash speed: v = √(2·accel·60))
		const s = rider(def.kind, 2000 - def.radius - 60, 4000);
		const slow = ride(world, s, 120, i => stick(i, 1, 0));
		check(
			slow.every(x => x.crash === undefined),
			`${def.name}: pulling away 60 u from it, it bumps and stops without a crash`,
			`${f1(Math.sqrt(2 * def.accel * 60))} < ${def.crashSpeed} u/s`,
		);
		// glancing: 20° off the wall's face, at top speed: slides along it
		const g = rider(def.kind, 1970 - def.radius, 3000);
		const a = Math.PI / 2 - (20 * Math.PI) / 180;
		g.p.ride.heading = V.quantHeading(a);
		g.p.ride.speed = V.topSteps(def);
		const gl = ride(world, g, 40, i => stick(i, Math.cos(a), Math.sin(a)));
		check(
			gl.every(x => x.crash === undefined),
			`${def.name}: 20° off the face at top speed is no crash`,
		);
		check(
			g.p.y > 3000 + def.topSpeed * 0.4 && V.rideSpeed(g.p.ride) > def.topSpeed * 0.6,
			`${def.name}: ...it slides on along the wall`,
			`${f1(g.p.y - 3000)} u, ${V.rideSpeed(g.p.ride)} u/s`,
		);
	}
});

section("A5. the state stays on the wire's grid, and two runs agree to the bit", () => {
	const world = wallWorld();
	const run = () => {
		const r = rider(VehicleKind.Motorcycle, 1200, 4000);
		const trail = [];
		let seed = 7;
		const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
		for (let i = 0; i < 900; i++) {
			const a = rnd() * Math.PI * 2;
			const cmd = rnd() < 0.1 ? stick(i, 0, 0) : stick(i, Math.cos(a), Math.sin(a));
			stepPlayer(world, r.p, r.save, cmd, DT);
			trail.push(`${r.p.x},${r.p.y},${V.packRide(r.p.ride)}`);
		}
		return trail;
	};
	const a = run();
	const b = run();
	checkEq(a.join("|") === b.join("|"), true, "900 random commands, twice: identical positions and ride states");
	let onGrid = true;
	const r = rider(VehicleKind.Bicycle, 1200, 4000);
	for (let i = 0; i < 600; i++) {
		stepPlayer(world, r.p, r.save, stick(i, Math.cos(i / 17), Math.sin(i / 23)), DT);
		const x = r.p.ride;
		if (!Number.isInteger(x.heading) || !Number.isInteger(x.speed) || x.heading < 0 || x.heading >= V.HEADING_STEPS)
			onGrid = false;
		if (!V.rideKeyValid(V.packRide(x))) onGrid = false;
		const back = V.unpackRide(V.packRide(x));
		if (back.kind !== x.kind || back.heading !== x.heading || back.speed !== x.speed) onGrid = false;
	}
	check(onGrid, "every tick: integer heading and speed, and packRide / unpackRide round-trip");
	checkEq(V.packRide(undefined), 0, "on foot packs to 0");
	check(!V.rideKeyValid(3 * V.HEADING_STEPS * 256), "kind 3 is no ride");
	check(
		!V.rideKeyValid(1 * V.HEADING_STEPS * 256 + V.topSteps(BIKE) + 1),
		"a bicycle above its top speed is no ride",
	);
	check(V.rideKeyValid((2 * V.HEADING_STEPS + 5) * 256 + 255), "a motorcycle at 510 u/s is");
});

function info(msg) {
	if (VERBOSE) console.log(`        ${msg}`);
}

// ================================================================ B. the server's vehicles, through the wire

const P = require(join(SRC, "shared/net/protocol.ts"));
const PL = require(join(SRC, "server/sim/players.ts"));
const { ServerSimulation } = require(join(SRC, "server/sim/simulation.ts"));
const { WorldClock } = require(join(SRC, "server/sim/waves.ts"));
const SV = require(join(SRC, "server/sim/vehicles.ts"));
const { PLACEABLES, placedSolid } = require(join(SRC, "shared/sim/placement.ts"));
const { createZombie, resetEntityIds } = require(join(SRC, "shared/game/entities.ts"));
const REP = require(join(SRC, "server/net/replication.ts"));
const { interactTarget } = require(join(SRC, "shared/sim/interactQuery.ts"));
const ETC_NAME = { 21: "bicycle", 22: "motorcycle" };

const PRESS_E = P.packEdges(0, 0, 1, 0);
const PRESS_ATTACK = P.packEdges(1, 0, 0, 0);

/**
 * A server with the interactive world on (what the server-builds merge switches on for the game), at noon, and a
 * log of every ride event and vehicle noise. `zombies: true` brings the real horde (its ambient spawner included).
 */
function serverWith({ zombies = false, width = 8000, height = 8000, hour = 12 } = {}) {
	resetEntityIds();
	const world = W.serverWorld(W.createWorld(width, height));
	const clock = new WorldClock({ day: 1, dayTime: hour });
	const sim = new ServerSimulation({ world, clock, zombies, interactive: true });
	const events = [];
	const noises = [];
	sim.onRide = (sp, e) => events.push({ slot: sp.slot, ...e });
	sim.onVehicleNoise = n => noises.push(n);
	return { world, sim, events, noises };
}

function addPlayer(sim, slot, x, y, save = fueled()) {
	const sp = PL.createServerPlayer({ slot, userId: 900 + slot, name: `p${slot}` }, save, x, y, sim.tick, sim.simHz);
	sim.add(sp);
	sp.state.x = x;
	sp.state.y = y;
	return sp;
}

/** a vehicle the SERVER put in the world (what ServerBuild.place makes), centred at (cx, cy) on quarter turn `rot` */
function park(world, item, cx, cy, rot = 0, owner = 0) {
	const def = PLACEABLES[item];
	const vdef = vehicleDef(vehicleKindOfItem(item));
	const r = V.parkedRect(vdef, cx, cy, rot);
	return W.addSolid(world, { ...placedSolid(def, r, rot), placeable: item, owner });
}

/** a client that only sends packets: one command per tick, through encodeInput → ingestInput, then the tick */
function driver(sim, sp) {
	let seq = 100;
	return {
		tick(mx = 0, my = 0, edges = 0, held = 0, aim = 0) {
			const cmd = P.makeCommand(seq, mx, my, aim, held, edges);
			seq += 1;
			const payload = P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [cmd] });
			PL.ingestInput(sp, payload, sim.tick / 60);
			sim.step();
		},
		ticks(n, mx = 0, my = 0, edges = 0, held = 0) {
			for (let i = 0; i < n; i++) this.tick(mx, my, i === 0 ? edges : 0, held);
		},
	};
}

function drain(sim) {
	const out = [];
	sim.worldOut.take(out);
	return out.map(p => p.ev);
}

const vehiclesIn = world => world.solids.filter(s => s.tags === "vehicle");

section(
	"B0. the vehicle is a server construction: crafted, held on the server's cursor, placed by the attack edge",
	() => {
		const { CRAFT_RECIPES } = require(join(SRC, "shared/data/crafts.ts"));
		const { addItem } = require(join(SRC, "shared/sim/inventory.ts"));
		const { world, sim } = serverWith();
		const sp = addPlayer(sim, 0, 2000, 2000);
		const d = driver(sim, sp);
		// a craft desk beside them (the bicycle kit needs one)
		W.addSolid(world, {
			...placedSolid(PLACEABLES[0], { x: 1900, y: 1850, w: 96, h: 72 }, 0),
			placeable: 0,
			owner: 0,
		});
		for (const item of [21, 22]) {
			const recipe = CRAFT_RECIPES.find(r => r.craftKind === 1 && r.resultIndex === item);
			for (const ing of recipe.ingredients) addItem(sp.save, ing.kind, ing.index, ing.count);
			if (recipe.needsPro)
				W.addSolid(world, {
					...placedSolid(PLACEABLES[1], { x: 2100, y: 1850, w: 112, h: 80 }, 0),
					placeable: 1,
					owner: 0,
				});
			const out = sim.craft.craft(0, sp.state, sp.save, recipe.id);
			checkEq(out.kind, "holding", `${ETC_NAME[item]}: the craft puts the kit on the SERVER's cursor`);

			d.tick(0, 0, PRESS_ATTACK, 0, 0);
			const placed = vehiclesIn(world).find(s => s.placeable === item);
			check(
				placed !== undefined && placed.owner === 0,
				`${ETC_NAME[item]}: the attack edge places it, the server's, with its builder`,
			);
			check(placed !== undefined && V.isRideable(placed), "...and it can be ridden");
			// round to it and get on, through the wire
			sp.state.x = placed.x + placed.w / 2;
			sp.state.y = placed.y - 30;
			d.ticks(40);
			d.tick(0, 0, PRESS_E);
			check(
				sim.vehicles.riding(0) && sp.state.ride?.kind === vehicleKindOfItem(item),
				`E: riding the ${ETC_NAME[item]} that was built`,
			);
			d.ticks(40);
			d.tick(0, 0, PRESS_E);
			d.ticks(40);
			// out of the way of the next ghost (a parked vehicle is not built over)
			for (const s of vehiclesIn(world)) W.removeSolid(world, s);
			sp.state.x = 2000;
			sp.state.y = 2000;
		}
	},
);

section("B1. getting on and off: E at the server's position, the solid out of the world and back", () => {
	const { world, sim, events } = serverWith();
	const bike = park(world, 21, 1000, 1000, 1);
	const sp = addPlayer(sim, 0, 1000 + 12 + 30, 1000);
	const d = driver(sim, sp);
	drain(sim);
	checkEq(
		interactTarget(world, sp.state.x, sp.state.y)?.kind,
		"vehicle",
		"E would act on the bicycle (the HUD's query)",
	);
	d.tick(0, 0, PRESS_E);
	check(sim.vehicles.riding(0) && sp.state.ride?.kind === VehicleKind.Bicycle, "E: the survivor rides the bicycle");
	check(bike.removed === true && !world.solids.includes(bike), "the parked solid left the world");
	const out = drain(sim);
	check(
		out.some(e => e.t === P.WorldEv.SolidRemove && e.id === bike.id),
		"...and everybody is told (SolidRemove, global)",
	);
	checkEq(sp.state.x, 1000, "the survivor sits on the seat (x)");
	checkEq(V.rideHeading(sp.state.ride), Math.PI / 2, "...facing the way it was parked (quarter turn 1 = +y)");
	check(
		events.some(e => e.kind === "mounted" && e.vehicle === VehicleKind.Bicycle),
		"the mounted event (achievements)",
	);
	// E at once: the cooldown holds it (each on/off is a global delta)
	d.tick(0, 0, PRESS_E);
	check(sim.vehicles.riding(0), `E again within ${SV.MOUNT_COOLDOWN_S} s does nothing`);
	d.ticks(40, 0, 1);
	d.tick(0, 0, PRESS_E);
	check(!sim.vehicles.riding(0) && sp.state.ride === undefined, "E again later: off");
	const parked = vehiclesIn(world);
	checkEq(parked.length, 1, "the bicycle is back in the world, once");
	const back = parked[0];
	check(back !== undefined && back.placeable === 21 && back.owner === 0, "the same kind, and still its builder's");
	check(back !== undefined && back.id !== bike.id && back.passable === true, "a new id, passable");
	const out2 = drain(sim);
	const add = out2.find(e => e.t === P.WorldEv.SolidAdd);
	check(
		add !== undefined && add.placeable === 21 && add.rot === 1,
		"SolidAdd with the placeable and the quarter turn",
		JSON.stringify(add),
	);
	const gap = Math.hypot(sp.state.x - (back.x + back.w / 2), sp.state.y - (back.y + back.h / 2));
	check(gap > 20 && gap < 50, "the survivor stepped off beside it", f1(gap));
	check(
		events.some(e => e.kind === "dismounted" && e.why === "action"),
		"the dismounted event",
	);
});

section("B2. the speed is the server's: only a survivor the server mounted rides", () => {
	const { world, sim } = serverWith({ width: 16000 });
	// a walker holding the stick: 210 u/s, whatever the client believes
	const walker = addPlayer(sim, 0, 1000, 2000);
	const dw = driver(sim, walker);
	dw.ticks(120, 1, 0);
	const walked = (walker.state.x - 1000) / 2;
	check(Math.abs(walked - 210) < 1, "on foot the server moves 210 u/s", f1(walked));
	// E far from any vehicle: nothing, and still 210 u/s
	park(world, 22, 6000, 2000);
	dw.tick(0, 0, PRESS_E);
	check(
		!sim.vehicles.riding(0) && walker.state.ride === undefined,
		"E with the motorcycle 3000 u away mounts nothing",
	);
	// E next to a vehicle the CLIENT placed (no placeable: MP_PHASE 2's local build): nothing
	const local = W.addSolid(world, placedSolid(PLACEABLES[22], V.parkedRect(MOTO, walker.state.x + 40, 2000, 0), 0));
	dw.tick(0, 0, PRESS_E);
	check(!sim.vehicles.riding(0), "E at a vehicle the server never placed (no placeable) mounts nothing");
	W.removeSolid(world, local);
	// a ridden vehicle's top speed, and back to a walk the tick it is left
	const rider = addPlayer(sim, 1, 6000, 2040);
	const dr = driver(sim, rider);
	dr.tick(0, 0, PRESS_E);
	check(sim.vehicles.riding(1), "E at the motorcycle, 40 u away: on it");
	let fastest = 0;
	for (let i = 0; i < 180; i++) {
		const x0 = rider.state.x;
		const y0 = rider.state.y;
		dr.tick(1, 0);
		fastest = Math.max(fastest, Math.hypot(rider.state.x - x0, rider.state.y - y0) * 60);
	}
	check(fastest <= MOTO.topSpeed + 0.01, `never faster than its top speed (${MOTO.topSpeed})`, f1(fastest));
	check(fastest >= MOTO.topSpeed - 0.01, "and it gets there", f1(fastest));
	dr.ticks(60, 0, 0);
	dr.tick(0, 0, PRESS_E);
	check(!sim.vehicles.riding(1), "off again");
	const x0 = rider.state.x;
	dr.ticks(60, 1, 0);
	check(Math.abs(rider.state.x - x0 - 210) < 2, "the next second on foot is a walk: 210 u", f1(rider.state.x - x0));
	// a flood of E presses: every command with three presses, for three seconds -- one on/off per cooldown at most
	const flood = addPlayer(sim, 2, 9000, 2040);
	park(world, 21, 9000, 2000);
	const df = driver(sim, flood);
	let toggles = 0;
	let was = false;
	for (let i = 0; i < 180; i++) {
		df.tick(0, 0, P.packEdges(0, 0, 3, 0));
		const now = sim.vehicles.riding(2);
		if (now !== was) toggles += 1;
		was = now;
	}
	check(
		toggles <= 3 / SV.MOUNT_COOLDOWN_S + 1,
		`180 ticks of triple E: at most one toggle per ${SV.MOUNT_COOLDOWN_S} s`,
		`${toggles}`,
	);
});

section("B3. fuel: the motorcycle burns the rider's oil; none, no engine; the bicycle burns nothing", () => {
	const { world, sim, events } = serverWith({ width: 30000 });
	const save = fueled(3);
	const sp = addPlayer(sim, 0, 1000, 2000, save);
	park(world, 22, 1000, 2040);
	const d = driver(sim, sp);
	d.tick(0, 0, PRESS_E);
	check(sim.vehicles.riding(0), "on the motorcycle with 3 oil");
	d.ticks(60 * 10, 1, 0);
	const perSecond = MOTO.oilIdle + MOTO.oilFull;
	checkEq(save.oil, 3 - Math.floor(10 * perSecond - 0.05), `10 s at full throttle burns ${f1(10 * perSecond)} oil`);
	let dryAt;
	for (let i = 0; i < 60 * 25 && save.oil > 0; i++) d.tick(1, 0);
	checkEq(save.oil, 0, "...and the tank runs dry");
	dryAt = { x: sp.state.x, v: V.rideSpeed(sp.state.ride) };
	d.ticks(60 * 6, 1, 0);
	const coast = sp.state.x - dryAt.x;
	const coastMax = (dryAt.v * dryAt.v) / (2 * MOTO.coast);
	checkEq(
		sp.state.ride?.speed,
		0,
		"with no oil the throttle does nothing: holding it, the motorcycle coasts to a stop",
	);
	check(
		dryAt.v === MOTO.topSpeed && Math.abs(coast - coastMax) < 10,
		`...from ${dryAt.v} u/s, in its coasting distance v²/2·coast = ${f1(coastMax)} u`,
		f1(coast),
	);
	d.tick(0, 0, PRESS_E);
	d.ticks(40);
	d.tick(0, 0, PRESS_E);
	check(!sim.vehicles.riding(0), "E at a motorcycle with an empty backpack: refused");
	check(
		events.some(e => e.kind === "refused" && e.why === "noOil"),
		"...and said why (noOil)",
	);
	// idling burns too, slowly: 1 a minute
	const idle = fueled(5);
	const sp2 = addPlayer(sim, 1, 20000, 2000, idle);
	park(world, 22, 20000, 2040);
	const d2 = driver(sim, sp2);
	d2.tick(0, 0, PRESS_E);
	d2.ticks(60 * 61);
	checkEq(idle.oil, 4, "a minute idling on it burns one oil");
	const pedals = fueled(0);
	const sp3 = addPlayer(sim, 2, 25000, 2000, pedals);
	park(world, 21, 25000, 2040);
	const d3 = driver(sim, sp3);
	d3.tick(0, 0, PRESS_E);
	d3.ticks(60 * 5, 1, 0);
	check(sim.vehicles.riding(2) && sp3.state.x > 25000 + BIKE.topSpeed * 3.5, "the bicycle needs no oil at all");
});

section("B4. crashes wear the vehicle and hurt the rider; broken, it is repaired with steel; never destroyed", () => {
	const { world, sim, events } = serverWith();
	W.addSolid(world, {
		kind: "wall_v",
		x: 5000,
		y: 0,
		w: 32,
		h: 8000,
		hp: 1,
		hpMax: 1,
		destructible: false,
		tags: "bwall",
	});
	const save = fueled(40);
	save.equipCloth = 3; // wooden armour, defence 4: a fall ignores it
	const sp = addPlayer(sim, 0, 1000, 2000, save);
	park(world, 22, 1000, 2040);
	const d = driver(sim, sp);
	d.tick(0, 0, PRESS_E);
	const hp0 = sp.state.hp;
	for (let i = 0; i < 600 && !events.some(e => e.kind === "crash"); i++) d.tick(1, 0);
	const crash = events.find(e => e.kind === "crash");
	check(
		crash !== undefined && crash.into === "solid" && crash.speed === MOTO.topSpeed,
		"into the wall at 510 u/s: a crash",
		JSON.stringify(crash),
	);
	checkEq(crash?.vehicleHp, MOTO.hpMax - MOTO.crashDamage, `the motorcycle lost ${MOTO.crashDamage} hp`);
	checkEq(
		Math.round(hp0 - sp.state.hp),
		MOTO.crashHurt,
		`the rider lost ${MOTO.crashHurt} (armour does not help: a fall)`,
	);
	check(sim.vehicles.riding(0), "a crash into a wall does not throw you off");
	// crash again and again until it breaks
	for (let n = 0; n < 12 && sim.vehicles.riding(0); n++) {
		d.ticks(40, -1, 0); // back off
		d.ticks(200, 1, 0); // and into the wall again
		sp.state.hp = sp.state.hpMax;
	}
	const crashes = events.filter(e => e.kind === "crash").length;
	check(!sim.vehicles.riding(0), `after ${crashes} crashes it broke and the rider got off`);
	const broken = vehiclesIn(world)[0];
	check(
		broken !== undefined && broken.hp >= 1 && broken.hp < broken.hpMax * V.BROKEN_RATIO,
		"it lies there broken, never below 1 hp (MP-11)",
		f1(broken?.hp),
	);
	check(
		events.some(e => e.kind === "dismounted" && e.why === "broken"),
		"the dismounted event says why (broken)",
	);
	d.ticks(40);
	// round to its far side from the wall: E acts on the NEAREST usable solid, and the wall is one
	sp.state.x = broken.x - 10;
	sp.state.y = broken.y + broken.h / 2;
	save.invenEtc[26] = 0;
	d.tick(0, 0, PRESS_E);
	check(!sim.vehicles.riding(0), "E at a broken vehicle does not ride it");
	save.invenEtc[26] = 2;
	const before = broken.hp;
	d.tick(0, 0, PRESS_E);
	check(
		broken.hp > before && save.invenEtc[26] === 1,
		"E with steel repairs it (+25%)",
		`${f1(before)} → ${f1(broken.hp)}`,
	);
	d.ticks(40);
	d.tick(0, 0, PRESS_E);
	check(sim.vehicles.riding(0), "repaired past 25%: E rides it again");
});

section(
	"B5. zombies: run into one at speed and you are thrown; slow, it stops you; behind, nothing; riders get bitten",
	() => {
		const { world, sim, events } = serverWith({ zombies: true, width: 12000, height: 6000, hour: 12 });
		const horde = sim.horde;
		const sp = addPlayer(sim, 0, 1000, 3000, fueled(40));
		sp.state.godMode = false;
		park(world, 22, 1000, 3040);
		const d = driver(sim, sp);
		d.tick(0, 0, PRESS_E);
		d.ticks(90, 1, 0);
		const z = createZombie(1, sp.state.x + 400, 3000, 1, false);
		horde.zombies.push(z);
		const hpBefore = sp.state.hp;
		for (let i = 0; i < 120 && sim.vehicles.riding(0); i++) d.tick(1, 0);
		const thrown = events.find(e => e.kind === "dismounted" && e.why === "thrown");
		check(thrown !== undefined, "a walker ahead at top speed: thrown off");
		check(z.hp < 100, "...the walker took the ram", `${f1(z.hp)} hp left`);
		check(sp.state.hp < hpBefore, "...the rider took the fall", `${f1(hpBefore - sp.state.hp)}`);
		const crash = events.find(e => e.kind === "crash" && e.into === "zombie");
		check(
			crash !== undefined && crash.vehicleHp < MOTO.hpMax,
			"...the motorcycle took the crash, and lies there",
			f1(crash?.vehicleHp),
		);
		checkEq(vehiclesIn(world).length, 1, "the motorcycle is parked where it happened");
		// slow into a zombie: a bump, no throw, no damage
		horde.zombies.length = 0;
		const b = addPlayer(sim, 1, 6000, 1000, fueled(40));
		park(world, 21, 6000, 1040);
		const db = driver(sim, b);
		db.tick(0, 0, PRESS_E);
		db.ticks(20, 1, 0);
		const slow = createZombie(1, b.state.x + BIKE.radius + 20, 1000, 1, false);
		slow.detect = false;
		horde.zombies.push(slow);
		for (let i = 0; i < 30; i++) db.tick(1, 0);
		check(sim.vehicles.riding(1), `a bicycle below ${BIKE.crashSpeed} u/s into a walker: still riding`);
		checkEq(slow.hp, 100, "...and the walker is not hurt");
		check(
			b.state.ride.speed * V.SPEED_STEP < BIKE.crashSpeed,
			"...the walker stopped it",
			V.rideSpeed(b.state.ride),
		);
		// a zombie behind never stops a vehicle
		horde.zombies.length = 0;
		const c = addPlayer(sim, 2, 9000, 5000, fueled(40));
		park(world, 21, 9000, 5040);
		const dc = driver(sim, c);
		dc.tick(0, 0, PRESS_E);
		dc.ticks(40, 1, 0);
		const tail = createZombie(1, c.state.x - BIKE.radius - 10, 5000, 1, false);
		horde.zombies.push(tail);
		const v0 = c.state.ride.speed;
		dc.tick(1, 0);
		check(c.state.ride.speed >= v0, "a walker right behind: no bump");
		// bitten while riding: a rider is a survivor like any other
		horde.zombies.length = 0;
		dc.ticks(120, 0, 0);
		const biter = createZombie(1, c.state.x + 30, c.state.y, 1, false);
		biter.detect = true;
		horde.zombies.push(biter);
		const hp1 = c.state.hp;
		dc.ticks(180, 0, 0);
		check(
			c.state.hp < hp1 && sim.vehicles.riding(2),
			"a walker next to a stopped rider bites (and the rider stays on)",
			`${f1(hp1 - c.state.hp)} hp`,
		);
	},
);

section("B6. noise: the motorcycle's engine and horn are an event the horde hears; the bicycle's bell is small", () => {
	const hear = item => {
		const { world, sim, noises } = serverWith({ zombies: true, width: 6000, height: 6000, hour: 12 });
		// a wall between them: the zombie cannot see the rider, only hear
		W.addSolid(world, {
			kind: "wall_v",
			x: 3150,
			y: 2000,
			w: 32,
			h: 2000,
			hp: 1,
			hpMax: 1,
			destructible: false,
			tags: "bwall",
		});
		const sp = addPlayer(sim, 0, 3000, 3000, fueled(40));
		park(world, item, 3000, 3040);
		const z = createZombie(1, 3350, 3000, 1, false);
		z.detect = false;
		z.angle = 0; // facing away
		sim.horde.zombies.push(z);
		const d = driver(sim, sp);
		d.tick(0, 0, PRESS_E);
		d.ticks(60 * 3);
		return { z, noises, sim };
	};
	const moto = hear(22);
	const engine = moto.noises.filter(n => n.source === "engine");
	check(engine.length >= 5, "the idling motorcycle rings every half second", `${engine.length} rings in 3 s`);
	checkEq(engine[0]?.radius, MOTO.noiseIdle, `...a ring of ${MOTO.noiseIdle} u at idle`);
	check(moto.z.detect === true, "a walker 350 u away behind a wall hears it and comes to look");
	const bike = hear(21);
	check(bike.noises.filter(n => n.source === "engine").length === 0, "the bicycle has no engine");
	check(bike.z.detect !== true, "...and the same walker never notices the stopped bicycle");
	// full throttle: the ring grows with speed
	const { world, sim, noises } = serverWith({ width: 20000 });
	const sp = addPlayer(sim, 0, 1000, 2000, fueled(40));
	park(world, 22, 1000, 2040);
	const d = driver(sim, sp);
	d.tick(0, 0, PRESS_E);
	d.ticks(120, 1, 0);
	const last = noises.filter(n => n.source === "engine").at(-1);
	checkEq(last?.radius, MOTO.noiseFull, `at top speed the ring is ${MOTO.noiseFull} u`);
	d.tick(1, 0, PRESS_ATTACK);
	const horn = noises.find(n => n.source === "horn");
	checkEq(horn?.radius, MOTO.hornRadius, "the attack button is the horn");
	d.tick(1, 0, PRESS_ATTACK);
	checkEq(noises.filter(n => n.source === "horn").length, 1, `...at most once a ${SV.HORN_COOLDOWN_S} s`);
});

section("B7. no weapon on a vehicle: the combat gets no attack, the button is the horn", () => {
	const { world, sim, noises } = serverWith({ zombies: true, width: 8000, height: 8000 });
	const { WEAPONS } = require(join(SRC, "shared/data/weapons.ts"));
	const PISTOL = WEAPONS.find(w => w.name === "Pistol").id;
	const save = fueled(40);
	save.invenWeapon[PISTOL] = 1;
	save.equipWeapon = PISTOL;
	save.ammoNormal = 50;
	const sp = addPlayer(sim, 0, 1000, 1000, save);
	sp.state.godMode = true;
	sp.state.weapon.pointer = PISTOL;
	sp.state.weapon.ammoCount = WEAPONS[PISTOL].mag;
	park(world, 21, 1000, 1040);
	const d = driver(sim, sp);
	d.tick(0, 0, PRESS_E);
	check(sim.vehicles.riding(0), "on the bicycle with a loaded pistol");
	const mag = sp.state.weapon.ammoCount;
	const shots = sim.combat.statsOf(0).shots ?? 0;
	for (let i = 0; i < 60; i++) d.tick(0, 0, i % 20 === 0 ? PRESS_ATTACK : 0, P.HeldBit.Attack);
	checkEq(sp.state.weapon.ammoCount, mag, "a second of the trigger: not one round fired");
	checkEq(sim.combat.statsOf(0).shots ?? 0, shots, "...and the combat counted no shot");
	check(
		noises.some(n => n.source === "horn" && n.radius === BIKE.hornRadius),
		"the bell rang instead",
	);
	// the gate is the ride, nothing else: off the bicycle, the same trigger fires
	d.ticks(30);
	d.tick(0, 0, PRESS_E);
	check(!sim.vehicles.riding(0), "off the bicycle");
	d.ticks(30);
	for (let i = 0; i < 60; i++) d.tick(0, 0, i % 20 === 0 ? PRESS_ATTACK : 0, P.HeldBit.Attack);
	check(
		(sim.combat.statsOf(0).shots ?? 0) > shots,
		"on foot the same presses shoot",
		`${sim.combat.statsOf(0).shots} shots`,
	);
});

section("B8. leaving, dying and a new world never take a vehicle out of the town", () => {
	const { world, sim, events } = serverWith();
	const sp = addPlayer(sim, 0, 1000, 1000);
	park(world, 21, 1000, 1040, 0, 3);
	const d = driver(sim, sp);
	d.tick(0, 0, PRESS_E);
	d.ticks(30, 1, 0);
	sim.remove(0);
	check(!sim.vehicles.riding(0) && sp.state.ride === undefined, "leaving the world: off");
	const left = vehiclesIn(world);
	check(
		left.length === 1 && Math.abs(left[0].x + left[0].w / 2 - sp.state.x) < 1,
		"...the bicycle stays where they were",
	);
	checkEq(left[0]?.owner, 3, "...still its builder's");
	const sp2 = addPlayer(sim, 1, left[0].x + left[0].w / 2, left[0].y - 30);
	const d2 = driver(sim, sp2);
	d2.tick(0, 0, PRESS_E);
	check(sim.vehicles.riding(1), "somebody else gets on it (anyone may ride, one at a time)");
	sp2.state.hp = -5;
	d2.tick(1, 0);
	d2.tick(1, 0);
	check(!sim.vehicles.riding(1), "dead: off");
	check(
		events.some(e => e.kind === "dismounted" && e.why === "dead"),
		"...the event says so",
	);
	checkEq(vehiclesIn(world).length, 1, "...and the bicycle is back in the world");
});

section("B9. replication: the rider's own ride in the self block, the vehicle under every other survivor", () => {
	const { world, sim } = serverWith();
	const a = addPlayer(sim, 0, 1000, 1000);
	const b = addPlayer(sim, 1, 1200, 1000);
	park(world, 22, 1000, 1040);
	const d = driver(sim, a);
	d.tick(0, 0, PRESS_E);
	for (let i = 0; i < 90; i++) d.tick(Math.cos(i / 30), Math.sin(i / 30));
	const self = REP.selfBlockOf(sim, a);
	checkEq(self.ride, V.packRide(a.state.ride), "self block: the exact ride key");
	const other = REP.playerBlockOf(a);
	checkEq(other.ride, VehicleKind.Motorcycle, "player block: the vehicle kind");
	check(Math.abs(other.moveAng - V.rideHeading(a.state.ride)) < 1e-9, "...and its heading in moveAng");
	const snap = { tick: sim.tick, self: REP.selfBlockOf(sim, b), players: [other], zombies: [], bosses: [] };
	const part = P.decodeSnapshotPart(P.encodeSnapshot(snap).parts[0]);
	checkEq(
		part.players[0].ride,
		VehicleKind.Motorcycle,
		"through the wire: the other client learns it rides a motorcycle",
	);
	const err = Math.abs(
		((part.players[0].moveAng - V.rideHeading(a.state.ride) + Math.PI * 3) % (Math.PI * 2)) - Math.PI,
	);
	check(err < (Math.PI * 2) / 256, "...facing where it faces (u8 angle)", err.toFixed(4));
	checkEq(part.self.ride, 0, "...and b's own block says b is on foot");
	const mine = P.decodeSnapshotPart(P.encodeSnapshot({ ...snap, self }).parts[0]);
	checkEq(mine.self.ride, self.ride, "a's own block through the wire: bit-exact");
});

// ================================================================ the end

console.log(
	`\n[test-vehicles] ${checks - failures}/${checks} checks passed${failures > 0 ? `, ${failures} FAILED` : ""}`,
);
process.exit(failures > 0 ? 1 : 0);
