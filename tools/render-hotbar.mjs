#!/usr/bin/env node
/*
 * The HUD hotbar (docs/DESIGN_RULES.md UI-09) as the engine would show it, in PNG: the REAL hud.ts / hudConsole.ts /
 * itemIcon.ts mounted on the counted fake tree (tools/ui-shim.mjs), laid out at a screen size (tools/ui-layout.mjs)
 * and painted (tools/ui-raster.mjs) -- with the item icons drawn by Frames (no atlas id) and from the atlas
 * (design/world-art/itemIcons.png behind a fake id), at the tile sizes players see.
 *
 *   node tools/render-hotbar.mjs --out <dir>                      # this checkout
 *   PZ_SRC=<another checkout>/src node tools/render-hotbar.mjs --out <dir>/before   # another version, same pictures
 *
 * Writes, per screen: hotbar-<screen>.png -- the five tiles (dagger, axe, bat, pistol, semi auto rifle) with the
 * dagger in hand, then with the pistol in hand, each row once with Frames and once with the atlas, 4x nearest -- and
 * tiles-<screen>.png, one tile per weapon of the game (all 30) with the atlas, 4x. Nothing is checked here: part 7 of
 * tools/test-hud.mjs measures the same drawing. And hud-<screen>.png: the whole console with the quick HEAL / EAT plates
 * (DESIGN_RULES ITM-07; on touch the whole screen, with the quick deck) in two states -- part 8 of test:hud checks them.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installUiShims } from "./ui-shim.mjs";
import { layoutGame, paintList, rectOf } from "./ui-layout.mjs";
import { hstack, rasterPaint, upscale, vstack } from "./ui-raster.mjs";
import { decodePNG, encodePNG } from "./png-lite.mjs";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const OUT = outAt >= 0 ? args[outAt + 1] : undefined;
if (OUT === undefined) {
	console.error("usage: node tools/render-hotbar.mjs --out <dir>");
	process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const ui = installUiShims({ seed: 1, viewport: [1120, 630] });
const { SRC, ROOT, require, flush, service, setViewport } = ui;
const boot = require(join(SRC, "client/bootstrap.ts"));
const { Hud } = require(join(SRC, "client/ui/hud.ts"));
const { WEAPONS } = require(join(SRC, "shared/data/weapons.ts"));
const WA = require(join(SRC, "client/view/worldArt.ts"));
const { WORLD_ART } = require(join(SRC, "client/view/worldArtAssets.ts"));

const FAKE = "rbxassetid://910000001";
const ATLAS = decodePNG(readFileSync(join(ROOT, "design", "world-art", "itemIcons.png")));
const resolve = id => (id === FAKE ? ATLAS : undefined);
function setIconAtlas(id) {
	const ids = {};
	for (const [name, t] of Object.entries(WORLD_ART)) ids[name] = t.id;
	ids.itemIcons = id;
	WA.overrideWorldArt(ids);
}

const ctx = boot.getCtx();
ctx.phase = "playing";
const save = ctx.save;
const uis = service("UserInputService");
const hud = new Hud(ctx);
hud.onBackpack = () => {};
hud.onPause = () => {};

const deep = (root, name) => root?.GetDescendants().find(d => d.Name === name);
const hudRoot = () => ctx.hudLayer.FindFirstChild("HudRoot");

function state(weaponId, over = {}) {
	const w = WEAPONS[weaponId];
	return {
		hp: 88,
		hpMax: 100,
		hunger: 58,
		hungerMax: 100,
		level: 3,
		exp: 30,
		expMax: 120,
		day: 5,
		lifeDay: 5,
		dayTime: 14.5,
		isNight: false,
		showClock: false,
		weaponId,
		weaponName: w.name,
		mag: w.mag > 0 ? 7 : 0,
		magSize: w.mag,
		reloading: false,
		reloadRatio: 0,
		ammoPool: 41,
		hitFlash: 0,
		...over,
	};
}

/** owns exactly `ids` (the hotbar shows them in id order) */
function own(ids) {
	for (let i = 0; i < WEAPONS.length; i++) save.invenWeapon[i] = ids.includes(i) ? 1 : 0;
	save.ammoNormal = 41;
}

const SCREENS = [
	{ name: "owner-1365x567", w: 1365, h: 567, touch: false },
	{ name: "1120x630", w: 1120, h: 630, touch: false },
	{ name: "1920x1080", w: 1920, h: 1080, touch: false },
	{ name: "touch-1120x630", w: 1120, h: 630, touch: true },
];

function useDevice(touch) {
	uis.TouchEnabled = touch;
	uis.MouseEnabled = !touch;
	uis.GetLastInputType = () => (touch ? Enum.UserInputType.Touch : Enum.UserInputType.MouseMovement);
}

/** mounts the HUD on `screen` with `atlas`, shows `weaponId` in hand, lays out; returns the hotbar bed */
function mountOn(screen, atlas, weaponId) {
	hud.unmount();
	setIconAtlas(atlas ? FAKE : "");
	useDevice(screen.touch);
	setViewport(screen.w, screen.h, screen.touch ? 58 : 36);
	hud.mount();
	hud.update(state(weaponId));
	for (let i = 0; i < 3; i++) {
		layoutGame(ui, ctx);
		hud.update(state(weaponId));
	}
	return deep(hudRoot(), "Hotbar");
}

/** the bed (the five tiles on their groove), painted */
function paintBed(bed) {
	const r = rectOf(bed);
	const view = { x: Math.floor(r.x) - 2, y: Math.floor(r.y) - 2, w: Math.ceil(r.w) + 4, h: Math.ceil(r.h) + 4 };
	return rasterPaint(paintList(bed), view, [30, 30, 34], resolve);
}

const HOTBAR = [0, 2, 6, 10, 13];
for (const screen of SCREENS) {
	const rows = [];
	for (const inHand of [0, 10]) {
		for (const atlas of [false, true]) {
			own(HOTBAR);
			rows.push(paintBed(mountOn(screen, atlas, inHand)));
		}
	}
	const tile = rectOf(deep(hudRoot(), "Slot1"));
	const file = join(OUT, `hotbar-${screen.name}.png`);
	writeFileSync(file, encodePNG(upscale(vstack(rows, 4), 4), true));
	console.log(
		`${file}  (tile ${tile.w.toFixed(1)} px; rows: dagger in hand Frames / atlas, pistol in hand Frames / atlas)`,
	);

	// every weapon of the game, one tile each (in hand, so the gun shows its magazine), from the atlas
	const tiles = [];
	for (let id = 0; id < WEAPONS.length; id++) {
		// the dagger is always owned (save.ts ownsWeapon): any other weapon is the second tile
		own([id]);
		const bed = mountOn(screen, true, id);
		const t = deep(bed, id === 0 ? "Slot1" : "Slot2");
		const r = rectOf(t);
		const view = { x: Math.floor(r.x) - 1, y: Math.floor(r.y) - 1, w: Math.ceil(r.w) + 2, h: Math.ceil(r.h) + 2 };
		tiles.push(rasterPaint(paintList(bed), view, [30, 30, 34], resolve));
	}
	const grid = [];
	for (let i = 0; i < tiles.length; i += 10) grid.push(hstack(tiles.slice(i, i + 10), 4));
	const all = join(OUT, `tiles-${screen.name}.png`);
	writeFileSync(all, encodePNG(upscale(vstack(grid, 4), 3), true));
	console.log(`${all}  (all ${WEAPONS.length} weapons, in hand, atlas)`);
}
hud.unmount();
flush();

// ---------------------------------------------------------------- the whole console (ITM-07: the quick HEAL / EAT)

/*
 * hud-<screen>.png: the desktop console (and the strip above it, where the plates' tooltip shows) or, on touch, the whole
 * screen (the thumbs' controls, the console, the quick deck, the corner) -- in two states, stacked: (1) a hurt, hungry
 * survivor with 2 Bandages, a First aid kit and 3 Canned food; (2) the same with no food left (EAT greyed), HEAL in the
 * use cooldown (the veil half drained) and, on desktop, the mouse over EAT (its reason on the tooltip). Run it on
 * another checkout (PZ_SRC) for the "before": a HUD without the plates draws the same states without them.
 */
const HUD_SCREENS = [
	{ name: "owner-1365x567", w: 1365, h: 567, touch: false, zoom: 2 },
	{ name: "1920x1080", w: 1920, h: 1080, touch: false, zoom: 1 },
	{ name: "touch-1120x630", w: 1120, h: 630, touch: true, zoom: 1 },
];
const USE = (() => {
	try {
		return require(join(SRC, "shared/data/usables.ts")).USABLES;
	} catch {
		return [];
	}
})();
const useId = n => USE.findIndex(u => u.name === n);
function stockQuick(food) {
	for (let i = 0; i < save.invenUse.length; i++) save.invenUse[i] = 0;
	save.invenUse[useId("Bandage")] = 2;
	save.invenUse[useId("First aid kit")] = 1;
	save.invenUse[useId("Canned food")] = food;
}
/** the two quick views a run would hand the HUD (client/systems/quickUse.ts), when this checkout has them */
function quickViews(heal, eat) {
	try {
		const Q = require(join(SRC, "shared/game/quickUse.ts"));
		const v = { hp: 60, hpMax: 100, hunger: 58, hungerMax: 100, dead: false };
		return [
			{ ...Q.quickPick(0, save, v), ...heal },
			{ ...Q.quickPick(1, save, v), ...eat },
		];
	} catch {
		return undefined;
	}
}
for (const screen of HUD_SCREENS) {
	const rows = [];
	for (const busy of [false, true]) {
		hud.unmount();
		setIconAtlas("");
		useDevice(screen.touch);
		setViewport(screen.w, screen.h, screen.touch ? 58 : 36);
		own(HOTBAR);
		stockQuick(busy ? 0 : 3);
		hud.mount();
		const quick = quickViews({ cooldown: busy ? 0.5 : 0, pulse: 0 }, { cooldown: busy ? 0.5 : 0, pulse: 0 });
		const st = state(10, { hp: 60, hunger: 58, ...(quick !== undefined ? { quick } : {}) });
		hud.update(st);
		for (let i = 0; i < 3; i++) {
			layoutGame(ui, ctx);
			hud.update(st);
		}
		const eat = deep(hudRoot(), "QuickEat");
		if (busy && eat !== undefined && !screen.touch) {
			eat.GuiState = Enum.GuiState.Hover;
			flush();
			hud.update(st);
			layoutGame(ui, ctx);
		}
		let view = { x: 0, y: 0, w: screen.w, h: screen.h };
		if (!screen.touch) {
			const r = rectOf(deep(hudRoot(), "Console"));
			const above = Math.ceil(r.h * 0.45);
			view = {
				x: Math.floor(r.x) - 8,
				y: Math.floor(r.y) - above,
				w: Math.ceil(r.w) + 16,
				h: Math.ceil(r.h) + above + 8,
			};
		}
		rows.push(rasterPaint(paintList(hudRoot()), view, [58, 66, 52], resolve));
	}
	const file = join(OUT, `hud-${screen.name}.png`);
	writeFileSync(file, encodePNG(upscale(vstack(rows, 6), screen.zoom), true));
	console.log(
		`${file}  (rows: a hurt, hungry survivor; then no food, HEAL cooling${screen.touch ? "" : ", the mouse on EAT"})`,
	);
}
hud.unmount();
flush();

// ---------------------------------------------------------------- the Bag's tiles and the item card: the same drawer

const { Backpack } = require(join(SRC, "client/ui/backpack.ts"));
const { ItemCard } = require(join(SRC, "client/ui/itemCard.ts"));
const { describeItem } = require(join(SRC, "client/ui/itemInfo.ts"));
const { iconOf } = require(join(SRC, "shared/data/itemIcons.ts"));

/** paints `g`'s subtree over its own rect, `pad` px around */
function paintRect(g, pad = 1) {
	const r = rectOf(g);
	const view = {
		x: Math.floor(r.x) - pad,
		y: Math.floor(r.y) - pad,
		w: Math.ceil(r.w) + 2 * pad,
		h: Math.ceil(r.h) + 2 * pad,
	};
	return rasterPaint(paintList(g), view, [30, 30, 34], resolve);
}

const SHOWN = HOTBAR.map(id => iconOf(1, id).key);
for (const screen of SCREENS.filter(s => !s.touch)) {
	const rows = [];
	const cards = [];
	for (const atlas of [false, true]) {
		setIconAtlas(atlas ? FAKE : "");
		useDevice(false);
		setViewport(screen.w, screen.h, 36);
		own(HOTBAR);
		const pack = new Backpack(ctx);
		pack.craftCheck = () => undefined;
		pack.open();
		for (let i = 0; i < 3; i++) layoutGame(ui, ctx);
		const root = ctx.uiLayer;
		const tiles = root
			.GetDescendants()
			.filter(
				d =>
					d.Name === "ItemIcon" &&
					d.Parent?.Name?.startsWith("Tile") &&
					SHOWN.includes(d.GetAttribute("Icon")),
			)
			.map(d => d.Parent);
		const bed = root.GetDescendants().find(d => d.Name === "IconBed");
		rows.push(hstack([...tiles.map(t => paintRect(t)), ...(bed ? [paintRect(bed)] : [])], 4));
		pack.close?.();
		for (const d of root.GetChildren()) d.Destroy();

		// the item card's header tile, one per weapon
		const holder = new Instance("Frame");
		holder.Name = "CardHolder";
		holder.Size = UDim2.fromScale(1, 1);
		holder.BackgroundTransparency = 1;
		holder.Parent = root;
		const heads = [];
		for (const id of HOTBAR) {
			const card = ItemCard(holder, `Card${id}`, { x: 40, y: 40, w: 320 });
			card.set(describeItem(save, 1, id));
			for (let i = 0; i < 3; i++) layoutGame(ui, ctx);
			heads.push(paintRect(deep(card.frame, "IconTile")));
			card.frame.Destroy();
		}
		holder.Destroy();
		cards.push(hstack(heads, 4));
	}
	const bag = join(OUT, `bag-${screen.name}.png`);
	writeFileSync(bag, encodePNG(upscale(vstack(rows, 4), 4), true));
	console.log(`${bag}  (Bag tiles + the details' big icon; rows: Frames / atlas)`);
	const card = join(OUT, `card-${screen.name}.png`);
	writeFileSync(card, encodePNG(upscale(vstack(cards, 4), 4), true));
	console.log(`${card}  (the item card's icon tile; rows: Frames / atlas)`);
}
flush();
