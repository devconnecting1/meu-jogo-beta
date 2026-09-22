/** Design constants ported from Dead Town (GameMaker @30fps → seconds where noted). */
export const DESIGN = {
	// world
	WORLD_W: 22400,
	WORLD_H: 16640,
	GRID: 128,
	CHAR_ASPECT: 1.2,
	LINE_LENGTH: 300,
	ITEM_GET_DISTANCE: 40,
	ITEM_RESPAWN_HOURS: 12,
	MAP_ITEM_PERCENT: 70,
	MAP_ITEM_HIT_TIME: 20 / 30,
	ZOMBIE_ITEM_PERCENT: 10,
	SAVE_FILE: "save",

	// player
	PLAYER_HP: 100,
	PLAYER_HUNGRY: 100,
	MOVE_SPEED: 7,
	HP_RECOVER: 0.04 * 30, // per second
	HUNGRY_SPEED: 0.01 * 30,
	HUNGRY_HURT: 0.02 * 30,
	BUFF_POISON_HURT: 0.06 * 30,
	PLAYER_ARM: 20,
	IFRAMES: 45 / 30,
	REACTION_MAX: 6,
	REACTION_FRICTION: 0.8 * 30,

	// spawn / zombies
	DEACTIVE_TIME: 1,
	DEACTIVE_RANGE: 1200,
	ITEM_SPAWN_MIN: 600,
	ITEM_SPAWN_MAX: 1800,
	ITEM_NUMBER: 6,
	ZOMBIE_SPAWN_MIN: 720,
	ZOMBIE_SPAWN_MAX: 1080,
	ZOMBIE_NUMBER: 10,
	ZOMBIE_NUMBER_MAX: 40,
	ZOMBIE_SPAWN_TIME: 1,
	ZOMBIE_WAVE_SPAWN_TIME: 2 / 30,
	ZOMBIE_SPECIAL_NUMBER: 2,
	ZOMBIE_SPECIAL_NUMBER_MAX: 4,
	PARCEL_NUMBER: 4,
	PARCEL_ADS_TIME: (30 * 60 * 2) / 30,

	// day/night
	TIME_SPEED: 0.0014 * 30, // per second
	DARK_ALPHA_MAX: 0.95,
	DARK_ALPHA_NIGHT_SKILL: 0.9,
	WEATHER_PERCENT: 10,
	CHANGE_TIME: 2,

	// bosses
	BOSS_LENGTH: 900,
	BOSS_RESPAWN_DAY: 3,
	BOSS1_DAY: 10,
	BOSS1_X: 2432,
	BOSS1_Y: 2432,
	BOSS2_DAY: 8,
	BOSS2_X: 2816,
	BOSS2_Y: 7296,
	BOSS3_DAY: 5,
	BOSS3_X: 18560,
	BOSS3_Y: 13690,
	BOSS4_DAY: 10,
	BOSS4_X: 17280,
	BOSS4_Y: 9472,

	// economy
	AUTOSAVE_SEC: 150 / 30,
	MONEY_AD_REWARD: 5,

	// structure HP
	HP_DOOR: 500,
	HP_IRON_DOOR: 1500,
	HP_BARRICADE: 700,
	HP_IRON_BARRICADE: 1700,
	HP_CRAFTDESK: 200,
	HP_CRAFTDESK_PRO: 400,
	HP_CAMPFIRE: 400,
	HP_TRAP: 100,
	HP_TRAP_ELECTRIC: 400,
	HP_GPS: 100,
	HP_BATTERY: 300,
	HP_COOKER: 300,
	HP_GENERATOR: 500,
	HP_LAMP: 400,
	HP_TURRET: 400,

	// building footprints (sprite * 4)
	BUILDING_W: [428, 684, 808, 1068, 1064] as Array<number>,

	/**
	 * Seed of the procedural town. Fixed (like Dead Town's hand-made map) so the city, its shops
	 * and the boss plazas are the same every session; 0 = a new random town each run.
	 */
	TOWN_SEED: 7331,
} as const;

/** Town layout (world units). Shared so AI/physics can reason about doors, walls and lanes. */
export const TOWN = {
	/** map border (dense forest/fence) thickness */
	BORDER: 600,
	ROAD_W: 3 * 128,
	/** target lot size between roads (actual lots vary ±ROAD_JITTER) */
	LOT_TARGET: 1536,
	ROAD_JITTER: 96,
	/** concrete band inside a lot along every road-facing edge */
	SIDEWALK: 72,
	/** gap between the sidewalk and a building's street face */
	SETBACK: 48,
	/** minimum alley between two buildings (player/zombie body is 36) */
	BUILDING_GAP: 96,
	/** building wall thickness and doorway width */
	WALL_T: 20,
	DOOR_W: 112,
	/** tree trunk collision (original mask_50_50) and visual canopy radius range */
	TREE_TRUNK: 44,
	CANOPY_R_MIN: 75,
	CANOPY_R_MAX: 86,
	/** car collision (original mask_200_100) */
	CAR_L: 200,
	CAR_W: 100,
	TRASH: 36,
	/** radius kept free of buildings/trees/cars around each boss anchor */
	BOSS_CLEAR: 560,
	/** spatial grid cell for solids */
	GRID_CELL: 512,
} as const;

/** seconds helpers: original frames at 30fps */
export function frames30(n: number): number {
	return n / 30;
}
