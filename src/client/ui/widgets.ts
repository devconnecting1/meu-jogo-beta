export const DESIGN_W = 1120;
export const DESIGN_H = 630;

export interface FrameOpts {
	transparency?: number;
	zIndex?: number;
	clips?: boolean;
	border?: number;
}

function designOf(parent: Instance): Array<number> {
	if (parent.IsA("GuiObject")) {
		const dw = parent.GetAttribute("DesignW");
		const dh = parent.GetAttribute("DesignH");
		if (typeOf(dw) === "number" && typeOf(dh) === "number") {
			const w = dw as number;
			const h = dh as number;
			if (w > 0 && h > 0) {
				return [w, h];
			}
		}
	}
	return [DESIGN_W, DESIGN_H];
}

function mark<T extends GuiObject>(g: T, w: number, h: number): T {
	g.SetAttribute("DesignW", w);
	g.SetAttribute("DesignH", h);
	return g;
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
	const design = designOf(parent);
	const f = new Instance("Frame");
	f.Name = name;
	f.Position = UDim2.fromScale(x / design[0], y / design[1]);
	f.Size = UDim2.fromScale(w / design[0], h / design[1]);
	f.BackgroundColor3 = color;
	f.BorderSizePixel = opts?.border ?? 0;
	if (opts?.transparency !== undefined) f.BackgroundTransparency = opts.transparency;
	if (opts?.zIndex !== undefined) f.ZIndex = opts.zIndex;
	if (opts?.clips !== undefined) f.ClipsDescendants = opts.clips;
	mark(f, w, h);
	f.Parent = parent;
	return f;
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
): TextLabel {
	const design = designOf(parent);
	const l = new Instance("TextLabel");
	l.Name = name;
	l.Position = UDim2.fromScale(x / design[0], y / design[1]);
	l.Size = UDim2.fromScale(w / design[0], h / design[1]);
	l.BackgroundTransparency = 1;
	l.BorderSizePixel = 0;
	l.Text = text;
	l.TextSize = textSize;
	l.TextColor3 = color;
	l.Font = Enum.Font.Gotham;
	l.TextWrapped = true;
	l.TextXAlignment = Enum.TextXAlignment.Center;
	mark(l, w, h);
	l.Parent = parent;
	return l;
}

export function makeButton(
	parent: Instance,
	name: string,
	text: string,
	x: number,
	y: number,
	w: number,
	h: number,
	bg: Color3,
	onClick: () => void,
): TextButton {
	const design = designOf(parent);
	const b = new Instance("TextButton");
	b.Name = name;
	b.Position = UDim2.fromScale(x / design[0], y / design[1]);
	b.Size = UDim2.fromScale(w / design[0], h / design[1]);
	b.BackgroundColor3 = bg;
	b.BorderSizePixel = 0;
	b.Text = text;
	b.TextSize = 20;
	b.TextColor3 = Color3.fromRGB(235, 235, 235);
	b.Font = Enum.Font.GothamBold;
	b.TextWrapped = true;
	mark(b, w, h);
	b.MouseButton1Click.Connect(onClick);
	b.Parent = parent;
	return b;
}

export function clearChildren(container: Instance): void {
	for (const child of container.GetChildren()) {
		child.Destroy();
	}
}

export interface Bar {
	frame: Frame;
	fill: Frame;
	setRatio(r: number): void;
}

export function makeBar(
	parent: Instance,
	name: string,
	x: number,
	y: number,
	w: number,
	h: number,
	fgColor: Color3,
): Bar {
	const frame = makeFrame(parent, name, x, y, w, h, Color3.fromRGB(28, 28, 34));
	const fill = makeFrame(frame, "Fill", 0, 0, w, h, fgColor);
	const bar: Bar = {
		frame,
		fill,
		setRatio(r: number): void {
			fill.Size = UDim2.fromScale(math.clamp(r, 0, 1), 1);
		},
	};
	bar.setRatio(1);
	return bar;
}

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
	const design = designOf(parent);
	const f = new Instance("ScrollingFrame");
	f.Name = name;
	f.Position = UDim2.fromScale(x / design[0], y / design[1]);
	f.Size = UDim2.fromScale(w / design[0], h / design[1]);
	f.BackgroundColor3 = Color3.fromRGB(30, 30, 36);
	f.BorderSizePixel = opts?.border ?? 0;
	if (opts?.transparency !== undefined) f.BackgroundTransparency = opts.transparency;
	if (opts?.zIndex !== undefined) f.ZIndex = opts.zIndex;
	if (opts?.clips !== undefined) f.ClipsDescendants = opts.clips;
	f.ScrollingDirection = Enum.ScrollingDirection.Y;
	f.CanvasSize = UDim2.fromOffset(0, 0);
	f.AutomaticCanvasSize = Enum.AutomaticSize.Y;
	f.ScrollBarThickness = 6;
	f.ScrollBarImageColor3 = Color3.fromRGB(120, 120, 130);
	mark(f, w, h);
	const layout = new Instance("UIListLayout");
	layout.SortOrder = Enum.SortOrder.LayoutOrder;
	layout.Padding = new UDim(0, 4);
	layout.Parent = f;
	f.Parent = parent;
	return { frame: f, layout, designW: w, designH: h };
}

export function nl(s: string): string {
	const parts = s.split("#");
	return parts.join("\n");
}

export function fmtNum(v: number): string {
	return `${math.round(v * 100) / 100}`;
}
