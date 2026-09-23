/*
 * Where each pose of each character sits in the characters' sprite sheets (design/world-art: zombies, zombiesFill,
 * survivors, survivorsFill, dogs, birds). tools/character-art.mjs writes the sheets from this layout and
 * client/view/charArt.ts reads them with it, so the two can never point at different cells.
 *
 * A sheet is a grid of square cells, one texel = 4 world units (WORLD_TEXEL, like the town). COLUMN = heading: the
 * pose is drawn at CHAR_DIRS headings, so the sprite is never rotated on screen and its texels stay on the same
 * square grid as the town's (ART-07); ROW = pose (a stride of the walk, a wind-up, a flight). The light is baked
 * per heading from the top left of the SCREEN, which is why it can be: a sprite that never turns never carries its
 * highlight round to the wrong side.
 *
 * The "Fill" sheets are the same cells as white silhouettes, drawn over the body tinted with ImageColor3 for the
 * hit flash, the lit exploder's blink and poison (LEG-02): ImageColor3 multiplies, so a tint can only darken the
 * colour sheet, never flash it white.
 *
 * No engine, no renderer here: the generator loads this file under Node.
 */

/** headings per turn in every sheet: 11.25 degrees apart */
export const CHAR_DIRS = 32;

/** the column of a screen heading (radians, 0 = facing screen right, y down) */
export function dirIndex(screenHeading: number): number {
	const t = (screenHeading / (math.pi * 2)) * CHAR_DIRS;
	const i = math.floor(t + 0.5) % CHAR_DIRS;
	return i < 0 ? i + CHAR_DIRS : i;
}

/** the screen heading a column is drawn at (the generator's side of dirIndex) */
export function dirHeading(dir: number): number {
	return (dir / CHAR_DIRS) * math.pi * 2;
}

/** stride steps baked per walk cycle: -1, -0.5, 0, 0.5, 1 of a full stride */
export const STEPS = 5;

/** the row offset of a stride (-1..1, times the walk's amplitude): the nearest baked step */
export function stepRow(step: number): number {
	return math.clamp(math.floor((step + 1) * 2 + 0.5), 0, STEPS - 1);
}

/** the stride a row offset was baked at (the generator's side of stepRow) */
export function rowStep(row: number): number {
	return row / 2 - 1;
}

// ---------------------------------------------------------------- zombies

/** texels per cell: the walker's reaching arms at any heading, the big exploder, the outline */
export const ZOMBIE_CELL = 20;
/** rows: five strides per type (1..5), then the spitter's two wind-ups and the jumper in the air */
export const ZOMBIE_ROW_WINDUP = 25;
export const ZOMBIE_ROW_AIR = 27;
export const ZOMBIE_ROWS = 28;

/** the row of a zombie of `type` (1..5) in a pose: `windup` 0..1 (spitter), `air` (jumper) or the stride */
export function zombieRow(type: number, step: number, windup: number, air: boolean): number {
	if (type === 2 && windup > 0.05) return windup < 0.75 ? ZOMBIE_ROW_WINDUP : ZOMBIE_ROW_WINDUP + 1;
	if (type === 5 && air) return ZOMBIE_ROW_AIR;
	const t = type >= 1 && type <= 5 ? type : 1;
	return (t - 1) * STEPS + stepRow(step);
}

// ---------------------------------------------------------------- survivors

/** texels per cell: a downed survivor lying full length, the cowboy's brim */
export const SURVIVOR_CELL = 18;
/** rows: five strides per outfit (0..3), then three crawl poses per outfit (downed, MP-03) */
export const SURVIVOR_ROW_DOWNED = 20;
export const SURVIVOR_ROWS = 32;
/** the Fill sheet has the walking rows only: a downed body never flashes */
export const SURVIVOR_FILL_ROWS = 20;
export const OUTFITS = 4;

export function survivorRow(outfit: number, step: number): number {
	const o = outfit >= 0 && outfit < OUTFITS ? outfit : 0;
	return o * STEPS + stepRow(step);
}

export function downedRow(outfit: number, drag: number): number {
	const o = outfit >= 0 && outfit < OUTFITS ? outfit : 0;
	return SURVIVOR_ROW_DOWNED + o * 3 + math.clamp(math.floor(drag + 1.5), 0, 2);
}

// ---------------------------------------------------------------- pets

/** dogs: five trot strides, then three tail wags standing, per dog (Carolina, Malamute, Doberman) */
export const DOG_CELL = 18;
export const DOG_ROWS_EACH = 8;
export const DOG_ROWS = 24;
/** birds: landed, then four wing spreads in flight, per bird (Pigeon, White pigeon, Eagle) */
export const BIRD_CELL = 22;
export const BIRD_ROWS_EACH = 5;
export const BIRD_ROWS = 15;
/** the wing spread each flight row was baked at, per bird kind: [landed, flight 1..4] */
export const PIGEON_SPREADS = [0, 0.35, 0.57, 0.78, 1];
export const EAGLE_SPREADS = [0.6, 0.85, 0.9, 0.95, 1];

/** PetLook 4..6 -> dog index 0..2 */
export function dogRow(pet: number, moving: boolean, swing: number, wag: number): number {
	const base = (math.clamp(pet, 4, 6) - 4) * DOG_ROWS_EACH;
	if (moving) return base + stepRow(swing);
	return base + STEPS + math.clamp(math.floor(wag + 1.5), 0, 2);
}

/** PetLook 1..3 -> bird index 0..2; `spread` 0..1 is how far the wings are open */
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
