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
 *   3. HUD SIZE        the console (with the day clock and the scoreboard's chip in it), the E hint, the banner and
 *                      the message feed of a mounted HUD are 80%..120% by the slider -- the banner right under the
 *                      bar at every size, the feed under it; the Touch tab's preview console follows it too, and so
 *                      does the first-run coach when the size changes in the middle of a run.
 *   4. TOUCH           each slider and switch moves the geometry the bootstrap hit-tests (getTouchLayout), the HUD's
 *                      touch layer is redrawn on it, the preview is that very layout (under a real top bar too), a
 *                      fixed stick is only grabbed at its home, and left-handed swaps which half moves.
 *   5. CONTROLS        the device radio lists SCHEMES and opens on the device in use (UserInputService.PreferredInput);
 *                      every row of every scheme is a binding the real bootstrap
 *                      honours (probed through its InputBegan / InputChanged / InputEnded handlers and the HUD's
 *                      touch buttons). A tip that promises a key that does nothing fails here.
 *   6. DEFAULTS        each tab's Defaults puts EXACTLY that tab's fields back to defaultSettings(), after the
 *                      question; Cancel changes nothing.
 *   7. ABOUT           the facts are the code's: the game's name, the original credited (CON-01), MAX_PLAYERS, the
 *                      toolchain, the version (package.json, one source), the way to the credits (and none over a run).
 *   8. PERSISTENCE     a change asks for one save a second at most and one on leaving; the settings survive the
 *                      server's report sanitiser and a reload, and garbage or out-of-range values are clamped; a change
 *                      made before the server's save arrived survives it (carried field by field).
 *   9. REDUCE MOTION   the read-only row follows the Roblox setting live and writes nothing.
 *  10. ...EVERYWHERE   what the row promises holds in the whole game: with it on, every tween the logo, the kit and the
 *                      fades create is 0 s long and the nameplate does not pop; skin.ts motionTween is the only
 *                      TweenService.Create in src/; every periodic pulse of the interface is gated by it (the HUD's
 *                      own pulses are measured frame by frame in test:hud).
 *  11. GRAPHICS        the Segmented (Auto / High / Low) writes the field and opens on it; High and Low are the tier
 *                      the run draws with (client/view/quality.ts: the light map's strips, the particle budget), Auto
 *                      is the measured one; the game loop reads it every frame (the hysteresis itself: test:light).
 *
 * Pure Node (>= 18) plus the project's TypeScript.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { installUiShims } from "./ui-shim.mjs";

const ui = installUiShims({ seed: 1, viewport: [1120, 630] });
const { SRC, ROOT, require, flush, service, setViewport, setClock, getClock, makeInstance } = ui;

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
	Graphics: { tab: 0, field: "graphics", effect: "11) o nivel de qualidade: as tiras da noite e as particulas" },
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
// the day clock and the scoreboard's chip are parts of the console now (UI-09, MP-23): they scale with it
const HUD_PARTS = ["Console", "HintBox", "BannerBox", "Feed"];
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
	for (const n of ["BannerBox", "Feed"]) out.spans[n] = hudSpan(n);
	out.inConsole = ["Sky", "ChipSlot"].every(n =>
		hudPart("Console")
			?.GetDescendants()
			.some(d => d.Name === n),
	);
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
		"HUD size 0% -> 100% do slider: console (com o relogio e o chip do placar), dica E, faixa de aviso e mensagens crescem de 80% para 120%",
		wrong.length === 0 && small.inConsole && big.inConsole,
		HUD_PARTS.map(n => `${n} x${small[n] === undefined ? "?" : ratio(n).toFixed(3)}`).join(", "),
	);
	const mid = mountedSizes(0.5);
	check(
		"...e o padrao (50%) e o tamanho de desenho (x1,0)",
		near(mid.Console * DESIGN_W, 778, 1e-6),
		`console ${px(mid.Console * DESIGN_W)} unidades`,
	);
	// top down: the banner right under the bar (the top centre is the messages' since the day plate moved into the
	// console), the feed under the banner -- at every size, the banner at the same top, none on another
	const stacked = [small, mid, big].every(
		m =>
			near(m.spans.BannerBox[0], small.spans.BannerBox[0], 1e-6) &&
			m.spans.BannerBox[1] <= m.spans.Feed[0] + 1e-6,
	);
	check(
		"...e em todo tamanho a faixa de aviso fica logo abaixo da barra e as mensagens sob ela, sem se cobrir",
		stacked && near(small.spans.BannerBox[0], 20, 1e-6),
		[small, mid, big]
			.map(m => ["BannerBox", "Feed"].map(n => m.spans[n].map(v => v.toFixed(0)).join("-")).join(" | "))
			.join(" ;; "),
	);
	ctx.phase = "lobby";
	s.uiSize = 0.5;
}
{
	// the first-run coach is part of the HUD: a HUD size changed during the run (Settings over the run) resizes it on
	// its next frame, saying the same thing -- it used to keep the size of the run's start (onboarding/coach.ts)
	const { Coach } = require(join(SRC, "client/onboarding/coach.ts"));
	const { createWorld } = require(join(SRC, "shared/game/world.ts"));
	ctx.phase = "playing";
	s.uiSize = 0;
	const refs = {
		world: createWorld(4000, 4000),
		player: { x: 1000, y: 1000, dead: false },
		zombies: [],
		bosses: [],
		save: ctx.save,
		daynight: { dayTime: 9 },
		input: { held: false },
	};
	const coach = new Coach(ctx);
	coach.start(refs, () => {});
	flush();
	const box = () => ctx.hudLayer.FindFirstChild("Coach");
	const title = () => findIn(box(), "Title", "TextLabel")?.Text;
	const small = box().Size.X.Scale;
	const said = title();
	coach.update(refs, 1 / 60);
	const sameSize = box().Size.X.Scale === small;
	s.uiSize = 1;
	coach.update(refs, 1 / 60);
	flush();
	const big = box().Size.X.Scale;
	check(
		"o coach da primeira partida segue o HUD size mudado no meio da partida (80% -> 120%), dizendo o mesmo",
		sameSize && near(big / small, 1.2 / 0.8, 1e-6) && title() === said && said !== "",
		`x${(big / small).toFixed(3)}, "${said}" -> "${title()}"`,
	);
	coach.stop();
	s.uiSize = 0.5;
	ctx.phase = "lobby";
	flush();
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
	// the tenth row (ITM-07's quick heal / eat) fits the page without scrolling; an eleventh would not -- so the bound is
	// real, and a row added past it fails here instead of hiding the last keys below the fold
	const { keyListFits } = require(join(SRC, "client/ui/settings.ts"));
	const most = Math.max(...SCHEMES.map(sc => sc.rows.length));
	check(
		`...e cabem sem rolar: ${most} linhas no dispositivo mais longo (a pagina tem lugar para ${most}, nao para ${most + 1})`,
		most === 10 && SCHEMES.every(sc => keyListFits(sc.rows.length)) && !keyListFits(most + 1),
		SCHEMES.map(sc => `${sc.title} ${sc.rows.length}`).join(", "),
	);
}
closeSettings();
flush();
// the device it opens on is the one the player is using (UserInputService.PreferredInput, client/ui/device.ts)
{
	const opensOn = [];
	for (const p of ["KeyboardAndMouse", "Touch", "Gamepad"]) {
		UIS.PreferredInput = Enum.PreferredInput[p];
		flush();
		const close = showSettings(
			ctx,
			() => {},
			() => {},
		);
		flush();
		openTab(2);
		const lists = [0, 1, 2].map(i => findIn(findIn(settingsRoot(), "Keys"), `List${i}`));
		const shownAt = lists.findIndex(l => {
			for (let n = l; n !== undefined && n.IsA("GuiObject"); n = n.Parent) if (!n.Visible) return false;
			return true;
		});
		opensOn.push(shownAt);
		close();
		flush();
	}
	UIS.PreferredInput = undefined;
	flush();
	check(
		"Controls abre no dispositivo em uso (PreferredInput): teclado, toque, controle",
		JSON.stringify(opensOn) === JSON.stringify([0, 1, 2]),
		opensOn.join(", "),
	);
}

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

/** a keyboard/gamepad HUD, mounted for the match scoreboard's rows (MP-23): not touch, so the desktop bindings apply */
function withScoreboardHud(fn) {
	ctx.phase = "playing";
	const h = new Hud(ctx);
	h.mount();
	flush();
	try {
		return fn(h);
	} finally {
		h.unmount();
		ctx.phase = "lobby";
		flush();
	}
}
/** enough of a HudState for Hud.update() to run (the scoreboard reads none of it) */
const SCORE_HUD_STATE = {
	hp: 100,
	hpMax: 100,
	hunger: 100,
	hungerMax: 100,
	level: 1,
	exp: 0,
	expMax: 100,
	day: 1,
	lifeDay: 1,
	dayTime: 12,
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
};

/**
 * (ITM-07) The quick-use chain after the field: `kind` read by the client's real press (client/systems/quickUse.ts
 * pressQuick, a fresh state: no cooldown carried from another probe) through the Bag's own verb (backpackSync.useItem,
 * offline here: the local rule) -- a hurt, hungry survivor with one Bandage and one Canned food is healed or fed by it.
 */
const QU = require(join(SRC, "client/systems/quickUse.ts"));
const BagSync = require(join(SRC, "client/net/backpackSync.ts"));
const { USABLES } = require(join(SRC, "shared/data/usables.ts"));
const { createPlayer } = require(join(SRC, "shared/game/player.ts"));
function quickChain(kind) {
	if (kind < 0) return false;
	const save = defaultSave();
	for (let i = 0; i < save.invenUse.length; i++) save.invenUse[i] = 0;
	const bandage = USABLES.findIndex(u => u.name === "Bandage");
	const can = USABLES.findIndex(u => u.name === "Canned food");
	save.invenUse[bandage] = 1;
	save.invenUse[can] = 1;
	const body = createPlayer(save, 0, 0);
	body.hp = 50;
	body.hungry = 30;
	const said = [];
	const res = QU.pressQuick(
		kind,
		body,
		save,
		1000,
		{ send: id => BagSync.useItem(body, save, id), say: t => said.push(t), heard: () => {}, tr: t => t },
		new QU.QuickUse(),
	);
	if (kind === 0) return res.used && body.hp === 70 && save.invenUse[bandage] === 0 && said[0] === "+20 HP";
	return res.used && body.hungry === 55 && save.invenUse[can] === 0 && said[0] === "+25 FOOD · +5 HP";
}

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
	// ITM-07: H heals and F eats, through the quick plates' press and the Bag's own verb
	"H / F": () => {
		fresh();
		tap(key("H"));
		const heal = input.quickUsePressed;
		const healed = quickChain(heal);
		fresh();
		tap(key("F"));
		const eat = input.quickUsePressed;
		return heal === 0 && eat === 1 && healed && quickChain(eat);
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
	"Q (hold)": () =>
		withScoreboardHud(h => {
			fresh();
			const board = h.scoreboard();
			press(key("Q"));
			h.update(SCORE_HUD_STATE);
			const openWhileHeld = board.isOpen();
			release(key("Q"));
			h.update(SCORE_HUD_STATE);
			return openWhileHeld && !board.isOpen();
		}),
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
	// ITM-07: the touch quick tiles (hudQuick.ts QuickDeck): a tap is H / F
	"Tap heal / food": () =>
		withTouchHud(() => {
			fresh();
			hudButton("QuickHeal").Activated.Fire();
			const heal = input.quickUsePressed;
			fresh();
			hudButton("QuickEat").Activated.Fire();
			const eat = input.quickUsePressed;
			return heal === 0 && eat === 1 && quickChain(heal) && quickChain(eat);
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
	Back: () =>
		withScoreboardHud(h => {
			fresh();
			const board = h.scoreboard();
			// main.client.ts's heartbeat turns the one-shot press into a toggle (Q's chip is the HUD's own, held)
			tap(pad("ButtonSelect"));
			if (input.scoreboardPressed) h.toggleScoreboard();
			h.update(SCORE_HUD_STATE);
			const openedOnPress = board.isOpen();
			fresh();
			tap(pad("ButtonSelect"));
			if (input.scoreboardPressed) h.toggleScoreboard();
			h.update(SCORE_HUD_STATE);
			return openedOnPress && !board.isOpen();
		}),
	// ITM-06: in a match the D-pad steps through the weapons (left the previous, right the next: combat.ts cycleWeapon);
	// with a menu holding the pad it is that menu's navigation and switches nothing
	"D-pad left / right": () => {
		fresh();
		tap(pad("DPadLeft"));
		const left = input.weaponCycle;
		fresh();
		tap(pad("DPadRight"));
		const right = input.weaponCycle;
		fresh();
		const probe = new Instance("TextButton");
		probe.Selectable = true;
		GuiService.SelectedObject = probe;
		tap(pad("DPadRight"));
		const inMenu = input.weaponCycle;
		GuiService.SelectedObject = undefined;
		probe.Destroy();
		fresh();
		return left === -1 && right === 1 && inMenu === 0 && GuiService.GuiNavigationEnabled === true;
	},
	// ITM-07: up heals, down eats (the order of the HP and FOOD bars); in a menu the D-pad is its navigation
	"D-pad up / down": () => {
		fresh();
		tap(pad("DPadUp"));
		const up = input.quickUsePressed;
		const healed = quickChain(up);
		fresh();
		tap(pad("DPadDown"));
		const down = input.quickUsePressed;
		const fed = quickChain(down);
		fresh();
		const probe = new Instance("TextButton");
		probe.Selectable = true;
		GuiService.SelectedObject = probe;
		tap(pad("DPadUp"));
		const inMenu = input.quickUsePressed;
		GuiService.SelectedObject = undefined;
		probe.Destroy();
		fresh();
		return up === 0 && down === 1 && healed && fed && inMenu === -1;
	},
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
	"Menus: the stick or D-pad moves the focus ring, B goes back.": () =>
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
		// a note that names a device's keys is probed too: one with no probe here is a promise nobody checks
		if (noteProbe === undefined && sc.title !== "Touch") missing.push(`${sc.title}: nota "${sc.note}"`);
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
		graphics: 2,
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
	const moduleSrc = readFileSync(join(SRC, "shared/module.ts"), "utf8");
	check(
		"Inspired by: so o nome do original, sem estudio (CON-01), o mesmo da tela de creditos",
		value("Inspired") === "Dead Town" &&
			moduleSrc.includes('INSPIRED_BY = "Dead Town"') &&
			creditsSrc.includes('"Inspired by the original"') &&
			creditsSrc.includes("INSPIRED_BY") &&
			!/Lemon Puppy/.test(creditsSrc),
		value("Inspired"),
	);
	check(
		"Mode: co-op com o teto de sobreviventes do servidor (MAX_PLAYERS)",
		value("Mode") === `Co-op, up to ${MAX_PLAYERS} survivors`,
		value("Mode"),
	);
	check(
		"Developed by: Luvitlua (shared/module.ts), como os creditos dizem; nenhuma ferramenta ou empresa",
		value("Developer") === "Luvitlua" &&
			moduleSrc.includes('DEVELOPER = "Luvitlua"') &&
			creditsSrc.includes('"Developed by"') &&
			creditsSrc.includes("DEVELOPER") &&
			!/roblox-ts|Yoyo|Lemon Puppy/.test(creditsSrc),
		value("Developer"),
	);
	// the version, from ONE source: package.json -> shared/version.ts (`npm run stamp`), "dev" builds show it bare and a
	// CI build names its commit; the committed file must be what the generator writes from package.json today
	const V = require(join(SRC, "shared/version.ts"));
	const versionFile = readFileSync(join(SRC, "shared/version.ts"), "utf8");
	check(
		"Version: a versao do package.json (a fonte unica, por shared/version.ts), com o commit num build da CI",
		value("Version") === (V.GAME_BUILD === "dev" ? pkg.version : `${pkg.version} (${V.GAME_BUILD})`) &&
			V.GAME_VERSION === pkg.version &&
			versionFile.includes(`GAME_VERSION = "${pkg.version}"`) &&
			/^\d+\.\d+\.\d+$/.test(pkg.version),
		value("Version"),
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
		graphics: 1,
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
		const max = f === "langType" ? 3 : f === "graphics" ? 2 : 1;
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
	// changed BEFORE the server's save arrived (the lobby is shown on a fallback save while the LoadAck is on its way):
	// the LoadAck used to put every field back to the stored one. Now what the player touched is carried over, field
	// by field, and what they did not comes from the save (shared/game/save.ts carrySettings, main.client.ts applyLoad)
	const base = defaultSettings();
	const mine = { ...base, bgm: 0, mirror: true };
	const stored = { ...defaultSettings(), soundEffect: 0.9, uiSize: 1, bgm: 0.7 };
	const into = { ...stored };
	const carried = saveMod.carrySettings(mine, base, into);
	check(
		"um ajuste feito antes de o save do servidor chegar sobrevive a ele: o que o jogador mexeu fica, o resto vem do save",
		carried &&
			into.bgm === 0 &&
			into.mirror === true &&
			into.soundEffect === 0.9 &&
			into.uiSize === 1 &&
			into.leftSize === stored.leftSize,
		JSON.stringify(into),
	);
	check("...e sem nada mexido nada e carregado", !saveMod.carrySettings({ ...base }, base, { ...stored }));
	const main = readFileSync(join(SRC, "client/main.client.ts"), "utf8");
	const at = main.indexOf("function applyLoad(");
	const body = main.slice(at, main.indexOf("\n}\n", at));
	const carryAt = body.indexOf("carrySettings(ctx.save.settings, settingsBase, info.save.settings)");
	const swapAt = body.indexOf("ctx.save = info.save;");
	check(
		"...e applyLoad (main.client.ts) carrega ANTES de trocar o save, so de um save que nao era do servidor, e o relata",
		carryAt >= 0 &&
			swapAt > carryAt &&
			/\(loadInfo === undefined \|\| !loadInfo\.persist\) &&/.test(body) &&
			/if \(carried\) net\.requestSave\("menu"\)/.test(body) &&
			/settingsBase = \{ \.\.\.info\.save\.settings \}/.test(body),
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

// ================================================================ 10. Reduce motion, everywhere the row says

console.log("\n10) Reduce motion em todo o jogo: todo tween sem duracao, nenhum pulo nem pulso\n");

{
	// every TweenService.Create of the game, with the duration it asked for (the shim lands every tween at once, so
	// the duration is the only thing that tells an eased fade from a cut)
	const TS = service("TweenService");
	const made = [];
	const create = TS.Create;
	TS.Create = (obj, info, props) => {
		made.push({ obj, time: info.args[0], props });
		return create(obj, info, props);
	};
	const { showLogo } = require(join(SRC, "client/ui/logo.ts"));
	const { Nameplate } = require(join(SRC, "client/ui/nameplate.ts"));
	const { tween, fadeText } = require(join(SRC, "client/ui/widgets.ts"));
	const run = () => {
		made.length = 0;
		// the splash: its title fades in (the subtitle follows 0,35 s later, a task.delay the shim does not run)
		showLogo(layer, () => {});
		flush();
		layer.FindFirstChild("Logo")?.Destroy();
		// the nameplate's level-up pop
		const host = makeInstance("Frame", false);
		const plate = new Nameplate(host, 1, { displayName: "Ana", name: "Ana" });
		plate.update(10, 10, 1, true);
		plate.update(10, 10, 2, true);
		const pops = made.filter(m => m.props.Scale !== undefined).length;
		plate.destroy();
		// the kit's own entry points
		const f = makeInstance("Frame", false);
		tween(f, 0.3, { BackgroundTransparency: 0.5 });
		const l = makeInstance("TextLabel", false);
		fadeText(l, 0.4, 0);
		return { times: made.map(m => m.time), pops };
	};
	const eased = run();
	GuiService.ReducedMotionEnabled = true;
	flush();
	const cut = run();
	GuiService.ReducedMotionEnabled = false;
	flush();
	TS.Create = create;
	check(
		"sem Reduce Motion: o logo esmaece, a placa de nome da o pulo do nivel, o kit anima (o controle do teste)",
		eased.times.length >= 4 && eased.times.every(t => t > 0) && eased.pops === 1,
		`duracoes ${eased.times.join(", ")}; pulos ${eased.pops}`,
	);
	check(
		"com Reduce Motion: todo tween (logo, kit, fades) tem duracao 0, e a placa de nome nao pula",
		cut.times.length >= 3 && cut.times.every(t => t === 0) && cut.pops === 0,
		`duracoes ${cut.times.join(", ")}; pulos ${cut.pops}`,
	);

	// nothing in src/ builds a tween of its own: skin.ts motionTween is the one TweenService.Create, so Reduce Motion
	// is honoured in one place; and every periodic pulse of the interface is gated by it
	const walk = dir =>
		readdirSync(dir).flatMap(n => {
			const p = join(dir, n);
			return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
		});
	const rogue = [];
	for (const file of walk(SRC)) {
		const text = readFileSync(file, "utf8");
		const rel = file.slice(SRC.length + 1);
		const creates = (text.match(/TweenService\.Create\(|new TweenInfo\(/g) ?? []).length;
		if (creates > 0 && !(rel === join("client", "ui", "skin.ts") && creates === 2))
			rogue.push(`${rel} (${creates})`);
	}
	check(
		"um tween so em todo src/: skin.ts motionTween (nenhum TweenService.Create / TweenInfo fora dele)",
		rogue.length === 0,
		rogue.join(", "),
	);
	const PULSES = [
		["client/ui/hud.ts", /reducedMotion\(\) \? 0 : 0\.15 \* math\.sin\(now \* 4\)/, "a vinheta de HP baixa"],
		["client/ui/hudConsole.ts", /const still = W\.reducedMotion\(\);/, "o pisca das barras de HP e fome"],
		["client/ui/hudSky.ts", /W\.reducedMotion\(\) \|\| math\.floor\(now \* PULSE_HZ \* 2\) % 2 === 0/, "o relogio"],
		[
			"client/onboarding/coach.ts",
			/reducedMotion\(\) \? 0 : math\.sin\(os\.clock\(\) \* 4\) \* 4/,
			"a seta do coach",
		],
		[
			"client/view/allyPlate.ts",
			/reducedMotion\(\) \? 0\.45 : 0\.45 \+ 0\.3 \* math\.sin/,
			"o anel do aliado caido",
		],
		[
			"client/ui/dangerFlash.ts",
			/reducedMotion\(\) \? \(strength > 0 \? 1 : 0\) : strength/,
			"o flash sobre os menus",
		],
	];
	const ungated = PULSES.filter(([f, re]) => !re.test(readFileSync(join(SRC, f), "utf8"))).map(([, , what]) => what);
	check(
		"todo pulso periodico da interface para com Reduce Motion (vinheta, barras, relogio, seta do coach, anel, flash)",
		ungated.length === 0,
		ungated.join(", "),
	);
}

// ================================================================ 11. Graphics

console.log("\n11) Graphics: Auto / High / Low e o nivel com que a partida desenha\n");

{
	const Q = require(join(SRC, "client/view/quality.ts"));
	const { LightMap, lightStripHeight } = require(join(SRC, "shared/engine/renderer.ts"));
	const { ParticleSystem } = require(join(SRC, "client/systems/particles.ts"));
	const { Camera } = require(join(SRC, "shared/engine/camera.ts"));
	s.graphics = 2;
	closeSettings = showSettings(
		ctx,
		() => {},
		() => {},
	);
	flush();
	openTab(0);
	const row = rowOf("Graphics");
	const segs = [0, 1, 2].map(i => findIn(row, `Tab${i}`, "TextButton"));
	const active = () => segs.findIndex(b => b?.GetAttribute("Variant") === "tabActive");
	check(
		"a linha Graphics e um Segmented de tres chapas, Auto / High / Low (pela lang.ts), e abre no valor salvo",
		segs.every(b => b !== undefined) &&
			segs.map(b => b.Text).join("/") === "Auto/High/Low" &&
			Q.GRAPHICS_OPTIONS.join("/") === "Auto/High/Low" &&
			active() === 2,
		`${segs.map(b => b?.Text).join("/")}, ativa ${active()}`,
	);
	saves.length = 0;
	delays.length = 0;
	const picked = [];
	for (const i of [1, 0, 2]) {
		segs[i].Activated.Fire();
		flush();
		picked.push(`${s.graphics}:${active()}`);
	}
	advance(1.1);
	check(
		"tocar numa chapa escreve o campo (0 Auto, 1 High, 2 Low), acende ela e pede um save",
		picked.join(",") === "1:1,0:0,2:2" && saves.includes("menu"),
		`${picked.join(", ")}; saves ${saves.length}`,
	);
	// what each value draws with: the tier is what the run's light map and particles are given (gameLoop below)
	const stripsAt = graphics => {
		const lm = new LightMap(makeInstance("Frame", false), { R: 0, G: 0, B: 0 });
		lm.setLowDetail(Q.lowDetail(graphics));
		const cam = new Camera();
		cam.setView(1920, 1080);
		lm.update(cam, 0.85, [{ x: 0, y: 0, r: 250, inner: 0.4 }]);
		return lm.stats.strips;
	};
	const bornAt = graphics => {
		const p = new ParticleSystem();
		p.lowDetail = Q.lowDetail(graphics);
		for (let i = 0; i < 60; i++) p.bloodBurst(0, 0, 10, "zombie");
		let n = 0;
		for (const _p of p.active()) n++;
		return n;
	};
	const hi = { strips: stripsAt(1), born: bornAt(1) };
	const lo = { strips: stripsAt(2), born: bornAt(2) };
	const auto = { strips: stripsAt(0), born: bornAt(0) };
	check(
		"High: a noite em tiras de 8 px a 1080p (135) e ate 320 particulas; Low: tiras de 12 px (90) e ate 160",
		hi.strips === Math.ceil(1080 / lightStripHeight(1080, false)) &&
			hi.strips === 135 &&
			lo.strips === 90 &&
			hi.born === 320 &&
			lo.born === 160,
		`High ${hi.strips} tiras ${hi.born} particulas; Low ${lo.strips} tiras ${lo.born} particulas`,
	);
	check(
		"Auto (sem quadro lento medido) desenha como High; o nivel medido e o de client/view/quality.ts (test:light)",
		auto.strips === hi.strips && auto.born === hi.born && Q.lowDetail(0) === false,
		`Auto ${auto.strips} tiras ${auto.born} particulas`,
	);
	const loopSrc = readFileSync(join(SRC, "client/gameLoop.ts"), "utf8");
	check(
		"...e a partida le o campo a cada quadro: update() mede e da o nivel as particulas, drawLight() ao mapa de luz",
		/this\.particles\.lowDetail = Quality\.qualityFrame\(dt, ctx\.save\.settings\.graphics\)/.test(loopSrc) &&
			/this\.lightMap\.setLowDetail\(Quality\.lowDetail\(save\.settings\.graphics\)\)/.test(loopSrc),
	);
	s.graphics = 0;
	closeSettings();
	flush();
}

console.log("");
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
}
console.log(
	"OK: toda linha da Settings faz o que diz no jogo -- som, HUD, toque, teclas, padroes, fatos, save, Reduce Motion e Graphics",
);
