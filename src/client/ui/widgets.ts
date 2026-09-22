/*
 * Project Z UI kit: the shadcn/ui vocabulary (Button, Card, Badge, Progress, Tabs, Separator, Dialog, Slider,
 * Toast) rebuilt on Roblox GuiObjects, styled only through theme.ts.
 *
 * Layout: every widget is placed in "design units" relative to its parent (the root screen is 1120 x 630);
 * positions/sizes are converted to Scale, so the layout follows the screen. Parents created here carry
 * DesignW/DesignH attributes so children can be placed in the parent's own design space.
 *
 * Rules:
 * - colours, fonts, radius and spacing come from theme.ts (never literals in the screens)
 * - flat, like the theme: no shadows; surfaces are separated by a 1 px `border` UIStroke; corners use --radius
 * - text is TextScaled + UITextSizeConstraint (max = design size x current UI scale), so it never overflows its
 *   box on phones and is not tiny on 1080p/1440p; borders scale the same way (1 px up to ~1440p)
 * - buttons have hover / press / disabled states and a 2 px `ring` when selected with a gamepad or keyboard
 *   (GuiService.SelectedObject), replacing Roblox's default selection highlight
 * - full screens use makeScreen(): the content is letterboxed at 16:9 inside the safe area (below the Roblox
 *   top bar); HUD clusters use makeAnchored() (corner anchored, fixed aspect ratio)
 */
import { BORDER, GAME, RADIUS, SIDEBAR, TEXT, THEME, TRANSPARENCY, TextRole, fontOf, roleFont, space } from "./theme";

const GuiService = game.GetService("GuiService");
const TweenService = game.GetService("TweenService");
const UserInputService = game.GetService("UserInputService");
const Workspace = game.GetService("Workspace");

export const DESIGN_W = 1120;
export const DESIGN_H = 630;

// ---------------------------------------------------------------- safe area & scale

/** height (px) covered by the Roblox top bar; our ScreenGui ignores the inset, so we keep clear of it */
export function topInset(): number {
	const [topLeft] = GuiService.GetGuiInset();
	let inset = topLeft.Y;
	const [ok, value] = pcall(() => GuiService.TopbarInset);
	if (ok) {
		const rect = value as Rect;
		if (rect.Height > 0) inset = math.max(inset, rect.Max.Y);
	}
	return math.max(0, inset);
}

export function viewportSize(): Vector2 {
	const cam = Workspace.CurrentCamera;
	if (cam !== undefined && cam.ViewportSize.X > 1 && cam.ViewportSize.Y > 1) return cam.ViewportSize;
	return new Vector2(DESIGN_W, DESIGN_H);
}

/** pixels per design unit of a letterboxed 1120x630 layout on the current screen */
export function uiScale(): number {
	const v = viewportSize();
	return math.max(0.35, math.min(v.X / DESIGN_W, (v.Y - topInset()) / DESIGN_H));
}

/** screen px for a border of `width` design px: 1 px up to ~1440p, thicker on 4K (like CSS px on a HiDPI screen) */
export function hairline(width: number): number {
	if (width <= 0) return 0;
	return math.max(1, math.round((width * uiScale()) / 1.6));
}

const textConstraints = new Map<UITextSizeConstraint, number>();
const strokeWidths = new Map<UIStroke, number>();

function applyTextSize(c: UITextSizeConstraint, designSize: number): void {
	const max = math.clamp(math.round(designSize * uiScale()), 6, 100);
	c.MaxTextSize = max;
	c.MinTextSize = math.clamp(math.floor(max * 0.5), 5, max);
}

/** TextScaled with a design-size cap (kept in sync with the screen size) */
export function scaleText(obj: TextLabel | TextButton | TextBox, designSize: number): UITextSizeConstraint {
	obj.TextScaled = true;
	let c = obj.FindFirstChildOfClass("UITextSizeConstraint");
	if (c === undefined) {
		c = new Instance("UITextSizeConstraint");
		const created = c;
		created.Destroying.Connect(() => textConstraints.delete(created));
		c.Parent = obj;
	}
	textConstraints.set(c, designSize);
	applyTextSize(c, designSize);
	return c;
}

/** sets a kit stroke's width in design px (kept in sync with the screen size) */
export function setStrokeWidth(s: UIStroke, width: number): void {
	if (!strokeWidths.has(s)) s.Destroying.Connect(() => strokeWidths.delete(s));
	strokeWidths.set(s, width);
	s.Thickness = hairline(width);
}

const insetListeners = new Set<() => void>();

function refreshAll(): void {
	for (const [c, size] of textConstraints) {
		if (c.Parent === undefined) {
			textConstraints.delete(c);
		} else {
			applyTextSize(c, size);
		}
	}
	for (const [s, width] of strokeWidths) {
		if (s.Parent === undefined) {
			strokeWidths.delete(s);
		} else {
			s.Thickness = hairline(width);
		}
	}
	for (const fn of insetListeners) fn();
}

let refreshQueued = false;
function queueRefresh(): void {
	if (refreshQueued) return;
	refreshQueued = true;
	task.defer(() => {
		refreshQueued = false;
		refreshAll();
	});
}

let watchedCamera: Camera | undefined;
let cameraConn: RBXScriptConnection | undefined;
function watchCamera(): void {
	const cam = Workspace.CurrentCamera;
	if (cam === watchedCamera) return;
	watchedCamera = cam;
	cameraConn?.Disconnect();
	cameraConn = cam?.GetPropertyChangedSignal("ViewportSize").Connect(queueRefresh);
	queueRefresh();
}
watchCamera();
Workspace.GetPropertyChangedSignal("CurrentCamera").Connect(watchCamera);
pcall(() => GuiService.GetPropertyChangedSignal("TopbarInset").Connect(queueRefresh));

/** runs `fn` now and whenever the screen size / top bar changes, until `owner` is destroyed */
export function onLayoutChange(owner: Instance, fn: () => void): void {
	insetListeners.add(fn);
	owner.Destroying.Connect(() => insetListeners.delete(fn));
	fn();
}

// ---------------------------------------------------------------- focus (gamepad / keyboard selection)

/** replaces Roblox's default selection highlight: the kit draws a `ring` stroke instead */
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
function registerFocus(obj: GuiObject, refresh: () => void): void {
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

// ---------------------------------------------------------------- design-space helpers

function designOf(parent: Instance): [number, number] {
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

/** 1 px border (UIStroke) in `border` colour by default */
export function addStroke(g: GuiObject, color = THEME.border, transparency = 0, width = BORDER.width): UIStroke {
	const s = new Instance("UIStroke");
	s.Color = color;
	s.Transparency = transparency;
	s.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
	s.LineJoinMode = Enum.LineJoinMode.Round;
	setStrokePosition(s, true);
	setStrokeWidth(s, width);
	s.Parent = g;
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

export function tween<T extends Instance>(obj: T, time: number, props: Partial<ExtractMembers<T, Tweenable>>): Tween {
	const t = TweenService.Create(obj, new TweenInfo(time, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), props);
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

// ---------------------------------------------------------------- frames & text

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
	if (opts?.transparency !== undefined) f.BackgroundTransparency = opts.transparency;
	if (opts?.zIndex !== undefined) f.ZIndex = opts.zIndex;
	if (opts?.clips !== undefined) f.ClipsDescendants = opts.clips;
	if (opts?.radius !== undefined && opts.radius > 0) addCorner(f, opts.radius, w, h);
	if (opts?.stroke !== undefined) {
		addStroke(f, opts.stroke, opts.strokeTransparency ?? 0, opts.strokeThickness ?? BORDER.width);
	}
	f.Parent = parent;
	return f;
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

/** changes the design text size of a label/button created by this kit */
export function setTextSize(obj: TextLabel | TextButton, designSize: number): void {
	scaleText(obj, designSize * inheritedTextScale(obj));
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
 * Colours of a variant, all exact theme tokens (no mixing):
 * - filled variants (default / secondary / destructive / active tab) keep their colours on hover and show the
 *   `ring` outline instead (the tweakcn palette has no hover shade for them);
 * - outline / ghost / inactive tab / list row switch to `accent` on hover, press and selection;
 * - sidebar items use the sidebar palette (hover = sidebar-accent, selected = sidebar-primary).
 */
interface VariantSpec {
	bg: Color3;
	/** 0 = filled, 1 = transparent until hovered */
	bgT: number;
	fg: Color3;
	stroke: Color3;
	strokeT: number;
	/** hover / press / selection background (undefined = keep the colours and show the ring) */
	hover: Color3 | undefined;
	hoverFg: Color3;
	ring: Color3;
	/** inner ring (rows and rail items live in clipped containers) */
	ringInner: boolean;
	/** recolour the button's own TextLabels to hoverFg while highlighted (rows) */
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

function spec(
	bg: Color3,
	bgT: number,
	fg: Color3,
	stroke: Color3,
	strokeT: number,
	hover: Color3 | undefined,
	hoverFg: Color3,
	extra?: Partial<VariantSpec>,
): VariantSpec {
	return {
		bg,
		bgT,
		fg,
		stroke,
		strokeT,
		hover,
		hoverFg,
		ring: THEME.ring,
		ringInner: false,
		recolorChildren: false,
		...extra,
	};
}

/** shadcn/ui button recipes mapped onto the author's role spec (see theme.ts) */
function variantSpec(v: AnyVariant): VariantSpec {
	const t = THEME;
	if (v === "secondary") {
		return spec(t.secondary, 0, t.secondaryForeground, t.border, 1, undefined, t.secondaryForeground);
	}
	if (v === "destructive") {
		return spec(t.destructive, 0, t.destructiveForeground, t.border, 1, undefined, t.destructiveForeground);
	}
	if (v === "outline") return spec(t.background, 1, t.foreground, t.border, 0, t.accent, t.accentForeground);
	if (v === "ghost") return spec(t.background, 1, t.foreground, t.border, 1, t.accent, t.accentForeground);
	if (v === "tab") {
		return spec(t.background, 1, t.mutedForeground, t.border, 1, t.accent, t.accentForeground, { ringInner: true });
	}
	if (v === "tabActive") {
		return spec(t.secondary, 0, t.secondaryForeground, t.border, 1, undefined, t.secondaryForeground, {
			ringInner: true,
		});
	}
	if (v === "row") {
		return spec(t.card, 0, t.cardForeground, t.border, 0, t.accent, t.accentForeground, {
			ringInner: true,
			recolorChildren: true,
		});
	}
	if (v === "nav") {
		return spec(
			SIDEBAR.background,
			1,
			SIDEBAR.foreground,
			SIDEBAR.border,
			1,
			SIDEBAR.accent,
			SIDEBAR.accentForeground,
			{
				ring: SIDEBAR.ring,
				ringInner: true,
				recolorChildren: true,
			},
		);
	}
	if (v === "navActive") {
		return spec(
			SIDEBAR.primary,
			0,
			SIDEBAR.primaryForeground,
			SIDEBAR.border,
			1,
			undefined,
			SIDEBAR.primaryForeground,
			{
				ring: SIDEBAR.ring,
				ringInner: true,
			},
		);
	}
	return spec(t.primary, 0, t.primaryForeground, t.border, 1, undefined, t.primaryForeground);
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
		if (!child.IsA("TextLabel")) continue;
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

/** focus ring outside a button with a gap (ring-offset); created on first focus / hover */
function makeOffsetRing(b: TextButton): Frame {
	const f = new Instance("Frame");
	f.Name = "FocusRing";
	f.AnchorPoint = new Vector2(0.5, 0.5);
	f.Position = UDim2.fromScale(0.5, 0.5);
	f.BackgroundColor3 = THEME.background;
	f.BackgroundTransparency = 1;
	f.BorderSizePixel = 0;
	f.Active = false;
	f.Selectable = false;
	f.ZIndex = b.ZIndex;
	const corner = b.FindFirstChildOfClass("UICorner");
	if (corner !== undefined) {
		const c = new Instance("UICorner");
		c.CornerRadius = corner.CornerRadius;
		c.Parent = f;
	}
	addStroke(f, THEME.ring, 0, BORDER.ring);
	onLayoutChange(f, () => {
		// ring (2) + offset gap (2), in screen px that follow the UI scale like every border
		const grow = (hairline(BORDER.ring) + hairline(BORDER.ring)) * 2;
		f.Size = new UDim2(1, grow, 1, grow);
	});
	f.Parent = b;
	return f;
}

/** redraws a kit button from its variant, GuiState, disabled flag and focus (instant: tokens are never blended) */
function refreshButton(b: TextButton): void {
	const s = variantSpec(variantOf(b));
	const disabled = isDisabled(b);
	const state = b.GuiState;
	const focus = isFocused(b) && !disabled;
	const hot = !disabled && (focus || state === Enum.GuiState.Hover || state === Enum.GuiState.Press);
	let bg = s.bg;
	let bgT = s.bgT;
	let fg = s.fg;
	let stroke = s.stroke;
	let strokeT = s.strokeT;
	let ring = focus;
	if (disabled) {
		// disabled, every variant: transparent fill (bg-muted equals bg-background/card here, so an opaque
		// muted fill used to disappear into the surface behind it) + opaque `border` outline so the control
		// still reads as a control, and `muted-foreground` text. mutedForeground (#8c8c7d) on the real
		// background (#10100e) is ~5.6:1 (>= 4.5:1 AA); no global transparency is applied to the text itself.
		bg = THEME.background;
		bgT = 1;
		fg = THEME.mutedForeground;
		stroke = THEME.border;
		strokeT = 0;
	} else if (hot) {
		if (s.hover !== undefined) {
			bg = s.hover;
			bgT = 0;
			fg = s.hoverFg;
		} else {
			ring = true;
		}
	}
	b.BackgroundColor3 = bg;
	b.BackgroundTransparency = bgT;
	b.TextColor3 = fg;
	// rows / tabs / rail items (clipped containers): the border itself becomes the ring;
	// buttons: shadcn `ring-2 ring-offset-2`, a ring separated from the button by a gap (visible on any fill)
	const innerRing = ring && s.ringInner;
	const border = b.FindFirstChild("Border");
	if (border !== undefined && border.IsA("UIStroke")) {
		border.Color = innerRing ? s.ring : stroke;
		border.Transparency = innerRing ? 0 : strokeT;
		setStrokeWidth(border, innerRing ? BORDER.ring : BORDER.width);
	}
	const offsetRing = b.FindFirstChild("FocusRing");
	if (ring && !s.ringInner) {
		const f = offsetRing !== undefined && offsetRing.IsA("Frame") ? offsetRing : makeOffsetRing(b);
		const rs = f.FindFirstChildOfClass("UIStroke");
		if (rs !== undefined) rs.Color = s.ring;
		f.Visible = true;
	} else if (offsetRing !== undefined && offsetRing.IsA("Frame")) {
		offsetRing.Visible = false;
	}
	if (disabled) recolorLabels(b, THEME.mutedForeground);
	else if (hot && s.recolorChildren && s.hover !== undefined) recolorLabels(b, s.hoverFg);
	else recolorLabels(b, undefined);
	// press feedback without colour changes
	const press = b.FindFirstChild("Press");
	if (press !== undefined && press.IsA("UIScale")) {
		tween(press, 0.06, { Scale: !disabled && state === Enum.GuiState.Press ? 0.97 : 1 });
	}
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
	/** corner radius in design units (default RADIUS.lg) */
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
	b.Text = text;
	b.FontFace = resolveFont(props.font, "label");
	b.TextWrapped = true;
	b.TextXAlignment = xAlign(props.align);
	b.TextStrokeColor3 = THEME.background;
	if (props.align === "left" || props.align === "right") {
		const pad = new Instance("UIPadding");
		pad.PaddingLeft = new UDim(size.padX / w, 0);
		pad.PaddingRight = new UDim(size.padX / w, 0);
		pad.Parent = b;
	}
	if (props.zIndex !== undefined) b.ZIndex = props.zIndex;
	scaleText(b, (props.textSize ?? size.text) * inheritedTextScale(parent));
	addCorner(b, props.radius ?? RADIUS.lg, w, h);
	const border = addStroke(b, THEME.border, 1);
	border.Name = "Border";
	const press = new Instance("UIScale");
	press.Name = "Press";
	press.Parent = b;
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

// ---------------------------------------------------------------- Card

/**
 * default: bg-card (panels and windows); hud: card over the game world (TRANSPARENCY.hud);
 * muted: bg-muted tile inside a card; popover: dialogs, toasts, tooltips, banners (always bordered)
 */
export type CardVariant = "default" | "hud" | "muted" | "popover";

export interface CardProps {
	x: number;
	y: number;
	w: number;
	h: number;
	variant?: CardVariant;
	/** background transparency (only for surfaces over the game world; default: 0, hud: TRANSPARENCY.hud) */
	transparency?: number;
	/** inner padding used by the Card* helpers (default space(6), like shadcn's px-6/py-6) */
	pad?: number;
	/** border colour override, a token (e.g. GAME.success for an owned item) */
	border?: Color3;
	zIndex?: number;
	clips?: boolean;
}

function cardColors(variant: CardVariant): [Color3, Color3] {
	if (variant === "popover") return [THEME.popover, THEME.popoverForeground];
	if (variant === "muted") return [THEME.muted, THEME.foreground];
	return [THEME.card, THEME.cardForeground];
}

export function Card(parent: Instance, name: string, props: CardProps): Frame {
	const variant = props.variant ?? "default";
	const [bg] = cardColors(variant);
	const f = makeFrame(parent, name, props.x, props.y, props.w, props.h, bg, {
		transparency: props.transparency ?? (variant === "hud" ? TRANSPARENCY.hud : 0),
		radius: RADIUS.lg,
		stroke: props.border ?? THEME.border,
		zIndex: props.zIndex,
		clips: props.clips,
	});
	f.SetAttribute("Pad", props.pad ?? space(6));
	f.SetAttribute("CardVariant", variant);
	return f;
}

function cardBox(card: Frame): [number, number, number] {
	const [w, h] = designOf(card);
	const pad = card.GetAttribute("Pad");
	return [w, h, typeIs(pad, "number") ? pad : space(6)];
}

function cardForeground(card: Frame): Color3 {
	const v = card.GetAttribute("CardVariant");
	return cardColors(v === "popover" || v === "muted" || v === "hud" ? v : "default")[1];
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

/** CardTitle: font-semibold, card-foreground (popover-foreground in a popover) */
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
}

/** height of a CardHeader (from the card's top edge to where the content starts) for a card padding `pad` */
export function cardHeaderHeight(pad = space(6), titleSize = TEXT.xl, descriptionLines = 0): number {
	let y = pad + math.ceil(titleSize * 1.3);
	if (descriptionLines > 0) y += space(1.5) + math.ceil(TEXT.sm * 1.5 * descriptionLines);
	return y + space(4);
}

/** CardHeader (title + optional description); returns the y where the content starts */
export function CardHeader(card: Frame, title: string, description?: string, opts?: CardHeaderOpts): number {
	const [w, , pad] = cardBox(card);
	const titleSize = opts?.titleSize ?? TEXT.xl;
	const innerW = w - pad * 2 - (opts?.action ?? 0);
	const titleH = math.ceil(titleSize * 1.3);
	CardTitle(card, title, { w: innerW, size: titleSize });
	let y = pad + titleH;
	if (description !== undefined && description !== "") {
		const lines = opts?.lines ?? 1;
		const descH = math.ceil(TEXT.sm * 1.5 * lines);
		CardDescription(card, description, { y: y + space(1.5), w: innerW, h: descH });
		y += space(1.5) + descH;
	}
	return y + space(4);
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

// ---------------------------------------------------------------- Badge

export type BadgeVariant = "default" | "secondary" | "outline" | "destructive";

export interface BadgeProps {
	x: number;
	y: number;
	/** default: fits the text */
	w?: number;
	h?: number;
	variant?: BadgeVariant;
	/** semantic accent from theme.GAME (e.g. success, xp, rare); drawn as the border, text stays `foreground` */
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

function badgeColors(variant: BadgeVariant, color: Color3 | undefined): [Color3, number, Color3, Color3, number] {
	// a GAME.* accent as a SOLID fill can't clear 4.5:1 against either foreground or background text (e.g.
	// GAME.success only reaches ~4.2:1 on foreground, GAME.xp ~4.0:1) — read it as an outline chip instead:
	// transparent fill, the accent as an opaque border, `foreground` text (~18.7:1 on the real background)
	if (color !== undefined) return [THEME.background, 1, THEME.foreground, color, 0];
	if (variant === "secondary") return [THEME.secondary, 0, THEME.secondaryForeground, THEME.border, 1];
	// same reasoning as above: destructive-on-destructive only reaches ~3.7:1, so this badge reads as a
	// destructive-bordered outline chip too instead of a solid destructive fill
	if (variant === "destructive") return [THEME.background, 1, THEME.foreground, THEME.destructive, 0];
	if (variant === "outline") return [THEME.background, 1, THEME.foreground, THEME.border, 0];
	return [THEME.primary, 0, THEME.primaryForeground, THEME.border, 1];
}

/** shadcn Badge: small rounded-md label, text-xs font-medium */
export function Badge(parent: Instance, name: string, text: string, props: BadgeProps): Frame {
	const h = props.h ?? 22;
	const size = props.textSize ?? TEXT.xs;
	const w = props.w ?? badgeWidth(text, size, h);
	const [bg, bgT, fg, border, strokeT] = badgeColors(props.variant ?? "default", props.color);
	const zIndex = props.zIndex ?? 2;
	const f = makeFrame(parent, name, props.x, props.y, w, h, bg, {
		transparency: bgT,
		radius: RADIUS.md,
		stroke: border,
		strokeTransparency: strokeT,
		zIndex,
	});
	makeLabel(f, "Text", text, space(1.5), 0, w - space(3), h, size, fg, {
		font: fontOf("sans", Enum.FontWeight.Medium),
		zIndex: zIndex + 1,
	});
	return f;
}

/** updates a Badge's text (and, for a custom-colour badge, its border accent — the fill stays transparent) */
export function setBadge(badge: Frame, text: string, color?: Color3): void {
	const label = badge.FindFirstChild("Text");
	if (label !== undefined && label.IsA("TextLabel")) label.Text = text;
	if (color !== undefined) {
		const stroke = badge.FindFirstChildOfClass("UIStroke");
		if (stroke !== undefined) stroke.Color = color;
	}
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

/** shadcn Separator: 1 px line in `border` colour */
export function Separator(parent: Instance, name: string, props: SeparatorProps): Frame {
	const [dw, dh] = designOf(parent);
	const f = new Instance("Frame");
	f.Name = name;
	f.BackgroundColor3 = props.color ?? THEME.border;
	f.BorderSizePixel = 0;
	if (props.zIndex !== undefined) f.ZIndex = props.zIndex;
	f.Position = UDim2.fromScale(props.x / dw, props.y / dh);
	onLayoutChange(f, () => {
		const px = hairline(BORDER.width);
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

/** shadcn Progress: `secondary` track + indicator in a semantic colour */
export function Progress(parent: Instance, name: string, props: ProgressProps): Bar {
	const { w, h } = props;
	const radius = math.min(RADIUS.lg, h / 2);
	const frame = makeFrame(parent, name, props.x, props.y, w, h, THEME.secondary, {
		radius,
		zIndex: props.zIndex,
	});
	const fill = makeFrame(frame, "Fill", 0, 0, w, h, props.color ?? THEME.primary, { radius });
	fill.ZIndex = frame.ZIndex + 1;
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
			{
				font: "numeric",
				zIndex: frame.ZIndex + 2,
			},
		);
		label.TextStrokeColor3 = GAME.textOutline;
		label.TextStrokeTransparency = 0.55;
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
}

export interface TabsHandle {
	/** TabsList */
	frame: Frame;
	/** TabsTrigger buttons, one per item */
	triggers: Array<TextButton>;
	/** marks `index` as the active trigger (no onChange) */
	setActive(index: number): void;
}

/** shadcn Tabs: TabsList (muted, bordered); active trigger = secondary, inactive = muted text, hover = accent */
export function Tabs(parent: Instance, name: string, props: TabsProps): TabsHandle {
	const { w, h, items } = props;
	const list = makeFrame(parent, name, props.x, props.y, w, h, THEME.muted, {
		radius: RADIUS.lg,
		stroke: THEME.border,
		zIndex: props.zIndex,
	});
	const gap = 3;
	const n = math.max(items.size(), 1);
	const triggerW = (w - gap * 2 - gap * (n - 1)) / n;
	const triggers: Array<TextButton> = [];
	const handle: TabsHandle = {
		frame: list,
		triggers,
		setActive(index: number): void {
			for (let i = 0; i < triggers.size(); i++) applyVariant(triggers[i], i === index ? "tabActive" : "tab");
		},
	};
	for (let i = 0; i < items.size(); i++) {
		const index = i;
		const t = buildButton(
			list,
			`Tab${i}`,
			items[i],
			{
				x: gap + i * (triggerW + gap),
				y: gap,
				w: triggerW,
				h: h - gap * 2,
				textSize: props.textSize ?? TEXT.sm,
				radius: RADIUS.md,
				zIndex: list.ZIndex + 1,
				onClick: (): void => {
					handle.setActive(index);
					props.onChange?.(index);
				},
			},
			"tab",
		);
		triggers.push(t);
	}
	handle.setActive(props.value ?? 0);
	return handle;
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

/**
 * Navigation rail with the neutral sidebar palette: bg sidebar + sidebar-border; items in sidebar-foreground,
 * hover = sidebar-accent, selected = sidebar-primary / sidebar-primary-foreground, focus ring = sidebar-ring.
 */
export function Sidebar(parent: Instance, name: string, props: SidebarProps): SidebarHandle {
	const { w, h, items } = props;
	const rail = makeFrame(parent, name, props.x, props.y, w, h, SIDEBAR.background, {
		radius: RADIUS.lg,
		stroke: SIDEBAR.border,
		zIndex: props.zIndex,
	});
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
			badges.get(index)?.Destroy();
			badges.delete(index);
			if (text === undefined || text === "" || buttons[index] === undefined) return;
			// on the rail (not inside the item, whose text padding would shift it), right-aligned in the item
			const bw = badgeWidth(text, TEXT.xs, NAV_BADGE_H);
			const badge = Badge(rail, `Badge${index}`, text, {
				x: w - pad - space(2) - bw,
				y: itemY(index) + (itemH - NAV_BADGE_H) / 2,
				w: bw,
				h: NAV_BADGE_H,
				variant: color === undefined ? "secondary" : undefined,
				color,
				zIndex: rail.ZIndex + 3,
			});
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
				radius: RADIUS.md,
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

export interface Screen {
	/** full-screen background (blocks clicks to what is below) */
	root: Frame;
	/** letterboxed 1120x630 design space inside the safe area */
	body: Frame;
}

export interface ScreenOpts {
	color?: Color3;
	transparency?: number;
	zIndex?: number;
}

/** full-screen page or modal overlay; place content in `body` using 1120x630 design units */
export function makeScreen(parent: Instance, name: string, opts?: ScreenOpts): Screen {
	const root = new Instance("Frame");
	root.Name = name;
	root.Size = UDim2.fromScale(1, 1);
	root.BackgroundColor3 = opts?.color ?? THEME.background;
	root.BackgroundTransparency = opts?.transparency ?? 0;
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
	body.AnchorPoint = new Vector2(0.5, 0.5);
	body.BackgroundTransparency = 1;
	body.BackgroundColor3 = THEME.background;
	body.BorderSizePixel = 0;
	setDesign(body, DESIGN_W, DESIGN_H);
	addAspect(body, DESIGN_W / DESIGN_H);
	body.Parent = root;
	onLayoutChange(root, () => {
		const inset = topInset();
		body.Size = new UDim2(1, 0, 1, -inset);
		body.Position = new UDim2(0.5, 0, 0.5, inset / 2);
	});
	root.Parent = parent;
	return { root, body };
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
	/** top-right "X" (secondary icon button) */
	closeButton?: boolean;
	onClose?: () => void;
}

export interface DialogHandle {
	root: Frame;
	/** DialogContent: a popover card */
	card: Frame;
	/** y (card design units) where the content starts, below the header */
	contentY: number;
	close(): void;
}

/** shadcn Dialog: scrim (background at 80%) + centred popover card (zoom-in-95 / fade-in) with its header */
export function Dialog(layer: Instance, name: string, props: DialogProps): DialogHandle {
	const { root, body } = makeScreen(layer, name, {
		color: THEME.background,
		transparency: TRANSPARENCY.overlay,
		zIndex: props.zIndex,
	});
	const card = Card(body, "DialogContent", {
		x: (DESIGN_W - props.w) / 2,
		y: (DESIGN_H - props.h) / 2,
		w: props.w,
		h: props.h,
		variant: "popover",
	});
	let contentY = space(6);
	const closeW = props.closeButton === true ? BUTTON_SIZE.icon.h : 0;
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
		Button(card, "Close", "X", {
			x: props.w - space(4) - closeW,
			y: space(4),
			w: closeW,
			size: "icon",
			variant: "secondary",
			onClick: (): void => handle.close(),
		});
	}
	// entrance: fade the scrim in, zoom the card from 95%
	root.BackgroundTransparency = 1;
	tween(root, 0.15, { BackgroundTransparency: TRANSPARENCY.overlay });
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

const TRACK_H = 6;
const THUMB = 18;

/**
 * shadcn Slider: `input` track, `primary` range, background thumb with a primary border. Mouse/touch drag;
 * with a gamepad or the keyboard, select it and use left/right.
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
	const inset = THUMB / 2;
	const track = makeFrame(hit, "Track", inset, (h - TRACK_H) / 2, w - inset * 2, TRACK_H, THEME.input, {
		radius: RADIUS.full,
		zIndex: z + 1,
	});
	const range = makeFrame(track, "Range", 0, 0, w - inset * 2, TRACK_H, THEME.primary, {
		radius: RADIUS.full,
		zIndex: z + 2,
	});
	const thumb = makeFrame(track, "Thumb", 0, TRACK_H / 2, THUMB, THUMB, THEME.background, {
		radius: RADIUS.full,
		stroke: THEME.primary,
		zIndex: z + 3,
	});
	thumb.AnchorPoint = new Vector2(0.5, 0.5);
	addAspect(thumb, 1);
	const thumbStroke = thumb.FindFirstChildOfClass("UIStroke");

	const refresh = (): void => {
		const v = math.clamp(props.get(), 0, 1);
		range.Size = UDim2.fromScale(v, 1);
		thumb.Position = UDim2.fromScale(v, 0.5);
		if (thumbStroke !== undefined) {
			const ring = isFocused(hit);
			thumbStroke.Color = ring ? THEME.ring : THEME.primary;
			setStrokeWidth(thumbStroke, ring ? BORDER.ring : BORDER.width);
		}
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
const ICON = 20;

interface ToastStyle {
	bg: Color3;
	fg: Color3;
	border: Color3;
	icon: Color3;
	glyphColor: Color3;
	glyph: string;
	/** design text size (default TEXT.sm); errors read at body size, not the smaller label/caption size */
	textSize: number;
}

/**
 * popover toasts with a semantic icon. Errors read as the same popover card as every other kind, with
 * `destructive` only on the border/icon and the message in `foreground` (~18.7:1 on the popover background) —
 * a solid `destructive` fill behind `destructive-foreground` text only reaches ~3.7:1, below the 4.5:1 floor.
 */
function toastStyle(kind: ToastKind): ToastStyle {
	const base = {
		bg: THEME.popover,
		fg: THEME.popoverForeground,
		border: THEME.border,
		glyphColor: THEME.background,
		textSize: TEXT.sm,
	};
	if (kind === "success") return { ...base, icon: GAME.success, glyph: "✓" };
	if (kind === "coin") return { ...base, icon: GAME.coin, glyph: "$" };
	if (kind === "error") {
		return { ...base, border: THEME.destructive, icon: THEME.destructive, glyph: "!", textSize: TEXT.base };
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

/** sonner-style toast: bordered popover card stacked in the top-right corner, newest first; duplicates merge */
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
	const slot = makeFrame(stack, "Toast", 0, 0, TOAST_W, TOAST_H, style.bg, { transparency: 1 });
	slot.Position = new UDim2();
	slot.ZIndex = 1001;
	slot.LayoutOrder = -++toastOrder;
	slot.SetAttribute("Text", text);
	slot.SetAttribute("Born", os.clock());
	const card = makeFrame(slot, "Card", 0, 0, TOAST_W, TOAST_H, style.bg, {
		radius: RADIUS.lg,
		stroke: style.border,
		zIndex: 1002,
	});
	const icon = makeFrame(card, "Icon", space(4), (TOAST_H - ICON) / 2, ICON, ICON, style.icon, {
		radius: RADIUS.full,
		zIndex: 1003,
	});
	const glyph = makeLabel(icon, "Glyph", style.glyph, 0, 0, ICON, ICON, TEXT.xs, style.glyphColor, {
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
	const stroke = card.FindFirstChildOfClass("UIStroke");
	const fadeTargets: Array<[GuiObject, boolean]> = [
		[card, false],
		[icon, false],
		[glyph, true],
		[label, true],
	];
	const setFade = (t: number, time: number): void => {
		for (const [obj, isText] of fadeTargets) {
			if (isText && obj.IsA("TextLabel")) tween(obj, time, { TextTransparency: t });
			else tween(obj, time, { BackgroundTransparency: t });
		}
		if (stroke !== undefined) tween(stroke, time, { Transparency: t });
	};
	card.Position = UDim2.fromScale(0.12, 0);
	card.BackgroundTransparency = 1;
	icon.BackgroundTransparency = 1;
	glyph.TextTransparency = 1;
	label.TextTransparency = 1;
	if (stroke !== undefined) stroke.Transparency = 1;
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
	f.BackgroundTransparency = opts?.transparency ?? 1;
	f.BorderSizePixel = 0;
	if (opts?.zIndex !== undefined) f.ZIndex = opts.zIndex;
	f.ClipsDescendants = true;
	f.ScrollingDirection = Enum.ScrollingDirection.Y;
	f.CanvasSize = UDim2.fromOffset(0, 0);
	f.AutomaticCanvasSize = Enum.AutomaticSize.Y;
	f.ScrollBarThickness = 6;
	f.ScrollBarImageColor3 = THEME.border;
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
function sizeRow(list: ScrollList, row: GuiObject, rowH: number): void {
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
 * space. Card look: bg-card + 1 px border + radius.
 */
export function makeListRow(list: ScrollList, name: string, order: number, rowH: number, color?: Color3): Frame {
	const row = new Instance("Frame");
	row.Name = name;
	row.BackgroundColor3 = color ?? THEME.card;
	row.BorderSizePixel = 0;
	row.LayoutOrder = order;
	setDesign(row, list.designW, rowH);
	addCorner(row, RADIUS.lg, list.designW, rowH);
	addStroke(row, THEME.border);
	sizeRow(list, row, rowH);
	row.Parent = list.frame;
	return row;
}

/**
 * Clickable row for a ScrollList (the row IS the button): bg-card + border; hover / press / gamepad selection =
 * accent, and its own TextLabels switch to accent-foreground meanwhile (put the row's labels directly inside it;
 * use >= TEXT.sm and SemiBold/Bold for what must stay legible on accent). Children use (list width) x rowH.
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

// ---------------------------------------------------------------- composite widgets

export interface CoinPill {
	frame: GuiObject;
	refresh(): void;
}

/** coin icon: chart-3 circle with a "$" in the background colour */
export function CoinIcon(parent: Instance, name: string, x: number, y: number, size: number, zIndex?: number): Frame {
	const icon = makeFrame(parent, name, x, y, size, size, GAME.coin, { radius: RADIUS.full, zIndex });
	makeLabel(icon, "Glyph", "$", 0, 0, size, size, size * 0.62, THEME.background, {
		weight: Enum.FontWeight.ExtraBold,
		zIndex: zIndex !== undefined ? zIndex + 1 : undefined,
	});
	return icon;
}

/** coin balance: coin icon (chart-3) + amount in foreground mono; `onClick` makes it an outline button */
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
			: makeFrame(parent, name, x, y, w, h, THEME.background, {
					transparency: 1,
					radius: RADIUS.lg,
					stroke: THEME.border,
				});
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
