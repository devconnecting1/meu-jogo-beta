/*
 * The buildings' doors and entrances in the town's pixel art (docs/DESIGN_RULES.md ART-17): each doorway's cells of
 * ONE atlas (design/world-art/entrances.png, painted by tools/entrance-art.mjs, its cells in ./entranceAtlas.ts) --
 * the ground outside it and what lies there (the leaves pinned outside, a door torn off, a barricade's stubs), the
 * doorway's frame and the leaves pinned inside (with the roof off), and the lintel on the roof's edge (roof on).
 * Which entrance a doorway is: ./entrances.ts.
 *
 * ART-01 holds here as everywhere: only while the atlas has an id (`artId`); without it every call answers false and
 * client/view/interiorView.ts draws the entrance flat. The atlas is baked per side (the light never turns with a
 * door): a cell is drawn where the generator says it lies from the doorway's gap, never rotated.
 *
 * VISUAL ONLY: the doorway stays the open gap the horde and the survivor walk through (EDI-09). Where a leaf rests is
 * worked out once per world, per doorway, from the town alone (nothing a survivor builds): pinned flat against the
 * wall beside the gap where that wall runs on under it and nothing stands there -- a window, a partition, a piece of
 * furniture, a board on the wall, a tree, a car --, else swung square to the wall at its jamb, else not drawn. The
 * middle of the gap is never covered (test:world-art §15).
 *
 * Nothing allocates per frame: a doorway's plan is built the first time it is drawn and kept; one scratch SpriteOpts.
 */
import { Z } from "shared/engine/colors";
import { Camera, ViewRect } from "shared/engine/camera";
import { Renderer, SpriteOpts } from "shared/engine/renderer";
import type { Opening } from "shared/game/interiors";
import { querySolids, Solid, WorldData } from "shared/game/world";
import { overlaps } from "./drawKit";
import { ENTRANCE_CELLS, ENTRANCE_LOOKS, ENTRANCE_SINGLE_LEAF } from "./entranceAtlas";
import { doorPick, doorShattered, doorWear, entranceStyle } from "./entrances";
import { artId } from "./worldArt";
import { WORLD_TEXEL } from "./worldArtAssets";

/** [x, y, w, h, ox, oy, shadow] in texels (./entranceAtlas.ts) */
type Cell = readonly [number, number, number, number, number, number, number];

const T = WORLD_TEXEL;
/** the only doorway the atlas is painted for: 112 u across a 20 u wall (ESC-02) */
const GAP_U = 112;
const WALL_U = 20;
/** the floor under the ground's own detail, the frame over the walls, the lintel over the roof (interiorView's) */
const Z_GROUND = Z.floorDetail + 1;
const Z_FRAME = Z.structure + 2;
const Z_LINTEL = Z.roof + 2;
/** the solids a survivor builds or that fly (never where a leaf rests: the plan is the town's alone) */
const IGNORED: Record<string, boolean> = {
	barricade: true,
	iron_barricade: true,
	door: true,
	iron_door: true,
	structure: true,
	canopy: true,
};
/** decoration on a wall that a leaf pinned against it would cover */
const ON_WALL: Record<string, boolean> = { board: true, notice: true, curtain: true };
/** the jambs a leaf may hang from, in the order tried */
const BOTH: ReadonlyArray<string> = ["a", "b"];
const BOTH_B: ReadonlyArray<string> = ["b", "a"];
const ONLY_A: ReadonlyArray<string> = ["a"];
const ONLY_B: ReadonlyArray<string> = ["b"];
/** inside, where a leaf rests: flat against the wall, else square at its jamb */
const IN_MODES: ReadonlyArray<string> = ["inFlat", "inSquare"];

/** a cell drawn at a world rect (x, y: its top-left; w, h with its baked shadow) */
export interface Piece {
	/** the atlas key (./entranceAtlas.ts), which says what the piece is */
	key: string;
	cell: Cell;
	x: number;
	y: number;
	w: number;
	h: number;
}

/** everything a doorway draws with the atlas, worked out once */
export interface DoorPlan {
	/** the ground outside, and what lies on it: the leaves pinned outside, a torn-off door, a barricade's stubs */
	outside: Array<Piece>;
	/** with the roof off: the frame across the wall, and the leaves pinned inside */
	inside: Array<Piece>;
	lintel?: Piece;
	/** the flat bounds of all of it, for culling */
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

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

/** does rect (x, y, w, h) overlap solid `s` by more than a sliver (touching is not overlapping) */
function hits(x: number, y: number, w: number, h: number, s: { x: number; y: number; w: number; h: number }): boolean {
	return x < s.x + s.w - 0.5 && x + w > s.x + 0.5 && y < s.y + s.h - 0.5 && y + h > s.y + 0.5;
}

const SCRATCH: Array<Solid> = [];
const SPANS: Array<number> = [];

export class EntranceArt {
	private world?: WorldData;
	private readonly plans = new Map<Opening, DoorPlan | false>();

	/** the world the next draws are in: every plan of another world is forgotten */
	useWorld(world: WorldData): void {
		if (world === this.world) return;
		this.world = world;
		this.plans.clear();
	}

	/** the atlas's id, or undefined: draw every entrance flat */
	live(): string | undefined {
		return artId("entrances");
	}

	/**
	 * The ground outside doorway `o` of building `b` and what lies on it, under every body and item: the stoop, the
	 * leaves pinned outside, a door torn off, a barricade's stubs. False = draw it flat.
	 */
	outside(r: Renderer, cam: Camera, b: Solid, o: Opening, v: ViewRect): boolean {
		const id = this.live();
		if (id === undefined) return false;
		const plan = this.planOf(b, o);
		if (plan === undefined) return false;
		if (!overlaps(plan.x0, plan.y0, plan.x1 - plan.x0, plan.y1 - plan.y0, v)) return true;
		for (const p of plan.outside) this.draw(r, cam, id, p, Z_GROUND, undefined);
		return true;
	}

	/** doorway `o` with the roof off: its frame across the wall and the leaves pinned inside. False = the old frame */
	doorway(r: Renderer, cam: Camera, b: Solid, o: Opening): boolean {
		const id = this.live();
		if (id === undefined) return false;
		const plan = this.planOf(b, o);
		if (plan === undefined) return false;
		for (const p of plan.inside) this.draw(r, cam, id, p, Z_FRAME, undefined);
		return true;
	}

	/** the lintel over doorway `o` on the roof's edge, faded with the roof. False = the flat eave */
	lintel(r: Renderer, cam: Camera, b: Solid, o: Opening, alpha: number): boolean {
		const id = this.live();
		if (id === undefined) return false;
		const plan = this.planOf(b, o);
		if (plan === undefined || plan.lintel === undefined) return false;
		this.draw(r, cam, id, plan.lintel, Z_LINTEL, alpha);
		return true;
	}

	private draw(r: Renderer, cam: Camera, id: string, p: Piece, z: number, alpha: number | undefined): void {
		const c = p.cell;
		const s = image(id, p.w, p.h, z);
		s.rectX = c[0];
		s.rectY = c[1];
		s.rectW = c[2];
		s.rectH = c[3];
		s.alpha = alpha;
		r.drawRect(cam, p.x + p.w / 2, p.y + p.h / 2, s);
	}

	// ------------------------------------------------------------------ the plan of a doorway (once per world)

	/** doorway `o`'s plan, built the first time it is asked for; undefined when the atlas has no cells for it */
	planOf(b: Solid, o: Opening): DoorPlan | undefined {
		let plan = this.plans.get(o);
		if (plan === undefined) {
			plan = this.build(b, o) ?? false;
			this.plans.set(o, plan);
		}
		return plan === false ? undefined : plan;
	}

	private piece(o: Opening, key: string): Piece | undefined {
		const c = ENTRANCE_CELLS[key];
		if (c === undefined) return undefined;
		return { key, cell: c, x: o.x + c[4] * T, y: o.y + c[5] * T, w: c[2] * T, h: c[3] * T };
	}

	private build(b: Solid, o: Opening): DoorPlan | undefined {
		const world = this.world;
		if (world === undefined || o.kind !== "door") return undefined;
		const along = o.side === "top" || o.side === "bottom";
		if ((along ? o.w : o.h) !== GAP_U || (along ? o.h : o.w) !== WALL_U) return undefined;
		const style = entranceStyle(b.buildingType ?? 1, o.main);
		const side = o.side;
		const look = (part: string, fixed: number | undefined, salt: number): number =>
			fixed ?? doorPick(o, salt, ENTRANCE_LOOKS[part] ?? 1);
		const stoop = this.piece(
			o,
			`stoop:${style.stoop}:${side}:${look(`stoop:${style.stoop}`, style.stoopLook, 89)}`,
		);
		const frame = this.piece(o, `frame:${style.frame}:${side}`);
		const lintel = this.piece(o, `roof:${style.roof}:${side}:${look(`roof:${style.roof}`, style.roofLook, 91)}`);
		if (stoop === undefined || frame === undefined || lintel === undefined) return undefined;
		const plan: DoorPlan = { outside: [stoop], inside: [frame], lintel, x0: 0, y0: 0, x1: 0, y1: 0 };
		const wear = style.wear ? doorWear(o) : 0;
		const torn = wear === 1 ? (doorPick(o, 93, 2) === 0 ? "a" : "b") : undefined;
		const shattered = style.shatter ? doorShattered(o) : 0;
		// the torn-off leaf's paint: a front door's (wood looks 0-3) or a back door's (plank, after them)
		let paint = 0;
		for (const leaf of style.leaves) {
			const n = ENTRANCE_LOOKS[`leaf:${leaf.kind}`] ?? 1;
			const base = leaf.look ?? doorPick(o, 85, n);
			if (leaf.kind === "wood") paint = base;
			else if (leaf.kind === "plank") paint = (ENTRANCE_LOOKS["leaf:wood"] ?? 0) + base;
			const outsideOnly = leaf.outsideOnly === true;
			if (ENTRANCE_SINGLE_LEAF[leaf.kind] === true) {
				// a single door: ONE leaf, hung at the jamb its place picks -- or, where that side has no room, the other
				// (a door torn off leaves none: it lies on the step)
				if (torn !== undefined) continue;
				const first = doorPick(o, 99, 2) === 0 ? "a" : "b";
				const hands = first === "a" ? BOTH : BOTH_B;
				this.restOf(world, plan, b, o, leaf.kind, leaf.inward, outsideOnly, hands, base);
				continue;
			}
			for (const hand of BOTH) {
				if (hand === torn) continue;
				// a shop's glass: one leaf's shattered (look 1), the other as the door's
				const k =
					leaf.kind === "glass" && shattered !== 0 ? ((shattered === 1) === (hand === "a") ? 1 : 0) : base;
				this.restOf(world, plan, b, o, leaf.kind, leaf.inward, outsideOnly, hand === "a" ? ONLY_A : ONLY_B, k);
			}
		}
		if (torn !== undefined) {
			const p = this.piece(o, `fallen:${torn}:${side}:${paint * 2 + doorPick(o, 95, 2)}`);
			if (p !== undefined && this.clear(world, b, p, false)) plan.outside.push(p);
		} else if (wear === 2) {
			const p = this.piece(o, `boards:${side}:${doorPick(o, 97, ENTRANCE_LOOKS.boards ?? 1)}`);
			if (p !== undefined) plan.outside.push(p);
		}
		let x0 = math.huge;
		let y0 = math.huge;
		let x1 = -math.huge;
		let y1 = -math.huge;
		for (const list of [plan.outside, plan.inside]) {
			for (const p of list) {
				x0 = math.min(x0, p.x);
				y0 = math.min(y0, p.y);
				x1 = math.max(x1, p.x + p.w);
				y1 = math.max(y1, p.y + p.h);
			}
		}
		plan.x0 = x0;
		plan.y0 = y0;
		plan.x1 = x1;
		plan.y1 = y1;
		return plan;
	}

	/**
	 * Where ONE leaf of doorway `o` rests, the first place that is free, hung at the jambs `hands` in that order (a
	 * double door's leaf has its own jamb; a single door's may hang from either): a door that opens out, pinned flat
	 * against the wall outside; else (and a door that opens in) pinned flat against the wall inside; else square to the
	 * wall at its jamb, inside; else nowhere. Pinned flat needs that stretch of wall whole under the leaf (no window,
	 * no other door, no corner) and nothing standing there; square, nothing of the building in its way. Never square
	 * outside: a leaf sticking out over the sidewalk would read as a post in the way.
	 */
	private restOf(
		world: WorldData,
		plan: DoorPlan,
		b: Solid,
		o: Opening,
		kind: string,
		inward: boolean,
		outsideOnly: boolean,
		hands: ReadonlyArray<string>,
		look: number,
	): void {
		const side = o.side;
		if (!inward) {
			for (const hand of hands) {
				const out = this.piece(o, `leaf:${kind}:outFlat:${hand}:${side}:${look}`);
				if (out !== undefined && this.wallRunsOn(world, b, o, out) && this.clear(world, b, out, false)) {
					plan.outside.push(out);
					return;
				}
			}
			if (outsideOnly) return;
		}
		for (const mode of IN_MODES) {
			for (const hand of hands) {
				const p = this.piece(o, `leaf:${kind}:${mode}:${hand}:${side}:${look}`);
				if (p === undefined) continue;
				if (mode === "inFlat" && !this.wallRunsOn(world, b, o, p)) continue;
				if (!this.clear(world, b, p, true)) continue;
				plan.inside.push(p);
				return;
			}
		}
	}

	/** the body of a piece (its baked shadow left out) */
	private body(p: Piece): [number, number, number, number] {
		const s = p.cell[6] * T;
		return [p.x, p.y, p.w - s, p.h - s];
	}

	/**
	 * Does the doorway's own wall run on, whole, under the leaf pinned beside the gap (no window, no other door, no
	 * corner before its end)? Measured in the wall's band: the union of the building's outside wall pieces there.
	 */
	private wallRunsOn(world: WorldData, b: Solid, o: Opening, p: Piece): boolean {
		const [px, py, pw, ph] = this.body(p);
		const along = o.side === "top" || o.side === "bottom";
		// the band: the wall's thickness, from the jamb along the leaf and a texel past its far end
		const l0 = along ? px : py;
		const l1 = along ? px + pw : py + ph;
		const before = l1 <= (along ? o.x : o.y) + 0.5;
		const a0 = before ? l0 - T : l0;
		const a1 = before ? l1 : l1 + T;
		const c0 = along ? o.y : o.x;
		const c1 = along ? o.y + o.h : o.x + o.w;
		SCRATCH.clear();
		if (along) querySolids(world, a0, c0 + 1, a1, c1 - 1, SCRATCH);
		else querySolids(world, c0 + 1, a0, c1 - 1, a1, SCRATCH);
		SPANS.clear();
		for (const s of SCRATCH) {
			if (s.parentId !== b.id || s.tags !== "bwall" || s.inner === true) continue;
			// the piece must cover the band's whole thickness
			const t0 = along ? s.y : s.x;
			const t1 = along ? s.y + s.h : s.x + s.w;
			if (t0 > c0 + 0.5 || t1 < c1 - 0.5) continue;
			const s0 = math.max(a0, along ? s.x : s.y);
			const s1 = math.min(a1, along ? s.x + s.w : s.y + s.h);
			if (s1 > s0) SPANS.push(s0, s1);
		}
		// the union of the spans from a0: sorted by start, each must begin where the covered stretch ends
		let covered = a0;
		let grew = true;
		while (grew) {
			grew = false;
			for (let i = 0; i < SPANS.size(); i += 2) {
				if (SPANS[i] <= covered + 0.5 && SPANS[i + 1] > covered) {
					covered = SPANS[i + 1];
					grew = true;
				}
			}
		}
		return covered >= a1 - 0.5;
	}

	/**
	 * Nothing of the town where a leaf would rest: inside, the building's own furniture, partitions, walls met at a
	 * corner and boards hung on the wall; outside, any solid of the town but the building's own wall behind it.
	 */
	private clear(world: WorldData, b: Solid, p: Piece, inward: boolean): boolean {
		const [x, y, w, h] = this.body(p);
		SCRATCH.clear();
		querySolids(world, x, y, x + w, y + h, SCRATCH);
		for (const s of SCRATCH) {
			if (s === b || IGNORED[s.kind] === true) continue;
			if (s.kind === "building") {
				// another building's record: only where its footprint is (a porch's notch is not)
				if (hits(x, y, w, h, s) && !inward) {
					for (const q of s.parts ?? [s]) if (hits(x, y, w, h, q)) return false;
				}
				continue;
			}
			if (inward && s.parentId !== b.id) continue;
			if (hits(x, y, w, h, s)) return false;
		}
		if (inward) {
			for (const d of b.decor ?? []) if (ON_WALL[d.kind] === true && hits(x, y, w, h, d)) return false;
		} else {
			// outside, the building's own footprint (a wing beside a porch, the other side of a notch)
			for (const q of b.parts ?? []) if (hits(x, y, w, h, q)) return false;
		}
		return true;
	}
}
