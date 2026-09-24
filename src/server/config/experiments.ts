/*
 * Experiments and configs (Creator Hub > Experiments and > Configs; docs/ANALYTICS.md §12). SERVER ONLY: ConfigService
 * refuses a client script (production/configs.md "ConfigService is only available to server scripts").
 *
 * An in-game experiment is nothing but a config KEY whose value Roblox deals out per player, so the code side is small
 * and every rule of it is here:
 *
 *   1. A player's value comes from THEIR snapshot, `GetConfigForPlayerAsync(player)`. `GetConfigAsync()` applies no
 *      experiment at all (experiments.md "Add experiments to your code").
 *   2. The first `GetValue` on that snapshot is what enrolls the player ("only the first call is random"), so a knob
 *      is read where it is used, never earlier: "Calling GetValue() too early can cause you to enroll players who never
 *      interact with the part of the game you're experimenting on."
 *   3. Nothing here can hurt the game. A config that fails to load throws (configs.md "Error handling"): every read is
 *      in pcall, bounded in time (SNAPSHOT_BUDGET_S -- a join never waits longer on it), and falls back to the knob's
 *      `fallback`, which is the game exactly as it was before the knob existed. With no config published the key
 *      reads nil, which is the fallback too. A value outside the knob's range (a typo in the Creator Hub) is the
 *      fallback, never a surprise.
 *   4. Whatever must last past the session is written where the game keeps things: the pack a new save was given is
 *      in that save. That is the "persist the value yourself" experiments.md asks of anything whose eligibility could
 *      change between sessions.
 *   5. Studio reads the STAGED values, and `ConfigService:SetTestingValue(key, value)` in the command bar overrides a
 *      key for that play session: the way to see a variant before publishing it.
 *
 * The knobs (docs/ANALYTICS.md §12 has the experiments proposed on them):
 *
 *   pz_welcome_pack   number   -1 = none (the fallback) .. SHOP_PACKS.size() - 1
 *                              a pack a NEW save is given on its first visit, delivered in the city like a bought one
 *                              (server/sim/backpack.ts). Read once per save, when it is created.
 */
import { GAME_NAME } from "shared/module";
import { SHOP_PACKS } from "shared/data/shop";
import { PlayerSaveData } from "shared/game/save";

/** a whole-number knob: one key, a safe range and the value that is the game without it */
export interface NumberKnob {
	key: string;
	fallback: number;
	min: number;
	max: number;
}

export const WELCOME_PACK: NumberKnob = {
	key: "pz_welcome_pack",
	fallback: -1,
	min: -1,
	max: SHOP_PACKS.size() - 1,
};

/** the longest a read waits for the player's snapshot (s): past it the knob keeps its fallback, nobody is enrolled */
export const SNAPSHOT_BUDGET_S = 3;

/** a config value -> the knob's value: a whole number inside the range, or the fallback (pure) */
export function knobValue(knob: NumberKnob, raw: unknown): number {
	// (NaN and ±inf fail `% 1` too)
	if (!typeIs(raw, "number") || raw % 1 !== 0) return knob.fallback;
	if (raw < knob.min || raw > knob.max) return knob.fallback;
	return raw;
}

/**
 * This player's snapshot (rule 1), or undefined: no ConfigService, a load that threw, or one slower than the budget.
 * On a timeout the snapshot that arrives later is never read -- so a player the knob could not be applied to is never
 * enrolled either (rule 2).
 */
function playerSnapshot(player: Player): ConfigSnapshot | undefined {
	const [found, service] = pcall(() => game.GetService("ConfigService"));
	if (!found || service === undefined) return undefined;
	const config = service as ConfigService;
	// (set inside the spawned thread: typed wide, or the checks below would read as constant)
	let done = false as boolean;
	let snapshot: ConfigSnapshot | undefined;
	task.spawn(() => {
		const [ok, value] = pcall(() => config.GetConfigForPlayerAsync(player));
		if (ok) snapshot = value;
		else warn(`[${GAME_NAME}] config: a player's snapshot could not be read: ${tostring(value)}`);
		done = true;
	});
	const started = os.clock();
	while (!done && os.clock() - started < SNAPSHOT_BUDGET_S) task.wait(0.05);
	if (!done) warn(`[${GAME_NAME}] config: a player's snapshot took too long; the knob keeps its fallback`);
	return done ? snapshot : undefined;
}

/**
 * The knob's value for this player -- enrolling them in the experiment running on its key, if there is one (rule 2:
 * call it where the value is used). YIELDS up to SNAPSHOT_BUDGET_S; never throws.
 */
export function readKnob(player: Player, knob: NumberKnob): number {
	const snapshot = playerSnapshot(player);
	if (snapshot === undefined) return knob.fallback;
	const [ok, raw] = pcall(() => snapshot.GetValue(knob.key));
	if (!ok) {
		warn(`[${GAME_NAME}] config: a key could not be read: ${tostring(raw)}`);
		return knob.fallback;
	}
	return knobValue(knob, raw);
}

/**
 * `pz_welcome_pack` for a save created this instant (server/main.server.ts, status "new" only): the pack goes into
 * `packsBought`, so it is delivered in the city like any bought one and is never given twice (the save only starts
 * once). Returns the arm, for the onboarding funnel's first step (server/analytics/events.ts `sessionLoaded`).
 */
export function grantWelcomePack(player: Player, save: PlayerSaveData): string {
	const id = readKnob(player, WELCOME_PACK);
	const pack = id >= 0 ? SHOP_PACKS[id] : undefined;
	if (pack === undefined) return "Welcome pack - None";
	save.packsBought[id] = (save.packsBought[id] ?? 0) + 1;
	return `Welcome pack - ${pack.name}`;
}
