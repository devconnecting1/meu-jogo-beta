#!/usr/bin/env node
/*
 * Every menu and every way of moving through them, the keys that reach the game while a menu is open, the
 * achievements and records, and the game's strings (docs/DESIGN_RULES.md UI-03, UI-06, UI-07, UI-10, UI-11).
 *
 *   npm run test:nav
 *   PZ_SRC=<another checkout>/src node tools/test-nav.mjs    (measures that version)
 *
 * test:lobby covers the lobby and the Survivor screen in depth, test:screens where every window sits, test:menus the
 * world going on behind the Bag. This suite walks every OTHER screen as a player would, with the REAL settings.ts /
 * wardrobe.ts / shop.ts / credits.ts / tutorial.ts / pauseMenu.ts / backpack.ts / lobby.ts / popup.ts / widgets.ts and
 * client/bootstrap.ts (its input handlers) under Node, over the counted fake Instance tree of tools/ui-shim.mjs:
 *
 *   1. OPEN / CLOSE     each screen opens, a pad player lands on a control of it, its own close control (X, Back,
 *                       Close, Got it, Back to game) is selectable and closes it through the handler main.client.ts
 *                       wires, and five more open / close cycles leave no Instance and no connection behind.
 *   2. THE PAD          with a menu holding the pad's focus, the buttons that would act in the world (A, X, Y, RT)
 *                       stay the menu's; the two toggles still reach the game: Start (the menu) and LB (the Bag -- the
 *                       button that opens it closes it, UI-11). B: see KNOWN below.
 *   3. MENU PRESSES     a toggle pressed in the lobby (P, B, Start, a weapon key) is not left pending for the first
 *                       frame of the next run: main.client.ts drops them when a run mounts.
 *   4. UI-06            Settings opened over a run keeps the survivor held like the menu it came from (source guard).
 *   5. ACHIEVEMENTS     the lobby's count and each row's progress are the save's (hidden ones out); every visible
 *      AND RECORDS      achievement has a trigger on the SERVER (server/save/achievements.ts, reached from a server
 *                       file) and the client writes none (CON-04): a report cannot move one, the end-of-run kills are
 *                       the server's kill credit, Never die stops at ANY death; nothing of content outside Núcleo 1
 *                       is on view (CON-03); Records shows the save's real values.
 *   6. STRINGS          every literal key the code asks lang.ts for is in LANG_TABLE; every text any of these screens
 *                       shows is a LANG_TABLE entry, made of entries and numbers, or a proper noun; and the CSV that
 *                       `npm run locale` writes is the committed one.
 *
 * KNOWN: bugs found by this suite that are not fixed here (they need a product decision or live in another agent's
 * files). Each is printed as "CONHECIDO" with where it lives; the suite fails if one of them silently changes, so the
 * list stays true: fixing one means removing it from KNOWN. LOC-UPPER (labels the code upper-cases) is a list that
 * moves with every screen, so it is only printed.
 *
 * Pure Node (>= 18) plus the project's TypeScript.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installUiShims } from "./ui-shim.mjs";

const ui = installUiShims({ seed: 1, viewport: [1120, 630] });
const { SRC, ROOT, require, flush, service, measure, Signal } = ui;
// Luau's tonumber (the Bag reads its selection keys with it)
globalThis.tonumber = v => (Number.isFinite(Number(v)) ? Number(v) : undefined);

// every connection the game makes, so a screen that leaves one behind is seen (Signal.clear on Destroy ends the
// ones on a destroyed Instance, exactly as the engine does)
const liveConns = [];
{
	const connect = Signal.prototype.Connect;
	Signal.prototype.Connect = function (fn) {
		const c = connect.call(this, fn);
		liveConns.push(c);
		return c;
	};
}
const connCount = () => liveConns.filter(c => c.Connected).length;

// every key the code asks lang.ts for, while the screens below are on screen
const lang = require(join(SRC, "shared/data/lang.ts"));
const asked = new Set();
{
	const get = lang.langGet;
	lang.langGet = (key, langType) => {
		asked.add(key);
		return get(key, langType);
	};
}

const boot = require(join(SRC, "client/bootstrap.ts"));
const saveClient = require(join(SRC, "client/systems/saveClient.ts"));
saveClient.requestSave = () => true;
const { showSettings } = require(join(SRC, "client/ui/settings.ts"));
const { showWardrobe } = require(join(SRC, "client/ui/wardrobe.ts"));
const { showShop } = require(join(SRC, "client/ui/shop.ts"));
const { showCredits } = require(join(SRC, "client/ui/credits.ts"));
const { showTutorial, SCHEMES } = require(join(SRC, "client/ui/tutorial.ts"));
const { showPause } = require(join(SRC, "client/ui/pauseMenu.ts"));
const { showLobby } = require(join(SRC, "client/ui/lobby.ts"));
const { Backpack } = require(join(SRC, "client/ui/backpack.ts"));
const { Hud } = require(join(SRC, "client/ui/hud.ts"));
const { showRunSummary, showDaybreakWait } = require(join(SRC, "client/onboarding/gameOver.ts"));
const { ACHIEVEMENTS, AchievementId } = require(join(SRC, "shared/data/achievements.ts"));
const Fly = require(join(SRC, "client/view/townFlyover.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const { GAME_NAME } = require(join(SRC, "shared/module.ts"));
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
/** a bug this suite found and reports without fixing: printed, and the check is that it is STILL exactly so */
const known = [];
function knownBug(id, what, where, stillThere) {
	known.push({ id, what, where });
	if (stillThere) console.log(`  CONHECIDO ${id}: ${what}  [${where}]`);
	else {
		console.error(`  FALHA ${id} mudou: "${what}" nao se reproduz mais -- tire-o de KNOWN (e do relatorio)`);
		failures++;
	}
}

const ctx = boot.getCtx();
ctx.phase = "lobby";
const layer = ctx.uiLayer;
const GuiService = service("GuiService");
const UIS = service("UserInputService");
const RunService = service("RunService");
const SEED = DESIGN.TOWN_SEED;

const findIn = (root, name, cls) =>
	root?.GetDescendants().find(d => d.Name === name && (cls === undefined || d.ClassName === cls));
const shown = (g, stop) => {
	for (let p = g; p !== undefined && p !== stop; p = p.Parent) if (p.IsA("GuiObject") && !p.Visible) return false;
	return g.Parent !== undefined;
};
const pad = key => ({
	UserInputType: Enum.UserInputType.Gamepad1,
	KeyCode: Enum.KeyCode[key],
	Position: new Vector3(),
});
const kbd = key => ({
	UserInputType: Enum.UserInputType.Keyboard,
	KeyCode: Enum.KeyCode[key],
	Position: new Vector3(),
});
function tap(inputObj, gpe = false) {
	UIS.InputBegan.Fire(inputObj, gpe);
	flush();
	UIS.InputEnded.Fire(inputObj, false);
	flush();
}

/** the player's last input was a pad: the kit's autoFocus selects a control of every screen that opens */
const lastInput = { type: Enum.UserInputType.MouseMovement };
UIS.GetLastInputType = () => lastInput.type;

// ================================================================ 1. open / close

console.log(`Navegacao: fonte ${SRC}\n`);
console.log("1) cada tela abre, o controle cai nela, o seu botao de fechar fecha, e 5 ciclos nao deixam nada\n");

const lobbyStatus = { loading: false, run: "fresh", hosted: false, seed: SEED };
const noop = () => {};
const lobbyHandlers = {
	onPlay: noop,
	onRebirth: noop,
	onWaitDawn: noop,
	onNewRun: noop,
	onShop: noop,
	onWardrobe: noop,
	onSettings: noop,
	onCredits: noop,
	onTutorial: noop,
	onPage: noop,
};
const pack = new Backpack(ctx);
pack.craftCheck = () => undefined;

/**
 * Each screen: how main.client.ts opens it, the root it puts in the UI layer, the control a player closes it with,
 * and what closing it must do. `close` is the screen's own cleanup when the handler hands the screen back to the
 * caller (as main.client.ts's goLobby / closePause do).
 */
const SCREENS = [
	{
		name: "Settings (lobby)",
		phase: "settings",
		root: "Settings",
		control: "Close",
		open: done => showSettings(ctx, done, noop),
	},
	{
		name: "Settings (sobre a partida)",
		phase: "playing",
		root: "Settings",
		control: "Close",
		open: done => showSettings(ctx, done, undefined, true),
	},
	{
		name: "Wardrobe",
		phase: "shop",
		root: "Wardrobe",
		control: "Close",
		open: done => showWardrobe(ctx, { onBack: done, onEquip: noop, onUnequip: noop }),
	},
	{ name: "Shop", phase: "shop", root: "Shop", control: "Back", open: done => showShop(ctx, done, noop) },
	{ name: "Credits", phase: "credits", root: "Credits", control: "Back", open: done => showCredits(ctx, done) },
	{
		name: "How to play",
		phase: "tutorial",
		root: "HowToPlay",
		control: "Done",
		open: done => showTutorial(ctx, done),
		selfClosing: true,
	},
	{
		name: "Achievements (lobby)",
		phase: "lobby",
		root: "Achievements",
		control: "Close",
		open: () => {
			findIn(layer.FindFirstChild("Lobby"), "Nav2").Activated.Fire();
			flush();
		},
		selfClosing: true,
		needsLobby: true,
	},
	{
		// a UI-07 window since the tables merge (client/ui/records.ts), no longer a popup
		name: "Records (lobby)",
		phase: "lobby",
		root: "Records",
		control: "Close",
		open: () => {
			findIn(layer.FindFirstChild("Lobby"), "Nav3").Activated.Fire();
			flush();
		},
		selfClosing: true,
		needsLobby: true,
	},
	{
		name: "Menu da partida",
		phase: "playing",
		root: "Menu",
		control: "Btn0",
		open: done => showPause(ctx, 0, { onResume: done, onSave: noop, onHome: noop, onShop: noop, onSettings: noop }),
	},
	{
		name: "Bag",
		phase: "playing",
		root: "Backpack",
		control: "Close",
		open: () => pack.open(),
		selfClosing: true,
		isOpen: () => pack.isOpen(),
	},
];

let lobby;
function openLobby() {
	lobby = showLobby(ctx, lobbyHandlers, lobbyStatus, "menu");
	flush();
}
function closeLobby() {
	lobby?.close();
	lobby = undefined;
	flush();
}

/** one open / close: returns what happened */
function cycle(sc) {
	ctx.phase = sc.phase;
	let closedBy = 0;
	let cleanup;
	const done = () => {
		closedBy++;
		// main.client.ts: the handler hands the screen back (goLobby's clearScreen, closePause)
		cleanup?.();
		cleanup = undefined;
	};
	const ret = sc.open(done);
	if (typeof ret === "function") cleanup = ret;
	flush();
	const root = layer.FindFirstChild(sc.root);
	const opened = root !== undefined && root.Visible !== false;
	const sel = GuiService.SelectedObject;
	const focusIn = sel !== undefined && root !== undefined && sel.IsDescendantOf(root) && shown(sel, layer);
	const control = root === undefined ? undefined : findIn(root, sc.control);
	const selectable = control !== undefined && control.Selectable === true && control.IsA("GuiButton");
	control?.Activated.Fire();
	flush();
	const after = layer.FindFirstChild(sc.root);
	const gone = sc.isOpen !== undefined ? !sc.isOpen() && after?.Visible === false : after === undefined;
	const selAfter = GuiService.SelectedObject;
	const selectionFree = selAfter === undefined || !(root !== undefined && selAfter.IsDescendantOf(root));
	cleanup?.();
	flush();
	return { opened, focusIn, selectable, gone, handled: sc.selfClosing === true || closedBy === 1, selectionFree };
}

Fly.pinFlyover(layer, SEED);
flush();
for (const sc of SCREENS) {
	if (sc.needsLobby) openLobby();
	lastInput.type = Enum.UserInputType.Gamepad1;
	const first = cycle(sc);
	check(
		`${sc.name}: abre; o controle cai num botao dela; "${sc.control}" e selecionavel e fecha pela via do main.client`,
		first.opened && first.focusIn && first.selectable && first.gone && first.handled && first.selectionFree,
		JSON.stringify(first),
	);
	// five more, measured: nothing made that is not destroyed, no connection left (the Bag is kept built on purpose,
	// so its first open is outside the measure)
	const conns = connCount();
	const r = measure(() => {
		for (let i = 0; i < 5; i++) cycle(sc);
	});
	const left = r.created - r.destroyed;
	check(
		`${sc.name}: 5 ciclos de abrir e fechar -- nenhuma Instance e nenhuma conexao sobrando`,
		left === 0 && connCount() === conns,
		`${r.created} criadas, ${r.destroyed} destruidas, ${connCount() - conns} conexoes a mais`,
	);
	lastInput.type = Enum.UserInputType.MouseMovement;
	if (sc.needsLobby) closeLobby();
	GuiService.SelectedObject = undefined;
	flush();
}

// the "?" of every window: a pad player who opens the help lands on its Close -- not on the "?" left behind the
// popup, where the next A would stack a second popup over the first
{
	const HELPS = [
		["Settings", "lobby", () => showSettings(ctx, noop, noop)],
		["Wardrobe", "shop", () => showWardrobe(ctx, { onBack: noop, onEquip: noop, onUnequip: noop })],
		[
			"Lobby",
			"lobby",
			() => {
				const h = showLobby(ctx, lobbyHandlers, lobbyStatus, "survivor");
				return () => h.close();
			},
		],
		[
			"Backpack",
			"playing",
			() => {
				pack.open();
				return () => pack.close();
			},
		],
	];
	const bad = [];
	for (const [rootName, phase, open] of HELPS) {
		ctx.phase = phase;
		lastInput.type = Enum.UserInputType.Gamepad1;
		const close = open();
		flush();
		const root = layer.FindFirstChild(rootName);
		const help = root?.GetDescendants().find(d => d.Name === "Help" && d.IsA("GuiButton") && shown(d, layer));
		GuiService.SelectedObject = help;
		help?.Activated.Fire();
		flush();
		const pop = layer.FindFirstChild("PopupOverlay");
		const sel = GuiService.SelectedObject;
		if (help === undefined) bad.push(`${rootName}: sem "?"`);
		else if (pop === undefined) bad.push(`${rootName}: o "?" nao abriu nada`);
		else if (sel === undefined || !sel.IsDescendantOf(pop)) bad.push(`${rootName}: foco em ${sel?.Name ?? "nada"}`);
		pop?.Destroy();
		close();
		GuiService.SelectedObject = undefined;
		lastInput.type = Enum.UserInputType.MouseMovement;
		flush();
	}
	check(
		'o "?" de Settings, Wardrobe, tela Survivor e Bag pelo controle: o foco vai para o Close do popup de ajuda',
		bad.length === 0,
		bad.join("; "),
	);
}

// ================================================================ 2. the pad through a focused menu

console.log("\n2) com um menu segurando o foco do controle: o que chega ao jogo\n");

const input = ctx.input;
ctx.phase = "playing";
{
	lastInput.type = Enum.UserInputType.Gamepad1;
	pack.open();
	flush();
	const focused = GuiService.SelectedObject !== undefined && GuiService.SelectedObject.IsDescendantOf(layer);
	const held = [];
	for (const k of ["ButtonA", "ButtonX", "ButtonY", "ButtonR2", "ButtonR1"]) {
		input.beginFrame();
		tap(pad(k));
		if (input.attackPressed || input.actionPressed || input.reloadPressed) held.push(k);
	}
	input.attackHeld = false;
	check(
		"Bag aberto pelo controle: o foco esta nele, e A / X / Y / RT / RB ficam com o menu (nada de tiro, E ou R no mundo)",
		focused && held.length === 0,
		held.join(", "),
	);
	input.beginFrame();
	tap(pad("ButtonL1"));
	const lbReaches = input.backpackPressed;
	// main.client.ts, the run's Heartbeat: `if (input.backpackPressed) toggleBackpack();`
	if (input.backpackPressed && pack.isOpen()) pack.close();
	flush();
	check(
		"...LB, o botao que abriu o Bag, chega ao jogo e o fecha (UI-11: B / LB abrem E fecham), devolvendo o controle",
		lbReaches && !pack.isOpen() && GuiService.SelectedObject === undefined,
		`backpackPressed ${lbReaches}, aberto ${pack.isOpen()}`,
	);
	input.beginFrame();
	pack.open();
	flush();
	tap(pad("ButtonStart"));
	check("...e Start (o Menu) tambem chega com o foco no Bag", input.pausePressed === true);
	pack.close();
	input.beginFrame();
	flush();

	const close = showPause(ctx, 0, { onResume: noop, onSave: noop, onHome: noop, onShop: noop, onSettings: noop });
	flush();
	tap(pad("ButtonStart"));
	const startCloses = input.pausePressed;
	input.beginFrame();
	tap(pad("ButtonB"));
	const bCloses = layer.FindFirstChild("Menu") === undefined || input.pausePressed;
	close();
	flush();
	check("Menu da partida pelo controle: Start (que o abriu) chega ao jogo, que o fecha", startCloses === true);
	// the key on the Menu's title strip is the one that opens it on THIS device, as the HUD's Menu plate says
	// (SCHEMES): P on a keyboard, Start on a pad, none on a touch screen (its MENU is a button, not a key)
	const keyOnMenu = () => {
		const c = showPause(ctx, 0, { onResume: noop, onSave: noop, onHome: noop, onShop: noop, onSettings: noop });
		flush();
		const hint = findIn(layer.FindFirstChild("Menu"), "KeyHint");
		const text = hint === undefined ? undefined : findIn(hint, "Text")?.Text;
		c();
		flush();
		return text;
	};
	lastInput.type = Enum.UserInputType.Gamepad1;
	const onPad = keyOnMenu();
	lastInput.type = Enum.UserInputType.MouseMovement;
	const onKeyboard = keyOnMenu();
	UIS.TouchEnabled = true;
	UIS.MouseEnabled = false;
	const onTouch = keyOnMenu();
	UIS.TouchEnabled = false;
	UIS.MouseEnabled = true;
	check(
		"...e a tecla no titulo do Menu e a do dispositivo: P no teclado, Start no controle, nenhuma no toque",
		onKeyboard === "P" && onPad === "Start" && onTouch === undefined,
		`teclado ${onKeyboard}, controle ${onPad}, toque ${onTouch}`,
	);
	lastInput.type = Enum.UserInputType.Gamepad1;
	knownBug(
		"NAV-B",
		"o B do controle nao fecha nenhuma tela (so tira a selecao); fechar e so pelo X / Back ou pelo botao que abriu",
		"widgets.ts / window.ts (sem tratamento de ButtonB)",
		!bCloses,
	);
	GuiService.SelectedObject = undefined;
	lastInput.type = Enum.UserInputType.MouseMovement;
	input.beginFrame();
	flush();
}

// ================================================================ 3. presses made in the menus

console.log("\n3) teclas apertadas nos menus nao ficam pendentes para o primeiro quadro da partida\n");

{
	ctx.phase = "lobby";
	openLobby();
	input.beginFrame();
	tap(kbd("P"));
	tap(kbd("B"));
	tap(kbd("Three"));
	lastInput.type = Enum.UserInputType.Gamepad1;
	GuiService.SelectedObject = findIn(layer.FindFirstChild("Lobby"), "Start");
	flush();
	tap(pad("ButtonStart"));
	GuiService.SelectedObject = undefined;
	lastInput.type = Enum.UserInputType.MouseMovement;
	closeLobby();
	const pending = [input.pausePressed, input.backpackPressed, input.weaponSlotPressed];
	check(
		"no lobby, P / B / 3 / Start ficam marcados no InputState (so o quadro da partida os limpa)",
		pending[0] === true && pending[1] === true && pending[2] === 2,
		JSON.stringify(pending),
	);
	const main = readFileSync(join(SRC, "client/main.client.ts"), "utf8");
	const at = main.indexOf("function mountRun(");
	const body = main.slice(at, main.indexOf("\n}\n", at));
	const clearAt = body.search(/ctx\.input\.beginFrame\(\)/);
	const connectAt = body.indexOf("RunService.Heartbeat.Connect");
	check(
		"...e mountRun (main.client.ts) os descarta antes do primeiro quadro: entrar na cidade nao abre o Menu nem o Bag",
		clearAt >= 0 && connectAt > clearAt,
		clearAt < 0
			? "mountRun nao chama ctx.input.beginFrame()"
			: `beginFrame em ${clearAt}, Heartbeat em ${connectAt}`,
	);
	input.beginFrame();
}

// ================================================================ 4. UI-06: Settings over a run holds the survivor

console.log("\n4) UI-06: a Settings sobre a partida segura o sobrevivente como o menu\n");

{
	const main = readFileSync(join(SRC, "client/main.client.ts"), "utf8");
	const fn = name => {
		const at = main.indexOf(`function ${name}(`);
		return at < 0 ? "" : main.slice(at, main.indexOf("\n}\n", at));
	};
	check(
		"settingsOverRun guarda o seu fechamento em pauseCleanup (o 'menuOpen' do quadro: sobrevivente parado, mundo andando)",
		/pauseCleanup = \(\) =>/.test(fn("settingsOverRun")) &&
			/const menuOpen = pauseCleanup !== undefined/.test(fn("mountRun")) &&
			/input\.setHeld\(menuOpen \|\| !alive\)/.test(fn("mountRun")) &&
			/loop\.update\(dt\)/.test(fn("mountRun")),
	);
	check(
		"...e P / Start com ela aberta a fecham (closePause), como fecham o menu",
		/if \(pauseCleanup === undefined\) openPause\(\);\s*else closePause\(\);/.test(fn("mountRun")),
	);
}

// ================================================================ 5. achievements and records

console.log("\n5) conquistas e recordes: o que a tela mostra e o que da para ganhar\n");

{
	const save = ctx.save;
	const visible = ACHIEVEMENTS.filter(a => a.hidden !== true);
	// a save with some progress: two done, one past its max, one half-way
	save.achievements[0] = 1;
	save.achievements[15] = 1;
	save.achievements[12] = 9999;
	save.achievements[14] = 50;
	save.bestDay = 12;
	save.day = 3;
	save.level = 7;
	save.deathCount = 2;
	openLobby();
	const nav = i => findIn(layer.FindFirstChild("Lobby"), `Nav${i}`);
	const sub = findIn(nav(2), "Sub")?.Text;
	const done = visible.filter(a => (save.achievements[a.id] ?? 0) >= a.max).length;
	check(
		"lobby: 'Achievements' conta as feitas sobre as visiveis (as escondidas fora: CON-03 / CON-04)",
		sub === `${done} / ${visible.length}` && done === 3 && visible.length === 9,
		sub,
	);
	nav(2).Activated.Fire();
	flush();
	const dialog = layer.FindFirstChild("Achievements");
	const rows = visible.map(a => findIn(dialog, `Ach${a.id}`));
	const wrong = visible.filter((a, i) => {
		const cur = Math.min(save.achievements[a.id] ?? 0, a.max);
		const v = findIn(rows[i], "Value")?.Text;
		const check = findIn(rows[i], "Check") !== undefined;
		return v !== `${cur.toLocaleString("en-US")} / ${a.max.toLocaleString("en-US")}` || check !== cur >= a.max;
	});
	check(
		"a janela lista as 9 visiveis, cada uma com 'atual / meta' do save (sem passar da meta) e o check so nas feitas",
		rows.every(r => r !== undefined) &&
			wrong.length === 0 &&
			!ACHIEVEMENTS.some(a => a.hidden && findIn(dialog, `Ach${a.id}`)),
		wrong.map(a => `${a.title}: ${findIn(rows[visible.indexOf(a)], "Value")?.Text}`).join("; "),
	);
	findIn(dialog, "Close").Activated.Fire();
	flush();
	nav(3).Activated.Fire();
	flush();
	// the Records window (client/ui/records.ts): one table row per record, the label and the value in two cells
	const records = layer.FindFirstChild("Records");
	const rowText = label => {
		const cell = records?.GetDescendants().find(d => d.ClassName === "TextLabel" && d.Text === label);
		const row = cell?.Parent;
		return row?.GetDescendants().find(d => d.ClassName === "TextLabel" && d !== cell && d.Text !== "")?.Text;
	};
	const shownRecords = {
		best: rowText("Best day"),
		life: rowText("Life day"),
		level: rowText("Level"),
		rebirths: rowText("Rebirths"),
	};
	check(
		"Records: o recorde, o dia desta vida, o nivel e os Rebirths sao os do save",
		shownRecords.best === "12" &&
			shownRecords.life === "3" &&
			shownRecords.level === "7" &&
			shownRecords.rebirths === "2",
		JSON.stringify(shownRecords),
	);
	findIn(records, "Close").Activated.Fire();
	flush();
	const lobbySub = findIn(nav(3), "Sub")?.Text;
	check("...e a chapa Records diz o mesmo recorde", lobbySub === "Best day 12", lobbySub);
	closeLobby();
	save.achievements.fill(0);

	// ---- who raises each achievement: ONLY the server (server/save/achievements.ts, CON-04 / ACH-2)
	const achSrc = readFileSync(join(SRC, "server/save/achievements.ts"), "utf8");
	/** each exported credit function of the module: the ids it names and the other credit functions it calls */
	const fns = new Map();
	for (const m of achSrc.matchAll(/export function (\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)) {
		const ids = [...m[2].matchAll(/AchievementId\.(\w+)/g)].map(x => AchievementId[x[1]]);
		fns.set(m[1], { ids, calls: [] });
	}
	for (const [name, f] of fns) {
		const body = achSrc.slice(achSrc.indexOf(`export function ${name}(`));
		const end = body.indexOf("\n}");
		for (const other of fns.keys())
			if (other !== name && new RegExp(`\\b${other}\\(`).test(body.slice(0, end))) f.calls.push(other);
	}
	// the server files that call a credit function (the module itself does not count: something must reach it)
	const serverFiles = [];
	const walkServer = d => {
		for (const f of readdirSync(d)) {
			const p = join(d, f);
			if (statSync(p).isDirectory()) walkServer(p);
			else if (p.endsWith(".ts") && !p.endsWith(join("save", "achievements.ts"))) serverFiles.push(p);
		}
	};
	walkServer(join(SRC, "server"));
	const callers = new Map();
	for (const p of serverFiles) {
		const text = readFileSync(p, "utf8");
		for (const name of fns.keys()) {
			if (new RegExp(`\\b${name}\\(`).test(text))
				callers.set(name, [...(callers.get(name) ?? []), p.slice(SRC.length + 1)]);
		}
	}
	const reached = new Set();
	const visit = name => {
		if (reached.has(name)) return;
		reached.add(name);
		for (const c of fns.get(name)?.calls ?? []) visit(c);
	};
	for (const name of callers.keys()) visit(name);
	const raised = new Set();
	for (const name of reached) for (const id of fns.get(name).ids) raised.add(id);
	const unreachable = visible.filter(a => !raised.has(a.id)).map(a => a.title);
	check(
		"ACH-1: toda conquista a vista tem um gatilho no SERVIDOR (uma funcao de server/save/achievements.ts que um arquivo do servidor chama)",
		unreachable.length === 0 && [...reached].length > 0,
		unreachable.join(", ") ||
			[...reached].map(n => `${n} <- ${(callers.get(n) ?? ["(interna)"]).join(", ")}`).join("; "),
	);
	// ...and the client raises none: no call, no write into `achievements` anywhere under client/
	const clientWrites = [];
	const walkClient = d => {
		for (const f of readdirSync(d)) {
			const p = join(d, f);
			if (statSync(p).isDirectory()) walkClient(p);
			else if (p.endsWith(".ts")) {
				const text = readFileSync(p, "utf8");
				if (/achievements\[[^\]]+\]\s*=(?!=)|(?:raise|add)Achievement\(/.test(text))
					clientWrites.push(p.slice(SRC.length + 1));
			}
		}
	};
	walkClient(join(SRC, "client"));
	check(
		"ACH-2: nenhum arquivo do cliente escreve uma conquista (o cliente so recebe a carteira do servidor)",
		clientWrites.length === 0,
		clientWrites.join(", "),
	);
	// ...and a report cannot: the server keeps its own counters whatever the client sends
	{
		const SAVE = require(join(SRC, "shared/game/save.ts"));
		const base = SAVE.defaultSave();
		const forged = JSON.parse(JSON.stringify(base));
		forged.achievements = ACHIEVEMENTS.map(a => a.max);
		const upd = SAVE.sanitizeClientReport(forged, base);
		check(
			"ACH-2: um relatorio com todas as conquistas completas nao move nenhuma (sanitizeClientReport, save v6)",
			upd.achievements.every(v => v === 0),
		);
	}

	// ACH-2: the kill counts come from the SERVER's kill credit. The client's copy of a zombie is the mirror's
	// (client/view/actorsView.ts), whose hp is never 0 unless the fuse is lit: the old per-frame count saw no kill
	// at all, except a lit exploder, which it took for one. The real mirror, a walker the server kills and an exploder
	// lighting its fuse, and the end-of-run count over them
	{
		const { MP_PHASE } = require(join(SRC, "shared/net/mpConfig.ts"));
		const { PROGRESS_SERVER_PHASE } = require(join(SRC, "shared/game/save.ts"));
		const onboarding = require(join(SRC, "client/onboarding/index.ts"));
		const PROG = require(join(SRC, "server/sim/progress.ts"));
		const netClient = require(join(SRC, "client/net/netClient.ts"));
		const saved = [netClient.remoteZombies, netClient.remoteBosses, netClient.takeZombieDeaths];
		let remote = [];
		netClient.remoteZombies = () => remote;
		netClient.remoteBosses = () => [];
		netClient.takeZombieDeaths = () => {};
		const { ActorsView } = require(join(SRC, "client/view/actorsView.ts"));
		const view = new ActorsView();
		const refs = { zombies: [], bosses: [], player: { dead: false, x: 0, y: 0 }, input: { held: false } };
		const firstInstall = save.firstInstall;
		save.firstInstall = false; // no coach: only the counters
		save.zombieKills = 40;
		onboarding.attachRun(ctx, refs);
		const walker = { netId: 7, x: 0, y: 0, angle: 0, flags: 0, type: 1, big: false, extra: 0 };
		const bomber = { netId: 8, x: 50, y: 0, angle: 0, flags: 0, type: 3, big: false, extra: 0 };
		const mirror = z => ({ ...z, feetCycle: 0, speed: 0, alpha: 1, stale: false });
		remote = [mirror(walker), mirror(bomber)];
		view.sync(refs, 1 / 60, () => {});
		// the server kills the walker (it stops arriving) and credits it; the exploder only lights its fuse
		const saves = new Map([[0, save]]);
		const prog = new PROG.Progress({ saveOf: slot => saves.get(slot) });
		prog.zombieKilled(7, 10, 0, 0, 1, 7);
		remote = [mirror({ ...bomber, extra: 1 })];
		for (let i = 0; i < 12; i++) {
			view.sync(refs, 1 / 60, () => {});
			RunService.Heartbeat.Fire(0.1);
			flush();
		}
		const summary = onboarding.runSummary(ctx, false);
		onboarding.detachRun();
		[netClient.remoteZombies, netClient.remoteBosses, netClient.takeZombieDeaths] = saved;
		save.firstInstall = firstInstall;
		check(
			"ACH-2: o fim de partida conta o abate que o SERVIDOR creditou (1), nao o pavio aceso de um bombardeiro (MP_PHASE 2)",
			MP_PHASE >= PROGRESS_SERVER_PHASE && summary.kills === 1 && save.zombieKills === 41,
			`kills ${summary.kills}, zombieKills ${save.zombieKills}`,
		);
		check(
			"...e o mesmo credito moveu as conquistas de abate (Zombie slayer, Melee weapons expert) no save do servidor",
			save.achievements[AchievementId.ZombieSlayer] === 1 && save.achievements[AchievementId.MeleeExpert] === 1,
		);
		save.achievements.fill(0);
		save.zombieKills = 0;
	}

	// ACH-3 / CON-03: Núcleo 1 is the Dagger, the Axe, the bat and the Pistol, and "sem chefe" -- no bow, no sniper, no
	// electricity, no vehicle, no turret. An achievement about content the game does not have is switched off (hidden)
	// until that content comes back, as the Records window lost its boss line for the same reason (UI-10)
	const OFF_CONTENT = {
		1: "eletricidade",
		3: "arco",
		7: "sniper",
		8: "chefe",
		9: "chefe",
		10: "chefe",
		11: "chefe",
		16: "veiculo",
		21: "torreta",
	};
	const onView = Object.keys(OFF_CONTENT)
		.map(Number)
		.filter(id => visible.some(a => a.id === id));
	check(
		"ACH-3: nenhuma conquista de conteudo fora do Nucleo 1 esta a vista (chefes 8-11, arco, sniper, eletricidade, veiculo, torreta: CON-03)",
		onView.length === 0,
		onView.map(id => `${ACHIEVEMENTS[id].title} (${OFF_CONTENT[id]})`).join(", ") || "todas escondidas",
	);
	check(
		"...e escondida nao e apagada: as 22 linhas continuam, com os ids do save (CON-03)",
		ACHIEVEMENTS.length === 22 && ACHIEVEMENTS.every((a, i) => a.id === i),
	);
	// ACH-4: Never die counts the nights of a life that has not died -- EVERY death, not only a paid Rebirth
	{
		const SAVE = require(join(SRC, "shared/game/save.ts"));
		const TITLES_SRV = require(join(SRC, "server/save/titles.ts"));
		const ACH_SRV = require(join(SRC, "server/save/achievements.ts"));
		const life = SAVE.defaultSave();
		TITLES_SRV.creditLifeNight(life);
		ACH_SRV.countLifeDeath(life); // a death answered by the wait for daybreak: deathCount stays 0
		TITLES_SRV.creditLifeNight(life);
		const lifeSrc = readFileSync(join(SRC, "server/sim/life.ts"), "utf8");
		const died = lifeSrc.slice(lifeSrc.indexOf("\tdied(sp: ServerPlayer)"), lifeSrc.indexOf("\trebirth(userId"));
		check(
			"ACH-4: Never die para na primeira morte da vida, paga ou esperada (lifeDeaths, que LifeKeeper.died conta em TODA morte)",
			life.deathCount === 0 &&
				life.lifeDeaths === 1 &&
				life.achievements[AchievementId.NeverDie] === 1 &&
				/countLifeDeath\(sp\.save\)/.test(died),
			`deathCount ${life.deathCount}, lifeDeaths ${life.lifeDeaths}, Never die ${life.achievements[AchievementId.NeverDie]}`,
		);
	}
}

// ================================================================ 6. strings

console.log("\n6) textos: tudo pela lang.ts, nada fora da tabela, e o CSV do `npm run locale` em dia\n");

const LANG = new Set(lang.LANG_TABLE);
/** (a Set's size is a method under the Luau shims) */
const LANG_COUNT = [...LANG].length;
{
	// every literal the code passes to tr() / langGet()
	const files = [];
	const walk = d => {
		for (const f of readdirSync(d)) {
			const p = join(d, f);
			if (statSync(p).isDirectory()) walk(p);
			else if (p.endsWith(".ts")) files.push(p);
		}
	};
	walk(SRC);
	const missing = [];
	for (const f of files) {
		// UI-03: the admin panel is the developer's own tool, in English on purpose
		if (f.includes(join("client", "admin"))) continue;
		const src = readFileSync(f, "utf8");
		for (const m of src.matchAll(/\b(?:tr|langGet)\(\s*"((?:[^"\\]|\\.)*)"/g)) {
			const key = m[1].replace(/\\(.)/g, "$1");
			if (!LANG.has(key)) missing.push(`${f.slice(SRC.length + 1)}: "${key}"`);
		}
	}
	check(
		"toda chave literal pedida a tr() / langGet() existe em LANG_TABLE",
		missing.length === 0,
		missing.join("; ") || `${files.length} arquivos`,
	);
}

{
	// the data the screens show through tr(): every item, skill, visible achievement, pack and title name, and every
	// line of SCHEMES (the Controls tab and How to play) -- a row added to a table without its entry fails here
	const need = [];
	const table = (file, name, field, keep = () => true) => {
		const rows = require(join(SRC, `shared/data/${file}.ts`))[name];
		for (const r of rows) if (keep(r) && typeof r[field] === "string") need.push([`${name}.${field}`, r[field]]);
	};
	table("weapons", "WEAPONS", "name");
	table("equips", "EQUIPS", "name");
	table("usables", "USABLES", "name");
	table("etcItems", "ETC_ITEMS", "name");
	table("skills", "SKILLS", "name");
	table("achievements", "ACHIEVEMENTS", "title", a => a.hidden !== true);
	table("shop", "SHOP_PACKS", "name");
	table("titles", "TITLES", "name");
	for (const sc of SCHEMES) {
		need.push(["SCHEMES.title", sc.title], ["SCHEMES.note", sc.note]);
		for (const [, what] of sc.rows) need.push(["SCHEMES.rows", what]);
	}
	const missing = need.filter(([, v]) => !LANG.has(v)).map(([where, v]) => `${where}: "${v}"`);
	check(
		"todo nome dos dados que as telas mostram (itens, skills, conquistas, pacotes, titulos, SCHEMES) esta na LANG_TABLE",
		missing.length === 0,
		missing.join("; ") || `${need.length} textos`,
	);
}

/** proper nouns a translator leaves alone (UI-03: the English of a name IS the name), and the kit's glyphs */
const PROPER = new Set([
	GAME_NAME,
	"PROJECT Z",
	"Dead Town (Lemon Puppy Games)",
	"roblox-ts",
	"Tester",
	"X",
	"?",
	// the original's credits (credits.ts): studios, a site and people's handles
	"Yoyo games",
	"Crazy GM",
	"Play GM",
	"opengameart.org",
	"dlf0325",
	"sodium031",
	"zizonpink",
]);
/** key legends are keys (the kit's Keycap / ValueKey / badge): the keyboard's letters and the pad's button names */
const KEYS = new Set(SCHEMES.flatMap(s => s.rows.map(r => r[0])));
/** units that read the same in every language the platform offers: "0.3 s", "280 XP", "1120 x 630" */
const UNITS = /\b(?:\d+(?:\.\d+)?\s*(?:s|XP|HP)|\d+\s*x\s*\d+|×\s*\d+)\b/g;
const LETTERS = /[A-Za-z]/;
/** the entries, and each line of a multi-line entry ("#" is a new line on screen: widgets.nl) */
const LINES = new Set([...LANG].flatMap(e => [e, ...e.split("#")]));
/** a label the code upper-cases (`.upper()`) shows a text the table does not have: "START" for "Start" */
const UPPER = new Set([...LINES].map(e => e.toUpperCase()).filter(e => !LINES.has(e)));
/** a piece found as a whole word (never "R" out of "START" or "Use" out of "User") */
const wordRe = e => new RegExp(`(?<![A-Za-z])${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "g");
/** every piece a line may be made of, longest first; `upper`: only the upper case of an entry */
const PIECES = [
	...[...LINES, ...PROPER, ...KEYS].map(e => ({ e, upper: false })),
	...[...UPPER].map(e => ({ e, upper: true })),
]
	.filter(p => LETTERS.test(p.e))
	.sort((a, b) => b.e.length - a.e.length)
	.map(p => ({ ...p, re: wordRe(p.e) }));
/**
 * Does one line of text reach the localisation table? It does when it is an entry (or a line of one), a proper noun
 * or a key, or when taking every entry (longest first, as whole words), number and unit out of it leaves no letter --
 * "Best day:  12", "Rebirth  ·  250". "upper": it only does as the upper case of an entry, which the platform
 * (case-sensitive) does not match. "literal": a text that never reaches the table at all.
 */
function lineKind(line) {
	const t = line.replace(/<[^>]+>/g, "").trim();
	if (!LETTERS.test(t) || LINES.has(t) || PROPER.has(t) || KEYS.has(t) || /^[A-Z]$/.test(t)) return "ok";
	let rest = t.replace(UNITS, " ");
	let upper = false;
	for (const p of PIECES) {
		if (!rest.includes(p.e)) continue;
		const next = rest.replace(p.re, " ");
		if (next !== rest && p.upper) upper = true;
		rest = next;
	}
	rest = rest.replace(/[0-9]+/g, " ");
	if (LETTERS.test(rest)) return "literal";
	return upper ? "upper" : "ok";
}
/** the texts on screen under `root` that do not reach the table, by kind: `where/name: "text"` */
function textsIn(root, where) {
	const out = { literal: [], upper: [] };
	for (const d of root.GetDescendants()) {
		if (d.ClassName !== "TextLabel" && d.ClassName !== "TextButton") continue;
		if (d.Text === "" || !shown(d, root.Parent)) continue;
		for (const line of String(d.Text).split("\n")) {
			const kind = lineKind(line);
			if (kind !== "ok") out[kind].push(`${where}/${d.Name}: "${line.slice(0, 48)}"`);
		}
	}
	return out;
}
{
	// every screen of this suite, the lobby's two pages, the HUD (desktop and touch) and the end-of-run screens
	const found = { literal: [], upper: [] };
	const visit = (where, open, rootName) => {
		const close = open();
		flush();
		const root = layer.FindFirstChild(rootName) ?? ctx.hudLayer.FindFirstChild(rootName);
		if (root === undefined) found.literal.push(`${where}: nao abriu`);
		else {
			const t = textsIn(root, where);
			found.literal.push(...t.literal);
			found.upper.push(...t.upper);
		}
		if (typeof close === "function") close();
		flush();
	};
	ctx.phase = "lobby";
	visit(
		"Lobby",
		() => {
			const h = showLobby(ctx, lobbyHandlers, lobbyStatus, "menu");
			return () => h.close();
		},
		"Lobby",
	);
	visit(
		"Survivor",
		() => {
			const h = showLobby(
				ctx,
				lobbyHandlers,
				{ ...lobbyStatus, run: "over", hosted: true, clockDriven: true },
				"survivor",
			);
			return () => h.close();
		},
		"Lobby",
	);
	for (let tab = 0; tab < 4; tab++) {
		visit(
			`Settings aba ${tab}`,
			() => {
				const close = showSettings(ctx, noop, noop);
				flush();
				findIn(layer.FindFirstChild("Settings"), "Tabs").FindFirstChild(`Tab${tab}`).Activated.Fire();
				return close;
			},
			"Settings",
		);
	}
	visit("Wardrobe", () => showWardrobe(ctx, { onBack: noop, onEquip: noop, onUnequip: noop }), "Wardrobe");
	visit("Shop", () => showShop(ctx, noop, noop), "Shop");
	visit("Credits", () => showCredits(ctx, noop), "Credits");
	visit("How to play", () => showTutorial(ctx, noop), "HowToPlay");
	ctx.phase = "playing";
	visit(
		"Menu",
		() => showPause(ctx, 0, { onResume: noop, onSave: noop, onHome: noop, onShop: noop, onSettings: noop }),
		"Menu",
	);
	// the end-of-run screen's four epitaphs (gameOver.ts closingLine): a record, five days, a first death, the rest
	const summaries = [
		{ days: 12, bestDay: 12, level: 7, kills: 20, bosses: 0, first: false },
		{ days: 6, bestDay: 12, level: 7, kills: 20, bosses: 0, first: false },
		{ days: 1, bestDay: 3, level: 1, kills: 0, bosses: 0, first: true },
		{ days: 3, bestDay: 12, level: 7, kills: 20, bosses: 0, first: false },
	];
	for (const summary of summaries) {
		visit(
			`Fim de partida (${summary.days} dias)`,
			() => showRunSummary(ctx, summary, { onRebirth: noop, onNewRun: noop, onHome: noop }),
			"RunOver",
		);
	}
	visit(
		"Espera do amanhecer",
		() => showDaybreakWait(ctx, summaries[3], { onRebirth: noop, onNewRun: noop, onHome: noop }).close,
		"RunOver",
	);
	for (let t = 0; t < 6; t++) {
		visit(
			`Bag aba ${t}`,
			() => {
				pack.open();
				flush();
				findIn(layer.FindFirstChild("Backpack"), "Tabs")?.FindFirstChild(`Tab${t}`)?.Activated.Fire();
				return () => pack.close();
			},
			"Backpack",
		);
	}
	for (const touch of [false, true]) {
		UIS.TouchEnabled = touch;
		visit(
			touch ? "HUD toque" : "HUD",
			() => {
				const h = new Hud(ctx);
				h.mount();
				h.update({
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
					weaponId: 0,
					weaponName: "Dagger",
					mag: 0,
					magSize: 0,
					reloading: false,
					reloadRatio: 0,
					ammoPool: 0,
					hitFlash: 0,
				});
				return () => h.unmount();
			},
			"HudRoot",
		);
	}
	UIS.TouchEnabled = false;
	ctx.phase = "lobby";
	check(
		"todo texto destas telas esta na LANG_TABLE, e feito de entradas e numeros, ou e nome proprio / tecla",
		found.literal.length === 0,
		found.literal.join("; "),
	);
	// informational (the list moves with every screen, so it is not pinned): see the report
	if (found.upper.length > 0) {
		known.push({ id: "LOC-UPPER" });
		console.log(
			`  CONHECIDO LOC-UPPER: ${found.upper.length} rotulos em maiusculas (.upper() de uma entrada) que a traducao do Roblox, sensivel a caixa, nao casa: ${found.upper.join("; ")}`,
		);
	}
	const notInTable = [...asked].filter(k => !LANG.has(k));
	check(
		"toda chave que as telas pediram a lang.ts em tempo de execucao esta na LANG_TABLE (nenhuma cai fora do CSV)",
		notInTable.length === 0,
		notInTable.map(k => `"${k.slice(0, 50)}"`).join("; ") || `${asked.size} chaves`,
	);
}
{
	// `npm run locale` in a scratch copy: its CSV must be the committed one, and it must read every entry of the table
	const tmp = mkdtempSync(join(tmpdir(), "pz-locale-"));
	try {
		mkdirSync(join(tmp, "tools"), { recursive: true });
		mkdirSync(join(tmp, "src/shared/data"), { recursive: true });
		writeFileSync(join(tmp, "tools/gen-locale.mjs"), readFileSync(join(ROOT, "tools/gen-locale.mjs")));
		writeFileSync(join(tmp, "src/shared/data/lang.ts"), readFileSync(join(SRC, "shared/data/lang.ts")));
		execFileSync(process.execPath, [join(tmp, "tools/gen-locale.mjs")], { stdio: "pipe" });
		const fresh = readFileSync(join(tmp, "design/locale/ProjectZ.csv"), "utf8");
		const committed = readFileSync(join(ROOT, "design/locale/ProjectZ.csv"), "utf8");
		const rows = fresh.trimEnd().split("\n").length - 1;
		check(
			"o CSV commitado (design/locale/ProjectZ.csv) e o que `npm run locale` gera hoje",
			fresh === committed,
			fresh === committed ? `${rows} textos` : "rode `npm run locale` e commite o CSV",
		);
		check(
			"...e o gerador le TODA entrada da LANG_TABLE (nenhuma escapa do parser dele)",
			rows === LANG_COUNT,
			`${rows} no CSV, ${LANG_COUNT} na tabela`,
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

console.log("");
if (known.length > 0) {
	console.log(
		`${known.length} bug(s) conhecido(s), reportado(s) e nao corrigido(s) aqui: ${known.map(k => k.id).join(", ")}`,
	);
}
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
}
console.log(
	"OK: toda tela abre e fecha sem sobra, o controle navega, conquistas e recordes sao os do save, e os textos estao na tabela",
);
