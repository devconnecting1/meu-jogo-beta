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
 *                       wires, and five more open / close cycles leave no Instance and no connection behind; the
 *                       menus' ScreenGui draws while a screen is open and stops when it closes; and the D-pad walks
 *                       every grid one cell at a time (the Bag with a short last row, its tabs, the shop's cards and
 *                       rail, the Settings tabs, the wardrobe: GuiObject.NextSelection*, widgets.linkGrid).
 *   2. THE PAD          with a menu holding the pad's focus, the buttons that would act in the world (A, X, Y, RT)
 *                       stay the menu's; the two toggles still reach the game: Start (the menu) and LB (the Bag -- the
 *                       button that opens it closes it, UI-11).
 *   2b. B / BACKSPACE   back out of the screen on top (client/ui/backStack.ts, NAV-B): every screen of section 1, by
 *                       both keys, through the same handler as its own control; a help popup closes alone and gives
 *                       the pad back to its "?"; a question is dismissed, never answered; never the lobby's own menu,
 *                       the end-of-run choice, the daybreak wait or the HUD's scoreboard; nothing eaten in a run.
 *   2c. THE DEATH       the death screen (client/onboarding/gameOver.ts, UI-13) with a pad: the focus lands on the action
 *       SCREEN          that works (Rebirth when it can be paid, else Home in a wait and New game when the run is over);
 *                       the world's buttons stay the screen's, Start and LB reach the game as from every menu; New game
 *                       asks with the pad on Cancel and B dismisses the question unanswered; five cycles leave nothing.
 *   3. MENU PRESSES     a toggle pressed in the lobby (P, B, Start, a weapon key) is not left pending for the first
 *                       frame of the next run: main.client.ts drops them when a run mounts.
 *   4. UI-06            Settings opened over a run keeps the survivor held like the menu it came from (source guard).
 *   5. ACHIEVEMENTS     the lobby's count and each row's progress are the save's (hidden ones out); every visible
 *      AND RECORDS      achievement has a trigger on the SERVER (server/save/achievements.ts, reached from a server
 *                       file) and the client writes none (CON-04): a report cannot move one, the end-of-run kills are
 *                       the server's kill credit, Never die stops at ANY death; nothing of content outside Núcleo 1
 *                       is on view (CON-03); Records shows the save's real values.
 *   6. STRINGS          every literal key the code asks lang.ts for is in LANG_TABLE; every text any of these screens
 *                       shows is a LANG_TABLE entry, made of entries and numbers, or a proper noun; no label is an
 *                       entry upper-cased in code (LOC-UPPER: translation is case-sensitive, capitals are their own
 *                       entries); and the CSV that `npm run locale` writes is the committed one, with every multi-line
 *                       entry as the screen shows it, real line breaks and no "#" (LOC-NL).
 *
 * KNOWN: bugs found by this suite that are not fixed here (they need a product decision or live in another agent's
 * files). Each is printed as "CONHECIDO" with where it lives; the suite fails if one of them silently changes, so the
 * list stays true: fixing one means removing it from KNOWN. (Empty since the settings / menus fixes: NAV-B, ACH-1..4,
 * LOC-UPPER and LOC-NL are real checks now.)
 *
 * Pure Node (>= 18) plus the project's TypeScript.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT } from "./locale-context.mjs";
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
const REC = require(join(SRC, "client/ui/records.ts"));
const { ACHIEVEMENTS, AchievementId } = require(join(SRC, "shared/data/achievements.ts"));
const Fly = require(join(SRC, "client/view/townFlyover.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const { GAME_NAME } = require(join(SRC, "shared/module.ts"));
const TOWNS = require(join(SRC, "shared/data/townNames.ts"));
const { showServers, askRestartTown, TRAVEL_TIMEOUT_S } = require(join(SRC, "client/ui/servers.ts"));
const TownNet = require(join(SRC, "client/net/townNet.ts"));
const { THEME } = require(join(SRC, "client/ui/theme.ts"));
flush();
const sameRgb = (a, b) =>
	a !== undefined && b !== undefined && Math.abs(a.R - b.R) + Math.abs(a.G - b.G) + Math.abs(a.B - b.B) < 1e-6;

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
	// a UI-07 window since the shop's polish (MON-06): its red X is the way out, as on every window
	{ name: "Shop", phase: "shop", root: "Shop", control: "Close", open: done => showShop(ctx, done, noop) },
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
		// MP-26: the lobby's Servers window (client/ui/servers.ts), opened by its button on a hosted lobby's Town section
		name: "Servers (lobby)",
		phase: "lobby",
		root: "Servers",
		control: "Close",
		open: () => {
			findIn(layer.FindFirstChild("Lobby"), "Servers", "TextButton").Activated.Fire();
			flush();
		},
		selfClosing: true,
		needsLobby: true,
		status: "hosted",
	},
	{
		name: "Menu da partida",
		phase: "playing",
		root: "Menu",
		control: "Btn0",
		open: done => showPause(ctx, 0, { onResume: done, onHome: noop, onShop: noop, onSettings: noop }),
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

/**
 * MP-26: the town's remote, answered here: three public towns (one full) for the Servers window, and every request
 * kept, so a question dismissed by B can be shown to have sent nothing (client/net/townNet.ts `setTownRequester`)
 */
const townRequests = [];
const SERVER_ROWS = [
	{ jobId: "job-a", seed: 11, day: 6, players: 3, max: 6 },
	{ jobId: "job-b", seed: 22, day: 12, players: 2, max: 6 },
	{ jobId: "job-c", seed: 33, day: 4, players: 6, max: 6 },
];
TownNet.setTownRequester(req => {
	townRequests.push(req);
	if (req.kind === "servers") return { ok: true, servers: SERVER_ROWS };
	return { ok: true };
});
const hostedStatus = { ...lobbyStatus, hosted: true };

let lobby;
function openLobby(status) {
	lobby = showLobby(ctx, lobbyHandlers, status === "hosted" ? hostedStatus : lobbyStatus, "menu");
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
	// the menus' ScreenGui draws while a screen is on it, and only then (a closed Bag kept for reuse costs nothing)
	const drawnOpen = ctx.uiGui.Enabled;
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
	return {
		opened,
		focusIn,
		selectable,
		gone,
		handled: sc.selfClosing === true || closedBy === 1,
		selectionFree,
		drawnOpen,
		drawnAfter: ctx.uiGui.Enabled,
	};
}

// the town behind the menus, where main.client.ts pins it: the world's ScreenGui, never the menus' (client/bootstrap.ts)
Fly.pinFlyover(ctx.backdropLayer, SEED);
flush();
for (const sc of SCREENS) {
	if (sc.needsLobby) openLobby(sc.status);
	lastInput.type = Enum.UserInputType.Gamepad1;
	const first = cycle(sc);
	check(
		`${sc.name}: abre; o controle cai num botao dela; "${sc.control}" e selecionavel e fecha pela via do main.client`,
		first.opened && first.focusIn && first.selectable && first.gone && first.handled && first.selectionFree,
		JSON.stringify(first),
	);
	// with the lobby under it the menus' ScreenGui stays on after the screen closes; with nothing under it, off
	check(
		`${sc.name}: a ScreenGui dos menus desenha com ela aberta e ${sc.needsLobby ? "segue (o lobby esta embaixo)" : "desliga ao fechar"}`,
		first.drawnOpen === true && first.drawnAfter === (sc.needsLobby === true),
		`aberta ${first.drawnOpen}, depois ${first.drawnAfter}`,
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

// MP-26: the Servers window with a pad, and the keeper's Restart town -- asked first, B leaves it unanswered
{
	ctx.phase = "lobby";
	lastInput.type = Enum.UserInputType.Gamepad1;
	const player = service("Players").LocalPlayer;
	townRequests.length = 0;
	const win = showServers(ctx);
	flush();
	const root = layer.FindFirstChild("Servers");
	const rowsShown = root
		?.GetDescendants()
		.filter(d => d.Name.startsWith("Row") && d.IsA("GuiButton") && shown(d, layer));
	const firstRow = rowsShown?.[0];
	const focusOnRow = firstRow !== undefined && GuiService.SelectedObject === firstRow;
	const join = findIn(root, "Join", "TextButton");
	const joinOffBefore = join?.Interactable === false;
	// the full town (third row) never enables Join; an open one does, and Join asks the server for THAT server
	const pickRow = i => {
		rowsShown?.[i]?.Activated.Fire();
		flush();
	};
	pickRow(2);
	const fullStaysOff = join?.Interactable === false;
	pickRow(0);
	const openTurnsOn = join?.Interactable === true && join?.Selectable === true;
	join?.Activated.Fire();
	flush();
	const sent = townRequests.map(r => (r.kind === "join" ? `join:${r.jobId}` : r.kind));
	win.close();
	flush();
	check(
		"Servers: o controle cai na primeira cidade; Join so com uma cidade aberta escolhida, e pede ESSE servidor",
		focusOnRow && joinOffBefore && fullStaysOff && openTurnsOn && sent.join(",") === "servers,join:job-a",
		JSON.stringify({ focusOnRow, joinOffBefore, fullStaysOff, openTurnsOn, sent }),
	);

	// Restart town: nobody but the keeper the server marked sees it
	openLobby("hosted");
	const lobbyRoot = layer.FindFirstChild("Lobby");
	const restart = findIn(lobbyRoot, "RestartTown", "TextButton");
	const hiddenForGuest = restart !== undefined && !shown(restart, layer);
	closeLobby();
	player.SetAttribute("pz_town_keeper", true);
	openLobby("hosted");
	const restart2 = findIn(layer.FindFirstChild("Lobby"), "RestartTown", "TextButton");
	const shownForKeeper = restart2 !== undefined && shown(restart2, layer) && restart2.Selectable === true;
	townRequests.length = 0;
	restart2?.Activated.Fire();
	flush();
	const popupUp = layer.FindFirstChild("PopupOverlay") !== undefined;
	const onCancel = GuiService.SelectedObject?.Name === "PopupBtn1";
	tap(pad("ButtonB"), true);
	const dismissed = layer.FindFirstChild("PopupOverlay") === undefined && townRequests.length === 0;
	restart2?.Activated.Fire();
	flush();
	findIn(layer.FindFirstChild("PopupOverlay"), "PopupBtn0")?.Activated.Fire();
	flush();
	const asked = townRequests.map(r => r.kind).join(",");
	closeLobby();
	player.SetAttribute("pz_town_keeper", undefined);
	GuiService.SelectedObject = undefined;
	lastInput.type = Enum.UserInputType.MouseMovement;
	flush();
	check(
		"Restart town: escondido para quem nao e o dono; o dono ve, a pergunta abre no Cancel, o B fecha sem pedir nada e so o Restart pede",
		hiddenForGuest && shownForKeeper && popupUp && onCancel && dismissed && asked === "restart",
		JSON.stringify({ hiddenForGuest, shownForKeeper, popupUp, onCancel, dismissed, asked }),
	);

	// review of 0b44458, L5: a trip that neither leaves nor fails gives the list back after TRAVEL_TIMEOUT_S; and a
	// TeleportInitFailed that comes BEFORE the join's own answer is the last word, never overwritten by "Travelling"
	const delays = [];
	const realDelay = task.delay;
	task.delay = (sec, fn) => delays.push({ sec, fn });
	const statusOf = () => findIn(layer.FindFirstChild("Servers"), "Status")?.Text ?? "";
	const pickFirstAndJoin = () => {
		const root = layer.FindFirstChild("Servers");
		findIn(root, "Row0", "TextButton")?.Activated.Fire();
		flush();
		findIn(root, "Join", "TextButton")?.Activated.Fire();
		flush();
	};
	try {
		TownNet.setTownRequester(req => (req.kind === "servers" ? { ok: true, servers: SERVER_ROWS } : { ok: true }));
		const w1 = showServers(ctx);
		flush();
		pickFirstAndJoin();
		const travelling = statusOf().startsWith("Travelling to");
		const timer = delays.find(d => d.sec === TRAVEL_TIMEOUT_S);
		timer?.fn();
		flush();
		const join1 = findIn(layer.FindFirstChild("Servers"), "Join", "TextButton");
		const back = statusOf() === "The trip did not start. Try again" && join1?.Interactable === true;
		w1.close();
		flush();
		check(
			`Servers: uma viagem que nao sai nem falha em ${TRAVEL_TIMEOUT_S} s devolve a lista, dizendo por que (Join de novo)`,
			travelling && timer !== undefined && back,
			JSON.stringify({ travelling, timer: timer !== undefined, status: statusOf(), back }),
		);
		// the notice first, the answer after
		TownNet.setTownRequester(req => {
			if (req.kind === "servers") return { ok: true, servers: SERVER_ROWS };
			TownNet.noticeJoinFailed("full");
			return { ok: true };
		});
		delays.length = 0;
		const w2 = showServers(ctx);
		flush();
		pickFirstAndJoin();
		const saysFull = statusOf() === "That town is full";
		const join2 = findIn(layer.FindFirstChild("Servers"), "Join", "TextButton");
		const noTimer = delays.length === 0;
		w2.close();
		flush();
		check(
			"Servers: o TeleportInitFailed que chega ANTES da resposta e a ultima palavra ('full'), nunca coberto por 'Travelling'",
			saysFull && join2?.Interactable === true && noTimer,
			JSON.stringify({ saysFull, noTimer }),
		);
	} finally {
		task.delay = realDelay;
		TownNet.setTownRequester(req => {
			townRequests.push(req);
			if (req.kind === "servers") return { ok: true, servers: SERVER_ROWS };
			return { ok: true };
		});
	}
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

// the D-pad through the grids, one cell at a time (GuiObject.NextSelection*, widgets.linkGrid): the engine's nearest-
// object guess skips a row or jumps to the panel beside a grid whose last row is short. The shim has no spatial
// navigation of its own, so what is checked is the links the screens set -- the ones the engine follows first
{
	/**
	 * What is wrong with `cells` (reading order, `cols` to a row) as a grid the pad walks: Right walks a row and stops at
	 * its end; Left is its way back; Down goes to the same column of the next row, or to that row's last cell when the
	 * row is short, and stops at the last row; Up goes back up a column; every link lands on a shown, selectable cell of
	 * the grid. The outer edges are left to the engine (no link): the focus still leaves for the tabs or the panel.
	 */
	const gridIssues = (label, cells, cols) => {
		const bad = [];
		const n = cells.length;
		const at = c => cells.indexOf(c);
		for (let i = 0; i < n; i++) {
			const c = cells[i];
			const col = i % cols;
			const row = Math.floor(i / cols);
			const rowEnd = Math.min((row + 1) * cols, n) - 1;
			const right = c.NextSelectionRight;
			if (i < rowEnd ? right !== cells[i + 1] : right !== undefined)
				bad.push(`${label} ${i}: Right -> ${at(right)}`);
			const left = c.NextSelectionLeft;
			if (col > 0 ? left !== cells[i - 1] : left !== undefined) bad.push(`${label} ${i}: Left -> ${at(left)}`);
			const down = c.NextSelectionDown;
			const nextRow = (row + 1) * cols;
			const wantDown = nextRow >= n ? undefined : i + cols < n ? cells[i + cols] : cells[n - 1];
			if (down !== wantDown) bad.push(`${label} ${i}: Down -> ${at(down)}`);
			const up = c.NextSelectionUp;
			if (row > 0 ? up !== cells[i - cols] : up !== undefined) bad.push(`${label} ${i}: Up -> ${at(up)}`);
			for (const t of [right, left, down, up]) {
				if (t !== undefined && !(at(t) >= 0 && t.Selectable && shown(t, layer)))
					bad.push(`${label} ${i}: fora da grade`);
			}
		}
		return bad;
	};
	const bad = [];
	const counts = [];
	// the Bag: seven weapons, so the second row is short (five, then two)
	ctx.phase = "playing";
	const { COLS: BAG_COLS } = require(join(SRC, "client/ui/bagGrid.ts"));
	const { WEAPONS } = require(join(SRC, "shared/data/weapons.ts"));
	const weaponsBefore = [...ctx.save.invenWeapon];
	for (let id = 0, owned = 0; id < WEAPONS.length && owned < 7; id++) {
		if (WEAPONS[id] === undefined) continue;
		ctx.save.invenWeapon[id] = 1;
		owned = ctx.save.invenWeapon.filter(v => v > 0).length;
	}
	pack.open();
	flush();
	const bag = layer.FindFirstChild("Backpack");
	const page = bag?.GetDescendants().find(d => /^Page\d+$/.test(d.Name) && shown(d, layer));
	const tiles = (page?.GetDescendants() ?? [])
		.filter(d => /^Tile\d+$/.test(d.Name) && d.IsA("GuiButton") && d.Selectable && shown(d, layer))
		.sort((a, b) => a.Parent.LayoutOrder - b.Parent.LayoutOrder || a.Position.X.Scale - b.Position.X.Scale);
	counts.push(`Bag ${tiles.length}`);
	if (tiles.length <= BAG_COLS) bad.push(`Bag: ${tiles.length} itens, sem uma segunda fileira curta`);
	bad.push(...gridIssues("Bag", tiles, BAG_COLS));
	const bagTabs =
		findIn(bag, "Tabs")
			?.GetChildren()
			.filter(c => /^Tab\d+$/.test(c.Name)) ?? [];
	bagTabs.sort((a, b) => Number(a.Name.slice(3)) - Number(b.Name.slice(3)));
	counts.push(`abas do Bag ${bagTabs.length}`);
	bad.push(...gridIssues("abas do Bag", bagTabs, bagTabs.length));
	pack.close();
	flush();
	ctx.save.invenWeapon = weaponsBefore;
	// the shop: the cards' Buy buttons (3 to a row) and the tab bar over them. With coins for every pack, the plain
	// grid; the sparse case (a card you cannot afford: its Buy is disabled, and the pad skips it) is checked below
	ctx.phase = "shop";
	const moneyBefore = ctx.save.money;
	ctx.save.money = 99999;
	const closeShop = showShop(ctx, noop, noop);
	flush();
	const shop = layer.FindFirstChild("Shop");
	const buys = (findIn(shop, "Content")?.GetChildren() ?? [])
		.filter(c => /^Pack\d+$/.test(c.Name))
		.sort((a, b) => Number(a.Name.slice(4)) - Number(b.Name.slice(4)))
		.map(c => findIn(c, "Buy"));
	const rail = (findIn(shop, "Tabs")?.GetChildren() ?? [])
		.filter(c => /^Tab\d+$/.test(c.Name))
		.sort((a, b) => Number(a.Name.slice(3)) - Number(b.Name.slice(3)));
	counts.push(`loja ${buys.length}`, `abas da loja ${rail.length}`);
	bad.push(...gridIssues("loja", buys, 3), ...gridIssues("abas da loja", rail, rail.length));
	closeShop();
	flush();
	ctx.save.money = moneyBefore;
	// Settings: the tab bar is one row, Left / Right never drop into the page or the title strip
	ctx.phase = "settings";
	const closeSettings = showSettings(ctx, noop, noop);
	flush();
	const tabs = (findIn(layer.FindFirstChild("Settings"), "Tabs")?.GetChildren() ?? []).filter(c =>
		/^Tab\d+$/.test(c.Name),
	);
	tabs.sort((a, b) => Number(a.Name.slice(3)) - Number(b.Name.slice(3)));
	counts.push(`abas da Settings ${tabs.length}`);
	bad.push(...gridIssues("abas da Settings", tabs, tabs.length));
	closeSettings();
	flush();
	// the wardrobe's tiles (3 to a row) on the page that shows
	ctx.phase = "shop";
	const closeWardrobe = showWardrobe(ctx, { onBack: noop, onEquip: noop, onUnequip: noop });
	flush();
	const worn = (layer.FindFirstChild("Wardrobe")?.GetDescendants() ?? [])
		.filter(d => /^Tile\d+$/.test(d.Name) && d.IsA("GuiButton") && shown(d, layer))
		.sort((a, b) => Number(a.Name.slice(4)) - Number(b.Name.slice(4)));
	counts.push(`guarda-roupa ${worn.length}`);
	bad.push(...gridIssues("guarda-roupa", worn, 3));
	closeWardrobe?.();
	layer.FindFirstChild("Wardrobe")?.Destroy();
	flush();
	check(
		"o direcional anda nas grades uma celula por vez: Bag (fileira curta), abas do Bag, loja, abas da loja, abas da Settings, guarda-roupa",
		bad.length === 0 && tiles.length > BAG_COLS && buys.length > 3 && rail.length > 1 && tabs.length > 1,
		bad.length > 0 ? bad.slice(0, 6).join("; ") : counts.join(", "),
	);
	GuiService.SelectedObject = undefined;

	// MON-06: a pack you cannot afford has its Buy disabled (it says how many coins are missing), so the pad skips it:
	// every link of the shop's grid lands on a card it CAN buy, left / right stay in the row, up / down reach the
	// nearest row with one, and a disabled card has no link at all -- the owner's 20 coins, the Medic Bag at 30
	{
		ctx.phase = "shop";
		const before = ctx.save.money;
		ctx.save.money = 20;
		const close = showShop(ctx, noop, noop);
		flush();
		const cards = (findIn(layer.FindFirstChild("Shop"), "Content")?.GetChildren() ?? [])
			.filter(c => /^Pack\d+$/.test(c.Name))
			.sort((a, b) => Number(a.Name.slice(4)) - Number(b.Name.slice(4)));
		const cells = cards.map(c => findIn(c, "Buy"));
		const stops = cells.filter(b => b.Selectable === true);
		const off = cells.filter(b => b.Selectable !== true);
		const issues = [];
		for (const b of off) {
			for (const k of ["NextSelectionLeft", "NextSelectionRight", "NextSelectionUp", "NextSelectionDown"]) {
				if (b[k] !== undefined) issues.push(`${b.Parent.Name}: desabilitado com ${k}`);
			}
		}
		for (const b of stops) {
			const i = cells.indexOf(b);
			const row = Math.floor(i / 3);
			for (const k of ["NextSelectionLeft", "NextSelectionRight", "NextSelectionUp", "NextSelectionDown"]) {
				const t = b[k];
				if (t === undefined) continue;
				if (!stops.includes(t)) issues.push(`${b.Parent.Name} ${k} -> fora das paradas`);
				const tr = Math.floor(cells.indexOf(t) / 3);
				if ((k === "NextSelectionLeft" || k === "NextSelectionRight") && tr !== row)
					issues.push(`${b.Parent.Name} ${k} sai da fileira`);
			}
		}
		// Pantry Crate (1) -> Right skips the Medic Bag (2): the row has nothing more to buy; Down from the Medic Bag's
		// column lands on the Electronics Box (5)
		const pantry = cells[1];
		const medic = cells[2];
		check(
			"loja com 20 moedas: o Medic Bag (30) fica fora do caminho do controle e os links so pousam no que da para comprar",
			medic?.Selectable === false &&
				issues.length === 0 &&
				pantry?.NextSelectionRight === undefined &&
				pantry?.NextSelectionDown === cells[4] &&
				cells[5]?.NextSelectionUp === pantry,
			issues.slice(0, 4).join("; ") || `${stops.length} paradas, ${off.length} fora`,
		);
		close();
		flush();
		ctx.save.money = before;
		GuiService.SelectedObject = undefined;
	}
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

	const close = showPause(ctx, 0, { onResume: noop, onHome: noop, onShop: noop, onSettings: noop });
	flush();
	tap(pad("ButtonStart"));
	const startCloses = input.pausePressed;
	input.beginFrame();
	close();
	flush();
	check("Menu da partida pelo controle: Start (que o abriu) chega ao jogo, que o fecha", startCloses === true);
	// SAV-01: saving is automatic -- the Menu the pad walks through has no Save row
	{
		const c = showPause(ctx, 0, { onResume: noop, onHome: noop, onShop: noop, onSettings: noop });
		flush();
		const menu = layer.FindFirstChild("Menu");
		const rows = menu.GetDescendants().filter(d => d.ClassName === "TextButton" && /^Btn\d$/.test(d.Name));
		const labels = rows.map(b => b.FindFirstChild("Label")?.Text ?? b.Text);
		const saves = menu
			.GetDescendants()
			.filter(d => (d.ClassName === "TextLabel" || d.ClassName === "TextButton") && d.Text === "Save");
		c();
		flush();
		check(
			"SAV-01: o Menu da partida tem 4 linhas (Back to game, Shop, Settings, Home) e nenhum Save",
			labels.join(" | ") === "Back to game | Shop | Settings | Home" && saves.length === 0,
			labels.join(" | "),
		);
	}
	// the key on the Menu's title strip is the one that opens it on THIS device, as the HUD's Menu plate says
	// (SCHEMES): P on a keyboard, Start on a pad, none on a touch screen (its MENU is a button, not a key)
	const keyOnMenu = () => {
		const c = showPause(ctx, 0, { onResume: noop, onHome: noop, onShop: noop, onSettings: noop });
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
	GuiService.SelectedObject = undefined;
	lastInput.type = Enum.UserInputType.MouseMovement;
	input.beginFrame();
	flush();
}

// ================================================================ 2b. B / Backspace: back out of the screen on top

console.log(
	"\n2b) NAV-B: o B do controle e o Backspace fecham a tela de cima -- nunca o menu do lobby, nunca uma escolha, nada na partida\n",
);

{
	const B = () => pad("ButtonB");
	const BACKSPACE = () => kbd("Backspace");
	/** a screen opened as main.client.ts opens it, then backed out of with `key` instead of its own control */
	const backCycle = (sc, key, gpe) => {
		ctx.phase = sc.phase;
		let closedBy = 0;
		let cleanup;
		const done = () => {
			closedBy++;
			cleanup?.();
			cleanup = undefined;
		};
		const ret = sc.open(done);
		if (typeof ret === "function") cleanup = ret;
		flush();
		const opened = layer.FindFirstChild(sc.root) !== undefined;
		tap(key, gpe);
		const after = layer.FindFirstChild(sc.root);
		const gone = sc.isOpen !== undefined ? !sc.isOpen() && after?.Visible === false : after === undefined;
		cleanup?.();
		flush();
		return { opened, gone, handled: sc.selfClosing === true || closedBy === 1 };
	};
	const bad = [];
	const keys = [
		// with a control selected the engine's GUI navigation takes the press too (gameProcessedEvent)
		["B", B(), true, Enum.UserInputType.Gamepad1],
		["B sem selecao", B(), false, Enum.UserInputType.Gamepad1],
		["Backspace", BACKSPACE(), false, Enum.UserInputType.Keyboard],
	];
	for (const sc of SCREENS) {
		for (const [label, key, gpe, device] of keys) {
			if (sc.needsLobby) openLobby(sc.status);
			lastInput.type = device;
			const r = backCycle(sc, key, gpe);
			if (!(r.opened && r.gone && r.handled)) bad.push(`${sc.name} / ${label}: ${JSON.stringify(r)}`);
			if (sc.needsLobby) {
				if (layer.FindFirstChild("Lobby") === undefined)
					bad.push(`${sc.name} / ${label}: o lobby fechou junto`);
				closeLobby();
			}
			GuiService.SelectedObject = undefined;
			lastInput.type = Enum.UserInputType.MouseMovement;
			input.beginFrame();
			flush();
		}
	}
	check(
		"B (com e sem selecao) e Backspace fecham cada tela pela mesma via do X / Back / Got it / Back to game dela",
		bad.length === 0,
		bad.join("; ") || `${SCREENS.length} telas x 3 teclas`,
	);

	// a help popup over a window: B closes the popup only, the pad lands back on the "?", and the next B closes the window
	{
		ctx.phase = "lobby";
		lastInput.type = Enum.UserInputType.Gamepad1;
		let backs = 0;
		const close = showSettings(ctx, () => backs++, noop);
		flush();
		const root = layer.FindFirstChild("Settings");
		const help = root?.GetDescendants().find(d => d.Name === "Help" && d.IsA("GuiButton"));
		GuiService.SelectedObject = help;
		help?.Activated.Fire();
		flush();
		const up = layer.FindFirstChild("PopupOverlay") !== undefined;
		tap(B(), true);
		const popupGone = layer.FindFirstChild("PopupOverlay") === undefined;
		const windowStays = layer.FindFirstChild("Settings") !== undefined && backs === 0;
		const onHelp = GuiService.SelectedObject === help;
		tap(B(), true);
		const windowClosed = backs === 1;
		close();
		GuiService.SelectedObject = undefined;
		lastInput.type = Enum.UserInputType.MouseMovement;
		flush();
		check(
			'um popup de ajuda sobre a Settings: o B fecha so o popup, o controle volta ao "?", e o B seguinte fecha a janela',
			up && popupGone && windowStays && onHelp && windowClosed,
			JSON.stringify({ up, popupGone, windowStays, onHelp, windowClosed }),
		);
	}

	// a question is dismissed, never answered: B on "watch the tutorial?" neither declines it nor enters the city
	{
		ctx.phase = "lobby";
		const save = ctx.save;
		const tutorialDone = save.tutorialDone;
		const firstInstall = save.firstInstall;
		save.tutorialDone = false;
		save.firstInstall = true;
		let played = 0;
		const h = showLobby(ctx, { ...lobbyHandlers, onPlay: () => played++ }, lobbyStatus, "survivor");
		flush();
		findIn(layer.FindFirstChild("Lobby"), "Enter")?.Activated.Fire();
		flush();
		const asked = layer.FindFirstChild("PopupOverlay") !== undefined;
		lastInput.type = Enum.UserInputType.Gamepad1;
		tap(B(), true);
		const dismissed = layer.FindFirstChild("PopupOverlay") === undefined;
		const unanswered = save.tutorialDone === false && save.firstInstall === true && played === 0;
		const survivorStays = h.page() === "survivor";
		h.close();
		save.tutorialDone = tutorialDone;
		save.firstInstall = firstInstall;
		GuiService.SelectedObject = undefined;
		lastInput.type = Enum.UserInputType.MouseMovement;
		flush();
		check(
			'"watch the tutorial?" + B: a pergunta sai sem resposta (nem "No", nem a cidade), e a tela Survivor fica',
			asked && dismissed && unanswered && survivorStays,
			JSON.stringify({ asked, dismissed, unanswered, survivorStays }),
		);
	}

	// P0-1 / P0-2 (client/net/matchClient.ts): the fresh-town card and the Play solo question are questions like the
	// tutorial's -- the pad lands on the answer that moves (New town, Play solo), B closes them UNANSWERED (nothing is
	// sent), each answer sends exactly its request, the card waits for a free lobby, and nothing is left behind
	{
		const Match = require(join(SRC, "client/net/matchClient.ts"));
		const sent = [];
		const remote = { OnClientEvent: new Signal(), FireServer: req => sent.push(JSON.stringify(req)) };
		const beats = connCount();
		Match.startMatchClient(ctx);
		const conn = Match.useMatchRemote(remote);
		const popupUp = () => layer.FindFirstChild("PopupOverlay") !== undefined;
		const focused = () => GuiService.SelectedObject?.Text;
		const beat = () => RunService.Heartbeat.Fire(1 / 60);
		ctx.phase = "lobby";
		lastInput.type = Enum.UserInputType.Gamepad1;

		Match.askPlaySolo();
		flush();
		const q1 = popupUp() && focused() === "Play solo";
		tap(B(), true);
		flush();
		const q1Dismissed = !popupUp() && sent.length === 0;
		Match.askPlaySolo();
		flush();
		GuiService.SelectedObject?.Activated.Fire();
		flush();
		const q1Answered = !popupUp() && sent.join() === '{"k":"solo"}';
		check(
			"Play solo: a pergunta com o controle no Play solo; B fecha sem mandar nada; A manda so {k: solo}",
			q1 && q1Dismissed && q1Answered,
			JSON.stringify({ q1, q1Dismissed, q1Answered, sent }),
		);

		remote.OnClientEvent.Fire({ k: "refused", why: "studio" });
		flush();
		const studio = popupUp() && focused() === "Close";
		tap(B(), true);
		flush();
		check("no Studio o servidor recusa e a tela explica (Close em foco), e o B fecha", studio && !popupUp());

		sent.length = 0;
		ctx.phase = "lobby";
		Match.askPlaySolo();
		flush();
		remote.OnClientEvent.Fire({ k: "offer", worldDay: 23, bestDay: 1 });
		beat();
		flush();
		const onlyOne = layer.GetChildren().filter(c => c.Name === "PopupOverlay").length === 1;
		tap(B(), true);
		flush();
		beat();
		flush();
		const card = layer.FindFirstChild("PopupOverlay");
		const title = card
			?.GetDescendants()
			.some(d => d.ClassName === "TextLabel" && String(d.Text).includes("Day 23"));
		const cardFocus = focused() === "New town";
		tap(B(), true);
		flush();
		beat();
		flush();
		const unanswered = !popupUp() && sent.length === 0;
		check(
			'a oferta espera o lobby livre (nada sobre outra pergunta); "Town · Day 23" com o foco no New town; B fecha sem resposta e ela nao volta',
			onlyOne && title && cardFocus && unanswered,
			JSON.stringify({ onlyOne, title, cardFocus, unanswered }),
		);

		// LOW 3 (the review of f25727a): an offer that did not get its free lobby is dropped for good -- a run that
		// started (the player chose to play here), or the server's lapse (600 s) -- never a card popping up later
		ctx.phase = "playing";
		remote.OnClientEvent.Fire({ k: "offer", worldDay: 23, bestDay: 1 });
		beat();
		flush();
		ctx.phase = "lobby";
		beat();
		flush();
		const droppedInRun = !popupUp();
		Match.askPlaySolo();
		flush();
		remote.OnClientEvent.Fire({ k: "offer", worldDay: 23, bestDay: 1 });
		beat();
		flush();
		ui.setClock(ui.getClock() + 601);
		tap(B(), true);
		flush();
		beat();
		flush();
		const droppedLate = !popupUp() && sent.length === 0;
		check(
			"uma oferta que nao achou o lobby livre some de vez: uma partida comecou, ou passaram os 600 s do servidor (nenhum cartao depois)",
			droppedInRun && droppedLate,
			JSON.stringify({ droppedInRun, droppedLate }),
		);

		// H1: the kept body is in danger -- a question with its reason, Close in focus, B closes it
		remote.OnClientEvent.Fire({ k: "refused", why: "danger" });
		flush();
		const danger =
			popupUp() &&
			focused() === "Close" &&
			layer
				.FindFirstChild("PopupOverlay")
				?.GetDescendants()
				.some(d => d.ClassName === "TextLabel" && String(d.Text).includes("still in danger"));
		tap(B(), true);
		flush();
		check(
			"Play solo recusado com o corpo em perigo: a tela diz por que (Close em foco), e o B fecha",
			danger && !popupUp(),
		);

		remote.OnClientEvent.Fire({ k: "offer", worldDay: 23, bestDay: 1 });
		beat();
		flush();
		findIn(layer.FindFirstChild("PopupOverlay"), "PopupBtn0")?.Activated.Fire();
		flush();
		const stay = sent.join() === '{"k":"offer","yes":false}';
		remote.OnClientEvent.Fire({ k: "offer", worldDay: 23, bestDay: 1 });
		beat();
		flush();
		GuiService.SelectedObject?.Activated.Fire();
		flush();
		const yes = sent[sent.length - 1] === '{"k":"offer","yes":true}';
		remote.OnClientEvent.Fire({ k: "trip", s: "failed", why: "teleport" });
		flush();
		const retryFocus = focused() === "Try again";
		GuiService.SelectedObject?.Activated.Fire();
		flush();
		const retried = sent[sent.length - 1] === '{"k":"offer","yes":true}' && !popupUp();
		check(
			"Stay manda {yes: false}; New town manda {yes: true}; uma falha abre Try again em foco, que repete o mesmo pedido",
			stay && yes && retryFocus && retried,
			JSON.stringify({ stay, yes, retryFocus, retried, sent }),
		);
		conn.Disconnect();
		ctx.phase = "lobby";
		GuiService.SelectedObject = undefined;
		lastInput.type = Enum.UserInputType.MouseMovement;
		flush();
		check(
			"...e nada fica para tras: nenhum popup, nenhuma conexao (a espera do lobby so existe enquanto a oferta espera)",
			!popupUp() && connCount() === beats,
			`${connCount() - beats} conexoes`,
		);
		// a refusal that needs no answer is a toast (it expires on its own), never a question over the lobby
		Match.onMatchNotice({ k: "refused", why: "rate" });
		flush();
		check("uma recusa sem pergunta (espere um pouco) e um toast, nunca um popup", !popupUp());
	}

	// what B must never close: the lobby's own menu, the end-of-run choice, the daybreak wait, the HUD's scoreboard
	{
		ctx.phase = "lobby";
		lastInput.type = Enum.UserInputType.Gamepad1;
		openLobby();
		GuiService.SelectedObject = findIn(layer.FindFirstChild("Lobby"), "Start");
		tap(B(), true);
		tap(BACKSPACE(), false);
		const lobbyStays = layer.FindFirstChild("Lobby") !== undefined && lobby.page() === "menu";
		closeLobby();

		ctx.phase = "dead";
		const summary = { days: 3, bestDay: 12, level: 7, kills: 20, bosses: 0, first: false };
		let chose = 0;
		const handlers = { onRebirth: () => chose++, onNewRun: () => chose++, onHome: () => chose++ };
		const closeOver = showRunSummary(ctx, summary, handlers);
		flush();
		tap(B(), true);
		tap(BACKSPACE(), false);
		const overStays = layer.FindFirstChild("RunOver") !== undefined && chose === 0;
		closeOver();
		const wait = showDaybreakWait(ctx, summary, handlers);
		flush();
		tap(B(), true);
		tap(BACKSPACE(), false);
		const waitStays = layer.FindFirstChild("RunOver") !== undefined && chose === 0;
		wait.close();
		flush();

		ctx.phase = "playing";
		const h = new Hud(ctx);
		h.mount();
		flush();
		h.toggleScoreboard();
		flush();
		const boardUp = h.scoreboard()?.isOpen() === true;
		tap(B(), false);
		const boardStays = h.scoreboard()?.isOpen() === true;
		h.unmount();
		ctx.phase = "lobby";
		GuiService.SelectedObject = undefined;
		lastInput.type = Enum.UserInputType.MouseMovement;
		flush();
		check(
			"...o B e o Backspace nao fecham o menu do lobby, nem a escolha do fim de partida, nem a espera do amanhecer, nem o placar da HUD",
			lobbyStays && overStays && waitStays && boardUp && boardStays,
			JSON.stringify({ lobbyStays, overStays, waitStays, boardUp, boardStays }),
		);
	}

	// in a run with no screen up nothing is eaten: the keyboard's B is still the Backpack, the pad's B does nothing
	{
		ctx.phase = "playing";
		input.beginFrame();
		tap(kbd("B"));
		const bag = input.backpackPressed === true;
		input.beginFrame();
		lastInput.type = Enum.UserInputType.Gamepad1;
		tap(B(), false);
		const quiet =
			!input.backpackPressed &&
			!input.pausePressed &&
			!input.attackPressed &&
			!input.actionPressed &&
			!input.reloadPressed;
		// Backspace typed into a text box (gameProcessedEvent) is the text box's
		let backs = 0;
		ctx.phase = "lobby";
		const close = showSettings(ctx, () => backs++, noop);
		flush();
		tap(BACKSPACE(), true);
		const typing = backs === 0 && layer.FindFirstChild("Settings") !== undefined;
		close();
		input.beginFrame();
		lastInput.type = Enum.UserInputType.MouseMovement;
		flush();
		check(
			"...na partida sem tela o B do teclado continua sendo o Bag e o B do controle nao faz nada; Backspace digitado numa caixa de texto e da caixa",
			bag && quiet && typing,
			JSON.stringify({ bag, quiet, typing }),
		);
	}
}

// ================================================================ 2c. the death screen with a pad (UI-13)

console.log(
	"\n2c) a tela de morte pelo controle: o foco na acao que funciona, New game pergunta com o foco no Cancel, nada sobra\n",
);

{
	const { rebirthPrice } = require(join(SRC, "shared/data/shop.ts"));
	const save = ctx.save;
	const money = save.money;
	const deaths = save.deathCount;
	const summary = { days: 3, bestDay: 12, level: 7, kills: 20, bosses: 0, first: false, record: false };
	const death = () => layer.FindFirstChild("RunOver");
	const sel = () => GuiService.SelectedObject?.Name;
	/** a death screen as main.client.ts opens it; `calls` counts what reached the handlers */
	const openDeath = (wait, coins, withNew = true, standing = 1) => {
		save.money = coins;
		save.deathCount = 0;
		ctx.phase = "dead";
		const calls = { rebirth: 0, newRun: 0, home: 0 };
		const handlers = {
			onRebirth: () => calls.rebirth++,
			onNewRun: withNew ? () => calls.newRun++ : undefined,
			onHome: () => calls.home++,
		};
		let close;
		if (wait) {
			const w = showDaybreakWait(ctx, summary, handlers, !withNew, () => standing);
			w.setRemaining(120, true);
			close = () => w.close();
		} else close = showRunSummary(ctx, summary, handlers);
		flush();
		return { calls, close: () => (close(), flush()) };
	};
	const price = rebirthPrice(0);
	lastInput.type = Enum.UserInputType.Gamepad1;
	// where the pad lands: the action that works
	const landings = [];
	for (const [label, wait, coins, withNew, want] of [
		["espera, com moedas", true, price, true, "Rebirth"],
		["espera, sem moedas (esperar nao pede botao)", true, 0, true, "Home"],
		["vida nova esperando, sem moedas", true, 0, false, "Home"],
		["fim, com moedas", false, price, true, "Rebirth"],
		["fim, sem moedas (o unico caminho)", false, 0, true, "NewGame"],
	]) {
		const s = openDeath(wait, coins, withNew);
		if (sel() !== want) landings.push(`${label}: ${sel() ?? "nada"} (esperado ${want})`);
		s.close();
		GuiService.SelectedObject = undefined;
	}
	check(
		"o foco do controle cai na acao que funciona: Rebirth quando da para pagar; senao Home numa espera, New game no fim",
		landings.length === 0,
		landings.join("; "),
	);

	// with the pad on the screen: A / X / Y / RT / RB stay the menu's; Start and LB still reach the game, as from every
	// menu (main.client.ts ignores both while the survivor is dead: the Menu opens only while playing, the Bag too)
	{
		const s = openDeath(true, price);
		const held = [];
		for (const k of ["ButtonA", "ButtonX", "ButtonY", "ButtonR2", "ButtonR1"]) {
			input.beginFrame();
			tap(pad(k));
			if (input.attackPressed || input.actionPressed || input.reloadPressed) held.push(k);
		}
		input.attackHeld = false;
		input.beginFrame();
		tap(pad("ButtonStart"));
		const start = input.pausePressed === true;
		input.beginFrame();
		tap(pad("ButtonL1"));
		const lb = input.backpackPressed === true;
		input.beginFrame();
		const main = readFileSync(join(SRC, "client/main.client.ts"), "utf8");
		const ignoredDead =
			/if \(input\.pausePressed && ctx\.phase === "playing"\)/.test(main) &&
			/function toggleBackpack\(\): void \{\n\tif \(ctx\.phase !== "playing"/.test(main);
		s.close();
		check(
			"...com o foco nela, A / X / Y / RT / RB ficam com a tela; Start e LB chegam ao jogo (como de todo menu), que os ignora com o sobrevivente morto",
			held.length === 0 && start && lb && s.calls.rebirth === 0 && ignoredDead,
			JSON.stringify({ held, start, lb, ignoredDead }),
		);
	}

	// New game asks first: the pad lands on Cancel, B dismisses the question unanswered (the screen stays), and only the
	// confirmation starts the new life
	{
		const s = openDeath(true, 0);
		GuiService.SelectedObject = findIn(death(), "NewGame");
		findIn(death(), "NewGame").Activated.Fire();
		flush();
		const pop = layer.FindFirstChild("PopupOverlay");
		const onCancel = sel() === "PopupBtn0" && findIn(pop, "PopupBtn0")?.Text === "Cancel";
		tap(pad("ButtonB"), true);
		const dismissed = layer.FindFirstChild("PopupOverlay") === undefined && death() !== undefined;
		const unanswered = s.calls.newRun === 0;
		findIn(death(), "NewGame").Activated.Fire();
		flush();
		findIn(layer.FindFirstChild("PopupOverlay"), "PopupBtn1").Activated.Fire();
		flush();
		const confirmed = s.calls.newRun === 1;
		s.close();
		check(
			"New game pelo controle: pergunta com o foco no Cancel; B tira a pergunta sem responder e a tela fica; so a confirmacao chama o handler",
			pop !== undefined && onCancel && dismissed && unanswered && confirmed,
			JSON.stringify({ asked: pop !== undefined, onCancel, dismissed, unanswered, confirmed }),
		);
	}

	// five open / close cycles of each build, the question opened in between: no Instance and no connection left
	{
		const conns = connCount();
		const r = measure(() => {
			for (let i = 0; i < 5; i++) {
				for (const wait of [true, false]) {
					const s = openDeath(wait, i % 2 === 0 ? price : 0, true, i % 3);
					findIn(death(), "NewGame").Activated.Fire();
					flush();
					s.close();
				}
			}
		});
		check(
			"5 ciclos de cada tela de morte (com a pergunta aberta ao fechar) -- nenhuma Instance e nenhuma conexao sobrando",
			r.created === r.destroyed && connCount() === conns && layer.FindFirstChild("PopupOverlay") === undefined,
			`${r.created} criadas, ${r.destroyed} destruidas, ${connCount() - conns} conexoes a mais`,
		);
	}
	GuiService.SelectedObject = undefined;
	lastInput.type = Enum.UserInputType.MouseMovement;
	input.beginFrame();
	save.money = money;
	save.deathCount = deaths;
	ctx.phase = "lobby";
	flush();
}

// ================================================================ 2d. the dawn card and the death's lesson with a pad

console.log(
	"\n2d) o cartao do amanhecer (BEM-04) e a licao da tela de morte (UI-13) pelo controle: nenhum toma o foco nem uma tecla\n",
);

{
	lastInput.type = Enum.UserInputType.Gamepad1;
	ctx.phase = "playing";
	const hud = new Hud(ctx);
	hud.mount();
	GuiService.SelectedObject = undefined;
	/** what each of the pad's buttons does to the frame's input, with the card up or not */
	const presses = () => {
		const out = {};
		for (const k of [
			"ButtonA",
			"ButtonX",
			"ButtonY",
			"ButtonB",
			"ButtonR2",
			"ButtonR1",
			"ButtonL1",
			"ButtonStart",
		]) {
			input.beginFrame();
			tap(pad(k));
			out[k] = [
				input.attackPressed,
				input.actionPressed,
				input.reloadPressed,
				input.backpackPressed,
				input.pausePressed,
			].join(",");
			input.attackHeld = false;
		}
		input.beginFrame();
		return JSON.stringify(out);
	};
	const without = presses();
	hud.showDawnReport({ zombies: 4, damage: 30, items: 2 });
	// the server's break line on it too (protocol note 24), so every text the card can hold is checked below
	hud.dawnBreakLine();
	flush();
	const card = findIn(ctx.hudLayer, "DawnCard");
	const focusAfterShow = GuiService.SelectedObject;
	const withCard = presses();
	const stillUp = card?.Visible === true;
	const selectable = (card?.GetDescendants() ?? []).filter(d => d.IsA("GuiObject") && d.Selectable === true);
	check(
		"o cartao abre sem tomar o foco do controle, nada nele e Selectable, e cada botao do controle faz o mesmo que sem ele (B incluido: nao e dele)",
		card !== undefined &&
			focusAfterShow === undefined &&
			selectable.length === 0 &&
			withCard === without &&
			stillUp,
		JSON.stringify({
			focus: focusAfterShow?.Name,
			selectable: selectable.map(d => d.Name),
			same: withCard === without,
		}),
	);
	const texts = (card?.GetDescendants() ?? [])
		.filter(d => (d.ClassName === "TextLabel" || d.ClassName === "TextButton") && d.Text !== "")
		.map(d => d.Text);
	const numbers = /^[0-9,]+$/;
	const outside = texts.filter(t => !numbers.test(t) && !lang.LANG_TABLE.includes(t));
	check(
		"todo texto do cartao e uma entrada da LANG_TABLE (ou um numero)",
		texts.length >= 7 && outside.length === 0,
		outside.join(" | "),
	);
	hud.unmount();
	flush();

	// the death screen's lesson: two lines of text, never a stop of the pad -- the focus lands where it always did
	const { rebirthPrice } = require(join(SRC, "shared/data/shop.ts"));
	const save = ctx.save;
	const money = save.money;
	save.money = rebirthPrice(save.deathCount);
	ctx.phase = "dead";
	const summary = { days: 3, bestDay: 12, level: 7, kills: 20, bosses: 0, first: false, record: false };
	const w = showDaybreakWait(
		ctx,
		summary,
		{ onRebirth: () => {}, onNewRun: () => {}, onHome: () => {}, cause: () => ({ kind: 2, night: true }) },
		false,
		() => 1,
	);
	w.setRemaining(120, true);
	flush();
	const death = layer.FindFirstChild("RunOver");
	const lesson = ["Cause", "Tip"].map(n => findIn(death, n));
	check(
		'a licao ("Starved." e a dica) e texto, nunca uma parada do controle: o foco cai no Rebirth como sempre',
		lesson.every(l => l !== undefined && l.ClassName === "TextLabel") &&
			lesson[0].Text === "Starved." &&
			lesson[1].Text.startsWith("Tip: ") &&
			GuiService.SelectedObject?.Name === "Rebirth",
		`${lesson.map(l => l?.Text).join(" / ")}; foco ${GuiService.SelectedObject?.Name}`,
	);
	w.close();
	flush();
	GuiService.SelectedObject = undefined;
	save.money = money;
	lastInput.type = Enum.UserInputType.MouseMovement;
	input.beginFrame();
	ctx.phase = "lobby";
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
		sub === `${done} / ${visible.length}` && done === 3 && visible.length === 18,
		sub,
	);
	// a pad player opens it: the focus lands on the first row, so the D-pad can walk (and scroll) the list
	lastInput.type = Enum.UserInputType.Gamepad1;
	nav(2).Activated.Fire();
	flush();
	const dialog = layer.FindFirstChild("Achievements");
	const rows = visible.map(a => findIn(dialog, `Ach${a.id}`));
	const shownIn = (row, name) => {
		const g = findIn(row, name);
		return g !== undefined && shown(g, dialog);
	};
	// UI-14: each row -- its "cur / goal" on the meter while it is being earned, the medal and "Unlocked" once done
	const wrong = visible.filter((a, i) => {
		const cur = Math.min(save.achievements[a.id] ?? 0, a.max);
		const v = findIn(rows[i], "Value")?.Text;
		const done = cur >= a.max;
		return (
			v !== `${cur.toLocaleString("en-US")} / ${a.max.toLocaleString("en-US")}` ||
			shownIn(rows[i], "Medal") !== done ||
			shownIn(rows[i], "Unlocked") !== done ||
			shownIn(rows[i], "Meter") === done
		);
	});
	check(
		"a janela lista as 18 visiveis, cada uma com 'atual / meta' do save (sem passar da meta); a medalha e 'Unlocked' so nas feitas, o medidor nas outras",
		rows.every(r => r !== undefined) &&
			wrong.length === 0 &&
			!ACHIEVEMENTS.some(a => a.hidden && findIn(dialog, `Ach${a.id}`)),
		wrong.map(a => `${a.title}: ${findIn(rows[visible.indexOf(a)], "Value")?.Text}`).join("; "),
	);
	// each row has its picture (achievements.ts `icon`) and says what earns it (`howTo`, a lang.ts entry)
	const bare = visible.filter((a, i) => {
		const icon = findIn(rows[i], "Icon");
		const how = findIn(rows[i], "HowTo")?.Text;
		return icon?.GetAttribute("Icon") !== a.icon || how !== a.howTo || a.howTo === "";
	});
	check(
		"cada conquista tem o seu desenho e a linha do que a ganha",
		bare.length === 0,
		bare.map(a => a.title).join(", ") || `${visible.length} com desenho e descricao`,
	);
	// the order: in progress (closest to done first; a tie by id), unlocked, not started -- under a header each
	const listed = findIn(dialog, "List")
		.GetDescendants()
		.filter(d => /^Ach\d+$/.test(d.Name))
		.sort((a, b) => a.LayoutOrder - b.LayoutOrder)
		.map(d => Number(d.Name.slice(3)));
	const group = a => {
		const cur = Math.min(save.achievements[a.id] ?? 0, a.max);
		return cur >= a.max ? 1 : cur > 0 ? 0 : 2;
	};
	const ratio = a => Math.min(save.achievements[a.id] ?? 0, a.max) / a.max;
	const expected = [...visible]
		.sort((a, b) => group(a) - group(b) || (group(a) === 0 ? ratio(b) - ratio(a) : 0) || a.id - b.id)
		.map(a => a.id);
	check(
		"a ordem: em progresso (o mais perto de acabar primeiro, empate pelo id), depois as desbloqueadas, depois as nao comecadas",
		JSON.stringify(listed) === JSON.stringify(expected),
		listed.join(","),
	);
	// the pad: the focus starts on a row; the X goes down into the list; every row is a stop chained to the next, and
	// the one in focus shows the kit's focus ring (its outline in `ring`), never a hidden selection
	const sel = GuiService.SelectedObject;
	const first = findIn(dialog, `Ach${expected[0]}`);
	const closeBtn = findIn(dialog, "Close");
	const chained = expected.every((id, i) => {
		const r = findIn(dialog, `Ach${id}`);
		const down = i + 1 < expected.length ? findIn(dialog, `Ach${expected[i + 1]}`) : undefined;
		return r.Selectable === true && r.NextSelectionDown === down;
	});
	const ringColor = row => row.FindFirstChild("PlateBand")?.BackgroundColor3;
	const second = findIn(dialog, `Ach${expected[1]}`);
	GuiService.SelectedObject = second;
	flush();
	const ringOn = ringColor(second);
	GuiService.SelectedObject = first;
	flush();
	const ringOff = ringColor(second);
	check(
		"controle: o foco abre na primeira linha, o X desce para a lista, cada linha e uma parada encadeada, e a linha em foco mostra o anel de foco",
		sel === first &&
			closeBtn?.NextSelectionDown === first &&
			chained &&
			sameRgb(ringOn, THEME.ring) &&
			!sameRgb(ringOff, THEME.ring),
		`foco ${sel?.Name}, X->${closeBtn?.NextSelectionDown?.Name}, encadeadas ${chained}, anel ${ringOn?.ToHex?.()} / ${ringOff?.ToHex?.()}`,
	);
	GuiService.SelectedObject = undefined;
	lastInput.type = Enum.UserInputType.MouseMovement;
	findIn(dialog, "Close").Activated.Fire();
	flush();
	nav(3).Activated.Fire();
	flush();
	const records = layer.FindFirstChild("Records");
	// the window's own rows (client/ui/table.ts: a row is "Row<n>", its cells "Clabel" / "Cvalue"), against what
	// recordRows(save) says the save holds -- All time (Best day, Level, Zombies put down, Titles earned) and
	// This life (Life day, Nights survived in this life, Rebirths)
	const recRows = REC.recordRows(save);
	const shownRows = new Map(
		records
			.GetDescendants()
			.filter(d => /^Row\d+$/.test(d.Name))
			.map(r => [findIn(r, "Clabel")?.Text, findIn(r, "Cvalue")?.Text]),
	);
	const wrongRecs = recRows.filter(r => shownRows.get(r.label) !== r.value);
	check(
		"Records: o recorde, o dia desta vida, o nivel e os Rebirths sao os do save",
		// Map#size is a method under the Luau shims (see the LANG_COUNT comment above)
		wrongRecs.length === 0 && shownRows.size() === recRows.length,
		wrongRecs.map(r => `${r.label}: mostra "${shownRows.get(r.label)}", esperado "${r.value}"`).join("; ") ||
			[...shownRows].map(([l, v]) => `${l}=${v}`).join(", "),
	);
	findIn(records, "Close").Activated.Fire();
	flush();
	const lobbySub = findIn(nav(3), "Sub")?.Text;
	check("...e a chapa Records diz o mesmo recorde", lobbySub === "Best day 12", lobbySub);
	closeLobby();
	save.achievements.fill(0);

	// ---- the Shop (MON-03, MON-06): what a card says, and what the Earn coins page says -- from the save
	{
		const SHOP = require(join(SRC, "client/ui/shop.ts"));
		const { SHOP_PACKS, COSTUMES, ECONOMY } = require(join(SRC, "shared/data/shop.ts"));
		const packIndex = name => SHOP_PACKS.findIndex(p => p.name === name);
		const medic = packIndex("Medic Bag");
		const builders = packIndex("Builder's Basics");
		const pigeonPack = packIndex("Pet Pigeon");
		const pigeonCostume = COSTUMES.find(c => c.name === "Pigeon");
		const keep = {
			money: save.money,
			bought: [...save.packsBought],
			opened: [...save.packsOpened],
			costumes: [...save.costumes],
			bestDay: save.bestDay,
			day: save.day,
			bossKills: save.bossKills,
		};
		save.money = 20;
		save.packsBought[builders] = (save.packsOpened[builders] ?? 0) + 1;
		save.costumes[pigeonCostume.id] = 1;
		save.bestDay = 1;
		save.day = 1;
		save.bossKills = 0;
		ctx.phase = "shop";
		// the Shop funnel (docs/ANALYTICS.md; the server's side is test:analytics): opening the shop asks for ONE
		// `viewShop` (screen 0) per visit -- the tabs send nothing. The shim's task.spawn runs nothing; here what is
		// spawned is caught and run against a stand-in for the remote
		const spawned = [];
		const shopCalls = [];
		const realSpawn = globalThis.task.spawn;
		const realInvoke = saveClient.invokeShopAction;
		globalThis.task.spawn = (fn, ...a) => spawned.push(() => fn(...a));
		saveClient.invokeShopAction = req => {
			shopCalls.push(req);
			return { ok: false, reason: "network" };
		};
		const runSpawned = () => {
			for (const f of spawned.splice(0)) {
				try {
					f();
				} catch {
					// a spawned loop that waits (task.wait) is not simulated here
				}
			}
		};
		const views = screen => shopCalls.filter(q => q.kind === "viewShop" && q.screen === screen).length;
		const close = SHOP.showShop(ctx, noop, noop);
		flush();
		runSpawned();
		const root = layer.FindFirstChild("Shop");
		const card = i => findIn(findIn(root, "Content"), `Pack${SHOP_PACKS[i].id}`);
		const buyOf = i => findIn(card(i), "Buy");
		const allText = d =>
			d
				.GetDescendants()
				.filter(x => (x.ClassName === "TextLabel" || x.ClassName === "TextButton") && shown(x, layer))
				.map(x => String(x.Text))
				.join(" | ");
		// the note says where a pack goes, and when -- never "your next game" (a pack bought from the run's menu arrives
		// in the same run: the server opens it as soon as the survivor is in the city)
		const packsText = allText(findIn(root, "Packs"));
		check(
			"loja: a nota diz que o pacote vai para a mochila ao entrar na cidade (nunca 'next game')",
			/enter the city/.test(packsText) && !/next game/i.test(packsText),
			packsText.slice(0, 120),
		);
		// can't afford it: the Buy is disabled and says how many coins are missing, in the same button every card has
		const medicBuy = buyOf(medic);
		const needed = SHOP_PACKS[medic].price - 20;
		check(
			"loja: sem moedas para o Medic Bag, o Buy desabilita e diz quanto falta ('10 more needed'); nada de contorno",
			medicBuy.GetAttribute("Disabled") === true &&
				medicBuy.Text === `${needed} more needed` &&
				medicBuy.GetAttribute("Variant") === buyOf(0).GetAttribute("Variant") &&
				buyOf(0).GetAttribute("Disabled") === false,
			`${medicBuy.Text}, ${medicBuy.GetAttribute("Variant")}`,
		);
		// a refusal for coins says how many are missing, as the Rebirth does
		check(
			"loja: a recusa por moedas diz quanto falta: 'Not enough coins: 10 more needed'",
			SHOP.fundsErrorText("funds", 10, 0) === "Not enough coins: 10 more needed" &&
				SHOP.fundsErrorText("funds", 0, 0) === "Not enough coins" &&
				SHOP.fundsErrorText("rate", 10, 0) === "Please wait a moment",
			SHOP.fundsErrorText("funds", 10, 0),
		);
		// a pack bought and not delivered yet says so -- "Pending", never "owned"
		const pending = findIn(card(builders), "Pending");
		check(
			"loja: um pacote comprado e ainda nao entregue diz 'Pending ×1' (nunca 'owned')",
			pending !== undefined && shown(pending, layer) && findIn(pending, "Text")?.Text === "Pending ×1",
			findIn(pending, "Text")?.Text,
		);
		// the pet of a pet pack is already yours: the card does not sell it again
		check(
			"loja: o Pet Pigeon de quem ja tem o pombo para sempre diz 'Owned' e nao vende",
			buyOf(pigeonPack).Text === "Owned" && buyOf(pigeonPack).GetAttribute("Disabled") === true,
			buyOf(pigeonPack).Text,
		);
		// what is inside: the Bag's icons, one tile per item, with the count; a pet pack draws the pet itself
		const iconsOk = SHOP_PACKS.every((p, i) => {
			const c = card(i);
			if (p.name.startsWith("Pet ")) return findIn(c, "Pet") !== undefined && /New game/.test(allText(c));
			return p.items.every(
				(it, k) =>
					findIn(findIn(c, `Item${k}`), "Icon")?.GetAttribute("Icon") !== "" &&
					findIn(findIn(c, `Item${k}`), "Legend")?.Text === `×${it.count}`,
			);
		});
		check("loja: cada cartao mostra os icones do Bag com a contagem, e o pet desenhado no pacote de pet", iconsOk);
		// Earn coins: the four sources the server pays, each with its coin chip and the player's progress
		const tabs = findIn(root, "Tabs");
		const r = measure(() => {
			tabs.FindFirstChild("Tab1").Activated.Fire();
			flush();
			tabs.FindFirstChild("Tab0").Activated.Fire();
			flush();
			tabs.FindFirstChild("Tab1").Activated.Fire();
			flush();
		});
		const earn = findIn(root, "Earn");
		const earnText = allText(earn);
		const chips = [0, 1, 2, 3].map(i => findIn(findIn(earn, `Earn${i}`), "Amount")?.Text);
		check(
			"loja › Earn coins: as quatro fontes com o chip de moedas (+3, +10, +8, +20) e o progresso do jogador",
			JSON.stringify(chips) ===
				JSON.stringify([
					`+${ECONOMY.COINS_PER_DAY}`,
					`+${ECONOMY.MILESTONE_BONUS}`,
					`+${ECONOMY.COINS_PER_BOSS}`,
					`+${ECONOMY.STARTING_COINS}`,
				]) &&
				/Day 1 \/ 5/.test(earnText) &&
				/4 days to go/.test(earnText) &&
				/Bosses defeated: 0/.test(earnText) &&
				/Received/.test(earnText),
			`${chips.join(" ")} | ${earnText.slice(0, 160)}`,
		);
		check(
			"loja: trocar de aba nao cria nem destroi Instance",
			r.created === 0 && r.destroyed === 0,
			`${r.created} / ${r.destroyed}`,
		);
		runSpawned();
		const afterTabs = views(0);
		close();
		flush();
		// a second visit is a second view; the wardrobe's screen is its own (screen 1), once per visit too
		SHOP.showShop(ctx, noop, noop)();
		flush();
		runSpawned();
		const closeWardrobeView = showWardrobe(ctx, { onBack: noop, onEquip: noop, onUnequip: noop });
		flush();
		runSpawned();
		closeWardrobeView();
		flush();
		check(
			"analytics: abrir a loja pede UM viewShop (tela 0) por visita -- as abas nao contam; o guarda-roupa, um (tela 1)",
			afterTabs === 1 && views(0) === 2 && views(1) === 1 && shopCalls.every(q => q.kind === "viewShop"),
			`loja ${afterTabs} depois das abas, ${views(0)} em 2 visitas; guarda-roupa ${views(1)}; ${shopCalls.length} chamadas`,
		);
		globalThis.task.spawn = realSpawn;
		saveClient.invokeShopAction = realInvoke;
		Object.assign(save, { money: keep.money, bestDay: keep.bestDay, day: keep.day, bossKills: keep.bossKills });
		save.packsBought = keep.bought;
		save.packsOpened = keep.opened;
		save.costumes = keep.costumes;
	}

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

	// ACH-3 / CON-03 (as rewritten by the owner, 2026-09-23: everything in the data works): an achievement is on view
	// exactly when the game can give it today. The bow and the sniper are weapons that work; the bosses SPAWN (the town's
	// anchors, shared/sim/ai/population.ts spawnBoss) and drop ITM-05's trophies; the energy works (ELE-01..09:
	// Thomas Edison and Turret are on, with their server triggers) and so do the vehicles (VEI-05: Rider, credited by
	// server/sim/vehicles.ts). Off: what has no trigger (Collector, Ninja) and the original's store and ads (Thanks,
	// Ads addict)
	const OFF = [4, 18, 19, 20];
	const offNow = ACHIEVEMENTS.filter(a => a.hidden === true).map(a => a.id);
	const population = readFileSync(join(SRC, "shared/sim/ai/population.ts"), "utf8");
	const world = readFileSync(join(SRC, "shared/game/world.ts"), "utf8");
	const { WEAPONS } = require(join(SRC, "shared/data/weapons.ts"));
	const { WeaponKind } = require(join(SRC, "shared/data/kinds.ts"));
	check(
		"ACH-3: a vista exatamente o que o jogo de hoje da: desligadas so sem gatilho e loja/anuncios do original",
		JSON.stringify(offNow) === JSON.stringify(OFF) &&
			visible.length === ACHIEVEMENTS.length - OFF.length &&
			WEAPONS.some(w => w.kind === WeaponKind.Bow) &&
			WEAPONS.some(w => w.kind === WeaponKind.Sniper) &&
			/this\.spawnBoss\(refs\)/.test(population) &&
			/bossAnchors: \[/.test(world),
		`desligadas ${JSON.stringify(offNow)}, ${visible.length} a vista`,
	);
	check(
		"...e desligada nao e apagada: as 22 linhas continuam, com os ids do save (CON-03)",
		ACHIEVEMENTS.length === 22 && ACHIEVEMENTS.every((a, i) => a.id === i),
	);
	// the toast (client/ui/achievementNotice.ts): a counter crossing its goal in this copy is announced once; a save
	// rewritten from outside is the new baseline. An admin reset rewrites ctx.save IN PLACE (client/admin/patches.ts):
	// before the rebase hook, the old "already complete" set outlived it and re-earning First steps was never told
	{
		const { noticeTracker } = require(join(SRC, "client/ui/achievementNotice.ts"));
		const { defaultSave: freshSave } = require(join(SRC, "shared/game/save.ts"));
		const live = freshSave();
		const tracker = noticeTracker(() => live);
		live.achievements[AchievementId.FirstSteps] = 1;
		const first = tracker.newlyCompleted();
		const again = tracker.newlyCompleted();
		// the admin reset: the same object, emptied, then the wallet brings First steps back
		const wipe = () => live.achievements.fill(0);
		wipe();
		tracker.rebase();
		live.achievements[AchievementId.FirstSteps] = 1;
		const reEarned = tracker.newlyCompleted();
		// the same without the rebase: the bug the review found
		const stale = noticeTracker(() => live);
		wipe();
		live.achievements[AchievementId.FirstSteps] = 1;
		const missed = stale.newlyCompleted();
		// an admin EDIT that completes one is not an achievement earned: rebased, never toasted
		live.achievements[AchievementId.GoodDay] = 1;
		tracker.rebase();
		const edited = tracker.newlyCompleted();
		const patches = readFileSync(join(SRC, "client/admin/patches.ts"), "utf8");
		check(
			"toast: uma vez ao completar; depois do reset do admin (no lugar) e re-ganha, avisa de novo; a edicao do admin nao avisa",
			JSON.stringify(first) === JSON.stringify([AchievementId.FirstSteps]) &&
				again.length === 0 &&
				JSON.stringify(reEarned) === JSON.stringify([AchievementId.FirstSteps]) &&
				missed.length === 0 &&
				edited.length === 0 &&
				/copyInto\(save, sanitizeStoredSave\(ev\.reset\)\);[^]*?rebaseAchievementNotices\(\);[^]*?deps\.endRun\(\)/.test(
					patches,
				) &&
				/applyAdminOps\(save, ops\);[^]*?rebaseAchievementNotices\(\);/.test(patches),
			`primeiro ${JSON.stringify(first)}, depois do reset ${JSON.stringify(reEarned)} (sem o rebase: ${JSON.stringify(missed)}), edicao ${JSON.stringify(edited)}`,
		);
	}

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
	table("achievements", "ACHIEVEMENTS", "howTo", a => a.hidden !== true);
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

/** every name a town can have (MP-26, shared/data/townNames.ts): proper nouns, like a player's */
const TOWN_NAMES = [];
for (const p of TOWNS.TOWN_PREFIXES) {
	for (const s of TOWNS.TOWN_SUFFIXES) if (TOWNS.townNameAllowed(p, s)) TOWN_NAMES.push(p + s);
}
{
	// ITM-07: the pickup's words -- the prompt "E: Pick up Shotgun ammo ×8", the note at the ceiling "Wood full (9999)",
	// the chip "+12 Wood" (client/ui/pickupToast.ts) and the lesson that teaches walking over supplies -- are entries,
	// item names (above) and numbers; the lesson's text in objectives.ts is the entry itself
	const objectives = readFileSync(join(SRC, "client/onboarding/objectives.ts"), "utf8");
	const pickupLesson = objectives.match(/id: "pickup",[\s\S]*?title: "([^"]+)",[\s\S]*?hint: "([^"]+)"/);
	const words = ["Pick up", "full"];
	const lesson = pickupLesson === null ? [] : [pickupLesson[1], pickupLesson[2]];
	check(
		"a coleta (ITM-07): 'Pick up', 'full' e a licao 'Pick something up' (andar por cima / usar) estao na LANG_TABLE",
		[...words, ...lesson].every(w => LANG.has(w)) &&
			lesson.length === 2 &&
			/Walk over food, ammo and materials/.test(lesson[1]),
		lesson.join(" / "),
	);
}

/** proper nouns a translator leaves alone (UI-03: the English of a name IS the name), and the kit's glyphs */
const PROPER = new Set([
	GAME_NAME,
	...TOWN_NAMES,
	"LAST TOWN",
	// the credits (credits.ts, Settings › About): who made it and what inspired it (shared/module.ts)
	"Luvitlua",
	"Dead Town",
	"Tester",
	"X",
	"?",
]);
/** key legends are keys (the kit's Keycap / ValueKey / badge): the keyboard's letters and the pad's button names */
const KEYS = new Set(SCHEMES.flatMap(s => s.rows.map(r => r[0])));
/** units that read the same in every language the platform offers: "0.3 s", "280 XP", "1120 x 630" */
const UNITS = /\b(?:\d+(?:\.\d+)?\s*(?:s|XP|HP)|\d+\s*x\s*\d+|×\s*\d+)\b/g;
/** the game's version as About shows it: "0.1.0", and in a CI build "0.1.0 (0b1edad)" -- the stamped commit is a number */
const VERSION = /\b\d+\.\d+\.\d+(?:\s*\([0-9a-f]{7}\))?/g;
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
	let rest = t.replace(VERSION, " ").replace(UNITS, " ");
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
	// MP-26: a hosted lobby seen by the town's keeper (Servers, Restart town), the Servers window in each of its states,
	// and the Restart town question
	{
		const player = service("Players").LocalPlayer;
		player.SetAttribute("pz_town_keeper", true);
		visit(
			"Lobby (servidor, dono)",
			() => {
				const h = showLobby(ctx, lobbyHandlers, hostedStatus, "menu");
				return () => h.close();
			},
			"Lobby",
		);
		visit(
			"Restart town?",
			() => {
				askRestartTown(ctx, SEED);
				return () => layer.FindFirstChild("PopupOverlay")?.Destroy();
			},
			"PopupOverlay",
		);
		player.SetAttribute("pz_town_keeper", undefined);
		const answers = [
			["lista", { ok: true, servers: SERVER_ROWS }],
			["uma so", { ok: true, servers: [SERVER_ROWS[0]] }],
			["vazia", { ok: true, servers: [] }],
			...["studio", "unavailable", "rate"].map(r => [r, { ok: false, reason: r }]),
		];
		for (const [label, answer] of answers) {
			TownNet.setTownRequester(() => answer);
			visit(
				`Servers (${label})`,
				() => {
					const w = showServers(ctx);
					return () => w.close();
				},
				"Servers",
			);
		}
		// a join refused, then one on its way: the status line says each
		for (const reason of ["full", "gone", "same", "inWorld", "busy", "loading", "failed"]) {
			TownNet.setTownRequester(req =>
				req.kind === "servers" ? { ok: true, servers: SERVER_ROWS } : { ok: false, reason },
			);
			visit(
				`Servers (join: ${reason})`,
				() => {
					const w = showServers(ctx);
					flush();
					const root = layer.FindFirstChild("Servers");
					findIn(root, "Row0", "TextButton")?.Activated.Fire();
					flush();
					findIn(root, "Join", "TextButton")?.Activated.Fire();
					return () => w.close();
				},
				"Servers",
			);
		}
		TownNet.setTownRequester(req => (req.kind === "servers" ? { ok: true, servers: SERVER_ROWS } : { ok: true }));
		visit(
			"Servers (a caminho)",
			() => {
				const w = showServers(ctx);
				flush();
				const root = layer.FindFirstChild("Servers");
				findIn(root, "Row0", "TextButton")?.Activated.Fire();
				flush();
				findIn(root, "Join", "TextButton")?.Activated.Fire();
				return () => w.close();
			},
			"Servers",
		);
	}
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
	visit(
		"Shop › Earn coins",
		() => {
			const close = showShop(ctx, noop, noop);
			flush();
			findIn(layer.FindFirstChild("Shop"), "Tabs").FindFirstChild("Tab1").Activated.Fire();
			return close;
		},
		"Shop",
	);
	visit(
		"Achievements",
		() => {
			ctx.save.achievements[0] = 1;
			ctx.save.achievements[12] = 17;
			const h = showLobby(ctx, lobbyHandlers, lobbyStatus, "menu");
			flush();
			findIn(layer.FindFirstChild("Lobby"), "Nav2").Activated.Fire();
			return () => {
				layer.FindFirstChild("Achievements")?.Destroy();
				h.close();
				ctx.save.achievements.fill(0);
			};
		},
		"Achievements",
	);
	visit("Credits", () => showCredits(ctx, noop), "Credits");
	visit("How to play", () => showTutorial(ctx, noop), "HowToPlay");
	// the game rules (compliance F3): How to play › Rules, the kit's popup over the card
	visit(
		"How to play › Rules",
		() => {
			const close = showTutorial(ctx, noop);
			flush();
			findIn(layer.FindFirstChild("HowToPlay"), "Rules", "TextButton").Activated.Fire();
			return () => {
				layer.FindFirstChild("PopupOverlay")?.Destroy();
				close();
			};
		},
		"PopupOverlay",
	);
	ctx.phase = "playing";
	visit("Menu", () => showPause(ctx, 0, { onResume: noop, onHome: noop, onShop: noop, onSettings: noop }), "Menu");
	// the death screen (gameOver.ts, UI-13): its four epitaphs (a record, five days, a first death, the rest), with and
	// without the coins for a Rebirth, and every state of the wait -- somebody standing (one, two), by day, the town
	// falling, the town's window run out, a new life waiting, the count at zero
	const summaries = [
		{ days: 12, bestDay: 12, level: 7, kills: 20, bosses: 0, first: false, record: true },
		{ days: 6, bestDay: 12, level: 7, kills: 20, bosses: 0, first: false },
		{ days: 1, bestDay: 3, level: 1, kills: 0, bosses: 0, first: true },
		{ days: 3, bestDay: 12, level: 7, kills: 20, bosses: 2, first: false },
	];
	const deathHandlers = { onRebirth: noop, onNewRun: noop, onHome: noop };
	const coins = ctx.save.money;
	for (const money of [999, 0]) {
		ctx.save.money = money;
		for (const summary of summaries) {
			visit(
				`Fim de partida (${summary.days} dias, ${money} moedas)`,
				() => showRunSummary(ctx, summary, deathHandlers),
				"RunOver",
			);
		}
		const waits = [
			["alguem de pe", 2, 197, true, false, 0],
			["um de pe", 1, 197, true, false, 0],
			["de dia", 1, 180, false, false, 0],
			["a cidade cai", 0, 150, true, false, 6],
			["a janela acabou", 0, 150, true, false, 31],
			["vida nova", 2, 120, true, true, 0],
			["vida nova, a cidade cai", 0, 120, true, true, 6],
			["zero", 2, 0, true, false, 0],
			["sem lista", undefined, 197, true, false, 0],
		];
		for (const [label, standing, seconds, night, newLife, later] of waits) {
			visit(
				`Espera do amanhecer (${label}, ${money} moedas)`,
				() => {
					const handlers = newLife ? { ...deathHandlers, onNewRun: undefined } : deathHandlers;
					const w = showDaybreakWait(ctx, summaries[3], handlers, newLife, () => standing);
					w.setRemaining(seconds, night);
					ui.setClock(ui.getClock() + later);
					w.setRemaining(seconds, night);
					return () => w.close();
				},
				"RunOver",
			);
		}
	}
	ctx.save.money = coins;
	// the New game question
	visit(
		"Morte: a pergunta do New game",
		() => {
			const close = showRunSummary(ctx, summaries[1], deathHandlers);
			flush();
			findIn(layer.FindFirstChild("RunOver"), "NewGame").Activated.Fire();
			return close;
		},
		"PopupOverlay",
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
	// LOC-UPPER: a label drawn in capitals is its own entry ("START"), never an entry upper-cased in code -- the
	// platform's translation is case-sensitive, and "Start" in the table does not match "START" on screen
	check(
		"LOC-UPPER: nenhum rotulo em maiusculas e .upper() de uma entrada (cada um e a sua propria entrada na LANG_TABLE)",
		found.upper.length === 0,
		found.upper.join("; ") || "nenhum",
	);
	const uppers = [];
	const walkUpper = d => {
		for (const f of readdirSync(d)) {
			const p = join(d, f);
			if (statSync(p).isDirectory()) walkUpper(p);
			else if (
				p.endsWith(".ts") &&
				!p.includes(join("client", "admin")) &&
				/\.upper\(\)/.test(readFileSync(p, "utf8"))
			)
				uppers.push(p.slice(SRC.length + 1));
		}
	};
	walkUpper(SRC);
	check(
		"...e nenhum arquivo do jogo (fora do admin, UI-03) chama .upper() num texto",
		uppers.length === 0,
		uppers.join(", ") || "nenhum",
	);
	const notInTable = [...asked].filter(k => !LANG.has(k));
	check(
		"toda chave que as telas pediram a lang.ts em tempo de execucao esta na LANG_TABLE (nenhuma cai fora do CSV)",
		notInTable.length === 0,
		notInTable.map(k => `"${k.slice(0, 50)}"`).join("; ") || `${[...asked].length} chaves`,
	);
}
{
	// `npm run locale` in a scratch copy: its CSV must be the committed one, and it must read every entry of the table
	const tmp = mkdtempSync(join(tmpdir(), "pz-locale-"));
	try {
		mkdirSync(join(tmp, "tools"), { recursive: true });
		mkdirSync(join(tmp, "src/shared/data"), { recursive: true });
		writeFileSync(join(tmp, "tools/gen-locale.mjs"), readFileSync(join(ROOT, "tools/gen-locale.mjs")));
		writeFileSync(join(tmp, "tools/locale-context.mjs"), readFileSync(join(ROOT, "tools/locale-context.mjs")));
		writeFileSync(join(tmp, "src/shared/data/lang.ts"), readFileSync(join(SRC, "shared/data/lang.ts")));
		execFileSync(process.execPath, [join(tmp, "tools/gen-locale.mjs")], { stdio: "pipe" });
		const fresh = readFileSync(join(tmp, "design/locale/LastTown.csv"), "utf8");
		const committed = readFileSync(join(ROOT, "design/locale/LastTown.csv"), "utf8");
		// RFC 4180 records: a quoted field may hold commas, doubled quotes and line breaks (LOC-NL)
		const records = [];
		{
			let rec = [];
			let field = "";
			let quoted = false;
			for (let i = 0; i < fresh.length; i++) {
				const c = fresh[i];
				if (quoted) {
					if (c === '"' && fresh[i + 1] === '"') {
						field += '"';
						i++;
					} else if (c === '"') quoted = false;
					else field += c;
				} else if (c === '"') quoted = true;
				else if (c === ",") {
					rec.push(field);
					field = "";
				} else if (c === "\n") {
					rec.push(field);
					records.push(rec);
					rec = [];
					field = "";
				} else field += c;
			}
		}
		const [header, ...body] = records;
		const rows = body.length;
		check(
			"o CSV commitado (design/locale/LastTown.csv) e o que `npm run locale` gera hoje",
			fresh === committed,
			fresh === committed ? `${rows} textos` : "rode `npm run locale` e commite o CSV",
		);
		check(
			"...e o gerador le TODA entrada da LANG_TABLE (nenhuma escapa do parser dele), nas colunas Key, Context, Example, Source",
			rows === LANG_COUNT && header.join() === "Key,Context,Example,Source" && body.every(r => r.length === 4),
			`${rows} no CSV, ${LANG_COUNT} na tabela`,
		);
		// LOC-NL: the Source is the text as the screen shows it -- a multi-line entry with real line breaks (widgets.ts
		// `nl` turns lang.ts's "#" into them before drawing), never the "#" the platform would never see on screen
		const sources = new Set(body.map(r => r[3]));
		const multi = [...LANG].filter(e => e.includes("#"));
		const unmatched = multi.filter(e => !sources.has(e.split("#").join("\n")));
		check(
			`LOC-NL: as ${multi.length} entradas de varias linhas vao ao CSV como a tela as mostra (quebra de linha real, sem "#")`,
			multi.length > 0 && unmatched.length === 0 && !body.some(r => r[3].includes("#")),
			unmatched.map(e => `"${e.slice(0, 40)}"`).join("; ") || `${multi.length} entradas`,
		);
		// the Context column is tools/locale-context.mjs, written verbatim (its own Source keys were already
		// checked against LANG_TABLE by gen-locale.mjs above -- a stale one there makes this whole block throw);
		// every other row's Context is blank, and none goes over the 80-char budget the map is kept under
		const byContext = new Map(body.map(r => [r[3], r[1]]));
		const contextKeys = Object.keys(CONTEXT);
		const wrong = contextKeys.filter(k => byContext.get(k) !== CONTEXT[k]);
		const shouldBeBlank = body.filter(r => CONTEXT[r[3]] === undefined && r[1] !== "");
		const tooLong = contextKeys.filter(k => CONTEXT[k].length > 80);
		check(
			`LOC-CTX: as ${contextKeys.length} entradas de tools/locale-context.mjs estao na coluna Context, e mais nenhuma`,
			wrong.length === 0 && shouldBeBlank.length === 0 && tooLong.length === 0,
			wrong.map(k => `"${k}"`).join("; ") ||
				shouldBeBlank.map(r => `"${r[3].slice(0, 40)}"`).join("; ") ||
				tooLong.map(k => `"${k}" (${CONTEXT[k].length})`).join("; ") ||
				`${contextKeys.length} com Context`,
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

// ================================================================ 7. the game rules (compliance F3)

console.log("\n7) as regras do jogo: How to play › Rules, com o caminho de recurso\n");
{
	const { RULES_TEXT } = require(join(SRC, "shared/data/rules.ts"));
	ctx.phase = "tutorial";
	const close = showTutorial(ctx, noop);
	flush();
	const card = layer.FindFirstChild("HowToPlay");
	const rulesBtn = findIn(card, "Rules", "TextButton");
	check("How to play tem o botao Rules", rulesBtn !== undefined && shown(rulesBtn, layer));
	rulesBtn?.Activated.Fire();
	flush();
	const pop = layer.FindFirstChild("PopupOverlay");
	const body = findIn(pop, "PopupBody");
	const lines = RULES_TEXT.split("#");
	check(
		"...que abre as regras, linha por linha, com o recurso por ultimo",
		body !== undefined && lines.every(l => String(body.Text).includes(l)) && lines.at(-1).startsWith("Appeals:"),
		body === undefined ? "sem popup" : `${lines.length} linhas`,
	);
	findIn(pop, "PopupBtn0", "TextButton")?.Activated.Fire();
	flush();
	check(
		"...e o Close fecha o popup e deixa o cartao aberto",
		layer.FindFirstChild("PopupOverlay") === undefined && layer.FindFirstChild("HowToPlay") !== undefined,
	);
	close();
	flush();
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
