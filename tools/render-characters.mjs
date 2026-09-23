#!/usr/bin/env node
/*
 * The characters rendered with the REAL drawing code, over the textured town, before and after their pixel art
 * (docs/DESIGN_RULES.md ART-08..ART-11):
 *
 *   node tools/render-characters.mjs                        # every scene into docs/art/characters/{before,after,compare}
 *   node tools/render-characters.mjs --only zombies --out /tmp/chars
 *
 * "before" is what the game draws today, with no character asset id: the flat survivor, humanoid and pets
 * (client/view/survivorView.ts, humanoidView.ts, cosmeticsView.ts), over the town's textures, which ARE live in the
 * owner's Studio. "after" is the same frame with the character sheets handed in as local PNGs
 * (design/world-art/*.png, read by the rasteriser): what the game shows once `npm run cloud -- upload-art` gives
 * them ids. Both go through the same functions the client calls (drawSurvivor, drawZombie, drawPet), the renderer
 * and tools/gui-raster.mjs; nothing is re-implemented. "compare" stacks the two, before on top, pixels unscaled.
 *
 * Scenes: the survivor in eight facings with each outfit; the weapons in the hands (idle and mid-swing); hit, poison
 * and downed; each pet standing and on the move; each zombie variant in eight facings and in its special poses; a
 * horde of 60 by day and the same street at night, lit only by the survivors (LUZ-02); a fight with hit flashes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePNG, encodePNG } from "./png-lite.mjs";
import { countSprites, rasterise } from "./gui-raster.mjs";
import { drawText } from "./pixel-font.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const argv = process.argv.slice(2);
const argOf = (k, d) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const OUT = resolve(argOf("out", join(ROOT, "docs", "art", "characters")));
const ONLY = argOf("only", undefined);

const { installShims } = await import("./luau-shim.mjs");
const { SRC, require } = installShims({ seed: 3 });
const { installFakeGui } = await import("./fake-gui.mjs");
const gui = installFakeGui();

const { COLORS, Z } = require(join(SRC, "shared/engine/colors.ts"));
const { Camera } = require(join(SRC, "shared/engine/camera.ts"));
const { Renderer, LightMap } = require(join(SRC, "shared/engine/renderer.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const { generateTown, pointInSolid, buildingAt } = require(join(SRC, "shared/game/world.ts"));
const { darkAlphaAt } = require(join(SRC, "shared/sim/clock.ts"));
const { WorldView } = require(join(SRC, "client/view/worldView.ts"));
const { WEAPONS, meleeReach } = require(join(SRC, "shared/data/weapons.ts"));
const { PetLook, OutfitLook, petFlies } = require(join(SRC, "shared/data/cosmetics.ts"));
const { ZOMBIES } = require(join(SRC, "shared/data/zombies.ts"));
const HV = require(join(SRC, "client/view/humanoidView.ts"));
const SV = require(join(SRC, "client/view/survivorView.ts"));
const CV = require(join(SRC, "client/view/cosmeticsView.ts"));
const PF = require(join(SRC, "client/view/petFollow.ts"));
const WA = require(join(SRC, "client/view/worldArt.ts"));
const { WORLD_ART } = require(join(SRC, "client/view/worldArtAssets.ts"));

const ART_DIR = join(ROOT, "design", "world-art");
const MANIFEST = JSON.parse(readFileSync(join(ART_DIR, "manifest.json"), "utf8"));
/** the character sheets: everything tools/character-art.mjs writes */
const CHARACTER_SHEETS = MANIFEST.textures.filter(t => t.kind === "sheet").map(t => t.name);
for (const t of MANIFEST.textures) {
	if (CHARACTER_SHEETS.some(n => t.name === `${n}Fill` || t.name === `${n}Rim`)) CHARACTER_SHEETS.push(t.name);
}
const LOCAL = "local:";

/** the town's art always on (it is live in the owner's Studio); the characters' only for "after" */
function setArt(characters) {
	const ids = {};
	for (const t of MANIFEST.textures) {
		if (!characters && CHARACTER_SHEETS.includes(t.name)) continue;
		ids[t.name] = LOCAL + t.name;
	}
	WA.overrideWorldArt(ids);
}

const images = new Map();
function localImage(id) {
	if (images.has(id)) return images.get(id);
	const file = id.startsWith(LOCAL) ? join(ART_DIR, `${id.slice(LOCAL.length)}.png`) : undefined;
	const img = file !== undefined && existsSync(file) ? decodePNG(readFileSync(file)) : undefined;
	if (img === undefined) console.warn(`  (no local file for ${id}: magenta)`);
	images.set(id, img);
	return img;
}

// ---------------------------------------------------------------- the stage

const world = generateTown(DESIGN.TOWN_SEED);

function stage(vw, vh, zoom, cx, cy) {
	const root = gui.make("Frame");
	root.Size = UDim2.fromOffset(vw, vh);
	const r = new Renderer(root, "Sprites");
	const dark = gui.make("Frame");
	dark.Parent = root;
	dark.BackgroundTransparency = 1;
	const cam = new Camera();
	cam.setView(vw, vh);
	r.setView(vw, vh);
	cam.zoom = zoom;
	cam.x = cx;
	cam.y = cy;
	return { root, r, cam, dark, vw, vh };
}

/** the sun of 10:00, or at night away from the nearest of `lights` */
function shadowFn(hour, lights) {
	const s = { x: 0, y: 0 };
	return (x, y, len) => {
		if (hour > 6 && hour < 18) {
			const rad = ((hour / 24) * 360 - 225) * (Math.PI / 180);
			s.x = Math.cos(rad) * len;
			s.y = -Math.sin(rad) * len;
			return s;
		}
		let best = lights[0] ?? { x, y: y - 1 };
		for (const l of lights) if (Math.hypot(l.x - x, l.y - y) < Math.hypot(best.x - x, best.y - y)) best = l;
		const dx = x - best.x;
		const dy = y - best.y;
		const d = Math.hypot(dx, dy);
		s.x = d < 1 ? 0 : (dx / d) * len;
		s.y = d < 1 ? len * 0.5 : (dy / d) * len;
		return s;
	};
}

/** plain bands of the town's ground textures, for the line-ups: each column group on its own ground */
const GROUNDS = [
	["grass", COLORS.grass],
	["asphalt", COLORS.road],
	["concrete", COLORS.sidewalk],
	["dirt", COLORS.dirtPath],
];
function drawBands(st, x0, y0, w, h, n) {
	const bw = w / n;
	for (let i = 0; i < n; i++) {
		const [name, color] = GROUNDS[i % GROUNDS.length];
		const id = WA.artId(name);
		const t = WORLD_ART[name];
		st.r.drawRect(st.cam, x0 + bw * i + bw / 2, y0 + h / 2, {
			w: bw,
			h,
			color,
			zIndex: 1,
			...(id !== undefined ? { image: id, scaleType: "tile", tileW: t.w * 4, tileH: t.h * 4 } : {}),
		});
	}
}

function survivorLook(x, y, angle, opts = {}) {
	const look = SV.createLook();
	look.x = x;
	look.y = y;
	look.angle = angle;
	look.outfit = opts.outfit ?? OutfitLook.None;
	look.weapon = WEAPONS[opts.weapon ?? 0];
	look.swingReach = meleeReach(look.weapon);
	look.feetPhase = opts.phase ?? 0;
	look.feetAmp = opts.amp ?? 0;
	look.flash = opts.flash ?? 0;
	look.poisoned = opts.poisoned ?? false;
	look.downed = opts.downed ?? false;
	look.swinging = opts.swing !== undefined;
	look.swingAngle = angle + (opts.swing ?? 0);
	look.clock = 0.4;
	return look;
}

function drawLook(st, look, shadow) {
	const so = shadow(look.x, look.y, 10);
	look.shadowX = so.x;
	look.shadowY = so.y;
	const trail = SV.createSwingTrail();
	if (look.swinging) {
		// mid-sweep: the blade already on its way (a fresh sweep would be drawn at its start)
		trail.drawn = true;
		trail.rel = -10;
	}
	SV.drawSurvivor(st.r, st.cam, look, trail);
}

function drawZombieAt(st, z, shadow) {
	const def = ZOMBIES.find(d => d.id === z.type) ?? ZOMBIES[0];
	const rad = def.radius * (z.big ? 1.4 : 1);
	const lift = z.air ? 22 : 0;
	const liftScale = 1 + lift / 100;
	const so = shadow(z.x, z.y, 10);
	st.r.drawCircle(st.cam, z.x + so.x, z.y + so.y, (rad * 2.1) / liftScale, {
		color: COLORS.shadow,
		alpha: 0.3 * (1 - lift / 70),
		zIndex: Z.actorShadow,
	});
	const up = st.cam.screenDirToWorld(0, -1);
	HV.drawZombie(
		st.r,
		st.cam,
		z.x + up.x * lift,
		z.y + up.y * lift,
		z.angle,
		(rad / 18) * liftScale,
		z.type,
		z.flash ?? 0,
		1,
		z.phase ?? 0.8,
		Z.zombie,
		z.windup ?? 0,
		lift > 0,
		z.rush ?? false,
		z.blink ?? false,
	);
}

function drawPetAt(st, p, shadow) {
	const f = PF.createPetFollower();
	f.x = p.x;
	f.y = p.y;
	f.angle = p.angle;
	f.started = true;
	f.moving = p.moving ?? 0;
	f.phase = p.phase ?? 0;
	f.lift = p.lift ?? 0;
	CV.drawPet(st.r, st.cam, f, p.look, p.clock ?? 0.1, shadow);
}

function label(img, text, x, y, px = 2) {
	drawText(img, text, x + 1, y + 1, px, [16, 16, 16]);
	drawText(img, text, x, y, px, [240, 240, 236]);
}

function finish(st, labels, hour = 10, lights = []) {
	st.r.endFrame();
	const darkness = darkAlphaAt(hour, false, false);
	if (darkness > 0.004) {
		const lm = new LightMap(st.dark, COLORS.overlayNight);
		lm.update(st.cam, darkness, lights);
	}
	const img = rasterise({ layer: st.r.layer, dark: st.dark, vw: st.vw, vh: st.vh }, COLORS.bg, localImage);
	for (const [text, x, y, px] of labels) label(img, text, x, y, px);
	return { img, counts: countSprites(st.r.layer) };
}

// ---------------------------------------------------------------- scenes

/** a spot on the town's open ground well away from buildings, for the line-ups (any x, y: the bands cover it) */
const LINEUP = { x: 60000, y: 60000 };
const FACINGS = [0, 1, 2, 3, 4, 5, 6, 7].map(i => (i * Math.PI) / 4);
const FACING_NAMES = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];

function sceneSurvivors() {
	const zoom = 3;
	const gap = 64;
	const rows = [
		["plain", OutfitLook.None],
		["Santa", OutfitLook.Santa],
		["Zombie costume", OutfitLook.Zombie],
		["Cowboy", OutfitLook.Cowboy],
	];
	const w = gap * FACINGS.length;
	const h = gap * rows.length + 20;
	const st = stage(w * zoom, h * zoom, zoom, LINEUP.x + w / 2, LINEUP.y + h / 2);
	const shadow = shadowFn(10, []);
	st.r.beginFrame();
	drawBands(st, LINEUP.x, LINEUP.y, w, h, 4);
	const labels = [];
	rows.forEach(([name, outfit], j) => {
		FACINGS.forEach((a, i) => {
			const look = survivorLook(LINEUP.x + gap * (i + 0.5), LINEUP.y + 20 + gap * (j + 0.5), a, {
				outfit,
				phase: i * 0.8,
				amp: i % 2,
			});
			drawLook(st, look, shadow);
		});
		labels.push([name, 6, (20 + gap * j) * zoom + 4, 2]);
	});
	FACING_NAMES.forEach((n, i) => labels.push([n, gap * (i + 0.5) * zoom - 6, 6, 2]));
	return finish(st, labels);
}

function sceneWeapons() {
	const zoom = 3;
	const gap = 88;
	const list = [
		["Dagger", 0],
		["Dagger swing", 0, 0.2],
		["Axe", 2],
		["Axe swing", 2, -0.3],
		["Bat", 6],
		["Bat swing", 6, 0.4],
		["Pistol", 10],
		["Rifle", 13],
		["Shotgun", 16],
		["Machine gun", 18],
		["Bow", 22],
		["Chainsaw swing", 5, 0],
	];
	const cols = 6;
	const w = gap * cols;
	const h = gap * 2 * 2;
	const st = stage(w * zoom, h * zoom, zoom, LINEUP.x + w / 2, LINEUP.y + h / 2);
	const shadow = shadowFn(10, []);
	st.r.beginFrame();
	drawBands(st, LINEUP.x, LINEUP.y, w, h, 3);
	const labels = [];
	list.forEach(([name, weapon, swing], k) => {
		const i = k % cols;
		const j = Math.floor(k / cols);
		for (const [row, a] of [
			[j * 2, 0],
			[j * 2 + 1, (3 * Math.PI) / 4],
		]) {
			const look = survivorLook(LINEUP.x + gap * (i + 0.35), LINEUP.y + gap * (row + 0.55), a, {
				weapon,
				swing,
				outfit: k % 4,
			});
			drawLook(st, look, shadow);
		}
		labels.push([name, gap * i * zoom + 4, gap * j * 2 * zoom + 4, 2]);
	});
	return finish(st, labels);
}

function sceneStates() {
	const zoom = 3;
	const gap = 80;
	const items = [
		["hit", { flash: 1 }],
		["hit (Santa)", { flash: 1, outfit: OutfitLook.Santa }],
		["fading hit", { flash: 0.4, outfit: OutfitLook.Cowboy }],
		["poisoned", { poisoned: true }],
		["poisoned (Zombie)", { poisoned: true, outfit: OutfitLook.Zombie }],
		["downed", { downed: true }],
		["downed (Santa)", { downed: true, outfit: OutfitLook.Santa }],
		["downed (Cowboy)", { downed: true, outfit: OutfitLook.Cowboy, phase: 1.6, amp: 1 }],
	];
	const w = gap * 4;
	const h = gap * 2 + 20;
	const st = stage(w * zoom, h * zoom, zoom, LINEUP.x + w / 2, LINEUP.y + h / 2);
	const shadow = shadowFn(10, []);
	st.r.beginFrame();
	drawBands(st, LINEUP.x, LINEUP.y, w, h, 4);
	const labels = [];
	items.forEach(([name, o], k) => {
		const i = k % 4;
		const j = Math.floor(k / 4);
		drawLook(st, survivorLook(LINEUP.x + gap * (i + 0.5), LINEUP.y + 20 + gap * (j + 0.5), 0.6, o), shadow);
		labels.push([name, gap * i * zoom + 4, (20 + gap * j) * zoom - 2, 2]);
	});
	return finish(st, labels);
}

function scenePets() {
	const zoom = 3;
	const gap = 110;
	const pets = [
		["Pigeon", PetLook.Pigeon],
		["White pigeon", PetLook.WhitePigeon],
		["Eagle", PetLook.Eagle],
		["Carolina", PetLook.Carolina],
		["Malamute", PetLook.Malamute],
		["Doberman", PetLook.Doberman],
	];
	const w = gap * pets.length;
	const h = gap * 2 + 24;
	const st = stage(w * zoom, h * zoom, zoom, LINEUP.x + w / 2, LINEUP.y + h / 2);
	const shadow = shadowFn(10, []);
	st.r.beginFrame();
	drawBands(st, LINEUP.x, LINEUP.y, w, h, 3);
	const labels = [];
	pets.forEach(([name, look], i) => {
		const cx = LINEUP.x + gap * (i + 0.5);
		// standing (a bird landed), facing the camera's bottom-left
		drawPetAt(st, { x: cx, y: LINEUP.y + 24 + gap * 0.5, angle: 2.2, look, clock: 0.2 }, shadow);
		// on the move: a dog mid-trot, a bird flying with its wings out
		const flies = petFlies(look);
		drawPetAt(
			st,
			{ x: cx, y: LINEUP.y + 24 + gap * 1.5, angle: -0.5, look, moving: 1, phase: 1.2, lift: flies ? 1 : 0 },
			shadow,
		);
		labels.push([name, gap * i * zoom + 4, 6, 2]);
	});
	return finish(st, labels);
}

function sceneZombies() {
	const zoom = 3;
	const gap = 76;
	const rows = [
		["Walker", { type: 1 }],
		["Big walker", { type: 1, big: true }],
		["Spitter", { type: 2 }],
		["Exploder", { type: 3 }],
		["Charger", { type: 4 }],
		["Jumper", { type: 5 }],
	];
	const specials = [
		["spitting", { type: 2, windup: 10 }],
		["fuse lit", { type: 3, blink: true }],
		["charging", { type: 4, rush: true }],
		["in the air", { type: 5, air: true }],
		["hit", { type: 1, flash: 1 }],
		["hit (big)", { type: 1, big: true, flash: 0.6 }],
	];
	const cols = FACINGS.length + 1;
	const w = gap * cols;
	const h = gap * rows.length + 20;
	const st = stage(w * zoom, h * zoom, zoom, LINEUP.x + w / 2, LINEUP.y + h / 2);
	const shadow = shadowFn(10, []);
	st.r.beginFrame();
	drawBands(st, LINEUP.x, LINEUP.y, w, h, 4);
	const labels = [];
	rows.forEach(([name, z], j) => {
		FACINGS.forEach((a, i) => {
			drawZombieAt(
				st,
				{ ...z, x: LINEUP.x + gap * (i + 0.5), y: LINEUP.y + 20 + gap * (j + 0.5), angle: a, phase: i * 0.9 },
				shadow,
			);
		});
		const [sname, s] = specials[j];
		drawZombieAt(
			st,
			{ ...s, x: LINEUP.x + gap * (FACINGS.length + 0.5), y: LINEUP.y + 20 + gap * (j + 0.5), angle: 0.8 },
			shadow,
		);
		labels.push([name, 6, (20 + gap * j) * zoom + 2, 2]);
		labels.push([sname, gap * FACINGS.length * zoom + 4, (20 + gap * j) * zoom + 2, 2]);
	});
	FACING_NAMES.forEach((n, i) => labels.push([n, gap * (i + 0.5) * zoom - 6, 4, 2]));
	return finish(st, labels);
}

// ---------------------------------------------------------------- the street scenes

function surfaceFree(x, y) {
	return buildingAt(world, x, y) === undefined && pointInSolid(world, x, y, 22) === undefined;
}

/** a residential street mid-block with lawns on both sides (the horde spills off the road onto them) */
function findStreet() {
	for (const road of world.roads) {
		if (road.avenue || road.vertical || road.w < 3000) continue;
		const cx = road.x + road.w / 2;
		const cy = road.y + road.h / 2;
		const jn = world.junctions.some(j => Math.abs(j.x + j.w / 2 - cx) < 900 && Math.abs(j.y + j.h / 2 - cy) < 600);
		if (!jn) return { x: cx, y: cy };
	}
	return { x: world.width / 2, y: world.height / 2 };
}

/** 60 zombies of every type closing in on four survivors with their pets */
function streetCast(cx, cy) {
	const survivors = [
		{ x: cx - 70, y: cy - 45, angle: Math.PI + 0.3, outfit: OutfitLook.None, weapon: 2, pet: PetLook.Carolina },
		{ x: cx + 70, y: cy - 45, angle: -0.3, outfit: OutfitLook.Cowboy, weapon: 10, pet: PetLook.Eagle },
		{ x: cx - 70, y: cy + 55, angle: 2.4, outfit: OutfitLook.Santa, weapon: 6, pet: PetLook.Malamute },
		{ x: cx + 70, y: cy + 55, angle: 0.7, outfit: OutfitLook.Zombie, weapon: 13, pet: PetLook.Pigeon },
	];
	const zombies = [];
	let seed = 11;
	const rnd = () => {
		seed = (seed * 16807) % 2147483647;
		return seed / 2147483647;
	};
	const types = [1, 1, 1, 1, 1, 1, 4, 4, 2, 3, 5, 1];
	for (let tries = 0; zombies.length < 60 && tries < 5000; tries++) {
		const a = rnd() * Math.PI * 2;
		const d = 230 + rnd() * 440;
		const x = cx + Math.cos(a) * d * 1.3;
		const y = cy + Math.sin(a) * d * 0.75;
		if (!surfaceFree(x, y)) continue;
		if (zombies.some(z => Math.hypot(z.x - x, z.y - y) < 40)) continue;
		const type = types[zombies.length % types.length];
		zombies.push({
			x,
			y,
			type,
			big: type === 1 && zombies.length % 17 === 0,
			angle: Math.atan2(cy - y, cx - x) + (rnd() - 0.5) * 0.5,
			phase: rnd() * 6.28,
		});
	}
	return { survivors, zombies };
}

function drawStreet(hour, fight) {
	const w = 1280;
	const h = 800;
	const c = findStreet();
	const st = stage(w, h, 1, c.x, c.y);
	const cast = streetCast(c.x, c.y);
	const lights = cast.survivors.map(s => ({ x: s.x, y: s.y, r: 250, inner: 0.4 }));
	const shadow = shadowFn(hour, lights);
	const view = new WorldView(shadow);
	view.clock = 0;
	for (const s of world.solids) if (s.kind === "tree") s.canopyAlpha = 1;
	st.r.beginFrame();
	const v = st.cam.viewRect(32);
	view.drawGround(st.r, st.cam, v, world);
	view.drawSolids(st.r, st.cam, v, world);
	cast.zombies.forEach((z, i) => {
		if (fight && i % 5 === 0) z.flash = i % 10 === 0 ? 1 : 0.5;
		if (fight && z.type === 3 && i % 2 === 0) z.blink = true;
		drawZombieAt(st, z, shadow);
	});
	cast.survivors.forEach((s, i) => {
		// at the heel, on the outer side of the group
		const heel = Math.atan2(s.y - c.y, s.x - c.x) + (i % 2 ? 0.6 : -0.6);
		const flies = petFlies(s.pet);
		drawPetAt(
			st,
			{
				x: s.x + Math.cos(heel) * 46,
				y: s.y + Math.sin(heel) * 46,
				angle: s.angle,
				look: s.pet,
				lift: flies ? 0.6 : 0,
				moving: flies ? 1 : 0,
				phase: 1,
			},
			shadow,
		);
		const look = survivorLook(s.x, s.y, s.angle, {
			outfit: s.outfit,
			weapon: s.weapon,
			swing: fight && i === 0 ? 0.3 : fight && i === 2 ? -0.4 : undefined,
			flash: fight && i === 1 ? 0.9 : 0,
			poisoned: fight && i === 3,
			phase: i,
			amp: 1,
		});
		drawLook(st, look, shadow);
	});
	return finish(st, [], hour, lights);
}

const SCENES = {
	survivors: { title: "The survivor, each outfit, eight facings", draw: sceneSurvivors },
	weapons: { title: "Weapons in the hands, held and swung", draw: sceneWeapons },
	states: { title: "Hit, poisoned, downed", draw: sceneStates },
	pets: { title: "Pets: standing, and on the move", draw: scenePets },
	zombies: { title: "Every zombie variant, eight facings and its special pose", draw: sceneZombies },
	"horde-day": { title: "A horde of 60 and four survivors with pets, 10:00", draw: () => drawStreet(10, false) },
	"horde-night": {
		title: "The same street at 22:00, lit by the survivors only",
		draw: () => drawStreet(22, false),
	},
	fight: { title: "A fight: hit flashes, a lit fuse, a swing, a hit survivor", draw: () => drawStreet(10, true) },
};

// ---------------------------------------------------------------- main

function stack(title, before, after) {
	const pad = 8;
	const head = 26;
	const W = Math.max(before.w, after.w) + pad * 2;
	const H = head + before.h + head + after.h + pad * 3;
	const img = { w: W, h: H, data: Buffer.alloc(W * H * 4) };
	for (let i = 0; i < W * H; i++) {
		img.data[i * 4] = 24;
		img.data[i * 4 + 1] = 24;
		img.data[i * 4 + 2] = 28;
		img.data[i * 4 + 3] = 255;
	}
	const blit = (src, x0, y0) => {
		for (let y = 0; y < src.h; y++)
			src.data.copy(img.data, ((y0 + y) * W + x0) * 4, y * src.w * 4, (y + 1) * src.w * 4);
	};
	drawText(img, `BEFORE (today, no character ids) - ${title}`, pad, pad + 4, 2, [235, 235, 235]);
	blit(before, pad, pad + head);
	const y1 = pad * 2 + head + before.h;
	drawText(img, `AFTER (the character sheets uploaded) - ${title}`, pad, y1 + 4, 2, [235, 235, 235]);
	blit(after, pad, y1 + head);
	return img;
}

const names = ONLY !== undefined ? ONLY.split(",") : Object.keys(SCENES);
const report = {};
for (const name of names) {
	const scene = SCENES[name];
	if (scene === undefined) {
		console.error(`no scene "${name}" (have: ${Object.keys(SCENES).join(", ")})`);
		process.exit(1);
	}
	const out = {};
	for (const phase of ["before", "after"]) {
		setArt(phase === "after");
		const t0 = Date.now();
		const res = scene.draw();
		const file = join(OUT, phase, `${name}.png`);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, encodePNG(res.img, true));
		out[phase] = res;
		console.log(
			`  ${phase.padEnd(6)} ${basename(file).padEnd(18)} ${`${res.img.w}x${res.img.h}`.padEnd(10)} ${String(res.counts.sprites).padStart(5)} sprites (${res.counts.images} images, ${res.counts.strokes} strokes)  ${Date.now() - t0} ms`,
		);
	}
	const file = join(OUT, "compare", `${name}.png`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, encodePNG(stack(scene.title, out.before.img, out.after.img), true));
	report[name] = { title: scene.title, before: out.before.counts, after: out.after.counts };
}
writeFileSync(join(OUT, "scenes.json"), `${JSON.stringify(report, undefined, "\t")}\n`);
WA.overrideWorldArt(undefined);
