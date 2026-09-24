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
 *      (HEAD 2f48f55) — give that same hash, i.e. the extraction changed no behaviour. Its body part (hunger,
 *      healing, starving, poison) is DESIGN_RULES VIT-01 since 2026-09-24, written from the rule (`referenceBody`);
 *   3. quantising the input (§2.2: 256 move directions) moves the survivor by less than QUANT_TOL over the
 *      whole run, and not at all (< 1e-6 u) for the 8 keyboard directions;
 *   4. generateTown(seed) builds the same map twice (the §4.5 map hash), which is what lets client and server
 *      generate the world locally and only exchange deltas;
 *   5. VIT-01 itself: the wait before healing restarts on every hp lost, ramps in, needs a FOOD bar of 25 and pays
 *      food for every hp; items heal at once; Recovery sets the rate, not the wait; nobody out-heals a walker's bites;
 *      and a rest between two fights takes 60-90 s from 1 hp to full.
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
		p.sinceHurt ?? -1,
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

	referenceBody(p, save, dt);
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

/**
 * The body of the reference path: DESIGN_RULES VIT-01 (2026-09-24) written again HERE from the rule, numbers and all,
 * instead of imported -- so every hash below also checks shared/sim/vitals.ts against its spec. Until VIT-01 this was
 * the original's (hunger 0,3/s; starving 0,6 hp/s; healing 1,2 hp/s whenever the stomach was not empty, bite or no
 * bite, for free; poison 1,8 hp/s).
 *
 *   the stomach   runs down 0,3/s × (1 − Patience / 3)
 *   HP lost       starving (0,6 hp/s at 0) and poison (1,8 hp/s, halved by Poison immunity) restart the wait
 *   the wait      7 s since the last HP lost, then the rate ramps in over 2 s; `sinceHurt` stops counting at 9
 *   healing       1,5 hp/s × (1 + Recovery), only while the FOOD bar reads 25 or more (it rounds: ≥ 24,5), and each
 *                 healed hp costs 0,25 food; god mode never starts the wait
 */
function referenceBody(p, save, dt) {
	p.hungry = Math.max(0, p.hungry - 0.3 * (1 - save.skillLevels[8] / 3) * dt);
	let hurt = false;
	if (p.hungry <= 0) {
		p.hp -= 0.6 * dt;
		hurt = true;
	}
	if (p.buffs.poison > 0) {
		p.buffs.poison -= dt;
		p.hp -= 1.8 * (save.skillLevels[20] > 0 ? 0.5 : 1) * dt;
		hurt = true;
	}
	p.sinceHurt = hurt && p.godMode !== true ? 0 : Math.min(9, (p.sinceHurt ?? 9) + dt);
	if (p.hp >= p.hpMax || p.hungry < 24.5) return;
	const k = Math.min(1, Math.max(0, (p.sinceHurt - 7) / 2));
	if (k <= 0) return;
	const healed = Math.min(p.hpMax - p.hp, 1.5 * (1 + save.skillLevels[1]) * k * dt);
	p.hp += healed;
	p.hungry = Math.max(0, p.hungry - healed * 0.25);
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
		// hurt, rested and just fed enough: it heals at once, paying food, until the FOOD bar drops under 25 (VIT-01)
		// and the speed penalty of a hungry stomach sets in
		p.hp = 70;
		p.hungry = 26;
		save.skillLevels[7] = 1; // a movement skill, so the speed is not the bare default
	}
	// then the stomach is nearly empty: starving in a moment, and the hp drain with it
	if (at(0.5)) p.hungry = 0.4;
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
	if (ref.hash === base.hash)
		ok(`pre-F0 GameLoop.updatePlayer gives the same hash (movement unchanged; the body per VIT-01)`);
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

// ---------------------------------------------------------------- (5) VIT-01: the wait before healing, and its food

console.log(`\n[vitals] VIT-01: no healing for a while after a hit, and only on a fed stomach, which pays for it`);
{
	const V = require(join(SRC, "shared/sim/vitals.ts"));
	const Ply = require(join(SRC, "shared/game/player.ts"));
	const { USABLES } = require(join(SRC, "shared/data/usables.ts"));
	const { EQUIPS } = require(join(SRC, "shared/data/equips.ts"));
	const DT = 1 / 60;
	const flat = W.createWorld(4000, 4000);
	const STAND = SIM.makeCommand(1, 0, 0, 0, 0, 0, 0);
	const near = (a, b, tol) => Math.abs(a - b) <= tol;
	const usable = name => {
		const u = USABLES.find(row => row.name === name);
		if (u === undefined) throw new Error(`usables.ts moved: no ${name}`);
		return u;
	};
	/** a survivor standing in an empty world: `hp`, `food`, rested unless `since` says otherwise, `skills` {id: level} */
	function body({ hp = 50, food = 100, since, skills = {}, cloth = -1 } = {}) {
		const save = defaultSave();
		for (const [id, lv] of Object.entries(skills)) save.skillLevels[Number(id)] = lv;
		save.equipCloth = cloth;
		const p = createPlayer(save, 2000, 2000);
		p.hp = hp;
		p.hungry = food;
		if (since !== undefined) p.sinceHurt = since;
		return { p, save };
	}
	/** `seconds` of standing through the real stepPlayer; `each(t)` runs before every step */
	function stand(b, seconds, each) {
		const n = Math.round(seconds / DT);
		for (let i = 0; i < n; i++) {
			each?.(i * DT, i);
			stepPlayer(flat, b.p, b.save, STAND, DT);
		}
	}
	/** a bite through the server's damage entry point (the one every zombie, blast and crash goes through) */
	const bite = (b, raw = 10) => Ply.applyPlayerDamage(b.p, b.save, raw, false);

	console.log(
		`  the numbers: wait ${V.REGEN_DELAY_S} s, ramp ${V.REGEN_RAMP_S} s, ${V.REGEN_HP_PER_S} hp/s × (1 + Recovery), ` +
			`FOOD ≥ ${V.REGEN_FOOD_MIN}, ${V.REGEN_FOOD_PER_HP} food per hp healed`,
	);

	// (a) the delay resets on damage: a bite every 5 s for 30 s, then nothing
	{
		const b = body({ hp: 90 });
		let rose = 0;
		let last = b.p.hp;
		stand(b, 30, (t, i) => {
			if (i % 300 === 0) bite(b);
			if (b.p.hp > last + 1e-12) rose += 1;
			last = b.p.hp;
		});
		if (rose === 0) ok(`a bite every 5 s for 30 s: the hp never went up once (${b.p.hp.toFixed(2)} left)`);
		else fail(`a bite every 5 s: the hp went up on ${rose} steps between the bites`);
		// the last bite landed at t = 25 s: 5 s ago. `each` runs before step i, so a rise seen there came from step
		// i - 1, the (300 + i)th step since the bite
		const hp0 = b.p.hp;
		let firstRise;
		stand(b, 6, (t, i) => {
			if (firstRise === undefined && b.p.hp > hp0 + 1e-12) firstRise = 5 + i * DT;
		});
		if (firstRise !== undefined && firstRise >= V.REGEN_DELAY_S && firstRise <= V.REGEN_DELAY_S + 2 * DT) {
			ok(
				`the first hp comes back ${firstRise.toFixed(3)} s after the last bite (the wait: ${V.REGEN_DELAY_S} s)`,
			);
		} else
			fail(`the first hp came back ${firstRise?.toFixed(3)} s after the last bite (wait ${V.REGEN_DELAY_S} s)`);
		// mid-ramp and past it: half the rate at 8 s, the full rate from 9 s
		const rateAt = (since, lv = 0) => {
			const r = body({ hp: 10, since, skills: { 1: lv } });
			const h = r.p.hp;
			stepPlayer(flat, r.p, r.save, STAND, DT);
			return (r.p.hp - h) / DT;
		};
		const half = rateAt(V.REGEN_DELAY_S + V.REGEN_RAMP_S / 2 - DT);
		const full = rateAt(V.REGEN_RESTED_S);
		if (near(half, V.REGEN_HP_PER_S / 2, 1e-6) && near(full, V.REGEN_HP_PER_S, 1e-9)) {
			ok(`it ramps in: ${half.toFixed(3)} hp/s half-way through the ramp, ${full.toFixed(3)} hp/s past it`);
		} else fail(`the ramp: ${half} hp/s half-way, ${full} hp/s past it`);
		// a new bite in the middle of the ramp starts the wait over
		const r = body({ hp: 50, since: V.REGEN_DELAY_S + 1 });
		bite(r);
		const h = r.p.hp;
		stand(r, V.REGEN_DELAY_S - 0.05);
		if (r.p.hp === h) ok("a bite in the middle of the ramp starts the whole wait over");
		else fail(`a bite mid-ramp: ${h} -> ${r.p.hp} before the new wait was over`);
	}

	// (b) a walker's rhythm (LEG-04: 7 bites in 10 s) against the best healing there is: Recovery 3 and steel armour
	{
		const steel = EQUIPS.findIndex(e => e.name === "Steel armor");
		const b = body({ hp: 100, skills: { 1: 3 }, cloth: steel });
		let rose = 0;
		let last = b.p.hp;
		stand(b, 30, (t, i) => {
			if (i % 86 === 0) bite(b);
			if (b.p.hp > last + 1e-12) rose += 1;
			last = b.p.hp;
		});
		// the original's rule on the same bites: 1,2 × 4 hp/s whenever fed, bite or no bite
		const old = 100 + Math.min(0, 30 * (4.8 - (10 - EQUIPS[steel].def) * (60 / 86)));
		const oldText = `the original's rule: ${old >= 100 ? "full the whole time" : `${old.toFixed(0)} hp`}`;
		if (rose === 0 && b.p.hp < 100 - 30) {
			ok(
				`Recovery 3 + steel armour standing in a walker's bites for 30 s: ${b.p.hp.toFixed(0)} hp, never a ` +
					`step of healing (${oldText})`,
			);
		} else fail(`Recovery 3 + steel armour vs a walker: ${b.p.hp.toFixed(1)} hp, ${rose} steps of healing`);
		const bare = body({ hp: 100 });
		stand(bare, 10, (t, i) => i % 86 === 0 && bite(bare));
		const lost = 100 - bare.p.hp;
		if (near(lost, 70, 0.5))
			ok(`a bare survivor loses the walker's whole ${lost.toFixed(0)} hp in 10 s (LEG-04: 70)`);
		else fail(`a bare survivor lost ${lost.toFixed(1)} hp in 10 s to a walker (LEG-04: 70)`);
		const absorbed = body({ hp: 50, since: V.REGEN_RESTED_S });
		Ply.applyPlayerDamage(absorbed.p, absorbed.save, 0, false);
		if (absorbed.p.sinceHurt === V.REGEN_RESTED_S)
			ok("a bite the armour stops whole takes nothing, and restarts nothing");
		else fail(`an absorbed bite restarted the wait (sinceHurt ${absorbed.p.sinceHurt})`);
	}

	// (c) no healing below the food threshold, and the food each hp costs
	{
		const gate = V.REGEN_FOOD_MIN - 0.5;
		const low = body({ hp: 50, food: gate - 0.01 });
		stand(low, 10);
		const at = body({ hp: 50, food: gate + 0.2 });
		let lastHeal;
		let prevHp = at.p.hp;
		stand(at, 10, () => {
			if (at.p.hp > prevHp) lastHeal = at.p.hungry;
			prevHp = at.p.hp;
		});
		if (low.p.hp === 50 && at.p.hp > 50) {
			ok(
				`FOOD reading ${V.REGEN_FOOD_MIN - 1} (${(gate - 0.01).toFixed(2)}): not one hp in 10 s; reading ` +
					`${V.REGEN_FOOD_MIN}: it heals (${(at.p.hp - 50).toFixed(2)} hp) until the bar drops to ${V.REGEN_FOOD_MIN - 1}`,
			);
		} else fail(`the food gate: ${low.p.hp} hp under it, ${at.p.hp} hp over it`);
		// the step that heals last starts at 24.5 or more and pays at most one step's price out of it
		const step = (0.3 + V.REGEN_HP_PER_S * V.REGEN_FOOD_PER_HP) * DT;
		if (lastHeal !== undefined && lastHeal < gate + step && lastHeal > gate - step) {
			ok(
				`…and it stops the step the bar turns to ${V.REGEN_FOOD_MIN - 1} (last heal at food ${lastHeal.toFixed(4)})`,
			);
		} else fail(`the last heal was at food ${lastHeal}`);
		// the cost: 60 -> 100 on a full stomach, then again with Patience 3 (no idle drain at all)
		const cost = skills => {
			const b = body({ hp: 60, food: 100, skills });
			let t = 0;
			stand(b, 60, () => b.p.hp < b.p.hpMax && (t += DT));
			return { spent: 100 - b.p.hungry, t, rest: 60 - t };
		};
		const plain = cost({});
		const idle = 0.3 * 60;
		if (near(plain.spent, idle + 40 * V.REGEN_FOOD_PER_HP, 0.05)) {
			ok(
				`healing 40 hp costs ${(plain.spent - idle).toFixed(2)} food on top of the ${idle.toFixed(0)} a minute ` +
					`the stomach runs down anyway (${plain.t.toFixed(1)} s of healing)`,
			);
		} else
			fail(`healing 40 hp cost ${(plain.spent - idle).toFixed(2)} food (expected ${40 * V.REGEN_FOOD_PER_HP})`);
		const patient = cost({ 8: 3 });
		if (near(patient.spent, 40 * V.REGEN_FOOD_PER_HP, 1e-6)) {
			ok(
				`Patience 3 stops the stomach at rest, not the price of healing: still ${patient.spent.toFixed(2)} food`,
			);
		} else fail(`Patience 3: healing 40 hp cost ${patient.spent} food`);
	}

	// (d) what heals from the backpack heals at once; rotten meat is hp lost
	{
		for (const name of ["Bandage", "First aid kit", "Canned food"]) {
			const u = usable(name);
			const b = body({ hp: 30, food: 60 });
			bite(b);
			b.save.invenUse[u.id] = 1;
			const before = b.p.hp;
			Ply.itemUseEffect(b.p, b.save, u.id);
			const since = b.p.sinceHurt;
			if (near(b.p.hp - before, u.hp, 1e-9) && since === 0) {
				ok(`${name} right after a bite: +${u.hp} hp at once, and the body's own wait goes on (${since} s)`);
			} else fail(`${name} after a bite: ${before} -> ${b.p.hp} hp, sinceHurt ${since}`);
		}
		const rotten = usable("Rotten meat");
		const r = body({ hp: 60, food: 60 });
		r.save.invenUse[rotten.id] = 1;
		Ply.itemUseEffect(r.p, r.save, rotten.id);
		if (r.p.sinceHurt === 0 && r.p.hp === 60 + rotten.hp)
			ok(`Rotten meat is hp lost (${rotten.hp}): the wait starts over`);
		else fail(`Rotten meat: hp ${r.p.hp}, sinceHurt ${r.p.sinceHurt}`);
	}

	// (e) skills: Recovery multiplies the rate and leaves the wait alone; Health's extra bar fills; poison and starving
	{
		const rows = [];
		let sameWait = true;
		let ratios = true;
		for (let lv = 0; lv <= 3; lv++) {
			const b = body({ hp: 10, since: 0, skills: { 1: lv } });
			let first;
			stand(b, V.REGEN_RESTED_S + 1, (t, i) => first === undefined && b.p.hp > 10 && (first = (i - 1) * DT));
			if (!near(first ?? -1, V.REGEN_DELAY_S, 2 * DT)) sameWait = false;
			const r = body({ hp: 10, skills: { 1: lv } });
			stand(r, 1);
			const rate = r.p.hp - 10;
			if (!near(rate, V.REGEN_HP_PER_S * (1 + lv), 1e-6)) ratios = false;
			rows.push(`${lv}: ${rate.toFixed(2)} hp/s`);
		}
		if (ratios && sameWait)
			ok(`Recovery sets the rate (${rows.join(", ")}); the wait is ${V.REGEN_DELAY_S} s at every level`);
		else fail(`Recovery: ${rows.join(", ")}; same wait ${sameWait}`);
		const health = body({ hp: 100, skills: { 0: 3 } });
		stand(health, 30);
		if (health.p.hpMax === 130 && health.p.hp > 100)
			ok(`Health 3 raises the bar to 130 and healing fills it (${health.p.hp.toFixed(1)})`);
		else fail(`Health 3: ${health.p.hp}/${health.p.hpMax}`);
		const poisoned = (immune, god) => {
			const b = body({ hp: 80, skills: immune ? { 20: 1 } : {} });
			b.p.godMode = god;
			b.p.buffs.poison = 5;
			let rose = 0;
			let last = b.p.hp;
			stand(b, 5, () => {
				if (b.p.hp > last + 1e-12) rose += 1;
				last = b.p.hp;
			});
			return { lost: 80 - b.p.hp, rose, since: b.p.sinceHurt };
		};
		const plain = poisoned(false, false);
		const immune = poisoned(true, false);
		if (
			plain.rose === 0 &&
			near(plain.lost, 5 * 1.8, 0.05) &&
			near(immune.lost, 5 * 0.9, 0.05) &&
			immune.rose === 0
		) {
			ok(
				`poison is hp lost every step: no healing while it runs (${plain.lost.toFixed(1)} hp in 5 s; ` +
					`${immune.lost.toFixed(1)} with Poison immunity), and the wait starts when it ends`,
			);
		} else fail(`poison: ${JSON.stringify({ plain, immune })}`);
		const god = poisoned(false, true);
		if (god.since >= V.REGEN_RESTED_S - 1e-9) ok("admin god mode: poison never starts the wait");
		else fail(`god mode: poison started the wait (sinceHurt ${god.since})`);
		// starving, then one can of food: the wait first, and by then the bar is under 25 again -- eat enough
		const starved = body({ hp: 60, food: 0 });
		stand(starved, 2);
		const can = usable("Canned food");
		starved.save.invenUse[can.id] = 2;
		Ply.itemUseEffect(starved.p, starved.save, can.id);
		const h1 = starved.p.hp;
		stand(starved, V.REGEN_RESTED_S + 3);
		const oneCan = starved.p.hp - h1;
		Ply.itemUseEffect(starved.p, starved.save, can.id);
		const h2 = starved.p.hp;
		stand(starved, V.REGEN_RESTED_S + 3);
		if (near(60 - 1.2, h1 - can.hp, 0.05) && oneCan === 0 && starved.p.hp > h2) {
			ok(
				`starving costs ${(0.6).toFixed(1)} hp/s and is hp lost; one can after it (FOOD ${can.hunger}) is ` +
					`under 25 by the end of the wait -- a second one heals`,
			);
		} else fail(`starving then eating: ${h1} -> +${oneCan}, then ${h2} -> ${starved.p.hp}`);
	}

	// (f) between two fights: 0 -> full in a sensible time, on a full stomach
	{
		const toFull = (skills, hp = 1) => {
			const b = body({ hp, since: 0, skills });
			let t = 0;
			while (b.p.hp < b.p.hpMax && t < 600) {
				stepPlayer(flat, b.p, b.save, STAND, DT);
				t += DT;
			}
			return { t, food: 100 - b.p.hungry };
		};
		const base = toFull({});
		const rows = [1, 2, 3].map(lv => `Recovery ${lv}: ${toFull({ 1: lv }).t.toFixed(0)} s`);
		const big = toFull({ 0: 3 });
		const line =
			`${base.t.toFixed(1)} s from 1 hp to 100 counting the wait (${base.food.toFixed(0)} food of 100); ` +
			`${rows.join(", ")}; Health 3 (130 hp): ${big.t.toFixed(0)} s`;
		if (base.t >= 60 && base.t <= 90) ok(line);
		else fail(`${line} -- outside the 60-90 s of a rest between two fights`);
	}

	// (g) spec parity: 3 minutes of bites, poison, meals, a hungry stretch and skills -- stepPlayer against the rule as
	// written in `referenceBody` above, every step
	{
		const mk = () => body({ hp: 40, food: 45, skills: { 1: 2, 8: 1, 20: 1 } });
		const a = mk();
		const r = mk();
		let worst = 0;
		const can = usable("Canned food");
		const n = Math.round(180 / DT);
		for (let i = 0; i < n; i++) {
			const t = i * DT;
			for (const b of [a, r]) {
				if (i % 700 === 0 && t < 60) {
					// a bite that lands (the i-frames are long over): hp and the wait, the reference by hand
					if (b === a) bite(a, 12);
					else {
						r.p.hp -= 12;
						r.p.sinceHurt = 0;
					}
				}
				if (i === 4200) b.p.buffs.poison = 3;
				if (i === 7000 || i === 9000) {
					if (b === a) {
						a.save.invenUse[can.id] = 1;
						Ply.itemUseEffect(a.p, a.save, can.id);
					} else {
						r.p.hp = Math.min(r.p.hpMax, r.p.hp + can.hp);
						r.p.hungry = Math.min(r.p.hungryMax, r.p.hungry + can.hunger);
					}
				}
			}
			stepPlayer(flat, a.p, a.save, STAND, DT);
			r.p.hpMax = Ply.maxHpOf(r.save);
			referenceBody(r.p, r.save, DT);
			worst = Math.max(
				worst,
				Math.abs(a.p.hp - r.p.hp),
				Math.abs(a.p.hungry - r.p.hungry),
				Math.abs(a.p.sinceHurt - r.p.sinceHurt),
			);
		}
		if (worst < 1e-9)
			ok(
				`3 minutes of bites, poison, meals and skills: stepPlayer is the rule, step for step (Δ ${worst.toExponential(1)})`,
			);
		else fail(`stepPlayer parted from the rule by ${worst} over 3 minutes`);
	}
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
if (failures > 0) {
	console.log(`\n[test-sim] ${failures} failure(s) in ${secs}s`);
	process.exit(1);
}
console.log(`\n[test-sim] all checks passed in ${secs}s`);
