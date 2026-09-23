/*
 * "Achievement unlocked: Zombie slayer" -- the moment the SERVER's counter reaches its goal (docs/DESIGN_RULES.md
 * CON-04, docs/MULTIPLAYER.md §6.7).
 *
 * The client counts nothing any more: the server moves every counter on its own events (server/save/achievements.ts)
 * and the wallet brings them here, pushed as soon as they change (server/main.server.ts `pushWallets`, the stand-in
 * for the §4.1 `Self` channel); `applyWallet` only ever raises them. What is left for this module is the toast: a
 * counter that was below its goal in this copy before a wallet and is at it after. Once per achievement, because the
 * copy only grows -- and a save that is REPLACED or REWRITTEN from outside is taken as the new baseline, never
 * announced: a LoadAck (`onActivate`, or a new save object), and an admin reset or edit, which rewrites ctx.save IN
 * PLACE (client/admin/patches.ts calls `rebaseAchievementNotices`). Without that last one, a survivor whose progress an
 * admin reset would never hear about re-earning First steps: the old "already complete" set outlived the reset.
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

/** the toast's memory: which achievements this copy already had complete */
export interface NoticeTracker {
	/** the save as it is now is the baseline: nothing it already holds is news */
	rebase: () => void;
	/** the ids completed since the last look, in the achievements' order; a save swapped meanwhile is a baseline */
	newlyCompleted: () => Array<number>;
}

/** pure (no Instances): tools/test-nav.mjs drives it directly */
export function noticeTracker(current: () => PlayerSaveData): NoticeTracker {
	let seenSave = current();
	let seen = completed(seenSave);
	return {
		rebase: () => {
			seenSave = current();
			seen = completed(seenSave);
		},
		newlyCompleted: () => {
			const save = current();
			const now = completed(save);
			const out = new Array<number>();
			if (save === seenSave) {
				for (const a of ACHIEVEMENTS) {
					if (now.has(a.id) && !seen.has(a.id)) out.push(a.id);
				}
			}
			seenSave = save;
			seen = now;
			return out;
		},
	};
}

let active: NoticeTracker | undefined;

/** an admin rewrote ctx.save in place (a reset, an edit): its contents are the new baseline, never announced */
export function rebaseAchievementNotices(): void {
	active?.rebase();
}

/** listens to the server's wallets for the rest of the session (call once, at boot) */
export function startAchievementNotices(ctx: GameContext): void {
	const tracker = noticeTracker(() => ctx.save);
	active = tracker;
	// a LoadAck adopted as ctx.save is the new baseline, taken the moment it is adopted -- not at the next wallet, which
	// may already be the one that completes something (First steps, granted as the survivor enters the town)
	onActivate(() => tracker.rebase());
	onWalletChanged(() => {
		const ids = tracker.newlyCompleted();
		const lang = ctx.save.settings.langType;
		for (const id of ids) {
			toast(ctx, `${langGet("Achievement unlocked", lang)}: ${langGet(ACHIEVEMENTS[id].title, lang)}`, "success");
		}
	});
}
