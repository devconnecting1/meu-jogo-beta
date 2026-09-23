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
import type { DoorSide, Rect } from "./world";

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
	| "galley";

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
	| "bench";

export type DecorKind = "rug" | "mat" | "blood" | "papers" | "glass" | "chair" | "chairDown" | "board" | "curtain";

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
	/** building type (1/2 house, 3 school, 4 hospital, 5 gas, 6 pharmacy, 7/8 market, 9 gun shop, 10 cloth, 11 restaurant) */
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
/** re-cutting the columns around the main door never leaves a column narrower than this (a room, not a slot) */
const MIN_COL = 144;

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
	/** interior openings between adjacent cells: c1, r1, c2, r2, wide (1: open plan, most of the wall) */
	links: Array<[number, number, number, number, number]>;
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
		rows: [44, 26, 30],
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
		cols: [36, 30, 34],
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
	cols: [28, 22, 20, 30],
	rows: [28, 36, 36],
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
		rows: [40, 30, 30],
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
		rows: [66, 34],
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
		links: [
			[0, 0, 0, 1, 0],
			[1, 0, 1, 1, 0],
			[0, 1, 1, 1, 0],
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
		cols: [31, 38, 31],
		rows: [38, 21, 41],
		map: [
			["C", ".", "c"],
			["H", "H", "H"],
			["e", "O", "f"],
		],
		rooms: SCHOOL_ROOMS,
		main: [1, 1],
		doors: [
			[0, 1, "L", 0.5],
			[2, 1, "R", 0.5],
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
		cols: [32, 36, 32],
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
		rows: [34, 21, 45],
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
	const kind: RoomKind = bt === 3 || bt === 4 ? "lobby" : bt === 11 ? "diner" : "sales";
	return { cols: [1], rows: [1], map: [["A"]], rooms: { A: kind }, main: [0, 0], doors: [], extra: 0, links: [] };
}

// ---------------------------------------------------------------------------------------------- room kinds

interface RoomInfo {
	floor: FloorKind;
	/** 0 no windows, 1 on its outside walls, 2 only on the street face (a shop window) */
	win: number;
}

const ROOM_INFO: Record<RoomKind, RoomInfo> = {
	living: { floor: "wood", win: 1 },
	kitchen: { floor: "kitchen", win: 1 },
	dining: { floor: "wood", win: 1 },
	bedroom: { floor: "carpet", win: 1 },
	bath: { floor: "bath", win: 0 },
	hall: { floor: "wood", win: 0 },
	sales: { floor: "shop", win: 2 },
	stock: { floor: "concrete", win: 0 },
	cold: { floor: "bath", win: 0 },
	secure: { floor: "concrete", win: 0 },
	office: { floor: "carpet", win: 1 },
	classroom: { floor: "shop", win: 1 },
	corridor: { floor: "tile", win: 0 },
	lobby: { floor: "tile", win: 1 },
	ward: { floor: "tile", win: 1 },
	treatment: { floor: "tile", win: 0 },
	diner: { floor: "wood", win: 1 },
	galley: { floor: "kitchen", win: 0 },
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
 * Do `a` and `b` leave a passage between them that one body fits in and two do not, longer than a nook? That is
 * the gap a survivor gets cornered in and a queue of zombies single-files through (EDI-11). Corner to corner
 * and sealed gaps (under SEALED: nobody walks in) are fine.
 */
function narrowBetween(a: LR, b: LR): boolean {
	const du = math.max(0, b.u0 - a.u1, a.u0 - b.u1);
	const dv = math.max(0, b.v0 - a.v1, a.v0 - b.v1);
	if (du > 0 && dv > 0) return false;
	const g = math.max(du, dv);
	if (g < SEALED || g >= PATH) return false;
	const len = du > 0 ? math.min(a.v1, b.v1) - math.max(a.v0, b.v0) : math.min(a.u1, b.u1) - math.max(a.u0, b.u0);
	return len > NOOK;
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
		for (const [i1, j1, i2, j2, wide] of tpl.links) {
			const s: LSide = i2 > i1 ? "R" : i2 < i1 ? "L" : j2 > j1 ? "K" : "F";
			const e = this.edgeOf(i1, j1, s);
			if (e.out !== undefined) continue;
			const len = e.b - e.a - TI - 32;
			const w = wide === 1 ? math.max(INNER_DOOR_W, math.floor(len * 0.8)) : INNER_DOOR_W;
			const o = this.cutIn(e, w, 0.5, "inner", false);
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
			if (info.win === 0) continue;
			let best: Edge | undefined;
			for (let j = 0; j < this.nr; j++) {
				for (let i = 0; i < this.nc; i++) {
					if (this.at(i, j) !== room) continue;
					for (const s of LSIDES) {
						const e = this.edgeOf(i, j, s);
						if (e.out === undefined || (info.win === 2 && s !== "F")) continue;
						if (e.b - e.a - END_MARGIN * 2 < WINDOW_W + 40) continue;
						if (info.win === 2) {
							// a shop front: a row of windows wherever the front's doors leave wall, 140 apart
							const run = this.runOf(i, j, s);
							const whole = run.b - run.a > e.b - e.a ? run : e;
							for (
								let c = whole.a + END_MARGIN + WINDOW_W / 2;
								c <= whole.b - END_MARGIN - WINDOW_W / 2;
								c += 140
							) {
								const o: LOpening = {
									band: bandOf(whole, c - WINDOW_W / 2, c + WINDOW_W / 2),
									kind: "window",
									out: whole.out,
									alongU: whole.alongU,
									main: false,
								};
								if (this.freeOf(o, 40)) this.openings.push(o);
							}
							continue;
						}
						if (best === undefined || e.b - e.a > best.b - best.a) best = e;
					}
				}
			}
			if (best !== undefined) this.tryWindow(best, 0.5, undefined);
		}
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
		const added: Array<LOpening> = [];
		for (let j = 0; j < this.nr; j++) {
			for (let i = 0; i < this.nc; i++) {
				const room = this.at(i, j);
				if (room < 0) continue;
				const info = ROOM_INFO[this.kinds[room]];
				if (info.win === 0) continue;
				for (const s of LSIDES) {
					const e = this.edgeOf(i, j, s);
					// a shop's front row is done; its side walls get a window where the wall is free
					if (e.out === undefined || (info.win === 2 && s === "F")) continue;
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
		// never a single way in (EDI-09): a building with one door and no window gets one wherever a wall is free
		let exits = 0;
		for (const o of this.openings) if (o.kind !== "inner") exits++;
		for (let j = 0; j < this.nr && exits < 2; j++) {
			for (let i = 0; i < this.nc && exits < 2; i++) {
				const room = this.at(i, j);
				if (room < 0 || ROOM_INFO[this.kinds[room]].win === 0) continue;
				for (const s of LSIDES) {
					const e = this.edgeOf(i, j, s);
					if (e.out !== undefined && exits < 2 && this.tryWindow(e, 0.5, added)) exits++;
				}
			}
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
					if (e.out !== undefined) inset[s] = T;
					else {
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
			const zones = this.zonesOf(o, win ? WINDOW_CLEAR_DEPTH : CLEAR_DEPTH, win ? WINDOW_CLEAR_SIDE : CLEAR_SIDE);
			for (const z of zones) this.clear.push(z);
		}
	}

	/**
	 * Can a piece go here? Inside the room, clear of every opening's zone, and against every other obstacle
	 * (wall, post, piece) either sealed off (closer than any body, SEALED) or at least PATH away: no gap a single
	 * body could squeeze into and be cornered in, no aisle too narrow for two (EDI-11). An island keeps PATH from
	 * everything.
	 */
	fits(p: LR, room: LR, island: boolean): boolean {
		if (p.u0 < room.u0 - 0.5 || p.u1 > room.u1 + 0.5 || p.v0 < room.v0 - 0.5 || p.v1 > room.v1 + 0.5) return false;
		for (const c of this.clear) if (overlapLR(p, c)) return false;
		for (const w of this.walls) {
			if (overlapLR(p, w.r)) return false;
			if (island ? gapLR(p, w.r) < PATH : narrowBetween(p, w.r)) return false;
		}
		for (const q of this.pieces) {
			if (overlapLR(p, q)) return false;
			if (island ? gapLR(p, q) < PATH : narrowBetween(p, q)) return false;
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

	/** a piece of `len` × `depth` with its back against a wall of the room; answers whether it went in */
	againstWall(ctx: RoomCtx, kind: FurnitureKind, len: number, depth: number, prefer?: LSide, only = false): boolean {
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
					if (!this.fits(p, r, false)) continue;
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
	): number {
		const r = biggest(ctx).inner;
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
			for (const du of CHECKOUT_AT)
				this.island(ctx, "checkout", 96, 44, false, du * W, -H / 2 + CLEAR_DEPTH + 40);
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

	/** the reach grid of the last `removePockets` (world, the town's 8-unit grid) */
	private gx0 = 0;
	private gy0 = 0;
	private gcols = 0;
	private grows = 0;
	private readonly gSeen: Array<number> = [];
	private readonly gBlocked: Array<number> = [];
	private readonly gInside: Array<number> = [];
	private readonly gQueue: Array<number> = [];

	/**
	 * EDI-11 (no safe spot) and CID-05 (no sealed pocket), checked exactly as tools/validate-world.mjs checks them:
	 * on the town's own 8-unit grid, a survivor (radius 18) can stand on a cell when its centre is 18 clear of every
	 * wall and piece, and walks from cell to cell (4 neighbours). From the main door, every cell inside the footprint
	 * a survivor can stand on must be reached -- the horde's walkers are smaller, so they reach it too. The local
	 * rules of `fits` keep the paths two bodies wide, but they cannot see a pocket two pieces close off between them
	 * and a wall (corner to corner, or a nook behind a piece): the piece nearest such a pocket, the latest placed
	 * first, comes out again, until there is none.
	 */
	removePockets(): void {
		const r = this.inp.rect;
		const C = POCKET_CELL;
		const R = BODY;
		this.gx0 = math.floor(r.x / C) * C;
		this.gy0 = math.floor(r.y / C) * C;
		const cols = math.ceil((r.x + r.w - this.gx0) / C);
		const rows = math.ceil((r.y + r.h - this.gy0) / C);
		this.gcols = cols;
		this.grows = rows;
		const n = cols * rows;
		const inside = this.gInside;
		inside.clear();
		const parts: Array<Rect> = [];
		for (const p of this.merged((i, j) => this.at(i, j) >= 0)) parts.push(this.f.rect(p));
		for (let j = 0; j < rows; j++) {
			const py = this.gy0 + j * C + C / 2;
			for (let i = 0; i < cols; i++) {
				const px = this.gx0 + i * C + C / 2;
				let v = 0;
				for (const p of parts) {
					if (px >= p.x && px <= p.x + p.w && py >= p.y && py <= p.y + p.h) v = 1;
				}
				inside.push(v);
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
		for (let iter = 0; iter < POCKET_TRIES; iter++) {
			const blocked = this.gBlocked;
			blocked.clear();
			for (let k = 0; k < n; k++) blocked.push(0);
			for (const w of walls) this.stampBody(w, R);
			for (const p of this.pieces) this.stampBody(this.f.rect(p), R);
			const seen = this.gSeen;
			seen.clear();
			for (let k = 0; k < n; k++) seen.push(0);
			const q = this.gQueue;
			q.clear();
			const s0 = this.cellAt(seedX, seedY);
			if (s0 >= 0 && blocked[s0] === 0) {
				seen[s0] = 1;
				q.push(s0);
			}
			let head = 0;
			while (head < q.size()) {
				const k = q[head];
				head++;
				const i = k % cols;
				if (i > 0) this.visit(k - 1);
				if (i < cols - 1) this.visit(k + 1);
				if (k >= cols) this.visit(k - cols);
				if (k + cols < n) this.visit(k + cols);
			}
			let pocket = -1;
			for (let k = 0; k < n && pocket < 0; k++) {
				if (inside[k] === 1 && blocked[k] === 0 && seen[k] === 0) pocket = k;
			}
			if (pocket < 0) return;
			const px = this.gx0 + (pocket % cols) * C + C / 2;
			const py = this.gy0 + math.floor(pocket / cols) * C + C / 2;
			let culprit = -1;
			for (let k = this.pieces.size() - 1; k >= 0 && culprit < 0; k--) {
				const b = this.f.rect(this.pieces[k]);
				const dx = math.max(b.x - px, 0, px - b.x - b.w);
				const dy = math.max(b.y - py, 0, py - b.y - b.h);
				if (dx * dx + dy * dy < (R + C * 2) * (R + C * 2)) culprit = k;
			}
			// a pocket that only walls make: nothing to take out (tools/validate-world.mjs names it)
			if (culprit < 0) return;
			this.pieces.remove(culprit);
		}
	}

	private cellAt(x: number, y: number): number {
		const i = math.floor((x - this.gx0) / POCKET_CELL);
		const j = math.floor((y - this.gy0) / POCKET_CELL);
		if (i < 0 || j < 0 || i >= this.gcols || j >= this.grows) return -1;
		return j * this.gcols + i;
	}

	private visit(k: number): void {
		if (this.gSeen[k] === 1 || this.gBlocked[k] === 1) return;
		this.gSeen[k] = 1;
		this.gQueue.push(k);
	}

	/** marks the cells whose centre is closer than `R` to the world rect `w` */
	private stampBody(w: Rect, R: number): void {
		const C = POCKET_CELL;
		const i0 = math.max(0, math.floor((w.x - R - this.gx0) / C));
		const i1 = math.min(this.gcols - 1, math.floor((w.x + w.w + R - this.gx0) / C));
		const j0 = math.max(0, math.floor((w.y - R - this.gy0) / C));
		const j1 = math.min(this.grows - 1, math.floor((w.y + w.h + R - this.gy0) / C));
		for (let j = j0; j <= j1; j++) {
			const py = this.gy0 + j * C + C / 2;
			const dy = math.max(w.y - py, 0, py - w.y - w.h);
			for (let i = i0; i <= i1; i++) {
				const px = this.gx0 + i * C + C / 2;
				const dx = math.max(w.x - px, 0, px - w.x - w.w);
				if (dx * dx + dy * dy < R * R) this.gBlocked[j * this.gcols + i] = 1;
			}
		}
	}

	/** did the last `removePockets` reach the world point (x, y) from the main door? */
	reached(x: number, y: number): boolean {
		const k = this.cellAt(x, y);
		return k >= 0 && this.gSeen[k] === 1;
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
/** the pocket check's grid (the town's validator grid) and body: a survivor, shared/game/physics.ts PLAYER_RADIUS */
const POCKET_CELL = 8;
const BODY = 18;
/** at most this many pieces come out of one building for its pockets */
const POCKET_TRIES = 24;

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
};

// ---------------------------------------------------------------------------------------------- furnishing by room

function furnish(pl: Planner, ctx: RoomCtx, bt: number): void {
	const k = ctx.kind;
	const rng = pl.rng;
	if (k === "living") {
		if (!pl.againstWall(ctx, "sofa", 136, 52)) pl.againstWall(ctx, "sofa", 100, 48);
		pl.againstWall(ctx, "tv", 96, 28);
		if (rng.chance(0.7)) pl.againstWall(ctx, "bookcase", 88, 28);
		if (rng.chance(0.5)) pl.againstWall(ctx, "armchair", 52, 52);
	} else if (k === "kitchen") {
		const counter =
			pl.againstWall(ctx, "counter", 200, 40) ||
			pl.againstWall(ctx, "counter", 136, 40) ||
			pl.againstWall(ctx, "counter", 96, 40);
		pl.againstWall(ctx, "fridge", 48, 44);
		if (counter) pl.againstWall(ctx, "stove", 56, 40);
		if (rng.chance(0.6)) pl.island(ctx, "table", 88, 64, true);
	} else if (k === "dining") {
		pl.island(ctx, "table", 120, 72, rng.chance(0.5));
		pl.againstWall(ctx, "cabinet", 88, 32);
	} else if (k === "bedroom") {
		const bed = pl.againstWall(ctx, "bed", 104, 124, "K") || pl.againstWall(ctx, "bed", 76, 116);
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
		pl.againstWall(ctx, "rack", 112, 44);
	} else if (k === "cold") {
		if (!pl.againstWall(ctx, "coldcase", 140, 44, "K")) pl.againstWall(ctx, "coldcase", 96, 44);
		pl.againstWall(ctx, "coldcase", 96, 44);
	} else if (k === "secure") {
		pl.againstWall(ctx, "safe", 56, 56, "K");
		pl.againstWall(ctx, "gunrack", 120, 28);
	} else if (k === "office") {
		pl.againstWall(ctx, "desk", 96, 48);
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
		} else {
			pl.againstWall(ctx, "bench", 112, 36);
		}
	} else if (k === "lobby") {
		if (bt === 4) {
			pl.island(ctx, "reception", 168, 52, true);
			pl.againstWall(ctx, "bench", 128, 36);
			pl.againstWall(ctx, "cabinet", 56, 36);
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
		pl.grid(ctx, "table", 72, 72, true, 4, 3, 0.18, 0.95, PATH);
	} else if (k === "galley") {
		pl.againstWall(ctx, "stove", 112, 56, "K");
		pl.againstWall(ctx, "counter", 160, 44);
		pl.againstWall(ctx, "fridge", 64, 48);
		pl.island(ctx, "prep", 128, 56, true);
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
	} else if (k === "ward") {
		// curtains between the beds
		for (const p of pl.pieces) {
			if (p.room !== ctx.id || p.kind !== "hospbed") continue;
			const along = p.face === "F" || p.face === "K";
			if (along) pl.decorAt("curtain", p.u1 + 14, (p.v0 + p.v1) / 2, 6, p.v1 - p.v0, 0);
			else pl.decorAt("curtain", (p.u0 + p.u1) / 2, p.v1 + 14, p.u1 - p.u0, 6, 0);
		}
	}
	// chairs round every table and desk (flat, EDI-12: a chair is clutter, not a wall), a few knocked over
	for (const p of pl.pieces) {
		if (p.room !== ctx.id) continue;
		if (p.kind !== "table" && p.kind !== "schooldesk" && p.kind !== "desk" && p.kind !== "teacherdesk") continue;
		const wall = p.kind === "desk" || p.kind === "teacherdesk";
		const along = p.u1 - p.u0 >= p.v1 - p.v0;
		const sides: Array<LSide> = wall ? [p.face] : along ? ["F", "K"] : ["L", "R"];
		for (const s of sides) {
			const down = rng.chance(0.25);
			const cu = (p.u0 + p.u1) / 2;
			const cv = (p.v0 + p.v1) / 2;
			const u = s === "L" ? p.u0 - 16 : s === "R" ? p.u1 + 16 : cu;
			const v = s === "F" ? p.v0 - 16 : s === "K" ? p.v1 + 16 : cv;
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
	// broken glass inside some windows (APO-01): the zombies came through here
	for (const o of pl.openings) {
		if (o.kind !== "window" || !rng.chance(0.35)) continue;
		const b = o.band;
		const cu = (b.u0 + b.u1) / 2;
		const cv = (b.v0 + b.v1) / 2;
		const off = 22;
		if (o.out === "F") pl.decorAt("glass", cu, b.v1 + off, 60, 28, 0);
		else if (o.out === "K") pl.decorAt("glass", cu, b.v0 - off, 60, 28, 0);
		else if (o.out === "L") pl.decorAt("glass", b.u1 + off, cv, 28, 60, 0);
		else pl.decorAt("glass", b.u0 - off, cv, 28, 60, 0);
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
		out.openings.push({ ...f.rect(o.band), kind: o.kind, side, main: o.main });
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
	// the main wing: the part the main door is in (its gap lies inside the part: exterior walls are inside cells)
	let wingArea = -1;
	for (const p of out.parts) {
		const has = out.doorX >= p.x && out.doorX <= p.x + p.w && out.doorY >= p.y && out.doorY <= p.y + p.h;
		if (has) {
			out.mainWing = p;
			break;
		}
		if (p.w * p.h > wingArea) {
			wingArea = p.w * p.h;
			out.mainWing = p;
		}
	}
	// no loot furniture reachable (should not happen): the middle of the biggest room
	if (out.loot.size() === 0 && out.rooms.size() > 0) {
		let best = out.rooms[0];
		for (const r of out.rooms) if (r.w * r.h > best.w * best.h) best = r;
		out.loot.push({ x: best.x + best.w / 2, y: best.y + best.h / 2 });
	}
	return out;
}
