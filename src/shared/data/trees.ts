/*
 * The town's trees (docs/DESIGN_RULES.md VEG-06): which kinds grow where, how big and in which greens -- as DATA,
 * read by the town generator (shared/game/world.ts `addTree`: every tree's species, look, size and tint), by the art
 * generator (tools/tree-art.mjs: one crown per species and look in design/world-art/trees.png, lit and shaded on its
 * own) and by the drawing (client/view/worldView.ts `drawTreeArt`).
 *
 * The owner's playtest (2026-09-24): "trees are repeated and in the same repetitive rotation" -- every tree of the town
 * was one of three round crowns of the same size, all facing the same way, scattered evenly. Now:
 *  - eight kinds: four broadleaf crowns (round, lobed, a wide spreading one, a tall narrow one), a pine, a young tree,
 *    a shrub and, rarely, a dead one (APO-01: a few, not a dead town);
 *  - each in several LOOKS, every one its own drawing with its own light from the top left (ART-02): a crown is never
 *    turned or mirrored, so the lit side never leaves the top left;
 *  - a size per tree inside its kind's range and one of its kind's greens (darker where a park is dense);
 *  - where it grows decides what it is: a street is planted with one kind (with a young replacement here and there, a
 *    dead one rarely), a park grows in groves, a yard has a bit of everything.
 * Only what is DRAWN changes: every tree still collides by its 44 u trunk (TOWN.TREE_TRUNK, the original's mask), so
 * nothing a body, a bullet or the horde's flow field meets is new.
 *
 * `Solid.variant` of a tree is `species * TREE_LOOKS_MAX + look`; `canopyR` its crown's radius; `tint` its green.
 *
 * This module imports nothing (the art generator reads it with a bare TypeScript transpile).
 */

/** a kind of tree */
export interface TreeSpecies {
	/** the art's name for it (tools/tree-art.mjs, client/view/treeAtlas.ts) */
	name: string;
	/** how many different crowns the art draws for it: each one drawn and lit on its own, never a turned copy */
	looks: number;
	/** the side of its crown's cell in the atlas, in texels: its middle size at 4 world units a texel (ART-02) */
	box: number;
	/** the crown's radius, world units: what is drawn and what turns see-through over a body (VEG-04) */
	rMin: number;
	rMax: number;
	/** how tall it stands: the length of its shadow (a building's is 20-30) */
	lift: number;
	/** a shrub: lower than a person (drawn under the bodies, never see-through), no trunk showing */
	low: boolean;
	/**
	 * Its colours, each a blend of two colours of the palette (shared/engine/colors.ts, CON-01): [a, b, k] = a.Lerp(b, k).
	 * The crown's texture is greyscale and tinted with one of them (ART-03).
	 */
	tints: ReadonlyArray<readonly [string, string, number]>;
}

export const TREE_ROUND = 0;
export const TREE_LOBED = 1;
export const TREE_WIDE = 2;
export const TREE_COLUMN = 3;
export const TREE_PINE = 4;
export const TREE_YOUNG = 5;
export const TREE_SHRUB = 6;
export const TREE_DEAD = 7;

/** `Solid.variant` of a tree = species * TREE_LOOKS_MAX + look */
export const TREE_LOOKS_MAX = 8;

export const TREE_SPECIES: ReadonlyArray<TreeSpecies> = [
	{
		name: "round",
		looks: 6,
		box: 42,
		rMin: 76,
		rMax: 92,
		lift: 34,
		low: false,
		tints: [
			["treeLeaf", "treeLeafLight", 0.15],
			["treeLeaf", "treeLeafLight", 0.45],
			["treeLeaf", "treeLeafDark", 0.3],
		],
	},
	{
		name: "lobed",
		looks: 6,
		box: 44,
		rMin: 80,
		rMax: 96,
		lift: 36,
		low: false,
		tints: [
			["treeLeafDark", "treeLeaf", 0.55],
			["treeLeaf", "treeLeafLight", 0.3],
			["treeLeafDark", "treeLeaf", 0.2],
		],
	},
	{
		name: "wide",
		looks: 5,
		box: 48,
		rMin: 90,
		rMax: 100,
		lift: 30,
		low: false,
		tints: [
			["treeLeaf", "treeLeafLight", 0.3],
			["treeLeaf", "treeYoung", 0.25],
			["treeLeafDark", "treeLeaf", 0.45],
		],
	},
	{
		name: "column",
		looks: 5,
		box: 28,
		rMin: 50,
		rMax: 60,
		lift: 52,
		low: false,
		tints: [
			["treeLeaf", "treeLeafLight", 0.6],
			["treeLeafDark", "treeLeaf", 0.6],
			["treeLeaf", "treePine", 0.35],
		],
	},
	{
		name: "pine",
		looks: 6,
		box: 36,
		rMin: 64,
		rMax: 80,
		lift: 46,
		low: false,
		tints: [
			["treePine", "treePine", 0],
			["treePine", "treePineDark", 0.5],
			["treePine", "treeLeaf", 0.3],
		],
	},
	{
		name: "young",
		looks: 4,
		box: 24,
		rMin: 42,
		rMax: 52,
		lift: 20,
		low: false,
		// a fresh, yellower green -- never the walker's (COLORS.zombie1: 22 ΔE off it, LEG-03)
		tints: [
			["treeYoung", "treeYoung", 0],
			["treeYoung", "treeLeaf", 0.3],
		],
	},
	{
		name: "shrub",
		looks: 6,
		box: 18,
		rMin: 30,
		rMax: 40,
		lift: 10,
		low: true,
		tints: [
			["treeLeafDark", "treeLeaf", 0.35],
			["treeLeafDark", "treePine", 0.3],
			["treeLeaf", "treeLeafDark", 0.5],
		],
	},
	{
		name: "dead",
		looks: 3,
		box: 38,
		rMin: 66,
		rMax: 84,
		lift: 34,
		low: false,
		tints: [
			["treeDead", "treeDead", 0],
			["treeDead", "treeTrunk", 0.35],
		],
	},
];

/** where a tree was planted: it decides what grows (TREE_SITE_MIX) and how its neighbours are laid out */
export type TreeSite =
	/** a residential street's grass verge (a planted street: one species, VEG-02's rhythm) */
	| "street"
	/** a downtown street's tree pit (a planted street) */
	| "pit"
	/** an avenue's median (a planted street) */
	| "median"
	/** a park, in groves (world.ts `parkTrees`) */
	| "park"
	/** a plaza's lawns */
	| "plaza"
	/** a house's yard */
	| "yard"
	/** a school's or a hospital's grounds */
	| "civic"
	/** a planter in a downtown yard */
	| "shop"
	/** the campus quad (EDI-17) */
	| "quad";

/**
 * The species a tree gets where it grows on its own (a yard, a plaza), and a park grove's species: weights in
 * TREE_SPECIES order (round, lobed, wide, column, pine, young, shrub, dead).
 */
export const TREE_SITE_MIX: Record<TreeSite, ReadonlyArray<number>> = {
	street: [24, 28, 20, 28, 0, 0, 0, 0],
	pit: [25, 20, 0, 55, 0, 0, 0, 0],
	median: [22, 33, 0, 45, 0, 0, 0, 0],
	park: [22, 26, 16, 10, 26, 0, 0, 0],
	plaza: [30, 15, 0, 20, 5, 10, 20, 0],
	yard: [18, 16, 10, 8, 16, 10, 18, 4],
	civic: [25, 20, 15, 10, 10, 0, 20, 0],
	shop: [30, 0, 0, 40, 0, 20, 10, 0],
	quad: [35, 45, 0, 20, 0, 0, 0, 0],
};

/**
 * A planted street (street, pit, median): every tree is the street's species, but for a young one planted where one
 * was lost, now and then another kind, and -- on a residential street or a median -- rarely one that died.
 */
export const STREET_YOUNG = 0.1;
export const STREET_OTHER = 0.06;
export const STREET_DEAD = 0.03;

/**
 * A park's grove: its trees are the grove's species, but for a companion of another kind, a shrub at its edge and,
 * rarely, a dead one; the lone trees on the open lawn between the groves are any of the park's kinds.
 */
export const GROVE_COMPANION = 0.12;
export const GROVE_EDGE_SHRUB = 0.35;
export const GROVE_DEAD = 0.02;

/**
 * VEG-06: two trees of the same kind and look are never within TREE_TWIN_NEAR of each other while another look of the
 * kind has none that close; past that, the look the kind's trees within TREE_TWIN_CLEAR use least (the nearer, the
 * more a tree counts) is taken
 */
export const TREE_TWIN_NEAR = 260;
export const TREE_TWIN_CLEAR = 600;

/** the look of a tree (`Solid.variant`) as its species and its look */
export function treeSpecies(variant: number): number {
	return math.floor(variant / TREE_LOOKS_MAX);
}

export function treeLook(variant: number): number {
	return variant % TREE_LOOKS_MAX;
}
