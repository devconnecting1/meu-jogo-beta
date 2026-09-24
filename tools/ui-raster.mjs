/*
 * Paints what tools/ui-layout.mjs `paintList` says a renderer draws -- rects, strokes, images (an atlas cell,
 * Pixelated or not, a 9-slice) and text -- into an RGBA canvas, in screen pixels, so a suite can LOOK at a piece of
 * the kit the way the engine shows it (the HUD's hotbar tiles: tools/test-hud.mjs part 7, tools/render-hotbar.mjs).
 *
 *   import { rasterPaint, upscale } from "./ui-raster.mjs";
 *   const img = rasterPaint(paintList(tile), { x, y, w, h }, [22, 20, 24], id => decodedImage);
 *   writeFileSync("tile.png", encodePNG(upscale(img, 4), true));
 *
 * A rect covers the pixels whose CENTRE falls inside it (a fractional edge rounds to the nearest pixel, as the engine
 * snaps a GuiObject), clipped by its `clip`. A Pixelated image samples its texel at the pixel centre (nearest), a
 * bilinear one is sampled the same way (only the atlas matters here, and it is Pixelated). Text is drawn with the 5 x 7
 * pixel font of tools/pixel-font.mjs, sized from the label's px and aligned like the label: good enough to see where a
 * legend sits, not the engine's font. `resolve(id)` returns a decoded image ({ w, h, data } RGBA) or undefined (then
 * the image is left out).
 */
import { FONT } from "./pixel-font.mjs";

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/** the pixel span [a, b) whose centres fall in [x, x + w) */
function span(x, w) {
	return [Math.ceil(x - 0.5), Math.ceil(x + w - 0.5)];
}

function blend(img, i, rgb, a) {
	if (a <= 0) return;
	const k = i * 4;
	const d = img.data;
	d[k] = Math.round(d[k] + (rgb[0] - d[k]) * a);
	d[k + 1] = Math.round(d[k + 1] + (rgb[1] - d[k + 1]) * a);
	d[k + 2] = Math.round(d[k + 2] + (rgb[2] - d[k + 2]) * a);
	d[k + 3] = Math.round(d[k + 3] + (255 - d[k + 3]) * a);
}

/** calls `fn(px, py, i)` for every canvas pixel of rect `r` (screen px) inside its clip and the view */
function eachPixel(img, view, r, fn) {
	const [x0, x1] = span(r.x - view.x, r.w);
	const [y0, y1] = span(r.y - view.y, r.h);
	let cx0 = 0;
	let cy0 = 0;
	let cx1 = img.w;
	let cy1 = img.h;
	if (r.clip !== undefined) {
		const [a, b] = span(r.clip[0] - view.x, r.clip[2] - r.clip[0]);
		const [c, d] = span(r.clip[1] - view.y, r.clip[3] - r.clip[1]);
		cx0 = Math.max(cx0, a);
		cx1 = Math.min(cx1, b);
		cy0 = Math.max(cy0, c);
		cy1 = Math.min(cy1, d);
	}
	for (let y = Math.max(y0, cy0); y < Math.min(y1, cy1); y++) {
		for (let x = Math.max(x0, cx0); x < Math.min(x1, cx1); x++) fn(x, y, y * img.w + x);
	}
}

/** a 9-slice's source coordinate for `p` of `size` px, the rect being `total` texels with a centre [a0, a1) */
function sliceMap(p, size, a0, a1, total, s) {
	let left = a0 * s;
	let right = (total - a1) * s;
	if (left + right > size && left + right > 0) {
		const k = size / (left + right);
		left *= k;
		right *= k;
	}
	if (p < left) return (p / left) * a0;
	if (p >= size - right) return a1 + ((p - (size - right)) / right) * (total - a1);
	return a0 + ((p - left) / Math.max(size - left - right, 1e-6)) * (a1 - a0);
}

function paintImage(img, view, e, resolve) {
	const src = resolve(e.image);
	if (src === undefined) return;
	const [ox, oy] = e.rectSize[0] > 0 ? e.rectOffset : [0, 0];
	const rw = e.rectSize[0] > 0 ? e.rectSize[0] : src.w;
	const rh = e.rectSize[1] > 0 ? e.rectSize[1] : src.h;
	const sliced = e.slice[2] > e.slice[0] && e.slice[3] > e.slice[1];
	eachPixel(img, view, e, (x, y, i) => {
		const u = x + view.x + 0.5 - e.x;
		const v = y + view.y + 0.5 - e.y;
		const fu = sliced ? sliceMap(u, e.w, e.slice[0], e.slice[2], rw, e.sliceScale) : (u / e.w) * rw;
		const fv = sliced ? sliceMap(v, e.h, e.slice[1], e.slice[3], rh, e.sliceScale) : (v / e.h) * rh;
		const tx = Math.min(ox + rw - 1, Math.max(ox, ox + Math.floor(fu)));
		const ty = Math.min(oy + rh - 1, Math.max(oy, oy + Math.floor(fv)));
		const s = (Math.min(src.h - 1, ty) * src.w + Math.min(src.w - 1, tx)) * 4;
		const a = (src.data[s + 3] / 255) * e.alpha;
		if (a <= 0) return;
		const rgb = [
			(src.data[s] * e.tint[0]) / 255,
			(src.data[s + 1] * e.tint[1]) / 255,
			(src.data[s + 2] * e.tint[2]) / 255,
		];
		blend(img, i, rgb, a);
	});
}

function paintText(img, view, e) {
	const text = String(e.text).toUpperCase();
	// font pixels per glyph pixel: the 7-row glyph about as tall as the label's cap height
	const g = Math.max(1, Math.round((e.px * 0.72) / 7));
	const tw = text.length * 6 * g - g;
	const th = 7 * g;
	const bx = e.x - view.x;
	const by = e.y - view.y;
	const x = e.alignX === "Left" ? bx : e.alignX === "Right" ? bx + e.w - tw : bx + (e.w - tw) / 2;
	const y = e.alignY === "Top" ? by : e.alignY === "Bottom" ? by + e.h - th : by + (e.h - th) / 2;
	const X = Math.round(x);
	const Y = Math.round(y);
	for (let c = 0; c < text.length; c++) {
		const glyph = FONT[text[c]] ?? FONT[" "];
		for (let r = 0; r < 7; r++) {
			for (let q = 0; q < 5; q++) {
				if (glyph[r][q] !== "1") continue;
				for (let dy = 0; dy < g; dy++) {
					for (let dx = 0; dx < g; dx++) {
						const px = X + (c * 6 + q) * g + dx;
						const py = Y + r * g + dy;
						if (px < 0 || py < 0 || px >= img.w || py >= img.h) continue;
						if (e.clip !== undefined) {
							const sx = px + view.x + 0.5;
							const sy = py + view.y + 0.5;
							if (sx < e.clip[0] || sx >= e.clip[2] || sy < e.clip[1] || sy >= e.clip[3]) continue;
						}
						blend(img, py * img.w + px, e.color, e.alpha);
					}
				}
			}
		}
	}
}

/**
 * Paints `list` (paintList's entries, in draw order) over `bg` ([r, g, b], or undefined: transparent) into a canvas of
 * the screen rect `view` = { x, y, w, h } (whole px).
 */
export function rasterPaint(list, view, bg, resolve = () => undefined) {
	const w = Math.round(view.w);
	const h = Math.round(view.h);
	const img = { w, h, data: Buffer.alloc(w * h * 4) };
	if (bg !== undefined) {
		for (let i = 0; i < w * h; i++) {
			img.data[i * 4] = bg[0];
			img.data[i * 4 + 1] = bg[1];
			img.data[i * 4 + 2] = bg[2];
			img.data[i * 4 + 3] = 255;
		}
	}
	for (const e of list) {
		if (e.kind === "rect") eachPixel(img, view, e, (x, y, i) => blend(img, i, e.color, clamp01(e.alpha)));
		else if (e.kind === "stroke") {
			const t = Math.max(1, Math.round(e.thickness));
			eachPixel(img, view, e, (x, y, i) => {
				const [x0, x1] = span(e.x - view.x, e.w);
				const [y0, y1] = span(e.y - view.y, e.h);
				if (x - x0 < t || x1 - 1 - x < t || y - y0 < t || y1 - 1 - y < t) blend(img, i, e.color, e.alpha);
			});
		} else if (e.kind === "image") paintImage(img, view, e, resolve);
		else if (e.kind === "text") paintText(img, view, e);
	}
	return img;
}

/** `img` scaled up `k` times, nearest neighbour (a 46 px tile is easier to judge at 4x) */
export function upscale(img, k) {
	const out = { w: img.w * k, h: img.h * k, data: Buffer.alloc(img.w * k * img.h * k * 4) };
	for (let y = 0; y < out.h; y++) {
		for (let x = 0; x < out.w; x++) {
			const s = (Math.floor(y / k) * img.w + Math.floor(x / k)) * 4;
			img.data.copy(out.data, (y * out.w + x) * 4, s, s + 4);
		}
	}
	return out;
}

/** images side by side (tops aligned), `gap` px of `bg` between them */
export function hstack(images, gap = 8, bg = [0, 0, 0]) {
	const w = images.reduce((a, im) => a + im.w, 0) + gap * Math.max(0, images.length - 1);
	const h = Math.max(...images.map(im => im.h));
	const out = { w, h, data: Buffer.alloc(w * h * 4) };
	for (let i = 0; i < w * h; i++) {
		out.data[i * 4] = bg[0];
		out.data[i * 4 + 1] = bg[1];
		out.data[i * 4 + 2] = bg[2];
		out.data[i * 4 + 3] = 255;
	}
	let x0 = 0;
	for (const im of images) {
		for (let y = 0; y < im.h; y++) im.data.copy(out.data, (y * w + x0) * 4, y * im.w * 4, (y + 1) * im.w * 4);
		x0 += im.w + gap;
	}
	return out;
}

/** images stacked (lefts aligned), `gap` px of `bg` between them */
export function vstack(images, gap = 8, bg = [0, 0, 0]) {
	const w = Math.max(...images.map(im => im.w));
	const h = images.reduce((a, im) => a + im.h, 0) + gap * Math.max(0, images.length - 1);
	const out = { w, h, data: Buffer.alloc(w * h * 4) };
	for (let i = 0; i < w * h; i++) {
		out.data[i * 4] = bg[0];
		out.data[i * 4 + 1] = bg[1];
		out.data[i * 4 + 2] = bg[2];
		out.data[i * 4 + 3] = 255;
	}
	let y0 = 0;
	for (const im of images) {
		for (let y = 0; y < im.h; y++) im.data.copy(out.data, (y0 + y) * w * 4, y * im.w * 4, (y + 1) * im.w * 4);
		y0 += im.h + gap;
	}
	return out;
}
