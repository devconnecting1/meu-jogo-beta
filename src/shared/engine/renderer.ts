import { Camera } from "./camera";

export interface SpriteOpts {
	/** size in world units (scaled by camera zoom) */
	w?: number;
	h?: number;
	color?: Color3;
	/** world heading in radians (the camera angle is added by the renderer) */
	rotation?: number;
	alpha?: number;
	zIndex?: number;
	/** rounded corners, world units; ignored when `circle` is set */
	cornerRadius?: number;
	/** perfect ellipse/circle (UICorner 50%) */
	circle?: boolean;
	/** which point of the rect sits at (wx, wy): 0..1 in the rect's own (rotated) frame, default 0.5 */
	anchorX?: number;
	anchorY?: number;
	/** outline (UIStroke) colour; no outline when undefined */
	stroke?: Color3;
	/** outline thickness in screen px (default 2) */
	strokeThickness?: number;
	/** outline opacity 0..1 (default 1) */
	strokeAlpha?: number;
}

/**
 * One pooled Frame plus the last values written to it. Every draw writes ALL properties, but only
 * the ones that changed reach the engine (Roblox property writes are the expensive part).
 */
interface Sprite {
	frame: Frame;
	corner?: UICorner;
	stroke?: UIStroke;
	visible: boolean;
	posX: number;
	posY: number;
	sizeX: number;
	sizeY: number;
	centred: boolean;
	rot: number;
	color: Color3;
	transp: number;
	z: number;
	/** -1 = circle, 0 = square, >0 = radius px */
	cornerKey: number;
	strokeOn: boolean;
	strokeColor: Color3;
	strokeThick: number;
	strokeTransp: number;
}

const DEFAULT_COLOR = Color3.fromRGB(200, 200, 200);
const BLACK = Color3.fromRGB(0, 0, 0);
const TOP_LEFT = new Vector2(0, 0);
const CENTRE = new Vector2(0.5, 0.5);

/**
 * Immediate-mode pooled GUI sprite renderer. All world visuals are Frames under one layer.
 *
 * Per frame: `beginFrame()` → any number of `drawRect()` / `acquire()` → `endFrame()`.
 * The pool is a stack with a cursor: acquire = O(1) (reuse sprites[cursor++] or create one),
 * endFrame hides only the leftovers of the previous frame. Because draw order is stable, sprite i
 * usually draws the same thing as last frame, so the property cache skips most engine writes.
 */
export class Renderer {
	readonly layer: Frame;
	private sprites: Array<Sprite> = [];
	private byFrame = new Map<Frame, Sprite>();
	/** sprites [0, cursor) are in use this frame */
	private cursor = 0;
	/** sprites [0, shown) may be visible on screen (in use last frame) */
	private shown = 0;
	private viewW = 1120;
	private viewH = 630;

	constructor(parent: GuiObject, name: string) {
		this.layer = new Instance("Frame");
		this.layer.Name = name;
		this.layer.Size = UDim2.fromScale(1, 1);
		this.layer.BackgroundTransparency = 1;
		this.layer.BorderSizePixel = 0;
		this.layer.ClipsDescendants = true;
		this.layer.Parent = parent;
	}

	setView(w: number, h: number): void {
		this.viewW = w;
		this.viewH = h;
	}

	/** number of sprites drawn so far this frame (debug/perf overlay) */
	drawCount(): number {
		return this.cursor;
	}

	/** Start a new frame: every sprite becomes reusable (nothing is hidden yet). */
	beginFrame(): void {
		this.cursor = 0;
	}

	/** Hide the sprites that were used last frame but not this one. */
	endFrame(): void {
		for (let i = this.cursor; i < this.shown; i++) {
			this.hide(this.sprites[i]);
		}
		this.shown = this.cursor;
	}

	/** Hide everything immediately (e.g. leaving the game). */
	releaseAll(): void {
		const n = math.max(this.shown, this.cursor);
		for (let i = 0; i < n; i++) {
			this.hide(this.sprites[i]);
		}
		this.cursor = 0;
		this.shown = 0;
	}

	/**
	 * A visible Frame with every property reset to defaults (white-ish, opaque, square corners,
	 * no outline, no rotation, ZIndex 1, 32×32 at 0,0). Valid until the next beginFrame().
	 */
	acquire(): Frame {
		const sp = this.next();
		this.apply(sp, 0, 0, 32, 32, false, 0, DEFAULT_COLOR, 0, 1, 0, undefined, 2, 0);
		return sp.frame;
	}

	/** Hide a sprite early (it is reused from the next frame on). O(1). */
	release(f: Frame): void {
		const sp = this.byFrame.get(f);
		if (sp !== undefined) {
			this.hide(sp);
		}
	}

	/**
	 * Draw a rect sprite centred (by default) at a world position. Axis-aligned rects are snapped
	 * to whole pixels edge-by-edge so adjacent tiles/walls never leave seams.
	 */
	drawRect(cam: Camera, wx: number, wy: number, opts: SpriteOpts): Frame {
		const sp = this.next();
		let ww = opts.w ?? 32;
		let wh = opts.h ?? 32;
		const worldRot = opts.rotation ?? 0;
		const ax = opts.anchorX ?? 0.5;
		const ay = opts.anchorY ?? 0.5;
		let cx = wx;
		let cy = wy;
		if (ax !== 0.5 || ay !== 0.5) {
			const ox = (0.5 - ax) * ww;
			const oy = (0.5 - ay) * wh;
			const c = math.cos(worldRot);
			const s = math.sin(worldRot);
			cx += ox * c - oy * s;
			cy += ox * s + oy * c;
		}
		const zoom = cam.zoom;
		const scr = cam.worldToScreen(cx, cy);
		// normalise to [0, 180): a rect rotated by 180° is the same rect; 90° is a w/h swap
		let deg = cam.spriteRotationDeg(worldRot) % 180;
		if (deg < 0) deg += 180;
		if (deg > 179.95) deg = 0;
		if (math.abs(deg - 90) < 0.05) {
			const t = ww;
			ww = wh;
			wh = t;
			deg = 0;
		}
		const pw = ww * zoom;
		const ph = wh * zoom;
		let corner = 0;
		if (opts.circle === true) {
			corner = -1;
		} else if (opts.cornerRadius !== undefined && opts.cornerRadius > 0) {
			corner = math.max(1, math.floor(opts.cornerRadius * zoom + 0.5));
		}
		const alpha = clamp01(opts.alpha ?? 1);
		const strokeAlpha = clamp01(opts.strokeAlpha ?? 1);
		if (deg < 0.05) {
			const l = math.floor(scr.x - pw * 0.5 + 0.5);
			const t = math.floor(scr.y - ph * 0.5 + 0.5);
			const r = math.floor(scr.x + pw * 0.5 + 0.5);
			const b = math.floor(scr.y + ph * 0.5 + 0.5);
			this.apply(
				sp,
				l,
				t,
				math.max(1, r - l),
				math.max(1, b - t),
				false,
				0,
				opts.color ?? DEFAULT_COLOR,
				1 - alpha,
				opts.zIndex ?? 1,
				corner,
				opts.stroke,
				opts.strokeThickness ?? 2,
				1 - strokeAlpha,
			);
		} else {
			this.apply(
				sp,
				math.floor(scr.x + 0.5),
				math.floor(scr.y + 0.5),
				math.max(1, math.floor(pw + 0.5)),
				math.max(1, math.floor(ph + 0.5)),
				true,
				deg,
				opts.color ?? DEFAULT_COLOR,
				1 - alpha,
				opts.zIndex ?? 1,
				corner,
				opts.stroke,
				opts.strokeThickness ?? 2,
				1 - strokeAlpha,
			);
		}
		return sp.frame;
	}

	/** Circle of diameter `d` (world units) centred at a world position. */
	drawCircle(cam: Camera, wx: number, wy: number, d: number, opts: SpriteOpts): Frame {
		opts.w = d;
		opts.h = d;
		opts.circle = true;
		return this.drawRect(cam, wx, wy, opts);
	}

	/** Thick line between two world points (`opts.h` = thickness, default 3). */
	drawSegment(cam: Camera, x1: number, y1: number, x2: number, y2: number, opts: SpriteOpts): Frame | undefined {
		const dx = x2 - x1;
		const dy = y2 - y1;
		const len = math.sqrt(dx * dx + dy * dy);
		if (len < 0.5) return undefined;
		opts.w = len;
		opts.h = opts.h ?? 3;
		opts.rotation = math.atan2(dy, dx);
		return this.drawRect(cam, (x1 + x2) * 0.5, (y1 + y2) * 0.5, opts);
	}

	private next(): Sprite {
		let sp = this.sprites[this.cursor];
		if (sp === undefined) {
			sp = this.create();
			this.sprites.push(sp);
		}
		this.cursor++;
		return sp;
	}

	private create(): Sprite {
		const f = new Instance("Frame");
		f.Name = "S";
		f.BorderSizePixel = 0;
		f.AnchorPoint = TOP_LEFT;
		f.Position = UDim2.fromOffset(0, 0);
		f.Size = UDim2.fromOffset(1, 1);
		f.BackgroundColor3 = DEFAULT_COLOR;
		f.BackgroundTransparency = 0;
		f.Rotation = 0;
		f.ZIndex = 1;
		f.Visible = false;
		f.Parent = this.layer;
		const sp: Sprite = {
			frame: f,
			visible: false,
			posX: 0,
			posY: 0,
			sizeX: 1,
			sizeY: 1,
			centred: false,
			rot: 0,
			color: DEFAULT_COLOR,
			transp: 0,
			z: 1,
			cornerKey: 0,
			strokeOn: false,
			strokeColor: BLACK,
			strokeThick: 2,
			strokeTransp: 0,
		};
		this.byFrame.set(f, sp);
		return sp;
	}

	private hide(sp: Sprite): void {
		if (sp.visible) {
			sp.visible = false;
			sp.frame.Visible = false;
		}
	}

	/** Write every property of the sprite (only changed values reach the engine). */
	private apply(
		sp: Sprite,
		px: number,
		py: number,
		sx: number,
		sy: number,
		centred: boolean,
		rot: number,
		color: Color3,
		transp: number,
		z: number,
		cornerKey: number,
		stroke: Color3 | undefined,
		strokeThick: number,
		strokeTransp: number,
	): void {
		const f = sp.frame;
		if (sp.centred !== centred) {
			sp.centred = centred;
			f.AnchorPoint = centred ? CENTRE : TOP_LEFT;
		}
		if (sp.posX !== px || sp.posY !== py) {
			sp.posX = px;
			sp.posY = py;
			f.Position = UDim2.fromOffset(px, py);
		}
		if (sp.sizeX !== sx || sp.sizeY !== sy) {
			sp.sizeX = sx;
			sp.sizeY = sy;
			f.Size = UDim2.fromOffset(sx, sy);
		}
		if (sp.rot !== rot) {
			sp.rot = rot;
			f.Rotation = rot;
		}
		if (sp.color !== color) {
			sp.color = color;
			f.BackgroundColor3 = color;
		}
		if (sp.transp !== transp) {
			sp.transp = transp;
			f.BackgroundTransparency = transp;
		}
		if (sp.z !== z) {
			sp.z = z;
			f.ZIndex = z;
		}
		// UICorner: always reset — a reused frame must never keep another sprite's rounding
		if (sp.cornerKey !== cornerKey) {
			sp.cornerKey = cornerKey;
			let c = sp.corner;
			if (c === undefined) {
				c = new Instance("UICorner");
				c.Parent = f;
				sp.corner = c;
			}
			c.CornerRadius = cornerKey < 0 ? new UDim(0.5, 0) : new UDim(0, cornerKey);
		}
		// UIStroke: created lazily, disabled (not destroyed) when unused
		const strokeOn = stroke !== undefined;
		if (strokeOn || sp.strokeOn) {
			let st = sp.stroke;
			if (st === undefined) {
				st = new Instance("UIStroke");
				st.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
				// engine defaults differ (Thickness 1): write the cached values so cache == instance
				st.Color = sp.strokeColor;
				st.Thickness = sp.strokeThick;
				st.Transparency = sp.strokeTransp;
				st.Enabled = false;
				st.Parent = f;
				sp.stroke = st;
			}
			if (sp.strokeOn !== strokeOn) {
				sp.strokeOn = strokeOn;
				st.Enabled = strokeOn;
			}
			if (stroke !== undefined) {
				if (sp.strokeColor !== stroke) {
					sp.strokeColor = stroke;
					st.Color = stroke;
				}
				if (sp.strokeThick !== strokeThick) {
					sp.strokeThick = strokeThick;
					st.Thickness = strokeThick;
				}
				if (sp.strokeTransp !== strokeTransp) {
					sp.strokeTransp = strokeTransp;
					st.Transparency = strokeTransp;
				}
			}
		}
		if (!sp.visible) {
			sp.visible = true;
			f.Visible = true;
		}
	}
}

function clamp01(v: number): number {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** a light in world space: full brightness up to `r * inner`, smooth falloff to 0 at `r` */
export interface LightSource {
	x: number;
	y: number;
	r: number;
	/** peak brightness 0..1 (default 1) */
	k?: number;
	/** fraction of the radius that is fully lit (default 0.45) */
	inner?: number;
}

/** transparency is quantised so a strip is only rewritten when its light visibly changes */
const LIGHT_STEPS = 64;
/**
 * Height of one light-map strip (screen px). Along a strip the light is interpolated between its
 * gradient keys; across strips it steps by at most ~0.05 opacity at the steepest part of a falloff.
 */
const STRIP_H = 6;
/**
 * Spacing of the light samples (screen px). The light is sampled on this grid and interpolated
 * bilinearly: vertically when a strip is built, horizontally by its gradient. At 32 px the error is
 * under ~0.03 opacity even on the steepest falloff, from ~2× the samples of the old 48 px cell grid.
 */
const GRID = 32;
/** the engine's cap on NumberSequence keypoints (UIGradient.Transparency) */
const MAX_KEYS = 20;
/** a sample column this close (in light) to the line through its neighbours adds nothing as a key */
const KEY_EPS = 0.25 / LIGHT_STEPS;
/**
 * A strip is rewritten only when the new gradient differs from the shown one by more than this
 * anywhere (2 quantisation steps, ≈ 0.03 opacity, ~4 levels of 8-bit colour): a fire's flicker or
 * the camera walking past a lamp then costs about the writes of the old cell grid, and what is shown
 * never drifts further than this from the computed light.
 */
const WRITE_EPS = 2 / LIGHT_STEPS;
/** a light that moved or resized less than this (screen px) since it was sampled keeps its samples */
const MOVE_EPS = 0.35;

/** smoothstep falloff: 1 inside the lit core (r0), 0 at the radius */
function falloff(d: number, r0: number, r: number): number {
	if (d <= r0) return 1;
	if (d >= r) return 0;
	const t = (d - r0) / (r - r0);
	return 1 - t * t * (3 - 2 * t);
}

/**
 * Screen-space light map for the night: full-width horizontal strips of the night colour, each with
 * a UIGradient whose transparency follows the light across the strip, so every light has a smooth
 * round edge instead of the blocks of a cell grid. Opacity = maxDark × (1 − light), where light is
 * the brightest source at that point (a fire never darkens the player's own light).
 *
 * The light is sampled on a GRID-px lattice; a strip blends the two sample rows around its centre
 * line and uses sample columns as its gradient keys (UIGradient interpolates between them), so the
 * whole map is a continuous bilinear field. The key columns are chosen once per pair of sample
 * rows, for all the strips between them: columns on a straight run of both rows are dropped, then
 * the least significant ones until the engine's 20 are left. A blend of two rows is approximated at
 * least as well as the worse of the two, and neighbouring strips share their keys (no streaks).
 *
 * Cost control: only sample rows reached by a light that changed since they were sampled are
 * resampled, and only the strips over them rebuilt (a still camera costs nothing); a rebuilt strip is
 * only rewritten when it would visibly differ from what it shows (WRITE_EPS).
 */
export class LightMap {
	readonly layer: Frame;
	private strips: Array<Frame> = [];
	private grads: Array<UIGradient> = [];
	/** keys last written to each strip: x (screen px) and transparency */
	private lastX: Array<Array<number>> = [];
	private lastT: Array<Array<number>> = [];
	private rows = 0;
	private builtW = 0;
	private builtH = 0;
	private shown = false;
	private color: Color3;
	/** sample lattice: column x / row y positions (px, the last ones on the view's edge) */
	private sx: Array<number> = [];
	private sy: Array<number> = [];
	/** light at each sample, row-major (sy.size() × sx.size()), and rows to resample this frame */
	private samples: Array<number> = [];
	private rowDirty: Array<boolean> = [];
	/** key columns of the strips between sample rows r and r + 1 (indices into sx) */
	private pairKeys: Array<Array<number>> = [];
	/** this frame's lights in screen space (reused arrays, `nLights` valid entries) */
	private lx: Array<number> = [];
	private ly: Array<number> = [];
	private lr: Array<number> = [];
	private lin: Array<number> = [];
	private lk: Array<number> = [];
	private nLights = 0;
	/** each light as it was last sampled (pn < 0: resample everything), and the darkness all strips were last built with */
	private px: Array<number> = [];
	private py: Array<number> = [];
	private pr: Array<number> = [];
	private pin: Array<number> = [];
	private pk: Array<number> = [];
	private pn = -1;
	private pDark = -1;
	/** keys of the strip being built: x and transparency */
	private kx: Array<number> = [];
	private kt: Array<number> = [];

	constructor(parent: GuiObject, color: Color3) {
		this.color = color;
		this.layer = new Instance("Frame");
		this.layer.Name = "LightMap";
		this.layer.Size = UDim2.fromScale(1, 1);
		this.layer.BackgroundTransparency = 1;
		this.layer.BorderSizePixel = 0;
		this.layer.Visible = false;
		this.layer.Parent = parent;
	}

	/** (re)build the strips and the sample lattice when the viewport size changes */
	private ensureGrid(viewW: number, viewH: number): void {
		if (viewW === this.builtW && viewH === this.builtH) return;
		this.builtW = viewW;
		this.builtH = viewH;
		this.rows = math.ceil(viewH / STRIP_H);
		this.sx.clear();
		this.sy.clear();
		for (let x = 0; x < viewW; x += GRID) this.sx.push(x);
		this.sx.push(viewW);
		for (let y = 0; y < viewH; y += GRID) this.sy.push(y);
		this.sy.push(viewH);
		this.samples.clear();
		for (let i = 0; i < this.sx.size() * this.sy.size(); i++) this.samples.push(0);
		this.rowDirty.clear();
		for (let i = 0; i < this.sy.size(); i++) this.rowDirty.push(true);
		while (this.pairKeys.size() < this.sy.size()) this.pairKeys.push([]);
		// everything is resampled and rebuilt on the next update
		this.pn = -1;
		this.pDark = -1;
		while (this.strips.size() < this.rows) {
			const f = new Instance("Frame");
			f.Name = "L";
			f.BorderSizePixel = 0;
			f.BackgroundColor3 = this.color;
			f.BackgroundTransparency = 0;
			const g = new Instance("UIGradient");
			g.Parent = f;
			f.Parent = this.layer;
			this.strips.push(f);
			this.grads.push(g);
			this.lastX.push([]);
			this.lastT.push([]);
		}
		for (let i = 0; i < this.strips.size(); i++) {
			const f = this.strips[i];
			// key times are fractions of the width: a new width invalidates every strip
			this.lastX[i].clear();
			if (i >= this.rows) {
				f.Visible = false;
				continue;
			}
			const y = i * STRIP_H;
			f.Position = UDim2.fromOffset(0, y);
			f.Size = UDim2.fromOffset(viewW, math.min(STRIP_H, viewH - y));
			f.Visible = true;
		}
	}

	hide(): void {
		if (this.shown) {
			this.shown = false;
			this.layer.Visible = false;
		}
	}

	/**
	 * @param maxDark darkness where nothing is lit (0 = day → the map hides itself)
	 * @param lights world-space light sources (player, lamps, fires, muzzle flashes...)
	 */
	update(cam: Camera, maxDark: number, lights: Array<LightSource>): void {
		if (maxDark <= 0.004) {
			this.hide();
			return;
		}
		this.ensureGrid(cam.viewW, cam.viewH);
		if (!this.shown) {
			this.shown = true;
			this.layer.Visible = true;
		}
		// lights → screen space once; skip the ones that cannot reach the viewport
		let n = 0;
		for (const l of lights) {
			const s = cam.worldToScreen(l.x, l.y);
			const r = l.r * cam.zoom;
			if (r < 1 || s.x < -r || s.y < -r || s.x > cam.viewW + r || s.y > cam.viewH + r) continue;
			this.lx[n] = s.x;
			this.ly[n] = s.y;
			this.lr[n] = r;
			// the fully lit core stays strictly inside the ring so the falloff never divides by 0
			this.lin[n] = math.min(r * (l.inner ?? 0.45), r - 1);
			this.lk[n] = clamp01(l.k ?? 1);
			n++;
		}
		this.nLights = n;
		this.markDirty();
		// dusk and dawn move the darkness a little every frame: the light samples do not depend on
		// it, and the strips are rebuilt only once it has moved by half a quantisation step
		const darkMoved = math.abs(maxDark - this.pDark) >= 0.5 / LIGHT_STEPS;
		if (darkMoved) this.pDark = maxDark;
		const nRows = this.sy.size();
		for (let r = 0; r < nRows; r++) {
			if (this.rowDirty[r]) this.sampleRow(r);
		}
		for (let r = 0; r < nRows - 1; r++) {
			if (this.rowDirty[r] || this.rowDirty[r + 1]) this.selectKeys(r);
		}
		const viewW = this.builtW;
		let r0 = 0;
		for (let row = 0; row < this.rows; row++) {
			const y = row * STRIP_H;
			const cy = y + math.min(STRIP_H, this.builtH - y) * 0.5;
			while (r0 < nRows - 2 && this.sy[r0 + 1] <= cy) r0++;
			if (!darkMoved && !this.rowDirty[r0] && !this.rowDirty[r0 + 1]) continue;
			this.writeStrip(row, this.buildStrip(r0, cy, maxDark), viewW);
		}
		for (let r = 0; r < nRows; r++) this.rowDirty[r] = false;
	}

	/**
	 * Flag the sample rows reached by a light that changed (beyond MOVE_EPS) since it was sampled,
	 * old and new extent both. Only such lights update their remembered state, so a slow drift still
	 * adds up to a resample instead of being lost frame by frame.
	 */
	private markDirty(): void {
		const n = this.nLights;
		const pn = this.pn;
		const all = pn < 0;
		for (let i = 0; i < math.max(n, pn); i++) {
			const kept =
				!all &&
				i < n &&
				i < pn &&
				math.abs(this.lx[i] - this.px[i]) < MOVE_EPS &&
				math.abs(this.ly[i] - this.py[i]) < MOVE_EPS &&
				math.abs(this.lr[i] - this.pr[i]) < MOVE_EPS &&
				math.abs(this.lin[i] - this.pin[i]) < MOVE_EPS &&
				math.abs(this.lk[i] - this.pk[i]) < 0.5 / LIGHT_STEPS;
			if (kept) continue;
			if (i < n) {
				this.markRows(this.ly[i], this.lr[i]);
				this.px[i] = this.lx[i];
				this.py[i] = this.ly[i];
				this.pr[i] = this.lr[i];
				this.pin[i] = this.lin[i];
				this.pk[i] = this.lk[i];
			}
			if (i < pn) this.markRows(this.py[i], this.pr[i]);
		}
		if (all) {
			for (let r = 0; r < this.sy.size(); r++) this.rowDirty[r] = true;
		}
		this.pn = n;
	}

	/** flag the sample rows within a light's reach (radius r around screen y) */
	private markRows(y: number, r: number): void {
		const first = math.max(0, math.ceil((y - r) / GRID));
		const last = math.min(this.sy.size() - 1, math.floor((y + r) / GRID) + 1);
		for (let row = first; row <= last; row++) this.rowDirty[row] = true;
	}

	/** light at every sample of one lattice row: the brightest source, each over its chord only */
	private sampleRow(r: number): void {
		const y = this.sy[r];
		const cols = this.sx.size();
		const base = r * cols;
		for (let c = 0; c < cols; c++) this.samples[base + c] = 0;
		for (let i = 0; i < this.nLights; i++) {
			const dy = y - this.ly[i];
			const rad = this.lr[i];
			if (dy >= rad || dy <= -rad) continue;
			const k = this.lk[i];
			const r0 = this.lin[i];
			const chord = math.sqrt(rad * rad - dy * dy);
			const first = math.max(0, math.ceil((this.lx[i] - chord) / GRID));
			const last = math.min(cols - 1, math.floor((this.lx[i] + chord) / GRID) + 1);
			for (let c = first; c <= last; c++) {
				const idx = base + c;
				if (this.samples[idx] >= k) continue;
				const dx = this.sx[c] - this.lx[i];
				const d2 = dx * dx + dy * dy;
				// inside the lit core no distance is needed
				const l = d2 <= r0 * r0 ? k : k * falloff(math.sqrt(d2), r0, rad);
				if (l > this.samples[idx]) this.samples[idx] = l;
			}
		}
	}

	/**
	 * Choose the key columns shared by the strips between sample rows r and r + 1: every column
	 * that is not on a straight run in both rows, then drop the one whose removal changes either row
	 * least until at most MAX_KEYS are left.
	 */
	private selectKeys(r: number): void {
		const sx = this.sx;
		const s = this.samples;
		const cols = sx.size();
		const a = r * cols;
		const b = a + cols;
		const keys = this.pairKeys[r];
		keys.clear();
		keys.push(0);
		for (let j = 1; j < cols - 1; j++) {
			const q = keys[keys.size() - 1];
			const u = (sx[j] - sx[q]) / (sx[j + 1] - sx[q]);
			const ea = math.abs(s[a + q] + (s[a + j + 1] - s[a + q]) * u - s[a + j]);
			const eb = math.abs(s[b + q] + (s[b + j + 1] - s[b + q]) * u - s[b + j]);
			if (ea >= KEY_EPS || eb >= KEY_EPS) keys.push(j);
		}
		keys.push(cols - 1);
		while (keys.size() > MAX_KEYS) {
			let best = 1;
			let bestErr = math.huge;
			for (let i = 1; i < keys.size() - 1; i++) {
				const p = keys[i - 1];
				const j = keys[i];
				const q = keys[i + 1];
				const u = (sx[j] - sx[p]) / (sx[q] - sx[p]);
				const ea = math.abs(s[a + p] + (s[a + q] - s[a + p]) * u - s[a + j]);
				const eb = math.abs(s[b + p] + (s[b + q] - s[b + p]) * u - s[b + j]);
				const err = math.max(ea, eb);
				if (err < bestErr) {
					bestErr = err;
					best = i;
				}
			}
			keys.remove(best);
		}
	}

	/**
	 * Keys of the strip whose centre line `cy` lies between sample rows r0 and r0 + 1: the two rows
	 * blended at the pair's key columns. Returns the key count (in kx / kt).
	 */
	private buildStrip(r0: number, cy: number, maxDark: number): number {
		const kx = this.kx;
		const kt = this.kt;
		const s = this.samples;
		const keys = this.pairKeys[r0];
		const cols = this.sx.size();
		const y0 = this.sy[r0];
		const f = math.clamp((cy - y0) / (this.sy[r0 + 1] - y0), 0, 1);
		const a = r0 * cols;
		const b = a + cols;
		const m = keys.size();
		for (let j = 0; j < m; j++) {
			const c = keys[j];
			const light = s[a + c] + (s[b + c] - s[a + c]) * f;
			kx[j] = this.sx[c];
			kt[j] = math.floor((1 - maxDark * (1 - light)) * LIGHT_STEPS + 0.5) / LIGHT_STEPS;
		}
		return m;
	}

	/**
	 * Largest difference between the strip's shown gradient and the built keys. Both are piecewise
	 * linear over [0, viewW], so the maximum sits on a key of one of them: exact, O(keys).
	 */
	private gap(row: number, m: number): number {
		const ox = this.lastX[row];
		const ot = this.lastT[row];
		const on = ox.size();
		if (on < 2) return math.huge;
		const kx = this.kx;
		const kt = this.kt;
		let worst = 0;
		// usual case: same key columns as shown, so the gap is the largest change at a key
		let same = on === m;
		for (let j = 0; same && j < m; j++) {
			if (ox[j] !== kx[j]) same = false;
			else worst = math.max(worst, math.abs(ot[j] - kt[j]));
		}
		if (same) return worst;
		worst = 0;
		let s = 0;
		for (let j = 0; j < m; j++) {
			const x = kx[j];
			while (s < on - 2 && ox[s + 1] < x) s++;
			const v = ot[s] + ((ot[s + 1] - ot[s]) * (x - ox[s])) / (ox[s + 1] - ox[s]);
			worst = math.max(worst, math.abs(v - kt[j]));
		}
		s = 0;
		for (let j = 0; j < on; j++) {
			const x = ox[j];
			while (s < m - 2 && kx[s + 1] < x) s++;
			const v = kt[s] + ((kt[s + 1] - kt[s]) * (x - kx[s])) / (kx[s + 1] - kx[s]);
			worst = math.max(worst, math.abs(v - ot[j]));
		}
		return worst;
	}

	/** push the built keys to the strip's gradient, unless it already shows them within WRITE_EPS */
	private writeStrip(row: number, m: number, viewW: number): void {
		if (this.gap(row, m) <= WRITE_EPS) return;
		const px = this.lastX[row];
		const pt = this.lastT[row];
		px.clear();
		pt.clear();
		const keys: Array<NumberSequenceKeypoint> = [];
		for (let j = 0; j < m; j++) {
			const x = this.kx[j];
			const t = this.kt[j];
			px.push(x);
			pt.push(t);
			// the ends are exactly 0 and 1 (x = 0 and x = viewW), as the engine requires
			keys.push(new NumberSequenceKeypoint(x / viewW, t));
		}
		this.grads[row].Transparency = new NumberSequence(keys);
	}
}
