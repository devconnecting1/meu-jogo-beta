/*
 * Titles: a word in brackets under a survivor's name, for everyone to read (docs/DESIGN_RULES.md MON-05).
 *
 * A title is EARNED by playing and never sold (MON-01: it is identity, and the only way to have one is to have done
 * the thing). The SERVER decides every unlock from its own counters (MP-00) and writes it into the save:
 *
 *   Survivor       the first night one of your lives lives through: credited at midnight by the MP-13 day count
 *                  (alive, in the world for half the day, not AFK) and still standing at 06:00, having been alive
 *                  in the world every tick since that midnight (server/sim/simulation.ts `creditDawn`)
 *   Horde Breaker  HORDE_BREAKER_KILLS zombies put down: the killing blows the server's kill credit gave you
 *                  (server/sim/progress.ts `zombieKilled`). An assist is XP (MP-15), not a kill: it does not count
 *   Week One       one life living WEEK_ONE_NIGHTS midnights the SERVER credited to it (`lifeNights`) by the same
 *                  MP-13 count, presence and AFK rule included, so idling in the street never gets there -- and a
 *                  day a client reported before the server counted days, or an admin set, is not one of them
 *
 * Nothing here needs a boss or anything outside Núcleo 1 (CON-03). A new title is a new row at the END of the table:
 * the save keeps one flag per id (`titles[id]`) and the wire carries `id + 1`, so reordering would hand everybody's
 * titles to the wrong names. The colour is a TONE, not a Color3: shared code never reads the client's theme, and
 * client/ui/titleStyle.ts resolves each tone to a game token held to 4,5:1 by `npm run test:contrast`.
 */

/** the ids of the titles, as the save and the server know them */
export const TitleId = {
	Survivor: 0,
	HordeBreaker: 1,
	WeekOne: 2,
} as const;
export type TitleId = (typeof TitleId)[keyof typeof TitleId];

/** Horde Breaker: zombies put down (killing blows the server credited, lifetime) */
export const HORDE_BREAKER_KILLS = 100;
/** Week One: the midnights one life has to live, as the server credits them (`lifeNights`) */
export const WEEK_ONE_NIGHTS = 7;
/** ...which takes a life that started at day 1 to day 8 */
export const WEEK_ONE_DAY = WEEK_ONE_NIGHTS + 1;

/**
 * Which game colour a title is drawn in (client/ui/titleStyle.ts): `bonus` the item card's green, `effect` its
 * orange, `value` its yellow (theme.ts STAT, the stat-* tokens).
 */
export type TitleTone = "bonus" | "effect" | "value";

export interface TitleDef {
	/** index into `save.titles`; the wire carries `id + 1` (0 = no title) */
	id: number;
	/** the title itself, drawn in brackets: "[Survivor]" (a lang key) */
	name: string;
	/** one line: how it is earned (a lang key) */
	howTo: string;
	/** what a locked title's progress counts (a lang key): "Zombies put down: 37 / 100" */
	progressLabel: string;
	/** the number that progress reaches */
	goal: number;
	tone: TitleTone;
}

export const TITLES: Array<TitleDef> = [
	{
		id: TitleId.Survivor,
		name: "Survivor",
		howTo: "Survive your first night.",
		progressLabel: "Nights survived",
		goal: 1,
		tone: "bonus",
	},
	{
		id: TitleId.HordeBreaker,
		name: "Horde Breaker",
		howTo: "Put down 100 zombies.",
		progressLabel: "Zombies put down",
		goal: HORDE_BREAKER_KILLS,
		tone: "effect",
	},
	{
		id: TitleId.WeekOne,
		name: "Week One",
		howTo: "Stay alive for 7 days in one life.",
		progressLabel: "Days survived in this life",
		goal: WEEK_ONE_NIGHTS,
		tone: "value",
	},
];

/** the largest title byte on the wire (PlayerJoined / PlayerProfile / Announce): 0 = none, else id + 1 */
export const TITLE_WIRE_MAX = TITLES.size();

/** the wire byte of a title id (-1 = none) */
export function titleToWire(id: number): number {
	return id >= 0 && id < TITLES.size() ? id + 1 : 0;
}

/** the title id a wire byte names, or -1 for none (and for anything out of range) */
export function titleFromWire(wire: number): number {
	return wire >= 1 && wire <= TITLE_WIRE_MAX && wire % 1 === 0 ? wire - 1 : -1;
}
