/*
 * Where each pose of each character sits in the characters' sprite sheets (design/world-art: survivors, arms,
 * weapons, zombies, dogs, birds, and the white Fill / Rim masks of survivors and zombies). tools/character-art.mjs
 * writes the sheets from this layout and client/view/charArt.ts reads them with it, so the two can never point at
 * different cells (docs/DESIGN_RULES.md ART-07). Every sheet stays within 1024 x 1024 texels, the largest image
 * Roblox keeps at full resolution.
 *
 * A sheet is a grid of square cells, one texel = 4 world units (WORLD_TEXEL, like the town). COLUMN = heading: every
 * pose is drawn at CHAR_DIRS screen headings, so a character sprite is never rotated on screen -- its texels stay on
 * the square grid of the town's, and the light baked into it stays at the top left of the screen (ART-02). ROW = pose
 * (a stride of the walk, a wind-up, a flight, an arm's length, a weapon).
 *
 * Every cell is an even number of texels: a character is drawn as a few sprites (body, arms, weapon), each centred on
 * a point snapped to whole texels from the body's centre, and with even cells their texel grids coincide on screen.
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

/** strides baked per walk cycle: -1, -0.5, 0, 0.5, 1 of a full stride */
export const STEPS = 5;

/** the row offset of a stride (-1..1): the nearest baked one */
export function stepRow(step: number): number {
	return math.clamp(math.floor((step + 1) * 2 + 0.5), 0, STEPS - 1);
}

/** the stride a row offset was baked at (the generator's side of stepRow) */
export function rowStep(row: number): number {
	return row / 2 - 1;
}

// ---------------------------------------------------------------- zombies

/** texels per cell: the walker's reaching arms at any heading, the exploder's belly, the outline and a margin */
export const ZOMBIE_CELL = 24;
/** rows: five strides per type (1..5), the spitter's two wind-ups, the jumper in the air, the charger charging */
export const ZOMBIE_ROW_WINDUP = 25;
export const ZOMBIE_ROW_AIR = 27;
export const ZOMBIE_ROW_RUSH = 28;
export const ZOMBIE_ROWS = 33;
/** the radius each type is baked at (shared/data/zombies.ts `radius`): a sprite is drawn at radius / this */
export const ZOMBIE_BAKED_RADIUS = [16, 16, 16, 17, 17, 16];

/**
 * The row of a zombie of `kind` (1..5) in a pose: `windup` 0..1 (spitter), `air` (jumper), `rush` (charger), or
 * the stride `step` (-1..1). Unknown kinds draw as walkers.
 */
export function zombieRow(kind: number, step: number, windup: number, air: boolean, rush: boolean): number {
	if (kind === 2 && windup > 0.05) return windup < 0.75 ? ZOMBIE_ROW_WINDUP : ZOMBIE_ROW_WINDUP + 1;
	if (kind === 5 && air) return ZOMBIE_ROW_AIR;
	if (kind === 4 && rush) return ZOMBIE_ROW_RUSH + stepRow(step);
	const k = kind >= 1 && kind <= 5 ? kind : 1;
	return (k - 1) * STEPS + stepRow(step);
}

// ---------------------------------------------------------------- survivors

/** OutfitLook 0..3 (shared/data/cosmetics.ts) */
export const OUTFITS = 4;
/** texels per cell: a downed survivor lying full length, the cowboy's brim */
export const SURVIVOR_CELL = 20;
/**
 * A standing survivor is two layers, because the arms go between them: the BODY (boots, torso, pack) under the
 * arms, and the HEAD (hair, or the hat with its brim and Santa's pom-pom) over them -- from above, a hand held
 * up by the shoulder passes under the brim, never over the face.
 *
 * rows: five strides per outfit (body), one head per outfit, then three crawl poses per outfit (downed, MP-03: one
 * cell, no arms of their own to place, no weapon)
 */
export const SURVIVOR_ROW_HEAD = OUTFITS * STEPS;
export const SURVIVOR_ROW_DOWNED = SURVIVOR_ROW_HEAD + OUTFITS;
export const SURVIVOR_ROWS = SURVIVOR_ROW_DOWNED + OUTFITS * 3;
/**
 * The Fill and Rim masks have the walking BODY rows only: a hit and the poison colour the torso, as the flat drawing
 * always did, and the flat drawing never flashed a downed body either.
 */
export const SURVIVOR_MASK_ROWS = SURVIVOR_ROW_HEAD;

function outfitIndex(outfit: number): number {
	return outfit >= 0 && outfit < OUTFITS ? outfit : 0;
}

/** the body of a standing survivor at stride `step` (-1..1) */
export function survivorRow(outfit: number, step: number): number {
	return outfitIndex(outfit) * STEPS + stepRow(step);
}

/** the head (or hat) of a standing survivor */
export function headRow(outfit: number): number {
	return SURVIVOR_ROW_HEAD + outfitIndex(outfit);
}

/** `drag` -1..1: which arm is pulling */
export function downedRow(outfit: number, drag: number): number {
	return SURVIVOR_ROW_DOWNED + outfitIndex(outfit) * 3 + math.clamp(math.floor(drag + 1.5), 0, 2);
}

/** where the arms leave the body (body frame, world units): the shoulder joints under the torso's edge */
export const SHOULDER_F = 1;
export const SHOULDER_L = 10;

/** an arm is baked at each of these lengths (shoulder to the hand's centre, world units), per outfit */
export const ARM_LENGTHS = [8, 12, 16, 20, 25, 30, 36, 42, 48];
export const ARM_CELL = 18;
export const ARM_ROWS = OUTFITS * ARM_LENGTHS.size();

/** the baked length nearest `len` (an index into ARM_LENGTHS) */
export function armLengthIndex(len: number): number {
	let best = 0;
	let bestD = math.huge;
	for (let i = 0; i < ARM_LENGTHS.size(); i++) {
		const d = math.abs(ARM_LENGTHS[i] - len);
		if (d < bestD) {
			bestD = d;
			best = i;
		}
	}
	return best;
}

export function armRow(outfit: number, lengthIndex: number): number {
	return outfitIndex(outfit) * ARM_LENGTHS.size() + lengthIndex;
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

// ---------------------------------------------------------------- pets

/** dogs: five trot strides, then three tail wags standing, per dog (PetLook 4 Carolina, 5 Malamute, 6 Doberman) */
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
