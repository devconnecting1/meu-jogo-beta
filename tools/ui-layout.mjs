/*
 * A layout pass for the counted fake Instance tree of tools/ui-shim.mjs: the rects the engine would give every
 * GuiObject, computed from what the kit writes -- Scale / Offset / AnchorPoint, UIAspectRatioConstraint,
 * UISizeConstraint, UIPadding, a UIListLayout (a ScrollingFrame's rows), a ScrollingFrame's bar gutter -- and written
 * back as AbsolutePosition / AbsoluteSize. Writing AbsoluteSize fires its property signal, which is what the kit
 * listens to (widgets.ts sizeRow gives a list row its pixel height from the list's width, a Keycap fits its legend),
 * so `layout()` runs a few passes until those settle, like frames of the real engine.
 *
 *   import { layout, rectOf, paintList } from "./ui-layout.mjs";
 *   layout(ui, screenGuiOrRoot, { w: 844, h: 390 });
 *   rectOf(someLabel)            // { x, y, w, h } in screen pixels
 *   paintList(root)              // what a renderer draws, in draw order (tools/test-tables.mjs, PNG renders)
 *
 * Not modelled (the kit does not rely on them): AutomaticSize other than a label's X (estimated from its text),
 * horizontal lists, grid layouts, rotation.
 */

const EPS = 1e-9;

const isGui = n => n !== undefined && typeof n.IsA === "function" && n.IsA("GuiObject");

/** a text's width in px at `px` (a generous estimate of the kit's fonts, bold wider) */
export function textWidth(text, px, bold = false, mono = false) {
	const chars = Array.from(String(text).replace(/<[^>]+>/g, "")).length;
	return chars * px * (mono ? 0.62 : bold ? 0.57 : 0.52);
}

function padOf(n, w, h) {
	const p = n.FindFirstChildOfClass?.("UIPadding");
	if (p === undefined) return { l: 0, r: 0, t: 0, b: 0 };
	const u = (d, size) => (d === undefined ? 0 : d.Scale * size + d.Offset);
	return { l: u(p.PaddingLeft, w), r: u(p.PaddingRight, w), t: u(p.PaddingTop, h), b: u(p.PaddingBottom, h) };
}

function sizeOf(n, pw, ph) {
	let w = n.Size.X.Scale * pw + n.Size.X.Offset;
	let h = n.Size.Y.Scale * ph + n.Size.Y.Offset;
	// a label that grows with its text (the Keycap legend): its width is its text's
	if ((n.ClassName === "TextLabel" || n.ClassName === "TextButton") && n.AutomaticSize?.Name === "X") {
		const px = n.TextSize ?? 14;
		w = Math.max(w, textWidth(n.Text ?? "", px, /Bold|SemiBold/.test(n.FontFace?.Weight?.Name ?? "")));
	}
	const ar = n.FindFirstChildOfClass?.("UIAspectRatioConstraint");
	if (ar !== undefined && w > 0 && h > 0) {
		if (w / h > ar.AspectRatio) w = h * ar.AspectRatio;
		else h = w / ar.AspectRatio;
	}
	const sc = n.FindFirstChildOfClass?.("UISizeConstraint");
	if (sc !== undefined) {
		if (sc.MinSize !== undefined) {
			w = Math.max(w, sc.MinSize.X);
			h = Math.max(h, sc.MinSize.Y);
		}
		if (sc.MaxSize !== undefined) {
			w = Math.min(w, sc.MaxSize.X);
			h = Math.min(h, sc.MaxSize.Y);
		}
	}
	return [Math.max(0, w), Math.max(0, h)];
}

function setAbs(n, x, y, w, h) {
	const p = n.AbsolutePosition;
	if (p === undefined || Math.abs(p.X - x) > EPS || Math.abs(p.Y - y) > EPS) n.AbsolutePosition = new Vector2(x, y);
	const s = n.AbsoluteSize;
	if (s === undefined || Math.abs(s.X - w) > EPS || Math.abs(s.Y - h) > EPS) n.AbsoluteSize = new Vector2(w, h);
}

function place(n, box) {
	for (const c of n.GetChildren()) {
		if (!isGui(c)) continue;
		layoutNode(c, box);
	}
}

/** lays out `n` inside the parent content box `box` = { x, y, w, h } */
function layoutNode(n, box) {
	const [w, h] = sizeOf(n, box.w, box.h);
	const x = box.x + n.Position.X.Scale * box.w + n.Position.X.Offset - n.AnchorPoint.X * w;
	const y = box.y + n.Position.Y.Scale * box.h + n.Position.Y.Offset - n.AnchorPoint.Y * h;
	setAbs(n, x, y, w, h);
	layoutChildren(n, x, y, w, h);
}

function layoutChildren(n, x, y, w, h) {
	const pad = padOf(n, w, h);
	let cw = w - pad.l - pad.r;
	const ch = h - pad.t - pad.b;
	const scrolling = n.ClassName === "ScrollingFrame";
	if (scrolling) {
		const always = n.VerticalScrollBarInset?.Name === "Always";
		const bar = n.ScrollBarThickness ?? 0;
		if (always) cw -= bar;
	}
	const list = n.FindFirstChildOfClass?.("UIListLayout");
	if (list === undefined) {
		place(n, { x: x + pad.l, y: y + pad.t, w: cw, h: ch });
		return;
	}
	// a vertical list: visible children stacked by LayoutOrder (ties in child order), the layout's padding between
	const gap = list.Padding === undefined ? 0 : list.Padding.Scale * ch + list.Padding.Offset;
	const kids = n
		.GetChildren()
		.map((c, i) => [c, i])
		.filter(([c]) => isGui(c) && c.Visible)
		.sort((a, b) => a[0].LayoutOrder - b[0].LayoutOrder || a[1] - b[1])
		.map(([c]) => c);
	const scrollY = scrolling && n.CanvasPosition !== undefined ? n.CanvasPosition.Y : 0;
	let cy = y + pad.t - scrollY;
	const right = list.HorizontalAlignment?.Name === "Right";
	for (const c of kids) {
		const [kw, kh] = sizeOf(c, cw, ch);
		const kx = x + pad.l + (right ? cw - kw : 0);
		setAbs(c, kx, cy, kw, kh);
		layoutChildren(c, kx, cy, kw, kh);
		cy += kh + gap;
	}
	if (scrolling) {
		const content = cy - gap - (y + pad.t - scrollY) + pad.t + pad.b;
		n.AbsoluteCanvasSize = new Vector2(cw, Math.max(content, 0));
	}
}

/**
 * Lays out everything under `root` as if `root` filled a { w, h } screen at (0, 0) (a ScreenGui, or any frame given
 * the whole screen). Runs `passes` rounds with the shim's deferred work flushed in between, so a row that sized itself
 * from its list's AbsoluteSize in round 1 is placed with that size in round 2.
 */
export function layout(ui, root, screen, passes = 3) {
	for (let i = 0; i < passes; i++) {
		if (isGui(root)) {
			setAbs(root, 0, 0, screen.w, screen.h);
			layoutChildren(root, 0, 0, screen.w, screen.h);
		} else {
			place(root, { x: 0, y: 0, w: screen.w, h: screen.h });
		}
		ui.flush();
	}
}

/** the rect the last `layout` gave `g`, in screen pixels */
export function rectOf(g) {
	const p = g.AbsolutePosition;
	const s = g.AbsoluteSize;
	return { x: p.X, y: p.Y, w: s.X, h: s.Y };
}

/** is `g` drawn: visible, and every ancestor visible up to (not including) a non-GUI parent */
export function shown(g) {
	for (let n = g; n !== undefined; n = n.Parent) {
		if (!isGui(n)) return true;
		if (!n.Visible) return false;
	}
	return true;
}

/** the text px TextScaled lands on inside `rect` for `label` (its UITextSizeConstraint caps it) */
export function textPx(label, rect) {
	const text = String(label.Text ?? "");
	const c = label.FindFirstChildOfClass?.("UITextSizeConstraint");
	if (!label.TextScaled) return label.TextSize ?? 14;
	const bold = /Bold|SemiBold|ExtraBold/.test(label.FontFace?.Weight?.Name ?? "");
	const mono = String(label.FontFace?.Family ?? "")
		.toLowerCase()
		.includes("mono");
	const lines = text.split("\n");
	const longest = Math.max(...lines.map(l => Array.from(l).length), 1);
	const perChar = mono ? 0.62 : bold ? 0.57 : 0.52;
	let fit = Math.min(rect.h / (lines.length * 1.15), rect.w / (longest * perChar));
	if (label.TextWrapped && lines.length === 1 && longest * perChar * fit > rect.w) fit = rect.h / 2.3;
	const max = c?.MaxTextSize ?? 100;
	const min = c?.MinTextSize ?? 1;
	return Math.max(min, Math.min(max, fit));
}

/**
 * What a renderer draws for `root`, in draw order (the ScreenGui's ZIndexBehavior.Sibling: a parent under its
 * children, siblings by ZIndex then child order), clipped by every ClipsDescendants / ScrollingFrame ancestor:
 *   { kind: "rect", x, y, w, h, color: [r,g,b], alpha, radius, clip }
 *   { kind: "stroke", ..., thickness }
 *   { kind: "image", x, y, w, h, image, slice: [l, t, r, b], sliceScale, tint, alpha, clip }
 *   { kind: "text", x, y, w, h, text, color, alpha, px, bold, mono, alignX, alignY, wrapped, clip }
 */
export function paintList(root) {
	const out = [];
	const rgb = c => [Math.round(c.R * 255), Math.round(c.G * 255), Math.round(c.B * 255)];
	const walk = (n, clip) => {
		if (!isGui(n) || !n.Visible) return;
		const r = rectOf(n);
		const t = n.BackgroundTransparency ?? 1;
		const corner = n.FindFirstChildOfClass("UICorner");
		const radius =
			corner === undefined ? 0 : corner.CornerRadius.Scale * Math.min(r.w, r.h) + corner.CornerRadius.Offset;
		if (t < 1 && n.BackgroundColor3 !== undefined) {
			out.push({ kind: "rect", ...r, color: rgb(n.BackgroundColor3), alpha: 1 - t, radius, clip });
		}
		if (n.ClassName === "ImageLabel" && n.Image && (n.ImageTransparency ?? 0) < 1) {
			const sc = n.SliceCenter;
			out.push({
				kind: "image",
				...r,
				image: n.Image,
				slice: sc === undefined ? [0, 0, 0, 0] : [sc.Min.X, sc.Min.Y, sc.Max.X, sc.Max.Y],
				sliceScale: n.SliceScale ?? 1,
				tint: rgb(n.ImageColor3 ?? new Color3(1, 1, 1)),
				alpha: 1 - (n.ImageTransparency ?? 0),
				clip,
			});
		}
		const text = n.ClassName === "TextLabel" || n.ClassName === "TextButton" || n.ClassName === "TextBox";
		const stroke = n.GetChildren().find(c => c.ClassName === "UIStroke" && c.Enabled !== false);
		if (!text && stroke !== undefined && (stroke.Transparency ?? 0) < 1) {
			out.push({
				kind: "stroke",
				...r,
				color: rgb(stroke.Color),
				alpha: 1 - (stroke.Transparency ?? 0),
				thickness: stroke.Thickness ?? 1,
				radius,
				clip,
			});
		}
		if (text) {
			const placeholder = n.ClassName === "TextBox" && (n.Text ?? "") === "";
			const str = placeholder ? (n.PlaceholderText ?? "") : (n.Text ?? "");
			const alpha = 1 - (n.TextTransparency ?? 0);
			if (str !== "" && alpha > 0) {
				const pad = padOf(n, r.w, r.h);
				const box = { x: r.x + pad.l, y: r.y + pad.t, w: r.w - pad.l - pad.r, h: r.h - pad.t - pad.b };
				const weight = n.FontFace?.Weight?.Name ?? "Regular";
				out.push({
					kind: "text",
					...box,
					text: String(str).replace(/<[^>]+>/g, ""),
					color: rgb(placeholder ? (n.PlaceholderColor3 ?? n.TextColor3) : n.TextColor3),
					alpha,
					px: textPx(n, box),
					bold: /Bold|SemiBold|ExtraBold|Heavy/.test(weight),
					mono: String(n.FontFace?.Family ?? "")
						.toLowerCase()
						.includes("mono"),
					alignX: n.TextXAlignment?.Name ?? "Center",
					alignY: n.TextYAlignment?.Name ?? "Center",
					wrapped: n.TextWrapped === true,
					clip,
				});
			}
		}
		let inner = clip;
		if (n.ClipsDescendants || n.ClassName === "ScrollingFrame") {
			const c = [r.x, r.y, r.x + r.w, r.y + r.h];
			inner =
				clip === undefined
					? c
					: [
							Math.max(c[0], clip[0]),
							Math.max(c[1], clip[1]),
							Math.min(c[2], clip[2]),
							Math.min(c[3], clip[3]),
						];
		}
		const kids = n
			.GetChildren()
			.map((c, i) => [c, i])
			.filter(([c]) => isGui(c))
			.sort((a, b) => (a[0].ZIndex ?? 1) - (b[0].ZIndex ?? 1) || a[1] - b[1])
			.map(([c]) => c);
		for (const c of kids) walk(c, inner);
	};
	if (isGui(root)) walk(root, undefined);
	else {
		const kids = root
			.GetChildren()
			.map((c, i) => [c, i])
			.filter(([c]) => isGui(c))
			.sort((a, b) => (a[0].ZIndex ?? 1) - (b[0].ZIndex ?? 1) || a[1] - b[1])
			.map(([c]) => c);
		for (const c of kids) walk(c, undefined);
	}
	return out;
}
