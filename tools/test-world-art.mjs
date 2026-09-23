#!/usr/bin/env node
/*
 * The town's pixel art (client/view/worldView.ts + worldArt.ts, textures from tools/gen-world-art.mjs): it only
 * ever ADDS to the flat town, it draws what it claims, it costs no Instance churn, and it keeps the actors legible.
 *
 *   npm run test:world-art
 *   node tools/test-world-art.mjs --golden     # rewrites tools/golden/world-flat.json from the CURRENT src
 *                                              # (do it only when the flat drawing changes on purpose)
 *
 * What this proves:
 *   1. NO ART, NO CHANGE. With no asset id the town is drawn exactly as before the art existed: the stream of draw
 *      calls of drawGround + drawSolids over seven scenes (day, night, overview, the map border) and a camera pan
 *      hashes to tools/golden/world-flat.json, recorded from the flat drawing of e097eb3 (the commit before the
 *      art). And not one sprite shows an image.
 *   2. WITH ART, THE SURFACES ARE TEXTURES. With a fake id for every texture: the ground, the roads, the roofs and
 *      the props draw as ImageLabels, pixelated, tiles at their texel size (4 units per texel), no flat asphalt /
 *      sidewalk / lawn rect is left under them, the asphalt is one world-anchored sheet under the lots.
 *      Each texture falls back ON ITS OWN: with only the lawn uploaded, only the lawn is textured.
 *   3. NO CHURN. After a warm-up, 600 frames of camera movement create no Instance, flat and with art, and the
 *      renderer's write cache still skips what did not change.
 *   4. THE COST, measured on a dense 1920 x 1080 downtown screen: sprites, ImageLabels, strokes, corners and the
 *      Node time of a frame, flat against art (printed; the art stays within 10 % of the flat town's sprites).
 *   5. LEGIBILITY (LEG-03). A walker and the survivor on every kind of ground, rendered through the real code and
 *      rasterised: the strongest colour step across the silhouette (ΔE, CIELAB) must not drop with the textures,
 *      and a walker on grass must clear the bar the old outline missed (it measured 15; the lawn's own colour).
 *   6. THE PIPELINE. The manifest, the PNGs and worldArtAssets.ts agree; masks and roof tiles are greyscale (the
 *      roof keeps its type colour, EDI-03); each ground texture's mean colour stays within ΔE 6 of the flat colour
 *      it replaces (the art never repaints the palette); ids are "" or rbxassetid.
 *   7. THE TOOLS RUN. tools/render-map.mjs renders a scene whose PNG decodes, with no missing texture (magenta);
 *      `npm run cloud -- upload-art --dry-run` lists every texture without reading any key.
 *   8. THE NAMEPLATE OVER THE WORLD (UI-04 clarification). The plate has no background, so each of its voices (name,
 *      level, handle, every title) is measured with its pixel drop shadow against the real ground pixels of every
 *      ground a survivor stands on, by day and under the night tint: the letter against its own shadow at 4,5:1 even
 *      on pure white, and the letter or its shadow 30 ΔE off every ground pixel. `PZ_PLATE_RECORD=<file>` writes
 *      the per-ground table as JSON.
 *
 * Pure Node (>= 18) + the project's TypeScript on tools/luau-shim.mjs and the fake GUI tree of tools/fake-gui.mjs.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installShims, ROOT } from "./luau-shim.mjs";
import { installFakeGui } from "./fake-gui.mjs";
import { countSprites, rasterise } from "./gui-raster.mjs";
import { decodePNG } from "./png-lite.mjs";

const GOLDEN_MODE = process.argv.includes("--golden");
const GOLDEN = join(ROOT, "tools", "golden", "world-flat.json");
const ART_DIR = join(ROOT, "design", "world-art");

const { SRC, require } = installShims({ seed: 7 });
const gui = installFakeGui();

const { COLORS, Z } = require(join(SRC, "shared/engine/colors.ts"));
const { Camera } = require(join(SRC, "shared/engine/camera.ts"));
const { Renderer } = require(join(SRC, "shared/engine/renderer.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const { generateTown, buildingAt, pointInSolid, hash01 } = require(join(SRC, "shared/game/world.ts"));
const { WorldView } = require(join(SRC, "client/view/worldView.ts"));
const ART_MODULE = join(SRC, "client/view/worldArt.ts");
const WA = existsSync(ART_MODULE) ? require(ART_MODULE) : undefined;

// ---------------------------------------------------------------- harness

let failures = 0;
function check(ok, what, detail) {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail !== undefined ? `  (${detail})` : ""}`);
	if (!ok) failures++;
	return ok;
}
function section(title) {
	console.log(`\n${title}`);
}

const world = generateTown(DESIGN.TOWN_SEED);

/** a stage: a renderer over the fake tree and a camera on `rect` at `zoom` */
function stage(w, h, zoom = 1) {
	const root = gui.make("Frame");
	const r = new Renderer(root, "Sprites");
	const cam = new Camera();
	cam.setView(w, h);
	r.setView(w, h);
	cam.zoom = zoom;
	return { root, r, cam };
}

/** the sun of 10:00 (shadows down and a little right), or at night away from a light at (lx, ly) */
function shadowFn(night, lx = 0, ly = 0) {
	const s = { x: 0, y: 0 };
	return (x, y, len) => {
		if (!night) {
			s.x = 0.2588 * len;
			s.y = 0.9659 * len;
			return s;
		}
		const dx = x - lx;
		const dy = y - ly;
		const d = Math.hypot(dx, dy);
		s.x = d < 1 ? 0 : (dx / d) * len;
		s.y = d < 1 ? len * 0.5 : (dy / d) * len;
		return s;
	};
}

function drawTown(st, view, cx, cy) {
	st.cam.x = cx;
	st.cam.y = cy;
	const v = st.cam.viewRect(32);
	st.r.beginFrame();
	view.drawGround(st.r, st.cam, v, world);
	view.drawSolids(st.r, st.cam, v, world);
	st.r.endFrame();
}

/** every texture live under a fake id; `only` limits it to some */
function fakeIds(only) {
	const manifest = JSON.parse(readFileSync(join(ART_DIR, "manifest.json"), "utf8"));
	const ids = {};
	manifest.textures.forEach((t, i) => {
		if (only === undefined || only.includes(t.name)) ids[t.name] = `rbxassetid://${900000 + i}`;
	});
	return { ids, manifest };
}

function setArt(ids) {
	if (WA !== undefined) WA.overrideWorldArt(ids);
}

// ================================================================ 1. no art, no change

const SCENES = [
	{ name: "street", x: 16476, y: 11722, w: 1280, h: 800, zoom: 1, night: false },
	{ name: "downtown", x: 7764, y: 9854, w: 1280, h: 800, zoom: 1, night: false },
	{ name: "park", x: 2724, y: 14928, w: 1280, h: 800, zoom: 1, night: false },
	{ name: "school", x: 4445, y: 2742, w: 1280, h: 800, zoom: 1, night: false },
	{ name: "gas", x: 941, y: 8801, w: 1280, h: 800, zoom: 1, night: false },
	{ name: "street-night", x: 16476, y: 11722, w: 1280, h: 800, zoom: 1, night: true },
	{ name: "overview", x: 12200, y: 5000, w: 3000, h: 2000, zoom: 0.5, night: false },
	{ name: "border", x: 0, y: 5000, w: 1280, h: 800, zoom: 1, night: false },
];

/** the draw calls of a frame, as the renderer received them (the options are copied: callers reuse them) */
const calls = [];
let capturing = false;
const drawRect = Renderer.prototype.drawRect;
const round = v => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v);
const rgb = c => (c === undefined ? undefined : [Math.round(c.R * 255), Math.round(c.G * 255), Math.round(c.B * 255)]);
Renderer.prototype.drawRect = function (cam, wx, wy, o) {
	if (capturing) {
		calls.push([
			round(wx),
			round(wy),
			round(o.w),
			round(o.h),
			round(o.rotation),
			rgb(o.color),
			round(o.alpha),
			o.zIndex,
			round(o.cornerRadius),
			o.circle,
			rgb(o.stroke),
			round(o.strokeThickness),
			round(o.strokeAlpha),
			round(o.anchorX),
			round(o.anchorY),
			o.image,
		]);
	}
	return drawRect.call(this, cam, wx, wy, o);
};

function digestOf(scene) {
	const st = stage(Math.round(scene.w * scene.zoom), Math.round(scene.h * scene.zoom), scene.zoom);
	const cx = scene.x + scene.w / 2;
	const cy = scene.y + scene.h / 2;
	const view = new WorldView(shadowFn(scene.night, cx - 60, cy + 40));
	calls.length = 0;
	capturing = true;
	drawTown(st, view, cx, cy);
	// a short pan: clipping at the view's edges changes every frame
	for (let f = 1; f <= 12; f++) drawTown(st, view, cx + f * 37, cy + f * 11);
	capturing = false;
	const json = JSON.stringify(calls);
	return { count: calls.length, sha1: createHash("sha1").update(json).digest("hex"), layer: st.r.layer };
}

section("1) no asset id: the town is drawn exactly as before the art");
setArt({});
const flatDigests = {};
for (const sc of SCENES) flatDigests[sc.name] = digestOf(sc);
if (GOLDEN_MODE) {
	mkdirSync(join(ROOT, "tools", "golden"), { recursive: true });
	const out = {
		note: "draw-call digests of WorldView.drawGround + drawSolids with no world art (tools/test-world-art.mjs --golden)",
		recordedFrom: process.env.PZ_GOLDEN_FROM ?? "the src it was run on",
		scenes: Object.fromEntries(Object.entries(flatDigests).map(([k, v]) => [k, { count: v.count, sha1: v.sha1 }])),
	};
	writeFileSync(GOLDEN, `${JSON.stringify(out, undefined, "\t")}\n`);
	console.log(`wrote ${GOLDEN}`);
	process.exit(0);
}
const golden = JSON.parse(readFileSync(GOLDEN, "utf8")).scenes;
for (const sc of SCENES) {
	const d = flatDigests[sc.name];
	const g = golden[sc.name];
	check(
		g !== undefined && d.count === g.count && d.sha1 === g.sha1,
		`${sc.name}: same ${d.count} draw calls as e097eb3`,
		g === undefined ? "no golden" : `${d.sha1.slice(0, 10)} vs ${g.sha1.slice(0, 10)}, ${g.count} calls`,
	);
}
{
	let images = 0;
	for (const sc of SCENES) images += countSprites(flatDigests[sc.name].layer).images;
	check(images === 0, "and not one sprite shows an image", `${images}`);
}

// ================================================================ 2. with art: textures, and each one on its own

section("2) with every texture live: surfaces and props are pixel-art images");
const ALL = fakeIds();
const nameOf = {};
for (const [name, id] of Object.entries(ALL.ids)) nameOf[id] = name;
const texOf = Object.fromEntries(ALL.manifest.textures.map(t => [t.name, t]));
{
	setArt(ALL.ids);
	const counts = {};
	let bad = [];
	let badTile = [];
	let flatGround = 0;
	let sheet = 0;
	for (const sc of SCENES.slice(0, 6)) {
		const d = digestOf(sc);
		for (const f of d.layer.GetChildren()) {
			if (f.Visible === false) continue;
			const label = f.GetChildren().find(k => k.ClassName === "ImageLabel");
			const shows = label !== undefined && label.Visible !== false;
			if (!shows) {
				// a flat rect the art should have replaced: road asphalt, sidewalk, lawn, plaza paving
				const c = f.BackgroundColor3;
				const same = k => Math.abs(c.R - k.R) + Math.abs(c.G - k.G) + Math.abs(c.B - k.B) < 0.004;
				if (f.BackgroundTransparency < 1 && (f.ZIndex === Z.road || f.ZIndex <= Z.ground + 1)) {
					if (same(COLORS.road) || same(COLORS.sidewalk) || same(COLORS.grass) || same(COLORS.parkGrass))
						flatGround++;
				}
				continue;
			}
			const name = nameOf[label.Image];
			counts[name] = (counts[name] ?? 0) + 1;
			if (label.ResampleMode.Name !== "Pixelated") bad.push(name);
			if (f.BackgroundTransparency !== 1) bad.push(`${name} (background shows)`);
			if (label.ScaleType.Name === "Tile") {
				const t = texOf[name];
				const want = [t.w * 4 * sc.zoom, t.h * 4 * sc.zoom].map(v => Math.max(1, Math.floor(v + 0.5)));
				if (label.TileSize.X.Offset !== want[0] || label.TileSize.Y.Offset !== want[1]) badTile.push(name);
			}
			if (name === "asphalt" && f.ZIndex === Z.ground - 1) sheet++;
		}
	}
	check(bad.length === 0, "every image is pixelated and hides its Frame's background", bad.slice(0, 4).join(", "));
	check(
		badTile.length === 0,
		"every tile repeats at its texel size (4 units per texel)",
		badTile.slice(0, 4).join(", "),
	);
	check(flatGround === 0, "no flat asphalt, sidewalk or lawn rect is left under the textures", `${flatGround}`);
	check(sheet === 6, "the asphalt is one sheet per frame, under the lots", `${sheet} sheets in 6 scenes`);
	const want = [
		"concrete",
		"grass",
		"plaza",
		"kerbN",
		"kerbW",
		"paint",
		"roofShingleH",
		"roofGravel",
		"roofMembrane",
		"eaves",
		"parapet",
		"shadowBox",
		"bin",
		"pump",
		"manhole",
		"dirt",
		"apron",
	];
	const missing = want.filter(n => !(counts[n] > 0));
	check(
		missing.length === 0,
		"ground, kerbs, paint, roofs, rims, soft shadows, bins, pumps, manholes all drawn",
		missing.join(", "),
	);
	const cars = Object.keys(counts).filter(n => /^car\d$/.test(n)).length;
	const crowns = Object.keys(counts).filter(n => /^canopy\d$/.test(n)).length;
	check(cars >= 3, "cars come in several body styles", `${cars} styles on screen`);
	check(crowns >= 2, "tree crowns come in several shapes", `${crowns} shapes on screen`);
}
{
	// a half-finished upload: only the lawn
	setArt(fakeIds(["grass"]).ids);
	const d = digestOf(SCENES[0]);
	let grass = 0;
	let other = 0;
	let flatRoad = 0;
	for (const f of d.layer.GetChildren()) {
		if (f.Visible === false) continue;
		const label = f.GetChildren().find(k => k.ClassName === "ImageLabel");
		if (label !== undefined && label.Visible !== false) {
			if (nameOf[label.Image] === "grass") grass++;
			else other++;
		} else if (f.ZIndex === Z.road) flatRoad++;
	}
	check(
		grass > 0 && other === 0,
		"only the lawn uploaded: only the lawn is textured",
		`${grass} lawn, ${other} other`,
	);
	check(flatRoad > 0, "and the roads fall back to their flat asphalt", `${flatRoad} road rects`);
	// the decorative extras exist only with their art
	setArt({});
}

// ================================================================ 3. no churn

section("3) 600 frames of camera movement after a warm-up: no Instance created");
function pan(st, view, frames, from) {
	for (let f = 0; f < frames; f++) {
		// back and forth along a downtown avenue, and across it: every kind of thing enters and leaves the view
		const t = (f % 300) / 300;
		const k = t < 0.5 ? t * 2 : 2 - t * 2;
		drawTown(st, view, from.x + k * 2400, from.y + Math.sin(f * 0.05) * 500);
	}
}
for (const [label, ids] of [
	["flat", {}],
	["art", ALL.ids],
]) {
	setArt(ids);
	const st = stage(1280, 720, 1);
	const view = new WorldView(shadowFn(false));
	const from = { x: 7000, y: 10200 };
	pan(st, view, 600, from);
	const created = gui.stats.created;
	const writes = gui.stats.writes;
	pan(st, view, 600, from);
	const churn = gui.stats.created - created;
	check(churn === 0, `${label}: no Instance created in 600 frames`, `${churn} created`);
	console.log(
		`       ${label}: ${((gui.stats.writes - writes) / 600).toFixed(0)} property writes per frame while panning`,
	);
	// a still camera writes nothing at all
	const w0 = gui.stats.writes;
	for (let f = 0; f < 30; f++) drawTown(st, view, from.x, from.y);
	const w1 = gui.stats.writes;
	for (let f = 0; f < 30; f++) drawTown(st, view, from.x, from.y);
	check(
		gui.stats.writes - w1 === 0,
		`${label}: a still camera writes no property`,
		`${gui.stats.writes - w1} writes (first ${w1 - w0})`,
	);
}
setArt({});

// ================================================================ 4. the cost

section("4) cost of a dense screen: downtown, 1920 x 1080, zoom 1");
const perf = {};
for (const [label, ids] of [
	["flat", {}],
	["art", ALL.ids],
]) {
	setArt(ids);
	const st = stage(1920, 1080, 1);
	const view = new WorldView(shadowFn(false));
	const at = { x: 8400, y: 10250 };
	const created0 = gui.stats.created;
	drawTown(st, view, at.x, at.y);
	const c = countSprites(st.r.layer);
	const pool = gui.stats.created - created0;
	// Node time of drawGround + drawSolids through the renderer (fake engine): relative, not Roblox milliseconds
	const t0 = process.hrtime.bigint();
	for (let f = 0; f < 200; f++) drawTown(st, view, at.x + (f % 50) * 3, at.y + (f % 30) * 2);
	const us = Number(process.hrtime.bigint() - t0) / 1000 / 200;
	perf[label] = { ...c, instances: pool, usPerFrame: Math.round(us) };
	console.log(
		`       ${label.padEnd(4)} ${String(c.sprites).padStart(4)} sprites: ${String(c.flat).padStart(3)} flat Frames + ${String(c.images).padStart(3)} ImageLabels, ${c.strokes} strokes, ${c.corners} corners; ${pool} Instances in the pool; ${perf[label].usPerFrame} µs/frame (Node)`,
	);
}
// the art trades nine sprites per car for three and adds details (kerbs, decals, rooftop units): the budget is
// the flat town's sprite count plus 10 %
check(
	perf.art.sprites <= perf.flat.sprites * 1.1,
	"the art stays within 10 % of the flat town's sprites",
	`${perf.art.sprites} vs ${perf.flat.sprites}`,
);
setArt({});

// ================================================================ 5. legibility (LEG-03)

section("5) LEG-03: a walker and the survivor stand out on every ground");
const HV = require(join(SRC, "client/view/humanoidView.ts"));
const SV = require(join(SRC, "client/view/survivorView.ts"));
const images = new Map();
function localImage(id) {
	const name = nameOf[id];
	if (name === undefined) return undefined;
	if (!images.has(name)) images.set(name, decodePNG(readFileSync(join(ART_DIR, `${name}.png`))));
	return images.get(name);
}
const inRect = (q, x, y) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h;
function surfaceAt(x, y) {
	if (buildingAt(world, x, y) !== undefined) return "building";
	if (pointInSolid(world, x, y, 60) !== undefined) return "solid";
	for (const road of world.roads) {
		if (!inRect(road, x, y)) continue;
		for (const m of road.medians) if (inRect(m, x, y)) return "median";
		return "road";
	}
	const lot = world.lots.find(l => inRect(l, x, y));
	if (lot === undefined) return "border";
	for (const g of lot.ground) if (inRect(g, x, y)) return g.kind;
	for (const p of lot.paths) if (inRect(p, x, y)) return "path";
	if (inRect(lot.yard, x, y)) {
		if (lot.zone === "commercial") return "plaza";
		if (lot.kind === "park") return "park";
		return lot.kind === "block" && lot.zone === "residential" && hash01(lot.x, lot.y, 3) < 0.3
			? "grassLong"
			: "grass";
	}
	return "sidewalk";
}
/** a point with 70 units of the same ground all round, found on a fixed walk through the town */
function spotOn(kind) {
	for (let i = 0; i < 400000; i++) {
		const x = 1000 + ((i * 7919) % 20000);
		const y = 1000 + ((i * 104729) % 14600);
		if (surfaceAt(x, y) !== kind) continue;
		let ok = true;
		for (let dx = -70; dx <= 70 && ok; dx += 35) {
			for (let dy = -70; dy <= 70 && ok; dy += 35) if (surfaceAt(x + dx, y + dy) !== kind) ok = false;
		}
		if (ok) return { x, y };
	}
	return undefined;
}
const S = 160;
function shot(p, actor, art) {
	setArt(art ? ALL.ids : {});
	const st = stage(S, S, 1);
	const view = new WorldView(shadowFn(false));
	st.cam.x = p.x;
	st.cam.y = p.y;
	const v = st.cam.viewRect(32);
	st.r.beginFrame();
	view.drawGround(st.r, st.cam, v, world);
	view.drawSolids(st.r, st.cam, v, world);
	// the actor's drop shadow is part of the ground in both pictures: only the body is compared
	const so = { x: 2.6, y: 9.7 };
	if (actor !== "survivor")
		st.r.drawCircle(st.cam, p.x + so.x, p.y + so.y, 33.6, {
			color: COLORS.shadow,
			alpha: 0.3,
			zIndex: Z.actorShadow,
		});
	if (actor === "zombie")
		HV.drawHumanoid(st.r, st.cam, p.x, p.y, 0.7, 16 / 18, HV.zombieColor(1), 0, 1, 0.8, Z.zombie);
	if (actor === "survivor") {
		const look = SV.createLook();
		look.x = p.x;
		look.y = p.y;
		look.angle = 0.7;
		look.shadowX = so.x;
		look.shadowY = so.y;
		SV.drawSurvivor(st.r, st.cam, look, SV.createSwingTrail());
	}
	st.r.endFrame();
	return rasterise({ layer: st.r.layer, vw: S, vh: S }, COLORS.bg, localImage);
}
function lab(r, g, b) {
	const f = c => {
		c /= 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	const R = f(r);
	const G = f(g);
	const B = f(b);
	const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
	const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
	const Zc = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
	const h = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
	return [116 * h(Y) - 16, 500 * (h(X) - h(Y)), 200 * (h(Y) - h(Zc))];
}
/**
 * Silhouette contrast: for every ground pixel touching the body, the strongest colour step (ΔE) to a body pixel
 * within 3 px -- a dark rim, a bright body or both. Averaged along the whole outline.
 */
function silhouette(ground, withBody) {
	const n = S * S;
	const mask = new Uint8Array(n);
	const L = new Array(n);
	for (let i = 0; i < n; i++) {
		const a = ground.data;
		const b = withBody.data;
		const d =
			Math.abs(a[i * 4] - b[i * 4]) +
			Math.abs(a[i * 4 + 1] - b[i * 4 + 1]) +
			Math.abs(a[i * 4 + 2] - b[i * 4 + 2]);
		if (d > 6) mask[i] = 1;
		L[i] = lab(b[i * 4], b[i * 4 + 1], b[i * 4 + 2]);
	}
	let sum = 0;
	let count = 0;
	for (let i = 0; i < n; i++) {
		if (mask[i]) continue;
		const x = i % S;
		const y = Math.floor(i / S);
		let touching = false;
		for (const [dx, dy] of [
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1],
		]) {
			const xx = x + dx;
			const yy = y + dy;
			if (xx >= 0 && xx < S && yy >= 0 && yy < S && mask[yy * S + xx]) touching = true;
		}
		if (!touching) continue;
		let best = 0;
		for (let dy = -3; dy <= 3; dy++) {
			for (let dx = -3; dx <= 3; dx++) {
				const xx = x + dx;
				const yy = y + dy;
				if (xx < 0 || xx >= S || yy < 0 || yy >= S || !mask[yy * S + xx]) continue;
				const q = L[yy * S + xx];
				best = Math.max(best, Math.hypot(L[i][0] - q[0], L[i][1] - q[1], L[i][2] - q[2]));
			}
		}
		sum += best;
		count++;
	}
	return count > 0 ? sum / count : 0;
}
{
	const kinds = ["grass", "park", "grassLong", "road", "plaza", "apron", "parking"];
	let worstZombie = Infinity;
	let worstSurvivor = Infinity;
	for (const kind of kinds) {
		const p = spotOn(kind);
		if (p === undefined) {
			check(false, `a spot of ${kind} in the town`);
			continue;
		}
		const res = {};
		for (const actor of ["zombie", "survivor"]) {
			for (const art of [false, true]) {
				const base = shot(p, actor === "zombie" ? "zombieShadow" : "none", art);
				res[`${actor}${art ? "Art" : "Flat"}`] = silhouette(base, shot(p, actor, art));
			}
		}
		worstZombie = Math.min(worstZombie, res.zombieArt);
		worstSurvivor = Math.min(worstSurvivor, res.survivorArt);
		check(
			res.zombieArt >= res.zombieFlat * 0.9 && res.survivorArt >= res.survivorFlat * 0.9,
			`${kind.padEnd(9)}: the textures keep both silhouettes`,
			`walker ${res.zombieFlat.toFixed(1)} -> ${res.zombieArt.toFixed(1)}, survivor ${res.survivorFlat.toFixed(1)} -> ${res.survivorArt.toFixed(1)} ΔE`,
		);
	}
	// e097eb3 measured 15.1 for a walker on grass (its outline was the lawn's own colour) and ~35-42 elsewhere
	check(
		worstZombie >= 25,
		"a walker stands out on the worst ground (was 15 with the old outline)",
		`${worstZombie.toFixed(1)} ΔE`,
	);
	check(worstSurvivor >= 30, "the survivor stands out on the worst ground", `${worstSurvivor.toFixed(1)} ΔE`);
}
setArt({});

// ================================================================ 6. the pipeline

section("6) the art pipeline: manifest, PNGs, worldArtAssets.ts, palette");
{
	const manifest = ALL.manifest;
	const assetsTs = readFileSync(join(SRC, "client/view/worldArtAssets.ts"), "utf8");
	const tsNames = [...assetsTs.matchAll(/^\t(\w+): \{ id: "([^"]*)", w: (\d+), h: (\d+)/gm)].map(m => ({
		name: m[1],
		id: m[2],
		w: Number(m[3]),
		h: Number(m[4]),
	}));
	check(
		tsNames.length === manifest.textures.length &&
			tsNames.every(
				(t, i) =>
					t.name === manifest.textures[i].name &&
					t.w === manifest.textures[i].w &&
					t.h === manifest.textures[i].h,
			),
		"worldArtAssets.ts lists exactly the manifest's textures and sizes (npm run art:world)",
		`${tsNames.length} vs ${manifest.textures.length}`,
	);
	check(
		tsNames.every(t => t.id === "" || /^rbxassetid:\/\/\d+$/.test(t.id)),
		'every id is "" or rbxassetid://<digits>',
	);
	let decodeFail = [];
	let notGrey = [];
	const decoded = {};
	for (const t of manifest.textures) {
		try {
			const img = decodePNG(readFileSync(join(ART_DIR, t.file)));
			decoded[t.name] = img;
			if (img.w !== t.w || img.h !== t.h) decodeFail.push(`${t.name} size`);
			if (t.kind === "mask" || t.kind === "tileTint") {
				for (let i = 0; i < img.w * img.h; i++) {
					const [r, g, b] = [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]];
					if (img.data[i * 4 + 3] > 0 && (r !== g || g !== b)) {
						notGrey.push(t.name);
						break;
					}
				}
			}
		} catch (e) {
			decodeFail.push(`${t.name}: ${e.message}`);
		}
	}
	check(decodeFail.length === 0, "every PNG decodes at its manifest size", decodeFail.slice(0, 3).join(", "));
	check(
		notGrey.length === 0,
		"masks and roof tiles are greyscale: the tint keeps the type colour (EDI-03)",
		notGrey.join(", "),
	);
	const mean = img => {
		let r = 0;
		let g = 0;
		let b = 0;
		let n = 0;
		for (let i = 0; i < img.w * img.h; i++) {
			const a = img.data[i * 4 + 3] / 255;
			r += img.data[i * 4] * a;
			g += img.data[i * 4 + 1] * a;
			b += img.data[i * 4 + 2] * a;
			n += a;
		}
		return [r / n, g / n, b / n];
	};
	const c255 = c => [c.R * 255, c.G * 255, c.B * 255];
	const mixc = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
	const W255 = [255, 255, 255];
	const pairs = [
		["asphalt", c255(COLORS.road)],
		["asphaltLot", mixc(c255(COLORS.road), c255(COLORS.sidewalk), 0.14)],
		["concrete", c255(COLORS.sidewalk)],
		["plaza", mixc(c255(COLORS.sidewalk), W255, 0.1)],
		["pavers", mixc(c255(COLORS.sidewalk), W255, 0.16)],
		["apron", mixc(c255(COLORS.sidewalk), c255(COLORS.road), 0.3)],
		["grass", c255(COLORS.grass)],
		["dirt", mixc(c255(COLORS.dirtPath), W255, 0.25)],
		["floorWood", c255(COLORS.floorWood)],
		["floorShop", c255(COLORS.floorShop)],
	];
	for (const [name, flat] of pairs) {
		const m = mean(decoded[name]);
		const a = lab(...m);
		const b = lab(...flat);
		const dE = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
		check(dE <= 6, `${name.padEnd(10)} keeps the flat colour it replaces`, `mean ΔE ${dE.toFixed(1)}`);
	}
}

// ================================================================ 7. the tools run

section("7) the tools: render-map renders a decodable PNG, upload-art dry-runs without a key");
{
	const dir = mkdtempSync(join(tmpdir(), "pz-render-"));
	const run = spawnSync(
		process.execPath,
		[join(ROOT, "tools", "render-map.mjs"), "--preset", "street", "--out", dir, "--quiet"],
		{
			encoding: "utf8",
			env: { ...process.env, PZ_SRC: SRC },
		},
	);
	check(run.status === 0, "tools/render-map.mjs --preset street exits 0", (run.stderr || "").split("\n")[0]);
	const png = join(dir, "street.png");
	let img;
	try {
		img = decodePNG(readFileSync(png));
	} catch (e) {
		check(false, "its PNG decodes", e.message);
	}
	if (img !== undefined) {
		check(img.w === 1280 && img.h === 800, "its PNG decodes, 1280 x 800", `${img.w} x ${img.h}`);
		let magenta = 0;
		// (a plain object: the Luau shims turn Set.size into a method)
		const seen = {};
		for (let i = 0; i < img.w * img.h; i += 7) {
			const [r, g, b] = [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]];
			if (r === 255 && g === 0 && b === 255) magenta++;
			seen[(r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3)] = true;
		}
		const colours = Object.keys(seen).length;
		check(magenta === 0, "no texture missing (magenta) in the render", `${magenta} px`);
		check(colours > 200, "and it is a picture, not a blank", `${colours} colours`);
	}
	rmSync(dir, { recursive: true, force: true });
	const dry = spawnSync(process.execPath, [join(ROOT, "tools", "cloud.mjs"), "upload-art", "--dry-run"], {
		encoding: "utf8",
	});
	check(
		dry.status === 0 &&
			dry.stdout.includes("dry run") &&
			dry.stdout.includes(`${ALL.manifest.textures.length} texturas`),
		"npm run cloud -- upload-art --dry-run lists the textures without a key",
		(dry.stdout || dry.stderr || "").split("\n")[0],
	);
}

// ================================================================ 8. the nameplate over the world

section("8) the nameplate (UI-04 clarification): every voice with its pixel shadow, on every ground, day and night");
{
	/*
	 * The nameplate has no background (the owner, 2026-09-23) and text never has a contour (UI-04), so each line lands
	 * on the ground with ONE pixel drop shadow (client/ui/skin.ts textShadow): a copy in OVER_WORLD.shadow at
	 * TRANSPARENCY.textShadow, one skin pixel down-right. What the eye gets is a glyph with a dark edge on its lower
	 * right side (letter against its own shadow) and the ground on its upper left.
	 *
	 * The grounds are the town's REAL ground, drawn by the real WorldView with every texture on (tints, kerb shadows,
	 * paint and decals included) and rasterised; each pixel is kept only where the town says that ground is
	 * (surfaceAt), so a "grass" sample is grass pixels and nothing else. Floors are the raw textures (interiors draw
	 * them untinted). Night: every ground pixel under COLORS.overlayNight at half and at full darkness (MAX_DARK) --
	 * the plate itself is drawn ABOVE the light map (gameLoop NAMEPLATE_Z), so only its ground goes dark.
	 *
	 * The two rules, per voice (name, level, handle, every title):
	 *   A. the letter against its own shadow is >= 4,5:1 over ANY ground: checked on pure white, the brightest thing a
	 *      shadow at partial opacity can sit on, and on every ground pixel below;
	 *   B. the plate never melts into a ground: on every ground pixel, the letter or its shadow is >= 30 ΔE (CIELAB)
	 *      from it -- the bar the survivor's own silhouette clears in section 5 (LEG-03).
	 * And, printed for the record (not a gate: the shadow side of the glyph carries A), the letter against the ground
	 * itself: its WCAG ratio to the ground's mean colour and the ΔE to its nearest pixel.
	 */
	// theme.ts names font weights at load (its type scale); the fake tree of this suite draws no text, so it has none
	globalThis.Enum.FontWeight ??= Object.fromEntries(
		["Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold", "Heavy"].map(n => [
			n,
			{ Name: n, EnumType: "FontWeight" },
		]),
	);
	const TH = require(join(SRC, "client/ui/theme.ts"));
	const { titleColor } = require(join(SRC, "client/ui/titleStyle.ts"));
	const { TITLES } = require(join(SRC, "shared/data/titles.ts"));
	const { MAX_DARK } = require(join(SRC, "shared/sim/clock.ts"));
	const c255 = c => [c.R * 255, c.G * 255, c.B * 255];
	const voices = [
		["name", TH.OVER_WORLD.name],
		["level", TH.OVER_WORLD.level],
		["handle", TH.OVER_WORLD.handle],
		...TITLES.map((t, i) => [`[${t.name}]`, titleColor(i)]),
	].map(([n, c]) => [n, c255(c)]);
	const shadowRgb = c255(TH.OVER_WORLD.shadow);
	const shadowA = 1 - TH.TRANSPARENCY.textShadow;
	const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
	/** the shadow as it lands on ground `g` */
	const shadowOn = g => mix(g, shadowRgb, shadowA);
	const lum = ([r, g, b]) => {
		const f = v => {
			const c = v / 255;
			return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		};
		return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
	};
	const ratio = (a, b) => {
		const x = lum(a);
		const y = lum(b);
		return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
	};
	const dE = (a, b) => {
		const p = lab(...a);
		const q = lab(...b);
		return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
	};

	// A on pure white: the bound for every ground there is
	for (const [n, c] of voices) {
		const r = ratio(c, shadowOn([255, 255, 255]));
		check(r >= 4.5, `${n.padEnd(15)} reads against its own shadow even on pure white`, `${r.toFixed(2)}:1`);
	}

	// the grounds, sampled from the real drawing
	const P = 192;
	function patchAt(x, y) {
		setArt(ALL.ids);
		const st = stage(P, P, 1);
		const view = new WorldView(shadowFn(false));
		st.cam.x = x;
		st.cam.y = y;
		const v = st.cam.viewRect(32);
		st.r.beginFrame();
		view.drawGround(st.r, st.cam, v, world);
		view.drawSolids(st.r, st.cam, v, world);
		st.r.endFrame();
		return rasterise({ layer: st.r.layer, vw: P, vh: P }, COLORS.bg, localImage);
	}
	/** up to `max` pixels of ground `kind` (or inside a crosswalk, for "zebra"), from up to three patches */
	function groundPixels(kind, max = 6000) {
		const out = [];
		let patches = 0;
		const crossings = world.crossings ?? [];
		for (let i = 0; i < 400000 && patches < 3 && out.length < max; i++) {
			let cx;
			let cy;
			if (kind === "zebra") {
				const c = crossings[(i * 7) % Math.max(1, crossings.length)];
				if (c === undefined || i >= crossings.length) break;
				cx = c.x + c.w / 2;
				cy = c.y + c.h / 2;
			} else {
				cx = 1000 + ((i * 7919) % 20000);
				cy = 1000 + ((i * 104729) % 14600);
				if (surfaceAt(cx, cy) !== kind) continue;
			}
			const img = patchAt(cx, cy);
			patches++;
			for (let py = 0; py < P; py += 2) {
				for (let px = 0; px < P; px += 2) {
					const wx = cx - P / 2 + px + 0.5;
					const wy = cy - P / 2 + py + 0.5;
					const inside =
						kind === "zebra"
							? crossings.some(c => inRect(c, wx, wy)) && surfaceAt(wx, wy) === "road"
							: surfaceAt(wx, wy) === kind;
					if (!inside) continue;
					const k = (py * P + px) * 4;
					out.push([img.data[k], img.data[k + 1], img.data[k + 2]]);
				}
			}
		}
		return out;
	}
	const grounds = [
		["sidewalk (concrete slabs)", "sidewalk"],
		["walk (light pavers)", "walk"],
		["plaza (downtown pavers)", "plaza"],
		["road (asphalt)", "road"],
		["zebra crossing", "zebra"],
		["parking lot", "parking"],
		["gas forecourt", "apron"],
		["driveway", "drive"],
		["grass (lawn)", "grass"],
		["long grass", "grassLong"],
		["park grass", "park"],
		["verge", "verge"],
		["school yard (dirt)", "playground"],
		["park path", "path"],
		["curb ramp (tactile)", "ramp"],
	].map(([label, kind]) => [label, groundPixels(kind)]);
	for (const floor of ["floorWood", "floorTile", "floorShop"]) {
		const img = localImage(ALL.ids[floor]);
		const px = [];
		for (let i = 0; i < img.w * img.h; i++) px.push([img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]]);
		grounds.push([`floor: ${floor.slice(5).toLowerCase()}`, px]);
	}
	const night = c255(COLORS.overlayNight);
	const lights = [
		["day", 0],
		["night, half-lit", 0.5],
		["night, dark", MAX_DARK],
	];
	const empty = grounds.filter(([, px]) => px.length === 0).map(([l]) => l);
	check(
		empty.length === 0,
		"every ground was found in the town and sampled",
		empty.join(", ") || `${grounds.length} grounds`,
	);

	const record = [];
	let worstA = Infinity;
	let worstAAt = "";
	let worstB = Infinity;
	let worstBAt = "";
	for (const [label, pixels] of grounds) {
		if (pixels.length === 0) continue;
		for (const [light, dark] of lights) {
			const px = dark > 0 ? pixels.map(p => mix(p, night, dark)) : pixels;
			const mean = [0, 1, 2].map(i => px.reduce((s, p) => s + p[i], 0) / px.length);
			const row = { ground: label, light, mean: mean.map(Math.round), voices: {} };
			for (const [n, c] of voices) {
				let a = Infinity;
				let b = Infinity;
				let near = Infinity;
				for (const g of px) {
					a = Math.min(a, ratio(c, shadowOn(g)));
					b = Math.min(b, Math.max(dE(c, g), dE(shadowOn(g), g)));
					near = Math.min(near, dE(c, g));
				}
				row.voices[n] = { shadow: a, block: b, ground: ratio(c, mean), nearest: near };
				if (a < worstA) {
					worstA = a;
					worstAAt = `${n} on ${label}, ${light}`;
				}
				if (b < worstB) {
					worstB = b;
					worstBAt = `${n} on ${label}, ${light}`;
				}
			}
			record.push(row);
		}
	}
	check(
		worstA >= 4.5,
		"A: every voice against its own shadow, on every ground pixel",
		`worst ${worstA.toFixed(2)}:1 (${worstAAt})`,
	);
	check(
		worstB >= 30,
		"B: the letter or its shadow stands 30 ΔE off every ground pixel",
		`worst ${worstB.toFixed(1)} ΔE (${worstBAt})`,
	);

	// the record: the letter against the ground's mean colour (WCAG) and its own shadow (worst pixel), per ground
	const shown = ["name", "level", "handle", ...TITLES.map(t => `[${t.name}]`)];
	console.log(
		`\n    ground x light                          mean     ${shown.map(n => n.slice(0, 9).padStart(10)).join("")}`,
	);
	for (const row of record) {
		const cells = shown.map(n => {
			const v = row.voices[n];
			return `${v.ground.toFixed(1)}/${v.shadow.toFixed(1)}`.padStart(10);
		});
		const hexOf = row.mean.map(v => v.toString(16).padStart(2, "0")).join("");
		console.log(`    ${`${row.ground}, ${row.light}`.padEnd(40)}#${hexOf}${cells.join("")}`);
	}
	console.log("    (each cell: the letter against the ground's mean colour / against its own shadow, worst pixel)");
	if (process.env.PZ_PLATE_RECORD) writeFileSync(process.env.PZ_PLATE_RECORD, JSON.stringify(record, undefined, 1));
}

console.log(failures === 0 ? "\nworld-art: all checks passed" : `\nworld-art: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
