/*
 * Last Town: the pixel art of the buildings' doors and entrances (docs/DESIGN_RULES.md ART-17), baked into ONE atlas
 * (design/world-art/entrances.png) that client/view/entranceArt.ts draws a few cells of per doorway -- the ground
 * outside it (a house's step and coir mat, a shop's rubber mat, a hospital's ramp, a school's steps), the leaves of
 * its double door (ESC-02) pinned open against a wall, the doorway's frame with the roof off, and the lintel over it
 * on the roof's edge. Written by tools/gen-world-art.mjs with the rest of the town (`npm run art:world`) and uploaded
 * with it; until the atlas has an id -- or while the uploaded one is not this PNG -- every entrance is drawn by
 * client/view/interiorView.ts's flat Frames, at most two outside and one on the roof (ART-01, ART-16's budget).
 *
 *   import { entranceArt } from "./entrance-art.mjs";
 *   const art = entranceArt({ C });   // { atlas, cells, looks, dims, report }
 *
 * VISUAL ONLY. A doorway of the town is an open gap (EDI-09: the horde's flow field and the survivor's path go
 * straight through it); nothing here changes a solid. So nothing painted here stands in the way: a leaf is pinned
 * flat against the wall beside the gap, or -- where the wall beside it is not free -- swung square to it at the jamb,
 * never across the passage (client/view/entranceArt.ts picks, once per world, and test:world-art §15 checks that
 * the middle of every gap stays clear); a door torn off, a sidewalk menu board knocked over and the stubs of a
 * barricade that was broken through lie flat on the ground (COL-02, like the fallen chairs).
 *
 * THE STYLE is the town's (ART-02, ART-12): the same painter as the furniture (tools/furniture-art.mjs `Canvas`,
 * `orient`, `shade`): 4 world units per texel, a one-texel dark outline, three to five tones per material, light
 * from the top left and a one-texel contact shadow to the bottom right. Every piece is painted in a CANONICAL frame
 * -- the doorway's gap along x (GAP texels), the wall's thickness along y (WALL texels, y 0 the inside face), the
 * outside at the bottom -- and turned to the side the door looks out of BEFORE it is shaded: the four sides are four
 * bakes, never a rotated sprite, so the light never turns with the door.
 *
 * WHICH CELLS (keys; `side` the side the door looks out of, `look` a variant the client picks by the door's place):
 *   stoop:<kind>:<side>:<look>                 the ground outside (under every body, over the ground)
 *   frame:<kind>:<side>                        the doorway across the wall, drawn with the interior (roof off)
 *   roof:<kind>:<side>:<look>                  the lintel on the roof's edge over the door (roof on)
 *   leaf:<kind>:<mode>:<hand>:<side>:<look>    one leaf: mode inFlat / inSquare / outFlat / outSquare, hand a (the
 *                                              jamb at canonical x 0) or b (at x GAP)
 *   fallen:<hand>:<side>:<look>                a house door torn off its hinges, lying face up outside
 *   boards:<side>:<look>                       what is left of a barricade the horde broke through
 * A cell is [x, y, w, h, ox, oy, shadow]: its texels in the atlas (the baked shadow included, right and bottom), and
 * where its top-left lies in texels from the top-left of the doorway's gap rect in the world.
 */
import { Canvas, hashStr, materials, mix, orient, pack, ramp, rng, shade } from "./furniture-art.mjs";

/** a doorway's gap in texels (TOWN.DOOR_W = 112 u, ESC-02) and an outside wall's thickness (TOWN.WALL_T = 20 u) */
const GAP = 28;
const WALL = 5;
/** one leaf of the double door: half the gap long, drawn LEAF_T texels thick (its top edge and a sliver of its face) */
const LEAF_LEN = 14;
const LEAF_T = 5;
/** how far a doorway's frame reaches into the wall at each end of the gap (its jambs), as the interiors' one */
const JAMB = 2;
const SIDES = ["top", "bottom", "left", "right"];
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

// ---------------------------------------------------------------- materials

/** the furniture's materials, and the doors' own (the palette of shared/engine/colors.ts, CON-01) */
function doorMaterials(C) {
	const m = materials(C);
	const add = (name, base, opts) => (m[name] = ramp(base, opts));
	// the ground: a poured step, stone, the ramp; the yellow of a warning strip and of the hazard stripes
	add("concrete", mix(C.sidewalk, WHITE, 0.3));
	add("concreteOld", mix(C.sidewalk, WHITE, 0.14));
	add("rampConcrete", mix(C.sidewalk, WHITE, 0.36));
	add("stone", [196, 188, 164]);
	add("tactile", [214, 178, 62]);
	add("hazard", [220, 180, 58]);
	add("hazardInk", [44, 42, 40]);
	add("grate", [74, 78, 84], { shine: true });
	// mats: coir (a house's), rubber (a shop's, the police's blue-grey), a bank's runner
	add("coir", [156, 112, 64], { soft: true });
	add("coirEdge", [100, 66, 40], { soft: true });
	add("rubberMat", [56, 58, 62]);
	add("rubberBlue", [60, 72, 94]);
	add("runner", [52, 78, 64], { soft: true });
	// the leaves: painted front doors (never the raw wood of a door a survivor builds, COLORS.door), oak, steel
	add("paintWhite", [220, 216, 204]);
	add("paintGreen", [62, 100, 74]);
	add("paintNavy", [56, 68, 104]);
	add("paintOxblood", [114, 52, 46]);
	add("paintTeal", [66, 112, 116]);
	add("paintCream", [206, 196, 164]);
	add("oak", [116, 80, 48]);
	add("steelSchool", [98, 118, 106]);
	add("steelCampus", [128, 50, 68]);
	add("steelGrey", [124, 128, 132]);
	add("alu", [172, 176, 180], { shine: true });
	add("brassDoor", [178, 148, 80], { shine: true });
	add("iron", [58, 60, 66]);
	add("plankOld", [134, 114, 90]);
	// glass a leaf holds: the ground shows through it (like a window's pane, ART-12)
	m.glassLeaf = { ...ramp(mix(C.glassCold, WHITE, 0.3), { shine: true }), alpha: 150 };
	m.glassDark = { ...ramp([70, 84, 94], { shine: true }), alpha: 220 };
	// a shattered leaf's empty frame: the ground seen through it, a breath of the glass that was there
	m.glassGone = { ...ramp(mix(C.glassCold, WHITE, 0.3), { shine: true }), alpha: 34 };
	m.wired = { ...ramp(mix(C.glassCold, WHITE, 0.2), { shine: true }), alpha: 175 };
	// a glazed screen in a wall (the hospital's sliding doors pocketed beside the gap)
	m.screen = { ...ramp(mix(C.glassCold, C.metalDark, 0.25), { shine: true }), alpha: 235 };
	// the roof's edge: a house's door hood, an awning rolled up, a hospital's canopy, a roll-up door's hood
	add("shingle", [84, 78, 74]);
	add("mustard", [220, 170, 66], { soft: true });
	add("rose", [212, 130, 140], { soft: true });
	add("cream", [234, 226, 202], { soft: true });
	add("canopyWhite", [226, 228, 230], { shine: true });
	add("hospBlue", [56, 104, 176]);
	add("policeBlue", [118, 144, 184]);
	add("fireRed", [170, 56, 44]);
	add("galvDoor", [150, 156, 160], { shine: true });
	return m;
}

/** the colours drawn over a material as they are (a lens, chalk, a knob, splinters) */
function doorInks(C) {
	return {
		lens: [222, 216, 188],
		lensDark: [42, 48, 56],
		chalk: mix(C.chalkboard, [214, 220, 210], 0.55),
		knob: [196, 164, 88],
		hinge: [104, 108, 116],
		splinter: [196, 172, 132],
		nail: [150, 154, 160],
		shard: mix(C.glassCold, WHITE, 0.6),
		dirt: [104, 84, 60],
		sticker: [236, 234, 224],
		stickerInk: [70, 72, 78],
		open: [74, 150, 88],
		crack: [60, 70, 78],
		sensor: [30, 32, 36],
		// a step's joint, a crevice: the concrete's and the stone's own colour in deep shade
		jointConcrete: mix(mix(C.sidewalk, WHITE, 0.3), BLACK, 0.42),
		jointStone: mix([196, 188, 164], BLACK, 0.42),
	};
}

// ---------------------------------------------------------------- the canonical frame and the four sides

/**
 * Where the canonical rect [x0, x0 + L) × [y0, y0 + D) lies in the world once the door looks out of `side`, as the
 * top-left of its bake in texels from the top-left of the gap's world rect (the same turn as `orient`).
 */
function placeOf(side, x0, y0, L, D) {
	if (side === "bottom") return [x0, y0];
	if (side === "top") return [GAP - x0 - L, WALL - y0 - D];
	if (side === "left") return [WALL - y0 - D, x0];
	return [y0, GAP - x0 - L];
}

// ---------------------------------------------------------------- the ground outside (canonical: below the wall)

/**
 * Each stoop is painted over canonical x [-A, GAP + A) × y [WALL, WALL + D): local x = canonical x + A, local y 0
 * against the wall's outside face.
 */

/** a house's front step: the poured slab (its nose in shade), the coir mat on it -- straight, kicked askew, or worn */
function stoopStep(c, L, D, look, r, A, K) {
	c.box(0, 0, L, D - 1, "concrete", 2);
	c.box(0, D - 1, L, 1, "concrete", 1, -1);
	for (let k = 0; k < 6; k++) c.shadeAt(1 + Math.floor(r() * (L - 2)), Math.floor(r() * (D - 1)), -1);
	const mw = 22;
	const mh = 4;
	const mx = A + (GAP - mw) / 2 + (look === 1 ? 2 : 0);
	for (let y = 0; y < mh; y++) {
		// kicked askew: each lower row a texel further along
		const sx = mx + (look === 1 ? Math.floor(y / 2) : 0);
		for (let x = 0; x < mw; x++) {
			const edge = x === 0 || x === mw - 1 || y === 0 || y === mh - 1;
			// the weave: short light and dark dashes, a brick bond row by row
			const t = edge ? 0 : (x + (y % 2) * 2) % 4 < 2 ? 1 : -1;
			c.dot(sx + x, 1 + y, edge ? "coirEdge" : "coir", 3, t);
		}
	}
	if (look === 1) {
		// a corner turned up where it was kicked: its underside, lighter
		c.dot(mx + mw + 1, 1 + mh - 1, "coirEdge", 4, 1);
		c.dot(mx + mw, 1 + mh - 1, "coir", 4, 2);
	}
	if (look === 2) {
		// worn: the middle trodden dark, the mud of the last boots
		c.shadeBox(mx + 6, 2, mw - 12, mh - 2, -1);
		for (const [x, y] of [
			[mx + 8, 2],
			[mx + 13, 3],
			[mx + 16, 2],
		]) {
			c.inkAt(x, y, K.dirt);
		}
	}
}

/** a back door's plain step, bare or with a worn rubber mat */
function stoopBack(c, L, D, look, r, A) {
	c.box(0, 0, L, D - 1, "concreteOld", 2);
	c.box(0, D - 1, L, 1, "concreteOld", 1, -1);
	for (let k = 0; k < 4; k++) c.shadeAt(1 + Math.floor(r() * (L - 2)), Math.floor(r() * (D - 1)), -1);
	if (look === 1) {
		c.box(A + 6, 0, GAP - 12, 2, "rubberMat", 3);
		for (let x = A + 7; x < A + GAP - 7; x += 2) c.shadeAt(x, 1, 1);
	}
}

/** a shop's entrance: the aluminium nosing across the doorway and the ribbed rubber mat on the sidewalk */
function stoopMat(c, L, D, look, r, A, K, mat = "rubberMat") {
	c.box(A, 0, GAP, 1, "alu", 2);
	const mx = A + 1;
	const mw = GAP - 2;
	c.box(mx, 1, mw, D - 1, mat, 2);
	for (let y = 2; y < D - 1; y++) c.shadeBox(mx + 1, y, mw - 2, 1, y % 2 === 0 ? 1 : -1);
	if (look === 1) {
		// worn: a paler patch where everyone steps, and a corner curled up
		c.shadeBox(mx + 8, 2, mw - 16, D - 3, 1);
		c.dot(mx + mw - 1, D - 1, mat, 3, 1);
	}
}

/** a diner's: the mat, and its sidewalk menu board knocked flat on its back beside it -- chalk up (COL-02) */
function stoopDiner(c, L, D, look, r, A, K) {
	stoopMat(c, L, D - 7, 0, r, A, K);
	const bx = look === 0 ? L - 11 : 1;
	const by = D - 6;
	c.box(bx, by, 10, 6, "wood", 2);
	c.box(bx + 1, by + 1, 8, 4, "chalk", 2);
	// the day's specials in chalk: short lines, no letters (CON-02)
	for (const [x, y, n] of [
		[2, 1, 5],
		[2, 2, 3],
		[5, 2, 2],
		[2, 3, 4],
	]) {
		for (let k = 0; k < n; k++) c.inkAt(bx + x + k, by + y, K.chalk);
	}
	// the hinge rail across its top, where the other half folded under it
	c.box(bx, by, 10, 1, "woodDark", 3);
}

/** a hospital's: the ramp between its low curbs, grooved against slipping, the yellow warning strip at the doors */
function stoopRamp(c, L, D, look, r, A) {
	c.box(0, 0, 1, D, "concrete", 3);
	c.box(L - 1, 0, 1, D, "concrete", 3);
	c.box(1, 0, L - 2, D - 1, "rampConcrete", 2);
	c.box(1, D - 1, L - 2, 1, "rampConcrete", 1, -1);
	for (let y = 3; y < D - 1; y += 2) c.shadeBox(2, y, L - 4, 1, -1);
	for (let x = A; x < A + GAP; x++) {
		for (let y = 0; y < 2; y++) c.dot(x, y, "tactile", 2, (x + y) % 2 === 0 ? 1 : 0);
	}
	if (look === 1)
		for (let k = 0; k < 8; k++) c.shadeAt(2 + Math.floor(r() * (L - 4)), 3 + Math.floor(r() * (D - 4)), -1);
}

/** a school's (concrete) or the town hall's (stone) steps: three treads, each nose lit and each riser in shade */
function stoopStairs(c, L, D, look, r, A, K, mat = "concrete") {
	const tread = 3;
	const joint = K[mat === "stone" ? "jointStone" : "jointConcrete"];
	for (let k = 0; k < 3; k++) {
		const y0 = k * tread;
		// each tread two steps below the last: its riser takes the light or the shade of the side the door is on
		c.box(0, y0, L, tread, mat, 7 - 2 * k);
	}
	c.box(0, 3 * tread, L, D - 3 * tread, mat, 1, -1);
	// the joint at the foot of each riser, where the tread below begins: a crevice, dark whatever the light, beside the
	// riser's own light or shade -- so the steps read on every side (the edge texels stay the outline)
	for (let k = 1; k <= 3; k++) for (let x = 1; x < L - 1; x++) c.inkAt(x, k * tread, joint);
	if (look === 1) {
		// a chipped nose and the leaves blown into the corner
		c.shadeBox(A + 4, tread, 3, 1, -2);
		for (const [x, y] of [
			[1, 1],
			[2, 4],
			[L - 3, 7],
		]) {
			c.inkAt(x, y, K.dirt);
		}
	}
}

/** the bank's: the brass threshold, and the runner on the top step (the stone stairs are the bank's own, EDI-24) */
function stoopBank(c, L, D, look, r, A) {
	c.box(A, 0, GAP, 1, "brassDoor", 2);
	const sx = look === 1 ? 1 : 0;
	c.box(A + 3 + sx, 1, GAP - 6, D - 1, "runner", 2);
	c.shadeBox(A + 4 + sx, 2, GAP - 8, 1, 1);
}

/** a fire station's or a garage's bay: the trench drain across it, the hazard stripes painted at both jambs */
function stoopBay(c, L, D, look, r, A) {
	for (let x = A; x < A + GAP; x++) {
		c.dot(x, 0, "grate", 2, 0);
		c.dot(x, 1, "grate", 2, x % 2 === 0 ? -2 : 0);
	}
	for (const x0 of [0, L - A]) {
		for (let y = 0; y < D; y++) {
			for (let x = x0; x < x0 + A; x++) c.dot(x, y, (x + y) % 4 < 2 ? "hazard" : "hazardInk", 2);
		}
	}
	if (look === 1) for (let x = A + 3; x < A + GAP - 3; x += 5) c.shadeAt(x, 1, 1);
}

/** a service door's step: old concrete, a crack or two */
function stoopService(c, L, D, look, r) {
	c.box(0, 0, L, D - 1, "concreteOld", 2);
	c.box(0, D - 1, L, 1, "concreteOld", 1, -1);
	if (look === 1) {
		let x = 3 + Math.floor(r() * (L - 8));
		for (let y = 0; y < D - 1; y++) {
			c.shadeAt(x, y, -2);
			x += r() < 0.5 ? 1 : 0;
		}
	}
}

/** the stoops: A texels past the gap at each end, D deep, `looks` variants */
const STOOPS = {
	step: { A: 2, D: 6, looks: 3, draw: stoopStep },
	back: { A: 1, D: 4, looks: 2, draw: stoopBack },
	mat: { A: 0, D: 6, looks: 2, draw: stoopMat },
	matBlue: { A: 0, D: 6, looks: 2, draw: (c, L, D, look, r, A, K) => stoopMat(c, L, D, look, r, A, K, "rubberBlue") },
	diner: { A: 11, D: 13, looks: 2, draw: stoopDiner },
	ramp: { A: 3, D: 11, looks: 2, draw: stoopRamp },
	stairs: { A: 6, D: 10, looks: 2, draw: stoopStairs },
	stoneStairs: {
		A: 6,
		D: 10,
		looks: 2,
		draw: (c, L, D, look, r, A, K) => stoopStairs(c, L, D, look, r, A, K, "stone"),
	},
	bank: { A: 1, D: 4, looks: 2, draw: stoopBank },
	bay: { A: 4, D: 6, looks: 2, draw: stoopBay },
	service: { A: 1, D: 4, looks: 2, draw: stoopService },
};

// ---------------------------------------------------------------- the doorway (canonical: across the wall)

/**
 * The frame of a doorway seen from inside, over canonical x [-JAMB, GAP + JAMB) × y [0, WALL) (a sliding door's
 * screen reaches further along the wall): the casing capping the wall's ends and the sill across the gap.
 */
function frameOf(kind) {
	const casing = { wood: "trim", alu: "alu", steel: "steelGrey", stone: "stone", bay: "steelDark" }[kind] ?? "trim";
	const sill = { wood: "counter", alu: "alu", steel: "steelGrey", stone: "stone", bay: "concrete" }[kind];
	return (c, L, D) => {
		for (let y = 0; y < D; y++) {
			c.dot(0, y, casing, 4, -1);
			c.dot(1, y, casing, 4, 0);
			c.dot(L - 2, y, casing, 4, 0);
			c.dot(L - 1, y, casing, 4, -1);
		}
		if (kind === "bay") {
			// the roll-up door's guide rails in the jambs, and the rubber seal on the sill where it comes down
			for (let y = 0; y < D; y++) {
				c.dot(2, y, "iron", 5, 0);
				c.dot(L - 3, y, "iron", 5, 0);
			}
			c.box(JAMB + 1, D - 2, L - 2 * JAMB - 2, 1, "rubber", 1);
			return;
		}
		const y = Math.floor((D - 1) / 2);
		c.box(JAMB, y, L - 2 * JAMB, 2, sill, 1);
		if (kind === "alu") c.shadeBox(JAMB, y, L - 2 * JAMB, 1, 1);
		if (kind === "stone") c.box(JAMB, y + 1, L - 2 * JAMB, 1, "brassDoor", 1);
	};
}

/**
 * A hospital's automatic doors, stuck part open: the glazed screens the two panels slide into, in the wall beside the
 * gap, and each panel's leading edge still three texels into it; the track across the sill. Canonical x [-SLIDE,
 * GAP + SLIDE).
 */
const SLIDE = 11;
function frameSliding(c, L, D, look, r, A, K) {
	for (const [x0, x1, lead] of [
		[0, A + 3, A + 2],
		[A + GAP - 3, L, A + GAP - 3],
	]) {
		for (let x = x0; x < x1; x++) {
			c.dot(x, 1, "alu", 5, 1);
			c.dot(x, 2, "screen", 4, 0);
			c.dot(x, 3, "alu", 5, -1);
		}
		// the mullions, and the panel's leading stile with its rubber seal
		for (let x = x0 + 4; x < x1 - 1; x += 5) c.dot(x, 2, "alu", 5, 0);
		c.dot(lead, 1, "rubber", 5);
		c.dot(lead, 2, "rubber", 5);
		c.dot(lead, 3, "rubber", 5);
	}
	c.box(A, 2, GAP, 1, "steelDark", 1);
	c.box(A, 1, GAP, 1, "alu", 1, 1);
	// a crack across one panel's screen
	c.inkAt(A - 3, 2, K.crack);
	c.inkAt(A - 5, 2, K.crack);
}

const FRAMES = {
	wood: { A: JAMB, draw: frameOf("wood") },
	alu: { A: JAMB, draw: frameOf("alu") },
	steel: { A: JAMB, draw: frameOf("steel") },
	stone: { A: JAMB, draw: frameOf("stone") },
	bay: { A: JAMB, draw: frameOf("bay") },
	sliding: { A: SLIDE, draw: frameSliding },
};

// ---------------------------------------------------------------- the lintel on the roof's edge (canonical)

/**
 * Painted over canonical x [-JAMB, GAP + JAMB) × y [WALL - F, WALL): inside the roof, on the wall under its edge,
 * never past it (LEG-03: nothing on the roof's layer hangs over the street, where it would hide a zombie). Local y
 * F - 1 is the outside face. Baked without the silhouette outline: it is part of the roof's edge, and its own bevel
 * (lit along its top and left, in shade along its bottom and right, whichever side the door is on) sets it off.
 */

/**
 * A house's door hood: the flashing against the roof, a strip of shingles, the painted fascia on its two brackets;
 * some with a porch lantern at one end (black, its glass unlit: the power is off, LUZ-02).
 */
function roofTrim(c, L, D, look, r, A, K) {
	c.box(0, 0, L, 1, "steel", 3, 1);
	for (let y = 1; y < D - 1; y++) {
		for (let x = 0; x < L; x++) c.dot(x, y, "shingle", 4, (x + (y % 2) * 2) % 4 === 0 ? -1 : y === 1 ? 1 : 0);
	}
	c.box(0, D - 1, L, 1, "paintWhite", 4);
	for (const x of [1, L - 2]) c.box(x, 1, 1, D - 1, "woodDark", 5);
	if (look > 0) {
		const x = look === 1 ? A - 2 : A + GAP;
		c.box(x, D - 3, 2, 3, "iron", 6);
		c.inkAt(x + (look === 1 ? 0 : 1), D - 2, K.lens);
	}
}

/** a back door's: the painted trim over it, and nothing else */
function roofBackTrim(c, L, D) {
	c.box(0, 0, L, D, "paintWhite", 3);
}

/** a service door's steel header, some with a caged wall light over it */
function roofSteelHead(c, L, D, look, r, A, K) {
	c.box(0, 0, L, D, "steelGrey", 3);
	for (let x = 3; x < L - 2; x += 6) c.dot(x, 1, "steelGrey", 3, 1);
	if (look === 1) {
		const x = A + GAP / 2 - 2;
		c.box(x, 0, 4, D, "iron", 5);
		c.inkAt(x + 1, 1, K.lens);
		c.inkAt(x + 2, 1, K.lens);
	}
}

/** a shop's: the aluminium header box across the doors, a closer over each leaf */
function roofShop(c, L, D, look, r, A) {
	c.box(0, 0, L, D, "alu", 3);
	c.box(0, D - 1, L, 1, "steelDark", 3);
	for (const x of [A + 3, A + GAP - 7]) c.box(x, 1, 4, 1, "iron", 4);
}

/** a diner's or a bakery's awning, rolled up the evening the town fell: its stripes and scalloped valance */
function roofAwning(c, L, D, look) {
	const colour = look === 0 ? "mustard" : "rose";
	for (let x = 0; x < L; x++) {
		const m = Math.floor(x / 3) % 2 === 0 ? colour : "cream";
		// rolled: lit along the top of the roll, in shade below it, the valance hanging in scallops
		for (let y = 0; y < D - 1; y++) c.dot(x, y, m, 4, y === 0 ? 1 : y === D - 2 ? -1 : 0);
		if (x % 3 !== 1) c.dot(x, D - 1, m, 3, -1);
	}
	c.box(0, 0, 1, D - 1, "iron", 5);
	c.box(L - 1, 0, 1, D - 1, "iron", 5);
}

/** a hospital's entrance canopy: its white fascia and the hospital's blue band, the sliding doors' operator box */
function roofCanopy(c, L, D, look, r, A, K) {
	c.box(0, 0, L, D, "canopyWhite", 4);
	c.box(0, D - 2, L, 1, "hospBlue", 4);
	const x = A + GAP / 2 - 7;
	c.box(x, 0, 14, 2, "alu", 5);
	c.inkAt(x + 7, 1, K.sensor);
}

/** a school's concrete lintel with the caged wall light over the doors; the campus's with the college's maroon band */
function roofSchool(c, L, D, look, r, A, K) {
	c.box(0, 0, L, D, "concrete", 3);
	if (look === 1) c.box(0, D - 1, L, 1, "steelCampus", 3);
	const x = A + GAP / 2 - 2;
	c.box(x, 0, 4, 2, "iron", 5);
	c.inkAt(x + 1, 1, K.lens);
	c.inkAt(x + 2, 1, K.lens);
}

/** the bank's stone lintel: a brass line along it and the keystone over the doors */
function roofBank(c, L, D, look, r, A) {
	c.box(0, 0, L, D, "stone", 4);
	c.box(0, D - 1, L, 1, "brassDoor", 4);
	c.box(A + GAP / 2 - 2, 0, 4, D, "stone", 5, 1);
}

/**
 * A roll-up door's hood (fire-engine red at the fire station, galvanised at a garage), the curtain's bottom bar
 * hanging out under it: from above, all a roll-up door shows of how far it is up.
 */
function roofHood(c, L, D, look) {
	const m = look === 0 ? "fireRed" : "galvDoor";
	for (let x = 0; x < L; x++) {
		for (let y = 0; y < D - 1; y++) c.dot(x, y, m, 5, x % 4 === 3 ? -1 : y === 0 ? 1 : 0);
	}
	c.box(2, D - 1, L - 4, 1, "rubber", 4);
}

/** the town hall's: a stone lintel, two rosettes and the keystone */
function roofCivic(c, L, D, look, r, A) {
	c.box(0, 0, L, D, "stone", 4);
	c.box(A + GAP / 2 - 2, 0, 4, D, "stone", 5, 1);
	for (const x of [A + 4, A + GAP - 5]) {
		c.dot(x, 1, "stone", 5, 2);
		c.dot(x + 1, 1, "stone", 5, -1);
	}
}

/** the police station's: a steel header with the station's pale blue band */
function roofPolice(c, L, D) {
	c.box(0, 0, L, D, "steelGrey", 3);
	c.box(0, 1, L, 1, "policeBlue", 3);
}

/** the gun shop's: the security grille's steel header, riveted, and a camera at one end */
function roofGrille(c, L, D, look, r, A, K) {
	c.box(0, 0, L, D, "steelDark", 3);
	for (let x = 1; x < L; x += 3) c.shadeAt(x, 1, 2);
	c.box(L - 5, 0, 3, D, "iron", 5);
	c.inkAt(L - 4, 1, K.lensDark);
}

const ROOFS = {
	trim: { F: 4, looks: 3, draw: roofTrim },
	backtrim: { F: 2, looks: 1, draw: roofBackTrim },
	steelhead: { F: 3, looks: 2, draw: roofSteelHead },
	shop: { F: 3, looks: 1, draw: roofShop },
	awning: { F: 4, looks: 2, draw: roofAwning },
	canopy: { F: 4, looks: 1, draw: roofCanopy },
	school: { F: 3, looks: 2, draw: roofSchool },
	bank: { F: 3, looks: 1, draw: roofBank },
	hood: { F: 4, looks: 2, draw: roofHood },
	civic: { F: 3, looks: 1, draw: roofCivic },
	police: { F: 3, looks: 1, draw: roofPolice },
	grille: { F: 3, looks: 1, draw: roofGrille },
};

// ---------------------------------------------------------------- the leaves (painted in the leaf's own frame)

/**
 * A leaf is painted LEAF_LEN texels along it (its hinge at u 0) and LEAF_T across -- v 0 its back, against the wall
 * or the jamb; v 1 its top edge seen from above, lit; v 2-3 a sliver of its face, the side that shows (the furniture's
 * convention, ART-12); v 4 the face's edge, where a knob, a pull or a push bar stands off it. Then it is laid where it
 * rests (`leafPlace`) and turned to the door's side.
 */

const PAINTS = ["paintWhite", "paintGreen", "paintNavy", "paintOxblood"];

/** the leaf's body in `m`, its top edge lit */
function leafBody(c, L, D, m) {
	c.box(0, 0, L, D, m, 3);
	c.shadeBox(0, 1, L, 1, 1);
}

/** sunk panels on the face between (u0, u1) pairs: in shade, their lower edge catching the light */
function panels(c, spans, m) {
	for (const [u0, u1] of spans) {
		c.box(u0, 2, u1 - u0, 2, m, 2, -1);
		c.shadeBox(u0, 3, u1 - u0, 1, 1);
	}
}

/** a house's front door: painted, two sunk panels, the brass knob standing off the face by its free edge */
function leafWood(c, L, D, look, r, K) {
	const paint = PAINTS[look % PAINTS.length];
	leafBody(c, L, D, paint);
	panels(
		c,
		[
			[2, 6],
			[7, 11],
		],
		paint,
	);
	c.inkAt(L - 2, 3, K.knob);
	c.inkAt(L - 2, D - 1, K.knob);
	c.inkAt(0, 1, K.hinge);
}

/** a back door: glazed over a sunk panel, painted teal or cream */
function leafPlank(c, L, D, look, r, K) {
	const paint = look === 0 ? "paintTeal" : "paintCream";
	leafBody(c, L, D, paint);
	c.box(2, 2, 7, 1, "glassLeaf", 2);
	panels(c, [[2, 9]], paint);
	c.box(2, 2, 7, 1, "glassLeaf", 2);
	c.inkAt(L - 2, 3, K.knob);
	c.inkAt(L - 2, D - 1, K.knob);
}

/** the town hall's: oak, three sunk panels, a long brass pull */
function leafOak(c, L, D, look, r, K) {
	leafBody(c, L, D, "oak");
	panels(
		c,
		[
			[2, 5],
			[6, 9],
			[10, 12],
		],
		"oak",
	);
	c.inkAt(L - 2, D - 1, K.knob);
	c.inkAt(L - 3, D - 1, K.knob);
}

/** a shop's glass door: the aluminium frame, the glass with the light on it, the push bar across; shattered, the frame */
function leafGlass(c, L, D, look, r, K, sticker = false) {
	leafBody(c, L, D, "alu");
	for (let u = 2; u < L - 2; u++) {
		for (let v = 2; v < 4; v++) {
			// shattered: the glass gone but for jagged teeth at the corners
			const tooth =
				(u === 2 && v === 2) || (u === 3 && v === 3) || (u === L - 3 && v === 3) || (u === L - 4 && v === 2);
			if (look === 1 && !tooth) c.dot(u, v, "glassGone", 2);
			else c.dot(u, v, "glassLeaf", 2, (u === 4 && v === 2) || (u === 3 && v === 3 && look !== 1) ? 2 : 0);
		}
	}
	if (look === 1) {
		// the last shards caught in the frame's bottom rail
		c.inkAt(6, 3, K.shard);
		c.inkAt(9, 3, K.shard);
	}
	// the push bar, standing off the face
	for (let u = 3; u < L - 3; u++) c.inkAt(u, D - 1, K.nail);
	if (sticker) {
		// a gas station's: the hours card and the little OPEN sign stuck to the glass (no letters: CON-02)
		c.inkAt(8, 2, K.sticker);
		c.inkAt(9, 2, K.sticker);
		c.inkAt(8, 3, K.stickerInk);
		c.inkAt(6, 2, K.open);
	}
}

/** the bank's: heavy dark glass in a brass frame, a long brass pull */
function leafDark(c, L, D, look, r, K) {
	leafBody(c, L, D, "brassDoor");
	c.box(2, 2, L - 4, 2, "glassDark", 2);
	c.dot(4, 2, "glassDark", 2, 2);
	for (let u = L - 5; u < L - 2; u++) c.inkAt(u, D - 1, K.knob);
}

/** the police station's: a steel frame, wired glass, a push bar */
function leafWired(c, L, D, look, r, K) {
	leafBody(c, L, D, "steelGrey");
	for (let u = 2; u < L - 2; u++) {
		for (let v = 2; v < 4; v++) c.dot(u, v, "wired", 2, (u + v) % 2 === 0 ? -1 : 0);
	}
	for (let u = 3; u < L - 3; u++) c.inkAt(u, D - 1, K.nail);
}

const STEELS = ["steelSchool", "steelCampus", "steelGrey"];

/** a school's, the campus's or a service door: painted steel, a wired-glass vision panel, the panic bar across it */
function leafSteel(c, L, D, look, r, K) {
	const paint = STEELS[look % STEELS.length];
	leafBody(c, L, D, paint);
	c.shadeBox(1, 3, L - 2, 1, -1);
	if (look !== 2) c.box(7, 2, 4, 1, "wired", 2);
	for (let u = 2; u < L - 2; u++) c.inkAt(u, D - 1, K.nail);
}

/** the gun shop's security grille, forced: the steel lattice, its far end bent out of true (or its hasp torn out) */
function leafGrille(c, L, D, look, r, K) {
	for (let u = 0; u < L; u++) {
		// bent: the last few bars a texel off the rest
		const off = look === 0 && u >= L - 4 ? 1 : 0;
		for (let v = 0; v < D - 1; v++) {
			const rail = u === 0 || u === L - 1 || v === 0 || v === D - 2;
			if (rail || (u + v) % 2 === 0) c.dot(u, v + off, "iron", 3, rail ? 0 : -1);
		}
	}
	// the pry marks: bright bare steel where the bar went in
	c.inkAt(L - 2, 1 + (look === 0 ? 1 : 0), K.nail);
	if (look === 1) c.inkAt(L - 1, D - 1, K.nail);
}

const LEAVES = {
	wood: { looks: 4, draw: leafWood },
	plank: { looks: 2, draw: leafPlank },
	oak: { looks: 1, draw: leafOak },
	glass: { looks: 2, draw: leafGlass },
	gas: { looks: 1, draw: (c, L, D, look, r, K) => leafGlass(c, L, D, 0, r, K, true) },
	dark: { looks: 1, draw: leafDark },
	wired: { looks: 1, draw: leafWired },
	steel: { looks: 3, draw: leafSteel },
	grille: { looks: 2, draw: leafGrille },
};

/**
 * Where a leaf rests in the canonical frame, and how its own (u, v) land there: pinned flat against the wall's face
 * beside the gap (outside it or inside), or swung square to the wall at its jamb with its face to the passage.
 */
function leafPlace(mode, hand) {
	const a = hand === "a";
	const L = LEAF_LEN;
	const T = LEAF_T;
	if (mode === "outFlat" || mode === "inFlat") {
		const out = mode === "outFlat";
		return {
			x0: a ? -L : GAP,
			y0: out ? WALL : -T,
			w: L,
			h: T,
			map: (u, v) => [a ? -1 - u : GAP + u, out ? WALL + v : -1 - v],
		};
	}
	const out = mode === "outSquare";
	return {
		x0: a ? 0 : GAP - T,
		y0: out ? WALL : -L,
		w: T,
		h: L,
		map: (u, v) => [a ? v : GAP - 1 - v, out ? WALL + u : -1 - u],
	};
}

// ---------------------------------------------------------------- wear (APO-01, a few houses)

/**
 * A house's door torn off its hinges and fallen flat on its step, face up and a little askew, shifted towards the
 * jamb it tore from (hand): the painted face with its four sunk panels (the back door's glazed top), the knob, the
 * hinge leaves torn out with it, a corner split to bare wood. Floor, like a rug (COL-02): the gap behind it is open.
 * The paints are the leaves' (`PAINTS`, then the back door's two), so it matches the leaf still hanging.
 */
const FALLEN_PAINTS = [...PAINTS, "paintTeal", "paintCream"];
const FALLEN = { w: 32, h: 18, x0: -2, y0: WALL };
function fallen(c, L, D, look, r, K, hand) {
	const pi = Math.floor(look / 2) % FALLEN_PAINTS.length;
	const paint = FALLEN_PAINTS[pi];
	const tilt = (look % 2 === 0 ? 0.07 : -0.06) * (hand === "a" ? 1 : -1);
	const cx = L / 2 + (hand === "a" ? -1 : 1);
	const cy = D / 2;
	// the door's own frame: t along it (GAP texels, across the doorway), s across it (a leaf's width)
	const hl = GAP / 2 - 0.5;
	const hw = LEAF_LEN / 2 - 0.5;
	const cos = Math.cos(tilt);
	const sin = Math.sin(tilt);
	for (let y = 0; y < D; y++) {
		for (let x = 0; x < L; x++) {
			const dx = x + 0.5 - cx;
			const dy = y + 0.5 - cy;
			const t = dx * cos + dy * sin;
			const s = -dx * sin + dy * cos;
			if (Math.abs(t) > hl || Math.abs(s) > hw) continue;
			const pt = t + hl;
			const ps = s + hw;
			const glazed = pi >= PAINTS.length && pt > 3 && pt < 11 && ps > 2.5 && ps < LEAF_LEN - 3.5;
			const panel =
				!glazed &&
				ps > 2 &&
				ps < LEAF_LEN - 3 &&
				Math.abs(ps - hw) > 0.9 &&
				((pt > 2.5 && pt < 12.5) || (pt > 15 && pt < GAP - 3.5));
			c.dot(x, y, glazed ? "glassLeaf" : paint, panel ? 1 : 2);
		}
	}
	const at = (pt, ps) => {
		const t = pt - hl;
		const s = ps - hw;
		return [Math.round(cx + t * cos - s * sin - 0.5), Math.round(cy + t * sin + s * cos - 0.5)];
	};
	// the knob by one long edge, halfway along; the torn-out hinges on the other
	const knob = at(GAP / 2, LEAF_LEN - 2);
	c.inkAt(knob[0], knob[1], K.knob);
	for (const pt of [3, GAP - 5]) {
		const h = at(pt, 1);
		c.inkAt(h[0], h[1], K.hinge);
	}
	const split = at(1, 1);
	c.inkAt(split[0], split[1], K.splinter);
	c.inkAt(split[0] + 1, split[1], K.splinter);
}

/** what a barricade the horde broke through leaves: plank stubs still nailed at each jamb, splintered, a nail or two */
function boards(c, L, D, look, r, K) {
	const A = 4;
	const lens = look === 0 ? [7, 5, 6, 8] : [5, 8, 7, 4];
	const rows = [0, 3];
	for (let k = 0; k < 2; k++) {
		const y = rows[k];
		const la = lens[k];
		const lb = lens[k + 2];
		c.box(0, y, la, 2, "plankOld", 3, k === 0 ? 0 : -1);
		c.box(L - lb, y, lb, 2, "plankOld", 3, k === 0 ? 0 : -1);
		// the splintered ends: ragged, bare wood
		c.clear(la - 1, y + (k % 2));
		c.inkAt(la - 2, y, K.splinter);
		c.inkAt(L - lb + 1, y + 1, K.splinter);
		c.clear(L - lb, y + ((k + 1) % 2));
		// the nails in the wall's face beside the gap
		c.inkAt(A - 2, y, K.nail);
		c.inkAt(L - A + 1, y + 1, K.nail);
	}
}

// ---------------------------------------------------------------- the atlas

/**
 * The styles the sheet shows (docs/art/entrances-sheet.png): the ones client/view/entrances.ts gives each building
 * type (that table decides; this list only labels the picture).
 */
export const SHEET_STYLES = [
	["house", { stoop: "step", frame: "wood", roof: "trim", roofLook: 1, leaves: [["wood", true, 1]] }],
	[
		"house, back door",
		{ stoop: "back", stoopLook: 1, frame: "wood", roof: "backtrim", leaves: [["plank", true, 0]] },
	],
	["shop", { stoop: "mat", frame: "alu", roof: "shop", leaves: [["glass", false, 0]] }],
	[
		"shop, a leaf shattered",
		{ stoop: "mat", stoopLook: 1, frame: "alu", roof: "shop", leaves: [["glass", false, 1]] },
	],
	["diner", { stoop: "diner", frame: "alu", roof: "awning", roofLook: 0, leaves: [["glass", false, 0]] }],
	["bakery", { stoop: "mat", frame: "alu", roof: "awning", roofLook: 1, leaves: [["glass", false, 0]] }],
	["gas station", { stoop: "mat", frame: "alu", roof: "shop", leaves: [["gas", false, 0]] }],
	[
		"gun shop",
		{
			stoop: "mat",
			frame: "alu",
			roof: "grille",
			leaves: [
				["grille", false, 0],
				["glass", true, 1],
			],
		},
	],
	["hospital", { stoop: "ramp", frame: "sliding", roof: "canopy", leaves: [] }],
	["school", { stoop: "stairs", frame: "steel", roof: "school", leaves: [["steel", false, 0]] }],
	["campus", { stoop: "stairs", frame: "steel", roof: "school", roofLook: 1, leaves: [["steel", false, 1]] }],
	["bank", { stoop: "bank", frame: "stone", roof: "bank", leaves: [["dark", true, 0]] }],
	["town hall", { stoop: "stoneStairs", frame: "stone", roof: "civic", leaves: [["oak", true, 0]] }],
	["police", { stoop: "matBlue", frame: "steel", roof: "police", leaves: [["wired", false, 0]] }],
	["fire station bay", { stoop: "bay", frame: "bay", roof: "hood", roofLook: 0, leaves: [] }],
	["garage bay", { stoop: "bay", stoopLook: 1, frame: "bay", roof: "hood", roofLook: 1, leaves: [] }],
	[
		"service door",
		{ stoop: "service", frame: "steel", roof: "steelhead", roofLook: 1, leaves: [["steel", false, 2]] },
	],
];

/** the whole atlas: `{ atlas: { w, h, toCanvas }, cells, looks, dims, report }`; `C` the palette ([r, g, b] by name) */
export function entranceArt({ C }) {
	const MAT = doorMaterials(C);
	const K = doorInks(C);
	const entries = [];
	const offsets = {};
	const looks = {};
	const report = { cells: 0 };
	/** a canonical canvas `cv` over [x0, x0 + L) × [y0, y0 + D), turned to `side`, shaded and packed as `key` */
	const bake = (key, cv, x0, y0, side, shadow, outline = true) => {
		const img = shade(orient(cv, side), MAT, { shadow, outline });
		entries.push({ key, img, shadow });
		offsets[key] = placeOf(side, x0, y0, cv.L, cv.D);
	};
	for (const [kind, s] of Object.entries(STOOPS)) {
		looks[`stoop:${kind}`] = s.looks;
		const L = GAP + 2 * s.A;
		for (let look = 0; look < s.looks; look++) {
			for (const side of SIDES) {
				const cv = new Canvas(L, s.D);
				s.draw(cv, L, s.D, look, rng(hashStr(`stoop:${kind}:${look}`)), s.A, K);
				bake(`stoop:${kind}:${side}:${look}`, cv, -s.A, WALL, side, 1);
			}
		}
	}
	for (const [kind, f] of Object.entries(FRAMES)) {
		const L = GAP + 2 * f.A;
		for (const side of SIDES) {
			const cv = new Canvas(L, WALL);
			f.draw(cv, L, WALL, 0, rng(hashStr(`frame:${kind}`)), f.A, K);
			bake(`frame:${kind}:${side}`, cv, -f.A, 0, side, 0, false);
		}
	}
	for (const [kind, f] of Object.entries(ROOFS)) {
		looks[`roof:${kind}`] = f.looks;
		const L = GAP + 2 * JAMB;
		for (let look = 0; look < f.looks; look++) {
			for (const side of SIDES) {
				const cv = new Canvas(L, f.F);
				f.draw(cv, L, f.F, look, rng(hashStr(`roof:${kind}:${look}`)), JAMB, K);
				bake(`roof:${kind}:${side}:${look}`, cv, -JAMB, WALL - f.F, side, 0, false);
			}
		}
	}
	for (const [kind, f] of Object.entries(LEAVES)) {
		looks[`leaf:${kind}`] = f.looks;
		for (let look = 0; look < f.looks; look++) {
			// one picture of the leaf, laid in each of its places
			const own = new Canvas(LEAF_LEN, LEAF_T);
			f.draw(own, LEAF_LEN, LEAF_T, look, rng(hashStr(`leaf:${kind}:${look}`)), K);
			for (const mode of ["inFlat", "inSquare", "outFlat", "outSquare"]) {
				for (const hand of ["a", "b"]) {
					const p = leafPlace(mode, hand);
					const cv = new Canvas(p.w, p.h);
					for (let v = 0; v < LEAF_T; v++) {
						for (let u = 0; u < LEAF_LEN; u++) {
							const i = v * LEAF_LEN + u;
							if (own.mat[i] === null) continue;
							const [x, y] = p.map(u, v);
							const j = (y - p.y0) * p.w + (x - p.x0);
							cv.mat[j] = own.mat[i];
							cv.z[j] = own.z[i];
							cv.tone[j] = own.tone[i];
							cv.ink[j] = own.ink[i];
						}
					}
					for (const side of SIDES)
						bake(`leaf:${kind}:${mode}:${hand}:${side}:${look}`, cv, p.x0, p.y0, side, 1);
				}
			}
		}
	}
	// a torn-off door fallen on its step: the leaves' paints (look = paint × 2 + which way askew), by its jamb
	looks.fallen = FALLEN_PAINTS.length * 2;
	for (let look = 0; look < looks.fallen; look++) {
		for (const hand of ["a", "b"]) {
			const cv = new Canvas(FALLEN.w, FALLEN.h);
			fallen(cv, FALLEN.w, FALLEN.h, look, rng(hashStr(`fallen:${look}`)), K, hand);
			for (const side of SIDES) bake(`fallen:${hand}:${side}:${look}`, cv, FALLEN.x0, FALLEN.y0, side, 1);
		}
	}
	looks.boards = 2;
	for (let look = 0; look < looks.boards; look++) {
		const L = GAP + 8;
		const cv = new Canvas(L, 5);
		boards(cv, L, 5, look, rng(hashStr(`boards:${look}`)), K);
		for (const side of SIDES) bake(`boards:${side}:${look}`, cv, -4, WALL, side, 1);
	}
	const packed = pack(entries);
	const cells = {};
	for (const [k, c] of Object.entries(packed.cells)) cells[k] = [c[0], c[1], c[2], c[3], ...offsets[k], c[4]];
	report.cells = entries.length;
	report.unique = packed.unique;
	return {
		atlas: { w: packed.w, h: packed.h, toCanvas: () => ({ w: packed.w, h: packed.h, data: packed.data }) },
		cells,
		looks,
		dims: { GAP, WALL, LEAF_LEN, LEAF_T, JAMB },
		report,
	};
}

/** src/client/view/entranceAtlas.ts: the cells, the looks and the dimensions they were painted to */
export function entranceAtlasModule(art, name) {
	const L = [];
	L.push("// generated by tools/gen-world-art.mjs (tools/entrance-art.mjs) — do not edit");
	L.push(
		`// the entrances' atlas: design/world-art/${name}.png; its asset id is WORLD_ART.${name} in worldArtAssets.ts (upload-art)`,
	);
	L.push("");
	L.push("/** the atlas's size in texels (one texel = 4 world units) */");
	L.push(`export const ENTRANCE_ATLAS_W = ${art.atlas.w};`);
	L.push(`export const ENTRANCE_ATLAS_H = ${art.atlas.h};`);
	L.push("");
	L.push("/** texels: a doorway's gap and wall (112 × 20 u), a leaf's length and drawn thickness, a frame's jamb */");
	for (const [k, v] of Object.entries(art.dims)) L.push(`export const ENTRANCE_${k} = ${v};`);
	L.push("");
	L.push('/** how many looks each part has ("stoop:<kind>", "roof:<kind>", "leaf:<kind>", "fallen", "boards") */');
	L.push("export const ENTRANCE_LOOKS: Record<string, number> = {");
	// quoted only where it must be (prettier's quote-props "as-needed": the module is written as prettier leaves it)
	for (const [k, n] of Object.entries(art.looks).sort()) L.push(`\t${/^\w+$/.test(k) ? k : `"${k}"`}: ${n},`);
	L.push("};");
	L.push("");
	L.push("/**");
	L.push(
		" * Every cell: [x, y, w, h, ox, oy, shadow] in texels -- its rect in the atlas (its baked shadow included, right and",
	);
	L.push(
		" * bottom), then where its top-left lies from the top-left of the doorway's gap rect in the world, and the shadow.",
	);
	L.push(' * Keys: "stoop:<kind>:<side>:<look>", "frame:<kind>:<side>", "roof:<kind>:<side>:<look>",');
	L.push(
		' * "leaf:<kind>:<inFlat|inSquare|outFlat|outSquare>:<a|b>:<side>:<look>", "fallen:<a|b>:<side>:<look>", "boards:<side>:<look>".',
	);
	L.push(" */");
	L.push(
		"export const ENTRANCE_CELLS: Record<string, readonly [number, number, number, number, number, number, number]> = {",
	);
	for (const [k, c] of Object.entries(art.cells)) L.push(`\t"${k}": [${c.join(", ")}],`);
	L.push("};");
	L.push("");
	return L.join("\n");
}

/**
 * docs/art/entrances-sheet.png: every entrance style composed as the game lays it out, the door looking down --
 * from the street with the roof on (the lintel on the roof's edge, the stoop and the leaves pinned outside) and with
 * the roof off (the floor, the frame, the leaves pinned inside) -- magnified 3x, labelled; then every leaf, flat and
 * square. `styles`: [label, { stoop, stoopLook, frame, roof, roofLook, leaves: [[kind, inward, look]] }].
 */
export function entranceSheet(art, drawText, C, styles) {
	const Z = 3;
	const canvas = art.atlas.toCanvas();
	const tile = { w: 64, h: 56 };
	const cols = 4;
	const rows = Math.ceil((styles.length * 2) / cols);
	const W = cols * (tile.w * Z + 12) + 12;
	const H = rows * (tile.h * Z + 28) + 12;
	const img = { w: W, h: H, data: Buffer.alloc(W * H * 4) };
	const put = (X, Y, rgb, a = 1) => {
		if (X < 0 || Y < 0 || X >= W || Y >= H) return;
		const i = (Y * W + X) * 4;
		for (let k = 0; k < 3; k++) img.data[i + k] = Math.round(img.data[i + k] * (1 - a) + rgb[k] * a);
		img.data[i + 3] = 255;
	};
	for (let i = 0; i < W * H; i++) {
		img.data[i * 4] = 30;
		img.data[i * 4 + 1] = 30;
		img.data[i * 4 + 2] = 36;
		img.data[i * 4 + 3] = 255;
	}
	const fill = (x0, y0, tx, ty, w, h, rgb) => {
		for (let y = ty; y < ty + h; y++) {
			for (let x = tx; x < tx + w; x++) {
				for (let dy = 0; dy < Z; dy++)
					for (let dx = 0; dx < Z; dx++) put(x0 + x * Z + dx, y0 + y * Z + dy, rgb);
			}
		}
	};
	const cell = (x0, y0, gx, gy, key) => {
		const c = art.cells[key];
		if (c === undefined) return;
		const [cx, cy, cw, ch, ox, oy] = c;
		for (let y = 0; y < ch; y++) {
			for (let x = 0; x < cw; x++) {
				const si = ((cy + y) * canvas.w + cx + x) * 4;
				const a = canvas.data[si + 3] / 255;
				if (a <= 0) continue;
				const rgb = [canvas.data[si], canvas.data[si + 1], canvas.data[si + 2]];
				for (let dy = 0; dy < Z; dy++) {
					for (let dx = 0; dx < Z; dx++)
						put(x0 + (gx + ox + x) * Z + dx, y0 + (gy + oy + y) * Z + dy, rgb, a);
				}
			}
		}
	};
	const walk = mix(C.sidewalk, WHITE, 0.16);
	const wall = C.wallShop;
	const floor = C.floorWood;
	const roof = mix(C.roofGray, BLACK, 0.05);
	styles.forEach(([label, s], i) => {
		for (const off of [false, true]) {
			const k = i * 2 + (off ? 1 : 0);
			const x0 = 12 + (k % cols) * (tile.w * Z + 12);
			const y0 = 12 + Math.floor(k / cols) * (tile.h * Z + 28);
			// the gap at (18, 18): the building above it, the street below
			const gx = 18;
			const gy = 18;
			fill(x0, y0 + 14, 0, 0, tile.w, gy, off ? floor : roof);
			fill(x0, y0 + 14, 0, gy, tile.w, tile.h - gy, walk);
			if (off) {
				fill(x0, y0 + 14, 0, gy, gx, WALL, wall);
				fill(x0, y0 + 14, gx + GAP, gy, tile.w - gx - GAP, WALL, wall);
			} else {
				fill(x0, y0 + 14, 0, gy, tile.w, WALL, roof);
			}
			const Y = y0 + 14;
			cell(x0, Y, gx, gy, `stoop:${s.stoop}:bottom:${s.stoopLook ?? 0}`);
			for (const [kind, inward, look] of s.leaves) {
				if (inward && !off) continue;
				for (const hand of ["a", "b"])
					cell(x0, Y, gx, gy, `leaf:${kind}:${inward ? "inFlat" : "outFlat"}:${hand}:bottom:${look ?? 0}`);
			}
			if (off) cell(x0, Y, gx, gy, `frame:${s.frame}:bottom`);
			else cell(x0, Y, gx, gy, `roof:${s.roof}:bottom:${s.roofLook ?? 0}`);
			drawText(img, `${label} ${off ? "(inside)" : "(street)"}`.slice(0, 34), x0, y0 + 2, 1, [236, 236, 236]);
		}
	});
	return img;
}
