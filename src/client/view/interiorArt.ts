/*
 * The interiors in the town's pixel art (docs/DESIGN_RULES.md ART-12): every piece of furniture, the floor
 * decoration and the frames of the doorways and windows as cells of ONE atlas (design/world-art/furniture.png,
 * painted by tools/furniture-art.mjs, its cells in ./furnitureAtlas.ts), and the walls outlined as one piece of
 * masonry with the shadow at their foot.
 *
 * ART-01 holds here as everywhere: each part is drawn this way only while its texture has an id (`artId`: the
 * atlas, `wall`, `wallShade`, the town's `blood0`/`blood1`); without it every call answers false and
 * client/view/interiorView.ts draws that thing exactly as before, with its Frames.
 *
 * A piece is ONE sprite when the atlas holds its size, facing and look (every size the planner asks for:
 * shared/game/interiors.ts); a piece of another size -- a gondola, whose length the aisles compute, a wide
 * open-plan doorway, a rug -- is two or four crops of the largest cell of its kind (its TEMPLATE), each corner of the
 * template where it belongs: the ends, the outline and the baked shadow stay whole, and only the middle is shorter.
 * What a piece shows can depend on its building (a pharmacy's shelves hold medicine: FURNITURE_ART_KIND) and on
 * `Solid.variant` (FURNITURE_LOOKS). Nothing here touches a solid or a collision box: the art stands on the piece's
 * own rect, plus the one or two texels of its shadow to the bottom right.
 *
 * Nothing allocates per frame: the sprites of each piece, decoration and frame are worked out once per world and
 * kept (`plans`), and one scratch SpriteOpts is filled per sprite.
 */
import { COLORS, Z } from "shared/engine/colors";
import { Camera } from "shared/engine/camera";
import { Renderer, SpriteOpts } from "shared/engine/renderer";
import type { Decor, Opening } from "shared/game/interiors";
import { hash01, Solid, WorldData } from "shared/game/world";
import { artId, artSize, artSlice } from "./worldArt";
import { WORLD_TEXEL, WorldArtName } from "./worldArtAssets";
import {
	FURNITURE_ART_KIND,
	FURNITURE_CELLS,
	FURNITURE_LOOKS,
	FURNITURE_TEMPLATES,
	RUG_COLOURS,
} from "./furnitureAtlas";

const BLACK = COLORS.shadow;
/** the walls' outline: the wall colour in deep shade (the town's outlines, ART-02) */
const EDGE_HOUSE = COLORS.wallHouse.Lerp(BLACK, 0.62);
const EDGE_SHOP = COLORS.wallShop.Lerp(BLACK, 0.62);
const FILL_HOUSE = COLORS.wallHouse;
const FILL_SHOP = COLORS.wallShop;
const FILL_HOUSE_INNER = COLORS.wallHouse.Lerp(COLORS.white, 0.18);
const FILL_SHOP_INNER = COLORS.wallShop.Lerp(COLORS.white, 0.18);
/** one texel: the outline's width, and how far a wall's fill reaches into the wall it joins */
const EDGE = WORLD_TEXEL;
/** the wall's foot shadow reaches this far onto the floor (the slice's border: 3 texels) */
const SHADE_OUT = 3 * WORLD_TEXEL;
/** a doorway's frame reaches this far into the wall at each end of the gap (its jambs) */
const JAMB = 2 * WORLD_TEXEL;
const DOOR_GAP = 112;
const WINDOW_GAP = 80;
const OUTER_WALL = 20;
const INNER_WALL = 16;

const BLOOD: Array<WorldArtName> = ["blood0", "blood1"];
const PAPERS = 3;
const FALLEN = 4;
/** the kinds a chair is pulled up to */
const SEATED: Record<string, boolean> = {
	table: true,
	desk: true,
	schooldesk: true,
	teacherdesk: true,
	labbench: true,
};

/**
 * The sprites of one thing, worked out once: [centre x, centre y, w, h (world), rect x, y, w, h (texels)] per
 * sprite, eight numbers each; an empty plan draws nothing (the flat drawing takes over).
 */
type Plan = Array<number>;
const NONE: Plan = [];

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

/**
 * One axis of a piece laid over a cell: the whole cell when the piece is its size (`p` = `t`), else the cell's first
 * half and its last, so both ends -- and the shadow after the last -- are the template's own. Pushes [src, srcLen,
 * dst, dstLen] per span into `out` and answers how many.
 */
function spans(out: Array<number>, p: number, t: number, cell: number, shadow: number, x0: number, k: number): number {
	if (p >= t) {
		out.push(0, cell, x0, (p + shadow) * k);
		return 1;
	}
	const a = math.floor(p / 2);
	const b = p - a + shadow;
	out.push(0, a, x0, a * k);
	out.push(cell - b, b, x0 + a * k, b * k);
	return 2;
}

const SX: Array<number> = [];
const SY: Array<number> = [];

/**
 * The plan of rect (x, y, w, h) drawn from `cell` ([x, y, w, h, shadow] in texels). `exact`: the cell is this
 * thing's own size. Otherwise the cell is a template at least as large, cropped; answers false when it is smaller.
 */
function planOver(
	out: Plan,
	x: number,
	y: number,
	w: number,
	h: number,
	cell: readonly [number, number, number, number, number],
	exact: boolean,
): boolean {
	const [cx, cy, cw, ch, sh] = cell;
	const tw = cw - sh;
	const th = ch - sh;
	const pw = exact ? tw : math.max(1, math.floor(w / WORLD_TEXEL + 0.5));
	const ph = exact ? th : math.max(1, math.floor(h / WORLD_TEXEL + 0.5));
	if (pw > tw || ph > th) return false;
	SX.clear();
	SY.clear();
	const nx = spans(SX, pw, tw, cw, sh, x, w / pw);
	const ny = spans(SY, ph, th, ch, sh, y, h / ph);
	for (let j = 0; j < ny; j++) {
		for (let i = 0; i < nx; i++) {
			const dw = SX[i * 4 + 3];
			const dh = SY[j * 4 + 3];
			out.push(SX[i * 4 + 2] + dw / 2, SY[j * 4 + 2] + dh / 2, dw, dh);
			out.push(cx + SX[i * 4], cy + SY[j * 4], SX[i * 4 + 1], SY[j * 4 + 1]);
		}
	}
	return true;
}

/** a cell by key, drawn over (x, y, w, h), exactly or cropped from template `template` */
function planCell(key: string, template: string | undefined, x: number, y: number, w: number, h: number): Plan {
	const out: Plan = [];
	const exact = FURNITURE_CELLS[key];
	if (exact !== undefined && planOver(out, x, y, w, h, exact, true)) return out;
	if (template === undefined) return NONE;
	const tk = FURNITURE_CELLS[template];
	if (tk !== undefined && planOver(out, x, y, w, h, tk, false)) return out;
	return NONE;
}

export class InteriorArt {
	private world?: WorldData;
	private readonly plans = new Map<object, Plan>();
	/** each building's furniture and walls, by the building's id (a chair looks for its table, a wall its joints) */
	private readonly pieces = new Map<number, Array<Solid>>();
	private readonly walls = new Map<number, Array<Solid>>();
	/** each wall's fill rect [x0, y0, x1, y1]: in by an outline where it is free, into its neighbour where it joins */
	private readonly fills = new Map<Solid, Array<number>>();

	/** the world the next draws are in: every plan of another world is forgotten */
	useWorld(world: WorldData): void {
		if (world === this.world) return;
		this.world = world;
		this.plans.clear();
		this.pieces.clear();
		this.walls.clear();
		this.fills.clear();
		for (const s of world.solids) {
			const id = s.parentId;
			if (id === undefined) continue;
			const map = s.kind === "furniture" ? this.pieces : s.tags === "bwall" ? this.walls : undefined;
			if (map === undefined) continue;
			let list = map.get(id);
			if (list === undefined) {
				list = [];
				map.set(id, list);
			}
			list.push(s);
		}
	}

	private draw(r: Renderer, cam: Camera, id: string, plan: Plan, z: number): void {
		for (let i = 0; i < plan.size(); i += 8) {
			const o = image(id, plan[i + 2], plan[i + 3], z);
			o.rectX = plan[i + 4];
			o.rectY = plan[i + 5];
			o.rectW = plan[i + 6];
			o.rectH = plan[i + 7];
			r.drawRect(cam, plan[i], plan[i + 1], o);
		}
	}

	// ------------------------------------------------------------------ furniture

	/** a piece of furniture in building type `bt` from the atlas; false = draw it flat */
	furniture(r: Renderer, cam: Camera, s: Solid, bt: number): boolean {
		const id = artId("furniture");
		if (id === undefined) return false;
		let plan = this.plans.get(s);
		if (plan === undefined) {
			plan = this.planPiece(s, bt);
			this.plans.set(s, plan);
		}
		if (plan.size() === 0) return false;
		this.draw(r, cam, id, plan, Z.structure);
		return true;
	}

	private planPiece(s: Solid, bt: number): Plan {
		const byType = FURNITURE_ART_KIND[s.tags];
		const art = (byType !== undefined ? byType[bt] : undefined) ?? s.tags;
		const looks = FURNITURE_LOOKS[art];
		if (looks === undefined) return NONE;
		const face = s.face ?? "bottom";
		const look = (s.variant ?? 0) % looks;
		const plan = this.planFacing(art, s, face, look);
		if (plan.size() > 0) return plan;
		// a free-standing piece laid crosswise to its front (a range of the library's stacks, set in rows across the
		// room) that its kind has no cell for: its front is one of its long sides, the one the variant picks
		const across = face === "left" || face === "right";
		if (!(across ? s.w > s.h : s.h > s.w)) return NONE;
		const k = (s.variant ?? 0) % 2 === 0;
		return this.planFacing(art, s, across ? (k ? "bottom" : "top") : k ? "right" : "left", look);
	}

	private planFacing(art: string, s: Solid, face: string, look: number): Plan {
		const key = `${art}:${s.w}x${s.h}:${face}:${look}`;
		const template = FURNITURE_TEMPLATES[`${art}:${face}:${look}:${s.w >= s.h ? "h" : "v"}`];
		return planCell(key, template, s.x, s.y, s.w, s.h);
	}

	// ------------------------------------------------------------------ decoration

	/** one piece of floor decoration of building `b`; false = draw it flat */
	decor(r: Renderer, cam: Camera, b: Solid, d: Decor): boolean {
		const k: string = d.kind;
		if (k === "blood") {
			// the town's own dried blood (ART-05), one of its two shapes by where it lies
			const id = artId(BLOOD[math.floor(hash01(d.x, d.y, 29) * 2) % 2]);
			if (id === undefined) return false;
			r.drawRect(cam, d.x + d.w / 2, d.y + d.h / 2, image(id, 64, 48, Z.decal));
			return true;
		}
		const id = artId("furniture");
		if (id === undefined) return false;
		let plan = this.plans.get(d);
		if (plan === undefined) {
			plan = this.planDecor(b, d);
			this.plans.set(d, plan);
		}
		if (plan.size() === 0) return false;
		const floor = k === "rug" || k === "mat" || k === "board" || k === "curtain" || k === "notice";
		this.draw(r, cam, id, plan, floor ? Z.floorDetail : Z.decal);
		return true;
	}

	private planDecor(b: Solid, d: Decor): Plan {
		const k: string = d.kind;
		const cx = d.x + d.w / 2;
		const cy = d.y + d.h / 2;
		const along = d.w >= d.h ? "h" : "v";
		const T = WORLD_TEXEL;
		if (k === "chair") return this.centred(`chair:${this.tableSide(b, cx, cy)}`, cx, cy);
		if (k === "chairDown") {
			return this.centred(`chairDown:${math.floor(hash01(d.x, d.y, 31) * FALLEN) % FALLEN}`, cx, cy);
		}
		if (k === "papers") {
			return this.centred(`papers:${math.floor(hash01(d.x, d.y, 33) * PAPERS) % PAPERS}`, cx, cy);
		}
		if (k === "glass") return this.centred(`glass:${along}`, cx, cy);
		if (k === "mat") return this.centred(`mat:${along}`, cx, cy);
		if (k === "curtain") return this.centred(`curtain:${along}`, cx, cy);
		if (k === "board" || k === "notice") {
			// a board on a wall: three texels from the wall side of its decoration into the room (a board is flat on
			// the wall; decoration, it blocks nothing), as long as the decoration says (cropped from the longest)
			const side = this.roomSide(b, d, along === "h");
			const t = 3 * T;
			const w = along === "h" ? d.w : t;
			const h = along === "h" ? t : d.h;
			const x = side === "left" ? d.x + d.w - t : d.x;
			const y = side === "top" ? d.y + d.h - t : d.y;
			return planCell("", `${k}:${side}`, x, y, w, h);
		}
		if (k === "rug") {
			const c = math.floor(hash01(d.x, d.y, 37) * RUG_COLOURS) % RUG_COLOURS;
			return planCell("", `rug:${c}:${along}`, d.x, d.y, d.w, d.h);
		}
		return NONE;
	}

	/** a face-free cell drawn at its own size, centred on (cx, cy) */
	private centred(key: string, cx: number, cy: number): Plan {
		const c = FURNITURE_CELLS[key];
		if (c === undefined) return NONE;
		const w = (c[2] - c[4]) * WORLD_TEXEL;
		const h = (c[3] - c[4]) * WORLD_TEXEL;
		return planCell(key, undefined, cx - w / 2, cy - h / 2, w, h);
	}

	/**
	 * Which way a board hung on a wall faces (the side of the wall its room is on): the room rect it lies in, and the
	 * nearer of that rect's two edges along it -- the wall is there, the room the other way.
	 */
	private roomSide(b: Solid, d: Decor, alongX: boolean): string {
		const cx = d.x + d.w / 2;
		const cy = d.y + d.h / 2;
		for (const q of b.rooms ?? []) {
			if (cx < q.x || cx > q.x + q.w || cy < q.y || cy > q.y + q.h) continue;
			if (alongX) return cy - q.y <= q.y + q.h - cy ? "bottom" : "top";
			return cx - q.x <= q.x + q.w - cx ? "right" : "left";
		}
		return alongX ? "bottom" : "right";
	}

	/**
	 * Which side of a chair its table is on (the chair faces it): the table, desk or school desk of the building
	 * whose edge the chair stands beside (interiors.ts `decorate` puts it 16 u off the middle of a side).
	 */
	private tableSide(b: Solid, cx: number, cy: number): string {
		const list = this.pieces.get(b.id);
		if (list !== undefined) {
			for (const p of list) {
				if (SEATED[p.tags] !== true) continue;
				const inX = cx >= p.x && cx <= p.x + p.w;
				const inY = cy >= p.y && cy <= p.y + p.h;
				if (inX && math.abs(cy - (p.y - 16)) <= 4) return "bottom";
				if (inX && math.abs(cy - (p.y + p.h + 16)) <= 4) return "top";
				if (inY && math.abs(cx - (p.x - 16)) <= 4) return "right";
				if (inY && math.abs(cx - (p.x + p.w + 16)) <= 4) return "left";
			}
		}
		return "bottom";
	}

	// ------------------------------------------------------------------ doorways and windows

	/** the frame of a doorway or a window; false = draw it flat */
	opening(r: Renderer, cam: Camera, o: Opening): boolean {
		const id = artId("furniture");
		if (id === undefined) return false;
		let plan = this.plans.get(o);
		if (plan === undefined) {
			plan = this.planOpening(o);
			this.plans.set(o, plan);
		}
		if (plan.size() === 0) return false;
		this.draw(r, cam, id, plan, Z.structure + 2);
		return true;
	}

	private planOpening(o: Opening): Plan {
		const along = o.w >= o.h;
		const len = along ? o.w : o.h;
		const thick = along ? o.h : o.w;
		// the frame reaches a jamb into the wall at each end of the gap
		const x = along ? o.x - JAMB : o.x;
		const y = along ? o.y : o.y - JAMB;
		const w = along ? o.w + 2 * JAMB : o.w;
		const h = along ? o.h : o.h + 2 * JAMB;
		const a = along ? "h" : "v";
		if (o.kind === "door") {
			return len === DOOR_GAP && thick === OUTER_WALL ? planCell(`door:${a}`, undefined, x, y, w, h) : NONE;
		}
		if (o.kind === "window") {
			return len === WINDOW_GAP && thick === OUTER_WALL
				? planCell(`window:${o.side}`, undefined, x, y, w, h)
				: NONE;
		}
		return thick === INNER_WALL ? planCell("", `inner:${a}`, x, y, w, h) : NONE;
	}

	// ------------------------------------------------------------------ walls

	/**
	 * A building's wall (`s`, tagged bwall with a parent): the shadow at its foot on the floor (`wallShade`), then
	 * the wall as masonry -- a dark outline under it (its own rect) and the plaster (`wall`, tinted as before) on
	 * top, in by one texel where the wall is free and one texel into the wall it joins where it meets one, so the
	 * walls of a building read as one outlined piece instead of a row of boxes. False = draw it flat.
	 */
	wall(r: Renderer, cam: Camera, s: Solid, house: boolean): boolean {
		const id = artId("wall");
		if (id === undefined || s.parentId === undefined) return false;
		const shade = artId("wallShade");
		if (shade !== undefined) {
			const o = image(shade, s.w + 2 * SHADE_OUT, s.h + 2 * SHADE_OUT, Z.floorDetail);
			const sl = artSlice("wallShade");
			o.scaleType = "slice";
			o.sliceX0 = sl[0];
			o.sliceY0 = sl[1];
			o.sliceX1 = sl[2];
			o.sliceY1 = sl[3];
			o.sliceScale = WORLD_TEXEL;
			r.drawRect(cam, s.x + s.w / 2, s.y + s.h / 2, o);
		}
		const inner = s.inner === true;
		r.drawRect(cam, s.x + s.w / 2, s.y + s.h / 2, edgeOpts(s.w, s.h, house ? EDGE_HOUSE : EDGE_SHOP));
		let f = this.fills.get(s);
		if (f === undefined) {
			f = this.fillOf(s);
			this.fills.set(s, f);
		}
		const size = artSize("wall");
		const o = image(id, f[2] - f[0], f[3] - f[1], Z.structure + 1);
		o.scaleType = "tile";
		o.tileW = size.w * WORLD_TEXEL;
		o.tileH = size.h * WORLD_TEXEL;
		o.imageTint = house ? (inner ? FILL_HOUSE_INNER : FILL_HOUSE) : inner ? FILL_SHOP_INNER : FILL_SHOP;
		r.drawRect(cam, (f[0] + f[2]) / 2, (f[1] + f[3]) / 2, o);
		return true;
	}

	/** the fill rect of wall `s` among its building's walls (see `wall`) */
	private fillOf(s: Solid): Array<number> {
		const x0 = s.x;
		const y0 = s.y;
		const x1 = s.x + s.w;
		const y1 = s.y + s.h;
		const sibs = this.walls.get(s.parentId ?? -1) ?? [];
		// how much of each side another wall touches: left, right, top, bottom
		const touched = [0, 0, 0, 0];
		for (const q of sibs) {
			if (q === s) continue;
			const qx1 = q.x + q.w;
			const qy1 = q.y + q.h;
			const oy = math.min(y1, qy1) - math.max(y0, q.y);
			const ox = math.min(x1, qx1) - math.max(x0, q.x);
			if (oy > 0 && math.abs(qx1 - x0) < 0.5) touched[0] += oy;
			if (oy > 0 && math.abs(q.x - x1) < 0.5) touched[1] += oy;
			if (ox > 0 && math.abs(qy1 - y0) < 0.5) touched[2] += ox;
			if (ox > 0 && math.abs(q.y - y1) < 0.5) touched[3] += ox;
		}
		const joined = (i: number, side: number): boolean => touched[i] >= side - 0.5;
		return [
			joined(0, s.h) ? x0 - EDGE : x0 + EDGE,
			joined(2, s.w) ? y0 - EDGE : y0 + EDGE,
			joined(1, s.h) ? x1 + EDGE : x1 - EDGE,
			joined(3, s.w) ? y1 + EDGE : y1 - EDGE,
		];
	}
}

/** a wall's outline: a flat dark rect under its plaster */
function edgeOpts(w: number, h: number, color: Color3): SpriteOpts {
	const o = image("", w, h, Z.structure);
	o.image = undefined;
	o.color = color;
	return o;
}
