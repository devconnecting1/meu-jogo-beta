#!/usr/bin/env node
/*
 * MON-04 on screen: are the outfits and the pets really drawn, do they read, does a pet follow like a pet, and does
 * the wardrobe preview show exactly what the world shows?
 *
 *   node tools/test-cosmetics.mjs
 *   PZ_SRC=path/to/src node tools/test-cosmetics.mjs
 *
 * Until MON-04 a bought costume went into a save slot that was saved and replicated and never drawn. This suite runs
 * the REAL client view code — client/view/petFollow.ts, cosmeticsView.ts, survivorView.ts and cosmeticPreview.ts,
 * over the real shared/engine/renderer.ts — on a small fake Instance tree, and checks what a player would notice:
 *
 *   1. THE PET FOLLOWS. It starts at the heel, trails the owner with a smooth lag (no jump bigger than its top
 *      speed allows, no instant turn), STOPS when the owner stops and stays stopped (no creeping, no orbiting),
 *      steps out of the way when walked into, is put back at the heel after a respawn, survives a frame hitch,
 *      and ends in about the same place at 30 and at 144 fps. A bird flies while it travels and lands after.
 *   2. EVERY LOOK IS DRAWN, AND READS AT 32 px (MON-02). Each outfit and each pet draws sprites, their signature
 *      colours are there, they are told apart by colour AND by silhouette (the cowboy's hat is wider than a head,
 *      Santa's pom-pom sits behind it, the eagle is the widest pet, the Malamute bigger than the Carolina), and the
 *      plain survivor is exactly the pre-MON-04 drawing. Sections 2-6 are the FLAT drawing (ART-01): the uploads as
 *      they are with the characters' sheets taken out, whatever has been uploaded.
 *   3. NOTHING IS ALLOCATED PER FRAME for a pet or an outfit: every pet sprite goes through one scratch SpriteOpts
 *      and no colour is built while drawing (counted, not assumed).
 *   4. LAYERS. The survivor keeps its own band of ZIndex, a pet sits under it; one layer per piece.
 *   5. THE PREVIEW is the world drawing magnified (3–4×): every outfit × every pet fits inside the box without
 *      clipping, the head is 22 u × scale, a redraw with nothing changed writes no property, a small box shrinks
 *      the scale instead of clipping, and destroy() cleans up.
 *   6. THE WARDROBE'S TILES draw one cosmetic alone (`subject`): an outfit's tile the survivor only, a pet's tile
 *      the pet only, framed on it, and every one of them fits its tile without clipping.
 *   7. WITH THE CHARACTERS' PIXEL ART (ART-08, ART-09, ART-11: the uploaded sheets' ids of worldArtAssets.ts, read
 *      back to design/world-art's PNGs; a local stand-in for one not uploaded yet): MON-04 holds there too -- each
 *      outfit is a different picture, its body cell (arms and head baked in) from its own sheet plus the weapon,
 *      upright and pixelated, and reads by colour (the blue jacket, Santa's red, the Cowboy's straw hat, the
 *      costume's green skin that is not a zombie's green); each pet is one cell with its own colour and size; a hit
 *      and the poison keep their colours over any outfit (Santa flashes white, keeps the red outline); nothing is
 *      built or created per frame; the wardrobe preview and every tile show the whole cosmetic, texels included, at
 *      4 u x scale per texel.
 *
 * The wardrobe SCREEN (tabs, tile states, the one action, the try-on preview) runs in tools/test-backpack.mjs,
 * whose fake tree carries the whole UI kit; the purchase itself is the server's, in tools/test-save.mjs (§17)
 * and, through the real ShopAction remote, tools/test-body.mjs (§10).
 *
 * Pure Node (>= 18) + the project's TypeScript, on tools/luau-shim.mjs plus the few Roblox datatypes the renderer
 * touches. The fake tree has no layout engine: it records what was asked of it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installShims } from "./luau-shim.mjs";
import { decodePNG } from "./png-lite.mjs";

const { SRC, require } = installShims({ seed: 7 });

// ---------------------------------------------------------------- the Roblox bits the renderer touches

class Vector2 {
	constructor(x = 0, y = 0) {
		this.X = x;
		this.Y = y;
	}
}
class UDim {
	constructor(scale = 0, offset = 0) {
		this.Scale = scale;
		this.Offset = offset;
	}
}
class UDim2 {
	constructor(xs = 0, xo = 0, ys = 0, yo = 0) {
		this.X = new UDim(xs, xo);
		this.Y = new UDim(ys, yo);
	}
	static fromOffset(x, y) {
		return new UDim2(0, x, 0, y);
	}
	static fromScale(x, y) {
		return new UDim2(x, 0, y, 0);
	}
}
globalThis.Vector2 = Vector2;
globalThis.UDim = UDim;
globalThis.UDim2 = UDim2;
globalThis.Enum = {
	ApplyStrokeMode: { Border: "Border", Contextual: "Contextual" },
	// what an ImageLabel of the characters' pixel art is set up with (shared/engine/renderer.ts)
	ScaleType: { Stretch: "Stretch", Tile: "Tile", Slice: "Slice" },
	ResamplerMode: { Default: "Default", Pixelated: "Pixelated" },
};

/** every Instance created, and the property writes made while `counting` */
const tree = { created: [], writes: 0, counting: false };

function makeInstance(className) {
	const state = { ClassName: className, Name: className, children: [], parent: undefined, destroyed: false };
	const proxy = new Proxy(state, {
		get(t, k) {
			if (k === "Parent") return t.parent;
			if (k === "Destroy") {
				return () => {
					for (const c of [...t.children]) c.Destroy();
					if (t.parent !== undefined) {
						const list = t.parent.__state.children;
						list.splice(list.indexOf(proxy), 1);
					}
					t.parent = undefined;
					t.destroyed = true;
				};
			}
			if (k === "__state") return t;
			if (k === "GetChildren") return () => [...t.children];
			return t[k];
		},
		set(t, k, v) {
			if (k === "Parent") {
				if (t.parent !== undefined) {
					const list = t.parent.__state.children;
					list.splice(list.indexOf(proxy), 1);
				}
				t.parent = v;
				if (v !== undefined) v.__state.children.push(proxy);
				return true;
			}
			if (tree.counting && t[k] !== v) tree.writes++;
			t[k] = v;
			return true;
		},
	});
	tree.created.push(proxy);
	return proxy;
}
globalThis.Instance = function Instance(className) {
	return makeInstance(className);
};

// ---------------------------------------------------------------- the modules under test

const COS = require(join(SRC, "shared/data/cosmetics.ts"));
const { Z, COLORS } = require(join(SRC, "shared/engine/colors.ts"));
const { Camera } = require(join(SRC, "shared/engine/camera.ts"));
const { Renderer } = require(join(SRC, "shared/engine/renderer.ts"));
const PF = require(join(SRC, "client/view/petFollow.ts"));
const CV = require(join(SRC, "client/view/cosmeticsView.ts"));
const SV = require(join(SRC, "client/view/survivorView.ts"));
const PV = require(join(SRC, "client/view/cosmeticPreview.ts"));
const HV = require(join(SRC, "client/view/humanoidView.ts"));
const { EQUIPS } = require(join(SRC, "shared/data/equips.ts"));
const WA = require(join(SRC, "client/view/worldArt.ts"));
const { WORLD_ART } = require(join(SRC, "client/view/worldArtAssets.ts"));

/** the characters' sheets and masks (client/boot/preloadPlan.ts laterArt: survivors, weapons, zombies, dogs, birds) */
const isCharacterSheet = name => /^(survivors|weapons|zombies|dogs|birds)/.test(name);
/**
 * Sections 2-6 measure the FLAT drawing (ART-01: without the sheets' ids, the survivor and the pets are drawn exactly
 * as before), whatever has been uploaded: the uploads as they are, with every character sheet's id taken out.
 * Section 7 draws the same looks from the uploaded sheets.
 */
const flatIds = {};
for (const [name, t] of Object.entries(WORLD_ART)) flatIds[name] = isCharacterSheet(name) ? "" : t.id;
WA.overrideWorldArt(flatIds);

// ---------------------------------------------------------------- tiny harness

let failures = 0;
let checks = 0;

function check(ok, what, detail) {
	checks += 1;
	if (ok) {
		console.log(`  ok    ${what}${detail !== undefined ? `  (${detail})` : ""}`);
		return true;
	}
	failures += 1;
	console.log(`  FALHA ${what}${detail !== undefined ? `  (${detail})` : ""}`);
	return false;
}

function section(title) {
	console.log(`\n${title}`);
}

const OUTFITS = [
	["plain", COS.OutfitLook.None],
	["Santa", COS.OutfitLook.Santa],
	["Zombie", COS.OutfitLook.Zombie],
	["Cowboy", COS.OutfitLook.Cowboy],
];
const PETS = [
	["Pigeon", COS.PetLook.Pigeon],
	["White pigeon", COS.PetLook.WhitePigeon],
	["Eagle", COS.PetLook.Eagle],
	["Carolina", COS.PetLook.Carolina],
	["Malamute", COS.PetLook.Malamute],
	["Doberman", COS.PetLook.Doberman],
];

const rgb = c => [Math.round(c.R * 255), Math.round(c.G * 255), Math.round(c.B * 255)];
const colorDist = (a, b) => {
	const [r1, g1, b1] = rgb(a);
	const [r2, g2, b2] = rgb(b);
	return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
};
const sameColor = (a, b) => a !== undefined && b !== undefined && colorDist(a, b) < 0.5;

// ================================================================ 1. the pet follows

const DT = 1 / 60;
const dist = (f, x, y) => Math.hypot(f.x - x, f.y - y);

section("1) o pet segue o dono: atraso suave, para quando ele para");
{
	const f = PF.createPetFollower();
	let ox = 1000;
	let oy = 1000;
	PF.stepPetFollower(f, ox, oy, 0, DT, false);
	check(f.started, "o primeiro quadro poe o pet no lugar");
	check(Math.abs(dist(f, ox, oy) - PF.PET_HEEL) < 1e-6, "no calcanhar do dono", `${dist(f, ox, oy).toFixed(2)} u`);
	check(f.x < ox, "atras de quem olha para +x");

	// walk east at 150 u/s for 3 s
	let maxJump = 0;
	let maxDv = 0;
	let maxDist = 0;
	let prevVx = f.vx;
	let prevVy = f.vy;
	for (let i = 0; i < 180; i++) {
		const px = f.x;
		const py = f.y;
		ox += 150 * DT;
		PF.stepPetFollower(f, ox, oy, 0, DT, false);
		maxJump = Math.max(maxJump, Math.hypot(f.x - px, f.y - py));
		maxDv = Math.max(maxDv, Math.hypot(f.vx - prevVx, f.vy - prevVy));
		prevVx = f.vx;
		prevVy = f.vy;
		maxDist = Math.max(maxDist, dist(f, ox, oy));
	}
	const speed = Math.hypot(f.vx, f.vy);
	check(Math.abs(speed - 150) < 15, "andando, o pet acompanha a velocidade do dono", `${speed.toFixed(1)} u/s`);
	check(f.x < ox, "e vem atras (o dono puxa, o pet segue)");
	check(maxDist < 120, "a guia nunca estica demais", `max ${maxDist.toFixed(1)} u`);
	check(
		maxJump <= 360 * DT + 1e-6,
		"nenhum salto maior que a velocidade maxima permite",
		`${maxJump.toFixed(2)} u/quadro`,
	);
	check(
		maxDv < 40,
		"a velocidade muda aos poucos (atraso suave, sem tranco)",
		`max dv ${maxDv.toFixed(1)} u/s por quadro`,
	);
	check(f.moving > 0.9, "e as patas estao andando", `moving ${f.moving.toFixed(2)}`);

	// the owner stops
	let stoppedAt = -1;
	for (let i = 0; i < 180; i++) {
		PF.stepPetFollower(f, ox, oy, 0, DT, false);
		if (stoppedAt < 0 && f.vx === 0 && f.vy === 0) stoppedAt = i;
	}
	check(
		stoppedAt >= 0 && stoppedAt < 90,
		"quando o dono para, o pet para (em menos de 1,5 s)",
		`parou em ${(stoppedAt / 60).toFixed(2)} s`,
	);
	const restX = f.x;
	const restY = f.y;
	for (let i = 0; i < 300; i++) PF.stepPetFollower(f, ox, oy, 0, DT, false);
	check(f.x === restX && f.y === restY, "e fica parado: 5 s sem se arrastar nem orbitar");
	const rest = dist(f, ox, oy);
	check(rest > PF.PET_MIN_DIST && rest <= PF.PET_HEEL + 8, "parado perto do calcanhar", `${rest.toFixed(1)} u`);
	check(f.moving < 0.05, "as patas pararam", `moving ${f.moving.toFixed(3)}`);
	const facing = Math.atan2(oy - f.y, ox - f.x);
	const turn = Math.abs(Math.atan2(Math.sin(f.angle - facing), Math.cos(f.angle - facing)));
	check(turn < 0.1, "parado, ele olha para o dono", `${turn.toFixed(3)} rad`);

	// the owner walks into it
	const before = dist(f, ox, oy);
	ox = f.x + 10;
	oy = f.y;
	const close = dist(f, ox, oy);
	for (let i = 0; i < 60; i++) PF.stepPetFollower(f, ox, oy, 0, DT, false);
	check(
		close < PF.PET_MIN_DIST && dist(f, ox, oy) > close + 5,
		"pisado, ele sai da frente",
		`${close.toFixed(1)} -> ${dist(f, ox, oy).toFixed(1)} u (antes ${before.toFixed(1)})`,
	);

	// a respawn across the map
	ox += 5000;
	PF.stepPetFollower(f, ox, oy, Math.PI, DT, false);
	check(Math.abs(dist(f, ox, oy) - PF.PET_HEEL) < 1e-6, "dono renasceu longe: o pet reaparece no calcanhar");
	check(f.vx === 0 && f.vy === 0, "parado");

	// a 2 s hitch while the owner moves
	const hx = f.x;
	const hy = f.y;
	ox += 200;
	PF.stepPetFollower(f, ox, oy, 0, 2, false);
	check(Math.hypot(f.x - hx, f.y - hy) <= 360 * 0.1 + 1e-6, "um engasgo de 2 s nao arremessa o pet (dt limitado)");
}

section("1b) independe da taxa de quadros");
{
	const run = fps => {
		const f = PF.createPetFollower();
		let ox = 0;
		let oy = 0;
		const dt = 1 / fps;
		PF.stepPetFollower(f, ox, oy, 0, dt, false);
		// a path with a turn: east for 2 s, then south for 2 s (whole frames, so both owners end on the same spot)
		for (let i = 0; i < 4 * fps; i++) {
			if (i < 2 * fps) ox += 160 * dt;
			else oy += 160 * dt;
			PF.stepPetFollower(f, ox, oy, 0, dt, false);
		}
		const moving = { x: f.x, y: f.y };
		for (let i = 0; i < 3 * fps; i++) PF.stepPetFollower(f, ox, oy, 0, dt, false);
		return { moving, rest: { x: f.x, y: f.y } };
	};
	const a = run(30);
	const b = run(144);
	const gap = Math.hypot(a.moving.x - b.moving.x, a.moving.y - b.moving.y);
	check(
		gap < 4,
		"o mesmo caminho a 30 e a 144 fps: o pet esta no mesmo lugar",
		`${gap.toFixed(2)} u de diferenca, andando`,
	);
	const rest = Math.hypot(a.rest.x - b.rest.x, a.rest.y - b.rest.y);
	check(rest < 4, "e para no mesmo lugar", `${rest.toFixed(2)} u de diferenca, parado`);
}

section("1c) passaros voam enquanto seguem e pousam quando chegam");
{
	const f = PF.createPetFollower();
	let ox = 0;
	PF.stepPetFollower(f, ox, 0, 0, DT, true);
	check(
		Math.abs(dist(f, ox, 0) - PF.BIRD_HEEL) < 1e-6,
		"o passaro comeca pousado, um pouco mais longe",
		`${PF.BIRD_HEEL} u`,
	);
	check(f.lift === 0, "no chao");
	for (let i = 0; i < 90; i++) {
		ox += 150 * DT;
		PF.stepPetFollower(f, ox, 0, 0, DT, true);
	}
	check(f.lift > 0.9, "seguindo, ele voa", `lift ${f.lift.toFixed(2)}`);
	const p0 = f.phase;
	PF.stepPetFollower(f, ox, 0, 0, DT, true);
	check(f.phase !== p0, "e bate as asas");
	for (let i = 0; i < 240; i++) PF.stepPetFollower(f, ox, 0, 0, DT, true);
	check(f.lift === 0, "quando o dono para, ele pousa");
	const p1 = f.phase;
	PF.stepPetFollower(f, ox, 0, 0, DT, true);
	check(f.phase === p1, "e pousado nao bate as asas");
}

// ================================================================ 2–4. drawing

/** a renderer over the fake tree, a camera at 1:1, and a recorder of every sprite drawn this frame */
function newStage(w = 800, h = 600, zoom = 1) {
	const root = makeInstance("Frame");
	const r = new Renderer(root, "World");
	const cam = new Camera();
	cam.setView(w, h);
	cam.zoom = zoom;
	cam.x = 0;
	cam.y = 0;
	return { root, r, cam };
}

/** every visible sprite of the renderer, as plain numbers */
function spritesOf(r) {
	const out = [];
	for (const f of r.layer.GetChildren()) {
		if (f.Visible !== true) continue;
		const corner = f.GetChildren().find(c => c.ClassName === "UICorner");
		const stroke = f.GetChildren().find(c => c.ClassName === "UIStroke");
		out.push({
			frame: f,
			x: f.Position.X.Offset,
			y: f.Position.Y.Offset,
			w: f.Size.X.Offset,
			h: f.Size.Y.Offset,
			centred: f.AnchorPoint.X === 0.5,
			rot: f.Rotation,
			color: f.BackgroundColor3,
			alpha: 1 - f.BackgroundTransparency,
			z: f.ZIndex,
			circle: corner !== undefined && corner.CornerRadius.Scale === 0.5,
			stroke: stroke !== undefined && stroke.Enabled === true ? stroke.Color : undefined,
			strokeThick: stroke !== undefined && stroke.Enabled === true ? stroke.Thickness : 0,
		});
	}
	return out;
}

/** axis-aligned box of a (possibly rotated) sprite, stroke included */
function boxOf(s) {
	const cx = s.centred ? s.x : s.x + s.w / 2;
	const cy = s.centred ? s.y : s.y + s.h / 2;
	const a = (s.rot * Math.PI) / 180;
	const hw = (Math.abs(Math.cos(a)) * s.w + Math.abs(Math.sin(a)) * s.h) / 2 + s.strokeThick;
	const hh = (Math.abs(Math.sin(a)) * s.w + Math.abs(Math.cos(a)) * s.h) / 2 + s.strokeThick;
	return { minX: cx - hw, maxX: cx + hw, minY: cy - hh, maxY: cy + hh, cx, cy };
}

function survivorLook(outfit) {
	const look = SV.createLook();
	look.x = 0;
	look.y = 0;
	look.angle = 0;
	look.outfit = outfit;
	look.swingReach = 52;
	return look;
}

function drawOne(outfit) {
	const st = newStage();
	st.r.beginFrame();
	SV.drawSurvivor(st.r, st.cam, survivorLook(outfit), SV.createSwingTrail());
	st.r.endFrame();
	return spritesOf(st.r);
}

const SHADOW_POINT = { x: 0, y: 0 };
const noShadow = () => {
	SHADOW_POINT.x = 0;
	SHADOW_POINT.y = 0;
	return SHADOW_POINT;
};

function petAt(look, flies, moving) {
	const f = PF.createPetFollower();
	f.started = true;
	f.x = 0;
	f.y = 0;
	f.angle = 0;
	if (moving) {
		f.moving = 1;
		f.lift = flies ? 1 : 0;
		f.phase = Math.PI / 2;
	}
	return f;
}

function drawPetOnly(look, moving) {
	const st = newStage();
	st.r.beginFrame();
	CV.drawPet(st.r, st.cam, petAt(look, COS.petFlies(look), moving), look, 0, noShadow);
	st.r.endFrame();
	return spritesOf(st.r).filter(s => s.z !== Z.actorShadow);
}

section("2) cada traje e desenhado, e se le por cor e silhueta a 32 px (MON-02)");
{
	const plain = drawOne(COS.OutfitLook.None);
	const torso = sprites => sprites.find(s => s.z === Z.player + 1 && s.w === 24 && s.h === 38);
	const head = sprites => sprites.filter(s => s.z === Z.player + 4 && s.circle);
	// the plain survivor is the pre-MON-04 drawing, colour for colour
	check(sameColor(torso(plain)?.color, COLORS.player), "sem traje: o torso continua COLORS.player");
	check(sameColor(torso(plain)?.stroke, COLORS.playerDark), "com o contorno playerDark");
	const plainHead = head(plain)[0];
	check(
		plainHead !== undefined && plainHead.w === 22 && sameColor(plainHead.color, COLORS.playerDark),
		"e a cabeca de 22 u em playerDark",
	);
	check(
		plain.filter(s => s.z === Z.player + 2 || s.z === Z.player + 5).length === 0,
		"e nada por cima do torso nem da cabeca",
	);

	const torsos = new Map();
	for (const [name, look] of OUTFITS) {
		const s = drawOne(look);
		check(s.length > 0, `${name}: desenhado (${s.length} sprites)`);
		const t = torso(s);
		torsos.set(name, t?.color);
		const zs = s.filter(x => x.z !== Z.actorShadow).map(x => x.z);
		check(
			zs.every(z => z >= Z.player - 1 && z <= Z.player + 5),
			`${name}: todas as pecas na faixa do sobrevivente (${Z.player - 1}..${Z.player + 5})`,
			`${Math.min(...zs)}..${Math.max(...zs)}`,
		);
	}
	// colour: every torso apart from every other one
	const names = [...torsos.keys()];
	let minD = Infinity;
	let pair = "";
	for (let i = 0; i < names.length; i++) {
		for (let j = i + 1; j < names.length; j++) {
			const d = colorDist(torsos.get(names[i]), torsos.get(names[j]));
			if (d < minD) {
				minD = d;
				pair = `${names[i]} x ${names[j]}`;
			}
		}
	}
	check(
		minD > 60,
		"os quatro torsos sao cores claramente diferentes",
		`menor distancia ${minD.toFixed(0)} (${pair})`,
	);

	const santa = drawOne(COS.OutfitLook.Santa);
	check(sameColor(torso(santa)?.color, Color3.fromRGB(198, 32, 40)), "Santa: casaco vermelho");
	check(sameColor(torso(santa)?.stroke, Color3.fromRGB(246, 244, 238)), "com a barra branca em volta");
	// the survivor stands at the centre of an 800 x 600 view, facing +x: "behind" is left of x = 400
	const pompom = santa.find(s => s.circle && s.z === Z.player + 4 && s.w === 9);
	check(
		pompom !== undefined && boxOf(pompom).cx < 400 - 10,
		"e o pompom branco CAI PARA TRAS da cabeca (silhueta unica)",
		pompom ? `${(boxOf(pompom).cx - 400).toFixed(0)} u` : "sem pompom",
	);
	check(
		santa.some(s => s.z === Z.player + 5 && sameColor(s.color, Color3.fromRGB(198, 32, 40))),
		"gorro vermelho por cima",
	);

	const cowboy = drawOne(COS.OutfitLook.Cowboy);
	const brim = head(cowboy).reduce((m, s) => Math.max(m, s.w), 0);
	check(brim >= 22 * 1.3, "Cowboy: a aba e bem mais larga que a cabeca (22) -- a silhueta de cima", `${brim} u`);
	check(brim <= 32, "mas deixa os ombros a vista (e nao passa do corpo, COL-01)", `${brim} u`);
	check(
		cowboy.filter(s => s.z === Z.player + 2).length === 2,
		"e o colete aberto: dois paineis de couro sobre a camisa",
	);

	const zombie = drawOne(COS.OutfitLook.Zombie);
	const zHead = head(zombie)[0];
	check(zHead !== undefined && rgb(zHead.color)[1] > rgb(zHead.color)[0] + 20, "Zombie: pele verde na cabeca");
	check(
		zombie.filter(s => s.z === Z.player + 2).length >= 3,
		"e rasgos na roupa mostrando a pele",
		`${zombie.filter(s => s.z === Z.player + 2).length} pecas`,
	);
	const zTorso = torso(zombie)?.color;
	check(
		colorDist(zTorso, COLORS.zombie1) > 40,
		"o torso NAO e o verde dos zumbis de verdade (P3: e um sobrevivente fantasiado)",
		`distancia ${colorDist(zTorso, COLORS.zombie1).toFixed(0)}`,
	);
	check(
		zombie.filter(s => s.z === Z.player + 3).length >= 2,
		"e as maos continuam na arma (a silhueta de sobrevivente)",
	);
}

section("2b) acerto e veneno continuam legiveis por cima do traje (LEG-02)");
{
	const st = newStage();
	const look = survivorLook(COS.OutfitLook.Santa);
	look.flash = 1;
	st.r.beginFrame();
	SV.drawSurvivor(st.r, st.cam, look, SV.createSwingTrail());
	st.r.endFrame();
	const t = spritesOf(st.r).find(s => s.z === Z.player + 1 && s.w === 24);
	check(
		sameColor(t?.stroke, COLORS.uiRed) && t?.strokeThick === 3,
		"Santa atingido: o contorno vermelho grosso de todo acerto aparece",
	);
	check(
		rgb(t.color)[1] > 150,
		"e o casaco pisca para o BRANCO (vermelho sobre vermelho nao se leria)",
		`rgb ${rgb(t.color)}`,
	);
	const pst = newStage();
	const poisoned = survivorLook(COS.OutfitLook.Cowboy);
	poisoned.poisoned = true;
	pst.r.beginFrame();
	SV.drawSurvivor(pst.r, pst.cam, poisoned, SV.createSwingTrail());
	pst.r.endFrame();
	const pt = spritesOf(pst.r).find(s => s.z === Z.player + 1 && s.w === 24);
	check(
		sameColor(pt?.color, COLORS.zombie5),
		"envenenado, o torso fica na cor do veneno mesmo com traje (sinal de jogo vence cosmetico)",
	);
}

section("3) cada pet e desenhado, com cor e silhueta proprias");
{
	const extent = sprites => {
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const s of sprites) {
			const b = boxOf(s);
			minX = Math.min(minX, b.minX);
			maxX = Math.max(maxX, b.maxX);
			minY = Math.min(minY, b.minY);
			maxY = Math.max(maxY, b.maxY);
		}
		return { len: maxX - minX, span: maxY - minY };
	};
	const bodies = new Map();
	const bodyArea = new Map();
	const sizes = new Map();
	for (const [name, look] of PETS) {
		const moving = drawPetOnly(look, true);
		const still = drawPetOnly(look, false);
		check(
			moving.length >= 5 && still.length >= 5,
			`${name}: desenhado (${still.length} sprites parado, ${moving.length} em movimento)`,
		);
		const zs = still.map(s => s.z);
		check(
			zs.every(z => z >= CV.PET_Z && z <= CV.PET_Z + 3 && z < Z.player - 1),
			`${name}: debaixo do sobrevivente, sem empatar com os pes dele (camadas ${CV.PET_Z}..${CV.PET_Z + 3})`,
			`${Math.min(...zs)}..${Math.max(...zs)}`,
		);
		// the body is the biggest sprite on the body layer
		const body = still.filter(s => s.z === CV.PET_Z + 1).sort((a, b) => b.w * b.h - a.w * a.h)[0];
		bodies.set(name, body.color);
		bodyArea.set(name, body.w * body.h);
		sizes.set(name, { still: extent(still), moving: extent(moving) });
	}
	let minD = Infinity;
	let pair = "";
	const names = [...bodies.keys()];
	for (let i = 0; i < names.length; i++) {
		for (let j = i + 1; j < names.length; j++) {
			const d = colorDist(bodies.get(names[i]), bodies.get(names[j]));
			if (d < minD) {
				minD = d;
				pair = `${names[i]} x ${names[j]}`;
			}
		}
	}
	check(minD > 40, "os seis corpos tem cores diferentes entre si", `menor distancia ${minD.toFixed(0)} (${pair})`);
	const span = n => sizes.get(n).moving.span;
	const len = n => sizes.get(n).still.len;
	check(
		span("Eagle") > 55,
		"a aguia de asas abertas e a silhueta mais larga",
		`envergadura ${span("Eagle").toFixed(0)} u`,
	);
	check(
		sizes.get("Eagle").still.span > 40,
		"e mesmo pousada ela mantem as asas abertas",
		`${sizes.get("Eagle").still.span.toFixed(0)} u`,
	);
	check(
		sizes.get("Pigeon").still.span < 16,
		"o pombo pousado dobra as asas",
		`${sizes.get("Pigeon").still.span.toFixed(0)} u`,
	);
	check(span("Pigeon") > sizes.get("Pigeon").still.span + 10, "e voando abre", `${span("Pigeon").toFixed(0)} u`);
	check(
		bodyArea.get("Malamute") > bodyArea.get("Carolina") * 1.3,
		"o Malamute e bem maior que a Carolina (corpo)",
		`${bodyArea.get("Malamute")} x ${bodyArea.get("Carolina")} px2`,
	);
	check(
		len("Carolina") > len("Pigeon") + 10,
		"um cao e mais comprido que um pombo",
		`${len("Carolina").toFixed(0)} x ${len("Pigeon").toFixed(0)} u`,
	);
	check(
		sizes.get("Doberman").still.span < sizes.get("Malamute").still.span,
		"o Doberman e mais esguio que o Malamute",
		`${sizes.get("Doberman").still.span.toFixed(1)} x ${sizes.get("Malamute").still.span.toFixed(1)} u`,
	);
	const dober = drawPetOnly(COS.PetLook.Doberman, false);
	check(
		dober.some(s => sameColor(s.color, Color3.fromRGB(180, 108, 50))),
		"Doberman: preto com marcas caramelo",
	);
	const mal = drawPetOnly(COS.PetLook.Malamute, false);
	check(
		mal.some(s => sameColor(s.color, Color3.fromRGB(240, 240, 238))),
		"Malamute: cinza com mascara e cauda brancas",
	);
	check(drawPetOnly(COS.PetLook.None, false).length === 0, "sem pet, nada e desenhado");
}

section("3b) um passaro voando sobe na tela e a sombra fica no chao");
{
	const st = newStage();
	const f = petAt(COS.PetLook.Pigeon, true, true);
	st.r.beginFrame();
	CV.drawPet(st.r, st.cam, f, COS.PetLook.Pigeon, 0, noShadow);
	st.r.endFrame();
	const all = spritesOf(st.r);
	const shadow = all.find(s => s.z === Z.actorShadow);
	const body = all.filter(s => s.z === CV.PET_Z + 1).sort((a, b) => b.w * b.h - a.w * a.h)[0];
	check(
		shadow !== undefined && body !== undefined && boxOf(body).cy < boxOf(shadow).cy - 15,
		"o corpo esta acima da propria sombra",
		`${(boxOf(shadow).cy - boxOf(body).cy).toFixed(0)} px`,
	);
}

section("4) nada e alocado por quadro para pet ou traje");
{
	// every Color3 built or lerped while drawing is counted
	const P3 = Color3.prototype;
	const lerp = P3.Lerp;
	const fromRGB = Color3.fromRGB;
	let built = 0;
	P3.Lerp = function (...a) {
		built++;
		return lerp.apply(this, a);
	};
	Color3.fromRGB = (...a) => {
		built++;
		return fromRGB(...a);
	};
	const st = newStage();
	const opts = new Set();
	const draw = st.r.drawRect.bind(st.r);
	let rects = 0;
	st.r.drawRect = (cam, x, y, o) => {
		rects++;
		opts.add(o);
		return draw(cam, x, y, o);
	};
	for (const [, look] of PETS) {
		for (const moving of [false, true]) {
			st.r.beginFrame();
			CV.drawPet(st.r, st.cam, petAt(look, COS.petFlies(look), moving), look, 1.5, noShadow);
			st.r.endFrame();
		}
	}
	check(built === 0, "desenhar os seis pets, parados e andando, nao cria nenhuma cor", `${built} Color3`);
	// (the Luau shim turns Set#size into a method, like roblox-ts)
	check(
		opts.size() === 1,
		`todos os ${rects} sprites de pet saem de UMA SpriteOpts reaproveitada`,
		`${opts.size()} tabela(s)`,
	);
	built = 0;
	for (const [, look] of OUTFITS) {
		st.r.beginFrame();
		SV.drawSurvivor(st.r, st.cam, survivorLook(look), SV.createSwingTrail());
		st.r.endFrame();
	}
	check(built === 0, "desenhar o sobrevivente com cada traje (sem acerto) nao cria nenhuma cor", `${built} Color3`);
	P3.Lerp = lerp;
	Color3.fromRGB = fromRGB;
	// the pieces the outfit adds go through the same scratch
	const outfitOpts = new Set();
	st.r.drawRect = (cam, x, y, o) => {
		outfitOpts.add(o);
		return draw(cam, x, y, o);
	};
	st.r.beginFrame();
	CV.drawOutfitTorso(st.r, st.cam, 0, 0, 0, Z.player, COS.OutfitLook.Zombie);
	CV.drawOutfitHead(st.r, st.cam, 0, 0, 0, Z.player, COS.OutfitLook.Santa);
	CV.drawOutfitTorso(st.r, st.cam, 0, 0, 0, Z.player, COS.OutfitLook.Cowboy);
	CV.drawOutfitHead(st.r, st.cam, 0, 0, 0, Z.player, COS.OutfitLook.Cowboy);
	st.r.endFrame();
	check(
		outfitOpts.size() === 1,
		"as pecas dos trajes tambem saem da mesma SpriteOpts",
		`${outfitOpts.size()} tabela(s)`,
	);
}

// ================================================================ 5. the wardrobe preview

section("5) a previa do guarda-roupa: o mesmo desenho do mundo, ampliado, sem cortar nada");
{
	const panel = makeInstance("Frame");
	const W = 420;
	const H = 270;
	const preview = new PV.SurvivorPreview(panel, { x: 10, y: 20, w: W, h: H });
	check(preview.frame.Parent === panel, "a previa vive dentro do Frame que o guarda-roupa der");
	check(preview.scale >= 3 && preview.scale <= 4, "na escala pedida (3-4x)", `${preview.scale}x`);
	check(
		preview.frame.Size.X.Offset === W && preview.frame.Position.Y.Offset === 20,
		"no tamanho e na posicao pedidos",
	);
	const renderer = preview.renderer;
	let worst = 0;
	let worstWhat = "";
	let maxSprites = 0;
	for (const [oname, outfit] of OUTFITS) {
		for (const [pname, pet] of [["sem pet", 0], ...PETS]) {
			preview.setOutfit(outfit);
			preview.setPet(pet);
			preview.draw(0.7);
			const sprites = spritesOf(renderer);
			maxSprites = Math.max(maxSprites, sprites.length);
			for (const s of sprites) {
				const b = boxOf(s);
				const out = Math.max(-b.minX, -b.minY, b.maxX - W, b.maxY - H, 0);
				if (out > worst) {
					worst = out;
					worstWhat = `${oname} + ${pname}`;
				}
			}
		}
	}
	check(
		worst <= 0.5,
		"todo traje x todo pet cabe inteiro na caixa (nada cortado)",
		worst > 0 ? `saiu ${worst.toFixed(1)} px em ${worstWhat}` : `${OUTFITS.length * (PETS.length + 1)} combinacoes`,
	);
	check(maxSprites < 70, "com poucos sprites (uma grade de previas continua barata)", `max ${maxSprites}`);

	preview.setOutfit(COS.OutfitLook.None);
	preview.setPet(COS.PetLook.None);
	preview.draw(0);
	const headSprite = spritesOf(renderer).find(s => s.circle && s.z === Z.player + 4);
	const want = Math.round(22 * preview.scale);
	check(
		headSprite !== undefined && Math.abs(headSprite.w - want) <= 1,
		"a cabeca tem 22 u x escala (e o desenho do mundo ampliado)",
		headSprite ? `${headSprite.w} px, esperado ${want}` : "sem cabeca",
	);

	// the same state drawn again writes nothing: calling draw() every frame is free
	preview.setOutfit(COS.OutfitLook.Cowboy);
	preview.setPet(COS.PetLook.Malamute);
	preview.draw(0);
	const before = tree.created.length;
	tree.writes = 0;
	tree.counting = true;
	preview.draw(0);
	tree.counting = false;
	check(
		tree.writes === 0 && tree.created.length === before,
		"redesenhar sem mudanca nao escreve propriedade nem cria Instance",
		`${tree.writes} escritas`,
	);

	// from the save's EQUIPS ids, as the wardrobe will call it
	const id = n => EQUIPS.find(e => e.name === n).id;
	preview.setEquipped(id("Santa"), id("White pigeon"));
	const [o, p] = preview.showing();
	check(
		o === COS.OutfitLook.Santa && p === COS.PetLook.WhitePigeon,
		"setEquipped aceita os ids do save (equipOutfit / equipPet)",
	);
	preview.setEquipped(-1, -1);
	const [o2, p2] = preview.showing();
	check(o2 === 0 && p2 === 0, "e -1 e nada");

	// a box too small for 3.5x shrinks instead of clipping
	const small = new PV.SurvivorPreview(panel, { w: 160, h: 110 });
	check(small.scale < PV.PREVIEW_SCALE, "uma caixa pequena reduz a escala", `${small.scale.toFixed(2)}x`);
	small.setOutfit(COS.OutfitLook.Cowboy);
	small.setPet(COS.PetLook.Eagle);
	small.draw(0);
	let smallOut = 0;
	for (const s of spritesOf(small.renderer)) {
		const b = boxOf(s);
		smallOut = Math.max(smallOut, -b.minX, -b.minY, b.maxX - 160, b.maxY - 110);
	}
	check(smallOut <= 0.5, "e continua sem cortar nada", `${smallOut.toFixed(1)} px`);

	const frame = preview.frame;
	preview.destroy();
	check(frame.Parent === undefined && frame.__state.destroyed, "destroy() remove a previa");
	check(
		PV.PREVIEW_OUTFITS.length === 4 && PV.PREVIEW_PETS.length === 7,
		"listas prontas para a grade do guarda-roupa (4 trajes, 6 pets + nenhum)",
	);
}

// ================================================================ 6. the wardrobe's tiles

section("6) o ladrilho do guarda-roupa: cada traje sozinho, cada pet sozinho, inteiro no ladrilho");
{
	const panel = makeInstance("Frame");
	// the wardrobe's tile drawing box (client/ui/wardrobe.ts: a 104 tile less 6 on each side)
	const S = 92;
	const clipOf = (preview, w, h) => {
		let out = 0;
		for (const s of spritesOf(preview.renderer)) {
			const b = boxOf(s);
			out = Math.max(out, -b.minX, -b.minY, b.maxX - w, b.maxY - h);
		}
		return out;
	};
	const isPet = s => s.z >= CV.PET_Z && s.z <= CV.PET_Z + 3;
	const isSurvivor = s => s.z >= Z.player - 1 && s.z <= Z.player + 5;

	let worst = 0;
	let worstWhat = "";
	let strays = 0;
	for (const [name, look] of OUTFITS) {
		const tile = new PV.SurvivorPreview(panel, { w: S, h: S, subject: "outfit" });
		tile.setOutfit(look);
		tile.setPet(COS.PetLook.Eagle); // ignored: an outfit's tile shows the outfit only
		tile.draw(0);
		const out = clipOf(tile, S, S);
		if (out > worst) {
			worst = out;
			worstWhat = name;
		}
		const sprites = spritesOf(tile.renderer);
		strays += sprites.filter(isPet).length;
		check(sprites.some(isSurvivor), `${name}: o ladrilho desenha o sobrevivente vestindo o traje`);
		tile.destroy();
	}
	check(
		worst <= 0.5,
		"todo traje cabe inteiro no ladrilho",
		worst > 0 ? `saiu ${worst.toFixed(1)} px (${worstWhat})` : `${S} x ${S}`,
	);
	check(strays === 0, "e o ladrilho de traje nao desenha pet nenhum", `${strays} sprites de pet`);

	worst = 0;
	strays = 0;
	for (const [name, look] of PETS) {
		const tile = new PV.SurvivorPreview(panel, { w: S, h: S, subject: "pet" });
		tile.setPet(look);
		tile.setOutfit(COS.OutfitLook.Cowboy); // ignored: a pet's tile shows the pet only
		for (const clock of [0, 0.7, 1.5]) {
			tile.draw(clock);
			const out = clipOf(tile, S, S);
			if (out > worst) {
				worst = out;
				worstWhat = `${name} t=${clock}`;
			}
		}
		const sprites = spritesOf(tile.renderer);
		strays += sprites.filter(isSurvivor).length;
		check(
			sprites.filter(isPet).length >= 5,
			`${name}: o ladrilho desenha o pet`,
			`${sprites.filter(isPet).length} sprites`,
		);
		tile.destroy();
	}
	check(
		worst <= 0.5,
		"todo pet cabe inteiro no ladrilho, abanando o rabo ou nao",
		worst > 0 ? `saiu ${worst.toFixed(1)} px (${worstWhat})` : `${S} x ${S}`,
	);
	check(strays === 0, "e o ladrilho de pet nao desenha o sobrevivente", `${strays} sprites do sobrevivente`);

	// the pet's tile frames the PET: it is drawn big, not as the corner of the full scene
	const full = new PV.SurvivorPreview(panel, { w: S, h: S });
	const petTile = new PV.SurvivorPreview(panel, { w: S, h: S, subject: "pet" });
	check(
		petTile.scale > full.scale * 1.5,
		"o pet sozinho aparece bem maior que na cena inteira (a caixa e dele)",
		`${petTile.scale.toFixed(2)}x contra ${full.scale.toFixed(2)}x`,
	);
	check(
		PV.previewFit(S, S, 10, PV.OUTFIT_SCENE).scale === S / (PV.OUTFIT_SCENE.maxY - PV.OUTFIT_SCENE.minY),
		"previewFit enquadra a cena pedida (a do traje, aqui)",
	);
	full.destroy();
	petTile.destroy();

	// the Shop's pet packs (MON-06): each card shows the pet itself, the wardrobe's drawing, in a bed 90 units wide and
	// as tall as the contents and price lines (client/ui/shop.ts: 90 x 82 at the design size; a phone draws the same
	// design space smaller, so the box never changes shape) -- the whole pet, never clipped, and never a stand-in
	const { SHOP_PACKS } = require(join(SRC, "shared/data/shop.ts"));
	const { ItemKind } = require(join(SRC, "shared/data/kinds.ts"));
	const packPets = [];
	for (const p of SHOP_PACKS) {
		for (const it of p.items) {
			if (it.kind === ItemKind.Equip && COS.petLookOfEquip(it.index) !== COS.PetLook.None) {
				packPets.push([p.name, COS.petLookOfEquip(it.index)]);
			}
		}
	}
	let packWorst = 0;
	let packWhat = "";
	let drawn = 0;
	for (const [name, look] of packPets) {
		for (const [w, h] of [
			[90, 82],
			[60, 50],
		]) {
			const pic = new PV.SurvivorPreview(panel, { w, h, subject: "pet", scene: PV.packPetScene(look) });
			pic.setPet(look);
			pic.draw(0);
			const out = clipOf(pic, w, h);
			if (out > packWorst) {
				packWorst = out;
				packWhat = `${name} ${w}x${h}`;
			}
			if (spritesOf(pic.renderer).filter(isPet).length >= 5) drawn++;
			pic.destroy();
		}
	}
	check(
		packPets.length === 2 && drawn === packPets.length * 2 && packWorst <= 0.5,
		"loja: o pet de cada pacote de pet (Pigeon, Carolina) desenhado inteiro no cartao, sem cortar",
		packWorst > 0 ? `saiu ${packWorst.toFixed(1)} px (${packWhat})` : `${packPets.map(p => p[0]).join(", ")}`,
	);
}

// ================================================================ 7. the characters' pixel art

section("7) com a arte dos personagens (ART-08, ART-09, ART-11): os mesmos trajes e pets, das folhas de pixel art");
{
	const CS = require(join(SRC, "client/view/charSheets.ts"));
	const artDir = join(SRC, "..", "design", "world-art");
	const manifest = JSON.parse(readFileSync(join(artDir, "manifest.json"), "utf8"));
	// the ids the game draws with: the uploaded ones (worldArtAssets.ts), and a local stand-in for a texture that has
	// none yet; each id is read back to its PNG in design/world-art, so the texels below are the uploaded sheets'
	const ids = {};
	const nameOfId = new Map();
	for (const t of manifest.textures) {
		const id = WORLD_ART[t.name]?.id || `local:${t.name}`;
		ids[t.name] = id;
		nameOfId.set(id, t.name);
	}
	WA.overrideWorldArt(ids);
	const sheets = manifest.textures.map(t => t.name).filter(isCharacterSheet);
	const standIns = sheets.filter(n => ids[n].startsWith("local:"));
	console.log(
		`  (${sheets.length} folhas de personagem: ${sheets.length - standIns.length} com o id enviado` +
			`${standIns.length > 0 ? `; substituto local para ${standIns.join(", ")}` : ""})`,
	);
	const pngs = new Map();
	const png = name => {
		if (!pngs.has(name)) pngs.set(name, decodePNG(readFileSync(join(artDir, `${name}.png`))));
		return pngs.get(name);
	};
	/** the visible image sprites of a renderer: which sheet, which cell, the tint and opacity, the screen box */
	const imagesOf = r =>
		spritesOf(r)
			.map(s => {
				const im = s.frame.GetChildren().find(c => c.ClassName === "ImageLabel" && c.Visible === true);
				if (im === undefined) return undefined;
				return {
					...s,
					sheet: nameOfId.get(im.Image) ?? im.Image,
					rx: im.ImageRectOffset?.X ?? 0,
					ry: im.ImageRectOffset?.Y ?? 0,
					rw: im.ImageRectSize?.X ?? 0,
					rh: im.ImageRectSize?.Y ?? 0,
					tint: im.ImageColor3,
					alpha: 1 - im.ImageTransparency,
					pixelated: im.ResampleMode === Enum.ResamplerMode.Pixelated,
				};
			})
			.filter(s => s !== undefined);
	/** the opaque texels of a cell: count, mean colour of its body (outline excluded), and its screen bounds */
	const cellOf = s => {
		const img = png(s.sheet);
		let n = 0;
		let body = 0;
		const sum = [0, 0, 0];
		const share = { blue: 0, red: 0, green: 0, tan: 0 };
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		for (let y = 0; y < s.rh; y++) {
			for (let x = 0; x < s.rw; x++) {
				const i = ((s.ry + y) * img.w + s.rx + x) * 4;
				if (img.data[i + 3] === 0) continue;
				n++;
				x0 = Math.min(x0, x);
				y0 = Math.min(y0, y);
				x1 = Math.max(x1, x + 1);
				y1 = Math.max(y1, y + 1);
				const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
				if (r + g + b < 120) continue;
				body++;
				sum[0] += r;
				sum[1] += g;
				sum[2] += b;
				if (b > r + 30 && b > g + 10) share.blue++;
				else if (r > g + 60 && r > b + 50) share.red++;
				else if (g > r + 10 && g > b + 10) share.green++;
				else if (r > b + 40 && g > b + 20 && r >= g) share.tan++;
			}
		}
		const k = s.w / s.rw;
		const left = s.centred ? s.x - s.w / 2 : s.x;
		const top = s.centred ? s.y - s.h / 2 : s.y;
		for (const k of Object.keys(share)) share[k] /= Math.max(1, body);
		return {
			n,
			share,
			mean: sum.map(v => v / Math.max(1, body)),
			minX: left + x0 * k,
			maxX: left + x1 * k,
			minY: top + y0 * k,
			maxY: top + y1 * k,
			w: (x1 - x0) * k,
			span: Math.max(x1 - x0, y1 - y0) * k,
		};
	};

	const drawOneAt = outfit => {
		const st = newStage();
		st.r.beginFrame();
		SV.drawSurvivor(st.r, st.cam, survivorLook(outfit), SV.createSwingTrail());
		st.r.endFrame();
		return st.r;
	};

	// ---- each outfit: its body cell and its weapon, from its own sheet, upright, pixelated
	const outfitSheet = ["survivorsA", "survivorsA", "survivorsB", "survivorsB"];
	const shares = {};
	/** each outfit's body as drawn: its sheet and its cell */
	const pictures = new Map();
	for (const [name, outfit] of OUTFITS) {
		const images = imagesOf(drawOneAt(outfit));
		const body = images.find(s => s.sheet.startsWith("survivors"));
		const weapon = images.find(s => s.sheet === "weapons");
		const block = (outfit % CS.OUTFITS_PER_SHEET) * CS.SURVIVOR_ROWS_EACH;
		const row = body !== undefined ? body.ry / CS.SURVIVOR_CELL : -1;
		check(
			images.length === 2 && body !== undefined && weapon !== undefined,
			`${name}: o corpo inteiro (bracos e cabeca) numa celula, e a arma na mao`,
			images.map(s => s.sheet).join(" + "),
		);
		check(
			body !== undefined &&
				body.sheet === outfitSheet[outfit] &&
				row >= block &&
				row < block + CS.SURVIVOR_ROWS_EACH,
			`${name}: das linhas do proprio traje (${outfitSheet[outfit]})`,
			`linha ${row}`,
		);
		check(
			images.every(s => s.rot === 0 && s.pixelated && s.rw === s.rh),
			`${name}: celulas em pe na tela (a direcao e a coluna), pixeladas`,
		);
		if (body !== undefined) shares[name] = cellOf(body).share;
		if (body !== undefined) pictures.set(name, `${body.sheet} @ ${body.rx},${body.ry}`);
	}
	check(
		pictures.size() === OUTFITS.length && new Set(pictures.values()).size() === OUTFITS.length,
		"MON-04: cada traje troca o que e desenhado (quatro celulas diferentes, nenhuma ignora o traje)",
		[...pictures].map(([n, p]) => `${n}: ${p}`).join("; "),
	);
	const pct = v => `${Math.round((v ?? 0) * 100)}%`;
	check((shares.plain?.blue ?? 0) >= 0.3, "sem traje: a jaqueta azul de sempre", `${pct(shares.plain?.blue)} azul`);
	check((shares.Santa?.red ?? 0) >= 0.3, "Santa: o vermelho", `${pct(shares.Santa?.red)} vermelho`);
	check(
		(shares.Cowboy?.tan ?? 0) >= 0.4,
		"Cowboy: o chapeu palha por cima de tudo",
		`${pct(shares.Cowboy?.tan)} palha`,
	);
	// the costume's green is its skin, between the rags: far less of it than a walker's green (P3, LEG-03)
	const walker = (() => {
		const st = newStage();
		st.r.beginFrame();
		HV.drawZombie(st.r, st.cam, 0, 0, 0, 16 / 18, 1, 0, 1, 0, Z.zombie, 0, false, false, false);
		st.r.endFrame();
		const cell = imagesOf(st.r).find(s => s.sheet === "zombies");
		return cell !== undefined ? cellOf(cell).share.green : 0;
	})();
	check(
		(shares.Zombie?.green ?? 0) >= 0.1 && (shares.Zombie?.green ?? 1) < walker * 0.6,
		"Zombie: pele verde entre os trapos, bem menos verde que um zumbi de verdade (P3)",
		`${pct(shares.Zombie?.green)} verde, o walker ${pct(walker)}`,
	);

	// ---- each pet: one cell from its sheet, with its own colour and size
	const petCells = {};
	for (const [name, look] of PETS) {
		for (const moving of [false, true]) {
			const st = newStage();
			st.r.beginFrame();
			CV.drawPet(st.r, st.cam, petAt(look, COS.petFlies(look), moving), look, 0, noShadow);
			st.r.endFrame();
			const images = imagesOf(st.r);
			const sheet = COS.petFlies(look) ? "birds" : "dogs";
			check(
				images.length === 1 && images[0].sheet === sheet,
				`${name}${moving ? " andando" : ""}: uma celula de ${sheet}`,
				images.map(s => s.sheet).join(" + "),
			);
			if (images.length === 1) petCells[`${name}${moving ? "+" : ""}`] = cellOf(images[0]);
		}
	}
	const names = PETS.map(([n]) => n);
	let minD = Infinity;
	let pair = "";
	for (let i = 0; i < names.length; i++) {
		for (let j = i + 1; j < names.length; j++) {
			const a = petCells[names[i]]?.mean ?? [0, 0, 0];
			const b = petCells[names[j]]?.mean ?? [0, 0, 0];
			const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
			if (d < minD) {
				minD = d;
				pair = `${names[i]} x ${names[j]}`;
			}
		}
	}
	check(
		minD > 25,
		"os seis pets tem cores medias diferentes entre si",
		`menor distancia ${minD.toFixed(0)} (${pair})`,
	);
	check(
		(petCells["Malamute"]?.n ?? 0) > (petCells["Carolina"]?.n ?? 0) * 1.15,
		"o Malamute e maior que a Carolina",
		`${petCells["Malamute"]?.n} contra ${petCells["Carolina"]?.n} texels`,
	);
	const widest = Object.entries(petCells).sort((a, b) => b[1].span - a[1].span)[0]?.[0];
	check(widest === "Eagle+", "a aguia de asas abertas e o pet mais largo", `${widest}`);

	// ---- a hit and the poison, over any outfit (LEG-02, MON-04's exceptions)
	const hitOf = (outfit, flash, poisoned) => {
		const look = survivorLook(outfit);
		look.flash = flash;
		look.poisoned = poisoned;
		const st = newStage();
		st.r.beginFrame();
		SV.drawSurvivor(st.r, st.cam, look, SV.createSwingTrail());
		st.r.endFrame();
		return imagesOf(st.r);
	};
	const santaHit = hitOf(COS.OutfitLook.Santa, 1, false);
	const fill = santaHit.find(s => s.sheet === "survivorsAFill");
	const rim = santaHit.find(s => s.sheet === "survivorsARim");
	check(
		fill !== undefined && sameColor(fill.tint, COLORS.white) && fill.alpha >= 0.5,
		"Santa atingido: o corpo vai ao BRANCO (o casaco ja e vermelho)",
		fill ? `${rgb(fill.tint)} a ${fill.alpha.toFixed(2)}` : "sem mascara",
	);
	check(
		rim !== undefined && sameColor(rim.tint, COLORS.uiRed),
		"e mantem o contorno vermelho grosso de todo acerto",
		rim ? `${rgb(rim.tint)}` : "sem contorno",
	);
	const plainHit = hitOf(COS.OutfitLook.None, 1, false).find(s => s.sheet === "survivorsAFill");
	check(plainHit !== undefined && sameColor(plainHit.tint, COLORS.uiRed), "os outros trajes piscam para o vermelho");
	const poisoned = hitOf(COS.OutfitLook.Cowboy, 0, true).find(s => s.sheet === "survivorsBFill");
	check(
		poisoned !== undefined && sameColor(poisoned.tint, COLORS.zombie5) && poisoned.alpha >= 0.5,
		"veneno vence traje: um veu da cor do veneno sobre o corpo",
		poisoned ? `a ${poisoned.alpha.toFixed(2)}` : "sem veu",
	);
	check(
		hitOf(COS.OutfitLook.Santa, 0, false).length === 2,
		"e sem acerto nem veneno, nenhuma mascara (o corpo e a arma)",
	);

	// ---- nothing built while drawing, nothing created after the first frame
	{
		const P3 = Color3.prototype;
		const lerp = P3.Lerp;
		const fromRGB = Color3.fromRGB;
		let built = 0;
		P3.Lerp = function (...a) {
			built++;
			return lerp.apply(this, a);
		};
		Color3.fromRGB = (...a) => {
			built++;
			return fromRGB(...a);
		};
		const st = newStage();
		const frame = t => {
			st.r.beginFrame();
			for (const [, outfit] of OUTFITS) {
				const look = survivorLook(outfit);
				look.feetPhase = t;
				look.feetAmp = 1;
				look.angle = t * 0.3;
				SV.drawSurvivor(st.r, st.cam, look, SV.createSwingTrail());
			}
			for (const [, look] of PETS) {
				const f = petAt(look, COS.petFlies(look), true);
				f.phase = t;
				f.angle = t * 0.2;
				CV.drawPet(st.r, st.cam, f, look, t, noShadow);
			}
			st.r.endFrame();
		};
		frame(0);
		const before = tree.created.length;
		for (let i = 1; i <= 120; i++) frame(i * 0.1);
		check(built === 0, "desenhar trajes e pets da arte nao cria nenhuma cor", `${built} Color3`);
		check(
			tree.created.length === before,
			"120 quadros andando e girando, depois do primeiro, nao criam Instance",
			`${tree.created.length - before}`,
		);
		P3.Lerp = lerp;
		Color3.fromRGB = fromRGB;
	}

	// ---- the wardrobe: the same art, magnified, whole in its box and in every tile
	{
		const panel = makeInstance("Frame");
		const W = 420;
		const H = 270;
		const preview = new PV.SurvivorPreview(panel, { x: 10, y: 20, w: W, h: H });
		let worst = 0;
		let worstWhat = "";
		let texel = 0;
		for (const [oname, outfit] of OUTFITS) {
			for (const [pname, pet] of [["sem pet", 0], ...PETS]) {
				preview.setOutfit(outfit);
				preview.setPet(pet);
				preview.draw(0.7);
				for (const s of imagesOf(preview.renderer)) {
					const c = cellOf(s);
					texel = s.w / s.rw;
					const out = Math.max(-c.minX, -c.minY, c.maxX - W, c.maxY - H, 0);
					if (out > worst) {
						worst = out;
						worstWhat = `${oname} + ${pname}`;
					}
				}
			}
		}
		check(
			worst <= 0.5,
			"na previa, todo traje x todo pet cabe inteiro na caixa (os texels, nao so a celula)",
			worst > 0
				? `saiu ${worst.toFixed(1)} px em ${worstWhat}`
				: `${OUTFITS.length * (PETS.length + 1)} combinacoes`,
		);
		check(
			Math.abs(texel - 4 * preview.scale) < 0.6,
			"um texel e 4 u x escala: a mesma arte do mundo, ampliada",
			`${texel.toFixed(1)} px a ${preview.scale}x`,
		);
		preview.setOutfit(COS.OutfitLook.Cowboy);
		preview.setPet(COS.PetLook.Malamute);
		preview.draw(0);
		const before = tree.created.length;
		tree.writes = 0;
		tree.counting = true;
		preview.draw(0);
		tree.counting = false;
		check(
			tree.writes === 0 && tree.created.length === before,
			"redesenhar sem mudanca nao escreve propriedade nem cria Instance",
			`${tree.writes} escritas`,
		);
		preview.destroy();
		const S = 92;
		let tileOut = 0;
		let tileWhat = "";
		const tiles = [
			...OUTFITS.map(([n, look]) => [n, "outfit", look]),
			...PETS.map(([n, look]) => [n, "pet", look]),
		];
		for (const [name, subject, look] of tiles) {
			const tile = new PV.SurvivorPreview(panel, { w: S, h: S, subject });
			if (subject === "outfit") tile.setOutfit(look);
			else tile.setPet(look);
			tile.draw(0.4);
			const images = imagesOf(tile.renderer);
			check(images.length >= 1, `${name}: o ladrilho desenha a pixel art`, `${images.length} celulas`);
			for (const s of images) {
				const c = cellOf(s);
				const out = Math.max(-c.minX, -c.minY, c.maxX - S, c.maxY - S, 0);
				if (out > tileOut) {
					tileOut = out;
					tileWhat = name;
				}
			}
			tile.destroy();
		}
		check(
			tileOut <= 0.5,
			"todo ladrilho mostra o seu cosmetico inteiro",
			tileOut > 0 ? `saiu ${tileOut.toFixed(1)} px (${tileWhat})` : `${S} x ${S}`,
		);
		// the shop's pet packs, framed on their own pet (packPetScene): the texels whole in the card's picture too, and
		// the pigeon -- small in the world -- clearly bigger than the wardrobe's framing would draw it in the same box
		const { SHOP_PACKS } = require(join(SRC, "shared/data/shop.ts"));
		const { ItemKind } = require(join(SRC, "shared/data/kinds.ts"));
		let packOut = 0;
		let packWhat = "";
		let packs = 0;
		for (const p of SHOP_PACKS) {
			for (const it of p.items) {
				const look = it.kind === ItemKind.Equip ? COS.petLookOfEquip(it.index) : COS.PetLook.None;
				if (look === COS.PetLook.None) continue;
				packs++;
				for (const [w, h] of [
					[90, 82],
					[60, 50],
				]) {
					const pic = new PV.SurvivorPreview(panel, { w, h, subject: "pet", scene: PV.packPetScene(look) });
					pic.setPet(look);
					pic.draw(0);
					for (const s of imagesOf(pic.renderer)) {
						const c = cellOf(s);
						const out = Math.max(-c.minX, -c.minY, c.maxX - w, c.maxY - h, 0);
						if (out > packOut) {
							packOut = out;
							packWhat = `${p.name} ${w}x${h}`;
						}
					}
					pic.destroy();
				}
			}
		}
		const framed = new PV.SurvivorPreview(panel, {
			w: 90,
			h: 82,
			subject: "pet",
			scene: PV.packPetScene(COS.PetLook.Pigeon),
		});
		const plain = new PV.SurvivorPreview(panel, { w: 90, h: 82, subject: "pet" });
		check(
			packs === 2 && packOut <= 0.5 && framed.scale > plain.scale * 1.4,
			"loja: o pet de cada pacote, em pixel art, inteiro no cartao e maior que no enquadramento do guarda-roupa",
			packOut > 0
				? `saiu ${packOut.toFixed(1)} px (${packWhat})`
				: `${framed.scale.toFixed(2)}x contra ${plain.scale.toFixed(2)}x`,
		);
		framed.destroy();
		plain.destroy();
	}
	WA.overrideWorldArt(undefined);
}

// ---------------------------------------------------------------- verdict

console.log("");
if (failures > 0) {
	console.log(`${failures} de ${checks} verificacao(oes) falharam`);
	process.exit(1);
}
console.log(`${checks} verificacoes, 0 falhas`);
