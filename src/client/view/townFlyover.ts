/*
 * The town behind the menus (docs/DESIGN_RULES.md UI-10): the lobby and the Survivor screen stand on the REAL town
 * of the world the player is about to enter, seen from the air while a slow camera drifts past its landmarks.
 *
 *   - The town is `generateTown(seed)` with the server's seed (MP-22: `pz_world_seed`, or InitBegin's), drawn by
 *     client/view/worldView.ts -- the very code the run draws with -- through a Renderer (pooled Frames) and a
 *     Camera of its own. It never touches the run's renderer, camera or night layer.
 *   - A SHOT is a straight, eased glide along the facade of a landmark (the gas station, the hospital, a shop
 *     with its rooftop sign...), about SHOT_LEN long at 26-38 u/s on average (57 at the fastest). The last FADE_S of a shot dips to
 *     the page colour, the camera cuts to the next landmark there, and the next shot fades in: nothing ever
 *     jumps while the town is on screen.
 *   - The mood is the world's own hour (`setDayTime`, from the server's clock) or a fixed dusk, with the night
 *     tint of the run when it is dark, capped so the town stays a shape behind the menus instead of a black page.
 *   - A handful of idle zombies shamble near the path, drawn with the horde's own body (humanoidView.ts). They
 *     are cosmetic: no AI, no simulation, nothing the server knows about -- they wander, turn back at walls and
 *     stop now and then.
 *   - Between the town and the menus: the page colour at TRANSPARENCY.backdrop (UI-10), so every label keeps its
 *     contrast; the fade of a cut is the same colour going opaque.
 *
 * Cost: one Renderer pool, warmed on the first frames and then only rewritten (no Instance after warm-up, npm run
 * test:lobby counts them); nothing below allocates per frame except the SpriteOpts tables the shared world
 * drawing passes, exactly as the run does. Phones get a slower pan and fewer walkers, and the zoom never lets a
 * big screen draw more than ~1920 x 1080 units of town. Reduce Motion (GuiService.ReducedMotionEnabled) gets a
 * still frame: no drift, no walkers moving, no fades.
 *
 * Lifecycle (client/ui/lobby.ts, client/main.client.ts): it is the backdrop of ALL the menus, not of one screen. The
 * lobby, and every menu screen opened from it (Settings, Wardrobe, Shop, Credits, How to play), PIN it in the backdrop
 * layer (`pinFlyover`, `ctx.backdropLayer`), under screens that are see-through; switching between them never touches
 * it, so the glide goes on without a restart, a cut or a new warm-up. That layer is in the world's ScreenGui, not the
 * menus' (client/bootstrap.ts): the town changes every frame, and in the menus' ScreenGui it would invalidate every
 * screen's cached drawing with it. The run RELEASES it the moment it starts
 * (`releaseFlyover`): every Frame is destroyed and the next menu builds a new pool. Only the town's data is cached
 * between lobbies (a town takes a noticeable moment to generate), and `prewarmTown` builds it behind the logo. The
 * match TAKES that copy instead of generating the same town again (client/boot/townCache.ts): it moves to the match,
 * this flyover lets go of it first, and the next menu draws a freshly generated one -- never a street the match changed.
 */
import { Camera } from "shared/engine/camera";
import { COLORS, Z } from "shared/engine/colors";
import { Renderer, SpriteOpts } from "shared/engine/renderer";
import { ZOMBIE_BASE_RADIUS } from "shared/game/entities";
import { rectHitsSolid, Solid, WorldData } from "shared/game/world";
import * as TownCache from "../boot/townCache";
import { darkAlphaAt } from "shared/sim/clock";
import { screenSize } from "../ui/device";
import { onLayoutChange, reducedMotion, setWorldTransparency } from "../ui/skin";
import { THEME, TRANSPARENCY } from "../ui/theme";
import { createSun, shadowOffset, updateSun } from "./drawKit";
import { drawZombie } from "./humanoidView";
import { WorldView } from "./worldView";

const RunService = game.GetService("RunService");

/** length of one shot along a facade (world units) */
const SHOT_LEN = 1300;
/**
 * Average glide speed (u/s): desktop, and a phone (a small view crosses its own width faster). The eased glide peaks
 * at 1,5x the average, so 38 tops out at 57 u/s.
 */
const SPEED = 38;
const SPEED_SMALL = 26;
/** the dip to the page colour at each end of a shot (s) */
const FADE_S = 1.2;
/** how far out from the door the camera line runs: across the sidewalk, over the street (world units) */
const STREET_OUT = 300;
/** the hour of the fixed dusk (no server clock: offline, or before the first clock) */
const DUSK = 18.4;
/**
 * The darkest the night tint gets behind the menus. The run's night goes to 0.85 with the survivor's light cutting
 * it; with no light in the shot and the menu scrim on top, that would be a black page. 0.6 still reads as night.
 */
const NIGHT_CAP = 0.6;
/** idle walkers: desktop, phone */
const WALKERS = 8;
const WALKERS_SMALL = 4;
const WALK_SPEED_MIN = 9;
const WALK_SPEED_MAX = 15;
/** feet swing per second of walking (the horde's own gait is 5,2 rad/s at a stroll) */
const WALK_CYCLE = 5.2;
const WALKER_RADIUS = ZOMBIE_BASE_RADIUS;
/** a view smaller than this (screen px) is a phone: slower pan, fewer walkers */
const SMALL_W = 1000;
const SMALL_H = 520;
/** the largest area of town one frame draws, in world units: bigger screens zoom in instead of drawing more */
const MAX_VIEW_H = 1080;
/** the ZIndex layers inside the backdrop */
const Z_TOWN = 1;
const Z_NIGHT = 2;
const Z_SCRIM = 3;
const Z_FADE = 4;

// ---------------------------------------------------------------- the town's data (client/boot/townCache.ts)

/**
 * The town of `seed` for the menus, generated once and kept until the match takes it (client/boot/townCache.ts: the
 * match gets this very copy instead of generating it again, and the next menu builds a fresh one).
 */
export function townFor(seed: number): WorldData {
	return TownCache.townFor(seed);
}

/** builds the town now (behind the logo) so the first lobby does not stall on it */
export function prewarmTown(seed: number): void {
	TownCache.prewarmTown(seed);
}

// ---------------------------------------------------------------- shots

/** a landmark the camera glides past: its door, and the direction along its facade */
interface Landmark {
	x: number;
	y: number;
	/** unit direction along the facade (the street) */
	dx: number;
	dy: number;
}

/** the landmarks of a town, in a shuffled order: every building that is not a plain house, seen from its street */
function landmarksOf(world: WorldData): Array<Landmark> {
	const out: Array<Landmark> = [];
	for (const s of world.solids) {
		if (s.kind !== "building" || (s.buildingType ?? 1) < 3) continue;
		const side = s.doorSide ?? "bottom";
		const doorX = s.doorX ?? s.x + s.w / 2;
		const doorY = s.doorY ?? s.y + s.h;
		const nx = side === "left" ? -1 : side === "right" ? 1 : 0;
		const ny = side === "top" ? -1 : side === "bottom" ? 1 : 0;
		out.push({
			x: doorX + nx * STREET_OUT,
			y: doorY + ny * STREET_OUT,
			dx: ny !== 0 ? 1 : 0,
			dy: nx !== 0 ? 1 : 0,
		});
	}
	if (out.size() === 0) out.push({ x: world.width / 2, y: world.height / 2, dx: 1, dy: 0 });
	for (let i = out.size() - 1; i > 0; i--) {
		const j = math.random(0, i);
		const t = out[i];
		out[i] = out[j];
		out[j] = t;
	}
	return out;
}

/** 0..1 -> 0..1, slow at both ends (the glide starts and settles like a crane shot) */
function easeInOut(t: number): number {
	const k = math.clamp(t, 0, 1);
	return k * k * (3 - 2 * k);
}

// ---------------------------------------------------------------- the idle walkers

interface Walker {
	on: boolean;
	x: number;
	y: number;
	angle: number;
	speed: number;
	/** seconds until the next turn or stop */
	turnIn: number;
	/** standing still until turnIn runs out */
	paused: boolean;
	phase: number;
}

// ---------------------------------------------------------------- the flyover

export class TownFlyover {
	/** the backdrop: town, night tint, scrim and fade, in that order */
	readonly layer: Frame;
	readonly seed: number;
	private readonly world: WorldData;
	private readonly renderer: Renderer;
	private readonly cam = new Camera();
	private readonly town: WorldView;
	private readonly night: Frame;
	private readonly fade: Frame;
	private readonly landmarks: Array<Landmark>;
	private readonly walkers: Array<Walker> = [];
	private readonly sun = createSun();
	private readonly shadow = (x: number, y: number, len: number): { x: number; y: number } =>
		shadowOffset(this.sun, x, y, len);
	/** the view rectangle of this frame, refilled in place */
	private readonly view = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	/** scratch sprite options for the walkers' shadows (the renderer reads them, never keeps them) */
	private readonly shadowOpts: SpriteOpts = { color: COLORS.shadow, alpha: 0.3, zIndex: Z.actorShadow };
	private shot = -1;
	private shotT = 0;
	private shotDur = 1;
	private fromX = 0;
	private fromY = 0;
	private toX = 0;
	private toY = 0;
	private clock = 0;
	private dayTime: number | undefined;
	private small = false;
	private conn: RBXScriptConnection | undefined;
	/** Reduce Motion: the one still frame is on screen (redrawn only when the screen or the hour changes) */
	private stillDrawn = false;
	private destroyed = false;

	constructor(seed: number) {
		this.seed = seed;
		this.world = townFor(seed);
		this.landmarks = landmarksOf(this.world);
		const layer = new Instance("Frame");
		layer.Name = "TownBackdrop";
		layer.Size = UDim2.fromScale(1, 1);
		layer.BackgroundTransparency = 1;
		layer.BackgroundColor3 = THEME.background;
		layer.BorderSizePixel = 0;
		layer.ClipsDescendants = true;
		layer.Active = false;
		// it lives under every menu screen, but it is not a screen: the interface audio must not hear it open or close
		// (client/audio/uiAudio.ts), nor count it as a menu still open, wherever it is pinned
		layer.SetAttribute("Backdrop", true);
		this.layer = layer;
		this.renderer = new Renderer(layer, "Town");
		this.renderer.layer.ZIndex = Z_TOWN;
		this.town = new WorldView(this.shadow);
		// the night of the run, in the world's own colour: it is part of drawing the town, not of the UI
		this.night = this.sheet("Night", COLORS.overlayNight, Z_NIGHT);
		this.night.Visible = false;
		// between the town and the menus: the page colour, so every label keeps its contrast (UI-10)
		const scrim = this.sheet("Scrim", THEME.background, Z_SCRIM);
		setWorldTransparency(scrim, TRANSPARENCY.backdrop);
		this.fade = this.sheet("Fade", THEME.background, Z_FADE);
		this.fade.BackgroundTransparency = 1;
		for (let i = 0; i < WALKERS; i++) {
			this.walkers.push({ on: false, x: 0, y: 0, angle: 0, speed: 0, turnIn: 0, paused: false, phase: 0 });
		}
		onLayoutChange(layer, () => this.fit());
		this.nextShot();
	}

	private sheet(name: string, color: Color3, zIndex: number): Frame {
		const f = new Instance("Frame");
		f.Name = name;
		f.Size = UDim2.fromScale(1, 1);
		f.BorderSizePixel = 0;
		f.BackgroundColor3 = color;
		f.ZIndex = zIndex;
		f.Active = false;
		f.Parent = this.layer;
		return f;
	}

	/** the view follows the screen: the whole screen, zoomed so a big one does not draw more town */
	private fit(): void {
		// it hangs in the world's ScreenGui (ScreenInsets.None): the whole screen, under a notch too
		const v = screenSize();
		this.renderer.setView(v.X, v.Y);
		this.cam.setView(v.X, v.Y);
		this.cam.zoom = math.max(1, v.Y / MAX_VIEW_H);
		this.small = v.X < SMALL_W || v.Y < SMALL_H;
		this.stillDrawn = false;
	}

	/** the world's hour (the server's clock), or undefined for the fixed dusk */
	setDayTime(t: number | undefined): void {
		if (t === this.dayTime) return;
		this.dayTime = t;
		this.stillDrawn = false;
	}

	/** puts the backdrop under `host` (at the back, ZIndex `zIndex`) and starts the drift */
	attach(host: GuiObject, zIndex: number): void {
		if (this.destroyed) return;
		// pinned again by the next menu screen: it is already there and gliding -- nothing to touch
		if (this.layer.Parent === host && this.layer.ZIndex === zIndex && this.conn !== undefined) return;
		this.layer.ZIndex = zIndex;
		this.layer.Parent = host;
		this.stillDrawn = false;
		if (this.conn === undefined) this.conn = RunService.RenderStepped.Connect(dt => this.step(dt));
	}

	/** stops the drift and takes the backdrop off the screen; the pool is kept for the next attach */
	detach(): void {
		this.conn?.Disconnect();
		this.conn = undefined;
		if (!this.destroyed) this.layer.Parent = undefined;
	}

	/** releases everything: the run starts, or the town changed */
	destroy(): void {
		if (this.destroyed) return;
		this.detach();
		this.destroyed = true;
		this.renderer.releaseAll();
		this.layer.Destroy();
	}

	/** where the camera is (tests, and a playtest's sanity check) */
	cameraAt(): [number, number] {
		return [this.cam.x, this.cam.y];
	}

	/** sprites drawn by the last frame */
	spriteCount(): number {
		return this.renderer.drawCount();
	}

	/** is this the flyover drawing `world`? (a town the match takes is let go of first: client/boot/townCache.ts) */
	shows(world: WorldData): boolean {
		return this.world === world;
	}

	// ------------------------------------------------------------ the shot

	private nextShot(): void {
		this.shot = (this.shot + 1) % this.landmarks.size();
		const lm = this.landmarks[this.shot];
		// every other shot runs the other way along its street
		const sign = this.shot % 2 === 0 ? 1 : -1;
		const half = SHOT_LEN / 2;
		const w = this.world;
		this.fromX = math.clamp(lm.x - lm.dx * half * sign, 0, w.width);
		this.fromY = math.clamp(lm.y - lm.dy * half * sign, 0, w.height);
		this.toX = math.clamp(lm.x + lm.dx * half * sign, 0, w.width);
		this.toY = math.clamp(lm.y + lm.dy * half * sign, 0, w.height);
		this.shotT = 0;
		this.shotDur = SHOT_LEN / (this.small ? SPEED_SMALL : SPEED);
		this.place(0);
		this.scatter(lm);
	}

	/** the camera at time t of the shot (eased) */
	private place(t: number): void {
		const k = easeInOut(t / this.shotDur);
		this.cam.x = this.fromX + (this.toX - this.fromX) * k;
		this.cam.y = this.fromY + (this.toY - this.fromY) * k;
	}

	/** puts the walkers on open ground near this shot's street (a walker with no room is left out) */
	private scatter(lm: Landmark): void {
		const count = this.small ? WALKERS_SMALL : WALKERS;
		for (let i = 0; i < this.walkers.size(); i++) {
			const wk = this.walkers[i];
			wk.on = false;
			if (i >= count) continue;
			for (let tries = 0; tries < 6 && !wk.on; tries++) {
				const along = (math.random() - 0.5) * SHOT_LEN * 0.9;
				const across = (math.random() - 0.5) * 520;
				const x = lm.x + lm.dx * along + lm.dy * across;
				const y = lm.y + lm.dy * along + lm.dx * across;
				if (this.blocked(x, y)) continue;
				wk.on = true;
				wk.x = x;
				wk.y = y;
				wk.angle = math.random() * math.pi * 2;
				wk.speed = WALK_SPEED_MIN + math.random() * (WALK_SPEED_MAX - WALK_SPEED_MIN);
				wk.turnIn = 1 + math.random() * 4;
				wk.paused = math.random() < 0.3;
				wk.phase = math.random() * math.pi * 2;
			}
		}
	}

	private blocked(x: number, y: number): boolean {
		const w = this.world;
		if (x < 0 || y < 0 || x > w.width || y > w.height) return true;
		const s: Solid | undefined = rectHitsSolid(w, x, y, WALKER_RADIUS * 2, WALKER_RADIUS * 2);
		return s !== undefined;
	}

	/** a shambling step: straight on, now and then a turn or a stop; a wall turns it back */
	private walk(wk: Walker, dt: number): void {
		wk.turnIn -= dt;
		if (wk.turnIn <= 0) {
			wk.turnIn = 2 + math.random() * 4;
			wk.paused = math.random() < 0.25;
			if (!wk.paused) wk.angle += (math.random() - 0.5) * 2.2;
		}
		if (wk.paused) return;
		const nx = wk.x + math.cos(wk.angle) * wk.speed * dt;
		const ny = wk.y + math.sin(wk.angle) * wk.speed * dt;
		if (this.blocked(nx, ny)) {
			wk.angle += math.pi;
			return;
		}
		wk.x = nx;
		wk.y = ny;
		wk.phase = (wk.phase + WALK_CYCLE * dt) % (math.pi * 2);
	}

	// ------------------------------------------------------------ the frame

	/** one frame: move the camera and the walkers, then draw (Reduce Motion: a still frame, drawn once) */
	step(dt: number): void {
		if (this.destroyed) return;
		const still = reducedMotion();
		if (still) {
			if (this.stillDrawn) return;
			this.stillDrawn = true;
			// the still frame is the landmark itself, square in the middle of the shot
			this.cam.x = (this.fromX + this.toX) / 2;
			this.cam.y = (this.fromY + this.toY) / 2;
			this.fade.BackgroundTransparency = 1;
		} else {
			this.clock += dt;
			this.shotT += dt;
			if (this.shotT >= this.shotDur) this.nextShot();
			this.place(this.shotT);
			for (const wk of this.walkers) if (wk.on) this.walk(wk, dt);
			// the dip to the page colour at both ends of the shot: the cut happens while the page is opaque
			const edge = math.min(this.shotT, this.shotDur - this.shotT);
			const t = edge >= FADE_S ? 1 : math.clamp(edge / FADE_S, 0, 1);
			if (this.fade.BackgroundTransparency !== t) this.fade.BackgroundTransparency = t;
		}
		this.draw();
	}

	private draw(): void {
		const hour = this.dayTime ?? DUSK;
		const cam = this.cam;
		// shadows: the sun's direction for the hour, held at the low evening sun after dark (no light to run from)
		updateSun(this.sun, math.clamp(hour, 6.5, 17.5), cam.x, cam.y);
		const halfW = cam.viewW / 2 / cam.zoom;
		const halfH = cam.viewH / 2 / cam.zoom;
		const v = this.view;
		v.minX = cam.x - halfW - 32;
		v.maxX = cam.x + halfW + 32;
		v.minY = cam.y - halfH - 32;
		v.maxY = cam.y + halfH + 32;
		const r = this.renderer;
		r.beginFrame();
		this.town.clock = this.clock;
		this.town.drawGround(r, cam, v, this.world);
		this.town.drawSolids(r, cam, v, this.world);
		const sc = WALKER_RADIUS / 18;
		const so = this.shadowOpts;
		for (const wk of this.walkers) {
			if (!wk.on) continue;
			if (wk.x < v.minX - 60 || wk.x > v.maxX + 60 || wk.y < v.minY - 60 || wk.y > v.maxY + 60) continue;
			const off = shadowOffset(this.sun, wk.x, wk.y, 10);
			so.alpha = 0.3;
			so.zIndex = Z.actorShadow;
			so.color = COLORS.shadow;
			r.drawCircle(cam, wk.x + off.x, wk.y + off.y, WALKER_RADIUS * 2.1, so);
			// the same walker the horde draws: its pixel art once uploaded (ART-10), the flat humanoid otherwise
			drawZombie(
				r,
				cam,
				wk.x,
				wk.y,
				wk.angle,
				sc,
				1,
				0,
				1,
				wk.paused ? 0 : wk.phase,
				Z.zombie,
				0,
				false,
				false,
				false,
			);
		}
		r.endFrame();
		const dark = math.min(darkAlphaAt(hour, false, false), NIGHT_CAP);
		const tint = 1 - dark;
		const lit = dark > 0.004;
		if (this.night.Visible !== lit) this.night.Visible = lit;
		if (this.night.BackgroundTransparency !== tint) this.night.BackgroundTransparency = tint;
	}
}

// ---------------------------------------------------------------- the one flyover of the client

let current: TownFlyover | undefined;

/**
 * The flyover behind `host`: the one already built when it shows the same town (a lobby coming back from the Shop
 * reuses its pool), a new one otherwise.
 */
export function attachFlyover(host: GuiObject, seed: number, zIndex: number): TownFlyover {
	let f = current;
	if (f !== undefined && f.seed !== seed) {
		f.destroy();
		f = undefined;
	}
	if (f === undefined) {
		f = new TownFlyover(seed);
		current = f;
	}
	f.attach(host, zIndex);
	return f;
}

/** ZIndex of the menus' backdrop in its layer: at the back of it */
export const MENU_BACKDROP_Z = 0;

/**
 * The town behind the menus (UI-10): the flyover in the backdrop `layer` (ctx.backdropLayer, the world's ScreenGui, drawn
 * under the menus' one), where every menu screen -- the lobby, and whatever it opens -- stands on it. The one already
 * there keeps gliding (same town: nothing is touched); a new
 * town (MP-22) replaces it. Idempotent: every menu screen pins it, so none depends on which came first.
 */
export function pinFlyover(layer: GuiObject, seed: number): TownFlyover {
	return attachFlyover(layer, seed, MENU_BACKDROP_Z);
}

/** stop drawing and take the backdrop off the screen (the pool is kept for the next attach) */
export function detachFlyover(): void {
	current?.detach();
}

/** a run starts: every Frame of the flyover is destroyed; the next lobby builds a new one */
export function releaseFlyover(): void {
	current?.destroy();
	current = undefined;
}

// the match takes the menus' town (client/boot/townCache.ts takeTown): a flyover still drawing it lets go before the
// match gets it, so no menu ever draws a street the match has changed (the next menu draws a freshly generated copy)
TownCache.onTownTaken(world => {
	if (current !== undefined && current.shows(world)) releaseFlyover();
});

/** the flyover alive right now, if any (tests) */
export function activeFlyover(): TownFlyover | undefined {
	return current;
}
