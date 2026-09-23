/*
 * The achievements (docs/DESIGN_RULES.md CON-04). Twenty-two rows inherited from the original, kept in its order
 * and with its ids: the save stores one counter per row (`PlayerSaveData.achievements`), so a row is never removed
 * or renumbered -- CON-03: content that is not in the game is switched off, never deleted.
 *
 * `hidden` is that switch. A hidden row is not listed, not counted in the lobby's "3 / 9" and not credited, and its
 * stored counter is kept untouched for the day its content comes back. A row is hidden when the game has nothing
 * that could ever raise it:
 *   - its content is not in Núcleo 1 (CON-03: no boss, no bow, no sniper, no electricity, no vehicle, no turret);
 *   - it has no trigger at all, and nothing in the original tells us what it counted (Collector, Ninja);
 *   - it belonged to the original's store and ads (Thanks, Ads addict).
 * Unhiding a row is part of adding its content, together with the server's trigger for it (server/save/
 * achievements.ts): `npm run test:nav` fails for a VISIBLE row nothing on the server can raise.
 */
export interface AchievementDef {
	id: number;
	max: number;
	key: string;
	/** display name */
	title: string;
	/** switched off (CON-03, CON-04): not listed, not counted, not credited -- see the header for when */
	hidden?: boolean;
	androidId: string;
}

/** the ids the code credits by name (server/save/achievements.ts); the rest are switched off */
export const AchievementId = {
	FirstSteps: 0,
	ThomasEdison: 1,
	MeleeExpert: 2,
	BowExpert: 3,
	Collector: 4,
	Chef: 5,
	Blacksmith: 6,
	Sniper: 7,
	CentipedeSlayer: 8,
	RafflesiaSlayer: 9,
	GiantSlayer: 10,
	HedgehogSlayer: 11,
	ZombieSlayer: 12,
	SpecialZombieSlayer: 13,
	WoodsCollector: 14,
	GoodDay: 15,
	Rider: 16,
	NeverDie: 17,
	Ninja: 18,
	Thanks: 19,
	AdsAddict: 20,
	Turret: 21,
} as const;

export const ACHIEVEMENTS: Array<AchievementDef> = [
	{ id: 0, max: 1, key: "first_installation", title: "First steps", androidId: "CgkIg6_npp8FEAIQAg" },
	// electricity (generator, battery, lamp) is not in Núcleo 1 (CON-03)
	{ id: 1, max: 1, key: "thomas_edison", title: "Thomas Edison", hidden: true, androidId: "CgkIg6_npp8FEAIQAw" },
	{ id: 2, max: 1000, key: "melee_weapons_expert", title: "Melee weapons expert", androidId: "CgkIg6_npp8FEAIQBA" },
	// no bow in Núcleo 1 (CON-03)
	{ id: 3, max: 200, key: "bow_expert", title: "Bow expert", hidden: true, androidId: "CgkIg6_npp8FEAIQBQ" },
	// no trigger, and nothing says what the original collected
	{ id: 4, max: 100, key: "collector", title: "Collector", hidden: true, androidId: "CgkIg6_npp8FEAIQBg" },
	{ id: 5, max: 200, key: "chef", title: "Chef", androidId: "CgkIg6_npp8FEAIQBw" },
	{ id: 6, max: 100, key: "blacksmith", title: "Blacksmith", androidId: "CgkIg6_npp8FEAIQCA" },
	// no sniper rifle in Núcleo 1 (CON-03)
	{ id: 7, max: 100, key: "sniper", title: "Sniper", hidden: true, androidId: "CgkIg6_npp8FEAIQCQ" },
	// Núcleo 1 has no boss (CON-03); the Records window and the Survivor screen dropped their boss lines for it too
	{
		id: 8,
		max: 1,
		key: "centipede_slayer",
		title: "Centipede slayer",
		hidden: true,
		androidId: "CgkIg6_npp8FEAIQCg",
	},
	{
		id: 9,
		max: 1,
		key: "rafflesia_slayer",
		title: "Rafflesia slayer",
		hidden: true,
		androidId: "CgkIg6_npp8FEAIQCw",
	},
	{ id: 10, max: 1, key: "giant_slayer", title: "Giant slayer", hidden: true, androidId: "CgkIg6_npp8FEAIQDA" },
	{
		id: 11,
		max: 1,
		key: "hedgehog_slayer",
		title: "Hedgehog slayer",
		hidden: true,
		androidId: "CgkIg6_npp8FEAIQDQ",
	},
	{ id: 12, max: 500, key: "zombie_slayer", title: "Zombie slayer", androidId: "CgkIg6_npp8FEAIQDg" },
	{
		id: 13,
		max: 100,
		key: "special_zombie_slayer",
		title: "Special zombie slayer",
		androidId: "CgkIg6_npp8FEAIQDw",
	},
	{ id: 14, max: 100, key: "woods_collector", title: "Woods collector", androidId: "CgkIg6_npp8FEAIQEA" },
	{ id: 15, max: 1, key: "good_day", title: "Good day", androidId: "CgkIg6_npp8FEAIQEQ" },
	// no vehicle in Núcleo 1 (CON-03)
	{ id: 16, max: 5000, key: "rider", title: "Rider", hidden: true, androidId: "CgkIg6_npp8FEAIQEg" },
	{ id: 17, max: 50, key: "never_die", title: "Never die", androidId: "CgkIg6_npp8FEAIQEw" },
	// no trigger, and nothing says what the original counted
	{ id: 18, max: 1, key: "ninja", title: "Ninja", hidden: true, androidId: "CgkIg6_npp8FEAIQFA" },
	// the original's store rating and rewarded ads: this game has neither
	{ id: 19, max: 1, key: "thanks", title: "Thanks", hidden: true, androidId: "CgkIg6_npp8FEAIQFQ" },
	{ id: 20, max: 50, key: "ads_addict", title: "Ads addict", hidden: true, androidId: "CgkIg6_npp8FEAIQFg" },
	// no turret in Núcleo 1 (CON-03)
	{ id: 21, max: 1, key: "turret", title: "Turret", hidden: true, androidId: "CgkIg6_npp8FEAIQFw" },
];

/** is this row on in this game (listed, counted, credited)? */
export function achievementOn(id: number): boolean {
	const def = ACHIEVEMENTS[id];
	return def !== undefined && def.hidden !== true;
}
