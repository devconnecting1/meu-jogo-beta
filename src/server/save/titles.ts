/*
 * Titles, decided by the SERVER (docs/DESIGN_RULES.md MON-05, MP-00). The only code that writes `titles`,
 * `zombieKills`, `lifeNights`, `titleStats` and -- through the wardrobe's request -- `equipTitle` into a live save.
 *
 *   grantTitle          a title was earned: the flag goes into the save, once. Callers are the server's own events
 *                       below; nothing a client sends reaches it.
 *   creditZombieKill    one killing blow the kill credit gave this survivor (server/sim/progress.ts `creditKill`): +1
 *                       lifetime, the zombie's kind, a firearm's kill -- Horde Breaker, Exterminator, Zombie Bane,
 *                       Tracker, Sharpshooter. An assist never gets here (it is XP, MP-15, not a zombie you put down).
 *   creditMachineTitles a zombie a machine this survivor built (or a drone they fly) brought down: Sentry.
 *   creditBossTitles    a boss this survivor took part in bringing down (MP-15): Boss Hunter, Apex Hunter.
 *   creditLifeNight     one midnight the server credited to this life (server/sim/simulation.ts `creditMidnight`, a run
 *                       that pays): Week One, Seasoned, Old Guard, Centurion, Unbroken.
 *   creditNightLived    a whole night lived (server/sim/simulation.ts `creditDawn`, at 06:00), with what the server saw
 *                       of it (`NightLived`): Survivor, Nightwatch, Untouched, Blade Dancer, Stormborn, Fog Walker,
 *                       Safety in Numbers, Ghost, Close Call.
 *   creditBuilt         a construction the server placed for this survivor: Builder.
 *   creditCrafted       items the server crafted for this survivor: Tinkerer.
 *   creditVault         a bank vault this survivor's work cracked (EDI-24): Safecracker.
 *   equipTitle          the wardrobe's Equip / Unequip, through the ShopAction RemoteFunction (server/main.server.ts
 *                       `handleAction`). The request is an id and nothing else: -1 takes the title off, any other
 *                       whole id must be a title this save EARNED, or the answer is "invalid" and nothing moves.
 *
 * Every credit answers the titles it unlocked (`Unlocks`: empty -- the shared constant, no allocation -- on the
 * thousands of events that unlock nothing), so the caller announces each exactly once. Every counter is bounded
 * (SAVE_LIMITS.COUNTER_MAX, a set of bits at its own bits), and every caller has already asked the simulation whether
 * the run pays (§9.3: an assisted run earns no title, as it earns no coins).
 *
 * A client REPORT cannot do any of this either: `sanitizeClientReport` copies `titles`, `zombieKills` and
 * `titleStats` from the trusted save, `stripClientAchievements` pins them again, and `enforceSaveInvariants` takes an
 * unearned `equipTitle` off (shared/game/save.ts).
 *
 * Pure: no Instances, no services, so tools/test-save.mjs and tools/test-titles.mjs drive it directly and
 * tools/test-body.mjs through the real ShopAction remote of a booted server.
 */
import {
	BLADE_DANCER_KILLS,
	BOSS_KIND_COUNT,
	BUILDER_BUILDS,
	CENTURION_NIGHTS,
	CLOSE_CALL_SHARE,
	EXTERMINATOR_KILLS,
	GHOST_FROM_DAY,
	HORDE_BREAKER_KILLS,
	NIGHTWATCH_NIGHTS,
	OLD_GUARD_NIGHTS,
	SAFETY_IN_NUMBERS_SURVIVORS,
	SEASONED_NIGHTS,
	SENTRY_KILLS,
	SHARPSHOOTER_KILLS,
	TINKERER_CRAFTS,
	TITLES,
	TitleId,
	TitleStat,
	UNBROKEN_NIGHTS,
	UNTOUCHED_KILLS,
	WEEK_ONE_NIGHTS,
	ZOMBIE_BANE_KILLS,
	ZOMBIE_KIND_COUNT,
	bitCount,
	withBit,
} from "shared/data/titles";
import { WeaponKind } from "shared/data/kinds";
import { PlayerSaveData, SAVE_LIMITS, ownsTitle } from "shared/game/save";
import { ShopActionReason } from "shared/net/net";
import { Weather } from "shared/sim/weather";
import { creditNightAchievements } from "./achievements";

export type TitleEquip = { ok: true; titleId: number } | { ok: false; reason: ShopActionReason };

/** the titles one event unlocked, in the order they were granted (empty for almost every event) */
export type Unlocks = ReadonlyArray<number>;

/** what nothing unlocked: one shared empty list, so the common case allocates nothing */
const NONE: Unlocks = [];

/** `into` with `titleId` added when THIS call granted it (a fresh list only on the first unlock of an event) */
function grantInto(save: PlayerSaveData, titleId: number, into: Unlocks): Unlocks {
	if (!grantTitle(save, titleId)) return into;
	const out = into === NONE ? new Array<number>() : (into as Array<number>);
	out.push(titleId);
	return out;
}

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

/** +`n` on a count stat, never past COUNTER_MAX; answers the new value */
function addStat(save: PlayerSaveData, stat: number, n: number): number {
	const v = math.min(SAVE_LIMITS.COUNTER_MAX, math.max(0, save.titleStats[stat] ?? 0) + n);
	save.titleStats[stat] = v;
	return v;
}

/** a firearm: what a Sharpshooter counts (a bow is quiet, a flamethrower is Special, a blade is melee) */
function isFirearm(weaponKind: number): boolean {
	return (
		weaponKind === WeaponKind.Rifle ||
		weaponKind === WeaponKind.Pistol ||
		weaponKind === WeaponKind.MG ||
		weaponKind === WeaponKind.Shotgun ||
		weaponKind === WeaponKind.Sniper
	);
}

/**
 * One zombie this survivor put down, as the server's kill credit decided it (the killing blow). `zombieType` is its
 * kind (1..5, -1 unknown), `weaponKind` the WeaponKind the server says did it (-1 unknown: a vehicle's ram, a caller
 * that does not know) -- only the counters that care about them look. Horde Breaker, Exterminator and Zombie Bane at
 * their counts, Tracker once every kind is in, Sharpshooter at SHARPSHOOTER_KILLS firearm kills.
 */
export function creditZombieKill(save: PlayerSaveData, zombieType = -1, weaponKind = -1): Unlocks {
	save.zombieKills = math.min(SAVE_LIMITS.COUNTER_MAX, math.max(0, save.zombieKills) + 1);
	let out = NONE;
	if (save.zombieKills >= HORDE_BREAKER_KILLS) out = grantInto(save, TitleId.HordeBreaker, out);
	if (save.zombieKills >= EXTERMINATOR_KILLS) out = grantInto(save, TitleId.Exterminator, out);
	if (save.zombieKills >= ZOMBIE_BANE_KILLS) out = grantInto(save, TitleId.ZombieBane, out);
	if (typeIs(zombieType, "number") && zombieType % 1 === 0 && zombieType >= 1 && zombieType <= ZOMBIE_KIND_COUNT) {
		const kinds = withBit(save.titleStats[TitleStat.ZombieKinds] ?? 0, zombieType - 1);
		save.titleStats[TitleStat.ZombieKinds] = kinds;
		if (bitCount(kinds, ZOMBIE_KIND_COUNT) >= ZOMBIE_KIND_COUNT) out = grantInto(save, TitleId.Tracker, out);
	}
	if (isFirearm(weaponKind) && addStat(save, TitleStat.GunKills, 1) >= SHARPSHOOTER_KILLS) {
		out = grantInto(save, TitleId.Sharpshooter, out);
	}
	return out;
}

/** a zombie a machine this survivor built (a turret, an electric turret) or a turret drone they fly brought down */
export function creditMachineTitles(save: PlayerSaveData): Unlocks {
	if (addStat(save, TitleStat.MachineKills, 1) >= SENTRY_KILLS) return grantInto(save, TitleId.Sentry, NONE);
	return NONE;
}

/** a boss this survivor took part in bringing down (MP-15's participation), by its type 1..4 */
export function creditBossTitles(save: PlayerSaveData, bossType: number): Unlocks {
	if (!typeIs(bossType, "number") || bossType % 1 !== 0 || bossType < 1 || bossType > BOSS_KIND_COUNT) return NONE;
	const kinds = withBit(save.titleStats[TitleStat.BossKinds] ?? 0, bossType - 1);
	save.titleStats[TitleStat.BossKinds] = kinds;
	let out = grantInto(save, TitleId.BossHunter, NONE);
	if (bitCount(kinds, BOSS_KIND_COUNT) >= BOSS_KIND_COUNT) out = grantInto(save, TitleId.ApexHunter, out);
	return out;
}

/**
 * One midnight the server credited to this life, in a run that pays (the MP-13 count: alive, present, not AFK).
 * Week One, Seasoned, Old Guard and Centurion at their counts of `lifeNights`; Unbroken at UNBROKEN_NIGHTS while the
 * life has not died once (`lifeDeaths`, every death the server decided). The save's `day` is not read: a life's day
 * may have been counted by a client before the server counted days, or set by an admin -- neither is a night lived.
 * The same night moves the achievements that count nights (CON-04: Good day, Never die).
 */
export function creditLifeNight(save: PlayerSaveData): Unlocks {
	save.lifeNights = math.min(SAVE_LIMITS.DAY_MAX, math.max(0, save.lifeNights) + 1);
	creditNightAchievements(save);
	const n = save.lifeNights;
	let out = NONE;
	if (n >= WEEK_ONE_NIGHTS) out = grantInto(save, TitleId.WeekOne, out);
	if (n >= SEASONED_NIGHTS) out = grantInto(save, TitleId.Seasoned, out);
	if (n >= OLD_GUARD_NIGHTS) out = grantInto(save, TitleId.OldGuard, out);
	if (n >= CENTURION_NIGHTS) out = grantInto(save, TitleId.Centurion, out);
	if (save.lifeDeaths <= 0 && n >= UNBROKEN_NIGHTS) out = grantInto(save, TitleId.Unbroken, out);
	return out;
}

/**
 * What the server saw of one night a survivor lived WHOLE (server/sim/simulation.ts `creditDawn`: paid at the midnight
 * inside it, alive in the world every tick since, awake at the controls -- progress.ts `survivedNight`). The simulation
 * keeps these per survivor from that midnight on, from its own events only.
 */
export interface NightLived {
	/** zombies this survivor put down since midnight (killing blows; a machine's are not theirs) */
	kills: number;
	/** of those, the ones NOT by a melee weapon (a gun, a bow, a flame, a ram) */
	otherKills: number;
	/** the body lost health at some tick since midnight (a bite, a spit, hunger, poison) */
	hurt: boolean;
	/** the lowest health since midnight, as a share of the maximum (1 = never scratched) */
	lowestShare: number;
	/** the sky of the night: the WORLD's weather at 06:00 (a Weather value) */
	weather: number;
	/** the weather the town's own roll gave that day (an admin's sky is not a night the town threw at anyone) */
	rolledWeather: number;
	/** the world's day at 06:00 */
	worldDay: number;
	/** survivors who lived this same whole night, this one included */
	livedTogether: number;
}

/**
 * A whole night lived, at 06:00. Survivor the first time; Nightwatch at NIGHTWATCH_NIGHTS of them (over every life);
 * and the nights with something to tell (see TITLES).
 */
export function creditNightLived(save: PlayerSaveData, night: NightLived): Unlocks {
	const nights = addStat(save, TitleStat.NightsSurvived, 1);
	let out = grantInto(save, TitleId.Survivor, NONE);
	if (nights >= NIGHTWATCH_NIGHTS) out = grantInto(save, TitleId.Nightwatch, out);
	if (!night.hurt && night.kills >= UNTOUCHED_KILLS) out = grantInto(save, TitleId.Untouched, out);
	if (night.kills >= BLADE_DANCER_KILLS && night.otherKills <= 0) out = grantInto(save, TitleId.BladeDancer, out);
	// the town's own sky: an admin who sets a storm has not thrown one at anyone (and an eased one is §9.3's anyway)
	const own = night.weather === night.rolledWeather;
	if (own && night.weather === Weather.Storm) out = grantInto(save, TitleId.Stormborn, out);
	if (own && (night.weather === Weather.Fog || night.weather === Weather.DawnFog)) {
		out = grantInto(save, TitleId.FogWalker, out);
	}
	if (night.livedTogether >= SAFETY_IN_NUMBERS_SURVIVORS) out = grantInto(save, TitleId.SafetyInNumbers, out);
	if (night.worldDay >= GHOST_FROM_DAY && night.kills <= 0 && !night.hurt) out = grantInto(save, TitleId.Ghost, out);
	if (night.lowestShare <= CLOSE_CALL_SHARE) out = grantInto(save, TitleId.CloseCall, out);
	return out;
}

/** a construction the server placed for this survivor (server/sim/build.ts `place`) */
export function creditBuilt(save: PlayerSaveData): Unlocks {
	if (addStat(save, TitleStat.Builds, 1) >= BUILDER_BUILDS) return grantInto(save, TitleId.Builder, NONE);
	return NONE;
}

/** `count` items the server crafted for this survivor (server/sim/craft.ts: a Chef's double counts as two) */
export function creditCrafted(save: PlayerSaveData, count: number): Unlocks {
	if (!typeIs(count, "number") || count !== count || count < 1) return NONE;
	if (addStat(save, TitleStat.Crafts, math.floor(count)) >= TINKERER_CRAFTS) {
		return grantInto(save, TitleId.Tinkerer, NONE);
	}
	return NONE;
}

/** this survivor's work cracked a bank vault (server/sim/vault.ts `onCracked`, EDI-24) */
export function creditVault(save: PlayerSaveData): Unlocks {
	return grantInto(save, TitleId.Safecracker, NONE);
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
