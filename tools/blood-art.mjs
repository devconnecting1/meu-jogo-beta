/*
 * Project Z combat blood (docs/DESIGN_RULES.md ART-15, LEG-02): the pixel art a fight leaves on the floor, baked into
 * ONE atlas (design/world-art/blood.png) that client/view/bloodView.ts draws a cell of per stain (ImageRectOffset /
 * ImageRectSize, Pixelated). Written by tools/gen-world-art.mjs with the rest of the town (`npm run art:world`) and
 * uploaded with it (`upload-art`, the CI's `assets` job); until the atlas has an id -- or while the uploaded one is not
 * this PNG (its sha1, like the other atlases) -- the blood is drawn by the flat circles of before (ART-01).
 *
 *   import { bloodArt, bloodAtlasModule, bloodSheet } from "./blood-art.mjs";
 *   const art = bloodArt({ C });   // { atlas, cells, bandH, groups }
 *
 * WHAT IS IN IT. Three kinds of stain, each in a few shapes and turned every way it can lie:
 *   drop   where a droplet of a spray landed: a 2 x 2 or 3 x 2 bead with a satellite or two (4 shapes x 4 flips);
 *   splat  a body's blood where it fell (a kill, a big bite): an irregular core with satellites and two short
 *          spines (3 shapes x 4 flips);
 *   smear  the spatter behind a hit, from the attacker to the target: an impact bead and droplets thrown ALONG the
 *          hit, longer near the bead and smaller further out, in a narrow cone (2 shapes x 8 directions, 45° apart:
 *          the straight one turned and flipped four ways, a diagonal one flipped four ways).
 * No chunk, no gib, no organ: droplets and splats only (Roblox's maturity questionnaire: pixelated blood is
 * "unrealistic", docs/CREATOR_HUB.md). No outline either: a stain lies IN the floor, so its edge is only its own
 * blood a little thinner or darker, never a ring of another colour (a halo would lift it off the wood or the tiles).
 *
 * THE LIGHT never turns with the stain (like the furniture's, ART-12): each shape is flipped or turned as a MASK
 * first and shaded after, so the lit edge is always its top left and the gloss sits up there too.
 *
 * THREE BANDS, the same cells in each, one under the other (BLOOD_BAND_H apart):
 *   0 matte  greyscale, tinted at runtime (ImageColor3) along the drying: fresh red, then darker, then the brown of a
 *            game day old, darker and less red on asphalt and grass (client/view/bloodView.ts); the edge a shade
 *            darker all round, the way a stain dries from its rim;
 *   1 wet    a survivor's fresh blood in its own colours (COLORS.blood): lit top-left edge, shaded bottom-right edge,
 *            and a pale gloss texel on every bead of 4 texels or more -- the few seconds blood is still liquid;
 *   2 wet    the horde's (COLORS.bloodHorde), the same way.
 * Scale: 4 world units per texel (ART-02), the town's; a drop is 8-12 u, a splat ~44 u, a smear ~56 u long.
 */

/** world units per texel */
const U = 4;
/** transparent texels right of and below every cell */
const GUTTER = 1;
/** the width the cells of a band are shelved in */
const BAND_W = 96;

const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];
/** what a wet bead reflects: a pale warm light, never white (a white fleck would read as an item's glint, LEG-01) */
const SHEEN = [255, 206, 196];

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

// ---------------------------------------------------------------- masks

/** a stain's coverage, w x h texels, with the point (ax, ay) -- in texels, fractional -- where the hit was */
class Mask {
	constructor(w, h, ax = w / 2, ay = h / 2) {
		this.w = w;
		this.h = h;
		this.ax = ax;
		this.ay = ay;
		this.m = new Uint8Array(w * h);
	}
	has(x, y) {
		return x >= 0 && y >= 0 && x < this.w && y < this.h && this.m[y * this.w + x] === 1;
	}
	set(x, y) {
		x = Math.floor(x);
		y = Math.floor(y);
		if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.m[y * this.w + x] = 1;
	}
	count() {
		let n = 0;
		for (const v of this.m) n += v;
		return n;
	}
	static rows(rows, ax, ay) {
		const k = new Mask(rows[0].length, rows.length, ax, ay);
		rows.forEach((row, y) => [...row].forEach((ch, x) => ch === "#" && k.set(x, y)));
		return k;
	}
}

/** the mask flipped / turned: fx mirrors x, fy mirrors y, t swaps x and y (a quarter turn with a mirror) */
function transform(src, { fx = false, fy = false, t = false } = {}) {
	let w = src.w;
	let h = src.h;
	let ax = src.ax;
	let ay = src.ay;
	let cells = [];
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (src.has(x, y)) cells.push([x, y]);
	if (t) {
		cells = cells.map(([x, y]) => [y, x]);
		[w, h] = [h, w];
		[ax, ay] = [ay, ax];
	}
	if (fx) {
		cells = cells.map(([x, y]) => [w - 1 - x, y]);
		ax = w - ax;
	}
	if (fy) {
		cells = cells.map(([x, y]) => [x, h - 1 - y]);
		ay = h - ay;
	}
	const out = new Mask(w, h, ax, ay);
	for (const [x, y] of cells) out.set(x, y);
	return out;
}

/** smooth value noise over a w x h mask, lattice every `cell` texels, in [-1, 1] */
function lowNoise(w, h, cell, r) {
	const gw = Math.ceil(w / cell) + 2;
	const gh = Math.ceil(h / cell) + 2;
	const lat = Array.from({ length: gw * gh }, () => r() * 2 - 1);
	const s = t => t * t * (3 - 2 * t);
	return (x, y) => {
		const fx = x / cell;
		const fy = y / cell;
		const i = Math.floor(fx);
		const j = Math.floor(fy);
		const u = s(fx - i);
		const v = s(fy - j);
		const at = (a, b) => lat[b * gw + a];
		const top = at(i, j) + (at(i + 1, j) - at(i, j)) * u;
		const bot = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * u;
		return top + (bot - top) * v;
	};
}

// ---------------------------------------------------------------- the shapes (base orientation)

/** where a droplet of a spray landed: hand-placed, every texel on purpose */
const DROPS = [
	["......", ".##...", ".###..", "..#...", "....#.", "......"],
	["......", "..#...", ".##.#.", ".##...", "......", "...#.."],
	["......", "......", ".###..", ".####.", "..##..", "#....."],
	["......", ".#....", "......", "..##..", "..#..#", "......"],
];

/** true when no texel of the 3 x 3 block round (x, y) is set: a new droplet there stays a droplet */
function clear(k, x, y) {
	x = Math.floor(x);
	y = Math.floor(y);
	for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (k.has(x + i, y + j)) return false;
	return x >= 0 && y >= 0 && x < k.w && y < k.h;
}

/**
 * A body's blood where it fell: a lumpy core (a round middle and two lobes, never a regular disc), a few satellite
 * droplets round it, some two texels long and pointing away, and now and then a short run joining one to the core.
 */
function splat(seed) {
	const r = rng(seed);
	const n = 14;
	const c = n / 2;
	const k = new Mask(n, n);
	const noise = lowNoise(n, n, 3, r);
	const R = 2.5 + r() * 0.4;
	const lobes = [0, 1].map(() => {
		const a = r() * Math.PI * 2;
		const off = 1.6 + r() * 0.7;
		return { x: c + Math.cos(a) * off, y: c + Math.sin(a) * off, r: 1.3 + r() * 0.5 };
	});
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const px = x + 0.5;
			const py = y + 0.5;
			let d = Math.hypot(px - c, py - c) / R;
			for (const l of lobes) d = Math.min(d, Math.hypot(px - l.x, py - l.y) / l.r);
			if (d + noise(x, y) * 0.18 < 1) k.set(x, y);
		}
	}
	const sats = 5 + Math.floor(r() * 3);
	const run = Math.floor(r() * sats);
	for (let i = 0; i < sats; i++) {
		const a = (i / sats) * Math.PI * 2 + (r() - 0.5) * 0.9;
		const dist = 4.6 + r() * 1.6;
		const ux = Math.cos(a);
		const uy = Math.sin(a);
		const sx = c + ux * dist;
		const sy = c + uy * dist;
		if (!clear(k, sx, sy)) continue;
		k.set(sx, sy);
		// an elongated drop points away from the core
		if (r() < 0.5) k.set(sx + ux, sy + uy);
		if (i === run && r() < 0.7) for (let t = R + 0.6; t < dist - 0.6; t += 0.5) k.set(c + ux * t, c + uy * t);
	}
	return k;
}

/**
 * The spatter behind a hit, thrown along +x: an egg-shaped impact bead at (3, 4.5) leaning the way the blood went,
 * then droplets in a cone that widens with distance, each clear of the others -- two texels long near the bead
 * (they flew fast and streaked), single further out.
 */
function smearStraight(seed) {
	const r = rng(seed);
	const k = new Mask(16, 9, 3, 4.5);
	const noise = lowNoise(16, 9, 2, r);
	for (let y = 0; y < 9; y++) {
		for (let x = 0; x < 8; x++) {
			const dx = x + 0.5 - 3;
			const dy = y + 0.5 - 4.5;
			// wider behind the middle than in front: the egg points along +x
			const d = Math.hypot(dx / (dx > 0 ? 2.6 : 1.9), dy / 1.7) + noise(x, y) * 0.2;
			if (d < 1) k.set(x, y);
		}
	}
	let placed = 0;
	for (let tries = 0; tries < 60 && placed < 7; tries++) {
		const t = 6.5 + r() * 9;
		const half = 0.6 + (t - 5) * 0.34;
		const y = 4.5 + (r() * 2 - 1) * half;
		const long = t < 10.5;
		if (!clear(k, t, y) || (long && !clear(k, t + 1, y))) continue;
		k.set(t, y);
		if (long) k.set(t + 1, y);
		placed++;
	}
	return k;
}

/** the same thrown along +x+y, on the diagonal: the bead at (3.5, 3.5), droplets stepping corner to corner */
function smearDiagonal(seed) {
	const r = rng(seed);
	const n = 13;
	const k = new Mask(n, n, 3.5, 3.5);
	const noise = lowNoise(n, n, 2, r);
	const S = Math.SQRT1_2;
	for (let y = 0; y < 8; y++) {
		for (let x = 0; x < 8; x++) {
			const dx = x + 0.5 - 3.5;
			const dy = y + 0.5 - 3.5;
			const along = (dx + dy) * S;
			const across = (dy - dx) * S;
			const d = Math.hypot(along / (along > 0 ? 2.6 : 1.9), across / 1.7) + noise(x, y) * 0.2;
			if (d < 1) k.set(x, y);
		}
	}
	let placed = 0;
	for (let tries = 0; tries < 60 && placed < 7; tries++) {
		const t = 5.4 + r() * 8.4;
		const half = 0.5 + (t - 4) * 0.32;
		const lat = (r() * 2 - 1) * half;
		const px = 3.5 + t * S - lat * S;
		const py = 3.5 + t * S + lat * S;
		const long = t < 9;
		if (!clear(k, px, py) || (long && !clear(k, px + 1, py + 1))) continue;
		k.set(px, py);
		if (long) k.set(px + 1, py + 1);
		placed++;
	}
	return k;
}

// ---------------------------------------------------------------- shading

/**
 * One cell of a band. Every texel's role comes from its four neighbours in the (already turned) mask: alone (a
 * droplet), on the bottom-right edge, on the top-left edge, or inside; a wet bead of 4+ texels gets one gloss texel
 * (two on the big ones) at its top left.
 */
function paint(mask, band, C) {
	const { w, h } = mask;
	const px = new Float32Array(w * h * 4);
	const put = (x, y, c, a) => {
		const i = (y * w + x) * 4;
		px[i] = c[0];
		px[i + 1] = c[1];
		px[i + 2] = c[2];
		px[i + 3] = a;
	};
	const gloss = new Set();
	if (band > 0) {
		// the beads (4-connected), each with its gloss
		const seen = new Uint8Array(w * h);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				if (!mask.has(x, y) || seen[y * w + x]) continue;
				const comp = [];
				const stack = [[x, y]];
				seen[y * w + x] = 1;
				while (stack.length > 0) {
					const [cx, cy] = stack.pop();
					comp.push([cx, cy]);
					for (const [nx, ny] of [
						[cx + 1, cy],
						[cx - 1, cy],
						[cx, cy + 1],
						[cx, cy - 1],
					]) {
						if (mask.has(nx, ny) && !seen[ny * w + nx]) {
							seen[ny * w + nx] = 1;
							stack.push([nx, ny]);
						}
					}
				}
				if (comp.length < 4) continue;
				const inside = ([cx, cy]) =>
					mask.has(cx - 1, cy) && mask.has(cx, cy - 1) && mask.has(cx + 1, cy) && mask.has(cx, cy + 1);
				const open = ([cx, cy]) => mask.has(cx + 1, cy) && mask.has(cx, cy + 1) && mask.has(cx + 1, cy + 1);
				const byCorner = (a, b) => a[0] + a[1] - (b[0] + b[1]) || a[1] - b[1];
				let pick = comp.filter(inside).sort(byCorner)[0] ?? comp.filter(open).sort(byCorner)[0];
				if (pick === undefined) continue;
				gloss.add(`${pick[0]},${pick[1]}`);
				if (comp.length >= 16 && mask.has(pick[0] + 1, pick[1]) && inside([pick[0] + 1, pick[1]])) {
					gloss.add(`${pick[0] + 1},${pick[1]}`);
				}
			}
		}
	}
	const base = band === 1 ? C.blood : band === 2 ? C.bloodHorde : WHITE;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (!mask.has(x, y)) continue;
			const L = mask.has(x - 1, y);
			const Up = mask.has(x, y - 1);
			const R = mask.has(x + 1, y);
			const D = mask.has(x, y + 1);
			const single = !L && !Up && !R && !D;
			if (band === 0) {
				// matte, for the tint: the core is the tint itself, the rim a shade darker all round (it dries first)
				const rim = !(L && Up && R && D);
				const v = single ? 214 : rim ? 196 : 255;
				put(x, y, [v, v, v], single ? 226 : rim ? 222 : 238);
				continue;
			}
			let c;
			let a = 238;
			if (gloss.has(`${x},${y}`)) {
				c = mix(base, SHEEN, 0.5);
				a = 246;
			} else if (single) {
				c = mix(base, BLACK, 0.05);
				a = 228;
			} else if (!R || !D) {
				c = mix(base, BLACK, 0.22);
			} else if (!L || !Up) {
				c = mix(base, WHITE, 0.08);
				a = 226;
			} else c = base;
			put(x, y, c, a);
		}
	}
	return { w, h, px };
}

// ---------------------------------------------------------------- the atlas

/** the four flips of a stain that has no direction */
const FLIPS = [{}, { fx: true }, { fy: true }, { fx: true, fy: true }];

/**
 * A smear's eight directions (sector s = s x 45°, 0 = +x, 2 = +y: screen down): the straight shape for the even
 * sectors, the diagonal one for the odd, each turned from its base so the spatter runs away from the attacker.
 */
const SECTORS = [
	{ diag: false, t: {} },
	{ diag: true, t: {} },
	{ diag: false, t: { t: true } },
	{ diag: true, t: { fx: true } },
	{ diag: false, t: { fx: true } },
	{ diag: true, t: { fx: true, fy: true } },
	{ diag: false, t: { t: true, fy: true } },
	{ diag: true, t: { fy: true } },
];

/** shelf-packs the cells of one band (x, y in texels inside the band) */
function shelve(masks) {
	let x = 0;
	let y = 0;
	let rowH = 0;
	const at = [];
	for (const m of masks) {
		if (x + m.w + GUTTER > BAND_W) {
			x = 0;
			y += rowH;
			rowH = 0;
		}
		at.push([x, y]);
		x += m.w + GUTTER;
		rowH = Math.max(rowH, m.h + GUTTER);
	}
	return { at, h: y + rowH };
}

/**
 * The atlas: every stain in every orientation, in index order (drops, splats, smears), shelved once and painted in
 * each of the three bands. `C` is the palette of shared/engine/colors.ts.
 */
export function bloodArt({ C }) {
	const masks = [];
	const groups = {};
	const group = (name, list) => {
		groups[name] = { first: masks.length, count: list.length };
		masks.push(...list);
	};
	const drops = DROPS.map(rows => Mask.rows(rows, 3, 3));
	group(
		"drop",
		drops.flatMap(m => FLIPS.map(f => transform(m, f))),
	);
	const splats = [211, 223, 239].map(splat);
	group(
		"splat",
		splats.flatMap(m => FLIPS.map(f => transform(m, f))),
	);
	const straight = [307, 331].map(smearStraight);
	const diagonal = [353, 379].map(smearDiagonal);
	const smears = [];
	for (const s of SECTORS) for (let v = 0; v < 2; v++) smears.push(transform((s.diag ? diagonal : straight)[v], s.t));
	group("smear", smears);
	const { at, h: bandH } = shelve(masks);
	const W = BAND_W;
	const H = bandH * 3;
	const data = Buffer.alloc(W * H * 4);
	const cells = [];
	masks.forEach((m, i) => {
		const [x0, y0] = at[i];
		cells.push([x0, y0, m.w, m.h, m.ax, m.ay]);
		for (let band = 0; band < 3; band++) {
			const p = paint(m, band, C);
			for (let y = 0; y < p.h; y++) {
				for (let x = 0; x < p.w; x++) {
					const si = (y * p.w + x) * 4;
					if (p.px[si + 3] <= 0) continue;
					const di = ((band * bandH + y0 + y) * W + x0 + x) * 4;
					for (let k = 0; k < 4; k++) data[di + k] = Math.max(0, Math.min(255, Math.round(p.px[si + k])));
				}
			}
		}
	});
	return {
		atlas: { w: W, h: H, toCanvas: () => ({ w: W, h: H, data }) },
		cells,
		bandH,
		groups,
		masks,
	};
}

/** src/client/view/bloodAtlas.ts: the cells and the three bands (the atlas's id is WORLD_ART.<name>) */
export function bloodAtlasModule(art, name) {
	const g = art.groups;
	const L = [];
	L.push("// generated by tools/gen-world-art.mjs (tools/blood-art.mjs) — do not edit");
	L.push(
		`// combat blood (DESIGN_RULES ART-15): design/world-art/${name}.png; its id is WORLD_ART.${name} (worldArtAssets.ts)`,
	);
	L.push("");
	L.push("/** the atlas's size in texels (one texel = 4 world units) */");
	L.push(`export const BLOOD_ATLAS_W = ${art.atlas.w};`);
	L.push(`export const BLOOD_ATLAS_H = ${art.atlas.h};`);
	L.push("");
	L.push("/**");
	L.push(
		" * The same cells three times, one band under the other: band 0 matte (greyscale, tinted as the stain dries),",
	);
	L.push(
		" * band 1 a survivor's wet blood, band 2 the horde's. A cell's wet copy is `BLOOD_BAND_H` (or twice it) lower.",
	);
	L.push(" */");
	L.push(`export const BLOOD_BAND_H = ${art.bandH};`);
	L.push("");
	L.push("/** drops (where a droplet landed): shape x 4 + flip */");
	L.push(`export const BLOOD_DROP_FIRST = ${g.drop.first};`);
	L.push(`export const BLOOD_DROPS = ${g.drop.count};`);
	L.push("/** splats (where a body bled: a kill, a big bite): shape x 4 + flip */");
	L.push(`export const BLOOD_SPLAT_FIRST = ${g.splat.first};`);
	L.push(`export const BLOOD_SPLATS = ${g.splat.count};`);
	L.push(
		"/** smears (the spatter behind a hit): first + sector x BLOOD_SMEAR_SHAPES + shape; sector 0 = +x, 2 = +y */",
	);
	L.push(`export const BLOOD_SMEAR_FIRST = ${g.smear.first};`);
	L.push("export const BLOOD_SMEAR_SHAPES = 2;");
	L.push("");
	L.push("/**");
	L.push(
		" * Every cell of band 0: [x, y, w, h, ax, ay] in texels -- its corner, its size, and the point of it (fractional)",
	);
	L.push(" * that lies on the hit: a drop's or a splat's middle, a smear's impact bead.");
	L.push(" */");
	L.push("export const BLOOD_CELLS: ReadonlyArray<readonly [number, number, number, number, number, number]> = [");
	for (const c of art.cells) L.push(`\t[${c.join(", ")}],`);
	L.push("];");
	L.push("");
	return L.join("\n");
}

/**
 * docs/art/blood-sheet.png: every cell magnified 6x on the floors it lands on (wood, tiles, carpet, sidewalk, asphalt,
 * grass), the wet bands as they are and the matte band tinted along the drying (fresh, a few minutes, a game day).
 */
export function bloodSheet(art, drawText, C) {
	const Z = 6;
	const canvas = art.atlas.toCanvas();
	const floors = [
		["wood", C.floorWood],
		["tiles", C.floorTile],
		["carpet", C.floorCarpet],
		["sidewalk", C.sidewalk],
		["asphalt", C.road],
		["grass", C.grass],
	];
	const stages = [
		["survivor, wet", 1, WHITE],
		["horde, wet", 2, WHITE],
		["survivor, drying", 0, mix(C.blood, C.bloodDry, 0.4)],
		["horde, drying", 0, mix(C.bloodHorde, C.bloodDry, 0.4)],
		["a game day old", 0, C.bloodDry],
	];
	const cellW = 18 * Z;
	const cols = art.cells.length;
	const W = 150 + cellW * Math.min(cols, 12) + 8;
	const rowsPerStage = Math.ceil(cols / 12);
	const rowH = 17 * Z;
	const H = 8 + stages.length * (rowsPerStage * rowH + 24) + 8;
	const img = { w: W, h: H, data: Buffer.alloc(W * H * 4) };
	for (let i = 0; i < W * H; i++) {
		img.data[i * 4] = 34;
		img.data[i * 4 + 1] = 34;
		img.data[i * 4 + 2] = 38;
		img.data[i * 4 + 3] = 255;
	}
	let y = 8;
	for (const [label, band, tint] of stages) {
		drawText(img, label, 8, y + 4, 1, [235, 235, 235]);
		for (let i = 0; i < cols; i++) {
			const [cx, cy, cw, ch] = art.cells[i];
			const col = i % 12;
			const row = Math.floor(i / 12);
			const X = 150 + col * cellW;
			const Y = y + 18 + row * rowH;
			const floor = floors[(i + band) % floors.length][1];
			for (let yy = 0; yy < 16 * Z; yy++) {
				for (let xx = 0; xx < cellW - 4; xx++) {
					const di = ((Y + yy) * W + X + xx) * 4;
					if (Y + yy >= H) continue;
					img.data[di] = floor[0];
					img.data[di + 1] = floor[1];
					img.data[di + 2] = floor[2];
				}
			}
			for (let yy = 0; yy < ch * Z; yy++) {
				for (let xx = 0; xx < cw * Z; xx++) {
					const si = ((band * art.bandH + cy + Math.floor(yy / Z)) * canvas.w + cx + Math.floor(xx / Z)) * 4;
					const a = canvas.data[si + 3] / 255;
					if (a <= 0) continue;
					const di = ((Y + yy + Z) * W + X + xx + Z) * 4;
					for (let k = 0; k < 3; k++) {
						const v = (canvas.data[si + k] * tint[k]) / 255;
						img.data[di + k] = Math.round(v * a + img.data[di + k] * (1 - a));
					}
				}
			}
		}
		y += 18 + rowsPerStage * rowH + 6;
	}
	return img;
}

export { U as BLOOD_TEXEL };
