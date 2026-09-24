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
 *   C. THE CLIENT: the prediction replays a ride from the server's self block to within RECONCILE_EPS while it
 *      accelerates, weaves and brakes (client/net/prediction.ts); a client that pretends to ride is rewound to a
 *      walk; another client's snapshot buffer carries the rider's vehicle and heading; the vehicle is drawn inside
 *      its footprint, under its rider, whose hands hold the bars and no weapon, with no Instance after warm-up --
 *      flat (no ids: ART-01) and from the uploaded art (the vehicles' sprites, the survivors' sheets: the rider's
 *      body cell and no weapon cell).
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
	// stepPlayer answers in one shared table (shared/sim/playerMove.ts): keeping them means copying them
	for (let i = 0; i < n; i++) out.push({ ...stepPlayer(world, r.p, r.save, cmdOf(i), DT) });
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

section("B1b. E for a window's glass is for the glass only: the bicycle parked under it is not ridden (EDI-18)", () => {
	const WIN = require(join(SRC, "shared/game/windows.ts"));
	const { world, sim } = serverWith();
	// a shop front along y = 1000 with a pane in it (1000..1080), a bicycle parked just inside, both in E's reach; the
	// wall and the glass are a building's (parentId), as the town lays them
	const wall = x =>
		W.addSolid(world, {
			kind: "wall_h",
			x,
			y: 1000,
			w: 100,
			h: 20,
			hp: 999999,
			hpMax: 999999,
			destructible: false,
			tags: "bwall",
			parentId: 1,
		});
	wall(900);
	const pane = W.addSolid(world, {
		kind: "window",
		x: 1000,
		y: 1000,
		w: 80,
		h: 20,
		hp: WIN.GLASS_HITS,
		hpMax: WIN.GLASS_HITS,
		destructible: false,
		tags: "window",
		parentId: 1,
	});
	wall(1080);
	park(world, 21, 1040, 1080, 0);
	const sp = addPlayer(sim, 0, 1040, 1040);
	const d = driver(sim, sp);
	checkEq(
		interactTarget(world, sp.state.x, sp.state.y)?.kind,
		"vehicle",
		"a plain E there would take the bicycle (the HUD's query)",
	);
	// the press whose hint was the window (HeldBit.Glass, protocol.ts note 23)
	d.tick(0, 0, PRESS_E, P.HeldBit.Glass);
	check(
		WIN.windowBroken(pane) && !sim.vehicles.riding(0) && sp.state.ride === undefined,
		"the E for the glass breaks the pane and nobody gets on the bicycle (the review of b61425a)",
		`pane ${WIN.windowBroken(pane) ? "broken" : "intact"}, riding ${sim.vehicles.riding(0)}`,
	);
	d.ticks(40);
	d.tick(0, 0, PRESS_E);
	check(sim.vehicles.riding(0), "and a plain E afterwards rides it, as ever");
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
	// that refused repair was a press the interaction heard: its PRESS_COOLDOWN_S holds the next one
	d.tick(0, 0, PRESS_E);
	check(
		broken.hp === before && save.invenEtc[26] === 2,
		"E at once: inside the interaction's press cooldown, nothing",
	);
	d.ticks(15);
	d.tick(0, 0, PRESS_E);
	check(
		broken.hp > before && save.invenEtc[26] === 1,
		"E with steel repairs it (+25%)",
		`${f1(before)} → ${f1(broken.hp)}`,
	);
	// the very next tick: getting on is the vehicle's rule (MOUNT_COOLDOWN_S since the last on/off), never the
	// interaction's press cooldown the repair just spent
	d.tick(0, 0, PRESS_E);
	check(sim.vehicles.riding(0), "repaired past 25%: E rides it again, on the next tick");
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
		// 250 u off, well inside the idle ring of 400 even after an idle walker's wander (IA-03) in the time it spreads
		const z = createZombie(1, 3250, 3000, 1, false);
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
	// IA-03: a noise says where it came from, never where you are -- the walker goes to look (suspicious or searching),
	// and only its eyes would make that a chase
	check(
		(moto.z.aware ?? 0) >= 1,
		"a walker 250 u away behind a wall hears it and comes to look",
		`aware ${moto.z.aware ?? 0}`,
	);
	const bike = hear(21);
	check(bike.noises.filter(n => n.source === "engine").length === 0, "the bicycle has no engine");
	check(
		(bike.z.aware ?? 0) === 0 && bike.z.detect !== true,
		"...and the same walker never notices the stopped bicycle",
		`aware ${bike.z.aware ?? 0}`,
	);
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

// ================================================================ C. the client: prediction, the others, the drawing

const { Prediction } = require(join(SRC, "client/net/prediction.ts"));
const { SnapshotBuffer } = require(join(SRC, "client/net/snapshotBuffer.ts"));
const { seqNewer } = require(join(SRC, "shared/net/codec.ts"));
const { RECONCILE_EPS } = require(join(SRC, "shared/net/mpConfig.ts"));

/** the server's self block for `sp`, through the real wire (encode → decode) */
function selfThroughWire(sim, sp) {
	const snap = { tick: sim.tick, self: REP.selfBlockOf(sim, sp), players: [], zombies: [], bosses: [] };
	return P.decodeSnapshotPart(P.encodeSnapshot(snap).parts[0]).self;
}

/**
 * A client predicting its survivor against the real server, `latency` ticks each way: its commands reach the server
 * that much later, the self block comes back that much later, and every self block is reconciled with the commands
 * the server has not simulated yet (§2.2).
 */
function predictedSession({ latency = 6, oil = 40, x = 2000, y = 3000 } = {}) {
	const { world, sim, events } = serverWith({ width: 16000, height: 8000 });
	const sp = addPlayer(sim, 0, x, y, fueled(oil));
	const clientWorld = W.createWorld(16000, 8000);
	const clientSave = fueled(oil);
	const me = Ply.createPlayer(clientSave, x, y);
	const pred = new Prediction();
	pred.attach(clientWorld, me, clientSave);
	const up = [];
	const down = [];
	const sent = [];
	let seq = 1000;
	let t = 0;
	const errs = [];
	return {
		world,
		sim,
		sp,
		me,
		pred,
		events,
		errs,
		/** one tick: the client makes and predicts a command, the server runs, the wire delivers what is due */
		tick(mx, my, edges = 0) {
			seq += 1;
			t += 1;
			const cmd = P.makeCommand(seq, mx, my, 0, 0, edges);
			pred.restoreExact();
			pred.step(cmd);
			sent.push(cmd);
			up.push({ at: t + latency, cmd });
			while (up.length > 0 && up[0].at <= t) {
				const { cmd: c } = up.shift();
				PL.ingestInput(sp, P.encodeInput({ viewTick: 0, viewFrac: 0, cmds: [c] }), t / 60);
			}
			sim.step();
			down.push({ at: t + latency, block: selfThroughWire(sim, sp) });
			while (down.length > 0 && down[0].at <= t) {
				const { block } = down.shift();
				while (sent.length > 0 && !seqNewer(sent[0].seq, block.ackSeq)) sent.shift();
				pred.reconcile(block, sent, t / 60);
				errs.push(pred.stats().last);
			}
		},
	};
}

section(
	"B10. the Rider achievement: a point per 10 u the server moved a rider, on either vehicle, never on foot",
	() => {
		const { AchievementId, ACHIEVEMENTS, achievementOn } = require(join(SRC, "shared/data/achievements.ts"));
		const { RIDER_UNITS_PER_POINT } = require(join(SRC, "server/save/achievements.ts"));
		const RIDER = AchievementId.Rider;
		check(achievementOn(RIDER), "Rider is on view (CON-04: its content works now)");
		checkEq(RIDER_UNITS_PER_POINT, 10, "a point per 10 u: the original's 10 px (1 px = 1 u)");
		const { world, sim, events } = serverWith({ width: 30000 });
		const walker = addPlayer(sim, 1, 1000, 3000);
		driver(sim, walker).ticks(120, 1, 0);
		checkEq(walker.save.achievements[RIDER], 0, "two seconds of walking: nothing");
		for (const item of [21, 22]) {
			const sp = addPlayer(sim, 0, 1000, 2000, fueled(20));
			sp.save.achievements[RIDER] = 0;
			park(world, item, 1000, 2040);
			const d = driver(sim, sp);
			d.tick(0, 0, PRESS_E);
			const from = events.length;
			d.ticks(60 * 6, 1, 0);
			d.ticks(60, 0, 0);
			d.tick(0, 0, PRESS_E);
			check(!sim.vehicles.riding(0), `${ETC_NAME[item]}: ridden 6 s and left`);
			const ridden = events
				.slice(from)
				.filter(e => e.kind === "distance")
				.reduce((a, e) => a + e.units, 0);
			const got = sp.save.achievements[RIDER];
			check(
				ridden > 1000 && got === Math.floor(ridden / RIDER_UNITS_PER_POINT),
				`${ETC_NAME[item]}: the odometer's ${f1(ridden)} u are ${Math.floor(ridden / 10)} points, the remainder carried`,
				`${got}`,
			);
			sim.remove(0);
			for (const s of vehiclesIn(world)) W.removeSolid(world, s);
		}
		// the goal is a ceiling
		const sp = addPlayer(sim, 0, 1000, 2000, fueled(20));
		const max = ACHIEVEMENTS[RIDER].max;
		sp.save.achievements[RIDER] = max - 3;
		park(world, 22, 1000, 2040);
		const d = driver(sim, sp);
		d.tick(0, 0, PRESS_E);
		d.ticks(60 * 3, 1, 0);
		d.tick(0, 0, PRESS_E);
		checkEq(sp.save.achievements[RIDER], max, `...and it stops at its goal (${max})`);
		sim.remove(0);
		for (const s of vehiclesIn(world)) W.removeSolid(world, s);
		// §9.3 (the verification of 2026-09-24): an assisted run rides as far as it likes and earns no Road Trip point,
		// as it earns no coins -- the ride's odometer still turns (the `distance` events), the achievement does not
		sim.paysRewards = () => false;
		const helped = addPlayer(sim, 0, 1000, 2000, fueled(20));
		helped.save.achievements[RIDER] = 0;
		park(world, 22, 1000, 2040);
		const dh = driver(sim, helped);
		dh.tick(0, 0, PRESS_E);
		const from = events.length;
		dh.ticks(60 * 4, 1, 0);
		dh.tick(0, 0, PRESS_E);
		const ridden = events
			.slice(from)
			.filter(e => e.kind === "distance")
			.reduce((a, e) => a + e.units, 0);
		check(
			ridden > 500 && helped.save.achievements[RIDER] === 0,
			"an assisted run: ridden, and no Road Trip point (§9.3)",
			`${f1(ridden)} u, Rider ${helped.save.achievements[RIDER]}`,
		);
		sim.paysRewards = undefined;
	},
);

section(
	"B11. security review of 5874cfa: presence, fuel debt, ram credit, step-aside, reach, body swap, E priority",
	() => {
		const { WEAPONS } = require(join(SRC, "shared/data/weapons.ts"));
		const { AchievementId } = require(join(SRC, "shared/data/achievements.ts"));
		const wall = (world, x, y, w, h) =>
			W.addSolid(world, { kind: "wall", x, y, w, h, hp: 1e6, hpMax: 1e6, destructible: false, tags: "bwall" });

		// V1: riding with the stick is presence (the day's credit, MP-13); the step itself still does not "walk"
		{
			const { world, sim } = serverWith({ width: 30000 });
			const sp = addPlayer(sim, 0, 1000, 2000, fueled(40));
			park(world, 21, 1000, 2040);
			const d = driver(sim, sp);
			d.tick(0, 0, PRESS_E);
			d.ticks(60 * 10, 1, 0);
			check(sim.vehicles.riding(0), "V1: ten seconds on the bicycle, stick held");
			check(sim.idleSeconds(sp) < 0.5, "V1: ...and the server does not count them idle", f1(sim.idleSeconds(sp)));
			const steps = ride(wallWorld(), rider(VehicleKind.Bicycle), 60, i => stick(i + 1, 1, 0));
			check(
				steps.every(r => !r.walking) && steps[59].moved > 0,
				"V1: ...while the step itself never walks (no feet, no footsteps)",
			);
			d.ticks(60 * 5, 0, 0);
			check(sim.idleSeconds(sp) > 4, "V1: five seconds coasting with no stick are idle", f1(sim.idleSeconds(sp)));
		}

		// V2: the unburnt fraction stays with the slot: getting off every 8 s does not ride for free
		{
			const world = W.createWorld(3000, 3000);
			const save = fueled(30);
			const p = Ply.createPlayer(save, 1000, 1000);
			const sp = { slot: 0, state: p, save, userId: 1 };
			const veh = new SV.ServerVehicles({ world });
			park(world, 22, 1000, 1030);
			let ridden = 0;
			let cycles = 0;
			for (let cycle = 0; cycle < 20; cycle++) {
				for (let i = 0; i < 40; i++) veh.step(DT);
				if (!veh.tryMount(sp)) break;
				cycles += 1;
				for (let t = 0; t < 8 * 60; t++) {
					p.ride.speed = V.topSteps(MOTO);
					veh.afterStep(sp, { moved: 0, walking: false, died: false }, [], DT);
					veh.step(DT);
					ridden += DT;
				}
				veh.getOff(sp);
			}
			const owed = ridden * (MOTO.oilIdle + MOTO.oilFull);
			check(
				cycles === 20 && 30 - save.oil === Math.floor(owed + 1e-6),
				`V2: 20 rides of 8 s at top speed, off and on between them, burn the ${f1(owed)} oil they owe`,
				`${30 - save.oil} burnt in ${cycles} rides`,
			);
		}

		// V3: a zombie killed by the vehicle is nobody's weapon: Street Sweeper, never Long Shot for the holstered rifle
		{
			const { world, sim } = serverWith({ zombies: true, width: 12000, height: 6000, hour: 12 });
			const sniper = WEAPONS.find(w => w.kind === 5);
			const save = fueled(40);
			save.invenWeapon[sniper.id] = 1;
			save.equipWeapon = sniper.id;
			const sp = addPlayer(sim, 0, 1000, 3000, save);
			sp.state.godMode = false;
			park(world, 22, 1000, 3040);
			const d = driver(sim, sp);
			d.tick(0, 0, PRESS_E);
			d.ticks(90, 1, 0);
			sim.horde.zombies.length = 0;
			const z = createZombie(1, sp.state.x + 300, sp.state.y, 1, false);
			z.hp = 5;
			// held in the rider's lane (an idle walker wanders since IA-03): the question is the credit, not the aim
			z.stunned = 1e6;
			sim.horde.zombies.push(z);
			for (let i = 0; i < 90 && sim.vehicles.riding(0); i++) d.tick(1, 0);
			const a = save.achievements;
			check(
				z.hp <= 0 && a[AchievementId.ZombieSlayer] === 1 && a[AchievementId.Sniper] === 0,
				`V3: run over with a ${sniper.name} holstered: the kill counts, for no weapon`,
				`hp ${z.hp}, slayer ${a[AchievementId.ZombieSlayer]}, sniper ${a[AchievementId.Sniper]}`,
			);
		}

		// NIT: getting off never steps through a wall or a closed door (the reviewer's vestibule)
		{
			const world = W.createWorld(3000, 3000);
			wall(world, 900, 1000, 200, 20); // across the way ahead
			wall(world, 930, 880, 40, 120); // left
			wall(world, 1030, 880, 40, 120); // right
			wall(world, 980, 900, 40, 40); // behind
			const save = fueled(10);
			const p = Ply.createPlayer(save, 1000, 1300);
			const sp = { slot: 0, state: p, save, userId: 1 };
			const veh = new SV.ServerVehicles({ world });
			park(world, 22, 1000, 1330);
			check(veh.tryMount(sp), "NIT: on the motorcycle (below the wall)");
			p.x = 1000;
			p.y = 1000 - MOTO.radius - 0.01;
			p.ride.heading = V.quantHeading(Math.PI / 2);
			for (let i = 0; i < 40; i++) veh.step(DT);
			veh.getOff(sp);
			check(
				!veh.riding(0) && p.y < 1000,
				"NIT: boxed in against the wall, E leaves the rider on this side",
				f1(p.y),
			);
		}

		// NIT: E does not get on across a closed door (thin enough for the vehicle to be in reach behind it)
		{
			const { world, sim } = serverWith();
			W.addSolid(world, {
				kind: "door",
				x: 900,
				y: 1000,
				w: 200,
				h: 6,
				hp: 100,
				hpMax: 100,
				destructible: true,
				tags: "door",
				open: false,
			});
			park(world, 21, 1000, 1000 + 6 + 1 + BIKE.width / 2);
			const sp = addPlayer(sim, 0, 1000, 1000 - 31);
			const d = driver(sim, sp);
			checkEq(
				interactTarget(world, sp.state.x, sp.state.y)?.kind,
				"vehicle",
				"NIT: the bike behind the door is in reach",
			);
			d.tick(0, 0, PRESS_E);
			check(!sim.vehicles.riding(0), "NIT: ...and E does not get on it through the closed door");
		}

		// NIT: a new body while riding (a stand-up, a resumed body) parks the vehicle where the old body rode
		{
			const { world, sim, events } = serverWith();
			const sp = addPlayer(sim, 0, 1000, 2000, fueled(40));
			park(world, 21, 1000, 2040);
			const d = driver(sim, sp);
			d.tick(0, 0, PRESS_E);
			d.ticks(60, 1, 0);
			const rodeTo = { x: sp.state.x, y: sp.state.y };
			sp.state = Ply.createPlayer(sp.save, 5000, 5000);
			d.tick(0, 0);
			const parked = vehiclesIn(world)[0];
			const cx = parked === undefined ? NaN : parked.x + parked.w / 2;
			check(
				!sim.vehicles.riding(0) &&
					sp.state.ride === undefined &&
					Math.abs(cx - rodeTo.x) < 2 &&
					events.some(e => e.kind === "dismounted" && e.why === "left"),
				"NIT: the bicycle stays where it was ridden, not at the new body",
				`${f1(cx)} vs ${f1(rodeTo.x)}`,
			);
			check(sp.state.x === 5000 && sp.state.y === 5000, "NIT: ...and the new body does not step aside from it");
		}

		// NIT: a parked vehicle does not take E from a door in reach, nor from the loot of the building you stand in
		{
			const world = W.createWorld(3000, 3000);
			const door = W.addSolid(world, {
				kind: "door",
				x: 1000,
				y: 960,
				w: 96,
				h: 24,
				hp: 100,
				hpMax: 100,
				destructible: true,
				tags: "door",
				open: false,
			});
			park(world, 21, 1048, 1010);
			const at = { x: 1048, y: 1010 };
			checkEq(
				interactTarget(world, at.x, at.y)?.kind,
				"door",
				"NIT: on a bike left in a doorway, E is the door's",
			);
			door.open = true;
			checkEq(
				interactTarget(world, at.x, at.y)?.solid?.id,
				door.id,
				"NIT: ...open or closed (it is still the door)",
			);
			const house = W.addSolid(world, {
				kind: "building",
				x: 1800,
				y: 1800,
				w: 400,
				h: 400,
				hp: 1,
				hpMax: 1,
				destructible: false,
				passable: true,
				lootItems: [{ kind: 4, id: 23, count: 1 }],
			});
			park(world, 21, 2000, 2000);
			checkEq(interactTarget(world, 2000, 2000)?.kind, "search", "NIT: a bike parked indoors: E searches first");
			house.lootItems = [];
			checkEq(interactTarget(world, 2000, 2000)?.kind, "vehicle", "NIT: ...and rides it once the house is empty");
		}
	},
);

section("B12. the motorcycle's headlight (LUZ-04): ONE cone for the horde, the light map and an ally's view", () => {
	const Light = require(join(SRC, "shared/sim/survivorLight.ts"));
	const MOTO_DEF = vehicleDef(VehicleKind.Motorcycle);
	check(
		MOTO_DEF.headlight > Light.FLASHLIGHT_REACH,
		"the headlight reaches further than the flashlight",
		`${MOTO_DEF.headlight} u`,
	);
	checkEq(vehicleDef(VehicleKind.Bicycle).headlight, 0, "the bicycle has none");
	// the rule: riding a motorcycle, the beam is the headlight along the RIDE (not the aim); on foot, the flashlight
	const save = fueled(20);
	const p = Ply.createPlayer(save, 0, 0);
	p.angle = Math.PI;
	p.ride = { kind: VehicleKind.Motorcycle, heading: V.quantHeading(0), speed: 0 };
	checkEq(Light.survivorBeamReach(p, save), MOTO_DEF.headlight, "on the motorcycle: the headlight's reach");
	check(Math.abs(Light.survivorBeamAngle(p)) < 1e-6, "...along the ride's heading, whatever the aim");
	p.ride = { kind: VehicleKind.Bicycle, heading: 0, speed: 0 };
	checkEq(Light.survivorBeamReach(p, save), 0, "on the bicycle, no beam (no flashlight in hand either)");
	p.ride = undefined;
	check(Light.survivorBeamAngle(p) === Math.PI, "on foot the beam, if any, follows the aim");

	// the server: at 23:00, a walker 500 u AHEAD of a stopped rider is lit (drawn, sent); one 500 u behind is not
	const lit = item => {
		const { world, sim } = serverWith({ zombies: true, width: 8000, height: 8000, hour: 23 });
		const sp = addPlayer(sim, 0, 4000, 4000, fueled(40));
		park(world, item, 4000, 4040);
		const d = driver(sim, sp);
		d.tick(0, 0, PRESS_E);
		// point the rider at +x (the stick sets the heading), then stop
		d.ticks(40, 1, 0);
		d.ticks(120, 0, 0);
		const h = V.rideHeading(sp.state.ride);
		const ahead = createZombie(1, sp.state.x + Math.cos(h) * 500, sp.state.y + Math.sin(h) * 500, 1, false);
		const behind = createZombie(1, sp.state.x - Math.cos(h) * 500, sp.state.y - Math.sin(h) * 500, 1, false);
		ahead.alpha = 0;
		behind.alpha = 0;
		sim.horde.zombies.length = 0;
		sim.horde.zombies.push(ahead, behind);
		d.ticks(30, 0, 0);
		return { ahead: ahead.alpha, behind: behind.alpha };
	};
	const moto = lit(22);
	check(
		moto.ahead > 0.9 && moto.behind < 0.1,
		"night, on the motorcycle: the walker ahead is lit, the one behind is not",
		`${moto.ahead.toFixed(2)} / ${moto.behind.toFixed(2)}`,
	);
	const bike = lit(21);
	check(
		bike.ahead < 0.1,
		"on the bicycle (no headlight), the same walker stays in the dark",
		`${bike.ahead.toFixed(2)}`,
	);

	// the screen: an ally riding a motorcycle lights their headlight's cone along the ride (playersView.collectLights)
	const { LightList, addAllyLight } = require(join(SRC, "client/view/lightList.ts"));
	const lights = new LightList();
	const ally = {
		userId: 5,
		x: 100,
		y: 100,
		angle: Math.PI,
		dead: false,
		flashlight: false,
		ride: VehicleKind.Motorcycle,
		rideHeading: 0.5,
	};
	addAllyLight(lights, ally);
	const cone = lights.items.find(l => l.cone !== undefined);
	check(
		cone !== undefined &&
			cone.r === MOTO_DEF.headlight &&
			Math.abs(cone.angle - 0.5) < 1e-9 &&
			cone.cone === Light.CONE_HALF_ANGLE,
		"an ally on a motorcycle: the headlight's cone, along their ride, as wide as the server's",
		cone === undefined ? "no cone" : `${cone.r} u at ${cone.angle}`,
	);
});

section("C1. prediction: the client replays the ride from the server's own numbers, to the bit", () => {
	const s = predictedSession();
	park(s.world, 22, 2000, 3040);
	s.tick(0, 0, PRESS_E);
	let mountedAt;
	for (let i = 0; i < 40; i++) {
		s.tick(0, 0);
		if (mountedAt === undefined && s.me.ride !== undefined) mountedAt = i;
	}
	check(s.sim.vehicles.riding(0), "the server put the survivor on the motorcycle");
	check(
		mountedAt !== undefined && s.me.ride?.kind === VehicleKind.Motorcycle,
		"the client learnt it from the self block",
		`after ${mountedAt} ticks`,
	);
	const from = s.errs.length;
	// ten seconds of riding: full throttle, weaving, braking round, coasting
	for (let i = 0; i < 600; i++) {
		const a = Math.sin(i / 40) * 1.2 + (i > 300 && i < 360 ? Math.PI : 0);
		if (i % 150 > 130) s.tick(0, 0);
		else s.tick(Math.cos(a), Math.sin(a));
	}
	const riding = s.errs.slice(from + 12);
	const worst = Math.max(...riding);
	check(riding.length > 500, "reconciled every tick while riding", `${riding.length}`);
	check(
		worst <= RECONCILE_EPS,
		`predicted vs server at every ack: ≤ ${RECONCILE_EPS} u (no correction at all)`,
		`worst ${worst.toExponential(2)} u`,
	);
	// and off again: E, the server lets them off, the client walks
	s.tick(0, 0, PRESS_E);
	for (let i = 0; i < 20; i++) s.tick(0, 0);
	check(
		!s.sim.vehicles.riding(0) && s.me.ride === undefined,
		"E: off on the server, and on the client from the self block",
	);
});

section("C2. a client that pretends to ride goes at a walk: the server never granted the ride", () => {
	const s = predictedSession();
	// a modified client puts itself on a motorcycle at top speed, with no vehicle anywhere
	s.me.ride = { kind: VehicleKind.Motorcycle, heading: 0, speed: V.topSteps(MOTO) };
	const x0 = s.sp.state.x;
	const consumed0 = s.sp.counters.consumed;
	for (let i = 0; i < 120; i++) s.tick(1, 0);
	const serverRan = s.sp.state.x - x0;
	const commands = s.sp.counters.consumed - consumed0;
	check(
		Math.abs(serverRan - (commands * 210) / 60) < 1,
		`the server moved it at a walk: ${commands} commands × 210 u/s`,
		f1(serverRan),
	);
	check(s.me.ride === undefined, "the self block took the ride away from the client");
	check(
		s.pred.stats().replays >= 1,
		"the client was rewound to the server's walk",
		`${s.pred.stats().replays} replays`,
	);
	check(
		Math.abs(s.pred.exact().x - s.sp.state.x) < (210 * 7) / 60,
		"and it predicts from where the server has it (one latency of walking ahead)",
		f1(s.pred.exact().x - s.sp.state.x),
	);
});

section("C3. the others see the rider: the kind and the heading through the snapshot buffer", () => {
	const { world, sim } = serverWith({ width: 16000 });
	const a = addPlayer(sim, 0, 2000, 2000);
	const b = addPlayer(sim, 1, 2300, 2000);
	park(world, 21, 2000, 2040);
	const d = driver(sim, a);
	d.tick(0, 0, PRESS_E);
	const buffer = new SnapshotBuffer();
	const headings = new Map();
	for (let i = 0; i < 180; i++) {
		d.tick(Math.cos(i / 25), Math.sin(i / 25));
		headings.set(sim.tick, V.rideHeading(a.state.ride));
		if (sim.tick % 3 === 0) {
			const snap = {
				tick: sim.tick,
				self: REP.selfBlockOf(sim, b),
				players: [REP.playerBlockOf(a)],
				zombies: [],
				bosses: [],
			};
			for (const part of P.encodeSnapshot(snap).parts)
				buffer.receive(P.decodeSnapshotPart(part), sim.tick, sim.tick / 60);
		}
		buffer.advance(1 / 60, sim.tick, sim.tick / 60, world);
	}
	const st = buffer.states().find(x => x.slot === 0);
	checkEq(st?.ride, VehicleKind.Bicycle, "client B's buffer: slot 0 rides a bicycle");
	const at = Math.round(buffer.renderNow());
	const want = headings.get(at) ?? headings.get(at - 1);
	const err = Math.abs(((st.moveAng - want + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
	check(err < 0.1, "...facing where A faced at the render time", `${err.toFixed(3)} rad`);
	// A gets off: B sees it on foot
	for (let i = 0; i < 30; i++) d.tick(0, 0);
	d.tick(0, 0, PRESS_E);
	for (let i = 0; i < 30; i++) {
		d.tick(0, 0);
		if (sim.tick % 3 === 0) {
			const snap = { tick: sim.tick, players: [REP.playerBlockOf(a)], zombies: [], bosses: [] };
			for (const part of P.encodeSnapshot(snap).parts)
				buffer.receive(P.decodeSnapshotPart(part), sim.tick, sim.tick / 60);
		}
		buffer.advance(1 / 60, sim.tick, sim.tick / 60, world);
	}
	checkEq(buffer.states().find(x => x.slot === 0)?.ride, 0, "...and on foot once A got off");
});

// ---------------------------------------------------------------- C4. the drawing, on a fake Instance tree

class Vector2 {
	constructor(x = 0, y = 0) {
		this.X = x;
		this.Y = y;
	}
}
class UDim {
	constructor(scale = 0, offset = 0) {
		this.Scale = scale;
		this.Offset = offset;
	}
}
class UDim2 {
	constructor(xs = 0, xo = 0, ys = 0, yo = 0) {
		this.X = new UDim(xs, xo);
		this.Y = new UDim(ys, yo);
	}
	static fromOffset(x, y) {
		return new UDim2(0, x, 0, y);
	}
	static fromScale(x, y) {
		return new UDim2(x, 0, y, 0);
	}
}
globalThis.Vector2 ??= Vector2;
globalThis.UDim ??= UDim;
globalThis.UDim2 ??= UDim2;
globalThis.Enum ??= {
	ApplyStrokeMode: { Border: "Border", Contextual: "Contextual" },
	ResamplerMode: { Pixelated: "Pixelated", Default: "Default" },
	ScaleType: { Stretch: "Stretch", Tile: "Tile", Slice: "Slice" },
};
const tree = { created: 0 };
function makeInstance(className) {
	const state = { ClassName: className, Name: className, children: [], parent: undefined };
	const proxy = new Proxy(state, {
		get(t, k) {
			if (k === "Parent") return t.parent;
			if (k === "Destroy") return () => (t.parent = undefined);
			if (k === "GetChildren") return () => [...t.children];
			if (k === "__state") return t;
			return t[k];
		},
		set(t, k, v) {
			if (k === "Parent") {
				t.parent = v;
				if (v !== undefined) v.__state.children.push(proxy);
				return true;
			}
			t[k] = v;
			return true;
		},
	});
	tree.created += 1;
	return proxy;
}
globalThis.Instance ??= function Instance(className) {
	return makeInstance(className);
};

section(
	"C4. the drawing: a bicycle and a motorcycle under their rider, hands on the bars, no Instance after warm-up",
	() => {
		const { Z, COLORS } = require(join(SRC, "shared/engine/colors.ts"));
		const { Camera } = require(join(SRC, "shared/engine/camera.ts"));
		const { Renderer } = require(join(SRC, "shared/engine/renderer.ts"));
		const VV = require(join(SRC, "client/view/vehicleView.ts"));
		const SVW = require(join(SRC, "client/view/survivorView.ts"));
		const { WEAPONS } = require(join(SRC, "shared/data/weapons.ts"));
		const WA = require(join(SRC, "client/view/worldArt.ts"));
		const { WORLD_ART } = require(join(SRC, "client/view/worldArtAssets.ts"));
		const CS = require(join(SRC, "client/view/charSheets.ts"));
		// the art this section draws with: the uploads as they are, with the vehicles' sprites and the characters'
		// sheets on (their uploaded ids; a stand-in for one not uploaded yet) or off (the flat drawing, ART-01)
		const isRideArt = name => name === "bicycle" || name === "motorcycle" || /^(survivors|weapons)/.test(name);
		const artIds = on => {
			const ids = {};
			for (const [name, t] of Object.entries(WORLD_ART)) {
				ids[name] = !isRideArt(name) ? t.id : on ? t.id || `local:${name}` : "";
			}
			return ids;
		};
		WA.overrideWorldArt(artIds(false));
		// what a frame asks of the renderer, recorded
		const calls = [];
		const rec = {
			drawRect: (cam, x, y, o) => calls.push({ x, y, ...o }),
			drawCircle: (cam, x, y, d, o) => calls.push({ x, y, w: d, h: d, circle: true, ...o }),
			drawSegment: (cam, x1, y1, x2, y2, o) =>
				calls.push({ x: (x1 + x2) / 2, y: (y1 + y2) / 2, segment: true, ...o }),
		};
		for (const def of VEHICLES) {
			for (const heading of [0, Math.PI / 3, Math.PI]) {
				calls.length = 0;
				VV.drawVehicle(rec, undefined, def.kind, 1000, 1000, heading, 4, 4, Z.player - 2);
				const body = calls.filter(c => c.zIndex >= Z.player - 2);
				const inside = body.every(c => {
					const dx = c.x - 1000;
					const dy = c.y - 1000;
					const f = dx * Math.cos(heading) + dy * Math.sin(heading);
					const l = -dx * Math.sin(heading) + dy * Math.cos(heading);
					return (
						Math.abs(f) + (c.w ?? 0) / 2 <= def.length / 2 + 1 &&
						Math.abs(l) + (c.h ?? 0) / 2 <= def.width / 2 + 1
					);
				});
				check(
					body.length >= 5 && inside,
					`${def.name} at ${f1((heading * 180) / Math.PI)}°: ${body.length} parts, all inside its ${def.length} × ${def.width} footprint`,
				);
				// the rider's layers (survivorView): feet Z.player - 1, torso + 1, hands + 3: the bars sit over the feet
				check(
					body.every(c => c.zIndex <= Z.player),
					"...all under the rider's body (torso at Z.player + 1)",
				);
			}
		}
		calls.length = 0;
		VV.drawVehicle(rec, undefined, VehicleKind.Motorcycle, 0, 0, 0, 0, 0, Z.player - 2);
		check(
			calls.some(c => c.color === COLORS.motoPaint) && calls.some(c => c.color === COLORS.tyre),
			"the motorcycle in its paint, on its tyres",
		);
		calls.length = 0;
		VV.drawVehicle(rec, undefined, VehicleKind.Bicycle, 0, 0, 0, 0, 0, Z.player - 2);
		check(
			calls.some(c => c.color === COLORS.bikeFrame),
			"the bicycle in its frame colour",
		);
		// ART-01: with an id each vehicle is ONE pixel-art image on its footprint; without, the flat parts again
		const lit = artIds(true);
		WA.overrideWorldArt(lit);
		for (const def of VEHICLES) {
			calls.length = 0;
			VV.drawVehicle(rec, undefined, def.kind, 0, 0, 0, 0, 0, Z.player - 2);
			const images = calls.filter(c => c.image !== undefined);
			check(
				images.length === 1 &&
					calls.length === 2 &&
					images[0].w === def.length &&
					images[0].h === def.width &&
					images[0].image === (def.kind === VehicleKind.Motorcycle ? lit.motorcycle : lit.bicycle),
				`${def.name} with its art uploaded: its shadow and one ${def.length} × ${def.width} image`,
			);
		}
		WA.overrideWorldArt(artIds(false));
		calls.length = 0;
		VV.drawVehicle(rec, undefined, VehicleKind.Motorcycle, 0, 0, 0, 0, 0, Z.player - 2);
		check(calls.every(c => c.image === undefined) && calls.length > 2, "no id: the flat parts");
		// the rider: the survivor drawing with `riding` -- no weapon, both hands on the bars, no body shadow
		const look = SVW.createLook();
		look.x = 0;
		look.y = 0;
		look.angle = 0;
		look.weapon = WEAPONS.find(w => w.name === "Pistol");
		look.riding = true;
		calls.length = 0;
		SVW.drawSurvivor(rec, undefined, look, SVW.createSwingTrail());
		const hands = calls.filter(c => c.circle === true && c.w === 10);
		check(
			hands.length === 2 &&
				hands.every(
					h => Math.abs(h.x - SVW.RIDE_GRIP_F) < 0.01 && Math.abs(Math.abs(h.y) - SVW.RIDE_GRIP_L) < 0.01,
				),
			"the rider's two hands on the grips",
		);
		check(!calls.some(c => c.color === COLORS.weapon && c.zIndex === look.z), "...no pistol in them");
		check(!calls.some(c => c.circle === true && c.w === 38), "...and no body shadow (the vehicle casts it)");
		look.riding = false;
		calls.length = 0;
		SVW.drawSurvivor(rec, undefined, look, SVW.createSwingTrail());
		check(
			calls.some(c => c.color === COLORS.weapon && c.zIndex === look.z),
			"on foot the same survivor holds the pistol again",
		);
		// the rider from the survivors' sheets (ART-09): the body's cell and NO weapon cell -- the pose's scratch must
		// not keep the pistol the same survivor held on foot the frame before (nor another survivor's weapon)
		{
			WA.overrideWorldArt(lit);
			const cam = new Camera();
			cam.setView(800, 600);
			const cells = () => ({
				weapon: calls.filter(c => c.image === lit.weapons),
				body: calls.filter(c => c.image === lit.survivorsA),
			});
			look.riding = false;
			calls.length = 0;
			SVW.drawSurvivor(rec, cam, look, SVW.createSwingTrail());
			const onFoot = cells();
			look.riding = true;
			calls.length = 0;
			SVW.drawSurvivor(rec, cam, look, SVW.createSwingTrail());
			const riding = cells();
			const row = riding.body[0] === undefined ? -1 : riding.body[0].rectY / CS.SURVIVOR_CELL;
			check(
				onFoot.weapon.length === 1 && onFoot.body.length === 1,
				"with the art: on foot, the body's cell and the pistol's",
			);
			check(
				riding.weapon.length === 0 && riding.body.length === 1,
				"...riding, the body's cell and no weapon (VEI-05), right after holding the pistol",
				`${riding.weapon.length} weapon cells`,
			);
			check(
				row >= CS.Grip.Idle * CS.STEPS && row < (CS.Grip.Idle + 1) * CS.STEPS,
				"...its hands out at the bars' width (the idle grip: the sheets bake no riding pose), not the pistol's",
				`row ${row}`,
			);
			check(!calls.some(c => c.circle === true && c.w === 38), "...and no body shadow (the vehicle casts it)");
			look.riding = false;
			WA.overrideWorldArt(artIds(false));
		}
		// the real renderer on a fake tree: riding, parking and riding again create no Instance after the first frame
		for (const [label, ids] of [
			["flat", artIds(false)],
			["art", lit],
		]) {
			WA.overrideWorldArt(ids);
			const root = makeInstance("Frame");
			const r = new Renderer(root, "World");
			const cam = new Camera();
			cam.setView(800, 600);
			cam.x = 1000;
			cam.y = 1000;
			const parked = {
				x: 1100,
				y: 1000,
				w: MOTO.length,
				h: MOTO.width,
				hp: 60,
				hpMax: 120,
				tags: "vehicle",
				placeable: 22,
				rot: 0,
			};
			const frame = i => {
				r.beginFrame();
				look.riding = true;
				look.x = 1000 + i;
				look.y = 1000;
				look.angle = i / 30;
				VV.drawVehicle(r, cam, 1 + (i % 2), look.x, look.y, look.angle, 4, 4, Z.player - 2);
				SVW.drawSurvivor(r, cam, look, SVW.createSwingTrail());
				VV.drawParkedVehicle(r, cam, parked, 4, 4);
				r.endFrame();
			};
			frame(0);
			frame(1);
			const warm = tree.created;
			for (let i = 2; i < 300; i++) frame(i);
			checkEq(
				tree.created - warm,
				0,
				`${label}: 300 frames of a rider and a parked vehicle: no Instance created after warm-up`,
			);
		}
		WA.overrideWorldArt(undefined);
	},
);

// ================================================================ the end

console.log(
	`\n[test-vehicles] ${checks - failures}/${checks} checks passed${failures > 0 ? `, ${failures} FAILED` : ""}`,
);
process.exit(failures > 0 ? 1 : 0);
