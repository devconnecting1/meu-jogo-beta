/*
 * Project Z design system: the single source of truth for colour, type, radius and spacing in the UI.
 *
 * Raw tokens come from the author's tweakcn theme ("Meu tema global"), generated into themeTokens.ts by
 * `npm run theme`. This file maps them to roles:
 * - THEME: shadcn semantic roles, dark mode (neutral greys and one steel-blue accent, see PALETTE)
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
 * PALETTE (owner, 2026-09-23, from the reference Wardrobe window: "clean, polished"): NEUTRAL greys with no hue,
 * in clear steps, and ONE accent. The slate-blue tint every grey used to carry (chroma 0,02 at hue 250), the
 * shadcn green main action and a saturated tab blue made three families that never matched -- the owner's "looks
 * AI-made". The steps, darkest first: `background` #141414 (wells, header band), `sidebar` #1A1A1A (panels,
 * grooves), `window` #262626 (a window's body), `sidebar-accent` #444444 (sections, keys, label cells), `cell`
 * #565656, `secondary` #727272 (the iron plate: inactive tab, other actions). The accent is the reference's
 * steel blue #597388, for what is chosen AND the main action. The world is already grey -- asphalt, concrete --
 * so the body stays dark and separates by darkness; the relief (plate.ts) is the light and dark washes.
 *
 * Labels on plates (DESIGN_RULES UI-04 / UI-05, the owner's rules):
 * - text never carries a contour -- no UIStroke on text, no TextStroke. It reads as ugly, full stop;
 * - a label on a plate is ALWAYS the light `foreground` (#FAFAFA), never the near-black body colour. Dark
 *   letters on the iron plates were tried and read as disabled buttons;
 * - so the PLATE carries the contrast. Button titles (large, SemiBold/Bold) need 3:1 against it; small text on
 *   a plate (the "Day 1" under PLAY, the subtitles of the menu tiles, key legends) needs 4,5:1. Where the
 *   reference's plate colour did not reach that, the plate was darkened by the smallest step that does:
 *     secondary (iron)   #767676 -> #727272   4,35:1 -> 4,6:1 under #FAFAFA (the reference's white is #FFFFFF)
 *     primary / tab-active (steel blue) #597388 as in the reference, 4,9:1
 *     destructive (red)  #EF4444, NOT the reference's X red #A71000: this token is also the HP bar, the damage
 *                        text and the penalty rows, which that dark red would drop under 3:1 on the dark body
 *   chart-1 / GAME.success (#399560) and chart-2 / GAME.xp (#4C88BB) are game colours drawn AS text on the dark
 *   body; they are not UI roles and did not move.
 * Every ratio here is measured by `npm run test:contrast`, which reads this file's role map, so re-pointing a
 * role moves the test with it; the same test fails if a plate label stops being `foreground`.
 *
 * Role map:
 * - background / foreground: full-screen pages (lobby, shop, settings, credits) and default text
 * - card (+ border, radius): panels and windows (survivor card, backpack, shop cards, menu, game over, HUD)
 * - popover (+ border): dialogs, tutorial, toasts, tooltips, round banners (the nameplate has no surface: OVER_WORLD)
 * - primary (the steel blue): the ONE main action of a screen; secondary (iron): other actions (menu tiles, Back)
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
	/** the main action of a screen: the steel-blue relief plate, the palette's one accent (4,9:1 under the light text) */
	primary: TOKENS.primary,
	/** the text on that plate: the light foreground, 4,9:1 (see "Labels on plates" above) */
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
	/**
	 * The ACTIVE tab, the chosen segment, the selected rail item and grid tile (UI-07): the reference's steel-blue
	 * plate (#597388, 4,9:1 under the light text, so small text on it also reads -- UI-05).
	 */
	tabActive: TOKENS.tabActive,
	/** the text on that plate: the light foreground (UI-05) */
	tabActiveForeground: TOKENS.foreground,
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
	/** thick panel frame and title strips (#444444); also the hover fill of recessed controls */
	frame: SIDEBAR_TOKENS.accent,
	/**
	 * face of a KEY (Keycap, the E-prompt Badge): the dark iron (#444444, 9,3:1 under `foreground`). Darker
	 * than every button plate on purpose -- a key legend is information, and must never look clickable.
	 */
	key: SIDEBAR_TOKENS.accent,
	/**
	 * Outline of a well, of an inactive tab and of a list row (#6B6B6B). This one is iron and not a dark grey
	 * on purpose: at the old #404040 it measured 1,68:1 against the panel (docs/research/ui.md 6.4), i.e. the
	 * structure of every window was almost invisible. It reads over 3:1 on the panel and on a well (test:contrast).
	 */
	line: SIDEBAR_TOKENS.border,
	/** the recessed fill itself: the darkest token (#141414) */
	well: TOKENS.background,

	// ---- the window vocabulary (DESIGN_RULES UI-07), from dark to light, the order of the reference art:
	/** header band of a window (title, "?", X): the body colour, a shade darker than the window under it */
	header: TOKENS.background,
	/**
	 * body of a modal window (#262626): graphite, one step LIGHTER than the panels, as in the reference -- it is
	 * what makes the thick frame and the tabs stand off the page. Only as light as `muted-foreground` allows
	 * (4,54:1 on it); the HUD and the other panels keep `panel`, whose game-colour texts need the darker fill.
	 */
	window: TOKENS.window,
	/** the list inside a section: the gaps between its rows are the grooves (#1A1A1A) */
	groove: SIDEBAR_TOKENS.background,
	/** the SECTION plate of a window ("Keybinds"), lighter than the window body (#444444, 1,55:1 over the window) */
	section: SIDEBAR_TOKENS.accent,
	/** label cell of a settings row: the darker, left side, with the label centred in it (#444444) */
	cellLabel: SIDEBAR_TOKENS.accent,
	/** value cell of a settings row: one step lighter (#565656, over 1,3:1 on the label cell, like the reference) */
	cell: TOKENS.cell,
	/**
	 * the one-line description under a row's label, IN the label cell (the form row of window.ts, UI-07): #B1B1B1, the
	 * least step lighter than `muted-foreground` that reads at 4,5:1 on the label cell (muted itself is 3,55:1 there)
	 */
	cellCaption: TOKENS.cellMutedForeground,
	/**
	 * a row of a selectable list whose TEXT is the content -- the wardrobe's titles, drawn in their game colours
	 * (MON-05): the window's graphite (#262626), the lightest face those colours still read on at 4,5:1. A LOCKED row
	 * is `well`, a step darker.
	 */
	row: TOKENS.window,
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
	 * DESIGN_RULES UI-10: the scrim of the menus' town flyover (client/view/townFlyover.ts) -- the page colour at 60%
	 * over the drifting town, so the world shows at 40% at most. That ceiling is a contrast bound, not a taste: the
	 * brightest thing the town can put behind the scrim is white (a zebra, a rooftop plate), and at 40% the
	 * composite still holds `foreground` at 4,5:1 (tools/test-contrast.mjs measures it). That is what lets the lobby's
	 * title and tagline stand straight on it, in `foreground`; every other colour sits on a plate, a section or a
	 * window (test:lobby checks it).
	 */
	backdrop: 0.4,
	/**
	 * UI-06: peak of the red flash drawn above every menu when the survivor is hit with one open (the screen
	 * edge at its strongest, fading to nothing towards the centre, like the HUD's damage vignette). An effect,
	 * not a background: it is not scaled by the player's Background Transparency, which asks for solid panels
	 * and not for a solid red screen.
	 */
	alarm: 0.3,
	/** HUD cards / popovers drawn over the world: background at 85% */
	hud: 0.15,
	/**
	 * a thin gauge drawn over the world: the ally's HP / bleed-out track, between their body and their name
	 * (client/view/allyPlate.ts), background at 75%. (The nameplate itself has NO background any more: see OVER_WORLD
	 * and textShadow below.)
	 */
	nameplate: 0.25,
	/**
	 * UI-04 (clarification): the pixel drop shadow of text drawn straight over the WORLD (skin.ts textShadow), 85%
	 * opaque: the lightest step at which every voice of the nameplate still reads at 4,5:1 against its own shadow even
	 * where that shadow lies on pure white (`npm run test:world-art` section 8). At 80% the orange of [Horde Breaker]
	 * would fall to 4,09:1 there; at 85% it is 4,90:1 (5,39:1 on the town's brightest real ground, a zebra stripe).
	 */
	textShadow: 0.15,
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
	/** experience / level (the XP colour; over the world the nameplate writes it lighter, OVER_WORLD.level): chart-2 */
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

/**
 * The item card's voices (client/ui/itemCard.ts, DESIGN_RULES UI-08, the owner's reference windows): what the card
 * measures in yellow, what an item gives in green, a status effect in orange, and what it costs you in the red of
 * damage. All four are TEXT on the card's panel (SURFACE.panel), held to 4,5:1 there by `npm run test:contrast`:
 * the yellow 12,2:1, the green 8,7:1, the orange 7,2:1, the red 4,6:1. The green and the orange are chart-1's and
 * chart-3's hues made lighter -- those two measure 4,7:1 / 4,8:1 on the panel, too close to the floor for small
 * numbers -- and the yellow is new: the palette had none (LEG-02's yellow is electricity IN THE WORLD, not a UI
 * colour).
 */
export const STAT = {
	/** numbers: damage, cooldown, range, magazine, recipes... */
	value: TOKENS.statValue,
	/** what the item adds: health, hunger, defense, speed */
	bonus: TOKENS.statBonus,
	/** a status effect and how long it lasts: speed boost, steady aim, pain relief */
	effect: TOKENS.statEffect,
	/** what the item takes away: rotten meat's health, heavy armour's speed */
	penalty: TOKENS.destructive,
};

/**
 * Text drawn straight over the WORLD, where no plate may go: the nameplate under a survivor (client/ui/nameplate.ts).
 * DESIGN_RULES UI-04 (clarification, 2026-09-23): the owner asked for the name, level and title with nothing behind
 * them, and text never carries a contour -- so each line lands on the ground with the kit's pixel DROP SHADOW (skin.ts
 * `textShadow`): a copy in `shadow`, one skin pixel down and to the right, at TRANSPARENCY.textShadow. Every colour
 * here is measured WITH that shadow against the real ground pixels (18 grounds, drawn by the real WorldView), by day
 * and under the night tint, by `npm run test:world-art` (section 8): the letter against its own shadow at 4,5:1 even
 * where the shadow lies on pure white, and the letter or its shadow at least 30 ΔE from every ground pixel -- the bar
 * the survivor's own silhouette clears (LEG-03).
 */
export const OVER_WORLD = {
	/** the display name: the anchor of the plate */
	name: TOKENS.foreground,
	/**
	 * "@username", only when it adds something: the light caption grey (#B1B1B1, 5,53:1 against its shadow on white).
	 * The muted #9C9C9C would be 4,32:1 there
	 */
	handle: TOKENS.cellMutedForeground,
	/**
	 * "LV 12": the XP blue (chart-2's hue and chroma) made lighter for the world (#87C4FA, 6,39:1 against its shadow on
	 * white). chart-2 itself would be 3,13:1 there
	 */
	level: TOKENS.statLevel,
	/** the shadow every line casts: the page's near-black */
	shadow: TOKENS.background,
};

/**
 * The fills of the HUD console's three bars (client/ui/hudConsole.ts, DESIGN_RULES UI-09). Each bar carries its value
 * as a light label centred on it ("HP 88 / 100"), small Bold text, so under UI-05 the FILL owes it 4,5:1 -- the
 * game colours themselves only reach 3,5-3,7:1 (they were drawn under a 3:1 "large text" rule the old HUD never
 * met). Each fill is its game colour with the same hue and chroma, darkened by the smallest OKLCH step that passes,
 * never the text: HP #EF4444 -> #DC2F34 (4,50:1), food #D2691E -> #BD5600 (4,51:1), XP #4C88BB -> #3C78AA (4,54:1).
 * GAME.hp / food / xp keep the lighter colours, because they are also drawn AS text on the dark body. Measured by
 * `npm run test:contrast`, with each fill against the dark groove it runs in (3:1, non-text).
 */
export const BAR = {
	/** HP: red, the colour of the survivor's blood (LEG-02) */
	hp: TOKENS.barHp,
	/** food: orange */
	food: TOKENS.barFood,
	/** XP and level: blue */
	xp: TOKENS.barXp,
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
