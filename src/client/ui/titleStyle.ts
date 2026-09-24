/*
 * How a title looks (docs/DESIGN_RULES.md MON-05): the word in brackets, in the colour of its RARITY. One place, so the
 * nameplate under a survivor, the wardrobe's rows, its preview, the scoreboard and the unlock toast can never disagree.
 *
 * A title is drawn as TEXT in two places and must read in both: on the wardrobe's rows, at 4,5:1 (`npm run
 * test:contrast`, "titles"), and on the nameplate, straight over the WORLD with the kit's pixel shadow (UI-04
 * clarification), at 4,5:1 against that shadow even on pure white and 30 ΔE off every ground (`npm run test:world-art`,
 * section 9). The rarities are theme tokens (theme.ts RARITY, design/tweakcn-theme.json `title-*`), from the easiest up:
 *   common     green   #52CD86  the item card's green: Survivor keeps the colour it always had (the owner asked for
 *                              GAME.success, #399560, which is 4,07:1 on the row; this is the same green made lighter)
 *   uncommon   teal    #56D2DF
 *   rare       violet  #BF9BFC
 *   epic       orange  #F58B4B  the item card's orange
 *   legendary  gold    #F6D653  the item card's gold
 * The colour is never the only cue: the wardrobe writes the rarity's word on every row ("Legendary"), the toast too.
 * No raw colour anywhere: every one is a token (UI-01).
 */
import { TITLES, TitleRarity, rarityName } from "shared/data/titles";
import { langGet } from "shared/data/lang";
import { RARITY } from "./theme";

/** the token a rarity draws in */
export function rarityColor(rarity: TitleRarity): Color3 {
	if (rarity === "uncommon") return RARITY.uncommon;
	if (rarity === "rare") return RARITY.rare;
	if (rarity === "epic") return RARITY.epic;
	if (rarity === "legendary") return RARITY.legendary;
	return RARITY.common;
}

/** the colour of title `titleId` (a TITLES id); a title that does not exist is drawn in the common green */
export function titleColor(titleId: number): Color3 {
	const def = TITLES[titleId];
	return rarityColor(def !== undefined ? def.rarity : "common");
}

/** "[Survivor]" -- the title as every screen writes it; "" for none */
export function titleText(titleId: number, lang: number): string {
	const def = TITLES[titleId];
	return def !== undefined ? `[${langGet(def.name, lang)}]` : "";
}

/** "Rare" -- the word for the rarity of title `titleId`, translated; "" for none */
export function titleRarityText(titleId: number, lang: number): string {
	const def = TITLES[titleId];
	return def !== undefined ? langGet(rarityName(def.rarity), lang) : "";
}
