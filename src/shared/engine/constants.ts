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
	// the guard after a hit. The original's 45 frames (1.5 s, obj_player_body.attacked_delay) made the whole
	// horde worth one zombie: ten around you bit no harder than one. 0.5 s still stops a crowd landing every
	// bite in the same frame, and each zombie keeps its own rhythm (STUN_TIME after a bite) — LEG-04
	IFRAMES: 0.5,
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

/**
 * Town layout (world units; 1 m ≈ 55 u, see docs/DESIGN_RULES.md). Shared so AI/physics/validator
 * can reason about doors, walls, sidewalks and lanes.
 */
export const TOWN = {
	/** map border (dense forest/fence) thickness */
	BORDER: 600,
	/** two-lane street (~7 m): with cars parked at both curbs one lane (~2.9 m) stays free */
	ROAD_W: 3 * 128,
	/** avenue (~14 m, two lanes each way + planted median): one N–S and one E–W, crossing downtown */
	AVENUE_W: 6 * 128,
	MEDIAN_W: 96,
	/** target lot size between roads (actual lots vary ±ROAD_JITTER per side) */
	LOT_TARGET: 1536,
	ROAD_JITTER: 64,
	/**
	 * Sidewalk band inside a lot along every road-facing edge (~2.3 m, Dead Town's 128 px tile):
	 * the service strip at the curb (grass verge / tree pits: street trees, bins) + the clear path.
	 */
	SIDEWALK: 128,
	VERGE: 48,
	/** minimum gap between the sidewalk and a building's street face (civic buildings) */
	SETBACK: 48,
	/** houses keep a front yard; shops stand at the sidewalk */
	SETBACK_HOUSE_MIN: 112,
	SETBACK_HOUSE_MAX: 176,
	SETBACK_SHOP_MAX: 16,
	/** gas-station forecourt depth: pump islands between the street and the shop */
	FORECOURT: 320,
	/** margin between a building and the yard edge on its non-street sides */
	SIDE_YARD: 48,
	/** minimum alley between two buildings (player/zombie body is 36) */
	BUILDING_GAP: 96,
	/** building wall thickness and doorway width */
	WALL_T: 20,
	DOOR_W: 112,
	/** tree trunk collision (original mask_50_50) and visual canopy radius range */
	TREE_TRUNK: 44,
	CANOPY_R_MIN: 75,
	CANOPY_R_MAX: 86,
	/** street-tree spacing: one pitch per street (8.7–10.9 m), trees on both sides line up */
	TREE_PITCH_MIN: 480,
	TREE_PITCH_MAX: 600,
	/** nothing parked or planted closer than one car length to a street corner */
	CORNER_CLEAR: 200,
	/** car collision (original mask_200_100) */
	CAR_L: 200,
	CAR_W: 100,
	/** parked car ↔ curb, and the parallel-parking stall length (car + gap) */
	CURB_GAP: 12,
	PARK_SLOT: 264,
	/** contiguous width that always stays free across a carriageway (one lane) */
	LANE_FREE: 150,
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
