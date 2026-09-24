/*
 * Building plans: the footprint, the rooms, the walls with their doorways and windows, the furniture, the floor
 * decoration and the loot spots of one building (docs/DESIGN_RULES.md EDI-01, EDI-07..EDI-14).
 *
 * Pure: no Instances, no services, no Math.random. The same seed gives the same building on the server and on
 * every client (the map hash of §4.5 covers every wall and every piece of furniture), and the town generator
 * (world.ts) calls this with a building-local seed built from integers only, so a building's interior never
 * shifts the town's own random stream: the town places the same buildings in the same lots as before, and only
 * what is inside each footprint changed.
 *
 * How a plan is made:
 *   1. A TEMPLATE per building type and footprint class cuts the footprint into a small grid of cells (weights
 *      along the street and in depth). Each cell is a room letter or "." (outside: a porch, a patio, a loading
 *      notch, a courtyard). That is what makes the buildings L, T and U shapes instead of boxes, and the cells of
 *      one letter are one room.
 *   2. WALLS follow from the grid: an exterior wall where a cell meets the outside (inside the cell, its outer face
 *      on the footprint's edge, like the old four walls), an interior partition where two rooms meet (centred on
 *      the line), a post in the inner corner of every notch. Every piece is cut so that no two overlap
 *      (INT-01), and doorways, windows and interior openings are cut out of them.
 *   3. DOORS: the main entrance faces the street (EDI-01); secondary doors (back door, service door, emergency
 *      exits) are kept only when the ground outside them is free — `canOpen` asks the town and reserves it.
 *      WINDOWS go where a real building has them (living rooms, bedrooms, kitchens, classrooms, wards, the shop
 *      front), never in a bathroom, a stockroom, a cold room or the gun shop's secure room.
 *   4. FURNITURE per room, against walls or as islands, with one rule that keeps every room open: between two
 *      obstacles (walls included) there is either no gap (they touch) or a gap of at least PATH (two bodies wide,
 *      EDI-07/EDI-11), and nothing stands in front of an opening. Loot spots sit in front of the furniture that
 *      explains them (EDI-03): the fridge, the pharmacy shelves, the gun racks.
 *
 * Coordinates: the plan is laid out in a LOCAL frame, u along the street face and v in depth (v = 0 is the face
 * on the street), then mapped onto the world through the building's street side, optionally mirrored.
 */
import { TOWN } from "shared/engine/constants";
import type { DoorSide, Rect, Solid } from "./world";
import { brokenShare } from "./windows";

// ---------------------------------------------------------------------------------------------- public types

export type RoomKind =
	| "living"
	| "kitchen"
	| "dining"
	| "bedroom"
	| "bath"
	| "hall"
	| "sales"
	| "stock"
	| "cold"
	| "secure"
	| "office"
	| "classroom"
	| "corridor"
	| "lobby"
	| "ward"
	| "treatment"
	| "diner"
	| "galley"
	// the college campus (EDI-17)
	| "foyer"
	| "lecture"
	| "stacks"
	| "reading"
	| "lab"
	| "chemstore"
	| "dormroom"
	| "common";

export type FloorKind = "wood" | "tile" | "shop" | "carpet" | "kitchen" | "bath" | "concrete";

export type FurnitureKind =
	| "sofa"
	| "armchair"
	| "tv"
	| "bookcase"
	| "counter"
	| "stove"
	| "fridge"
	| "table"
	| "bed"
	| "nightstand"
	| "wardrobe"
	| "desk"
	| "cabinet"
	| "toilet"
	| "basin"
	| "tub"
	| "shelf"
	| "gondola"
	| "checkout"
	| "coldcase"
	| "rack"
	| "gunrack"
	| "display"
	| "clothesrack"
	| "hospbed"
	| "optable"
	| "reception"
	| "lockers"
	| "schooldesk"
	| "teacherdesk"
	| "prep"
	| "booth"
	| "safe"
	| "bench"
	// the college campus (EDI-17)
	| "lectern"
	| "seats"
	| "labbench"
	| "fumehood"
	| "chemshelf"
	| "bunk"
	| "vending";

export type DecorKind =
	| "rug"
	| "mat"
	| "blood"
	| "papers"
	| "glass"
	| "chair"
	| "chairDown"
	| "board"
	| "curtain"
	/** a cork notice board on a wall (the campus's lobbies and halls) */
	| "notice";

export type OpeningKind = "door" | "window" | "inner";

/** one floor rectangle of a room (a room of several cells has several) */
export interface RoomRect extends Rect {
	kind: RoomKind;
	floor: FloorKind;
	/** rooms of one building are numbered from 0; the rects of one room share it */
	room: number;
}

/** a gap cut in a wall: its rect is exactly the gap (wall thickness × opening width) */
export interface Opening extends Rect {
	kind: OpeningKind;
	/** exterior openings: the side the building looks out of through it; interior: an axis (top = wall along x) */
	side: DoorSide;
	/** the main entrance (the one facing the street) */
	main: boolean;
	/** a window generated with its glass already broken (EDI-18: a seeded share, `brokenShare` of the type) */
	broken?: boolean;
	/**
	 * A window's solid, set by the town (world.ts `planInteriors`): the pane's state lives there (shared/game/windows.ts),
	 * and the drawing reads it through this without looking the solid up
	 */
	glass?: Solid;
}

export interface Piece extends Rect {
	kind: FurnitureKind;
	/** bullets fly over it (a table, a bed, a counter); a tall piece stops them (a shelf, a wardrobe) */
	low: boolean;
	/** the side of the piece that faces into the room (its front) */
	face: DoorSide;
	/** a small deterministic number for the drawing (which end the sink is at, which way a bed's pillow lies) */
	variant: number;
}

export interface Decor extends Rect {
	kind: DecorKind;
	/** quarter turns or a small angle (radians), for the drawing */
	rot: number;
}

export interface WallRect extends Rect {
	/** a partition inside the building (drawn a shade lighter, thinner) */
	inner: boolean;
}

export interface BuildingPlan {
	/** non-overlapping rects whose union is the footprint (walls included): roof, "inside", shadow */
	parts: Array<Rect>;
	rooms: Array<RoomRect>;
	walls: Array<WallRect>;
	openings: Array<Opening>;
	furniture: Array<Piece>;
	decor: Array<Decor>;
	/** where a survivor can search the building (EDI-03): in front of the furniture that holds its loot */
	loot: Array<{ x: number; y: number }>;
	/** the notches of the footprint (outside, inside the bounding box): `front` on the street face (a porch) */
	yards: Array<Rect & { front: boolean }>;
	/** the part the main entrance opens into: where the rooftop sign goes (the main wing) */
	mainWing: Rect;
	/** centre of the main doorway, on its wall's mid-line */
	doorX: number;
	doorY: number;
	/** how far the main door is set back from the street face (a porch) */
	recess: number;
}

export interface PlanInput {
	/**
	 * building type (1/2 house, 3 school, 4 hospital, 5 gas, 6 pharmacy, 7/8 market, 9 gun shop, 10 cloth, 11 restaurant;
	 * the campus: 12 main hall, 13 library, 14 science lab, 15 dorm)
	 */
	type: number;
	/** the footprint's bounding box (world) */
	rect: Rect;
	/** the side of the box facing the street: the main door is in it */
	side: DoorSide;
	/**
	 * Where the town put the main door: its centre along the street face (world x for a top / bottom face, y for a
	 * left / right one). The plan keeps it there exactly -- the town reserved the walk to it, and moving it would move
	 * every tree, bin and car placed after it -- and fits the rooms around it.
	 */
	doorU: number;
	/** building-local seed (integers only) */
	seed: number;
	/**
	 * A secondary door would open onto `approach` (world, the ground right outside it): answer whether that ground
	 * is free. The town asks once it is complete (trees, bins and cars placed), so the answer is final. The main
	 * door is never asked: the town already keeps its approach.
	 */
	canOpen: (approach: Rect) => boolean;
}

// ---------------------------------------------------------------------------------------------- dimensions

/** exterior wall thickness (the old four walls') and doorway width (ESC-02) */
const T = TOWN.WALL_T;
const DOOR = TOWN.DOOR_W;
/** interior partition thickness */
export const INNER_WALL = 16;
const TI = INNER_WALL;
/** interior doorway: two bodies side by side (EDI-11) */
export const INNER_DOOR_W = 96;
/** a window: wide enough for the biggest walker (45 u) to climb through, narrower than a door */
export const WINDOW_W = 80;
/** the clear width every path between two obstacles keeps (two bodies of 36 plus margin, EDI-11) */
export const PATH = 88;
/**
 * Obstacles closer than this are a SEALED slot: narrower than the slimmest body (a walker, 32), nobody walks into
 * it. Between SEALED and PATH a body would fit alone and could be cornered or queue in single file: never.
 */
const SEALED = 30;
/** nothing is placed in front of a doorway, this deep (two bodies) and this much wider on each side */
const CLEAR_DEPTH = 72;
const CLEAR_SIDE = 16;
/** nor in front of a window: the horde climbs in there (EDI-10); one body deep is enough to step down */
const WINDOW_CLEAR_DEPTH = 44;
const WINDOW_CLEAR_SIDE = 4;
/** a secondary door needs this much free ground outside it */
const APPROACH_DEPTH = 80;
/** an opening keeps this far from the end of its wall (the corner, a partition) */
const END_MARGIN = T + 16;
/** an outside door keeps only this far from the end of its wall: enough for a stub beside the frame */
const DOOR_MARGIN = T + 4;
/** the main door's run of wall reaches at least this far on each side of its centre */
const MAIN_HALF = DOOR / 2 + DOOR_MARGIN;
/** re-cutting the columns around the main door never leaves a column narrower than this: a room with its bed
 * or its sofa AND a window, not a slot (a narrower one falls back to the next template) */
const MIN_COL = 200;

// ---------------------------------------------------------------------------------------------- rng

/** MINSTD, like the town's: exact in Luau doubles, the same on every machine */
class PlanRng {
	private s: number;

	constructor(seed: number) {
		let s = math.floor(math.abs(seed)) % 2147483647;
		if (s === 0) s = 1;
		this.s = s;
	}

	next(): number {
		this.s = (this.s * 48271) % 2147483647;
		return (this.s - 1) / 2147483646;
	}

	int(a: number, b: number): number {
		return math.min(b, a + math.floor(this.next() * (b - a + 1)));
	}

	chance(p: number): boolean {
		return this.next() < p;
	}
}

/** integer-only seed of a building (never math.sin: the server and a phone must agree to the last bit) */
export function buildingSeed(x: number, y: number, kind: number, town: number): number {
	const a = (math.floor(x) * 7919 + math.floor(y) * 104729 + kind * 15485863) % 2147483647;
	return ((a + (math.floor(math.abs(town)) % 1000003) * 31) % 2147483646) + 1;
}

// ---------------------------------------------------------------------------------------------- templates

/** local sides: F front (v = 0, the street), K back (v = D), L (u = 0), R (u = A) */
type LSide = "F" | "K" | "L" | "R";

interface Template {
	/** weights of the columns along the street face, and of the rows from the front */
	cols: Array<number>;
	rows: Array<number>;
	/** one array per row, one letter per column: a room letter, or "." for outside */
	map: Array<Array<string>>;
	/** room letter → kind */
	rooms: Record<string, RoomKind>;
	/**
	 * Main entrance: the column and row of the cell whose FRONT face (the street side) holds it. Where along that
	 * face is the town's choice (`PlanInput.doorU`): the columns are re-cut around it when they must (`fitMain`).
	 */
	main: [number, number];
	/** secondary door candidates, kept when the ground outside is free: column, row, side, position */
	doors: Array<[number, number, LSide, number]>;
	/** at most this many secondary doors */
	extra: number;
	/**
	 * interior openings between adjacent cells: c1, r1, c2, r2, wide (1: open plan, most of the wall), and where along
	 * the wall (a share of it, 0.5 when left out: the middle) -- off the middle, the rest of the wall is free for a piece
	 */
	links: Array<[number, number, number, number, number, number?]>;
}

const HOUSE_ROOMS: Record<string, RoomKind> = {
	L: "living",
	K: "kitchen",
	D: "dining",
	B: "bedroom",
	b: "bedroom",
	W: "bath",
	H: "hall",
};

/** small house (428 × 552), deep: porch with the door in it / back patio */
const HOUSE_S_DEEP: Array<Template> = [
	{
		cols: [44, 56],
		rows: [26, 30, 44],
		map: [
			[".", "L"],
			["L", "L"],
			["K", "B"],
		],
		rooms: HOUSE_ROOMS,
		main: [0, 1],
		doors: [[0, 2, "K", 0.5]],
		extra: 1,
		links: [
			[0, 1, 0, 2, 0],
			[1, 1, 1, 2, 0],
		],
	},
	{
		cols: [50, 50],
		rows: [34, 42, 24],
		map: [
			["L", "L"],
			["K", "B"],
			["K", "."],
		],
		rooms: HOUSE_ROOMS,
		main: [0, 0],
		doors: [
			[0, 2, "R", 0.5],
			[0, 2, "K", 0.5],
		],
		extra: 1,
		links: [
			[0, 0, 0, 1, 0],
			[1, 0, 1, 1, 0],
		],
	},
];

/** small house, wide (552 × 428) */
const HOUSE_S_WIDE: Array<Template> = [
	{
		cols: [32, 30, 38],
		rows: [45, 55],
		map: [
			[".", "L", "L"],
			["K", "K", "B"],
		],
		rooms: HOUSE_ROOMS,
		main: [1, 0],
		doors: [
			[0, 1, "K", 0.5],
			[1, 1, "K", 0.5],
		],
		extra: 1,
		links: [
			[1, 0, 1, 1, 1],
			[2, 0, 2, 1, 0],
		],
	},
	{
		cols: [55, 45],
		rows: [50, 50],
		map: [
			["L", "B"],
			["K", "."],
		],
		rooms: HOUSE_ROOMS,
		main: [0, 0],
		doors: [
			[0, 1, "R", 0.5],
			[0, 1, "K", 0.5],
		],
		extra: 1,
		links: [
			[0, 0, 0, 1, 1],
			[0, 0, 1, 0, 0],
		],
	},
];

/** medium / large house with a hall (4 columns): living, hall to the bedrooms, kitchen with the back door */
const HOUSE_HALL: Template = {
	cols: [26, 22, 18, 34],
	rows: [26, 34, 40],
	map: [
		[".", "L", "L", "B"],
		["L", "L", "H", "B"],
		["K", "K", "H", "b"],
	],
	rooms: HOUSE_ROOMS,
	main: [1, 0],
	doors: [
		[2, 2, "K", 0.5],
		[0, 2, "K", 0.5],
	],
	extra: 1,
	links: [
		[1, 1, 2, 1, 0],
		[2, 1, 3, 1, 0],
		[2, 2, 3, 2, 0],
		[1, 2, 2, 2, 0],
		[1, 1, 1, 2, 1],
	],
};

/** medium / large house, U around a back patio: two wings (kitchen, bedroom with its bathroom) */
const HOUSE_U: Template = {
	cols: [36, 28, 36],
	rows: [48, 52],
	map: [
		["L", "L", "B"],
		["K", ".", "W"],
	],
	rooms: HOUSE_ROOMS,
	main: [1, 0],
	doors: [
		[0, 1, "R", 0.5],
		[0, 1, "K", 0.5],
	],
	extra: 1,
	links: [
		[0, 0, 0, 1, 0],
		[1, 0, 2, 0, 0],
		[2, 0, 2, 1, 0],
	],
};

/** large house, L with a back-left notch: living, open kitchen-dining, bedroom with an en-suite */
const HOUSE_L: Template = {
	cols: [34, 32, 34],
	rows: [36, 30, 34],
	map: [
		["L", "L", "B"],
		["K", "D", "B"],
		[".", "D", "W"],
	],
	rooms: HOUSE_ROOMS,
	main: [0, 0],
	doors: [
		[1, 2, "K", 0.5],
		[1, 2, "L", 0.5],
		[0, 1, "K", 0.5],
	],
	extra: 1,
	links: [
		[0, 0, 0, 1, 0],
		[1, 0, 1, 1, 1],
		[0, 1, 1, 1, 1],
		[1, 0, 2, 0, 0],
		[2, 1, 2, 2, 0],
	],
};

/** medium house, deep (556 × 684): front bay with the living room, kitchen and bath behind */
const HOUSE_M_DEEP: Array<Template> = [
	{
		cols: [48, 52],
		rows: [26, 34, 40],
		map: [
			[".", "L"],
			["K", "L"],
			["W", "B"],
		],
		rooms: HOUSE_ROOMS,
		main: [1, 0],
		doors: [
			[0, 2, "K", 0.5],
			[0, 1, "L", 0.5],
		],
		extra: 1,
		links: [
			[0, 1, 1, 1, 1],
			[1, 1, 1, 2, 0],
			[0, 1, 0, 2, 0],
		],
	},
	{
		cols: [52, 48],
		rows: [36, 38, 26],
		map: [
			["L", "L"],
			["K", "B"],
			["K", "."],
		],
		rooms: HOUSE_ROOMS,
		main: [0, 0],
		doors: [
			[0, 2, "R", 0.5],
			[0, 2, "K", 0.5],
		],
		extra: 1,
		links: [
			[0, 0, 0, 1, 1],
			[1, 0, 1, 1, 0],
		],
	},
];

/** the big house (1068 × 1068): U around a patio, en-suite master bedroom, open dining room */
const HOUSE_XL: Template = {
	cols: [34, 32, 34],
	rows: [34, 30, 36],
	map: [
		["L", "L", "B"],
		["D", "D", "b"],
		["K", ".", "W"],
	],
	rooms: HOUSE_ROOMS,
	main: [1, 0],
	doors: [
		[0, 2, "R", 0.5],
		[1, 1, "K", 0.5],
		[0, 2, "K", 0.5],
	],
	extra: 2,
	links: [
		[0, 0, 0, 1, 1],
		[2, 0, 1, 0, 0],
		[1, 1, 2, 1, 0],
		[0, 1, 0, 2, 0],
		[2, 1, 2, 2, 0],
	],
};

const SHOP_ROOMS: Record<string, RoomKind> = { S: "sales", R: "stock", F: "cold", X: "secure", O: "office" };

/** a small shop (684 × 556): sales floor on the street, back room, loading notch */
function smallShop(back: string): Array<Template> {
	return [
		{
			cols: [62, 38],
			rows: [68, 32],
			map: [
				["S", "S"],
				[back, "."],
			],
			rooms: SHOP_ROOMS,
			main: [0, 0],
			doors: [
				[0, 1, "R", 0.5],
				[0, 1, "K", 0.5],
			],
			extra: 1,
			links: [[0, 0, 0, 1, 0]],
		},
		{
			cols: [24, 52, 24],
			rows: [66, 34],
			map: [
				["S", "S", "S"],
				[".", back, "."],
			],
			rooms: SHOP_ROOMS,
			main: [1, 0],
			doors: [[1, 1, "K", 0.5]],
			extra: 1,
			links: [[1, 0, 1, 1, 0]],
		},
	];
}

/** the corner market (684 × 556): sales, cold room and stockroom behind, loading notch */
const SMALL_MARKET: Array<Template> = [
	{
		cols: [36, 34, 30],
		rows: [62, 38],
		map: [
			["S", "S", "S"],
			["F", "R", "."],
		],
		rooms: SHOP_ROOMS,
		main: [1, 0],
		doors: [
			[1, 1, "R", 0.5],
			[1, 1, "K", 0.5],
		],
		extra: 1,
		// the walk-in cooler and the stockroom both open onto the sales floor (a third doorway between them
		// left the stockroom no wall for a rack)
		links: [
			[0, 0, 0, 1, 0],
			[1, 0, 1, 1, 0],
		],
	},
	...smallShop("R"),
];

/** the supermarket (1068 × 1064): two front doors (in and out), cold room, stockroom, loading dock */
const BIG_MARKET: Array<Template> = [
	{
		cols: [36, 34, 30],
		rows: [64, 36],
		map: [
			["S", "S", "S"],
			["F", "R", "."],
		],
		rooms: SHOP_ROOMS,
		main: [0, 0],
		doors: [
			[2, 0, "F", 0.5],
			[1, 1, "R", 0.5],
			[1, 1, "K", 0.5],
		],
		extra: 2,
		links: [
			[0, 0, 0, 1, 0],
			[1, 0, 1, 1, 0],
			[0, 1, 1, 1, 0],
		],
	},
	{
		cols: [26, 48, 26],
		rows: [62, 38],
		map: [
			["S", "S", "S"],
			[".", "F", "R"],
		],
		rooms: SHOP_ROOMS,
		main: [1, 0],
		doors: [
			[1, 0, "F", 0.8],
			[2, 1, "K", 0.5],
			[1, 1, "L", 0.5],
		],
		extra: 2,
		links: [
			[1, 0, 1, 1, 0],
			[2, 0, 2, 1, 0],
			[1, 1, 2, 1, 0],
		],
	},
];

const DINER_ROOMS: Record<string, RoomKind> = { D: "diner", K: "galley", R: "stock" };

/** the restaurant (1068 × 1064): dining room on the street, kitchen with two swing doors, service yard */
const RESTAURANT: Array<Template> = [
	{
		cols: [45, 30, 25],
		rows: [58, 42],
		map: [
			["D", "D", "D"],
			["D", "K", "."],
		],
		rooms: DINER_ROOMS,
		main: [1, 0],
		doors: [
			[1, 1, "R", 0.5],
			[1, 1, "K", 0.5],
		],
		extra: 1,
		links: [
			[1, 0, 1, 1, 0],
			[0, 1, 1, 1, 0],
		],
	},
	{
		cols: [30, 40, 30],
		rows: [60, 40],
		map: [
			["D", "D", "D"],
			[".", "K", "R"],
		],
		rooms: DINER_ROOMS,
		main: [1, 0],
		doors: [
			[2, 1, "K", 0.5],
			[1, 1, "L", 0.5],
		],
		extra: 2,
		links: [
			[1, 0, 1, 1, 0],
			[2, 0, 2, 1, 0],
			[1, 1, 2, 1, 0],
		],
	},
];

/** gas station shop (684 × 556): the shop faces the forecourt, back room with the service door */
const GAS: Array<Template> = [
	{
		cols: [40, 30, 30],
		rows: [62, 38],
		map: [
			["S", "S", "S"],
			["R", "R", "."],
		],
		rooms: SHOP_ROOMS,
		main: [1, 0],
		doors: [
			[1, 1, "R", 0.5],
			[0, 1, "K", 0.5],
		],
		extra: 1,
		links: [[0, 0, 0, 1, 0]],
	},
	{
		cols: [30, 40, 30],
		rows: [62, 38],
		map: [
			["S", "S", "S"],
			[".", "R", "O"],
		],
		rooms: SHOP_ROOMS,
		main: [1, 0],
		doors: [
			[1, 1, "K", 0.5],
			[1, 1, "L", 0.5],
		],
		extra: 1,
		links: [
			[1, 0, 1, 1, 0],
			[1, 1, 2, 1, 0],
		],
	},
];

const SCHOOL_ROOMS: Record<string, RoomKind> = {
	C: "classroom",
	c: "classroom",
	e: "classroom",
	f: "classroom",
	H: "corridor",
	E: "lobby",
	O: "office",
};

/** the school (1064 × 812): classrooms on a corridor with an exit at each end; a courtyard notch */
const SCHOOL: Array<Template> = [
	{
		cols: [29, 42, 29],
		rows: [38, 21, 41],
		map: [
			["C", ".", "c"],
			["H", "H", "H"],
			["e", "O", "f"],
		],
		rooms: SCHOOL_ROOMS,
		main: [1, 1],
		// the corridor's two ends first; where the yard outside one is taken, a back classroom's fire exit
		doors: [
			[0, 1, "L", 0.5],
			[2, 1, "R", 0.5],
			[0, 2, "K", 0.5],
			[2, 2, "K", 0.5],
			[1, 2, "K", 0.5],
		],
		extra: 2,
		links: [
			[0, 0, 0, 1, 0],
			[2, 0, 2, 1, 0],
			[0, 2, 0, 1, 0],
			[1, 2, 1, 1, 0],
			[2, 2, 2, 1, 0],
		],
	},
	{
		cols: [34, 32, 34],
		rows: [38, 21, 41],
		map: [
			["C", "E", "c"],
			["H", "H", "H"],
			["e", ".", "f"],
		],
		rooms: SCHOOL_ROOMS,
		main: [1, 0],
		doors: [
			[0, 1, "L", 0.5],
			[2, 1, "R", 0.5],
			[1, 1, "K", 0.5],
			[0, 2, "K", 0.5],
			[2, 2, "K", 0.5],
		],
		extra: 3,
		links: [
			[0, 0, 0, 1, 0],
			[1, 0, 1, 1, 1],
			[2, 0, 2, 1, 0],
			[0, 2, 0, 1, 0],
			[2, 2, 2, 1, 0],
		],
	},
];

const HOSPITAL_ROOMS: Record<string, RoomKind> = {
	E: "lobby",
	H: "corridor",
	M: "ward",
	m: "ward",
	T: "treatment",
	O: "office",
};

/** the hospital (1064 × 812): reception block on the street, a corridor, wards and the treatment room (ER doors) */
const HOSPITAL: Array<Template> = [
	{
		cols: [29, 42, 29],
		rows: [27, 21, 52],
		map: [
			[".", "E", "."],
			["H", "H", "H"],
			["M", "T", "m"],
		],
		rooms: HOSPITAL_ROOMS,
		main: [1, 0],
		doors: [
			[1, 2, "K", 0.5],
			[0, 1, "L", 0.5],
			[2, 1, "R", 0.5],
		],
		extra: 3,
		links: [
			[1, 0, 1, 1, 1],
			[0, 2, 0, 1, 0],
			[1, 2, 1, 1, 0],
			[2, 2, 2, 1, 0],
		],
	},
	{
		cols: [36, 28, 36],
		rows: [42, 22, 36],
		map: [
			["E", "E", "M"],
			["H", "H", "H"],
			["O", ".", "T"],
		],
		rooms: HOSPITAL_ROOMS,
		main: [0, 0],
		doors: [
			[2, 2, "K", 0.5],
			[1, 1, "K", 0.5],
			[0, 1, "L", 0.5],
			[2, 1, "R", 0.5],
		],
		extra: 3,
		links: [
			[0, 0, 0, 1, 1],
			[2, 0, 2, 1, 0],
			[0, 2, 0, 1, 0],
			[2, 2, 2, 1, 0],
		],
	},
];

// ---------------------------------------------------------------------------------------------- the campus (EDI-17)
//
// Four buildings of 600-760 along their street round a quad (shared/game/campus.ts): the main hall 400 deep, the
// others 352. Each faces its own street (the main door, EDI-01) and has its back on the quad or on a lane, where the
// secondary doors go (EDI-09). The main door is in the middle column of every template. None is a box (EDI-14): the
// hall is a U round its entrance court, the library a front pavilion between set-back stacks, the lab an L round the
// chemicals' delivery bay (or a T), the dorm a T whose common room runs on to the quad. Each notch is shallow enough
// to leave the rooms either side of it their furniture (a deeper one leaves the dorm's common room no wall for the
// sofa, the library's stacks no room for their rows).
//
// What makes these rooms furnishable at this size is where the doorways are: a doorway in the middle of every wall
// of a 200-unit room leaves no wall for anything (EDI-12 keeps 72 u clear in front of each). So the room of the
// middle column is a foyer that passes people through (tiled, a notice board on a wall, nothing that must fit), the
// rooms either side are entered off it, and a link that must share a wall with a piece sits off the middle (the 6th
// number of a link).

const CAMPUS_ROOMS: Record<string, RoomKind> = {
	A: "lecture",
	a: "lecture",
	E: "foyer",
	H: "corridor",
	O: "office",
	S: "stacks",
	s: "stacks",
	R: "reading",
	L: "lab",
	l: "lab",
	C: "chemstore",
	B: "dormroom",
	b: "dormroom",
	M: "common",
	W: "bath",
};

/**
 * The main hall (~700 × 400), an L on the quad (EDI-14): the foyer at the door, a lecture room either side of it
 * (or a lecture room and the faculty office), the back corridor with its lockers along two thirds of the building,
 * an exit at its end and the door onto the quad; a paved patio on the quad behind the third room. The street front
 * stays whole: the sign goes beside the door (ART-07).
 */
const CAMPUS_HALL: Array<Template> = [
	{
		cols: [36, 28, 36],
		rows: [60, 40],
		map: [
			["A", "E", "a"],
			["H", "H", "."],
		],
		rooms: CAMPUS_ROOMS,
		main: [1, 0],
		// the corridor's door onto the quad, then its two ends (the near one onto the patio)
		doors: [
			[1, 1, "K", 0.5],
			[0, 1, "L", 0.5],
			[1, 1, "R", 0.5],
		],
		extra: 2,
		// the lecture rooms off the foyer, towards the front: the back wall is the seats'
		links: [
			[1, 0, 0, 0, 0, 0.15],
			[1, 0, 2, 0, 0, 0.15],
			[1, 0, 1, 1, 0],
		],
	},
	{
		cols: [38, 26, 36],
		rows: [60, 40],
		map: [
			["A", "E", "O"],
			[".", "H", "H"],
		],
		rooms: CAMPUS_ROOMS,
		main: [1, 0],
		doors: [
			[1, 1, "K", 0.5],
			[2, 1, "R", 0.5],
			[1, 1, "L", 0.5],
		],
		extra: 2,
		links: [
			[1, 0, 0, 0, 0, 0.15],
			[1, 0, 2, 0, 0, 0.15],
			[1, 0, 1, 1, 0],
		],
	},
];

/**
 * The library (~700 × 352), an L on the quad (EDI-14): the reading room with the front desk at the door, the stacks
 * either side of it (or behind one wall of it), entered at the back of the reading room so its front stays the
 * desk's; one wing of stacks stops short of the back, a paved patio behind it. The second door is a fire exit of the
 * stacks (onto the lane, or the patio): a door at the back of the reading room as well would leave its walls no room
 * for the desk and the tables.
 */
const CAMPUS_LIBRARY: Array<Template> = [
	{
		cols: [30, 40, 30],
		rows: [80, 20],
		map: [
			["S", "R", "s"],
			["S", ".", "s"],
		],
		rooms: CAMPUS_ROOMS,
		main: [1, 0],
		doors: [
			[0, 0, "L", 0.5],
			[2, 0, "R", 0.5],
			[0, 1, "K", 0.5],
			[2, 1, "K", 0.5],
		],
		extra: 1,
		// as far back as the front row goes: its side walls ahead of them are the desk's
		links: [
			[1, 0, 0, 0, 0, 1],
			[1, 0, 2, 0, 0, 1],
		],
	},
	{
		cols: [56, 44],
		rows: [72, 28],
		map: [
			["R", "S"],
			[".", "S"],
		],
		rooms: CAMPUS_ROOMS,
		main: [0, 0],
		doors: [
			[1, 0, "R", 0.5],
			[1, 1, "K", 0.5],
		],
		extra: 1,
		links: [[0, 0, 1, 0, 0, 0.85]],
	},
];

/**
 * The science lab (~700 × 352), an L or a T on the quad (EDI-14): the prep hall at the door with the door onto the
 * quad, a teaching lab on one side and the windowless chemicals store on the other, which stops short of the back
 * where the deliveries came (a paved bay) -- or two labs either side of the prep hall, which runs on to the quad
 * between their two back notches.
 */
const CAMPUS_LAB: Array<Template> = [
	{
		cols: [40, 26, 34],
		rows: [72, 28],
		map: [
			["L", "E", "C"],
			["L", "E", "."],
		],
		rooms: CAMPUS_ROOMS,
		main: [1, 0],
		doors: [
			[1, 1, "K", 0.5],
			[0, 0, "L", 0.5],
		],
		extra: 2,
		links: [
			[1, 0, 0, 0, 0, 0.3],
			[1, 0, 2, 0, 0, 0.3],
		],
	},
	{
		cols: [37, 26, 37],
		rows: [72, 28],
		map: [
			["L", "E", "l"],
			[".", "E", "."],
		],
		rooms: CAMPUS_ROOMS,
		main: [1, 0],
		doors: [
			[1, 1, "K", 0.5],
			[0, 0, "L", 0.5],
			[2, 0, "R", 0.5],
		],
		extra: 2,
		links: [
			[1, 0, 0, 0, 0, 0.3],
			[1, 0, 2, 0, 0, 0.3],
		],
	},
];

/**
 * The dorm (~700 × 352), a T on the quad (EDI-14): the common room from the street door to the door onto the quad,
 * a bunk room either side entered at its front, so each keeps its walls for the bunk beds (a bunk room with a door
 * of its own as well has none left), stopping short of the back (a paved notch behind each). No washroom: at this
 * size one would leave a bunk room no wall for a bed -- the showers are down the hall, off the map.
 */
const CAMPUS_DORM: Array<Template> = [
	{
		cols: [36, 28, 36],
		rows: [78, 22],
		map: [
			["B", "M", "b"],
			[".", "M", "."],
		],
		rooms: CAMPUS_ROOMS,
		main: [1, 0],
		doors: [
			[1, 1, "K", 0.5],
			[0, 0, "L", 0.5],
			[2, 0, "R", 0.5],
		],
		extra: 1,
		// the bunk rooms' doorways as far to the front as they go: the back of the common room's side walls is the
		// sofa's and the TV's
		links: [
			[1, 0, 0, 0, 0, 0],
			[1, 0, 2, 0, 0, 0],
		],
	},
];

/** the templates that fit a footprint of this type, `along` × `depth` */
function templatesFor(bt: number, along: number, depth: number): Array<Template> {
	if (bt === 1 || bt === 2) {
		const area = along * depth;
		if (area > 1000000) return [HOUSE_XL];
		if (area > 500000) return [HOUSE_HALL, HOUSE_U, HOUSE_L];
		if (area > 300000) {
			if (along >= depth) return [HOUSE_HALL, HOUSE_U];
			return HOUSE_M_DEEP;
		}
		return along >= depth ? HOUSE_S_WIDE : HOUSE_S_DEEP;
	}
	if (bt === 3) return SCHOOL;
	if (bt === 4) return HOSPITAL;
	if (bt === 5) return GAS;
	if (bt === 7) return BIG_MARKET;
	if (bt === 8) return SMALL_MARKET;
	if (bt === 11) return RESTAURANT;
	if (bt === 9) return smallShop("X");
	if (bt === 12) return CAMPUS_HALL;
	if (bt === 13) return CAMPUS_LIBRARY;
	if (bt === 14) return CAMPUS_LAB;
	if (bt === 15) return CAMPUS_DORM;
	return smallShop("R");
}

/** a house's last resort: the living room across the whole front (the town's door fits anywhere), a back patio */
const HOUSE_FALLBACK: Template = {
	cols: [34, 32, 34],
	rows: [48, 52],
	map: [
		["L", "L", "L"],
		["K", ".", "B"],
	],
	rooms: HOUSE_ROOMS,
	main: [1, 0],
	doors: [
		[0, 1, "K", 0.5],
		[2, 1, "K", 0.5],
	],
	extra: 1,
	links: [
		[0, 0, 0, 1, 0],
		[2, 0, 2, 1, 0],
	],
};

/** anything else's last resort: one room (never seen on the validated seeds: every template fits a centred door) */
function fallbackFor(bt: number): Template {
	if (bt === 1 || bt === 2) return HOUSE_FALLBACK;
	const kind: RoomKind =
		bt === 3 || bt === 4 || bt === 12
			? "lobby"
			: bt === 11
				? "diner"
				: bt === 13
					? "reading"
					: bt === 14
						? "lab"
						: bt === 15
							? "common"
							: "sales";
	return { cols: [1], rows: [1], map: [["A"]], rooms: { A: kind }, main: [0, 0], doors: [], extra: 0, links: [] };
}

// ---------------------------------------------------------------------------------------------- room kinds

interface RoomInfo {
	floor: FloorKind;
	/**
	 * 0 no windows; 1 on its outside walls; 2 a shop front: a row of windows along the street face, and one on a
	 * side wall where it is free
	 */
	win: number;
	/**
	 * The room's first window is cut BEFORE the furniture (a hall-like room whose furniture is sparse: classroom,
	 * ward, lobby, dining room of a restaurant). A home's rooms are furnished first and get their windows where the
	 * wall is still free, as a real room does: the bed against the wall, the window beside it.
	 */
	early: boolean;
}

const ROOM_INFO: Record<RoomKind, RoomInfo> = {
	living: { floor: "wood", win: 1, early: false },
	kitchen: { floor: "kitchen", win: 1, early: false },
	dining: { floor: "wood", win: 1, early: false },
	bedroom: { floor: "carpet", win: 1, early: false },
	bath: { floor: "bath", win: 0, early: false },
	hall: { floor: "wood", win: 0, early: false },
	sales: { floor: "shop", win: 2, early: true },
	stock: { floor: "concrete", win: 0, early: false },
	cold: { floor: "bath", win: 0, early: false },
	secure: { floor: "concrete", win: 0, early: false },
	office: { floor: "carpet", win: 1, early: false },
	classroom: { floor: "shop", win: 1, early: true },
	corridor: { floor: "tile", win: 0, early: false },
	lobby: { floor: "tile", win: 1, early: true },
	ward: { floor: "tile", win: 1, early: true },
	treatment: { floor: "tile", win: 0, early: false },
	diner: { floor: "wood", win: 1, early: true },
	galley: { floor: "kitchen", win: 0, early: false },
	// the campus (EDI-17): the reading room, a lab and a bunk room are furnished round their window (a dorm room's
	// window is the one thing it is sure of); a lecture room, the stacks and the common room get theirs where the
	// seats, the shelves and the sofa leave wall (a lecture room's seats need its back wall, and on the quad side of
	// the hall that wall is outside); the chemicals store has none (a real one is a locked, windowless room)
	foyer: { floor: "tile", win: 0, early: false },
	lecture: { floor: "shop", win: 1, early: false },
	stacks: { floor: "carpet", win: 1, early: false },
	reading: { floor: "carpet", win: 1, early: true },
	lab: { floor: "tile", win: 1, early: true },
	chemstore: { floor: "concrete", win: 0, early: false },
	dormroom: { floor: "carpet", win: 1, early: true },
	common: { floor: "wood", win: 1, early: false },
};

// ---------------------------------------------------------------------------------------------- local geometry

/** a rect in the local frame */
interface LR {
	u0: number;
	u1: number;
	v0: number;
	v1: number;
}

function lr(u0: number, u1: number, v0: number, v1: number): LR {
	return { u0: math.min(u0, u1), u1: math.max(u0, u1), v0: math.min(v0, v1), v1: math.max(v0, v1) };
}

function overlapLR(a: LR, b: LR): boolean {
	return a.u0 < b.u1 && a.u1 > b.u0 && a.v0 < b.v1 && a.v1 > b.v0;
}

/** distance between two rects (0 when they touch or overlap) */
function gapLR(a: LR, b: LR): number {
	const du = math.max(0, b.u0 - a.u1, a.u0 - b.u1);
	const dv = math.max(0, b.v0 - a.v1, a.v0 - b.v1);
	return math.sqrt(du * du + dv * dv);
}

/** a nook this shallow (a piece's end against a wall) is a step in and out, not a passage */
const NOOK = 64;

/**
 * Do `a` and `b` leave a passage between them that one body fits in and two do not, longer than `nook`? That is
 * the gap a survivor gets cornered in and a queue of zombies single-files through (EDI-11). Corner to corner
 * and sealed gaps (under SEALED: nobody walks in) are fine.
 *
 * Against a WALL a short one (a piece's end, NOOK deep) is only a step in and out. Between two PIECES it is never
 * fine (`nook` 0): such a slot can be the only way into the space behind them -- behind an armchair and a TV, say
 * -- and the horde's flow field (32 u cells, obstacles grown 4 u) cannot see through a slot under two bodies wide,
 * so a survivor who squeezed in there would be out of the horde's reach (the hiding pocket of seeds 2 and
 * 1712783770, review of ea5cf71).
 */
function narrowBetween(a: LR, b: LR, nook: number): boolean {
	const du = math.max(0, b.u0 - a.u1, a.u0 - b.u1);
	const dv = math.max(0, b.v0 - a.v1, a.v0 - b.v1);
	if (du > 0 && dv > 0) return false;
	const g = math.max(du, dv);
	if (g < SEALED || g >= PATH) return false;
	const len = du > 0 ? math.min(a.v1, b.v1) - math.max(a.v0, b.v0) : math.min(a.u1, b.u1) - math.max(a.u0, b.u0);
	return len > nook;
}

/**
 * `piece` minus the run-axis interval of every rect in `cut` that overlaps it. `alongU`: the piece runs along u
 * (a wall seen from above as a horizontal band in the local frame). Every cutter spans the piece's full thickness
 * where they overlap (walls of one line, openings of one wall), so the difference is one-dimensional.
 */
function subtract(pieces: Array<LR>, cut: ReadonlyArray<LR>, alongU: boolean): Array<LR> {
	let cur = pieces;
	for (const c of cut) {
		const kept: Array<LR> = [];
		for (const p of cur) {
			if (!overlapLR(p, c)) {
				kept.push(p);
				continue;
			}
			if (alongU) {
				if (c.u0 > p.u0) kept.push(lr(p.u0, c.u0, p.v0, p.v1));
				if (c.u1 < p.u1) kept.push(lr(c.u1, p.u1, p.v0, p.v1));
			} else {
				if (c.v0 > p.v0) kept.push(lr(p.u0, p.u1, p.v0, c.v0));
				if (c.v1 < p.v1) kept.push(lr(p.u0, p.u1, c.v1, p.v1));
			}
		}
		cur = kept;
	}
	return cur;
}

/** the local frame of a building: u along the street face, v in depth from it */
class Frame {
	readonly A: number;
	readonly D: number;

	constructor(
		private readonly r: Rect,
		private readonly side: DoorSide,
		private readonly mirror: boolean,
	) {
		const alongX = side === "top" || side === "bottom";
		this.A = alongX ? r.w : r.h;
		this.D = alongX ? r.h : r.w;
	}

	x(u: number, v: number): number {
		const s = this.side;
		const uu = this.mirror ? this.A - u : u;
		if (s === "top" || s === "bottom") return this.r.x + uu;
		if (s === "left") return this.r.x + v;
		return this.r.x + this.r.w - v;
	}

	y(u: number, v: number): number {
		const s = this.side;
		const uu = this.mirror ? this.A - u : u;
		if (s === "left" || s === "right") return this.r.y + uu;
		if (s === "top") return this.r.y + v;
		return this.r.y + this.r.h - v;
	}

	rect(l: LR): Rect {
		const x0 = this.x(l.u0, l.v0);
		const x1 = this.x(l.u1, l.v1);
		const y0 = this.y(l.u0, l.v0);
		const y1 = this.y(l.u1, l.v1);
		return { x: math.min(x0, x1), y: math.min(y0, y1), w: math.abs(x1 - x0), h: math.abs(y1 - y0) };
	}

	/** the world side a local side looks towards */
	world(s: LSide): DoorSide {
		const side = this.side;
		if (s === "F") return side;
		if (s === "K") {
			if (side === "top") return "bottom";
			if (side === "bottom") return "top";
			if (side === "left") return "right";
			return "left";
		}
		const low = (s === "L") !== this.mirror;
		if (side === "top" || side === "bottom") return low ? "left" : "right";
		return low ? "top" : "bottom";
	}
}

/** an edge of the grid, with the side its building interior lies on */
interface Edge {
	/** true: the wall runs along u (a front / back / partition line at constant v) */
	alongU: boolean;
	/** the line: v for alongU, u otherwise */
	at: number;
	a: number;
	b: number;
	/** exterior: the side of the building the outside is on; interior: undefined */
	out?: LSide;
}

/** the wall band of an edge (exterior: inside the cell; interior: centred on the line) */
function bandOf(e: Edge, a: number, b: number): LR {
	if (e.out === undefined) {
		return e.alongU ? lr(a, b, e.at - TI / 2, e.at + TI / 2) : lr(e.at - TI / 2, e.at + TI / 2, a, b);
	}
	if (e.out === "F") return lr(a, b, e.at, e.at + T);
	if (e.out === "K") return lr(a, b, e.at - T, e.at);
	if (e.out === "L") return lr(e.at, e.at + T, a, b);
	return lr(e.at - T, e.at, a, b);
}

// ---------------------------------------------------------------------------------------------- the plan

interface LOpening {
	band: LR;
	kind: OpeningKind;
	/** exterior: the local side it looks out of; interior: undefined */
	out?: LSide;
	alongU: boolean;
	main: boolean;
	/** a window whose glass the generator broke (EDI-18) */
	broken?: boolean;
}

interface LPiece extends LR {
	kind: FurnitureKind;
	low: boolean;
	face: LSide;
	loot: boolean;
	room: number;
}

interface LDecor extends LR {
	kind: DecorKind;
	rot: number;
}

/** one room while furnishing: its cells' inner rects and the walls around them */
interface RoomCtx {
	id: number;
	kind: RoomKind;
	cells: Array<{ inner: LR; walls: Array<{ side: LSide; seg: LR }> }>;
	/** the whole floor inside the walls, when the room's cells fill a rectangle */
	whole?: LR;
}

class Planner {
	readonly f: Frame;
	readonly us: Array<number> = [];
	readonly vs: Array<number> = [];
	/** room index per cell, -1 outside */
	readonly cell: Array<number> = [];
	readonly kinds: Array<RoomKind> = [];
	readonly nc: number;
	readonly nr: number;
	readonly openings: Array<LOpening> = [];
	readonly walls: Array<{ r: LR; inner: boolean }> = [];
	readonly pieces: Array<LPiece> = [];
	readonly decor: Array<LDecor> = [];
	readonly clear: Array<LR> = [];
	/** the same zones exactly as wide as their openings (no side margin): a last resort's (`fits` with `tight`) */
	readonly clearTight: Array<LR> = [];
	readonly loot: Array<{ u: number; v: number; room: number }> = [];
	recess = 0;
	/** the main door's centre along the street face, in this plan's local frame */
	readonly mainU: number;
	/** the columns whose front run holds the main door (set by fitMain) */
	private mainLo = 0;
	private mainHi = 0;

	constructor(
		readonly inp: PlanInput,
		readonly tpl: Template,
		readonly rng: PlanRng,
		mirror: boolean,
	) {
		this.f = new Frame(inp.rect, inp.side, mirror);
		this.nc = tpl.cols.size();
		this.nr = tpl.rows.size();
		cuts(this.us, tpl.cols, this.f.A);
		cuts(this.vs, tpl.rows, this.f.D);
		const along = inp.side === "top" || inp.side === "bottom" ? inp.doorU - inp.rect.x : inp.doorU - inp.rect.y;
		this.mainU = mirror ? this.f.A - along : along;
		const letters: Array<string> = [];
		for (let j = 0; j < this.nr; j++) {
			const row = tpl.map[j];
			for (let i = 0; i < this.nc; i++) {
				const ch = row[i] ?? ".";
				if (ch === "." || ch === "") {
					this.cell.push(-1);
					continue;
				}
				let id = letters.indexOf(ch);
				if (id < 0) {
					id = letters.size();
					letters.push(ch);
					this.kinds.push(tpl.rooms[ch] ?? "hall");
				}
				this.cell.push(id);
			}
		}
	}

	at(i: number, j: number): number {
		if (i < 0 || j < 0 || i >= this.nc || j >= this.nr) return -1;
		return this.cell[j * this.nc + i];
	}

	/**
	 * Fits the main door where the town put it (`mainU`): the front run of the main cell's room -- its cells of the
	 * main row whose front face is outside -- must reach MAIN_HALF past the door on both sides. When it does not,
	 * the column cut on that side moves (on the 8-unit grid), as long as the column it eats stays MIN_COL wide.
	 * Answers how far the cuts move in total, or -1 when the door cannot fit this template this way round;
	 * `apply` makes the move.
	 */
	fitMain(apply: boolean): number {
		const [mi, mj] = this.tpl.main;
		const id = this.at(mi, mj);
		if (id < 0 || this.at(mi, mj - 1) >= 0) return -1;
		const frontOut = (i: number) => this.at(i, mj) === id && this.at(i, mj - 1) < 0;
		let lo = mi;
		let hi = mi;
		while (lo > 0 && frontOut(lo - 1)) lo--;
		while (hi < this.nc - 1 && frontOut(hi + 1)) hi++;
		const us = this.us;
		const u = this.mainU;
		let cost = 0;
		let left = us[lo];
		let right = us[hi + 1];
		if (u - MAIN_HALF < left) {
			if (lo === 0) return -1;
			left = math.floor((u - MAIN_HALF) / 8) * 8;
			if (left - us[lo - 1] < MIN_COL) return -1;
			cost += us[lo] - left;
		}
		if (u + MAIN_HALF > right) {
			if (hi + 1 === this.nc) return -1;
			right = math.ceil((u + MAIN_HALF) / 8) * 8;
			if (us[hi + 2] - right < MIN_COL) return -1;
			cost += right - us[hi + 1];
		}
		if (apply) {
			us[lo] = left;
			us[hi + 1] = right;
			this.mainLo = lo;
			this.mainHi = hi;
		}
		return cost;
	}

	/**
	 * The main wing (local): the stretch of facade that holds the main door -- the cells of the main row, either
	 * side of the main cell, that are inside and have the street (or the porch, or the entrance court) in front,
	 * whatever room they are -- from that facade back through every following row in which all of those columns
	 * are still inside. Inside the footprint by construction, and its street edge IS the main door's facade.
	 */
	mainWingLocal(): LR {
		const [mi, mj] = this.tpl.main;
		const front = (i: number) => this.at(i, mj) >= 0 && this.at(i, mj - 1) < 0;
		let lo = mi;
		let hi = mi;
		while (lo > 0 && front(lo - 1)) lo--;
		while (hi < this.nc - 1 && front(hi + 1)) hi++;
		let j1 = mj;
		const full = (j: number) => {
			for (let i = lo; i <= hi; i++) if (this.at(i, j) < 0) return false;
			return true;
		};
		while (j1 + 1 < this.nr && full(j1 + 1)) j1++;
		return lr(this.us[lo], this.us[hi + 1], this.vs[mj], this.vs[j1 + 1]);
	}

	/** the edge of cell (i, j) on local side s */
	edgeOf(i: number, j: number, s: LSide): Edge {
		const us = this.us;
		const vs = this.vs;
		const out = this.at(i + (s === "L" ? -1 : s === "R" ? 1 : 0), j + (s === "F" ? -1 : s === "K" ? 1 : 0)) < 0;
		if (s === "F") return { alongU: true, at: vs[j], a: us[i], b: us[i + 1], out: out ? s : undefined };
		if (s === "K") return { alongU: true, at: vs[j + 1], a: us[i], b: us[i + 1], out: out ? s : undefined };
		if (s === "L") return { alongU: false, at: us[i], a: vs[j], b: vs[j + 1], out: out ? s : undefined };
		return { alongU: false, at: us[i + 1], a: vs[j], b: vs[j + 1], out: out ? s : undefined };
	}

	/**
	 * The exterior edge of cell (i, j) on side s, extended along the cells of the same room whose same side is
	 * outside too: one room's street face is one wall, however many cells it spans (a door can sit anywhere on it).
	 */
	runOf(i: number, j: number, s: LSide): Edge {
		const e = this.edgeOf(i, j, s);
		// the cell's own edge when a door fits in it (so a template can put two doors on one long front)
		if (e.out === undefined || e.b - e.a >= DOOR + DOOR_MARGIN * 2) return e;
		const id = this.at(i, j);
		const alongU = e.alongU;
		let lo = alongU ? i : j;
		let hi = lo;
		const same = (k: number) => {
			const ci = alongU ? k : i;
			const cj = alongU ? j : k;
			return this.at(ci, cj) === id && this.edgeOf(ci, cj, s).out !== undefined;
		};
		while (same(lo - 1)) lo--;
		while (same(hi + 1)) hi++;
		const line = alongU ? this.us : this.vs;
		return { alongU, at: e.at, a: line[lo], b: line[hi + 1], out: e.out };
	}

	/** an opening of width w on edge e at fraction k of its usable length; undefined if it does not fit */
	cutIn(e: Edge, w: number, k: number, kind: OpeningKind, main: boolean): LOpening | undefined {
		// a door may nearly fill a corridor's end (a short stub of wall beside it); a window keeps off the corners
		const m = e.out === undefined ? TI / 2 + 16 : kind === "door" ? DOOR_MARGIN : END_MARGIN;
		const lo = e.a + m + w / 2;
		const hi = e.b - m - w / 2;
		if (hi < lo) return undefined;
		const c = math.floor(lo + (hi - lo) * math.clamp(k, 0, 1));
		return { band: bandOf(e, c - w / 2, c + w / 2), kind, out: e.out, alongU: e.alongU, main };
	}

	/** is this opening clear of every other opening on the same wall (a window never eats a door) */
	freeOf(o: LOpening, margin: number): boolean {
		for (const p of this.openings) {
			if (p.alongU !== o.alongU) continue;
			const grow = lr(o.band.u0 - margin, o.band.u1 + margin, o.band.v0 - margin, o.band.v1 + margin);
			if (overlapLR(grow, p.band)) return false;
		}
		return true;
	}

	/** the ground right outside an exterior opening (world): what a secondary door needs free */
	approachOf(o: LOpening): Rect {
		return this.f.rect(this.approachLocal(o));
	}

	approachLocal(o: LOpening): LR {
		const b = o.band;
		const d = APPROACH_DEPTH;
		const s = CLEAR_SIDE;
		if (o.out === "F") return lr(b.u0 - s, b.u1 + s, b.v0 - d, b.v0);
		if (o.out === "K") return lr(b.u0 - s, b.u1 + s, b.v1, b.v1 + d);
		if (o.out === "L") return lr(b.u0 - d, b.u0, b.v0 - s, b.v1 + s);
		return lr(b.u1, b.u1 + d, b.v0 - s, b.v1 + s);
	}

	/** does a local rect run into the building's own footprint (a door in a notch facing the other wing)? */
	hitsFootprint(q: LR): boolean {
		for (let j = 0; j < this.nr; j++) {
			for (let i = 0; i < this.nc; i++) {
				if (this.at(i, j) < 0) continue;
				if (overlapLR(q, lr(this.us[i], this.us[i + 1], this.vs[j], this.vs[j + 1]))) return true;
			}
		}
		return false;
	}

	// ------------------------------------------------------------------------------------ doors and windows

	cutDoors(): void {
		const tpl = this.tpl;
		// the main door, exactly where the town put it (fitMain made room for it)
		const mj = tpl.main[1];
		const front: Edge = {
			alongU: true,
			at: this.vs[mj],
			a: this.us[this.mainLo],
			b: this.us[this.mainHi + 1],
			out: "F",
		};
		const u = this.mainU;
		this.openings.push({
			band: bandOf(front, u - DOOR / 2, u + DOOR / 2),
			kind: "door",
			out: "F",
			alongU: true,
			main: true,
		});
		this.recess = this.vs[mj];
		let extra = 0;
		for (const [i, j, s, k] of tpl.doors) {
			if (extra >= tpl.extra) break;
			const e = this.runOf(i, j, s);
			if (e.out === undefined) continue;
			const o = this.cutIn(e, DOOR, k, "door", false);
			if (o === undefined || !this.freeOf(o, 40)) continue;
			// the ground outside: never the building's own other wing, and free in the town (which then keeps it)
			if (this.hitsFootprint(this.approachLocal(o))) continue;
			if (!this.inp.canOpen(this.approachOf(o))) continue;
			this.openings.push(o);
			extra++;
		}
		for (const [i1, j1, i2, j2, wide, at] of tpl.links) {
			const s: LSide = i2 > i1 ? "R" : i2 < i1 ? "L" : j2 > j1 ? "K" : "F";
			const e = this.edgeOf(i1, j1, s);
			if (e.out !== undefined) continue;
			const len = e.b - e.a - TI - 32;
			const w = wide === 1 ? math.max(INNER_DOOR_W, math.floor(len * 0.8)) : INNER_DOOR_W;
			const o = this.cutIn(e, w, at ?? 0.5, "inner", false);
			if (o === undefined) continue;
			this.openings.push(o);
			this.join(this.at(i1, j1), this.at(i2, j2));
		}
		this.connectRooms();
	}

	// ------------------------------------------------------------------------------------ rooms joined

	/** union-find over the rooms: which ones an interior doorway already joins */
	private readonly roomOf: Array<number> = [];

	private root(a: number): number {
		while (this.roomOf.size() <= a) this.roomOf.push(this.roomOf.size());
		let r = a;
		while (this.roomOf[r] !== r) r = this.roomOf[r];
		return r;
	}

	private join(a: number, b: number): void {
		if (a < 0 || b < 0) return;
		const ra = this.root(a);
		const rb = this.root(b);
		if (ra !== rb) this.roomOf[math.max(ra, rb)] = math.min(ra, rb);
	}

	/**
	 * EDI-08: every room is reached from the main door THROUGH THE INSIDE. A template's link can fail to cut when the
	 * columns moved around the main door (a wall grew too short for a doorway); then the room gets a doorway on the
	 * first interior wall it shares with a room that is already joined, cells in order, so no room is ever reached
	 * only through its own outside door or a window.
	 */
	private connectRooms(): void {
		const mainRoom = this.at(this.tpl.main[0], this.tpl.main[1]);
		for (let pass = 0; pass < this.kinds.size(); pass++) {
			let changed = false;
			for (let j = 0; j < this.nr; j++) {
				for (let i = 0; i < this.nc; i++) {
					const id = this.at(i, j);
					if (id < 0 || this.root(id) === this.root(mainRoom)) continue;
					for (const s of LSIDES) {
						const n = this.at(
							i + (s === "L" ? -1 : s === "R" ? 1 : 0),
							j + (s === "F" ? -1 : s === "K" ? 1 : 0),
						);
						if (n < 0 || n === id || this.root(n) !== this.root(mainRoom)) continue;
						const o = this.cutIn(this.edgeOf(i, j, s), INNER_DOOR_W, 0.5, "inner", false);
						if (o === undefined) continue;
						this.openings.push(o);
						this.join(id, n);
						changed = true;
						break;
					}
				}
			}
			if (!changed) break;
		}
	}

	/** the floor right inside an opening, `depth` deep and `side` wider at each end (on both sides of a partition) */
	zonesOf(o: LOpening, depth: number, side: number): Array<LR> {
		const b = o.band;
		const out: Array<LR> = [];
		if (o.alongU) {
			if (o.out !== "F") out.push(lr(b.u0 - side, b.u1 + side, b.v0 - depth, b.v0));
			if (o.out !== "K") out.push(lr(b.u0 - side, b.u1 + side, b.v1, b.v1 + depth));
		} else {
			if (o.out !== "L") out.push(lr(b.u0 - depth, b.u0, b.v0 - side, b.v1 + side));
			if (o.out !== "R") out.push(lr(b.u1, b.u1 + depth, b.v0 - side, b.v1 + side));
		}
		return out;
	}

	/**
	 * The windows every room is sure of, BEFORE the furniture: a shop front's whole row of windows, and one window
	 * in the longest outside wall of every other room that has windows. The furniture then keeps clear of them.
	 */
	firstWindows(): void {
		for (let room = 0; room < this.kinds.size(); room++) {
			const info = ROOM_INFO[this.kinds[room]];
			if (info.win === 0 || !info.early) continue;
			let best: Edge | undefined;
			const fronts: Array<string> = [];
			for (let j = 0; j < this.nr; j++) {
				for (let i = 0; i < this.nc; i++) {
					if (this.at(i, j) !== room) continue;
					for (const s of LSIDES) {
						const e = this.edgeOf(i, j, s);
						if (e.out === undefined || (info.win === 2 && s !== "F")) continue;
						if (info.win === 2) {
							// a shop front: one row of windows along the room's whole street face (however many
							// cells it spans), wherever its doors leave wall, 140 apart
							const run = this.frontRun(i, j);
							const key = `${run.at}:${run.a}`;
							if (fronts.includes(key)) continue;
							fronts.push(key);
							for (
								let c = run.a + END_MARGIN + WINDOW_W / 2;
								c <= run.b - END_MARGIN - WINDOW_W / 2;
								c += 140
							) {
								const o: LOpening = {
									band: bandOf(run, c - WINDOW_W / 2, c + WINDOW_W / 2),
									kind: "window",
									out: run.out,
									alongU: run.alongU,
									main: false,
								};
								if (this.freeOf(o, 40)) this.openings.push(o);
							}
							continue;
						}
						if (e.b - e.a - END_MARGIN * 2 < WINDOW_W + 40) continue;
						if (best === undefined || e.b - e.a > best.b - best.a) best = e;
					}
				}
			}
			if (best !== undefined) this.tryWindow(best, 0.5, undefined);
		}
	}

	/** the street face of cell (i, j) run along every neighbour of the same room whose front is outside too */
	frontRun(i: number, j: number): Edge {
		const id = this.at(i, j);
		const out = (k: number) => this.at(k, j) === id && this.at(k, j - 1) < 0;
		let lo = i;
		let hi = i;
		while (lo > 0 && out(lo - 1)) lo--;
		while (hi < this.nc - 1 && out(hi + 1)) hi++;
		return { alongU: true, at: this.vs[j], a: this.us[lo], b: this.us[hi + 1], out: "F" };
	}

	/** does a window open into this room? (an outside wall lies inside its cell, so the gap's middle is in the room) */
	hasWindow(room: number): boolean {
		for (const o of this.openings) {
			if (o.kind !== "window") continue;
			const cu = (o.band.u0 + o.band.u1) / 2;
			const cv = (o.band.v0 + o.band.v1) / 2;
			for (let j = 0; j < this.nr; j++) {
				if (cv < this.vs[j] || cv > this.vs[j + 1]) continue;
				for (let i = 0; i < this.nc; i++) {
					if (cu >= this.us[i] && cu <= this.us[i + 1] && this.at(i, j) === room) return true;
				}
			}
		}
		return false;
	}

	/**
	 * A window for a room that has none: the first free place on any of its outside walls (any length the window
	 * fits in, every nudge); failing that, the place with the fewest pieces in front, and those pieces go. A piece
	 * that defines the room (its bed, sofa, counter) goes only when `anyPiece` says the building needs this window
	 * to have a second way in; otherwise such a room keeps its bed and has no window, like many a real one.
	 */
	forceWindow(room: number, added: Array<LOpening>, anyPiece: boolean): void {
		const edges: Array<Edge> = [];
		for (let j = 0; j < this.nr; j++) {
			for (let i = 0; i < this.nc; i++) {
				if (this.at(i, j) !== room) continue;
				for (const s of LSIDES) {
					const e = this.edgeOf(i, j, s);
					if (e.out !== undefined) edges.push(e);
				}
			}
		}
		for (const e of edges) if (this.tryWindow(e, 0.5, added)) return;
		let best: LOpening | undefined;
		let bestCost = math.huge;
		for (const e of edges) {
			for (const nudge of WINDOW_NUDGE) {
				const o = this.cutIn(e, WINDOW_W, 0.5 + nudge, "window", false);
				if (o === undefined || !this.freeOf(o, 36)) continue;
				let cost = 0;
				for (const z of this.zonesOf(o, WINDOW_CLEAR_DEPTH, WINDOW_CLEAR_SIDE)) {
					for (const p of this.pieces) if (overlapLR(z, p)) cost += DEFINING.includes(p.kind) ? 10 : 1;
				}
				if (cost < bestCost && (anyPiece || cost < 10)) {
					bestCost = cost;
					best = o;
				}
			}
		}
		if (best === undefined) return;
		for (const z of this.zonesOf(best, WINDOW_CLEAR_DEPTH, WINDOW_CLEAR_SIDE)) {
			for (let q = this.pieces.size() - 1; q >= 0; q--) if (overlapLR(z, this.pieces[q])) this.pieces.remove(q);
		}
		this.openings.push(best);
		added.push(best);
	}

	/** windows cut while furnishing (`roomWindow`): the walls are already built, `cutWindows` cuts these out too */
	readonly late: Array<LOpening> = [];

	/**
	 * A home's room gets its window right after the piece that defines it (the bed, the sofa, the counter), before
	 * the smaller pieces: on the longest outside wall where the piece left room, and nothing is placed in front of
	 * it afterwards. So a small bedroom has its bed AND its window, and the wardrobe goes where it can.
	 */
	roomWindow(ctx: RoomCtx): void {
		if (ROOM_INFO[ctx.kind].win === 0 || this.hasWindow(ctx.id)) return;
		const edges: Array<Edge> = [];
		for (let j = 0; j < this.nr; j++) {
			for (let i = 0; i < this.nc; i++) {
				if (this.at(i, j) !== ctx.id) continue;
				for (const s of LSIDES) {
					const e = this.edgeOf(i, j, s);
					if (e.out !== undefined) edges.push(e);
				}
			}
		}
		// longest first; a total order (Luau's sort is not stable, and every machine must pick the same wall)
		edges.sort((p, q) => {
			if (p.b - p.a !== q.b - q.a) return p.b - p.a > q.b - q.a;
			if (p.alongU !== q.alongU) return p.alongU;
			if (p.at !== q.at) return p.at < q.at;
			return p.a < q.a;
		});
		for (const e of edges) {
			const n = this.late.size();
			if (!this.tryWindow(e, 0.5, this.late)) continue;
			for (const z of this.zonesOf(this.late[n], WINDOW_CLEAR_DEPTH, WINDOW_CLEAR_SIDE)) {
				this.clear.push(z);
				this.clearTight.push(z);
			}
			this.nearClear.clear();
			this.nearClearTight.clear();
			return;
		}
	}

	/**
	 * The outside wall of cell (i, j) on side s run on through the cells of the same room whose same side is outside
	 * too: a campus lecture room's side wall is one wall however many rows cut it (the window pass, EDI-17).
	 */
	sideRun(i: number, j: number, s: LSide): Edge {
		const e = this.edgeOf(i, j, s);
		if (e.out === undefined) return e;
		const id = this.at(i, j);
		const alongU = e.alongU;
		const same = (k: number) => {
			const ci = alongU ? k : i;
			const cj = alongU ? j : k;
			return this.at(ci, cj) === id && this.edgeOf(ci, cj, s).out !== undefined;
		};
		let lo = alongU ? i : j;
		let hi = lo;
		while (same(lo - 1)) lo--;
		while (same(hi + 1)) hi++;
		const line = alongU ? this.us : this.vs;
		return { alongU, at: e.at, a: line[lo], b: line[hi + 1], out: e.out };
	}

	/** a window on edge e at fraction k (nudged along if blocked); `added` collects it when walls exist already */
	tryWindow(e: Edge, k: number, added: Array<LOpening> | undefined): boolean {
		for (const nudge of WINDOW_NUDGE) {
			const o = this.cutIn(e, WINDOW_W, k + nudge, "window", false);
			if (o === undefined || !this.freeOf(o, 36)) continue;
			let blocked = false;
			for (const z of this.zonesOf(o, WINDOW_CLEAR_DEPTH, WINDOW_CLEAR_SIDE)) {
				for (const p of this.pieces) if (overlapLR(z, p)) blocked = true;
			}
			if (blocked) continue;
			this.openings.push(o);
			if (added !== undefined) added.push(o);
			return true;
		}
		return false;
	}

	/**
	 * The rest of the windows, AFTER the furniture: a real room puts the bed against a wall and the window where
	 * the wall is free, so a window only goes where nothing stands in front of it (the horde must be able to climb
	 * in, EDI-10). Each is then cut out of the wall that was already built.
	 */
	cutWindows(): void {
		const isHouse = this.inp.type === 1 || this.inp.type === 2;
		// the campus's rooms span the rows its notches cut (EDI-17): each of their outside walls is taken whole
		const campus = this.inp.type >= 12 && this.inp.type <= 15;
		const runs: Array<string> = [];
		// the windows the rooms took while being furnished are cut out of the walls with these
		const added: Array<LOpening> = [...this.late];
		for (let j = 0; j < this.nr; j++) {
			for (let i = 0; i < this.nc; i++) {
				const room = this.at(i, j);
				if (room < 0) continue;
				const info = ROOM_INFO[this.kinds[room]];
				if (info.win === 0) continue;
				for (const s of LSIDES) {
					const e = campus ? this.sideRun(i, j, s) : this.edgeOf(i, j, s);
					// a shop's front row is done; its side walls get a window where the wall is free
					if (e.out === undefined || (info.win === 2 && s === "F")) continue;
					if (campus) {
						const key = `${s}:${e.at}:${e.a}`;
						if (runs.includes(key)) continue;
						runs.push(key);
					}
					const len = e.b - e.a - END_MARGIN * 2;
					if (len < WINDOW_W + 40) continue;
					// "not every wall": a house keeps a side window two times in three
					if (isHouse && (s === "L" || s === "R") && this.rng.chance(0.34)) continue;
					const n = math.max(1, math.floor(len / 250));
					// the middle of its share of the wall, or a little to either side if a piece stands there
					for (let q = 0; q < n; q++) this.tryWindow(e, (q + 0.5) / n, added);
				}
			}
		}
		// every room that has windows gets one (EDI-10), and so no building is ever a single way in (EDI-09): a room
		// the pass above left without (its only outside wall was a skipped side, or pieces stood along it) takes the
		// first free stretch of any of its outside walls -- and when there is none, the piece in front of the best
		// one goes (a bookcase gives way to the window, never the other way round)
		for (let room = 0; room < this.kinds.size(); room++) {
			if (ROOM_INFO[this.kinds[room]].win === 0 || this.hasWindow(room)) continue;
			this.forceWindow(room, added, false);
		}
		// and never a single way in (EDI-09): with one door and no window yet, the biggest room with windows gets
		// one even if its bed or its sofa has to go
		let exits = 0;
		for (const o of this.openings) if (o.kind !== "inner") exits++;
		if (exits < 2) {
			let best = -1;
			let area = -1;
			for (let room = 0; room < this.kinds.size(); room++) {
				if (ROOM_INFO[this.kinds[room]].win === 0) continue;
				let a = 0;
				for (let j = 0; j < this.nr; j++) {
					for (let i = 0; i < this.nc; i++) {
						if (this.at(i, j) === room) a += (this.us[i + 1] - this.us[i]) * (this.vs[j + 1] - this.vs[j]);
					}
				}
				if (a > area) {
					area = a;
					best = room;
				}
			}
			if (best >= 0) this.forceWindow(best, added, true);
		}
		if (added.size() === 0) return;
		const kept: Array<{ r: LR; inner: boolean }> = [];
		for (const w of this.walls) {
			let pieces: Array<LR> = [w.r];
			for (const o of added) pieces = subtract(pieces, [o.band], o.alongU);
			for (const p of pieces) {
				if (p.u1 - p.u0 >= 2 && p.v1 - p.v0 >= 2) kept.push({ r: p, inner: w.inner });
			}
		}
		this.walls.clear();
		for (const w of kept) this.walls.push(w);
	}

	// ------------------------------------------------------------------------------------ walls

	buildWalls(): void {
		const extH: Array<LR> = [];
		const extV: Array<LR> = [];
		const inH: Array<LR> = [];
		const inV: Array<LR> = [];
		// exterior edges, merged per line and side; interior edges merged per line
		const runs = new Map<string, Array<[number, number, Edge]>>();
		const push = (key: string, e: Edge) => {
			let list = runs.get(key);
			if (list === undefined) {
				list = [];
				runs.set(key, list);
			}
			list.push([e.a, e.b, e]);
		};
		for (let j = 0; j < this.nr; j++) {
			for (let i = 0; i < this.nc; i++) {
				const id = this.at(i, j);
				if (id < 0) continue;
				for (const s of LSIDES) {
					const e = this.edgeOf(i, j, s);
					if (e.out !== undefined) {
						push(`x${e.out}${e.at}`, e);
						continue;
					}
					// an interior edge once, from its low side
					if (s !== "R" && s !== "K") continue;
					const other = this.at(i + (s === "R" ? 1 : 0), j + (s === "K" ? 1 : 0));
					if (other === id) continue;
					push(`i${e.alongU ? "h" : "v"}${e.at}`, e);
				}
			}
		}
		const keys: Array<string> = [];
		for (const [k] of runs) keys.push(k);
		keys.sort();
		for (const k of keys) {
			const list = runs.get(k) as Array<[number, number, Edge]>;
			list.sort((p, q) => p[0] < q[0]);
			let a = list[0][0];
			let b = list[0][1];
			const e0 = list[0][2];
			const flush = () => {
				if (e0.out !== undefined) {
					(e0.alongU ? extH : extV).push(bandOf(e0, a, b));
				} else if (e0.alongU) {
					inH.push(bandOf(e0, a - TI / 2, b + TI / 2));
				} else {
					inV.push(bandOf(e0, a - TI / 2, b + TI / 2));
				}
			};
			for (let n = 1; n < list.size(); n++) {
				const [na, nb] = list[n];
				if (na <= b + 0.5) {
					b = math.max(b, nb);
				} else {
					flush();
					a = na;
					b = nb;
				}
			}
			flush();
		}
		// posts in the inner corner of every notch (where exactly three of the four cells are inside)
		const posts: Array<LR> = [];
		for (let j = 1; j < this.nr; j++) {
			for (let i = 1; i < this.nc; i++) {
				const nw = this.at(i - 1, j - 1) >= 0;
				const ne = this.at(i, j - 1) >= 0;
				const sw = this.at(i - 1, j) >= 0;
				const se = this.at(i, j) >= 0;
				const n = (nw ? 1 : 0) + (ne ? 1 : 0) + (sw ? 1 : 0) + (se ? 1 : 0);
				if (n !== 3) continue;
				const u = this.us[i];
				const v = this.vs[j];
				// the post sits in the cell diagonally opposite the empty one
				const east = !nw || !sw;
				const south = !nw || !ne;
				posts.push(lr(east ? u : u - T, east ? u + T : u, south ? v : v - T, south ? v + T : v));
			}
		}
		const vRest = subtract(extV, extH, false);
		const solidExt: Array<LR> = [...extH, ...vRest, ...posts];
		let h = subtract(inH, solidExt, true);
		const hInside: Array<LR> = [];
		for (const p of h) if (this.inside((p.u0 + p.u1) / 2, (p.v0 + p.v1) / 2)) hInside.push(p);
		h = hInside;
		let v = subtract(inV, [...solidExt, ...h], false);
		const vInside: Array<LR> = [];
		for (const p of v) if (this.inside((p.u0 + p.u1) / 2, (p.v0 + p.v1) / 2)) vInside.push(p);
		v = vInside;
		const bands: Array<LR> = [];
		for (const o of this.openings) bands.push(o.band);
		const emit = (list: Array<LR>, alongU: boolean, inner: boolean) => {
			for (const p of subtract(list, bands, alongU)) {
				if (p.u1 - p.u0 < 2 || p.v1 - p.v0 < 2) continue;
				this.walls.push({ r: p, inner });
			}
		};
		emit(extH, true, false);
		emit(vRest, false, false);
		emit(posts, true, false);
		emit(h, true, true);
		emit(v, false, true);
	}

	inside(u: number, v: number): boolean {
		for (let i = 0; i < this.nc; i++) {
			if (u < this.us[i] || u > this.us[i + 1]) continue;
			for (let j = 0; j < this.nr; j++) {
				if (v < this.vs[j] || v > this.vs[j + 1]) continue;
				if (this.at(i, j) >= 0) return true;
			}
		}
		return false;
	}

	// ------------------------------------------------------------------------------------ footprint and rooms

	/** cells with `keep(i, j)` merged into non-overlapping rects: row runs, stacked when identical */
	merged(keep: (i: number, j: number) => boolean): Array<LR> {
		const out: Array<LR> = [];
		const open: Array<{ a: number; b: number; r: LR }> = [];
		for (let j = 0; j < this.nr; j++) {
			const row: Array<{ a: number; b: number }> = [];
			let i = 0;
			while (i < this.nc) {
				if (!keep(i, j)) {
					i++;
					continue;
				}
				let k = i;
				while (k + 1 < this.nc && keep(k + 1, j)) k++;
				row.push({ a: i, b: k });
				i = k + 1;
			}
			const still: Array<{ a: number; b: number; r: LR }> = [];
			for (const run of row) {
				let grown = false;
				for (let q = 0; q < open.size(); q++) {
					const o = open[q];
					if (o.a === run.a && o.b === run.b) {
						o.r.v1 = this.vs[j + 1];
						still.push(o);
						open.remove(q);
						grown = true;
						break;
					}
				}
				if (!grown) {
					still.push({
						a: run.a,
						b: run.b,
						r: lr(this.us[run.a], this.us[run.b + 1], this.vs[j], this.vs[j + 1]),
					});
				}
			}
			for (const o of open) out.push(o.r);
			open.clear();
			for (const o of still) open.push(o);
		}
		for (const o of open) out.push(o.r);
		return out;
	}

	// ------------------------------------------------------------------------------------ furnishing

	roomCtx(id: number): RoomCtx {
		const ctx: RoomCtx = { id, kind: this.kinds[id], cells: [] };
		for (let j = 0; j < this.nr; j++) {
			for (let i = 0; i < this.nc; i++) {
				if (this.at(i, j) !== id) continue;
				const inset: Record<LSide, number> = { F: 0, K: 0, L: 0, R: 0 };
				for (const s of LSIDES) {
					const e = this.edgeOf(i, j, s);
					if (e.out !== undefined) {
						inset[s] = T;
					} else {
						const other = this.at(
							i + (s === "L" ? -1 : s === "R" ? 1 : 0),
							j + (s === "F" ? -1 : s === "K" ? 1 : 0),
						);
						inset[s] = other === id ? 0 : TI / 2;
					}
				}
				const inner = lr(
					this.us[i] + inset.L,
					this.us[i + 1] - inset.R,
					this.vs[j] + inset.F,
					this.vs[j + 1] - inset.K,
				);
				const walls: Array<{ side: LSide; seg: LR }> = [];
				for (const s of LSIDES) {
					if (inset[s] === 0) continue;
					walls.push({ side: s, seg: inner });
				}
				ctx.cells.push({ inner, walls });
			}
		}
		// a room whose cells fill a rectangle is one floor for the free-standing pieces (a shop's sales floor)
		let i0 = this.nc;
		let i1 = -1;
		let j0 = this.nr;
		let j1 = -1;
		for (let j = 0; j < this.nr; j++) {
			for (let i = 0; i < this.nc; i++) {
				if (this.at(i, j) !== id) continue;
				i0 = math.min(i0, i);
				i1 = math.max(i1, i);
				j0 = math.min(j0, j);
				j1 = math.max(j1, j);
			}
		}
		if (ctx.cells.size() > 1 && (i1 - i0 + 1) * (j1 - j0 + 1) === ctx.cells.size()) {
			let u0 = -math.huge;
			let u1 = math.huge;
			let v0 = -math.huge;
			let v1 = math.huge;
			for (const c of ctx.cells) {
				u0 = math.max(u0, c.inner.u0 < this.us[i0] + T + 1 ? c.inner.u0 : -math.huge);
				u1 = math.min(u1, c.inner.u1 > this.us[i1 + 1] - T - 1 ? c.inner.u1 : math.huge);
				v0 = math.max(v0, c.inner.v0 < this.vs[j0] + T + 1 ? c.inner.v0 : -math.huge);
				v1 = math.min(v1, c.inner.v1 > this.vs[j1 + 1] - T - 1 ? c.inner.v1 : math.huge);
			}
			ctx.whole = lr(u0, u1, v0, v1);
		}
		return ctx;
	}

	/** keep-clear zones in front of every doorway and of the first windows (the rest go where the wall is free) */
	clearZones(): void {
		for (const o of this.openings) {
			const win = o.kind === "window";
			const depth = win ? WINDOW_CLEAR_DEPTH : CLEAR_DEPTH;
			for (const z of this.zonesOf(o, depth, win ? WINDOW_CLEAR_SIDE : CLEAR_SIDE)) this.clear.push(z);
			for (const z of this.zonesOf(o, depth, 0)) this.clearTight.push(z);
		}
	}

	/**
	 * Can a piece go here? Inside the room, clear of every opening's zone, and against every other obstacle
	 * (wall, post, piece) either sealed off (closer than any body, SEALED) or at least PATH away: no gap a single
	 * body could squeeze into and be cornered in, no aisle too narrow for two (EDI-11). An island keeps PATH from
	 * everything. `tight`: the zones in front of the openings are exactly as wide as the openings (the side margins
	 * may be used), for the one piece a small room of many doorways must still get (a kitchen's fridge).
	 */
	fits(p: LR, room: LR, island: boolean, tight = false): boolean {
		if (p.u0 < room.u0 - 0.5 || p.u1 > room.u1 + 0.5 || p.v0 < room.v0 - 0.5 || p.v1 > room.v1 + 0.5) return false;
		for (const c of this.clearNear(room, tight)) if (overlapLR(p, c)) return false;
		for (const w of this.wallsNear(room)) {
			if (overlapLR(p, w)) return false;
			if (island ? gapLR(p, w) < PATH : narrowBetween(p, w, NOOK)) return false;
		}
		for (const q of this.pieces) {
			// a piece PATH away or more on either axis can neither overlap nor pinch (cheap reject)
			if (q.u0 - p.u1 >= PATH || p.u0 - q.u1 >= PATH || q.v0 - p.v1 >= PATH || p.v0 - q.v1 >= PATH) continue;
			if (overlapLR(p, q)) return false;
			if (island ? gapLR(p, q) < PATH : narrowBetween(p, q, 0)) return false;
		}
		if (island) {
			// and PATH from the room's own edges (a room of several cells has no wall between them)
			if (p.u0 - room.u0 < PATH && p.u0 - room.u0 > 0.5) return false;
			if (room.u1 - p.u1 < PATH && room.u1 - p.u1 > 0.5) return false;
			if (p.v0 - room.v0 < PATH && p.v0 - room.v0 > 0.5) return false;
			if (room.v1 - p.v1 < PATH && room.v1 - p.v1 > 0.5) return false;
		}
		return true;
	}

	/** the zones of `clear` / `clearTight` that reach a room's floor rect, per rect (a new zone empties both) */
	private readonly nearClear = new Map<LR, Array<LR>>();
	private readonly nearClearTight = new Map<LR, Array<LR>>();

	clearNear(room: LR, tight: boolean): Array<LR> {
		const cache = tight ? this.nearClearTight : this.nearClear;
		let list = cache.get(room);
		if (list === undefined) {
			list = [];
			// `fits` keeps a piece within half a unit of its room: a zone further off cannot overlap it
			for (const c of tight ? this.clearTight : this.clear) {
				if (c.u0 > room.u1 + 0.5 || c.u1 < room.u0 - 0.5 || c.v0 > room.v1 + 0.5 || c.v1 < room.v0 - 0.5) {
					continue;
				}
				list.push(c);
			}
			cache.set(room, list);
		}
		return list;
	}

	/** the walls within PATH of a room's floor rect (`fits` looks at no other), per rect, while furnishing */
	private readonly nearWalls = new Map<LR, Array<LR>>();

	wallsNear(room: LR): Array<LR> {
		let list = this.nearWalls.get(room);
		if (list === undefined) {
			list = [];
			for (const w of this.walls) {
				const r = w.r;
				if (r.u0 - room.u1 >= PATH || room.u0 - r.u1 >= PATH) continue;
				if (r.v0 - room.v1 >= PATH || room.v0 - r.v1 >= PATH) continue;
				list.push(r);
			}
			this.nearWalls.set(room, list);
		}
		return list;
	}

	/** a piece of `len` × `depth` with its back against a wall of the room; answers whether it went in */
	againstWall(
		ctx: RoomCtx,
		kind: FurnitureKind,
		len: number,
		depth: number,
		prefer?: LSide,
		only = false,
		tight = false,
	): boolean {
		const order: Array<LSide> = [];
		if (prefer !== undefined) order.push(prefer);
		const start = this.rng.int(0, 3);
		for (let k = 0; k < 4 && !only; k++) {
			const s = LSIDES[(start + k) % 4];
			if (s !== prefer) order.push(s);
		}
		for (const s of order) {
			for (const c of ctx.cells) {
				let has = false;
				for (const w of c.walls) if (w.side === s) has = true;
				if (!has) continue;
				const r = c.inner;
				const alongU = s === "F" || s === "K";
				const lo = alongU ? r.u0 : r.v0;
				const hi = alongU ? r.u1 : r.v1;
				if (hi - lo < len) continue;
				// corners first, then the middle, then a walk along the wall
				const tries: Array<number> = [lo, hi - len, (lo + hi - len) / 2];
				for (let t = lo + 24; t < hi - len; t += 32) tries.push(t);
				for (const t0 of tries) {
					const t = math.floor(t0);
					let p: LR;
					if (s === "F") p = lr(t, t + len, r.v0, r.v0 + depth);
					else if (s === "K") p = lr(t, t + len, r.v1 - depth, r.v1);
					else if (s === "L") p = lr(r.u0, r.u0 + depth, t, t + len);
					else p = lr(r.u1 - depth, r.u1, t, t + len);
					if (!this.fits(p, r, false, tight)) continue;
					this.place(ctx, p, kind, flip(s));
					return true;
				}
			}
		}
		return false;
	}

	/** a free-standing piece near the middle of the room's biggest cell; `alongU` says which way it lies */
	island(ctx: RoomCtx, kind: FurnitureKind, len: number, depth: number, alongU: boolean, du = 0, dv = 0): boolean {
		const c = biggest(ctx);
		const r = c.inner;
		const w = alongU ? len : depth;
		const h = alongU ? depth : len;
		const cu = (r.u0 + r.u1) / 2 + du;
		const cv = (r.v0 + r.v1) / 2 + dv;
		for (const [ou, ov] of ISLAND_OFFSETS) {
			const p = lr(
				math.floor(cu + ou - w / 2),
				math.floor(cu + ou + w / 2),
				math.floor(cv + ov - h / 2),
				math.floor(cv + ov + h / 2),
			);
			if (!this.fits(p, r, true)) continue;
			this.place(ctx, p, kind, alongU ? "F" : "L");
			return true;
		}
		return false;
	}

	place(ctx: RoomCtx, p: LR, kind: FurnitureKind, face: LSide): void {
		const info = PIECES[kind];
		const piece: LPiece = { ...p, kind, low: info.low, face, loot: info.loot, room: ctx.id };
		this.pieces.push(piece);
	}

	/**
	 * Free-standing pieces in a grid over the band [vFrom, vTo] (shares of the biggest cell's depth): as many as fit
	 * with `gap` between them and the walls, at most cols × rows, spread evenly. `alongU`: the piece's long side
	 * runs along u. Answers how many went in.
	 */
	grid(
		ctx: RoomCtx,
		kind: FurnitureKind,
		len: number,
		depth: number,
		alongU: boolean,
		maxCols: number,
		maxRows: number,
		vFrom: number,
		vTo: number,
		gap: number,
		cell?: LR,
	): number {
		const r = cell ?? biggest(ctx).inner;
		const pw = alongU ? len : depth;
		const ph = alongU ? depth : len;
		const W = r.u1 - r.u0;
		const v0 = r.v0 + (r.v1 - r.v0) * vFrom;
		const v1 = r.v0 + (r.v1 - r.v0) * vTo;
		const cols = math.min(maxCols, math.floor((W - gap) / (pw + gap)));
		const rows = math.min(maxRows, math.floor((v1 - v0 - gap) / (ph + gap)));
		if (cols < 1 || rows < 1) return 0;
		const su = (W - cols * pw) / (cols + 1);
		const sv = (v1 - v0 - rows * ph) / (rows + 1);
		let n = 0;
		for (let j = 0; j < rows; j++) {
			for (let i = 0; i < cols; i++) {
				const u = math.floor(r.u0 + su + i * (pw + su));
				const v = math.floor(v0 + sv + j * (ph + sv));
				const p = lr(u, u + pw, v, v + ph);
				if (!this.fits(p, r, true)) continue;
				this.place(ctx, p, kind, "F");
				n++;
			}
		}
		return n;
	}

	/**
	 * A sales floor: checkouts just inside the front, then gondolas behind them with aisles wider than two bodies,
	 * laid along the floor's longer free side (a deep supermarket gets rows across it, a shallow corner shop columns).
	 */
	aisles(ctx: RoomCtx, kind: FurnitureKind, depth: number): void {
		const r = biggest(ctx).inner;
		const W = r.u1 - r.u0;
		const H = r.v1 - r.v0;
		const aisle = H > 500 ? PATH + 16 : PATH;
		// the checkouts: at the front of a side wall (the till by the door), or free-standing on a big floor
		if (!this.againstWall(ctx, "checkout", 96, 44, "L", true)) this.againstWall(ctx, "checkout", 96, 44, "R", true);
		if (H > 500) {
			for (const du of CHECKOUT_AT) {
				this.island(ctx, "checkout", 96, 44, false, du * W, -H / 2 + CLEAR_DEPTH + 40);
			}
		}
		// gondolas: columns running from the front aisle to the back aisle, or rows when the floor is too shallow;
		// a big floor keeps a band at the front for its free-standing checkouts
		const front = H > 500 ? CLEAR_DEPTH + 150 : 0;
		const len = math.min(340, H - front - 2 * aisle);
		if (len >= 100 && this.grid(ctx, kind, len, depth, false, 6, 1, front / H, 1, aisle) > 0) return;
		const row = math.min(420, W - 2 * aisle);
		if (row >= 120) this.grid(ctx, kind, row, depth, true, 2, 4, front / H, 1, aisle);
	}

	decorAt(kind: DecorKind, u: number, v: number, w: number, h: number, rot: number): void {
		const d: LDecor = { ...lr(u - w / 2, u + w / 2, v - h / 2, v + h / 2), kind, rot };
		this.decor.push(d);
	}

	/** the loot spot in front of a piece: LOOT_FRONT into the room from the middle of its front */
	lootSpot(p: LPiece): { u: number; v: number } {
		const cu = (p.u0 + p.u1) / 2;
		const cv = (p.v0 + p.v1) / 2;
		const d = LOOT_FRONT;
		if (p.face === "F") return { u: cu, v: p.v0 - d };
		if (p.face === "K") return { u: cu, v: p.v1 + d };
		if (p.face === "L") return { u: p.u0 - d, v: cv };
		return { u: p.u1 + d, v: cv };
	}

	// ------------------------------------------------------------------------------------ no pockets

	/** the reach grid of the last `removePockets` (world, the town's 8-unit grid; its cells are the module's) */
	private gx0 = 0;
	private gy0 = 0;
	private gcols = 0;
	private grows = 0;
	/**
	 * The generations this planner's last `removePockets` marked the module's grids with: a cell is inside the
	 * footprint when P_INSIDE holds `insideGen`; P_MARK holds `blockedGen` on a cell a wall or piece blocks and
	 * `seenGen` on one the survivor's flood reached. Anything older is a free cell nobody reached.
	 */
	private insideGen = 0;
	private blockedGen = 0;
	private seenGen = 0;
	/** inside cells that `stampBody` blocked since the last try began */
	private insideBlocked = 0;

	/**
	 * EDI-11 (no safe spot) and CID-05 (no sealed pocket), checked the way tools/validate-world.mjs checks them.
	 *
	 * 1. The survivor: on the town's own 8-unit grid, a survivor (radius 18) can stand on a cell when its centre is
	 *    18 clear of every wall and piece, and walks from cell to cell (4 neighbours). From the main door, every
	 *    cell inside the footprint a survivor can stand on must be reached.
	 * 2. The horde (`hordePocket`): every such cell must also be reachable the way the horde really walks -- its
	 *    flow field of 32 u cells with every obstacle grown 4 u (server/sim/flowField.ts), from outside, and then a
	 *    straight chase down a clear line (zombieBrain's DIRECT_CHASE). A slot a survivor squeezes through can be
	 *    too narrow for the field; what lies behind it would be a safe spot (review of ea5cf71).
	 *
	 * The local rules of `fits` keep the paths two bodies wide, but they cannot see every pocket two pieces close off
	 * with a wall: the piece nearest such a pocket, the latest placed first, comes out again, until there is none.
	 *
	 * Cost: the town plans ~150 buildings at every world start on the server and on every client (~900,000 cells
	 * of this grid per town), so nothing here clears a grid. The grids are module scratch, grown once and never
	 * freed; a cell holds the generation that last marked it (P_GEN only grows, so an older mark reads as free);
	 * the border ring is marked blocked, so the flood needs no bounds check; the inside cells are counted, and the
	 * cells blocked among them while stamping, so the grid is only searched for a pocket when the flood came up
	 * short of the count.
	 */
	removePockets(): void {
		const r = this.inp.rect;
		const C = POCKET_CELL;
		const R = BODY;
		// one cell of border all round the footprint's box: blocked, so the flood needs no bounds check
		const gx0 = math.floor(r.x / C) * C - C;
		const gy0 = math.floor(r.y / C) * C - C;
		const cols = math.ceil((r.x + r.w - gx0) / C) + 1;
		const rows = math.ceil((r.y + r.h - gy0) / C) + 1;
		this.gx0 = gx0;
		this.gy0 = gy0;
		this.gcols = cols;
		this.grows = rows;
		const n = cols * rows;
		growTo(P_INSIDE, n);
		growTo(P_MARK, n);
		growTo(P_QUEUE, n);
		const inside = P_INSIDE;
		const mark = P_MARK;
		const queue = P_QUEUE;
		// the inside mask, part by part: a cell is inside when its centre lies in a part (edges included)
		P_GEN++;
		const ig = P_GEN;
		this.insideGen = ig;
		let insideCount = 0;
		for (const lp of this.merged((i, j) => this.at(i, j) >= 0)) {
			const p = this.f.rect(lp);
			const i0 = math.max(0, math.ceil((p.x - gx0 - C / 2) / C));
			const i1 = math.min(cols - 1, math.floor((p.x + p.w - gx0 - C / 2) / C));
			const j0 = math.max(0, math.ceil((p.y - gy0 - C / 2) / C));
			const j1 = math.min(rows - 1, math.floor((p.y + p.h - gy0 - C / 2) / C));
			for (let j = j0; j <= j1; j++) {
				for (let i = i0; i <= i1; i++) {
					const k = j * cols + i;
					if (inside[k] !== ig) {
						inside[k] = ig;
						insideCount++;
					}
				}
			}
		}
		const walls: Array<Rect> = [];
		for (const w of this.walls) walls.push(this.f.rect(w.r));
		let seedX = 0;
		let seedY = 0;
		for (const o of this.openings) {
			if (!o.main) continue;
			const q = this.f.rect(o.band);
			seedX = q.x + q.w / 2;
			seedY = q.y + q.h / 2;
		}
		const pieces: Array<Rect> = [];
		for (let iter = 0; iter < POCKET_TRIES; iter++) {
			// this try's blocked cells, under a new generation: the walls, the border ring, the pieces
			P_GEN++;
			const bg = P_GEN;
			this.blockedGen = bg;
			this.insideBlocked = 0;
			for (const w of walls) this.stampBody(w, R);
			for (let i = 0; i < cols; i++) {
				mark[i] = bg;
				mark[(rows - 1) * cols + i] = bg;
			}
			for (let j = 0; j < rows; j++) {
				mark[j * cols] = bg;
				mark[j * cols + cols - 1] = bg;
			}
			pieces.clear();
			for (const p of this.pieces) pieces.push(this.f.rect(p));
			for (const p of pieces) this.stampBody(p, R);
			// the survivor's flood from the main door: a cell is free and not yet reached when its mark is older than bg
			P_GEN++;
			const gen = P_GEN;
			this.seenGen = gen;
			let tail = 0;
			let reachedInside = 0;
			const s0 = this.cellAt(seedX, seedY);
			if (s0 >= 0 && mark[s0] < bg) {
				mark[s0] = gen;
				queue[tail] = s0;
				tail++;
			}
			let head = 0;
			while (head < tail) {
				const k = queue[head];
				head++;
				if (inside[k] === ig) reachedInside++;
				// the four neighbours, inline and unchecked (the border ring is blocked): every cell of every building
				if (mark[k - 1] < bg) {
					mark[k - 1] = gen;
					queue[tail] = k - 1;
					tail++;
				}
				if (mark[k + 1] < bg) {
					mark[k + 1] = gen;
					queue[tail] = k + 1;
					tail++;
				}
				if (mark[k - cols] < bg) {
					mark[k - cols] = gen;
					queue[tail] = k - cols;
					tail++;
				}
				if (mark[k + cols] < bg) {
					mark[k + cols] = gen;
					queue[tail] = k + cols;
					tail++;
				}
			}
			// a pocket: an inside cell neither blocked nor reached (looked for only when the counts say there is one)
			let pocket = -1;
			if (reachedInside < insideCount - this.insideBlocked) {
				for (let k = 0; k < n && pocket < 0; k++) {
					if (inside[k] === ig && mark[k] < bg) pocket = k;
				}
			}
			if (pocket < 0) pocket = this.hordePocket(walls, pieces);
			if (pocket < 0) return;
			const px = gx0 + (pocket % cols) * C + C / 2;
			const py = gy0 + math.floor(pocket / cols) * C + C / 2;
			// the piece closing it off: the latest placed near it, else the nearest one at all
			let culprit = -1;
			let nearest = -1;
			let nearestD = math.huge;
			for (let k = pieces.size() - 1; k >= 0; k--) {
				const b = pieces[k];
				const dx = math.max(b.x - px, 0, px - b.x - b.w);
				const dy = math.max(b.y - py, 0, py - b.y - b.h);
				const d2 = dx * dx + dy * dy;
				if (culprit < 0 && d2 < (R + C * 2) * (R + C * 2)) culprit = k;
				if (d2 < nearestD) {
					nearestD = d2;
					nearest = k;
				}
			}
			if (culprit < 0) culprit = nearest;
			// a pocket that only walls make: nothing to take out (tools/validate-world.mjs names it)
			if (culprit < 0) return;
			this.pieces.remove(culprit);
		}
	}

	/**
	 * The horde's side of EDI-11, on the last survivor flood: the first cell a survivor stands on inside (8 u grid,
	 * reached from the door) that no zombie gets to, or -1. The flow field is rebuilt here as the server builds it --
	 * world-aligned 32 u cells, every wall and piece grown by FIELD_INFLATE, 8 neighbours, no corner cut past a
	 * blocked cell -- and flooded from every free cell outside the footprint (a window is a gap: the field crosses
	 * it). A spot is reached when its own field cell is, or when a reached cell lies within DIRECT_REACH with a clear
	 * straight line to it (the chase's last stretch goes straight, not by the field).
	 *
	 * One array holds the field (F_MARK: `hard` on a blocked cell, `gen` on a reached one, older = free, unreached).
	 * Only the spots under a field cell the field did not reach are searched, and the spots of one field cell
	 * usually get through by the same neighbour: the last one that let a spot of the cell through is tried first,
	 * with only the walls and pieces near the cell when the neighbour is next to it. All of that only saves work: a
	 * spot is reached when ANY neighbour lets it through, so the answer is the one the full search gives.
	 */
	private hordePocket(walls: Array<Rect>, pieces: Array<Rect>): number {
		const r = this.inp.rect;
		const FC = FIELD_CELL;
		const M = FC * 2;
		const fx0 = math.floor((r.x - M) / FC) * FC;
		const fy0 = math.floor((r.y - M) / FC) * FC;
		const fcols = math.ceil((r.x + r.w + M - fx0) / FC);
		const frows = math.ceil((r.y + r.h + M - fy0) / FC);
		const fn = fcols * frows;
		growTo(F_MARK, fn);
		growTo(F_QUEUE, fn);
		const fmark = F_MARK;
		const queue = F_QUEUE;
		const nWalls = walls.size();
		const nRects = nWalls + pieces.size();
		P_GEN++;
		const hard = P_GEN;
		for (let q = 0; q < nRects; q++) {
			const s = q < nWalls ? walls[q] : pieces[q - nWalls];
			const i0 = math.max(0, math.floor((s.x - FIELD_INFLATE - fx0) / FC));
			const j0 = math.max(0, math.floor((s.y - FIELD_INFLATE - fy0) / FC));
			const i1 = math.min(fcols - 1, math.floor((s.x + s.w + FIELD_INFLATE - fx0) / FC));
			const j1 = math.min(frows - 1, math.floor((s.y + s.h + FIELD_INFLATE - fy0) / FC));
			for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fmark[j * fcols + i] = hard;
		}
		P_GEN++;
		const gen = P_GEN;
		let tail = 0;
		for (let j = 0; j < frows; j++) {
			const cy = fy0 + j * FC + FC / 2;
			for (let i = 0; i < fcols; i++) {
				const k = j * fcols + i;
				if (fmark[k] === hard || this.insideWorld(fx0 + i * FC + FC / 2, cy)) continue;
				fmark[k] = gen;
				queue[tail] = k;
				tail++;
			}
		}
		let head = 0;
		while (head < tail) {
			const k = queue[head];
			head++;
			const ci = k % fcols;
			const cj = (k - ci) / fcols;
			for (let dj = -1; dj <= 1; dj++) {
				const nj = cj + dj;
				if (nj < 0 || nj >= frows) continue;
				for (let di = -1; di <= 1; di++) {
					const ni = ci + di;
					if ((di === 0 && dj === 0) || ni < 0 || ni >= fcols) continue;
					const nk = nj * fcols + ni;
					// free and not reached yet: older than `hard` (this call's marks are hard, then gen)
					if (fmark[nk] >= hard) continue;
					if (di !== 0 && dj !== 0 && (fmark[cj * fcols + ni] === hard || fmark[nj * fcols + ci] === hard)) {
						continue;
					}
					fmark[nk] = gen;
					queue[tail] = nk;
					tail++;
				}
			}
		}
		// every spot of the survivor's flood (inside, standable, reached from the door): the horde must reach it too.
		// Only under the field cells the field did not reach: the 8 u grid and the field are both aligned on 8 u, so
		// a field cell is 4 × 4 cells of the 8 u grid. One field row covers whole rows of the 8 u grid, so the first
		// spot that fails in a field row is the first in the 8 u grid's order (the one this returns)
		const C = POCKET_CELL;
		const per = FC / C;
		const cols = this.gcols;
		const rows = this.grows;
		const ig = this.insideGen;
		const sg = this.seenGen;
		const inside = P_INSIDE;
		const mark = P_MARK;
		const near = F_NEAR;
		const gx0 = this.gx0;
		const gy0 = this.gy0;
		// whole numbers: both origins are multiples of 8 (math.floor of a coordinate, times the cell)
		const offI = (gx0 - fx0) / C;
		const offJ = (gy0 - fy0) / C;
		const RING = math.ceil(DIRECT_REACH / FC);
		const reach2 = DIRECT_REACH * DIRECT_REACH;
		for (let fj = 0; fj < frows; fj++) {
			const j0 = math.max(0, fj * per - offJ);
			const j1 = math.min(rows - 1, fj * per - offJ + per - 1);
			if (j0 > j1) continue;
			let first = -1;
			for (let fi = 0; fi < fcols; fi++) {
				const fk = fj * fcols + fi;
				if (fmark[fk] === gen) continue;
				const i0 = math.max(0, fi * per - offI);
				const i1 = math.min(cols - 1, fi * per - offI + per - 1);
				if (i0 > i1) continue;
				// the walls and pieces a line to a neighbouring cell can cross (it stays in the 3 × 3 cells around)
				let nearReady = false;
				// the reached cell that let the last spot of this cell through: the next spot tries it first
				let good = -1;
				for (let j = j0; j <= j1; j++) {
					const py = gy0 + j * C + C / 2;
					for (let i = i0; i <= i1; i++) {
						const k = j * cols + i;
						if (inside[k] !== ig || mark[k] !== sg || (first >= 0 && k > first)) continue;
						if (!nearReady) {
							nearReady = true;
							const bx0 = fx0 + (fi - 1) * FC;
							const bx1 = fx0 + (fi + 2) * FC;
							const by0 = fy0 + (fj - 1) * FC;
							const by1 = fy0 + (fj + 2) * FC;
							near.clear();
							for (let q = 0; q < nRects; q++) {
								const s = q < nWalls ? walls[q] : pieces[q - nWalls];
								if (s.x > bx1 || s.x + s.w < bx0 || s.y > by1 || s.y + s.h < by0) continue;
								near.push(s);
							}
						}
						const px = gx0 + i * C + C / 2;
						let ok = false;
						for (let ring = good >= 0 ? 0 : 1; ring <= RING && !ok; ring++) {
							for (let dj = -ring; dj <= ring && !ok; dj++) {
								for (let di = -ring; di <= ring && !ok; di++) {
									// ring 0: the last good neighbour, before the rings are searched in order
									let ni = fi + di;
									let nj = fj + dj;
									if (ring === 0) {
										ni = good % fcols;
										nj = (good - ni) / fcols;
									} else if (math.max(math.abs(di), math.abs(dj)) !== ring) {
										continue;
									}
									if (ni < 0 || nj < 0 || ni >= fcols || nj >= frows) continue;
									const nk = nj * fcols + ni;
									if (fmark[nk] !== gen) continue;
									const cx = fx0 + ni * FC + FC / 2;
									const cy = fy0 + nj * FC + FC / 2;
									if ((cx - px) * (cx - px) + (cy - py) * (cy - py) > reach2) continue;
									const close = math.abs(ni - fi) <= 1 && math.abs(nj - fj) <= 1;
									if (
										close
											? segmentFree(cx, cy, px, py, near)
											: segmentFree(cx, cy, px, py, walls) && segmentFree(cx, cy, px, py, pieces)
									) {
										ok = true;
										good = nk;
									}
								}
							}
						}
						if (!ok) first = k;
					}
				}
			}
			if (first >= 0) return first;
		}
		return -1;
	}

	/** is the world point (x, y) inside the footprint (the inside mask of the last `removePockets`)? */
	private insideWorld(x: number, y: number): boolean {
		const k = this.cellAt(x, y);
		return k >= 0 && P_INSIDE[k] === this.insideGen;
	}

	private cellAt(x: number, y: number): number {
		const i = math.floor((x - this.gx0) / POCKET_CELL);
		const j = math.floor((y - this.gy0) / POCKET_CELL);
		if (i < 0 || j < 0 || i >= this.gcols || j >= this.grows) return -1;
		return j * this.gcols + i;
	}

	/** marks blocked (this try's generation) the cells whose centre is closer than `R` to the world rect `w` */
	private stampBody(w: Rect, R: number): void {
		const C = POCKET_CELL;
		const cols = this.gcols;
		const mark = P_MARK;
		const inside = P_INSIDE;
		const bg = this.blockedGen;
		const ig = this.insideGen;
		const gx0 = this.gx0;
		const gy0 = this.gy0;
		let blockedInside = 0;
		const i0 = math.max(0, math.floor((w.x - R - gx0) / C));
		const i1 = math.min(cols - 1, math.floor((w.x + w.w + R - gx0) / C));
		const j0 = math.max(0, math.floor((w.y - R - gy0) / C));
		const j1 = math.min(this.grows - 1, math.floor((w.y + w.h + R - gy0) / C));
		for (let j = j0; j <= j1; j++) {
			const py = gy0 + j * C + C / 2;
			const dy = math.max(w.y - py, 0, py - w.y - w.h);
			for (let i = i0; i <= i1; i++) {
				const px = gx0 + i * C + C / 2;
				const dx = math.max(w.x - px, 0, px - w.x - w.w);
				if (dx * dx + dy * dy >= R * R) continue;
				const k = j * cols + i;
				if (mark[k] === bg) continue;
				mark[k] = bg;
				if (inside[k] === ig) blockedInside++;
			}
		}
		this.insideBlocked += blockedInside;
	}

	/** did the last `removePockets` (of this planner, the latest one) reach the world point (x, y) from the door? */
	reached(x: number, y: number): boolean {
		const k = this.cellAt(x, y);
		return k >= 0 && P_MARK[k] === this.seenGen;
	}

	/** is this local rect floor inside the building, touching no wall and no piece? (where flat clutter may lie) */
	freeFloor(q: LR): boolean {
		if (!this.inside(q.u0, q.v0) || !this.inside(q.u1, q.v1)) return false;
		if (!this.inside(q.u0, q.v1) || !this.inside(q.u1, q.v0)) return false;
		for (const w of this.walls) if (overlapLR(q, w.r)) return false;
		for (const p of this.pieces) if (overlapLR(q, p)) return false;
		return true;
	}

	/** a point where a body of radius 18 stands clear of every wall and piece */
	standable(u: number, v: number): boolean {
		if (!this.inside(u, v)) return false;
		const body = lr(u - 18, u + 18, v - 18, v + 18);
		for (const w of this.walls) if (overlapLR(body, w.r)) return false;
		for (const q of this.pieces) if (overlapLR(body, q)) return false;
		return true;
	}
}

const LSIDES: Array<LSide> = ["F", "K", "L", "R"];
/** the checkouts' places across a sales floor (shares of its width, from the middle) */
const CHECKOUT_AT: Array<number> = [-0.28, 0.28];
/** where a window may slide to (a share of its slot of the wall) when a piece stands in front of the middle */
const WINDOW_NUDGE: Array<number> = [0, 0.25, -0.25, 0.4, -0.4];
const ISLAND_OFFSETS: Array<[number, number]> = [
	[0, 0],
	[0, 40],
	[0, -40],
	[40, 0],
	[-40, 0],
	[48, 48],
	[-48, -48],
	[48, -48],
	[-48, 48],
];
/** a loot spot stands this far out from the front of its piece */
const LOOT_FRONT = 44;
/**
 * `removePockets`' grids, shared by every planner (one building is planned at a time): grown, never shrunk, never
 * cleared -- a cell holds the generation (P_GEN) that last marked it. P_INSIDE: the footprint; P_MARK: blocked or
 * reached; P_QUEUE: the flood's queue.
 */
const P_INSIDE: Array<number> = [];
const P_MARK: Array<number> = [];
const P_QUEUE: Array<number> = [];
/** the horde's field for `hordePocket`: blocked or reached, the flood's queue; the walls and pieces near one cell */
const F_MARK: Array<number> = [];
const F_QUEUE: Array<number> = [];
const F_NEAR: Array<Rect> = [];
/** the latest generation: only grows, so a cell marked by any earlier flood or stamp reads as unmarked */
let P_GEN = 0;
/** the horde's flow field (server/sim/flowField.ts CELL, INFLATE) */
const FIELD_CELL = 32;
const FIELD_INFLATE = 4;
/** how far the chase's last straight stretch is trusted: zombieBrain DIRECT_CHASE is 200 u (validator: 160 too) */
const DIRECT_REACH = 160;
/** the pocket check's grid (the town's validator grid) and body: a survivor, shared/game/physics.ts PLAYER_RADIUS */
const POCKET_CELL = 8;
const BODY = 18;
/** at most this many pieces come out of one building for its pockets */
const POCKET_TRIES = 24;

/** grows a scratch grid to `n` cells with zeros (older than any generation); a grid is never shrunk */
function growTo(a: Array<number>, n: number): void {
	for (let k = a.size(); k < n; k++) a.push(0);
}

/** does the segment (x0, y0)-(x1, y1) cross none of the rects? (slab test; touching an edge is crossing) */
function segmentFree(x0: number, y0: number, x1: number, y1: number, rects: Array<Rect>): boolean {
	const dx = x1 - x0;
	const dy = y1 - y0;
	const lx = math.min(x0, x1);
	const hx = math.max(x0, x1);
	const ly = math.min(y0, y1);
	const hy = math.max(y0, y1);
	for (const q of rects) {
		if (q.x > hx || q.x + q.w < lx || q.y > hy || q.y + q.h < ly) continue;
		let t0 = 0;
		let t1 = 1;
		let miss = false;
		for (let axis = 0; axis < 2 && !miss; axis++) {
			const d = axis === 0 ? dx : dy;
			const o = axis === 0 ? x0 : y0;
			const lo = axis === 0 ? q.x : q.y;
			const hi = axis === 0 ? q.x + q.w : q.y + q.h;
			if (math.abs(d) < 1e-9) {
				if (o < lo || o > hi) miss = true;
				continue;
			}
			let ta = (lo - o) / d;
			let tb = (hi - o) / d;
			if (ta > tb) {
				const t = ta;
				ta = tb;
				tb = t;
			}
			t0 = math.max(t0, ta);
			t1 = math.min(t1, tb);
			if (t0 > t1) miss = true;
		}
		if (!miss) return false;
	}
	return true;
}

function flip(s: LSide): LSide {
	if (s === "F") return "K";
	if (s === "K") return "F";
	if (s === "L") return "R";
	return "L";
}

function biggest(ctx: RoomCtx): { inner: LR } {
	const whole = ctx.whole;
	if (whole !== undefined) return { inner: whole };
	let best = ctx.cells[0];
	let area = -1;
	for (const c of ctx.cells) {
		const a = (c.inner.u1 - c.inner.u0) * (c.inner.v1 - c.inner.v0);
		if (a > area) {
			area = a;
			best = c;
		}
	}
	return best;
}

/** grid cut positions from weights, on the 8-unit grid; the last one is the full length */
function cuts(out: Array<number>, weights: ReadonlyArray<number>, total: number): void {
	let sum = 0;
	for (const w of weights) sum += w;
	let acc = 0;
	out.push(0);
	for (let i = 0; i < weights.size() - 1; i++) {
		acc += weights[i];
		out.push(math.floor((total * acc) / sum / 8 + 0.5) * 8);
	}
	out.push(total);
}

interface PieceInfo {
	low: boolean;
	loot: boolean;
}

/** which pieces stop bullets (tall) and which hold loot (EDI-03, EDI-12) */
const PIECES: Record<FurnitureKind, PieceInfo> = {
	sofa: { low: true, loot: false },
	armchair: { low: true, loot: false },
	tv: { low: false, loot: false },
	bookcase: { low: false, loot: true },
	counter: { low: true, loot: true },
	stove: { low: true, loot: false },
	fridge: { low: false, loot: true },
	table: { low: true, loot: false },
	bed: { low: true, loot: false },
	nightstand: { low: true, loot: false },
	wardrobe: { low: false, loot: true },
	desk: { low: true, loot: false },
	cabinet: { low: false, loot: true },
	toilet: { low: true, loot: false },
	basin: { low: true, loot: false },
	tub: { low: true, loot: false },
	shelf: { low: false, loot: true },
	gondola: { low: false, loot: true },
	checkout: { low: true, loot: false },
	coldcase: { low: false, loot: true },
	rack: { low: false, loot: true },
	gunrack: { low: false, loot: true },
	display: { low: true, loot: true },
	clothesrack: { low: true, loot: true },
	hospbed: { low: true, loot: false },
	optable: { low: true, loot: false },
	reception: { low: true, loot: false },
	lockers: { low: false, loot: true },
	schooldesk: { low: true, loot: false },
	teacherdesk: { low: true, loot: false },
	prep: { low: true, loot: true },
	booth: { low: true, loot: false },
	safe: { low: false, loot: true },
	bench: { low: true, loot: false },
	// the campus (EDI-17): the loot is where it was kept -- the chemicals shelf, the vending machine (and the stacks'
	// bookcases, the dorm's wardrobes, above); a bunk bed is two beds high and stops a bullet, a lab bench does not
	lectern: { low: true, loot: false },
	seats: { low: true, loot: false },
	labbench: { low: true, loot: false },
	fumehood: { low: false, loot: false },
	chemshelf: { low: false, loot: true },
	bunk: { low: false, loot: false },
	vending: { low: false, loot: true },
};

/** the pieces that say what a room is: a window takes their place only as a last resort (`forceWindow`) */
const DEFINING: Array<FurnitureKind> = [
	"bed",
	"sofa",
	"counter",
	"stove",
	"fridge",
	"table",
	"desk",
	"toilet",
	"tub",
	"hospbed",
	"optable",
	"teacherdesk",
	"checkout",
	"reception",
	"safe",
	"seats",
	"lectern",
	"fumehood",
	"bunk",
];

// ---------------------------------------------------------------------------------------------- furnishing by room

function furnish(pl: Planner, ctx: RoomCtx, bt: number): void {
	const k = ctx.kind;
	const rng = pl.rng;
	if (k === "living") {
		if (!pl.againstWall(ctx, "sofa", 136, 52)) pl.againstWall(ctx, "sofa", 100, 48);
		pl.roomWindow(ctx);
		pl.againstWall(ctx, "tv", 96, 28);
		if (rng.chance(0.7)) pl.againstWall(ctx, "bookcase", 88, 28);
		if (rng.chance(0.5)) pl.againstWall(ctx, "armchair", 52, 52);
	} else if (k === "kitchen") {
		const counter =
			pl.againstWall(ctx, "counter", 200, 40) ||
			pl.againstWall(ctx, "counter", 136, 40) ||
			pl.againstWall(ctx, "counter", 96, 40);
		// a small kitchen whose walls are mostly doorways (a back door and two ways through) still gets what makes it a
		// kitchen, before its window takes a wall: the fridge, then a short counter, then a counter island
		let fridge = false;
		if (!counter) {
			fridge =
				pl.againstWall(ctx, "fridge", 48, 44) ||
				pl.againstWall(ctx, "fridge", 40, 40) ||
				pl.againstWall(ctx, "counter", 64, 36) ||
				pl.island(ctx, "counter", 96, 48, true) ||
				pl.island(ctx, "counter", 96, 48, false) ||
				// a pass-through kitchen (back door, a way through, an open-plan side): the fridge beside a doorway,
				// clear of the opening itself (EDI-12 keeps the doorway's own width free, not its margins)
				pl.againstWall(ctx, "fridge", 40, 40, undefined, false, true);
		}
		pl.roomWindow(ctx);
		if (!fridge) pl.againstWall(ctx, "fridge", 48, 44);
		if (counter) pl.againstWall(ctx, "stove", 56, 40);
		if (rng.chance(0.6)) pl.island(ctx, "table", 88, 64, true);
	} else if (k === "dining") {
		// a table in the middle with room to walk round it, or pushed against a wall in a narrow room
		const along = rng.chance(0.5);
		const placed =
			pl.island(ctx, "table", 120, 72, along) ||
			pl.island(ctx, "table", 120, 72, !along) ||
			pl.island(ctx, "table", 112, 60, along) ||
			pl.island(ctx, "table", 112, 60, !along);
		if (!placed) pl.againstWall(ctx, "table", 120, 64);
		pl.roomWindow(ctx);
		pl.againstWall(ctx, "cabinet", 88, 32);
	} else if (k === "bedroom") {
		// a double bed with its head on the back wall, else a single one: head on a wall, or its side on it
		const bed =
			pl.againstWall(ctx, "bed", 104, 124, "K") ||
			pl.againstWall(ctx, "bed", 76, 116) ||
			pl.againstWall(ctx, "bed", 116, 76) ||
			pl.againstWall(ctx, "bed", 64, 108) ||
			pl.againstWall(ctx, "bed", 108, 64);
		pl.roomWindow(ctx);
		if (bed) pl.againstWall(ctx, "nightstand", 32, 28);
		pl.againstWall(ctx, "wardrobe", 88, 40);
	} else if (k === "bath") {
		pl.againstWall(ctx, "tub", 124, 60);
		pl.againstWall(ctx, "toilet", 32, 40);
		pl.againstWall(ctx, "basin", 40, 28);
	} else if (k === "sales") {
		if (bt === 6) {
			pl.againstWall(ctx, "shelf", 180, 36, "K");
			pl.againstWall(ctx, "shelf", 160, 36);
			pl.againstWall(ctx, "shelf", 140, 36);
			pl.island(ctx, "display", 150, 44, true, 0, 40);
		} else if (bt === 9) {
			pl.againstWall(ctx, "gunrack", 180, 28, "K");
			pl.againstWall(ctx, "gunrack", 150, 28);
			pl.againstWall(ctx, "gunrack", 120, 28);
			pl.island(ctx, "display", 170, 44, true);
		} else if (bt === 10) {
			pl.againstWall(ctx, "shelf", 160, 36, "K");
			pl.island(ctx, "clothesrack", 110, 32, true, -80, 0);
			pl.island(ctx, "clothesrack", 110, 32, true, 80, 0);
			pl.againstWall(ctx, "checkout", 112, 52, "L");
		} else {
			// markets and the gas station shop: cold cases along the back wall, checkouts, aisles
			const cold =
				pl.againstWall(ctx, "coldcase", 320, 44, "K") ||
				pl.againstWall(ctx, "coldcase", 200, 44, "K") ||
				pl.againstWall(ctx, "coldcase", 140, 44);
			if (cold && bt === 7) pl.againstWall(ctx, "coldcase", 200, 44);
			pl.aisles(ctx, "gondola", 48);
		}
	} else if (k === "stock") {
		if (!pl.againstWall(ctx, "rack", 160, 44, "K")) pl.againstWall(ctx, "rack", 112, 44);
		if (!pl.againstWall(ctx, "rack", 112, 44)) pl.againstWall(ctx, "rack", 80, 40);
	} else if (k === "cold") {
		if (!pl.againstWall(ctx, "coldcase", 140, 44, "K")) pl.againstWall(ctx, "coldcase", 96, 44);
		pl.againstWall(ctx, "coldcase", 96, 44);
	} else if (k === "secure") {
		pl.againstWall(ctx, "safe", 56, 56, "K");
		pl.againstWall(ctx, "gunrack", 120, 28);
	} else if (k === "office") {
		pl.againstWall(ctx, "desk", 96, 48);
		pl.roomWindow(ctx);
		pl.againstWall(ctx, "cabinet", 56, 36);
	} else if (k === "classroom") {
		if (!pl.againstWall(ctx, "teacherdesk", 112, 52, "F")) pl.againstWall(ctx, "teacherdesk", 112, 52);
		// the pupils' desks along both side walls, facing the board: the middle of the room stays one wide aisle
		for (let n = 0; n < 2; n++) {
			pl.againstWall(ctx, "schooldesk", 72, 44, "L", true);
			pl.againstWall(ctx, "schooldesk", 72, 44, "R", true);
		}
		if (pl.grid(ctx, "schooldesk", 96, 40, true, 2, 2, 0.3, 1, PATH) === 0) {
			pl.againstWall(ctx, "schooldesk", 96, 44, "K", true);
		}
	} else if (k === "corridor") {
		if (bt === 3) {
			pl.againstWall(ctx, "lockers", 160, 32);
			pl.againstWall(ctx, "lockers", 160, 32);
			pl.againstWall(ctx, "lockers", 128, 32);
		} else if (bt === 12) {
			// the campus hall's back hall: a bank of lockers and a bench by the door to the quad
			pl.againstWall(ctx, "lockers", 128, 32);
			pl.againstWall(ctx, "bench", 112, 36);
		} else {
			pl.againstWall(ctx, "bench", 112, 36);
		}
	} else if (k === "lobby") {
		if (bt === 4) {
			pl.island(ctx, "reception", 168, 52, true);
			pl.againstWall(ctx, "bench", 128, 36);
			pl.againstWall(ctx, "cabinet", 56, 36);
		} else if (bt === 12) {
			// the campus hall's lobby: the vending machine the students lived on, a bench, the trophy cabinet
			pl.againstWall(ctx, "vending", 56, 44);
			pl.againstWall(ctx, "bench", 112, 36);
			pl.againstWall(ctx, "cabinet", 72, 36);
		} else {
			pl.againstWall(ctx, "cabinet", 72, 36);
			pl.againstWall(ctx, "bench", 128, 36);
		}
	} else if (k === "ward") {
		for (let n = 0; n < 4; n++) pl.againstWall(ctx, "hospbed", 64, 120);
		pl.againstWall(ctx, "cabinet", 56, 36);
	} else if (k === "treatment") {
		pl.island(ctx, "optable", 120, 60, true);
		pl.againstWall(ctx, "cabinet", 72, 36);
		pl.againstWall(ctx, "cabinet", 72, 36);
	} else if (k === "diner") {
		for (let n = 0; n < 3; n++) pl.againstWall(ctx, "booth", 112, 64);
		// tables across the whole dining room, cell by cell (an L-shaped room is set in both its arms)
		if (ctx.whole !== undefined) pl.grid(ctx, "table", 72, 72, true, 4, 3, 0.18, 0.95, PATH);
		else for (const c of ctx.cells) pl.grid(ctx, "table", 72, 72, true, 4, 3, 0.12, 0.95, PATH, c.inner);
	} else if (k === "galley") {
		pl.againstWall(ctx, "stove", 112, 56, "K");
		pl.againstWall(ctx, "counter", 160, 44);
		pl.againstWall(ctx, "fridge", 64, 48);
		pl.island(ctx, "prep", 128, 56, true);
	} else {
		furnishCampus(pl, ctx);
	}
}

/**
 * The campus's rooms (EDI-17), each with the piece that says what it is (EDI-08): tiered seats and a lectern in a
 * lecture room, the stacks' shelves, the front desk and reading tables, the lab benches and a fume hood, the chemicals
 * shelves, the bunk beds, the common room's sofa. Every rule of `fits` holds (paths two bodies wide, nothing in front
 * of an opening), so a room too small for a piece simply goes without it (the validator names such a room).
 */
function furnishCampus(pl: Planner, ctx: RoomCtx): void {
	const k = ctx.kind;
	const rng = pl.rng;
	if (k === "lecture") {
		// two tiers of seats rising to the back wall, facing the lectern at the front (the room is ~200 deep: the
		// lectern keeps a path's width from the seats); a wide room gets a second block with an aisle between
		const seats =
			pl.againstWall(ctx, "seats", 176, 72, "K", true) ||
			pl.againstWall(ctx, "seats", 144, 64, "K", true) ||
			pl.againstWall(ctx, "seats", 144, 64);
		if (seats) pl.againstWall(ctx, "seats", 144, 72, "K", true);
		if (!pl.againstWall(ctx, "lectern", 56, 40, "F", true)) pl.againstWall(ctx, "lectern", 56, 40);
		if (rng.chance(0.5)) pl.againstWall(ctx, "cabinet", 56, 36);
	} else if (k === "stacks") {
		// free-standing ranges first, front to back with aisles two bodies wide, then shelves along the walls
		if (pl.grid(ctx, "bookcase", 112, 28, false, 3, 1, 0, 1, PATH) === 0) pl.island(ctx, "bookcase", 96, 28, true);
		if (!pl.againstWall(ctx, "bookcase", 140, 28, "K")) pl.againstWall(ctx, "bookcase", 112, 28);
		pl.roomWindow(ctx);
		pl.againstWall(ctx, "bookcase", 120, 28);
		pl.againstWall(ctx, "bookcase", 120, 28);
		pl.againstWall(ctx, "bookcase", 96, 28);
	} else if (k === "reading") {
		// the front desk by a side wall near the door, reading tables in the middle, a shelf of new books
		const desk =
			pl.againstWall(ctx, "reception", 128, 44, "L", true) ||
			pl.againstWall(ctx, "reception", 128, 44, "R", true) ||
			pl.againstWall(ctx, "reception", 112, 44, "L", true) ||
			pl.againstWall(ctx, "reception", 112, 44, "R", true) ||
			pl.againstWall(ctx, "reception", 112, 44);
		if (!desk) pl.againstWall(ctx, "reception", 88, 40);
		if (pl.grid(ctx, "table", 112, 64, true, 2, 2, 0.3, 1, PATH) === 0) {
			if (!pl.againstWall(ctx, "table", 112, 64, "K", true)) pl.againstWall(ctx, "table", 96, 60);
		}
		pl.againstWall(ctx, "bookcase", 96, 28);
	} else if (k === "lab") {
		// the fume hood on the back wall, benches along the walls and one in the middle, the reagents' shelf
		if (!pl.againstWall(ctx, "fumehood", 96, 44, "K")) pl.againstWall(ctx, "fumehood", 80, 40);
		const island = pl.island(ctx, "labbench", 136, 48, false) || pl.island(ctx, "labbench", 112, 48, true);
		pl.againstWall(ctx, "labbench", 136, 48);
		if (!island) pl.againstWall(ctx, "labbench", 112, 48);
		if (!pl.againstWall(ctx, "chemshelf", 112, 32)) pl.againstWall(ctx, "chemshelf", 80, 32);
	} else if (k === "chemstore") {
		if (!pl.againstWall(ctx, "chemshelf", 136, 36, "K")) pl.againstWall(ctx, "chemshelf", 96, 32);
		pl.againstWall(ctx, "chemshelf", 96, 32);
	} else if (k === "dormroom") {
		// two bunk beds (head to a wall), the window, a wardrobe and a desk
		const bunk = pl.againstWall(ctx, "bunk", 64, 124) || pl.againstWall(ctx, "bunk", 124, 64);
		pl.roomWindow(ctx);
		if (bunk) pl.againstWall(ctx, "bunk", 64, 124);
		pl.againstWall(ctx, "wardrobe", 72, 40);
		pl.againstWall(ctx, "desk", 88, 44);
	} else if (k === "common") {
		// the common room: a sofa on the back wall, the window, the TV, a table if there is room. No fridge: in a
		// room this narrow it ends up beside a doorway and closes it to the horde (EDI-11); the food the students
		// kept is in their rooms, where the dorm is searched
		if (!pl.againstWall(ctx, "sofa", 136, 52, "K")) pl.againstWall(ctx, "sofa", 100, 48);
		pl.roomWindow(ctx);
		pl.againstWall(ctx, "tv", 96, 28);
		if (rng.chance(0.6)) pl.island(ctx, "table", 88, 64, true);
	}
}

/** flat decoration: rugs, mats, chairs round the tables, papers, dried blood, broken glass under windows */
function decorate(pl: Planner, ctx: RoomCtx): void {
	const k = ctx.kind;
	const rng = pl.rng;
	const c = biggest(ctx).inner;
	const cu = (c.u0 + c.u1) / 2;
	const cv = (c.v0 + c.v1) / 2;
	const w = c.u1 - c.u0;
	const h = c.v1 - c.v0;
	if (k === "living" || k === "bedroom") {
		pl.decorAt("rug", cu, cv, math.min(160, w * 0.45), math.min(112, h * 0.4), 0);
	} else if (k === "bath") {
		pl.decorAt("mat", cu, cv, 56, 36, 0);
	} else if (k === "classroom") {
		// the board on the front wall
		pl.decorAt("board", cu, c.v0 + 6, math.min(180, w * 0.6), 8, 0);
		if (rng.chance(0.5)) pl.decorAt("papers", cu + (rng.next() - 0.5) * w * 0.5, cv + h * 0.2, 40, 32, rng.next());
	} else if (k === "office" || k === "lobby") {
		pl.decorAt("papers", cu + (rng.next() - 0.5) * w * 0.4, cv, 44, 34, rng.next());
	} else if (k === "lecture") {
		// the projection screen / whiteboard on the front wall, facing the seats
		pl.decorAt("board", cu, c.v0 + 6, math.min(180, w * 0.6), 8, 0);
		if (rng.chance(0.6)) pl.decorAt("papers", cu + (rng.next() - 0.5) * w * 0.5, cv, 40, 32, rng.next());
	} else if (k === "reading" || k === "stacks" || k === "dormroom") {
		if (k !== "stacks") pl.decorAt("rug", cu, cv, math.min(140, w * 0.4), math.min(96, h * 0.35), 0);
		if (rng.chance(0.7)) pl.decorAt("papers", cu + (rng.next() - 0.5) * w * 0.5, cv + h * 0.15, 44, 34, rng.next());
	} else if (k === "lab") {
		// broken glassware on the floor (the lab was left in a hurry)
		if (rng.chance(0.6)) pl.decorAt("glass", cu + (rng.next() - 0.5) * w * 0.4, cv, 60, 28, 0);
	} else if (k === "common") {
		pl.decorAt("rug", cu, cv, math.min(150, w * 0.45), math.min(104, h * 0.4), 0);
	} else if (k === "ward") {
		// curtains between the beds
		for (const p of pl.pieces) {
			if (p.room !== ctx.id || p.kind !== "hospbed") continue;
			const along = p.face === "F" || p.face === "K";
			const cu = along ? p.u1 + 14 : (p.u0 + p.u1) / 2;
			const cv = along ? (p.v0 + p.v1) / 2 : p.v1 + 14;
			const w = along ? 6 : p.u1 - p.u0;
			const h = along ? p.v1 - p.v0 : 6;
			if (pl.freeFloor(lr(cu - w / 2, cu + w / 2, cv - h / 2, cv + h / 2))) {
				pl.decorAt("curtain", cu, cv, w, h, 0);
			}
		}
	}
	// the campus's notice boards: flyers for the last classes, on a wall of the halls and the lobby (EDI-17)
	const bt = pl.inp.type;
	if (bt >= 12 && bt <= 15 && (k === "foyer" || k === "corridor" || k === "common")) {
		noticeBoard(pl, ctx);
	}
	// chairs round every table and desk (flat, EDI-12: a chair is clutter, not a wall), a few knocked over
	for (const p of pl.pieces) {
		if (p.room !== ctx.id) continue;
		if (
			p.kind !== "table" &&
			p.kind !== "schooldesk" &&
			p.kind !== "desk" &&
			p.kind !== "teacherdesk" &&
			p.kind !== "labbench"
		) {
			continue;
		}
		const wall = p.kind === "desk" || p.kind === "teacherdesk";
		const along = p.u1 - p.u0 >= p.v1 - p.v0;
		const sides: Array<LSide> = wall ? [p.face] : along ? ["F", "K"] : ["L", "R"];
		for (const s of sides) {
			const down = rng.chance(0.25);
			const cu = (p.u0 + p.u1) / 2;
			const cv = (p.v0 + p.v1) / 2;
			const u = s === "L" ? p.u0 - 16 : s === "R" ? p.u1 + 16 : cu;
			const v = s === "F" ? p.v0 - 16 : s === "K" ? p.v1 + 16 : cv;
			// only on free floor: never in a wall behind a desk pushed against it, nor under another piece
			if (!pl.freeFloor(lr(u - 13, u + 13, v - 13, v + 13))) continue;
			pl.decorAt(down ? "chairDown" : "chair", u, v, 26, 26, down ? rng.next() * 1.4 : 0);
		}
	}
	// a few days after the outbreak (APO-01): dried blood in some rooms
	if (rng.chance(0.22)) {
		pl.decorAt(
			"blood",
			cu + (rng.next() - 0.5) * w * 0.5,
			cv + (rng.next() - 0.5) * h * 0.5,
			64,
			48,
			rng.next() * 6,
		);
	}
}

/**
 * A notice board flat on a wall of the room (decoration: it blocks nothing), the back wall first: never across a
 * doorway or a window, never under a piece. A room whose walls are all taken goes without.
 */
function noticeBoard(pl: Planner, ctx: RoomCtx): void {
	const c = biggest(ctx).inner;
	const cu = (c.u0 + c.u1) / 2;
	const cv = (c.v0 + c.v1) / 2;
	const along = math.min(96, (c.u1 - c.u0) * 0.5);
	const across = math.min(96, (c.v1 - c.v0) * 0.5);
	const t = 8;
	const spots: Array<LR> = [
		lr(cu - along / 2, cu + along / 2, c.v1 - 2 - t, c.v1 - 2),
		lr(c.u0 + 2, c.u0 + 2 + t, cv - across / 2, cv + across / 2),
		lr(c.u1 - 2 - t, c.u1 - 2, cv - across / 2, cv + across / 2),
		lr(cu - along / 2, cu + along / 2, c.v0 + 2, c.v0 + 2 + t),
	];
	for (const q of spots) {
		if (!pl.freeFloor(q)) continue;
		const grown = lr(q.u0 - 24, q.u1 + 24, q.v0 - 24, q.v1 + 24);
		let clear = true;
		for (const o of pl.openings) if (overlapLR(grown, o.band)) clear = false;
		if (!clear) continue;
		pl.decorAt("notice", (q.u0 + q.u1) / 2, (q.v0 + q.v1) / 2, q.u1 - q.u0, q.v1 - q.v0, 0);
		return;
	}
}

// ---------------------------------------------------------------------------------------------- entry point

/** Lays out one building (see the header). Deterministic in `inp`. */
export function planBuilding(inp: PlanInput): BuildingPlan {
	const rng = new PlanRng(inp.seed);
	const alongX = inp.side === "top" || inp.side === "bottom";
	const A = alongX ? inp.rect.w : inp.rect.h;
	const D = alongX ? inp.rect.h : inp.rect.w;
	const list = templatesFor(inp.type, A, D);
	// the seed picks a template and a way round; the first (from there on) that fits the town's door is kept,
	// the way round that needs the columns moved least
	const start = rng.int(0, list.size() - 1);
	const flipFirst = rng.chance(0.5);
	let pl: Planner | undefined;
	for (let n = 0; n < list.size() && pl === undefined; n++) {
		const tpl = list[(start + n) % list.size()];
		const a = new Planner(inp, tpl, rng, flipFirst);
		const b = new Planner(inp, tpl, rng, !flipFirst);
		const ca = a.fitMain(false);
		const cb = b.fitMain(false);
		if (ca < 0 && cb < 0) continue;
		pl = ca >= 0 && (cb < 0 || ca <= cb) ? a : b;
		pl.fitMain(true);
	}
	if (pl === undefined) {
		// never seen on the validated seeds; a plan must exist all the same: one room behind the whole front
		pl = new Planner(inp, fallbackFor(inp.type), rng, false);
		pl.fitMain(true);
	}
	pl.cutDoors();
	pl.firstWindows();
	pl.buildWalls();
	pl.clearZones();
	for (let id = 0; id < pl.kinds.size(); id++) {
		const ctx = pl.roomCtx(id);
		furnish(pl, ctx, inp.type);
	}
	pl.cutWindows();
	pl.removePockets();
	for (let id = 0; id < pl.kinds.size(); id++) decorate(pl, pl.roomCtx(id));
	// a few days after the outbreak (APO-01, EDI-18): a share of the windows is already broken -- the storefronts
	// looted, the zombies come through -- and the rest still has its glass. One draw per window, as the glass decal it
	// replaces took (the plan's stream, and so everything after it, is the one it always was); the shards are drawn
	// from the window's state now, on both sides of the sill (client/view/interiorView.ts), for a pane broken later too
	const share = brokenShare(inp.type);
	for (const o of pl.openings) {
		if (o.kind !== "window") continue;
		o.broken = rng.chance(share);
	}
	// loot spots: in front of the pieces that hold the loot, one per room at most, up to three
	const taken: Array<number> = [];
	for (const p of pl.pieces) {
		if (!p.loot || taken.includes(p.room) || pl.loot.size() >= 3) continue;
		const s = pl.lootSpot(p);
		if (!pl.standable(s.u, s.v) || !pl.reached(pl.f.x(s.u, s.v), pl.f.y(s.u, s.v))) continue;
		taken.push(p.room);
		pl.loot.push({ u: s.u, v: s.v, room: p.room });
	}
	const f = pl.f;
	const out: BuildingPlan = {
		parts: [],
		rooms: [],
		walls: [],
		openings: [],
		furniture: [],
		decor: [],
		loot: [],
		yards: [],
		mainWing: inp.rect,
		doorX: 0,
		doorY: 0,
		recess: pl.recess,
	};
	for (const p of pl.merged((i, j) => pl.at(i, j) >= 0)) out.parts.push(f.rect(p));
	for (const p of pl.merged((i, j) => pl.at(i, j) < 0)) out.yards.push({ ...f.rect(p), front: p.v0 < 1 });
	for (let id = 0; id < pl.kinds.size(); id++) {
		const kind = pl.kinds[id];
		for (const p of pl.merged((i, j) => pl.at(i, j) === id)) {
			out.rooms.push({ ...f.rect(p), kind, floor: ROOM_INFO[kind].floor, room: id });
		}
	}
	for (const w of pl.walls) out.walls.push({ ...f.rect(w.r), inner: w.inner });
	for (const o of pl.openings) {
		const side = o.out !== undefined ? f.world(o.out) : f.world(o.alongU ? "F" : "L");
		const opening: Opening = { ...f.rect(o.band), kind: o.kind, side, main: o.main };
		if (o.kind === "window") opening.broken = o.broken === true;
		out.openings.push(opening);
		if (o.main) {
			const r = f.rect(o.band);
			out.doorX = r.x + r.w / 2;
			out.doorY = r.y + r.h / 2;
		}
	}
	for (const p of pl.pieces) {
		out.furniture.push({ ...f.rect(p), kind: p.kind, low: p.low, face: f.world(p.face), variant: rng.int(0, 3) });
	}
	for (const d of pl.decor) out.decor.push({ ...f.rect(d), kind: d.kind, rot: d.rot });
	for (const s of pl.loot) out.loot.push({ x: f.x(s.u, s.v), y: f.y(s.u, s.v) });
	// the main wing: behind the stretch of facade that holds the main door, as deep as the footprint goes on
	// behind all of it (where the storefront sign stands and the roof units sit, client/view/buildingSigns.ts)
	out.mainWing = f.rect(pl.mainWingLocal());
	// no loot furniture reachable (should not happen): the middle of the biggest room
	if (out.loot.size() === 0 && out.rooms.size() > 0) {
		let best = out.rooms[0];
		for (const r of out.rooms) if (r.w * r.h > best.w * best.h) best = r;
		out.loot.push({ x: best.x + best.w / 2, y: best.y + best.h / 2 });
	}
	return out;
}
