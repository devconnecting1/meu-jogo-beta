/*
 * A software rasteriser for the fake Roblox GUI tree of tools/fake-gui.mjs: it paints what the engine would show
 * for the sprites shared/engine/renderer.ts left visible -- Frames (background, UICorner, UIStroke drawn outside
 * the border), their child ImageLabels (Stretch, Tile with TileSize, 9-slice with SliceCenter / SliceScale,
 * ImageRectOffset / Size, ImageColor3, ImageTransparency, Pixelated or bilinear) -- in ZIndex order (siblings,
 * ties in child order), then the LightMap's gradient strips on top.
 *
 *   import { rasterise, countSprites } from "./gui-raster.mjs";
 *   const img = rasterise({ layer, dark, vw, vh }, COLORS.bg, id => decodedImage);   // RGBA { w, h, data }
 *
 * `resolve(id)` answers the decoded image ({ w, h, data }, RGBA) of a content id; an unknown one is painted
 * magenta, so a missing texture is impossible to miss. Used by tools/render-map.mjs and tools/test-world-art.mjs.
 */

const MAGENTA = { w: 1, h: 1, data: Buffer.from([255, 0, 255, 255]) };

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

function sdRoundBox(px, py, hw, hh, r) {
	const qx = Math.abs(px) - (hw - r);
	const qy = Math.abs(py) - (hh - r);
	const ox = Math.max(qx, 0);
	const oy = Math.max(qy, 0);
	return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

class Canvas {
	constructor(w, h, bg) {
		this.w = w;
		this.h = h;
		this.px = new Float32Array(w * h * 3);
		for (let i = 0; i < w * h; i++) {
			this.px[i * 3] = bg.R;
			this.px[i * 3 + 1] = bg.G;
			this.px[i * 3 + 2] = bg.B;
		}
	}
	blend(i, r, g, b, a) {
		if (a <= 0) return;
		const k = i * 3;
		this.px[k] += (r - this.px[k]) * a;
		this.px[k + 1] += (g - this.px[k + 1]) * a;
		this.px[k + 2] += (b - this.px[k + 2]) * a;
	}
	toRGBA() {
		const data = Buffer.alloc(this.w * this.h * 4);
		for (let i = 0; i < this.w * this.h; i++) {
			data[i * 4] = Math.round(clamp01(this.px[i * 3]) * 255);
			data[i * 4 + 1] = Math.round(clamp01(this.px[i * 3 + 1]) * 255);
			data[i * 4 + 2] = Math.round(clamp01(this.px[i * 3 + 2]) * 255);
			data[i * 4 + 3] = 255;
		}
		return { w: this.w, h: this.h, data };
	}
}

/** texel of the label's image at (u, v) px inside a w x h label, per its ScaleType; returns [r, g, b, a] 0..1 */
function sampler(label, w, h, resolve) {
	const img = resolve(label.Image) ?? MAGENTA;
	const rs = label.ImageRectSize;
	const ro = label.ImageRectOffset;
	const rw = rs.X > 0 ? rs.X : img.w;
	const rh = rs.Y > 0 ? rs.Y : img.h;
	const ox = rs.X > 0 ? ro.X : 0;
	const oy = rs.Y > 0 ? ro.Y : 0;
	const type = label.ScaleType.Name;
	const pixelated = label.ResampleMode.Name === "Pixelated";
	const out = [0, 0, 0, 0];
	const texel = (tx, ty) => {
		// clamped to the rect: the engine never reads outside ImageRect
		const x = Math.min(ox + rw - 1, Math.max(ox, tx));
		const y = Math.min(oy + rh - 1, Math.max(oy, ty));
		return (Math.min(img.h - 1, y) * img.w + Math.min(img.w - 1, x)) * 4;
	};
	const fetch = (fx, fy) => {
		if (pixelated) {
			const i = texel(Math.floor(fx), Math.floor(fy));
			out[0] = img.data[i] / 255;
			out[1] = img.data[i + 1] / 255;
			out[2] = img.data[i + 2] / 255;
			out[3] = img.data[i + 3] / 255;
			return out;
		}
		const x0 = Math.floor(fx - 0.5);
		const y0 = Math.floor(fy - 0.5);
		const ax = fx - 0.5 - x0;
		const ay = fy - 0.5 - y0;
		let r = 0;
		let g = 0;
		let b = 0;
		let a = 0;
		for (const [dx, dy, k] of [
			[0, 0, (1 - ax) * (1 - ay)],
			[1, 0, ax * (1 - ay)],
			[0, 1, (1 - ax) * ay],
			[1, 1, ax * ay],
		]) {
			const i = texel(x0 + dx, y0 + dy);
			const al = img.data[i + 3] / 255;
			r += (img.data[i] / 255) * al * k;
			g += (img.data[i + 1] / 255) * al * k;
			b += (img.data[i + 2] / 255) * al * k;
			a += al * k;
		}
		out[0] = a > 0 ? r / a : 0;
		out[1] = a > 0 ? g / a : 0;
		out[2] = a > 0 ? b / a : 0;
		out[3] = a;
		return out;
	};
	if (type === "Tile") {
		const ts = label.TileSize;
		const tw = ts.X.Scale * w + ts.X.Offset || w;
		const th = ts.Y.Scale * h + ts.Y.Offset || h;
		return (u, v) => {
			const fu = (((u % tw) + tw) % tw) / tw;
			const fv = (((v % th) + th) % th) / th;
			return fetch(ox + fu * rw, oy + fv * rh);
		};
	}
	if (type === "Slice") {
		const sc = label.SliceCenter;
		const s = label.SliceScale;
		const x0 = sc.Min.X;
		const y0 = sc.Min.Y;
		const x1 = sc.Max.X;
		const y1 = sc.Max.Y;
		const map = (p, size, a0, a1, total) => {
			let left = a0 * s;
			let right = (total - a1) * s;
			if (left + right > size && left + right > 0) {
				const k = size / (left + right);
				left *= k;
				right *= k;
			}
			if (p < left) return (p / left) * a0;
			if (p >= size - right) return a1 + ((p - (size - right)) / right) * (total - a1);
			const mid = size - left - right;
			return a0 + ((p - left) / Math.max(mid, 1e-6)) * (a1 - a0);
		};
		return (u, v) => fetch(ox + map(u, w, x0, x1, rw), oy + map(v, h, y0, y1, rh));
	}
	return (u, v) => fetch(ox + (u / w) * rw, oy + (v / h) * rh);
}

function rasterSprite(cv, f, resolve) {
	const sx = f.Size.X.Offset;
	const sy = f.Size.Y.Offset;
	const ax = f.AnchorPoint.X;
	const ay = f.AnchorPoint.Y;
	const cx = f.Position.X.Offset + (0.5 - ax) * sx;
	const cy = f.Position.Y.Offset + (0.5 - ay) * sy;
	const rot = (f.Rotation * Math.PI) / 180;
	const c = Math.cos(rot);
	const s = Math.sin(rot);
	const hw = sx / 2;
	const hh = sy / 2;
	const kids = f.GetChildren();
	const corner = kids.find(k => k.ClassName === "UICorner");
	const stroke = kids.find(k => k.ClassName === "UIStroke" && k.Enabled);
	const labels = kids.filter(
		k => (k.ClassName === "ImageLabel" || k.ClassName === "ImageButton") && k.Visible !== false && k.Image !== "",
	);
	let r = 0;
	if (corner !== undefined) {
		r = corner.CornerRadius.Scale * Math.min(sx, sy) + corner.CornerRadius.Offset;
		r = Math.max(0, Math.min(r, Math.min(hw, hh)));
	}
	const bgA = 1 - f.BackgroundTransparency;
	const t = stroke !== undefined ? stroke.Thickness : 0;
	const stA = stroke !== undefined ? 1 - stroke.Transparency : 0;
	const bg = f.BackgroundColor3;
	const ext = Math.abs(c) * hw + Math.abs(s) * hh + t + 2;
	const ext2 = Math.abs(s) * hw + Math.abs(c) * hh + t + 2;
	const x0 = Math.max(0, Math.floor(cx - ext));
	const x1 = Math.min(cv.w - 1, Math.ceil(cx + ext));
	const y0 = Math.max(0, Math.floor(cy - ext2));
	const y1 = Math.min(cv.h - 1, Math.ceil(cy + ext2));
	const imgs = labels.map(l => ({
		sample: sampler(l, sx, sy, resolve),
		tint: l.ImageColor3,
		a: 1 - l.ImageTransparency,
		// the label's own rect inside the frame (the renderer fills the frame; an offset is honoured anyway)
		lx: l.Position.X.Scale * sx + l.Position.X.Offset,
		ly: l.Position.Y.Scale * sy + l.Position.Y.Offset,
		lw: l.Size.X.Scale * sx + l.Size.X.Offset,
		lh: l.Size.Y.Scale * sy + l.Size.Y.Offset,
	}));
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const dx = x + 0.5 - cx;
			const dy = y + 0.5 - cy;
			const lx = dx * c + dy * s;
			const ly = -dx * s + dy * c;
			const d = sdRoundBox(lx, ly, hw, hh, r);
			const i = y * cv.w + x;
			if (bgA > 0) {
				const cov = clamp01(0.5 - d);
				if (cov > 0) cv.blend(i, bg.R, bg.G, bg.B, bgA * cov);
			}
			for (const im of imgs) {
				if (im.a <= 0) continue;
				const u = lx + hw - im.lx;
				const v = ly + hh - im.ly;
				const di = sdRoundBox(u - im.lw / 2, v - im.lh / 2, im.lw / 2, im.lh / 2, 0);
				const cov = clamp01(0.5 - di);
				if (cov <= 0) continue;
				const px = im.sample(Math.min(im.lw - 1e-6, Math.max(0, u)), Math.min(im.lh - 1e-6, Math.max(0, v)));
				cv.blend(i, px[0] * im.tint.R, px[1] * im.tint.G, px[2] * im.tint.B, px[3] * im.a * cov);
			}
			if (t > 0 && stA > 0) {
				const ring = clamp01(0.5 - (d - t)) - clamp01(0.5 - d);
				if (ring > 0) cv.blend(i, stroke.Color.R, stroke.Color.G, stroke.Color.B, ring * stA);
			}
		}
	}
}

/** the light map's strips: a Frame of the night colour whose UIGradient carries the transparency across */
function rasterStrip(cv, f) {
	const x0 = f.Position.X.Offset;
	const y0 = f.Position.Y.Offset;
	const w = f.Size.X.Offset;
	const h = f.Size.Y.Offset;
	const grad = f.GetChildren().find(k => k.ClassName === "UIGradient");
	const keys =
		grad !== undefined
			? grad.Transparency.Keypoints
			: [
					{ Time: 0, Value: 0 },
					{ Time: 1, Value: 0 },
				];
	const col = f.BackgroundColor3;
	const base = 1 - f.BackgroundTransparency;
	let k = 0;
	for (let x = Math.max(0, x0); x < Math.min(cv.w, x0 + w); x++) {
		const tt = (x + 0.5 - x0) / w;
		while (k < keys.length - 2 && keys[k + 1].Time < tt) k++;
		const a = keys[k];
		const b = keys[Math.min(keys.length - 1, k + 1)];
		const f01 = b.Time > a.Time ? clamp01((tt - a.Time) / (b.Time - a.Time)) : 0;
		const transp = a.Value + (b.Value - a.Value) * f01;
		const alpha = base * (1 - transp);
		for (let y = Math.max(0, y0); y < Math.min(cv.h, y0 + h); y++)
			cv.blend(y * cv.w + x, col.R, col.G, col.B, alpha);
	}
}

const visible = inst => inst.Visible !== false;

/**
 * Paints the sprite layer (and, when given, the light map's layer) of a drawn frame.
 * @param drawn { layer, dark?, vw, vh }: the Renderer's layer, the Frame the LightMap lives in, the view size
 */
export function rasterise(drawn, bgColor, resolve) {
	const cv = new Canvas(drawn.vw, drawn.vh, bgColor);
	const sprites = drawn.layer.GetChildren().filter(visible);
	// ZIndexBehavior.Sibling: siblings by ZIndex, ties in child order (Array.prototype.sort is stable)
	const order = sprites.map((f, i) => ({ f, i })).sort((a, b) => a.f.ZIndex - b.f.ZIndex || a.i - b.i);
	for (const { f } of order) rasterSprite(cv, f, resolve);
	if (drawn.dark !== undefined) {
		for (const lm of drawn.dark.GetChildren().filter(visible)) {
			for (const strip of lm.GetChildren().filter(visible)) rasterStrip(cv, strip);
		}
	}
	return cv.toRGBA();
}

/** what the renderer asked of the engine on this screen: visible sprites, how many show an image, strokes, corners */
export function countSprites(layer) {
	const sprites = layer.GetChildren().filter(visible);
	let images = 0;
	let strokes = 0;
	let corners = 0;
	for (const f of sprites) {
		for (const k of f.GetChildren()) {
			if (k.ClassName === "ImageLabel" && k.Visible !== false && k.Image !== "") images++;
			else if (k.ClassName === "UIStroke" && k.Enabled) strokes++;
			else if (k.ClassName === "UICorner" && (k.CornerRadius.Scale > 0 || k.CornerRadius.Offset > 0)) corners++;
		}
	}
	return { sprites: sprites.length, images, flat: sprites.length - images, strokes, corners };
}
