#!/usr/bin/env node
/*
 * Ground items on every ground, by day and by night, flat and with the art: the REAL client/view/groundItemsView.ts
 * drawn onto the fake GUI tree (tools/fake-gui.mjs) and rasterised (tools/gui-raster.mjs), exactly as
 * tools/render-map.mjs draws the town. Nothing is re-implemented: if the drawing code changes, the picture changes.
 *
 *   node tools/render-ground-items.mjs --out <dir>                      # the whole set
 *   node tools/render-ground-items.mjs --out <dir> --src <checkout>/src  # another checkout's code (the "before")
 *
 * The set (docs/DESIGN_RULES.md ITM-06):
 *   grounds-day-flat.png   grounds-day-art.png      one row per ground (grass, asphalt, concrete, pavers, dirt, the
 *   grounds-night-flat.png grounds-night-art.png    interior floors...), an item of every kind across it; at night a
 *                                                   survivor's light on the left of each row, the dark on the right
 *   town-day.png town-night.png                     a real street of the town (client/view/worldView.ts): a car's
 *                                                   spill, a zombie's drop, a boss's trophies on one spot, and the
 *                                                   survivor with three items in reach
 *   zoom-*.png                                      the same, 3x, around the survivor (what E takes) and the pile
 *   drop.png                                        a drop's first frames, 1/30 s apart (and with Reduce Motion)
 *
 * With `--art` (default design/world-art) the art rows hand the view "local:<name>" ids, read back from the PNGs, so
 * the pictures show the art before (or without) an upload -- the item icons' atlas included.
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
if (opt("src") !== undefined) process.env.PZ_SRC = resolve(opt("src"));
const { installShims, ROOT } = await import("./luau-shim.mjs");
const { SRC, require } = installShims({ seed: 1 });
const { installFakeGui } = await import("./fake-gui.mjs");
const gui = installFakeGui();

if (opt("out") === undefined) {
	console.error("usage: node tools/render-ground-items.mjs --out <dir> [--src <checkout>/src] [--art <dir>]");
	process.exit(2);
}
// (docs/art/ground-items keeps a chosen few of these, before and after: DESIGN_RULES ITM-06)
const OUT = resolve(opt("out"));
const ART_DIR = resolve(opt("art") ?? join(ROOT, "design", "world-art"));
mkdirSync(OUT, { recursive: true });

const { COLORS, Z } = require(join(SRC, "shared/engine/colors.ts"));
const { Camera } = require(join(SRC, "shared/engine/camera.ts"));
const { Renderer, LightMap } = require(join(SRC, "shared/engine/renderer.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const W = require(join(SRC, "shared/game/world.ts"));
const { darkAlphaAt } = require(join(SRC, "shared/sim/clock.ts"));
const { WorldView } = require(join(SRC, "client/view/worldView.ts"));
const SV = require(join(SRC, "client/view/survivorView.ts"));
const HV = require(join(SRC, "client/view/humanoidView.ts"));
const { GroundItemsView } = require(join(SRC, "client/view/groundItemsView.ts"));
const worldArt = require(join(SRC, "client/view/worldArt.ts"));

// ---------------------------------------------------------------- art ids: "local:<name>" read back from ART_DIR

const LOCAL = "local:";
const manifest = JSON.parse(readFileSync(join(ART_DIR, "manifest.json"), "utf8"));
const images = new Map();
function localImage(id) {
	if (images.has(id)) return images.get(id);
	const file = id.startsWith(LOCAL) ? join(ART_DIR, `${id.slice(LOCAL.length)}.png`) : undefined;
	const img = file !== undefined && existsSync(file) ? decodePNG(readFileSync(file)) : undefined;
	images.set(id, img);
	return img;
}
function useArt(on) {
	if (!on) {
		worldArt.overrideWorldArt({});
		return;
	}
	const ids = {};
	for (const t of manifest.textures) ids[t.name] = LOCAL + t.name;
	worldArt.overrideWorldArt(ids);
}

// ---------------------------------------------------------------- what lies on the ground

/** [kind, id, count, label]: an item of every kind a table, a zombie or a boss can drop (cosmetics never drop) */
const ITEMS = [
	[1, 0, 1, "Dagger"],
	[1, 2, 1, "Axe"],
	[1, 6, 1, "Bat"],
	[1, 10, 1, "Pistol"],
	[1, 14, 1, "AK-40"],
	[1, 16, 1, "Shotgun"],
	[1, 22, 1, "Bow"],
	[2, 4, 1, "Steel armor"],
	[2, 13, 1, "Flashlight"],
	[4, 44, 12, "Ammo"],
	[4, 45, 8, "Shells"],
	[4, 47, 5, "Arrows"],
	[4, 48, 10, "Oil"],
	[3, 12, 1, "Bandage"],
	[3, 5, 1, "First aid"],
	[3, 17, 1, "Apple"],
	[3, 9, 1, "Canned"],
	[3, 0, 1, "Raw meat"],
	[4, 23, 3, "Wood"],
	[4, 24, 2, "Stone"],
	[4, 26, 1, "Steel"],
	[4, 34, 1, "Cloth"],
	[4, 41, 1, "Leather"],
	[4, 33, 2, "Gunpowder"],
	[4, 30, 1, "Parts"],
	[4, 14, 1, "Campfire kit"],
];

const WHITE = COLORS.white;
const BLACK = COLORS.shadow;
const rgbOf = (r, g, b) => Color3.fromRGB(r, g, b);
/** client/view/worldView.ts GROUND and its tints, spelled the same way */
const G = {
	plaza: COLORS.sidewalk.Lerp(WHITE, 0.1),
	walk: COLORS.sidewalk.Lerp(WHITE, 0.16),
	apron: COLORS.sidewalk.Lerp(COLORS.road, 0.3),
	parking: COLORS.road.Lerp(COLORS.sidewalk, 0.14),
	playground: COLORS.dirtPath.Lerp(WHITE, 0.25),
};
const PARK_TINT = rgbOf(228, 246, 231);
const PATH_TINT = rgbOf(211, 198, 172);
const CONCRETE_FLOOR_TINT = rgbOf(214, 214, 212);
/** [label, flat colour, texture, tint]: every ground an item can land on */
const GROUNDS = [
	["Grass", COLORS.grass, "grass"],
	["Long grass", COLORS.grass, "grassLong"],
	["Park grass", COLORS.parkGrass, "grass", PARK_TINT],
	["Asphalt", COLORS.road, "asphalt"],
	["Parking lot", G.parking, "asphaltLot"],
	["Sidewalk", COLORS.sidewalk, "concrete"],
	["Plaza pavers", G.plaza, "plaza"],
	["Walk pavers", G.walk, "pavers"],
	["Gas apron", G.apron, "apron"],
	["Dirt path", COLORS.dirtPath, "dirt", PATH_TINT],
	["Playground", G.playground, "dirt"],
	["Wood floor", COLORS.floorWood, "floorWood"],
	["Tile floor", COLORS.floorTile, "floorTile"],
	["Shop floor", COLORS.floorShop, "floorShop"],
	["Carpet", COLORS.floorCarpet, "floorCarpet"],
	["Kitchen", COLORS.floorKitchen, "floorKitchen"],
	["Bathroom", COLORS.floorBath, "floorBath"],
	["Back room", COLORS.floorConcrete, "concrete", CONCRETE_FLOOR_TINT],
];

let nextId = 1000;
function item(kind, itemId, count, x, y, vx = 0, vy = 0) {
	nextId += 1;
	return { id: nextId, kind, itemId, count, x, y, vx, vy };
}

// ---------------------------------------------------------------- a stage

function stage(vw, vh, cx, cy, zoom = 1) {
	const root = gui.make("Frame");
	root.Size = UDim2.fromOffset(vw, vh);
	const renderer = new Renderer(root, "Sprites");
	renderer.setView(vw, vh);
	const dark = gui.make("Frame");
	dark.Parent = root;
	dark.BackgroundTransparency = 1;
	const cam = new Camera();
	cam.setView(vw, vh);
	cam.zoom = zoom;
	cam.x = cx;
	cam.y = cy;
	return { root, renderer, dark, cam, vw, vh };
}

/** the loop's shadow rule (GameLoop.shadowOffset): the sun by day, away from the survivor's light at night */
function shadowRule(state) {
	const out = { x: 0, y: 0 };
	return (x, y, len) => {
		if (state.night) {
			const dx = x - state.lx;
			const dy = y - state.ly;
			const d = Math.hypot(dx, dy);
			if (d < 1) {
				out.x = 0;
				out.y = len * 0.5;
			} else {
				out.x = (dx / d) * len;
				out.y = (dy / d) * len;
			}
			return out;
		}
		out.x = 0.7 * len;
		out.y = 0.7 * len;
		return out;
	};
}

/** one frame of the items view; `set` lets a newer view be told what E takes, Reduce Motion... (older ones ignore it) */
function drawItems(view, st, items, clock, set = {}) {
	for (const [k, v] of Object.entries(set)) view[k] = v;
	view.draw(st.renderer, st.cam, st.cam.viewRect(32), items, clock, 1 / 30);
}

function raster(st) {
	return rasterise({ layer: st.renderer.layer, dark: st.dark, vw: st.vw, vh: st.vh }, COLORS.bg, localImage);
}

function blit(dst, src, ox, oy) {
	for (let y = 0; y < src.h; y++) {
		const yy = oy + y;
		if (yy < 0 || yy >= dst.h) continue;
		for (let x = 0; x < src.w; x++) {
			const xx = ox + x;
			if (xx < 0 || xx >= dst.w) continue;
			const s = (y * src.w + x) * 4;
			const d = (yy * dst.w + xx) * 4;
			dst.data[d] = src.data[s];
			dst.data[d + 1] = src.data[s + 1];
			dst.data[d + 2] = src.data[s + 2];
			dst.data[d + 3] = 255;
		}
	}
}

function canvas(w, h, rgb = [24, 24, 28]) {
	const img = { w, h, data: Buffer.alloc(w * h * 4) };
	for (let i = 0; i < w * h; i++) {
		img.data[i * 4] = rgb[0];
		img.data[i * 4 + 1] = rgb[1];
		img.data[i * 4 + 2] = rgb[2];
		img.data[i * 4 + 3] = 255;
	}
	return img;
}

function save(name, img) {
	writeFileSync(join(OUT, name), encodePNG(img, true));
	console.log(`  ${name.padEnd(26)} ${img.w}x${img.h}`);
}

// ---------------------------------------------------------------- 1. every item on every ground

const PITCH = 58;
const ROW_H = 76;
const LABEL_W = 132;

function groundRow(ground, night, art) {
	const [, flat, tex, tint] = ground;
	const vw = ITEMS.length * PITCH + 40;
	const vh = ROW_H;
	// a place of its own in the world, so every item's id-based tilt and glint phase is the same on every row
	const cx = 4000 + vw / 2;
	const cy = 4000;
	const st = stage(vw, vh, cx, cy);
	const x0 = cx - vw / 2;
	const light = { night, lx: x0 + 20 + PITCH * 3, ly: cy };
	const view = new GroundItemsView(shadowRule(light));
	st.renderer.beginFrame();
	const id = art ? worldArt.artId(tex) : undefined;
	if (id !== undefined) {
		const size = worldArt.artSize(tex);
		st.renderer.drawRect(st.cam, cx, cy, {
			w: vw,
			h: vh,
			zIndex: Z.ground,
			image: id,
			imageTint: tint,
			scaleType: "tile",
			tileW: size.w * 4,
			tileH: size.h * 4,
		});
	} else {
		st.renderer.drawRect(st.cam, cx, cy, { w: vw, h: vh, color: flat, zIndex: Z.ground });
	}
	nextId = 1000;
	const items = ITEMS.map(([kind, itemId, count], i) => item(kind, itemId, count, x0 + 20 + PITCH * (i + 0.5), cy));
	// the clock where no glint is lit (the still picture) -- the glint has its own image
	drawItems(view, st, items, 1.3);
	st.renderer.endFrame();
	if (night) {
		const lm = new LightMap(st.dark, COLORS.overlayNight);
		lm.update(st.cam, darkAlphaAt(22, false, false), [{ x: light.lx, y: light.ly, r: 250, inner: 0.4 }]);
	}
	return raster(st);
}

function groundsSheet(night, art) {
	useArt(art);
	const rows = GROUNDS.map(g => groundRow(g, night, art));
	const w = LABEL_W + rows[0].w + 8;
	const head = 34;
	const img = canvas(w, head + rows.length * (ROW_H + 4));
	const title = `${night ? "22:00, the survivor's light on the left" : "Day"} - ${art ? "art" : "flat"}`;
	drawText(img, title, 8, 10, 2, [235, 235, 235]);
	rows.forEach((row, i) => {
		const y = head + i * (ROW_H + 4);
		drawText(img, GROUNDS[i][0], 6, y + ROW_H / 2 - 4, 1, [220, 220, 220]);
		blit(img, row, LABEL_W, y);
	});
	// the item names over the first row, once
	ITEMS.forEach(([, , , label], i) => {
		if (i % 2 === 0) drawText(img, label.slice(0, 9), LABEL_W + 4 + PITCH * i, head - 12, 1, [170, 170, 170]);
	});
	return img;
}

console.log(`render-ground-items: src ${SRC}, art ${ART_DIR}`);
for (const night of [false, true]) {
	for (const art of [false, true]) {
		save(`grounds-${night ? "night" : "day"}-${art ? "art" : "flat"}.png`, groundsSheet(night, art));
	}
}

// ---------------------------------------------------------------- 2. a real street

const town = W.generateTown(DESIGN.TOWN_SEED);

/** where the street scene's pieces go, relative to a point on a road's top kerb (x along it, y = the kerb) */
const SCENE = {
	survivor: [-120, -64],
	// in reach of the survivor: three items within E's 40 u, the nearest a shotgun
	reach: [
		[1, 16, 1, 28, 10],
		[4, 45, 8, -30, 16],
		[3, 12, 1, 4, -34],
	],
	// a walker's drop on the lawn: rotten meat and a round of the general table
	lawn: [
		[3, 19, 1, 170, -230],
		[4, 44, 12, 196, -212],
	],
	// a car's spill on the asphalt (server/sim/items.ts spill)
	road: [
		[4, 26, 1, 130, 70],
		[4, 48, 10, 170, 96],
	],
	// a boss's trophies and rolls on ONE spot (shared/sim/ai/bossBrain.ts): the pile
	pile: [
		[1, 25, 1, -330, 150],
		[4, 36, 3, -330, 150],
		[4, 43, 3, -330, 150],
		[4, 23, 3, -326, 153],
		[3, 9, 1, -333, 147],
		[4, 44, 20, -328, 149],
	],
};

/** a residential street mid-block: the kerb point (x, y) with lawn above, nothing solid where the scene goes */
function findStreet() {
	const free = (x, y) => W.pointInSolid(town, x, y, 24) === undefined && W.buildingAt(town, x, y) === undefined;
	for (const road of town.roads) {
		if (road.avenue || road.vertical) continue;
		for (let t = road.x + 700; t < road.x + road.w - 700; t += 64) {
			const lot = town.lots.find(
				l => t >= l.x && t < l.x + l.w && road.y - 300 >= l.y && road.y - 300 < l.y + l.h,
			);
			if (lot === undefined || lot.zone !== "residential" || lot.kind !== "block") continue;
			const all = [
				SCENE.survivor,
				...[...SCENE.reach, ...SCENE.lawn, ...SCENE.road, ...SCENE.pile].map(e => [e[3], e[4]]),
			];
			if (!all.every(([dx, dy]) => free(t + dx, road.y + dy))) continue;
			// mid-block (no crossing in the picture) and no canopy over the survivor or the pile
			const view = { x0: t - 540, x1: t + 540, y0: road.y - 340, y1: road.y + 260 };
			if (town.junctions.some(j => j.x < view.x1 && j.x + j.w > view.x0 && j.y < view.y1 && j.y + j.h > view.y0))
				continue;
			const canopyOver = (x, y) =>
				town.solids.some(
					s => s.kind === "tree" && Math.hypot(s.x + s.w / 2 - x, s.y + s.h / 2 - y) < (s.canopyR ?? 80) + 30,
				);
			const sx = t + SCENE.survivor[0];
			const sy = road.y + SCENE.survivor[1];
			if (canopyOver(sx, sy) || canopyOver(t + SCENE.pile[0][3], road.y + SCENE.pile[0][4])) continue;
			return { x: t, y: road.y };
		}
	}
	throw new Error("no residential street");
}

function townScene(night, art, zoomAt) {
	useArt(art);
	const k = findStreet();
	const cx = k.x;
	const cy = k.y - 40;
	const survivor = { x: k.x + SCENE.survivor[0], y: k.y + SCENE.survivor[1] };
	nextId = 5000;
	const items = [];
	for (const e of SCENE.reach) items.push(item(e[0], e[1], e[2], survivor.x + e[3], survivor.y + e[4]));
	for (const e of [...SCENE.lawn, ...SCENE.road, ...SCENE.pile])
		items.push(item(e[0], e[1], e[2], k.x + e[3], k.y + e[4]));
	const vw = 1024;
	const vh = 576;
	const zoom = zoomAt !== undefined ? 3 : 1;
	const at = zoomAt ?? { x: cx, y: cy };
	const st = stage(zoomAt !== undefined ? 360 : vw, zoomAt !== undefined ? 240 : vh, at.x, at.y, zoom);
	const light = { night, lx: survivor.x, ly: survivor.y };
	const shadow = shadowRule(light);
	const view = new WorldView(shadow);
	view.clock = 0;
	for (const s of town.solids) if (s.kind === "tree") s.canopyAlpha = 1;
	const v = st.cam.viewRect(32);
	st.renderer.beginFrame();
	view.drawGround(st.renderer, st.cam, v, town);
	const itemsView = new GroundItemsView(shadow);
	// what E takes: the nearest item in reach (shared/sim/interactQuery.ts nearestGroundItem)
	const target = items.reduce((best, it) => {
		const d = Math.hypot(it.x - survivor.x, it.y - survivor.y);
		return d < 40 && (best === undefined || d < best.d) ? { it, d } : best;
	}, undefined);
	drawItems(itemsView, st, items, 1.3, { target: target?.it.id ?? -1 });
	view.drawSolids(st.renderer, st.cam, v, town);
	const look = SV.createLook();
	look.x = survivor.x;
	look.y = survivor.y;
	look.angle = 0.3;
	const so = shadow(look.x, look.y, 10);
	look.shadowX = so.x;
	look.shadowY = so.y;
	SV.drawSurvivor(st.renderer, st.cam, look, SV.createSwingTrail());
	// a walker further down the street, for scale
	const zx = cx + 330;
	const zy = cy + 10;
	HV.drawHumanoid(st.renderer, st.cam, zx, zy, Math.PI, 16 / 18, HV.zombieColor(1), 0, 1, 0.8, Z.zombie);
	st.renderer.endFrame();
	if (night) {
		const lm = new LightMap(st.dark, COLORS.overlayNight);
		lm.update(st.cam, darkAlphaAt(22, false, false), [{ x: survivor.x, y: survivor.y, r: 250, inner: 0.4 }]);
	}
	const img = raster(st);
	return { img, survivor, pile: { x: k.x + SCENE.pile[0][3], y: k.y + SCENE.pile[0][4] } };
}

for (const night of [false, true]) {
	save(`town-${night ? "night" : "day"}.png`, townScene(night, true).img);
}
const flatDay = townScene(false, false);
save("town-day-flat.png", flatDay.img);
save("zoom-reach.png", townScene(false, true, flatDay.survivor).img);
save("zoom-pile.png", townScene(false, true, flatDay.pile).img);
save("zoom-reach-night.png", townScene(true, true, flatDay.survivor).img);

// ---------------------------------------------------------------- 3. a drop: its first frames

function dropStrip(reduce, art) {
	useArt(art);
	const frames = [];
	const view = new GroundItemsView(shadowRule({ night: false }));
	nextId = 9000;
	const fresh = [item(1, 16, 1, 7000, 7000, 120, -40), item(4, 45, 8, 7040, 7004, -60, 90)];
	for (let f = 0; f < 10; f++) {
		const st = stage(160, 110, 7020, 7010, 2);
		st.renderer.beginFrame();
		st.renderer.drawRect(st.cam, 7020, 7010, { w: 200, h: 200, color: COLORS.sidewalk, zIndex: Z.ground });
		drawItems(view, st, fresh, 1.3 + f / 30, { reduceMotion: reduce });
		st.renderer.endFrame();
		frames.push(raster(st));
		// the items slide like shared/game/world.ts updateGroundItems, 1/30 s a frame
		for (const it of fresh) {
			for (let k = 0; k < 2; k++) {
				it.x += it.vx / 60;
				it.y += it.vy / 60;
				it.vx *= 0.9;
				it.vy *= 0.9;
				if (it.vx * it.vx + it.vy * it.vy < 1) {
					it.vx = 0;
					it.vy = 0;
				}
			}
		}
	}
	const img = canvas(frames.length * 164 + 4, 110 + 8);
	frames.forEach((fr, i) => blit(img, fr, 4 + i * 164, 4));
	return img;
}
const d1 = dropStrip(false, true);
const d2 = dropStrip(true, true);
const drop = canvas(d1.w, d1.h + d2.h + 36);
drawText(drop, "A drop, 1/30 s a frame", 6, 4, 1, [230, 230, 230]);
blit(drop, d1, 0, 14);
drawText(drop, "The same with Reduce Motion", 6, d1.h + 20, 1, [230, 230, 230]);
blit(drop, d2, 0, d1.h + 30);
save("drop.png", drop);

// ---------------------------------------------------------------- 4. the glint

function glintRow(reduce) {
	useArt(true);
	const view = new GroundItemsView(shadowRule({ night: false }));
	nextId = 1000;
	const out = [];
	for (let f = 0; f < 8; f++) {
		const st = stage(ITEMS.length * 40 + 20, 56, 3000, 3000);
		st.renderer.beginFrame();
		st.renderer.drawRect(st.cam, 3000, 3000, { w: 2000, h: 200, color: COLORS.road, zIndex: Z.ground });
		const x0 = 3000 - (ITEMS.length * 40) / 2;
		const items = ITEMS.map(([kind, itemId, count], i) => item(kind, itemId, count, x0 + 40 * i + 20, 3000));
		nextId = 1000;
		drawItems(view, st, items, f * 0.33, { reduceMotion: reduce });
		st.renderer.endFrame();
		out.push(raster(st));
	}
	return out;
}
{
	const rows = glintRow(false);
	const img = canvas(rows[0].w + 8, rows.length * 60 + 20);
	drawText(img, "Glint over 2.6 s (every 0.33 s) on asphalt", 6, 4, 1, [230, 230, 230]);
	rows.forEach((r, i) => blit(img, r, 4, 16 + i * 60));
	save("glint.png", img);
}
console.log(`done: ${OUT}`);
