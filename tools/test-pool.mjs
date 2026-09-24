#!/usr/bin/env node
/*
 * The world renderer's pool (shared/engine/renderer.ts): one sub-pool per ZIndex, sprites that never change their
 * ZIndex, and the warm-up that builds a night fight's sprites behind the lobby (client/view/poolWarmup.ts). On the
 * fake GUI of tools/fake-gui.mjs, which counts every property write that changes a value.
 *
 *   npm run test:pool
 *
 * What this proves:
 *   1. THE SAME PICTURE. Every sprite paints in the order the draws asked for -- by ZIndex, then in draw order -- on
 *      a 1280 x 720 night fight (the town, blood, acid, 40 walkers, 4 survivors, sparks, tracers), and again after
 *      decals and walkers came and went in the middle of their lists. Each sprite has the ZIndex its draw asked for.
 *   2. A BIRTH OR A DEATH IS O(1). Under a still camera, a blood decal appearing and vanishing every frame costs
 *      exactly one write (Visible) and no ZIndex. The oldest decal expiring, or a walker dying at the front of the
 *      horde, moves only sprites of its own ZIndex. (The single pool this replaced: 676 writes, 257 of them ZIndex,
 *      for one decal on a 336-sprite street.)
 *   3. WALKING WRITES NO ZIndex. 600 frames of panning with the horde walking and blood coming and going: not one
 *      ZIndex write, no Instance after the warm-up; the writes per frame are printed.
 *   4. RESERVE + WARM. `warm(n)` makes at most n sprites a call, hidden, at their ZIndex, rounded / outlined / with
 *      a blank ImageLabel as reserved; drawing on a warmed sprite keeps its write cache true (no stale corner, no
 *      stroke left on, a sheet cell drawn on a warmed image creates nothing).
 *   5. THE WARM-UP PROFILE. poolWarmup.ts reserves what the reference fight draws, flat and with the characters'
 *      art (the uploaded sheets' ids): on the warmed pool the fight creates no Frame, UICorner, UIStroke or
 *      ImageLabel, and no layer is reserved far past what the fight shows.
 *   6. THE DRIVER. warmFightPool warms only while the lobby or its menus are up (not behind the boot logo, not
 *      during a run), WARM_PER_FRAME sprites a frame, and lets go of Heartbeat once the pool is warm.
 *   7. THE API. drawCount, poolSize, acquire, release and releaseAll across the buckets.
 *   8. ONE CLIP. The world layer has no clip of its own: its only child is the renderer's layer, which fills it and
 *      clips to the same rect (rotation support off, nothing rotated above either: the two clips were the same).
 *   9. NO WRITE WITHOUT A CHANGE. A steady music track writes no Volume; the night layer and the touch sticks are
 *      written only when they move (source guards: those two only run on the whole client).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installShims } from "./luau-shim.mjs";
import { installFakeGui } from "./fake-gui.mjs";

const { SRC, ROOT, require } = installShims({ seed: 7 });
const gui = installFakeGui();

// a Heartbeat the suite fires by hand, and just enough of `game` for the client modules loaded below
const heartbeat = {
	conns: new Set(),
	Connect(fn) {
		const c = {
			Connected: true,
			Disconnect() {
				c.Connected = false;
				heartbeat.conns.delete(c);
			},
			fn,
		};
		heartbeat.conns.add(c);
		return c;
	},
	fire(dt = 1 / 60) {
		for (const c of [...heartbeat.conns]) if (c.Connected) c.fn(dt);
	},
};
globalThis.game = { GetService: () => ({ Heartbeat: heartbeat, IsClient: () => true }) };
// Sounds that can play (the fake tree only stores properties)
{
	const make = globalThis.Instance;
	globalThis.Instance = function Instance(className) {
		const inst = make(className);
		if (className === "Sound") {
			inst.IsPlaying = false;
			inst.Play = () => {
				inst.IsPlaying = true;
			};
			inst.Stop = () => {
				inst.IsPlaying = false;
			};
		}
		return inst;
	};
}

const { Camera } = require(join(SRC, "shared/engine/camera.ts"));
const { Renderer } = require(join(SRC, "shared/engine/renderer.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const { COLORS, Z } = require(join(SRC, "shared/engine/colors.ts"));
const { generateTown } = require(join(SRC, "shared/game/world.ts"));
const { WorldView } = require(join(SRC, "client/view/worldView.ts"));
const HV = require(join(SRC, "client/view/humanoidView.ts"));
const SV = require(join(SRC, "client/view/survivorView.ts"));
const WA = require(join(SRC, "client/view/worldArt.ts"));
const { WORLD_ART } = require(join(SRC, "client/view/worldArtAssets.ts"));
const CA = require(join(SRC, "client/view/charArt.ts"));
const PW = require(join(SRC, "client/view/poolWarmup.ts"));
const { AudioTrack } = require(join(SRC, "client/audio/audio.ts"));

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

/** the sprite a write landed on: the Frame itself, or the Frame a modifier / ImageLabel belongs to */
const spriteOf = inst => (inst.ClassName === "Frame" ? inst : (inst.Parent ?? inst));

/**
 * Runs `fn` and reports what it cost the engine: changed writes on Instances already in the tree (an Instance being
 * built is not in it yet), ZIndex writes among them, the sprites they touched, per property, and Instances created.
 */
function watch(fn) {
	const w = { writes: 0, zWrites: 0, touched: new Set(), byProp: {}, rewrites: 0, created: 0 };
	const c0 = gui.stats.created;
	gui.stats.onWrite = (inst, prop, changed) => {
		if (inst.Parent === undefined) return;
		if (!changed) {
			w.rewrites++;
			return;
		}
		w.writes++;
		if (prop === "ZIndex") w.zWrites++;
		w.touched.add(spriteOf(inst));
		const key = `${inst.ClassName}.${String(prop)}`;
		w.byProp[key] = (w.byProp[key] ?? 0) + 1;
	};
	try {
		fn();
	} finally {
		gui.stats.onWrite = undefined;
	}
	w.created = gui.stats.created - c0;
	return w;
}
const top = (byProp, frames = 1, n = 5) =>
	Object.entries(byProp)
		.sort((a, b) => b[1] - a[1])
		.slice(0, n)
		.map(([k, c]) => `${k} ${(c / frames).toFixed(1)}`)
		.join(", ");

/** every texture live (the characters' sheets included): its uploaded id, or a fake one while it has none */
function allIds() {
	const manifest = JSON.parse(readFileSync(join(ROOT, "design", "world-art", "manifest.json"), "utf8"));
	const ids = {};
	manifest.textures.forEach((t, i) => (ids[t.name] = WORLD_ART[t.name]?.id || `rbxassetid://${900000 + i}`));
	return ids;
}

// ---------------------------------------------------------------- the reference night fight

const world = generateTown(DESIGN.TOWN_SEED);
const AT = { x: 8400, y: 10250 };

/**
 * A night fight drawn in GameLoop.render's order: the town's ground, blood decals and acid puddles, the town's solids,
 * the horde (a shadow + drawZombie each), 4 survivors, 60 sparks, 12 tracers. `state.town` false leaves the town out.
 */
function makeFight(vw, vh, n = 40) {
	const root = gui.make("Frame");
	const r = new Renderer(root, "Sprites");
	const cam = new Camera();
	cam.setView(vw, vh);
	r.setView(vw, vh);
	const sun = { x: 0, y: 0 };
	const view = new WorldView((x, y, len) => ((sun.x = 0.2588 * len), (sun.y = 0.9659 * len), sun));
	let seed = 1;
	const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
	const zombies = [];
	for (let i = 0; i < n; i++) {
		zombies.push({
			id: i,
			x: AT.x + (rnd() - 0.5) * vw * 0.9,
			y: AT.y + (rnd() - 0.5) * vh * 0.9,
			a: rnd() * 6,
			kind: 1 + (i % 5),
		});
	}
	const newDecal = () => ({ x: AT.x + (rnd() - 0.5) * vw, y: AT.y + (rnd() - 0.5) * vh, d: 10 + rnd() * 20 });
	const decals = [];
	for (let i = 0; i < 40; i++) decals.push(newDecal());
	const puddles = [];
	for (let i = 0; i < 4; i++) puddles.push({ x: AT.x - 300 + i * 150, y: AT.y + 200 });
	const looks = [];
	for (let i = 0; i < 4; i++) {
		const l = SV.createLook();
		l.x = AT.x + i * 60 - 90;
		l.y = AT.y + 40;
		l.z = Z.player;
		looks.push(l);
	}
	const trail = SV.createSwingTrail();
	const state = { camX: AT.x, camY: AT.y, t: 0, town: true };
	function frame() {
		cam.x = state.camX;
		cam.y = state.camY;
		const v = cam.viewRect(32);
		r.beginFrame();
		if (state.town) view.drawGround(r, cam, v, world);
		for (const d of decals) r.drawCircle(cam, d.x, d.y, d.d, { color: COLORS.blood, alpha: 0.6, zIndex: Z.decal });
		for (const p of puddles) {
			r.drawCircle(cam, p.x, p.y, 40, {
				color: COLORS.acid,
				alpha: 0.45,
				stroke: COLORS.bloodZombie,
				strokeAlpha: 0.6,
				zIndex: Z.decal + 1,
			});
		}
		if (state.town) view.drawSolids(r, cam, v, world);
		for (const z of zombies) {
			r.drawCircle(cam, z.x + 3, z.y + 9, 38, { color: COLORS.shadow, alpha: 0.3, zIndex: Z.actorShadow });
			HV.drawZombie(r, cam, z.x, z.y, z.a, 1, z.kind, 0, 1, state.t + z.id, Z.zombie, 0, false, false, false);
		}
		for (const l of looks) SV.drawSurvivor(r, cam, l, trail);
		for (let i = 0; i < 60; i++) {
			r.drawCircle(cam, AT.x + i * 7 - 200, AT.y - 100 + (i % 7) * 9, 5, {
				color: COLORS.blood,
				alpha: 0.8,
				zIndex: Z.particle,
			});
		}
		for (let i = 0; i < 12; i++) {
			r.drawSegment(cam, AT.x, AT.y, AT.x + 300, AT.y + i * 20 - 120, {
				h: 2,
				color: COLORS.white,
				zIndex: Z.projectile,
			});
		}
		r.endFrame();
	}
	return { r, cam, zombies, decals, newDecal, looks, state, frame };
}

/** records every sprite a frame's draws got, with the ZIndex each asked for */
function recordDraws(r) {
	const calls = [];
	const draw = r.drawRect;
	r.drawRect = function (cam, x, y, o) {
		const f = draw.call(this, cam, x, y, o);
		calls.push({ f, z: o.zIndex ?? 1 });
		return f;
	};
	return calls;
}

/** the visible sprites in the order the engine paints them (ZIndexBehavior.Sibling: ZIndex, ties in child order) */
function paintOrder(layer) {
	return layer
		.GetChildren()
		.map((f, i) => ({ f, i }))
		.filter(e => e.f.Visible !== false)
		.sort((a, b) => a.f.ZIndex - b.f.ZIndex || a.i - b.i)
		.map(e => e.f);
}

/** does this frame paint exactly what was asked, in the order asked? */
function samePicture(S, calls) {
	calls.length = 0;
	S.frame();
	const asked = calls
		.map((c, i) => ({ ...c, i }))
		.sort((a, b) => a.z - b.z || a.i - b.i)
		.map(c => c.f);
	const painted = paintOrder(S.r.layer);
	let firstOff = -1;
	for (let i = 0; i < Math.max(asked.length, painted.length); i++) {
		if (asked[i] !== painted[i]) {
			firstOff = i;
			break;
		}
	}
	const wrongZ = calls.filter(c => c.f.ZIndex !== c.z).length;
	// (under the Luau shim a Set's size is a method, as in roblox-ts)
	const distinct = new Set(calls.map(c => c.f)).size();
	return { ok: firstOff < 0 && wrongZ === 0 && distinct === calls.length, n: calls.length, firstOff, wrongZ };
}

WA.overrideWorldArt({});

// ================================================================ 1. the same picture

section("1) the same picture: every sprite paints by ZIndex, then in draw order");
{
	const S = makeFight(1280, 720);
	const calls = recordDraws(S.r);
	let res = samePicture(S, calls);
	check(
		res.ok,
		"a night fight: the paint order is the draws' order",
		`${res.n} sprites, first off ${res.firstOff}, ${res.wrongZ} wrong ZIndex`,
	);
	// things come and go in the middle of their lists: the slots behind them move up
	S.decals.splice(10, 3);
	S.zombies.splice(5, 2);
	S.decals.push(S.newDecal());
	res = samePicture(S, calls);
	check(
		res.ok,
		"...and after decals and walkers left the middle of their lists",
		`${res.n} sprites, first off ${res.firstOff}`,
	);
	S.state.camX += 333;
	S.state.camY -= 120;
	res = samePicture(S, calls);
	check(
		res.ok,
		"...and on another street (tiles entering and leaving the view)",
		`${res.n} sprites, first off ${res.firstOff}`,
	);
	WA.overrideWorldArt(allIds());
	res = samePicture(S, calls);
	check(res.ok, "...and with every texture and character sheet live", `${res.n} sprites, first off ${res.firstOff}`);
	WA.overrideWorldArt({});
}

// ================================================================ 2. births and deaths

section("2) a birth or a death costs O(1), and never a ZIndex");
{
	const S = makeFight(1280, 720);
	const extra = { x: AT.x + 20, y: AT.y + 30, d: 24 };
	// warm-up: both states drawn once
	S.frame();
	S.decals.push(extra);
	S.frame();
	S.decals.pop();
	S.frame();
	const toggle = watch(() => {
		for (let f = 0; f < 60; f++) {
			if (f % 2 === 0) S.decals.push(extra);
			else S.decals.pop();
			S.frame();
		}
	});
	check(
		toggle.writes === 60 &&
			(toggle.byProp["Frame.Visible"] ?? 0) === 60 &&
			toggle.zWrites === 0 &&
			toggle.created === 0,
		"a blood decal appearing / vanishing every frame (still camera): one write a frame, Visible",
		`${(toggle.writes / 60).toFixed(1)} writes/frame, ${toggle.zWrites} ZIndex, ${toggle.created} created`,
	);

	S.frame();
	const decalZ = f => f.ZIndex === Z.decal;
	const expire = watch(() => {
		S.decals.shift();
		S.frame();
	});
	check(
		expire.zWrites === 0 && expire.created === 0 && [...expire.touched].every(decalZ),
		"the oldest decal expiring moves only decals (the slots behind it at Z.decal)",
		`${expire.writes} writes on ${expire.touched.size()} sprites, all decals: ${[...expire.touched].every(decalZ)}`,
	);

	S.frame();
	const layers = new Set([Z.actorShadow, Z.zombie, Z.zombie + 1, Z.zombie + 2, Z.zombie + 3]);
	const death = watch(() => {
		S.zombies.shift();
		S.frame();
	});
	check(
		death.zWrites === 0 && death.created === 0 && [...death.touched].every(f => layers.has(f.ZIndex)),
		"a walker dying at the front of the horde moves only the horde's own layers (shadows, feet, arms, body, head)",
		`${death.writes} writes on ${death.touched.size()} sprites; the town, the blood and the survivors untouched`,
	);
	console.log(
		"       (the horde's order is the snapshot's: a death at its front still moves every walker after it, in its own" +
			" layers -- client/net/snapshotBuffer.ts decides that order, not the renderer)",
	);
}

// ================================================================ 3. walking

section("3) walking: no ZIndex write, no Instance after the warm-up");
{
	const S = makeFight(1280, 720);
	const walk = f => {
		// back and forth along the street, so the second pass sees the town the first one did
		const k = (f % 300) / 300;
		S.state.camX = AT.x + (k < 0.5 ? k * 2 : 2 - k * 2) * 375;
		S.state.t = f * 0.09;
		for (const z of S.zombies) {
			z.x += Math.cos(z.a) * 0.4 * (f % 600 < 300 ? 1 : -1);
			z.y += Math.sin(z.a) * 0.4 * (f % 600 < 300 ? 1 : -1);
		}
		// blood lands and the oldest dries up
		if (f % 10 === 0) {
			S.decals.push(S.newDecal());
			S.decals.shift();
		}
		S.frame();
	};
	for (let f = 0; f < 600; f++) walk(f);
	const w = watch(() => {
		for (let f = 600; f < 1200; f++) walk(f);
	});
	check(w.created === 0, "600 frames of walking after a warm-up create no Instance", `${w.created} created`);
	check(
		w.zWrites === 0,
		"...and write no ZIndex at all (no Z-order rebuild from the world)",
		`${w.zWrites} ZIndex writes`,
	);
	console.log(
		`       ${S.r.drawCount()} sprites a frame, ${(w.writes / 600).toFixed(0)} writes/frame  [${top(w.byProp, 600)}]; pool ${S.r.poolSize()} sprites`,
	);
}

// ================================================================ 4. reserve + warm

section("4) reserve + warm: built ahead, hidden, at their ZIndex, rounded / outlined as asked");
{
	const root = gui.make("Frame");
	const r = new Renderer(root, "Sprites");
	const cam = new Camera();
	cam.setView(1280, 720);
	r.setView(1280, 720);
	r.reserve(Z.zombie + 1, 50, 50, 10);
	check(r.poolSize() === 0 && r.layer.GetChildren().length === 0, "reserve creates nothing by itself");
	const c0 = gui.stats.created;
	const left1 = r.warm(16);
	check(
		r.poolSize() === 16 && left1 === 34,
		"warm(16) makes 16 sprites and says 34 are missing",
		`${r.poolSize()}, ${left1}`,
	);
	let calls = 1;
	while (r.warm(16) > 0) calls++;
	calls++;
	const sprites = r.layer.GetChildren();
	const corners = sprites.filter(f => f.FindFirstChildOfClass("UICorner") !== undefined);
	const strokes = sprites.filter(f => f.FindFirstChildOfClass("UIStroke") !== undefined);
	check(
		sprites.length === 50 && calls === 4 && gui.stats.created - c0 === 110,
		"50 sprites in 4 calls, 50 corners and 10 strokes: 110 Instances",
		`${sprites.length} sprites, ${calls} calls, ${gui.stats.created - c0} Instances`,
	);
	check(
		sprites.every(f => f.Visible === false && f.ZIndex === Z.zombie + 1) &&
			corners.length === 50 &&
			strokes.length === 10 &&
			strokes.every(f => f.FindFirstChildOfClass("UIStroke").Enabled === false) &&
			corners.every(f => f.FindFirstChildOfClass("UICorner").CornerRadius.Offset === 0),
		"all hidden, at their ZIndex; square corners until drawn round, strokes off until drawn outlined",
	);
	check(r.warm(16) === 0 && r.poolSize() === 50, "a warm pool stays as it is");
	r.reserve(Z.zombie + 1, 20, 20, 30);
	check(r.warm(64) === 0 && r.poolSize() === 50, "a smaller reservation never shrinks it...", `${r.poolSize()}`);
	const w = watch(() => r.warm(64));
	check(
		r.layer.GetChildren().filter(f => f.FindFirstChildOfClass("UIStroke") !== undefined).length === 30 &&
			w.writes === 0,
		"...and more outlines are added to the sprites that exist",
	);
	// drawn on the warm pool: nothing created, and every sprite shows what it was asked
	const drawn = watch(() => {
		r.beginFrame();
		for (let i = 0; i < 50; i++) {
			const round = i % 2 === 0;
			r.drawRect(cam, i * 20, 100, {
				w: 16,
				h: 16,
				color: COLORS.zombie1,
				cornerRadius: round ? 4 : undefined,
				stroke: i < 5 ? COLORS.shadow : undefined,
				zIndex: Z.zombie + 1,
			});
		}
		r.endFrame();
	});
	const kids = r.layer.GetChildren();
	const radiusOk = kids.every(
		(f, i) => f.FindFirstChildOfClass("UICorner").CornerRadius.Offset === (i % 2 === 0 ? 4 : 0),
	);
	const strokeOk = kids.every((f, i) => {
		const st = f.FindFirstChildOfClass("UIStroke");
		return i < 5 ? st.Enabled === true : st === undefined || st.Enabled === false;
	});
	check(
		drawn.created === 0 && radiusOk && strokeOk,
		"a fight drawn on it creates nothing and every corner / outline is right",
		`${drawn.created} created`,
	);
	// the same slot drawn again, square: its warmed corner goes back to 0 (a reused frame never keeps a rounding)
	r.beginFrame();
	r.drawRect(cam, 0, 100, { w: 16, h: 16, color: COLORS.zombie1, zIndex: Z.zombie + 1 });
	r.endFrame();
	check(
		kids[0].FindFirstChildOfClass("UICorner").CornerRadius.Offset === 0,
		"...and a rounded slot drawn square is square again",
	);
}
{
	// a layer of sheet cells (the characters' art): its ImageLabels are built ahead too, hidden and blank
	const r = new Renderer(gui.make("Frame"), "Sprites");
	const cam = new Camera();
	cam.setView(1280, 720);
	r.setView(1280, 720);
	r.reserve(Z.zombie, 8, 0, 0, 8);
	const c0 = gui.stats.created;
	while (r.warm(3) > 0);
	const kids = r.layer.GetChildren();
	const labels = kids.map(f => f.FindFirstChildOfClass("ImageLabel"));
	check(
		kids.length === 8 &&
			gui.stats.created - c0 === 16 &&
			labels.every(l => l !== undefined && l.Visible === false && !l.Image),
		"a layer reserved with images: each sprite comes with its ImageLabel, hidden and blank",
		`${kids.length} sprites, ${labels.filter(l => l !== undefined).length} ImageLabels, ${gui.stats.created - c0} Instances`,
	);
	const drawn = watch(() => {
		r.beginFrame();
		for (let i = 0; i < 8; i++) {
			r.drawRect(cam, i * 40, 100, {
				w: 32,
				h: 32,
				image: "rbxassetid://1",
				rectX: i * 24,
				rectY: 24,
				rectW: 24,
				rectH: 24,
				zIndex: Z.zombie,
			});
		}
		r.endFrame();
	});
	check(
		drawn.created === 0 &&
			labels.every(
				(l, i) =>
					l.Visible === true &&
					l.Image === "rbxassetid://1" &&
					l.ImageRectOffset.X === i * 24 &&
					l.ImageRectOffset.Y === 24 &&
					l.ImageRectSize.X === 24,
			),
		"...and a sheet cell drawn on it creates nothing and shows its picture and its cell",
		`${drawn.created} created`,
	);
}

// ================================================================ 5. the warm-up profile

section("5) the warm-up profile (client/view/poolWarmup.ts) against the fight it was measured on");
for (const [label, ids] of [
	["flat", {}],
	["art", allIds()],
]) {
	WA.overrideWorldArt(ids);
	const zArt = CA.zombieArtLive();
	const sArt = CA.survivorArtLive();
	const S = makeFight(1920, 1080);
	S.state.town = false;
	PW.reserveFightPool(S.r, 1920, 1080, zArt, sArt);
	const c0 = gui.stats.created;
	let frames = 0;
	while (S.r.warm(PW.WARM_PER_FRAME) > 0) frames++;
	frames++;
	const warmed = S.r.poolSize();
	const instances = gui.stats.created - c0;
	const reserved = new Map();
	for (const f of S.r.layer.GetChildren()) reserved.set(f.ZIndex, (reserved.get(f.ZIndex) ?? 0) + 1);
	const byClass0 = { ...gui.stats.byClass };
	S.frame();
	S.state.t = 3.7;
	S.frame();
	const made = cls => (gui.stats.byClass[cls] ?? 0) - (byClass0[cls] ?? 0);
	const shown = new Map();
	for (const f of S.r.layer.GetChildren()) if (f.Visible) shown.set(f.ZIndex, (shown.get(f.ZIndex) ?? 0) + 1);
	check(
		zArt === (label === "art") && sArt === (label === "art"),
		`${label}: the characters' art is ${label === "art" ? "live" : "off"}, and the profile follows it`,
	);
	check(
		made("Frame") + made("UICorner") + made("UIStroke") + made("ImageLabel") === 0,
		`${label}: on the warmed pool the fight creates no Frame, UICorner, UIStroke or ImageLabel`,
		`${made("Frame")} Frames, ${made("UICorner")} corners, ${made("UIStroke")} strokes, ${made("ImageLabel")} images`,
	);
	const over = [...reserved].filter(([z, n]) => n > (shown.get(z) ?? 0) * 1.25 + 2);
	check(
		over.length === 0,
		`${label}: no layer is reserved far past what the fight shows (25 % + 2)`,
		over.map(([z, n]) => `z ${z}: ${n} reserved, ${shown.get(z) ?? 0} shown`).join("; "),
	);
	console.log(
		`       ${label}: ${warmed} sprites (${instances} Instances) warmed in ${frames} frames of ${PW.WARM_PER_FRAME}; the fight then made ${made("ImageLabel")} ImageLabels`,
	);
}
{
	WA.overrideWorldArt({});
	const r = new Renderer(gui.make("Frame"), "Sprites");
	PW.reserveFightPool(r, 844, 390, false, false);
	while (r.warm(1000) > 0);
	const big = new Renderer(gui.make("Frame"), "Sprites");
	PW.reserveFightPool(big, 1920, 1080, false, false);
	while (big.warm(1000) > 0);
	check(
		r.poolSize() < big.poolSize() && r.poolSize() >= big.poolSize() * 0.5,
		"a phone reserves half a 1080p fight (fewer bodies fit in view), never less",
		`${r.poolSize()} vs ${big.poolSize()} sprites`,
	);
}

// ================================================================ 6. the driver

section("6) warmFightPool: only behind the lobby and its menus, a few sprites a frame, then it lets go");
{
	WA.overrideWorldArt({});
	const r = new Renderer(gui.make("Frame"), "Sprites");
	const ctx = { phase: "boot", renderer: r, viewW: 1920, viewH: 1080 };
	const before = heartbeat.conns.size();
	PW.warmFightPool(ctx);
	for (let i = 0; i < 5; i++) heartbeat.fire();
	check(r.poolSize() === 0, "behind the boot logo: nothing (the logo and the town's generation have the frames)");
	ctx.phase = "lobby";
	heartbeat.fire();
	check(r.poolSize() === PW.WARM_PER_FRAME, "the lobby's first frame: WARM_PER_FRAME sprites", `${r.poolSize()}`);
	heartbeat.fire();
	ctx.phase = "playing";
	const mid = r.poolSize();
	for (let i = 0; i < 5; i++) heartbeat.fire();
	ctx.phase = "dead";
	heartbeat.fire();
	check(r.poolSize() === mid, "a run (playing, dead) pauses it: the run's frames are the run's", `${mid}`);
	ctx.phase = "settings";
	let frames = 0;
	while (heartbeat.conns.size() > before && frames < 1000) {
		heartbeat.fire();
		frames++;
	}
	const ref = new Renderer(gui.make("Frame"), "Sprites");
	PW.reserveFightPool(ref, 1920, 1080, false, false);
	while (ref.warm(1000) > 0);
	check(
		heartbeat.conns.size() === before && r.poolSize() === ref.poolSize(),
		"back in the menus it finishes, and lets go of Heartbeat once warm",
		`${r.poolSize()} sprites, ${frames} more frames`,
	);
}

// ================================================================ 7. the API

section("7) the API across buckets");
{
	const root = gui.make("Frame");
	const r = new Renderer(root, "Sprites");
	const cam = new Camera();
	cam.setView(640, 360);
	r.setView(640, 360);
	r.beginFrame();
	for (let i = 0; i < 3; i++) r.drawRect(cam, i * 10, 0, { zIndex: 5 });
	for (let i = 0; i < 2; i++) r.drawRect(cam, i * 10, 0, { zIndex: 9 });
	const a = r.acquire();
	check(
		r.drawCount() === 6 && r.poolSize() === 6,
		"drawCount and poolSize add up every ZIndex",
		`${r.drawCount()}, ${r.poolSize()}`,
	);
	check(
		a.Visible === true && a.ZIndex === 1 && a.Size.X.Offset === 32,
		"acquire(): a visible 32 x 32 Frame at ZIndex 1",
	);
	r.release(a);
	check(a.Visible === false, "release hides it at once");
	r.endFrame();
	r.beginFrame();
	r.drawRect(cam, 0, 0, { zIndex: 5 });
	r.endFrame();
	const vis = root
		.FindFirstChild("Sprites")
		.GetChildren()
		.filter(f => f.Visible);
	check(vis.length === 1 && vis[0].ZIndex === 5, "endFrame hides each bucket's leftovers", `${vis.length} shown`);
	r.releaseAll();
	check(r.layer.GetChildren().every(f => f.Visible === false) && r.drawCount() === 0, "releaseAll hides everything");
	r.beginFrame();
	r.drawRect(cam, 0, 0, { zIndex: 9 });
	r.endFrame();
	check(r.poolSize() === 6, "and the pool is reused, never rebuilt", `${r.poolSize()}`);
}

// ================================================================ 8. one clip

section("8) one clip: the world layer's only child is the renderer's layer, which clips to the same rect");
{
	const host = gui.make("Frame");
	const r = new Renderer(host, "Sprites");
	const L = r.layer;
	check(
		L.Parent === host &&
			L.Size.X.Scale === 1 &&
			L.Size.Y.Scale === 1 &&
			L.Size.X.Offset === 0 &&
			L.Size.Y.Offset === 0 &&
			L.Position.X.Scale === 0 &&
			L.Position.X.Offset === 0 &&
			L.Position.Y.Scale === 0 &&
			L.Position.Y.Offset === 0 &&
			L.AnchorPoint.X === 0 &&
			L.AnchorPoint.Y === 0 &&
			L.Rotation === 0 &&
			L.ClipsDescendants === true,
		"the renderer's layer fills its parent exactly, unrotated, and clips",
	);
	const boot = readFileSync(join(SRC, "client", "bootstrap.ts"), "utf8");
	const renderers = [...boot.matchAll(/new Renderer\(worldLayer\b/g)].length;
	const parented = [...boot.matchAll(/\.Parent\s*=\s*worldLayer\b/g)].length;
	check(
		!/worldLayer\.ClipsDescendants/.test(boot) && renderers === 1 && parented === 0,
		"bootstrap: World has no clip of its own, and the Renderer's layer is the only thing put in it",
		`${renderers} renderer(s), ${parented} other child(ren)`,
	);
	// no other file reaches the world layer (ctx.worldLayer is the same Frame)
	const { readdirSync, statSync } = await import("node:fs");
	const files = [];
	const walk = d => {
		for (const e of readdirSync(d)) {
			const p = join(d, e);
			if (statSync(p).isDirectory()) walk(p);
			else if (p.endsWith(".ts")) files.push(p);
		}
	};
	walk(SRC);
	const others = files.filter(
		p => !p.endsWith("bootstrap.ts") && !p.endsWith("context.ts") && /worldLayer/.test(readFileSync(p, "utf8")),
	);
	check(others.length === 0, "and no other source file touches the world layer", others.join(", "));
	check(
		/const worldLayer[\s\S]{0,300}Size = UDim2\.fromScale\(1, 1\)/.test(boot) && !/worldLayer\.Rotation/.test(boot),
		"World itself fills Root, unrotated: the two clips were one and the same rect",
	);
}

// ================================================================ 9. no write without a change

section("9) no write without a change");
{
	const parent = gui.make("Folder");
	const track = new AudioTrack("bgm", parent, gui.make("SoundGroup"), 0.5, 0.5);
	track.set("bgmNight");
	const vol = [];
	const run = frames =>
		watch(() => {
			for (let i = 0; i < frames; i++) track.update(1 / 60, 1);
		});
	const fading = run(30);
	vol.push(fading.byProp["Sound.Volume"] ?? 0);
	run(60);
	const steady = run(120);
	check(
		vol[0] > 0 && (steady.byProp["Sound.Volume"] ?? 0) === 0 && steady.rewrites === 0,
		"a steady music track writes no Volume (not even the same value); a fading one does",
		`fading: ${vol[0]} writes in 30 frames; steady: ${steady.byProp["Sound.Volume"] ?? 0} writes, ${steady.rewrites} rewrites`,
	);
	track.setLevel(0.5);
	const change = run(1);
	check((change.byProp["Sound.Volume"] ?? 0) === 1, "...and a new level is written at once");
	track.stop();
	run(120);
	const silent = run(60);
	check(silent.writes + silent.rewrites === 0, "a stopped track, faded out, writes nothing either");

	const loop = readFileSync(join(SRC, "client", "gameLoop.ts"), "utf8");
	const light = loop.slice(loop.indexOf("private drawLight("), loop.indexOf("private drawLight(") + 600);
	check(
		/if \(ctx\.darkLayer\.BackgroundTransparency !== 1\) ctx\.darkLayer\.BackgroundTransparency = 1;/.test(light),
		"the night layer's transparency is written only if something changed it (GameLoop.drawLight, every frame)",
	);
	const hud = readFileSync(join(SRC, "client", "ui", "hud.ts"), "utf8");
	const touch = hud.slice(hud.indexOf("private updateTouch("));
	const body = touch.slice(0, touch.indexOf("\n\t}\n"));
	check(
		/placeAt\(this\.joyBase, this\.joyAt,/.test(body) &&
			/placeAt\(this\.aimPad, this\.padAt,/.test(body) &&
			!/this\.(joyBase|aimPad)\.Position\s*=/.test(body),
		"the stick's base and the aim pad are placed only when they move (Hud.updateTouch, every frame)",
	);
}

WA.overrideWorldArt(undefined);
console.log(failures === 0 ? "\nall pool checks passed" : `\n${failures} pool check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
