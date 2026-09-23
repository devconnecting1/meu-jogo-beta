/*
 * The characters as shapes: every survivor (you and your allies, with each outfit), every pet and every zombie type,
 * described ONCE, in the body's own frame, with their palettes (docs/DESIGN_RULES.md ART-07..ART-10).
 *
 * Two things read this model, and that is the point of having one:
 *
 *   the pixel art   tools/character-art.mjs loads this very file (through tools/luau-shim.mjs) and rasterises every
 *                   pose at every heading into the sprite sheets of design/world-art (4 world units per texel, a
 *                   near-black outline, the colour ramps below lit from the top left, grime and blood per texel);
 *   the flat body   client/view/charArt.ts `drawFlat` draws the parts flagged F_FLAT as plain Frames: what every
 *                   client shows until the sheets are uploaded (ART-01's rule for the town: no id, no texture).
 *
 * So the flat body and the pixel art can never disagree on a silhouette, a size or a colour: they are the same
 * list of parts, one drawn as rects, the other rasterised with more detail (the parts flagged F_ART only: rags,
 * straps, hair, blood speckles).
 *
 * Units: world units at scale 1 (a humanoid is 36 u across the shoulders, the survivor's hitbox, SURVIVOR_R = 18).
 * `f` runs along the heading, `l` to the body's right (drawKit.part's frame); `w` is the size along the heading,
 * `h` across it. Sizes are the FILL: the pixel art adds a one-texel (4 u) outline around the silhouette, the flat
 * body a stroke of the same weight, so both land on about the hitbox.
 *
 * Nothing here touches the engine: no Instance, no service, no renderer. Every builder writes into a PartList whose
 * part objects are reused, so drawing a character allocates nothing per frame (tools/test-cosmetics.mjs counts).
 */
import { COLORS } from "shared/engine/colors";

// ---------------------------------------------------------------- parts

export const PART_BOX = 0;
export const PART_OVAL = 1;

/** how the pixel art fills a part (the flat body only ever uses the ramp's `base`) */
export const MAT_PLAIN = 0;
/** cloth: a few grime specks and worn texels (an apocalypse a few days old: nothing is clean) */
export const MAT_CLOTH = 1;
export const MAT_SKIN = 2;
/** infected skin: blotches of rot */
export const MAT_ROT = 3;
/** hair and fur tufts: strands in two tones */
export const MAT_HAIR = 4;
/** blood and ooze: an irregular splotch, unlit, wet core and dried rim */
export const MAT_BLOOD = 5;
/** a coat of fur or feathers: soft speckle */
export const MAT_FUR = 6;
/** lit from inside (the spitter's acid sac, the exploder's boils): bright core, no shadow side */
export const MAT_GLOW = 7;
/** torn cloth: ragged edges and holes where what is under shows through */
export const MAT_RAG = 8;
/** metal and buckles: hard highlight */
export const MAT_METAL = 9;

/** drawn by the flat body (client/view/charArt.ts drawFlat) */
export const F_FLAT = 1;
/** rasterised into the pixel art (tools/character-art.mjs) */
export const F_ART = 2;
/** outlined: a near-black stroke in the flat body, a dark contact line on the part below it in the pixel art */
export const F_EDGE = 4;
/** takes the hit flash and the status tints (LEG-02) in the flat body */
export const F_FLASH = 8;
/** the main mass (the torso): the one the flat body gives the thick hit outline, as before */
export const F_MAIN = 16;
/** stands above what is under it: casts a one-texel shadow down-right in the pixel art (a head on the shoulders) */
export const F_LIFT = 32;

/** a colour ramp: the deepest line, shadow, base and light (pixel-art ramps: shadows cool, lights warm) */
export interface Ramp {
	deep: Color3;
	dark: Color3;
	base: Color3;
	light: Color3;
}

/** the ramp of a base colour; shadows shift cool and saturated, lights warm, as a pixel artist picks them */
export function rampOf(r: number, g: number, b: number): Ramp {
	const k = (v: number) => math.clamp(math.floor(v + 0.5), 0, 255);
	return {
		deep: Color3.fromRGB(k(r * 0.36 + 4), k(g * 0.36 + 3), k(b * 0.42 + 8)),
		dark: Color3.fromRGB(k(r * 0.66), k(g * 0.68), k(b * 0.78 + 6)),
		base: Color3.fromRGB(r, g, b),
		light: Color3.fromRGB(k(r + (255 - r) * 0.3 + 6), k(g + (248 - g) * 0.28 + 4), k(b + (222 - b) * 0.22)),
	};
}

/** a ramp whose base is exactly `c` (so the flat body keeps a palette colour to the bit) */
function rampOfColor(c: Color3): Ramp {
	return rampOf(math.floor(c.R * 255 + 0.5), math.floor(c.G * 255 + 0.5), math.floor(c.B * 255 + 0.5));
}

/** one shape of a character, in the body's frame (see the header); refilled in place, never kept */
export interface CharPart {
	shape: number;
	f: number;
	l: number;
	w: number;
	h: number;
	/** turned a further `tilt` radians from the heading */
	tilt: number;
	/** corner radius of a box (world units) */
	round: number;
	ramp: Ramp;
	/** stacking order: the flat body draws it at `z + layer`; the pixel art paints higher layers on top */
	layer: number;
	mat: number;
	flags: number;
}

/**
 * The parts of one character in one pose. `begin(scale)` empties it; `add` reuses the part objects of earlier
 * frames, so after the first frame of the biggest character nothing is ever allocated.
 */
export class PartList {
	readonly parts = new Array<CharPart>();
	n = 0;
	private k = 1;

	begin(scale = 1): void {
		this.n = 0;
		this.k = scale;
	}

	add(
		shape: number,
		f: number,
		l: number,
		w: number,
		h: number,
		tilt: number,
		round: number,
		ramp: Ramp,
		layer: number,
		mat: number,
		flags: number,
	): void {
		let p = this.parts[this.n] as CharPart | undefined;
		if (p === undefined) {
			p = { shape, f: 0, l: 0, w: 0, h: 0, tilt: 0, round: 0, ramp, layer: 0, mat: 0, flags: 0 };
			this.parts.push(p);
		}
		const k = this.k;
		p.shape = shape;
		p.f = f * k;
		p.l = l * k;
		p.w = w * k;
		p.h = h * k;
		p.tilt = tilt;
		p.round = round * k;
		p.ramp = ramp;
		p.layer = layer;
		p.mat = mat;
		p.flags = flags;
		this.n++;
	}

	box(f: number, l: number, w: number, h: number, tilt: number, round: number, ramp: Ramp, layer: number, mat: number, flags: number): void {
		this.add(PART_BOX, f, l, w, h, tilt, round, ramp, layer, mat, flags);
	}

	oval(f: number, l: number, w: number, h: number, tilt: number, ramp: Ramp, layer: number, mat: number, flags: number): void {
		this.add(PART_OVAL, f, l, w, h, tilt, 0, ramp, layer, mat, flags);
	}
}

/** the flags almost every visible mass carries */
const SOLID = F_FLAT + F_ART + F_EDGE;
/** a detail only the pixel art has room for */
const ART = F_ART;
/** a detail the flat body draws too (no outline) */
const MARK = F_FLAT + F_ART;

/** iterate a body's two sides without building a table per call */
const SIDES = [-1, 1];

// ---------------------------------------------------------------- palettes

/** the outline ink of the pixel art (near black, a hint of warmth) */
export const OUTLINE_INK = Color3.fromRGB(20, 17, 20);
/** the flat body's stroke: the same ink */
export const FLAT_EDGE = OUTLINE_INK;

/** dried blood: the town's dried-blood decals (ART-04) and the victims' blood on a zombie's mouth and hands */
const BLOOD_DRY = rampOf(96, 26, 24);
const BLOOD_WET = rampOf(132, 28, 30);
/** a zombie's own wounds bleed green-black (LEG-02: green is zombie blood) */
const OOZE = rampOf(66, 92, 38);

// survivors -------------------------------------------------------------------

/** the plain survivor's work jacket: the survivors' blue (MP-08 reads it as "one of us" across the screen) */
const JACKET = rampOf(74, 128, 190);
const JACKET_PATCH = rampOf(104, 96, 78);
/** the backpack: faded olive canvas. No zombie carries one: it is the survivor's signature from above (P3) */
const PACK = rampOf(110, 104, 66);
const PACK_STRAP = rampOf(64, 58, 40);
const HAIR = rampOf(82, 58, 40);
const SKIN = rampOf(226, 184, 146);
const BOOTS = rampOf(66, 52, 42);

const SANTA_RED = rampOf(196, 34, 42);
const SANTA_FUR = rampOf(240, 238, 230);
const SANTA_BELT = rampOf(34, 28, 28);
const SANTA_GOLD = rampOf(222, 178, 64);
const SANTA_SACK = rampOf(156, 118, 72);
const SANTA_BOOTS = rampOf(36, 30, 30);

const COSTUME_RAGS = rampOf(108, 98, 86);
const COSTUME_TORN = rampOf(52, 46, 40);
const COSTUME_SKIN = rampOf(148, 186, 112);
const COSTUME_HAIR = rampOf(62, 56, 48);
const COSTUME_PACK = rampOf(78, 72, 64);
const COSTUME_BOOTS = rampOf(54, 48, 42);

const COWBOY_SHIRT = rampOf(226, 206, 164);
const COWBOY_VEST = rampOf(98, 62, 34);
const COWBOY_HAT = rampOf(182, 136, 80);
const COWBOY_CROWN = rampOf(150, 106, 58);
const COWBOY_BAND = rampOf(58, 38, 22);
const COWBOY_ROLL = rampOf(96, 106, 124);
const COWBOY_BOOTS = rampOf(94, 58, 32);

/** what a downed survivor turns (MP-03, LEG-02: red is the survivor's blood) */
const DOWNED_RED = Color3.fromRGB(200, 60, 60);

/** the outfit a survivor wears, as the view needs it (index = OutfitLook) */
export interface OutfitStyle {
	/** the torso's ramp: the flat body's torso colour is its base */
	torso: Ramp;
	/** hands: skin, or gloves (the hands are drawn with the weapon, client/view/survivorView.ts) */
	hands: Ramp;
	boots: Ramp;
	/** the head seen from above: hair, or the hat's brim */
	head: Ramp;
	/** what a hit lerps the torso towards (LEG-02: Santa's red coat flashes white) */
	flashTo: Color3;
	/** the downed body: the torso and the head lerped towards red (MP-03), built once */
	downedTorso: Ramp;
	downedHead: Ramp;
}

function lerpRamp(rp: Ramp, to: Color3, k: number): Ramp {
	return { deep: rp.deep.Lerp(to, k * 0.6), dark: rp.dark.Lerp(to, k), base: rp.base.Lerp(to, k), light: rp.light.Lerp(to, k) };
}

function outfit(torso: Ramp, hands: Ramp, boots: Ramp, head: Ramp, flashTo: Color3): OutfitStyle {
	return {
		torso,
		hands,
		boots,
		head,
		flashTo,
		downedTorso: lerpRamp(torso, DOWNED_RED, 0.35),
		downedHead: lerpRamp(head, DOWNED_RED, 0.2),
	};
}

export const OUTFIT_STYLES: Array<OutfitStyle> = [
	outfit(JACKET, SKIN, BOOTS, HAIR, COLORS.uiRed),
	outfit(SANTA_RED, SANTA_FUR, SANTA_BOOTS, SANTA_FUR, COLORS.white),
	outfit(COSTUME_RAGS, COSTUME_SKIN, COSTUME_BOOTS, COSTUME_SKIN, COLORS.uiRed),
	outfit(COWBOY_SHIRT, SKIN, COWBOY_BOOTS, COWBOY_HAT, COLORS.uiRed),
];

/** the style of an OutfitLook; anything unknown is the plain survivor */
export function outfitStyle(outfitLook: number): OutfitStyle {
	return OUTFIT_STYLES[outfitLook] ?? OUTFIT_STYLES[0];
}

/** OutfitLook numbers, repeated here so the generator needs no data module (shared/data/cosmetics.ts) */
const SANTA = 1;
const COSTUME = 2;
const COWBOY = 3;

/** how far a foot swings along the heading at full stride, world units */
export const STRIDE = 7;

/**
 * A survivor standing or walking. `step` is the stride, -1..1 (sin of the walk phase times its amplitude): the
 * feet swing and the shoulders counter-turn a little with it. Layers: feet -1, torso 1, back and outfit 2, head 4,
 * hat 5 (the weapon sits at 0 and the hands at 3: client/view/survivorView.ts draws them, they depend on the weapon).
 */
export function survivorParts(out: PartList, outfitLook: number, step: number): void {
	out.begin(1);
	const st = outfitStyle(outfitLook);
	const sway = step * 0.07;
	for (const side of SIDES) {
		out.box(step * STRIDE * side, side * 8, 11, 8, 0, 3, st.boots, -1, MAT_PLAIN, SOLID);
	}
	// the torso: a capsule across the shoulders, the thing a hit outlines in red
	if (outfitLook === SANTA) {
		// the white fur trim all round the red coat: a white coat edge, then the red inside it
		out.box(0, 0, 19, 31, sway, 8, SANTA_FUR, 1, MAT_FUR, SOLID + F_FLASH + F_MAIN);
		out.box(0.5, 0, 12, 24, sway, 6, SANTA_RED, 1, MAT_CLOTH, MARK + F_FLASH);
		// the belt across the front of the coat, a gold buckle in the middle
		out.box(4, 0, 4, 30, sway, 1, SANTA_BELT, 2, MAT_PLAIN, MARK);
		out.box(4, 0, 3.5, 4, sway, 0, SANTA_GOLD, 2, MAT_METAL, ART);
		// the sack on the back
		out.oval(-12, 2, 12, 19, 0.15, SANTA_SACK, 2, MAT_CLOTH, SOLID);
		out.box(-6, 3, 4, 6, 0.3, 1, SANTA_SACK, 2, MAT_CLOTH, ART);
	} else if (outfitLook === COSTUME) {
		out.box(0, 0, 18, 30, sway, 7, COSTUME_RAGS, 1, MAT_RAG, SOLID + F_FLASH + F_MAIN);
		// rips: green skin showing through the cloth, at odd angles; the torn hem bitten out of the back
		out.box(4, -8, 7, 4, 0.6, 1, COSTUME_SKIN, 2, MAT_SKIN, MARK);
		out.box(-3, 7, 8, 4, -0.4, 1, COSTUME_SKIN, 2, MAT_SKIN, MARK);
		out.box(1, 12, 4, 3, 1.2, 1, COSTUME_SKIN, 2, MAT_SKIN, ART);
		out.box(-8, -6, 3, 4, 0.3, 0, COSTUME_TORN, 2, MAT_PLAIN, ART);
		// a pack that has seen better days (the costume is still a survivor: P3)
		out.box(-11, 0, 9, 18, 0, 3, COSTUME_PACK, 2, MAT_RAG, SOLID);
		out.box(-3, 7, 9, 2.5, 0, 0, COSTUME_TORN, 2, MAT_PLAIN, ART);
	} else if (outfitLook === COWBOY) {
		out.box(0, 0, 18, 30, sway, 7, COWBOY_SHIRT, 1, MAT_CLOTH, SOLID + F_FLASH + F_MAIN);
		// an open vest: two leather panels on the shoulders, the shirt showing down the middle and at the front
		for (const side of SIDES) {
			out.box(-1.5, side * 9.5, 16, 10, sway, 3, COWBOY_VEST, 2, MAT_CLOTH, SOLID);
		}
		// the bedroll strapped across the back
		out.box(-12, 0, 8, 25, 0, 4, COWBOY_ROLL, 2, MAT_CLOTH, SOLID);
		for (const side of SIDES) {
			out.box(-12, side * 6, 8, 2, 0, 0, COWBOY_BAND, 2, MAT_PLAIN, ART);
		}
	} else {
		out.box(0, 0, 18, 30, sway, 7, JACKET, 1, MAT_CLOTH, SOLID + F_FLASH + F_MAIN);
		// the zip down the front, a mended patch on one shoulder: a jacket worn for days
		out.box(5, 0, 7, 1.5, sway, 0, rampOfColor(JACKET.dark), 1, MAT_PLAIN, ART);
		out.box(-2, -10, 5, 5, sway + 0.2, 0, JACKET_PATCH, 1, MAT_CLOTH, ART);
		// the backpack and its straps over the shoulders
		out.box(-11, 0, 10, 19, 0, 3, PACK, 2, MAT_CLOTH, SOLID);
		out.box(-13, 0, 4, 15, 0, 1, rampOfColor(PACK.dark), 2, MAT_CLOTH, ART);
		for (const side of SIDES) {
			out.box(-3, side * 7, 11, 2.5, sway, 0, PACK_STRAP, 2, MAT_PLAIN, ART);
		}
	}
	// the head, or the hat on it
	if (outfitLook === SANTA) {
		// fur brim where the head is, the pom-pom out BEHIND it (the only survivor whose head has a tail), the red cap
		out.oval(1.5, 0, 16, 16, 0, SANTA_FUR, 4, MAT_FUR, SOLID + F_LIFT);
		out.oval(-14, 6, 8, 8, 0, SANTA_FUR, 4, MAT_FUR, SOLID);
		out.oval(0.5, 0, 11, 11, 0, SANTA_RED, 5, MAT_CLOTH, MARK);
		out.box(-6.5, 3, 10, 5, math.atan2(4, -9), 2, SANTA_RED, 5, MAT_CLOTH, MARK);
	} else if (outfitLook === COWBOY) {
		// the brim is wider than the head: that width is the silhouette from above
		out.oval(1, 0, 24, 24, 0, COWBOY_HAT, 4, MAT_CLOTH, SOLID + F_LIFT);
		out.oval(0, 0, 13, 13, 0, COWBOY_BAND, 5, MAT_PLAIN, MARK);
		out.oval(0, 0, 10, 10, 0, COWBOY_CROWN, 5, MAT_CLOTH, ART);
	} else if (outfitLook === COSTUME) {
		out.oval(2, 0, 15, 15, 0, COSTUME_SKIN, 4, MAT_SKIN, SOLID + F_LIFT);
		// what is left of the hair
		out.oval(-1, -3, 7, 7, 0, COSTUME_HAIR, 5, MAT_HAIR, MARK);
		out.oval(-3, 4, 5, 5, 0, COSTUME_HAIR, 5, MAT_HAIR, ART);
	} else {
		out.oval(2, 0, 15, 15, 0, HAIR, 4, MAT_HAIR, SOLID + F_LIFT);
		// the forehead at the front of the head: which way they look, even with no weapon
		out.oval(7.5, 0, 4, 9, 0, SKIN, 4, MAT_SKIN, ART);
	}
}

/**
 * Downed (MP-03): flat on the ground, dragging themselves on, both hands busy (no weapon). Long along the heading
 * instead of wide across it -- from above that alone says "someone is down" -- legs trailing, arms pulling, head
 * down; the torso and the head take the red of the survivor's blood (LEG-02). `drag` is -1..1.
 */
export function downedParts(out: PartList, outfitLook: number, drag: number): void {
	out.begin(1);
	const st = outfitStyle(outfitLook);
	for (const side of SIDES) {
		out.box(-19 + drag * 4 * side, side * 7, 16, 7, 0, 3, st.boots, 0, MAT_CLOTH, SOLID);
		out.box(19 - drag * 4 * side, side * 10, 18, 6, 0, 3, st.downedTorso, 1, MAT_CLOTH, SOLID);
	}
	out.box(0, 0, 30, 18, 0, 8, st.downedTorso, 2, MAT_CLOTH, SOLID + F_FLASH + F_MAIN);
	out.oval(16, 0, 14, 14, 0, st.downedHead, 3, MAT_HAIR, SOLID + F_LIFT);
}

// zombies ---------------------------------------------------------------------

/** a zombie type's colours: the skin and clothes that make its hue, what it bleeds and what it wears on its feet */
interface ZombieStyle {
	skin: Ramp;
	/** head: the skin a little lighter (the scalp catches the light) */
	head: Ramp;
	/** arms: the skin a little darker */
	arm: Ramp;
	rags: Ramp;
	shoes: Ramp;
	hair: Ramp;
}

function zombieStyle(skin: Color3, rags: Ramp): ZombieStyle {
	const s = rampOfColor(skin);
	return {
		skin: s,
		head: rampOfColor(skin.Lerp(COLORS.white, 0.08)),
		arm: rampOfColor(skin.Lerp(COLORS.shadow, 0.1)),
		rags,
		shoes: rampOf(54, 56, 48),
		hair: rampOf(48, 44, 38),
	};
}

/**
 * One style per type, index = type (1 walker .. 5 jumper). The body keeps the colour each type has always had
 * (COLORS.zombie1..5): the flat torso is exactly it, so the hue that tells a spitter from a walker never moved.
 */
const ZOMBIE_STYLES: Array<ZombieStyle> = [
	zombieStyle(COLORS.zombie1, rampOf(74, 84, 60)),
	zombieStyle(COLORS.zombie1, rampOf(74, 84, 60)),
	zombieStyle(COLORS.zombie2, rampOf(66, 56, 74)),
	zombieStyle(COLORS.zombie3, rampOf(96, 62, 50)),
	zombieStyle(COLORS.zombie4, rampOf(70, 62, 44)),
	zombieStyle(COLORS.zombie5, rampOf(52, 70, 76)),
];
const ACID = rampOf(150, 214, 72);
const BOIL = rampOf(236, 176, 82);
/** the charger's jersey: a linebacker's, in its type colour, with shoulder pads under it */
const JERSEY_STRIPE = rampOf(58, 50, 34);
/** the jumper's tracksuit stripes */
const TRACK_STRIPE = rampOf(214, 226, 222);

/** the skin ramp of a zombie type (1..5) */
export function zombieSkin(type: number): Ramp {
	return (ZOMBIE_STYLES[type] ?? ZOMBIE_STYLES[1]).skin;
}

/**
 * A zombie of `type` (1 walker, 2 spitter, 3 exploder, 4 charger, 5 jumper), each with a silhouette of its own
 * (ART-09): the walker's arms reach straight ahead; the spitter's hang at its sides under a big head and a swollen
 * acid sac; the exploder is a round bloated belly with stubs for arms; the charger is all shoulders, head low, arms
 * swept back; the jumper crouches on long splayed legs, arms back -- and reaches forward only in the air.
 *
 * `step` is the stride (-1..1): feet, the lurch of the shoulders and the arms' sway follow it. `windup` (0..1) is
 * the spitter pulling its head back as the sac swells; `air` (0..1) the jumper in flight. Layers 0..4 (feet, arms,
 * torso, what is on it, head); `sc` is the hitbox's radius over 18.
 */
export function zombieParts(out: PartList, type: number, step: number, windup: number, air: number, sc: number): void {
	out.begin(sc);
	const zs = ZOMBIE_STYLES[type] ?? ZOMBIE_STYLES[1];
	const lurch = step * 0.1;
	const body = SOLID + F_FLASH;
	if (type === 2) {
		// ---- spitter: arms hanging, a head too big, the acid sac under the jaw
		const k = math.clamp(windup, 0, 1);
		for (const side of SIDES) {
			out.box(step * STRIDE * side, side * 8, 11, 8, 0, 3, zs.shoes, 0, MAT_PLAIN, SOLID);
			out.box(-2 - step * side * 1.5, side * 14.5, 14, 5.5, side * -0.35, 2, zs.arm, 1, MAT_ROT, body);
		}
		out.box(0, 0, 18, 26, lurch, 8, zs.skin, 2, MAT_ROT, body + F_MAIN);
		out.box(-3, 0, 11, 24, lurch, 6, zs.rags, 2, MAT_RAG, ART);
		out.oval(-5, 7, 4, 5, 0, OOZE, 3, MAT_BLOOD, ART);
		out.oval(11 - 6 * k, 0, 9 + 6 * k, 10 + 7 * k, 0, ACID, 3, MAT_GLOW, SOLID);
		const head = 18 * (1 + 0.25 * k);
		out.oval(3 - 9 * k, 0, head, head, 0, zs.head, 4, MAT_ROT, body + F_LIFT);
		out.oval(1 - 9 * k, -3, 6, 5, 0, zs.hair, 4, MAT_HAIR, ART);
		// acid drooling from the mouth
		out.oval(13 - 5 * k, 3, 3, 3, 0, ACID, 4, MAT_GLOW, ART);
		return;
	}
	if (type === 3) {
		// ---- exploder: a round belly, stubs for arms, boils about to burst
		for (const side of SIDES) {
			out.box(step * 6 * side, side * 9, 11, 8, 0, 3, zs.shoes, 0, MAT_PLAIN, SOLID);
			out.box(7 - step * side, side * 15, 11, 7, side * 0.45, 3, zs.arm, 1, MAT_ROT, body);
		}
		out.oval(0, 0, 28, 33, lurch * 0.5, zs.skin, 2, MAT_ROT, body + F_MAIN);
		out.oval(-6, -6, 9, 9, 0, BOIL, 3, MAT_GLOW, SOLID);
		out.oval(3, 9, 6, 6, 0, BOIL, 3, MAT_GLOW, ART + F_EDGE);
		out.oval(-9, 6, 5, 5, 0, BOIL, 3, MAT_GLOW, ART + F_EDGE);
		out.oval(6, -9, 4, 4, 0, BOIL, 3, MAT_GLOW, ART);
		out.oval(-1, 12, 4, 6, 0, OOZE, 3, MAT_BLOOD, ART);
		out.oval(11, 0, 13, 13, 0, zs.head, 4, MAT_ROT, body + F_LIFT);
		out.box(16, 0, 3, 5, 0, 0, BLOOD_WET, 4, MAT_BLOOD, ART);
		return;
	}
	if (type === 4) {
		// ---- charger: shoulders like a door, head low and forward, arms swept back to run
		for (const side of SIDES) {
			out.box(step * 8 * side, side * 10, 12, 8, 0, 3, zs.shoes, 0, MAT_PLAIN, SOLID);
			out.box(-6 + step * side * 2, side * 16.5, 16, 7, side * -0.3, 3, zs.arm, 1, MAT_ROT, body);
		}
		out.box(0, 0, 20, 35, lurch * 0.6, 9, zs.skin, 2, MAT_CLOTH, body + F_MAIN);
		for (const side of SIDES) {
			out.oval(-1, side * 10, 15, 13, lurch * 0.6, rampOfColor(zs.skin.light), 2, MAT_CLOTH, ART);
		}
		out.box(-3, 0, 3, 33, lurch * 0.6, 0, JERSEY_STRIPE, 2, MAT_PLAIN, ART);
		out.oval(3, -9, 7, 8, 0, BLOOD_DRY, 3, MAT_BLOOD, MARK);
		out.oval(12, 0, 13, 13, 0, rampOf(128, 128, 96), 4, MAT_ROT, body + F_LIFT);
		out.box(17, 0, 3, 6, 0, 0, BLOOD_WET, 4, MAT_BLOOD, ART);
		return;
	}
	if (type === 5) {
		// ---- jumper: crouched on long splayed legs; arms back, or reaching forward in the air
		const a = math.clamp(air, 0, 1);
		for (const side of SIDES) {
			const back = -15 - 5 * a + step * side * 3;
			out.box(back + 6, side * 11, 13, 6, side * 0.6, 3, zs.arm, 0, MAT_ROT, SOLID);
			out.box(back, side * (15 - 3 * a), 10, 6, side * 0.35, 3, zs.shoes, 0, MAT_PLAIN, SOLID);
			if (a > 0.5) out.box(15, side * 8, 18, 5, side * -0.08, 2, zs.arm, 1, MAT_ROT, body);
			else out.box(-6, side * 12.5, 15, 5, side * -0.5, 2, zs.arm, 1, MAT_ROT, body);
		}
		out.box(1, 0, 18, 22, lurch, 7, zs.skin, 2, MAT_CLOTH, body + F_MAIN);
		for (const side of SIDES) {
			out.box(1, side * 9.5, 16, 2, lurch, 0, TRACK_STRIPE, 2, MAT_PLAIN, ART);
		}
		out.oval(-2, -4, 5, 4, 0, BLOOD_DRY, 3, MAT_BLOOD, ART);
		out.oval(9, 0, 14, 14, 0, rampOf(110, 150, 138), 4, MAT_ROT, body + F_LIFT);
		out.box(14, 0, 3, 5, 0, 0, BLOOD_WET, 4, MAT_BLOOD, ART);
		return;
	}
	// ---- walker: arms straight ahead, swaying with the lurch; torn shirt, dried blood, bloody hands and mouth
	for (const side of SIDES) {
		const along = step * side;
		out.box(step * STRIDE * side, side * 8, 11, 8, 0, 3, zs.shoes, 0, MAT_PLAIN, SOLID);
		out.box(19 - along * 2, side * 10.5, 22, 6.5, -side * 0.05 + lurch * 0.4, 3, zs.arm, 1, MAT_ROT, body);
		out.box(11 - along * 2, side * 10.5, 8, 8, -side * 0.05 + lurch * 0.4, 2, zs.rags, 1, MAT_RAG, ART);
		out.box(28 - along * 2, side * 10.5, 5, 6.5, -side * 0.05 + lurch * 0.4, 0, BLOOD_DRY, 1, MAT_BLOOD, ART);
	}
	out.box(0, 0, 20, 30, lurch, 8, zs.skin, 2, MAT_ROT, body + F_MAIN);
	out.box(-4, 1, 12, 28, lurch, 5, zs.rags, 2, MAT_RAG, ART);
	out.oval(1, -9, 5, 6, 0, OOZE, 2, MAT_BLOOD, ART);
	out.oval(6, 5, 8, 9, lurch, BLOOD_DRY, 3, MAT_BLOOD, MARK);
	out.oval(4, 0, 15, 14.5, lurch * 0.5, zs.head, 4, MAT_ROT, body + F_LIFT);
	out.oval(1, -2, 6, 7, 0, zs.hair, 4, MAT_HAIR, ART);
	out.oval(-1, 3, 5, 4, 0, zs.hair, 4, MAT_HAIR, ART);
	out.box(10, 0, 3, 6, 0, 0, BLOOD_WET, 4, MAT_BLOOD, ART);
}

// pets ---------------------------------------------------------------------------

interface DogStyle {
	coat: Ramp;
	head: Ramp;
	muzzle: Ramp;
	ears: Ramp;
	paws: Ramp;
	/** overall size, and how narrow the body is across (a Doberman is slim, a Malamute stocky) */
	scale: number;
	slim: number;
}

interface BirdStyle {
	body: Ramp;
	head: Ramp;
	wing: Ramp;
	tip: Ramp;
	tail: Ramp;
	beak: Ramp;
	scale: number;
	/** the eagle's wings stay open: it soars, and landed it mantles */
	soars: boolean;
}

const CAROLINA: DogStyle = {
	coat: rampOf(202, 146, 84),
	head: rampOf(206, 152, 90),
	muzzle: rampOf(232, 196, 144),
	ears: rampOf(150, 98, 54),
	paws: rampOf(170, 118, 64),
	scale: 1,
	slim: 0.95,
};
/** a wolf-grey darker than the pigeon's slate, so the two greys of the catalogue never read as one */
const MALAMUTE: DogStyle = {
	coat: rampOf(94, 98, 108),
	head: rampOf(100, 104, 114),
	muzzle: rampOf(238, 238, 236),
	ears: rampOf(84, 88, 98),
	paws: rampOf(226, 226, 224),
	scale: 1.14,
	slim: 1.1,
};
const DOBERMAN: DogStyle = {
	coat: rampOf(40, 34, 34),
	head: rampOf(44, 38, 38),
	muzzle: rampOf(180, 108, 50),
	ears: rampOf(30, 26, 26),
	paws: rampOf(160, 94, 44),
	scale: 1,
	slim: 0.82,
};
/** the Malamute's white mask and curled tail */
const MALAMUTE_WHITE = rampOf(240, 240, 238);

const PIGEON: BirdStyle = {
	body: rampOf(134, 140, 154),
	head: rampOf(100, 106, 122),
	wing: rampOf(150, 156, 170),
	tip: rampOf(58, 60, 68),
	tail: rampOf(92, 96, 108),
	beak: rampOf(56, 56, 60),
	scale: 1,
	soars: false,
};
const WHITE_PIGEON: BirdStyle = {
	body: rampOf(240, 240, 238),
	head: rampOf(250, 250, 250),
	wing: rampOf(232, 232, 228),
	tip: rampOf(186, 186, 194),
	tail: rampOf(222, 222, 220),
	beak: rampOf(232, 150, 140),
	scale: 1,
	soars: false,
};
const EAGLE: BirdStyle = {
	body: rampOf(104, 66, 36),
	head: rampOf(198, 160, 84),
	wing: rampOf(116, 74, 40),
	tip: rampOf(46, 30, 18),
	tail: rampOf(90, 58, 32),
	beak: rampOf(238, 198, 66),
	scale: 1.35,
	soars: true,
};

/** PetLook numbers, repeated here so the generator needs no data module */
const PET_PIGEON = 1;
const PET_WHITE_PIGEON = 2;
const PET_EAGLE = 3;
const PET_MALAMUTE = 5;
const PET_DOBERMAN = 6;

function dogOf(pet: number): DogStyle {
	return pet === PET_MALAMUTE ? MALAMUTE : pet === PET_DOBERMAN ? DOBERMAN : CAROLINA;
}

function birdOf(pet: number): BirdStyle {
	return pet === PET_EAGLE ? EAGLE : pet === PET_WHITE_PIGEON ? WHITE_PIGEON : PIGEON;
}

/** the size a pet is drawn at (the model is at 1) */
export function petScale(pet: number): number {
	return pet >= 4 ? dogOf(pet).scale : birdOf(pet).scale;
}

/**
 * A dog (Carolina, Malamute, Doberman). `swing` is the trot (-1..1: diagonal pairs of paws swing together), `wag`
 * the tail (-1..1, only while it stands with you), `moving` 0..1. Layers 0..3: legs, tail and ears; body and
 * muzzle; head; the marks on the head.
 */
export function dogParts(out: PartList, pet: number, swing: number, wag: number, moving: number): void {
	const d = dogOf(pet);
	out.begin(d.scale);
	const w = d.slim;
	const sw = swing * 4;
	for (const side of SIDES) {
		out.box(10 + sw * side, side * 6.5 * w, 6, 4, 0, 2, d.paws, 0, MAT_FUR, SOLID);
		out.box(-10 - sw * side, side * 6.5 * w, 6, 4, 0, 2, d.paws, 0, MAT_FUR, SOLID);
	}
	const wg = wag * 0.55 * (1 - moving);
	if (pet === PET_DOBERMAN) {
		out.box(-15, 0, 5, 3, wg * 0.4, 1, d.coat, 0, MAT_FUR, SOLID);
	} else if (pet !== PET_MALAMUTE) {
		out.box(-17.5, wg * 4, 10, 4, 0.35 + wg, 2, d.coat, 0, MAT_FUR, SOLID);
	}
	out.oval(0, 0, 26, 12 * w, 0, d.coat, 1, MAT_FUR, SOLID);
	// a darker saddle along the back (the pixel art only)
	out.oval(-3, 0, 14, 5 * w, 0, rampOfColor(d.coat.dark), 1, MAT_FUR, ART);
	for (const side of SIDES) {
		out.box(13, side * 5.5, 7, 4, side * -0.7, 1, d.ears, 0, MAT_FUR, SOLID);
	}
	out.box(20, 0, 7, 5.5, 0, 2, d.muzzle, 1, MAT_FUR, SOLID);
	out.box(23, 0, 2, 2.5, 0, 0, rampOf(24, 20, 20), 1, MAT_PLAIN, ART);
	out.oval(14.5, 0, 11.5, 11.5, 0, d.head, 2, MAT_FUR, SOLID + F_LIFT);
	if (pet === PET_MALAMUTE) {
		// the white mask down the face, and the bushy tail curled up over the back
		out.oval(17.5, 0, 6, 6, 0, MALAMUTE_WHITE, 3, MAT_FUR, MARK);
		out.oval(-11, 2 + wg * 2, 10, 10, 0, MALAMUTE_WHITE, 2, MAT_FUR, SOLID);
	} else if (pet === PET_DOBERMAN) {
		// the tan brows over the eyes
		for (const side of SIDES) out.oval(16.5, side * 3, 3, 3, 0, d.muzzle, 3, MAT_FUR, MARK);
	}
}

/**
 * A bird (Pigeon, White pigeon, Eagle). `open` 0..1 is how far the wings are spread (0: a landed pigeon, folded
 * along its back). Layers 0..3: wings and tail; the dark primaries and the body; head and folded wings; beak.
 */
export function birdParts(out: PartList, pet: number, open: number): void {
	const b = birdOf(pet);
	out.begin(b.scale);
	const span = 24;
	const bodyHalf = 5;
	if (open > 0.02) {
		const reach = span * open;
		for (const side of SIDES) {
			out.box(0, side * (bodyHalf + reach / 2), 10, reach, 0, 3, b.wing, 0, MAT_FUR, SOLID);
			// the dark primaries at the wing tips, swept a little back (only once the wing is out past the body)
			if (reach > 8) out.box(-2, side * (bodyHalf + reach - 3), 8, 6, 0, 2, b.tip, 1, MAT_FUR, MARK);
		}
	}
	out.box(-9, 0, 8, b.soars ? 11 : 7, 0, 2, b.tail, 0, MAT_FUR, SOLID);
	out.oval(0, 0, 15, 10, 0, b.body, 1, MAT_FUR, SOLID);
	if (open <= 0.02) {
		// landed pigeon: the folded wings along its back, with the dark bar across them
		for (const side of SIDES) {
			out.box(-2.5, side * 3.2, 11, 3.5, 0, 1.5, b.wing, 2, MAT_FUR, MARK);
			out.box(-5, side * 3.2, 2, 3.5, 0, 0, b.tip, 3, MAT_PLAIN, MARK);
		}
	}
	out.oval(8, 0, 7, 7, 0, b.head, 2, MAT_FUR, SOLID + F_LIFT);
	out.box(12, 0, 4, b.soars ? 3.5 : 2.5, 0, 1, b.beak, 3, MAT_PLAIN, MARK);
}
