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
 *   1. NO ART, NO CHANGE. With no asset id the town is drawn exactly as the golden flat town: the stream of draw
 *      calls of drawGround + drawSolids over seven scenes (day, night, overview, the map border) and a camera pan
 *      hashes to tools/golden/world-flat.json, recorded from the flat drawing of e097eb3 (the commit before the
 *      art) and re-recorded on purpose only when the flat drawing changes: the storefront signs (ART-07) replaced
 *      the rooftop emblems in downtown, school, gas and overview. A second digest per scene, with the signage hook
 *      stubbed out, still equals 8725b0b's with its emblem stubbed out: the signs are the only change. And not one
 *      sprite shows an image.
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
 *   8. THE STOREFRONT SIGNS (EDI-03, ART-07, client/view/buildingSigns.ts). Every type that is not a house has its
 *      own sign (face colour and pictogram unlike any other); its texture is its grid texel for texel and the flat
 *      drawing's runs repaint the same grid; on every building of five towns it stands on the roof, on the entrance
 *      wall, beside the doorway and never over it, at most a fifth of the facade; it is upright and costs a bounded
 *      number of sprites (flat and art, every kind of wear); rasterised with the textures it reads against its roof
 *      and the ground in front by day and in the survivor's light at 22:00, and out of the light it is exactly as
 *      dark as its roof (no sign glows, LUZ-02); the textured roofs keep the type colours apart.
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

/**
 * The building's signage hook (client/view/buildingSigns.ts through WorldView.drawSignage; drawEmblem before the
 * signs): stubbed out, a digest says whether everything BUT the signs is still the town of the golden.
 */
const SIGN_HOOK = "drawSignage" in WorldView.prototype ? "drawSignage" : "drawEmblem";

function digestOf(scene, noSigns = false) {
	const st = stage(Math.round(scene.w * scene.zoom), Math.round(scene.h * scene.zoom), scene.zoom);
	const cx = scene.x + scene.w / 2;
	const cy = scene.y + scene.h / 2;
	const view = new WorldView(shadowFn(scene.night, cx - 60, cy + 40));
	if (noSigns) view[SIGN_HOOK] = () => {};
	calls.length = 0;
	capturing = true;
	drawTown(st, view, cx, cy);
	// a short pan: clipping at the view's edges changes every frame
	for (let f = 1; f <= 12; f++) drawTown(st, view, cx + f * 37, cy + f * 11);
	capturing = false;
	const json = JSON.stringify(calls);
	return { count: calls.length, sha1: createHash("sha1").update(json).digest("hex"), layer: st.r.layer };
}

section("1) no asset id: the town is drawn exactly as the golden flat town");
setArt({});
const flatDigests = {};
const bareDigests = {};
for (const sc of SCENES) {
	flatDigests[sc.name] = digestOf(sc);
	bareDigests[sc.name] = digestOf(sc, true);
}
if (GOLDEN_MODE) {
	mkdirSync(join(ROOT, "tools", "golden"), { recursive: true });
	const out = {
		note: "draw-call digests of WorldView.drawGround + drawSolids with no world art (tools/test-world-art.mjs --golden); noSigns: the same with the building-signage hook stubbed out",
		recordedFrom: process.env.PZ_GOLDEN_FROM ?? "the src it was run on",
		scenes: Object.fromEntries(
			SCENES.map(sc => {
				const d = flatDigests[sc.name];
				const b = bareDigests[sc.name];
				return [sc.name, { count: d.count, sha1: d.sha1, noSigns: { count: b.count, sha1: b.sha1 } }];
			}),
		),
	};
	writeFileSync(GOLDEN, `${JSON.stringify(out, undefined, "\t")}\n`);
	console.log(`wrote ${GOLDEN}`);
	process.exit(0);
}
const goldenFile = JSON.parse(readFileSync(GOLDEN, "utf8"));
const golden = goldenFile.scenes;
console.log(`  (golden: ${goldenFile.recordedFrom})`);
for (const sc of SCENES) {
	const d = flatDigests[sc.name];
	const g = golden[sc.name];
	check(
		g !== undefined && d.count === g.count && d.sha1 === g.sha1,
		`${sc.name}: same ${d.count} draw calls as the golden`,
		g === undefined ? "no golden" : `${d.sha1.slice(0, 10)} vs ${g.sha1.slice(0, 10)}, ${g.count} calls`,
	);
}
{
	// the signs are the only thing a sign change may change: without them, every scene is the golden's town
	const off = SCENES.filter(sc => {
		const b = bareDigests[sc.name];
		const g = golden[sc.name]?.noSigns;
		return g === undefined || b.count !== g.count || b.sha1 !== g.sha1;
	});
	check(
		off.length === 0,
		"and without the signage hook every scene is the same town (only the signs are new)",
		off.map(sc => sc.name).join(", "),
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

// ================================================================ 8. the storefront signs (EDI-03, ART-07)

section("8) the storefront signs: one per type, at the main entrance, cheap, legible day and night");
const BS = require(join(SRC, "client/view/buildingSigns.ts"));
const SD = require(join(SRC, "shared/data/buildingSigns.ts"));
const { TOWN } = require(join(SRC, "shared/engine/constants.ts"));
const { LightMap } = require(join(SRC, "shared/engine/renderer.ts"));
const { darkAlphaAt } = require(join(SRC, "shared/sim/clock.ts"));
const SIGN_TYPES = [3, 4, 5, 6, 7, 8, 9, 10, 11];
const TX = SD.SIGN_TEXEL;
const rgb255 = c => [c.R * 255, c.G * 255, c.B * 255];
const dE = (p, q) => {
	const a = lab(...p);
	const b = lab(...q);
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};
const luminance = ([r, g, b]) => {
	const f = c => {
		c /= 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
/** the frame of a board: its outline, its lit top row, its grimy bottom row and the face colour (the commonest) */
function frameOf(sign) {
	const rows = sign.rows;
	const h = rows.length;
	const w = rows[0].length;
	const count = {};
	for (let y = 2; y < h - 2; y++) for (let x = 1; x < w - 1; x++) count[rows[y][x]] = (count[rows[y][x]] ?? 0) + 1;
	const face = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
	return { w, h, face, top: rows[1][1], bottom: rows[h - 2][1] };
}
{
	// --- the data: one sign per type that is not a house, well-formed, no two alike
	const bad = [];
	for (const t of [0, 1, 2]) if (SD.BUILDING_SIGNS[t] !== undefined) bad.push(`type ${t} is a house and has a sign`);
	const seenTexture = {};
	for (const t of SIGN_TYPES) {
		const s = SD.BUILDING_SIGNS[t];
		if (s === undefined) {
			bad.push(`type ${t} has no sign`);
			continue;
		}
		const { w, h } = frameOf(s);
		if (!((w === 24 && h === 16) || (w === 32 && h === 20))) bad.push(`type ${t}: a ${w} x ${h} board`);
		if (s.rows.some(r => r.length !== w)) bad.push(`type ${t}: rows of different lengths`);
		for (let x = 0; x < w; x++)
			if (s.rows[0][x] !== "k" || s.rows[h - 1][x] !== "k") bad.push(`type ${t}: outline`);
		for (let y = 0; y < h; y++)
			if (s.rows[y][0] !== "k" || s.rows[y][w - 1] !== "k") bad.push(`type ${t}: outline`);
		const used = {};
		for (const ch of s.rows.join("")) used[ch] = true;
		for (const ch of Object.keys(used)) {
			if (SD.SIGN_ART[ch] === undefined) bad.push(`type ${t}: '${ch}' is not a sign colour`);
			if (!s.order.includes(ch)) bad.push(`type ${t}: '${ch}' is not in its paint order`);
		}
		const order = {};
		for (const ch of s.order) {
			if (order[ch]) bad.push(`type ${t}: '${ch}' twice in its paint order`);
			order[ch] = true;
		}
		if (s.order[0] !== "k") bad.push(`type ${t}: the outline is not painted first`);
		if (seenTexture[s.texture] !== undefined) bad.push(`types ${seenTexture[s.texture]} and ${t} share a texture`);
		seenTexture[s.texture] = t;
	}
	check(bad.length === 0, "every type but the houses has its own well-formed sign", bad.slice(0, 3).join("; "));
	// no two alike: another face colour, and another picture
	let minFace = Infinity;
	let minPicture = Infinity;
	let pair = "";
	let picturePair = "";
	for (let i = 0; i < SIGN_TYPES.length; i++) {
		for (let j = i + 1; j < SIGN_TYPES.length; j++) {
			const a = SD.BUILDING_SIGNS[SIGN_TYPES[i]];
			const b = SD.BUILDING_SIGNS[SIGN_TYPES[j]];
			const fa = frameOf(a);
			const fb = frameOf(b);
			const face = dE(rgb255(SD.SIGN_ART[fa.face]), rgb255(SD.SIGN_ART[fb.face]));
			let picture = 1;
			if (fa.w === fb.w && fa.h === fb.h) {
				let diff = 0;
				for (let y = 0; y < fa.h; y++) {
					for (let x = 0; x < fa.w; x++) {
						const pa = a.rows[y][x] === fa.face;
						const pb = b.rows[y][x] === fb.face;
						if (pa !== pb) diff++;
					}
				}
				picture = diff / (fa.w * fa.h);
			}
			if (face < minFace) {
				minFace = face;
				pair = `${SIGN_TYPES[i]}/${SIGN_TYPES[j]}`;
			}
			if (picture < minPicture) {
				minPicture = picture;
				picturePair = `${SIGN_TYPES[i]}/${SIGN_TYPES[j]}`;
			}
		}
	}
	check(minFace >= 10, "no two boards share a face colour", `closest faces ΔE ${minFace.toFixed(1)} (types ${pair})`);
	check(
		minPicture >= 0.1,
		"no two pictograms share a shape",
		`the closest two (types ${picturePair}) differ on ${(minPicture * 100).toFixed(0)}% of their texels`,
	);
}
{
	// --- the art and the flat drawing are the same picture: the PNG is the grid, the runs repaint the grid
	const badPng = [];
	const badRuns = [];
	let maxLayer = 0;
	const runCounts = [];
	for (const t of SIGN_TYPES) {
		const s = SD.BUILDING_SIGNS[t];
		const { w, h } = frameOf(s);
		const png = join(ART_DIR, `${s.texture}.png`);
		if (!existsSync(png)) {
			badPng.push(`${s.texture}: no PNG`);
			continue;
		}
		const img = decodePNG(readFileSync(png));
		if (img.w !== w || img.h !== h) badPng.push(`${s.texture}: ${img.w} x ${img.h}`);
		else {
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					const want = rgb255(SD.SIGN_ART[s.rows[y][x]]).map(Math.round);
					const i = (y * w + x) * 4;
					const got = [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
					if (got[3] !== 255 || want.some((v, k) => Math.abs(v - got[k]) > 1)) {
						badPng.push(`${s.texture} (${x}, ${y})`);
						y = h;
						break;
					}
				}
			}
		}
		// paint the runs in draw order (layer, then list order) and compare with the grid, texel by texel
		const runs = BS.signRuns(t);
		runCounts.push(runs.length);
		const paint = new Array(w * h).fill(undefined);
		const sorted = runs.map((q, i) => ({ q, i })).sort((a, b) => a.q[7] - b.q[7] || a.i - b.i);
		for (const { q } of sorted) {
			maxLayer = Math.max(maxLayer, q[7]);
			for (let y = q[1]; y < q[1] + q[3]; y++) {
				for (let x = q[0]; x < q[0] + q[2]; x++) paint[y * w + x] = [q[4] * 255, q[5] * 255, q[6] * 255];
			}
		}
		for (let y = 0; y < h && badRuns.length < 3; y++) {
			for (let x = 0; x < w; x++) {
				const want = rgb255(SD.SIGN_ART[s.rows[y][x]]);
				const got = paint[y * w + x];
				if (got === undefined || want.some((v, k) => Math.abs(v - got[k]) > 0.5)) {
					badRuns.push(`type ${t} (${x}, ${y})`);
					break;
				}
			}
		}
	}
	check(badPng.length === 0, "each sign's texture is its grid, texel for texel", badPng.slice(0, 3).join(", "));
	check(
		badRuns.length === 0,
		"the flat drawing's runs repaint exactly the same grid",
		badRuns.join(", ") || `${Math.min(...runCounts)}-${Math.max(...runCounts)} runs a board`,
	);
	check(
		maxLayer <= BS.SIGN_MAX_LAYER,
		`the runs stack at most ${BS.SIGN_MAX_LAYER} layers (under the wear, under the canopy)`,
		`${maxLayer}`,
	);
}
/** where a building's sign goes, by its record: the hook's arguments (worldView.ts drawSignage) */
const signOf = b => BS.signRect(b.buildingType ?? 1, b.doorSide ?? "bottom", b.doorX, b.doorY, b);
{
	// --- placement, on every building of five towns: at the main entrance, facing its street, on the roof
	const seeds = [DESIGN.TOWN_SEED, 1, 42, 99991, 123456];
	const bad = [];
	let signs = 0;
	let maxShare = 0;
	for (const seed of seeds) {
		const w = seed === DESIGN.TOWN_SEED ? world : generateTown(seed);
		for (const b of w.solids) {
			if (b.kind !== "building") continue;
			const t = b.buildingType ?? 1;
			const q = signOf(b);
			if (t <= 2) {
				if (q !== undefined) bad.push(`${seed}: house #${b.id} has a sign`);
				continue;
			}
			if (q === undefined) {
				bad.push(`${seed}: ${b.tags} #${b.id} has no sign`);
				continue;
			}
			signs++;
			const side = b.doorSide;
			const alongX = side === "top" || side === "bottom";
			// on the roof: never over the sidewalk
			if (q.x < b.x || q.y < b.y || q.x + q.w > b.x + b.w || q.y + q.h > b.y + b.h)
				bad.push(`${seed}: ${b.tags} #${b.id}: the sign leaves the footprint`);
			// on the entrance wall, SIGN_INSET in from its facade
			const inset =
				side === "top"
					? q.y - b.y
					: side === "bottom"
						? b.y + b.h - (q.y + q.h)
						: side === "left"
							? q.x - b.x
							: b.x + b.w - (q.x + q.w);
			if (Math.abs(inset - BS.SIGN_INSET) > 0.01)
				bad.push(`${seed}: ${b.tags} #${b.id}: ${inset} u from its entrance wall`);
			// beside the doorway, never over it: SIGN_GAP clear of the opening, right next to it
			const u = alongX ? b.doorX : b.doorY;
			const a0 = alongX ? q.x : q.y;
			const a1 = a0 + (alongX ? q.w : q.h);
			const d0 = u - TOWN.DOOR_W / 2;
			const d1 = u + TOWN.DOOR_W / 2;
			const gap = a0 >= d1 ? a0 - d1 : d0 - a1;
			if (gap < BS.SIGN_GAP - 0.5) bad.push(`${seed}: ${b.tags} #${b.id}: ${gap.toFixed(1)} u from the doorway`);
			else if (gap > BS.SIGN_GAP + 0.5) bad.push(`${seed}: ${b.tags} #${b.id}: ${gap.toFixed(1)} u off its door`);
			// sized to the building: no giant sticker
			maxShare = Math.max(maxShare, (a1 - a0) / (alongX ? b.w : b.h));
			if (BS.hasHelipad(t)) {
				const p = BS.helipadRect(b);
				if (p.x < b.x || p.y < b.y || p.x + p.w > b.x + b.w || p.y + p.h > b.y + b.h)
					bad.push(`${seed}: ${b.tags} #${b.id}: the helipad leaves the roof`);
				if (p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h)
					bad.push(`${seed}: ${b.tags} #${b.id}: the helipad under the sign`);
			}
		}
	}
	check(
		bad.length === 0,
		"every sign stands on its roof, on the entrance wall, beside the doorway (5 towns)",
		bad.slice(0, 3).join("; ") || `${signs} signs`,
	);
	check(
		maxShare <= 0.2,
		"and is sized to its building: at most a fifth of its facade",
		`${(maxShare * 100).toFixed(0)}% at most`,
	);
}
{
	// --- what one building's signage costs, drawn through the real renderer: every type, every kind of wear
	const bucket = (x, y) => {
		const h = hash01(x, y, 91);
		return h < 0.3 ? 0 : h < 0.45 ? 1 : h < 0.65 ? 2 : 3;
	};
	const bad = [];
	const cost = { flat: {}, art: {} };
	for (const [label, ids] of [
		["flat", {}],
		["art", ALL.ids],
	]) {
		setArt(ids);
		for (const t of SIGN_TYPES) {
			const real = world.solids.find(s => s.kind === "building" && s.buildingType === t);
			const done = {};
			for (let i = 0; i < 400 && Object.keys(done).length < 4; i++) {
				// the same footprint, moved until every wear bucket was drawn once
				const roof = { x: real.x + i * 8, y: real.y, w: real.w, h: real.h };
				const k = bucket(roof.x, roof.y);
				if (done[k]) continue;
				done[k] = true;
				const dx = real.doorX + i * 8;
				const dy = real.doorY;
				const q = BS.signRect(t, real.doorSide, dx, dy, roof);
				const st = stage(1400, 1400, 1);
				st.cam.x = roof.x + roof.w / 2;
				st.cam.y = roof.y + roof.h / 2;
				const v = st.cam.viewRect(32);
				st.r.beginFrame();
				calls.length = 0;
				capturing = true;
				BS.drawBuildingSign(st.r, st.cam, v, t, dx, dy, real.doorSide, roof, 1, shadowFn(false));
				capturing = false;
				st.r.endFrame();
				const n = calls.length;
				cost[label][t] = Math.max(cost[label][t] ?? 0, n);
				const helipad = BS.hasHelipad(t) ? 6 : 0;
				const max = label === "flat" ? BS.SIGN_MAX_FLAT + helipad : BS.SIGN_MAX_ART;
				if (n > max) bad.push(`${label} type ${t}: ${n} sprites`);
				const alongX = real.doorSide === "top" || real.doorSide === "bottom";
				for (const c of calls) {
					const [x, y, w, h, rot, , , z, , , , , , , , image] = c;
					if (rot !== undefined && rot !== 0) bad.push(`${label} type ${t}: a rotated sprite`);
					if (z < Z.roof + 1 || z >= Z.canopy) bad.push(`${label} type ${t}: ZIndex ${z}`);
					// every sprite on the roof (the board's shadow too), none over the doorway
					if (x - w / 2 < roof.x - 0.01 || x + w / 2 > roof.x + roof.w + 0.01)
						bad.push(`${label} type ${t}: a sprite leaves the roof`);
					if (y - h / 2 < roof.y - 0.01 || y + h / 2 > roof.y + roof.h + 0.01)
						bad.push(`${label} type ${t}: a sprite leaves the roof`);
					const a0 = alongX ? x - w / 2 : y - h / 2;
					const a1 = alongX ? x + w / 2 : y + h / 2;
					const u = alongX ? dx : dy;
					const nearWall = alongX
						? Math.min(Math.abs(y - h / 2 - roof.y), Math.abs(y + h / 2 - roof.y - roof.h)) < TOWN.WALL_T
						: Math.min(Math.abs(x - w / 2 - roof.x), Math.abs(x + w / 2 - roof.x - roof.w)) < TOWN.WALL_T;
					if (nearWall && a1 > u - TOWN.DOOR_W / 2 && a0 < u + TOWN.DOOR_W / 2)
						bad.push(`${label} type ${t}: a sprite over the doorway`);
					if (label === "art" && image !== undefined && q !== undefined && w === q.w && h === q.h) {
						if (nameOf[image] !== SD.BUILDING_SIGNS[t].texture)
							bad.push(`art type ${t}: the board shows ${nameOf[image]}`);
					}
				}
			}
		}
	}
	setArt({});
	check(bad.length === 0, "upright, on the roof, clear of the doorway, within budget", bad.slice(0, 3).join("; "));
	const row = label =>
		SIGN_TYPES.map(t => `${SD.BUILDING_SIGNS[t].texture.slice(4).toLowerCase()} ${cost[label][t]}`).join(", ");
	console.log(`       flat sprites a building (worst wear): ${row("flat")}`);
	console.log(`       art  sprites a building (worst wear): ${row("art")}`);
}
{
	// --- legibility: the board against its roof and the ground in front, the pictogram against the board,
	// rasterised through the real code with the textures (what the owner sees), at 10:00 and at 22:00 in the
	// survivor's light at the door; and in the dark, the sign darkens like its roof (it does not glow, LUZ-02)
	setArt(ALL.ids);
	const VW = 480;
	const VH = 360;
	const dark = darkAlphaAt(22, false, false);
	function render(b, q, mode) {
		const st = stage(VW, VH, 1);
		const cx = q.x + q.w / 2;
		const cy = q.y + q.h / 2;
		st.cam.x = cx;
		st.cam.y = cy;
		const n = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }[b.doorSide];
		const lx = b.doorX + n[0] * 60;
		const ly = b.doorY + n[1] * 60;
		const view = new WorldView(shadowFn(mode !== "day", lx, ly));
		const v = st.cam.viewRect(32);
		st.r.beginFrame();
		view.drawGround(st.r, st.cam, v, world);
		view.drawSolids(st.r, st.cam, v, world);
		st.r.endFrame();
		let darkFrame;
		if (mode !== "day") {
			darkFrame = gui.make("Frame");
			darkFrame.Parent = st.root;
			darkFrame.BackgroundTransparency = 1;
			const lm = new LightMap(darkFrame, COLORS.overlayNight);
			lm.update(st.cam, dark, mode === "lit" ? [{ x: lx, y: ly, r: 250, inner: 0.4 }] : []);
		}
		const img = rasterise({ layer: st.r.layer, dark: darkFrame, vw: VW, vh: VH }, COLORS.bg, localImage);
		const px = (wx, wy) => {
			const sx = Math.floor(wx - cx + VW / 2);
			const sy = Math.floor(wy - cy + VH / 2);
			const i = (sy * VW + sx) * 4;
			return [img.data[i], img.data[i + 1], img.data[i + 2]];
		};
		return px;
	}
	const mean = list => {
		const s = [0, 0, 0];
		for (const p of list) for (let k = 0; k < 3; k++) s[k] += p[k];
		return s.map(v => v / Math.max(1, list.length));
	};
	function measure(b, q, px) {
		const s = SD.BUILDING_SIGNS[b.buildingType];
		const f = frameOf(s);
		const face = [];
		const rim = [];
		const picture = [];
		for (let y = 0; y < f.h; y++) {
			for (let x = 0; x < f.w; x++) {
				const ch = s.rows[y][x];
				const p = px(q.x + (x + 0.5) * TX, q.y + (y + 0.5) * TX);
				if (x === 0 || y === 0 || x === f.w - 1 || y === f.h - 1) rim.push(p);
				else if (y === 1 || y === f.h - 2) continue;
				else if (ch === f.face) face.push(p);
				else picture.push(p);
			}
		}
		// the roof round the board (12 to 28 u out, on the roof) and the ground in front of the facade
		const roof = [];
		const ground = [];
		const n = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }[b.doorSide];
		for (let y = q.y - 28; y <= q.y + q.h + 28; y += 4) {
			for (let x = q.x - 28; x <= q.x + q.w + 28; x += 4) {
				const out = Math.max(q.x - x, x - q.x - q.w, q.y - y, y - q.y - q.h);
				if (out < 12 || x < b.x + 8 || y < b.y + 8 || x > b.x + b.w - 8 || y > b.y + b.h - 8) continue;
				roof.push(px(x, y));
			}
		}
		for (let k = 40; k <= 100; k += 6) {
			for (let a = 0; a <= 1; a += 0.1) {
				const x = n[0] !== 0 ? (n[0] < 0 ? b.x : b.x + b.w) + n[0] * k : q.x + a * q.w;
				const y = n[1] !== 0 ? (n[1] < 0 ? b.y : b.y + b.h) + n[1] * k : q.y + a * q.h;
				ground.push(px(x, y));
			}
		}
		const F = mean(face);
		const R = mean(roof);
		const pic = picture.reduce((m, p) => m + dE(p, F), 0) / Math.max(1, picture.length);
		return {
			board: Math.max(dE(F, R), dE(mean(rim), R)),
			ground: dE(F, mean(ground)),
			picture: pic,
			face: F,
			roof: R,
		};
	}
	/**
	 * How dark the night made a colour: the overlay's share `a` in night = day + a (overlay - day), least squares
	 * over the three channels.
	 */
	const OVERLAY = rgb255(COLORS.overlayNight);
	const darkShare = (day, night) => {
		let num = 0;
		let den = 0;
		for (let k = 0; k < 3; k++) {
			num += (night[k] - day[k]) * (OVERLAY[k] - day[k]);
			den += (OVERLAY[k] - day[k]) ** 2;
		}
		return den > 0 ? num / den : 0;
	};
	const rows = [];
	const bad = [];
	const roofs = {};
	const darkShares = [];
	for (const t of SIGN_TYPES) {
		// a building of the type whose sign carries only its grime (no crack, chip or bleach over the picture)
		const all = world.solids.filter(s => s.kind === "building" && s.buildingType === t);
		const b = all.find(s => hash01(s.x, s.y, 91) >= 0.65) ?? all[0];
		const q = signOf(b);
		const day = measure(b, q, render(b, q, "day"));
		const lit = measure(b, q, render(b, q, "lit"));
		const off = measure(b, q, render(b, q, "dark"));
		roofs[t] = day.roof;
		rows.push({ t, day, lit, off });
		const name = SD.BUILDING_SIGNS[t].texture.slice(4).toLowerCase();
		if (day.board < 30) bad.push(`${name}: board on its roof ΔE ${day.board.toFixed(0)} by day`);
		if (day.ground < 15) bad.push(`${name}: board on the ground in front ΔE ${day.ground.toFixed(0)} by day`);
		if (day.picture < 30) bad.push(`${name}: pictogram on its board ΔE ${day.picture.toFixed(0)} by day`);
		if (lit.board < 15 || lit.picture < 15 || lit.ground < 10)
			bad.push(`${name}: in the survivor's light at night`);
		// in the dark the board is as dark as its roof (the same share of night over both): it does not glow
		const faceDark = darkShare(day.face, off.face);
		const roofDark = darkShare(day.roof, off.roof);
		if (Math.abs(faceDark - roofDark) > 0.03 || faceDark < dark - 0.03)
			bad.push(`${name}: night over the board ${faceDark.toFixed(2)}, over its roof ${roofDark.toFixed(2)}`);
		darkShares.push(faceDark);
	}
	console.log(
		"       ΔE (CIELAB)       board/roof  board/ground  pictogram/board   (day | 22:00 in the survivor's light)",
	);
	for (const { t, day, lit } of rows) {
		const name = SD.BUILDING_SIGNS[t].texture.slice(4).toLowerCase().padEnd(9);
		const f = (a, b) => `${a.toFixed(0).padStart(3)} |${b.toFixed(0).padStart(3)}`;
		console.log(
			`       ${name}         ${f(day.board, lit.board)}      ${f(day.ground, lit.ground)}      ${f(day.picture, lit.picture)}`,
		);
	}
	check(
		bad.length === 0,
		"every sign reads on its roof, by day and in the survivor's light at night",
		bad.join("; "),
	);
	check(
		darkShares.length === SIGN_TYPES.length && bad.every(s => !s.includes("night over")),
		"out of the light a sign is as dark as its roof: no sign glows (LUZ-02)",
		`night over every board ${Math.min(...darkShares).toFixed(2)}-${Math.max(...darkShares).toFixed(2)} (the night's ${dark.toFixed(2)})`,
	);
	// the roof colour is the second cue: still apart once the textures tint it (the two food stores share it)
	let minRoof = Infinity;
	let roofPair = "";
	for (let i = 0; i < SIGN_TYPES.length; i++) {
		for (let j = i + 1; j < SIGN_TYPES.length; j++) {
			const a = SIGN_TYPES[i];
			const b = SIGN_TYPES[j];
			if (a === 7 && b === 8) continue;
			const d = dE(roofs[a], roofs[b]);
			if (d < minRoof) {
				minRoof = d;
				roofPair = `${a}/${b}`;
			}
		}
	}
	check(
		minRoof >= 10,
		"the textured roofs keep their type colours apart (market and grocery share theirs)",
		`closest ΔE ${minRoof.toFixed(1)} (types ${roofPair})`,
	);
	setArt({});
}

console.log(failures === 0 ? "\nworld-art: all checks passed" : `\nworld-art: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
