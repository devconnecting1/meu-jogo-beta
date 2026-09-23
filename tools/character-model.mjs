/*
 * The characters as shapes (docs/DESIGN_RULES.md ART-07..ART-10): every survivor body (each outfit, each grip,
 * walking, swinging and downed), the weapons in their hands, every zombie type and every pet, described once in the
 * body's own frame. tools/character-art.mjs rasterises these parts, at every heading, into the sprite sheets of
 * design/world-art (4 world units per texel, like the town).
 *
 * Only the generator reads this file: the game never builds a character from parts. It draws the baked cells
 * (client/view/charArt.ts), or -- with no asset id -- the flat drawing it always had (survivorView.ts,
 * humanoidView.ts, cosmeticsView.ts). So nothing here has to be allocation-free or Luau-safe.
 *
 * Frame: `f` along the heading (forward), `l` to the body's right; `w` is a part's size along its own axis (the
 * heading turned by `tilt`), `h` across it. World units, and the sizes are the FILL: the one-texel outline goes
 * round the whole silhouette. The proportions are the flat drawing's, which the owner already reads at a glance: a
 * survivor 24 x 38 with a 22 head and the hands on the weapon; a zombie 26 x 36 with a 20 head and its arms straight
 * ahead. What the pixel art adds is the outline, the light, the cloth, the wear and the blood.
 *
 * Why so few parts: at 4 units per texel a detail is a texel or nothing. Every part here is meant to land on whole
 * texels at every heading, and the colour ramps (charRamp) are what give the form. No random noise: a speck that
 * jumps from texel to texel as the body turns reads as flicker, not dirt.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** the palette of shared/engine/colors.ts, as [r, g, b] 0..255 (the same reader tools/gen-world-art.mjs uses) */
export const PALETTE = (() => {
	const src = readFileSync(join(ROOT, "src", "shared", "engine", "colors.ts"), "utf8");
	const out = {};
	for (const m of src.matchAll(/(\w+): Color3\.fromRGB\((\d+), (\d+), (\d+)\)/g)) {
		out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
	}
	return out;
})();

const clamp255 = v => Math.max(0, Math.min(255, Math.round(v)));

/**
 * A colour ramp as a pixel artist builds one: `deep` (the darkest, for contact shadows), `dark`, `base`, `light`.
 * Shadows shift cool and a little more saturated, lights warm -- the town's rule (ART-02).
 */
export function charRamp(r, g, b) {
	return {
		deep: [clamp255(r * 0.42 + 4), clamp255(g * 0.42 + 4), clamp255(b * 0.5 + 12)],
		dark: [clamp255(r * 0.7), clamp255(g * 0.72 + 2), clamp255(b * 0.82 + 8)],
		base: [r, g, b],
		light: [clamp255(r + (255 - r) * 0.3 + 10), clamp255(g + (250 - g) * 0.28 + 8), clamp255(b + (226 - b) * 0.2)],
	};
}
const rampOf = c => charRamp(c[0], c[1], c[2]);
const mixc = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const scalec = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

/** the outline ink: near black with a hint of warmth (LEG-03: darker than every ground of the town) */
export const INK = [22, 18, 22];
/** the ring of a downed survivor: the survivor's blood (LEG-02, MP-03) */
export const INK_DOWNED = [118, 20, 26];

// ---------------------------------------------------------------- parts

/**
 * A list of parts, painted in `layer` order (then insertion order). Options:
 *   shape  "box" (rounded by `round`) or "oval"
 *   dome   0..1, how round the part is lit (1 a sphere/pillow, 0 flat)
 *   lift   stands above what is under it: casts a one-texel shadow down-right (light from the top left)
 *   detail a small mark that must survive at this scale: wins a texel it covers by a third
 *   thin   a limb: counts in the silhouette at a lower coverage, so a diagonal arm stays one piece
 *   flat   lit as a flat surface whatever its shape (blood, stripes, patches: printed on what is under them)
 *   glow   lit from inside (acid, boils): bright core, no shadow side
 *   ring   outlined where it lies over the body too (a head, a hat): the selective outline of pixel art
 */
export class Parts {
	constructor() {
		this.list = [];
	}
	box(f, l, w, h, ramp, layer, o = {}) {
		this.list.push({ shape: "box", f, l, w, h, ramp, layer, tilt: 0, round: 0, dome: 1, ...o });
		return this;
	}
	oval(f, l, w, h, ramp, layer, o = {}) {
		this.list.push({ shape: "oval", f, l, w, h, ramp, layer, tilt: 0, round: 0, dome: 1, ...o });
		return this;
	}
	/** a limb from (f0, l0) to (f1, l1), `width` across, rounded ends */
	limb(f0, l0, f1, l1, width, ramp, layer, o = {}) {
		const len = Math.hypot(f1 - f0, l1 - l0);
		return this.box((f0 + f1) / 2, (l0 + l1) / 2, len + width * 0.3, width, ramp, layer, {
			tilt: Math.atan2(l1 - l0, f1 - f0),
			round: width / 2,
			thin: true,
			...o,
		});
	}
}

const SIDES = [-1, 1];

// ================================================================ survivors

/** OutfitLook (shared/data/cosmetics.ts): 0 plain, 1 Santa, 2 Zombie, 3 Cowboy */
export const OUTFITS = 4;

const SKIN = charRamp(226, 184, 146);
/** the survivors' blue since the first build (COLORS.player), a shade deeper: a work jacket, not a sky */
const JACKET = rampOf(mixc(PALETTE.player, [52, 96, 150], 0.35));
const JACKET_PATCH = charRamp(142, 128, 92);
const PACK = charRamp(164, 140, 90);
const PACK_FLAP = charRamp(122, 100, 62);
const HAIR = charRamp(62, 46, 38);
const BOOTS = charRamp(70, 54, 44);

const SANTA_RED = charRamp(196, 38, 46);
const SANTA_FUR = charRamp(240, 238, 230);
const SANTA_SACK = charRamp(150, 112, 70);
const SANTA_BOOTS = charRamp(44, 36, 36);

const COSTUME_RAGS = charRamp(112, 102, 88);
const COSTUME_TORN = charRamp(72, 64, 56);
const COSTUME_SKIN = charRamp(150, 186, 112);
const COSTUME_HAIR = charRamp(62, 54, 44);
const COSTUME_PACK = charRamp(94, 88, 74);
const COSTUME_BOOTS = charRamp(58, 50, 44);

const COWBOY_SHIRT = charRamp(226, 206, 164);
const COWBOY_VEST = charRamp(104, 64, 34);
const COWBOY_HAT = charRamp(188, 142, 84);
const COWBOY_CROWN = charRamp(160, 114, 62);
const COWBOY_BAND = charRamp(66, 42, 26);
const COWBOY_ROLL = charRamp(98, 108, 126);
const COWBOY_STRAP = charRamp(70, 48, 32);
const COWBOY_BOOTS = charRamp(106, 66, 36);

/** what each outfit wears: torso, sleeve, cuff (or undefined), hand, boots */
const OUTFIT = [
	{ torso: JACKET, sleeve: JACKET, cuff: undefined, hand: SKIN, boots: BOOTS },
	{ torso: SANTA_RED, sleeve: SANTA_RED, cuff: SANTA_FUR, hand: SANTA_FUR, boots: SANTA_BOOTS },
	{ torso: COSTUME_RAGS, sleeve: COSTUME_RAGS, cuff: COSTUME_TORN, hand: COSTUME_SKIN, boots: COSTUME_BOOTS },
	{ torso: COWBOY_SHIRT, sleeve: COWBOY_SHIRT, cuff: undefined, hand: SKIN, boots: COWBOY_BOOTS },
];

/** the torso's depth along the heading and its width across it (fill), and where the arms leave it */
const TORSO_W = 16;
const TORSO_H = 30;
const SHOULDER_F = 1;
const SHOULDER_L = 11;
/** how far a boot swings along the heading at full stride, and how far the shoulders sway with it (radians) */
const STRIDE = 9;
const SWAY = 0.08;

/**
 * A standing survivor holding with the given hands ([fR, lR, fL, lL]: right hand, then left, in the body frame --
 * charSheets.GRIP_HANDS) at stride `step` (-1..1): boots, torso, what the outfit carries on the back, both arms
 * and the head or hat, as ONE silhouette. The weapon is not here: it is its own sprite, under this one.
 */
export function survivorParts(outfit, hands, step) {
	const p = new Parts();
	const o = OUTFIT[outfit] ?? OUTFIT[0];
	for (const side of SIDES) p.box(step * STRIDE * side, side * 6.5, 10, 8, o.boots, 0, { round: 3.5, dome: 0.6 });
	// the shoulders sway a little with the stride: the walk reads even with the boots under the body
	p.box(0, 0, TORSO_W, TORSO_H, o.torso, 2, { round: 7, dome: 0.85, main: true, tilt: step * SWAY });
	if (outfit === 1) {
		// Santa: the toy sack over one shoulder instead of a pack
		p.oval(-12, 3, 12, 15, SANTA_SACK, 4, { lift: true, dome: 0.9 });
		p.box(-7, 7, 4, 4, charRamp(96, 70, 44), 5, { round: 1, flat: true, detail: true });
	} else if (outfit === 2) {
		// the zombie costume: rags torn open on painted green skin, a pack that has seen better days; still a
		// SURVIVOR silhouette -- hands on the weapon, a pack on the back, no arms reaching out (P3, LEG-03)
		p.box(2, -8, 6, 5, COSTUME_SKIN, 3, { tilt: 0.5, round: 1, flat: true, detail: true });
		p.box(-1, 8, 6, 5, COSTUME_SKIN, 3, { tilt: -0.4, round: 1, flat: true, detail: true });
		p.box(-11, 0, 8, 17, COSTUME_PACK, 4, { round: 3, lift: true });
		p.box(-13, -4, 3.5, 4, COSTUME_TORN, 5, { flat: true, detail: true });
	} else if (outfit === 3) {
		// the cowboy: cream shirt, an open leather vest over the shoulders, a bedroll strapped across the back
		for (const side of SIDES) p.box(-1, side * 8.5, 13, 11, COWBOY_VEST, 3, { round: 3.5, dome: 0.7 });
		p.box(-11, 0, 8, 26, COWBOY_ROLL, 4, { round: 4, lift: true });
		for (const side of SIDES) p.box(-11, side * 6, 9, 2.5, COWBOY_STRAP, 5, { flat: true });
	} else {
		// plain: the blue work jacket with a patch on one shoulder (it has seen a few days out here), and the
		// backpack -- the survivor's signature from above: no zombie carries one (P3)
		p.box(-2, 9, 5, 5, JACKET_PATCH, 3, { round: 1, flat: true, detail: true });
		p.box(-11, 0, 8, 18, PACK, 4, { round: 3, lift: true });
		p.box(-13.5, 0, 3, 13, PACK_FLAP, 5, { round: 1, flat: true });
	}
	// the arms, from the shoulders to the hands, over the torso and under the head
	const [fR, lR, fL, lL] = hands;
	arm(p, o, SHOULDER_F, SHOULDER_L, fR, lR);
	arm(p, o, SHOULDER_F, -SHOULDER_L, fL, lL);
	head(p, outfit);
	return p.list;
}

function arm(p, o, sf, sl, hf, hl) {
	p.limb(sf, sl, hf, hl, 7, o.sleeve, 6, { dome: 0.7 });
	const len = Math.hypot(hf - sf, hl - sl);
	if (o.cuff !== undefined && len > 10) {
		const k = (len - 4) / len;
		p.oval(sf + (hf - sf) * k, sl + (hl - sl) * k, 6, 7.5, o.cuff, 7, { flat: true });
	}
	p.oval(hf, hl, 8, 8, o.hand, 8, { detail: true, lift: true, dome: 0.7 });
}

/** the head seen from above, or the hat on it: over the arms (a hand passes under a brim, never over a face) */
function head(p, outfit) {
	if (outfit === 1) {
		// the beard pokes out ahead of the face, a thin fur brim rings the red cap, and the cap's tip droops back
		// to the pom-pom: the only survivor whose head has a tail (MON-04)
		p.oval(8, 0, 8, 11, SANTA_FUR, 9, { dome: 0.6 });
		p.oval(1, 0, 17, 17, SANTA_FUR, 10, { lift: true, dome: 0.8, ring: true });
		p.oval(0.5, 0, 13, 13, SANTA_RED, 11, { dome: 0.8 });
		p.limb(-3, 1.5, -10, 5, 5.5, SANTA_RED, 11);
		p.oval(-12.5, 6, 7, 7, SANTA_FUR, 12, { lift: true, detail: true });
	} else if (outfit === 3) {
		// the brim is wider than the head: that width is the silhouette from above (MON-04)
		p.oval(1, 0, 23, 23, COWBOY_HAT, 10, { lift: true, dome: 0.5, ring: true });
		p.oval(0.5, 0, 13, 12, COWBOY_BAND, 11, { dome: 0.4 });
		p.oval(0.5, 0, 9.5, 9, COWBOY_CROWN, 12, { dome: 0.9 });
	} else if (outfit === 2) {
		p.oval(1.5, 0, 16, 16, COSTUME_SKIN, 10, { lift: true, ring: true });
		p.oval(-2, -3, 7, 7, COSTUME_HAIR, 11, { detail: true });
		p.oval(-3, 4, 5, 5, COSTUME_HAIR, 11, { detail: true });
	} else {
		p.oval(1.5, 0, 17, 17, HAIR, 10, { lift: true });
		// the brow at the front of the head: which way they look, even with nothing in their hands
		p.oval(8, 0, 4, 8, SKIN, 11, { detail: true, dome: 0.5 });
	}
}

/**
 * Downed (MP-03): flat on the belly, dragging themselves on with both arms, legs trailing; long along the heading
 * instead of wide across it, which alone says "someone is down". `drag` -1..1 swaps which arm pulls.
 */
export function downedParts(outfit, drag) {
	const p = new Parts();
	const o = OUTFIT[outfit] ?? OUTFIT[0];
	const head = [HAIR, SANTA_RED, COSTUME_SKIN, COWBOY_HAT][outfit] ?? HAIR;
	const legs = [charRamp(62, 70, 90), SANTA_RED, COSTUME_TORN, charRamp(78, 84, 104)][outfit] ?? JACKET;
	for (const side of SIDES) {
		p.limb(-8, side * 5, -20 + drag * 3 * side, side * 7, 8, legs, 0);
		p.box(-23 + drag * 3 * side, side * 7, 6, 7.5, o.boots, 1, { round: 2 });
		const reach = 20 - drag * 4 * side;
		p.limb(6, side * 9, reach, side * 11, 7, o.sleeve, 1);
		p.oval(reach + 2, side * 11, 8, 8, o.hand, 2, { detail: true });
	}
	p.box(0, 0, 25, 19, o.torso, 3, { round: 8, main: true });
	if (outfit === 0) p.box(-3, 0, 12, 12, PACK, 4, { round: 3, lift: true });
	if (outfit === 1) p.oval(-3, 2, 12, 13, SANTA_SACK, 4, { lift: true });
	if (outfit === 3) p.box(-5, 0, 7, 17, COWBOY_ROLL, 4, { round: 3.5, lift: true });
	p.oval(15, 0, outfit === 3 ? 19 : 15, outfit === 3 ? 19 : 15, head, 5, { lift: true });
	if (outfit === 1) p.oval(13, 0, 17, 17, SANTA_FUR, 4, { lift: true });
	return p.list;
}

// ================================================================ weapons

const STEEL = charRamp(196, 202, 212);
const DARK_STEEL = charRamp(88, 92, 102);
const GUNMETAL = charRamp(62, 64, 72);
const WOOD = charRamp(142, 96, 54);
const LIGHT_WOOD = charRamp(196, 156, 100);
const GRIP = charRamp(64, 44, 32);
const GOLD = charRamp(224, 180, 66);
const ORANGE = charRamp(214, 110, 36);
const RED_TANK = charRamp(170, 40, 36);
const BOWSTRING = charRamp(214, 206, 180);

/**
 * The weapon visuals, one per row of the weapons sheet, lying along +f and centred: the back end (the handle, the
 * grip, the stock) at -len/2. `len` is the drawn length along the aim: for melee the blade from 14 u to the weapon's
 * reach (MELEE_REACH: "the original's reach was the weapon sprite", so the sprite keeps that length), for guns the
 * length survivorView.ts has always drawn them at.
 */
export function weaponParts(visual, len) {
	const p = new Parts();
	const a = -len / 2;
	const b = len / 2;
	switch (visual) {
		case "dagger":
			p.box(a + 4, 0, 8, 4, GRIP, 0, { round: 1.5 });
			p.box(a + 9, 0, 2.5, 10, DARK_STEEL, 1, { flat: true });
			p.box((a + 10 + b) / 2, 0, b - a - 10, 4.5, STEEL, 0, { round: 2, dome: 0.5 });
			break;
		case "blade":
			p.box(a + 5, 0, 10, 4, GRIP, 0, { round: 1.5 });
			p.box(a + 10.5, 0, 2.5, 10, DARK_STEEL, 1, { flat: true });
			p.box((a + 12 + b) / 2, 0, b - a - 12, 4.5, STEEL, 0, { round: 2, dome: 0.5 });
			break;
		case "goldBlade":
			p.box(a + 5, 0, 10, 4, GRIP, 0, { round: 1.5 });
			p.box(a + 10.5, 0, 2.5, 10, GOLD, 1, { flat: true });
			p.box((a + 12 + b) / 2, 0, b - a - 12, 4.5, GOLD, 0, { round: 2, dome: 0.5 });
			break;
		case "axe":
		case "stoneAxe":
		case "goldAxe": {
			const headRamp = visual === "stoneAxe" ? charRamp(128, 124, 116) : visual === "goldAxe" ? GOLD : STEEL;
			p.box(0, 0, len, 4.5, WOOD, 0, { round: 2 });
			p.box(b - 5, 4, 9, 13, headRamp, 1, { round: 2, lift: true });
			break;
		}
		case "bat":
			p.box(a + 6, 0, 12, 4.5, GRIP, 0, { round: 2 });
			p.box((a + 10 + b) / 2, 0, b - a - 10, 7.5, LIGHT_WOOD, 0, { round: 3.5, dome: 0.8 });
			break;
		case "club":
			p.box(0, 0, len, 5.5, WOOD, 0, { round: 2.5 });
			p.box(a + 5, 0, 10, 6, GRIP, 1, { round: 2 });
			break;
		case "crowbar":
			p.box(0, 0, len, 4.5, charRamp(150, 40, 36), 0, { round: 2 });
			p.box(b - 2, 3, 6, 4.5, charRamp(150, 40, 36), 0, { tilt: 1.1, round: 2 });
			break;
		case "golf":
			p.box(0, 0, len, 3.5, DARK_STEEL, 0, { round: 1.5 });
			p.box(a + 5, 0, 10, 5, GRIP, 1, { round: 2 });
			p.box(b - 2, 3, 7, 6, STEEL, 1, { round: 2 });
			break;
		case "saw":
			p.box(a + 5, 0, 10, 6, WOOD, 0, { round: 2 });
			p.box((a + 9 + b) / 2, 1, b - a - 9, 9, STEEL, 0, { round: 1, dome: 0.4 });
			break;
		case "chainsaw":
			p.box(a + 8, 0, 16, 12, ORANGE, 1, { round: 3, lift: true });
			p.box((a + 14 + b) / 2, 0, b - a - 14, 7, DARK_STEEL, 0, { round: 3.5, dome: 0.4 });
			break;
		case "pistol":
			p.box(a + 4, 0, 8, 5, GRIP, 0, { round: 1 });
			p.box(1, 0, len - 4, 6, GUNMETAL, 1, { round: 1, dome: 0.6 });
			break;
		case "rifle":
			p.box(a + 7, 0, 14, 7, WOOD, 0, { round: 2 });
			p.box(0, 0, len * 0.42, 7, GUNMETAL, 1, { round: 1 });
			p.box((b - len * 0.1 + b) / 2 - len * 0.12, 0, len * 0.46, 4, GUNMETAL, 0, { round: 1 });
			break;
		case "shotgun":
			p.box(a + 7, 0, 14, 7, WOOD, 0, { round: 2 });
			p.box(-1, 0, len * 0.3, 7, GUNMETAL, 1, { round: 1 });
			p.box(len * 0.2, 0, len * 0.55, 5.5, GUNMETAL, 0, { round: 1 });
			p.box(len * 0.18, 0, 9, 7.5, WOOD, 1, { round: 2 });
			break;
		case "mg":
			p.box(a + 6, 0, 12, 8, GUNMETAL, 0, { round: 2 });
			p.box(-2, 0, len * 0.4, 10, GUNMETAL, 1, { round: 2 });
			p.box(len * 0.28, 0, len * 0.44, 4.5, DARK_STEEL, 0, { round: 1 });
			p.box(-3, 6, 8, 6, charRamp(96, 100, 62), 2, { round: 1, lift: true });
			break;
		case "sniper":
			p.box(a + 8, 0, 16, 7, charRamp(76, 82, 62), 0, { round: 2 });
			p.box(-2, 0, len * 0.34, 6, GUNMETAL, 1, { round: 1 });
			p.box(len * 0.25, 0, len * 0.5, 3.5, GUNMETAL, 0, { round: 1 });
			p.box(-1, 0, 16, 4, DARK_STEEL, 2, { round: 2, lift: true });
			break;
		case "bow":
			// held across the aim: the limbs curve back to the string
			p.limb(0, -3, -3, -20, 4.5, WOOD, 1);
			p.limb(0, 3, -3, 20, 4.5, WOOD, 1);
			p.limb(-5, -18, -5, 18, 1.8, BOWSTRING, 0, { flat: true });
			p.box(0, 0, 5, 7, GRIP, 2, { round: 2 });
			break;
		case "crossbow":
			p.box(-6, 0, 22, 6, WOOD, 0, { round: 2 });
			p.limb(5, 0, 1, -18, 4, DARK_STEEL, 1);
			p.limb(5, 0, 1, 18, 4, DARK_STEEL, 1);
			p.limb(0, -17, 0, 17, 1.8, BOWSTRING, 0, { flat: true });
			break;
		case "flamer":
			p.box(a + 8, 0, 16, 10, RED_TANK, 1, { round: 4, lift: true });
			p.box(4, 0, len * 0.6, 5, DARK_STEEL, 0, { round: 2 });
			break;
		default:
			// the stun gun and anything new: a compact gun
			p.box(a + 6, 0, 12, 7, charRamp(210, 190, 60), 1, { round: 2 });
			p.box(4, 0, len * 0.55, 5, GUNMETAL, 0, { round: 1 });
			break;
	}
	return p.list;
}

// ================================================================ zombies

const ZOMBIE_SHOES = charRamp(56, 54, 50);
const ZOMBIE_HAIR = charRamp(50, 44, 36);
/** the victims' blood on a zombie's mouth, hands and shirt: dried to a dark red (LEG-02: red is human blood) */
const BLOOD = charRamp(128, 22, 26);
const ACID = rampOf(PALETTE.acid);
const BOIL = charRamp(238, 176, 72);
const BONE = charRamp(212, 206, 186);

/**
 * Each type keeps the body colour it always had (COLORS.zombie1..5): the SKIN is that colour -- head and arms, the
 * parts that read first -- so the hue that tells a spitter from a walker never moved; what is left of their clothes
 * is the same hue, darker and dirtier, torn to show the skin (grime, ART-09).
 */
function zombieStyle(skin) {
	const cloth = mixc(scalec(skin, 0.52), [88, 86, 80], 0.38);
	return {
		skin: rampOf(skin),
		head: rampOf(mixc(skin, [214, 212, 184], 0.32)),
		cloth: rampOf(cloth),
		torn: rampOf(scalec(cloth, 0.7)),
	};
}
const ZOMBIE_STYLE = {
	1: zombieStyle(PALETTE.zombie1),
	2: zombieStyle(PALETTE.zombie2),
	3: zombieStyle(PALETTE.zombie3),
	4: zombieStyle(PALETTE.zombie4),
	5: zombieStyle(PALETTE.zombie5),
};

/** the radius each type is baked at (shared/data/zombies.ts `radius`); the runtime scales from it */
export const ZOMBIE_RADIUS = { 1: 16, 2: 16, 3: 17, 4: 17, 5: 16 };

/**
 * A zombie of type `kind` (1 walker, 2 spitter, 3 exploder, 4 charger, 5 jumper), each with a silhouette of its own
 * (ART-09). `step` -1..1 is the stride (the shoulders lurch with it), `windup` 0..1 the spitter swelling to spit,
 * `air` the jumper in flight, `rush` the charger charging.
 */
export function zombieParts(kind, step, windup = 0, air = false, rush = false) {
	const p = new Parts();
	const z = ZOMBIE_STYLE[kind] ?? ZOMBIE_STYLE[1];
	const lurch = step * 0.1;
	if (kind === 2) {
		// ---- spitter: hunched, arms hanging, a head too big for it and the acid sac swelling under the jaw
		const k = Math.max(0, Math.min(1, windup));
		for (const side of SIDES) {
			p.box(step * STRIDE * side, side * 6.5, 9, 7, ZOMBIE_SHOES, 0, { round: 3, dome: 0.5 });
			p.limb(0, side * 11, -10 - step * side * 2, side * 15, 6.5, z.skin, 1);
		}
		p.box(-1, 0, 15, 26, z.cloth, 2, { round: 7, dome: 0.85, tilt: lurch, main: true });
		p.box(-5, -6, 5, 6, z.torn, 3, { round: 1, flat: true, detail: true });
		p.oval(12 - 3 * k, 0, 10 + 6 * k, 13 + 7 * k, ACID, 4, { glow: true });
		p.oval(4 - 6 * k, 0, 20, 20, z.head, 5, { lift: true, ring: true });
		p.oval(0 - 6 * k, -4, 6, 7, ZOMBIE_HAIR, 6, { detail: true });
		p.oval(18 - 2 * k, 3, 4, 4, ACID, 6, { glow: true, detail: true });
		return p.list;
	}
	if (kind === 3) {
		// ---- exploder: a bloated round belly of bare skin, stubs for arms, boils about to burst
		for (const side of SIDES) {
			p.box(step * 5 * side, side * 9, 9, 8, ZOMBIE_SHOES, 0, { round: 3, dome: 0.5 });
			p.limb(3, side * 14, 9 - step * side, side * 18, 7.5, z.skin, 1);
		}
		p.oval(0, 0, 30, 33, z.skin, 2, { tilt: lurch * 0.4, main: true });
		p.box(-10, 0, 8, 27, z.torn, 3, { round: 4, dome: 0.6 });
		p.oval(-2, -8, 8, 8, BOIL, 4, { glow: true, detail: true });
		p.oval(4, 8, 7, 7, BOIL, 4, { glow: true, detail: true });
		p.oval(-6, 6, 5, 5, BOIL, 4, { glow: true, detail: true });
		p.oval(13, 0, 13, 13, z.head, 5, { lift: true, ring: true });
		p.box(18, 0, 3, 5, BLOOD, 6, { flat: true, detail: true });
		return p.list;
	}
	if (kind === 4) {
		// ---- charger: shoulders like a door, in the rags of a jersey; the head low and forward between them,
		// heavy fists hanging at its sides -- swung back when it charges
		const lean = rush ? 4 : 0;
		const s = rush ? 1.4 : 1;
		for (const side of SIDES) {
			p.box(step * 7 * s * side - lean, side * 8, 10, 8, ZOMBIE_SHOES, 0, { round: 3, dome: 0.5 });
			const hf = rush ? -12 + step * side * 2 : 5 - step * side * 3;
			const hl = side * (rush ? 19 : 20);
			p.limb(0, side * 15, hf, hl, 8.5, z.skin, 3, { dome: 0.8 });
			p.oval(hf + (rush ? -1 : 1), hl, 10, 10, z.skin, 3, { dome: 0.8 });
			p.box(hf + (rush ? -3 : 4), hl, 3, 7, BLOOD, 4, { flat: true, detail: true });
		}
		p.box(lean * 0.5, 0, 18, 34, z.cloth, 2, { round: 8, dome: 0.85, tilt: lurch * 0.6, main: true });
		for (const side of SIDES) p.oval(lean * 0.5 - 1, side * 9, 13, 12, z.skin, 3, { dome: 0.9 });
		p.box(-5 + lean * 0.5, 0, 3.5, 22, z.torn, 4, { flat: true, tilt: lurch * 0.6 });
		p.oval(11 + lean, 0, 14, 14, z.head, 5, { lift: true, ring: true });
		p.box(16.5 + lean, 0, 3, 5, BLOOD, 6, { flat: true, detail: true });
		return p.list;
	}
	if (kind === 5) {
		// ---- jumper: crouched on long splayed legs; arms down in front, reaching out only in the air
		for (const side of SIDES) {
			const kf = air ? -22 : -14 + step * side * 3;
			const kl = side * (air ? 8 : 14);
			p.limb(-3, side * 6, kf, kl, 7, z.cloth, 0);
			p.box(kf - 3, kl + side * 1, 8, 6.5, ZOMBIE_SHOES, 0, { round: 2, tilt: side * 0.4 });
			if (air) p.limb(3, side * 8, 21, side * 7, 6, z.skin, 1);
			else p.limb(2, side * 9, 13, side * 12, 6, z.skin, 1);
		}
		p.box(1, 0, 15, 22, z.cloth, 2, { round: 7, dome: 0.85, tilt: lurch, main: true });
		// the ribs through what is left of the shirt
		for (const side of SIDES) p.box(0, side * 6, 11, 2.2, BONE, 3, { flat: true, tilt: lurch });
		p.oval(-3, -2, 5, 5, BLOOD, 3, { flat: true, detail: true });
		p.oval(9, 0, 15, 15, z.head, 5, { lift: true, ring: true });
		p.box(14.5, 0, 3, 5, BLOOD, 6, { flat: true, detail: true });
		return p.list;
	}
	// ---- walker: arms straight ahead (the zombie's silhouette, P3), a torn shirt, bloody hands and mouth
	for (const side of SIDES) {
		const sway = step * side;
		p.box(step * 7 * side, side * 7, 9, 7, ZOMBIE_SHOES, 0, { round: 3, dome: 0.5 });
		p.limb(3, side * 10, 27 - sway * 3, side * (9 + lurch * 6), 6.5, z.skin, 3, { dome: 0.7 });
		p.box(29 - sway * 3, side * 9, 4, 6.5, BLOOD, 4, { flat: true, detail: true });
	}
	p.box(0, 0, 16, 28, z.cloth, 2, { round: 7, dome: 0.85, tilt: lurch, main: true });
	p.box(-2, 8, 7, 6, z.skin, 3, { round: 2, flat: true, detail: true });
	p.oval(3, -7, 6, 6, BLOOD, 3, { flat: true, detail: true });
	p.oval(4, 0, 18, 18, z.head, 5, { lift: true, ring: true });
	p.oval(0, -3, 7, 8, ZOMBIE_HAIR, 6, { detail: true });
	p.box(11.5, 0, 3, 6, BLOOD, 6, { flat: true, detail: true });
	return p.list;
}

// ================================================================ pets

const dog = (coat, head, muzzle, ears, paws, scale, slim) => ({
	coat: charRamp(...coat),
	head: charRamp(...head),
	muzzle: charRamp(...muzzle),
	ears: charRamp(...ears),
	paws: charRamp(...paws),
	scale,
	slim,
});
/** PetLook 4..6 (shared/data/cosmetics.ts) */
const DOGS = {
	4: dog([204, 148, 86], [208, 154, 92], [234, 198, 146], [150, 98, 54], [176, 122, 66], 1, 0.95),
	// a wolf-grey darker than the pigeon's slate, so the two greys of the catalogue never read as one
	5: dog([98, 102, 112], [104, 108, 118], [240, 240, 238], [84, 88, 98], [228, 228, 226], 1.14, 1.1),
	6: dog([44, 38, 38], [48, 42, 42], [182, 110, 52], [30, 26, 26], [162, 96, 46], 1, 0.82),
};
const MALAMUTE_WHITE = charRamp(240, 240, 238);

/** a dog trotting (`swing` -1..1: diagonal pairs of paws together) or standing (`wag` -1..1 of the tail) */
export function dogParts(pet, swing, wag) {
	const p = new Parts();
	const d = DOGS[pet] ?? DOGS[4];
	const s = d.scale;
	const w = d.slim;
	const sw = swing * 4;
	for (const side of SIDES) {
		p.box((10 + sw * side) * s, side * 6 * w * s, 6 * s, 4.5 * s, d.paws, 0, { round: 2 });
		p.box((-10 - sw * side) * s, side * 6 * w * s, 6 * s, 4.5 * s, d.paws, 0, { round: 2 });
	}
	if (pet === 6) p.box(-15 * s, 0, 5 * s, 3.5 * s, d.coat, 0, { round: 1, tilt: wag * 0.3 });
	else if (pet === 4) p.limb(-12 * s, 0, -20 * s, (1 + wag * 4) * s, 4.5 * s, d.coat, 0);
	p.oval(0, 0, 27 * s, 12.5 * w * s, d.coat, 1, { main: true });
	for (const side of SIDES) p.box(13 * s, side * 5.5 * s, 7 * s, 4.5 * s, d.ears, 2, { tilt: side * -0.7, round: 1 });
	p.box(20 * s, 0, 7 * s, 5.5 * s, d.muzzle, 2, { round: 2 });
	p.box(23.5 * s, 0, 2 * s, 3 * s, charRamp(28, 22, 22), 3, { detail: true, flat: true });
	p.oval(14 * s, 0, 11.5 * s, 11.5 * s, d.head, 3, { lift: true });
	if (pet === 5) {
		// the white mask down the face, and the bushy tail curled up over the back
		p.oval(17.5 * s, 0, 5.5 * s, 6 * s, MALAMUTE_WHITE, 4, { detail: true });
		p.oval(-10 * s, (2 + wag * 2) * s, 10 * s, 10 * s, MALAMUTE_WHITE, 4, { lift: true });
	} else if (pet === 6) {
		for (const side of SIDES)
			p.oval(16.5 * s, side * 3 * s, 3 * s, 3 * s, d.muzzle, 4, { detail: true, flat: true });
	}
	return p.list;
}

const bird = (body, head, wing, tip, tail, beak, scale, soars) => ({
	body: charRamp(...body),
	head: charRamp(...head),
	wing: charRamp(...wing),
	tip: charRamp(...tip),
	tail: charRamp(...tail),
	beak: charRamp(...beak),
	scale,
	soars,
});
/** PetLook 1..3 */
const BIRDS = {
	1: bird([134, 140, 154], [100, 106, 122], [150, 156, 170], [58, 60, 68], [92, 96, 108], [56, 56, 60], 1, false),
	2: bird(
		[240, 240, 238],
		[250, 250, 250],
		[232, 232, 228],
		[186, 186, 194],
		[222, 222, 220],
		[232, 150, 140],
		1,
		false,
	),
	3: bird([104, 66, 36], [198, 160, 84], [116, 74, 40], [46, 30, 18], [90, 58, 32], [238, 198, 66], 1.35, true),
};

/** a bird with its wings spread `open` 0..1 (0: a landed pigeon, wings folded along its back) */
export function birdParts(pet, open) {
	const p = new Parts();
	const b = BIRDS[pet] ?? BIRDS[1];
	const s = b.scale;
	if (open > 0.02) {
		const reach = 24 * open * s;
		const half = 4.5 * s;
		for (const side of SIDES) {
			p.box(-1 * s, side * (half + reach / 2), 10 * s, reach + 2, b.wing, 0, { round: 3 * s, dome: 0.6 });
			if (reach > 9)
				p.box(-3 * s, side * (half + reach - 3.5 * s), 7 * s, 7 * s, b.tip, 1, { round: 2, flat: true });
		}
	}
	p.box(-9 * s, 0, 8 * s, (b.soars ? 11 : 7) * s, b.tail, 0, { round: 2 * s, dome: 0.5 });
	p.oval(0, 0, 15 * s, 10 * s, b.body, 2, { main: true });
	if (open <= 0.02) {
		for (const side of SIDES) p.box(-2.5 * s, side * 3 * s, 10 * s, 3.5 * s, b.wing, 3, { round: 1.5, dome: 0.5 });
		for (const side of SIDES) p.box(-6 * s, side * 3 * s, 2.5 * s, 3.5 * s, b.tip, 4, { flat: true, detail: true });
	}
	p.oval(8 * s, 0, 7.5 * s, 7.5 * s, b.head, 5, { lift: true });
	p.box(12.5 * s, 0, 4 * s, (b.soars ? 3.5 : 2.5) * s, b.beak, 6, { detail: true, round: 1 });
	return p.list;
}
