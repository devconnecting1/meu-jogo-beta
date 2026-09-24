#!/usr/bin/env node
/*
 * A fresh fight's blood in the real town, before and after its pixel art (docs/DESIGN_RULES.md ART-15), with the REAL
 * drawing code: the town by client/view/worldView.ts, the bodies by humanoidView / survivorView, the blood by the
 * real client/systems/particles.ts and -- where the checkout has it -- client/view/bloodView.ts, onto the fake GUI
 * tree of tools/fake-gui.mjs, rasterised by tools/gui-raster.mjs (as tools/render-map.mjs does).
 *
 *   node tools/render-blood.mjs --out <dir> --tag after                       # this checkout
 *   node tools/render-blood.mjs --out <dir> --tag before --src <old>/src      # a checkout before ART-15
 *   node tools/render-blood.mjs --out <dir> --compare                         # before | after, side by side, 2x
 *
 * The fight, the same in both: the survivor shoots two walkers (four hits and a kill, three hits), and a third bites
 * them twice from behind; the picture is taken 1.45 s in, droplets still in the air. Two places -- a house's bedroom
 * (its roof off, as when you are inside) and a residential street -- by day (10:00) and at 22:00 in the survivor's
 * light. The "before" gets its blood the way the wire gave it then: a kill or a bite with no direction arrived with
 * angle 0, so it sprayed to +x. The "after" also renders the same stains 5 game minutes and a game day later.
 *
 * Both render the town with every texture live (the local PNGs of design/world-art, "local:<name>" ids): the town and
 * the bodies are the same pixel art, only the blood differs. A checkout without bloodView.ts draws the blood as its
 * GameLoop did (`legacy` below, line for line: tools/test-world-art.mjs §13 holds the new flat drawing to it).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodePNG, encodePNG } from "./png-lite.mjs";
import { rasterise } from "./gui-raster.mjs";
import { drawText } from "./pixel-font.mjs";

const argv = process.argv.slice(2);
const opt = name => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
if (opt("out") === undefined) {
	console.error(
		"usage: node tools/render-blood.mjs --out <dir> (--tag before|after [--src <checkout>/src] | --compare)",
	);
	process.exit(2);
}
const OUT = resolve(opt("out"));
mkdirSync(OUT, { recursive: true });

const SCENES = ["bedroom-day", "bedroom-night", "street-day", "street-night"];

// ---------------------------------------------------------------- compare (no src needed)

function upscale(img, k) {
	const out = { w: img.w * k, h: img.h * k, data: Buffer.alloc(img.w * k * img.h * k * 4) };
	for (let y = 0; y < out.h; y++) {
		for (let x = 0; x < out.w; x++) {
			const si = (Math.floor(y / k) * img.w + Math.floor(x / k)) * 4;
			const di = (y * out.w + x) * 4;
			img.data.copy(out.data, di, si, si + 4);
		}
	}
	return out;
}

function sideBySide(images, labels, k = 2) {
	const ups = images.map(i => upscale(i, k));
	const gap = 12;
	const head = 22;
	const W = ups.reduce((s, i) => s + i.w, 0) + gap * (ups.length - 1);
	const H = Math.max(...ups.map(i => i.h)) + head;
	const img = { w: W, h: H, data: Buffer.alloc(W * H * 4) };
	for (let i = 0; i < W * H; i++) {
		img.data[i * 4] = 24;
		img.data[i * 4 + 1] = 24;
		img.data[i * 4 + 2] = 28;
		img.data[i * 4 + 3] = 255;
	}
	let x0 = 0;
	ups.forEach((u, n) => {
		for (let y = 0; y < u.h; y++) u.data.copy(img.data, ((y + head) * W + x0) * 4, y * u.w * 4, (y + 1) * u.w * 4);
		drawText(img, labels[n], x0 + 4, 6, 2, [235, 235, 235]);
		x0 += u.w + gap;
	});
	return img;
}

if (argv.includes("--compare")) {
	const read = f => decodePNG(readFileSync(join(OUT, f)));
	for (const s of SCENES) {
		const b = join(OUT, `${s}-before.png`);
		const a = join(OUT, `${s}-after.png`);
		if (!existsSync(b) || !existsSync(a)) continue;
		writeFileSync(
			join(OUT, `compare-${s}.png`),
			encodePNG(
				sideBySide([read(`${s}-before.png`), read(`${s}-after.png`)], ["BEFORE", "AFTER (ART-15)"]),
				true,
			),
		);
		console.log(`  compare-${s}.png`);
	}
	for (const s of SCENES) {
		const files = [`${s}-after.png`, `${s}-after-5min.png`, `${s}-after-1day.png`];
		if (!files.every(f => existsSync(join(OUT, f)))) continue;
		writeFileSync(
			join(OUT, `aging-${s}.png`),
			encodePNG(sideBySide(files.map(read), ["FRESH", "5 GAME MINUTES", "A GAME DAY"]), true),
		);
		console.log(`  aging-${s}.png`);
	}
	process.exit(0);
}

// ---------------------------------------------------------------- the checkout

const TAG = opt("tag") ?? "after";
if (opt("src") !== undefined) process.env.PZ_SRC = resolve(opt("src"));
const { installShims, ROOT, setSeed } = await import("./luau-shim.mjs");
const { SRC, require } = installShims({ seed: 1 });
const { installFakeGui } = await import("./fake-gui.mjs");
const gui = installFakeGui();
const ART_DIR = join(ROOT, "design", "world-art");

const { COLORS, Z } = require(join(SRC, "shared/engine/colors.ts"));
const { Camera } = require(join(SRC, "shared/engine/camera.ts"));
const { Renderer, LightMap } = require(join(SRC, "shared/engine/renderer.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const W = require(join(SRC, "shared/game/world.ts"));
const { darkAlphaAt } = require(join(SRC, "shared/sim/clock.ts"));
const { WorldView } = require(join(SRC, "client/view/worldView.ts"));
const HV = require(join(SRC, "client/view/humanoidView.ts"));
const SV = require(join(SRC, "client/view/survivorView.ts"));
const { circleInView } = require(join(SRC, "client/view/drawKit.ts"));
const { ParticleSystem } = require(join(SRC, "client/systems/particles.ts"));
const worldArt = require(join(SRC, "client/view/worldArt.ts"));
const BV_MODULE = join(SRC, "client/view/bloodView.ts");
const BV = existsSync(BV_MODULE) ? require(BV_MODULE) : undefined;

// every texture live from its local PNG, the blood's atlas too when this checkout draws it
const manifest = JSON.parse(readFileSync(join(ART_DIR, "manifest.json"), "utf8"));
const ids = {};
for (const t of manifest.textures) ids[t.name] = `local:${t.name}`;
worldArt.overrideWorldArt(ids);
const images = new Map();
function localImage(id) {
	if (!id.startsWith("local:")) return undefined;
	if (!images.has(id)) images.set(id, decodePNG(readFileSync(join(ART_DIR, `${id.slice(6)}.png`))));
	return images.get(id);
}

/** the blood as GameLoop drew it before ART-15 (drawDecals / drawParticles) */
function legacy(r, cam, v, ps) {
	const o = { zIndex: Z.decal };
	for (const d of ps.decalRecords()) {
		if (d.life <= 0 || !circleInView(d.x, d.y, d.size, v)) continue;
		o.color = d.color;
		o.alpha = 0.7 * Math.min(1, d.life / 5);
		r.drawCircle(cam, d.x, d.y, d.size, o);
	}
	const q = { zIndex: Z.particle };
	for (const p of ps.active()) {
		if (!circleInView(p.x, p.y, p.size, v)) continue;
		q.color = p.color;
		q.alpha = Math.min(Math.max((p.life / p.maxLife) * 1.5, 0), 1);
		r.drawCircle(cam, p.x, p.y, p.size, q);
	}
}

// ---------------------------------------------------------------- the places

const world = W.generateTown(DESIGN.TOWN_SEED);
const VW = 560;
const VH = 360;
const free = (x, y) => W.pointInSolid(world, x, y, 20) === undefined;

/** a house with a bedroom (the richest), the bedroom, and a free spot near its middle */
function bedroom() {
	const houses = world.solids.filter(
		s => s.kind === "building" && (s.buildingType === 1 || s.buildingType === 2) && s.rooms !== undefined,
	);
	houses.sort((a, b) => (b.rooms?.length ?? 0) - (a.rooms?.length ?? 0) || a.id - b.id);
	for (const b of houses) {
		const room = b.rooms.filter(q => q.kind === "bedroom").sort((p, q) => q.w * q.h - p.w * p.h)[0];
		if (room === undefined || room.w < 220 || room.h < 200) continue;
		return { b, cx: room.x + room.w / 2, cy: room.y + room.h / 2, room };
	}
	throw new Error("no house with a bedroom");
}

/** a residential street: the middle of a long horizontal road */
function street() {
	const road = world.roads
		.filter(r => !r.vertical && !r.avenue && r.w > 3000)
		.sort((a, b) => b.w - a.w || a.y - b.y)[0];
	return { cx: Math.round(road.x + road.w * 0.37), cy: road.y + road.h / 2 };
}

/** the nearest free spot to (x, y) inside `box` (a spiral of 8 u steps) */
function near(x, y, box) {
	for (let r = 0; r < 200; r += 8) {
		for (let k = 0; k < 16; k++) {
			const px = x + Math.cos((k / 16) * Math.PI * 2) * r;
			const py = y + Math.sin((k / 16) * Math.PI * 2) * r;
			if (
				box !== undefined &&
				(px < box.x + 24 || px > box.x + box.w - 24 || py < box.y + 24 || py > box.y + box.h - 24)
			)
				continue;
			if (free(px, py)) return { x: px, y: py };
		}
	}
	return { x, y };
}

// ---------------------------------------------------------------- the fight

/**
 * The same fight for every picture: `wire(dir)` is how a direction reached the client -- the old wire sent 0 for none
 * (before), the new one sends none (after).
 */
function fight(ps, cast, until) {
	const { s, z1, z2, z3 } = cast;
	const at = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
	const wire = d => (d === undefined && TAG === "before" ? 0 : d);
	const events = [
		[0.0, () => ps.bloodBurst(z1.x, z1.y, 3, "zombie", at(s, z1))],
		[0.2, () => ps.bloodBurst(z1.x, z1.y, 3, "zombie", at(s, z1))],
		[0.3, () => ps.bloodBurst(z2.x, z2.y, 3, "zombie", at(s, z2))],
		[0.4, () => ps.bloodBurst(z1.x, z1.y, 3, "zombie", at(s, z1))],
		[0.55, () => ps.bloodBurst(z2.x, z2.y, 3, "zombie", at(s, z2))],
		[0.6, () => ps.bloodBurst(z1.x, z1.y, 3, "zombie", at(s, z1))],
		[0.7, () => ps.bloodBurst(z1.x, z1.y, 10, "zombie", wire(undefined))],
		[0.9, () => ps.bloodBurst(s.x, s.y, 4, "player", wire(TAG === "before" ? undefined : at(z3, s)))],
		[1.1, () => ps.bloodBurst(z2.x, z2.y, 3, "zombie", at(s, z2))],
		[1.3, () => ps.bloodBurst(s.x, s.y, 4, "player", wire(TAG === "before" ? undefined : at(z3, s)))],
	];
	let t = 0;
	let next = 0;
	while (t < until) {
		while (next < events.length && events[next][0] <= t + 1e-9) events[next++][1]();
		ps.update(1 / 60);
		t += 1 / 60;
	}
}

function render(name, place, night, extraAge) {
	const root = gui.make("Frame");
	root.Size = UDim2.fromOffset(VW, VH);
	const r = new Renderer(root, "Sprites");
	r.setView(VW, VH);
	const dark = gui.make("Frame");
	dark.Parent = root;
	dark.BackgroundTransparency = 1;
	const cam = new Camera();
	cam.setView(VW, VH);
	cam.x = place.cx;
	cam.y = place.cy;
	const box = place.room;
	const s = near(place.cx - 90, place.cy + 20, box);
	const z1 = near(place.cx + 70, place.cy - 50, box);
	const z2 = near(place.cx + 100, place.cy + 60, box);
	const z3 = near(s.x - 38, s.y + 14, box);
	const cast = { s, z1, z2, z3 };
	setSeed(2026);
	const ps = new ParticleSystem();
	if (BV !== undefined) ps.pixelArt = BV.bloodArtLive();
	fight(ps, cast, 1.45);
	if (extraAge > 0) for (let t = 0; t < extraAge; t += 1) ps.update(1);
	if (place.b !== undefined) place.b.roofAlpha = 0;
	const sun = { x: 0, y: 0 };
	const shadow = (x, y, len) => {
		if (!night) {
			sun.x = 0.2588 * len;
			sun.y = 0.9659 * len;
			return sun;
		}
		const dx = x - s.x;
		const dy = y - s.y;
		const d = Math.hypot(dx, dy) || 1;
		sun.x = (dx / d) * len;
		sun.y = (dy / d) * len;
		return sun;
	};
	const view = new WorldView(shadow);
	view.clock = 0;
	const v = cam.viewRect(32);
	r.beginFrame();
	view.drawGround(r, cam, v, world);
	if (BV !== undefined) new BV.BloodView().drawDecals(r, cam, v, ps, world);
	else legacy(r, cam, v, { decalRecords: () => ps.decalRecords(), active: () => [] });
	view.drawSolids(r, cam, v, world);
	const bodies = extraAge > 0 ? [] : [z1, z2, z3].filter(z => z !== z1);
	for (const z of bodies) {
		const so = shadow(z.x, z.y, 10);
		r.drawCircle(cam, z.x + so.x, z.y + so.y, 34, { color: COLORS.shadow, alpha: 0.3, zIndex: Z.actorShadow });
		const a = Math.atan2(s.y - z.y, s.x - z.x);
		HV.drawZombie(r, cam, z.x, z.y, a, 1, z === z2 ? 2 : 1, 0, 1, 0.4, Z.zombie, 0, false, false, false);
	}
	const look = SV.createLook();
	look.x = s.x;
	look.y = s.y;
	look.angle = Math.atan2(z2.y - s.y, z2.x - s.x);
	look.weapon = 10;
	const so = shadow(s.x, s.y, 10);
	look.shadowX = so.x;
	look.shadowY = so.y;
	look.z = Z.player;
	SV.drawSurvivor(r, cam, look, SV.createSwingTrail());
	if (BV !== undefined) new BV.BloodView().drawParticles(r, cam, v, ps);
	else legacy(r, cam, v, { decalRecords: () => [], active: () => ps.active() });
	r.endFrame();
	if (place.b !== undefined) place.b.roofAlpha = 1;
	if (night) {
		const lm = new LightMap(dark, COLORS.overlayNight);
		lm.update(cam, darkAlphaAt(22, false, false), [{ x: s.x, y: s.y, r: 250, inner: 0.4 }]);
	}
	const img = rasterise({ layer: r.layer, dark, vw: VW, vh: VH }, COLORS.bg, localImage);
	writeFileSync(join(OUT, `${name}.png`), encodePNG(img, true));
	console.log(`  ${name}.png`);
}

const places = { bedroom: bedroom(), street: street() };
console.log(`render-blood: ${TAG}, src ${SRC}${BV === undefined ? " (no bloodView.ts: the old blood)" : ""}`);
for (const sc of SCENES) {
	const [where, when] = sc.split("-");
	render(`${sc}-${TAG}`, places[where], when === "night", 0);
	if (TAG === "after") {
		render(`${sc}-${TAG}-5min`, places[where], when === "night", 300);
		render(`${sc}-${TAG}-1day`, places[where], when === "night", 700);
	}
}
