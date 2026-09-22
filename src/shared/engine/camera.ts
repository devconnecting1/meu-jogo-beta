import { Vec2, v2 } from "./vec2";

/**
 * Camera for the 2D canvas.
 * World is Cartesian (x right, y down-ish). Projection supports:
 *  - "top": plain top-down
 *  - "iso": fake isometric diamond (2:1)
 */
export type ProjectionMode = "top" | "iso";

export interface ScreenPoint {
	x: number;
	y: number;
}

export class Camera {
	x = 0;
	y = 0;
	zoom = 1;
	/** radians, visual rotation of the world (sniper etc.) */
	angle = 0;
	/** viewport size in px (screen) */
	viewW = 1120;
	viewH = 630;
	projection: ProjectionMode = "iso";
	/** iso squash factor for vertical axis in "fake iso" mode */
	isoSquash = 0.5;
	shakeMag = 0;
	shakeT = 0;
	private shakeX = 0;
	private shakeY = 0;

	setView(w: number, h: number): void {
		this.viewW = w;
		this.viewH = h;
	}

	follow(tx: number, ty: number, lerpT: number): void {
		this.x += (tx - this.x) * lerpT;
		this.y += (ty - this.y) * lerpT;
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

	/** world → screen (pixels relative to viewport top-left) */
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

	/** screen (viewport px) → world */
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

	/** approximate half-extent of view in world units (for culling) */
	cullMargin(): number {
		return (math.max(this.viewW, this.viewH) / math.max(this.zoom, 0.01)) * 1.2 + 256;
	}
}
