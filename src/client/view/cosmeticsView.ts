/*
 * What a bought cosmetic LOOKS like (docs/DESIGN_RULES.md MON-02, MON-04): the three outfits drawn on the survivor's
 * body and the six pets drawn at their heel — the same code for yourself, for every ally and for the wardrobe
 * preview (client/view/cosmeticPreview.ts), so what you pay for is exactly what the others see.
 *
 * The one constraint that shaped every sprite here is MON-02: the survivor is ~32 px seen from above, so detail does
 * not read and COLOUR and SILHOUETTE do. Each look is therefore built around one thing you can tell apart across the
 * screen, in the dark, in a crowd:
 *
 *   Santa    a red coat with a white fur trim all round, white gloves, and a red cap whose white pom-pom droops out
 *            BEHIND the head — the only survivor whose head has a tail.
 *   Zombie   torn grey-brown rags with green skin showing through the rips, green hands and a green, patchy scalp.
 *            The survivor silhouette is kept on purpose — hands on the weapon, no arms reaching forward, the name
 *            plate — so the costume reads as "a survivor dressed as a zombie" and never as a zombie (P3, LEG-03).
 *   Cowboy   a straw-tan hat wider than the head (30 u against 22), which is the whole silhouette from above,
 *            over a cream shirt with a dark leather vest on the shoulders.
 *
 *   Pigeon        small, slate grey, wings that beat fast in flight and fold along the body when it lands
 *   White pigeon  the same bird in white with a pink beak
 *   Eagle         brown, big, wings ALWAYS open (it soars and, landed, mantles) with dark tips and a golden head
 *   Carolina      a lean caramel dog with pointed ears and a curved tail
 *   Malamute      a bigger grey-and-white dog: white face, bushy white tail curled over its back
 *   Doberman      a slim black dog with tan muzzle, brows and paws, pointed ears and a docked tail
 *
 * LEG-02 exception (documented in MON-04): red means "player blood / damage", and Santa's coat is red. A hit on
 * Santa therefore flashes towards WHITE instead of red, while the red hit outline every survivor gets stays — the
 * damage signal is the outline and the flash, not the coat colour.
 *
 * Nothing here allocates per frame: every sprite goes through ONE module scratch `SpriteOpts` refilled per call
 * (`spec`), every colour is built once below, and `SIDES` is iterated without building a table. The renderer's
 * pool and property cache do the rest (shared/engine/renderer.ts).
 *
 * Layers (ZIndex) — the survivor's stack is z-1 .. z+5 around `Z.player` (see survivorView.ts); a pet sits just
 * below it, `PET_Z` .. `PET_Z + 3`, so it never ties with its owner. That band overlaps the horde's; a pet and a
 * zombie never interact, and either drawn over the other reads fine.
 */
import { Camera } from "shared/engine/camera";
import { COLORS, Z } from "shared/engine/colors";
import { Renderer, SpriteOpts } from "shared/engine/renderer";
import { OutfitLook, PetLook, petFlies } from "shared/data/cosmetics";
import { PetFollower } from "./petFollow";

const BLACK = COLORS.shadow;
const WHITE = COLORS.white;

/**
 * A pet's lowest layer: legs, tail and wings; body +1, head +2, the small marks on the head +3 — so a pet ends at
 * Z.player - 2, one below the survivor's feet (z - 1): a pet at its owner's heel never ties with the owner.
 */
export const PET_Z = Z.player - 5;
/** how high a bird flies above its shadow, in world units, at full lift */
const BIRD_HEIGHT = 22;

// ---------------------------------------------------------------- the scratch sprite

const O: SpriteOpts = {};

/**
 * The one SpriteOpts every sprite of this file is drawn with, refilled in place. Every field is written on every
 * call — `part`, `drawCircle` and `drawSegment` all write into the opts they are given, so a field left over from
 * the previous sprite would leak into the next.
 */
function spec(
	w: number,
	h: number,
	color: Color3,
	z: number,
	corner?: number,
	stroke?: Color3,
	thick?: number,
	alpha?: number,
): SpriteOpts {
	O.w = w;
	O.h = h;
	O.color = color;
	O.zIndex = z;
	O.cornerRadius = corner;
	O.stroke = stroke;
	O.strokeThickness = thick;
	O.alpha = alpha;
	O.strokeAlpha = undefined;
	O.circle = undefined;
	O.rotation = undefined;
	O.anchorX = undefined;
	O.anchorY = undefined;
	return O;
}

/** a rect in a body's frame: `fwd` along the heading `a`, `lat` to its right, turned a further `tilt` */
function piece(
	r: Renderer,
	cam: Camera,
	x: number,
	y: number,
	a: number,
	fwd: number,
	lat: number,
	tilt: number,
	o: SpriteOpts,
): void {
	const c = math.cos(a);
	const s = math.sin(a);
	o.rotation = a + tilt;
	r.drawRect(cam, x + c * fwd - s * lat, y + s * fwd + c * lat, o);
}

/** a circle of diameter `d` in a body's frame */
function disc(
	r: Renderer,
	cam: Camera,
	x: number,
	y: number,
	a: number,
	fwd: number,
	lat: number,
	d: number,
	o: SpriteOpts,
): void {
	const c = math.cos(a);
	const s = math.sin(a);
	r.drawCircle(cam, x + c * fwd - s * lat, y + s * fwd + c * lat, d, o);
}

/** iterate a body's two sides without building a table per call */
const SIDES = [-1, 1];

// ================================================================ outfits

/** the colours one outfit paints the survivor with; index = OutfitLook */
export interface OutfitPalette {
	/** torso fill and outline */
	body: Color3;
	edge: Color3;
	edgeThick: number;
	/** feet (shoes or boots, seen from above) */
	boots: Color3;
	/** hands: skin, or gloves */
	hands: Color3;
	/** the top of the head — hair, or the hat's brim — and its outline */
	head: Color3;
	headEdge: Color3;
	/** what a hit lerps the torso towards (LEG-02: the red coat flashes white) */
	flashTo: Color3;
}

const PLAYER_DARK = COLORS.playerDark;
/** exactly the survivor as it was drawn before MON-04: the plain look must not move by a pixel */
const PLAIN: OutfitPalette = {
	body: COLORS.player,
	edge: PLAYER_DARK,
	edgeThick: 2,
	boots: PLAYER_DARK.Lerp(BLACK, 0.4),
	hands: COLORS.playerSkin,
	head: PLAYER_DARK,
	headEdge: PLAYER_DARK.Lerp(BLACK, 0.4),
	flashTo: COLORS.uiRed,
};

const SANTA_RED = Color3.fromRGB(198, 32, 40);
const SANTA_FUR = Color3.fromRGB(246, 244, 238);
const SANTA_FUR_EDGE = Color3.fromRGB(196, 192, 186);
const SANTA_BELT = Color3.fromRGB(30, 26, 26);

const ZOMBIE_SKIN = Color3.fromRGB(148, 186, 112);
const ZOMBIE_SKIN_EDGE = Color3.fromRGB(84, 112, 64);
const ZOMBIE_RAGS = Color3.fromRGB(108, 98, 86);
const ZOMBIE_RAGS_EDGE = Color3.fromRGB(64, 56, 48);
const ZOMBIE_HAIR = Color3.fromRGB(62, 56, 48);
/** the ragged hem: bites out of the cloth, in the colour of the rags' own shadow */
const ZOMBIE_TORN = Color3.fromRGB(46, 42, 38);

const COWBOY_SHIRT = Color3.fromRGB(226, 206, 164);
/** the vest is a darker leather than the hat, so the two browns never melt into one blob */
const COWBOY_LEATHER = Color3.fromRGB(98, 62, 34);
const COWBOY_LEATHER_EDGE = Color3.fromRGB(64, 40, 20);
const COWBOY_HAT = Color3.fromRGB(180, 134, 78);
const COWBOY_HAT_EDGE = Color3.fromRGB(110, 72, 38);
const COWBOY_CROWN = Color3.fromRGB(146, 102, 56);
const COWBOY_BAND = Color3.fromRGB(58, 38, 22);
/**
 * The brim: wider than the 22 u head, which is the whole silhouette from above, but not so wide that it hides the
 * shoulders — a 36 u brim (tried first) covered the torso front to back and the cowboy read as a brown disc.
 */
const COWBOY_BRIM = 30;

const PALETTES: Array<OutfitPalette> = [
	PLAIN,
	{
		body: SANTA_RED,
		edge: SANTA_FUR,
		edgeThick: 2,
		boots: Color3.fromRGB(34, 28, 28),
		hands: SANTA_FUR,
		head: SANTA_FUR,
		headEdge: SANTA_FUR_EDGE,
		flashTo: WHITE,
	},
	{
		body: ZOMBIE_RAGS,
		edge: ZOMBIE_RAGS_EDGE,
		edgeThick: 2,
		boots: Color3.fromRGB(52, 46, 40),
		hands: ZOMBIE_SKIN,
		head: ZOMBIE_SKIN,
		headEdge: ZOMBIE_SKIN_EDGE,
		flashTo: COLORS.uiRed,
	},
	{
		body: COWBOY_SHIRT,
		edge: COWBOY_LEATHER_EDGE,
		edgeThick: 2,
		boots: Color3.fromRGB(90, 56, 30),
		hands: COLORS.playerSkin,
		head: COWBOY_HAT,
		headEdge: COWBOY_HAT_EDGE,
		flashTo: COLORS.uiRed,
	},
];

/** the palette of an OutfitLook; anything unknown draws the plain survivor */
export function outfitPalette(outfit: number): OutfitPalette {
	return PALETTES[outfit] ?? PLAIN;
}

/** Santa's cap: the droopy tip, from the crown out behind the head, in the head's frame */
const CAP_TIP_FWD = -8.5;
const CAP_TIP_LAT = 4;
const CAP_TIP_LEN = 11;
const CAP_TIP_TILT = math.atan2(4, -9);

/**
 * What the outfit puts ON the torso, above it and below the hands (z + 2): Santa's belt, the zombie's rips and
 * torn hem, the cowboy's open vest. The plain survivor has nothing here.
 */
export function drawOutfitTorso(
	r: Renderer,
	cam: Camera,
	x: number,
	y: number,
	a: number,
	z: number,
	outfit: number,
): void {
	if (outfit === OutfitLook.Santa) {
		// the belt across the front of the coat
		piece(r, cam, x, y, a, 7, 0, 0, spec(4, 32, SANTA_BELT, z + 2, 1));
	} else if (outfit === OutfitLook.Zombie) {
		// rips: skin showing through the cloth, at odd angles
		piece(r, cam, x, y, a, 5, -9, 0.6, spec(8, 4, ZOMBIE_SKIN, z + 2, 1));
		piece(r, cam, x, y, a, -5, 7, -0.4, spec(9, 4, ZOMBIE_SKIN, z + 2, 1));
		piece(r, cam, x, y, a, 0, 13, 1.2, spec(5, 3, ZOMBIE_SKIN, z + 2, 1));
		// the torn hem: two bites out of the back edge
		piece(r, cam, x, y, a, -11, -6, 0.3, spec(4, 5, ZOMBIE_TORN, z + 2));
		piece(r, cam, x, y, a, -11, 9, -0.5, spec(4, 4, ZOMBIE_TORN, z + 2));
	} else if (outfit === OutfitLook.Cowboy) {
		// an open vest: two leather panels on the shoulders -- the part of the torso a hat leaves in sight from
		// above -- with the shirt showing at the front, the back and down the middle
		for (const side of SIDES) {
			piece(
				r,
				cam,
				x,
				y,
				a,
				-1.5,
				side * 12.5,
				0,
				spec(20, 12, COWBOY_LEATHER, z + 2, 4, COWBOY_LEATHER_EDGE, 1),
			);
		}
	}
}

/**
 * The head seen from above, which for an outfit with a hat IS the hat (z + 4 and z + 5). Called for every
 * survivor, plain included, so the head has one owner.
 */
export function drawOutfitHead(
	r: Renderer,
	cam: Camera,
	x: number,
	y: number,
	a: number,
	z: number,
	outfit: number,
): void {
	const pal = outfitPalette(outfit);
	if (outfit === OutfitLook.Santa) {
		// fur brim where the head is, the pom-pom out behind it, then the red cap over both
		disc(r, cam, x, y, a, 1, 0, 23, spec(23, 23, pal.head, z + 4, undefined, pal.headEdge, 1));
		disc(r, cam, x, y, a, -16, 7, 9, spec(9, 9, SANTA_FUR, z + 4, undefined, SANTA_FUR_EDGE, 1));
		disc(r, cam, x, y, a, 0, 0, 15, spec(15, 15, SANTA_RED, z + 5));
		piece(r, cam, x, y, a, CAP_TIP_FWD, CAP_TIP_LAT, CAP_TIP_TILT, spec(CAP_TIP_LEN, 6, SANTA_RED, z + 5, 3));
	} else if (outfit === OutfitLook.Cowboy) {
		// the brim is wider than the head: that width is the silhouette
		disc(
			r,
			cam,
			x,
			y,
			a,
			1,
			0,
			COWBOY_BRIM,
			spec(COWBOY_BRIM, COWBOY_BRIM, pal.head, z + 4, undefined, pal.headEdge, 1.5),
		);
		disc(r, cam, x, y, a, 0, 0, 15, spec(15, 15, COWBOY_CROWN, z + 5, undefined, COWBOY_BAND, 2));
	} else if (outfit === OutfitLook.Zombie) {
		disc(r, cam, x, y, a, 1, 0, 22, spec(22, 22, pal.head, z + 4, undefined, pal.headEdge, 1));
		// what is left of the hair
		disc(r, cam, x, y, a, -3, -4, 8, spec(8, 8, ZOMBIE_HAIR, z + 5));
		disc(r, cam, x, y, a, -5, 5, 6, spec(6, 6, ZOMBIE_HAIR, z + 5));
	} else {
		disc(r, cam, x, y, a, 1, 0, 22, spec(22, 22, pal.head, z + 4, undefined, pal.headEdge, 1));
	}
}

// ================================================================ pets

interface DogLook {
	coat: Color3;
	edge: Color3;
	head: Color3;
	muzzle: Color3;
	ears: Color3;
	paws: Color3;
	/** overall size, and how narrow the body is across (a Doberman is slim, a Malamute stocky) */
	scale: number;
	slim: number;
}

interface BirdLook {
	body: Color3;
	edge: Color3;
	head: Color3;
	wing: Color3;
	tip: Color3;
	tail: Color3;
	beak: Color3;
	scale: number;
	/** the eagle's wings stay open: it soars, and landed it mantles */
	soars: boolean;
}

const CAROLINA: DogLook = {
	coat: Color3.fromRGB(202, 146, 84),
	edge: Color3.fromRGB(128, 84, 44),
	head: Color3.fromRGB(206, 152, 90),
	muzzle: Color3.fromRGB(232, 196, 144),
	ears: Color3.fromRGB(150, 98, 54),
	paws: Color3.fromRGB(170, 118, 64),
	scale: 1,
	slim: 0.95,
};
/** a wolf-grey darker than the pigeon's slate, so the two greys of the catalogue never read as one */
const MALAMUTE: DogLook = {
	coat: Color3.fromRGB(94, 98, 108),
	edge: Color3.fromRGB(56, 58, 66),
	head: Color3.fromRGB(100, 104, 114),
	muzzle: Color3.fromRGB(238, 238, 236),
	ears: Color3.fromRGB(84, 88, 98),
	paws: Color3.fromRGB(226, 226, 224),
	scale: 1.14,
	slim: 1.1,
};
const DOBERMAN: DogLook = {
	coat: Color3.fromRGB(40, 34, 34),
	edge: Color3.fromRGB(16, 14, 14),
	head: Color3.fromRGB(44, 38, 38),
	muzzle: Color3.fromRGB(180, 108, 50),
	ears: Color3.fromRGB(30, 26, 26),
	paws: Color3.fromRGB(160, 94, 44),
	scale: 1,
	slim: 0.82,
};
/** the Malamute's white mask and curled tail */
const MALAMUTE_WHITE = Color3.fromRGB(240, 240, 238);
const MALAMUTE_WHITE_EDGE = Color3.fromRGB(176, 178, 184);

const PIGEON: BirdLook = {
	body: Color3.fromRGB(134, 140, 154),
	edge: Color3.fromRGB(84, 88, 100),
	head: Color3.fromRGB(100, 106, 122),
	wing: Color3.fromRGB(150, 156, 170),
	tip: Color3.fromRGB(58, 60, 68),
	tail: Color3.fromRGB(92, 96, 108),
	beak: Color3.fromRGB(56, 56, 60),
	scale: 1,
	soars: false,
};
const WHITE_PIGEON: BirdLook = {
	body: Color3.fromRGB(240, 240, 238),
	edge: Color3.fromRGB(170, 170, 176),
	head: Color3.fromRGB(250, 250, 250),
	wing: Color3.fromRGB(232, 232, 228),
	tip: Color3.fromRGB(186, 186, 194),
	tail: Color3.fromRGB(222, 222, 220),
	beak: Color3.fromRGB(232, 150, 140),
	scale: 1,
	soars: false,
};
const EAGLE: BirdLook = {
	body: Color3.fromRGB(104, 66, 36),
	edge: Color3.fromRGB(58, 36, 20),
	head: Color3.fromRGB(198, 160, 84),
	wing: Color3.fromRGB(116, 74, 40),
	tip: Color3.fromRGB(46, 30, 18),
	tail: Color3.fromRGB(90, 58, 32),
	beak: Color3.fromRGB(238, 198, 66),
	scale: 1.35,
	soars: true,
};

/** where a pet's drop shadow falls; the loop owns the sun (client/view/drawKit.ts shadowOffset) */
export type PetShadowFn = (x: number, y: number, len: number) => { x: number; y: number };

/**
 * One pet, where its follower says it is (client/view/petFollow.ts). `clock` drives the idle tail wag; `shadow`
 * is the loop's sun, so a pet's shadow falls the same way as its owner's (LUZ-01).
 */
export function drawPet(
	r: Renderer,
	cam: Camera,
	f: PetFollower,
	look: number,
	clock: number,
	shadow: PetShadowFn,
): void {
	if (look === PetLook.None) return;
	if (petFlies(look)) {
		drawBird(
			r,
			cam,
			f,
			look === PetLook.Eagle ? EAGLE : look === PetLook.WhitePigeon ? WHITE_PIGEON : PIGEON,
			shadow,
		);
		return;
	}
	if (look === PetLook.Carolina) drawDog(r, cam, f, CAROLINA, look, clock, shadow);
	else if (look === PetLook.Malamute) drawDog(r, cam, f, MALAMUTE, look, clock, shadow);
	else if (look === PetLook.Doberman) drawDog(r, cam, f, DOBERMAN, look, clock, shadow);
}

function drawDog(
	r: Renderer,
	cam: Camera,
	f: PetFollower,
	d: DogLook,
	look: number,
	clock: number,
	shadow: PetShadowFn,
): void {
	const x = f.x;
	const y = f.y;
	const a = f.angle;
	const s = d.scale;
	const w = s * d.slim;
	const so = shadow(x, y, 6);
	piece(
		r,
		cam,
		x + so.x,
		y + so.y,
		a,
		0,
		0,
		0,
		spec(34 * s, 16 * w, BLACK, Z.actorShadow, 7 * s, undefined, undefined, 0.28),
	);
	// a trot: diagonal pairs of paws swing together, by distance walked (f.phase), not by time
	const swing = math.sin(f.phase) * 4 * s * f.moving;
	for (const side of SIDES) {
		piece(r, cam, x, y, a, 10 * s + swing * side, side * 7.5 * w, 0, spec(7 * s, 4 * s, d.paws, PET_Z, 2));
		piece(r, cam, x, y, a, -10 * s - swing * side, side * 7.5 * w, 0, spec(7 * s, 4 * s, d.paws, PET_Z, 2));
	}
	// the tail: wagging while it stands with you, streaming behind while it runs
	const wag = math.sin(clock * 11) * 0.55 * (1 - f.moving);
	if (look === PetLook.Doberman) {
		piece(r, cam, x, y, a, -15 * s, 0, wag * 0.4, spec(5 * s, 3 * s, d.coat, PET_Z, 1));
	} else if (look === PetLook.Carolina) {
		piece(r, cam, x, y, a, -18 * s, wag * 4, 0.35 + wag, spec(11 * s, 4 * s, d.coat, PET_Z, 2, d.edge, 1));
	}
	// body
	piece(r, cam, x, y, a, 0, 0, 0, spec(28 * s, 13 * w, d.coat, PET_Z + 1, 6 * s, d.edge, 1));
	// ears under the head, so only their points show out of its sides; the snout ahead of it
	for (const side of SIDES) {
		piece(r, cam, x, y, a, 15 * s, side * 6 * s, side * -0.7, spec(7 * s, 4 * s, d.ears, PET_Z, 1));
	}
	piece(r, cam, x, y, a, 21 * s, 0, 0, spec(8 * s, 6 * s, d.muzzle, PET_Z + 1, 2, d.edge, 1));
	// head
	disc(r, cam, x, y, a, 15 * s, 0, 12 * s, spec(12 * s, 12 * s, d.head, PET_Z + 2, undefined, d.edge, 1));
	if (look === PetLook.Malamute) {
		// the white mask down the face, and the bushy tail curled up over the back
		disc(r, cam, x, y, a, 18 * s, 0, 6 * s, spec(6 * s, 6 * s, MALAMUTE_WHITE, PET_Z + 3));
		disc(
			r,
			cam,
			x,
			y,
			a,
			-11 * s,
			2 * s + wag * 2,
			11 * s,
			spec(11 * s, 11 * s, MALAMUTE_WHITE, PET_Z + 2, undefined, MALAMUTE_WHITE_EDGE, 1),
		);
	} else if (look === PetLook.Doberman) {
		// the tan brows over the eyes
		for (const side of SIDES) {
			disc(r, cam, x, y, a, 17 * s, side * 3 * s, 3 * s, spec(3 * s, 3 * s, d.muzzle, PET_Z + 3));
		}
	}
}

function drawBird(r: Renderer, cam: Camera, f: PetFollower, b: BirdLook, shadow: PetShadowFn): void {
	const a = f.angle;
	const s = b.scale;
	// height goes towards the top of the SCREEN (the camera may be turned): -sin / -cos of its angle, no table
	const h = f.lift * BIRD_HEIGHT;
	const x = f.x - math.sin(cam.angle) * h;
	const y = f.y - math.cos(cam.angle) * h;
	// the shadow stays on the ground, shrinking and fading as the bird climbs
	const so = shadow(f.x, f.y, 5);
	const shadowK = 1 - f.lift * 0.35;
	piece(
		r,
		cam,
		f.x + so.x,
		f.y + so.y,
		a,
		0,
		0,
		0,
		spec(16 * s * shadowK, 12 * s * shadowK, BLACK, Z.actorShadow, 6 * s, undefined, undefined, 0.26 * shadowK),
	);
	// wings: the eagle's stay open (only a slow beat), a pigeon's beat hard in the air and fold when it lands
	const beat = math.abs(math.sin(f.phase));
	let open: number;
	if (b.soars) open = f.lift > 0 ? 0.85 + 0.15 * beat : 0.6;
	else open = f.lift > 0.05 ? (0.35 + 0.65 * beat) * f.lift : 0;
	const span = 24 * s;
	const bodyHalf = 5 * s;
	if (open > 0.02) {
		const reach = span * open;
		for (const side of SIDES) {
			piece(
				r,
				cam,
				x,
				y,
				a,
				0,
				side * (bodyHalf + reach / 2),
				0,
				spec(10 * s, reach, b.wing, PET_Z, 3 * s, b.edge, 1),
			);
			// the dark primaries at the wing tips, swept a little back (only once the wing is out past the body)
			if (reach > 8 * s) {
				piece(
					r,
					cam,
					x,
					y,
					a,
					-2 * s,
					side * (bodyHalf + reach - 3 * s),
					0,
					spec(8 * s, 6 * s, b.tip, PET_Z + 1, 2 * s),
				);
			}
		}
	}
	// tail
	piece(r, cam, x, y, a, -9 * s, 0, 0, spec(8 * s, (b.soars ? 11 : 7) * s, b.tail, PET_Z, 2 * s, b.edge, 1));
	// body
	piece(r, cam, x, y, a, 0, 0, 0, spec(15 * s, 10 * s, b.body, PET_Z + 1, 5 * s, b.edge, 1));
	if (open <= 0.02) {
		// landed pigeon: the folded wings along its back, with the dark bar across them
		for (const side of SIDES) {
			piece(r, cam, x, y, a, -2.5 * s, side * 3.2 * s, 0, spec(11 * s, 3.5 * s, b.wing, PET_Z + 2, 1.5 * s));
			piece(r, cam, x, y, a, -5 * s, side * 3.2 * s, 0, spec(2 * s, 3.5 * s, b.tip, PET_Z + 3));
		}
	}
	// head and beak
	disc(r, cam, x, y, a, 8 * s, 0, 7 * s, spec(7 * s, 7 * s, b.head, PET_Z + 2, undefined, b.edge, 1));
	piece(r, cam, x, y, a, 12 * s, 0, 0, spec(4 * s, (b.soars ? 3.5 : 2.5) * s, b.beak, PET_Z + 3, 1));
}
