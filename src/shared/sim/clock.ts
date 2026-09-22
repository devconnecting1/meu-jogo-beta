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

/** night for the clock speed and the HUD: after 19:00 and before 06:00 */
export function isNightAt(dayTime: number): boolean {
	return dayTime > 19 || dayTime < 6;
}

/** game hours per real second at this time of day */
export function clockSpeed(dayTime: number): number {
	return DESIGN.TIME_SPEED * (isNightAt(dayTime) ? 1.2 : 0.8);
}

/** the clock after `dt` seconds, NOT wrapped: ≥ HOURS_PER_DAY means a new day started */
export function advanceClock(dayTime: number, dt: number): number {
	return dayTime + clockSpeed(dayTime) * dt;
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
