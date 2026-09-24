/*
 * Project Z interiors: the pixel art of every piece of furniture, of the floor decoration and of the doorways and
 * windows (docs/DESIGN_RULES.md ART-12, EDI-08..EDI-12), baked into ONE atlas (design/world-art/furniture.png) that
 * client/view/interiorArt.ts draws a cell of per piece (ImageRectOffset / ImageRectSize, Pixelated). Written by
 * tools/gen-world-art.mjs with the rest of the town (`npm run art:world`) and uploaded with it (`upload-art`); until
 * the atlas has an id -- or while the uploaded one is not this PNG (its sha1, like the item icons') -- every piece
 * is drawn by the flat Frames of client/view/interiorView.ts, exactly as before (ART-01).
 *
 *   import { furnitureArt } from "./furniture-art.mjs";
 *   const art = furnitureArt({ Tex, C, ROOT });   // { atlas, cells, templates, looks, artKinds, report }
 *
 * THE STYLE is the town's (ART-02): 4 world units per texel, a dark outline round every silhouette, three to five
 * tones per material, light from the top left, and a short shadow baked to the bottom right (one texel for a low
 * piece, two for a tall one: a wardrobe stands taller than a bed), like the town's props (`withShadow`). A few days
 * after the outbreak (§1, APO-01): gaps on the shelves, a box knocked over, papers on a desk, a blanket thrown back,
 * a cracked display case, dried blood only where it makes sense (a hospital bed, a stretcher).
 *
 * HOW A PIECE IS PAINTED. A drawer paints a MATERIAL and a HEIGHT per texel in a canonical frame -- L texels along
 * the piece's front, D in depth, its back (the wall) at the top and its front (the room) at the bottom -- and that
 * map is turned to the piece's facing in the world (`Solid.face`) BEFORE it is shaded: the light never turns with the
 * furniture. Shading is one rule for everything: a texel next to the outside is outline; the top and left edges of a
 * raised part catch the light, its bottom and right edges are in shade, and a part two steps lower than its top-left
 * neighbour lies in that neighbour's shadow; the drawer's own tones (seams, folds, a highlight) add on top.
 *
 * WHICH CELLS. The sizes are the planner's own: every `(ctx, "<kind>", len, depth` call in shared/game/interiors.ts
 * (againstWall, island, grid) is one piece size, in each of the four facings. A kind whose length the planner
 * computes (`aisles(ctx, "<kind>", depth)`: the gondolas) gets a long TEMPLATE instead; so does every other kind
 * (its largest cell): a piece of a size the atlas does not hold is drawn as two or four crops of it, the corners of
 * the template -- the ends, the outline, the shadow -- where they belong (client/view/interiorArt.ts). A new kind
 * (a new room type) drops in: its sizes are read the same way, and until it has a drawer of its own it is painted
 * by the generic one (a wooden cabinet) and listed in the report. A piece of the same kind can look different by
 * the room's building (`ART_KIND_BY_TYPE`: a pharmacy's shelves hold medicine, a clothes shop's folded clothes) and
 * by `Solid.variant` (`looks`: the colour of a sofa, which end the sink is at).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** world units per texel */
const U = 4;
/** transparent texels after every cell (right and below): no neighbour ever bleeds into a crop */
export const GUTTER = 2;
/** the largest image Roblox keeps at full size */
export const MAX_SIDE = 1024;
/** a computed-length kind (aisles) is templated this long (world units): the planner's longest row is 420 */
const TEMPLATE_LEN = 432;
/** an interior opening (an open-plan side) is templated this long: the longest seen is ~320 */
const OPENING_LEN = 448;
const FACES = ["top", "bottom", "left", "right"];

// ---------------------------------------------------------------- colour helpers

const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];
const INK = [22, 18, 20];

function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function hashStr(s) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
}

// ---------------------------------------------------------------- materials

/**
 * Every material's ramp from its base colour (the palette of shared/engine/colors.ts): outline, two shades, the base,
 * two lights. `soft` materials (cloth, paper) keep a gentler ramp; `shine` ones (glass, porcelain, steel) a sharper
 * highlight.
 */
function ramp(base, { shine = false, soft = false, outline } = {}) {
	return {
		o: outline ?? mix(base, INK, 0.74),
		dd: mix(base, BLACK, soft ? 0.3 : 0.38),
		d: mix(base, BLACK, soft ? 0.14 : 0.2),
		m: base,
		l: mix(base, WHITE, soft ? 0.12 : 0.16),
		h: mix(base, WHITE, shine ? 0.5 : soft ? 0.24 : 0.32),
	};
}

function materials(C) {
	const m = {};
	const add = (name, base, opts) => (m[name] = ramp(base, opts));
	add("wood", C.furnWood);
	add("woodDark", C.furnDark);
	add("woodLight", mix(C.furnWood, [214, 184, 136], 0.55));
	add("laminate", mix(C.counterTop, [206, 176, 128], 0.45));
	add("fabric", C.fabric, { soft: true });
	add("fabricRed", C.fabricRed, { soft: true });
	add("fabricGreen", [84, 112, 82], { soft: true });
	add("fabricBrown", [122, 94, 72], { soft: true });
	add("fabricMustard", [178, 144, 72], { soft: true });
	add("bedding", C.bedding, { soft: true });
	add("pillow", mix(C.bedding, WHITE, 0.45), { soft: true });
	add("sheet", mix(C.curtain, WHITE, 0.45), { soft: true });
	add("porcelain", C.porcelain, { shine: true });
	add("steel", C.metal, { shine: true });
	add("steelDark", C.metalDark, { shine: true });
	add("counter", C.counterTop);
	add("glass", C.glassCold, { shine: true });
	add("glassDark", mix(C.glassCold, C.metalDark, 0.45), { shine: true });
	// what is left of a window pane: glass the floor shows through (drawn at `alpha`)
	m.pane = { ...ramp(mix(C.glassCold, WHITE, 0.25), { shine: true }), alpha: 130 };
	add("fabricGrey", [118, 118, 126], { soft: true });
	add("screen", [36, 40, 50], { shine: true });
	add("paper", C.paper, { soft: true });
	add("chalk", C.chalkboard);
	add("curtain", C.curtain, { soft: true });
	add("cardboard", [168, 128, 84]);
	add("cardboardDark", [138, 100, 64]);
	add("rubber", [48, 48, 54]);
	add("vinyl", [156, 56, 50]);
	add("vinylTeal", [86, 128, 132], { soft: true });
	add("plastic", [70, 108, 158]);
	add("locker", [92, 120, 142]);
	add("lockerGreen", [92, 128, 108]);
	add("felt", [112, 40, 42], { soft: true });
	add("trim", mix(C.windowFrame, C.furnWood, 0.12));
	add("leaf", [74, 126, 64]);
	add("pot", [152, 86, 60]);
	add("shade", [226, 208, 168], { soft: true });
	add("goodsA", C.goodsA);
	add("goodsB", C.goodsB);
	add("goodsC", C.goodsC);
	add("goodsD", [98, 150, 88]);
	add("goodsE", [222, 220, 210]);
	add("goodsF", [130, 94, 146]);
	add("amber", [172, 112, 52], { shine: true });
	add("rugRed", C.rug, { soft: true });
	add("rugBlue", [60, 74, 114], { soft: true });
	add("rugCream", [192, 176, 142], { soft: true });
	add("matBlue", mix(C.glassCold, C.porcelain, 0.4), { soft: true });
	add("food", [196, 150, 96]);
	// the campus (EDI-17): a lab bench's black epoxy top, a notice board's cork
	add("epoxy", mix(C.metalDark, BLACK, 0.3), { shine: true });
	add("cork", mix(C.furnWood, C.goodsC, 0.35));
	return m;
}

/** dried blood (LEG-02: red is blood) and the chalk, the loose ink colours drawn over a material */
function inks(C) {
	return {
		blood: mix(C.blood, BLACK, 0.4),
		bloodDark: mix(C.blood, BLACK, 0.58),
		chalk: [214, 220, 210],
		led: [58, 64, 60],
		shard: mix(C.glassCold, WHITE, 0.55),
		text: mix(C.paper, BLACK, 0.4),
		coin: [196, 170, 84],
		red: C.goodsA,
		green: [96, 150, 88],
		/** a chemical spill: the acid green of the game's acid (LEG-02: green is not blood) */
		acid: mix(C.acid, BLACK, 0.3),
	};
}

// ---------------------------------------------------------------- the canvas: material + height per texel

class Canvas {
	constructor(L, D) {
		this.L = L;
		this.D = D;
		const n = L * D;
		this.mat = new Array(n).fill(null);
		this.z = new Array(n).fill(0);
		this.tone = new Array(n).fill(0);
		this.ink = new Array(n).fill(null);
	}
	i(x, y) {
		x = Math.round(x);
		y = Math.round(y);
		return x >= 0 && y >= 0 && x < this.L && y < this.D ? y * this.L + x : -1;
	}
	has(x, y) {
		const i = this.i(x, y);
		return i >= 0 && this.mat[i] !== null;
	}
	dot(x, y, mat, z, tone = 0) {
		const i = this.i(x, y);
		if (i < 0) return;
		this.mat[i] = mat;
		this.z[i] = z;
		this.tone[i] = tone;
		this.ink[i] = null;
	}
	box(x, y, w, h, mat, z, tone = 0) {
		for (let yy = Math.round(y); yy < Math.round(y) + Math.round(h); yy++) {
			for (let xx = Math.round(x); xx < Math.round(x) + Math.round(w); xx++) this.dot(xx, yy, mat, z, tone);
		}
	}
	/** a box with its corner texels left out (what was under them stays): the rounded end of a cushion, a tub */
	round(x, y, w, h, mat, z, tone = 0) {
		x = Math.round(x);
		y = Math.round(y);
		for (let yy = y; yy < y + h; yy++) {
			for (let xx = x; xx < x + w; xx++) {
				const corner = w > 2 && h > 2 && (xx === x || xx === x + w - 1) && (yy === y || yy === y + h - 1);
				if (!corner) this.dot(xx, yy, mat, z, tone);
			}
		}
	}
	/** a small round thing seen from above (a plate, a mug, a pot): a square with its corners a shade darker */
	disc(x, y, n, mat, z) {
		x = Math.round(x - (n - 1) / 2);
		y = Math.round(y - (n - 1) / 2);
		this.box(x, y, n, n, mat, z);
		if (n >= 3) {
			for (const [cx, cy] of [
				[x, y],
				[x + n - 1, y],
				[x, y + n - 1],
				[x + n - 1, y + n - 1],
			]) {
				this.shadeAt(cx, cy, -1);
			}
		}
	}
	/** an irregular blotch (a stain, a spill): `n` texels grown from (x, y) with the stream `r`, in ink `c` */
	blotch(x, y, n, c, r) {
		const pts = [[Math.round(x), Math.round(y)]];
		this.inkAt(pts[0][0], pts[0][1], c);
		for (let k = 1; k < n; k++) {
			const [px, py] = pts[Math.floor(r() * pts.length)];
			const d = Math.floor(r() * 4);
			const nx = px + (d === 0 ? 1 : d === 1 ? -1 : 0);
			const ny = py + (d === 2 ? 1 : d === 3 ? -1 : 0);
			if (!this.has(nx, ny)) continue;
			this.inkAt(nx, ny, c);
			pts.push([nx, ny]);
		}
	}
	ellipse(cx, cy, rx, ry, mat, z, tone = 0) {
		for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
			for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
				const dx = (x - cx) / (rx + 0.35);
				const dy = (y - cy) / (ry + 0.35);
				if (dx * dx + dy * dy <= 1) this.dot(x, y, mat, z, tone);
			}
		}
	}
	/** adds `t` to the tone of the texels already painted in the box */
	shadeBox(x, y, w, h, t) {
		for (let yy = Math.round(y); yy < Math.round(y) + Math.round(h); yy++) {
			for (let xx = Math.round(x); xx < Math.round(x) + Math.round(w); xx++) {
				const i = this.i(xx, yy);
				if (i >= 0 && this.mat[i] !== null) this.tone[i] += t;
			}
		}
	}
	shadeAt(x, y, t) {
		this.shadeBox(x, y, 1, 1, t);
	}
	/** an exact colour on a texel already painted (a printed label, a stain): drawn as is, never shaded */
	inkAt(x, y, c) {
		const i = this.i(x, y);
		if (i >= 0 && this.mat[i] !== null) this.ink[i] = c;
	}
	inkBox(x, y, w, h, c) {
		for (let yy = Math.round(y); yy < Math.round(y) + Math.round(h); yy++) {
			for (let xx = Math.round(x); xx < Math.round(x) + Math.round(w); xx++) this.inkAt(xx, yy, c);
		}
	}
	clear(x, y) {
		const i = this.i(x, y);
		if (i < 0) return;
		this.mat[i] = null;
		this.ink[i] = null;
		this.tone[i] = 0;
		this.z[i] = 0;
	}
	/** the same picture with x and y swapped (a drawer that paints its long axis along x, stood on end) */
	transposed() {
		const out = new Canvas(this.D, this.L);
		for (let y = 0; y < this.D; y++) {
			for (let x = 0; x < this.L; x++) {
				const a = y * this.L + x;
				const b = x * out.L + y;
				out.mat[b] = this.mat[a];
				out.z[b] = this.z[a];
				out.tone[b] = this.tone[a];
				out.ink[b] = this.ink[a];
			}
		}
		return out;
	}
}

/** the canonical canvas (front at the bottom) turned to face `face` in the world */
function orient(cv, face) {
	const { L, D } = cv;
	const across = face === "left" || face === "right";
	const out = new Canvas(across ? D : L, across ? L : D);
	for (let y = 0; y < D; y++) {
		for (let x = 0; x < L; x++) {
			let X;
			let Y;
			if (face === "bottom") {
				X = x;
				Y = y;
			} else if (face === "top") {
				X = L - 1 - x;
				Y = D - 1 - y;
			} else if (face === "left") {
				X = D - 1 - y;
				Y = x;
			} else {
				X = y;
				Y = L - 1 - x;
			}
			const a = y * L + x;
			const b = Y * out.L + X;
			out.mat[b] = cv.mat[a];
			out.z[b] = cv.z[a];
			out.tone[b] = cv.tone[a];
			out.ink[b] = cv.ink[a];
		}
	}
	return out;
}

/**
 * The world-facing map shaded into RGBA (see the header), with `shadow` texels of baked shadow to the bottom right
 * and `outline` off for flat decoration that sits in the floor (a rug's own border is its outline).
 */
function shade(cv, MAT, { shadow = 1, outline = true } = {}) {
	const W = cv.L;
	const H = cv.D;
	const out = { w: W + shadow, h: H + shadow, d: new Float32Array((W + shadow) * (H + shadow) * 4) };
	const put = (x, y, c, a) => {
		const i = (y * out.w + x) * 4;
		out.d[i] = c[0];
		out.d[i + 1] = c[1];
		out.d[i + 2] = c[2];
		out.d[i + 3] = a;
	};
	const zAt = (x, y) => {
		if (x < 0 || y < 0 || x >= W || y >= H) return -99;
		const i = y * W + x;
		return cv.mat[i] === null ? -99 : cv.z[i];
	};
	// the baked shadow first, under everything, where nothing of the piece is
	for (let k = shadow; k >= 1; k--) {
		const a = k === 1 ? 84 : 44;
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				if (cv.mat[y * W + x] === null) continue;
				const X = x + k;
				const Y = y + k;
				if (X < W && Y < H && cv.mat[Y * W + X] !== null) continue;
				put(X, Y, BLACK, a);
			}
		}
	}
	const empty = (x, y) => zAt(x, y) === -99;
	const rim = (x, y) => !empty(x, y) && (empty(x - 1, y) || empty(x + 1, y) || empty(x, y - 1) || empty(x, y + 1));
	// the silhouette's edge, as the texel next to it sees it: the outline ring, or (no outline) the outside itself
	const edge = outline ? rim : empty;
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			const m = cv.mat[i];
			if (m === null) continue;
			const R = MAT[m];
			if (R === undefined) throw new Error(`furniture art: no material "${m}"`);
			const z = cv.z[i];
			const zu = zAt(x, y - 1);
			const zl = zAt(x - 1, y);
			const zd = zAt(x, y + 1);
			const zr = zAt(x + 1, y);
			let c;
			if (outline && (zu === -99 || zl === -99 || zd === -99 || zr === -99)) c = R.o;
			else {
				let lv = 0;
				if ((zu !== -99 && zu < z) || (zl !== -99 && zl < z)) lv = 1;
				else if ((zd !== -99 && zd < z) || (zr !== -99 && zr < z)) lv = -1;
				if (zu >= z + 2 || zl >= z + 2) lv = -1;
				// the bevel inside the silhouette, in the world's frame (after the piece was turned): lit along its top
				// and left edge, in shade along its bottom and right one -- the light never turns with the furniture
				if (edge(x, y - 1) || edge(x - 1, y)) lv += 1;
				else if (edge(x, y + 1) || edge(x + 1, y)) lv -= 1;
				lv = Math.max(-2, Math.min(2, lv + cv.tone[i]));
				c = lv === -2 ? R.dd : lv === -1 ? R.d : lv === 1 ? R.l : lv === 2 ? R.h : R.m;
			}
			if (cv.ink[i] !== null) c = cv.ink[i];
			put(x, y, c, cv.ink[i] !== null ? 255 : (R.alpha ?? 255));
		}
	}
	return out;
}

// ---------------------------------------------------------------- the drawers (canonical: front at the bottom)

/**
 * Each drawer paints a piece L x D texels in the canonical frame: `c` its Canvas, `look` which of its `looks`,
 * `r` a random stream seeded by the piece (kind, size, look -- never the facing: turned, it is the same piece), `K`
 * the ink colours. A drawer that is long along its depth (a bed whose head is on the wall) handles it itself.
 */

/** a pot plant's leaves over (x, y): a few leaves round a lit middle */
function plant(c, x, y, z) {
	x = Math.round(x);
	y = Math.round(y);
	for (const [dx, dy] of [
		[0, 0],
		[-1, 0],
		[1, 0],
		[0, -1],
		[0, 1],
		[-1, -1],
		[1, 1],
	]) {
		c.dot(x + dx, y + dy, "leaf", z, dx + dy < 0 ? 1 : dx + dy > 0 ? -1 : 0);
	}
	c.dot(x + 1, y - 1, "leaf", z + 1, 1);
}

/** a hob's burner: a dark ring round its cap */
function burner(c, x, y) {
	c.disc(x, y, 3, "steelDark", 2);
	c.inkAt(Math.round(x), Math.round(y), [110, 112, 120]);
}

/**
 * A sofa (an armchair is a short one): the back rest along the wall and the arms standing higher than the seat --
 * the seat lies in their shadow along the back and the left arm (light from the top left) -- the seat cushions each
 * lit along their top and parted by a seam, a throw pillow against an arm; a cushion a little out of place.
 */
function sofa(c, L, D, look, r) {
	const cloth = ["fabric", "fabricGreen", "fabricGrey"][look % 3];
	const back = Math.max(3, Math.round(D * 0.3));
	const arm = L >= 20 ? 3 : 2;
	c.box(0, 0, L, D, cloth, 2);
	// the back rest and the arms: two steps above the seat
	c.box(0, 0, L, back, cloth, 5);
	c.round(0, 0, arm, D, cloth, 5);
	c.round(L - arm, 0, arm, D, cloth, 5);
	// the seat cushions: seams between them, each cushion's front edge rounded down
	const inner = L - 2 * arm;
	const n = inner >= 24 ? 3 : inner >= 12 ? 2 : 1;
	for (let k = 0; k < n; k++) {
		const x0 = arm + Math.round((inner * k) / n);
		const x1 = arm + Math.round((inner * (k + 1)) / n);
		c.box(x0 + (k > 0 ? 1 : 0), back, x1 - x0 - (k > 0 ? 1 : 0), D - back - 1, cloth, 3);
	}
	// a throw pillow in a colour of its own against one arm
	if (inner >= 8) {
		const px = r() < 0.5 ? arm : L - arm - 4;
		const pillow = look === 1 ? "fabricMustard" : look === 2 ? "fabricRed" : "bedding";
		c.round(px, back - 1, 4, 4, pillow, 6);
	}
	// a few days: a cushion knocked askew, pushed half off the seat
	if (inner >= 12 && r() < 0.5) c.shadeBox(arm + 1 + Math.floor(r() * (inner - 4)), D - 3, 3, 1, -1);
}

function booth(c, L, D, look, r, K) {
	const back = 3;
	const seat = Math.max(back + 3, Math.round(D * 0.48));
	c.box(0, 0, L, seat, "vinyl", 2);
	c.box(0, 0, L, back, "vinyl", 3);
	// tufted back: a seam every 4 texels
	for (let x = 3; x < L - 1; x += 4) c.shadeBox(x, 0, 1, back, -1);
	c.shadeBox(0, seat - 1, L, 1, -1);
	// the table in front of the bench, laminate edged in steel
	const tx = 2;
	c.box(tx, seat, L - 2 * tx, D - seat, "steel", 2);
	c.box(tx + 1, seat, L - 2 * tx - 2, D - seat - 1, "laminate", 2);
	// what was on it: two plates, a napkin holder, the ketchup
	const mid = Math.floor(L / 2);
	c.disc(tx + 5, seat + 3, 3, "porcelain", 3);
	c.disc(L - tx - 6, seat + 3, 3, "porcelain", 3);
	c.inkAt(tx + 5, seat + 3, K.red);
	c.box(mid - 1, seat + 1, 2, 1, "steel", 3);
	c.dot(mid + 2, seat + 1, "goodsA", 3);
	if (look === 1) c.inkBox(L - tx - 5, seat + 4, 2, 1, K.bloodDark);
	if (r() < 0.5) c.dot(tx + 8, seat + 4, "goodsE", 3);
}

function tv(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "woodDark", 2);
	const tw = Math.round(L * 0.66);
	const x0 = Math.floor((L - tw) / 2);
	if (look === 2) {
		// knocked over, lying on its face across the stand
		c.box(x0 - 1, 1, tw + 2, D - 2, "screen", 3);
		c.inkBox(x0 + 3, 2, 1, D - 4, mix(K.shard, BLACK, 0.3));
	} else {
		// the flat screen seen from above: its top edge catching the light, the bezel, the foot
		c.box(x0, 1, tw, 3, "screen", 4);
		c.shadeBox(x0 + 1, 3, tw - 2, 1, -1);
		c.box(x0 + Math.floor(tw / 2) - 2, 4, 4, 1, "steelDark", 3);
	}
	// a console and the remote on the shelf, a plant at one end
	c.box(2, D - 3, 5, 2, "steelDark", 3);
	c.inkAt(6, D - 2, K.led);
	c.dot(L - 5, D - 2, "rubber", 3);
	if (look === 1) {
		c.disc(L - 3, 3, 3, "pot", 3);
		plant(c, L - 3, 2, 5);
	}
}

function bookcase(c, L, D, look, r) {
	c.box(0, 0, L, D, "wood", 5);
	c.box(1, 1, L - 2, D - 2, "woodDark", 3);
	const colours = ["goodsA", "goodsB", "goodsC", "goodsD", "fabricRed", "fabric", "goodsE"];
	let x = 1;
	while (x < L - 1) {
		const w = r() < 0.7 ? 1 : 2;
		if (r() < 0.14) {
			x += w + 1;
			continue;
		}
		const mat = colours[Math.floor(r() * colours.length)];
		const depth = D - 3 + (r() < 0.4 ? 1 : 0);
		c.box(x, D - 1 - depth, Math.min(w, L - 1 - x), depth, mat, 4);
		if (w === 2) c.shadeBox(x + 1, D - 1 - depth, 1, depth, -1);
		x += w;
	}
	// a book lying flat, and at one end a box or a plant
	if (L >= 12) c.box(Math.floor(L / 2) - 2, 2, 4, 2, colours[look % colours.length], 5);
	if (look === 1 && L >= 10) {
		c.box(L - 5, 1, 4, D - 2, "woodDark", 3);
		c.disc(L - 3, Math.floor(D / 2), 3, "pot", 4);
		plant(c, L - 3, Math.floor(D / 2) - 1, 5);
	}
}

function counter(c, L, D, look, r, K, steel = false) {
	const top = steel ? "steel" : "counter";
	c.box(0, 0, L, D, top, 2);
	// the backsplash along the wall, the worn front edge
	c.box(0, 0, L, 1, steel ? "steelDark" : "porcelain", 3);
	c.shadeBox(0, D - 2, L, 1, 1);
	if (steel) for (let y = 2; y < D - 2; y += 2) c.shadeBox(1, y, L - 2, 1, -1);
	const leftSink = look % 2 === 0;
	if (L >= 16) {
		const sw = steel ? 10 : 7;
		const sd = Math.min(5, D - 3);
		const sx = leftSink ? Math.round(L * 0.18) : L - Math.round(L * 0.18) - sw;
		c.box(sx, 2, sw, sd, "steel", 2);
		c.box(sx + 1, 3, sw - 2, sd - 2, "steelDark", 1);
		if (steel) c.box(sx + Math.floor(sw / 2), 3, 1, sd - 2, "steel", 2);
		c.dot(sx + Math.floor(sw / 2), 1, "steel", 4);
		c.dot(sx + Math.floor(sw / 2), 2, "steel", 3);
		// a dirty dish left in it
		if (r() < 0.6) c.box(sx + 2, 4, 2, 2, "porcelain", 2);
	}
	// what was being cooked: a board with a knife, a pot, a mug; a spill
	const other = leftSink ? L - Math.round(L * 0.34) : Math.round(L * 0.16);
	if (L >= 24) {
		c.box(other, 3, 5, 4, steel ? "woodLight" : "woodLight", 3);
		c.box(other + 1, 4, 3, 1, "steel", 4);
		c.disc(other + (leftSink ? -4 : 8), 4, 3, "steelDark", 3);
	}
	if (L >= 12 && r() < 0.7) c.dot(leftSink ? L - 3 : 2, D - 3, "porcelain", 3);
	if (r() < 0.5)
		c.inkBox(
			Math.floor(r() * (L - 4)) + 1,
			D - 3,
			2,
			1,
			mix(steel ? [120, 124, 130] : [150, 144, 130], BLACK, 0.12),
		);
}

function stove(c, L, D, look, r, K) {
	const big = L >= 20;
	const body = big ? "steel" : "porcelain";
	c.box(0, 0, L, D, body, 2);
	if (!big) {
		// the back panel with its knobs
		c.box(0, 0, L, 2, "steelDark", 3);
		for (let x = 2; x < L - 1; x += 3) c.inkAt(x, 1, [150, 152, 158]);
		// two big burners and two small ones, as on a real hob
		const burners = [
			[3, 4],
			[L - 4, Math.min(D - 3, 7)],
			[3, Math.min(D - 3, 7)],
			[L - 4, 4],
		];
		burner(c, burners[0][0], burners[0][1]);
		burner(c, burners[1][0], burners[1][1]);
		c.box(burners[2][0] - 1, burners[2][1] - 1, 2, 2, "steelDark", 2);
		c.box(burners[3][0], burners[3][1] - 1, 2, 2, "steelDark", 2);
		if (look === 1) {
			// a pot left on the hob, its lid on
			c.disc(burners[1][0], burners[1][1], 4, "steel", 4);
			c.dot(Math.round(burners[1][0]), Math.round(burners[1][1]), "steelDark", 5);
		}
		if (look === 2) {
			c.disc(burners[2][0], burners[2][1], 3, "steelDark", 4);
			c.box(Math.round(burners[2][0]) + 2, Math.round(burners[2][1]), 3, 1, "rubber", 4);
		}
		return;
	}
	// a restaurant range: six burners, a griddle, the knobs along the front
	const gx = Math.round(L * 0.66);
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 2; j++) {
			const bx = 2.5 + i * ((gx - 3) / 3);
			const by = 3 + j * ((D - 6) / 1.3);
			burner(c, bx + 1, by);
		}
	}
	c.box(gx, 1, L - gx - 1, D - 4, "steelDark", 2);
	for (let y = 2; y < D - 4; y += 2) c.shadeBox(gx + 1, y, L - gx - 3, 1, 1);
	c.box(0, D - 2, L, 2, "steel", 3);
	for (let x = 2; x < L - 1; x += 3) c.inkAt(x, D - 2, [48, 50, 56]);
	c.disc(4, 3, 4, "steel", 4);
	c.box(7, 3, 3, 1, "rubber", 4);
	if (r() < 0.5) c.inkBox(gx + 2, 3, 3, 2, [92, 70, 44]);
}

function fridge(c, L, D, look, r, K, steel = false) {
	const body = steel || L >= 15 ? "steel" : "porcelain";
	c.box(0, 0, L, D, body, 5);
	// the door's top edge along the front, and its handle
	c.shadeBox(1, D - 3, L - 2, 1, -1);
	if (body === "steel") c.shadeBox(Math.floor(L / 2), 1, 1, D - 3, -1);
	// a vent grille at the back of a steel one
	if (body === "steel") for (let x = 2; x < L - 2; x += 2) c.shadeAt(x, 2, -2);
	// what people keep on a fridge
	if (look === 1) {
		c.box(2, 2, 4, 3, "goodsA", 6);
		c.inkBox(3, 3, 2, 1, [236, 214, 120]);
	} else if (look === 2) {
		c.disc(L - 4, 3, 3, "woodLight", 6);
		c.dot(L - 4, 3, "goodsD", 7);
	}
}

function table(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "wood", 2);
	const alongX = L >= D;
	// the planks, and a little grain
	if (alongX) {
		for (let y = 3; y < D - 1; y += 4) c.shadeBox(1, y, L - 2, 1, -1);
	} else {
		for (let x = 3; x < L - 1; x += 4) c.shadeBox(x, 1, 1, D - 2, -1);
	}
	for (let k = 0; k < (L * D) / 30; k++)
		c.shadeAt(1 + Math.floor(r() * (L - 2)), 1 + Math.floor(r() * (D - 2)), r() < 0.5 ? 1 : -1);
	// the table as it was left: plates at the places, a vase, a knocked-over glass
	const places = alongX
		? [
				[L * 0.3, 2.5],
				[L * 0.7, 2.5],
				[L * 0.3, D - 3.5],
				[L * 0.7, D - 3.5],
			]
		: [
				[2.5, D * 0.3],
				[2.5, D * 0.7],
				[L - 3.5, D * 0.3],
				[L - 3.5, D * 0.7],
			];
	const n = L * D > 300 ? 4 : 2;
	for (let k = 0; k < n; k++) {
		if (r() < 0.2) continue;
		const [px, py] = places[k];
		c.disc(px, py, 3, "porcelain", 3);
		if (r() < 0.4) c.inkAt(Math.round(px), Math.round(py), K.red);
	}
	if (look !== 2 && L >= 10 && D >= 10) {
		c.disc(L / 2 - 0.5, D / 2 - 0.5, 2, "glass", 3);
		c.dot(L / 2 - 0.5, D / 2 - 1.5, "leaf", 4);
		c.dot(L / 2 + 0.5, D / 2 - 1.5, look === 1 ? "goodsC" : "goodsA", 4);
	}
	if (look === 2) {
		// papers spread out, a glass on its side and what it spilled
		c.box(Math.round(L * 0.4), Math.round(D * 0.35), 4, 5, "paper", 3);
		c.box(Math.round(L * 0.4) + 3, Math.round(D * 0.35) + 2, 4, 5, "paper", 3);
		c.inkBox(Math.round(L * 0.4) + 1, Math.round(D * 0.35) + 1, 2, 1, K.text);
		c.box(Math.round(L * 0.2), Math.round(D * 0.55), 2, 1, "glass", 3);
		c.inkBox(Math.round(L * 0.2) + 2, Math.round(D * 0.55), 2, 2, mix([128, 90, 58], BLACK, 0.3));
	}
}

function tableDiner(c, L, D, look, r, K) {
	// laminate on a chrome edge, a checked cloth on half of them; the napkins, salt and pepper, what was served
	c.box(0, 0, L, D, "steel", 2);
	c.box(1, 1, L - 2, D - 2, "laminate", 2);
	if (look !== 1) {
		for (let y = 2; y < D - 2; y++) {
			for (let x = 2; x < L - 2; x++) {
				const odd = (Math.floor((x - 2) / 2) + Math.floor((y - 2) / 2)) % 2 === 1;
				c.dot(x, y, odd ? "fabricRed" : "bedding", 2, 0);
			}
		}
	}
	const m = L / 2 - 0.5;
	c.box(Math.round(m) - 1, Math.round(D / 2) - 1, 2, 1, "steel", 4);
	c.dot(Math.round(m) - 1, Math.round(D / 2), "goodsE", 4);
	c.dot(Math.round(m), Math.round(D / 2), "rubber", 4);
	c.disc(4, 4, 3, "porcelain", 3);
	c.inkAt(4, 4, [170, 120, 70]);
	if (r() < 0.7) c.disc(L - 5, D - 5, 3, "porcelain", 3);
	if (look === 2) c.inkBox(L - 6, 4, 3, 2, K.blood);
}

function bed(c, L, D, look, r, K) {
	const cloth = ["fabric", "fabricRed", "fabricGreen"][look % 3];
	// draws a bed whose head is at the top of a w x h box, then stands it the right way
	const paint = (cv, w, h) => {
		cv.box(0, 0, w, h, "bedding", 2);
		cv.box(0, 0, w, 2, "woodDark", 4);
		const n = w >= 22 ? 2 : 1;
		const pw = Math.floor((w - 2 - (n - 1)) / n);
		for (let k = 0; k < n; k++) {
			const px = 1 + k * (pw + 1);
			cv.round(px, 3, pw, 4, "pillow", 3);
			cv.shadeBox(px + 1, 6, pw - 2, 1, -1);
		}
		const yb = 9;
		const thrown = look === 2;
		const bw = thrown ? Math.round(w * 0.62) : w;
		const bx = thrown ? w - bw : 0;
		cv.box(bx, yb, bw, h - yb, cloth, 3);
		// the turned-down edge and its shadow, the creases of a bed slept in
		cv.box(bx, yb, bw, 2, "bedding", 4);
		cv.shadeBox(bx, yb + 2, bw, 1, -1);
		for (let k = 0; k < 4; k++) {
			const x = bx + 1 + Math.floor(r() * (bw - 4));
			const y = yb + 4 + Math.floor(r() * Math.max(1, h - yb - 6));
			cv.shadeAt(x, y, -1);
			cv.shadeAt(x + 1, y + 1, -1);
		}
		if (thrown) cv.shadeBox(bx, yb, 1, h - yb, -1);
	};
	headToWall(c, L, D, look, paint);
}

/**
 * A bed-like piece painted head at the top of a w x h box by `paint(cv, w, h)`: as is when its head is on the wall
 * (deeper than long), else laid along the wall with the head at one end (the look decides which) -- the right-hand
 * side of the painted box is then the side facing the room.
 */
function headToWall(c, L, D, look, paint) {
	if (D >= L * 0.9) {
		paint(c, L, D);
		return;
	}
	const cv = new Canvas(D, L);
	paint(cv, D, L);
	const t = cv.transposed();
	const flip = look % 2 === 1;
	for (let y = 0; y < D; y++) {
		for (let x = 0; x < L; x++) {
			const sx = flip ? L - 1 - x : x;
			const a = y * L + sx;
			const b = y * L + x;
			c.mat[b] = t.mat[a];
			c.z[b] = t.z[a];
			c.tone[b] = t.tone[a];
			c.ink[b] = t.ink[a];
		}
	}
}

// ---------------------------------------------------------------- the campus (EDI-17)

/** tiered lecture seats: the rows rise to the back wall, each a platform and its seats, the backs to the wall */
function seats(c, L, D, look, r, K) {
	const tiers = Math.max(2, Math.floor(D / 8));
	const step = Math.floor(D / tiers);
	const pitch = 5;
	const n = Math.floor((L - 2) / pitch);
	const x0 = Math.floor((L - n * pitch) / 2);
	for (let t = 0; t < tiers; t++) {
		// tier 0 is the front row (the bottom), each one a step higher towards the wall
		const y0 = t === tiers - 1 ? 0 : D - (t + 1) * step;
		const h = t === tiers - 1 ? D - t * step : step;
		const z = 2 + t * 2;
		c.box(0, y0, L, h, "woodDark", z);
		for (let i = 0; i < n; i++) {
			const sx = x0 + i * pitch;
			// a seat folded up (nobody sat since) or down, some knocked about; its back against the step behind
			const folded = r() < 0.35;
			const sy = y0 + 1;
			c.box(sx, sy, 4, 1, "fabric", z + 2, -1);
			if (folded) c.box(sx, sy + 1, 4, 1, "fabric", z + 1);
			else c.round(sx, sy + 1, 4, Math.max(2, h - 3), "fabric", z + 1);
			if (!folded && r() < 0.12) c.box(sx + 1, sy + 2, 2, 2, look === 1 ? "paper" : "fabricBrown", z + 2);
		}
		// the writing tablet's rail along the front of each row
		c.box(0, y0 + h - 1, L, 1, "wood", z + 1);
	}
	if (look === 2) c.blotch(x0 + Math.floor(r() * Math.max(1, L - 8)), D - 3, 7, K.blood, r);
}

/** a lectern: the sloped reading top (lit), the notes left on it, the microphone on its gooseneck */
function lectern(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "wood", 3);
	c.box(1, 1, L - 2, D - 3, "wood", 4);
	c.shadeBox(1, D - 3, L - 2, 1, -1);
	c.box(3, 2, 6, 4, "paper", 5);
	c.box(4, 3, 6, 4, "paper", 5);
	c.inkBox(5, 4, 3, 1, K.text);
	c.inkBox(5, 6, 2, 1, K.text);
	c.box(L - 4, 1, 1, 4, "steelDark", 5);
	c.dot(L - 4, 5, "rubber", 6);
	if (look === 1) c.box(2, D - 4, 4, 2, "steel", 5);
}

/** a lab bench: black epoxy top, the sink and its gooseneck tap, a gas tap, glassware, a notebook (a spill) */
function labbench(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "epoxy", 2);
	c.shadeBox(0, D - 2, L, 1, 1);
	const left = look % 2 === 0;
	const sx = left ? 2 : L - 9;
	c.box(sx, 2, 7, D - 5, "steel", 1);
	c.box(sx + 1, 3, 5, D - 7, "steelDark", 1);
	c.box(sx + 3, 1, 1, 2, "steel", 4);
	c.dot(sx + 3, 3, "steel", 3);
	// the gas taps along the middle, the glassware on the other end
	const gx = left ? sx + 10 : 3;
	for (let k = 0; k < 3; k++) c.dot(gx + k * 4, 2, "goodsC", 3);
	const ox = left ? L - 12 : 12;
	c.disc(ox, D / 2, 3, "glass", 4);
	c.dot(ox, D / 2 - 1, "glass", 5, 1);
	c.box(ox + 3, D / 2 - 1, 2, 2, "glass", 4);
	c.box(ox - 5, 3, 4, 2, "woodLight", 3);
	for (let k = 0; k < 3; k++) c.dot(ox - 5 + k, 2, k === 1 ? "goodsD" : "glass", 4);
	if (L >= 30) {
		c.box(Math.floor(L / 2) - 2, D - 5, 5, 3, "paper", 3);
		c.inkBox(Math.floor(L / 2) - 1, D - 4, 3, 1, K.text);
	}
	if (look === 2) {
		// a beaker knocked over and what it spilled
		c.box(ox - 1, D - 4, 3, 1, "glass", 3);
		c.blotch(ox + 3, D - 4, 8, K.acid, r);
	}
}

/** a fume hood: the steel cabinet, its glass sash along the front with the dark chamber behind, a flask inside */
function fumehood(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "steel", 5);
	// the exhaust duct's collar on top, towards the wall
	c.disc(Math.floor(L / 2), 3, 4, "steelDark", 6);
	c.box(2, 6, L - 4, D - 8, "screen", 4);
	c.box(2, D - 3, L - 4, 2, "glass", 5);
	c.dot(Math.floor(L / 3), D - 5, "glass", 4);
	c.dot(Math.floor(L / 3), D - 6, "goodsD", 4);
	for (let x = 3; x < L - 3; x += 3) c.inkAt(x, 6, [78, 82, 90]);
	if (look === 1) {
		for (let k = 0; k < 4; k++) c.inkAt(3 + Math.floor(r() * (L - 6)), D - 3 + (k % 2), K.shard);
	}
}

/** the reagents' shelf: brown, clear, green and blue bottles with their caps and hazard labels; a spill */
function chemshelf(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "steel", 4);
	c.box(1, 1, L - 2, D - 2, "steelDark", 2);
	for (let x = 12; x < L - 2; x += 12) c.box(x, 0, 1, D, "steel", 4);
	const bottles = ["amber", "amber", "glass", "goodsD", "goodsB", "goodsE"];
	let x = 1;
	while (x < L - 2) {
		if (x % 12 === 0 || r() < 0.18) {
			x++;
			continue;
		}
		const mat = bottles[Math.floor(r() * bottles.length)];
		const y = 2 + Math.floor(r() * Math.max(1, D - 5));
		const w = mat === "goodsE" ? 2 : 1;
		c.box(x, y, w, 2, mat, 3);
		c.dot(x, y, mat === "goodsE" ? "steel" : "rubber", 4);
		if (r() < 0.2) c.inkAt(x, y + 1, r() < 0.5 ? [214, 180, 70] : [196, 84, 60]);
		x += w + (r() < 0.5 ? 1 : 0);
	}
	if (look === 1) {
		// a bottle on its side and what leaked from it
		const bx = 2 + Math.floor(r() * Math.max(1, L - 8));
		c.box(bx, D - 3, 3, 1, "amber", 3);
		c.blotch(bx + 3, D - 3, 6, K.acid, r);
	}
}

/** a bunk bed from above: the top bunk's steel frame and mattress, blanket and pillow, the ladder on the room side */
function bunk(c, L, D, look, r) {
	const cloth = ["fabric", "fabricGreen", "fabricMustard"][look % 3];
	headToWall(c, L, D, look, (cv, w, h) => {
		cv.box(0, 0, w, h, "steelDark", 4);
		cv.box(1, 1, w - 2, h - 2, "bedding", 3);
		cv.round(2, 2, w - 4, 4, "pillow", 4);
		const yb = 7;
		const thrown = look === 1;
		const bw = thrown ? Math.max(3, Math.round((w - 2) * 0.6)) : w - 2;
		cv.box(1, yb, bw, h - yb - 1, cloth, 4);
		cv.box(1, yb, bw, 1, "bedding", 5);
		for (let k = 0; k < 3; k++)
			cv.shadeAt(
				2 + Math.floor(r() * Math.max(1, bw - 3)),
				yb + 3 + Math.floor(r() * Math.max(1, h - yb - 5)),
				-1,
			);
		// the ladder hooked over the rail on the room side (the right of the painted box): two rails, the rungs
		const ly = Math.floor(h * 0.5);
		for (let y = ly; y < Math.min(h - 1, ly + 9); y++) {
			cv.dot(w - 3, y, "steel", 6, y === ly ? 1 : 0);
			cv.dot(w - 1, y, "steel", 6, y === ly ? 1 : 0);
			cv.dot(w - 2, y, y % 2 === 0 ? "steel" : cloth, y % 2 === 0 ? 6 : 4, y % 2 === 0 ? 1 : 0);
		}
		// the corner posts
		for (const [px, py] of [
			[0, 0],
			[w - 1, 0],
			[0, h - 1],
			[w - 1, h - 1],
		]) {
			cv.dot(px, py, "steel", 6);
		}
	});
}

/** a snack machine: the red cabinet, the glass front with its spiral rows of snacks, the coin panel */
function vending(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "vinyl", 5);
	const gw = Math.max(4, L - 5);
	c.box(1, D - 5, gw, 4, "glassDark", 4);
	const snacks = [K.red, [214, 180, 70], [70, 130, 170], [98, 150, 88], [222, 220, 210]];
	const smashed = look === 1;
	for (let x = 2; x < 1 + gw - 1; x++) {
		for (let y = D - 4; y < D - 2; y++) {
			if (smashed && r() < 0.6) continue;
			if (r() < 0.15) continue;
			c.inkAt(x, y, mix(snacks[(x + y * 3) % snacks.length], [110, 140, 156], smashed ? 0 : 0.35));
		}
	}
	if (smashed) for (let k = 0; k < 4; k++) c.inkAt(1 + Math.floor(r() * gw), D - 5 + Math.floor(r() * 4), K.shard);
	c.box(L - 4, D - 5, 3, 4, "steelDark", 5);
	c.dot(L - 3, D - 4, "goodsC", 6);
	c.box(2, 2, L - 7, 2, "vinyl", 6);
}

/** a library's stacks: a steel range, books tight on it with their call-number labels, gaps where some were taken */
function stacksShelf(c, L, D, look, r) {
	c.box(0, 0, L, D, "steel", 5);
	c.box(1, 1, L - 2, D - 2, "steelDark", 3);
	for (let x = 13; x < L - 2; x += 13) c.box(x, 0, 1, D, "steel", 5);
	const colours = ["goodsA", "goodsB", "fabricGreen", "fabricRed", "fabric", "goodsE", "woodDark", "goodsC"];
	let x = 1;
	while (x < L - 1) {
		if (x % 13 === 0) {
			x++;
			continue;
		}
		if (r() < 0.1) {
			x += 2;
			continue;
		}
		const mat = colours[Math.floor(r() * colours.length)];
		const depth = D - 3 + (r() < 0.3 ? 1 : 0);
		c.box(x, D - 1 - depth, 1, depth, mat, 4);
		if (r() < 0.5) c.inkAt(x, D - 3, [236, 232, 220]);
		x++;
	}
	if (look === 1 && L >= 12) c.box(Math.floor(L / 3), 1, 4, 2, "goodsB", 5);
}

/** a library table: open books, a stack, a green-shaded reading lamp in the middle */
function tableLibrary(c, L, D, look, r, K) {
	table(c, L, D, 2, r, K);
	// clear what the house table put down, keep the wood
	for (let i = 0; i < L * D; i++) {
		if (c.mat[i] !== null && c.mat[i] !== "wood") {
			c.mat[i] = "wood";
			c.z[i] = 2;
			c.ink[i] = null;
			c.tone[i] = 0;
		}
	}
	const alongX = L >= D;
	const cx = Math.floor(L / 2);
	const cy = Math.floor(D / 2);
	c.disc(cx, cy, 3, "fabricGreen", 4);
	c.dot(cx - 1, cy - 1, "fabricGreen", 4, 2);
	const spots = alongX
		? [
				[3, 2],
				[L - 9, D - 7],
				[L - 8, 2],
			]
		: [
				[2, 3],
				[D > 12 ? L - 7 : 2, D - 9],
			];
	for (const [x, y] of spots) {
		if (r() < 0.2) continue;
		// an open book: two pages and the gutter
		c.box(x, y, 6, 4, "paper", 3);
		c.shadeBox(x + 3, y, 1, 4, -1);
		c.inkBox(x + 1, y + 1, 1, 1, K.text);
		c.inkBox(x + 4, y + 2, 1, 1, K.text);
	}
	if (look !== 0) {
		c.box(alongX ? L - 6 : 2, alongX ? 2 : D - 6, 4, 3, "goodsB", 3);
		c.box(alongX ? L - 6 : 2, alongX ? 2 : D - 6, 4, 1, "goodsA", 4);
	}
}

/** a library's circulation desk: the front desk with the returns piled on it, a book stamp, the terminal */
function circulation(c, L, D, look, r, K) {
	reception(c, L, D, look, r, K);
	for (let k = 0; k < 3; k++) {
		const x = 4 + k * 3;
		c.box(x, D - 7, 3, 3, ["goodsA", "goodsB", "fabricGreen"][(k + look) % 3], 5 + k);
	}
	c.dot(L - 12, 3, "rubber", 5);
}

/** a cork notice board on the wall seen from above: its frame's top edge and the flyers pinned to it */
function notice(c, L, r) {
	c.box(0, 0, L, 1, "wood", 3);
	c.box(0, 1, L, 2, "cork", 2);
	// the flyers: pinned sheets hanging off the cork, some torn down
	for (let x = 2; x < L - 2; x += 3) {
		if (r() < 0.25) continue;
		const mat = r() < 0.2 ? "goodsC" : r() < 0.2 ? "goodsB" : "paper";
		c.box(x, 1, 2, 2, mat, 3);
		c.dot(x, 1, "goodsA", 4);
	}
}

function hospbed(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "steel", 2);
	c.box(1, 0, L - 2, 2, "steel", 4);
	c.box(1, 2, L - 2, D - 4, "bedding", 2);
	// the head section raised (lit), the pillow, the sheet, the rails and the foot
	c.box(1, 2, L - 2, 8, "bedding", 3);
	c.round(3, 3, L - 6, 4, "pillow", 3);
	const thrown = look === 1;
	const sw = thrown ? Math.round((L - 2) * 0.6) : L - 2;
	c.box(1, 12, sw, D - 15, "sheet", 3);
	c.box(1, 12, sw, 1, "bedding", 4);
	c.box(0, 5, 1, D - 12, "steel", 3);
	c.box(L - 1, 5, 1, D - 12, "steel", 3);
	c.box(1, D - 2, L - 2, 2, "steel", 3);
	for (let k = 0; k < 3; k++) c.shadeAt(2 + Math.floor(r() * (sw - 3)), 14 + Math.floor(r() * (D - 18)), -1);
	if (look === 2) {
		// dried blood on the sheet: a patient bled here (APO-01, a hospital)
		c.blotch(Math.round(L / 2), Math.round(D * 0.52), 14, K.blood, r);
		c.blotch(Math.round(L / 2), Math.round(D * 0.52), 4, K.bloodDark, r);
	}
}

function nightstand(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "wood", 2);
	if (look === 1) {
		// the lamp knocked over, its shade on its side
		c.box(1, 2, 4, 2, "shade", 3);
		c.dot(5, 3, "steel", 3);
	} else {
		c.disc(2, 2, 3, "shade", 4);
		c.inkAt(2, 2, mix([226, 208, 168], WHITE, 0.35));
	}
	c.box(L - 4, D - 3, 3, 2, look === 2 ? "goodsA" : "goodsB", 3);
	c.dot(L - 2, 1, "rubber", 3);
}

function wardrobe(c, L, D, look, r) {
	c.box(0, 0, L, D, "wood", 5);
	c.shadeBox(Math.floor(L / 2), 2, 1, D - 3, -1);
	if (look === 1) {
		c.round(3, 2, Math.min(9, L - 6), D - 4, "fabricBrown", 6);
		c.box(3 + Math.floor(Math.min(9, L - 6) / 2) - 1, 2, 2, 1, "rubber", 7);
	} else if (look === 2) {
		c.box(L - 8, 2, 4, 3, "cardboard", 6);
		c.box(L - 5, 3, 3, 3, "cardboardDark", 6);
	}
}

function desk(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "wood", 2);
	const mx = Math.round(L * 0.42);
	if (look === 1) {
		// the monitor knocked flat on its face
		c.box(mx - 3, 2, 9, 4, "screen", 3);
	} else if (look === 2) {
		// a laptop left open
		c.box(mx - 2, 1, 7, 2, "screen", 3);
		c.box(mx - 2, 3, 7, 3, "steel", 3);
		c.shadeBox(mx - 1, 4, 5, 1, -1);
	} else {
		c.box(mx - 3, 1, 8, 2, "screen", 4);
		c.box(mx, 3, 2, 1, "steelDark", 3);
		c.box(mx - 2, D - 5, 7, 2, "goodsE", 3);
		c.shadeBox(mx - 1, D - 4, 5, 1, -1);
	}
	// papers, a mug
	c.box(2, 2, 4, 5, "paper", 3);
	c.box(3, 4, 4, 5, "paper", 3);
	c.inkBox(4, 5, 2, 1, K.text);
	c.inkBox(4, 7, 2, 1, K.text);
	c.disc(L - 3, 3, 2, "porcelain", 3);
	if (L >= 20) c.box(L - 7, D - 4, 3, 2, "goodsB", 3);
}

function teacherdesk(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "woodDark", 2);
	// a stack of marked papers, the register, an apple, a mug of pens
	c.box(3, 3, 5, 6, "paper", 3);
	c.box(4, 2, 5, 6, "paper", 4);
	c.inkBox(5, 3, 3, 1, K.text);
	c.inkBox(5, 5, 2, 1, K.red);
	c.box(Math.round(L / 2) - 3, 2, 6, 4, "goodsB", 3);
	c.shadeBox(Math.round(L / 2), 2, 1, 4, -1);
	c.disc(L - 5, D - 5, 2, "goodsA", 3);
	c.dot(L - 5, D - 7, "leaf", 4);
	c.disc(L - 4, 3, 2, "porcelain", 3);
	c.dot(L - 4, 3, "goodsC", 4);
	if (look === 1) c.box(Math.round(L / 2) - 4, D - 5, 6, 3, "goodsD", 3);
}

function schooldesk(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "steelDark", 2);
	c.box(1, 0, L - 2, D - 1, "laminate", 2);
	// the pencil groove along the back
	c.shadeBox(1, 1, L - 2, 1, -1);
	const seats = L >= 18 ? 2 : 1;
	for (let s = 0; s < seats; s++) {
		const x0 = Math.round(((s + 0.5) * L) / seats) - 3;
		if (r() < 0.25) continue;
		// an exercise book, open, and a pencil
		c.box(x0, 3, 6, 4, "paper", 3);
		c.shadeBox(x0 + 3, 3, 1, 4, -1);
		c.inkBox(x0 + 1, 4, 2, 1, K.text);
		c.inkBox(x0 + 4, 5, 1, 1, K.text);
		if (r() < 0.7) c.box(x0 + 7, 2, 1, 3, "goodsC", 3);
	}
	if (look === 1) c.box(1, D - 4, 5, 3, "goodsB", 3);
}

function cabinet(c, L, D, look, r) {
	// a filing cabinet: steel, its drawers' tops along the front
	c.box(0, 0, L, D, "steel", 4);
	c.shadeBox(1, D - 3, L - 2, 1, -1);
	for (let x = Math.round(L / 3); x < L - 1; x += Math.round(L / 3)) c.shadeBox(x, 2, 1, D - 4, -1);
	if (look === 1) {
		c.disc(3, 3, 3, "pot", 5);
		plant(c, 3, 2, 6);
	} else if (look === 2) {
		c.box(L - 7, 1, 5, D - 3, "cardboard", 5);
		c.box(L - 6, 2, 3, 1, "paper", 6);
	}
}

function sideboard(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "woodDark", 3);
	// a vase of flowers, a stack of plates, a framed photo face down
	c.disc(4, Math.floor(D / 2), 2, "glass", 4);
	c.dot(3, D / 2 - 1.5, "goodsA", 5);
	c.dot(4, D / 2 - 1.5, "goodsC", 5);
	c.dot(5, D / 2 - 0.5, "leaf", 5);
	c.disc(L / 2, Math.floor(D / 2), 3, "porcelain", 4);
	if (look !== 1) c.box(L - 6, 2, 3, 3, "wood", 4);
}

function cabinetMed(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "porcelain", 4);
	c.shadeBox(1, D - 3, L - 2, 1, -1);
	c.shadeBox(Math.floor(L / 2), 2, 1, D - 4, -1);
	// a green cross on the door (never the red one: that emblem is protected), a box of gloves, a kidney dish
	const cx = Math.round(L / 4);
	c.inkBox(cx - 1, 3, 3, 1, K.green);
	c.inkBox(cx, 2, 1, 3, K.green);
	c.box(L - 7, 1, 5, 3, "goodsB", 5);
	c.inkBox(L - 6, 2, 3, 1, [226, 230, 234]);
	if (look === 1) c.box(Math.round(L / 2), D - 5, 4, 2, "steel", 5);
}

function toilet(c, L, D, look, r) {
	// the cistern against the wall, the bowl in front of it with its seat, the water (or the lid down)
	c.box(0, 0, L, 3, "porcelain", 4);
	c.dot(Math.floor(L / 2), 1, "steel", 5);
	const bw = Math.max(4, L - 2);
	const bx = Math.floor((L - bw) / 2);
	c.round(bx, 3, bw, D - 3, "porcelain", 2);
	if (look === 1) {
		c.round(bx + 1, 3, bw - 2, D - 4, "porcelain", 3);
	} else {
		c.round(bx + 1, 4, bw - 2, D - 6, "matBlue", 1);
	}
}

function basin(c, L, D, look, r) {
	// a vanity top with its bowl, the tap at the back, a bar of soap
	c.round(0, 0, L, D, "porcelain", 2);
	c.round(2, 2, L - 4, D - 3, "matBlue", 1);
	c.shadeBox(3, 2, L - 6, 1, -1);
	c.dot(Math.floor(L / 2), 0, "steel", 4);
	c.dot(Math.floor(L / 2), 1, "steel", 3);
	c.dot(L - 2, 1, "goodsD", 3);
}

function tub(c, L, D, look, r, K) {
	c.round(0, 0, L, D, "porcelain", 3);
	c.round(2, 2, L - 4, D - 4, "matBlue", 1);
	// the waterline's grime, the tap and the drain at one end
	c.shadeBox(3, 2, L - 6, 1, -1);
	const end = look % 2 === 0;
	const tx = end ? 1 : L - 2;
	c.dot(tx, Math.floor(D / 2) - 1, "steel", 4);
	c.dot(tx, Math.floor(D / 2) + 1, "steel", 4);
	c.inkAt(end ? 4 : L - 5, Math.floor(D / 2), [70, 76, 84]);
	c.shadeBox(end ? 3 : L - 8, 3, 5, D - 6, -1);
	if (look === 2) c.box(L - 9, D - 4, 4, 1, "goodsE", 4);
}

/** products on a shelf deck: blocks of `pal` colours along a band, some gone, one knocked over */
function products(c, x0, x1, y0, depth, pal, r, z, { gap = 0.16, width = [2, 3] } = {}) {
	let x = x0;
	while (x < x1) {
		const w = width[Math.floor(r() * width.length)];
		if (r() < gap) {
			x += w;
			continue;
		}
		const mat = pal[Math.floor(r() * pal.length)];
		const d = Math.max(1, depth - (r() < 0.3 ? 1 : 0));
		const ww = Math.min(w, x1 - x);
		if (r() < 0.06 && ww >= 2) {
			// knocked over: lying across the deck
			c.box(x, y0 + depth - 2, ww + 1, 2, mat, z - 1);
		} else c.box(x, y0 + (depth - d), ww, d, mat, z);
		if (ww >= 2) c.shadeBox(x + ww - 1, y0 + (depth - d), 1, d, -1);
		x += ww + (r() < 0.3 ? 1 : 0);
	}
}

function shelf(c, L, D, look, r, K, stock = "mixed") {
	const frame = stock === "meds" ? "porcelain" : stock === "clothes" ? "wood" : "steel";
	c.box(0, 0, L, D, frame, 4);
	c.box(1, 1, L - 2, D - 2, stock === "clothes" ? "woodDark" : "steel", 2);
	const bay = 12;
	for (let x = bay; x < L - 2; x += bay) c.box(x, 0, 1, D, frame, 4);
	for (let b = 1; b < L - 1; b += bay) {
		const x1 = Math.min(L - 1, b + bay - 1);
		if (stock === "clothes") {
			// folded stacks, each a colour, a fold line across
			let x = b;
			while (x + 4 <= x1) {
				if (r() < 0.2) {
					x += 5;
					continue;
				}
				const mat = ["fabric", "fabricRed", "fabricGreen", "fabricMustard", "bedding", "fabricBrown"][
					Math.floor(r() * 6)
				];
				c.box(x, 2, 4, D - 3, mat, 3);
				c.shadeBox(x, 2 + Math.floor((D - 3) / 2), 4, 1, -1);
				x += 5;
			}
		} else if (stock === "meds") {
			products(c, b, x1, 2, D - 3, ["goodsE", "goodsE", "goodsB", "goodsD", "amber", "goodsA"], r, 3, {
				gap: 0.2,
			});
		} else {
			products(c, b, x1, 2, D - 3, ["goodsA", "goodsB", "goodsC", "goodsD", "goodsE"], r, 3);
		}
	}
	// the medicine boxes' printed stripes
	if (stock === "meds") {
		for (let x = 2; x < L - 2; x += 3) if (r() < 0.4) c.inkAt(x, D - 3, look === 1 ? K.green : [70, 130, 170]);
	}
}

/** the gondola: double-sided, a tall spine along the middle, products both sides in bays, end caps (face-free) */
function gondola(c, L, D, look, r) {
	if (D > L) {
		const cv = new Canvas(D, L);
		gondola(cv, D, L, look, r);
		const t = cv.transposed();
		c.mat = t.mat;
		c.z = t.z;
		c.tone = t.tone;
		c.ink = t.ink;
		return;
	}
	c.box(0, 0, L, D, "steel", 2);
	const mid = Math.floor(D / 2);
	c.box(0, mid - 1, L, 2, "steelDark", 5);
	const bay = 14;
	const pals = [
		["goodsA", "goodsC", "goodsE"],
		["goodsB", "goodsE", "goodsD"],
		["goodsC", "goodsA", "cardboard"],
		["goodsD", "goodsB", "goodsF"],
		["amber", "goodsE", "goodsA"],
	];
	for (let b = 2; b < L - 2; b += bay) {
		const x1 = Math.min(L - 2, b + bay - 1);
		const pal = pals[Math.floor(r() * pals.length)];
		products(c, b, x1, 1, mid - 2, pal, r, 3, { gap: 0.2 });
		products(c, b, x1, mid + 1, D - mid - 2, pals[Math.floor(r() * pals.length)], r, 3, { gap: 0.2 });
		c.box(x1, 0, 1, D, "steel", 4);
	}
	// the end caps
	c.box(0, 0, 2, D, "steel", 4);
	c.box(L - 2, 0, 2, D, "steel", 4);
	c.box(0, mid - 2, 2, 4, look === 1 ? "goodsA" : "goodsC", 5);
}

function checkout(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "counter", 2);
	// the belt along the customer side, the scanner, the register and its open drawer
	const bl = Math.round(L * 0.56);
	c.box(1, D - 5, bl, 3, "rubber", 2);
	for (let x = 2; x < bl; x += 2) c.shadeBox(x, D - 5, 1, 3, 1);
	c.box(bl + 1, D - 5, 4, 3, "glassDark", 3);
	c.box(L - 8, 1, 6, 4, "steelDark", 4);
	c.inkBox(L - 7, 2, 4, 1, [44, 70, 66]);
	c.box(L - 7, 5, 4, 2, "steelDark", 3);
	if (look !== 1) {
		for (let k = 0; k < 3; k++) c.inkAt(L - 7 + Math.floor(r() * 4), 5 + Math.floor(r() * 2), K.coin);
	}
	c.box(2, 1, 5, 2, "steelDark", 3);
	if (r() < 0.6) c.box(3 + Math.floor(r() * (bl - 6)), D - 5, 2, 2, ["goodsA", "goodsB", "goodsC"][look % 3], 3);
}

function coldcase(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "steel", 4);
	c.shadeBox(0, D - 2, L, 1, -1);
	c.box(1, 1, L - 2, D - 3, "glass", 3);
	const sec = 18;
	for (let x = sec; x < L - 2; x += sec) c.box(x, 0, 1, D - 1, "steel", 4);
	// the products under the glass, cold, and the frost on it
	const pal = [
		[196, 84, 60],
		[70, 130, 170],
		[222, 220, 210],
		[214, 180, 70],
		[98, 150, 88],
	];
	const glass = [150, 196, 214];
	let broken = look === 1 ? Math.floor(r() * Math.max(1, L - 10)) + 2 : -99;
	// rows of bottles and cartons, two texels a facing, in runs of one product; the gaps are what was taken
	let x = 2;
	while (x < L - 3) {
		const run = 2 + Math.floor(r() * 3);
		const p = pal[Math.floor(r() * pal.length)];
		const gone = r() < 0.2;
		for (let k = 0; k < run && x < L - 3; k++, x += 2) {
			if (gone || x % sec === 0 || (x + 1) % sec === 0) continue;
			const inBreak = x >= broken && x < broken + 7;
			const col = inBreak ? p : mix(p, glass, 0.5);
			for (let y = 3; y < D - 3; y += 2) c.inkAt(x, y, col);
			c.inkAt(x, 2, mix(col, WHITE, 0.25));
		}
		x += r() < 0.4 ? 1 : 0;
	}
	for (let k = 0; k < L / 6; k++)
		c.inkAt(2 + Math.floor(r() * (L - 4)), 1 + Math.floor(r() * 2), mix(glass, WHITE, 0.6));
	if (broken > 0) {
		for (let k = 0; k < 5; k++) c.inkAt(broken + Math.floor(r() * 7), 2 + Math.floor(r() * (D - 5)), K.shard);
	}
	for (let x = 2; x < L - 2; x += 2) c.inkAt(x, D - 2, [70, 74, 82]);
}

function rack(c, L, D, look, r) {
	c.box(0, 0, L, D, "steel", 2);
	for (let x = 1; x < L - 1; x += 2) c.shadeBox(x, 1, 1, D - 2, -1);
	const bay = 13;
	// cardboard boxes: stacked, some open, the tape across the lids
	let x = 1;
	while (x < L - 3) {
		const w = 4 + Math.floor(r() * 4);
		if (r() < 0.2) {
			x += w;
			continue;
		}
		const ww = Math.min(w, L - 1 - x);
		const d = D - 2 - Math.floor(r() * 3);
		const mat = r() < 0.5 ? "cardboard" : "cardboardDark";
		const high = r() < 0.4;
		c.box(x, 1, ww, d, mat, high ? 4 : 3);
		if (r() < 0.25) c.box(x + 1, 2, Math.max(1, ww - 2), Math.max(1, d - 2), "cardboardDark", 1);
		else c.shadeBox(x + Math.floor(ww / 2), 1, 1, d, 1);
		x += ww + (r() < 0.5 ? 1 : 0);
	}
	for (let px = 0; px < L; px += bay) {
		c.box(px, 0, 1, 1, "steelDark", 5);
		c.box(px, D - 1, 1, 1, "steelDark", 5);
	}
	c.box(L - 1, 0, 1, 1, "steelDark", 5);
	c.box(L - 1, D - 1, 1, 1, "steelDark", 5);
}

function gunrack(c, L, D, look, r) {
	c.box(0, 0, L, D, "wood", 2);
	c.box(0, 0, L, 3, "woodDark", 3);
	for (let x = 1; x < L - 1; x += 2) c.shadeAt(x, 1, -1);
	// the long guns stood in their slots, muzzles to the wall; the gaps are the ones taken
	for (let x = 2; x < L - 2; x += 3) {
		if (r() < 0.3) continue;
		c.box(x, 1, 1, D - 3, "steel", 4);
		c.box(x, D - 3, 1, 3, "woodDark", 4);
		if (r() < 0.3) c.dot(x, D - 4, "steelDark", 5);
	}
	if (look === 1 && L >= 16) {
		// one lying across the rest
		c.box(3, D - 4, 9, 1, "steel", 5);
		c.box(12, D - 4, 3, 1, "woodDark", 5);
	}
}

function displayCase(c, L, D, look, r, K, stock = "guns") {
	const frame = stock === "guns" ? "woodDark" : "porcelain";
	c.box(0, 0, L, D, frame, 3);
	c.box(1, 1, L - 2, D - 2, "glassDark", 2);
	const felt = stock === "guns" ? [96, 36, 38] : [214, 214, 206];
	const glass = [110, 140, 156];
	for (let y = 2; y < D - 2; y++) for (let x = 2; x < L - 2; x++) c.inkAt(x, y, mix(felt, glass, 0.4));
	// what is on show: pistols (a gun shop), boxes and bottles (a pharmacy); gaps where it was taken
	const smash = look === 1 ? 3 + Math.floor(r() * Math.max(1, L - 14)) : -99;
	for (let x = 3; x < L - 5; x += 6) {
		if (r() < 0.25) continue;
		const inSmash = x >= smash - 1 && x < smash + 8;
		const tint = p => (inSmash ? p : mix(p, glass, 0.35));
		if (stock === "guns") {
			const g = tint([46, 48, 54]);
			c.inkBox(x, 3, 4, 1, g);
			c.inkBox(x, 4, 2, 2, g);
			c.inkAt(x + 1, 4, tint([120, 84, 56]));
		} else {
			c.inkBox(x, 3, 2, 3, tint([222, 220, 210]));
			c.inkAt(x, 4, tint([70, 130, 170]));
			c.inkBox(x + 3, 4, 1, 2, tint([172, 112, 52]));
		}
	}
	if (smash > 0) {
		// the smashed pane: what is left of the glass round the hole, and its shards
		for (let k = 0; k < 9; k++) c.inkAt(smash + Math.floor(r() * 8), 2 + Math.floor(r() * (D - 4)), K.shard);
		c.shadeBox(smash - 1, 1, 1, D - 2, 1);
	}
	for (let x = 2; x < L - 2; x += 5) c.inkAt(x, 1, mix(glass, WHITE, 0.55));
}

function clothesrack(c, L, D, look, r) {
	const mid = Math.floor(D / 2);
	const pal =
		look === 1
			? ["fabric", "fabricGreen", "bedding", "fabric"]
			: ["fabricRed", "fabricMustard", "fabricBrown", "fabric"];
	// the rack's two feet, running across its depth, and the rail between them
	c.box(0, 0, 2, D, "steelDark", 2);
	c.box(L - 2, 0, 2, D, "steelDark", 2);
	c.box(2, mid, L - 4, 1, "steel", 3);
	// the garments on their hangers across the rail, the whole depth of the rack, in runs of a colour; a gap where
	// some were taken, one pulled half off its hanger
	let x = 2;
	while (x < L - 2) {
		const run = 2 + Math.floor(r() * 5);
		const mat = pal[Math.floor(r() * pal.length)];
		const gone = r() < 0.18;
		for (let k = 0; k < run && x < L - 2; k++, x++) {
			if (gone) continue;
			const sag = r() < 0.08 ? 1 : 0;
			// a garment's shoulders across the rail: its hanger's hook shows at the top of every other one
			c.box(x, sag, 1, D - sag, mat, 4, k % 2 === 0 ? 0 : -1);
			if (k % 2 === 0) c.dot(x, mid, mat, 5, 1);
		}
	}
}

function optable(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "steel", 2);
	c.round(1, 1, L - 2, D - 2, "vinylTeal", 3);
	// the paper sheet down the middle and the head rest; blood where something was done in a hurry
	c.box(Math.round(L * 0.2), 2, Math.round(L * 0.66), D - 4, "paper", 3);
	c.round(2, 2, 5, D - 4, "bedding", 4);
	if (look !== 0) {
		c.blotch(Math.round(L * 0.52), Math.round(D / 2), look === 2 ? 18 : 11, K.blood, r);
		c.blotch(Math.round(L * 0.52), Math.round(D / 2), 3, K.bloodDark, r);
	}
}

function reception(c, L, D, look, r, K) {
	// the desk behind, the raised counter the visitors lean on along the front, a return at each end
	c.box(0, 0, L, D, "laminate", 2);
	c.box(0, D - 4, L, 4, "wood", 4);
	c.box(0, 0, 3, D, "wood", 4);
	c.box(L - 3, 0, 3, D, "wood", 4);
	const mx = Math.round(L * 0.35);
	c.box(mx, 1, 7, 2, "screen", 5);
	c.box(mx + 3, 3, 2, 1, "steelDark", 3);
	c.box(mx, 5, 7, 2, "goodsE", 3);
	c.box(Math.round(L * 0.62), 2, 4, 5, "paper", 3);
	c.inkBox(Math.round(L * 0.62) + 1, 3, 2, 1, K.text);
	c.box(6, 2, 4, 3, "steelDark", 3);
	c.box(L - 9, 2, 3, 5, look === 1 ? "goodsA" : "goodsB", 3);
	c.dot(Math.round(L * 0.5), D - 3, "steel", 5);
	if (look === 2) c.box(Math.round(L * 0.75), D - 3, 5, 2, "paper", 5);
}

function lockers(c, L, D, look, r) {
	const mat = look === 1 ? "lockerGreen" : "locker";
	c.box(0, 0, L, D, mat, 5);
	for (let x = 4; x < L; x += 4) c.shadeBox(x, 0, 1, D, -1);
	// the vents along each top, a dent here and there
	for (let x = 1; x < L - 1; x++) if (x % 4 !== 0 && x % 4 !== 3) c.shadeAt(x, 2, -1);
	for (let k = 0; k < L / 10; k++) c.shadeAt(1 + Math.floor(r() * (L - 2)), 3 + Math.floor(r() * (D - 5)), -1);
	if (L >= 16 && r() < 0.6) c.box(Math.floor(r() * (L / 4 - 1)) * 4 + 1, 3, 3, 3, "fabricRed", 6);
}

function prep(c, L, D, look, r, K) {
	c.box(0, 0, L, D, "steel", 2);
	for (let y = 2; y < D - 1; y += 2) c.shadeBox(1, y, L - 2, 1, -1);
	// a board with a knife, bowls, a tray, what was being cut
	c.box(3, 3, 7, 5, "woodLight", 3);
	c.box(4, 5, 5, 1, "steel", 4);
	c.dot(9, 5, "rubber", 4);
	c.disc(L - 6, 4, 4, "porcelain", 3);
	c.box(L - 7, 3, 2, 2, "food", 3);
	c.disc(L / 2, D - 5, 3, "porcelain", 3);
	c.box(Math.round(L / 2) + 3, D - 6, 6, 4, "steelDark", 3);
	for (let k = 0; k < 4; k++)
		c.dot(Math.round(L / 2) + 4 + Math.floor(r() * 4), D - 5 + Math.floor(r() * 2), "food", 4);
	if (look === 1) c.inkBox(5, D - 4, 3, 2, K.blood);
}

function safe(c, L, D, look, r) {
	c.box(0, 0, L, D, "steelDark", 5);
	for (const [x, y] of [
		[2, 2],
		[L - 3, 2],
		[2, D - 3],
		[L - 3, D - 3],
	])
		c.dot(x, y, "steel", 6);
	// the door's wheel and dial along the front, the hinges on one side
	c.ellipse(L / 2 - 0.5, D - 4.5, 2.3, 2.3, "steel", 6);
	c.ellipse(L / 2 - 0.5, D - 4.5, 1, 1, "steelDark", 6);
	c.dot(L / 2 - 0.5, D - 4.5, "steel", 7);
	c.box(1, 4, 1, 2, "steel", 6);
	c.box(1, D - 6, 1, 2, "steel", 6);
	if (look === 1) c.box(L - 5, 3, 2, 3, "goodsC", 6);
}

function bench(c, L, D, look, r) {
	// three slats on steel frames
	for (let s = 0; s < 3; s++) {
		const y = 1 + s * Math.floor((D - 1) / 3);
		c.box(0, y, L, Math.max(1, Math.floor((D - 1) / 3) - 1), "wood", 2);
	}
	for (const x of [1, Math.floor(L / 2), L - 2]) c.box(x, 0, 1, D, "steelDark", 3);
}

function benchSeats(c, L, D, look, r) {
	// a row of moulded seats on a steel beam (a waiting room)
	c.box(0, 0, L, 2, "steelDark", 2);
	const n = Math.max(1, Math.floor(L / 7));
	const sw = Math.floor(L / n);
	for (let k = 0; k < n; k++) {
		const x = k * sw;
		c.round(x, 0, sw - 1, D, "plastic", 3);
		c.box(x, 0, sw - 1, 2, "plastic", 4);
		c.shadeBox(x + 1, 2, sw - 3, 1, -1);
	}
}

function armchair(c, L, D, look, r, K) {
	sofa(c, L, D, look, r, K);
}

/** a kind with no drawer of its own (a new room type): a plain wooden cabinet, outlined and lit like the rest */
function generic(c, L, D) {
	c.box(0, 0, L, D, "wood", 3);
	if (L >= 8) c.shadeBox(Math.floor(L / 2), 2, 1, Math.max(1, D - 4), -1);
}

/**
 * The art kinds: `draw` paints, `looks` counts the looks `Solid.variant` picks from, `tall` doubles the shadow,
 * `from` names the planner kind whose sizes it takes (an art kind picked by building type, ART_KIND_BY_TYPE).
 */
const KINDS = {
	sofa: { draw: sofa, looks: 3 },
	armchair: { draw: armchair, looks: 3 },
	booth: { draw: booth, looks: 2 },
	tv: { draw: tv, looks: 3, tall: true },
	bookcase: { draw: bookcase, looks: 2, tall: true },
	counter: { draw: counter, looks: 2 },
	counterSteel: { draw: (c, L, D, l, r, K) => counter(c, L, D, l, r, K, true), looks: 2, from: "counter" },
	stove: { draw: stove, looks: 3 },
	fridge: { draw: fridge, looks: 3, tall: true },
	table: { draw: table, looks: 3 },
	tableDiner: { draw: tableDiner, looks: 3, from: "table" },
	bed: { draw: bed, looks: 3 },
	hospbed: { draw: hospbed, looks: 3 },
	nightstand: { draw: nightstand, looks: 3 },
	wardrobe: { draw: wardrobe, looks: 3, tall: true },
	desk: { draw: desk, looks: 3 },
	teacherdesk: { draw: teacherdesk, looks: 2 },
	schooldesk: { draw: schooldesk, looks: 2 },
	cabinet: { draw: cabinet, looks: 3, tall: true },
	sideboard: { draw: sideboard, looks: 2, from: "cabinet" },
	cabinetMed: { draw: cabinetMed, looks: 2, tall: true, from: "cabinet" },
	toilet: { draw: toilet, looks: 2 },
	basin: { draw: basin, looks: 1 },
	tub: { draw: tub, looks: 3 },
	shelf: { draw: shelf, looks: 1, tall: true },
	shelfMeds: { draw: (c, L, D, l, r, K) => shelf(c, L, D, l, r, K, "meds"), looks: 2, tall: true, from: "shelf" },
	shelfClothes: {
		draw: (c, L, D, l, r, K) => shelf(c, L, D, l, r, K, "clothes"),
		looks: 1,
		tall: true,
		from: "shelf",
	},
	gondola: { draw: gondola, looks: 2, tall: true, faceless: true },
	checkout: { draw: checkout, looks: 3 },
	coldcase: { draw: coldcase, looks: 2, tall: true },
	rack: { draw: rack, looks: 2, tall: true },
	gunrack: { draw: gunrack, looks: 2, tall: true },
	display: { draw: (c, L, D, l, r, K) => displayCase(c, L, D, l, r, K, "meds"), looks: 2 },
	displayGuns: { draw: (c, L, D, l, r, K) => displayCase(c, L, D, l, r, K, "guns"), looks: 2, from: "display" },
	clothesrack: { draw: clothesrack, looks: 2 },
	optable: { draw: optable, looks: 3 },
	reception: { draw: reception, looks: 3 },
	lockers: { draw: lockers, looks: 2, tall: true },
	prep: { draw: prep, looks: 2 },
	safe: { draw: safe, looks: 2, tall: true },
	bench: { draw: bench, looks: 1 },
	benchSeats: { draw: benchSeats, looks: 1, from: "bench" },
	// the campus (EDI-17)
	seats: { draw: seats, looks: 3 },
	lectern: { draw: lectern, looks: 2 },
	labbench: { draw: labbench, looks: 3 },
	fumehood: { draw: fumehood, looks: 2, tall: true },
	chemshelf: { draw: chemshelf, looks: 2, tall: true },
	bunk: { draw: bunk, looks: 3, tall: true },
	vending: { draw: vending, looks: 2, tall: true },
	stacks: { draw: stacksShelf, looks: 2, tall: true, from: "bookcase" },
	tableLibrary: { draw: tableLibrary, looks: 2, from: "table" },
	circulation: { draw: circulation, looks: 3, from: "reception" },
};

/**
 * The art kind a piece takes by the type of its building (shared/game/world.ts building types): a planner kind that
 * means different things in different buildings. Written into the client's table (furnitureAtlas.ts).
 */
export const ART_KIND_BY_TYPE = {
	shelf: { 6: "shelfMeds", 10: "shelfClothes" },
	display: { 9: "displayGuns" },
	cabinet: { 1: "sideboard", 2: "sideboard", 4: "cabinetMed" },
	bench: { 4: "benchSeats" },
	counter: { 11: "counterSteel" },
	table: { 11: "tableDiner", 13: "tableLibrary" },
	// the campus's library (EDI-17): its shelves are the stacks, its front desk the circulation desk
	bookcase: { 13: "stacks" },
	reception: { 13: "circulation" },
};

// ---------------------------------------------------------------- decoration and openings (face-free cells)

function chair(c) {
	// the seat towards the table (the bottom), the back rest away from it
	c.box(1, 1, 5, 5, "wood", 2);
	c.box(1, 0, 5, 2, "woodDark", 3);
	c.dot(1, 6, "woodDark", 1);
	c.dot(5, 6, "woodDark", 1);
}

function chairDown(c) {
	// tipped over backwards: the back rest flat on the floor, the seat's underside up, its four legs in the air
	c.box(1, 0, 5, 2, "woodDark", 1);
	c.box(1, 2, 5, 5, "wood", 2);
	c.shadeBox(2, 3, 3, 3, -1);
	for (const [x, y] of [
		[1, 2],
		[5, 2],
		[1, 6],
		[5, 6],
	]) {
		c.dot(x, y, "woodDark", 4);
	}
}

function papers(c, L, D, r, K) {
	const sheets = 2 + Math.floor(r() * 2);
	for (let k = 0; k < sheets; k++) {
		const x = Math.floor(r() * (L - 5));
		const y = Math.floor(r() * (D - 6));
		c.box(x, y, 5, 6, "paper", 1 + k);
		// a corner turned: a sheet lying askew
		if (r() < 0.6) c.clear(x + (r() < 0.5 ? 0 : 4), y);
		for (let t = y + 1; t < y + 5; t += 2) c.inkBox(x + 1, t, 3 - (t % 3 === 0 ? 1 : 0), 1, K.text);
	}
}

function glassShards(c, L, D, r, K) {
	for (let k = 0; k < 11; k++) {
		const x = Math.floor(r() * L);
		const y = Math.floor(r() * D);
		c.dot(x, y, "glass", 1, r() < 0.4 ? 2 : 1);
		if (r() < 0.4) c.dot(x + 1, y, "glass", 1, 0);
	}
}

function bathMat(c, L, D, r) {
	c.round(0, 1, L, D - 2, "matBlue", 1);
	for (let k = 0; k < L * 1.5; k++)
		c.shadeAt(1 + Math.floor(r() * (L - 2)), 2 + Math.floor(r() * (D - 4)), r() < 0.5 ? 1 : -1);
	for (let x = 1; x < L - 1; x += 2) {
		c.dot(x, 0, "matBlue", 1, 1);
		c.dot(x, D - 1, "matBlue", 1, 1);
	}
}

function curtain(c, L) {
	// the privacy curtain hanging from its ceiling rail, in pleats (lit on the top-left of each fold)
	for (let x = 0; x < L; x++) {
		const fold = x % 4;
		c.dot(x, 0, "curtain", 3, fold === 0 ? 2 : fold === 1 ? 1 : fold === 3 ? -1 : 0);
		c.dot(x, 1, "curtain", 3, fold === 0 ? 1 : fold === 3 ? -2 : fold === 2 ? -1 : 0);
	}
}

/**
 * The chalkboard on the front wall, seen from above and a little from the room: its wooden frame against the wall,
 * the green slate with the last lesson's chalk on it, the aluminium tray with chalk and a duster left in it.
 */
function board(c, L, r) {
	c.box(0, 0, L, 1, "woodDark", 3);
	c.box(0, 1, L, 1, "chalk", 3);
	for (let x = 2; x < L - 2; x++) if (r() < 0.35) c.dot(x, 1, "chalk", 3, 2);
	c.box(0, 2, L, 1, "steel", 2);
	c.dot(Math.floor(L * 0.3), 2, "goodsE", 3);
	c.dot(Math.floor(L * 0.3) + 2, 2, "goodsE", 3);
	c.box(Math.floor(L * 0.7), 2, 3, 1, "rubber", 3);
}

/** a rug: fringe on the short ends, a dark border, a light line, the field with a small lattice (crop-friendly) */
function rug(c, L, D, colour) {
	const field = colour;
	c.box(0, 0, L, D, field, 1);
	const long = L >= D;
	for (let y = 0; y < D; y++) {
		for (let x = 0; x < L; x++) {
			const e = Math.min(x, y, L - 1 - x, D - 1 - y);
			const endGap = long ? Math.min(x, L - 1 - x) : Math.min(y, D - 1 - y);
			if (endGap === 0) {
				// the fringe: every other thread
				if ((long ? y : x) % 2 === 0) c.dot(x, y, "paper", 1, -1);
				else c.clear(x, y);
				continue;
			}
			if (e <= 2 && !(endGap === 0)) c.shadeAt(x, y, -1);
			if (e === 3) c.inkAt(x, y, colour === "rugCream" ? [150, 76, 62] : [206, 172, 96]);
			if (e > 4 && (x + y) % 4 === 0 && (x - y + 400) % 8 === 0) c.shadeAt(x, y, 1);
			if (e > 4 && (x - y + 400) % 4 === 0 && (x + y) % 8 === 4) c.shadeAt(x, y, -1);
		}
	}
}

/**
 * A doorway's frame: the painted casing capping the wall's end on each side of the gap (its outer texel the wall's
 * outline, its inner one lit or in shade by the side the light comes from) and a threshold across the gap (an
 * outside door's is stone, an inside one's a strip of oak). Drawn without the silhouette outline: it is part of the
 * wall.
 */
function doorway(c, L, D, outside) {
	const jamb = 2;
	for (let y = 0; y < D; y++) {
		c.dot(0, y, "trim", 4, -1);
		c.dot(1, y, "trim", 4, 0);
		c.dot(L - 2, y, "trim", 4, 0);
		c.dot(L - 1, y, "trim", 4, -1);
	}
	const y = Math.floor((D - 1) / 2);
	const t = outside ? 2 : 1;
	c.box(jamb, y, L - 2 * jamb, t, outside ? "counter" : "woodLight", 1);
}

/**
 * A window seen from above, its glass broken (EDI-10; EDI-18: born broken or broken since): the painted frame capping
 * the wall's ends, the inside sill (oak) and the outside one (stone), and between them what is left of the pane --
 * translucent glass still in the frame at both ends and along the edges, jagged, the middle gone: the horde climbs
 * through there.
 */
function windowFrame(c, L, D, r, K) {
	const jamb = 3;
	for (let y = 0; y < D; y++) {
		c.dot(0, y, "trim", 4, -1);
		c.dot(1, y, "trim", 4, 0);
		c.dot(2, y, "trim", 4, 0);
		c.dot(L - 3, y, "trim", 4, 0);
		c.dot(L - 2, y, "trim", 4, 0);
		c.dot(L - 1, y, "trim", 4, -1);
	}
	const w = L - 2 * jamb;
	c.box(jamb, 0, w, 1, "woodLight", 3);
	c.box(jamb, D - 1, w, 1, "counter", 3);
	// the pane between the sills: gone in the middle, jagged remnants at the ends and a sliver along each sill
	for (let y = 1; y < D - 1; y++) {
		const left = 2 + Math.floor(r() * 4) - (y === 2 ? 1 : 0);
		const right = 2 + Math.floor(r() * 4) - (y === 2 ? 1 : 0);
		for (let x = jamb; x < jamb + w; x++) {
			const kept = x < jamb + left || x >= jamb + w - right || (y !== 2 && r() < 0.18);
			if (kept) c.dot(x, y, "pane", 2);
		}
	}
	for (let k = 0; k < 3; k++) c.inkAt(jamb + 2 + Math.floor(r() * (w - 4)), D - 1, K.shard);
}

/**
 * The same window with its glass in (EDI-18): the painted frame and the two sills, and between them the whole pane --
 * the same translucent glass, the floor showing through -- split by the glazing bar, with the light on it (ART-02: from
 * the top left) as a slanted streak a third of the way along each sash and a glint in its corner. Read from above, the
 * difference from `windowFrame` is the middle: filled and lit here, open there.
 */
function windowGlass(c, L, D, r, K) {
	const jamb = 3;
	for (let y = 0; y < D; y++) {
		c.dot(0, y, "trim", 4, -1);
		c.dot(1, y, "trim", 4, 0);
		c.dot(2, y, "trim", 4, 0);
		c.dot(L - 3, y, "trim", 4, 0);
		c.dot(L - 2, y, "trim", 4, 0);
		c.dot(L - 1, y, "trim", 4, -1);
	}
	const w = L - 2 * jamb;
	c.box(jamb, 0, w, 1, "woodLight", 3);
	c.box(jamb, D - 1, w, 1, "counter", 3);
	c.box(jamb, 1, w, D - 2, "pane", 2);
	// the glazing bar between the two sashes
	const bar = Math.floor(L / 2);
	c.box(bar, 1, 1, D - 2, "trim", 3);
	// the reflection on each sash: a streak slanting down to the left, a third of the way along it, and a glint
	for (const x0 of [jamb + Math.floor((bar - jamb) / 3), bar + 1 + Math.floor((L - jamb - bar - 1) / 3)]) {
		for (let y = 1; y < D - 1; y++) c.dot(x0 + (D - 2 - y), y, "pane", 2, 2);
	}
	c.inkAt(jamb, 1, K.shard);
	c.inkAt(bar + 1, 1, K.shard);
}

// ---------------------------------------------------------------- what the planner makes

/**
 * Reads shared/game/interiors.ts: the kinds (the FurnitureKind union), each literal piece size `(ctx, "kind", len,
 * depth` (againstWall, island, grid and the aisles' checkouts), the kinds laid out by `aisles` (computed lengths)
 * and which kinds are tall (PIECES.low false).
 */
export function readPlanner(ROOT) {
	const src = readFileSync(join(ROOT, "src", "shared", "game", "interiors.ts"), "utf8");
	const union = /export type FurnitureKind =([^;]+);/.exec(src);
	const kinds = union ? [...union[1].matchAll(/"(\w+)"/g)].map(m => m[1]) : [];
	const sizes = {};
	for (const m of src.matchAll(/\(\s*ctx\s*,\s*"(\w+)"\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
		const k = m[1];
		(sizes[k] ??= new Set()).add(`${m[2]},${m[3]}`);
	}
	const aisles = {};
	for (const m of src.matchAll(/aisles\(\s*ctx\s*,\s*"(\w+)"\s*,\s*(\d+)\s*\)/g)) aisles[m[1]] = Number(m[2]);
	const tall = {};
	for (const m of src.matchAll(/^\t(\w+): \{ low: (true|false)/gm)) tall[m[1]] = m[2] === "false";
	return { kinds, sizes, aisles, tall };
}

// ---------------------------------------------------------------- the atlas

/**
 * Every cell painted, deduplicated (the same pixels are stored once), and shelf-packed into one image of at most
 * MAX_SIDE x MAX_SIDE. Answers the RGBA image and, per key, [x, y, w, h, shadow] in texels.
 */
function pack(entries) {
	const unique = [];
	const byHash = new Map();
	for (const e of entries) {
		const bytes = Buffer.alloc(e.img.w * e.img.h * 4);
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.max(0, Math.min(255, Math.round(e.img.d[i])));
		for (let i = 0; i < e.img.w * e.img.h; i++)
			if (bytes[i * 4 + 3] === 0) bytes[i * 4] = bytes[i * 4 + 1] = bytes[i * 4 + 2] = 0;
		const h = `${e.img.w}x${e.img.h}:${hashStr(bytes.toString("latin1"))}:${bytes.length}`;
		let u = byHash.get(h);
		if (u === undefined) {
			u = { w: e.img.w, h: e.img.h, bytes, keys: [] };
			byHash.set(h, u);
			unique.push(u);
		}
		u.keys.push(e);
	}
	// tallest first, rows left to right
	const order = [...unique].sort((a, b) => b.h - a.h || b.w - a.w);
	let x = 0;
	let y = 0;
	let rowH = 0;
	let width = 0;
	for (const u of order) {
		if (x + u.w + GUTTER > MAX_SIDE) {
			y += rowH;
			x = 0;
			rowH = 0;
		}
		u.x = x;
		u.y = y;
		x += u.w + GUTTER;
		rowH = Math.max(rowH, u.h + GUTTER);
		width = Math.max(width, x);
	}
	const height = y + rowH;
	if (width > MAX_SIDE || height > MAX_SIDE)
		throw new Error(`furniture atlas ${width} x ${height} is over ${MAX_SIDE}`);
	const W = width;
	const H = height;
	const data = Buffer.alloc(W * H * 4);
	for (const u of order) {
		for (let yy = 0; yy < u.h; yy++)
			u.bytes.copy(data, ((u.y + yy) * W + u.x) * 4, yy * u.w * 4, (yy + 1) * u.w * 4);
	}
	const cells = {};
	for (const u of order) for (const e of u.keys) cells[e.key] = [u.x, u.y, u.w, u.h, e.shadow];
	return { w: W, h: H, data, cells, unique: unique.length };
}

/**
 * The whole interior art: `{ atlas: { w, h, toCanvas }, cells, templates, looks, artKinds, report }`. `C` is the
 * palette of shared/engine/colors.ts ([r, g, b] by name), `ROOT` the repository.
 */
export function furnitureArt({ C, ROOT }) {
	const MAT = materials(C);
	const K = inks(C);
	const planner = readPlanner(ROOT);
	const entries = [];
	const templates = {};
	const looks = {};
	const report = { generic: [], cells: 0 };
	const push = (key, img, shadow) => entries.push({ key, img, shadow });

	/** the planner sizes an art kind takes ([len, depth] in world units) */
	const sizesOf = art => {
		const base = KINDS[art]?.from ?? art;
		return [...(planner.sizes[base] ?? [])].map(s => s.split(",").map(Number));
	};
	// every art kind: the planner's own kinds (a new one painted by `generic`) and the ones picked by building type
	const artKinds = [...new Set([...planner.kinds, ...Object.keys(KINDS)])];
	for (const art of artKinds) {
		const spec = KINDS[art] ?? { draw: generic, looks: 1 };
		if (KINDS[art] === undefined) report.generic.push(art);
		const base = spec.from ?? art;
		const tall = spec.tall ?? planner.tall[base] ?? false;
		const shadow = tall ? 2 : 1;
		looks[art] = spec.looks;
		const sizes = sizesOf(art);
		const aisle = planner.aisles[base];
		// a computed-length kind: its template, long both ways (a column of gondolas or a row)
		if (aisle !== undefined) {
			sizes.push([TEMPLATE_LEN, aisle]);
			sizes.push([aisle, TEMPLATE_LEN]);
		}
		// the largest cell of each facing and look, both ways round: the template a piece of another size is cropped from
		const best = {};
		for (let look = 0; look < spec.looks; look++) {
			for (const [len, depth] of sizes) {
				const Lt = Math.max(1, Math.round(len / U));
				const Dt = Math.max(1, Math.round(depth / U));
				const r0 = hashStr(`${art}:${len}x${depth}:${look}`);
				let canon;
				if (spec.faceless) {
					canon = new Canvas(Lt, Dt);
					spec.draw(canon, Lt, Dt, look, rng(r0), K);
				}
				for (const face of FACES) {
					const across = face === "left" || face === "right";
					const w = across ? depth : len;
					const h = across ? len : depth;
					let world;
					if (spec.faceless) {
						// the same picture whichever way it faces: only its long axis follows the world
						world = across ? canon.transposed() : canon;
					} else {
						const cv = new Canvas(Lt, Dt);
						spec.draw(cv, Lt, Dt, look, rng(r0), K);
						world = orient(cv, face);
					}
					const key = `${art}:${w}x${h}:${face}:${look}`;
					push(key, shade(world, MAT, { shadow }), shadow);
					const o = w >= h ? "h" : "v";
					const tk = `${art}:${face}:${look}:${o}`;
					if (best[tk] === undefined || w * h > best[tk].area) best[tk] = { key, area: w * h };
				}
			}
		}
		for (const [tk, b] of Object.entries(best)) templates[tk] = b.key;
	}
	// the decoration: chairs by the side their table is on, chairs knocked over, papers, glass, mats, curtains, the
	// board and the rugs (flat on the floor: no shadow, no outline where the drawing says so)
	const deco = (key, L, D, draw, { face = "bottom", shadow = 0, outline = true, seed = 0 } = {}) => {
		const cv = new Canvas(L, D);
		draw(cv, L, D, rng(hashStr(key) + seed), K);
		push(key, shade(orient(cv, face), MAT, { shadow, outline }), shadow);
	};
	for (const face of FACES) {
		deco(`chair:${face}`, 7, 7, cv => chair(cv), { face, shadow: 1 });
		deco(`chairDown:${FACES.indexOf(face)}`, 7, 7, cv => chairDown(cv), { face, shadow: 1 });
	}
	for (let k = 0; k < 3; k++) deco(`papers:${k}`, 11, 9, (cv, L, D, r) => papers(cv, L, D, r, K), { outline: false });
	deco("glass:h", 15, 7, (cv, L, D, r) => glassShards(cv, L, D, r, K), { outline: false });
	deco("glass:v", 7, 15, (cv, L, D, r) => glassShards(cv, L, D, r, K), { outline: false, seed: 7 });
	deco("mat:h", 14, 9, (cv, L, D, r) => bathMat(cv, L, D, r));
	deco("mat:v", 14, 9, (cv, L, D, r) => bathMat(cv, L, D, r), { face: "left" });
	deco("curtain:h", 30, 2, cv => curtain(cv, 30), { shadow: 1, outline: false });
	deco("curtain:v", 30, 2, cv => curtain(cv, 30), { face: "left", shadow: 1, outline: false });
	// a board on a wall faces the room: one cell per side the room is on (the wall's edge away from it)
	for (const face of FACES) {
		deco(`board:${face}`, 46, 3, (cv, L, D, r) => board(cv, 46, r), { face, outline: false });
		deco(`notice:${face}`, 26, 3, (cv, L, D, r) => notice(cv, 26, r), { face, outline: false });
	}
	const RUGS = ["rugRed", "rugBlue", "rugCream"];
	RUGS.forEach((colour, i) => {
		deco(`rug:${i}:h`, 40, 28, cv => rug(cv, 40, 28, colour), { outline: false });
		deco(`rug:${i}:v`, 28, 40, cv => rug(cv, 28, 40, colour), { outline: false });
	});
	// the openings: an outside door (112 u, walls of 20), the frame of an inside doorway (any width, cropped from a
	// long one), a window with its outside to each side
	deco("door:h", 32, 5, cv => doorway(cv, 32, 5, true), { outline: false });
	deco("door:v", 32, 5, cv => doorway(cv, 32, 5, true), { face: "left", outline: false });
	const OL = Math.round(OPENING_LEN / U) + 4;
	deco("inner:h", OL, 4, cv => doorway(cv, OL, 4, false), { outline: false });
	deco("inner:v", OL, 4, cv => doorway(cv, OL, 4, false), { face: "left", outline: false });
	for (const side of FACES)
		deco(`window:${side}`, 24, 5, (cv, L, D, r) => windowFrame(cv, L, D, r, K), { face: side, outline: false });
	// ...and the same window with its glass in (EDI-18: a window is intact or broken; interiorArt draws it as it is now)
	for (const side of FACES)
		deco(`windowGlass:${side}`, 24, 5, (cv, L, D, r) => windowGlass(cv, L, D, r, K), {
			face: side,
			outline: false,
		});
	const packed = pack(entries);
	report.cells = entries.length;
	report.unique = packed.unique;
	return {
		atlas: { w: packed.w, h: packed.h, toCanvas: () => ({ w: packed.w, h: packed.h, data: packed.data }) },
		cells: packed.cells,
		templates,
		looks,
		artKinds: ART_KIND_BY_TYPE,
		rugs: RUGS.length,
		report,
	};
}

/**
 * docs/art/furniture-sheet.png: every art kind's largest cell facing the room below, in every look, then the
 * decoration and the frames, magnified 4x (a texel as big as at zoom 1) on the wood and the shop floor, labelled.
 */
export function furnitureSheet(art, drawText) {
	const Z = 4;
	const canvas = art.atlas.toCanvas();
	const best = {};
	const rest = [];
	for (const k of Object.keys(art.cells)) {
		const [a, size, face, look] = k.split(":");
		if (size === undefined || !size.includes("x")) {
			rest.push(k);
			continue;
		}
		if (face !== "bottom") continue;
		const [w, h] = size.split("x").map(Number);
		if (w > 360 || h > 360) continue;
		const id = `${a}:${look}`;
		if (best[id] === undefined || w * h > best[id].area) best[id] = { k, area: w * h };
	}
	const pick = [
		...Object.values(best)
			.map(b => b.k)
			.sort(),
		...rest.filter(k => !k.startsWith("inner")),
	];
	const W = 1600;
	const places = [];
	let x = 8;
	let y = 8;
	let rowH = 0;
	for (const k of pick) {
		const c = art.cells[k];
		const w = Math.max(c[2] * Z, 72);
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
	const floors = [
		[140, 110, 76],
		[150, 146, 136],
	];
	for (let i = 0; i < W * H; i++) {
		const f = floors[(Math.floor((i % W) / (Z * 8)) + Math.floor(Math.floor(i / W) / (Z * 8))) % 2];
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
		const label = p.k.replace(":bottom", "");
		drawText(img, label.slice(0, Math.floor(p.w / 6)), p.x, p.y + 3, 1, [250, 250, 250]);
	}
	return img;
}

/** src/client/view/furnitureAtlas.ts: the cells, the templates, the looks and the art kinds by building type */
export function furnitureAtlasModule(art, name) {
	const L = [];
	L.push("// generated by tools/gen-world-art.mjs (tools/furniture-art.mjs) — do not edit");
	L.push(
		`// the interiors' atlas: design/world-art/${name}.png; its asset id is WORLD_ART.${name} in worldArtAssets.ts (upload-art)`,
	);
	L.push("");
	L.push("/** the atlas's size in texels (one texel = 4 world units) */");
	L.push(`export const FURNITURE_ATLAS_W = ${art.atlas.w};`);
	L.push(`export const FURNITURE_ATLAS_H = ${art.atlas.h};`);
	L.push("");
	L.push("/** how many looks each art kind has (`Solid.variant` modulo this) */");
	L.push("export const FURNITURE_LOOKS: Record<string, number> = {");
	for (const [k, n] of Object.entries(art.looks).sort()) L.push(`\t${k}: ${n},`);
	L.push("};");
	L.push("");
	L.push(
		"/** the art kind a planner kind takes in a building of a type (shared/game/world.ts types); else its own */",
	);
	L.push("export const FURNITURE_ART_KIND: Record<string, Record<number, string>> = {");
	for (const [k, m] of Object.entries(art.artKinds)) {
		L.push(
			`\t${k}: { ${Object.entries(m)
				.map(([t, a]) => `[${t}]: "${a}"`)
				.join(", ")} },`,
		);
	}
	L.push("};");
	L.push("");
	L.push(`/** how many rug colours there are ("rug:<n>:h" / "rug:<n>:v") */`);
	L.push(`export const RUG_COLOURS = ${art.rugs};`);
	L.push("");
	L.push("/**");
	L.push(
		" * Every cell: [x, y, w, h, shadow] in texels, w and h with the `shadow` texels of baked shadow on the right and",
	);
	L.push(
		' * bottom. Furniture: "<art kind>:<w>x<h>:<face>:<look>" (w, h the piece in world units). Decoration and openings:',
	);
	L.push(
		' * "chair:<side of its table>", "chairDown:<n>", "papers:<n>", "glass:h", "mat:v", "curtain:h", "board:h", "rug:<n>:h",',
	);
	L.push(' * "door:h", "inner:v" (cropped to the width), "window:<the side it looks out of>" (its glass broken) and');
	L.push(' * "windowGlass:<side>" (its glass in, EDI-18).');
	L.push(" */");
	L.push("export const FURNITURE_CELLS: Record<string, readonly [number, number, number, number, number]> = {");
	for (const [k, c] of Object.entries(art.cells)) L.push(`\t"${k}": [${c.join(", ")}],`);
	L.push("};");
	L.push("");
	L.push(
		'/** "<art kind>:<face>:<look>:<h|v>" -> the key of its largest cell, cropped for a piece of a size not in the atlas */',
	);
	L.push("export const FURNITURE_TEMPLATES: Record<string, string> = {");
	for (const [k, v] of Object.entries(art.templates)) L.push(`\t"${k}": "${v}",`);
	L.push("};");
	L.push("");
	return L.join("\n");
}
