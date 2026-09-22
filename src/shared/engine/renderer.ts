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

/** transparency is quantised so a cell is only rewritten when its light visibly changes */
const LIGHT_STEPS = 40;

/**
 * Coarse screen-space light map for the night: a grid of dark Frames (pooled, one per cell)
 * whose opacity = maxDark × (1 − light), where light is the brightest source covering the cell.
 * Replaces a flat overlay, so the player's surroundings and built lamps/fires stay readable.
 */
export class LightMap {
	readonly layer: Frame;
	private cells: Array<Frame> = [];
	private transp: Array<number> = [];
	private cols = 0;
	private rows = 0;
	private cell = 56;
	private builtW = 0;
	private builtH = 0;
	private shown = false;
	private color: Color3;

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

	/** (re)build the grid when the viewport size changes; cells of ~48–64 px */
	private ensureGrid(viewW: number, viewH: number): void {
		if (viewW === this.builtW && viewH === this.builtH) return;
		this.builtW = viewW;
		this.builtH = viewH;
		this.cell = math.clamp(math.ceil(math.max(viewW, viewH) / 32), 48, 64);
		this.cols = math.ceil(viewW / this.cell);
		this.rows = math.ceil(viewH / this.cell);
		const need = this.cols * this.rows;
		while (this.cells.size() < need) {
			const f = new Instance("Frame");
			f.Name = "L";
			f.BorderSizePixel = 0;
			f.BackgroundColor3 = this.color;
			f.BackgroundTransparency = 0;
			f.Parent = this.layer;
			this.cells.push(f);
			this.transp.push(0);
		}
		for (let i = 0; i < this.cells.size(); i++) {
			const f = this.cells[i];
			if (i >= need) {
				f.Visible = false;
				continue;
			}
			const c = i % this.cols;
			const r = math.floor(i / this.cols);
			f.Position = UDim2.fromOffset(c * this.cell, r * this.cell);
			f.Size = UDim2.fromOffset(this.cell, this.cell);
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
		const lx: Array<number> = [];
		const ly: Array<number> = [];
		const lr: Array<number> = [];
		const lin: Array<number> = [];
		const lk: Array<number> = [];
		for (const l of lights) {
			const s = cam.worldToScreen(l.x, l.y);
			const r = l.r * cam.zoom;
			if (s.x < -r || s.y < -r || s.x > cam.viewW + r || s.y > cam.viewH + r) continue;
			lx.push(s.x);
			ly.push(s.y);
			lr.push(r);
			lin.push(r * (l.inner ?? 0.45));
			lk.push(clamp01(l.k ?? 1));
		}
		const n = lx.size();
		const half = this.cell * 0.5;
		for (let row = 0; row < this.rows; row++) {
			const cy = row * this.cell + half;
			for (let col = 0; col < this.cols; col++) {
				const cx = col * this.cell + half;
				let light = 0;
				for (let i = 0; i < n; i++) {
					const dx = cx - lx[i];
					const dy = cy - ly[i];
					const r = lr[i];
					const d2 = dx * dx + dy * dy;
					if (d2 >= r * r) continue;
					const d = math.sqrt(d2);
					const r0 = lin[i];
					let l = lk[i];
					if (d > r0) {
						const t = (d - r0) / (r - r0);
						l *= 1 - t * t * (3 - 2 * t);
					}
					if (l > light) light = l;
				}
				const tr = math.floor((1 - maxDark * (1 - light)) * LIGHT_STEPS + 0.5) / LIGHT_STEPS;
				const idx = row * this.cols + col;
				if (this.transp[idx] !== tr) {
					this.transp[idx] = tr;
					this.cells[idx].BackgroundTransparency = tr;
				}
			}
		}
	}
}
