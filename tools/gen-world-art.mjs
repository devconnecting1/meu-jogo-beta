#!/usr/bin/env node
/*
 * Last Town world art: the pixel-art textures and sprites of the town, generated procedurally into
 * design/world-art/ (PNG + manifest.json), and the client's index of them (src/client/view/worldArtAssets.ts).
 *
 *   npm run art:world                       # writes design/world-art/*.png, manifest.json, the contact sheet
 *                                           # and src/client/view/worldArtAssets.ts (ids from assets.json)
 *   node tools/gen-world-art.mjs --assets   # only rewrites worldArtAssets.ts from design/world-art/assets.json
 *
 * Art direction (docs/DESIGN_RULES.md §1, APO): a small generic North American town a FEW DAYS after the
 * outbreak. Grass still mowed (a few yards a bit long), clean concrete with joints and kerbs, dark asphalt with
 * grain and faded paint, cars that were parked last week (some broken into, a few burnt), bins and spilled
 * litter, dried blood near the wrecks. No decades-old ruin, no neon, no brand (CON-02), nothing drawn from Dead
 * Town (CON-01): every pixel below is computed from the palette of shared/engine/colors.ts.
 *
 * Scale: 1 texel = WORLD_TEXEL (4) world units, so a 200 x 100 car is 50 x 25 texels, a 36-unit bin 9 x 9, the
 * survivor (36 u) about 9 texels -- the chunky pixel of the reference art, at zoom 1 one texel is 4 x 4 px.
 *
 * Kinds of texture (manifest `kind`):
 *   tile     seamless, drawn with ScaleType.Tile, one tile = w x h texels x WORLD_TEXEL units, full colour
 *   tileTint seamless and GREYSCALE: the client tints it with ImageColor3 (a roof's colour identifies its
 *            building type, EDI-03, so the roof texture carries only the relief, never the hue)
 *   sprite   one object, ScaleType.Stretch (rotated by ImageLabel.Rotation when it has a heading), full colour
 *   mask     a greyscale silhouette tinted at runtime (a car's paint, VEI-04; a tree's foliage)
 *   overlay  RGBA shading / detail drawn over a mask (glass, lights, outline, highlights) -- untinted
 *   slice    9-slice (ScaleType.Slice): soft shadows and roof rims of any size
 *   sheet    the characters' sprite sheets (tools/character-art.mjs): one cell per pose and heading, laid out by
 *            src/client/view/charSheets.ts, full colour; their white Fill / Rim masks are `mask`s
 *   atlas    not town art: the item icons of src/shared/data/itemIcons.ts (tools/icon-atlas.mjs), one cell per
 *            icon (+ its dimmed copy) and glyph, listed in the manifest's `cells` / `dim` and in the generated
 *            src/client/ui/itemIconAtlas.ts; client/ui/itemIcon.ts draws an icon as one ImageLabel of its cell.
 *            Uploaded like the rest; its id is only written while it belongs to the PNG on disk (assets.json's
 *            sha1), because a stale atlas would show the wrong icons: until the new one is up, the Frames draw them.
 *            The interiors' atlas (`furniture`, tools/furniture-art.mjs) is one too: every piece of furniture, the
 *            floor decoration and the doorway and window frames, its cells in src/client/view/furnitureAtlas.ts
 *            (client/view/interiorArt.ts), under the same sha1 rule: a stale one would put a bed where a shelf is.
 *            So is the combat blood's (`blood`, tools/blood-art.mjs, ART-15): drops, splats and smears in three bands
 *            (matte for the tint, a survivor's wet red, the horde's), its cells in src/client/view/bloodAtlas.ts
 *            And the everyday town's fixtures' (`townProps`, tools/town-prop-art.mjs, ART-16): the market's stalls,
 *            tents, crates and carts, the street's lamps, hydrants and benches, the parks' and the backyards' things,
 *            the building site's, and the ground they stand on, its cells in src/client/view/townPropAtlas.ts
 *            And the buildings' doors (`entrances`, tools/entrance-art.mjs, ART-17): the ground outside each doorway,
 *            the leaves of its double door, its frame and the lintel over it, its cells in src/client/view/entranceAtlas.ts
 *            And the trees' (`trees`, tools/tree-art.mjs, VEG-06): every kind's crowns in their looks, greyscale (the
 *            tree's green tints them), their light in a second band, and the trunk; its cells in treeAtlas.ts
 *   ui       not town art either: the game's name, LAST TOWN, in the bold pixel font of tools/title-font.mjs (the one
 *            the store art's wordmark uses, docs/promo) -- the lobby's title and the splash (client/ui/logo.ts).
 *            GREYSCALE + alpha like the UI skin: three cells stacked top to bottom (the ink -- outline and hard
 *            shadow --, the fill of LAST, the fill of TOWN), each drawn by its own ImageLabel tinted with a theme
 *            token, so the colours stay the theme's (UI-01). Without an id the flat text wordmark draws instead.
 *
 * Light: the baked form shading (canopy highlights, car roofs, parapet rims) is lit from the top left, the
 * convention of top-down pixel art; what really moves with the sun (drop shadows, which roof slope is lit,
 * the kerb's shadow) is computed by client/view/worldView.ts every frame (LUZ-01).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { encodePNG } from "./png-lite.mjs";
import { drawText } from "./pixel-font.mjs";
import { characterArt } from "./character-art.mjs";
import { bossArt } from "./boss-art.mjs";
import { buildIconAtlas, loadIconData } from "./icon-atlas.mjs";
import { furnitureArt, furnitureAtlasModule, furnitureSheet } from "./furniture-art.mjs";
import { bloodArt, bloodAtlasModule, bloodSheet } from "./blood-art.mjs";
import { treeArt, treeAtlasModule, treeSheet } from "./tree-art.mjs";
import { townPropArt, townPropAtlasModule, townPropSheet } from "./town-prop-art.mjs";
import { entranceArt, entranceAtlasModule, entranceSheet, SHEET_STYLES } from "./entrance-art.mjs";
import { dilate, layoutText, TITLE_H } from "./title-font.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "design", "world-art");
const TS_OUT = join(ROOT, "src", "client", "view", "worldArtAssets.ts");
const ICON_TS_OUT = join(ROOT, "src", "client", "ui", "itemIconAtlas.ts");
const FURNITURE_TS_OUT = join(ROOT, "src", "client", "view", "furnitureAtlas.ts");
const FURNITURE_SHEET = join(ROOT, "docs", "art", "furniture-sheet.png");
const BLOOD_TS_OUT = join(ROOT, "src", "client", "view", "bloodAtlas.ts");
const BLOOD_SHEET = join(ROOT, "docs", "art", "blood-sheet.png");
const TREE_TS_OUT = join(ROOT, "src", "client", "view", "treeAtlas.ts");
const TREE_SHEET = join(ROOT, "docs", "art", "tree-sheet.png");
const TOWN_PROP_TS_OUT = join(ROOT, "src", "client", "view", "townPropAtlas.ts");
const TOWN_PROP_SHEET = join(ROOT, "docs", "art", "town-props-sheet.png");
const ENTRANCE_TS_OUT = join(ROOT, "src", "client", "view", "entranceAtlas.ts");
const ENTRANCE_SHEET = join(ROOT, "docs", "art", "entrances-sheet.png");
const SHEET = join(ROOT, "docs", "art", "world-art-sheet.png");
/** world units per texel */
const WORLD_TEXEL = 4;

// ---------------------------------------------------------------- the palette (shared/engine/colors.ts)

function readPalette() {
	const src = readFileSync(join(ROOT, "src", "shared", "engine", "colors.ts"), "utf8");
	const out = {};
	for (const m of src.matchAll(/(\w+): Color3\.fromRGB\((\d+), (\d+), (\d+)\)/g)) {
		out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
	}
	return out;
}
const C = readPalette();
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const add = (a, d) => [a[0] + d, a[1] + d, a[2] + d];
const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];
/** the ground colours worldView.ts derives from the palette (GROUND in worldView.ts) */
const G = {
	plaza: mix(C.sidewalk, WHITE, 0.1),
	walk: mix(C.sidewalk, WHITE, 0.16),
	apron: mix(C.sidewalk, C.road, 0.3),
	parking: mix(C.road, C.sidewalk, 0.14),
	playground: mix(C.dirtPath, WHITE, 0.25),
	ramp: mix(C.uiYellow, C.sidewalk, 0.35),
	pit: mix(C.treeTrunk, BLACK, 0.3),
};

// ---------------------------------------------------------------- texel canvas + noise

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

class Tex {
	constructor(w, h, wrap = false) {
		this.w = w;
		this.h = h;
		this.wrap = wrap;
		this.d = new Float32Array(w * h * 4);
	}
	idx(x, y) {
		if (this.wrap) {
			x = ((x % this.w) + this.w) % this.w;
			y = ((y % this.h) + this.h) % this.h;
		} else if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
		return (y * this.w + x) * 4;
	}
	set(x, y, c, a = 255) {
		const i = this.idx(Math.round(x), Math.round(y));
		if (i < 0) return;
		this.d[i] = c[0];
		this.d[i + 1] = c[1];
		this.d[i + 2] = c[2];
		this.d[i + 3] = a;
	}
	get(x, y) {
		const i = this.idx(x, y);
		if (i < 0) return [0, 0, 0, 0];
		return [this.d[i], this.d[i + 1], this.d[i + 2], this.d[i + 3]];
	}
	alpha(x, y) {
		const i = this.idx(x, y);
		return i < 0 ? 0 : this.d[i + 3];
	}
	/** paint `c` over the texel with opacity a (0..255), "source over" */
	over(x, y, c, a) {
		const i = this.idx(Math.round(x), Math.round(y));
		if (i < 0 || a <= 0) return;
		const sa = a / 255;
		const da = this.d[i + 3] / 255;
		const oa = sa + da * (1 - sa);
		for (let k = 0; k < 3; k++) {
			this.d[i + k] = oa > 0 ? (c[k] * sa + this.d[i + k] * da * (1 - sa)) / oa : 0;
		}
		this.d[i + 3] = oa * 255;
	}
	/** add `delta` to the colour of an opaque texel */
	shade(x, y, delta) {
		const i = this.idx(Math.round(x), Math.round(y));
		if (i < 0) return;
		for (let k = 0; k < 3; k++) this.d[i + k] += delta;
	}
	fill(c, a = 255) {
		for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.set(x, y, c, a);
	}
	rect(x0, y0, w, h, c, a = 255) {
		for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c, a);
	}
	toCanvas() {
		const data = Buffer.alloc(this.w * this.h * 4);
		for (let i = 0; i < this.w * this.h * 4; i++) data[i] = Math.max(0, Math.min(255, Math.round(this.d[i])));
		// fully transparent texels carry no colour (smaller files, no fringe when resampled)
		for (let i = 0; i < this.w * this.h; i++)
			if (data[i * 4 + 3] === 0) data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 0;
		return { w: this.w, h: this.h, data };
	}
}

/** seamless value noise over a size x size tile with `cells` lattice cells across, in [-1, 1] */
function noiseTile(size, cells, seed) {
	const r = rng(seed);
	const lat = new Float32Array(cells * cells).map(() => r() * 2 - 1);
	const out = new Float32Array(size * size);
	const at = (i, j) => lat[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)];
	const s = t => t * t * (3 - 2 * t);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const fx = (x / size) * cells;
			const fy = (y / size) * cells;
			const i = Math.floor(fx);
			const j = Math.floor(fy);
			const u = s(fx - i);
			const v = s(fy - j);
			const a = at(i, j) + (at(i + 1, j) - at(i, j)) * u;
			const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * u;
			out[y * size + x] = a + (b - a) * v;
		}
	}
	return out;
}

function fbm(size, octaves, seed) {
	const out = new Float32Array(size * size);
	let norm = 0;
	for (let o = 0; o < octaves.length; o++) {
		const [cells, amp] = octaves[o];
		const n = noiseTile(size, cells, seed + o * 101);
		for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
		norm += amp;
	}
	for (let i = 0; i < out.length; i++) out[i] /= norm;
	return out;
}

// ---------------------------------------------------------------- registry

const textures = [];

function add_(name, kind, tex, description, extra = {}) {
	textures.push({ name, kind, tex, description, ...extra });
}

// ================================================================ GROUND (tiles)

/** road asphalt: fine aggregate grain, soft darker tar blotches, a few hairline cracks; no big feature (it tiles) */
function asphalt(size, base, seed, { cracks = 3, light = 0.05, dark = 0.08, blotch = 5 } = {}) {
	const t = new Tex(size, size, true);
	const r = rng(seed);
	const low = fbm(
		size,
		[
			[4, 1],
			[8, 0.6],
			[16, 0.35],
		],
		seed,
	);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			let c = add(base, low[y * size + x] * blotch + (r() - 0.5) * 4);
			const roll = r();
			if (roll < light) c = add(mix(c, [c[0] + 4, c[1] + 4, c[2]], 1), 12 + r() * 9);
			else if (roll < light + dark) c = add(c, -(8 + r() * 6));
			t.set(x, y, c);
		}
	}
	for (let k = 0; k < cracks; k++) {
		let x = Math.floor(r() * size);
		let y = Math.floor(r() * size);
		const horizontal = r() < 0.5;
		const len = 5 + Math.floor(r() * 7);
		for (let s = 0; s < len; s++) {
			t.shade(x, y, -14);
			if (horizontal) {
				x += 1;
				if (r() < 0.35) y += r() < 0.5 ? -1 : 1;
			} else {
				y += 1;
				if (r() < 0.35) x += r() < 0.5 ? -1 : 1;
			}
		}
	}
	return t;
}

/** concrete slabs with 1-texel joints (slab x slab texels), a little variation per slab, speckles, one crack */
function slabs(size, slab, base, seed, { joint = -18, perSlab = 4, speckle = 0.07, cracks = 1 } = {}) {
	const t = new Tex(size, size, true);
	const r = rng(seed);
	const n = size / slab;
	const offs = [];
	for (let i = 0; i < n * n; i++) offs.push((r() - 0.5) * 2 * perSlab);
	const low = fbm(
		size,
		[
			[4, 1],
			[8, 0.5],
		],
		seed + 7,
	);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const s = Math.floor(y / slab) * n + Math.floor(x / slab);
			let c = add(base, offs[s] + low[y * size + x] * 3 + (r() - 0.5) * 3);
			const roll = r();
			if (roll < speckle / 2) c = add(c, 7 + r() * 5);
			else if (roll < speckle) c = add(c, -(6 + r() * 5));
			// joint on the slab's top and left edge; a lighter lip right after it (worn arris)
			if (x % slab === 0 || y % slab === 0) c = add(c, joint);
			else if (x % slab === 1 || y % slab === 1) c = add(c, 4);
			t.set(x, y, c);
		}
	}
	for (let k = 0; k < cracks; k++) {
		const sx = Math.floor(r() * n) * slab;
		const sy = Math.floor(r() * n) * slab;
		let x = sx + 2 + Math.floor(r() * (slab - 4));
		let y = sy + 1;
		while (y < sy + slab) {
			t.shade(x, y, -9);
			y += 1;
			if (r() < 0.45) x += r() < 0.5 ? -1 : 1;
			x = Math.max(sx + 1, Math.min(sx + slab - 1, x));
		}
	}
	return t;
}

/** running-bond pavers (bw x bh texels) for the footpaths from the doors */
function pavers(size, bw, bh, base, seed) {
	const t = new Tex(size, size, true);
	const r = rng(seed);
	for (let row = 0; row < size / bh; row++) {
		const shift = row % 2 === 0 ? 0 : bw / 2;
		for (let col = -1; col <= size / bw; col++) {
			const x0 = col * bw + shift;
			const tone = (r() - 0.5) * 12;
			const warm = (r() - 0.5) * 6;
			for (let y = row * bh; y < row * bh + bh; y++) {
				for (let x = x0; x < x0 + bw; x++) {
					let c = [base[0] + tone + warm, base[1] + tone, base[2] + tone - warm];
					c = add(c, (r() - 0.5) * 4);
					if (y === row * bh || x === x0) c = add(c, -20);
					else if (y === row * bh + 1 || x === x0 + 1) c = add(c, 5);
					t.set(x, y, c);
				}
			}
		}
	}
	return t;
}

/** mowed lawn: soft blotches, tiny "^" tufts on a jittered lattice (the woven look), sparse light blades */
function lawn(size, seed, { base, light, dark, tufts = 0.65, long = false }) {
	const t = new Tex(size, size, true);
	const r = rng(seed);
	const low = fbm(
		size,
		[
			[4, 1],
			[8, 0.7],
			[16, 0.4],
		],
		seed,
	);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const v = low[y * size + x];
			let c = v > 0 ? mix(base, light, v * (long ? 0.7 : 0.45)) : mix(base, dark, -v * (long ? 0.8 : 0.5));
			c = add(c, (r() - 0.5) * 4);
			t.set(x, y, c);
		}
	}
	const step = long ? 5 : 4;
	// the weave: a small "^" of blades per lattice cell, low contrast (the zombies walk on this: LEG-03)
	const tuftDark = mix(base, dark, long ? 0.75 : 0.6);
	const tuftLight = mix(base, light, long ? 0.9 : 0.75);
	for (let cy = 0; cy < size; cy += step) {
		for (let cx = 0; cx < size; cx += step) {
			if (r() > tufts) continue;
			const x = cx + Math.floor(r() * (step - 1));
			const y = cy + Math.floor(r() * (step - 1));
			if (long) {
				// a clump of long blades: a dry head over a dark root
				t.set(x, y, mix(tuftLight, [128, 132, 72], 0.18));
				t.set(x + 1, y - 1, tuftLight);
				t.set(x, y + 1, tuftDark);
				t.set(x + 1, y + 1, tuftDark);
			} else {
				t.set(x, y + 1, tuftDark);
				t.set(x + 1, y, tuftLight);
				t.set(x + 2, y + 1, tuftDark);
			}
		}
	}
	return t;
}

/** packed earth with pebbles (park paths, the school yard) */
function earth(size, base, seed) {
	const t = new Tex(size, size, true);
	const r = rng(seed);
	const low = fbm(
		size,
		[
			[4, 1],
			[8, 0.6],
			[16, 0.3],
		],
		seed,
	);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			let c = add(base, low[y * size + x] * 9 + (r() - 0.5) * 5);
			if (r() < 0.05) c = add(c, -10);
			t.set(x, y, c);
		}
	}
	for (let k = 0; k < size * size * 0.02; k++) {
		const x = Math.floor(r() * size);
		const y = Math.floor(r() * size);
		t.set(x, y, add(base, 22 + r() * 10));
		t.shade(x + 1, y + 1, -14);
	}
	return t;
}

/** bark mulch / soil in the downtown tree pits */
function mulch(size, base, seed) {
	const t = new Tex(size, size, true);
	const r = rng(seed);
	t.fill(base);
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) t.shade(x, y, (r() - 0.5) * 10);
	for (let k = 0; k < size * size * 0.25; k++) {
		const x = Math.floor(r() * size);
		const y = Math.floor(r() * size);
		const chip = r() < 0.5 ? add(base, 18 + r() * 12) : add(base, -12);
		t.set(x, y, chip);
		if (r() < 0.6) t.set(x + 1, y, chip);
	}
	return t;
}

/** tactile warning strip where a crosswalk lands: raised domes on the yellow ramp */
function tactile(base) {
	const t = new Tex(4, 4, true);
	t.fill(base);
	t.set(1, 1, add(base, 26));
	t.set(2, 1, add(base, 10));
	t.set(1, 2, add(base, 4));
	t.set(2, 2, add(base, -26));
	t.set(3, 3, add(base, -6));
	return t;
}

/** road paint: white, a little dirty, worn through in fine specks (tinted: white zebras, yellow line) */
function paint(size, seed) {
	const t = new Tex(size, size, true);
	const r = rng(seed);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const g = 236 + (r() - 0.5) * 14;
			const roll = r();
			// no big blotch: every bar and dash repeats this tile from its own corner, a feature would repeat too
			const a = roll < 0.08 ? 80 + r() * 60 : roll < 0.2 ? 200 : 255;
			t.set(x, y, [g, g, g], a);
		}
	}
	return t;
}

/**
 * Kerb stones along x for the NORTH kerb of a road (sidewalk above, asphalt below): an arris, the lit top, the
 * dark face, and the kerb's contact shadow on the asphalt (row 3, translucent). A joint every half tile. The
 * other three kerbs are this one flipped or turned (`flipY`, `transpose`), so the shadow is always road-side.
 */
function kerb(len, base, seed) {
	const t = new Tex(len, 4, true);
	const r = rng(seed);
	for (let x = 0; x < len; x++) {
		const tone = (r() - 0.5) * 5;
		t.set(x, 0, add(base, -10 + tone));
		t.set(x, 1, add(base, 22 + tone));
		t.set(x, 2, add(base, -18 + tone));
		t.set(x, 3, BLACK, 78);
	}
	for (const j of [0, len / 2]) {
		for (let y = 0; y < 3; y++) t.shade(j, y, -24);
	}
	return t;
}

/** mirrors a texture top to bottom */
function flipY(src) {
	const t = new Tex(src.w, src.h, src.wrap);
	for (let y = 0; y < src.h; y++) {
		for (let x = 0; x < src.w; x++) {
			const p = src.get(x, src.h - 1 - y);
			t.set(x, y, p, p[3]);
		}
	}
	return t;
}

/** transposes a texture (a horizontal kerb / fence / shingle course made vertical) */
function transpose(src) {
	const t = new Tex(src.h, src.w, src.wrap);
	for (let y = 0; y < src.h; y++) {
		for (let x = 0; x < src.w; x++) {
			const p = src.get(x, y);
			t.set(y, x, p, p[3]);
		}
	}
	return t;
}

/** the dense forest outside the town's fence: overlapping round crowns, lit from the top left */
function forest(size, base, seed) {
	const t = new Tex(size, size, true);
	const r = rng(seed);
	t.fill(mix(base, BLACK, 0.25));
	const crowns = [];
	for (let k = 0; k < 34; k++)
		crowns.push({ x: r() * size, y: r() * size, rad: 5 + r() * 5, tone: (r() - 0.5) * 14 });
	crowns.sort((a, b) => a.y - b.y);
	for (const c of crowns) {
		for (let dy = -Math.ceil(c.rad); dy <= Math.ceil(c.rad); dy++) {
			for (let dx = -Math.ceil(c.rad); dx <= Math.ceil(c.rad); dx++) {
				const d = Math.hypot(dx, dy);
				if (d > c.rad) continue;
				const lit = (-dx - dy) / (c.rad * 1.4);
				let col = add(base, c.tone + lit * 12);
				if (d > c.rad - 1) col = add(col, -10);
				t.set(Math.floor(c.x + dx), Math.floor(c.y + dy), col);
			}
		}
	}
	return t;
}

/** a board fence along x: planks with a post every half tile */
function fence(len, base, seed) {
	const t = new Tex(len, 2, true);
	const r = rng(seed);
	for (let x = 0; x < len; x++) {
		const tone = (r() - 0.5) * 8;
		t.set(x, 0, add(base, 12 + tone));
		t.set(x, 1, add(base, -8 + tone));
		if (x % 3 === 0) t.shade(x, 0, -10);
	}
	for (const p of [0, len / 2]) {
		t.set(p, 0, add(base, -26));
		t.set(p, 1, add(base, -34));
	}
	return t;
}

/**
 * Wooden floor: boards along x (3 texels + a seam), each its own tone, its lit edge and the seam's shadow, butt
 * joints staggered from board to board, and a grain streak along each board.
 */
function planks(size, base, seed) {
	const t = new Tex(size, size, true);
	const r = rng(seed);
	for (let b = 0; b < size / 4; b++) {
		const tone = (r() - 0.5) * 16;
		const cut = Math.floor(r() * size);
		const cut2 = (cut + size / 2) % size;
		const grainY = b * 4 + 1 + Math.floor(r() * 2);
		const g0 = Math.floor(r() * size);
		const gl = 6 + Math.floor(r() * 10);
		for (let y = b * 4; y < b * 4 + 4; y++) {
			for (let x = 0; x < size; x++) {
				let c = add(base, tone + (r() - 0.5) * 5);
				if (y === b * 4 + 3) c = add(c, -26);
				else if (y === b * 4) c = add(c, 6);
				if (y === grainY && (x - g0 + size) % size < gl) c = add(c, -7);
				if (x === cut || x === cut2) c = add(base, tone - 24);
				else if ((x === (cut + 1) % size || x === (cut2 + 1) % size) && y !== b * 4 + 3) c = add(c, 5);
				t.set(x, y, c);
			}
		}
	}
	return t;
}

/** carpet: a soft loop pile, a faint diagonal weave, no seams (it must tile invisibly) */
function carpet(size, base, seed) {
	const t = new Tex(size, size, true);
	const r = rng(seed);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const weave = (x + y) % 4 === 0 ? -5 : (x - y + size) % 4 === 2 ? 3 : 0;
			t.set(x, y, add(base, weave + (r() - 0.5) * 7));
		}
	}
	return t;
}

/**
 * Square floor tiles with grout; `checker` alternates two tones (a kitchen's, a hospital's). Tiles of 8 texels or
 * more are bevelled like the town's slabs -- a lit top and left edge, a shaded bottom and right one, light from the
 * top left (ART-02) -- and each one differs a little from its neighbours; `chips` flecks them (a shop's vinyl).
 */
function floorTiles(size, tile, base, seed, checker, { chips = 0 } = {}) {
	const t = new Tex(size, size, true);
	const r = rng(seed);
	const n = size / tile;
	const tones = [];
	for (let i = 0; i < n * n; i++) tones.push((r() - 0.5) * (checker ? 5 : 8));
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const tx = Math.floor(x / tile);
			const ty = Math.floor(y / tile);
			const odd = (tx + ty) % 2 === 1;
			let c = checker ? add(base, odd ? -12 : 8) : add(base, odd ? -3 : 2);
			c = add(c, tones[ty * n + tx] + (r() - 0.5) * 4);
			const u = x % tile;
			const v = y % tile;
			if (tile >= 8) {
				if (u === 1 || v === 1) c = add(c, 6);
				else if (u === tile - 1 || v === tile - 1) c = add(c, -6);
			}
			if (chips > 0 && r() < chips) c = add(c, r() < 0.5 ? 12 : -12);
			if (u === 0 || v === 0) c = add(base, -24);
			t.set(x, y, c);
		}
	}
	return t;
}

/**
 * An interior wall's outline and the shadow at its foot (ART-12), one 9-slice drawn round every wall: its centre is
 * the wall's own rect, opaque WHITE (tinted to the outline's colour, `imageTint`: the dark rect the plaster sits on,
 * showing a texel wide where the wall is free), and its three-texel border the shadow on the floor, dark at the
 * wall's foot and gone three texels out, the corners rounded (black: the tint leaves it black). One sprite a wall
 * where it was two (the outline was a Frame of its own): a building of many rooms costs what its walls cost.
 */
function wallShade() {
	const n = 7;
	const t = new Tex(n, n);
	const alpha = [1, 0.26, 0.14, 0.06];
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const k = Math.round(Math.hypot(x - 3, y - 3));
			if (k > 3) continue;
			t.set(x, y, k === 0 ? WHITE : BLACK, Math.round(255 * alpha[k]));
		}
	}
	return t;
}

// ================================================================ ROOFS (greyscale, tinted by the roof colour)

/**
 * Asphalt shingles, courses along x: each course (4 texels) starts with the shadow the course above casts on it,
 * then the tabs, whose slots are cut only in the lower half (the upper half is covered) -- that is what keeps a
 * shingle roof from reading as a brick wall. Tabs are 6 to 9 texels wide, each a slightly different grey.
 */
function shingles(size, seed) {
	const t = new Tex(size, size, true);
	const r = rng(seed);
	for (let course = 0; course < size / 4; course++) {
		const y0 = course * 4;
		for (let x = 0; x < size; x++) {
			t.set(x, y0, [212, 212, 212]);
			t.set(x, y0 + 1, [252, 252, 252]);
		}
		let x = Math.floor(r() * 8);
		const end = x + size;
		while (x < end) {
			const tab = 6 + Math.floor(r() * 4);
			const tone = 238 + r() * 14;
			for (let xx = x; xx < x + tab; xx++) {
				t.set(xx, y0 + 2, [tone, tone, tone]);
				t.set(xx, y0 + 3, [tone - 8, tone - 8, tone - 8]);
			}
			// the slot between two tabs, in the exposed lower half only
			t.set(x + tab, y0 + 2, [218, 218, 218]);
			t.set(x + tab, y0 + 3, [214, 214, 214]);
			x += tab + 1;
		}
	}
	return t;
}

/** tar and gravel of a flat commercial roof */
function gravel(size, seed) {
	const t = new Tex(size, size, true);
	const r = rng(seed);
	const low = fbm(
		size,
		[
			[4, 1],
			[8, 0.5],
		],
		seed,
	);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			let g = 240 + low[y * size + x] * 7 + (r() - 0.5) * 8;
			const roll = r();
			if (roll < 0.12) g -= 22 + r() * 10;
			else if (roll < 0.2) g = 255;
			t.set(x, y, [g, g, g]);
		}
	}
	return t;
}

/**
 * Single-ply membrane (school, hospital, gas station): long sheets side by side with faint welded seams, a few
 * darker water stains where the roof ponds. Low contrast on purpose: a strong grid read as a tiled floor.
 */
function membrane(size, sheet, seed) {
	const t = new Tex(size, size, true);
	const r = rng(seed);
	const low = fbm(
		size,
		[
			[4, 1],
			[8, 0.5],
		],
		seed,
	);
	const tones = [];
	for (let i = 0; i < size / sheet; i++) tones.push(244 + r() * 7);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			let g = tones[Math.floor(x / sheet)] + (r() - 0.5) * 3;
			// ponding: soft darker blotches
			const v = low[y * size + x];
			if (v < -0.3) g -= (-v - 0.3) * 22;
			if (x % sheet === 0) g = 252;
			else if (x % sheet === 1) g = 236;
			t.set(x, y, [g, g, g]);
		}
	}
	return t;
}

/** plaster for the thin interior-facing walls (tinted with the wall colour) */
function plaster(size, seed) {
	const t = new Tex(size, size, true);
	const r = rng(seed);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const g = 246 + (r() - 0.5) * 14;
			t.set(x, y, [g, g, g]);
		}
	}
	return t;
}

/**
 * 9-slice rims drawn over a roof (untinted: they only lighten and darken): `eaves` for a pitched roof (a dark
 * drip edge and a soft fascia band), `parapet` for a flat roof (the low wall around it, its lit coping and the
 * dark inner face).
 */
function roofRim(kind) {
	const n = 12;
	const t = new Tex(n, n);
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const d = Math.min(x, y, n - 1 - x, n - 1 - y);
			const topLeft = y <= x ? y <= n - 1 - x : x <= n - 1 - y;
			if (kind === "eaves") {
				if (d === 0) t.set(x, y, BLACK, 150);
				else if (d === 1) t.set(x, y, topLeft ? WHITE : BLACK, topLeft ? 46 : 60);
				else if (d === 2) t.set(x, y, BLACK, 26);
			} else {
				if (d === 0) t.set(x, y, BLACK, 170);
				else if (d === 1) t.set(x, y, WHITE, topLeft ? 110 : 60);
				else if (d === 2) t.set(x, y, WHITE, topLeft ? 50 : 20);
				else if (d === 3) t.set(x, y, BLACK, 70);
			}
		}
	}
	return t;
}

// ================================================================ SHADOWS

/** a soft rectangular shadow: black, opaque core, 6-texel smooth falloff (drawn at ~30 % opacity) */
function shadowBox() {
	const n = 16;
	const b = 6;
	const t = new Tex(n, n);
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const dx = Math.max(0, b - x - 0.5, x + 0.5 - (n - b));
			const dy = Math.max(0, b - y - 0.5, y + 0.5 - (n - b));
			const d = Math.min(1, Math.hypot(dx, dy) / b);
			const k = 1 - d * d * (3 - 2 * d);
			t.set(x, y, BLACK, 255 * k);
		}
	}
	return t;
}

// ================================================================ TREES

/**
 * The trees' kinds are DATA in src/shared/data/trees.ts (the generator and the drawing read the same table): like the
 * signs' module it imports nothing, so a bare transpile runs it here. Their art is tools/tree-art.mjs (one atlas).
 */
function loadTrees() {
	const ts = createRequire(import.meta.url)("typescript");
	const src = readFileSync(join(ROOT, "src", "shared", "data", "trees.ts"), "utf8");
	const js = ts.transpileModule(src, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	}).outputText;
	const exports = {};
	runInNewContext(js, { exports, module: { exports }, math: { floor: Math.floor } });
	return exports;
}

// ================================================================ CARS

/**
 * Four body styles on the same 50 x 25 footprint (the 200 x 100 collision box of every car). x runs from the
 * rear bumper (0) to the front bumper (49), y across from the driver's side (0) to the passenger side (24).
 * The body fills y 1..23; the tyres stick out one texel at y 0 and 24, the mirrors too.
 *   rearGlass / windshield: where the glass starts and ends along x; the roof is between them.
 *   greenhouse inset: the cabin is narrower than the body, so the side windows show from above.
 */
const CAR_STYLES = [
	{ name: "sedan", rearGlass: [11, 15], windshield: [30, 35], front: 36, wheels: [9, 38] },
	{ name: "hatch", rearGlass: [4, 8], windshield: [28, 33], front: 34, wheels: [8, 37] },
	{ name: "pickup", bed: [2, 20], rearGlass: [21, 22], windshield: [31, 36], front: 37, wheels: [9, 39] },
	{ name: "suv", rearGlass: [3, 6], windshield: [34, 38], front: 39, wheels: [9, 39], rails: true },
];
const CAR_L = 50;
const CAR_W = 25;
const TYRE = [30, 30, 32];
const TYRE_HI = [64, 64, 68];

/** the painted body: y 1..23 with rounded ends (radius 4 at the rear, 5 at the nose) */
function carBody(x, y) {
	if (x < 0 || x >= CAR_L || y < 1 || y > 23) return false;
	const r = x < CAR_L / 2 ? 4 : 5;
	const cx = x < CAR_L / 2 ? r - 0.5 : CAR_L - r - 0.5;
	const cy = y < 12 ? 1 + r - 0.5 : 23 - r + 0.5;
	const inX = x < CAR_L / 2 ? x < cx : x > cx;
	const inY = y < 12 ? y < cy : y > cy;
	if (inX && inY) return Math.hypot(x - cx, y - cy) <= r + 0.15;
	return true;
}

function carArt(style, seed) {
	const r = rng(seed);
	const [g0, g1] = style.rearGlass;
	const [w0, w1] = style.windshield;
	const mirror = w0 + 1;
	const inMask = (x, y) => carBody(x, y) || ((y === 0 || y === 24) && (x === mirror || x === mirror + 1));
	const mask = new Tex(CAR_L, CAR_W);
	for (let y = 0; y < CAR_W; y++) for (let x = 0; x < CAR_L; x++) if (inMask(x, y)) mask.set(x, y, WHITE);

	const trim = new Tex(CAR_L, CAR_W);
	const glass = C.carGlass;
	const glassHi = mix(glass, WHITE, 0.3);
	const glassLo = mix(glass, BLACK, 0.25);
	// tyres, one texel outside the body on both sides
	for (const wx of style.wheels) {
		for (let x = wx; x < wx + 5; x++) {
			trim.set(x, 0, x === wx || x === wx + 4 ? TYRE : TYRE_HI);
			trim.set(x, 24, TYRE);
		}
	}
	// body form, symmetric (any heading reads the same): darker shoulders, a lit spine
	for (let x = 0; x < CAR_L; x++) {
		for (let y = 1; y <= 23; y++) {
			if (!carBody(x, y)) continue;
			const edge = Math.min(y - 1, 23 - y);
			if (edge === 0) trim.set(x, y, BLACK, 70);
			else if (edge === 1) trim.set(x, y, BLACK, 34);
			else if (edge === 2) trim.set(x, y, BLACK, 12);
			else if (y >= 10 && y <= 14) trim.set(x, y, WHITE, 18);
		}
	}
	// the greenhouse: side windows, roof, windshield and rear glass (trapezoids narrowing towards the roof)
	const roofLo = 6;
	const roofHi = 18;
	for (let x = g0; x <= w1; x++) {
		for (const y of [4, 5, 19, 20]) trim.set(x, y, y === 4 || y === 20 ? glassLo : glass);
	}
	for (let x = g1 + 1; x < w0; x++) {
		trim.set(x, roofLo, BLACK, 60);
		trim.set(x, roofHi, BLACK, 60);
		for (let y = roofLo + 1; y < roofHi; y++) trim.set(x, y, WHITE, y <= roofLo + 3 ? 34 : 16);
	}
	if (style.rails) {
		for (let x = g1 + 2; x < w0 - 1; x++) {
			trim.set(x, roofLo + 2, [58, 58, 62]);
			trim.set(x, roofHi - 2, [58, 58, 62]);
		}
	}
	const pane = (xa, xb, wideAt, reflect) => {
		for (let x = xa; x <= xb; x++) {
			const k = (x - xa) / Math.max(1, xb - xa);
			const f = wideAt === "b" ? k : 1 - k;
			const lo = Math.round(roofLo - 2 * f);
			const hi = Math.round(roofHi + 2 * f);
			for (let y = lo; y <= hi; y++) {
				let c = y === lo || y === hi ? glassLo : glass;
				if (reflect && (x * 2 + y) % 9 < 2 && y > lo && y < hi) c = glassHi;
				trim.set(x, y, c);
			}
		}
	};
	pane(w0, w1, "b", true);
	pane(g0, g1, "a", true);
	// hood and trunk: panel lines, a lit crease
	for (let x = style.front; x < CAR_L - 2; x++) {
		trim.set(x, 8, BLACK, 26);
		trim.set(x, 16, BLACK, 26);
		trim.set(x, 12, WHITE, 26);
	}
	for (let y = 5; y <= 19; y++) {
		trim.set(style.front, y, BLACK, 40);
		if (style.bed === undefined && g0 > 3) trim.set(g0 - 1, y, BLACK, 30);
	}
	if (style.bed !== undefined) {
		// the load bed: ribbed floor between the bed rails (rows 1..3 and 21..23 stay paint)
		for (let x = style.bed[0]; x <= style.bed[1]; x++) {
			for (let y = 4; y <= 20; y++) trim.set(x, y, (y - 4) % 3 === 0 ? [54, 54, 58] : [72, 72, 76]);
			trim.set(x, 4, BLACK, 200);
		}
		for (let y = 4; y <= 20; y++) trim.set(style.bed[1], y, [44, 44, 48]);
	}
	// lights: headlights at the nose, tail lights at the back, dark bumpers between them
	for (const [y0, y1] of [
		[3, 6],
		[18, 21],
	]) {
		for (let y = y0; y <= y1; y++) {
			trim.set(CAR_L - 2, y, C.carLight);
			trim.set(CAR_L - 3, y, mix(C.carLight, BLACK, 0.15));
			trim.set(1, y, C.carTail);
			trim.set(2, y, mix(C.carTail, BLACK, 0.3));
		}
	}
	for (let y = 7; y <= 17; y++) {
		trim.set(CAR_L - 1, y, [40, 40, 44], 230);
		trim.set(0, y, [40, 40, 44], 230);
	}
	// mirrors, then the outline of the whole shape
	for (const y of [0, 24]) {
		trim.set(mirror, y, BLACK, 90);
		trim.set(mirror + 1, y, BLACK, 40);
	}
	const outlined = t => {
		for (let y = 0; y < CAR_W; y++) {
			for (let x = 0; x < CAR_L; x++) {
				if (!inMask(x, y)) continue;
				if (!inMask(x - 1, y) || !inMask(x + 1, y) || !inMask(x, y - 1) || !inMask(x, y + 1))
					t.over(x, y, BLACK, 150);
			}
		}
	};
	outlined(trim);

	// broken into: the windshield smashed into a web of cracks round a hole, the driver's window gone, scratches
	const damage = new Tex(CAR_L, CAR_W);
	const ix = Math.round((w0 + w1) / 2);
	const iy = 9 + Math.floor(r() * 5);
	for (let a = 0; a < 7; a++) {
		const ang = (a / 7) * Math.PI * 2 + r() * 0.5;
		for (let s = 1; s < 9; s++) {
			const x = Math.round(ix + Math.cos(ang) * s * 0.7);
			const y = Math.round(iy + Math.sin(ang) * s);
			if (x < w0 || x > w1 || y < roofLo - 1 || y > roofHi + 1) break;
			damage.set(x, y, [214, 222, 230], 200);
		}
	}
	damage.set(ix, iy, [14, 14, 16], 240);
	damage.set(ix + 1, iy, [14, 14, 16], 200);
	damage.set(ix, iy + 1, [14, 14, 16], 200);
	for (let x = w0 - 6; x <= w1 - 1; x++) {
		damage.set(x, 4, [16, 16, 18], 240);
		damage.set(x, 5, [24, 22, 22], 240);
		if (r() < 0.3) damage.set(x, 6, [200, 210, 220], 150);
	}
	for (let k = 0; k < 3; k++) {
		const x = 4 + Math.floor(r() * (CAR_L - 12));
		const y = r() < 0.5 ? 2 + Math.floor(r() * 2) : 21 + Math.floor(r() * 2);
		for (let s = 0; s < 4; s++) damage.set(x + s, y + (s > 1 ? 1 : 0), WHITE, 70);
	}

	// burnt out: no glass (the scorched cabin shows), soot, rust blooming through, tyres burnt down to the rims
	const wreck = new Tex(CAR_L, CAR_W);
	const soot = fbm(
		64,
		[
			[8, 1],
			[16, 0.6],
		],
		seed + 11,
	);
	for (let y = 0; y < CAR_W; y++) {
		for (let x = 0; x < CAR_L; x++) {
			if (!carBody(x, y)) continue;
			const v = soot[y * 64 + x];
			if (v > 0.2) wreck.set(x, y, [128, 66, 30], 160);
			else if (v < -0.25) wreck.set(x, y, [10, 10, 10], 160);
			else wreck.set(x, y, BLACK, 60);
		}
	}
	const scorched = (xa, xb) => {
		for (let x = xa; x <= xb; x++) {
			for (let y = roofLo - 1; y <= roofHi + 1; y++)
				wreck.set(x, y, (x + y) % 3 === 0 ? [58, 50, 42] : [26, 24, 22]);
		}
	};
	scorched(w0, w1);
	scorched(g0, g1);
	for (let x = g0; x <= w1; x++) for (const y of [4, 5, 19, 20]) wreck.set(x, y, [22, 20, 18]);
	for (const wx of style.wheels) {
		for (let x = wx; x < wx + 5; x++) {
			wreck.set(x, 0, [84, 78, 72]);
			wreck.set(x, 24, [70, 66, 62]);
		}
	}
	outlined(wreck);
	return { mask, trim, damage, wreck };
}

// ================================================================ STREET PROPS

/** a green wheelie bin seen from above: hinge bar and handle at the back, the lid with its grip at the front */
function wheelieBin() {
	const t = new Tex(9, 9);
	const body = C.trashBin;
	const lid = C.trashLid;
	t.rect(0, 0, 9, 9, mix(body, BLACK, 0.15));
	t.rect(1, 1, 7, 7, lid);
	t.rect(0, 0, 9, 1, mix(body, BLACK, 0.35));
	t.rect(1, 1, 7, 1, mix(lid, WHITE, 0.08));
	t.rect(1, 2, 7, 1, mix(lid, WHITE, 0.2));
	t.rect(2, 4, 5, 2, mix(lid, WHITE, 0.1));
	t.rect(7, 2, 1, 6, mix(lid, BLACK, 0.18));
	t.rect(3, 7, 3, 1, mix(body, BLACK, 0.45));
	t.set(0, 0, BLACK, 0);
	t.set(8, 0, BLACK, 0);
	t.set(0, 8, mix(body, BLACK, 0.4));
	t.set(8, 8, mix(body, BLACK, 0.4));
	return t;
}

/**
 * Litter spilled on the ground (flat decals, COL-02): loose paper, a torn bin bag, a flattened box. Only paper,
 * plastic and cardboard, in muted tones: nothing that could pass for loot -- no can, no bottle, no bandage white
 * blob (LEG-01: decoration never imitates what can be picked up).
 */
function litter(kind, seed) {
	const t = new Tex(12, 12);
	const r = rng(seed);
	const paper = [196, 192, 178];
	const sheet = (x, y, w, h) => {
		t.rect(x, y, w, h, add(paper, (r() - 0.5) * 14), 220);
		t.set(x + w - 1, y + h - 1, add(paper, -36), 220);
	};
	if (kind === 0) {
		sheet(1, 2, 3, 2);
		sheet(6, 1, 2, 3);
		sheet(4, 7, 3, 2);
		sheet(9, 8, 2, 2);
		// a crumpled wrapper and a scrap of cardboard
		t.set(8, 5, [120, 104, 88], 220);
		t.set(9, 5, [104, 90, 76], 220);
		t.rect(2, 9, 2, 1, [128, 100, 66], 220);
	} else if (kind === 1) {
		// a black bin bag torn open, its contents spread out of it
		const bag = [36, 36, 40];
		for (let y = 3; y < 9; y++)
			for (let x = 2; x < 9; x++) if (Math.hypot(x - 5.5, y - 5.8) < 3.4) t.set(x, y, bag);
		t.set(4, 4, [70, 70, 78]);
		t.set(5, 4, [58, 58, 66]);
		t.set(7, 6, [56, 56, 62]);
		t.set(6, 7, [20, 20, 22]);
		sheet(8, 8, 2, 2);
		t.set(9, 3, [128, 100, 66], 220);
		t.set(1, 9, add(paper, -20), 220);
		t.set(6, 10, [120, 92, 60], 220);
		t.set(10, 10, add(paper, -10), 220);
	} else {
		// a flattened cardboard box, its fold line, and a sheet that blew off it
		const card = [146, 114, 74];
		t.rect(1, 3, 7, 5, card, 230);
		t.rect(1, 5, 7, 1, mix(card, BLACK, 0.2), 230);
		t.rect(1, 3, 7, 1, mix(card, WHITE, 0.1), 230);
		t.set(7, 7, mix(card, BLACK, 0.3), 230);
		sheet(4, 9, 2, 2);
		sheet(9, 2, 2, 2);
	}
	return t;
}

/** dried blood: a dark red smear with drops (LEG-02 keeps red for blood) */
function bloodDry(seed) {
	const t = new Tex(16, 12);
	const r = rng(seed);
	const dark = mix(C.blood, BLACK, 0.35);
	const low = fbm(
		16,
		[
			[4, 1],
			[8, 0.5],
		],
		seed,
	);
	for (let y = 0; y < 12; y++) {
		for (let x = 0; x < 16; x++) {
			const d = Math.hypot((x - 6.5) / 5.2, (y - 6) / 3.4) + low[y * 16 + x] * 0.35;
			if (d < 0.75) t.set(x, y, mix(dark, BLACK, 0.2), 230);
			else if (d < 1) t.set(x, y, dark, 190);
		}
	}
	// the smear trails off to one side, and a few drops
	for (let x = 11; x < 16; x++) if (r() < 0.8) t.set(x, 6 + Math.round((r() - 0.5) * 2), dark, 160);
	for (let k = 0; k < 4; k++) t.set(Math.floor(r() * 16), Math.floor(r() * 12), dark, 200);
	return t;
}

/**
 * The rain's puddles (DESIGN_RULES LUZ-05, client/view/weatherView.ts `PUDDLE_ART`): standing water on the asphalt, on
 * the town's 4-u texel. The pool is three or four overlapping ellipses along its length, each a little higher or
 * lower, its shores stepping a texel in or out every few columns and broken by noise, so the edge steps irregularly,
 * texel by texel (a dip in old asphalt, never a pill). Four
 * tones: the dark water, the sky's reflection as lighter streaks across it, a 1-texel highlight rim on the light side
 * (the top and the left, where the town's light comes from, ART-02) and a 1-texel halo of wet, darker ground round it.
 * `lobe`: the main pool keeps to one end and a small pool lies off the other (-1: at the left, +1: at the right), a
 * texel of wet ground between them. Drawn along +x; `transposed()` turns it for a vertical road with the rim still on
 * the light side (a turn by 90° would put it on the right). The palette is colors.ts's own (`puddle`, `puddleSheen`).
 */
function puddle(w, h, seed, { lobe = 0 } = {}) {
	const t = new Tex(w, h);
	const size = Math.max(w, h);
	const n = fbm(
		size,
		[
			[4, 1],
			[9, 0.4],
		],
		seed,
	);
	const r = rng(seed);
	const water = new Uint8Array(w * h);
	const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? water[y * w + x] : 0);
	const mid = (h - 1) / 2;
	const half = (h - 2) / 2;
	// the main pool's stretch of the length (a lobed puddle leaves the rest to its small pool)
	const share = lobe ? 0.72 : 1;
	const x0 = lobe < 0 ? (w - 1) * (1 - share) + 0.5 : 0.5;
	const len = (w - 1) * share - 0.5;
	// a long pool is four of them, a short one three; the middle ones the deepest
	const k = len / h > 2.2 ? 4 : 3;
	const blobs = [];
	for (let i = 0; i < k; i++) {
		const end = i === 0 || i === k - 1;
		blobs.push({
			cx: 0,
			cy: mid + (r() - 0.5) * half * (end ? 0.8 : 0.35),
			rx: (len / k) * (end ? 0.8 : 0.9) * (0.92 + r() * 0.16),
			ry: half * (end ? 0.6 + r() * 0.3 : 0.84 + r() * 0.2),
		});
	}
	// the end ones reach the ends and no further (an ellipse cut by the picture's edge is a square end); the rest
	// spread evenly between them
	const first = x0 + blobs[0].rx;
	const last = x0 + len - blobs[k - 1].rx;
	blobs.forEach((b, i) => (b.cx = first + ((last - first) * i) / (k - 1)));
	for (let y = 1; y < h - 1; y++) {
		for (let x = 1; x < w - 1; x++) {
			const q = n[y * size + x] * 0.7;
			for (const b of blobs) {
				if (((x - b.cx) / b.rx) ** 2 + ((y - b.cy) / b.ry) ** 2 + q < 1) {
					water[y * w + x] = 1;
					break;
				}
			}
		}
	}
	// no lone texels and no one-texel necks: a water texel with fewer than 2 water neighbours dries, a dry one with 3+ fills
	const smooth = () => {
		for (let pass = 0; pass < 2; pass++) {
			const next = Uint8Array.from(water);
			for (let y = 1; y < h - 1; y++) {
				for (let x = 1; x < w - 1; x++) {
					const k = at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1);
					if (at(x, y) && k < 2) next[y * w + x] = 0;
					else if (!at(x, y) && k >= 3) next[y * w + x] = 1;
				}
			}
			water.set(next);
		}
	};
	// the shore steps: along the length, the top and the bottom edge each move a texel in or out every few columns,
	// on their own (the steps of a pixel-art puddle, not the curve of an ellipse)
	{
		let dt = 0;
		let db = 0;
		let runT = 0;
		let runB = 0;
		for (let x = 2; x < w - 2; x++) {
			if (runT <= 0) {
				dt = Math.max(-1, Math.min(1, dt + (r() < 0.5 ? -1 : 1)));
				runT = 2 + Math.floor(r() * 3);
			}
			if (runB <= 0) {
				db = Math.max(-1, Math.min(1, db + (r() < 0.5 ? -1 : 1)));
				runB = 2 + Math.floor(r() * 3);
			}
			runT--;
			runB--;
			let y0 = -1;
			let y1 = -1;
			for (let y = 1; y < h - 1; y++) {
				if (!water[y * w + x]) continue;
				if (y0 < 0) y0 = y;
				y1 = y;
			}
			// the thin ends are left as they are: they round the pool off
			if (y0 < 0 || y1 - y0 < 3) continue;
			const top = Math.max(1, y0 + dt);
			const bot = Math.min(h - 2, y1 + db);
			if (bot - top < 2) continue;
			for (let y = 1; y < h - 1; y++) water[y * w + x] = y >= top && y <= bot ? 1 : 0;
		}
	}
	smooth();
	if (lobe) {
		// the small pool, off the main one's end and a little to one side, a texel of wet ground apart
		const main = Uint8Array.from(water);
		const near = (x, y) => {
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) if (main[(y + dy) * w + x + dx]) return true;
			return false;
		};
		const sx = lobe > 0 ? (w - 1) * (share + (1 - share) * 0.45) : (w - 1) * (1 - share) * 0.55;
		const sy = mid + (r() < 0.5 ? -1 : 1) * half * 0.25;
		const srx = (w - 1) * (1 - share) * 0.42;
		const sry = half * 0.62;
		for (let y = 1; y < h - 1; y++) {
			for (let x = 1; x < w - 1; x++) {
				if (main[y * w + x] || near(x, y)) continue;
				if (((x - sx) / srx) ** 2 + ((y - sy) / sry) ** 2 + n[y * size + x] * 0.3 < 1) water[y * w + x] = 1;
			}
		}
	}
	// the top row of water in each column (the sky's streaks sit under it)
	const top = [];
	for (let x = 0; x < w; x++) {
		let y0 = -1;
		for (let y = 0; y < h && y0 < 0; y++) if (at(x, y)) y0 = y;
		top.push(y0);
	}
	const halo = mix(C.road, BLACK, 0.55);
	const dark = C.puddle;
	const band = mix(C.puddle, C.puddleSheen, 0.45);
	const rim = C.puddleSheen;
	// the sky in the water: a long streak in the first half, a shorter one further on and lower (a deep puddle only)
	const streak = (x, y) => {
		const a = Math.round(x0 + len * 0.18);
		const b = Math.round(x0 + len * 0.5);
		const c = Math.round(x0 + len * 0.58);
		const d = Math.round(x0 + len * 0.76);
		if (x >= a && x < b && y === top[x] + 2) return true;
		return x >= c && x < d && y === top[x] + 4 && h > 9;
	};
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (!at(x, y)) {
				// the wet ground: a texel touching the water (sides, not corners: a stepped ring)
				if (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1)) t.set(x, y, halo, 128);
				continue;
			}
			// the rim catches the light along the near shore and fades out along the far end and the lower left
			const up = !at(x, y - 1);
			const left = !at(x - 1, y);
			let c = dark;
			if ((up && x < x0 + len * 0.8) || (left && y <= mid)) c = rim;
			else if (up || left || (streak(x, y) && at(x, y + 1) && at(x + 1, y))) c = band;
			t.set(x, y, c, 236);
		}
	}
	return t;
}

/** `t` mirrored across its diagonal (x <-> y): a puddle for a vertical road, its lit rim still at the top and left */
function transposed(t) {
	const o = new Tex(t.h, t.w);
	for (let y = 0; y < t.h; y++) {
		for (let x = 0; x < t.w; x++) {
			const [r, g, b, a] = t.get(x, y);
			if (a > 0) o.set(y, x, [r, g, b], a);
		}
	}
	return o;
}

/**
 * A drop landing on a puddle: four texels round an empty one, the ring it leaves (weatherView `PUDDLE_DROPS`). A static
 * picture: the view moves it from spot to spot on a beat, and not at all with Reduce Motion.
 */
function puddleDrop() {
	const t = new Tex(3, 3);
	for (const [x, y] of [
		[1, 0],
		[0, 1],
		[2, 1],
		[1, 2],
	])
		t.set(x, y, C.puddleRipple, 210);
	return t;
}

/** motor oil soaked into the concrete or the asphalt */
function oilStain(seed) {
	const t = new Tex(16, 12);
	const low = fbm(
		16,
		[
			[4, 1],
			[8, 0.6],
		],
		seed,
	);
	for (let y = 0; y < 12; y++) {
		for (let x = 0; x < 16; x++) {
			const d = Math.hypot((x - 7.5) / 6.5, (y - 5.5) / 4.6) + low[y * 16 + x] * 0.45;
			if (d < 0.55) t.set(x, y, [14, 14, 18], 120);
			else if (d < 1) t.set(x, y, [18, 18, 22], 70);
		}
	}
	return t;
}

/** a longer crack in the asphalt, with a branch */
function crack(seed) {
	const t = new Tex(24, 8);
	const r = rng(seed);
	let y = 3 + Math.floor(r() * 2);
	for (let x = 0; x < 24; x++) {
		t.set(x, y, [12, 12, 14], 170);
		t.set(x, y - 1, WHITE, 18);
		if (r() < 0.4) y = Math.max(1, Math.min(6, y + (r() < 0.5 ? -1 : 1)));
		if (x === 10) {
			let by = y;
			for (let bx = x; bx < x + 6; bx++) {
				by += r() < 0.6 ? 1 : 0;
				if (by < 8) t.set(bx, by, [12, 12, 14], 130);
			}
		}
	}
	return t;
}

/** a cast-iron manhole cover */
function manhole() {
	const t = new Tex(8, 8);
	const iron = [60, 60, 64];
	for (let y = 0; y < 8; y++) {
		for (let x = 0; x < 8; x++) {
			const d = Math.hypot(x - 3.5, y - 3.5);
			if (d > 3.9) continue;
			if (d > 3.1) t.set(x, y, mix(iron, BLACK, 0.35));
			else t.set(x, y, (x + y) % 2 === 0 ? add(iron, 16) : iron);
		}
	}
	t.set(2, 1, add(iron, 34));
	t.set(1, 2, add(iron, 30));
	t.set(5, 6, mix(iron, BLACK, 0.3));
	t.set(6, 5, mix(iron, BLACK, 0.3));
	return t;
}

/** a storm drain grate at the kerb */
function drain() {
	const t = new Tex(8, 4);
	t.rect(0, 0, 8, 4, [96, 96, 100]);
	t.rect(1, 1, 6, 2, [22, 22, 24]);
	for (let x = 1; x < 7; x += 2) t.rect(x, 1, 1, 2, [74, 74, 78]);
	return t;
}

/**
 * A fuel dispenser (DESIGN_RULES EDI-16), standing UPRIGHT on its island like the storefront signs stand on their
 * parapets (ART-07): a pump is read by its side view, the one the station's own sign draws (shared/data/
 * buildingSigns.ts, EDI-03: the pumps look like the sign says) -- the white cabinet with the dark display (unlit: the
 * power went, ART-07) and the red stripe, the hose down its side to the holstered nozzle, the steel plinth. Seen from
 * straight above it would be a white box, which is what the forecourt looked like before. 9 x 12 texels (36 x 48 u)
 * and its baked shadow; drawn twice on each island, never rotated (client/view/worldView.ts `drawPump`).
 */
const PUMP_ROWS = [
	"kkkkkkk..",
	"kWWWWWkX.",
	"kWdddwk.X",
	"kWdgdwk.X",
	"kWdddwk.X",
	"kWWWWwk.X",
	"krrrrRk.X",
	"kWWWWwk.X",
	"kWWWWwkss",
	"kWWWWwk..",
	"kgggggk..",
	"kkkkkkk..",
];
function pump(palette) {
	return withShadow(machineSprite({ rows: PUMP_ROWS }, palette));
}

/**
 * A gas station's canopy roof (DESIGN_RULES EDI-16), 113 x 29 texels: exactly the canopy of shared/game/world.ts
 * (PUMP_CANOPY_L x PUMP_CANOPY_D = 452 x 116 u at 4 u a texel), one texture per side its street is on (`street`: "N",
 * "S", "W", "E"), because what is on it is placed by where the islands stand -- and every one is lit from the top left
 * (ART-02), so they are drawn, not flipped.
 *
 * What a real canopy shows from above: the fascia round its edge in the station's colours (the storefront sign's
 * charcoal, shared/data/buildingSigns.ts, with the red pinstripe of its pump: no text, no brand, CON-02) and the lit /
 * shaded faces the top-left light gives it; the standing-seam steel deck, one panel every 6 texels, each seam a lit
 * ridge and its shadow; the backs of the light fixtures in two rows over the lanes (their lenses are underneath:
 * unlit, the power went, ART-07); the drain over each column with the rain's dirt streaked along the panels towards it;
 * a roof hatch; and a few days of weather -- soft stains, grime along the gutter, leaves blown into its corners.
 *
 * `u` runs along the street (0..112), `v` from the street eave (0..28); the islands' middle is v = 11 and their
 * columns u = 27.75 and 85.25 (the canopy is symmetric in u: the far corner's station gets the same picture).
 */
const CANOPY_U = 113;
const CANOPY_V = 29;
function gasCanopy(street, palette, seed) {
	const along = street === "N" || street === "S";
	const W = along ? CANOPY_U : CANOPY_V;
	const H = along ? CANOPY_V : CANOPY_U;
	const t = new Tex(W, H);
	const r = rng(seed);
	// canopy space (u along the street, v from the eave) -> canvas
	const X = (u, v) => (street === "N" || street === "S" ? u : street === "W" ? v : W - 1 - v);
	const Y = (u, v) => (street === "N" ? v : street === "S" ? H - 1 - v : u);
	const put = (u, v, c, a = 255) => {
		if (u < 0 || v < 0 || u >= CANOPY_U || v >= CANOPY_V) return;
		t.over(X(u, v), Y(u, v), c, a);
	};
	/** the canvas top-left corner of a `du` x `dv` block whose canopy-space corner is (u, v): things with a light and a
	 * shadow are drawn in canvas space from there (their light is the canvas's top left on every side) */
	const corner = (u, v, du, dv) => [
		Math.min(X(u, v), X(u + du - 1, v + dv - 1)),
		Math.min(Y(u, v), Y(u + du - 1, v + dv - 1)),
	];
	const k = palette.k;
	const lit = palette.z;
	const body = palette.x;
	const shade = palette.X;
	const stripe = palette.r;
	const deck = mix(C.wallShop, WHITE, 0.32);
	// each standing-seam panel (6 texels wide, across the canopy) a slightly different sheet
	const panelTone = [];
	for (let i = 0; i < 24; i++) panelTone.push((r() - 0.5) * 9);
	const panelOf = u => Math.floor((u - 3) / 6);
	const deckNoise = fbm(
		128,
		[
			[8, 1],
			[32, 0.4],
		],
		seed,
	);
	// the ring: outline, the fascia's outer face (lit on the canvas's top and left, shaded on the bottom and right), the
	// red pinstripe, the fascia's body, and the gutter inside it (in the fascia's shadow on the top and left)
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const m = Math.min(x, y, W - 1 - x, H - 1 - y);
			const litSide = Math.min(x, y) <= Math.min(W - 1 - x, H - 1 - y);
			if (m === 0) t.set(x, y, k);
			else if (m === 1) t.set(x, y, litSide ? lit : shade);
			else if (m === 2) t.set(x, y, stripe);
			else if (m === 3) t.set(x, y, body);
			else {
				const n = deckNoise[(y % 128) * 128 + (x % 128)];
				const u = along ? x : y;
				// grime gathers towards the gutters: the deck darkens a little over its last few texels to the fascia
				const grime = Math.max(0, 3 - (m - 4)) / 3;
				let c = add(deck, n * 6 + (panelTone[panelOf(u)] ?? 0));
				c = mix(c, [120, 114, 100], 0.12 * grime);
				if (m === 4) c = litSide ? mix(c, BLACK, 0.24) : mix(c, BLACK, 0.08);
				t.set(x, y, c);
			}
		}
	}
	// standing seams across the deck, perpendicular to the street: a lit ridge, its shadow beside it
	const inDeck = (u, v) => u >= 5 && v >= 5 && u < CANOPY_U - 5 && v < CANOPY_V - 5;
	for (let u = 9; u < CANOPY_U - 5; u += 6) {
		for (let v = 5; v < CANOPY_V - 5; v++) {
			// the ridge's light faces the canvas's left (N/S) or top (W/E) in both cases: the next texel is its shade
			put(u, v, WHITE, 96);
			put(u + 1, v, BLACK, 58);
		}
	}
	// the drains' 4 x 4 texel blocks, centred on the columns (u 27.75 and 85.25, v 11: the islands' middle)
	const cols = [26, 83];
	const colV = 9;
	// the rain runs along the panels to the drain over each column: dirt streaked towards it, from both eaves
	for (const cu of cols) {
		for (let du = 0; du < 4; du++) {
			const len = 3 + Math.floor(r() * 5);
			for (let s = 1; s <= len; s++) {
				const a = Math.round(46 * (1 - s / (len + 1)));
				if (inDeck(cu + du, colV - s)) put(cu + du, colV - s, [70, 66, 58], a);
				if (inDeck(cu + du, colV + 3 + s)) put(cu + du, colV + 3 + s, [70, 66, 58], a);
			}
		}
		// the drain: a grate in a dark sump, its lip lit on the canvas's top left
		const [dx, dy] = corner(cu, colV, 4, 4);
		for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) t.over(dx + i, dy + j, [96, 98, 104], 255);
		for (let i = 1; i < 3; i++) for (let j = 1; j < 3; j++) t.over(dx + i, dy + j, [34, 34, 38], 255);
		for (let i = 0; i < 4; i++) {
			t.over(dx + i, dy, [150, 152, 158], 255);
			t.over(dx, dy + i, [150, 152, 158], 255);
		}
		t.over(dx + 1, dy + 1, [70, 72, 78], 255);
	}
	// the backs of the light fixtures, over the lanes: small boxes, their shadow down and right on the canvas
	const fixture = (u, v) => {
		// a 3 x 2 box along the street (2 x 3 on a canopy along y): its lit top edge, its body, its shadow
		const box = [150, 154, 162];
		const [x, y] = corner(u, v, 3, 2);
		const [w, h] = along ? [3, 2] : [2, 3];
		for (let i = 0; i < w; i++) {
			for (let j = 0; j < h; j++) t.over(x + i, y + j, i === 0 || j === 0 ? mix(box, WHITE, 0.35) : box, 255);
		}
		t.over(x + w - 1, y + h - 1, mix(box, BLACK, 0.25), 255);
		for (let i = 1; i <= w; i++) t.over(x + i, y + h, BLACK, 64);
		for (let j = 1; j <= h; j++) t.over(x + w, y + j, BLACK, 64);
	};
	for (let u = 12; u < CANOPY_U - 10; u += 12) {
		if (!cols.some(cu => Math.abs(u - cu - 1) < 4)) fixture(u, 5);
		if (!cols.some(cu => Math.abs(u + 6 - cu - 1) < 4) && u + 6 < CANOPY_U - 10) fixture(u + 6, 20);
	}
	// a roof hatch at one end of the deck, over the shop's lane: a lid lit on its top-left edges, its handle, its shadow
	{
		const lid = [150, 154, 160];
		const [x, y] = corner(101, 16, 5, 4);
		const [w, h] = along ? [5, 4] : [4, 5];
		for (let i = 0; i < w; i++) {
			for (let j = 0; j < h; j++) t.over(x + i, y + j, i === 0 || j === 0 ? mix(lid, WHITE, 0.3) : lid, 255);
		}
		for (let i = 1; i <= w; i++) t.over(x + i, y + h, BLACK, 70);
		for (let j = 1; j <= h; j++) t.over(x + w, y + j, BLACK, 70);
		t.over(x + Math.floor(w / 2), y + Math.floor(h / 2), [60, 62, 68], 255);
	}
	// a few days of weather: soft stains on the deck, grime along the gutter, leaves blown into the corners
	for (let i = 0; i < 7; i++) {
		const su = 8 + r() * (CANOPY_U - 16);
		const sv = 6 + r() * (CANOPY_V - 12);
		const rad = 1.2 + r() * 2.2;
		for (let du = -4; du <= 4; du++) {
			for (let dv = -4; dv <= 4; dv++) {
				const d = Math.hypot(du, dv * 1.4) / rad;
				const u = Math.round(su + du);
				const v = Math.round(sv + dv);
				if (d < 1 && inDeck(u, v)) put(u, v, [88, 84, 74], Math.round(34 * (1 - d * d)));
			}
		}
	}
	for (let u = 4; u < CANOPY_U - 4; u++) {
		if (r() < 0.5) put(u, CANOPY_V - 5, [96, 90, 78], 40);
		if (r() < 0.3) put(u, 4, [96, 90, 78], 28);
	}
	const leaf = [
		[128, 96, 52],
		[104, 110, 58],
		[150, 110, 60],
	];
	for (const [lu, lv] of [
		[5, 5],
		[CANOPY_U - 7, CANOPY_V - 6],
		[6, CANOPY_V - 6],
		[CANOPY_U - 6, 5],
	]) {
		for (let i = 0; i < 4; i++) {
			const u = lu + Math.floor(r() * 3);
			const v = lv + Math.floor(r() * 2);
			put(u, v, leaf[Math.floor(r() * leaf.length)]);
		}
	}
	return t;
}

// ================================================================ RIDEABLE VEHICLES (VEI-05)
//
// Seen from above with the nose to the right (+x), on exactly the footprint the game parks them on (VEHICLES length
// × width at 4 u a texel), and with their bars where the rider's hands go (client/view/survivorView.ts RIDE_GRIP_F,
// 17 u ahead of the centre). Full colour sprites from the palette's vehicle entries; the drop shadow is the game's
// (it moves with the sun, LUZ-01), so none is baked in.

/** a bicycle, 18 × 7 texels (72 × 28 u): thin tyres, the frame, the pedals across it, the saddle, the bars */
function bicycle() {
	const t = new Tex(18, 7);
	const tyre = C.tyre;
	const frame = C.bikeFrame;
	const metal = C.vehicleMetal;
	const hub = mix(tyre, WHITE, 0.35);
	t.rect(0, 3, 6, 1, tyre);
	t.set(3, 3, hub);
	t.rect(12, 3, 6, 1, tyre);
	t.set(15, 3, hub);
	t.rect(5, 3, 8, 1, frame);
	t.set(7, 3, mix(frame, WHITE, 0.35));
	t.set(11, 3, mix(frame, WHITE, 0.2));
	t.rect(8, 1, 1, 5, metal);
	t.set(8, 1, tyre);
	t.set(8, 5, tyre);
	t.rect(5, 2, 3, 3, C.vehicleSeat);
	t.set(5, 2, mix(C.vehicleSeat, WHITE, 0.2));
	t.rect(13, 0, 1, 7, metal);
	t.set(13, 0, tyre);
	t.set(13, 6, tyre);
	return t;
}

/** a motorcycle, 22 × 8 texels (88 × 32 u): fat tyres, the engine under the tank, the exhaust on its right, the lamp */
function motorcycle() {
	const t = new Tex(22, 8);
	const tyre = C.tyre;
	const paint = C.motoPaint;
	const metal = C.vehicleMetal;
	const seat = C.vehicleSeat;
	t.rect(0, 3, 7, 2, tyre);
	t.rect(1, 3, 5, 1, mix(tyre, WHITE, 0.12));
	t.rect(16, 3, 6, 2, tyre);
	t.rect(17, 3, 4, 1, mix(tyre, WHITE, 0.12));
	t.rect(8, 1, 4, 6, mix(metal, BLACK, 0.25));
	t.rect(9, 1, 2, 6, metal);
	t.rect(2, 6, 9, 1, metal);
	t.set(2, 6, mix(metal, BLACK, 0.4));
	t.rect(6, 2, 10, 4, paint);
	t.rect(11, 2, 4, 1, mix(paint, WHITE, 0.3));
	t.rect(6, 5, 10, 1, mix(paint, BLACK, 0.3));
	t.rect(4, 2, 6, 4, seat);
	t.rect(5, 2, 4, 1, mix(seat, WHITE, 0.15));
	t.rect(15, 0, 1, 8, C.weapon);
	t.set(15, 0, mix(metal, WHITE, 0.3));
	t.set(15, 7, mix(metal, WHITE, 0.3));
	t.rect(21, 3, 1, 2, C.carLight);
	return t;
}

/** drops a 1-texel shadow down and right of everything opaque in `t` (small props carry their own shadow) */
function withShadow(t) {
	const out = new Tex(t.w + 1, t.h + 1);
	for (let y = 0; y < t.h; y++) {
		for (let x = 0; x < t.w; x++) if (t.alpha(x, y) > 0) out.set(x + 1, y + 1, BLACK, 96);
	}
	for (let y = 0; y < t.h; y++) {
		for (let x = 0; x < t.w; x++) {
			const p = t.get(x, y);
			if (p[3] > 0) out.over(x, y, p, p[3]);
		}
	}
	return out;
}

/** a rooftop air-conditioning unit: casing, fan grille, slatted coil (its shadow baked in) */
function acUnit() {
	const t = new Tex(12, 10);
	const box = [178, 180, 186];
	t.rect(0, 0, 12, 10, mix(box, BLACK, 0.45));
	t.rect(1, 1, 10, 8, box);
	t.rect(1, 1, 10, 1, mix(box, WHITE, 0.45));
	t.rect(1, 8, 10, 1, mix(box, BLACK, 0.2));
	for (let y = 2; y < 8; y++) {
		for (let x = 2; x < 8; x++) {
			const d = Math.hypot(x - 4.5, y - 4.5);
			if (d < 3) t.set(x, y, d < 1 ? [120, 120, 126] : (x + y) % 2 === 0 ? [54, 54, 60] : [80, 80, 88]);
		}
	}
	for (let y = 2; y < 8; y += 2) t.rect(8, y, 2, 1, mix(box, BLACK, 0.3));
	return withShadow(t);
}

/** a round roof vent (its shadow baked in) */
function vent() {
	const t = new Tex(6, 6);
	for (let y = 0; y < 6; y++) {
		for (let x = 0; x < 6; x++) {
			const d = Math.hypot(x - 2.5, y - 2.5);
			if (d > 2.9) continue;
			const lit = (-(x - 2.5) - (y - 2.5)) / 5;
			t.set(x, y, d > 2.2 ? [70, 70, 76] : add([150, 150, 156], lit * 40));
		}
	}
	t.set(2, 2, [60, 60, 66]);
	t.set(3, 3, [60, 60, 66]);
	return withShadow(t);
}

/** a brick chimney stack on a house roof: courses of brick, the flue opening, a cap (its shadow baked in) */
function chimney() {
	const t = new Tex(7, 7);
	const brick = [128, 74, 58];
	const r = rng(111);
	for (let y = 0; y < 7; y++) {
		for (let x = 0; x < 7; x++) {
			let c = add(brick, (r() - 0.5) * 16);
			if (y % 2 === 0 && (x + (y % 4 === 0 ? 0 : 2)) % 4 === 0) c = add(brick, -30);
			t.set(x, y, c);
		}
	}
	t.rect(0, 0, 7, 1, [150, 146, 140]);
	t.rect(0, 0, 1, 7, [150, 146, 140]);
	t.rect(2, 2, 3, 3, [26, 22, 22]);
	t.set(2, 2, [50, 44, 42]);
	for (let i = 0; i < 7; i++) {
		t.over(6, i, BLACK, 90);
		t.over(i, 6, BLACK, 90);
	}
	return withShadow(t);
}

// ---------------------------------------------------------------- building signs (DESIGN_RULES ART-07)

/**
 * The signs are DATA in src/shared/data/buildingSigns.ts (the game draws the same grids flat when a texture has no
 * id): that module imports nothing, so a bare transpile runs it here with a Color3 that returns [r, g, b].
 */
function loadSigns() {
	const ts = createRequire(import.meta.url)("typescript");
	const src = readFileSync(join(ROOT, "src", "shared", "data", "buildingSigns.ts"), "utf8");
	const js = ts.transpileModule(src, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	}).outputText;
	const exports = {};
	runInNewContext(js, { exports, module: { exports }, Color3: { fromRGB: (r, g, b) => [r, g, b] } });
	return exports;
}

/** a sign board, texel for texel from its grid */
function signBoard(sign, palette) {
	const t = new Tex(sign.rows[0].length, sign.rows.length);
	sign.rows.forEach((row, y) => {
		for (let x = 0; x < row.length; x++) t.set(x, y, palette[row[x]]);
	});
	return t;
}

// ---------------------------------------------------------------- the electric builds (DESIGN_RULES ELE-01..08)

/**
 * The machines are DATA in src/shared/data/machineArt.ts (the game draws the same grids flat when a texture has no
 * id): like the signs' module it imports nothing, so a bare transpile runs it here with a Color3 that returns [r, g, b].
 */
function loadMachines() {
	const ts = createRequire(import.meta.url)("typescript");
	const src = readFileSync(join(ROOT, "src", "shared", "data", "machineArt.ts"), "utf8");
	const js = ts.transpileModule(src, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	}).outputText;
	const exports = {};
	runInNewContext(js, { exports, module: { exports }, Color3: { fromRGB: (r, g, b) => [r, g, b] } });
	return exports;
}

/** a machine sprite, texel for texel from its grid ('.' stays transparent) */
function machineSprite(sprite, palette) {
	const t = new Tex(sprite.rows[0].length, sprite.rows.length);
	sprite.rows.forEach((row, y) => {
		for (let x = 0; x < row.length; x++) if (row[x] !== ".") t.set(x, y, palette[row[x]]);
	});
	return t;
}

/**
 * The hospital's helipad (ICAO's hospital heliport: a red H on a white cross of five squares, on the dark deck of
 * the landing area inside its white ring), painted on the roof: the paint is a little thin everywhere and worn
 * through in places, with a crack or two. Its geometry is HELIPAD's, the same numbers the flat drawing uses.
 */
function helipad(pad, palette) {
	const n = pad.size;
	const t = new Tex(n, n);
	const c = (n - 1) / 2;
	const r = rng(141);
	const deck = palette[pad.deck];
	const paint = palette[pad.paint];
	const mark = palette[pad.mark];
	const base = Math.round(255 * pad.alpha);
	const put = (x, y, col) => {
		// worn paint: most texels a little thin, some worn through to the membrane
		const roll = r();
		const a = roll < 0.06 ? base * 0.35 : roll < 0.2 ? base * 0.75 : base;
		t.set(x, y, add(col, (r() - 0.5) * 10), Math.round(a));
	};
	const outer = pad.ring / 2;
	const inner = outer - pad.ringWidth;
	const sq = pad.square;
	const s0 = Math.floor(c - sq / 2) + 1;
	const inCross = (x, y) =>
		(x >= s0 && x < s0 + sq && y >= s0 - sq && y < s0 + sq * 2) ||
		(y >= s0 && y < s0 + sq && x >= s0 - sq && x < s0 + sq * 2);
	const l0 = s0 + (sq - pad.letter) / 2;
	const inH = (x, y) => {
		if (y < l0 || y >= l0 + pad.letter || x < l0 || x >= l0 + pad.letter) return false;
		if (x < l0 + pad.leg || x >= l0 + pad.letter - pad.leg) return true;
		const b0 = l0 + (pad.letter - pad.bar) / 2;
		return y >= b0 && y < b0 + pad.bar;
	};
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const d = Math.hypot(x - c, y - c);
			if (inH(x, y)) put(x, y, mark);
			else if (inCross(x, y) || (d <= outer && d > inner)) put(x, y, paint);
			else if (d <= inner) t.set(x, y, add(deck, (r() - 0.5) * 8), base);
		}
	}
	// two hairline cracks through the paint, where the membrane moved
	for (const [x0, y0, dx] of [
		[s0 - sq + 2, s0 + 3, 1],
		[s0 + sq + 4, s0 - sq + 1, -1],
	]) {
		let x = x0;
		for (let y = y0; y < y0 + 7; y++) {
			if (t.alpha(x, y) > 0) t.set(x, y, mix(paint, BLACK, 0.55), Math.round(base * 0.7));
			if (r() < 0.5) x += dx;
		}
	}
	return t;
}

// ================================================================ the game's name (client/ui/logo.ts)

/** the words of the wordmark, left to right; word i's fill is cell i + 1 (cell 0 is the ink) */
const WORDMARK_WORDS = ["LAST", "TOWN"];
/** the greys of a letter's fill, tinted by the client: its lit top edge, its upper half, its lower half */
const WORDMARK_GREY = { light: 255, top: 232, bottom: 190 };
/** the hard shadow under the outline: one font pixel down and right, 85% opaque (tools/title-font.mjs drawTitle) */
const WORDMARK_SHADOW_A = 217;

/**
 * LAST TOWN in the bold pixel font of tools/title-font.mjs, the shape of the store art's wordmark
 * (docs/promo/logo/last-town-wordmark.png: the same layoutText, the same one-pixel outline and hard shadow), one texel
 * per font pixel, as three stacked cells of `w` x `cellH` texels:
 *   cell 0  the ink: the outline ring (white, tinted THEME.background) and, under it, the hard shadow (black)
 *   cell 1  the fill of LAST, cell 2 the fill of TOWN: the lit top edge at full strength, the upper half a little and
 *           the lower half more darkened -- the relief of the promo's two-tone fill, in greys the client tints with
 *           GAME.brand and THEME.foreground (a multiplying tint can only darken, so the edge is the token itself)
 * Returns the texture and the height of one cell.
 */
function wordmark() {
	const words = WORDMARK_WORDS.map(w => layoutText(w));
	const gap = layoutText(" ").w;
	const m = layoutText(WORDMARK_WORDS.join(" "));
	const ring = dilate(m, 1);
	// the ring is one pixel round the letters; the shadow falls one more pixel down and right
	const w = ring.w + 1;
	const cellH = ring.h + 1;
	const t = new Tex(w, cellH * (1 + words.length));
	const inRing = (x, y) => ring.bits[y * ring.w + x] === 1;
	// the shadow first, the ring over it: what is left of the shadow is the part the ring does not cover
	for (let y = 0; y < ring.h; y++) {
		for (let x = 0; x < ring.w; x++) if (inRing(x, y)) t.set(x + 1, y + 1, BLACK, WORDMARK_SHADOW_A);
	}
	for (let y = 0; y < ring.h; y++) {
		for (let x = 0; x < ring.w; x++) if (inRing(x, y)) t.set(x, y, WHITE);
	}
	let x0 = 0;
	words.forEach((word, i) => {
		const top = cellH * (i + 1);
		for (let y = 0; y < TITLE_H; y++) {
			for (let x = 0; x < word.w; x++) {
				if (word.bits[y * word.w + x] === 0) continue;
				const lit = y === 0 || word.bits[(y - 1) * word.w + x] === 0;
				const g = lit ? WORDMARK_GREY.light : y < TITLE_H / 2 ? WORDMARK_GREY.top : WORDMARK_GREY.bottom;
				t.set(x0 + x + 1, top + y + 1, [g, g, g]);
			}
		}
		x0 += word.w + gap;
	});
	return { tex: t, cellH };
}

// ================================================================ the list

function build() {
	add_(
		"asphalt",
		"tile",
		asphalt(64, C.road, 11, { cracks: 0 }),
		"road asphalt: grain and tar blotches (cracks are decals: a crack here would repeat every tile)",
	);
	add_(
		"asphaltLot",
		"tile",
		asphalt(64, G.parking, 12, { cracks: 1, light: 0.09, dark: 0.12, blotch: 7 }),
		"parking-lot asphalt, a little more worn",
	);
	add_(
		"concrete",
		"tile",
		slabs(64, 16, C.sidewalk, 21, { cracks: 1 }),
		"sidewalk: 64-unit concrete slabs with joints",
	);
	add_(
		"plaza",
		"tile",
		slabs(32, 8, G.plaza, 22, { joint: -14, perSlab: 5, cracks: 0 }),
		"downtown paving: 32-unit pavers",
	);
	add_("pavers", "tile", pavers(16, 8, 4, G.walk, 23), "footpaths to the doors: running-bond pavers");
	add_(
		"apron",
		"tile",
		slabs(64, 32, G.apron, 24, { joint: -20, perSlab: 3, speckle: 0.08, cracks: 0 }),
		"gas forecourt / ambulance bay: poured concrete panels",
	);
	add_("grass", "tile", lawn(64, 31, { base: C.grass, light: C.grassLight, dark: C.grassDark }), "mowed lawn");
	add_(
		"grassLong",
		"tile",
		lawn(64, 32, {
			base: mix(C.grass, C.grassDark, 0.3),
			light: mix(C.grassLight, [130, 134, 72], 0.25),
			dark: mix(C.grassDark, BLACK, 0.08),
			tufts: 0.7,
			long: true,
		}),
		"a yard nobody mowed for a week or two",
	);
	add_("dirt", "tile", earth(32, G.playground, 33), "packed earth: park paths, the school yard");
	add_("soil", "tile", mulch(16, G.pit, 34), "tree pits: bark mulch");
	add_("tactile", "tile", tactile(G.ramp), "tactile paving where a crosswalk lands");
	add_("paint", "tile", paint(16, 35), "road paint, worn (tinted: white zebras, yellow line)");
	const kerbN = kerb(16, C.curb, 36);
	add_("kerbN", "tile", kerbN, "kerb on a road's north edge (its shadow on the asphalt below)");
	add_("kerbS", "tile", flipY(kerbN), "kerb on a road's south edge");
	add_("kerbW", "tile", transpose(kerbN), "kerb on a road's west edge");
	add_("kerbE", "tile", transpose(flipY(kerbN)), "kerb on a road's east edge");
	add_("forest", "tile", forest(64, C.borderForest, 37), "the forest outside the town fence");
	add_("fenceH", "tile", fence(16, C.fence, 38), "board fence along x");
	add_("fenceV", "tile", transpose(fence(16, C.fence, 38)), "board fence along y");
	add_("floorWood", "tile", planks(32, C.floorWood, 41), "house floors: boards");
	add_("floorTile", "tile", floorTiles(16, 8, C.floorTile, 42, true), "hospital / pharmacy floor: checker tiles");
	add_("floorShop", "tile", floorTiles(32, 8, C.floorShop, 43, false, { chips: 0.05 }), "shop floor: vinyl tiles");
	add_("wall", "tileTint", plaster(8, 44), "walls: plaster (tint: the wall colour)");
	add_("roofShingleH", "tileTint", shingles(32, 51), "pitched roof shingles, courses along x (tint: roof colour)");
	add_("roofShingleV", "tileTint", transpose(shingles(32, 51)), "pitched roof shingles, courses along y");
	add_("roofGravel", "tileTint", gravel(32, 52), "flat roof: tar and gravel (shops)");
	add_("roofMembrane", "tileTint", membrane(64, 16, 53), "flat roof: welded membrane (school, hospital, gas)");
	add_("eaves", "slice", roofRim("eaves"), "pitched roof rim: drip edge and fascia", { slice: [4, 4, 8, 8] });
	add_("parapet", "slice", roofRim("parapet"), "flat roof rim: parapet, coping, inner face", { slice: [4, 4, 8, 8] });
	add_("shadowBox", "slice", shadowBox(), "soft rectangular drop shadow", { slice: [6, 6, 10, 10] });
	// the town's trees (DESIGN_RULES VEG-06): every kind in its looks, masks and their light, and the trunk
	const species = loadTrees().TREE_SPECIES;
	const trees = treeArt({ species });
	const crowns = trees.cells.reduce((n, list) => n + list.length, 0);
	add_(
		"trees",
		"atlas",
		trees.atlas,
		`trees: ${crowns} crowns of ${species.length} kinds (greyscale masks, tint: foliage; their light below) and the trunk (client/view/worldView.ts)`,
		{ trees, species },
	);
	CAR_STYLES.forEach((style, i) => {
		const art = carArt(style, 71 + i * 13);
		add_(`car${i}`, "mask", art.mask, `${style.name}: body (tint: paint)`);
		add_(`carTrim${i}`, "overlay", art.trim, `${style.name}: glass, lights, wheels, outline`);
		add_(`carDamage${i}`, "overlay", art.damage, `${style.name}: smashed windshield, scratches`);
		add_(`carWreck${i}`, "overlay", art.wreck, `${style.name}: burnt out`);
	});
	add_("bin", "sprite", wheelieBin(), "wheelie bin");
	for (let i = 0; i < 3; i++) add_(`litter${i}`, "sprite", litter(i, 81 + i), "spilled litter (flat)");
	for (let i = 0; i < 2; i++) add_(`blood${i}`, "sprite", bloodDry(91 + i), "dried blood");
	for (let i = 0; i < 2; i++) add_(`oil${i}`, "sprite", oilStain(95 + i), "oil stain");
	for (let i = 0; i < 2; i++) add_(`crack${i}`, "sprite", crack(97 + i), "asphalt crack");
	add_("manhole", "sprite", manhole(), "manhole cover");
	// the rain's puddles (LUZ-05): two long gutter shapes and two lane ones, each along x and turned for a vertical
	// road, and the drop that lands on them
	const PUDDLES = [
		[puddle(38, 11, 201), "in a gutter: long, stepped edge"],
		[puddle(30, 10, 202, { lobe: 1 }), "in a gutter, a small pool past its end"],
		[puddle(22, 14, 203), "in a lane: a dip in the asphalt"],
		[puddle(32, 15, 204, { lobe: -1 }), "in a lane, a small pool before it"],
	];
	PUDDLES.forEach(([tex, what], i) => {
		add_(`puddle${i}`, "sprite", tex, `rain puddle ${what} (sky streaks, lit rim, wet halo)`);
		add_(`puddle${i}V`, "sprite", transposed(tex), `rain puddle ${what}, on a vertical road`);
	});
	add_("puddleDrop", "sprite", puddleDrop(), "a drop's ring on a puddle (4 texels)");
	add_("drain", "sprite", drain(), "storm drain");
	// a NEW name, not the old top-down "pump": the owner's place holds an id for that one, and the upright art under
	// it would be the old picture stretched until the next upload; a new texture has no id, so ART-01's flat
	// dispenser stands in until then (EDI-16)
	add_(
		"dispenser",
		"sprite",
		pump(loadSigns().SIGN_ART),
		"fuel dispenser, upright: the station sign's white cabinet, dark display, red stripe, hose and nozzle",
	);
	add_("acUnit", "sprite", acUnit(), "rooftop air conditioner");
	add_("vent", "sprite", vent(), "roof vent");
	add_("chimney", "sprite", chimney(), "brick chimney on a house roof");
	// the storefront signs and the hospital's helipad (src/shared/data/buildingSigns.ts)
	const signs = loadSigns();
	for (const type of Object.keys(signs.BUILDING_SIGNS).sort((a, b) => Number(a) - Number(b))) {
		const sign = signs.BUILDING_SIGNS[type];
		add_(sign.texture, "sprite", signBoard(sign, signs.SIGN_ART), `storefront sign (type ${type}): ${sign.shows}`);
	}
	add_(
		"helipad",
		"sprite",
		helipad(signs.HELIPAD, signs.SIGN_ART),
		"hospital roof: the heliport's red H on a white cross",
	);
	// a gas station's canopy roof (EDI-16), one per side its street is on
	for (const [i, side] of ["N", "S", "W", "E"].entries()) {
		add_(
			`gasCanopy${side}`,
			"sprite",
			gasCanopy(side, signs.SIGN_ART, 151 + i),
			`gas station canopy roof, street to the ${side}: charcoal fascia with a red pinstripe, standing seams, fixtures, drains, weather`,
		);
	}
	// a gas station's price pylon (EDI-16): its grid, texel for texel, the post's '.' margins transparent
	add_(
		signs.PRICE_SIGN.texture,
		"sprite",
		machineSprite(signs.PRICE_SIGN, signs.SIGN_ART),
		`gas station price sign: ${signs.PRICE_SIGN.shows}`,
	);
	// the rideable builds (VEI-05), parked or under a rider (client/view/vehicleView.ts)
	add_("bicycle", "sprite", bicycle(), "a bicycle from above, nose to +x: tyres, frame, pedals, saddle, bars");
	add_(
		"motorcycle",
		"sprite",
		motorcycle(),
		"a motorcycle from above, nose to +x: tank, seat, engine, exhaust, lamp",
	);
	// the electric builds and their moving parts (src/shared/data/machineArt.ts, ELE-09)
	const machines = loadMachines();
	for (const key of Object.keys(machines.MACHINE_SPRITES)) {
		const m = machines.MACHINE_SPRITES[key];
		add_(m.texture, "sprite", machineSprite(m, machines.MACHINE_ART), m.shows);
	}
	// interiors (shared/game/interiors.ts): the floors the old three did not cover
	add_("floorCarpet", "tile", carpet(16, C.floorCarpet, 47), "bedroom / office carpet: a low loop pile");
	add_("floorKitchen", "tile", floorTiles(16, 8, C.floorKitchen, 45, true), "kitchen floor: checker tiles");
	add_("floorBath", "tile", floorTiles(16, 4, C.floorBath, 46, false), "bathroom / cold room: small tiles");
	add_(
		"wallShade",
		"slice",
		wallShade(),
		"an interior wall's outline (its centre, tinted) and the shadow at its foot",
		{
			slice: [3, 3, 4, 4],
		},
	);
	// the survivors (arms baked per grip), their weapons, the horde and the pets (ART-08..ART-11)
	for (const t of characterArt(Tex)) add_(t.name, t.kind, t.tex, t.description, { character: true });
	// the four bosses, one sheet each (ART-14, tools/boss-art.mjs)
	for (const t of bossArt(Tex)) add_(t.name, t.kind, t.tex, t.description, { character: true });
	// the item icons (DESIGN_RULES UI-11): not the town, but uploaded with it
	const atlas = buildIconAtlas(loadIconData(ROOT));
	const icons = atlas.order.filter(k => atlas.cells[k].n === 16).length;
	add_(
		"itemIcons",
		"atlas",
		{ w: atlas.w, h: atlas.h, toCanvas: () => ({ w: atlas.w, h: atlas.h, data: atlas.data }) },
		`item icons: ${icons} icons, their dimmed copies and ${atlas.order.length - icons} glyphs (client/ui/itemIcon.ts)`,
		{ atlas },
	);
	// the interiors (DESIGN_RULES ART-12): every piece of furniture, the floor decoration, the doorway and window frames
	const furniture = furnitureArt({ C, ROOT });
	add_(
		"furniture",
		"atlas",
		furniture.atlas,
		`interiors: ${Object.keys(furniture.cells).length} cells of furniture, decoration and frames (client/view/interiorArt.ts)`,
		{ furniture },
	);
	if (furniture.report.generic.length > 0) {
		console.log(`furniture: no drawer yet for ${furniture.report.generic.join(", ")} (painted as a plain cabinet)`);
	}
	// the blood a fight leaves (DESIGN_RULES ART-15): drops, splats, smears; a matte band and two wet ones
	const blood = bloodArt({ C });
	add_(
		"blood",
		"atlas",
		blood.atlas,
		`combat blood: ${blood.cells.length} cells of drops, splats and smears, matte and wet (client/view/bloodView.ts)`,
		{ blood },
	);
	// the everyday town's fixtures (DESIGN_RULES ART-16): the market, the street, the parks, the backyards, the site
	const townProps = townPropArt({ C });
	add_(
		"townProps",
		"atlas",
		townProps.atlas,
		`the town's fixtures: ${townProps.report.cells} cells of market, street, park, backyard and building-site pieces and their ground (client/view/townPropArt.ts)`,
		{ townProps },
	);
	// the buildings' doors and entrances (DESIGN_RULES ART-17): the stoop, the leaves, the frame, the lintel
	const entrances = entranceArt({ C });
	add_(
		"entrances",
		"atlas",
		entrances.atlas,
		`the buildings' entrances: ${entrances.report.cells} cells of stoops, door leaves, frames and lintels, each side baked on its own (client/view/entranceArt.ts)`,
		{ entrances },
	);
	// the game's name (UI-10): the lobby's title and the splash, not the town -- uploaded with it all the same
	const mark = wordmark();
	add_(
		"wordmark",
		"ui",
		mark.tex,
		`the LAST TOWN wordmark: three ${mark.tex.w} x ${mark.cellH} cells top to bottom, the ink (tint: background), ` +
			"the fill of LAST (tint: brand) and of TOWN (tint: foreground) (client/ui/logo.ts)",
	);
}

// ---------------------------------------------------------------- output

function manifestOf() {
	return {
		generator: "tools/gen-world-art.mjs",
		worldTexel: WORLD_TEXEL,
		note: "1 texel = worldTexel world units; tiles repeat every w x h texels; masks and tileTint textures are greyscale and tinted with ImageColor3; overlays are untinted RGBA; slice = 9-slice centre in texels; sheet = the characters' pose x heading cells (src/client/view/charSheets.ts). The client draws every one with ResamplerMode.Pixelated.",
		textures: textures.map(t => ({
			name: t.name,
			file: `${t.name}.png`,
			kind: t.kind,
			w: t.tex.w,
			h: t.tex.h,
			...(t.slice !== undefined ? { slice: t.slice } : {}),
			description: t.description,
			...(t.atlas !== undefined ? atlasCells(t.atlas) : {}),
		})),
	};
}

/** an atlas's cells for the manifest: `cells` [x, y, w, h] per key, and `dim` for the icons' dimmed copies */
function atlasCells(atlas) {
	const cells = {};
	const dim = {};
	for (const key of atlas.order) {
		const c = atlas.cells[key];
		cells[key] = [c.x, c.y, c.n, c.n];
		if (c.dimX !== c.x || c.dimY !== c.y) dim[key] = [c.dimX, c.dimY, c.n, c.n];
	}
	return { cells, dim };
}

/** manifest.json: JSON with tabs, each atlas cell on one line */
function manifestJson(manifest) {
	const oneLine = cells => Object.fromEntries(Object.entries(cells).map(([k, c]) => [k, `<<${c.join(", ")}>>`]));
	const textures = manifest.textures.map(t =>
		t.cells !== undefined ? { ...t, cells: oneLine(t.cells), dim: oneLine(t.dim) } : t,
	);
	return `${JSON.stringify({ ...manifest, textures }, undefined, "\t")}\n`.replace(/"<<([\d, ]+)>>"/g, "[$1]");
}

const sha1 = bytes => createHash("sha1").update(bytes).digest("hex");

/** the id an atlas may use: the uploaded one only while assets.json's sha1 is that of the PNG on disk */
function atlasId(t, id, hashes) {
	if (id === "") return "";
	const file = join(OUT_DIR, t.file);
	if (existsSync(file) && hashes[t.name] === sha1(readFileSync(file))) return id;
	console.log(`${t.name}: the uploaded atlas is not this PNG (run npm run cloud -- upload-art); its id is left out`);
	return "";
}

/** src/client/view/worldArtAssets.ts from the manifest and design/world-art/assets.json */
function writeAssetsModule(manifest) {
	const assetsPath = join(OUT_DIR, "assets.json");
	const assets = existsSync(assetsPath) ? JSON.parse(readFileSync(assetsPath, "utf8")) : {};
	const ids = { ...(assets.ids ?? {}) };
	for (const t of manifest.textures) {
		if (t.kind === "atlas") ids[t.name] = atlasId(t, ids[t.name] ?? "", assets.sha1 ?? {});
	}
	const L = [];
	L.push("// generated by tools/gen-world-art.mjs — do not edit");
	L.push(
		"// textures: design/world-art/manifest.json, asset ids: design/world-art/assets.json (npm run cloud -- upload-art)",
	);
	L.push(
		"// an empty id turns that texture off: client/view/worldView.ts then draws that surface flat, as before the art",
	);
	L.push("");
	L.push("export interface WorldArtAsset {");
	L.push('\t/** "rbxassetid://...", or "" until the texture is uploaded */');
	L.push("\tid: string;");
	L.push("\t/** size in texels (one texel = WORLD_TEXEL world units) */");
	L.push("\tw: number;");
	L.push("\th: number;");
	L.push("\t/** 9-slice centre in texels (slice textures only) */");
	L.push("\tslice?: readonly [number, number, number, number];");
	L.push("}");
	L.push("");
	L.push("/** world units per texel of the world art */");
	L.push(`export const WORLD_TEXEL = ${WORLD_TEXEL};`);
	L.push("");
	L.push(`export type WorldArtName =${manifest.textures.map(t => `\n\t| "${t.name}"`).join("")};`);
	L.push("");
	L.push("export const WORLD_ART: Record<WorldArtName, WorldArtAsset> = {");
	for (const t of manifest.textures) {
		const id = ids[t.name] ?? "";
		const slice = t.slice !== undefined ? `, slice: [${t.slice.join(", ")}]` : "";
		L.push(`\t/** ${t.kind}: ${t.description} */`);
		L.push(`\t${t.name}: { id: "${id}", w: ${t.w}, h: ${t.h}${slice} },`);
	}
	L.push("};");
	L.push("");
	L.push("/** every texture of the world art (the item icon atlas too), for the preload pass */");
	L.push("export const WORLD_ART_NAMES: Array<WorldArtName> = [");
	for (const t of manifest.textures) L.push(`\t"${t.name}",`);
	L.push("];");
	L.push("");
	writeFileSync(TS_OUT, L.join("\n"));
	const live = manifest.textures.filter(t => (ids[t.name] ?? "") !== "").length;
	console.log(`wrote ${TS_OUT} (${live}/${manifest.textures.length} textures with an asset id)`);
}

/** src/client/ui/itemIconAtlas.ts: the atlas's cells for client/ui/itemIcon.ts (its id is in worldArtAssets.ts) */
function writeIconAtlasModule() {
	const t = textures.find(x => x.atlas !== undefined);
	const { atlas } = t;
	const L = [];
	L.push("// generated by tools/gen-world-art.mjs — do not edit");
	L.push(
		`// the item icons' atlas (tools/icon-atlas.mjs): design/world-art/${t.name}.png, the same cells in manifest.json;`,
	);
	L.push(`// its asset id is WORLD_ART.${t.name} in client/view/worldArtAssets.ts (npm run cloud -- upload-art)`);
	L.push("");
	L.push("/** the atlas's size in texels */");
	L.push(`export const ICON_ATLAS_W = ${atlas.w};`);
	L.push(`export const ICON_ATLAS_H = ${atlas.h};`);
	L.push("");
	L.push("/**");
	L.push(
		" * Per icon or glyph key: [x, y, n, dimX, dimY] in texels -- the top-left corner of its cell, the cell's side",
	);
	L.push(
		" * (16 for an icon, 8 for a glyph) and the corner of its dimmed copy (a glyph's is its own cell: the ink wins).",
	);
	L.push(" */");
	L.push("export const ICON_ATLAS_CELLS: Record<string, readonly [number, number, number, number, number]> = {");
	for (const key of atlas.order) {
		const c = atlas.cells[key];
		const name = /^[A-Za-z_]\w*$/.test(key) ? key : JSON.stringify(key);
		L.push(`\t${name}: [${c.x}, ${c.y}, ${c.n}, ${c.dimX}, ${c.dimY}],`);
	}
	L.push("};");
	L.push("");
	writeFileSync(ICON_TS_OUT, L.join("\n"));
	console.log(`wrote ${ICON_TS_OUT} (${atlas.order.length} cells, atlas ${atlas.w} x ${atlas.h})`);
}

/** src/client/view/furnitureAtlas.ts and the interiors' page of docs/art (the furniture, magnified and labelled) */
function writeFurnitureModule() {
	const t = textures.find(x => x.furniture !== undefined);
	writeFileSync(FURNITURE_TS_OUT, furnitureAtlasModule(t.furniture, t.name));
	console.log(
		`wrote ${FURNITURE_TS_OUT} (${Object.keys(t.furniture.cells).length} cells, atlas ${t.tex.w} x ${t.tex.h})`,
	);
	if (process.argv.includes("--no-sheet")) return;
	const sheet = furnitureSheet(t.furniture, drawText);
	mkdirSync(dirname(FURNITURE_SHEET), { recursive: true });
	writeFileSync(FURNITURE_SHEET, encodePNG(sheet, true));
	console.log(`wrote ${FURNITURE_SHEET} (${sheet.w}x${sheet.h})`);
}

/** src/client/view/bloodAtlas.ts and docs/art/blood-sheet.png (every stain on the floors it lands on) */
function writeBloodModule() {
	const t = textures.find(x => x.blood !== undefined);
	writeFileSync(BLOOD_TS_OUT, bloodAtlasModule(t.blood, t.name));
	console.log(`wrote ${BLOOD_TS_OUT} (${t.blood.cells.length} cells, atlas ${t.tex.w} x ${t.tex.h})`);
	if (process.argv.includes("--no-sheet")) return;
	const sheet = bloodSheet(t.blood, drawText, C);
	mkdirSync(dirname(BLOOD_SHEET), { recursive: true });
	writeFileSync(BLOOD_SHEET, encodePNG(sheet, true));
	console.log(`wrote ${BLOOD_SHEET} (${sheet.w}x${sheet.h})`);
}

/** src/client/view/treeAtlas.ts and docs/art/tree-sheet.png (every crown in each of its greens, as the game draws) */
function writeTreeModule() {
	const t = textures.find(x => x.trees !== undefined);
	writeFileSync(TREE_TS_OUT, treeAtlasModule(t.trees, t.name));
	const crowns = t.trees.cells.reduce((n, list) => n + list.length, 0);
	console.log(`wrote ${TREE_TS_OUT} (${crowns} crowns, atlas ${t.tex.w} x ${t.tex.h})`);
	if (process.argv.includes("--no-sheet")) return;
	const sheet = treeSheet(t.trees, drawText, C, t.species);
	mkdirSync(dirname(TREE_SHEET), { recursive: true });
	writeFileSync(TREE_SHEET, encodePNG(sheet, true));
	console.log(`wrote ${TREE_SHEET} (${sheet.w}x${sheet.h})`);
}

/** src/client/view/townPropAtlas.ts and docs/art/town-props-sheet.png (every fixture in every look, magnified) */
function writeTownPropModule() {
	const t = textures.find(x => x.townProps !== undefined);
	writeFileSync(TOWN_PROP_TS_OUT, townPropAtlasModule(t.townProps, t.name));
	console.log(
		`wrote ${TOWN_PROP_TS_OUT} (${t.townProps.report.cells} cells, ${t.townProps.report.unique} unique, atlas ${t.tex.w} x ${t.tex.h})`,
	);
	if (process.argv.includes("--no-sheet")) return;
	const sheet = townPropSheet(t.townProps, drawText);
	mkdirSync(dirname(TOWN_PROP_SHEET), { recursive: true });
	writeFileSync(TOWN_PROP_SHEET, encodePNG(sheet, true));
	console.log(`wrote ${TOWN_PROP_SHEET} (${sheet.w}x${sheet.h})`);
}

/** src/client/view/entranceAtlas.ts and docs/art/entrances-sheet.png (every entrance style, from the street and inside) */
function writeEntranceModule() {
	const t = textures.find(x => x.entrances !== undefined);
	writeFileSync(ENTRANCE_TS_OUT, entranceAtlasModule(t.entrances, t.name));
	console.log(
		`wrote ${ENTRANCE_TS_OUT} (${t.entrances.report.cells} cells, ${t.entrances.report.unique} unique, atlas ${t.tex.w} x ${t.tex.h})`,
	);
	if (process.argv.includes("--no-sheet")) return;
	const sheet = entranceSheet(t.entrances, drawText, C, SHEET_STYLES);
	mkdirSync(dirname(ENTRANCE_SHEET), { recursive: true });
	writeFileSync(ENTRANCE_SHEET, encodePNG(sheet, true));
	console.log(`wrote ${ENTRANCE_SHEET} (${sheet.w}x${sheet.h})`);
}

/** every texture magnified on one page, labelled, tiles shown 2 x 2 so the seams can be checked */
function contactSheet() {
	const zoom = 4;
	const cellW = 300;
	const pad = 10;
	const cols = 5;
	// the characters' sheets are hundreds of texels wide: they have their own pages (docs/art/characters)
	const cells = textures
		.filter(
			t =>
				!t.character &&
				t.atlas === undefined &&
				t.furniture === undefined &&
				t.blood === undefined &&
				t.trees === undefined &&
				t.townProps === undefined &&
				t.entrances === undefined,
		)
		.map(t => {
			const reps = t.kind === "tile" || t.kind === "tileTint" ? 2 : 1;
			let z = zoom;
			while (t.tex.w * reps * z > cellW - pad * 2 && z > 1) z--;
			return { t, reps, z, h: t.tex.h * reps * z + 30 };
		});
	const rows = [];
	for (let i = 0; i < cells.length; i += cols) rows.push(cells.slice(i, i + cols));
	const H = rows.reduce((s, row) => s + Math.max(...row.map(c => c.h)) + pad, pad);
	const W = cols * cellW;
	const img = { w: W, h: H, data: Buffer.alloc(W * H * 4) };
	for (let i = 0; i < W * H; i++) {
		const x = i % W;
		const y = Math.floor(i / W);
		const check = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 58 : 66;
		img.data[i * 4] = check;
		img.data[i * 4 + 1] = check;
		img.data[i * 4 + 2] = check + 4;
		img.data[i * 4 + 3] = 255;
	}
	// masks and greyscale tiles are shown tinted with a sample colour, as the game would
	const sample = { car: [150, 60, 60], wall: C.wallHouse, roof: [160, 70, 60] };
	let y0 = pad;
	for (const row of rows) {
		row.forEach((c, ci) => {
			const t = c.t;
			let tint = [255, 255, 255];
			if (t.name.startsWith("car") && t.kind === "mask") tint = sample.car;
			else if (t.name === "wall") tint = sample.wall;
			else if (t.kind === "tileTint") tint = sample.roof;
			const x0 = ci * cellW + pad;
			for (let ry = 0; ry < c.reps; ry++) {
				for (let rx = 0; rx < c.reps; rx++) {
					for (let y = 0; y < t.tex.h; y++) {
						for (let x = 0; x < t.tex.w; x++) {
							const p = t.tex.get(x, y);
							const a = p[3] / 255;
							if (a <= 0) continue;
							for (let dy = 0; dy < c.z; dy++) {
								for (let dx = 0; dx < c.z; dx++) {
									const X = x0 + (rx * t.tex.w + x) * c.z + dx;
									const Y = y0 + 22 + (ry * t.tex.h + y) * c.z + dy;
									const i = (Y * W + X) * 4;
									for (let k = 0; k < 3; k++) {
										const v = Math.max(0, Math.min(255, (p[k] * tint[k]) / 255));
										img.data[i + k] = Math.round(img.data[i + k] * (1 - a) + v * a);
									}
								}
							}
						}
					}
				}
			}
			drawText(img, t.name, x0, y0 + 4, 2, [235, 235, 235]);
		});
		y0 += Math.max(...row.map(c => c.h)) + pad;
	}
	mkdirSync(dirname(SHEET), { recursive: true });
	writeFileSync(SHEET, encodePNG(img, true));
	console.log(`wrote ${SHEET} (${W}x${H})`);
}

build();
const manifest = manifestOf();
if (!process.argv.includes("--assets")) {
	mkdirSync(OUT_DIR, { recursive: true });
	let bytes = 0;
	for (const t of textures) {
		const png = encodePNG(t.tex.toCanvas());
		bytes += png.length;
		writeFileSync(join(OUT_DIR, `${t.name}.png`), png);
	}
	// a texture that left the list leaves the folder too (the upload sends what is in the manifest)
	const names = new Set(textures.map(t => `${t.name}.png`));
	for (const f of readdirSync(OUT_DIR)) if (f.endsWith(".png") && !names.has(f)) unlinkSync(join(OUT_DIR, f));
	writeFileSync(join(OUT_DIR, "manifest.json"), manifestJson(manifest));
	writeIconAtlasModule();
	writeFurnitureModule();
	writeBloodModule();
	writeTreeModule();
	writeTownPropModule();
	writeEntranceModule();
	console.log(`world-art: ${textures.length} textures in ${OUT_DIR} (${(bytes / 1024).toFixed(1)} kB)`);
	if (!process.argv.includes("--no-sheet")) contactSheet();
}
writeAssetsModule(manifest);
