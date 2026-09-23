#!/usr/bin/env node
/*
 * Does the Bag create Instances when all it should do is switch a tab or update a number?
 *
 *   node tools/test-backpack.mjs
 *   PZ_SRC=<another checkout>/src node tools/test-backpack.mjs    (measures that version, e.g. the code before)
 *
 * The owner, in a playtest: "when I open the Bag and go through the tabs, Craft and so on, it takes a few ms to
 * load, and it should be instant". Creating GuiObjects is one of the most expensive things a Roblox client does
 * (Instance.new, every property, the reparent, a layout pass), and the Bag used to destroy its whole page and
 * build it again on every tab switch and after every action -- Craft alone is 80 rows.
 *
 * There is no Studio in CI, so this runs the REAL backpack.ts / widgets.ts / skin.ts / theme.ts / save.ts under
 * Node, over a small fake Instance tree, and counts what a profiler would blame: Instances created and destroyed
 * (plus the property writes on Instances that already existed, to show an update only touches what changed).
 *
 * The walk: open the Bag; every tab 5 times; into an item detail and back, twice; use an item (a count drops);
 * use the last one (a row goes away); craft (counts drop, a new item appears in another tab); learn a skill;
 * a change that arrives from OUTSIDE while the Bag is open (server reply, admin patch); close and reopen; a
 * change made while the Bag was closed; every tab once more.
 *
 * What it asserts:
 *  1. once a screen was mounted, going back to it creates and destroys ZERO Instances;
 *  2. an action creates at most what the new data needs (one row for an item the list never had);
 *  3. what is on screen always matches the save -- a cached page must never show old data.
 *
 * Pure Node (>= 18) plus the project's TypeScript, on the shared shims of tools/luau-shim.mjs. The fake tree
 * only models what the kit touches (parenting, Destroy, attributes, property / event signals, Visible); it has
 * no layout engine, so it counts WORK, it does not time it.
 */
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
Object.assign(globalThis, { Vector2, UDim, UDim2, Rect, TweenInfo, Font });

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
	if (my.counted) stats.log.push({ kind: "gone", inst, toast: my.toastAtDestroy });
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
function service(name) {
	let s = services.get(name);
	if (s !== undefined) return s;
	s = makeInstance(name, false);
	if (name === "GuiService") {
		Object.assign(s, {
			SelectedObject: undefined,
			GetGuiInset: () => [new Vector2(0, 0), new Vector2(0, 0)],
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
		cam.ViewportSize = new Vector2(1920, 1080);
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

// ---------------------------------------------------------------- the modules under test (the shared .ts loader)

const { Backpack } = require(join(SRC, "client/ui/backpack.ts"));
const { defaultSave } = require(join(SRC, "shared/game/save.ts"));
const { WEAPONS } = require(join(SRC, "shared/data/weapons.ts"));
const { EQUIPS } = require(join(SRC, "shared/data/equips.ts"));
const { USABLES } = require(join(SRC, "shared/data/usables.ts"));
const { ETC_ITEMS } = require(join(SRC, "shared/data/etcItems.ts"));
const { CRAFT_RECIPES } = require(join(SRC, "shared/data/crafts.ts"));
const { SKILLS } = require(join(SRC, "shared/data/skills.ts"));
flush();

// ---------------------------------------------------------------- the save and the game's callbacks

const MAT_START = 23;
const KIND = { Weapon: 1, Equip: 2, Use: 3, Etc: 4 };
const save = defaultSave();
// a survivor a few days in: some weapons, some equipment, food and medicine, a pile of materials, 2 points
for (let id = 1; id <= 8 && id < WEAPONS.length; id++) save.invenWeapon[id] = id % 3 === 0 ? 2 : 1;
for (let id = 0; id < 6 && id < EQUIPS.length; id++) save.invenEquip[id] = 1;
for (let id = 0; id < 8 && id < USABLES.length; id++) save.invenUse[id] = 3;
for (let id = MAT_START; id < MAT_START + 14 && id < ETC_ITEMS.length; id++) save.invenEtc[id] = 6;
save.skillPoint = 2;

// the recipe the walk crafts: hand-made, only materials, result not owned yet (so a new row must appear)
const countOf = (kind, index) =>
	kind === KIND.Weapon
		? (save.invenWeapon[index] ?? 0)
		: kind === KIND.Equip
			? (save.invenEquip[index] ?? 0)
			: kind === KIND.Use
				? (save.invenUse[index] ?? 0)
				: (save.invenEtc[index] ?? 0);
const inventoryOf = kind =>
	kind === KIND.Weapon
		? save.invenWeapon
		: kind === KIND.Equip
			? save.invenEquip
			: kind === KIND.Use
				? save.invenUse
				: save.invenEtc;
const RECIPE = CRAFT_RECIPES.find(
	r =>
		!r.needsDesk &&
		!r.needsPro &&
		r.needsFire !== true &&
		(r.resultKind === KIND.Use || r.resultKind === KIND.Weapon) &&
		countOf(r.resultKind, r.resultIndex) === 0 &&
		r.ingredients.every(i => i.kind === KIND.Etc),
);
if (RECIPE === undefined) throw new Error("no hand recipe with a new result to craft");
for (const ing of RECIPE.ingredients) save.invenEtc[ing.index] = ing.count;

const ctx = { phase: "playing", save, uiLayer: undefined };
{
	const gui = makeInstance("ScreenGui", false);
	const layer = makeInstance("Frame", false);
	layer.Name = "Ui";
	layer.Parent = gui;
	ctx.uiLayer = layer;
	ctx.screen = gui;
}

const pack = new Backpack(ctx);
pack.nearbyDesk = true;
pack.nearbyPro = true;
pack.nearbyFire = true;
pack.craftCheck = () => undefined;
// what main.client does (without the world): the backpack only asks, the game changes the save
pack.onEquipWeapon = id => {
	save.equipWeapon = id;
};
pack.onEquipItem = id => {
	const slot = EQUIPS[id].kind;
	if (slot === 1) save.equipCloth = id;
	else if (slot === 2) save.equipHand = id;
	else if (slot === 3) save.equipGun = id;
	else save.equipDeco = id;
};
pack.onUnequipItem = slot => {
	if (slot === 1) save.equipCloth = -1;
	else if (slot === 2) save.equipHand = -1;
	else if (slot === 3) save.equipGun = -1;
	else save.equipDeco = -1;
};
pack.onUse = id => {
	if ((save.invenUse[id] ?? 0) > 0) save.invenUse[id] -= 1;
};
pack.onCraft = id => {
	const r = CRAFT_RECIPES.find(x => x.id === id);
	for (const ing of r.ingredients) inventoryOf(ing.kind)[ing.index] -= ing.count;
	inventoryOf(r.resultKind)[r.resultIndex] = (inventoryOf(r.resultKind)[r.resultIndex] ?? 0) + r.resultCount;
};

// ---------------------------------------------------------------- driving the UI like a player

const bag = () => ctx.uiLayer.FindFirstChild("Backpack");
function visible(inst, out = []) {
	for (const c of inst.GetChildren()) {
		if (c.IsA("GuiObject") && !c.Visible) continue;
		out.push(c);
		visible(c, out);
	}
	return out;
}
function find(root, name, cls) {
	if (root === undefined) return undefined;
	return visible(root).find(d => d.Name === name && (cls === undefined || d.ClassName === cls));
}
const content = () => find(bag(), "Content");
function click(button, what) {
	if (button === undefined) throw new Error(`button not found: ${what}`);
	button.Activated.Fire();
	flush();
}
const TABS = ["Weapons", "Equipment", "Usables", "Materials", "Craft", "Skills"];
function tab(i) {
	click(find(bag(), "Categories")?.FindFirstChild(`Item${i}`), `tab ${TABS[i]}`);
}
function rows() {
	const list = find(content(), "List", "ScrollingFrame");
	if (list === undefined) return [];
	return list
		.GetChildren()
		.filter(c => c.IsA("GuiObject") && c.Visible)
		.sort((a, b) => a.LayoutOrder - b.LayoutOrder);
}
const text = (root, name) => find(root, name)?.Text;
const rowNamed = name => rows().find(r => text(r, "Name") === name);
const back = () => click(find(bag(), "Nav", "TextButton"), "back");
const act = () => click(find(content(), "Action", "TextButton"), "detail action");
const heartbeat = dt => {
	service("RunService").Heartbeat.Fire(dt);
	flush();
};

// ---------------------------------------------------------------- measuring

let failures = 0;
function check(name, ok, detail) {
	const tail = detail === undefined ? "" : `  (${detail})`;
	if (ok) console.log(`  ok    ${name}${tail}`);
	else {
		console.error(`  FALHA ${name}${tail}`);
		failures++;
	}
}

const table = [];
/** runs one step of the walk and returns what it cost */
function phase(label, fn) {
	const from = stats.log.length;
	stats.phaseSeq = stats.seq;
	stats.writes = 0;
	const tweensBefore = tweens;
	fn();
	flush();
	const r = { label, bagNew: 0, bagGone: 0, toastNew: 0, writes: stats.writes, tweens: tweens - tweensBefore };
	for (const e of stats.log.slice(from)) {
		const my = e.inst[INTERNAL];
		const toast = e.kind === "gone" ? e.toast : my.destroyed ? my.toastAtDestroy : underToast(e.inst);
		if (toast) {
			if (e.kind === "new") r.toastNew++;
		} else if (e.kind === "new") r.bagNew++;
		else r.bagGone++;
	}
	table.push(r);
	return r;
}
const zero = r => r.bagNew === 0 && r.bagGone === 0;
const cost = r => `${r.bagNew} criadas, ${r.bagGone} destruidas`;

// ---------------------------------------------------------------- the walk

console.log(`Bag: fonte ${SRC}\n`);
console.log("1) abrir e percorrer as abas\n");

phase("abrir o Bag (1a vez)", () => pack.open());
check("o Bag abriu na aba Weapons", rows().length > 0 && text(rows()[0], "Name") !== undefined);

const firstVisit = [1, 2, 3, 4, 5, 0].map(i => phase(`1a visita: ${TABS[i]}`, () => tab(i)));
const usableRow = (() => {
	tab(2);
	return rows()[0];
})();
const ROW_COST = usableRow.GetDescendants().length + 1;
console.log(`  (uma linha de item custa ${ROW_COST} Instances)`);
tab(0);

for (let round = 2; round <= 5; round++) {
	const r = phase(`volta ${round}: 6 trocas de aba`, () => {
		for (const i of [1, 2, 3, 4, 5, 0]) tab(i);
	});
	check(`volta ${round} pelas 6 abas nao cria nem destroi Instance`, zero(r), cost(r));
}

console.log("\n2) detalhe de item\n");
tab(0);
const weaponNames = rows().map(r => text(r, "Name"));
phase("entra no detalhe (1a vez)", () => click(rows()[0], "weapon row"));
check("o detalhe mostra a arma clicada", text(content(), "Name") === weaponNames[0], text(content(), "Name"));
let r = phase("volta para a lista", back);
check("voltar do detalhe nao cria nem destroi Instance", zero(r), cost(r));
r = phase("entra em outro detalhe", () => click(rows()[1], "weapon row 2"));
check("outro detalhe reusa a pagina", zero(r), cost(r));
check("e mostra a outra arma", text(content(), "Name") === weaponNames[1], text(content(), "Name"));
r = phase("volta de novo", back);
check("voltar de novo nao cria nem destroi Instance", zero(r), cost(r));
r = phase("equipa uma arma (detalhe)", () => {
	click(rowNamed(weaponNames[2]), "weapon row 3");
	act();
});
check("equipar atualiza no lugar", zero(r), cost(r));
check("a pagina diz Equipped", find(content(), "Action", "TextButton")?.Text === "Equipped");
back();
check("a lista marca a arma equipada", find(rowNamed(weaponNames[2]), "Equipped") !== undefined);

console.log("\n3) usar item (uma contagem muda) e usar o ultimo (uma linha sai)\n");
tab(2);
const useA = USABLES[0].name;
const useB = USABLES[1].name;
click(rowNamed(useA), useA);
r = phase(`Use ${useA} (3 -> 2)`, act);
check("usar nao cria nem destroi Instance", zero(r), cost(r));
check("o detalhe mostra a contagem nova", text(content(), "Owned") === "Owned x 2", text(content(), "Owned"));
r = phase("volta para Usables", back);
check("voltar nao cria nem destroi Instance", zero(r), cost(r));
check("a linha mostra x 2", text(rowNamed(useA), "Count") === "x 2", text(rowNamed(useA), "Count"));
save.invenUse[USABLES[1].id] = 1;
const before = rows().length;
click(rowNamed(useB), useB);
r = phase(`Use o ultimo ${useB} (1 -> 0) e volta`, () => {
	act();
	back();
});
check("usar o ultimo nao cria nem destroi Instance", zero(r), cost(r));
check(
	"a linha do item acabado sumiu",
	rowNamed(useB) === undefined && rows().length === before - 1,
	`${before} -> ${rows().length} linhas`,
);

console.log("\n4) craft\n");
const resultName = (() => {
	const pool = RECIPE.resultKind === KIND.Weapon ? WEAPONS : USABLES;
	return pool[RECIPE.resultIndex].name;
})();
const recipeRowName = RECIPE.resultCount > 1 ? `${resultName} x${RECIPE.resultCount}` : resultName;
tab(4);
phase(`abre a receita ${recipeRowName} (1a vez)`, () => click(rowNamed(recipeRowName), recipeRowName));
r = phase("Craft", act);
check("craftar atualiza a receita no lugar", zero(r), cost(r));
const ing0 = RECIPE.ingredients[0];
check(
	"a receita mostra os ingredientes gastos",
	text(find(content(), "Ing0"), "Count") === `0 / ${ing0.count}`,
	text(find(content(), "Ing0"), "Count"),
);
r = phase("volta para Craft (lista reordena)", back);
check("voltar para Craft nao cria nem destroi Instance", zero(r), cost(r));
check(
	"a receita craftada agora falta material",
	text(rowNamed(recipeRowName), "Status") === "Missing",
	text(rowNamed(recipeRowName), "Status"),
);
const resultTab = RECIPE.resultKind === KIND.Weapon ? 0 : 2;
r = phase(`aba ${TABS[resultTab]} com o item novo`, () => tab(resultTab));
check(
	"o item novo cria no maximo uma linha",
	r.bagNew <= ROW_COST && r.bagGone === 0,
	`${cost(r)}; uma linha = ${ROW_COST}`,
);
check("e a linha dele esta la", rowNamed(resultName) !== undefined);

console.log("\n5) skills\n");
tab(5);
const skill = SKILLS.find(s => s.maxLevel > 1);
const skillRow = () => rows().find(x => text(x, "Name") === skill.name);
r = phase(`aprende ${skill.name}`, () => click(find(skillRow(), "Plus", "TextButton"), "plus"));
check("aprender skill atualiza no lugar", zero(r), cost(r));
check(
	"a linha mostra o nivel novo",
	text(skillRow(), "Level") === `Lv 1 / ${skill.maxLevel}`,
	text(skillRow(), "Level"),
);
check(
	"o aviso mostra os pontos que sobraram",
	(text(content(), "Text") ?? "").startsWith("1 skill point "),
	text(content(), "Text"),
);

console.log("\n6) dado que muda por fora com o Bag aberto (resposta do servidor, admin)\n");
tab(3);
const mat = ETC_ITEMS[MAT_START + 13];
save.invenEtc[mat.id] += 5;
r = phase("mudanca de fora + 0,5 s de quadros", () => {
	for (let i = 0; i < 30; i++) heartbeat(1 / 60);
});
check("a atualizacao por fora nao cria nem destroi Instance", zero(r), cost(r));
check(
	"a linha mostra a contagem nova",
	text(rowNamed(mat.name), "Count") === "x 11",
	text(rowNamed(mat.name), "Count"),
);

console.log("\n7) fechar e reabrir\n");
r = phase("fecha e reabre 3 vezes", () => {
	for (let i = 0; i < 3; i++) {
		pack.close();
		pack.open();
	}
});
check("reabrir nao cria nem destroi Instance", zero(r), cost(r));
check("reabre na ultima aba", find(bag(), "Categories") !== undefined && rowNamed(mat.name) !== undefined);
// a pad user had a row selected: a hidden Bag must not keep it (bootstrap reads a selection as "a menu has the pad")
service("GuiService").SelectedObject = rows()[0];
pack.close();
check("fechar tira a selecao do gamepad de dentro do Bag", service("GuiService").SelectedObject === undefined);
const fresh = USABLES[9];
save.invenUse[fresh.id] = 4;
save.invenUse[USABLES[0].id] = 0;
r = phase("mudanca com o Bag fechado, reabre e vai a Usables", () => {
	pack.open();
	tab(2);
});
check(
	"o item ganho aparece, o gasto sai",
	rowNamed(fresh.name) !== undefined && rowNamed(USABLES[0].name) === undefined,
);
check("e custa no maximo uma linha", r.bagNew <= ROW_COST && r.bagGone === 0, `${cost(r)}; uma linha = ${ROW_COST}`);

console.log("\n8) todas as abas mais uma vez\n");
r = phase("volta final pelas 6 abas", () => {
	for (const i of [0, 1, 2, 3, 4, 5]) tab(i);
});
check("depois de tudo, trocar de aba segue sem criar nem destruir", zero(r), cost(r));
const alive = bag() === undefined ? 0 : bag().GetDescendants().length + 1;

// ---------------------------------------------------------------- report

console.log("\nPasso                                              criadas  destruidas  escritas  (toast)");
for (const x of table) {
	console.log(
		`${x.label.padEnd(50)} ${String(x.bagNew).padStart(7)} ${String(x.bagGone).padStart(11)} ${String(x.writes).padStart(9)}  ${x.toastNew > 0 ? `(${x.toastNew})` : ""}`,
	);
}
const sum = (list, k) => list.reduce((s, x) => s + x[k], 0);
console.log(`\nprimeira visita das abas: ${sum(firstVisit, "bagNew")} criadas`);
console.log(`Instances vivas no Bag no fim: ${alive}`);
console.log(`(escritas = propriedades escritas em Instances que ja existiam; toast = popup de aviso, fora do Bag)`);

console.log("");
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
}
console.log("OK: depois de montada, cada tela do Bag troca e atualiza sem criar nem destruir Instance");
