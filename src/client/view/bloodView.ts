/*
 * The blood of a fight on screen (docs/DESIGN_RULES.md ART-15, LEG-02): the stains on the floor and the droplets in
 * the air, from the records of client/systems/particles.ts. Two drawings, chosen by one texture:
 *
 *   FLAT (no id for `blood`, or the atlas did not load: client/view/worldArt.ts) -- exactly the drawing of before,
 *   call for call (ART-01; `npm run test:world-art` §13 holds it to tools/golden/blood-flat.json): round stains at
 *   Z.decal fading out over 10 s, round droplets at Z.particle.
 *
 *   PIXEL ART (design/world-art/blood.png, tools/blood-art.mjs) -- one sprite per stain, a cell of the atlas at the
 *   town's 4 u a texel, on the town's texel grid:
 *     - a stain is a DROP where a droplet landed, a SPLAT where a body bled (a kill, a big bite) or a SMEAR behind a
 *       hit, thrown from the attacker through the target (the hit's direction, 8 ways); its shape among its kind's
 *       and its flip come from where it lies, so every client draws the same stain;
 *     - it AGES: wet and glossy for its first 20 s (the atlas's wet bands: a survivor's bright red, the horde's dark
 *       brownish red), then matte, darker and browner in five steps until it is the brown of a game day old
 *       (COLORS.bloodDry), then it fades out in five steps by 905 s. On asphalt, grass and dirt the blood soaks in: a
 *       little darker and less red than on a floor, a sidewalk or a porch. No step flashes (Reduce Motion) and each
 *       step is one or two property writes, never one a frame;
 *     - a droplet in the air is a square of one texel (two while it is big and young), on the texel grid, in one of
 *       its blood's three tones; it flies UNDER the bodies (Z.decal + 1): blood never covers a survivor or a zombie
 *       and never an item on the ground (LEG-03). Debris (chips, sparks) is squares too, over them as before.
 *
 * Nothing here allocates per frame: the option tables are scratches, the tints are built once below, and a stain
 * looks up what it lies on once (its record keeps it).
 */
import { COLORS, Z } from "shared/engine/colors";
import { Camera, ViewRect } from "shared/engine/camera";
import { Renderer, SpriteOpts } from "shared/engine/renderer";
import { clamp } from "shared/engine/vec2";
import { buildingAt, GroundKind, hash01, Rect, WorldData } from "shared/game/world";
import {
	BLOOD_DRY_S,
	BLOOD_HORDE,
	BLOOD_LIFE_S,
	BLOOD_NONE,
	BLOOD_SURVIVOR,
	BLOOD_WET_S,
	Decal,
	DECAL_SMEAR,
	DECAL_SPLAT,
	Particle,
	ParticleSystem,
} from "../systems/particles";
import {
	BLOOD_BAND_H,
	BLOOD_CELLS,
	BLOOD_DROP_FIRST,
	BLOOD_DROPS,
	BLOOD_SMEAR_FIRST,
	BLOOD_SMEAR_SHAPES,
	BLOOD_SPLAT_FIRST,
	BLOOD_SPLATS,
} from "./bloodAtlas";
import { circleInView, mix, overlaps } from "./drawKit";
import { artId } from "./worldArt";
import { WORLD_TEXEL } from "./worldArtAssets";

/** a stain on a floor, a sidewalk, a porch: its own colours */
export const GROUND_HARD = 0;
/** a stain on asphalt, grass or dirt: it soaks in, a little darker and less red */
export const GROUND_SOAK = 1;

/** the steps from fresh to dry (after the wet seconds) and from dry to gone */
export const BLOOD_DRY_STEPS = 5;
export const BLOOD_FADE_STEPS = 5;

const WHITE = Color3.fromRGB(255, 255, 255);
const BLACK = Color3.fromRGB(0, 0, 0);
/** a droplet's light tone leans to this pale warm light, never white (LEG-01: no item's glint) */
const SHEEN = Color3.fromRGB(255, 206, 196);
/** the wet bands multiplied on a soaking ground (they carry their own colours: ImageColor3 can only darken them) */
const WET_SOAK = Color3.fromRGB(206, 220, 220);

/** what soaks blood up: the lot's ground rects that are grass, soil or asphalt */
const SOAKS: Partial<Record<GroundKind, true>> = {
	verge: true,
	pit: true,
	parking: true,
	stall: true,
	playground: true,
};

/** a colour soaked into the ground: a quarter of the way to its own grey, then 16 % darker */
function soaked(c: Color3): Color3 {
	const grey = c.R * 0.3 + c.G * 0.59 + c.B * 0.11;
	const k = 0.84;
	return new Color3(
		(c.R + (grey - c.R) * 0.25) * k,
		(c.G + (grey - c.G) * 0.25) * k,
		(c.B + (grey - c.B) * 0.25) * k,
	);
}

/** the matte band's tint for [blood][ground][step]: fresh at step 0, COLORS.bloodDry at BLOOD_DRY_STEPS */
function dryingTints(fresh: Color3): Array<Array<Color3>> {
	const hard: Array<Color3> = [];
	const soak: Array<Color3> = [];
	for (let k = 0; k <= BLOOD_DRY_STEPS; k++) {
		const c = fresh.Lerp(COLORS.bloodDry, k / BLOOD_DRY_STEPS);
		hard.push(c);
		soak.push(soaked(c));
	}
	return [hard, soak];
}
const TINT_SURVIVOR = dryingTints(COLORS.blood);
const TINT_HORDE = dryingTints(COLORS.bloodHorde);
const WET_TINT = [WHITE, WET_SOAK];

/** a droplet's three tones (base, dark, light) by its blood */
function tones(base: Color3): Array<Color3> {
	return [base, base.Lerp(BLACK, 0.3), base.Lerp(SHEEN, 0.35)];
}
const SPRAY_SURVIVOR = tones(COLORS.blood);
const SPRAY_HORDE = tones(COLORS.bloodHorde);

/*
 * The option tables, one scratch per call site (M4). The flat ones are the loop's of before, key for key: what they
 * pass is what tools/golden/blood-flat.json recorded.
 */
const DECAL_O: SpriteOpts = { zIndex: Z.decal };
const PARTICLE_O: SpriteOpts = { zIndex: Z.particle };
const STAIN_O: SpriteOpts = { zIndex: Z.decal };
/** droplets of blood in the air: under every body and every item (LEG-03) */
const SPRAY_O: SpriteOpts = { zIndex: Z.decal + 1 };
/** debris in the air (chips, sparks, dust): over the bodies, as the flat drawing puts it */
const CHIP_O: SpriteOpts = { zIndex: Z.particle };

const T = WORLD_TEXEL;

function inRect(r: Rect, x: number, y: number): boolean {
	return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

/**
 * What a stain at (x, y) lies on: GROUND_SOAK for a road (asphalt, and the planted median of an avenue), a lot's grass,
 * soil, parking lot or school yard, a park's dirt path, a house's lawn and the forest outside the fence; GROUND_HARD
 * for a building's floor, a sidewalk, a plaza, a path to a door, a driveway, a forecourt, a porch or a patio.
 */
export function bloodGround(w: WorldData, x: number, y: number): number {
	if (buildingAt(w, x, y) !== undefined) return GROUND_HARD;
	for (const road of w.roads) if (inRect(road, x, y)) return GROUND_SOAK;
	for (const lot of w.lots) {
		if (!inRect(lot, x, y)) continue;
		for (const g of lot.ground) if (inRect(g, x, y)) return SOAKS[g.kind] === true ? GROUND_SOAK : GROUND_HARD;
		for (const p of lot.paths) if (inRect(p, x, y)) return GROUND_SOAK;
		if (inRect(lot.yard, x, y)) return lot.zone === "commercial" ? GROUND_HARD : GROUND_SOAK;
		return GROUND_HARD;
	}
	return GROUND_SOAK;
}

/** true while the blood's atlas has an id and loaded: the pixel art draws the blood (else the flat drawing does) */
export function bloodArtLive(): boolean {
	return artId("blood") !== undefined;
}

/** the atlas cell of a stain (band 0), by its kind, its shape pick and a smear's direction */
export function stainCell(kind: number, pick: number, sector: number): number {
	if (kind === DECAL_SMEAR && sector >= 0) {
		return (
			BLOOD_SMEAR_FIRST +
			sector * BLOOD_SMEAR_SHAPES +
			(math.floor(pick * BLOOD_SMEAR_SHAPES) % BLOOD_SMEAR_SHAPES)
		);
	}
	if (kind === DECAL_SPLAT) return BLOOD_SPLAT_FIRST + (math.floor(pick * BLOOD_SPLATS) % BLOOD_SPLATS);
	return BLOOD_DROP_FIRST + (math.floor(pick * BLOOD_DROPS) % BLOOD_DROPS);
}

/** which band draws a stain of `src` blood this `age` old: its wet band, or 0 (matte) once it stopped shining */
export function stainBand(src: number, age: number): number {
	if (age >= BLOOD_WET_S) return 0;
	if (src === BLOOD_SURVIVOR) return 1;
	if (src === BLOOD_HORDE) return 2;
	return 0;
}

/** the opacity of a stain this `age` old: 1 until it is dry, then down in BLOOD_FADE_STEPS steps */
export function stainAlpha(age: number): number {
	if (age < BLOOD_DRY_S) return 1;
	const f = math.floor(((age - BLOOD_DRY_S) / (BLOOD_LIFE_S - BLOOD_DRY_S)) * BLOOD_FADE_STEPS);
	return 1 - math.min(f, BLOOD_FADE_STEPS - 1) / BLOOD_FADE_STEPS;
}

/** how far along the drying a matte stain this `age` old is: 0 (fresh) .. BLOOD_DRY_STEPS (a game day old) */
export function stainStep(age: number): number {
	const k = math.floor(((age - BLOOD_WET_S) / (BLOOD_DRY_S - BLOOD_WET_S)) * BLOOD_DRY_STEPS);
	return math.clamp(k, 0, BLOOD_DRY_STEPS);
}

/** the ImageColor3 a stain is drawn with: its wet band as authored (darker on soaking ground), else its drying tint */
export function stainTint(d: Decal, band: number, ground: number): Color3 {
	if (band > 0) return WET_TINT[ground];
	const step = stainStep(d.age);
	if (d.src === BLOOD_SURVIVOR) return TINT_SURVIVOR[ground][step];
	if (d.src === BLOOD_HORDE) return TINT_HORDE[ground][step];
	return d.color;
}

export class BloodView {
	/** every stain of `ps` in view, flat or in pixel art as the atlas decides */
	drawDecals(r: Renderer, cam: Camera, v: ViewRect, ps: ParticleSystem, world: WorldData): void {
		const id = artId("blood");
		for (const d of ps.decalRecords()) this.drawDecal(r, cam, v, d, world, id);
	}

	/** one stain; `id` is the atlas's (undefined: the flat drawing) */
	drawDecal(r: Renderer, cam: Camera, v: ViewRect, d: Decal, world: WorldData, id: string | undefined): void {
		if (id === undefined) {
			if (d.life <= 0 || !circleInView(d.x, d.y, d.size, v)) return;
			const o = DECAL_O;
			o.color = d.color;
			o.alpha = 0.7 * math.min(1, d.life / 5);
			r.drawCircle(cam, d.x, d.y, d.size, o);
			return;
		}
		if (d.age >= BLOOD_LIFE_S) return;
		if (d.pick < 0) d.pick = hash01(math.floor(d.x), math.floor(d.y), 41);
		const c = BLOOD_CELLS[stainCell(d.kind, d.pick, d.sector)];
		const w = c[2] * T;
		const h = c[3] * T;
		// on the town's texel grid: the stain's texels sit on the asphalt's and the floor's
		const left = math.floor((d.x - c[4] * T) / T + 0.5) * T;
		const top = math.floor((d.y - c[5] * T) / T + 0.5) * T;
		if (!overlaps(left, top, w, h, v)) return;
		if (d.ground < 0) d.ground = bloodGround(world, d.x, d.y);
		const band = stainBand(d.src, d.age);
		const o = STAIN_O;
		o.image = id;
		o.w = w;
		o.h = h;
		o.rectX = c[0];
		o.rectY = c[1] + band * BLOOD_BAND_H;
		o.rectW = c[2];
		o.rectH = c[3];
		o.imageTint = stainTint(d, band, d.ground);
		o.alpha = stainAlpha(d.age);
		r.drawRect(cam, left + w / 2, top + h / 2, o);
	}

	/** every droplet and chip of `ps` in view */
	drawParticles(r: Renderer, cam: Camera, v: ViewRect, ps: ParticleSystem): void {
		const art = artId("blood") !== undefined;
		for (const p of ps.active()) this.drawParticle(r, cam, v, p, art);
	}

	/** one droplet or chip: a round one as before, or with the art a square of the town's texels */
	drawParticle(r: Renderer, cam: Camera, v: ViewRect, p: Particle, art: boolean): void {
		if (!art) {
			if (!circleInView(p.x, p.y, p.size, v)) return;
			const o = PARTICLE_O;
			o.color = p.color;
			o.alpha = clamp((p.life / p.maxLife) * 1.5, 0, 1);
			r.drawCircle(cam, p.x, p.y, p.size, o);
			return;
		}
		// two texels while big and young, one after: it shrinks as it flies, it never fades (nothing flickers)
		const s = p.size >= 6 && p.life > p.maxLife * 0.5 ? 2 * T : T;
		const left = math.floor((p.x - s / 2) / T + 0.5) * T;
		const top = math.floor((p.y - s / 2) / T + 0.5) * T;
		if (!overlaps(left, top, s, s, v)) return;
		let o: SpriteOpts;
		let color: Color3;
		if (p.src === BLOOD_SURVIVOR) {
			o = SPRAY_O;
			color = SPRAY_SURVIVOR[p.tone];
		} else if (p.src === BLOOD_HORDE) {
			o = SPRAY_O;
			color = SPRAY_HORDE[p.tone];
		} else {
			o = p.src === BLOOD_NONE ? CHIP_O : SPRAY_O;
			color = p.tone === 1 ? mix(p.color, BLACK, 0.3) : p.color;
		}
		o.color = color;
		o.w = s;
		o.h = s;
		r.drawRect(cam, left + s / 2, top + s / 2, o);
	}
}
