/*
 * The awareness marks over the horde's heads (docs/DESIGN_RULES.md IA-05): what each zombie is doing, decided by
 * the server (shared/sim/ai/memory.ts `Aware`) and shown to every player.
 *
 *   IDLE        a small BLUE dot — only on the zombies near you (it fades in inside CALM_NEAR), so a street full of
 *               shamblers stays a street, not a field of markers;
 *   SUSPICIOUS  a GOLD "?" — it heard or glimpsed something and is walking to that place;
 *   SEARCHING   the same "?", tilting side to side while it looks round (still with Reduce Motion);
 *   CHASING     a RED "!" — it sees you. Full size when it starts, a size smaller once the chase is on.
 *
 * Shape AND colour carry the state, so it reads for every kind of colour blindness (dot / ? / !); each mark is
 * pixel art in the town's scale (ART-02: 4 u per texel) with the town's 1-texel near-black outline and a lighter
 * texel row where the top-left light hits it. Every change pops the new mark in (a quick scale and a white rim,
 * ~0.3 s; with Reduce Motion only the rim, never a movement), and a zombie that gives up lets its "?" fade.
 *
 * It sits above the head and is never drawn over a survivor: a mark that would cover one slides sideways, away
 * from them. The layer lies above the night overlay (the mark must read at night) and under the nameplates; a
 * zombie's mark is only as visible as the zombie (its `alpha`: nothing is revealed in the dark that the body did
 * not already show), and one under a roof that is closed is not drawn at all (EDI-04).
 *
 * Pooled: one Renderer, no Instance per frame after the warm-up. No text (UI-04), no theme colour: these are
 * world art, like the zombies themselves (UI-01 is about the interface).
 */
import { Camera, ViewRect } from "shared/engine/camera";
import { COLORS, ICON_ART } from "shared/engine/colors";
import { Renderer } from "shared/engine/renderer";
import { ZombieState, zombieRadius } from "shared/game/entities";
import { querySolids, Solid, WorldData } from "shared/game/world";

/** world units per texel of a mark (the town's pixel art is 4 u per texel, ART-02) */
export const MARK_TEXEL = 4;
/** the idle dot shows only this close to the local survivor, fading in over the last CALM_FADE */
export const CALM_NEAR = 300;
export const CALM_FADE = 100;
/** a new mark pops from this scale to 1 over POP_TIME, with a white rim that fades over RIM_TIME */
export const POP_SCALE = 1.6;
export const POP_TIME = 0.2;
export const RIM_TIME = 0.35;
/** a chase's "!" settles to this size after CHASE_SETTLE seconds: a horde does not shout forever */
export const CHASE_SETTLE = 1.5;
export const SETTLED_SCALE = 0.8;
/** a "?" whose zombie gave up fades out over this long */
export const FADE_OUT = 0.35;
/** the searching "?" tilts this far (radians) and this fast (rad/s) */
export const SEARCH_TILT = 0.2;
export const SEARCH_TILT_SPEED = 3;
/** clearance between a mark's centre and a survivor's centre: the body (18) and half the mark (14) and a gap */
export const SURVIVOR_CLEAR = 40;
/** a roof at least this opaque hides the zombie under it, and so its mark */
const ROOF_HIDES = 0.5;
/** the solids around one point, reused: a frame of marks allocates nothing */
const around: Array<Solid> = [];

/** is (x, y) under a building's roof that is (mostly) on? (`buildingAt`, without its per-call table) */
function underRoof(world: WorldData, x: number, y: number): boolean {
	around.clear();
	querySolids(world, x - 1, y - 1, x + 1, y + 1, around);
	for (const s of around) {
		if (s.kind !== "building" || x < s.x || x > s.x + s.w || y < s.y || y > s.y + s.h) continue;
		return (s.roofAlpha ?? 1) > ROOF_HIDES;
	}
	return false;
}

/** the three looks (fill, top-left light), all over the town's outline colour */
export const MARK_COLORS = {
	outline: ICON_ART.k,
	calm: Color3.fromRGB(86, 156, 230),
	calmLight: Color3.fromRGB(170, 215, 255),
	alert: Color3.fromRGB(255, 204, 51),
	alertLight: Color3.fromRGB(255, 240, 160),
	hunt: Color3.fromRGB(224, 48, 44),
	huntLight: Color3.fromRGB(255, 176, 156),
};

/** a rectangle of texels, in the glyph's own grid (x right, y down) */
interface Cell {
	x: number;
	y: number;
	w: number;
	h: number;
}

interface Glyph {
	w: number;
	h: number;
	outline: Array<Cell>;
	fill: Array<Cell>;
	light: Array<Cell>;
}

/** a glyph's texels, row by row: 0 = nothing, 1 = fill, 2 = the lit edge (drawn over the fill) */
type Texels = Array<Array<number>>;

/**
 * Greedy rectangle cover of the texels of `rows` for which `pick` holds: runs along a row, then grown down while
 * the next rows repeat the same run. Few rectangles, so few Frames per mark.
 */
function cover(rows: Texels, pick: (v: number) => boolean, pad: number): Array<Cell> {
	const h = rows.size();
	const w = rows[0].size();
	const taken = new Array<boolean>();
	for (let i = 0; i < w * h; i++) taken.push(false);
	const on = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && pick(rows[y][x]);
	const out = new Array<Cell>();
	for (let y = 0; y < h; y++) {
		let x = 0;
		while (x < w) {
			if (!on(x, y) || taken[y * w + x]) {
				x++;
				continue;
			}
			let x1 = x;
			while (x1 + 1 < w && on(x1 + 1, y) && !taken[y * w + x1 + 1]) x1++;
			let y1 = y;
			let grow = true;
			while (grow && y1 + 1 < h) {
				for (let k = x; k <= x1; k++) {
					if (!on(k, y1 + 1) || taken[(y1 + 1) * w + k]) grow = false;
				}
				if (grow) y1++;
			}
			for (let yy = y; yy <= y1; yy++) for (let k = x; k <= x1; k++) taken[yy * w + k] = true;
			out.push({ x: x - pad, y: y - pad, w: x1 - x + 1, h: y1 - y + 1 });
			x = x1 + 1;
		}
	}
	return out;
}

/** the glyph's 8-neighbour dilation, one texel wider all round: the outline is drawn as this, under the glyph */
function dilate(rows: Texels): Texels {
	const h = rows.size();
	const w = rows[0].size();
	const out: Texels = [];
	for (let y = -1; y <= h; y++) {
		const line = new Array<number>();
		for (let x = -1; x <= w; x++) {
			let hit = 0;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const yy = y + dy;
					const xx = x + dx;
					if (yy >= 0 && yy < h && xx >= 0 && xx < w && rows[yy][xx] !== 0) hit = 1;
				}
			}
			line.push(hit);
		}
		out.push(line);
	}
	return out;
}

const isAny = (v: number): boolean => v !== 0;
const isLit = (v: number): boolean => v === 2;

function glyph(rows: Texels): Glyph {
	return {
		w: rows[0].size(),
		h: rows.size(),
		outline: cover(dilate(rows), isAny, 1),
		fill: cover(rows, isAny, 0),
		light: cover(rows, isLit, 0),
	};
}

/** the three marks; each is readable by its SHAPE alone (1 = fill, 2 = lit edge) */
export const GLYPHS = {
	/** chasing: "!" */
	bang: glyph([
		[2, 1],
		[2, 1],
		[2, 1],
		[0, 0],
		[2, 1],
	]),
	/** suspicious, searching: "?" */
	query: glyph([
		[2, 2, 2],
		[0, 0, 1],
		[0, 1, 1],
		[0, 0, 0],
		[0, 1, 0],
	]),
	/** idle, near you: a dot */
	dot: glyph([
		[2, 1],
		[1, 1],
	]),
};

/** what a zombie's mark is doing: its state, and for how long */
interface MarkState {
	aware: number;
	/** seconds since `aware` last changed */
	t: number;
	/** the state it had before, drawn fading out when it drops to idle */
	prev: number;
	seen: number;
}

/** a survivor a mark must never cover */
export interface MarkAvoid {
	x: number;
	y: number;
}

export class AwarenessMarks {
	readonly renderer: Renderer;
	private readonly marks = new Map<number, MarkState>();
	private readonly gone = new Array<number>();
	private frame = 0;
	/** Reduce Motion: the pop and the tilt stop; the rim (a colour, not a movement) stays */
	reduceMotion = false;

	constructor(parent: GuiObject, zIndex: number) {
		this.renderer = new Renderer(parent, "AwarenessMarks");
		this.renderer.layer.ZIndex = zIndex;
	}

	hide(): void {
		this.renderer.releaseAll();
		this.marks.clear();
	}

	/**
	 * One frame of marks. `avoid[0]` is the local survivor (the idle dots are measured from them); every entry is
	 * a body a mark must never cover. `world` lets a roof hide what is under it (undefined: nothing is hidden).
	 */
	draw(
		cam: Camera,
		v: ViewRect,
		zombies: ReadonlyArray<ZombieState>,
		avoid: ReadonlyArray<MarkAvoid>,
		dt: number,
		world?: WorldData,
	): void {
		const r = this.renderer;
		this.frame += 1;
		r.setView(cam.viewW, cam.viewH);
		r.beginFrame();
		const up = cam.screenDirToWorld(0, -1);
		const right = cam.screenDirToWorld(1, 0);
		const me = avoid[0];
		for (const z of zombies) {
			const aware = z.hp > 0 || (z.fuse ?? -1) > 0 ? (z.aware ?? 0) : 0;
			let m = this.marks.get(z.id);
			if (m === undefined) {
				// first sight of this body: whatever it is doing, it is not news — no pop
				m = { aware, t: POP_TIME + RIM_TIME, prev: 0, seen: 0 };
				this.marks.set(z.id, m);
			} else if (m.aware !== aware) {
				m.prev = m.aware;
				m.aware = aware;
				m.t = 0;
			} else {
				m.t += dt;
			}
			m.seen = this.frame;
			const alpha = math.clamp(z.alpha, 0, 1);
			if (alpha <= 0.02) continue;
			const rad = zombieRadius(z);
			if (
				z.x + rad < v.minX - 60 ||
				z.x - rad > v.maxX + 60 ||
				z.y + rad < v.minY - 80 ||
				z.y - rad > v.maxY + 60
			) {
				continue;
			}
			if (world !== undefined && underRoof(world, z.x, z.y)) continue;
			// what to draw, how big and how opaque
			let shown = m.aware;
			let k = alpha;
			let scale = 1;
			if (shown === 0) {
				if (m.prev !== 0 && m.t < FADE_OUT) {
					// it gave up: the "?" (or "!") it had fades where it stood
					shown = m.prev;
					k *= 1 - m.t / FADE_OUT;
				} else {
					if (me === undefined) continue;
					const d = math.sqrt((z.x - me.x) * (z.x - me.x) + (z.y - me.y) * (z.y - me.y));
					if (d > CALM_NEAR) continue;
					k *= 0.85 * math.clamp((CALM_NEAR - d) / CALM_FADE, 0, 1);
				}
			} else if (!this.reduceMotion && m.t < POP_TIME) {
				const p = m.t / POP_TIME;
				scale = POP_SCALE + (1 - POP_SCALE) * (1 - (1 - p) * (1 - p));
			}
			if (shown === 3 && m.aware === 3 && m.t > CHASE_SETTLE) scale *= SETTLED_SCALE;
			if (k <= 0.02) continue;
			const rim = m.aware !== 0 && m.t < RIM_TIME ? 1 - m.t / RIM_TIME : 0;
			const tilt = shown === 2 && !this.reduceMotion ? math.sin(m.t * SEARCH_TILT_SPEED + z.id) * SEARCH_TILT : 0;
			const g = shown === 3 ? GLYPHS.bang : shown === 0 ? GLYPHS.dot : GLYPHS.query;
			// above the head, in screen terms; the jumper's lift raises it with the body
			const lift = math.max(0, z.jumpHeight ?? 0);
			const above = rad * 1.9 + lift + (g.h * MARK_TEXEL * scale) / 2 + 2;
			let mx = z.x + up.x * above;
			let my = z.y + up.y * above;
			for (const s of avoid) {
				const dx = mx - s.x;
				const dy = my - s.y;
				if (dx * dx + dy * dy >= SURVIVOR_CLEAR * SURVIVOR_CLEAR) continue;
				// slide sideways (screen right or left, away from the survivor) until it clears them
				const du = dx * up.x + dy * up.y;
				const dr = dx * right.x + dy * right.y;
				const side = dr >= 0 ? 1 : -1;
				const need = math.sqrt(math.max(0, SURVIVOR_CLEAR * SURVIVOR_CLEAR - du * du)) + 1;
				const shift = side * need - dr;
				mx += right.x * shift;
				my += right.y * shift;
			}
			this.drawGlyph(cam, g, shown, mx, my, scale, tilt, k, rim);
		}
		// forget the marks of bodies that stopped arriving
		const gone = this.gone;
		gone.clear();
		for (const [id, m] of this.marks) {
			if (m.seen !== this.frame) gone.push(id);
		}
		for (const id of gone) this.marks.delete(id);
		r.endFrame();
	}

	private drawGlyph(
		cam: Camera,
		g: Glyph,
		aware: number,
		cx: number,
		cy: number,
		scale: number,
		tilt: number,
		alpha: number,
		rim: number,
	): void {
		const fill = aware === 3 ? MARK_COLORS.hunt : aware === 0 ? MARK_COLORS.calm : MARK_COLORS.alert;
		const light =
			aware === 3 ? MARK_COLORS.huntLight : aware === 0 ? MARK_COLORS.calmLight : MARK_COLORS.alertLight;
		const outline = rim > 0 ? MARK_COLORS.outline.Lerp(COLORS.white, rim) : MARK_COLORS.outline;
		const t = MARK_TEXEL * scale;
		this.cells(cam, g, g.outline, outline, cx, cy, t, tilt, alpha, 1);
		this.cells(cam, g, g.fill, fill, cx, cy, t, tilt, alpha, 2);
		this.cells(cam, g, g.light, light, cx, cy, t, tilt, alpha, 3);
	}

	/** draws texel rectangles of `g`, upright on screen, centred on (cx, cy), turned by `tilt` */
	private cells(
		cam: Camera,
		g: Glyph,
		list: Array<Cell>,
		color: Color3,
		cx: number,
		cy: number,
		t: number,
		tilt: number,
		alpha: number,
		z: number,
	): void {
		// screen-aligned axes in world terms, turned by the tilt
		const ca = math.cos(cam.angle - tilt);
		const sa = math.sin(cam.angle - tilt);
		// screen right = (ca, -sa), screen down = (sa, ca) — the same rotation as Camera.screenDirToWorld
		for (const c of list) {
			const lx = (c.x + c.w / 2 - g.w / 2) * t;
			const ly = (c.y + c.h / 2 - g.h / 2) * t;
			this.renderer.drawRect(cam, cx + lx * ca + ly * sa, cy - lx * sa + ly * ca, {
				w: c.w * t,
				h: c.h * t,
				color,
				alpha,
				rotation: tilt - cam.angle,
				zIndex: z,
			});
		}
	}
}
