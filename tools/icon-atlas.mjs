/*
 * The item icons' atlas: every icon and glyph of src/shared/data/itemIcons.ts rasterised into one image, so
 * client/ui/itemIcon.ts can draw an icon as ONE ImageLabel (ImageRectOffset / ImageRectSize, Pixelated) instead of
 * the 10-50 Frames of its runs (docs/DESIGN_RULES.md UI-11). tools/gen-world-art.mjs writes it with the town's
 * textures (design/world-art/itemIcons.png, its cells in manifest.json) and the client's table of cells
 * (src/client/ui/itemIconAtlas.ts), so `npm run cloud -- upload-art` sends it with the rest.
 *
 *   import { loadIconData, buildIconAtlas } from "./icon-atlas.mjs";
 *   const atlas = buildIconAtlas(loadIconData(ROOT));   // { w, h, data (RGBA), cells, order }
 *
 * The pixels are the drawer's own: a grid character is its ICON_ART colour (the runs the Frame drawer paints cover
 * exactly these pixels, in these colours -- npm run test:icons repaints every cell from them), the dimmed copy of an
 * icon is the drawer's `dim` grey of each colour (itemIcon.ts dimOf, which no tint could make), and a glyph is
 * white, for ImageColor3 to tint with the theme colour the UI asks for (white x ink = ink).
 *
 * Layout: 16 x 16 cells, the icons in data order and then their dimmed copies, in rows of COLS; the 8 x 8 glyphs in
 * a strip under them. Every cell starts on an even texel and is followed by a 2-texel transparent gutter, so neither
 * nearest-neighbour sampling nor a mip level down ever reads a neighbour. Well under Roblox's 1024 x 1024 image.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

/** side of an icon's grid and of a glyph's, in texels */
export const ICON_N = 16;
export const GLYPH_N = 8;
/** transparent texels after every cell (right and below) */
export const GUTTER = 2;
/** icon cells per row */
export const COLS = 16;
/** the largest image Roblox keeps at full size */
export const MAX_SIDE = 1024;

/** transpiles a module of src/ that needs nothing from its imports at load time, with `globals` in scope */
function loadModule(ROOT, rel, globals) {
	const ts = createRequire(import.meta.url)("typescript");
	const src = readFileSync(join(ROOT, "src", rel), "utf8");
	const js = ts.transpileModule(src, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	}).outputText;
	const exports = {};
	// the imports (the item tables) are only read inside functions the atlas never calls
	runInNewContext(js, { exports, module: { exports }, require: () => ({}), ...globals });
	return exports;
}

/** the grids and the palette: { icons: { key: rows }, glyphs: { key: rows }, art: { ch: [r, g, b] } } */
export function loadIconData(ROOT) {
	const Color3 = { fromRGB: (r, g, b) => [r, g, b] };
	const colors = loadModule(ROOT, "shared/engine/colors.ts", { Color3 });
	const data = loadModule(ROOT, "shared/data/itemIcons.ts", { Color3 });
	return { icons: data.ITEM_ICONS, glyphs: data.ICON_GLYPHS, art: colors.ICON_ART };
}

/**
 * The grey the drawer shows an art colour in when the icon is dimmed (client/ui/itemIcon.ts dimOf): the colour's
 * lightness compressed towards the middle, as the 0-255 byte the engine shows for that Color3.
 */
export function dimByte([r, g, b]) {
	const lum = (r / 255) * 0.3 + (g / 255) * 0.59 + (b / 255) * 0.11;
	const v = Math.min(1, Math.max(0, lum * 0.6 + 0.12));
	return Math.round(v * 255);
}

/**
 * The atlas: { w, h, data, cells, order }. `cells[key]` = { x, y, n, dimX, dimY } (a glyph's dimmed cell is its
 * own: the drawer ignores `dim` for a glyph, its ink wins); `order` lists the keys icons first, then glyphs.
 */
export function buildIconAtlas({ icons, glyphs, art }) {
	const iconKeys = Object.keys(icons);
	const glyphKeys = Object.keys(glyphs);
	const stride = ICON_N + GUTTER;
	const gStride = GLYPH_N + GUTTER;
	const w = COLS * stride;
	const iconRows = Math.ceil((iconKeys.length * 2) / COLS);
	const glyphCols = Math.floor(w / gStride);
	const glyphRows = Math.ceil(glyphKeys.length / glyphCols);
	const h = iconRows * stride + glyphRows * gStride;
	if (w > MAX_SIDE || h > MAX_SIDE) throw new Error(`icon atlas ${w} x ${h} is over ${MAX_SIDE} x ${MAX_SIDE}`);
	const data = Buffer.alloc(w * h * 4);
	const put = (x, y, rgb) => {
		const i = (y * w + x) * 4;
		data[i] = rgb[0];
		data[i + 1] = rgb[1];
		data[i + 2] = rgb[2];
		data[i + 3] = 255;
	};
	const paint = (key, rows, n, x0, y0, colour) => {
		if (rows.length !== n || rows.some(r => r.length !== n)) throw new Error(`icon ${key}: not ${n} x ${n}`);
		for (let y = 0; y < n; y++) {
			for (let x = 0; x < n; x++) {
				const ch = rows[y][x];
				if (ch !== ".") put(x0 + x, y0 + y, colour(ch));
			}
		}
	};
	const artOf = key => ch => {
		const c = art[ch];
		if (c === undefined) throw new Error(`icon ${key}: "${ch}" is not an ICON_ART colour`);
		return c;
	};
	const cells = {};
	const at = i => [(i % COLS) * stride, Math.floor(i / COLS) * stride];
	iconKeys.forEach((key, i) => {
		const [x, y] = at(i);
		const [dimX, dimY] = at(iconKeys.length + i);
		paint(key, icons[key], ICON_N, x, y, artOf(key));
		const colour = artOf(key);
		paint(key, icons[key], ICON_N, dimX, dimY, ch => {
			const g = dimByte(colour(ch));
			return [g, g, g];
		});
		cells[key] = { x, y, n: ICON_N, dimX, dimY };
	});
	const WHITE = [255, 255, 255];
	glyphKeys.forEach((key, i) => {
		const x = (i % glyphCols) * gStride;
		const y = iconRows * stride + Math.floor(i / glyphCols) * gStride;
		paint(key, glyphs[key], GLYPH_N, x, y, () => WHITE);
		cells[key] = { x, y, n: GLYPH_N, dimX: x, dimY: y };
	});
	return { w, h, data, cells, order: [...iconKeys, ...glyphKeys] };
}
