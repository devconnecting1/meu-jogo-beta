/*
 * "Title unlocked: [Survivor] · Common" -- the moment the SERVER grants a title (docs/DESIGN_RULES.md MON-05).
 *
 * The server decides every unlock from its own counters and tells only the survivor who earned it, on the reliable
 * channel (`Announce{TitleUnlocked}`, client/net/netClient.ts `netOnTitle`). This is what the client does with it:
 * the game's normal success toast, and the flag in the save's DISPLAY copy so the wardrobe and your own nameplate
 * know at once. That copy is never believed by anybody: `titles` is server-owned (a report cannot move it, and the
 * next wallet or LoadAck restates it), so writing it here is mirroring the server, not declaring anything.
 */
import { GameContext } from "shared/game/context";
import { TITLES } from "shared/data/titles";
import { langGet } from "shared/data/lang";
import { netOnAdminItem, netOnTitle } from "../net/netClient";
import { toast } from "./popup";
import { titleRarityText, titleText } from "./titleStyle";

/**
 * §9.3 (review of b0174ed, L-1): what a survivor reads when they take an admin's drop -- exactly what an assisted run
 * loses (server/main.server.ts `paysRewards`), and nothing it does not
 */
export const ADMIN_ITEM_TEXT = "Admin item: this run no longer earns coins, titles or achievements.";

/** listens for the server's title notices for the rest of the session (call once, at boot) */
export function startTitleNotices(ctx: GameContext): void {
	// an admin's drop taken: the run earns nothing more, and the player hears it the moment it happens
	netOnAdminItem(() => toast(ctx, langGet(ADMIN_ITEM_TEXT, ctx.save.settings.langType), "info"));
	netOnTitle(titleId => {
		if (titleId < 0 || titleId >= TITLES.size()) return;
		const save = ctx.save;
		save.titles[titleId] = 1;
		const lang = save.settings.langType;
		// the rarity's word rides with the name (MON-05): the toast has one colour, so the word is what says it
		const rarity = titleRarityText(titleId, lang);
		toast(ctx, `${langGet("Title unlocked", lang)}: ${titleText(titleId, lang)} · ${rarity}`, "success");
	});
}
