/*
 * A fake Roblox GUI tree for Node: the datatypes, enums and Instances the world renderer touches
 * (shared/engine/renderer.ts: Frame, ImageLabel, UICorner, UIStroke, UIGradient), with the engine's defaults.
 *
 *   import { installFakeGui } from "./fake-gui.mjs";
 *   const gui = installFakeGui();            // after installShims() of tools/luau-shim.mjs
 *   const root = gui.make("Frame");
 *   ... draw ...
 *   gui.stats.created / gui.stats.writes     // Instances created, property writes that changed a value
 *
 * It keeps no layout engine: an Instance is a bag of properties plus a child list, which is all the renderer
 * writes and all tools/render-map.mjs needs to rasterise what the engine would show. `stats` counts what the
 * engine would pay for: every Instance created and every property write that changed a value, compared by value
 * as Luau compares Roblox datatypes (a write that changes nothing is counted apart, in `rewrites`).
 */

class Vector2 {
	constructor(x = 0, y = 0) {
		this.X = x;
		this.Y = y;
	}
}
class UDim {
	constructor(scale = 0, offset = 0) {
		this.Scale = scale;
		this.Offset = offset;
	}
}
class UDim2 {
	constructor(xs = 0, xo = 0, ys = 0, yo = 0) {
		this.X = new UDim(xs, xo);
		this.Y = new UDim(ys, yo);
	}
	static fromOffset(x = 0, y = 0) {
		return new UDim2(0, x, 0, y);
	}
	static fromScale(x = 0, y = 0) {
		return new UDim2(x, 0, y, 0);
	}
}
class Rect {
	constructor(a = 0, b = 0, c = 0, d = 0) {
		if (a instanceof Vector2) {
			this.Min = a;
			this.Max = b;
		} else {
			this.Min = new Vector2(a, b);
			this.Max = new Vector2(c, d);
		}
		this.Width = this.Max.X - this.Min.X;
		this.Height = this.Max.Y - this.Min.Y;
	}
}
class NumberSequenceKeypoint {
	constructor(time, value) {
		this.Time = time;
		this.Value = value;
		this.Envelope = 0;
	}
}
class NumberSequence {
	constructor(a, b) {
		if (Array.isArray(a)) this.Keypoints = a;
		else {
			const v1 = b ?? a;
			this.Keypoints = [new NumberSequenceKeypoint(0, a), new NumberSequenceKeypoint(1, v1)];
		}
	}
}

const enumItem = (type, name) => ({ Name: name, EnumType: type, toString: () => `Enum.${type}.${name}` });
function enumOf(type, names) {
	const e = {};
	for (const n of names) e[n] = enumItem(type, n);
	return e;
}

const WHITE = { R: 1, G: 1, B: 1 };
const GREY = { R: 163 / 255, G: 162 / 255, B: 165 / 255 };
const BLACK = { R: 0, G: 0, B: 0 };

/** the engine's defaults for the properties the renderer reads back (Roblox values) */
function defaultsOf(className) {
	const gui = {
		Visible: true,
		AnchorPoint: new Vector2(0, 0),
		Position: new UDim2(),
		Size: new UDim2(),
		Rotation: 0,
		ZIndex: 1,
		BackgroundColor3: GREY,
		BackgroundTransparency: 0,
		BorderSizePixel: 1,
		ClipsDescendants: false,
	};
	if (className === "Frame") return gui;
	if (className === "ImageLabel" || className === "ImageButton") {
		return {
			...gui,
			BackgroundColor3: WHITE,
			Image: "",
			ImageColor3: WHITE,
			ImageTransparency: 0,
			ScaleType: ENUM.ScaleType.Stretch,
			TileSize: UDim2.fromScale(1, 1),
			SliceCenter: new Rect(0, 0, 0, 0),
			SliceScale: 1,
			ImageRectOffset: new Vector2(0, 0),
			ImageRectSize: new Vector2(0, 0),
			ResampleMode: ENUM.ResamplerMode.Default,
		};
	}
	if (className === "UICorner") return { CornerRadius: new UDim(0, 8) };
	if (className === "UIStroke") {
		return {
			Enabled: true,
			Color: BLACK,
			Thickness: 1,
			Transparency: 0,
			ApplyStrokeMode: ENUM.ApplyStrokeMode.Contextual,
			LineJoinMode: ENUM.LineJoinMode.Round,
		};
	}
	if (className === "UIGradient") {
		return { Enabled: true, Rotation: 0, Transparency: new NumberSequence(0), Offset: new Vector2(0, 0) };
	}
	return {};
}

const ENUM = {
	ApplyStrokeMode: enumOf("ApplyStrokeMode", ["Contextual", "Border"]),
	LineJoinMode: enumOf("LineJoinMode", ["Round", "Bevel", "Miter"]),
	ScaleType: enumOf("ScaleType", ["Stretch", "Slice", "Tile", "Fit", "Crop"]),
	ResamplerMode: enumOf("ResamplerMode", ["Default", "Pixelated"]),
	ZIndexBehavior: enumOf("ZIndexBehavior", ["Global", "Sibling"]),
};

const GUI_CLASSES = new Set(["Frame", "ImageLabel", "ImageButton", "TextLabel", "TextButton", "ScrollingFrame"]);

/**
 * Does writing `b` over `a` change anything? Roblox datatypes compare by VALUE (Luau's `==` / `~=` call their __eq),
 * which is also what the renderer's write cache does in the real client: a Color3 rebuilt each frame with the same
 * value is not a write there, so it is not one here either.
 */
function sameValue(a, b) {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if ("R" in a && "R" in b) return a.R === b.R && a.G === b.G && a.B === b.B;
	if (a instanceof UDim2 && b instanceof UDim2) {
		return (
			a.X.Scale === b.X.Scale && a.X.Offset === b.X.Offset && a.Y.Scale === b.Y.Scale && a.Y.Offset === b.Y.Offset
		);
	}
	if (a instanceof UDim && b instanceof UDim) return a.Scale === b.Scale && a.Offset === b.Offset;
	if (a instanceof Vector2 && b instanceof Vector2) return a.X === b.X && a.Y === b.Y;
	if (a instanceof Rect && b instanceof Rect) return sameValue(a.Min, b.Min) && sameValue(a.Max, b.Max);
	return false;
}

export function installFakeGui() {
	const stats = { created: 0, writes: 0, rewrites: 0, byClass: {} };

	function make(className) {
		const props = defaultsOf(className);
		props.ClassName = className;
		props.Name = className;
		const children = [];
		let parent;
		const self = new Proxy(props, {
			get(t, k) {
				if (k === "Parent") return parent;
				if (k === "GetChildren") return () => [...children];
				if (k === "FindFirstChildOfClass") return cls => children.find(c => c.ClassName === cls);
				if (k === "FindFirstChild") return name => children.find(c => c.Name === name);
				if (k === "IsA") {
					return cls =>
						cls === className || cls === "Instance" || (cls === "GuiObject" && GUI_CLASSES.has(className));
				}
				if (k === "Destroy") {
					return () => {
						for (const c of [...children]) c.Destroy();
						self.Parent = undefined;
					};
				}
				if (k === "__children") return children;
				return t[k];
			},
			set(t, k, v) {
				if (k === "Parent") {
					if (parent !== undefined) {
						const list = parent.__children;
						const i = list.indexOf(self);
						if (i >= 0) list.splice(i, 1);
					}
					parent = v;
					if (v !== undefined) v.__children.push(self);
					return true;
				}
				if (!sameValue(t[k], v)) stats.writes++;
				else stats.rewrites++;
				t[k] = v;
				return true;
			},
		});
		stats.created++;
		stats.byClass[className] = (stats.byClass[className] ?? 0) + 1;
		return self;
	}

	globalThis.Vector2 = Vector2;
	globalThis.UDim = UDim;
	globalThis.UDim2 = UDim2;
	globalThis.Rect = Rect;
	globalThis.NumberSequence = NumberSequence;
	globalThis.NumberSequenceKeypoint = NumberSequenceKeypoint;
	globalThis.Enum = ENUM;
	globalThis.Instance = function Instance(className) {
		return make(className);
	};
	return { make, stats, ENUM };
}
