#!/usr/bin/env node
/*
 * Every row of Settings, for its REAL effect in the game (docs/DESIGN_RULES.md UI-07 "Formulário"), not only for the
 * save field it writes.
 *
 *   npm run test:settings
 *   PZ_SRC=<another checkout>/src node tools/test-settings.mjs    (measures that version)
 *
 * The owner asked whether every feature of the settings had been tested. test:screens checks the FORM (the window,
 * the Switch, the radio, the Defaults popup); this suite follows each control to what it changes: the mixer's sound
 * groups, the HUD that mounts, the touch geometry the thumbs hit, the keys the bootstrap listens to, and the save that
 * goes to the server and comes back. It runs the REAL settings.ts / window.ts / widgets.ts, client/audio (mixer,
 * previews, music), client/ui/hud.ts, client/bootstrap.ts (its input handlers and its touch layout) and
 * shared/game/save.ts under Node, over the counted fake Instance tree of tools/ui-shim.mjs, and checks:
 *
 *   1. THE MAP         data-driven: every field of SettingsData has a row (or a written reason not to), and every form
 *                      row on General and Touch controls is in the table below with the effect it is tested for. A new
 *                      setting without an effect test fails here.
 *   2. AUDIO           SFX and BGM: the slider moves the real SoundGroup volumes (sfx, ui, bgm) on the next frame, by
 *                      the documented curve; the previews play on the right bus while dragging (and the first move up
 *                      from 0 is heard); 0 mutes and skips playing; the night music stops at 0 and comes back.
 *   3. HUD SIZE        the console, the day plate, the E hint, the banner and the message feed of a mounted HUD are
 *                      80%..120% by the slider; the Touch tab's preview console follows it too.
 *   4. TOUCH           each slider and switch moves the geometry the bootstrap hit-tests (getTouchLayout), the HUD's
 *                      touch layer is redrawn on it, the preview is that very layout (under a real top bar too), a
 *                      fixed stick is only grabbed at its home, and left-handed swaps which half moves.
 *   5. CONTROLS        the device radio lists SCHEMES; every row of every scheme is a binding the real bootstrap
 *                      honours (probed through its InputBegan / InputChanged / InputEnded handlers and the HUD's
 *                      touch buttons). A tip that promises a key that does nothing fails here.
 *   6. DEFAULTS        each tab's Defaults puts EXACTLY that tab's fields back to defaultSettings(), after the
 *                      question; Cancel changes nothing.
 *   7. ABOUT           the facts are the code's: the game's name, the original credited (CON-01), MAX_PLAYERS, the
 *                      toolchain, the way to the credits (and none over a run).
 *   8. PERSISTENCE     a change asks for one save a second at most and one on leaving; the settings survive the
 *                      server's report sanitiser and a reload, and garbage or out-of-range values are clamped.
 *   9. REDUCE MOTION   the read-only row follows the Roblox setting live and writes nothing.
 *
 * Pure Node (>= 18) plus the project's TypeScript.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installUiShims } from "./ui-shim.mjs";

const ui = installUiShims({ seed: 1, viewport: [1120, 630] });
const { SRC, ROOT, require, flush, service, setViewport, setClock, getClock } = ui;

// ---------------------------------------------------------------- Sounds that play (the tree only stores props)

/** every Sound:Play(), in order: which sound, through which SoundGroup, at what volume */
const plays = [];
{
	const makeInstance = globalThis.Instance;
	globalThis.Instance = function Instance(className) {
		const inst = makeInstance(className);
		if (className === "Sound") {
			inst.IsPlaying = false;
			inst.Play = () => {
				inst.IsPlaying = true;
				plays.push({ id: inst.SoundId, group: inst.SoundGroup?.Name, volume: inst.Volume, sound: inst });
			};
			inst.Stop = () => {
				inst.IsPlaying = false;
			};
		}
		return inst;
	};
}

const boot = require(join(SRC, "client/bootstrap.ts"));
const saveClient = require(join(SRC, "client/systems/saveClient.ts"));
/** requestSave(reason) calls, in order (the remote is not there under Node) */
const saves = [];
saveClient.requestSave = reason => {
	saves.push(reason);
	return true;
};
const { showSettings } = require(join(SRC, "client/ui/settings.ts"));
const { Hud } = require(join(SRC, "client/ui/hud.ts"));
const { audio } = require(join(SRC, "client/audio/audio.ts"));
const { GameMusic } = require(join(SRC, "client/audio/music.ts"));
const { soundDef } = require(join(SRC, "shared/data/sounds.ts"));
const { COMPACT_LAYOUT, placeTouchConsole } = require(join(SRC, "client/ui/hudConsole.ts"));
const { SCHEMES } = require(join(SRC, "client/ui/tutorial.ts"));
const saveMod = require(join(SRC, "shared/game/save.ts"));
const { defaultSettings, defaultSave, sanitizeClientReport, sanitizeStoredSave, resetRun } = saveMod;
const { MAX_PLAYERS } = require(join(SRC, "shared/net/mpConfig.ts"));
const { GAME_NAME } = require(join(SRC, "shared/module.ts"));
const { DESIGN_W, DESIGN_H } = require(join(SRC, "client/ui/widgets.ts"));
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
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const px = v => (typeof v === "number" ? v.toFixed(1) : String(v));

// ---------------------------------------------------------------- the client, and a way to drive it

const ctx = boot.getCtx();
ctx.phase = "lobby";
const s = ctx.save.settings;
const layer = ctx.uiLayer;
const GuiService = service("GuiService");
const UIS = service("UserInputService");
const RunService = service("RunService");
const SoundService = service("SoundService");

/** the delays the screens schedule (task.delay is the engine's; here they wait for `advance`) */
const delays = [];
globalThis.task.delay = (t, fn, ...a) => {
	delays.push({ at: getClock() + t, fn: () => fn(...a) });
};
function advance(seconds) {
	setClock(getClock() + seconds);
	for (let i = 0; i < delays.length; i++) {
		if (delays[i].at <= getClock()) {
			const [d] = delays.splice(i, 1);
			i--;
			d.fn();
		}
	}
	flush();
}
/** one engine frame: the mixer (and whatever listens to Heartbeat) runs */
function frame(dt = 1 / 60) {
	setClock(getClock() + dt);
	RunService.Heartbeat.Fire(dt);
	flush();
}

const settingsRoot = () => layer.FindFirstChild("Settings");
const findIn = (root, name, cls) =>
	root?.GetDescendants().find(d => d.Name === name && (cls === undefined || d.ClassName === cls));
const openTab = i => {
	findIn(settingsRoot(), "Tabs").FindFirstChild(`Tab${i}`).Activated.Fire();
	flush();
};
/** `g` and every ancestor up to `root` are visible (a tab's page is kept built and hidden) */
const shownIn = (g, root) => {
	for (let p = g; p !== undefined && p !== root; p = p.Parent) if (p.IsA("GuiObject") && !p.Visible) return false;
	return true;
};
/** the form rows of the tab on screen: the frames that hold a label cell with a description (window.ts SettingRow) */
function formRows(root) {
	return root
		.GetDescendants()
		.filter(d => d.Name === "Description" && d.Parent?.FindFirstChild("SegLabelC") !== undefined)
		.map(d => d.Parent)
		.filter(r => shownIn(r, root));
}
const rowOf = name => formRows(settingsRoot()).find(r => r.Name === name);

const pad = key => ({
	UserInputType: Enum.UserInputType.Gamepad1,
	KeyCode: Enum.KeyCode[key],
	Position: new Vector3(),
});
const press = (inputObj, gpe = false) => {
	UIS.InputBegan.Fire(inputObj, gpe);
	flush();
};
const release = inputObj => {
	UIS.InputEnded.Fire(inputObj, false);
	flush();
};

/** a slider's hit button (widgets.ts Slider: the TextButton named like its row) */
const sliderOf = name => findIn(rowOf(name), name, "TextButton");
/** puts a slider at `v` (multiples of its 0.05 step) the way a pad does: focus it, then left / right */
function setSlider(name, v, onEachPress) {
	const hit = sliderOf(name);
	GuiService.SelectedObject = hit;
	flush();
	for (let i = 0; i < 25; i++) press(pad("DPadLeft"));
	const steps = Math.round(v / 0.05);
	for (let i = 0; i < steps; i++) {
		press(pad("DPadRight"));
		onEachPress?.(i);
	}
	GuiService.SelectedObject = undefined;
	flush();
}
const switchOf = name => findIn(rowOf(name), name, "TextButton");
const keyText = (row, name = "Legend") => findIn(row, name)?.Text;

// ================================================================ 1. the map: every field, every row

console.log(`Settings: fonte ${SRC}\n`);
console.log("1) o mapa: todo campo de SettingsData tem linha (ou motivo escrito), toda linha tem efeito testado\n");

/**
 * Every form row of Settings -> the save field it writes and the section of this suite that follows it into the game.
 * Adding a row to settings.ts without adding it here fails the check below: a setting is not done until its effect is.
 */
const ROWS = {
	Sfx: { tab: 0, field: "soundEffect", effect: "2) mixer: sfx + ui" },
	Bgm: { tab: 0, field: "bgm", effect: "2) mixer: bgm, a musica da noite" },
	UiSize: { tab: 0, field: "uiSize", effect: "3) HUD montada 80%..120%" },
	Motion: { tab: 0, field: undefined, effect: "9) segue o Reduce Motion do Roblox (so leitura)" },
	LeftSize: { tab: 1, field: "leftSize", effect: "4) move.baseR" },
	LeftPos: { tab: 1, field: "leftPos", effect: "4) move.homeY" },
	RightSize: { tab: 1, field: "rightSize", effect: "4) aim.baseR e os quatro botoes" },
	RightPos: { tab: 1, field: "rightPos", effect: "4) aim.homeY" },
	Relative: { tab: 1, field: "leftRelative", effect: "4) analogico flutuante x fixo (bootstrap)" },
	Mirror: { tab: 1, field: "mirror", effect: "4) canhoto: os lados trocam (bootstrap)" },
};
/** fields of SettingsData with no row, and why (UI-07: a new field is a save schema change, reviewed) */
const NO_ROW = {
	langType:
		"a troca English / Korean saiu: o Roblox traduz pela conta do jogador; o campo so escolhe um OVERRIDE de lang.ts",
};

setViewport(1120, 630);
let closeSettings = showSettings(
	ctx,
	() => {},
	() => {},
);
flush();
const seenRows = [];
for (const tab of [0, 1]) {
	openTab(tab);
	for (const r of formRows(settingsRoot())) seenRows.push(`${tab}:${r.Name}`);
}
const fields = Object.keys(defaultSettings());
const unmapped = fields.filter(f => NO_ROW[f] === undefined && !Object.values(ROWS).some(r => r.field === f));
check(
	`todo campo de SettingsData (${fields.length}) tem uma linha na Settings ou um motivo escrito para nao ter`,
	unmapped.length === 0,
	unmapped.length === 0 ? `${fields.join(", ")}` : `sem linha: ${unmapped.join(", ")}`,
);
const untested = seenRows.filter(k => {
	const [tab, name] = k.split(":");
	return name !== "Defaults" && ROWS[name]?.tab !== +tab;
});
check(
	"toda linha de formulario de General e Touch controls esta no mapa, com o efeito que esta suite testa",
	untested.length === 0 && Object.keys(ROWS).every(n => seenRows.includes(`${ROWS[n].tab}:${n}`)),
	untested.length === 0 ? seenRows.join(", ") : `sem teste de efeito: ${untested.join(", ")}`,
);

// ================================================================ 2. audio

console.log("\n2) SFX e BGM: o volume REAL dos grupos de som, os previews e a musica\n");

audio.start();
audio.bindSettings(() => ctx.save.settings);
frame();
const group = bus => SoundService.FindFirstChild("ProjectZAudio")?.FindFirstChild(bus);
/** audio.ts: gain = HEADROOM[bus] * slider^1.5 */
const HEADROOM = { sfx: 1, ui: 0.8, bgm: 0.7 };
const gainOf = (bus, v) => HEADROOM[bus] * Math.pow(v, 1.5);
check(
	"o mixer tem os tres grupos (sfx, ui, bgm) sob o SoundService",
	["sfx", "ui", "bgm"].every(b => group(b)?.ClassName === "SoundGroup"),
);
openTab(0);
{
	const bad = [];
	for (const v of [0.25, 1, 0.5]) {
		setSlider("Sfx", v);
		frame();
		if (!near(s.soundEffect, v, 1e-9)) bad.push(`campo ${s.soundEffect} != ${v}`);
		for (const bus of ["sfx", "ui"]) {
			if (!near(group(bus).Volume, gainOf(bus, v), 1e-9))
				bad.push(`${bus} ${group(bus).Volume} != ${gainOf(bus, v)}`);
		}
		if (!near(group("bgm").Volume, gainOf("bgm", s.bgm), 1e-9)) bad.push("o SFX mexeu no BGM");
	}
	check(
		"SFX: arrastar muda o volume do grupo sfx E do ui (a interface anda no slider do SFX) no proximo quadro, pela curva v^1.5",
		bad.length === 0,
		bad.join("; ") || `a 50%: sfx ${group("sfx").Volume.toFixed(3)}, ui ${group("ui").Volume.toFixed(3)}`,
	);
}
{
	plays.length = 0;
	setSlider("Sfx", 0.3, () => advance(0.2));
	const clicks = plays.filter(p => p.id === soundDef("uiClick").id && p.group === "ui");
	check(
		"...e enquanto arrasta, o preview (o clique da interface) toca no grupo ui, espacado (nao um por pixel)",
		clicks.length >= 3 && clicks.length <= 6,
		`${clicks.length} cliques em 6 passos`,
	);
	setSlider("Sfx", 0);
	frame();
	plays.length = 0;
	audio.play("uiClick");
	audio.play("uiHover");
	check(
		"SFX em 0: os grupos sfx e ui ficam mudos e nada toca (nem stream, nem CPU)",
		group("sfx").Volume === 0 && group("ui").Volume === 0 && plays.length === 0,
		`sfx ${group("sfx").Volume}, ${plays.length} sons`,
	);
	// the first move up from 0: the preview of THAT move must be heard (the gains used to wait for the next frame)
	plays.length = 0;
	advance(1);
	const hit = sliderOf("Sfx");
	GuiService.SelectedObject = hit;
	flush();
	press(pad("DPadRight"));
	GuiService.SelectedObject = undefined;
	flush();
	check(
		"...e o primeiro passo para cima a partir de 0 ja se ouve (o preview daquele passo nao cai no mudo)",
		near(s.soundEffect, 0.05) && plays.some(p => p.id === soundDef("uiClick").id),
		`${plays.length} sons no passo 0 -> 5%`,
	);
	setSlider("Sfx", 0.5);
}
{
	const music = new GameMusic();
	music.update({ isNight: true, dayTime: 22, hpRatio: 1, dead: false });
	for (let i = 0; i < 240; i++) frame();
	const tracks = SoundService.FindFirstChild("ProjectZAudio")
		.GetChildren()
		.filter(c => c.ClassName === "Sound" && c.Name.startsWith("Track") && c.SoundId === soundDef("bgmNight").id);
	const night = tracks.find(t => t.IsPlaying);
	check(
		"a musica da noite toca no grupo bgm (a partida a pede; a Settings so muda o volume dela)",
		night !== undefined && night.SoundGroup === group("bgm") && night.Volume > 0,
		`${tracks.length} faixas, tocando: ${night !== undefined}`,
	);
	const bad = [];
	for (const v of [0.2, 0.9]) {
		setSlider("Bgm", v);
		frame();
		if (!near(group("bgm").Volume, gainOf("bgm", v), 1e-9)) bad.push(`bgm ${group("bgm").Volume}`);
		if (!near(group("sfx").Volume, gainOf("sfx", s.soundEffect), 1e-9)) bad.push("o BGM mexeu no SFX");
	}
	check(
		"BGM: arrastar muda o volume do grupo bgm no proximo quadro, pela mesma curva (0,7 x v^1.5), sem tocar no SFX",
		bad.length === 0,
		bad.join("; ") || `a 90%: ${group("bgm").Volume.toFixed(3)}`,
	);
	plays.length = 0;
	setSlider("Bgm", 0.6, () => advance(0.7));
	const stingers = plays.filter(p => p.id === soundDef("stingerDawn").id && p.group === "bgm");
	check(
		"...o preview do BGM (a vinheta do amanhecer) toca no grupo bgm enquanto arrasta, espacado",
		stingers.length >= 3,
		`${stingers.length} vinhetas em 12 passos`,
	);
	setSlider("Bgm", 0);
	for (let i = 0; i < 5; i++) frame();
	check(
		"BGM em 0: a musica da noite PARA (nada em stream) e o grupo fica mudo",
		!night.IsPlaying && night.Volume === 0 && group("bgm").Volume === 0,
		`tocando ${night.IsPlaying}, volume ${night.Volume}`,
	);
	setSlider("Bgm", 0.5);
	for (let i = 0; i < 60; i++) frame();
	check("...e volta a tocar quando o slider sobe", night.IsPlaying && night.Volume > 0);
	music.stop();
	for (let i = 0; i < 400; i++) frame();
}

// ================================================================ 3. HUD size

console.log("\n3) HUD size: a HUD montada muda de tamanho de verdade (80%..120%)\n");

const hud = new Hud(ctx);
const hudRoot = () => ctx.hudLayer.FindFirstChild("HudRoot");
const hudPart = name =>
	hudRoot()
		?.GetDescendants()
		.find(d => d.Name === name);
/** the design-space width (Scale of the screen) a HUD cluster takes */
const hudW = name => hudPart(name)?.Size.X.Scale;
const HUD_PARTS = ["Console", "DayPlate", "HintBox", "BannerBox", "Feed"];
/** the top and bottom (design units, from the top of the screen) of a cluster anchored at the top */
const hudSpan = name => {
	const f = hudPart(name);
	return [f.Position.Y.Scale * DESIGN_H, (f.Position.Y.Scale + f.Size.Y.Scale) * DESIGN_H];
};
function mountedSizes(uiSize) {
	s.uiSize = uiSize;
	hud.mount();
	flush();
	const out = { spans: {} };
	for (const n of HUD_PARTS) out[n] = hudW(n);
	for (const n of ["DayPlate", "BannerBox", "Feed"]) out.spans[n] = hudSpan(n);
	hud.unmount();
	flush();
	return out;
}
{
	ctx.phase = "playing";
	const small = mountedSizes(0);
	const big = mountedSizes(1);
	const ratio = n => big[n] / small[n];
	const wrong = HUD_PARTS.filter(n => small[n] === undefined || !near(ratio(n), 1.2 / 0.8, 1e-6));
	check(
		"HUD size 0% -> 100% do slider: console, placa do dia, dica E, faixa de aviso e mensagens crescem de 80% para 120%",
		wrong.length === 0,
		HUD_PARTS.map(n => `${n} x${small[n] === undefined ? "?" : ratio(n).toFixed(3)}`).join(", "),
	);
	const mid = mountedSizes(0.5);
	check(
		"...e o padrao (50%) e o tamanho de desenho (x1,0)",
		near(mid.Console * DESIGN_W, 638, 1e-6),
		`console ${px(mid.Console * DESIGN_W)} unidades`,
	);
	// top down: the day plate, the banner under it, the feed under the banner -- at every size, none on another
	const stacked = [small, mid, big].every(
		m => m.spans.DayPlate[1] <= m.spans.BannerBox[0] + 1e-6 && m.spans.BannerBox[1] <= m.spans.Feed[0] + 1e-6,
	);
	check(
		"...e em todo tamanho a placa do dia, a faixa de aviso e as mensagens ficam uma sob a outra, sem se cobrir",
		stacked,
		[small, mid, big]
			.map(m =>
				["DayPlate", "BannerBox", "Feed"].map(n => m.spans[n].map(v => v.toFixed(0)).join("-")).join(" | "),
			)
			.join(" ;; "),
	);
	ctx.phase = "lobby";
	s.uiSize = 0.5;
}
{
	// the Touch tab's preview draws the compact console at the HUD size of the General tab: visited first, it must not
	// keep the size it was built with after the slider moved on General
	openTab(1);
	const deck = () => findIn(findIn(settingsRoot(), "Preview"), "Console");
	const deckW = () => deck().Size.X.Scale;
	const before = deckW();
	openTab(0);
	setSlider("UiSize", 1);
	openTab(1);
	const L = boot.getTouchLayout();
	const want = placeTouchConsole(L, COMPACT_LAYOUT, 1.2).w / L.viewW;
	check(
		"o preview da aba Touch desenha o console no HUD size escolhido em General (mesmo com a aba ja construida)",
		near(deckW(), want, 1e-6) && deckW() > before,
		`${before.toFixed(4)} -> ${deckW().toFixed(4)}, esperado ${want.toFixed(4)}`,
	);
	// ...and General's Defaults puts it back with the HUD size
	openTab(0);
	findIn(findIn(settingsRoot(), "Interface"), "Action").Activated.Fire();
	flush();
	findIn(layer.FindFirstChild("PopupOverlay"), "PopupBtn1").Activated.Fire();
	flush();
	openTab(1);
	check(
		"...e o Defaults de General o devolve ao tamanho padrao junto com o HUD size",
		s.uiSize === 0.5 && near(deckW(), before, 1e-6),
		`${deckW().toFixed(4)}, padrao ${before.toFixed(4)}`,
	);
	openTab(0);
}
closeSettings();
flush();

// ================================================================ 4. touch controls

console.log("\n4) controles de toque: a geometria que o polegar toca, a HUD e o preview\n");

// a phone under a 36 px Roblox bar (its buttons on the left 140 px), with a touch screen and no mouse
UIS.TouchEnabled = true;
UIS.MouseEnabled = false;
setViewport(844, 390, 36, 140);
const BAR = 36;
ctx.phase = "playing";
hud.mount();
flush();
closeSettings = showSettings(ctx, () => {}, undefined, true);
flush();
openTab(1);
const L = () => boot.getTouchLayout();
const touchLayer = () => hudRoot()?.FindFirstChild("Touch");
/** the centre (and radius) of a HUD touch control, in screen px (the layer's design space IS the viewport) */
function hudControl(name) {
	const f = touchLayer()
		?.GetDescendants()
		.find(d => d.Name === name);
	if (f === undefined) return undefined;
	const vw = L().viewW;
	const vh = L().viewH;
	const cx = (f.Position.X.Scale + f.Size.X.Scale * (0.5 - f.AnchorPoint.X)) * vw;
	const cy = (f.Position.Y.Scale + f.Size.Y.Scale * (0.5 - f.AnchorPoint.Y)) * vh;
	return { x: cx, y: cy, r: (f.Size.X.Scale * vw) / 2 };
}
/** the same control on the Settings preview, scaled back to screen px */
function previewControl(name) {
	const f = findIn(findIn(settingsRoot(), "Preview"), name);
	if (f === undefined) return undefined;
	const vw = L().viewW;
	const vh = L().viewH;
	return {
		x: (f.Position.X.Scale + f.Size.X.Scale / 2) * vw,
		y: (f.Position.Y.Scale + f.Size.Y.Scale / 2) * vh,
		r: (f.Size.X.Scale * vw) / 2,
	};
}
const CONTROLS = [
	["JoyBase", "Stick", l => ({ x: l.move.homeX, y: l.move.homeY, r: l.move.baseR })],
	["AimPad", "Aim", l => ({ x: l.aim.homeX, y: l.aim.homeY, r: l.aim.baseR })],
	["UseBtn", "Use", l => l.use],
	["ReloadBtn", "Reload", l => l.reload],
	["BagBtn", "Bag", l => l.bag],
	["MenuBtn", "Menu", l => l.pause],
];
/** HUD and preview against the layout the bootstrap hit-tests with: centre within half a pixel, radius too */
function drawnMatches() {
	const bad = [];
	for (const [hudName, prevName, pick] of CONTROLS) {
		const want = pick(L());
		const h = hudControl(hudName);
		const p = previewControl(prevName);
		const wantR = Math.max(want.r, hudName.endsWith("Btn") ? 22 : 0);
		if (h === undefined || !near(h.x, want.x, 0.5) || !near(h.y, want.y, 0.5) || !near(h.r, wantR, 0.5))
			bad.push(`HUD ${hudName} ${h ? `${px(h.x)},${px(h.y)} r${px(h.r)}` : "?"} != ${px(want.x)},${px(want.y)}`);
		if (p === undefined || !near(p.x, want.x, 0.75) || !near(p.y, want.y, 0.75) || !near(p.r, want.r, 0.75))
			bad.push(
				`preview ${prevName} ${p ? `${px(p.x)},${px(p.y)} r${px(p.r)}` : "?"} != ${px(want.x)},${px(want.y)} r${px(want.r)}`,
			);
	}
	return bad;
}
{
	const bad = drawnMatches();
	check(
		"844 x 390 sob uma barra de 36 px: a HUD e o preview da Settings desenham os controles onde o bootstrap os testa",
		bad.length === 0,
		bad.join("; "),
	);
}

/** each slider: set it low and high, and the part of the layout it owns must move the documented way */
const SLIDERS = [
	["LeftSize", "o analogico cresce", l => l.move.baseR, (lo, hi) => hi > lo],
	["LeftPos", "o analogico sobe", l => l.move.homeY, (lo, hi) => hi < lo],
	["RightSize", "o pad de mira e os botoes crescem", l => l.aim.baseR + l.use.r + l.bag.r, (lo, hi) => hi > lo],
	["RightPos", "o pad de mira sobe", l => l.aim.homeY, (lo, hi) => hi < lo],
];
for (const [name, what, measureOf, ok] of SLIDERS) {
	const field = ROWS[name].field;
	setSlider(name, 0);
	const lo = measureOf(L());
	const drawnLo = drawnMatches();
	setSlider(name, 1);
	const hi = measureOf(L());
	const drawnHi = drawnMatches();
	check(
		`${name} (${field}): 0% -> 100% e ${what} na geometria do bootstrap; HUD e preview redesenhados nela`,
		s[field] === 1 && ok(lo, hi) && drawnLo.length === 0 && drawnHi.length === 0,
		`${px(lo)} -> ${px(hi)}${drawnLo.length + drawnHi.length > 0 ? `; ${[...drawnLo, ...drawnHi].join("; ")}` : ""}`,
	);
	setSlider(name, 0.5);
}

/** a finger on the glass, through the real bootstrap (Position is inset-relative, as the engine reports it) */
const finger = (x, y) => ({
	UserInputType: Enum.UserInputType.Touch,
	KeyCode: Enum.KeyCode.Unknown,
	Position: new Vector3(x, y - BAR, 0),
});
{
	const input = ctx.input;
	const sw = switchOf("Relative");
	s.leftRelative = true;
	// floating: a thumb anywhere on the move half opens the stick under it
	const home = { x: L().move.homeX, y: L().move.homeY };
	let t = finger(L().splitX * 0.5, L().viewH * 0.45);
	press(t);
	const floatBase = [input.joystickActive, input.joystickBaseX, input.joystickBaseY];
	release(t);
	sw.Activated.Fire();
	flush();
	const fixedField = s.leftRelative;
	t = finger(L().splitX * 0.5, L().viewH * 0.45);
	press(t);
	const farGrab = input.joystickActive;
	release(t);
	t = finger(home.x + 5, home.y - 5);
	press(t);
	const nearGrab = [input.joystickActive, input.joystickBaseX, input.joystickBaseY];
	release(t);
	check(
		"Floating stick ligado: um polegar em qualquer ponto da metade do analogico abre o analogico sob ele (bootstrap)",
		floatBase[0] === true && near(floatBase[1], L().splitX * 0.5, 1e-6),
		`base ${px(floatBase[1])},${px(floatBase[2])}`,
	);
	check(
		"...desligado pelo Switch: o campo vira, o toque longe da base e ignorado e o toque na base a pega NA base",
		fixedField === false &&
			L().floating === false &&
			farGrab === false &&
			nearGrab[0] === true &&
			near(nearGrab[1], home.x, 1e-6) &&
			near(nearGrab[2], home.y, 1e-6),
		`campo ${fixedField}, longe ${farGrab}, perto ${nearGrab[0]} base ${px(nearGrab[1])},${px(nearGrab[2])}`,
	);
	sw.Activated.Fire();
	flush();

	const mirror = switchOf("Mirror");
	const before = { move: L().move.homeX, aim: L().aim.homeX };
	mirror.Activated.Fire();
	flush();
	const after = { move: L().move.homeX, aim: L().aim.homeX };
	t = finger(L().viewW * 0.8, L().viewH * 0.6);
	press(t);
	const rightMoves = input.joystickActive && !input.aimStickActive;
	release(t);
	t = finger(L().viewW * 0.2, L().viewH * 0.6);
	press(t);
	const leftAims = input.aimStickActive && !input.joystickActive;
	release(t);
	check(
		"Left-handed: o analogico vai para a direita e o pad de mira para a esquerda, na geometria e no toque (bootstrap)",
		s.mirror === true &&
			before.move < L().viewW / 2 &&
			after.move > L().viewW / 2 &&
			after.aim < L().viewW / 2 &&
			rightMoves &&
			leftAims &&
			drawnMatches().length === 0,
		`analogico ${px(before.move)} -> ${px(after.move)}, mira ${px(before.aim)} -> ${px(after.aim)}; direita anda ${rightMoves}, esquerda mira ${leftAims}`,
	);
	mirror.Activated.Fire();
	flush();
	input.attackPressed = false;
	input.attackReleased = false;
}
closeSettings();
flush();
hud.unmount();
flush();

// ================================================================ 5. Controls: what each scheme promises, and the bootstrap

console.log("\n5) Controls: cada linha de cada esquema e uma tecla que o bootstrap real atende\n");

UIS.TouchEnabled = false;
UIS.MouseEnabled = true;
setViewport(1120, 630);
ctx.phase = "lobby";
closeSettings = showSettings(
	ctx,
	() => {},
	() => {},
);
flush();
openTab(2);
{
	const lists = [0, 1, 2].map(i => findIn(findIn(settingsRoot(), "Keys"), `List${i}`));
	const listed = lists.map(l =>
		l
			.GetDescendants()
			.filter(d => /^Row\d+$/.test(d.Name))
			.sort((a, b) => a.LayoutOrder - b.LayoutOrder)
			.map(r => findIn(r, "Legend")?.Text),
	);
	check(
		"Controls lista, para cada dispositivo, exatamente as teclas de SCHEMES (a mesma fonte do How to play)",
		SCHEMES.every((sc, i) => JSON.stringify(listed[i]) === JSON.stringify(sc.rows.map(r => r[0]))),
		listed.map(l => l.length).join(" / "),
	);
}
closeSettings();
flush();

/** every chip of every scheme -> a probe of the REAL bootstrap (or the HUD) that returns true when it does what it says */
const input = ctx.input;
function fresh() {
	input.beginFrame();
	for (const k of ["keyW", "keyA", "keyS", "keyD", "attackHeld"]) input[k] = false;
	input.moveX = 0;
	input.moveY = 0;
	input.moveMagnitude = 0;
}
const key = k => ({ UserInputType: Enum.UserInputType.Keyboard, KeyCode: Enum.KeyCode[k], Position: new Vector3() });
const mouse = t => ({ UserInputType: Enum.UserInputType[t], KeyCode: Enum.KeyCode.Unknown, Position: new Vector3() });
const stick = (k, x, y) => ({
	UserInputType: Enum.UserInputType.Gamepad1,
	KeyCode: Enum.KeyCode[k],
	Position: new Vector3(x, y, 0),
});
function tap(inputObj) {
	press(inputObj);
	release(inputObj);
}
/** a touch HUD, mounted for the rows that are HUD buttons */
function withTouchHud(fn) {
	UIS.TouchEnabled = true;
	UIS.MouseEnabled = false;
	ctx.phase = "playing";
	const h = new Hud(ctx);
	const calls = { bag: 0, menu: 0, action: 0 };
	h.onBackpack = () => calls.bag++;
	h.onPause = () => calls.menu++;
	h.onAction = () => calls.action++;
	h.mount();
	flush();
	try {
		return fn(h, calls);
	} finally {
		h.unmount();
		UIS.TouchEnabled = false;
		UIS.MouseEnabled = true;
		ctx.phase = "lobby";
		flush();
	}
}
const hudButton = name => ctx.hudLayer.GetDescendants().find(d => d.Name === name && d.ClassName === "TextButton");

const PROBES = {
	// ---- keyboard & mouse
	"W A S D": () => {
		fresh();
		press(key("W"));
		press(key("D"));
		boot.syncKeyboardMove();
		const ok = input.moveMagnitude === 1 && near(input.moveX, Math.SQRT1_2) && near(input.moveY, -Math.SQRT1_2);
		release(key("W"));
		release(key("D"));
		boot.syncKeyboardMove();
		return ok && input.moveMagnitude === 0;
	},
	Mouse: () => {
		fresh();
		UIS.InputChanged.Fire(mouse("MouseMovement"), false);
		ctx.cam.x = 0;
		ctx.cam.y = 0;
		const get = UIS.GetMouseLocation;
		UIS.GetMouseLocation = () => new Vector2(ctx.viewW / 2, ctx.viewH / 2 + 120);
		const down = boot.refreshAim(0, 0);
		UIS.GetMouseLocation = () => new Vector2(ctx.viewW / 2 + 120, ctx.viewH / 2);
		const right = boot.refreshAim(0, 0);
		UIS.GetMouseLocation = get;
		return input.aimMode === "mouse" && near(down, Math.PI / 2, 0.05) && near(right, 0, 0.05);
	},
	"Left click": () => {
		fresh();
		press(mouse("MouseButton1"));
		const ok = input.attackPressed && input.attackHeld;
		release(mouse("MouseButton1"));
		// a click that lands on a button is the button's (gameProcessedEvent), never a shot
		fresh();
		press(mouse("MouseButton1"), true);
		const onGui = input.attackPressed;
		release(mouse("MouseButton1"));
		return ok && !input.attackHeld && !onGui;
	},
	E: () => {
		fresh();
		tap(key("E"));
		return input.actionPressed;
	},
	R: () => {
		fresh();
		tap(key("R"));
		return input.reloadPressed;
	},
	"1 – 5": () => {
		const got = [];
		for (const k of ["One", "Two", "Three", "Four", "Five"]) {
			fresh();
			tap(key(k));
			got.push(input.weaponSlotPressed);
		}
		return got.join() === "0,1,2,3,4";
	},
	B: () => {
		fresh();
		tap(key("B"));
		return input.backpackPressed;
	},
	P: () => {
		fresh();
		tap(key("P"));
		return input.pausePressed;
	},
	// MP-23: the match scoreboard shows while Q is HELD (Tab is the Roblox player list's, UI-02)
	"Q (hold)": () => {
		fresh();
		press(key("Q"));
		const held = input.keyScoreboard === true;
		release(key("Q"));
		return held && input.keyScoreboard === false;
	},
	// ---- touch
	"Left thumb": () =>
		withTouchHud(() => {
			fresh();
			const l = boot.getTouchLayout();
			const t = finger(l.move.homeX + 30, l.move.homeY);
			press(t);
			const ok = input.joystickActive && near(input.joystickBaseX, l.move.homeX + 30);
			release(t);
			return ok && !input.joystickActive;
		}),
	"Right thumb": () =>
		withTouchHud(() => {
			fresh();
			const l = boot.getTouchLayout();
			const t = finger(l.aim.homeX, l.aim.homeY);
			press(t);
			t.Position = new Vector3(l.aim.homeX + 40, l.aim.homeY - BAR, 0);
			UIS.InputChanged.Fire(t, false);
			const ok = input.aimStickActive && input.aimMode === "touch" && near(input.aimAngle, 0, 0.05);
			release(t);
			return ok;
		}),
	"Let go": () =>
		withTouchHud(() => {
			fresh();
			const l = boot.getTouchLayout();
			const t = finger(l.aim.homeX, l.aim.homeY);
			press(t);
			const before = input.attackPressed;
			release(t);
			return !before && input.attackPressed && input.attackReleased;
		}),
	"Keep holding": () =>
		withTouchHud(() => {
			fresh();
			const l = boot.getTouchLayout();
			const t = finger(l.aim.homeX, l.aim.homeY);
			press(t);
			boot.refreshAim(0, 0);
			const early = input.attackHeld;
			setClock(getClock() + 0.3);
			boot.refreshAim(0, 0);
			const held = input.attackHeld;
			release(t);
			return !early && held && !input.attackHeld;
		}),
	USE: () =>
		withTouchHud((h, calls) => {
			hudButton("UseBtn").Activated.Fire();
			return calls.action === 1;
		}),
	RELOAD: () =>
		withTouchHud(() => {
			fresh();
			hudButton("ReloadBtn").Activated.Fire();
			return input.reloadPressed;
		}),
	"Tap a weapon": () =>
		withTouchHud(() => {
			fresh();
			const tile = ctx.hudLayer.GetDescendants().find(d => d.Name === "Slot2" && d.IsA("GuiButton"));
			tile?.Activated.Fire();
			return input.weaponSlotPressed === 1;
		}),
	BAG: () =>
		withTouchHud((h, calls) => {
			hudButton("BagBtn").Activated.Fire();
			return calls.bag === 1;
		}),
	MENU: () =>
		withTouchHud((h, calls) => {
			hudButton("MenuBtn").Activated.Fire();
			return calls.menu === 1;
		}),
	// ---- gamepad
	"Left stick": () => {
		fresh();
		UIS.InputChanged.Fire(stick("Thumbstick1", 1, 0), false);
		const ok = input.moveMagnitude === 1 && near(input.moveX, 1);
		UIS.InputChanged.Fire(stick("Thumbstick1", 0, 0), false);
		return ok && input.moveMagnitude === 0;
	},
	"Right stick": () => {
		fresh();
		ctx.cam.x = 0;
		ctx.cam.y = 0;
		UIS.InputChanged.Fire(stick("Thumbstick2", 0, -1), false);
		const ok = input.aimMode === "touch" && near(input.aimAngle, Math.PI / 2, 0.05);
		UIS.InputChanged.Fire(stick("Thumbstick2", 0, 0), false);
		input.aimMode = "mouse";
		return ok;
	},
	"RT / RB / A": () => {
		const ok = [];
		for (const k of ["ButtonR2", "ButtonR1", "ButtonA"]) {
			fresh();
			press(pad(k));
			ok.push(input.attackPressed && input.attackHeld);
			release(pad(k));
			ok.push(!input.attackHeld);
		}
		return ok.every(Boolean);
	},
	X: () => {
		fresh();
		tap(pad("ButtonX"));
		return input.actionPressed;
	},
	Y: () => {
		fresh();
		tap(pad("ButtonY"));
		return input.reloadPressed;
	},
	LB: () => {
		fresh();
		tap(pad("ButtonL1"));
		return input.backpackPressed;
	},
	Start: () => {
		fresh();
		tap(pad("ButtonStart"));
		return input.pausePressed;
	},
	// MP-23: Back / Select opens and closes the match scoreboard
	Back: () => {
		fresh();
		tap(pad("ButtonSelect"));
		return input.scoreboardPressed === true;
	},
	"D-pad": () => GuiService.GuiNavigationEnabled === true,
};
/**
 * NAV-B: `inputObj` (the pad's B, the keyboard's Backspace) backs out of the screen on top through the bootstrap's
 * real handler -- a Settings window opened in the lobby, closed by it as by its X (client/ui/backStack.ts)
 */
function backsOut(inputObj) {
	let backs = 0;
	const phase = ctx.phase;
	ctx.phase = "lobby";
	const close = showSettings(
		ctx,
		() => backs++,
		() => {},
	);
	flush();
	tap(inputObj);
	flush();
	close();
	flush();
	ctx.phase = phase;
	return backs === 1;
}
/** a scheme's note that promises a binding too */
const NOTE_PROBES = {
	"Right click also interacts; Backspace goes back in menus.": () => {
		fresh();
		tap(mouse("MouseButton2"));
		const rightClick = input.actionPressed;
		return rightClick && backsOut(key("Backspace"));
	},
	"Menus: the stick moves the focus ring, B goes back.": () =>
		GuiService.GuiNavigationEnabled === true && backsOut(pad("ButtonB")),
};
{
	const missing = [];
	const broken = [];
	let probed = 0;
	for (const sc of SCHEMES) {
		for (const [chip, what] of sc.rows) {
			const probe = PROBES[chip];
			if (probe === undefined) {
				missing.push(`${sc.title}: ${chip}`);
				continue;
			}
			probed++;
			if (!probe()) broken.push(`${sc.title}: "${chip}" -> ${what}`);
		}
		const noteProbe = NOTE_PROBES[sc.note];
		if (noteProbe !== undefined) {
			probed++;
			if (!noteProbe()) broken.push(`${sc.title}: nota "${sc.note}"`);
		}
	}
	fresh();
	check(
		"toda linha de SCHEMES tem uma sonda aqui (uma tecla nova sem teste falha)",
		missing.length === 0,
		missing.join(", ") || `${probed} linhas e notas`,
	);
	check(
		"...e cada uma faz o que promete no bootstrap real (teclado, mouse, toque, controle) e na HUD de toque",
		broken.length === 0,
		broken.join("; "),
	);
}

// ================================================================ 6. Defaults

console.log("\n6) Defaults: cada aba volta EXATAMENTE os seus campos, depois da pergunta\n");

/** a value of each field that is not its default */
function scrambled() {
	return {
		soundEffect: 0.15,
		bgm: 0.85,
		uiSize: 0.95,
		leftSize: 0.1,
		leftPos: 0.9,
		leftRelative: false,
		rightSize: 1,
		rightPos: 0.05,
		mirror: true,
		langType: 2,
	};
}
closeSettings = showSettings(
	ctx,
	() => {},
	() => {},
);
flush();
for (const [tab, page, label] of [
	[0, "Interface", "General"],
	[1, "Page1", "Touch controls"],
]) {
	openTab(tab);
	const d = defaultSettings();
	Object.assign(s, scrambled());
	const own = Object.values(ROWS)
		.filter(r => r.tab === tab && r.field !== undefined)
		.map(r => r.field);
	const action = findIn(findIn(settingsRoot(), page), "Defaults")?.FindFirstChild("SegValueC")
		? findIn(findIn(findIn(settingsRoot(), page), "Defaults"), "Action")
		: findIn(findIn(settingsRoot(), page), "Action");
	action.Activated.Fire();
	flush();
	let pop = layer.FindFirstChild("PopupOverlay");
	findIn(pop, "PopupBtn0").Activated.Fire();
	flush();
	const untouched = JSON.stringify(s) === JSON.stringify({ ...s, ...scrambled() });
	action.Activated.Fire();
	flush();
	pop = layer.FindFirstChild("PopupOverlay");
	findIn(pop, "PopupBtn1").Activated.Fire();
	flush();
	const wrong = [];
	for (const f of Object.keys(d)) {
		const want = own.includes(f) ? d[f] : scrambled()[f];
		if (s[f] !== want) wrong.push(`${f}=${s[f]} (esperado ${want})`);
	}
	check(
		`${label}: Cancel nao muda nada; Reset poe ${own.join(", ")} em defaultSettings() e nenhum outro campo`,
		untouched && wrong.length === 0,
		wrong.join(", ") || `${own.length} campos`,
	);
	// what the tab shows after the reset is the reset value
	if (tab === 0) {
		check(
			"...e as teclas da aba mostram os valores de volta (50%)",
			["SfxValue", "BgmValue", "UiSizeValue"].every(n => keyText(findIn(settingsRoot(), n)) === "50%"),
		);
	}
}
Object.assign(s, defaultSettings());
closeSettings();
flush();

// ================================================================ 7. About

console.log("\n7) About: os fatos sao os do codigo\n");

{
	let credits = 0;
	closeSettings = showSettings(
		ctx,
		() => {},
		() => credits++,
	);
	flush();
	openTab(3);
	const about = findIn(settingsRoot(), "About");
	const value = row => findIn(findIn(about, row), "Text", "TextLabel")?.Text;
	const creditsSrc = readFileSync(join(SRC, "client/ui/credits.ts"), "utf8");
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	check("Game: o nome do jogo (GAME_NAME de shared/module.ts)", value("Game") === GAME_NAME, value("Game"));
	check(
		"Inspired by: o original e o estudio, como a CON-01 e a tela de creditos dizem",
		value("Inspired") === "Dead Town (Lemon Puppy Games)" &&
			creditsSrc.includes('"Inspired by Dead Town"') &&
			creditsSrc.includes('"by Lemon Puppy Games"'),
		value("Inspired"),
	);
	check(
		"Mode: co-op com o teto de sobreviventes do servidor (MAX_PLAYERS)",
		value("Mode") === `Co-op, up to ${MAX_PLAYERS} survivors`,
		value("Mode"),
	);
	check(
		"Built with: roblox-ts, o compilador do projeto (package.json), como os creditos dizem",
		value("Built") === "roblox-ts" &&
			pkg.devDependencies["roblox-ts"] !== undefined &&
			creditsSrc.includes("roblox-ts"),
	);
	const open = findIn(about, "OpenCredits");
	open?.Activated.Fire();
	flush();
	check("Credits: o botao abre a pagina de creditos (no lobby)", open !== undefined && credits === 1);
	closeSettings();
	flush();
}

// ================================================================ 8. persistence

console.log("\n8) persistencia: salvo com o progresso, de volta num reload, saneado ao carregar\n");

{
	closeSettings = showSettings(
		ctx,
		() => {},
		() => {},
	);
	flush();
	openTab(0);
	saves.length = 0;
	delays.length = 0;
	setSlider("Sfx", 0.7, () => advance(0.05));
	const whileDragging = saves.length;
	advance(1.1);
	const afterASecond = saves.length;
	check(
		"arrastar um slider pede UM save a cada segundo no maximo (nao um por pixel), e o pede",
		whileDragging <= 1 && afterASecond >= 1 && afterASecond <= 2 && saves.every(r => r === "menu"),
		`${whileDragging} durante 14 passos, ${afterASecond} depois de 1 s`,
	);
	saves.length = 0;
	closeSettings();
	flush();
	check("fechar a Settings pede um save (nada se perde fechando o jogo logo depois)", saves.includes("menu"));
}
{
	// the report the client sends is ctx.save as JSON (saveClient.sendNow); the server keeps what sanitizeClientReport
	// reads, and a reload reads the stored document with sanitizeStoredSave
	const base = defaultSave();
	const mine = {
		...defaultSettings(),
		soundEffect: 0.35,
		bgm: 0,
		uiSize: 1,
		leftSize: 0.2,
		leftPos: 0.8,
		leftRelative: false,
		rightSize: 0.65,
		rightPos: 0.3,
		mirror: true,
		langType: 1,
	};
	const client = defaultSave();
	client.settings = { ...mine };
	const stored = sanitizeClientReport(JSON.parse(JSON.stringify(client)), base);
	const reloaded = sanitizeStoredSave(JSON.parse(JSON.stringify(stored)));
	check(
		"cada campo mudado passa pelo relatorio ao servidor e volta igual num reload",
		JSON.stringify(reloaded.settings) === JSON.stringify(mine),
		JSON.stringify(reloaded.settings),
	);
	const kept = defaultSave();
	kept.settings = { ...mine };
	resetRun(kept);
	check("New game (resetRun) guarda as configuracoes", JSON.stringify(kept.settings) === JSON.stringify(mine));

	/** garbage per field: out of range, the wrong type, NaN, missing */
	const bad = [];
	const d = defaultSettings();
	for (const f of Object.keys(d)) {
		const isBool = typeof d[f] === "boolean";
		const max = f === "langType" ? 3 : 1;
		const cases = isBool
			? [
					["texto", "yes", d[f]],
					["numero", 1, d[f]],
					["ausente", undefined, d[f]],
				]
			: [
					["acima", 7, max],
					["abaixo", -3, 0],
					["texto", "0.4", d[f]],
					["NaN", NaN, d[f]],
					["ausente", undefined, d[f]],
				];
		for (const [label, v, want] of cases) {
			const doc = { settings: { ...d, [f]: v } };
			if (v === undefined) delete doc.settings[f];
			const loaded = sanitizeStoredSave(doc).settings[f];
			const reported = sanitizeClientReport(doc, base).settings[f];
			if (loaded !== want || reported !== want)
				bad.push(`${f} ${label}: carga ${loaded}, relatorio ${reported}, esperado ${want}`);
		}
	}
	check(
		"lixo em qualquer campo (fora da faixa, tipo errado, NaN, ausente) e grampeado ou cai no padrao, na carga E no relatorio",
		bad.length === 0,
		bad.join("; ") || `${Object.keys(d).length} campos x 3-5 casos`,
	);
	check(
		"settings nao-tabela (lixo inteiro) vira defaultSettings()",
		JSON.stringify(sanitizeStoredSave({ settings: "x" }).settings) === JSON.stringify(d),
	);
}
{
	// a save loaded from the server replaces ctx.save (main.client.ts applyLoad): the mixer reads the NEW settings on
	// the next frame, and the next HUD mount the new touch prefs and HUD size
	const old = ctx.save;
	const loaded = defaultSave();
	loaded.settings = { ...defaultSettings(), soundEffect: 0.2, bgm: 0.1, mirror: true, uiSize: 1 };
	ctx.save = loaded;
	frame();
	const mixed =
		near(group("sfx").Volume, gainOf("sfx", 0.2), 1e-9) && near(group("bgm").Volume, gainOf("bgm", 0.1), 1e-9);
	UIS.TouchEnabled = true;
	ctx.phase = "playing";
	const h2 = new Hud(ctx);
	h2.mount();
	flush();
	const mirrored = boot.getTouchLayout().mirrored === true;
	const console1 = hudW("Console");
	h2.unmount();
	UIS.TouchEnabled = false;
	ctx.phase = "lobby";
	flush();
	check(
		"um save carregado vale na hora: o mixer le os volumes novos no proximo quadro, a HUD o lado e o tamanho ao montar",
		mixed && mirrored && console1 !== undefined,
		`mixer ${mixed}, canhoto ${mirrored}`,
	);
	ctx.save = old;
	frame();
}

// ================================================================ 9. Reduce motion

console.log("\n9) Reduce motion: segue a configuracao do Roblox, so leitura\n");

{
	closeSettings = showSettings(
		ctx,
		() => {},
		() => {},
	);
	flush();
	openTab(0);
	const row = rowOf("Motion");
	const before = JSON.stringify(ctx.save);
	const off = keyText(row);
	GuiService.ReducedMotionEnabled = true;
	flush();
	const on = keyText(row);
	GuiService.ReducedMotionEnabled = false;
	flush();
	check(
		"a tecla diz Off / On acompanhando o GuiService.ReducedMotionEnabled ao vivo, e nao escreve nada no save",
		off === "Off" && on === "On" && keyText(row) === "Off" && JSON.stringify(ctx.save) === before,
		`${off} -> ${on} -> ${keyText(row)}`,
	);
	check("...e nao e um controle: nenhum botao na linha", !row.GetDescendants().some(d => d.IsA("GuiButton")));
	closeSettings();
	flush();
}

console.log("");
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
}
console.log(
	"OK: toda linha da Settings faz o que diz no jogo -- som, HUD, toque, teclas, padroes, fatos, save e Reduce Motion",
);
