#!/usr/bin/env node
/*
 * The match clock and the night waves (docs/MULTIPLAYER.md §3.1, §4.5, §4.6, §11.3 F2-2B).
 *
 *   npm run test:clock                  # everything (exit code 1 on any failure)
 *   node tools/test-clock.mjs --days 3  # longer soak of the client convergence (default 2 game days)
 *   PZ_SRC=path/to/src node tools/test-clock.mjs
 *
 * Until F2 the clock ran in every client (client/systems/daynight.ts), so two survivors on one server could be
 * at different hours and the 19h / 22h / 1h waves reached each of them at a different moment. The clock now
 * lives in server/sim/waves.ts and travels as WorldEv.Clock; the client replays it. This file proves the three
 * things that has to be true for that to be an improvement rather than a new class of bug:
 *
 *   1. ONE CLOCK        the server's hour does not depend on how its ticks fall — 60 Hz, the §3.1 fallback of
 *                       30 Hz and a stuttering heartbeat land on the same hour, so every client that is told
 *                       the hour is told the SAME hour, and a laggy server does not drift into its own night.
 *   2. CONVERGENCE      a client fed delayed, quantised and mostly LOST Clock deltas tracks the server within
 *                       §4.6's 0.05 h, never runs time backwards, never jumps the night on screen, and walks
 *                       through every hour in order — including a full minute with no delta at all.
 *   3. THE PROMISE      the queues are filled once, between 18:00 and 18:30, with exactly the original's
 *                       numbers; the three waves start once each, at 19:00, 22:00 and 01:00; and the whole
 *                       promised headcount is delivered before dawn whether the pacing director is running at
 *                       its slowest or its fastest — a relief paces a wave, it never shortens one.
 *
 * Plus the two guards around them: an admin skip announces nothing and credits nothing (§3.6), and the whole
 * server-driven path is inert below MP_PHASE 2, so a stray delta cannot take the clock away from a client that
 * is still simulating for itself.
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
const SOAK_DAYS = numArg("--days", 2);

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

const CLOCK = require(join(SRC, "shared/sim/clock.ts"));
const { WorldClock, pouringWave } = require(join(SRC, "server/sim/waves.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const { getDayPopulation } = require(join(SRC, "shared/data/spawns.ts"));
const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
const { AnnounceKind, CLOCK_HOUR_SCALE } = require(join(SRC, "shared/net/protocol.ts"));
const { WAVE_MIN, WAVE_MAX } = require(join(SRC, "shared/sim/ai/director.ts"));
const mpConfig = require(join(SRC, "shared/net/mpConfig.ts"));
const PROJECT_MP_PHASE = mpConfig.MP_PHASE;

/**
 * The client half only wakes up at MP_PHASE >= 2 (that is the point of the gate), and the project is still
 * pinned at 1 by tools/test-net.mjs. The phase is a plain exported const, so the test can move it the way the
 * live server will when F2 lands — and section 5 puts it back to prove the gate itself.
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
const HOURS = CLOCK.HOURS_PER_DAY;
const abs = c => c.day * HOURS + c.dayTime;
/** real seconds of one game day: 13 h of day at 0.8× plus 11 h of night at 1.2× */
const DAY_SECONDS = 13 / (DESIGN.TIME_SPEED * 0.8) + 11 / (DESIGN.TIME_SPEED * 1.2);

/** a clock with scripted weather, so nothing in this file depends on a dice roll */
function newClock(options = {}) {
	return new WorldClock({ rollRain: () => false, ...options });
}

console.log(
	`clock read from the code: TIME_SPEED ${DESIGN.TIME_SPEED} h/s, a game day is ${DAY_SECONDS.toFixed(1)} s, ` +
		`resync every ${require(join(SRC, "shared/net/mpConfig.ts")).CLOCK_RESYNC_S} s, wire step 1/${CLOCK_HOUR_SCALE} h`,
);

// ================================================================ 1: one clock for everybody

section("1) the server's hour does not depend on how the ticks fall (§3.1, §4.6)");

{
	// the three runs must cover EXACTLY the same real time, or the test would be measuring its own loop
	const TICKS = Math.round(DAY_SECONDS * 1.5 * 60);
	const runFor = TICKS * TICK_DT;
	const fixed60 = newClock();
	const fixed30 = newClock();
	const stuttering = newClock();

	for (let i = 0; i < TICKS; i++) fixed60.step(TICK_DT);
	for (let i = 0; i < TICKS / 2; i++) fixed30.step(1 / 30);
	// a heartbeat that hitches: Studio breakpoints, a DataStore call, a frame that took 250 ms
	let spent = 0;
	while (spent < runFor) {
		const dt = nextRandom() < 0.02 ? between(0.15, 0.3) : between(0.004, 0.05);
		const step = Math.min(dt, runFor - spent);
		stuttering.step(step);
		spent += step;
	}

	check(
		"60 Hz and 30 Hz land on the same hour",
		Math.abs(abs(fixed60) - abs(fixed30)) < 1e-9,
		`Δ ${(abs(fixed60) - abs(fixed30)).toExponential(2)} h`,
	);
	check(
		"a stuttering heartbeat lands on the same hour",
		Math.abs(abs(fixed60) - abs(stuttering)) < 1e-9,
		`Δ ${(abs(fixed60) - abs(stuttering)).toExponential(2)} h over ${runFor.toFixed(1)} s`,
	);
	check("and on the same day", fixed60.day === fixed30.day && fixed60.day === stuttering.day, `day ${fixed60.day}`);
	check(
		"with the same waves and the same dawn count",
		fixed60.wave1Active === fixed30.wave1Active &&
			fixed60.wave3Active === stuttering.wave3Active &&
			fixed60.morningCount === stuttering.morningCount,
		`morningCount ${fixed60.morningCount}`,
	);

	// the speed change at 19:00 is the one place a step-size dependency could hide: a step that straddles it
	// must give the same answer as two steps that stop on it
	const whole = newClock({ dayTime: 18.99 });
	const split = newClock({ dayTime: 18.99 });
	whole.step(2);
	split.step(0.5);
	split.step(1.5);
	check(
		"a step across 19:00 is split at the speed change",
		Math.abs(whole.dayTime - split.dayTime) < 1e-12,
		`${whole.dayTime.toFixed(9)} vs ${split.dayTime.toFixed(9)}`,
	);
	const nightSpeed = DESIGN.TIME_SPEED * 1.2;
	const daySpeed = DESIGN.TIME_SPEED * 0.8;
	const expected = 18.99 + daySpeed * ((19 - 18.99) / daySpeed) + nightSpeed * (2 - (19 - 18.99) / daySpeed);
	check(
		"…and the night part really runs at 1.2×",
		Math.abs(whole.dayTime - expected) < 1e-9,
		`${whole.dayTime.toFixed(6)} vs ${expected.toFixed(6)}`,
	);
}

// ================================================================ 2: the client converges

section(`2) a client on a lossy link tracks the server (${SOAK_DAYS} game day(s), §4.6)`);

{
	// day 5 is the first the original lets rain (`if day<=4 weather = 0`): scripted, so the weather crosses
	// the wire in this run instead of depending on a 10 % roll
	const server = newClock({ day: 5, dayTime: 16, rollRain: day => day === 6 });
	const save = defaultSave();
	const client = new DayNight(save);
	client.day = 1; // deliberately wrong: the first delta has to take the client to the server's day

	let announced = [];
	client.onAnnounce = text => announced.push({ text, at: client.dayTime, day: client.day });

	/** in flight: {at (real seconds), event, sampledTick} */
	const wire = [];
	const LOSS = 0.6;
	const BLACKOUT_FROM = DAY_SECONDS * 0.35;
	const BLACKOUT_TO = BLACKOUT_FROM + 60;

	let now = 0;
	let tick = 0;
	let clientAcc = 0;
	let worstError = 0;
	let worstStep = 0;
	let backwards = 0;
	let worstDarkStep = 0;
	let delivered = 0;
	let dropped = 0;
	const hoursSeen = new Set();
	let prevAbs = -1;
	let prevDark = -1;
	let prevHour = 0;
	let prevRain = false;
	/**
	 * Nothing is measured before the first delta lands: until then the client is running its OWN clock (it
	 * was deliberately started on the wrong day), and the one jump it is allowed is the lock onto the server.
	 */
	let locked = false;
	/** the deepest night moves darkAlpha this fast; the correction may add a quarter on top (CLOCK_CATCHUP) */
	const DARK_PER_HOUR = (DESIGN.DARK_ALPHA_MAX / 6) * 3;
	const DARK_LIMIT = DARK_PER_HOUR * CLOCK.clockSpeed(0) * 1.3;

	const runFor = DAY_SECONDS * SOAK_DAYS;
	while (now < runFor) {
		// ---- server: one fixed tick
		server.step(TICK_DT);
		tick += 1;
		now += TICK_DT;
		const ev = server.clockEvent(tick);
		if (ev !== undefined) {
			const blackout = now >= BLACKOUT_FROM && now < BLACKOUT_TO;
			if (blackout || nextRandom() < LOSS) dropped += 1;
			else wire.push({ at: now + between(0.08, 0.25), ev, sentAt: now });
		}

		// ---- client: its own frame rate, which is not the server's
		clientAcc += TICK_DT;
		const frame = 1 / between(24, 90);
		if (clientAcc < frame) continue;
		const dt = clientAcc;
		clientAcc = 0;

		for (let i = wire.length - 1; i >= 0; i--) {
			if (wire[i].at > now) continue;
			const packet = wire[i];
			wire.splice(i, 1);
			delivered += 1;
			// what really reaches applyClock: the hour quantised to the wire grid, and an age estimate that
			// is itself a little wrong (clockSync smooths a sampled clock, §4.6)
			const quantised = Math.round(packet.ev.dayTime * CLOCK_HOUR_SCALE) / CLOCK_HOUR_SCALE;
			const age = now - packet.sentAt + between(-0.02, 0.02);
			client.applyClock({ ...packet.ev, dayTime: quantised }, age);
		}

		client.update(dt);

		if (!locked) {
			// the lock frame itself: start the measurements from the state it produced
			locked = client.serverDriven();
			prevAbs = locked ? abs(client) : -1;
			prevDark = locked ? client.darkAlpha : -1;
			prevHour = client.dayTime;
			prevRain = client.isRaining;
			continue;
		}
		const stepH = abs(client) - prevAbs;
		if (stepH < 0) backwards += 1;
		// against the faster of the two speeds the frame touched, so a frame straddling 06:00 or 19:00 is
		// measured against the speed it actually ran at rather than the one it happened to end in
		const reference = Math.max(CLOCK.clockSpeed(prevHour), CLOCK.clockSpeed(client.dayTime));
		worstStep = Math.max(worstStep, stepH / dt / reference);
		worstError = Math.max(worstError, Math.abs(abs(client) - abs(server)));
		// a weather change moves the overlay in one step by design (rain floors it at 0.5), and that is the
		// server telling the client it started raining, not the clock jumping
		if (prevRain === client.isRaining) {
			worstDarkStep = Math.max(worstDarkStep, Math.abs(client.darkAlpha - prevDark) / dt);
		}
		prevAbs = abs(client);
		prevDark = client.darkAlpha;
		prevHour = client.dayTime;
		prevRain = client.isRaining;
		hoursSeen.add(`${client.day}:${Math.floor(client.dayTime)}`);
	}

	console.log(
		`     ${delivered} deltas delivered, ${dropped} lost (${Math.round((100 * dropped) / (dropped + delivered))} %), ` +
			`including ${BLACKOUT_TO - BLACKOUT_FROM} s of total silence`,
	);
	check(
		"the client never lags the server by more than §4.6's threshold",
		worstError < CLOCK_SNAP_H,
		`worst ${worstError.toFixed(4)} h vs ${CLOCK_SNAP_H} h`,
	);
	check(
		"…so it never had to jump the night on screen",
		worstStep <= 1.25 + 1e-9,
		`fastest frame ran at ${worstStep.toFixed(3)}× the clock's own speed (the correction may add 0.25)`,
	);
	check("the clock never runs backwards", backwards === 0, `${backwards} backward frame(s)`);
	check(
		"the light moves smoothly with it",
		worstDarkStep <= DARK_LIMIT,
		`worst ${worstDarkStep.toFixed(4)} of ${DARK_LIMIT.toFixed(4)} alpha/s`,
	);
	check(
		"the weather crossed the wire",
		client.isRaining === server.isRaining,
		`client ${client.isRaining}, server ${server.isRaining}`,
	);
	check("the client is on the server's day", client.day === server.day, `client ${client.day}, server ${server.day}`);
	check(
		"every dawn was seen exactly once",
		client.morningCount === server.morningCount,
		`${client.morningCount} vs ${server.morningCount}`,
	);

	// "never skips the night": the client's own clock must have been observed inside every hour of every
	// whole day it lived through, not teleported over the dark ones
	let missed = [];
	for (let day = 6; day <= server.day - 1; day++) {
		for (let h = 0; h < 24; h++) if (!hoursSeen.has(`${day}:${h}`)) missed.push(`${day}:${h}`);
	}
	check(
		"it walked through every hour of every whole day",
		missed.length === 0,
		missed.length > 0 ? `missed ${missed.join(", ")}` : `${hoursSeen.size} hour slots visited`,
	);

	const waveTexts = announced.filter(a => a.text.startsWith("Wave")).map(a => a.text);
	check(
		"each wave was announced once per night",
		waveTexts.length === 3 * (server.day - 5),
		waveTexts.join(", ") || "none",
	);
	check(
		"the waves the client shows are the server's",
		client.wave3Active === server.wave3Active && client.wave1Active === server.wave1Active,
	);
}

// ================================================================ 3: the original's promise

section("3) the night's queues: filled once, poured on time, delivered whole (§3.5)");

{
	const server = newClock({ day: 12, dayTime: 12 });
	const pop = getDayPopulation(12);
	const fills = [];
	server.onWaveFill = f =>
		fills.push({ at: server.dayTime, day: f.day, walkers: [...f.walkers], specials: [...f.specials] });

	const starts = { 1: [], 2: [], 3: [] };
	const announcements = [];
	let wasActive = [false, false, false];

	// a stand-in for the wave half of the spawner: one zombie per interval, from the queue the clock names
	function drainer(waveScale) {
		return { timer: 0, scale: waveScale, walkers: 0, specials: 0 };
	}
	const slow = drainer(WAVE_MIN); // the slowest the pacing director may ever run a wave
	const fast = drainer(WAVE_MAX);
	const mirror = newClock({ day: 12, dayTime: 12 }); // a second clock, drained at the fast rate

	function drain(clock, d, dt) {
		d.timer += dt;
		const every = DESIGN.ZOMBIE_WAVE_SPAWN_TIME / d.scale;
		while (d.timer >= every) {
			d.timer -= every;
			const w = pouringWave(clock, clock.waveQueues);
			if (w >= 0) {
				clock.waveQueues[w] -= 1;
				d.walkers += 1;
			}
			const s = pouringWave(clock, clock.specialWaveQueues);
			if (s >= 0) {
				clock.specialWaveQueues[s] -= 1;
				d.specials += 1;
			}
		}
	}

	// noon of day 12 to 08:00 of day 13
	while (!(server.day === 13 && server.dayTime >= 8)) {
		server.step(TICK_DT);
		mirror.step(TICK_DT);
		for (const a of server.takeAnnouncements()) announcements.push({ ...a, at: server.dayTime, day: server.day });
		mirror.takeAnnouncements();
		const active = [server.wave1Active, server.wave2Active, server.wave3Active];
		for (let i = 0; i < 3; i++) {
			if (active[i] && !wasActive[i]) starts[i + 1].push({ day: server.day, at: server.dayTime });
		}
		wasActive = active;
		drain(server, slow, TICK_DT);
		drain(mirror, fast, TICK_DT);
	}

	check("the queues were filled exactly once", fills.length === 1, `${fills.length} fill(s)`);
	check(
		"…inside the 18:00–18:30 window",
		fills.length === 1 && fills[0].at > 18 && fills[0].at < 18.5,
		fills.length === 1 ? `at ${fills[0].at.toFixed(3)} h` : "n/a",
	);
	check(
		"…with the original's numbers, untouched",
		fills.length === 1 &&
			fills[0].walkers.join() === [pop.wave1, pop.wave2, pop.wave3].join() &&
			fills[0].specials.join() === [pop.specialWave1, pop.specialWave2, pop.specialWave3].join(),
		fills.length === 1 ? `walkers ${fills[0].walkers.join("/")}, specials ${fills[0].specials.join("/")}` : "n/a",
	);

	for (const [wave, hour] of [
		[1, 19],
		[2, 22],
		[3, 1],
	]) {
		const list = starts[wave];
		const ok = list.length === 1 && Math.abs(list[0].at - hour) < 0.05;
		check(
			`wave ${wave} starts once, at ${hour}:00`,
			ok,
			list.map(s => `day ${s.day} ${s.at.toFixed(3)} h`).join(", ") || "never",
		);
	}

	const texts = announcements.map(a => a.text);
	check(
		"the night announces Wave 1, Wave 2, Wave 3, Good morning — in that order",
		texts.join(" | ") === "Wave 1 | Wave 2 | Wave 3 | Good morning",
		texts.join(" | "),
	);
	check(
		"and the Announce delta carries the wave number",
		announcements[0].msg === AnnounceKind.Wave &&
			announcements[0].arg === 1 &&
			announcements[2].arg === 3 &&
			announcements[3].msg === AnnounceKind.Morning,
	);

	const promisedWalkers = pop.wave1 + pop.wave2 + pop.wave3;
	const promisedSpecials = pop.specialWave1 + pop.specialWave2 + pop.specialWave3;
	check(
		"the slowest pacing still delivers every walker",
		slow.walkers === promisedWalkers,
		`${slow.walkers} of ${promisedWalkers}`,
	);
	check("…and every special", slow.specials === promisedSpecials, `${slow.specials} of ${promisedSpecials}`);
	check(
		"the fastest pacing delivers the same, not more",
		fast.walkers === promisedWalkers && fast.specials === promisedSpecials,
		`${fast.walkers} walkers, ${fast.specials} specials`,
	);
	check(
		"nothing is left owing at dawn",
		server.waveQueues.join() === "0,0,0" && server.specialWaveQueues.join() === "0,0,0",
		server.waveQueues.join("/"),
	);

	// the table itself, for the days that change it
	let tableOk = true;
	let tableDetail = "";
	for (const day of [1, 3, 5, 12, 25]) {
		const c = newClock({ day, dayTime: 12 });
		c.fillNight();
		const p = getDayPopulation(day);
		if (c.waveQueues.join() !== [p.wave1, p.wave2, p.wave3].join()) {
			tableOk = false;
			tableDetail += ` day ${day}: ${c.waveQueues.join("/")} vs ${[p.wave1, p.wave2, p.wave3].join("/")}`;
		}
	}
	check("every day of the original's table is promised unchanged", tableOk, tableDetail || "days 1, 3, 5, 12, 25");

	// pressing "force wave" twice must not promise a second night
	const forced = newClock({ day: 12, dayTime: 12 });
	forced.fillNight();
	forced.fillNight();
	check(
		"filling an already promised night changes nothing",
		forced.waveQueues.join() === [pop.wave1, pop.wave2, pop.wave3].join(),
		forced.waveQueues.join("/"),
	);
}

// ================================================================ 4: the admin's clock

section("4) an admin moving the clock skips the hours instead of living them (§3.6, §10)");

{
	const server = newClock({ day: 3, dayTime: 12 });
	server.step(TICK_DT);
	server.takeAnnouncements();
	const before = server.morningCount;
	// the same two steps client/admin/world.ts::skipToNight takes: promise the night, THEN move the clock
	server.fillNight();
	server.setClock(23.5);
	check("skipping past 19:00 and 22:00 announces nothing", server.takeAnnouncements().length === 0);
	check(
		"…and nobody is paid for a dawn they slept through",
		server.morningCount === before,
		`${server.morningCount}`,
	);
	check("the world is where the admin put it", Math.abs(server.dayTime - 23.5) < 1e-9 && server.isNight === true);
	check("and the night's queues are ready anyway", server.waveQueues.join() !== "0,0,0", server.waveQueues.join("/"));
	const ev = server.clockEvent(1);
	check("a Clock delta goes out immediately after a skip", ev !== undefined && Math.abs(ev.dayTime - 23.5) < 1e-9);
	check("…and only once: the next tick is not due yet", server.clockEvent(2) === undefined);
	// a nudge inside one stretch of night changes no day, no weather and no wave bit — the change detection
	// alone would not see it, so setClock says so explicitly
	server.setClock(23.7);
	check(
		"a nudge the change detection cannot see still resyncs",
		server.clockEvent(3) !== undefined,
		"23.5 h → 23.7 h",
	);
	// someone joining reads the clock without stealing the resync everyone else is waiting on
	const joinCopy = server.clockEventNow(4);
	check("a joining client gets the clock as it is", Math.abs(joinCopy.dayTime - 23.7) < 1e-9);
	check("…without resetting anyone else's schedule", server.clockEvent(5) === undefined);

	// the client on the other end jumps, because that is what the admin asked to see
	const client = new DayNight(defaultSave());
	const jumped = [];
	client.applyClock({ worldDay: 3, dayTime: 12, rain: false, waveFlags: 0 }, 0);
	client.update(TICK_DT);
	client.onAnnounce = text => jumped.push(text);
	client.applyClock({ worldDay: 3, dayTime: 23.5, rain: false, waveFlags: CLOCK.WAVE_FLAG_1 + CLOCK.WAVE_FLAG_2 }, 0);
	client.update(TICK_DT);
	check("the client jumps to the new hour", Math.abs(client.dayTime - 23.5) < 0.01, `${client.dayTime.toFixed(3)} h`);
	check("…without announcing the hours it flew over", jumped.length === 0, jumped.join(", "));
	check(
		"…and shows the waves the server says are pouring",
		client.wave1Active && client.wave2Active && !client.wave3Active,
	);

	// a small error is eased instead: one frame may not move the clock by more than a fraction of a step
	const eased = new DayNight(defaultSave());
	eased.applyClock({ worldDay: 3, dayTime: 12, rain: false, waveFlags: 0 }, 0);
	eased.update(TICK_DT);
	const atStart = eased.dayTime;
	eased.applyClock({ worldDay: 3, dayTime: 12 + CLOCK_SNAP_H * 0.9, rain: false, waveFlags: 0 }, 0);
	eased.update(TICK_DT);
	const moved = eased.dayTime - atStart;
	check(
		"an error under the threshold is bled off, not jumped",
		moved < CLOCK.clockSpeed(12) * TICK_DT * 1.3,
		`${(moved / (CLOCK.clockSpeed(12) * TICK_DT)).toFixed(2)}× one frame`,
	);
	check("…and it does get corrected", eased.dayTime > atStart, "the clock moved forward");
}

// ================================================================ 5: the MP_PHASE gate

section("5) below MP_PHASE 2 the client keeps its own clock (§11.1)");

{
	setPhase(1);
	const { DayNight: GatedDayNight } = requireFresh("client/systems/daynight.ts");
	const client = new GatedDayNight(defaultSave());
	const before = client.dayTime;
	const taken = client.applyClock({ worldDay: 9, dayTime: 2, rain: true, waveFlags: 7 }, 0);
	client.update(TICK_DT);
	check("applyClock refuses the delta", taken === false);
	check(
		"the hour is still the client's own",
		client.dayTime > before && Math.abs(client.dayTime - before) < 0.01,
		`${client.dayTime.toFixed(4)} h`,
	);
	check("the local clock still runs itself", client.serverDriven() === false);
	setPhase(PROJECT_MP_PHASE);
	check(
		"the project's own MP_PHASE is left where it was",
		mpConfig.MP_PHASE === PROJECT_MP_PHASE,
		`MP_PHASE = ${PROJECT_MP_PHASE}`,
	);
}

/** re-require a module with the current MP_PHASE baked into its module-level reads */
function requireFresh(rel) {
	const file = join(SRC, rel);
	delete require.cache[require.resolve(file)];
	return require(file);
}

// ---------------------------------------------------------------- verdict

console.log("");
if (failures > 0) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("all clock and wave tests passed");
