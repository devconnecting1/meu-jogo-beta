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
 *     when it differs from the world's (MP-13 / MP-20); no text carries a contour (UI-04);
 *  5. touch: the compact console never covers the move stick or the fire controls, measured on the touch layout's
 *     own numbers (shared/engine/input.ts), at 1120x630 ("phone") and 1360x435 (wide), with the default controls,
 *     left-handed, at the largest sizes and with a fixed stick -- and its tiles stay a thumb wide; the sky's touch
 *     plate sits under the row of Menu and Bag and covers nothing -- the thumbs, Menu, Bag, the console, nor the
 *     banner and feed over the top centre (phones included, and a crowded one); the match scoreboard's chip (MP-23)
 *     is in that row, left of Menu (desktop: the third plate of the console's row, after Bag and Menu), a thumb
 *     target, and covers nothing either -- the sky included; and at the largest HUD size the banner is 1,2x, still
 *     at the top, and still narrows off the corner.
 *
 * Pure Node (>= 18) plus the project's TypeScript.
 */
import { join } from "node:path";
import { installUiShims } from "./ui-shim.mjs";

const ui = installUiShims({ seed: 1, viewport: [1120, 630] });
const { SRC, require, INTERNAL, flush, service, measure, setViewport, setClock, getClock } = ui;

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
blinkAt(true);
hud.update(state({ hunger: 10 }));
check("fome baixa pisca a barra de fome em vermelho", sameColor(face(barFill("Food")), BAR.hp));
blinkAt(false);
hud.update(state());

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

hud.unmount();
check("desmontar remove tudo", hudRoot() === undefined);

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
