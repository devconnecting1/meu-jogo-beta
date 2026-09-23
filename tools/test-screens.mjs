#!/usr/bin/env node
/*
 * The menu screens on a real screen (docs/DESIGN_RULES.md UI-07, UI-10, UI-06): where the windows sit, and what is
 * behind them.
 *
 *   npm run test:screens
 *   PZ_SRC=<another checkout>/src node tools/test-screens.mjs    (measures that version)
 *
 * The owner, from a Studio playtest (1365 x 567, Settings opened from the lobby): "why are the panels crooked instead
 * of neatly in the middle? and why can't I see anything behind the panels?". Measured on his screenshot: the window
 * had 85 px above it and 26 below -- every screen's design space started below the Roblox top bar across the whole
 * width, although the bar's buttons only take its left corner -- and behind it a flat page: opening Settings closed
 * the lobby and took the town flyover with it.
 *
 * This runs the REAL settings.ts / wardrobe.ts / lobby.ts + survivor.ts / shop.ts / credits.ts / tutorial.ts /
 * pauseMenu.ts / popup.ts / townFlyover.ts / widgets.ts / skin.ts and client/bootstrap.ts under Node, over the counted
 * fake Instance tree of tools/ui-shim.mjs, with the Roblox top bar modelled as the engine reports it
 * (GuiService.TopbarInset: the stretch of the bar its buttons leave free), and checks:
 *
 *   1. CENTRED         Settings, the Wardrobe, the Survivor screen, How to play and the in-run menu, at the owner's
 *                      1365 x 567 (58 px bar, buttons over the left 160 px), 1920 x 1080, 1120 x 630, 1360 x 435 and
 *                      a 844 x 390 phone under a 36 px bar: each window is centred on the FULL screen (+-2 px), never
 *                      under a button, inside the screen; where a centred window WOULD run under a button, it moves
 *                      down to the bar's edge and no further. The window's corner lands on a whole pixel.
 *   2. PAGES           the lobby's logo and coins, the shop's Back: a page that reaches the screen's edges keeps clear
 *                      of the buttons, as before.
 *   3. THE SCALE       the full height is used when the design space does not meet a button (the owner's screen: 0.9
 *                      px per unit, not the old 0.808), and never less than before anywhere.
 *   4. THE TOWN        lobby -> Settings -> lobby -> Wardrobe -> Shop -> Credits -> How to play -> lobby: the flyover
 *                      stays pinned at the back of the UI layer, the same one, gliding on across every switch (no
 *                      restart, no cut), with no Instance made or lost; every screen is see-through over it, and any
 *                      text not in `foreground` sits on a plate or a window. Reduce Motion: a still frame that no
 *                      switch redraws. The run releases every Frame of it.
 *   5. OVER A RUN      Settings opened from the in-run menu shows the WORLD: the see-through scrim of every screen over
 *                      a run (UI-06), under the damage flash, no town flyover, no credits page; a popup over a run
 *                      dims the street instead of hiding it. Source guards: main.client.ts opens it over the run and
 *                      back to the menu, and every menu screen pins the flyover.
 *
 * Pure Node (>= 18) plus the project's TypeScript. No layout engine: the rects are computed here from the Scale /
 * Offset / AnchorPoint / aspect the kit writes, the way the engine does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installUiShims } from "./ui-shim.mjs";

const ui = installUiShims({ seed: 1, viewport: [1120, 630] });
const { SRC, require, flush, service, measure, setViewport } = ui;

const boot = require(join(SRC, "client/bootstrap.ts"));
const saveClient = require(join(SRC, "client/systems/saveClient.ts"));
saveClient.requestSave = () => true;
const { showSettings } = require(join(SRC, "client/ui/settings.ts"));
const { showWardrobe } = require(join(SRC, "client/ui/wardrobe.ts"));
const { showLobby } = require(join(SRC, "client/ui/lobby.ts"));
const { showShop } = require(join(SRC, "client/ui/shop.ts"));
const { showCredits } = require(join(SRC, "client/ui/credits.ts"));
const { showTutorial } = require(join(SRC, "client/ui/tutorial.ts"));
const { showPause } = require(join(SRC, "client/ui/pauseMenu.ts"));
const { popup } = require(join(SRC, "client/ui/popup.ts"));
const Fly = require(join(SRC, "client/view/townFlyover.ts"));
const skin = require(join(SRC, "client/ui/skin.ts"));
const { THEME, TRANSPARENCY } = require(join(SRC, "client/ui/theme.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
flush();

// ---------------------------------------------------------------- checks

let failures = 0;
function check(name, ok, detail) {
	const tail = detail === undefined ? "" : `  (${detail})`;
	if (ok) console.log(`  ok    ${name}${tail}`);
	else {
		console.error(`  FALHA ${name}${tail}`);
		failures++;
	}
}
const sameColor = (a, b) =>
	a !== undefined && b !== undefined && Math.abs(a.R - b.R) + Math.abs(a.G - b.G) + Math.abs(a.B - b.B) < 1e-6;
const px = v => v.toFixed(1);

const ctx = boot.getCtx();
ctx.phase = "lobby";
const layer = ctx.uiLayer;
const GuiService = service("GuiService");
const RunService = service("RunService");
const SEED = DESIGN.TOWN_SEED;

/** the screen the fake engine reports now */
const screen = { w: 1120, h: 630, bar: 0, buttons: 0 };
function setScreen(w, h, bar = 0, buttons = 0) {
	Object.assign(screen, { w, h, bar, buttons });
	setViewport(w, h, bar, buttons);
}

/** the rect of `g` on screen (px), from the kit's Scale / Offset / AnchorPoint / aspect, like the engine */
function rectOf(g) {
	const chain = [];
	for (let p = g; p !== undefined && p.IsA("GuiObject"); p = p.Parent) chain.unshift(p);
	let rect = { x: 0, y: 0, w: screen.w, h: screen.h };
	for (const n of chain) {
		let w = n.Size.X.Scale * rect.w + n.Size.X.Offset;
		let h = n.Size.Y.Scale * rect.h + n.Size.Y.Offset;
		const ar = n.FindFirstChildOfClass("UIAspectRatioConstraint");
		if (ar !== undefined) {
			if (w / h > ar.AspectRatio) w = h * ar.AspectRatio;
			else h = w / ar.AspectRatio;
		}
		const x = rect.x + n.Position.X.Scale * rect.w + n.Position.X.Offset - n.AnchorPoint.X * w;
		const y = rect.y + n.Position.Y.Scale * rect.h + n.Position.Y.Offset - n.AnchorPoint.Y * h;
		rect = { x, y, w, h };
	}
	return rect;
}
const fmt = r => `${px(r.x)},${px(r.y)} ${px(r.w)}x${px(r.h)}`;

/** a px rect under one of the Roblox buttons (they take x < buttons, up to the bar's height) */
const underButtons = (r, s = screen) => s.bar > 0 && r.y < s.bar - 0.5 && r.x < s.buttons - 0.5;

/** the scale the kit used before this change: the design space always below the bar, across the whole width */
const oldScale = (w, h, bar) => Math.max(0.35, Math.min(w / 1120, (h - bar) / 630));

// ================================================================ 1. centred windows

console.log(`Telas: fonte ${SRC}\n`);
console.log("1) janelas centradas na tela INTEIRA, nunca sob um botao do Roblox\n");

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
const lobbyStatus = { loading: false, run: "fresh", hosted: false, seed: SEED };
const wardrobeHandlers = { onBack: () => {}, onEquip: () => {}, onUnequip: () => {} };

/** each window: how to open it, and where its frame is */
const WINDOWS = [
	{
		name: "Settings",
		open: () =>
			showSettings(
				ctx,
				() => {},
				() => {},
			),
		frame: () => layer.FindFirstChild("Settings")?.FindFirstChild("Body")?.FindFirstChild("Window"),
	},
	{
		name: "Wardrobe",
		open: () => showWardrobe(ctx, wardrobeHandlers),
		frame: () => layer.FindFirstChild("Wardrobe")?.FindFirstChild("Body")?.FindFirstChild("Window"),
	},
	{
		name: "Survivor",
		open: () => {
			const h = showLobby(ctx, lobbyHandlers, lobbyStatus, "survivor");
			return () => h.close();
		},
		frame: () =>
			layer.FindFirstChild("Lobby")?.FindFirstChild("Body")?.FindFirstChild("Survivor")?.FindFirstChild("Window"),
	},
	{
		name: "How to play",
		open: () => showTutorial(ctx, () => {}),
		frame: () => layer.FindFirstChild("HowToPlay")?.FindFirstChild("Body")?.FindFirstChild("DialogContent"),
	},
	{
		name: "Menu (na partida)",
		open: () => showPause(ctx, 0, {}),
		frame: () => layer.FindFirstChild("Menu")?.FindFirstChild("Body")?.FindFirstChild("Panel"),
	},
];

const SCREENS = [
	// the owner's playtest window: 58 px bar, the Roblox buttons over its left ~160 px
	[1365, 567, 58, 160, "1365 x 567, barra de 58 px, botoes nos 160 px da esquerda (a captura do dono)"],
	[1920, 1080, 58, 160, "1920 x 1080, botoes a esquerda"],
	[1120, 630, 58, 160, "1120 x 630, botoes a esquerda"],
	[1120, 630, 0, 0, "1120 x 630 sem barra"],
	[1360, 435, 58, 160, "1360 x 435, botoes a esquerda"],
	[844, 390, 36, 104, "celular 844 x 390, barra de 36 px"],
];

/** one case: where the window is, and what the rule says about it */
function judge(label, r) {
	const cx = r.x + r.w / 2;
	const cy = r.y + r.h / 2;
	const centredX = Math.abs(cx - screen.w / 2) <= 2;
	// where a centred window of this size would be, and whether a button would be over it there
	const centred = { x: (screen.w - r.w) / 2, y: (screen.h - r.h) / 2, w: r.w, h: r.h };
	const wouldHit = underButtons(centred);
	const inside = r.x >= -0.5 && r.y >= -0.5 && r.x + r.w <= screen.w + 0.5 && r.y + r.h <= screen.h + 0.5;
	check(
		`${label}: centrada na horizontal (+-2 px) e dentro da tela`,
		centredX && inside,
		`${fmt(r)}, centro x ${px(cx)} de ${screen.w / 2}`,
	);
	if (wouldHit) {
		check(
			`${label}: centrada ela ficaria sob um botao, entao desce ate a borda da barra e nao mais`,
			Math.abs(r.y - screen.bar) <= 1,
			`topo ${px(r.y)}, barra ${screen.bar} (centrada: topo ${px(centred.y)})`,
		);
	} else {
		check(
			`${label}: centrada na vertical (+-2 px)`,
			Math.abs(cy - screen.h / 2) <= 2,
			`${px(r.y)} acima, ${px(screen.h - r.y - r.h)} abaixo`,
		);
	}
	check(`${label}: nunca sob um botao do Roblox`, !underButtons(r), fmt(r));
	check(
		`${label}: o canto da janela cai num pixel inteiro`,
		Math.abs(r.x - Math.round(r.x)) < 1e-6 && Math.abs(r.y - Math.round(r.y)) < 1e-6,
		`${r.x}, ${r.y}`,
	);
	return { r, moved: wouldHit };
}

const moved = [];
const measured = new Map();
for (const win of WINDOWS) {
	setScreen(1120, 630);
	const close = win.open();
	flush();
	for (const [w, h, bar, buttons, label] of SCREENS) {
		setScreen(w, h, bar, buttons);
		const f = win.frame();
		if (f === undefined) {
			check(`${win.name} aberta`, false);
			break;
		}
		const res = judge(`${win.name}, ${label}`, rectOf(f));
		if (res.moved) moved.push(`${win.name} @ ${w}x${h}`);
		measured.set(`${win.name}|${w}x${h}|${bar}`, res.r);
	}
	close();
	flush();
}
check(
	"o caso 'desce so o necessario' foi exercitado (alguma janela esbarraria num botao se ficasse centrada)",
	moved.length > 0,
	moved.join(", "),
);
{
	// the owner's numbers: the Settings window he measured at y 85-541 (85 px above, 26 below) is centred now
	const r = measured.get("Settings|1365x567|58");
	if (r !== undefined) {
		const above = r.y;
		const below = 567 - r.y - r.h;
		check(
			"a Settings do dono: a mesma folga em cima e embaixo (antes: 85 px e 26 px)",
			Math.abs(above - below) <= 2,
			`${px(above)} px em cima, ${px(below)} px embaixo, ${px(r.x)} px a esquerda, ${px(1365 - r.x - r.w)} a direita`,
		);
	}
}

// ================================================================ 2. pages that reach the edges

console.log("\n2) paginas que chegam a borda (o logo do lobby, o Back da loja) continuam longe dos botoes\n");

for (const [w, h, bar, buttons, label] of SCREENS) {
	setScreen(w, h, bar, buttons);
	const handle = showLobby(ctx, lobbyHandlers, lobbyStatus, "menu");
	flush();
	const menu = layer.FindFirstChild("Lobby").FindFirstChild("Body").FindFirstChild("Menu");
	const logo = rectOf(menu.FindFirstChild("Title"));
	const coins = rectOf(menu.FindFirstChild("Coins"));
	check(
		`lobby, ${label}: o logo e as moedas fora dos botoes`,
		!underButtons(logo) && !underButtons(coins),
		fmt(logo),
	);
	// the menu goes back to being a page after the Survivor window: the body re-centres on what shows
	handle.show("survivor");
	handle.show("menu");
	check(
		`lobby, ${label}: voltar da tela Survivor devolve a pagina ao seu lugar`,
		JSON.stringify(rectOf(menu.FindFirstChild("Title"))) === JSON.stringify(logo),
	);
	handle.close();
	const closeShop = showShop(
		ctx,
		() => {},
		() => {},
	);
	flush();
	const back = rectOf(layer.FindFirstChild("Shop").FindFirstChild("Body").FindFirstChild("Back"));
	check(`loja, ${label}: o Back fora dos botoes`, !underButtons(back), fmt(back));
	closeShop();
	flush();
}

// ================================================================ 3. the scale

console.log("\n3) a escala: a altura inteira quando o espaco de desenho nao encontra um botao\n");

for (const [w, h, bar, buttons, label] of SCREENS) {
	setScreen(w, h, bar, buttons);
	const s = skin.uiScale();
	const before = oldScale(w, h, bar);
	check(`${label}: nunca menor que antes`, s >= before - 1e-9, `${s.toFixed(3)} (antes ${before.toFixed(3)})`);
	check(
		`${label}: pixels da pele inteiros`,
		Number.isInteger(skin.skinPx()) && skin.skinPx() >= 1,
		`${skin.skinPx()}`,
	);
}
setScreen(1365, 567, 58, 160);
check(
	"a tela do dono usa a altura inteira: 567 / 630 = 0,9 px por unidade (antes 0,808)",
	Math.abs(skin.uiScale() - 0.9) < 1e-9,
	`${skin.uiScale().toFixed(4)}`,
);
// the shim's default: the buttons take the whole width of the bar
Object.assign(screen, { w: 1120, h: 630, bar: 36, buttons: 1120 });
setViewport(1120, 630, 36);
check(
	"sem saber onde estao os botoes (TopbarInset sem largura), a barra inteira conta como botao: o de antes",
	Math.abs(skin.uiScale() - (630 - 36) / 630) < 1e-9,
	`${skin.uiScale().toFixed(4)}`,
);

// ================================================================ 4. the town behind every menu screen

console.log("\n4) a cidade atras de toda tela de menu: a mesma, sem parar, sem criar Instance\n");

setScreen(1365, 567, 58, 160);
ctx.phase = "lobby";
const frame = (dt = 1 / 60) => {
	RunService.RenderStepped.Fire(dt);
	flush();
};
/** main.client.ts's menuScreen(): the one on screen goes, the flyover is pinned, the next one opens */
let current;
let fly;
function menuScreen(phase, open) {
	current?.();
	current = undefined;
	ctx.phase = phase;
	Fly.pinFlyover(layer, SEED);
	current = open();
	flush();
}
const openLobby = () => {
	const h = showLobby(ctx, lobbyHandlers, lobbyStatus, "menu");
	return () => h.close();
};
// the lobby pins it itself (goLobby opens it without menuScreen)
current = openLobby();
flush();
fly = Fly.activeFlyover();
check(
	"o lobby prende o voo no fundo da camada da UI, atras de toda tela",
	fly !== undefined && fly.layer.Parent === layer && fly.layer.ZIndex < layer.FindFirstChild("Lobby").ZIndex,
	`${fly?.layer.Parent?.Name}, ZIndex ${fly?.layer.ZIndex}`,
);
// warm-up: two loops over every landmark (each shot shows another street), as test:lobby does
{
	const town = Fly.townFor(SEED);
	const landmarks = town.solids.filter(s => s.kind === "building" && (s.buildingType ?? 1) >= 3).length;
	let cuts = 0;
	let last = fly.cameraAt();
	for (let i = 0; i < 20000 && cuts < landmarks * 2; i++) {
		frame(1);
		const now = fly.cameraAt();
		if (Math.hypot(now[0] - last[0], now[1] - last[1]) > 200) cuts++;
		last = now;
	}
}
const conns = () => RunService.RenderStepped.conns.length;

/** everything under the flyover right now (to see whether a switch destroys any of it) */
const flyoverSet = () => new Set(fly.layer.GetDescendants());
const FLOW = [
	[
		"settings",
		"Settings",
		() =>
			showSettings(
				ctx,
				() => {},
				() => {},
			),
	],
	["lobby", "Lobby", openLobby],
	["shop", "Wardrobe", () => showWardrobe(ctx, wardrobeHandlers)],
	[
		"shop",
		"Shop",
		() =>
			showShop(
				ctx,
				() => {},
				() => {},
			),
	],
	["credits", "Credits", () => showCredits(ctx, () => {})],
	["tutorial", "HowToPlay", () => showTutorial(ctx, () => {})],
	["lobby", "Lobby", openLobby],
];

/** a text on the screen that is not on a plate, a panel or a window must be `foreground` (UI-10) */
function looseText(root) {
	const body = root.FindFirstChild("Body");
	const onSurface = l => {
		for (let p = l.Parent; p !== undefined && p !== body && p !== root; p = p.Parent) {
			if (!p.IsA("GuiObject")) continue;
			if (p.BackgroundTransparency < 1) return true;
			if (p.FindFirstChild("PlateFace") !== undefined || p.FindFirstChild("Skin1") !== undefined) return true;
		}
		return false;
	};
	const shown = l => {
		for (let p = l; p !== undefined && p !== root; p = p.Parent) if (p.IsA("GuiObject") && !p.Visible) return false;
		return true;
	};
	return root
		.GetDescendants()
		.filter(d => d.ClassName === "TextLabel" && d.Text !== "" && shown(d) && d.TextTransparency < 1)
		.filter(d => !onSurface(d) && !sameColor(d.TextColor3, THEME.foreground))
		.map(d => `${d.Name} "${String(d.Text).slice(0, 24)}"`);
}

{
	const before = flyoverSet();
	// the flyover's own frame connection: the screens bring theirs (previews, the credits' scroll), this one stays
	const flyConn = fly.conn;
	const connsBefore = conns();
	let jumps = 0;
	let still = 0;
	let flyMade = 0;
	let flyGone = 0;
	const path = [];
	for (const [phase, name, open] of FLOW) {
		for (let i = 0; i < 30; i++) frame();
		const at = fly.cameraAt();
		const r = measure(() => menuScreen(phase, open));
		for (const e of r.log) {
			if (e.kind === "new" && e.inst.IsDescendantOf(fly.layer)) flyMade++;
			if (e.kind === "gone" && before.has(e.inst)) flyGone++;
		}
		// the switch itself moved nothing: the camera is where it was, the same flyover, the same glide
		const same =
			Fly.activeFlyover() === fly && fly.layer.Parent === layer && fly.conn === flyConn && flyConn.Connected;
		const after = fly.cameraAt();
		if (after[0] !== at[0] || after[1] !== at[1]) jumps++;
		if (!same) still++;
		const root = layer.FindFirstChild(name);
		const body = root?.FindFirstChild("Body");
		check(
			`${name}: por cima do voo e transparente -- a cidade atras, sob o scrim do voo e nenhum outro`,
			root !== undefined &&
				root.ZIndex > fly.layer.ZIndex &&
				root.BackgroundTransparency === 1 &&
				body.BackgroundTransparency === 1,
			root === undefined ? "nao abriu" : `fundo ${root.BackgroundTransparency}, ZIndex ${root.ZIndex}`,
		);
		const loose = looseText(root);
		check(`${name}: todo texto fora da cor clara esta numa chapa ou janela`, loose.length === 0, loose.join("; "));
		path.push(name);
	}
	check(
		`${path.join(" -> ")}: o mesmo voo, preso o tempo todo, uma conexao de quadro so`,
		still === 0 && conns() === connsBefore,
		`${still} trocas perderam o voo; ${conns() - connsBefore} conexoes a mais no fim`,
	);
	check("...a camera nao salta em nenhuma troca (nada recomeca nem corta)", jumps === 0, `${jumps} saltos`);
	check(
		"...e nenhuma Instance do voo foi criada nem destruida nas trocas (o pool fica)",
		flyMade === 0 && flyGone === 0,
		`${flyMade} criadas, ${flyGone} destruidas`,
	);
	// the frames in between: the glide itself, over 7 screens, never jumps outside a cut behind the opaque fade
	let snaps = 0;
	let last = fly.cameraAt();
	const r = measure(() => {
		for (const [phase, , open] of FLOW) {
			menuScreen(phase, open);
			for (let i = 0; i < 90; i++) {
				frame();
				const now = fly.cameraAt();
				const fade = fly.layer.FindFirstChild("Fade").BackgroundTransparency;
				if (Math.hypot(now[0] - last[0], now[1] - last[1]) > 20 && fade > 0.05) snaps++;
				last = now;
			}
		}
	});
	let made = 0;
	let gone = 0;
	const set = flyoverSet();
	for (const e of r.log) {
		if (e.kind === "new" && e.inst.IsDescendantOf(fly.layer)) made++;
		if (e.kind === "gone" && set.has(e.inst)) gone++;
	}
	check(
		"7 telas com 90 quadros cada: o voo segue deslizando sem criar Instance e so corta com a pagina opaca",
		made === 0 && gone === 0 && snaps === 0,
		`${made} criadas, ${gone} destruidas, ${snaps} saltos a vista`,
	);
}

// Reduce Motion: a still frame, and a screen switch does not redraw it
GuiService.ReducedMotionEnabled = true;
flush();
frame();
{
	const at = fly.cameraAt();
	let redrawn = 0;
	const r = measure(() => {
		for (const [phase, , open] of [FLOW[0], FLOW[1]]) {
			menuScreen(phase, open);
			// pinned again by the next screen, the still frame on screen stays the one drawn (nothing to redraw)
			if (fly.stillDrawn !== true) redrawn++;
			for (let i = 0; i < 30; i++) frame();
		}
	});
	const still = fly.cameraAt();
	check(
		"Reduzir Movimento: quadro parado atras de todas as telas, a troca nao o redesenha nem o move",
		redrawn === 0 &&
			still[0] === at[0] &&
			still[1] === at[1] &&
			fly.layer.FindFirstChild("Fade").BackgroundTransparency === 1,
		`${redrawn} redesenhos, ${r.created} Instances das telas`,
	);
}
GuiService.ReducedMotionEnabled = false;
flush();

// the run starts: every Frame of the flyover goes, and it stops drawing
{
	current?.();
	current = undefined;
	flush();
	const connsBefore = conns();
	Fly.releaseFlyover();
	flush();
	check(
		"a partida monta: o voo solta TODOS os Frames e para de desenhar",
		Fly.activeFlyover() === undefined &&
			layer.FindFirstChild("TownBackdrop") === undefined &&
			conns() === connsBefore - 1 &&
			fly.layer.GetDescendants().length === 0,
		`${conns() - connsBefore} conexoes`,
	);
}

// ================================================================ 5. over a run: the world, not the town

console.log("\n5) sobre a partida: o MUNDO atras (UI-06), nao a cidade do lobby\n");

ctx.phase = "playing";
setScreen(1365, 567, 58, 160);
{
	const close = showSettings(ctx, () => {}, undefined, true);
	flush();
	const root = layer.FindFirstChild("Settings");
	check(
		"Settings aberta do menu da partida: o scrim de toda tela sobre a partida (o mundo a vista, nao uma pagina)",
		root !== undefined &&
			Math.abs(root.BackgroundTransparency - TRANSPARENCY.overWorld) < 1e-9 &&
			sameColor(root.BackgroundColor3, THEME.background),
		`${root?.BackgroundTransparency}`,
	);
	check("...sem o voo do lobby atras (o mundo e o fundo)", Fly.activeFlyover() === undefined);
	const flashZ = +(
		readFileSync(join(SRC, "client/ui/dangerFlash.ts"), "utf8").match(/const FLASH_Z = (\d+);/)?.[1] ?? NaN
	);
	check(
		"...e abaixo do flash de dano (o aviso continua por cima)",
		root.ZIndex < flashZ,
		`${root.ZIndex} < ${flashZ}`,
	);
	// the About tab: no way to the credits page from over a run
	const tabs = root.GetDescendants().find(d => d.Name === "Tabs");
	const about = tabs?.GetDescendants().find(d => d.IsA("TextButton") && d.Text === "About");
	about?.Activated.Fire();
	flush();
	check(
		"...sem a linha dos creditos (uma pagina de texto solto nao le sobre uma rua clara)",
		about !== undefined &&
			root.GetDescendants().some(d => d.Name === "Built") &&
			!root.GetDescendants().some(d => d.Name === "OpenCredits"),
	);
	const win = rectOf(root.FindFirstChild("Body").FindFirstChild("Window"));
	check("...e centrada como no lobby", Math.abs(win.y + win.h / 2 - 567 / 2) <= 2, fmt(win));
	close();
	flush();
}
{
	const overlay = popup(ctx, "Help", "A line.", [{ text: "Close" }]);
	flush();
	check(
		"um popup sobre a partida (o ? do Bag ou da Settings) escurece a rua em vez de esconde-la",
		Math.abs(overlay.BackgroundTransparency - TRANSPARENCY.overWorld) < 1e-9,
		`${overlay.BackgroundTransparency}`,
	);
	overlay.Destroy();
	ctx.phase = "lobby";
	const inMenus = popup(ctx, "Help", "A line.", [{ text: "Close" }]);
	flush();
	check(
		"...e nos menus continua o de um dialogo (escurece a tela de baixo)",
		Math.abs(inMenus.BackgroundTransparency - TRANSPARENCY.overlay) < 1e-9,
	);
	inMenus.Destroy();
	flush();
}

// source guards: what main.client.ts does (it does not load under Node)
{
	const main = readFileSync(join(SRC, "client/main.client.ts"), "utf8");
	const fn = name => {
		const at = main.indexOf(`function ${name}(`);
		if (at < 0) return "";
		const end = main.indexOf("\n}\n", at);
		return main.slice(at, end);
	};
	check(
		"main.client.ts: menuScreen() prende o voo da cidade do mundo (netTownSeed) atras da tela",
		/Flyover\.pinFlyover\(ctx\.uiLayer, netTownSeed\(\)\)/.test(fn("menuScreen")),
	);
	const opens = ["openShop", "openWardrobe", "openSettings", "openCredits", "openTutorial"];
	const missing = opens.filter(n => !/menuScreen\("/.test(fn(n)));
	check(
		"...e toda tela de menu abre por ela (Loja, Guarda-roupa, Settings, Creditos, How to play)",
		missing.length === 0,
		missing.join(", "),
	);
	check(
		"...a Settings do menu da partida abre SOBRE a partida (sem stopGame) e o X volta ao menu",
		/onSettings: settingsOverRun/.test(main) &&
			/showSettings\(\s*ctx,[\s\S]*?true,?\s*\)/.test(fn("settingsOverRun")) &&
			!/stopGame\(/.test(fn("settingsOverRun")) &&
			/openPause\(\)/.test(fn("settingsOverRun")),
	);
	const lobbySrc = readFileSync(join(SRC, "client/ui/lobby.ts"), "utf8");
	check("lobby.ts: fechar o lobby nao tira o voo (so a partida o solta)", !/detachFlyover\(/.test(lobbySrc));
}

console.log("");
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
}
console.log(
	"OK: toda janela centrada na tela inteira e longe dos botoes do Roblox; a cidade atras de toda tela de menu, sem parar e sem criar Instance; sobre a partida, o mundo",
);
