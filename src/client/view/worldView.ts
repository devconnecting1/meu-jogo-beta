/*
 * The town on screen: ground, roads, crosswalks, buildings (floor, roof, rooftop emblem), walls, the map border,
 * trees, cars, pump islands, bins and the structures players build -- everything that stands still in the world.
 *
 * This is the drawing half of what `gameLoop.ts` drew until now, moved here verbatim (docs/MULTIPLAYER.md §11.3:
 * "desenho em gameLoop.ts -> client/view/{worldView,actorsView,fxView}.ts"), with the loop's private helpers
 * replaced by `drawKit` and the two things it read off the loop handed in: where a shadow falls (`shadow`, LUZ-01)
 * and the animation clock (`clock`: a struck tree's shake, a lamp's flicker).
 *
 * Two owners draw through it, each with its own Renderer and Camera: the run (`GameLoop.render`) and the menus'
 * town flyover (client/view/townFlyover.ts, DESIGN_RULES UI-10), so the town behind the lobby is the very town the
 * survivor walks into -- the same roofs, emblems and cars, never a picture of it.
 *
 * It holds no world state of its own: the WorldData is passed in on every call.
 */
import { COLORS, Z } from "shared/engine/colors";
import { Camera, ViewRect } from "shared/engine/camera";
import { TOWN } from "shared/engine/constants";
import { Renderer, SpriteOpts } from "shared/engine/renderer";
import { clamp } from "shared/engine/vec2";
import { GroundRect, querySolids, Road, Solid, WorldData } from "shared/game/world";
import { circleInView, overlaps, part, SIDES } from "./drawKit";

const WHITE = COLORS.white;
const BLACK = COLORS.shadow;
/** street furniture / ground palette, derived from the base colours */
const GROUND = {
	plaza: COLORS.sidewalk.Lerp(WHITE, 0.1),
	verge: COLORS.grass.Lerp(COLORS.grassLight, 0.4),
	pit: COLORS.treeTrunk.Lerp(BLACK, 0.3),
	walk: COLORS.sidewalk.Lerp(WHITE, 0.16),
	drive: COLORS.sidewalk.Lerp(BLACK, 0.08),
	apron: COLORS.sidewalk.Lerp(COLORS.road, 0.3),
	parking: COLORS.road.Lerp(COLORS.sidewalk, 0.14),
	stall: WHITE.Lerp(COLORS.road, 0.25),
	playground: COLORS.dirtPath.Lerp(WHITE, 0.25),
	ramp: COLORS.uiYellow.Lerp(COLORS.sidewalk, 0.35),
	zebra: WHITE.Lerp(COLORS.road, 0.12),
	lane: WHITE.Lerp(COLORS.road, 0.3),
	island: COLORS.sidewalk.Lerp(WHITE, 0.2),
};

/** road markings: dash period/length, crosswalk stripe width/period */
const DASH_PERIOD = 160;
const DASH_LEN = 64;
const ZEBRA_W = 24;
const ZEBRA_STEP = 48;

/** outward unit normal of a building wall */
function sideNormal(side: string | undefined): { x: number; y: number } {
	if (side === "top") return { x: 0, y: -1 };
	if (side === "left") return { x: -1, y: 0 };
	if (side === "right") return { x: 1, y: 0 };
	return { x: 0, y: 1 };
}

/** axis-aligned square rect clipped to the view (huge roads / lots never become huge Frames) */
function drawClipped(
	r: Renderer,
	cam: Camera,
	x: number,
	y: number,
	w: number,
	h: number,
	v: ViewRect,
	opts: SpriteOpts,
): void {
	const x0 = math.max(x, v.minX);
	const y0 = math.max(y, v.minY);
	const x1 = math.min(x + w, v.maxX);
	const y1 = math.min(y + h, v.maxY);
	if (x1 <= x0 || y1 <= y0) return;
	opts.w = x1 - x0;
	opts.h = y1 - y0;
	r.drawRect(cam, (x0 + x1) / 2, (y0 + y1) / 2, opts);
}

/** where the shadow of something at (x, y) falls, for a shadow `len` long (LUZ-01) */
export type ShadowFn = (x: number, y: number, len: number) => { x: number; y: number };

export class WorldView {
	/** the owner's animation clock (seconds): a struck solid's shake, a lamp's flicker */
	clock = 0;
	private readonly queryBuf: Array<Solid> = [];
	private readonly shadow: ShadowFn;

	constructor(shadow: ShadowFn) {
		this.shadow = shadow;
	}

	// ------------------------------------------------------------------ ground

	/**
	 * Ground: lots (sidewalk band, yard: grass or downtown paving, verges, tree pits, footpaths,
	 * driveways, forecourts, parking lots), then roads (asphalt, curbs, medians, lane marks, zebras).
	 * Nothing here collides; everything is clipped to the view.
	 */
	drawGround(r: Renderer, cam: Camera, v: ViewRect, world: WorldData): void {
		const w = world;
		for (const lot of w.lots) {
			if (!overlaps(lot.x, lot.y, lot.w, lot.h, v)) continue;
			const y = lot.yard;
			if (y.x !== lot.x || y.y !== lot.y || y.w !== lot.w || y.h !== lot.h) {
				drawClipped(r, cam, lot.x, lot.y, lot.w, lot.h, v, {
					color: COLORS.sidewalk,
					zIndex: Z.ground,
				});
			}
			const paved = lot.zone === "commercial";
			drawClipped(r, cam, y.x, y.y, y.w, y.h, v, {
				color: paved ? GROUND.plaza : lot.kind === "park" ? COLORS.parkGrass : COLORS.grass,
				zIndex: Z.ground + 1,
			});
			for (const p of lot.patches) {
				if (!overlaps(p.x, p.y, p.w, p.h, v)) continue;
				// lighter, low-contrast tufts: a dark rounded blob here reads as the shadow of nothing
				r.drawRect(cam, p.x + p.w / 2, p.y + p.h / 2, {
					w: p.w,
					h: p.h,
					color: COLORS.grassLight,
					alpha: 0.3,
					cornerRadius: math.min(p.w, p.h) / 2,
					zIndex: Z.ground + 2,
				});
			}
			for (const p of lot.paths) {
				drawClipped(r, cam, p.x, p.y, p.w, p.h, v, {
					color: COLORS.dirtPath,
					alpha: 0.85,
					zIndex: Z.ground + 2,
				});
			}
			for (const gr of lot.ground) {
				if (overlaps(gr.x, gr.y, gr.w, gr.h, v)) this.drawGroundRect(r, cam, gr, v);
			}
		}
		for (const road of w.roads) {
			if (overlaps(road.x, road.y, road.w, road.h, v)) this.drawRoad(r, cam, road, v, world);
		}
		for (const c of w.crossings) {
			if (!overlaps(c.x, c.y, c.w, c.h, v)) continue;
			// zebra: bars along the traffic, laid out across the road
			const across = c.vertical ? c.w : c.h;
			const n = math.floor((across - 16) / ZEBRA_STEP);
			const first = (across - (n - 1) * ZEBRA_STEP) / 2;
			for (let i = 0; i < n; i++) {
				const t = first + i * ZEBRA_STEP;
				r.drawRect(cam, c.vertical ? c.x + t : c.x + c.w / 2, c.vertical ? c.y + c.h / 2 : c.y + t, {
					w: c.vertical ? ZEBRA_W : c.w,
					h: c.vertical ? c.h : ZEBRA_W,
					color: GROUND.zebra,
					alpha: 0.9,
					zIndex: Z.roadLine,
				});
			}
		}
	}

	private drawGroundRect(r: Renderer, cam: Camera, g: GroundRect, v: ViewRect): void {
		const k = g.kind;
		if (k === "stall") {
			r.drawRect(cam, g.x + g.w / 2, g.y + g.h / 2, {
				w: g.w,
				h: g.h,
				color: GROUND.stall,
				zIndex: Z.ground + 3,
			});
			return;
		}
		if (k === "pit") {
			r.drawRect(cam, g.x + g.w / 2, g.y + g.h / 2, {
				w: g.w,
				h: g.h,
				color: GROUND.pit,
				cornerRadius: 6,
				stroke: COLORS.curb,
				strokeThickness: 1,
				zIndex: Z.ground + 2,
			});
			return;
		}
		let color = GROUND.ramp;
		if (k === "verge") color = GROUND.verge;
		else if (k === "walk") color = GROUND.walk;
		else if (k === "drive") color = GROUND.drive;
		else if (k === "apron") color = GROUND.apron;
		else if (k === "parking") color = GROUND.parking;
		else if (k === "playground") color = GROUND.playground;
		drawClipped(r, cam, g.x, g.y, g.w, g.h, v, { color, zIndex: Z.ground + 2 });
	}

	/**
	 * Stretches of a road between its intersections that touch the view (along its axis), unclipped;
	 * ja / jb: that end is an intersection (not the road's end at the map border).
	 */
	private roadStretches(
		road: Road,
		v: ViewRect,
		world: WorldData,
	): Array<{ a: number; b: number; ja: boolean; jb: boolean }> {
		const vertical = road.vertical;
		const lo = vertical ? v.minY : v.minX;
		const hi = vertical ? v.maxY : v.maxX;
		let start = vertical ? road.y : road.x;
		let startJ = false;
		let stop = vertical ? road.y + road.h : road.x + road.w;
		let stopJ = false;
		const cuts: Array<{ a: number; b: number }> = [];
		for (const j of world.junctions) {
			if (vertical ? j.x !== road.x : j.y !== road.y) continue;
			const a = vertical ? j.y : j.x;
			const b = a + (vertical ? j.h : j.w);
			if (b <= lo) {
				if (b > start) {
					start = b;
					startJ = true;
				}
			} else if (a >= hi) {
				if (a < stop) {
					stop = a;
					stopJ = true;
				}
			} else {
				cuts.push({ a, b });
			}
		}
		cuts.sort((p, q) => p.a < q.a);
		const out: Array<{ a: number; b: number; ja: boolean; jb: boolean }> = [];
		let at = start;
		let atJ = startJ;
		for (const c of cuts) {
			if (c.a > at) out.push({ a: at, b: c.a, ja: atJ, jb: true });
			if (c.b > at) {
				at = c.b;
				atJ = true;
			}
		}
		if (stop > at) out.push({ a: at, b: stop, ja: atJ, jb: stopJ });
		return out;
	}

	/** asphalt, curbs (never across a crossing road), planted median, dashed lane lines */
	private drawRoad(r: Renderer, cam: Camera, road: Road, v: ViewRect, world: WorldData): void {
		const vertical = road.vertical;
		drawClipped(r, cam, road.x, road.y, road.w, road.h, v, { color: COLORS.road, zIndex: Z.road });
		const curb = 6;
		const size = vertical ? road.w : road.h;
		const base = vertical ? road.x : road.y;
		const stretches = this.roadStretches(road, v, world);
		for (const st of stretches) {
			for (const off of [0, size - curb]) {
				if (vertical) {
					drawClipped(r, cam, base + off, st.a, curb, st.b - st.a, v, {
						color: COLORS.curb,
						zIndex: Z.roadLine,
					});
				} else {
					drawClipped(r, cam, st.a, base + off, st.b - st.a, curb, v, {
						color: COLORS.curb,
						zIndex: Z.roadLine,
					});
				}
			}
		}
		for (const m of road.medians) {
			if (!overlaps(m.x, m.y, m.w, m.h, v)) continue;
			drawClipped(r, cam, m.x, m.y, m.w, m.h, v, {
				color: GROUND.verge,
				stroke: COLORS.curb,
				strokeThickness: 2,
				zIndex: Z.roadLine,
			});
		}
		// yellow centre line on two-lane streets, white lane lines on each avenue carriageway;
		// the dashes stop before the crosswalks
		const lines: Array<number> = [];
		if (road.avenue) {
			const carriage = (size - TOWN.MEDIAN_W) / 2;
			lines.push(base + carriage / 2, base + size - carriage / 2);
		} else {
			lines.push(base + size / 2);
		}
		const color = road.avenue ? GROUND.lane : COLORS.roadLine;
		const gap = TOWN.SIDEWALK + 24;
		const lo = vertical ? v.minY : v.minX;
		const hi = vertical ? v.maxY : v.maxX;
		for (const st of stretches) {
			const from = math.max(st.ja ? st.a + gap : st.a, lo - DASH_LEN);
			const to = math.min(st.jb ? st.b - gap : st.b, hi + DASH_LEN);
			for (let t = math.ceil(from / DASH_PERIOD) * DASH_PERIOD; t + DASH_LEN <= to; t += DASH_PERIOD) {
				for (const mid of lines) {
					r.drawRect(cam, vertical ? mid : t + DASH_LEN / 2, vertical ? t + DASH_LEN / 2 : mid, {
						w: vertical ? 5 : DASH_LEN,
						h: vertical ? DASH_LEN : 5,
						color,
						alpha: 0.7,
						zIndex: Z.roadLine,
					});
				}
			}
		}
	}

	// ------------------------------------------------------------------ solids

	drawSolids(r: Renderer, cam: Camera, v: ViewRect, world: WorldData): void {
		const list = this.queryBuf;
		list.clear();
		// pad: canopies reach ~90 px past the trunk, shadows ~20 px past their caster
		querySolids(world, v.minX - 140, v.minY - 140, v.maxX + 140, v.maxY + 140, list);
		for (const s of list) {
			if (s.kind === "building") {
				if (overlaps(s.x - 30, s.y - 30, s.w + 60, s.h + 60, v)) this.drawBuilding(r, cam, s, v);
			} else if (s.tags === "border") {
				this.drawBorder(r, cam, s, v);
			} else if (s.kind === "tree") {
				this.drawTree(r, cam, s, v);
			} else if (overlaps(s.x - 16, s.y - 16, s.w + 32, s.h + 32, v)) {
				if (s.tags === "bwall") this.drawWall(r, cam, s);
				else if (s.tags === "pump") this.drawPump(r, cam, s);
				else if (s.kind === "car" && s.tags === "trash") this.drawTrash(r, cam, s);
				else if (s.kind === "car") this.drawCar(r, cam, s);
				else this.drawStructure(r, cam, s);
			}
		}
	}

	private shake(s: Solid): { x: number; y: number } {
		const t = s.hitShake ?? 0;
		if (t <= 0) return { x: 0, y: 0 };
		const amp = 4 * math.min(1, t / 0.25);
		return { x: math.sin(this.clock * 70) * amp, y: math.cos(this.clock * 55) * amp * 0.6 };
	}

	private drawBuilding(r: Renderer, cam: Camera, s: Solid, v: ViewRect): void {
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const roofA = s.roofAlpha ?? 1;
		const bt = s.buildingType ?? 1;
		const isHouse = bt === 1 || bt === 2;
		// building shadow (the roof's, like the original: 0.3 * roof_alpha)
		const so = this.shadow(cx, cy, 20);
		if (overlaps(s.x + so.x, s.y + so.y, s.w, s.h, v)) {
			r.drawRect(cam, cx + so.x, cy + so.y, {
				w: s.w,
				h: s.h,
				color: BLACK,
				alpha: 0.3 * math.max(roofA, 0.4),
				zIndex: Z.shadow,
			});
		}
		// floor (visible through the doorway / when the roof fades)
		r.drawRect(cam, cx, cy, {
			w: s.w,
			h: s.h,
			color: isHouse ? COLORS.floorWood : bt === 4 || bt === 6 ? COLORS.floorTile : COLORS.floorShop,
			stroke: BLACK,
			strokeAlpha: 0.25,
			strokeThickness: 2,
			zIndex: Z.floor,
		});
		// doormat just outside the door: shows the entrance even with the roof closed
		const n = sideNormal(s.doorSide);
		const dx = s.doorX ?? cx;
		const dy = s.doorY ?? s.y + s.h;
		const matOff = TOWN.WALL_T / 2 + 14;
		r.drawRect(cam, dx + n.x * matOff, dy + n.y * matOff, {
			w: n.x !== 0 ? 22 : TOWN.DOOR_W - 24,
			h: n.x !== 0 ? TOWN.DOOR_W - 24 : 22,
			color: COLORS.doormat,
			cornerRadius: 3,
			zIndex: Z.floorDetail,
		});
		if (roofA <= 0.01) return;
		const roof = s.roofColor ?? COLORS.roofGray;
		const roofDark = roof.Lerp(BLACK, 0.3);
		r.drawRect(cam, cx, cy, {
			w: s.w,
			h: s.h,
			color: roof,
			alpha: roofA,
			stroke: roofDark,
			strokeThickness: 3,
			strokeAlpha: roofA,
			zIndex: Z.roof,
		});
		if (isHouse) {
			// ridge along the long axis
			const alongX = s.w >= s.h;
			r.drawRect(cam, cx, cy, {
				w: alongX ? s.w - 80 : 12,
				h: alongX ? 12 : s.h - 80,
				color: roofDark,
				alpha: roofA * 0.8,
				zIndex: Z.roof + 1,
			});
		} else {
			// flat roof: a/c box
			r.drawRect(cam, cx + s.w * 0.22, cy - s.h * 0.2, {
				w: 90,
				h: 70,
				color: roof.Lerp(WHITE, 0.25),
				alpha: roofA,
				stroke: roofDark,
				strokeAlpha: roofA,
				zIndex: Z.roof + 1,
			});
		}
		// darker eave over the doorway: the entrance reads from above
		const ex = dx + n.x * (TOWN.WALL_T / 2 - 6);
		const ey = dy + n.y * (TOWN.WALL_T / 2 - 6);
		r.drawRect(cam, ex, ey, {
			w: n.x !== 0 ? 12 : TOWN.DOOR_W,
			h: n.x !== 0 ? TOWN.DOOR_W : 12,
			color: roofDark.Lerp(BLACK, 0.3),
			alpha: roofA,
			zIndex: Z.roof + 1,
		});
		this.drawEmblem(r, cam, bt, cx, cy, roofA);
	}

	/** rooftop sign so shops can be found from afar */
	private drawEmblem(r: Renderer, cam: Camera, bt: number, cx: number, cy: number, a: number): void {
		const z = Z.roof + 2;
		if (bt === 4 || bt === 6) {
			const plate = bt === 4 ? 150 : 110;
			const crossColor = bt === 4 ? COLORS.uiRed : COLORS.uiGreen;
			r.drawRect(cam, cx, cy, { w: plate, h: plate, color: WHITE, alpha: a, cornerRadius: 12, zIndex: z });
			r.drawRect(cam, cx, cy, { w: plate * 0.72, h: plate * 0.24, color: crossColor, alpha: a, zIndex: z + 1 });
			r.drawRect(cam, cx, cy, { w: plate * 0.24, h: plate * 0.72, color: crossColor, alpha: a, zIndex: z + 1 });
		} else if (bt === 9) {
			r.drawCircle(cam, cx, cy, 110, {
				color: COLORS.uiPanel,
				alpha: a,
				stroke: COLORS.uiRed,
				strokeThickness: 4,
				strokeAlpha: a,
				zIndex: z,
			});
			r.drawRect(cam, cx, cy, { w: 120, h: 8, color: COLORS.uiRed, alpha: a, zIndex: z + 1 });
			r.drawRect(cam, cx, cy, { w: 8, h: 120, color: COLORS.uiRed, alpha: a, zIndex: z + 1 });
		} else if (bt === 5) {
			r.drawCircle(cam, cx, cy, 90, { color: COLORS.uiRed, alpha: a, zIndex: z });
			r.drawRect(cam, cx, cy, { w: 30, h: 44, color: WHITE, alpha: a, cornerRadius: 6, zIndex: z + 1 });
		} else if (bt === 7 || bt === 8 || bt === 11 || bt === 10 || bt === 3) {
			const accent = bt === 3 ? COLORS.uiYellow : bt === 11 ? WHITE : bt === 10 ? COLORS.uiBlue : COLORS.uiGreen;
			r.drawRect(cam, cx, cy, {
				w: 160,
				h: 56,
				color: COLORS.uiPanel,
				alpha: a,
				cornerRadius: 8,
				stroke: accent,
				strokeThickness: 3,
				strokeAlpha: a,
				zIndex: z,
			});
			r.drawRect(cam, cx, cy, { w: 110, h: 10, color: accent, alpha: a, zIndex: z + 1 });
		}
	}

	private drawWall(r: Renderer, cam: Camera, s: Solid): void {
		r.drawRect(cam, s.x + s.w / 2, s.y + s.h / 2, {
			w: s.w,
			h: s.h,
			color: COLORS.wallHouse,
			stroke: COLORS.wallWood,
			strokeThickness: 1,
			strokeAlpha: 0.8,
			zIndex: Z.structure,
		});
	}

	private drawBorder(r: Renderer, cam: Camera, s: Solid, v: ViewRect): void {
		drawClipped(r, cam, s.x, s.y, s.w, s.h, v, { color: COLORS.borderForest, zIndex: Z.structure });
		// fence along the inner edge
		const f = 8;
		let fx = s.x;
		let fy = s.y;
		let fw = s.w;
		let fh = s.h;
		if (s.w > s.h) {
			fh = f;
			fy = s.y === 0 ? s.y + s.h - f : s.y;
		} else {
			fw = f;
			fx = s.x === 0 ? s.x + s.w - f : s.x;
		}
		drawClipped(r, cam, fx, fy, fw, fh, v, { color: COLORS.fence, zIndex: Z.structure + 1 });
	}

	private drawTree(r: Renderer, cam: Camera, s: Solid, v: ViewRect): void {
		const sh = this.shake(s);
		const cx = s.x + s.w / 2 + sh.x;
		const cy = s.y + s.h / 2 + sh.y;
		const rad = s.canopyR ?? 80;
		if (!circleInView(cx, cy, rad + 24, v)) return;
		const a = s.canopyAlpha ?? 1;
		const leaf = s.tint ?? COLORS.treeLeaf;
		const so = this.shadow(cx, cy, 18);
		r.drawCircle(cam, cx + so.x, cy + so.y, rad * 1.8, { color: BLACK, alpha: 0.22, zIndex: Z.shadow });
		r.drawCircle(cam, cx, cy, s.w, {
			color: COLORS.treeTrunk,
			stroke: COLORS.treeTrunk.Lerp(BLACK, 0.4),
			strokeThickness: 2,
			zIndex: Z.structure,
		});
		r.drawCircle(cam, cx, cy, rad * 2, {
			color: leaf,
			alpha: a,
			stroke: COLORS.treeLeafDark,
			strokeThickness: 2,
			strokeAlpha: a * 0.7,
			zIndex: Z.canopy,
		});
		r.drawCircle(cam, cx - rad * 0.22, cy - rad * 0.22, rad * 1.1, {
			color: leaf.Lerp(COLORS.grassLight.Lerp(COLORS.treeLeafLight, 0.5), 0.6),
			alpha: a * a,
			zIndex: Z.canopy + 1,
		});
	}

	private drawCar(r: Renderer, cam: Camera, s: Solid): void {
		const sh = this.shake(s);
		const cx = s.x + s.w / 2 + sh.x;
		const cy = s.y + s.h / 2 + sh.y;
		const vertical = s.h > s.w;
		// generated cars carry their heading (right-hand parking, askew when abandoned); the body keeps
		// the car's real size even when the collision box of an askew car is a bit larger
		const heading = s.heading;
		const L = heading !== undefined ? TOWN.CAR_L : vertical ? s.h : s.w;
		const W = heading !== undefined ? TOWN.CAR_W : vertical ? s.w : s.h;
		const a = heading ?? (vertical ? math.pi / 2 : 0);
		const paint = s.tint ?? COLORS.car;
		const so = this.shadow(cx, cy, 10);
		part(r, cam, cx + so.x, cy + so.y, a, 0, 0, {
			w: L,
			h: W,
			color: BLACK,
			alpha: 0.35,
			cornerRadius: 18,
			zIndex: Z.shadow,
		});
		part(r, cam, cx, cy, a, 0, 0, {
			w: L,
			h: W,
			color: paint,
			cornerRadius: 18,
			stroke: paint.Lerp(BLACK, 0.45),
			strokeThickness: 2,
			zIndex: Z.structure,
		});
		part(r, cam, cx, cy, a, -L * 0.04, 0, {
			w: L * 0.44,
			h: W * 0.8,
			color: paint.Lerp(BLACK, 0.25),
			cornerRadius: 10,
			zIndex: Z.structure + 1,
		});
		part(r, cam, cx, cy, a, L * 0.2, 0, {
			w: L * 0.1,
			h: W * 0.72,
			color: COLORS.carGlass,
			cornerRadius: 4,
			zIndex: Z.structure + 2,
		});
		part(r, cam, cx, cy, a, -L * 0.28, 0, {
			w: L * 0.07,
			h: W * 0.66,
			color: COLORS.carGlass,
			cornerRadius: 4,
			zIndex: Z.structure + 2,
		});
		for (const side of SIDES) {
			part(r, cam, cx, cy, a, L * 0.47, side * W * 0.3, {
				w: 8,
				h: 18,
				color: COLORS.carLight,
				cornerRadius: 3,
				zIndex: Z.structure + 2,
			});
			part(r, cam, cx, cy, a, -L * 0.48, side * W * 0.3, {
				w: 6,
				h: 16,
				color: COLORS.carTail,
				cornerRadius: 2,
				zIndex: Z.structure + 2,
			});
		}
	}

	/** gas-station pump island: a raised concrete curb carrying two dispensers */
	private drawPump(r: Renderer, cam: Camera, s: Solid): void {
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const horizontal = s.w >= s.h;
		const so = this.shadow(cx, cy, 8);
		r.drawRect(cam, cx + so.x, cy + so.y, {
			w: s.w,
			h: s.h,
			color: BLACK,
			alpha: 0.3,
			cornerRadius: 8,
			zIndex: Z.shadow,
		});
		r.drawRect(cam, cx, cy, {
			w: s.w,
			h: s.h,
			color: GROUND.island,
			cornerRadius: 8,
			stroke: COLORS.curb,
			strokeThickness: 2,
			zIndex: Z.structure,
		});
		for (const k of [-1, 1]) {
			const off = (horizontal ? s.w : s.h) * 0.25 * k;
			r.drawRect(cam, cx + (horizontal ? off : 0), cy + (horizontal ? 0 : off), {
				w: horizontal ? 30 : 24,
				h: horizontal ? 24 : 30,
				color: COLORS.wallShop,
				cornerRadius: 4,
				stroke: COLORS.wallShop.Lerp(BLACK, 0.5),
				strokeThickness: 1,
				zIndex: Z.structure + 1,
			});
		}
	}

	private drawTrash(r: Renderer, cam: Camera, s: Solid): void {
		const sh = this.shake(s);
		const cx = s.x + s.w / 2 + sh.x;
		const cy = s.y + s.h / 2 + sh.y;
		const so = this.shadow(cx, cy, 7);
		r.drawRect(cam, cx + so.x, cy + so.y, {
			w: s.w,
			h: s.h,
			color: BLACK,
			alpha: 0.3,
			cornerRadius: 6,
			zIndex: Z.shadow,
		});
		r.drawRect(cam, cx, cy, {
			w: s.w,
			h: s.h,
			color: COLORS.trashBin,
			cornerRadius: 6,
			stroke: COLORS.trashBin.Lerp(BLACK, 0.5),
			strokeThickness: 2,
			zIndex: Z.structure,
		});
		r.drawRect(cam, cx, cy, {
			w: s.w - 8,
			h: s.h - 8,
			color: COLORS.trashLid,
			cornerRadius: 5,
			zIndex: Z.structure + 1,
		});
		r.drawRect(cam, cx, cy, {
			w: 14,
			h: 4,
			color: COLORS.trashBin.Lerp(BLACK, 0.4),
			zIndex: Z.structure + 2,
		});
	}

	private structureColor(s: Solid): Color3 {
		if (s.kind === "wall_h" || s.kind === "wall_v") return COLORS.wallWood;
		if (s.kind === "door") return COLORS.door;
		if (s.kind === "iron_door") return COLORS.ironDoor;
		if (s.kind === "barricade") return COLORS.barricade;
		if (s.kind === "iron_barricade") return COLORS.ironBarricade;
		if (s.tags === "turret" || s.tags === "electric_turret") return COLORS.turret;
		if (s.tags === "trap" || s.tags === "trap_electric") return COLORS.trap;
		if (s.tags === "lamp") return COLORS.lamp;
		if (s.tags === "campfire" || s.tags === "brazier") return COLORS.campfire;
		if (s.tags === "generator" || s.tags === "battery") return COLORS.uiBlue;
		return COLORS.uiPanelLight;
	}

	/** player-built structures (doors, barricades, turrets, traps, desks...) */
	private drawStructure(r: Renderer, cam: Camera, s: Solid): void {
		const sh = this.shake(s);
		const cx = s.x + s.w / 2 + sh.x;
		const cy = s.y + s.h / 2 + sh.y;
		const isTrap = s.tags === "trap" || s.tags === "trap_electric";
		const isDoor = s.kind === "door" || s.kind === "iron_door";
		const color = this.structureColor(s);
		if (!isTrap) {
			const so = this.shadow(cx, cy, 8);
			r.drawRect(cam, cx + so.x, cy + so.y, { w: s.w, h: s.h, color: BLACK, alpha: 0.3, zIndex: Z.shadow });
		}
		r.drawRect(cam, cx, cy, {
			w: s.w,
			h: s.h,
			color,
			alpha: isDoor && s.open === true ? 0.35 : 1,
			stroke: color.Lerp(BLACK, 0.45),
			strokeThickness: 2,
			cornerRadius: isTrap ? 8 : 0,
			// traps lie flat on the floor: zombies walk over them
			zIndex: isTrap ? Z.item : Z.structure,
		});
		if (s.powered === true && (s.tags === "lamp" || s.tags === "campfire" || s.tags === "brazier")) {
			r.drawCircle(cam, cx, cy, math.min(s.w, s.h) * 0.5, {
				color: COLORS.lamp,
				alpha: 0.6 + math.sin(this.clock * 9) * 0.2,
				zIndex: Z.structure + 1,
			});
		}
		if (s.destructible && s.hp < s.hpMax && s.hpMax < 99999) {
			const k = clamp(s.hp / s.hpMax, 0, 1);
			const bw = math.max(40, s.w * 0.8);
			const by = s.y - 10;
			r.drawRect(cam, cx, by, { w: bw, h: 6, color: BLACK, alpha: 0.6, zIndex: Z.actorFx });
			r.drawRect(cam, cx - (bw * (1 - k)) / 2, by, {
				w: math.max(1, bw * k),
				h: 4,
				color: COLORS.uiRed.Lerp(COLORS.uiGreen, k),
				zIndex: Z.actorFx + 1,
			});
		}
	}
}
