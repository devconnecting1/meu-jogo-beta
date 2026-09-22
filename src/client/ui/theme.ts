/*
 * Project Z design system: the single source of truth for colour, type, radius and spacing in the UI.
 *
 * Raw tokens come from the author's tweakcn theme ("Meu tema global"), generated into themeTokens.ts by
 * `npm run theme`. This file maps them to roles:
 * - THEME: shadcn semantic roles, dark mode (olive neutrals fit the zombie / military mood)
 * - SIDEBAR: the neutral navigation palette (category rails of the backpack, shop and settings)
 * - GAME: game meanings of the chart palette (HP, food, XP, heal, boss/rare, materials, coins)
 * - spacing (space(n) = n x 4), radius (4), borders, typography roles (TYPE) and fonts
 *
 * Colour rule: every colour written to a GuiObject / UIStroke / ImageLabel is EXACTLY one of these tokens (no Lerp,
 * no tints, no literals). Relief (highlights and shadows) comes from GREYSCALE + ALPHA skin textures tinted with
 * ImageColor3 = a token (see skin.ts), never from mixed colours. Transparency is only used where the UI sits over
 * the game world (TRANSPARENCY, documented below) and for enter/exit fades.
 *
 * CHANGE (Pixel Quest relief skin): the author moved the game's "primary" role from the near-white `foreground`
 * to chart-1 (#2E8B57, green), with `foreground` (#FFFFE3) as its text colour. The one main action of a screen
 * (Play / Continue, Equip, Use, Craft, Buy, Confirm) is now the green relief button of the reference art;
 * `secondary` (#606055) keeps every other action and the active tab, `destructive` (#EF4444) the dangerous ones
 * and Close. The neutral sidebar tokens became the surface palette (SURFACE below): panels, frames, strips and
 * the recessed "wells" that hold lists and bars.
 *
 * Role map (author's spec):
 * - background / foreground: full-screen pages (lobby, shop, settings, credits) and default text
 * - card (+ border, radius): panels and windows (survivor card, backpack, shop cards, pause, game over, HUD)
 * - popover (+ border): dialogs, tutorial, toasts, tooltips, nameplate, round banners
 * - primary (chart-1 green): the ONE main action of a screen; secondary: other actions (menu tiles, Back) and the
 *   active tab; destructive: dangerous actions and the Close (X) buttons
 * - accent: states only (hover / pressed of outline, ghost and inactive tabs; the selected list row);
 *   text on accent is SemiBold / Bold and >= 14 (contrast ~3.4:1)
 * - muted-foreground: secondary text (captions, counts, descriptions) and disabled controls
 * - destructive: dangerous actions, errors, HP, damage vignette
 * - border: outlines and separators; input: slider / progress tracks; ring: 2 px focus outline (gamepad / keys)
 *
 * All sizes are design units of the 1120 x 630 layout (see widgets.ts), i.e. "CSS px" before the UI scale.
 */
import {
	DARK,
	DARK_SIDEBAR,
	FONT_FAMILIES,
	RADIUS_PX,
	SHADOW_OPACITY,
	SPACING_PX,
	SidebarColors,
	ThemeColors,
} from "./themeTokens";

/** active mode: swap for LIGHT / LIGHT_SIDEBAR (from themeTokens) to preview the light palette */
const TOKENS: ThemeColors = DARK;
const SIDEBAR_TOKENS: SidebarColors = DARK_SIDEBAR;

// ---------------------------------------------------------------- semantic roles (shadcn)

export const THEME = {
	background: TOKENS.background,
	foreground: TOKENS.foreground,
	card: TOKENS.card,
	cardForeground: TOKENS.cardForeground,
	popover: TOKENS.popover,
	popoverForeground: TOKENS.popoverForeground,
	/** primary = chart-1 (#2E8B57): the main action of a screen, drawn as a green relief button */
	primary: TOKENS.chart1,
	/** text on `primary`: foreground (#FFFFE3) with the dark contour of the skin (see skin.ts) */
	primaryForeground: TOKENS.foreground,
	secondary: TOKENS.secondary,
	secondaryForeground: TOKENS.secondaryForeground,
	muted: TOKENS.muted,
	mutedForeground: TOKENS.mutedForeground,
	accent: TOKENS.accent,
	accentForeground: TOKENS.accentForeground,
	destructive: TOKENS.destructive,
	destructiveForeground: TOKENS.destructiveForeground,
	border: TOKENS.border,
	input: TOKENS.input,
	ring: TOKENS.ring,
};

/** navigation rails: item = foreground, hover = sidebar-accent, selected = the raised `secondary` relief */
export const SIDEBAR = SIDEBAR_TOKENS;

/**
 * Surface palette of the relief skin (the neutral sidebar tokens). Every window is a `panel` of `frame`d
 * plates; what holds content (lists, rows, tracks, inactive tabs) is a `well` sunk into it, outlined in `line`.
 */
export const SURFACE = {
	/** panel interior (#1A1A1A) */
	panel: SIDEBAR_TOKENS.background,
	/** thick panel frame and title strips (#303030); also the hover fill of recessed controls */
	frame: SIDEBAR_TOKENS.accent,
	/** outline of a well, of an inactive tab and of a list row (#404040) */
	line: SIDEBAR_TOKENS.border,
	/** the recessed fill itself: the darkest token (#10100E) */
	well: TOKENS.background,
};

/**
 * Transparency presets (Roblox transparency = 1 - CSS alpha). Used ONLY where the UI sits over the game world,
 * plus enter / exit fades of transient elements (toasts, banners, feed lines); colours themselves are never mixed.
 */
export const TRANSPARENCY = {
	/** modal scrim (Dialog, pause, backpack): background at 80% over the world */
	overlay: 0.2,
	/** HUD cards / popovers drawn over the world: background at 85% */
	hud: 0.15,
	/** the player's nameplate: background at 75%, lighter than the HUD so it never hides the character */
	nameplate: 0.25,
	/** touch controls drawn over the world (thumbs must still see the map): joystick base idle / dragging */
	touchIdle: 0.85,
	touchActive: 0.7,
	/** joystick knob and the outline of the touch controls */
	touchKnob: 0.45,
	touchStroke: 0.6,
	/** FIRE button idle / held */
	fireIdle: 0.45,
	fireHeld: 0.2,
	/** shadows are part of the tweakcn theme; 0 opacity = the kit draws none (flat, border-separated look) */
	shadow: 1 - SHADOW_OPACITY,
};

// ---------------------------------------------------------------- game colours (from the chart palette)

export const GAME = {
	/** health: destructive */
	hp: TOKENS.destructive,
	/** hunger / food: chart-3 */
	food: TOKENS.chart3,
	/** experience / level (HUD bar, nameplate badge): chart-2 */
	xp: TOKENS.chart2,
	/** heal, success, "ready", equipped: chart-1 */
	success: TOKENS.chart1,
	/** rare items, bosses: chart-4 */
	rare: TOKENS.chart4,
	/** coin icon: chart-3 (coin amounts are written in foreground) */
	coin: TOKENS.chart3,
	/** neutral information (info toasts, night): chart-2 */
	info: TOKENS.chart2,
	/** attention without danger (craft desk nearby, sun): chart-3 */
	warning: TOKENS.chart3,
	/** materials / wood and misc items: chart-5 */
	material: TOKENS.chart5,
	/** day / night indicator */
	sun: TOKENS.chart3,
	moon: TOKENS.chart2,
	/** the "Z" of the logo */
	brand: TOKENS.destructive,
	/** damage vignette: destructive */
	blood: TOKENS.destructive,
	/** outline that keeps banner text readable over the world */
	textOutline: TOKENS.background,
};

// ---------------------------------------------------------------- spacing & radius

/** Tailwind spacing step (--spacing) */
export const SPACING = SPACING_PX;

/** space(4) = 16: the Tailwind scale (p-4, gap-2...) in design units */
export function space(n: number): number {
	return n * SPACING_PX;
}

/** shadcn radius scale derived from --radius (sm = r-4, md = r-2, lg = r, xl = r+4) */
export const RADIUS = {
	none: 0,
	sm: math.max(RADIUS_PX - 4, 0),
	md: math.max(RADIUS_PX - 2, 0),
	lg: RADIUS_PX,
	xl: RADIUS_PX + 4,
	full: 9999,
};

/** border and focus-ring widths (px at 1x; scaled to stay visible on large screens) */
export const BORDER = {
	width: 1,
	ring: 2,
};

// ---------------------------------------------------------------- typography

/** Tailwind text sizes (design units) */
export const TEXT = {
	xs: 12,
	sm: 14,
	base: 16,
	lg: 18,
	xl: 20,
	xl2: 24,
	xl3: 30,
	xl4: 36,
	xl5: 48,
	xl6: 60,
};

export const FONT_FAMILY = FONT_FAMILIES;

export type FontFamilyKey = "sans" | "mono";

export type TextRole = "display" | "title" | "heading" | "body" | "label" | "caption" | "numeric";

export interface TextStyle {
	size: number;
	weight: Enum.FontWeight;
	family: FontFamilyKey;
}

/**
 * Typography roles. BuilderSans Regular / Medium / Bold / ExtraBold ship with the client (instant); SemiBold is
 * streamed on first use. BuilderMono has Light / Regular / Bold only.
 */
export const TYPE: Record<TextRole, TextStyle> = {
	/** logo, round banners */
	display: { size: TEXT.xl5, weight: Enum.FontWeight.ExtraBold, family: "sans" },
	/** screen titles (h1) */
	title: { size: TEXT.xl3, weight: Enum.FontWeight.Bold, family: "sans" },
	/** card / dialog titles (CardTitle: font-semibold) */
	heading: { size: TEXT.xl, weight: Enum.FontWeight.SemiBold, family: "sans" },
	/** paragraphs */
	body: { size: TEXT.base, weight: Enum.FontWeight.Regular, family: "sans" },
	/** buttons, tabs, nav items, form labels: SemiBold so it stays legible on `accent` (hover) backgrounds */
	label: { size: TEXT.sm, weight: Enum.FontWeight.SemiBold, family: "sans" },
	/** descriptions, hints (CardDescription: text-sm text-muted-foreground) */
	caption: { size: TEXT.xs, weight: Enum.FontWeight.Regular, family: "sans" },
	/** counters, ammo, timers: tabular digits */
	numeric: { size: TEXT.base, weight: Enum.FontWeight.Bold, family: "mono" },
};

const fontCache = new Map<string, Font>();

/** Font for a family + weight (cached; Font values are immutable) */
export function fontOf(family: FontFamilyKey, weight: Enum.FontWeight): Font {
	const key = `${family}:${weight.Name}`;
	let f = fontCache.get(key);
	if (f === undefined) {
		f = new Font(FONT_FAMILY[family], weight);
		fontCache.set(key, f);
	}
	return f;
}

/** Font of a typography role */
export function roleFont(role: TextRole): Font {
	const t = TYPE[role];
	return fontOf(t.family, t.weight);
}

/** "#rrggbb" of a theme colour, for RichText <font color> tags */
export function hex(c: Color3): string {
	return `#${c.ToHex()}`;
}
