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
import { overlaps, SIDES } from "./drawKit";
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
const MAT = COLORS.doormat;
const RUG_BORDER = COLORS.rug.Lerp(COLORS.goodsC, 0.35);

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

	/** the world the frame's interiors are drawn in (worldView, once per frame): the art's plans are per world */
	useWorld(world: WorldData): void {
		this.art.useWorld(world);
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
		r.drawRect(cam, cx, cy, edged(flat(w, h, COLORS.furnWood, z), BLACK, 0.6));
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

	/** the frames of the building's openings, seen from inside: a threshold under a doorway, a broken window */
	drawOpenings(r: Renderer, cam: Camera, b: Solid, v: ViewRect): void {
		const list = b.openings;
		if (list === undefined) return;
		for (const o of list) {
			if (!overlaps(o.x - 8, o.y - 8, o.w + 16, o.h + 16, v)) continue;
			if (!this.art.opening(r, cam, o)) this.drawOpening(r, cam, o);
		}
	}

	private drawOpening(r: Renderer, cam: Camera, o: Opening): void {
		const cx = o.x + o.w / 2;
		const cy = o.y + o.h / 2;
		const along = o.w >= o.h;
		if (o.kind !== "window") {
			// a threshold strip across a doorway
			const t = o.kind === "door" ? COLORS.furnDark : COLORS.furnWood;
			const s = flat(along ? o.w : 6, along ? 6 : o.h, t, Z.floorDetail);
			s.alpha = 0.8;
			r.drawRect(cam, cx, cy, s);
			return;
		}
		// a window: the frame on both faces of the wall, the sill between them, what is left of the glass
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
		sill.alpha = 0.35;
		r.drawRect(cam, cx, cy, sill);
		const shard = flat(10, 6, COLORS.glassCold, Z.structure + 2);
		shard.rotation = 0.6;
		r.drawRect(cam, cx + (along ? -len / 2 + 7 : 0), cy + (along ? 0 : -len / 2 + 7), shard);
	}

	/** a doormat outside every door of the building: the entrances read with the roof on */
	drawDoormats(r: Renderer, cam: Camera, b: Solid, v: ViewRect, step: Color3 | undefined): void {
		const list = b.openings;
		if (list === undefined) return;
		const off = TOWN.WALL_T / 2 + 14;
		for (const o of list) {
			if (o.kind !== "door") continue;
			const nx = normalX(o.side);
			const ny = normalY(o.side);
			const cx = o.x + o.w / 2 + nx * off;
			const cy = o.y + o.h / 2 + ny * off;
			if (!overlaps(cx - 80, cy - 80, 160, 160, v)) continue;
			const across = nx !== 0;
			if (step !== undefined) {
				const so = edged(
					flat(across ? 20 : o.w + 20, across ? o.h + 20 : 20, step, Z.floorDetail),
					BLACK,
					0.22,
				);
				r.drawRect(cam, cx - nx * 4, cy - ny * 4, so);
			}
			const m = flat(across ? 22 : o.w - 24, across ? o.h - 24 : 22, MAT, Z.floorDetail + 1);
			m.cornerRadius = 3;
			r.drawRect(cam, cx, cy, m);
		}
	}

	/**
	 * On the roof's edge, over every door and window: a darker eave over a doorway and a strip of dark glass over a
	 * window, so from the street a survivor sees where the building can be entered -- and where the horde will
	 * climb in -- without the roof lifting (EDI-10).
	 */
	drawRoofMarks(r: Renderer, cam: Camera, b: Solid, a: number, eave: Color3, v: ViewRect): void {
		const list = b.openings;
		if (list === undefined) return;
		for (const o of list) {
			// only the marks in view: a big building half on screen has dozens of openings off it
			if (o.kind === "inner" || !overlaps(o.x - 16, o.y - 16, o.w + 32, o.h + 32, v)) continue;
			const nx = normalX(o.side);
			const ny = normalY(o.side);
			const across = nx !== 0;
			const door = o.kind === "door";
			const depth = door ? 12 : 8;
			// on the outer edge of the wall, inside the roof
			const edge = (across ? o.w : o.h) / 2 - depth / 2;
			const cx = o.x + o.w / 2 + nx * edge;
			const cy = o.y + o.h / 2 + ny * edge;
			const s = flat(across ? depth : o.w, across ? o.h : depth, door ? eave : GLASS_DARK, Z.roof + 2);
			s.alpha = a;
			r.drawRect(cam, cx, cy, s);
		}
	}
}
