import { langGet, LangType } from "./lang";

/*
 * The game rules, and the moderation messages that point to them (compliance audit F3, F10).
 *
 * Roblox's ban guidelines ask for the rules to be stated somewhere every user can read them, applied fairly, and
 * appealable to the creator. They are read in three places, all from here or from docs/CREATOR_HUB.md:
 *   - in the game: How to play › Rules (client/ui/tutorial.ts), for anyone who is in;
 *   - on the experience page: the same text in the description (docs/CREATOR_HUB.md), for someone who is banned
 *     and cannot get in -- which is why a ban message points THERE, not to a screen they cannot open;
 *   - the appeal path: the group linked on the experience page (the owner links it, docs/CREATOR_HUB.md).
 *
 * Every text is a lang.ts key (UI-03). Kick and ban messages are chosen on the server, in the language of the player's
 * own account (Player.LocaleId), through langGet like every other string.
 */

/** the rules and the appeal line, one per "#" (the popup shows them as lines) */
export const RULES_TEXT =
	"Play fair: no exploits, cheats or scripts, and no abusing bugs.#" +
	"Be kind: no harassment, hate, bullying or scams in chat.#" +
	"Keep personal information private: yours and everyone else's.#" +
	"Don't ruin the game for other survivors on purpose.#" +
	"Follow the Roblox Community Standards.#" +
	"Breaking a rule can get you kicked or banned. Only a person bans, never the game on its own.#" +
	"Appeals: contact the developer through the group linked on this experience's page.";

/** the save's LangType for a Roblox LocaleId ("ko-kr" -> Korean); anything else (or nothing) is English, the source */
export function langTypeOfLocale(localeId: string | undefined): number {
	if (!typeIs(localeId, "string")) return LangType.English;
	// Roblox LocaleIds are lower case ("en-us", "zh-cn")
	const lang = localeId.sub(1, 2);
	if (lang === "ko") return LangType.Korean;
	if (lang === "zh") return LangType.Chinese;
	if (lang === "ja") return LangType.Japanese;
	return LangType.English;
}

/** a sentence ends with its own punctuation, or gets a full stop */
function sentence(text: string): string {
	const last = text.sub(-1);
	return last === "." || last === "!" || last === "?" ? text : `${text}.`;
}

/** what a kicked player reads: the fixed line, and the admin's reason after it only as the text filter returned it */
export function kickMessage(lang: number, filteredReason: string | undefined): string {
	const head = langGet("You were kicked by an administrator", lang);
	return filteredReason !== undefined && filteredReason !== "" ? `${head}: ${filteredReason}` : sentence(head);
}

/** the automatic kick for flooding the remotes (docs/MULTIPLAYER.md §9.2, level 2): the only one the game makes */
export function floodKickMessage(lang: number): string {
	return sentence(langGet("Disconnected for sending too many network messages", lang));
}

/** where a banned player reads the rules and how to appeal: the experience page, the one place they can still open */
export function rulesPointer(lang: number): string {
	return sentence(langGet("The rules and how to appeal are on this experience's page", lang));
}

/**
 * Players:BanAsync's DisplayReason: the admin's reason as the text filter returned it (or the fixed line when there is
 * none), then where the rules and the appeal are. `cut` shortens the admin's part so the whole fits `maxChars` (the
 * API's 400) without ever cutting the pointer.
 */
export function banMessage(
	lang: number,
	filteredReason: string | undefined,
	maxChars: number,
	cut: (text: string, maxChars: number) => string,
): string {
	const pointer = rulesPointer(lang);
	const head =
		filteredReason !== undefined && filteredReason !== ""
			? cut(filteredReason, math.max(0, maxChars - pointer.size() - 2))
			: langGet("You are banned from this experience for breaking its rules", lang);
	return `${sentence(head)} ${pointer}`;
}
