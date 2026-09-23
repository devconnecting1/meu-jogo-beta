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
 * ImageColor3 = a token (see skin.ts). One honest exception, which the audit raised (docs/research/ui.md 5.3):
 * ImageColor3 MULTIPLIES, and those texels are grey, not white, so what a skinned surface finally renders is the
 * token darkened by the texture. The token is still the only colour anyone writes, but a measured contrast ratio
 * between two tokens is an UPPER bound for a skinned surface, exact for the flat fallback.
 * Transparency is only used where the UI sits over the game world (TRANSPARENCY, documented below) and for
 * enter/exit fades.
 *
 * PALETTE ("mixed"): near-black body, cold-iron relief. The world is already grey -- asphalt, concrete -- so a
 * mid-grey panel over a mid-grey street disappears and only its outline holds the reading. The body therefore
 * stays almost black (`background` #0E0F11) and separates by darkness, while the RELIEF is cold iron
 * (`border` / `input` / `secondary` #7A8591): a pixel bevel is a stamped metal plate, and a stamped plate is
 * cold, which the old warm olive (#606055 over #10100E) never was.
 *
 * Labels on plates (DESIGN_RULES UI-04 / UI-05, the owner's rules):
 * - text never carries a contour -- no UIStroke on text, no TextStroke. It reads as ugly, full stop;
 * - a label on a plate is ALWAYS the light `foreground` (#F9FBFE), never the near-black body colour. Dark
 *   letters on the iron plates were tried and read as disabled buttons;
 * - so the PLATE carries the contrast. Button titles (large, SemiBold/Bold) need 3:1 against it; small text on
 *   a plate (the "Day 1" under PLAY, the subtitles of the menu tiles, key legends) needs 4,5:1. Where the
 *   owner's plate colour did not reach that, the plate was darkened by the smallest step that does, hue and
 *   chroma unchanged:
 *     secondary (iron)  #7A8591 -> #6A7581   3,62:1 -> 4,53:1   (border / input keep #7A8591: no text on them)
 *     primary (green)   #399560 -> #248350   3,59:1 -> 4,57:1   (chart-1 / GAME.success keep #399560: it is
 *                                                                  drawn AS text on the dark body and needs
 *                                                                  the lighter green there)
 *     destructive (red) #EF4444 unchanged    3,63:1             (carries titles only -- Close, Quit -- so 3:1)
 * Every ratio here is measured by `npm run test:contrast`, which reads this file's role map, so re-pointing a
 * role moves the test with it; the same test fails if a plate label stops being `foreground`.
 *
 * Role map:
 * - background / foreground: full-screen pages (lobby, shop, settings, credits) and default text
 * - card (+ border, radius): panels and windows (survivor card, backpack, shop cards, menu, game over, HUD)
 * - popover (+ border): dialogs, tutorial, toasts, tooltips, nameplate, round banners
 * - primary (the green): the ONE main action of a screen; secondary (iron): other actions (menu tiles, Back)
 *   and the active tab; destructive (red): dangerous actions and the Close (X) buttons. All three carry
 *   `*-foreground`, which is the light `foreground` (see "Labels on plates" above)
 * - accent: states only (hover / pressed of outline, ghost and inactive tabs; the selected list row).
 *   NOTE: the kit actually fills those states with SURFACE.frame (widgets.ts, `sunk`); `accent` is kept as the
 *   role's declared colour and is held to the same 4,5:1 against `accent-foreground` so adopting it is safe
 * - muted-foreground: secondary text (captions, counts, descriptions) and disabled controls
 * - destructive: dangerous actions, errors, HP, damage vignette. It stays bright BECAUSE it is also drawn as
 *   text (missing ingredients, error rows) and as the HP bar, which need it light against the dark body
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
	/** the main action of a screen, a green relief plate: one step darker than chart-1 so light text reads */
	primary: TOKENS.primary,
	/** the text on that plate: the light foreground, 4,57:1 (see "Labels on plates" above) */
	primaryForeground: TOKENS.primaryForeground,
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
	/** panel interior (#181A1D) */
	panel: SIDEBAR_TOKENS.background,
	/** thick panel frame and title strips (#3F464D); also the hover fill of recessed controls */
	frame: SIDEBAR_TOKENS.accent,
	/**
	 * face of a KEY (Keycap, the E-prompt Badge): the dark iron (#3F464D, 9,2:1 under `foreground`). Darker
	 * than every button plate on purpose -- a key legend is information, and must never look clickable.
	 */
	key: SIDEBAR_TOKENS.accent,
	/**
	 * Outline of a well, of an inactive tab and of a list row (#646D78). This one is iron and not a dark grey
	 * on purpose: at the old #404040 it measured 1,68:1 against the panel (docs/research/ui.md 6.4), i.e. the
	 * structure of every window was almost invisible. It now reads 3,3:1 over the panel and 3,7:1 over a well.
	 */
	line: SIDEBAR_TOKENS.border,
	/** the recessed fill itself: the darkest token (#0E0F11) */
	well: TOKENS.background,
};

/**
 * Transparency presets (Roblox transparency = 1 - CSS alpha). Used ONLY where the UI sits over the game world,
 * plus enter / exit fades of transient elements (toasts, banners, feed lines); colours themselves are never mixed.
 *
 * These are DESIGN values. What finally reaches the screen is `worldTransparency(value)` (skin.ts), which
 * multiplies them by GuiService.PreferredTransparency -- the player's "Background Transparency" setting, and
 * the multiplication the accessibility doc asks for. A player who set it to 0 gets an opaque HUD. Everything
 * drawn through paintSurface / makeFrame / makeScreen / addStroke already goes through it; a preset read
 * straight into `BackgroundTransparency` (the touch controls and the nameplate do this) does not.
 */
export const TRANSPARENCY = {
	/**
	 * modal scrim of a screen that is NOT over a running world (Dialog, popups, the lobby's "How to play"):
	 * background at 80%
	 */
	overlay: 0.2,
	/**
	 * DESIGN_RULES UI-06: the scrim of a screen opened OVER A RUN (Bag, menu, both end-of-run screens). No
	 * menu pauses the world, so this scrim only dims it -- background at 45% -- and the street, the horde
	 * closing in and an ally going down stay readable round the panel. The panels themselves stay OPAQUE: their
	 * text is held to 4,5:1 against the panel token (tools/test-contrast.mjs), and a panel the street shows
	 * through has no fixed colour to be measured against -- muted text over a sunlit sidewalk drops below 4,5:1
	 * before the panel is even 10% see-through. Where the panel hides the street, the red flash of
	 * client/ui/dangerFlash.ts is the warning.
	 */
	overWorld: 0.55,
	/**
	 * UI-06: peak of the red flash drawn above every menu when the survivor is hit with one open (the screen
	 * edge at its strongest, fading to nothing towards the centre, like the HUD's damage vignette). An effect,
	 * not a background: it is not scaled by the player's Background Transparency, which asks for solid panels
	 * and not for a solid red screen.
	 */
	alarm: 0.3,
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
