/*
 * The numbers of the wellbeing rules (docs/DESIGN_RULES.md BEM-04 / BEM-07; research docs/research/MOTIVATION_AND_ETHICS.md
 * §4.7 and §6), shared by the client that shows the dawn card and the server that decides the break line and measures
 * it (docs/ANALYTICS.md §15). Pure data.
 *
 * The break line is ONE decision, the server's (the review of ca9494a, L7): at 06:00 server/main.server.ts asks
 * `breakNudgeEarned`, tells that survivor (`Announce{BreakNudge}`, shared/net/protocol.ts note 23) and logs the analytics
 * `BreakNudge` in the same step; the client shows the line because it was told, never from a clock of its own -- so a
 * line shown and an event counted can never disagree.
 */
import { DAY_BREAK_HOUR, NIGHT_REAL_SECONDS } from "shared/sim/clock";

/**
 * A session this long (minutes since the player joined the server) is a long one: the dawn after a night lived standing
 * brings one gentle line about a break, once per session. Never a reward to stay, never a count to the next night, never
 * a lock: the card goes by itself.
 */
export const BREAK_NUDGE_MIN = 90;

/**
 * The break line counts as heeded when the player leaves the server within this many seconds of it (the analytics
 * event `BreakNudge`, field `Left - Yes/No`; a server closing in that time is `Left - Unknown`).
 */
export const BREAK_NUDGE_LEFT_S = 120;

/**
 * Does this survivor get the break line at this dawn? `sessionSeconds`: real seconds since they joined the server;
 * `livedNight`: alive in the world every tick since midnight (server/sim/simulation.ts `creditDawn`, the presence the
 * Survivor title counts with -- ~55% of the night); `already`: this session had its line.
 */
export function breakNudgeEarned(sessionSeconds: number, livedNight: boolean, already: boolean): boolean {
	return !already && livedNight && sessionSeconds >= BREAK_NUDGE_MIN * 60;
}

/**
 * A night is a night to report (the dawn card) when the survivor stood in the city, alive, for at least this share of
 * its real length before daybreak: somebody who walked in at 05:50 lived no night. Looser than the break line's "since
 * midnight", so a survivor who is given the line has, in all but a hiccup, a card to read it on (and if not, it goes to
 * the message feed: client/main.client.ts).
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
