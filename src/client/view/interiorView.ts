/*
 * The inside of a building on screen (docs/DESIGN_RULES.md EDI-08..EDI-14): furniture, floor decoration, the frames
 * of doorways and windows, and the marks that show a building's entrances and windows from outside with the roof
 * on. The plan itself is shared/game/interiors.ts; client/view/worldView.ts calls in here.
 *
 * Everything here is drawn with plain Frames in the palette of shared/engine/colors.ts (ART colours, never UI
 * tokens): it looks right with no uploaded asset at all, next to the flat town or the textured one. With the
 * interiors' atlas uploaded, each piece, decoration and frame is drawn by client/view/interiorArt.ts instead (the
 * town's pixel art, ART-12), and falls back here on its own when its texture has no id (ART-01).
 *
 * Culling: an interior under a roof that is on is never drawn -- not its floors, walls, furniture, decoration or
 * frames (worldView asks `roofOpaque` first). A closed roof covers the whole footprint, so that costs nothing to
 * look at and saves most of a building's sprites; inside the largest building the survivor sees ~100.
 *
 * Nothing allocates per call: one scratch SpriteOpts, reset by `flat()`, filled and handed to the renderer.
 */
import { COLORS, Z } from "shared/engine/colors";
import { Camera, ViewRect } from "shared/engine/camera";
import { TOWN } from "shared/engine/constants";
import { Renderer, SpriteOpts } from "shared/engine/renderer";
import type { Decor, FloorKind, Opening } from "shared/game/interiors";
import { Solid, WorldData } from "shared/game/world";
import { windowIntact } from "shared/game/windows";
import { overlaps, SIDES } from "./drawKit";
import { EntranceArt } from "./entranceArt";
import { entranceStyle, FlatRect } from "./entrances";
import { InteriorArt } from "./interiorArt";

const BLACK = COLORS.shadow;
const WHITE = COLORS.white;

/** a roof at or above this alpha hides everything under it */
export const ROOF_OPAQUE = 0.999;

/** flat colour of each floor kind */
export const FLOOR_FLAT: Record<FloorKind, Color3> = {
	wood: COLORS.floorWood,
	tile: COLORS.floorTile,
	shop: COLORS.floorShop,
	carpet: COLORS.floorCarpet,
	kitchen: COLORS.floorKitchen,
	bath: COLORS.floorBath,
	concrete: COLORS.floorConcrete,
};

const WALL_INNER_HOUSE = COLORS.wallHouse.Lerp(WHITE, 0.18);
const WALL_INNER_SHOP = COLORS.wallShop.Lerp(WHITE, 0.18);
const GLASS_DARK = COLORS.carGlass;
const BLOOD_DRY = COLORS.blood.Lerp(BLACK, 0.35);
const RUG_BORDER = COLORS.rug.Lerp(COLORS.goodsC, 0.35);
/** a notice board's cork, and the reagent bottles on a lab's shelves (EDI-17) */
const CORK = COLORS.furnWood.Lerp(COLORS.goodsC, 0.35);
const BOTTLES: Array<Color3> = [COLORS.furnWood, COLORS.acid, COLORS.goodsB];

// ---- window glass (EDI-18)
/** an intact pane seen from above: the glass over the sill, more solid than the tint an open frame keeps */
const PANE_ALPHA = 0.62;
/** the streak of light on an intact pane (from inside, and on the roof's edge with the art) */
const GLINT = COLORS.glassCold.Lerp(WHITE, 0.7);
/** a broken window's mark on the roof's edge: the dark room seen through the empty frame, darker than glass */
const HOLE_DARK = COLORS.carGlass.Lerp(BLACK, 0.55);
/** the shards on the ground: this far out of the wall's face (their decal's middle) */
const SHARD_OFF = 20;
/**
 * Their layer: the ground's own detail with the doormats, under the blood (Z.decal) and every item and body. Not
 * Z.decal itself: the town's sprites drawn after the fight's blood in that sub-pool would turn a blood decal's birth
 * into a shift of every shard behind it (the pool's O(1) birth, tools/test-pool.mjs §2).
 */
const Z_SHARDS = Z.floorDetail + 1;

/** is this window's glass in? (its solid, `Opening.glass`; a plan without one reads as the old open frame) */
function paneIntact(o: Opening): boolean {
	const g = o.glass;
	return g !== undefined && windowIntact(g);
}

const O: SpriteOpts = {};

/** the scratch options, reset, as a flat rect */
function flat(w: number, h: number, color: Color3, z: number): SpriteOpts {
	const o = O;
	o.w = w;
	o.h = h;
	o.color = color;
	o.zIndex = z;
	o.alpha = undefined;
	o.rotation = undefined;
	o.cornerRadius = undefined;
	o.circle = undefined;
	o.anchorX = undefined;
	o.anchorY = undefined;
	o.stroke = undefined;
	o.strokeThickness = undefined;
	o.strokeAlpha = undefined;
	o.image = undefined;
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
	return o;
}

/** outline the scratch rect */
function edged(o: SpriteOpts, stroke: Color3, alpha = 0.7, thick = 1): SpriteOpts {
	o.stroke = stroke;
	o.strokeAlpha = alpha;
	o.strokeThickness = thick;
	return o;
}

/** outward normal of a side */
function normalX(side: string): number {
	return side === "left" ? -1 : side === "right" ? 1 : 0;
}
function normalY(side: string): number {
	return side === "top" ? -1 : side === "bottom" ? 1 : 0;
}

export class InteriorView {
	/** building records by id, for the walls and furniture that name their parent (built once per world) */
	private readonly parents = new Map<number, Solid>();
	private parentsFor?: WorldData;
	/** the pixel-art drawing of all of it, used where its textures have ids (ART-01) */
	readonly art = new InteriorArt();
	/** the doors and entrances in pixel art (ART-17), where the entrances' atlas has an id */
	readonly entrances = new EntranceArt();

	/** the world the frame's interiors are drawn in (worldView, once per frame): the art's plans are per world */
	useWorld(world: WorldData): void {
		this.art.useWorld(world);
		this.entrances.useWorld(world);
	}

	/** the building a wall, window or piece of furniture belongs to */
	parentOf(world: WorldData, s: Solid): Solid | undefined {
		if (world !== this.parentsFor) {
			this.parents.clear();
			for (const q of world.solids) if (q.kind === "building") this.parents.set(q.id, q);
			this.parentsFor = world;
		}
		const id = s.parentId;
		return id !== undefined ? this.parents.get(id) : undefined;
	}

	/** is this building's interior hidden under its roof right now? */
	roofOpaque(b: Solid | undefined): boolean {
		return b !== undefined && (b.roofAlpha ?? 1) >= ROOF_OPAQUE;
	}

	// ------------------------------------------------------------------ walls and furniture (solids)

	/** a wall of a building: the outside walls in the type's colour, partitions a shade lighter */
	drawWall(r: Renderer, cam: Camera, s: Solid, house: boolean): void {
		const base = house ? COLORS.wallHouse : COLORS.wallShop;
		const color = s.inner === true ? (house ? WALL_INNER_HOUSE : WALL_INNER_SHOP) : base;
		const o = edged(flat(s.w, s.h, color, Z.structure), COLORS.wallWood, 0.8);
		r.drawRect(cam, s.x + s.w / 2, s.y + s.h / 2, o);
	}

	/**
	 * A building's wall in the town's pixel art -- outlined as one piece with the walls it joins, the shadow at its
	 * foot -- or false when the `wall` texture has no id (then worldView draws it as before).
	 */
	drawWallArt(r: Renderer, cam: Camera, s: Solid, house: boolean): boolean {
		return this.art.wall(r, cam, s, house);
	}

	/**
	 * One piece of furniture in a building of type `bt`: its cell of the interiors' atlas when that is uploaded,
	 * else a body and a detail or two in Frames, lit from the top left like the rest of the town.
	 */
	drawFurniture(r: Renderer, cam: Camera, s: Solid, bt = 1): void {
		if (this.art.furniture(r, cam, s, bt)) return;
		const t = s.tags;
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const w = s.w;
		const h = s.h;
		const z = Z.structure;
		const face = s.face ?? "bottom";
		const fx = normalX(face);
		const fy = normalY(face);
		// the long side along x?
		const wide = w >= h;
		const k = s.variant ?? 0;
		if (t === "sofa" || t === "armchair" || t === "booth") {
			const cloth = t === "booth" ? COLORS.fabricRed : COLORS.fabric;
			r.drawRect(cam, cx, cy, edged(flat(w, h, cloth, z), BLACK, 0.5));
			// the back rest along the wall side, the seat in front of it
			const back = 14;
			r.drawRect(
				cam,
				cx - fx * ((fx !== 0 ? w : h) / 2 - back / 2),
				cy - fy * ((fy !== 0 ? h : w) / 2 - back / 2),
				flat(fx !== 0 ? back : w, fy !== 0 ? back : h, cloth.Lerp(BLACK, 0.3), z + 1),
			);
			if (t === "booth") {
				r.drawRect(
					cam,
					cx + fx * 6,
					cy + fy * 6,
					flat(fx !== 0 ? w * 0.4 : w * 0.7, fy !== 0 ? h * 0.4 : h * 0.7, COLORS.furnWood, z + 2),
				);
			}
			return;
		}
		if (t === "bed" || t === "hospbed") {
			const frame = t === "hospbed" ? COLORS.metal : COLORS.furnDark;
			r.drawRect(cam, cx, cy, edged(flat(w, h, frame, z), BLACK, 0.5));
			// the head: against the wall when the bed stands out from it, else (a bed whose side is on the wall)
			// at one end of its length
			let hx = -fx;
			let hy = -fy;
			if ((fx !== 0 && h > w) || (fy !== 0 && w > h)) {
				const headAt = k % 2 === 0 ? 1 : -1;
				hx = wide ? headAt : 0;
				hy = wide ? 0 : headAt;
			}
			// the blanket, off the head, and the pillow at the head
			const sheet = t === "hospbed" ? COLORS.bedding : k % 2 === 0 ? COLORS.fabric : COLORS.fabricRed;
			const blanket = flat(w - 8 - math.abs(hx) * 16, h - 8 - math.abs(hy) * 16, sheet, z + 1);
			r.drawRect(cam, cx - hx * 8, cy - hy * 8, blanket);
			const pillow = flat(hx !== 0 ? 16 : w - 16, hy !== 0 ? 16 : h - 16, COLORS.bedding, z + 2);
			pillow.cornerRadius = 4;
			r.drawRect(cam, cx + hx * ((w - 20) / 2), cy + hy * ((h - 20) / 2), pillow);
			return;
		}
		if (
			t === "table" ||
			t === "desk" ||
			t === "schooldesk" ||
			t === "teacherdesk" ||
			t === "nightstand" ||
			t === "bench"
		) {
			const wood = t === "teacherdesk" ? COLORS.furnDark : COLORS.furnWood;
			const o = edged(flat(w, h, wood, z), BLACK, 0.55);
			o.cornerRadius = t === "table" ? 6 : 2;
			r.drawRect(cam, cx, cy, o);
			if (t === "desk" || t === "teacherdesk") {
				r.drawRect(
					cam,
					cx + (wide ? w * 0.18 : 0),
					cy + (wide ? 0 : h * 0.18),
					flat(18, 14, COLORS.paper, z + 1),
				);
			}
			return;
		}
		if (t === "counter" || t === "checkout" || t === "reception" || t === "display" || t === "prep") {
			const top = t === "prep" ? COLORS.metal : COLORS.counterTop;
			r.drawRect(cam, cx, cy, edged(flat(w, h, top, z), BLACK, 0.5));
			if (t === "counter") {
				// the sink, at one end or the other
				const off = (k % 2 === 0 ? 1 : -1) * (wide ? w : h) * 0.28;
				r.drawRect(
					cam,
					cx + (wide ? off : 0),
					cy + (wide ? 0 : off),
					edged(flat(28, 22, COLORS.metal, z + 1), BLACK, 0.4),
				);
			} else if (t === "display") {
				r.drawRect(cam, cx, cy, flat(w - 10, h - 10, COLORS.glassCold, z + 1));
			} else if (t === "checkout" || t === "reception") {
				r.drawRect(
					cam,
					cx + (wide ? w * 0.3 : 0),
					cy + (wide ? 0 : h * 0.3),
					flat(16, 16, COLORS.metalDark, z + 1),
				);
			}
			return;
		}
		if (t === "stove" || t === "optable" || t === "safe") {
			const body = t === "optable" ? COLORS.metal : COLORS.metalDark;
			r.drawRect(cam, cx, cy, edged(flat(w, h, body, z), BLACK, 0.6));
			const d = math.min(w, h) * 0.45;
			const dot = flat(d, d, t === "optable" ? COLORS.bedding : BLACK, z + 1);
			dot.circle = t !== "optable";
			r.drawRect(cam, cx, cy, dot);
			return;
		}
		if (t === "fridge" || t === "toilet" || t === "basin" || t === "tub") {
			const o = edged(flat(w, h, COLORS.porcelain, z), BLACK, 0.45);
			o.cornerRadius = t === "fridge" ? 3 : 8;
			r.drawRect(cam, cx, cy, o);
			if (t === "tub" || t === "basin" || t === "toilet") {
				const inner = flat(w - 12, h - 12, COLORS.floorBath.Lerp(COLORS.glassCold, 0.5), z + 1);
				inner.cornerRadius = 6;
				r.drawRect(cam, cx + fx * 3, cy + fy * 3, inner);
			} else {
				// the handle on the front
				r.drawRect(
					cam,
					cx + fx * (w / 2 - 5),
					cy + fy * (h / 2 - 5),
					flat(fx !== 0 ? 3 : w * 0.5, fy !== 0 ? 3 : h * 0.5, COLORS.metal, z + 1),
				);
			}
			return;
		}
		if (t === "tv" || t === "wardrobe" || t === "bookcase" || t === "cabinet" || t === "lockers") {
			const body =
				t === "tv" ? COLORS.metalDark : t === "lockers" || t === "cabinet" ? COLORS.metal : COLORS.furnWood;
			r.drawRect(cam, cx, cy, edged(flat(w, h, body, z), BLACK, 0.6));
			if (t === "tv") {
				r.drawRect(cam, cx, cy, flat(wide ? w * 0.7 : 6, wide ? 6 : h * 0.7, GLASS_DARK, z + 1));
			} else if (t === "bookcase") {
				r.drawRect(
					cam,
					cx,
					cy,
					flat(
						wide ? w - 10 : h * 0.5,
						wide ? h * 0.5 : h - 10,
						COLORS.goodsA.Lerp(COLORS.goodsB, (k % 3) / 3),
						z + 1,
					),
				);
			} else {
				// the doors' seams (a wardrobe's two leaves, a locker row's doors)
				r.drawRect(cam, cx, cy, flat(wide ? 2 : w - 6, wide ? h - 6 : 2, body.Lerp(BLACK, 0.4), z + 1));
			}
			return;
		}
		if (
			t === "shelf" ||
			t === "gondola" ||
			t === "rack" ||
			t === "coldcase" ||
			t === "gunrack" ||
			t === "clothesrack"
		) {
			const frame = t === "gunrack" ? COLORS.furnDark : t === "clothesrack" ? COLORS.metalDark : COLORS.metal;
			r.drawRect(cam, cx, cy, edged(flat(w, h, frame, z), BLACK, 0.6));
			let goods = COLORS.goodsA.Lerp(COLORS.goodsC, (k % 4) / 4);
			if (t === "coldcase") goods = COLORS.glassCold;
			else if (t === "rack") goods = COLORS.furnWood.Lerp(COLORS.goodsC, 0.3);
			else if (t === "gunrack") goods = COLORS.metalDark;
			else if (t === "clothesrack") goods = k % 2 === 0 ? COLORS.fabric : COLORS.fabricRed;
			// two bands of goods on a gondola (both faces), one on a wall shelf
			const band = t === "gondola" ? 2 : 1;
			for (let q = 0; q < band; q++) {
				const off = band === 2 ? (q === 0 ? -1 : 1) * (wide ? h : w) * 0.22 : 0;
				r.drawRect(
					cam,
					cx + (wide ? 0 : off),
					cy + (wide ? off : 0),
					flat(wide ? w - 8 : (w - 8) / band, wide ? (h - 8) / band : h - 8, goods, z + 1),
				);
			}
			return;
		}
		if (this.drawCampusPiece(r, cam, s, cx, cy, w, h, fx, fy, wide, k)) return;
		if (t === "foldchairs") {
			// the town hall's folding chairs (EDI-19): rows of steel seats (a row every 32 u of depth), a chair's width
			// apart along each row
			const along = wide;
			const len = along ? w : h;
			const depth = along ? h : w;
			const n = math.max(2, math.floor(len / 30));
			const rows = math.max(1, math.floor(depth / 32));
			const pitch = len / n;
			const band = depth / rows;
			for (let q = 0; q < rows; q++) {
				const off = -depth / 2 + band * (q + 0.5);
				for (let i = 0; i < n; i++) {
					const at = -len / 2 + pitch * (i + 0.5);
					const seat = flat(along ? pitch - 8 : band - 8, along ? band - 8 : pitch - 8, COLORS.metal, z);
					r.drawRect(cam, cx + (along ? at : off), cy + (along ? off : at), edged(seat, BLACK, 0.55));
				}
			}
			return;
		}
		r.drawRect(cam, cx, cy, edged(flat(w, h, COLORS.furnWood, z), BLACK, 0.6));
	}

	/**
	 * The campus's furniture (EDI-17), in the same palette and light as the rest: tiered seats, a lectern, lab
	 * benches with their black epoxy tops, a fume hood behind its glass sash, the reagents' shelves, bunk beds with
	 * their ladder, a vending machine. Answers false for anything else.
	 */
	private drawCampusPiece(
		r: Renderer,
		cam: Camera,
		s: Solid,
		cx: number,
		cy: number,
		w: number,
		h: number,
		fx: number,
		fy: number,
		wide: boolean,
		k: number,
	): boolean {
		const t = s.tags;
		const z = Z.structure;
		if (t === "seats") {
			// tiers of seats rising away from the lectern: a row of seats per tier, darker (higher) towards the wall
			r.drawRect(cam, cx, cy, edged(flat(w, h, COLORS.furnDark, z), BLACK, 0.55));
			const across = fy !== 0;
			const depth = across ? h : w;
			const len = across ? w : h;
			const tiers = math.max(2, math.floor(depth / 32));
			const step = depth / tiers;
			const n = math.max(3, math.floor((len - 8) / 22));
			const pitch = (len - 8) / n;
			for (let q = 0; q < tiers; q++) {
				// from the front (the face side) back to the wall
				const off = depth / 2 - step * (q + 0.5);
				const seat = COLORS.fabric.Lerp(BLACK, q * 0.14);
				for (let i = 0; i < n; i++) {
					const along = -(len - 8) / 2 + pitch * (i + 0.5);
					const sx = across ? along : fx * off;
					const sy = across ? fy * off : along;
					const o = flat(across ? pitch - 4 : step - 8, across ? step - 8 : pitch - 4, seat, z + 1);
					o.cornerRadius = 3;
					r.drawRect(cam, cx + sx, cy + sy, o);
				}
			}
			return true;
		}
		if (t === "lectern") {
			r.drawRect(cam, cx, cy, edged(flat(w, h, COLORS.furnWood, z), BLACK, 0.55));
			r.drawRect(cam, cx - fx * 4, cy - fy * 4, flat(w * 0.55, h * 0.45, COLORS.paper, z + 1));
			return true;
		}
		if (t === "labbench") {
			const top = COLORS.metalDark.Lerp(BLACK, 0.35);
			r.drawRect(cam, cx, cy, edged(flat(w, h, top, z), BLACK, 0.6));
			// the sink at one end, a flask and a beaker on the other
			const tip = (k % 2 === 0 ? 1 : -1) * (wide ? w : h) * 0.3;
			r.drawRect(cam, cx + (wide ? tip : 0), cy + (wide ? 0 : tip), flat(18, 18, COLORS.metal, z + 1));
			const glass = flat(8, 8, COLORS.glassCold, z + 1);
			glass.circle = true;
			r.drawRect(cam, cx - (wide ? tip : 0), cy - (wide ? 0 : tip), glass);
			return true;
		}
		if (t === "fumehood") {
			r.drawRect(cam, cx, cy, edged(flat(w, h, COLORS.metal, z), BLACK, 0.6));
			// the glass sash on its front, the dark cabinet behind it
			const sash = flat(fx !== 0 ? 8 : w - 12, fy !== 0 ? 8 : h - 12, COLORS.glassCold, z + 1);
			r.drawRect(cam, cx + fx * ((fx !== 0 ? w : h) / 2 - 6), cy + fy * ((fy !== 0 ? h : w) / 2 - 6), sash);
			r.drawRect(cam, cx - fx * 4, cy - fy * 4, flat(w * 0.5, h * 0.4, COLORS.metalDark, z + 1));
			return true;
		}
		if (t === "chemshelf") {
			r.drawRect(cam, cx, cy, edged(flat(w, h, COLORS.metal, z), BLACK, 0.6));
			// rows of bottles: brown, green, blue
			const n = math.max(2, math.floor((wide ? w : h) / 22));
			for (let q = 0; q < n; q++) {
				const along = -((wide ? w : h) / 2) + ((wide ? w : h) / n) * (q + 0.5);
				const b = flat(10, 10, BOTTLES[(q + k) % 3], z + 1);
				b.circle = true;
				r.drawRect(cam, cx + (wide ? along : 0), cy + (wide ? 0 : along), b);
			}
			return true;
		}
		if (t === "bunk") {
			// from above, the top bunk: the frame, the blanket, the pillow at the head, the ladder down one side
			r.drawRect(cam, cx, cy, edged(flat(w, h, COLORS.furnDark, z), BLACK, 0.55));
			const headAt = k % 2 === 0 ? 1 : -1;
			const hx = wide ? headAt : 0;
			const hy = wide ? 0 : headAt;
			r.drawRect(
				cam,
				cx - hx * 8,
				cy - hy * 8,
				flat(w - 8 - math.abs(hx) * 16, h - 8 - math.abs(hy) * 16, COLORS.fabric, z + 1),
			);
			const pillow = flat(hx !== 0 ? 16 : w - 16, hy !== 0 ? 16 : h - 16, COLORS.bedding, z + 2);
			pillow.cornerRadius = 4;
			r.drawRect(cam, cx + hx * ((w - 20) / 2), cy + hy * ((h - 20) / 2), pillow);
			// the ladder: two rails and a rung on the long side facing into the room
			const lx = fx !== 0 ? fx * (w / 2 - 3) : 0;
			const ly = fy !== 0 ? fy * (h / 2 - 3) : 0;
			r.drawRect(
				cam,
				cx + lx,
				cy + ly,
				flat(fx !== 0 ? 4 : w * 0.3, fy !== 0 ? 4 : h * 0.3, COLORS.furnWood, z + 3),
			);
			return true;
		}
		if (t === "vending") {
			r.drawRect(cam, cx, cy, edged(flat(w, h, COLORS.fabricRed, z), BLACK, 0.6));
			// the glass front with the snacks behind it, on the side facing the room
			const gx = fx * ((fx !== 0 ? w : h) / 2 - 7);
			const gy = fy * ((fy !== 0 ? h : w) / 2 - 7);
			r.drawRect(
				cam,
				cx + gx,
				cy + gy,
				flat(fx !== 0 ? 10 : w - 12, fy !== 0 ? 10 : h - 12, COLORS.glassCold, z + 1),
			);
			r.drawRect(
				cam,
				cx - fx * 6,
				cy - fy * 6,
				flat(fx !== 0 ? 8 : w * 0.5, fy !== 0 ? 8 : h * 0.5, COLORS.goodsC, z + 1),
			);
			return true;
		}
		return false;
	}

	// ------------------------------------------------------------------ the record: decoration, openings, marks

	/** rugs, mats, chairs, papers, the classroom's board, the wards' curtains, dried blood and broken glass */
	drawDecor(r: Renderer, cam: Camera, b: Solid, v: ViewRect): void {
		const list = b.decor;
		if (list === undefined) return;
		for (const d of list) {
			if (!overlaps(d.x, d.y, d.w, d.h, v)) continue;
			if (!this.art.decor(r, cam, b, d)) this.drawOneDecor(r, cam, d);
		}
	}

	private drawOneDecor(r: Renderer, cam: Camera, d: Decor): void {
		const cx = d.x + d.w / 2;
		const cy = d.y + d.h / 2;
		const k = d.kind;
		if (k === "rug") {
			const o = edged(flat(d.w, d.h, COLORS.rug, Z.floorDetail), RUG_BORDER, 0.9, 3);
			o.alpha = 0.92;
			r.drawRect(cam, cx, cy, o);
		} else if (k === "mat") {
			const o = flat(d.w, d.h, COLORS.glassCold.Lerp(COLORS.porcelain, 0.4), Z.floorDetail);
			o.cornerRadius = 8;
			r.drawRect(cam, cx, cy, o);
		} else if (k === "board") {
			r.drawRect(cam, cx, cy, edged(flat(d.w, d.h, COLORS.chalkboard, Z.floorDetail), COLORS.furnWood, 1, 2));
		} else if (k === "notice") {
			// a cork board on the wall with the last flyers pinned to it (the campus's halls, EDI-17)
			r.drawRect(cam, cx, cy, edged(flat(d.w, d.h, CORK, Z.floorDetail), COLORS.furnWood, 1, 1));
			const along = d.w >= d.h;
			for (let q = 0; q < 3; q++) {
				const off = (q - 1) * (along ? d.w : d.h) * 0.3;
				r.drawRect(
					cam,
					cx + (along ? off : 0),
					cy + (along ? 0 : off),
					flat(8, 8, COLORS.paper, Z.floorDetail + 1),
				);
			}
		} else if (k === "curtain") {
			const o = flat(d.w, d.h, COLORS.curtain, Z.floorDetail);
			o.alpha = 0.85;
			r.drawRect(cam, cx, cy, o);
		} else if (k === "blood") {
			const o = flat(d.w, d.h * 0.8, BLOOD_DRY, Z.decal);
			o.cornerRadius = d.h * 0.4;
			o.rotation = d.rot;
			o.alpha = 0.8;
			r.drawRect(cam, cx, cy, o);
		} else if (k === "papers") {
			for (let q = 0; q < 3; q++) {
				const o = flat(14, 18, COLORS.paper, Z.decal);
				o.rotation = d.rot + q * 0.7;
				r.drawRect(cam, cx + (q - 1) * 10, cy + ((q * 7) % 11) - 5, o);
			}
		} else if (k === "glass") {
			for (let q = 0; q < 3; q++) {
				const o = flat(8, 5, COLORS.glassCold, Z.decal);
				o.rotation = q * 1.1;
				o.alpha = 0.9;
				const along = d.w >= d.h;
				r.drawRect(cam, cx + (along ? (q - 1) * 16 : 0), cy + (along ? 0 : (q - 1) * 16), o);
			}
		} else if (k === "chair" || k === "chairDown") {
			const o = edged(flat(22, 22, COLORS.furnWood, Z.decal), BLACK, 0.5);
			o.rotation = d.rot;
			o.cornerRadius = 3;
			r.drawRect(cam, cx, cy, o);
			if (k === "chair") r.drawRect(cam, cx, cy - 8, flat(22, 6, COLORS.furnDark, Z.decal + 1));
		}
	}

	/**
	 * The frames of the building's openings, seen from inside: a threshold under a doorway, a window with its glass in
	 * or broken (EDI-18) and, under a broken one, the glass on the floor. Each is the interiors' atlas cell when that is
	 * uploaded (client/view/interiorArt.ts: the pane or the empty frame, and the shards) and these Frames otherwise; an
	 * outside door is first its entrance's frame and the leaves pinned inside (ART-17, ./entranceArt.ts).
	 */
	drawOpenings(r: Renderer, cam: Camera, b: Solid, v: ViewRect): void {
		const list = b.openings;
		if (list === undefined) return;
		for (const o of list) {
			// a window's shards lie up to ~40 u off its sill, a door's leaves pinned inside (with the entrances' art) ~60 u
			// along its wall: the frame is culled with them
			const m = o.kind === "window" ? 40 : o.kind === "door" && this.entrances.live() !== undefined ? 64 : 8;
			if (!overlaps(o.x - m, o.y - m, o.w + 2 * m, o.h + 2 * m, v)) continue;
			this.drawOpening(r, cam, b, o);
		}
	}

	private drawOpening(r: Renderer, cam: Camera, b: Solid, o: Opening): void {
		const cx = o.x + o.w / 2;
		const cy = o.y + o.h / 2;
		const along = o.w >= o.h;
		if (o.kind !== "window") {
			if (o.kind === "door" && this.entrances.doorway(r, cam, b, o)) return;
			if (this.art.opening(r, cam, o)) return;
			// a threshold strip across a doorway
			const t = o.kind === "door" ? COLORS.furnDark : COLORS.furnWood;
			const s = flat(along ? o.w : 6, along ? 6 : o.h, t, Z.floorDetail);
			s.alpha = 0.8;
			r.drawRect(cam, cx, cy, s);
			return;
		}
		const intact = paneIntact(o);
		// the glass on the floor inside a broken one (outside it is drawn with the roof on too: `drawWindowShards`)
		if (!intact) this.drawShards(r, cam, o, -1);
		// the atlas: the frame and the whole pane with its reflection, or the frame and what is left of the glass
		if (this.art.opening(r, cam, o, intact)) return;
		// a window: the frame on both faces of the wall, the sill between them, and the glass -- the pane with a streak of
		// light on it, or what is left of it
		const len = along ? o.w : o.h;
		const thick = along ? o.h : o.w;
		for (const sgn of SIDES) {
			const off = sgn * (thick / 2 - 2);
			r.drawRect(
				cam,
				cx + (along ? 0 : off),
				cy + (along ? off : 0),
				flat(along ? len : 4, along ? 4 : len, COLORS.windowFrame, Z.structure + 1),
			);
		}
		const sill = flat(along ? len - 4 : thick - 8, along ? thick - 8 : len - 4, COLORS.glassCold, Z.structure);
		sill.alpha = intact ? PANE_ALPHA : 0.35;
		r.drawRect(cam, cx, cy, sill);
		if (intact) {
			// the reflection: a short streak of light across the pane, a third of the way along (light from the top left)
			const glint = flat(along ? len * 0.22 : 3, along ? 3 : len * 0.22, GLINT, Z.structure + 2);
			glint.alpha = 0.75;
			r.drawRect(cam, cx - (along ? len * 0.2 : 0), cy - (along ? 0 : len * 0.2), glint);
			return;
		}
		const shard = flat(10, 6, COLORS.glassCold, Z.structure + 2);
		shard.rotation = 0.6;
		r.drawRect(cam, cx + (along ? -len / 2 + 7 : 0), cy + (along ? 0 : -len / 2 + 7), shard);
	}

	/**
	 * The glass on the ground OUTSIDE every broken window of the building (EDI-18): drawn with the roof on too -- it lies
	 * in the street, and it is how a survivor reads from outside which windows are open frames. A decal (COL-02, ART-04):
	 * a few pale shards, never white, nothing that reads as loot.
	 */
	drawWindowShards(r: Renderer, cam: Camera, b: Solid, v: ViewRect): void {
		const list = b.openings;
		if (list === undefined) return;
		for (const o of list) {
			if (o.kind !== "window" || paneIntact(o)) continue;
			if (!overlaps(o.x - 48, o.y - 48, o.w + 96, o.h + 96, v)) continue;
			this.drawShards(r, cam, o, 1);
		}
	}

	/** the shards of window `o` on the ground outside it (`sgn` 1) or on the floor inside (-1) */
	private drawShards(r: Renderer, cam: Camera, o: Opening, sgn: number): void {
		const along = o.w >= o.h;
		const off = sgn * ((along ? o.h : o.w) / 2 + SHARD_OFF);
		const cx = o.x + o.w / 2 + normalX(o.side) * off;
		const cy = o.y + o.h / 2 + normalY(o.side) * off;
		// the atlas's broken-glass cell (the decoration the plan used to scatter under a window)
		if (this.art.shards(r, cam, o, sgn, cx, cy, Z_SHARDS)) return;
		// flat: three chips along the sill, the broken-glass decal of the plan's old drawing
		for (let q = 0; q < 3; q++) {
			const s = flat(8, 5, COLORS.glassCold, Z_SHARDS);
			s.rotation = q * 1.1 + (sgn > 0 ? 0.4 : 0);
			s.alpha = 0.9;
			r.drawRect(cam, cx + (along ? (q - 1) * 16 : 0), cy + (along ? 0 : (q - 1) * 16), s);
		}
	}

	/**
	 * The entrance outside every door of the building, read with the roof on (ART-17): its pixel art where the
	 * entrances' atlas has an id (./entranceArt.ts: the stoop, the leaves pinned outside...), else flat -- the thing
	 * on the ground (a step, a mat, a ramp, the steps, a bay's hazard paint) and the one detail that says which entrance
	 * it is (the coir mat, the aluminium nosing, the yellow warning strip...): two Frames at most (ART-16's budget).
	 */
	drawEntrances(r: Renderer, cam: Camera, b: Solid, v: ViewRect): void {
		const list = b.openings;
		if (list === undefined) return;
		const bt = b.buildingType ?? 1;
		for (const o of list) {
			if (o.kind !== "door") continue;
			if (this.entrances.outside(r, cam, b, o, v)) continue;
			const nx = normalX(o.side);
			const ny = normalY(o.side);
			const cx = o.x + o.w / 2 + nx * (TOWN.WALL_T / 2);
			const cy = o.y + o.h / 2 + ny * (TOWN.WALL_T / 2);
			if (!overlaps(cx - 100, cy - 100, 200, 200, v)) continue;
			const style = entranceStyle(bt, o.main);
			this.drawFlatEntrance(r, cam, o, style.base, Z.floorDetail, nx, ny);
			if (style.detail !== undefined) this.drawFlatEntrance(r, cam, o, style.detail, Z.floorDetail + 1, nx, ny);
		}
	}

	/** one flat rect of an entrance (./entrances.ts FlatRect), outside doorway `o` whose wall faces (nx, ny) */
	private drawFlatEntrance(
		r: Renderer,
		cam: Camera,
		o: Opening,
		f: FlatRect,
		z: number,
		nx: number,
		ny: number,
	): void {
		const across = nx !== 0;
		const len = (across ? o.h : o.w) + f.along;
		const off = TOWN.WALL_T / 2 + f.off;
		const at = f.at ?? 0;
		const s = flat(across ? f.depth : len, across ? len : f.depth, f.color, z);
		if (f.radius !== undefined) s.cornerRadius = f.radius;
		if (f.edge === true) edged(s, BLACK, 0.22);
		r.drawRect(cam, o.x + o.w / 2 + nx * off + (across ? 0 : at), o.y + o.h / 2 + ny * off + (across ? at : 0), s);
	}

	/**
	 * On the roof's edge, over every door and window: a darker eave over a doorway and a strip of dark glass over a
	 * window, so from the street a survivor sees where the building can be entered -- and where the horde will
	 * climb in -- without the roof lifting (EDI-10). A BROKEN window (EDI-18) is the dark room through the empty frame,
	 * with what is left of the glass at its two ends (and its shards on the ground below, `drawWindowShards`); an intact
	 * one is the glass it always was, and with the town's art (`glint`) a streak of light on it.
	 */
	drawRoofMarks(r: Renderer, cam: Camera, b: Solid, a: number, eave: Color3, v: ViewRect, glint = false): void {
		const list = b.openings;
		if (list === undefined) return;
		const bt = b.buildingType ?? 1;
		for (const o of list) {
			// only the marks in view: a big building half on screen has dozens of openings off it
			if (o.kind === "inner" || !overlaps(o.x - 16, o.y - 16, o.w + 32, o.h + 32, v)) continue;
			const door = o.kind === "door";
			// a door's lintel in the entrances' art (ART-17): the house's hood, the shop's header, the bay's hood...
			if (door && this.entrances.lintel(r, cam, b, o, a)) continue;
			const nx = normalX(o.side);
			const ny = normalY(o.side);
			const across = nx !== 0;
			const depth = door ? 12 : 8;
			const intact = door || paneIntact(o);
			// on the outer edge of the wall, inside the roof
			const edge = (across ? o.w : o.h) / 2 - depth / 2;
			const cx = o.x + o.w / 2 + nx * edge;
			const cy = o.y + o.h / 2 + ny * edge;
			const s = flat(
				across ? depth : o.w,
				across ? o.h : depth,
				door ? (entranceStyle(bt, o.main).eave ?? eave) : intact ? GLASS_DARK : HOLE_DARK,
				Z.roof + 2,
			);
			s.alpha = a;
			r.drawRect(cam, cx, cy, s);
			if (door) continue;
			const len = across ? o.h : o.w;
			if (intact) {
				if (!glint) continue;
				// the reflection: a short streak of light a third of the way along the glass
				const g = flat(across ? 2 : len * 0.22, across ? len * 0.22 : 2, GLINT, Z.roof + 3);
				g.alpha = a * 0.7;
				r.drawRect(cam, cx - (across ? 0 : len * 0.2), cy - (across ? len * 0.2 : 0), g);
				continue;
			}
			// the stubs of glass left in the frame, one at each end
			for (const sgn of SIDES) {
				const stub = flat(across ? depth - 2 : 10, across ? 10 : depth - 2, COLORS.glassCold, Z.roof + 3);
				stub.alpha = a;
				r.drawRect(cam, cx + (across ? 0 : sgn * (len / 2 - 6)), cy + (across ? sgn * (len / 2 - 6) : 0), stub);
			}
		}
	}
}
