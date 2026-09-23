#!/usr/bin/env node
/*
 * Theme pipeline: tweakcn / shadcn registry theme -> src/client/ui/themeTokens.ts
 *
 *   npm run theme                                   # regenerate from design/tweakcn-theme.json
 *   npm run theme -- https://tweakcn.com/r/themes/<id>   # download the theme, save it to design/, regenerate
 *   npm run theme -- path/to/theme.json             # use another local registry file
 *
 * Pure Node (>= 18, global fetch), no dependencies.
 *
 * - colours: oklch() / hsl() / rgb() / #hex -> sRGB (OKLab matrices, sRGB gamma, gamut clamp) -> Color3.fromRGB.
 *   Colours with alpha ("oklch(1 0 0 / 10%)") are flattened over the mode's background (Color3 has no alpha).
 * - radius / spacing: rem or px -> px (1rem = 16px). In the game these are design units of the 1120x630 layout.
 * - fonts: the first family of font-sans / font-mono / font-serif is mapped to the closest Roblox built-in family
 *   (FONT_MAP below; unknown fonts fall back to BuilderSans / BuilderMono / Merriweather).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE = join(ROOT, "design", "tweakcn-theme.json");
const OUT_FILE = join(ROOT, "src", "client", "ui", "themeTokens.ts");
const REM_PX = 16;

// ---------------------------------------------------------------- colour tokens

/** shadcn colour tokens, in output order; `fallback` is used when a theme omits the token */
const COLOR_TOKENS = [
	["background"],
	["foreground"],
	["card", "background"],
	["card-foreground", "foreground"],
	["popover", "card"],
	["popover-foreground", "card-foreground"],
	["primary"],
	["primary-foreground", "background"],
	["secondary", "muted"],
	["secondary-foreground", "foreground"],
	["muted", "secondary"],
	["muted-foreground", "foreground"],
	["accent", "secondary"],
	["accent-foreground", "foreground"],
	["destructive"],
	["destructive-foreground", "#ffffff"],
	["border"],
	["input", "border"],
	["ring", "primary"],
	["chart-1", "primary"],
	["chart-2", "primary"],
	["chart-3", "primary"],
	["chart-4", "primary"],
	["chart-5", "primary"],
	// Project Z extensions (not shadcn): tweakcn does not know them, so a theme downloaded from it falls back to
	// the token on the right and nothing breaks -- the window kit just loses the exact shade (docs/DESIGN_RULES UI-07)
	/** the ACTIVE tab / segment / selected tile: a blue plate under light text */
	["tab-active", "chart-2"],
	/** the value cell of a settings row, one step lighter than the label cell (sidebar-accent) */
	["cell", "sidebar-accent"],
	/** the body of a modal window: one step lighter than the panels (sidebar), so the window stands off the page */
	["window", "sidebar"],
];

/** navigation (sidebar) tokens, emitted as a separate group; keys drop the "sidebar-" prefix */
const SIDEBAR_TOKENS = [
	["sidebar", "card"],
	["sidebar-foreground", "card-foreground"],
	["sidebar-primary", "primary"],
	["sidebar-primary-foreground", "primary-foreground"],
	["sidebar-accent", "accent"],
	["sidebar-accent-foreground", "accent-foreground"],
	["sidebar-border", "border"],
	["sidebar-ring", "ring"],
];

const ALL_TOKENS = [...COLOR_TOKENS, ...SIDEBAR_TOKENS];

function sidebarKey(token) {
	return token === "sidebar" ? "background" : camel(token.replace(/^sidebar-/, ""));
}

function camel(token) {
	return token.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// ---------------------------------------------------------------- colour parsing / conversion

const clamp01 = v => Math.min(1, Math.max(0, v));

/** linear-light sRGB -> gamma-encoded sRGB */
function gammaEncode(x) {
	return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** OKLab -> linear sRGB (Björn Ottosson's reference matrices) */
function oklabToLinearSrgb(L, a, b) {
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.291485548 * b;
	const l = l_ * l_ * l_;
	const m = m_ * m_ * m_;
	const s = s_ * s_ * s_;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
}

function parseNumber(token, percentScale = 1) {
	const t = token.trim();
	if (t === "none") return 0;
	if (t.endsWith("%")) return (parseFloat(t) / 100) * percentScale;
	if (t.endsWith("deg")) return parseFloat(t);
	return parseFloat(t);
}

/** splits "a b c / d" or "a, b, c, d" into [components, alpha] */
function splitArgs(inner) {
	const [main, alphaPart] = inner.split("/");
	const parts = main
		.replace(/,/g, " ")
		.split(/\s+/)
		.filter(p => p !== "");
	let alpha = 1;
	if (alphaPart !== undefined) alpha = parseNumber(alphaPart, 1);
	else if (parts.length === 4) alpha = parseNumber(parts.pop(), 1);
	return [parts, clamp01(alpha)];
}

function hslToRgb(h, s, l) {
	const k = n => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [f(0), f(8), f(4)];
}

/** any CSS colour used by tweakcn -> { rgb: [r, g, b] (0..1, gamma-encoded), alpha } */
function parseColor(value) {
	const v = value.trim().toLowerCase();
	let m = v.match(/^oklch\((.*)\)$/);
	if (m) {
		const [[l, c, h], alpha] = splitArgs(m[1]);
		const L = parseNumber(l, 1);
		const C = parseNumber(c, 0.4);
		const H = (parseNumber(h, 1) * Math.PI) / 180;
		const lin = oklabToLinearSrgb(L, C * Math.cos(H), C * Math.sin(H));
		return { rgb: lin.map(x => clamp01(gammaEncode(x))), alpha };
	}
	m = v.match(/^oklab\((.*)\)$/);
	if (m) {
		const [[l, a, b], alpha] = splitArgs(m[1]);
		const lin = oklabToLinearSrgb(parseNumber(l, 1), parseNumber(a, 0.4), parseNumber(b, 0.4));
		return { rgb: lin.map(x => clamp01(gammaEncode(x))), alpha };
	}
	m = v.match(/^hsla?\((.*)\)$/);
	if (m) {
		const [[h, s, l], alpha] = splitArgs(m[1]);
		return { rgb: hslToRgb(parseNumber(h), parseNumber(s, 1), parseNumber(l, 1)).map(clamp01), alpha };
	}
	m = v.match(/^rgba?\((.*)\)$/);
	if (m) {
		const [[r, g, b], alpha] = splitArgs(m[1]);
		return { rgb: [r, g, b].map(x => clamp01(parseNumber(x, 255) / 255)), alpha };
	}
	m = v.match(/^#([0-9a-f]{3,8})$/);
	if (m) {
		let hex = m[1];
		if (hex.length === 3 || hex.length === 4) hex = [...hex].map(ch => ch + ch).join("");
		const n = i => parseInt(hex.slice(i, i + 2), 16) / 255;
		return { rgb: [n(0), n(2), n(4)], alpha: hex.length === 8 ? n(6) : 1 };
	}
	// bare shadcn v3 HSL triplet ("0 0% 100%")
	m = v.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
	if (m) return { rgb: hslToRgb(+m[1], +m[2] / 100, +m[3] / 100), alpha: 1 };
	throw new Error(`unsupported colour: "${value}"`);
}

const to255 = rgb => rgb.map(x => Math.round(clamp01(x) * 255));
const hexOf = rgb =>
	"#" +
	to255(rgb)
		.map(x => x.toString(16).padStart(2, "0"))
		.join("");

// ---------------------------------------------------------------- sizes

/** "0.25rem" / "4px" / "0.5em" -> px */
function toPx(value, fallbackPx) {
	if (value === undefined) return fallbackPx;
	const v = String(value).trim();
	const n = parseFloat(v);
	if (Number.isNaN(n)) return fallbackPx;
	if (v.endsWith("rem") || v.endsWith("em")) return n * REM_PX;
	return n;
}

const round2 = n => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- fonts

const FAMILY = name => `rbxasset://fonts/families/${name}.json`;

/**
 * Google/web font -> closest Roblox built-in family. `mono` is the monospace sibling used when a proportional font
 * is chosen for font-mono (e.g. Geist -> Geist Mono -> BuilderMono). Add entries here to support more fonts.
 */
const FONT_MAP = {
	geist: { family: "BuilderSans", mono: "BuilderMono" },
	"geist mono": { family: "BuilderMono" },
	inter: { family: "BuilderSans", mono: "BuilderMono" },
	"plus jakarta sans": { family: "BuilderSans", mono: "BuilderMono" },
	"dm sans": { family: "BuilderSans", mono: "BuilderMono" },
	figtree: { family: "BuilderSans", mono: "BuilderMono" },
	manrope: { family: "BuilderSans", mono: "BuilderMono" },
	outfit: { family: "BuilderSans", mono: "BuilderMono" },
	"instrument sans": { family: "BuilderSans", mono: "BuilderMono" },
	"space grotesk": { family: "BuilderSans", mono: "BuilderMono" },
	poppins: { family: "Montserrat", mono: "BuilderMono" },
	montserrat: { family: "Montserrat", mono: "BuilderMono" },
	"open sans": { family: "SourceSansPro", mono: "BuilderMono" },
	lato: { family: "SourceSansPro", mono: "BuilderMono" },
	"source sans pro": { family: "SourceSansPro", mono: "BuilderMono" },
	"source sans 3": { family: "SourceSansPro", mono: "BuilderMono" },
	nunito: { family: "Nunito", mono: "BuilderMono" },
	"nunito sans": { family: "Nunito", mono: "BuilderMono" },
	roboto: { family: "Roboto", mono: "RobotoMono" },
	"roboto condensed": { family: "RobotoCondensed", mono: "RobotoMono" },
	"roboto mono": { family: "RobotoMono" },
	ubuntu: { family: "Ubuntu", mono: "BuilderMono" },
	"ubuntu mono": { family: "BuilderMono" },
	oswald: { family: "Oswald", mono: "BuilderMono" },
	"titillium web": { family: "TitilliumWeb", mono: "BuilderMono" },
	"josefin sans": { family: "JosefinSans", mono: "BuilderMono" },
	arimo: { family: "Arimo", mono: "BuilderMono" },
	arial: { family: "Arimo", mono: "BuilderMono" },
	jura: { family: "Jura", mono: "BuilderMono" },
	michroma: { family: "Michroma", mono: "BuilderMono" },
	"fredoka one": { family: "FredokaOne", mono: "BuilderMono" },
	fredoka: { family: "FredokaOne", mono: "BuilderMono" },
	bangers: { family: "Bangers", mono: "BuilderMono" },
	creepster: { family: "Creepster", mono: "BuilderMono" },
	"luckiest guy": { family: "LuckiestGuy", mono: "BuilderMono" },
	"permanent marker": { family: "PermanentMarker", mono: "BuilderMono" },
	"special elite": { family: "SpecialElite", mono: "BuilderMono" },
	"press start 2p": { family: "PressStart2P", mono: "PressStart2P" },
	"amatic sc": { family: "AmaticSC", mono: "BuilderMono" },
	"indie flower": { family: "IndieFlower", mono: "BuilderMono" },
	"patrick hand": { family: "PatrickHand", mono: "BuilderMono" },
	kalam: { family: "Kalam", mono: "BuilderMono" },
	"denk one": { family: "DenkOne", mono: "BuilderMono" },
	inconsolata: { family: "Inconsolata" },
	"jetbrains mono": { family: "BuilderMono" },
	"fira code": { family: "BuilderMono" },
	"ibm plex mono": { family: "BuilderMono" },
	"source code pro": { family: "BuilderMono" },
	"space mono": { family: "BuilderMono" },
	"dm mono": { family: "BuilderMono" },
	menlo: { family: "BuilderMono" },
	monospace: { family: "BuilderMono" },
	"ui-monospace": { family: "BuilderMono" },
	merriweather: { family: "Merriweather", mono: "BuilderMono" },
	georgia: { family: "Merriweather", mono: "BuilderMono" },
	lora: { family: "Merriweather", mono: "BuilderMono" },
	"playfair display": { family: "Merriweather", mono: "BuilderMono" },
	"libre baskerville": { family: "Merriweather", mono: "BuilderMono" },
	"source serif 4": { family: "Merriweather", mono: "BuilderMono" },
	serif: { family: "Merriweather", mono: "BuilderMono" },
	"ui-serif": { family: "Merriweather", mono: "BuilderMono" },
};

const MONO_FAMILIES = new Set(["BuilderMono", "RobotoMono", "Inconsolata", "PressStart2P"]);
const SLOT_FALLBACK = { sans: "BuilderSans", mono: "BuilderMono", serif: "Merriweather" };

function firstFamily(stack) {
	if (typeof stack !== "string") return undefined;
	const first = stack
		.split(",")[0]
		.trim()
		.replace(/^["']|["']$/g, "");
	return first === "" ? undefined : first;
}

/** returns [roblox family, human-readable note] for a theme font slot */
function mapFont(slot, stack) {
	const web = firstFamily(stack);
	if (web === undefined) return [SLOT_FALLBACK[slot], `font-${slot}: (unset) -> ${SLOT_FALLBACK[slot]}`];
	const entry = FONT_MAP[web.toLowerCase()];
	if (entry === undefined) {
		return [SLOT_FALLBACK[slot], `font-${slot}: ${web} (no Roblox match) -> ${SLOT_FALLBACK[slot]}`];
	}
	if (slot === "mono" && !MONO_FAMILIES.has(entry.family)) {
		const mono = entry.mono ?? SLOT_FALLBACK.mono;
		return [mono, `font-mono: ${web} is proportional -> its monospace sibling ${mono}`];
	}
	return [entry.family, `font-${slot}: ${web} -> ${entry.family}`];
}

// ---------------------------------------------------------------- source loading

async function loadSource(arg) {
	if (arg !== undefined && /^https?:\/\//i.test(arg)) {
		const res = await fetch(arg, { headers: { accept: "application/json" } });
		if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${res.statusText} (${arg})`);
		const json = await res.json();
		mkdirSync(dirname(DEFAULT_SOURCE), { recursive: true });
		writeFileSync(DEFAULT_SOURCE, JSON.stringify(json, null, "\t") + "\n");
		const saved = relative(ROOT, DEFAULT_SOURCE).replace(/\\/g, "/");
		console.log(`downloaded ${arg} -> ${saved}`);
		return { json, label: `${saved} (downloaded from ${arg})` };
	}
	const path = arg !== undefined ? resolve(process.cwd(), arg) : DEFAULT_SOURCE;
	return { json: JSON.parse(readFileSync(path, "utf8")), label: relative(ROOT, path).replace(/\\/g, "/") };
}

// ---------------------------------------------------------------- generation

function resolveMode(vars, shared, modeName, tokens, keyOf) {
	const raw = new Map();
	for (const [token] of ALL_TOKENS) {
		const value = vars?.[token] ?? shared?.[token];
		if (value !== undefined) raw.set(token, value);
	}
	const resolveToken = (token, seen = new Set()) => {
		if (raw.has(token)) return { source: raw.get(token), color: parseColor(raw.get(token)) };
		const spec = ALL_TOKENS.find(([t]) => t === token);
		const fallback = spec?.[1];
		if (fallback === undefined || seen.has(token)) {
			throw new Error(`theme mode "${modeName}" has no "${token}" colour`);
		}
		seen.add(token);
		if (fallback.startsWith("#")) return { source: `${fallback} (default)`, color: parseColor(fallback) };
		const r = resolveToken(fallback, seen);
		return { source: `var(--${fallback})`, color: r.color };
	};
	const bg = resolveToken("background").color.rgb;
	const out = [];
	for (const [token] of tokens) {
		const { source, color } = resolveToken(token);
		let rgb = color.rgb;
		if (color.alpha < 1) rgb = rgb.map((c, i) => c * color.alpha + bg[i] * (1 - color.alpha));
		out.push({ key: keyOf(token), token, source, rgb, alpha: color.alpha });
	}
	return out;
}

function colorBlock(name, type, doc, entries) {
	const lines = [`/** ${doc} */`, `export const ${name}: ${type} = {`];
	for (const e of entries) {
		const [r, g, b] = to255(e.rgb);
		const flat = e.alpha < 1 ? ` (alpha ${round2(e.alpha)} flattened over background)` : "";
		lines.push(`\t/** ${e.token}: ${e.source} ${hexOf(e.rgb)}${flat} */`);
		lines.push(`\t${e.key}: Color3.fromRGB(${r}, ${g}, ${b}),`);
	}
	lines.push("};");
	return lines.join("\n");
}

async function main() {
	const { json, label } = await loadSource(process.argv[2]);
	const vars = json.cssVars ?? json;
	const shared = vars.theme ?? {};
	const light = vars.light ?? {};
	const dark = vars.dark ?? vars.light ?? {};

	const darkColors = resolveMode(dark, shared, "dark", COLOR_TOKENS, camel);
	const lightColors = resolveMode(light, shared, "light", COLOR_TOKENS, camel);
	const darkSidebar = resolveMode(dark, shared, "dark", SIDEBAR_TOKENS, sidebarKey);
	const lightSidebar = resolveMode(light, shared, "light", SIDEBAR_TOKENS, sidebarKey);

	const radiusSrc = shared.radius ?? dark.radius ?? light.radius;
	const spacingSrc = shared.spacing ?? dark.spacing ?? light.spacing;
	const trackingSrc = shared["letter-spacing"] ?? dark["letter-spacing"] ?? light["letter-spacing"];
	const shadowSrc = dark["shadow-opacity"] ?? shared["shadow-opacity"] ?? light["shadow-opacity"];
	const radius = round2(toPx(radiusSrc, 10));
	const spacing = round2(toPx(spacingSrc, 4));
	const trackingEm = round2(parseFloat(trackingSrc ?? "0") || 0);
	const shadowOpacity = round2(parseFloat(shadowSrc ?? "0.1") || 0);

	const fonts = {};
	for (const slot of ["sans", "mono", "serif"]) {
		const stack = shared[`font-${slot}`] ?? dark[`font-${slot}`] ?? light[`font-${slot}`];
		fonts[slot] = mapFont(slot, stack);
	}

	const name = typeof json.name === "string" ? json.name : "theme";
	const iface = COLOR_TOKENS.map(([token]) => `\t${camel(token)}: Color3;`).join("\n");
	const sidebarIface = SIDEBAR_TOKENS.map(([token]) => `\t/** --${token} */\n\t${sidebarKey(token)}: Color3;`).join(
		"\n",
	);
	const out = `// generated by tools/gen-theme.mjs — do not edit
// source: ${label} ("${name}")
// regenerate: \`npm run theme\` (or \`npm run theme -- <tweakcn registry url>\`)
// semantic roles, game colours and typography live in theme.ts

/** shadcn colour tokens + the Project Z extensions tab-active / cell / window (CSS --kebab-case -> camelCase) */
export interface ThemeColors {
${iface}
}

export const THEME_NAME = ${JSON.stringify(name)};

${colorBlock("DARK", "ThemeColors", ".dark tokens (the game UI uses this mode)", darkColors)}

${colorBlock("LIGHT", "ThemeColors", ":root (light) tokens", lightColors)}

/** sidebar (navigation) tokens: --sidebar-* without the prefix */
export interface SidebarColors {
${sidebarIface}
}

${colorBlock("DARK_SIDEBAR", "SidebarColors", ".dark sidebar tokens (navigation rails)", darkSidebar)}

${colorBlock("LIGHT_SIDEBAR", "SidebarColors", ":root (light) sidebar tokens", lightSidebar)}

/** --radius: ${radiusSrc ?? "(unset)"} -> px (design units of the 1120x630 layout) */
export const RADIUS_PX = ${radius};
/** --spacing: ${spacingSrc ?? "(unset)"} -> px; Tailwind step unit (p-4 = 4 x SPACING_PX) */
export const SPACING_PX = ${spacing};
/** --letter-spacing: ${trackingSrc ?? "(unset)"}; informational: Roblox text has no tracking */
export const LETTER_SPACING_EM = ${trackingEm};
/** --shadow-opacity: ${shadowSrc ?? "(unset)"}; the kit draws no shadows when this is 0 (flat, border-separated) */
export const SHADOW_OPACITY = ${shadowOpacity};

/** Roblox font families (use with Font.new(family, weight)) */
export const FONT_FAMILIES = {
	/** ${fonts.sans[1]} */
	sans: "${FAMILY(fonts.sans[0])}",
	/** ${fonts.mono[1]} */
	mono: "${FAMILY(fonts.mono[0])}",
	/** ${fonts.serif[1]} */
	serif: "${FAMILY(fonts.serif[0])}",
};
`;
	writeFileSync(OUT_FILE, out);
	console.log(`wrote ${relative(ROOT, OUT_FILE)} from ${label}`);
	const summary = [...darkColors, ...darkSidebar].map(e => `${e.token}=${hexOf(e.rgb)}`).join("  ");
	console.log(`dark: ${summary}`);
	const families = Object.values(fonts)
		.map(f => f[0])
		.join(" / ");
	console.log(`radius ${radius}px · spacing ${spacing}px · shadows ${shadowOpacity} · fonts ${families}`);
}

main().catch(err => {
	console.error(`gen-theme: ${err instanceof Error ? err.message : err}`);
	process.exit(1);
});
