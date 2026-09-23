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
const { VEHICLES, VehicleKind, vehicleDef } = require(join(SRC, "shared/data/buildings.ts"));
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

// ================================================================ the end

console.log(
	`\n[test-vehicles] ${checks - failures}/${checks} checks passed${failures > 0 ? `, ${failures} FAILED` : ""}`,
);
process.exit(failures > 0 ? 1 : 0);
