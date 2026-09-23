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
const { ServerCombat } = require(join(SRC, "server/sim/combat.ts"));
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
 * One measurement: a client at `rttMs` firing at what it SEES (the world INTERP_DEFAULT_S behind the server,
 * which is what §5.1 draws), with its command arriving half an RTT later.
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
			const view = tick - interpTicks;
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
	check(Math.abs(rewindCapS(0.15, 0.1, 60) - (0.075 + 0.1 + 2 / 60)) < 1e-9, "ping/2 + interpolation + 2 ticks");
	checkEq(rewindCapS(2, 0.25, 60), CFG.REWIND_MAX_S, "and it never exceeds REWIND_MAX_S, whatever the ping");
	check(biteRewindCapS(2, 0.25, 60) === CFG.FAIR_BITE_REWIND_MAX_S, "a bite gets the shorter FAIR_BITE ceiling");
	checkEq(judgedTick(100, 400, 0.3, 60), 100, "a view from the FUTURE collapses to the present");
	checkEq(judgedTick(100, Number.NaN, 0.3, 60), 100, "and so does a NaN");
	checkEq(judgedTick(100, 0, 0.1, 60), 94, "an ancient view is clamped to the ceiling, not refused");
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
checkEq(CFG.MP_PHASE, 1, "MP_PHASE is put back where the repository has it (tools/test-net.mjs pins it)");

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
