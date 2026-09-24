/*
 * The achievements (docs/DESIGN_RULES.md CON-04). Twenty-two rows inherited from the original, kept in its order
 * and with its ids: the save stores one counter per row (`PlayerSaveData.achievements`), so a row is never removed
 * or renumbered -- CON-03: content that is not in the game is switched off, never deleted.
 *
 * `hidden` is that switch. A hidden row is not listed, not counted in the lobby's "3 / 18" and not credited, and its
 * stored counter is kept untouched for the day its content works. A row is on view exactly when the game of today can
 * give it (CON-03: everything in the data works -- the bow and the sniper are weapons, the bosses spawn at the town's
 * anchors), and hidden when nothing could ever raise it:
 *   - its content does not work yet (none today: the energy, ELE-01..08, and the vehicles, VEI-05, both work);
 *   - it has no trigger at all, and nothing in the original tells us what it counted (Scavenger, Unseen);
 *   - it belonged to the original's store and ads (Thanks, Retired).
 * The titles are in our own words (CON-05); the ids, the keys and the counters are the original's, so saves carry over.
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
	{ id: 0, max: 1, key: "first_installation", title: "Arrival", androidId: "CgkIg6_npp8FEAIQAg" },
	// an electric lamp switched on and lit by the grid (server/save/achievements.ts creditLitLamp, ELE-03)
	{ id: 1, max: 1, key: "thomas_edison", title: "Lights On", androidId: "CgkIg6_npp8FEAIQAw" },
	{ id: 2, max: 1000, key: "melee_weapons_expert", title: "Close Quarters", androidId: "CgkIg6_npp8FEAIQBA" },
	{ id: 3, max: 200, key: "bow_expert", title: "Quiet Archer", androidId: "CgkIg6_npp8FEAIQBQ" },
	// no trigger, and nothing says what the original collected
	{ id: 4, max: 100, key: "collector", title: "Scavenger", hidden: true, androidId: "CgkIg6_npp8FEAIQBg" },
	{ id: 5, max: 200, key: "chef", title: "Camp Cook", androidId: "CgkIg6_npp8FEAIQBw" },
	{ id: 6, max: 100, key: "blacksmith", title: "Metalworker", androidId: "CgkIg6_npp8FEAIQCA" },
	{ id: 7, max: 100, key: "sniper", title: "Long Shot", androidId: "CgkIg6_npp8FEAIQCQ" },
	// the bosses spawn at the town's anchors (shared/sim/ai/population.ts spawnBoss) and drop ITM-05's trophies; if
	// they are ever switched off (CON-03's "sem chefe"), these four go back to hidden in the same step
	{ id: 8, max: 1, key: "centipede_slayer", title: "Centipede Down", androidId: "CgkIg6_npp8FEAIQCg" },
	{ id: 9, max: 1, key: "rafflesia_slayer", title: "Rafflesia Down", androidId: "CgkIg6_npp8FEAIQCw" },
	{ id: 10, max: 1, key: "giant_slayer", title: "Giant Down", androidId: "CgkIg6_npp8FEAIQDA" },
	{ id: 11, max: 1, key: "hedgehog_slayer", title: "Hedgehog Down", androidId: "CgkIg6_npp8FEAIQDQ" },
	{ id: 12, max: 500, key: "zombie_slayer", title: "Street Sweeper", androidId: "CgkIg6_npp8FEAIQDg" },
	{
		id: 13,
		max: 100,
		key: "special_zombie_slayer",
		title: "Odd Ones Out",
		androidId: "CgkIg6_npp8FEAIQDw",
	},
	{ id: 14, max: 100, key: "woods_collector", title: "Woodpile", androidId: "CgkIg6_npp8FEAIQEA" },
	{ id: 15, max: 1, key: "good_day", title: "First Sunrise", androidId: "CgkIg6_npp8FEAIQEQ" },
	// a point per 10 u the server moved a rider, bicycle or motorcycle (VEI-05, server/sim/vehicles.ts)
	{ id: 16, max: 5000, key: "rider", title: "Road Trip", androidId: "CgkIg6_npp8FEAIQEg" },
	{ id: 17, max: 50, key: "never_die", title: "Deathless", androidId: "CgkIg6_npp8FEAIQEw" },
	// no trigger, and nothing says what the original counted
	{ id: 18, max: 1, key: "ninja", title: "Unseen", hidden: true, androidId: "CgkIg6_npp8FEAIQFA" },
	// the original's store rating and rewarded ads: this game has neither
	{ id: 19, max: 1, key: "thanks", title: "Thanks", hidden: true, androidId: "CgkIg6_npp8FEAIQFQ" },
	{ id: 20, max: 50, key: "ads_addict", title: "Retired", hidden: true, androidId: "CgkIg6_npp8FEAIQFg" },
	// a zombie brought down by a machine you built or a turret drone you fly (creditTurretKill, ELE-04)
	{ id: 21, max: 1, key: "turret", title: "Sentry Builder", androidId: "CgkIg6_npp8FEAIQFw" },
];

/** is this row on in this game (listed, counted, credited)? */
export function achievementOn(id: number): boolean {
	const def = ACHIEVEMENTS[id];
	return def !== undefined && def.hidden !== true;
}
