/*
 * The town on screen: ground, roads, crosswalks, buildings (floor, roof, signage), walls, the map border,
 * trees, cars, a gas station's pump islands, canopy and price sign, bins and the structures players build --
 * everything that stands still in the world.
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
import type { FloorKind } from "shared/game/interiors";
import { SIGN_ART } from "shared/data/buildingSigns";
import { TREE_SPECIES, treeLook, treeSpecies } from "shared/data/trees";
import {
	DoorSide,
	GroundRect,
	hash01,
	Lot,
	PUMP_CAR_FILLING,
	PUMP_CAR_GAP,
	PUMP_DISPENSER_AT,
	PUMP_ISLAND_D,
	PUMP_ISLAND_L,
	queryParts,
	queryTown,
	Rect,
	Road,
	Solid,
	WorldData,
} from "shared/game/world";
import { drawBuildingSign, drawPriceSign } from "./buildingSigns";
import { drawParkedVehicle } from "./vehicleView";
import {
	drawBankRoof,
	drawPortico,
	drawTownCanopy,
	drawTownGround,
	drawTownProp,
	drawVaultDoor,
	vaultDoorSolid,
} from "./townView";
import { circleInView, overlaps, part, SIDES } from "./drawKit";
import { FLOOR_FLAT, InteriorView } from "./interiorView";
import { artId, artSize, artSlice } from "./worldArt";
import { WORLD_TEXEL, WorldArtName } from "./worldArtAssets";
import { TREE_BAND_H, TREE_CELLS, TREE_TRUNK_CELL } from "./treeAtlas";

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
	porch: COLORS.floorWood.Lerp(COLORS.furnDark, 0.2),
	patio: COLORS.sidewalk.Lerp(WHITE, 0.06),
	zebra: WHITE.Lerp(COLORS.road, 0.12),
	lane: WHITE.Lerp(COLORS.road, 0.3),
	island: COLORS.sidewalk.Lerp(WHITE, 0.2),
	/** a pump island's noses: the safety paint where a bumper hits first */
	nose: COLORS.uiYellow.Lerp(COLORS.curb, 0.3),
};

// ------------------------------------------------------------------ a gas station's forecourt (EDI-16)

/** a dispenser: the white body, the red stripe and the dark (unlit) display of the station's own sign (EDI-03) */
const PUMP_BODY = SIGN_ART.W;
const PUMP_STRIPE = SIGN_ART.r;
const PUMP_INK = SIGN_ART.k;
const PUMP_DISPLAY = SIGN_ART.d;
/**
 * A dispenser stands upright on its island, like a sign on its parapet (ART-07): its foot this far below its spot on
 * the island (in the island's near half), its cabinet rising above it on screen. Flat: 28 x 40; art: its texture.
 */
const PUMP_FOOT = 16;
const PUMP_FLAT_W = 28;
const PUMP_FLAT_H = 40;
/** the canopy's steel column, standing between the two dispensers of each island (off-centre on an island along y,
 * where the upright cabinets leave the gap) */
const COLUMN = COLORS.metal;
const COLUMN_EDGE = COLUMN.Lerp(BLACK, 0.55);
const COLUMN_SIZE = 14;
const COLUMN_OFF_V = -12;
/**
 * The canopy (EDI-16): round its pale steel deck a fascia in the storefront sign's charcoal with the red pinstripe of
 * its pump (EDI-03: the station's colours, no text, no brand), the colours of its texture (tools/gen-world-art.mjs
 * `gasCanopy`, the ones the flat drawing uses without an id).
 */
const CANOPY_DECK = COLORS.wallShop.Lerp(WHITE, 0.32);
const CANOPY_FASCIA_BODY = SIGN_ART.x;
const CANOPY_OUTLINE = SIGN_ART.k;
const CANOPY_STRIPE = SIGN_ART.r;
const CANOPY_GUTTER = CANOPY_DECK.Lerp(BLACK, 0.3);
const CANOPY_SEAM = CANOPY_DECK.Lerp(BLACK, 0.16);
const CANOPY_DRAIN = Color3.fromRGB(58, 60, 66);
/** the fascia's depth: the outline, its face, the pinstripe and its body (4 texels) */
const CANOPY_FASCIA = 16;
/** the flat drawing's seams: the texture's first ridge (texel 9) and every second panel (12 texels) */
const CANOPY_SEAM0 = 36;
const CANOPY_SEAM_PITCH = 48;
/** the columns' drains, in canopy space: along the street from the canopy's end (symmetric), and from the street eave */
const CANOPY_DRAINS: ReadonlyArray<number> = [111, 341];
const CANOPY_COLUMN_V = 44;
/** the roof's texture for each side its street is on */
const CANOPY_ART: Record<DoorSide, WorldArtName> = {
	top: "gasCanopyN",
	bottom: "gasCanopyS",
	left: "gasCanopyW",
	right: "gasCanopyE",
};
/** how high the canopy stands, as the length of its shadow (a building's is 20-30, a tree's 18-34) */
const CANOPY_LIFT = 44;
/** the pump's hose and nozzle, left in the tank of a car abandoned mid-fill */
const HOSE = Color3.fromRGB(30, 30, 34);

/** the campus quad's fountain, statue and benches (EDI-17): stone, water, weathered bronze, iron */
const PROP = {
	stone: COLORS.sidewalk.Lerp(WHITE, 0.28),
	water: COLORS.glassCold.Lerp(COLORS.roofBlue, 0.45),
	ripple: COLORS.glassCold.Lerp(WHITE, 0.5),
	bronze: COLORS.treeLeafDark.Lerp(COLORS.metal, 0.45),
	iron: COLORS.metalDark,
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
/** a porch deck is the house's floor boards, weathered */
const PORCH_TINT = Color3.fromRGB(214, 206, 196);
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
/**
 * A shrub's crown (VEG-06): lower than a person, so under every body (a survivor beside a shrub stands over its
 * leaves; it never hides a zombie, LEG-03), over the ground and the trunks' layer's shadows; its light one layer up.
 */
const Z_SHRUB = Z.structure;
/** the named textures, typed once (template strings would allocate a string per car per frame) */
const CAR_MASK: Array<WorldArtName> = ["car0", "car1", "car2", "car3"];
const CAR_TRIM: Array<WorldArtName> = ["carTrim0", "carTrim1", "carTrim2", "carTrim3"];
const CAR_DAMAGE: Array<WorldArtName> = ["carDamage0", "carDamage1", "carDamage2", "carDamage3"];
const CAR_WRECK: Array<WorldArtName> = ["carWreck0", "carWreck1", "carWreck2", "carWreck3"];
const LITTER: Array<WorldArtName> = ["litter0", "litter1", "litter2"];
const BLOOD: Array<WorldArtName> = ["blood0", "blood1"];
const OIL: Array<WorldArtName> = ["oil0", "oil1"];
const CRACK: Array<WorldArtName> = ["crack0", "crack1"];
/** the texture of each interior floor, and the tint that keeps a borrowed one in its room's colour */
const FLOOR_ART: Record<FloorKind, WorldArtName> = {
	wood: "floorWood",
	tile: "floorTile",
	shop: "floorShop",
	carpet: "floorCarpet",
	kitchen: "floorKitchen",
	bath: "floorBath",
	concrete: "concrete",
};
/** half the width of a flat roof's seam cover: the parapet's rim (4 texels), the flat drawing's stroke (3 px) */
const SEAM_RIM_ART = 16;
const SEAM_RIM_FLAT = 4;
/** a back room's concrete floor: the sidewalk's concrete texture, darkened to COLORS.floorConcrete (test:world-art §6) */
export const CONCRETE_FLOOR_TINT = Color3.fromRGB(214, 214, 212);
/**
 * A tree's crown -- and a gas station's canopy and price pylon (EDI-16) -- while a body stands under it: the opacity
 * the loop eases it to (gameLoop `updateCanopy`, VEG-04; the original obj_tree1 fades near the player).
 */
export const CANOPY_SEE_THROUGH = 0.35;
/**
 * The same fade for a gas station's canopy and price pylon (EDI-16), opened further: a crown is small and full of
 * gaps and a body crosses it, a canopy is one sheet over exactly where the survivor stands to drain a pump and the
 * horde closes in. At the crown's 0.35 the characters' art lost a fifth of its outline contrast under it (LEG-03,
 * test:world-art §5: walker 49 -> 38, survivor 40 -> 32 ΔE); at this it keeps the open-ground bars, and the fascia
 * still outlines the canopy.
 */
export const SHELTER_SEE_THROUGH = 0.15;

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
	o.rectX = undefined;
	o.rectY = undefined;
	o.rectW = undefined;
	o.rectH = undefined;
	return o;
}

/** `artOpts` for one square cell of an atlas: its corner (x, y) and side `n`, in texels */
function cellOpts(id: string, w: number, h: number, z: number, x: number, y: number, n: number): SpriteOpts {
	const o = artOpts(id, w, h, z);
	o.rectX = x;
	o.rectY = y;
	o.rectW = n;
	o.rectH = n;
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

/**
 * A point of a gas station's canopy (EDI-16) by canopy space: `u` along its street from its low end, `v` from its
 * street eave (`Solid.face`: the side its street is on). One scratch point, read at once.
 */
const CANOPY_SPOT = { x: 0, y: 0 };
function canopySpot(s: Solid, u: number, v: number): { x: number; y: number } {
	const face = s.face ?? "top";
	if (face === "top" || face === "bottom") {
		CANOPY_SPOT.x = s.x + u;
		CANOPY_SPOT.y = face === "top" ? s.y + v : s.y + s.h - v;
	} else {
		CANOPY_SPOT.y = s.y + u;
		CANOPY_SPOT.x = face === "left" ? s.x + v : s.x + s.w - v;
	}
	return CANOPY_SPOT;
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

/** draws an electric build where it stands, or answers false (client/view/machinesView.ts, ELE-01..08) */
export interface MachineDrawer {
	draw(r: Renderer, cam: Camera, s: Solid): boolean;
}

export class WorldView {
	/** the owner's animation clock (seconds): a struck solid's shake, a lamp's flicker */
	clock = 0;
	/** the player asked for reduced motion (client/ui/skin.ts `reducedMotion`, set by the loop): struck solids hold still */
	reduceMotion = false;
	/** the electric builds' own drawing (the match's view sets it; the lobby's town has no builds) */
	machines?: MachineDrawer;
	private readonly queryBuf: Array<Solid> = [];
	private readonly shadow: ShadowFn;
	/** a pitched roof's colour in full sun, half light and shade (built once per building, not per frame) */
	private readonly roofShades = new Map<Solid, Array<Color3>>();
	private shadesFor?: WorldData;
	/** furniture, decoration, openings, entrance marks (client/view/interiorView.ts) */
	readonly interior = new InteriorView();
	/** a building without parts is one part: itself (reused, never allocated per frame) */
	private readonly onePart: Array<Rect> = [];
	/** the seams of each compound flat roof, flat and art drawing (`seamsOf`), per world */
	private readonly seamsFlat = new Map<Solid, Array<Rect>>();
	private readonly seamsArt = new Map<Solid, Array<Rect>>();

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
		// the everyday town's own ground (the bank's steps, a court, a sand pit...): ./townView.ts, both drawings
		if (drawTownGround(r, cam, g, v)) return;
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
		else if (k === "porch") color = GROUND.porch;
		else if (k === "patio") color = GROUND.patio;
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
		// pad: canopies reach ~90 px past the trunk, shadows ~20 px past their caster. The town first, without the
		// buildings' own walls and furniture (queryTown); those only while a roof in view is lifted, below -- the
		// same solids in the same order as one querySolids, minus the parts no open roof shows (review of ea5cf71)
		const x0 = v.minX - 140;
		const y0 = v.minY - 140;
		const x1 = v.maxX + 140;
		const y1 = v.maxY + 140;
		queryTown(world, x0, y0, x1, y1, list);
		this.interior.useWorld(world);
		let open = false;
		if (world !== this.shadesFor) {
			this.roofShades.clear();
			this.seamsFlat.clear();
			this.seamsArt.clear();
			this.shadesFor = world;
		}
		for (const s of list) {
			if (s.kind === "building") {
				// the art culls on its own (its shadow reaches further); the flat drawing keeps its old margin
				if (!this.drawBuildingArt(r, cam, s, v) && overlaps(s.x - 30, s.y - 30, s.w + 60, s.h + 60, v)) {
					this.drawBuilding(r, cam, s, v);
				}
				this.drawSignage(r, cam, v, s);
				if (!this.interior.roofOpaque(s)) open = true;
			} else if (s.tags === "border") {
				if (!this.drawBorderArt(r, cam, s, v)) this.drawBorder(r, cam, s, v);
			} else if (s.kind === "tree") {
				if (!this.drawTreeArt(r, cam, s, v)) this.drawTree(r, cam, s, v);
			} else if (s.kind === "canopy") {
				// a gas station's canopy (EDI-16): culled on its own (its shadow reaches further than its rect); the
				// bank's portico and the everyday town's other roofs on posts: ./townView.ts
				if (s.tags === "portico") drawPortico(r, cam, s, v, this.shadow, this.clock);
				else if (!drawTownCanopy(r, cam, s, v, this.shadow)) this.drawCanopy(r, cam, s, v);
			} else if (s.tags === "gas_sign") {
				// its footing, and the price pylon standing on it (upright: it reaches past the footing's rect)
				this.drawGasSign(r, cam, s, v);
			} else if (s.tags === "pump") {
				// the oil stains lie in the lanes beside the island: it culls on its own
				this.drawPump(r, cam, s, v);
			} else if (overlaps(s.x - 16, s.y - 16, s.w + 32, s.h + 32, v)) {
				if (s.tags === "bwall") {
					if (!this.drawWallArt(r, cam, s)) this.drawWall(r, cam, s);
				} else if (s.kind === "car" && s.tags === "trash") {
					if (!this.drawTrashArt(r, cam, s)) this.drawTrash(r, cam, s);
				} else if (s.kind === "car") {
					if (!this.drawCarArt(r, cam, s)) this.drawCar(r, cam, s);
				} else if (s.tags === "vehicle") {
					// a parked bicycle or motorcycle (VEI-05): drawn by the same code as a ridden one
					const so = this.shadow(s.x + s.w / 2, s.y + s.h / 2, 6);
					drawParkedVehicle(r, cam, s, so.x, so.y);
				} else if (s.kind === "prop") {
					// the everyday town's fixtures first (./townView.ts), the campus quad's here
					if (!drawTownProp(r, cam, s, world, this.shadow)) this.drawProp(r, cam, s);
				} else if (vaultDoorSolid(s)) {
					// the bank's vault door (EDI-24): a steel slab, not a built door
					drawVaultDoor(r, cam, s, world);
				} else if (this.machines === undefined || !this.machines.draw(r, cam, s)) {
					this.drawStructure(r, cam, s);
				}
			}
		}
		// a building's walls, windows and furniture: nothing to draw under a roof that is on, so with every roof in
		// view on (a survivor out in the street) the parts are not even looked up
		if (!open) return;
		list.clear();
		queryParts(world, x0, y0, x1, y1, list);
		for (const s of list) {
			if (s.kind === "window") continue;
			const home = this.interior.parentOf(world, s);
			if (this.interior.roofOpaque(home)) continue;
			if (!overlaps(s.x - 16, s.y - 16, s.w + 32, s.h + 32, v)) continue;
			const bt = home?.buildingType ?? 1;
			const house = bt === 1 || bt === 2;
			if (s.kind === "furniture") {
				this.interior.drawFurniture(r, cam, s, bt);
			} else if (!this.interior.drawWallArt(r, cam, s, house) && !this.drawWallArt(r, cam, s, house)) {
				this.interior.drawWall(r, cam, s, house);
			}
		}
	}

	private shake(s: Solid): { x: number; y: number } {
		const t = s.hitShake ?? 0;
		// Reduce Motion (BEM-08): the struck solid holds still; its flinch still counts down (solidFlinch.ts), and the
		// hit still reads by what does not move -- the debris, the drop, the sound
		if (t <= 0 || this.reduceMotion) return { x: 0, y: 0 };
		const amp = 4 * math.min(1, t / 0.25);
		return { x: math.sin(this.clock * 70) * amp, y: math.cos(this.clock * 55) * amp * 0.6 };
	}

	/** the rects of a building's footprint: its parts, or the record itself when it has none */
	private partsOf(s: Solid): Array<Rect> {
		const parts = s.parts;
		if (parts !== undefined) return parts;
		this.onePart[0] = s;
		return this.onePart;
	}

	/**
	 * Where two parts of a flat roof meet: one roof, not two buildings side by side, so the rims drawn along the
	 * seam are covered, `rim` short of each end (the outer rim runs on across it). Built once per building.
	 */
	private seamsOf(s: Solid, rim: number): Array<Rect> {
		const key = rim === SEAM_RIM_ART ? this.seamsArt : this.seamsFlat;
		const cached = key.get(s);
		if (cached !== undefined) return cached;
		const out: Array<Rect> = [];
		const parts = s.parts ?? [];
		for (let i = 0; i < parts.size(); i++) {
			for (let j = i + 1; j < parts.size(); j++) {
				const a = parts[i];
				const b = parts[j];
				const x = math.abs(a.x + a.w - b.x) < 0.5 ? b.x : math.abs(b.x + b.w - a.x) < 0.5 ? a.x : undefined;
				if (x !== undefined) {
					const y0 = math.max(a.y, b.y) + rim;
					const y1 = math.min(a.y + a.h, b.y + b.h) - rim;
					if (y1 > y0) out.push({ x: x - rim, y: y0, w: rim * 2, h: y1 - y0 });
				}
				const y = math.abs(a.y + a.h - b.y) < 0.5 ? b.y : math.abs(b.y + b.h - a.y) < 0.5 ? a.y : undefined;
				if (y !== undefined) {
					const x0 = math.max(a.x, b.x) + rim;
					const x1 = math.min(a.x + a.w, b.x + b.w) - rim;
					if (x1 > x0) out.push({ x: x0, y: y - rim, w: x1 - x0, h: rim * 2 });
				}
			}
		}
		key.set(s, out);
		return out;
	}

	/**
	 * The inside of a building whose roof is not on (the survivor is in it, or it is fading): each room's floor,
	 * the decoration, and the frames of the doorways and windows. A building without rooms (a test's plain box) keeps
	 * the old single floor in its type's colour.
	 */
	private drawInterior(r: Renderer, cam: Camera, s: Solid, v: ViewRect, art: boolean): void {
		const rooms = s.rooms;
		if (rooms === undefined) {
			const bt = s.buildingType ?? 1;
			const isHouse = bt === 1 || bt === 2;
			r.drawRect(cam, s.x + s.w / 2, s.y + s.h / 2, {
				w: s.w,
				h: s.h,
				color: isHouse ? COLORS.floorWood : bt === 4 || bt === 6 ? COLORS.floorTile : COLORS.floorShop,
				stroke: BLACK,
				strokeAlpha: 0.25,
				strokeThickness: 2,
				zIndex: Z.floor,
			});
			return;
		}
		for (const q of rooms) {
			if (!overlaps(q.x, q.y, q.w, q.h, v)) continue;
			const name = FLOOR_ART[q.floor];
			const id = art ? artId(name) : undefined;
			if (id !== undefined) {
				const tint = q.floor === "concrete" ? CONCRETE_FLOOR_TINT : undefined;
				this.tileRect(r, cam, q.x, q.y, q.w, q.h, v, name, id, Z.floor, tint, 1);
				continue;
			}
			drawClipped(r, cam, q.x, q.y, q.w, q.h, v, { color: FLOOR_FLAT[q.floor], zIndex: Z.floor });
		}
		this.interior.drawDecor(r, cam, s, v);
		this.interior.drawOpenings(r, cam, s, v);
	}

	/** the old single doormat and eave, for a building record without openings (tests' plain boxes) */
	private drawPlainEntrance(r: Renderer, cam: Camera, s: Solid, roofA: number, eave: Color3): void {
		const n = sideNormal(s.doorSide);
		const dx = s.doorX ?? s.x + s.w / 2;
		const dy = s.doorY ?? s.y + s.h;
		if (roofA < 0) {
			const matOff = TOWN.WALL_T / 2 + 14;
			r.drawRect(cam, dx + n.x * matOff, dy + n.y * matOff, {
				w: n.x !== 0 ? 22 : TOWN.DOOR_W - 24,
				h: n.x !== 0 ? TOWN.DOOR_W - 24 : 22,
				color: COLORS.doormat,
				cornerRadius: 3,
				zIndex: Z.floorDetail,
			});
			return;
		}
		const ex = dx + n.x * (TOWN.WALL_T / 2 - 6);
		const ey = dy + n.y * (TOWN.WALL_T / 2 - 6);
		r.drawRect(cam, ex, ey, {
			w: n.x !== 0 ? 12 : TOWN.DOOR_W,
			h: n.x !== 0 ? TOWN.DOOR_W : 12,
			color: eave,
			alpha: roofA,
			zIndex: Z.roof + 1,
		});
	}

	private drawBuilding(r: Renderer, cam: Camera, s: Solid, v: ViewRect): void {
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const roofA = s.roofAlpha ?? 1;
		const bt = s.buildingType ?? 1;
		const isHouse = bt === 1 || bt === 2;
		const parts = this.partsOf(s);
		// building shadow (the roof's, like the original: 0.3 * roof_alpha), one per part of the footprint
		const so = this.shadow(cx, cy, 20);
		const shX = so.x;
		const shY = so.y;
		for (const p of parts) {
			if (!overlaps(p.x + shX, p.y + shY, p.w, p.h, v)) continue;
			r.drawRect(cam, p.x + p.w / 2 + shX, p.y + p.h / 2 + shY, {
				w: p.w,
				h: p.h,
				color: BLACK,
				alpha: 0.3 * math.max(roofA, 0.4),
				zIndex: Z.shadow,
			});
		}
		// the inside, only while the roof is not on (a closed roof covers the whole footprint)
		if (!this.interior.roofOpaque(s)) this.drawInterior(r, cam, s, v, false);
		// doormats outside every door, and the glass under every broken window (EDI-18): read with the roof closed
		if (s.openings !== undefined) {
			this.interior.drawDoormats(r, cam, s, v, undefined);
			this.interior.drawWindowShards(r, cam, s, v);
		} else {
			this.drawPlainEntrance(r, cam, s, -1, BLACK);
		}
		if (roofA <= 0.01) return;
		const roof = s.roofColor ?? COLORS.roofGray;
		const roofDark = roof.Lerp(BLACK, 0.3);
		for (const p of parts) {
			const px = p.x + p.w / 2;
			const py = p.y + p.h / 2;
			r.drawRect(cam, px, py, {
				w: p.w,
				h: p.h,
				color: roof,
				alpha: roofA,
				stroke: roofDark,
				strokeThickness: 3,
				strokeAlpha: roofA,
				zIndex: Z.roof,
			});
			if (isHouse) {
				// a ridge along each wing's long axis: an L-shaped house reads as two gables meeting
				const alongX = p.w >= p.h;
				r.drawRect(cam, px, py, {
					w: alongX ? math.max(12, p.w - 80) : 12,
					h: alongX ? 12 : math.max(12, p.h - 80),
					color: roofDark,
					alpha: roofA * 0.8,
					zIndex: Z.roof + 1,
				});
			}
		}
		if (!isHouse) {
			// one flat roof over the whole footprint: the parts' strokes along the seams are covered
			for (const q of this.seamsOf(s, SEAM_RIM_FLAT)) {
				r.drawRect(cam, q.x + q.w / 2, q.y + q.h / 2, {
					w: q.w,
					h: q.h,
					color: roof,
					alpha: roofA,
					zIndex: Z.roof + 1,
				});
			}
		}
		const wing = s.mainWing ?? s;
		const wx = wing.x + wing.w / 2;
		const wy = wing.y + wing.h / 2;
		if (!isHouse) {
			// flat roof: a/c box on the main wing
			r.drawRect(cam, wx + wing.w * 0.22, wy - wing.h * 0.2, {
				w: 90,
				h: 70,
				color: roof.Lerp(WHITE, 0.25),
				alpha: roofA,
				stroke: roofDark,
				strokeAlpha: roofA,
				zIndex: Z.roof + 1,
			});
		}
		// darker eaves over the doorways and dark glass over the windows: the entrances read from above
		const eave = roofDark.Lerp(BLACK, 0.3);
		if (s.openings !== undefined) this.interior.drawRoofMarks(r, cam, s, roofA, eave, v);
		else this.drawPlainEntrance(r, cam, s, roofA, eave);
	}

	/**
	 * How the building says what it is (client/view/buildingSigns.ts, DESIGN_RULES EDI-03, ART-07): the storefront
	 * sign beside the main entrance and, on a hospital, the helipad. The ONE hook of the signage, shared by the flat
	 * and the art drawing and by the menus' flyover: it hands the sign the building's type, its main entrance (where,
	 * and in which wall) and the roof rect the sign stands on. A building of several wings and entrances
	 * (shared/game/interiors.ts) hands its MAIN entrance (`doorX`/`doorY`/`doorSide`: the one facing the street) and
	 * its main wing (`Solid.mainWing`: the part behind the stretch of facade that holds that door, so the sign stays
	 * on that facade -- in a porch or a school's entrance court too -- and the helipad on that wing's roof). Called
	 * once per building per frame, from `drawSolids`, for the flat and the art drawing alike. Nothing else here knows
	 * a sign exists.
	 */
	private drawSignage(r: Renderer, cam: Camera, v: ViewRect, s: Solid): void {
		const a = s.roofAlpha ?? 1;
		if (a <= 0.01) return;
		drawBuildingSign(
			r,
			cam,
			v,
			s.buildingType ?? 1,
			s.doorX ?? s.x + s.w / 2,
			s.doorY ?? s.y + s.h,
			s.doorSide ?? "bottom",
			s.mainWing ?? s,
			a,
			this.shadow,
		);
		// the bank's stone parapet and the laylight over its hall (EDI-24, ./townView.ts)
		if (s.buildingType === 22) drawBankRoof(r, cam, v, s, a);
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

	/**
	 * Gas-station pump island (EDI-16): a raised concrete curb with its safety-painted noses, two dispensers standing
	 * upright in the colours of the station's sign -- white, the dark display, the red stripe (EDI-03: the pumps look
	 * like the sign says) -- and the canopy's column between them. Each part falls back on its own (ART-01): the soft
	 * shadow and the oil the forecourt collected in both lanes (a hash of the island) with their textures, the
	 * dispensers as the `dispenser` sprite once it has an id and as Frames until then; the curb, its noses and the
	 * column are Frames either way. With no id at all, the very calls of the flat drawing.
	 */
	private drawPump(r: Renderer, cam: Camera, s: Solid, v: ViewRect): void {
		// the stains lie in the lanes beside the island, further out than the island's own margin
		if (!overlaps(s.x - 96, s.y - 96, s.w + 192, s.h + 192, v)) return;
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const horizontal = s.w >= s.h;
		const along = horizontal ? s.w : s.h;
		for (const k of SIDES) {
			// a stain in each lane most of the time, somewhere along the island, where a car stood and dripped
			const salt = k < 0 ? 81 : 82;
			if (hash01(s.x, s.y, salt) >= 0.8) continue;
			const oil = artId(OIL[math.floor(hash01(s.x, s.y, salt + 10) * 2) % 2]);
			if (oil === undefined) continue;
			const u = (hash01(s.x, s.y, salt + 20) - 0.5) * along * 0.6;
			const w = k * (PUMP_ISLAND_D / 2 + 44);
			const o = artOpts(oil, 64, 48, Z.decal);
			o.rotation = horizontal ? 0 : math.pi / 2;
			r.drawRect(cam, cx + (horizontal ? u : w), cy + (horizontal ? w : u), o);
		}
		if (!overlaps(s.x - 16, s.y - 16, s.w + 32, s.h + 32, v)) return;
		const sb = artId("shadowBox");
		if (sb !== undefined) {
			const so = this.shadow(cx, cy, 10);
			const o = sliced(artOpts(sb, s.w + 10, s.h + 10, Z.shadow), "shadowBox", 1.5);
			o.alpha = 0.4;
			r.drawRect(cam, cx + so.x, cy + so.y, o);
		} else {
			const so = this.shadow(cx, cy, 8);
			r.drawRect(cam, cx + so.x, cy + so.y, {
				w: s.w,
				h: s.h,
				color: BLACK,
				alpha: 0.3,
				cornerRadius: 8,
				zIndex: Z.shadow,
			});
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
		this.drawIslandKit(r, cam, s);
		const art = artId("dispenser");
		const size = artSize("dispenser");
		for (const k of SIDES) {
			const off = along * PUMP_DISPENSER_AT * k;
			// upright, never rotated: the cabinet rises from its foot, the display near its top, the red stripe below it
			const dx = cx + (horizontal ? off : 0);
			const foot = cy + (horizontal ? 0 : off) + PUMP_FOOT;
			if (art !== undefined) {
				const ph = size.h * WORLD_TEXEL;
				r.drawRect(cam, dx, foot - ph / 2, artOpts(art, size.w * WORLD_TEXEL, ph, Z.structure + 3));
				continue;
			}
			r.drawRect(cam, dx, foot - PUMP_FLAT_H / 2, {
				w: PUMP_FLAT_W,
				h: PUMP_FLAT_H,
				color: PUMP_BODY,
				cornerRadius: 3,
				stroke: PUMP_INK,
				strokeThickness: 1,
				zIndex: Z.structure + 3,
			});
			r.drawRect(cam, dx - 3, foot - PUMP_FLAT_H + 11, {
				w: 16,
				h: 10,
				color: PUMP_DISPLAY,
				zIndex: Z.structure + 4,
			});
			r.drawRect(cam, dx, foot - PUMP_FLAT_H * 0.4, {
				w: PUMP_FLAT_W,
				h: 5,
				color: PUMP_STRIPE,
				zIndex: Z.structure + 4,
			});
		}
	}

	/** the noses of a pump island and the canopy's column on it: flat Frames in the flat and the art drawing alike */
	private drawIslandKit(r: Renderer, cam: Camera, s: Solid): void {
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const horizontal = s.w >= s.h;
		const along = horizontal ? s.w : s.h;
		const across = horizontal ? s.h : s.w;
		for (const k of SIDES) {
			const off = (along / 2 - 8) * k;
			r.drawRect(cam, cx + (horizontal ? off : 0), cy + (horizontal ? 0 : off), {
				w: horizontal ? 8 : across - 8,
				h: horizontal ? across - 8 : 8,
				color: GROUND.nose,
				cornerRadius: 3,
				zIndex: Z.structure + 1,
			});
		}
		r.drawRect(cam, cx, cy + (horizontal ? 0 : COLUMN_OFF_V), {
			w: COLUMN_SIZE,
			h: COLUMN_SIZE,
			color: COLUMN,
			stroke: COLUMN_EDGE,
			strokeThickness: 1,
			zIndex: Z.structure + 2,
		});
	}

	/**
	 * A gas station's canopy (EDI-16): a flat roof on a column per island, over the islands and the eave of a pump car's
	 * flank, its shadow on the forecourt a canopy's height off. Above the actors like a tree's crown, and see-through
	 * like one while a body is under it (`canopyAlpha`, eased by the loop's `updateCanopy`: VEG-04's fade, LEG-03).
	 * Aerial: nothing collides (COL-02). With its texture (`gasCanopy` + the side its street is on) the roof is ONE
	 * sprite of pixel art; without an id, this: the fascia in the storefront sign's charcoal with the red pinstripe of
	 * its pump, the pale steel deck, a seam every second panel and the drain over each column -- 15 Frames.
	 */
	private drawCanopy(r: Renderer, cam: Camera, s: Solid, v: ViewRect): void {
		if (!overlaps(s.x - 60, s.y - 60, s.w + 120, s.h + 120, v)) return;
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const a = s.canopyAlpha ?? 1;
		const so = this.shadow(cx, cy, CANOPY_LIFT);
		const tex = artId(CANOPY_ART[s.face ?? "top"]);
		const sb = artId("shadowBox");
		if (sb !== undefined) {
			const o = sliced(artOpts(sb, s.w + 16, s.h + 16, Z.shadow), "shadowBox", 3);
			o.alpha = 0.34;
			r.drawRect(cam, cx + so.x, cy + so.y, o);
		} else {
			r.drawRect(cam, cx + so.x, cy + so.y, { w: s.w, h: s.h, color: BLACK, alpha: 0.24, zIndex: Z.shadow });
		}
		if (tex !== undefined) {
			const o = artOpts(tex, s.w, s.h, Z.roof);
			o.alpha = a;
			r.drawRect(cam, cx, cy, o);
			return;
		}
		// the fascia, and its red pinstripe one texel in (a stroke round an empty rect: UIStroke draws outside it)
		const T = WORLD_TEXEL;
		r.drawRect(cam, cx, cy, {
			w: s.w,
			h: s.h,
			color: CANOPY_FASCIA_BODY,
			alpha: a,
			stroke: CANOPY_OUTLINE,
			strokeThickness: 2,
			strokeAlpha: a,
			zIndex: Z.roof,
		});
		r.drawRect(cam, cx, cy, {
			w: s.w - T * 6,
			h: s.h - T * 6,
			color: CANOPY_STRIPE,
			alpha: 0,
			stroke: CANOPY_STRIPE,
			strokeThickness: math.max(1, math.floor(T * cam.zoom + 0.5)),
			strokeAlpha: a,
			zIndex: Z.roof + 1,
		});
		const F = CANOPY_FASCIA;
		r.drawRect(cam, cx, cy, {
			w: s.w - F * 2,
			h: s.h - F * 2,
			color: CANOPY_DECK,
			alpha: a,
			stroke: CANOPY_GUTTER,
			strokeThickness: 2,
			strokeAlpha: a,
			zIndex: Z.roof + 1,
		});
		// a standing seam every second panel, across the canopy (perpendicular to its street)
		const along = s.face === "top" || s.face === "bottom";
		const len = along ? s.w : s.h;
		const deep = (along ? s.h : s.w) - F * 2;
		for (let u = CANOPY_SEAM0; u < len - F; u += CANOPY_SEAM_PITCH) {
			r.drawRect(cam, along ? s.x + u : cx, along ? cy : s.y + u, {
				w: along ? 3 : deep,
				h: along ? deep : 3,
				color: CANOPY_SEAM,
				alpha: a,
				zIndex: Z.roof + 2,
			});
		}
		// the drain over each column: at the islands' middle, CANOPY_COLUMN_V from the street eave
		for (const u of CANOPY_DRAINS) {
			const p = canopySpot(s, u, CANOPY_COLUMN_V);
			r.drawRect(cam, p.x, p.y, {
				w: 14,
				h: 14,
				color: CANOPY_DRAIN,
				alpha: a,
				stroke: CANOPY_GUTTER,
				strokeThickness: 1,
				strokeAlpha: a,
				zIndex: Z.roof + 3,
			});
		}
	}

	/** the price sign's concrete footing, and the pylon on it (client/view/buildingSigns.ts `drawPriceSign`) */
	private drawGasSign(r: Renderer, cam: Camera, s: Solid, v: ViewRect): void {
		if (overlaps(s.x - 16, s.y - 16, s.w + 32, s.h + 32, v)) {
			const cx = s.x + s.w / 2;
			const cy = s.y + s.h / 2;
			const so = this.shadow(cx, cy, 6);
			r.drawRect(cam, cx + so.x, cy + so.y, {
				w: s.w,
				h: s.h,
				color: BLACK,
				alpha: 0.3,
				cornerRadius: 4,
				zIndex: Z.shadow,
			});
			r.drawRect(cam, cx, cy, {
				w: s.w,
				h: s.h,
				color: GROUND.island,
				cornerRadius: 4,
				stroke: COLORS.curb,
				strokeThickness: 2,
				zIndex: Z.structure,
			});
		}
		drawPriceSign(r, cam, v, s, s.canopyAlpha ?? 1, this.shadow);
	}

	/**
	 * What stands on the campus quad (EDI-17), lit from the top left like the town and with its shadow on the sun's
	 * side (LUZ-01): the fountain's stone basin and its water, the founder in weathered bronze on a stone plinth, a
	 * bench of wooden slats on iron ends with its back away from the plaza. Frames only, the same with or without the
	 * town's textures, like a building's furniture (ART-12).
	 */
	private drawProp(r: Renderer, cam: Camera, s: Solid): void {
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const t = s.tags;
		if (t !== "fountain" && t !== "statue") {
			// a bench, flat (ART-01; its pixel art is ART-16's): the slats in their iron ends, the back rest on the side
			// away from where it faces -- two Frames, no shadow: a town holds hundreds of benches (the review of e9b0fbb, L5)
			const n = sideNormal(s.face);
			const horizontal = s.w >= s.h;
			r.drawRect(cam, cx, cy, {
				w: s.w,
				h: s.h,
				color: COLORS.furnWood,
				stroke: PROP.iron,
				strokeThickness: 2,
				zIndex: Z.structure,
			});
			r.drawRect(cam, cx - n.x * (s.w / 2 - 4), cy - n.y * (s.h / 2 - 4), {
				w: horizontal ? s.w - 4 : 5,
				h: horizontal ? 5 : s.h - 4,
				color: COLORS.furnDark,
				zIndex: Z.structure + 1,
			});
			return;
		}
		const so = this.shadow(cx, cy, t === "statue" ? 14 : 6);
		const round = t === "fountain";
		r.drawRect(cam, cx + so.x, cy + so.y, {
			w: s.w,
			h: s.h,
			color: BLACK,
			alpha: 0.3,
			cornerRadius: round ? s.w / 2 : 4,
			zIndex: Z.shadow,
		});
		if (t === "fountain") {
			// the basin's stone rim, the water, the spout's column and the ripple it makes
			r.drawRect(cam, cx, cy, {
				w: s.w,
				h: s.h,
				color: PROP.stone,
				cornerRadius: s.w / 2,
				stroke: PROP.stone.Lerp(BLACK, 0.45),
				strokeThickness: 2,
				zIndex: Z.structure,
			});
			r.drawRect(cam, cx, cy, {
				w: s.w - 16,
				h: s.h - 16,
				color: PROP.water,
				cornerRadius: (s.w - 16) / 2,
				zIndex: Z.structure + 1,
			});
			r.drawRect(cam, cx, cy, {
				w: 28,
				h: 28,
				color: PROP.ripple,
				cornerRadius: 14,
				alpha: 0.6,
				zIndex: Z.structure + 2,
			});
			r.drawRect(cam, cx, cy, { w: 14, h: 14, color: PROP.stone, cornerRadius: 7, zIndex: Z.structure + 3 });
			return;
		}
		if (t === "statue") {
			// the plinth, and the figure on it seen from above: shoulders and a head, verdigris lit from the top left
			r.drawRect(cam, cx, cy, {
				w: s.w,
				h: s.h,
				color: PROP.stone,
				stroke: PROP.stone.Lerp(BLACK, 0.45),
				strokeThickness: 2,
				zIndex: Z.structure,
			});
			r.drawRect(cam, cx, cy + 2, { w: 30, h: 16, color: PROP.bronze, cornerRadius: 6, zIndex: Z.structure + 1 });
			r.drawRect(cam, cx, cy - 2, {
				w: 16,
				h: 16,
				color: PROP.bronze.Lerp(WHITE, 0.2),
				cornerRadius: 8,
				zIndex: Z.structure + 2,
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
		if (s.tags === "solar" || s.tags === "reactor" || s.tags === "oil_generator" || s.tags === "battery") {
			return COLORS.uiBlue;
		}
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
		if (k === "porch") return this.tiled(r, cam, g, v, "floorWood", z, PORCH_TINT);
		if (k === "walk" || k === "patio") return this.tiled(r, cam, g, v, "pavers", z);
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
	 * A building with textured roof, floors and soft shadow, one part of its footprint at a time (an L-shaped house
	 * is two gables meeting, a U-shaped school three membrane roofs). Houses get a gable roof whose sunlit slope is
	 * lighter (which slope follows the sun, LUZ-01) and a chimney; flat roofs a parapet with its shadow on the roof
	 * and rooftop units. The roof keeps the colour that identifies the building type (EDI-03): the texture is grey
	 * and tinted with it. A doorstep marks every entrance. Answers false when the roof texture is not live.
	 */
	private drawBuildingArt(r: Renderer, cam: Camera, s: Solid, v: ViewRect): boolean {
		const bt = s.buildingType ?? 1;
		const isHouse = bt === 1 || bt === 2;
		const flatTex: WorldArtName = bt === 3 || bt === 4 || bt === 5 ? "roofMembrane" : "roofGravel";
		// the texture of a house decides by its box (one check per building); each part picks its own direction
		const roofProbe: WorldArtName = isHouse ? "roofShingleH" : flatTex;
		if (artId(roofProbe) === undefined) return false;
		if (!overlaps(s.x - 60, s.y - 60, s.w + 120, s.h + 120, v)) return true;
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const roofA = s.roofAlpha ?? 1;
		const parts = this.partsOf(s);
		// soft drop shadow, a little longer than the flat one: a building is taller than a car
		const so = this.shadow(cx, cy, 30);
		const shX = so.x;
		const shY = so.y;
		const sb = artId("shadowBox");
		for (const p of parts) {
			const sx = p.x + p.w / 2 + shX;
			const sy = p.y + p.h / 2 + shY;
			if (sb !== undefined) {
				const o = sliced(artOpts(sb, p.w + 16, p.h + 16, Z.shadow), "shadowBox", 3);
				o.alpha = 0.36 * math.max(roofA, 0.4);
				r.drawRect(cam, sx, sy, o);
			} else {
				r.drawRect(cam, sx, sy, {
					w: p.w,
					h: p.h,
					color: BLACK,
					alpha: 0.3 * math.max(roofA, 0.4),
					zIndex: Z.shadow,
				});
			}
		}
		// the rooms' floors, the decoration and the frames (only while the roof is not on)
		if (!this.interior.roofOpaque(s)) this.drawInterior(r, cam, s, v, true);
		// the doorstep and the mat on it, at every door, and the glass under every broken window (EDI-18): the entrances
		// read even with the roof closed
		if (s.openings !== undefined) {
			this.interior.drawDoormats(r, cam, s, v, STEP);
			this.interior.drawWindowShards(r, cam, s, v);
		} else {
			this.drawPlainEntrance(r, cam, s, -1, BLACK);
		}
		if (roofA <= 0.01) return true;
		const roof = s.roofColor ?? COLORS.roofGray;
		const shades = this.roofShadesOf(s, roof);
		const sun = this.shadow(cx, cy, 1);
		const sunX = sun.x;
		const sunY = sun.y;
		const wing = s.mainWing ?? s;
		const wx = wing.x + wing.w / 2;
		const wy = wing.y + wing.h / 2;
		for (const p of parts) {
			const px = p.x + p.w / 2;
			const py = p.y + p.h / 2;
			if (isHouse) {
				// gable: the slope that faces the light is the roof's own colour, the other one is in shade
				const alongX = p.w >= p.h;
				const tex: WorldArtName = alongX ? "roofShingleH" : "roofShingleV";
				const id = artId(tex);
				if (id === undefined) continue;
				const d = alongX ? sunY : sunX;
				const first = d > 0.25 ? shades[0] : d < -0.25 ? shades[2] : shades[1];
				const second = d > 0.25 ? shades[2] : d < -0.25 ? shades[0] : shades[1];
				if (alongX) {
					this.tileRect(r, cam, p.x, p.y, p.w, p.h / 2, v, tex, id, Z.roof, first, roofA);
					this.tileRect(r, cam, p.x, py, p.w, p.h / 2, v, tex, id, Z.roof, second, roofA);
				} else {
					this.tileRect(r, cam, p.x, p.y, p.w / 2, p.h, v, tex, id, Z.roof, first, roofA);
					this.tileRect(r, cam, px, p.y, p.w / 2, p.h, v, tex, id, Z.roof, second, roofA);
				}
				// ridge cap along the wing's long axis: half-lit, with a dark edge on both sides
				r.drawRect(cam, px, py, {
					w: alongX ? p.w - 8 : 12,
					h: alongX ? 12 : p.h - 8,
					color: shades[1],
					alpha: roofA,
					stroke: shades[3],
					strokeThickness: 2,
					strokeAlpha: roofA,
					zIndex: Z.roof + 1,
				});
				const eaves = artId("eaves");
				if (eaves !== undefined) {
					const o = sliced(artOpts(eaves, p.w, p.h, Z.roof + 2), "eaves", WORLD_TEXEL);
					o.alpha = roofA;
					r.drawRect(cam, px, py, o);
				}
			} else {
				const id = artId(flatTex);
				if (id === undefined) continue;
				this.tileRect(r, cam, p.x, p.y, p.w, p.h, v, flatTex, id, Z.roof, roof, roofA);
				// the parapet facing the light throws a band of shadow onto the roof (LUZ-01): along the axis the
				// light mostly comes from, one sprite per part
				const inset = 12;
				if (math.abs(sunY) >= math.abs(sunX)) {
					const bh = 16 * math.abs(sunY);
					const by = sunY > 0 ? p.y + inset + bh / 2 : p.y + p.h - inset - bh / 2;
					r.drawRect(cam, px, by, {
						w: p.w - inset * 2,
						h: bh,
						color: BLACK,
						alpha: 0.2 * roofA,
						zIndex: Z.roof + 1,
					});
				} else {
					const bw = 16 * math.abs(sunX);
					const bx = sunX > 0 ? p.x + inset + bw / 2 : p.x + p.w - inset - bw / 2;
					r.drawRect(cam, bx, py, {
						w: bw,
						h: p.h - inset * 2,
						color: BLACK,
						alpha: 0.2 * roofA,
						zIndex: Z.roof + 1,
					});
				}
				const parapet = artId("parapet");
				if (parapet !== undefined) {
					const o = sliced(artOpts(parapet, p.w, p.h, Z.roof + 2), "parapet", WORLD_TEXEL);
					o.alpha = roofA;
					r.drawRect(cam, px, py, o);
				}
			}
		}
		if (!isHouse) {
			// one flat roof over the whole footprint: the parapets' rims along the seams are covered with roof
			const id = artId(flatTex);
			if (id !== undefined) {
				for (const q of this.seamsOf(s, SEAM_RIM_ART)) {
					this.tileRect(r, cam, q.x, q.y, q.w, q.h, v, flatTex, id, Z.roof + 3, roof, roofA);
				}
			}
		}
		if (isHouse) {
			// a brick chimney on most houses, a quarter along the ridge of the roof part over the main wing
			const hc = hash01(s.x, s.y, 61);
			const chimney = artId("chimney");
			if (hc < 0.7) {
				let gable: Rect = wing;
				for (const p of parts) {
					if (wx >= p.x && wx <= p.x + p.w && wy >= p.y && wy <= p.y + p.h) gable = p;
				}
				const gx = gable.x + gable.w / 2;
				const gy = gable.y + gable.h / 2;
				const alongX = gable.w >= gable.h;
				const k = hc < 0.35 ? -0.28 : 0.28;
				const chx = alongX ? gx + gable.w * k : gx + 22;
				const chy = alongX ? gy - 22 : gy + gable.h * k;
				if (chimney !== undefined) {
					const o = artOpts(chimney, 32, 32, Z.roof + 3);
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
						zIndex: Z.roof + 3,
					});
				}
			}
		} else {
			this.drawRoofUnits(r, cam, wing, s.doorSide, wx, wy, roofA);
		}
		// darker eaves over the doorways and dark glass over the windows: the entrances read from above (with the art, the
		// glass catches the light: EDI-18)
		if (s.openings !== undefined) this.interior.drawRoofMarks(r, cam, s, roofA, shades[3], v, true);
		else this.drawPlainEntrance(r, cam, s, roofA, shades[3]);
		return true;
	}

	/**
	 * An air conditioner and a vent on a flat roof (the main wing `s` of a building whose main entrance is in wall
	 * `side`), one at each end of its back half: the front, over the entrance, is where the storefront sign stands
	 * (client/view/buildingSigns.ts), and a hospital's middle is its helipad. One sprite each.
	 */
	private drawRoofUnits(
		r: Renderer,
		cam: Camera,
		s: Rect,
		side: DoorSide | undefined,
		cx: number,
		cy: number,
		a: number,
	): void {
		const ac = artId("acUnit");
		const vent = artId("vent");
		const h = hash01(s.x, s.y, 71);
		// which end of the back the air conditioner takes, picked by the building
		const flip = h < 0.5 ? 1 : -1;
		// the entrance wall's outward normal (nx, ny): the units go the other way
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

	private drawWallArt(r: Renderer, cam: Camera, s: Solid, house = true): boolean {
		const id = artId("wall");
		if (id === undefined) return false;
		const o = artOpts(id, s.w, s.h, Z.structure);
		const size = artSize("wall");
		o.scaleType = "tile";
		o.tileW = size.w * WORLD_TEXEL;
		o.tileH = size.h * WORLD_TEXEL;
		const base = house ? COLORS.wallHouse : COLORS.wallShop;
		o.imageTint = s.inner === true ? base.Lerp(WHITE, 0.18) : base;
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
	 * A tree (VEG-06): its kind's crown in its own look -- one cell of the trees' atlas (tools/tree-art.mjs), a drawing
	 * lit from the top left and never turned, tinted with the tree's own green, at the tree's own size -- with its
	 * light over it, its silhouette as its shadow on the ground (as long as the kind is tall), and the trunk: the 44 u
	 * collision box, drawn at exactly that size. A crown keeps VEG-04's see-through (`canopyAlpha`, eased by the loop
	 * while a body is under it); a shrub stands lower than a person, so it is drawn under the bodies, never over one,
	 * and shows no trunk. Four sprites a tree (three a shrub), the same as the three crowns before it.
	 */
	private drawTreeArt(r: Renderer, cam: Camera, s: Solid, v: ViewRect): boolean {
		const atlas = artId("trees");
		if (atlas === undefined) return false;
		const kind = math.clamp(treeSpecies(s.variant ?? 0), 0, TREE_SPECIES.size() - 1);
		const sp = TREE_SPECIES[kind];
		const looks = TREE_CELLS[kind];
		const cell = looks[treeLook(s.variant ?? 0) % looks.size()];
		const sh = this.shake(s);
		const cx = s.x + s.w / 2 + sh.x;
		const cy = s.y + s.h / 2 + sh.y;
		const rad = s.canopyR ?? 80;
		if (!circleInView(cx, cy, rad + sp.lift + 8, v)) return true;
		const a = sp.low ? 1 : (s.canopyAlpha ?? 1);
		const d = rad * 2;
		const so = this.shadow(cx, cy, sp.lift);
		const shadow = cellOpts(atlas, d, d, Z.shadow, cell[0], cell[1], cell[2]);
		shadow.imageTint = BLACK;
		shadow.alpha = 0.26;
		r.drawRect(cam, cx + so.x, cy + so.y, shadow);
		if (!sp.low) {
			const trunk = cellOpts(
				atlas,
				s.w,
				s.h,
				Z.structure,
				TREE_TRUNK_CELL[0],
				TREE_TRUNK_CELL[1],
				TREE_TRUNK_CELL[2],
			);
			trunk.imageTint = COLORS.treeTrunk;
			r.drawRect(cam, cx, cy, trunk);
		}
		const z = sp.low ? Z_SHRUB : Z.canopy;
		const crown = cellOpts(atlas, d, d, z, cell[0], cell[1], cell[2]);
		crown.imageTint = s.tint ?? COLORS.treeLeaf;
		crown.alpha = a;
		r.drawRect(cam, cx, cy, crown);
		const shade = cellOpts(atlas, d, d, z + 1, cell[0], cell[1] + TREE_BAND_H, cell[2]);
		shade.alpha = a;
		r.drawRect(cam, cx, cy, shade);
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
		// left at a gas pump mid-fill (EDI-16): the driver ran, the door is open and the nozzle still in the tank
		const filling = s.variant === PUMP_CAR_FILLING;
		let state = CAR_INTACT;
		let door = filling;
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
		if (filling) this.drawHose(r, cam, cx, cy, a, L, W);
		return true;
	}

	/**
	 * The hose of a car left mid-fill at a pump (EDI-16): from the filler on its right rear flank to the dispenser
	 * behind the island's column, the island on the car's right (world.ts `placeGas`: the car stands PUMP_CAR_GAP off
	 * the island's curb, centred on it), and the nozzle in the filler. Two flat Frames, over the car and the island.
	 */
	private drawHose(r: Renderer, cam: Camera, cx: number, cy: number, a: number, L: number, W: number): void {
		const fx = math.cos(a);
		const fy = math.sin(a);
		// the filler, and the near face of the rear dispenser (in the car's frame: forward f, right l)
		const f0 = -L * 0.3;
		const l0 = W / 2 - 2;
		const f1 = -PUMP_ISLAND_L * PUMP_DISPENSER_AT;
		const l1 = W / 2 + PUMP_CAR_GAP + PUMP_ISLAND_D / 2 - 12;
		const df = f1 - f0;
		const dl = l1 - l0;
		const len = math.sqrt(df * df + dl * dl);
		const mf = (f0 + f1) / 2;
		const ml = (l0 + l1) / 2;
		r.drawRect(cam, cx + fx * mf - fy * ml, cy + fy * mf + fx * ml, {
			w: len,
			h: 3,
			rotation: a + math.atan2(dl, df),
			color: HOSE,
			zIndex: Z.structure + 4,
		});
		part(r, cam, cx, cy, a, f0, l0, {
			w: 10,
			h: 6,
			color: HOSE,
			stroke: PUMP_STRIPE,
			strokeThickness: 1,
			zIndex: Z.structure + 4,
		});
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
}
