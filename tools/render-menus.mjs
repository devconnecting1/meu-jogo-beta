#!/usr/bin/env node
/*
 * The lobby's Achievements window and the Shop (Packs, Earn coins) as a player sees them, in PNG: the REAL lobby.ts /
 * shop.ts / widgets.ts / window.ts / plate.ts / skin.ts on the counted fake tree (tools/ui-shim.mjs), with the town
 * flyover behind the menus (client/view/townFlyover.ts), laid out at a screen size (tools/ui-layout.mjs) and painted
 * (tools/ui-raster.mjs) with the real skin textures (design/ui-skin), the town's art and the item-icon atlas
 * (design/world-art) behind their uploaded ids.
 *
 *   node tools/render-menus.mjs --out <dir>                                     # this checkout
 *   PZ_SRC=<another checkout>/src node tools/render-menus.mjs --out <dir>/before # another version, same pictures
 *   node tools/render-menus.mjs --out <dir> --only shop-packs --sizes 1030x560
 *
 * Writes <screen>-<w>x<h>.png for every screen and size: the owner's screenshots (770 x 554, the achievements; 1030 x
 * 560, the shop), 1920 x 1080 and an 844 x 390 phone. The save is the one of those screenshots: 20 coins, best day 1,
 * no boss, Arrival done and three counters on the way (Street Sweeper 17 / 500, Close Quarters 17 / 1,000, Woodpile 2 /
 * 100); `--rich` adds a second, later save (more coins, a pack waiting, more unlocked). The text is the 5 x 7 pixel
 * font of tools/pixel-font.mjs (where a legend sits, not the engine's font). Nothing is checked here: test:screens,
 * test:nav and test:contrast measure the same screens.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installUiShims } from "./ui-shim.mjs";
import { layoutGame, paintList, withUIScale } from "./ui-layout.mjs";
import { rasterPaint } from "./ui-raster.mjs";
import { decodePNG, encodePNG } from "./png-lite.mjs";

const args = process.argv.slice(2);
const arg = name => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const OUT = arg("--out");
if (OUT === undefined) {
	console.error("usage: node tools/render-menus.mjs --out <dir> [--only <screen,...>] [--sizes WxH,...] [--rich]");
	process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const ONLY = arg("--only")?.split(",");
const RICH = args.includes("--rich");

const ui = installUiShims({ seed: 1, viewport: [1120, 630] });
// the drawings in a drawingBox (the pets, the lobby's survivor) are sized by a UIScale: draw them at their real size
withUIScale(true);
const { SRC, ROOT, require, flush, service, setViewport } = ui;
const boot = require(join(SRC, "client/bootstrap.ts"));
const saveClient = require(join(SRC, "client/systems/saveClient.ts"));
saveClient.requestSave = () => true;
const { showLobby } = require(join(SRC, "client/ui/lobby.ts"));
const { showShop } = require(join(SRC, "client/ui/shop.ts"));
const Fly = require(join(SRC, "client/view/townFlyover.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
flush();

// ---------------------------------------------------------------- the images behind the ids

/** rbxassetid -> PNG file, from the two asset tables the game's ids come from */
const files = new Map();
for (const dir of ["ui-skin", "world-art"]) {
	const table = JSON.parse(readFileSync(join(ROOT, "design", dir, "assets.json"), "utf8"));
	for (const [name, id] of Object.entries(table.ids ?? {})) {
		if (typeof id === "string" && id !== "") files.set(id, join(ROOT, "design", dir, `${name}.png`));
	}
}
const decoded = new Map();
const resolve = id => {
	if (decoded.has(id)) return decoded.get(id);
	const file = files.get(id);
	let img;
	try {
		img = file === undefined ? undefined : decodePNG(readFileSync(file));
	} catch {
		img = undefined;
	}
	decoded.set(id, img);
	return img;
};

// ---------------------------------------------------------------- the save of the owner's screenshots

const ctx = boot.getCtx();
ctx.phase = "lobby";
const save = ctx.save;
const RunService = service("RunService");
function ownerSave() {
	save.money = 20;
	save.bestDay = 1;
	save.day = 1;
	save.bossKills = 0;
	save.achievements.fill(0);
	save.achievements[0] = 1; // Arrival
	save.achievements[12] = 17; // Street Sweeper
	save.achievements[2] = 17; // Close Quarters
	save.achievements[14] = 2; // Woodpile
	save.packsBought.fill(0);
	save.packsOpened.fill(0);
}
function richSave() {
	ownerSave();
	save.money = 1843;
	save.bestDay = 12;
	save.day = 7;
	save.bossKills = 2;
	save.achievements[15] = 1; // First Sunrise
	save.achievements[10] = 1; // Giant Down
	save.achievements[12] = 500; // Street Sweeper, done
	save.achievements[17] = 6; // Deathless
	save.achievements[5] = 40; // Camp Cook
	save.packsBought[3] = 2; // Builder's Basics x2, waiting
}

const lobbyHandlers = {
	onPlay: () => {},
	onRebirth: () => {},
	onWaitDawn: () => {},
	onNewRun: () => {},
	onShop: () => {},
	onWardrobe: () => {},
	onSettings: () => {},
	onCredits: () => {},
	onTutorial: () => {},
	onPage: () => {},
};
const lobbyStatus = { loading: false, run: "fresh", hosted: false, seed: DESIGN.TOWN_SEED };

const frame = (dt = 1 / 60) => {
	RunService.RenderStepped.Fire(dt);
	flush();
};

/** a button of `root` whose text (its own, or its Label's) is `text` */
function buttonWithText(root, text) {
	return root
		?.GetDescendants()
		.find(
			d =>
				(d.ClassName === "TextButton" && d.Text === text) ||
				(d.ClassName === "TextButton" && d.FindFirstChild("Label")?.Text === text),
		);
}

/** the screens: how each one is opened over the lobby's town, and how it is closed */
const SCREENS = [
	{
		name: "achievements",
		open: () => {
			const lobby = showLobby(ctx, lobbyHandlers, lobbyStatus, "menu");
			flush();
			const nav = ctx.uiLayer
				.FindFirstChild("Lobby")
				?.GetDescendants()
				.find(d => d.Name === "Nav2");
			nav?.Activated.Fire();
			flush();
			return () => {
				ctx.uiLayer.FindFirstChild("Achievements")?.Destroy();
				lobby.close();
			};
		},
	},
	{
		// the same window scrolled to the end of its list: the not-started rows, their pictures in grey
		name: "achievements-end",
		scrollEnd: true,
		open: () => {
			const lobby = showLobby(ctx, lobbyHandlers, lobbyStatus, "menu");
			flush();
			ctx.uiLayer
				.FindFirstChild("Lobby")
				?.GetDescendants()
				.find(d => d.Name === "Nav2")
				?.Activated.Fire();
			flush();
			return () => {
				ctx.uiLayer.FindFirstChild("Achievements")?.Destroy();
				lobby.close();
			};
		},
	},
	{
		name: "shop-packs",
		open: () => {
			ctx.phase = "shop";
			const close = showShop(
				ctx,
				() => {},
				() => {},
			);
			flush();
			return close;
		},
	},
	{
		name: "shop-earn",
		open: () => {
			ctx.phase = "shop";
			const close = showShop(
				ctx,
				() => {},
				() => {},
			);
			flush();
			buttonWithText(ctx.uiLayer.FindFirstChild("Shop"), "Earn coins")?.Activated.Fire();
			flush();
			return close;
		},
	},
];

const SIZES = (arg("--sizes") ?? "770x554,1030x560,1920x1080,844x390").split(",").map(s => {
	const [w, h] = s.split("x").map(Number);
	// the Roblox bar: 58 px with its buttons over the left 160 px on a desktop, 36 px on a phone (test:screens' cases)
	return w <= 900 && h <= 400 ? [w, h, 36, 104] : [w, h, 58, 160];
});

// the town behind the menus, pinned where main.client.ts pins it, and gliding a little so the shot shows a street
Fly.pinFlyover(ctx.backdropLayer, DESIGN.TOWN_SEED);
flush();
for (let i = 0; i < 240; i++) frame(1 / 30);

for (const rich of RICH ? [false, true] : [false]) {
	for (const sc of SCREENS) {
		if (ONLY !== undefined && !ONLY.includes(sc.name)) continue;
		for (const [w, h, bar, buttons] of SIZES) {
			if (rich) richSave();
			else ownerSave();
			setViewport(w, h, bar, buttons);
			ctx.phase = "lobby";
			const close = sc.open();
			for (let i = 0; i < 3; i++) {
				frame();
				layoutGame(ui, ctx, 3);
			}
			// a list scrolled to its end (the achievements' not-started rows), when the screen asks for it
			if (sc.scrollEnd === true) {
				for (const d of ctx.uiLayer.GetDescendants()) {
					if (d.ClassName !== "ScrollingFrame" || d.AbsoluteCanvasSize === undefined) continue;
					const end = Math.max(0, d.AbsoluteCanvasSize.Y - d.AbsoluteSize.Y);
					if (end > 0) d.CanvasPosition = new Vector2(0, end);
				}
				layoutGame(ui, ctx, 3);
			}
			const view = { x: 0, y: 0, w, h };
			const list = [...paintList(ctx.screen), ...paintList(ctx.uiGui)];
			const img = rasterPaint(list, view, [20, 20, 20], resolve);
			const file = join(OUT, `${sc.name}${rich ? "-rich" : ""}-${w}x${h}.png`);
			writeFileSync(file, encodePNG(img, true));
			console.log(file);
			close?.();
			flush();
		}
	}
}
