import { Camera } from "./camera";

export interface SpriteOpts {
	w?: number;
	h?: number;
	color?: Color3;
	rotation?: number;
	alpha?: number;
	image?: string;
	rectOffset?: Vector2;
	rectSize?: Vector2;
	zIndex?: number;
	cornerRadius?: number;
	anchorX?: number;
	anchorY?: number;
}

interface PooledSprite {
	frame: Frame;
	inUse: boolean;
}

const DEFAULT_COLOR = Color3.fromRGB(200, 200, 200);

/**
 * Pooled GUI sprite renderer. All world visuals are Frames under a WorldLayer.
 * Fake-iso is handled by Camera.worldToScreen; sprites stay axis-aligned (classic fake-iso look).
 */
export class Renderer {
	readonly layer: Frame;
	private pool: Array<PooledSprite> = [];

	constructor(parent: GuiObject, name: string) {
		this.layer = new Instance("Frame");
		this.layer.Name = name;
		this.layer.Size = UDim2.fromScale(1, 1);
		this.layer.BackgroundTransparency = 1;
		this.layer.BorderSizePixel = 0;
		this.layer.ClipsDescendants = true;
		this.layer.Parent = parent;
	}

	private viewW = 1120;
	private viewH = 630;

	setView(w: number, h: number): void {
		this.viewW = w;
		this.viewH = h;
	}

	acquire(): Frame {
		for (const p of this.pool) {
			if (!p.inUse) {
				p.inUse = true;
				p.frame.Visible = true;
				return p.frame;
			}
		}
		const f = new Instance("Frame");
		f.BorderSizePixel = 0;
		f.AnchorPoint = new Vector2(0.5, 0.5);
		f.Visible = true;
		f.Parent = this.layer;
		this.pool.push({ frame: f, inUse: true });
		return f;
	}

	release(f: Frame): void {
		for (const p of this.pool) {
			if (p.frame === f) {
				p.inUse = false;
				f.Visible = false;
				return;
			}
		}
	}

	releaseAll(): void {
		for (const p of this.pool) {
			p.inUse = false;
			p.frame.Visible = false;
		}
	}

	/**
	 * Draw a rect sprite at world position.
	 * Returns the frame (caller must release next frame if transient).
	 */
	drawRect(cam: Camera, wx: number, wy: number, opts: SpriteOpts): Frame {
		const f = this.acquire();
		const s = cam.worldToScreen(wx, wy);
		const w = opts.w ?? 32;
		const h = opts.h ?? 32;
		f.Size = UDim2.fromOffset(math.max(1, math.floor(w * cam.zoom)), math.max(1, math.floor(h * cam.zoom)));
		f.Position = UDim2.fromOffset(math.floor(s.x), math.floor(s.y));
		f.BackgroundColor3 = opts.color ?? DEFAULT_COLOR;
		f.BackgroundTransparency = 1 - clamp01(opts.alpha ?? 1);
		f.Rotation = (opts.rotation ?? 0) * (180 / math.pi);
		f.ZIndex = opts.zIndex ?? math.floor(s.y);
		f.BorderSizePixel = 0;

		// corner radius child
		if (opts.cornerRadius !== undefined) {
			let c = f.FindFirstChildOfClass("UICorner") as UICorner | undefined;
			if (!c) {
				c = new Instance("UICorner");
				c.Parent = f;
			}
			c.CornerRadius = new UDim(0, opts.cornerRadius);
		}
		return f;
	}
}

function clamp01(v: number): number {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}
