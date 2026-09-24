#!/usr/bin/env node
/*
 * The wellbeing HUD moments (docs/DESIGN_RULES.md BEM-04 / BEM-08) as the engine would show them, in PNG: the REAL
 * hud.ts (with client/ui/dawnCard.ts) mounted on the counted fake tree (tools/ui-shim.mjs), laid out at a screen size
 * (tools/ui-layout.mjs) and painted (tools/ui-raster.mjs) with the skin's own textures, over a street drawn by the game's
 * own code (docs/art/after/street.png, `npm run render:map`), which the HUD sits on.
 *
 *   node tools/render-wellbeing.mjs --out <dir>                                   # this checkout
 *   PZ_SRC=<another checkout>/src node tools/render-wellbeing.mjs --out <dir>     # another version, same moments
 *
 * Writes, per screen: dawn-<screen>.png -- 06:00 after a night survived: the dawn card with the night's numbers, the
 * server's "Progress saved" and, a long session, the break line (an older checkout, without the card, shows what it
 * showed then: the "Good morning" banner) -- and levelup-<screen>.png, the feed line of a level-up ("Level 5 · +1 skill
 * point · Bag › Skills"; an older checkout: "Level UP"); each with a .json of every text it shows (box, colour, size), for
 * a pass with a real font. The raster's own text is the 5 x 7 pixel font of tools/pixel-font.mjs. Nothing is checked
 * here: test:hud §10 measures the same drawing.
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
	console.error("usage: node tools/render-wellbeing.mjs --out <dir>");
	process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const ui = installUiShims({ seed: 1, viewport: [1120, 630] });
const { SRC, ROOT, require, flush, service, setViewport } = ui;
const boot = require(join(SRC, "client/bootstrap.ts"));
const { Hud } = require(join(SRC, "client/ui/hud.ts"));
const { SKIN_TEXTURES } = require(join(SRC, "client/ui/skinAssets.ts"));
flush();

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
const STREET = decodePNG(readFileSync(opt("backdrop") ?? join(ROOT, "docs", "art", "after", "street.png")));

/** the street under the HUD: `STREET` scaled to cover w x h (nearest), centred */
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

const ctx = boot.getCtx();
ctx.phase = "playing";
const save = ctx.save;
save.invenWeapon[2] = 1;
save.invenWeapon[10] = 1;
save.ammoNormal = 41;
const uis = service("UserInputService");
const hud = new Hud(ctx);
hud.onBackpack = () => {};
hud.onPause = () => {};

/** the HUD's frame: a survivor at 06:00 with a pistol in hand */
const state = () => ({
	hp: 72,
	hpMax: 100,
	hunger: 58,
	hungerMax: 100,
	level: 5,
	exp: 10,
	expMax: 160,
	day: 6,
	lifeDay: 6,
	dayTime: 6.05,
	isNight: false,
	showClock: false,
	weaponId: 10,
	weaponName: "Pistol",
	mag: 7,
	magSize: 12,
	reloading: false,
	reloadRatio: 0,
	ammoPool: 41,
	hitFlash: 0,
});

const SCREENS = [
	// the owner's playtest window: 58 px bar, the Roblox buttons over its left ~160 px
	{ name: "1365x567", w: 1365, h: 567, bar: 58, buttons: 160, touch: false },
	{ name: "phone-844x390", w: 844, h: 390, bar: 36, buttons: 104, touch: true },
];

/** the moments: each opens on a freshly mounted HUD; an older checkout gets what it had then */
const MOMENTS = [
	{
		name: "dawn",
		show() {
			hud.showMessage("Good morning");
			if (typeof hud.showDawnReport !== "function") return;
			hud.showDawnReport({ zombies: 23, damage: 64, items: 9 }, true);
			hud.dawnStoreNotice("saving");
			hud.dawnStoreNotice("saved");
		},
	},
	{
		name: "levelup",
		show() {
			if (typeof hud.showLevelUp === "function") hud.showLevelUp(5, 1);
			else hud.showMessage("Level UP");
		},
	},
];

for (const m of MOMENTS) {
	for (const s of SCREENS) {
		hud.unmount();
		uis.TouchEnabled = s.touch;
		uis.MouseEnabled = !s.touch;
		uis.GetLastInputType = () => (s.touch ? Enum.UserInputType.Touch : Enum.UserInputType.MouseMovement);
		setViewport(s.w, s.h, s.bar, s.buttons);
		hud.mount();
		hud.update(state());
		m.show();
		for (let i = 0; i < 3; i++) {
			layoutGame(ui, ctx);
			hud.update(state());
		}
		const list = paintList(ctx.hudGui ?? ctx.hudLayer);
		const view = { x: 0, y: 0, w: s.w, h: s.h };
		const img = composite(backdrop(s.w, s.h), rasterPaint(list, view, undefined, resolve));
		const file = join(OUT, `${m.name}-${s.name}.png`);
		writeFileSync(file, encodePNG(img, true));
		const texts = list
			.filter(e => e.kind === "text")
			.map(e => ({ text: e.text, x: e.x, y: e.y, w: e.w, h: e.h, px: e.px, color: e.color, bold: e.bold }));
		writeFileSync(join(OUT, `${m.name}-${s.name}.json`), JSON.stringify({ w: s.w, h: s.h, texts }, null, 1));
		console.log(file);
	}
}
hud.unmount();
flush();
