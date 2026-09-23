export interface AchievementDef {
	id: number;
	max: number;
	key: string;
	/** display name */
	title: string;
	/** not shown in the list (depends on features this game does not have, e.g. ads/store rating) */
	hidden?: boolean;
	androidId: string;
}

export const ACHIEVEMENTS: Array<AchievementDef> = [
	{ id: 0, max: 1, key: "first_installation", title: "Arrival", androidId: "CgkIg6_npp8FEAIQAg" },
	{ id: 1, max: 1, key: "thomas_edison", title: "Lights On", androidId: "CgkIg6_npp8FEAIQAw" },
	{ id: 2, max: 1000, key: "melee_weapons_expert", title: "Close Quarters", androidId: "CgkIg6_npp8FEAIQBA" },
	{ id: 3, max: 200, key: "bow_expert", title: "Quiet Archer", androidId: "CgkIg6_npp8FEAIQBQ" },
	{ id: 4, max: 100, key: "collector", title: "Scavenger", androidId: "CgkIg6_npp8FEAIQBg" },
	{ id: 5, max: 200, key: "chef", title: "Camp Cook", androidId: "CgkIg6_npp8FEAIQBw" },
	{ id: 6, max: 100, key: "blacksmith", title: "Metalworker", androidId: "CgkIg6_npp8FEAIQCA" },
	{ id: 7, max: 100, key: "sniper", title: "Long Shot", androidId: "CgkIg6_npp8FEAIQCQ" },
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
	{ id: 16, max: 5000, key: "rider", title: "Road Trip", androidId: "CgkIg6_npp8FEAIQEg" },
	{ id: 17, max: 50, key: "never_die", title: "Deathless", androidId: "CgkIg6_npp8FEAIQEw" },
	{ id: 18, max: 1, key: "ninja", title: "Unseen", androidId: "CgkIg6_npp8FEAIQFA" },
	{ id: 19, max: 1, key: "thanks", title: "Thanks", hidden: true, androidId: "CgkIg6_npp8FEAIQFQ" },
	{ id: 20, max: 50, key: "ads_addict", title: "Retired", hidden: true, androidId: "CgkIg6_npp8FEAIQFg" },
	{ id: 21, max: 1, key: "turret", title: "Sentry Builder", androidId: "CgkIg6_npp8FEAIQFw" },
];
