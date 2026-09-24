/*
 * Small pieces every world view needs: culling tests, a rect drawn in an object's own frame and where its
 * shadow falls (LUZ-01). They lived in `gameLoop.ts` until F1; `playersView` needs the same ones, and
 * `worldView` / `actorsView` / `fxView` will in F2 (docs/MULTIPLAYER.md §11.3).
 *
 * Nothing here allocates per frame: `shadowOffset` writes into a module scratch because a frame asks for one shadow
 * per solid, item and actor on screen and none of those results outlives the next call, and `mix` builds each colour
 * blend once.
 */
import { Camera, ViewRect } from "shared/engine/camera";
import { Renderer, SpriteOpts } from "shared/engine/renderer";

/** iterate a body's two sides without building a table per call (`for (const s of [-1, 1])` allocates) */
export const SIDES = [-1, 1];

// ------------------------------------------------------------------ colour blends (M4)

/**
 * The steps a blend driven by a continuous value (a hit flash fading out, a spitter winding up) is quantised to:
 * `quantize` rounds that value to 1/BLEND_STEPS before it reaches `mix`, so a fading flash is at most 41 colours,
 * never a new one per frame. 0, 1 and the tenths come out exact (0.7 * 40 = 28), so a flash of 1 or a wind-up of 8
 * blends to the very colour the unquantised Lerp gave.
 */
const BLEND_STEPS = 40;
/** blends remembered at most; past it the memo starts over (a caller with fresh colours only loses the memo) */
const BLEND_MAX = 1024;
const blends = new Map<Color3, Map<Color3, Map<number, Color3>>>();
let blendCount = 0;

/** `v` (0..1) on the BLEND_STEPS grid: what a continuous input goes through before `mix` */
export function quantize(v: number): number {
	return math.floor(math.clamp(v, 0, 1) * BLEND_STEPS + 0.5) / BLEND_STEPS;
}

/**
 * `a.Lerp(b, t)`, built once per (a, b, t) and handed back afterwards: the same Color3 every frame. A zombie's rim,
 * its dark arms and its head were 2-4 new Color3 per zombie per frame (the collector's work), and a new Color3 is also
 * a new identity, which the renderer's write cache (`sp.color !== color`) took for a change and wrote to the engine
 * every frame. `t` must come from a small set of values: a constant, or a `quantize`d input.
 */
export function mix(a: Color3, b: Color3, t: number): Color3 {
	let byB = blends.get(a);
	if (byB === undefined) {
		byB = new Map<Color3, Map<number, Color3>>();
		blends.set(a, byB);
	}
	let byT = byB.get(b);
	if (byT === undefined) {
		byT = new Map<number, Color3>();
		byB.set(b, byT);
	}
	let c = byT.get(t);
	if (c === undefined) {
		if (blendCount >= BLEND_MAX) {
			blends.clear();
			blendCount = 0;
			return a.Lerp(b, t);
		}
		c = a.Lerp(b, t);
		byT.set(t, c);
		blendCount++;
	}
	return c;
}

/** frame-rate independent version of `lerp(a, b, perFrame)` tuned at 60 fps */
export function ease(perFrame: number, dt: number): number {
	return 1 - math.pow(1 - perFrame, dt * 60);
}

/** does the w × h rect at (x, y) touch the view? */
export function overlaps(x: number, y: number, w: number, h: number, v: ViewRect): boolean {
	return x < v.maxX && x + w > v.minX && y < v.maxY && y + h > v.minY;
}

/** does the circle of radius r at (x, y) touch the view? */
export function circleInView(x: number, y: number, r: number, v: ViewRect): boolean {
	return x + r > v.minX && x - r < v.maxX && y + r > v.minY && y - r < v.maxY;
}

/** rect in an object's local frame (fwd along `a`, lat to its right) */
export function part(
	r: Renderer,
	cam: Camera,
	cx: number,
	cy: number,
	a: number,
	fwd: number,
	lat: number,
	opts: SpriteOpts,
): void {
	const fx = math.cos(a);
	const fy = math.sin(a);
	opts.rotation = a;
	r.drawRect(cam, cx + fx * fwd - fy * lat, cy + fy * fwd + fx * lat, opts);
}

// ------------------------------------------------------------------ shadows (LUZ-01)

/**
 * Where light comes from this frame: the sun by day, the survivor's own 250 u light at night (the
 * original did the same, and it is what makes a torch-lit street read as lit from the middle).
 */
export interface SunState {
	/** unit vector the daytime shadows point along */
	x: number;
	y: number;
	/** outside 6h–18h shadows point away from `light` instead of along the sun */
	night: boolean;
	lightX: number;
	lightY: number;
}

export function createSun(): SunState {
	return { x: 0.7, y: 0.7, night: false, lightX: 0, lightY: 0 };
}

/**
 * Sun direction for the hour, plus the position light runs from at night.
 * Original: `lengthdir(len, day_time / 24 * 360 - 180 - 45)` (GameMaker's y is flipped).
 */
export function updateSun(sun: SunState, dayTime: number, lightX: number, lightY: number): void {
	sun.lightX = lightX;
	sun.lightY = lightY;
	if (dayTime > 6 && dayTime < 18) {
		const rad = math.rad((dayTime / 24) * 360 - 225);
		sun.x = math.cos(rad);
		sun.y = -math.sin(rad);
		sun.night = false;
	} else {
		sun.night = true;
	}
}

/** result of the last `shadowOffset`; read it before calling again (one scratch, no allocation) */
const SHADOW = { x: 0, y: 0 };

/** where a shadow of length `len` falls for something at (x, y) */
export function shadowOffset(sun: SunState, x: number, y: number, len: number): { x: number; y: number } {
	if (sun.night) {
		const dx = x - sun.lightX;
		const dy = y - sun.lightY;
		const d = math.sqrt(dx * dx + dy * dy);
		if (d < 1) {
			SHADOW.x = 0;
			SHADOW.y = len * 0.5;
		} else {
			SHADOW.x = (dx / d) * len;
			SHADOW.y = (dy / d) * len;
		}
		return SHADOW;
	}
	SHADOW.x = sun.x * len;
	SHADOW.y = sun.y * len;
	return SHADOW;
}
