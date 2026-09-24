/*
 * Project Z: the pixel art of the everyday town's fixtures (docs/DESIGN_RULES.md ART-16; laid out by
 * shared/game/townLots.ts, drawn flat by client/view/townView.ts) -- the street market's stalls, tents, crates, carts
 * and food truck, the street's lamps, hydrants, mailboxes, benches and bus stops, the parks' playgrounds and courts,
 * the backyards' sheds, pools, trampolines and grills, the building site's piles and plant, and the ground they stand
 * on -- baked into ONE atlas (design/world-art/townProps.png) that client/view/townPropArt.ts draws a cell of per
 * fixture. Written by tools/gen-world-art.mjs with the rest of the town (`npm run art:world`) and uploaded with it;
 * until the atlas has an id -- or while the uploaded one is not this PNG -- every fixture is drawn by townView's
 * flat Frames, exactly as before (ART-01).
 *
 *   import { townPropArt } from "./town-prop-art.mjs";
 *   const art = townPropArt({ C });   // { atlas, cells, looks, faceless, strips, report }
 *
 * THE STYLE is the interiors' and the town's (ART-02, ART-12): the same painter (tools/furniture-art.mjs `Canvas`,
 * `shade`): 4 world units per texel, a one-texel dark outline, three to five tones per material, light from the top
 * left, a one-texel contact shadow baked to the bottom right (what stands tall also casts the sun's shadow, drawn by
 * the client each frame like a bin's: LUZ-01; the tents and the shelter's roof bake none). A drawer paints
 * a thing in its canonical frame -- L texels along its front, D deep, its front at the bottom -- and the map is turned
 * to the thing's `Solid.face` before it is shaded (the light never turns with it); a drawer that has a slope (a
 * tent, a shed's roof) is handed the face to put the shaded half on the world's bottom / right. A few days after the
 * outbreak (APO-01): wares taken off the tables, a crate tipped, a tent down on its tables, another torn.
 *
 * WHICH CELLS. Every size townLots.ts gives a fixture (the constants are mirrored in PROPS below, and test:world-art
 * checks that every fixture of five towns finds its cell), in each facing it can have, in each look. A cell is
 * [x, y, w, h, ox, oy, shadow]: its texels in the atlas, where the fixture's rect starts inside it (a hoop's rim
 * hangs over the court in front of its rect) and the texels of baked shadow on its right and bottom. The long thin things -- a site's fence, a frame's studs -- are STRIPS: one
 * long cell along x and one along y, cropped to the length.
 */
import { Canvas, hashStr, materials, mix, orient, pack, ramp, rng, shade } from "./furniture-art.mjs";

/** world units per texel */
const U = 4;
const FACES = ["top", "bottom", "left", "right"];

// ---------------------------------------------------------------- materials

/** the furniture's materials, and the town's own (the colours of client/view/townView.ts's flat drawing) */
function propMaterials(C) {
	const m = materials(C);
	const add = (name, base, opts) => (m[name] = ramp(base, opts));
	// the market (EDI-20)
	add("canvas", [226, 222, 206], { soft: true });
	add("canvasBack", [204, 196, 176], { soft: true });
	add("stripeR", [182, 58, 52], { soft: true });
	add("stripeB", [52, 102, 162], { soft: true });
	add("stripeG", [62, 130, 82], { soft: true });
	add("tablecloth", [214, 208, 190], { soft: true });
	add("apple", [176, 48, 40]);
	add("orange", [214, 132, 44]);
	add("cabbage", [104, 150, 72]);
	add("bread", [196, 146, 84]);
	add("jar", [120, 96, 70], { shine: true });
	add("clothBlue", [72, 92, 150], { soft: true });
	add("clothPurple", [110, 80, 140], { soft: true });
	add("leather", [128, 84, 52]);
	add("truck", [230, 226, 212]);
	add("water", [64, 152, 196], { shine: true });
	// under a tent (what a rent shows), and the old rain lying in a sagging one (dull: LEG-03, not an item)
	add("under", [44, 40, 38]);
	add("rain", [78, 98, 108], { shine: true });
	// what the crowd dropped: a shade darker and without an outline (LEG-03: never read as an item to pick up)
	add("spillApple", [138, 40, 34]);
	add("spillOrange", [176, 102, 34]);
	add("spillCabbage", [84, 116, 56]);
	add("litter", [198, 192, 174], { soft: true });
	add("kraft", [162, 124, 80], { soft: true });
	// the street (MOB-04)
	add("galv", [150, 156, 160], { shine: true });
	add("iron", [58, 60, 66]);
	add("lamp", [88, 92, 98], { shine: true });
	add("hydrant", [190, 52, 42]);
	add("brass", [226, 196, 70], { shine: true });
	add("postBlue", [44, 72, 136]);
	add("mailGrey", [104, 108, 116], { shine: true });
	add("flag", [200, 50, 44]);
	add("signBlue", [44, 92, 164]);
	add("white", [236, 234, 224]);
	m.glassSmoke = { ...ramp([120, 150, 164], { shine: true }), alpha: 200 };
	// the shade a frame of bars casts on the ground between them (the ground shows through, darker)
	m.gapShade = { ...ramp([28, 26, 24]), o: [28, 26, 24], alpha: 70 };
	add("stone", [208, 200, 178]);
	// the parks and the backyards (MOB-05, MOB-06)
	add("playRed", [196, 62, 50]);
	add("playYellow", [226, 184, 58]);
	add("playBlue", [62, 116, 186]);
	add("court", [94, 124, 98]);
	add("courtLine", [222, 226, 220]);
	add("courtKey", [150, 84, 64]);
	add("sand", [214, 196, 150], { soft: true });
	add("soil", [92, 68, 48], { soft: true });
	add("sprout", [88, 134, 64]);
	add("coping", [220, 216, 204]);
	add("padBlue", [56, 110, 180]);
	add("mat", [34, 34, 38]);
	add("grill", [44, 44, 50], { shine: true });
	add("shedRoof", [96, 104, 96]);
	// the building site (EDI-21)
	add("brick", [160, 78, 58]);
	add("steelBar", [110, 116, 124], { shine: true });
	add("toilet", [58, 104, 168]);
	add("mixer", [214, 120, 40]);
	add("dumpster", [56, 96, 68]);
	add("earth", [128, 100, 72], { soft: true });
	add("slab", [184, 182, 174]);
	return m;
}

/** the canonical top half ends up at the world's bottom or right (the shaded side, light from the top left) */
const shadeTop = face => face === "top" || face === "left";

// ---------------------------------------------------------------- the market (EDI-20)

const WARES = [
	["apple", "orange", "cabbage"],
	["bread", "bread", "jar"],
	["clothBlue", "clothPurple", "leather"],
];

/** a trestle table under its cloth, the cloth's drop down the front, and what is still on it (gaps: taken) */
function stall(c, L, D, look, r) {
	c.box(0, 0, L, D, "wood", 3);
	c.box(1, 1, L - 2, D - 3, "tablecloth", 4);
	c.box(0, D - 2, L, 2, "tablecloth", 3, -1);
	for (let x = 4; x < L - 3; x += 7) c.shadeBox(x, 1, 1, D - 3, -1);
	const wares = WARES[look % 3];
	for (let x = 2, k = 0; x < L - 4; x += 5, k++) {
		if (r() < 0.22) continue;
		const m = wares[k % 3];
		if (look === 0) {
			c.disc(x + 1.5, 4, 3, m, 6);
			c.dot(x + 1, 6, m, 6);
			c.dot(x + 3, 6, m, 6);
		} else if (look === 1) {
			if (m === "jar") {
				c.box(x, 3, 2, 2, m, 6);
				c.box(x + 2, 5, 2, 2, m, 6);
			} else {
				c.round(x, 3, 4, 3, m, 6);
				c.shadeBox(x + 1, 4, 2, 1, -1);
			}
		} else {
			c.box(x, 3, 4, 3, m, 6);
			c.shadeBox(x, 4, 4, 1, -1);
		}
	}
}

/** a trestle table knocked over: its top's underside, the two trestles sticking up, the cloth half off at the front */
function trestle(c, L, D, look) {
	c.box(0, 1, L, D - 2, "woodDark", 2);
	for (let y = 3; y < D - 2; y += 3) c.shadeBox(0, y, L, 1, -1);
	for (const x of [3, L - 5]) {
		c.box(x, 0, 2, D, "wood", 6);
		c.box(x - 1, 0, 4, 1, "wood", 6);
		c.box(x - 1, D - 1, 4, 1, "wood", 6);
	}
	const cx = look === 1 ? 4 : L - 17;
	c.box(cx, D - 4, 13, 4, "tablecloth", 3);
	c.shadeBox(cx + 4, D - 4, 1, 4, -1);
	c.shadeBox(cx + 9, D - 4, 1, 4, -1);
}

/** a crate of produce; two stacked; or one tipped over, its open end to the front and what it held rolled out */
function crates(c, L, D, look, r) {
	if (look === 2) {
		c.box(1, 0, L - 2, 6, "wood", 3);
		for (let x = 3; x < L - 2; x += 3) c.shadeBox(x, 0, 1, 6, -1);
		c.box(2, 5, L - 4, 2, "woodDark", 2, -1);
		for (const [x, y, m] of [
			[2, 8, "apple"],
			[5, 9, "cabbage"],
			[7, 8, "orange"],
			[8, 10, "apple"],
		]) {
			c.dot(x, y, m, 2);
		}
		return;
	}
	c.box(0, 0, L, D, "wood", 3);
	for (let y = 3; y < D - 1; y += 3) c.shadeBox(1, y, L - 2, 1, -1);
	c.box(2, 2, L - 4, D - 4, "woodDark", 2);
	for (let k = 0; k < 4; k++) {
		c.dot(3 + (k % 2) * 3 + (r() < 0.5 ? 0 : 1), 3 + Math.floor(k / 2) * 3, k % 2 ? "apple" : "cabbage", 3);
	}
	if (look === 1) {
		c.box(1, 0, L - 3, D - 3, "woodLight", 7);
		for (let y = 3; y < D - 3; y += 3) c.shadeBox(2, y, L - 5, 1, -1);
		c.box(3, 2, L - 7, D - 7, "woodDark", 6);
	}
}

/** a hand cart: its bed of planks between two rails, a wheel at each side, the handle at its front */
function handcart(c, L, D, look) {
	c.box(1, 0, L - 2, D - 6, "wood", 4);
	for (let y = 3; y < D - 7; y += 3) c.shadeBox(1, y, L - 2, 1, -1);
	c.box(1, 0, 1, D - 6, "woodDark", 5);
	c.box(L - 2, 0, 1, D - 6, "woodDark", 5);
	c.box(0, 6, 1, 5, "rubber", 3);
	c.box(L - 1, 6, 1, 5, "rubber", 3);
	c.box(2, D - 6, 1, 5, "steelDark", 4);
	c.box(L - 3, D - 6, 1, 5, "steelDark", 4);
	c.box(2, D - 2, L - 4, 1, "steelDark", 4);
	if (look === 1) {
		c.box(3, 3, 5, 5, "woodLight", 7);
		c.box(4, 4, 3, 3, "woodDark", 6);
	}
}

/**
 * The food truck from above: its white box with the roof's seams, the vent and the fridge unit on it, the serving
 * hatch's striped awning propped out along its right side (scalloped), and at the front the cab -- lower, its roof,
 * the windscreen sloping down to the hood, the mirrors, the headlamps
 */
function foodtruck(c, L, D) {
	const cab = 13;
	const body = D - cab;
	c.box(0, 0, L, body, "truck", 8);
	for (let y = 7; y < body - 2; y += 8) c.shadeBox(1, y, L - 6, 1, -1);
	// the roof vent (its grille) and the fridge unit's fan
	c.box(4, 4, 6, 6, "steel", 9);
	for (let y = 5; y < 9; y += 2) c.box(5, y, 4, 1, "steelDark", 9);
	c.box(4, body - 12, 7, 6, "steel", 9);
	c.disc(7.5, body - 9, 4, "steelDark", 9);
	// the serving hatch along the right side, and its awning propped out over it: stripes across it, its free edge
	// scalloped, the fold where it hinges lit
	c.box(L - 8, 9, 1, body - 12, "iron", 8);
	for (let y = 10; y < body - 4; y++) {
		const band = Math.floor((y - 10) / 3) % 2 === 0 ? "stripeR" : "canvasBack";
		for (let x = L - 7; x < L; x++) {
			if (x === L - 1 && (y - 10) % 3 === 2) continue;
			c.dot(x, y, band, 10, x === L - 7 ? 1 : x >= L - 2 ? -1 : 0);
		}
	}
	// the cab: its roof, the windscreen, the hood, the mirrors and the headlamps
	c.box(1, body, L - 2, 5, "truck", 6);
	c.box(2, body + 5, L - 4, 3, "glassDark", 5);
	c.shadeBox(2, body + 5, 3, 1, 2);
	c.box(1, body + 8, L - 2, cab - 9, "truck", 4);
	c.shadeBox(1, D - 1, L - 2, 1, -1);
	c.dot(0, body + 5, "iron", 6);
	c.dot(L - 1, body + 5, "iron", 6);
	c.box(2, D - 1, 3, 1, "brass", 4);
	c.box(L - 5, D - 1, 3, 1, "brass", 4);
}

/** what shows through a hole in a tent: the dark under the canvas */
const TENT_HOLE = "under";

/**
 * A stall's striped tent over its pair of tables (aerial: no baked shadow; its shadow on the sun's side is drawn
 * apart). A ridge tent seen from above: the ridge runs along the tables (the middle of the canvas, L long), a slope
 * falls to each aisle, and the stripes run from the ridge down both slopes to the scalloped valance along each eave.
 * The slope away from the light a tone darker (`face` says which: light from the top left), the ridge cap lit, the
 * cloth pulled into creases at each corner pole and sagging a little between them. `look` = stripe colour + 3 x
 * state: standing; torn (a rent in one slope, the dark under the tent showing through, the torn flap folded back
 * over the canvas beside it); sagging (the belly between the poles deep in shade, the ridge sunk with it, old rain
 * lying in it); or down (`tentDown`).
 */
function tent(c, L, D, look, r, K, face) {
	const stripe = ["stripeR", "stripeB", "stripeG"][look % 3];
	const state = Math.floor(look / 3);
	if (state === 3) {
		tentDown(c, L, D, stripe, r);
		return;
	}
	const top = shadeTop(face);
	const mid = Math.floor(D / 2);
	// an odd count of bands, a stripe at each end
	let n = Math.max(5, Math.round(L / 5));
	if (n % 2 === 0) n += 1;
	const band = x => Math.min(n - 1, Math.floor((x * n) / L));
	const from = k => Math.ceil((k * L) / n);
	for (let y = 0; y < D; y++) {
		for (let x = 0; x < L; x++) {
			const k = band(x);
			// the valance's scallops: the two end texels of every band left out along both eaves
			if ((y === 0 || y === D - 1) && (x === from(k) || x === from(k + 1) - 1)) continue;
			const away = top ? y < mid : y > mid;
			c.dot(x, y, k % 2 === 0 ? stripe : "canvas", 4, away ? -1 : 0);
		}
	}
	// the valance's hem along each eave, and the ridge cap (the row under it on the far slope in its shadow)
	c.shadeBox(0, 1, L, 1, -1);
	c.shadeBox(0, D - 2, L, 1, -1);
	const sag = state === 2;
	for (let x = 1; x < L - 1; x++) {
		const dip = sag && Math.abs(x - (L - 1) / 2) < L * 0.3;
		c.shadeAt(x, mid, dip ? 0 : 1);
		c.shadeAt(x, top ? mid - 1 : mid + 1, -1);
	}
	// the cloth hangs slack between the corner poles: a crescent of shade along each eave, deepest mid-span and none
	// at the poles (a sagging tent's reaches halfway up its slope, its core a tone darker still)
	const slope = mid - 3;
	for (const [hem, dir] of [
		[2, 1],
		[D - 3, -1],
	]) {
		for (let x = 1; x < L - 1; x++) {
			const s = Math.sin((Math.PI * (x + 0.5)) / L);
			const deep = Math.round(s * (sag ? slope * 0.55 : 2.4));
			for (let k = 0; k < deep; k++) c.shadeAt(x, hem + dir * k, sag && k < deep * 0.5 ? -2 : -1);
		}
	}
	// the creases the corner poles pull into the cloth: a fold in shade, lit on its side towards the light
	const len = Math.max(4, Math.round(Math.min(L, D) / 7));
	for (const [px, py, dx, dy] of [
		[1, 1, 1, 1],
		[L - 2, 1, -1, 1],
		[1, D - 2, 1, -1],
		[L - 2, D - 2, -1, -1],
	]) {
		for (let k = 1; k <= len; k++) {
			const x = px + dx * (k + 1);
			const y = py + dy * k;
			c.shadeAt(x, y, -1);
			c.shadeAt(x - 1, y - (dy > 0 ? 0 : 1), 1);
		}
	}
	// the poles' tops at the corners
	for (const [x, y] of [
		[1, 1],
		[L - 2, 1],
		[1, D - 2],
		[L - 2, D - 2],
	]) {
		c.dot(x, y, "steelDark", 5);
	}
	if (state === 1) {
		// the rent: a triangle torn down from a seam of one slope (the tent's hash picks which), the dark under the
		// tent showing through it, its long edge ragged
		const h = Math.max(8, Math.round(slope * 0.42));
		const onTop = r() < 0.5;
		const y0 = onTop ? 3 + Math.floor(r() * 2) : mid + 3 + Math.floor(r() * 2);
		const x0 = from(2 + 2 * Math.floor(r() * Math.max(1, (n - 5) / 2)));
		for (let k = 0; k < h; k++) {
			const w = 1 + Math.round(k * 0.62) + (k > 1 && r() < 0.3 ? 1 : 0);
			for (let x = x0; x < x0 + w; x++) c.dot(x, y0 + k, TENT_HOLE, 1);
		}
		// the flap, still hanging by the rent's lower edge and folded down over the canvas under it: the cloth's
		// plain underside (the stripes only a shade through it), off the canvas (it casts a shadow on it)
		for (let k = 0; k < h; k++) {
			const w = Math.max(1, Math.round((h - k) * 0.62));
			for (let x = x0; x < x0 + w; x++) c.dot(x, y0 + h + k, "canvasBack", 6, band(x) % 2 === 0 ? -1 : 0);
		}
	} else if (sag) {
		// the old rain in the lowest part of the canvas: a small dull puddle, a glint of sky in it
		const cx = (L - 1) / 2;
		const cy = top ? D - 3 - Math.round(slope * 0.2) : 2 + Math.round(slope * 0.2);
		c.ellipse(cx, cy, Math.max(2, L * 0.11), Math.max(1.5, D * 0.05), "rain", 3);
		c.dot(Math.round(cx - L * 0.05), Math.round(cy - 1), "rain", 3, 2);
	}
}

/**
 * A tent that came down on its tables: the sheet slumped over the tables and the crates between them (lumps where it
 * lies on them, in the light; hollows between them, in shade), its edge a soft wobble inside the frame (the tables'
 * corners show round it), the stripes bent by the folds, long creases, and a pole that fell with it sticking out.
 */
function tentDown(c, L, D, stripe, r) {
	const p1 = r() * 6.28;
	const p2 = r() * 6.28;
	const p3 = r() * 6.28;
	const ends = y => (y < 4 ? 4 - y : y > D - 5 ? y - (D - 5) : 0);
	for (let y = 1; y < D - 1; y++) {
		const x0 = 2 + Math.round(1.2 + 1.2 * Math.sin(y * 0.33 + p1)) + ends(y);
		const x1 = L - 3 - Math.round(1.2 + 1.2 * Math.sin(y * 0.27 + p2)) - ends(y);
		const warp = 2 * Math.sin(y * 0.2 + p3);
		for (let x = x0; x <= x1; x++) {
			const onStripe = Math.floor((x + warp + 60) / 5) % 2 === 0;
			c.dot(x, y, onStripe ? stripe : "canvas", 3);
		}
	}
	// what it lies on: the two tables along the eaves, the crates between them (the canvas rises over each)
	const T = Math.round(D * 0.23);
	const lift = (x, y, w, h, dz) => {
		for (let yy = y; yy < y + h; yy++) {
			for (let xx = x; xx < x + w; xx++) {
				const i = c.i(xx, yy);
				if (i >= 0 && c.mat[i] !== null) c.z[i] += dz;
			}
		}
	};
	lift(3, 2, L - 6, T, 2);
	lift(3, D - 2 - T, L - 6, T, 2);
	const cw = Math.round(L * 0.3);
	lift(Math.round((L - cw) / 2), 2 + T + 1, cw, D - 2 * T - 6, 3);
	// the creases: long folds, each a line in shade with a lit edge above it
	for (let k = 0; k < 6; k++) {
		let x = 3 + Math.floor(r() * (L - 8));
		let y = 3 + Math.floor(r() * (D - 8));
		const dx = r() < 0.5 ? 1 : -1;
		const n = 5 + Math.floor(r() * 7);
		for (let s = 0; s < n; s++) {
			c.shadeAt(x, y, -1);
			c.shadeAt(x, y - 1, 1);
			x += dx;
			y += r() < 0.4 ? 1 : 0;
		}
	}
	// the pole that fell with it, poking out of the heap at one end
	let x = 0;
	let y = D - 7;
	for (let s = 0; s < Math.round(L * 0.6); s++) {
		c.dot(x, y, "steelDark", 7);
		x += 1;
		if (s % 3 === 2) y -= 1;
	}
}

// ---------------------------------------------------------------- the street (MOB-04)

/** a park bench: the backrest at its back, two slats of seat, the cast-iron ends */
function bench(c, L, D) {
	c.box(0, 0, L, 2, "woodDark", 5);
	c.box(0, 2, L, 2, "wood", 3);
	c.box(0, 4, L, D - 4, "wood", 3);
	c.shadeBox(0, 3, L, 1, -1);
	for (const x of [1, L - 2]) c.box(x, 0, 1, D, "steelDark", 4);
}

/** the foot of a street lamp's pole (the lamp itself is `lamphead`, high over the curb) */
function lampfoot(c, L, D) {
	c.disc((L - 1) / 2, (D - 1) / 2, Math.min(L, D), "iron", 6);
	c.dot(1, 1, "lamp", 7);
}

/** a street lamp's arm and its dark head out over the street (the power is out: LUZ-02) */
function lamphead(c, L, D) {
	c.box(1, 0, 1, D - 4, "steelDark", 6);
	c.box(0, D - 4, L, 4, "lamp", 7);
	c.dot(1, D - 2, "glassDark", 8);
}

/** a fire hydrant from above: the red body, its nozzles either side, the brass bonnet */
function hydrant(c, L, D) {
	c.disc(2, 2, 5, "hydrant", 5);
	c.dot(0, 2, "hydrant", 4);
	c.dot(4, 2, "hydrant", 4);
	c.box(1, 1, 3, 3, "hydrant", 6);
	c.dot(2, 2, "brass", 7);
}

/** a mailbox on its post: the rounded grey box, the red flag up on its side */
function mailbox(c, L, D) {
	c.round(0, 0, L, D, "mailGrey", 6);
	c.shadeBox(0, D - 1, L, 1, -1);
	c.box(L - 1, 1, 1, 2, "flag", 7);
}

/** the blue collection box: its rounded top lit, the slot at the front */
function postbox(c, L, D) {
	c.round(0, 0, L, D, "postBlue", 6);
	c.box(1, 1, L - 2, 2, "postBlue", 7, 1);
	c.box(1, D - 3, L - 2, 1, "iron", 7);
}

/** a bus stop's pole */
function stoppole(c, L, D) {
	c.disc((L - 1) / 2, (D - 1) / 2, Math.min(L, D), "iron", 6);
}

/** the bus stop's sign, upright over its pole: the front of a bus, white on blue (ART-07: a picture, no text) */
function stopsign(c, L, D) {
	c.box(0, 0, L, D, "signBlue", 8);
	c.box(1, 1, L - 2, D - 3, "white", 9);
	c.box(2, 2, L - 4, 1, "glassDark", 10);
	c.dot(1, D - 2, "iron", 9);
	c.dot(L - 2, D - 2, "iron", 9);
}

/** a bus shelter's roof: smoked glass on its steel frame (aerial, see-through: drawn with its own alpha) */
function shelter(c, L, D) {
	c.box(0, 0, L, D, "glassSmoke", 6);
	for (let x = 0; x < L; x += Math.floor(L / 4)) c.box(x, 0, 1, D, "steel", 7);
	c.box(0, 0, L, 1, "steel", 7);
	c.box(0, D - 1, L, 1, "steel", 7);
	c.box(L - 1, 0, 1, D, "steel", 7);
	for (let k = 0; k < 4; k++) c.shadeAt(3 + k, 2 + k, 1);
}

// ---------------------------------------------------------------- the parks (MOB-05)

/** a swing set: the A-frames' feet at its ends, the top bar across, the seats hanging from it on their chains */
function swings(c, L, D) {
	const mid = Math.floor(D / 2);
	for (const x of [0, L - 2]) c.box(x, 0, 2, D, "playRed", 5);
	c.box(0, mid - 1, L, 2, "playRed", 7);
	for (const f of [0.3, 0.7]) {
		const x = Math.round(L * f) - 2;
		c.box(x, mid + 1, 4, 2, "rubber", 3);
		c.dot(x, mid + 1, "steelDark", 4);
		c.dot(x + 3, mid + 1, "steelDark", 4);
	}
}

/** a slide: the platform and its ladder at the back, the yellow chute down to the front between its rails */
function slide(c, L, D) {
	c.box(1, 0, L - 2, 8, "playBlue", 7);
	for (let y = 1; y < 8; y += 2) c.shadeBox(1, y, L - 2, 1, -1);
	c.box(2, 8, L - 4, D - 8, "playYellow", 5);
	c.box(2, 8, 1, D - 8, "playYellow", 6, 1);
	c.box(L - 3, 8, 1, D - 8, "playYellow", 6, -1);
}

/** a climbing frame: the yellow bars in a grid (the sand shows between them), the blue frame and corner posts */
function climber(c, L, D) {
	// the sand between the bars, in the frame's shade (painted: the bars keep their colour, the outline runs round
	// the whole frame instead of every bar)
	c.box(0, 0, L, D, "gapShade", 1);
	for (let k = 0; k < L; k += 5) {
		c.box(k, 0, 1, D, "playYellow", 6);
		c.box(0, k, L, 1, "playYellow", 6);
	}
	c.box(0, 0, L, 1, "playBlue", 7);
	c.box(0, D - 1, L, 1, "playBlue", 7);
	c.box(0, 0, 1, D, "playBlue", 7);
	c.box(L - 1, 0, 1, D, "playBlue", 7);
	for (const [x, y] of [
		[0, 0],
		[L - 2, 0],
		[0, D - 2],
		[L - 2, D - 2],
	]) {
		c.box(x, y, 2, 2, "playBlue", 8);
	}
}

/** a spring rider: the animal's body in yellow or red on its round base plate, its handle */
function springer(c, L, D, look) {
	const m = look % 2 === 0 ? "playYellow" : "playRed";
	c.ellipse(3, 3, 3, 3, "steelDark", 2);
	c.box(1, 2, 5, 3, m, 5);
	c.box(4, 1, 2, 2, m, 6);
	c.dot(4, 3, "steel", 7);
}

/** a basketball hoop: the backboard along the baseline, its square, the rim over the court in front */
function hoop(c, L, D) {
	c.box(0, 0, L, 3, "white", 7);
	c.box(4, 1, 4, 1, "flag", 8);
	c.box(5, 3, 2, 1, "steelDark", 6);
	for (let y = 4; y < D; y++) {
		for (let x = 2; x < L - 2; x++) {
			const d = Math.hypot(x - (L - 1) / 2, y - 6.5);
			if (d > 1.4 && d < 2.9) c.dot(x, y, "playRed", 6);
		}
	}
}

/** a picnic table: its two benches either side of the table top, the legs showing between */
function picnic(c, L, D) {
	for (const x of [3, L - 4]) c.box(x, 0, 1, D, "woodDark", 2);
	c.box(0, 0, L, 4, "wood", 3);
	c.box(0, D - 4, L, 4, "wood", 3);
	c.box(1, 6, L - 2, D - 12, "wood", 4);
	for (let y = 7; y < D - 6; y += 2) c.shadeBox(1, y, L - 2, 1, -1);
	c.shadeBox(0, 2, L, 1, -1);
	c.shadeBox(0, D - 2, L, 1, -1);
}

// ---------------------------------------------------------------- the backyards (MOB-06)

/** a garden shed's gable roof: the slope away from the light darker, shingle courses, the ridge */
function shed(c, L, D, look, r, K, face) {
	const top = shadeTop(face);
	const mid = Math.floor(D / 2);
	for (let y = 0; y < D; y++) c.box(0, y, L, 1, "shedRoof", 5, (top ? y < mid : y >= mid) ? -1 : 0);
	for (let y = 2; y < D; y += 3) if (y !== mid) c.shadeBox(0, y, L, 1, -1);
	c.box(0, mid, L, 1, "shedRoof", 6, 1);
}

/** a backyard pool: the coping round it, the water in it (the coping's shadow on its near edge), the deep end
 * darker, a ladder, ripples */
function pool(c, L, D, look, r) {
	c.box(0, 0, L, D, "coping", 3);
	c.box(2, 2, L - 4, D - 4, "water", 1);
	c.shadeBox(L - 12, 2, 10, D - 4, -1);
	// ripples: short lit dashes, and the light caught along the far side of the coping
	for (let k = 0; k < Math.round((L * D) / 90); k++) {
		const x = 4 + Math.floor(r() * (L - 12));
		const y = 4 + Math.floor(r() * (D - 8));
		c.shadeBox(x, y, 2 + Math.floor(r() * 2), 1, 1);
	}
	c.shadeBox(2, 2, L - 4, 1, -1);
	c.shadeBox(2, 2, 1, D - 4, -1);
	c.box(3, 2, 1, 3, "steel", 4);
	c.box(5, 2, 1, 3, "steel", 4);
}

/** a trampoline: the blue pad round it, the black mat, the springs on the pad */
function trampoline(c, L, D) {
	const m = (L - 1) / 2;
	c.ellipse(m, m, m, m, "padBlue", 4);
	c.ellipse(m, m, m - 2.5, m - 2.5, "mat", 3);
	for (let k = 0; k < 12; k++) {
		const a = (k / 12) * Math.PI * 2;
		c.dot(m + Math.cos(a) * (m - 1.2), m + Math.sin(a) * (m - 1.2), "steel", 5);
	}
	c.shadeAt(m - 3, m - 3, 1);
}

/** a kettle grill: its black lid lit on the top left, the handle */
function grill(c, L, D) {
	const m = (L - 1) / 2;
	c.ellipse(m, m, m, m, "grill", 5);
	c.box(2, 3, L - 4, 1, "steel", 7);
	c.dot(2, 2, "grill", 6, 2);
}

// ---------------------------------------------------------------- the building site (EDI-21)

/** a pile of what the house is built of (look): lumber, bricks on a pallet, steel bars */
function pile(c, L, D, look) {
	if (look === 1) {
		c.box(0, 0, L, D, "woodDark", 2);
		c.box(1, 1, L - 2, D - 2, "brick", 5);
		for (let y = 2; y < D - 1; y += 2) {
			c.shadeBox(1, y, L - 2, 1, -1);
			for (let x = 1 + (y % 4 === 0 ? 2 : 0); x < L - 1; x += 4) c.shadeAt(x, y - 1, -1);
		}
		return;
	}
	const m = look === 2 ? "steelBar" : "woodLight";
	for (let y = 0; y < D; y++) {
		const z = y < D / 2 ? 6 : 4;
		c.box(y % 3 === 0 ? 1 : 0, y, L - (y % 2), 1, m, z, y % 3 === 2 ? -1 : 0);
	}
}

function portapotty(c, L, D) {
	c.box(0, 0, L, D, "toilet", 8);
	c.box(1, 1, L - 2, D - 2, "toilet", 9, 1);
	c.disc((L - 1) / 2, (D - 1) / 2, 3, "white", 10);
	c.shadeBox(2, D - 2, L - 4, 1, -1);
}

function mixer(c, L, D) {
	c.box(1, 1, L - 2, D - 2, "iron", 3);
	c.ellipse((L - 1) / 2, D / 2 - 1, L / 2 - 2, D / 2 - 2.5, "mixer", 7);
	c.disc((L - 1) / 2, 4, 3, "iron", 8);
}

function dumpster(c, L, D) {
	c.box(0, 0, L, D, "dumpster", 6);
	c.box(1, 1, L / 2 - 1, D - 2, "dumpster", 7, 1);
	c.box(L / 2, 1, 1, D - 2, "iron", 7);
	c.shadeBox(L / 2 + 1, 1, L / 2 - 2, D - 2, -1);
}

function scaffold(c, L, D) {
	c.box(0, 2, L, D - 4, "wood", 5);
	for (let x = 12; x < L; x += 12) c.shadeBox(x, 2, 1, D - 4, -1);
	c.box(0, 0, L, 1, "galv", 7);
	c.box(0, D - 1, L, 1, "galv", 7);
	for (let x = 0; x < L; x += 16) c.box(x, 0, 1, D, "galv", 8);
}

/** a stone column of the bank's portico, from above: its round capital, lit (EDI-23) */
function column(c, L, D) {
	const m = (L - 1) / 2;
	c.ellipse(m, m, m, m, "stone", 8);
	c.ellipse(m - 0.8, m - 0.8, m - 2, m - 2, "stone", 9, 1);
}

/** a strip of chain-link fence: posts every ten texels, the mesh between (see through: every other texel) */
function fence(c, L, D) {
	for (let x = 0; x < L; x++) c.dot(x, x % 2 === 0 ? 0 : D - 1, "galv", 4, x % 4 < 2 ? 0 : -1);
	for (let x = 0; x < L; x += 10) c.box(x, 0, 2, D, "iron", 6);
}

/** the top plate of a timber frame's wall (a stud's head every four texels) */
function studs(c, L, D) {
	c.box(0, 0, L, 1, "woodLight", 4, 1);
	c.box(0, D - 1, L, 1, "woodLight", 4, -1);
	for (let x = 0; x < L; x += 4) c.box(x, 0, 1, D, "wood", 4, -1);
}

// ---------------------------------------------------------------- ground (flat: no outline, no shadow)

function court(c, L, D, look, r) {
	c.box(0, 0, L, D, "court", 1);
	for (let k = 0; k < (L * D) / 12; k++) c.shadeAt(Math.floor(r() * L), Math.floor(r() * D), r() < 0.5 ? -1 : 1);
	const along = L >= D;
	const len = along ? L : D;
	const wide = along ? D : L;
	const put = (a, b, w, h, m) => (along ? c.box(a, b, w, h, m, 2) : c.box(b, a, h, w, m, 2));
	// the keys under the hoops, then the lines: the boundary, the half line, the centre circle
	for (const end of [2, len - 2 - 28]) put(end, Math.round(wide / 2 - 12), 28, 24, "courtKey");
	put(2, 2, len - 4, 1, "courtLine");
	put(2, wide - 3, len - 4, 1, "courtLine");
	put(2, 2, 1, wide - 4, "courtLine");
	put(len - 3, 2, 1, wide - 4, "courtLine");
	put(Math.floor(len / 2), 2, 1, wide - 4, "courtLine");
	for (const end of [2, len - 2 - 28]) {
		put(end, Math.round(wide / 2 - 12), 28, 1, "courtLine");
		put(end, Math.round(wide / 2 + 11), 28, 1, "courtLine");
		put(end === 2 ? 29 : len - 30, Math.round(wide / 2 - 12), 1, 24, "courtLine");
	}
	const cx = along ? L / 2 : D / 2;
	for (let a = 0; a < 64; a++) {
		const t = (a / 64) * Math.PI * 2;
		const x = Math.round(cx + Math.cos(t) * 9);
		const y = Math.round(wide / 2 + Math.sin(t) * 9);
		put(x, y, 1, 1, "courtLine");
	}
}

function sandbox(c, L, D, look, r) {
	c.box(0, 0, L, D, "woodDark", 2);
	c.box(1, 1, L - 2, D - 2, "sand", 1);
	for (let k = 0; k < (L * D) / 6; k++)
		c.shadeAt(1 + Math.floor(r() * (L - 2)), 1 + Math.floor(r() * (D - 2)), r() < 0.6 ? -1 : 1);
}

function garden(c, L, D, look, r) {
	c.box(0, 0, L, D, "woodDark", 2);
	c.box(1, 1, L - 2, D - 2, "soil", 1);
	const along = L >= D;
	for (let k = 2; k < (along ? D : L) - 1; k += 3) {
		for (let j = 2; j < (along ? L : D) - 2; j += 2) {
			if (r() < 0.15) continue;
			if (along) c.dot(j, k, "sprout", 3);
			else c.dot(k, j, "sprout", 3);
		}
	}
}

function steps(c, L, D) {
	c.box(0, 0, L, D, "stone", 1);
	const along = L >= D;
	const deep = along ? D : L;
	for (let t = 6; t < deep; t += 6) {
		if (along) {
			c.shadeBox(0, t - 1, L, 1, 1);
			c.shadeBox(0, t, L, 1, -2);
		} else {
			c.shadeBox(t - 1, 0, 1, D, 1);
			c.shadeBox(t, 0, 1, D, -2);
		}
	}
}

function site(c, L, D, look, r) {
	c.box(0, 0, L, D, "earth", 1);
	for (let k = 0; k < (L * D) / 8; k++) c.shadeAt(Math.floor(r() * L), Math.floor(r() * D), r() < 0.6 ? -1 : 1);
	const along = L >= D;
	for (const f of [0.35, 0.62]) {
		const k = Math.round((along ? D : L) * f);
		if (along) c.shadeBox(4, k, L - 8, 2, -1);
		else c.shadeBox(k, 4, 2, D - 8, -1);
	}
}

function pad(c, L, D, look, r) {
	c.box(0, 0, L, D, "slab", 1);
	for (let k = 0; k < (L * D) / 10; k++) c.shadeAt(Math.floor(r() * L), Math.floor(r() * D), r() < 0.5 ? -1 : 1);
	for (let x = 20; x < L; x += 20) c.shadeBox(x, 0, 1, D, -1);
	for (let y = 20; y < D; y += 20) c.shadeBox(0, y, L, 1, -1);
}

/** a spill of produce: three pieces, small and dark (LEG-03) */
function spill(c, L, D, look, r) {
	const SPILT = ["spillApple", "spillCabbage", "spillOrange"];
	const along = L >= D;
	const len = along ? L : D;
	const wide = along ? D : L;
	// three pieces on a crowd's spill, one every five texels in front of a table knocked over
	const n = len < 20 ? 3 : Math.round(len / 5);
	for (let i = 0; i < n; i++) {
		const m = SPILT[(i + look) % 3];
		const a =
			n === 3 ? Math.round((len - 1) * [0.22, 0.5, 0.78][i]) : Math.round((i + 0.5) * (len / n) + r() * 2 - 1);
		const b = n === 3 ? Math.round((wide - 1) * [0.3, 0.7, 0.35][i]) : 1 + Math.floor(r() * (wide - 3));
		const k = m === "spillCabbage" ? 3 : 2;
		if (along) c.box(a - 1, b - 1, k, k, m, 1);
		else c.box(b - 1, a - 1, k, k, m, 1);
	}
}

function paper(c, L, D, look) {
	c.box(1, 1, 4, 3, "litter", 1);
	c.box(L - 5, D - 4, 4, 3, "litter", 1, look === 1 ? -1 : 0);
	c.shadeBox(1, 3, 4, 1, -1);
}

function bag(c, L, D, look) {
	const along = L >= D;
	if (along) {
		c.box(0, 1, L - 3, D - 3, "kraft", 1);
		c.box(L - 4, 1, 1, D - 3, "kraft", 1, -1);
		c.box(L - 2, D - 2, 2, 2, ["spillApple", "spillOrange", "spillCabbage"][look % 3], 1);
	} else {
		c.box(1, 0, L - 3, D - 3, "kraft", 1);
		c.box(1, D - 4, L - 3, 1, "kraft", 1, -1);
		c.box(L - 2, D - 2, 2, 2, ["spillApple", "spillOrange", "spillCabbage"][look % 3], 1);
	}
}

// ---------------------------------------------------------------- the table of fixtures

/**
 * Every fixture: its tag, its canonical size in world units (along its front x deep: townLots.ts's constants), the
 * faces it can have ("-": it has none, drawn as painted), its looks, its drawer, its baked shadow, and where it hangs
 * past its rect (`ext`: texels in front). `sizes` lists more than one size for a tag laid out at several.
 */
const TENT_ALONG = [8, 16, 24, 40].map(o => 128 + 2 * o);
const TENT_ACROSS = [16, 24].map(o => 176 + 2 * o);
const PROPS = [
	{ tag: "stall", sizes: [[128, 44]], faces: FACES, looks: 3, draw: stall },
	{ tag: "trestle", sizes: [[128, 44]], faces: FACES, looks: 3, draw: trestle },
	{ tag: "crates", sizes: [[44, 44]], faces: ["-"], looks: 3, draw: crates },
	{ tag: "handcart", sizes: [[44, 88]], faces: FACES, looks: 2, draw: handcart },
	{ tag: "foodtruck", sizes: [[100, 220]], faces: FACES, looks: 1, draw: foodtruck },
	{
		tag: "tent",
		sizes: TENT_ALONG.flatMap(a => TENT_ACROSS.map(b => [a, b])),
		faces: ["top", "left"],
		looks: 9,
		draw: tent,
		shadow: 0,
		aerial: true,
	},
	{ tag: "tent", sizes: [[144, 192]], faces: ["top", "left"], looks: 12, first: 9, draw: tent, shadow: 1 },
	{ tag: "bench", sizes: [[64, 24]], faces: FACES, looks: 1, draw: bench },
	{ tag: "streetlight", sizes: [[16, 16]], faces: ["-"], looks: 1, draw: lampfoot },
	{ tag: "hydrant", sizes: [[20, 20]], faces: ["-"], looks: 1, draw: hydrant },
	{ tag: "mailbox", sizes: [[16, 16]], faces: FACES, looks: 1, draw: mailbox },
	{ tag: "postbox", sizes: [[28, 28]], faces: FACES, looks: 1, draw: postbox },
	{ tag: "busstop", sizes: [[12, 12]], faces: ["-"], looks: 1, draw: stoppole },
	{ tag: "shelter", sizes: [[176, 72]], faces: FACES, looks: 1, draw: shelter, shadow: 0, aerial: true },
	{ tag: "swings", sizes: [[144, 40]], faces: ["bottom"], looks: 1, draw: swings },
	{ tag: "swings", sizes: [[128, 40]], faces: FACES, looks: 1, draw: swings },
	{ tag: "slide", sizes: [[40, 112]], faces: ["-"], looks: 1, draw: slide },
	{ tag: "climber", sizes: [[88, 88]], faces: ["-"], looks: 1, draw: climber },
	{ tag: "springer", sizes: [[28, 28]], faces: ["-"], looks: 2, draw: springer },
	{ tag: "hoop", sizes: [[48, 16]], faces: FACES, looks: 1, draw: hoop, ext: 6 },
	{ tag: "picnic", sizes: [[96, 72]], faces: ["-"], looks: 1, draw: picnic },
	{ tag: "shed", sizes: [[96, 72]], faces: FACES, looks: 1, draw: shed },
	{ tag: "pool", sizes: [[176, 96]], faces: FACES, looks: 1, draw: pool, shadow: 0 },
	{ tag: "trampoline", sizes: [[88, 88]], faces: ["-"], looks: 1, draw: trampoline },
	{ tag: "grill", sizes: [[32, 32]], faces: ["-"], looks: 1, draw: grill },
	{ tag: "pile", sizes: [[112, 56]], faces: FACES, looks: 1, draw: pile },
	{ tag: "pile", sizes: [[72, 56]], faces: FACES, looks: 2, first: 1, draw: pile },
	{ tag: "pile", sizes: [[96, 40]], faces: FACES, looks: 3, first: 2, draw: pile },
	{ tag: "portapotty", sizes: [[48, 48]], faces: FACES, looks: 1, draw: portapotty },
	{ tag: "mixer", sizes: [[56, 56]], faces: FACES, looks: 1, draw: mixer },
	{ tag: "dumpster", sizes: [[128, 64]], faces: FACES, looks: 1, draw: dumpster },
	{ tag: "scaffold", sizes: [[280, 40]], faces: FACES, looks: 1, draw: scaffold },
	{ tag: "column", sizes: [[40, 40]], faces: ["-"], looks: 1, draw: column },
];

/** what lies flat on the ground (townLots.ts ground kinds): both orientations of each size, no outline, no shadow */
const GROUND = [
	{ tag: "court", sizes: [[352, 320]], looks: 1, draw: court },
	{ tag: "sandbox", sizes: [[320, 256]], looks: 1, draw: sandbox },
	{ tag: "garden", sizes: [[128, 64]], looks: 1, draw: garden },
	{ tag: "steps", sizes: [[808, 96]], looks: 1, draw: steps },
	{ tag: "site", sizes: [[544, 624]], looks: 1, draw: site },
	{ tag: "pad", sizes: [[360, 320]], looks: 1, draw: pad },
	{
		tag: "spill",
		sizes: [
			[56, 40],
			[96, 40],
		],
		looks: 3,
		draw: spill,
	},
	{ tag: "paper", sizes: [[40, 32]], looks: 3, draw: paper },
	{ tag: "bag", sizes: [[36, 28]], looks: 3, draw: bag },
];

/** the long thin things, one cell along x and one along y, cropped to the length (world units: the longest) */
const STRIPS = [
	{ tag: "fence", len: 640, thick: 8, draw: fence, outline: false },
	{ tag: "studs", len: 360, thick: 8, draw: studs, outline: false },
];

/** a street lamp's head and a bus stop's sign: drawn at a point (client/view/townPropArt.ts `drawPropAt`) */
const POINTS = [
	{ key: "lamphead", L: 12, D: 36, faces: FACES, draw: lamphead },
	{ key: "stopsign", L: 28, D: 28, faces: ["-"], draw: stopsign },
];

// ---------------------------------------------------------------- the atlas

/**
 * The whole atlas: `{ atlas: { w, h, toCanvas }, cells, looks, faceless, strips, report }`. `C` is the palette of
 * shared/engine/colors.ts ([r, g, b] by name).
 */
export function townPropArt({ C }) {
	const MAT = propMaterials(C);
	const entries = [];
	const offsets = {};
	const looks = {};
	const faceless = {};
	const strips = {};
	const report = { cells: 0 };
	const paint = (key, Lw, Dw, draw, look, face, shadow, opts = {}) => {
		const Lt = Math.max(1, Math.round(Lw / U));
		const Dt = Math.max(1, Math.round(Dw / U)) + (opts.ext ?? 0);
		const cv = new Canvas(Lt, Dt);
		draw(cv, Lt, Dt, look, rng(hashStr(`${key}:${look}`)), undefined, face);
		const world = face === "-" ? cv : orient(cv, face);
		const img = shade(world, MAT, { shadow, outline: opts.outline !== false });
		entries.push({ key, img, shadow });
		// where the rect starts inside the cell: the part hanging past its front moves with the face
		const ext = opts.ext ?? 0;
		offsets[key] = [face === "left" ? ext : 0, face === "top" ? ext : 0];
	};
	for (const p of PROPS) {
		looks[p.tag] = Math.max(looks[p.tag] ?? 0, p.looks);
		if (p.faces[0] === "-") faceless[p.tag] = true;
		const shadow = p.shadow ?? 1;
		for (const [Lw, Dw] of p.sizes) {
			for (const face of p.faces) {
				const across = face === "left" || face === "right";
				const w = across ? Dw : Lw;
				const h = across ? Lw : Dw;
				for (let look = p.first ?? 0; look < p.looks; look++) {
					paint(`${p.tag}:${w}x${h}:${face}:${look}`, Lw, Dw, p.draw, look, face, shadow, { ext: p.ext });
				}
			}
		}
	}
	for (const g of GROUND) {
		looks[g.tag] = g.looks;
		faceless[g.tag] = true;
		for (const [a, b] of g.sizes) {
			for (const [w, h] of [
				[a, b],
				[b, a],
			]) {
				for (let look = 0; look < g.looks; look++) {
					paint(`${g.tag}:${w}x${h}:-:${look}`, w, h, g.draw, look, "-", 0, { outline: false });
				}
			}
		}
	}
	for (const s of STRIPS) {
		strips[s.tag] = true;
		const outline = s.outline !== false;
		paint(`${s.tag}:h`, s.len, s.thick, s.draw, 0, "-", 0, { outline });
		const cv = new Canvas(Math.round(s.len / U), Math.round(s.thick / U));
		s.draw(cv, cv.L, cv.D, 0, rng(hashStr(s.tag)));
		entries.push({ key: `${s.tag}:v`, img: shade(cv.transposed(), MAT, { shadow: 0, outline }), shadow: 0 });
		offsets[`${s.tag}:v`] = [0, 0];
	}
	for (const p of POINTS) {
		for (const face of p.faces) paint(`${p.key}:${face}`, p.L, p.D, p.draw, 0, face, 1);
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
		faceless,
		strips,
		report,
	};
}

/** src/client/view/townPropAtlas.ts: the cells, the looks, which tags have no face, which are strips */
export function townPropAtlasModule(art, name) {
	const L = [];
	L.push("// generated by tools/gen-world-art.mjs (tools/town-prop-art.mjs) — do not edit");
	L.push(
		`// the town's fixtures' atlas: design/world-art/${name}.png; its asset id is WORLD_ART.${name} in worldArtAssets.ts (upload-art)`,
	);
	L.push("");
	L.push("/** the atlas's size in texels (one texel = 4 world units) */");
	L.push(`export const TOWN_PROP_ATLAS_W = ${art.atlas.w};`);
	L.push(`export const TOWN_PROP_ATLAS_H = ${art.atlas.h};`);
	L.push("");
	L.push("/** how many looks each fixture has (`Solid.variant` modulo this) */");
	L.push("export const TOWN_PROP_LOOKS: Record<string, number> = {");
	for (const [k, n] of Object.entries(art.looks).sort()) L.push(`\t${k}: ${n},`);
	L.push("};");
	L.push("");
	L.push('/** the fixtures and grounds drawn as painted, whatever their face (their key\'s face is "-") */');
	L.push("export const TOWN_PROP_FACELESS: Record<string, boolean> = {");
	for (const k of Object.keys(art.faceless).sort()) L.push(`\t${k}: true,`);
	L.push("};");
	L.push("");
	L.push(
		'/** the long thin fixtures: one cell along x ("<tag>:h") and one along y ("<tag>:v"), cropped to the length */',
	);
	L.push("export const TOWN_PROP_STRIPS: Record<string, boolean> = {");
	for (const k of Object.keys(art.strips).sort()) L.push(`\t${k}: true,`);
	L.push("};");
	L.push("");
	L.push("/**");
	L.push(
		" * Every cell: [x, y, w, h, ox, oy, shadow] in texels -- its rect in the atlas (baked shadow included), where the",
	);
	L.push(
		' * fixture\'s rect starts inside it and its baked shadow (right and bottom). Keys: "<tag>:<w>x<h>:<face or ->:<look>"',
	);
	L.push(" * (w, h the rect in world units),");
	L.push(' * "<strip>:h" / "<strip>:v", "lamphead:<face>", "stopsign:-".');
	L.push(" */");
	L.push(
		"export const TOWN_PROP_CELLS: Record<string, readonly [number, number, number, number, number, number, number]> = {",
	);
	for (const [k, c] of Object.entries(art.cells)) L.push(`\t"${k}": [${c.join(", ")}],`);
	L.push("};");
	L.push("");
	return L.join("\n");
}

/**
 * docs/art/town-props-sheet.png: one cell per fixture and look (its "bottom" or faceless cell, the largest size),
 * the strips and the points, magnified 3x on grass and sidewalk, labelled.
 */
export function townPropSheet(art, drawText) {
	const Z = 3;
	const canvas = art.atlas.toCanvas();
	const best = {};
	const rest = [];
	for (const k of Object.keys(art.cells)) {
		const [tag, size, face, look] = k.split(":");
		if (size === undefined || !size.includes("x")) {
			rest.push(k);
			continue;
		}
		if (face !== "bottom" && face !== "-" && !(tag === "tent" && face === "top")) continue;
		const [w, h] = size.split("x").map(Number);
		const id = `${tag}:${look}`;
		if (best[id] === undefined || w * h > best[id].area) best[id] = { k, area: w * h };
	}
	const pick = [
		...Object.values(best)
			.map(b => b.k)
			.sort((a, b) => art.cells[b][3] - art.cells[a][3] || a.localeCompare(b)),
		...rest.filter(k => !k.endsWith(":v")),
	];
	const W = 1800;
	const places = [];
	let x = 8;
	let y = 8;
	let rowH = 0;
	for (const k of pick) {
		const c = art.cells[k];
		const w = Math.max(c[2] * Z, 90);
		const h = c[3] * Z + 16;
		if (x + w + 10 > W) {
			x = 8;
			y += rowH + 10;
			rowH = 0;
		}
		places.push({ k, c, x, y, w });
		x += w + 10;
		rowH = Math.max(rowH, h);
	}
	const H = y + rowH + 8;
	const img = { w: W, h: H, data: Buffer.alloc(W * H * 4) };
	const grounds = [
		[92, 128, 70],
		[168, 166, 158],
	];
	for (let i = 0; i < W * H; i++) {
		const f = grounds[(Math.floor((i % W) / (Z * 16)) + Math.floor(Math.floor(i / W) / (Z * 16))) % 2];
		img.data[i * 4] = f[0];
		img.data[i * 4 + 1] = f[1];
		img.data[i * 4 + 2] = f[2];
		img.data[i * 4 + 3] = 255;
	}
	for (const p of places) {
		const [cx, cy, cw, ch] = p.c;
		for (let yy = 0; yy < ch * Z; yy++) {
			for (let xx = 0; xx < cw * Z; xx++) {
				const si = ((cy + Math.floor(yy / Z)) * canvas.w + cx + Math.floor(xx / Z)) * 4;
				const a = canvas.data[si + 3] / 255;
				const di = ((p.y + 16 + yy) * W + p.x + xx) * 4;
				for (let k = 0; k < 3; k++)
					img.data[di + k] = Math.round(canvas.data[si + k] * a + img.data[di + k] * (1 - a));
			}
		}
		drawText(img, p.k.replace(":bottom", "").slice(0, Math.floor(p.w / 6)), p.x, p.y + 3, 1, [250, 250, 250]);
	}
	return img;
}
