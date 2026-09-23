/*
 * How a title looks (docs/DESIGN_RULES.md MON-05): the word in brackets, in its game colour. One place, so the
 * nameplate under a survivor, the wardrobe's rows and its preview can never disagree.
 *
 * The colours are the item card's voices (theme.ts STAT, UI-08), because a title is drawn as TEXT in two places and
 * must read in both: on the wardrobe's rows, at 4,5:1 (`npm run test:contrast`, "titles"), and on the nameplate,
 * straight over the WORLD with the kit's pixel shadow (UI-04 clarification), at 4,5:1 against that shadow even on pure
 * white and 30 ΔE off every ground (`npm run test:world-art`, section 8):
 *   bonus  green  Survivor. The owner asked for GAME.success (#399560); it does not read on the wardrobe row
 *                 (#262626, 4,07:1), so it is the nearest game token that passes: STAT.bonus, the same green made
 *                 lighter for the item card (#52CD86: 7,52:1 on the row, 5,89:1 against its shadow on white).
 *   effect orange Horde Breaker (STAT.effect: 6,25:1 on the row, 4,90:1 against its shadow on white).
 *   value  yellow Week One (STAT.value: 10,57:1 on the row, 8,28:1 against its shadow on white).
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
