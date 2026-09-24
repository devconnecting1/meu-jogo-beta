#!/usr/bin/env node
/*
 * The night's light map (shared/engine/renderer.ts LightMap) and the client's quality tier (client/view/quality.ts),
 * on the fake GUI of tools/fake-gui.mjs, which counts every property write that changes a value.
 *
 *   npm run test:light
 *   PZ_SRC=<another checkout>/src node tools/test-light.mjs     (measures that version; an older one fails the checks)
 *
 * What this proves (docs/research/performance.md, audit M1 and M6):
 *   1. THE COST, BEFORE AND AFTER. The audit's scene -- two lamps, a flickering campfire, the survivor walking past
 *      them, firing -- at 1920 x 1080 on the High and the Low tier: gradient rewrites, NumberSequences and keypoints
 *      allocated per frame, strips and GuiEffects (strips carrying a gradient), against the numbers of 2558ad0 (the
 *      light map before this change). A street lit only by the survivor carries a gradient on under half its strips.
 *   2. HIGH LOOKS THE SAME. With the camera still, the High map at 720p is the 6 px map of before, pixel for pixel;
 *      at 1080p (8 px strips) it is within a hair of it (mean under 1/255, 99% of the pixels within 2 steps), and
 *      exactly as far from the true light as the 6 px map is. After walking, a camera that stops shows what a map
 *      drawn from scratch there shows (within WRITE_EPS), on both tiers.
 *   3. lightAt AGREES WITH THE DRAWN MAP. The darkness the screen shows is maxDark × (1 − lightAt) -- the rule the
 *      zombies' awareness marks read (client/view/zombieAwareness.ts) -- within the map's own sampling error, on both
 *      tiers, with lamps, a fire, a flashlight's cone and a muzzle flash.
 *   4. THE LOW TIER'S CAP NEVER TEARS. Past LOW_REWRITES gradient rewrites a frame, a strip that drifted a little waits;
 *      a strip that changed a lot (a blast, a lamp coming on) is drawn at once. So no strip is ever more than 4 steps
 *      (≈ 0.06 opacity) off an uncapped map of the same strips -- walking, firing, blasts -- and a still camera never
 *      holds one back for more than a frame or two.
 *   5. NO CHURN. 600 frames walking, and switching High → Low → High twice, create no Instance once both layouts
 *      exist; the gradient memo stays bounded.
 *   7. THE WEATHER (LUZ-05). The fog is a second LightMap with one light, the survivor: walking through it at 1080p
 *      costs a fraction of the night's rewrites on both tiers, creates no Instance, a still one writes nothing, and the
 *      drawn fog is the rule's (`fogScreenAt`) at every pixel. A lightning strike lifts the night's own map for a few
 *      rewrites (the Reduce Motion swell too) and the night after it is back where it was, writing nothing.
 *   6. AUTO'S HYSTERESIS. The governor (QualityGovernor) against scripted frame times: a steady 60 FPS never drops; a
 *      slow device drops after 3 s and stays; bursts, hitches and a borderline 50 FPS never switch; a device that is
 *      fast on Low but slow on High settles on Low after at most five switches (no flapping); one that cools down
 *      comes back to High once and stays. High and Low are fixed, and Auto is only measured while it is Auto.
 *
 * Pure Node (>= 18) plus the project's TypeScript.
 */
import { join } from "node:path";
import { installShims } from "./luau-shim.mjs";
import { installFakeGui } from "./fake-gui.mjs";

const { SRC, require } = installShims({ seed: 7 });
const gui = installFakeGui();

// allocations: every NumberSequence and keypoint the light map makes (userdata in Luau: garbage for the GC)
let keypoints = 0;
let sequences = 0;
{
	const KP = globalThis.NumberSequenceKeypoint;
	const NS = globalThis.NumberSequence;
	globalThis.NumberSequenceKeypoint = function (...a) {
		keypoints++;
		return new KP(...a);
	};
	globalThis.NumberSequence = function (...a) {
		sequences++;
		return new NS(...a);
	};
}
let gradWrites = 0;
gui.stats.onWrite = (inst, prop, changed) => {
	if (changed && inst.ClassName === "UIGradient" && prop === "Transparency") gradWrites++;
};

const { Camera } = require(join(SRC, "shared/engine/camera.ts"));
const R = require(join(SRC, "shared/engine/renderer.ts"));
const { LightMap, lightAt, lightStripHeight } = R;
const { COLORS } = require(join(SRC, "shared/engine/colors.ts"));
const Q = require(join(SRC, "client/view/quality.ts"));

let failures = 0;
function check(name, ok, detail) {
	const tail = detail === undefined ? "" : `  (${detail})`;
	if (ok) console.log(`  ok    ${name}${tail}`);
	else {
		console.error(`  FALHA ${name}${tail}`);
		failures++;
	}
}
const f1 = v => v.toFixed(1);
const f4 = v => v.toFixed(4);
const STEP = 1 / 64;
const DARK = 0.85;

console.log(`Light map e nivel de qualidade: fonte ${SRC}\n`);
const tiered = typeof lightStripHeight === "function" && typeof LightMap.prototype.setLowDetail === "function";
if (!tiered) console.log("  (esta versao nao tem niveis: mede so o mapa de antes)\n");

/** a light map on its own Frame, on the tier asked (a version without tiers is always "high") */
function makeMap(low, stripH) {
	const lm = new LightMap(gui.make("Frame"), COLORS.overlayNight, stripH);
	if (tiered) lm.setLowDetail(low);
	return lm;
}

/** the audit's scene (scratchpad light.mjs of the performance audit): the survivor at x, two lamps, a campfire */
function auditLights(out, f, x, shoot) {
	out.length = 0;
	out.push({ x, y: 1000, r: 250, inner: 0.4 });
	out.push({ x: 1300, y: 900, r: 400, inner: 0.5 });
	out.push({ x: 1900, y: 1150, r: 400, inner: 0.5 });
	out.push({ x: 1600, y: 1100, r: 300 * (0.92 + Math.sin((f / 60) * 11) * 0.05), inner: 0.5 });
	if (shoot && f % 6 < 2) out.push({ x: x + 20, y: 1000, r: 150, k: 0.85, inner: 0.2 });
	return out;
}

/** strips on screen and how many carry a gradient (a GuiEffect), read off the Instances */
function effects(lm) {
	let strips = 0;
	let grads = 0;
	for (const s of lm.layer.GetChildren()) {
		if (s.Visible === false) continue;
		strips++;
		if (s.GetChildren().some(k => k.ClassName === "UIGradient" && k.Enabled !== false)) grads++;
	}
	return { strips, grads };
}

/** the darkness (alpha) each pixel of the view shows, as the engine blends a strip: base × (1 − gradient) */
function alphaField(lm, W, H) {
	const out = new Float32Array(W * H);
	for (const s of lm.layer.GetChildren()) {
		if (s.Visible === false) continue;
		const y0 = s.Position.Y.Offset;
		const h = s.Size.Y.Offset;
		const w = s.Size.X.Offset;
		const grad = s.GetChildren().find(k => k.ClassName === "UIGradient" && k.Enabled !== false);
		const base = 1 - s.BackgroundTransparency;
		const keys = grad ? grad.Transparency.Keypoints : undefined;
		let k = 0;
		for (let x = 0; x < W; x++) {
			let a = base;
			if (keys !== undefined) {
				const t = (x + 0.5) / w;
				while (k < keys.length - 2 && keys[k + 1].Time < t) k++;
				const A = keys[k];
				const B = keys[Math.min(keys.length - 1, k + 1)];
				const u = B.Time > A.Time ? Math.min(1, Math.max(0, (t - A.Time) / (B.Time - A.Time))) : 0;
				a = base * (1 - (A.Value + (B.Value - A.Value) * u));
			}
			for (let y = y0; y < Math.min(H, y0 + h); y++) out[y * W + x] = a;
		}
	}
	return out;
}
/** the true darkness: maxDark × (1 − lightAt) at each pixel's centre */
function truthField(cam, lights, W, H) {
	const out = new Float32Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++)
			out[y * W + x] = DARK * (1 - lightAt(lights, cam.x - W / 2 + x + 0.5, cam.y - H / 2 + y + 0.5));
	return out;
}
function diff(a, b) {
	let max = 0;
	let sum = 0;
	const d = new Float32Array(a.length);
	for (let i = 0; i < a.length; i++) {
		d[i] = Math.abs(a[i] - b[i]);
		if (d[i] > max) max = d[i];
		sum += d[i];
	}
	d.sort();
	return { max, mean: sum / a.length, p99: d[Math.floor(d.length * 0.99)] };
}

// ================================================================ 1. the cost, before and after

console.log("1) o custo por quadro a 1080p: reescritas de gradiente, alocacoes e GuiEffects, antes e depois\n");

/**
 * The light map of 2558ad0 (one UIGradient per 6 px strip, always on; every rewritten strip a new NumberSequence of
 * new keypoints) on this very scene: `PZ_SRC=<2558ad0>/src node tools/test-light.mjs` prints these numbers again.
 */
const BEFORE = {
	"1920x1080 walking": { writes: 49.7, keypoints: 967, sequences: 49.7, strips: 180, grads: 180 },
	"1920x1080 walking+firing": { writes: 50.0, keypoints: 972, sequences: 50.0, strips: 180, grads: 180 },
	"1920x1080 still, campfire": { writes: 11.0, keypoints: 212, sequences: 11.0, strips: 180, grads: 180 },
	"1280x720 walking": { writes: 36.8, keypoints: 679, sequences: 36.8, strips: 120, grads: 120 },
	"844x390 walking": { writes: 16.7, keypoints: 265, sequences: 16.7, strips: 65, grads: 65 },
};

function measure(W, H, low, walk, shoot) {
	const lm = makeMap(low);
	const cam = new Camera();
	cam.setView(W, H);
	const lights = [];
	const frame = f => {
		const x = 1000 + (walk ? f * 2.5 : 0);
		cam.x = x;
		cam.y = 1000;
		lm.update(cam, DARK, auditLights(lights, f, x, shoot));
	};
	for (let f = 0; f < 5; f++) frame(f);
	const c0 = gui.stats.created;
	gradWrites = 0;
	keypoints = 0;
	sequences = 0;
	let grads = 0;
	let maxWrites = 0;
	let prev = 0;
	for (let f = 0; f < 600; f++) {
		frame(f);
		maxWrites = Math.max(maxWrites, gradWrites - prev);
		prev = gradWrites;
		grads += effects(lm).grads;
	}
	return {
		writes: gradWrites / 600,
		maxWrites,
		keypoints: keypoints / 600,
		sequences: sequences / 600,
		strips: effects(lm).strips,
		grads: grads / 600,
		created: gui.stats.created - c0,
	};
}

const now = {};
const table = [];
for (const [key, W, H, walk, shoot] of [
	["1920x1080 walking", 1920, 1080, true, false],
	["1920x1080 walking+firing", 1920, 1080, true, true],
	["1920x1080 still, campfire", 1920, 1080, false, false],
	["1280x720 walking", 1280, 720, true, false],
	["844x390 walking", 844, 390, true, false],
]) {
	for (const low of tiered ? [false, true] : [false]) {
		const m = measure(W, H, low, walk, shoot);
		now[`${key} ${low ? "low" : "high"}`] = m;
		const b = BEFORE[key];
		table.push(
			`    ${(key + (low ? "  LOW" : "  HIGH")).padEnd(34)} gradient ${f1(b.writes).padStart(5)} -> ${f1(m.writes).padStart(5)}/q (max ${m.maxWrites})` +
				`   keypoints ${String(b.keypoints).padStart(4)} -> ${f1(m.keypoints).padStart(5)}   NumberSequence ${f1(b.sequences).padStart(5)} -> ${f1(m.sequences).padStart(5)}` +
				`   GuiEffects ${b.grads} -> ${m.grads.toFixed(0)} de ${m.strips} tiras`,
		);
	}
}
console.log("    antes (2558ad0) -> agora, por quadro, 600 quadros:");
for (const line of table) console.log(line);
console.log("");

{
	const hi = now["1920x1080 walking high"];
	const b = BEFORE["1920x1080 walking"];
	check(
		"1080p High andando: um quarto menos de reescritas de gradiente (tiras de 8 px) e os keypoints quase todos da memoria",
		hi.writes <= b.writes * 0.8 && hi.keypoints <= 10 && hi.sequences <= b.sequences * 0.8 && hi.created === 0,
		`${f1(b.writes)} -> ${f1(hi.writes)} reescritas, ${b.keypoints} -> ${f1(hi.keypoints)} keypoints, ${f1(b.sequences)} -> ${f1(hi.sequences)} sequencias`,
	);
	const allocBefore = b.keypoints + b.sequences;
	const allocHigh = hi.keypoints + hi.sequences;
	check(
		"...no total, 90% menos userdata alocados por quadro (keypoints + NumberSequences)",
		allocHigh <= allocBefore * 0.1,
		`${f1(allocBefore)} -> ${f1(allocHigh)} por quadro`,
	);
}
if (tiered) {
	const lo = now["1920x1080 walking low"];
	const b = BEFORE["1920x1080 walking"];
	check(
		"1080p Low andando: tiras de 12 px e o teto de reescritas: menos da metade das reescritas e das alocacoes de antes",
		lo.writes <= b.writes * 0.45 && lo.sequences <= b.sequences * 0.45 && lo.keypoints <= 10 && lo.strips === 90,
		`${f1(b.writes)} -> ${f1(lo.writes)} reescritas, ${f1(b.sequences)} -> ${f1(lo.sequences)} sequencias, ${lo.strips} tiras`,
	);
	const still = now["1920x1080 still, campfire high"];
	const bs = BEFORE["1920x1080 still, campfire"];
	check(
		"camera parada com a fogueira tremendo: menos reescritas e a memoria devolve a maioria das sequencias (a chama se repete)",
		still.writes < bs.writes && still.sequences <= still.writes * 0.8 && still.keypoints <= 1,
		`${f1(still.writes)} reescritas, ${f1(still.sequences)} sequencias novas, ${f1(still.keypoints)} keypoints`,
	);
}
{
	// a street at night lit only by the survivor: the rows no light reaches are one colour, with no GuiEffect
	const cam = new Camera();
	cam.setView(1920, 1080);
	cam.x = 1000;
	cam.y = 1000;
	const lm = makeMap(false);
	lm.update(cam, DARK, [{ x: 1000, y: 1000, r: 250, inner: 0.4 }]);
	const e = effects(lm);
	check(
		"rua iluminada so pelo sobrevivente (1080p): menos da metade das tiras carrega gradiente (antes: todas as 180)",
		tiered && e.grads <= e.strips * 0.5 && e.grads > 0,
		`${e.grads} de ${e.strips} tiras com gradiente`,
	);
	// and a still camera over a still night costs nothing at all
	const w0 = gui.stats.writes;
	keypoints = 0;
	sequences = 0;
	for (let f = 0; f < 120; f++) lm.update(cam, DARK, [{ x: 1000, y: 1000, r: 250, inner: 0.4 }]);
	check(
		"...e uma noite parada com a camera parada nao escreve nem aloca nada (120 quadros)",
		gui.stats.writes === w0 && keypoints === 0 && sequences === 0,
		`${gui.stats.writes - w0} escritas, ${keypoints + sequences} alocacoes`,
	);
}

// ================================================================ 2. High looks the same

console.log("\n2) High igual ao de antes com a camera parada\n");

const SCENES = {
	lamps: x => auditLights([], 0, x, false),
	survivor: x => [{ x, y: 1000, r: 250, inner: 0.4 }],
	flashlight: x => [
		{ x, y: 1000, r: 250, inner: 0.4 },
		{ x, y: 1000, r: 520, inner: 0.35, angle: 0.4, cone: 0.35 },
		{ x: x - 500, y: 1200, r: 150, k: 0.85, inner: 0.2 },
		{ x: x + 600, y: 800, r: 300, inner: 0.5 },
	],
};
function still(W, H, lm, lights) {
	const cam = new Camera();
	cam.setView(W, H);
	cam.x = 1000;
	cam.y = 1000;
	lm.update(cam, DARK, lights);
	return cam;
}
if (tiered) {
	const bad720 = [];
	for (const [name, mk] of Object.entries(SCENES)) {
		const lights = mk(1000);
		const a = makeMap(false);
		const b = makeMap(false, 6);
		still(1280, 720, a, lights);
		still(1280, 720, b, lights);
		const d = diff(alphaField(a, 1280, 720), alphaField(b, 1280, 720));
		if (d.max !== 0) bad720.push(`${name} ${f4(d.max)}`);
	}
	check(
		"720p: o High desenha em tiras de 6 px, o mapa de antes pixel a pixel (lampadas, sobrevivente, lanterna)",
		lightStripHeight(720, false) === 6 && bad720.length === 0,
		bad720.join(", ") || "diferenca 0 em todo pixel",
	);
	const rows = [];
	let ok = true;
	for (const [name, mk] of Object.entries(SCENES)) {
		const lights = mk(1000);
		const hi = makeMap(false);
		const six = makeMap(false, 6);
		const cam = still(1920, 1080, hi, lights);
		still(1920, 1080, six, lights);
		const A = alphaField(hi, 1920, 1080);
		const B = alphaField(six, 1920, 1080);
		const T = truthField(cam, lights, 1920, 1080);
		const ab = diff(A, B);
		const at = diff(A, T);
		const bt = diff(B, T);
		const same =
			ab.mean <= 1 / 255 && ab.p99 <= 2 * STEP + 1e-6 && at.mean <= bt.mean + 0.0005 && at.p99 <= bt.p99 + 0.005;
		ok &&= same;
		rows.push(
			`${name}: 8 px x 6 px media ${f4(ab.mean)} p99 ${f4(ab.p99)}; erro x luz verdadeira media ${f4(bt.mean)} -> ${f4(at.mean)}, p99 ${f4(bt.p99)} -> ${f4(at.p99)}`,
		);
	}
	check(
		"1080p: o High (tiras de 8 px) fica a um fio do de 6 px (media < 1/255, 99% dos pixels a 2 passos) e tao perto da luz verdadeira quanto ele",
		ok,
		rows.join(" | "),
	);
	// walking, then a camera that stops: what shows is what a map drawn there from scratch shows
	const stop = [];
	for (const low of [false, true]) {
		const lm = makeMap(low);
		const cam = new Camera();
		cam.setView(1920, 1080);
		const lights = [];
		let x = 1000;
		for (let f = 0; f < 240; f++) {
			x = 1000 + f * 2.5;
			cam.x = x;
			cam.y = 1000;
			lm.update(cam, DARK, auditLights(lights, 0, x, f % 6 < 2));
		}
		for (let f = 0; f < 10; f++) lm.update(cam, DARK, auditLights(lights, 0, x, false));
		const fresh = makeMap(low);
		fresh.update(cam, DARK, auditLights(lights, 0, x, false));
		const d = diff(alphaField(lm, 1920, 1080), alphaField(fresh, 1920, 1080));
		stop.push({ low, d });
	}
	check(
		"andou 240 quadros e parou: em 10 quadros a tela e a de um mapa desenhado do zero ali (a 2 passos, WRITE_EPS), High e Low",
		stop.every(s => s.d.max <= 2 * STEP + 1e-6),
		stop.map(s => `${s.low ? "Low" : "High"} max ${f4(s.d.max)}`).join(", "),
	);
}

// ================================================================ 3. lightAt agrees with the drawn map

console.log("\n3) lightAt e o mapa desenhado dizem a mesma coisa\n");

if (tiered) {
	const rows = [];
	let ok = true;
	for (const low of [false, true]) {
		for (const [name, mk] of Object.entries(SCENES)) {
			const lights = mk(1000);
			const lm = makeMap(low);
			const cam = still(1920, 1080, lm, lights);
			const d = diff(alphaField(lm, 1920, 1080), truthField(cam, lights, 1920, 1080));
			const good = d.mean <= 0.012 && d.p99 <= 0.06;
			ok &&= good;
			rows.push(`${low ? "Low" : "High"} ${name}: media ${f4(d.mean)} p99 ${f4(d.p99)}`);
		}
	}
	check(
		"a escuridao desenhada e maxDark x (1 - lightAt) a menos do erro de amostragem do mapa (media <= 0,012, p99 <= 0,06), nos dois niveis",
		ok,
		rows.join(" | "),
	);
}

// ================================================================ 4. the low tier's cap never tears

console.log("\n4) o teto do Low: nenhuma emenda\n");

/** how far (transparency) the strips of `a` are from those of `b` (the same geometry), sampled every 8 px */
function stripGap(a, b, W) {
	const sa = a.layer.GetChildren().filter(s => s.Visible !== false);
	const sb = b.layer.GetChildren().filter(s => s.Visible !== false);
	const shown = (s, x) => {
		const g = s.GetChildren().find(k => k.ClassName === "UIGradient" && k.Enabled !== false);
		const base = 1 - s.BackgroundTransparency;
		if (!g) return base;
		const keys = g.Transparency.Keypoints;
		const t = x / s.Size.X.Offset;
		let k = 0;
		while (k < keys.length - 2 && keys[k + 1].Time < t) k++;
		const A = keys[k];
		const B = keys[Math.min(keys.length - 1, k + 1)];
		const u = B.Time > A.Time ? Math.min(1, Math.max(0, (t - A.Time) / (B.Time - A.Time))) : 0;
		return base * (1 - (A.Value + (B.Value - A.Value) * u));
	};
	let worst = 0;
	for (let i = 0; i < sa.length; i++)
		for (let x = 0; x <= W; x += 8) worst = Math.max(worst, Math.abs(shown(sa[i], x) - shown(sb[i], x)));
	return worst;
}
if (tiered) {
	const rows = [];
	let tearFree = true;
	let stillFlushed = true;
	for (const [W, H] of [
		[1920, 1080],
		[1280, 720],
	]) {
		for (const [label, walk, blasts] of [
			["parada: fogueira, tiros, explosoes", false, true],
			["andando: tiros, explosoes", true, true],
		]) {
			const lm = makeMap(true);
			const ref = makeMap(false, lightStripHeight(H, true));
			const cam = new Camera();
			cam.setView(W, H);
			const lights = [];
			let worst = 0;
			let held = 0;
			// how many frames in a row each strip has been waiting (the map's own `pending` flags)
			const age = [];
			let oldest = 0;
			for (let f = 0; f < 480; f++) {
				const x = 1000 + (walk ? f * 2.5 : 0);
				cam.x = x;
				cam.y = 1000;
				auditLights(lights, f, x, true);
				// a blast in the dark every 1.5 s, full for 0.2 s then fading over 0.4 s (fxView explosionFade)
				const t = f % 90;
				if (blasts && t < 36)
					lights.push({ x: x - 420, y: 1260, r: 220, k: t < 12 ? 1 : 1 - (t - 12) / 24, inner: 0.35 });
				lm.update(cam, DARK, lights);
				ref.update(cam, DARK, lights);
				if (f >= 5 && f % 2 === 0) worst = Math.max(worst, stripGap(lm, ref, W));
				held += lm.stats.deferred;
				for (let row = 0; row < lm.stats.strips; row++) {
					age[row] = lm.pending[row] ? (age[row] ?? 0) + 1 : 0;
					oldest = Math.max(oldest, age[row]);
				}
			}
			if (worst > 4 * STEP + 1e-6) tearFree = false;
			if (!walk && oldest > 2) stillFlushed = false;
			rows.push(
				`${W}x${H} ${label}: pior ${(worst / STEP).toFixed(1)} passos, ${f1(held / 480)} tiras adiadas/q, a que mais esperou ${oldest} q`,
			);
		}
	}
	check(
		"com o teto, nenhuma tira fica a mais de 4 passos (~0,06) de um mapa sem teto das mesmas tiras: explosao e lampada entram inteiras",
		tearFree,
		rows.join(" | "),
	);
	check("...e com a camera parada nenhuma tira espera mais de 2 quadros seguidos", stillFlushed);
}

// ================================================================ 5. no churn

console.log("\n5) sem churn: nenhuma Instance depois das duas disposicoes, memoria limitada\n");

if (tiered) {
	const lm = makeMap(false);
	const cam = new Camera();
	cam.setView(1920, 1080);
	const lights = [];
	const run = (frames, from) => {
		for (let f = 0; f < frames; f++) {
			const x = 1000 + (from + f) * 2.5;
			cam.x = x;
			cam.y = 1000;
			lm.update(cam, DARK, auditLights(lights, from + f, x, true));
		}
	};
	run(10, 0);
	lm.setLowDetail(true);
	run(10, 10);
	lm.setLowDetail(false);
	run(10, 20);
	const c0 = gui.stats.created;
	let f = 30;
	for (const low of [true, false, true, false]) {
		lm.setLowDetail(low);
		run(150, f);
		f += 150;
	}
	check(
		"600 quadros andando e atirando, trocando High -> Low -> High duas vezes: nenhuma Instance nova",
		gui.stats.created === c0,
		`${gui.stats.created - c0} criadas`,
	);
	// random lights for a long while: the gradient memo starts over instead of growing
	const rnd = (() => {
		let s = 12345;
		return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
	})();
	let peak = 0;
	for (let i = 0; i < 1500; i++) {
		lights.length = 0;
		for (let k = 0; k < 6; k++)
			lights.push({
				x: 1000 + rnd() * 1800 - 900,
				y: 1000 + rnd() * 1000 - 500,
				r: 80 + rnd() * 300,
				inner: 0.4,
			});
		cam.x = 1000;
		cam.y = 1000;
		lm.update(cam, DARK, lights);
		peak = Math.max(peak, lm.seqMemoSize ?? 0);
	}
	check(
		"a memoria de gradientes fica limitada (512) com 1500 quadros de luzes ao acaso",
		peak > 0 && peak <= 512,
		`pico ${peak}`,
	);
}

// ================================================================ 6. Auto's hysteresis

console.log("\n6) Auto: histerese, sem vaivem\n");

/** runs `seconds` of frames whose time is `dtOf(t, low)` through a fresh governor; returns its switches over time */
function drive(seconds, dtOf) {
	const g = new Q.QualityGovernor();
	const log = [];
	let t = 0;
	while (t < seconds) {
		const dt = dtOf(t, g.low);
		const before = g.low;
		g.sample(dt);
		t += dt;
		if (g.low !== before) log.push({ t, low: g.low });
	}
	return { g, log };
}
const at = log => log.map(e => `${e.low ? "Low" : "High"}@${e.t.toFixed(0)}s`).join(" ") || "nenhuma troca";
{
	const steady = drive(600, () => 1 / 60);
	check("60 FPS por 10 min: fica em High, nenhuma troca", steady.log.length === 0 && !steady.g.low, at(steady.log));
	const slow = drive(600, () => 0.03);
	check(
		"um aparelho a 33 FPS: desce para Low em ~3 s e fica (uma troca)",
		slow.log.length === 1 && slow.log[0].low && slow.log[0].t <= 4.1,
		at(slow.log),
	);
	const border = drive(600, () => 0.02);
	check("50 FPS (entre os dois limiares) por 10 min: nenhuma troca", border.log.length === 0, at(border.log));
	const bursts = drive(600, t => (t % 10 < 2 ? 0.04 : 1 / 60));
	check(
		"rajadas de 2 s a 25 FPS a cada 10 s: nenhuma troca (precisa de 3 s lentos seguidos)",
		bursts.log.length === 0,
		at(bursts.log),
	);
	let next = 0;
	const hitches = drive(600, t => {
		if (t >= next) {
			next = t + 3;
			return 0.6;
		}
		return 1 / 60;
	});
	check(
		"um engasgo de 0,6 s a cada 3 s (carga, GC) num jogo a 60 FPS: nenhuma troca",
		hitches.log.length === 0,
		at(hitches.log),
	);
	const flap = drive(1200, (t, low) => (low ? 1 / 60 : 0.026));
	const last = flap.log[flap.log.length - 1];
	check(
		"rapido no Low e lento no High: no maximo 5 trocas e fica em Low (sem vaivem a cada 23 s)",
		flap.log.length <= 5 && flap.g.low && flap.g.locked && last.t < 200,
		`${flap.log.length} trocas: ${at(flap.log)}`,
	);
	const cools = drive(600, (t, low) => (t < 10 ? 0.03 : low ? 1 / 60 : 1 / 60));
	check(
		"lento 10 s e depois bom nos dois (esfriou): volta ao High uma vez e fica",
		cools.log.length === 2 && !cools.g.low && cools.log[1].t < 40,
		at(cools.log),
	);
}
{
	// the module: High and Low are fixed, and Auto is only measured while the setting is Auto
	for (let i = 0; i < 600; i++) Q.qualityFrame(0.05, Q.GRAPHICS_HIGH);
	const autoUntouched = Q.lowDetail(Q.GRAPHICS_AUTO) === false;
	const highFixed = Q.qualityFrame(0.05, Q.GRAPHICS_HIGH) === false;
	for (let i = 0; i < 300; i++) Q.qualityFrame(0.05, Q.GRAPHICS_AUTO);
	const autoDropped = Q.lowDetail(Q.GRAPHICS_AUTO) === true;
	check(
		"High e Low sao fixos (10 s lentos em High nao mexem no Auto); em Auto os mesmos quadros levam a Low; High continua High",
		autoUntouched &&
			highFixed &&
			autoDropped &&
			Q.lowDetail(Q.GRAPHICS_HIGH) === false &&
			Q.lowDetail(Q.GRAPHICS_LOW) === true,
	);
}

// ================================================================ 7. the fog and the lightning (LUZ-05)

console.log("\n7) o clima (LUZ-05): a neblina e o relampago pelo mesmo LightMap, no High e no Low, sem churn\n");
{
	const WV = require(join(SRC, "client/view/weatherView.ts"));
	const Wx = require(join(SRC, "shared/sim/weather.ts"));

	/**
	 * A survivor walking through fog as the game moves them (250 u/s, a new heading every 1.5 s, a stop every 4.5 s)
	 * with the camera following the way GameLoop does (`follow`, lerp dt·8): the fog's one "light" is the survivor,
	 * who stays near the middle of the screen, so the map changes only as far as the camera lags.
	 */
	function fogWalk(W, H, low, density = 1) {
		const view = new WV.WeatherView();
		const parent = gui.make("Frame");
		const cam = new Camera();
		cam.setView(W, H);
		const dt = 1 / 60;
		let px = 1000;
		let py = 1000;
		cam.x = px;
		cam.y = py;
		const frame = f => {
			const heading = Math.floor(f / 90) * 1.3;
			const moving = f % 270 < 200;
			if (moving) {
				px += Math.cos(heading) * 250 * dt;
				py += Math.sin(heading) * 250 * dt;
			}
			cam.follow(px, py, Math.min(1, dt * 8));
			view.drawFog(parent, cam, density, px, py, low);
		};
		for (let f = 0; f < 5; f++) frame(f);
		const c0 = gui.stats.created;
		gradWrites = 0;
		keypoints = 0;
		sequences = 0;
		let maxWrites = 0;
		let prev = 0;
		let grads = 0;
		for (let f = 5; f < 605; f++) {
			frame(f);
			maxWrites = Math.max(maxWrites, gradWrites - prev);
			prev = gradWrites;
			grads += effects(view.fogLayer()).grads;
		}
		return {
			view,
			cam,
			px,
			py,
			writes: gradWrites / 600,
			maxWrites,
			alloc: (keypoints + sequences) / 600,
			created: gui.stats.created - c0,
			strips: effects(view.fogLayer()).strips,
			grads: grads / 600,
		};
	}
	const hi = fogWalk(1920, 1080, false);
	const lo = fogWalk(1920, 1080, true);
	const night = now["1920x1080 walking high"];
	console.log(
		`    neblina a 1080p andando: HIGH ${f1(hi.writes)} reescritas/q (max ${hi.maxWrites}), ${f1(hi.alloc)} alocacoes/q, ` +
			`${hi.grads.toFixed(0)} GuiEffects de ${hi.strips} tiras; LOW ${f1(lo.writes)}/q (max ${lo.maxWrites}), ` +
			`${f1(lo.alloc)} alocacoes/q, ${lo.grads.toFixed(0)} de ${lo.strips} (a noite com lampioes: ${f1(night.writes)}/q)`,
	);
	check(
		"a neblina andando custa menos que a noite andando: um quarto das reescritas de gradiente no High, e o Low menos que o High",
		hi.writes <= night.writes * 0.25 && lo.writes <= hi.writes && lo.alloc <= hi.alloc + 0.01,
		`${f1(hi.writes)} e ${f1(lo.writes)} contra ${f1(night.writes)}`,
	);
	check(
		"...e nenhuma Instance depois do primeiro quadro, nos dois niveis (600 quadros)",
		hi.created === 0 && lo.created === 0,
		`${hi.created} e ${lo.created}`,
	);
	check(
		"o Low da neblina e o Low da noite: tiras de 12 px a 1080p",
		lo.strips === 90 && hi.strips === 135,
		`${hi.strips} / ${lo.strips}`,
	);
	{
		// a still survivor under a still camera: nothing at all
		const w0 = gui.stats.writes;
		keypoints = 0;
		sequences = 0;
		const parent = hi.view.fogLayer().layer.Parent;
		for (let f = 0; f < 120; f++) hi.view.drawFog(parent, hi.cam, 1, hi.px, hi.py, false);
		const w1 = gui.stats.writes;
		check(
			"parado, a neblina parada nao escreve nem aloca nada (120 quadros)",
			w1 === w0 && keypoints + sequences === 0,
			`${w1 - w0} escritas`,
		);
	}
	{
		// the drawn fog is the rule: FOG_SCREEN_MAX × density × (distance from the survivor), within the strips' error
		const cam = new Camera();
		cam.setView(1280, 720);
		cam.x = 1000;
		cam.y = 1000;
		const view = new WV.WeatherView();
		const host = gui.make("Frame");
		view.drawFog(host, cam, 0.8, 1040, 990, false);
		const drawn = alphaField(view.fogLayer(), 1280, 720);
		let worst = 0;
		let sum = 0;
		for (let y = 0; y < 720; y++) {
			for (let x = 0; x < 1280; x++) {
				const d = Math.hypot(cam.x - 640 + x + 0.5 - 1040, cam.y - 360 + y + 0.5 - 990);
				const e = Math.abs(drawn[y * 1280 + x] - Wx.fogScreenAt(0.8, d));
				worst = Math.max(worst, e);
				sum += e;
			}
		}
		check(
			"a neblina desenhada = fogScreenAt (a regra da LUZ-05) a cada pixel, dentro do erro das tiras",
			worst <= 0.05 && sum / (1280 * 720) <= 0.01,
			`max ${f4(worst)}, media ${f4(sum / (1280 * 720))}`,
		);
		// and a clear day hides the map (nothing drawn, nothing written)
		const w0 = gui.stats.writes;
		view.drawFog(host, cam, 0, 1040, 990, false);
		const hidden = view.fogLayer().layer.Visible === false;
		view.drawFog(host, cam, 0, 1040, 990, false);
		check("sem neblina o mapa se esconde (e nao escreve mais nada)", hidden && gui.stats.writes - w0 <= 1);
	}

	// ---- the lightning: the night's own map lifted, a few rewrites per strike, and a still night after it costs nothing
	{
		const lm = makeMap(false);
		const cam = new Camera();
		cam.setView(1920, 1080);
		cam.x = 1000;
		cam.y = 1000;
		const lights = [{ x: 1000, y: 1000, r: 250, inner: 0.4 }];
		const day = Wx.STORM_FROM_DAY + 3;
		const strike = Wx.strikesOfDay(day)[0];
		const speed = require(join(SRC, "shared/sim/clock.ts")).clockSpeed(strike.hour);
		const base = 0.85;
		const run = gentle => {
			lm.update(cam, base, lights);
			const w0 = gradWrites;
			const f0 = gui.stats.writes;
			const a0 = keypoints + sequences;
			let peakLift = 0;
			for (let f = -10; f < 120; f++) {
				const flash = Wx.stormFlashAt(Wx.Weather.Storm, day, strike.hour + (f / 60) * speed, gentle);
				peakLift = Math.max(peakLift, flash);
				lm.update(cam, base * (1 - Wx.FLASH_LIFT * flash), lights);
			}
			return {
				grad: gradWrites - w0,
				writes: gui.stats.writes - f0,
				alloc: keypoints + sequences - a0,
				peak: peakLift,
			};
		};
		const real = run(false);
		const gentle = run(true);
		const far = alphaField(lm, 1920, 1080)[10];
		const w0 = gui.stats.writes;
		for (let f = 0; f < 120; f++) lm.update(cam, base, lights);
		// a strike (~every 30 s) costs less than a third of a second of walking at night (the 1080p High walk above)
		const budget = night.writes * 20;
		check(
			"um raio levanta a noite do proprio mapa (ate FLASH_LIFT) e custa menos que 1/3 s de noite andando; o de Reduzir Movimento tambem",
			real.peak > 0.5 && real.grad <= budget && gentle.grad <= budget && real.alloc <= 2 * real.grad + 20,
			`real: ${real.grad} reescritas de gradiente, ${real.writes} escritas em 2 s; suave: ${gentle.grad} / ` +
				`${gentle.writes}; teto ${budget.toFixed(0)}`,
		);
		// what a strip shows stays within WRITE_EPS (2 steps) of the computed night, plus its own half step
		check(
			"...e depois dele a noite parada volta a nao escrever nada, a menos de WRITE_EPS da escuridao de antes",
			gui.stats.writes === w0 && Math.abs(far - base) <= 2 / 64 + 1 / 64 + 1e-6,
			`${gui.stats.writes - w0} escritas; canto ${f4(far)} (antes ${base})`,
		);
	}
}

console.log("");
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
}
console.log(
	"OK: a noite custa menos (reescritas, alocacoes, GuiEffects), o High e o de antes, lightAt concorda, o Low nao rasga e o Auto nao oscila",
);
