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
 *      and the blood's art: on the warmed pool the fight creates no Frame, UICorner, UIStroke or ImageLabel (the characters' labels
 *      are built hidden by the warm-up), and no layer is reserved far past what the fight shows.
 *   6. THE DRIVER. warmFightPool warms only while the lobby or its menus are up (not behind the boot logo, not
 *      during a run), WARM_PER_FRAME sprites a frame, and lets go of Heartbeat once the pool is warm.
 *   7. THE API. drawCount, poolSize, acquire, release and releaseAll across the buckets.
 *   8. ONE CLIP. The world layer has no clip of its own: its only child is the renderer's layer, which fills it and
 *      clips to the same rect (rotation support off, nothing rotated above either: the two clips were the same).
 *   9. NO WRITE WITHOUT A CHANGE. A steady music track writes no Volume; the night layer and the touch sticks are
 *      written only when they move (source guards: those two only run on the whole client); the audio listener is
 *      moved (a CFrame, an engine call) only when the camera did; a ground item's glint is drawn only while it
 *      flashes (source guard).
 *  10. NO GARBAGE ON THE ACTOR PATHS (M4). A walking horde -- hit flashes fading, spitters winding up, a lit fuse --
 *      builds no Color3 once warm, draws from 4 option tables and writes no property with the value it already had;
 *      a fight's blood reuses its particle and decal records; GameLoop.shadowOffset answers in one scratch.
 *  11. THE CANOPY ASKS A GRID (L6). "Is a body under this crown?" answered from the cells under it, exactly as the
 *      walk over the whole horde answered it, with the grid's arrays kept from frame to frame.
 *  12. THE HORDE'S ORDER (perf audit M2). The real SnapshotBuffer, with its netId table walked in Luau's order: a
 *      spawn under a recycled low netId moves no walker already drawn, and a death at the front moves one walker
 *      into its place (it used to move the whole horde: 280 sprites, 867 writes for 40 walkers).
 *  14. THE BLOOD'S PIXEL ART (ART-15, client/view/bloodView.ts). On the pool warmed with its profile, a 10 s fight's
 *      stains and droplets create no Instance, write no ZIndex and build no Color3; a stain born into a full ring
 *      rewrites one sprite; a stain's whole life under a still camera writes only at its steps, then it is gone.
 *      (The reference fight of 1-5 draws its blood through the same view: flat circles, or cells and squares.)
 *  15. A PANE BREAKING (EDI-18). A window of the fight's screen losing its glass writes only its shards (the ground's
 *      detail layer, under the blood, so a blood decal's birth stays one write) and the roof's edge over it: no ZIndex,
 *      no Instance, and nothing a frame afterwards.
 *  16. THE WEATHER (LUZ-05). A storm on a wet street, the camera running along it, with the puddles' pixel art and
 *      without it (the flat drawing): on the pool warmed with poolWarmup's `weatherPool` no Instance and no ZIndex
 *      write; the streaks and the puddles fit that reservation; a rain draws fewer streaks than a storm, the Low tier
 *      half and Reduce Motion none; the drops sit still with Reduce Motion (the camera still: no write at all) and
 *      move on their beat without it; every puddle on the texel grid, the four shapes all used; the streets dry and
 *      stop drawing.
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
const BV = require(join(SRC, "client/view/bloodView.ts"));
const PS = require(join(SRC, "client/systems/particles.ts"));
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

/** a survivor's fresh blood stain (a ParticleSystem decal record) of diameter `d`, for the real BloodView */
function stainAt(x, y, d) {
	return {
		x,
		y,
		size: d,
		color: COLORS.blood,
		life: 10,
		maxLife: 10,
		kind: PS.DECAL_DROP,
		src: PS.BLOOD_SURVIVOR,
		sector: -1,
		age: 0,
		ground: -1,
		pick: -1,
	};
}

/**
 * A night fight drawn in GameLoop.render's order: the town's ground, blood decals and acid puddles, the town's solids,
 * the horde (a shadow + drawZombie each), 4 survivors, 60 sparks of blood and 40 chips of debris, 12 tracers.
 * `state.town` false leaves the town out. The blood goes through the real client/view/bloodView.ts: flat circles, or
 * with its atlas live (ART-15) one image per stain, square droplets under the bodies and square chips over them.
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
	const newDecal = () => stainAt(AT.x + (rnd() - 0.5) * vw, AT.y + (rnd() - 0.5) * vh, 10 + rnd() * 20);
	const decals = [];
	for (let i = 0; i < 40; i++) decals.push(newDecal());
	const blood = new BV.BloodView();
	const sparks = [];
	for (let i = 0; i < 60; i++) {
		sparks.push({
			x: AT.x + i * 7 - 200,
			y: AT.y - 100 + (i % 7) * 9,
			size: 5,
			color: COLORS.blood,
			life: 0.3,
			maxLife: 0.4,
			src: PS.BLOOD_SURVIVOR,
			tone: i % 3,
		});
	}
	// and the debris of the same fight: chips off a chewed barricade, sparks off a car (over the bodies, as squares
	// with the blood's art)
	const chips = [];
	for (let i = 0; i < 40; i++) {
		chips.push({
			x: AT.x + i * 9 - 180,
			y: AT.y + 60 + (i % 5) * 7,
			size: 5,
			color: COLORS.fence,
			life: 0.3,
			maxLife: 0.6,
			src: PS.BLOOD_NONE,
			tone: i % 3,
		});
	}
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
		const art = WA.artId("blood");
		for (const d of decals) blood.drawDecal(r, cam, v, d, world, art);
		for (const p of puddles) {
			r.drawCircle(cam, p.x, p.y, 40, {
				color: COLORS.acid,
				alpha: 0.45,
				stroke: COLORS.acidRim,
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
		for (const p of sparks) blood.drawParticle(r, cam, v, p, art !== undefined);
		for (const p of chips) blood.drawParticle(r, cam, v, p, art !== undefined);
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
	const extra = stainAt(AT.x + 20, AT.y + 30, 24);
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
		"       (this horde is a plain list, so a death at its front moves every walker after it, in its own layers; the" +
			" game's order is client/net/snapshotBuffer.ts's, where a death moves one walker: section 12)",
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

	// images: a character's cell is a Frame and its ImageLabel, and both can be built ahead
	const ri = new Renderer(gui.make("Frame"), "Sprites");
	ri.setView(1280, 720);
	ri.reserve(Z.zombie, 6, 0, 0, 4);
	const ci = gui.stats.created;
	while (ri.warm(3) > 0);
	const cells = ri.layer.GetChildren();
	const labels = cells.map(f => f.FindFirstChildOfClass("ImageLabel")).filter(l => l !== undefined);
	check(
		cells.length === 6 &&
			labels.length === 4 &&
			gui.stats.created - ci === 10 &&
			labels.every(l => l.Visible === false && (l.Image ?? "") === ""),
		"reserve(z, 6, 0, 0, 4): 6 sprites, 4 with a hidden ImageLabel that shows no picture yet (10 Instances)",
		`${cells.length} sprites, ${labels.length} labels, ${gui.stats.created - ci} Instances`,
	);
	const cellDraw = watch(() => {
		ri.beginFrame();
		for (let i = 0; i < 4; i++) {
			ri.drawRect(cam, i * 40, 60, {
				w: 32,
				h: 32,
				image: "rbxassetid://7",
				rectX: i * 32,
				rectY: 0,
				rectW: 32,
				rectH: 32,
				zIndex: Z.zombie,
			});
		}
		ri.endFrame();
	});
	check(
		cellDraw.created === 0 &&
			labels.every(
				(l, i) => l.Visible === true && l.Image === "rbxassetid://7" && l.ImageRectOffset.X === i * 32,
			),
		"a sheet's cells drawn on them create nothing and show their picture and cell",
		`${cellDraw.created} created`,
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
	PW.reserveFightPool(S.r, 1920, 1080, zArt, sArt, BV.bloodArtLive());
	const c0 = gui.stats.created;
	const images0 = gui.stats.byClass.ImageLabel ?? 0;
	let frames = 0;
	while (S.r.warm(PW.WARM_PER_FRAME) > 0) frames++;
	frames++;
	const warmed = S.r.poolSize();
	const instances = gui.stats.created - c0;
	const warmedImages = (gui.stats.byClass.ImageLabel ?? 0) - images0;
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
		`       ${label}: ${warmed} sprites (${instances} Instances, ${warmedImages} of them ImageLabels) warmed in ${frames} frames of ${PW.WARM_PER_FRAME}`,
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
	// and the weather a fight may happen in (LUZ-05, §16), its puddles flat as the art is here
	PW.reserveWeatherPool(ref, 1920, 1080, false);
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

	// the audio listener follows the camera: a CFrame and an engine call only when the camera moved (L2)
	const { audio } = require(join(SRC, "client/audio/audio.ts"));
	const hadCFrame = globalThis.CFrame;
	const hadVector3 = globalThis.Vector3;
	const hadPcall = globalThis.pcall;
	let calls = 0;
	globalThis.pcall = (fn, ...a) => {
		calls++;
		try {
			return [true, fn(...a)];
		} catch (e) {
			return [false, e];
		}
	};
	let cframes = 0;
	globalThis.CFrame = class {
		constructor() {
			cframes++;
		}
	};
	globalThis.Vector3 = class {};
	audio.started = true;
	audio.setListener(1000, 2000);
	const first = cframes;
	for (let f = 0; f < 120; f++) audio.setListener(1000 + (f % 2) * 0.4, 2000);
	const still = cframes - first;
	for (let f = 1; f <= 60; f++) audio.setListener(1000 + f * 3, 2000);
	const moving = cframes - first - still;
	audio.started = false;
	globalThis.CFrame = hadCFrame;
	globalThis.Vector3 = hadVector3;
	globalThis.pcall = hadPcall;
	const items = readFileSync(join(SRC, "client", "view", "groundItemsView.ts"), "utf8");
	check(
		/if \(t >= GLINT_LEN\) return;/.test(items) && !/t < GLINT_LEN \?/.test(items),
		"a ground item's two glint sprites are drawn only while it flashes, not transparent between flashes (groundItemsView)",
	);
	check(
		first === 1 && still === 0 && moving === 60 && calls === 61,
		"the audio listener builds a CFrame and calls the engine only when the camera moved (still or creeping: never)",
		`first ${first}, 120 still frames ${still}, 60 moving frames ${moving}; ${calls} engine calls`,
	);
}

// ================================================================ 10. no garbage on the actor paths

section("10) no garbage per frame on the actor paths (M4): option tables, colours, particle records");
{
	WA.overrideWorldArt({});
	const C = globalThis.Color3;
	const lerp = C.prototype.Lerp;
	const fromRGB = C.fromRGB;
	let built = 0;
	C.prototype.Lerp = function (...a) {
		built++;
		return lerp.apply(this, a);
	};
	C.fromRGB = (...a) => {
		built++;
		return fromRGB(...a);
	};
	const r = new Renderer(gui.make("Frame"), "Sprites");
	const cam = new Camera();
	cam.setView(1280, 720);
	r.setView(1280, 720);
	const opts = new Set();
	const draw = r.drawRect.bind(r);
	r.drawRect = (c, x, y, o) => {
		opts.add(o);
		return draw(c, x, y, o);
	};
	// 40 walkers of every type: 4 hit, 2 spitters winding up, one lit fuse; the hit flash fades 1 -> 0 over 60 frames
	const horde = [];
	for (let i = 0; i < 40; i++)
		horde.push({ x: (i % 10) * 110 - 500, y: Math.floor(i / 10) * 140 - 250, a: i * 0.7, kind: 1 + (i % 5) });
	const frame = f => {
		r.beginFrame();
		for (const [i, z] of horde.entries()) {
			z.x += Math.cos(z.a) * 0.5;
			const flash = i < 4 ? 1 - (f % 60) / 60 : 0;
			const windup = i === 6 || i === 11 ? (f % 50) / 5 : 0;
			HV.drawZombie(
				r,
				cam,
				z.x,
				z.y,
				z.a,
				1,
				z.kind,
				flash,
				1,
				f * 0.09 + i,
				Z.zombie,
				windup,
				false,
				false,
				i === 7,
			);
		}
		r.endFrame();
	};
	for (let f = 0; f < 300; f++) frame(f);
	built = 0;
	opts.clear();
	const w = watch(() => {
		for (let f = 300; f < 600; f++) frame(f);
	});
	check(
		built === 0,
		"300 frames of a walking horde, a flash fading and spitters winding up: not one Color3 built once warm",
		`${built} Color3`,
	);
	check(
		opts.size() <= 4,
		"every walker is drawn from the same 4 option tables (feet, arms, body, head)",
		`${opts.size()}`,
	);
	check(
		w.rewrites === 0,
		"and no property is written again with the value it had (a fresh Color3 each frame was an engine write each frame)",
		`${(w.writes / 300).toFixed(0)} writes/frame, ${w.rewrites} same-value rewrites`,
	);
	C.prototype.Lerp = lerp;
	C.fromRGB = fromRGB;

	// blood: a fight's sprays and splats reuse their records
	const { ParticleSystem } = require(join(SRC, "client/systems/particles.ts"));
	const ps = new ParticleSystem();
	const seen = new Set();
	let fresh = 0;
	let sprayed = 0;
	const fight = f => {
		if (f % 6 === 0) {
			ps.bloodBurst(f % 300, 40, 12, "zombie", 0.5);
			sprayed += 12;
		}
		if (f % 9 === 0) {
			ps.debrisBurst(f % 200, 10, 6, COLORS.fence);
			sprayed += 6;
		}
		ps.update(1 / 60);
		for (const p of ps.active()) if (!seen.has(p)) (seen.add(p), fresh++);
		for (const d of ps.decalRecords()) if (!seen.has(d)) (seen.add(d), fresh++);
	};
	for (let f = 0; f < 1200; f++) fight(f);
	fresh = 0;
	sprayed = 0;
	for (let f = 1200; f < 2400; f++) fight(f);
	// a new record only when the fight reaches a new peak of live particles (the free list grows to it, once)
	check(
		fresh <= 12,
		"20 s of a fight's blood and debris after a warm-up: records reused (free list, decal ring rewritten in place)",
		`${fresh} new records for ${sprayed} particles sprayed; ${ps.active().length} particles, ${ps.decalRecords().length} decals live`,
	);
	// the same with the blood's pixel art (ART-15): stains live a game day, join and smear, and still reuse their records
	ps.clear();
	ps.pixelArt = true;
	for (let f = 0; f < 1200; f++) fight(f);
	fresh = 0;
	sprayed = 0;
	for (let f = 1200; f < 2400; f++) fight(f);
	check(
		fresh <= 12,
		"...and with the pixel art's stains (a game day long, joined, smeared): records reused all the same",
		`${fresh} new records for ${sprayed} particles sprayed; ${ps.decalRecords().length} decals live`,
	);

	const loop = readFileSync(join(SRC, "client", "gameLoop.ts"), "utf8");
	const shadow = loop.slice(loop.indexOf("private shadowOffset("), loop.indexOf("private drawDecals("));
	check(
		/return out;/.test(shadow) && !/return \{/.test(shadow),
		"GameLoop.shadowOffset answers in one scratch, like drawKit's (a table per solid, item and actor before)",
	);
}

// ================================================================ 11. the canopy asks a grid

section("11) a tree's canopy asks the cells under its crown, not the whole horde (L6)");
{
	const { BodyGrid } = require(join(SRC, "client/view/bodyGrid.ts"));
	const grid = new BodyGrid();
	let seed = 11;
	const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
	let mismatch = "";
	let asked = 0;
	for (let frame = 0; frame < 40 && mismatch === ""; frame++) {
		// a horde around a point of the town, some bodies exactly on a cell's edge, and a few outside the map
		const bodies = [];
		for (let i = 0; i < 150; i++) {
			const edge = i % 17 === 0;
			bodies.push({
				x: edge ? 256 * (30 + (i % 7)) : 7000 + (rnd() - 0.5) * 3000 - (i % 23 === 0 ? 9000 : 0),
				y: edge ? 256 * (40 + (i % 5)) : 10000 + (rnd() - 0.5) * 2000,
			});
		}
		grid.clear();
		for (const b of bodies) grid.add(b.x, b.y);
		for (let t = 0; t < 60; t++) {
			const x = 7000 + (rnd() - 0.5) * 3400;
			const y = 10000 + (rnd() - 0.5) * 2400;
			const r = 60 + rnd() * 200;
			const linear = bodies.some(b => (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y) < r * r);
			asked++;
			if (grid.anyWithin(x, y, r) !== linear) mismatch = `(${x.toFixed(0)}, ${y.toFixed(0)}) r ${r.toFixed(0)}`;
		}
	}
	check(
		mismatch === "",
		"the grid answers exactly as the walk over the whole horde did",
		`${asked} questions ${mismatch}`,
	);
	const fill = () => {
		grid.clear();
		for (let i = 0; i < 150; i++) grid.add(7000 + (i % 15) * 90, 10000 + Math.floor(i / 15) * 90);
		grid.anyWithin(7400, 10300, 120);
	};
	fill();
	const cellArrays = grid.arrays.length;
	for (let f = 0; f < 60; f++) fill();
	check(
		grid.size() === 150 && grid.arrays.length === cellArrays,
		"refilled every frame, it keeps its cells' arrays (none made after the first fill)",
		`${grid.arrays.length} arrays`,
	);
	const loop = readFileSync(join(SRC, "client", "gameLoop.ts"), "utf8");
	const canopy = loop.slice(
		loop.indexOf("private updateCanopy("),
		loop.indexOf("// ---", loop.indexOf("private updateCanopy(")),
	);
	check(
		/this\.underCanopy\.anyWithin\(cx, cy, r\)/.test(canopy) && !/for \(const z of this\.zombies\)/.test(canopy),
		"GameLoop.updateCanopy asks the grid, filled once a frame (it walked every zombie for every tree)",
	);
}

// ================================================================ 12. the horde's own order

section("12) the horde's draw order is the snapshot buffer's: a spawn or a death moves one walker, not the horde");
{
	/*
	 * perf audit M2. The view draws `SnapshotBuffer.zombieStates()` in its order, and the renderer hands out sprite
	 * slots by it. That order was the iteration order of the buffer's netId -> track table: in Luau a table keyed by
	 * small integers walks them in key order (its array part), so a recycled LOW netId -- or a rehash -- put a new
	 * body in front of the horde and moved every walker's sprites; a death at the front did the same. The Node Map
	 * walks in insertion order, so the table is given Luau's order here (ascending keys) to measure what Roblox does.
	 */
	const { SnapshotBuffer } = require(join(SRC, "client/net/snapshotBuffer.ts"));
	const root = gui.make("Frame");
	const r = new Renderer(root, "Sprites");
	const cam = new Camera();
	cam.setView(1280, 720);
	r.setView(1280, 720);
	cam.x = AT.x;
	cam.y = AT.y;
	const buf = new SnapshotBuffer();
	buf.setRate(60);
	const table = buf.zombies;
	if (table instanceof Map) {
		table[Symbol.iterator] = function* luauOrder() {
			for (const k of [...Map.prototype.keys.call(this)].sort((a, b) => a - b)) yield [k, this.get(k)];
		};
	}
	const bodies = new Map();
	const place = id => ({
		x: AT.x - 500 + ((id * 97) % 1000),
		y: AT.y - 280 + ((id * 53) % 560),
		angle: (id % 8) * 0.7,
		type: 1 + (id % 5),
	});
	// netIds 2..41: netId 1 died a while ago and is free again (§4.4: reused after 2 s)
	for (let id = 2; id <= 41; id++) bodies.set(id, place(id));
	let tick = 3000;
	let now = 0;
	const feed = () => {
		const zombies = [];
		for (const [netId, b] of bodies) {
			zombies.push({
				netId,
				x: b.x,
				y: b.y,
				angle: b.angle,
				flags: 0,
				type: b.type,
				big: false,
				mid: false,
				aware: 0,
			});
		}
		buf.receive({ tick: tick % 65536, part: 0, parts: 1, players: [], zombies, bosses: [] }, tick, now);
	};
	const frame = () => {
		tick += 1;
		now += 1 / 60;
		if (tick % 3 === 0) feed();
		buf.advance(1 / 60, tick, now);
		r.beginFrame();
		for (const z of buf.zombieStates()) {
			r.drawCircle(cam, z.x + 3, z.y + 9, 38, {
				color: COLORS.shadow,
				alpha: 0.3 * z.alpha,
				zIndex: Z.actorShadow,
			});
			HV.drawZombie(
				r,
				cam,
				z.x,
				z.y,
				z.angle,
				1,
				z.type,
				0,
				z.alpha,
				z.feetCycle,
				Z.zombie,
				0,
				false,
				false,
				false,
			);
		}
		r.endFrame();
	};
	const sprites = () => {
		const out = new Set();
		const walk = f => {
			for (const c of f.GetChildren()) {
				if (c.ClassName === "Frame") out.add(c);
				walk(c);
			}
		};
		walk(r.layer);
		return out;
	};
	/** runs `fn` and counts the sprites that EXISTED before it and had a property changed */
	const moved = fn => {
		const before = sprites();
		const w = watch(fn);
		let n = 0;
		for (const f of w.touched) if (before.has(f)) n += 1;
		return { n, writes: w.writes, zWrites: w.zWrites };
	};
	for (let i = 0; i < 180; i++) frame(); // every body in, faded in, standing still
	const perWalker = r.drawCount() / bodies.size();
	const idle = moved(() => {
		for (let i = 0; i < 30; i++) frame();
	});
	check(idle.writes === 0, "a still horde of 40 writes nothing", `${idle.writes} writes in 30 frames`);

	// a spawn under the recycled netId 1: the lowest of all
	bodies.set(1, place(1));
	const spawn = moved(() => {
		for (let i = 0; i < 3; i++) frame();
	});
	check(
		spawn.n === 0 && spawn.zWrites === 0,
		"a spawn under a recycled low netId moves no walker already drawn (it is drawn after them)",
		`${spawn.n} existing sprites changed, ${spawn.writes} writes; one walker is ${perWalker.toFixed(0)} sprites`,
	);
	for (let i = 0; i < 60; i++) frame();

	// a death at the front of the order: the reliable ZombieDied takes the body away at once
	const first = buf.zombieStates()[0].netId;
	bodies.delete(first);
	const death = moved(() => {
		buf.forgetZombie(first, tick);
		frame();
	});
	check(
		death.n <= 2 * perWalker && death.zWrites === 0,
		"a death at the front moves one walker into its place (two walkers' sprites at most), not the horde",
		`${death.n} existing sprites changed, ${death.writes} writes; the horde is ${r.drawCount()} sprites`,
	);
	const ids = buf.zombieStates().map(z => z.netId);
	check(
		ids.length === bodies.size() && new Set(ids).size() === ids.length && !ids.includes(first),
		"and the order still holds every body once, and not the dead one",
		`${ids.length} drawn`,
	);
}

// ================================================================ 13. the ground items (ITM-07)

section("13) ground items (ITM-07): drops, a pile, the target and the glint -- no Instance after the warm-up");
{
	const { GroundItemsView, hopHeight, HOP_TIME, PILE_SPREAD } = require(join(SRC, "client/view/groundItemsView.ts"));
	const RULE = require(join(SRC, "shared/sim/pickupRule.ts"));
	/** a street's worth of loot: every kind, a boss's pile of six on one spot, and a drop every half second */
	const street = () => {
		const root = gui.make("Frame");
		const r = new Renderer(root, "Sprites");
		r.setView(1280, 720);
		const cam = new Camera();
		cam.setView(1280, 720);
		cam.x = 3000;
		cam.y = 3000;
		const shadow = { x: 0, y: 0 };
		const view = new GroundItemsView((x, y, len) => {
			shadow.x = 0.7 * len;
			shadow.y = 0.7 * len;
			return shadow;
		});
		const kinds = [
			[1, 0],
			[1, 10],
			[1, 16],
			[2, 4],
			[2, 13],
			[3, 12],
			[3, 17],
			[4, 23],
			[4, 44],
			[4, 45],
			[4, 48],
			[4, 30],
		];
		let id = 100;
		const items = [];
		const drop = (k, x, y, moving) => {
			id += 1;
			const [kind, itemId] = kinds[k % kinds.length];
			items.push({ id, kind, itemId, count: 3, x, y, vx: moving ? 120 : 0, vy: moving ? -40 : 0 });
		};
		for (let i = 0; i < 36; i++) drop(i, 2500 + (i % 12) * 80, 2800 + Math.floor(i / 12) * 90, false);
		for (let i = 0; i < 6; i++) drop(i * 3, 3300, 3100, false);
		let clock = 0;
		let f = 0;
		const frame = () => {
			f += 1;
			clock += 1 / 60;
			// a drop lands every 30 frames and the oldest drop is picked up: six in play, on seven spots in turn (a
			// steady street, so the warm-up has seen its busiest frame)
			if (f % 30 === 0) {
				const n = f / 30;
				drop(n, 2600 + (n % 7) * 90, 3200, true);
				if (items.length > 42 + 6) items.splice(42, 1);
			}
			for (const it of items) {
				if (it.vx === 0 && it.vy === 0) continue;
				it.x += it.vx / 60;
				it.y += it.vy / 60;
				it.vx *= 0.9;
				it.vy *= 0.9;
				if (it.vx * it.vx + it.vy * it.vy < 1) {
					it.vx = 0;
					it.vy = 0;
				}
			}
			view.target = items[(Math.floor(f / 45) * 7) % items.length].id;
			view.reduceMotion = f % 600 >= 450;
			r.beginFrame();
			view.draw(r, cam, cam.viewRect(32), items, clock, 1 / 60);
			r.endFrame();
		};
		return { r, view, items, frame };
	};
	for (const [label, ids] of [
		["flat looks (no atlas id)", {}],
		["the icons' atlas", { itemIcons: "rbxassetid://4242" }],
	]) {
		WA.overrideWorldArt(ids);
		const S = street();
		for (let i = 0; i < 4200; i++) S.frame();
		const w = watch(() => {
			for (let i = 0; i < 600; i++) S.frame();
		});
		check(
			w.created === 0,
			`${label}: 600 frames of drops, pickups, a pile, the target moving and the glint create no Instance`,
			`${w.created} created`,
		);
		check(
			w.zWrites === 0,
			`${label}: ...and write no ZIndex (glint and brackets have buckets of their own)`,
			`${w.zWrites} ZIndex writes`,
		);
		console.log(
			`       ${label}: ${S.r.drawCount()} sprites for ${S.items.length} items, ${(w.writes / 600).toFixed(0)} writes/frame [${top(w.byProp, 600)}]; pool ${S.r.poolSize()}`,
		);
	}
	WA.overrideWorldArt({ itemIcons: "rbxassetid://4242" });
	// what one item costs with the atlas: the icon and its shadow; gear adds its ring (2); the target its brackets (8)
	const one = (kind, itemId, target) => {
		const root = gui.make("Frame");
		const r = new Renderer(root, "Sprites");
		r.setView(200, 200);
		const cam = new Camera();
		cam.setView(200, 200);
		cam.x = 1000;
		cam.y = 1000;
		const view = new GroundItemsView(() => ({ x: 1, y: 1 }));
		view.reduceMotion = true;
		view.target = target ? 5 : -1;
		r.beginFrame();
		view.draw(
			r,
			cam,
			cam.viewRect(32),
			[{ id: 5, kind, itemId, count: 1, x: 1000, y: 1000, vx: 0, vy: 0 }],
			1.3,
			0,
		);
		r.endFrame();
		return r.drawCount();
	};
	const supply = one(4, 23, false);
	const gear = one(1, 10, false);
	const targeted = one(1, 10, true);
	check(
		supply === 2 && gear === 4 && targeted === 12,
		`with the atlas an item is 2 sprites (icon + shadow), gear 4 (its ring), the target 12 (its brackets)`,
		`${supply} / ${gear} / ${targeted}`,
	);
	// the hop: two arcs that land, and nothing with Reduce Motion
	check(
		hopHeight(0) === 0 &&
			hopHeight(HOP_TIME * 0.3) > 4 &&
			hopHeight(HOP_TIME) === 0 &&
			hopHeight(HOP_TIME + 1) === 0,
		`a drop hops twice and lands (${HOP_TIME.toFixed(2)} s)`,
	);
	// a pile fans out, every item off the spot, apart from each other
	{
		const root = gui.make("Frame");
		const r = new Renderer(root, "Sprites");
		r.setView(300, 300);
		const cam = new Camera();
		cam.setView(300, 300);
		cam.x = 1000;
		cam.y = 1000;
		const at = [];
		const draw = r.drawRect.bind(r);
		r.drawRect = (c, x, y, o) => {
			if (o.zIndex === Z.item) at.push([x, y]);
			return draw(c, x, y, o);
		};
		const view = new GroundItemsView(() => ({ x: 0, y: 0 }));
		view.reduceMotion = true;
		const pile = [];
		for (let i = 0; i < 6; i++)
			pile.push({ id: 300 + i, kind: 4, itemId: 23 + i, count: 1, x: 1000, y: 1000, vx: 0, vy: 0 });
		r.beginFrame();
		view.draw(r, cam, cam.viewRect(32), pile, 1.3, 0);
		r.endFrame();
		// the icon is drawn centred on its drawn box: compare the boxes' centres, the icon offset taken back out
		let closest = Infinity;
		for (let i = 0; i < at.length; i++)
			for (let j = 0; j < i; j++)
				closest = Math.min(closest, Math.hypot(at[i][0] - at[j][0], at[i][1] - at[j][1]));
		check(
			at.length === 6 && closest >= 12,
			`six items on one spot fan out (at least ${PILE_SPREAD} u off it), no two icons closer than 12 u`,
			`${at.length} icons, closest ${closest.toFixed(1)} u`,
		);
	}
	// the tiers
	check(
		RULE.groundTier(1, 25) === "rare" &&
			RULE.groundTier(2, 14) === "rare" &&
			RULE.groundTier(1, 28) === "rare" &&
			RULE.groundTier(1, 10) === "gear" &&
			RULE.groundTier(2, 13) === "gear" &&
			RULE.groundTier(4, 23) === "supply" &&
			RULE.groundTier(3, 12) === "supply",
		"tiers: a boss's trophy or a golden weapon is rare, a weapon or equipment gear, the rest supplies",
	);
	WA.overrideWorldArt(undefined);
}

// ================================================================ 14. the blood's pixel art (ART-15)

section("14) the blood's pixel art (ART-15): a stain born costs one sprite, drying writes only at its steps, no churn");
{
	WA.overrideWorldArt(allIds());
	const root = gui.make("Frame");
	const r = new Renderer(root, "Sprites");
	const cam = new Camera();
	cam.setView(1920, 1080);
	r.setView(1920, 1080);
	cam.x = AT.x;
	cam.y = AT.y;
	const blood = new BV.BloodView();
	const ps = new PS.ParticleSystem();
	ps.pixelArt = true;
	const frame = () => {
		const v = cam.viewRect(32);
		r.beginFrame();
		blood.drawDecals(r, cam, v, ps, world);
		blood.drawParticles(r, cam, v, ps);
		r.endFrame();
	};
	// the warm-up the lobby does, then a fight: shots with a direction, kills, bites, chips
	PW.reserveFightPool(r, 1920, 1080, true, true, BV.bloodArtLive());
	while (r.warm(PW.WARM_PER_FRAME) > 0);
	// the first frame of a fight on the warmed pool: 34 stains and 6 kills (40 stains, 60 droplets) and a car's 40
	// sparks at once create nothing
	{
		const first = new PS.ParticleSystem();
		first.pixelArt = true;
		for (let i = 0; i < 34; i++) {
			first.addDecal(
				AT.x - 800 + i * 40,
				AT.y + ((i * 37) % 400) - 200,
				30,
				COLORS.bloodHorde,
				PS.DECAL_SPLAT,
				PS.BLOOD_HORDE,
			);
		}
		for (let i = 0; i < 6; i++) first.bloodBurst(AT.x - 300 + i * 120, AT.y, 10, "zombie");
		for (let i = 0; i < 8; i++) first.debrisBurst(AT.x + 200, AT.y + 100, 5, COLORS.car);
		const v = cam.viewRect(32);
		const w0 = watch(() => {
			r.beginFrame();
			blood.drawDecals(r, cam, v, first, world);
			blood.drawParticles(r, cam, v, first);
			r.endFrame();
		});
		const chipsDrawn = r.layer.GetChildren().filter(f => f.Visible !== false && f.ZIndex === Z.particle).length;
		check(
			w0.created === 0 && chipsDrawn === 40,
			"the warm-up covers a fight's first frame: 40 stains, 60 droplets and 40 chips of debris (their own layer) create nothing",
			`${w0.created} created, ${chipsDrawn} chips shown`,
		);
	}
	const fight = f => {
		if (f % 8 === 0)
			ps.bloodBurst(AT.x + ((f * 37) % 900) - 450, AT.y + ((f * 53) % 500) - 250, 3, "zombie", f * 0.4);
		if (f % 45 === 7) ps.bloodBurst(AT.x + ((f * 29) % 800) - 400, AT.y + ((f * 17) % 400) - 200, 10, "zombie");
		if (f % 70 === 11) ps.bloodBurst(AT.x, AT.y + 40, 4, "player", f);
		if (f % 50 === 3) ps.debrisBurst(AT.x + 90, AT.y + 90, 5, COLORS.fence);
		ps.update(1 / 60);
		frame();
	};
	for (let f = 0; f < 600; f++) fight(f);
	const C = globalThis.Color3;
	const lerp = C.prototype.Lerp;
	const fromRGB = C.fromRGB;
	let built = 0;
	C.prototype.Lerp = function (...a) {
		built++;
		return lerp.apply(this, a);
	};
	C.fromRGB = (...a) => {
		built++;
		return fromRGB(...a);
	};
	const w = watch(() => {
		for (let f = 600; f < 1200; f++) fight(f);
	});
	C.prototype.Lerp = lerp;
	C.fromRGB = fromRGB;
	check(
		w.created === 0 && w.zWrites === 0 && built === 0,
		"a 10 s fight's blood on the warmed pool: no Instance, no ZIndex write, not one Color3 built",
		`${w.created} created, ${w.zWrites} ZIndex, ${built} Color3; ${(w.writes / 600).toFixed(0)} writes/frame [${top(w.byProp, 600)}]`,
	);

	// a full ring: the stain shed longest ago gives its record, and its sprite, to the newest -- nothing else moves
	ps.clear();
	for (let i = 0; i < 160; i++) {
		ps.addDecal(
			AT.x - 600 + (i % 20) * 60,
			AT.y - 300 + Math.floor(i / 20) * 70,
			30,
			COLORS.bloodHorde,
			PS.DECAL_SPLAT,
			PS.BLOOD_HORDE,
		);
		ps.update(0.05);
	}
	frame();
	frame();
	const born = watch(() => {
		ps.addDecal(AT.x + 3, AT.y + 250, 30, COLORS.bloodHorde, PS.DECAL_SPLAT, PS.BLOOD_HORDE);
		frame();
	});
	check(
		born.touched.size() === 1 && born.zWrites === 0 && born.created === 0,
		"a stain born into a full ring (160) rewrites one sprite: the one of the stain it replaced",
		`${born.writes} writes on ${born.touched.size()} sprite(s)`,
	);

	// one stain drying under a still camera: writes only at its steps (wet -> matte, 5 tints, 5 fades), then it is gone
	ps.clear();
	ps.addDecal(AT.x, AT.y, 30, COLORS.blood, PS.DECAL_SPLAT, PS.BLOOD_SURVIVOR);
	frame();
	frame();
	let steps = 0;
	let quiet = 0;
	const life = watch(() => {
		for (let t = 0; t < PS.BLOOD_LIFE_S + 5; t += 0.5) {
			const before = gui.stats.writes;
			ps.update(0.5);
			frame();
			if (gui.stats.writes > before) steps++;
			else quiet++;
		}
	});
	const shown = r.layer.GetChildren().filter(f => f.Visible !== false && f.ZIndex === Z.decal).length;
	check(
		steps <= 1 + BV.BLOOD_DRY_STEPS + BV.BLOOD_FADE_STEPS + 1 && life.writes <= 3 * steps && shown === 0,
		`a stain's whole life (${PS.BLOOD_LIFE_S} s) under a still camera: ${steps} frames write (${life.writes} writes), ${quiet} write nothing; then it is gone`,
	);
	WA.overrideWorldArt(undefined);
}

// ================================================================ 15. window glass

section("15) window glass (EDI-18): a pane breaking in view touches only its own layers, no ZIndex, no Instance");
{
	const WIN = require(join(SRC, "shared/game/windows.ts"));
	// the windows of the reference fight's screen (the gun shop's, born broken on this seed: glass is put in to break it)
	const panes = [];
	for (const s of world.solids) {
		if (s.kind !== "building" || s.openings === undefined) continue;
		for (const o of s.openings) {
			if (o.kind !== "window" || o.glass === undefined) continue;
			if (Math.abs(o.x - AT.x) < 600 && Math.abs(o.y - AT.y) < 330) panes.push(o.glass);
		}
	}
	check(panes.length > 0, "the reference fight's screen has windows", `${panes.length}`);
	const pane = panes[0];
	const generated = WIN.windowIntact(pane);
	// the shards on the ground, and the roof's edge over the window (its strip, the glint or the stubs of glass)
	const layers = new Set([Z.floorDetail + 1, Z.roof + 2, Z.roof + 3]);
	for (const [label, ids] of [
		["flat", {}],
		["art", allIds()],
	]) {
		WA.overrideWorldArt(ids);
		const S = makeFight(1280, 720);
		// warm-up: both states drawn once
		S.frame();
		WIN.setWindowGlass(pane, false);
		S.frame();
		WIN.setWindowGlass(pane, true);
		S.frame();
		const brk = watch(() => {
			WIN.setWindowGlass(pane, false);
			S.frame();
		});
		check(
			brk.created === 0 && brk.zWrites === 0 && [...brk.touched].every(f => layers.has(f.ZIndex)),
			`${label}: the pane breaking writes only the shards and the roof's edge (Z.floorDetail + 1, Z.roof + 2..3), no ZIndex, nothing created`,
			`${brk.writes} writes on ${brk.touched.size()} sprites: ${top(brk.byProp)}`,
		);
		const after = watch(() => {
			for (let f = 0; f < 30; f++) S.frame();
		});
		check(
			after.writes === 0 && after.created === 0,
			`${label}: then the open frame costs nothing a frame (still camera)`,
			`${after.writes} writes in 30 frames`,
		);
		WIN.setWindowGlass(pane, generated);
	}
	WA.overrideWorldArt({});
}

// ================================================================ 16. the weather (LUZ-05)

section("16) the weather (LUZ-05): a storm's streaks and a wet street's puddles -- no Instance after the warm-up");
{
	const WV = require(join(SRC, "client/view/weatherView.ts"));
	const { WORLD_TEXEL } = require(join(SRC, "client/view/worldArtAssets.ts"));
	// the puddles' textures live under fake ids (and the drop's ring), or none of them (the flat drawing)
	const puddleIds = {};
	[...WV.PUDDLE_ART, ...WV.PUDDLE_ART_V, "puddleDrop"].forEach((n, i) => (puddleIds[n] = `rbxassetid://${9100 + i}`));
	// the longest plain street of the town, walked along its length at a run's pace, in a storm
	const road = [...world.roads]
		.filter(r => !r.avenue)
		.sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || a.x - b.x || a.y - b.y)[0];
	const run = ({ art, low = false, reduceMotion = false, frames = 600, storm = true, still = false } = {}) => {
		WA.overrideWorldArt(art ? puddleIds : {});
		const r = new Renderer(gui.make("Frame"), "Sprites");
		const cam = new Camera();
		cam.setView(1920, 1080);
		r.setView(1920, 1080);
		PW.reserveWeatherPool(r, 1920, 1080, WV.puddleArtLive());
		while (r.warm(1000) > 0);
		const view = new WV.WeatherView();
		const f = { clock: 0, reduceMotion, low };
		let maxRain = 0;
		let maxWet = 0;
		let images = 0;
		// the still camera: on the first puddle of the town (the drops' spots are its own)
		const p0 = WV.puddlesOf(world)[0];
		const frame = i => {
			const t = i / 60;
			f.clock = t;
			if (still) {
				cam.x = p0.x;
				cam.y = p0.y;
			} else {
				cam.x = road.vertical ? road.x + road.w / 2 : road.x + 300 + t * 250;
				cam.y = road.vertical ? road.y + 300 + t * 250 : road.y + road.h / 2;
			}
			view.step(1 / 60, true, storm);
			r.beginFrame();
			const v = cam.viewRect(32);
			view.drawPuddles(r, cam, v, world, f);
			// the still camera watches the puddles alone (the streaks fall every frame, by design)
			if (!still) view.drawRain(r, cam, v, f);
			r.endFrame();
			let rain = 0;
			let wet = 0;
			for (const s of r.layer.GetChildren()) {
				if (s.Visible === false) continue;
				if (s.ZIndex === Z.rain) rain++;
				else if (s.ZIndex === Z.wet) {
					wet++;
					if (s.FindFirstChild("I")?.Visible === true) images++;
				}
			}
			maxRain = Math.max(maxRain, rain);
			maxWet = Math.max(maxWet, wet);
		};
		// the first second off the books: the view settles and the camera's first frames place every sprite
		if (still) for (let i = 0; i < 60; i++) frame(i);
		const w = watch(() => {
			for (let i = still ? 60 : 0; i < (still ? 60 : 0) + frames; i++) frame(i);
		});
		return { w, maxRain, maxWet, images, r };
	};
	for (const art of [true, false]) {
		const look = art ? "pixel art" : "flat";
		const storm = run({ art });
		const reserved = new Map(PW.weatherPool(art).map(([z, n]) => [z, n]));
		check(
			storm.w.created === 0 && storm.w.zWrites === 0,
			`${look}: 10 s of a storm on a wet street, the camera running along it: no Instance on the warmed pool, no ZIndex write`,
			`${storm.w.created} Instances; ${(storm.w.writes / 600).toFixed(1)} writes a frame (${top(storm.w.byProp, 600, 4)})`,
		);
		check(
			storm.maxRain <= reserved.get(Z.rain) &&
				storm.maxWet <= reserved.get(Z.wet) &&
				storm.maxRain >= reserved.get(Z.rain) * 0.75 &&
				storm.maxWet >= reserved.get(Z.wet) * 0.25,
			`${look}: what it draws fits what the warm-up reserved, and the reservation is not far past it`,
			`streaks ${storm.maxRain} of ${reserved.get(Z.rain)}, puddle sprites up to ${storm.maxWet} of ${reserved.get(Z.wet)}`,
		);
		check(
			art ? storm.images > 0 : storm.images === 0,
			art
				? "pixel art: the puddles and their drops are images"
				: "flat: no image anywhere (the textures have no id)",
			`${storm.images} image sprites drawn`,
		);
		const rain = run({ art, storm: false });
		const low = run({ art, low: true });
		const calm = run({ art, reduceMotion: true });
		check(
			rain.maxRain < storm.maxRain && low.maxRain <= Math.ceil(storm.maxRain / 2) && calm.maxRain === 0,
			`${look}: a rain draws fewer streaks than a storm, the Low tier half, and Reduce Motion none`,
			`storm ${storm.maxRain}, rain ${rain.maxRain}, Low ${low.maxRain}, Reduce Motion ${calm.maxRain}`,
		);
		check(
			low.maxWet <= storm.maxWet / 2 + 1 && calm.maxWet === storm.maxWet,
			`${look}: Low draws the puddles without their drops${art ? "" : " and sheen"}; Reduce Motion keeps the drops (still)`,
			`puddle sprites: High ${storm.maxWet}, Low ${low.maxWet}, Reduce Motion ${calm.maxWet}`,
		);
		// the camera still, the rain steady: with Reduce Motion nothing moves, so nothing is written; without it only
		// the drops, one move per drop per beat
		const stillCalm = run({ art, reduceMotion: true, still: true, storm: false });
		const stillRain = run({ art, still: true, storm: false });
		// a drop moves every 0.55 s: 10 s is ~18 moves, one Position write each
		check(
			stillCalm.w.writes === 0 &&
				stillRain.w.writes > 0 &&
				stillRain.w.writes <= stillRain.maxWet * 20 &&
				Object.keys(stillRain.w.byProp).every(k => k === "Frame.Position"),
			`${look}: the camera still in the rain: Reduce Motion writes nothing (the drops sit still), without it the drops move on their beat and nothing else is written`,
			`Reduce Motion ${stillCalm.w.writes} writes in 10 s; the drops moving ${stillRain.w.writes} (${top(stillRain.w.byProp, 1, 3)}), ${stillRain.maxWet} sprites`,
		);
	}
	WA.overrideWorldArt({});
	// the puddles themselves: on the texel grid, the gutter's two shapes in the gutters, the lane's in the lanes, all four
	{
		const puddles = WV.puddlesOf(world);
		const offGrid = puddles.filter(
			p => (p.x - p.w / 2) % WORLD_TEXEL !== 0 || (p.y - p.h / 2) % WORLD_TEXEL !== 0,
		).length;
		const count = (v, alongX) => puddles.filter(p => p.variant === v && p.alongX === alongX).length;
		const shapes = [0, 1, 2, 3].map(v => `${v}: ${count(v, true)} + ${count(v, false)}`);
		check(
			puddles.length > 20 && offGrid === 0 && [0, 1, 2, 3].every(v => count(v, true) > 0 && count(v, false) > 0),
			"every puddle's texture lies on the 4-u texel grid (its texels are the asphalt's); all four shapes, on both kinds of road",
			`${puddles.length} puddles, ${offGrid} off the grid; shape: along x + along y ${shapes.join(", ")}`,
		);
		const again = WV.puddlesOf(world);
		check(
			again.length === puddles.length &&
				again.every((p, i) => p.x === puddles[i].x && p.y === puddles[i].y && p.variant === puddles[i].variant),
			"the same town, the same puddles, the same shapes (placed by the town, not by the screen)",
		);
	}
	// the streets dry: after the rain the puddles fade and are gone, and nothing is drawn from then on
	{
		const r = new Renderer(gui.make("Frame"), "Sprites");
		const cam = new Camera();
		cam.setView(1280, 720);
		r.setView(1280, 720);
		const view = new WV.WeatherView();
		const f = { clock: 0, reduceMotion: false, low: false };
		// centred on a puddle of the town
		const p = WV.puddlesOf(world)[0];
		cam.x = p.x;
		cam.y = p.y;
		view.step(1 / 60, true, false);
		let shown = 0;
		const draw = () => {
			r.beginFrame();
			view.drawPuddles(r, cam, cam.viewRect(32), world, f);
			view.drawRain(r, cam, cam.viewRect(32), f);
			r.endFrame();
			return r.layer.GetChildren().filter(s => s.Visible !== false).length;
		};
		shown = draw();
		let dryAt = -1;
		for (let i = 1; i <= 60 * 200; i++) {
			view.step(1 / 60, false, false);
			if (i % 60 === 0 && draw() === 0 && dryAt < 0) dryAt = i / 60;
		}
		check(
			shown > 0 && view.rain === 0 && view.wet === 0 && dryAt > 60 && dryAt <= 160,
			"after the rain: the streaks go at once (4 s), the puddles dry for a while (~2.5 min) and then nothing is drawn",
			`${shown} sprites in the rain, dry after ${dryAt} s`,
		);
	}
	WA.overrideWorldArt(undefined);
}

WA.overrideWorldArt(undefined);
console.log(failures === 0 ? "\nall pool checks passed" : `\n${failures} pool check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
