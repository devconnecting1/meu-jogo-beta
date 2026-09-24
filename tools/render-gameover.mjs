#!/usr/bin/env node
/*
 * The death screens (docs/DESIGN_RULES.md MP-21 / MP-22, UI-13) as the engine would show them, in PNG: the REAL
 * client/onboarding/gameOver.ts mounted on the counted fake tree (tools/ui-shim.mjs), laid out at a screen size
 * (tools/ui-layout.mjs) and painted (tools/ui-raster.mjs) with the skin's own textures (design/ui-skin), over a night
 * street drawn by the game's own code (docs/art/after/street-night.png, `npm run render:map`), which the see-through
 * scrim of every screen over a run dims (UI-06).
 *
 *   node tools/render-gameover.mjs --out <dir>                                   # this checkout
 *   PZ_SRC=<another checkout>/src node tools/render-gameover.mjs --out <dir>     # another version, same cases
 *   node tools/render-gameover.mjs --out <dir> --text none                       # no text (a font pass adds it)
 *
 * Writes, per case and screen: <case>-<screen>.png, and <case>-<screen>.json -- every text the screen shows, with its
 * box in screen pixels, colour, size in px, weight and alignment, so a pass with a real font can draw it (the raster's
 * own text is the 5 x 7 pixel font of tools/pixel-font.mjs: where a legend sits, not how it reads). Nothing is checked
 * here: test:screens measures the same drawing (section 7).
 *
 * The cases are the states gameOver.ts has to tell apart (an older checkout ignores what it does not know: the
 * survivors still standing, the record, the cause the server told -- UI-13's lesson): the first death, waiting with an
 * ally up, the last one down (the town falls
 * unless someone pays), a New game waiting for first light, no Rebirth money, and the end of a run with nobody to wake
 * you (offline).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installUiShims } from "./ui-shim.mjs";
import { layoutGame, paintList } from "./ui-layout.mjs";
import { rasterPaint } from "./ui-raster.mjs";
import { decodePNG, encodePNG } from "./png-lite.mjs";

const args = process.argv.slice(2);
const opt = name => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : undefined;
};
const OUT = opt("out");
if (OUT === undefined) {
	console.error("usage: node tools/render-gameover.mjs --out <dir> [--text pixel|none] [--only <case>]");
	process.exit(2);
}
const TEXT_MODE = opt("text") ?? "pixel";
const ONLY = opt("only");
mkdirSync(OUT, { recursive: true });

const ui = installUiShims({ seed: 1, viewport: [1120, 630] });
const { SRC, ROOT, require, flush, service, setViewport } = ui;
const boot = require(join(SRC, "client/bootstrap.ts"));
const GO = require(join(SRC, "client/onboarding/gameOver.ts"));
const { SKIN_TEXTURES } = require(join(SRC, "client/ui/skinAssets.ts"));
flush();

// ---------------------------------------------------------------- images the raster may meet

const skinImages = new Map();
for (const [name, t] of Object.entries(SKIN_TEXTURES)) {
	if (!t.id) continue;
	try {
		skinImages.set(t.id, decodePNG(readFileSync(join(ROOT, "design", "ui-skin", `${name}.png`))));
	} catch {
		// a texture that is not in the checkout is left out (the raster skips an image it cannot resolve)
	}
}
const resolve = id => skinImages.get(id);
const STREET = decodePNG(readFileSync(opt("backdrop") ?? join(ROOT, "docs", "art", "after", "street-night.png")));

/** the street under the screen: `STREET` scaled to cover w x h (nearest), centred */
function backdrop(w, h) {
	const k = Math.max(w / STREET.w, h / STREET.h);
	const ox = (STREET.w * k - w) / 2;
	const oy = (STREET.h * k - h) / 2;
	const data = Buffer.alloc(w * h * 4);
	for (let y = 0; y < h; y++) {
		const sy = Math.min(STREET.h - 1, Math.floor((y + oy) / k));
		for (let x = 0; x < w; x++) {
			const sx = Math.min(STREET.w - 1, Math.floor((x + ox) / k));
			STREET.data.copy(data, (y * w + x) * 4, (sy * STREET.w + sx) * 4, (sy * STREET.w + sx) * 4 + 4);
			data[(y * w + x) * 4 + 3] = 255;
		}
	}
	return { w, h, data };
}

/** `over` (painted over transparent black, i.e. premultiplied) composited onto `under` */
function composite(under, over) {
	const out = { w: under.w, h: under.h, data: Buffer.from(under.data) };
	for (let i = 0; i < out.w * out.h; i++) {
		const a = over.data[i * 4 + 3] / 255;
		for (let c = 0; c < 3; c++) {
			const v = over.data[i * 4 + c] + out.data[i * 4 + c] * (1 - a);
			out.data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(v)));
		}
		out.data[i * 4 + 3] = 255;
	}
	return out;
}

// ---------------------------------------------------------------- the cases

const ctx = boot.getCtx();
const save = ctx.save;
const uis = service("UserInputService");

function useDevice(touch) {
	uis.TouchEnabled = touch;
	uis.MouseEnabled = !touch;
	uis.GetLastInputType = () => (touch ? Enum.UserInputType.Touch : Enum.UserInputType.MouseMovement);
}

const noop = () => {};
/** the handlers main.client.ts passes; `cause`: why the server said this survivor died (UI-13, an older checkout ignores it) */
const handlers = (newRun = true, cause = undefined) => ({
	onRebirth: noop,
	onNewRun: newRun ? noop : undefined,
	onHome: noop,
	cause: cause === undefined ? undefined : () => cause,
});
/** shared/data/deathCause.ts DeathKind */
const HORDE = 1;
const HUNGER = 2;
const POISON = 3;
const BOSS = 4;

/**
 * name, what the save holds, and how to open it. `standing`: the other survivors still up in town (undefined: the
 * screen is not told, as an older checkout never is); `seconds`: the count the run loop hands the wait; `later`: real
 * seconds that pass before the picture is taken (the town's fall is counted by the screen itself)
 */
const CASES = [
	{
		name: "first-death",
		save: { money: 20, deathCount: 0, runRev: 0, lifeDeaths: 0, day: 1, bestDay: 1 },
		summary: { days: 1, bestDay: 1, level: 1, kills: 11, bosses: 0, first: true, record: false },
		wait: { seconds: 197, night: true, standing: 2 },
		cause: { kind: HORDE, night: true },
	},
	{
		name: "wait-broke",
		save: { money: 4, deathCount: 0, runRev: 3, lifeDeaths: 1, day: 3, bestDay: 12 },
		summary: { days: 3, bestDay: 12, level: 7, kills: 20, bosses: 0, first: false, record: false },
		wait: { seconds: 102, night: true, standing: 1 },
		cause: { kind: HUNGER, night: true },
	},
	{
		name: "town-falls",
		save: { money: 60, deathCount: 1, runRev: 4, lifeDeaths: 1, day: 5, bestDay: 5 },
		summary: { days: 5, bestDay: 5, level: 6, kills: 64, bosses: 0, first: false, record: true },
		wait: { seconds: 150, night: true, standing: 0, later: 6 },
		cause: { kind: BOSS, night: true },
	},
	{
		name: "new-life",
		save: { money: 4, deathCount: 0, runRev: 5, lifeDeaths: 0, day: 1, bestDay: 12 },
		summary: { days: 3, bestDay: 12, level: 7, kills: 20, bosses: 0, first: false, record: false },
		wait: { seconds: 125, night: true, standing: 2, newLife: true },
	},
	{
		name: "offline",
		save: { money: 20, deathCount: 0, runRev: 2, lifeDeaths: 1, day: 4, bestDay: 6 },
		summary: { days: 4, bestDay: 6, level: 3, kills: 30, bosses: 0, first: false, record: false },
		cause: { kind: POISON, night: false },
	},
	{
		name: "offline-broke",
		save: { money: 0, deathCount: 2, runRev: 6, lifeDeaths: 3, day: 2, bestDay: 6 },
		summary: { days: 2, bestDay: 6, level: 3, kills: 9, bosses: 0, first: false, record: false },
	},
];

const SCREENS = [
	// the owner's playtest window: 58 px bar, the Roblox buttons over its left ~160 px
	{ name: "1365x567", w: 1365, h: 567, bar: 58, buttons: 160, touch: false },
	{ name: "1920x1080", w: 1920, h: 1080, bar: 58, buttons: 160, touch: false },
	{ name: "phone-844x390", w: 844, h: 390, bar: 36, buttons: 104, touch: true },
];

function open(c) {
	Object.assign(save, c.save);
	if (c.wait === undefined) {
		const close = GO.showRunSummary(ctx, c.summary, handlers(true, c.cause));
		return { close, frame: () => {} };
	}
	const w = c.wait;
	const handle = GO.showDaybreakWait(
		ctx,
		c.summary,
		handlers(w.newLife !== true, c.cause),
		w.newLife === true,
		() => w.standing,
	);
	const frame = () => handle.setRemaining(w.seconds, w.night);
	return { close: () => handle.close(), frame };
}

for (const c of CASES) {
	if (ONLY !== undefined && c.name !== ONLY) continue;
	for (const s of SCREENS) {
		ctx.phase = "dead";
		useDevice(s.touch);
		setViewport(s.w, s.h, s.bar, s.buttons);
		const shot = open(c);
		flush();
		shot.frame();
		if (c.wait?.later !== undefined) {
			ui.setClock(ui.getClock() + c.wait.later);
			shot.frame();
		}
		for (let i = 0; i < 3; i++) {
			layoutGame(ui, ctx);
			shot.frame();
		}
		const list = paintList(ctx.uiGui);
		const shapes = TEXT_MODE === "none" ? list.filter(e => e.kind !== "text") : list;
		const view = { x: 0, y: 0, w: s.w, h: s.h };
		const img = composite(backdrop(s.w, s.h), rasterPaint(shapes, view, undefined, resolve));
		const file = join(OUT, `${c.name}-${s.name}.png`);
		writeFileSync(file, encodePNG(img, true));
		const texts = list
			.filter(e => e.kind === "text")
			.map(e => ({
				text: e.text,
				x: e.x,
				y: e.y,
				w: e.w,
				h: e.h,
				px: e.px,
				color: e.color,
				alpha: e.alpha,
				bold: e.bold,
				mono: e.mono,
				alignX: e.alignX,
				alignY: e.alignY,
				wrapped: e.wrapped,
				clip: e.clip,
			}));
		writeFileSync(join(OUT, `${c.name}-${s.name}.json`), JSON.stringify({ w: s.w, h: s.h, texts }, null, 1));
		console.log(file);
		shot.close();
		flush();
	}
}
