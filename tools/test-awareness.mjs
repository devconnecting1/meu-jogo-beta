#!/usr/bin/env node
/*
 * The zombies' awareness marks (docs/DESIGN_RULES.md IA-05, client/view/zombieAwareness.ts), drawn by the REAL
 * module onto the fake GUI tree of tools/fake-gui.mjs and rasterised by tools/gui-raster.mjs.
 *
 *   npm run test:awareness                         # the checks (exit code 1 on any failure)
 *   npm run test:awareness -- --out <dir>          # ...and the PNGs: every state on every ground, and the story
 *
 *   1. SHAPES     dot / "?" / "!" are different silhouettes, not only different colours, and each costs a few Frames;
 *   2. LEG-03     every mark reads on light pavers, asphalt, grass, every room floor (its flat colour, the darkest and
 *                 the lightest texel of its texture, the shadow at a wall's foot), every rug of the interiors' art, a
 *                 fight's blood (ART-15: wet, drying and a day old, on wood and asphalt), under the thickest fog (LUZ-05:
 *                 the marks sit above it) and in the dark: some part of its edge is ≥ 3:1 against the ground (WCAG
 *                 1.4.11), and the fill is ≥ 3:1 against its own outline;
 *   3. PLACEMENT  above the head, and never over a survivor: a zombie right under you slides its mark aside;
 *   4. WHO        the idle dot only near you; nothing for a zombie the dark hides; nothing under a closed roof;
 *   5. MOTION     a change pops in (a bigger first frame and a white rim); Reduce Motion never moves (no pop, no
 *                 tilt) but keeps the rim; a zombie that gives up lets its "?" fade;
 *   6. CHURN      600 frames of a horde changing state create no Instance after the warm-up;
 *   7. STORY      (--out) the tools/test-ai.mjs story, one picture per beat: wander → gunshot → investigate → spot →
 *                 groan → chase → lose sight → search → give up.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { installShims, ROOT, setSeed } from "./luau-shim.mjs";
import { installFakeGui } from "./fake-gui.mjs";
import { rasterise } from "./gui-raster.mjs";
import { decodePNG, encodePNG } from "./png-lite.mjs";
import { drawText } from "./pixel-font.mjs";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const OUT = outAt >= 0 && args[outAt + 1] !== undefined ? resolve(args[outAt + 1]) : undefined;

const { SRC, require } = installShims({ seed: 11 });
const gui = installFakeGui();

const { COLORS, Z } = require(join(SRC, "shared/engine/colors.ts"));
const { Camera } = require(join(SRC, "shared/engine/camera.ts"));
const R = require(join(SRC, "shared/engine/renderer.ts"));
const { Renderer, LightMap } = R;
const W = require(join(SRC, "shared/game/world.ts"));
const { createZombie, resetEntityIds } = require(join(SRC, "shared/game/entities.ts"));
const { createPlayer } = require(join(SRC, "shared/game/player.ts"));
const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
const { darkAlphaAt } = require(join(SRC, "shared/sim/clock.ts"));
const HV = require(join(SRC, "client/view/humanoidView.ts"));
const SV = require(join(SRC, "client/view/survivorView.ts"));
const { WorldView } = require(join(SRC, "client/view/worldView.ts"));
const AW = require(join(SRC, "client/view/zombieAwareness.ts"));
const mp = require(join(SRC, "shared/net/mpConfig.ts"));
mp.MP_PHASE = 1;
const zombieAI = require(join(SRC, "client/systems/zombieAI.ts"));
const { DayNight } = require(join(SRC, "client/systems/daynight.ts"));
const ART_MODULE = join(SRC, "client/view/worldArt.ts");
const worldArt = existsSync(ART_MODULE) ? require(ART_MODULE) : undefined;
const ART_DIR = join(ROOT, "design", "world-art");

let failures = 0;
const ok = msg => console.log(`  ok    ${msg}`);
const fail = msg => {
	failures++;
	console.log(`  FAIL  ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
const info = msg => console.log(`        ${msg}`);
const section = t => console.log(`\n${t}`);

const DT = 1 / 60;
const STATE = ["idle", "suspicious", "searching", "chasing"];

// ---------------------------------------------------------------- colour maths (WCAG 2.x)

const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);
const ratio = (a, b) => {
	const x = lum(a);
	const y = lum(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const rgb = c => [Math.round(c.R * 255), Math.round(c.G * 255), Math.round(c.B * 255)];
const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));

// ---------------------------------------------------------------- a stage: a camera, a renderer and the marks

function stage(vw, vh, zoom = 1) {
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
	const marks = new AW.AwarenessMarks(root, 84);
	return { root, renderer, dark, cam, marks, vw, vh };
}

function zombieAt(x, y, aware, type = 1) {
	const z = createZombie(type, x, y, 3, false);
	z.aware = aware;
	z.alpha = 1;
	z.angle = Math.PI / 2;
	z.angleSlow = z.angle;
	return z;
}

/** the marks' own sprites, as rectangles in screen px: { x0, y0, x1, y1, color } */
function markRects(st) {
	const out = [];
	for (const f of st.marks.renderer.layer.GetChildren()) {
		if (f.Visible === false || f.BackgroundTransparency >= 1) continue;
		const sx = f.Size.X.Offset;
		const sy = f.Size.Y.Offset;
		const cx = f.Position.X.Offset + (0.5 - f.AnchorPoint.X) * sx;
		const cy = f.Position.Y.Offset + (0.5 - f.AnchorPoint.Y) * sy;
		out.push({
			x0: cx - sx / 2,
			y0: cy - sy / 2,
			x1: cx + sx / 2,
			y1: cy + sy / 2,
			color: rgb(f.BackgroundColor3),
			z: f.ZIndex,
			alpha: 1 - f.BackgroundTransparency,
		});
	}
	return out;
}

// ================================================================ 1. shapes

section("1. SHAPES: three silhouettes, a handful of Frames each");
{
	const shape = g => {
		const cells = new Set();
		for (const c of g.fill)
			for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) cells.add(`${x},${y}`);
		return [...cells].sort().join(" ");
	};
	const G = AW.GLYPHS;
	const shapes = [shape(G.dot), shape(G.query), shape(G.bang)];
	check(new Set(shapes).size() === 3, "dot, '?' and '!' have different silhouettes (the state reads without colour)");
	for (const [name, g] of Object.entries(G)) {
		const frames = g.outline.length + g.fill.length + g.light.length;
		info(
			`${name}: ${g.w}×${g.h} texels of ${AW.MARK_TEXEL} u, ${frames} Frames (outline ${g.outline.length}, fill ${g.fill.length}, light ${g.light.length})`,
		);
		check(frames <= 10, `${name} costs ${frames} Frames (≤ 10)`);
	}
}

// ================================================================ 2. LEG-03 contrast

section("2. LEG-03: every mark reads on every ground, and at night");
const GROUNDS = {
	"light pavers": rgb(COLORS.sidewalk),
	asphalt: rgb(COLORS.road),
	grass: rgb(COLORS.grass),
	"park grass": rgb(COLORS.parkGrass),
	"shop floor": rgb(COLORS.floorTile),
	"wood floor": rgb(COLORS.floorWood),
	// the rest of the rooms' floors (ART-12): vinyl, carpet, a kitchen's and a bathroom's tiles, a back room's concrete
	"vinyl floor": rgb(COLORS.floorShop),
	carpet: rgb(COLORS.floorCarpet),
	"kitchen floor": rgb(COLORS.floorKitchen),
	"bath floor": rgb(COLORS.floorBath),
	"back-room concrete": rgb(COLORS.floorConcrete),
	// the floor in the shadow at a wall's foot (wallShade: at most 30 % black)
	"wood floor by a wall": mix(rgb(COLORS.floorWood), [0, 0, 0], 0.3),
};
{
	// with the art, every floor texture's darkest and lightest texel, and every rug's (the interiors' atlas)
	const extremes = (name, img, keep) => {
		let lo;
		let hi;
		for (let i = 0; i < img.w * img.h; i++) {
			if (img.data[i * 4 + 3] < 255 || (keep !== undefined && !keep(i % img.w, Math.floor(i / img.w)))) continue;
			const c = [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]];
			if (lo === undefined || lum(c) < lum(lo)) lo = c;
			if (hi === undefined || lum(c) > lum(hi)) hi = c;
		}
		if (lo !== undefined) GROUNDS[`${name} (art, darkest)`] = lo;
		if (hi !== undefined) GROUNDS[`${name} (art, lightest)`] = hi;
	};
	for (const [name, file] of [
		["wood floor", "floorWood"],
		["tile floor", "floorTile"],
		["vinyl floor", "floorShop"],
		["carpet", "floorCarpet"],
		["kitchen floor", "floorKitchen"],
		["bath floor", "floorBath"],
	]) {
		const p = join(ART_DIR, `${file}.png`);
		if (existsSync(p)) extremes(name, decodePNG(readFileSync(p)));
	}
	const FA = join(SRC, "client/view/furnitureAtlas.ts");
	const atlas = join(ART_DIR, "furniture.png");
	if (existsSync(FA) && existsSync(atlas)) {
		const { FURNITURE_CELLS, RUG_COLOURS } = require(FA);
		const img = decodePNG(readFileSync(atlas));
		for (let n = 0; n < RUG_COLOURS; n++) {
			const [x0, y0, w, h] = FURNITURE_CELLS[`rug:${n}:h`];
			extremes(`rug ${n}`, img, (x, y) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h);
		}
	}
	// the doorsteps (ART-17): a zombie at a door stands on a coir or rubber mat, a ramp's warning strip, a school's
	// steps, a bay's hazard paint -- every stoop's darkest and lightest texel, in each of its looks
	const EA = join(SRC, "client/view/entranceAtlas.ts");
	const doors = join(ART_DIR, "entrances.png");
	if (existsSync(EA) && existsSync(doors)) {
		const { ENTRANCE_CELLS } = require(EA);
		const img = decodePNG(readFileSync(doors));
		for (const [key, c] of Object.entries(ENTRANCE_CELLS)) {
			const [part, kind, side, look] = key.split(":");
			if (part !== "stoop" || side !== "bottom") continue;
			const [x0, y0, w, h] = c;
			extremes(`${kind} doorstep ${look}`, img, (x, y) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h);
		}
	}
	// a downtown square's floor (MOB-07): its mosaic in every look, and the planted bed a zombie crosses (the lawn above),
	// the atlas's darkest and lightest texel of each mosaic; flat, the mosaic's disc and its ring
	const TA = join(SRC, "client/view/townPropAtlas.ts");
	const props = join(ART_DIR, "townProps.png");
	if (existsSync(TA) && existsSync(props)) {
		const { TOWN_PROP_CELLS } = require(TA);
		const img = decodePNG(readFileSync(props));
		for (const [key, c] of Object.entries(TOWN_PROP_CELLS)) {
			const [tag, size, , look] = key.split(":");
			if (tag !== "medallion" || size !== "288x288") continue;
			const [x0, y0, w, h] = c;
			extremes(`square mosaic ${look}`, img, (x, y) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h);
		}
		GROUNDS["square mosaic (flat)"] = rgb(COLORS.sidewalk.Lerp(COLORS.white, 0.2));
		GROUNDS["square mosaic's ring (flat)"] = rgb(COLORS.sidewalk.Lerp(COLORS.shadow, 0.12));
	}
}
{
	// a fight's blood (ART-15): a mark over a zombie standing in a stain, wet (a survivor's red, the horde's dark red)
	// or a game day old, on a wood floor and on the asphalt -- the atlas's darkest and lightest texel, blended as drawn
	const BV_MODULE = join(SRC, "client/view/bloodView.ts");
	const atlas = join(ART_DIR, "blood.png");
	if (existsSync(BV_MODULE) && existsSync(atlas)) {
		const BA = require(join(SRC, "client/view/bloodAtlas.ts"));
		const img = decodePNG(readFileSync(atlas));
		const stains = [
			["a survivor's wet blood", 1, [255, 255, 255]],
			["the horde's wet blood", 2, [255, 255, 255]],
			["dried blood", 0, rgb(COLORS.bloodDry)],
			["the horde's blood drying", 0, mix(rgb(COLORS.bloodHorde), rgb(COLORS.bloodDry), 0.4)],
		];
		for (const [what, band, tint] of stains) {
			for (const [floor, g] of [
				["wood floor", rgb(COLORS.floorWood)],
				["asphalt", rgb(COLORS.road)],
			]) {
				let lo;
				let hi;
				for (const [x0, y0, w, h] of BA.BLOOD_CELLS) {
					for (let y = 0; y < h; y++) {
						for (let x = 0; x < w; x++) {
							const i = ((band * BA.BLOOD_BAND_H + y0 + y) * img.w + x0 + x) * 4;
							const a = img.data[i + 3] / 255;
							if (a <= 0) continue;
							const c = [0, 1, 2].map(k =>
								Math.round(((img.data[i + k] * tint[k]) / 255) * a + g[k] * (1 - a)),
							);
							if (lo === undefined || lum(c) < lum(lo)) lo = c;
							if (hi === undefined || lum(c) > lum(hi)) hi = c;
						}
					}
				}
				GROUNDS[`${what} on ${floor} (darkest)`] = lo;
				GROUNDS[`${what} on ${floor} (lightest)`] = hi;
			}
		}
	}
}
// the fog (LUZ-05): the marks sit ABOVE it, so the ground they read against is the fogged one -- the thickest fog the
// screen ever draws (FOG_SCREEN_MAX, past FOG_FULL_R) over each ground; and the night below adds those at night too
{
	const WEATHER = join(SRC, "shared/sim/weather.ts");
	if (existsSync(WEATHER) && COLORS.overlayFog !== undefined) {
		const { FOG_SCREEN_MAX } = require(WEATHER);
		for (const [name, g] of Object.entries({ ...GROUNDS }))
			GROUNDS[`${name} in fog`] = mix(g, rgb(COLORS.overlayFog), FOG_SCREEN_MAX);
	}
}
// the night: the deepest overlay the clock ever draws (clock.ts MAX_DARK), over each ground
const NIGHT = darkAlphaAt(23, false, false);
for (const [name, g] of Object.entries({ ...GROUNDS }))
	GROUNDS[`${name} at night`] = mix(g, rgb(COLORS.overlayNight), NIGHT);
{
	const worst = { ratio: Infinity, where: "" };
	for (const aware of [0, 1, 2, 3]) {
		const st = stage(200, 160);
		st.cam.x = 1000;
		st.cam.y = 1000;
		const z = zombieAt(1000, 1030, aware);
		st.marks.reduceMotion = true;
		// the survivor stands close, so the idle dot shows; a first frame is "not news" (no pop, no rim)
		st.marks.draw(st.cam, st.cam.viewRect(32), [z], [{ x: 1000, y: 1140 }], DT);
		const rects = markRects(st);
		const colors = new Map();
		for (const r of rects) colors.set(r.color.join(","), r.color);
		const outline = rgb(AW.MARK_COLORS.outline);
		const fill = rgb(aware === 3 ? AW.MARK_COLORS.hunt : aware === 0 ? AW.MARK_COLORS.calm : AW.MARK_COLORS.alert);
		check(
			colors.has(outline.join(",")) && colors.has(fill.join(",")),
			`${STATE[aware]}: drawn with its outline and its fill`,
		);
		const inner = ratio(fill, outline);
		check(inner >= 3, `${STATE[aware]}: fill against its own outline ${inner.toFixed(1)}:1 (≥ 3)`);
		const row = [];
		for (const [gname, g] of Object.entries(GROUNDS)) {
			// rasterised for real: the pixels of the mark that differ from the ground, and the best step among them
			const img = rasterise(
				{ layer: st.renderer.layer, over: [st.marks.renderer.layer], vw: st.vw, vh: st.vh },
				Color3.fromRGB(g[0], g[1], g[2]),
				() => undefined,
			);
			let best = 0;
			for (let i = 0; i < img.w * img.h; i++) {
				const px = [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]];
				if (px[0] === g[0] && px[1] === g[1] && px[2] === g[2]) continue;
				best = Math.max(best, ratio(px, g));
			}
			row.push(`${gname} ${best.toFixed(1)}`);
			if (best < worst.ratio) {
				worst.ratio = best;
				worst.where = `${STATE[aware]} on ${gname}`;
			}
			if (best < 3) fail(`${STATE[aware]} on ${gname}: its edge is only ${best.toFixed(2)}:1 against the ground`);
		}
		info(`${STATE[aware].padEnd(10)} ${row.join(" · ")}`);
	}
	check(worst.ratio >= 3, `the weakest case is still ≥ 3:1 (${worst.where}, ${worst.ratio.toFixed(2)}:1)`);
}

// ================================================================ 3. placement

section("3. PLACEMENT: over the head, never over a survivor");
{
	const st = stage(400, 300);
	st.cam.x = 1000;
	st.cam.y = 1000;
	const me = { x: 1000, y: 1000 };
	// a zombie in the open: the mark is above its head, upright on screen
	let z = zombieAt(1000, 1200, 3);
	st.marks.draw(st.cam, st.cam.viewRect(32), [z], [me], DT);
	let rects = markRects(st);
	const head = st.cam.worldToScreen(z.x, z.y);
	const top = Math.max(...rects.map(r => r.y1));
	check(rects.length > 0 && top < head.y - 16, "the mark sits above the head (screen up), clear of the body");
	// right under the survivor's feet: the mark would land on them — it slides aside instead
	z = zombieAt(1000, 1045, 3);
	st.marks.draw(st.cam, st.cam.viewRect(32), [z], [me], DT);
	rects = markRects(st);
	const s = st.cam.worldToScreen(me.x, me.y);
	const r18 = 18 * st.cam.zoom;
	const covers = rects.some(r => {
		const qx = Math.max(r.x0, Math.min(s.x, r.x1));
		const qy = Math.max(r.y0, Math.min(s.y, r.y1));
		return (qx - s.x) ** 2 + (qy - s.y) ** 2 < r18 * r18;
	});
	check(
		rects.length > 0 && !covers,
		"a zombie right under the survivor: its mark slides aside and never covers them",
	);
	// the camera turned (the sniper's view): still upright and still above the head on screen
	st.cam.angle = 1.1;
	z = zombieAt(1000, 1200, 1);
	st.marks.draw(st.cam, st.cam.viewRect(32), [z], [me], DT);
	rects = markRects(st);
	const h2 = st.cam.worldToScreen(z.x, z.y);
	check(
		rects.length > 0 && Math.max(...rects.map(r => r.y1)) < h2.y - 12,
		"with the camera turned it is still above the head on screen",
	);
}

// ================================================================ 4. who gets one

section("4. WHO: the idle dot only near you; nothing the dark or a roof hides");
{
	const st = stage(800, 600, 0.5);
	st.cam.x = 2000;
	st.cam.y = 2000;
	const me = { x: 2000, y: 2000 };
	const idle = [];
	for (let i = 0; i < 24; i++) {
		const a = (i / 24) * Math.PI * 2;
		const d = 120 + (i % 6) * 100;
		idle.push(zombieAt(2000 + Math.cos(a) * d, 2000 + Math.sin(a) * d, 0));
	}
	st.marks.draw(st.cam, st.cam.viewRect(32), idle, [me], DT);
	const near = idle.filter(z => Math.hypot(z.x - 2000, z.y - 2000) < AW.CALM_NEAR).length;
	const dots = markRects(st).filter(r => r.z === 2).length;
	info(`${idle.length} idle zombies, ${near} within ${AW.CALM_NEAR} u: ${dots} dots drawn`);
	check(dots === near, "only the idle zombies near you carry the blue dot (a street full of them stays a street)");
	const hidden = zombieAt(2100, 2000, 3);
	hidden.alpha = 0;
	st.marks.draw(st.cam, st.cam.viewRect(32), [hidden], [me], DT);
	check(
		markRects(st).length === 0,
		"a zombie the dark hides (alpha 0) has no mark: the mark reveals nothing the body did not",
	);
	// MP_PHASE 2: `alpha` is only "the server sent it" (an ally's flashlight lit it over there); on THIS screen the
	// mark follows this screen's light on the ground under the zombie (MarkNight: the light map's own lights)
	{
		const deep = darkAlphaAt(23, false, false);
		const sent = zombieAt(2300, 2000, 3); // 300 u east of you: past your own 250 u light
		const markAlpha = () => Math.max(0, ...markRects(st).map(r => r.alpha));
		const drawNight = (dark, lights) => {
			st.marks.draw(st.cam, st.cam.viewRect(32), [sent], [me], DT, undefined, { dark, lights });
			return markAlpha();
		};
		const mine = { x: 2000, y: 2000, r: 250, inner: 0.4 };
		const unlit = drawNight(deep, [mine]);
		check(unlit === 0, "night, sent by the server (alpha 1), no light over it here: no mark");
		const beamEast = { x: 2000, y: 2000, r: 560, inner: 0.35, angle: 0, cone: Math.PI / 4 };
		const beamSouth = { ...beamEast, angle: Math.PI / 2 };
		const inBeam = drawNight(deep, [mine, beamEast]);
		const offBeam = drawNight(deep, [mine, beamSouth]);
		const beamLight = R.lightAt([beamEast], sent.x, sent.y);
		check(
			inBeam > 0.5 && Math.abs(inBeam - beamLight) < 0.02 && offBeam === 0,
			`...your flashlight on it: the mark, as bright as the beam there (${inBeam.toFixed(2)} = ${beamLight.toFixed(2)}); aimed away: none`,
		);
		const edge = drawNight(deep, [{ x: 2000, y: 2000, r: 400, inner: 0.4 }]);
		check(
			edge > 0 && edge < inBeam,
			`...at the fringe of a light it is as dim as the ground there (${edge.toFixed(2)}; lightAt ${R.lightAt([{ x: 2000, y: 2000, r: 400, inner: 0.4 }], 2300, 2000).toFixed(2)})`,
		);
		check(drawNight(0.2, [mine]) > 0.9, "...and at dusk, before the night hides anything, it is drawn in full");
		check(
			R.lightAt([mine], 2000, 2000) === 1 &&
				R.lightAt([mine], 2250, 2000) === 0 &&
				R.lightAt([beamEast], 2000, 2300) === 0 &&
				R.lightAt([beamEast], 2150, 2000) === 1 &&
				R.lightAt([beamEast], 2600, 2000) === 0,
			"lightAt is the light map's rule: full in the core, 0 at the radius and outside a cone",
		);
	}
	// under a closed roof
	const world = W.createWorld(4000, 4000);
	W.addSolid(world, {
		kind: "building",
		x: 2200,
		y: 1800,
		w: 400,
		h: 400,
		hp: 1,
		hpMax: 1,
		destructible: false,
		tags: "house",
		rot: 0,
		passable: true,
		buildingType: 1,
		roofAlpha: 1,
	});
	const inside = zombieAt(2400, 2000, 3);
	st.marks.draw(st.cam, st.cam.viewRect(32), [inside], [me], DT, world);
	check(markRects(st).length === 0, "a zombie under a closed roof has no mark (EDI-04: the roof hides the inside)");
	world.solids[0].roofAlpha = 0;
	st.marks.draw(st.cam, st.cam.viewRect(32), [inside], [me], DT, world);
	check(markRects(st).length > 0, "...and has one once the roof is off (you are inside)");
}

// ================================================================ 5. motion

section("5. MOTION: a change pops in; Reduce Motion never moves");
{
	const size = (reduce, aware, frames) => {
		const st = stage(300, 300);
		st.cam.x = 1000;
		st.cam.y = 1000;
		st.marks.reduceMotion = reduce;
		const z = zombieAt(1000, 1100, 0);
		const me = { x: 1000, y: 900 };
		st.marks.draw(st.cam, st.cam.viewRect(32), [z], [me], DT);
		z.aware = aware;
		const out = [];
		for (let f = 0; f < frames; f++) {
			st.marks.draw(st.cam, st.cam.viewRect(32), [z], [me], DT);
			const rs = markRects(st);
			const h = Math.max(...rs.map(r => r.y1)) - Math.min(...rs.map(r => r.y0));
			const w = Math.max(...rs.map(r => r.x1)) - Math.min(...rs.map(r => r.x0));
			const rim = rs.some(r => r.z === 1 && r.color.join(",") !== rgb(AW.MARK_COLORS.outline).join(","));
			out.push({ h, w, rim });
		}
		return out;
	};
	const pop = size(false, 3, 30);
	const still = size(true, 3, 30);
	info(
		`"!" height: first frame ${pop[0].h.toFixed(1)} px, settled ${pop[20].h.toFixed(1)} px; with Reduce Motion ${still[0].h.toFixed(1)} → ${still[20].h.toFixed(1)} px`,
	);
	check(pop[0].h > pop[20].h * 1.3, "a new state pops in: the first frame is bigger, then it settles");
	check(
		still.every(s => Math.abs(s.h - still[0].h) < 0.01),
		"with Reduce Motion the mark never changes size",
	);
	check(pop[0].rim && still[0].rim && !still[25].rim, "the white rim flashes on the change either way, then goes");
	// a whole tilt period (2π / SEARCH_TILT_SPEED ≈ 2.1 s) after the pop: the phase is per zombie id, so a shorter
	// window could land on a stretch where the "?" is as wide going one way as the other
	const tilt = size(false, 2, 150);
	const tiltStill = size(true, 2, 150);
	const spread = xs => Math.max(...xs) - Math.min(...xs);
	const tiltW = spread(tilt.slice(20).map(s => s.w));
	check(tiltW > 0.5, `a searching '?' tilts while it looks round (its width swings ${tiltW.toFixed(1)} px)`);
	check(spread(tiltStill.map(s => s.w)) < 0.01, "...and stands still with Reduce Motion");
	// giving up: the "?" fades, then nothing (the zombie is far from the survivor, so no dot either)
	const st = stage(300, 300);
	st.cam.x = 1000;
	st.cam.y = 1000;
	const z = zombieAt(1000, 1100, 1);
	const far = { x: 5000, y: 5000 };
	st.marks.draw(st.cam, st.cam.viewRect(32), [z], [far], DT);
	z.aware = 0;
	st.marks.draw(st.cam, st.cam.viewRect(32), [z], [far], DT);
	const fading = markRects(st).length;
	for (let f = 0; f < 40; f++) st.marks.draw(st.cam, st.cam.viewRect(32), [z], [far], DT);
	check(fading > 0 && markRects(st).length === 0, "a zombie that gives up lets its '?' fade, then shows nothing");
}

// ================================================================ 6. churn

section("6. CHURN: a changing horde creates no Instance after the warm-up");
{
	const st = stage(1120, 630);
	st.cam.x = 2000;
	st.cam.y = 2000;
	const zs = [];
	for (let i = 0; i < 40; i++) zs.push(zombieAt(1600 + (i % 8) * 100, 1800 + Math.floor(i / 8) * 90, i % 4));
	const me = { x: 2000, y: 2000 };
	for (let f = 0; f < 120; f++) {
		for (const z of zs) z.aware = (z.id + Math.floor(f / 30)) % 4;
		st.marks.draw(st.cam, st.cam.viewRect(32), zs, [me], DT);
	}
	const before = gui.stats.created;
	for (let f = 0; f < 600; f++) {
		for (const z of zs) z.aware = (z.id + Math.floor(f / 30)) % 4;
		st.marks.draw(st.cam, st.cam.viewRect(32), zs, [me], DT);
	}
	const created = gui.stats.created - before;
	info(`${markRects(st).length} mark sprites on screen for 40 zombies`);
	check(created === 0, `600 frames of 40 zombies changing state: ${created} Instances created`);
}

// ================================================================ 7. pictures (--out)

/** decoded art PNGs for the rasteriser ("local:<name>" ids, as tools/render-map.mjs hands them) */
const images = new Map();
function localImage(id) {
	if (images.has(id)) return images.get(id);
	let img;
	const file = id.startsWith("local:") ? join(ART_DIR, `${id.slice(6)}.png`) : undefined;
	if (file !== undefined && existsSync(file)) img = decodePNG(readFileSync(file));
	images.set(id, img);
	return img;
}

function useLocalArt() {
	if (worldArt === undefined) return;
	const manifestPath = join(ART_DIR, "manifest.json");
	if (!existsSync(manifestPath)) return;
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const ids = {};
	for (const t of manifest.textures) ids[t.name] = `local:${t.name}`;
	worldArt.overrideWorldArt(ids);
}

function blit(dst, src, ox, oy) {
	for (let y = 0; y < src.h; y++) {
		if (oy + y < 0 || oy + y >= dst.h) continue;
		for (let x = 0; x < src.w; x++) {
			if (ox + x < 0 || ox + x >= dst.w) continue;
			const s = (y * src.w + x) * 4;
			const d = ((oy + y) * dst.w + ox + x) * 4;
			dst.data[d] = src.data[s];
			dst.data[d + 1] = src.data[s + 1];
			dst.data[d + 2] = src.data[s + 2];
			dst.data[d + 3] = 255;
		}
	}
}

function canvas(w, h, bg = [24, 24, 28]) {
	const data = Buffer.alloc(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		data[i * 4] = bg[0];
		data[i * 4 + 1] = bg[1];
		data[i * 4 + 2] = bg[2];
		data[i * 4 + 3] = 255;
	}
	return { w, h, data };
}

/**
 * One picture of the town around (cx, cy): ground and solids by the real WorldView, bodies, marks, the night, and
 * (for the story) the noise rings still spreading, as faint circles — the original drew them too.
 */
function shot(world, cx, cy, vw, vh, hour, zombies, survivors, marks, zoom = 1, rings = []) {
	const st = marks ?? stage(vw, vh, zoom);
	st.cam.x = cx;
	st.cam.y = cy;
	const shadow = (x, y, len) => ({ x: len * 0.5, y: len * 0.5 });
	const view = new WorldView(shadow);
	view.clock = 0;
	const v = st.cam.viewRect(32);
	st.renderer.beginFrame();
	view.drawGround(st.renderer, st.cam, v, world);
	view.drawSolids(st.renderer, st.cam, v, world);
	for (const z of zombies) {
		st.renderer.drawCircle(st.cam, z.x + 5, z.y + 5, 16 * 2.1, {
			color: COLORS.shadow,
			alpha: 0.3,
			zIndex: Z.actorShadow,
		});
		HV.drawHumanoid(
			st.renderer,
			st.cam,
			z.x,
			z.y,
			z.angleSlow,
			16 / 18,
			HV.zombieColor(z.type),
			0,
			1,
			z.feetCycle ?? 0,
			Z.zombie,
		);
	}
	for (const ring of rings) {
		if (ring.r <= 10) continue;
		st.renderer.drawCircle(st.cam, ring.x, ring.y, Math.min(ring.r, ring.rMax) * 2, {
			color: COLORS.white,
			alpha: 0,
			stroke: COLORS.white,
			strokeThickness: 2,
			strokeAlpha: 0.45 * (1 - Math.min(ring.r, ring.rMax) / ring.rMax) + 0.1,
			zIndex: Z.effect,
		});
	}
	for (const p of survivors) {
		const look = SV.createLook();
		look.x = p.x;
		look.y = p.y;
		look.angle = p.angle ?? 0;
		look.shadowX = 5;
		look.shadowY = 5;
		SV.drawSurvivor(st.renderer, st.cam, look, SV.createSwingTrail());
	}
	st.renderer.endFrame();
	const darkness = darkAlphaAt(hour, false, false);
	// the lights the map draws are the ones the marks are dimmed by (GameLoop.drawLight → drawAwareness)
	const lights = survivors.map(p => ({ x: p.x, y: p.y, r: 250, inner: 0.4 }));
	if (darkness > 0.004) {
		const lm = new LightMap(st.dark, COLORS.overlayNight);
		lm.update(st.cam, darkness, lights);
	}
	return {
		st,
		night: { dark: darkness > 0.004 ? darkness : 0, lights },
		img: () =>
			rasterise(
				{ layer: st.renderer.layer, dark: st.dark, over: [st.marks.renderer.layer], vw: st.vw, vh: st.vh },
				COLORS.bg,
				localImage,
			),
	};
}

/** the first point of a spiral around the town's middle whose ground is `want` (by the generator's own rects) */
function findGround(world, want) {
	const inR = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
	const kind = (x, y) => {
		if (W.buildingAt(world, x, y) !== undefined || W.pointInSolid(world, x, y, 60) !== undefined) return "solid";
		for (const road of world.roads)
			if (inR(road, x, y)) return road.medians.some(m => inR(m, x, y)) ? "median" : "road";
		const lot = world.lots.find(l => inR(l, x, y));
		if (lot === undefined) return "none";
		for (const g of lot.ground) if (inR(g, x, y)) return g.kind;
		if (inR(lot.yard, x, y)) return lot.zone === "commercial" ? "plaza" : "grass";
		return "sidewalk";
	};
	const cx = world.width / 2;
	const cy = world.height / 2;
	for (let i = 0; i < 20000; i++) {
		const a = i * 2.39996;
		const d = 24 * Math.sqrt(i) * 3;
		const x = Math.round(cx + Math.cos(a) * d);
		const y = Math.round(cy + Math.sin(a) * d);
		if (kind(x, y) !== want) continue;
		// the whole little scene must stand on that ground
		let all = true;
		for (const [ox, oy] of [
			[-60, 0],
			[60, 0],
			[0, -90],
			[0, 90],
		])
			if (kind(x + ox, y + oy) !== want) all = false;
		if (all) return { x, y };
	}
	return undefined;
}

function statesPicture(dir) {
	useLocalArt();
	const world = W.generateTown(7331);
	const rows = [
		["light pavers", "sidewalk", 12],
		["asphalt", "road", 12],
		["grass", "grass", 12],
		["asphalt at night", "road", 23],
	];
	const TW = 240;
	const TH = 190;
	const HEAD = 30;
	const LEFT = 150;
	const img = canvas(LEFT + TW * 4 + 10, HEAD + TH * rows.length + 10);
	for (let c = 0; c < 4; c++) drawText(img, STATE[c].toUpperCase(), LEFT + c * TW + 12, 10, 2, [235, 235, 235]);
	rows.forEach(([label, ground, hour], r) => {
		drawText(img, label.toUpperCase(), 8, HEAD + r * TH + TH / 2 - 6, 1, [235, 235, 235]);
		const at = findGround(world, ground);
		if (at === undefined) {
			fail(`no ${ground} ground found for the picture`);
			return;
		}
		for (let c = 0; c < 4; c++) {
			resetEntityIds();
			const z = zombieAt(at.x, at.y - 10, c);
			const me = { x: at.x + 70, y: at.y + 60, angle: Math.atan2(z.y - at.y - 60, z.x - at.x - 70) };
			z.angleSlow = Math.atan2(me.y - z.y, me.x - z.x);
			const s = shot(world, at.x + 20, at.y + 10, TW - 10, TH - 10, hour, [z], [me]);
			s.st.marks.reduceMotion = true;
			// a few frames so the searching "?" has its settled look; Reduce Motion keeps it upright for the picture
			for (let f = 0; f < 3; f++)
				s.st.marks.draw(s.st.cam, s.st.cam.viewRect(32), [z], [me], DT, undefined, s.night);
			blit(img, s.img(), LEFT + c * TW + 5, HEAD + r * TH + 5);
		}
	});
	const file = join(dir, "awareness-states.png");
	writeFileSync(file, encodePNG(img, true));
	return file;
}

/** the test-ai story (tools/test-ai.mjs `sequenceScenario`), photographed at each beat */
function storyPicture(dir) {
	setSeed(20260922);
	resetEntityIds();
	const world = W.createWorld(4000, 4000);
	const wall = (x, y, w, h) =>
		W.addSolid(world, {
			kind: w >= h ? "wall_h" : "wall_v",
			x,
			y,
			w,
			h,
			hp: 1000,
			hpMax: 1000,
			destructible: false,
			tags: "bwall",
			rot: 0,
		});
	wall(2300, 1300, 32, 900);
	const save = defaultSave();
	const player = createPlayer(save, 2000, 1800);
	const daynight = new DayNight(save);
	daynight.day = 3;
	daynight.dayTime = 12;
	daynight.update(0);
	daynight.isNight = false;
	daynight.darkAlpha = 0;
	const refs = {
		world,
		players: [player],
		player,
		save,
		input: {},
		zombies: [],
		bosses: [],
		bullets: [],
		daynight,
		pendingPlace: 0,
		fx: [],
		onMessage: () => {},
		onExp: () => {},
	};
	const add = (x, y, a, still) => {
		const z = createZombie(1, x, y, 3, false);
		z.detect = false;
		z.angle = a;
		z.angleSlow = a;
		if (still) {
			z.wanderPause = true;
			z.wanderTimer = 999;
		}
		refs.zombies.push(z);
		return z;
	};
	const scout = add(2000, 1080, Math.PI, false);
	const neighbour = add(2040, 960, -Math.PI / 2, true);
	const CX = 2140;
	const CY = 1330;
	const st = stage(620, 470, 0.44);
	const beats = [];
	const snap = caption => {
		const s = shot(world, CX, CY, 620, 470, 12, refs.zombies, [player], st, 0.44, refs.sounds ?? []);
		st.marks.reduceMotion = false;
		st.marks.draw(st.cam, st.cam.viewRect(32), refs.zombies, [player], DT, world);
		beats.push({ caption, img: s.img() });
	};
	const tick = () => zombieAI.updateZombies(refs, DT);
	let t = 0;
	const step = n => {
		for (let i = 0; i < n; i++) {
			tick();
			t += DT;
			st.marks.draw(st.cam, st.cam.viewRect(32), refs.zombies, [player], DT, world);
		}
	};
	st.cam.x = CX;
	st.cam.y = CY;
	// each beat is photographed ~0.4 s after the change: the settled mark (the pop is section 5's business)
	const SETTLE = 24;
	step(60);
	snap(`${t.toFixed(1)}s wander (idle, far: no mark)`);
	zombieAI.emitSound(refs, player.x, player.y, 800, true);
	const until = (pred, max) => {
		for (let i = 0; i < max && !pred(); i++) step(1);
	};
	step(20);
	snap(`${t.toFixed(1)}s a gunshot: the ring spreads`);
	until(() => scout.aware === 1, 600);
	step(SETTLE);
	snap(`${t.toFixed(1)}s the scout heard it: suspicious`);
	step(90);
	snap(`${t.toFixed(1)}s investigates the shot`);
	until(() => scout.aware === 3, 900);
	step(SETTLE);
	snap(`${t.toFixed(1)}s spots you, groans: chasing; the neighbour, woken: suspicious`);
	step(40);
	// the survivor sprints east round the house
	let lost = false;
	for (let i = 0; i < 60 * 4; i++) {
		player.x = Math.min(3400, player.x + 4.2);
		step(1);
		if (!lost && scout.aware !== 3) {
			lost = true;
			step(SETTLE);
			snap(`${t.toFixed(1)}s lost sight: to the last place`);
		}
	}
	until(() => scout.aware === 2, 900);
	step(40);
	snap(`${t.toFixed(1)}s searching (hops, looks round)`);
	until(() => scout.aware === 0, 1200);
	step(4);
	snap(`${t.toFixed(1)}s gives up: the mark fades`);
	const COLS = 4;
	const PW = 620;
	const PH = 470;
	const CAP = 28;
	const rowsN = Math.ceil(beats.length / COLS);
	const img = canvas(COLS * (PW + 8) + 8, rowsN * (PH + CAP + 8) + 8);
	beats.forEach((b, i) => {
		const x = 8 + (i % COLS) * (PW + 8);
		const y = 8 + Math.floor(i / COLS) * (PH + CAP + 8);
		drawText(img, `${i + 1}. ${b.caption}`.toUpperCase(), x + 4, y + 6, 1, [235, 235, 235]);
		blit(img, b.img, x, y + CAP);
	});
	const file = join(dir, "awareness-story.png");
	writeFileSync(file, encodePNG(img, true));
	return { file, beats: beats.length };
}

if (OUT !== undefined) {
	section("7. PICTURES");
	mkdirSync(OUT, { recursive: true });
	info(statesPicture(OUT));
	const story = storyPicture(OUT);
	info(`${story.file} (${story.beats} beats)`);
	check(story.beats >= 8, `the story has all its beats (${story.beats})`);
}

console.log(`\n[test-awareness] ${failures === 0 ? "all good" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
