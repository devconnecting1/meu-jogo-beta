/*
 * "Title unlocked: [Survivor]" -- the moment the SERVER grants a title (docs/DESIGN_RULES.md MON-05).
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
import { netOnTitle } from "../net/netClient";
import { toast } from "./popup";
import { titleText } from "./titleStyle";

/** listens for the server's title notices for the rest of the session (call once, at boot) */
export function startTitleNotices(ctx: GameContext): void {
	netOnTitle(titleId => {
		if (titleId < 0 || titleId >= TITLES.size()) return;
		const save = ctx.save;
		save.titles[titleId] = 1;
		const lang = save.settings.langType;
		toast(ctx, `${langGet("Title unlocked", lang)}: ${titleText(titleId, lang)}`, "success");
	});
}
