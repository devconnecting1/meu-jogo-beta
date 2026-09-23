/*
 * The town on screen: ground, roads, crosswalks, buildings (floor, roof, signage), walls, the map border,
 * trees, cars, pump islands, bins and the structures players build -- everything that stands still in the world.
 *
 * This is the drawing half of what `gameLoop.ts` drew until now, moved here verbatim (docs/MULTIPLAYER.md §11.3:
 * "desenho em gameLoop.ts -> client/view/{worldView,actorsView,fxView}.ts"), with the loop's private helpers
 * replaced by `drawKit` and the two things it read off the loop handed in: where a shadow falls (`shadow`, LUZ-01)
 * and the animation clock (`clock`: a struck tree's shake, a lamp's flicker).
 *
 * Two owners draw through it, each with its own Renderer and Camera: the run (`GameLoop.render`) and the menus'
 * town flyover (client/view/townFlyover.ts, DESIGN_RULES UI-10), so the town behind the lobby is the very town the
 * survivor walks into -- the same roofs, signs and cars, never a picture of it.
 *
 * It holds no world state of its own: the WorldData is passed in on every call.
 *
 * World art (2026-09-23, the owner's "polish the town"): every surface and prop has a pixel-art version drawn with
 * the textures of design/world-art (tools/gen-world-art.mjs) -- tiled ImageLabels for the ground, the roads and the
 * roofs, sprites for the cars, trees, bins and pumps, soft 9-slice shadows -- and each one is used only when its
 * texture has an asset id (client/view/worldArt.ts). Without one, that surface is drawn by the flat method below,
 * untouched: the `draw*Art` methods are additions, never replacements, and the decorative extras the art brings
 * (manholes, drains, oil stains, litter, dried blood, rooftop units, kerb shadows) exist only with it.
 * Nothing here changes a solid, a collision box or the generator: a car's model, its state (intact, broken into,
 * burnt) and a yard's overgrowth are read off a hash of where it stands, the same on every client.
 */
import { COLORS, Z } from "shared/engine/colors";
import { Camera, ViewRect } from "shared/engine/camera";
import { TOWN } from "shared/engine/constants";
import { Renderer, SpriteOpts } from "shared/engine/renderer";
import { clamp } from "shared/engine/vec2";
import { GroundRect, hash01, Lot, querySolids, Rect, Road, Solid, WorldData } from "shared/game/world";
import { drawBuildingSign } from "./buildingSigns";
import { circleInView, overlaps, part, SIDES } from "./drawKit";
import { artId, artSize, artSlice } from "./worldArt";
import { WORLD_TEXEL, WorldArtName } from "./worldArtAssets";

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

// ------------------------------------------------------------------ world art: tints and sizes

/** ImageColor3 multiplies: a darker variant of a texture is the texture times these */
const PARK_TINT = Color3.fromRGB(228, 246, 231);
const DRIVE_TINT = Color3.fromRGB(235, 235, 235);
const PATH_TINT = Color3.fromRGB(211, 198, 172);
/** the paint and body of a burnt-out car */
const BURNT = Color3.fromRGB(66, 60, 56);
const DOOR_GAP = Color3.fromRGB(28, 28, 30);
const STEP = COLORS.sidewalk.Lerp(WHITE, 0.3);
const CHIMNEY = Color3.fromRGB(122, 74, 58);
/**
 * Kerb stones inside the road edge: 12 units of stone (the flat curb is 6) and, baked into the same texture, 4 of
 * contact shadow on the asphalt. When the sun (at night the survivor's light) is behind a kerb, its shadow reaches
 * further: one more strip, up to KERB_SHADOW_SUN units (LUZ-01).
 */
const KERB_W = 16;
const KERB_SHADOW_SUN = 8;
/** how far behind a kerb the light must be before its longer shadow is worth a sprite */
const KERB_SUN_MIN = 0.3;
/** pitch of the spots that may carry an oil stain or a crack along a road (units) */
const DECAL_PITCH = 224;
/** a yard nobody has mowed since the outbreak: the share of residential yards whose grass is long */
const OVERGROWN = 0.3;
/** car states (VEI-03: few wrecks) */
const CAR_INTACT = 0;
const CAR_BROKEN = 1;
const CAR_BURNT = 2;
/** car body styles in the art (sedan, hatchback, pickup, SUV) */
const CAR_STYLES = 4;
const CANOPY_STYLES = 3;
/** the named textures, typed once (template strings would allocate a string per car per frame) */
const CAR_MASK: Array<WorldArtName> = ["car0", "car1", "car2", "car3"];
const CAR_TRIM: Array<WorldArtName> = ["carTrim0", "carTrim1", "carTrim2", "carTrim3"];
const CAR_DAMAGE: Array<WorldArtName> = ["carDamage0", "carDamage1", "carDamage2", "carDamage3"];
const CAR_WRECK: Array<WorldArtName> = ["carWreck0", "carWreck1", "carWreck2", "carWreck3"];
const CANOPY_MASK: Array<WorldArtName> = ["canopy0", "canopy1", "canopy2"];
const CANOPY_SHADE: Array<WorldArtName> = ["canopyShade0", "canopyShade1", "canopyShade2"];
const LITTER: Array<WorldArtName> = ["litter0", "litter1", "litter2"];
const BLOOD: Array<WorldArtName> = ["blood0", "blood1"];
const OIL: Array<WorldArtName> = ["oil0", "oil1"];
const CRACK: Array<WorldArtName> = ["crack0", "crack1"];

/**
 * The one SpriteOpts every art draw fills (the hot path allocates no table per sprite). `artOpts` resets every
 * field the renderer reads, so nothing leaks from one draw into the next.
 */
const ART: SpriteOpts = {};

function artOpts(id: string, w: number, h: number, z: number): SpriteOpts {
	const o = ART;
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
	return o;
}

/** a 9-slice texture's centre on the scratch options, `unit` world units per texel of its border */
function sliced(o: SpriteOpts, name: WorldArtName, unit: number): SpriteOpts {
	const s = artSlice(name);
	o.scaleType = "slice";
	o.sliceX0 = s[0];
	o.sliceY0 = s[1];
	o.sliceX1 = s[2];
	o.sliceY1 = s[3];
	o.sliceScale = unit;
	return o;
}

/** is this car standing askew in a lane (abandoned, VEI-03) rather than parked square to the kerb? */
function isAskew(s: Solid): boolean {
	const h = s.heading;
	if (h === undefined) return false;
	const q = h / (math.pi / 2);
	return math.abs(q - math.floor(q + 0.5)) > 0.01;
}
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
	/** a pitched roof's colour in full sun, half light and shade (built once per building, not per frame) */
	private readonly roofShades = new Map<Solid, Array<Color3>>();
	private shadesFor?: WorldData;

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
		// with the asphalt texture, one world-anchored sheet under the lots is every road's asphalt: the tiles line
		// up across every crossing and the whole street network costs one sprite
		const asphalt = artId("asphalt");
		if (asphalt !== undefined) this.drawAsphaltSheet(r, cam, v, world, asphalt);
		for (const lot of w.lots) {
			if (!overlaps(lot.x, lot.y, lot.w, lot.h, v)) continue;
			const y = lot.yard;
			if (y.x !== lot.x || y.y !== lot.y || y.w !== lot.w || y.h !== lot.h) {
				if (!this.tiled(r, cam, lot, v, "concrete", Z.ground)) {
					drawClipped(r, cam, lot.x, lot.y, lot.w, lot.h, v, {
						color: COLORS.sidewalk,
						zIndex: Z.ground,
					});
				}
			}
			const paved = lot.zone === "commercial";
			if (!this.drawYardArt(r, cam, lot, v)) {
				drawClipped(r, cam, y.x, y.y, y.w, y.h, v, {
					color: paved ? GROUND.plaza : lot.kind === "park" ? COLORS.parkGrass : COLORS.grass,
					zIndex: Z.ground + 1,
				});
			}
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
				if (this.tiled(r, cam, p, v, "dirt", Z.ground + 2, PATH_TINT)) continue;
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
		const paint = artId("paint");
		for (const c of w.crossings) {
			if (!overlaps(c.x, c.y, c.w, c.h, v)) continue;
			// zebra: bars along the traffic, laid out across the road
			const across = c.vertical ? c.w : c.h;
			const n = math.floor((across - 16) / ZEBRA_STEP);
			const first = (across - (n - 1) * ZEBRA_STEP) / 2;
			for (let i = 0; i < n; i++) {
				const t = first + i * ZEBRA_STEP;
				const bx = c.vertical ? c.x + t : c.x + c.w / 2;
				const by = c.vertical ? c.y + c.h / 2 : c.y + t;
				const bw = c.vertical ? ZEBRA_W : c.w;
				const bh = c.vertical ? c.h : ZEBRA_W;
				if (paint !== undefined) {
					this.paintStripe(r, cam, paint, bx, by, bw, bh, GROUND.zebra, 0.92);
					continue;
				}
				r.drawRect(cam, bx, by, {
					w: bw,
					h: bh,
					color: GROUND.zebra,
					alpha: 0.9,
					zIndex: Z.roadLine,
				});
			}
		}
		if (asphalt !== undefined) this.drawStreetDetail(r, cam, v, world);
	}

	private drawGroundRect(r: Renderer, cam: Camera, g: GroundRect, v: ViewRect): void {
		if (this.drawGroundRectArt(r, cam, g, v)) return;
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
		// the art draws all the asphalt at once (drawAsphaltSheet)
		if (artId("asphalt") === undefined) {
			drawClipped(r, cam, road.x, road.y, road.w, road.h, v, { color: COLORS.road, zIndex: Z.road });
		}
		const curb = 6;
		const size = vertical ? road.w : road.h;
		const base = vertical ? road.x : road.y;
		const stretches = this.roadStretches(road, v, world);
		const kerbLow = artId(vertical ? "kerbW" : "kerbN");
		const kerbHigh = artId(vertical ? "kerbE" : "kerbS");
		const art = artId("asphalt") !== undefined;
		for (const st of stretches) {
			if (art) this.drawRoadDetail(r, cam, v, road, base, size, st.a, st.b, st.ja, st.jb);
			if (kerbLow !== undefined && kerbHigh !== undefined) {
				this.drawKerbs(r, cam, v, vertical, base, size, st.a, st.b, kerbLow, kerbHigh);
				continue;
			}
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
			if (this.tiled(r, cam, m, v, "grass", Z.roadLine, undefined, COLORS.curb)) continue;
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
		const paint = artId("paint");
		const gap = TOWN.SIDEWALK + 24;
		const lo = vertical ? v.minY : v.minX;
		const hi = vertical ? v.maxY : v.maxX;
		for (const st of stretches) {
			const from = math.max(st.ja ? st.a + gap : st.a, lo - DASH_LEN);
			const to = math.min(st.jb ? st.b - gap : st.b, hi + DASH_LEN);
			for (let t = math.ceil(from / DASH_PERIOD) * DASH_PERIOD; t + DASH_LEN <= to; t += DASH_PERIOD) {
				for (const mid of lines) {
					if (paint !== undefined) {
						const dx = vertical ? mid : t + DASH_LEN / 2;
						const dy = vertical ? t + DASH_LEN / 2 : mid;
						this.paintStripe(
							r,
							cam,
							paint,
							dx,
							dy,
							vertical ? 6 : DASH_LEN,
							vertical ? DASH_LEN : 6,
							color,
							0.78,
						);
						continue;
					}
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
		if (world !== this.shadesFor) {
			this.roofShades.clear();
			this.shadesFor = world;
		}
		for (const s of list) {
			if (s.kind === "building") {
				// the art culls on its own (its shadow reaches further); the flat drawing keeps its old margin
				if (this.drawBuildingArt(r, cam, s, v)) continue;
				if (overlaps(s.x - 30, s.y - 30, s.w + 60, s.h + 60, v)) this.drawBuilding(r, cam, s, v);
			} else if (s.tags === "border") {
				if (!this.drawBorderArt(r, cam, s, v)) this.drawBorder(r, cam, s, v);
			} else if (s.kind === "tree") {
				if (!this.drawTreeArt(r, cam, s, v)) this.drawTree(r, cam, s, v);
			} else if (overlaps(s.x - 16, s.y - 16, s.w + 32, s.h + 32, v)) {
				if (s.tags === "bwall") {
					if (!this.drawWallArt(r, cam, s)) this.drawWall(r, cam, s);
				} else if (s.tags === "pump") {
					if (!this.drawPumpArt(r, cam, s)) this.drawPump(r, cam, s);
				} else if (s.kind === "car" && s.tags === "trash") {
					if (!this.drawTrashArt(r, cam, s)) this.drawTrash(r, cam, s);
				} else if (s.kind === "car") {
					if (!this.drawCarArt(r, cam, s)) this.drawCar(r, cam, s);
				} else {
					this.drawStructure(r, cam, s);
				}
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
		this.drawSignage(r, cam, v, s, roofA);
	}

	/**
	 * How the building says what it is (client/view/buildingSigns.ts, DESIGN_RULES EDI-03, ART-07): the storefront
	 * sign beside the main entrance and, on a hospital, the helipad. The ONE hook of the signage, shared by the flat
	 * and the art drawing and by the menus' flyover: it hands the sign the building's type, its main entrance (where,
	 * and in which wall) and the roof rect the sign stands on -- the only lines to change when a building has several
	 * wings or entrances (the main one's, and the main wing's rect). Nothing else here knows a sign exists.
	 */
	private drawSignage(r: Renderer, cam: Camera, v: ViewRect, s: Solid, a: number): void {
		drawBuildingSign(
			r,
			cam,
			v,
			s.buildingType ?? 1,
			s.doorX ?? s.x + s.w / 2,
			s.doorY ?? s.y + s.h,
			s.doorSide ?? "bottom",
			s,
			a,
			this.shadow,
		);
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

	// ================================================================== world art (see the header)
	//
	// Every method below answers false when its texture has no asset id, and the caller then draws the flat
	// version above. Z layers are the flat ones, so nothing changes place in the stack.

	/**
	 * `name` tiled over the rect, clipped to the view on WHOLE tiles counted from the rect's own corner: the
	 * pattern never slides as the camera moves, and the sprite changes size only when a tile boundary crosses the
	 * view's edge. Answers false (nothing drawn) when the texture is not live.
	 */
	private tiled(
		r: Renderer,
		cam: Camera,
		q: Rect,
		v: ViewRect,
		name: WorldArtName,
		z: number,
		tint?: Color3,
		stroke?: Color3,
		strokeThickness = 2,
		strokeAlpha = 1,
	): boolean {
		const id = artId(name);
		if (id === undefined) return false;
		this.tileRect(r, cam, q.x, q.y, q.w, q.h, v, name, id, z, tint, 1, stroke, strokeThickness, strokeAlpha);
		return true;
	}

	/** the drawing half of `tiled` (also used for roof slopes); fills the scratch and draws, returns nothing */
	private tileRect(
		r: Renderer,
		cam: Camera,
		x: number,
		y: number,
		w: number,
		h: number,
		v: ViewRect,
		name: WorldArtName,
		id: string,
		z: number,
		tint: Color3 | undefined,
		alpha: number,
		stroke?: Color3,
		strokeThickness = 2,
		strokeAlpha = 1,
	): void {
		const size = artSize(name);
		const pw = size.w * WORLD_TEXEL;
		const ph = size.h * WORLD_TEXEL;
		let x0 = x;
		let y0 = y;
		if (v.minX > x0) x0 += math.floor((v.minX - x0) / pw) * pw;
		if (v.minY > y0) y0 += math.floor((v.minY - y0) / ph) * ph;
		const x1 = math.min(x + w, v.maxX);
		const y1 = math.min(y + h, v.maxY);
		if (x1 <= x0 || y1 <= y0) return;
		const o = artOpts(id, x1 - x0, y1 - y0, z);
		o.scaleType = "tile";
		o.tileW = pw;
		o.tileH = ph;
		o.imageTint = tint;
		o.alpha = alpha;
		o.stroke = stroke;
		o.strokeThickness = strokeThickness;
		o.strokeAlpha = strokeAlpha;
		r.drawRect(cam, (x0 + x1) / 2, (y0 + y1) / 2, o);
	}

	/** every road's asphalt in one sprite, under the lots (which cover everything that is not road) */
	private drawAsphaltSheet(r: Renderer, cam: Camera, v: ViewRect, world: WorldData, id: string): void {
		const size = artSize("asphalt");
		const p = size.w * WORLD_TEXEL;
		// anchored on the world's own tile grid, so every street's grain lines up with its neighbours'
		const x0 = math.max(0, math.floor(v.minX / p) * p);
		const y0 = math.max(0, math.floor(v.minY / p) * p);
		const x1 = math.min(world.width, v.maxX);
		const y1 = math.min(world.height, v.maxY);
		if (x1 <= x0 || y1 <= y0) return;
		const o = artOpts(id, x1 - x0, y1 - y0, Z.ground - 1);
		o.scaleType = "tile";
		o.tileW = p;
		o.tileH = size.h * WORLD_TEXEL;
		r.drawRect(cam, (x0 + x1) / 2, (y0 + y1) / 2, o);
	}

	/** a lot's yard: downtown paving, park lawn, a mowed lawn or (a few) a lawn nobody has mowed since */
	private drawYardArt(r: Renderer, cam: Camera, lot: Lot, v: ViewRect): boolean {
		const y = lot.yard;
		const z = Z.ground + 1;
		if (lot.zone === "commercial") return this.tiled(r, cam, y, v, "plaza", z);
		if (lot.kind === "park") return this.tiled(r, cam, y, v, "grass", z, PARK_TINT);
		const long = lot.kind === "block" && lot.zone === "residential" && hash01(lot.x, lot.y, 3) < OVERGROWN;
		if (long && this.tiled(r, cam, y, v, "grassLong", z)) return true;
		return this.tiled(r, cam, y, v, "grass", z);
	}

	private drawGroundRectArt(r: Renderer, cam: Camera, g: GroundRect, v: ViewRect): boolean {
		const k = g.kind;
		const z = Z.ground + 2;
		if (k === "stall") {
			const id = artId("paint");
			if (id === undefined) return false;
			this.paintStripe(r, cam, id, g.x + g.w / 2, g.y + g.h / 2, g.w, g.h, GROUND.stall, 0.9, Z.ground + 3);
			return true;
		}
		if (k === "pit") {
			const id = artId("soil");
			if (id === undefined) return false;
			this.tileRect(r, cam, g.x, g.y, g.w, g.h, v, "soil", id, z, undefined, 1, COLORS.curb, 2);
			return true;
		}
		if (k === "verge") return this.tiled(r, cam, g, v, "grass", z);
		if (k === "walk") return this.tiled(r, cam, g, v, "pavers", z);
		if (k === "drive") return this.tiled(r, cam, g, v, "concrete", z, DRIVE_TINT);
		if (k === "apron") return this.tiled(r, cam, g, v, "apron", z);
		if (k === "parking") return this.tiled(r, cam, g, v, "asphaltLot", z);
		if (k === "playground") return this.tiled(r, cam, g, v, "dirt", z);
		return this.tiled(r, cam, g, v, "tactile", z);
	}

	/** a painted marking (zebra bar, lane dash, parking stall line): worn white paint, tinted */
	private paintStripe(
		r: Renderer,
		cam: Camera,
		id: string,
		cx: number,
		cy: number,
		w: number,
		h: number,
		tint: Color3,
		alpha: number,
		z = Z.roadLine,
	): void {
		const size = artSize("paint");
		const o = artOpts(id, w, h, z);
		o.scaleType = "tile";
		o.tileW = size.w * WORLD_TEXEL;
		o.tileH = size.h * WORLD_TEXEL;
		o.imageTint = tint;
		o.alpha = alpha;
		r.drawRect(cam, cx, cy, o);
	}

	/**
	 * The two kerbs of a road stretch [a, b]: stone kerbs with joints and their contact shadow on the asphalt (one
	 * sprite each, the texture of that side of the road), and a longer shadow on the kerbs the light is behind.
	 */
	private drawKerbs(
		r: Renderer,
		cam: Camera,
		v: ViewRect,
		vertical: boolean,
		base: number,
		size: number,
		a: number,
		b: number,
		lowId: string,
		highId: string,
	): void {
		const tex = artSize(vertical ? "kerbW" : "kerbN");
		const p = (vertical ? tex.h : tex.w) * WORLD_TEXEL;
		const lo = vertical ? v.minY : v.minX;
		const hi = vertical ? v.maxY : v.maxX;
		let s0 = a;
		if (lo > s0) s0 += math.floor((lo - s0) / p) * p;
		const s1 = math.min(b, hi);
		if (s1 <= s0) return;
		const mid = (s0 + s1) / 2;
		const across = base + size / 2;
		const sun = this.shadow(vertical ? across : mid, vertical ? mid : across, 1);
		const toward = vertical ? sun.x : sun.y;
		const len = s1 - s0;
		for (const side of SIDES) {
			const low = side < 0;
			const off = low ? base : base + size - KERB_W;
			const o = artOpts(low ? lowId : highId, vertical ? KERB_W : len, vertical ? len : KERB_W, Z.roadLine);
			o.scaleType = "tile";
			o.tileW = tex.w * WORLD_TEXEL;
			o.tileH = tex.h * WORLD_TEXEL;
			const kc = off + KERB_W / 2;
			r.drawRect(cam, vertical ? kc : mid, vertical ? mid : kc, o);
			// the road lies past a low kerb's line and before a high one's: the long shadow falls there when the light
			// is on the sidewalk side
			const behind = low ? toward : -toward;
			if (behind < KERB_SUN_MIN) continue;
			const sw = KERB_SHADOW_SUN * behind;
			const sc = low ? base + KERB_W + sw / 2 : base + size - KERB_W - sw / 2;
			r.drawRect(cam, vertical ? sc : mid, vertical ? mid : sc, {
				w: vertical ? sw : len,
				h: vertical ? len : sw,
				color: BLACK,
				alpha: 0.18,
				zIndex: Z.roadLine,
			});
		}
	}

	/**
	 * What a few days of abandonment leave on a road stretch: oil where cars park, a crack here and there, a storm
	 * drain at the kerb past each crosswalk. Spots sit on a fixed lattice along the road and a hash of the spot
	 * picks what (if anything) is there: the same street on every client, nothing stored, cost ∝ the view.
	 */
	private drawRoadDetail(
		r: Renderer,
		cam: Camera,
		v: ViewRect,
		road: Road,
		base: number,
		size: number,
		a: number,
		b: number,
		ja: boolean,
		jb: boolean,
	): void {
		const vertical = road.vertical;
		const lo = vertical ? v.minY : v.minX;
		const hi = vertical ? v.maxY : v.maxX;
		// clear of the crosswalks and the corner ramps
		const clearA = ja ? a + TOWN.SIDEWALK + 48 : a + 64;
		const clearB = jb ? b - TOWN.SIDEWALK - 48 : b - 64;
		const rot = vertical ? math.pi / 2 : 0;
		const first = math.ceil(math.max(clearA, lo - 96) / DECAL_PITCH) * DECAL_PITCH;
		const last = math.min(clearB, hi + 96);
		const salt = vertical ? road.x : road.y;
		for (let t = first; t <= last; t += DECAL_PITCH) {
			const h = hash01(t, salt, 51);
			if (h >= 0.24) continue;
			const pick = hash01(t, salt, 52);
			let name: WorldArtName;
			let across: number;
			let w: number;
			let hh: number;
			if (h < 0.16) {
				// an oil stain in a parking lane, where a car dripped for years
				name = OIL[math.floor(pick * 2) % 2];
				const lane = TOWN.CURB_GAP + TOWN.CAR_W / 2;
				across = pick < 0.5 ? base + lane : base + size - lane;
				w = 64;
				hh = 48;
			} else {
				name = CRACK[math.floor(pick * 2) % 2];
				across = base + size * (0.3 + 0.4 * hash01(t, salt, 53));
				w = 96;
				hh = 32;
			}
			const id = artId(name);
			if (id === undefined) continue;
			const along = t + (pick - 0.5) * 60;
			const o = artOpts(id, w, hh, Z.road);
			o.rotation = rot;
			r.drawRect(cam, vertical ? across : along, vertical ? along : across, o);
		}
		const drain = artId("drain");
		if (drain === undefined) return;
		// storm drains in the gutter just past each crosswalk, on the kerb traffic reaches first (right-hand)
		for (const tip of SIDES) {
			if (tip < 0 ? !ja : !jb) continue;
			const along = tip < 0 ? clearA : clearB;
			// not every corner has one
			if (hash01(along, salt, 54) < 0.5) continue;
			if (along < lo - 32 || along > hi + 32) continue;
			const across = tip < 0 ? base + size - KERB_W - 8 : base + KERB_W + 8;
			const o = artOpts(drain, 32, 16, Z.road);
			o.rotation = rot;
			r.drawRect(cam, vertical ? across : along, vertical ? along : across, o);
		}
	}

	/** a manhole cover in every crossing, somewhere off its middle */
	private drawStreetDetail(r: Renderer, cam: Camera, v: ViewRect, world: WorldData): void {
		const id = artId("manhole");
		if (id === undefined) return;
		for (const j of world.junctions) {
			const cx = j.x + j.w * (0.3 + 0.4 * hash01(j.x, j.y, 41));
			const cy = j.y + j.h * (0.3 + 0.4 * hash01(j.x, j.y, 42));
			if (!circleInView(cx, cy, 24, v)) continue;
			r.drawRect(cam, cx, cy, artOpts(id, 32, 32, Z.road));
		}
	}

	/** a pitched roof's colour in full light, half light, shade, and its ridge (built once per building) */
	private roofShadesOf(s: Solid, roof: Color3): Array<Color3> {
		let c = this.roofShades.get(s);
		if (c === undefined) {
			c = [roof, roof.Lerp(BLACK, 0.1), roof.Lerp(BLACK, 0.24), roof.Lerp(BLACK, 0.4)];
			this.roofShades.set(s, c);
		}
		return c;
	}

	/**
	 * A building with textured roof, floor and soft shadow. Houses get a gable roof whose sunlit slope is lighter
	 * (which slope follows the sun, LUZ-01) and a chimney; flat roofs a parapet with its shadow on the roof and
	 * rooftop units. The roof keeps the colour that identifies the building type (EDI-03): the texture is grey and
	 * tinted with it. A doorstep marks the entrance. Answers false when the roof texture is not live.
	 */
	private drawBuildingArt(r: Renderer, cam: Camera, s: Solid, v: ViewRect): boolean {
		const bt = s.buildingType ?? 1;
		const isHouse = bt === 1 || bt === 2;
		const alongX = s.w >= s.h;
		const roofTex: WorldArtName = isHouse
			? alongX
				? "roofShingleH"
				: "roofShingleV"
			: bt === 3 || bt === 4 || bt === 5
				? "roofMembrane"
				: "roofGravel";
		const roofId = artId(roofTex);
		if (roofId === undefined) return false;
		if (!overlaps(s.x - 60, s.y - 60, s.w + 120, s.h + 120, v)) return true;
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const roofA = s.roofAlpha ?? 1;
		// soft drop shadow, a little longer than the flat one: a building is taller than a car
		const so = this.shadow(cx, cy, 30);
		const sx = cx + so.x;
		const sy = cy + so.y;
		const sb = artId("shadowBox");
		if (sb !== undefined) {
			const o = sliced(artOpts(sb, s.w + 16, s.h + 16, Z.shadow), "shadowBox", 3);
			o.alpha = 0.36 * math.max(roofA, 0.4);
			r.drawRect(cam, sx, sy, o);
		} else {
			r.drawRect(cam, sx, sy, {
				w: s.w,
				h: s.h,
				color: BLACK,
				alpha: 0.3 * math.max(roofA, 0.4),
				zIndex: Z.shadow,
			});
		}
		// floor (seen through the doorway, and when the roof fades with the survivor inside)
		const floorTex: WorldArtName = isHouse ? "floorWood" : bt === 4 || bt === 6 ? "floorTile" : "floorShop";
		const floorId = artId(floorTex);
		if (floorId !== undefined) {
			this.tileRect(r, cam, s.x, s.y, s.w, s.h, v, floorTex, floorId, Z.floor, undefined, 1, BLACK, 2, 0.25);
		} else {
			r.drawRect(cam, cx, cy, {
				w: s.w,
				h: s.h,
				color: isHouse ? COLORS.floorWood : bt === 4 || bt === 6 ? COLORS.floorTile : COLORS.floorShop,
				stroke: BLACK,
				strokeAlpha: 0.25,
				strokeThickness: 2,
				zIndex: Z.floor,
			});
		}
		// the doorstep and the mat on it: the entrance reads even with the roof closed
		const n = sideNormal(s.doorSide);
		const dx = s.doorX ?? cx;
		const dy = s.doorY ?? s.y + s.h;
		const stepOff = TOWN.WALL_T / 2 + 10;
		r.drawRect(cam, dx + n.x * stepOff, dy + n.y * stepOff, {
			w: n.x !== 0 ? 20 : TOWN.DOOR_W + 20,
			h: n.x !== 0 ? TOWN.DOOR_W + 20 : 20,
			color: STEP,
			stroke: BLACK,
			strokeAlpha: 0.22,
			strokeThickness: 1,
			zIndex: Z.floorDetail,
		});
		const matOff = TOWN.WALL_T / 2 + 14;
		r.drawRect(cam, dx + n.x * matOff, dy + n.y * matOff, {
			w: n.x !== 0 ? 22 : TOWN.DOOR_W - 24,
			h: n.x !== 0 ? TOWN.DOOR_W - 24 : 22,
			color: COLORS.doormat,
			cornerRadius: 3,
			zIndex: Z.floorDetail + 1,
		});
		if (roofA <= 0.01) return true;
		const roof = s.roofColor ?? COLORS.roofGray;
		const shades = this.roofShadesOf(s, roof);
		const sun = this.shadow(cx, cy, 1);
		if (isHouse) {
			// gable: the slope that faces the light is the roof's own colour, the other one is in shade
			const d = alongX ? sun.y : sun.x;
			const first = d > 0.25 ? shades[0] : d < -0.25 ? shades[2] : shades[1];
			const second = d > 0.25 ? shades[2] : d < -0.25 ? shades[0] : shades[1];
			if (alongX) {
				this.tileRect(r, cam, s.x, s.y, s.w, s.h / 2, v, roofTex, roofId, Z.roof, first, roofA);
				this.tileRect(r, cam, s.x, cy, s.w, s.h / 2, v, roofTex, roofId, Z.roof, second, roofA);
			} else {
				this.tileRect(r, cam, s.x, s.y, s.w / 2, s.h, v, roofTex, roofId, Z.roof, first, roofA);
				this.tileRect(r, cam, cx, s.y, s.w / 2, s.h, v, roofTex, roofId, Z.roof, second, roofA);
			}
			// ridge cap along the long axis: half-lit, with a dark edge on both sides
			r.drawRect(cam, cx, cy, {
				w: alongX ? s.w - 8 : 12,
				h: alongX ? 12 : s.h - 8,
				color: shades[1],
				alpha: roofA,
				stroke: shades[3],
				strokeThickness: 2,
				strokeAlpha: roofA,
				zIndex: Z.roof + 1,
			});
			// a brick chimney on most houses, on the ridge, a quarter along it
			const hc = hash01(s.x, s.y, 61);
			const chimney = artId("chimney");
			if (hc < 0.7) {
				const k = hc < 0.35 ? -0.28 : 0.28;
				const chx = alongX ? cx + s.w * k : cx + 22;
				const chy = alongX ? cy - 22 : cy + s.h * k;
				if (chimney !== undefined) {
					const o = artOpts(chimney, 32, 32, Z.roof + 2);
					o.alpha = roofA;
					r.drawRect(cam, chx, chy, o);
				} else {
					r.drawRect(cam, chx, chy, {
						w: 28,
						h: 28,
						color: CHIMNEY,
						alpha: roofA,
						stroke: BLACK,
						strokeAlpha: 0.5 * roofA,
						strokeThickness: 2,
						zIndex: Z.roof + 2,
					});
				}
			}
			const eaves = artId("eaves");
			if (eaves !== undefined) {
				const o = sliced(artOpts(eaves, s.w, s.h, Z.roof + 2), "eaves", WORLD_TEXEL);
				o.alpha = roofA;
				r.drawRect(cam, cx, cy, o);
			}
		} else {
			this.tileRect(r, cam, s.x, s.y, s.w, s.h, v, roofTex, roofId, Z.roof, roof, roofA);
			// the parapet facing the light throws a band of shadow onto the roof (LUZ-01): along the axis the light
			// mostly comes from, one sprite
			const inset = 12;
			if (math.abs(sun.y) >= math.abs(sun.x)) {
				const bh = 16 * math.abs(sun.y);
				const by = sun.y > 0 ? s.y + inset + bh / 2 : s.y + s.h - inset - bh / 2;
				r.drawRect(cam, cx, by, {
					w: s.w - inset * 2,
					h: bh,
					color: BLACK,
					alpha: 0.2 * roofA,
					zIndex: Z.roof + 1,
				});
			} else {
				const bw = 16 * math.abs(sun.x);
				const bx = sun.x > 0 ? s.x + inset + bw / 2 : s.x + s.w - inset - bw / 2;
				r.drawRect(cam, bx, cy, {
					w: bw,
					h: s.h - inset * 2,
					color: BLACK,
					alpha: 0.2 * roofA,
					zIndex: Z.roof + 1,
				});
			}
			this.drawRoofUnits(r, cam, s, cx, cy, roofA);
			const parapet = artId("parapet");
			if (parapet !== undefined) {
				const o = sliced(artOpts(parapet, s.w, s.h, Z.roof + 2), "parapet", WORLD_TEXEL);
				o.alpha = roofA;
				r.drawRect(cam, cx, cy, o);
			}
		}
		// darker eave over the doorway: the entrance reads from above
		const ex = dx + n.x * (TOWN.WALL_T / 2 - 6);
		const ey = dy + n.y * (TOWN.WALL_T / 2 - 6);
		r.drawRect(cam, ex, ey, {
			w: n.x !== 0 ? 12 : TOWN.DOOR_W,
			h: n.x !== 0 ? TOWN.DOOR_W : 12,
			color: shades[3],
			alpha: roofA,
			zIndex: Z.roof + 2,
		});
		this.drawSignage(r, cam, v, s, roofA);
		return true;
	}

	/**
	 * An air conditioner and a vent on a flat roof, one at each end of its back half: the front, over the entrance,
	 * is where the storefront sign stands (client/view/buildingSigns.ts), and a hospital's middle is its helipad.
	 * One sprite each.
	 */
	private drawRoofUnits(r: Renderer, cam: Camera, s: Solid, cx: number, cy: number, a: number): void {
		const ac = artId("acUnit");
		const vent = artId("vent");
		const h = hash01(s.x, s.y, 71);
		// which end of the back the air conditioner takes, picked by the building
		const flip = h < 0.5 ? 1 : -1;
		// the entrance wall's outward normal (nx, ny): the units go the other way
		const side = s.doorSide;
		const nx = side === "left" ? -1 : side === "right" ? 1 : 0;
		const ny = nx !== 0 ? 0 : side === "top" ? -1 : 1;
		const alongX = ny !== 0;
		for (const k of SIDES) {
			const big = k < 0;
			const id = big ? ac : vent;
			if (id === undefined) continue;
			if (!big && h > 0.85) continue;
			const size = artSize(big ? "acUnit" : "vent");
			const along = k * flip * (alongX ? s.w : s.h) * (0.26 + 0.06 * hash01(s.x, s.y + k, 72));
			const back = (alongX ? s.h : s.w) * (0.24 + 0.06 * hash01(s.x + k, s.y, 73));
			const ux = alongX ? cx + along : cx - nx * back;
			const uy = alongX ? cy - ny * back : cy + along;
			const o = artOpts(id, size.w * WORLD_TEXEL, size.h * WORLD_TEXEL, Z.roof + 1);
			o.alpha = a;
			r.drawRect(cam, ux, uy, o);
		}
	}

	private drawWallArt(r: Renderer, cam: Camera, s: Solid): boolean {
		const id = artId("wall");
		if (id === undefined) return false;
		const o = artOpts(id, s.w, s.h, Z.structure);
		const size = artSize("wall");
		o.scaleType = "tile";
		o.tileW = size.w * WORLD_TEXEL;
		o.tileH = size.h * WORLD_TEXEL;
		o.imageTint = COLORS.wallHouse;
		o.stroke = COLORS.wallWood;
		o.strokeThickness = 1;
		o.strokeAlpha = 0.8;
		r.drawRect(cam, s.x + s.w / 2, s.y + s.h / 2, o);
		return true;
	}

	private drawBorderArt(r: Renderer, cam: Camera, s: Solid, v: ViewRect): boolean {
		const id = artId("forest");
		if (id === undefined) return false;
		this.tileRect(r, cam, s.x, s.y, s.w, s.h, v, "forest", id, Z.structure, undefined, 1);
		const horizontal = s.w > s.h;
		const fenceName: WorldArtName = horizontal ? "fenceH" : "fenceV";
		const fence = artId(fenceName);
		const f = 8;
		let fx = s.x;
		let fy = s.y;
		let fw = s.w;
		let fh = s.h;
		if (horizontal) {
			fh = f;
			fy = s.y === 0 ? s.y + s.h - f : s.y;
		} else {
			fw = f;
			fx = s.x === 0 ? s.x + s.w - f : s.x;
		}
		if (fence !== undefined) {
			this.tileRect(r, cam, fx, fy, fw, fh, v, fenceName, fence, Z.structure + 1, undefined, 1);
		} else {
			drawClipped(r, cam, fx, fy, fw, fh, v, { color: COLORS.fence, zIndex: Z.structure + 1 });
		}
		return true;
	}

	/**
	 * A tree: a pixel-art crown (one of three shapes, tinted with the tree's own green) with its light and shadow,
	 * the crown's silhouette as its shadow on the ground, and the trunk. The crown keeps VEG-04's see-through
	 * (`canopyAlpha`, eased by the loop while an actor is under it).
	 */
	private drawTreeArt(r: Renderer, cam: Camera, s: Solid, v: ViewRect): boolean {
		const k = math.floor(hash01(s.x, s.y, 13) * CANOPY_STYLES) % CANOPY_STYLES;
		const mask = artId(CANOPY_MASK[k]);
		if (mask === undefined) return false;
		const sh = this.shake(s);
		const cx = s.x + s.w / 2 + sh.x;
		const cy = s.y + s.h / 2 + sh.y;
		const rad = s.canopyR ?? 80;
		if (!circleInView(cx, cy, rad + 48, v)) return true;
		const a = s.canopyAlpha ?? 1;
		const d = rad * 2;
		const so = this.shadow(cx, cy, 34);
		const shadow = artOpts(mask, d, d, Z.shadow);
		shadow.imageTint = BLACK;
		shadow.alpha = 0.26;
		r.drawRect(cam, cx + so.x, cy + so.y, shadow);
		r.drawCircle(cam, cx, cy, s.w, {
			color: COLORS.treeTrunk,
			stroke: COLORS.treeTrunk.Lerp(BLACK, 0.4),
			strokeThickness: 2,
			zIndex: Z.structure,
		});
		const crown = artOpts(mask, d, d, Z.canopy);
		crown.imageTint = s.tint ?? COLORS.treeLeaf;
		crown.alpha = a;
		r.drawRect(cam, cx, cy, crown);
		const shade = artId(CANOPY_SHADE[k]);
		if (shade !== undefined) {
			const o = artOpts(shade, d, d, Z.canopy + 1);
			o.alpha = a;
			r.drawRect(cam, cx, cy, o);
		}
		return true;
	}

	/**
	 * A car: one of four body styles (tinted with the car's own paint, VEI-04) with glass, lights and wheels, a
	 * soft shadow, and what a few days did to it. Parked cars are mostly intact (a few broken into, a very few
	 * burnt); the ones abandoned askew in a lane (VEI-03, already few) stand with the driver's door open, most with
	 * the windshield smashed or burnt out, some with dried blood by the door (APO-01).
	 */
	private drawCarArt(r: Renderer, cam: Camera, s: Solid): boolean {
		const style = math.floor(hash01(s.x, s.y, 21) * CAR_STYLES) % CAR_STYLES;
		const mask = artId(CAR_MASK[style]);
		const trim = artId(CAR_TRIM[style]);
		if (mask === undefined || trim === undefined) return false;
		const askew = isAskew(s);
		const roll = hash01(s.x, s.y, 23);
		let state = CAR_INTACT;
		let door = false;
		if (askew) {
			door = roll >= 0.3;
			state = roll < 0.3 ? CAR_BURNT : roll < 0.75 ? CAR_BROKEN : CAR_INTACT;
		} else if (roll < 0.02) {
			state = CAR_BURNT;
		} else if (roll < 0.08) {
			state = CAR_BROKEN;
		}
		const wreck = artId(CAR_WRECK[style]);
		const damage = artId(CAR_DAMAGE[style]);
		if (state === CAR_BURNT && wreck === undefined) state = CAR_BROKEN;
		if (state === CAR_BROKEN && damage === undefined) state = CAR_INTACT;
		const sh = this.shake(s);
		const cx = s.x + s.w / 2 + sh.x;
		const cy = s.y + s.h / 2 + sh.y;
		const vertical = s.h > s.w;
		const heading = s.heading;
		const L = heading !== undefined ? TOWN.CAR_L : vertical ? s.h : s.w;
		const W = heading !== undefined ? TOWN.CAR_W : vertical ? s.w : s.h;
		const a = heading ?? (vertical ? math.pi / 2 : 0);
		const paint = state === CAR_BURNT ? BURNT : (s.tint ?? COLORS.car);
		const so = this.shadow(cx, cy, 12);
		const sb = artId("shadowBox");
		if (sb !== undefined) {
			const o = sliced(artOpts(sb, L + 14, W + 14, Z.shadow), "shadowBox", 2);
			o.rotation = a;
			o.alpha = 0.42;
			r.drawRect(cam, cx + so.x, cy + so.y, o);
		} else {
			part(r, cam, cx + so.x, cy + so.y, a, 0, 0, {
				w: L,
				h: W,
				color: BLACK,
				alpha: 0.35,
				cornerRadius: 18,
				zIndex: Z.shadow,
			});
		}
		if (askew && state !== CAR_INTACT && hash01(s.x, s.y, 25) < 0.5) {
			const blood = artId(BLOOD[math.floor(hash01(s.x, s.y, 26) * 2) % 2]);
			if (blood !== undefined) {
				const o = artOpts(blood, 64, 48, Z.decal);
				part(r, cam, cx, cy, a, L * 0.05, -W / 2 - 34, o);
			}
		}
		const body = artOpts(mask, L, W, Z.structure);
		body.imageTint = paint;
		part(r, cam, cx, cy, a, 0, 0, body);
		part(
			r,
			cam,
			cx,
			cy,
			a,
			0,
			0,
			artOpts(state === CAR_BURNT && wreck !== undefined ? wreck : trim, L, W, Z.structure + 1),
		);
		if (state === CAR_BROKEN && damage !== undefined) {
			part(r, cam, cx, cy, a, 0, 0, artOpts(damage, L, W, Z.structure + 2));
		}
		if (door) {
			// the driver's door (left, -lat), hinged at its front edge and swung out ~55°
			const hingeF = L * 0.1;
			const hingeL = -W / 2 + 3;
			const open = 0.95;
			const len = 46;
			const df = -math.cos(open);
			const dl = -math.sin(open);
			part(r, cam, cx, cy, a, hingeF - len / 2, hingeL + 5, {
				w: len - 6,
				h: 8,
				color: DOOR_GAP,
				zIndex: Z.structure + 2,
			});
			const fx = math.cos(a);
			const fy = math.sin(a);
			const pf = hingeF + (df * len) / 2;
			const pl = hingeL + (dl * len) / 2;
			r.drawRect(cam, cx + fx * pf - fy * pl, cy + fy * pf + fx * pl, {
				w: len,
				h: 8,
				rotation: a + math.atan2(dl, df),
				color: paint,
				stroke: BLACK,
				strokeAlpha: 0.6,
				strokeThickness: 1.5,
				zIndex: Z.structure + 3,
			});
		}
		return true;
	}

	/** a wheelie bin with its soft shadow; half of them have spilled some litter beside them (flat, MOB-03) */
	private drawTrashArt(r: Renderer, cam: Camera, s: Solid): boolean {
		const id = artId("bin");
		if (id === undefined) return false;
		const sh = this.shake(s);
		const cx = s.x + s.w / 2 + sh.x;
		const cy = s.y + s.h / 2 + sh.y;
		const h = hash01(s.x, s.y, 31);
		if (h < 0.5) {
			const litter = artId(LITTER[math.floor(hash01(s.x, s.y, 32) * 3) % 3]);
			if (litter !== undefined) {
				const side = h < 0.25 ? -1 : 1;
				const along = hash01(s.x, s.y, 33) < 0.5;
				r.drawRect(
					cam,
					s.x + s.w / 2 + (along ? side * 38 : 6),
					s.y + s.h / 2 + (along ? 6 : side * 38),
					artOpts(litter, 48, 48, Z.decal),
				);
			}
		}
		const sb = artId("shadowBox");
		const so = this.shadow(cx, cy, 8);
		if (sb !== undefined) {
			const o = sliced(artOpts(sb, s.w + 8, s.h + 8, Z.shadow), "shadowBox", 1.5);
			o.alpha = 0.4;
			r.drawRect(cam, cx + so.x, cy + so.y, o);
		}
		r.drawRect(cam, cx, cy, artOpts(id, s.w, s.h, Z.structure));
		return true;
	}

	/** a pump island: the raised concrete curb, two dispensers, and the oil the forecourt collected */
	private drawPumpArt(r: Renderer, cam: Camera, s: Solid): boolean {
		const id = artId("pump");
		if (id === undefined) return false;
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const horizontal = s.w >= s.h;
		const oil = artId(OIL[math.floor(hash01(s.x, s.y, 81) * 2) % 2]);
		if (oil !== undefined) {
			const o = artOpts(oil, 64, 48, Z.decal);
			o.rotation = horizontal ? 0 : math.pi / 2;
			r.drawRect(cam, cx + (horizontal ? -30 : 64), cy + (horizontal ? 60 : -30), o);
		}
		const so = this.shadow(cx, cy, 10);
		const sb = artId("shadowBox");
		if (sb !== undefined) {
			const o = sliced(artOpts(sb, s.w + 10, s.h + 10, Z.shadow), "shadowBox", 1.5);
			o.alpha = 0.4;
			r.drawRect(cam, cx + so.x, cy + so.y, o);
		}
		r.drawRect(cam, cx, cy, {
			w: s.w,
			h: s.h,
			color: GROUND.island,
			cornerRadius: 8,
			stroke: COLORS.curb,
			strokeThickness: 2,
			zIndex: Z.structure,
		});
		for (const k of SIDES) {
			const off = (horizontal ? s.w : s.h) * 0.25 * k;
			const o = artOpts(id, 32, 24, Z.structure + 1);
			o.rotation = horizontal ? 0 : math.pi / 2;
			r.drawRect(cam, cx + (horizontal ? off : 0), cy + (horizontal ? 0 : off), o);
		}
		return true;
	}
}
