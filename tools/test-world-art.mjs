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
 *   8. THE CHARACTERS' ART (ART-07..ART-10). The sheets have the layout client/view/charSheets.ts reads, within
 *      1024 px, with a clear margin round every cell and Fill + Rim masks that are exactly each cell. With no
 *      character id every survivor, zombie and pet makes the draw calls it made before the art
 *      (tools/golden/characters-flat.json, recorded from f3c5564); each group falls back on its own; with the
 *      sheets a survivor is two sprites, a zombie and a pet one. The cost of a night -- 60 zombies, 4 survivors and
 *      their pets, 300 frames -- flat against art: sprites, Instances, property writes, time, and no churn.
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
import { castDrawer, characterCast } from "./character-cast.mjs";

const GOLDEN_MODE = process.argv.includes("--golden");
// --golden-chars: rewrites tools/golden/characters-flat.json from the CURRENT src (run it on the commit before the
// characters' art, with PZ_SRC, and PZ_GOLDEN_FROM naming it)
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

// the characters' draw calls with no character id (§8), and --golden-chars: record them from this src
const GOLDEN_CHARS = join(ROOT, "tools", "golden", "characters-flat.json");
function charDigest() {
	const cast = characterCast(require, SRC);
	const drawMember = castDrawer(require, SRC, shadowFn(false));
	const st = stage(1400, 1400, 1);
	st.cam.x = 600;
	st.cam.y = 600;
	calls.length = 0;
	capturing = true;
	st.r.beginFrame();
	cast.forEach((m, i) => drawMember(st, m, (i % 12) * 110, Math.floor(i / 12) * 110));
	st.r.endFrame();
	capturing = false;
	const sha1 = createHash("sha1").update(JSON.stringify(calls)).digest("hex");
	return { count: calls.length, sha1, images: countSprites(st.r.layer).images };
}
if (process.argv.includes("--golden-chars")) {
	setArt({});
	const d = charDigest();
	const out = {
		note: "draw-call digest of the flat survivors, zombies and pets of tools/character-cast.mjs (tools/test-world-art.mjs --golden-chars)",
		recordedFrom: process.env.PZ_GOLDEN_FROM ?? "the src it was run on",
		count: d.count,
		sha1: d.sha1,
	};
	writeFileSync(GOLDEN_CHARS, `${JSON.stringify(out, undefined, "\t")}\n`);
	console.log(`wrote ${GOLDEN_CHARS} (${d.count} calls)`);
	process.exit(0);
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
/**
 * The three looks of a frame: "flat" (no id at all), "town" (the town's textures, the characters still flat: what
 * the owner's Studio shows today) and "chars" (the town and the characters' pixel art, ART-07).
 */
const CHAR_SHEETS = new Set(
	ALL.manifest.textures
		.filter(t => t.kind === "sheet" || /^(survivors[A-Z]|zombies)(Fill|Rim)$/.test(t.name))
		.map(t => t.name),
);
const TOWN_IDS = Object.fromEntries(Object.entries(ALL.ids).filter(([name]) => !CHAR_SHEETS.has(name)));
function shot(p, actor, look) {
	setArt(look === "chars" ? ALL.ids : look === "town" ? TOWN_IDS : {});
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
	// the walker the horde draws (humanoidView.drawZombie: its pixel art with the character sheets live)
	if (actor === "zombie")
		HV.drawZombie(st.r, st.cam, p.x, p.y, 0.7, 16 / 18, 1, 0, 1, 0.8, Z.zombie, 0, false, false, false);
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
 * How deep into the body the step is looked for: one texel of the art (4 px at zoom 1) and a pixel. It was 3 px,
 * enough for the flat drawing's 2-px rims; with the characters' pixel art (ART-07) the outline is a whole texel,
 * and a near-black texel on dark asphalt is only half of what separates a body from the road -- the other half is
 * the jacket's blue a texel further in. Both drawings are measured with the same window.
 */
const REACH = 5;
/**
 * Silhouette contrast: for every ground pixel touching the body, the strongest colour step (ΔE) to a body pixel
 * within REACH px -- a dark rim, a bright body or both. Averaged along the whole outline.
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
		for (let dy = -REACH; dy <= REACH; dy++) {
			for (let dx = -REACH; dx <= REACH; dx++) {
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
	let worstZombieChars = Infinity;
	let worstSurvivorChars = Infinity;
	for (const kind of kinds) {
		const p = spotOn(kind);
		if (p === undefined) {
			check(false, `a spot of ${kind} in the town`);
			continue;
		}
		const res = {};
		for (const actor of ["zombie", "survivor"]) {
			for (const look of ["flat", "town", "chars"]) {
				const base = shot(p, actor === "zombie" ? "zombieShadow" : "none", look);
				res[`${actor}.${look}`] = silhouette(base, shot(p, actor, look));
			}
		}
		const f = (actor, look) => res[`${actor}.${look}`].toFixed(1);
		worstZombie = Math.min(worstZombie, res["zombie.town"]);
		worstSurvivor = Math.min(worstSurvivor, res["survivor.town"]);
		worstZombieChars = Math.min(worstZombieChars, res["zombie.chars"]);
		worstSurvivorChars = Math.min(worstSurvivorChars, res["survivor.chars"]);
		check(
			res["zombie.town"] >= res["zombie.flat"] * 0.9 && res["survivor.town"] >= res["survivor.flat"] * 0.9,
			`${kind.padEnd(9)}: the textures keep both silhouettes`,
			`walker ${f("zombie", "flat")} -> ${f("zombie", "town")} -> art ${f("zombie", "chars")}, survivor ${f("survivor", "flat")} -> ${f("survivor", "town")} -> art ${f("survivor", "chars")} ΔE`,
		);
	}
	// e097eb3 measured 15.1 for a walker on grass (its outline was the lawn's own colour) and ~35-42 elsewhere
	check(
		worstZombie >= 25,
		"a walker stands out on the worst ground (was 15 with the old outline)",
		`${worstZombie.toFixed(1)} ΔE`,
	);
	check(worstSurvivor >= 30, "the survivor stands out on the worst ground", `${worstSurvivor.toFixed(1)} ΔE`);
	// the characters' pixel art (ART-07): a near-black outline a texel wide round every body, on every ground
	check(
		worstZombieChars >= 40,
		"with the characters' art, the walker stands out further on the worst ground",
		`${worstZombieChars.toFixed(1)} ΔE`,
	);
	check(
		worstSurvivorChars >= 35,
		"with the characters' art, the survivor still clears the bar on the worst ground",
		`${worstSurvivorChars.toFixed(1)} ΔE`,
	);
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

// ================================================================ 8. the characters' pixel art

section("8) the characters' pixel art (ART-07..ART-10): sheets, fallback, cost of a horde");
{
	const CS = require(join(SRC, "client/view/charSheets.ts"));
	const manifest = ALL.manifest;
	const byName = Object.fromEntries(manifest.textures.map(t => [t.name, t]));
	const img = name => decodePNG(readFileSync(join(ART_DIR, `${name}.png`)));

	// ---- 8a. the sheets
	const sheets = [
		["survivorsA", CS.SURVIVOR_CELL, CS.SURVIVOR_ROWS, true],
		["survivorsB", CS.SURVIVOR_CELL, CS.SURVIVOR_ROWS, true],
		["weapons", CS.WEAPON_CELL, CS.WEAPON_ROWS, false],
		["zombies", CS.ZOMBIE_CELL, CS.ZOMBIE_ROWS, true],
		["dogs", CS.DOG_CELL, CS.DOG_ROWS, false],
		["birds", CS.BIRD_CELL, CS.BIRD_ROWS, false],
	];
	const bad = [];
	for (const [name, cell, rows, masks] of sheets) {
		const t = byName[name];
		if (t === undefined) {
			bad.push(`${name} missing`);
			continue;
		}
		if (t.w !== CS.CHAR_DIRS * cell || t.h !== rows * cell) bad.push(`${name} is ${t.w}x${t.h}`);
		if (t.w > 1024 || t.h > 1024) bad.push(`${name} over 1024`);
		const colour = img(name);
		const fill = masks ? img(`${name}Fill`) : undefined;
		const rim = masks ? img(`${name}Rim`) : undefined;
		let empty = 0;
		let margin = 0;
		let maskMismatch = 0;
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < CS.CHAR_DIRS; c++) {
				let any = false;
				for (let y = 0; y < cell; y++) {
					for (let x = 0; x < cell; x++) {
						const i = ((r * cell + y) * colour.w + c * cell + x) * 4;
						const a = colour.data[i + 3] > 0;
						if (!a) {
							if (fill !== undefined && (fill.data[i + 3] > 0 || rim.data[i + 3] > 0)) maskMismatch++;
							continue;
						}
						any = true;
						if (x === 0 || y === 0 || x === cell - 1 || y === cell - 1) margin++;
						// every opaque texel is either the silhouette (Fill) or its outline (Rim), never both
						if (fill !== undefined && fill.data[i + 3] > 0 === rim.data[i + 3] > 0) maskMismatch++;
					}
				}
				if (!any) empty++;
			}
		}
		if (empty > 0) bad.push(`${name}: ${empty} empty cells`);
		if (margin > 0) bad.push(`${name}: ${margin} texels on a cell's border`);
		if (maskMismatch > 0) bad.push(`${name}: ${maskMismatch} texels where Fill + Rim != the cell`);
	}
	check(
		bad.length === 0,
		"every sheet is CHAR_DIRS x rows cells, within 1024 px, no empty cell, a clear margin, Fill + Rim = the cell",
		bad.slice(0, 4).join("; "),
	);

	// ---- 8b. the scripted cast (tools/character-cast.mjs): every outfit x grip x state, every zombie pose, every pet
	const cast = characterCast(require, SRC);
	const drawMember = castDrawer(require, SRC, shadowFn(false));
	const drawCast = (st, list) => list.forEach((m, i) => drawMember(st, m, (i % 12) * 110, Math.floor(i / 12) * 110));

	// ---- 8c. without ids the characters are drawn exactly as before (ART-01)
	setArt(TOWN_IDS);
	{
		const d = charDigest();
		const g = JSON.parse(readFileSync(GOLDEN_CHARS, "utf8"));
		check(
			d.count === g.count && d.sha1 === g.sha1,
			`no character id: the ${cast.length} survivors, zombies and pets make the same ${d.count} draw calls as ${g.recordedFrom.split(" ")[0]}`,
			`${d.sha1.slice(0, 10)} vs ${g.sha1.slice(0, 10)}, ${g.count} calls`,
		);
		check(d.images === 0, "and not one of them shows an image", `${d.images}`);
	}

	// ---- 8d. each group falls back on its own; with its sheets it is drawn from them
	const imagesOf = (ids, list) => {
		setArt(ids);
		const st = stage(1400, 1400, 1);
		st.cam.x = 600;
		st.cam.y = 600;
		st.r.beginFrame();
		drawCast(st, list);
		st.r.endFrame();
		const used = {};
		for (const f of st.r.layer.GetChildren()) {
			if (f.Visible === false) continue;
			const im = f.GetChildren().find(c => c.ClassName === "ImageLabel" && c.Visible !== false);
			if (im !== undefined) used[nameOf[im.Image] ?? im.Image] = (used[nameOf[im.Image] ?? im.Image] ?? 0) + 1;
		}
		return { used, counts: countSprites(st.r.layer) };
	};
	const only = names => ({ ...TOWN_IDS, ...Object.fromEntries(names.map(n => [n, ALL.ids[n]])) });
	const zombiesOnly = imagesOf(only(["zombies", "zombiesFill", "zombiesRim"]), cast);
	check(
		(zombiesOnly.used.zombies ?? 0) === cast.filter(m => m.kind === "zombie").length &&
			zombiesOnly.used.survivorsA === undefined &&
			zombiesOnly.used.dogs === undefined,
		"only the zombies uploaded: every zombie is its cell, survivors and pets stay flat",
		JSON.stringify(zombiesOnly.used),
	);
	const noWeapons = imagesOf(
		only(["survivorsA", "survivorsAFill", "survivorsARim", "survivorsB", "survivorsBFill", "survivorsBRim"]),
		cast,
	);
	check(
		noWeapons.used.survivorsA === undefined && noWeapons.used.survivorsB === undefined,
		"a survivor needs every one of its sheets: without the weapons it is drawn flat, never half art",
		JSON.stringify(noWeapons.used),
	);
	const all = imagesOf(ALL.ids, cast);
	const survivors = cast.filter(m => m.kind === "survivor");
	const standing = survivors.filter(m => !m.downed);
	const hit = standing.filter(m => (m.flash ?? 0) > 0).length;
	const poisoned = standing.filter(m => m.poisoned).length;
	const zombies = cast.filter(m => m.kind === "zombie");
	const flashing = zombies.filter(m => m.flash > 0 || m.blink).length;
	const want = {
		survivors: survivors.length + hit * 2 + poisoned,
		weapons: standing.length,
		zombies: zombies.length + flashing * 2,
		dogs: cast.filter(m => m.kind === "pet" && m.look >= 4).length,
		birds: cast.filter(m => m.kind === "pet" && m.look <= 3).length,
	};
	const got = {
		survivors: ["A", "B"].reduce(
			(n, s) =>
				n +
				(all.used[`survivors${s}`] ?? 0) +
				(all.used[`survivors${s}Fill`] ?? 0) +
				(all.used[`survivors${s}Rim`] ?? 0),
			0,
		),
		weapons: all.used.weapons ?? 0,
		zombies: (all.used.zombies ?? 0) + (all.used.zombiesFill ?? 0) + (all.used.zombiesRim ?? 0),
		dogs: all.used.dogs ?? 0,
		birds: all.used.birds ?? 0,
	};
	check(
		JSON.stringify(got) === JSON.stringify(want),
		"with every sheet: a survivor is its body cell + its weapon (+ the two masks on a hit, the veil when poisoned), a zombie one cell (+ two masks on a hit or a lit fuse), a pet one cell",
		JSON.stringify(got),
	);
	check(
		all.counts.strokes === 0,
		"and no character needs a UIStroke any more (the outline is in the texels)",
		`${all.counts.strokes}`,
	);

	// ---- 8e. the cost of a night: 60 zombies closing in on 4 survivors with their pets, 300 frames
	const horde = [];
	for (let i = 0; i < 60; i++) {
		horde.push({
			kind: "zombie",
			type: [1, 1, 1, 4, 2, 1, 3, 1, 5, 1][i % 10],
			big: i % 23 === 0,
			angle: 0,
			phase: i,
		});
	}
	const party = [0, 1, 2, 3].map(o => ({
		kind: "survivor",
		outfit: o,
		weapon: [2, 10, 6, 13][o],
		angle: o,
		phase: o,
		amp: 1,
	}));
	const pets = [4, 3, 5, 1].map((look, i) => ({
		kind: "pet",
		look,
		angle: i,
		moving: 1,
		phase: i,
		lift: look === 3 || look === 1 ? 1 : 0,
	}));
	function night(ids) {
		setArt(ids);
		const st = stage(1280, 800, 1);
		st.cam.x = 0;
		st.cam.y = 0;
		const frame = f => {
			st.r.beginFrame();
			horde.forEach((z, i) => {
				const a = (i / 60) * Math.PI * 2 + f * 0.002;
				const d = 520 - ((f * 0.9 + i * 7) % 380);
				z.angle = a + Math.PI + Math.sin(f * 0.05 + i) * 0.3;
				z.phase = f * 0.12 + i;
				z.flash = (f + i) % 45 < 4 ? 1 - ((f + i) % 45) / 4 : 0;
				drawMember(st, z, Math.cos(a) * d * 1.3, Math.sin(a) * d * 0.8);
			});
			party.forEach((s, i) => {
				s.angle = i * 1.6 + f * 0.03;
				s.phase = f * 0.2;
				s.swing = i === 0 && f % 30 < 12 ? -1 + ((f % 30) / 12) * 2 : undefined;
				s.flash = (f + i * 20) % 80 < 5 ? 0.8 : 0;
				drawMember(st, s, (i % 2 ? 50 : -50) + Math.sin(f * 0.01) * 20, i < 2 ? -40 : 40);
			});
			pets.forEach((p, i) => {
				p.angle = f * 0.03 + i;
				p.phase = f * 0.3;
				drawMember(st, p, i % 2 ? 110 : -110, i < 2 ? -80 : 80);
			});
			st.r.endFrame();
		};
		for (let f = 0; f < 120; f++) frame(f);
		const created0 = gui.stats.created;
		const writes0 = gui.stats.writes;
		const t0 = process.hrtime.bigint();
		const N = 300;
		for (let f = 120; f < 120 + N; f++) frame(f);
		const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
		const counts = countSprites(st.r.layer);
		return {
			created: gui.stats.created - created0,
			writes: (gui.stats.writes - writes0) / N,
			us,
			counts,
			pool:
				st.r.layer.GetChildren().length +
				st.r.layer.GetChildren().reduce((n, f) => n + f.GetChildren().length, 0),
		};
	}
	const flat = night(TOWN_IDS);
	const art = night(ALL.ids);
	for (const [label, m] of [
		["flat", flat],
		["art ", art],
	]) {
		console.log(
			`       ${label} ${String(m.counts.sprites).padStart(4)} sprites: ${String(m.counts.flat).padStart(3)} Frames + ${String(m.counts.images).padStart(3)} ImageLabels, ${String(m.counts.strokes).padStart(3)} strokes, ${String(m.counts.corners).padStart(3)} corners; ${m.pool} Instances in the pool; ${m.writes.toFixed(0)} property writes/frame; ${m.us.toFixed(0)} µs/frame (Node)`,
		);
	}
	check(
		flat.created === 0 && art.created === 0,
		"no Instance created after the warm-up, flat or art",
		`${flat.created}, ${art.created}`,
	);
	check(
		art.counts.sprites <= flat.counts.sprites * 0.6,
		"the art draws the horde with at most 60 % of the flat drawing's sprites",
		`${art.counts.sprites} vs ${flat.counts.sprites}`,
	);
	check(art.pool <= flat.pool, "and keeps no more Instances in the pool", `${art.pool} vs ${flat.pool}`);
	check(
		art.writes <= flat.writes,
		"and writes no more properties per frame",
		`${art.writes.toFixed(0)} vs ${flat.writes.toFixed(0)}`,
	);
}
setArt({});

console.log(failures === 0 ? "\nworld-art: all checks passed" : `\nworld-art: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
