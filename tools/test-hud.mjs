#!/usr/bin/env node
/*
 * The in-run HUD (docs/DESIGN_RULES.md UI-09): the console at the bottom centre, with the day clock (the sky) at its
 * left end -- on touch, in its own plate in the top corner, under Menu and Bag.
 *
 *   npm run test:hud
 *   PZ_SRC=<another checkout>/src node tools/test-hud.mjs    (measures that version)
 *
 * The HUD updates EVERY frame, so the owner's rule for the Bag (test:backpack: "it should be instant") is stricter
 * here: after mount, `update()` creates and destroys nothing, whatever moves -- HP, food, XP, the magazine, a reload,
 * the night, a hit. This runs the REAL hud.ts / hudConsole.ts / widgets.ts / plate.ts / theme.ts and the REAL
 * client/bootstrap.ts (its key handler and its touch geometry) under Node, over the counted fake Instance tree of
 * tools/ui-shim.mjs, and checks:
 *
 *  1. mount, then 600 frames with everything changing: zero Instances created or destroyed, and a frame whose
 *     state did not change writes nothing;
 *  2. the hotbar is exactly `ownedWeapons` (client/systems/combat.ts, what keys 1-5 pick) 1-5, in order, the
 *     weapon in hand blue and raised, an owned one dark and flat, a key with no weapon an empty socket; a weapon
 *     picked up appears in its slot rewriting the tiles in place;
 *  3. clicking tile k writes the field key k writes (InputState.weaponSlotPressed, through bootstrap's real
 *     InputBegan handler), and the Bag / Menu plates call what B / P call;
 *  4. the texts: "HP 88 / 100", "FOOD 58 / 100", "LV 3 · 30 / 120", the ammo chip -- and the sky (4b): the world's
 *     day, the countdown to nightfall ("Night in 2:14") and at night to daybreak, in real seconds, the sun / moon on
 *     its arc and the horde's pips, the red pulse of the last 30 s (still with Reduce Motion), and the life's day only
 *     when it differs from the world's (MP-13 / MP-20); the weather's pixel icon (LUZ-05: rain, storm, fog while there
 *     is fog, nothing on a clear day), never on the sun's path, on the desktop and the touch sky, without churn; no
 *     text carries a contour (UI-04); with Reduce Motion
 *     nothing throbs: low HP holds its fill lit, low food holds it red, the low-HP vignette holds one value;
 *  4c. a hit lights the HP bar's relief and the damage vignette -- in a server session (MP_PHASE 2) too, where the
 *     bite is the server's: its own self block, over the wire format, read back by the client's prediction;
 *  4d. DESIGN_RULES VIT-01's cue (hudRegen.ts): a soft glow round the HP bar while the body heals (in with the ramp,
 *     outside the groove so the label keeps its plate), nothing during the wait after a hit, a fork on the FOOD bar
 *     while only food stands in the way (in a fight too, and starving; it starts where the bar turns red), popping
 *     once; Reduce Motion holds the glow and drops the pop; 600 frames through every phase create nothing, a steady
 *     frame writes nothing;
 *  5. touch: the compact console never covers the move stick or the fire controls, measured on the touch layout's
 *     own numbers (shared/engine/input.ts), at 1120x630 ("phone") and 1360x435 (wide), with the default controls,
 *     left-handed, at the largest sizes and with a fixed stick -- and its tiles stay a thumb wide; the sky's touch
 *     plate sits under the row of Menu and Bag and covers nothing -- the thumbs, Menu, Bag, the console, nor the
 *     banner and feed over the top centre (phones included, and a crowded one); the match scoreboard's chip (MP-23)
 *     is in that row, left of Menu (desktop: the third plate of the console's row, after Bag and Menu), a thumb
 *     target, and covers nothing either -- the sky included; and at the largest HUD size the banner is 1,2x, still
 *     at the top, and still narrows off the corner.
 *  5b. the three ScreenGuis (client/bootstrap.ts): the world's covers the whole screen (ScreenInsets.None), the HUD's and
 *     the menus' the device safe area, drawn world < HUD < menus; the menus' one is off in a run with nothing open and
 *     a toast or the hit flash turn it on; and on a phone with a notch (both sides, or one) the move stick and the aim
 *     pad are hit exactly where they are drawn -- a finger's Position is measured from the core UI safe area, as the
 *     engine reports it --, the buttons stay in the safe area under the bar, and the aim cursor turns around the
 *     survivor at the middle of the WHOLE screen.
 *  5c. the player's device is UserInputService.PreferredInput, one answer (client/ui/device.ts): a hybrid device with its
 *     mouse in use gets the desktop HUD AND the mouse aim; switching to the touch screen rebuilds the HUD with the
 *     thumbs' controls and turns the aim to touch; a pad names X in the hint and opens Controls on Gamepad; back to the
 *     keyboard the hint says E without a rebuild; a phone is the touch HUD as before.
 *  6. the hotbar with the item icon atlas: one ImageLabel per tile, no reserve of Frames, no churn.
 *  7. the icon in its tile (the owner's screenshot, 2026-09-24: the dagger low and right, the axe under the key, a
 *     1,56 px-per-pixel staircase), measured on the PAINTED pixels (tools/ui-raster.mjs), with the Frames and with the
 *     atlas, for all 30 weapons, on desktop at 1365 x 567 (the owner's 41 px tile), 1120 x 630, 1366 x 768,
 *     1920 x 1080 and 1360 x 435 and on touch at 1120 x 630 and 1360 x 435: the centre of what the icon draws is within
 *     1 px of the centre of what the tile leaves it (the face; above the ammo chip on a gun's tile), inside it, no
 *     pixel of it under the key badge, one side for every weapon that the screen pixels carry evenly (16 / 24 / 32 /
 *     40 / 48 px...) with every Frame and the image on whole pixels (Pixelated), no Instance while weapons change,
 *     and a resize re-fits it in place. Pictures of the same drawing: node tools/render-hotbar.mjs --out <dir>.
 *  8. the save indicator (DESIGN_RULES SAV-01, client/ui/saveIndicator.ts): built on the first notice, its words and
 *     theme colours per state, in the Roblox top bar right of its buttons (under the bar when it has no free stretch)
 *     and covering nothing of the HUD, taking no input; "Saved" holds then fades (Reduce Motion: it just goes), the
 *     failure stays until a write lands; 400 notices and 3000 frames create no Instance, and a still frame writes nothing.
 *  11. the dawn card (DESIGN_RULES BEM-04, client/ui/dawnCard.ts + client/systems/nightReport.ts) and the level-up
 *     (BEM-08): the night's tally (a death drops it, a Rebirth restarts it, half a night lived is the floor, one card
 *     a dawn), the break line only after BREAK_NUDGE_MIN minutes and once; the card built on its first dawn, in the
 *     banner's box (a "Good morning" gives way to it, a wave takes it), "Progress saved" only after the server's
 *     "saved" pushed once it is up, nothing Selectable, a tap sends it away, it goes by itself (a write in flight is
 *     waited for, capped), nothing moves, 20 dawns and 600 frames create no Instance; the level-up line says
 *     "Level 5 · +1 skill point · Backpack › Skills"; main.client.ts wires all of it.
 *
 * Pure Node (>= 18) plus the project's TypeScript.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installUiShims } from "./ui-shim.mjs";
import { layoutGame, paintList, rectOf, shown } from "./ui-layout.mjs";
import { rasterPaint } from "./ui-raster.mjs";
import { decodePNG } from "./png-lite.mjs";

const ui = installUiShims({ seed: 1, viewport: [1120, 630] });
const { SRC, ROOT, require, INTERNAL, flush, service, measure, setViewport, setClock, getClock } = ui;

const boot = require(join(SRC, "client/bootstrap.ts"));
const { Hud, messageReach } = require(join(SRC, "client/ui/hud.ts"));
const { COMPACT_LAYOUT, DESKTOP_LAYOUT } = require(join(SRC, "client/ui/hudConsole.ts"));
const { ownedWeapons } = require(join(SRC, "client/systems/combat.ts"));
const { WEAPONS } = require(join(SRC, "shared/data/weapons.ts"));
const { computeTouchLayout, MIN_TOUCH_PX } = require(join(SRC, "shared/engine/input.ts"));
const { THEME, SURFACE, BAR, STAT, GAME } = require(join(SRC, "client/ui/theme.ts"));
const { iconOf } = require(join(SRC, "shared/data/itemIcons.ts"));
const { iconFrameCount } = require(join(SRC, "client/ui/itemIcon.ts"));
const Clock = require(join(SRC, "shared/sim/clock.ts"));
const { countdown } = require(join(SRC, "client/onboarding/gameOver.ts"));
const { NIGHTFALL_WARN_S, SKY_PLATE_W, SKY_PLATE_H } = require(join(SRC, "client/ui/hudSky.ts"));
const { navReach } = require(join(SRC, "client/ui/hudNav.ts"));
const WA = require(join(SRC, "client/view/worldArt.ts"));
const { WORLD_ART } = require(join(SRC, "client/view/worldArtAssets.ts"));
const { ICON_ATLAS_CELLS } = require(join(SRC, "client/ui/itemIconAtlas.ts"));
/** the uploads as they are, with the item icon atlas's id set to `id` ("" = none: the icons are Frames) */
function setIconAtlas(id) {
	const ids = {};
	for (const [name, t] of Object.entries(WORLD_ART)) ids[name] = t.id;
	ids.itemIcons = id;
	WA.overrideWorldArt(ids);
}
// parts 1-5 measure the Frame icons whatever has been uploaded; part 6 the atlas (npm run test:icons)
setIconAtlas("");
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
const table = [];
function phase(label, fn) {
	const r = measure(fn);
	table.push({ label, ...r });
	return r;
}
const zero = r => r.created === 0 && r.destroyed === 0;
const cost = r => `${r.created} criadas, ${r.destroyed} destruidas, ${r.writes} escritas`;
const sameColor = (a, b) => a !== undefined && b !== undefined && a.R === b.R && a.G === b.G && a.B === b.B;

// ---------------------------------------------------------------- the run

const ctx = boot.getCtx();
ctx.phase = "playing";
const save = ctx.save;
// Núcleo 1 (CON-03): the dagger (always owned), the axe and the pistol; the bat is picked up later
const DAGGER = 0;
const AXE = 2;
const BAT = 6;
const PISTOL = 10;
for (const [id, name] of [
	[DAGGER, "Dagger"],
	[AXE, "Axe"],
	[BAT, "Baseball bat"],
	[PISTOL, "Pistol"],
]) {
	if (WEAPONS[id]?.name !== name) throw new Error(`weapons.ts moved: expected ${name} at ${id}`);
}
save.invenWeapon[AXE] = 1;
save.invenWeapon[PISTOL] = 1;
save.ammoNormal = 41;
const pistolPool = () => save.ammoNormal;
/** what combat.ts reads: the save and the weapon in hand */
const refs = weaponId => ({ save, player: { weapon: { pointer: weaponId } } });

function state(over = {}) {
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
		weaponId: PISTOL,
		weaponName: "Pistol",
		mag: 7,
		magSize: 12,
		reloading: false,
		reloadRatio: 0,
		ammoPool: pistolPool(),
		hitFlash: 0,
		...over,
	};
}

// ---------------------------------------------------------------- reading the tree

/** every descendant of `root` named `name` (visible or not) */
function deepAll(root, name) {
	return root === undefined ? [] : root.GetDescendants().filter(d => d.Name === name);
}
const deep = (root, name) => deepAll(root, name)[0];
const hudRoot = () => ctx.hudLayer.FindFirstChild("HudRoot");
const consoleFrame = () => deep(hudRoot(), "Console");
const tile = k => deep(consoleFrame(), `Slot${k + 1}`);
/** the notched plate a kit host wears (plate.ts): its face colour, and whether it is raised or ringed */
const face = host => host?.FindFirstChild("PlateFace")?.BackgroundColor3;
const band = host => host?.FindFirstChild("PlateBand");
const raised = host => band(host)?.Visible === true && sameColor(band(host).BackgroundColor3, THEME.foreground);
const ringed = host => band(host)?.Visible === true && sameColor(band(host).BackgroundColor3, SURFACE.line);
const barLabel = name => deep(consoleFrame(), `${name}Bar`)?.FindFirstChild("Value");
const barFill = name => deep(deep(consoleFrame(), `${name}Bar`), "Fill");
/** the pixel icon a tile shows (DESIGN_RULES UI-11: the Bag's and the item card's drawing), undefined when hidden */
const iconKey = k => {
	const view = deep(tile(k), "ItemIcon");
	return view?.Visible === true && view.GetAttribute("Icon") !== "" ? view.GetAttribute("Icon") : undefined;
};
/** the Frames of that icon that show (a view keeps the rest of its pool hidden) */
const iconFrames = k => (deep(tile(k), "ItemIcon")?.GetChildren() ?? []).filter(f => f.Visible).length;
const weaponIcon = id => iconOf(1, id).key;
const keyLegend = k => {
	const key = tile(k)?.FindFirstChild("Key");
	return key?.Visible === true ? key.FindFirstChild("Legend")?.Text : undefined;
};
const ammo = k => {
	const chip = tile(k)?.FindFirstChild("Ammo");
	return chip?.Visible === true ? chip.FindFirstChild("Count") : undefined;
};

/** what the hotbar shows, tile by tile: a weapon's icon, or "_" for an empty socket */
function hotbar() {
	const out = [];
	for (let k = 0; k < 5; k++) out.push(iconKey(k) ?? "_");
	return out.join(" ");
}
/** what it SHOULD show: the first five of ownedWeapons, by the icon the Bag draws for each */
function expected(weaponId) {
	const list = ownedWeapons(refs(weaponId));
	const out = [];
	for (let k = 0; k < 5; k++) out.push(list[k] === undefined ? "_" : weaponIcon(list[k]));
	return out.join(" ");
}
const DAP = [weaponIcon(DAGGER), weaponIcon(AXE), weaponIcon(PISTOL), "_", "_"].join(" ");
const DABP = [weaponIcon(DAGGER), weaponIcon(AXE), weaponIcon(BAT), weaponIcon(PISTOL), "_"].join(" ");

// ---------------------------------------------------------------- 1) desktop: mount, then 600 frames

console.log(`HUD: fonte ${SRC}\n`);
console.log("1) desktop: montar, depois 600 quadros com tudo mudando\n");

const hud = new Hud(ctx);
let bagCalls = 0;
let menuCalls = 0;
hud.onBackpack = () => bagCalls++;
hud.onPause = () => menuCalls++;
const mounted = phase("monta a HUD (desktop)", () => {
	hud.mount();
	hud.update(state());
});
console.log(`  (montar custa ${mounted.created} Instances)`);
check("o console existe, embaixo e no centro", consoleFrame() !== undefined && consoleFrame().AnchorPoint.X === 0.5);
check(
	"no desktop o console tem a coluna da arma e as chapas Bag / Menu",
	deep(consoleFrame(), "WeaponName") !== undefined &&
		deep(consoleFrame(), "Bag") !== undefined &&
		deep(consoleFrame(), "Menu") !== undefined,
);
check(
	"os cards soltos antigos sairam (status, arma, BAG)",
	deep(hudRoot(), "Status") === undefined &&
		deep(hudRoot(), "WeaponBox") === undefined &&
		deep(hudRoot(), "BagBox") === undefined,
);
// the match scoreboard's chip (MP-23) goes where Bag and Menu are: the third plate of their row, inside the console
{
	const [bag, menu, slot, weapons] = ["Bag", "Menu", "ChipSlot", "Weapons"].map(n => deep(consoleFrame(), n));
	const x0 = f => f.Position.X.Scale;
	const x1 = f => f.Position.X.Scale + f.Size.X.Scale;
	const same = (a, b) => Math.abs(a - b) < 1e-9;
	check(
		"o chip do placar (MP-23) e a terceira chapa da fileira, depois de Bag e Menu, do mesmo tamanho, sob a secao das armas",
		slot !== undefined &&
			deep(slot, "Survivors") !== undefined &&
			x0(bag) < x0(menu) &&
			x1(menu) < x0(slot) &&
			same(slot.Position.Y.Scale, bag.Position.Y.Scale) &&
			same(slot.Size.X.Scale, bag.Size.X.Scale) &&
			same(slot.Size.Y.Scale, bag.Size.Y.Scale) &&
			x0(bag) >= x0(weapons) - 1e-9 &&
			x1(slot) <= x1(weapons) + 1e-9,
		slot === undefined
			? "sem ChipSlot"
			: `Bag ${x0(bag).toFixed(3)} Menu ${x0(menu).toFixed(3)} chip ${x0(slot).toFixed(3)}`,
	);
	check(
		"...e o console nao cresceu por ele: 778 x 114 unidades, e nada fora dele no topo (a placa do dia saiu)",
		DESKTOP_LAYOUT.w === 778 && DESKTOP_LAYOUT.h === 114 && deep(hudRoot(), "DayPlate") === undefined,
		`${DESKTOP_LAYOUT.w} x ${DESKTOP_LAYOUT.h}`,
	);
}

const WEAPON_CYCLE = [PISTOL, PISTOL, AXE, DAGGER, PISTOL];
function frameState(i) {
	const t = i / 600;
	const weaponId = WEAPON_CYCLE[Math.floor(i / 120) % WEAPON_CYCLE.length];
	const gun = weaponId === PISTOL;
	const reloading = gun && i % 90 >= 60;
	return state({
		hp: Math.max(0, 100 * Math.abs(Math.cos(t * 7))),
		hunger: 100 * (1 - t),
		level: 3 + Math.floor(i / 200),
		exp: (i * 3) % 120,
		dayTime: (6 + t * 30) % 24,
		isNight: i % 300 >= 150,
		day: 5 + Math.floor(i / 250),
		lifeDay: i < 400 ? 5 + Math.floor(i / 250) : 1,
		showClock: i % 200 >= 100,
		weaponId,
		weaponName: WEAPONS[weaponId].name,
		magSize: WEAPONS[weaponId].mag,
		mag: gun ? 12 - (i % 13) : 0,
		reloading,
		reloadRatio: reloading ? (i % 30) / 30 : 0,
		ammoPool: gun ? 41 - (i % 7) : 0,
		hitFlash: i % 45 < 10 ? 1 - (i % 45) / 10 : 0,
	});
}
let seen = new Set();
const run600 = phase("600 quadros: HP, fome, XP, municao, recarga, dia/noite, dano", () => {
	for (let i = 0; i < 600; i++) {
		setClock(1000 + i / 60);
		const s = frameState(i);
		hud.update(s);
		seen.add(hotbar());
	}
});
check("600 quadros nao criam nem destroem Instance", zero(run600), cost(run600));

// a frame like the one before writes nothing (the HUD caches what it shows)
hud.update(state());
const still = phase("60 quadros identicos", () => {
	for (let i = 0; i < 60; i++) {
		setClock(2000 + i / 60);
		hud.update(state());
	}
});
check("um quadro igual ao anterior nao escreve nenhuma propriedade", still.writes === 0 && zero(still), cost(still));

// ---------------------------------------------------------------- 2) the hotbar is the list keys 1-5 pick from

console.log("\n2) a hotbar e a lista das teclas 1-5 (ownedWeapons), na ordem\n");

hud.update(state());
check(
	"3 armas: Dagger, Axe, Pistol e dois soquetes vazios",
	hotbar() === expected(PISTOL) && hotbar() === DAP,
	`${hotbar()} / esperado ${expected(PISTOL)}`,
);
check(
	"a arma na mao (Pistol, tecla 3) e azul e em relevo",
	sameColor(face(tile(2)), THEME.tabActive) && raised(tile(2)),
);
check(
	"as outras sao ferro escuro liso",
	[0, 1].every(k => sameColor(face(tile(k)), SURFACE.section) && !raised(tile(k))),
);
check(
	"a tecla sem arma e um soquete vazio no leito (escuro, contornado)",
	[3, 4].every(k => sameColor(face(tile(k)), SURFACE.well) && ringed(tile(k))),
);
check(
	"cada arma mostra a tecla que a escolhe (1-5); o soquete vazio, nenhuma",
	keyLegend(0) === "1" && keyLegend(1) === "2" && keyLegend(2) === "3" && keyLegend(3) === undefined,
	[0, 1, 2, 3, 4].map(keyLegend).join(","),
);
check(
	"o icone e o do Bag e do cartao de item (UI-11: o mesmo desenho de pixel, nunca a inicial)",
	iconKey(0) === weaponIcon(DAGGER) && iconKey(2) === weaponIcon(PISTOL) && deep(tile(0), "Letter") === undefined,
	`${iconKey(0)} / ${iconKey(2)}`,
);
check(
	"cada ladrilho mostra exatamente os Frames do seu icone",
	[0, 1, 2].every(k => iconFrames(k) === iconFrameCount(iconKey(k))),
	[0, 1, 2].map(k => `${iconKey(k)} ${iconFrames(k)}`).join(", "),
);

hud.update(state({ weaponId: AXE, weaponName: "Axe", magSize: 0, mag: 0 }));
check(
	"trocar de arma move o azul (Axe, tecla 2)",
	sameColor(face(tile(1)), THEME.tabActive) && sameColor(face(tile(2)), SURFACE.section),
);
hud.update(state());

// DESIGN_RULES ITM-06: the weapon PUT AWAY -- empty hands. The same tiles (the list keys 1-5 pick from does not move),
// none of them blue, and the weapon column says why nothing fires
{
	const weaponType = () => deep(consoleFrame(), "WeaponType")?.Text;
	const typeBefore = weaponType();
	const away = phase("guarda a Pistol (ITM-06: maos vazias)", () => {
		for (let i = 0; i < 30; i++) hud.update(state({ holstered: true }));
	});
	check(
		"arma guardada: NENHUM ladrilho azul, a mesma hotbar (as teclas 1-5 nao mudam)",
		[0, 1, 2, 3, 4].every(k => !sameColor(face(tile(k)), THEME.tabActive)) && hotbar() === expected(PISTOL),
		hotbar(),
	);
	check(
		"a Pistol guardada e ferro escuro liso como as outras, com a tecla 3 e so a reserva no chip",
		sameColor(face(tile(2)), SURFACE.section) &&
			!raised(tile(2)) &&
			keyLegend(2) === "3" &&
			ammo(2)?.Text === String(pistolPool()),
		`${keyLegend(2)} / ${ammo(2)?.Text}`,
	);
	check(
		'a coluna da arma diz "Put away" no lugar do tipo',
		weaponType() === "Put away" && deep(consoleFrame(), "WeaponName")?.Text === "Pistol",
		weaponType(),
	);
	check("guardar a arma nao cria nem destroi Instance, em 30 quadros", zero(away), cost(away));
	const drawn = phase("saca a Pistol de novo", () => hud.update(state()));
	check(
		"sacada: o azul volta a Pistol (tecla 3) e a coluna diz o tipo de novo",
		sameColor(face(tile(2)), THEME.tabActive) && raised(tile(2)) && weaponType() === typeBefore && zero(drawn),
		`${weaponType()} / ${cost(drawn)}`,
	);
}

const TILE_COST = tile(0).GetDescendants().length + 1;
save.invenWeapon[BAT] = 1;
const pickup = phase("pega o Baseball bat (a lista ganha um item no meio)", () => {
	for (let i = 0; i < 30; i++) hud.update(state());
});
check(
	"a arma nova aparece no lugar dela, e as outras seguem as teclas",
	hotbar() === expected(PISTOL) && hotbar() === DABP,
	`${hotbar()} / esperado ${expected(PISTOL)}`,
);
check(
	"pegar uma arma cria no maximo um ladrilho (aqui: nenhum, os 5 ja existem)",
	pickup.created <= TILE_COST && pickup.destroyed === 0,
	`${cost(pickup)}; um ladrilho = ${TILE_COST}`,
);
check("o azul segue a Pistol, agora na tecla 4", sameColor(face(tile(3)), THEME.tabActive) && keyLegend(3) === "4");

save.invenWeapon[BAT] = 0;
const loss = phase("perde o Baseball bat", () => hud.update(state()));
check("perder uma arma reescreve os ladrilhos no lugar", zero(loss) && hotbar() === DAP, hotbar());

// more weapons than keys: the hotbar shows what the keys reach, and no more
save.invenWeapon[1] = 1;
save.invenWeapon[3] = 1;
save.invenWeapon[BAT] = 1;
const six = phase("6 armas", () => hud.update(state()));
check(
	"com 6 armas, os ladrilhos sao as 5 primeiras (a 6a so pelo Bag, como nas teclas)",
	zero(six) && hotbar() === expected(PISTOL) && ownedWeapons(refs(PISTOL)).length === 6,
	`${hotbar()} / esperado ${expected(PISTOL)}`,
);
check(
	"e nenhum ladrilho fica azul com a 6a na mao (nenhuma tecla a alcanca)",
	[0, 1, 2, 3, 4].every(k => !sameColor(face(tile(k)), THEME.tabActive)),
);
for (const id of [1, 3, BAT]) save.invenWeapon[id] = 0;
hud.update(state());
check("de volta a 3 armas", hotbar() === DAP, hotbar());

// ---------------------------------------------------------------- 3) a click is a key press

console.log("\n3) clicar no ladrilho k e o mesmo que a tecla k\n");

const uis = service("UserInputService");
const KEYS = [Enum.KeyCode.One, Enum.KeyCode.Two, Enum.KeyCode.Three, Enum.KeyCode.Four, Enum.KeyCode.Five];
const input = ctx.input;
const byKey = [];
const byClick = [];
for (let k = 0; k < 5; k++) {
	input.beginFrame();
	uis.InputBegan.Fire({ UserInputType: Enum.UserInputType.Keyboard, KeyCode: KEYS[k] }, false);
	byKey.push(input.weaponSlotPressed);
	input.beginFrame();
	tile(k).Activated.Fire();
	flush();
	byClick.push(input.weaponSlotPressed);
}
input.beginFrame();
check(
	"tecla k (o InputBegan real do bootstrap) e clique no ladrilho k escrevem o mesmo campo, com o mesmo valor",
	byKey.join(",") === "0,1,2,3,4" && byClick.join(",") === byKey.join(","),
	`teclas ${byKey.join(",")} / cliques ${byClick.join(",")}`,
);
const list = ownedWeapons(refs(PISTOL));
check(
	"e o ladrilho k mostra a arma que o combate pega para k (ownedWeapons[k])",
	[0, 1, 2].every(k => iconKey(k) === weaponIcon(list[k])),
);
deep(consoleFrame(), "Bag").Activated.Fire();
deep(consoleFrame(), "Menu").Activated.Fire();
flush();
check("a chapa Bag abre o Bag, a Menu abre o menu", bagCalls === 1 && menuCalls === 1, `${bagCalls} / ${menuCalls}`);
check(
	"com teclado e mouse, as chapas mostram B e P",
	deep(deep(consoleFrame(), "Bag"), "Key")?.Text === "B" && deep(deep(consoleFrame(), "Menu"), "Key")?.Text === "P",
);
uis.GetLastInputType = () => Enum.UserInputType.Gamepad1;
const pad = phase("o jogador pega o controle", () => hud.update(state()));
check(
	"com o controle: LB e Start nas chapas, e nenhuma tecla nos ladrilhos (o controle nao tem tecla de arma)",
	zero(pad) &&
		deep(deep(consoleFrame(), "Bag"), "Key")?.Text === "LB" &&
		deep(deep(consoleFrame(), "Menu"), "Key")?.Text === "Start" &&
		[0, 1, 2].every(k => keyLegend(k) === undefined),
);
uis.GetLastInputType = () => Enum.UserInputType.MouseMovement;
hud.update(state());
check("de volta ao teclado: 1-5", keyLegend(0) === "1" && keyLegend(2) === "3");

// ---------------------------------------------------------------- 4) the texts

console.log("\n4) textos: barras, municao, dia do mundo x dia da vida\n");

hud.update(state());
check("HP 88 / 100", barLabel("Hp")?.Text === "HP 88 / 100", barLabel("Hp")?.Text);
check("FOOD 58 / 100", barLabel("Food")?.Text === "FOOD 58 / 100", barLabel("Food")?.Text);
check(
	"LV 3 · 30 / 120 (o nivel dentro da barra de XP)",
	barLabel("Xp")?.Text === "LV 3 · 30 / 120",
	barLabel("Xp")?.Text,
);
check(
	"o texto das barras e o foreground claro (UI-05), e o preenchimento e a chapa BAR",
	["Hp", "Food", "Xp"].every(n => sameColor(barLabel(n)?.TextColor3, THEME.foreground)) &&
		sameColor(face(barFill("Hp")), BAR.hp) &&
		sameColor(face(barFill("Food")), BAR.food) &&
		sameColor(face(barFill("Xp")), BAR.xp),
);
check(
	"cada preenchimento e uma chapa em relevo",
	["Hp", "Food", "Xp"].every(n => raised(barFill(n))),
);
check(
	"o preenchimento acompanha o valor",
	barFill("Hp").Size.X.Scale === 0.88 && barFill("Xp").Size.X.Scale === 0.25,
	`${barFill("Hp").Size.X.Scale} / ${barFill("Xp").Size.X.Scale}`,
);
hud.update(state({ hp: 0.4 }));
check(
	"HP fracionado arredonda para cima (0.4 vivo nao e 0)",
	barLabel("Hp")?.Text === "HP 1 / 100",
	barLabel("Hp")?.Text,
);

// low HP blinks the fill out; a hit lights it; low food blinks it red
const blinkAt = on => {
	// sin(t * 8) > 0 hides the fill: pick a clock on each side
	setClock(on ? Math.PI / 16 : (3 * Math.PI) / 16);
};
blinkAt(true);
hud.update(state({ hp: 10 }));
const hiddenAtLow = barFill("Hp").Visible === false;
blinkAt(false);
hud.update(state({ hp: 10 }));
check("HP baixo pisca o preenchimento", hiddenAtLow && barFill("Hp").Visible === true);
hud.update(state({ hitFlash: 1 }));
const hotBand = band(barFill("Hp"))?.BackgroundTransparency;
hud.update(state({ hitFlash: 0 }));
check(
	"o golpe acende o relevo do HP (e a vinheta segue piscando a tela)",
	hotBand === 0.5 && band(barFill("Hp")).BackgroundTransparency === 0.7,
	`${hotBand} -> ${band(barFill("Hp")).BackgroundTransparency}`,
);
const vignette = deep(hudRoot(), "VignetteTop");
hud.update(state({ hitFlash: 1 }));
check("a vinheta de dano continua", vignette.BackgroundTransparency < 1, `${vignette.BackgroundTransparency}`);
hud.update(state());

// ...and in a session on the server (MP_PHASE 2), where the hit is the SERVER's: the bite lands through its own entry
// point (`applyPlayerDamage`), travels in its own self block (server/net/replication.ts) over the wire format, the
// client's prediction reads it back (client/net/prediction.ts), the survivor fades it as client/systems/combat.ts does
// and the HUD state takes it as main.client.ts does. Before, `hitFlash` never rose for the local survivor there: the
// only writer of it ran on the server
{
	const Ply = require(join(SRC, "shared/game/player.ts"));
	const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
	const { createWorld } = require(join(SRC, "shared/game/world.ts"));
	const { MP_PHASE, SIM_HZ, SNAP_NEAR_EVERY_TICKS } = require(join(SRC, "shared/net/mpConfig.ts"));
	const { encodeSnapshot, decodeSnapshotPart } = require(join(SRC, "shared/net/protocol.ts"));
	const { createServerPlayer } = require(join(SRC, "server/sim/players.ts"));
	const REP = require(join(SRC, "server/net/replication.ts"));
	const { Prediction } = require(join(SRC, "client/net/prediction.ts"));
	const world = createWorld(4000, 4000);
	const server = createServerPlayer({ slot: 0, userId: 7, name: "me" }, defaultSave(), 1000, 1000, 0, SIM_HZ);
	const mySave = defaultSave();
	const me = Ply.createPlayer(mySave, 1000, 1000);
	const prediction = new Prediction();
	prediction.attach(world, me, mySave);
	const frameS = 1 / 60;
	let tick = 0;
	let now = 50;
	/** one snapshot's self block, the server's own, through the encoder and the decoder, into the reconciliation */
	const snapshot = () => {
		tick += SNAP_NEAR_EVERY_TICKS;
		const self = REP.selfBlockOf({ spawnShielded: () => false }, server);
		const part = encodeSnapshot({ tick, self, players: [], zombies: [], bosses: [] }).parts[0];
		prediction.reconcile(decodeSnapshotPart(part).self, [], now);
	};
	/** one client frame after the snapshots: combat.ts fades the flash, then the HUD reads the survivor */
	const frame = () => {
		now += frameS;
		me.hitFlash = Math.max(0, (me.hitFlash ?? 0) - frameS);
		hud.update(state({ hp: me.hp, hpMax: me.hpMax, hitFlash: me.hitFlash ?? 0 }));
	};
	const look = () => ({
		vignette: vignette.BackgroundTransparency,
		relief: band(barFill("Hp")).BackgroundTransparency,
	});
	snapshot();
	frame();
	const calm = look();
	Ply.applyPlayerDamage(server.state, server.save, 10);
	snapshot();
	frame();
	const bitten = look();
	check(
		"na sessao do servidor (MP_PHASE 2) a mordida que o servidor aplica acende a vinheta e o relevo do HP no cliente",
		MP_PHASE >= 2 &&
			calm.vignette === 1 &&
			calm.relief === 0.7 &&
			me.hp === 90 &&
			bitten.vignette < 1 &&
			bitten.relief === 0.5,
		`MP_PHASE ${MP_PHASE}, HP ${me.hp}: vinheta ${calm.vignette} -> ${bitten.vignette}, relevo ${calm.relief} -> ${bitten.relief}`,
	);
	// a second later (the i-frames over, the snapshots still coming) both are back at rest, and nothing re-lit them
	for (let i = 0; i < 60; i++) {
		if (i % SNAP_NEAR_EVERY_TICKS === 0) snapshot();
		frame();
	}
	const after = look();
	check(
		"e um segundo depois a vinheta e o relevo apagam, sem outro golpe",
		after.vignette === 1 && after.relief === 0.7 && prediction.stats().flashes === 1,
		`vinheta ${after.vignette}, relevo ${after.relief}, ${prediction.stats().flashes} flash(es)`,
	);
	hud.update(state());
}
blinkAt(true);
hud.update(state({ hunger: 10 }));
check("fome baixa pisca a barra de fome em vermelho", sameColor(face(barFill("Food")), BAR.hp));
blinkAt(false);
hud.update(state());

// Reduce Motion: nothing throbs. Low HP holds its fill lit and low food holds it red at both phases of the blink, and the
// low-HP vignette holds one value through the whole pulse (its middle), like the hit flash over the menus
{
	const gs = service("GuiService");
	const vignetteTop = deep(hudRoot(), "VignetteTop");
	const across = over => {
		const seen = { hpFill: new Set(), foodRed: new Set(), vignette: new Set() };
		for (let i = 0; i < 48; i++) {
			setClock(5000 + i / 30);
			hud.update(state(over));
			seen.hpFill.add(barFill("Hp").Visible);
			seen.foodRed.add(sameColor(face(barFill("Food")), BAR.hp));
			seen.vignette.add(vignetteTop.BackgroundTransparency.toFixed(4));
		}
		return seen;
	};
	// (the Luau shims make a Set's size a method, as roblox-ts has it)
	const count = set => [...set].length;
	const moving = across({ hp: 10, hunger: 10 });
	gs.ReducedMotionEnabled = true;
	flush();
	const still = across({ hp: 10, hunger: 10 });
	gs.ReducedMotionEnabled = false;
	flush();
	check(
		"sem Reduce Motion a HP baixa pisca, a fome baixa pisca e a vinheta pulsa (o controle do teste)",
		count(moving.hpFill) === 2 && count(moving.foodRed) === 2 && count(moving.vignette) > 5,
		`HP ${[...moving.hpFill]}, fome ${[...moving.foodRed]}, vinheta ${count(moving.vignette)} valores`,
	);
	check(
		"com Reduce Motion nada pulsa: HP baixa acesa, fome baixa vermelha, a vinheta de HP baixa num valor so",
		count(still.hpFill) === 1 &&
			still.hpFill.has(true) &&
			count(still.foodRed) === 1 &&
			still.foodRed.has(true) &&
			count(still.vignette) === 1 &&
			Number([...still.vignette][0]) < 1,
		`HP ${[...still.hpFill]}, fome vermelha ${[...still.foodRed]}, vinheta ${[...still.vignette].join(", ")}`,
	);
	hud.update(state());
}

// ammo: magazine / reserve on the gun in hand, the reserve alone on the others, red when empty
check(
	"Pistol na mao: 7/41 no amarelo dos numeros (STAT.value)",
	ammo(2)?.Text === "7/41" && sameColor(ammo(2)?.TextColor3, STAT.value),
	ammo(2)?.Text,
);
check("arma branca: sem chip de municao", ammo(0) === undefined && ammo(1) === undefined);
hud.update(state({ weaponId: DAGGER, weaponName: "Dagger", magSize: 0, mag: 0, ammoPool: 0 }));
check("Pistol fora da mao: so a reserva (41)", ammo(2)?.Text === "41", ammo(2)?.Text);
hud.update(state({ mag: 0 }));
check("pente vazio fica vermelho", sameColor(ammo(2)?.TextColor3, STAT.penalty));
hud.update(state({ mag: 0, reloading: true, reloadRatio: 0.4 }));
const reload = deep(tile(2), "Reload");
check(
	"a recarga enche o ladrilho da mao de baixo para cima (azul sobre o leito escuro)",
	reload.Visible && reload.Size.Y.Scale === 0.4 && sameColor(face(tile(2)), SURFACE.well),
	`${reload.Size.Y.Scale}`,
);
check(
	"e a leitura da direita diz Reloading...",
	deep(consoleFrame(), "Magazine")?.Text === "Reloading...",
	deep(consoleFrame(), "Magazine")?.Text,
);
hud.update(state());
check("recarga pronta: o ladrilho volta a azul", !reload.Visible && sameColor(face(tile(2)), THEME.tabActive));
check(
	"a coluna da direita: nome, tipo e pente / reserva",
	deep(consoleFrame(), "WeaponName")?.Text === "Pistol" &&
		deep(consoleFrame(), "WeaponType")?.Text === "Pistol" &&
		deep(consoleFrame(), "Magazine")?.Text.endsWith("7</font> / 41"),
	`${deep(consoleFrame(), "WeaponName")?.Text} / ${deep(consoleFrame(), "WeaponType")?.Text} / ${deep(consoleFrame(), "Magazine")?.Text}`,
);

// ---------------------------------------------------------------- 4d) VIT-01: the healing cue on the vitals bars

console.log("\n4d) VIT-01: o HP brilha enquanto cura; um garfo na FOOD quando so a comida impede a cura\n");
{
	const VIT = require(join(SRC, "shared/sim/vitals.ts"));
	const gs = service("GuiService");
	const glow = () => deep(consoleFrame(), "HpGlow");
	const glowParts = () => ["GlowV", "GlowH"].map(n => deep(glow(), n));
	const fork = () => deep(deep(consoleFrame(), "FoodBar"), "EatHint");
	const lit = () => glow()?.Visible === true;
	const eat = () => fork()?.Visible === true;
	const glowT = () => glowParts()[0].BackgroundTransparency;
	const forkSize = () => fork().Size.X.Scale;
	const RESTED = VIT.REGEN_RESTED_S;
	const healing = { hp: 60, hunger: 80, sinceHurt: RESTED };
	setClock(7000);
	hud.update(state());
	check(
		"o brilho e o garfo existem desde a montagem, escondidos (sem sinceHurt, a HUD nao inventa cura)",
		glow() !== undefined && fork() !== undefined && !lit() && !eat(),
	);
	hud.update(state(healing));
	check(
		"curando: o HP ganha um brilho na cor de cura do tema (GAME.success), e nada na FOOD",
		lit() &&
			glowParts().every(f => sameColor(f.BackgroundColor3, GAME.success) && f.BackgroundTransparency < 1) &&
			!eat(),
		`transparencia ${glowT()}`,
	);
	{
		// the ring sits OUTSIDE the HP groove and under it: the bar's fill and label (UI-05's 4,5:1) are untouched
		const g = glow();
		const groove = deep(consoleFrame(), "HpBar");
		const inside =
			g.Position.X.Scale < groove.Position.X.Scale &&
			g.Position.Y.Scale < groove.Position.Y.Scale &&
			g.Position.X.Scale + g.Size.X.Scale > groove.Position.X.Scale + groove.Size.X.Scale &&
			g.Position.Y.Scale + g.Size.Y.Scale > groove.Position.Y.Scale + groove.Size.Y.Scale;
		check(
			"o brilho abraca o sulco do HP por fora e por baixo dele: o texto da barra continua sobre a chapa",
			inside && g.ZIndex < groove.ZIndex && g.Parent === groove.Parent,
		);
	}
	// the ramp: fainter at its start than at the full rate (same clock: the same breath)
	hud.update(state({ ...healing, sinceHurt: VIT.REGEN_DELAY_S + VIT.REGEN_RAMP_S * 0.25 }));
	const early = glowT();
	hud.update(state(healing));
	check("o brilho entra com a rampa: mais fraco no comeco da cura", early > glowT(), `${early} -> ${glowT()}`);
	hud.update(state({ ...healing, sinceHurt: 2 }));
	check("na espera depois de um golpe: nada (a luta ja diz isso)", !lit() && !eat());
	hud.update(state({ ...healing, hp: 100 }));
	check("vida cheia: nada", !lit() && !eat());

	// low food: the fork, with one pop
	const rest = forkSize();
	setClock(7100);
	hud.update(state({ ...healing, hunger: VIT.REGEN_FOOD_MIN - 1 }));
	const popped = forkSize();
	check(
		`FOOD abaixo de ${VIT.REGEN_FOOD_MIN} com vida faltando: o garfo aparece na ponta da barra de FOOD, e o HP nao brilha`,
		eat() && !lit() && fork().Position.X.Scale > 0.8,
		`x ${fork().Position.X.Scale.toFixed(3)}`,
	);
	check("...e ele pulsa uma vez ao aparecer", popped > rest * 1.3, `${popped.toFixed(4)} contra ${rest.toFixed(4)}`);
	for (let i = 1; i <= 30; i++) {
		setClock(7100 + i / 60);
		hud.update(state({ ...healing, hunger: VIT.REGEN_FOOD_MIN - 1 }));
	}
	check("...e volta ao tamanho em 0,3 s, sem pulsar de novo", forkSize() === rest, `${forkSize()}`);
	hud.update(state({ ...healing, hunger: VIT.REGEN_FOOD_MIN - 1, sinceHurt: 1 }));
	check("o garfo fica tambem no meio da luta: a espera acaba sozinha, a fome nao", eat());
	hud.update(state({ ...healing, hunger: 0 }));
	check("e passando fome (FOOD 0)", eat());
	{
		// one number for the hungry survivor: the fork (no healing) and the FOOD bar's red (hudConsole LOW_FOOD) start
		// together, at REGEN_FOOD_MIN -- Reduce Motion holds the red, so one frame reads it
		const gs2 = service("GuiService");
		gs2.ReducedMotionEnabled = true;
		flush();
		const at = food => {
			hud.update(state({ ...healing, hunger: food }));
			return { fork: eat(), red: sameColor(face(barFill("Food")), BAR.hp) };
		};
		const under = at(VIT.REGEN_FOOD_MIN - 1);
		const over = at(VIT.REGEN_FOOD_MIN + 1);
		gs2.ReducedMotionEnabled = false;
		flush();
		hud.update(state(healing));
		check(
			`o garfo e o vermelho da FOOD comecam no mesmo numero (${VIT.REGEN_FOOD_MIN}): um aviso so para a fome`,
			under.fork && under.red && !over.fork && !over.red,
			`${VIT.REGEN_FOOD_MIN - 1}: ${JSON.stringify(under)} / ${VIT.REGEN_FOOD_MIN + 1}: ${JSON.stringify(over)}`,
		);
	}
	{
		const lum = c => {
			const f = v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
			return 0.2126 * f(c.R) + 0.7152 * f(c.G) + 0.0722 * f(c.B);
		};
		const px = deep(fork(), "Px0");
		const a = lum(px.BackgroundColor3);
		const b = lum(SURFACE.groove);
		const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
		check(
			"o garfo e o claro do rotulo sobre o sulco escuro: >= 3:1 (grafico, WCAG 1.4.11)",
			sameColor(px.BackgroundColor3, THEME.foreground) && ratio >= 3,
			`${ratio.toFixed(2)}:1`,
		);
	}
	// Reduce Motion: no pop, and the glow holds one value
	gs.ReducedMotionEnabled = true;
	flush();
	hud.update(state(healing));
	hud.update(state({ ...healing, hunger: 10 }));
	const stillPop = forkSize();
	const values = new Set();
	for (let i = 0; i < 90; i++) {
		setClock(7200 + i / 30);
		hud.update(state(healing));
		values.add(glowT());
	}
	gs.ReducedMotionEnabled = false;
	flush();
	check(
		"com Reduce Motion: o garfo aparece sem pulsar e o brilho fica num valor so",
		stillPop === rest && [...values].length === 1,
		`garfo ${stillPop.toFixed(4)}, brilho ${[...values].join(", ")}`,
	);
	const breath = new Set();
	for (let i = 0; i < 90; i++) {
		setClock(7300 + i / 30);
		hud.update(state(healing));
		breath.add(glowT());
	}
	check("sem ele, o brilho respira devagar (0,5 Hz)", [...breath].length > 3, `${[...breath].length} valores em 3 s`);

	// no churn: 600 frames through every phase create nothing; a steady frame writes nothing; breathing writes 2 at most
	const phases = [
		healing,
		{ ...healing, sinceHurt: 0.5 },
		{ ...healing, sinceHurt: VIT.REGEN_DELAY_S + 1 },
		{ ...healing, hunger: 12 },
		{ ...healing, hp: 100 },
		{ ...healing, hunger: 0, hp: 20 },
	];
	const churn = phase("600 quadros passando por curando / espera / rampa / fome / cheio", () => {
		for (let i = 0; i < 600; i++) {
			setClock(7400 + i / 60);
			hud.update(state(phases[Math.floor(i / 25) % phases.length]));
		}
	});
	check("600 quadros de dicas de cura nao criam nem destroem Instance", zero(churn), cost(churn));
	gs.ReducedMotionEnabled = true;
	flush();
	hud.update(state(healing));
	const steady = phase("60 quadros curando, Reduce Motion", () => {
		for (let i = 0; i < 60; i++) {
			setClock(7500 + i / 60);
			hud.update(state(healing));
		}
	});
	gs.ReducedMotionEnabled = false;
	flush();
	check(
		"curando parado (Reduce Motion): nenhum quadro escreve nada",
		steady.writes === 0 && zero(steady),
		cost(steady),
	);
	let worst = 0;
	for (let i = 0; i < 60; i++) {
		const one = phase("um quadro respirando", () => {
			setClock(7600 + i / 60);
			hud.update(state(healing));
		});
		worst = Math.max(worst, one.writes);
	}
	check("respirando: no maximo 2 escritas por quadro (as duas partes do anel)", worst <= 2, `pior ${worst}`);
	hud.update(state());
}

/** the hours (every quarter) at which the sky's weather icon overlaps the sun or the moon: "" = never (LUZ-05) */
function weatherOnArc(groove) {
	const box = f => {
		const ax = f.AnchorPoint?.X ?? 0;
		const ay = f.AnchorPoint?.Y ?? 0;
		const x = f.Position.X.Scale - ax * f.Size.X.Scale;
		const y = f.Position.Y.Scale - ay * f.Size.Y.Scale;
		return [x, y, x + f.Size.X.Scale, y + f.Size.Y.Scale];
	};
	const icon = box(deep(groove(), "Weather"));
	let hit = "";
	for (let t = 0; t < 24; t += 0.25) {
		hud.update(state({ dayTime: t, isNight: Clock.isNightAt(t), weather: 2 }));
		const b = box(deep(groove(), "Body"));
		if (b[0] < icon[2] && icon[0] < b[2] && b[1] < icon[3] && icon[1] < b[3]) hit += ` ${t}h`;
	}
	hud.update(state());
	return hit;
}

// ---------------------------------------------------------------- 4b) the sky (the day clock, hudSky.ts)

console.log("\n4b) o ceu: o relogio do dia virou uma secao do console (UI-09)\n");

const sky = () => deep(consoleFrame(), "SkyWindow");
const skyText = name => deep(sky(), name)?.Text;
const bodyX = () => deep(sky(), "Body").Position.X.Scale;
const bodyY = () => deep(sky(), "Body").Position.Y.Scale;
/** the countdown as the sky must write it: the phase's words and the dawn wait's own M:SS, the number in `color` */
const hexOf = c =>
	`#${[c.R, c.G, c.B]
		.map(v =>
			Math.round(v * 255)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
const expectCount = (t, color = STAT.value) => {
	const night = Clock.isNightAt(t);
	const left = Clock.secondsUntilHour(t, night ? Clock.DAY_BREAK_HOUR : Clock.NIGHTFALL_HOUR);
	return `${night ? "Daybreak in" : "Night in"} <font color="${hexOf(color)}">${countdown(left)}</font>`;
};
check("a placa do dia solta no topo saiu", deep(hudRoot(), "DayPlate") === undefined);
{
	const sections = ["Sky", "Vitals", "Weapons", "Hand"].map(n => deep(consoleFrame(), n));
	check(
		"o ceu e a primeira secao do console, na ponta esquerda: Sky | Vitals | Weapons | Hand",
		sections.every(f => f !== undefined) &&
			sections.every((f, i) => i === 0 || f.Position.X.Scale > sections[i - 1].Position.X.Scale),
		sections.map(f => f?.Position.X.Scale.toFixed(3)).join(" < "),
	);
	check(
		"o console so ficou mais largo, nao mais alto (a altura e o que o mundo menos pode ceder)",
		DESKTOP_LAYOUT.h === 114 && DESKTOP_LAYOUT.w === 778,
		`${DESKTOP_LAYOUT.w} x ${DESKTOP_LAYOUT.h}`,
	);
}
hud.update(state({ day: 5, lifeDay: 5, dayTime: 14.5 }));
check(
	'"Day 5" (o dia do MUNDO) em ExtraBold, e nenhum dia da vida quando os dois concordam',
	skyText("Day") === "Day 5" &&
		deep(sky(), "Day").FontFace.Weight.Name === "ExtraBold" &&
		deep(sky(), "Extra").Visible === false,
	`${skyText("Day")} / extra ${deep(sky(), "Extra").Visible}`,
);
check(
	"de dia: a contagem ate o anoitecer, em segundos reais, no amarelo dos numeros",
	skyText("Countdown") === expectCount(14.5),
	skyText("Countdown"),
);
hud.update(state({ day: 5, lifeDay: 2, dayTime: 14.5 }));
check(
	"New game: Life day 2 embaixo, e o Day 5 do mundo nao muda",
	skyText("Day") === "Day 5" && deep(sky(), "Extra").Visible && skyText("Extra") === "Life day 2",
	skyText("Extra"),
);
hud.update(state({ day: 5, lifeDay: 5, dayTime: 14.5 }));
check("de novo iguais: a linha some", deep(sky(), "Extra").Visible === false);
hud.update(state({ showClock: true, dayTime: 14.5 }));
check("com relogio (o item): 14:30 na linha de baixo", skyText("Extra") === "14:30", skyText("Extra"));
hud.update(state({ showClock: true, lifeDay: 2, dayTime: 14.5 }));
check("os dois juntos", skyText("Extra") === "Life day 2 · 14:30", skyText("Extra"));

// the sun travels the arc left -> right from 06:00 to 19:00, and the path it left behind goes dim
const xs = [];
for (const t of [6.01, 9, 12.5, 16, 18.99]) {
	hud.update(state({ dayTime: t }));
	xs.push(bodyX());
}
hud.update(state({ dayTime: 12.5 }));
check(
	"o sol anda da esquerda (06:00) para a direita (19:00), subindo ate o meio-dia",
	xs.every((x, i) => i === 0 || x > xs[i - 1]) && xs[0] < 0.2 && xs[4] > 0.8 && bodyY() < 0.2,
	xs.map(x => x.toFixed(2)).join(" -> "),
);
const dotColors = () =>
	deep(sky(), "Dot1") === undefined
		? []
		: sky()
				.GetChildren()
				.filter(c => c.Name.startsWith("Dot"))
				.map(c => (sameColor(c.BackgroundColor3, SURFACE.section) ? "." : "o"))
				.join("");
check(
	"o caminho que o sol ja fez fica apagado; o que falta do dia fica claro",
	/^\.+o+$/.test(dotColors()),
	dotColors(),
);
const pips = () =>
	sky()
		.GetChildren()
		.filter(c => c.Name.startsWith("Pip") && c.Visible);
check(
	"de dia, um pip vermelho so, na ponta do por do sol: a horda vem ao anoitecer",
	pips().length === 1 && pips()[0].Position.X.Scale > 0.9 && sameColor(pips()[0].BackgroundColor3, STAT.penalty),
);
check("de dia: o sol, nao a lua", deep(sky(), "Sun").Visible && !deep(sky(), "Moon").Visible);

// the night: the moon, the three waves, the countdown to daybreak (MP-21's words)
hud.update(state({ dayTime: 23, isNight: true }));
check(
	"a noite: a lua de pixel, e a contagem ate o amanhecer (06:00) nas palavras da espera (Daybreak in)",
	deep(sky(), "Moon").Visible && !deep(sky(), "Sun").Visible && skyText("Countdown") === expectCount(23),
	skyText("Countdown"),
);
check(
	"a noite: um pip por onda (19:00, 22:00, 01:00); as que ja comecaram ficam apagadas",
	pips().length === 3 &&
		pips().filter(p => sameColor(p.BackgroundColor3, STAT.penalty)).length === 1 &&
		pips().filter(p => sameColor(p.BackgroundColor3, SURFACE.section)).length === 2,
	pips()
		.map(p => (sameColor(p.BackgroundColor3, STAT.penalty) ? "!" : "."))
		.join(""),
);
hud.update(state({ dayTime: 2, isNight: true }));
check(
	"depois da 01:00 as tres ja comecaram",
	pips().every(p => sameColor(p.BackgroundColor3, SURFACE.section)),
);

// the last seconds before nightfall: the number turns red and pulses once a second; Reduce Motion keeps it red
const lastDay = 19 - 20 * Clock.clockSpeed(18.9); // ~20 real seconds before 19:00
setClock(100.1);
hud.update(state({ dayTime: lastDay }));
const pulseA = skyText("Countdown");
setClock(100.6);
hud.update(state({ dayTime: lastDay }));
const pulseB = skyText("Countdown");
check(
	`nos ultimos ${NIGHTFALL_WARN_S} s do dia o numero pisca vermelho / amarelo, 1 vez por segundo (< 3/s)`,
	[pulseA, pulseB].includes(expectCount(lastDay, STAT.penalty)) &&
		[pulseA, pulseB].includes(expectCount(lastDay, STAT.value)) &&
		pulseA !== pulseB,
	`${pulseA} | ${pulseB}`,
);
const gui = service("GuiService");
gui.ReducedMotionEnabled = true;
flush();
const still1 = (setClock(101.1), hud.update(state({ dayTime: lastDay })), skyText("Countdown"));
const still2 = (setClock(101.6), hud.update(state({ dayTime: lastDay })), skyText("Countdown"));
gui.ReducedMotionEnabled = false;
flush();
check(
	"com Reduzir Movimento: vermelho parado, sem piscar",
	still1 === still2 && still1 === expectCount(lastDay, STAT.penalty),
	still1,
);
hud.update(state({ dayTime: 12 }));
check("longe do anoitecer, amarelo de novo", skyText("Countdown") === expectCount(12), skyText("Countdown"));
const skyIdle = phase("60 quadros no mesmo segundo do relogio", () => {
	for (let i = 0; i < 60; i++) hud.update(state({ dayTime: 12 }));
});
check("o ceu parado nao escreve nada", skyIdle.writes === 0 && zero(skyIdle), cost(skyIdle));

// LUZ-05: the weather's pixel icon, in the groove's corner the arc never crosses
{
	const shown = () => {
		const w = deep(sky(), "Weather");
		if (w === undefined || !w.Visible) return "none";
		for (const n of ["Rain", "Storm", "Fog"]) if (deep(w, n)?.Visible) return n;
		return "?";
	};
	const seen = [];
	for (const [weather, fog, dayTime] of [
		[0, 0, 12],
		[1, 0, 12],
		[2, 0, 12],
		[3, 1, 6],
		[3, 0, 12],
		[4, 0.7, 12],
	]) {
		hud.update(state({ dayTime, weather, fog }));
		seen.push(shown());
	}
	check(
		"o clima (LUZ-05): nada num dia limpo; nuvem com gotas na chuva, com raio na tempestade, faixas na neblina; a neblina da manha some quando levanta",
		seen.join(" ") === "none Rain Storm Fog none Fog",
		seen.join(" "),
	);
	// the icon never sits on the path of the sun or the moon, at any hour
	const hit = weatherOnArc(sky);
	check("o icone nunca fica debaixo do sol ou da lua, a qualquer hora", hit === "", hit || "livre o dia todo");
	hud.update(state({ dayTime: 12, weather: 2 }));
	const still = phase("600 quadros de tempestade", () => {
		for (let i = 0; i < 600; i++) hud.update(state({ dayTime: 12, weather: 2 }));
	});
	check("a tempestade parada nao escreve nada no ceu", still.writes === 0 && zero(still), cost(still));
	const cycle = phase("600 quadros trocando de clima", () => {
		for (let i = 0; i < 600; i++) hud.update(state({ dayTime: 12, weather: i % 5, fog: i % 5 >= 3 ? 0.8 : 0 }));
	});
	check("trocar de clima so mostra e esconde: nenhuma Instance criada ou destruida", zero(cycle), cost(cycle));
}
hud.update(state());

// UI-04: no contour on any text of the HUD
const texts = hudRoot()
	.GetDescendants()
	.filter(d => d.ClassName === "TextLabel" || d.ClassName === "TextButton");
const stroked = hudRoot()
	.GetDescendants()
	.filter(
		d =>
			(d.ClassName === "UIStroke" &&
				(d.Parent?.ClassName === "TextLabel" || d.Parent?.ClassName === "TextButton")) ||
			((d.ClassName === "TextLabel" || d.ClassName === "TextButton") && d.TextStrokeTransparency < 1),
	);
check(`nenhum dos ${texts.length} textos da HUD tem contorno (UI-04)`, stroked.length === 0, `${stroked.length}`);

// ---------------------------------------------------------------- 5) touch

console.log("\n5) toque: o console compacto nunca cobre o analogico nem os botoes de tiro\n");

hud.unmount();
uis.TouchEnabled = true;
uis.MouseEnabled = false;
uis.GetLastInputType = () => Enum.UserInputType.Touch;
const TOP_BAR = 58;
const settings = save.settings;
const DEFAULT_PREFS = {
	leftSize: settings.leftSize,
	leftPos: settings.leftPos,
	leftRelative: settings.leftRelative,
	rightSize: settings.rightSize,
	rightPos: settings.rightPos,
	mirror: settings.mirror,
};

/** [left, top, right, bottom] of a circle */
const circle = (x, y, r) => [x - r, y - r, x + r, y + r];
const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const fmt = r => `[${r.map(v => Math.round(v)).join(", ")}]`;

function consoleRect() {
	const f = consoleFrame();
	return [
		f.Position.X.Offset,
		f.Position.Y.Offset,
		f.Position.X.Offset + f.Size.X.Offset,
		f.Position.Y.Offset + f.Size.Y.Offset,
	];
}

/** checks the console against the geometry bootstrap hit-tests with, recomputed here from the same inputs */
function checkTouch(label, w, h, prefs, atBottom = true, skyHome = atBottom) {
	const L = computeTouchLayout(prefs, w, h, TOP_BAR);
	const live = boot.getTouchLayout();
	const same =
		live.viewW === w && live.viewH === h && live.move.homeX === L.move.homeX && live.aim.homeX === L.aim.homeX;
	const c = consoleRect();
	const stick = circle(L.move.homeX, L.move.homeY, L.floating ? L.move.baseR : L.move.grabR);
	const fire = [
		["o pad de mira / tiro", circle(L.aim.homeX, L.aim.homeY, L.aim.baseR)],
		["RELOAD", circle(L.reload.x, L.reload.y, Math.max(L.reload.r, MIN_TOUCH_PX / 2))],
		["USE", circle(L.use.x, L.use.y, Math.max(L.use.r, MIN_TOUCH_PX / 2))],
	];
	const tilePx = ((c[2] - c[0]) / COMPACT_LAYOUT.w) * COMPACT_LAYOUT.tile;
	check(`${label}: a geometria viva do bootstrap e a mesma recalculada aqui`, same);
	check(
		`${label}: o console nao cobre o analogico`,
		!overlaps(c, stick),
		`console ${fmt(c)} / analogico ${fmt(stick)}`,
	);
	for (const [name, r] of fire) {
		check(`${label}: nem ${name}`, !overlaps(c, r), `${fmt(r)}`);
	}
	check(
		`${label}: dentro da tela${atBottom ? ", embaixo" : ", acima dos polegares"}`,
		c[0] >= 0 && c[2] <= w && c[3] <= h && c[1] >= TOP_BAR && (atBottom ? c[3] > h * 0.7 : c[3] <= stick[1]),
		fmt(c),
	);
	check(
		`${label}: o ladrilho e da largura de um polegar (>= ${MIN_TOUCH_PX} px)`,
		tilePx >= MIN_TOUCH_PX - 1e-6,
		`${tilePx.toFixed(1)} px`,
	);
	const hint = deep(hudRoot(), "HintBox");
	check(
		`${label}: a dica "E: ..." fica acima do console`,
		hint.Position.Y.Offset <= c[1],
		`${hint.Position.Y.Offset} <= ${Math.round(c[1])}`,
	);
	checkSky(label, L, c, w, h, skyHome);
	return c;
}

/**
 * The touch sky (hudSky.ts skyPlate, hudConsole.ts placeTouchSky): under the row of Menu and Bag, flush with its outer
 * end, as tall as they are; never over the console, a thumb control, Menu / Bag, a Roblox button, nor the reach of the
 * messages over the top centre (the banner at its widest, popping, and the feed: hud.ts messageReach); when the console
 * floats up there (a crowded phone), wherever the corner -- or the console's side -- is still free.
 */
/** hud.ts BANNER_MIN_W: the narrowest banner card (its own minimum) */
const BANNER_MIN_W_UNITS = 280;
function checkSky(label, L, c, w, h, atHome, chipHome = atHome) {
	const f = deep(hudRoot(), "SkyPlate");
	const r = [
		f.Position.X.Offset,
		f.Position.Y.Offset,
		f.Position.X.Offset + f.Size.X.Offset,
		f.Position.Y.Offset + f.Size.Y.Offset,
	];
	// the messages as the HUD draws them now: on touch narrowed so they stop short of the sky (hud.ts fitMessages)
	const [bannerW, feedW] = hud.messageWidths();
	// at the HUD size the HUD was mounted with (hud.ts: k = 0,8 + 0,4 x uiSize)
	const [banner, feed] = messageReach(w, h, L.inset, bannerW, feedW, 0.8 + 0.4 * settings.uiSize);
	const others = [
		["o console", c],
		["o analogico", circle(L.move.homeX, L.move.homeY, L.floating ? L.move.baseR : L.move.grabR)],
		["o pad de mira", circle(L.aim.homeX, L.aim.homeY, L.aim.baseR)],
		["RELOAD", circle(L.reload.x, L.reload.y, Math.max(L.reload.r, MIN_TOUCH_PX / 2))],
		["USE", circle(L.use.x, L.use.y, Math.max(L.use.r, MIN_TOUCH_PX / 2))],
		["Menu", circle(L.pause.x, L.pause.y, L.pause.r)],
		["Bag", circle(L.bag.x, L.bag.y, L.bag.r)],
		["a faixa (onda, manha) no maior tamanho que a HUD desenha, no pulo", banner],
		["as mensagens embaixo dela", feed],
	];
	const hit = others.filter(([, o]) => overlaps(r, o)).map(([n]) => n);
	check(
		`${label}: o relogio (toque) nao cobre nada: console, polegares, Menu, Bag, faixa, mensagens`,
		hit.length === 0,
		hit.length > 0 ? `sobre ${hit.join(", ")} ${fmt(r)}` : fmt(r),
	);
	check(
		`${label}: o relogio fica na tela, abaixo da barra do Roblox`,
		r[0] >= 0 && r[2] <= w && r[1] >= L.inset && r[3] <= h,
		fmt(r),
	);
	const rowR = Math.max(L.pause.x + L.pause.r, L.bag.x + L.bag.r);
	const rowB = Math.max(L.pause.y + L.pause.r, L.bag.y + L.bag.r);
	if (atHome) {
		check(
			`${label}: logo abaixo da fileira do Menu e do Bag, rente a ponta dela`,
			Math.abs(r[2] - rowR) <= 1 && r[1] >= rowB && r[1] - rowB <= L.pause.r,
			`${fmt(r)} / fileira ate x ${Math.round(rowR)}, y ${Math.round(rowB)}`,
		);
	}
	check(
		`${label}: a faixa e as mensagens ficam no centro, e continuam largas (faixa >= ${BANNER_MIN_W_UNITS} unidades)`,
		bannerW >= BANNER_MIN_W_UNITS && feedW >= 200,
		`faixa ate ${Math.round(bannerW)} de 720 unidades, linha ate ${Math.round(feedW)} de 560`,
	);
	const px = (r[3] - r[1]) / SKY_PLATE_H;
	check(
		`${label}: o texto do relogio nao fica abaixo do piso de 9 px`,
		["Day", "Countdown"].every(n => {
			const c2 = deep(f, n)?.FindFirstChildOfClass("UITextSizeConstraint");
			return c2 !== undefined && c2.MaxTextSize >= 9;
		}),
		`${px.toFixed(2)} px por unidade, largura ${Math.round(r[2] - r[0])} px (${SKY_PLATE_W} unidades)`,
	);
	checkChip(label, L, others, r, chipHome);
	checkQuickDeck(label, L, c, r);
}

/** a frame's rect in screen pixels, from its Offset placement (the touch layer's frames are placed in pixels) */
const offsetRect = f => [
	f.Position.X.Offset,
	f.Position.Y.Offset,
	f.Position.X.Offset + f.Size.X.Offset,
	f.Position.Y.Offset + f.Size.Y.Offset,
];

/**
 * (ITM-08) The touch quick deck (hudQuick.ts QuickDeck, hudConsole.ts placeTouchQuick): the HEAL and EAT tiles, each a
 * thumb target (>= MIN_TOUCH_PX on both sides, the hotbar tile's size), on screen under the Roblox bar, covering nothing
 * -- the thumbs, Menu, Bag, the sky, the chip, the console --, and the prompt "E: ..." never over it.
 */
function checkQuickDeck(label, L, c, sky) {
	const deckFrame = deep(hudRoot(), "QuickDeck");
	check(`${label}: os ladrilhos rapidos (HEAL / EAT) tem a sua placa no toque`, deckFrame !== undefined);
	if (deckFrame === undefined) return;
	const d = offsetRect(deckFrame);
	const slot = deep(hudRoot(), "ChipSlot");
	const chip = slot !== undefined ? offsetRect(slot) : undefined;
	const others = [
		["o console", c],
		["o analogico", circle(L.move.homeX, L.move.homeY, L.floating ? L.move.baseR : L.move.grabR)],
		["o pad de mira", circle(L.aim.homeX, L.aim.homeY, L.aim.baseR)],
		["RELOAD", circle(L.reload.x, L.reload.y, Math.max(L.reload.r, MIN_TOUCH_PX / 2))],
		["USE", circle(L.use.x, L.use.y, Math.max(L.use.r, MIN_TOUCH_PX / 2))],
		["Menu", circle(L.pause.x, L.pause.y, L.pause.r)],
		["Bag", circle(L.bag.x, L.bag.y, L.bag.r)],
		["o relogio", sky],
		...(chip !== undefined ? [["o chip do placar", chip]] : []),
	];
	const hit = others.filter(([, o]) => overlaps(d, o)).map(([n]) => n);
	if (process.env.PZ_DEBUG_QUICK) {
		console.log(`    DEBUG ${label} view ${L.viewW}x${L.viewH} inset ${L.inset} deck ${fmt(d)}`);
		for (const [n, o] of others) console.log(`      ${n} ${fmt(o)}`);
	}
	check(
		`${label}: a placa rapida nao cobre nada: console, polegares, Menu, Bag, relogio, chip`,
		hit.length === 0,
		hit.length > 0 ? `sobre ${hit.join(", ")} ${fmt(d)}` : fmt(d),
	);
	// the tiles' size: the deck's pixels per design unit x the tile's design side (the hotbar tile's)
	const scale = (d[2] - d[0]) / deckFrame.GetAttribute("DesignW");
	const tilePx = scale * COMPACT_LAYOUT.tile;
	check(
		`${label}: na tela, abaixo da barra do Roblox, cada ladrilho um alvo de polegar (>= ${MIN_TOUCH_PX} px)`,
		d[0] >= 0 &&
			d[2] <= L.viewW + 0.5 &&
			d[1] >= L.inset - 0.5 &&
			d[3] <= L.viewH + 0.5 &&
			tilePx >= MIN_TOUCH_PX - 0.5,
		`ladrilho ${tilePx.toFixed(1)} px`,
	);
	// the prompt: centred over the console, anchored at its bottom, a box of 440 x 46 design units x the HUD size
	const hint = deep(hudRoot(), "HintBox");
	const k = 0.8 + 0.4 * settings.uiSize;
	const s = Math.min(L.viewW / 1120, L.viewH / 630) * k;
	const hx = hint.Position.X.Offset;
	const hb = hint.Position.Y.Offset;
	const hr = [hx - (440 * s) / 2, hb - 46 * s, hx + (440 * s) / 2, hb];
	check(`${label}: a dica "E: ..." nunca fica sobre a placa rapida`, !overlaps(hr, d), `dica ${fmt(hr)}`);
	// the pickup chips (ITM-07, pickupToast.ts): a column as wide as the prompt, anchored at its bottom, the rows over
	// its height -- all CHIP_ROWS of them at their widest, never over the quick tiles either
	const { TOAST_W, TOAST_H } = require(join(SRC, "client/ui/pickupToast.ts"));
	const toast = deep(hudRoot(), "PickupToast");
	const rows = [hx - (TOAST_W * s) / 2, hb - TOAST_H * s, hx + (TOAST_W * s) / 2, hb - 46 * s];
	check(
		`${label}: a coluna da coleta ("+12 Wood") sobe com a dica e nunca fica sobre a placa rapida`,
		toast !== undefined &&
			toast.Position.X.Offset === hx &&
			toast.Position.Y.Offset === hb &&
			toast.Position.X.Scale === 0 &&
			toast.Position.Y.Scale === 0 &&
			!overlaps(rows, d),
		`coleta ${fmt(rows)}`,
	);
	// ...and where the prompt went over the tiles, it and the chips still end below the Roblox bar: a small phone whose
	// console floated up puts the tiles under the console instead (hudConsole.ts placeTouchQuick `prompt`)
	if (d[3] <= c[1] + 1 && hr[0] < d[2] && d[0] < hr[2]) {
		check(
			`${label}: a dica subiu sobre a placa rapida e ela e a coleta continuam na tela, abaixo da barra do Roblox`,
			rows[1] >= L.inset - 1,
			`coleta a partir de y ${Math.round(rows[1])}, barra ate ${L.inset}`,
		);
	}
}

/**
 * The match scoreboard's survivors chip on touch (MP-23; hudConsole.ts placeTouchChip): where Bag and Menu are, in
 * their row left of Menu, and with the sky right under the row its left edge is the sky's (the corner is one block);
 * a thumb target that covers nothing -- the console, a thumb control, Menu, Bag, the sky, nor the banner and the feed
 * as the HUD draws them now (narrowed off the corner, hud.ts fitMessages).
 */
function checkChip(label, L, others, sky, atHome) {
	const slot = deep(hudRoot(), "ChipSlot");
	const found = slot !== undefined && deep(slot, "Survivors") !== undefined;
	check(`${label}: o chip do placar esta no canto de toque`, found);
	if (!found) return;
	const r = [
		slot.Position.X.Offset,
		slot.Position.Y.Offset,
		slot.Position.X.Offset + slot.Size.X.Offset,
		slot.Position.Y.Offset + slot.Size.Y.Offset,
	];
	const hit = [...others, ["o relogio", sky]].filter(([, o]) => overlaps(r, o)).map(([n]) => n);
	check(
		`${label}: o chip nao cobre nada: console, polegares, Menu, Bag, relogio, faixa, mensagens`,
		hit.length === 0,
		hit.length > 0 ? `sobre ${hit.join(", ")} ${fmt(r)}` : fmt(r),
	);
	check(
		`${label}: o chip fica na tela, abaixo da barra do Roblox, e e um alvo de polegar (>= ${MIN_TOUCH_PX} px)`,
		r[0] >= 0 &&
			r[2] <= L.viewW &&
			r[1] >= L.inset &&
			r[3] <= L.viewH &&
			r[2] - r[0] >= MIN_TOUCH_PX - 0.5 &&
			r[3] - r[1] >= MIN_TOUCH_PX - 0.5,
		`${Math.round(r[2] - r[0])} x ${Math.round(r[3] - r[1])} px`,
	);
	if (atHome) {
		const menuL = L.pause.x - L.pause.r;
		const rowB = Math.max(L.pause.y + L.pause.r, L.bag.y + L.bag.r);
		// with the sky right under the row the corner is one block: the chip starts where the clock starts
		const skyUnder = sky[1] >= rowB && sky[1] - rowB <= L.pause.r;
		check(
			`${label}: o chip e o terceiro botao da fileira, a esquerda do Menu${skyUnder ? ", e comeca onde o relogio comeca" : ""}`,
			r[2] <= menuL &&
				menuL - r[2] <= L.pause.r &&
				Math.abs((r[1] + r[3]) / 2 - L.pause.y) <= 1 &&
				(!skyUnder || Math.abs(r[0] - sky[0]) <= 1),
			`${fmt(r)} / Menu a partir de x ${Math.round(menuL)}, relogio a partir de x ${Math.round(sky[0])}`,
		);
	}
	const c = deep(slot, "Count")?.FindFirstChildOfClass("UITextSizeConstraint");
	check(`${label}: a contagem do chip nao fica abaixo do piso de 9 px`, c !== undefined && c.MaxTextSize >= 9);
	// the open scoreboard, pinned to the left edge, never covers the day clock nor its own chip (MP-23) -- with the
	// largest controls the two move to the top left, where the panel opens
	const board = hud.scoreboard();
	board.toggle();
	const p = board.frame.Position;
	const s = board.frame.Size;
	const panel = [p.X.Offset, p.Y.Offset, p.X.Offset + s.X.Offset, p.Y.Offset + s.Y.Offset];
	board.toggle();
	// the compass / GPS plate at the top left (hudNav.ts; at its largest, the map) moves down under the sky and the chip
	// when a crowded layout sends them to its corner: the three never overlap
	const navHolder = deep(hudRoot(), "Nav");
	const nr = navReach(L.viewW, L.viewH, L.inset, 0.8 + 0.4 * settings.uiSize);
	const push = navHolder?.Position.Y.Offset ?? 0;
	const nav = [nr[0], nr[1] + push, nr[2], nr[3] + push];
	check(
		`${label}: a bussola / o GPS (em cima a esquerda) nao fica sob o relogio nem sob o chip`,
		navHolder !== undefined && !overlaps(nav, sky) && !overlaps(nav, r),
		`${fmt(nav)}${push !== 0 ? `, descida ${push} px` : ""}`,
	);
	check(
		`${label}: o placar aberto nao cobre o relogio nem o chip, e cabe na tela`,
		!overlaps(panel, sky) && !overlaps(panel, r) && panel[1] >= L.inset && panel[3] <= L.viewH + 0.5,
		fmt(panel),
	);
}

setViewport(1120, 630, TOP_BAR);
const touchMount = phase("monta a HUD (toque, 1120x630)", () => {
	hud.mount();
	hud.update(state());
});
console.log(`  (montar no toque custa ${touchMount.created} Instances)`);
{
	const touchSky = () => deep(deep(hudRoot(), "SkyPlate"), "SkyWindow");
	const hit = weatherOnArc(touchSky);
	check("no toque, o icone do clima tambem nunca fica sob o sol ou a lua (LUZ-05)", hit === "", hit || "livre");
}
check(
	"no toque: barras e hotbar so; Bag e Menu sao do toque (cantos de cima)",
	consoleFrame() !== undefined &&
		deep(consoleFrame(), "Bag") === undefined &&
		deep(consoleFrame(), "Menu") === undefined &&
		deep(consoleFrame(), "WeaponName") === undefined &&
		deep(hudRoot(), "BagBtn") !== undefined &&
		deep(hudRoot(), "MenuBtn") !== undefined,
);
check(
	"no toque o ladrilho nao mostra tecla (toca-se o proprio ladrilho)",
	keyLegend(0) === undefined && keyLegend(2) === undefined,
);
const touchRect = checkTouch("1120x630 (phone)", 1120, 630, DEFAULT_PREFS);
console.log(
	`  console no phone: ${fmt(touchRect)} = ${Math.round(touchRect[2] - touchRect[0])} x ${Math.round(touchRect[3] - touchRect[1])} px`,
);
// messageReach is makeAnchored's recipe written out: it must be where the real banner and feed frames land
{
	const pxOf = (fr, vw, vh) => {
		const ar = fr.FindFirstChildOfClass("UIAspectRatioConstraint").AspectRatio;
		const pw = Math.min(fr.Size.X.Scale * vw, fr.Size.Y.Scale * vh * ar);
		const ph = pw / ar;
		const x = fr.Position.X.Scale * vw + fr.Position.X.Offset - fr.AnchorPoint.X * pw;
		const y = fr.Position.Y.Scale * vh + fr.Position.Y.Offset - fr.AnchorPoint.Y * ph;
		return [x, y, x + pw, y + ph];
	};
	const [reachBanner, reachFeed] = messageReach(1120, 630, TOP_BAR);
	const banner = pxOf(deep(hudRoot(), "BannerBox"), 1120, 630);
	const feed = pxOf(deep(hudRoot(), "Feed"), 1120, 630);
	const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
	const popped = [
		(banner[0] + banner[2]) / 2 - ((banner[2] - banner[0]) * 1.2) / 2,
		banner[1],
		(banner[0] + banner[2]) / 2 + ((banner[2] - banner[0]) * 1.2) / 2,
		banner[1] + (banner[3] - banner[1]) * 1.2,
	];
	check(
		"o alcance das mensagens (hud.ts messageReach) e onde a faixa (no pulo de 1,2x) e as mensagens ficam de verdade",
		near(reachBanner, popped) && near(reachFeed, feed),
		`faixa ${fmt(reachBanner)} / ${fmt(popped)}; mensagens ${fmt(reachFeed)} / ${fmt(feed)}`,
	);
}

input.beginFrame();
tile(2).Activated.Fire();
flush();
check("tocar no ladrilho 3 e a tecla 3", input.weaponSlotPressed === 2);
input.beginFrame();

const touch600 = phase("600 quadros no toque", () => {
	for (let i = 0; i < 600; i++) {
		setClock(3000 + i / 60);
		hud.update(frameState(i));
	}
});
check("600 quadros no toque nao criam nem destroem Instance", zero(touch600), cost(touch600));

setViewport(1360, 435, TOP_BAR);
const wideRect = checkTouch("1360x435 (wide)", 1360, 435, DEFAULT_PREFS);
console.log(
	`  console no wide: ${fmt(wideRect)} = ${Math.round(wideRect[2] - wideRect[0])} x ${Math.round(wideRect[3] - wideRect[1])} px`,
);

const VARIANTS = [
	["canhoto", { mirror: true }],
	["controles no maximo", { leftSize: 1, rightSize: 1 }],
	["analogico fixo", { leftRelative: false }],
	[
		"canhoto, maximo, fixo e erguidos",
		{ mirror: true, leftSize: 1, rightSize: 1, leftRelative: false, leftPos: 1, rightPos: 1 },
	],
];
for (const [w, h] of [
	[1120, 630],
	[1360, 435],
]) {
	setViewport(w, h, TOP_BAR);
	for (const [name, over] of VARIANTS) {
		const prefs = { ...DEFAULT_PREFS, ...over };
		Object.assign(settings, prefs);
		const re = phase(`toque ${w}x${h} ${name}: reposiciona`, () => boot.refreshTouchLayout());
		// with the controls at their largest the corner under Menu and Bag may be RELOAD's: the sky takes the next free place
		checkTouch(`${w}x${h} ${name}`, w, h, prefs, true, !name.includes("maximo"));
		check(
			`${w}x${h} ${name}: reposicionar o console nao cria nada nele`,
			re.log.every(e => !e.inst[INTERNAL] || !isUnder(e.inst, consoleFrame())),
		);
	}
	Object.assign(settings, DEFAULT_PREFS);
	boot.refreshTouchLayout();
}

// a phone held upright: the two thumbs meet in the middle of the bottom edge, so the console goes above them
setViewport(390, 844, 47);
{
	const L = computeTouchLayout(DEFAULT_PREFS, 390, 844, 47);
	const c = consoleRect();
	const all = [
		circle(L.move.homeX, L.move.homeY, L.move.baseR),
		circle(L.aim.homeX, L.aim.homeY, L.aim.baseR),
		circle(L.reload.x, L.reload.y, Math.max(L.reload.r, MIN_TOUCH_PX / 2)),
		circle(L.use.x, L.use.y, Math.max(L.use.r, MIN_TOUCH_PX / 2)),
	];
	check(
		"390x844 (retrato): sem faixa entre os polegares, o console sobe acima deles e nao cobre nenhum",
		all.every(r => !overlaps(c, r)) && c[0] >= 0 && c[2] <= 390 && c[1] >= 47,
		`console ${fmt(c)}`,
	);
	// the chip's home in the row, left of Menu, is where the banner reaches on a portrait phone: it goes beside the sky
	checkSky("390x844 (retrato)", L, c, 390, 844, true, false);
}
// a crowded phone: 844 x 390 with every control at its largest and raised -- the console floats up to the top row, so
// the clock has to find the other free place (the row's left end, or the console's side)
{
	const prefs = {
		...DEFAULT_PREFS,
		mirror: true,
		leftSize: 1,
		rightSize: 1,
		leftRelative: false,
		leftPos: 1,
		rightPos: 1,
	};
	Object.assign(settings, prefs);
	setViewport(844, 390, 36);
	boot.refreshTouchLayout();
	checkSky("844x390 lotado", computeTouchLayout(prefs, 844, 390, 36), consoleRect(), 844, 390, false);
	Object.assign(settings, DEFAULT_PREFS);
}
for (const [w, h, bar] of [
	[844, 390, 36],
	[932, 430, 47],
	[667, 375, 20],
]) {
	setViewport(w, h, bar);
	boot.refreshTouchLayout();
	// on the 667 x 375 phone the thumbs meet, the console floats up above them (placeTouchConsole's last step) and takes
	// the band under Menu and Bag: the sky goes to the other end of their row
	const L = computeTouchLayout(DEFAULT_PREFS, w, h, bar);
	checkSky(`${w}x${h} (celular)`, L, consoleRect(), w, h, w !== 667, true);
}
// the HUD size setting at its largest (x1,2, test:settings §3): the banner and the feed are 20% bigger, still at the
// top, and on touch they still narrow off the corner -- the sky and the chip -- keeping at least their minimum
{
	const k = settings.uiSize;
	settings.uiSize = 1;
	for (const [w, h, bar] of [
		[844, 390, 36],
		[1120, 630, TOP_BAR],
	]) {
		setViewport(w, h, bar);
		hud.unmount();
		hud.mount();
		hud.update(state());
		const L = computeTouchLayout(DEFAULT_PREFS, w, h, bar);
		const [bannerW, feedW] = hud.messageWidths();
		const [banner] = messageReach(w, h, L.inset, bannerW, feedW, 1.2);
		const unscaled = messageReach(w, h, L.inset, bannerW, feedW, 1)[0];
		check(
			`${w}x${h} (HUD size 120%): a faixa e 1,2x maior e continua no topo`,
			Math.abs(banner[2] - banner[0] - (unscaled[2] - unscaled[0]) * 1.2) < 0.01 && banner[1] === unscaled[1],
			fmt(banner),
		);
		checkSky(`${w}x${h} (HUD size 120%)`, L, consoleRect(), w, h, true, true);
	}
	settings.uiSize = k;
	hud.unmount();
	hud.mount();
}
setViewport(1120, 630, TOP_BAR);

function isUnder(inst, root) {
	if (root === undefined) return false;
	return inst === root || inst.IsDescendantOf(root);
}

// ---------------------------------------------------------------- 5b) three ScreenGuis, and a phone with a notch

console.log("\n5b) tres ScreenGuis (mundo / HUD / menus) e o toque num celular com entalhe\n");
{
	const pg = service("Players").LocalPlayer.FindFirstChild("PlayerGui");
	const [world, hudG, uiG] = ["GameGui", "HudGui", "UiGui"].map(n => pg.FindFirstChild(n));
	check(
		"tres ScreenGuis, desenhadas nesta ordem (DisplayOrder): o mundo, a HUD, os menus",
		world === ctx.screen &&
			hudG === ctx.hudGui &&
			uiG === ctx.uiGui &&
			world.DisplayOrder < hudG.DisplayOrder &&
			hudG.DisplayOrder < uiG.DisplayOrder,
		[world, hudG, uiG].map(g => `${g?.Name} ${g?.DisplayOrder}`).join(" < "),
	);
	check(
		"o mundo cobre a tela inteira (ScreenInsets None, sem recorte); a HUD e os menus ficam na area segura do aparelho",
		world.ScreenInsets === Enum.ScreenInsets.None &&
			world.ClipToDeviceSafeArea === false &&
			world.SafeAreaCompatibility === Enum.SafeAreaCompatibility.None &&
			hudG.ScreenInsets === Enum.ScreenInsets.DeviceSafeInsets &&
			uiG.ScreenInsets === Enum.ScreenInsets.DeviceSafeInsets &&
			[world, hudG, uiG].every(g => g.ZIndexBehavior === Enum.ZIndexBehavior.Sibling && g.ResetOnSpawn === false),
		[world, hudG, uiG].map(g => `${g.Name} ${g.ScreenInsets?.Name}`).join(", "),
	);
	const root = ctx.root;
	check(
		"cada camada na sua: mundo < noite < fundo dos menus na do mundo; a HUD na da HUD; os menus na dos menus",
		root.Parent === world &&
			ctx.worldLayer.Parent === root &&
			ctx.darkLayer.Parent === root &&
			ctx.backdropLayer.Parent === root &&
			ctx.worldLayer.ZIndex < ctx.darkLayer.ZIndex &&
			ctx.darkLayer.ZIndex < ctx.backdropLayer.ZIndex &&
			ctx.hudLayer.Parent === hudG &&
			ctx.uiLayer.Parent === uiG,
		`mundo ${ctx.worldLayer.ZIndex}, noite ${ctx.darkLayer.ZIndex}, fundo ${ctx.backdropLayer.ZIndex}`,
	);
	// the menus' ScreenGui: off in a run with nothing open; a toast or the hit flash turn it on, and off again
	const { showToast } = require(join(SRC, "client/ui/widgets.ts"));
	const { DangerFlash } = require(join(SRC, "client/ui/dangerFlash.ts"));
	const offInRun = hud.isMounted() && uiG.Enabled === false;
	showToast(ctx.uiLayer, "Saving...");
	flush();
	const onToast = uiG.Enabled;
	for (const t of ctx.uiLayer.FindFirstChild("ToastStack").GetChildren()) if (t.Name === "Toast") t.Destroy();
	flush();
	const offAfterToast = uiG.Enabled === false;
	const flash = new DangerFlash(ctx);
	flash.frame(1 / 60, true, 100);
	flash.frame(1 / 60, true, 80);
	const onFlash = uiG.Enabled;
	flash.reset();
	const offAfterFlash = uiG.Enabled === false;
	check(
		"a ScreenGui dos menus nao desenha na partida sem menu; um toast ou o flash de dano a ligam, e ela desliga quando somem",
		offInRun && onToast && offAfterToast && onFlash && offAfterFlash,
		`partida ${offInRun}, toast ${onToast} -> ${offAfterToast}, flash ${onFlash} -> ${offAfterFlash}`,
	);

	// a phone with a notch: the world under it, the HUD beside it, and a finger lands where the control is drawn
	const gs = service("GuiService");
	const PHONES = [
		// an iPhone held sideways: the notch's side and its twin are both inset, and the home indicator at the bottom
		["844x390, entalhe dos dois lados + indicador", 844, 390, 36, { left: 47, right: 47, bottom: 21 }],
		// an Android punch-hole on one side only: the safe area is off-centre
		["800x360, furo de camera a esquerda", 800, 360, 36, { left: 32 }],
	];
	for (const [label, w, h, bar, cut] of PHONES) {
		setViewport(w, h, bar, 120, cut);
		input.aimMode = "touch";
		hud.update(state());
		layoutGame(ui, ctx);
		const L = boot.getTouchLayout();
		const safe = { x: cut.left ?? 0, y: cut.top ?? 0, w: w - (cut.left ?? 0) - (cut.right ?? 0) };
		safe.h = h - safe.y - (cut.bottom ?? 0);
		// where the core UI safe area starts on the screen: a touch's Position is measured from there (the engine's own
		// "accounting for GUI insets"), which is the whole point of the shim's GetInsetArea / GetGuiInset
		const none = gs.GetInsetArea(Enum.ScreenInsets.None);
		const core = { x: -none.Min.X, y: -none.Min.Y };
		const centre = f => {
			const r = rectOf(f);
			return [r.x + r.w / 2, r.y + r.h / 2];
		};
		const near = (a, b) => Math.abs(a - b) <= 0.5;
		check(
			`${label}: a geometria de toque e a da area segura (${safe.w} x ${safe.h}), e o mundo cobre a tela inteira`,
			L.viewW === safe.w &&
				L.viewH === safe.h &&
				rectOf(ctx.worldLayer).w === w &&
				rectOf(ctx.hudLayer).x === safe.x,
			`toque ${L.viewW} x ${L.viewH}, mundo ${rectOf(ctx.worldLayer).w}, HUD a partir de x ${rectOf(ctx.hudLayer).x}`,
		);
		const bad = [];
		for (const [name, frame, at] of [
			["o analogico", deep(hudRoot(), "JoyBase"), [L.move.homeX, L.move.homeY]],
			["o pad de mira", deep(hudRoot(), "AimPad"), [L.aim.homeX, L.aim.homeY]],
		]) {
			const [cx, cy] = centre(frame);
			if (!near(cx, safe.x + at[0]) || !near(cy, safe.y + at[1])) bad.push(`${name} desenhado em ${cx},${cy}`);
			// the finger on the drawn centre, as the engine reports it, through bootstrap's real handler
			const finger = {
				UserInputType: Enum.UserInputType.Touch,
				KeyCode: Enum.KeyCode.Unknown,
				Position: new Vector3(cx - core.x, cy - core.y, 0),
			};
			uis.InputBegan.Fire(finger, false);
			flush();
			const hit =
				name === "o analogico"
					? input.joystickActive && near(input.joystickBaseX, at[0]) && near(input.joystickBaseY, at[1])
					: input.aimStickActive && near(input.aimStickBaseX, at[0]) && near(input.aimStickBaseY, at[1]);
			if (!hit) bad.push(`${name}: o toque no desenho nao pega o controle ali`);
			uis.InputEnded.Fire(finger, false);
			flush();
		}
		check(
			`${label}: o analogico e o pad de mira: onde estao desenhados e onde o dedo os pega e o mesmo ponto`,
			bad.length === 0,
			bad.join("; "),
		);
		const out = [];
		for (const name of ["BagBtn", "MenuBtn", "ReloadBtn", "ChipSlot", "SkyPlate"]) {
			const r = rectOf(deep(hudRoot(), name));
			const inside =
				r.x >= safe.x - 0.5 &&
				r.x + r.w <= safe.x + safe.w + 0.5 &&
				r.y >= safe.y + bar - 0.5 &&
				r.y + r.h <= safe.y + safe.h + 0.5;
			if (!inside)
				out.push(`${name} [${Math.round(r.x)}, ${Math.round(r.y)}, ${Math.round(r.w)} x ${Math.round(r.h)}]`);
		}
		check(
			`${label}: Bag, Menu, Reload, o chip e o relogio ficam na area segura, abaixo da barra`,
			out.length === 0,
			out.join("; "),
		);
		// the aim cursor rides around the survivor, who is the middle of the WHOLE screen (the camera), not of the safe area
		const cursor = deep(hudRoot(), "AimCursor");
		const [kx, ky] = centre(cursor);
		const reach = Math.max(64 * L.scale, 52);
		const rad = (cursor.Rotation * Math.PI) / 180;
		const [ox, oy] = [kx - Math.cos(rad) * reach, ky - Math.sin(rad) * reach];
		check(
			`${label}: a mira de toque gira em volta do sobrevivente (o centro da tela inteira)`,
			cursor.Visible && near(ox, w / 2) && near(oy, h / 2),
			`${ox.toFixed(1)}, ${oy.toFixed(1)} / ${w / 2}, ${h / 2}`,
		);
	}
	setViewport(1120, 630, TOP_BAR);
	hud.update(state());
}

// ---------------------------------------------------------------- 5c) the player's device: UserInputService.PreferredInput

console.log("\n5c) o dispositivo do jogador: UserInputService.PreferredInput, uma resposta so\n");
{
	const { currentScheme, SCHEME_KEYBOARD, SCHEME_TOUCH, SCHEME_GAMEPAD } = require(
		join(SRC, "client/ui/tutorial.ts"),
	);
	const { gamepadActive } = require(join(SRC, "client/ui/widgets.ts"));
	const hintKey = () => deep(deep(hudRoot(), "HintBox"), "Key")?.FindFirstChild("Text")?.Text;
	const touchDrawn = () => deep(hudRoot(), "BagBtn") !== undefined && deep(consoleFrame(), "Bag") === undefined;
	const deskDrawn = () => deep(hudRoot(), "BagBtn") === undefined && deep(consoleFrame(), "Bag") !== undefined;
	// a touch laptop / a tablet with a keyboard: a touch screen AND a mouse, the mouse in use. The old HUD read only
	// TouchEnabled and drew the thumbs' controls while the bootstrap aimed with the mouse: two answers in one frame
	hud.unmount();
	uis.TouchEnabled = true;
	uis.MouseEnabled = true;
	uis.GetLastInputType = () => Enum.UserInputType.MouseMovement;
	uis.PreferredInput = Enum.PreferredInput.KeyboardAndMouse;
	input.aimMode = "mouse";
	hud.mount();
	hud.update(state());
	check(
		"aparelho hibrido com o mouse em uso: a HUD de desktop, a mira do mouse e as teclas do teclado (uma resposta so)",
		deskDrawn() && input.aimMode === "mouse" && currentScheme() === SCHEME_KEYBOARD && !gamepadActive(),
		`HUD ${deskDrawn() ? "desktop" : "toque"}, mira ${input.aimMode}, esquema ${currentScheme()}`,
	);
	// the player puts the mouse down and plays on the glass: the HUD rebuilds for touch, the aim follows the thumbs
	const toTouch = measure(() => {
		uis.PreferredInput = Enum.PreferredInput.Touch;
		flush();
		hud.update(state());
	});
	check(
		"o jogador passa a usar a tela de toque: a HUD se refaz com os controles de toque, a mira vira de toque, Controls abre em Touch",
		touchDrawn() && input.aimMode === "touch" && currentScheme() === SCHEME_TOUCH,
		`${toTouch.created} criadas, ${toTouch.destroyed} destruidas`,
	);
	// ...then picks a pad up: no touch controls, and every hint names the pad's buttons
	uis.PreferredInput = Enum.PreferredInput.Gamepad;
	flush();
	hud.update(state());
	hud.setInteractHint("E: Open door");
	const padKey = hintKey();
	check(
		"e pega um controle: a HUD de desktop de novo, a dica diz X, o foco do kit e o do controle, Controls abre em Gamepad",
		deskDrawn() && padKey === "X" && gamepadActive() && currentScheme() === SCHEME_GAMEPAD,
		`dica ${padKey}, esquema ${currentScheme()}`,
	);
	// ...and back to the keyboard: the hint says E again, without a rebuild (the hints follow every frame)
	const toKeys = measure(() => {
		uis.PreferredInput = Enum.PreferredInput.KeyboardAndMouse;
		flush();
		hud.setInteractHint("E: Open door");
	});
	check(
		"de volta ao teclado: a dica diz E, sem refazer a HUD (so o toque troca os controles)",
		hintKey() === "E" && toKeys.created === 0 && toKeys.destroyed === 0 && currentScheme() === SCHEME_KEYBOARD,
		`dica ${hintKey()}, ${toKeys.created} criadas`,
	);
	// a phone is a phone: PreferredInput Touch from the start is the touch HUD, as TouchEnabled without a mouse was
	hud.unmount();
	uis.MouseEnabled = false;
	uis.GetLastInputType = () => Enum.UserInputType.Touch;
	uis.PreferredInput = undefined;
	hud.mount();
	hud.update(state());
	check(
		"um celular (sem mouse, o toque em uso): a HUD de toque, como antes",
		touchDrawn() && currentScheme() === SCHEME_TOUCH,
	);
	hud.setInteractHint(undefined);
	void SCHEME_KEYBOARD;
}

hud.unmount();
check("desmontar remove tudo", hudRoot() === undefined);

// ---------------------------------------------------------------- 6) the hotbar with the item icon atlas

console.log("\n6) a hotbar com o atlas dos icones: um ImageLabel por ladrilho, nenhum Frame de icone reservado\n");
{
	const named = name =>
		hudRoot()
			.GetDescendants()
			.filter(d => d.Name === name).length;
	setIconAtlas("");
	const flatMount = phase("monta a HUD (toque), icones em Frames", () => {
		hud.mount();
		hud.update(state());
	});
	const flatPx = named("Px");
	const flatAll = hudRoot().GetDescendants().length;
	hud.unmount();
	setIconAtlas("rbxassetid://910000001");
	const atlasMount = phase("monta a HUD (toque), icones do atlas", () => {
		hud.mount();
		hud.update(state());
	});
	const images = named("Atlas");
	// the hotbar's five, the two quick tiles (ITM-08), and one per pickup chip (ITM-07, client/ui/pickupToast.ts): each
	// icon is the Bag's too
	const { CHIP_ROWS: chipRows } = require(join(SRC, "client/ui/pickupToast.ts"));
	const oneImage = b => {
		const kids = deep(b, "ItemIcon")?.GetChildren() ?? [];
		return kids.length === 1 && kids[0].ClassName === "ImageLabel";
	};
	const quickTiles = ["QuickHeal", "QuickEat"].map(n => deep(hudRoot(), n));
	check(
		"cada ladrilho da hotbar e cada ladrilho rapido (HEAL / EAT) e UM ImageLabel, sem a reserva de Frames (e cada chip da coleta, outro)",
		named("Px") === 0 &&
			images === 5 + 2 + chipRows &&
			[0, 1, 2, 3, 4].every(k => oneImage(tile(k))) &&
			quickTiles.every(b => b !== undefined && oneImage(b)),
		`${images} imagens; sem atlas eram ${flatPx} Frames`,
	);
	check(
		"montar custa so isso a menos: os Frames de icone viram imagens (5 da hotbar, 2 rapidos, 1 por chip), o resto e o mesmo",
		atlasMount.created === flatMount.created - flatPx + images &&
			hudRoot().GetDescendants().length === flatAll - flatPx + images,
		`${flatMount.created} -> ${atlasMount.created} Instances`,
	);
	const cellOk = k => {
		const img = deep(tile(k), "ItemIcon")?.GetChildren()[0];
		const c = ICON_ATLAS_CELLS[iconKey(k)];
		return (
			img?.Visible === true && c !== undefined && img.ImageRectOffset.X === c[0] && img.ImageRectOffset.Y === c[1]
		);
	};
	const armed = [0, 1, 2, 3, 4].filter(k => iconKey(k) !== undefined);
	check(
		"e cada imagem mostra a celula do icone da arma (o mesmo desenho do Bag)",
		iconKey(0) === weaponIcon(DAGGER) && armed.length >= 3 && armed.every(cellOk),
		armed.map(k => iconKey(k)).join(", "),
	);
	const run = phase("600 quadros no toque, icones do atlas", () => {
		for (let i = 0; i < 600; i++) {
			setClock(5000 + i / 60);
			hud.update(frameState(i));
		}
	});
	check("600 quadros com o atlas nao criam nem destroem Instance", zero(run), cost(run));
	hud.unmount();
	setIconAtlas("");
	console.log(
		`  (a HUD no toque: ${flatAll + 1} Instances com os icones em Frames, ${flatAll - flatPx + images + 1} com o atlas)`,
	);
}

// ---------------------------------------------------------------- 7) the icon in its tile: centred, clear, crisp

console.log("\n7) o icone no ladrilho: no meio do que sobra, longe da tecla e da municao, nitido, do mesmo tamanho\n");
{
	// the owner's screenshot (1365 x 567, a 41 px tile): the dagger low and right, the axe's head and the pistol's grip
	// under the key badge, 1,56 px per icon pixel. Measured here on the PAINTED pixels (tools/ui-raster.mjs, the
	// engine's snapping: a rect covers the pixels whose centre it holds), with the Frames and with the atlas
	const FAKE_ATLAS = "rbxassetid://910000001";
	const ATLAS_PNG = decodePNG(readFileSync(join(ROOT, "design", "world-art", "itemIcons.png")));
	const resolve = id => (id === FAKE_ATLAS ? ATLAS_PNG : undefined);
	const snap = e => Math.ceil(e - 0.5);
	/** `g`'s rect in whole screen pixels, [x0, y0, x1, y1) */
	const pxBox = g => {
		const r = rectOf(g);
		return [snap(r.x), snap(r.y), snap(r.x + r.w), snap(r.y + r.h)];
	};
	/** the pixels tile `b`'s icon paints: their box and a lookup, in screen pixels */
	function drawnIcon(b) {
		const [x0, y0, x1, y1] = pxBox(b);
		const img = rasterPaint(
			paintList(deep(b, "ItemIcon")),
			{ x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
			undefined,
			resolve,
		);
		const box = [Infinity, Infinity, -Infinity, -Infinity];
		const on = new Set();
		for (let y = 0; y < img.h; y++) {
			for (let x = 0; x < img.w; x++) {
				if (img.data[(y * img.w + x) * 4 + 3] === 0) continue;
				on.add(`${x0 + x},${y0 + y}`);
				box[0] = Math.min(box[0], x0 + x);
				box[1] = Math.min(box[1], y0 + y);
				box[2] = Math.max(box[2], x0 + x + 1);
				box[3] = Math.max(box[3], y0 + y + 1);
			}
		}
		return { box, on };
	}
	/** what tile `b` leaves its icon: the face (inside the plate's relief), above the ammo chip on a gun's tile */
	function room(b, gun) {
		const v = pxBox(b.FindFirstChild("PlateFace"));
		const h = pxBox(b.FindFirstChild("PlateFaceH"));
		const face = [v[0], h[1], v[2], h[3]];
		return gun ? [face[0], face[1], face[2], pxBox(b.FindFirstChild("Ammo"))[1]] : face;
	}
	const inRect = (key, r) => {
		const [x, y] = key.split(",").map(Number);
		return x >= r[0] && x < r[2] && y >= r[1] && y < r[3];
	};
	const boxesMeet = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
	/** the sides the drawer draws evenly: whole screen px per icon pixel, or a regular 1,5 / 2,5 */
	const evenSide = s => s % 16 === 0 || s === 24 || s === 40;

	const own = ids => {
		for (let i = 0; i < WEAPONS.length; i++) save.invenWeapon[i] = ids.includes(i) ? 1 : 0;
	};
	const useDevice = touch => {
		uis.TouchEnabled = touch;
		uis.MouseEnabled = !touch;
		uis.GetLastInputType = () => (touch ? Enum.UserInputType.Touch : Enum.UserInputType.MouseMovement);
		uis.PreferredInput = undefined;
	};
	const weaponState = id =>
		state({
			weaponId: id,
			weaponName: WEAPONS[id].name,
			magSize: WEAPONS[id].mag,
			mag: WEAPONS[id].mag > 0 ? 7 : 0,
		});
	/** shows weapon `id` in hand (the dagger always owned is tile 1, any other weapon tile 2) and lays out */
	function show(id) {
		own(id === 0 ? [] : [id]);
		hud.update(weaponState(id));
		layoutGame(ui, ctx);
		hud.update(weaponState(id));
		return tile(id === 0 ? 0 : 1);
	}

	const SCREENS = [
		{ label: "1365x567 (a tela do dono)", w: 1365, h: 567, touch: false },
		{ label: "1120x630", w: 1120, h: 630, touch: false },
		{ label: "1366x768", w: 1366, h: 768, touch: false },
		{ label: "1920x1080", w: 1920, h: 1080, touch: false },
		{ label: "1360x435", w: 1360, h: 435, touch: false },
		{ label: "toque 1120x630", w: 1120, h: 630, touch: true },
		{ label: "toque 1360x435", w: 1360, h: 435, touch: true },
	];
	const HEADLINE = [DAGGER, AXE, PISTOL, 13];
	for (const screen of SCREENS) {
		for (const atlas of [false, true]) {
			hud.unmount();
			setIconAtlas(atlas ? FAKE_ATLAS : "");
			useDevice(screen.touch);
			setViewport(screen.w, screen.h, screen.touch ? TOP_BAR : 36);
			hud.mount();
			own([]);
			hud.update(weaponState(DAGGER));
			for (let i = 0; i < 3; i++) layoutGame(ui, ctx);
			const where = `${screen.label}, ${atlas ? "atlas" : "Frames"}`;
			const off = [];
			const covered = [];
			const outside = [];
			const sides = new Set();
			const crooked = [];
			const headline = [];
			let tilePx = 0;
			let badge = false;
			const run = measure(() => {
				for (let id = 0; id < WEAPONS.length; id++) {
					const b = show(id);
					const view = deep(b, "ItemIcon");
					const gun = WEAPONS[id].mag > 0;
					const name = `${WEAPONS[id].name} (${weaponIcon(id)})`;
					const { box, on } = drawnIcon(b);
					const r = room(b, gun);
					const dx = (box[0] + box[2]) / 2 - (r[0] + r[2]) / 2;
					const dy = (box[1] + box[3]) / 2 - (r[1] + r[3]) / 2;
					if (Math.abs(dx) > 1 || Math.abs(dy) > 1) off.push(`${name} ${dx},${dy}`);
					if (box[0] < r[0] || box[1] < r[1] || box[2] > r[2] || box[3] > r[3]) {
						outside.push(`${name} [${box}] em [${r}]`);
					}
					const key = b.FindFirstChild("Key");
					if (key.Visible) {
						badge = true;
						const k = pxBox(key);
						const hit = [...on].filter(p => inRect(p, k)).length;
						if (hit > 0) covered.push(`${name}: ${hit} px sob a tecla`);
					}
					sides.add(Math.round(rectOf(view).w));
					const img = view.GetChildren().find(c => c.ClassName === "ImageLabel" && c.Visible);
					const runs = view.GetChildren().filter(c => c.ClassName === "Frame" && c.Visible);
					const whole = u =>
						u.X.Scale === 0 &&
						u.Y.Scale === 0 &&
						Number.isInteger(u.X.Offset) &&
						Number.isInteger(u.Y.Offset);
					const snapped =
						whole(view.Position) &&
						whole(view.Size) &&
						(atlas
							? img !== undefined &&
								img.ResampleMode.Name === "Pixelated" &&
								whole(img.Position) &&
								whole(img.Size)
							: runs.length > 0 && runs.every(f => whole(f.Position) && whole(f.Size)));
					if (!snapped) crooked.push(name);
					if (HEADLINE.includes(id)) {
						const k = key.Visible ? pxBox(key) : undefined;
						headline.push(
							`${WEAPONS[id].name}: centro ${dx >= 0 ? "+" : ""}${dx},${dy >= 0 ? "+" : ""}${dy} px` +
								`${k !== undefined ? `, caixa ${boxesMeet(box, k) ? "toca a" : "longe da"} tecla` : ""}`,
						);
					}
					tilePx = rectOf(b).w;
				}
			});
			const [side] = [...sides];
			console.log(
				`  ${where}: ladrilho ${tilePx.toFixed(1)} px, icone ${[...sides].join("/")} px; ${headline.join("; ")}`,
			);
			check(
				`${where}: o que cada uma das ${WEAPONS.length} armas desenha fica no meio do que o ladrilho deixa (1 px)`,
				off.length === 0,
				off.slice(0, 4).join("; "),
			);
			check(
				`${where}: ...dentro da face, e a de fogo acima do chip da municao`,
				outside.length === 0,
				outside.slice(0, 3).join("; "),
			);
			check(
				`${where}: ${badge ? "nenhum pixel do icone fica sob a tecla" : "sem tecla no ladrilho (toque)"}`,
				covered.length === 0 && badge === !screen.touch,
				covered.slice(0, 4).join("; "),
			);
			check(
				`${where}: o mesmo tamanho para toda arma, nitido (${side} px = ${side / 16} px de tela por pixel do icone)`,
				[...sides].length === 1 && evenSide(side) && crooked.length === 0,
				crooked.slice(0, 3).join(", "),
			);
			check(`${where}: trocar ${WEAPONS.length} armas nao cria nem destroi Instance`, zero(run), cost(run));
		}
	}

	// a resize re-fits the icons in place: the size the tiles have, never an Instance
	hud.unmount();
	setIconAtlas("");
	useDevice(false);
	setViewport(1365, 567, 36);
	hud.mount();
	show(AXE);
	for (let i = 0; i < 3; i++) layoutGame(ui, ctx);
	const small = Math.round(rectOf(deep(tile(1), "ItemIcon")).w);
	const resized = measure(() => {
		setViewport(1920, 1080, 36);
		for (let i = 0; i < 3; i++) layoutGame(ui, ctx);
		hud.update(weaponState(AXE));
	});
	const big = Math.round(rectOf(deep(tile(1), "ItemIcon")).w);
	const { box, on } = drawnIcon(tile(1));
	const r = room(tile(1), false);
	const k = pxBox(tile(1).FindFirstChild("Key"));
	check(
		"mudar o tamanho da tela reajusta o icone no lugar: maior, no meio, longe da tecla, sem Instance",
		big > small &&
			Math.abs((box[0] + box[2]) / 2 - (r[0] + r[2]) / 2) <= 1 &&
			Math.abs((box[1] + box[3]) / 2 - (r[1] + r[3]) / 2) <= 1 &&
			![...on].some(p => inRect(p, k)) &&
			zero(resized),
		`${small} -> ${big} px, ${cost(resized)}`,
	);
	hud.unmount();
	setIconAtlas("");
	own([AXE, PISTOL]);
}

// ---------------------------------------------------------------- 8) what was picked up (ITM-07)

console.log("\n8) a coleta: '+12 Shotgun ammo' sobre a dica, o Bag pisca, nada criado (ITM-07)\n");
{
	const PK = require(join(SRC, "client/systems/pickups.ts"));
	const { CHIP_TIME, BAG_FLASH_TIME, TOAST_H, CHIP_H, CHIP_ROWS } = require(join(SRC, "client/ui/pickupToast.ts"));
	for (const [device, atlas] of [
		["desktop", ""],
		["toque", "rbxassetid://910000001"],
	]) {
		setIconAtlas(atlas);
		const touch = device === "toque";
		const uis2 = service("UserInputService");
		uis2.TouchEnabled = touch;
		uis2.MouseEnabled = !touch;
		uis2.GetLastInputType = () => (touch ? Enum.UserInputType.Touch : Enum.UserInputType.MouseMovement);
		uis2.PreferredInput = undefined;
		let t = 7000;
		setClock(t);
		/** `seconds` of frames at 60 Hz, the HUD updated on each (it takes at most a quarter second a frame) */
		const advance = seconds => {
			for (let i = 0; i < Math.round(seconds * 60); i++) {
				t += 1 / 60;
				setClock(t);
				hud.update(state());
			}
		};
		const drained = [];
		PK.takePickupNotes(drained);
		hud.mount();
		hud.update(state());
		const root = deep(hudRoot(), "PickupToast");
		const chip = i => deep(root, `Chip${i}`);
		const text = i => `${deep(chip(i), "Amount")?.Text ?? ""} ${deep(chip(i), "Name")?.Text ?? ""}`;
		const up = () => [0, 1, 2].filter(i => chip(i)?.Visible === true).length;
		const flashFrame = touch
			? deep(hudRoot(), "BagBtn")?.FindFirstChild("PickupFlash")
			: deep(consoleFrame(), "PickupFlash");
		const hint = deep(hudRoot(), "HintBox");
		check(
			`${device}: a coluna da coleta nasce com a HUD, vazia, no lugar da dica (o mesmo fundo), e a luz do Bag apagada`,
			root !== undefined &&
				up() === 0 &&
				root.AnchorPoint.X === 0.5 &&
				root.AnchorPoint.Y === 1 &&
				hint !== undefined &&
				root.Position.X.Scale === hint.Position.X.Scale &&
				root.Position.Y.Scale === hint.Position.Y.Scale &&
				root.Position.X.Offset === hint.Position.X.Offset &&
				root.Position.Y.Offset === hint.Position.Y.Offset &&
				flashFrame !== undefined &&
				flashFrame.BackgroundTransparency === 1,
		);
		// the rows sit over the prompt's own height: the lowest chip ends above the prompt
		const lowest = chip(0);
		const lowestBottom = (lowest.Position.Y.Scale + lowest.Size.Y.Scale) * TOAST_H;
		check(
			`${device}: o chip mais baixo acaba acima da dica (o prompt continua lido), ${CHIP_ROWS} linhas de ${CHIP_H}`,
			lowestBottom <= TOAST_H - 46 + 1e-6,
			`fim do chip ${lowestBottom.toFixed(1)} de ${TOAST_H}`,
		);
		PK.took(4, 45, 8);
		t += 1 / 60;
		setClock(t);
		hud.update(state());
		check(
			`${device}: uma coleta mostra "+8 Shotgun ammo" e acende o Bag`,
			up() === 1 && text(0) === "+8 Shotgun ammo" && flashFrame.BackgroundTransparency < 1,
			`${text(0)}; luz ${flashFrame.BackgroundTransparency}`,
		);
		PK.took(4, 45, 8);
		advance(0.5);
		check(
			`${device}: o mesmo item de novo soma no mesmo chip ("+16")`,
			up() === 1 && text(0) === "+16 Shotgun ammo",
			text(0),
		);
		PK.took(3, 12, 1);
		t += 1 / 60;
		setClock(t);
		hud.update(state());
		check(
			`${device}: outro item: um chip novo embaixo, o anterior sobe`,
			up() === 2 && text(0) === "+1 Bandage" && text(1) === "+16 Shotgun ammo",
			`${text(0)} | ${text(1)}`,
		);
		advance(BAG_FLASH_TIME + 0.05);
		check(`${device}: a luz do Bag apaga em ${BAG_FLASH_TIME} s`, flashFrame.BackgroundTransparency === 1);
		advance(CHIP_TIME + 0.1);
		check(`${device}: e os chips saem depois de ${CHIP_TIME} s`, up() === 0);
		// a run of pickups: every 20 frames something, from a list of six items; nothing is created
		const cycle = [
			[4, 44, 12],
			[4, 23, 3],
			[3, 17, 1],
			[1, 16, 1],
			[2, 13, 1],
			[4, 48, 10],
		];
		const run = phase(
			`600 quadros com coletas a cada 20 (${device}${atlas === "" ? ", Frames" : ", atlas"})`,
			() => {
				for (let i = 0; i < 600; i++) {
					if (i % 20 === 0) {
						const [k, id, n] = cycle[(i / 20) % cycle.length];
						PK.took(k, id, n);
					}
					t += 1 / 60;
					setClock(t);
					hud.update(frameState(i));
				}
			},
		);
		check(`${device}: 600 quadros de coletas nao criam nem destroem Instance`, zero(run), cost(run));
		hud.unmount();
	}
	setIconAtlas("");
	const uis3 = service("UserInputService");
	uis3.TouchEnabled = false;
	uis3.MouseEnabled = true;
	uis3.GetLastInputType = () => Enum.UserInputType.MouseMovement;
	uis3.PreferredInput = undefined;
}

// ---------------------------------------------------------------- 9) the save indicator (SAV-01)

console.log('\n9) o indicador de save (SAV-01): "Saving..." / "Saved" no canto, a falha dita, sem churn\n');
{
	const SI = require(join(SRC, "client/ui/saveIndicator.ts"));
	const { topBar } = require(join(SRC, "client/ui/skin.ts"));
	const gs = service("GuiService");
	const uiG = ctx.uiGui;
	setViewport(1365, 567, 58, 160);
	ctx.phase = "playing";
	const hud = new Hud(ctx);
	hud.mount();
	const ind = new SI.SaveIndicator(ctx.uiLayer, () => 0);
	const offBefore = uiG.Enabled === false;
	const built = phase("indicador: o primeiro aviso (constroi)", () => ind.show("saving"));
	layoutGame(ui, ctx);
	const root = ind.frame();
	const label = deep(root, "Text");
	const chip = deep(root, "Chip");
	const pixels = (deep(root, "Icon")?.GetChildren() ?? []).filter(f => f.ClassName === "Frame");
	check(
		"o primeiro aviso monta o chip (uma vez) e liga a ScreenGui dos menus; antes dele nada existia",
		built.created > 0 && offBefore && uiG.Enabled === true && ind.shown() === "saving",
		`${cost(built)}`,
	);
	// the words and the colours of each state, from lang.ts and the theme
	const looks = {};
	for (const state of ["saving", "saved", "failing", "stopped"]) {
		ind.show(state);
		layoutGame(ui, ctx);
		looks[state] = {
			text: label.Text,
			color: label.TextColor3,
			icon: pixels[0]?.BackgroundColor3,
			w: Math.round(rectOf(root).w),
		};
	}
	check(
		'os textos: "Saving...", "Saved", "Progress not saved — retrying", "Progress not saved"',
		looks.saving.text === "Saving..." &&
			looks.saved.text === "Saved" &&
			looks.failing.text === "Progress not saved — retrying" &&
			looks.stopped.text === "Progress not saved",
		Object.values(looks)
			.map(l => l.text)
			.join(" | "),
	);
	check(
		"as cores sao do tema: gravando em cinza mudo, gravado com o disquete verde, a falha em vermelho",
		sameColor(looks.saving.color, THEME.mutedForeground) &&
			sameColor(looks.saved.color, THEME.foreground) &&
			sameColor(looks.saved.icon, GAME.success) &&
			sameColor(looks.failing.color, THEME.destructive) &&
			sameColor(looks.failing.icon, THEME.destructive) &&
			chip !== undefined &&
			pixels.length > 0,
		`${pixels.length} Frames no disquete`,
	);
	check(
		"o aviso de falha cabe no chip largo: o chip cresce para ele e volta ao tamanho curto no Saved",
		looks.failing.w > looks.saved.w && looks.stopped.w === looks.failing.w,
		`${looks.saved.w} / ${looks.failing.w} px`,
	);

	// where: in the top bar, right of the Roblox buttons -- a strip the HUD never uses
	ind.show("saved");
	layoutGame(ui, ctx);
	const bar = topBar();
	const r = rectOf(root);
	check(
		"1365 x 567 (barra de 58 px, botoes nos 160 px): o chip fica NA barra, a direita dos botoes, nunca sob eles",
		r.x >= bar.freeMin && r.x + r.w <= bar.freeMax && r.y >= 0 && r.y + r.h <= bar.h,
		`x ${Math.round(r.x)}..${Math.round(r.x + r.w)}, y ${Math.round(r.y)}..${Math.round(r.y + r.h)}, barra ${bar.h} px, livre desde ${bar.freeMin}`,
	);
	const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
	/** a GuiObject that puts something on screen (the HUD's full-screen holders are transparent and draw nothing) */
	const draws = d =>
		(d.BackgroundTransparency ?? 1) < 1 ||
		(typeof d.Text === "string" && d.Text !== "" && d.TextTransparency < 1) ||
		(typeof d.Image === "string" && d.Image !== "" && (d.ImageTransparency ?? 0) < 1);
	const covered = hudRoot()
		.GetDescendants()
		.filter(d => d.IsA("GuiObject") && shown(d) && d.AbsoluteSize.X > 0 && draws(d) && overlaps(rectOf(d), r));
	check("...e nao cobre nada da HUD da partida", covered.length === 0, covered.map(d => d.Name).join(", ") || "nada");
	check(
		"nao bloqueia: nao recebe clique nem foco, e fica acima dos menus (e do flash) e abaixo dos toasts",
		root.Active === false &&
			root.GetDescendants().every(d => d.ClassName !== "TextButton" && d.ClassName !== "ImageButton") &&
			root.ZIndex > 350 &&
			root.ZIndex < 1000,
		`ZIndex ${root.ZIndex}`,
	);
	// no free stretch in the bar reported: just under it, at the left
	setViewport(1120, 630, 36);
	layoutGame(ui, ctx);
	const low = rectOf(root);
	check(
		"sem trecho livre na barra (TopbarInset sem folga): logo abaixo dela, a esquerda",
		low.y >= 36 && low.y < 36 + 20 && low.x < 20,
		`x ${Math.round(low.x)}, y ${Math.round(low.y)}`,
	);
	setViewport(1365, 567, 58, 160);

	// "Saved" holds, then fades; the failure stays until a write lands
	ind.show("saved");
	ind.step(SI.SAVED_HOLD_S - 0.1);
	const held = ind.shown() === "saved" && label.TextTransparency === 0;
	ind.step(0.1 + SI.FADE_S / 2);
	const fading = ind.shown() === "saved" && label.TextTransparency > 0 && label.TextTransparency < 1;
	ind.step(SI.FADE_S);
	flush();
	const gone = ind.shown() === undefined && root.Visible === false && uiG.Enabled === false;
	check(
		`"Saved" fica ${SI.SAVED_HOLD_S} s, some em ${SI.FADE_S} s, e a ScreenGui dos menus volta a desligar`,
		held && fading && gone,
		`parado ${held}, sumindo ${fading}, sumiu ${gone}`,
	);
	ind.show("failing");
	ind.step(600);
	const stays = ind.shown() === "failing" && label.TextTransparency === 0;
	ind.show("saving");
	ind.show("saved");
	check(
		'"Progress not saved — retrying" fica na tela (10 min) ate uma gravacao dar certo; ai vira "Saved"',
		stays && ind.shown() === "saved",
	);
	// Reduce Motion: no fade, the chip goes at once when its time is up
	gs.ReducedMotionEnabled = true;
	flush();
	ind.show("saved");
	ind.step(SI.SAVED_HOLD_S + 0.01);
	const instant = ind.shown() === undefined && label.TextTransparency === 0;
	gs.ReducedMotionEnabled = false;
	flush();
	check("com Reduzir Movimento nao ha esmaecimento: o chip some de uma vez", instant);

	// no churn: 400 notices and 3000 frames create nothing
	const states = ["saving", "saved", "saving", "failing", "saving", "saved", "stopped"];
	const churn = phase("indicador: 400 avisos e 3000 quadros", () => {
		for (let i = 0; i < 400; i++) {
			ind.show(states[i % states.length]);
			for (let f = 0; f < 7; f++) ind.step(1 / 60 + (f === 6 ? SI.SAVED_HOLD_S : 0));
		}
		for (let f = 0; f < 200; f++) ind.step(1 / 60);
	});
	check("400 avisos e 3000 quadros: nenhuma Instance criada nem destruida (UI-09)", zero(churn), cost(churn));
	ind.show("failing");
	const quiet = phase("indicador: 600 quadros parado", () => {
		for (let f = 0; f < 600; f++) ind.step(1 / 60);
	});
	check("parado (a falha na tela), 600 quadros nao escrevem nada", quiet.writes === 0 && zero(quiet), cost(quiet));
	// no contour on its text (UI-04)
	check(
		"sem contorno no texto (UI-04)",
		label.TextStrokeTransparency === 1 && label.GetChildren().every(c => c.ClassName !== "UIStroke"),
	);
	root.Destroy();
	hud.unmount();
	flush();
}

// ---------------------------------------------------------------- 10) quick HEAL / EAT (ITM-08)

console.log("\n10) uso rapido: HEAL e EAT no fim das barras de HP e FOOD, sem abrir o Bag (ITM-08)\n");
{
	const { USABLES } = require(join(SRC, "shared/data/usables.ts"));
	const QU = require(join(SRC, "client/systems/quickUse.ts"));
	const { QUICK_W } = require(join(SRC, "client/ui/hudConsole.ts"));
	const byName = n => USABLES.findIndex(u => u.name === n);
	const BANDAGE = byName("Bandage");
	const KIT = byName("First aid kit");
	const CAN = byName("Canned food");
	const APPLE = byName("Apple");
	const useIcon = id => iconOf(3, id).key;
	const gui = service("GuiService");
	const deskUse = () => {
		uis.TouchEnabled = false;
		uis.MouseEnabled = true;
		uis.GetLastInputType = () => Enum.UserInputType.MouseMovement;
		uis.PreferredInput = undefined;
	};
	const stock = (bandage, kit, can, apple) => {
		for (let i = 0; i < save.invenUse.length; i++) save.invenUse[i] = 0;
		save.invenUse[BANDAGE] = bandage;
		save.invenUse[KIT] = kit;
		save.invenUse[CAN] = can;
		save.invenUse[APPLE] = apple;
	};
	hud.unmount();
	setIconAtlas("");
	deskUse();
	setViewport(1365, 567, 36);
	hud.mount();
	stock(2, 1, 3, 2);
	const q = new QU.QuickUse();
	let now = 7000;
	const body = (hp, hungry) => ({ hp, hpMax: 100, hungry, hungryMax: 100, dead: hp <= 0 });
	/** a frame of the run: the HUD state with the runtime's two views (what main.client.ts pushes) */
	let last = [60, 58];
	const qframe = (hp, hunger, over = {}) => {
		last = [hp, hunger];
		setClock(now);
		hud.update(state({ hp, hunger, quick: q.frame(body(hp, hunger), save, now), ...over }));
	};
	qframe(60, 58);
	for (let i = 0; i < 3; i++) layoutGame(ui, ctx);
	qframe(60, 58);
	const plate = k => deep(consoleFrame(), k === 0 ? "QuickHeal" : "QuickEat");
	const groove = k => deep(consoleFrame(), k === 0 ? "QuickHealGroove" : "QuickEatGroove");
	const shown = k => deep(plate(k), "ItemIcon")?.GetAttribute("Icon");
	const dimmed = k => deep(plate(k), "ItemIcon")?.GetAttribute("Dim") === true;
	const countOf = k => deep(plate(k), "Count")?.Text;
	const legendOf = k => {
		const key = deep(plate(k), "Key");
		return key?.Visible === true ? key.FindFirstChild("Legend")?.Text : undefined;
	};
	const tipText = () => {
		const t = deep(consoleFrame(), "QuickTip");
		return t?.Visible === true ? deep(t, "Text")?.Text : undefined;
	};
	/** the pointer enters / leaves plate k (the engine's GuiState), and the next frame runs: the tooltip is update's */
	const hover = (k, on) => {
		plate(k).GuiState = on ? Enum.GuiState.Hover : Enum.GuiState.Idle;
		flush();
		qframe(...last);
	};

	// ---- where: at the end of the HP and FOOD bars, in their rows; XP keeps the full width; the console does not grow
	{
		const [hpBar, foodBar, xpBar] = ["Hp", "Food", "Xp"].map(n => rectOf(deep(consoleFrame(), `${n}Bar`)));
		const [heal, eat] = [0, 1].map(k => rectOf(groove(k)));
		const vitals = rectOf(deep(consoleFrame(), "Vitals"));
		const row = (p, bar) =>
			Math.abs(p.y - bar.y) <= 1 &&
			Math.abs(p.h - bar.h) <= 1 &&
			p.x >= bar.x + bar.w &&
			p.x - (bar.x + bar.w) <= 8;
		check(
			"HEAL fica no fim da barra de HP e EAT no da FOOD: a mesma fileira, a mesma altura, logo depois da barra",
			row(heal, hpBar) && row(eat, foodBar),
			`HP ${hpBar.x.toFixed(0)}+${hpBar.w.toFixed(0)} -> HEAL ${heal.x.toFixed(0)}; FOOD -> EAT ${eat.x.toFixed(0)}`,
		);
		check(
			"...separadas da barra (outra chapa, fora do sulco dela), e a XP embaixo segue na largura inteira, ate onde elas acabam",
			!deep(deep(consoleFrame(), "HpBar"), "QuickHeal") &&
				!deep(deep(consoleFrame(), "FoodBar"), "QuickEat") &&
				Math.abs(xpBar.x + xpBar.w - (heal.x + heal.w)) <= 1 &&
				heal.x + heal.w <= vitals.x + vitals.w,
			`XP ate ${(xpBar.x + xpBar.w).toFixed(0)}, HEAL ate ${(heal.x + heal.w).toFixed(0)} px`,
		);
		check(
			`o console nao cresceu por elas: ${DESKTOP_LAYOUT.w} x ${DESKTOP_LAYOUT.h} unidades (cada placa ${QUICK_W} x ${DESKTOP_LAYOUT.barH})`,
			DESKTOP_LAYOUT.w === 778 && DESKTOP_LAYOUT.h === 114,
		);
		check(
			"o texto das barras encurtadas continua o mesmo",
			barLabel("Hp")?.Text === "HP 60 / 100" && barLabel("Food")?.Text === "FOOD 58 / 100",
			`${barLabel("Hp")?.Text} / ${barLabel("Food")?.Text}`,
		);
		// the icon on whole screen pixels, at a side itemIcon.ts draws evenly (16 / 32 / 48, or 24 / 40), on the owner's
		// screen and at 1080p -- and the resize re-fits it in place
		const crisp = () => {
			const f = deep(plate(0), "ItemIcon");
			const whole = u =>
				u.X.Scale === 0 && u.Y.Scale === 0 && Number.isInteger(u.X.Offset) && Number.isInteger(u.Y.Offset);
			return whole(f.Position) && whole(f.Size) && [16, 24, 32, 40, 48, 64].includes(f.Size.X.Offset)
				? f.Size.X.Offset
				: -1;
		};
		const small = crisp();
		const resized = phase("placas rapidas: 1365x567 -> 1920x1080", () => {
			setViewport(1920, 1080, 36);
			for (let i = 0; i < 3; i++) layoutGame(ui, ctx);
			qframe(60, 58);
		});
		const big = crisp();
		check(
			"o icone da placa em pixels inteiros, num lado nitido, e maior a 1080p sem criar Instance",
			small > 0 && big > small && zero(resized),
			`${small} px a 1365x567, ${big} px a 1920x1080`,
		);
		setViewport(1365, 567, 36);
		for (let i = 0; i < 3; i++) layoutGame(ui, ctx);
	}

	// ---- what: the item a press uses (the shared pick), the count of the kind, raised iron when usable
	check(
		"HP 60 (faltam 40): HEAL mostra o First aid kit, a menor que cobre sem sobra alem dela (a Bandage, 20, nao cobre)",
		shown(0) === useIcon(KIT) && !dimmed(0) && countOf(0) === "×3",
		`${shown(0)}, ${countOf(0)}`,
	);
	check(
		"FOOD 58 (faltam 42): nenhuma cobre, EAT mostra a maior (Canned food, 25); contagem 5",
		shown(1) === useIcon(CAN) && countOf(1) === "×5",
		`${shown(1)}, ${countOf(1)}`,
	);
	qframe(85, 80);
	check(
		"HP 85 e FOOD 80: a Bandage (20 cobre 15) e a Apple (20 cobre 20 exatos, antes do Canned food 25)",
		shown(0) === useIcon(BANDAGE) && shown(1) === useIcon(APPLE),
		`${shown(0)}, ${shown(1)}`,
	);
	check(
		"usavel = ferro em relevo (UI-07: aperta-se), contagem clara",
		[0, 1].every(k => sameColor(face(plate(k)), THEME.secondary) && raised(plate(k))) &&
			sameColor(deep(plate(0), "Count").TextColor3, THEME.secondaryForeground),
	);

	// ---- disabled: none / full, the socket look, the icon grey, the count muted -- and the reason under the mouse
	hover(0, true);
	check(
		'passar o mouse numa placa usavel diz o que ela faz: "Bandage: +15 HP"',
		tipText() === "Bandage: +15 HP",
		tipText(),
	);
	hover(0, false);
	check("o mouse fora: a dica some", tipText() === undefined);
	stock(0, 0, 3, 2);
	qframe(85, 80);
	hover(0, true);
	check(
		'sem cura nenhuma: HEAL apagada (o soquete escuro contornado, o icone cinza, "×0" mudo), e o motivo sob o mouse',
		ringed(plate(0)) &&
			sameColor(face(plate(0)), SURFACE.well) &&
			dimmed(0) &&
			shown(0) === useIcon(BANDAGE) &&
			countOf(0) === "×0" &&
			sameColor(deep(plate(0), "Count").TextColor3, THEME.mutedForeground) &&
			tipText() === "No healing items",
		`${tipText()}`,
	);
	hover(0, false);
	stock(2, 1, 3, 2);
	qframe(100, 100);
	hover(0, true);
	const fullHeal = tipText();
	hover(0, false);
	hover(1, true);
	const fullEat = tipText();
	hover(1, false);
	check(
		"barra cheia: as duas apagadas, e o motivo de cada uma (Already at full health / You're already full)",
		ringed(plate(0)) &&
			ringed(plate(1)) &&
			dimmed(0) &&
			dimmed(1) &&
			fullHeal === "Already at full health" &&
			fullEat === "You're already full",
		`${fullHeal} / ${fullEat}`,
	);
	stock(2, 1, 0, 0);
	qframe(85, 40);
	hover(1, true);
	check('sem comida: EAT apagada, "No food"', ringed(plate(1)) && tipText() === "No food", tipText());
	hover(1, false);
	stock(2, 1, 3, 2);

	// ---- the keys: H / F on the keyboard (SCHEMES), the D-pad's arrows on a pad
	qframe(85, 80);
	check("com teclado: as teclas H e F nas placas (tutorial.ts SCHEMES)", legendOf(0) === "H" && legendOf(1) === "F");
	uis.GetLastInputType = () => Enum.UserInputType.Gamepad1;
	uis.PreferredInput = Enum.PreferredInput.Gamepad;
	const toPad = phase("placas rapidas: o jogador pega o controle", () => qframe(85, 80));
	const arrow = (k, n) => deep(deep(plate(k), "Key"), n)?.Visible === true;
	check(
		"com o controle: a seta do D-pad (para cima em HEAL, para baixo em EAT), sem letra, sem criar Instance",
		deep(plate(0), "Key").Visible &&
			arrow(0, "Up") &&
			!arrow(0, "Down") &&
			arrow(1, "Down") &&
			!arrow(1, "Up") &&
			deep(deep(plate(0), "Key"), "Legend").Text === "" &&
			zero(toPad),
		cost(toPad),
	);
	deskUse();
	qframe(85, 80);

	// ---- a click is the key: the same field (InputState.quickUsePressed) as H / F and the D-pad's up / down
	{
		const got = [];
		for (const [inputObj, what] of [
			[{ UserInputType: Enum.UserInputType.Keyboard, KeyCode: Enum.KeyCode.H }, "H"],
			[{ UserInputType: Enum.UserInputType.Keyboard, KeyCode: Enum.KeyCode.F }, "F"],
			[{ UserInputType: Enum.UserInputType.Gamepad1, KeyCode: Enum.KeyCode.DPadUp }, "D-pad up"],
			[{ UserInputType: Enum.UserInputType.Gamepad1, KeyCode: Enum.KeyCode.DPadDown }, "D-pad down"],
		]) {
			input.beginFrame();
			uis.InputBegan.Fire(inputObj, false);
			got.push(`${what}=${input.quickUsePressed}`);
		}
		const clicks = [];
		for (const k of [0, 1]) {
			input.beginFrame();
			plate(k).Activated.Fire();
			flush();
			clicks.push(input.quickUsePressed);
		}
		input.beginFrame();
		check(
			"H e o D-pad para cima escrevem 0 (HEAL), F e para baixo 1 (EAT); clicar na placa escreve o mesmo campo",
			got.join(",") === "H=0,F=1,D-pad up=0,D-pad down=1" && clicks.join(",") === "0,1",
			`${got.join(", ")}; cliques ${clicks.join(",")}`,
		);
		input.beginFrame();
		uis.InputBegan.Fire({ UserInputType: Enum.UserInputType.Keyboard, KeyCode: Enum.KeyCode.H }, true);
		const typing = input.quickUsePressed;
		input.setHeld(true);
		uis.InputBegan.Fire({ UserInputType: Enum.UserInputType.Keyboard, KeyCode: Enum.KeyCode.F }, false);
		input.setHeld(true);
		const held = input.quickUsePressed;
		input.setHeld(false);
		input.beginFrame();
		check(
			"H digitado no chat nao cura, e com uma tela aberta (UI-06: o sobrevivente parado) a tecla e largada",
			typing === -1 && held === -1,
			`chat ${typing}, tela ${held}`,
		);
	}

	// ---- the cooldown sweep, the pulse, Reduce Motion
	{
		const veil = k => deep(plate(k), "Cooldown");
		const iconY = k => deep(plate(k), "ItemIcon").Position.Y.Offset;
		/** the plate's light band at the "hot" wash (plate.ts: foreground at 50%; at rest 30%) */
		const hotBand = k => raised(plate(k)) && Math.abs(band(plate(k)).BackgroundTransparency - 0.5) < 1e-6;
		const sent = [];
		const press = (k, hp, hunger) => q.press(k, body(hp, hunger), save, now, id => (sent.push(id), true));
		const r = press(0, 70, 80);
		qframe(70, 80);
		const at0 = veil(0).Visible ? veil(0).Size.Y.Scale : 0;
		const eatVeil = veil(1).Visible;
		const litIcon = iconY(0);
		const lit = hotBand(0);
		check(
			"um uso (HP 70, faltam 30): o verbo do Bag recebe o First aid kit -- a menor que cobre 30 -- e o ganho e +30 HP",
			r.used && sent[0] === KIT && r.hpGain === 30,
			`usou ${USABLES[sent[0]]?.name}, +${r.hpGain} HP`,
		);
		check(
			"e o tempo de uso (0,25 s, o mesmo do servidor) cobre AS DUAS placas com o veu, cheio no comeco",
			at0 > 0.95 && eatVeil,
			`veu ${at0.toFixed(2)}`,
		);
		now += 0.125;
		qframe(70, 80);
		const half = veil(0).Size.Y.Scale;
		now += 0.2;
		qframe(70, 80);
		check(
			"o veu escorre com o tempo e some quando pronto",
			Math.abs(half - 0.5) < 0.05 && !veil(0).Visible && !veil(1).Visible,
			`${half.toFixed(2)} na metade`,
		);
		const early = press(0, 70, 80);
		check(
			"a leitura da barra espera o snapshot: logo depois do kit (HP ainda 70 no cliente) o HEAL diz cheio, nao gasta outra",
			!early.used && early.why === "full" && sent.length === 1,
			`${early.why}`,
		);
		now += 2;
		qframe(70, 80);
		const idleIcon = iconY(0);
		check(
			"o pulso: a placa acende e o icone sobe logo depois do uso, e os dois voltam",
			lit && litIcon < idleIcon && !hotBand(0),
			`icone em y ${litIcon} -> ${idleIcon}`,
		);
		gui.ReducedMotionEnabled = true;
		flush();
		press(1, 70, 60);
		qframe(70, 60);
		const stillVeil = veil(1).Size.Y.Scale;
		const stillIcon = iconY(1);
		const stillLit = hotBand(1);
		now += 0.125;
		qframe(70, 60);
		const stillVeil2 = veil(1).Size.Y.Scale;
		gui.ReducedMotionEnabled = false;
		flush();
		now += 2;
		qframe(70, 60);
		check(
			"com Reduzir Movimento: o veu fica inteiro enquanto espera (nao escorre) e o icone nao pula -- so a luz",
			stillVeil === 1 && stillVeil2 === 1 && stillIcon === iconY(1) && stillLit,
			`veu ${stillVeil} / ${stillVeil2}, icone ${stillIcon} / ${iconY(1)}`,
		);
	}

	// ---- no churn: 600 frames of everything changing, and an idle frame writes nothing
	{
		const run = phase("600 quadros com as placas rapidas mudando (pick, contagem, veu, pulso, estados)", () => {
			for (let i = 0; i < 600; i++) {
				now += 1 / 60;
				if (i % 40 === 0) stock(i % 120 === 0 ? 0 : 2, 1, i % 200 === 0 ? 0 : 3, 2);
				const hp = 100 * Math.abs(Math.cos(i / 50));
				const hunger = 100 * Math.abs(Math.sin(i / 70));
				if (i % 25 === 0) q.press(i % 50 === 0 ? 0 : 1, body(hp, hunger), save, now, () => true);
				if (i % 90 === 0) hover(i % 180 === 0 ? 0 : 1, true);
				if (i % 90 === 45) hover(i % 180 === 45 ? 0 : 1, false);
				qframe(hp, hunger);
			}
		});
		check("600 quadros com HEAL / EAT mudando nao criam nem destroem Instance", zero(run), cost(run));
		hover(0, false);
		hover(1, false);
		stock(2, 1, 3, 2);
		now += 5;
		qframe(80, 70);
		const idle = phase("60 quadros identicos com as placas rapidas", () => {
			for (let i = 0; i < 60; i++) {
				now += 1 / 60;
				qframe(80, 70);
			}
		});
		check("quadros iguais: as placas nao escrevem nada", idle.writes === 0 && zero(idle), cost(idle));
	}

	// ---- beside VIT-01's cue and ITM-07's chips: the glow round the HP bar and the fork at the FOOD bar's end read the
	// bars' shortened width (hudConsole.ts hands RegenCue what makeBar drew), and the pickup chips ride over the prompt
	{
		const VIT = require(join(SRC, "shared/sim/vitals.ts"));
		const PK = require(join(SRC, "client/systems/pickups.ts"));
		const { CHIP_TIME } = require(join(SRC, "client/ui/pickupToast.ts"));
		const apart = (a, b) => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
		const px = r => `${Math.round(r.x)}..${Math.round(r.x + r.w)} x ${Math.round(r.y)}..${Math.round(r.y + r.h)}`;
		const rested = { sinceHurt: VIT.REGEN_RESTED_S };
		const hungry = VIT.REGEN_FOOD_MIN - 1;
		const chips = () =>
			[0, 1, 2]
				.map(i => deep(deep(hudRoot(), "PickupToast"), `Chip${i}`))
				.filter(c => c?.Visible === true)
				.map(rectOf);
		/** three chips up (the column at its tallest), the longest name the data has */
		const pickups = () => {
			PK.took(4, 45, 12);
			PK.took(3, 12, 1);
			PK.took(1, 16, 1);
			qframe(...last, rested);
			layoutGame(ui, ctx);
		};
		/** the chips run out (nothing left fading into the next checks) */
		const clear = () => {
			for (let i = 0; i < Math.ceil((CHIP_TIME + 0.2) * 60); i++) {
				now += 1 / 60;
				qframe(...last);
			}
		};
		for (const [w, h] of [
			[1365, 567],
			[1920, 1080],
			[1120, 630],
		]) {
			setViewport(w, h, 36);
			for (let i = 0; i < 3; i++) layoutGame(ui, ctx);
			qframe(60, 80, rested);
			layoutGame(ui, ctx);
			const glow = deep(consoleFrame(), "HpGlow");
			const g = rectOf(glow);
			const heal = rectOf(groove(0));
			const hpBar = rectOf(deep(consoleFrame(), "HpBar"));
			check(
				`${w}x${h}: curando, o brilho abraca a barra de HP encurtada e acaba antes da HEAL`,
				glow.Visible && apart(g, heal) && g.x + g.w > hpBar.x + hpBar.w && g.x + g.w < heal.x,
				`brilho ${px(g)}, HEAL ${px(heal)}`,
			);
			// the fork on its first frame: the pop, at its biggest (the clock stands still, so it stays there)
			qframe(60, hungry, rested);
			layoutGame(ui, ctx);
			const fork = deep(deep(consoleFrame(), "FoodBar"), "EatHint");
			const f = rectOf(fork);
			const eat = rectOf(groove(1));
			const foodBar = rectOf(deep(consoleFrame(), "FoodBar"));
			check(
				`${w}x${h}: sem comida, o garfo na ponta da FOOD encurtada (no pulo, o maior), antes da EAT`,
				fork.Visible && apart(f, eat) && f.x + f.w < eat.x && f.x + f.w > foodBar.x + foodBar.w * 0.8,
				`garfo ${px(f)}, FOOD ate ${Math.round(foodBar.x + foodBar.w)}, EAT ${px(eat)}`,
			);
			// the number: its label is TextScaled (skin.ts scaleText), so the text never leaves the label's frame -- and
			// on the shortened bars that frame stops where the fork's pop begins (hudRegen.ts forkRoom); HP's the same
			const foodLabel = barLabel("Food");
			const lf = rectOf(foodLabel);
			const lh = rectOf(barLabel("Hp"));
			check(
				`${w}x${h}: "FOOD ${hungry} / 100" fica antes do garfo, mesmo no pulo; o numero do HP logo acima do da FOOD`,
				foodLabel.TextScaled === true &&
					apart(f, lf) &&
					Math.abs(lh.x + lh.w / 2 - (lf.x + lf.w / 2)) <= 0.5 &&
					foodLabel.Text === `FOOD ${hungry} / 100`,
				`rotulo ${px(lf)}, garfo ${px(f)}`,
			);
			pickups();
			const up = chips();
			check(
				`${w}x${h}: tres coletas na tela: os chips sobre a dica, longe das placas HEAL e EAT`,
				up.length === 3 && up.every(c => apart(c, heal) && apart(c, eat) && apart(c, g)),
				up.map(px).join(" / "),
			);
			clear();
		}
		// touch: the quick deck sits over the console's left end, the prompt goes over it where they meet, and the chips
		// with the prompt -- the real frames at 1120 x 630 and on a crowded phone (the column's box, in checkQuickDeck)
		hud.unmount();
		uis.TouchEnabled = true;
		uis.MouseEnabled = false;
		uis.GetLastInputType = () => Enum.UserInputType.Touch;
		for (const [w, h, bar] of [
			[1120, 630, 58],
			[844, 390, 36],
		]) {
			setViewport(w, h, bar);
			hud.mount();
			boot.refreshTouchLayout();
			for (let i = 0; i < 3; i++) layoutGame(ui, ctx);
			qframe(60, hungry, rested);
			pickups();
			const deckR = rectOf(deep(hudRoot(), "QuickDeck"));
			const up = chips();
			const hintR = rectOf(deep(hudRoot(), "HintBox"));
			check(
				`toque ${w}x${h}: tres coletas: nenhum chip sobre os ladrilhos HEAL / EAT`,
				up.length === 3 && up.every(c => apart(c, deckR)) && up.every(c => c.y + c.h <= hintR.y + hintR.h),
				`placa ${px(deckR)}; ${up.map(px).join(" / ")}`,
			);
			clear();
			hud.unmount();
		}
		deskUse();
		setViewport(1365, 567, 36);
		hud.mount();
		for (let i = 0; i < 3; i++) layoutGame(ui, ctx);
		qframe(80, 70);
	}
	hud.unmount();
	setIconAtlas("");
}

// ---------------------------------------------------------------- 11) the dawn card and the level-up (BEM-04, BEM-08)

console.log("\n11) o cartao do amanhecer (BEM-04) e o level-up que diz o que deu (BEM-08)\n");
{
	const NR = require(join(SRC, "client/systems/nightReport.ts"));
	const DCard = require(join(SRC, "client/ui/dawnCard.ts"));
	const W = require(join(SRC, "shared/data/wellbeing.ts"));
	const NIGHT = Clock.NIGHT_REAL_SECONDS;

	// (a) the tally: what a night was, and which nights earn a card
	/** a night of `NIGHT` real seconds, frame by frame: `from` (share of the night) the survivor stands, `dies` kills them */
	const night = ({ from = 0, dies, rises, hits = [], heals = [], kills = 0, pickups = 0 } = {}) => {
		const t = new NR.NightTally();
		let hp = 100;
		let k = 0;
		let pk = 0;
		let report;
		let reports = 0;
		const frames = Math.round(NIGHT);
		for (let s = 0; s <= frames + 2; s++) {
			const f = s / frames;
			const nightNow = s <= frames;
			let alive = f >= from;
			if (dies !== undefined && f >= dies && (rises === undefined || f < rises)) alive = false;
			if (hits.includes(s)) hp -= 10;
			if (heals.includes(s)) hp += 5;
			if (s === Math.round(frames / 2)) {
				k += kills;
				pk += pickups;
			}
			const r = t.step({ night: nightNow, alive, hp, kills: k, pickups: pk, now: s });
			if (r !== undefined) {
				report = r;
				reports++;
			}
		}
		return { report, reports };
	};
	const full = night({ hits: [30, 60, 90], heals: [70], kills: 12, pickups: 7 });
	check(
		"uma noite inteira de pe: o cartao sai UMA vez, na primeira luz, com zumbis 12, dano 30 (a cura nao desconta) e itens 7",
		full.reports === 1 && full.report?.zombies === 12 && full.report?.damage === 30 && full.report?.items === 7,
		JSON.stringify(full),
	);
	const died = night({ dies: 0.7 });
	const risen = night({ dies: 0.3, rises: 0.8 });
	const late = night({ from: 0.4 });
	const tooLate = night({ from: 0.6 });
	check(
		`morreu na noite: nenhum cartao; levantou com 20% da noite: nenhum; entrou com 60% dela: cartao; com 40%: nenhum (${W.MIN_NIGHT_SHARE * 100}%)`,
		died.reports === 0 && risen.reports === 0 && late.reports === 1 && tooLate.reports === 0,
		JSON.stringify([died.reports, risen.reports, late.reports, tooLate.reports]),
	);
	check(
		`a linha da pausa e a regra do SERVIDOR (breakNudgeEarned): sessao de ${W.BREAK_NUDGE_MIN} min, a noite vivida de pe, uma vez por sessao`,
		!W.breakNudgeEarned(W.BREAK_NUDGE_MIN * 60 - 1, true, false) &&
			W.breakNudgeEarned(W.BREAK_NUDGE_MIN * 60, true, false) &&
			!W.breakNudgeEarned(W.BREAK_NUDGE_MIN * 60 * 3, false, false) &&
			!W.breakNudgeEarned(W.BREAK_NUDGE_MIN * 60 * 3, true, true) &&
			NR.breakNudgeDue === undefined,
	);

	// (b) the card on the HUD
	setViewport(1365, 567, 58, 160);
	uis.TouchEnabled = false;
	uis.MouseEnabled = true;
	uis.GetLastInputType = () => Enum.UserInputType.MouseMovement;
	uis.PreferredInput = undefined;
	ctx.phase = "playing";
	const hud = new Hud(ctx);
	hud.mount();
	hud.update(state());
	const box = () => deep(hudRoot(), "DawnBox");
	const card = () => deep(box(), "DawnCard");
	const txt = name => deep(card(), name)?.Text;
	const up = () => card()?.Visible === true;
	check(
		"antes do primeiro amanhecer o cartao nem existe: montar a HUD nao paga nada por ele (so a caixa ancorada)",
		box() !== undefined &&
			card() === undefined &&
			box()
				.GetChildren()
				.filter(c => c.IsA("GuiObject")).length === 0,
	);
	hud.dawnStoreNotice("saved");
	hud.showMessage("Good morning");
	const bannerLabel = deep(hudRoot(), "Banner");
	const bannerBefore = bannerLabel.Text;
	const first = phase("cartao do amanhecer: o primeiro (constroi)", () =>
		hud.showDawnReport({ zombies: 12, damage: 85, items: 7 }),
	);
	layoutGame(ui, ctx);
	check(
		'"Night survived" e a noite em numeros: 12 zombies, 85 damage taken, 7 items found (no amarelo dos numeros)',
		up() &&
			txt("Title") === "Night survived" &&
			txt("Value1") === "12" &&
			txt("Key1") === "zombies" &&
			txt("Value2") === "85" &&
			txt("Key2") === "damage taken" &&
			txt("Value3") === "7" &&
			txt("Key3") === "items found" &&
			[1, 2, 3].every(i => sameColor(deep(card(), `Value${i}`).TextColor3, STAT.value)) &&
			first.created > 0,
		[1, 2, 3].map(i => `${txt(`Value${i}`)} ${txt(`Key${i}`)}`).join(" | "),
	);
	check(
		'o "Good morning" da caixa sai na hora: o cartao E o banner da manha',
		bannerBefore === "Good morning" && bannerLabel.TextTransparency === 1,
	);
	hud.showMessage("Good morning");
	check("...e um Good morning com o cartao de pe nao e desenhado por cima", bannerLabel.TextTransparency === 1);
	check(
		'nada salvo e dito antes de o servidor falar DEPOIS de o cartao abrir: sem linha (o "saved" de antes nao conta)',
		deep(card(), "Store").Visible === false && deep(card(), "Disk").Visible === false,
	);
	hud.dawnStoreNotice("saving");
	const saving = [txt("Store"), deep(card(), "Store").Visible, deep(card(), "Store").TextColor3];
	// an older write's "saved" (in flight when the dawn came: no `answersDawn`) is not this night's answer
	hud.dawnStoreNotice("saved", false);
	const older = txt("Store");
	hud.dawnStoreNotice("saved", true);
	const diskPx = deep(card(), "Disk")
		.GetChildren()
		.filter(f => f.ClassName === "Frame");
	check(
		'a "saved" sem answersDawn (uma gravacao de antes da pergunta do amanhecer) nao vira "Progress saved": o cartao segue em "Saving..."',
		older === "Saving...",
		older,
	);
	check(
		'"Saving..." em cinza enquanto a gravacao voa; "Progress saved" com o disquete verde quando o servidor RESPONDE a pergunta do amanhecer',
		saving[0] === "Saving..." &&
			saving[1] === true &&
			sameColor(saving[2], THEME.mutedForeground) &&
			txt("Store") === "Progress saved" &&
			sameColor(deep(card(), "Store").TextColor3, THEME.foreground) &&
			diskPx.length > 0 &&
			sameColor(diskPx[0].BackgroundColor3, GAME.success),
		`${saving[0]} -> ${txt("Store")}`,
	);
	hud.dawnStoreNotice("failing");
	check(
		'uma gravacao que falhou e dita em vermelho: "Progress not saved — retrying"',
		txt("Store") === "Progress not saved — retrying" && sameColor(deep(card(), "Store").TextColor3, STAT.penalty),
	);
	// L2 of the review of 440af66: a card that opens during an outage the corner indicator already shows starts from it;
	// an older write that lands ends the outage ("Saving...": the dawn's own write is still to come); only the answer
	// says "Progress saved"
	{
		hud.dawnCard().hide();
		hud.showDawnReport({ zombies: 2, damage: 5, items: 1 });
		const opened = [deep(card(), "Store").Visible, txt("Store")];
		hud.dawnStoreNotice("saved", false);
		const outageOver = txt("Store");
		hud.dawnStoreNotice("saved", true);
		const answered = txt("Store");
		hud.dawnCard().hide();
		hud.showDawnReport({ zombies: 2, damage: 5, items: 1 });
		const clean = deep(card(), "Store").Visible === false;
		hud.dawnStoreNotice("saved", false);
		const stillQuiet = deep(card(), "Store").Visible === false;
		check(
			'aberto numa queda ja conhecida: comeca em "Progress not saved — retrying"; a gravacao velha que chega o leva a "Saving...", a resposta a "Progress saved"; sem queda, um "saved" velho nao diz nada',
			opened[0] === true &&
				opened[1] === "Progress not saved — retrying" &&
				outageOver === "Saving..." &&
				answered === "Progress saved" &&
				clean &&
				stillQuiet,
			JSON.stringify({ opened, outageOver, answered, clean, stillQuiet }),
		);
		// the card up again for what follows (the last push was a "saved": no outage carries over)
		hud.showDawnReport({ zombies: 12, damage: 85, items: 7 });
	}
	// where: the banner's own box at the top centre, never over the console
	const cr = rectOf(card());
	const [bannerW, feedW] = hud.messageWidths();
	const [reach] = messageReach(1365, 567, 58, bannerW, feedW, 0.8 + 0.4 * save.settings.uiSize);
	const inside =
		cr.x >= reach[0] - 0.5 &&
		cr.x + cr.w <= reach[2] + 0.5 &&
		cr.y >= reach[1] - 0.5 &&
		cr.y + cr.h <= reach[3] + 0.5;
	const con = rectOf(consoleFrame());
	const overlapR = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
	check(
		"no lugar do banner (topo central, a caixa das mensagens), longe do console e do sobrevivente no meio da tela",
		inside && !overlapR(cr, con) && cr.y + cr.h < 567 / 2,
		`cartao ${Math.round(cr.x)},${Math.round(cr.y)} ${Math.round(cr.w)}x${Math.round(cr.h)}`,
	);
	// the pad is never taken, and nothing asks for B
	const selectable = box()
		.GetDescendants()
		.filter(d => d.IsA("GuiObject") && d.Selectable === true);
	check(
		"nada no cartao e Selectable: o controle continua do sobrevivente (UI-09), o cartao nunca toma o foco",
		selectable.length === 0,
		selectable.map(d => d.Name).join(", "),
	);
	// it goes by itself; the server's word on the dawn's save is waited for; "Progress saved" stays a moment
	const t0 = getClock();
	const at = s => {
		setClock(t0 + s);
		hud.update(state());
	};
	hud.showDawnReport({ zombies: 1, damage: 0, items: 1 });
	check(
		'no singular: "1 zombie", "1 item found"',
		txt("Key1") === "zombie" && txt("Key3") === "item found" && txt("Value2") === "0",
	);
	at(1);
	hud.dawnStoreNotice("saved", true);
	at(DCard.DAWN_SHOW_S - 0.1);
	const stillUp = up();
	at(DCard.DAWN_SHOW_S + 0.1);
	check(
		`com a palavra do servidor dada ("saved" em 1 s), some sozinho em ${DCard.DAWN_SHOW_S} s (nunca espera o jogador)`,
		stillUp && !up(),
	);
	// L2 of the review of ca9494a: the dawn's write comes after SAV-01's delay and gap (up to ~18 s), and an unchanged
	// save is answered "saved" without a write (server/main.server.ts `dawnAsks`): the card waits for that word
	{
		const tw = getClock();
		hud.showDawnReport({ zombies: 3, damage: 10, items: 0 });
		setClock(tw + DCard.DAWN_SHOW_S + 4);
		hud.update(state());
		const waiting = up() && deep(card(), "Store").Visible === false;
		setClock(tw + 18);
		hud.dawnStoreNotice("saved", true);
		hud.update(state());
		const late = up() && txt("Store") === "Progress saved";
		setClock(tw + 18 + DCard.DAWN_SAVED_HOLD_S - 0.1);
		hud.update(state());
		const held = up();
		setClock(tw + 18 + DCard.DAWN_SAVED_HOLD_S + 0.1);
		hud.update(state());
		check(
			`sem palavra ainda, o cartao espera (e nao diz nada); um "saved" que chega em 18 s ainda aparece nele, ${DCard.DAWN_SAVED_HOLD_S} s, e ele vai`,
			waiting && late && held && !up(),
			JSON.stringify({ waiting, late, held }),
		);
		const tn = getClock();
		hud.showDawnReport({ zombies: 3, damage: 10, items: 0 });
		setClock(tn + DCard.DAWN_MAX_S - 0.1);
		hud.update(state());
		const before = up() && deep(card(), "Store").Visible === false;
		setClock(tn + DCard.DAWN_MAX_S + 0.1);
		hud.update(state());
		check(
			`...e se a palavra nunca vem (Studio sem DataStore), vai em ${DCard.DAWN_MAX_S} s sem ter dito nada`,
			before && !up(),
		);
	}
	hud.showDawnReport({ zombies: 3, damage: 10, items: 0 });
	const t1 = getClock();
	setClock(t1 + DCard.DAWN_SHOW_S - 1);
	hud.dawnStoreNotice("saving");
	setClock(t1 + DCard.DAWN_SHOW_S + 2);
	hud.update(state());
	const waited = up();
	setClock(t1 + DCard.DAWN_SHOW_S + 3);
	hud.dawnStoreNotice("saved", true);
	setClock(t1 + DCard.DAWN_SHOW_S + 3 + DCard.DAWN_SAVED_HOLD_S - 0.1);
	hud.update(state());
	const held = up() && txt("Store") === "Progress saved";
	setClock(t1 + DCard.DAWN_SHOW_S + 3 + DCard.DAWN_SAVED_HOLD_S + 0.1);
	hud.update(state());
	check(
		`uma gravacao em voo e esperada (ate ${DCard.DAWN_MAX_S} s); "Progress saved" fica ${DCard.DAWN_SAVED_HOLD_S} s e o cartao vai`,
		waited && held && !up(),
	);
	hud.showDawnReport({ zombies: 3, damage: 10, items: 0 });
	setClock(getClock() + 1);
	hud.dawnStoreNotice("saving");
	setClock(getClock() + DCard.DAWN_MAX_S + 1);
	hud.update(state());
	check(`...mas nunca mais que ${DCard.DAWN_MAX_S} s, com ou sem resposta`, !up());

	// M1 of the review of ca9494a: the card takes no click nor touch -- only its ╳ does (a thumb's size), the rest of it is
	// the playfield's. The engine's gameProcessedEvent is true where an input lands on something that sinks it (a button
	// that can fire, an Active GuiObject), so what sinks it at a point is computed here and handed to bootstrap's REAL
	// InputBegan, as the engine would
	const isButton = d => d.ClassName === "TextButton" || d.ClassName === "ImageButton" || d.ClassName === "TextBox";
	const sinksAt = (x, y) =>
		[ctx.hudLayer, ...ctx.hudLayer.GetDescendants()].filter(d => {
			if (!d.IsA?.("GuiObject") || !shown(d)) return false;
			if (!(isButton(d) ? d.Interactable !== false : d.Active === true)) return false;
			const r = rectOf(d);
			return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
		});
	const cardSinks = () =>
		[card(), ...card().GetDescendants()].filter(
			d => d.IsA?.("GuiObject") && shown(d) && (isButton(d) ? d.Interactable !== false : d.Active === true),
		);
	const mouse1 = { UserInputType: Enum.UserInputType.MouseButton1, KeyCode: Enum.KeyCode.Unknown };
	/** a left click at (x, y) through bootstrap's handler: did it fire? */
	const clickAt = (x, y) => {
		const gpe = sinksAt(x, y).length > 0;
		input.beginFrame();
		uis.InputBegan.Fire({ ...mouse1, Position: new Vector3(x, y, 0) }, gpe);
		flush();
		const fired = input.attackPressed === true;
		uis.InputEnded.Fire({ ...mouse1, Position: new Vector3(x, y, 0) }, gpe);
		flush();
		input.beginFrame();
		return fired;
	};
	hud.showDawnReport({ zombies: 3, damage: 10, items: 0 });
	hud.dawnBreakLine();
	layoutGame(ui, ctx);
	{
		const cr = rectOf(card());
		const target = deep(card(), "Dismiss");
		const hit = rectOf(target);
		const cross = rectOf(deep(card(), "Cross"));
		const inHit = (x, y) => x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h;
		// points on the card's texts and body, away from the ╳'s hit
		const points = [
			[cr.x + cr.w * 0.1, cr.y + cr.h * 0.5],
			[cr.x + cr.w * 0.5, cr.y + cr.h * 0.3],
			[cr.x + cr.w * 0.5, cr.y + cr.h * 0.8],
			[cr.x + cr.w * 0.3, cr.y + cr.h * 0.95],
		].filter(([x, y]) => !inHit(x, y));
		const fired = points.map(([x, y]) => clickAt(x, y));
		const sinks = cardSinks();
		check(
			"um clique que comeca no cartao (texto, numeros, fundo, linha da pausa) e um tiro: nada nele prende o mouse (Active falso)",
			points.length === 4 && fired.every(f => f) && up(),
			`${fired.join(",")}; no cartao, prende: ${sinks.map(d => d.Name).join(", ")}`,
		);
		check(
			"so o ╳ e botao: um TextButton no canto do cartao, sobre a cruz e dentro do cartao, nao Selectable, de pelo menos MIN_TOUCH_PX (44 px) de lado",
			sinks.length === 1 &&
				sinks[0] === target &&
				target.ClassName === "TextButton" &&
				target.Selectable === false &&
				hit.w >= MIN_TOUCH_PX - 0.5 &&
				hit.h >= MIN_TOUCH_PX - 0.5 &&
				hit.x <= cross.x + cross.w / 2 &&
				cross.x + cross.w / 2 <= hit.x + hit.w &&
				hit.y <= cross.y + cross.h / 2 &&
				cross.y + cross.h / 2 <= hit.y + hit.h &&
				hit.x >= cr.x - 0.5 &&
				hit.y >= cr.y - 0.5 &&
				hit.x + hit.w <= cr.x + cr.w + 0.5 &&
				hit.y + hit.h <= cr.y + cr.h + 0.5 &&
				hit.w * hit.h < (cr.w * cr.h) / 4,
			`hit ${Math.round(hit.w)}x${Math.round(hit.h)} no cartao ${Math.round(cr.w)}x${Math.round(cr.h)}`,
		);
		// a click on the ╳ is the button's (no shot), and it sends the card away
		const onCross = clickAt(hit.x + hit.w / 2, hit.y + hit.h / 2);
		target.Activated.Fire();
		const tapped = !up() && hud.dawnCard().wasDismissed();
		hud.showDawnReport({ zombies: 3, damage: 10, items: 0 });
		hud.showMessage("Wave 1");
		check(
			"um clique no ╳ e do botao (nao atira) e manda o cartao embora; uma onda (noticia) toma a caixa dele",
			!onCross && tapped && !up(),
		);
	}
	// the break line: the server's (protocol note 24), never the client's -- on the card if it is up, else nowhere here
	const noCard = hud.dawnBreakLine();
	hud.showDawnReport({ zombies: 3, damage: 10, items: 0 });
	const short = hud.dawnCard().size();
	const noLine = deep(card(), "Break").Visible === false;
	const onCard = hud.dawnBreakLine();
	const tall = hud.dawnCard().size();
	const breakShown =
		deep(card(), "Break").Visible === true &&
		txt("Break") === "You've played for over 90 minutes. Dawn is a good time for a break.";
	check(
		"a linha da pausa so quando o servidor a da: no cartao aberto (que cresce, nunca alem da caixa do banner); sem cartao, false (vai para o feed)",
		!noCard && noLine && onCard && breakShown && tall[1] > short[1] && tall[1] <= DCard.DAWN_H,
		`${short.join("x")} -> ${tall.join("x")}`,
	);
	// ...and with no card up, main.client puts it on the feed, once
	const feedLines = () => deepAll(hudRoot(), "Line").map(l => l.GetAttribute("Text"));
	hud.dawnCard().hide();
	hud.breakLineOnFeed();
	check(
		"sem cartao, a linha vai para o feed (a mesma frase), em vez de sumir: linha contada e linha vista",
		feedLines().includes("You've played for over 90 minutes. Dawn is a good time for a break."),
		feedLines().join(" | "),
	);
	check("a caixa do cartao tem a altura da caixa do banner (o mesmo lugar)", DCard.DAWN_H === 110);
	// no churn once built: 20 dawns, their notices and 600 frames
	const churn = phase("cartao do amanhecer: 20 amanheceres, avisos e 600 quadros", () => {
		for (let i = 0; i < 20; i++) {
			hud.showDawnReport({ zombies: i, damage: i * 7, items: i % 3 });
			if (i % 4 === 0) hud.dawnBreakLine();
			hud.dawnStoreNotice(i % 2 === 0 ? "saving" : "saved", i % 2 === 1);
			for (let f = 0; f < 30; f++) {
				setClock(getClock() + 1 / 60);
				hud.update(state());
			}
		}
	});
	check(
		"depois de construido: 20 amanheceres, avisos e 600 quadros sem criar nem destruir Instance",
		zero(churn),
		cost(churn),
	);
	hud.showDawnReport({ zombies: 3, damage: 10, items: 0 });
	const still = phase("cartao do amanhecer: 120 quadros de pe", () => {
		for (let f = 0; f < 120; f++) {
			setClock(getClock() + 1 / 60);
			hud.update(state());
		}
	});
	check("...e de pe por 120 quadros, nada criado nem destruido", zero(still) && up(), cost(still));
	const dcSrc = readFileSync(join(SRC, "client/ui/dawnCard.ts"), "utf8");
	check(
		"nada se move: o cartao aparece e some (sem tween, sem pulso), entao o Reduzir Movimento nao tem o que tirar; texto sem contorno",
		!/tween|fadeText|fadeSurface|motionTween|math\.sin/.test(dcSrc) &&
			card()
				.GetDescendants()
				.every(d => d.ClassName !== "UIStroke"),
	);

	// (c) the level-up says what it gave (BEM-08)
	hud.showLevelUp(5, 1);
	hud.showLevelUp(7, 2);
	const lines = deepAll(hudRoot(), "Line").map(l => [l.GetAttribute("Text"), l.FindFirstChild("Text")?.TextColor3]);
	const one = lines.find(([t]) => t === "Level 5 · +1 skill point · Backpack › Skills");
	const two = lines.find(([t]) => t === "Level 7 · +2 skill points · Backpack › Skills");
	check(
		'o level-up diz o que deu e onde gastar: "Level 5 · +1 skill point · Backpack › Skills" (e "+2 skill points"), no azul do XP',
		one !== undefined && two !== undefined && sameColor(one[1], GAME.xp),
		lines.map(([t]) => t).join(" | "),
	);
	// the run wires it all: the tally every frame (the dead too), the server's store notices, the level line
	const mainSrc = readFileSync(join(SRC, "client/main.client.ts"), "utf8");
	check(
		"main.client.ts: a noite contada a cada quadro (fora do `if (alive)`), o aviso de gravacao do servidor no cartao, o level-up novo",
		/\n\t\tstepNight\(!refs\.player\.dead\);/.test(mainSrc) &&
			/net\.onStoreState\(\(state, answersDawn\) => hud\.dawnStoreNotice\(state, answersDawn\)\);/.test(
				mainSrc,
			) &&
			/hud\.showLevelUp\(save\.level, save\.level - lastLevel\);/.test(mainSrc) &&
			!/hud\.showMessage\("Level UP"\)/.test(mainSrc) &&
			/nightTally\.reset\(\);\n\tbreakNudgeAt = undefined;/.test(mainSrc),
	);
	// L6 / L7 of the review of ca9494a: the damage is the server's hp (the self block), and the break line is only ever
	// what the server said -- on the card, or the feed after BREAK_CARD_WAIT_S -- with no clock of the client's own
	check(
		"main.client.ts: o dano da noite vem do hp do servidor (netSelfHp), e a linha da pausa so do Announce do servidor (sem relogio proprio)",
		/hp: netSelfHp\(\) \?\? refs\.player\.hp,/.test(mainSrc) &&
			/if \(netTakeBreakNudge\(\)\) breakNudgeAt = now;/.test(mainSrc) &&
			/if \(hud\.dawnBreakLine\(\)\) \{\n\t\tbreakNudgeAt = undefined;/.test(mainSrc) &&
			/now - breakNudgeAt >= BREAK_CARD_WAIT_S\) \{\n\t\thud\.breakLineOnFeed\(\);/.test(mainSrc) &&
			!/SESSION_START|breakNudgeDue|BREAK_NUDGE_MIN/.test(mainSrc),
	);

	// L1 and M1 on a phone (844 x 390, touch): the card with the break line never covers the message feed under it, and
	// a finger that lands on the card still moves or aims
	hud.unmount();
	uis.TouchEnabled = true;
	uis.MouseEnabled = false;
	uis.GetLastInputType = () => Enum.UserInputType.Touch;
	setViewport(844, 390, 36, 104);
	hud.mount();
	hud.update(state());
	layoutGame(ui, ctx);
	hud.showDawnReport({ zombies: 23, damage: 64, items: 9 });
	hud.dawnBreakLine();
	hud.showLevelUp(8, 1);
	hud.showLevelUp(9, 1);
	hud.update(state());
	layoutGame(ui, ctx);
	{
		const cr = rectOf(card());
		const feed = deep(hudRoot(), "Feed");
		const feedBox = rectOf(feed);
		const lines = deepAll(feed, "Line")
			.filter(l => shown(l))
			.map(rectOf);
		const overlapR = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
		const [cw, ch] = hud.dawnCard().size();
		const brk = rectOf(deep(card(), "Break"));
		const rows = ch >= DCard.DAWN_H ? 2 : 1;
		check(
			`844x390 toque: o cartao com a linha da pausa (${rows} linha(s), ${Math.round(cw)}x${Math.round(ch)}) termina acima do feed, e nenhuma linha do feed fica sob ele`,
			up() &&
				ch <= DCard.DAWN_H &&
				cr.y + cr.h <= feedBox.y + 0.5 &&
				lines.length === 2 &&
				lines.every(l => !overlapR(cr, l)) &&
				brk.y + brk.h <= cr.y + cr.h + 0.5 &&
				brk.h >= rows * 9 - 0.5,
			`cartao y ${Math.round(cr.y)}..${Math.round(cr.y + cr.h)}, feed a partir de ${Math.round(feedBox.y)}; linha da pausa ${Math.round(brk.h)} px`,
		);
		// the ╳'s 44 px hit on a phone: inside the card, and clear of the corner's controls (the chip, the clock plate)
		const hit = rectOf(deep(card(), "Dismiss"));
		const corner = ["ChipSlot", "SkyPlate", "BagBtn", "MenuBtn"]
			.map(n => [n, deep(hudRoot(), n)])
			.filter(([, f]) => f !== undefined && shown(f))
			.map(([n, f]) => [n, rectOf(f)]);
		check(
			"844x390 toque: o alvo do ╳ (>= 44 px) fica dentro do cartao, longe do chip do placar, do relogio, do Bag e do Menu",
			hit.w >= MIN_TOUCH_PX - 0.5 &&
				hit.h >= MIN_TOUCH_PX - 0.5 &&
				hit.x >= cr.x - 0.5 &&
				hit.y >= cr.y - 0.5 &&
				hit.x + hit.w <= cr.x + cr.w + 0.5 &&
				hit.y + hit.h <= cr.y + cr.h + 0.5 &&
				corner.length >= 2 &&
				corner.every(([, r]) => !overlapR(hit, r)),
			`hit ${Math.round(hit.x)},${Math.round(hit.y)} ${Math.round(hit.w)}x${Math.round(hit.h)}; ${corner.map(([n]) => n).join(", ")}`,
		);
		const gsv = service("GuiService");
		const none = gsv.GetInsetArea(Enum.ScreenInsets.None);
		const core = { x: -none.Min.X, y: -none.Min.Y };
		const L = boot.getTouchLayout();
		/** a finger at (x, y) on the screen, through bootstrap's real handler: what did it start? */
		const touchAt = (x, y) => {
			const finger = {
				UserInputType: Enum.UserInputType.Touch,
				KeyCode: Enum.KeyCode.Unknown,
				Position: new Vector3(x - core.x, y - core.y, 0),
			};
			const gpe = sinksAt(x, y).length > 0;
			uis.InputBegan.Fire(finger, gpe);
			flush();
			const got = { gpe, move: input.joystickActive === true, aim: input.aimStickActive === true };
			uis.InputEnded.Fire(finger, gpe);
			flush();
			return got;
		};
		const right = touchAt(cr.x + cr.w * 0.62, cr.y + cr.h * 0.6);
		const left = touchAt(cr.x + cr.w * 0.3, cr.y + cr.h * 0.6);
		check(
			"844x390 toque: um dedo que pousa no cartao ainda mira (do lado da mira) e anda (do lado do analogico flutuante)",
			!right.gpe && right.aim && !left.gpe && (L.floating ? left.move : true),
			JSON.stringify({ right, left, floating: L.floating }),
		);
	}
	hud.unmount();
	flush();
}

// ---------------------------------------------------------------- report

console.log("\nPasso                                                        criadas  destruidas  escritas");
for (const x of table) {
	console.log(
		`${x.label.padEnd(60)} ${String(x.created).padStart(7)} ${String(x.destroyed).padStart(11)} ${String(x.writes).padStart(9)}`,
	);
}
console.log(
	`\nconsole desktop ${DESKTOP_LAYOUT.w} x ${DESKTOP_LAYOUT.h}, compacto ${COMPACT_LAYOUT.w} x ${COMPACT_LAYOUT.h} (unidades de design)`,
);
console.log(`hotbars vistas nos 600 quadros: ${[...seen].join(" | ")}`);
void GAME;
void getClock;

console.log("");
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
}
console.log("OK: a HUD atualiza sem criar Instance, a hotbar e a lista das teclas 1-5, e o toque nunca e coberto");
