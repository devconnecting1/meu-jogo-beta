/*
 * Project Z UI kit: the shadcn/ui vocabulary (Button, Card, Badge, Progress, Tabs, Separator, Dialog, Slider,
 * Toast) rebuilt on Roblox GuiObjects and dressed in the author's "Pixel Quest relief" skin (skin.ts).
 *
 * Look (from the reference art, DESIGN_RULES UI-07):
 * - windows are PANELS: flat interior, thick frame, bitten pixel corners, a darker HEADER band with the big
 *   title centred on it (and, in window.ts, the "?" at the left and the red "X" at the right)
 * - what holds content (lists, tracks, chips) is a WELL sunk into the panel; a window's section is a lighter
 *   notched plate (window.ts)
 * - what you press is a PLATE (plate.ts): notched pixel corners, light band and ears on top, dark lip under;
 *   pressing pushes it in. Inactive tabs are flat iron plates; the active tab / selected item is BLUE
 * - text never carries a contour (DESIGN_RULES UI-04): labels on plates are the light `foreground`, and the
 *   PLATE is what makes them readable (UI-05) -- a plate that fails the contrast test gets darker, the text
 *   never gets an outline
 *
 * Layout: every widget is placed in "design units" relative to its parent (the root screen is 1120 x 630);
 * positions/sizes are converted to Scale, so the layout follows the screen. Parents created here carry
 * DesignW/DesignH attributes so children can be placed in the parent's own design space.
 *
 * Rules:
 * - colours, fonts, radius and spacing come from theme.ts (never literals in the screens); the relief itself
 *   is a greyscale texture tinted with ImageColor3 = an exact token (skin.ts: panels, wells) or a token washed
 *   over a token with Frames (plate.ts: buttons, tabs, keys, tiles)
 * - text is TextScaled + UITextSizeConstraint (max = design size x current UI scale), so it never overflows its
 *   box on phones and is not tiny on 1080p/1440p; skin pixels and borders scale the same way. Exception: a
 *   Keycap keeps its text size and grows its box instead (fixedText), because a key legend squeezed to fit
 *   a fixed key is the blur this kit used to draw
 * - buttons have hover / press / disabled states and a pixel `ring` when selected with a gamepad or keyboard
 *   (GuiService.SelectedObject), replacing Roblox's default selection highlight
 * - full screens use makeScreen(): a 16:9 design space at the menus' one scale (skin.ts fitScale), placed so the
 *   screen's content -- its window, or the whole space for a page -- is centred on the FULL screen and pushed down
 *   only by a real overlap with a Roblox top-bar button; HUD clusters use makeAnchored() (corner anchored, fixed
 *   aspect ratio)
 * - no skin textures (or a failed fetch) = the previous flat look, drawn from the same tokens (skin.ts)
 */
import { BORDER, GAME, SIDEBAR, SURFACE, TEXT, THEME, TRANSPARENCY, TextRole, fontOf, roleFont, space } from "./theme";
import { PlateState, clearPlate, paintPlate, plateUnit, reliefPx } from "./plate";
import { registerBack } from "./backStack";
import {
	DESIGN_H,
	DESIGN_W,
	PRESS_DROP,
	SurfaceSpec,
	boxStroke,
	clearSurface,
	clearTextOutline,
	fadeSurface,
	fadeText,
	fixedText,
	fixedTextPx,
	focusSurface,
	hairline,
	motionTime,
	onLayoutChange,
	paintSurface,
	panelSurface,
	placeContent,
	preferredTextScale,
	reducedMotion,
	scaleText,
	setStrokeWidth,
	setSurfaceTransparency,
	setWorldStrokeTransparency,
	setWorldTransparency,
	skinEnabled,
	skinPx,
	stripSurface,
	topBar,
	topInset,
	uiScale,
	viewportSize,
	wellSurface,
	worldTransparency,
} from "./skin";

const GuiService = game.GetService("GuiService");
const TweenService = game.GetService("TweenService");
const UserInputService = game.GetService("UserInputService");

export {
	DESIGN_H,
	DESIGN_W,
	boxStroke,
	clearTextOutline,
	fadeSurface,
	fadeText,
	fixedText,
	fixedTextPx,
	hairline,
	motionTime,
	onLayoutChange,
	preferredTextScale,
	reducedMotion,
	scaleText,
	setStrokeWidth,
	setSurfaceTransparency,
	setWorldStrokeTransparency,
	setWorldTransparency,
	skinEnabled,
	skinPx,
	topInset,
	uiScale,
	viewportSize,
	worldTransparency,
};

// ---------------------------------------------------------------- focus (gamepad / keyboard selection)

/** replaces Roblox's default selection highlight: the kit draws the pixel focus ring instead */
const NO_SELECTION_IMAGE = new Instance("Frame");
NO_SELECTION_IMAGE.Name = "NoSelectionImage";
NO_SELECTION_IMAGE.BackgroundTransparency = 1;
NO_SELECTION_IMAGE.BackgroundColor3 = THEME.background;
NO_SELECTION_IMAGE.BorderSizePixel = 0;
NO_SELECTION_IMAGE.Size = UDim2.fromScale(1, 1);

const focusHandlers = new Map<GuiObject, () => void>();
let focused: GuiObject | undefined;

GuiService.GetPropertyChangedSignal("SelectedObject").Connect(() => {
	const prev = focused;
	focused = GuiService.SelectedObject;
	if (prev !== undefined) focusHandlers.get(prev)?.();
	if (focused !== undefined) focusHandlers.get(focused)?.();
});

/** makes `obj` selectable with the kit's focus ring; `refresh` redraws it when it gains/loses focus */
export function registerFocus(obj: GuiObject, refresh: () => void): void {
	obj.SelectionImageObject = NO_SELECTION_IMAGE;
	focusHandlers.set(obj, refresh);
	obj.Destroying.Connect(() => focusHandlers.delete(obj));
}

export function isFocused(obj: GuiObject): boolean {
	return focused === obj;
}

/** the player's last input came from a gamepad */
export function gamepadActive(): boolean {
	return UserInputService.GetLastInputType().Name.sub(1, 7) === "Gamepad";
}

/** selects `obj` when playing with a gamepad (so a new screen/dialog is usable without a mouse) */
export function autoFocus(obj: GuiObject): void {
	if (gamepadActive()) GuiService.SelectedObject = obj;
}

/**
 * Shows / hides `obj` (a page kept built for reuse, a pooled row). Hiding also takes the gamepad / keyboard
 * selection off it or off anything inside it: bootstrap.ts reads "something is selected" as "a menu has the pad",
 * so a hidden control that kept the selection would keep the buttons from the game.
 */
export function setVisible(obj: GuiObject, visible: boolean): void {
	if (obj.Visible !== visible) obj.Visible = visible;
	if (visible) return;
	const sel = GuiService.SelectedObject;
	if (sel !== undefined && (sel === obj || sel.IsDescendantOf(obj))) GuiService.SelectedObject = undefined;
}

// ---------------------------------------------------------------- design-space helpers

/** the design space (w, h) children of `parent` are placed in: its DesignW / DesignH, or the root 1120 x 630 */
export function designOf(parent: Instance): [number, number] {
	if (parent.IsA("GuiObject")) {
		const dw = parent.GetAttribute("DesignW");
		const dh = parent.GetAttribute("DesignH");
		if (typeIs(dw, "number") && typeIs(dh, "number") && dw > 0 && dh > 0) {
			return [dw, dh];
		}
	}
	return [DESIGN_W, DESIGN_H];
}

/** text multiplier inherited from an enlarged container (see makeAnchored's `scale`) */
function inheritedTextScale(parent: Instance): number {
	let node: Instance | undefined = parent;
	for (let depth = 0; depth < 8 && node !== undefined; depth++) {
		const v = node.GetAttribute("TextScale");
		if (typeIs(v, "number") && v > 0) return v;
		node = node.Parent;
	}
	return 1;
}

/** marks `g` as a design space of w x h for its children */
export function setDesign<T extends GuiObject>(g: T, w: number, h: number): T {
	g.SetAttribute("DesignW", w);
	g.SetAttribute("DesignH", h);
	return g;
}

function place(g: GuiObject, parent: Instance, x: number, y: number, w: number, h: number): void {
	const [dw, dh] = designOf(parent);
	g.Position = UDim2.fromScale(x / dw, y / dh);
	g.Size = UDim2.fromScale(w / dw, h / dh);
	setDesign(g, w, h);
}

/** rounded corners; `radius` in design units of the object itself (RADIUS.full = pill / circle) */
export function addCorner(g: GuiObject, radius: number, w: number, h: number): UICorner {
	const c = new Instance("UICorner");
	c.CornerRadius = new UDim(math.clamp(radius / math.max(math.min(w, h), 1), 0, 0.5), 0);
	c.Parent = g;
	return c;
}

let strokePositionOk = true;
/** inner = CSS border (inside the box, never clipped); outer = CSS ring */
function setStrokePosition(s: UIStroke, inner: boolean): void {
	if (!strokePositionOk) return;
	const [ok] = pcall(() => {
		s.BorderStrokePosition = inner ? Enum.BorderStrokePosition.Inner : Enum.BorderStrokePosition.Outer;
	});
	if (!ok) strokePositionOk = false;
}

/** 1 px border (UIStroke) in `border` colour by default; `transparency` is a design value (see TRANSPARENCY) */
export function addStroke(g: GuiObject, color = THEME.border, transparency = 0, width = BORDER.width): UIStroke {
	// boxStroke: a border around the box, and never a UIStroke on a text object (UI-04)
	const s = boxStroke(g);
	s.Color = color;
	setWorldStrokeTransparency(s, transparency);
	s.LineJoinMode = Enum.LineJoinMode.Round;
	setStrokePosition(s, true);
	setStrokeWidth(s, width);
	return s;
}

export function addAspect(g: GuiObject, ratio: number): UIAspectRatioConstraint {
	const a = new Instance("UIAspectRatioConstraint");
	a.AspectRatio = ratio;
	a.AspectType = Enum.AspectType.FitWithinMaxSize;
	a.DominantAxis = Enum.DominantAxis.Width;
	a.Parent = g;
	return a;
}

/**
 * Every animation of the kit (and of the screens, which import this) goes through here, which is what makes
 * Reduce Motion a one-line honour: `motionTime` returns 0 when the player asked for it, and a 0-second tween
 * lands on its final value at once instead of being skipped -- so nothing ends up half-animated.
 */
export function tween<T extends Instance>(obj: T, time: number, props: Partial<ExtractMembers<T, Tweenable>>): Tween {
	const info = new TweenInfo(motionTime(time), Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
	const t = TweenService.Create(obj, info, props);
	t.Play();
	return t;
}

export function clearChildren(container: Instance): void {
	for (const child of container.GetChildren()) {
		child.Destroy();
	}
}

// ---------------------------------------------------------------- fonts

/** a typography role from theme.ts, or an explicit Font */
export type FontSpec = TextRole | Font;

function resolveFont(spec: FontSpec | undefined, fallback: TextRole): Font {
	if (spec === undefined) return roleFont(fallback);
	if (typeIs(spec, "string")) return roleFont(spec);
	return spec;
}

// ---------------------------------------------------------------- frames, surfaces & text

export interface FrameOpts {
	transparency?: number;
	zIndex?: number;
	clips?: boolean;
	/** corner radius in design units */
	radius?: number;
	stroke?: Color3;
	strokeTransparency?: number;
	/** stroke width in design px */
	strokeThickness?: number;
}

export function makeFrame(
	parent: Instance,
	name: string,
	x: number,
	y: number,
	w: number,
	h: number,
	color: Color3,
	opts?: FrameOpts,
): Frame {
	const f = new Instance("Frame");
	f.Name = name;
	place(f, parent, x, y, w, h);
	f.BackgroundColor3 = color;
	f.BorderSizePixel = 0;
	if (opts?.transparency !== undefined) setWorldTransparency(f, opts.transparency);
	if (opts?.zIndex !== undefined) f.ZIndex = opts.zIndex;
	if (opts?.clips !== undefined) f.ClipsDescendants = opts.clips;
	if (opts?.radius !== undefined && opts.radius > 0) addCorner(f, opts.radius, w, h);
	if (opts?.stroke !== undefined) {
		addStroke(f, opts.stroke, opts.strokeTransparency ?? 0, opts.strokeThickness ?? BORDER.width);
	}
	f.Parent = parent;
	return f;
}

/** the four surfaces of the skin (see skin.ts): a framed window, a sunk well, a title strip, a raised plate */
export type SurfaceKind = "panel" | "well" | "strip" | "raised";

export interface SurfaceOpts {
	/** panel interior / well fill / strip colour / raised face (defaults per kind) */
	fill?: Color3;
	/** panel frame / well border (defaults per kind) */
	border?: Color3;
	transparency?: number;
	zIndex?: number;
	clips?: boolean;
}

function surfaceSpec(kind: SurfaceKind, opts?: SurfaceOpts): SurfaceSpec {
	const t = opts?.transparency ?? 0;
	if (kind === "panel") return panelSurface(opts?.fill ?? SURFACE.panel, opts?.border ?? SURFACE.frame, t);
	if (kind === "strip") return stripSurface(opts?.fill ?? SURFACE.frame, t);
	return wellSurface(opts?.fill ?? SURFACE.well, opts?.border ?? SURFACE.line, t);
}

/**
 * Paints `host` as `kind`. A RAISED surface is a plate (plate.ts: the reference's notched plate with light band,
 * ears and lip, drawn with Frames); the others are skin surfaces. Switching between the two hides the other one.
 */
function applyKind(host: GuiObject, kind: SurfaceKind, opts?: SurfaceOpts): void {
	if (kind === "raised") {
		clearSurface(host);
		host.BackgroundColor3 = THEME.background;
		host.BackgroundTransparency = 1;
		paintPlate(host, opts?.fill ?? THEME.secondary, "idle");
		return;
	}
	clearPlate(host);
	paintSurface(host, surfaceSpec(kind, opts));
}

/** a skinned plate (panel / well / strip / raised) placed in the parent's design space */
export function makeSurface(
	parent: Instance,
	name: string,
	x: number,
	y: number,
	w: number,
	h: number,
	kind: SurfaceKind,
	opts?: SurfaceOpts,
): Frame {
	const f = new Instance("Frame");
	f.Name = name;
	place(f, parent, x, y, w, h);
	f.BorderSizePixel = 0;
	if (opts?.zIndex !== undefined) f.ZIndex = opts.zIndex;
	if (opts?.clips !== undefined) f.ClipsDescendants = opts.clips;
	applyKind(f, kind, opts);
	f.Parent = parent;
	return f;
}

/** repaints an existing surface (e.g. a card whose accent border changed) */
export function setSurface(host: GuiObject, kind: SurfaceKind, opts?: SurfaceOpts): void {
	applyKind(host, kind, opts);
}

export type TextAlign = "left" | "center" | "right";

export interface LabelOpts {
	/** typography role (default "body") or an explicit Font */
	font?: FontSpec;
	/** shorthand for the sans family (or mono with `mono`) at this weight */
	weight?: Enum.FontWeight;
	mono?: boolean;
	align?: TextAlign;
	valign?: "top" | "center" | "bottom";
	rich?: boolean;
	zIndex?: number;
	/**
	 * IGNORED. Text never carries a contour (DESIGN_RULES UI-04); the option stays only so the call sites that
	 * still pass it compile. Passing it changes nothing.
	 */
	outline?: boolean;
}

function xAlign(a: TextAlign | undefined): Enum.TextXAlignment {
	if (a === "left") return Enum.TextXAlignment.Left;
	if (a === "right") return Enum.TextXAlignment.Right;
	return Enum.TextXAlignment.Center;
}

function labelFont(opts: LabelOpts | undefined, fallback: TextRole): Font {
	if (opts?.font !== undefined) return resolveFont(opts.font, fallback);
	const mono = opts?.mono === true;
	if (opts?.weight !== undefined || mono) {
		return fontOf(mono ? "mono" : "sans", opts?.weight ?? (mono ? Enum.FontWeight.Bold : Enum.FontWeight.Regular));
	}
	return roleFont(fallback);
}

export function makeLabel(
	parent: Instance,
	name: string,
	text: string,
	x: number,
	y: number,
	w: number,
	h: number,
	textSize: number,
	color: Color3,
	opts?: LabelOpts,
): TextLabel {
	const l = new Instance("TextLabel");
	l.Name = name;
	place(l, parent, x, y, w, h);
	l.BackgroundTransparency = 1;
	l.BackgroundColor3 = THEME.background;
	l.BorderSizePixel = 0;
	l.Text = text;
	l.TextStrokeColor3 = THEME.background;
	l.TextColor3 = color;
	l.FontFace = labelFont(opts, "body");
	l.TextWrapped = true;
	l.RichText = opts?.rich === true;
	l.TextXAlignment = xAlign(opts?.align);
	if (opts?.valign === "top") l.TextYAlignment = Enum.TextYAlignment.Top;
	else if (opts?.valign === "bottom") l.TextYAlignment = Enum.TextYAlignment.Bottom;
	if (opts?.zIndex !== undefined) l.ZIndex = opts.zIndex;
	scaleText(l, textSize * inheritedTextScale(parent));
	l.Parent = parent;
	return l;
}

/** the TextLabel a kit button draws its text with (buttons keep their own text invisible under the skin) */
function buttonLabel(b: TextButton): TextLabel | undefined {
	const l = b.FindFirstChild("Label");
	return l !== undefined && l.IsA("TextLabel") ? l : undefined;
}

/** changes the design text size of a label/button created by this kit */
export function setTextSize(obj: TextLabel | TextButton, designSize: number): void {
	const target = obj.IsA("TextButton") ? (buttonLabel(obj) ?? obj) : obj;
	scaleText(target, designSize * inheritedTextScale(obj));
}

// ---------------------------------------------------------------- Button

export type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
export type ButtonSize = "sm" | "default" | "lg" | "icon";

/** internal variants: tab triggers, list rows, sidebar (navigation) items */
type AnyVariant = ButtonVariant | "tab" | "tabActive" | "row" | "nav" | "navActive";

/** height / text size / horizontal padding per size (design units) */
export const BUTTON_SIZE: Record<ButtonSize, { h: number; text: number; padX: number }> = {
	sm: { h: 34, text: TEXT.sm, padX: space(3) },
	default: { h: 44, text: TEXT.base, padX: space(4) },
	lg: { h: 56, text: TEXT.lg, padX: space(6) },
	icon: { h: 44, text: TEXT.base, padX: 0 },
};

/**
 * Look of a variant, all exact theme tokens (the relief is `foreground` / `background` washed over the face, see
 * plate.ts):
 * - raised variants (default / secondary / destructive / active tab / selected rail item) are the reference's
 *   notched plates: light band and ears on top, dark lip under; hovering brightens the light, pressing pushes the
 *   plate in. The active tab and the selected rail item are BLUE (`tabActive`, DESIGN_RULES UI-07);
 * - flat variants (an inactive tab) are the same notched plate in iron with no bands, and rise on hover;
 * - recessed variants (outline / row / rail item / ghost) are wells that fill with `frame` on hover;
 * - disabled is always a dark slot outlined in `line`, with muted text (a plate draws it with its own frames).
 */
interface VariantSpec {
	kind: "raised" | "flat" | "well" | "ghost";
	/** raised face / well fill */
	face: Color3;
	/** well border */
	border: Color3;
	fg: Color3;
	/** recessed variants: hover / focus fill and text */
	hotFace: Color3;
	hotBorder: Color3;
	hotFg: Color3;
	/** recessed variants: pressed fill */
	pressFace: Color3;
	ring: Color3;
	/** the control lives in a clipped container: the focus ring becomes its border instead of an outer ring */
	ringInner: boolean;
	/** recolour the button's own TextLabels to hoverFg while highlighted (rows, rail items) */
	recolorChildren: boolean;
}

function toVariant(style: string): AnyVariant {
	if (style === "primary") return "default";
	if (style === "danger") return "destructive";
	if (style === "success") return "secondary";
	if (
		style === "secondary" ||
		style === "outline" ||
		style === "ghost" ||
		style === "destructive" ||
		style === "tab" ||
		style === "tabActive" ||
		style === "row" ||
		style === "nav" ||
		style === "navActive"
	) {
		return style;
	}
	return "default";
}

function raised(face: Color3, fg: Color3, extra?: Partial<VariantSpec>): VariantSpec {
	return {
		kind: "raised",
		face,
		border: SURFACE.line,
		fg,
		hotFace: face,
		hotBorder: SURFACE.line,
		hotFg: fg,
		pressFace: face,
		ring: THEME.ring,
		ringInner: false,
		recolorChildren: false,
		...extra,
	};
}

function sunk(fill: Color3, border: Color3, fg: Color3, extra?: Partial<VariantSpec>): VariantSpec {
	return {
		kind: "well",
		face: fill,
		border,
		fg,
		hotFace: SURFACE.frame,
		hotBorder: THEME.secondary,
		hotFg: THEME.accentForeground,
		pressFace: SURFACE.line,
		ring: THEME.ring,
		ringInner: false,
		recolorChildren: false,
		...extra,
	};
}

/** shadcn/ui button recipes mapped onto the author's relief spec (see theme.ts) */
function variantSpec(v: AnyVariant): VariantSpec {
	const t = THEME;
	if (v === "secondary") return raised(t.secondary, t.secondaryForeground);
	if (v === "destructive") return raised(t.destructive, t.destructiveForeground);
	if (v === "outline") return sunk(SURFACE.well, t.border, t.foreground);
	if (v === "ghost") return sunk(SURFACE.well, t.border, t.foreground, { kind: "ghost" });
	// the reference's tab bar: inactive tabs are flat iron plates with the light label, the active one is blue
	if (v === "tab") return raised(t.secondary, t.secondaryForeground, { kind: "flat", ringInner: true });
	if (v === "tabActive") return raised(t.tabActive, t.tabActiveForeground, { ringInner: true });
	if (v === "row") {
		return sunk(SURFACE.well, SURFACE.line, t.cardForeground, { ringInner: true, recolorChildren: true });
	}
	if (v === "nav") {
		return sunk(SURFACE.well, SURFACE.line, SIDEBAR.foreground, {
			kind: "ghost",
			ring: SIDEBAR.ring,
			ringInner: true,
			recolorChildren: true,
		});
	}
	if (v === "navActive") {
		// the selected item of a rail is an active tab standing up: the same blue plate
		return raised(t.tabActive, t.tabActiveForeground, { ring: SIDEBAR.ring, ringInner: true });
	}
	return raised(t.primary, t.primaryForeground);
}

/** text colour of a variant (for custom content inside a button, e.g. a subtitle line) */
export function buttonForeground(variant: ButtonVariant): Color3 {
	return variantSpec(variant).fg;
}

function isDisabled(b: GuiButton): boolean {
	return b.GetAttribute("Disabled") === true;
}

function variantOf(b: TextButton): AnyVariant {
	const v = b.GetAttribute("Variant");
	return toVariant(typeIs(v, "string") ? v : "default");
}

/** recolours the button's own TextLabels (and restores their colour when `color` is undefined) */
function recolorLabels(b: TextButton, color: Color3 | undefined): void {
	for (const child of b.GetChildren()) {
		if (!child.IsA("TextLabel") || child.Name === "Label") continue;
		const base = child.GetAttribute("BaseTextColor");
		if (color !== undefined) {
			if (!typeIs(base, "Color3")) child.SetAttribute("BaseTextColor", child.TextColor3);
			child.TextColor3 = color;
		} else if (typeIs(base, "Color3")) {
			child.TextColor3 = base;
			child.SetAttribute("BaseTextColor", undefined);
		}
	}
}

/**
 * Sets the colour of a label that lives inside a kit button (a list row's name or status). While that row is
 * highlighted or disabled the kit shows another colour and puts the saved one back afterwards (recolorLabels),
 * so the new colour goes to the saved value then: written to TextColor3 it would be undone when the highlight ends.
 */
export function setLabelColor(label: TextLabel, color: Color3): void {
	if (typeIs(label.GetAttribute("BaseTextColor"), "Color3")) label.SetAttribute("BaseTextColor", color);
	else label.TextColor3 = color;
}

/** pixel focus ring around a button, with a 1 px gap (shadcn's ring-offset); created on first focus */
function makeOffsetRing(b: TextButton): Frame {
	const f = new Instance("Frame");
	f.Name = "FocusRing";
	f.AnchorPoint = new Vector2(0.5, 0.5);
	f.Position = UDim2.fromScale(0.5, 0.5);
	f.BorderSizePixel = 0;
	f.Active = false;
	f.Selectable = false;
	f.ZIndex = b.ZIndex;
	paintSurface(f, focusSurface(THEME.ring));
	onLayoutChange(f, () => {
		// ring (2 skin px) + gap (1 skin px) on each side
		const grow = 2 * 3 * skinPx();
		f.Size = new UDim2(1, grow, 1, grow);
	});
	f.Parent = b;
	return f;
}

/** how far the content of a pressed raised button drops (screen px) */
function pressShift(b: TextButton, on: boolean): void {
	let pad = b.FindFirstChild("PressShift") as UIPadding | undefined;
	if (!on) {
		if (pad !== undefined) {
			pad.PaddingTop = new UDim();
			pad.PaddingBottom = new UDim();
		}
		return;
	}
	if (pad === undefined) {
		pad = new Instance("UIPadding");
		pad.Name = "PressShift";
		pad.Parent = b;
	}
	const drop = PRESS_DROP * skinPx();
	pad.PaddingTop = new UDim(0, drop);
	pad.PaddingBottom = new UDim(0, -drop);
}

/** redraws a kit button from its variant, GuiState, disabled flag and focus (instant: tokens are never blended) */
function refreshButton(b: TextButton): void {
	const s = variantSpec(variantOf(b));
	const disabled = isDisabled(b);
	const state = b.GuiState;
	const focus = isFocused(b) && !disabled;
	const pressed = !disabled && state === Enum.GuiState.Press;
	const hot = !disabled && (focus || state === Enum.GuiState.Hover || pressed);
	let fg = s.fg;
	if (disabled) {
		// disabled, every variant: a plain well with `muted-foreground` text. mutedForeground (#818c96) on the
		// well fill (#0e0f11) is 5.6:1 (>= 4.5:1 AA); no transparency is applied to the text itself.
		fg = THEME.mutedForeground;
		if (s.kind === "raised" || s.kind === "flat") {
			// the same dark slot outlined in `line`, drawn by the plate's own frames: disabling creates nothing
			clearSurface(b);
			paintPlate(b, SURFACE.well, "outline", 1, SURFACE.line);
		} else {
			clearPlate(b);
			paintSurface(b, wellSurface(SURFACE.well, SURFACE.line));
		}
		pressShift(b, false);
	} else if (s.kind === "raised" || s.kind === "flat") {
		// a plate (plate.ts); a flat one (inactive tab) only rises while hovered, focused or pressed
		const rest: PlateState = s.kind === "flat" ? "flat" : "idle";
		const plateState: PlateState = pressed ? "press" : hot ? "hot" : rest;
		clearSurface(b);
		paintPlate(b, s.face, plateState);
		pressShift(b, pressed);
	} else {
		clearPlate(b);
		const fill = pressed ? s.pressFace : hot ? s.hotFace : s.face;
		const border = focus && s.ringInner ? s.ring : hot ? s.hotBorder : s.border;
		if (s.kind === "ghost" && !hot && !(focus && s.ringInner)) clearSurface(b);
		else paintSurface(b, wellSurface(fill, border));
		if (hot) fg = s.hotFg;
		pressShift(b, false);
	}
	b.TextColor3 = fg;
	const label = buttonLabel(b);
	if (label !== undefined) label.TextColor3 = fg;
	// buttons outside a clipped container get the ring-offset focus ring; rows / tabs / rail items turn their
	// own border into the ring instead (an outer ring would be clipped away)
	const offsetRing = b.FindFirstChild("FocusRing");
	if (focus && !s.ringInner) {
		const f = offsetRing !== undefined && offsetRing.IsA("Frame") ? offsetRing : makeOffsetRing(b);
		paintSurface(f, focusSurface(s.ring));
		f.Visible = true;
	} else if (offsetRing !== undefined && offsetRing.IsA("Frame")) {
		offsetRing.Visible = false;
	}
	if (disabled) recolorLabels(b, THEME.mutedForeground);
	else if (hot && s.recolorChildren) recolorLabels(b, s.hotFg);
	else recolorLabels(b, undefined);
}

export interface ButtonProps {
	x: number;
	y: number;
	w: number;
	/** default: the size's height */
	h?: number;
	variant?: ButtonVariant;
	size?: ButtonSize;
	onClick?: () => void;
	disabled?: boolean;
	/** design text size (default: the size's) */
	textSize?: number;
	/** default: the "label" role (SemiBold) */
	font?: FontSpec;
	align?: TextAlign;
	zIndex?: number;
	/** corner radius in design units (only used by the flat fallback; the skin has pixel corners) */
	radius?: number;
}

function buildButton(
	parent: Instance,
	name: string,
	text: string,
	props: ButtonProps,
	variant: AnyVariant,
	sizing?: (b: TextButton) => void,
): TextButton {
	const size = BUTTON_SIZE[props.size ?? "default"];
	const w = props.w;
	const h = props.h ?? size.h;
	const b = new Instance("TextButton");
	b.Name = name;
	if (sizing === undefined) place(b, parent, props.x, props.y, w, h);
	else setDesign(b, w, h);
	b.AutoButtonColor = false;
	b.BorderSizePixel = 0;
	b.BackgroundTransparency = 1;
	b.BackgroundColor3 = THEME.background;
	b.Text = text;
	b.TextTransparency = 1; // the skin sits above the button's own text: it is drawn by the Label below
	b.TextColor3 = THEME.foreground;
	b.TextStrokeColor3 = THEME.background;
	if (props.zIndex !== undefined) b.ZIndex = props.zIndex;

	// the button's text, drawn above the skin layers
	const label = new Instance("TextLabel");
	label.Name = "Label";
	label.BackgroundTransparency = 1;
	label.BackgroundColor3 = THEME.background;
	label.BorderSizePixel = 0;
	label.Size = UDim2.fromScale(1, 1);
	label.Text = text;
	label.TextColor3 = THEME.foreground;
	label.TextStrokeColor3 = THEME.background;
	label.FontFace = resolveFont(props.font, "label");
	label.TextWrapped = true;
	label.TextXAlignment = xAlign(props.align);
	label.ZIndex = b.ZIndex;
	if (props.align === "left" || props.align === "right") {
		const pad = new Instance("UIPadding");
		pad.PaddingLeft = new UDim(size.padX / w, 0);
		pad.PaddingRight = new UDim(size.padX / w, 0);
		pad.Parent = label;
	}
	scaleText(label, (props.textSize ?? size.text) * inheritedTextScale(parent));
	label.Parent = b;
	b.GetPropertyChangedSignal("Text").Connect(() => {
		label.Text = b.Text;
	});

	b.SetAttribute("Variant", variant);
	b.SetAttribute("Disabled", props.disabled === true);
	b.Interactable = props.disabled !== true;
	b.Selectable = props.disabled !== true;
	registerFocus(b, () => refreshButton(b));
	b.GetPropertyChangedSignal("GuiState").Connect(() => refreshButton(b));
	const onClick = props.onClick;
	b.Activated.Connect(() => {
		if (isDisabled(b) || onClick === undefined) return;
		onClick();
	});
	refreshButton(b);
	sizing?.(b);
	b.Parent = parent;
	return b;
}

/** shadcn Button: variant default | secondary | outline | ghost | destructive, size sm | default | lg | icon */
export function Button(parent: Instance, name: string, text: string, props: ButtonProps): TextButton {
	return buildButton(parent, name, text, props, toVariant(props.variant ?? "default"));
}

function applyVariant(b: TextButton, variant: AnyVariant): void {
	if (b.GetAttribute("Variant") === variant) return;
	b.SetAttribute("Variant", variant);
	refreshButton(b);
}

export function setButtonVariant(b: TextButton, variant: ButtonVariant): void {
	applyVariant(b, toVariant(variant));
}

export function setButtonEnabled(b: TextButton, enabled: boolean): void {
	b.SetAttribute("Disabled", !enabled);
	b.Interactable = enabled;
	b.Selectable = enabled;
	if (!enabled && GuiService.SelectedObject === b) GuiService.SelectedObject = undefined;
	refreshButton(b);
}

// ---------------------------------------------------------------- Card (panel)

/**
 * default: a framed panel; hud: the same panel over the game world (its interior at TRANSPARENCY.hud);
 * muted: a well sunk into a panel; popover: dialogs, toasts, tooltips, banners (also a framed panel)
 */
export type CardVariant = "default" | "hud" | "muted" | "popover";

export interface CardProps {
	x: number;
	y: number;
	w: number;
	h: number;
	variant?: CardVariant;
	/** interior transparency (only for surfaces over the game world; default: 0, hud: TRANSPARENCY.hud) */
	transparency?: number;
	/** inner padding used by the Card* helpers (default space(6), like shadcn's px-6/py-6) */
	pad?: number;
	/** frame / border colour override, a token (e.g. GAME.success for an owned item) */
	border?: Color3;
	/** interior colour override, a token (a modal window's body is SURFACE.window) */
	fill?: Color3;
	zIndex?: number;
	clips?: boolean;
}

function cardForegroundOf(variant: CardVariant): Color3 {
	if (variant === "popover") return THEME.popoverForeground;
	return THEME.cardForeground;
}

export function Card(parent: Instance, name: string, props: CardProps): Frame {
	const variant = props.variant ?? "default";
	const transparency = props.transparency ?? (variant === "hud" ? TRANSPARENCY.hud : 0);
	const kind: SurfaceKind = variant === "muted" ? "well" : "panel";
	const f = makeSurface(parent, name, props.x, props.y, props.w, props.h, kind, {
		fill: props.fill ?? (variant === "muted" ? SURFACE.well : SURFACE.panel),
		border: props.border ?? (variant === "muted" ? SURFACE.line : SURFACE.frame),
		transparency,
		zIndex: props.zIndex,
		clips: props.clips,
	});
	f.SetAttribute("Pad", props.pad ?? space(6));
	f.SetAttribute("CardVariant", variant);
	f.SetAttribute("CardTransparency", transparency);
	return f;
}

/** repaints a Card's frame / border colour in place, keeping its variant and transparency (a line turning red) */
export function setCardBorder(card: Frame, border: Color3): void {
	const muted = card.GetAttribute("CardVariant") === "muted";
	const t = card.GetAttribute("CardTransparency");
	setSurface(card, muted ? "well" : "panel", {
		fill: muted ? SURFACE.well : SURFACE.panel,
		border,
		transparency: typeIs(t, "number") ? t : 0,
	});
}

function cardBox(card: Frame): [number, number, number] {
	const [w, h] = designOf(card);
	const pad = card.GetAttribute("Pad");
	return [w, h, typeIs(pad, "number") ? pad : space(6)];
}

function cardForeground(card: Frame): Color3 {
	const v = card.GetAttribute("CardVariant");
	return cardForegroundOf(v === "popover" ? "popover" : "default");
}

export interface CardTextOpts {
	x?: number;
	y?: number;
	w?: number;
	h?: number;
	size?: number;
	color?: Color3;
	align?: TextAlign;
	zIndex?: number;
}

/** CardTitle: heading role (SemiBold), card-foreground (popover-foreground in a popover) */
export function CardTitle(card: Frame, text: string, opts?: CardTextOpts): TextLabel {
	const [w, , pad] = cardBox(card);
	const size = opts?.size ?? TEXT.xl;
	return makeLabel(
		card,
		"CardTitle",
		text,
		opts?.x ?? pad,
		opts?.y ?? pad,
		opts?.w ?? w - pad * 2,
		opts?.h ?? math.ceil(size * 1.3),
		size,
		opts?.color ?? cardForeground(card),
		{ font: "heading", align: opts?.align ?? "left", zIndex: opts?.zIndex },
	);
}

/** CardDescription: text-sm, muted-foreground */
export function CardDescription(card: Frame, text: string, opts?: CardTextOpts): TextLabel {
	const [w, , pad] = cardBox(card);
	const size = opts?.size ?? TEXT.sm;
	return makeLabel(
		card,
		"CardDescription",
		text,
		opts?.x ?? pad,
		opts?.y ?? pad,
		opts?.w ?? w - pad * 2,
		opts?.h ?? math.ceil(size * 1.5),
		size,
		opts?.color ?? THEME.mutedForeground,
		{ align: opts?.align ?? "left", valign: "top", zIndex: opts?.zIndex },
	);
}

export interface CardHeaderOpts {
	titleSize?: number;
	/** width reserved at the right of the header for an action (e.g. a close button) */
	action?: number;
	/** lines of description to reserve (default 1) */
	lines?: number;
	/** title colour (default `foreground`; e.g. `destructive` for "Game over") */
	color?: Color3;
	/** header band colour (default SURFACE.header; e.g. `destructive` for a dangerous window) */
	stripColor?: Color3;
}

/** margin between a panel's edge and its title strip (clears the frame at every UI scale) */
export const CARD_STRIP_INSET = space(2);
const STRIP_PAD = space(3);

/** height of the title strip a CardHeader draws (design units), e.g. to place a button or badge on it */
export function cardStripHeight(titleSize = TEXT.xl2): number {
	return math.ceil(titleSize * 1.3) + STRIP_PAD;
}

const STRIP_INSET = CARD_STRIP_INSET;
const stripHeight = cardStripHeight;

/** height of a CardHeader: from the card's top edge to where the content starts (the skinned strip is fixed) */
export function cardHeaderHeight(titleSize = TEXT.xl2, descriptionLines = 0): number {
	let y = STRIP_INSET + stripHeight(titleSize) + space(3);
	if (descriptionLines > 0) y += math.ceil(TEXT.sm * 1.5 * descriptionLines) + space(2);
	return y;
}

/** inner edge of a Card's frame, in screen px: the skin's dark edge + iron frame (4 skin px), or the flat border */
function cardFramePx(): number {
	return skinEnabled() ? 4 * skinPx() : hairline(BORDER.width);
}

/**
 * CardHeader: the reference's window HEADER (DESIGN_RULES UI-07) -- a band flush with the frame, one shade darker
 * than the window body (`SURFACE.header`), with the big bold title centred on it -- and an optional muted
 * description under it. Returns the y where the content starts.
 *
 * The band ends exactly where the old inset title strip ended (CARD_STRIP_INSET + cardStripHeight), so every
 * screen that placed a close "X", a key cap or a badge "on the strip" still lands on the header, and
 * cardHeaderHeight() is still where the content starts.
 */
export function CardHeader(card: Frame, title: string, description?: string, opts?: CardHeaderOpts): number {
	const [w, h, pad] = cardBox(card);
	const titleSize = opts?.titleSize ?? TEXT.xl2;
	const stripH = stripHeight(titleSize);
	const bottom = STRIP_INSET + stripH;
	const band = new Instance("Frame");
	band.Name = "TitleStrip";
	band.BackgroundColor3 = opts?.stripColor ?? SURFACE.header;
	band.BorderSizePixel = 0;
	band.ZIndex = card.ZIndex + 1;
	onLayoutChange(band, () => {
		const f = cardFramePx();
		band.Position = new UDim2(0, f, 0, f);
		band.Size = new UDim2(1, -2 * f, bottom / h, -f);
	});
	band.Parent = card;
	const action = opts?.action ?? 0;
	makeLabel(
		card,
		"Title",
		title,
		action,
		STRIP_INSET,
		w - action * 2,
		stripH,
		titleSize,
		opts?.color ?? THEME.foreground,
		{
			// heavier than the "title" role: the reference's window titles are its boldest text
			font: fontOf("sans", Enum.FontWeight.ExtraBold),
			zIndex: band.ZIndex + 1,
		},
	);
	let y = STRIP_INSET + stripH + space(3);
	if (description !== undefined && description !== "") {
		const lines = opts?.lines ?? 1;
		const descH = math.ceil(TEXT.sm * 1.5 * lines);
		CardDescription(card, description, { y, w: w - pad * 2, h: descH });
		y += descH + space(2);
	}
	return y;
}

/** CardContent: padded region from `y` (to the bottom padding when `h` is omitted) */
export function CardContent(card: Frame, y: number, h?: number): Frame {
	const [w, ch, pad] = cardBox(card);
	return makeFrame(card, "CardContent", pad, y, w - pad * 2, h ?? ch - y - pad, THEME.card, { transparency: 1 });
}

/** CardFooter: padded row of height `h` at the bottom of the card */
export function CardFooter(card: Frame, h: number): Frame {
	const [w, ch, pad] = cardBox(card);
	return makeFrame(card, "CardFooter", pad, ch - pad - h, w - pad * 2, h, THEME.card, { transparency: 1 });
}

// ---------------------------------------------------------------- Badge (chip)

export type BadgeVariant = "default" | "secondary" | "outline" | "destructive";

export interface BadgeProps {
	x: number;
	y: number;
	/** default: fits the text */
	w?: number;
	h?: number;
	variant?: BadgeVariant;
	/** semantic accent from theme.GAME (e.g. success, xp, rare); drawn as the chip border, text stays `foreground` */
	color?: Color3;
	textSize?: number;
	zIndex?: number;
}

/** approximate width of a one-line badge / pill for `text` */
export function badgeWidth(text: string, textSize = TEXT.xs, h = 22): number {
	const [n] = utf8.len(text);
	const chars = typeIs(n, "number") ? n : text.size();
	return math.max(h, math.ceil(chars * textSize * 0.6 + space(2) * 2));
}

/** [surface kind, fill, border, text] of a badge */
function badgeLook(variant: BadgeVariant, color: Color3 | undefined): [SurfaceKind, Color3, Color3, Color3] {
	// a GAME.* accent as a SOLID fill can't clear 4.5:1 against either foreground or background text (e.g.
	// GAME.success only reaches ~4.2:1 on foreground, GAME.xp ~4.0:1) — read it as an outlined chip instead:
	// the well fill, the accent as the border, `foreground` text (~18.7:1 on that fill)
	if (color !== undefined) return ["well", SURFACE.well, color, THEME.foreground];
	// "default" is the key cap of the reference art (the E prompt): a small raised plate of dark iron
	if (variant === "default") return ["raised", SURFACE.key, SURFACE.line, THEME.foreground];
	if (variant === "secondary") return ["well", THEME.secondary, SURFACE.line, THEME.secondaryForeground];
	if (variant === "destructive") return ["well", SURFACE.well, THEME.destructive, THEME.foreground];
	return ["well", SURFACE.well, THEME.border, THEME.foreground];
}

/** shadcn Badge: a small chip (well or key cap), text-xs Bold; no contour (UI-04), the fill carries the contrast */
export function Badge(parent: Instance, name: string, text: string, props: BadgeProps): Frame {
	const h = props.h ?? 22;
	const size = props.textSize ?? TEXT.xs;
	const w = props.w ?? badgeWidth(text, size, h);
	const [kind, fill, border, fg] = badgeLook(props.variant ?? "default", props.color);
	const zIndex = props.zIndex ?? 2;
	const f = makeSurface(parent, name, props.x, props.y, w, h, kind, { fill, border, zIndex });
	makeLabel(f, "Text", text, space(1.5), 0, w - space(3), h, size, fg, {
		font: fontOf("sans", Enum.FontWeight.Bold),
		zIndex: zIndex + 1,
	});
	return f;
}

/** updates a Badge's text (and, for a custom-colour badge, its accent — the chip keeps the well fill) */
export function setBadge(badge: Frame, text: string, color?: Color3): void {
	const label = badge.FindFirstChild("Text");
	if (label !== undefined && label.IsA("TextLabel")) label.Text = text;
	if (color !== undefined) setSurface(badge, "well", { fill: SURFACE.well, border: color });
}

/** repaints a Badge as another variant / accent in place (e.g. a station tag going `secondary` -> `destructive`) */
export function setBadgeLook(badge: Frame, variant: BadgeVariant, color?: Color3): void {
	const [kind, fill, border, fg] = badgeLook(variant, color);
	setSurface(badge, kind, { fill, border });
	const label = badge.FindFirstChild("Text");
	if (label !== undefined && label.IsA("TextLabel")) label.TextColor3 = fg;
}

// ---------------------------------------------------------------- Keycap

export interface KeycapProps {
	/** left edge (or the point `anchorX` names) and vertical CENTRE, in the parent's design units */
	x: number;
	cy: number;
	/** which point of the key `x` is: 0 = left edge (default), 0.5 = centre, 1 = right edge */
	anchorX?: number;
	/** key height in design units; the legend decides the width */
	h: number;
	/** narrowest key in design units (default: square, so "E" still reads as a key) */
	minW?: number;
	/** legend design size (default TEXT.xs), drawn at a fixed size: never squeezed */
	textSize?: number;
	/** legend font (default the "label" role) */
	font?: FontSpec;
	zIndex?: number;
}

/**
 * A key of the keyboard / pad shown as a LEGEND, not a button: a raised plate of dark iron (SURFACE.key) with
 * the legend in `foreground`, SemiBold, and no contour (UI-04). The dark iron is on purpose -- darker than any
 * button plate, so a key never looks like something to click.
 *
 * The KEY fits the TEXT, never the other way round (the old keys were fixed-width Badges, and TextScaled
 * crushed "Keep holding" into a blur). The legend is fixedText -- its size follows the screen, floored at
 * MIN_TEXT_PX -- with AutomaticSize on X, and the key takes the legend's width plus padding whenever that
 * width changes (screen size, the player's Text Size setting). The automatic size sits on the legend and not
 * on the plate deliberately: the plate's skin layers are Scale-sized children, the docs do not say how
 * AutomaticSize treats those, and a key that could not shrink back after a resize would be a bug.
 *
 * Returns the key; its AbsoluteSize tells a row where its next element can start.
 */
export function Keycap(parent: Instance, name: string, text: string, props: KeycapProps): Frame {
	const [dw, dh] = designOf(parent);
	const zIndex = props.zIndex ?? 2;
	const key = new Instance("Frame");
	key.Name = name;
	key.BorderSizePixel = 0;
	key.ZIndex = zIndex;
	key.AnchorPoint = new Vector2(props.anchorX ?? 0, 0.5);
	key.Position = UDim2.fromScale(props.x / dw, props.cy / dh);
	key.BackgroundColor3 = THEME.background;
	key.BackgroundTransparency = 1;
	const unit = plateUnit(props.h);
	paintPlate(key, SURFACE.key, "idle", unit);

	const legend = new Instance("TextLabel");
	legend.Name = "Legend";
	legend.BackgroundTransparency = 1;
	legend.BackgroundColor3 = THEME.background;
	legend.BorderSizePixel = 0;
	legend.Text = text;
	legend.TextColor3 = THEME.foreground;
	legend.FontFace = resolveFont(props.font, "label");
	legend.TextWrapped = false;
	legend.AutomaticSize = Enum.AutomaticSize.X;
	legend.AnchorPoint = new Vector2(0.5, 0.5);
	legend.Position = UDim2.fromScale(0.5, 0.5);
	legend.Size = new UDim2(0, 0, 1, 0);
	legend.ZIndex = zIndex + 1;
	fixedText(legend, (props.textSize ?? TEXT.xs) * inheritedTextScale(parent));
	legend.Parent = key;

	const fit = (): void => {
		const scale = uiScale();
		const pad = space(2) * scale;
		const w = math.max((props.minW ?? props.h) * scale, legend.AbsoluteSize.X + pad * 2);
		// a key is never shorter than its legend plus the bevel (light band + lip), whatever the design height
		const h = math.max(props.h * scale, legend.TextSize + 2 * reliefPx(unit) + 2);
		key.Size = UDim2.fromOffset(math.round(w), math.round(h));
	};
	legend.GetPropertyChangedSignal("AbsoluteSize").Connect(fit);
	onLayoutChange(key, fit);
	key.Parent = parent;
	return key;
}

// ---------------------------------------------------------------- Separator

export interface SeparatorProps {
	x: number;
	y: number;
	/** length (width, or height when vertical) in design units */
	length: number;
	vertical?: boolean;
	color?: Color3;
	zIndex?: number;
}

/** shadcn Separator: a 1 skin px rule in the surface `line` colour */
export function Separator(parent: Instance, name: string, props: SeparatorProps): Frame {
	const [dw, dh] = designOf(parent);
	const f = new Instance("Frame");
	f.Name = name;
	f.BackgroundColor3 = props.color ?? SURFACE.line;
	f.BorderSizePixel = 0;
	if (props.zIndex !== undefined) f.ZIndex = props.zIndex;
	f.Position = UDim2.fromScale(props.x / dw, props.y / dh);
	onLayoutChange(f, () => {
		const px = skinPx();
		f.Size = props.vertical ? new UDim2(0, px, props.length / dh, 0) : new UDim2(props.length / dw, 0, 0, px);
	});
	f.Parent = parent;
	return f;
}

// ---------------------------------------------------------------- Progress

export interface Bar {
	frame: Frame;
	fill: Frame;
	label: TextLabel | undefined;
	setRatio(r: number): void;
	setText(text: string): void;
	setColor(c: Color3): void;
}

export interface ProgressProps {
	x: number;
	y: number;
	w: number;
	h: number;
	/** indicator colour (default primary; HUD bars use theme.GAME) */
	color?: Color3;
	/** 0..1 (default 1) */
	value?: number;
	/** value text inside the bar (BuilderMono) */
	label?: boolean;
	textSize?: number;
	zIndex?: number;
}

/** inner area of a well, inset by its 1 skin px border (screen px, follows the UI scale) */
function wellInner(host: GuiObject, name: string, zIndex: number): Frame {
	const inner = new Instance("Frame");
	inner.Name = name;
	inner.BackgroundTransparency = 1;
	inner.BackgroundColor3 = THEME.background;
	inner.BorderSizePixel = 0;
	inner.ZIndex = zIndex;
	inner.ClipsDescendants = true;
	onLayoutChange(inner, () => {
		const px = skinEnabled() ? skinPx() : hairline(BORDER.width);
		inner.Position = new UDim2(0, px, 0, px);
		inner.Size = new UDim2(1, -px * 2, 1, -px * 2);
	});
	inner.Parent = host;
	return inner;
}

/** shadcn Progress: a recessed track with a flat indicator (the reference's bars) */
export function Progress(parent: Instance, name: string, props: ProgressProps): Bar {
	const { w, h } = props;
	const zIndex = props.zIndex ?? 1;
	const frame = makeSurface(parent, name, props.x, props.y, w, h, "well", { zIndex });
	const inner = wellInner(frame, "Inner", zIndex + 1);
	const fill = new Instance("Frame");
	fill.Name = "Fill";
	fill.BackgroundColor3 = props.color ?? THEME.primary;
	fill.BorderSizePixel = 0;
	fill.Position = new UDim2();
	fill.Size = UDim2.fromScale(1, 1);
	fill.ZIndex = zIndex + 2;
	fill.Parent = inner;
	let label: TextLabel | undefined;
	if (props.label === true) {
		label = makeLabel(
			frame,
			"Value",
			"",
			space(2),
			0,
			w - space(4),
			h,
			props.textSize ?? h * 0.7,
			THEME.foreground,
			{ font: "numeric", zIndex: zIndex + 3 },
		);
	}
	const bar: Bar = {
		frame,
		fill,
		label,
		setRatio(r: number): void {
			const v = math.clamp(r === r ? r : 0, 0, 1);
			fill.Size = UDim2.fromScale(v, 1);
			fill.Visible = v > 0.001;
		},
		setText(text: string): void {
			if (label !== undefined) label.Text = text;
		},
		setColor(c: Color3): void {
			fill.BackgroundColor3 = c;
		},
	};
	bar.setRatio(props.value ?? 1);
	return bar;
}

// ---------------------------------------------------------------- Tabs

export interface TabsProps {
	x: number;
	y: number;
	w: number;
	h: number;
	items: Array<string>;
	value?: number;
	onChange?: (index: number) => void;
	textSize?: number;
	zIndex?: number;
	/**
	 * Tab widths in design units, left-aligned from `x` (the reference's tab bar: each tab as wide as its name).
	 * Default: the items share `w` evenly.
	 */
	widths?: Array<number>;
	/** gap between tabs (default space(3); a Segmented uses its own) */
	gap?: number;
}

export interface TabsHandle {
	/** TabsList */
	frame: Frame;
	/** TabsTrigger buttons, one per item */
	triggers: Array<TextButton>;
	/** marks `index` as the active trigger (no onChange) */
	setActive(index: number): void;
}

/** width of a tab / segment that fits `text` at `textSize` Bold, with the plate's padding (design units) */
export function tabWidth(text: string, textSize = TEXT.lg): number {
	const [n] = utf8.len(text);
	const chars = typeIs(n, "number") ? n : text.size();
	return math.ceil(chars * textSize * 0.62 + space(6) * 2);
}

/** the tab triggers of a Tabs / Segmented, laid out in `list` (its own design space) */
function tabTriggers(list: Frame, props: TabsProps, inset: number, gap: number): TabsHandle {
	const { items } = props;
	const [w, h] = designOf(list);
	const n = math.max(items.size(), 1);
	const evenW = (w - inset * 2 - gap * (n - 1)) / n;
	const triggers: Array<TextButton> = [];
	const handle: TabsHandle = {
		frame: list,
		triggers,
		setActive(index: number): void {
			for (let i = 0; i < triggers.size(); i++) applyVariant(triggers[i], i === index ? "tabActive" : "tab");
		},
	};
	let x = inset;
	for (let i = 0; i < items.size(); i++) {
		const index = i;
		const tw = props.widths?.[i] ?? evenW;
		const t = buildButton(
			list,
			`Tab${i}`,
			items[i],
			{
				x,
				y: inset,
				w: tw,
				h: h - inset * 2,
				textSize: props.textSize ?? TEXT.lg,
				// the reference's tab labels: light and Bold (no contour, UI-04: the plate carries the contrast)
				font: fontOf("sans", Enum.FontWeight.Bold),
				zIndex: list.ZIndex + 1,
				onClick: (): void => {
					handle.setActive(index);
					props.onChange?.(index);
				},
			},
			"tab",
		);
		triggers.push(t);
		x += tw + gap;
	}
	handle.setActive(props.value ?? 0);
	return handle;
}

/**
 * The reference's TAB BAR (DESIGN_RULES UI-07): notched plates standing on the window body, spaced, no tray.
 * Inactive tabs are flat iron plates, the active one a raised BLUE plate (`tabActive`), labels light and Bold.
 */
export function Tabs(parent: Instance, name: string, props: TabsProps): TabsHandle {
	const bar = makeFrame(parent, name, props.x, props.y, props.w, props.h, THEME.background, {
		transparency: 1,
		zIndex: props.zIndex,
	});
	return tabTriggers(bar, props, 0, props.gap ?? space(3));
}

/**
 * A SEGMENTED selector (On / Off, Keyboard / Gamepad / Touch): the tab bar's plates packed in a dark notched
 * groove, so it reads as one control with one choice lit in blue.
 */
export function Segmented(parent: Instance, name: string, props: TabsProps): TabsHandle {
	const tray = makeFrame(parent, name, props.x, props.y, props.w, props.h, THEME.background, {
		transparency: 1,
		zIndex: props.zIndex,
	});
	paintPlate(tray, SURFACE.well, "flat", 2);
	return tabTriggers(tray, { ...props, textSize: props.textSize ?? TEXT.base }, 3, props.gap ?? 3);
}

// ---------------------------------------------------------------- Sidebar (navigation rail)

export interface SidebarProps {
	x: number;
	y: number;
	w: number;
	h: number;
	items: Array<string>;
	value?: number;
	onChange?: (index: number) => void;
	/** item height (default 40) */
	itemH?: number;
	textSize?: number;
	zIndex?: number;
}

export interface SidebarHandle {
	/** the rail */
	frame: Frame;
	/** one button per item (design space: rail inner width x itemH), e.g. to add a Badge at the right */
	items: Array<TextButton>;
	/** marks `index` as the selected item (no onChange) */
	setActive(index: number): void;
	/** Badge at the right of item `index` (e.g. unspent points); undefined text hides it */
	setBadge(index: number, text: string | undefined, color?: Color3): void;
}

const NAV_BADGE_H = 20;

/** Navigation rail: a well holding the items; the selected one is a raised `secondary` plate */
export function Sidebar(parent: Instance, name: string, props: SidebarProps): SidebarHandle {
	const { w, h, items } = props;
	const rail = makeSurface(parent, name, props.x, props.y, w, h, "well", { zIndex: props.zIndex });
	const pad = space(2);
	const itemH = props.itemH ?? 40;
	const buttons: Array<TextButton> = [];
	const badges = new Map<number, Frame>();
	const itemY = (i: number): number => pad + i * (itemH + space(1));
	const handle: SidebarHandle = {
		frame: rail,
		items: buttons,
		setActive(index: number): void {
			for (let i = 0; i < buttons.size(); i++) applyVariant(buttons[i], i === index ? "navActive" : "nav");
		},
		setBadge(index: number, text: string | undefined, color?: Color3): void {
			const current = badges.get(index);
			if (text === undefined || text === "" || buttons[index] === undefined) {
				if (current !== undefined) current.Visible = false;
				return;
			}
			const bw = badgeWidth(text, TEXT.xs, NAV_BADGE_H);
			// the chip is kept and rewritten while its width and look hold (a count going 3 -> 2, shown / hidden);
			// only a new width or look builds another one
			const shape = `${bw}:${color === undefined ? "secondary" : "accent"}`;
			if (current !== undefined && current.GetAttribute("Shape") === shape) {
				setBadge(current, text, color);
				current.Visible = true;
				return;
			}
			current?.Destroy();
			// on the rail (not inside the item, whose text padding would shift it), right-aligned in the item
			const badge = Badge(rail, `Badge${index}`, text, {
				x: w - pad - space(2) - bw,
				y: itemY(index) + (itemH - NAV_BADGE_H) / 2,
				w: bw,
				h: NAV_BADGE_H,
				variant: color === undefined ? "secondary" : undefined,
				color,
				zIndex: rail.ZIndex + 3,
			});
			badge.SetAttribute("Shape", shape);
			badges.set(index, badge);
		},
	};
	for (let i = 0; i < items.size(); i++) {
		const index = i;
		const b = buildButton(
			rail,
			`Item${i}`,
			items[i],
			{
				x: pad,
				y: itemY(i),
				w: w - pad * 2,
				h: itemH,
				size: "sm",
				align: "left",
				textSize: props.textSize ?? TEXT.sm,
				zIndex: rail.ZIndex + 1,
				onClick: (): void => {
					handle.setActive(index);
					props.onChange?.(index);
				},
			},
			"nav",
		);
		buttons.push(b);
	}
	handle.setActive(props.value ?? 0);
	return handle;
}

// ---------------------------------------------------------------- screens & anchored clusters

/** a rectangle in design units */
export interface DesignRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** the whole 1120 x 630 design space: the content of a page whose layout reaches the screen's edges */
export const FULL_SCREEN: DesignRect = { x: 0, y: 0, w: DESIGN_W, h: DESIGN_H };

/** a w x h window centred in the design space (where every UI-07 window of the game sits) */
export function centredRect(w: number, h: number): DesignRect {
	return { x: (DESIGN_W - w) / 2, y: (DESIGN_H - h) / 2, w, h };
}

export interface Screen {
	/** full-screen background (blocks clicks to what is below) */
	root: Frame;
	/** the 1120x630 design space, placed so the screen's content is centred on the full screen (skin.ts placeContent) */
	body: Frame;
	/** what the screen shows now (a page whose two views differ: the lobby's menu and its Survivor window) */
	setContent(content?: DesignRect): void;
}

export interface ScreenOpts {
	color?: Color3;
	transparency?: number;
	zIndex?: number;
	/**
	 * What the screen shows, in design units: its window (centred on the full screen, pushed down only by a real
	 * overlap with a Roblox button), or -- the default -- the whole design space, for a page whose layout reaches the
	 * screen's edges (the lobby's logo, the shop's Back), which is kept clear of the buttons the same way.
	 */
	content?: DesignRect;
}

/**
 * Full-screen page or modal overlay; place content in `body` using 1120x630 design units.
 *
 * DESIGN_RULES UI-07: a window is centred on the FULL screen. The Roblox top bar is not a band across the top: its
 * buttons sit in a corner of it (GuiService.TopbarInset), so the rest of its height is screen like any other, and a
 * window only moves down when its own rect would really run under a button -- by exactly that much. The body used to
 * start below the bar across the whole width, which is what left every window visibly low (the owner's 1365 x 567
 * Settings: 85 px above it, 26 below).
 */
export function makeScreen(parent: Instance, name: string, opts?: ScreenOpts): Screen {
	const root = new Instance("Frame");
	root.Name = name;
	root.Size = UDim2.fromScale(1, 1);
	root.BackgroundColor3 = opts?.color ?? THEME.background;
	setWorldTransparency(root, opts?.transparency ?? 0);
	root.BorderSizePixel = 0;
	root.Active = true;
	if (opts?.zIndex !== undefined) root.ZIndex = opts.zIndex;
	// a transparent button under the content swallows clicks meant for whatever is behind the screen
	const blocker = new Instance("TextButton");
	blocker.Name = "InputBlocker";
	blocker.Size = UDim2.fromScale(1, 1);
	blocker.BackgroundTransparency = 1;
	blocker.BackgroundColor3 = THEME.background;
	blocker.TextColor3 = THEME.foreground;
	blocker.Text = "";
	blocker.AutoButtonColor = false;
	blocker.Selectable = false;
	blocker.ZIndex = 0;
	blocker.Parent = root;
	const body = new Instance("Frame");
	body.Name = "Body";
	body.ZIndex = 1;
	body.BackgroundTransparency = 1;
	body.BackgroundColor3 = THEME.background;
	body.BorderSizePixel = 0;
	setDesign(body, DESIGN_W, DESIGN_H);
	body.Parent = root;
	let content = opts?.content ?? FULL_SCREEN;
	// the design space at the one scale of the menus, where its content is centred on the full screen: in Scale of
	// the root (the whole screen), so a fractional px is exact instead of truncated to UDim's integer Offset
	const layout = (): void => {
		const v = viewportSize();
		const s = uiScale();
		const [x, y] = placeContent(v.X, v.Y, topBar(), s, content.x, content.y, content.w, content.h);
		body.Position = UDim2.fromScale(x / v.X, y / v.Y);
		body.Size = UDim2.fromScale((DESIGN_W * s) / v.X, (DESIGN_H * s) / v.Y);
	};
	onLayoutChange(root, layout);
	root.Parent = parent;
	return {
		root,
		body,
		setContent(shown?: DesignRect): void {
			const c = shown ?? FULL_SCREEN;
			if (c.x === content.x && c.y === content.y && c.w === content.w && c.h === content.h) return;
			content = c;
			layout();
		},
	};
}

/**
 * HUD cluster anchored to a screen corner/edge with a fixed aspect ratio (so it looks the same on
 * phones, 16:9 and 4:3). anchorX/anchorY in 0..1; margins in design units; `belowTopBar` keeps
 * top-anchored clusters clear of the Roblox top bar; `scale` (e.g. the "UI size" setting) enlarges it.
 */
export function makeAnchored(
	parent: Instance,
	name: string,
	anchorX: number,
	anchorY: number,
	w: number,
	h: number,
	marginX: number,
	marginY: number,
	belowTopBar: boolean,
	scale = 1,
): Frame {
	const f = new Instance("Frame");
	f.Name = name;
	f.AnchorPoint = new Vector2(anchorX, anchorY);
	f.BackgroundTransparency = 1;
	f.BackgroundColor3 = THEME.background;
	f.BorderSizePixel = 0;
	// `scale` enlarges the cluster on screen; its children keep laying out in the same w x h design space
	f.Size = UDim2.fromScale((w * scale) / DESIGN_W, (h * scale) / DESIGN_H);
	if (scale !== 1) f.SetAttribute("TextScale", scale);
	setDesign(f, w, h);
	addAspect(f, w / h);
	const mx = (anchorX === 0 ? 1 : anchorX === 1 ? -1 : 0) * (marginX / DESIGN_W);
	const my = (anchorY === 0 ? 1 : anchorY === 1 ? -1 : 0) * (marginY / DESIGN_H);
	onLayoutChange(f, () => {
		const inset = belowTopBar && anchorY === 0 ? topInset() : 0;
		f.Position = new UDim2(anchorX + mx, 0, anchorY + my, inset);
	});
	f.Parent = parent;
	return f;
}

// ---------------------------------------------------------------- Dialog

export interface DialogProps {
	w: number;
	h: number;
	title?: string;
	description?: string;
	/** lines reserved for the description (default 1) */
	descriptionLines?: number;
	zIndex?: number;
	/** top-right "X" (destructive icon button, as in the reference art) */
	closeButton?: boolean;
	onClose?: () => void;
	/**
	 * The scrim's transparency (default TRANSPARENCY.overlay: a modal dims the screen it opens over). A dialog that is
	 * a menu screen of its own, standing on the town flyover (How to play), passes 1: the flyover's scrim is the one.
	 */
	scrim?: number;
}

export interface DialogHandle {
	root: Frame;
	/** DialogContent: a popover panel */
	card: Frame;
	/** y (card design units) where the content starts, below the header */
	contentY: number;
	close(): void;
}

/** shadcn Dialog: scrim (background at 80%) + centred panel with its title strip (zoom-in-95 / fade-in) */
export function Dialog(layer: Instance, name: string, props: DialogProps): DialogHandle {
	const scrim = props.scrim ?? TRANSPARENCY.overlay;
	const rect = centredRect(props.w, props.h);
	const { root, body } = makeScreen(layer, name, {
		color: THEME.background,
		transparency: scrim,
		zIndex: props.zIndex,
		content: rect,
	});
	const card = Card(body, "DialogContent", { ...rect, variant: "popover" });
	let contentY = space(6);
	// the close button rides on the title strip, like the reference's red "X"
	const closeW = props.closeButton === true ? cardStripHeight() - space(2) : 0;
	if (props.title !== undefined) {
		contentY = CardHeader(card, props.title, props.description, {
			titleSize: TEXT.xl2,
			action: closeW > 0 ? closeW + space(2) : 0,
			lines: props.descriptionLines,
		});
	}
	let closed = false;
	const handle: DialogHandle = {
		root,
		card,
		contentY,
		close(): void {
			if (closed) return;
			closed = true;
			root.Destroy();
			props.onClose?.();
		},
	};
	if (closeW > 0) {
		// a pad player lands on the X (the caller may move the focus to something of its own after this): left on the
		// button that opened the dialog, behind its scrim, the pad could only reopen it
		const close = Button(card, "Close", "X", {
			x: props.w - CARD_STRIP_INSET - space(1) - closeW,
			y: CARD_STRIP_INSET + space(1),
			w: closeW,
			h: closeW,
			size: "icon",
			variant: "destructive",
			zIndex: card.ZIndex + 3,
			onClick: (): void => handle.close(),
		});
		autoFocus(close);
		// B / Backspace backs out of the dialog the way its X does (backStack.ts)
		registerBack(close, (): void => handle.close());
	}
	// entrance: fade the scrim in, zoom the card from 95% (both instant under Reduce Motion, via tween())
	root.BackgroundTransparency = 1;
	tween(root, 0.15, { BackgroundTransparency: worldTransparency(scrim) });
	const zoom = new Instance("UIScale");
	zoom.Scale = 0.95;
	zoom.Parent = card;
	tween(zoom, 0.15, { Scale: 1 });
	return handle;
}

// ---------------------------------------------------------------- Slider

export interface SliderProps {
	x: number;
	y: number;
	w: number;
	h: number;
	get: () => number;
	set: (v: number) => void;
	/** snapping step in 0..1 (default 0.05) */
	step?: number;
	zIndex?: number;
}

export interface SliderHandle {
	frame: TextButton;
	refresh: () => void;
	disconnect(): void;
}

const TRACK_H = 12;
/** the knob: a raised iron plate standing up, taller than the groove (the reference's pixel handle) */
const THUMB_W = 16;
const THUMB_H = 26;

/**
 * Slider in the plate vocabulary (DESIGN_RULES UI-07): a dark notched groove, the chosen amount filled in blue
 * (`tabActive`, "what is selected"), and a raised iron handle. Mouse/touch drag; with a gamepad or the keyboard,
 * select it and use left/right.
 */
export function Slider(parent: Instance, name: string, props: SliderProps): SliderHandle {
	const { w, h } = props;
	const step = props.step ?? 0.05;
	const hit = new Instance("TextButton");
	hit.Name = name;
	place(hit, parent, props.x, props.y, w, h);
	hit.BackgroundTransparency = 1;
	hit.BackgroundColor3 = THEME.background;
	hit.TextColor3 = THEME.foreground;
	hit.AutoButtonColor = false;
	hit.Text = "";
	hit.BorderSizePixel = 0;
	if (props.zIndex !== undefined) hit.ZIndex = props.zIndex;
	// left/right adjust the value instead of moving the selection
	hit.SelectionBehaviorLeft = Enum.SelectionBehavior.Stop;
	hit.SelectionBehaviorRight = Enum.SelectionBehavior.Stop;
	const z = hit.ZIndex;
	const inset = THUMB_W / 2;
	const trackW = w - inset * 2;
	const track = makeFrame(hit, "Track", inset, (h - TRACK_H) / 2, trackW, TRACK_H, THEME.background, {
		transparency: 1,
		zIndex: z + 1,
	});
	paintPlate(track, SURFACE.well, "flat", 2);
	// the range lives inside the groove, one relief unit in, and is clipped by it
	const inner = new Instance("Frame");
	inner.Name = "Inner";
	inner.BackgroundTransparency = 1;
	inner.BackgroundColor3 = THEME.background;
	inner.BorderSizePixel = 0;
	inner.ClipsDescendants = true;
	inner.ZIndex = z + 2;
	onLayoutChange(inner, () => {
		const u = reliefPx(2);
		inner.Position = new UDim2(0, u, 0, u);
		inner.Size = new UDim2(1, -2 * u, 1, -2 * u);
	});
	inner.Parent = track;
	const range = new Instance("Frame");
	range.Name = "Range";
	range.BackgroundColor3 = THEME.tabActive;
	range.BorderSizePixel = 0;
	range.Size = UDim2.fromScale(1, 1);
	range.ZIndex = z + 3;
	range.Parent = inner;
	const thumb = makeFrame(track, "Thumb", 0, (TRACK_H - THUMB_H) / 2, THUMB_W, THUMB_H, THEME.background, {
		transparency: 1,
		zIndex: z + 4,
	});
	thumb.AnchorPoint = new Vector2(0.5, 0.5);
	addAspect(thumb, THUMB_W / THUMB_H);

	const refresh = (): void => {
		const v = math.clamp(props.get(), 0, 1);
		range.Size = UDim2.fromScale(v, 1);
		thumb.Position = UDim2.fromScale(v, 0.5);
		// focused (gamepad / keyboard): the handle lights up like a hovered plate, in the ring colour
		const ring = isFocused(hit);
		paintPlate(thumb, ring ? THEME.ring : THEME.secondary, ring ? "hot" : "idle", 3);
	};
	const setValue = (v: number): void => {
		props.set(math.clamp(math.round(v / step) * step, 0, 1));
		refresh();
	};
	const apply = (px: number): void => {
		const rel = (px - track.AbsolutePosition.X) / math.max(track.AbsoluteSize.X, 1);
		setValue(rel);
	};
	registerFocus(hit, refresh);
	let dragging = false;
	const isPointer = (input: InputObject): boolean =>
		input.UserInputType === Enum.UserInputType.MouseButton1 || input.UserInputType === Enum.UserInputType.Touch;
	const conns: Array<RBXScriptConnection> = [
		hit.InputBegan.Connect((input: InputObject): void => {
			if (!isPointer(input)) return;
			dragging = true;
			apply(input.Position.X);
		}),
		hit.InputEnded.Connect((input: InputObject): void => {
			if (isPointer(input)) dragging = false;
		}),
		UserInputService.InputChanged.Connect((input: InputObject): void => {
			if (
				dragging &&
				(input.UserInputType === Enum.UserInputType.MouseMovement ||
					input.UserInputType === Enum.UserInputType.Touch)
			) {
				apply(input.Position.X);
			}
		}),
		UserInputService.InputEnded.Connect((input: InputObject): void => {
			if (isPointer(input)) dragging = false;
		}),
		UserInputService.InputBegan.Connect((input: InputObject): void => {
			if (!isFocused(hit)) return;
			const k = input.KeyCode;
			if (k === Enum.KeyCode.DPadLeft || k === Enum.KeyCode.Left) setValue(props.get() - step);
			else if (k === Enum.KeyCode.DPadRight || k === Enum.KeyCode.Right) setValue(props.get() + step);
		}),
	];
	refresh();
	hit.Parent = parent;
	return {
		frame: hit,
		refresh,
		disconnect(): void {
			for (const c of conns) c.Disconnect();
		},
	};
}

// ---------------------------------------------------------------- Toast (sonner)

export type ToastKind = "info" | "success" | "error" | "coin";

const MAX_TOASTS = 4;
const TOAST_TIME = 2.8;
const TOAST_W = 360;
const TOAST_H = 50;
const ICON = 22;

interface ToastStyle {
	frame: Color3;
	fg: Color3;
	icon: Color3;
	glyphColor: Color3;
	glyph: string;
	/** design text size (default TEXT.sm); errors read at body size, not the smaller label/caption size */
	textSize: number;
}

/**
 * Popover toasts with a semantic chip. Errors read as the same panel as every other kind, with `destructive`
 * only on the frame/chip and the message in `foreground` (~18.7:1 on the panel) — a solid `destructive` fill
 * behind `destructive-foreground` text only reaches ~3.7:1, below the 4.5:1 floor.
 */
function toastStyle(kind: ToastKind): ToastStyle {
	// glyphColor is text on the icon chip: THEME.foreground (UI-05), never the near-black body colour
	const base = { frame: SURFACE.frame, fg: THEME.popoverForeground, glyphColor: THEME.foreground, textSize: TEXT.sm };
	if (kind === "success") return { ...base, icon: GAME.success, glyph: "✓" };
	if (kind === "coin") return { ...base, icon: GAME.coin, glyph: "$" };
	if (kind === "error") {
		return { ...base, frame: THEME.destructive, icon: THEME.destructive, glyph: "!", textSize: TEXT.base };
	}
	return { ...base, icon: GAME.info, glyph: "i" };
}

function toastStack(layer: Instance): Frame {
	const existing = layer.FindFirstChild("ToastStack");
	if (existing !== undefined && existing.IsA("Frame")) return existing;
	// top-right corner, below the Roblox top bar and the HUD's bag button, above every panel of the layer
	const stack = makeAnchored(layer, "ToastStack", 1, 0, TOAST_W, (TOAST_H + 8) * MAX_TOASTS, 14, 84, true);
	stack.ZIndex = 1000;
	const layout = new Instance("UIListLayout");
	layout.SortOrder = Enum.SortOrder.LayoutOrder;
	layout.HorizontalAlignment = Enum.HorizontalAlignment.Right;
	layout.Padding = new UDim(8 / ((TOAST_H + 8) * MAX_TOASTS), 0);
	layout.Parent = stack;
	return stack;
}

let toastOrder = 0;

/** sonner-style toast: a small panel stacked in the top-right corner, newest first; duplicates merge */
export function showToast(layer: Instance, text: string, kind: ToastKind = "info"): void {
	const stack = toastStack(layer);
	for (const child of stack.GetChildren()) {
		if (child.IsA("Frame") && child.GetAttribute("Text") === text) {
			// same message again: refresh it instead of stacking a copy
			child.SetAttribute("Born", os.clock());
			child.LayoutOrder = -++toastOrder;
			return;
		}
	}
	const live: Array<Frame> = [];
	for (const child of stack.GetChildren()) {
		if (child.IsA("Frame")) live.push(child);
	}
	live.sort((a, b) => a.LayoutOrder > b.LayoutOrder);
	while (live.size() >= MAX_TOASTS) live.remove(0)?.Destroy();

	const style = toastStyle(kind);
	const slot = makeFrame(stack, "Toast", 0, 0, TOAST_W, TOAST_H, THEME.background, { transparency: 1 });
	slot.Position = new UDim2();
	slot.ZIndex = 1001;
	slot.LayoutOrder = -++toastOrder;
	slot.SetAttribute("Text", text);
	slot.SetAttribute("Born", os.clock());
	const card = makeSurface(slot, "Card", 0, 0, TOAST_W, TOAST_H, "panel", {
		border: style.frame,
		zIndex: 1002,
	});
	const icon = makeSurface(card, "Icon", space(4), (TOAST_H - ICON) / 2, ICON, ICON, "well", {
		fill: style.icon,
		border: style.icon,
		zIndex: 1003,
	});
	const glyph = makeLabel(icon, "Glyph", style.glyph, 0, 0, ICON, ICON, TEXT.sm, style.glyphColor, {
		weight: Enum.FontWeight.Bold,
		zIndex: 1004,
	});
	const textX = space(4) + ICON + space(3);
	const label = makeLabel(
		card,
		"Text",
		text,
		textX,
		0,
		TOAST_W - textX - space(4),
		TOAST_H,
		style.textSize,
		style.fg,
		{ font: "label", align: "left", zIndex: 1003 },
	);
	// enter: slide in from the right + fade (transient: the only use of transparency on toasts)
	const setFade = (t: number, time: number): void => {
		fadeSurface(card, time, t);
		fadeSurface(icon, time, t);
		fadeText(glyph, time, t);
		fadeText(label, time, t);
	};
	card.Position = UDim2.fromScale(0.12, 0);
	setSurfaceTransparency(card, 1);
	setSurfaceTransparency(icon, 1);
	glyph.TextTransparency = 1;
	label.TextTransparency = 1;
	tween(card, 0.2, { Position: UDim2.fromScale(0, 0) });
	setFade(0, 0.2);
	task.spawn(() => {
		while (slot.Parent !== undefined) {
			const born = slot.GetAttribute("Born");
			if (typeIs(born, "number") && os.clock() - born >= TOAST_TIME) break;
			task.wait(0.2);
		}
		if (slot.Parent === undefined) return;
		tween(card, 0.25, { Position: UDim2.fromScale(0.06, 0) });
		setFade(1, 0.25);
		task.wait(0.25);
		slot.Destroy();
	});
}

// ---------------------------------------------------------------- lists

export interface ScrollList {
	frame: ScrollingFrame;
	layout: UIListLayout;
	designW: number;
	designH: number;
}

export function makeScrollList(
	parent: Instance,
	name: string,
	x: number,
	y: number,
	w: number,
	h: number,
	opts?: FrameOpts,
): ScrollList {
	const f = new Instance("ScrollingFrame");
	f.Name = name;
	place(f, parent, x, y, w, h);
	f.BackgroundColor3 = THEME.card;
	setWorldTransparency(f, opts?.transparency ?? 1);
	f.BorderSizePixel = 0;
	if (opts?.zIndex !== undefined) f.ZIndex = opts.zIndex;
	f.ClipsDescendants = true;
	f.ScrollingDirection = Enum.ScrollingDirection.Y;
	f.CanvasSize = UDim2.fromOffset(0, 0);
	f.AutomaticCanvasSize = Enum.AutomaticSize.Y;
	// the reference's scroll bar: thin and LIGHT (`border`, 4,6:1 over the panel), the engine's rounded bar tinted;
	// 4 design units wide, a whole number of pixels at every scale
	f.ScrollBarImageColor3 = THEME.border;
	f.ScrollBarImageTransparency = 0;
	onLayoutChange(f, () => {
		f.ScrollBarThickness = reliefPx(4);
	});
	f.VerticalScrollBarInset = Enum.ScrollBarInset.ScrollBar;
	f.SelectionImageObject = NO_SELECTION_IMAGE;
	const layout = new Instance("UIListLayout");
	layout.SortOrder = Enum.SortOrder.LayoutOrder;
	layout.Padding = new UDim(0, 6);
	layout.Parent = f;
	const pad = new Instance("UIPadding");
	pad.PaddingRight = new UDim(0, 4);
	pad.Parent = f;
	f.Parent = parent;
	return { frame: f, layout, designW: w, designH: h };
}

/** keeps a row `rowH` design units tall, proportional to the list's width */
export function sizeRow(list: ScrollList, row: GuiObject, rowH: number): void {
	const resize = (): void => {
		const px = list.frame.AbsoluteSize.X;
		const h = px > 1 ? (px * rowH) / list.designW : rowH;
		row.Size = new UDim2(1, 0, 0, math.round(h));
	};
	resize();
	const conn = list.frame.GetPropertyChangedSignal("AbsoluteSize").Connect(resize);
	row.Destroying.Connect(() => conn.Disconnect());
}

/**
 * Static row for a ScrollList: full width, `rowH` design units tall; children use a (list width) x rowH design
 * space. Look: a well sunk into the panel (flat fill + 1 px border).
 */
export function makeListRow(list: ScrollList, name: string, order: number, rowH: number, color?: Color3): Frame {
	const row = new Instance("Frame");
	row.Name = name;
	row.BorderSizePixel = 0;
	row.LayoutOrder = order;
	setDesign(row, list.designW, rowH);
	paintSurface(row, wellSurface(color ?? SURFACE.well, SURFACE.line));
	sizeRow(list, row, rowH);
	row.Parent = list.frame;
	return row;
}

/**
 * Clickable row for a ScrollList (the row IS the button): a well that fills with the frame colour on hover /
 * press / gamepad selection, and whose own TextLabels switch to accent-foreground meanwhile (put the row's
 * labels directly inside it; use >= TEXT.sm and SemiBold/Bold). Children use (list width) x rowH.
 */
export function ListRowButton(
	list: ScrollList,
	name: string,
	order: number,
	rowH: number,
	onClick: () => void,
): TextButton {
	const b = buildButton(list.frame, name, "", { x: 0, y: 0, w: list.designW, h: rowH, onClick }, "row", row =>
		sizeRow(list, row, rowH),
	);
	b.LayoutOrder = order;
	return b;
}

/**
 * The rows of a ScrollList, kept and reused: the world renderer's Frame pool (shared/engine/renderer.ts) for a
 * list. A render asks for its rows in list order, each under the KEY of what it shows (an item id, a recipe id):
 *  - a key the last render also showed gets the same row back, so a row whose data did not change has nothing
 *    to rewrite, and a re-sorted list only moves rows (LayoutOrder);
 *  - a new key takes a row a vanished key left behind, and a row is only created when there is none;
 *  - finish() hides the rows no key asked for; they are kept for the next new key, never destroyed.
 * Once a list has been as long as it gets, rendering it again creates no Instance at all.
 *
 *   pool.begin(); for (const item of items) fill(pool.acquire(keyOf(item)), item); pool.finish();
 *
 * Keys must be unique within one render.
 */
export class RowPool<T extends { frame: GuiObject }> {
	readonly list: ScrollList;
	private readonly make: (list: ScrollList, index: number) => T;
	/** rows by the key they showed in the last render */
	private shown = new Map<string, T>();
	/** rows by the key they show in the render going on */
	private next = new Map<string, T>();
	/** rows no key uses: hidden, ready for a key the list has not shown yet */
	private readonly spare: Array<T> = [];
	private built = 0;
	private order = 0;

	constructor(list: ScrollList, make: (list: ScrollList, index: number) => T) {
		this.list = list;
		this.make = make;
	}

	/** starts a render */
	begin(): void {
		this.order = 0;
		this.next.clear();
	}

	/** the row for `key`, placed next in the list: the one that showed it last time, a spare one, or a new one */
	acquire(key: string): T {
		let row = this.shown.get(key);
		if (row !== undefined) this.shown.delete(key);
		else row = this.spare.pop() ?? this.make(this.list, this.built++);
		this.next.set(key, row);
		if (row.frame.LayoutOrder !== this.order) row.frame.LayoutOrder = this.order;
		this.order += 1;
		setVisible(row.frame, true);
		return row;
	}

	/** ends a render: the rows of keys that are gone are hidden and kept for a later key */
	finish(): void {
		for (const [, row] of this.shown) {
			setVisible(row.frame, false);
			this.spare.push(row);
		}
		const done = this.shown;
		done.clear();
		this.shown = this.next;
		this.next = done;
	}

	/** rows shown by the last render */
	count(): number {
		return this.order;
	}
}

// ---------------------------------------------------------------- composite widgets

export interface CoinPill {
	frame: GuiObject;
	refresh(): void;
}

/** coin icon: a chart-3 chip with a "$" in THEME.foreground (the chip carries the contrast, UI-05) */
export function CoinIcon(parent: Instance, name: string, x: number, y: number, size: number, zIndex?: number): Frame {
	const z = zIndex ?? 2;
	const icon = makeSurface(parent, name, x, y, size, size, "well", {
		fill: GAME.coin,
		border: GAME.coin,
		zIndex: z,
	});
	// the glyph is text (UI-04/UI-05): always THEME.foreground, never the near-black body colour
	makeLabel(icon, "Glyph", "$", 0, 0, size, size, size * 0.62, THEME.foreground, {
		weight: Enum.FontWeight.ExtraBold,
		zIndex: z + 1,
	});
	return icon;
}

/** coin balance: coin chip (chart-3) + amount in foreground mono; `onClick` makes it a pressable plate */
export function makeCoinPill(
	parent: Instance,
	name: string,
	x: number,
	y: number,
	w: number,
	h: number,
	getMoney: () => number,
	onClick?: () => void,
): CoinPill {
	const frame: GuiObject =
		onClick !== undefined
			? Button(parent, name, "", { x, y, w, h, variant: "outline", onClick })
			: makeSurface(parent, name, x, y, w, h, "well");
	const iconSize = h - space(5);
	CoinIcon(frame, "Icon", space(3), (h - iconSize) / 2, iconSize, frame.ZIndex + 1);
	const textX = space(3) + iconSize + space(3);
	const amount = makeLabel(frame, "Amount", "", textX, 0, w - textX - space(4), h, h * 0.42, THEME.foreground, {
		font: "numeric",
		align: "left",
		zIndex: frame.ZIndex + 1,
	});
	const pill: CoinPill = {
		frame,
		refresh(): void {
			amount.Text = fmtInt(getMoney());
		},
	};
	pill.refresh();
	return pill;
}

// ---------------------------------------------------------------- formatting

export function nl(s: string): string {
	const parts = s.split("#");
	return parts.join("\n");
}

/** 2 decimals max, no trailing zeros ("0.5", "1.25", "3") */
export function fmtNum(v: number): string {
	const r = math.round(v * 100) / 100;
	if (r === math.floor(r)) return `${r}`;
	return string.format("%.2f", r).gsub("0+$", "")[0];
}

/** integer with thousands separators ("12,345") */
export function fmtInt(v: number): string {
	const n = math.floor(math.abs(v) + 0.5);
	let s = `${n}`;
	let out = "";
	while (s.size() > 3) {
		out = `,${s.sub(-3)}${out}`;
		s = s.sub(1, -4);
	}
	return `${v < 0 ? "-" : ""}${s}${out}`;
}

/** seconds with 2 decimals max ("0.23 s", "1.5 s") */
export function fmtSeconds(v: number): string {
	return `${fmtNum(v)} s`;
}
