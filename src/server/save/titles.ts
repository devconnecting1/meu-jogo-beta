/*
 * Titles, decided by the SERVER (docs/DESIGN_RULES.md MON-05, MP-00). The only code that writes `titles`,
 * `zombieKills`, `lifeNights` and -- through the wardrobe's request -- `equipTitle` into a live save.
 *
 *   grantTitle        a title was earned: the flag goes into the save, once. Callers are the server's own events:
 *                     a credited midnight and the 06:00 after it (server/sim/simulation.ts), a killing blow
 *                     (server/sim/progress.ts through `creditZombieKill`). Nothing a client sends reaches it.
 *   creditZombieKill  one killing blow the kill credit gave this survivor: +1 lifetime, and Horde Breaker at
 *                     HORDE_BREAKER_KILLS. An assist never gets here (it is XP, MP-15, not a zombie you put down).
 *   creditLifeNight   one midnight the server credited to this life (server/sim/simulation.ts `creditMidnight`,
 *                     a run that pays): +1 for the life, and Week One at WEEK_ONE_NIGHTS.
 *   equipTitle        the wardrobe's Equip / Unequip, through the ShopAction RemoteFunction (server/main.server.ts
 *                     `handleAction`). The request is an id and nothing else: -1 takes the title off, any other
 *                     whole id must be a title this save EARNED, or the answer is "invalid" and nothing moves.
 *
 * A client REPORT cannot do any of this either: `sanitizeClientReport` copies `titles` and `zombieKills` from the
 * trusted save and `enforceSaveInvariants` takes an unearned `equipTitle` off (shared/game/save.ts).
 *
 * Pure: no Instances, no services, so tools/test-save.mjs drives it directly and tools/test-body.mjs through the
 * real ShopAction remote of a booted server.
 */
import { HORDE_BREAKER_KILLS, TITLES, TitleId, WEEK_ONE_NIGHTS } from "shared/data/titles";
import { PlayerSaveData, SAVE_LIMITS, ownsTitle } from "shared/game/save";
import { ShopActionReason } from "shared/net/net";
import { creditNightAchievements } from "./achievements";

export type TitleEquip = { ok: true; titleId: number } | { ok: false; reason: ShopActionReason };

/**
 * `titleId` is now this survivor's. True only the FIRST time -- the unlock notice (the toast) and the save write
 * follow that answer, so a title can never be announced twice.
 */
export function grantTitle(save: PlayerSaveData, titleId: number): boolean {
	if (titleId < 0 || titleId >= TITLES.size() || titleId % 1 !== 0) return false;
	if (ownsTitle(save, titleId)) return false;
	save.titles[titleId] = 1;
	return true;
}

/**
 * One zombie this survivor put down, as the server's kill credit decided it (the killing blow). Returns the title it
 * unlocked (Horde Breaker, at HORDE_BREAKER_KILLS), or -1.
 */
export function creditZombieKill(save: PlayerSaveData): number {
	save.zombieKills = math.min(SAVE_LIMITS.COUNTER_MAX, math.max(0, save.zombieKills) + 1);
	if (save.zombieKills >= HORDE_BREAKER_KILLS && grantTitle(save, TitleId.HordeBreaker)) return TitleId.HordeBreaker;
	return -1;
}

/**
 * One midnight the server credited to this life, in a run that pays (the MP-13 count: alive, present, not AFK).
 * Returns the title it unlocked (Week One, at WEEK_ONE_NIGHTS), or -1. The save's `day` is not read: a life's day
 * may have been counted by a client before the server counted days, or set by an admin -- neither is a night lived.
 * The same night moves the achievements that count nights (CON-04: Good day, Never die).
 */
export function creditLifeNight(save: PlayerSaveData): number {
	save.lifeNights = math.min(SAVE_LIMITS.DAY_MAX, math.max(0, save.lifeNights) + 1);
	creditNightAchievements(save);
	if (save.lifeNights >= WEEK_ONE_NIGHTS && grantTitle(save, TitleId.WeekOne)) return TitleId.WeekOne;
	return -1;
}

/** a whole id, -1 (none) included: the request travels through a RemoteFunction, so it may be anything */
function isTitleChoice(v: unknown): v is number {
	return typeIs(v, "number") && v === v && v % 1 === 0 && v >= -1 && v < TITLES.size();
}

/**
 * The wardrobe asked to show `titleId` under the name (-1 = none). On success the save already shows it (and the
 * replicator's next profile pass tells everybody, server/sim/players.ts `refreshProfile`); on a refusal the save
 * is untouched.
 */
export function equipTitle(save: PlayerSaveData, titleId: unknown): TitleEquip {
	if (!isTitleChoice(titleId)) return { ok: false, reason: "invalid" };
	if (titleId >= 0 && !ownsTitle(save, titleId)) return { ok: false, reason: "invalid" };
	save.equipTitle = titleId;
	return { ok: true, titleId };
}
