/*
 * "Achievement unlocked: Zombie slayer" -- the moment the SERVER's counter reaches its goal (docs/DESIGN_RULES.md
 * CON-04, docs/MULTIPLAYER.md §6.7).
 *
 * The client counts nothing any more: the server moves every counter on its own events (server/save/achievements.ts)
 * and the wallet brings them here, pushed as soon as they change (server/main.server.ts `pushWallets`, the stand-in
 * for the §4.1 `Self` channel); `applyWallet` only ever raises them. What is left for this module is the toast: a
 * counter that was below its goal in this copy before a wallet and is at it after. Once per achievement, because the
 * copy only grows -- and a save that REPLACES the copy (a LoadAck, an admin reset) is taken as the new baseline, never
 * announced: whatever it already holds was earned before, and was announced then.
 */
import { GameContext } from "shared/game/context";
import { PlayerSaveData } from "shared/game/save";
import { ACHIEVEMENTS } from "shared/data/achievements";
import { langGet } from "shared/data/lang";
import { onActivate, onWalletChanged } from "../systems/saveClient";
import { toast } from "./popup";

/** the ids completed in `save` (switched-off rows are never announced) */
function completed(save: PlayerSaveData): Set<number> {
	const done = new Set<number>();
	for (const a of ACHIEVEMENTS) {
		if (a.hidden === true) continue;
		if ((save.achievements[a.id] ?? 0) >= a.max) done.add(a.id);
	}
	return done;
}

/** listens to the server's wallets for the rest of the session (call once, at boot) */
export function startAchievementNotices(ctx: GameContext): void {
	let seenSave = ctx.save;
	let seen = completed(seenSave);
	// a LoadAck adopted as ctx.save is the new baseline, taken the moment it is adopted -- not at the next wallet, which
	// may already be the one that completes something (First steps, granted as the survivor enters the town)
	onActivate(() => {
		seenSave = ctx.save;
		seen = completed(seenSave);
	});
	onWalletChanged(() => {
		const save = ctx.save;
		const now = completed(save);
		// a save swapped in some other way is a baseline too: nothing it already holds is news
		if (save !== seenSave) {
			seenSave = save;
			seen = now;
			return;
		}
		const lang = save.settings.langType;
		for (const a of ACHIEVEMENTS) {
			if (!now.has(a.id) || seen.has(a.id)) continue;
			toast(ctx, `${langGet("Achievement unlocked", lang)}: ${langGet(a.title, lang)}`, "success");
		}
		seen = now;
	});
}
