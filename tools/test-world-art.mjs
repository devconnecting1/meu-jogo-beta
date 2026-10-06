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
 *      the rooftop emblems in downtown, school, gas and overview; the window glass (EDI-18) put the open frames'
 *      marks and shards on the windows born broken (with none born broken, every scene was the old golden's). A
 *      second digest per scene, with the signage hook stubbed out, still equals 8725b0b's with its emblem stubbed
 *      out: the signs are the only change. And not one
 *      sprite shows an image.
 *   2. WITH ART, THE SURFACES ARE TEXTURES. With a fake id for every texture: the ground, the roads, the roofs and
 *      the props draw as ImageLabels, pixelated, tiles at their texel size (4 units per texel), no flat asphalt /
 *      sidewalk / lawn rect is left under them, the asphalt is one world-anchored sheet under the lots.
 *      Each texture falls back ON ITS OWN: with only the lawn uploaded, only the lawn is textured.
 *   3. NO CHURN. After a warm-up, 600 frames of camera movement create no Instance, flat and with art, and the
 *      renderer's write cache still skips what did not change.
 *   4. THE COST, measured on a dense 1920 x 1080 downtown screen (the block whose screen draws the most sprites flat):
 *      sprites, ImageLabels, strokes, corners and the Node time of a frame, flat against art (printed; the art stays
 *      within 10 % of the flat town's sprites there, and over every downtown block's screen together).
 *   5. LEGIBILITY (LEG-03). A walker and the survivor on every kind of ground, rendered through the real code and
 *      rasterised: the strongest colour step across the silhouette (ΔE, CIELAB) must not drop with the textures,
 *      and a walker on grass must clear the bar the old outline missed (it measured 15; the lawn's own colour).
 *   6. THE PIPELINE. The manifest, the PNGs and worldArtAssets.ts agree; masks and roof tiles are greyscale (the
 *      roof keeps its type colour, EDI-03); each ground texture's mean colour stays within ΔE 6 of the flat colour
 *      it replaces (the art never repaints the palette); ids are "" or rbxassetid. The game's name (`wordmark`, kind
 *      "ui") is the store art's LAST TOWN in tools/title-font.mjs, greyscale, as its three cells (ink, LAST, TOWN).
 *   7. THE TOOLS RUN. tools/render-map.mjs renders a scene whose PNG decodes, with no missing texture (magenta);
 *      `npm run cloud -- upload-art --dry-run` lists every texture without reading any key.
 *   8. THE STOREFRONT SIGNS (EDI-03, ART-07, client/view/buildingSigns.ts). Every type that is not a house has its
 *      own sign (face colour and pictogram unlike any other); its texture is its grid texel for texel and the flat
 *      drawing's runs repaint the same grid; on every building of five towns it stands on the roof, on the entrance
 *      wall, beside the doorway and never over it, at most a fifth of the facade; it is upright and costs a bounded
 *      number of sprites (flat and art, every kind of wear); rasterised with the textures it reads against its roof
 *      and the ground in front by day and in the survivor's light at 22:00, and out of the light it is exactly as
 *      dark as its roof (no sign glows, LUZ-02); the textured roofs keep the type colours apart.
 *   9. THE NAMEPLATE OVER THE WORLD (UI-04 clarification). The plate has no background, so each of its voices (name,
 *      level, handle, every title) is measured with its pixel drop shadow against the real ground pixels of every
 *      ground a survivor stands on, by day and under the night tint: the letter against its own shadow at 4,5:1 even
 *      on pure white, and the letter or its shadow 30 ΔE off every ground pixel. `PZ_PLATE_RECORD=<file>` writes
 *      the per-ground table as JSON.
 *  10. THE CHARACTERS' ART (ART-08..ART-11). The sheets have the layout client/view/charSheets.ts reads, within
 *      1024 px, with a clear margin round every cell and Fill + Rim masks that are exactly each cell. With no
 *      character id every survivor, zombie and pet makes the draw calls it made before the art
 *      (tools/golden/characters-flat.json, recorded from f3c5564); each group falls back on its own; with the
 *      sheets a survivor is two sprites, a zombie and a pet one. The cost of a night -- 60 zombies, 4 survivors and
 *      their pets, 300 frames -- flat against art: sprites, Instances, property writes, time, and no churn.
 *  11. THE INTERIORS (EDI-04, ART-12). With every roof on, nothing of any interior is drawn; walking in and out of
 *      the largest building creates no Instance; its sprites inside and the writes of a walk across it (printed), the
 *      art costing at most 10 % more sprites than the flat drawing (the town's budget, §4). 11b, their pixel art: with
 *      no id, the first building of each type (the 15 of before and the everyday town's) seen from inside makes the
 *      flat interiors' very draw calls (tools/golden/interiors-flat.json, `--golden-interiors` with PZ_SRC on the
 *      commit before the art; re-recorded with the window glass, EDI-18, and with the everyday town, EDI-19..EDI-24);
 *      in 5 towns every piece of furniture is drawn
 *      from the atlas, exactly on its solid's rect (plus its baked shadow), in at most 4 sprites; every decoration and
 *      every doorway and window has its art; a chair faces its table. §5 measures the bodies on every room floor and
 *      every rug, §6 the floors' mean colours.
 *  12. THE GROUND ITEMS (ITM-07, client/view/groundItemsView.ts). An item of every kind on each of 18 grounds, flat and
 *      with the icons' atlas, rasterised: by day and in the survivor's light every icon steps 3:1 or 35 ΔE off its
 *      ground, and on every ground the weakest icon reads at least as well as the weakest flat look it replaces; out
 *      of every light no item steps more than 1.5:1 off its ground (nothing glows), and every sprite of the view is
 *      under the night. The pictures: node tools/render-ground-items.mjs --out <dir>.
 *  13. COMBAT BLOOD (ART-15, LEG-02, client/view/bloodView.ts). With no id a seeded 15 s fight's blood makes the
 *      draw calls of the GameLoop before the art (tools/golden/blood-flat.json, `--golden-blood` with PZ_SRC on that
 *      commit; the horde's colour hashed by name), and with the art it throws the same dice. The horde's blood is a
 *      darker, browner red than a survivor's, far from the acid and off every ground. The atlas: three bands (matte
 *      greyscale, the two wet ones in their own reds, no outline, no near-white fleck, their means the palette's); a
 *      smear's spatter runs along its hit in all 8 directions; every stain is one image on the texel grid, every
 *      droplet a square, all of them under the bodies and the items; a stain ages in 11 looks, always drier and
 *      fainter, darker where it soaks in (asphalt, grass, soil: checked against 4000 points of the town); droplets on
 *      one spot join, and a full ring keeps the newest; an item lying in blood (wet, drying, dry) still reads.
 *      The pictures: node tools/render-blood.mjs --out <dir> (docs/art/blood).
 *  14. THE WINDOW GLASS (EDI-18, client/view/interiorView.ts). On the building with the most windows of both states:
 *      from the street, glass is the dark strip it always was and an open frame the darker hole with two stubs of
 *      glass (70 ΔE apart) over three shards on the ground outside; inside, the pane with its streak of light or the
 *      sill tint and the glass on the floor; with the interiors' atlas, its cells: `windowGlass:<side>` for the pane,
 *      `window:<side>` for the empty frame and `glass:h|v` for the shards, outside and in. No
 *      sprite of the glass is over a body in the frame or an item; panes breaking in view create no Instance.
 *  15. THE ENTRANCES (ART-17, client/view/entrances.ts + entranceArt.ts). With no id of the entrances' atlas the art
 *      draws nothing and every doorway is flat, at most two Frames on the ground and one on the roof's edge, the kinds
 *      told apart; with it, in five towns every doorway has its stoop, frame and lintel; the stoop starts at the wall's
 *      outside face, the lintel lies inside the footprint (LEG-03), a single door draws one leaf and a double door at
 *      most its two (ESC-02), no leaf stands in the passage (the gap less 20 u at
 *      each jamb, 72 u in and 48 u out: EDI-09) nor on anything of the town, every leaf rests somewhere, a few house
 *      doors are torn off or were boarded up (APO-01), a doorway costs at most 4 / 1 / 3 sprites, and the four sides
 *      are four bakes (the light never turns with a door). §5 measures the bodies on every kind of doorstep.
 *  16. THE TREES (VEG-06, shared/data/trees.ts, tools/tree-art.mjs). One greyscale atlas: every kind in its looks, each
 *      a square of its kind's size, none over another and none a turned or mirrored copy of another; every crown
 *      lighter to the left and above, texel by texel (never turned after lighting); the trunk's cell is the 44 u
 *      collision box. Drawn: a tree is its cell at its size and never turned -- shadow, trunk, crown and light, 4
 *      sprites; a shrub 3, under the bodies and never see-through -- and without the atlas the flat tree. Every kind
 *      stands on the same trunk. §1 proves the flat drawing reads the new sizes and greens and nothing else changed
 *      (`noTrees`).
 *
 * Pure Node (>= 18) + the project's TypeScript on tools/luau-shim.mjs and the fake GUI tree of tools/fake-gui.mjs.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installShims, ROOT, setSeed } from "./luau-shim.mjs";
import { installFakeGui } from "./fake-gui.mjs";
import { countSprites, rasterise } from "./gui-raster.mjs";
import { decodePNG } from "./png-lite.mjs";
import { castDrawer, characterCast } from "./character-cast.mjs";
import { bossCast, bossDrawer } from "./boss-cast.mjs";
import { dilate, layoutText } from "./title-font.mjs";

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
const { generateTown, buildingAt, pointInSolid, hash01, removeSolid } = require(join(SRC, "shared/game/world.ts"));
const WV = require(join(SRC, "client/view/worldView.ts"));
const { WorldView } = WV;
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
/**
 * The same town without its downtown squares (MOB-07, shared/game/townSquares.ts). They are laid last, from their own
 * streams, and every solid and ground rect of theirs lies inside its square (the ground they were laid on was empty):
 * taken out newest first -- each cell of the grid gives back its tail -- they leave the very town they were laid in,
 * and a digest of it is the golden before them, call for call (`noSquares`). A checkout without squares: the town.
 */
function withoutSquares(w) {
	const squares = w.lots.flatMap(l => l.squares ?? []);
	const inSq = r => squares.some(q => r.x >= q.x && r.y >= q.y && r.x + r.w <= q.x + q.w && r.y + r.h <= q.y + q.h);
	const gone = w.solids
		.filter(s => s.kind !== "building" && s.parentId === undefined && inSq(s))
		.sort((a, b) => b.id - a.id);
	for (const s of gone) removeSolid(w, s);
	for (const l of w.lots) {
		if (l.squares === undefined) continue;
		l.ground = l.ground.filter(g => !inSq(g));
		delete l.squares;
	}
	return w;
}
const bareWorld = withoutSquares(generateTown(DESIGN.TOWN_SEED));

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

function drawTown(st, view, cx, cy, w = world) {
	st.cam.x = cx;
	st.cam.y = cy;
	const v = st.cam.viewRect(32);
	st.r.beginFrame();
	view.drawGround(st.r, st.cam, v, w);
	view.drawSolids(st.r, st.cam, v, w);
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

/**
 * The scenes are framed on what they are named for, found in the town (the fixed rects of before showed an empty yard,
 * a bare crossing and a house where the forecourt used to be once the everyday town moved the buildings round and the
 * mix got its quotas, EDI-19/EDI-20, 2026-09-24): a house of the street with its ridge along x and its front yard, a
 * shop's door at the sidewalk, a park's middle, the first school, a gas station's forecourt whose street is at the top
 * (its canopy is `gasCanopyN`), framed like render-map's `findGas`.
 */
const sceneOn = (name, x, y, night = false) => ({
	name,
	x: Math.round(x - 640),
	y: Math.round(y - 400),
	w: 1280,
	h: 800,
	zoom: 1,
	night,
});
const HOUSE = world.solids.find(
	s =>
		s.kind === "building" && s.buildingType === 1 && s.w > s.h && (s.doorSide === "top" || s.doorSide === "bottom"),
);
const SHOP = world.solids.find(
	s =>
		s.kind === "building" &&
		[6, 8, 9, 10].includes(s.buildingType) &&
		world.lots.some(l => l.zone === "commercial" && s.x >= l.x && s.x < l.x + l.w && s.y >= l.y && s.y < l.y + l.h),
);
const PARK = world.lots.find(l => l.kind === "park");
const SCHOOL = world.solids.find(s => s.kind === "building" && s.buildingType === 3);
const STREET_AT =
	HOUSE !== undefined
		? [HOUSE.x + HOUSE.w / 2, HOUSE.doorY + (HOUSE.doorSide === "top" ? -160 : 160)]
		: [17116, 12122];
const GAS_SCENE = (() => {
	const canopies = world.solids.filter(s => s.kind === "canopy" && s.tags === "canopy");
	const c = canopies.find(s => s.face === "top") ?? canopies[0];
	if (c === undefined) return sceneOn("gas", 1581, 9201);
	const b = world.solids
		.filter(s => s.kind === "building" && s.buildingType === 5)
		.sort((p, q) => Math.hypot(p.x - c.x, p.y - c.y) - Math.hypot(q.x - c.x, q.y - c.y))[0];
	const cx = b !== undefined ? (b.x + b.w / 2) * 0.35 + (c.x + c.w / 2) * 0.65 : c.x + c.w / 2;
	const cy = b !== undefined ? (b.y + b.h / 2) * 0.35 + (c.y + c.h / 2) * 0.65 : c.y + c.h / 2;
	return sceneOn("gas", cx, cy);
})();
const SCENES = [
	sceneOn("street", STREET_AT[0], STREET_AT[1]),
	SHOP !== undefined ? sceneOn("downtown", SHOP.doorX, SHOP.doorY) : sceneOn("downtown", 8404, 10254),
	PARK !== undefined ? sceneOn("park", PARK.x + PARK.w / 2, PARK.y + PARK.h / 2) : sceneOn("park", 3364, 15328),
	SCHOOL !== undefined
		? sceneOn("school", SCHOOL.x + SCHOOL.w / 2, SCHOOL.y + SCHOOL.h / 2)
		: sceneOn("school", 5085, 3142),
	GAS_SCENE,
	sceneOn("street-night", STREET_AT[0], STREET_AT[1], true),
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

/**
 * The trees' drawing (VEG-06: their kinds, sizes and greens, and the parks' groves) stubbed out: a digest says whether
 * everything BUT the trees is still the town of the golden. The same two method names before and after the trees'
 * kinds (72dd2dd), so a golden recorded with PZ_SRC on that commit reads the same way.
 */
function withoutTrees(view) {
	view.drawTree = () => {};
	view.drawTreeArt = () => true;
	return view;
}

function digestOf(scene, noSigns = false, noTrees = false, w = world) {
	const st = stage(Math.round(scene.w * scene.zoom), Math.round(scene.h * scene.zoom), scene.zoom);
	const cx = scene.x + scene.w / 2;
	const cy = scene.y + scene.h / 2;
	const view = new WorldView(shadowFn(scene.night, cx - 60, cy + 40));
	if (noSigns) view[SIGN_HOOK] = () => {};
	if (noTrees) withoutTrees(view);
	calls.length = 0;
	capturing = true;
	drawTown(st, view, cx, cy, w);
	// a short pan: clipping at the view's edges changes every frame
	for (let f = 1; f <= 12; f++) drawTown(st, view, cx + f * 37, cy + f * 11, w);
	capturing = false;
	const json = JSON.stringify(calls);
	return { count: calls.length, sha1: createHash("sha1").update(json).digest("hex"), layer: st.r.layer };
}

// the characters' draw calls with no character id (§10), and --golden-chars: record them from this src
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
// the bosses' draw calls with no boss sheet (§10f, ART-14), and --golden-bosses: record them from this src (run it
// on the commit before the bosses' art, with PZ_SRC, and PZ_GOLDEN_FROM naming it)
const GOLDEN_BOSSES = join(ROOT, "tools", "golden", "bosses-flat.json");
/** where member `i` of the boss cast is drawn (far apart: nothing of one lands on another) */
const bossAt = i => [(i % 6) * 400, Math.floor(i / 6) * 1600];
function bossDigest() {
	const cast = bossCast();
	const drawBoss = bossDrawer(require, SRC, shadowFn(false));
	const st = stage(1400, 1400, 1);
	st.cam.x = 600;
	st.cam.y = 600;
	calls.length = 0;
	capturing = true;
	st.r.beginFrame();
	cast.forEach((m, i) => drawBoss(st, m, ...bossAt(i)));
	st.r.endFrame();
	capturing = false;
	const sha1 = createHash("sha1").update(JSON.stringify(calls)).digest("hex");
	return { count: calls.length, sha1, images: countSprites(st.r.layer).images };
}
if (process.argv.includes("--golden-bosses")) {
	setArt({});
	const d = bossDigest();
	const out = {
		note: "draw-call digest of the flat bosses of tools/boss-cast.mjs (tools/test-world-art.mjs --golden-bosses)",
		recordedFrom: process.env.PZ_GOLDEN_FROM ?? "the src it was run on",
		count: d.count,
		sha1: d.sha1,
	};
	writeFileSync(GOLDEN_BOSSES, `${JSON.stringify(out, undefined, "\t")}\n`);
	console.log(`wrote ${GOLDEN_BOSSES} (${d.count} calls)`);
	process.exit(0);
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

/**
 * ART-01 inside (ART-12): the first building of each type with its roof off, the camera on it and a short pan, with
 * no world art -- the draw calls hashed. tools/golden/interiors-flat.json holds them as recorded from the flat
 * interiors of the commit before their pixel art (`--golden-interiors`, with PZ_SRC on that commit).
 */
const GOLDEN_INTERIORS = join(ROOT, "tools", "golden", "interiors-flat.json");
function interiorBuildings(w) {
	const out = [];
	// every type of the town: the 15 of before and the everyday town's (EDI-19..EDI-24: the bank and its vault too)
	let top = 15;
	for (const s of w.solids) if (s.kind === "building" && s.buildingType > top) top = s.buildingType;
	for (let t = 1; t <= top; t++) {
		const list = w.solids.filter(s => s.kind === "building" && s.buildingType === t && s.rooms !== undefined);
		list.sort((a, b) => a.id - b.id);
		if (list[0] !== undefined) out.push(list[0]);
	}
	return out;
}
/** building `b` as the town without its squares has it (the same id: the squares take none of the town's) */
const bareOf = b => bareWorld.solids.find(s => s.id === b.id) ?? b;
function interiorDigest(b0, noTrees = false, w = world) {
	const b = w === world ? b0 : bareOf(b0);
	const st = stage(1920, 1080, 1);
	const view = new WorldView(shadowFn(false));
	if (noTrees) withoutTrees(view);
	b.roofAlpha = 0;
	calls.length = 0;
	capturing = true;
	const cx = b.x + b.w / 2;
	const cy = b.y + b.h / 2;
	drawTown(st, view, cx, cy, w);
	for (let f = 1; f <= 6; f++) drawTown(st, view, cx + f * 29, cy + f * 13, w);
	capturing = false;
	b.roofAlpha = undefined;
	return { count: calls.length, sha1: createHash("sha1").update(JSON.stringify(calls)).digest("hex") };
}
if (process.argv.includes("--golden-interiors")) {
	setArt({});
	const scenes = {};
	for (const b of interiorBuildings(world)) {
		const d = interiorDigest(b);
		const t = interiorDigest(b, true, bareWorld);
		const q = interiorDigest(b, false, bareWorld);
		scenes[`type${b.buildingType}`] = {
			building: b.id,
			x: b.x,
			y: b.y,
			count: d.count,
			sha1: d.sha1,
			noTrees: { count: t.count, sha1: t.sha1 },
			noSquares: { count: q.count, sha1: q.sha1 },
		};
	}
	const out = {
		note: "draw-call digests of each building type's first building seen from inside with no world art (tools/test-world-art.mjs --golden-interiors); noTrees: the same with the trees' drawing stubbed out (the town round the building, VEG-06), in the town without its downtown squares; noSquares: the town without its downtown squares (MOB-07), drawn whole",
		recordedFrom: process.env.PZ_GOLDEN_FROM ?? "the src it was run on",
		scenes,
	};
	mkdirSync(join(ROOT, "tools", "golden"), { recursive: true });
	writeFileSync(GOLDEN_INTERIORS, `${JSON.stringify(out, undefined, "\t")}\n`);
	console.log(`wrote ${GOLDEN_INTERIORS}`);
	process.exit(0);
}

/**
 * ART-15, combat blood: a seeded 15 s fight's sprays, kills, bites and debris through the REAL ParticleSystem, drawn
 * every frame by `draw` while the camera drifts, the draw calls hashed. tools/golden/blood-flat.json holds them as the
 * GameLoop of the commit before the blood's pixel art drew them (`--golden-blood`, with PZ_SRC on that commit: its
 * drawDecals / drawParticles are `legacyBloodDraw` below, line for line). The horde's colour is hashed by name, not by
 * value: LEG-02 moved it from green to a dark red with the art, and the digest proves every other thing is the same.
 */
const GOLDEN_BLOOD = join(ROOT, "tools", "golden", "blood-flat.json");
const { ParticleSystem } = require(join(SRC, "client/systems/particles.ts"));
const { circleInView } = require(join(SRC, "client/view/drawKit.ts"));
const BLOOD_AT = { x: 8400, y: 10250 };
/** the flat blood exactly as GameLoop drew it before ART-15 (its DECAL_O / PARTICLE_O and the two loops) */
function legacyBloodDraw(r, cam, v, ps) {
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
/**
 * The fight: a 3-drop shot every 40 frames (with its direction), a heavy 12-drop hit every 30 (the decal ring fills and
 * wraps), a kill every 130, a bite every 170, a tree's chips every 210, the low tier from frame 450. `setup(ps)` runs
 * once before it (the art turns ps.pixelArt on), `each(ps, f)` after every step. Answers the digest of the draw calls.
 */
function bloodScenario(draw, setup, each) {
	setSeed(4242);
	const ps = new ParticleSystem();
	if (setup !== undefined) setup(ps);
	const st = stage(1280, 720, 1);
	const at = BLOOD_AT;
	calls.length = 0;
	for (let f = 0; f < 900; f++) {
		if (f % 40 === 0)
			ps.bloodBurst(at.x + ((f * 37) % 500) - 250, at.y + ((f * 53) % 300) - 150, 3, "zombie", (f * 0.7) % 6.28);
		if (f % 30 === 5) ps.bloodBurst(at.x + ((f * 61) % 700) - 350, at.y + ((f * 23) % 400) - 200, 12, "zombie", f);
		if (f % 130 === 10) ps.bloodBurst(at.x + ((f * 29) % 400) - 200, at.y + ((f * 17) % 260) - 130, 10, "zombie");
		if (f % 170 === 25) ps.bloodBurst(at.x - 40 + (f % 80), at.y + 20, 4, "player");
		if (f % 210 === 40) ps.debrisBurst(at.x + 100, at.y - 60, 5, COLORS.treeTrunk);
		if (f === 450) ps.lowDetail = true;
		ps.update(1 / 60);
		if (each !== undefined) each(ps, f);
		st.cam.x = at.x + f * 0.4;
		st.cam.y = at.y + Math.sin(f / 50) * 30;
		const v = st.cam.viewRect(32);
		st.r.beginFrame();
		capturing = true;
		draw(st.r, st.cam, v, ps);
		capturing = false;
		st.r.endFrame();
	}
	const red = JSON.stringify(rgb(COLORS.blood));
	const horde = JSON.stringify(rgb(COLORS.bloodHorde ?? COLORS.bloodZombie));
	const named = calls.map(c => {
		const k = JSON.stringify(c[5]);
		return [...c.slice(0, 5), k === red ? "blood" : k === horde ? "horde" : c[5], ...c.slice(6)];
	});
	calls.length = 0;
	return { count: named.length, sha1: createHash("sha1").update(JSON.stringify(named)).digest("hex"), ps, st };
}
if (process.argv.includes("--golden-blood")) {
	setArt({});
	const d = bloodScenario(legacyBloodDraw);
	const out = {
		note: "draw-call digest of the flat combat blood of a seeded fight (tools/test-world-art.mjs --golden-blood, legacyBloodDraw); the horde's colour by name",
		recordedFrom: process.env.PZ_GOLDEN_FROM ?? "the src it was run on",
		count: d.count,
		sha1: d.sha1,
	};
	mkdirSync(join(ROOT, "tools", "golden"), { recursive: true });
	writeFileSync(GOLDEN_BLOOD, `${JSON.stringify(out, undefined, "\t")}\n`);
	console.log(`wrote ${GOLDEN_BLOOD} (${d.count} calls)`);
	process.exit(0);
}

section("1) no asset id: the town is drawn exactly as the golden flat town");
setArt({});
const flatDigests = {};
const bareDigests = {};
const treelessDigests = {};
const squarelessDigests = {};
for (const sc of SCENES) {
	flatDigests[sc.name] = digestOf(sc);
	// the signs' and the trees' proofs keep proving what they proved: on the town the squares were laid in (MOB-07)
	bareDigests[sc.name] = digestOf(sc, true, false, bareWorld);
	treelessDigests[sc.name] = digestOf(sc, false, true, bareWorld);
	squarelessDigests[sc.name] = digestOf(sc, false, false, bareWorld);
}
if (GOLDEN_MODE) {
	mkdirSync(join(ROOT, "tools", "golden"), { recursive: true });
	const out = {
		note: "draw-call digests of WorldView.drawGround + drawSolids with no world art (tools/test-world-art.mjs --golden); noSigns: the same with the building-signage hook stubbed out; noTrees: the same with the trees' drawing stubbed out (VEG-06); both in the town without its downtown squares, and noSquares: that town drawn whole (MOB-07)",
		recordedFrom: process.env.PZ_GOLDEN_FROM ?? "the src it was run on",
		scenes: Object.fromEntries(
			SCENES.map(sc => {
				const d = flatDigests[sc.name];
				const b = bareDigests[sc.name];
				const t = treelessDigests[sc.name];
				const q = squarelessDigests[sc.name];
				return [
					sc.name,
					{
						count: d.count,
						sha1: d.sha1,
						noSigns: { count: b.count, sha1: b.sha1 },
						noTrees: { count: t.count, sha1: t.sha1 },
						noSquares: { count: q.count, sha1: q.sha1 },
					},
				];
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
	// VEG-06 (the trees' kinds, sizes and greens, a park's groves) changed the trees and nothing else: without the
	// trees' drawing, every scene is the town the golden before them drew (72dd2dd, recorded with the kinds)
	const off = SCENES.filter(sc => {
		const t = treelessDigests[sc.name];
		const g = golden[sc.name]?.noTrees;
		return g === undefined || t.count !== g.count || t.sha1 !== g.sha1;
	});
	check(
		off.length === 0,
		"and without the trees every scene is the same town (VEG-06 changed only the trees)",
		off.map(sc => sc.name).join(", "),
	);
}
{
	// MOB-07 (the downtown squares) added the squares and nothing else: the town without them is, scene by scene, the
	// golden before them call for call (recorded as noSquares with the squares, compared with the golden before)
	const off = SCENES.filter(sc => {
		const q = squarelessDigests[sc.name];
		const g = golden[sc.name]?.noSquares;
		return g === undefined || q.count !== g.count || q.sha1 !== g.sha1;
	});
	check(
		off.length === 0,
		"and without the downtown squares every scene is the same town (MOB-07 added only the squares)",
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
	// the crowns drawn, by their cell of the trees' atlas (VEG-06; a plain object: the shims make Set.size a method)
	const crownCells = {};
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
			if (name === "trees" && (f.ZIndex === Z.canopy || f.ZIndex === Z.structure)) {
				crownCells[`${label.ImageRectOffset.X},${label.ImageRectOffset.Y}`] = true;
			}
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
		"dispenser",
		"gasCanopy",
		"manhole",
		"dirt",
		"apron",
	];
	// a gas canopy of whichever street side the town put a station on (gasCanopyN, S, W or E)
	const missing = want.filter(n =>
		n === "gasCanopy" ? !["N", "S", "W", "E"].some(d => counts[`gasCanopy${d}`] > 0) : !(counts[n] > 0),
	);
	check(
		missing.length === 0,
		"ground, kerbs, paint, roofs, rims, soft shadows, bins, pumps, manholes all drawn",
		missing.join(", "),
	);
	// a gas station's canopy roof (EDI-16) is one sprite of its street side's texture, texel for texel: every canopy of
	// the town is exactly its texture at 4 units a texel (the generator's 113 x 29 is world.ts's 452 x 116)
	{
		const side = { top: "gasCanopyN", bottom: "gasCanopyS", left: "gasCanopyW", right: "gasCanopyE" };
		// the gas stations' (tags "canopy"): a market tent, a bus shelter and the bank's portico are canopies of their own
		const gasCanopy = s => s.kind === "canopy" && s.tags === "canopy";
		const bad = world.solids.filter(gasCanopy).filter(s => {
			const t = texOf[side[s.face]];
			return t === undefined || t.w * 4 !== s.w || t.h * 4 !== s.h;
		});
		const n = world.solids.filter(gasCanopy).length;
		check(
			n > 0 && bad.length === 0,
			"every gas station canopy is its street side's roof texture at 4 units a texel",
			`${n - bad.length}/${n}${bad.length > 0 ? `; #${bad[0].id} ${bad[0].w}x${bad[0].h} ${bad[0].face}` : ""}`,
		);
	}
	// the styles are counted on the overview too: the six close scenes are framed on a house, a shop, a park, a school
	// and a forecourt, and hold a handful of cars between them (a hash picks each car's style)
	const styles = { ...counts };
	{
		const d = digestOf(SCENES.find(sc => sc.name === "overview"));
		for (const f of d.layer.GetChildren()) {
			const label = f.GetChildren().find(k => k.ClassName === "ImageLabel");
			if (f.Visible === false || label === undefined || label.Visible === false || label.Image === "") continue;
			const name = nameOf[label.Image];
			styles[name] = (styles[name] ?? 0) + 1;
		}
	}
	const cars = Object.keys(styles).filter(n => /^car\d$/.test(n)).length;
	check(cars >= 3, "cars come in several body styles", `${cars} styles on screen`);
	// every crown on screen is a cell of the trees' atlas: the six scenes show many different drawings (VEG-06), less
	// the trunk's cell
	const crowns = Object.keys(crownCells).length - 1;
	check(crowns >= 12, "tree crowns come in many shapes (VEG-06)", `${crowns} different crowns on screen`);
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
/**
 * The screens: the middle of every downtown block. The dense one is the block whose screen draws the most sprites flat
 * (the fixed point of before, 8400 x 10250, framed one market's big roof and no sign once the everyday town moved the
 * buildings round, EDI-19/EDI-20, 2026-09-24); the budget holds there, and over every block's screen together.
 */
const blockScreens = world.lots.filter(l => l.zone === "commercial").map(l => ({ x: l.x + l.w / 2, y: l.y + l.h / 2 }));
function spritesAt(ids, at) {
	setArt(ids);
	const st = stage(1920, 1080, 1);
	drawTown(st, new WorldView(shadowFn(false)), at.x, at.y);
	return countSprites(st.r.layer).sprites;
}
let DENSE = { x: 8400, y: 10250 };
const blocks = { flat: 0, art: 0, worst: 0, where: "" };
{
	let most = -1;
	for (const at of blockScreens) {
		const f = spritesAt({}, at);
		const a = spritesAt(ALL.ids, at);
		blocks.flat += f;
		blocks.art += a;
		if (f > most) {
			most = f;
			DENSE = at;
		}
		if (a / f > blocks.worst) {
			blocks.worst = a / f;
			blocks.where = `${Math.round(at.x)} x ${Math.round(at.y)}: ${a} vs ${f}`;
		}
	}
}
console.log(`       the densest downtown screen: the block round ${Math.round(DENSE.x)} x ${Math.round(DENSE.y)}`);
const perf = {};
for (const [label, ids] of [
	["flat", {}],
	["art", ALL.ids],
]) {
	setArt(ids);
	const st = stage(1920, 1080, 1);
	const view = new WorldView(shadowFn(false));
	const at = DENSE;
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
check(
	blockScreens.length > 0 && blocks.art <= blocks.flat * 1.1,
	`and so it does over every downtown block's screen together (${blockScreens.length})`,
	`${blocks.art} vs ${blocks.flat}; the most, ${((blocks.worst - 1) * 100).toFixed(0)} %, at ${blocks.where}`,
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
/** a gas station's canopies (EDI-16): aerial, so no solid -- but a ground under one is measured under it (below) */
const CANOPIES = world.solids.filter(s => s.kind === "canopy");
function surfaceAt(x, y) {
	if (buildingAt(world, x, y) !== undefined) return "building";
	for (const c of CANOPIES) if (inRect(c, x, y)) return "canopy";
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
 * the owner's Studio shows today) and "chars" (the town and the characters' pixel art, ART-08).
 */
const CHAR_SHEETS = new Set(
	ALL.manifest.textures
		.filter(t => t.kind === "sheet" || /^(survivors[A-Z]|zombies|boss[A-Z][a-z]+)(Fill|Rim)$/.test(t.name))
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
 * enough for the flat drawing's 2-px rims; with the characters' pixel art (ART-08) the outline is a whole texel,
 * and a near-black texel on dark asphalt is only half of what separates a body from the road -- the other half is
 * the jacket's blue a texel further in. Both drawings are measured with the same window.
 */
const REACH = 5;
/**
 * Silhouette contrast: for every ground pixel touching the body, the strongest colour step (ΔE) to a body pixel
 * within REACH px -- a dark rim, a bright body or both. Averaged along the whole outline.
 */
function silhouette(ground, withBody) {
	// square shots: S x S for a walker and the survivor, bigger for a boss (§10f)
	const S = ground.w;
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
	// the characters' pixel art (ART-08): a near-black outline a texel wide round every body, on every ground
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
{
	// MOB-07: on a downtown square's floor -- its mosaic in each look the town laid, a cafe's deck, a pocket park's bed
	// -- a walker and the survivor clear the open ground's bars (the mosaic's stones sit a step either side of the paving)
	const seen = new Set();
	for (const lot of world.lots) {
		for (const g of lot.ground) {
			if (!["medallion", "terrace", "bed"].includes(g.kind)) continue;
			const key =
				g.kind === "medallion" ? `mosaic look ${g.variant ?? 0}` : g.kind === "terrace" ? "cafe deck" : "bed";
			if (seen.has(key)) continue;
			// a spot on it a body's width clear of anything standing (on the mosaic's disc, not its rect's corners)
			let p;
			const mx = g.x + g.w / 2;
			const my = g.y + g.h / 2;
			for (let y = g.y + 40; y < g.y + g.h - 40 && p === undefined; y += 8) {
				for (let x = g.x + 40; x < g.x + g.w - 40 && p === undefined; x += 8) {
					if (g.kind === "medallion" && Math.hypot(x - mx, y - my) > g.w / 2 - 28) continue;
					if (pointInSolid(world, x, y, 44) === undefined) p = { x, y };
				}
			}
			if (p === undefined) continue;
			seen.add(key);
			const res = {};
			for (const actor of ["zombie", "survivor"]) {
				for (const look of ["flat", "town", "chars"]) {
					const base = shot(p, actor === "zombie" ? "zombieShadow" : "none", look);
					res[`${actor}.${look}`] = silhouette(base, shot(p, actor, look));
				}
			}
			const f = (actor, look) => res[`${actor}.${look}`].toFixed(1);
			check(
				res["zombie.town"] >= 25 &&
					res["survivor.town"] >= 30 &&
					res["zombie.chars"] >= 40 &&
					res["survivor.chars"] >= 35,
				`on a square's ${key.padEnd(13)} (MOB-07): both clear the open ground's bars`,
				`walker ${f("zombie", "flat")} -> ${f("zombie", "town")} -> art ${f("zombie", "chars")}, survivor ${f("survivor", "flat")} -> ${f("survivor", "town")} -> art ${f("survivor", "chars")} ΔE`,
			);
		}
	}
	check(
		seen.has("cafe deck") && seen.has("bed") && [...seen].filter(k => k.startsWith("mosaic")).length >= 1,
		// a town lays the medallions it has room for (one is enough); every look present is measured above
		"a square's mosaic (the looks the town laid), a cafe's deck and a bed were measured",
		[...seen].join(", "),
	);
}
{
	// EDI-16: under a gas station's canopy -- see-through while a body is under it, the tree crown's fade opened
	// further (WorldView.SHELTER_SEE_THROUGH, eased by gameLoop.updateCanopy) -- a walker and the survivor clear the same
	// bars as on open ground: in a lane beside an island, with the canopy at its see-through opacity over them
	const canopy = CANOPIES[0];
	const see = WV.SHELTER_SEE_THROUGH;
	if (canopy === undefined || see === undefined) {
		check(false, "a gas station's canopy in the town, and the see-through opacity it fades to");
	} else {
		const island = world.solids.find(s => s.tags === "pump" && inRect(canopy, s.x + s.w / 2, s.y + s.h / 2));
		const n = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }[island.face];
		// the lane on the shop's side of the island: 60 u off its middle, away from the street
		const p = { x: island.x + island.w / 2 - n[0] * 60, y: island.y + island.h / 2 - n[1] * 60 };
		const res = {};
		canopy.canopyAlpha = see;
		for (const actor of ["zombie", "survivor"]) {
			for (const look of ["flat", "town", "chars"]) {
				const base = shot(p, actor === "zombie" ? "zombieShadow" : "none", look);
				res[`${actor}.${look}`] = silhouette(base, shot(p, actor, look));
			}
		}
		canopy.canopyAlpha = 1;
		const f = (actor, look) => res[`${actor}.${look}`].toFixed(1);
		check(
			res["zombie.town"] >= 25 && res["survivor.town"] >= 30,
			"under the see-through canopy of a gas station, a walker and the survivor clear the open-ground bars",
			`walker ${f("zombie", "flat")} -> ${f("zombie", "town")} -> art ${f("zombie", "chars")}, survivor ${f("survivor", "flat")} -> ${f("survivor", "town")} -> art ${f("survivor", "chars")} ΔE, canopy at ${see}`,
		);
		check(
			res["zombie.chars"] >= 40 && res["survivor.chars"] >= 35,
			"and with the characters' art too",
			`walker ${f("zombie", "chars")}, survivor ${f("survivor", "chars")} ΔE`,
		);
	}
}
{
	// ART-17: on the doorstep of every kind of entrance -- a coir mat, a rubber mat, a ramp's warning strip, a school's
	// steps, a bay's hazard paint --, with the roof on, a walker and the survivor clear the open ground's bars
	const EN_MODULE = join(SRC, "client/view/entrances.ts");
	if (existsSync(EN_MODULE)) {
		const EN = require(EN_MODULE);
		const seen = new Set();
		for (const b of world.solids) {
			if (b.kind !== "building") continue;
			for (const o of b.openings ?? []) {
				if (o.kind !== "door") continue;
				const style = EN.entranceStyle(b.buildingType, o.main);
				if (seen.has(style.stoop)) continue;
				const nx = o.side === "left" ? -1 : o.side === "right" ? 1 : 0;
				const ny = o.side === "top" ? -1 : o.side === "bottom" ? 1 : 0;
				// on the stoop, a body's radius off the wall's face, in the middle of the doorway
				const p = { x: o.x + o.w / 2 + nx * (o.w / 2 + 20), y: o.y + o.h / 2 + ny * (o.h / 2 + 20) };
				if (nx === 0) p.y = ny > 0 ? o.y + o.h + 20 : o.y - 20;
				else p.x = nx > 0 ? o.x + o.w + 20 : o.x - 20;
				if (pointInSolid(world, p.x, p.y, 17) !== undefined) continue;
				seen.add(style.stoop);
				const res = {};
				for (const actor of ["zombie", "survivor"]) {
					for (const look of ["flat", "town", "chars"]) {
						const base = shot(p, actor === "zombie" ? "zombieShadow" : "none", look);
						res[`${actor}.${look}`] = silhouette(base, shot(p, actor, look));
					}
				}
				const f = (actor, look) => res[`${actor}.${look}`].toFixed(1);
				check(
					res["zombie.town"] >= 25 &&
						res["survivor.town"] >= 30 &&
						res["zombie.chars"] >= 40 &&
						res["survivor.chars"] >= 35,
					`on a ${style.stoop.padEnd(11)} doorstep (${style.name}): both clear the open ground's bars`,
					`walker ${f("zombie", "flat")} -> ${f("zombie", "town")} -> art ${f("zombie", "chars")}, survivor ${f("survivor", "flat")} -> ${f("survivor", "town")} -> art ${f("survivor", "chars")} ΔE`,
				);
			}
		}
		check(
			[...seen].length >= 9,
			"a doorstep of every kind of entrance in the town was measured",
			`${[...seen].join(", ")}`,
		);
	}
}
{
	// ART-12: inside, the roof off, on every kind of room floor and on a rug -- the floors' textures, the shadow at
	// the walls' foot and the furniture around keep both silhouettes, and the bars of the open ground hold
	const buildings = world.solids
		.filter(s => s.kind === "building" && s.rooms !== undefined)
		.sort((a, b) => a.id - b.id);
	const clear = (b, x, y, rugOk) => {
		if (pointInSolid(world, x, y, 70) !== undefined) return false;
		for (const d of b.decor ?? []) {
			if (rugOk && d.kind === "rug") continue;
			if (x > d.x - 60 && x < d.x + d.w + 60 && y > d.y - 60 && y < d.y + d.h + 60) return false;
		}
		return true;
	};
	// which of the rugs' colours a rug is (client/view/interiorArt.ts: by where it lies)
	const FA = join(SRC, "client/view/furnitureAtlas.ts");
	const RUGS = existsSync(FA) ? (require(FA).RUG_COLOURS ?? 1) : 1;
	const rugColour = d => Math.floor(hash01(d.x, d.y, 37) * RUGS) % RUGS;
	/** a point of `floor` (or on a rug of colour n: "rug<n>") with free floor round it, and its building */
	const roomSpot = floor => {
		for (const b of buildings) {
			if (floor.startsWith("rug")) {
				for (const d of b.decor ?? []) {
					if (d.kind !== "rug" || d.w < 110 || d.h < 60 || `rug${rugColour(d)}` !== floor) continue;
					const x = Math.round(d.x + d.w / 2);
					const y = Math.round(d.y + d.h / 2);
					if (clear(b, x, y, true)) return { b, x, y };
				}
				continue;
			}
			for (const q of b.rooms) {
				if (q.floor !== floor || q.w < 220 || q.h < 220) continue;
				for (let y = q.y + 90; y < q.y + q.h - 90; y += 24) {
					for (let x = q.x + 90; x < q.x + q.w - 90; x += 24) if (clear(b, x, y, false)) return { b, x, y };
				}
			}
		}
		return undefined;
	};
	const worst = { zt: Infinity, st: Infinity, zc: Infinity, sc: Infinity };
	const floors = ["wood", "carpet", "kitchen", "bath", "tile", "shop", "concrete"];
	for (let n = 0; n < RUGS; n++) floors.push(`rug${n}`);
	for (const floor of floors) {
		const spot = roomSpot(floor);
		if (spot === undefined) {
			check(false, `a free spot of ${floor} floor inside a building`);
			continue;
		}
		spot.b.roofAlpha = 0;
		const res = {};
		for (const actor of ["zombie", "survivor"]) {
			for (const look of ["flat", "town", "chars"]) {
				const base = shot(spot, actor === "zombie" ? "zombieShadow" : "none", look);
				res[`${actor}.${look}`] = silhouette(base, shot(spot, actor, look));
			}
		}
		spot.b.roofAlpha = undefined;
		const f = (actor, look) => res[`${actor}.${look}`].toFixed(1);
		worst.zt = Math.min(worst.zt, res["zombie.town"]);
		worst.st = Math.min(worst.st, res["survivor.town"]);
		worst.zc = Math.min(worst.zc, res["zombie.chars"]);
		worst.sc = Math.min(worst.sc, res["survivor.chars"]);
		// a floor's texture keeps what its flat colour gave; a rug is a colour of its own with the art (the flat one is
		// always the red), so each rug colour is held to the open ground's bars instead
		const rug = floor.startsWith("rug");
		check(
			rug
				? res["zombie.town"] >= 25 &&
						res["survivor.town"] >= 30 &&
						res["zombie.chars"] >= 40 &&
						res["survivor.chars"] >= 35
				: res["zombie.town"] >= res["zombie.flat"] * 0.9 && res["survivor.town"] >= res["survivor.flat"] * 0.9,
			`inside, ${floor.padEnd(8)}: ${rug ? "a rug of this colour clears the open ground's bars" : "the interiors' art keeps both silhouettes"}`,
			`walker ${f("zombie", "flat")} -> ${f("zombie", "town")} -> art ${f("zombie", "chars")}, survivor ${f("survivor", "flat")} -> ${f("survivor", "town")} -> art ${f("survivor", "chars")} ΔE`,
		);
	}
	check(
		worst.zt >= 25 && worst.st >= 30,
		"inside, on the worst floor, a walker and the survivor clear the open ground's bars",
		`walker ${worst.zt.toFixed(1)}, survivor ${worst.st.toFixed(1)} ΔE`,
	);
	check(
		worst.zc >= 40 && worst.sc >= 35,
		"and with the characters' art too",
		`walker ${worst.zc.toFixed(1)}, survivor ${worst.sc.toFixed(1)} ΔE`,
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
			if (t.kind === "mask" || t.kind === "tileTint" || t.kind === "ui") {
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
		"masks, roof tiles and the wordmark are greyscale: the tint keeps the type colour (EDI-03) / the theme's (UI-01)",
		notGrey.join(", "),
	);
	// the game's name (client/ui/logo.ts): the store art's wordmark -- tools/title-font.mjs, LAST TOWN, the one-pixel
	// outline and the hard shadow one pixel down and right -- as three stacked cells: the ink, LAST's fill, TOWN's fill
	{
		const wm = decoded.wordmark;
		const m = layoutText("LAST TOWN");
		const ring = dilate(m, 1);
		const lastW = layoutText("LAST").w;
		const cw = ring.w + 1;
		const ch = ring.h + 1;
		const alphaAt = (x, y) => wm.data[(y * wm.w + x) * 4 + 3];
		const bad = [];
		if (wm === undefined || wm.w !== cw || wm.h !== ch * 3) bad.push(`size ${wm?.w} x ${wm?.h}`);
		else {
			const inRing = (x, y) => x >= 0 && y >= 0 && x < ring.w && y < ring.h && ring.bits[y * ring.w + x] === 1;
			const letter = (x, y) => x >= 0 && y >= 0 && x < m.w && y < m.h && m.bits[y * m.w + x] === 1;
			for (let y = 0; y < ch; y++) {
				for (let x = 0; x < cw; x++) {
					const ink = inRing(x, y) || inRing(x - 1, y - 1);
					if (ink !== alphaAt(x, y) > 0) bad.push(`ink ${x},${y}`);
					if (inRing(x, y) && alphaAt(x, y) !== 255) bad.push(`outline ${x},${y} not opaque`);
					const l = letter(x - 1, y - 1);
					if ((l && x - 1 < lastW) !== alphaAt(x, ch + y) > 0) bad.push(`LAST ${x},${y}`);
					if ((l && x - 1 >= lastW) !== alphaAt(x, ch * 2 + y) > 0) bad.push(`TOWN ${x},${y}`);
				}
			}
		}
		check(
			bad.length === 0,
			"wordmark.png: LAST TOWN in the store art's pixel font (outline + hard shadow), ink / LAST / TOWN in three cells",
			bad.slice(0, 4).join(", ") || `${cw} x ${ch} x 3`,
		);
		const wmTex = manifest.textures.find(t => t.name === "wordmark");
		check(
			wmTex?.kind === "ui" && /client\/ui\/logo\.ts/.test(wmTex.description),
			'in the manifest as kind "ui" (uploaded with the town by CI, drawn by client/ui/logo.ts)',
		);
	}
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
		// the interiors' rooms (shared/game/interiors.ts): tiles, carpet, kitchen checker, bathroom tiles
		["floorTile", c255(COLORS.floorTile)],
		["floorCarpet", c255(COLORS.floorCarpet)],
		["floorKitchen", c255(COLORS.floorKitchen)],
		["floorBath", c255(COLORS.floorBath)],
	];
	for (const [name, flat] of pairs) {
		const m = mean(decoded[name]);
		const a = lab(...m);
		const b = lab(...flat);
		const dE = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
		check(dE <= 6, `${name.padEnd(10)} keeps the flat colour it replaces`, `mean ΔE ${dE.toFixed(1)}`);
	}
	// a back room's floor is the concrete texture tinted (ImageColor3 multiplies) to the flat floorConcrete
	const tint = WV.CONCRETE_FLOOR_TINT;
	if (tint !== undefined) {
		const m = mean(decoded.concrete).map((v, i) => v * [tint.R, tint.G, tint.B][i]);
		const a = lab(...m);
		const b = lab(...c255(COLORS.floorConcrete));
		const dE = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
		check(dE <= 6, "concrete tinted for a back room keeps floorConcrete", `mean ΔE ${dE.toFixed(1)}`);
	}
	// the rain's puddles (LUZ-05, client/view/weatherView.ts): pixel art in four tones, the vertical road's texture the
	// same picture mirrored on its diagonal, and every drop's ring on the water
	const WTV = require(join(SRC, "client/view/weatherView.ts"));
	if (WTV.PUDDLE_ART !== undefined && decoded.puddle0 !== undefined) {
		const px = (img, x, y) => [...img.data.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 4)];
		const onWater = (img, x, y) => x >= 0 && y >= 0 && x < img.w && y < img.h && px(img, x, y)[3] > 200;
		const bad = [];
		WTV.PUDDLE_ART.forEach((name, v) => {
			const h = decoded[name];
			const vt = decoded[WTV.PUDDLE_ART_V[v]];
			// the tones: every opaque colour the texture uses, and the halo (the one translucent tone)
			const tones = new Set();
			const halo = new Set();
			for (let y = 0; y < h.h; y++) {
				for (let x = 0; x < h.w; x++) {
					const [r, g, b, a] = px(h, x, y);
					if (a === 0) continue;
					(a > 200 ? tones : halo).add(`${r},${g},${b}`);
					const t = px(vt, y, x);
					if (t.join() !== [r, g, b, a].join()) bad.push(`${name}V is not ${name} mirrored at ${x},${y}`);
				}
			}
			if (vt.w !== h.h || vt.h !== h.w) bad.push(`${name}V size`);
			// (a Set's size is a method under the Luau shims: count its entries)
			const nTones = [...tones].length;
			const nHalo = [...halo].length;
			if (nTones !== 3 || nHalo !== 1) bad.push(`${name}: ${nTones} water tones, ${nHalo} halo`);
			// the lit rim on the light side: the first water texel of every column from the top is the lightest tone
			let lit = 0;
			let cols = 0;
			for (let x = 0; x < h.w; x++) {
				for (let y = 0; y < h.h; y++) {
					if (!onWater(h, x, y)) continue;
					cols++;
					const [r, g, b] = px(h, x, y);
					if (r + g + b >= Math.max(...[...tones].map(t => t.split(",").reduce((a, c) => a + Number(c), 0))))
						lit++;
					break;
				}
			}
			if (lit < cols * 0.6) bad.push(`${name}: the top shore is lit in ${lit} of ${cols} columns`);
			for (const [sx, sy] of WTV.PUDDLE_DROPS[v]) {
				// the ring (3 x 3) and the texels beside it on the water, in both textures
				for (const [dx, dy] of [
					[0, 0],
					[-1, 0],
					[1, 0],
					[0, -1],
					[0, 1],
					[-2, 0],
					[2, 0],
					[0, -2],
					[0, 2],
				]) {
					if (!onWater(h, sx + dx, sy + dy)) bad.push(`${name}: drop ${sx},${sy} off the water`);
					if (!onWater(vt, sy + dy, sx + dx)) bad.push(`${name}V: drop ${sy},${sx} off the water`);
				}
			}
		});
		check(
			bad.length === 0,
			"puddles: dark water, sky streaks and a lit rim on the top shore (3 tones) and a wet halo; the vertical ones mirrored on the diagonal; every drop lands on the water",
			bad.slice(0, 4).join("; "),
		);
		const ring = decoded.puddleDrop;
		const ringTexels =
			ring === undefined ? 0 : [...Array(ring.w * ring.h).keys()].filter(i => ring.data[i * 4 + 3] > 0).length;
		check(
			ring !== undefined &&
				ring.w === 3 &&
				ring.h === 3 &&
				ringTexels === 4 &&
				ring.data[(1 * 3 + 1) * 4 + 3] === 0,
			"a drop's ring: four texels round an empty one (a static picture: it moves on a beat, and not at all with Reduce Motion)",
			`${ringTexels} texels`,
		);
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
const SIGN_TYPES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
/** the college campus's four buildings (DESIGN_RULES EDI-17): one institution, one plate colour and one roof */
const CAMPUS_SIGNS = [12, 13, 14, 15];
const sameFamily = (a, b) => CAMPUS_SIGNS.includes(a) && CAMPUS_SIGNS.includes(b);
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
			// the campus's four plates are one maroon (its pictograms tell them apart, checked below)
			const face = sameFamily(SIGN_TYPES[i], SIGN_TYPES[j])
				? Infinity
				: dE(rgb255(SD.SIGN_ART[fa.face]), rgb255(SD.SIGN_ART[fb.face]));
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
	check(
		minFace >= 10,
		"no two boards share a face colour (the campus's four share the college's)",
		`closest faces ΔE ${minFace.toFixed(1)} (types ${pair})`,
	);
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
/**
 * where a building's sign goes, by its record: the hook's arguments (worldView.ts drawSignage) -- the MAIN entrance,
 * and the roof of the main wing (shared/game/interiors.ts: the wing behind the facade that holds the main door)
 */
const roofOf = b => b.mainWing ?? b;
const signOf = b => BS.signRect(b.buildingType ?? 1, b.doorSide ?? "bottom", b.doorX, b.doorY, roofOf(b));
{
	// --- placement, on every building of five towns: at the main entrance, facing its street, on the roof
	const seeds = [DESIGN.TOWN_SEED, 1, 42, 99991, 123456];
	const bad = [];
	const blind = [];
	let signs = 0;
	let maxShare = 0;
	let maxStreet = 0;
	const inR = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
	for (const seed of seeds) {
		const w = seed === DESIGN.TOWN_SEED ? world : generateTown(seed);
		const others = w.solids.filter(s => s.kind === "building");
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
			// on the roof: never over the sidewalk, and on the main wing (a compound footprint's porch, entrance
			// court or loading notch is not roof)
			const wing = roofOf(b);
			if (q.x < b.x || q.y < b.y || q.x + q.w > b.x + b.w || q.y + q.h > b.y + b.h)
				bad.push(`${seed}: ${b.tags} #${b.id}: the sign leaves the footprint`);
			if (q.x < wing.x || q.y < wing.y || q.x + q.w > wing.x + wing.w || q.y + q.h > wing.y + wing.h)
				bad.push(`${seed}: ${b.tags} #${b.id}: the sign leaves the main wing's roof`);
			// on the entrance wall, SIGN_INSET in from its facade
			const inset =
				side === "top"
					? q.y - wing.y
					: side === "bottom"
						? wing.y + wing.h - (q.y + q.h)
						: side === "left"
							? q.x - wing.x
							: wing.x + wing.w - (q.x + q.w);
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
			// facing its street: straight out from the board, over nothing but the lot, a road
			const n = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }[side];
			let street;
			for (let k = 8; k <= 1200 && street === undefined; k += 8) {
				const x = (n[0] < 0 ? q.x : n[0] > 0 ? q.x + q.w : q.x + q.w / 2) + n[0] * k;
				const y = (n[1] < 0 ? q.y : n[1] > 0 ? q.y + q.h : q.y + q.h / 2) + n[1] * k;
				if (others.some(o => o !== b && inR(o, x, y))) break;
				if (w.roads.some(r => inR(r, x, y))) street = k;
			}
			if (street === undefined) blind.push(`${seed}: ${b.tags} #${b.id}`);
			else maxStreet = Math.max(maxStreet, street);
			// sized to the building: no giant sticker
			maxShare = Math.max(maxShare, (a1 - a0) / (alongX ? b.w : b.h));
			if (BS.hasHelipad(t)) {
				const p = BS.helipadRect(wing);
				if (p.x < wing.x || p.y < wing.y || p.x + p.w > wing.x + wing.w || p.y + p.h > wing.y + wing.h)
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
		blind.length === 0 && maxStreet <= 600,
		"it faces its street: straight out from the board, past no other building, a road within 600 u",
		blind.slice(0, 3).join("; ") || `${maxStreet} u at most`,
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
	const measured = new Set();
	for (const [label, ids] of [
		["flat", {}],
		["art", ALL.ids],
	]) {
		setArt(ids);
		for (const t of SIGN_TYPES) {
			const real = world.solids.find(s => s.kind === "building" && s.buildingType === t);
			// towns legitimately lack some shop types (EDI-19 quotas allow zero): measure those present
			if (real === undefined) continue;
			measured.add(t);
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
	check(measured.size() >= 10, "most shop types exist to be measured", `${measured.size()} of ${SIGN_TYPES.length}`);
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
		// the roof round the board (12 to 28 u out, on the main wing's roof) and the ground in front of its facade
		// (a school's entrance court, a shop's front)
		const roof = [];
		const ground = [];
		const n = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }[b.doorSide];
		const wing = roofOf(b);
		for (let y = q.y - 28; y <= q.y + q.h + 28; y += 4) {
			for (let x = q.x - 28; x <= q.x + q.w + 28; x += 4) {
				const out = Math.max(q.x - x, x - q.x - q.w, q.y - y, y - q.y - q.h);
				if (out < 12 || x < wing.x + 8 || y < wing.y + 8 || x > wing.x + wing.w - 8 || y > wing.y + wing.h - 8)
					continue;
				roof.push(px(x, y));
			}
		}
		for (let k = 40; k <= 100; k += 6) {
			for (let a = 0; a <= 1; a += 0.1) {
				const x = n[0] !== 0 ? (n[0] < 0 ? wing.x : wing.x + wing.w) + n[0] * k : q.x + a * q.w;
				const y = n[1] !== 0 ? (n[1] < 0 ? wing.y : wing.y + wing.h) + n[1] * k : q.y + a * q.h;
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
		if (all.length === 0) continue;
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
		darkShares.length >= 10 && bad.every(s => !s.includes("night over")),
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
			if (roofs[a] === undefined || roofs[b] === undefined) continue;
			if ((a === 7 && b === 8) || sameFamily(a, b)) continue;
			const d = dE(roofs[a], roofs[b]);
			if (d < minRoof) {
				minRoof = d;
				roofPair = `${a}/${b}`;
			}
		}
	}
	check(
		minRoof >= 10,
		"the textured roofs keep their type colours apart (market and grocery share theirs, and the campus)",
		`closest ΔE ${minRoof.toFixed(1)} (types ${roofPair})`,
	);
	setArt({});
}

// ================================================================ 9. the nameplate over the world

section("9) the nameplate (UI-04 clarification): every voice with its pixel shadow, on every ground, day and night");
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
		// MON-07: the Supporter heart before a subscriber's name
		["supporter", TH.OVER_WORLD.supporter],
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
		// a downtown square's floor (MOB-07): its mosaic and a pocket park's bed (a cafe's deck is the wood floor's boards,
		// tinted: "floor: wood" below; the bodies on it, section 5)
		["square's mosaic", "medallion"],
		["square's bed", "bed"],
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
	const shown = ["name", "level", "handle", "supporter", ...TITLES.map(t => `[${t.name}]`)];
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
// ================================================================ 10. the characters' pixel art

section("10) the characters' pixel art (ART-08..ART-11): sheets, fallback, cost of a horde");
{
	const CS = require(join(SRC, "client/view/charSheets.ts"));
	const manifest = ALL.manifest;
	const byName = Object.fromEntries(manifest.textures.map(t => [t.name, t]));
	const img = name => decodePNG(readFileSync(join(ART_DIR, `${name}.png`)));

	// ---- 10a. the sheets
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

	// ---- 10b. the scripted cast (tools/character-cast.mjs): every outfit x grip x state, every zombie pose, every pet
	const cast = characterCast(require, SRC);
	const drawMember = castDrawer(require, SRC, shadowFn(false));
	const drawCast = (st, list) => list.forEach((m, i) => drawMember(st, m, (i % 12) * 110, Math.floor(i / 12) * 110));

	// ---- 10c. without ids the characters are drawn exactly as before (ART-01)
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

	// ---- 10d. each group falls back on its own; with its sheets it is drawn from them
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

	// ---- 10e. the cost of a night: 60 zombies closing in on 4 survivors with their pets, 300 frames
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
	const HORDE_SHADOW = { color: COLORS.shadow, alpha: 0.3, zIndex: Z.actorShadow };
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
				const x = Math.cos(a) * d * 1.3;
				const y = Math.sin(a) * d * 0.8;
				// its round drop shadow, as client/view/actorsView.ts draws it under every zombie (flat or art)
				st.r.drawCircle(st.cam, x + 2.6, y + 9.7, (z.big ? 22.4 : 16) * 2.1, HORDE_SHADOW);
				drawMember(st, z, x, y);
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

	// ---- 10f. the bosses (ART-14): their sheets, the flat fallback of before, each on its own, the cost of a fight
	{
		const BV = require(join(SRC, "client/view/bossView.ts"));
		const { bossHitRadius, BOSS1_SEGMENT_RADIUS } = require(join(SRC, "shared/game/entities.ts"));
		const bossSheets = [
			["bossGiant", CS.GIANT_CELL, CS.BOSS_BAND, CS.GIANT_POSES * CS.BOSS_BANDS],
			["bossHedgehog", CS.HEDGEHOG_CELL, CS.BOSS_BAND, CS.HEDGEHOG_POSES * CS.BOSS_BANDS],
			["bossCentipede", CS.CENTIPEDE_CELL, CS.BOSS_BAND, CS.CENTIPEDE_POSES * CS.BOSS_BANDS],
			["bossRafflesia", CS.RAFFLESIA_CELL, CS.RAFFLESIA_FRAMES, 1],
		];
		const bad = [];
		const extent = {};
		for (const [name, cell, cols, rows] of bossSheets) {
			const t = byName[name];
			if (t === undefined || byName[`${name}Fill`] === undefined || byName[`${name}Rim`] === undefined) {
				bad.push(`${name} (or a mask) missing`);
				continue;
			}
			if (t.w !== cols * cell || t.h !== rows * cell || t.w > 1024 || t.h > 1024)
				bad.push(`${name} is ${t.w}x${t.h}`);
			const colour = img(name);
			const fill = img(`${name}Fill`);
			const rim = img(`${name}Rim`);
			let empty = 0;
			let margin = 0;
			let mismatch = 0;
			let maxR = 0;
			for (let r = 0; r < rows; r++) {
				for (let c = 0; c < cols; c++) {
					let any = false;
					for (let y = 0; y < cell; y++) {
						for (let x = 0; x < cell; x++) {
							const i = ((r * cell + y) * colour.w + c * cell + x) * 4;
							if (colour.data[i + 3] === 0) {
								if (fill.data[i + 3] > 0 || rim.data[i + 3] > 0) mismatch++;
								continue;
							}
							any = true;
							if (x === 0 || y === 0 || x === cell - 1 || y === cell - 1) margin++;
							if (fill.data[i + 3] > 0 === rim.data[i + 3] > 0) mismatch++;
							maxR = Math.max(maxR, Math.hypot(x + 0.5 - cell / 2, y + 0.5 - cell / 2) * 4);
						}
					}
					if (!any) empty++;
				}
			}
			extent[name] = maxR;
			if (empty > 0) bad.push(`${name}: ${empty} empty cells`);
			if (margin > 0) bad.push(`${name}: ${margin} texels on a cell's border`);
			if (mismatch > 0) bad.push(`${name}: ${mismatch} texels where Fill + Rim != the cell`);
		}
		check(
			bad.length === 0,
			"10f. every boss sheet has charSheets.ts's layout (32 headings in two bands; the rafflesia's vine beats), within 1024, no empty cell, a clear margin, Fill + Rim = the cell",
			bad.slice(0, 4).join("; "),
		);
		// the size of what you hit, and a boss fits its plaza (TOWN.BOSS_CLEAR: the circle kept free round an anchor)
		const { TOWN } = require(join(SRC, "shared/engine/constants.ts"));
		const hit = { bossGiant: 45, bossHedgehog: 38, bossRafflesia: 65 };
		const sized = Object.entries(hit).every(([n, r]) => extent[n] >= r * 1.05 && extent[n] <= r * 2.2);
		check(
			sized && bossHitRadius({ type: 3 }) === 45 && BOSS1_SEGMENT_RADIUS === 34,
			"each is drawn round the body it is hit at (hit radius <= its reach <= 2.2x: fists, needles, vines past the body)",
			Object.entries(extent)
				.map(([n, r]) => `${n.slice(4)} ${r.toFixed(0)} u`)
				.join(", "),
		);
		check(
			Math.max(...Object.values(extent)) * 2 < TOWN.BOSS_CLEAR,
			`and the biggest (the rafflesia with its vines) fits its plaza many times over (${TOWN.BOSS_CLEAR} u kept free)`,
		);

		// without their ids the bosses are drawn exactly as before (ART-01), with them each from its own cell
		setArt(TOWN_IDS);
		const d = bossDigest();
		const g = JSON.parse(readFileSync(GOLDEN_BOSSES, "utf8"));
		check(
			d.count === g.count && d.sha1 === g.sha1 && d.images === 0,
			`no boss id: the ${bossCast().length} bosses make the same ${d.count} draw calls as ${g.recordedFrom.split(" ")[0]}, no image`,
			`${d.sha1.slice(0, 10)} vs ${g.sha1.slice(0, 10)}, ${g.count} calls`,
		);
		const drawBossList = bossDrawer(require, SRC, shadowFn(false));
		const usedBy = ids => {
			setArt(ids);
			const st = stage(1400, 1400, 1);
			st.cam.x = 600;
			st.cam.y = 600;
			st.r.beginFrame();
			bossCast().forEach((m, i) => drawBossList(st, m, ...bossAt(i)));
			st.r.endFrame();
			const used = {};
			for (const f of st.r.layer.GetChildren()) {
				if (f.Visible === false) continue;
				const im = f.GetChildren().find(c => c.ClassName === "ImageLabel" && c.Visible !== false);
				if (im !== undefined)
					used[nameOf[im.Image] ?? im.Image] = (used[nameOf[im.Image] ?? im.Image] ?? 0) + 1;
			}
			return { used, counts: countSprites(st.r.layer) };
		};
		const giantOnly = usedBy(only(["bossGiant", "bossGiantFill", "bossGiantRim"]));
		const cast = bossCast();
		const giants = cast.filter(m => m.type === 3);
		check(
			giantOnly.used.bossGiant === giants.length &&
				giantOnly.used.bossHedgehog === undefined &&
				giantOnly.used.bossCentipede === undefined,
			"each boss falls back on its own: only the giant uploaded, only the giant is its cells",
			JSON.stringify(giantOnly.used),
		);
		check(
			!BV.bossArtLive(3) || giantOnly.used.bossGiantFill === giants.filter(m => m.flash > 0).length,
			"...and a hit giant wears its Fill and Rim masks",
		);
		const allBoss = usedBy(ALL.ids);
		const segments = cast.filter(m => m.type === 1).length * 50;
		const wantBoss = {
			bossGiant: giants.length,
			bossHedgehog: cast.filter(m => m.type === 4).length,
			bossRafflesia: cast.filter(m => m.type === 2).length,
			bossCentipede: segments,
		};
		check(
			Object.entries(wantBoss).every(([n, k]) => allBoss.used[n] === k) && allBoss.counts.strokes === 0,
			"with every sheet: the giant, the hedgehog and the rafflesia one cell each, the centipede one a segment, no UIStroke",
			JSON.stringify(allBoss.used),
		);
		const flatBoss = usedBy(TOWN_IDS);
		check(
			allBoss.counts.sprites < flatBoss.counts.sprites,
			"and fewer sprites than the flat bosses",
			`${allBoss.counts.sprites} vs ${flatBoss.counts.sprites}`,
		);

		// a boss fight: the four of them moving, hit and flashing, 300 frames: no Instance after the warm-up
		const fight = ids => {
			setArt(ids);
			const st = stage(1280, 800, 0.5);
			st.cam.x = 0;
			st.cam.y = 0;
			const frame = f => {
				st.r.beginFrame();
				const list = [
					{ type: 3, angle: f * 0.02, moveCycle: (f * 1) % 360, flash: f % 40 < 5 ? 1 : 0 },
					{ type: 4, angle: -f * 0.03, flash: f % 55 < 4 ? 0.7 : 0 },
					{ type: 2, angle: 0, clock: f / 60, flash: f % 70 < 5 ? 1 : 0 },
					{ type: 1, angle: f * 0.01, clock: f / 60, flash: f % 90 < 6 ? 0.8 : 0 },
				];
				list.forEach((m, i) =>
					drawBossList(st, m, (i - 1.5) * 600 + Math.sin(f * 0.02) * 40, (i % 2) * 300 - 150),
				);
				st.r.endFrame();
			};
			for (let f = 0; f < 90; f++) frame(f);
			const created0 = gui.stats.created;
			for (let f = 90; f < 390; f++) frame(f);
			return { created: gui.stats.created - created0, counts: countSprites(st.r.layer) };
		};
		const fFlat = fight(TOWN_IDS);
		const fArt = fight(ALL.ids);
		console.log(
			`       bosses: flat ${fFlat.counts.sprites} sprites (${fFlat.counts.strokes} strokes), art ${fArt.counts.sprites} sprites (${fArt.counts.images} images)`,
		);
		check(
			fFlat.created === 0 && fArt.created === 0,
			"a boss fight, 300 frames: no Instance created after the warm-up, flat or art",
			`${fFlat.created}, ${fArt.created}`,
		);

		// LEG-03: each boss stands out on every ground (section 5's measure, on a shot big enough for the rafflesia);
		// its round shadow is part of the ground in both pictures, so only the body is compared
		const BS = 300;
		const bossShot = (p, m, look, withBody) => {
			setArt(look === "chars" ? ALL.ids : TOWN_IDS);
			const st = stage(BS, BS, 1);
			const sun = shadowFn(false);
			const view = new WorldView(sun);
			st.cam.x = p.x;
			st.cam.y = p.y;
			const v = st.cam.viewRect(32);
			st.r.beginFrame();
			view.drawGround(st.r, st.cam, v, world);
			view.drawSolids(st.r, st.cam, v, world);
			if (withBody) drawBossList(st, m, p.x, p.y);
			else if (m.type !== 1) {
				const so = sun(p.x, p.y, 14);
				st.r.drawCircle(st.cam, p.x + so.x, p.y + so.y, bossHitRadius(m) * 2 * 1.05, {
					color: COLORS.shadow,
					alpha: 0.35,
					zIndex: Z.actorShadow,
				});
			}
			st.r.endFrame();
			return rasterise({ layer: st.r.layer, vw: BS, vh: BS }, COLORS.bg, localImage);
		};
		const legible = [
			["giant", { type: 3, angle: 0.7, moveCycle: 200 }],
			["hedgehog", { type: 4, angle: 0.7, clock: 0.2 }],
			["centipede", { type: 1, angle: 0.7, clock: 0.2 }],
			["rafflesia", { type: 2, angle: 0, clock: 0.3 }],
		];
		const worst = {};
		const rows = [];
		for (const kind of ["grass", "park", "grassLong", "road", "plaza", "apron", "parking"]) {
			const p = spotOn(kind);
			if (p === undefined) continue;
			const cells = [];
			for (const [name, m] of legible) {
				const res = {};
				for (const look of ["flat", "chars"]) {
					res[look] = silhouette(bossShot(p, m, look, false), bossShot(p, m, look, true));
				}
				worst[name] = Math.min(worst[name] ?? Infinity, res.chars);
				cells.push(`${name} ${res.flat.toFixed(0)}->${res.chars.toFixed(0)}`);
			}
			rows.push(`${kind}: ${cells.join(", ")}`);
		}
		for (const r of rows) console.log(`       ${r}`);
		// the bar the survivor's art clears in section 5; a boss is bigger than a survivor and must not read less
		check(
			Object.keys(worst).length === legible.length && Object.values(worst).every(w => w >= 35),
			"LEG-03: with their art, every boss stands out on the worst ground (the survivor's bar, 35 ΔE)",
			Object.entries(worst)
				.map(([n, w]) => `${n} ${w.toFixed(1)}`)
				.join(", "),
		);
		setArt(TOWN_IDS);
	}
}
setArt({});

// ================================================================ 11. the interiors (EDI-04, EDI-08..EDI-14, ART-12)

section("11) interiors: nothing under a closed roof is drawn, walking in and out creates no Instance, the cost inside");
{
	const IV_MODULE = join(SRC, "client/view/interiorView.ts");
	const IV = existsSync(IV_MODULE) ? require(IV_MODULE) : undefined;
	// every call into the interior drawing, counted (an older checkout has none: its numbers are the "before")
	const drawn = { furniture: 0, decor: 0, openings: 0, walls: 0 };
	if (IV !== undefined) {
		const proto = IV.InteriorView.prototype;
		for (const [key, name] of [
			["furniture", "drawFurniture"],
			["decor", "drawDecor"],
			["openings", "drawOpenings"],
			["walls", "drawWall"],
		]) {
			const real = proto[name];
			proto[name] = function (...a) {
				drawn[key]++;
				return real.apply(this, a);
			};
		}
	}
	const reset = () => {
		for (const k of Object.keys(drawn)) drawn[k] = 0;
	};
	// a wall of an open building in the pixel art (ART-12) goes through the interior's art: counted as a wall
	if (IV !== undefined && "drawWallArt" in IV.InteriorView.prototype) {
		const real = IV.InteriorView.prototype.drawWallArt;
		IV.InteriorView.prototype.drawWallArt = function (...a) {
			drawn.walls++;
			return real.apply(this, a);
		};
	}
	const insideCost = {};
	// the town's largest building, and a camera on it
	let big;
	for (const s of world.solids) {
		if (s.kind !== "building") continue;
		if (big === undefined || s.w * s.h > big.w * big.h || (s.w * s.h === big.w * big.h && s.id < big.id)) big = s;
	}
	const at = { x: big.x + big.w / 2, y: big.y + big.h / 2 };
	for (const [label, ids] of [
		["flat", {}],
		["art", ALL.ids],
	]) {
		setArt(ids);
		// roofs on: the dense downtown and the big building from outside draw nothing of any interior
		const st = stage(1920, 1080, 1);
		const view = new WorldView(shadowFn(false));
		reset();
		drawTown(st, view, 8400, 10250);
		drawTown(st, view, at.x, at.y);
		const closed = drawn.furniture + drawn.decor + drawn.openings + drawn.walls;
		check(
			closed === 0,
			`${label}: with every roof on, no furniture, decoration, frame or wall is drawn`,
			`${closed}`,
		);
		const outside = countSprites(st.r.layer).sprites;
		// in and out of the building three times (the roof fades both ways), then twice more: no Instance
		const cycle = () => {
			for (const a of [1, 0.6, 0.2, 0, 0, 0, 0.2, 0.6, 1]) {
				big.roofAlpha = a;
				for (let f = 0; f < 4; f++) drawTown(st, view, at.x + f * 5, at.y);
			}
		};
		for (let k = 0; k < 3; k++) cycle();
		const created = gui.stats.created;
		cycle();
		cycle();
		check(
			gui.stats.created === created,
			`${label}: walking in and out of it creates no Instance`,
			`${gui.stats.created - created} created`,
		);
		// inside, the roof off: the sprites of the screen and the property writes of a walk across the building
		big.roofAlpha = 0;
		drawTown(st, view, at.x, at.y);
		const inside = countSprites(st.r.layer);
		const w0 = gui.stats.writes;
		const steps = 120;
		for (let f = 0; f < steps; f++) {
			const t = f / steps;
			drawTown(st, view, at.x - big.w * 0.3 + t * big.w * 0.6, at.y + Math.sin(t * 6) * big.h * 0.2);
		}
		const writes = (gui.stats.writes - w0) / steps;
		big.roofAlpha = undefined;
		console.log(
			`       ${label.padEnd(4)} ${big.tags} #${big.id} (${big.w} x ${big.h}), 1920 x 1080: ${outside} sprites from outside, ` +
				`${inside.sprites} inside (${inside.flat} flat, ${inside.images} images); ${writes.toFixed(0)} property writes a frame walking across it`,
		);
		insideCost[label] = inside.sprites;
	}
	setArt({});
	// the pixel art of the rooms (ART-12) costs at most 10 % more sprites than their Frames did, the town's own budget
	// (§4): a piece is one sprite instead of 1-9 Frames, but every wall adds its shade on the floor, so a building of
	// many rooms (a big house, the hospital, the school) comes out a little over the flat drawing
	if (insideCost.art !== undefined) {
		check(
			insideCost.art <= insideCost.flat * 1.1,
			"art: the largest building seen from inside stays within 10 % of the flat drawing's sprites",
			`${insideCost.art} vs ${insideCost.flat}`,
		);
	}
}

section("11b) the interiors' pixel art: no id no change, every piece in the atlas, the art on the solid's own rect");
{
	const IA_MODULE = join(SRC, "client/view/interiorArt.ts");
	// ART-01 inside: with no id, each building type's rooms make the flat interiors' very draw calls
	setArt({});
	const golden = existsSync(GOLDEN_INTERIORS) ? JSON.parse(readFileSync(GOLDEN_INTERIORS, "utf8")) : undefined;
	console.log(`  (golden: ${golden?.recordedFrom ?? "none"})`);
	for (const b of interiorBuildings(world)) {
		const g = golden?.scenes?.[`type${b.buildingType}`];
		const d = interiorDigest(b);
		check(
			g !== undefined && g.building === b.id && d.count === g.count && d.sha1 === g.sha1,
			`no id: ${b.tags} #${b.id} from inside is the flat interior of the golden, call for call`,
			g === undefined ? "no golden" : `${d.count} calls, ${d.sha1.slice(0, 10)} vs ${g.sha1.slice(0, 10)}`,
		);
		// and the town round it, without its trees, is the golden's before the trees' kinds (VEG-06)
		const t = interiorDigest(b, true, bareWorld);
		check(
			g?.noTrees !== undefined && t.count === g.noTrees.count && t.sha1 === g.noTrees.sha1,
			"  ...and without the trees round it, the same calls as before VEG-06",
			g?.noTrees === undefined
				? "no golden"
				: `${t.count} calls, ${t.sha1.slice(0, 10)} vs ${g.noTrees.sha1.slice(0, 10)}`,
		);
		// and without the downtown squares round it (MOB-07), the golden's before them
		const q = interiorDigest(b, false, bareWorld);
		check(
			g?.noSquares !== undefined && q.count === g.noSquares.count && q.sha1 === g.noSquares.sha1,
			"  ...and without the squares round it, the same calls as before MOB-07",
			g?.noSquares === undefined
				? "no golden"
				: `${q.count} calls, ${q.sha1.slice(0, 10)} vs ${g.noSquares.sha1.slice(0, 10)}`,
		);
	}
	if (existsSync(IA_MODULE)) {
		const IA = require(IA_MODULE);
		const { FURNITURE_CELLS } = require(join(SRC, "client/view/furnitureAtlas.ts"));
		setArt(ALL.ids);
		const nullR = { drawRect() {} };
		const cam = new Camera();
		const seeds = [DESIGN.TOWN_SEED, 1, 42, 99991, 123456];
		const stat = { pieces: 0, exact: 0, cropped: 0, missing: [], off: [], decor: 0, decorMissing: [], frames: 0 };
		const frameMissing = [];
		let chairs = 0;
		let seated = 0;
		const SEATED = new Set(["table", "desk", "schooldesk", "teacherdesk", "labbench"]);
		for (const seed of seeds) {
			const w = seed === DESIGN.TOWN_SEED ? world : generateTown(seed);
			const art = new IA.InteriorArt();
			art.useWorld(w);
			const byId = new Map();
			for (const s of w.solids) if (s.kind === "building") byId.set(s.id, s);
			const pieces = new Map();
			for (const s of w.solids) {
				if (s.kind !== "furniture") continue;
				const b = byId.get(s.parentId);
				if (!pieces.has(b.id)) pieces.set(b.id, []);
				pieces.get(b.id).push(s);
				stat.pieces++;
				if (!art.furniture(nullR, cam, s, b.buildingType)) {
					if (stat.missing.length < 6)
						stat.missing.push(`${s.tags} ${s.w}x${s.h} ${s.face} in type ${b.buildingType}`);
					continue;
				}
				const plan = art.plans.get(s);
				const n = plan.length / 8;
				if (n === 1) stat.exact++;
				else stat.cropped++;
				// the art stands on the piece's own rect (collision unchanged), plus at most two texels of shadow
				let x0 = Infinity;
				let y0 = Infinity;
				let x1 = -Infinity;
				let y1 = -Infinity;
				for (let i = 0; i < plan.length; i += 8) {
					x0 = Math.min(x0, plan[i] - plan[i + 2] / 2);
					y0 = Math.min(y0, plan[i + 1] - plan[i + 3] / 2);
					x1 = Math.max(x1, plan[i] + plan[i + 2] / 2);
					y1 = Math.max(y1, plan[i + 1] + plan[i + 3] / 2);
				}
				const good =
					Math.abs(x0 - s.x) < 0.01 &&
					Math.abs(y0 - s.y) < 0.01 &&
					x1 >= s.x + s.w - 0.01 &&
					y1 >= s.y + s.h - 0.01 &&
					x1 <= s.x + s.w + 10 &&
					y1 <= s.y + s.h + 10 &&
					n <= 4;
				if (!good && stat.off.length < 6) stat.off.push(`${s.tags} ${s.w}x${s.h} (${n} sprites)`);
			}
			for (const b of byId.values()) {
				for (const d of b.decor ?? []) {
					stat.decor++;
					if (!art.decor(nullR, cam, b, d) && stat.decorMissing.length < 6)
						stat.decorMissing.push(`${d.kind} ${Math.round(d.w)}x${Math.round(d.h)}`);
					if (d.kind !== "chair" && d.kind !== "chairDown") continue;
					chairs++;
					const cx = d.x + d.w / 2;
					const cy = d.y + d.h / 2;
					const near = (pieces.get(b.id) ?? []).some(
						p =>
							SEATED.has(p.tags) &&
							((cx >= p.x &&
								cx <= p.x + p.w &&
								(Math.abs(cy - p.y + 16) <= 4 || Math.abs(cy - p.y - p.h - 16) <= 4)) ||
								(cy >= p.y &&
									cy <= p.y + p.h &&
									(Math.abs(cx - p.x + 16) <= 4 || Math.abs(cx - p.x - p.w - 16) <= 4))),
					);
					if (near) seated++;
				}
				for (const o of b.openings ?? []) {
					stat.frames++;
					if (!art.opening(nullR, cam, o) && frameMissing.length < 6)
						frameMissing.push(`${o.kind} ${o.w}x${o.h}`);
				}
			}
		}
		check(
			stat.missing.length === 0,
			`every piece of furniture of ${seeds.length} towns is drawn from the atlas (${stat.pieces}: ${stat.exact} its own cell, ${stat.cropped} cropped from its kind's template)`,
			stat.missing.join("; "),
		);
		check(
			stat.off.length === 0,
			"every piece's art stands exactly on its solid (the collision box), with at most its baked shadow past it",
			stat.off.join("; "),
		);
		check(
			stat.decorMissing.length === 0,
			`every decoration (${stat.decor}) has its art: rugs, chairs, papers, glass, mats, curtains, boards, blood`,
			stat.decorMissing.join("; "),
		);
		check(
			frameMissing.length === 0,
			`every doorway and window (${stat.frames}) has its frame`,
			frameMissing.join("; "),
		);
		check(
			chairs > 0 && seated / chairs >= 0.95,
			"a chair faces the table it stands at (the art turns it by the table beside it)",
			`${seated} of ${chairs}`,
		);
		const cells = Object.keys(FURNITURE_CELLS).length;
		console.log(`       atlas: ${cells} cells; a piece is 1 sprite (its cell) or 2-4 (a template cropped)`);
		setArt({});
	}
}

// ================================================================ 11c. the town's fixtures (ART-16)

section("11c) the town's fixtures' pixel art (ART-16): every fixture and its ground in the atlas, on its own rect");
/** what lies on the ground as a decorative extra: the market's litter and a square's floor (MOB-07), art only */
const FLOOR_EXTRAS = ["spill", "paper", "bag", "drain", "cracked", "weeds", "leaves", "vigil", "chalk"];
{
	const TPA_MODULE = join(SRC, "client/view/townPropArt.ts");
	if (existsSync(TPA_MODULE)) {
		const TPA = require(TPA_MODULE);
		const { TOWN_PROP_STRIPS } = require(join(SRC, "client/view/townPropAtlas.ts"));
		const cam = new Camera();
		const noShadow = () => ({ x: 0, y: 0 });
		const calls = [];
		const rec = {
			drawRect: (c, x, y, o) => calls.push({ x, y, w: o.w, h: o.h, image: o.image, z: o.zIndex }),
			drawCircle: (c, x, y, d, o) => calls.push({ x, y, w: d, h: d, image: undefined, z: o.zIndex }),
		};
		// without the atlas every call answers false and draws nothing: townView's Frames, as before (ART-01; §1)
		setArt({});
		let silent = true;
		for (const s of world.solids) {
			if (s.kind === "prop" && TPA.drawPropArt(rec, cam, s, world, noShadow)) silent = false;
			if (s.kind === "canopy" && s.tags !== "portico" && TPA.drawCanopyArt(rec, cam, s, noShadow)) silent = false;
		}
		check(silent && calls.length === 0, "no id: no fixture is drawn from the atlas (townView draws them flat)");
		// ...and the flat fallback stays lean (the review of e9b0fbb, L5): a town holds hundreds of fixtures, so each is
		// at most two Frames with its shadow -- a lamp or a bus stop its pole and its head, the food truck its awning too,
		// a standing tent its canvas and three stripes (and a rent or a puddle) -- and the market's litter none at all
		{
			const TV = require(join(SRC, "client/view/townView.ts"));
			const { WorldView } = require(join(SRC, "client/view/worldView.ts"));
			const view = new WorldView(noShadow);
			const LIMIT = { foodtruck: 3, tent: 6, shelter: 2, column: 4, bank: 0, kiosk: 3, parasol: 3 };
			const v = { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 };
			const most = {};
			let over = [];
			for (const s of world.solids) {
				const canopy =
					s.kind === "canopy" && (s.tags === "tent" || s.tags === "shelter" || s.tags === "parasol");
				if (s.kind !== "prop" && !canopy) continue;
				calls.length = 0;
				let drawn = canopy
					? TV.drawTownCanopy(rec, cam, s, v, noShadow)
					: TV.drawTownProp(rec, cam, s, world, noShadow);
				// a bench (and the campus quad's fountain and statue) is worldView's own drawProp
				if (!drawn && !canopy) {
					view.drawProp(rec, cam, s);
					drawn = true;
				}
				const n = calls.length;
				most[s.tags] = Math.max(most[s.tags] ?? 0, n);
				const cap = LIMIT[s.tags] ?? (s.tags === "fountain" || s.tags === "statue" ? 5 : 2);
				if (n > cap && over.length < 6) over.push(`${s.tags}: ${n}`);
			}
			let litter = 0;
			for (const l of world.lots) {
				for (const g of l.ground) {
					if (!FLOOR_EXTRAS.includes(g.kind)) continue;
					calls.length = 0;
					TV.drawTownGround(rec, cam, g, v);
					litter += calls.length;
				}
			}
			check(
				over.length === 0,
				"no id: every fixture's flat fallback is at most two Frames (a lamp, a bus stop: pole and head; the food truck: 3; a tent: 5-6)",
				over.join("; ") ||
					Object.entries(most)
						.map(([k, n]) => `${k} ${n}`)
						.join(", "),
			);
			check(
				litter === 0,
				"no id: the market's litter and what lies on a square's floor are the pixel art's only (decorative extras, ART-04)",
				`${litter} calls`,
			);
		}
		setArt(ALL.ids);
		const id = ALL.ids.townProps;
		const TOWN = new Set([
			...["stall", "trestle", "crates", "handcart", "foodtruck", "bench", "streetlight", "hydrant", "mailbox"],
			...["postbox", "busstop", "swings", "slide", "climber", "springer", "hoop", "picnic", "shed", "pool"],
			...[
				"trampoline",
				"grill",
				"pile",
				"portapotty",
				"mixer",
				"dumpster",
				"scaffold",
				"column",
				"fence",
				"studs",
			],
			// the downtown squares (MOB-07)
			...["planter", "lamppost", "noticeboard", "kiosk", "cafe", "rubble", "barrier"],
		]);
		const GROUND = new Set([
			...["court", "sandbox", "garden", "steps", "site", "pad", "spill", "paper", "bag"],
			...["medallion", "drain", "cracked", "weeds", "leaves", "vigil", "chalk"],
		]);
		const seeds = [DESIGN.TOWN_SEED, 1, 42, 99991, 123456];
		const stat = { fixtures: 0, roofs: 0, ground: 0, missing: [], off: [] };
		const tags = new Set();
		/** the atlas sprites drawn for one thing: the fixture's own (not its sun shadow), their union */
		const span = () => {
			let x0 = Infinity;
			let y0 = Infinity;
			let x1 = -Infinity;
			let y1 = -Infinity;
			let n = 0;
			for (const c of calls) {
				if (c.image !== id || c.z === Z.roof - 1) continue;
				n++;
				x0 = Math.min(x0, c.x - c.w / 2);
				y0 = Math.min(y0, c.y - c.h / 2);
				x1 = Math.max(x1, c.x + c.w / 2);
				y1 = Math.max(y1, c.y + c.h / 2);
			}
			return { x0, y0, x1, y1, n };
		};
		const T = 4;
		for (const seed of seeds) {
			const w = seed === DESIGN.TOWN_SEED ? world : generateTown(seed);
			const things = [];
			for (const s of w.solids) {
				if (s.kind === "prop" && TOWN.has(s.tags)) things.push(["prop", s]);
				else if (s.kind === "canopy" && ["tent", "shelter", "parasol"].includes(s.tags))
					things.push(["roof", s]);
			}
			for (const l of w.lots) for (const g of l.ground) if (GROUND.has(g.kind)) things.push(["ground", g]);
			for (const [kind, s] of things) {
				calls.length = 0;
				const tag = kind === "ground" ? s.kind : s.tags;
				tags.add(tag);
				const ok =
					kind === "prop"
						? TPA.drawPropArt(rec, cam, s, w, noShadow)
						: kind === "roof"
							? TPA.drawCanopyArt(rec, cam, s, noShadow)
							: TPA.drawGroundArt(rec, cam, s);
				if (kind === "prop") stat.fixtures++;
				else if (kind === "roof") stat.roofs++;
				else stat.ground++;
				if (!ok) {
					if (stat.missing.length < 6)
						stat.missing.push(`${tag} ${s.w}x${s.h} ${s.face ?? "-"} v${s.variant ?? "-"}`);
					continue;
				}
				// the art starts on the thing's own rect and covers it; past it only its baked contact shadow (one
				// texel) and a hoop's rim over the court; a strip is its rect exactly
				const b = span();
				const hang = s.tags === "hoop" ? 6 * T : 0;
				const past = TOWN_PROP_STRIPS[tag] === true ? 0 : T + hang;
				const good =
					b.n >= 1 &&
					b.x0 >= s.x - hang - 0.01 &&
					b.y0 >= s.y - hang - 0.01 &&
					b.x0 <= s.x + 0.01 &&
					b.y0 <= s.y + 0.01 &&
					b.x1 >= s.x + s.w - 0.01 &&
					b.y1 >= s.y + s.h - 0.01 &&
					b.x1 <= s.x + s.w + past + 0.01 &&
					b.y1 <= s.y + s.h + past + 0.01;
				if (!good && stat.off.length < 6) stat.off.push(`${tag} ${s.w}x${s.h}: ${JSON.stringify(b)}`);
			}
		}
		check(
			stat.missing.length === 0,
			`every fixture, roof and ground of the everyday town in ${seeds.length} towns is drawn from the atlas (${stat.fixtures} fixtures, ${stat.roofs} tents and shelters, ${stat.ground} grounds; ${[...tags].length} kinds)`,
			stat.missing.join("; "),
		);
		check(
			stat.off.length === 0,
			"each one's art stands on its own rect (the collision box): at most a texel of baked shadow past it",
			stat.off.join("; "),
		);
		setArt({});
	}
}

section("12) ground items (ITM-07): every item on every ground, by day, in the survivor's light and in the dark");
{
	const { GroundItemsView } = require(join(SRC, "client/view/groundItemsView.ts"));
	const WHITE = COLORS.white;
	const rgb3 = (r, g, b) => Color3.fromRGB(r, g, b);
	/** every ground an item lands on: client/view/worldView.ts's colour, texture and tint for it */
	const GROUNDS = [
		["grass", COLORS.grass, "grass"],
		["long grass", COLORS.grass, "grassLong"],
		["park grass", COLORS.parkGrass, "grass", rgb3(228, 246, 231)],
		["asphalt", COLORS.road, "asphalt"],
		["parking lot", COLORS.road.Lerp(COLORS.sidewalk, 0.14), "asphaltLot"],
		["sidewalk", COLORS.sidewalk, "concrete"],
		["plaza pavers", COLORS.sidewalk.Lerp(WHITE, 0.1), "plaza"],
		["walk pavers", COLORS.sidewalk.Lerp(WHITE, 0.16), "pavers"],
		["gas apron", COLORS.sidewalk.Lerp(COLORS.road, 0.3), "apron"],
		["dirt path", COLORS.dirtPath, "dirt", rgb3(211, 198, 172)],
		["playground", COLORS.dirtPath.Lerp(WHITE, 0.25), "dirt"],
		["wood floor", COLORS.floorWood, "floorWood"],
		["tile floor", COLORS.floorTile, "floorTile"],
		["shop floor", COLORS.floorShop, "floorShop"],
		["carpet", COLORS.floorCarpet, "floorCarpet"],
		["kitchen", COLORS.floorKitchen, "floorKitchen"],
		["bathroom", COLORS.floorBath, "floorBath"],
		["back room", COLORS.floorConcrete, "concrete", rgb3(214, 214, 212)],
	];
	/** an item of every kind that lies on the ground: weapons, gear, ammunition, oil, food, medicine, materials, kits */
	const ITEMS = [
		[1, 0, "Dagger"],
		[1, 2, "Axe"],
		[1, 6, "Bat"],
		[1, 10, "Pistol"],
		[1, 14, "AK-40"],
		[1, 16, "Shotgun"],
		[1, 22, "Bow"],
		[1, 25, "Flamethrower"],
		[2, 4, "Steel armor"],
		[2, 13, "Flashlight"],
		[2, 14, "Robot suit"],
		[4, 44, "Ammo"],
		[4, 45, "Shells"],
		[4, 47, "Arrows"],
		[4, 48, "Oil"],
		[3, 12, "Bandage"],
		[3, 5, "First aid"],
		[3, 17, "Apple"],
		[3, 9, "Canned"],
		[3, 0, "Raw meat"],
		[3, 19, "Rotten meat"],
		[4, 23, "Wood"],
		[4, 24, "Stone"],
		[4, 26, "Steel"],
		[4, 34, "Cloth"],
		[4, 41, "Leather"],
		[4, 33, "Gunpowder"],
		[4, 30, "Parts"],
		[4, 14, "Campfire kit"],
		[4, 36, "Voltage circuit"],
	];
	const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	const lum = ([r, g, b]) => 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);
	const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
	const S = 64;
	/** one item (or none) on one ground, rasterised: 64 x 64 px at zoom 1 */
	const shot = (ground, art, night, lit, item) => {
		const root = gui.make("Frame");
		const r = new Renderer(root, "Sprites");
		r.setView(S, S);
		const dark = gui.make("Frame");
		dark.Parent = root;
		dark.BackgroundTransparency = 1;
		const cam = new Camera();
		cam.setView(S, S);
		cam.x = 5000;
		cam.y = 5000;
		const view = new GroundItemsView(shadowFn(night, 5000, 4900));
		view.reduceMotion = true;
		r.beginFrame();
		const id = art ? WA.artId(ground[2]) : undefined;
		if (id !== undefined) {
			const sz = WA.artSize(ground[2]);
			r.drawRect(cam, 5000, 5000, {
				w: 400,
				h: 400,
				zIndex: Z.ground,
				image: id,
				imageTint: ground[3],
				scaleType: "tile",
				tileW: sz.w * 4,
				tileH: sz.h * 4,
			});
		} else r.drawRect(cam, 5000, 5000, { w: 400, h: 400, color: ground[1], zIndex: Z.ground });
		if (item !== undefined) {
			view.draw(
				r,
				cam,
				cam.viewRect(32),
				[{ id: 77, kind: item[0], itemId: item[1], count: 1, x: 5000, y: 5000, vx: 0, vy: 0 }],
				1.3,
				0,
			);
		}
		r.endFrame();
		if (night) {
			const lm = new LightMap(dark, COLORS.overlayNight);
			lm.update(cam, darkAlphaAt(22, false, false), lit ? [{ x: 5000, y: 5000, r: 250, inner: 0.4 }] : []);
		}
		return rasterise({ layer: r.layer, dark, vw: S, vh: S }, COLORS.bg, localImage);
	};
	/** the item's strongest step against the ground under it: WCAG ratio and ΔE, over the pixels the item changed */
	const step = (a, b) => {
		let best = 1;
		let e = 0;
		for (let i = 0; i < a.w * a.h; i++) {
			const p = [a.data[i * 4], a.data[i * 4 + 1], a.data[i * 4 + 2]];
			const q = [b.data[i * 4], b.data[i * 4 + 1], b.data[i * 4 + 2]];
			if (p[0] === q[0] && p[1] === q[1] && p[2] === q[2]) continue;
			best = Math.max(best, ratio(p, q));
			e = Math.max(e, dE(p, q));
		}
		return { ratio: best, dE: e };
	};
	const results = {};
	for (const art of [false, true]) {
		setArt(art ? { ...ALL.ids } : {});
		for (const [mode, night, lit] of [
			["day", false, false],
			["22:00 in the light", true, true],
			["22:00 in the dark", true, false],
		]) {
			for (const g of GROUNDS) {
				const base = shot(g, art, night, lit, undefined);
				const row = ITEMS.map(it => ({ it, ...step(shot(g, art, night, lit, it), base) }));
				results[`${art ? "art" : "flat"}|${mode}|${g[0]}`] = row;
			}
		}
	}
	setArt({});
	const worst = (art, mode, key) => {
		let w;
		for (const g of GROUNDS) {
			for (const x of results[`${art}|${mode}|${g[0]}`]) {
				if (w === undefined || x[key] < w[key]) w = { ...x, ground: g[0] };
			}
		}
		return w;
	};
	const name = w => `${w.it[2]} on ${w.ground}`;
	// LEG-03 for loot: every item reads on every ground -- a step of 3:1 (WCAG 1.4.11, the awareness marks' bar) or,
	// where a brown hide on grey asphalt is close in lightness, of 35 ΔE (the survivor's floor, LEG-03)
	const readable = x => x.ratio >= 3 || x.dE >= 35;
	for (const mode of ["day", "22:00 in the light"]) {
		const bad = [];
		for (const g of GROUNDS)
			for (const x of results[`art|${mode}|${g[0]}`])
				if (!readable(x)) bad.push(`${x.it[2]} on ${g[0]} ${x.ratio.toFixed(2)}:1 ${x.dE.toFixed(0)} ΔE`);
		const wr = worst("art", mode, "ratio");
		const we = worst("art", mode, "dE");
		check(
			bad.length === 0,
			`with the icons, ${mode}: all ${ITEMS.length} items on all ${GROUNDS.length} grounds step ≥ 3:1 or ≥ 35 ΔE off the ground`,
			bad.length > 0
				? bad.slice(0, 4).join("; ")
				: `weakest ${wr.ratio.toFixed(2)}:1 (${name(wr)}), ${we.dE.toFixed(1)} ΔE (${name(we)})`,
		);
	}
	// better than the flat looks they replace: the weakest item of each ground reads at least as well
	{
		const worse = [];
		for (const g of GROUNDS) {
			const flat = Math.min(...results[`flat|day|${g[0]}`].map(x => x.dE));
			const icon = Math.min(...results[`art|day|${g[0]}`].map(x => x.dE));
			if (icon < flat) worse.push(`${g[0]} ${icon.toFixed(1)} < ${flat.toFixed(1)}`);
		}
		const f = worst("flat", "day", "dE");
		const a = worst("art", "day", "dE");
		const fr = worst("flat", "day", "ratio");
		const ar = worst("art", "day", "ratio");
		check(
			worse.length === 0,
			"on every ground the weakest icon reads at least as well as the weakest flat look (ΔE)",
			worse.length > 0
				? worse.join("; ")
				: `weakest flat ${f.dE.toFixed(1)} ΔE / ${fr.ratio.toFixed(2)}:1 → icons ${a.dE.toFixed(1)} ΔE / ${ar.ratio.toFixed(2)}:1`,
		);
	}
	// in the survivor's light an item reads as it does by day (the light's core is full light)
	{
		let off = 0;
		for (const g of GROUNDS) {
			const day = results[`art|day|${g[0]}`];
			const lit = results[`art|22:00 in the light|${g[0]}`];
			for (let i = 0; i < day.length; i++) off = Math.max(off, Math.abs(day[i].ratio - lit[i].ratio));
		}
		check(
			off < 0.05,
			"at 22:00 in the survivor's light every item reads as it does by day",
			`largest difference ${off.toFixed(3)}`,
		);
	}
	// out of every light, no item glows: it is as dark as the ground it lies on (LUZ-02)
	for (const art of ["flat", "art"]) {
		let most = { ratio: 0 };
		for (const g of GROUNDS) {
			for (const x of results[`${art}|22:00 in the dark|${g[0]}`])
				if (x.ratio > most.ratio) most = { ...x, ground: g[0] };
		}
		check(
			most.ratio < 1.5,
			`${art === "art" ? "with the icons" : "flat"}, 22:00 out of every light: no item steps more than 1.5:1 off its ground (nothing glows)`,
			`the most: ${most.ratio.toFixed(2)}:1 (${name(most)})`,
		);
	}
	// every sprite of the view is under the night (the dark layer): what is not lit is not seen
	{
		const root = gui.make("Frame");
		const r = new Renderer(root, "Sprites");
		r.setView(200, 200);
		const cam = new Camera();
		cam.setView(200, 200);
		cam.x = 1000;
		cam.y = 1000;
		const view = new GroundItemsView(shadowFn(false));
		view.target = 1;
		const zs = [];
		const draw = r.drawRect.bind(r);
		r.drawRect = (c, x, y, o) => {
			zs.push(o.zIndex ?? 1);
			return draw(c, x, y, o);
		};
		setArt({ ...ALL.ids });
		for (const t of [0, 0.3, 1.3]) {
			r.beginFrame();
			view.draw(
				r,
				cam,
				cam.viewRect(32),
				[
					{ id: 1, kind: 1, itemId: 25, count: 1, x: 1000, y: 1000, vx: 30, vy: 0 },
					{ id: 2, kind: 4, itemId: 23, count: 1, x: 1040, y: 1000, vx: 0, vy: 0 },
				],
				t,
				1 / 60,
			);
			r.endFrame();
		}
		setArt({});
		check(
			zs.length > 0 && Math.max(...zs) < Z.effect,
			`every sprite of a ground item -- icon, shadow, ring, glint, the target's brackets -- is under the night (ZIndex < ${Z.effect})`,
			`highest ${Math.max(...zs)}`,
		);
	}
}

// ================================================================ 13. combat blood (ART-15)

section(
	"13) combat blood (ART-15): the flat drawing as before; with the atlas, pixel stains that age, under the bodies",
);
{
	const BV = require(join(SRC, "client/view/bloodView.ts"));
	const BA = require(join(SRC, "client/view/bloodAtlas.ts"));
	const PS = require(join(SRC, "client/systems/particles.ts"));
	const view = new BV.BloodView();
	const drawBlood = (r, cam, v, ps) => {
		view.drawDecals(r, cam, v, ps, world);
		view.drawParticles(r, cam, v, ps);
	};
	const labOf = c => lab(...rgb(c));
	const dE3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

	// a. no id, no change: the golden flat fight
	setArt({});
	const golden = JSON.parse(readFileSync(GOLDEN_BLOOD, "utf8"));
	const flat = bloodScenario(drawBlood);
	check(
		flat.count === golden.count && flat.sha1 === golden.sha1,
		`no id: every stain and droplet of a 15 s fight is drawn exactly as before (tools/golden/blood-flat.json, from ${golden.recordedFrom})`,
		`${flat.count} calls ${flat.sha1.slice(0, 10)}, golden ${golden.count} ${golden.sha1.slice(0, 10)}`,
	);
	// LEG-02: the horde's blood is a dark brownish red, apart from a survivor's and from the acid (the only green left)
	{
		const h = rgb(COLORS.bloodHorde);
		const hs = dE3(labOf(COLORS.bloodHorde), labOf(COLORS.blood));
		const ha = dE3(labOf(COLORS.bloodHorde), labOf(COLORS.acid));
		const darker = labOf(COLORS.bloodHorde)[0] < labOf(COLORS.blood)[0] - 4;
		check(
			h[0] > h[1] * 2 && h[1] >= h[2] && darker && hs >= 20 && ha >= 60,
			"LEG-02: the horde bleeds a darker, browner red than a survivor, far from the acid's green",
			`horde (${h.join(",")}): ${hs.toFixed(1)} ΔE off a survivor's, ${ha.toFixed(1)} off the acid; L* ${labOf(COLORS.bloodHorde)[0].toFixed(0)} vs ${labOf(COLORS.blood)[0].toFixed(0)}`,
		);
		// the old green was 21 ΔE off the lawn: on grass a zombie's blood all but vanished
		const grounds = [
			COLORS.grass,
			COLORS.road,
			COLORS.sidewalk,
			COLORS.floorWood,
			COLORS.floorCarpet,
			COLORS.dirtPath,
		];
		const least = Math.min(...grounds.map(g => dE3(labOf(COLORS.bloodHorde), labOf(g))));
		check(least >= 30, "the horde's fresh blood stands off every ground (≥ 30 ΔE)", `least ${least.toFixed(1)} ΔE`);
	}

	// b. the same dice with the art: only the stains differ, never the sprays
	{
		const trace = art => {
			const pos = [];
			bloodScenario(
				() => {},
				ps => (ps.pixelArt = art),
				ps => {
					for (const p of ps.active()) pos.push(Math.round(p.x * 1000), Math.round(p.y * 1000));
				},
			);
			return createHash("sha1").update(pos.join(",")).digest("hex");
		};
		check(
			trace(false) === trace(true),
			"with the art the fight throws the same dice: every droplet flies the same",
		);
	}

	// c. the atlas: layout, bands, colours
	const png = decodePNG(readFileSync(join(ART_DIR, "blood.png")));
	const man = JSON.parse(readFileSync(join(ART_DIR, "manifest.json"), "utf8")).textures.find(t => t.name === "blood");
	{
		const cells = BA.BLOOD_CELLS;
		const inside = cells.every(([x, y, w, h]) => x + w <= png.w && y + h + 2 * BA.BLOOD_BAND_H <= png.h);
		check(
			man !== undefined &&
				man.kind === "atlas" &&
				png.w === BA.BLOOD_ATLAS_W &&
				png.h === BA.BLOOD_ATLAS_H &&
				BA.BLOOD_BAND_H * 3 === png.h &&
				inside,
			"the atlas: in the manifest (uploaded like the rest), the size bloodAtlas.ts says, three bands, every cell inside",
			`${png.w} x ${png.h}, ${cells.length} cells`,
		);
		check(
			BA.BLOOD_DROPS === 16 &&
				BA.BLOOD_SPLATS === 12 &&
				cells.length - BA.BLOOD_SMEAR_FIRST === 8 * BA.BLOOD_SMEAR_SHAPES &&
				BA.BLOOD_SPLAT_FIRST === BA.BLOOD_DROP_FIRST + BA.BLOOD_DROPS &&
				BA.BLOOD_SMEAR_FIRST === BA.BLOOD_SPLAT_FIRST + BA.BLOOD_SPLATS,
			"4 drops and 3 splats in 4 flips each, 2 smears in 8 directions",
		);
		const texels = (band, fn) => {
			for (const [x0, y0, w, h] of cells) {
				for (let y = 0; y < h; y++) {
					for (let x = 0; x < w; x++) {
						const i = ((band * BA.BLOOD_BAND_H + y0 + y) * png.w + x0 + x) * 4;
						if (png.data[i + 3] > 0) fn([png.data[i], png.data[i + 1], png.data[i + 2]], png.data[i + 3]);
					}
				}
			}
		};
		let grey = true;
		texels(0, c => (grey &&= c[0] === c[1] && c[1] === c[2]));
		check(grey, "band 0 is greyscale: the drying and the ground tint it (ImageColor3), like the roofs (ART-03)");
		for (const [band, base, who] of [
			[1, COLORS.blood, "a survivor's"],
			[2, COLORS.bloodHorde, "the horde's"],
		]) {
			let red = true;
			let lightest = 0;
			const sum = [0, 0, 0];
			let n = 0;
			texels(band, (c, a) => {
				red &&= c[0] > c[1] && c[0] > c[2];
				lightest = Math.max(lightest, lab(...c)[0]);
				for (let k = 0; k < 3; k++) sum[k] += c[k] * a;
				n += a;
			});
			const mean = sum.map(v => v / n);
			const off = dE3(lab(...mean), labOf(base));
			check(
				red && lightest < 75 && off <= 8,
				`band ${band}, ${who} wet blood: every texel its own red (no outline, no halo of another colour), no near-white fleck (LEG-01), its mean the palette's`,
				`lightest L* ${lightest.toFixed(0)}, mean ${off.toFixed(1)} ΔE off the palette`,
			);
		}
	}

	// d. a smear runs from the attacker through the target: its droplets lie along the hit, in all 8 directions
	{
		const bad = [];
		for (let s = 0; s < 8; s++) {
			for (const pick of [0.2, 0.7]) {
				const [x0, y0, w, h, ax, ay] = BA.BLOOD_CELLS[BV.stainCell(PS.DECAL_SMEAR, pick, s)];
				let sx = 0;
				let sy = 0;
				let n = 0;
				for (let y = 0; y < h; y++) {
					for (let x = 0; x < w; x++) {
						if (png.data[((y0 + y) * png.w + x0 + x) * 4 + 3] === 0) continue;
						sx += x + 0.5 - ax;
						sy += y + 0.5 - ay;
						n++;
					}
				}
				const got = Math.atan2(sy, sx);
				const want = (s * Math.PI) / 4;
				const off = Math.abs(Math.atan2(Math.sin(got - want), Math.cos(got - want)));
				if (off > 0.45 || PS.sectorOf(want + 0.3) !== s)
					bad.push(`sector ${s}: ${((got * 180) / Math.PI).toFixed(0)}°`);
			}
		}
		check(
			bad.length === 0,
			"a smear's spatter lies along the hit's direction, all 8 of them (within 26°)",
			bad.join(", "),
		);
	}

	// e. what the art draws: one image per stain on the texel grid, square droplets, all of it under the bodies
	{
		setArt({ ...ALL.ids });
		check(BV.bloodArtLive(), "with the atlas's id the pixel art is live");
		const st = stage(1280, 720, 1);
		const got = [];
		const draw = st.r.drawRect;
		st.r.drawRect = function (cam, x, y, o) {
			got.push({ x, y, w: o.w, h: o.h, z: o.zIndex, image: o.image, circle: o.circle, alpha: o.alpha });
			return draw.call(this, cam, x, y, o);
		};
		setSeed(99);
		const ps = new ParticleSystem();
		ps.pixelArt = true;
		st.cam.x = BLOOD_AT.x;
		st.cam.y = BLOOD_AT.y;
		let rounds = 0;
		for (let f = 0; f < 240; f++) {
			if (f % 20 === 0) ps.bloodBurst(BLOOD_AT.x + f, BLOOD_AT.y, 3, "zombie", f * 0.3);
			if (f % 60 === 5) ps.bloodBurst(BLOOD_AT.x - f, BLOOD_AT.y + 50, 10, "zombie");
			if (f % 70 === 9) ps.bloodBurst(BLOOD_AT.x, BLOOD_AT.y - 80, 4, "player", 1);
			if (f % 50 === 3) ps.debrisBurst(BLOOD_AT.x + 90, BLOOD_AT.y + 90, 5, COLORS.fence);
			ps.update(1 / 60);
			st.r.beginFrame();
			drawBlood(st.r, st.cam, st.cam.viewRect(32), ps);
			st.r.endFrame();
			rounds++;
		}
		const stains = got.filter(c => c.z === Z.decal);
		const drops = got.filter(c => c.z === Z.decal + 1);
		const chips = got.filter(c => c.z === Z.particle);
		const onGrid = c =>
			Math.abs(((c.x - c.w / 2) % 4) + 4) % 4 < 1e-6 && Math.abs(((c.y - c.h / 2) % 4) + 4) % 4 < 1e-6;
		check(
			stains.length > 0 && stains.every(c => c.image === ALL.ids.blood && c.circle !== true && onGrid(c)),
			"every stain is one cell of the atlas, on the town's texel grid (never a circle)",
			`${stains.length} stain draws in ${rounds} frames`,
		);
		check(
			drops.length > 0 &&
				chips.length > 0 &&
				[...drops, ...chips].every(
					c => c.circle !== true && c.w === c.h && (c.w === 4 || c.w === 8) && onGrid(c),
				),
			"every droplet and chip is a square of one or two texels on the grid, never a circle",
			`${drops.length} droplets, ${chips.length} chips`,
		);
		check(
			[...stains, ...drops].every(c => c.z < Z.actorShadow) &&
				[...drops, ...chips].every(c => (c.alpha ?? 1) === 1),
			"LEG-03: blood lies and flies under every body, shadow and item on the ground; a droplet never fades or flickers",
			`highest blood ZIndex ${Math.max(...[...stains, ...drops].map(c => c.z))} < ${Z.actorShadow}`,
		);
		const noBlood = { ...ALL.ids };
		delete noBlood.blood;
		setArt(noBlood);
		check(
			!BV.bloodArtLive(),
			"without the atlas's id (or when it did not load) the blood is flat, the rest of the art or not",
		);
		setArt({});
	}

	// f. a stain ages in steps: wet, drying, a game day old, gone -- monotonic, nothing flashes
	{
		const d = {
			x: 0,
			y: 0,
			size: 30,
			color: COLORS.bloodHorde,
			life: 10,
			maxLife: 10,
			kind: 1,
			src: PS.BLOOD_HORDE,
		};
		let changes = 0;
		let last;
		let alphaUp = false;
		let wetter = false;
		let prevAlpha = 1;
		let prevDry = Infinity;
		const dry = labOf(COLORS.bloodDry);
		for (let age = 0; age < PS.BLOOD_LIFE_S; age += 0.25) {
			d.age = age;
			const band = BV.stainBand(d.src, age);
			const tint = BV.stainTint(d, band, BV.GROUND_HARD);
			const alpha = BV.stainAlpha(age);
			const key = `${band}|${rgb(tint).join(",")}|${alpha}`;
			if (key !== last) changes++;
			last = key;
			if (alpha > prevAlpha + 1e-9) alphaUp = true;
			prevAlpha = alpha;
			if (band === 0) {
				const toDry = dE3(labOf(tint), dry);
				if (toDry > prevDry + 1e-6) wetter = true;
				prevDry = toDry;
			}
		}
		check(
			changes <= 1 + BV.BLOOD_DRY_STEPS + BV.BLOOD_FADE_STEPS && !alphaUp && !wetter,
			`over its ${PS.BLOOD_LIFE_S} s a stain changes look ${changes} times: wet, ${BV.BLOOD_DRY_STEPS} steps to dry, ${BV.BLOOD_FADE_STEPS} to gone -- always drier and fainter, never back`,
		);
		const wet = BV.stainBand(PS.BLOOD_SURVIVOR, 0) === 1 && BV.stainBand(PS.BLOOD_HORDE, 0) === 2;
		const gone = BV.stainBand(PS.BLOOD_SURVIVOR, PS.BLOOD_WET_S) === 0;
		const dried =
			rgb(BV.stainTint({ ...d, age: PS.BLOOD_DRY_S }, 0, BV.GROUND_HARD)).join() === rgb(COLORS.bloodDry).join();
		check(
			wet && gone && dried,
			"wet (its glossy band) for the first seconds, then matte; a game day old it is COLORS.bloodDry",
		);
		const soak = labOf(BV.stainTint({ ...d, age: 60 }, 0, BV.GROUND_SOAK));
		const hard = labOf(BV.stainTint({ ...d, age: 60 }, 0, BV.GROUND_HARD));
		const chroma = c => Math.hypot(c[1], c[2]);
		check(
			soak[0] < hard[0] && chroma(soak) < chroma(hard),
			"on asphalt, grass and dirt the blood soaks in: darker and less red than on a floor",
			`L* ${soak[0].toFixed(0)} vs ${hard[0].toFixed(0)}, chroma ${chroma(soak).toFixed(0)} vs ${chroma(hard).toFixed(0)}`,
		);
	}

	// g. stains join, and the ring keeps the newest
	{
		const ps = new ParticleSystem();
		ps.pixelArt = true;
		for (let i = 0; i < 200; i++)
			ps.addDecal(5000 + (i % 3), 5000, 10, COLORS.blood, PS.DECAL_DROP, PS.BLOOD_SURVIVOR);
		const one = ps.decalRecords().length;
		ps.addDecal(5000, 5000, 30, COLORS.blood, PS.DECAL_SPLAT, PS.BLOOD_SURVIVOR);
		ps.addDecal(5004, 5002, 10, COLORS.blood, PS.DECAL_DROP, PS.BLOOD_SURVIVOR);
		ps.addDecal(5000, 5000, 10, COLORS.bloodHorde, PS.DECAL_DROP, PS.BLOOD_HORDE);
		check(
			one === 1 && ps.decalRecords().length === 3,
			"200 droplets on one spot are one stain; a splat on it is a second, and the horde's blood is its own",
			`${one} then ${ps.decalRecords().length} records`,
		);
		const ring = new ParticleSystem();
		ring.pixelArt = true;
		for (let i = 0; i < 400; i++) {
			ring.addDecal(i * 60, 0, 30, COLORS.bloodHorde, PS.DECAL_SPLAT, PS.BLOOD_HORDE);
			ring.update(0.5);
		}
		const xs = ring.decalRecords().map(d => d.x);
		check(
			xs.length === 160 && Math.min(...xs) === 240 * 60 && xs.includes(399 * 60),
			"400 stains in a long night: the ring holds 160 (80 on Low), the 240 shed longest ago gave their records up",
			`${xs.length} records, the oldest at #${Math.min(...xs) / 60}`,
		);
		// the quality drops to Low with 160 fresh stains: the 80 past the Low ring fade out within the fade's 300 s
		// (not the day and a half a stain lives), a droplet on one of them does not revive it, the first 80 stay
		const low = new ParticleSystem();
		low.pixelArt = true;
		for (let i = 0; i < 160; i++) {
			low.addDecal(i * 60, 0, 30, COLORS.bloodHorde, PS.DECAL_SPLAT, PS.BLOOD_HORDE);
			low.update(0.1);
		}
		low.lowDetail = true;
		low.update(0.1);
		const past = low.decalRecords().slice(80);
		const fading = past.every(d => d.age >= PS.BLOOD_DRY_S);
		low.addDecal(120 * 60 + 2, 0, 10, COLORS.bloodHorde, PS.DECAL_DROP, PS.BLOOD_HORDE);
		const revived = low.decalRecords().some((d, i) => i >= 80 && d.age < PS.BLOOD_DRY_S);
		for (let t = 0; t < PS.BLOOD_LIFE_S - PS.BLOOD_DRY_S + 1; t += 1) low.update(1);
		const alive = low.decalRecords().filter(d => d.age < PS.BLOOD_LIFE_S).length;
		check(
			fading && !revived && alive === 80,
			"160 stains, then the Low tier: the 80 past its ring go straight to their fade (none revived by a drop on it); 300 s on, 80 are left",
			`fading ${fading}, revived ${revived}, ${alive} alive`,
		);
	}

	// h. what a stain lies on
	{
		const soakKinds = new Set([
			"road",
			"median",
			"grass",
			"grassLong",
			"park",
			"path",
			"verge",
			"pit",
			"parking",
			"stall",
			"playground",
			"border",
		]);
		const hardKinds = new Set([
			"building",
			"sidewalk",
			"plaza",
			"walk",
			"drive",
			"apron",
			"ramp",
			"porch",
			"patio",
		]);
		const wrong = [];
		let n = 0;
		setSeed(5);
		for (let i = 0; i < 4000; i++) {
			const x = Math.random() * world.width;
			const y = Math.random() * world.height;
			const s = surfaceAt(x, y);
			const want = soakKinds.has(s) ? BV.GROUND_SOAK : hardKinds.has(s) ? BV.GROUND_HARD : undefined;
			if (want === undefined) continue;
			n++;
			if (BV.bloodGround(world, x, y) !== want) wrong.push(`${s} at ${x.toFixed(0)},${y.toFixed(0)}`);
		}
		check(
			wrong.length === 0 && n > 2000,
			"a stain soaks into asphalt, grass and soil, and lies on floors, sidewalks and porches (4000 points of the town)",
			wrong.length > 0 ? wrong.slice(0, 3).join("; ") : `${n} points`,
		);
	}

	// i. LEG-03 and LEG-01: an item lying in blood still reads, wet or dry, on a floor and on the asphalt
	{
		const { GroundItemsView } = require(join(SRC, "client/view/groundItemsView.ts"));
		setArt({ ...ALL.ids });
		const S = 64;
		const ITEMS = [
			[3, 0, "Raw meat"],
			[3, 5, "First aid"],
			[3, 12, "Bandage"],
			[1, 10, "Pistol"],
			[4, 44, "Ammo"],
			[4, 41, "Leather"],
			[4, 23, "Wood"],
		];
		const GROUNDS = [
			["wood floor", "floorWood", undefined],
			["asphalt", "asphalt", undefined],
			["tile floor", "floorTile", undefined],
		];
		const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
		const lum = ([r, g, b]) => 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);
		const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
		const shot = (ground, stain, item) => {
			const root = gui.make("Frame");
			const r = new Renderer(root, "Sprites");
			r.setView(S, S);
			const cam = new Camera();
			cam.setView(S, S);
			cam.x = 5000;
			cam.y = 5000;
			const items = new GroundItemsView(shadowFn(false));
			items.reduceMotion = true;
			r.beginFrame();
			const sz = WA.artSize(ground[1]);
			r.drawRect(cam, 5000, 5000, {
				w: 400,
				h: 400,
				zIndex: Z.ground,
				image: WA.artId(ground[1]),
				scaleType: "tile",
				tileW: sz.w * 4,
				tileH: sz.h * 4,
			});
			view.drawDecal(r, cam, cam.viewRect(32), stain, world, WA.artId("blood"));
			if (item !== undefined) {
				items.draw(
					r,
					cam,
					cam.viewRect(32),
					[{ id: 77, kind: item[0], itemId: item[1], count: 1, x: 5000, y: 5000, vx: 0, vy: 0 }],
					1.3,
					0,
				);
			}
			r.endFrame();
			return rasterise({ layer: r.layer, vw: S, vh: S }, COLORS.bg, localImage);
		};
		const step = (a, b) => {
			let best = 1;
			let e = 0;
			for (let i = 0; i < a.w * a.h; i++) {
				const p = [a.data[i * 4], a.data[i * 4 + 1], a.data[i * 4 + 2]];
				const q = [b.data[i * 4], b.data[i * 4 + 1], b.data[i * 4 + 2]];
				if (p[0] === q[0] && p[1] === q[1] && p[2] === q[2]) continue;
				best = Math.max(best, ratio(p, q));
				e = Math.max(e, dE3(lab(...p), lab(...q)));
			}
			return { ratio: best, dE: e };
		};
		const bad = [];
		let weakest;
		let cases = 0;
		for (const g of GROUNDS) {
			for (const [src, age, what] of [
				[PS.BLOOD_SURVIVOR, 0, "a survivor's wet"],
				[PS.BLOOD_HORDE, 0, "the horde's wet"],
				[PS.BLOOD_HORDE, 300, "drying"],
				[PS.BLOOD_HORDE, 700, "a day old"],
			]) {
				const stain = {
					x: 5000,
					y: 5000,
					size: 30,
					color: COLORS.blood,
					life: 10,
					maxLife: 10,
					kind: PS.DECAL_SPLAT,
					src,
					sector: -1,
					age,
					ground: -1,
					pick: 0.1,
				};
				const base = shot(g, stain, undefined);
				for (const it of ITEMS) {
					const s = step(shot(g, stain, it), base);
					cases++;
					if (weakest === undefined || s.dE < weakest.dE)
						weakest = { ...s, where: `${it[2]} in ${what} blood on ${g[0]}` };
					if (!(s.ratio >= 3 || s.dE >= 35))
						bad.push(`${it[2]} in ${what} blood on ${g[0]}: ${s.ratio.toFixed(2)}:1 ${s.dE.toFixed(0)} ΔE`);
				}
			}
		}
		setArt({});
		check(
			bad.length === 0,
			`LEG-01/LEG-03: ${cases} items lying in a splat (wet, drying, dry; wood, asphalt, tiles) step ≥ 3:1 or ≥ 35 ΔE off it`,
			bad.length > 0
				? bad.slice(0, 3).join("; ")
				: `weakest ${weakest.ratio.toFixed(2)}:1 / ${weakest.dE.toFixed(0)} ΔE (${weakest.where})`,
		);
	}
}

// ================================================================ 14. window glass (EDI-18)

section("14) window glass (EDI-18): intact and broken read apart from the street, the shards are a decal, no churn");
{
	const WIN = require(join(SRC, "shared/game/windows.ts"));
	const panesOf = s => (s.openings ?? []).filter(o => o.kind === "window" && o.glass !== undefined);
	// the building on a 1920 x 1080 screen with the most of both: glass in some windows, open frames in others
	let b;
	let most = 0;
	for (const s of world.solids) {
		if (s.kind !== "building" || s.w > 1600 || s.h > 900) continue;
		const ws = panesOf(s);
		const both = Math.min(
			ws.filter(o => WIN.windowIntact(o.glass)).length,
			ws.filter(o => !WIN.windowIntact(o.glass)).length,
		);
		if (both > most) ((b = s), (most = both));
	}
	const at = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
	const panes = panesOf(b);
	const intact = panes.filter(o => WIN.windowIntact(o.glass));
	const broken = panes.filter(o => !WIN.windowIntact(o.glass));
	console.log(
		`       ${b.tags} #${b.id} (${b.w} x ${b.h}): ${intact.length} windows with glass, ${broken.length} open frames`,
	);
	/** the shards' layer: the ground's detail, under the blood (interiorView Z_SHARDS) */
	const ZS = Z.floorDetail + 1;
	const key = c => JSON.stringify(rgb(c));
	const GLASS = key(COLORS.glassCold);
	const HOLE = key(COLORS.carGlass.Lerp(Color3.fromRGB(0, 0, 0), 0.55));
	const DARK = key(COLORS.carGlass);
	/** one frame of the town on the building, its draw calls: [x, y, w, h, rot, rgb, alpha, z, ..., image] */
	const frameCalls = (ids, roofAlpha) => {
		setArt(ids);
		const st = stage(1920, 1080, 1);
		const view = new WorldView(shadowFn(false));
		b.roofAlpha = roofAlpha;
		drawTown(st, view, at.x, at.y);
		calls.length = 0;
		capturing = true;
		drawTown(st, view, at.x, at.y);
		capturing = false;
		b.roofAlpha = undefined;
		setArt({});
		return calls.slice();
	};
	const near = (c, o, d) => Math.hypot(c[0] - (o.x + o.w / 2), c[1] - (o.y + o.h / 2)) <= d;
	/** is call `c` on the street side of window `o`'s wall? (a wing's wall can stand inside the building's rect) */
	const NORMAL = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
	const outside = (c, o) =>
		(c[0] - (o.x + o.w / 2)) * NORMAL[o.side][0] + (c[1] - (o.y + o.h / 2)) * NORMAL[o.side][1] > 0;
	const colour = c => JSON.stringify(c[5]);
	/** the calls of window `o`'s neighbourhood that pass `f` */
	const around = (cs, o, d, f) => cs.filter(c => near(c, o, d) && f(c));
	const every = (list, f) => list.length > 0 && list.every(f);

	// flat, every roof on: the street's view of the building
	{
		const cs = frameCalls({}, undefined);
		const chipsOut = o => around(cs, o, 60, c => c[7] === ZS && colour(c) === GLASS && outside(c, o)).length;
		check(
			every(broken, o => chipsOut(o) === 3) &&
				intact.every(o => around(cs, o, 60, c => c[7] === ZS && colour(c) === GLASS).length === 0),
			"flat, roof on: three shards of glass on the ground outside every open frame, nothing on the ground under glass",
			`${broken.map(chipsOut).join(",")} shards outside the open frames`,
		);
		const mark = (o, col) => around(cs, o, 30, c => c[7] === Z.roof + 2 && colour(c) === col).length;
		const stubs = o => around(cs, o, 40, c => c[7] === Z.roof + 3 && colour(c) === GLASS).length;
		check(
			every(intact, o => mark(o, DARK) === 1 && stubs(o) === 0) &&
				every(broken, o => mark(o, HOLE) === 1 && stubs(o) === 2),
			"flat, roof on: on the roof's edge, glass is the dark glass it always was, an open frame the darker hole with two stubs of glass",
			`${intact.length} + ${broken.length} windows`,
		);
		const glass = rgb255(COLORS.glassCold);
		const hole = rgb255(COLORS.carGlass.Lerp(Color3.fromRGB(0, 0, 0), 0.55));
		check(
			dE(glass, hole) >= 35,
			"the stubs step off the hole (the survivor's bar, 35 ΔE): an open frame reads from the street",
			`${dE(glass, hole).toFixed(1)} ΔE`,
		);
	}

	// flat, the roof off: inside the building
	{
		const cs = frameCalls({}, 0);
		const pane = (o, alpha) =>
			around(cs, o, 12, c => c[7] === Z.structure && colour(c) === GLASS && Math.abs(c[6] - alpha) < 1e-3).length;
		const glint = o => around(cs, o, 40, c => c[7] === Z.structure + 2 && colour(c) !== GLASS).length;
		const chipsIn = o => around(cs, o, 60, c => c[7] === ZS && colour(c) === GLASS && !outside(c, o)).length;
		check(
			every(intact, o => pane(o, 0.62) === 1 && glint(o) === 1 && chipsIn(o) === 0),
			"flat, inside: an intact window is the pane (a more solid glass) with its streak of light",
		);
		check(
			every(broken, o => pane(o, 0.35) === 1 && glint(o) === 0 && chipsIn(o) === 3),
			"flat, inside: an open frame is the old sill tint and its glass on the floor inside",
			`${broken.map(chipsIn).join(",")} shards inside`,
		);
	}

	// with the art: the interiors' atlas (client/view/interiorArt.ts) -- the frame with the pane or with what is left of
	// it, and the broken-glass cell for the shards -- each cell read off the image's rect
	{
		const { FURNITURE_CELLS } = require(join(SRC, "client/view/furnitureAtlas.ts"));
		const atlas = ALL.ids.furniture;
		/** one frame's images, [x, y, z, rectX, rectY] each */
		const imageCalls = roofAlpha => {
			const out = [];
			const inner = Renderer.prototype.drawRect;
			Renderer.prototype.drawRect = function (cam, wx, wy, o) {
				if (capturing && o.image === atlas) out.push([wx, wy, o.zIndex, o.rectX, o.rectY]);
				return inner.call(this, cam, wx, wy, o);
			};
			try {
				frameCalls(ALL.ids, roofAlpha);
			} finally {
				Renderer.prototype.drawRect = inner;
			}
			return out;
		};
		const cellIs = (c, key) =>
			FURNITURE_CELLS[key] !== undefined && c[3] === FURNITURE_CELLS[key][0] && c[4] === FURNITURE_CELLS[key][1];
		const nearI = (c, o, d) => Math.hypot(c[0] - (o.x + o.w / 2), c[1] - (o.y + o.h / 2)) <= d;
		const outsideI = (c, o) =>
			(c[0] - (o.x + o.w / 2)) * NORMAL[o.side][0] + (c[1] - (o.y + o.h / 2)) * NORMAL[o.side][1] > 0;
		const shardsCell = o => `glass:${o.w >= o.h ? "h" : "v"}`;
		const shardsAt = (cs, o, out) =>
			cs.filter(c => nearI(c, o, 60) && c[2] === ZS && cellIs(c, shardsCell(o)) && outsideI(c, o) === out).length;
		const roofOn = imageCalls(undefined);
		const cs = frameCalls(ALL.ids, undefined);
		const glintRoof = o => around(cs, o, 40, c => c[7] === Z.roof + 3 && colour(c) !== GLASS).length;
		check(
			every(broken, o => shardsAt(roofOn, o, true) === 1) &&
				every(intact, o => glintRoof(o) === 1 && shardsAt(roofOn, o, true) === 0),
			"art, roof on: the atlas's broken glass outside every open frame, a glint on the roof's edge over the glass",
			`${broken.map(o => shardsAt(roofOn, o, true)).join(",")} outside the open frames`,
		);
		const inside = imageCalls(0);
		const frameCell = (o, key) =>
			inside.filter(c => nearI(c, o, 12) && c[2] === Z.structure + 2 && cellIs(c, `${key}:${o.side}`)).length;
		check(
			every(intact, o => frameCell(o, "windowGlass") === 1 && frameCell(o, "window") === 0) &&
				every(
					broken,
					o =>
						frameCell(o, "window") === 1 &&
						frameCell(o, "windowGlass") === 0 &&
						shardsAt(inside, o, false) === 1,
				),
			"art, inside: the frame with the whole pane (windowGlass), or with what is left of it (window) and the glass on the floor",
		);
	}

	// legibility: nothing of the glass is ever drawn over a body or an item
	{
		const all = [...frameCalls({}, 0), ...frameCalls(ALL.ids, 0)];
		const glassZ = [];
		for (const o of panes) for (const c of around(all, o, 70, c => c[7] < Z.roof)) glassZ.push(c[7]);
		check(
			glassZ.length > 0 && Math.max(...glassZ) < Z.zombie && ZS < Z.decal,
			"a body in the frame is drawn over the glass, and the shards lie under the blood and every item (the ground's detail layer)",
			`highest ${Math.max(...glassZ)} (the horde ${Z.zombie}); shards at ${ZS}, the blood at ${Z.decal}, items at ${Z.item}`,
		);
	}

	// a pane breaking in view (and, to measure it again and again, going back in): no Instance after the first break
	for (const [label, ids] of [
		["flat", {}],
		["art", ALL.ids],
	]) {
		setArt(ids);
		const st = stage(1920, 1080, 1);
		const view = new WorldView(shadowFn(false));
		const flip = on => intact.forEach(o => WIN.setWindowGlass(o.glass, !on));
		const run = frames => {
			for (let f = 0; f < frames; f++) {
				if (f % 10 === 0) flip(f % 20 === 0);
				b.roofAlpha = f % 40 < 20 ? undefined : 0;
				drawTown(st, view, at.x + (f % 7) * 3, at.y);
			}
		};
		run(40);
		const created = gui.stats.created;
		const w0 = gui.stats.writes;
		run(200);
		check(
			gui.stats.created === created,
			`${label}: all ${intact.length} panes breaking and the roof lifting, 200 frames after one of each: no Instance created`,
			`${gui.stats.created - created} created, ${((gui.stats.writes - w0) / 200).toFixed(0)} writes a frame`,
		);
		flip(false);
		b.roofAlpha = undefined;
		setArt({});
	}
	check(
		intact.every(o => WIN.windowIntact(o.glass)) && broken.every(o => !WIN.windowIntact(o.glass)),
		"the town is left as generated",
	);
}

// ================================================================ 15. the entrances (ART-17)

section("15) the entrances (ART-17): each doorway its own, the gap left open, every side its own bake, cheap");
{
	const EA_MODULE = join(SRC, "client/view/entranceArt.ts");
	if (!existsSync(EA_MODULE)) {
		console.log("  (no client/view/entranceArt.ts in this checkout)");
	} else {
		const EA = require(EA_MODULE);
		const EN = require(join(SRC, "client/view/entrances.ts"));
		const { ENTRANCE_CELLS, ENTRANCE_SINGLE_LEAF: SINGLE } = require(join(SRC, "client/view/entranceAtlas.ts"));
		const { InteriorView } = require(join(SRC, "client/view/interiorView.ts"));
		const { insideBuilding, querySolids } = require(join(SRC, "shared/game/world.ts"));
		const cam = new Camera();
		const count = { n: 0 };
		const rec = {
			drawRect: () => count.n++,
			drawCircle: () => count.n++,
		};
		const all = { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 };
		const doorsOf = b => (b.openings ?? []).filter(o => o.kind === "door");
		// --- without the atlas (ART-01): the art answers false, and each entrance is at most two Frames on the ground
		// and one on the roof's edge (ART-16's budget for the flat drawing)
		{
			setArt(Object.fromEntries(Object.entries(ALL.ids).filter(([name]) => name !== "entrances")));
			const iv = new InteriorView();
			iv.useWorld(world);
			let silent = true;
			let worstGround = 0;
			let worstRoof = 0;
			let doors = 0;
			for (const b of world.solids) {
				if (b.kind !== "building") continue;
				for (const o of doorsOf(b)) {
					doors++;
					if (iv.entrances.outside(rec, cam, b, o, all) || iv.entrances.lintel(rec, cam, b, o, 1))
						silent = false;
					const one = { ...b, openings: [o] };
					count.n = 0;
					iv.drawEntrances(rec, cam, one, all);
					worstGround = Math.max(worstGround, count.n);
					count.n = 0;
					iv.drawRoofMarks(rec, cam, one, 1, COLORS.shadow, all);
					worstRoof = Math.max(worstRoof, count.n);
				}
			}
			check(silent, "no entrances' atlas: the art draws nothing, the flat entrances stand in (ART-01)");
			check(
				worstGround <= 2 && worstRoof <= 1,
				`flat, each of the ${doors} doorways is at most two Frames on the ground and one on the roof's edge`,
				`ground ${worstGround}, roof ${worstRoof}`,
			);
			const bases = new Set(EN.ENTRANCE_STYLES.map(s => `${s.stoop}:${JSON.stringify(rgb(s.base.color))}`));
			check(
				[...bases].length >= 10,
				"flat, the entrances are told apart on the ground too (step, back step, mats, ramp, steps, runner, bay, service)",
				`${[...bases].length} kinds`,
			);
		}
		// --- with the atlas, in five towns
		setArt(ALL.ids);
		const seeds = [DESIGN.TOWN_SEED, 1, 42, 99991, 123456];
		const stat = {
			doors: 0,
			planned: 0,
			missing: [],
			stoopOff: [],
			roofOff: [],
			frameOff: [],
			passage: [],
			overlap: [],
			modes: { outFlat: 0, inFlat: 0, inSquare: 0, none: 0 },
			torn: 0,
			boarded: 0,
			houseDoors: 0,
			shattered: 0,
			styles: new Set(),
			worst: { out: 0, inside: 0 },
			leafCount: [],
			singles: 0,
			doubles: 0,
		};
		const hitsRect = (a, b) =>
			a.x < b.x + b.w - 0.5 && a.x + a.w > b.x + 0.5 && a.y < b.y + b.h - 0.5 && a.y + a.h > b.y + 0.5;
		const bodyOf = p => {
			const s = p.cell[6] * 4;
			return { x: p.x, y: p.y, w: p.w - s, h: p.h - s };
		};
		for (const seed of seeds) {
			const w = seed === DESIGN.TOWN_SEED ? world : generateTown(seed);
			const art = new EA.EntranceArt();
			art.useWorld(w);
			for (const b of w.solids) {
				if (b.kind !== "building") continue;
				const house = b.buildingType === 1 || b.buildingType === 2;
				for (const o of doorsOf(b)) {
					stat.doors++;
					const plan = art.planOf(b, o);
					if (plan === undefined) {
						if (stat.missing.length < 5)
							stat.missing.push(`type ${b.buildingType} ${o.side} ${o.w}x${o.h}`);
						continue;
					}
					stat.planned++;
					const style = EN.entranceStyle(b.buildingType, o.main);
					stat.styles.add(style.name);
					if (house) stat.houseDoors++;
					const along = o.side === "top" || o.side === "bottom";
					const nx = o.side === "left" ? -1 : o.side === "right" ? 1 : 0;
					const ny = o.side === "top" ? -1 : o.side === "bottom" ? 1 : 0;
					// the wall's outer face, and the passage: the gap less 20 u at each jamb (a leaf square to the wall
					// stands in those), 72 u in (the doorway's clear floor, EDI-12) and 48 u out
					const face = along ? (ny > 0 ? o.y + o.h : o.y) : nx > 0 ? o.x + o.w : o.x;
					const passage = along
						? { x: o.x + 20, w: o.w - 40, y: ny > 0 ? o.y - 72 : o.y - 48, h: o.h + 120 }
						: { y: o.y + 20, h: o.h - 40, x: nx > 0 ? o.x - 72 : o.x - 48, w: o.w + 120 };
					const stoop = bodyOf(plan.outside[0]);
					const near = along ? (ny > 0 ? stoop.y : stoop.y + stoop.h) : nx > 0 ? stoop.x : stoop.x + stoop.w;
					const depth = along ? stoop.h : stoop.w;
					if (Math.abs(near - face) > 0.01 || depth > 56 || !plan.outside[0].key.startsWith("stoop:"))
						if (stat.stoopOff.length < 5) stat.stoopOff.push(`${plan.outside[0].key} ${near} vs ${face}`);
					// the lintel lies on the roof, inside the footprint: never over the street (LEG-03)
					const l = plan.lintel;
					const corners = [
						[l.x + 0.5, l.y + 0.5],
						[l.x + l.w - 0.5, l.y + 0.5],
						[l.x + 0.5, l.y + l.h - 0.5],
						[l.x + l.w - 0.5, l.y + l.h - 0.5],
					];
					if (!corners.every(([x, y]) => insideBuilding(b, x, y)) && stat.roofOff.length < 5)
						stat.roofOff.push(`${l.key} of #${b.id}`);
					const frame = plan.inside[0];
					if (!frame.key.startsWith("frame:") || !hitsRect(bodyOf(frame), o)) stat.frameOff.push(frame.key);
					let leaves = 0;
					for (const list of [plan.outside, plan.inside]) {
						for (const p of list) {
							if (p.key.startsWith("fallen:")) stat.torn++;
							if (p.key.startsWith("boards:")) stat.boarded++;
							if (!p.key.startsWith("leaf:")) continue;
							leaves++;
							const mode = p.key.split(":")[2];
							stat.modes[mode]++;
							if (p.key.startsWith("leaf:glass") && p.key.endsWith(":1")) stat.shattered++;
							const r = bodyOf(p);
							// the gap stays open: no leaf across the passage (a torn-off door lies on the ground: floor)
							if (hitsRect(r, passage) && stat.passage.length < 5)
								stat.passage.push(`${p.key} of #${b.id}`);
							// and a leaf rests where nothing is: inside, none of the building's furniture, partitions or
							// windows; outside, nothing of the town
							const inside = mode !== "outFlat";
							for (const s of querySolids(w, r.x, r.y, r.x + r.w, r.y + r.h)) {
								if (s === b || s.kind === "canopy" || s.kind === "building") continue;
								if (inside && s.parentId !== b.id) continue;
								if (hitsRect(r, s) && stat.overlap.length < 5)
									stat.overlap.push(`${p.key} on ${s.tags}`);
							}
						}
					}
					// a single door has one leaf, a double door two (a torn-off door lies on the step: one fewer)
					const perKind = {};
					for (const list of [plan.outside, plan.inside]) {
						for (const p of list) {
							if (!p.key.startsWith("leaf:")) continue;
							const kind = p.key.split(":")[1];
							(perKind[kind] ??= []).push(p.key.split(":")[3]);
						}
					}
					for (const [kind, hands] of Object.entries(perKind)) {
						const single = SINGLE[kind] === true;
						const bad = single
							? hands.length > 1
							: hands.length > 2 || [...new Set(hands)].length !== hands.length;
						if (bad && stat.leafCount.length < 5)
							stat.leafCount.push(
								`${kind} x${hands.length} (${single ? "single" : "double"}) at #${b.id}`,
							);
						if (single) stat.singles++;
						else stat.doubles++;
					}
					const want =
						style.leaves.reduce((n, l) => n + (SINGLE[l.kind] === true ? 1 : 2), 0) -
						(plan.outside.some(p => p.key.startsWith("fallen:")) ? 1 : 0);
					stat.modes.none += Math.max(0, want - leaves);
					stat.worst.out = Math.max(stat.worst.out, plan.outside.length);
					stat.worst.inside = Math.max(stat.worst.inside, plan.inside.length);
				}
			}
		}
		check(
			stat.missing.length === 0,
			`every doorway of ${seeds.length} towns has its entrance in the atlas (${stat.planned} of ${stat.doors}, ${[...stat.styles].length} styles)`,
			stat.missing.join("; "),
		);
		check(
			stat.stoopOff.length === 0,
			"each stoop starts at the wall's outside face and lies at most 56 u out",
			stat.stoopOff.join("; "),
		);
		check(
			stat.roofOff.length === 0,
			"each lintel lies on the roof, inside the footprint: nothing of it over the street (LEG-03)",
			stat.roofOff.join("; "),
		);
		check(stat.frameOff.length === 0, "each frame lies across its gap", stat.frameOff.slice(0, 4).join("; "));
		check(
			stat.leafCount.length === 0 && stat.singles > 0 && stat.doubles > 0,
			"a single door (a house's, the gas station's, a service door) draws exactly one leaf, a double door (ESC-02) at most its two",
			stat.leafCount.join("; ") || `${stat.singles} single doors, ${stat.doubles} double doors drawn`,
		);
		check(
			stat.passage.length === 0,
			"the gap stays open (EDI-09): no leaf stands in the passage, 72 u in and 48 u out",
			stat.passage.join("; "),
		);
		check(
			stat.overlap.length === 0,
			"a leaf rests where nothing stands: no furniture, partition, window or solid of the town under it",
			stat.overlap.join("; "),
		);
		const m = stat.modes;
		const leafTotal = m.outFlat + m.inFlat + m.inSquare + m.none;
		console.log(
			`       leaves: ${m.outFlat} pinned outside, ${m.inFlat} pinned inside, ${m.inSquare} square inside, ${m.none} with nowhere free (${leafTotal})`,
		);
		// pinned flat where the wall beside the gap is free (a house's front wall mostly holds the sofa or the TV beside
		// its door, a back door stands by a corner: that leaf swings square instead, as a real one would stop there)
		check(
			m.outFlat + m.inFlat >= leafTotal * 0.25 && m.none <= leafTotal * 0.01,
			"every leaf rests somewhere (pinned flat against a wall where it is free, else square at its jamb)",
			`${Math.round(((m.outFlat + m.inFlat) / leafTotal) * 100)} % flat, ${((m.none / leafTotal) * 100).toFixed(1)} % nowhere`,
		);
		check(
			stat.torn > 0 && stat.boarded > 0 && stat.torn + stat.boarded <= stat.houseDoors * 0.15,
			"a few house doors are torn off or were boarded up and broken through (APO-01), never many",
			`${stat.torn} torn, ${stat.boarded} boarded of ${stat.houseDoors} house doors; ${stat.shattered} shop leaves shattered`,
		);
		check(
			stat.worst.out <= 4 && stat.worst.inside <= 3,
			"a doorway costs at most 4 sprites on the ground, 1 on the roof and 3 inside (the stoop, two leaves, one wear)",
			`${stat.worst.out} / 1 / ${stat.worst.inside}`,
		);
		// --- every side its own bake: the light never turns with the door (ART-02). A cell's four sides are not one
		// picture turned: the "top" cell turned half round is not the "bottom" one
		{
			const img = decodePNG(readFileSync(join(ART_DIR, "entrances.png")));
			const pix = (c, x, y) => {
				const i = ((c[1] + y) * img.w + c[0] + x) * 4;
				return (img.data[i] << 24) | (img.data[i + 1] << 16) | (img.data[i + 2] << 8) | img.data[i + 3];
			};
			let families = 0;
			let turned = [];
			for (const key of Object.keys(ENTRANCE_CELLS)) {
				if (!key.includes(":bottom")) continue;
				const top = ENTRANCE_CELLS[key.replace(":bottom", ":top")];
				const bot = ENTRANCE_CELLS[key];
				if (top === undefined) continue;
				families++;
				const [, , w, h, , , sh] = bot;
				if (top[2] !== w || top[3] !== h) continue;
				let same = true;
				for (let y = 0; y < h - sh && same; y++) {
					for (let x = 0; x < w - sh && same; x++) {
						if (pix(bot, x, y) !== pix(top, w - sh - 1 - x, h - sh - 1 - y)) same = false;
					}
				}
				// a cell symmetric under the turn and flat-lit could be the same; one that shades is not
				if (same && !key.startsWith("frame:")) turned.push(key);
			}
			check(
				turned.length <= families * 0.02,
				`each side is its own bake (${families} cells looking down, their "top" never merely turned)`,
				turned.slice(0, 4).join("; "),
			);
		}
		setArt({});
	}
}

// ================================================================ 16. the trees (VEG-06)

section(
	"16) the trees (VEG-06): kinds and looks in one atlas, the light never turns, a cell a sprite, shrubs underfoot",
);
{
	const TD = require(join(SRC, "shared/data/trees.ts"));
	const TA = require(join(SRC, "client/view/treeAtlas.ts"));
	const { TOWN } = require(join(SRC, "shared/engine/constants.ts"));
	const SPECIES = TD.TREE_SPECIES;
	const tex = ALL.manifest.textures.find(t => t.name === "trees");
	const img = decodePNG(readFileSync(join(ART_DIR, "trees.png")));
	const at = (x, y) => img.data.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 4);

	// --- the atlas: one greyscale image, every kind in its looks, every cell its own drawing
	let grey = true;
	for (let i = 0; i < img.w * img.h; i++) {
		const [r, g, b, a] = img.data.subarray(i * 4, i * 4 + 4);
		if (a > 0 && (r !== g || g !== b)) grey = false;
	}
	check(
		tex?.kind === "atlas" && img.w === TA.TREE_ATLAS_W && img.h === TA.TREE_ATLAS_H && grey,
		"trees.png is one greyscale atlas (tinted with each tree's green, ART-03), the size treeAtlas.ts says",
		`${img.w} x ${img.h}, ${tex?.kind}`,
	);
	const cells = [];
	const badCells = [];
	SPECIES.forEach((sp, k) => {
		const list = TA.TREE_CELLS[k] ?? [];
		if (list.length !== sp.looks) badCells.push(`${sp.name}: ${list.length} cells for ${sp.looks} looks`);
		list.forEach(([x, y, n], look) => {
			if (n !== sp.box || x + n > img.w || y + n > TA.TREE_BAND_H) badCells.push(`${sp.name} ${look}`);
			cells.push({ sp, k, look, x, y, n });
		});
	});
	const [tx, ty, tn] = TA.TREE_TRUNK_CELL;
	cells.forEach((a, i) =>
		cells.slice(i + 1).forEach(b => {
			if (a.x < b.x + b.n && b.x < a.x + a.n && a.y < b.y + b.n && b.y < a.y + a.n)
				badCells.push(`${a.sp.name} ${a.look} over ${b.sp.name} ${b.look}`);
		}),
	);
	check(
		badCells.length === 0,
		`every kind has its looks (${cells.length} crowns of ${SPECIES.length} kinds), each a square of its kind's size, none over another`,
		badCells.slice(0, 3).join("; "),
	);
	check(
		tn * 4 === TOWN.TREE_TRUNK,
		"the trunk's cell is the 44 u trunk at 4 u a texel: what stops a body is what is drawn (COL-01)",
		`${tn} texels`,
	);
	/** a cell's silhouette as a string of 0/1, and turned (q quarter turns) and mirrored */
	const shape = (c, q = 0, flip = false) => {
		let out = "";
		for (let y = 0; y < c.n; y++) {
			for (let x = 0; x < c.n; x++) {
				let u = flip ? c.n - 1 - x : x;
				let v = y;
				for (let i = 0; i < q; i++) [u, v] = [c.n - 1 - v, u];
				out += at(c.x + u, c.y + v)[3] > 0 ? "1" : "0";
			}
		}
		return out;
	};
	const copies = [];
	cells.forEach((a, i) =>
		cells.slice(i + 1).forEach(b => {
			if (a.n !== b.n) return;
			const sb = shape(b);
			for (let q = 0; q < 4; q++)
				for (const flip of [false, true])
					if (shape(a, q, flip) === sb) copies.push(`${a.sp.name} ${a.look} ~ ${b.sp.name} ${b.look}`);
		}),
	);
	check(
		copies.length === 0,
		"no crown is another turned or mirrored: every look is its own drawing",
		copies.slice(0, 3).join("; "),
	);

	// --- the light never turns (ART-02): in every crown, of two texels side by side the left one is the lighter more
	// often than the right, and of two one above the other the upper one -- a mirrored crown fails the first, a turned
	// one at least one (the texel as drawn: the mask's grey under its light and outline)
	const turned = [];
	let worst = Infinity;
	for (const c of cells) {
		const lum = (x, y) => {
			const m = at(c.x + x, c.y + y);
			if (m[3] === 0) return undefined;
			const o = at(c.x + x, TA.TREE_BAND_H + c.y + y);
			const a = o[3] / 255;
			return m[0] * (1 - a) + o[0] * a;
		};
		const h = [0, 0];
		const v = [0, 0];
		for (let y = 0; y < c.n; y++) {
			for (let x = 0; x < c.n; x++) {
				const l = lum(x, y);
				if (l === undefined) continue;
				const r = x + 1 < c.n ? lum(x + 1, y) : undefined;
				const d = y + 1 < c.n ? lum(x, y + 1) : undefined;
				if (r !== undefined && l !== r) h[l > r ? 0 : 1]++;
				if (d !== undefined && l !== d) v[l > d ? 0 : 1]++;
			}
		}
		const ratio = Math.min(h[0] / Math.max(1, h[1]), v[0] / Math.max(1, v[1]));
		worst = Math.min(worst, ratio);
		if (ratio <= 1)
			turned.push(
				`${c.sp.name} ${c.look} (${(h[0] / Math.max(1, h[1])).toFixed(2)}, ${(v[0] / Math.max(1, v[1])).toFixed(2)})`,
			);
	}
	check(
		turned.length === 0,
		"every crown is lit from the top left in every look: lighter to the left and above, texel by texel (never turned after lighting)",
		turned.slice(0, 3).join("; ") || `the least: ${worst.toFixed(2)} x as often`,
	);

	// --- the drawing: one tree of each kind, drawn alone, with the atlas live
	const byKind = SPECIES.map((_, k) => world.solids.find(s => s.kind === "tree" && TD.treeSpecies(s.variant) === k));
	check(
		byKind.every(s => s !== undefined),
		"the town grows every kind",
		SPECIES.filter((_, k) => byKind[k] === undefined)
			.map(s => s.name)
			.join(", "),
	);
	const drawn = [];
	const cost = [];
	for (const [label, ids] of [
		["art", ALL.ids],
		["no tree atlas", Object.fromEntries(Object.entries(ALL.ids).filter(([n]) => n !== "trees"))],
	]) {
		setArt(ids);
		byKind.forEach((s, k) => {
			if (s === undefined) return;
			const st = stage(800, 800, 1);
			const view = new WorldView(shadowFn(false));
			const cx = s.x + s.w / 2;
			const cy = s.y + s.h / 2;
			st.cam.x = cx;
			st.cam.y = cy;
			const v = st.cam.viewRect(32);
			for (const alpha of [1, 0.35]) {
				s.canopyAlpha = alpha;
				st.r.beginFrame();
				if (!view.drawTreeArt(st.r, st.cam, s, v)) view.drawTree(st.r, st.cam, s, v);
				st.r.endFrame();
				const frames = st.r.layer.GetChildren().filter(f => f.Visible !== false);
				const images = frames
					.map(f => ({
						f,
						l: f.GetChildren().find(q => q.ClassName === "ImageLabel" && q.Visible !== false),
					}))
					.filter(q => q.l !== undefined);
				if (label !== "art") {
					if (images.length > 0) drawn.push(`${SPECIES[k].name}: an image without its atlas`);
					continue;
				}
				cost.push(`${SPECIES[k].name} ${frames.length}`);
				const sp = SPECIES[k];
				const [x, y, n] = TA.TREE_CELLS[k][TD.treeLook(s.variant)];
				const d = s.canopyR * 2;
				const crown = images.find(
					q => q.l.ImageRectOffset.X === x && q.l.ImageRectOffset.Y === y && q.f.ZIndex !== Z.shadow,
				);
				const shade = images.find(q => q.l.ImageRectOffset.Y === y + TA.TREE_BAND_H);
				const trunk = images.find(
					q =>
						q.l.ImageRectOffset.X === TA.TREE_TRUNK_CELL[0] &&
						q.l.ImageRectOffset.Y === TA.TREE_TRUNK_CELL[1],
				);
				const bad = [];
				if (frames.length !== (sp.low ? 3 : 4)) bad.push(`${frames.length} sprites`);
				if (frames.some(f => Math.abs(f.Rotation) > 1e-9)) bad.push("a turned sprite");
				if (crown === undefined || shade === undefined) bad.push("no crown or light");
				else {
					if (crown.l.ImageRectOffset.X !== x || crown.l.ImageRectSize.X !== n) bad.push("not its cell");
					if (Math.abs(crown.f.Size.X.Offset - d) > 1) bad.push(`crown ${crown.f.Size.X.Offset} for ${d}`);
					// a shrub under every body and never see-through; a crown over them, see-through with a body under it
					if (sp.low && crown.f.ZIndex >= Z.zombie) bad.push("a shrub over the bodies");
					if (!sp.low && crown.f.ZIndex !== Z.canopy) bad.push("a crown under the roofs");
					const want = sp.low ? 0 : 1 - alpha;
					if (Math.abs(crown.l.ImageTransparency - want) > 1e-6)
						bad.push(`transparency ${crown.l.ImageTransparency}`);
				}
				if (sp.low !== (trunk === undefined)) bad.push(sp.low ? "a shrub with a trunk" : "no trunk");
				else if (trunk !== undefined && (trunk.f.Size.X.Offset !== s.w || trunk.f.ZIndex !== Z.structure))
					bad.push("the trunk not its 44 u box");
				if (bad.length > 0) drawn.push(`${sp.name} at ${alpha}: ${bad.join(", ")}`);
			}
			s.canopyAlpha = 1;
		});
	}
	setArt({});
	check(
		drawn.length === 0,
		"a tree is its cell at its size, never turned: 4 sprites (shadow, trunk, crown, light), a shrub 3 under the bodies; without the atlas, the flat tree",
		drawn.slice(0, 3).join("; ") || cost.slice(0, SPECIES.length).join(", "),
	);

	// --- what collides is what always did: every kind stands on the same 44 u trunk (the horde's flow field, COL-01)
	const trunks = world.solids.filter(s => s.kind === "tree");
	check(
		trunks.every(s => s.w === TOWN.TREE_TRUNK && s.h === TOWN.TREE_TRUNK && s.hp === 100 && s.destructible),
		"every tree, whatever its kind, is the same 44 u trunk to a body, a bullet and the flow field",
		`${trunks.length} trees`,
	);
}

console.log(failures === 0 ? "\nworld-art: all checks passed" : `\nworld-art: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
