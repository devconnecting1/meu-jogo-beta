#!/usr/bin/env node
/*
 * Whose day is it, and what a death costs (docs/DESIGN_RULES.md MP-13, MP-20, MP-21).
 *
 *   npm run test:life                   # everything (exit code 1 on any failure)
 *   node tools/test-life.mjs --seed 7   # a different network schedule for section 2
 *   PZ_SRC=path/to/src node tools/test-life.mjs
 *
 * Two survivors on one server turned up on different days: one read "Day 1 Morning", the other
 * "Day 2 Evening". The cause was a client that RESET its own clock when a run restarted — `newWorld()`
 * built a fresh DayNight, and a fresh DayNight opens at `save.day` and 07:00, which after a `resetRun` is
 * day 1 at sunrise. The server was right all along and corrected it, but only on the next Clock delta,
 * which goes out on a change or every CLOCK_RESYNC_S (docs/MULTIPLAYER.md §4.5) — ten seconds of somebody
 * else's night rendered as broad daylight.
 *
 * This file pins the four things that has to stop happening:
 *
 *   1. THE DAY IS THE WORLD'S    restarting a run does not move the world's clock by one second, and the
 *                                survivor's OWN day is the only number that goes back to 1 (MP-13, MP-20).
 *   2. ONE DAY FOR EVERYONE      two clients on the same server — one lagged, losing most of its deltas and
 *                                restarting in the middle of the night — read the same day and the same
 *                                hour as the server and as each other.
 *   3. THE WAIT ENDS AT DAWN     MP-21's wait is exactly the rest of the night: begun at any hour of the
 *                                dark it runs out at 06:00, and it never runs longer than one whole night.
 *   4. ONE CLICK, NOT TWO        an "outdated" refusal always hands back the runRev that makes the single
 *                                automatic retry succeed, which is what turns "click New game twice" into
 *                                clicking it once.
 *
 * Pure Node (>= 18) + the project's TypeScript (devDependency) to transpile src/ on the fly, with the same
 * Luau / roblox-ts shims the other tools use. `math.random` is a seeded generator, so every run is
 * reproducible — the network schedule included.
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
const numArg = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};
const SEED = numArg("--seed", 1);

// ---------------------------------------------------------------- seeded randomness

let rngState = SEED >>> 0;
function nextRandom() {
	rngState = (rngState + 0x6d2b79f5) >>> 0;
	let t = rngState;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (a, b) => a + nextRandom() * (b - a);

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
	exp: Math.exp,
	pow: Math.pow,
	min: Math.min,
	max: Math.max,
	sign: Math.sign,
	pi: Math.PI,
	huge: Infinity,
	clamp: (v, a, b) => Math.min(Math.max(v, a), b),
	rad: d => (d * Math.PI) / 180,
	deg: r => (r * 180) / Math.PI,
	round: x => (x < 0 ? -Math.round(-x) : Math.round(x)),
	random: (a, b) =>
		a === undefined
			? nextRandom()
			: b === undefined
				? 1 + Math.floor(nextRandom() * a)
				: a + Math.floor(nextRandom() * (b - a + 1)),
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
	Lerp(o, k) {
		return new Color3(this.R + (o.R - this.R) * k, this.G + (o.G - this.G) * k, this.B + (o.B - this.B) * k);
	}
}
globalThis.Color3 = Color3;
/**
 * Luau `buffer`. Nothing in this file encodes a packet, but server/sim/waves.ts reaches into
 * shared/net/protocol.ts for WorldEv and AnnounceKind, and that module builds a scratch writer while it
 * loads. tools/test-net.mjs owns the strict version that fuzzes the wire; this one only has to be correct.
 */
const buf = new WeakMap();
const view = b => {
	const v = buf.get(b);
	if (v === undefined) throw new Error("not a buffer");
	return v;
};
globalThis.buffer = {
	create: n => {
		const b = { __buffer: true };
		buf.set(b, new DataView(new ArrayBuffer(n)));
		return b;
	},
	len: b => view(b).byteLength,
	copy: (dst, dstOffset, src, srcOffset = 0, count) => {
		const s = view(src);
		const d = view(dst);
		const n = count ?? s.byteLength - srcOffset;
		for (let i = 0; i < n; i++) d.setUint8(dstOffset + i, s.getUint8(srcOffset + i));
	},
	writeu8: (b, o, v) => view(b).setUint8(o, v & 0xff),
	writei8: (b, o, v) => view(b).setInt8(o, v),
	writeu16: (b, o, v) => view(b).setUint16(o, v & 0xffff, true),
	writei16: (b, o, v) => view(b).setInt16(o, v, true),
	writeu32: (b, o, v) => view(b).setUint32(o, v >>> 0, true),
	writef32: (b, o, v) => view(b).setFloat32(o, v, true),
	writef64: (b, o, v) => view(b).setFloat64(o, v, true),
	readu8: (b, o) => view(b).getUint8(o),
	readi8: (b, o) => view(b).getInt8(o),
	readu16: (b, o) => view(b).getUint16(o, true),
	readi16: (b, o) => view(b).getInt16(o, true),
	readu32: (b, o) => view(b).getUint32(o, true),
	readf32: (b, o) => view(b).getFloat32(o, true),
	readf64: (b, o) => view(b).getFloat64(o, true),
	writestring: (b, o, s, n) => {
		const d = view(b);
		const bytes = Buffer.from(s, "utf8");
		const count = n ?? bytes.length;
		for (let i = 0; i < count; i++) d.setUint8(o + i, bytes[i] ?? 0);
	},
	readstring: (b, o, n) => {
		const d = view(b);
		const bytes = Buffer.alloc(n);
		for (let i = 0; i < n; i++) bytes[i] = d.getUint8(o + i);
		return bytes.toString("utf8");
	},
};

const AP = Array.prototype;
const shim = (name, fn) => Object.defineProperty(AP, name, { value: fn, configurable: true, writable: true });
shim("size", function () {
	return this.length;
});
shim("remove", function (i) {
	return this.splice(i, 1)[0];
});
shim("clear", function () {
	this.length = 0;
});
shim("insert", function (i, v) {
	this.splice(i, 0, v);
});

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

/** Luau's `typeIs`, which shared/game/save.ts uses to validate every wallet field it reads */
globalThis.typeIs = (v, t) => {
	if (t === "number") return typeof v === "number";
	if (t === "string") return typeof v === "string";
	if (t === "boolean") return typeof v === "boolean";
	if (t === "nil") return v === undefined || v === null;
	if (t === "function") return typeof v === "function";
	if (t === "table") return typeof v === "object" && v !== null;
	return false;
};

const {
	advanceClock,
	daybreakWaitSeconds,
	gameHours,
	secondsUntilHour,
	DAY_BREAK_HOUR,
	HOURS_PER_DAY,
	NIGHT_REAL_SECONDS,
} = require(join(SRC, "shared/sim/clock.ts"));
const { WorldClock } = require(join(SRC, "server/sim/waves.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const { applyWallet, defaultSave, resetRun, walletOf } = require(join(SRC, "shared/game/save.ts"));
const mpConfig = require(join(SRC, "shared/net/mpConfig.ts"));

/**
 * The client clock only obeys the server from MP_PHASE 2 on — that gate is the whole reason a stray delta
 * cannot take the clock away from a single-player build. tools/test-net.mjs pins the project's value; this
 * file moves it the way a live F2 server does, and section 1 puts it back to prove the gate still holds.
 */
function setPhase(value) {
	mpConfig.MP_PHASE = value;
}
setPhase(2);
const { DayNight, CLOCK_SNAP_H } = require(join(SRC, "client/systems/daynight.ts"));

// ---------------------------------------------------------------- reporting

let failures = 0;
function check(name, ok, detail) {
	const tail = detail === undefined ? "" : `  (${detail})`;
	if (ok) {
		console.log(`  ok    ${name}${tail}`);
	} else {
		console.error(`  FAIL  ${name}${tail}`);
		failures += 1;
	}
}
function section(title) {
	console.log(`\n${title}`);
}

const TICK_DT = 1 / 60;
const abs = c => gameHours(c.day, c.dayTime);
const newClock = (options = {}) => new WorldClock({ rollRain: () => false, ...options });
/** the Clock delta as client/net/netClient.ts hands it to `applyClock` (minus the wire fields) */
const deltaOf = clock => ({
	worldDay: clock.day,
	dayTime: clock.dayTime,
	rain: clock.isRaining,
	waveFlags: 0,
});
const wrapHour = h => h - Math.floor(h / HOURS_PER_DAY) * HOURS_PER_DAY;

console.log(
	`read from the code: TIME_SPEED ${DESIGN.TIME_SPEED} h/s, one night is ${NIGHT_REAL_SECONDS.toFixed(1)} s ` +
		`(${(NIGHT_REAL_SECONDS / 60).toFixed(2)} min), daybreak at ${DAY_BREAK_HOUR}:00, snap at ${CLOCK_SNAP_H} h`,
);

// ================================================================ 1: the day belongs to the world

section("1) restarting a run is a new LIFE, not a new world (MP-13, MP-20)");

{
	// a town well into its twelfth night, and a survivor who has been alive for three days of it
	const server = newClock({ day: 12, dayTime: 22.4 });
	const save = defaultSave();
	save.day = 3;
	const before = new DayNight(save);
	before.applyClock(deltaOf(server));
	check(
		"the client takes the server's day and hour",
		before.day === 12 && Math.abs(before.dayTime - 22.4) < 1e-9,
		`day ${before.day} at ${before.dayTime.toFixed(2)}h`,
	);

	// this is `newWorld()` → GameLoop.init: the save starts a fresh life and the loop rebuilds its clock
	resetRun(save);
	check("…and New game puts the survivor's own day back to 1", save.day === 1, `save.day ${save.day}`);

	const naive = new DayNight(save);
	check(
		"a clock rebuilt from the save alone IS the bug: day 1, 07:00",
		naive.day === 1 && Math.abs(naive.dayTime - 7) < 1e-9,
		`day ${naive.day} at ${naive.dayTime.toFixed(2)}h — what the playtest saw`,
	);

	const after = new DayNight(save);
	check("adoptWorld takes the world's clock over", after.adoptWorld(before) === true);
	check(
		"the world's day did not move",
		after.day === 12 && Math.abs(after.dayTime - 22.4) < 1e-9,
		`day ${after.day} at ${after.dayTime.toFixed(2)}h`,
	);
	check("…and it is still the SERVER's clock, not a local one", after.serverDriven() === true);
	check(
		"…so the night is still dark",
		after.darkAlpha > 0.5 && naive.darkAlpha === 0,
		`darkAlpha ${after.darkAlpha.toFixed(2)} vs ${naive.darkAlpha.toFixed(2)} on the naive one`,
	);
	check(
		"the two numbers of MP-13 have parted company",
		after.day === 12 && save.day === 1,
		`world day ${after.day}, life day ${save.day}`,
	);

	// the survivor's own day is credited once per world midnight, mirroring server/sim/progress.ts
	const lifeStart = save.day;
	const worldStart = after.day;
	let spent = 0;
	while (spent < 1400) {
		server.step(TICK_DT);
		after.applyClock(deltaOf(server));
		after.update(TICK_DT);
		spent += TICK_DT;
	}
	check(
		"both days then advance together, from their own starting points",
		after.day - worldStart === save.day - lifeStart && save.day - lifeStart >= 2,
		`world ${worldStart}→${after.day}, life ${lifeStart}→${save.day}`,
	);
	check("…and they are still different numbers", after.day !== save.day, `${after.day} vs ${save.day}`);

	// the gate: below MP_PHASE 2 every client owns its own town, so there is no world clock to take over
	setPhase(1);
	const solo = new DayNight(save);
	check("below MP_PHASE 2 there is nothing to adopt", solo.adoptWorld(after) === false);
	check(
		"…and the local clock is untouched by it",
		solo.day === save.day && Math.abs(solo.dayTime - 7) < 1e-9,
		`day ${solo.day} at ${solo.dayTime.toFixed(2)}h`,
	);
	setPhase(2);
}

// ================================================================ 2: two clients, one day

section("2) two clients on one server read the same day, through lag, loss and a restart");

{
	const server = newClock({ day: 7, dayTime: 17.8 });
	const saveA = defaultSave();
	saveA.day = 5;
	const saveB = defaultSave();
	saveB.day = 1;
	let a = new DayNight(saveA);
	const b = new DayNight(saveB);

	/** in flight: { at (real seconds), delta } */
	const toA = [];
	const toB = [];
	const LAG_A = 0.08;
	const LAG_B = 0.22;
	const LOSS_B = 0.55;
	// a bit over one game day, so the pair crosses a midnight together
	const RUN_FOR = 700;

	let restarted = false;
	/** real seconds at which both clients had heard from the server at least once, or -1 */
	let drivenAt = -1;
	let worst = 0;
	let worstPair = 0;
	let dayMismatches = 0;
	let samples = 0;
	let t = 0;

	while (t < RUN_FOR) {
		server.step(TICK_DT);
		if (server.clockEvent(0) !== undefined) {
			toA.push({ at: t + LAG_A, delta: deltaOf(server) });
			if (nextRandom() > LOSS_B) toB.push({ at: t + LAG_B, delta: deltaOf(server) });
		}
		while (toA.length > 0 && toA[0].at <= t) a.applyClock(toA.shift().delta);
		while (toB.length > 0 && toB[0].at <= t) b.applyClock(toB.shift().delta);
		a.update(TICK_DT);
		b.update(TICK_DT);

		// two minutes in, A gives up and presses New game: a fresh save, a fresh map, a fresh DayNight —
		// and the town carries on exactly where it was
		if (!restarted && t > 120) {
			restarted = true;
			resetRun(saveA);
			const next = new DayNight(saveA);
			next.adoptWorld(a);
			a = next;
			check(
				"the restart itself does not move the world's clock",
				Math.abs(abs(a) - abs(server)) < CLOCK_SNAP_H,
				`client day ${a.day} at ${a.dayTime.toFixed(2)}h vs server day ${server.day} at ${server.dayTime.toFixed(2)}h`,
			);
			check("…while the survivor's own day started over", saveA.day === 1, `life day ${saveA.day}`);
		}

		/*
		 * Sampling starts once both clients have heard from the server at least once, because until then
		 * there is nothing to compare: the Clock delta goes out on a CHANGE or every CLOCK_RESYNC_S (§4.5),
		 * and B drops more than half of them, so its first one can be two resyncs away. How long that took
		 * is itself asserted below — a client that never hears the hour is the bug, not the baseline.
		 */
		if (drivenAt < 0 && a.serverDriven() && b.serverDriven()) drivenAt = t;
		// …and away from the wrap, where "the same day" is a question with exactly one answer
		if (drivenAt >= 0 && t > drivenAt + 1 && server.dayTime > 0.5 && server.dayTime < 23.5) {
			samples += 1;
			worst = Math.max(worst, Math.abs(abs(a) - abs(server)), Math.abs(abs(b) - abs(server)));
			worstPair = Math.max(worstPair, Math.abs(abs(a) - abs(b)));
			if (a.day !== server.day || b.day !== server.day) dayMismatches += 1;
		}
		t += TICK_DT;
	}

	check(
		"both clients heard the hour within a couple of resyncs",
		drivenAt >= 0 && drivenAt < 60,
		`after ${drivenAt.toFixed(1)} s, with B losing ${(LOSS_B * 100).toFixed(0)}% of the deltas`,
	);
	check("both clients tracked the server's hour", worst <= CLOCK_SNAP_H, `worst error ${worst.toFixed(4)} h`);
	check("…and each other's", worstPair <= CLOCK_SNAP_H, `worst gap ${worstPair.toFixed(4)} h`);
	check("nobody ever showed a different DAY", dayMismatches === 0, `${samples} samples`);
	check(
		"…while the restarted survivor's own day stayed its own number",
		a.day === server.day && a.day !== saveA.day,
		`world day ${a.day}, A's life day ${saveA.day}, B's ${saveB.day}`,
	);
}

// ================================================================ 3: the wait ends at daybreak

section("3) died in the dark, up at first light (MP-21)");

{
	let worst = 0;
	let worstAt = 0;
	// every tenth of an hour of the night: 19:00 through 05:54
	for (let i = 0; i < 110; i++) {
		const hour = wrapHour(19 + i * 0.1);
		const landed = wrapHour(advanceClock(hour, daybreakWaitSeconds(hour)));
		const err = Math.abs(landed - DAY_BREAK_HOUR);
		if (err > worst) {
			worst = err;
			worstAt = hour;
		}
	}
	check(
		"begun at any hour of the night, the wait runs out at 06:00",
		worst < 1e-9,
		`worst ${worst.toExponential(2)} h, at ${worstAt.toFixed(1)}:00`,
	);

	check(
		"a death at dusk costs exactly one night",
		Math.abs(daybreakWaitSeconds(19) - NIGHT_REAL_SECONDS) < 1e-9,
		`${daybreakWaitSeconds(19).toFixed(1)} s = ${(NIGHT_REAL_SECONDS / 60).toFixed(2)} min`,
	);
	check(
		"…which is the 11 h at 1.2× TIME_SPEED the rule prices it at",
		Math.abs(NIGHT_REAL_SECONDS - 11 / (DESIGN.TIME_SPEED * 1.2)) < 1e-9,
		`${NIGHT_REAL_SECONDS.toFixed(1)} s`,
	);
	check(
		"the deeper into the night, the shorter the wait",
		daybreakWaitSeconds(23) < daybreakWaitSeconds(21) && daybreakWaitSeconds(5) < daybreakWaitSeconds(23),
		`21h ${daybreakWaitSeconds(21).toFixed(0)}s · 23h ${daybreakWaitSeconds(23).toFixed(0)}s · 5h ${daybreakWaitSeconds(5).toFixed(0)}s`,
	);

	let longest = 0;
	for (let i = 0; i < 240; i++) longest = Math.max(longest, daybreakWaitSeconds(i * 0.1));
	check(
		"and no death, at any hour at all, costs more than one night",
		longest <= NIGHT_REAL_SECONDS + 1e-9,
		`longest ${longest.toFixed(1)} s`,
	);
	check(
		"a death in broad daylight is capped there instead of waiting the day out",
		Math.abs(daybreakWaitSeconds(12) - NIGHT_REAL_SECONDS) < 1e-9 &&
			secondsUntilHour(12, DAY_BREAK_HOUR) > NIGHT_REAL_SECONDS * 1.5,
		`12:00 → ${daybreakWaitSeconds(12).toFixed(0)} s, uncapped it would be ${secondsUntilHour(12, DAY_BREAK_HOUR).toFixed(0)} s`,
	);

	// the countdown server/net/mpHost.ts actually runs: real seconds off a Heartbeat, against a live clock
	const clock = newClock({ day: 4, dayTime: 21 });
	let left = daybreakWaitSeconds(clock.dayTime);
	let ticks = 0;
	while (left > 0 && ticks < 60 * 600) {
		clock.step(TICK_DT);
		left -= TICK_DT;
		ticks += 1;
	}
	check(
		"the host's real-seconds countdown lands on daybreak, on the next day",
		Math.abs(clock.dayTime - DAY_BREAK_HOUR) < 0.01 && clock.day === 5,
		`clock reads day ${clock.day} at ${clock.dayTime.toFixed(3)}h after ${(ticks * TICK_DT).toFixed(1)} s`,
	);
	check(
		"…and the wait it counted is the one the screen showed",
		Math.abs(ticks * TICK_DT - daybreakWaitSeconds(21)) <= TICK_DT,
		`${(ticks * TICK_DT).toFixed(2)} s counted vs ${daybreakWaitSeconds(21).toFixed(2)} s promised`,
	);
}

// ================================================================ 4: one click, not two

section('4) an "outdated" refusal carries the runRev that makes the retry work');

{
	/*
	 * server/main.server.ts `handleAction`, transcribed down to the one rule this is about: a request
	 * naming a run the session has already moved past is refused, and the refusal carries the current
	 * wallet. The session is deliberately AHEAD of the client here — which is what an admin edit applied
	 * to the session but DEFERRED on a mid-run client leaves behind (client/admin/patches.ts).
	 */
	const session = defaultSave();
	session.runRev = 5;
	session.runOver = true;
	const client = defaultSave();
	client.runRev = 3;
	client.runOver = true;

	const handleNewRun = runRev => {
		if (runRev !== session.runRev) return { ok: false, reason: "outdated", wallet: walletOf(session) };
		resetRun(session);
		session.runRev += 1;
		return { ok: true, wallet: walletOf(session) };
	};

	const asked = client.runRev;
	const first = handleNewRun(asked);
	applyWallet(client, first.wallet);
	check("the first click is refused as outdated", first.ok === false && first.reason === "outdated");
	check(
		"…but its wallet corrects the client's runRev on the way out",
		client.runRev === session.runRev,
		`client ${asked} → ${client.runRev}, session ${session.runRev}`,
	);
	check("…so the client knows it has something new to say", client.runRev !== asked);

	const second = handleNewRun(client.runRev);
	applyWallet(client, second.wallet);
	check("the retry succeeds, on what the player experienced as one click", second.ok === true);
	check("…and leaves the two in step", client.runRev === session.runRev, `runRev ${client.runRev}`);
	check("…with the run actually restarted", session.day === 1 && session.runOver === false);

	// the retry is bounded: a refusal that teaches the client nothing must not be asked again
	const stuck = defaultSave();
	stuck.runRev = 9;
	const before = stuck.runRev;
	applyWallet(stuck, walletOf(stuck));
	check("a refusal that changes nothing is not retried", stuck.runRev === before, `runRev still ${stuck.runRev}`);

	// applyWallet only ever moves runRev FORWARD: an answer that crossed a newer change cannot undo it
	const raced = defaultSave();
	raced.runRev = 12;
	applyWallet(raced, { runRev: 4 });
	check("a stale wallet cannot roll the runRev back", raced.runRev === 12, `runRev ${raced.runRev}`);
}

// ================================================================

console.log("");
if (failures > 0) {
	console.error(`${failures} check(s) failed`);
	process.exit(1);
}
console.log("all checks passed");
