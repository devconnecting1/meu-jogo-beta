#!/usr/bin/env node
/*
 * The Roblox side of the UI suites: Luau strings, Roblox datatypes, Enum, services, `task` and a small fake
 * Instance tree that COUNTS what a profiler would blame -- Instances created and destroyed, and property writes on
 * Instances that already existed.
 *
 * It is the tree tools/test-backpack.mjs grew (that suite still carries its own copy, like the older suites carry
 * theirs of luau-shim.mjs: changing a behaviour here does not change it there, so if it matters to both, change
 * both). New UI suites import this instead:
 *
 *   import { installUiShims } from "./ui-shim.mjs";
 *   const ui = installUiShims({ seed: 1, viewport: [1120, 630] });
 *   const { Hud } = ui.require(join(ui.SRC, "client/ui/hud.ts"));
 *
 * On top of test-backpack's tree it models what client/bootstrap.ts touches when it loads (Players.LocalPlayer and
 * its PlayerGui, StarterGui, the camera's ViewportSize signal, the input events), so a suite can load the REAL
 * bootstrap -- its key handlers and its touch geometry -- instead of a stand-in; plus NumberSequence (the HUD's
 * vignette) and Luau's `string.match` on string patterns.
 *
 * The tree only models what the kit touches (parenting, Destroy, attributes, property / event signals, Visible);
 * it has no layout engine, so it counts WORK, it does not time it. AbsoluteSize is always 0.
 */
import { installShims } from "./luau-shim.mjs";

let installed;

/** installs everything once; returns the suite's handles */
export function installUiShims(options = {}) {
	if (installed !== undefined) return installed;
	const base = installShims({ seed: options.seed ?? 1 });
	installed = { ...base, ...install(options) };
	return installed;
}

function install(options) {
	// ---------------------------------------------------------------- Luau / roblox-ts globals (UI dialect)

	let clock = 1000;
	globalThis.os = { clock: () => clock, time: () => Math.floor(clock) };
	globalThis.pcall = (fn, ...a) => {
		try {
			return [true, fn(...a)];
		} catch (e) {
			return [false, String(e?.message ?? e)];
		}
	};
	globalThis.utf8 = { len: s => [Array.from(s).length] };

	/** Lua pattern -> RegExp (the subset the UI uses: classes, sets, anchors, quantifiers) */
	function luaPattern(p, flags) {
		const cls = {
			d: "\\d",
			s: "\\s",
			a: "[A-Za-z]",
			w: "[A-Za-z0-9]",
			l: "[a-z]",
			u: "[A-Z]",
			x: "[0-9A-Fa-f]",
			p: "[!-/:-@[-`{-~]",
		};
		let out = "";
		for (let i = 0; i < p.length; i++) {
			const c = p[i];
			if (c === "%") {
				const n = p[++i];
				out += cls[n] ?? "\\" + n;
			} else if (c === "-") out += "*?";
			else if (c === ".") out += "[\\s\\S]";
			else if (c === "^" && i === 0) out += "^";
			else if (c === "$" && i === p.length - 1) out += "$";
			else if (c === "[") {
				let set = "[";
				for (i++; i < p.length && p[i] !== "]"; i++) {
					if (p[i] === "%") set += (cls[p[++i]] ?? "\\" + p[i]).replace(/^\[|\]$/g, "");
					else set += p[i] === "\\" ? "\\\\" : p[i];
				}
				out += set + "]";
			} else if ("()*+?".includes(c)) out += c;
			else out += c.replace(/[\\/{}|^$[\]]/g, "\\$&");
		}
		return new RegExp(out, flags);
	}

	const SP = String.prototype;
	const def = (proto, name, fn) =>
		Object.defineProperty(proto, name, { value: fn, configurable: true, writable: true });
	// String.prototype.sub is a legacy JS method (it wraps the string in <sub>): replaced by Luau's
	def(SP, "sub", function (i = 1, j = -1) {
		const n = this.length;
		let s = i < 0 ? Math.max(n + i + 1, 1) : Math.max(i, 1);
		let e = j < 0 ? n + j + 1 : Math.min(j, n);
		return s > e ? "" : this.slice(s - 1, e);
	});
	def(SP, "upper", function () {
		return this.toUpperCase();
	});
	def(SP, "lower", function () {
		return this.toLowerCase();
	});
	def(SP, "size", function () {
		return Buffer.byteLength(String(this), "utf8");
	});
	def(SP, "rep", function (n) {
		return this.repeat(n);
	});
	def(SP, "gsub", function (pattern, repl) {
		let count = 0;
		const out = this.replace(luaPattern(pattern, "g"), (...m) => {
			count++;
			return typeof repl === "string" ? repl.replace(/%(\d)/g, (_, d) => (d === "0" ? m[0] : m[+d])) : repl(m[0]);
		});
		return [out, count];
	});
	// `str.match("^%d")` in the TypeScript is Luau's string.match: a Lua pattern and a tuple (captures or the whole
	// match). A RegExp argument is JavaScript's own call (the TypeScript compiler runs in this process too)
	const jsMatch = SP.match;
	def(SP, "match", function (pattern, ...rest) {
		if (typeof pattern !== "string") return jsMatch.call(this, pattern, ...rest);
		const m = luaPattern(pattern).exec(String(this));
		if (m === null) return [undefined];
		return m.length > 1 ? m.slice(1) : [m[0]];
	});
	globalThis.string = {
		format: (fmt, ...args) => {
			let k = 0;
			return fmt.replace(/%([-0 +#]*)(\d*)(?:\.(\d+))?([dfisxX%])/g, (_, flags, width, prec, type) => {
				if (type === "%") return "%";
				const v = args[k++];
				let s;
				if (type === "d" || type === "i") s = String(Math.trunc(v));
				else if (type === "f") s = Number(v).toFixed(prec === undefined ? 6 : +prec);
				else if (type === "x") s = Math.trunc(v).toString(16);
				else if (type === "X") s = Math.trunc(v).toString(16).toUpperCase();
				else s = String(v);
				return width ? s.padStart(+width, flags.includes("0") ? "0" : " ") : s;
			});
		},
	};

	const AP = Array.prototype;
	def(AP, "isEmpty", function () {
		return this.length === 0;
	});

	// ---------------------------------------------------------------- Roblox datatypes

	const Color3 = globalThis.Color3;
	def(Color3.prototype, "ToHex", function () {
		return [this.R, this.G, this.B]
			.map(v =>
				Math.round(v * 255)
					.toString(16)
					.padStart(2, "0"),
			)
			.join("");
	});
	class Vector2 {
		constructor(x = 0, y = 0) {
			this.X = x;
			this.Y = y;
		}
		add(o) {
			return new Vector2(this.X + o.X, this.Y + o.Y);
		}
	}
	class Vector3 {
		constructor(x = 0, y = 0, z = 0) {
			this.X = x;
			this.Y = y;
			this.Z = z;
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
		static fromScale(x, y) {
			return new UDim2(x, 0, y, 0);
		}
		static fromOffset(x, y) {
			return new UDim2(0, x, 0, y);
		}
		add(o) {
			return new UDim2(
				this.X.Scale + o.X.Scale,
				this.X.Offset + o.X.Offset,
				this.Y.Scale + o.Y.Scale,
				this.Y.Offset + o.Y.Offset,
			);
		}
	}
	class Rect {
		constructor(a = 0, b = 0, c = 0, d = 0) {
			this.Min = new Vector2(a, b);
			this.Max = new Vector2(c, d);
			this.Width = c - a;
			this.Height = d - b;
		}
	}
	class TweenInfo {
		constructor(...args) {
			this.args = args;
		}
	}
	class Font {
		constructor(family, weight, style) {
			this.Family = family;
			this.Weight = weight;
			this.Style = style;
		}
	}
	class NumberSequenceKeypoint {
		constructor(time, value) {
			this.Time = time;
			this.Value = value;
		}
	}
	class NumberSequence {
		constructor(points) {
			this.Keypoints = points;
		}
	}
	Object.assign(globalThis, {
		Vector2,
		Vector3,
		UDim,
		UDim2,
		Rect,
		TweenInfo,
		Font,
		NumberSequence,
		NumberSequenceKeypoint,
	});

	const enumItems = new Map();
	globalThis.Enum = new Proxy(
		{},
		{
			get(_, type) {
				if (typeof type !== "string") return undefined;
				return new Proxy(
					{},
					{
						get(_, name) {
							if (typeof name !== "string") return undefined;
							const key = `${type}.${name}`;
							let item = enumItems.get(key);
							if (item === undefined) {
								// (luau-shim makes Map#size a method, as roblox-ts has it)
								item = { Name: name, EnumType: type, Value: enumItems.size() };
								enumItems.set(key, item);
							}
							return item;
						},
					},
				);
			},
		},
	);

	// ---------------------------------------------------------------- fake Instance tree (counted)

	class Signal {
		constructor() {
			this.conns = [];
		}
		Connect(fn) {
			const conn = {
				Connected: true,
				fn,
				Disconnect: () => {
					conn.Connected = false;
					this.conns = this.conns.filter(c => c !== conn);
				},
			};
			this.conns.push(conn);
			return conn;
		}
		Once(fn) {
			const c = this.Connect((...a) => {
				c.Disconnect();
				fn(...a);
			});
			return c;
		}
		Fire(...args) {
			for (const c of [...this.conns]) if (c.Connected) c.fn(...args);
		}
		clear() {
			for (const c of this.conns) c.Connected = false;
			this.conns = [];
		}
	}

	const INTERNAL = Symbol("instance");
	const GUI = ["GuiObject", "GuiBase2d", "GuiBase"];
	const CLASSES = {
		Frame: GUI,
		ScrollingFrame: GUI,
		CanvasGroup: GUI,
		TextLabel: GUI,
		TextBox: GUI,
		ImageLabel: GUI,
		TextButton: ["GuiButton", ...GUI],
		ImageButton: ["GuiButton", ...GUI],
		ScreenGui: ["LayerCollector", "GuiBase2d", "GuiBase"],
		PlayerGui: ["BasePlayerGui"],
		UICorner: ["UIComponent"],
		UIStroke: ["UIComponent"],
		UIPadding: ["UIComponent"],
		UIListLayout: ["UIGridStyleLayout", "UILayout", "UIComponent"],
		UITextSizeConstraint: ["UIConstraint", "UIComponent"],
		UIAspectRatioConstraint: ["UIConstraint", "UIComponent"],
		UIScale: ["UIComponent"],
		UIGradient: ["UIComponent"],
		Folder: [],
		Camera: [],
		Player: [],
	};
	const EVENTS = new Set([
		"Activated",
		"MouseEnter",
		"MouseLeave",
		"MouseButton1Click",
		"MouseButton1Down",
		"MouseButton1Up",
		"InputBegan",
		"InputChanged",
		"InputEnded",
		"WindowFocusReleased",
		"SelectionGained",
		"SelectionLost",
		"ChildAdded",
		"ChildRemoved",
		"DescendantAdded",
		"DescendantRemoving",
		"AncestryChanged",
		"Changed",
		"Destroying",
		"Heartbeat",
		"RenderStepped",
		"Stepped",
	]);

	const stats = {
		/** every counted creation / destruction, in order: { kind: "new" | "gone", inst } */
		log: [],
		/** property writes on counted Instances that already existed when the current phase began */
		writes: 0,
		seq: 0,
		phaseSeq: 0,
	};

	function defaultsFor(className) {
		const d = { ClassName: className, Name: className };
		if ((CLASSES[className] ?? []).includes("GuiObject")) {
			Object.assign(d, {
				Visible: true,
				ZIndex: 1,
				LayoutOrder: 0,
				Active: false,
				Selectable: false,
				Interactable: true,
				BackgroundTransparency: 0,
				BackgroundColor3: new Color3(1, 1, 1),
				Position: new UDim2(),
				Size: new UDim2(),
				AnchorPoint: new Vector2(),
				AbsoluteSize: new Vector2(),
				AbsolutePosition: new Vector2(),
				GuiState: Enum.GuiState.Idle,
			});
		}
		if (className === "ScrollingFrame") {
			Object.assign(d, {
				CanvasPosition: new Vector2(),
				AbsoluteCanvasSize: new Vector2(),
				CanvasSize: new UDim2(),
			});
		}
		if (className === "TextLabel" || className === "TextButton" || className === "TextBox") {
			Object.assign(d, {
				Text: "",
				TextColor3: new Color3(),
				TextTransparency: 0,
				TextStrokeTransparency: 1,
				TextSize: 14,
				RichText: false,
			});
		}
		return d;
	}

	function setParent(inst, parent) {
		const my = inst[INTERNAL];
		if (my.destroyed) throw new Error(`The Parent property of ${inst.Name} is locked (it was destroyed)`);
		if (parent === my.parent) return;
		if (parent !== undefined && (parent === inst || parent.IsDescendantOf(inst))) {
			throw new Error(`Attempt to set ${inst.Name}.Parent to a descendant`);
		}
		const old = my.parent;
		if (old !== undefined) {
			const list = old[INTERNAL].children;
			list.splice(list.indexOf(inst), 1);
			old[INTERNAL].events.get("ChildRemoved")?.Fire(inst);
		}
		my.parent = parent;
		if (parent !== undefined) {
			parent[INTERNAL].children.push(inst);
			parent[INTERNAL].events.get("ChildAdded")?.Fire(inst);
		}
		my.propSignals.get("Parent")?.Fire();
	}

	function destroy(inst) {
		const my = inst[INTERNAL];
		if (my.destroyed) return;
		my.events.get("Destroying")?.Fire();
		for (const c of [...my.children]) destroy(c);
		if (my.parent !== undefined) setParent(inst, undefined);
		my.destroyed = true;
		// like the engine: a destroyed object cannot stay selected
		const gui = services.get("GuiService");
		if (gui !== undefined && gui.SelectedObject === inst) gui.SelectedObject = undefined;
		for (const s of my.events.values()) s.clear();
		for (const s of my.propSignals.values()) s.clear();
		if (my.counted) stats.log.push({ kind: "gone", inst });
	}

	function makeInstance(className, counted) {
		const props = defaultsFor(className);
		const my = {
			className,
			children: [],
			parent: undefined,
			attrs: new Map(),
			propSignals: new Map(),
			events: new Map(),
			destroyed: false,
			counted,
			seq: ++stats.seq,
		};
		let proxy;
		const methods = {
			IsA: c => c === "Instance" || c === className || (CLASSES[className] ?? []).includes(c),
			GetChildren: () => [...my.children],
			GetDescendants: () => {
				const out = [];
				const walk = i => {
					for (const c of i[INTERNAL].children) {
						out.push(c);
						walk(c);
					}
				};
				walk(proxy);
				return out;
			},
			FindFirstChild: name => my.children.find(c => c.Name === name),
			FindFirstChildOfClass: cls => my.children.find(c => c.ClassName === cls),
			FindFirstChildWhichIsA: cls => my.children.find(c => c.IsA(cls)),
			WaitForChild: name => my.children.find(c => c.Name === name),
			IsDescendantOf: anc => {
				for (let p = my.parent; p !== undefined; p = p[INTERNAL].parent) if (p === anc) return true;
				return false;
			},
			GetAttribute: n => my.attrs.get(n),
			SetAttribute: (n, v) => {
				if (v === undefined) my.attrs.delete(n);
				else my.attrs.set(n, v);
			},
			GetPropertyChangedSignal: p => {
				let s = my.propSignals.get(p);
				if (s === undefined) {
					s = new Signal();
					my.propSignals.set(p, s);
				}
				return s;
			},
			Destroy: () => destroy(proxy),
			ClearAllChildren: () => {
				for (const c of [...my.children]) destroy(c);
			},
		};
		proxy = new Proxy(props, {
			get(t, k) {
				if (k === INTERNAL) return my;
				if (k === "Parent") return my.parent;
				if (typeof k === "string" && Object.prototype.hasOwnProperty.call(methods, k)) return methods[k];
				if (typeof k === "string" && EVENTS.has(k)) {
					let s = my.events.get(k);
					if (s === undefined) {
						s = new Signal();
						my.events.set(k, s);
					}
					return s;
				}
				return t[k];
			},
			set(t, k, v) {
				if (k === "Parent") {
					setParent(proxy, v);
					return true;
				}
				const old = t[k];
				t[k] = v;
				if (old !== v) {
					if (my.counted && my.seq <= stats.phaseSeq) stats.writes++;
					my.propSignals.get(k)?.Fire();
				}
				return true;
			},
		});
		if (counted) stats.log.push({ kind: "new", inst: proxy });
		return proxy;
	}

	/** `new Instance("Frame")`: the only way the game makes an Instance, so this is where they are counted */
	globalThis.Instance = function Instance(className) {
		return makeInstance(className, true);
	};

	const baseTypeIs = globalThis.typeIs;
	globalThis.typeIs = (v, t) => {
		const inst = v !== undefined && v !== null && v[INTERNAL] !== undefined;
		if (t === "Instance") return inst;
		if (t === "Color3") return v instanceof Color3;
		if (t === "Vector2") return v instanceof Vector2;
		if (t === "UDim2") return v instanceof UDim2;
		if (t === "table" && inst) return false;
		return baseTypeIs(v, t);
	};

	// ---------------------------------------------------------------- services, task

	const deferred = [];
	globalThis.task = {
		defer: (fn, ...a) => {
			deferred.push(() => fn(...a));
		},
		// coroutines are not simulated: the skin's texture preload, the toasts' and feed lines' lifetime loops and
		// the banner's fade-out never run here
		spawn: () => {},
		delay: () => {},
		cancel: () => {},
		wait: () => {
			throw new Error("task.wait() outside a coroutine");
		},
	};

	/** runs what task.defer queued (the engine does it at the end of the frame) */
	function flush() {
		for (let n = 0; deferred.length > 0; n++) {
			if (n > 100000) throw new Error("task.defer loop");
			deferred.shift()();
		}
	}

	const [viewW, viewH] = options.viewport ?? [1120, 630];
	const services = new Map();
	function service(name) {
		let s = services.get(name);
		if (s !== undefined) return s;
		s = makeInstance(name, false);
		services.set(name, s);
		if (name === "GuiService") {
			Object.assign(s, {
				SelectedObject: undefined,
				GuiNavigationEnabled: false,
				GetGuiInset: () => [new Vector2(0, s.TopbarInset.Max.Y), new Vector2(0, 0)],
				TopbarInset: new Rect(0, 0, 0, 0),
				PreferredTransparency: 1,
				ReducedMotionEnabled: false,
				PreferredTextSize: Enum.PreferredTextSize.Medium,
			});
		} else if (name === "UserInputService") {
			Object.assign(s, {
				KeyboardEnabled: true,
				TouchEnabled: false,
				GamepadEnabled: false,
				MouseEnabled: true,
				GetLastInputType: () => Enum.UserInputType.MouseMovement,
				GetMouseLocation: () => new Vector2(viewW / 2, viewH / 2),
				IsKeyDown: () => false,
			});
		} else if (name === "TweenService") {
			s.Create = (obj, _info, props) => ({
				Play: () => {
					for (const [k, v] of Object.entries(props)) obj[k] = v;
				},
				Cancel: () => {},
				Completed: new Signal(),
			});
		} else if (name === "Workspace") {
			const cam = makeInstance("Camera", false);
			cam.ViewportSize = new Vector2(viewW, viewH);
			s.CurrentCamera = cam;
		} else if (name === "ContentProvider") {
			s.PreloadAsync = () => {};
		} else if (name === "RunService") {
			s.IsStudio = () => false;
			s.IsClient = () => true;
			s.IsServer = () => false;
		} else if (name === "Players") {
			const player = makeInstance("Player", false);
			Object.assign(player, { Name: "Tester", UserId: 1 });
			const playerGui = makeInstance("PlayerGui", false);
			playerGui.Name = "PlayerGui";
			playerGui.Parent = player;
			s.LocalPlayer = player;
		} else if (name === "StarterGui") {
			s.SetCoreGuiEnabled = () => {};
		}
		return s;
	}
	globalThis.game = { GetService: service };

	/**
	 * Resizes the screen: the camera's ViewportSize and the Roblox top bar, with the signals the client listens to
	 * (bootstrap.ts recomputes the touch layout, skin.ts rescales the kit on the deferred refresh).
	 */
	function setViewport(w, h, topBar = 0) {
		const gui = service("GuiService");
		gui.TopbarInset = new Rect(0, 0, w, topBar);
		const cam = service("Workspace").CurrentCamera;
		cam.ViewportSize = new Vector2(w, h);
		flush();
	}

	/** starts a measured step: returns its report once `fn` ran */
	function measure(fn) {
		const from = stats.log.length;
		stats.phaseSeq = stats.seq;
		stats.writes = 0;
		fn();
		flush();
		const r = { created: 0, destroyed: 0, writes: stats.writes, log: stats.log.slice(from) };
		for (const e of r.log) {
			if (e.kind === "new") r.created++;
			else r.destroyed++;
		}
		return r;
	}

	return {
		INTERNAL,
		Signal,
		stats,
		flush,
		service,
		makeInstance,
		setViewport,
		measure,
		setClock: t => {
			clock = t;
		},
		getClock: () => clock,
	};
}
