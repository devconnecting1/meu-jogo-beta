#!/usr/bin/env node
/*
 * The store art of LAST TOWN (the game page on Roblox): five thumbnails, the game icon and the wordmark, rendered
 * from the game's REAL drawing code, deterministically from a seed.
 *
 *   npm run promo                                  # everything into docs/promo/ (thumbnails/, icon/, logo/, previews/)
 *   npm run promo -- --only thumbnails             # or: icon, logo, previews, or a thumbnail's name (survive-the-night)
 *   npm run promo -- --seed 1234 --out /tmp/promo  # another town (every scene is FOUND in it), another folder
 *
 * More options: --boss 1..4 (the boss of "defeat-the-bosses": 1 centipede, 2 rafflesia, 3 giant, 4 hedgehog) and
 * --boss-hour (default 21), --shop-hour (the gun shop's clock, default 16), --town-zoom (the town's view, default 0.5).
 *
 * Truthful by construction (Roblox asks that thumbnails represent the actual experience; the specs and the policy
 * points applied are in docs/promo/README.md). Every picture is a frame the game can draw:
 *   - the town is shared/game/world.ts `generateTown(seed)`, drawn by client/view/worldView.ts with the town's pixel
 *     art (design/world-art/*.png, the textures `npm run cloud -- upload-art` puts in the game), through
 *     shared/engine/renderer.ts onto the fake GUI tree of tools/fake-gui.mjs and rasterised by tools/gui-raster.mjs,
 *     as tools/render-map.mjs and tools/render-characters.mjs do;
 *   - zombies go through client/view/actorsView.ts `drawZombies` (the horde's own path), survivors through
 *     survivorView.ts `drawSurvivor`, bosses through bossView.ts `drawBoss`, turrets, battery boxes and lamps through
 *     machinesView.ts, the awareness marks (blue dot, gold "?", red "!") through zombieAwareness.ts, the night through
 *     the renderer's LightMap with the clock's darkness (shared/sim/clock.ts) and the lights gameLoop.drawLight
 *     pushes (client/view/lightList.ts: the survivor's circle and the flashlight's cone by the ONE rule of
 *     shared/sim/survivorLight.ts, lamps and fires, the muzzle flash of a shot line);
 *   - constructions are placed by the game's own rules (shared/sim/placement.ts: a barricade snaps into a window or a
 *     doorway, EDI-13) and powered by what the server would say (client/systems/powerMirror.ts `applyPowerSet`);
 *   - at night a zombie is only as visible as the server makes it (shared/sim/ai/zombieBrain.ts `isLit` /
 *     `updateAlpha`): drawn inside a light, fading out (3 per second) just outside it, not at all in the dark;
 *   - a shot is a tracer from the muzzle as client/predict/weaponFx.ts and fxView.drawTracers draw it, and a hit a
 *     green burst from client/systems/particles.ts, drawn like gameLoop.drawParticles.
 * Only the framing, the moment and the title band on top are chosen. No interface is drawn (no HUD, no buttons),
 * so nothing on the picture pretends to be something you can press.
 *
 * Pixel art is only ever enlarged nearest-neighbour: the camera's zoom is a whole number of screen pixels per texel
 * (a texel is 4 units, ART-02: 2 px in the town's view at 0.5, 6-10 px in the scenes at 1.5-2.5, 14-18 px in the
 * icon at 3.5-4.5), and the textures are sampled Pixelated.
 * Titles use the bold pixel font of tools/title-font.mjs (drawn in code); labels use tools/pixel-font.mjs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePNG, encodePNG } from "./png-lite.mjs";
import { rasterise } from "./gui-raster.mjs";
import { drawText, FONT } from "./pixel-font.mjs";
import { drawTitle, layoutText, TITLE_H } from "./title-font.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const argOf = (k, d) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const OUT = resolve(argOf("out", join(ROOT, "docs", "promo")));
const ONLY = argOf("only", undefined)?.split(",");

// ---------------------------------------------------------------- the real code

const { installShims } = await import("./luau-shim.mjs");
const SEED_ARG = argOf("seed", undefined);
// the Luau math.random of the drawing code (a zombie's variant roll, a blood spray) is seeded too
const { SRC, require } = installShims({ seed: SEED_ARG !== undefined ? Number(SEED_ARG) : 7331 });
const { installFakeGui } = await import("./fake-gui.mjs");
const gui = installFakeGui();

// actorsView.ts's mirror half imports the network layer (and through it the client's bootstrap); a drawing needs
// none of it, so it gets an inert stand-in (as tools/boss-cast.mjs does)
{
	const net = require.resolve(join(SRC, "client/net/netClient.ts"));
	const stub = { remoteBosses: () => [], remoteZombies: () => [], takeZombieDeaths: () => {} };
	require.cache[net] = { id: net, filename: net, loaded: true, exports: stub, children: [], paths: [] };
}

const { COLORS, Z } = require(join(SRC, "shared/engine/colors.ts"));
const { Camera } = require(join(SRC, "shared/engine/camera.ts"));
const { Renderer, LightMap } = require(join(SRC, "shared/engine/renderer.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const W_ = require(join(SRC, "shared/game/world.ts"));
const { generateTown, pointInSolid, buildingAt, querySolids, addSolid, removeSolid } = W_;
const { createZombie, zombieRadius, bossHitRadius, BOSS1_SEGMENT_RADIUS } = require(
	join(SRC, "shared/game/entities.ts"),
);
const { raycast, blocksShots, rayCircle } = require(join(SRC, "shared/game/physics.ts"));
const { darkAlphaAt } = require(join(SRC, "shared/sim/clock.ts"));
const SL = require(join(SRC, "shared/sim/survivorLight.ts"));
const { STRUCTURE_LIGHT_R } = require(join(SRC, "shared/sim/ai/zombieTuning.ts"));
const { PLACEABLES, snapToOpening, placedSolid } = require(join(SRC, "shared/sim/placement.ts"));
const { packPowerState, TURRET_MUZZLE } = require(join(SRC, "shared/data/power.ts"));
const { applyPowerSet, resetPowerMirror } = require(join(SRC, "client/systems/powerMirror.ts"));
const { WEAPONS } = require(join(SRC, "shared/data/weapons.ts"));
const { OutfitLook } = require(join(SRC, "shared/data/cosmetics.ts"));
const { WorldView, SHELTER_SEE_THROUGH } = require(join(SRC, "client/view/worldView.ts"));
const { ActorsView } = require(join(SRC, "client/view/actorsView.ts"));
const { MachinesView } = require(join(SRC, "client/view/machinesView.ts"));
const { drawBoss } = require(join(SRC, "client/view/bossView.ts"));
const SV = require(join(SRC, "client/view/survivorView.ts"));
const AW = require(join(SRC, "client/view/zombieAwareness.ts"));
const { LightList, addSurvivorLight } = require(join(SRC, "client/view/lightList.ts"));
const { ParticleSystem } = require(join(SRC, "client/systems/particles.ts"));
const WA = require(join(SRC, "client/view/worldArt.ts"));

const TOWN_SEED = SEED_ARG !== undefined ? Number(SEED_ARG) : DESIGN.TOWN_SEED;

// ---------------------------------------------------------------- the town's art, from the local PNGs

const ART_DIR = join(ROOT, "design", "world-art");
const LOCAL = "local:";
{
	const manifest = JSON.parse(readFileSync(join(ART_DIR, "manifest.json"), "utf8"));
	const ids = {};
	for (const t of manifest.textures) ids[t.name] = LOCAL + t.name;
	WA.overrideWorldArt(ids);
}
const images = new Map();
function localImage(id) {
	if (images.has(id)) return images.get(id);
	const file = id.startsWith(LOCAL) ? join(ART_DIR, `${id.slice(LOCAL.length)}.png`) : undefined;
	const img = file !== undefined && existsSync(file) ? decodePNG(readFileSync(file)) : undefined;
	if (img === undefined) throw new Error(`render-promo: no local art for ${id}`);
	images.set(id, img);
	return img;
}

// ---------------------------------------------------------------- small image kit (RGBA { w, h, data })

function canvas(w, h, rgba = [0, 0, 0, 0]) {
	const img = { w, h, data: Buffer.alloc(w * h * 4) };
	for (let i = 0; i < w * h; i++) {
		img.data[i * 4] = rgba[0];
		img.data[i * 4 + 1] = rgba[1];
		img.data[i * 4 + 2] = rgba[2];
		img.data[i * 4 + 3] = rgba[3];
	}
	return img;
}

/** `src` over `dst` at (x, y), alpha-blended */
function blit(dst, src, x, y) {
	for (let sy = 0; sy < src.h; sy++) {
		const Y = y + sy;
		if (Y < 0 || Y >= dst.h) continue;
		for (let sx = 0; sx < src.w; sx++) {
			const X = x + sx;
			if (X < 0 || X >= dst.w) continue;
			const s = (sy * src.w + sx) * 4;
			const a = src.data[s + 3] / 255;
			if (a <= 0) continue;
			const d = (Y * dst.w + X) * 4;
			const under = dst.data[d + 3] / 255;
			const out = a + under * (1 - a);
			for (let c = 0; c < 3; c++) {
				dst.data[d + c] = Math.round((src.data[s + c] * a + dst.data[d + c] * under * (1 - a)) / out);
			}
			dst.data[d + 3] = Math.round(out * 255);
		}
	}
}

/** area-average downscale (what a browser does to a big thumbnail): the readability previews */
function downscale(src, w, h) {
	const out = { w, h, data: Buffer.alloc(w * h * 4) };
	const fx = src.w / w;
	const fy = src.h / h;
	for (let y = 0; y < h; y++) {
		const y0 = y * fy;
		const y1 = y0 + fy;
		for (let x = 0; x < w; x++) {
			const x0 = x * fx;
			const x1 = x0 + fx;
			const acc = [0, 0, 0, 0];
			let n = 0;
			for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
				const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
				for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
					const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
					const k = wx * wy;
					const i = (Math.min(src.h - 1, sy) * src.w + Math.min(src.w - 1, sx)) * 4;
					const a = src.data[i + 3] / 255;
					acc[0] += src.data[i] * a * k;
					acc[1] += src.data[i + 1] * a * k;
					acc[2] += src.data[i + 2] * a * k;
					acc[3] += a * k;
					n += k;
				}
			}
			const o = (y * w + x) * 4;
			const a = acc[3];
			out.data[o] = a > 0 ? Math.round(acc[0] / a) : 0;
			out.data[o + 1] = a > 0 ? Math.round(acc[1] / a) : 0;
			out.data[o + 2] = a > 0 ? Math.round(acc[2] / a) : 0;
			out.data[o + 3] = Math.round((a / n) * 255);
		}
	}
	return out;
}

/** a flat colour over the rect at alpha `a(x, y)` (0..1) */
function shade(img, x0, y0, x1, y1, rgb, a) {
	for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++) {
		for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x++) {
			const k = a(x, y);
			if (k <= 0) continue;
			const i = (y * img.w + x) * 4;
			for (let c = 0; c < 3; c++) img.data[i + c] = Math.round(img.data[i + c] + (rgb[c] - img.data[i + c]) * k);
		}
	}
}

const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * The band that carries a title: the picture darkened towards its top edge (never a box, never a button), so the
 * letters keep their contrast on any frame; `h` px tall, `k` the darkening at the very top.
 */
function topBand(img, h, k = 0.72) {
	shade(img, 0, 0, img.w, h, [6, 7, 16], (x, y) => k * (1 - smooth(y / h)));
}

/** the corners a touch darker, drawing the eye to the middle (minor post-processing, the game's own colours) */
function vignette(img, k = 0.35) {
	const cx = img.w / 2;
	const cy = img.h / 2;
	const r = Math.hypot(cx, cy);
	shade(img, 0, 0, img.w, img.h, [4, 5, 12], (x, y) => k * smooth((Math.hypot(x - cx, y - cy) / r - 0.55) / 0.45));
}

// ---------------------------------------------------------------- deterministic randomness of the compositions

function prng(seed) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---------------------------------------------------------------- the town

const world = generateTown(TOWN_SEED);
const machines = new MachinesView(() => ({ x: 0, y: 0 }));
const actors = new ActorsView();
const inRect = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
const lotAt = (x, y) => world.lots.find(l => inRect(l, x, y));
const free = (x, y, r = 20) =>
	x > 0 && y > 0 && x < world.width && y < world.height && pointInSolid(world, x, y, r) === undefined;
/** under a tree's crown (a body there turns it see-through, VEG-04: a shot reads better without) */
const underCanopy = (x, y) =>
	querySolids(world, x - 200, y - 200, x + 200, y + 200, []).some(
		s => s.kind === "tree" && Math.hypot(s.x + s.w / 2 - x, s.y + s.h / 2 - y) < (s.canopyR ?? 80) + 24,
	);
const outdoors = (x, y, r = 20) => free(x, y, r) && buildingAt(world, x, y) === undefined && !underCanopy(x, y);

/** a point `d` units from (x, y) along `a` */
const along = (x, y, a, d) => ({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d });

// ---------------------------------------------------------------- one frame of the game, drawn and rasterised

const DT = 1 / 60;

/**
 * Draws a moment of the game and returns its picture. `sc`:
 *   vw, vh, zoom, cx, cy     the view (px) and the camera (world units per px = 1 / zoom)
 *   hour                     the clock (0-24): the sun's shadows by day, the night's darkness (darkAlphaAt)
 *   survivors                [{ x, y, angle, weapon, outfit, flashlight, swing, phase, flash }]
 *   zombies                  ZombieState records (createZombie), their `alpha` set by `lightZombies`
 *   bosses                   BossState records
 *   shots                    [{ x1, y1, x2, y2, life, hit }]: tracers (and a green burst where `hit`)
 *   roofOff                  buildings whose roof is lifted (a survivor is inside: EDI-04)
 *   clock                    the animation clock (legs, flames)
 */
function drawMoment(sc) {
	const root = gui.make("Frame");
	root.Size = UDim2.fromOffset(sc.vw, sc.vh);
	const r = new Renderer(root, "Sprites");
	const dark = gui.make("Frame");
	dark.Parent = root;
	dark.BackgroundTransparency = 1;
	const cam = new Camera();
	cam.setView(sc.vw, sc.vh);
	r.setView(sc.vw, sc.vh);
	cam.zoom = sc.zoom;
	cam.x = sc.cx;
	cam.y = sc.cy;
	const marks = new AW.AwarenessMarks(root, 84);
	const survivors = sc.survivors ?? [];
	const zombies = sc.zombies ?? [];
	for (const z of zombies) settleAlpha(sc, z);
	const shots = sc.shots ?? [];
	const clock = sc.clock ?? 0.4;
	const darkness = darkAlphaAt(sc.hour, false, false);
	const night = darkness > 0.004;
	const v = cam.viewRect(32);

	// the night's lights, as gameLoop.drawLight pushes them
	const lights = nightLights(survivors, shots, v);
	const shadow = shadowFn(sc.hour, lights.items);
	// roofs lifted over whoever is inside; canopies see-through over a body (VEG-04), as the loop eases them
	const lifted = sc.roofOff ?? [];
	for (const b of lifted) b.roofAlpha = 0;
	const bodies = [...zombies.filter(z => z.alpha > 0.02), ...survivors];
	const faded = [];
	for (const s of querySolids(world, v.minX, v.minY, v.maxX, v.maxY, [])) {
		const fades = s.kind === "tree" || s.kind === "canopy" || s.tags === "gas_sign";
		if (!fades) continue;
		s.canopyAlpha = 1;
		if (s.kind === "tree") {
			const r2 = ((s.canopyR ?? 80) + 18) ** 2;
			const tx = s.x + s.w / 2;
			const ty = s.y + s.h / 2;
			if (bodies.some(b => (b.x - tx) ** 2 + (b.y - ty) ** 2 < r2)) s.canopyAlpha = 0.35;
		} else if (bodies.some(b => b.x > s.x - 18 && b.x < s.x + s.w + 18 && b.y > s.y - 18 && b.y < s.y + s.h + 18)) {
			s.canopyAlpha = SHELTER_SEE_THROUGH ?? 0.35;
		}
		faded.push(s);
	}

	const view = new WorldView(shadow);
	view.clock = clock;
	view.machines = machines;
	const tracers = shots.map(t => ({ ...t, life: t.life ?? 0.15 }));
	machines.learn(world, tracers, clock, clock, DT);

	// blood: each hit's spray, a moment after the shot (particles.ts, as fxView plays a ShotResult)
	const particles = new ParticleSystem();
	for (const t of shots) {
		if (t.hit !== true) continue;
		particles.bloodBurst(t.x2, t.y2, t.blood ?? 5, "zombie", Math.atan2(t.y2 - t.y1, t.x2 - t.x1));
	}
	particles.update(0.05);

	r.beginFrame();
	view.drawGround(r, cam, v, world);
	for (const d of particles.decalRecords()) {
		if (d.life <= 0) continue;
		r.drawCircle(cam, d.x, d.y, d.size, { color: d.color, alpha: 0.7 * Math.min(1, d.life / 5), zIndex: Z.decal });
	}
	view.drawSolids(r, cam, v, world);
	machines.drawAir(r, cam, v, DT, () => undefined, undefined);
	actors.drawZombies(r, cam, v, { zombies }, { shadow, clock });
	for (const s of survivors) {
		const look = SV.createLook();
		look.x = s.x;
		look.y = s.y;
		look.angle = s.angle;
		look.outfit = s.outfit ?? OutfitLook.None;
		look.weapon = WEAPONS[s.weapon ?? 10];
		look.feetPhase = s.phase ?? 0;
		look.feetAmp = s.amp ?? 0;
		look.flash = s.flash ?? 0;
		look.clock = clock;
		look.swinging = s.swing !== undefined;
		look.swingAngle = s.angle + (s.swing ?? 0);
		const so = shadow(s.x, s.y, 10);
		look.shadowX = so.x;
		look.shadowY = so.y;
		const trail = SV.createSwingTrail();
		if (look.swinging) {
			trail.drawn = true;
			trail.rel = -10;
		}
		SV.drawSurvivor(r, cam, look, trail);
	}
	for (const b of sc.bosses ?? []) drawBoss(r, cam, v, b, clock, shadow);
	// fxView.drawTracers: the shot lines of the last 0.2 s
	for (const t of tracers) {
		r.drawSegment(cam, t.x1, t.y1, t.x2, t.y2, {
			h: 3,
			color: t.color ?? COLORS.bullet,
			alpha: Math.min(1, Math.max(0, t.life * 5)),
			zIndex: Z.projectile,
		});
	}
	// gameLoop.drawParticles
	for (const p of particles.active()) {
		r.drawCircle(cam, p.x, p.y, p.size, {
			color: p.color,
			alpha: Math.min(1, Math.max(0, (p.life / p.maxLife) * 1.5)),
			zIndex: Z.particle,
		});
	}
	r.endFrame();
	if (night) {
		const lm = new LightMap(dark, COLORS.overlayNight);
		lm.update(cam, darkness, lights.items);
	}
	// the awareness marks: above the night, never over a survivor, as bright as the ground under the zombie
	marks.draw(
		cam,
		v,
		zombies,
		survivors.length > 0 ? survivors : [{ x: -1e6, y: -1e6 }],
		DT,
		world,
		night ? { dark: darkness, lights: lights.items } : undefined,
	);
	const img = rasterise(
		{ layer: r.layer, dark, over: [marks.renderer.layer], vw: sc.vw, vh: sc.vh },
		COLORS.bg,
		localImage,
	);
	for (const b of lifted) b.roofAlpha = 1;
	for (const s of faded) s.canopyAlpha = 1;
	return img;
}

/** gameLoop.drawLight's list: every survivor's circle and flashlight cone, lamps and fires, the shots' flashes */
function nightLights(survivors, shots, v) {
	const lights = new LightList();
	for (const s of survivors) {
		addSurvivorLight(
			lights,
			s.x,
			s.y,
			s.angle,
			SL.SURVIVOR_LIGHT_R,
			s.flashlight ? SL.FLASHLIGHT_REACH : undefined,
		);
	}
	for (const s of querySolids(world, v.minX - 400, v.minY - 400, v.maxX + 400, v.maxY + 400, [])) {
		const rr = STRUCTURE_LIGHT_R[s.tags];
		if (rr === undefined || s.powered !== true) continue;
		lights.circle(s.x + s.w / 2, s.y + s.h / 2, rr, 0.5);
	}
	for (const t of shots) {
		const k = Math.min(1, Math.max(0, (t.life ?? 0.15) * 5));
		if (k > 0.05) lights.circle(t.x1, t.y1, 150, 0.2, 0.85 * k);
	}
	return lights;
}

/** the sun by day (LUZ-01); at night away from the nearest light */
function shadowFn(hour, lights) {
	const s = { x: 0, y: 0 };
	return (x, y, len) => {
		if (hour > 6 && hour < 18) {
			const rad = ((hour / 24) * 360 - 225) * (Math.PI / 180);
			s.x = Math.cos(rad) * len;
			s.y = -Math.sin(rad) * len;
			return s;
		}
		let best;
		for (const l of lights) {
			if (best === undefined || Math.hypot(l.x - x, l.y - y) < Math.hypot(best.x - x, best.y - y)) best = l;
		}
		const dx = best !== undefined ? x - best.x : 0;
		const dy = best !== undefined ? y - best.y : 1;
		const d = Math.hypot(dx, dy);
		s.x = d < 1 ? 0 : (dx / d) * len;
		s.y = d < 1 ? len * 0.5 : (dy / d) * len;
		return s;
	};
}

/**
 * The server's `isLit` (shared/sim/ai/zombieBrain.ts), for the survivors and constructions of a moment: by day
 * everything; at night what stands in a survivor's circle, a flashlight's cone or a lamp's or fire's light.
 */
function litByServer(hour, survivors, x, y) {
	if (1 - darkAlphaAt(hour, false, false) >= 0.4) return true;
	for (const s of survivors) {
		const dx = x - s.x;
		const dy = y - s.y;
		const d2 = dx * dx + dy * dy;
		if (d2 <= SL.SURVIVOR_LIGHT_R ** 2) return true;
		if (s.flashlight && d2 <= SL.FLASHLIGHT_REACH ** 2) {
			let da = Math.atan2(dy, dx) - s.angle;
			while (da > Math.PI) da -= Math.PI * 2;
			while (da < -Math.PI) da += Math.PI * 2;
			if (Math.abs(da) <= SL.CONE_HALF_ANGLE) return true;
		}
	}
	for (const s of querySolids(world, x - 420, y - 420, x + 420, y + 420, [])) {
		const rr = STRUCTURE_LIGHT_R[s.tags];
		if (rr === undefined || s.powered !== true) continue;
		if (Math.hypot(s.x + s.w / 2 - x, s.y + s.h / 2 - y) <= rr) return true;
	}
	return false;
}

/**
 * A zombie of the moment: `createZombie` (the server's own record), placed, facing, walking, its awareness and its
 * alpha by the server's rule -- `fade` is how far it has faded since it stepped out of the light (updateAlpha,
 * 3 per second): 0 = still fully visible, 1 = gone.
 */
function zombie(sc, o) {
	const z = createZombie(o.type ?? 1, o.x, o.y, o.day ?? 6, false);
	z.x = o.x;
	z.y = o.y;
	z.angle = o.angle ?? 0;
	z.angleSlow = z.angle;
	z.scale = o.big ? 1.4 : 1;
	z.feetCycle = o.phase ?? 0;
	z.hitFlash = o.flash ?? 0;
	z.aware = o.aware ?? 3;
	z.rush = o.rush === true;
	z.jumpHeight = o.jump ?? 0;
	if (o.windup !== undefined) z.headX = o.windup;
	// how far it has faded since it left the light; the alpha itself is settled against the moment's final lights
	z.promoFade = o.fade ?? 1;
	settleAlpha(sc, z);
	return z;
}

/** the server's alpha for a zombie of the moment, from the survivors' lights as they finally stand */
function settleAlpha(sc, z) {
	const lit = litByServer(sc.hour, sc.survivors ?? [], z.x, z.y);
	z.alpha = lit ? 1 : Math.max(0, 1 - z.promoFade);
}

/**
 * A shot of `weapon` (a WEAPONS id) from a body at (x, y) along `aim`: one tracer per pellet from the muzzle to where
 * client/predict/weaponFx.ts `traceLocal` stops it -- the first wall on the line (physics raycast, blocksShots: shots
 * fly over constructions), or the first zombie or boss it meets. The pellets of a shotgun fan across its cone.
 * `from` = { x, y } of the muzzle's body; returns the tracers ({ hit: true } where a body stopped it).
 */
function fire(sc, x, y, aim, weapon, life = 0.15) {
	const w = WEAPONS[weapon];
	const n = Math.max(1, w.pellets);
	const out = [];
	for (let i = 0; i < n; i++) {
		const a = aim + (n === 1 ? 0 : ((i / (n - 1) - 0.5) * w.cone * 0.8 * Math.PI) / 180);
		const dx = Math.cos(a);
		const dy = Math.sin(a);
		let best = raycast(world, x, y, a, w.range, blocksShots).dist;
		let hit = false;
		for (const z of sc.zombies ?? []) {
			if (z.hp <= 0) continue;
			const t = rayCircle(x, y, dx, dy, z.x, z.y, zombieRadius(z));
			if (t !== undefined && t < best) {
				best = t;
				hit = true;
			}
		}
		for (const b of sc.bosses ?? []) {
			const parts =
				b.bodyX !== undefined
					? b.bodyX.map((bx, k) => [bx, b.bodyY[k], k === 0 ? bossHitRadius(b) : BOSS1_SEGMENT_RADIUS])
					: [[b.x, b.y, bossHitRadius(b)]];
			for (const [px, py, pr] of parts) {
				const t = rayCircle(x, y, dx, dy, px, py, pr);
				if (t !== undefined && t < best) {
					best = t;
					hit = true;
				}
			}
		}
		const m = along(x, y, aim, DESIGN.PLAYER_ARM);
		out.push({ x1: m.x, y1: m.y, x2: x + dx * best, y2: y + dy * best, life, hit, blood: n > 1 ? 2 : 5 });
	}
	return out;
}

/** a constructed piece (shared/sim/placement.ts), placed by the game's rules and added to the town */
const built = [];
function construct(index, rect, powered) {
	const def = PLACEABLES[index];
	const r = snapToOpening(world, def, { x: rect.x, y: rect.y, w: rect.w ?? def.w, h: rect.h ?? def.h });
	const s = addSolid(world, placedSolid(def, r, 0));
	s.placeable = index;
	if (powered !== undefined) {
		// what the server's PowerSet says of it (client/systems/powerMirror.ts): working, its store full
		applyPowerSet(world, { id: s.id, state: packPowerState(powered, 3, false, powered), pilot: 255 });
		s.powered = powered;
	}
	built.push(s);
	return s;
}

function clearBuilt() {
	for (const s of built) removeSolid(world, s);
	built.length = 0;
	resetPowerMirror();
	machines.clear();
}

// ---------------------------------------------------------------- titles and the wordmark

const BONE = { top: [246, 238, 218], bottom: [214, 198, 166], light: [255, 252, 240] };
const BLOOD = { top: [226, 58, 46], bottom: [170, 30, 30], light: [255, 124, 100] };
const AMBER = { top: [255, 206, 92], bottom: [228, 150, 44], light: [255, 238, 170] };

/**
 * A title: one or more lines of the bold pixel font, each line with its own colours, left-aligned at (x, y);
 * `px` screen pixels per font pixel. Returns the painted box.
 */
function title(img, lines, x, y, maxPx, lead = 3) {
	// as big as fits left of the corner wordmark (MARK_W and its margins), never bigger than maxPx
	const avail = img.w - x - (MARK_W + MARK_MARGIN + 56);
	const widest = Math.max(...lines.map(line => lineWidth(line, 1)));
	const px = Math.max(4, Math.min(maxPx, Math.floor(avail / (widest + 3))));
	let yy = y;
	let right = x;
	for (const line of lines) {
		// a line is a list of [text, colours] runs
		let xx = x;
		for (const [text, style] of line) {
			const m = layoutText(text);
			drawTitle(img, m, xx, yy, px, { ...style, shadowX: 1, shadowY: 1, shadowA: 0.9 });
			xx += (m.w + layoutText(" ").w) * px;
		}
		right = Math.max(right, xx);
		yy += (TITLE_H + lead) * px;
	}
	return { x, y, w: right - x, h: yy - y };
}

/** width in screen px of a title line at `px` */
function lineWidth(line, px) {
	let w = 0;
	line.forEach(([text], i) => {
		w += layoutText(text).w * px;
		if (i < line.length - 1) w += layoutText(" ").w * px;
	});
	return w;
}

/**
 * The LAST TOWN wordmark: LAST in blood red, TOWN in bone, the bold font's outline and hard shadow; `sub` adds
 * "ZOMBIE SURVIVAL" under it in the 5 x 7 label font (outlined the same way, so it reads on any background) between
 * two red rules. `stacked` puts TOWN under LAST. Transparent round the letters, cropped tight.
 */
function wordmark(px, { sub = false, stacked = false } = {}) {
	const last = layoutText("LAST");
	const town = layoutText("TOWN");
	const gap = layoutText(" ").w;
	const lead = 3;
	const wWords = stacked ? Math.max(last.w, town.w) : last.w + gap + town.w;
	const hWords = stacked ? TITLE_H * 2 + lead : TITLE_H;
	// the subtitle at half the size, one label pixel of tracking, and a rule each side
	const subPx = Math.max(1, Math.round(px / 2));
	const subMask = labelMask("ZOMBIE SURVIVAL", 2);
	const ruleW = stacked ? 6 : 12;
	const subW = (subMask.w + (ruleW + 4) * 2) * subPx;
	const W = Math.max((wWords + 4) * px, subW + 4 * subPx);
	const H = (hWords + 4) * px + (sub ? (subMask.h + 6) * subPx + 2 * px : 0);
	const img = canvas(W, H);
	const x0 = Math.floor((W - wWords * px) / 2);
	const y0 = px;
	const style = { shadowX: 1, shadowY: 1 };
	if (stacked) {
		drawTitle(img, last, x0 + Math.floor((wWords - last.w) / 2) * px, y0, px, { ...BLOOD, ...style });
		drawTitle(img, town, x0 + Math.floor((wWords - town.w) / 2) * px, y0 + (TITLE_H + lead) * px, px, {
			...BONE,
			...style,
		});
	} else {
		drawTitle(img, last, x0, y0, px, { ...BLOOD, ...style });
		drawTitle(img, town, x0 + (last.w + gap) * px, y0, px, { ...BONE, ...style });
	}
	if (sub) {
		const sy = y0 + (hWords + 2) * px + 2 * px;
		const sx = Math.floor((W - subMask.w * subPx) / 2);
		drawTitle(img, subMask, sx, sy, subPx, { top: [236, 226, 204], bottom: [206, 190, 160], ...style });
		const rule = { w: ruleW, h: 1, bits: new Uint8Array(ruleW).fill(1) };
		const ry = sy + 3 * subPx;
		for (const rx of [sx - (ruleW + 4) * subPx, sx + (subMask.w + 4) * subPx]) {
			drawTitle(img, rule, rx, ry, subPx, { top: [210, 52, 42], ...style });
		}
	}
	return trim(img);
}

/** a 0/1 mask of `text` in the 5 x 7 label font (tools/pixel-font.mjs), `gap` pixels between letters */
function labelMask(text, gap = 1) {
	const chars = [...text.toUpperCase()];
	const w = chars.length * (5 + gap) - gap;
	const bits = new Uint8Array(w * 7);
	chars.forEach((ch, i) => {
		const g = FONT[ch] ?? FONT[" "];
		for (let r = 0; r < 7; r++) {
			for (let c = 0; c < 5; c++) if (g[r][c] === "1") bits[r * w + i * (5 + gap) + c] = 1;
		}
	});
	return { w, h: 7, bits };
}

/** the picture cropped to its non-transparent pixels */
function trim(img) {
	let x0 = img.w;
	let y0 = img.h;
	let x1 = -1;
	let y1 = -1;
	for (let y = 0; y < img.h; y++) {
		for (let x = 0; x < img.w; x++) {
			if (img.data[(y * img.w + x) * 4 + 3] === 0) continue;
			x0 = Math.min(x0, x);
			y0 = Math.min(y0, y);
			x1 = Math.max(x1, x);
			y1 = Math.max(y1, y);
		}
	}
	const out = canvas(x1 - x0 + 1, y1 - y0 + 1);
	for (let y = 0; y < out.h; y++) {
		img.data.copy(out.data, y * out.w * 4, ((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x1 + 1) * 4);
	}
	return out;
}

/** the small wordmark in a thumbnail's top-right corner: its size, and the margin it keeps */
const MARK_PX = 4;
const MARK_MARGIN = 40;
const MARK_W = wordmark(MARK_PX).w;
function cornerMark(img) {
	const m = wordmark(MARK_PX);
	blit(img, m, img.w - m.w - MARK_MARGIN, MARK_MARGIN);
}

// ---------------------------------------------------------------- the thumbnails

const TW = 1920;
const TH = 1080;

/** a straight residential street well away from any crossing, with houses and parked cars: its middle */
function findQuietStreet() {
	let best;
	let bestScore = -Infinity;
	for (const road of world.roads) {
		if (road.avenue || road.vertical) continue;
		for (let t = road.x + 700; t < road.x + road.w - 700; t += 64) {
			const cy = road.y + road.h / 2;
			const near = world.junctions.some(
				j => Math.abs(j.x + j.w / 2 - t) < 700 && Math.abs(j.y + j.h / 2 - cy) < 700,
			);
			if (near) continue;
			const up = lotAt(t, road.y - 300);
			const down = lotAt(t, road.y + road.h + 300);
			if (up?.zone !== "residential" || down?.zone !== "residential") continue;
			// the frame of the shot: the curb across its middle, the yards above, the road below
			const rect = { x: t - 430, y: road.y - 200, w: 860, h: 480 };
			const list = querySolids(world, rect.x, rect.y, rect.x + rect.w, rect.y + rect.h, []);
			const cars = list.filter(s => s.tags === "car").length;
			const trees = list.filter(s => s.kind === "tree").length;
			const houses = list.filter(s => s.kind === "building").length;
			const score = Math.min(cars, 2) * 3 + Math.min(trees, 3) * 2 + Math.min(houses, 2) * 2;
			if (score > bestScore) {
				bestScore = score;
				best = { road, x: t, y: cy };
			}
		}
	}
	return best;
}

/**
 * 1. SURVIVE THE NIGHT. 22:00, a residential street: one survivor with a pistol and a flashlight, the beam down
 * the road, and the horde it reveals closing in rank after rank with their red "!" (IA-05). Outside the light the
 * night keeps what it hides (the server's alpha: nothing is drawn in the dark), a few at its edge fading.
 */
function thumbSurviveTheNight() {
	// 9 px a texel: the bodies read on a phone, and there is room for the night round the light
	const zoom = 2.25;
	const hour = 22;
	const vwU = TW / zoom;
	const vhU = TH / zoom;
	// the street: the one findQuietStreet likes, slid along (away from any crossing) to where no tree crown stands
	// in the beam
	const st = findQuietStreet();
	let cx = st.x;
	for (let k = 0; k < 30; k++) {
		const x = st.x + (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * 64;
		const cyy = st.road.y + st.road.h / 2;
		if (
			world.junctions.some(
				j => Math.abs(j.x + j.w / 2 - x) < vwU * 0.5 + 250 && Math.abs(j.y + j.h / 2 - cyy) < 700,
			)
		) {
			continue;
		}
		const beam = { x0: x - vwU * 0.15, x1: x + vwU / 2, y0: st.road.y - 100, y1: st.road.y + st.road.h };
		const trees = querySolids(world, beam.x0, beam.y0, beam.x1, beam.y1, []).filter(s => s.kind === "tree");
		if (trees.length === 0) {
			cx = x;
			break;
		}
	}
	const cy = st.road.y + 40;
	// the survivor on the road just off the curb, in the lower left third, lighting the street ahead
	const you = { x: cx - vwU * 0.26, y: cy + vhU * 0.2 };
	const aim0 = -0.1;
	const sc = { vw: TW, vh: TH, zoom, cx, cy, hour, clock: 0.35 };
	sc.survivors = [{ x: you.x, y: you.y, angle: aim0, weapon: 10, flashlight: true, phase: 0.5, amp: 0 }];
	const rnd = prng(TOWN_SEED ^ 0x51);
	const cast = [];
	const put = (a, d, o = {}) => {
		for (let t = 0; t < 12; t++) {
			const p = along(you.x, you.y, a + (rnd() - 0.5) * 0.12 * t, d + (rnd() - 0.5) * 30 * t);
			if (!outdoors(p.x, p.y, 22)) continue;
			if (cast.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 64)) continue;
			cast.push({ ...p, ...o });
			return;
		}
	};
	// three ranks across the beam, the nearest widest (the edge of the survivor's own circle at 250 u)
	const ranks = [
		[235, 5, 0.62, [1, 1, 4, 1, 1]],
		[350, 5, 0.5, [1, 2, 1, 1, 1]],
		[470, 4, 0.36, [1, 3, 1, 5]],
	];
	for (const [d, n, spread, types] of ranks) {
		for (let i = 0; i < n; i++) {
			put(aim0 + (i / (n - 1) - 0.5) * 2 * spread, d + (rnd() - 0.5) * 50, { type: types[i] });
		}
	}
	// behind the survivor, in the circle of their own light: the ones that got close
	put(aim0 + Math.PI - 0.55, 185, { type: 1 });
	// at the light's edge, stepping out of it: fading (updateAlpha) -- never under the title
	put(aim0 + 0.95, 340, { type: 1, fade: 0.45 });
	put(aim0 + 0.22, 640, { type: 1, fade: 0.55 });
	const dist = c => Math.hypot(c.x - you.x, c.y - you.y);
	// the one the survivor shoots: in the first rank, nearest the aim -- the aim (and the beam) turn onto it
	const lead = cast
		.filter(c => c.fade === undefined && dist(c) < 300)
		.sort(
			(p, q) =>
				Math.abs(Math.atan2(p.y - you.y, p.x - you.x) - aim0) -
				Math.abs(Math.atan2(q.y - you.y, q.x - you.x) - aim0),
		)[0];
	sc.survivors[0].angle = lead !== undefined ? Math.atan2(lead.y - you.y, lead.x - you.x) : aim0;
	sc.zombies = cast.map((c, i) =>
		zombie(sc, {
			...c,
			angle: Math.atan2(you.y - c.y, you.x - c.x) + (rnd() - 0.5) * 0.3,
			phase: rnd() * 6.28,
			big: i === 7,
		}),
	);
	sc.shots = fire(sc, you.x, you.y, sc.survivors[0].angle, 10, 0.16);
	const img = drawMoment(sc);
	vignette(img, 0.3);
	topBand(img, 420, 0.55);
	title(
		img,
		[
			[["SURVIVE", BONE]],
			[
				["THE", BONE],
				["NIGHT", BLOOD],
			],
		],
		64,
		56,
		12,
	);
	cornerMark(img);
	return img;
}

/** the outward normal of a building's side */
const NORMAL = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };

/** the building's doorways and windows (what a barricade can fill, EDI-13) */
const fortifiable = b => (b.openings ?? []).filter(o => o.kind === "door" || o.kind === "window");

/** a free spot for a body near (x, y) (a spiral out to `reach`), or undefined */
function freeSpot(x, y, reach = 60, test = free) {
	for (let i = 0; i < 80; i++) {
		const a = i * 2.39996;
		const d = (reach / 9) * Math.sqrt(i);
		const px = Math.round(x + Math.cos(a) * d);
		const py = Math.round(y + Math.sin(a) * d);
		if (test(px, py, 20)) return { x: px, y: py };
	}
	return undefined;
}

/** a construction's rect on the build grid (placement.ts ghostRect: the top-left corner on PLACE_GRID) */
function onGrid(index, cx, cy) {
	const def = PLACEABLES[index];
	const g = 128;
	return { x: Math.floor((cx - def.w / 2) / g + 0.5) * g, y: Math.floor((cy - def.h / 2) / g + 0.5) * g };
}

/** placement.ts placementValid's solid test for a rect (nothing under it) */
function rectFree(r) {
	return querySolids(world, r.x, r.y, r.x + r.w, r.y + r.h, []).every(
		s => !(r.x < s.x + s.w && r.x + r.w > s.x && r.y < s.y + s.h && r.y + r.h > s.y),
	);
}

/**
 * The house of the defence: a home with its entrance on a front yard deep and clear enough for a barricade wall
 * across it and the machines behind the wall (the yard, the sidewalk and the street in front of the door free of
 * anything solid), entrance to the side or down the picture so the horde never comes from under the title.
 */
function findFortHouse() {
	let best;
	let bestScore = -Infinity;
	for (const b of world.solids) {
		if (b.kind !== "building" || (b.buildingType !== 1 && b.buildingType !== 2)) continue;
		if (b.w > 640 || b.h > 640 || fortifiable(b).length < 3) continue;
		const f = NORMAL[b.doorSide ?? "bottom"];
		const s = [-f[1], f[0]];
		const across = f[0] !== 0 ? b.h : b.w;
		const wall = { x: b.x + b.w / 2 + (f[0] * b.w) / 2, y: b.y + b.h / 2 + (f[1] * b.h) / 2 };
		let clear = 0;
		let n = 0;
		for (let d = 60; d <= 700; d += 40) {
			for (let u = -across / 2 - 200; u <= across / 2 + 200; u += 40) {
				n++;
				if (outdoors(wall.x + f[0] * d + s[0] * u, wall.y + f[1] * d + s[1] * u, 16)) clear++;
			}
		}
		const facing = { left: 4, right: 3, bottom: 2, top: 0 }[b.doorSide ?? "bottom"];
		const score = (clear / n) * 30 + facing;
		if (score > bestScore) {
			bestScore = score;
			best = b;
		}
	}
	return best;
}

/**
 * 2. BUILD. BARRICADE. HOLD. 22:00, a house held by four survivors: a wall of wooden barricades on the build grid
 * across the front yard (placement.ts: the 128-unit grid, turned along the wall), the steel barricade snapped into
 * the front door and wood into the windows (EDI-13), two turrets behind the wall wired to a battery box and a lamp
 * on the lawn (ELE-01..04, powered as the server's PowerSet says); the horde piling against the wall in the fire of
 * the turrets and the survivors, two of them behind the wall, two at the windows of the house with its roof off.
 */
function thumbBuildBarricadeHold() {
	const b = findFortHouse();
	const hour = 22;
	const zoom = 1.5;
	const G = 128;
	const f = NORMAL[b.doorSide ?? "bottom"];
	const s = [-f[1], f[0]];
	const across = f[0] !== 0 ? b.h : b.w;
	const bx = b.x + b.w / 2;
	const by = b.y + b.h / 2;
	const wall = { x: bx + (f[0] * b.w) / 2, y: by + (f[1] * b.h) / 2 };
	/** a point in the front frame: `d` out from the front wall, `u` along it */
	const at = (d, u) => ({ x: wall.x + f[0] * d + s[0] * u, y: wall.y + f[1] * d + s[1] * u });
	const vwU = TW / zoom;
	const vhU = TH / zoom;
	// the wall of barricades a grid line out in the yard, then the camera on the fight: the house's far wall at the
	// edge of the picture, the wall of barricades and the horde across the rest
	const D = 260;
	const lineAt = at(D, 0);
	const horizontal = f[0] === 0;
	const lineCoord = horizontal ? Math.round(lineAt.y / G) * G : Math.round(lineAt.x / G) * G;
	const depth = horizontal ? b.h : b.w;
	const dCam = (horizontal ? vhU : vwU) / 2 - 40 - depth;
	const cam = at(dCam, horizontal ? 0 : f[0] < 0 ? -vhU * 0.07 : vhU * 0.07);
	const sc = { vw: TW, vh: TH, zoom, cx: cam.x, cy: cam.y, hour, clock: 0.7 };
	/** where a world point lands on the picture */
	const screen = p => ({ x: (p.x - sc.cx) * zoom + TW / 2, y: (p.y - sc.cy) * zoom + TH / 2 });
	/** in the clear part of the picture: under the title band, off the bottom strip Roblox covers */
	const clearOfTitle = p => {
		const q = screen(p);
		return q.y > 400 && q.y < TH - 140 && q.x > 120 && q.x < TW - 120;
	};
	sc.roofOff = [b];
	const placed = [];
	const place = (idx, r, powered) => {
		if (!rectFree(r)) return undefined;
		const p = construct(idx, r, powered);
		placed.push(p);
		return p;
	};
	// the wall: one barricade per grid cell along it, where nothing stands in the way
	const span = across / 2 + 320;
	const pieces = [];
	for (let u = -span; u <= span; u += G) {
		const c = at(D, u);
		const r = horizontal
			? { x: Math.floor(c.x / G) * G, y: lineCoord - (f[1] > 0 ? 0 : 32), w: 128, h: 32 }
			: { x: lineCoord - (f[0] > 0 ? 0 : 32), y: Math.floor(c.y / G) * G, w: 32, h: 128 };
		if (pieces.some(p => p.x === r.x && p.y === r.y)) continue;
		const p = place(10, r);
		if (p !== undefined) pieces.push(p);
	}
	// the house's own openings: steel in the front door, wood in the windows (snapped, EDI-13)
	for (const o of fortifiable(b)) {
		const idx = o.main ? 12 : 10;
		const def = PLACEABLES[idx];
		const r = snapToOpening(world, def, {
			x: o.x + o.w / 2 - def.w / 2,
			y: o.y + o.h / 2 - def.h / 2,
			w: def.w,
			h: def.h,
		});
		place(idx, r);
	}
	// behind the wall: two turrets on the grid, a battery box between them, a lamp by the house -- each on the first
	// free grid cell near where it is wanted, in the clear part of the picture
	const onCell = (idx, d, us) => {
		const def = PLACEABLES[idx];
		for (const u of us) {
			for (const dd of [0, -G / 2, G / 2]) {
				const q = at(d + dd, u);
				const g = onGrid(idx, q.x, q.y);
				const r = { x: g.x + (G - def.w) / 2, y: g.y + (G - def.h) / 2, w: def.w, h: def.h };
				if (!clearOfTitle({ x: r.x + r.w / 2, y: r.y + r.h / 2 })) continue;
				// between the house and the wall of barricades, never touching either
				const dist = f[0] !== 0 ? (r.x + r.w / 2 - wall.x) * f[0] : (r.y + r.h / 2 - wall.y) * f[1];
				if (dist < def.w / 2 + 24 || dist > D - def.w / 2 - 20) continue;
				const made = place(idx, r, true);
				if (made !== undefined) return made;
			}
		}
		return undefined;
	};
	const us = [];
	for (let u = -span; u <= span; u += G / 2) us.push(u);
	const byScreenY = (list, from) =>
		[...list].sort((p, q) => Math.abs(screen(at(D, p)).y - from) - Math.abs(screen(at(D, q)).y - from));
	const turrets = [onCell(2, D - 100, byScreenY(us, 520)), onCell(2, D - 100, byScreenY(us, 860))].filter(t => t);
	onCell(6, D - 190, byScreenY(us, 690));
	onCell(4, D - 170, byScreenY(us, 960));
	// the survivors: two behind the wall, two at the windows of the house
	const rnd = prng(TOWN_SEED ^ 0xb4);
	const survivors = [];
	const out = Math.atan2(f[1], f[0]);
	for (const u of [-70, 90]) {
		const p = freeSpot(at(D - 70, u).x, at(D - 70, u).y, 40, outdoors);
		if (p !== undefined) survivors.push({ ...p, angle: out + (rnd() - 0.5) * 0.5 });
	}
	const windows = fortifiable(b)
		.filter(o => o.kind === "window")
		.sort((p, q) => (p.side === b.doorSide ? 0 : 1) - (q.side === b.doorSide ? 0 : 1));
	for (const o of windows.slice(0, 2)) {
		const [nx, ny] = NORMAL[o.side];
		const inside = (x, y) => free(x, y, 20) && buildingAt(world, x, y) === b;
		const p = freeSpot(o.x + o.w / 2 - nx * 64, o.y + o.h / 2 - ny * 64, 50, inside);
		if (p !== undefined) survivors.push({ ...p, angle: Math.atan2(ny, nx) });
	}
	const kit = [
		{ weapon: 10, outfit: OutfitLook.None, flashlight: true },
		{ weapon: 16, outfit: OutfitLook.Cowboy, flashlight: true },
		{ weapon: 13, outfit: OutfitLook.None, flashlight: true },
		{ weapon: 2, outfit: OutfitLook.None, flashlight: false },
	];
	survivors.forEach((p, i) => Object.assign(p, kit[i], { phase: i * 0.7 }));
	sc.survivors = survivors;
	// the horde: piled against the wall, and more coming out of the dark
	const cast = [];
	for (const p of pieces) {
		for (const lat of [-34, 30]) {
			const c = { x: p.x + p.w / 2 + s[0] * lat + f[0] * 50, y: p.y + p.h / 2 + s[1] * lat + f[1] * 50 };
			if (rnd() < 0.8 && outdoors(c.x, c.y, 18)) {
				cast.push({ ...c, angle: out + Math.PI + (rnd() - 0.5) * 0.5, type: rnd() < 0.15 ? 4 : 1 });
			}
		}
	}
	const types = [1, 1, 2, 1, 1, 4, 1, 3, 1, 1, 5, 1];
	for (let tries = 0; cast.length < 40 && tries < 8000; tries++) {
		// most of them in the second and third rank, pressing on the wall; a few further out in the dark
		const d = D + 105 + (rnd() < 0.7 ? rnd() * 150 : 150 + rnd() * 330);
		const p = at(d, (rnd() - 0.5) * (span * 2 + 100));
		if (!outdoors(p.x, p.y, 22)) continue;
		if (cast.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 58)) continue;
		cast.push({ ...p, angle: out + Math.PI + (rnd() - 0.5) * 0.6, type: types[cast.length % types.length] });
	}
	sc.zombies = cast.map(c => zombie(sc, { ...c, phase: rnd() * 6.28, fade: 0.75 }));
	// the fight: the turrets and the survivors firing at the nearest lit zombie over the wall
	const shots = [];
	const lit = sc.zombies.filter(z => z.alpha > 0.9 && clearOfTitle(z));
	const taken = [];
	const target = (x, y, maxD) => {
		let best;
		for (const z of lit) {
			if (taken.includes(z)) continue;
			const d = Math.hypot(z.x - x, z.y - y);
			if (d > maxD) continue;
			if (best === undefined || d < best.d) best = { z, d };
		}
		if (best !== undefined) taken.push(best.z);
		return best?.z;
	};
	for (const t of turrets) {
		const tx = t.x + t.w / 2;
		const ty = t.y + t.h / 2;
		const z = target(tx, ty, 300);
		if (z === undefined) continue;
		// the turret's hitscan (server/sim/turrets.ts: the survivors' raycast), its line from the muzzle
		const a = Math.atan2(z.y - ty, z.x - tx);
		for (const t2 of fire(sc, tx, ty, a, 10, 0.15)) {
			t2.x1 = tx + Math.cos(a) * TURRET_MUZZLE;
			t2.y1 = ty + Math.sin(a) * TURRET_MUZZLE;
			shots.push(t2);
		}
	}
	for (const p of survivors) {
		if (p.weapon === 2) continue;
		const z = target(p.x, p.y, buildingAt(world, p.x, p.y) === b ? 420 : 380);
		if (z === undefined) continue;
		const a = Math.atan2(z.y - p.y, z.x - p.x);
		const shot = fire(sc, p.x, p.y, a, p.weapon, 0.12);
		// only a clear line: a survivor at a window does not fire into their own wall
		if (!shot.some(t => t.hit)) continue;
		p.angle = a;
		shots.push(...shot);
	}
	sc.shots = shots;
	const img = drawMoment(sc);
	vignette(img, 0.3);
	topBand(img, 360, 0.62);
	title(
		img,
		[
			[
				["BUILD.", BONE],
				["BARRICADE.", BONE],
			],
			[["HOLD.", BLOOD]],
		],
		64,
		56,
		12,
	);
	cornerMark(img);
	return img;
}

/**
 * The gun shop of the loot run: its entrance on a street (never up the picture, under the title), with the most
 * open ground in front of its door for the horde to come across.
 */
function findGunShop() {
	let best;
	let bestScore = -Infinity;
	for (const b of world.solids) {
		if (b.kind !== "building" || b.buildingType !== 9) continue;
		const f = NORMAL[b.doorSide ?? "bottom"];
		const door = { x: b.doorX ?? b.x + b.w / 2, y: b.doorY ?? b.y + b.h };
		let clear = 0;
		for (let d = 80; d <= 560; d += 40) {
			for (let u = -320; u <= 320; u += 40) {
				if (outdoors(door.x + f[0] * d - f[1] * u, door.y + f[1] * d + f[0] * u, 16)) clear++;
			}
		}
		// a side entrance: the shop on one side of the picture, the street across the other (a door down or up the
		// picture would need the whole height for the shop alone)
		const facing = { left: 30, right: 30, bottom: 0, top: -30 }[b.doorSide ?? "bottom"];
		const score = clear / 10 + facing;
		if (score > bestScore) {
			bestScore = score;
			best = b;
		}
	}
	return best;
}

/**
 * 3. LOOT THE GUN SHOP. Dusk (19:00: the light going, the zombies still seen), a gun shop with its roof off (EDI-04:
 * the survivors are inside): one at the gun rack where the loot is (the building's loot spot, EDI-03), one holding
 * the doorway with a pump shotgun, its five pellets fanning into the first of the horde; the street behind them full
 * of zombies coming, the ones that heard the shots still only suspicious (the gold "?", IA-02/IA-05).
 */
function thumbLootTheGunShop() {
	const b = findGunShop();
	const hour = Number(argOf("shop-hour", 16));
	const zoom = 2.25;
	const f = NORMAL[b.doorSide ?? "bottom"];
	const s = [-f[1], f[0]];
	const mainDoor = fortifiable(b).find(o => o.main) ?? { x: b.x, y: b.y + b.h / 2 - 56, w: 20, h: 112 };
	const dx0 = mainDoor.x + mainDoor.w / 2;
	const dy0 = mainDoor.y + mainDoor.h / 2;
	/** the shop's front frame: `d` out of its door (negative: inside), `u` along its front */
	const at = (d, u) => ({ x: dx0 + f[0] * d + s[0] * u, y: dy0 + f[1] * d + s[1] * u });
	// the doorway a third of the way across: the street and the horde on one side, the sales floor, the display case
	// and the back room with the safe on the other (a side entrance: findGunShop)
	const sc = { vw: TW, vh: TH, zoom, cx: dx0 - f[0] * 130, cy: dy0 - f[1] * 130 - 20, hour, clock: 1.1 };
	sc.roofOff = [b];
	const inside = (x, y) => free(x, y, 20) && buildingAt(world, x, y) === b;
	const onScreen = p => Math.abs((p.x - sc.cx) * zoom) < TW / 2 - 60 && Math.abs((p.y - sc.cy) * zoom) < TH / 2 - 60;
	const rnd = prng(TOWN_SEED ^ 0x9a);
	const out = Math.atan2(f[1], f[0]);
	// the guard in the doorway with a pump shotgun; the looter at the loot spot furthest in (the safe, EDI-03),
	// turned to it; a third at the window the horde is climbing through
	const guard = freeSpot(at(-58, 26).x, at(-58, 26).y, 30, inside) ?? at(-58, 26);
	const spots = (b.lootSpots ?? [])
		.filter(onScreen)
		.sort((p, q) => Math.hypot(q.x - dx0, q.y - dy0) - Math.hypot(p.x - dx0, p.y - dy0));
	const spot = spots[0] ?? at(-300, 0);
	const looter = freeSpot(spot.x, spot.y, 40, inside) ?? spot;
	const safe = querySolids(world, b.x, b.y, b.x + b.w, b.y + b.h, []).find(p => p.tags === "safe");
	const lookAt = safe !== undefined ? { x: safe.x + safe.w / 2, y: safe.y + safe.h / 2 } : { x: spot.x, y: spot.y };
	sc.survivors = [
		{ ...guard, angle: out, weapon: 16, outfit: OutfitLook.Cowboy, phase: 0.4 },
		{ ...looter, angle: Math.atan2(lookAt.y - looter.y, lookAt.x - looter.x), weapon: 13, phase: 1.3 },
	];
	// the horde: two at the doorway, one climbing in through a front window in the picture (EDI-10), the street full
	const cast = [];
	for (const u of [-30, 34]) {
		const p = at(46, u);
		if (outdoors(p.x, p.y, 18)) cast.push({ ...p, type: 1, aware: 3 });
	}
	const win = fortifiable(b)
		.filter(o => o.kind === "window" && o.side === b.doorSide && onScreen({ x: o.x + o.w / 2, y: o.y + o.h / 2 }))
		.sort((p, q) => q.y - p.y)[0];
	if (win !== undefined) {
		const w0 = { x: win.x + win.w / 2, y: win.y + win.h / 2 };
		cast.push({ ...w0, type: 1, aware: 3, climbing: true });
		const p = freeSpot(w0.x - f[0] * 110, w0.y - f[1] * 110 - 30, 40, inside);
		if (p !== undefined) {
			sc.survivors.push({ ...p, angle: Math.atan2(w0.y - p.y, w0.x - p.x), weapon: 10, phase: 2.1, aimAt: w0 });
		}
	}
	const types = [1, 1, 4, 1, 1, 2, 1, 1, 1, 3, 1, 5, 1, 1, 1, 1];
	for (let tries = 0; cast.length < 30 && tries < 10000; tries++) {
		const d = 110 + Math.pow(rnd(), 0.75) * 720;
		const u = (rnd() - 0.5) * (300 + d * 1.6);
		const p = at(d, u);
		if (!outdoors(p.x, p.y, 22) || !onScreen(p)) continue;
		if (cast.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 62)) continue;
		// the back of the crowd only heard the shots: suspicious, walking over to look (IA-02, IA-05)
		cast.push({ ...p, type: types[cast.length % types.length], aware: d > 400 ? 1 : 3 });
	}
	sc.zombies = cast.map(c =>
		zombie(sc, {
			...c,
			angle:
				c.climbing === true
					? out + Math.PI
					: Math.atan2(dy0 - c.y, dx0 - c.x) + (rnd() - 0.5) * (c.aware === 1 ? 0.9 : 0.35),
			phase: rnd() * 6.28,
		}),
	);
	// the guard fires into the nearest one in the street
	const near = sc.zombies
		.filter(z => buildingAt(world, z.x, z.y) !== b && Math.hypot(z.x - guard.x, z.y - guard.y) > 90)
		.sort((p, q) => Math.hypot(p.x - guard.x, p.y - guard.y) - Math.hypot(q.x - guard.x, q.y - guard.y))[0];
	if (near !== undefined) sc.survivors[0].angle = Math.atan2(near.y - guard.y, near.x - guard.x);
	sc.shots = fire(sc, guard.x, guard.y, sc.survivors[0].angle, 16, 0.14);
	// the one at the window fires at the climber, if the line is clear (a window's frame lets shots through)
	const sentry = sc.survivors.find(p => p.aimAt !== undefined);
	if (sentry !== undefined) {
		const shot = fire(sc, sentry.x, sentry.y, sentry.angle, 10, 0.1);
		if (shot.some(t => t.hit)) sc.shots.push(...shot);
	}
	const img = drawMoment(sc);
	vignette(img, 0.3);
	topBand(img, 380, 0.6);
	title(img, [[["LOOT THE", BONE]], [["GUN SHOP", AMBER]]], 64, 56, 12);
	cornerMark(img);
	return img;
}

/** a boss of the moment: the server's record (BossState), for bossView.drawBoss and the shots' rays */
function boss(type, x, y, angle, extra = {}) {
	return {
		id: 1,
		type,
		x,
		y,
		hp: 1,
		hpMax: 1,
		hpRecover: 0,
		damage: 0,
		exp: 0,
		moveSpeed: 0,
		angle,
		attackCd: 0,
		dead: false,
		hitFlash: 0,
		moveCycle: 0,
		...extra,
	};
}

/**
 * 4. DEFEAT THE BOSSES. A boss on its plaza (world.bossAnchors, where the game wakes it: CON-03), three survivors
 * round it firing, a few of the horde drawn in. `BOSS` picks which (1 centipede, 2 rafflesia, 3 giant, 4 hedgehog).
 */
function thumbDefeatTheBosses(type = Number(argOf("boss", 1)), hour = Number(argOf("boss-hour", 21))) {
	const a = world.bossAnchors.find(x => x.type === type) ?? world.bossAnchors[0];
	const zoom = type === 1 ? 1.5 : 2;
	const vwU = TW / zoom;
	const vhU = TH / zoom;
	const rnd = prng(TOWN_SEED ^ (0xb055 + type));
	const sc = { vw: TW, vh: TH, zoom, cx: a.x + vwU * 0.06, cy: a.y - vhU * 0.02, hour, clock: 0.3 };
	// the group, below and left of the boss, facing it
	const group = [
		[-250, 130],
		[-60, 200],
		[170, 180],
	];
	const kit = [
		{ weapon: 13, outfit: OutfitLook.None, flashlight: true },
		{ weapon: 18, outfit: OutfitLook.Cowboy, flashlight: true },
		{ weapon: 16, outfit: OutfitLook.None, flashlight: true },
	];
	const bossAt = { x: a.x + 40, y: a.y - 20 };
	sc.survivors = group.map(([ox, oy], i) => {
		const p = freeSpot(a.x + ox, a.y + oy, 60, outdoors) ?? { x: a.x + ox, y: a.y + oy };
		return { ...p, angle: Math.atan2(bossAt.y - p.y, bossAt.x - p.x), ...kit[i], phase: i };
	});
	if (type === 1) {
		// the centipede: its head lunging at the group, the chain of 50 plates swept round behind it (bossBrain's
		// serpent: each plate pulled to 30 u of the one ahead)
		const bodyX = [];
		const bodyY = [];
		let px = bossAt.x;
		let py = bossAt.y;
		let heading = Math.atan2(sc.survivors[1].y - py, sc.survivors[1].x - px) + Math.PI;
		for (let i = 0; i < 50; i++) {
			bodyX.push(px);
			bodyY.push(py);
			heading += 0.085 + Math.sin(i * 0.25) * 0.05;
			px += Math.cos(heading) * 30;
			py += Math.sin(heading) * 30;
		}
		sc.bosses = [
			boss(1, bodyX[0], bodyY[0], Math.atan2(bodyY[0] - bodyY[1], bodyX[0] - bodyX[1]), {
				bodyX,
				bodyY,
				bodyNumber: 50,
			}),
		];
	} else {
		sc.bosses = [
			boss(type, bossAt.x, bossAt.y, Math.atan2(sc.survivors[1].y - bossAt.y, sc.survivors[1].x - bossAt.x), {
				moveCycle: 90,
			}),
		];
	}
	const cast = [];
	for (let tries = 0; cast.length < 6 && tries < 3000; tries++) {
		const p = { x: a.x + (rnd() - 0.5) * vwU * 0.9, y: a.y + (rnd() - 0.5) * vhU * 0.7 };
		if (!outdoors(p.x, p.y, 22) || Math.hypot(p.x - bossAt.x, p.y - bossAt.y) < 260) continue;
		if (sc.survivors.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 120)) continue;
		cast.push({ ...p, type: rnd() < 0.2 ? 4 : 1 });
	}
	sc.zombies = cast.map(c => {
		const t = sc.survivors[Math.floor(rnd() * 3)];
		return zombie(sc, { ...c, angle: Math.atan2(t.y - c.y, t.x - c.x), phase: rnd() * 6.28, fade: 0.6 });
	});
	sc.shots = [];
	for (const p of sc.survivors) {
		const tx = type === 1 ? sc.bosses[0].bodyX[6 + Math.floor(rnd() * 10)] : bossAt.x;
		const ty = type === 1 ? sc.bosses[0].bodyY[6 + Math.floor(rnd() * 10)] : bossAt.y;
		p.angle = Math.atan2(ty - p.y, tx - p.x) + (rnd() - 0.5) * 0.08;
		sc.shots.push(...fire(sc, p.x, p.y, p.angle, p.weapon, 0.12 + rnd() * 0.06));
	}
	const img = drawMoment(sc);
	vignette(img, 0.3);
	topBand(img, 340, 0.6);
	title(img, [[["DEFEAT THE", BONE]], [["BOSSES", BLOOD]]], 64, 56, 12);
	cornerMark(img);
	return img;
}

/**
 * The piece of town with the most landmarks in the part of the picture the title leaves free (its lower 60 %): the
 * college campus, the gas station, the school, the hospital, the market, a park, shops and houses -- the overview
 * of a world's town. `w` x `h` is the view in units; answers its centre.
 */
function findOverview(w, h) {
	const WEIGHT = { 3: 6, 4: 6, 5: 8, 6: 3, 7: 5, 8: 3, 9: 4, 10: 3, 11: 3, 12: 9 };
	let best;
	let bestScore = -Infinity;
	for (let cy = h / 2 + 200; cy < world.height - h / 2 - 200; cy += 256) {
		for (let cx = w / 2 + 200; cx < world.width - w / 2 - 200; cx += 256) {
			const r = { x: cx - w / 2 + 60, y: cy - h / 2 + h * 0.4, w: w - 120, h: h * 0.6 - 60 };
			const list = querySolids(world, r.x, r.y, r.x + r.w, r.y + r.h, []);
			const kinds = {};
			let houses = 0;
			for (const s of list) {
				if (s.kind !== "building") continue;
				const share =
					(Math.max(0, Math.min(s.x + s.w, r.x + r.w) - Math.max(s.x, r.x)) *
						Math.max(0, Math.min(s.y + s.h, r.y + r.h) - Math.max(s.y, r.y))) /
					(s.w * s.h);
				if (share < 0.75) continue;
				const t = s.buildingType >= 12 ? 12 : s.buildingType === 2 ? 1 : s.buildingType;
				kinds[t] = true;
				if (t === 1) houses++;
			}
			const park = world.lots.some(
				l => l.kind === "park" && l.x < r.x + r.w && l.x + l.w > r.x && l.y < r.y + r.h && l.y + l.h > r.y,
			);
			let score = Math.min(houses, 4) + (park ? 5 : 0);
			for (const k of Object.keys(kinds)) score += WEIGHT[k] ?? 0;
			if (score > bestScore) {
				bestScore = score;
				best = { x: cx, y: cy };
			}
		}
	}
	return best;
}

/**
 * 5. A NEW TOWN EVERY WORLD. The town from above at 10:00, as the lobby shows it behind the menus (UI-10): the piece
 * of `generateTown(seed)` with the most landmarks, a group of survivors crossing it and a few of the horde wandering
 * the streets (idle: no marks). Every world ends when its last survivor falls and the next one is a new town, on a
 * new seed (MP-22).
 */
function thumbNewTown() {
	const zoom = Number(argOf("town-zoom", 0.5));
	const vwU = TW / zoom;
	const vhU = TH / zoom;
	const c = findOverview(vwU, vhU);
	const sc = { vw: TW, vh: TH, zoom, cx: c.x, cy: c.y, hour: 10, clock: 0.5 };
	const rnd = prng(TOWN_SEED ^ 0x70);
	// the group: three survivors walking together on the open ground nearest the middle of the free part
	const mid = { x: c.x + vwU * 0.05, y: c.y + vhU * 0.18 };
	const lead = freeSpot(mid.x, mid.y, 500, (x, y) => outdoors(x, y, 60)) ?? mid;
	const heading = rnd() * Math.PI * 2;
	sc.survivors = [
		[0, 0],
		[-46, 40],
		[-52, -38],
	].map(([fwd, side], i) => {
		const p = {
			x: lead.x + Math.cos(heading) * fwd - Math.sin(heading) * side,
			y: lead.y + Math.sin(heading) * fwd + Math.cos(heading) * side,
		};
		return {
			...p,
			angle: heading,
			weapon: [2, 10, 6][i],
			outfit: i === 1 ? OutfitLook.Cowboy : OutfitLook.None,
			phase: i * 1.7,
			amp: 1,
		};
	});
	// a few of the horde wandering the streets, far from the group
	const cast = [];
	for (let tries = 0; cast.length < 14 && tries < 6000; tries++) {
		const p = { x: c.x + (rnd() - 0.5) * vwU * 0.95, y: c.y - vhU * 0.1 + rnd() * vhU * 0.6 };
		if (!outdoors(p.x, p.y, 22) || Math.hypot(p.x - lead.x, p.y - lead.y) < 450) continue;
		if (cast.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 200)) continue;
		cast.push({
			...p,
			type: [1, 1, 1, 4, 1, 2][cast.length % 6],
			aware: 0,
			angle: rnd() * Math.PI * 2,
			phase: rnd() * 6,
		});
	}
	sc.zombies = cast.map(z => zombie(sc, z));
	const img = drawMoment(sc);
	vignette(img, 0.25);
	topBand(img, 380, 0.65);
	title(img, [[["A NEW TOWN", AMBER]], [["EVERY WORLD", BONE]]], 64, 56, 12);
	cornerMark(img);
	return img;
}

const THUMBS = {
	"survive-the-night": { file: "01-survive-the-night.png", draw: thumbSurviveTheNight },
	"build-barricade-hold": { file: "02-build-barricade-hold.png", draw: thumbBuildBarricadeHold },
	"loot-the-gun-shop": { file: "03-loot-the-gun-shop.png", draw: thumbLootTheGunShop },
	"defeat-the-bosses": { file: "04-defeat-the-bosses.png", draw: () => thumbDefeatTheBosses() },
	"new-town-every-world": { file: "05-new-town-every-world.png", draw: thumbNewTown },
};

// ---------------------------------------------------------------- the icon (512 x 512, shown down to ~50 px, cropped round)

const IW = 512;

/** a clear stretch of a lane of the quiet street (nothing parked, planted or built in a `size` square round it) */
function clearLane(size) {
	const st = findQuietStreet();
	const cy = st.road.y + 110;
	for (let i = 0; i < 60; i++) {
		const x = st.x + (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * 64;
		const h = size / 2 + 40;
		if (querySolids(world, x - h, cy - h, x + h, cy + h, []).length === 0) return { x, y: cy };
	}
	return { x: st.x, y: cy };
}

/**
 * The icon's moment, at 3.5-5x (14-20 px a texel): night on a lane of the quiet street, one survivor with a pistol
 * and a flashlight lighting the walkers that have seen them (the red "!"). Positions are fractions of the square;
 * the survivor may stand outside it (the light comes from below the picture).
 */
function iconMoment({ zoom = 5, you = [0.3, 0.74], them = [], hour = 22, shoot = false }) {
	const vU = IW / zoom;
	const c = clearLane(vU);
	const P = ([fx, fy]) => ({ x: c.x + (fx - 0.5) * vU, y: c.y + (fy - 0.5) * vU });
	const me = P(you);
	const first = them.length > 0 ? P(them[0]) : { x: me.x + 100, y: me.y - 60 };
	const sc = { vw: IW, vh: IW, zoom, cx: c.x, cy: c.y, hour, clock: 0.35 };
	sc.survivors = [
		{ ...me, angle: Math.atan2(first.y - me.y, first.x - me.x), weapon: 10, flashlight: true, phase: 0.5 },
	];
	sc.zombies = them.map(([fx, fy, type, fade], i) => {
		const p = P([fx, fy]);
		return zombie(sc, {
			...p,
			type,
			angle: Math.atan2(me.y - p.y, me.x - p.x),
			phase: 0.8 + i * 1.9,
			fade: fade ?? 1,
		});
	});
	sc.shots = shoot ? fire(sc, me.x, me.y, sc.survivors[0].angle, 10, 0.16) : [];
	return drawMoment(sc);
}

/** the corners of a square darkened towards a circle (the icon is shown cropped round in places) */
function roundVignette(img, inner = 0.62, k = 0.8) {
	const c = img.w / 2;
	shade(
		img,
		0,
		0,
		img.w,
		img.h,
		[4, 5, 12],
		(x, y) => k * smooth((Math.hypot(x + 0.5 - c, y + 0.5 - c) / c - inner) / (1.05 - inner)),
	);
}

/** the stacked wordmark at `px`, centred on x, its top at y */
function iconWordmark(img, px, y) {
	const m = wordmark(px, { stacked: true });
	blit(img, m, Math.round((img.w - m.w) / 2), y);
	return m;
}

const ICONS = {
	/** A: the stacked LAST TOWN over the moment: a survivor's shot into a walker that has seen them */
	"icon-a-shot": () => {
		const img = iconMoment({ zoom: 3.5, you: [0.28, 0.8], them: [[0.7, 0.8, 1]], shoot: true });
		shade(img, 0, 0, IW, IW, [6, 7, 16], (x, y) => 0.75 * (1 - smooth((y - 110) / 190)));
		roundVignette(img, 0.6, 0.8);
		iconWordmark(img, 7, 40);
		return img;
	},
	/** B: a walker's close-up in the survivor's light, its red "!" over it, the name under it */
	"icon-b-walker": () => {
		const img = iconMoment({ zoom: 4.5, you: [0.5, 1.2], them: [[0.5, 0.4, 1]], shoot: false });
		shade(img, 0, 0, IW, IW, [6, 7, 16], (x, y) => 0.72 * smooth((y - 300) / 80));
		roundVignette(img, 0.6, 0.8);
		iconWordmark(img, 7, 322);
		return img;
	},
	/** C: the horde -- three walkers coming into the light, three red "!", the name under them */
	"icon-c-horde": () => {
		const img = iconMoment({
			zoom: 3.5,
			you: [0.5, 1.25],
			them: [
				[0.24, 0.5, 1],
				[0.5, 0.42, 1],
				[0.76, 0.5, 1],
			],
			shoot: false,
		});
		shade(img, 0, 0, IW, IW, [6, 7, 16], (x, y) => 0.72 * smooth((y - 300) / 80));
		roundVignette(img, 0.6, 0.8);
		iconWordmark(img, 7, 322);
		return img;
	},
};
/** the one the game page uses (docs/promo/README.md says why) */
const ICON_PICK = "icon-c-horde";

// ---------------------------------------------------------------- the readability previews

/** a sheet of images on the page's dark grey, each with its label above: what the store shows at its sizes */
function sheet(rows, label = true) {
	const pad = 24;
	const head = label ? 28 : 0;
	const W = Math.max(...rows.map(r => r.reduce((s, x) => s + x.img.w + pad, pad)));
	const H = rows.reduce((s, r) => s + Math.max(...r.map(x => x.img.h)) + head + pad, pad);
	const img = canvas(W, H, [36, 38, 46, 255]);
	let y = pad;
	for (const r of rows) {
		let x = pad;
		for (const it of r) {
			if (label) drawText(img, it.label.toUpperCase(), x, y, 2, [226, 222, 212]);
			blit(img, it.img, x, y + head);
			x += it.img.w + pad;
		}
		y += Math.max(...r.map(x => x.img.h)) + head + pad;
	}
	return img;
}

/** the icon as Roblox shows it in places: cropped to a circle */
function circleCrop(src) {
	const out = canvas(src.w, src.h);
	const c = src.w / 2;
	for (let y = 0; y < src.h; y++) {
		for (let x = 0; x < src.w; x++) {
			const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
			const a = Math.min(1, Math.max(0, c - d + 0.5));
			const i = (y * src.w + x) * 4;
			src.data.copy(out.data, i, i, i + 3);
			out.data[i + 3] = Math.round(src.data[i + 3] * a);
		}
	}
	return out;
}

// ---------------------------------------------------------------- main

function writePNG(file, img, opaque) {
	mkdirSync(dirname(file), { recursive: true });
	const bytes = encodePNG(img, opaque);
	writeFileSync(file, bytes);
	console.log(
		`  ${relative(ROOT, file).padEnd(52)} ${`${img.w}x${img.h}`.padEnd(10)} ${(bytes.length / 1024).toFixed(0)} KB`,
	);
	return bytes.length;
}

const wants = name => ONLY === undefined || ONLY.includes(name);
console.log(`render-promo: town seed ${TOWN_SEED}, out ${relative(ROOT, OUT) || OUT}`);
const made = {};
for (const [name, t] of Object.entries(THUMBS)) {
	if (!wants("thumbnails") && !wants(name)) continue;
	const img = t.draw();
	clearBuilt();
	writePNG(join(OUT, "thumbnails", t.file), img, true);
	made[name] = img;
}
const icons = {};
if (wants("icon") || wants("previews")) {
	for (const [name, draw] of Object.entries(ICONS)) {
		const img = draw();
		clearBuilt();
		icons[name] = img;
		if (wants("icon")) writePNG(join(OUT, "icon", `${name}.png`), img, true);
	}
	if (wants("icon")) writePNG(join(OUT, "icon", "icon.png"), icons[ICON_PICK], true);
}
if (wants("logo")) {
	writePNG(join(OUT, "logo", "last-town-logo.png"), wordmark(12, { sub: true }), false);
	writePNG(join(OUT, "logo", "last-town-logo-stacked.png"), wordmark(12, { sub: true, stacked: true }), false);
	writePNG(join(OUT, "logo", "last-town-wordmark.png"), wordmark(6), false);
}
if (wants("previews")) {
	// every thumbnail at the sizes the site and the app show them (480 x 270 on a phone's home row, 256 x 144 in a
	// list), and every icon at 512, 150 and 50, square and cropped round
	for (const [name, t] of Object.entries(THUMBS)) {
		if (made[name] === undefined) made[name] = decodePNG(readFileSync(join(OUT, "thumbnails", t.file)));
	}
	const thumbRows = Object.entries(made).map(([name, img]) => [
		{ label: `${name} 480x270`, img: downscale(img, 480, 270) },
		{ label: "256x144", img: downscale(img, 256, 144) },
	]);
	writePNG(join(OUT, "previews", "thumbnails.png"), sheet(thumbRows), true);
	const iconRows = Object.entries(icons).map(([name, img]) => [
		{ label: `${name}${name === ICON_PICK ? " (used)" : ""}`, img: downscale(img, 256, 256) },
		{ label: "150", img: downscale(img, 150, 150) },
		{ label: "round", img: circleCrop(downscale(img, 150, 150)) },
		{ label: "50", img: downscale(img, 50, 50) },
	]);
	writePNG(join(OUT, "previews", "icons.png"), sheet(iconRows), true);
	// the transparent logos over the night and over a light page: they must read on both
	const logos = [wordmark(6, { sub: true }), wordmark(6, { sub: true, stacked: true }), wordmark(4)];
	const panel = rgb => {
		const w = Math.max(...logos.map(l => l.w)) + 48;
		const h = logos.reduce((s, l) => s + l.h + 24, 24);
		const p = canvas(w, h, [...rgb, 255]);
		let y = 24;
		for (const l of logos) {
			blit(p, l, 24, y);
			y += l.h + 24;
		}
		return p;
	};
	writePNG(
		join(OUT, "previews", "logos.png"),
		sheet([
			[
				{ label: "on the night", img: panel([22, 26, 44]) },
				{ label: "on a light page", img: panel([214, 222, 230]) },
			],
		]),
		true,
	);
}
