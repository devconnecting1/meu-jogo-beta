/*
 * The numbers of the wellbeing rules (docs/DESIGN_RULES.md BEM-04 / BEM-07; research docs/research/MOTIVATION_AND_ETHICS.md
 * §4.7 and §6), shared by the client that shows the dawn card and the server that measures it (docs/ANALYTICS.md §15),
 * so the line a player reads and the event the dashboard counts follow ONE rule. Pure data.
 */
import { DAY_BREAK_HOUR, NIGHT_REAL_SECONDS } from "shared/sim/clock";

/**
 * A session this long (minutes since the player joined the server) is a long one: the dawn card of the next night
 * survived adds one gentle line about a break, once per session. Never a reward to stay, never a count to the next
 * night, never a lock: the card goes by itself.
 */
export const BREAK_NUDGE_MIN = 90;

/**
 * The break line counts as heeded when the player leaves the server within this many seconds of it (the analytics
 * event `BreakNudge`, field `Left - Yes/No`).
 */
export const BREAK_NUDGE_LEFT_S = 120;

/**
 * A night is a night to report (the dawn card) when the survivor stood in the city, alive, for at least this share of
 * its real length before daybreak: somebody who walked in at 05:50 lived no night. The server's `BreakNudge` reads the
 * same rule off its own clock.
 */
export const MIN_NIGHT_SHARE = 0.5;

/** the real seconds a survivor must have been standing at daybreak for the night to count (MIN_NIGHT_SHARE of it) */
export const NIGHT_LIVED_S = NIGHT_REAL_SECONDS * MIN_NIGHT_SHARE;

/**
 * The dawn window of the world clock (hours): from daybreak (06:00, shared/sim/clock.ts DAY_BREAK_HOUR) to 07:30. A
 * session that ends in it ends at the healthy stopping point the dawn card offers (`SessionEnded` `Time - Dawn`).
 */
export const DAWN_END_HOUR = 7.5;

/** is `dayTime` (hours) inside the dawn window? */
export function isDawnAt(dayTime: number): boolean {
	return dayTime >= DAY_BREAK_HOUR && dayTime < DAWN_END_HOUR;
}
