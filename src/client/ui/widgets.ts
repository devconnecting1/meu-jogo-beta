/*
 * Project Z UI kit.
 *
 * Every widget is laid out in "design units" relative to its parent (the root screen is 1120 x 630);
 * positions/sizes are converted to Scale, so the layout follows the screen. Parents created here carry
 * DesignW/DesignH attributes so children can be placed in the parent's own design space.
 *
 * Consistency rules:
 * - colours come from PALETTE, fonts from FONTS
 * - text is TextScaled + UITextSizeConstraint (max = design size x current UI scale), so it never
 *   overflows its box on phones and is not tiny on 1080p/1440p
 * - panels/buttons have UICorner + UIStroke; buttons have hover / press / disabled states
 * - full screens use makeScreen(): the content is letterboxed at 16:9 inside the safe area (below the
 *   Roblox top bar); HUD clusters use makeAnchored() (corner anchored, fixed aspect ratio)
 */

const GuiService = game.GetService("GuiService");
const TweenService = game.GetService("TweenService");
const Workspace = game.GetService("Workspace");

export const DESIGN_W = 1120;
export const DESIGN_H = 630;

export const PALETTE = {
	bg: Color3.fromRGB(13, 15, 19),
	bgRaised: Color3.fromRGB(19, 22, 28),
	surface: Color3.fromRGB(27, 31, 39),
	surfaceAlt: Color3.fromRGB(35, 40, 50),
	surfaceHi: Color3.fromRGB(48, 54, 67),
	stroke: Color3.fromRGB(64, 71, 87),
	strokeSoft: Color3.fromRGB(44, 50, 62),
	text: Color3.fromRGB(237, 239, 243),
	textDim: Color3.fromRGB(160, 167, 181),
	textMuted: Color3.fromRGB(108, 115, 130),
	textOnAccent: Color3.fromRGB(28, 20, 8),
	accent: Color3.fromRGB(232, 168, 56),
	accentHi: Color3.fromRGB(250, 196, 96),
	danger: Color3.fromRGB(212, 68, 68),
	success: Color3.fromRGB(76, 180, 100),
	info: Color3.fromRGB(86, 146, 226),
	coin: Color3.fromRGB(247, 204, 72),
	hp: Color3.fromRGB(220, 70, 70),
	hunger: Color3.fromRGB(232, 164, 60),
	exp: Color3.fromRGB(96, 156, 236),
	overlay: Color3.fromRGB(0, 0, 0),
	blood: Color3.fromRGB(150, 12, 20),
};

export const FONTS = {
	display: Enum.Font.GothamBlack,
	bold: Enum.Font.GothamBold,
	medium: Enum.Font.GothamMedium,
	body: Enum.Font.Gotham,
};

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

const textConstraints = new Map<UITextSizeConstraint, number>();

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

const insetListeners = new Set<() => void>();

function refreshAll(): void {
	for (const [c, size] of textConstraints) {
		if (c.Parent === undefined) {
			textConstraints.delete(c);
		} else {
			applyTextSize(c, size);
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

/** rounded corners; `radius` in design units of the object itself */
export function addCorner(g: GuiObject, radius: number, w: number, h: number): UICorner {
	const c = new Instance("UICorner");
	c.CornerRadius = new UDim(math.clamp(radius / math.max(math.min(w, h), 1), 0, 0.5), 0);
	c.Parent = g;
	return c;
}

export function addStroke(g: GuiObject, color: Color3, transparency = 0, thickness = 1): UIStroke {
	const s = new Instance("UIStroke");
	s.Color = color;
	s.Transparency = transparency;
	s.Thickness = thickness;
	s.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
	s.LineJoinMode = Enum.LineJoinMode.Round;
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

export function lighten(c: Color3, amount: number): Color3 {
	return c.Lerp(new Color3(1, 1, 1), amount);
}

export function darken(c: Color3, amount: number): Color3 {
	return c.Lerp(new Color3(0, 0, 0), amount);
}

export function tween<T extends Instance>(obj: T, time: number, props: Partial<ExtractMembers<T, Tweenable>>): Tween {
	const t = TweenService.Create(obj, new TweenInfo(time, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), props);
	t.Play();
	return t;
}

// ---------------------------------------------------------------- frames

export interface FrameOpts {
	transparency?: number;
	zIndex?: number;
	clips?: boolean;
	border?: number;
	/** corner radius in design units */
	radius?: number;
	stroke?: Color3;
	strokeTransparency?: number;
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
	f.BorderSizePixel = opts?.border ?? 0;
	if (opts?.transparency !== undefined) f.BackgroundTransparency = opts.transparency;
	if (opts?.zIndex !== undefined) f.ZIndex = opts.zIndex;
	if (opts?.clips !== undefined) f.ClipsDescendants = opts.clips;
	if (opts?.radius !== undefined && opts.radius > 0) addCorner(f, opts.radius, w, h);
	if (opts?.stroke !== undefined) {
		addStroke(f, opts.stroke, opts.strokeTransparency ?? 0, opts.strokeThickness ?? 1);
	}
	f.Parent = parent;
	return f;
}

/** standard card/panel: surface colour, rounded, subtle outline */
export function makePanel(
	parent: Instance,
	name: string,
	x: number,
	y: number,
	w: number,
	h: number,
	opts?: FrameOpts & { color?: Color3 },
): Frame {
	return makeFrame(parent, name, x, y, w, h, opts?.color ?? PALETTE.surface, {
		radius: 14,
		stroke: PALETTE.strokeSoft,
		...opts,
	});
}

// ---------------------------------------------------------------- text

export type TextAlign = "left" | "center" | "right";

export interface LabelOpts {
	font?: Enum.Font;
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
	l.BorderSizePixel = 0;
	l.Text = text;
	l.TextColor3 = color;
	l.Font = opts?.font ?? FONTS.body;
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

// ---------------------------------------------------------------- buttons

export type ButtonStyle = "primary" | "secondary" | "ghost" | "danger" | "success";

interface StyleSpec {
	bg: Color3;
	text: Color3;
	stroke: Color3;
}

function styleSpec(style: ButtonStyle): StyleSpec {
	if (style === "primary") return { bg: PALETTE.accent, text: PALETTE.textOnAccent, stroke: PALETTE.accentHi };
	if (style === "danger") return { bg: PALETTE.danger, text: PALETTE.text, stroke: lighten(PALETTE.danger, 0.2) };
	if (style === "success") return { bg: PALETTE.success, text: PALETTE.text, stroke: lighten(PALETTE.success, 0.2) };
	if (style === "ghost") return { bg: PALETTE.surface, text: PALETTE.textDim, stroke: PALETTE.strokeSoft };
	return { bg: PALETTE.surfaceHi, text: PALETTE.text, stroke: PALETTE.stroke };
}

export interface ButtonOpts {
	textSize?: number;
	font?: Enum.Font;
	radius?: number;
	zIndex?: number;
	align?: TextAlign;
}

function buttonColor(b: TextButton): Color3 {
	const v = b.GetAttribute("BaseColor");
	return typeIs(v, "Color3") ? v : PALETTE.surfaceHi;
}

function isDisabled(b: GuiButton): boolean {
	return b.GetAttribute("Disabled") === true;
}

function refreshButton(b: TextButton): void {
	const base = buttonColor(b);
	let c = base;
	if (isDisabled(b)) c = PALETTE.surfaceAlt;
	else if (b.GetAttribute("Pressed") === true) c = darken(base, 0.18);
	else if (b.GetAttribute("Hover") === true) c = lighten(base, 0.12);
	tween(b, 0.08, { BackgroundColor3: c });
	b.TextTransparency = isDisabled(b) ? 0.5 : 0;
	const stroke = b.FindFirstChildOfClass("UIStroke");
	if (stroke !== undefined) stroke.Transparency = isDisabled(b) ? 0.6 : 0.15;
}

/**
 * Button with hover/press/disabled states. `bg` is a style or a custom base colour.
 * Change colours later only through setButtonStyle/setButtonColor (keeps the states working).
 */
export function makeButton(
	parent: Instance,
	name: string,
	text: string,
	x: number,
	y: number,
	w: number,
	h: number,
	bg: ButtonStyle | Color3,
	onClick: () => void,
	opts?: ButtonOpts,
): TextButton {
	const b = new Instance("TextButton");
	b.Name = name;
	place(b, parent, x, y, w, h);
	b.AutoButtonColor = false;
	b.BorderSizePixel = 0;
	b.Text = text;
	b.Font = opts?.font ?? FONTS.bold;
	b.TextWrapped = true;
	b.TextXAlignment = xAlign(opts?.align);
	if (opts?.zIndex !== undefined) b.ZIndex = opts.zIndex;
	scaleText(b, (opts?.textSize ?? math.min(20, math.max(12, h * 0.4))) * inheritedTextScale(parent));
	addCorner(b, opts?.radius ?? math.min(12, h / 2), w, h);
	const spec = typeIs(bg, "Color3") ? { ...styleSpec("secondary"), bg } : styleSpec(bg);
	addStroke(b, spec.stroke, 0.15, 1);
	b.TextColor3 = spec.text;
	b.BackgroundColor3 = spec.bg;
	b.SetAttribute("BaseColor", spec.bg);

	b.MouseEnter.Connect(() => {
		b.SetAttribute("Hover", true);
		refreshButton(b);
	});
	b.MouseLeave.Connect(() => {
		b.SetAttribute("Hover", false);
		b.SetAttribute("Pressed", false);
		refreshButton(b);
	});
	b.MouseButton1Down.Connect(() => {
		b.SetAttribute("Pressed", true);
		refreshButton(b);
	});
	b.MouseButton1Up.Connect(() => {
		b.SetAttribute("Pressed", false);
		refreshButton(b);
	});
	b.Activated.Connect(() => {
		if (isDisabled(b)) return;
		onClick();
	});
	b.Parent = parent;
	return b;
}

export function setButtonColor(b: TextButton, color: Color3): void {
	b.SetAttribute("BaseColor", color);
	refreshButton(b);
}

export function setButtonStyle(b: TextButton, style: ButtonStyle): void {
	const spec = styleSpec(style);
	b.TextColor3 = spec.text;
	const stroke = b.FindFirstChildOfClass("UIStroke");
	if (stroke !== undefined) stroke.Color = spec.stroke;
	setButtonColor(b, spec.bg);
}

export function setButtonEnabled(b: TextButton, enabled: boolean): void {
	b.SetAttribute("Disabled", !enabled);
	b.AutoButtonColor = false;
	refreshButton(b);
}

// ---------------------------------------------------------------- containers

export function clearChildren(container: Instance): void {
	for (const child of container.GetChildren()) {
		child.Destroy();
	}
}

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
	/** subtle vertical gradient on opaque screens */
	gradient?: boolean;
}

/** full-screen page or modal overlay; place content in `body` using 1120x630 design units */
export function makeScreen(parent: Instance, name: string, opts?: ScreenOpts): Screen {
	const root = new Instance("Frame");
	root.Name = name;
	root.Size = UDim2.fromScale(1, 1);
	root.BackgroundColor3 = opts?.color ?? PALETTE.bg;
	root.BackgroundTransparency = opts?.transparency ?? 0;
	root.BorderSizePixel = 0;
	root.Active = true;
	if (opts?.zIndex !== undefined) root.ZIndex = opts.zIndex;
	if (opts?.gradient === true) {
		const g = new Instance("UIGradient");
		g.Rotation = 90;
		g.Color = new ColorSequence(lighten(root.BackgroundColor3, 0.05), darken(root.BackgroundColor3, 0.25));
		g.Parent = root;
	}
	// a transparent button under the content swallows clicks meant for whatever is behind the screen
	const blocker = new Instance("TextButton");
	blocker.Name = "InputBlocker";
	blocker.Size = UDim2.fromScale(1, 1);
	blocker.BackgroundTransparency = 1;
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

// ---------------------------------------------------------------- bars

export interface Bar {
	frame: Frame;
	fill: Frame;
	label: TextLabel | undefined;
	setRatio(r: number): void;
	setText(text: string): void;
	setColor(c: Color3): void;
}

export function makeBar(
	parent: Instance,
	name: string,
	x: number,
	y: number,
	w: number,
	h: number,
	fgColor: Color3,
	opts?: { label?: boolean; track?: Color3; textSize?: number },
): Bar {
	const frame = makeFrame(parent, name, x, y, w, h, opts?.track ?? PALETTE.bgRaised, {
		radius: h / 2,
		stroke: PALETTE.strokeSoft,
		strokeTransparency: 0.3,
	});
	frame.ClipsDescendants = false;
	const fill = makeFrame(frame, "Fill", 0, 0, w, h, fgColor, { radius: h / 2 });
	const shine = new Instance("UIGradient");
	shine.Rotation = 90;
	shine.Color = new ColorSequence(new Color3(1, 1, 1), new Color3(0.78, 0.78, 0.78));
	shine.Parent = fill;
	let label: TextLabel | undefined;
	if (opts?.label === true) {
		label = makeLabel(frame, "Value", "", 8, 0, w - 16, h, opts.textSize ?? h * 0.75, PALETTE.text, {
			font: FONTS.bold,
			zIndex: 3,
		});
		label.TextStrokeTransparency = 0.6;
	}
	fill.ZIndex = 2;
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
	bar.setRatio(1);
	return bar;
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
	f.BackgroundColor3 = PALETTE.surface;
	f.BackgroundTransparency = opts?.transparency ?? 1;
	f.BorderSizePixel = opts?.border ?? 0;
	if (opts?.zIndex !== undefined) f.ZIndex = opts.zIndex;
	f.ClipsDescendants = true;
	f.ScrollingDirection = Enum.ScrollingDirection.Y;
	f.CanvasSize = UDim2.fromOffset(0, 0);
	f.AutomaticCanvasSize = Enum.AutomaticSize.Y;
	f.ScrollBarThickness = 6;
	f.ScrollBarImageColor3 = PALETTE.stroke;
	f.VerticalScrollBarInset = Enum.ScrollBarInset.ScrollBar;
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

/**
 * Row for a ScrollList: full width, `rowH` design units tall (kept proportional to the list width).
 * Its children use a (list width) x rowH design space.
 */
export function makeListRow(list: ScrollList, name: string, order: number, rowH: number, color: Color3): Frame {
	const row = new Instance("Frame");
	row.Name = name;
	row.BackgroundColor3 = color;
	row.BorderSizePixel = 0;
	row.LayoutOrder = order;
	setDesign(row, list.designW, rowH);
	addCorner(row, 10, list.designW, rowH);
	const resize = (): void => {
		const px = list.frame.AbsoluteSize.X;
		const h = px > 1 ? (px * rowH) / list.designW : rowH;
		row.Size = new UDim2(1, 0, 0, math.round(h));
	};
	resize();
	const conn = list.frame.GetPropertyChangedSignal("AbsoluteSize").Connect(resize);
	row.Destroying.Connect(() => conn.Disconnect());
	row.Parent = list.frame;
	return row;
}

// ---------------------------------------------------------------- composite widgets

export interface CoinPill {
	frame: Frame;
	refresh(): void;
}

/** coin balance pill; `onClick` makes it a shortcut (e.g. to the shop) */
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
	const frame = makePanel(parent, name, x, y, w, h, {
		radius: h / 2,
		stroke: PALETTE.coin,
		strokeTransparency: 0.55,
	});
	const icon = makeFrame(frame, "Icon", 8, 8, h - 16, h - 16, PALETTE.coin, { radius: h, zIndex: 2 });
	makeLabel(icon, "Glyph", "$", 0, 0, h - 16, h - 16, h * 0.5, PALETTE.textOnAccent, {
		font: FONTS.display,
		zIndex: 3,
	});
	const amount = makeLabel(frame, "Amount", "", h + 2, 0, w - h - 16, h, h * 0.46, PALETTE.text, {
		font: FONTS.bold,
		align: "left",
		zIndex: 2,
	});
	if (onClick !== undefined) {
		const hit = makeButton(frame, "Hit", "", 0, 0, w, h, PALETTE.surface, onClick, { radius: h / 2 });
		hit.BackgroundTransparency = 1;
		const stroke = hit.FindFirstChildOfClass("UIStroke");
		if (stroke !== undefined) stroke.Enabled = false;
		hit.ZIndex = 4;
		hit.MouseEnter.Connect(() => tween(frame, 0.1, { BackgroundColor3: PALETTE.surfaceAlt }));
		hit.MouseLeave.Connect(() => tween(frame, 0.1, { BackgroundColor3: PALETTE.surface }));
	}
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
