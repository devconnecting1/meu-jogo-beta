#!/usr/bin/env node
/*
 * Determinism self-test of the shared player simulation (docs/MULTIPLAYER.md §11.3 F0, §12.2 "Determinismo").
 *
 *   npm run test:sim                 # default seed (DESIGN.TOWN_SEED) and 300 commands
 *   node tools/test-sim.mjs --seed 42 --steps 600
 *   PZ_SRC=path/to/src node tools/test-sim.mjs
 *
 * What it proves, on the generated town (fixed seed) with walls, cars, a door that opens and closes on the
 * survivor, knockback, hunger, buffs, acid and admin noclip:
 *
 *   1. the same 300 input commands replayed twice give the SAME state hash (stepPlayer is deterministic, so the
 *      client's prediction and the server's simulation cannot drift apart);
 *   2. the same commands through a REFERENCE PATH — a copy of GameLoop.updatePlayer as it was before F0
 *      (HEAD 2f48f55) — give that same hash, i.e. the extraction changed no behaviour;
 *   3. quantising the input (§2.2: 256 move directions) moves the survivor by less than QUANT_TOL over the
 *      whole run, and not at all (< 1e-6 u) for the 8 keyboard directions;
 *   4. generateTown(seed) builds the same map twice (the §4.5 map hash), which is what lets client and server
 *      generate the world locally and only exchange deltas.
 *
 * Exit code 1 on any divergence. Pure Node (>= 18) + the project's TypeScript (devDependency) to transpile
 * src/shared on the fly, with the same Luau / roblox-ts shims tools/validate-world.mjs uses.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(process.env.PZ_SRC ?? join(ROOT, "src"));
const require = createRequire(import.meta.url);
const Module = require("node:module");
const ts = require("typescript");

// ---------------------------------------------------------------- Luau / roblox-ts shims

globalThis.math = {
	floor: Math.floor,
	ceil: Math.ceil,
	abs: Math.abs,
	sqrt: Math.sqrt,
	sin: Math.sin,
	cos: Math.cos,
	tan: Math.tan,
	atan2: Math.atan2,
	asin: Math.asin,
	acos: Math.acos,
	exp: Math.exp,
	pow: Math.pow,
	min: Math.min,
	max: Math.max,
	sign: Math.sign,
	pi: Math.PI,
	huge: Infinity,
	log: (x, b) => (b === undefined ? Math.log(x) : Math.log(x) / Math.log(b)),
	clamp: (v, a, b) => Math.min(Math.max(v, a), b),
	rad: d => (d * Math.PI) / 180,
	deg: r => (r * 180) / Math.PI,
	// Luau rounds halves away from zero (JS rounds them towards +∞)
	round: x => (x < 0 ? -Math.round(-x) : Math.round(x)),
	random: (a, b) =>
		a === undefined
			? Math.random()
			: b === undefined
				? 1 + Math.floor(Math.random() * a)
				: a + Math.floor(Math.random() * (b - a + 1)),
};
globalThis.print = (...a) => console.log(...a);
globalThis.warn = (...a) => console.warn(...a);
class Color3 {
	constructor(r = 0, g = 0, b = 0) {
		this.R = r;
		this.G = g;
		this.B = b;
	}
	static fromRGB(r, g, b) {
		return new Color3(r / 255, g / 255, b / 255);
	}
	static fromHSV(h, s, v) {
		const i = Math.floor(h * 6);
		const f = h * 6 - i;
		const p = v * (1 - s);
		const q = v * (1 - f * s);
		const t = v * (1 - (1 - f) * s);
		const m = [
			[v, t, p],
			[q, v, p],
			[p, v, t],
			[p, q, v],
			[t, p, v],
			[v, p, q],
		][((i % 6) + 6) % 6];
		return new Color3(m[0], m[1], m[2]);
	}
	Lerp(o, k) {
		return new Color3(this.R + (o.R - this.R) * k, this.G + (o.G - this.G) * k, this.B + (o.B - this.B) * k);
	}
}
globalThis.Color3 = Color3;
const AP = Array.prototype;
const shim = (name, fn) => Object.defineProperty(AP, name, { value: fn, configurable: true, writable: true });
shim("size", function () {
	return this.length;
});
shim("remove", function (i) {
	return this.splice(i, 1)[0];
});
shim("unorderedRemove", function (i) {
	const v = this[i];
	const last = this.pop();
	if (i < this.length) this[i] = last;
	return v;
});
shim("clear", function () {
	this.length = 0;
});
const jsSort = AP.sort;
shim("sort", function (cmp) {
	if (!cmp) return jsSort.call(this);
	// roblox-ts comparators return a boolean ("a before b")
	return jsSort.call(this, (a, b) => {
		const r = cmp(a, b);
		if (typeof r !== "boolean") return r;
		return r ? -1 : cmp(b, a) ? 1 : 0;
	});
});

// "shared/x" → SRC/shared/x.ts, transpiled with the project's TypeScript
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
	if (req.startsWith("shared/") || req.startsWith("client/")) return join(SRC, req + ".ts");
	if (req.startsWith(".") && parent?.filename?.endsWith(".ts")) {
		const p = resolve(dirname(parent.filename), req);
		if (existsSync(p + ".ts")) return p + ".ts";
	}
	return resolveFilename.call(this, req, parent, ...rest);
};
Module._extensions[".ts"] = function (m, filename) {
	const out = ts.transpileModule(readFileSync(filename, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	});
	m._compile(out.outputText, filename);
};

const W = require(join(SRC, "shared/game/world.ts"));
const { DESIGN, TOWN } = require(join(SRC, "shared/engine/constants.ts"));
const { clamp } = require(join(SRC, "shared/engine/vec2.ts"));
const physics = require(join(SRC, "shared/game/physics.ts"));
const { createPlayer, damageToPlayer, recalcMoveSpeed } = require(join(SRC, "shared/game/player.ts"));
const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
const { stepPlayer } = require(join(SRC, "shared/sim/playerMove.ts"));
const SIM = require(join(SRC, "shared/sim/types.ts"));

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const numArg = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};
const SEED = numArg("--seed", DESIGN.TOWN_SEED);
const STEPS = numArg("--steps", 300);
/** the quantised stick may not move the survivor further than this from the raw direction over a whole run */
const QUANT_TOL = 4;
/** the 8 keyboard directions are exact, so only floating point noise is allowed there */
const EXACT_TOL = 1e-6;

let failures = 0;
const fail = msg => {
	failures++;
	console.log(`  FAIL  ${msg}`);
};
const ok = msg => console.log(`  ok    ${msg}`);

// ---------------------------------------------------------------- hashing

const buf = new ArrayBuffer(8);
const view = new DataView(buf);

function hashNumber(h, v) {
	// −0 and 0 are the same position; hashing their bits would not be
	view.setFloat64(0, v === 0 ? 0 : v, true);
	for (let i = 0; i < 8; i++) {
		h ^= view.getUint8(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

function hashPlayer(h, p) {
	const fields = [
		p.x,
		p.y,
		p.hp,
		p.hungry,
		p.angle,
		p.reactionSpeed,
		p.reactionDir,
		p.iframe,
		p.attacked ? 1 : 0,
		p.dead ? 1 : 0,
		p.buffs.speed,
		p.buffs.calm,
		p.buffs.pain,
		p.buffs.poison,
		p.puddleSlow ?? 0,
	];
	for (const v of fields) h = hashNumber(h, v);
	return h;
}

const hex = h => (h >>> 0).toString(16).padStart(8, "0");

/** §4.5 map hash: number of solids + Σ id × coordinates */
function worldHash(world) {
	let h = 2166136261 >>> 0;
	h = hashNumber(h, world.solids.length);
	let acc = 0;
	for (const s of world.solids) acc += s.id * (s.x + s.y * 7 + s.w * 13 + s.h * 17);
	return hex(hashNumber(h, acc));
}

// ---------------------------------------------------------------- the reference path (pre-F0 GameLoop.updatePlayer)

const SPEED_SCALE = SIM.SPEED_SCALE;

/**
 * GameLoop.updatePlayer of HEAD 2f48f55, verbatim minus the view bits (walk cycle, getCtx().phase). `dir` is the
 * wanted world-space direction (null = standing) exactly as the old loop received it from the input.
 */
function referenceUpdatePlayer(world, p, save, dir, aimAngle, dt) {
	p.angle = aimAngle;
	let wdx = 0;
	let wdy = 0;
	if (dir !== null) {
		const l = Math.sqrt(dir.x * dir.x + dir.y * dir.y);
		if (l > 0.0001) {
			wdx = dir.x / l;
			wdy = dir.y / l;
		}
	}
	const speed = recalcMoveSpeed(p, save) * SPEED_SCALE;
	const rx = Math.cos(p.reactionDir) * p.reactionSpeed * SPEED_SCALE;
	const ry = Math.sin(p.reactionDir) * p.reactionSpeed * SPEED_SCALE;
	if (p.reactionSpeed > 0) {
		p.reactionSpeed = Math.max(0, p.reactionSpeed - DESIGN.REACTION_FRICTION * dt);
	}
	const mvx = wdx * speed + rx;
	const mvy = wdy * speed + ry;
	const res = p.noclip
		? { x: p.x + mvx * dt, y: p.y + mvy * dt }
		: physics.moveActor(world, p.x, p.y, physics.PLAYER_RADIUS, mvx * dt, mvy * dt);
	p.x = clamp(res.x, 40, world.width - 40);
	p.y = clamp(res.y, 40, world.height - 40);

	const hungerRate = 1 - save.skillLevels[8] / 3;
	p.hungry = Math.max(0, p.hungry - 0.01 * 30 * hungerRate * dt);
	if (p.hungry <= 0) {
		p.hp -= 0.02 * 30 * dt;
	} else if (p.hp < p.hpMax) {
		p.hp = Math.min(p.hpMax, p.hp + 0.04 * 30 * (1 + save.skillLevels[1]) * dt);
	}
	if (p.buffs.poison > 0) {
		p.buffs.poison -= dt;
		p.hp -= 0.06 * 30 * (save.skillLevels[20] > 0 ? 0.5 : 1) * dt;
	}
	if (p.buffs.speed > 0) p.buffs.speed -= dt;
	if (p.buffs.calm > 0) p.buffs.calm -= dt;
	if (p.buffs.pain > 0) p.buffs.pain -= dt;
	if (p.attacked) {
		p.iframe -= dt;
		if (p.iframe <= 0) {
			p.attacked = false;
			p.iframe = 0;
		}
	}
	if (p.hp <= 0 && !p.dead) {
		p.hp = 0;
		p.dead = true;
	}
}

// ---------------------------------------------------------------- scenario

/** deterministic PRNG (mulberry32) — nothing in the test may depend on math.random */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const sideNormal = side => {
	if (side === "top") return { x: 0, y: -1 };
	if (side === "left") return { x: -1, y: 0 };
	if (side === "right") return { x: 1, y: 0 };
	return { x: 0, y: 1 };
};

/**
 * The town for `seed` plus a wooden door built into the doorway of a building near the centre: the survivor
 * starts outside it, so the run bumps into walls, a car, and a door that opens and closes on them.
 */
function buildWorld(seed) {
	const world = W.generateTown(seed);
	const cx = world.width / 2;
	const cy = world.height / 2;
	let building;
	let bestD = Infinity;
	for (const s of world.solids) {
		if (s.kind !== "building" || s.doorX === undefined || s.doorSide === undefined) continue;
		const d = Math.hypot(s.doorX - cx, s.doorY - cy);
		if (d < bestD) {
			bestD = d;
			building = s;
		}
	}
	if (building === undefined) throw new Error("no building with a door in this town");
	const n = sideNormal(building.doorSide);
	const horizontal = n.x === 0;
	const dw = horizontal ? TOWN.DOOR_W : TOWN.WALL_T;
	const dh = horizontal ? TOWN.WALL_T : TOWN.DOOR_W;
	const door = W.addSolid(world, {
		kind: "door",
		x: building.doorX - dw / 2,
		y: building.doorY - dh / 2,
		w: dw,
		h: dh,
		hp: 500,
		hpMax: 500,
		destructible: true,
		tags: "door",
		rot: 0,
		open: false,
	});
	// a free spot outside the door to start from
	let spawn;
	for (let out = 90; out <= 400 && spawn === undefined; out += 20) {
		const x = building.doorX + n.x * out;
		const y = building.doorY + n.y * out;
		if (physics.circleBlocked(world, x, y, physics.PLAYER_RADIUS + 2) === undefined) spawn = { x, y };
	}
	if (spawn === undefined) throw new Error("no free ground in front of the door");
	// nearest parked car: something solid to slide along
	let car;
	let carD = Infinity;
	for (const s of world.solids) {
		if (s.kind !== "car" || s.tags !== "car") continue;
		const d = Math.hypot(s.x + s.w / 2 - spawn.x, s.y + s.h / 2 - spawn.y);
		if (d < carD) {
			carD = d;
			car = s;
		}
	}
	const doorPoint = { x: building.doorX, y: building.doorY };
	const inside = { x: building.doorX - n.x * 140, y: building.doorY - n.y * 140 };
	const corner = { x: building.x + 60, y: building.y + 60 };
	const carPoint = car !== undefined ? { x: car.x + car.w / 2, y: car.y + car.h / 2 } : { ...spawn };
	return { world, door, doorId: door.id, spawn, doorPoint, inside, corner, carPoint };
}

/** where the survivor is heading at this step, and the events scheduled for it */
function plan(scene, step, steps) {
	const t = step / steps;
	if (t < 0.17) return scene.doorPoint; // pushes against the closed door
	if (t < 0.33) return scene.inside; // walks in once it is open
	if (t < 0.47) return scene.corner; // interior walls
	if (t < 0.63) return scene.doorPoint; // back to the door (closed on them again)
	if (t < 0.8) return scene.carPoint; // out and into a parked car
	return scene.spawn;
}

/** world/state events applied BEFORE the step, identical in every run */
function applyEvents(scene, p, save, step, steps) {
	const at = f => step === Math.floor(steps * f);
	if (step === 0) {
		p.hungry = 1.2; // starving in a few seconds: speed penalty, then the hp drain
		save.skillLevels[7] = 1; // a movement skill, so the speed is not the bare default
	}
	if (at(0.17) || at(0.63)) scene.door.open = true;
	if (at(0.47) || at(0.8)) scene.door.open = false; // may close on the survivor: they are pushed out
	if (at(0.1) || at(0.4) || at(0.7)) {
		// a bite: i-frames, knockback and the slow that comes with being hit
		damageToPlayer(p, save, 20);
		p.reactionDir = (step % 7) * 0.9;
	}
	if (at(0.33)) p.buffs.speed = 1.5;
	if (at(0.6)) p.buffs.poison = 2;
	if (at(0.7)) p.buffs.pain = 1;
	if (step >= Math.floor(steps * 0.8) && step < Math.floor(steps * 0.83)) p.puddleSlow = 0.2; // acid
	p.noclip = step >= Math.floor(steps * 0.87) && step < Math.floor(steps * 0.92);
}

function freshPlayer(scene, save) {
	const p = createPlayer(save, scene.spawn.x, scene.spawn.y);
	return p;
}

/**
 * Records the run: steers towards the plan's waypoints, quantises the input into commands (§2.2) and steps the
 * shared simulation. Returns the commands (with their raw, pre-quantisation direction) and the state hash.
 */
function record(scene, steps, mode) {
	const save = defaultSave();
	const p = freshPlayer(scene, save);
	const jitter = rng(0x5eed);
	const dts = rng(0xd7);
	const cmds = [];
	let h = 2166136261 >>> 0;
	let blocked = 0;
	let inside = 0;
	for (let step = 0; step < steps; step++) {
		applyEvents(scene, p, save, step, steps);
		const target = plan(scene, step, steps);
		let ang = Math.atan2(target.y - p.y, target.x - p.x) + (jitter() - 0.5) * 0.5;
		let mag = 1;
		let moving = step % 37 !== 0; // a few idle ticks
		if (mode === "keys") {
			// keyboard only: the 8 exact directions
			ang = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
		} else if (step % 11 === 0) {
			mag = 0.35; // analogue stick, half deflection (the speed does not change: see InputCommand.moveMag)
		}
		const dx = moving ? Math.cos(ang) : 0;
		const dy = moving ? Math.sin(ang) : 0;
		const aim = step * 0.037;
		const dt = mode === "keys" ? 1 / 30 + dts() * (1 / 30) : 1 / 60;
		const cmd = SIM.makeCommand(step + 1, dx, dy, mag, aim, 0, 0);
		cmds.push({ cmd, dx, dy, mag, dt });
		// what the survivor WOULD travel with nothing in the way (knockback aside)
		const want = recalcMoveSpeed(p, save) * SPEED_SCALE * dt;
		const res = stepPlayer(scene.world, p, save, cmd, dt);
		if (moving && p.reactionSpeed <= 0 && res.moved < want * 0.5) blocked++;
		if (W.buildingAt(scene.world, p.x, p.y) !== undefined) inside++;
		h = hashPlayer(h, p);
	}
	return { cmds, hash: hex(h), blocked, inside, end: { x: p.x, y: p.y }, dead: p.dead };
}

/** replays the recorded commands through stepPlayer on a fresh world */
function replay(scene, cmds) {
	const save = defaultSave();
	const p = freshPlayer(scene, save);
	let h = 2166136261 >>> 0;
	for (let step = 0; step < cmds.length; step++) {
		applyEvents(scene, p, save, step, cmds.length);
		stepPlayer(scene.world, p, save, cmds[step].cmd, cmds[step].dt);
		h = hashPlayer(h, p);
	}
	return { hash: hex(h), end: { x: p.x, y: p.y } };
}

/**
 * Replays them through the pre-F0 code. `raw`: feed the direction the input had BEFORE quantisation (what the old
 * loop used) instead of the quantised one, to measure what §2.2's 256 directions cost.
 */
function replayReference(scene, cmds, raw) {
	const save = defaultSave();
	const p = freshPlayer(scene, save);
	let h = 2166136261 >>> 0;
	const track = [];
	for (let step = 0; step < cmds.length; step++) {
		applyEvents(scene, p, save, step, cmds.length);
		const c = cmds[step];
		let dir = null;
		if (raw) {
			if (c.dx !== 0 || c.dy !== 0) dir = { x: c.dx, y: c.dy };
		} else if (c.cmd.moveMag > 0) {
			dir = { x: SIM.moveDirX(c.cmd.moveAng), y: SIM.moveDirY(c.cmd.moveAng) };
		}
		referenceUpdatePlayer(scene.world, p, save, dir, SIM.aimOf(c.cmd.aim), c.dt);
		h = hashPlayer(h, p);
		track.push({ x: p.x, y: p.y });
	}
	return { hash: hex(h), track, end: { x: p.x, y: p.y } };
}

/** per-step positions of a stepPlayer replay, to compare against a reference track */
function trackOfSim(scene, cmds) {
	const save = defaultSave();
	const p = freshPlayer(scene, save);
	const track = [];
	for (let step = 0; step < cmds.length; step++) {
		applyEvents(scene, p, save, step, cmds.length);
		stepPlayer(scene.world, p, save, cmds[step].cmd, cmds[step].dt);
		track.push({ x: p.x, y: p.y });
	}
	return track;
}

function maxDist(a, b) {
	let m = 0;
	for (let i = 0; i < a.length; i++) m = Math.max(m, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
	return m;
}

// ---------------------------------------------------------------- run

const started = Date.now();
console.log(`[test-sim] town seed ${SEED}, ${STEPS} commands`);

// (4) the map itself has to be the same on both sides
const hashA = worldHash(buildWorld(SEED).world);
const hashB = worldHash(buildWorld(SEED).world);
if (hashA === hashB) ok(`generateTown(${SEED}) map hash ${hashA} (stable)`);
else fail(`generateTown(${SEED}) differs between runs: ${hashA} ≠ ${hashB}`);

for (const mode of ["stick", "keys"]) {
	const label = mode === "stick" ? "analogue stick, fixed 1/60 s" : "keyboard, variable frame time";
	console.log(`\n[${mode}] ${label}`);
	const base = record(buildWorld(SEED), STEPS, mode);
	console.log(
		`  ${STEPS} commands recorded · ${base.blocked} blocked steps (walls, car, door) · ` +
			`${base.inside} steps inside the building · end (${base.end.x.toFixed(2)}, ${base.end.y.toFixed(2)})` +
			`${base.dead ? " · died" : ""}`,
	);
	if (base.blocked < 10) fail(`only ${base.blocked} blocked steps: the run barely touches the world`);
	if (base.inside < 10) fail(`only ${base.inside} steps inside the building: the door was never used`);

	// (1) same commands, same result — twice
	const run1 = replay(buildWorld(SEED), base.cmds);
	const run2 = replay(buildWorld(SEED), base.cmds);
	if (run1.hash === base.hash && run2.hash === base.hash) ok(`stepPlayer replays to the same hash ${base.hash}`);
	else fail(`stepPlayer diverged: ${base.hash} vs ${run1.hash} vs ${run2.hash}`);

	// (2) the pre-F0 code, fed the same (decoded) input
	const ref = replayReference(buildWorld(SEED), base.cmds, false);
	if (ref.hash === base.hash) ok(`pre-F0 GameLoop.updatePlayer gives the same hash (no behaviour change)`);
	else
		fail(
			`reference path diverged: ${base.hash} vs ${ref.hash} · ` +
				`end (${base.end.x.toFixed(3)}, ${base.end.y.toFixed(3)}) vs (${ref.end.x.toFixed(3)}, ${ref.end.y.toFixed(3)})`,
		);

	// (3) what quantising the stick costs against the raw direction
	const rawRef = replayReference(buildWorld(SEED), base.cmds, true);
	const drift = maxDist(trackOfSim(buildWorld(SEED), base.cmds), rawRef.track);
	const tol = mode === "keys" ? EXACT_TOL : QUANT_TOL;
	if (drift <= tol) ok(`quantised input stays within ${drift.toExponential(2)} u of the raw one (≤ ${tol})`);
	else fail(`quantised input drifts ${drift.toFixed(3)} u from the raw one (> ${tol})`);
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
if (failures > 0) {
	console.log(`\n[test-sim] ${failures} failure(s) in ${secs}s`);
	process.exit(1);
}
console.log(`\n[test-sim] all checks passed in ${secs}s`);
