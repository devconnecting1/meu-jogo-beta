/*
 * A bold pixel display font for titles and the LAST TOWN wordmark (tools/render-promo.mjs), drawn in code like the
 * 5 x 7 label font of tools/pixel-font.mjs, and styled like the town's pixel art (docs/DESIGN_RULES.md ART-02,
 * ART-08): a one-texel near-black outline round the letters, a hard shadow, a two-tone fill and a lit top edge
 * (the light comes from the top left, as everywhere in the game).
 *
 *   import { layoutText, drawTitle, TITLE_H } from "./title-font.mjs";
 *   const m = layoutText("SURVIVE THE NIGHT");                  // a 0/1 mask in font pixels: { w, h, bits }
 *   drawTitle(img, m, x, y, 12, { top: [240, 232, 212], bottom: [214, 200, 172] });
 *
 * Glyphs are 10 font pixels tall with 2-pixel stems (a chunky display weight that survives being shrunk to a phone
 * thumbnail), variable width, upper case only; anything missing is a space.
 */

/** cap height of every glyph, in font pixels */
export const TITLE_H = 10;
/** font pixels between two letters, and the width of a space */
export const LETTER_GAP = 2;
export const SPACE_W = 6;

const G = rows => rows.map(r => r.replace(/ /g, ""));

export const TITLE_FONT = {
	A: G([
		"..####..",
		".######.",
		"###..###",
		"##....##",
		"##....##",
		"########",
		"########",
		"##....##",
		"##....##",
		"##....##",
	]),
	B: G([
		"#######.",
		"########",
		"##....##",
		"##...###",
		"#######.",
		"#######.",
		"##...###",
		"##....##",
		"########",
		"#######.",
	]),
	C: G([
		".######",
		"#######",
		"###....",
		"##.....",
		"##.....",
		"##.....",
		"##.....",
		"###....",
		"#######",
		".######",
	]),
	D: G([
		"######..",
		"#######.",
		"##...###",
		"##....##",
		"##....##",
		"##....##",
		"##....##",
		"##...###",
		"#######.",
		"######..",
	]),
	E: G([
		"#######",
		"#######",
		"##.....",
		"##.....",
		"######.",
		"######.",
		"##.....",
		"##.....",
		"#######",
		"#######",
	]),
	F: G([
		"#######",
		"#######",
		"##.....",
		"##.....",
		"######.",
		"######.",
		"##.....",
		"##.....",
		"##.....",
		"##.....",
	]),
	G: G([
		".#######",
		"########",
		"###.....",
		"##......",
		"##..####",
		"##..####",
		"##....##",
		"###...##",
		"########",
		".######.",
	]),
	H: G([
		"##....##",
		"##....##",
		"##....##",
		"##....##",
		"########",
		"########",
		"##....##",
		"##....##",
		"##....##",
		"##....##",
	]),
	I: G(["######", "######", "..##..", "..##..", "..##..", "..##..", "..##..", "..##..", "######", "######"]),
	J: G([
		"..######",
		"..######",
		"......##",
		"......##",
		"......##",
		"......##",
		"##....##",
		"###..###",
		"#######.",
		".#####..",
	]),
	K: G([
		"##....##",
		"##...###",
		"##..###.",
		"##.###..",
		"#####...",
		"#####...",
		"##.###..",
		"##..###.",
		"##...###",
		"##....##",
	]),
	L: G([
		"##.....",
		"##.....",
		"##.....",
		"##.....",
		"##.....",
		"##.....",
		"##.....",
		"##.....",
		"#######",
		"#######",
	]),
	M: G([
		"###....###",
		"####..####",
		"##########",
		"##.####.##",
		"##..##..##",
		"##......##",
		"##......##",
		"##......##",
		"##......##",
		"##......##",
	]),
	N: G([
		"##....##",
		"###...##",
		"####..##",
		"#####.##",
		"##.#####",
		"##..####",
		"##...###",
		"##....##",
		"##....##",
		"##....##",
	]),
	O: G([
		".######.",
		"########",
		"###..###",
		"##....##",
		"##....##",
		"##....##",
		"##....##",
		"###..###",
		"########",
		".######.",
	]),
	P: G([
		"#######.",
		"########",
		"##....##",
		"##....##",
		"########",
		"#######.",
		"##......",
		"##......",
		"##......",
		"##......",
	]),
	Q: G([
		".######.",
		"########",
		"###..###",
		"##....##",
		"##....##",
		"##....##",
		"##.##.##",
		"###.####",
		"########",
		".####.##",
	]),
	R: G([
		"#######.",
		"########",
		"##....##",
		"##....##",
		"########",
		"#######.",
		"##.###..",
		"##..###.",
		"##...###",
		"##....##",
	]),
	S: G([
		".#######",
		"########",
		"##......",
		"###.....",
		"#######.",
		".#######",
		".....###",
		"......##",
		"########",
		"#######.",
	]),
	T: G([
		"########",
		"########",
		"...##...",
		"...##...",
		"...##...",
		"...##...",
		"...##...",
		"...##...",
		"...##...",
		"...##...",
	]),
	U: G([
		"##....##",
		"##....##",
		"##....##",
		"##....##",
		"##....##",
		"##....##",
		"##....##",
		"###..###",
		"########",
		".######.",
	]),
	V: G([
		"##....##",
		"##....##",
		"##....##",
		"##....##",
		"##....##",
		"###..###",
		".##..##.",
		".######.",
		"..####..",
		"...##...",
	]),
	W: G([
		"##......##",
		"##......##",
		"##......##",
		"##......##",
		"##..##..##",
		"##.####.##",
		"##########",
		"####..####",
		"###....###",
		"##......##",
	]),
	X: G([
		"##....##",
		"###..###",
		".######.",
		"..####..",
		"...##...",
		"...##...",
		"..####..",
		".######.",
		"###..###",
		"##....##",
	]),
	Y: G([
		"##....##",
		"##....##",
		"###..###",
		".######.",
		"..####..",
		"...##...",
		"...##...",
		"...##...",
		"...##...",
		"...##...",
	]),
	Z: G([
		"########",
		"########",
		".....###",
		"....###.",
		"...###..",
		"..###...",
		".###....",
		"###.....",
		"########",
		"########",
	]),
	0: G([
		".######.",
		"########",
		"###..###",
		"##...###",
		"##..####",
		"####..##",
		"###...##",
		"###..###",
		"########",
		".######.",
	]),
	1: G(["..##..", ".###..", "####..", "..##..", "..##..", "..##..", "..##..", "..##..", "######", "######"]),
	2: G([
		".######.",
		"########",
		"##....##",
		"......##",
		"....####",
		"..####..",
		".###....",
		"###.....",
		"########",
		"########",
	]),
	3: G([
		"#######.",
		"########",
		"......##",
		"......##",
		"..#####.",
		"..#####.",
		"......##",
		"......##",
		"########",
		"#######.",
	]),
	4: G([
		"....###.",
		"...####.",
		"..##.##.",
		".##..##.",
		"##...##.",
		"########",
		"########",
		".....##.",
		".....##.",
		".....##.",
	]),
	5: G([
		"########",
		"########",
		"##......",
		"##......",
		"#######.",
		"########",
		"......##",
		"......##",
		"########",
		"#######.",
	]),
	6: G([
		".######.",
		"#######.",
		"##......",
		"##......",
		"#######.",
		"########",
		"##....##",
		"##....##",
		"########",
		".######.",
	]),
	7: G([
		"########",
		"########",
		".....###",
		"....###.",
		"...###..",
		"..###...",
		"..##....",
		"..##....",
		"..##....",
		"..##....",
	]),
	8: G([
		".######.",
		"########",
		"##....##",
		"##....##",
		".######.",
		".######.",
		"##....##",
		"##....##",
		"########",
		".######.",
	]),
	9: G([
		".######.",
		"########",
		"##....##",
		"##....##",
		"########",
		".#######",
		"......##",
		"......##",
		".#######",
		".######.",
	]),
	".": G(["..", "..", "..", "..", "..", "..", "..", "..", "##", "##"]),
	",": G(["..", "..", "..", "..", "..", "..", "..", "##", "##", "#."]),
	"!": G(["##", "##", "##", "##", "##", "##", "..", "..", "##", "##"]),
	"'": G(["##", "##", "#.", "..", "..", "..", "..", "..", "..", ".."]),
	"-": G(["......", "......", "......", "......", "######", "######", "......", "......", "......", "......"]),
	":": G(["..", "..", "##", "##", "..", "..", "..", "##", "##", ".."]),
};

/**
 * The 0/1 mask of `text` in font pixels (one line), `gap` font pixels between letters. Unknown characters are
 * spaces. Returned as { w, h, bits } with bits[y * w + x] = 1 where a letter is.
 */
export function layoutText(text, gap = LETTER_GAP) {
	const glyphs = [];
	let w = 0;
	for (const ch of text.toUpperCase()) {
		const g = TITLE_FONT[ch];
		if (g === undefined) {
			glyphs.push({ g: undefined, w: SPACE_W });
			w += SPACE_W;
			continue;
		}
		if (glyphs.length > 0 && glyphs[glyphs.length - 1].g !== undefined) w += gap;
		glyphs.push({ g, w: g[0].length, at: w });
		w += g[0].length;
	}
	const h = TITLE_H;
	const bits = new Uint8Array(Math.max(1, w) * h);
	let x = 0;
	let prevGlyph = false;
	for (const item of glyphs) {
		if (item.g === undefined) {
			x += item.w;
			prevGlyph = false;
			continue;
		}
		if (prevGlyph) x += gap;
		for (let r = 0; r < h; r++) {
			for (let c = 0; c < item.w; c++) if (item.g[r][c] === "#") bits[r * w + x + c] = 1;
		}
		x += item.w;
		prevGlyph = true;
	}
	return { w, h, bits };
}

/** a mask grown by `n` font pixels in the 8 directions (the outline ring of the pixel-art style) */
export function dilate(m, n = 1) {
	const w = m.w + n * 2;
	const h = m.h + n * 2;
	const bits = new Uint8Array(w * h);
	for (let y = 0; y < m.h; y++) {
		for (let x = 0; x < m.w; x++) {
			if (m.bits[y * m.w + x] === 0) continue;
			for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) bits[(y + n + dy) * w + x + n + dx] = 1;
		}
	}
	return { w, h, bits };
}

/** several one-line masks stacked, each centred (or left-aligned) on the widest, `lead` font pixels apart */
export function stackMasks(masks, lead = 3, align = "center") {
	const w = Math.max(...masks.map(m => m.w));
	const h = masks.reduce((s, m) => s + m.h, 0) + lead * (masks.length - 1);
	const bits = new Uint8Array(w * h);
	let y0 = 0;
	for (const m of masks) {
		const x0 = align === "center" ? Math.floor((w - m.w) / 2) : 0;
		for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) bits[(y0 + y) * w + x0 + x] = m.bits[y * m.w + x];
		y0 += m.h + lead;
	}
	return { w, h, bits };
}

function put(img, X, Y, rgb, a) {
	if (X < 0 || Y < 0 || X >= img.w || Y >= img.h || a <= 0) return;
	const i = (Y * img.w + X) * 4;
	if (a >= 1 || img.data[i + 3] === 0) {
		// onto an empty (transparent) pixel the colour is taken as it is, with its own alpha
		const under = img.data[i + 3] / 255;
		if (a >= 1 || under === 0) {
			img.data[i] = rgb[0];
			img.data[i + 1] = rgb[1];
			img.data[i + 2] = rgb[2];
			img.data[i + 3] = Math.round(Math.max(a, under) * 255);
			return;
		}
	}
	const under = img.data[i + 3] / 255;
	const out = a + under * (1 - a);
	for (let c = 0; c < 3; c++) {
		img.data[i + c] = Math.round((rgb[c] * a + img.data[i + c] * under * (1 - a)) / Math.max(out, 1e-6));
	}
	img.data[i + 3] = Math.round(out * 255);
}

function fillCell(img, x, y, px, rgb, a) {
	for (let dy = 0; dy < px; dy++) for (let dx = 0; dx < px; dx++) put(img, x + dx, y + dy, rgb, a);
}

/**
 * Paints mask `m` into RGBA `img` with its top-left letter pixel at (x, y), `px` screen pixels per font pixel,
 * in the town's pixel-art style:
 *   style.top / style.bottom   the fill above and below `split` (0..1 of the height; default: the upper half)
 *   style.light                the lit top edge (a letter pixel with nothing above it); default: none
 *   style.outline              the one-font-pixel ring round the letters (default near-black), `outlineWidth` wide
 *   style.shadow               a hard shadow of the outlined shape, `shadowX` / `shadowY` font pixels away, `shadowA`
 * `style.rowColor(row)` overrides top / bottom per mask row (a gradient); `style.lineH` is the height of one line
 * of letters in a stacked mask (TITLE_H + lead), so the split is taken per line.
 * Returns the painted box in screen pixels { x, y, w, h } (outline and shadow included).
 */
export function drawTitle(img, m, x, y, px, style = {}) {
	const outline = style.outline ?? [16, 12, 18];
	const ow = style.outlineWidth ?? 1;
	const sx = style.shadowX ?? 1;
	const sy = style.shadowY ?? 1;
	const sa = style.shadowA ?? 0.85;
	const shadow = style.shadow ?? [0, 0, 0];
	const split = style.split ?? 0.5;
	const ring = dilate(m, ow);
	if (sa > 0 && (sx !== 0 || sy !== 0)) {
		for (let yy = 0; yy < ring.h; yy++) {
			for (let xx = 0; xx < ring.w; xx++) {
				if (ring.bits[yy * ring.w + xx] === 0) continue;
				fillCell(img, x + (xx - ow + sx) * px, y + (yy - ow + sy) * px, px, shadow, sa);
			}
		}
	}
	for (let yy = 0; yy < ring.h; yy++) {
		for (let xx = 0; xx < ring.w; xx++) {
			if (ring.bits[yy * ring.w + xx] === 0) continue;
			fillCell(img, x + (xx - ow) * px, y + (yy - ow) * px, px, outline, 1);
		}
	}
	const top = style.top ?? [240, 232, 212];
	const bottom = style.bottom ?? top;
	for (let yy = 0; yy < m.h; yy++) {
		// rows of a stacked mask repeat every TITLE_H + lead; the split is taken per line of letters
		const row = yy % (style.lineH ?? m.h);
		const k = row / (style.lineH ?? m.h);
		for (let xx = 0; xx < m.w; xx++) {
			if (m.bits[yy * m.w + xx] === 0) continue;
			let rgb = style.rowColor !== undefined ? style.rowColor(row) : k < split ? top : bottom;
			if (style.light !== undefined && (yy === 0 || m.bits[(yy - 1) * m.w + xx] === 0)) rgb = style.light;
			fillCell(img, x + xx * px, y + yy * px, px, rgb, 1);
		}
	}
	return {
		x: x - ow * px + Math.min(0, sx) * px,
		y: y - ow * px + Math.min(0, sy) * px,
		w: (m.w + ow * 2 + Math.abs(sx)) * px,
		h: (m.h + ow * 2 + Math.abs(sy)) * px,
	};
}
