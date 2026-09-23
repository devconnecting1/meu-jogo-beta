/*
 * Where each pose of each character sits in the characters' sprite sheets (design/world-art: survivorsA / B, weapons,
 * zombies, dogs, birds, and the white Fill / Rim masks of the survivors and the zombies). tools/character-art.mjs
 * writes the sheets from this layout and client/view/charArt.ts reads them with it, so the two can never point at
 * different cells (docs/DESIGN_RULES.md ART-08). Every sheet stays within 1024 x 1024 texels, the largest image
 * Roblox keeps at full resolution.
 *
 * A sheet is a grid of square cells, one texel = 4 world units (WORLD_TEXEL, like the town). COLUMN = heading: every
 * pose is drawn at CHAR_DIRS screen headings, so a character sprite is never rotated on screen -- its texels stay on
 * the square grid of the town's, and the light baked into it stays at the top left of the screen (ART-02). ROW = pose
 * (a stride of the walk, a grip, a swing, a wind-up, a flight).
 *
 * Every cell is an even number of texels: a survivor is two sprites (the weapon under the body), each centred on a
 * point snapped to whole texels from the body's centre, and with even cells their texel grids coincide on screen.
 *
 * No engine and no renderer here: the generator loads this file under Node.
 */
import { WeaponKind } from "shared/data/kinds";

/** headings per turn in every sheet: 11.25 degrees apart */
export const CHAR_DIRS = 32;

/** the column of a screen heading (radians, 0 = facing screen right, y down) */
export function dirIndex(screenHeading: number): number {
	const i = math.floor((screenHeading / (math.pi * 2)) * CHAR_DIRS + 0.5) % CHAR_DIRS;
	return i < 0 ? i + CHAR_DIRS : i;
}

/** the screen heading a column is drawn at (the generator's side of dirIndex) */
export function dirHeading(dir: number): number {
	return (dir / CHAR_DIRS) * math.pi * 2;
}

/** strides baked per walk cycle, the pixel-art walk: one foot forward, both together, the other forward */
export const STEPS = 3;

/** the row offset of a stride (-1..1) */
export function stepRow(step: number): number {
	if (step < -1 / 3) return 0;
	if (step > 1 / 3) return 2;
	return 1;
}

/** the stride a row offset was baked at (the generator's side of stepRow) */
export function rowStep(row: number): number {
	return row - 1;
}

// ---------------------------------------------------------------- survivors

/** OutfitLook 0..3 (shared/data/cosmetics.ts) */
export const OUTFITS = 4;
/** texels per cell: a downed survivor lying full length, a long gun's support hand, the cowboy's brim */
export const SURVIVOR_CELL = 20;

/**
 * How the hands hold what they hold. A survivor cell is the WHOLE body -- boots, torso, pack, both arms, head or hat
 * -- rasterised as one silhouette with one outline, so the arms are baked per grip; only the weapon is a sprite of
 * its own (client/view/survivorView.ts puts it where these hands hold it).
 */
export const Grip = {
	/** a melee weapon held low in the right hand, the left hand free */
	Idle: 0,
	/** a pistol in both hands, straight ahead */
	Pistol: 1,
	/** a long gun (rifle, shotgun, MG, sniper, flamethrower, stun gun): right hand on the grip, left under the barrel */
	Long: 2,
	/** a bow held out in the left hand, the right at the string */
	Bow: 3,
} as const;
export const GRIPS = 4;

/**
 * Where the hands are, in the body's frame (world units: f along the heading, l to the body's right), right hand
 * first. The same numbers the flat drawing uses (survivorView.ts), except the long gun's support hand, which the flat
 * drawing slides out along the barrel and the pixel art keeps within its cell.
 */
export const GRIP_HANDS: ReadonlyArray<readonly [number, number, number, number]> = [
	[12, 14, 10, -14],
	[18, 6, 18, -2],
	[16, 7, 27, 3],
	[10, 8, 24, 0],
];

/** a melee swing: the blade hand 16 u out along the sweep (the left hand stays at (10, -14)) */
export const SWING_HAND = 16;
/** the sweep angles baked off the aim (radians): every melee cone is at most 60 degrees each way */
export const SWINGS = [-math.pi / 3, -math.pi / 6, 0, math.pi / 6, math.pi / 3];

/** per outfit: GRIPS x STEPS standing, then the swings, then three crawl poses (downed, MP-03) */
export const SURVIVOR_ROW_SWING = GRIPS * STEPS;
export const SURVIVOR_ROW_DOWNED = SURVIVOR_ROW_SWING + SWINGS.size();
export const SURVIVOR_ROWS_EACH = SURVIVOR_ROW_DOWNED + 3;
/** two outfits per sheet: survivorsA (plain, Santa), survivorsB (Zombie, Cowboy); their masks share the layout */
export const OUTFITS_PER_SHEET = 2;
export const SURVIVOR_SHEETS = OUTFITS / OUTFITS_PER_SHEET;
export const SURVIVOR_ROWS = SURVIVOR_ROWS_EACH * OUTFITS_PER_SHEET;

function outfitIndex(outfit: number): number {
	return outfit >= 0 && outfit < OUTFITS ? outfit : 0;
}

/** which sheet (0 = A, 1 = B) an outfit is drawn from */
export function survivorSheet(outfit: number): number {
	return math.floor(outfitIndex(outfit) / OUTFITS_PER_SHEET);
}

function outfitBase(outfit: number): number {
	return (outfitIndex(outfit) % OUTFITS_PER_SHEET) * SURVIVOR_ROWS_EACH;
}

/** a standing survivor holding with `grip`, at stride `step` (-1..1) */
export function survivorRow(outfit: number, grip: number, step: number): number {
	return outfitBase(outfit) + math.clamp(grip, 0, GRIPS - 1) * STEPS + stepRow(step);
}

/** mid-swing, the blade `rel` radians off the aim: the nearest baked sweep */
export function swingRow(outfit: number, rel: number): number {
	let best = 0;
	let bestD = math.huge;
	for (let i = 0; i < SWINGS.size(); i++) {
		const d = math.abs(SWINGS[i] - rel);
		if (d < bestD) {
			bestD = d;
			best = i;
		}
	}
	return outfitBase(outfit) + SURVIVOR_ROW_SWING + best;
}

/** `drag` -1..1: which arm is pulling */
export function downedRow(outfit: number, drag: number): number {
	return outfitBase(outfit) + SURVIVOR_ROW_DOWNED + math.clamp(math.floor(drag + 1.5), 0, 2);
}

/** the grip a weapon is held with (melee weapons are Idle between swings) */
export function gripOf(kind: number): number {
	if (kind === WeaponKind.Melee) return Grip.Idle;
	if (kind === WeaponKind.Pistol) return Grip.Pistol;
	if (kind === WeaponKind.Bow) return Grip.Bow;
	return Grip.Long;
}

// ---------------------------------------------------------------- weapons

/** texels per cell: the longest blade at any heading (the golden katana swings 74 u) */
export const WEAPON_CELL = 24;
/**
 * Melee weapon ids in sheet order: each has two rows, the swing (2i: the blade from 14 u to its reach) and the idle
 * hold (2i + 1: held low, drawn shorter). Guns follow, one row each.
 */
export const MELEE_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 27, 28, 29];
export const WEAPON_ROW_GUNS = MELEE_IDS.size() * 2;
/** a representative weapon id per gun row: pistol, rifle, shotgun, MG, sniper, bow, crossbow, flamethrower, stun gun */
export const GUN_ROW_IDS = [10, 13, 16, 18, 20, 22, 23, 25, 26];
export const WEAPON_ROWS = WEAPON_ROW_GUNS + GUN_ROW_IDS.size();

const MELEE_PAIR: Record<number, number> = {};
MELEE_IDS.forEach((id, i) => {
	MELEE_PAIR[id] = i;
});

/** the row a weapon is drawn from; `idle` picks a melee weapon's hold instead of its swing */
export function weaponRow(id: number, kind: number, idle: boolean): number {
	if (kind === WeaponKind.Melee) {
		const pair = MELEE_PAIR[id] ?? 0;
		return pair * 2 + (idle ? 1 : 0);
	}
	let g = 1;
	if (id === 23) g = 6;
	else if (id === 25) g = 7;
	else if (id === 26) g = 8;
	else if (kind === WeaponKind.Pistol) g = 0;
	else if (kind === WeaponKind.Shotgun) g = 2;
	else if (kind === WeaponKind.MG) g = 3;
	else if (kind === WeaponKind.Sniper) g = 4;
	else if (kind === WeaponKind.Bow) g = 5;
	return WEAPON_ROW_GUNS + g;
}

/** how long a gun is drawn (world units), the lengths survivorView.ts has always used */
export function gunLength(kind: number): number {
	if (kind === WeaponKind.Pistol) return 22;
	if (kind === WeaponKind.Shotgun) return 40;
	if (kind === WeaponKind.MG) return 50;
	if (kind === WeaponKind.Sniper) return 56;
	return 42;
}

/** a melee weapon in the swing: from 14 u out to its reach (MELEE_REACH: the reach IS the sprite) */
export function meleeSwingLength(reach: number): number {
	return math.max(8, reach - 14);
}

/** a melee weapon held low at rest: shorter from above (survivorView.ts has always drawn it so) */
export function meleeIdleLength(reach: number): number {
	return math.max(18, reach * 0.55);
}

/** how far into a weapon's length the hand holds it, from its back end (the middle of the handle or the grip) */
export const HANDLE = 5;

// ---------------------------------------------------------------- zombies

/** texels per cell: the walker's reaching arms at any heading, the charger's shoulders, the outline and a margin */
export const ZOMBIE_CELL = 24;
/** rows: three strides per type (1..5), the spitter's two wind-ups, the jumper in the air, the charger charging */
export const ZOMBIE_ROW_WINDUP = 5 * STEPS;
export const ZOMBIE_ROW_AIR = ZOMBIE_ROW_WINDUP + 2;
export const ZOMBIE_ROW_RUSH = ZOMBIE_ROW_AIR + 1;
export const ZOMBIE_ROWS = ZOMBIE_ROW_RUSH + STEPS;
/** the radius each type is baked at (shared/data/zombies.ts `radius`): a sprite is drawn at radius / this */
export const ZOMBIE_BAKED_RADIUS = [16, 16, 16, 17, 17, 16];

/**
 * The row of a zombie of `kind` (1..5) in a pose: `windup` 0..1 (spitter), `air` (jumper), `rush` (charger), or
 * the stride `step` (-1..1). Unknown kinds draw as walkers.
 */
export function zombieRow(kind: number, step: number, windup: number, air: boolean, rush: boolean): number {
	if (kind === 2 && windup > 0.05) return windup < 0.6 ? ZOMBIE_ROW_WINDUP : ZOMBIE_ROW_WINDUP + 1;
	if (kind === 5 && air) return ZOMBIE_ROW_AIR;
	if (kind === 4 && rush) return ZOMBIE_ROW_RUSH + stepRow(step);
	const k = kind >= 1 && kind <= 5 ? kind : 1;
	return (k - 1) * STEPS + stepRow(step);
}

// ---------------------------------------------------------------- pets

/** dogs: three trot strides, then three tail wags standing, per dog (PetLook 4 Carolina, 5 Malamute, 6 Doberman) */
export const DOG_CELL = 18;
export const DOG_ROWS_EACH = STEPS + 3;
export const DOG_ROWS = 3 * DOG_ROWS_EACH;
/** birds: landed, then four wing spreads in flight, per bird (PetLook 1 Pigeon, 2 White pigeon, 3 Eagle) */
export const BIRD_CELL = 24;
export const BIRD_ROWS_EACH = 5;
export const BIRD_ROWS = 3 * BIRD_ROWS_EACH;
/** the wing spread each row was baked at: a pigeon folds its wings when it lands, the eagle never closes them */
export const PIGEON_SPREADS = [0, 0.35, 0.57, 0.78, 1];
export const EAGLE_SPREADS = [0.6, 0.85, 0.9, 0.95, 1];

/** PetLook 4..6; trotting (`swing` -1..1) or standing (`wag` -1..1) */
export function dogRow(pet: number, moving: boolean, swing: number, wag: number): number {
	const base = (math.clamp(pet, 4, 6) - 4) * DOG_ROWS_EACH;
	if (moving) return base + stepRow(swing);
	return base + STEPS + math.clamp(math.floor(wag + 1.5), 0, 2);
}

/** PetLook 1..3; `spread` 0..1 is how far the wings are open */
export function birdRow(pet: number, spread: number): number {
	const b = math.clamp(pet, 1, 3) - 1;
	const spreads = pet === 3 ? EAGLE_SPREADS : PIGEON_SPREADS;
	let best = 0;
	let bestD = math.huge;
	for (let i = 0; i < BIRD_ROWS_EACH; i++) {
		const d = math.abs(spreads[i] - spread);
		if (d < bestD) {
			bestD = d;
			best = i;
		}
	}
	return b * BIRD_ROWS_EACH + best;
}
