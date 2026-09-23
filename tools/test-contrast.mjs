#!/usr/bin/env node
/*
 * Colour contrast of the theme, and the two rules that keep text readable without tricks.
 *
 *   npm run test:contrast
 *
 * Why this exists: docs/research/ui.md (6.4) found pairs below the readable minimum -- the main action button at
 * 4,18:1, `accent` at 3,35:1, the well outline over a panel at 1,68:1 -- and the fix is a change of PALETTE.
 * A palette has no compiler: the next theme regeneration can quietly undo it. So the ratios are a test.
 *
 * The owner's rules for text (docs/DESIGN_RULES.md UI-04 / UI-05), which this file enforces:
 *  1. text NEVER carries a contour: no UIStroke on a TextLabel / TextButton / TextBox, no TextStroke;
 *  2. a label on a plate (button, active tab, key) is the LIGHT `foreground`, never the near-black body;
 *  3. so the PLATE carries the contrast: a button title (large, SemiBold/Bold) needs 3:1 against its plate,
 *     small text on a plate ("Day 1" under PLAY, the menu-tile subtitles, key legends) needs 4,5:1.
 * Rule 1 is checked on the kit's source (skin.ts / widgets.ts / tutorial.ts), since a Luau GuiObject tree does
 * not exist here; rules 2 and 3 on the tokens.
 *
 * Criterion (ours, not Roblox's): the Roblox accessibility page asks for "sufficient color contrast" without a
 * number, so we adopt WCAG 2.x -- 4,5:1 for text, 3:1 for large text and for the non-text parts that carry
 * meaning (outlines, tracks, bar fills, focus rings).
 *
 * How the pairs are resolved: the values come from the GENERATED src/client/ui/themeTokens.ts, and the roles
 * (THEME / SURFACE / GAME / SIDEBAR) are read out of src/client/ui/theme.ts, including which mode is active
 * (`const TOKENS = DARK`). So re-pointing a role moves the test with it instead of leaving it measuring
 * something the UI no longer draws.
 *
 * Two honest limits, both from the audit:
 *  - 5.3: a skinned surface is a GREYSCALE texture multiplied by the token, so what it renders is DARKER than
 *    its token. For light text on a plate that makes the measured ratio the worst case; for anything else it is
 *    an estimate, exact only for the flat fallback (no textures).
 *  - the HUD draws over the game world at TRANSPARENCY.hud, and the world is not a colour we can measure.
 *
 * Pure Node (>= 18), no dependencies.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const UI = join(ROOT, "src", "client", "ui");
const TOKENS_FILE = join(UI, "themeTokens.ts");
const THEME_FILE = join(UI, "theme.ts");
/** the kit: the only code allowed to create strokes for the screens, and the keycaps */
const KIT_FILES = ["skin.ts", "widgets.ts", "plate.ts", "window.ts", "tutorial.ts"];

/** WCAG 2.x: normal (small) text */
const MIN_TEXT = 4.5;
/** WCAG 2.x: large text -- a button title is large and SemiBold/Bold */
const MIN_LARGE = 3;
/** WCAG 2.x: non-text content that carries meaning (outlines, tracks, indicators, focus rings) */
const MIN_UI = 3;
/** ours: the panel moulding is decoration, not the outline that identifies the panel -- but it must be seen */
const MIN_RELIEF = 1.5;
/**
 * ours: two tones of ONE shape (the label cell and the value cell of a settings row, UI-07). The reference's own
 * pair measures 1,22:1; below this the row reads as one flat bar and the "label | value" split is gone.
 */
const MIN_TONE = 1.2;

let failures = 0;
function check(label, ok, detail) {
	if (!ok) failures++;
	console.log(`${ok ? "ok   " : "FALHA"} ${label}${detail === undefined ? "" : `  ${detail}`}`);
}

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
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

// ---------------------------------------------------------------- the pairs the UI draws

/**
 * [front, back, minimum, what draws it].
 *
 * Surface note: a light colour has LESS contrast against the lighter of two dark surfaces, so where a colour
 * can sit either on the page (`background`) or on a panel (`SURFACE.panel`, which is lighter), the panel is
 * the worst case and the one measured.
 */
const PAIRS = [
	// --- text on the dark body ---
	["THEME.foreground", "THEME.background", MIN_TEXT, "texto das paginas cheias (lobby, loja, ajustes)"],
	["THEME.cardForeground", "THEME.card", MIN_TEXT, "texto de card"],
	["THEME.popoverForeground", "THEME.popover", MIN_TEXT, "texto de dialogo, toast, tutorial, nameplate"],
	["THEME.foreground", "SURFACE.panel", MIN_TEXT, "texto sobre o interior de um painel"],
	["THEME.foreground", "SURFACE.well", MIN_TEXT, "texto dentro de um well (listas, trilhos, barras)"],
	["THEME.foreground", "SURFACE.frame", MIN_TEXT, "titulo na faixa do painel"],
	["THEME.mutedForeground", "THEME.background", MIN_TEXT, "legendas e descricoes"],
	["THEME.mutedForeground", "SURFACE.panel", MIN_TEXT, "legendas dentro de um painel"],
	["THEME.mutedForeground", "SURFACE.well", MIN_TEXT, "botao desabilitado; aba inativa"],
	["THEME.accentForeground", "SURFACE.frame", MIN_TEXT, "texto de hover/selecao dos controles recuados"],
	["SIDEBAR.foreground", "SURFACE.well", MIN_TEXT, "item do trilho de navegacao"],
	["SIDEBAR.foreground", "SURFACE.panel", MIN_TEXT, "item do trilho sobre o painel"],

	// --- labels on plates: the plate carries the contrast (UI-05) ---
	["THEME.primaryForeground", "THEME.primary", MIN_LARGE, "chapa verde: titulo (PLAY, Got it, Equip)"],
	["THEME.primaryForeground", "THEME.primary", MIN_TEXT, "chapa verde: texto pequeno (o \"Day 1\" do PLAY)"],
	["THEME.secondaryForeground", "THEME.secondary", MIN_LARGE, "chapa de ferro: titulo (Shop, Settings, aba ativa)"],
	["THEME.secondaryForeground", "THEME.secondary", MIN_TEXT, "chapa de ferro: subtitulos (\"0 / 20\"), badge"],
	["THEME.destructiveForeground", "THEME.destructive", MIN_LARGE, "chapa vermelha: titulo (Close X, Quit)"],
	["THEME.accentForeground", "THEME.accent", MIN_TEXT, "o par `accent` do mapa de papeis (theme.ts)"],
	["THEME.foreground", "SURFACE.key", MIN_TEXT, "legenda de tecla (How to play, prompt E)"],
	// the value drawn OVER a bar's fill (Progress label: numeric Bold) lost its outline with UI-04 -> the fill
	["THEME.foreground", "GAME.hp", MIN_LARGE, "valor sobre a barra de vida (numeric Bold)"],
	["THEME.foreground", "GAME.food", MIN_LARGE, "valor sobre a barra de fome (numeric Bold)"],
	["THEME.foreground", "GAME.xp", MIN_LARGE, "valor sobre a barra de XP (numeric Bold)"],
	["THEME.foreground", "THEME.primary", MIN_LARGE, "valor sobre uma barra de progresso padrao"],
	["THEME.foreground", "GAME.coin", MIN_LARGE, "glifo \"$\" do icone de moeda (CoinIcon) e do chip do toast de moeda"],
	["THEME.foreground", "GAME.info", MIN_LARGE, "glifo do chip de toast (kind padrao \"info\"; success/coin/error tambem sobem deste piso)"],

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

	// --- the window vocabulary (UI-07): the reference's pieces, with light labels and no contour ---
	["THEME.foreground", "SURFACE.header", MIN_TEXT, "titulo da janela sobre a faixa do cabecalho"],
	["THEME.mutedForeground", "SURFACE.header", MIN_TEXT, "o \"?\" do cabecalho, em repouso"],
	["THEME.tabActiveForeground", "THEME.tabActive", MIN_TEXT, "aba ativa azul / segmento escolhido / item selecionado"],
	["THEME.secondaryForeground", "THEME.secondary", MIN_TEXT, "aba inativa (chapa lisa de ferro) e seu rotulo"],
	["THEME.foreground", "SURFACE.key", MIN_TEXT, "tecla de valor escura da linha de ajuste (W, LeftShift, 50%)"],
	["THEME.destructiveForeground", "THEME.destructive", MIN_LARGE, "X vermelho de fechar a janela (glifo grande Bold)"],
	["THEME.foreground", "SURFACE.cellLabel", MIN_TEXT, "celula de rotulo da linha de ajuste (Bold, centrado)"],
	["THEME.foreground", "SURFACE.cell", MIN_TEXT, "celula de valor (valor em texto: About)"],
	["THEME.foreground", "SURFACE.section", MIN_TEXT, "titulo do poco da secao (Volume, Keybinds)"],
	["THEME.mutedForeground", "SURFACE.groove", MIN_TEXT, "nota muda dentro da lista (nunca sobre uma celula)"],
	["THEME.foreground", "SURFACE.window", MIN_TEXT, "texto sobre o corpo grafite da janela"],
	["THEME.mutedForeground", "SURFACE.window", MIN_TEXT, "legenda sobre o corpo da janela (limita o quanto ele clareia)"],
	["SURFACE.window", "THEME.background", MIN_TONE, "corpo da janela destacado da pagina escura atras dela"],
	["SURFACE.window", "SURFACE.header", MIN_TONE, "faixa do cabecalho um tom abaixo do corpo da janela"],
	["THEME.tabActive", "SURFACE.window", MIN_UI, "aba ativa sobre o corpo da janela"],
	["THEME.secondary", "SURFACE.window", MIN_UI, "aba inativa sobre o corpo da janela"],
	["SURFACE.section", "SURFACE.window", MIN_RELIEF, "poco da secao sobre o corpo da janela"],
	["THEME.tabActive", "SURFACE.panel", MIN_UI, "item selecionado do trilho (Bag, loja) sobre o painel"],
	["THEME.secondary", "SURFACE.panel", MIN_UI, "chapa de ferro sobre um painel"],
	["THEME.secondary", "SURFACE.well", MIN_UI, "segmento inativo dentro da canaleta do seletor"],
	["SURFACE.well", "SURFACE.cell", MIN_RELIEF, "canaleta do seletor / sulco do slider sobre a celula de valor"],
	["THEME.tabActive", "SURFACE.well", MIN_UI, "faixa escolhida do slider dentro do sulco"],
	["THEME.border", "SURFACE.groove", MIN_UI, "barra de rolagem clara sobre a lista"],
	["SURFACE.section", "SURFACE.panel", MIN_RELIEF, "poco de secao sobre um painel comum"],
	["SURFACE.section", "SURFACE.groove", MIN_RELIEF, "sulco entre as linhas (lista) contra o poco"],
	["SURFACE.cellLabel", "SURFACE.groove", MIN_RELIEF, "sulco entre duas linhas contra a celula de rotulo"],
	["SURFACE.cell", "SURFACE.cellLabel", MIN_TONE, "celula de valor x celula de rotulo (dois tons da mesma linha)"],
];

/** labels drawn ON a plate: each must be the light `foreground` (UI-05), never the body colour */
const PLATE_LABELS = [
	"THEME.primaryForeground",
	"THEME.secondaryForeground",
	"THEME.destructiveForeground",
	"THEME.accentForeground",
	"THEME.tabActiveForeground",
];

// ---------------------------------------------------------------- run: contrast

console.log(`1) contraste dos tokens (${activeMode("TOKENS")} / ${activeMode("SIDEBAR_TOKENS")})\n`);
const width = PAIRS.reduce((w, p) => Math.max(w, `${p[0]} / ${p[1]}`.length), 0);
for (const [frontPath, backPath, min, why] of PAIRS) {
	const front = role(frontPath);
	const back = role(backPath);
	const r = contrast(front, back);
	const label = `${frontPath} / ${backPath}`.padEnd(width);
	check(label, r + 1e-9 >= min, `${r.toFixed(2).padStart(5)}:1  (min ${min})  ${hex(front)} sobre ${hex(back)}  ${why}`);
}

// ---------------------------------------------------------------- run: plate labels are light

console.log("\n2) rotulo sobre chapa e o foreground claro (UI-05)\n");
const foreground = role("THEME.foreground");
for (const path of PLATE_LABELS) {
	const rgb = role(path);
	check(`${path} == THEME.foreground`, same(rgb, foreground), `${hex(rgb)} (esperado ${hex(foreground)})`);
}

// ---------------------------------------------------------------- run: text never carries a contour

console.log("\n3) o kit nao cria contorno em texto (UI-04)\n");

/** source with comments removed, so a rule explained in a comment is not mistaken for code */
function code(file) {
	return readFileSync(join(UI, file), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");
}

/** body of a top-level function (from its declaration to the first `}` in column 0) */
function functionBody(src, name) {
	const start = src.search(new RegExp(`\\nexport function ${name}\\b|\\nfunction ${name}\\b`));
	if (start < 0) return undefined;
	const end = src.indexOf("\n}", start + 1);
	return src.slice(start, end < 0 ? undefined : end + 2);
}

const kit = new Map(KIT_FILES.map(f => [f, code(f)]));
let strokeCreations = 0;
for (const [file, src] of kit) {
	strokeCreations += (src.match(/new Instance\("UIStroke"\)/g) ?? []).length;
	check(
		`${file}: nenhum UIStroke em modo Contextual (o modo que contorna glifos)`,
		!/ApplyStrokeMode\s*=(?!=)\s*Enum\.ApplyStrokeMode\.Contextual/.test(src),
	);
	const strokes = [...src.matchAll(/TextStrokeTransparency\s*=(?!=)\s*([\d.]+)/g)].map(m => +m[1]);
	check(
		`${file}: nenhum TextStroke visivel`,
		strokes.every(t => t >= 1),
		strokes.length > 0 ? `valores: ${strokes.join(", ")}` : undefined,
	);
}
const skin = kit.get("skin.ts");
const boxStroke = functionBody(skin, "boxStroke");
const strokeHost = functionBody(skin, "strokeHost");
check(
	'o kit cria UIStroke em UM lugar so (skin.ts boxStroke)',
	strokeCreations === 1 && boxStroke !== undefined && boxStroke.includes('new Instance("UIStroke")'),
	`${strokeCreations} criacao(oes) de UIStroke em ${KIT_FILES.join(", ")}`,
);
check(
	"boxStroke desenha borda de caixa e passa por strokeHost",
	boxStroke !== undefined &&
		/ApplyStrokeMode\s*=\s*Enum\.ApplyStrokeMode\.Border/.test(boxStroke) &&
		/\.Parent\s*=\s*strokeHost\(/.test(boxStroke),
);
check(
	"strokeHost nunca devolve um objeto de texto",
	strokeHost !== undefined && ["TextLabel", "TextButton", "TextBox"].every(c => strokeHost.includes(`IsA("${c}")`)),
);
for (const [file, src] of kit) {
	if (file === "skin.ts") continue;
	check(`${file}: nao cria contorno de texto por textOutline()`, !/\btextOutline\(/.test(src));
}

// ---------------------------------------------------------------- run: text never carries a contour, in ALL of src/

console.log("\n4) nenhum contorno de texto em TODO src/, nao so no kit (UI-04 vale para o jogo inteiro)\n");

/** every .ts file under `dir`, recursively -- server and shared can build GuiObjects too (admin panel, HUD data) */
function listTsFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listTsFiles(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** source with comments removed, by absolute path (the KIT_FILES `code()` above is scoped to src/client/ui) */
function codeAt(path) {
	return readFileSync(path, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");
}

let sweepFiles = 0;
let sweepFailures = 0;
for (const file of listTsFiles(SRC)) {
	sweepFiles++;
	const rel = relative(ROOT, file).split("\\").join("/");
	const src = codeAt(file);
	const badStrokes = [...src.matchAll(/TextStrokeTransparency\s*=(?!=)\s*([\d.]+)/g)].map(m => +m[1]).filter(t => t < 1);
	if (badStrokes.length > 0) {
		sweepFailures++;
		check(`${rel}: nenhum TextStroke visivel`, false, `valores: ${badStrokes.join(", ")}`);
	}
	if (/ApplyStrokeMode\s*=(?!=)\s*Enum\.ApplyStrokeMode\.Contextual/.test(src)) {
		sweepFailures++;
		check(`${rel}: nenhum UIStroke em modo Contextual (o modo que contorna glifos)`, false);
	}
	if (/\btextOutline\(/.test(src)) {
		sweepFailures++;
		check(`${rel}: nao chama textOutline() (removida do kit -- UI-04 nao tem contorno para restaurar)`, false);
	}
	if (/\boutline\s*:\s*true\b/.test(src)) {
		sweepFailures++;
		check(`${rel}: nao usa a opcao "outline" (o kit a ignora desde UI-04; nunca desenhou nada)`, false);
	}
}
check(
	`TODO src/ (${sweepFiles} arquivos .ts): nenhum contorno de texto fora do kit`,
	sweepFailures === 0,
	sweepFailures > 0 ? `${sweepFailures} violacao(oes) acima` : undefined,
);

console.log("");
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam: ajuste design/tweakcn-theme.json (e rode \`npm run theme\`) ou o kit`);
	process.exit(1);
}
console.log(
	`OK: ${PAIRS.length} pares, ${PLATE_LABELS.length} rotulos de chapa claros, nenhum contorno em texto no kit nem em ${sweepFiles} arquivos de src/`,
);
