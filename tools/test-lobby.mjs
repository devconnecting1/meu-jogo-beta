#!/usr/bin/env node
/*
 * The lobby and the Survivor screen (docs/DESIGN_RULES.md UI-10), and the town that drifts behind them.
 *
 *   npm run test:lobby
 *   PZ_SRC=<another checkout>/src node tools/test-lobby.mjs    (measures that version)
 *
 * The owner, from a screenshot of the old lobby: the Survivor column belongs on another screen, opened by the big
 * button, which must be renamed because it no longer drops you in the game; the scrolling tips ticker is "horrible
 * and makes no sense"; both screens get the reference window's vocabulary (UI-07). Then: the background of both
 * shows the real town, slowly explored, like a flyover.
 *
 * This runs the REAL lobby.ts / survivor.ts / townFlyover.ts / worldView.ts / widgets.ts / window.ts / plate.ts /
 * skin.ts / theme.ts / save.ts / world.ts under Node, over a small fake Instance tree (the one tools/test-backpack.mjs
 * uses, plus attribute signals and the gradient datatypes), and checks:
 *
 *   1. THE MENU        no ticker and no survivor column; START (steel blue, bigger) then Shop, Wardrobe,
 *                      Achievements, Records, How to play, Settings and Credits (iron), each with a pixel icon and a
 *                      subtitle only where it says something; the stage draws the survivor (from the uploaded
 *                      characters' sheets, and flat without them); nothing counts bosses.
 *   2. THE SURVIVOR    START opens it; the texts of the three states the owner named -- a fresh save (Enter the city
 *      SCREEN          · Day 1), a run in memory (Continue · Day N), a run over (Rebirth · price + New game, in the
 *                      window, no popup) -- plus the new life waiting for first light; the first-run tutorial prompt;
 *                      the town's day when the server publishes it (MP-20); X and Home go back to the menu.
 *   3. REUSE           the Bag's rule: back and forth five times, state changes and the town's live numbers create
 *                      and destroy no Instance; five whole lobbies leave nothing behind (no Instance, no connection).
 *   4. LAYOUT          at 1120 x 630, 1360 x 435 and a 844 x 390 phone under a 36 px top bar: no two elements of a
 *                      container overlap, every element stays inside its container, no label is too small for its
 *                      text, and no label floats over the town outside the opaque header band.
 *   5. GAMEPAD         START has the first focus; the Survivor screen focuses the action that works; every plate is
 *                      selectable.
 *   6. THE FLYOVER     the real town of the seed; after a warm-up over every landmark, 600 frames (and 600 more with
 *                      cuts) create no Instance; the camera glides at 25-60 u/s and only jumps while the page is
 *                      opaque; the night tint; a phone draws less and pans slower; Reduce Motion is a still frame;
 *                      the run releases every Frame and never touches its own renderer.
 *   7. SOURCE GUARDS   main.client.ts keeps the run semantics (no game-over popup, the flyover released when a run
 *                      mounts); the server publishes the attributes the lobby reads; tips.ts is gone.
 *
 * Pure Node (>= 18) plus the project's TypeScript, on the shared shims of tools/luau-shim.mjs. No layout engine: the
 * rects are computed here from the Scale / Offset / AnchorPoint / aspect the kit writes, the way the engine does.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installShims } from "./luau-shim.mjs";

// the Luau / roblox-ts dialect every node suite shares (math, Color3, typeIs, Array / Map methods, the .ts
// loader, PZ_SRC); below it, what a UI module needs on top: Luau strings, Roblox datatypes, an Instance tree
const { SRC, require } = installShims({ seed: 1 });

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
const def = (proto, name, fn) => Object.defineProperty(proto, name, { value: fn, configurable: true, writable: true });
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

// the shared shim has size / remove / unorderedRemove / clear / sort and Map / Set size()
const AP = Array.prototype;
def(AP, "insert", function (i, v) {
	this.splice(i, 0, v);
});
def(AP, "isEmpty", function () {
	return this.length === 0;
});

// ---------------------------------------------------------------- Roblox datatypes

// the shared Color3, plus what theme.ts (hex) reads
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
	constructor(keys) {
		this.Keypoints = keys;
	}
}
Object.assign(globalThis, { Vector2, UDim, UDim2, Rect, TweenInfo, Font, NumberSequence, NumberSequenceKeypoint });

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
	/** every counted creation / destruction, in order: { kind: "new" | "gone", inst, toast } */
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
		Object.assign(d, { CanvasPosition: new Vector2(), AbsoluteCanvasSize: new Vector2(), CanvasSize: new UDim2() });
	}
	if (className === "TextLabel" || className === "TextButton" || className === "TextBox") {
		Object.assign(d, { Text: "", TextColor3: new Color3(), TextTransparency: 0, TextSize: 14, RichText: false });
	}
	return d;
}

function underToast(inst) {
	for (let p = inst; p !== undefined; p = p[INTERNAL].parent) {
		if (p.Name === "ToastStack") return true;
	}
	return false;
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
	my.toastAtDestroy = underToast(inst);
	my.events.get("Destroying")?.Fire();
	for (const c of [...my.children]) destroy(c);
	if (my.parent !== undefined) setParent(inst, undefined);
	my.destroyed = true;
	// like the engine: a destroyed object cannot stay selected
	const gui = services.get("GuiService");
	if (gui !== undefined && gui.SelectedObject === inst) gui.SelectedObject = undefined;
	for (const s of my.events.values()) s.clear();
	for (const s of my.propSignals.values()) s.clear();
	for (const s of my.attrSignals.values()) s.clear();
	if (my.counted) stats.log.push({ kind: "gone", inst, toast: my.toastAtDestroy });
}

function makeInstance(className, counted) {
	const props = defaultsFor(className);
	const my = {
		className,
		children: [],
		parent: undefined,
		attrs: new Map(),
		attrSignals: new Map(),
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
		IsDescendantOf: anc => {
			for (let p = my.parent; p !== undefined; p = p[INTERNAL].parent) if (p === anc) return true;
			return false;
		},
		GetAttribute: n => my.attrs.get(n),
		SetAttribute: (n, v) => {
			const old = my.attrs.get(n);
			if (v === undefined) my.attrs.delete(n);
			else my.attrs.set(n, v);
			if (old !== v) my.attrSignals.get(n)?.Fire();
		},
		GetAttributeChangedSignal: n => {
			let s = my.attrSignals.get(n);
			if (s === undefined) {
				s = new Signal();
				my.attrSignals.set(n, s);
			}
			return s;
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

/** `new Instance("Frame")`: the kit's only way to make an Instance, so this is where they are counted */
globalThis.Instance = function Instance(className) {
	return makeInstance(className, true);
};

// the shared typeIs, plus the Roblox datatypes and Instances the kit asks about
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
let spawned = 0;
globalThis.task = {
	defer: (fn, ...a) => {
		deferred.push(() => fn(...a));
	},
	// coroutines are not simulated: the skin's texture preload and the toasts' lifetime loop never run here
	spawn: () => {
		spawned++;
	},
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

let tweens = 0;
const services = new Map();
/** the screen the fake engine reports: viewport size and the height of the Roblox top bar */
const screenSize = { w: 1120, h: 630, inset: 0 };
function service(name) {
	let s = services.get(name);
	if (s !== undefined) return s;
	s = makeInstance(name, false);
	if (name === "GuiService") {
		Object.assign(s, {
			SelectedObject: undefined,
			GetGuiInset: () => [new Vector2(0, screenSize.inset), new Vector2(0, 0)],
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
		});
	} else if (name === "TweenService") {
		s.Create = (obj, _info, props) => {
			tweens++;
			return {
				Play: () => {
					for (const [k, v] of Object.entries(props)) obj[k] = v;
				},
				Cancel: () => {},
				Completed: new Signal(),
			};
		};
	} else if (name === "Workspace") {
		const cam = makeInstance("Camera", false);
		cam.ViewportSize = new Vector2(screenSize.w, screenSize.h);
		s.CurrentCamera = cam;
	} else if (name === "ContentProvider") {
		s.PreloadAsync = () => {};
	} else if (name === "RunService") {
		s.IsStudio = () => false;
		s.IsClient = () => true;
	}
	services.set(name, s);
	return s;
}
globalThis.game = { GetService: service };
// ---------------------------------------------------------------- the modules under test

const saveClient = require(join(SRC, "client/systems/saveClient.ts"));
/** the saves the lobby asked for, by reason */
const saves = [];
saveClient.requestSave = reason => {
	saves.push(reason);
	return true;
};
/** wallet listeners the lobby holds right now (a closed lobby must hold none) */
let walletListeners = 0;
{
	const real = saveClient.onWalletChanged;
	saveClient.onWalletChanged = fn => {
		walletListeners++;
		const off = real(fn);
		return () => {
			walletListeners--;
			off();
		};
	};
}
const { showLobby, WORLD_DAY_ATTR, DAY_TIME_ATTR, IN_WORLD_ATTR } = require(join(SRC, "client/ui/lobby.ts"));
const Fly = require(join(SRC, "client/view/townFlyover.ts"));
const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
const { rebirthPrice } = require(join(SRC, "shared/data/shop.ts"));
const { WEAPONS } = require(join(SRC, "shared/data/weapons.ts"));
const { THEME, SURFACE, TRANSPARENCY } = require(join(SRC, "client/ui/theme.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const { Renderer } = require(join(SRC, "shared/engine/renderer.ts"));
const { darkAlphaAt, secondsUntilHour } = require(join(SRC, "shared/sim/clock.ts"));
const { countdown } = require(join(SRC, "client/onboarding/gameOver.ts"));
const { MAX_PLAYERS } = require(join(SRC, "shared/net/mpConfig.ts"));
const WA = require(join(SRC, "client/view/worldArt.ts"));
const { WORLD_ART } = require(join(SRC, "client/view/worldArtAssets.ts"));
const { survivorArtLive } = require(join(SRC, "client/view/charArt.ts"));
const { SURVIVOR_CELL, SURVIVOR_ROWS_EACH } = require(join(SRC, "client/view/charSheets.ts"));
flush();

/** the characters' sheets and masks (client/boot/preloadPlan.ts laterArt: survivors, weapons, zombies, dogs, birds) */
const isCharacterSheet = name => /^(survivors|weapons|zombies|dogs|birds)/.test(name);
/**
 * The uploads as they are, with the characters' sheets on -- their uploaded ids, a stand-in for one not uploaded
 * yet -- or off (the flat drawing of before, ART-01)
 */
function setCharacterArt(on) {
	const ids = {};
	for (const [name, t] of Object.entries(WORLD_ART)) {
		ids[name] = !isCharacterSheet(name) ? t.id : on ? t.id || `local:${name}` : "";
	}
	WA.overrideWorldArt(ids);
}

// ---------------------------------------------------------------- the player, the game's callbacks, the screen

const save = defaultSave();
save.tutorialDone = false;
save.firstInstall = true;
const ctx = { phase: "lobby", save, uiLayer: undefined };
{
	const gui = makeInstance("ScreenGui", false);
	const layer = makeInstance("Frame", false);
	layer.Name = "Ui";
	layer.Parent = gui;
	ctx.uiLayer = layer;
	ctx.uiGui = gui;
	// the town behind the menus is pinned in the world's ScreenGui, under the menus' one (client/bootstrap.ts)
	const world = makeInstance("ScreenGui", false);
	const backdrop = makeInstance("Frame", false);
	backdrop.Name = "Backdrop";
	backdrop.Parent = world;
	ctx.backdropLayer = backdrop;
	ctx.screen = world;
}

const calls = {
	play: 0,
	rebirth: 0,
	wait: 0,
	newRun: 0,
	shop: 0,
	settings: 0,
	credits: 0,
	wardrobe: [],
	tutorial: [],
	pages: [],
};
const handlers = {
	onPlay: () => calls.play++,
	onRebirth: () => calls.rebirth++,
	onWaitDawn: () => calls.wait++,
	onNewRun: () => calls.newRun++,
	onShop: () => calls.shop++,
	onWardrobe: from => calls.wardrobe.push(from),
	onSettings: () => calls.settings++,
	onCredits: () => calls.credits++,
	onTutorial: thenPlay => calls.tutorial.push(thenPlay === true),
	onPage: p => calls.pages.push(p),
};
const status = (over = {}) => ({ loading: false, run: "fresh", hosted: false, seed: DESIGN.TOWN_SEED, ...over });

const RunService = service("RunService");
const Workspace = service("Workspace");
const GuiService = service("GuiService");
const UserInputService = service("UserInputService");

/** a new screen size (and top bar): the camera says so, the kit refreshes on the next deferred step */
function setScreen(w, h, inset = 0) {
	screenSize.w = w;
	screenSize.h = h;
	screenSize.inset = inset;
	Workspace.CurrentCamera.ViewportSize = new Vector2(w, h);
	flush();
}

// ---------------------------------------------------------------- driving it like a player

const lobbyRoot = () => ctx.uiLayer.FindFirstChild("Lobby");
const bodyOf = () => lobbyRoot()?.FindFirstChild("Body");
const menuPage = () => bodyOf()?.FindFirstChild("Menu");
const survivorPage = () => bodyOf()?.FindFirstChild("Survivor");
const deep = (root, name) => root?.GetDescendants().find(d => d.Name === name);
/** visible on screen: it and every ancestor up to the ScreenGui */
function shown(inst) {
	for (let p = inst; p !== undefined; p = p.Parent) {
		if (p.IsA("GuiObject") && !p.Visible) return false;
	}
	return true;
}
/** visible inside `root` (the page may be the one not on screen) */
function shownIn(inst, root) {
	for (let p = inst; p !== undefined && p !== root; p = p.Parent) {
		if (p.IsA("GuiObject") && !p.Visible) return false;
	}
	return true;
}
const texts = root =>
	(root?.GetDescendants() ?? [])
		.filter(d => (d.ClassName === "TextLabel" || d.ClassName === "TextButton") && shown(d) && d.Text !== "")
		.map(d => d.Text);
function click(button, what) {
	if (button === undefined) throw new Error(`button not found: ${what}`);
	button.Activated.Fire();
	flush();
}
const frame = (dt = 1 / 60) => {
	clock += dt;
	RunService.RenderStepped.Fire(dt);
	flush();
};
const variantOf = b => b?.GetAttribute("Variant");
const sameColor = (a, b) =>
	a !== undefined && b !== undefined && Math.abs(a.R - b.R) + Math.abs(a.G - b.G) + Math.abs(a.B - b.B) < 1e-6;
const window_ = () => survivorPage()?.FindFirstChild("Window");
const actionBtn = name => window_()?.FindFirstChild(name);
const note = () => window_()?.FindFirstChild("Note")?.Text ?? "";
const popupOpen = () => ctx.uiLayer.FindFirstChild("PopupOverlay") !== undefined;
function closePopups() {
	for (const c of ctx.uiLayer.GetChildren()) if (c.Name === "PopupOverlay") c.Destroy();
	flush();
}

// ---------------------------------------------------------------- measuring (Instances made / destroyed, writes)

let failures = 0;
function check(name, ok, detail) {
	const tail = detail === undefined ? "" : `  (${detail})`;
	if (ok) console.log(`  ok    ${name}${tail}`);
	else {
		console.error(`  FALHA ${name}${tail}`);
		failures++;
	}
}

/** Instances made and destroyed while `fn` runs (popups and toasts, which are not the lobby, apart) */
function measure(fn) {
	const from = stats.log.length;
	stats.phaseSeq = stats.seq;
	stats.writes = 0;
	fn();
	flush();
	const r = { made: 0, gone: 0, writes: stats.writes };
	for (const e of stats.log.slice(from)) {
		const my = e.inst[INTERNAL];
		let popupish = e.kind === "gone" ? e.toast : underToast(e.inst);
		for (let p = e.inst; p !== undefined && !popupish; p = p[INTERNAL].parent) {
			if (p.Name === "PopupOverlay" || p.Name === "Achievements") popupish = true;
		}
		if (popupish || (e.kind === "new" && my.destroyed && my.toastAtDestroy)) continue;
		if (e.kind === "new") r.made++;
		else r.gone++;
	}
	return r;
}
const zero = r => r.made === 0 && r.gone === 0;
const cost = r => `${r.made} criadas, ${r.gone} destruidas, ${r.writes} escritas`;
/** counted Instances alive right now */
function alive() {
	let n = 0;
	for (const e of stats.log) n += e.kind === "new" ? 1 : -1;
	return n;
}

// ================================================================ 1. the menu

console.log(`Lobby: fonte ${SRC}\n`);
console.log("1) o menu: sem ticker, sem coluna do sobrevivente, START e sete chapas\n");

setScreen(1120, 630);
const renderBefore = RunService.RenderStepped.conns.length;
const aliveBefore = alive();
let lobby;
const mount = measure(() => {
	lobby = showLobby(ctx, handlers, status());
});
console.log(`  (montar o lobby: ${mount.made} Instances)`);
check("o lobby abriu no menu", lobbyRoot() !== undefined && shown(menuPage()) && lobby.page() === "menu");
check(
	"nenhum ticker de dicas",
	lobbyRoot()
		.GetDescendants()
		.every(d => !/ticker|^tip/i.test(d.Name)),
);
check(
	"so duas conexoes de quadro: as previas e o voo sobre a cidade (nenhum letreiro rolando)",
	RunService.RenderStepped.conns.length - renderBefore === 2,
	`${RunService.RenderStepped.conns.length - renderBefore}`,
);
check(
	"sem coluna do sobrevivente no menu: nada de Loadout, Current day, XP ou Wardrobe no cabecalho de um card",
	survivorPage() === undefined &&
		texts(menuPage()).every(t => !/Loadout|Current day|XP|Bosses/.test(t)) &&
		deep(menuPage(), "Survivor") === undefined,
	texts(menuPage()).join(" | "),
);
const start = menuPage().FindFirstChild("Start");
const NAV = ["Shop", "Wardrobe", "Achievements", "Records", "How to play", "Settings", "Credits"];
const nav = NAV.map((_, i) => menuPage().FindFirstChild(`Nav${i}`));
check(
	'o botao principal virou START (azul-aco, "default")',
	start?.FindFirstChild("Title")?.Text === "START" && variantOf(start) === "default",
	start?.FindFirstChild("Title")?.Text,
);
check(
	"...e e maior que as outras chapas",
	start.Size.Y.Scale > nav[0].Size.Y.Scale * 1.8,
	`${(start.Size.Y.Scale / nav[0].Size.Y.Scale).toFixed(2)}x`,
);
check(
	"depois dele, em coluna e nesta ordem: Shop, Wardrobe, Achievements, Records, How to play, Settings, Credits",
	nav.every((b, i) => b?.FindFirstChild("Title")?.Text === NAV[i]) &&
		nav.every((b, i) => i === 0 || b.Position.Y.Scale > nav[i - 1].Position.Y.Scale) &&
		nav[0].Position.Y.Scale > start.Position.Y.Scale,
	nav.map(b => b?.FindFirstChild("Title")?.Text).join(", "),
);
check(
	"todas em ferro (secondary)",
	nav.every(b => variantOf(b) === "secondary"),
);
check(
	"cada uma com um icone de pixel desenhado com Frames",
	[start, ...nav].every(
		b =>
			(b
				.FindFirstChild("Icon")
				?.GetChildren()
				.filter(p => p.Name === "Px").length ?? 0) > 0,
	),
);
const subOf = b =>
	shown(b?.FindFirstChild("Sub") ?? { IsA: () => false, Parent: undefined })
		? b.FindFirstChild("Sub")?.Text
		: undefined;
check(
	"subtitulo so onde diz algo: Packs & costumes, a colecao, as conquistas, o recorde",
	subOf(nav[0]) === "Packs & costumes" &&
		/^\d+ \/ \d+$/.test(subOf(nav[1]) ?? "") &&
		/^\d+ \/ \d+$/.test(subOf(nav[2]) ?? "") &&
		subOf(nav[3]) === `Best day ${save.bestDay}` &&
		nav.slice(4).every(b => b.FindFirstChild("Sub") === undefined),
	nav.map(b => subOf(b) ?? "-").join(" | "),
);
check("START de um save novo nao tem subtitulo", !shown(start.FindFirstChild("Sub")));
// the stage's survivor (SurvivorPreview), both ways the world draws one: from the characters' sheets (ART-09: the
// body's cell of the outfit worn -- none, so the plain rows of survivorsA -- and the dagger's cell), and without them
// (ART-01: the flat drawing of before, feet, torso, hands, head and the blade, more than 5 Frames)
const stageSprites = () => (deep(deep(menuPage(), "Stage"), "Sprites")?.GetChildren() ?? []).filter(f => f.Visible);
const stageCells = () =>
	stageSprites()
		.map(f => f.GetChildren().find(c => c.ClassName === "ImageLabel" && c.Visible))
		.filter(im => im !== undefined);
{
	setCharacterArt(true);
	frame();
	const cells = stageCells();
	const body = cells.find(im => im.Image === WA.artId("survivorsA"));
	const row = body === undefined ? -1 : (body.ImageRectOffset?.Y ?? 0) / SURVIVOR_CELL;
	const weapon = cells.find(im => im.Image === WA.artId("weapons"));
	check(
		"o palco desenha o sobrevivente (SurvivorPreview) com a pixel art enviada: o corpo do traje vestido e a arma",
		survivorArtLive() && body !== undefined && row >= 0 && row < SURVIVOR_ROWS_EACH && weapon !== undefined,
		`${stageSprites().length} sprites; corpo ${body?.Image ?? "-"} linha ${row}; arma ${weapon?.Image ?? "-"}`,
	);
	setCharacterArt(false);
	frame();
	check(
		"...e sem as folhas dos personagens, o desenho liso de antes",
		!survivorArtLive() && stageCells().length === 0 && stageSprites().length > 5,
		`${stageSprites().length} sprites`,
	);
	WA.overrideWorldArt(undefined);
	frame();
}
const townCell = i => deep(deep(menuPage(), "Town"), `Cell${i}`);
check(
	"offline, a cidade e a sua: Day 1, Solo; sem cidade caida, duas celulas",
	townCell(0).FindFirstChild("Value").Text === "Day 1" &&
		townCell(1).FindFirstChild("Value").Text === "Solo" &&
		!shown(townCell(2)),
	`${townCell(0).FindFirstChild("Value").Text} / ${townCell(1).FindFirstChild("Value").Text}`,
);
check(
	"ninguem conta chefes (CON-03: o Nucleo 1 nao tem chefe)",
	texts(lobbyRoot()).every(t => !/boss/i.test(t)),
);
// the owner, 2026-09-23: the opaque band behind the header read as a black strip cut across the town
check("nenhuma faixa opaca cortando a cidade no topo", lobbyRoot().FindFirstChild("HeaderBand") === undefined);
{
	const plate = menuPage().FindFirstChild("StatusPlate");
	lobby.refresh(status({ hosted: false, offlineNote: "Saving is unavailable in this environment" }));
	check(
		"o aviso (vermelho) mora numa plaquinha do painel, nao solto sobre a cidade",
		plate !== undefined &&
			shown(plate) &&
			sameColor(plate.BackgroundColor3, SURFACE.panel) &&
			plate.FindFirstChild("Status")?.Text !== "",
	);
	lobby.refresh(status({ hosted: true }));
	check("sem aviso, sem plaquinha", !shown(plate));
}

// ================================================================ 2. the Survivor screen

console.log("\n2) START abre a tela Survivor: os tres estados, o tutorial, o X e o Home\n");

let r = measure(() => click(start, "START"));
console.log(`  (a tela Survivor, na primeira vez: ${r.made} Instances)`);
check(
	"START abre a tela Survivor (a janela UI-07) e esconde o menu",
	shown(survivorPage()) && !shown(menuPage()) && lobby.page() === "survivor",
);
check("...e avisa a pagina a quem a guarda", calls.pages.at(-1) === "survivor");
check(
	'janela: titulo "Survivor", o "?" e o X vermelho',
	window_().FindFirstChild("Title")?.Text === "Survivor" &&
		window_().FindFirstChild("Help") !== undefined &&
		variantOf(window_().FindFirstChild("Close")) === "destructive",
);
check(
	'save novo: "Enter the city  ·  Day 1", sem Rebirth nem New game',
	shown(actionBtn("Enter")) &&
		actionBtn("Enter").Text === "Enter the city  ·  Day 1" &&
		!shown(actionBtn("Rebirth")) &&
		!shown(actionBtn("NewGame")),
	actionBtn("Enter").Text,
);
check("...em azul-aco (a acao principal)", variantOf(actionBtn("Enter")) === "default");
const statValue = name =>
	deep(deep(window_(), name), "Value")
		?.GetChildren()
		.find(c => c.Name === "Value")?.Text;
check(
	"estatisticas no estilo das linhas de ajuste: This life, Record, Level com a barra de XP",
	statValue("Life") === "Day 1" &&
		statValue("Record") === `Day ${save.bestDay}` &&
		deep(deep(window_(), "Level"), "Legend")?.Text === String(save.level) &&
		deep(deep(window_(), "Level"), "Xp") !== undefined,
	`${statValue("Life")} / ${statValue("Record")} / nivel ${deep(deep(window_(), "Level"), "Legend")?.Text}`,
);
const slot = i => deep(window_(), `Slot${i}`);
const slotName = i =>
	slot(i)
		?.GetChildren()
		.find(c => c.Name === "Name")?.Text;
const weaponName = WEAPONS[save.equipWeapon >= 0 ? save.equipWeapon : 0].name;
const slotIcon = i => deep(slot(i), "ItemIcon")?.GetAttribute("Icon");
check(
	"loadout: seis ladrilhos com o icone do Bag (UI-11); o vazio diz Empty e nao desenha nada",
	[0, 1, 2, 3, 4, 5].every(i => slot(i) !== undefined && deep(slot(i), "ItemIcon") !== undefined) &&
		slotName(0) === weaponName &&
		typeof slotIcon(0) === "string" &&
		slotIcon(0) !== "" &&
		[1, 2, 3, 4, 5].some(i => slotName(i) === "Empty") &&
		[1, 2, 3, 4, 5].every(i => (slotName(i) === "Empty") === (slotIcon(i) === "")),
	[0, 1, 2, 3, 4, 5].map(i => `${slotName(i)}:${slotIcon(i)}`).join(" | "),
);
const face = t => t?.FindFirstChild("PlateFace")?.BackgroundColor3;
const emptySlot = [1, 2, 3, 4, 5].find(i => slotName(i) === "Empty");
check(
	"o ocupado e ferro, o vazio e o ladrilho escuro (UI-07)",
	sameColor(face(slot(0)), THEME.secondary) && sameColor(face(slot(emptySlot)), SURFACE.section),
);
check(
	"nada de chefes na tela Survivor",
	texts(survivorPage()).every(t => !/boss/i.test(t)),
);
check(
	"a janela nao usa o scrim do mundo nem cobre a cidade inteira: ha cidade em volta",
	window_().Size.X.Scale < 0.9 && window_().Size.Y.Scale < 1,
);

// the first run asks about the tutorial, as the lobby's old Play did
click(actionBtn("Enter"), "Enter");
check("primeira vez: Enter pergunta pelo tutorial antes da cidade", popupOpen() && calls.play === 0);
click(deep(ctx.uiLayer.FindFirstChild("PopupOverlay"), "PopupBtn0"), "No");
check(
	'"No": entra na cidade (onPlay), nao pergunta de novo e o coach da primeira partida fica desligado (declineTutorial)',
	calls.play === 1 && save.tutorialDone === true && save.firstInstall === false && saves.at(-1) === "auto",
	`tutorialDone ${save.tutorialDone}, firstInstall ${save.firstInstall}, save ${saves.at(-1)}`,
);
click(actionBtn("Enter"), "Enter");
check("da segunda vez vai direto", calls.play === 2 && !popupOpen());
save.tutorialDone = false;
click(actionBtn("Enter"), "Enter");
click(deep(ctx.uiLayer.FindFirstChild("PopupOverlay"), "PopupBtn1"), "Yes");
check('"Yes": o tutorial, e a cidade depois dele', calls.tutorial.at(-1) === true && calls.play === 2);
save.tutorialDone = true;
closePopups();
click(deep(window_(), "Wardrobe"), "Wardrobe");
check("o atalho do Wardrobe abre o guarda-roupa e volta para esta tela", calls.wardrobe.at(-1) === "survivor");

console.log("\n3) os estados da partida: em memoria, o dia do mundo, fim de partida, vida nova, cidade caida\n");

save.day = 5;
r = measure(() => lobby.refresh(status({ run: "suspended" })));
check(
	'partida em memoria: "Continue  ·  Day 5"',
	actionBtn("Enter").Text === "Continue  ·  Day 5",
	actionBtn("Enter").Text,
);
check("reescrever o estado nao cria nem destroi Instance", zero(r), cost(r));
check(
	'e o START do menu diz "Continue this run"',
	menuPage().FindFirstChild("Start").FindFirstChild("Sub").Text === "Continue this run",
);

// MP-20: the town's own day, published by the server
save.day = 1;
Workspace.SetAttribute(WORLD_DAY_ATTR, 7);
Workspace.SetAttribute(DAY_TIME_ATTR, 21.5);
Workspace.SetAttribute(IN_WORLD_ATTR, 2);
flush();
r = measure(() => lobby.refresh(status({ hosted: true })));
check(
	'num servidor, o botao diz o dia da CIDADE: "Enter the city  ·  Day 7" (MP-20)',
	actionBtn("Enter").Text === "Enter the city  ·  Day 7",
	actionBtn("Enter").Text,
);
check(
	"...e uma linha explica por que a vida diz outro numero",
	statValue("Life") === "Day 1" && note().includes("The town keeps its own day"),
	note(),
);
r = measure(() => {
	Workspace.SetAttribute(WORLD_DAY_ATTR, 8);
	Workspace.SetAttribute(DAY_TIME_ATTR, 21.6);
});
check("o dia que muda no servidor chega sozinho", actionBtn("Enter").Text === "Enter the city  ·  Day 8");
check("...sem criar nem destruir Instance", zero(r), cost(r));
check(
	"o painel da cidade no menu: Day 8, Night (lua), 2 / 6 in town",
	townCell(0).FindFirstChild("Value").Text === "Day 8" &&
		townCell(0).FindFirstChild("Caption").Text === "Night" &&
		shownIn(townCell(0).FindFirstChild("Moon"), menuPage()) &&
		!shownIn(townCell(0).FindFirstChild("Icon"), menuPage()) &&
		townCell(1).FindFirstChild("Value").Text === `2 / ${MAX_PLAYERS}` &&
		townCell(1).FindFirstChild("Caption").Text === "in town",
	`${townCell(0).FindFirstChild("Value").Text} ${townCell(0).FindFirstChild("Caption").Text} / ${townCell(1).FindFirstChild("Value").Text} ${townCell(1).FindFirstChild("Caption").Text}`,
);

// MP-21: the run is over -- the choice lives in the window, with every way out the server honours
save.runOver = true;
save.deathCount = 1;
save.money = 5;
const price = rebirthPrice(1);
const waitBtn = () => actionBtn("Wait");
/** the MP-21 row on screen, left to right */
const rowOf = () =>
	["NewGame", "Wait", "Rebirth", "Enter"]
		.filter(n => shown(actionBtn(n)))
		.sort((a, b) => actionBtn(a).Position.X.Scale - actionBtn(b).Position.X.Scale);
const dawnLeft = hour => countdown(secondsUntilHour(hour, 6));

// (a) a server that revives at daybreak (it owns the death, its clock ran here), at night: 21:36
r = measure(() => lobby.refresh(status({ hosted: true, run: "over", clockDriven: true })));
check(
	`fim de partida num servidor que levanta ao amanhecer: New game | Wait for daybreak | Rebirth  ·  ${price}, no lugar do Enter`,
	JSON.stringify(rowOf()) === '["NewGame","Wait","Rebirth"]' &&
		actionBtn("Rebirth").Text === `Rebirth  ·  ${price}` &&
		variantOf(actionBtn("Rebirth")) === "default" &&
		waitBtn().Text === "Wait for daybreak" &&
		variantOf(waitBtn()) === "secondary" &&
		actionBtn("NewGame").Text === "New game" &&
		variantOf(actionBtn("NewGame")) === "destructive",
	`${rowOf().join(" | ")}: ${rowOf()
		.map(n => `${actionBtn(n).Text} (${variantOf(actionBtn(n))})`)
		.join(", ")}`,
);
check("...dentro da janela: nenhum popup por cima", !popupOpen());
check(
	"...com o texto das tres saidas, quanto falta para as 06:00 (a noite no relogio do mundo) e quanto falta de moedas",
	note().startsWith("Rebirth wakes you now, for coins. Waiting for daybreak is free and keeps this life.") &&
		note().includes(`Daybreak in ${dawnLeft(21.6)}`) &&
		note().includes(`Not enough coins: ${price - 5} more needed`),
	note().replace(/\n/g, " / "),
);
check("trocar para o fim de partida nao cria Instance", zero(r), cost(r));
r = measure(() => Workspace.SetAttribute(DAY_TIME_ATTR, 22.1));
check(
	"a contagem anda com o relogio do servidor, sem criar Instance",
	note().includes(`Daybreak in ${dawnLeft(22.1)}`) && zero(r),
	`${cost(r)}; ${note().split("\n").at(-1)}`,
);
check(
	'o START do menu diz "Your run is over"',
	menuPage().FindFirstChild("Start").FindFirstChild("Sub").Text === "Your run is over",
);
click(actionBtn("Rebirth"), "Rebirth");
click(waitBtn(), "Wait for daybreak");
click(actionBtn("NewGame"), "New game");
check(
	"Rebirth, Wait for daybreak e New game chamam os caminhos de sempre (doRebirth / enterToWait mantendo a vida / doNewRun)",
	calls.rebirth === 1 && calls.wait === 1 && calls.newRun === 1,
	`${calls.rebirth} / ${calls.wait} / ${calls.newRun}`,
);
// (b) by day the server's own cap (one night from the death) may wake the survivor sooner: no number is promised
Workspace.SetAttribute(DAY_TIME_ATTR, 12);
flush();
check(
	"de dia a espera continua oferecida, mas sem prometer um numero",
	shown(waitBtn()) && !note().includes("Daybreak in"),
	note().replace(/\n/g, " / "),
);
// (c) a survivor who joined dead: the run's clock never ran here, but the server publishes the world's hour
r = measure(() => lobby.refresh(status({ hosted: true, run: "over", clockDriven: false })));
check("quem entrou morto: a hora que o servidor publica basta para oferecer a espera", shown(waitBtn()) && zero(r));
// (d) no clock of the server anywhere: the MP-21 choice without the wait (the old two)
Workspace.SetAttribute(DAY_TIME_ATTR, undefined);
r = measure(() => lobby.refresh(status({ hosted: true, run: "over", clockDriven: false })));
check(
	"sem relogio do servidor: so New game | Rebirth, com o texto da MP-21/MP-22 de antes",
	JSON.stringify(rowOf()) === '["NewGame","Rebirth"]' &&
		note().startsWith("Rebirth wakes you now. New game starts a new life at day 1,") &&
		!note().includes("Daybreak in"),
	`${rowOf().join(" | ")} / ${note().split("\n")[0]}`,
);
check("...e a fileira volta a duas chapas sem criar Instance", zero(r), cost(r));
r = measure(() => lobby.refresh(status({ hosted: true, run: "over", clockDriven: true })));
check(
	"o relogio da partida foi do servidor (hora nao publicada): a espera volta, sem contagem",
	JSON.stringify(rowOf()) === '["NewGame","Wait","Rebirth"]' && !note().includes("Daybreak in") && zero(r),
	`${rowOf().join(" | ")}, ${cost(r)}`,
);
// (e) offline: nobody revives at daybreak
Workspace.SetAttribute(DAY_TIME_ATTR, 23);
lobby.refresh(status({ hosted: false, run: "over", clockDriven: true }));
check(
	"offline: so Rebirth e New game, com o texto de antes (sem espera pela luz)",
	JSON.stringify(rowOf()) === '["NewGame","Rebirth"]' &&
		note().startsWith("Rebirth to continue this run, or start a new game from day 1."),
	`${rowOf().join(" | ")} / ${note().split("\n")[0]}`,
);
Workspace.SetAttribute(DAY_TIME_ATTR, 21.6);
flush();
lobby.refresh(status({ hosted: true, run: "newLife" }));
check(
	'vida nova esperando a primeira luz: "Enter the city", e o texto dela',
	shown(actionBtn("Enter")) &&
		actionBtn("Enter").Text === "Enter the city" &&
		!shown(actionBtn("Rebirth")) &&
		note().startsWith("Your new life wakes at first light."),
	`${actionBtn("Enter").Text} / ${note().split("\n")[0]}`,
);
r = measure(() => lobby.refresh(status({ hosted: true, run: "newLife", fellOn: 12 })));
check(
	"MP-22: a cidade que caiu aparece no painel (terceira celula)",
	shownIn(townCell(2), menuPage()) &&
		townCell(2).FindFirstChild("Value").Text === "Day 12" &&
		townCell(2).FindFirstChild("Caption").Text === "last town fell",
);
check("...sem criar Instance", zero(r), cost(r));
save.runOver = false;
save.money = 40;

// X and Home go back to the menu
click(window_().FindFirstChild("Close"), "X");
check("o X volta para o menu", shown(menuPage()) && !shown(survivorPage()) && calls.pages.at(-1) === "menu");
click(start, "START");
click(actionBtn("Home"), "Home");
check("Home volta para o menu", shown(menuPage()) && !shown(survivorPage()) && lobby.page() === "menu");

console.log("\n4) reuso (a regra do Bag)\n");
r = measure(() => {
	for (let i = 0; i < 5; i++) {
		click(start, "START");
		click(window_().FindFirstChild("Close"), "X");
	}
});
check("5 idas e voltas entre o menu e a tela Survivor: nenhuma Instance criada nem destruida", zero(r), cost(r));
r = measure(() => {
	for (let i = 0; i < 30; i++) frame();
});
check("30 quadros do lobby parado (previa + cidade) nao criam Instance depois do aquecimento", zero(r), cost(r));

// ================================================================ 5. gamepad

console.log("\n5) controle: foco inicial e chapas selecionaveis\n");
UserInputService.GetLastInputType = () => Enum.UserInputType.Gamepad1;
lobby.show("menu");
check("no menu, o foco comeca no START", GuiService.SelectedObject === start);
lobby.show("survivor");
check("na tela Survivor, na acao principal (Enter)", GuiService.SelectedObject === actionBtn("Enter"));
save.runOver = true;
save.money = 0;
lobby.refresh(status({ run: "over" }));
lobby.show("survivor");
check(
	"fim de partida sem moedas: o foco vai para o que funciona (New game)",
	GuiService.SelectedObject === actionBtn("NewGame"),
);
lobby.refresh(status({ run: "over", hosted: true, clockDriven: true }));
lobby.show("survivor");
check(
	"...e, onde a espera e oferecida, para a espera (gratis, a mesma vida)",
	GuiService.SelectedObject === actionBtn("Wait"),
);
save.money = 1000;
lobby.refresh(status({ run: "over", hosted: true, clockDriven: true }));
lobby.show("survivor");
check("...com moedas, para o Rebirth", GuiService.SelectedObject === actionBtn("Rebirth"));
lobby.show("menu");
check("voltar ao menu devolve o foco ao START", GuiService.SelectedObject === start);
check(
	"toda chapa na tela e selecionavel",
	lobbyRoot()
		.GetDescendants()
		.filter(d => d.ClassName === "TextButton" && d.Name !== "InputBlocker" && shown(d))
		.every(b => b.Selectable === true),
);
UserInputService.GetLastInputType = () => Enum.UserInputType.MouseMovement;
GuiService.SelectedObject = undefined;
save.runOver = false;
save.money = 40;
lobby.refresh(status());

// ================================================================ 6. layout

console.log("\n6) layout: nada se sobrepoe, nada sai do lugar, nenhum texto cortado\n");

/** the rect of `g` on screen (px), from the kit's Scale / Offset / AnchorPoint / aspect, like the engine */
function rectOf(g) {
	const chain = [];
	for (let p = g; p !== undefined && p !== lobbyRoot(); p = p.Parent) chain.unshift(p);
	let rect = { x: 0, y: 0, w: screenSize.w, h: screenSize.h };
	for (const n of chain) {
		let w = n.Size.X.Scale * rect.w + n.Size.X.Offset;
		let h = n.Size.Y.Scale * rect.h + n.Size.Y.Offset;
		const ar = n.FindFirstChildOfClass("UIAspectRatioConstraint");
		if (ar !== undefined) {
			if (w / h > ar.AspectRatio) w = h * ar.AspectRatio;
			else h = w / ar.AspectRatio;
		}
		const x = rect.x + n.Position.X.Scale * rect.w + n.Position.X.Offset - n.AnchorPoint.X * w;
		const y = rect.y + n.Position.Y.Scale * rect.h + n.Position.Y.Offset - n.AnchorPoint.Y * h;
		rect = { x, y, w, h };
	}
	return rect;
}
const EPS = 0.75;
const overlap = (a, b) =>
	Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > EPS &&
	Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > EPS;
const inside = (c, p) =>
	c.x >= p.x - EPS && c.y >= p.y - EPS && c.x + c.w <= p.x + p.w + EPS && c.y + c.h <= p.y + p.h + EPS;
/** overlaps the kit draws on purpose: the "?" sits inside its ring (window.ts HelpButton) */
const MEANT = new Set(["Hole|Glyph", "Glyph|Hole"]);
/** what the kit placed (it carries a design space): plates' relief, skin layers and pooled sprites do not */
const placed = g => g.IsA("GuiObject") && g.Visible && typeof g.GetAttribute("DesignW") === "number";
const path = g => {
	const out = [];
	for (let p = g; p !== undefined && p !== lobbyRoot(); p = p.Parent) out.unshift(p.Name);
	return out.slice(1).join(".");
};

/** every container: its placed children do not overlap, and stay inside it */
function layoutProblems(root) {
	const problems = [];
	const walk = container => {
		const kids = container.GetChildren().filter(placed);
		const rects = kids.map(rectOf);
		const outer = rectOf(container);
		for (let i = 0; i < kids.length; i++) {
			if (!inside(rects[i], outer)) problems.push(`fora: ${path(kids[i])}`);
			for (let j = i + 1; j < kids.length; j++) {
				if (MEANT.has(`${kids[i].Name}|${kids[j].Name}`)) continue;
				if (overlap(rects[i], rects[j])) problems.push(`sobrepoe: ${path(kids[i])} x ${kids[j].Name}`);
			}
			walk(kids[i]);
		}
	};
	walk(root);
	return problems;
}

/** a label whose text does not fit its box even at the smallest size TextScaled may draw it (clipped) */
function textProblems(root, strict) {
	const problems = [];
	for (const l of root.GetDescendants()) {
		if (l.ClassName !== "TextLabel" || !shown(l)) continue;
		const text = String(l.Text ?? "").replace(/<[^>]+>/g, "");
		if (text === "") continue;
		const c = l.FindFirstChildOfClass("UITextSizeConstraint");
		if (c === undefined) continue; // a key legend: its key grows to fit it
		const box = rectOf(l);
		// the size it has to fit at: the floor TextScaled can shrink to (clipped below it), or, at the design
		// resolution, three quarters of the design size (nothing should need shrinking much there)
		const px = strict ? Math.max(c.MinTextSize, c.MaxTextSize * 0.75) : c.MinTextSize;
		const bold =
			l.FontFace?.Weight?.Name !== undefined && /Bold|SemiBold|ExtraBold|Heavy/.test(l.FontFace.Weight.Name);
		const perChar = px * (bold ? 0.57 : 0.52);
		const lineH = px * 1.15;
		const lines = l.TextWrapped ? Math.max(1, Math.floor((box.h + EPS) / lineH)) : 1;
		let need = 0;
		for (const seg of text.split("\n"))
			need += Math.max(1, Math.ceil((Array.from(seg).length * perChar) / box.w - 1e-9));
		if (box.h + EPS < px || need > lines) {
			problems.push(
				`${path(l)} "${text.slice(0, 32)}" ${box.w.toFixed(0)}x${box.h.toFixed(0)} px @ ${px.toFixed(1)} px`,
			);
		}
	}
	return problems;
}

/**
 * A label straight on the menu page floats over the town. Only `foreground` may: the scrim holds it at 4,5:1 over a
 * white world (test:contrast, UI-10). Anything in another colour has to sit on a plate of its own.
 */
function floatingText(page) {
	return page
		.GetChildren()
		.filter(c => c.ClassName === "TextLabel" && shown(c) && c.Text !== "")
		.filter(c => !sameColor(c.TextColor3, THEME.foreground))
		.map(c => c.Name);
}

const SCREENS = [
	[1120, 630, 0, "1120 x 630 (o espaco de desenho)"],
	[1360, 435, 0, "1360 x 435 (largo e baixo)"],
	[844, 390, 36, "celular 844 x 390, barra do Roblox de 36 px"],
];
const LAYOUT_STATES = [
	["menu", status({ hosted: true, fellOn: 12, run: "suspended", loading: true })],
	["survivor", status({ hosted: true, fellOn: 12, run: "suspended", loading: true })],
	["survivor, fim de partida com a espera", status({ hosted: true, run: "over", clockDriven: true })],
];
for (const [w, h, inset, label] of SCREENS) {
	setScreen(w, h, inset);
	for (const [page, st] of LAYOUT_STATES) {
		save.runOver = st.run === "over";
		save.money = st.run === "over" ? 5 : 40;
		lobby.refresh(st);
		lobby.show(page === "menu" ? "menu" : "survivor");
		const root = page === "menu" ? menuPage() : survivorPage();
		const lay = layoutProblems(root);
		check(`${label}, ${page}: nada se sobrepoe nem sai do seu lugar`, lay.length === 0, lay.slice(0, 6).join("; "));
		const tp = textProblems(root, w === 1120);
		check(`${label}, ${page}: nenhum texto cortado`, tp.length === 0, tp.slice(0, 6).join("; "));
		if (page === "menu") {
			const fl = floatingText(root);
			check(
				`${label}: nenhum texto do menu solto sobre a cidade fora da cor clara (as outras cores em plaquinha)`,
				fl.length === 0,
				fl.join(", "),
			);
		} else {
			const loose = root
				.GetDescendants()
				.filter(d => d.ClassName === "TextLabel" && shown(d) && !d.IsDescendantOf(window_()));
			check(`${label}: na tela Survivor todo texto esta dentro da janela`, loose.length === 0);
		}
	}
}
setScreen(1120, 630);
save.runOver = false;
save.money = 40;
lobby.show("menu");
lobby.refresh(status());

// ================================================================ 7. closing, and five whole lobbies

console.log("\n7) fechar: nada fica para tras, em cinco lobbies inteiros\n");
const attrConns = () => [...Workspace[INTERNAL].attrSignals.values()].reduce((n, s) => n + s.conns.length, 0);
lobby.close();
flush();
check("fechar tira a tela", lobbyRoot() === undefined);
// the flyover is the backdrop of ALL the menus (UI-10): the screen the lobby hands over to (Settings, the Wardrobe, the
// Shop...) stands on it, so closing the lobby leaves it pinned and gliding -- its one frame connection is the only one
check(
	"...e desliga tudo o que ela ouvia: quadros, carteira, atributos do mundo (so o voo continua, atras da proxima tela)",
	RunService.RenderStepped.conns.length === renderBefore + 1 && walletListeners === 0 && attrConns() === 0,
	`quadro ${RunService.RenderStepped.conns.length - renderBefore}, carteira ${walletListeners}, atributos ${attrConns()}`,
);
check(
	"o voo sobre a cidade continua preso no fundo, na ScreenGui do mundo e nao na dos menus (a proxima tela de menu o mostra; so a partida o solta)",
	Fly.activeFlyover() !== undefined &&
		Fly.activeFlyover().layer.Parent === ctx.backdropLayer &&
		!Fly.activeFlyover().layer.IsDescendantOf(ctx.uiGui),
);
const aliveKept = alive();
const perCycle = [];
for (let i = 0; i < 5; i++) {
	const l = showLobby(ctx, handlers, status());
	flush();
	click(menuPage().FindFirstChild("Start"), "START");
	frame();
	click(window_().FindFirstChild("Close"), "X");
	l.close();
	flush();
	perCycle.push(alive() - aliveKept);
}
check(
	"5 lobbies abertos (menu, tela Survivor, um quadro) e fechados: nenhuma Instance a mais depois de cada um",
	perCycle.every(n => n === 0),
	perCycle.join(", "),
);
Fly.releaseFlyover();
flush();
check(
	"e quando a partida comeca, o voo vai junto: nada vivo alem do que existia antes do lobby",
	alive() === aliveBefore,
	`${alive() - aliveBefore}`,
);

// ================================================================ 8. the town flyover

console.log("\n8) o voo sobre a cidade (UI-10)\n");
setScreen(1920, 1080);
const host = makeInstance("Frame", false);
host.Name = "Host";
host.Parent = ctx.uiLayer;
// the run's own world layer and renderer: the flyover must never draw into them
const worldLayer = makeInstance("Frame", false);
worldLayer.Name = "World";
const runRenderer = new Renderer(worldLayer, "Sprites");
const runRenderBefore = RunService.RenderStepped.conns.length;
const aliveHost = alive();
let fly = Fly.attachFlyover(host, DESIGN.TOWN_SEED, 1);
flush();
const town = Fly.townFor(DESIGN.TOWN_SEED);
frame();
const townSprites = () =>
	fly.layer
		.FindFirstChild("Town")
		.GetChildren()
		.filter(f => f.Visible);
const [cx0, cy0] = fly.cameraAt();
const landmarks = town.solids.filter(s => s.kind === "building" && (s.buildingType ?? 1) >= 3);
const inView = landmarks.filter(s => Math.abs((s.doorX ?? s.x) - cx0) < 960 && Math.abs((s.doorY ?? s.y) - cy0) < 540);
check(
	"desenha a cidade DE VERDADE da semente: o primeiro plano ja mostra um ponto de referencia (nao uma casa)",
	townSprites().length > 50 && inView.length > 0,
	`${townSprites().length} sprites, ${inView.length} ponto(s) de referencia no quadro`,
);
// a roof is either flat (the Frame's own colour) or, once its texture is uploaded (ART-01..06), a grey image TINTED
// with the roof's colour or one of its shades (worldView.ts roofShadesOf: the sunlit slope, the shaded one, the ridge)
const roofTones = town.solids
	.filter(s => s.kind === "building" && s.roofColor !== undefined)
	.flatMap(s => [0, 0.1, 0.24, 0.4].map(k => s.roofColor.Lerp(Color3.fromRGB(0, 0, 0), k)));
const toneOf = f => {
	const img = f.FindFirstChild("I");
	return img !== undefined && img.Visible !== false && img.Image !== "" ? img.ImageColor3 : f.BackgroundColor3;
};
check(
	"...com os telhados da cidade (as cores dos predios gerados, lisas ou tingindo a textura)",
	townSprites().some(f => roofTones.some(c => sameColor(toneOf(f), c))),
);
check(
	"o scrim entre a cidade e os menus e o da pagina, em TRANSPARENCY.backdrop",
	sameColor(fly.layer.FindFirstChild("Scrim").BackgroundColor3, THEME.background) &&
		fly.layer.FindFirstChild("Scrim").BackgroundTransparency === TRANSPARENCY.backdrop,
);
check(
	"nunca desenha no renderer da partida",
	worldLayer.GetDescendants().length === 1 && runRenderer.drawCount() === 0,
);

// warm-up: two whole loops over every landmark (each shot shows another street)
let jumps = 0;
let prev = fly.cameraAt();
for (let i = 0; i < 20000 && jumps < landmarks.length * 2; i++) {
	frame(1);
	const now = fly.cameraAt();
	if (Math.hypot(now[0] - prev[0], now[1] - prev[1]) > 200) jumps++;
	prev = now;
}
check("aquecimento: duas voltas por todos os pontos de referencia", jumps >= landmarks.length * 2, `${jumps} cortes`);
r = measure(() => {
	for (let i = 0; i < 600; i++) frame(1 / 60);
});
const moved = Math.hypot(fly.cameraAt()[0] - prev[0], fly.cameraAt()[1] - prev[1]);
check("600 quadros a 60 fps depois do aquecimento: nenhuma Instance criada nem destruida", zero(r), cost(r));
check("...e a camera andou", moved > 50, `${moved.toFixed(0)} u`);
// the cuts get their own warm-up: one unmeasured run of the same frames. A sprite slot of the pool makes its UIStroke
// the first time a stroked rect lands in it (renderer.ts: lazily, then kept); with compound roofs (a stroked rect
// per part, EDI-14) the loops above do not always meet every such slot, and the first run with cuts would. After
// this one the pool is saturated: six more runs of 600 frames created nothing (measured when this was added).
for (let i = 0; i < 600; i++) frame(0.25);
r = measure(() => {
	for (let i = 0; i < 600; i++) frame(0.25);
});
check("600 quadros com cortes de plano (150 s): nenhuma Instance criada nem destruida", zero(r), cost(r));

// the glide: speed and cuts
{
	let maxSpeed = 0;
	let snapsInView = 0;
	let cuts = 0;
	let shotStart = fly.cameraAt();
	let shotTime = 0;
	const avgs = [];
	let last = fly.cameraAt();
	for (let i = 0; i < 60 * 150; i++) {
		frame(1 / 60);
		const now = fly.cameraAt();
		const d = Math.hypot(now[0] - last[0], now[1] - last[1]);
		const fade = fly.layer.FindFirstChild("Fade").BackgroundTransparency;
		if (d > 20) {
			// a cut: only ever behind the opaque page colour
			cuts++;
			if (fade > 0.05) snapsInView++;
			if (shotTime > 5) avgs.push(Math.hypot(last[0] - shotStart[0], last[1] - shotStart[1]) / shotTime);
			shotStart = now;
			shotTime = 0;
		} else {
			maxSpeed = Math.max(maxSpeed, d * 60);
			shotTime += 1 / 60;
		}
		last = now;
	}
	check(
		"a camera desliza a no maximo 60 u/s (com a entrada e a saida suaves)",
		maxSpeed <= 60,
		`${maxSpeed.toFixed(1)} u/s`,
	);
	check(
		"em media 25-60 u/s por plano",
		avgs.length > 0 && avgs.every(v => v >= 25 && v <= 60),
		avgs.map(v => v.toFixed(1)).join(", "),
	);
	check(
		"corta de plano e nunca pula no meio: todo corte acontece com a pagina opaca",
		cuts >= 2 && snapsInView === 0,
		`${cuts} cortes, ${snapsInView} a vista`,
	);
}

// the hour
fly.setDayTime(23);
frame();
const night = fly.layer.FindFirstChild("Night");
check(
	"noite: a tinta da noite do jogo, limitada para a cidade continuar um desenho atras dos menus",
	night.Visible && Math.abs(night.BackgroundTransparency - (1 - Math.min(darkAlphaAt(23, false, false), 0.6))) < 1e-9,
	`${night.BackgroundTransparency}`,
);
fly.setDayTime(12);
frame();
check("de dia, sem tinta", !night.Visible);
fly.setDayTime(undefined);
frame();
check("sem o relogio do servidor: um entardecer fixo", night.Visible && night.BackgroundTransparency > 0.6);

// the lobby detaches it and the Shop brings it back: the same pool
r = measure(() => {
	Fly.detachFlyover();
	fly = Fly.attachFlyover(host, DESIGN.TOWN_SEED, 1);
	frame();
});
check(
	"sair e voltar (a Loja e volta) reusa o mesmo voo: nenhuma Instance",
	zero(r) && Fly.activeFlyover() === fly,
	cost(r),
);

// Reduce Motion: a still frame
GuiService.ReducedMotionEnabled = true;
flush();
frame();
const still = fly.cameraAt();
r = measure(() => {
	for (let i = 0; i < 120; i++) frame(1 / 60);
});
check(
	"Reduzir Movimento: quadro parado -- a camera nao anda, nada e reescrito, sem esmaecer",
	still[0] === fly.cameraAt()[0] &&
		still[1] === fly.cameraAt()[1] &&
		r.writes === 0 &&
		zero(r) &&
		fly.layer.FindFirstChild("Fade").BackgroundTransparency === 1,
	`${cost(r)}`,
);
GuiService.ReducedMotionEnabled = false;
flush();

// a phone: lighter
const desktopSprites = fly.spriteCount();
Fly.releaseFlyover();
setScreen(844, 390, 36);
fly = Fly.attachFlyover(host, DESIGN.TOWN_SEED, 1);
frame();
{
	let t = 0;
	let startAt = fly.cameraAt();
	let last = startAt;
	let avg = 0;
	for (let i = 0; i < 60 * 120; i++) {
		frame(1 / 60);
		const now = fly.cameraAt();
		if (Math.hypot(now[0] - last[0], now[1] - last[1]) > 20) {
			avg = Math.hypot(last[0] - startAt[0], last[1] - startAt[1]) / t;
			break;
		}
		t += 1 / 60;
		last = now;
	}
	check(
		"celular: menos cidade por quadro e um pan mais lento",
		fly.spriteCount() < desktopSprites && avg > 0 && avg <= 30,
		`${fly.spriteCount()} contra ${desktopSprites} sprites, ${avg.toFixed(1)} u/s`,
	);
}

// a new town (MP-22): a new flyover, the old one gone
{
	const old = fly;
	const other = Fly.attachFlyover(host, 424242, 1);
	frame();
	check(
		"uma cidade nova (outra semente) troca o voo e solta o antigo",
		other !== old && old.layer.Parent === undefined && other.seed === 424242,
	);
	fly = other;
}

// the run starts
Fly.releaseFlyover();
flush();
check(
	"a partida comeca: o voo solta TODOS os seus Frames e para de desenhar",
	alive() === aliveHost &&
		RunService.RenderStepped.conns.length === runRenderBefore &&
		host.FindFirstChild("TownBackdrop") === undefined &&
		Fly.activeFlyover() === undefined,
	`${alive() - aliveHost} vivas, ${RunService.RenderStepped.conns.length - runRenderBefore} conexoes`,
);
check(
	"...e o renderer da partida nunca recebeu nada dele",
	worldLayer.GetDescendants().length === 1 && runRenderer.drawCount() === 0,
);
setScreen(1120, 630);

// ================================================================ 9. source guards

console.log("\n9) guardas de fonte (o que o Node nao roda)\n");
const read = rel => readFileSync(join(SRC, rel), "utf8");
const main = read("client/main.client.ts");
check(
	"main.client.ts: o fim de partida nao e mais um popup sobre o lobby",
	!/showGameOverChoice/.test(main) && !/popup\(ctx, tr\("Your run is over"\)/.test(main),
);
const startRun = main.slice(main.indexOf("function startRun"), main.indexOf("function playPressed"));
check(
	"...startRun: vida nova esperando -> enterToWait; senao a escolha na tela Survivor; partida em memoria -> resumeRun; senao newWorld",
	/enterToWait\(\)/.test(startRun) &&
		/goLobby\("survivor"\)/.test(startRun) &&
		/resumeRun\(\)/.test(startRun) &&
		/newWorld\(\)/.test(startRun),
);
check(
	"...o lobby chama os mesmos caminhos: playPressed, doRebirth, doNewRun",
	/onPlay: playPressed/.test(main) && /onRebirth: doRebirth/.test(main) && /onNewRun: doNewRun/.test(main),
);
check(
	"...e a partida solta o voo sobre a cidade ao montar",
	/function mountRun\([^)]*\): void \{\n(?:\t\/\/[^\n]*\n)*\tFlyover\.releaseFlyover\(\);/.test(main),
);
check(
	"...o Wait for daybreak do lobby entra morto na cidade pelo enterToWait de hoje, mantendo a vida (sem resetRun)",
	/onWaitDawn: \(\) => \{\s*if \(actionBusy \|\| !ctx\.save\.runOver\) return;\s*dawnChosen = true;\s*enterToWait\(\);\s*\}/.test(
		main,
	),
);
check(
	"...e a espera do amanhecer aceita essa escolha (openDeath), como aceita a vida nova",
	/serverRevives\(\) && \(loop\.getRefs\(\)\.daynight\.serverDriven\(\) \|\| newLifeWaiting \|\| dawnChosen\)/.test(
		main,
	),
);
const lobbySrc = read("client/ui/lobby.ts");
check(
	"lobby.ts: sem TIPS, sem ticker; shared/data/tips.ts nao existe mais",
	!/TIPS|shared\/data\/tips|Ticker/.test(lobbySrc) && !existsSync(join(SRC, "shared/data/tips.ts")),
);
check(
	'o "No" do tutorial passa por declineTutorial (desliga o coach) e so o How to play marca tutorialDone',
	/declineTutorial\(ctx\.save\)/.test(read("client/ui/survivor.ts")) &&
		!/tutorialDone = true/.test(read("client/ui/survivor.ts") + lobbySrc + main),
);
const host_ = read("server/net/mpHost.ts");
check(
	"o servidor publica os atributos que o lobby le (dia, hora e quem esta na cidade)",
	[WORLD_DAY_ATTR, DAY_TIME_ATTR, IN_WORLD_ATTR].every(a => host_.includes(`Workspace.SetAttribute("${a}"`)),
);
const loopSrc = read("client/gameLoop.ts");
check(
	"a partida e o voo desenham a cidade pelo MESMO codigo (client/view/worldView.ts)",
	/town\.drawGround\(/.test(loopSrc) &&
		/town\.drawSolids\(/.test(loopSrc) &&
		!/private drawBuilding/.test(loopSrc) &&
		/this\.town\.drawGround\(/.test(read("client/view/townFlyover.ts")),
);

console.log("");
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
}
console.log(
	"OK: lobby e tela Survivor como a UI-10 descreve, e a cidade atras deles sem criar Instance depois de aquecer",
);
