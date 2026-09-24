/*
 * The buildings' entrances (docs/DESIGN_RULES.md ART-17): what each doorway of the town looks like, by the building's
 * type and whether it is the main door -- a house's painted front door with its step and coir mat, a shop's glass
 * doors and rubber mat, a hospital's sliding doors over a ramp, a school's steel doors at the top of its steps, the
 * bank's dark glass in brass, a fire station's roll-up bay -- and the flat drawing of it (at most two Frames on the
 * ground and one on the roof's edge, ART-16's budget) used until the entrances' atlas has an id (ART-01). The pixel art
 * is ./entranceArt.ts; the doorway itself stays the open gap it always was (EDI-09): nothing here is a solid.
 *
 * Every choice a door makes (which look of its mat, which leaf is shattered, the few house doors torn off or once
 * boarded up) comes from a hash of where the doorway is: the same on every client, nothing stored or sent.
 */
import { COLORS } from "shared/engine/colors";
import type { Opening } from "shared/game/interiors";
import { hash01 } from "shared/game/world";

const WHITE = COLORS.white;
const BLACK = COLORS.shadow;

/**
 * The door in a doorway: which kind of leaf, and which way it swings. The kind says how many leaves: a single door's
 * one leaf closes the whole gap (a house's front and back door, the gas station's, a service door); the others are a
 * double door's two (ESC-02) -- ./entranceAtlas.ts ENTRANCE_SINGLE_LEAF, painted by tools/entrance-art.mjs.
 */
export interface LeafSpec {
	kind: string;
	/** swings into the building (drawn with the interior, the roof off) or out (drawn on the ground outside) */
	inward: boolean;
	/** a fixed look (the school's paint, the campus's maroon); undefined: by the door's place */
	look?: number;
	/** swings out and only out (a security grille outside a glass door): where the wall outside is taken, not drawn */
	outsideOnly?: boolean;
}

/** one flat rect of an entrance: along the wall (added to the gap's width), its depth, and where its middle is */
export interface FlatRect {
	/** added to the gap's width (negative: narrower than the gap) */
	along: number;
	depth: number;
	/** from the wall's outside face to the rect's middle */
	off: number;
	/** along the wall, from the gap's middle */
	at?: number;
	color: Color3;
	radius?: number;
	/** the town's thin outline (a step's edge) */
	edge?: boolean;
}

export interface EntranceStyle {
	name: string;
	/** the ground outside (entrances atlas "stoop:<kind>"), and a fixed look of it */
	stoop: string;
	stoopLook?: number;
	/** the doorway across the wall, with the roof off ("frame:<kind>") */
	frame: string;
	/** the lintel on the roof's edge ("roof:<kind>"), and a fixed look of it */
	roof: string;
	roofLook?: number;
	leaves: Array<LeafSpec>;
	/** a house's door: a few were torn off, a few were boarded up and broken through (APO-01) */
	wear: boolean;
	/** a shop's glass doors: now and then a leaf's glass is shattered (EDI-18's look) */
	shatter: boolean;
	/** the flat drawing on the ground: the thing itself and the one detail that says what it is */
	base: FlatRect;
	detail?: FlatRect;
	/** the flat mark on the roof's edge; undefined: the roof's own darker eave, as before the entrances */
	eave?: Color3;
}

// ---------------------------------------------------------------- the flat colours (the palette, never UI tokens)

/** a poured step (worldView.ts STEP: the doorstep the art path drew before the entrances) */
const STEP = COLORS.sidewalk.Lerp(WHITE, 0.3);
const STEP_OLD = COLORS.sidewalk.Lerp(WHITE, 0.14);
const RUBBER = COLORS.metalDark.Lerp(BLACK, 0.25);
const RUBBER_BLUE = COLORS.fabric.Lerp(BLACK, 0.35);
const ALU = COLORS.metal;
const RAMP = COLORS.sidewalk.Lerp(WHITE, 0.36);
const TACTILE = COLORS.uiYellow.Lerp(COLORS.sidewalk, 0.2);
const STONE = COLORS.counterTop.Lerp(WHITE, 0.15);
const RISER = COLORS.sidewalk.Lerp(BLACK, 0.25);
const RUNNER = COLORS.chalkboard.Lerp(WHITE, 0.1);
const BRASS = COLORS.goodsC.Lerp(COLORS.furnWood, 0.3);
const HAZARD = COLORS.uiYellow.Lerp(COLORS.sidewalk, 0.15);
const GRATE = COLORS.metalDark;

const HOUSE_BASE: FlatRect = { along: 20, depth: 20, off: 10, color: STEP, edge: true };
const HOUSE_MAT: FlatRect = { along: -24, depth: 22, off: 14, color: COLORS.doormat, radius: 3 };
const BACK_STEP: FlatRect = { along: 8, depth: 16, off: 8, color: STEP_OLD, edge: true };
const RUBBER_MAT: FlatRect = { along: -8, depth: 20, off: 12, color: RUBBER, radius: 2 };
const NOSING: FlatRect = { along: 0, depth: 4, off: 2, color: ALU };

const HOUSE: EntranceStyle = {
	name: "house",
	stoop: "step",
	frame: "wood",
	roof: "trim",
	leaves: [{ kind: "wood", inward: true }],
	wear: true,
	shatter: false,
	base: HOUSE_BASE,
	detail: HOUSE_MAT,
};
const HOUSE_BACK: EntranceStyle = {
	name: "houseBack",
	stoop: "back",
	frame: "wood",
	roof: "backtrim",
	leaves: [{ kind: "plank", inward: true }],
	wear: true,
	shatter: false,
	base: BACK_STEP,
};
const SHOP: EntranceStyle = {
	name: "shop",
	stoop: "mat",
	frame: "alu",
	roof: "shop",
	leaves: [{ kind: "glass", inward: false }],
	wear: false,
	shatter: true,
	base: RUBBER_MAT,
	detail: NOSING,
	eave: ALU.Lerp(BLACK, 0.2),
};
const DINER: EntranceStyle = {
	...SHOP,
	name: "diner",
	stoop: "diner",
	roof: "awning",
	roofLook: 0,
	// the sidewalk menu board knocked flat beside the mat
	detail: { along: -112 + 40, depth: 24, off: 38, at: 70, color: COLORS.chalkboard },
	eave: COLORS.goodsC,
};
const BAKERY: EntranceStyle = {
	...SHOP,
	name: "bakery",
	roof: "awning",
	roofLook: 1,
	eave: COLORS.goodsA.Lerp(WHITE, 0.35),
};
const GAS: EntranceStyle = { ...SHOP, name: "gas", leaves: [{ kind: "gas", inward: false }], shatter: false };
const GUNS: EntranceStyle = {
	...SHOP,
	name: "guns",
	roof: "grille",
	// the security grille outside, forced; the glass doors behind it
	leaves: [
		{ kind: "grille", inward: false, outsideOnly: true },
		{ kind: "glass", inward: true },
	],
	shatter: true,
	eave: GRATE,
};
const HOSPITAL: EntranceStyle = {
	name: "hospital",
	stoop: "ramp",
	frame: "sliding",
	roof: "canopy",
	leaves: [],
	wear: false,
	shatter: false,
	base: { along: 24, depth: 40, off: 20, color: RAMP, edge: true },
	detail: { along: 0, depth: 8, off: 4, color: TACTILE },
	eave: COLORS.porcelain,
};
const SCHOOL: EntranceStyle = {
	name: "school",
	stoop: "stairs",
	frame: "steel",
	roof: "school",
	roofLook: 0,
	leaves: [{ kind: "steel", inward: false, look: 0 }],
	wear: false,
	shatter: false,
	base: { along: 48, depth: 36, off: 18, color: STEP, edge: true },
	detail: { along: 48, depth: 3, off: 11, color: RISER },
	eave: STEP,
};
const CAMPUS: EntranceStyle = {
	...SCHOOL,
	name: "campus",
	roofLook: 1,
	leaves: [{ kind: "steel", inward: false, look: 1 }],
};
const BANK: EntranceStyle = {
	name: "bank",
	stoop: "bank",
	frame: "stone",
	roof: "bank",
	leaves: [{ kind: "dark", inward: true }],
	wear: false,
	shatter: false,
	base: { along: -24, depth: 12, off: 9, color: RUNNER },
	detail: { along: 0, depth: 4, off: 2, color: BRASS },
	eave: STONE,
};
const TOWN_HALL: EntranceStyle = {
	name: "townHall",
	stoop: "stoneStairs",
	frame: "stone",
	roof: "civic",
	leaves: [{ kind: "oak", inward: true }],
	wear: false,
	shatter: false,
	base: { along: 48, depth: 36, off: 18, color: STONE, edge: true },
	detail: { along: 48, depth: 3, off: 11, color: STONE.Lerp(BLACK, 0.25) },
	eave: STONE,
};
const POLICE: EntranceStyle = {
	name: "police",
	stoop: "matBlue",
	frame: "steel",
	roof: "police",
	leaves: [{ kind: "wired", inward: false }],
	wear: false,
	shatter: false,
	base: { ...RUBBER_MAT, color: RUBBER_BLUE },
	detail: NOSING,
	eave: COLORS.fabric.Lerp(WHITE, 0.25),
};
const BAY: EntranceStyle = {
	name: "fireBay",
	stoop: "bay",
	stoopLook: 0,
	frame: "bay",
	roof: "hood",
	roofLook: 0,
	leaves: [],
	wear: false,
	shatter: false,
	base: { along: 32, depth: 22, off: 11, color: HAZARD },
	detail: { along: 0, depth: 8, off: 4, color: GRATE },
	eave: COLORS.roofRed,
};
const GARAGE: EntranceStyle = { ...BAY, name: "garageBay", stoopLook: 1, roofLook: 1, eave: ALU };
const OFFICE: EntranceStyle = { ...SHOP, name: "office" };
const SERVICE: EntranceStyle = {
	name: "service",
	stoop: "service",
	frame: "steel",
	roof: "steelhead",
	leaves: [{ kind: "service", inward: false }],
	wear: false,
	shatter: false,
	base: { along: 8, depth: 16, off: 8, color: STEP_OLD, edge: true },
};

/**
 * The entrance of a doorway of a building of type `bt` (shared/data/buildings.ts): its main door by its type, a
 * house's back door, and every other building's side and back doors a steel service door.
 */
export function entranceStyle(bt: number, main: boolean): EntranceStyle {
	if (bt === 1 || bt === 2) return main ? HOUSE : HOUSE_BACK;
	if (!main) return SERVICE;
	if (bt === 3) return SCHOOL;
	if (bt === 4) return HOSPITAL;
	if (bt === 5) return GAS;
	if (bt === 9) return GUNS;
	if (bt === 11) return DINER;
	if (bt === 19) return BAKERY;
	if (bt >= 12 && bt <= 15) return CAMPUS;
	if (bt === 17) return GARAGE;
	if (bt === 21 || bt === 26) return OFFICE;
	if (bt === 22) return BANK;
	if (bt === 23) return TOWN_HALL;
	if (bt === 24) return BAY;
	if (bt === 25) return POLICE;
	return SHOP;
}

/** every style, for the tests */
export const ENTRANCE_STYLES: Array<EntranceStyle> = [
	HOUSE,
	HOUSE_BACK,
	SHOP,
	DINER,
	BAKERY,
	GAS,
	GUNS,
	HOSPITAL,
	SCHOOL,
	CAMPUS,
	BANK,
	TOWN_HALL,
	POLICE,
	BAY,
	GARAGE,
	OFFICE,
	SERVICE,
];

// ---------------------------------------------------------------- a door's own picks (hashes of its place)

/** a number in [0, n) for doorway `o` and salt `salt`: the same on every client */
export function doorPick(o: Opening, salt: number, n: number): number {
	return math.floor(hash01(o.x, o.y, salt) * n) % n;
}

/** a house door's wear (APO-01): 0 none, 1 torn off its hinges (one leaf lies outside), 2 boarded and broken through */
export function doorWear(o: Opening): number {
	const u = hash01(o.x, o.y, 83);
	return u < 0.05 ? 1 : u < 0.1 ? 2 : 0;
}

/** a shop door's shattered leaf (EDI-18's look): 0 none, 1 the leaf at jamb a, 2 at jamb b */
export function doorShattered(o: Opening): number {
	const u = hash01(o.x, o.y, 87);
	return u < 0.15 ? 1 : u < 0.3 ? 2 : 0;
}
