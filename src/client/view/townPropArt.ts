/*
 * The everyday town's fixtures in the town's pixel art (docs/DESIGN_RULES.md ART-16): the street market's stalls,
 * tents, crates, carts and food truck, the street's lamps, hydrants, mailboxes, benches and bus stops, the parks'
 * playgrounds and courts, the backyards' sheds, pools, trampolines and grills, the building site's piles and plant,
 * the bank's columns and steps, and the ground they lie on -- each ONE cell of one atlas (design/world-art/
 * townProps.png, painted by tools/town-prop-art.mjs, its cells in ./townPropAtlas.ts), drawn over the fixture's own
 * rect (plus the texel of contact shadow baked to its bottom right, and a hoop's rim over the court).
 *
 * ART-01 holds here as everywhere: only while the atlas has an id (`artId`); without it every call answers false
 * and client/view/townView.ts draws that fixture exactly as before, with its Frames. A fixture whose size, facing or
 * look the atlas lacks is drawn flat too (test:world-art checks there is none in five towns).
 *
 * Light: the form is lit from the top left in the atlas (ART-02); what stands tall also casts the sun's shadow
 * (LUZ-01), the soft `shadowBox` a bin casts, drawn here each frame -- a tent's and the shelter's are the flat
 * drawing's own. Nothing allocates per frame: a fixture's cell is looked up once per world and kept, and one scratch
 * SpriteOpts is filled per sprite.
 */
import { COLORS, Z } from "shared/engine/colors";
import { Camera } from "shared/engine/camera";
import { Renderer, SpriteOpts } from "shared/engine/renderer";
import { hash01, GroundRect, Solid, WorldData } from "shared/game/world";
import { artId, artSlice } from "./worldArt";
import { WORLD_TEXEL } from "./worldArtAssets";
import { TOWN_PROP_CELLS, TOWN_PROP_FACELESS, TOWN_PROP_LOOKS, TOWN_PROP_STRIPS } from "./townPropAtlas";

/** where the shadow of something at (x, y) falls, for a shadow `len` long (worldView.ts ShadowFn, LUZ-01) */
export type ShadowFn = (x: number, y: number, len: number) => { x: number; y: number };

/** [x, y, w, h, ox, oy, shadow] in texels (./townPropAtlas.ts) */
type Cell = readonly [number, number, number, number, number, number, number];

const T = WORLD_TEXEL;
const BLACK = COLORS.shadow;
/** the soft sun shadow's opacity and its reach past the fixture (a bin's: worldView.ts drawTrashArt) */
const SUN_ALPHA = 0.4;
const SUN_PAD = 8;
const SUN_SLICE = 1.5;
/** how high each fixture stands (its sun shadow's length): what stands lower casts only its baked contact shadow */
const LIFT: Record<string, number> = {
	bench: 6,
	handcart: 6,
	foodtruck: 10,
	scaffold: 14,
	pile: 6,
	portapotty: 16,
	mixer: 6,
	dumpster: 12,
	slide: 14,
	climber: 16,
	springer: 6,
	hoop: 22,
	picnic: 6,
	postbox: 12,
	shed: 16,
	trampoline: 10,
	grill: 8,
	column: 12,
};
/** a stack of crates stands higher than one (townLots.ts CRATE_STACKED) */
const CRATE_STACKED = 1;
const CRATE_LIFT = 10;
/** a swing set's shadow is its top bar's: this thick, `SWING_LIFT` long */
const SWING_BAR = 4;
const SWING_LIFT = 18;
/** a shadow's opacity drawn as a plain rect (townView.ts SHADOW_A) */
const FLAT_SHADOW_A = 0.28;
/** a street lamp's head and a bus stop's sign, off their pole (townView.ts's flat drawing: the same spots) */
const LAMP_OUT = 24;
const SIGN_UP = 26;
/** a market tent that came down (townLots.ts TENT_DOWN; `variant` = stripe + 3 × state) */
const TENT_DOWN = 3;

const O: SpriteOpts = {};

/** the scratch options, reset, as an image */
function image(id: string, w: number, h: number, z: number): SpriteOpts {
	const o = O;
	o.w = w;
	o.h = h;
	o.zIndex = z;
	o.image = id;
	o.color = undefined;
	o.rotation = undefined;
	o.alpha = undefined;
	o.cornerRadius = undefined;
	o.circle = undefined;
	o.anchorX = undefined;
	o.anchorY = undefined;
	o.stroke = undefined;
	o.strokeThickness = undefined;
	o.strokeAlpha = undefined;
	o.imageTint = undefined;
	o.scaleType = undefined;
	o.tileW = undefined;
	o.tileH = undefined;
	o.sliceX0 = undefined;
	o.sliceY0 = undefined;
	o.sliceX1 = undefined;
	o.sliceY1 = undefined;
	o.sliceScale = undefined;
	o.pixelated = undefined;
	o.rectX = undefined;
	o.rectY = undefined;
	o.rectW = undefined;
	o.rectH = undefined;
	return o;
}

// ------------------------------------------------------------------ cells, looked up once per world

let cellsFor: WorldData | undefined;
/** each fixture's (or ground rect's) cell, or false: the atlas has none for it */
const found = new Map<object, Cell | false>();
/** a street lamp's head and a bus stop's sign, by the pole's solid */
const tops = new Map<Solid, Cell | false>();

/** the world the next draws are in: every cell of another world is forgotten */
function useWorld(world: WorldData): void {
	if (cellsFor === world) return;
	cellsFor = world;
	found.clear();
	tops.clear();
}

/** which of its tag's looks a fixture is: its `variant`, else its own pick from where it stands */
function lookOf(tag: string, variant: number | undefined, x: number, y: number): number {
	const n = TOWN_PROP_LOOKS[tag] ?? 1;
	if (variant !== undefined) return variant % n;
	return n > 1 ? math.floor(hash01(x, y, 41) * n) % n : 0;
}

/** the cell of a thing `w` × `h` with this tag, face and look; undefined when the atlas has none */
function cellOf(
	thing: object,
	tag: string,
	w: number,
	h: number,
	face: string | undefined,
	variant: number | undefined,
	x: number,
	y: number,
): Cell | undefined {
	let c = found.get(thing);
	if (c === undefined) {
		if (TOWN_PROP_STRIPS[tag] === true) {
			c = TOWN_PROP_CELLS[`${tag}:${w >= h ? "h" : "v"}`] ?? false;
		} else {
			const f = TOWN_PROP_FACELESS[tag] === true ? "-" : (face ?? "bottom");
			c = TOWN_PROP_CELLS[`${tag}:${w}x${h}:${f}:${lookOf(tag, variant, x, y)}`] ?? false;
		}
		found.set(thing, c);
	}
	return c === false ? undefined : c;
}

// ------------------------------------------------------------------ drawing

/** a whole cell over the rect at (x, y): its texels from (x, y) less the part hanging past the rect */
function drawCell(
	r: Renderer,
	cam: Camera,
	id: string,
	c: Cell,
	x: number,
	y: number,
	z: number,
	alpha?: number,
	rotation?: number,
): void {
	const w = c[2] * T;
	const h = c[3] * T;
	const o = image(id, w, h, z);
	o.rectX = c[0];
	o.rectY = c[1];
	o.rectW = c[2];
	o.rectH = c[3];
	o.alpha = alpha;
	o.rotation = rotation;
	r.drawRect(cam, x - c[4] * T + w / 2, y - c[5] * T + h / 2, o);
}

/** a cell centred (its shadow left out of the centring) on (x, y) */
function drawCellAt(r: Renderer, cam: Camera, id: string, c: Cell, x: number, y: number, z: number): void {
	drawCell(r, cam, id, c, x - ((c[2] - c[6]) * T) / 2, y - ((c[3] - c[6]) * T) / 2, z);
}

/**
 * A strip (a fence, a frame's top plate) `len` long from the long cell: the cell's first half and its last, so both
 * ends -- its outline where it has one -- are the cell's own and only the middle is shorter. One sprite when the
 * strip is as long as the cell.
 */
function drawStrip(r: Renderer, cam: Camera, id: string, c: Cell, s: Solid): void {
	const along = s.w >= s.h;
	const cellLen = along ? c[2] : c[3];
	const thick = along ? c[3] : c[2];
	const p = math.min(cellLen, math.max(1, math.floor((along ? s.w : s.h) / T + 0.5)));
	const a = p >= cellLen ? p : math.floor(p / 2);
	for (const [src, len, at] of [
		[0, a, 0],
		[cellLen - (p - a), p - a, a],
	] as Array<[number, number, number]>) {
		if (len <= 0) continue;
		const w = (along ? len : thick) * T;
		const h = (along ? thick : len) * T;
		const o = image(id, w, h, Z.structure);
		o.rectX = c[0] + (along ? src : 0);
		o.rectY = c[1] + (along ? 0 : src);
		o.rectW = along ? len : thick;
		o.rectH = along ? thick : len;
		r.drawRect(cam, s.x + (along ? at * T : 0) + w / 2, s.y + (along ? 0 : at * T) + h / 2, o);
	}
}

/** the soft shadow of something standing `lift` high over rect `s`, on the sun's side (LUZ-01) */
function sunShadow(r: Renderer, cam: Camera, s: Solid, lift: number, shadow: ShadowFn): void {
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	const so = shadow(cx, cy, lift);
	const sb = artId("shadowBox");
	if (sb === undefined) {
		const o = image("", s.w, s.h, Z.shadow);
		o.image = undefined;
		o.color = BLACK;
		o.alpha = FLAT_SHADOW_A;
		r.drawRect(cam, cx + so.x, cy + so.y, o);
		return;
	}
	const o = image(sb, s.w + SUN_PAD, s.h + SUN_PAD, Z.shadow);
	const sl = artSlice("shadowBox");
	o.scaleType = "slice";
	o.sliceX0 = sl[0];
	o.sliceY0 = sl[1];
	o.sliceX1 = sl[2];
	o.sliceY1 = sl[3];
	o.sliceScale = SUN_SLICE;
	o.alpha = SUN_ALPHA;
	r.drawRect(cam, cx + so.x, cy + so.y, o);
}

/**
 * A "prop" fixture of the everyday town (or any bench) from the atlas: its sun shadow if it stands tall, its cell,
 * and a street lamp's head or a bus stop's sign up on their pole. False = draw it flat (no atlas, or no cell).
 */
export function drawPropArt(r: Renderer, cam: Camera, s: Solid, world: WorldData, shadow: ShadowFn): boolean {
	const id = artId("townProps");
	if (id === undefined) return false;
	useWorld(world);
	const t = s.tags;
	const c = cellOf(s, t, s.w, s.h, s.face, s.variant, s.x, s.y);
	if (c === undefined) return false;
	if (TOWN_PROP_STRIPS[t] === true) {
		drawStrip(r, cam, id, c, s);
		return true;
	}
	let top: Cell | undefined;
	if (t === "streetlight" || t === "busstop") {
		let q = tops.get(s);
		if (q === undefined) {
			q = TOWN_PROP_CELLS[t === "streetlight" ? `lamphead:${s.face ?? "bottom"}` : "stopsign:-"] ?? false;
			tops.set(s, q);
		}
		if (q === false) return false;
		top = q;
	}
	const lift = t === "crates" ? ((s.variant ?? 0) === CRATE_STACKED ? CRATE_LIFT : 0) : (LIFT[t] ?? 0);
	if (t === "swings") {
		// its top bar's shadow, end to end
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const so = shadow(cx, cy, SWING_LIFT);
		const wide = s.w >= s.h;
		const o = image("", wide ? s.w : SWING_BAR, wide ? SWING_BAR : s.h, Z.shadow);
		o.image = undefined;
		o.color = BLACK;
		o.alpha = FLAT_SHADOW_A;
		r.drawRect(cam, cx + so.x, cy + so.y, o);
	} else if (lift > 0) {
		sunShadow(r, cam, s, lift, shadow);
	}
	// a pool lies in the ground, under whoever walks its coping
	drawCell(r, cam, id, c, s.x, s.y, t === "pool" ? Z.ground + 4 : Z.structure);
	if (top !== undefined) {
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		if (t === "streetlight") {
			const f = s.face;
			const nx = f === "left" ? -1 : f === "right" ? 1 : 0;
			const ny = f === "top" ? -1 : f === "bottom" || f === undefined ? 1 : 0;
			drawCellAt(r, cam, id, top, cx + nx * LAMP_OUT, cy + ny * LAMP_OUT, Z.roof - 1);
		} else {
			drawCellAt(r, cam, id, top, cx, cy - SIGN_UP, Z.roof - 1);
		}
	}
	return true;
}

/**
 * A market tent or a bus shelter's roof from the atlas (both aerial: see-through with a body under them,
 * `canopyAlpha`): the sun's shadow of a standing roof (the flat drawing's), the roof turned by its `heading` (a tent
 * stands a few degrees askew; one that came down lies on its tables, under every actor). False = draw it flat.
 */
export function drawCanopyArt(r: Renderer, cam: Camera, s: Solid, shadow: ShadowFn): boolean {
	const id = artId("townProps");
	if (id === undefined) return false;
	const c = cellOf(s, s.tags, s.w, s.h, s.face, s.variant, s.x, s.y);
	if (c === undefined) return false;
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	const th = s.heading ?? 0;
	if (s.tags === "tent" && math.floor((s.variant ?? 0) / 3) === TENT_DOWN) {
		drawCell(r, cam, id, c, s.x, s.y, Z.structure + 6, undefined, th);
		return true;
	}
	const a = s.canopyAlpha ?? 1;
	const so = shadow(cx, cy, s.tags === "tent" ? 26 : 20);
	const o = image("", s.w, s.h, Z.shadow);
	o.image = undefined;
	o.color = BLACK;
	o.alpha = 0.22 * a + 0.04;
	o.rotation = th;
	r.drawRect(cam, cx + so.x, cy + so.y, o);
	drawCell(r, cam, id, c, s.x, s.y, Z.roof, a, th);
	return true;
}

/** the everyday town's own ground (a court, a sand pit, the bank's steps, the market's litter...) from the atlas */
export function drawGroundArt(r: Renderer, cam: Camera, g: GroundRect): boolean {
	const id = artId("townProps");
	if (id === undefined) return false;
	const k: string = g.kind;
	const c = cellOf(g, k, g.w, g.h, undefined, undefined, g.x, g.y);
	if (c === undefined) return false;
	const litter = k === "spill" || k === "paper" || k === "bag";
	drawCell(r, cam, id, c, g.x, g.y, litter ? Z.ground + 4 : Z.ground + 3);
	return true;
}
