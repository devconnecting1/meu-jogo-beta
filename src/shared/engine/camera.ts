import { Vec2, v2 } from "./vec2";

/**
 * Camera for the 2D GUI canvas.
 * World is Cartesian: x → right, y → down (same as screen), angles in radians (0 = +x, π/2 = +y).
 *  - "topdown" (default): screen = rotate(world - cam, angle) * zoom. Every sprite (rects, rotated
 *    bodies, walls) is drawn exactly where its collision box is, and Frame.Rotation = world heading
 *    + camera angle, so collision, drawing and aim always agree.
 *  - "iso": legacy fake-isometric diamond (2:1). Only the sprite CENTRE is projected (the Renderer
 *    still draws axis-aligned rects), so rects slide/overlap — kept for experiments, not for play.
 */
export type ProjectionMode = "topdown" | "iso";

export interface ScreenPoint {
	x: number;
	y: number;
}

/** axis-aligned rectangle in world units */
export interface ViewRect {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export class Camera {
	x = 0;
	y = 0;
	zoom = 1;
	/** radians, visual rotation of the world (sniper etc.) — topdown only */
	angle = 0;
	/** viewport size in px (screen) */
	viewW = 1120;
	viewH = 630;
	projection: ProjectionMode = "topdown";
	/** iso squash factor for vertical axis in "iso" mode */
	isoSquash = 0.5;
	shakeMag = 0;
	shakeT = 0;

	/**
	 * Where the LAST `project()` landed, in viewport px. Read it immediately after the call and never keep it:
	 * the next `project()` overwrites both numbers.
	 *
	 * Why this exists: `worldToScreen` returns a fresh {x, y}, which in Luau is a TABLE ALLOCATION. The
	 * renderer calls it once per sprite, and the town draws 1500-3000 sprites a frame -- around a hundred
	 * thousand short-lived tables a second, whose only purpose is to be read twice and thrown away. That is
	 * not slow to compute; it is slow because the collector has to walk them, and it walks them in a pause
	 * that lands in the middle of a frame. `project()` is the same arithmetic writing into these two fields.
	 *
	 * The cold callers (nameplate, ally plate, chat bubble, coach) keep using `worldToScreen`: one table each,
	 * a handful per frame, and no aliasing to reason about. Only the two hot loops use `project()`.
	 */
	screenX = 0;
	screenY = 0;

	/** cos/sin of `angle`, recomputed only when `angle` actually changes (it changes a few times a minute) */
	private trigFor = 0;
	private cosA = 1;
	private sinA = 0;
	/**
	 * Free camera (admin panel): while true, follow() is ignored and whoever detached the camera moves x / y / zoom
	 * itself. Everything that projects through the camera (renderer, light map, nameplate, aim) keeps working,
	 * including at zoom ≠ 1 (sizes scale by `zoom`, culling uses viewRect()).
	 */
	detached = false;
	private shakeX = 0;
	private shakeY = 0;

	setView(w: number, h: number): void {
		this.viewW = w;
		this.viewH = h;
	}

	follow(tx: number, ty: number, lerpT: number): void {
		if (this.detached) return;
		this.x += (tx - this.x) * lerpT;
		this.y += (ty - this.y) * lerpT;
	}

	/** detaches the camera at its current position (free camera) or re-attaches it at zoom 1 */
	setDetached(on: boolean): void {
		this.detached = on;
		if (!on) this.zoom = 1;
	}

	shake(magnitude: number, duration: number): void {
		if (magnitude > this.shakeMag) {
			this.shakeMag = magnitude;
		}
		this.shakeT = math.max(this.shakeT, duration);
	}

	update(dt: number): void {
		if (this.shakeT > 0) {
			this.shakeT -= dt;
			this.shakeX = (math.random() * 2 - 1) * this.shakeMag;
			this.shakeY = (math.random() * 2 - 1) * this.shakeMag;
			if (this.shakeT <= 0) {
				this.shakeMag = 0;
				this.shakeX = 0;
				this.shakeY = 0;
			}
		}
	}

	/**
	 * world -> screen, writing into `screenX` / `screenY` instead of allocating (see those fields).
	 * Identical arithmetic to `worldToScreen`; if you change one, change the other.
	 */
	project(wx: number, wy: number): void {
		const dx = wx - this.x;
		const dy = wy - this.y;
		if (this.projection === "iso") {
			this.screenX = (dx - dy) * this.zoom + this.viewW * 0.5 + this.shakeX;
			this.screenY = (dx + dy) * this.isoSquash * this.zoom + this.viewH * 0.5 + this.shakeY;
			return;
		}
		if (this.angle !== this.trigFor) {
			this.trigFor = this.angle;
			this.cosA = math.cos(this.angle);
			this.sinA = math.sin(this.angle);
		}
		const ca = this.cosA;
		const sa = this.sinA;
		this.screenX = (dx * ca - dy * sa) * this.zoom + this.viewW * 0.5 + this.shakeX;
		this.screenY = (dx * sa + dy * ca) * this.zoom + this.viewH * 0.5 + this.shakeY;
	}

	/** world → screen (pixels relative to viewport top-left). Exact inverse of screenToWorld. */
	worldToScreen(wx: number, wy: number): ScreenPoint {
		const dx = wx - this.x;
		const dy = wy - this.y;
		if (this.projection === "iso") {
			return {
				x: (dx - dy) * this.zoom + this.viewW * 0.5 + this.shakeX,
				y: (dx + dy) * this.isoSquash * this.zoom + this.viewH * 0.5 + this.shakeY,
			};
		}
		const ca = math.cos(this.angle);
		const sa = math.sin(this.angle);
		const rx = dx * ca - dy * sa;
		const ry = dx * sa + dy * ca;
		return {
			x: rx * this.zoom + this.viewW * 0.5 + this.shakeX,
			y: ry * this.zoom + this.viewH * 0.5 + this.shakeY,
		};
	}

	/** screen (viewport px) → world. Exact inverse of worldToScreen (same shake, zoom, angle). */
	screenToWorld(sx: number, sy: number): Vec2 {
		const px = sx - this.viewW * 0.5 - this.shakeX;
		const py = sy - this.viewH * 0.5 - this.shakeY;
		if (this.projection === "iso") {
			const a = px / this.zoom;
			const b = py / (this.isoSquash * this.zoom);
			// a = dx - dy, b = dx + dy
			const dx = (a + b) * 0.5;
			const dy = (b - a) * 0.5;
			return v2(dx + this.x, dy + this.y);
		}
		const ca = math.cos(-this.angle);
		const sa = math.sin(-this.angle);
		const rx = px / this.zoom;
		const ry = py / this.zoom;
		const dx = rx * ca - ry * sa;
		const dy = rx * sa + ry * ca;
		return v2(dx + this.x, dy + this.y);
	}

	/**
	 * Screen-space direction (e.g. WASD / joystick, y down) → world-space direction, same length.
	 * Identity in topdown with angle 0; undoes the camera rotation otherwise.
	 */
	screenDirToWorld(dx: number, dy: number): Vec2 {
		if (this.projection === "iso") {
			const b = dy / this.isoSquash;
			return v2((dx + b) * 0.5, (b - dx) * 0.5);
		}
		const ca = math.cos(this.angle);
		const sa = math.sin(this.angle);
		return v2(dx * ca + dy * sa, -dx * sa + dy * ca);
	}

	/** Frame.Rotation (degrees) for something whose world heading is `worldAngle` (radians). */
	spriteRotationDeg(worldAngle: number): number {
		if (this.projection === "iso") {
			const c = math.cos(worldAngle);
			const s = math.sin(worldAngle);
			return math.deg(math.atan2((c + s) * this.isoSquash, c - s));
		}
		return math.deg(worldAngle + this.angle);
	}

	/** World-space AABB that contains the whole viewport (handles zoom, rotation and shake). */
	viewRect(pad = 0): ViewRect {
		const c0 = this.screenToWorld(0, 0);
		const c1 = this.screenToWorld(this.viewW, 0);
		const c2 = this.screenToWorld(0, this.viewH);
		const c3 = this.screenToWorld(this.viewW, this.viewH);
		return {
			minX: math.min(c0.x, c1.x, c2.x, c3.x) - pad,
			minY: math.min(c0.y, c1.y, c2.y, c3.y) - pad,
			maxX: math.max(c0.x, c1.x, c2.x, c3.x) + pad,
			maxY: math.max(c0.y, c1.y, c2.y, c3.y) + pad,
		};
	}

	/** approximate half-extent of view in world units (for culling) */
	cullMargin(): number {
		return (math.max(this.viewW, this.viewH) / math.max(this.zoom, 0.01)) * 1.2 + 256;
	}
}
