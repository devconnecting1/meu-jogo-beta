/*
 * Achievements, counted by the SERVER (docs/DESIGN_RULES.md CON-04, MP-00; docs/MULTIPLAYER.md §6.7). The only code
 * that writes `achievements` and `lifeDeaths` into a live save.
 *
 * Why here. From MP_PHASE 2 the horde is the server's and every client only draws a mirror of it, whose bodies never
 * reach 0 hp (client/view/actorsView.ts): the client's old counter -- "a body whose hp fell to 0 between two frames"
 * -- saw no kill at all, except an exploder whose fuse was lit, which it counted as one. And the counters travelled in
 * the client's report, so any client could simply write `achievements[12] = 500`. Now:
 *
 *   - every counter moves on an event the SERVER decided, at the place that decides it:
 *       creditKillAchievements  the killing blow of the kill credit (server/sim/progress.ts `creditKill`, the very
 *                               place `zombieKills` is credited, MON-05), with the zombie's kind and the kind of the
 *                               weapon the server says was in hand: Zombie slayer, Special zombie slayer (any zombie
 *                               that is not a Walker), Melee weapons expert -- and Bow expert and Sniper, switched off
 *       creditNightAchievements a midnight the server credited to this life (server/save/titles.ts
 *                               `creditLifeNight`): Good day, and Never die while `lifeDeaths` is 0
 *       countLifeDeath          EVERY death the server decides (server/sim/life.ts `died`) -- a paid Rebirth, the free
 *                               wait for daybreak and a death an ally never came for alike. `deathCount` only counts
 *                               the paid Rebirths (it prices the next one), which is why Never die kept counting
 *                               after a death answered by waiting (ACH-4)
 *       creditFirstSteps        the first body the server stands in the town for this survivor (server/net/mpHost.ts)
 *       creditCraft / creditCook  a recipe the server crafted (server/sim/craft.ts) -- a cooked food is Chef's, the
 *                               rest Blacksmith's -- and any other cooking path the server grows (call creditCook)
 *       creditWood              wood the server put into the backpack (server/sim/items.ts: pickup, search)
 *   - a client report cannot move them: `sanitizeClientReport` copies `achievements` and `lifeDeaths` from the trusted
 *     save (shared/game/save.ts, v6), and the counters reach the client in its wallet (`walletOf`), which the client
 *     only ever raises (`applyWallet`) -- the "Achievement unlocked" toast is that raise crossing the goal
 *     (client/ui/achievementNotice.ts);
 *   - a switched-off row (`hidden`, CON-04) is never credited;
 *   - an assisted run (§9.3) earns no kill and no night, as it earns no coins (the callers already gate those two).
 *
 * Pure: no Instances, no services, so tools/test-save.mjs drives it directly.
 */
import { ACHIEVEMENTS, AchievementId, achievementOn } from "shared/data/achievements";
import { ItemKind, WeaponKind } from "shared/data/kinds";
import { USABLES } from "shared/data/usables";
import { PlayerSaveData, SAVE_LIMITS } from "shared/game/save";

/** ZombieType of the plain Walker; every other kind is a "special" zombie (Special zombie slayer) */
const WALKER = 1;

/** USABLES ids that are the cooked form of another row (`cook`): making one of these is cooking (Chef) */
const COOKED = new Set<number>();
for (const u of USABLES) {
	if (u.cook >= 0) COOKED.add(u.cook);
}

function whole(v: unknown): v is number {
	return typeIs(v, "number") && v === v && v % 1 === 0 && v > -math.huge && v < math.huge;
}

/**
 * Raises achievement `id` to at least `value` -- never down, never past its goal, never on a switched-off row.
 * True only when THIS call completed it.
 */
export function raiseAchievement(save: PlayerSaveData, id: number, value: number): boolean {
	if (!whole(id) || !achievementOn(id) || !whole(value)) return false;
	const goal = ACHIEVEMENTS[id].max;
	const cur = math.clamp(save.achievements[id] ?? 0, 0, goal);
	const raised = math.min(goal, value);
	if (raised <= cur) return false;
	save.achievements[id] = raised;
	return raised >= goal;
}

/** adds `amount` (a whole number above 0) to achievement `id`; true when this completed it */
export function addAchievement(save: PlayerSaveData, id: number, amount: number): boolean {
	if (!whole(amount) || amount <= 0) return false;
	return raiseAchievement(save, id, (save.achievements[id] ?? 0) + amount);
}

/**
 * One killing blow of the server's kill credit (never an assist: that is XP, MP-15, not a zombie you put down).
 * `zombieType` is the zombie's kind (1 = Walker), `weaponKind` the WeaponKind of the weapon the SERVER says was in hand
 * at the blow (-1 = unknown: only the counters that do not care move).
 */
export function creditKillAchievements(save: PlayerSaveData, zombieType: number, weaponKind: number): void {
	addAchievement(save, AchievementId.ZombieSlayer, 1);
	if (whole(zombieType) && zombieType > WALKER) addAchievement(save, AchievementId.SpecialZombieSlayer, 1);
	if (weaponKind === WeaponKind.Melee) addAchievement(save, AchievementId.MeleeExpert, 1);
	else if (weaponKind === WeaponKind.Bow) addAchievement(save, AchievementId.BowExpert, 1);
	else if (weaponKind === WeaponKind.Sniper) addAchievement(save, AchievementId.Sniper, 1);
}

/**
 * A midnight the server credited to this life (the MP-13 count: alive, present, awake; never in an assisted run),
 * AFTER `lifeNights` moved: Good day for the first night a life lives through, and Never die -- the nights of a life
 * that has not died once (`lifeDeaths`, every death, counted by the server).
 */
export function creditNightAchievements(save: PlayerSaveData): void {
	raiseAchievement(save, AchievementId.GoodDay, 1);
	if (save.lifeDeaths <= 0) raiseAchievement(save, AchievementId.NeverDie, save.lifeNights);
}

/** a death the server decided (server/sim/life.ts): one more for this life; `resetRun` puts it back to 0 */
export function countLifeDeath(save: PlayerSaveData): void {
	save.lifeDeaths = math.min(SAVE_LIMITS.COUNTER_MAX, math.max(0, save.lifeDeaths) + 1);
}

/** the server stood this survivor's first body in the town */
export function creditFirstSteps(save: PlayerSaveData): void {
	raiseAchievement(save, AchievementId.FirstSteps, 1);
}

/** is this recipe result a cooked food (the `cook` target of another usable)? */
export function isCookedFood(resultKind: number, resultIndex: number): boolean {
	return resultKind === ItemKind.Use && COOKED.has(resultIndex);
}

/**
 * The server crafted a recipe (server/sim/craft.ts): `count` cooked foods are Chef's; anything else made is one more
 * for Blacksmith (a recipe, not its yield: a stack of 10 bullets is one thing made).
 */
export function creditCraft(save: PlayerSaveData, resultKind: number, resultIndex: number, count: number): void {
	if (isCookedFood(resultKind, resultIndex)) creditCook(save, count);
	else addAchievement(save, AchievementId.Blacksmith, 1);
}

/**
 * `count` foods cooked by the server. Any cooking path that does not go through a recipe calls this, with what it
 * really cooked: the name is the contract (CON-04, Chef).
 */
export function creditCook(save: PlayerSaveData, count: number): void {
	addAchievement(save, AchievementId.Chef, count);
}

/** `count` wood the server put into this survivor's backpack (a pickup, a search) */
export function creditWood(save: PlayerSaveData, count: number): void {
	addAchievement(save, AchievementId.WoodsCollector, count);
}
