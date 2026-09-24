/*
 * The electric builds, drawn (docs/DESIGN_RULES.md ELE-09; the pixels are data in shared/data/machineArt.ts).
 *
 *   worldView.drawSolids → draw(r, cam, s)       one machine where it stands: its sprite and what its state shows
 *   gameLoop.render      → drawAir(...)          the drones in the air, the cables, the way home to a beacon
 *   gameLoop.drawLight   → collectLights(out)    a lamp drone's light, where it flies
 *   gameLoop.update      → learn(tracers, ...)   where each turret points, from the shots the server sent
 *
 * What a machine is doing is the SERVER's (server/sim/power.ts), and reaches this client as `PowerSet`
 * (client/systems/powerMirror.ts): working or not, the level of its store, a drone in the air and whom it escorts.
 * Nothing else travels, so the rest is read off what does:
 *   - a turret's head turns to its last shot: the server's `Tracer` leaves its muzzle, so the tracer names the turret
 *     (it starts TURRET_MUZZLE from its centre) and points where it aimed; the muzzle flashes while that tracer burns;
 *   - a drone in the air is beside its survivor at `droneOffset(id, clock)`, the function the server shoots and lights
 *     from, eased from where it was drawn so a launch flies off the pad instead of teleporting;
 *   - a cable runs from each machine to the nearest battery box within POWER_LINK_RANGE — the server's rule, on the
 *     client's copy of the same solids — yellow (LEG-02: electricity) while the box holds charge, grey when it is dry.
 *
 * States (ELE-09): a green status lamp on whatever works, dark red on what does not; a lamp's lens and a cooker's plates
 * glow, the reactor's core breathes, the oil generator smokes and shivers, the beacon's dish turns and its lamp blinks,
 * a pad's ring glows while it charges its drone, a battery box shows its charge in three yellow bars.
 *
 * Flat or art (ART-01): each sprite is one ImageLabel once its texture has an id, and otherwise the few rectangles of
 * its grid (decomposed once, painted in MACHINE_ART_ORDER). Turning parts turn in both. Nothing allocates per frame
 * and the renderer's pool never grows after warm-up.
 */
import { Camera, ViewRect } from "shared/engine/camera";
import { Z } from "shared/engine/colors";
import { LightSource, Renderer, SpriteOpts } from "shared/engine/renderer";
import { MACHINE_ART, MACHINE_ART_ORDER, MACHINE_SPRITES, MACHINE_TEXEL, MachineSprite } from "shared/data/machineArt";
import {
	BEACON_ARROW_FROM,
	BEACON_ARROW_FULL,
	droneOffset,
	LAMP_DRONE_LIGHT,
	linkDist2,
	machineOf,
	Point,
	POWER_LINK_RANGE,
	powerFlying,
	powerLevel,
	powerWorking,
	TURRET_MUZZLE,
} from "shared/data/power";
import { querySolids, Solid, WorldData } from "shared/game/world";
import { SLOT_NONE } from "shared/net/mpConfig";
import { mirroredPower } from "../systems/powerMirror";
import type { Tracer } from "../systems/types";
import { artId } from "./worldArt";
import { WORLD_ART, WorldArtName } from "./worldArtAssets";

/** where the shadow of something at (x, y) falls, for a shadow `len` long (LUZ-01): client/view/worldView.ts ShadowFn */
type ShadowFn = (x: number, y: number, len: number) => { x: number; y: number };

/** the colours the states are drawn in: the town art's (MACHINE_ART) and a few lights of their own */
const INK = MACHINE_ART;
const LED_ON = Color3.fromRGB(96, 214, 104);
const LED_OFF = Color3.fromRGB(112, 34, 34);
const LIT = Color3.fromRGB(255, 244, 170);
const HOT = Color3.fromRGB(244, 112, 44);
const CORE = Color3.fromRGB(120, 232, 150);
const FLASH = Color3.fromRGB(255, 238, 160);
const SMOKE = Color3.fromRGB(150, 150, 156);
const CABLE_DRY = Color3.fromRGB(90, 92, 98);

/** how far off the ground a flying drone is, for its shadow (the pets' eagle uses the same idea) */
const DRONE_SHADOW_LEN = 26;
/** a drone flying home or out eases at this speed (u/s), then locks onto its orbit */
const DRONE_EASE_SPEED = 900;
/** the beacon arrow: this far from the survivor, this long */
const ARROW_RADIUS = 96;
const ARROW_LEN = 22;
/** a sprite's runs stack this many layers at most over its base (`decomposeGrid` keeps to it; test:power §I) */
const MAX_LAYER = 4;
/**
 * Layers: a machine's body at the structures' (Z_BASE .. Z_BASE + MAX_LAYER), its states, glows and turning parts
 * over that (Z_STATE .. Z_TOP, the status lamps on top), all under the zombies (Z.zombie = Z.structure + 10): a walker
 * beside a turret is never under its head. A drone in the air flies over every body.
 */
const Z_BASE = Z.structure;
const Z_STATE = Z.structure + MAX_LAYER + 1;
const Z_TOP = Z_STATE + MAX_LAYER;
const Z_AIR = Z.projectile - 1;
const Z_CABLE = Z.decal;
/** the beacon arrow's two strokes, each this far back from the tip's heading */
const CHEVRON = (145 * math.pi) / 180;

/** one rectangle of a sprite, in texels, and its layer above the sprite's base */
interface Run {
	x: number;
	y: number;
	w: number;
	h: number;
	color: Color3;
	z: number;
}

/** what this client remembers about one machine between frames: its turret's aim and flash, its drone's position */
interface Seen {
	aim: number;
	flash: number;
	/** a drone as last drawn (it eases towards its orbit); undefined = on its pad */
	airX?: number;
	airY?: number;
}

/**
 * The runs of a grid (client/view/buildingSigns.ts's decomposition, row-major): colour by colour in `order`, each colour's
 * texels covered by rectangles that may spill over texels of colours painted after it (never an earlier colour's), and
 * each run on the lowest layer above every earlier colour's run it overlaps.
 *
 * At most `maxLayer` layers: a run that would land on the top layer does not spill (it covers only its own colour's
 * texels), so nothing painted later has to go over it. Nested rings — a coil in a coil — would otherwise climb a layer
 * per ring, into the states drawn over the body.
 */
export function decomposeGrid(rows: ReadonlyArray<string>, order: string, maxLayer = MAX_LAYER): Array<Run> {
	const m = rows.size();
	const n = (rows[0] ?? "").size();
	const rankOf = new Map<string, number>();
	const colours = order.size();
	for (let i = 1; i <= colours; i++) rankOf.set(order.sub(i, i), i - 1);
	const rank: Array<number> = [];
	for (let y = 0; y < m; y++) {
		const row = rows[y];
		for (let x = 0; x < n; x++) rank.push(rankOf.get(row.sub(x + 1, x + 1)) ?? -1);
	}
	const runs: Array<Run> = [];
	const layers: Array<number> = [];
	/** the lowest layer a run of colour `L` over [x0, x1] × [y0, y1] may sit on */
	const layerFor = (L: number, x0: number, y0: number, x1: number, y1: number): number => {
		let z = 0;
		for (let j = 0; j < runs.size(); j++) {
			if (layers[j] >= L) continue;
			const b = runs[j];
			if (x0 < b.x + b.w && b.x <= x1 && y0 < b.y + b.h && b.y <= y1) z = math.max(z, b.z + 1);
		}
		return z;
	};
	for (let L = 0; L < colours; L++) {
		const color = INK[order.sub(L + 1, L + 1)];
		if (color === undefined) continue;
		const covered: Array<boolean> = [];
		for (let i = 0; i < n * m; i++) covered.push(false);
		const needed = (i: number): boolean => rank[i] === L && !covered[i];
		for (let y = 0; y < m; y++) {
			for (let x = 0; x < n; x++) {
				if (!needed(y * n + x)) continue;
				// the widest span the rule allows on this row, grown down while every texel under it is allowed and
				// at least one still needs this colour; on the top layer, only this colour is allowed
				let x0 = x;
				let x1 = x;
				let y1 = y;
				let z = 0;
				for (let pass = 0; pass < 2; pass++) {
					const own = pass === 1;
					const allowed = (i: number): boolean => (own ? rank[i] === L : rank[i] >= L);
					x0 = x;
					while (x0 > 0 && allowed(y * n + x0 - 1)) x0 -= 1;
					x1 = x;
					while (x1 < n - 1 && allowed(y * n + x1 + 1)) x1 += 1;
					y1 = y;
					while (y1 + 1 < m) {
						let ok = true;
						let more = false;
						for (let i = x0; i <= x1; i++) {
							const k = (y1 + 1) * n + i;
							if (!allowed(k)) ok = false;
							else if (needed(k)) more = true;
						}
						if (!ok || !more) break;
						y1 += 1;
					}
					z = layerFor(L, x0, y, x1, y1);
					if (z < maxLayer) break;
				}
				for (let yy = y; yy <= y1; yy++) {
					for (let i = x0; i <= x1; i++) if (rank[yy * n + i] === L) covered[yy * n + i] = true;
				}
				runs.push({ x: x0, y, w: x1 - x0 + 1, h: y1 - y + 1, color, z });
				layers.push(L);
			}
		}
	}
	return runs;
}

const runsCache = new Map<string, Array<Run>>();

/** the flat drawing of a sprite (decomposed once) */
function runsOf(key: string): Array<Run> {
	const cached = runsCache.get(key);
	if (cached !== undefined) return cached;
	const sprite = MACHINE_SPRITES[key];
	const runs = sprite !== undefined ? decomposeGrid(sprite.rows, MACHINE_ART_ORDER) : [];
	runsCache.set(key, runs);
	return runs;
}

/** tests: how many rectangles a sprite costs drawn flat, and how many layers it stacks */
export function machineRunCount(key: string): number {
	return runsOf(key).size();
}
export function machineRunLayers(key: string): number {
	let top = 0;
	for (const q of runsOf(key)) top = math.max(top, q.z);
	return top;
}

/** the sprite a machine's body is drawn with, by tag */
const BASE_SPRITE: Record<string, string> = {
	turret: "turretBase",
	electric_turret: "shockBase",
	battery: "battery",
	solar: "solar",
	reactor: "reactor",
	oil_generator: "oilGenerator",
	lamp: "lamp",
	turret_drone: "padTurret",
	lamp_drone: "padLamp",
	gps: "gps",
	cooker: "cooker",
};

export class MachinesView {
	private readonly shadow: ShadowFn;
	private readonly opts: SpriteOpts = {};
	private readonly seen = new Map<Solid, Seen>();
	private readonly scratch = new Array<Solid>();
	private readonly at: Point = { x: 0, y: 0 };
	/** each machine's box (the server's rule on this client's solids), recomputed when the solids change */
	private readonly links = new Map<Solid, Solid | undefined>();
	private linkedFor?: WorldData;
	private linkedCount = -1;
	/** the drones and the beacons of the world, for the air and the arrow (the solids list is walked on a change) */
	private readonly drones = new Array<Solid>();
	private readonly beacons = new Array<Solid>();
	/** the animation clock (seconds) and the server's (for the drones' orbit), set each frame */
	private clock = 0;
	private serverSeconds = 0;
	/**
	 * the player asked for reduced motion (set by the loop, like worldView's): a struck machine holds still, and so does
	 * a running oil generator's shiver (BEM-08)
	 */
	reduceMotion = false;

	constructor(shadow: ShadowFn) {
		this.shadow = shadow;
	}

	// ------------------------------------------------------------------ per frame

	/**
	 * Once a frame, before anything is drawn: the clocks, and what the turrets' shots say about where they point. A
	 * tracer that starts at a turret's muzzle (or at a flying turret drone) is that machine firing, now, that way.
	 */
	learn(world: WorldData, tracers: ReadonlyArray<Tracer>, clock: number, serverSeconds: number, dt: number): void {
		this.clock = clock;
		this.serverSeconds = serverSeconds;
		this.refreshLists(world);
		for (const [, seen] of this.seen) {
			if (seen.flash > 0) seen.flash = math.max(0, seen.flash - dt);
		}
		for (const t of tracers) {
			if (t.life <= 0) continue;
			const aim = math.atan2(t.y2 - t.y1, t.x2 - t.x1);
			this.scratch.clear();
			querySolids(world, t.x1 - 40, t.y1 - 40, t.x1 + 40, t.y1 + 40, this.scratch);
			for (const s of this.scratch) {
				if (s.tags !== "turret" && s.tags !== "electric_turret") continue;
				const dx = t.x1 - (s.x + s.w / 2);
				const dy = t.y1 - (s.y + s.h / 2);
				if (dx * dx + dy * dy > (TURRET_MUZZLE + 2) * (TURRET_MUZZLE + 2)) continue;
				this.fired(s, aim, t.life);
			}
			this.scratch.clear();
			for (const d of this.drones) {
				const seen = this.seen.get(d);
				if (d.tags !== "turret_drone" || seen?.airX === undefined || seen.airY === undefined) continue;
				const dx = t.x1 - seen.airX;
				const dy = t.y1 - seen.airY;
				if (dx * dx + dy * dy < 70 * 70) this.fired(d, aim, t.life);
			}
		}
	}

	private fired(s: Solid, aim: number, life: number): void {
		const seen = this.seenOf(s);
		if (life < seen.flash) return;
		seen.aim = aim;
		seen.flash = life;
	}

	private seenOf(s: Solid): Seen {
		let seen = this.seen.get(s);
		if (seen === undefined) {
			seen = { aim: 0, flash: 0 };
			this.seen.set(s, seen);
		}
		return seen;
	}

	/** the drones and the beacons of the world, and the cables, walked again only when the solids changed */
	private refreshLists(world: WorldData): void {
		const n = world.solids.size();
		if (this.linkedFor === world && this.linkedCount === n) return;
		this.linkedFor = world;
		this.linkedCount = n;
		this.links.clear();
		this.drones.clear();
		this.beacons.clear();
		for (const s of world.solids) {
			const def = machineOf(s);
			if (def === undefined) continue;
			if (def.role === "drone") this.drones.push(s);
			if (s.tags === "gps") this.beacons.push(s);
			if (def.role !== "battery") this.links.set(s, this.nearestBox(world, s));
		}
		for (const [s] of this.seen) {
			if (s.removed === true) this.seen.delete(s);
		}
	}

	private nearestBox(world: WorldData, s: Solid): Solid | undefined {
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		this.scratch.clear();
		querySolids(
			world,
			cx - POWER_LINK_RANGE,
			cy - POWER_LINK_RANGE,
			cx + POWER_LINK_RANGE,
			cy + POWER_LINK_RANGE,
			this.scratch,
		);
		let best: Solid | undefined;
		let bestD = POWER_LINK_RANGE * POWER_LINK_RANGE;
		for (const o of this.scratch) {
			if (o.tags !== "battery" || o.removed === true) continue;
			const d = linkDist2(s, o);
			if (d > bestD || (d === bestD && best !== undefined && o.id > best.id)) continue;
			best = o;
			bestD = d;
		}
		this.scratch.clear();
		return best;
	}

	// ------------------------------------------------------------------ one machine where it stands

	/** worldView's hook: draws `s` if it is an electric build and answers true, else false (the old drawing runs) */
	draw(r: Renderer, cam: Camera, s: Solid): boolean {
		const def = machineOf(s);
		if (def === undefined) return false;
		const key = BASE_SPRITE[s.tags];
		if (key === undefined) return false;
		const power = mirroredPower(s.id);
		const state = power?.state ?? (s.powered === true ? 1 : 0);
		const working = powerWorking(state);
		const t = this.clock;
		let cx = s.x + s.w / 2;
		let cy = s.y + s.h / 2;
		// a struck machine shakes like any construction; a running engine shivers -- neither with Reduce Motion on (BEM-08:
		// whether it runs still shows in `drawState`)
		const hit = s.hitShake ?? 0;
		if (hit > 0 && !this.reduceMotion) {
			const amp = 4 * math.min(1, hit / 0.25);
			cx += math.sin(t * 70) * amp;
			cy += math.cos(t * 55) * amp * 0.6;
		}
		if (s.tags === "oil_generator" && working && !this.reduceMotion) {
			cx += math.sin(t * 41) * 0.6;
			cy += math.cos(t * 37) * 0.4;
		}
		const so = this.shadow(cx, cy, s.tags === "turret_drone" || s.tags === "lamp_drone" ? 4 : 8);
		this.rect(r, cam, cx + so.x, cy + so.y, s.w, s.h, INK.k, Z.shadow, 0.3);
		this.sprite(r, cam, key, cx, cy, 0, Z_BASE, 1);
		this.drawState(r, cam, s, cx, cy, state, working, power?.pilot ?? SLOT_NONE);
		this.drawHp(r, cam, s, cx);
		return true;
	}

	private drawState(
		r: Renderer,
		cam: Camera,
		s: Solid,
		cx: number,
		cy: number,
		state: number,
		working: boolean,
		pilot: number,
	): void {
		const tex = MACHINE_TEXEL;
		const t = this.clock;
		const tag = s.tags;
		const x0 = s.x + (cx - (s.x + s.w / 2));
		const y0 = s.y + (cy - (s.y + s.h / 2));
		if (tag === "turret") {
			const seen = this.seenOf(s);
			this.sprite(r, cam, "turretHead", cx, cy, seen.aim, Z_STATE, 1);
			if (seen.flash > 0) this.muzzle(r, cam, cx, cy, seen.aim, seen.flash);
			this.led(r, cam, x0 + s.w - tex * 3.5, y0 + tex * 3.5, working);
			return;
		}
		if (tag === "electric_turret") {
			const seen = this.seenOf(s);
			if (working) {
				const k = seen.flash > 0 ? 0.9 : 0.35 + math.sin(t * 6) * 0.15;
				this.circle(r, cam, cx, cy, tex * 4, INK.y, Z_STATE, k);
			}
			this.led(r, cam, x0 + s.w - tex * 3.5, y0 + tex * 3.5, working);
			return;
		}
		if (tag === "battery") {
			// the charge in three yellow bars in the gauge window (texels 3..6, rows 7, 5, 3 from the bottom)
			const level = powerLevel(state);
			for (let i = 0; i < 3; i++) {
				const on = level > i;
				this.rect(r, cam, x0 + tex * 5, y0 + tex * (7.5 - i * 2), tex * 4, tex, on ? INK.y : INK.d, Z_STATE, 1);
			}
			return;
		}
		if (tag === "reactor") {
			if (working) this.circle(r, cam, cx, cy, tex * 5.4, CORE, Z_STATE, 0.55 + math.sin(t * 1.7) * 0.2);
			this.led(r, cam, x0 + s.w - tex * 4, y0 + tex * 4, working);
			return;
		}
		if (tag === "solar") {
			this.led(r, cam, x0 + s.w - tex * 1.5, y0 + tex * 1.5, working);
			return;
		}
		if (tag === "oil_generator") {
			if (working) {
				// two puffs out of the exhaust (texel 13.5, 13.5), rising and fading, half a cycle apart
				for (let i = 0; i < 2; i++) {
					const f = (t * 0.9 + i * 0.5) % 1;
					const px = x0 + tex * 13.5 + f * 10;
					const py = y0 + tex * 13.5 - f * 26;
					this.circle(r, cam, px, py, 10 + f * 14, SMOKE, Z_STATE, 0.45 * (1 - f));
				}
			}
			// the tank's level, on the tank's face (the store bits: 0 dry … 3 full)
			const level = powerLevel(state);
			if (level > 0) {
				const w = tex * 5 * (level / 3);
				this.rect(r, cam, x0 + tex * 10 + w / 2, y0 + tex * 8.5, w, tex * 0.75, INK.y, Z_STATE, 0.9);
			}
			this.led(r, cam, x0 + tex * 1.5, y0 + tex * 2.5, working);
			return;
		}
		if (tag === "lamp") {
			if (working) {
				// the halo first, the lens over it (one layer: the same light)
				this.circle(r, cam, cx, cy, tex * 9, LIT, Z_STATE, 0.25);
				this.circle(r, cam, cx, cy, tex * 4.6, LIT, Z_STATE, 0.95);
			}
			return;
		}
		if (tag === "cooker") {
			if (working) {
				const k = 0.7 + math.sin(t * 5) * 0.1;
				this.circle(r, cam, x0 + tex * 4.5, y0 + tex * 5.5, tex * 3.4, HOT, Z_STATE, k);
				this.circle(r, cam, x0 + tex * 10.5, y0 + tex * 5.5, tex * 3.4, HOT, Z_STATE, k);
			}
			this.led(r, cam, x0 + s.w - tex * 1.5, y0 + s.h - tex * 1.5, working);
			return;
		}
		if (tag === "gps") {
			const turn = working ? t * 1.2 : 0;
			this.sprite(r, cam, "dish", cx, cy, turn, Z_STATE, 1);
			// the beacon lamp blinks once a second while it transmits
			const on = working && t % 1 < 0.35;
			this.rect(r, cam, cx, cy, tex * 1.5, tex * 1.5, on ? INK.r : LED_OFF, Z_TOP, 1);
			return;
		}
		if (tag === "turret_drone" || tag === "lamp_drone") {
			const flying = powerFlying(state) && pilot !== SLOT_NONE;
			const seen = this.seenOf(s);
			if (!flying && seen.airX === undefined) {
				// home: on its pad, the ring glowing while the pad charges it
				if (working) this.circle(r, cam, cx, cy, s.w * 0.8, INK.y, Z_STATE, 0.3 + math.sin(t * 4) * 0.1);
				this.sprite(r, cam, tag === "lamp_drone" ? "droneLamp" : "droneTurret", cx, cy, 0, Z_STATE + 1, 1);
			}
			this.led(r, cam, x0 + s.w - tex * 1.5, y0 + tex * 1.5, flying || working);
		}
	}

	private drawHp(r: Renderer, cam: Camera, s: Solid, cx: number): void {
		if (!s.destructible || s.hp >= s.hpMax || s.hpMax >= 99999) return;
		const k = math.clamp(s.hp / s.hpMax, 0, 1);
		const bw = math.max(40, s.w * 0.8);
		const by = s.y - 10;
		this.rect(r, cam, cx, by, bw, 6, INK.k, Z.actorFx, 0.6);
		this.rect(r, cam, cx - (bw * (1 - k)) / 2, by, math.max(1, bw * k), 4, INK.r.Lerp(LED_ON, k), Z.actorFx + 1, 1);
	}

	// ------------------------------------------------------------------ the air, the cables, the way home

	/**
	 * After the solids: the drones in the air (beside their survivor, `pilotAt` answers where each slot is DRAWN this
	 * frame), each machine's cable to its box, and the arrow that points the local survivor home to the nearest beacon.
	 */
	drawAir(
		r: Renderer,
		cam: Camera,
		v: ViewRect,
		dt: number,
		pilotAt: (slot: number) => { x: number; y: number } | undefined,
		me: { x: number; y: number } | undefined,
	): void {
		for (const d of this.drones) this.drawDrone(r, cam, v, d, dt, pilotAt);
		for (const [s, box] of this.links) this.drawCable(r, cam, v, s, box);
		if (me !== undefined) this.drawBeaconArrow(r, cam, me);
	}

	private drawDrone(
		r: Renderer,
		cam: Camera,
		v: ViewRect,
		d: Solid,
		dt: number,
		pilotAt: (slot: number) => { x: number; y: number } | undefined,
	): void {
		const power = mirroredPower(d.id);
		const pilot = power !== undefined && powerFlying(power.state) ? power.pilot : SLOT_NONE;
		const body = pilot !== SLOT_NONE ? pilotAt(pilot) : undefined;
		const seen = this.seenOf(d);
		const lamp = d.tags === "lamp_drone";
		const homeX = d.x + d.w / 2;
		const homeY = d.y + d.h / 2;
		let tx = homeX;
		let ty = homeY;
		if (body !== undefined) {
			droneOffset(d.id, lamp, this.serverSeconds, this.at);
			tx = body.x + this.at.x;
			ty = body.y + this.at.y;
		} else if (seen.airX === undefined) {
			return;
		}
		// ease towards the target (the orbit, or home), then lock onto it
		let x = seen.airX ?? homeX;
		let y = seen.airY ?? homeY;
		const dx = tx - x;
		const dy = ty - y;
		const dist = math.sqrt(dx * dx + dy * dy);
		const step = DRONE_EASE_SPEED * dt;
		if (dist <= step || dist < 1) {
			x = tx;
			y = ty;
		} else {
			x += (dx / dist) * step;
			y += (dy / dist) * step;
		}
		if (body === undefined && x === homeX && y === homeY) {
			// landed: the pad draws it from now on
			seen.airX = undefined;
			seen.airY = undefined;
			return;
		}
		seen.airX = x;
		seen.airY = y;
		if (x < v.minX - 60 || x > v.maxX + 60 || y < v.minY - 60 || y > v.maxY + 60) return;
		const so = this.shadow(x, y, DRONE_SHADOW_LEN);
		this.circle(r, cam, x + so.x, y + so.y, 30, INK.k, Z.actorShadow, 0.25);
		// the rotors blur while it flies
		this.circle(r, cam, x, y, 46, INK.s, Z_AIR, 0.12 + math.sin(this.clock * 40) * 0.04);
		const facing = lamp ? 0 : seen.aim;
		this.sprite(r, cam, lamp ? "droneLamp" : "droneTurret", x, y, facing, Z_AIR, 1);
		if (lamp) this.circle(r, cam, x, y, 10, LIT, Z_AIR + MAX_LAYER + 1, 0.95);
		else if (seen.flash > 0) this.muzzle(r, cam, x, y, seen.aim, seen.flash);
	}

	private drawCable(r: Renderer, cam: Camera, v: ViewRect, s: Solid, box: Solid | undefined): void {
		if (box === undefined || s.removed === true || box.removed === true) return;
		const def = machineOf(s);
		// a drone in the air has left its cable at the pad; the pad keeps it
		if (def === undefined) return;
		const ax = s.x + s.w / 2;
		const ay = s.y + s.h / 2;
		const bx = box.x + box.w / 2;
		const by = box.y + box.h / 2;
		if (math.max(ax, bx) < v.minX || math.min(ax, bx) > v.maxX) return;
		if (math.max(ay, by) < v.minY || math.min(ay, by) > v.maxY) return;
		const fed = powerWorking(mirroredPower(box.id)?.state ?? 0);
		const o = this.fresh(Z_CABLE, fed ? 0.8 : 0.55);
		o.color = fed ? INK.y : CABLE_DRY;
		o.h = 3;
		r.drawSegment(cam, ax, ay, bx, by, o);
	}

	private drawBeaconArrow(r: Renderer, cam: Camera, me: { x: number; y: number }): void {
		let best: Solid | undefined;
		let bestD = math.huge;
		for (const b of this.beacons) {
			if (b.removed === true || !powerWorking(mirroredPower(b.id)?.state ?? 0)) continue;
			const dx = b.x + b.w / 2 - me.x;
			const dy = b.y + b.h / 2 - me.y;
			const d = dx * dx + dy * dy;
			if (d < bestD) {
				bestD = d;
				best = b;
			}
		}
		if (best === undefined) return;
		const dist = math.sqrt(bestD);
		if (dist <= BEACON_ARROW_FROM) return;
		const k = math.clamp((dist - BEACON_ARROW_FROM) / (BEACON_ARROW_FULL - BEACON_ARROW_FROM), 0, 1);
		const a = math.atan2(best.y + best.h / 2 - me.y, best.x + best.w / 2 - me.x);
		const hx = me.x + math.cos(a) * (ARROW_RADIUS + ARROW_LEN / 2);
		const hy = me.y + math.sin(a) * (ARROW_RADIUS + ARROW_LEN / 2);
		// a chevron: two strokes meeting at the tip, in the machines' blue glass
		for (let side = -1; side <= 1; side += 2) {
			const w = a + side * CHEVRON;
			const ex = hx + math.cos(w) * ARROW_LEN;
			const ey = hy + math.sin(w) * ARROW_LEN;
			const o = this.fresh(Z.uiWorld, 0.35 + 0.55 * k);
			o.color = INK.c;
			o.h = 6;
			r.drawSegment(cam, hx, hy, ex, ey, o);
		}
	}

	/** the lights the machines add to the night (a lamp drone in the air; a lamp on the ground is the town's) */
	collectLights(out: Array<LightSource>): void {
		for (const d of this.drones) {
			if (d.tags !== "lamp_drone") continue;
			const seen = this.seen.get(d);
			if (seen?.airX === undefined || seen.airY === undefined) continue;
			const power = mirroredPower(d.id);
			if (power === undefined || !powerFlying(power.state)) continue;
			out.push({ x: seen.airX, y: seen.airY, r: LAMP_DRONE_LIGHT, inner: 0.5 });
		}
	}

	/** a new town, or leaving the world: nothing remembered belongs to it */
	clear(): void {
		this.seen.clear();
		this.links.clear();
		this.drones.clear();
		this.beacons.clear();
		this.linkedFor = undefined;
		this.linkedCount = -1;
	}

	// ------------------------------------------------------------------ drawing helpers

	private fresh(z: number, alpha: number): SpriteOpts {
		const o = this.opts;
		o.w = undefined;
		o.h = undefined;
		o.color = undefined;
		o.rotation = undefined;
		o.alpha = alpha;
		o.zIndex = z;
		o.cornerRadius = undefined;
		o.circle = undefined;
		o.anchorX = undefined;
		o.anchorY = undefined;
		o.stroke = undefined;
		o.image = undefined;
		o.imageTint = undefined;
		o.scaleType = undefined;
		o.pixelated = undefined;
		return o;
	}

	private rect(
		r: Renderer,
		cam: Camera,
		x: number,
		y: number,
		w: number,
		h: number,
		color: Color3,
		z: number,
		alpha: number,
	): void {
		const o = this.fresh(z, alpha);
		o.w = w;
		o.h = h;
		o.color = color;
		r.drawRect(cam, x, y, o);
	}

	private circle(
		r: Renderer,
		cam: Camera,
		x: number,
		y: number,
		d: number,
		color: Color3,
		z: number,
		alpha: number,
	): void {
		const o = this.fresh(z, alpha);
		o.color = color;
		r.drawCircle(cam, x, y, d, o);
	}

	private led(r: Renderer, cam: Camera, x: number, y: number, on: boolean): void {
		this.rect(r, cam, x, y, MACHINE_TEXEL, MACHINE_TEXEL, on ? LED_ON : LED_OFF, Z_TOP, 1);
	}

	private muzzle(r: Renderer, cam: Camera, cx: number, cy: number, aim: number, k: number): void {
		const d = TURRET_MUZZLE + 6;
		const o = this.fresh(Z_AIR + MAX_LAYER + 2, math.clamp(k * 8, 0, 1));
		o.w = 14;
		o.h = 10;
		o.color = FLASH;
		o.rotation = aim;
		r.drawRect(cam, cx + math.cos(aim) * d, cy + math.sin(aim) * d, o);
	}

	/**
	 * One sprite with its pivot at (x, y), turned by `rot`: one ImageLabel when its texture has an id (ART-01), else its
	 * runs, each placed about the pivot and turned with it.
	 */
	private sprite(
		r: Renderer,
		cam: Camera,
		key: string,
		x: number,
		y: number,
		rot: number,
		z: number,
		alpha: number,
	): void {
		const sprite: MachineSprite | undefined = MACHINE_SPRITES[key];
		if (sprite === undefined) return;
		const cols = (sprite.rows[0] ?? "").size();
		const rows = sprite.rows.size();
		const px = sprite.pivot !== undefined ? sprite.pivot[0] + 0.5 : cols / 2;
		const py = sprite.pivot !== undefined ? sprite.pivot[1] + 0.5 : rows / 2;
		const tex = MACHINE_TEXEL;
		const c = math.cos(rot);
		const s = math.sin(rot);
		const name = sprite.texture as WorldArtName;
		const id = WORLD_ART[name] !== undefined ? artId(name) : undefined;
		if (id !== undefined) {
			// the image's centre sits where the grid's centre is, turned about the pivot
			const ox = (cols / 2 - px) * tex;
			const oy = (rows / 2 - py) * tex;
			const o = this.fresh(z, alpha);
			o.w = cols * tex;
			o.h = rows * tex;
			o.image = id;
			o.rotation = rot;
			r.drawRect(cam, x + ox * c - oy * s, y + ox * s + oy * c, o);
			return;
		}
		for (const q of runsOf(key)) {
			const ox = (q.x + q.w / 2 - px) * tex;
			const oy = (q.y + q.h / 2 - py) * tex;
			const o = this.fresh(z + q.z, alpha);
			o.w = q.w * tex;
			o.h = q.h * tex;
			o.color = q.color;
			o.rotation = rot !== 0 ? rot : undefined;
			r.drawRect(cam, x + ox * c - oy * s, y + ox * s + oy * c, o);
		}
	}
}
