#!/usr/bin/env node
/*
 * Authoritative combat tests (F2 2C, docs/MULTIPLAYER.md §2.3, §3.6, §8.1, §8.3, §9.1; acceptance in §11.3 F2).
 *
 *   node tools/test-combat.mjs                   # everything (exit code 1 on any failure)
 *   node tools/test-combat.mjs --shots 400       # more samples per latency (default 300)
 *   node tools/test-combat.mjs --seed 7
 *   PZ_SRC=path/to/src node tools/test-combat.mjs
 *
 * It runs the REAL server modules (server/sim/{combat,history,progress}.ts) against a hostile client, on a
 * small hand-built world where every distance is known, so a miss is a verdict and not a coincidence.
 *
 * What it proves:
 *
 *   a. a client that fires straight at a zombie it has NO line of sight to (a wall between them), or that is
 *      past the weapon's range, takes no hp off anyone — the server traces the shot itself and the protocol has
 *      no field in which to claim a hit (§8.3 "nunca confiar do cliente");
 *   b. cadence and ammunition hold against forged packets: a command that claims three attack presses every
 *      tick, for ever, fires exactly as often as the weapon's cooldown and the magazine allow, and an empty
 *      reserve fires nothing (§8.1, §9.1 "no-spread / triggerbot");
 *   c. lag compensation is fair AND bounded: the registration rate of shots that hit on the shooter's screen is
 *      measured at 0 / 50 / 150 ms of RTT (§11.3 F2 wants ≥ 95 % at 150 ms), the same shots are shown to MISS
 *      without the rewind, and a client that declares an ancient view is clamped to its measured ping (§2.3);
 *   c''. the review of 2026-09-23 (#2, #3, #6), with a client streaming one Input a tick through the real queue:
 *      an honest 150 ms client with ±15 ms of jitter is never clamped, one that jumps its view 6 ticks back for
 *      each shot is clamped every time, a body drawn in the mid ring is judged where it was drawn, the measured
 *      ping is slow to rise and quick to fall, and the melee margin covers what a walker does in a 140 ms view;
 *      and from the review of dee095a: a running view offset past the ceiling (a bite's, a ping that just fell) is
 *      judged AT the ceiling, never past it (S1), and a jump that fits under the ceiling -- a 50 ms link measured at
 *      150 ms -- is clamped by the continuity alone, every time (S2);
 *   d. XP, kills and levels only move when the SERVER decides: the assist share of §3.6, the boss participation
 *      rule, and `stripClientProgress` pinning every reported progress field to the trusted copy once
 *      MP_PHASE ≥ 2 — which is the §11.3 F2 acceptance line "o XP só vem do servidor";
 *   e. with MP_PHASE ≥ 2 `damageToPlayer` (the entry point every client system still calls) stops being a
 *      damage source, while the server's `applyPlayerDamage` keeps working — the playtest bug that started this
 *      front (one player at 84/100 from zombies only his client knew about) cannot happen again.
 *
 * MP_PHASE itself is NOT changed in the repository (tools/test-net.mjs pins it on purpose): the test flips the
 * exported value at runtime, around the sections that need phase 2, and puts it back.
 *
 * Pure Node (>= 18) + the project's TypeScript (devDependency) to transpile src/ on the fly, with the Luau /
 * roblox-ts shims of tools/test-sim.mjs and the strict `buffer` of tools/test-net.mjs.
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

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};
const SEED = argValue("--seed", 1);
const SHOTS = argValue("--shots", 300);
// ---------------------------------------------------------------- deterministic RNG (never math.random)

/** mulberry32: the spawn search must give the same answer on every run */
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

let nextRandom = mulberry32(SEED);

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
			? nextRandom()
			: b === undefined
				? 1 + Math.floor(nextRandom() * a)
				: a + Math.floor(nextRandom() * (b - a + 1)),
};
globalThis.print = () => {};
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

class LuauBuffer {
	constructor(size) {
		this.bytes = new Uint8Array(size);
		this.view = new DataView(this.bytes.buffer);
	}
}

function bcheck(b, offset, n) {
	if (!(b instanceof LuauBuffer)) throw new TypeError("buffer expected");
	if (typeof offset !== "number" || !Number.isInteger(offset)) throw new TypeError(`offset ${offset} not an integer`);
	if (offset < 0 || offset + n > b.bytes.length) {
		throw new RangeError(`buffer access out of bounds (offset ${offset}, ${n} B, len ${b.bytes.length})`);
	}
}

function icheck(v, lo, hi, what) {
	if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
		throw new RangeError(`${what}: ${v} is not an integer in [${lo}, ${hi}] (Luau would wrap it)`);
	}
}

globalThis.buffer = {
	create(size) {
		if (!Number.isInteger(size) || size < 0) throw new RangeError(`buffer.create(${size})`);
		return new LuauBuffer(size);
	},
	len(b) {
		if (!(b instanceof LuauBuffer)) throw new TypeError("buffer expected");
		return b.bytes.length;
	},
	readu8: (b, o) => (bcheck(b, o, 1), b.view.getUint8(o)),
	readi8: (b, o) => (bcheck(b, o, 1), b.view.getInt8(o)),
	readu16: (b, o) => (bcheck(b, o, 2), b.view.getUint16(o, true)),
	readi16: (b, o) => (bcheck(b, o, 2), b.view.getInt16(o, true)),
	readu32: (b, o) => (bcheck(b, o, 4), b.view.getUint32(o, true)),
	readi32: (b, o) => (bcheck(b, o, 4), b.view.getInt32(o, true)),
	readf32: (b, o) => (bcheck(b, o, 4), b.view.getFloat32(o, true)),
	readf64: (b, o) => (bcheck(b, o, 8), b.view.getFloat64(o, true)),
	writeu8(b, o, v) {
		bcheck(b, o, 1);
		icheck(v, 0, 255, "writeu8");
		b.view.setUint8(o, v);
	},
	writei8(b, o, v) {
		bcheck(b, o, 1);
		icheck(v, -128, 127, "writei8");
		b.view.setInt8(o, v);
	},
	writeu16(b, o, v) {
		bcheck(b, o, 2);
		icheck(v, 0, 65535, "writeu16");
		b.view.setUint16(o, v, true);
	},
	writei16(b, o, v) {
		bcheck(b, o, 2);
		icheck(v, -32768, 32767, "writei16");
		b.view.setInt16(o, v, true);
	},
	writeu32(b, o, v) {
		bcheck(b, o, 4);
		icheck(v, 0, 4294967295, "writeu32");
		b.view.setUint32(o, v, true);
	},
	writef32(b, o, v) {
		bcheck(b, o, 4);
		if (typeof v !== "number") throw new TypeError("writef32 expects a number");
		b.view.setFloat32(o, v, true);
	},
	writef64(b, o, v) {
		bcheck(b, o, 8);
		if (typeof v !== "number") throw new TypeError("writef64 expects a number");
		b.view.setFloat64(o, v, true);
	},
	readstring(b, o, count) {
		bcheck(b, o, count);
		return Buffer.from(b.bytes.subarray(o, o + count)).toString("utf8");
	},
	writestring(b, o, value, count) {
		const bytes = Buffer.from(String(value), "utf8");
		const n = count === undefined ? bytes.length : count;
		if (!Number.isInteger(n) || n < 0 || n > bytes.length) throw new RangeError(`writestring count ${n}`);
		bcheck(b, o, n);
		b.bytes.set(bytes.subarray(0, n), o);
	},
	copy(target, targetOffset, source, sourceOffset = 0, count) {
		const n = count === undefined ? buffer.len(source) - sourceOffset : count;
		bcheck(source, sourceOffset, n);
		bcheck(target, targetOffset, n);
		target.bytes.set(source.bytes.subarray(sourceOffset, sourceOffset + n), targetOffset);
	},
	fill(b, offset, value, count) {
		const n = count === undefined ? buffer.len(b) - offset : count;
		bcheck(b, offset, n);
		icheck(value, 0, 255, "fill");
		b.bytes.fill(value, offset, offset + n);
	},
};

globalThis.typeIs = (v, t) => {
	switch (t) {
		case "buffer":
			return v instanceof LuauBuffer;
		case "number":
			return typeof v === "number";
		case "string":
			return typeof v === "string";
		case "boolean":
			return typeof v === "boolean";
		case "nil":
			return v === undefined || v === null;
		case "function":
			return typeof v === "function";
		case "table":
			return typeof v === "object" && v !== null && !(v instanceof LuauBuffer);
		default:
			return false;
	}
};

const defineMethod = (proto, name, fn) =>
	Object.defineProperty(proto, name, { value: fn, configurable: true, writable: true });
defineMethod(Array.prototype, "size", function () {
	return this.length;
});
defineMethod(Array.prototype, "remove", function (i) {
	return this.splice(i, 1)[0];
});
defineMethod(Array.prototype, "unorderedRemove", function (i) {
	const v = this[i];
	const last = this.pop();
	if (i < this.length) this[i] = last;
	return v;
});
defineMethod(Array.prototype, "clear", function () {
	this.length = 0;
});
defineMethod(String.prototype, "size", function () {
	return Buffer.byteLength(this.valueOf(), "utf8");
});
const jsSort = Array.prototype.sort;
defineMethod(Array.prototype, "sort", function (cmp) {
	if (!cmp) return jsSort.call(this);
	// roblox-ts comparators return a boolean ("a before b")
	return jsSort.call(this, (a, b) => {
		const r = cmp(a, b);
		if (typeof r !== "boolean") return r;
		return r ? -1 : cmp(b, a) ? 1 : 0;
	});
});
// roblox-ts Map/Set expose size() as a method; keep the native count behind it
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size").get;
defineMethod(Map.prototype, "size", function () {
	return mapSize.call(this);
});
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, "size").get;
defineMethod(Set.prototype, "size", function () {
	return setSize.call(this);
});

// "shared/x" / "server/x" → SRC/..., transpiled with the project's TypeScript (loader of test-sim.mjs)
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
	if (req.startsWith("shared/") || req.startsWith("client/") || req.startsWith("server/")) {
		return join(SRC, req + ".ts");
	}
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

// ---------------------------------------------------------------- the modules under test

const { addSolid, createWorld } = require(join(SRC, "shared/game/world.ts"));
const { defaultSave, expMaxInit } = require(join(SRC, "shared/game/save.ts"));
const Ply = require(join(SRC, "shared/game/player.ts"));
const { WEAPONS } = require(join(SRC, "shared/data/weapons.ts"));
const { createBoss, createZombie } = require(join(SRC, "shared/game/entities.ts"));
const { stepPlayer } = require(join(SRC, "shared/sim/playerMove.ts"));
const CFG = require(join(SRC, "shared/net/mpConfig.ts"));
const P = require(join(SRC, "shared/net/protocol.ts"));
const PL = require(join(SRC, "server/sim/players.ts"));
const { ServerCombat, PING_RISE, PING_FALL } = require(join(SRC, "server/sim/combat.ts"));
const { biteRewindCapS, judgedTick, PositionHistory, rewindCapS } = require(join(SRC, "server/sim/history.ts"));
const PROG = require(join(SRC, "server/sim/progress.ts"));

const TICK_DT = 1 / CFG.SIM_HZ;

// ---------------------------------------------------------------- reporting

let failures = 0;
const fail = msg => {
	failures++;
	console.log(`  FAIL  ${msg}`);
};
const ok = msg => console.log(`  ok    ${msg}`);
const info = msg => console.log(`        ${msg}`);
const section = title => console.log(`\n${title}`);

function check(cond, msg) {
	if (cond) ok(msg);
	else fail(msg);
	return cond;
}

function checkEq(actual, expected, msg) {
	return check(actual === expected, `${msg} (got ${actual}, expected ${expected})`);
}

// ---------------------------------------------------------------- fixtures

/** an empty field: every distance in this test is one we chose, not one the town generator happened to give */
function emptyWorld() {
	return createWorld(4000, 4000);
}

function wall(world, x, y, w, h) {
	return addSolid(world, {
		kind: "wall_h",
		x,
		y,
		w,
		h,
		hp: 1000,
		hpMax: 1000,
		destructible: false,
		tags: "wall",
	});
}

/**
 * The server half of the tick, with 2A's zombie list and 2D's Fx channel replaced by arrays. `random` is the
 * server RNG: 0.5 makes the spread roll exactly 0 and the damage roll exactly the weapon's damage, so a miss
 * is geometry and never luck.
 */
function newFixture(options = {}) {
	const world = options.world ?? emptyWorld();
	const zombies = [];
	const bosses = [];
	const shots = [];
	const saves = new Map();
	const history = new PositionHistory();
	const progress = new PROG.Progress({ saveOf: slot => saves.get(slot) });
	const combat = new ServerCombat({
		world,
		targets: { zombies: () => zombies, bosses: () => bosses },
		history,
		progress,
		random: options.random ?? (() => 0.5),
		hooks: {
			fx: e => {
				if (e.t === P.FxType.Shot) shots.push(e);
			},
		},
	});
	return { world, zombies, bosses, shots, saves, history, progress, combat };
}

function makePlayer(fx, slot, x, y, weaponId, tune = {}) {
	const save = defaultSave();
	save.invenWeapon[weaponId] = 1;
	save.equipWeapon = weaponId;
	save.ammoNormal = tune.ammoNormal ?? 500;
	save.ammoShotgun = 200;
	save.ammoMachinegun = 500;
	save.ammoArrow = 50;
	save.oil = 50;
	save.electric = 50;
	const sp = PL.createServerPlayer({ slot, userId: 100 + slot, name: `p${slot}` }, save, x, y, 0);
	fx.saves.set(slot, save);
	return sp;
}

function tough(z, hp = 1e9) {
	z.hp = hp;
	z.hpMax = hp;
	return z;
}

/** one tick of the §3.1 order for a single survivor: input → movement → weapons */
function tickPlayer(fx, sp, cmd, tick) {
	stepPlayer(fx.world, sp.state, sp.save, cmd, TICK_DT);
	fx.combat.stepPlayer(sp, cmd, tick, TICK_DT);
}

/** a command that aims at (tx, ty) from the survivor and presses the trigger `presses` times */
function aimCommand(sp, seq, tx, ty, presses, held = true) {
	const aim = Math.atan2(ty - sp.state.y, tx - sp.state.x);
	return P.makeCommand(seq, 0, 0, aim, held ? P.HeldBit.Attack : 0, P.packEdges(presses, 0, 0, 0));
}

const wrapU16 = v => ((Math.floor(v) % 65536) + 65536) % 65536;

// ================================================================ a. no line of sight, no range, no damage

section("a. the server traces the shot itself: no line of sight and no range means no damage (§8.1, §8.3)");

{
	const PX = 1000;
	const PY = 1000;
	const world = emptyWorld();
	// a wall squarely between the survivor and the zombie: the shot cannot physically reach it
	wall(world, PX + 180, PY - 200, 40, 400);
	const fx = newFixture({ world });
	const sp = makePlayer(fx, 0, PX, PY, 10); // Pistol: range 600
	const z = tough(createZombie(1, PX + 400, PY, 1), 1000);
	fx.zombies.push(z);
	fx.combat.afterWorld(1);
	sp.viewTick = 1;
	tickPlayer(fx, sp, aimCommand(sp, 1, z.x, z.y, 1), 2);
	checkEq(fx.shots.length, 1, "the trigger was pulled and the server resolved exactly one shot");
	checkEq(z.hp, 1000, "a zombie behind a wall takes no damage, however precisely the client aimed");
	checkEq(fx.shots[0].hits[0].hit, P.HitKind.Solid, "the ShotResult says the bullet stopped on the wall");
	checkEq(fx.combat.statsOf(0).hitsZombie, 0, "the server counted no hit on a body");
}

{
	// the very same shot with the wall gone: the fixture is not simply inert
	const fx = newFixture();
	const sp = makePlayer(fx, 0, 1000, 1000, 10);
	const z = tough(createZombie(1, 1400, 1000, 1), 1000);
	fx.zombies.push(z);
	fx.combat.afterWorld(1);
	sp.viewTick = 1;
	tickPlayer(fx, sp, aimCommand(sp, 1, z.x, z.y, 1), 2);
	checkEq(fx.shots[0].hits[0].hit, P.HitKind.Zombie, "with a clear lane the same shot connects");
	check(z.hp < 1000, `and the zombie actually loses hp (${z.hp})`);
}

{
	// past the weapon's range: the range is the server's number, not something a packet carries
	const fx = newFixture();
	const sp = makePlayer(fx, 0, 1000, 1000, 10); // Pistol: range 600
	const z = tough(createZombie(1, 1000 + 700, 1000, 1), 1000);
	fx.zombies.push(z);
	fx.combat.afterWorld(1);
	sp.viewTick = 1;
	tickPlayer(fx, sp, aimCommand(sp, 1, z.x, z.y, 1), 2);
	checkEq(z.hp, 1000, "a zombie 700 u away is untouched by a 600 u weapon");
	checkEq(fx.shots[0].hits[0].hit, P.HitKind.None, "the ShotResult ends in empty air at the range limit");
}

{
	// aiming 90° away from the zombie: nothing in the protocol lets the client say "but I hit it"
	const fx = newFixture();
	const sp = makePlayer(fx, 0, 1000, 1000, 10);
	const z = tough(createZombie(1, 1400, 1000, 1), 1000);
	fx.zombies.push(z);
	fx.combat.afterWorld(1);
	sp.viewTick = 1;
	tickPlayer(fx, sp, aimCommand(sp, 1, 1000, 600, 1), 2);
	checkEq(z.hp, 1000, "a shot pointing somewhere else damages nothing");
}

// ================================================================ b. cadence, magazine and reserve (§8.1)

section("b. forged packets do not fire faster: cadence, magazine and reserve are the server's (§8.1, §9.1)");

/** fires for `seconds` with `presses` attack presses per command, and reports what the server allowed */
function burst(presses, seconds, weaponId, ammoNormal) {
	const fx = newFixture();
	const sp = makePlayer(fx, 0, 1000, 1000, weaponId, { ammoNormal });
	const z = tough(createZombie(1, 1400, 1000, 1));
	fx.zombies.push(z);
	const ticks = Math.round(seconds * CFG.SIM_HZ);
	for (let tick = 1; tick <= ticks; tick++) {
		fx.combat.afterWorld(tick);
		sp.viewTick = wrapU16(tick);
		tickPlayer(fx, sp, aimCommand(sp, tick, z.x, z.y, presses), tick);
	}
	return { fx, sp, shots: fx.shots.length, stats: fx.combat.statsOf(0) };
}

{
	const honest = burst(1, 10, 10, 500); // Pistol: 20/30 s between shots
	const forged = burst(3, 10, 10, 500); // the same 10 s, claiming three presses every single tick
	const ceiling = Math.ceil(10 / WEAPONS[10].cooldown);
	info(`Pistol over 10 s: honest client ${honest.shots} shots, forged client ${forged.shots}, ceiling ${ceiling}`);
	checkEq(forged.shots, honest.shots, "three presses per tick fire exactly as often as one press per tick");
	check(forged.shots <= ceiling, `and never beat the cooldown (${forged.shots} ≤ ${ceiling})`);
	check(forged.stats.blockedCadence > 0, `the refusals are counted for the panel (${forged.stats.blockedCadence})`);
}

{
	// an automatic weapon held down for a second: the cadence floor of one tick is the hard rate cap
	const forged = burst(3, 1, 15, 500); // M10: 3/30 s
	const ceiling = Math.ceil(1 / WEAPONS[15].cooldown);
	info(`M10 held for 1 s: ${forged.shots} shots (cooldown ceiling ${ceiling}, tick ceiling ${CFG.SIM_HZ})`);
	check(forged.shots <= ceiling, `an automatic weapon is capped by its cooldown (${forged.shots} ≤ ${ceiling})`);
}

{
	// nothing in the magazine and nothing in the pool: the trigger does nothing at all
	const empty = burst(3, 12, 10, 0);
	const fired = empty.stats.shots;
	const save = empty.sp.save;
	info(`Pistol with an empty reserve: ${fired} shots, ${empty.stats.blockedAmmo} refused for ammunition`);
	check(fired <= WEAPONS[10].mag, `at most one magazine ever leaves the barrel (${fired} ≤ ${WEAPONS[10].mag})`);
	check(empty.stats.blockedAmmo > 0, "the empty trigger is counted, not obeyed");
	check(save.ammoNormal >= 0, `the reserve never goes negative (${save.ammoNormal})`);
	checkEq(save.ammoNormal, 0, "and an empty pool stays empty");
}

{
	// the rounds have to come from somewhere: fired + still in the magazine ≤ what the save started with
	const run = burst(3, 20, 10, 40);
	const left = run.sp.save.ammoNormal + run.sp.state.weapon.ammoCount;
	info(`Pistol, 40 rounds in reserve: ${run.stats.shots} fired, ${left} left (reserve + magazine)`);
	checkEq(run.stats.shots + left, 40 + WEAPONS[10].mag, "every round is accounted for: none was invented");
}

// ================================================================ c. lag compensation (§2.3, §11.3 F2)

section("c. the rewind makes a laggy shot fair, and its ceiling makes a lag switch useless (§2.3, §9.1)");

const SHOOTER_X = 1000;
const SHOOTER_Y = 1000;
/** the target runs across the line of fire: only movement ACROSS the ray can turn a hit into a miss */
const TARGET_X = SHOOTER_X + 420;
const TARGET_AMP = 500;
const TARGET_SPEED = 250;

function targetY(tickValue) {
	const t = tickValue * TICK_DT;
	const period = (4 * TARGET_AMP) / TARGET_SPEED;
	const ph = t / period - Math.floor(t / period);
	const v = ph < 0.25 ? ph * 4 : ph < 0.75 ? 2 - ph * 4 : ph * 4 - 4;
	return SHOOTER_Y + TARGET_AMP * v;
}

/**
 * One measurement: a client at `rttMs` firing at what it SEES, with its command arriving half an RTT later. What
 * it sees is its newest snapshot -- which left the server half an RTT ago -- held INTERP_DEFAULT_S further back
 * (§5.1: the delay is the measured lateness plus the buffer, client/net/snapshotBuffer.ts). An earlier version
 * of this test drew the world INTERP_DEFAULT_S behind the server's clock with no downstream trip in it, which
 * is the extrapolating client tools/test-zombie-motion.mjs measured and replaced.
 *
 *   mode "fair"      — the client declares the view it really drew and the server measured its ping: §2.3
 *   mode "none"      — no compensation at all (the client declares the present): what F1 would have done
 *   mode "lagswitch" — the client declares a view one second old while the server measures no ping: §9.1
 */
function measure(rttMs, mode) {
	const owdTicks = (rttMs / 2000) * CFG.SIM_HZ;
	const interpTicks = CFG.INTERP_DEFAULT_S * CFG.SIM_HZ;
	const fx = newFixture();
	const sp = makePlayer(fx, 0, SHOOTER_X, SHOOTER_Y, 15); // M10: 800 u, 3/30 s
	fx.combat.setPing(0, mode === "lagswitch" ? 0 : rttMs / 1000);
	const z = tough(createZombie(1, TARGET_X, targetY(0), 1));
	fx.zombies.push(z);
	const inbox = new Map();
	let fired = 0;
	let registered = 0;
	let seq = 1;
	const maxTicks = SHOTS * 40;
	for (let tick = 1; tick <= maxTicks && fired < SHOTS; tick++) {
		z.y = targetY(tick);
		fx.combat.afterWorld(tick);
		const packet = inbox.get(tick);
		if (packet !== undefined) {
			inbox.delete(tick);
			sp.viewTick = wrapU16(packet.view);
			sp.viewFrac = Math.max(0, Math.min(255, Math.round((packet.view - Math.floor(packet.view)) * 256)));
			const before = fx.shots.length;
			tickPlayer(fx, sp, packet.cmd, tick);
			if (fx.shots.length > before) {
				fired++;
				const shot = fx.shots[fx.shots.length - 1];
				if (shot.hits.some(h => h.hit === P.HitKind.Zombie)) registered++;
			}
		} else {
			tickPlayer(fx, sp, P.makeCommand(seq++, 0, 0, 0, 0, 0), tick);
		}
		// the client pulls the trigger at its own rate, aiming at the body it is drawing right now
		if (tick % 8 === 0) {
			const view = tick - owdTicks - interpTicks;
			const cmd = aimCommand(sp, seq++, TARGET_X, targetY(view), 1);
			const declared = mode === "none" ? tick + owdTicks : mode === "lagswitch" ? view - CFG.SIM_HZ : view;
			// a packet can never be consumed in the tick that produced it, however fast the link is
			inbox.set(tick + Math.max(1, Math.ceil(owdTicks)), { cmd, view: declared });
		}
	}
	return { fired, registered, rate: fired > 0 ? registered / fired : 0, stats: fx.combat.statsOf(0) };
}

{
	const fair = [0, 50, 150].map(rtt => ({ rtt, r: measure(rtt, "fair") }));
	for (const row of fair) {
		const pct = (row.r.rate * 100).toFixed(1);
		info(`RTT ${String(row.rtt).padStart(3)} ms: ${row.r.registered}/${row.r.fired} shots registered (${pct} %)`);
	}
	for (const row of fair) {
		check(
			row.r.rate >= 0.95,
			`≥ 95 % of the shots that hit on screen register at ${row.rtt} ms RTT (${(row.r.rate * 100).toFixed(1)} %)`,
		);
		// the ceiling exists for the dishonest view: the view an honest client really drew is never cut short.
		// With the half-ping ceiling a 150 ms client lost 40 ms of compensation on every shot (10 u on this
		// target, 30 u on a charging charger) -- inside a zombie's body here, which is why the rate alone missed it
		check(
			row.r.stats.rewindClamped === 0,
			`an honest ${row.rtt} ms client's view is never clamped (${row.r.stats.rewindClamped} of ${row.r.fired})`,
		);
	}

	const none = measure(150, "none");
	info(
		`the same 150 ms client with NO compensation: ${none.registered}/${none.fired} (${(none.rate * 100).toFixed(1)} %)`,
	);
	check(
		none.rate < 0.5,
		`without the rewind the same aim mostly misses (${(none.rate * 100).toFixed(1)} % < 50 %) — the compensation is what is doing the work`,
	);

	const lag = measure(150, "lagswitch");
	info(`a client declaring a 1 s old view with no measured ping: ${(lag.rate * 100).toFixed(1)} %`);
	check(
		lag.stats.rewindClamped > 0,
		`the declared view was clamped to the measured ping (${lag.stats.rewindClamped}×)`,
	);
	check(
		lag.rate <= fair[2].r.rate,
		`and it buys nothing: ${(lag.rate * 100).toFixed(1)} % ≤ the honest client's ${(fair[2].r.rate * 100).toFixed(1)} %`,
	);

	// the ceiling is not decoration: past REWIND_MAX_S the compensation simply stops, and the player has to
	// lead the target a little (§2.3 "Acima disso o jogador precisa antecipar"). Lag is never an advantage.
	const extreme = measure(700, "fair");
	info(`RTT 700 ms, past the ${CFG.REWIND_MAX_S * 1000} ms ceiling: ${(extreme.rate * 100).toFixed(1)} %`);
	check(
		extreme.rate < fair[2].r.rate,
		`the rewind stops at its ceiling instead of growing with the lag (${(extreme.rate * 100).toFixed(1)} % < ${(fair[2].r.rate * 100).toFixed(1)} %)`,
	);
}

{
	// the ceiling itself (§2.3 "Teto por jogador"), independent of any geometry
	checkEq(rewindCapS(0, 0, 60, 0.3), 2 / 60, "with no ping and no interpolation the rewind is 2 ticks");
	check(Math.abs(rewindCapS(0.15, 0.1, 60) - (0.15 + 0.1 + 2 / 60)) < 1e-9, "ping + interpolation + 2 ticks");
	checkEq(rewindCapS(2, 0.25, 60), CFG.REWIND_MAX_S, "and it never exceeds REWIND_MAX_S, whatever the ping");
	check(biteRewindCapS(2, 0.25, 60) === CFG.FAIR_BITE_REWIND_MAX_S, "a bite gets the shorter FAIR_BITE ceiling");
	checkEq(judgedTick(100, 400, 0.3, 60), 100, "a view from the FUTURE collapses to the present");
	checkEq(judgedTick(100, Number.NaN, 0.3, 60), 100, "and so does a NaN");
	checkEq(judgedTick(100, 0, 0.1, 60), 94, "an ancient view is clamped to the ceiling, not refused");
}

// ================================================================ c''. the review of 2026-09-23 (#2, #3)

section("c''. the rewind judges each body where it was DRAWN, and a view cannot jump for one shot (review #2, #3)");

/**
 * A stream client, closer to the real one than `measure`: one Input a tick through the real queue
 * (players.ts `acceptInput` / `takeCommand`), each carrying the view of the frame that built it, delivered
 * `rttMs/2 ± jitterMs` later, and a shot every 8 ticks at the body it draws. The server hears a ping once a second
 * (± `pingNoiseMs`): the real RTT, or `serverPingMs` when the ping it measures is not the link's.
 *
 *   mid    the shooter draws the target in its MID ring: a near interval further back (client/net/snapshotBuffer.ts
 *          `extra`), which the server learns from the replication layer (`viewExtraTicks`, here fixed)
 *   jump   on a shot, the client declares a view `jump` ticks OLDER than the one it drew -- inside the ping ceiling --
 *          and aims where the target was then: the "rewind to wherever it hits" cheat
 */
function stream({
	rttMs,
	jitterMs = 0,
	pingNoiseMs = 0,
	serverPingMs = rttMs,
	mid = false,
	serverKnowsRing = true,
	jump = 0,
	shots = 150,
	seed = 11,
	speed = TARGET_SPEED,
}) {
	// the same zig-zag as `targetY`, at `speed`
	const targetY = tickValue => {
		const t = tickValue * TICK_DT;
		const period = (4 * TARGET_AMP) / speed;
		const ph = t / period - Math.floor(t / period);
		const v = ph < 0.25 ? ph * 4 : ph < 0.75 ? 2 - ph * 4 : ph * 4 - 4;
		return SHOOTER_Y + TARGET_AMP * v;
	};
	let s = seed;
	const rand = () => {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		return s / 0x7fffffff;
	};
	const owdTicks = (rttMs / 2000) * CFG.SIM_HZ;
	const interpTicks = CFG.INTERP_DEFAULT_S * CFG.SIM_HZ;
	// (an older src has no midViewExtraTicks: it drew the mid ring the same near interval further back)
	const extra = mid ? (CFG.midViewExtraTicks?.(CFG.SIM_HZ) ?? 3) : 0;
	const fx = newFixture();
	if (mid && serverKnowsRing) fx.combat.targets.viewExtraTicks = () => extra;
	const sp = makePlayer(fx, 0, SHOOTER_X, SHOOTER_Y, 15); // M10: 800 u, 3/30 s
	const z = tough(createZombie(1, TARGET_X, targetY(0), 1));
	fx.zombies.push(z);
	const inbox = [];
	let fired = 0;
	let registered = 0;
	let seq = 1;
	for (let tick = 1; fired < shots && tick < shots * 40; tick++) {
		z.y = targetY(tick);
		fx.combat.afterWorld(tick);
		if (tick % CFG.SIM_HZ === 1) {
			fx.combat.setPing(0, (serverPingMs + (rand() * 2 - 1) * pingNoiseMs) / 1000);
		}
		// what landed since the last tick, in the order it landed
		inbox.sort((a, b) => a.at - b.at);
		while (inbox.length > 0 && inbox[0].at <= tick) {
			const pkt = inbox.shift();
			PL.acceptInput(sp, pkt.packet, tick * TICK_DT);
		}
		const before = fx.shots.length;
		tickPlayer(fx, sp, PL.takeCommand(sp), tick);
		if (fx.shots.length > before) {
			fired++;
			if (fx.shots[fx.shots.length - 1].hits.some(h => h.hit === P.HitKind.Zombie)) registered++;
		}
		// the client's frame: it draws `view` (the target `extra` further back), and says so
		const view = tick - owdTicks - interpTicks;
		const shoot = tick % 8 === 0;
		const declared = shoot ? view - jump : view;
		const cmd = shoot
			? aimCommand(sp, seq++, TARGET_X, targetY(view - jump - extra), 1)
			: P.makeCommand(seq++, 0, 0, 0, 0, 0);
		const packet = {
			viewTick: wrapU16(declared),
			viewFrac: Math.max(0, Math.min(255, Math.round((declared - Math.floor(declared)) * 256))),
			cmds: [cmd],
		};
		const delay = owdTicks + ((rand() * 2 - 1) * jitterMs * CFG.SIM_HZ) / 1000;
		inbox.push({ at: tick + Math.max(1, delay), packet });
	}
	return { fired, registered, rate: fired > 0 ? registered / fired : 0, stats: fx.combat.statsOf(0) };
}

{
	const pct = r => `${(r.rate * 100).toFixed(1)} %`;
	// #3: an honest client on a bad link -- 150 ms, ±15 ms of jitter, a noisy ping -- is never clamped
	const honest = stream({ rttMs: 150, jitterMs: 15, pingNoiseMs: 20 });
	info(
		`honest, 150 ms ±15 ms: ${honest.registered}/${honest.fired} (${pct(honest)}), clamped ${honest.stats.rewindClamped}`,
	);
	check(
		honest.stats.rewindClamped === 0,
		`an honest jittery client's view is never clamped (${honest.stats.rewindClamped} of ${honest.fired})`,
	);
	check(honest.rate >= 0.95, `and ≥ 95 % of what it hits on screen registers (${pct(honest)})`);

	// #3: the same client declaring a view 6 ticks older on every shot -- inside the 150 ms ceiling (17 ticks) --
	// and aiming where the target was then. The ceiling alone let it through: 097f484 judged every one of them there
	const jumpy = stream({ rttMs: 150, jitterMs: 15, pingNoiseMs: 20, jump: 6 });
	info(
		`the same client jumping its view 6 ticks back on each shot: ${pct(jumpy)}, clamped ${jumpy.stats.rewindClamped}`,
	);
	check(
		jumpy.stats.rewindClamped >= jumpy.fired * 0.9,
		`a view that jumps inside the ceiling for a shot is clamped to the running one (${jumpy.stats.rewindClamped} of ${jumpy.fired})`,
	);
	check(
		jumpy.rate <= honest.rate,
		`and aiming at the past buys nothing (${pct(jumpy)} against the honest ${pct(honest)})`,
	);

	/*
	 * S2 (the review of dee095a): the case above does not need the continuity -- at 150 ms a 6-tick jump is already
	 * past the ping ceiling, and `judge` reverted to the ceiling alone still passed. This one does: a 50 ms link whose
	 * ping the server measures at 150 ms (a throttled second the filter is still coming down from, or a ping sample
	 * that is simply high) leaves ~10 ticks of ceiling above the honest view, and a 6-tick jump fits inside it.
	 */
	const roomy = stream({ rttMs: 50, serverPingMs: 150, jitterMs: 15, pingNoiseMs: 20 });
	const inside = stream({ rttMs: 50, serverPingMs: 150, jitterMs: 15, pingNoiseMs: 20, jump: 6 });
	info(
		`50 ms link, 150 ms measured: honest ${pct(roomy)} clamped ${roomy.stats.rewindClamped}; jumping 6 ticks ` +
			`${pct(inside)} clamped ${inside.stats.rewindClamped}`,
	);
	check(
		roomy.stats.rewindClamped === 0,
		`with room under the ceiling an honest view is still never clamped (${roomy.stats.rewindClamped} of ${roomy.fired})`,
	);
	check(
		inside.stats.rewindClamped === inside.fired,
		`a jump the ceiling allows is clamped by the continuity alone, every time (${inside.stats.rewindClamped} of ${inside.fired})`,
	);
	check(
		inside.rate <= roomy.rate,
		`and aiming at the past buys nothing (${pct(inside)} against the honest ${pct(roomy)})`,
	);

	// #2: the shooter draws the target in its mid ring, 3 ticks further back than its declared view. A fast body
	// (450 u/s: 22 u in those 3 ticks, more than a walker's radius) so that judging it at the wrong instant misses
	const FAST = 450;
	const mid = stream({ rttMs: 150, jitterMs: 15, pingNoiseMs: 20, mid: true, speed: FAST });
	info(
		`honest, target in the mid ring: ${mid.registered}/${mid.fired} (${pct(mid)}), clamped ${mid.stats.rewindClamped}`,
	);
	check(mid.rate >= 0.95, `a body drawn in the mid ring is judged where it was drawn: ≥ 95 % register (${pct(mid)})`);
	check(mid.stats.rewindClamped === 0, `and its shooter is not clamped for it (${mid.stats.rewindClamped})`);
	// the case has teeth: with the server blind to the ring (what 097f484 did), the same aim is judged 3 ticks late
	const blind = stream({ rttMs: 150, jitterMs: 15, pingNoiseMs: 20, mid: true, serverKnowsRing: false, speed: FAST });
	info(`the same shots with the server judging the mid ring at the declared view: ${pct(blind)}`);
	check(blind.rate < 0.5, `judged at the declared view instead, most of them miss (${pct(blind)})`);
}

{
	/*
	 * #6: melee is judged in the PRESENT with a margin of reach. A walker backing off at 90 u/s is drawn ~225 ms old
	 * by a 140 ms client (a round trip plus the buffer): the blade that meets it on screen at the edge of its reach
	 * swings at a body 20 u further out on the server. The fixed 12 u margin (a walker in 130 ms) missed it; the
	 * margin now follows the measured age of the view, 12-24 u.
	 */
	const { meleeReach } = require(join(SRC, "shared/data/weapons.ts"));
	const { zombieRadius } = require(join(SRC, "shared/game/entities.ts"));
	const swingAt = pingS => {
		const fx = newFixture();
		const sp = makePlayer(fx, 0, 1000, 1000, 0); // the Dagger
		fx.combat.setPing(0, pingS);
		const z = tough(createZombie(1, 1000, 1000, 1), 1000);
		// on screen: at the edge of the blade's reach; on the server, 225 ms of walking further away
		z.x = 1000 + meleeReach(WEAPONS[0]) + zombieRadius(z) - 2 + 0.225 * 90;
		fx.zombies.push(z);
		for (let tick = 1; tick <= 40; tick++) {
			fx.combat.afterWorld(tick);
			sp.viewTick = wrapU16(tick);
			tickPlayer(fx, sp, aimCommand(sp, tick, z.x, z.y, tick === 1 ? 1 : 0, tick <= 3), tick);
		}
		return z.hp < 1000;
	};
	check(
		swingAt(0.14),
		"a 140 ms client's blade meets the walker it saw at the edge of its reach, 20 u further out now",
	);
	check(!swingAt(0), "…and a client with no latency is not handed that reach: the body really is out of it");

	/*
	 * N6 (the review of dee095a): how deep a client keeps its queue is its own choice, so the wait its commands sit
	 * in buys no reach. At 50 ms the margin is a walker in 50 + 33 (the queue's target wait) + 100 ms: 16.5 u. The
	 * measured wait of a queue kept at INPUT_BUFFER_MAX made it 19.5 u; a body 18 u past the blade stays out of it.
	 */
	const swingWaiting = (wait, margin) => {
		const fx = newFixture();
		const sp = makePlayer(fx, 0, 1000, 1000, 0); // the Dagger
		fx.combat.setPing(0, 0.05);
		const z = tough(createZombie(1, 1000, 1000, 1), 1000);
		z.x = 1000 + meleeReach(WEAPONS[0]) + zombieRadius(z) + margin;
		fx.zombies.push(z);
		for (let tick = 1; tick <= 40; tick++) {
			fx.combat.afterWorld(tick);
			sp.viewTick = wrapU16(tick);
			sp.viewWait = wait;
			tickPlayer(fx, sp, aimCommand(sp, tick, z.x, z.y, tick === 1 ? 1 : 0, tick <= 3), tick);
		}
		return z.hp < 1000;
	};
	check(swingWaiting(2, 16), "at 50 ms the blade reaches 16 u past its length");
	check(!swingWaiting(CFG.INPUT_BUFFER_MAX, 18), "and a queue kept full does not stretch it to 18 u");
}

{
	// #3: the measured ping is slow to rise and quick to fall
	const fx = newFixture();
	fx.combat.setPing(0, 0.05);
	fx.combat.setPing(0, 0.3); // one second of a throttled link
	const spiked = fx.combat.pingOf(0);
	check(
		Math.abs(spiked - (0.05 + 0.25 * PING_RISE)) < 1e-9,
		`one high sample moves the ceiling ${PING_RISE * 100} % of the way (${(spiked * 1000).toFixed(0)} ms, not 300)`,
	);
	for (let i = 0; i < 40; i++) fx.combat.setPing(0, 0.3);
	check(
		fx.combat.pingOf(0) > 0.29,
		`a ping that stays high is followed within ~40 s (${(fx.combat.pingOf(0) * 1000).toFixed(0)} ms)`,
	);
	fx.combat.setPing(0, 0.05);
	check(
		fx.combat.pingOf(0) < 0.3 - 0.25 * PING_FALL + 0.01,
		`one lower sample takes ${PING_FALL * 100} % of the way down at once (${(fx.combat.pingOf(0) * 1000).toFixed(0)} ms)`,
	);
}

{
	/*
	 * N1, N2 (the review of dee095a): the view a shot is judged in is the one its command was BUILT under, and only a
	 * command the queue took can say what that was. A packet set `viewTick` on arrival whatever became of it, so on a
	 * tick that waits a held trigger fired in the view of the latest packet -- a late copy included, a free ±3-tick
	 * choice inside the continuity; and a command refused as out of the window (its ring slot 32 apart from a queued
	 * one) or a second copy of a queued one rewrote that one's view before it was consumed.
	 */
	const fx = newFixture();
	const sp = makePlayer(fx, 0, SHOOTER_X, SHOOTER_Y, 15);
	const pkt = (viewTick, seqs) => ({
		viewTick,
		viewFrac: 0,
		cmds: seqs.map(s => P.makeCommand(s, 0, 0, 0, P.HeldBit.Attack, 0)),
	});
	PL.acceptInput(sp, pkt(500, [10]), 0);
	PL.takeCommand(sp);
	PL.acceptInput(sp, pkt(497, [10]), 0); // a late copy of 10, naming another view
	PL.takeCommand(sp); // nothing queued: this tick waits, trigger held
	checkEq(sp.viewTick, 500, "a tick that waits fires in the last consumed command's view, not a late packet's");
	PL.acceptInput(sp, pkt(510, [11]), 0);
	PL.acceptInput(sp, pkt(470, [11]), 0); // a second copy of the queued 11
	PL.takeCommand(sp);
	checkEq(sp.viewTick, 510, "a copy of a queued command cannot re-declare its view");
	PL.acceptInput(sp, pkt(520, [12]), 0);
	PL.acceptInput(sp, pkt(430, [12 + 96]), 0); // out of the window, and in the same ring slot as 12
	PL.takeCommand(sp);
	checkEq(sp.viewTick, 520, "a command refused as out of the window does not overwrite a queued one's view");
}

{
	/*
	 * S1 (the review of dee095a): a running view offset further back than the ceiling reaches -- a bite's shorter one,
	 * or a ping that has just fallen -- is judged AT the ceiling. `judge` answered the newest end of the continuity
	 * window instead, past the ceiling: an offset of 16 ticks judged 13 back under a ceiling of 6, 9 or 12.
	 */
	const fx = newFixture();
	const st = fx.combat.slotOf(0);
	st.viewSeen = true;
	st.viewOffset = 16;
	const now = 1000;
	const back = [6, 9, 12].map(cap => now - fx.combat.judge(st, now, now - 16, cap / CFG.SIM_HZ, 0));
	check(
		back.every((b, i) => Math.abs(b - [6, 9, 12][i]) < 1e-9),
		`a running offset of 16 ticks is judged at ceilings of 6, 9 and 12, not past them (${back.map(b => b.toFixed(1)).join(", ")} back)`,
	);
	// …and inside the ceiling the continuity still holds the view to the running offset
	const held = now - fx.combat.judge(st, now, now - 10, 0.3, 0);
	check(Math.abs(held - 13) < 1e-9, `a view 6 ticks fresher than an offset of 16 is held at 13 (${held.toFixed(1)})`);

	/*
	 * The same through `biteAllowed`, which judges with the shot's running offset under the 150 ms bite ceiling: an
	 * honest 150 ms client (a round trip, the buffer and the queue: ~16 ticks) and a walker closing in at 5 u a tick,
	 * inside contact + FAIR_BITE_MARGIN 9 ticks ago (the ceiling), outside it 13 ticks ago. Judged 13 back, the bite the
	 * victim saw coming was refused.
	 */
	const T = 40;
	const fb = newFixture();
	const victim = makePlayer(fb, 0, 1000, 1000, 10);
	const walker = tough(createZombie(1, 1000, 1000, 1));
	fb.zombies.push(walker);
	for (let tick = 1; tick <= T; tick++) {
		walker.x = 1000 + 15 + 5 * (T - tick);
		fb.combat.afterWorld(tick);
	}
	const vst = fb.combat.slotOf(0);
	vst.viewSeen = true;
	vst.viewOffset = 16;
	victim.viewTick = T - 16;
	victim.viewFrac = 0;
	fb.combat.setPing(0, 0.15);
	checkEq(
		fb.combat.biteAllowed(victim, walker, 40, T),
		true,
		"a bite is judged at the 150 ms bite ceiling, where the walker already was in reach — not 13 ticks back",
	);
}

// ================================================================ c'. the history ring itself

section("c'. the position ring answers for the whole window and forgets what left it (§2.3)");

{
	const h = new PositionHistory(8);
	for (let tick = 0; tick < 8; tick++) {
		h.beginTick(tick);
		h.record(7, tick * 10, 0);
	}
	checkEq(h.sampleAt(7, 3).x, 30, "an exact tick reads back exactly");
	checkEq(h.sampleAt(7, 3.5).x, 35, "a fractional tick interpolates");
	checkEq(h.sampleAt(7, 99), undefined, "a tick the ring never held answers undefined");
	checkEq(h.sampleAt(42, 3), undefined, "so does an entity it never saw");
	h.forget(7);
	checkEq(h.size(), 0, "a dead entity's track is dropped, so a recycled netId cannot inherit it");
}

{
	// the ring must survive the wrap without ever answering with a stale slot
	const h = new PositionHistory(4);
	for (let tick = 0; tick < 12; tick++) {
		h.beginTick(tick);
		h.record(1, tick, 0);
	}
	checkEq(h.sampleAt(1, 11).x, 11, "the newest tick is there after three wraps");
	checkEq(h.sampleAt(1, 8).x, 8, "and so is the oldest one still inside the window");
	checkEq(h.sampleAt(1, 7), undefined, "one tick older than the window is gone, not wrong");
}

{
	/*
	 * N3 (the review of dee095a): the deepest rewind is not REWIND_MAX_S but a body drawn in the MID ring,
	 * REWIND_MAX_S + MID_REWIND_EXTRA_S. The ring has to hold it, the tick after it (the far end is interpolated) and
	 * the tick being simulated, which a shot is judged in before `afterWorld` records it.
	 */
	const deepest = (CFG.REWIND_MAX_S + CFG.MID_REWIND_EXTRA_S) * CFG.SIM_HZ;
	check(
		CFG.HISTORY_TICKS >= Math.ceil(deepest - 1e-9) + 2,
		`HISTORY_TICKS (${CFG.HISTORY_TICKS}) holds the mid ring's ceiling, ${(deepest / CFG.SIM_HZ) * 1000} ms = ` +
			`${deepest.toFixed(1)} ticks, plus the tick after it and the one in progress`,
	);
	// and in the ring itself: at tick T (recorded up to T - 1) the deepest judged instant still reads back
	const h = new PositionHistory();
	const T = 500;
	for (let tick = 1; tick < T; tick++) {
		h.beginTick(tick);
		h.record(3, tick, 0);
	}
	const far = h.sampleAt(3, T - deepest - 0.5);
	check(far !== undefined && Math.abs(far.x - (T - deepest - 0.5)) < 1e-9, "the far end of it is in the ring");
}

// ================================================================ d. XP, kills and levels (§3.6, §11.3 F2)

section("d. progress only moves when the server decides it (§3.6, §8.3, MP-15)");

{
	const save = defaultSave();
	const need = expMaxInit(save.level);
	checkEq(PROG.awardExp(save, need - 1), 0, "just under the bar is not a level");
	checkEq(PROG.awardExp(save, 1), 1, "and the next point of XP is");
	checkEq(save.skillPoint, 1, "a level hands out exactly one skill point");
	checkEq(PROG.awardExp(save, -50), 0, "negative XP does nothing");
	checkEq(PROG.awardExp(save, Number.NaN), 0, "and neither does a NaN");
}

{
	const saves = new Map([
		[0, defaultSave()],
		[1, defaultSave()],
		[2, defaultSave()],
	]);
	const prog = new PROG.Progress({ saveOf: slot => saves.get(slot) });
	prog.noteZombieDamage(1, 1, 50, 0); // an ally softened it up
	prog.noteZombieDamage(1, 2, 10, 0);
	const awards = prog.zombieKilled(1, 100, 0, 5); // slot 0 finished it five seconds later
	const killer = awards.find(a => a.slot === 0);
	const assist = awards.find(a => a.slot === 1);
	checkEq(killer.exp, 100, "the killing blow is worth the whole XP");
	checkEq(assist.exp, 60, "and an assist inside the window is worth 60 % (MP-15: no more kill stealing)");
	checkEq(awards.length, 3, "everyone who helped is paid, once");
	checkEq(saves.get(1).exp, 60, "the assist landed in the live save, not in a report");
	checkEq(prog.statsOf(0).kills, 1, "the kill is counted for the killer");
	checkEq(prog.statsOf(1).assists, 1, "and the assist for the helper");
}

{
	const saves = new Map([[0, defaultSave()]]);
	const prog = new PROG.Progress({ saveOf: slot => saves.get(slot) });
	prog.noteZombieDamage(9, 0, 30, 0);
	const late = prog.zombieKilled(9, 100, -1, PROG.ASSIST_WINDOW_S + 1);
	checkEq(late.length, 0, "a hit older than the assist window pays nothing");
	checkEq(saves.get(0).exp, 0, "and the save did not move");
}

{
	const saves = new Map([
		[0, defaultSave()],
		[1, defaultSave()],
		[2, defaultSave()],
	]);
	const prog = new PROG.Progress({ saveOf: slot => saves.get(slot) });
	prog.noteBossDamage(5, 0, 600, 0); // 6 % of the boss: a participant by damage
	prog.noteBossDamage(5, 1, 50, 0); // 0.5 %, but present for the whole fight
	prog.noteBossNear(5, 1, PROG.BOSS_NEAR_S + 1);
	prog.noteBossDamage(5, 2, 50, 0); // 0.5 % and gone after five seconds
	prog.noteBossNear(5, 2, 5);
	const awards = prog.bossKilled(5, 1000, 10000, 0);
	checkEq(awards.length, 2, "both participants are paid, the tourist is not");
	check(
		awards.every(a => a.exp === 1000),
		"every participant gets the FULL boss XP (§3.6), not a share",
	);
	checkEq(saves.get(1).bossKills, 1, "and the boss kill lands in the live save");
	checkEq(saves.get(2).bossKills, 0, "the tourist's save is untouched");
}

{
	// a slot is reused by whoever enters next (§4.4: `freeSlot` hands out the lowest free one), and the ledgers are
	// keyed by slot. A leaves after doing 6 % of the boss; B walks in and takes slot 0; C kills the boss. Before the
	// fix `remove` only dropped the counters, so B was paid A's fight: the XP, the boss kill and COINS_PER_BOSS.
	const saves = new Map([
		[0, defaultSave()],
		[1, defaultSave()],
	]);
	const prog = new PROG.Progress({ saveOf: slot => saves.get(slot) });
	prog.noteBossDamage(7, 0, 600, 0); // A, slot 0: 6 % of the boss
	prog.noteZombieDamage(8, 0, 50, 0); // …and softened a walker up
	prog.remove(0); // A leaves the world
	const newcomer = defaultSave();
	newcomer.money = 0;
	saves.set(0, newcomer); // B takes slot 0
	const bossAwards = prog.bossKilled(7, 1000, 10000, 1); // C, slot 1, lands the killing blow
	check(
		!bossAwards.some(a => a.slot === 0),
		"a newcomer in a reused slot is not paid the boss its last owner fought",
	);
	check(
		newcomer.exp === 0 && newcomer.bossKills === 0 && newcomer.money === 0,
		"…no XP, no boss kill, no boss coins",
		`exp ${newcomer.exp}, bossKills ${newcomer.bossKills}, money ${newcomer.money}`,
	);
	const walkerAwards = prog.zombieKilled(8, 100, 1, 1);
	check(!walkerAwards.some(a => a.slot === 0), "…nor the assist its last owner earned on a walker");
}

{
	// end to end: a kill resolved by the weapon machine pays XP with no client in the loop
	const fx = newFixture();
	const sp = makePlayer(fx, 0, 1000, 1000, 13); // Semi auto rifle: 110 dmg
	const z = createZombie(1, 1300, 1000, 1);
	z.hp = 1;
	z.hpMax = 1;
	z.exp = 40;
	fx.zombies.push(z);
	fx.combat.afterWorld(1);
	sp.viewTick = 1;
	tickPlayer(fx, sp, aimCommand(sp, 1, z.x, z.y, 1), 2);
	check(z.hp <= 0, "the zombie went down to a server-resolved shot");
	checkEq(sp.save.exp, 40, "the XP was written straight into the live save");
	checkEq(fx.progress.statsOf(0).kills, 1, "and the kill was counted on the server");
	checkEq(fx.history.has(z.id), false, "a dead body's history track is released");
}

// ================================================================ e. MP_PHASE 2: the client stops deciding

section("e. with MP_PHASE ≥ 2 the client's damage path is dead and the reports are ignored (§11.3 F2)");

const PHASE_BEFORE = CFG.MP_PHASE;

{
	// below the switch nothing changes: the single-player game keeps working exactly as it did
	CFG.MP_PHASE = 1;
	const save = defaultSave();
	const p = Ply.createPlayer(save, 0, 0);
	const hp = p.hp;
	check(Ply.damageToPlayer(p, save, 20), "MP_PHASE 1: the current path still hurts the survivor");
	check(p.hp < hp, `and the hp actually went down (${hp} → ${p.hp})`);
	checkEq(Ply.damageIsServerOwned(), false, "damage is not server-owned yet");

	const prev = defaultSave();
	const upd = defaultSave();
	upd.level = 40;
	upd.exp = 900;
	upd.bossKills = 12;
	checkEq(PROG.stripClientProgress(prev, upd), false, "and a report is still the client's to make");
	checkEq(upd.level, 40, "so its fields survive");
}

{
	CFG.MP_PHASE = PROG.PROGRESS_SERVER_PHASE;
	const save = defaultSave();
	const p = Ply.createPlayer(save, 0, 0);
	const hp = p.hp;
	checkEq(Ply.damageIsServerOwned(), true, "MP_PHASE 2: the server owns damage");
	checkEq(Ply.damageToPlayer(p, save, 40), false, "every client call site becomes a no-op…");
	checkEq(p.hp, hp, "…and cannot take a single point of hp off a survivor");
	check(Ply.applyPlayerDamage(p, save, 40), "the server's own entry point still works");
	check(p.hp < hp, `and it is the one that moves the bar (${hp} → ${p.hp})`);
}

{
	// the same thing through the module a zombie would use: server/sim/combat.ts
	CFG.MP_PHASE = PROG.PROGRESS_SERVER_PHASE;
	const fx = newFixture();
	const sp = makePlayer(fx, 0, 1000, 1000, 10);
	const hp = sp.state.hp;
	check(fx.combat.damagePlayer(sp, 25, 0), "the server applies a bite through damagePlayer");
	check(sp.state.hp < hp, `the survivor's hp moved on the server (${hp} → ${sp.state.hp})`);
	checkEq(fx.combat.statsOf(0).damageTaken > 0, true, "and it is on the record for the admin panel");
}

{
	// the drop-in sink the horde owner injects into shared/sim/ai/*, now that damageToPlayer is inert there
	CFG.MP_PHASE = PROG.PROGRESS_SERVER_PHASE;
	const fx = newFixture();
	const sp = makePlayer(fx, 0, 1000, 1000, 10);
	const sink = fx.combat.damageSink(p => (p === sp.state ? 0 : -1));
	const hp = sp.state.hp;
	check(sink(sp.state, sp.save, 30), "a bite routed through the server's damage sink lands");
	check(sp.state.hp < hp, `and it is the server that moved the bar (${hp} → ${sp.state.hp})`);
	const stranger = Ply.createPlayer(defaultSave(), 0, 0);
	checkEq(sink(stranger, defaultSave(), 30), false, "a survivor this server does not know takes nothing");
	checkEq(stranger.hp, 100, "and their hp is untouched");
}

{
	CFG.MP_PHASE = PROG.PROGRESS_SERVER_PHASE;
	const prev = defaultSave();
	prev.level = 7;
	prev.exp = 33;
	prev.skillPoint = 2;
	prev.bossKills = 4;
	prev.day = 9;
	const upd = defaultSave();
	upd.level = 400;
	upd.exp = 999999;
	upd.skillPoint = 300;
	upd.bossKills = 900;
	upd.day = 5000;
	upd.ammoNormal = 123; // not a progress field: the report may still carry it
	check(PROG.stripClientProgress(prev, upd), "a report that tries to move progress is noticed");
	checkEq(upd.level, 7, "level comes from the server");
	checkEq(upd.exp, 33, "so does XP");
	checkEq(upd.skillPoint, 2, "and the skill points");
	checkEq(upd.bossKills, 4, "and the boss kills");
	checkEq(upd.day, 9, "and the day");
	checkEq(upd.ammoNormal, 123, "fields the server does not own yet are left alone");
	checkEq(PROG.stripClientProgress(upd, upd), false, "a report that agrees with the server is not an anomaly");
}

CFG.MP_PHASE = PHASE_BEFORE;
checkEq(CFG.MP_PHASE, 2, "MP_PHASE is put back where the repository has it (tools/test-net.mjs pins it)");

// ================================================================ f. the fair bite (§2.3)

section("f. a bite must also reach the victim where the VICTIM saw the zombie (§2.3 'mordida justa')");

{
	const fx = newFixture();
	const sp = makePlayer(fx, 0, 1000, 1000, 10);
	const z = tough(createZombie(1, 1000, 1000, 1));
	fx.zombies.push(z);
	// the zombie spent the last 20 ticks far away, and only teleported into contact in the present
	for (let tick = 1; tick <= 20; tick++) {
		z.x = 1600;
		fx.combat.afterWorld(tick);
	}
	z.x = 1010;
	fx.combat.afterWorld(21);
	sp.viewTick = 10;
	sp.viewFrac = 0;
	fx.combat.setPing(0, 0.15);
	checkEq(fx.combat.biteAllowed(sp, z, 40, 21), false, "a zombie the victim never saw in reach cannot bite them");
	// and the honest case: it really was next to them at the moment they were drawing
	const fx2 = newFixture();
	const sp2 = makePlayer(fx2, 0, 1000, 1000, 10);
	const z2 = tough(createZombie(1, 1020, 1000, 1));
	fx2.zombies.push(z2);
	for (let tick = 1; tick <= 21; tick++) fx2.combat.afterWorld(tick);
	sp2.viewTick = 15;
	sp2.viewFrac = 0;
	fx2.combat.setPing(0, 0.15);
	checkEq(fx2.combat.biteAllowed(sp2, z2, 40, 21), true, "a zombie that was in their face all along bites");
}

// ================================================================ g. bosses are hit through the same path

section("g. the same resolution covers bosses (§2.3)");

{
	const fx = newFixture();
	const sp = makePlayer(fx, 0, 1000, 1000, 20); // Bolt action sniper: 1200 u
	const b = createBoss(2, 1500, 1000);
	fx.bosses.push(b);
	fx.combat.afterWorld(1);
	sp.viewTick = 1;
	// a sniper fires on RELEASE: press and hold, then let go
	tickPlayer(fx, sp, aimCommand(sp, 1, b.x, b.y, 1, true), 2);
	const cmd = P.makeCommand(2, 0, 0, Math.atan2(b.y - sp.state.y, b.x - sp.state.x), 0, P.packEdges(0, 1, 0, 0));
	tickPlayer(fx, sp, cmd, 3);
	check(b.hp < b.hpMax, `the boss lost hp to a server-resolved shot (${b.hpMax} → ${b.hp})`);
	checkEq(fx.combat.statsOf(0).hitsBoss, 1, "and the hit is counted against the boss, not a zombie");
}

// ---------------------------------------------------------------- verdict

console.log("");
if (failures > 0) {
	console.log(`${failures} failure(s)`);
	process.exit(1);
}
console.log("all authoritative combat tests passed");
