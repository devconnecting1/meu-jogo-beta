#!/usr/bin/env node
/*
 * Colour contrast of the theme: every pair the UI really draws, measured.
 *
 *   npm run test:contrast
 *
 * Why this exists: docs/research/ui.md (6.4) found three pairs below the readable minimum -- the main action
 * button at 4,18:1, `accent` at 3,35:1 and the well outline over a panel at 1,68:1 -- and the fix is a change
 * of PALETTE. A palette has no compiler: the next theme regeneration can quietly undo it. So the ratios are
 * a test.
 *
 * Criterion (ours, not Roblox's): the Roblox accessibility page asks for "sufficient color contrast" without
 * fixing a number, so we adopt WCAG 2.x -- 4,5:1 for text and 3:1 for the non-text parts that carry meaning
 * (outlines, tracks, bar fills, focus rings). Our text is small (the kit's `label` role is 14 design units,
 * which on a phone renders at the 9 px floor of skin.ts), so we do NOT claim the 3:1 "large text" exemption
 * anywhere.
 *
 * How the pairs are resolved: the values come from the GENERATED src/client/ui/themeTokens.ts, and the roles
 * (THEME / SURFACE / GAME / SIDEBAR) are read out of src/client/ui/theme.ts, including which mode is active
 * (`const TOKENS = DARK`). So re-pointing a role -- say `primary` back to chart-1 -- moves the test with it
 * instead of leaving it measuring something the UI no longer draws.
 *
 * Two honest limits, both from the audit:
 *  - 5.3: a skinned surface is a GREYSCALE texture multiplied by the token, so what a panel really renders is
 *    darker than its token. These ratios are therefore an UPPER bound for skinned surfaces; the flat fallback
 *    (no textures) is what they describe exactly.
 *  - the HUD draws over the game world at TRANSPARENCY.hud, and the world is not a colour we can measure.
 *    Banner and HUD text carries a 1 px outline in `background` (GAME.textOutline) for that reason.
 *
 * Pure Node (>= 18), no dependencies.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS_FILE = join(ROOT, "src", "client", "ui", "themeTokens.ts");
const THEME_FILE = join(ROOT, "src", "client", "ui", "theme.ts");

/** WCAG 2.x: normal text */
const MIN_TEXT = 4.5;
/** WCAG 2.x: non-text content that carries meaning (outlines, tracks, indicators, focus rings) */
const MIN_UI = 3;
/** ours: the panel moulding is decoration, not the outline that identifies the panel -- but it must be seen */
const MIN_RELIEF = 1.5;

// ---------------------------------------------------------------- parsing

const tokensSrc = readFileSync(TOKENS_FILE, "utf8");
const themeSrc = readFileSync(THEME_FILE, "utf8");

/** the body of `export const NAME ... = { ... };` */
function block(src, name) {
	const start = src.indexOf(`export const ${name}`);
	if (start < 0) throw new Error(`${name} not found`);
	const open = src.indexOf("{", start);
	const close = src.indexOf("\n};", open);
	if (open < 0 || close < 0) throw new Error(`${name} is not an object literal`);
	return src.slice(open, close);
}

/** { key: [r, g, b] } from a themeTokens.ts colour block */
function colorBlock(name) {
	const out = new Map();
	const re = /^\t(\w+): Color3\.fromRGB\((\d+), (\d+), (\d+)\),$/gm;
	for (const m of block(tokensSrc, name).matchAll(re)) {
		out.set(m[1], [+m[2], +m[3], +m[4]]);
	}
	if (out.size === 0) throw new Error(`no colours parsed from ${name}`);
	return out;
}

/** which themeTokens block theme.ts is currently pointed at */
function activeMode(local) {
	const m = themeSrc.match(new RegExp(`const ${local}[^=]*=\\s*(\\w+);`));
	if (m === null) throw new Error(`theme.ts: could not read \`${local}\``);
	return m[1];
}

const TOKENS = colorBlock(activeMode("TOKENS"));
const SIDEBAR_TOKENS = colorBlock(activeMode("SIDEBAR_TOKENS"));

/** { role: [r, g, b] } from a theme.ts role block (`key: TOKENS.token,` / `key: SIDEBAR_TOKENS.token,`) */
function roleBlock(name) {
	const out = new Map();
	const re = /^\t(\w+): (TOKENS|SIDEBAR_TOKENS)\.(\w+),$/gm;
	for (const m of block(themeSrc, name).matchAll(re)) {
		const from = m[2] === "TOKENS" ? TOKENS : SIDEBAR_TOKENS;
		const rgb = from.get(m[3]);
		if (rgb === undefined) throw new Error(`theme.ts ${name}.${m[1]} points at a missing token "${m[3]}"`);
		out.set(m[1], rgb);
	}
	if (out.size === 0) throw new Error(`no roles parsed from ${name}`);
	return out;
}

const GROUPS = {
	THEME: roleBlock("THEME"),
	SURFACE: roleBlock("SURFACE"),
	GAME: roleBlock("GAME"),
	// `export const SIDEBAR = SIDEBAR_TOKENS;` -- the rail palette is the token group itself
	SIDEBAR: SIDEBAR_TOKENS,
};

/** "THEME.foreground" -> [r, g, b] */
function role(path) {
	const [group, key] = path.split(".");
	const g = GROUPS[group];
	if (g === undefined) throw new Error(`unknown group in "${path}"`);
	const rgb = g.get(key);
	if (rgb === undefined) throw new Error(`theme.ts has no ${path}`);
	return rgb;
}

// ---------------------------------------------------------------- WCAG maths

const channel = v => {
	const c = v / 255;
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

/** WCAG relative luminance */
function luminance([r, g, b]) {
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1:1 .. 21:1 */
function contrast(a, b) {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const hex = ([r, g, b]) => "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------- the pairs the UI draws

/**
 * [front, back, minimum, what draws it].
 *
 * Surface note: a light colour has LESS contrast against the lighter of two dark surfaces, so where a colour
 * can sit either on the page (`background`) or on a panel (`SURFACE.panel`, which is lighter), the panel is
 * the worst case and the one measured.
 */
const PAIRS = [
	// --- text ---
	["THEME.foreground", "THEME.background", MIN_TEXT, "texto das paginas cheias (lobby, loja, ajustes)"],
	["THEME.cardForeground", "THEME.card", MIN_TEXT, "texto de card"],
	["THEME.popoverForeground", "THEME.popover", MIN_TEXT, "texto de dialogo, toast, tutorial, nameplate"],
	["THEME.foreground", "SURFACE.panel", MIN_TEXT, "texto sobre o interior de um painel"],
	["THEME.foreground", "SURFACE.well", MIN_TEXT, "texto dentro de um well (listas, trilhos, barras)"],
	["THEME.foreground", "SURFACE.frame", MIN_TEXT, "titulo na faixa do painel; badge `default`"],
	["THEME.mutedForeground", "THEME.background", MIN_TEXT, "legendas e descricoes"],
	["THEME.mutedForeground", "SURFACE.panel", MIN_TEXT, "legendas dentro de um painel"],
	["THEME.mutedForeground", "SURFACE.well", MIN_TEXT, "botao desabilitado; aba inativa"],
	["THEME.accentForeground", "SURFACE.frame", MIN_TEXT, "texto de hover/selecao dos controles recuados"],
	["THEME.accentForeground", "THEME.accent", MIN_TEXT, "o par `accent` do mapa de papeis (theme.ts)"],
	["THEME.primaryForeground", "THEME.primary", MIN_TEXT, "a acao principal da tela (Play, Equip, Buy)"],
	["THEME.secondaryForeground", "THEME.secondary", MIN_TEXT, "demais acoes, aba ativa, item de trilho ativo"],
	["THEME.destructiveForeground", "THEME.destructive", MIN_TEXT, "acoes perigosas e o botao Fechar (X)"],
	["SIDEBAR.foreground", "SURFACE.well", MIN_TEXT, "item do trilho de navegacao"],
	["SIDEBAR.foreground", "SURFACE.panel", MIN_TEXT, "item do trilho sobre o painel"],

	// --- game colours used as text / numbers / glyphs ---
	["GAME.success", "SURFACE.panel", MIN_TEXT, "cura, equipado, ingrediente presente"],
	["GAME.hp", "SURFACE.panel", MIN_TEXT, "erro, dano, ingrediente faltando"],
	["GAME.xp", "SURFACE.panel", MIN_TEXT, "nivel, XP, avisos neutros"],
	["GAME.food", "SURFACE.panel", MIN_TEXT, "fome, moedas, atencao sem perigo"],
	["GAME.rare", "SURFACE.panel", MIN_TEXT, "itens raros, chefes"],
	["GAME.material", "SURFACE.panel", MIN_TEXT, "materiais e itens diversos"],

	// --- non-text: outlines, tracks, indicators, focus ---
	["SURFACE.line", "SURFACE.panel", MIN_UI, "contorno de well, aba inativa e linha de lista (achado 6.4)"],
	["SURFACE.line", "SURFACE.well", MIN_UI, "o mesmo contorno visto contra o well que ele fecha"],
	["THEME.border", "SURFACE.panel", MIN_UI, "separadores e contornos sobre um painel"],
	["THEME.border", "THEME.background", MIN_UI, "separadores e contornos sobre a pagina"],
	["THEME.input", "SURFACE.well", MIN_UI, "trilho de slider / progresso"],
	["THEME.ring", "SURFACE.panel", MIN_UI, "anel de foco (gamepad / teclado)"],
	["THEME.primary", "SURFACE.well", MIN_UI, "indicador de progresso dentro do trilho"],
	["GAME.hp", "SURFACE.well", MIN_UI, "barra de vida"],
	["GAME.food", "SURFACE.well", MIN_UI, "barra de fome"],
	["GAME.xp", "SURFACE.well", MIN_UI, "barra de XP"],
	["SURFACE.frame", "SURFACE.panel", MIN_RELIEF, "moldura grossa do painel (relevo, nao e o contorno)"],
];

// ---------------------------------------------------------------- run

let failures = 0;
const width = PAIRS.reduce((w, p) => Math.max(w, `${p[0]} / ${p[1]}`.length), 0);

console.log(`contraste dos tokens (${activeMode("TOKENS")} / ${activeMode("SIDEBAR_TOKENS")})\n`);
for (const [frontPath, backPath, min, why] of PAIRS) {
	const front = role(frontPath);
	const back = role(backPath);
	const r = contrast(front, back);
	const ok = r + 1e-9 >= min;
	if (!ok) failures++;
	const label = `${frontPath} / ${backPath}`.padEnd(width);
	const shown = `${hex(front)} sobre ${hex(back)}`;
	console.log(
		`${ok ? "ok  " : "FALHA"} ${label}  ${r.toFixed(2).padStart(5)}:1  (min ${min})  ${shown}  ${why}`,
	);
}

console.log("");
if (failures > 0) {
	console.error(`${failures} par(es) abaixo do minimo: ajuste design/tweakcn-theme.json e rode \`npm run theme\``);
	process.exit(1);
}
console.log(`OK: ${PAIRS.length} pares medidos, nenhum abaixo do minimo`);
