/*
 * The characters' pixel art at run time (docs/DESIGN_RULES.md ART-08..ART-11): the survivors, the horde and the pets
 * drawn from the sprite sheets tools/character-art.mjs bakes (design/world-art: survivorsA / B, weapons, zombies, dogs,
 * birds and the white Fill / Rim masks), laid out by client/view/charSheets.ts.
 *
 * WHY SHEETS, AND NOT ROTATED SPRITES. Every pose is baked at CHAR_DIRS (32) screen headings, and a character sprite
 * is always drawn UNROTATED on screen, from the column of its heading (ImageRectOffset). A rotated Pixelated
 * ImageLabel samples its texels in its own turned frame (ResamplerMode.Pixelated is nearest-neighbour of the
 * closest image pixel), so its "pixels" would be diamonds and stairs crossing the town's square grid, and the light
 * baked from the top left would swing round with the body. Pre-drawn headings keep the texels square and on the
 * town's 4-units-per-texel scale, and the light where the town's is (ART-02).
 *
 * WHAT IT COSTS. One Frame + ImageLabel per layer, from the renderer's pool: a zombie is ONE sprite (plus its round
 * shadow), a pet one, a survivor two -- the whole body with its arms baked per grip, and the weapon under it. The
 * flat drawing it replaces spent 5-7 Frames on a zombie and 8-14 on a survivor. A hit or the exploder's fuse adds
 * the two masks while it lasts: Fill (the silhouette, tinted with the flash colour at the flash's strength) and Rim
 * (the outline, tinted with the outline colour of the flat drawing). Nothing here allocates: one scratch SpriteOpts,
 * colours built once (tools/test-world-art.mjs §10 measures a horde of 60, flat against art).
 *
 * WITHOUT IDS, NOTHING CHANGES (ART-01). Each group only draws when every sheet it needs has an asset id (survivors:
 * both outfit sheets, their masks and the weapons; zombies: sheet and masks; dogs; birds); otherwise these functions
 * answer false and the caller draws the flat look it always drew, with the same calls. So the game is unchanged
 * until the owner's next `npm run cloud -- upload-art`, and a half-finished upload shows only the complete groups.
 */
import { Camera } from "shared/engine/camera";
import { COLORS } from "shared/engine/colors";
import { Renderer, SpriteOpts } from "shared/engine/renderer";
import {
	BIRD_CELL,
	DOG_CELL,
	SURVIVOR_CELL,
	WEAPON_CELL,
	ZOMBIE_BAKED_RADIUS,
	ZOMBIE_CELL,
	birdRow,
	dirIndex,
	dogRow,
	survivorSheet,
	zombieRow,
} from "./charSheets";
import { artId } from "./worldArt";
import { WORLD_TEXEL, WorldArtName } from "./worldArtAssets";

const WHITE = COLORS.white;

/** the half width of the flat humanoid (humanoidView: `sc` = radius / this); the art converts it back to a radius */
const HUMANOID_HALF_WIDTH = 18;

// ---------------------------------------------------------------- which groups are live

/** the survivors' sheets, their Fill and Rim masks: A holds outfits 0-1, B outfits 2-3 (charSheets.survivorSheet) */
const SURVIVOR_SHEETS: ReadonlyArray<readonly [WorldArtName, WorldArtName, WorldArtName]> = [
	["survivorsA", "survivorsAFill", "survivorsARim"],
	["survivorsB", "survivorsBFill", "survivorsBRim"],
];

/** every sheet a survivor needs (each outfit's cells, their masks, the weapons), or the survivor is drawn flat */
export function survivorArtLive(): boolean {
	for (const names of SURVIVOR_SHEETS) {
		for (const name of names) if (artId(name) === undefined) return false;
	}
	return artId("weapons") !== undefined;
}

export function zombieArtLive(): boolean {
	return artId("zombies") !== undefined && artId("zombiesFill") !== undefined && artId("zombiesRim") !== undefined;
}

// ---------------------------------------------------------------- one cell

/** the scratch every sprite of this file is drawn with; every field is written on every call */
const O: SpriteOpts = {};

/**
 * One cell of a sheet, UNROTATED on screen (the heading is the column), centred on (x, y), `scale` times its baked
 * size. `tint` multiplies the image (ImageColor3): white for the full-colour sheets, the flash / outline colour for
 * a white mask.
 */
export function drawCell(
	r: Renderer,
	cam: Camera,
	id: string,
	cell: number,
	col: number,
	row: number,
	x: number,
	y: number,
	scale: number,
	z: number,
	alpha: number,
	tint: Color3,
): void {
	const size = cell * WORLD_TEXEL * scale;
	O.w = size;
	O.h = size;
	// the renderer adds the camera's angle: this cancels it, so the cell is upright on screen
	O.rotation = -cam.angle;
	O.image = id;
	O.imageTint = tint;
	O.alpha = alpha;
	O.zIndex = z;
	O.rectX = col * cell;
	O.rectY = row * cell;
	O.rectW = cell;
	O.rectH = cell;
	O.scaleType = undefined;
	O.pixelated = undefined;
	O.color = undefined;
	O.cornerRadius = undefined;
	O.circle = undefined;
	O.stroke = undefined;
	O.strokeThickness = undefined;
	O.strokeAlpha = undefined;
	O.anchorX = undefined;
	O.anchorY = undefined;
	r.drawRect(cam, x, y, O);
}

/** the column of something facing world heading `a` (the camera may be turned) */
export function columnOf(cam: Camera, a: number): number {
	return dirIndex(a + cam.angle);
}

/** result of `snapped` (one scratch point: read it before the next call) */
export const SNAP = { x: 0, y: 0 };

/**
 * (x, y) moved so its offset from the anchor (ax, ay) is a whole number of texels on SCREEN: a survivor is two
 * sprites (the body and the weapon), and with every cell an even number of texels wide their texel grids then
 * coincide, so the weapon never looks drawn on a finer or shifted grid than the hands holding it.
 */
export function snapped(cam: Camera, ax: number, ay: number, x: number, y: number, scale: number): void {
	const t = WORLD_TEXEL * scale;
	const dx = x - ax;
	const dy = y - ay;
	const ang = cam.angle;
	if (ang === 0) {
		SNAP.x = ax + math.floor(dx / t + 0.5) * t;
		SNAP.y = ay + math.floor(dy / t + 0.5) * t;
		return;
	}
	const c = math.cos(ang);
	const s = math.sin(ang);
	const sx = math.floor((dx * c - dy * s) / t + 0.5) * t;
	const sy = math.floor((dx * s + dy * c) / t + 0.5) * t;
	SNAP.x = ax + sx * c + sy * s;
	SNAP.y = ay - sx * s + sy * c;
}

// ---------------------------------------------------------------- survivors' pieces

/** a weapon in the hands: its long axis along world heading `a`, centred on (cx, cy), snapped to the body */
export function drawWeaponCell(
	r: Renderer,
	cam: Camera,
	row: number,
	bodyX: number,
	bodyY: number,
	cx: number,
	cy: number,
	a: number,
	z: number,
): void {
	snapped(cam, bodyX, bodyY, cx, cy, 1);
	drawCell(r, cam, artId("weapons") ?? "", WEAPON_CELL, columnOf(cam, a), row, SNAP.x, SNAP.y, 1, z, 1, WHITE);
}

/** a cell of an outfit's survivor sheet (a grip and stride, a swing or a crawl): 0 colour, 1 Fill, 2 Rim */
export function drawSurvivorCell(
	r: Renderer,
	cam: Camera,
	outfit: number,
	layer: number,
	row: number,
	col: number,
	x: number,
	y: number,
	z: number,
	alpha: number,
	tint: Color3,
): void {
	const id = artId(SURVIVOR_SHEETS[survivorSheet(outfit)][layer]) ?? "";
	drawCell(r, cam, id, SURVIVOR_CELL, col, row, x, y, 1, z, alpha, tint);
}

// ---------------------------------------------------------------- zombies

/**
 * A zombie of type `kind` (1..5) from the zombies sheet, or false when that sheet is not live (the caller then
 * draws the flat humanoid). The arguments are the flat drawing's (humanoidView.drawHumanoid): `sc` is its scale
 * (radius / 18, times the jumper's lift), `flash` 0..1 the hit flash, `windup` the spitter's 0..10; `air` is a
 * jumper in flight, `rush` a charger charging, `blink` the lit fuse's red beat (red body, yellow outline).
 */
export function drawZombieArt(
	r: Renderer,
	cam: Camera,
	x: number,
	y: number,
	a: number,
	sc: number,
	kind: number,
	flash: number,
	alpha: number,
	phase: number,
	z: number,
	windup: number,
	air: boolean,
	rush: boolean,
	blink: boolean,
): boolean {
	if (!zombieArtLive()) return false;
	const k = kind >= 1 && kind <= 5 ? kind : 1;
	const scale = (sc * HUMANOID_HALF_WIDTH) / ZOMBIE_BAKED_RADIUS[k];
	const row = zombieRow(k, math.sin(phase), windup / 10, air, rush);
	const col = columnOf(cam, a);
	drawCell(r, cam, artId("zombies") ?? "", ZOMBIE_CELL, col, row, x, y, scale, z, alpha, WHITE);
	if (blink) {
		// the lit fuse: the flat drawing turns the body 80% red with a yellow outline, so does this
		drawCell(
			r,
			cam,
			artId("zombiesFill") ?? "",
			ZOMBIE_CELL,
			col,
			row,
			x,
			y,
			scale,
			z + 1,
			0.8 * alpha,
			COLORS.uiRed,
		);
		drawCell(r, cam, artId("zombiesRim") ?? "", ZOMBIE_CELL, col, row, x, y, scale, z + 2, alpha, COLORS.uiYellow);
	} else if (flash > 0) {
		// a hit: towards white by 75% of the flash, with the white outline (LEG-02: white is "hit", red is you)
		drawCell(
			r,
			cam,
			artId("zombiesFill") ?? "",
			ZOMBIE_CELL,
			col,
			row,
			x,
			y,
			scale,
			z + 1,
			0.75 * flash * alpha,
			WHITE,
		);
		drawCell(r, cam, artId("zombiesRim") ?? "", ZOMBIE_CELL, col, row, x, y, scale, z + 2, alpha, WHITE);
	}
	return true;
}

// ---------------------------------------------------------------- pets

/** a dog (PetLook 4..6) trotting (`moving` > 0.5, stride from `phase`) or standing and wagging (`wag` -1..1) */
export function drawDogArt(
	r: Renderer,
	cam: Camera,
	pet: number,
	x: number,
	y: number,
	a: number,
	moving: number,
	phase: number,
	wag: number,
	z: number,
): boolean {
	const id = artId("dogs");
	if (id === undefined) return false;
	const row = dogRow(pet, moving > 0.5, math.sin(phase), wag);
	drawCell(r, cam, id, DOG_CELL, columnOf(cam, a), row, x, y, 1, z, 1, WHITE);
	return true;
}

/** a bird (PetLook 1..3) with its wings `open` 0..1, drawn at (x, y) (already lifted by the caller) */
export function drawBirdArt(
	r: Renderer,
	cam: Camera,
	pet: number,
	x: number,
	y: number,
	a: number,
	open: number,
	z: number,
): boolean {
	const id = artId("birds");
	if (id === undefined) return false;
	drawCell(r, cam, id, BIRD_CELL, columnOf(cam, a), birdRow(pet, open), x, y, 1, z, 1, WHITE);
	return true;
}
