/*
 * WHEN a player's save is written (docs/DESIGN_RULES.md SAV-01, docs/MULTIPLAYER.md §6.8). The owner, 2026-09-24: "Não
 * faz ter a opção do usuário salvar manualmente, pois o Save tem que ser automático e que faça sentido." There is no
 * Save button and no remote that asks for a write: the SERVER decides every write, from its own events.
 *
 *   1. the autosave: every AUTOSAVE_INTERVAL s, for a session that changed (server/main.server.ts, the autosave loop);
 *   2. an EVENT save, soon after a moment that matters -- a purchase, a level, a skill learned, a day survived, a title,
 *      a death, a Rebirth / a daybreak stand-up, a new life, a rare craft, and a night lived through to daybreak
 *      (`SaveEvent`; "dawn": the dawn card says "Progress saved" only once a write landed, DESIGN_RULES BEM-04). Most of
 *      them are found by comparing a few numbers of the live save once a second (`milestonesOf`), so no simulation file
 *      has to know about the DataStore; a purchase, a Rebirth, a New game, the midnight's day, a skill, a craft and the
 *      dawn are named where they happen (server/main.server.ts `saveSoon`);
 *   3. the leave and BindToClose, as before (the final write, which releases the session lock).
 *
 * What keeps it cheap and safe, all of it enforced here and tested by tools/test-save.mjs (section 32) and, through the
 * real server, tools/test-body.mjs (section 32):
 *   - coalescing: an event save waits EVENT_SAVE_DELAY s (a burst -- a death, the body banked, a title -- is one write)
 *     and never starts less than EVENT_SAVE_GAP s after the player's last write ATTEMPT, whatever asked for it: at most
 *     one write per player per EVENT_SAVE_GAP s outside the leave and the shutdown. The autosave obeys the same gap;
 *   - the budget: an event save only runs while the server's UpdateAsync budget is at least EVENT_SAVE_MIN_BUDGET (twice
 *     the autosave's floor, which keeps room for joins and leaves); below it, it waits, and the autosave still comes;
 *   - nothing new, nothing written: the JSON of the last save that landed is kept, and an identical one is not sent
 *     again (only the lock refresh writes an unchanged save);
 *   - failures back off: a write that is not the last one makes ONE UpdateAsync attempt (main.server.ts `flush`), and
 *     when it fails -- or the save cannot even be encoded -- the next attempt waits 15 s, then 30 s, then 60 s
 *     (`gapOf`), until one lands. An outage costs about one UpdateAsync a minute per player; the final write (the leave,
 *     BindToClose) keeps its retries in place, because it gets no other try;
 *   - the client never asks: a progress report (SaveRequest) marks the session dirty and nothing else -- it is carried
 *     by the next autosave -- so no client can make the server write when it chooses (anti-spam; no save-scumming).
 *
 * Worst case, a crash that skips BindToClose loses what changed since the last write that landed: at most
 * EVENT_SAVE_GAP + EVENT_SCAN_S s (+ the write's own latency) after an event of the list, at most AUTOSAVE_INTERVAL +
 * EVENT_SCAN_S s after anything else. A DataStore outage is the exception: nothing lands, and the client says so
 * ("Progress not saved — retrying", client/ui/saveIndicator.ts) until a write does -- or until the save is found to be
 * exactly what the DataStore already holds.
 *
 * Accepted as it is (review L5): the load's UpdateAsync counts as the session's first write, so the first event save of
 * a session waits until EVENT_SAVE_GAP s after the join -- a brand-new player's first document can land ~16 s in (or
 * with the leave, whichever comes first); and an event save still pending when the player leaves is not run after it:
 * the leave's final write carries it.
 *
 * Pure module: no services, no clock of its own (the caller passes os.clock()).
 */
import { ItemKind } from "shared/data/kinds";
import type { PlayerSaveData } from "shared/game/save";
import { BackpackOutcome, recipeById } from "../sim/craft";

/** s between two rounds of the autosave (a session is only written when it changed, or its lock needs refreshing) */
export const AUTOSAVE_INTERVAL = 60;
/** s an event save waits before it runs: the rest of a burst rides with it */
export const EVENT_SAVE_DELAY = 3;
/** s between the START of two write attempts of one player (event saves and the autosave; not the leave, not shutdown) */
export const EVENT_SAVE_GAP = 15;
/** UpdateAsync budget an event save needs left before it runs: twice the autosave's floor (main.server.ts) */
export const EVENT_SAVE_MIN_BUDGET = 8;
/** s between two looks at the live saves for events (main.server.ts, on Heartbeat) */
export const EVENT_SCAN_S = 1;

/**
 * Why a write was asked for early. "retry": the last write failed (the DataStore is down) -- tried again a gap later;
 * "auto": the autosave came inside the gap, so it is served when the gap ends.
 */
export type SaveEvent =
	| "purchase"
	| "level"
	| "skill"
	| "day"
	| "title"
	| "death"
	| "revive"
	| "life"
	| "craft"
	| "dawn"
	| "retry"
	| "auto";

/** the numbers of a save whose change is an event of the list (compared once a second: see `milestoneEvent`) */
export interface Milestones {
	level: number;
	/** skill levels learned, summed */
	skills: number;
	/** this life's day and the record */
	day: number;
	bestDay: number;
	runOver: boolean;
	/** a Rebirth, a New game, a world's end, an admin edit */
	runRev: number;
	lifeDeaths: number;
	/** the titles earned, one digit each */
	titles: string;
}

/** a session's write bookkeeping (server/main.server.ts `Session.cadence`) */
export interface Cadence {
	/** os.clock() the pending early write is due at (undefined = none pending) */
	due: number | undefined;
	/** what asked for it first */
	reason: SaveEvent | undefined;
	/** os.clock() the last write attempt started -- the load counts: its UpdateAsync took the lock */
	lastAttempt: number;
	/**
	 * Write attempts that failed in a row (the DataStore is down, the save cannot be encoded): the next attempt waits
	 * longer each time (`gapOf`). Back to 0 when a write lands.
	 */
	failures: number;
	/** "failing" is what the player was last told (client/ui/saveIndicator.ts): the next landing -- or a save found
	 * identical to what the DataStore holds -- takes it back with "saved" */
	failingShown: boolean;
	/** the JSON of the last save that landed (undefined = none yet this session): an identical save is not rewritten */
	lastJson: string | undefined;
	/** the milestones as the last look saw them (undefined = not looked at yet: the first look only takes note) */
	marks: Milestones | undefined;
}

/** a session that just loaded at `now` */
export function newCadence(now: number): Cadence {
	return {
		due: undefined,
		reason: undefined,
		lastAttempt: now,
		failures: 0,
		failingShown: false,
		lastJson: undefined,
		marks: undefined,
	};
}

/**
 * The least time between the starts of two write attempts of one player: EVENT_SAVE_GAP, and while the writes fail
 * it backs off -- 15 s after the first failure, 30 s after the second, then AUTOSAVE_INTERVAL (60 s) -- so an outage
 * costs about one UpdateAsync a minute per player (the autosave alone, with its retries, used to cost four).
 */
export function gapOf(c: Cadence): number {
	if (c.failures <= 1) return EVENT_SAVE_GAP;
	return math.min(EVENT_SAVE_GAP * 2 ** (c.failures - 1), AUTOSAVE_INTERVAL);
}

/**
 * Asks for an early write: EVENT_SAVE_DELAY s from now, and never before `gapOf` s after the last attempt. One
 * already pending stays as it is -- it was asked earlier and will carry this change too (the save is written whole).
 */
export function scheduleSave(c: Cadence, now: number, reason: SaveEvent): void {
	if (c.due !== undefined) return;
	c.due = math.max(now + EVENT_SAVE_DELAY, c.lastAttempt + gapOf(c));
	c.reason = reason;
}

/** is the pending early write due */
export function saveDue(c: Cadence, now: number): boolean {
	return c.due !== undefined && now >= c.due;
}

/** a write attempt started less than `gapOf` s ago (15 s, more while the writes fail): the next one waits */
export function tooSoon(c: Cadence, now: number): boolean {
	return now - c.lastAttempt < gapOf(c);
}

/** a write attempt failed (after `writeStarted`): the next one backs off */
export function writeFailed(c: Cadence): void {
	c.failures += 1;
}

/** a write landed, and `json` is what the DataStore holds now */
export function writeLanded(c: Cadence, json: string): void {
	c.failures = 0;
	c.lastJson = json;
}

/** nothing is pending any more: a write carried it, or there was nothing new to write */
export function settled(c: Cadence): void {
	c.due = undefined;
	c.reason = undefined;
}

/** a write attempt starts now: whatever was pending rides with it */
export function writeStarted(c: Cadence, now: number): void {
	c.lastAttempt = now;
	settled(c);
}

export function milestonesOf(save: PlayerSaveData): Milestones {
	let skills = 0;
	for (const v of save.skillLevels) skills += v;
	let titles = "";
	for (const v of save.titles) titles += v > 0 ? "1" : "0";
	return {
		level: save.level,
		skills,
		day: save.day,
		bestDay: save.bestDay,
		runOver: save.runOver,
		runRev: save.runRev,
		lifeDeaths: save.lifeDeaths,
		titles,
	};
}

/** which event moved the save from `prev` to `now` (the most serious first), or undefined when none did */
export function milestoneEvent(prev: Milestones | undefined, now: Milestones): SaveEvent | undefined {
	if (prev === undefined) return undefined;
	if (now.lifeDeaths > prev.lifeDeaths || (now.runOver && !prev.runOver)) return "death";
	if (!now.runOver && prev.runOver) return "revive";
	if (now.runRev !== prev.runRev) return "life";
	if (now.level > prev.level) return "level";
	if (now.skills > prev.skills) return "skill";
	if (now.day > prev.day || now.bestDay > prev.bestDay) return "day";
	if (now.titles !== prev.titles) return "title";
	return undefined;
}

/** looks at the live save: the event it shows since the last look (and remembers this look) */
export function noteMilestones(c: Cadence, save: PlayerSaveData): SaveEvent | undefined {
	const now = milestonesOf(save);
	const ev = milestoneEvent(c.marks, now);
	c.marks = now;
	return ev;
}

/**
 * A craft worth a write of its own: a weapon or an equipment piece made at a workbench (the desk or the pro desk) --
 * the recipes that eat steel, machine parts, blueprints, gold or another weapon. Not what the hands make from wood and
 * stone (the stick, the stone axe), nor ammunition, smelting, a bandage, a meal or a construction (which goes on the
 * cursor, not into the save): those are cheap, frequent, and ride with the autosave.
 */
export function isRareCraft(recipeId: number): boolean {
	const recipe = recipeById(recipeId);
	if (recipe === undefined || recipe.craftKind === 1) return false;
	if (recipe.resultKind !== ItemKind.Weapon && recipe.resultKind !== ItemKind.Equip) return false;
	return recipe.needsDesk || recipe.needsPro;
}

/** the event a backpack outcome of the server is, if any: a skill learned, a rare craft */
export function backpackEvent(outcome: BackpackOutcome): SaveEvent | undefined {
	if (outcome.kind === "learned") return "skill";
	if (outcome.kind === "crafted" && isRareCraft(outcome.recipe)) return "craft";
	return undefined;
}
