/*
 * How a title looks (docs/DESIGN_RULES.md MON-05): the word in brackets, in its game colour. One place, so the
 * nameplate under a survivor, the wardrobe's rows and its preview can never disagree.
 *
 * The colours are the item card's voices (theme.ts STAT, UI-08), because a title is drawn as TEXT on the darkest
 * surfaces of the game -- the nameplate's popover and the wardrobe's rows -- and must read at 4,5:1 on both
 * (`npm run test:contrast`, "titles"):
 *   bonus  green  Survivor. The owner asked for GAME.success (#399560); it reads on the nameplate (4,95:1) but not
 *                 on the wardrobe row (#262626, 4,07:1), so it is the nearest game token that passes both: STAT.bonus,
 *                 the same green made lighter for the item card (#52CD86: 9,15:1 and 7,52:1).
 *   effect orange Horde Breaker (STAT.effect, 7,61:1 / 6,25:1).
 *   value  yellow Week One (STAT.value, 12,86:1 / 10,57:1).
 * No raw colour anywhere: every one is a token (UI-01).
 */
import { TITLES, TitleTone } from "shared/data/titles";
import { langGet } from "shared/data/lang";
import { STAT } from "./theme";

/** the token a tone draws in */
export function toneColor(tone: TitleTone): Color3 {
	if (tone === "effect") return STAT.effect;
	if (tone === "value") return STAT.value;
	return STAT.bonus;
}

/** the colour of title `titleId` (a TITLES id); a title that does not exist is drawn in the green of the first */
export function titleColor(titleId: number): Color3 {
	const def = TITLES[titleId];
	return toneColor(def !== undefined ? def.tone : "bonus");
}

/** "[Survivor]" -- the title as every screen writes it; "" for none */
export function titleText(titleId: number, lang: number): string {
	const def = TITLES[titleId];
	return def !== undefined ? `[${langGet(def.name, lang)}]` : "";
}
