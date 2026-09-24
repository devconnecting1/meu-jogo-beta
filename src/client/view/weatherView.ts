/*
 * What the weather looks like (docs/DESIGN_RULES.md LUZ-05). The weather itself is the server's (the Clock delta's
 * byte, shared/sim/weather.ts); this view only draws what the client's clock derives from it:
 *
 *   FOG      a second LightMap (shared/engine/renderer.ts), in the fog's pale grey, under the night's: clear around the
 *            survivor up to FOG_CLEAR_R and thickening to FOG_FULL_R, FOG_SCREEN_MAX × density opaque past it -- the
 *            night's own strips and gradients with one "light", the survivor, so the Graphics tier (High / Low / Auto)
 *            and its cost rules hold exactly as they do for the night (tools/test-light.mjs §7). What the fog covers
 *            is what the horde cannot see either (FOG_SIGHT_CUT); the awareness marks, the nameplates and the prompts
 *            sit above it (LEG-03).
 *   RAIN     streaks falling across the view, anchored in the WORLD (they stay put as the camera pans), a storm's
 *            longer, faster and slanted by the wind; under the night's overlay like everything in the street. With
 *            Reduce Motion there are none -- the wet streets, the darker sky and the HUD's icon say it rains.
 *   PUDDLES  on the asphalt, where water gathers (mostly the gutters), filling while it rains and drying for a while
 *            after (`wet`). Pixel art on the town's 4-u texel (tools/gen-world-art.mjs `puddle`, PUDDLE_ART): four
 *            shapes -- two long gutter ones, two lane ones -- picked by the puddle's place, each with its stepped shore,
 *            its dark water, the sky's streaks, a 1-texel lit rim on the light side and a 1-texel halo of wet ground,
 *            and each mirrored on its diagonal for a vertical road (a turn by 90° would put the lit rim on the right);
 *            laid on the texel grid, so its texels are the asphalt's. While it rains, drops land on them: a ring of 4
 *            texels (`puddleDrop`) that sits still and moves to another spot of the water on a beat -- and does not
 *            move at all with Reduce Motion; none on the Low tier. Without the textures' ids (before the CI's
 *            upload-art) the flat drawing stands in: a capsule, its small pool, the sky's sheen and single texel dots
 *            for the drops. Placed once per town from its roads, deterministically.
 *
 * Everything is drawn through the world renderer's pool, at its own ZIndex (Z.wet, Z.rain), with this view's option
 * tables reused frame after frame: no Instance once the pool is warm (client/view/poolWarmup.ts `weatherPool`, the art
 * or the flat look), no table per sprite (tools/test-pool.mjs §14). The lightning is not drawn here: it lifts the
 * night's own overlay (gameLoop drawLight, `FLASH_LIFT`), which is what makes it light the town rather than whiten
 * the screen.
 */
import { COLORS, Z } from "shared/engine/colors";
import { Camera, ViewRect } from "shared/engine/camera";
import { LightMap, LightSource, Renderer, SpriteOpts } from "shared/engine/renderer";
import { Rect, WorldData } from "shared/game/world";
import { FOG_CLEAR_R, FOG_FULL_R, FOG_SCREEN_MAX, weatherHash } from "shared/sim/weather";
import { artId, artSize } from "./worldArt";
import { WORLD_TEXEL, WorldArtName } from "./worldArtAssets";

/**
 * One puddle: the rectangle of its texture (x, y the centre, w x h in u, its top-left corner on the texel grid), which
 * of the four shapes, its road's direction and its drops' beat.
 */
export interface Puddle {
	x: number;
	y: number;
	w: number;
	h: number;
	/** PUDDLE_ART's index: 0, 1 in a gutter, 2, 3 in a lane */
	variant: number;
	/** the long axis runs along x (a horizontal road); a vertical road's puddle is the `V` texture */
	alongX: boolean;
	/** 0..1: this puddle's place in the drops' beat (they do not all move at once) */
	phase: number;
}

/** the puddles' textures along x (tools/gen-world-art.mjs `puddle`), and the same shapes for a vertical road */
export const PUDDLE_ART: ReadonlyArray<WorldArtName> = ["puddle0", "puddle1", "puddle2", "puddle3"];
export const PUDDLE_ART_V: ReadonlyArray<WorldArtName> = ["puddle0V", "puddle1V", "puddle2V", "puddle3V"];
/** the puddles are drawn from their textures (their ids are uploaded and fetched): poolWarmup reserves for that look */
export function puddleArtLive(): boolean {
	return artId(PUDDLE_ART[0]) !== undefined;
}

/** a lobed shape's small pool: at the right end (1), the left (-1) or none (the flat drawing's satellite) */
const PUDDLE_LOBE = [0, 1, 0, -1];
/**
 * Where drops land on each shape: the texel (along, across) of a ring's centre in the texture along x, four per shape,
 * each ring and the texels round it on the water (tools/test-world-art.mjs §6 reads the PNGs). A vertical road's
 * texture is the same picture mirrored on its diagonal: (across, along).
 */
export const PUDDLE_DROPS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
	[
		[7, 6],
		[15, 4],
		[22, 6],
		[32, 6],
	],
	[
		[4, 4],
		[8, 5],
		[12, 4],
		[16, 4],
	],
	[
		[5, 8],
		[9, 5],
		[13, 7],
		[16, 6],
	],
	[
		[4, 5],
		[14, 9],
		[18, 4],
		[25, 6],
	],
];

/** seconds for the rain on screen to come and go (a new day's rain starts at midnight: it eases in, not pops) */
const RAIN_EASE_S = 4;
/** seconds the streets take to fill while it rains, and to dry once it stopped ("shortly after") */
const WET_FILL_S = 30;
const WET_DRY_S = 150;

/** streaks on a 1920 x 1080 view (scaled by the view's area, never above it): rain, storm; the Low tier halves them */
const STREAKS_RAIN = 72;
const STREAKS_STORM = 96;
/** streaks: length (u), fall speed (u/s), the wind's slant (radians off straight down), opacity */
const STREAK_LEN = 30;
const STREAK_LEN_STORM = 44;
const STREAK_FALL = 900;
const STREAK_FALL_STORM = 1350;
const STREAK_SLANT = 0.18;
const STREAK_SLANT_STORM = 0.42;
const STREAK_ALPHA = 0.55;
const STREAK_ALPHA_STORM = 0.62;
const STREAK_W = 2;
const REF_AREA = 1920 * 1080;

/** the flat puddle (no texture id): how dark the water and how bright the sheen at full wet */
const PUDDLE_ALPHA = 0.5;
const SHEEN_ALPHA = 0.3;
/** drops: two per puddle, each moving to another of its spots every DROP_HOP_S (never with Reduce Motion) */
const DROPS_PER_PUDDLE = 2;
const DROP_HOP_S = 0.55;
const DROP_ALPHA = 0.85;
/** a ring is 3 x 3 texels; the flat look's drop is one texel */
const DROP_RING = 3;

/** puddle placement along a road: the first one this far in, then every PUDDLE_STEP + a hashed extra */
const PUDDLE_START = 150;
const PUDDLE_STEP = 170;
const PUDDLE_STEP_VAR = 230;
const PUDDLE_CHANCE = 0.7;
/** kept this far off a junction's box and a zebra crossing: a crossing is where feet go, not where a puddle is drawn */
const PUDDLE_CLEAR = 24;

function overlaps(ax: number, ay: number, aw: number, ah: number, b: Rect, pad: number): boolean {
	return (
		ax - aw / 2 < b.x + b.w + pad &&
		ax + aw / 2 > b.x - pad &&
		ay - ah / 2 < b.y + b.h + pad &&
		ay + ah / 2 > b.y - pad
	);
}

/**
 * The town's puddles, from its roads: along each one, at hashed steps, most in a gutter (along a curb, where the water
 * runs), some in a lane (a dip in the asphalt), never on a junction, a zebra crossing or an avenue's median; the shape
 * picked by the place (a gutter's or a lane's two), the texture laid on the texel grid. Deterministic (the same town,
 * the same puddles on every screen) and made once per town.
 */
export function puddlesOf(world: WorldData): Array<Puddle> {
	const out = new Array<Puddle>();
	for (let i = 0; i < world.roads.size(); i++) {
		const road = world.roads[i];
		const alongLen = road.vertical ? road.h : road.w;
		const across = road.vertical ? road.w : road.h;
		let pos = PUDDLE_START + weatherHash(i + 1, 0, 17) * PUDDLE_STEP;
		for (let k = 1; pos < alongLen - PUDDLE_START && k < 400; k++) {
			const h = (salt: number): number => weatherHash(i + 1, k, salt);
			if (h(1) < PUDDLE_CHANCE) {
				const gutter = h(2) < 0.65;
				const side = h(3) < 0.5 ? -1 : 1;
				// the shape: one of the gutter's two or the lane's two, by where it lies
				const px = math.floor(road.vertical ? road.x + road.w / 2 : road.x + pos);
				const py = math.floor(road.vertical ? road.y + pos : road.y + road.h / 2);
				const variant = (gutter ? 0 : 2) + (weatherHash(px, py, 19) < 0.5 ? 0 : 1);
				const size = artSize(PUDDLE_ART[variant]);
				const len = size.w * WORLD_TEXEL;
				const wid = size.h * WORLD_TEXEL;
				const off = gutter ? side * (across / 2 - 14 - wid / 2) : side * across * (0.08 + 0.26 * h(6));
				const w = road.vertical ? wid : len;
				const hh = road.vertical ? len : wid;
				// its top-left corner on the texel grid: the puddle's texels are the asphalt's (drawAsphaltSheet)
				const left = math.floor(
					(road.vertical ? road.x + road.w / 2 + off - w / 2 : road.x + pos - w / 2) / WORLD_TEXEL + 0.5,
				);
				const top = math.floor(
					(road.vertical ? road.y + pos - hh / 2 : road.y + road.h / 2 + off - hh / 2) / WORLD_TEXEL + 0.5,
				);
				const cx = left * WORLD_TEXEL + w / 2;
				const cy = top * WORLD_TEXEL + hh / 2;
				let free = true;
				for (const j of world.junctions) {
					if (overlaps(cx, cy, w, hh, j, PUDDLE_CLEAR)) {
						free = false;
						break;
					}
				}
				if (free) {
					for (const c of world.crossings) {
						if (overlaps(cx, cy, w, hh, c, PUDDLE_CLEAR)) {
							free = false;
							break;
						}
					}
				}
				if (free) {
					for (const m of road.medians) {
						if (overlaps(cx, cy, w, hh, m, 8)) {
							free = false;
							break;
						}
					}
				}
				if (free) {
					out.push({ x: cx, y: cy, w, h: hh, variant, alongX: !road.vertical, phase: h(10) });
				}
			}
			pos += PUDDLE_STEP + h(11) * PUDDLE_STEP_VAR;
		}
	}
	return out;
}

/** what the drawers need from the frame: the clock (s), Reduce Motion and the Graphics tier */
export interface WeatherFrame {
	clock: number;
	reduceMotion: boolean;
	low: boolean;
}

export class WeatherView {
	/** how hard it rains on screen now (0..1), eased (a rain that starts at midnight comes in over RAIN_EASE_S) */
	rain = 0;
	/** how wet the streets are (0..1): fills while it rains, dries for WET_DRY_S after */
	wet = 0;
	/** the rain on screen is a storm's (longer, faster, slanted streaks) */
	storm = false;
	private settled = false;
	private puddles?: Array<Puddle>;
	private puddlesFor?: WorldData;
	private fogMap?: LightMap;
	private readonly fogLights: Array<LightSource> = [{ x: 0, y: 0, r: FOG_FULL_R, inner: FOG_CLEAR_R / FOG_FULL_R }];
	/** the option tables the drawers refill (the renderer reads them and keeps nothing) */
	private readonly art: SpriteOpts = { zIndex: Z.wet };
	private readonly drop: SpriteOpts = { zIndex: Z.wet };
	private readonly water: SpriteOpts = { color: COLORS.puddle, zIndex: Z.wet, circle: true };
	private readonly sheen: SpriteOpts = { color: COLORS.puddleSheen, zIndex: Z.wet, circle: true };
	private readonly streak: SpriteOpts = { color: COLORS.rainStreak, zIndex: Z.rain, h: STREAK_W };

	/**
	 * One frame of the weather's own easing (`dt` real seconds). The first call of a view settles at once: a survivor
	 * who joins in the middle of a rain sees wet streets, not streets filling up.
	 */
	step(dt: number, raining: boolean, storm: boolean): void {
		const target = raining ? 1 : 0;
		if (!this.settled) {
			this.settled = true;
			this.rain = target;
			this.wet = target;
			this.storm = storm;
			return;
		}
		const t = math.max(0, dt);
		if (this.rain < target) this.rain = math.min(target, this.rain + t / RAIN_EASE_S);
		else if (this.rain > target) this.rain = math.max(target, this.rain - t / RAIN_EASE_S);
		if (raining) this.wet = math.min(1, this.wet + t / WET_FILL_S);
		else this.wet = math.max(0, this.wet - t / WET_DRY_S);
		// the storm's look follows the sky it falls from; while the rain eases out it keeps the one it had
		if (raining) this.storm = storm;
	}

	/** a new run or a new town: the next step settles again, and the puddles are placed for the new streets */
	reset(): void {
		this.settled = false;
		this.rain = 0;
		this.wet = 0;
		this.puddles = undefined;
		this.puddlesFor = undefined;
	}

	/**
	 * The puddles of the streets in view (Z.wet), as wet as the streets are: each its texture (or the flat drawing), and
	 * while it rains its drops -- still, moving on a beat, not at all with Reduce Motion, none on the Low tier.
	 */
	drawPuddles(r: Renderer, cam: Camera, v: ViewRect, world: WorldData, f: WeatherFrame): void {
		const wet = this.wet;
		if (wet <= 0.02) return;
		if (this.puddlesFor !== world || this.puddles === undefined) {
			this.puddles = puddlesOf(world);
			this.puddlesFor = world;
		}
		// quantised: a street drying over minutes rewrites its puddles a few dozen times, not every frame
		const k = math.floor(wet * 16 + 0.5) / 16;
		const drops = this.rain > 0.2 && !f.low;
		const dropAlpha = DROP_ALPHA * k * (math.floor(this.rain * 8 + 0.5) / 8);
		const ringId = artId("puddleDrop");
		const art = this.art;
		const drop = this.drop;
		if (ringId !== undefined) {
			drop.image = ringId;
			drop.color = undefined;
			drop.w = DROP_RING * WORLD_TEXEL;
			drop.h = DROP_RING * WORLD_TEXEL;
		} else {
			drop.image = undefined;
			drop.color = COLORS.puddleRipple;
			drop.w = WORLD_TEXEL;
			drop.h = WORLD_TEXEL;
		}
		drop.alpha = dropAlpha;
		for (const p of this.puddles) {
			const hw = p.w / 2;
			const hh = p.h / 2;
			if (p.x + hw < v.minX || p.x - hw > v.maxX || p.y + hh < v.minY || p.y - hh > v.maxY) continue;
			const id = artId(p.alongX ? PUDDLE_ART[p.variant] : PUDDLE_ART_V[p.variant]);
			if (id !== undefined) {
				art.image = id;
				art.w = p.w;
				art.h = p.h;
				art.alpha = k;
				r.drawRect(cam, p.x, p.y, art);
			} else {
				this.drawFlat(r, cam, p, k, f.low);
			}
			if (!drops) continue;
			const spots = PUDDLE_DROPS[p.variant];
			const n = spots.size();
			for (let j = 0; j < DROPS_PER_PUDDLE; j++) {
				// the beat: each puddle on its own, the second drop half a beat after the first; with Reduce Motion
				// the drops keep the spots they have (a still ring on the water, the rain said without motion)
				const beat = f.reduceMotion
					? math.floor(p.phase * 8)
					: math.floor(f.clock / DROP_HOP_S + p.phase * 8 + j * 0.5);
				// four spots, a step of 3 and the second drop 2 further: the two never share one
				const s = spots[(beat * 3 + j * 2) % n];
				const tx = p.alongX ? s[0] : s[1];
				const ty = p.alongX ? s[1] : s[0];
				r.drawRect(cam, p.x - hw + (tx + 0.5) * WORLD_TEXEL, p.y - hh + (ty + 0.5) * WORLD_TEXEL, drop);
			}
		}
	}

	/**
	 * A puddle without its texture: a capsule of water inside the texture's halo, the small pool of a lobed shape a gap
	 * apart (translucent sprites never overlap: an overlap would be a darker blot), and the sky's sheen along the
	 * upper-left rim, where the town's light comes from (ART-02); no sheen on the Low tier.
	 */
	private drawFlat(r: Renderer, cam: Camera, p: Puddle, k: number, low: boolean): void {
		const water = this.water;
		const len = (p.alongX ? p.w : p.h) - 2 * WORLD_TEXEL;
		const across = (p.alongX ? p.h : p.w) - 2 * WORLD_TEXEL;
		const lobe = PUDDLE_LOBE[p.variant];
		const main = lobe !== 0 ? len * 0.7 : len;
		const shift = -lobe * (len - main) * 0.5;
		water.alpha = PUDDLE_ALPHA * k;
		water.w = p.alongX ? main : across;
		water.h = p.alongX ? across : main;
		r.drawRect(cam, p.alongX ? p.x + shift : p.x, p.alongX ? p.y : p.y + shift, water);
		if (lobe !== 0) {
			const sat = len * 0.2;
			const at = lobe * (len / 2 - sat / 2);
			water.w = p.alongX ? sat : across * 0.6;
			water.h = p.alongX ? across * 0.6 : sat;
			r.drawRect(cam, p.alongX ? p.x + at : p.x, p.alongX ? p.y : p.y + at, water);
		}
		if (low) return;
		const sheen = this.sheen;
		sheen.alpha = SHEEN_ALPHA * k;
		sheen.w = p.alongX ? main * 0.62 : math.max(3, across * 0.2);
		sheen.h = p.alongX ? math.max(3, across * 0.2) : main * 0.62;
		r.drawRect(
			cam,
			p.alongX ? p.x + shift - main * 0.08 : p.x - across * 0.26,
			p.alongX ? p.y - across * 0.26 : p.y + shift - main * 0.08,
			sheen,
		);
	}

	/** the rain's streaks over the town (Z.rain); none with Reduce Motion, half on the Low tier */
	drawRain(r: Renderer, cam: Camera, v: ViewRect, f: WeatherFrame): void {
		const rain = this.rain;
		if (rain <= 0.02 || f.reduceMotion) return;
		const storm = this.storm;
		const W = v.maxX - v.minX;
		const H = v.maxY - v.minY;
		if (!(W > 0 && H > 0)) return;
		const area = math.min(1, (W * H * cam.zoom * cam.zoom) / REF_AREA);
		let n = math.ceil((storm ? STREAKS_STORM : STREAKS_RAIN) * math.max(0.25, area) * rain);
		if (f.low) n = math.ceil(n / 2);
		const len = storm ? STREAK_LEN_STORM : STREAK_LEN;
		const fall = storm ? STREAK_FALL_STORM : STREAK_FALL;
		const slant = storm ? STREAK_SLANT_STORM : STREAK_SLANT;
		const dx = math.sin(slant);
		const dy = math.cos(slant);
		const o = this.streak;
		o.alpha = (storm ? STREAK_ALPHA_STORM : STREAK_ALPHA) * math.min(1, rain * 1.5);
		// one angle for every streak, set as such: an angle taken back out of two endpoints (drawSegment) wobbles in its
		// last bits with the position, and every streak would rewrite its Rotation every frame
		o.w = len;
		o.h = STREAK_W;
		o.rotation = math.atan2(dy, dx);
		for (let i = 0; i < n; i++) {
			const speed = fall * (0.8 + 0.4 * weatherHash(i + 1, 3, 29));
			// anchored in the world: a streak keeps its place as the camera pans, and wraps round the view's edges
			const ax = weatherHash(i + 1, 1, 29) * W + dx * speed * f.clock;
			const ay = weatherHash(i + 1, 2, 29) * H + dy * speed * f.clock;
			const x = v.minX + ((((ax - v.minX) % W) + W) % W);
			const y = v.minY + ((((ay - v.minY) % H) + H) % H);
			r.drawRect(cam, x + dx * len * 0.5, y + dy * len * 0.5, o);
		}
	}

	/**
	 * The fog over the town, thickening with distance from (x, y) -- the survivor -- in `parent` (the night's layer, one
	 * ZIndex under the night's own map). `fog` is the clock's density; `low` the Graphics tier.
	 */
	drawFog(parent: GuiObject, cam: Camera, fog: number, x: number, y: number, low: boolean): void {
		const opacity = FOG_SCREEN_MAX * math.clamp(fog, 0, 1);
		if (opacity <= 0.004) {
			this.fogMap?.hide();
			return;
		}
		let map = this.fogMap;
		if (map === undefined) {
			map = new LightMap(parent, COLORS.overlayFog);
			map.layer.Name = "FogMap";
			// under the night's map (ZIndex 1): the fog is in the street, the night falls over it
			map.layer.ZIndex = 0;
			this.fogMap = map;
		}
		map.setLowDetail(low);
		const clear = this.fogLights[0];
		clear.x = x;
		clear.y = y;
		map.update(cam, opacity, this.fogLights);
	}

	/** the fog map's cost card (the admin panel, tools/test-light.mjs), undefined before any fog */
	fogLayer(): LightMap | undefined {
		return this.fogMap;
	}

	hide(): void {
		this.fogMap?.hide();
	}
}
