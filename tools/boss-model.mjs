/*
 * The four bosses as shapes (docs/DESIGN_RULES.md ART-14): the centipede, the rafflesia, the giant and the hedgehog,
 * in the same pixel art as the horde (ART-08, ART-10): 4 world units per texel, a one-texel near-black outline, ramps
 * lit from the top left, a selective line round a head. tools/boss-art.mjs rasterises them into their sheets.
 *
 * What each must say at a glance, before any detail (P3: it looks like what it does, bossBrain.ts):
 *   - the CENTIPEDE sweeps through you as a chain: a wide plated head with two hooked fangs, then fifty armoured
 *     segments, each with its pair of legs rippling -- the silhouette is the chain and the legs;
 *   - the RAFFLESIA never moves and pulls you in: a flower as wide as a car, five fleshy warted petals round a pit
 *     full of pale teeth, and six thorned vines sweeping round it -- the vines are what reach you;
 *   - the GIANT lunges in surges: a hunched mountain of flayed muscle, shoulders twice a walker, a small head sunk
 *     between them, fists like boulders, a ridge of bone down the back; charging, it leans in with the fists ahead;
 *   - the HEDGEHOG shoots fans of needles: a dome of dark quills with pale tips, the long needles it fires sticking out
 *     of it all round, a snout and two red eyes in front.
 * Each is baked at the size it is HIT at (shared/game/entities.ts bossHitRadius): centipede head 40 / segment 34,
 * rafflesia 65, giant 45, hedgehog 38. The flat drawing's boss red (COLORS.boss) is the family every one of them is
 * painted from -- chitin, petals, flayed flesh, the quills' roots -- so a boss reads as a boss, never as one of the
 * five zombie colours (ART-10), and red stays "danger" (LEG-02).
 *
 * Frame: `f` along the heading, `l` to the body's right (tools/character-model.mjs Parts). World units.
 */
import { PALETTE, Parts, charRamp } from "./character-model.mjs";

const SIDES = [-1, 1];
const mixc = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const rampOf = c => charRamp(c[0], c[1], c[2]);
/** COLORS.boss (170, 50, 50): every boss is painted from it */
const BOSS = PALETTE.boss ?? [170, 50, 50];

const BONE = charRamp(226, 214, 184);
const BLOOD = charRamp(120, 20, 24);

// ================================================================ the giant (boss 3)

/**
 * The giant's hide: a dead man's pale grey gone violet, so the raw muscle where it burst -- the boss red -- stands out
 * against it (a hue apart from every zombie type: ART-10's five colours are greens, a purple, an orange, an ochre).
 */
const GIANT_SKIN = charRamp(162, 150, 158);
const GIANT_ARM = charRamp(124, 112, 122);
const GIANT_MUSCLE = rampOf(mixc(BOSS, [150, 24, 34], 0.2));
const GIANT_STRIATION = rampOf(mixc(BOSS, [70, 10, 16], 0.6));
const GIANT_FIST = charRamp(108, 96, 106);
const GIANT_HEAD = charRamp(192, 178, 170);
const GIANT_BROW = charRamp(84, 70, 78);
const GIANT_PANTS = charRamp(58, 64, 88);
const GIANT_BOOTS = charRamp(52, 42, 36);

/**
 * The giant at stride `step` (-1..1: the fists swing opposite the feet), or `lunge`: leaning into its surge with both
 * fists forward (bossBrain `updateChargerBoss`: it moves in surges, a sine of its move cycle). From above: a slab of
 * shoulders twice a walker's, the arms hanging down its sides to fists like boulders -- the gorilla's silhouette, not a
 * walker's reaching arms -- a small bald head sunk forward, and the spine's bone spurs down the hump.
 */
export function giantParts(step, lunge = false) {
	const p = new Parts();
	const lean = lunge ? 7 : 0;
	for (const side of SIDES) {
		const swing = step * side;
		// boots: only their toes show past the belly
		p.box(swing * 10 - lean * 0.4, side * 17, 18, 15, GIANT_BOOTS, 0, { round: 5, dome: 0.5 });
		// the arm: raw muscle from the shoulder to the elbow, grey hide from the elbow to a fist like a boulder --
		// hanging at the sides and swinging with the stride, both thrown forward in the lunge
		const ef = lunge ? 12 : -1 - swing * 6;
		const el = side * (lunge ? 44 : 47);
		const ff = lunge ? 36 : -3 - swing * 15;
		const fl = side * (lunge ? 36 : 48);
		p.limb(4 + lean * 0.5, side * 34, ef, el, 18, GIANT_MUSCLE, 3, { dome: 0.85 });
		p.limb(ef, el, ff, fl, 16, GIANT_ARM, 3, { dome: 0.85, ring: true });
		p.oval(ff + 3, fl, 26, 26, GIANT_FIST, 4, { lift: true, dome: 0.9, ring: true });
		// knuckles scraped raw
		p.box(ff + 13, fl, 4, 13, BLOOD, 5, { flat: true, detail: true });
		// the deltoid, burst open
		p.oval(4 + lean * 0.5, side * 31, 26, 24, GIANT_MUSCLE, 4, { dome: 0.95 });
		p.box(5 + lean * 0.5, side * 31, 14, 3, GIANT_STRIATION, 5, { flat: true, detail: true, tilt: side * 0.6 });
	}
	// the waist of torn work pants behind the slab
	p.box(-24 + lean * 0.3, 0, 12, 46, GIANT_PANTS, 1, { round: 5, dome: 0.6 });
	// the slab of the back and shoulders: much wider than it is deep, hunched
	p.box(-3 + lean * 0.5, 0, 40, 80, GIANT_SKIN, 2, { round: 17, dome: 0.85, main: true });
	// a gash across the back where the hide split over the muscle
	p.box(-12 + lean * 0.5, -12, 6, 18, GIANT_MUSCLE, 3, { flat: true, tilt: 0.5 });
	// the spine: a ridge of bone spurs down the hump, what says "not a man" from above
	for (let k = 0; k < 4; k++) p.oval(-20 + k * 7 + lean * 0.5, 0, 7, 6.5, BONE, 4, { lift: true, detail: true });
	// a small bald head sunk forward between the shoulders: dark brows, a bloody jaw
	p.oval(20 + lean, 0, 25, 25, GIANT_HEAD, 6, { lift: true, ring: true });
	p.box(25 + lean, 0, 3.5, 15, GIANT_BROW, 7, { flat: true, detail: true });
	p.box(30 + lean, 0, 3.5, 8, BLOOD, 7, { flat: true, detail: true });
	return p.list;
}

// ================================================================ the hedgehog (boss 4)

const QUILL = rampOf(mixc(BOSS, [58, 42, 36], 0.72));
const QUILL_ROOT = rampOf(mixc(BOSS, [70, 40, 34], 0.5));
const QUILL_TIP = charRamp(230, 214, 176);
const NEEDLE = charRamp(208, 200, 178);
const SNOUT = charRamp(186, 138, 116);
const NOSE = charRamp(40, 30, 32);
const EYE = charRamp(232, 44, 36);
const CLAW = charRamp(96, 72, 60);
/** the paws: the snout's bare skin, so they show against the dark quills */
const PAW = charRamp(168, 118, 98);

/** the hedgehog at stride `step`: its feet under the quills; the needles it fires stick out all round */
export function hedgehogParts(step) {
	const p = new Parts();
	for (const side of SIDES) {
		const s = step * side;
		// the front paws peek out beside the snout, under the first quills: they are what shows it walking
		p.box(24 + s * 8, side * 31, 12, 11, PAW, 0, { round: 3, dome: 0.5 });
		p.box(-16 - s * 6, side * 26, 11, 9, CLAW, 0, { round: 3, dome: 0.5 });
	}
	// the body under the quills: dark red at the roots
	p.oval(-3, 0, 66, 58, QUILL_ROOT, 1, { main: true, dome: 0.9 });
	// the quills, raked back and out, each with its pale tip: the spiky outline IS the hedgehog
	const QUILLS = 15;
	for (let i = 0; i < QUILLS; i++) {
		const a = Math.PI * 0.32 + (i / (QUILLS - 1)) * Math.PI * 1.36;
		const r0 = 14;
		const r1 = 38 + (i % 2) * 6;
		const f0 = Math.cos(a) * r0 - 4;
		const l0 = Math.sin(a) * r0 * 0.9;
		const f1 = Math.cos(a) * r1 - 4;
		const l1 = Math.sin(a) * r1 * 0.9;
		p.limb(f0, l0, f1, l1, 7, QUILL, 2, { dome: 0.6 });
		p.oval(f1 + Math.cos(a) * 2, l1 + Math.sin(a) * 2, 5, 5, QUILL_TIP, 3, { detail: true });
	}
	// the dome's top, lit: the quills lying flat over the back
	p.oval(-6, 0, 40, 34, QUILL, 3, { dome: 1 });
	for (const side of SIDES) p.box(-6, side * 7, 22, 2.4, QUILL_TIP, 4, { flat: true, tilt: side * 0.25 });
	// the long needles it fires, round the body (bossBrain `pushNeedle`): the flat drawing's eight, less the face's
	for (let k = 1; k < 8; k++) {
		const a = (k * Math.PI) / 4;
		p.limb(Math.cos(a) * 30, Math.sin(a) * 26, Math.cos(a) * 60, Math.sin(a) * 52, 4.5, NEEDLE, 4, { dome: 0.4 });
	}
	// the face: a snout, the nose, two red eyes (LEG-02: red is danger, and it is looking at you)
	p.oval(29, 0, 24, 21, SNOUT, 5, { lift: true, ring: true });
	p.oval(40, 0, 7, 7, NOSE, 6, { detail: true });
	for (const side of SIDES) p.oval(28, side * 7, 4.5, 4.5, EYE, 6, { glow: true, detail: true });
	return p.list;
}

// ================================================================ the centipede (boss 1)

const CHITIN = rampOf(mixc(BOSS, [96, 30, 26], 0.35));
const CHITIN_RIM = rampOf(mixc(BOSS, [212, 120, 52], 0.55));
const CHITIN_DARK = rampOf(mixc(BOSS, [40, 14, 14], 0.6));
const LEG = charRamp(214, 150, 64);
const FANG = charRamp(64, 40, 30);
const FANG_TIP = charRamp(232, 200, 120);
const ANTENNA = charRamp(200, 140, 70);
const CENTIPEDE_EYE = charRamp(250, 196, 90);

/** the centipede's head: the plated shield, antennae, and the two hooked fangs -- `open`, spread to bite */
export function centipedeHeadParts(open = false) {
	const p = new Parts();
	for (const side of SIDES) {
		// the antennae: thin, sweeping out and back, under everything
		p.limb(20, side * 20, 44, side * (open ? 42 : 38), 4, ANTENNA, 0);
		p.limb(44, side * (open ? 42 : 38), 50, side * (open ? 52 : 50), 3.5, ANTENNA, 0);
		// the fangs (forcipules): thick, dark, hooked inwards to amber points -- the part that bites; open, spread wide
		const midL = open ? 24 : 18;
		const tipL = open ? 14 : 5;
		p.limb(16, side * 20, 36, side * midL, 11, FANG, 4, { lift: true, dome: 0.8 });
		p.limb(36, side * midL, 48, side * tipL, 8, FANG, 4, { lift: true, dome: 0.8 });
		p.oval(48, side * tipL, 7, 7, FANG_TIP, 5, { detail: true });
	}
	p.oval(0, 0, 56, 70, CHITIN, 2, { main: true, dome: 0.8, ring: true });
	p.box(-1, 0, 38, 5, CHITIN_DARK, 3, { flat: true });
	p.box(-20, 0, 6, 60, CHITIN_RIM, 3, { flat: true });
	for (const side of SIDES) p.oval(15, side * 14, 7, 7, CENTIPEDE_EYE, 4, { glow: true, detail: true });
	return p.list;
}

/**
 * A body segment: a wide armour plate with a lighter rim band at the back, a dark keel down the middle and a pair of
 * legs splayed out under it; `beat` -1..1 is where the legs are in their ripple (the left and the right opposite).
 */
export function centipedeSegmentParts(beat) {
	const p = new Parts();
	for (const side of SIDES) {
		const b = beat * side;
		p.limb(-2, side * 28, 4 + b * 10, side * 48, 8, LEG, 0, { dome: 0.6 });
		p.limb(4 + b * 10, side * 48, -6 + b * 12, side * 58, 6, LEG, 0, { dome: 0.6 });
	}
	p.oval(0, 0, 40, 70, CHITIN, 1, { main: true, dome: 0.75 });
	p.box(-13, 0, 7, 62, CHITIN_RIM, 2, { flat: true });
	p.box(3, 0, 26, 5, CHITIN_DARK, 2, { flat: true });
	return p.list;
}

/** the last segment: smaller, with the two long rear legs trailing behind like a second pair of antennae */
export function centipedeTailParts() {
	const p = new Parts();
	for (const side of SIDES) {
		p.limb(-6, side * 18, -40, side * 34, 5.5, LEG, 0);
		p.limb(-40, side * 34, -60, side * 30, 4, LEG, 0);
	}
	p.oval(0, 0, 36, 56, CHITIN, 1, { main: true, dome: 0.75 });
	p.box(-11, 0, 6, 46, CHITIN_RIM, 2, { flat: true });
	p.box(3, 0, 22, 5, CHITIN_DARK, 2, { flat: true });
	return p.list;
}

// ================================================================ the rafflesia (boss 2)

const PETAL = rampOf(mixc(BOSS, [176, 70, 52], 0.3));
const PETAL_EDGE = rampOf(mixc(BOSS, [110, 28, 30], 0.5));
const WART = charRamp(236, 218, 190);
const RIM = rampOf(mixc(BOSS, [86, 22, 30], 0.55));
const PIT = charRamp(38, 14, 20);
const TOOTH = charRamp(238, 226, 200);
const VINE = charRamp(92, 78, 52);
const THORN = charRamp(214, 196, 150);

/**
 * The rafflesia with its vines `sweep` radians round (charSheets rafflesiaSweep): six thorned vines from under the
 * petals to 120 u out (the flat drawing's tentacles, and the reach of its lash, bossBrain `updateStationary`), five
 * warted petals, the raised rim and the pit with its teeth. Drawn at heading 0: it never turns.
 */
export function rafflesiaParts(sweep) {
	const p = new Parts();
	for (let i = 0; i < 6; i++) {
		const a = sweep + (i * Math.PI) / 3;
		const c = Math.cos(a);
		const s = Math.sin(a);
		// a vine curls a little as it goes out (a bend, not a straight stick), thick at the root
		const bend = a + 0.28;
		const mf = c * 78;
		const ml = s * 78;
		const tf = mf + Math.cos(bend) * 34;
		const tl = ml + Math.sin(bend) * 34;
		p.limb(c * 40, s * 40, mf, ml, 15, VINE, 0, { dome: 0.7 });
		p.limb(mf, ml, tf, tl, 10, VINE, 0, { dome: 0.7 });
		for (const k of [0.45, 0.75]) {
			const tx = c * (40 + (78 - 40) * k) - s * 8;
			const ty = s * (40 + (78 - 40) * k) + c * 8;
			p.oval(tx, ty, 4, 4, THORN, 1, { detail: true });
		}
		p.oval(tf, tl, 7, 7, THORN, 1, { detail: true });
	}
	for (let k = 0; k < 5; k++) {
		const a = (k * Math.PI * 2) / 5 - Math.PI / 2;
		const c = Math.cos(a);
		const s = Math.sin(a);
		p.oval(c * 36, s * 36, 54, 50, PETAL, 2, { tilt: a, dome: 0.75 });
		p.oval(c * 55, s * 55, 16, 34, PETAL_EDGE, 2, { tilt: a, dome: 0.5 });
		// the warts: pale blisters in a loose ring on each petal
		for (const [r, t] of [
			[30, -0.28],
			[42, 0.12],
			[34, 0.32],
			[48, -0.1],
		]) {
			p.oval(Math.cos(a + t) * r, Math.sin(a + t) * r, 5.5, 5.5, WART, 3, { detail: true, flat: true });
		}
	}
	p.oval(0, 0, 46, 46, RIM, 4, { lift: true, dome: 0.9, main: true });
	p.oval(0, 0, 28, 28, PIT, 5, { flat: true });
	for (let k = 0; k < 7; k++) {
		const a = (k * Math.PI * 2) / 7;
		p.oval(Math.cos(a) * 10, Math.sin(a) * 10, 4, 4, TOOTH, 6, { detail: true });
	}
	return p.list;
}
