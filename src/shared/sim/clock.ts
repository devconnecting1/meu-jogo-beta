/*
 * Pure clock maths: time of day, night, waves, darkness, noise hours (docs/MULTIPLAYER.md §4.6, §11.2). No state and
 * no random numbers: DayNight (client, F0) and the server's waves (F2) drive their own state with these rules, and a
 * client replays the server's clock between two Clock messages with them.
 *
 * Original speeds: the night runs 1.2× and the day 0.8× DESIGN.TIME_SPEED, i.e. a 605 s game day
 * (day 6h–19h 387 s + night 19h–6h 218 s).
 */
import { DESIGN } from "shared/engine/constants";

export const HOURS_PER_DAY = 24;
/** darkest overlay alpha at midnight (the renderer punches light holes around survivors and lit lamps/fires) */
export const MAX_DARK = 0.85;
/** the night's wave queues are filled once while the clock is inside (WAVE_FILL_FROM, WAVE_FILL_TO) */
export const WAVE_FILL_FROM = 18;
export const WAVE_FILL_TO = 18.5;

/** hour, text shown when the clock passes it, and whether it is the dawn (non-wave zombies lose the trail) */
export interface ClockAnnouncement {
	hour: number;
	text: string;
	morning: boolean;
}

/** in the order they are announced when one step passes several (a long frame) */
export const CLOCK_ANNOUNCEMENTS: ReadonlyArray<ClockAnnouncement> = [
	{ hour: 19, text: "Wave 1", morning: false },
	{ hour: 22, text: "Wave 2", morning: false },
	{ hour: 1, text: "Wave 3", morning: false },
	{ hour: 7, text: "Good morning", morning: true },
];

/**
 * The hour the night ends (MP-21). It is 06:00 and not the 07:00 of "Good morning": 06:00 is where
 * `isNightAt` turns false and the clock goes back to day speed, so 19:00 → 06:00 is the 11 h at 1.2× the
 * rule prices the night at (~3.6 real minutes). A survivor who has to wait out the night waits for THIS.
 */
export const DAY_BREAK_HOUR = 6;

/** night for the clock speed and the HUD: after 19:00 and before 06:00 */
export function isNightAt(dayTime: number): boolean {
	return dayTime > 19 || dayTime < 6;
}

/** game hours per real second at this time of day */
export function clockSpeed(dayTime: number): number {
	return DESIGN.TIME_SPEED * (isNightAt(dayTime) ? 1.2 : 0.8);
}

/**
 * Speed of the interval that STARTS at `dayTime`, which is what an integration step needs.
 *
 * It only differs from clockSpeed at the single instant 19:00: `isNightAt` calls it day (the night is
 * "after 19:00"), but the stretch ahead of it is night. Integrating that stretch at day speed would make
 * the clock depend on where the ticks happened to fall.
 */
function forwardSpeed(dayTime: number): number {
	return DESIGN.TIME_SPEED * (dayTime >= 19 || dayTime < 6 ? 1.2 : 0.8);
}

/** the next hour at which the speed changes, starting from `dayTime` in [0, 24); 30 = 06:00 of the next day */
function nextSpeedEdge(dayTime: number): number {
	if (dayTime < 6) return 6;
	if (dayTime < 19) return 19;
	return HOURS_PER_DAY + 6;
}

/** a step never needs more splits than this; the guard exists so a nonsense dt cannot spin here */
const MAX_EDGE_SPLITS = 64;

/**
 * The clock after `dt` seconds, NOT wrapped: ≥ HOURS_PER_DAY means a new day started.
 *
 * The step is split at 06:00 and 19:00 instead of being integrated at the speed it started in. That costs
 * one comparison per frame and buys the property the whole of F2 rests on: the hour a step lands on does
 * not depend on the step SIZE. The server ticks at a fixed 1/60 s, a client replays a 10 s gap between two
 * Clock deltas in one go (§4.6), and an admin skips half a night in a single call — all three have to agree,
 * or the survivors would be looking at different clocks again.
 */
export function advanceClock(dayTime: number, dt: number): number {
	if (!(dt > 0)) return dayTime;
	let carried = 0;
	let t = dayTime;
	if (t >= HOURS_PER_DAY || t < 0) {
		const days = math.floor(t / HOURS_PER_DAY);
		carried = days * HOURS_PER_DAY;
		t -= carried;
	}
	let left = dt;
	for (let i = 0; i < MAX_EDGE_SPLITS && left > 0; i++) {
		const speed = forwardSpeed(t);
		const toEdge = (nextSpeedEdge(t) - t) / speed;
		if (left <= toEdge) {
			t += speed * left;
			left = 0;
			break;
		}
		left -= toEdge;
		t = nextSpeedEdge(t);
		if (t >= HOURS_PER_DAY) {
			t -= HOURS_PER_DAY;
			carried += HOURS_PER_DAY;
		}
	}
	// the guard tripped (a dt of many game days): finish in one piece rather than return a stalled clock
	if (left > 0) t += forwardSpeed(t) * left;
	return carried + t;
}

/**
 * REAL seconds until the clock next reads `hour` — the exact inverse of `advanceClock`, and for the same
 * reason: it walks the same 06:00 / 19:00 speed edges, so `advanceClock(t, secondsUntilHour(t, h))` lands on
 * `h` whatever the two hours are. Returns 0 when the clock is already there.
 *
 * It exists because a countdown made of game hours is a lie to the player: 4 game hours before dawn is 79 s
 * at night speed and 119 s in daylight. MP-21 promises a wait that "is short"; the screen has to be able to
 * say how short in the seconds the player is actually going to sit there (client/onboarding/gameOver.ts).
 */
export function secondsUntilHour(dayTime: number, hour: number): number {
	const wrap = (v: number): number => v - math.floor(v / HOURS_PER_DAY) * HOURS_PER_DAY;
	let t = wrap(dayTime);
	const target = wrap(hour);
	let seconds = 0;
	for (let i = 0; i < MAX_EDGE_SPLITS; i++) {
		const edge = nextSpeedEdge(t);
		const speed = forwardSpeed(t);
		// the target on the same unwrapped axis as `edge`: behind us means tomorrow's
		const ahead = target >= t ? target : target + HOURS_PER_DAY;
		if (ahead <= edge) return seconds + (ahead - t) / speed;
		seconds += (edge - t) / speed;
		t = edge >= HOURS_PER_DAY ? edge - HOURS_PER_DAY : edge;
	}
	return seconds;
}

/** real seconds of one whole night, 19:00 → 06:00 at night speed (~3.6 min) — MP-21's price for a death */
export const NIGHT_REAL_SECONDS = secondsUntilHour(19, DAY_BREAK_HOUR);

/**
 * How long a survivor who died at `dayTime` stays down on a shared server before the world puts them back
 * on their feet (MP-21, server/net/mpHost.ts; the client counts the same number down on screen).
 *
 * MP-21 writes the rule for the death it was written about — one at night — and prices it at the night
 * itself: die at 19:00 and you miss all of it. That is the first term. The cap is the answer to the death
 * the rule does not mention: dying at 08:00, the next daybreak is nearly a whole game day away, and ten real
 * minutes of watching is not "a espera é curta" by anyone's reading. So the wait is the rest of the night,
 * and never more than a whole one — the same cost, whenever it is collected.
 */
export function daybreakWaitSeconds(dayTime: number): number {
	return math.min(secondsUntilHour(dayTime, DAY_BREAK_HOUR), NIGHT_REAL_SECONDS);
}

/** `dayTime` folded back into [0, 24), moving whole days onto `day` (a step may cross midnight) */
export function normalizeClock(day: number, dayTime: number): { day: number; dayTime: number } {
	const days = math.floor(dayTime / HOURS_PER_DAY);
	return { day: day + days, dayTime: dayTime - days * HOURS_PER_DAY };
}

/** did the clock pass hour `t` going from `prev` to `cur` (both already wrapped to [0, 24))? */
export function crossed(prev: number, cur: number, t: number): boolean {
	if (cur >= prev) {
		return prev < t && cur >= t;
	}
	return prev < t || cur >= t;
}

/** night wave `wave` (1–3) spawns at this time: wave 1 after 19h, wave 2 after 22h, wave 3 between 1h and 6h */
export function waveActive(wave: number, dayTime: number): boolean {
	if (wave === 1) return dayTime > 19;
	if (wave === 2) return dayTime > 22;
	return dayTime > 1 && dayTime < 6;
}

/** inside the window in which the night's wave queues are filled */
export function inWaveFillWindow(dayTime: number): boolean {
	return dayTime > WAVE_FILL_FROM && dayTime < WAVE_FILL_TO;
}

/*
 * Wave bits of the Clock delta (§4.5 `waveFlags`). The server decides which of the three queues is pouring
 * and the client MIRRORS the answer instead of recomputing it from its own hour: at the moment a wave
 * starts, the client's replayed clock is up to an interpolation delay away from the server's, and "is the
 * wave on" is exactly the question that must not be answered twice.
 */
export const WAVE_FLAG_1 = 1;
export const WAVE_FLAG_2 = 2;
export const WAVE_FLAG_3 = 4;
export const WAVE_FLAG_MASK = 7;

/** the three wave bits for this time of day */
export function waveFlagsAt(dayTime: number): number {
	let flags = 0;
	if (waveActive(1, dayTime)) flags += WAVE_FLAG_1;
	if (waveActive(2, dayTime)) flags += WAVE_FLAG_2;
	if (waveActive(3, dayTime)) flags += WAVE_FLAG_3;
	return flags;
}

/** is wave `wave` (1–3) pouring, according to a received `waveFlags` byte? */
export function waveActiveInFlags(flags: number, wave: number): boolean {
	const bit = wave === 1 ? WAVE_FLAG_1 : wave === 2 ? WAVE_FLAG_2 : WAVE_FLAG_3;
	// no bitwise operators: roblox-ts maps them onto bit32, and a plain remainder reads the same in both
	return math.floor(flags / bit) % 2 === 1;
}

/**
 * Daytime hours in which noise matters (sys_sound_view: 6 < t < 18 and no rain). At night and in the rain every
 * zombie already hunts, so footsteps/shots add nothing.
 */
export function soundMattersAt(dayTime: number, raining: boolean): boolean {
	return dayTime > 6 && dayTime < 18 && !raining;
}

/** original: rain is possible from day 5 on (`if day<=4 weather = 0`); the roll itself belongs to the caller */
export function rainPossible(day: number): boolean {
	return day > 4;
}

/**
 * Night overlay alpha: ramps from 18h and back until 6h, capped at MAX_DARK ("Nocturnal", skill 16, keeps the
 * original 0.05 advantage); rain keeps it at least at 0.5.
 */
export function darkAlphaAt(dayTime: number, raining: boolean, nocturnal: boolean): number {
	let ramp = 0;
	if (dayTime >= 18) {
		ramp = dayTime - 18;
	} else if (dayTime < 6) {
		ramp = 6 - dayTime;
	}
	const cap = nocturnal ? MAX_DARK - (DESIGN.DARK_ALPHA_MAX - DESIGN.DARK_ALPHA_NIGHT_SKILL) : MAX_DARK;
	let dark = math.min(cap, ramp * ((DESIGN.DARK_ALPHA_MAX / 6) * 3));
	if (raining) {
		dark = math.min(cap, math.max(dark, 0.5));
	}
	return dark;
}

/** absolute game clock in hours (day × 24 + time of day): building loot respawn timestamps */
export function gameHours(day: number, dayTime: number): number {
	return day * HOURS_PER_DAY + dayTime;
}
