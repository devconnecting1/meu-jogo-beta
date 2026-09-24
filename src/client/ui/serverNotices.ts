/*
 * What the server tells this player on its own, started once at boot (client/main.client.ts): one import there, which is
 * close to Luau's 200-locals budget (npm run check:luau).
 *
 *   titleNotice        MON-05: "Title unlocked: [Survivor]" the moment the server grants one
 *   achievementNotice  CON-04: "Achievement unlocked" the moment the server's counter reaches its goal
 *   saveIndicator      SAV-01: "Saving..." / "Saved" in the corner when the server writes the save, and
 *                      "Progress not saved — retrying" while it cannot
 */
import { GameContext } from "shared/game/context";
import { startAchievementNotices } from "./achievementNotice";
import { startSaveIndicator } from "./saveIndicator";
import { startTitleNotices } from "./titleNotice";

export function startServerNotices(ctx: GameContext): void {
	startTitleNotices(ctx);
	startAchievementNotices(ctx);
	startSaveIndicator(ctx);
}
