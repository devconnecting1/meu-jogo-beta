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

// ================================================================ 6: the weather (LUZ-05)

section("6) the weather: the server's, the same on every screen, and what it does to both sides (LUZ-05)");

{
	const W = require(join(SRC, "shared/sim/weather.ts"));
	const P = require(join(SRC, "shared/net/protocol.ts"));
	const S = require(join(SRC, "shared/sim/ai/perception.ts"));
	const { LANG_TABLE } = require(join(SRC, "shared/data/lang.ts"));
	globalThis.typeIs ??= (v, t) =>
		t === "buffer" ? v !== null && typeof v === "object" && v.__buffer === true : typeof v === t;
	const K = W.Weather;

	// ---- a) the hash is exact integer maths: an independent BigInt version agrees on every input (no float rounding)
	{
		const M = 2147483647n;
		const whole = v => BigInt(Math.floor(Math.abs(v))) % M;
		const step = x => (x * 48271n) % M;
		const sq = x => {
			const v = (x * ((x % 65536n) + 1n)) % M;
			return v === 0n ? 1n : v;
		};
		const big = (a, b, c) => {
			let x = whole(a);
			if (x === 0n) x = 1n;
			x = sq(step(x));
			x = (x + whole(b) * 16807n) % M;
			if (x === 0n) x = 1n;
			x = step(sq(step(x)));
			x = (x + whole(c) * 69621n) % M;
			if (x === 0n) x = 1n;
			x = step(sq(step(sq(step(x)))));
			return Number(x - 1n) / (2147483647 - 1);
		};
		let bad = 0;
		for (let i = 0; i < 20000; i++) {
			const a = Math.floor(between(0, 2147483646));
			const b = Math.floor(between(0, 65535));
			const c = Math.floor(between(0, 1000));
			if (W.weatherHash(a, b, c) !== big(a, b, c)) bad += 1;
		}
		check(
			"the weather's hash is exact (20 000 inputs = an independent BigInt version, bit for bit)",
			bad === 0,
			`${bad} differ`,
		);
		// and not linear: two salts of one day, and two days in a row, are unrelated (MINSTD alone is linear mod M)
		const corr = (xs, ys) => {
			const n = xs.length;
			const mx = xs.reduce((a, b) => a + b, 0) / n;
			const my = ys.reduce((a, b) => a + b, 0) / n;
			let sxy = 0;
			let sxx = 0;
			let syy = 0;
			for (let i = 0; i < n; i++) {
				sxy += (xs[i] - mx) * (ys[i] - my);
				sxx += (xs[i] - mx) ** 2;
				syy += (ys[i] - my) ** 2;
			}
			return sxy / Math.sqrt(sxx * syy);
		};
		const salts = [[], []];
		const days = [[], []];
		const lowPair = [];
		for (let d = 1; d <= 20000; d++) {
			salts[0].push(W.weatherHash(7331, d, 101));
			salts[1].push(W.weatherHash(7331, d, 211));
			days[0].push(W.weatherHash(7331, d, 101));
			days[1].push(W.weatherHash(7331, d + 1, 101));
			if (salts[0][d - 1] < 0.1) lowPair.push(salts[1][d - 1]);
		}
		const lowMean = lowPair.reduce((a, b) => a + b, 0) / lowPair.length;
		check(
			"...and not linear: two salts of a day, and two days in a row, are unrelated (|r| < 0.03; a low roll says nothing of the other)",
			Math.abs(corr(salts[0], salts[1])) < 0.03 &&
				Math.abs(corr(days[0], days[1])) < 0.03 &&
				Math.abs(lowMean - 0.5) < 0.05,
			`r ${corr(salts[0], salts[1]).toFixed(4)} / ${corr(days[0], days[1]).toFixed(4)}; after a roll < 0.1 the other averages ${lowMean.toFixed(3)}`,
		);
	}

	// ---- b) the roll: the original's rain rate, storms later, fog never on the first two days
	{
		const seeds = [DESIGN.TOWN_SEED, 1, 42, 99991, 2147483646];
		const count = { rain5: 0, eligible5: 0, storm: 0, rainy8: 0, dawn: 0, eligible3: 0, fog: 0, eligible6: 0 };
		let early = 0;
		let stormEarly = 0;
		let rainEarly = 0;
		let fogEarly = 0;
		let unstable = 0;
		for (const seed of seeds) {
			for (let day = 1; day <= 3000; day++) {
				const k = W.weatherOfDay(seed, day);
				if (W.weatherOfDay(seed, day) !== k) unstable += 1;
				if (day <= 2 && k !== K.Clear) early += 1;
				if (day <= 4 && W.weatherRains(k)) rainEarly += 1;
				if (day < W.STORM_FROM_DAY && k === K.Storm) stormEarly += 1;
				if (day < W.FOG_FROM_DAY && k === K.Fog) fogEarly += 1;
				if (day >= 5) {
					count.eligible5 += 1;
					if (W.weatherRains(k)) count.rain5 += 1;
				}
				if (day >= W.STORM_FROM_DAY && W.weatherRains(k)) {
					count.rainy8 += 1;
					if (k === K.Storm) count.storm += 1;
				}
				if (day >= W.DAWN_FOG_FROM_DAY) {
					count.eligible3 += 1;
					if (k === K.DawnFog) count.dawn += 1;
				}
				if (day >= W.FOG_FROM_DAY) {
					count.eligible6 += 1;
					if (k === K.Fog) count.fog += 1;
				}
			}
		}
		const pct = (n, d) => (100 * n) / d;
		check("a day's weather is a pure function of (seed, day): asked twice, the same answer", unstable === 0);
		check("days 1-2 are always clear (no fog, no rain), days 1-4 never rain", early === 0 && rainEarly === 0);
		check(
			"rain (with storms) on the original's 10 % of the days from day 5",
			Math.abs(pct(count.rain5, count.eligible5) - DESIGN.WEATHER_PERCENT) < 1.2,
			`${pct(count.rain5, count.eligible5).toFixed(1)} %`,
		);
		check(
			`storms only from day ${W.STORM_FROM_DAY}, about one rainy day in three`,
			stormEarly === 0 && Math.abs(count.storm / count.rainy8 - 1 / 3) < 0.06,
			`${((100 * count.storm) / count.rainy8).toFixed(1)} % of the rainy days`,
		);
		check(
			`fog at dawn on ~${W.DAWN_FOG_PERCENT} % of the days from day ${W.DAWN_FOG_FROM_DAY}, all-day fog on ~${W.FOG_PERCENT} % from day ${W.FOG_FROM_DAY}`,
			fogEarly === 0 &&
				Math.abs(pct(count.dawn, count.eligible3) - W.DAWN_FOG_PERCENT) < 2 &&
				Math.abs(pct(count.fog, count.eligible6) - W.FOG_PERCENT) < 1,
			`${pct(count.dawn, count.eligible3).toFixed(1)} % and ${pct(count.fog, count.eligible6).toFixed(1)} %`,
		);
	}

	// ---- c) the server decides, the wire carries one byte, and the client shows exactly what the server lives by
	{
		const clockOf = (weather, rain) => ({
			t: P.WorldEv.Clock,
			worldDay: 12,
			dayTime: 5.5,
			tick: 3,
			rain,
			weather,
			waveFlags: 0,
		});
		const encodeClock = e => P.encodeWorld({ tick: 7, events: [e] }).packets[0];
		const decodeClock = pkt => P.decodeWorld(pkt)?.events[0];
		let wireOk = true;
		for (let k = 0; k <= W.WEATHER_MAX; k++) {
			const pkt = encodeClock(clockOf(k, W.weatherRains(k)));
			const e = decodeClock(pkt);
			if (e === undefined || e.weather !== k || e.rain !== W.weatherRains(k) || buffer.len(pkt) !== 5 + 9) {
				wireOk = false;
			}
		}
		check("every weather crosses the wire in the byte that was the rain boolean: 9 B, like before", wireOk);
		const legacy = decodeClock(encodeClock(clockOf(undefined, true)));
		check(
			"a caller that only says `rain` still writes rain (1) or clear (0)",
			legacy?.weather === K.Rain && legacy.rain === true,
		);
		const pkt = encodeClock(clockOf(K.Fog, false));
		let refused = 0;
		for (let v = W.WEATHER_MAX + 1; v < 256; v++) {
			buffer.writeu8(pkt, 12, v);
			if (decodeClock(pkt) === undefined) refused += 1;
		}
		check(
			"a weather byte above WEATHER_MAX is a malformed delta: all 251 refused",
			refused === 256 - W.WEATHER_MAX - 1,
			`${refused}`,
		);

		for (const [label, kind, day] of [
			["a storm day", K.Storm, 11],
			["a dawn-fog day", K.DawnFog, 6],
			["a fog day", K.Fog, 9],
		]) {
			const server = new WorldClock({ day, dayTime: 0, seed: 5150, rollWeather: () => kind });
			const client = new DayNight(defaultSave());
			client.applyClock(decodeClock(encodeClock(server.clockEvent(0))), 0);
			let worst = 0;
			let fields = "";
			let flashes = 0;
			let masked = 0;
			let fogged = 0;
			const ticks = Math.round(DAY_SECONDS / TICK_DT) - 120;
			for (let i = 0; i < ticks; i++) {
				server.step(TICK_DT);
				client.update(TICK_DT);
				const d = Math.max(
					Math.abs(server.darkAlpha - client.darkAlpha),
					Math.abs(server.fog - client.fog),
					Math.abs(server.flash - client.flash),
					Math.abs(server.thunderMask - client.thunderMask),
				);
				if (d > worst) {
					worst = d;
					fields = `${server.dayTime.toFixed(3)} h: dark ${server.darkAlpha.toFixed(3)}/${client.darkAlpha.toFixed(3)}`;
				}
				if (server.weather !== client.weather || server.isRaining !== client.isRaining) worst = Infinity;
				if (server.flash > 0) flashes += 1;
				if (server.thunderMask < 1) masked += 1;
				if (server.fog > 0.5) fogged += 1;
			}
			check(
				`${label}, a whole day tick by tick: the client's darkness, fog, lightning and thunder = the server's`,
				worst < 1e-9,
				`${worst === 0 ? "identical" : fields}; ${flashes} flash ticks, ${masked} masked, ${fogged} foggy`,
			);
		}
	}

	// ---- d) the fog: continuous, zero at midnight, and it cuts sight for BOTH sides alike
	{
		let jump = 0;
		let midnight = 0;
		for (const kind of [K.Clear, K.Rain, K.Storm, K.DawnFog, K.Fog]) {
			midnight = Math.max(midnight, W.fogDensityAt(kind, 0), W.fogDensityAt(kind, 24 - 1e-9));
			let prev = W.fogDensityAt(kind, 0);
			for (let t = 0; t < 24; t += 1 / 2048) {
				const v = W.fogDensityAt(kind, t);
				jump = Math.max(jump, Math.abs(v - prev));
				prev = v;
			}
		}
		check("the fog never jumps (max step at the wire's 1/2048 h)", jump < 0.01, jump.toFixed(4));
		check("...and is 0 at midnight for every weather: a new day's weather never pops the fog", midnight < 1e-6);
		const dawn = h => W.fogDensityAt(K.DawnFog, h);
		check(
			"fog at dawn: nothing at 03:59, thick at 05:30, full at 06:00, gone at 09:00, none at noon",
			dawn(3.99) === 0 && dawn(5.5) > 0.99 && dawn(6) === 1 && dawn(9) === 0 && dawn(12) === 0,
			[3.99, 4.5, 5.5, 7.5, 8.5, 9].map(h => `${h}h ${dawn(h).toFixed(2)}`).join(", "),
		);
		const allDay = W.fogDensityAt(K.Fog, 13);
		check(
			"a fog day: thick all day (≥ 0.7 at 13:00), full at dawn",
			allDay >= 0.7 && W.fogDensityAt(K.Fog, 6) === 1,
			allDay.toFixed(2),
		);
		// both sides: the horde's eyes and the survivor's screen
		const clear = S.senseRanges({ darkness: 0, night: false, raining: false, fog: 0 });
		const thick = S.senseRanges({ darkness: 0, night: false, raining: false, fog: 1 });
		check(
			"the thickest fog halves the horde's eyes by day (520 → 260 u)",
			Math.abs(thick.sight - S.SIGHT_DAY * (1 - W.FOG_SIGHT_CUT)) < 1e-9 && clear.sight === S.SIGHT_DAY,
			`${clear.sight} → ${thick.sight}`,
		);
		const seeMe = W.fogScreenAt(1, thick.sight);
		const clearDay = W.fogScreenAt(1, S.SIGHT_DAY);
		check(
			"...and the survivor's screen alike: what can see you is clear on it (≤ 5 % fog), what a clear day showed is fogged",
			W.fogScreenAt(1, W.FOG_CLEAR_R) === 0 &&
				seeMe <= 0.05 &&
				clearDay >= 0.45 &&
				Math.abs(W.fogScreenAt(1, W.FOG_FULL_R) - W.FOG_SCREEN_MAX) < 1e-9,
			`${thick.sight} u ${(seeMe * 100).toFixed(1)} %, ${S.SIGHT_DAY} u ${(clearDay * 100).toFixed(0)} %, ` +
				`${W.FOG_FULL_R} u ${(W.FOG_SCREEN_MAX * 100).toFixed(0)} %`,
		);
		check(
			"fog never masks a sound (the thunder does)",
			W.thunderMaskAt(K.Fog, 9, 6) === 1 && W.thunderMaskAt(K.DawnFog, 9, 6) === 1,
		);
	}

	// ---- e) the storm: the schedule, the photosensitivity cap, Reduce Motion, and the thunder's window
	{
		let strikes = 0;
		let days = 0;
		let minGap = Infinity;
		let late = 0;
		let perSecondMax = 0;
		let lift = 0;
		let gentleBumps = 0;
		let gentlePeak = 0;
		let gentleSlope = 0;
		let heard = 0;
		let windowOk = true;
		for (let day = W.STORM_FROM_DAY; day < W.STORM_FROM_DAY + 120; day++) {
			const list = W.strikesOfDay(day);
			days += 1;
			strikes += list.length;
			for (let i = 1; i < list.length; i++) {
				minGap = Math.min(minGap, CLOCK.secondsUntilHour(list[i - 1].hour, list[i].hour));
			}
			for (const s of list) if (s.hour > 23) late += 1;
			// the day at 60 real frames a second: every flicker (a rise of ≥ 0.1) and the gentle shape's swells
			let t = 0;
			let prev = 0;
			let prevG = 0;
			let rising = false;
			// the swell's way (a flat frame of the quantised ramp is neither): a rise after a fall is a second swell
			let gFalling = false;
			const edges = [];
			while (t < 24) {
				const v = W.stormFlashAt(K.Storm, day, t);
				const g = W.stormFlashAt(K.Storm, day, t, true);
				if (v - prev >= 0.1 && !rising) edges.push(t);
				rising = v > prev;
				if (g > prevG && gFalling && prevG > 0) gentleBumps += 1;
				if (g > prevG) gFalling = false;
				else if (g < prevG) gFalling = true;
				gentleSlope = Math.max(gentleSlope, Math.abs(g - prevG));
				gentlePeak = Math.max(gentlePeak, g);
				lift = Math.max(lift, v);
				prev = v;
				prevG = g;
				const next = CLOCK.advanceClock(t, 1 / 60);
				if (W.thunderBetween(K.Storm, day, t, Math.min(next, 24)) > 0) heard += 1;
				t = next;
			}
			for (let i = 0; i < edges.length; i++) {
				let n = 1;
				for (let j = i + 1; j < edges.length && CLOCK.secondsUntilHour(edges[i], edges[j]) < 1; j++) n += 1;
				perSecondMax = Math.max(perSecondMax, n);
			}
			// the thunder: after each strike's delay the horde hears THUNDER_HEARING for THUNDER_MASK_S, all of it before
			for (const s of list) {
				const speed = CLOCK.clockSpeed(s.hour);
				const onset = s.hour + s.delay * speed;
				const before = W.thunderMaskAt(K.Storm, day, onset - 0.2 * speed);
				const after = W.thunderMaskAt(K.Storm, day, onset + 0.5 * speed);
				const gone = W.thunderMaskAt(K.Storm, day, onset + (W.THUNDER_MASK_S + 0.2) * speed);
				if (before !== 1 || after !== W.THUNDER_HEARING || gone !== 1) windowOk = false;
			}
		}
		check(
			`a storm day has ~${Math.round(W.STRIKE_CHANCE * W.STRIKE_SLOTS)} strikes, none after 23:00 (nothing crosses midnight)`,
			Math.abs(strikes / days - W.STRIKE_CHANCE * W.STRIKE_SLOTS) < 2.5 && late === 0,
			`${(strikes / days).toFixed(1)} a day over ${days} days`,
		);
		check(
			"two strikes are never closer than 10 real seconds",
			minGap >= 10,
			`${minGap.toFixed(1)} s at the closest`,
		);
		check(
			"photosensitivity: at most 2 flickers in any second (WCAG 2.3.1 allows 3), and the flash never lifts more than FLASH_LIFT",
			perSecondMax <= 2 && lift <= 1 && lift > 0.9,
			`${perSecondMax} a second at most; peak ${lift} × ${W.FLASH_LIFT}`,
		);
		check(
			"Reduce Motion: one slow swell per strike, never a flicker, ≤ 0.04 a frame -- and it lifts the dark as far as the " +
				"real flash (the reveal is everybody's, L4 of the review)",
			gentleBumps === 0 &&
				gentlePeak <= W.FLASH_GENTLE_PEAK + 1e-9 &&
				gentlePeak >= lift - 0.02 &&
				gentleSlope <= 0.04,
			`peak ${gentlePeak.toFixed(3)} (the real flash ${lift}), steepest ${gentleSlope.toFixed(4)} a frame`,
		);
		check(
			"the thunder: 100 % before the clap, THUNDER_HEARING for THUNDER_MASK_S after it, 100 % again",
			windowOk,
			`${W.THUNDER_HEARING * 100} % for ${W.THUNDER_MASK_S} s`,
		);
		check(
			"every strike's clap is heard exactly once by a client stepping 60 frames a second",
			heard === strikes,
			`${heard} claps, ${strikes} strikes`,
		);
		const dark = W.weatherDark(K.Storm, 12, false, 0);
		check(
			"a storm's day is darker than a rain's, and still lit for the horde (ambient ≥ 0.4)",
			dark === W.STORM_DARK && W.weatherDark(K.Rain, 12, false, 0) === 0.5 && 1 - dark >= 0.4,
			`storm ${dark}, rain ${W.weatherDark(K.Rain, 12, false, 0)}`,
		);
		check(
			"no storm, no lightning and no thunder",
			W.stormFlashAt(K.Rain, 11, 12) === 0 && W.thunderMaskAt(K.Rain, 11, 12) === 1,
		);
	}

	// ---- f) the feed and the admin
	{
		const server = newClock({ day: 9, dayTime: 12 });
		server.clockEvent(0);
		server.setWeather(K.Fog);
		const e1 = server.clockEvent(1);
		server.setRain(true);
		const e2 = server.clockEvent(2);
		server.setWeather(9);
		const e3 = server.clockEvent(3);
		check(
			"the admin's weather goes out at once; setRain is rain; an unknown weather changes nothing",
			e1?.weather === K.Fog &&
				e2?.weather === K.Rain &&
				e2.rain === true &&
				e3 === undefined &&
				server.weather === K.Rain,
		);
		const client = new DayNight(defaultSave());
		const said = [];
		client.onAnnounce = text => said.push(text);
		const at = (worldDay, dayTime, weather) => ({
			worldDay,
			dayTime,
			rain: W.weatherRains(weather),
			weather,
			waveFlags: 0,
		});
		client.applyClock(at(9, 12, K.Rain), 0);
		const first = said.length;
		client.applyClock(at(9, 12, K.Storm), 0);
		client.applyClock(at(10, 0.1, K.Clear), 0);
		client.applyClock(at(10, 0.2, K.DawnFog), 0);
		check(
			"the first delta is not news; a weather change lived on screen is said in the feed, a clear sky is not",
			first === 0 &&
				said.length === 2 &&
				said[0] === W.weatherAnnouncement(K.Storm) &&
				said[1] === W.weatherAnnouncement(K.DawnFog),
			said.join(" | "),
		);
		const texts = [K.Rain, K.Storm, K.DawnFog, K.Fog].map(k => W.weatherAnnouncement(k));
		check(
			"every weather's text is in lang.ts (Roblox translates it)",
			texts.every(t => LANG_TABLE.includes(t)),
			texts.join(" | "),
		);
		const offline = new DayNight(defaultSave(), 5150);
		check(
			"offline, the client rolls the very hash the server rolls, from the town's seed",
			offline.weather === W.weatherOfDay(5150, offline.day),
		);
	}

	// ---- g) the review of the weather (M1, M2, L1, L2, L4): the reveal, the admin's sky, the flicker guard, the ease
	{
		const at = (worldDay, dayTime, weather) => ({
			worldDay,
			dayTime,
			rain: W.weatherRains(weather),
			weather,
			waveFlags: 0,
		});
		// a storm day with two night strikes in a row (the dark, where a strike reveals)
		let day = W.STORM_FROM_DAY;
		let A;
		let B;
		for (; day < W.STORM_FROM_DAY + 60; day++) {
			const night = W.strikesOfDay(day).filter(s => s.hour > 21 || s.hour < 4);
			const i = night.findIndex((s, k) => k + 2 < night.length && s.power > 0.8);
			if (i >= 0) {
				A = night[i];
				B = night[i + 1];
				break;
			}
		}
		const speed = CLOCK.clockSpeed(A.hour);
		const flashAt = h => W.stormFlashAt(K.Storm, day, h);

		// M1: the flash on screen is the one at the RENDER time, where the horde is drawn
		const lag = 0.15;
		const client = new DayNight(defaultSave());
		client.applyClock(at(day, A.hour - 0.5 * speed, K.Storm), 0);
		client.renderLagS = lag;
		let drawnOnset;
		let clockOnset;
		let mismatch = 0;
		let reveals = 0;
		let revealWrong = 0;
		for (let i = 0; i < 180; i++) {
			client.update(TICK_DT);
			const t = client.dayTime;
			const render = t - lag * CLOCK.clockSpeed(t);
			if (clockOnset === undefined && flashAt(t) > 0) clockOnset = i;
			if (drawnOnset === undefined && client.flash > 0) drawnOnset = i;
			if (Math.abs(client.flash - flashAt(render)) > 1e-12) mismatch += 1;
			const want = W.flashReveals(K.Storm, render, flashAt(render));
			if (client.reveal) reveals += 1;
			if (client.reveal !== want) revealWrong += 1;
		}
		check(
			"M1: the screen's flash is the strike at the render time (the clock minus the horde's delay): the bodies it " +
				"lights are drawn at that very moment",
			mismatch === 0 && Math.abs(drawnOnset - clockOnset - Math.round(lag / TICK_DT)) <= 1,
			`${mismatch} frames off; onset ${((drawnOnset - clockOnset) * TICK_DT).toFixed(3)} s after the clock's`,
		);
		check(
			"...and the reveal (every body drawn at full alpha) is exactly the frames that flash lights the dark town",
			reveals > 0 && revealWrong === 0,
			`${reveals} frames of reveal, ${revealWrong} wrong`,
		);

		// L1 (and the final review's MEDIUM): each strike is played once, never backwards, and a screen shows at most
		// FLICKERS_PER_S rising edges of its lightning in any second -- whatever the clock or the render lag does
		client.applyClock(at(day, A.hour - 0.2 * speed, K.Storm), 0);
		const snapped = Math.abs(client.dayTime - (A.hour - 0.2 * speed)) < 1e-9;
		let replay = 0;
		for (let i = 0; i < 90; i++) {
			client.update(TICK_DT);
			if (client.flash > 0 || client.gentleFlash > 0) replay += 1;
		}
		check(
			"L1: a clock that snaps back into a strike this screen played replays nothing (a strike is played once, day and slot)",
			snapped && replay === 0,
			`${replay} frames of flash on the replay`,
		);
		/** the rising edges of a series (a rise after a frame that did not rise), and the most of them in any second */
		const flickers = series => {
			const ups = [];
			for (let i = 1; i < series.length; i++) {
				const up = series[i] > series[i - 1];
				const was = i > 1 && series[i - 1] > series[i - 2];
				if (up && !was) ups.push(i * TICK_DT);
			}
			let worst = 0;
			for (let i = 0; i < ups.length; i++) {
				let n = 0;
				for (let k = i; k < ups.length && ups[k] - ups[i] < 1; k++) n += 1;
				worst = Math.max(worst, n);
			}
			return { ups: ups.length, worst };
		};
		/** a screen 0.1 s behind the clock through strike A, `event` moving its clock or its lag on the way */
		const scene = event => {
			const c = new DayNight(defaultSave());
			c.applyClock(at(day, A.hour - 0.2 * speed, K.Storm), 0);
			c.renderLagS = 0.1;
			const sharp = [];
			const swell = [];
			let onset = -1;
			for (let i = 0; i < 240; i++) {
				if (onset < 0 && c.flash > 0) onset = i;
				if (onset >= 0) event(c, i - onset);
				c.update(TICK_DT);
				sharp.push(c.flash);
				swell.push(c.gentleFlash);
			}
			return { sharp: flickers(sharp), swell: flickers(swell) };
		};
		const plain = scene(() => {});
		// the admin skips to just before the next strike 0.5 s after A started (the review's probe: 4 flickers in 0.7 s)
		const toB = scene((c, k) => {
			if (k === 30) c.applyClock(at(day, B.hour - 0.06 * CLOCK.clockSpeed(B.hour), K.Storm), 0);
		});
		// a resync snaps the clock back 1.05 s while A's swell is still up; a snapshot buffer relocks 0.1 -> 0.4 s into A
		const back = scene((c, k) => {
			if (k === 63) c.applyClock(at(day, c.dayTime - 1.05 * speed, K.Storm), 0);
		});
		const relock = scene((c, k) => {
			if (k === 18) c.renderLagS = 0.4;
		});
		const worst = r => Math.max(r.sharp.worst, r.swell.worst);
		check(
			`photosensitivity: at most ${W.FLICKERS_PER_S} flickers in any second on a screen whatever the clock does -- a ` +
				"skip into the next strike 0.5 s after one (its rises wait), a resync back into a strike, a render lag that relocks",
			worst(plain) === 2 && worst(toB) <= W.FLICKERS_PER_S && worst(back) <= 2 && worst(relock) <= 2,
			`one strike ${plain.sharp.ups} rising edges (${plain.swell.ups} of the swell); the skip ${worst(toB)} in a second, ` +
				`the resync ${worst(back)}, the relock ${worst(relock)}`,
		);
		check(
			"...and never an earlier point of a strike: the resync and the relock replay no flicker (the same edges as the strike alone)",
			back.sharp.ups === plain.sharp.ups &&
				back.swell.ups === plain.swell.ups &&
				relock.sharp.ups === plain.sharp.ups &&
				relock.swell.ups === plain.swell.ups,
			`resync ${back.sharp.ups}/${back.swell.ups}, relock ${relock.sharp.ups}/${relock.swell.ups} edges`,
		);

		// L1: a new weather eases in on the screen (darkness, fog) over WEATHER_EASE_S; the horde's numbers are instant
		const ease = new DayNight(defaultSave());
		ease.applyClock(at(12, 12, K.Clear), 0);
		ease.update(TICK_DT);
		ease.applyClock(at(12, ease.dayTime, K.Fog), 0);
		const fog0 = ease.fogShown;
		const instant = ease.fog;
		for (let i = 0; i < Math.round(W.WEATHER_EASE_S / 2 / TICK_DT); i++) ease.update(TICK_DT);
		const half = ease.fogShown / ease.fog;
		for (let i = 0; i < Math.round((W.WEATHER_EASE_S / 2 + 0.1) / TICK_DT); i++) ease.update(TICK_DT);
		const done = ease.fogShown === ease.fog;
		ease.applyClock(at(12, ease.dayTime, K.Rain), 0);
		const dark0 = ease.darkBase;
		const darkNow = ease.darkAlpha;
		check(
			`L1: fog over a clear noon eases in on the screen over ${W.WEATHER_EASE_S} s (the horde's fog is at once)`,
			fog0 < 0.02 && instant > 0.69 && half > 0.3 && half < 0.7 && done,
			`shown ${fog0.toFixed(3)} -> ${(half * 100).toFixed(0)} % at half time -> ${done ? "all" : "not all"}; horde ${instant.toFixed(2)}`,
		);
		check(
			"...and the rain's darkness too: the screen starts from the old sky, the horde's darkness is the new one at once",
			dark0 < 0.05 && Math.abs(darkNow - 0.5) < 1e-9,
			`screen ${dark0.toFixed(3)}, horde ${darkNow}`,
		);
		const first2 = new DayNight(defaultSave());
		first2.applyClock(at(12, 12, K.Fog), 0);
		check("...but a session's first delta is not lived: it shows the fog at once", first2.fogShown === first2.fog);
		// a change in the middle of another eases on from what is on screen, never from the old sky's full value
		const twice = new DayNight(defaultSave());
		twice.applyClock(at(12, 12, K.Clear), 0);
		twice.update(TICK_DT);
		twice.applyClock(at(12, twice.dayTime, K.Fog), 0);
		for (let i = 0; i < Math.round(W.WEATHER_EASE_S / 2 / TICK_DT); i++) twice.update(TICK_DT);
		const mid = twice.fogShown;
		twice.applyClock(at(12, twice.dayTime, K.Clear), 0);
		const after = twice.fogShown;
		let steepest = 0;
		let prevShown = after;
		for (let i = 0; i < Math.round((W.WEATHER_EASE_S + 0.1) / TICK_DT); i++) {
			twice.update(TICK_DT);
			steepest = Math.max(steepest, Math.abs(twice.fogShown - prevShown));
			prevShown = twice.fogShown;
		}
		check(
			"NIT: a new sky in the middle of an ease eases on from what the screen shows (no jump), and gets there",
			mid > 0.2 && Math.abs(after - mid) < 1e-9 && steepest < 0.02 && twice.fogShown === 0,
			`fog on screen ${mid.toFixed(3)} when the sky cleared, ${after.toFixed(3)} the frame after, steepest ${steepest.toFixed(4)} a frame`,
		);

		// M1 (server): a night strike lights the town on the wire from its flash until FLASH_REVEAL_HOLD_S after it
		const srv = new WorldClock({ day, dayTime: A.hour - 0.5 * speed, rollWeather: () => K.Storm });
		let litFrom;
		let flashEnd;
		let revealEnd;
		for (let i = 0; i < 150; i++) {
			srv.step(TICK_DT);
			const tick = (i + 1) * TICK_DT;
			if (litFrom === undefined && srv.revealing()) litFrom = tick;
			if (litFrom !== undefined && flashEnd === undefined && srv.flash === 0) flashEnd = tick;
			if (litFrom !== undefined && revealEnd === undefined && !srv.revealing()) revealEnd = tick;
		}
		const strikeT = 0.5;
		check(
			"M1: on the server a night strike reveals the town at its flash and keeps it revealed FLASH_REVEAL_HOLD_S after " +
				"the flash (the screens draw it up to INTERP_MAX_S later, and fade a body DESPAWN_FADE_S)",
			litFrom !== undefined &&
				Math.abs(litFrom - strikeT) <= 2 * TICK_DT &&
				Math.abs(revealEnd - flashEnd - W.FLASH_REVEAL_HOLD_S) <= 2 * TICK_DT,
			`from ${(litFrom - strikeT).toFixed(3)} s after the strike, the flash over at ${(flashEnd - strikeT).toFixed(2)} s, ` +
				`revealed until ${(revealEnd - strikeT).toFixed(2)} s`,
		);
		const noon = W.strikesOfDay(day).find(s => s.hour > 10 && s.hour < 15);
		const daySrv = new WorldClock({
			day,
			dayTime: noon.hour - 0.2 * CLOCK.clockSpeed(noon.hour),
			rollWeather: () => K.Storm,
		});
		let dayReveal = 0;
		let dayFlash = 0;
		for (let i = 0; i < 90; i++) {
			daySrv.step(TICK_DT);
			if (daySrv.revealing()) dayReveal += 1;
			if (daySrv.flash > 0) dayFlash += 1;
		}
		check(
			"...by day there is nothing to reveal (a storm's day is lit for the horde already)",
			dayFlash > 0 && dayReveal === 0,
		);

		// L2: a clock set into another day brings that day's own weather, and pays nobody
		let d = 9;
		while (d < 400 && !(W.weatherRains(W.weatherOfDay(4242, d + 1)) && !W.weatherRains(W.weatherOfDay(4242, d))))
			d++;
		const moved = new WorldClock({ day: d, dayTime: 23, seed: 4242 });
		let paid = 0;
		moved.onNewDay = () => (paid += 1);
		const before = moved.weather;
		moved.setClock(6.99, d + 1);
		moved.setWeather(K.Fog);
		moved.setClock(12);
		check(
			"L2: a clock set across midnight rolls the new day's weather (and pays nobody); a set inside the day keeps the admin's",
			before === W.weatherOfDay(4242, d) &&
				moved.dayRoll === W.weatherOfDay(4242, d + 1) &&
				W.weatherRains(moved.dayRoll) &&
				moved.weather === K.Fog &&
				paid === 0,
			`day ${d} ${W.weatherName(before)} -> day ${d + 1} ${W.weatherName(moved.dayRoll)}, then the admin's ${W.weatherName(moved.weather)}`,
		);

		// M2: the admin's weather assists every run when it eases the night against the day's roll
		const assists = (r, c) => W.weatherAssists(r, c);
		check(
			"M2: fog, dawn fog, rain or a storm over a clear roll assist; a clear sky over a rainy roll does not; a storm over rain does",
			assists(K.Clear, K.Rain) &&
				assists(K.Clear, K.Storm) &&
				assists(K.Clear, K.Fog) &&
				assists(K.Clear, K.DawnFog) &&
				!assists(K.Rain, K.Clear) &&
				!assists(K.Rain, K.Fog) &&
				assists(K.Rain, K.Storm) &&
				!assists(K.Storm, K.Rain) &&
				!assists(K.Fog, K.Fog),
		);
	}
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
