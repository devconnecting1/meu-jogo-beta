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
 *                               weapon: the one that launched the arrow or the flame (server/sim/projectiles.ts), else
 *                               the one the server says is in hand. Zombie slayer, Special zombie slayer (any zombie
 *                               that is not a Walker), Melee weapons expert, Bow expert, Sniper
 *       creditBossAchievement   every participant of a boss the server's credit counted (server/sim/progress.ts
 *                               `creditBoss`, MP-15): Centipede, Rafflesia, Giant, Hedgehog slayer
 *       creditNightAchievements a midnight the server credited to this life (server/save/titles.ts
 *                               `creditLifeNight`): Good day, and Never die while `lifeDeaths` is 0
 *       countLifeDeath          EVERY death the server decides (server/sim/life.ts `died`) -- a paid Rebirth, the free
 *                               wait for daybreak and a death an ally never came for alike. `deathCount` only counts
 *                               the paid Rebirths (it prices the next one), which is why Never die kept counting
 *                               after a death answered by waiting (ACH-4)
 *       creditFirstSteps        the first body the server stands in the town for this survivor (server/net/mpHost.ts)
 *       creditCraft             a recipe the server crafted (server/sim/craft.ts), by its heat (ITM-01): what a
 *                               cooking made is Chef's, what a smelting made Blacksmith's
 *       creditTaken             what the server put into the backpack (server/sim/items.ts: pickup, search, a
 *                               Thief's find): wood is Woods collector's
 *       creditRide              the distance the server moved a rider (server/sim/vehicles.ts, VEI-05): Rider
 *       creditLitLamp           an electric lamp this survivor switched on lit up on the grid (server/sim/power.ts
 *                               `act`, ELE-03): Thomas Edison
 *       creditTurretKill        a zombie a machine this survivor built -- or a turret drone they fly -- brought down
 *                               (server/sim/progress.ts `zombieKilled` by a machine, ELE-04): Turret
 *   - a client report cannot move them: `sanitizeClientReport` copies `achievements` and `lifeDeaths` from the trusted
 *     save (shared/game/save.ts, v6), and `stripClientAchievements` pins them again (with `titles`) where the server
 *     merges the report. The counters reach the client in its wallet (`walletOf`), which the client only ever raises
 *     (`applyWallet`) -- the "Achievement unlocked" toast is that raise crossing the goal
 *     (client/ui/achievementNotice.ts);
 *   - a switched-off row (`hidden`, CON-04) is never credited;
 *   - an assisted run (§9.3) earns no achievement at all, as it earns no coins: every caller asks the simulation's
 *     `paysRewards` first -- the kill and the boss credit (progress.ts), the night (simulation.ts), the lamp (power.ts),
 *     and the cooking, the smelting, the wood and the ride (craft.ts, items.ts through interaction.ts, vehicles.ts),
 *     which counted in an assisted run until 2026-09-24 (Camp Cook, Metalworker, Woodpile, Road Trip).
 *
 * Pure: no Instances, no services, so tools/test-save.mjs drives it directly.
 */
import { ACHIEVEMENTS, AchievementId, achievementOn } from "shared/data/achievements";
import { ETC_ITEMS } from "shared/data/etcItems";
import { ItemKind, WeaponKind } from "shared/data/kinds";
import { PlayerSaveData, SAVE_LIMITS } from "shared/game/save";
import type { CraftHeat } from "shared/sim/craftRule";

/** ZombieType of the plain Walker; every other kind is a "special" zombie (Special zombie slayer) */
const WALKER = 1;

/** ETC_ITEMS id of wood (Woods collector) */
const WOOD = ETC_ITEMS.findIndex(e => e.name === "Wood");

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
 * `zombieType` is the zombie's kind (1 = Walker), `weaponKind` the WeaponKind of the weapon the SERVER says did it --
 * the one that launched the projectile, or the one in hand at the blow (-1 = unknown: only the counters that do not
 * care move).
 */
export function creditKillAchievements(save: PlayerSaveData, zombieType: number, weaponKind: number): void {
	addAchievement(save, AchievementId.ZombieSlayer, 1);
	if (whole(zombieType) && zombieType > WALKER) addAchievement(save, AchievementId.SpecialZombieSlayer, 1);
	if (weaponKind === WeaponKind.Melee) addAchievement(save, AchievementId.MeleeExpert, 1);
	else if (weaponKind === WeaponKind.Bow) addAchievement(save, AchievementId.BowExpert, 1);
	else if (weaponKind === WeaponKind.Sniper) addAchievement(save, AchievementId.Sniper, 1);
}

/** a boss this survivor took part in bringing down (MP-15's participation), by its type 1..4 */
export function creditBossAchievement(save: PlayerSaveData, bossType: number): void {
	// by name, not by offset: the types are shared/sim/ai/bossBrain.ts's (1 serpent, 2 plant, 3 charger, 4 needles)
	if (bossType === 1) raiseAchievement(save, AchievementId.CentipedeSlayer, 1);
	else if (bossType === 2) raiseAchievement(save, AchievementId.RafflesiaSlayer, 1);
	else if (bossType === 3) raiseAchievement(save, AchievementId.GiantSlayer, 1);
	else if (bossType === 4) raiseAchievement(save, AchievementId.HedgehogSlayer, 1);
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

/**
 * The report's pin (server/main.server.ts `processReport`, beside `stripClientProgress` and `stripClientLife`): a
 * client report may mirror the achievements, never set or raise them. `sanitizeClientReport` already copies
 * `achievements` and `lifeDeaths` from the trusted save (v6); they are pinned again here, where the report is merged,
 * so the rule has a guard of its own that does not hang on how the sanitizer reads a report. `titles` goes with them:
 * nothing an achievement could stand for may be granted by a report either (MON-05: only `grantTitle` writes a
 * title).
 *
 * Answers whether the report had tried (a staleness signal for the admin panel, §9.3): `claimed` is the report as it
 * was decoded, BEFORE the sanitizer copied the trusted values over it -- the only place a claim is still visible. A
 * copy that lags one wallet behind is flagged too, which is what "stale" means (as `stripClientProgress` does).
 */
export function stripClientAchievements(prev: PlayerSaveData, upd: PlayerSaveData, claimed?: unknown): boolean {
	let tried = false;
	if (typeIs(claimed, "table")) {
		const raw = claimed as Record<string, unknown>;
		tried =
			claimDiffers(prev.achievements, raw.achievements) ||
			claimDiffers(prev.titles, raw.titles) ||
			(raw.lifeDeaths !== undefined && raw.lifeDeaths !== prev.lifeDeaths);
	}
	// and whatever reached `upd` anyway (the sanitizer copies these from `prev`: only a regression there leaves a trace)
	tried =
		tried ||
		claimDiffers(prev.achievements, upd.achievements) ||
		claimDiffers(prev.titles, upd.titles) ||
		upd.lifeDeaths !== prev.lifeDeaths;
	upd.achievements = [...prev.achievements];
	upd.titles = [...prev.titles];
	upd.lifeDeaths = prev.lifeDeaths;
	return tried;
}

/** does a list the report carries differ from the trusted one? Absent is no claim; anything but a list is one */
function claimDiffers(trusted: ReadonlyArray<number>, claim: unknown): boolean {
	if (claim === undefined) return false;
	if (!typeIs(claim, "table")) return true;
	const list = claim as ReadonlyArray<unknown>;
	if (list.size() !== trusted.size()) return true;
	for (let i = 0; i < trusted.size(); i++) {
		if (list[i] !== trusted[i]) return true;
	}
	return false;
}

/** a death the server decided (server/sim/life.ts): one more for this life; `resetRun` puts it back to 0 */
export function countLifeDeath(save: PlayerSaveData): void {
	save.lifeDeaths = math.min(SAVE_LIMITS.COUNTER_MAX, math.max(0, save.lifeDeaths) + 1);
}

/** the server stood this survivor's first body in the town */
export function creditFirstSteps(save: PlayerSaveData): void {
	raiseAchievement(save, AchievementId.FirstSteps, 1);
}

/**
 * The server crafted a recipe (server/sim/craft.ts), heated as the recipe says (shared/sim/craftRule.ts `craftHeat`,
 * ITM-01): what a cooking made -- `count`, a Chef's double included -- is Chef's; what a smelting made is Blacksmith's
 * (the original's item_cook and item_fire). A cold craft (the workbench, the hands) is neither.
 */
export function creditCraft(save: PlayerSaveData, heat: CraftHeat, count: number): void {
	if (heat === "cook") addAchievement(save, AchievementId.Chef, count);
	else if (heat === "smelt") addAchievement(save, AchievementId.Blacksmith, count);
}

/**
 * Thomas Edison: E switched on an electric lamp and it LIT, fed by a battery box (server/sim/power.ts `act`, ELE-03)
 * -- light made from electricity, which is the name. A fire is not it, and neither is a lamp switched on with no power
 * (it stays dark: nothing was lit).
 */
export function creditLitLamp(save: PlayerSaveData): void {
	raiseAchievement(save, AchievementId.ThomasEdison, 1);
}

/**
 * Turret: a zombie brought down by a machine this survivor built (a turret, an electric turret) or by a turret drone
 * they fly (server/sim/progress.ts `zombieKilled` with `byMachine`, ELE-04). It is the machine's kill, so it moves no
 * kill counter (MON-05) -- this is the one achievement it earns.
 */
export function creditTurretKill(save: PlayerSaveData): void {
	raiseAchievement(save, AchievementId.Turret, 1);
}

/**
 * `count` of an item the SERVER put into this survivor's backpack (a pickup, a search, a Thief's find): wood is Woods
 * collector's.
 */
export function creditTaken(save: PlayerSaveData, kind: number, id: number, count: number): void {
	if (kind === ItemKind.Etc && id === WOOD && WOOD >= 0) addAchievement(save, AchievementId.WoodsCollector, count);
}

/** world units ridden per point of Rider: the original's 10 px (obj_player `move_count`), 1 px = 1 u here */
export const RIDER_UNITS_PER_POINT = 10;

/**
 * `points` of Rider (a whole number, one per RIDER_UNITS_PER_POINT the SERVER moved a rider: server/sim/vehicles.ts
 * turns its odometer into points and keeps the remainder). Bicycle and motorcycle alike (VEI-05).
 */
export function creditRide(save: PlayerSaveData, points: number): void {
	addAchievement(save, AchievementId.Rider, points);
}
