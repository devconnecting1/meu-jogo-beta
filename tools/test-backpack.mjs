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
 * change made while the Bag was closed; every tab once more; then the item card (DESIGN_RULES UI-08): the pointer
 * over a whole list and the pad's selection down it (one card, rewritten in place: zero Instances), its colours and
 * device hints, no tooltip on touch, and the item page showing the same card.
 *
 * What it asserts:
 *  1. once a screen was mounted, going back to it creates and destroys ZERO Instances;
 *  2. an action creates at most what the new data needs (one row for an item the list never had);
 *  3. what is on screen always matches the save -- a cached page must never show old data.
 *
 * Then (part 9) the WARDROBE (client/ui/wardrobe.ts, DESIGN_RULES MON-04 / UI-07) on the same kit and fake tree:
 * only the tabs that exist, the tile states (dark = yours, iron = worn, padlock + price = locked, blue = selected),
 * the details panel and its one action, the try-on preview, the purchase request carrying the costume id and NO
 * price (answered by the server's own rule, server/save/costumes.ts), and selecting, buying, wearing and switching
 * tabs without creating or destroying an Instance.
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
const { defaultSave, equipSlotOf, setEquipped } = require(join(SRC, "shared/game/save.ts"));
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
	setEquipped(save, equipSlotOf(id), id);
};
pack.onUnequipItem = slot => {
	setEquipped(save, slot, -1);
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
		// PZ_DEBUG=1: name what a step created or destroyed, with the path it hangs from
		if (process.env.PZ_DEBUG && !toast) {
			const path = [];
			for (let i = e.inst; i !== undefined && path.length < 8; i = i.Parent)
				path.unshift(`${i.Name}:${i.ClassName}`);
			console.log(`        [${label}] ${e.kind} ${path.join(" / ")}`);
		}
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

console.log("\n9) cartao do item (UI-08): segue o ponteiro e a selecao do controle, e e o mesmo da pagina do item\n");
const { STAT, GAME } = require(join(SRC, "client/ui/theme.ts"));
const uis = service("UserInputService");
const gui = service("GuiService");
const tip = () => find(content(), "Tooltip");
/** the row's GuiState, as the engine sets it when the pointer enters / leaves it */
const pointer = (row, on) => {
	row.GuiState = on ? Enum.GuiState.Hover : Enum.GuiState.Idle;
	flush();
};
/** the value label of the stat line labelled `label` inside `root` */
const statValue = (root, label) =>
	root === undefined
		? undefined
		: visible(root)
				.find(d => d.Name === "Label" && d.Text === label)
				?.Parent?.FindFirstChild("Value");
const legends = root =>
	root === undefined
		? []
		: visible(root)
				.filter(d => d.Name === "Legend")
				.map(d => d.Text);
const sameColor = (a, b) => a !== undefined && b !== undefined && a.R === b.R && a.G === b.G && a.B === b.B;

tab(0);
const listed = rows();
phase("ponteiro na 1a arma (1a vez: monta o cartao)", () => pointer(listed[0], true));
check(
	"o cartao aparece com a arma da linha",
	text(tip(), "Name") === text(listed[0], "Name"),
	`${text(tip(), "Name")} / ${text(listed[0], "Name")}`,
);
const firstWeapon = WEAPONS.find(w => w.name === text(listed[0], "Name"));
check(
	"o dano vem da tabela, em amarelo (STAT.value)",
	statValue(tip(), "Damage")?.Text === String(firstWeapon.dmg) &&
		sameColor(statValue(tip(), "Damage")?.TextColor3, STAT.value),
	statValue(tip(), "Damage")?.Text,
);
check(
	"a dica fala o teclado e o mouse (tutorial.ts SCHEMES)",
	legends(tip()).includes("Left click"),
	legends(tip()).join(", "),
);
check(
	"o cartao nao oferece botao nenhum (sem trocar / presentear)",
	visible(tip()).every(d => !d.IsA("GuiButton")),
);
r = phase(`ponteiro percorre as ${listed.length} armas`, () => {
	for (let i = 1; i < listed.length; i++) {
		pointer(listed[i - 1], false);
		pointer(listed[i], true);
	}
});
check("percorrer a lista com o cartao nao cria nem destroi Instance", zero(r), cost(r));
check(
	"o cartao mostra a ultima arma apontada",
	text(tip(), "Name") === text(listed[listed.length - 1], "Name"),
	text(tip(), "Name"),
);
const equippedRow = rowNamed(weaponNames[2]);
pointer(listed[listed.length - 1], false);
pointer(equippedRow, true);
check(
	'a linha coberta pelo cartao tem o "EQUIPPED" repetido no cabecalho dele',
	text(tip(), "Tag") === "EQUIPPED" && sameColor(find(tip(), "Tag")?.TextColor3, GAME.success),
	text(tip(), "Tag"),
);
pointer(equippedRow, false);
check("sem ponteiro nem selecao, o cartao some", tip() === undefined);

uis.GetLastInputType = () => Enum.UserInputType.Gamepad1;
r = phase("selecao do controle anda pela lista", () => {
	for (const row of listed) {
		gui.SelectedObject = row;
		flush();
	}
});
check("a selecao do controle mostra o cartao sem criar Instance", tip() !== undefined && zero(r), cost(r));
check("com o controle, a dica fala o controle", legends(tip()).includes("RT / RB / A"), legends(tip()).join(", "));
gui.SelectedObject = undefined;
flush();
check("tirar a selecao esconde o cartao", tip() === undefined);

uis.GetLastInputType = () => Enum.UserInputType.Touch;
uis.TouchEnabled = true;
uis.MouseEnabled = false;
pointer(listed[0], true);
check("no toque nao ha tooltip (o toque abre a pagina do item, que tem o cartao)", tip() === undefined);
pointer(listed[0], false);
uis.GetLastInputType = () => Enum.UserInputType.MouseMovement;
uis.TouchEnabled = false;
uis.MouseEnabled = true;

tab(2);
const food = rows()[0];
pointer(food, true);
const foodDef = USABLES.find(u => u.name === text(food, "Name"));
check(
	`${foodDef.name}: o que enche a fome vem em verde (STAT.bonus)`,
	foodDef.hunger > 0 && sameColor(statValue(tip(), "Hunger recovery")?.TextColor3, STAT.bonus),
	statValue(tip(), "Hunger recovery")?.Text,
);
r = phase("clica na linha apontada: a pagina do item", () => click(food, foodDef.name));
check("abrir a pagina esconde o tooltip", tip() === undefined);
check("a pagina mostra o cartao do mesmo item", text(content(), "Name") === foodDef.name, text(content(), "Name"));
check(
	"e a dica da pagina comeca pela acao dela (Click: Use)",
	legends(find(content(), "Card"))[0] === "Click",
	legends(find(content(), "Card")).join(", "),
);
back();
pointer(food, false);
const alive = bag() === undefined ? 0 : bag().GetDescendants().length + 1;

// ---------------------------------------------------------------- 9. the wardrobe (MON-04), on the same kit

console.log("\n9) o guarda-roupa (MON-04): abas, ladrilhos, a previa e a acao unica\n");
pack.close();
{
	const saveClient = require(join(SRC, "client/systems/saveClient.ts"));
	const { showWardrobe } = require(join(SRC, "client/ui/wardrobe.ts"));
	const { buyCostume } = require(join(SRC, "server/save/costumes.ts"));
	const { COSTUMES } = require(join(SRC, "shared/data/shop.ts"));
	const { THEME, SURFACE } = require(join(SRC, "client/ui/theme.ts"));
	const { Z } = require(join(SRC, "shared/engine/colors.ts"));
	const { PET_Z } = require(join(SRC, "client/view/cosmeticsView.ts"));
	const { SurvivorPreview } = require(join(SRC, "client/view/cosmeticPreview.ts"));
	const COS = require(join(SRC, "shared/data/cosmetics.ts"));
	const { ownsEquip } = require(join(SRC, "shared/game/save.ts"));

	const costume = name => COSTUMES.find(c => c.name === name);
	const [SANTA, ZOMBIE, COWBOY, CAROLINA] = ["Santa", "Zombie", "Cowboy", "Carolina"].map(costume);
	// a survivor with 40 coins, the Cowboy bought and worn, and the Carolina of a pack (in the inventory only)
	for (const c of COSTUMES) {
		save.costumes[c.id] = 0;
		save.invenEquip[c.equipId] = 0;
	}
	save.money = 40;
	save.costumes[COWBOY.id] = 1;
	save.equipOutfit = COWBOY.equipId;
	save.invenEquip[CAROLINA.equipId] = 1;
	save.equipPet = -1;

	// the server, as the wardrobe reaches it: the one remote call, recorded, answered by the server's own rule
	const asked = [];
	saveClient.sessionReady = () => true;
	saveClient.invokeShopAction = request => {
		asked.push(JSON.parse(JSON.stringify(request)));
		const r = buyCostume(save, request.costumeId);
		return r.ok ? { ok: true, price: r.price } : { ok: false, reason: r.reason };
	};
	// main.client's equip path (the same as the Bag's): owned, into its slot
	let closedBy = "";
	const close = showWardrobe(ctx, {
		onBack: () => {
			closedBy = "X";
		},
		onEquip: id => {
			if (ownsEquip(save, id)) setEquipped(save, equipSlotOf(id), id);
		},
		onUnequip: slot => {
			setEquipped(save, slot, -1);
		},
	});
	flush();
	const screen = () => ctx.uiLayer.FindFirstChild("Wardrobe");
	/** first descendant with that name (hidden or not) */
	const deep = (root, name) => root?.GetDescendants().find(d => d.Name === name);
	const page = i => deep(screen(), `Page${i}`);
	const tile = (i, j) => deep(page(i), `Tile${j}`);
	const face = t => t.FindFirstChild("PlateFace")?.BackgroundColor3;
	const locked = t => t.FindFirstChild("Lock")?.Visible === true;
	const details = () => deep(screen(), "Details");
	const action = () => deep(details(), "Action");
	const legend = root => deep(root, "Legend")?.Text;
	const status = () => legend(deep(details(), "Status"));
	const statusLabel = () => deep(deep(details(), "Status"), "Label")?.Text;
	const noteText = () => deep(deep(details(), "Note"), "Text")?.Text ?? "";
	const title = () => details()?.FindFirstChild("Title")?.Text;
	const renderFrame = () => {
		service("RunService").RenderStepped.Fire(1 / 60);
		flush();
	};
	/** the preview's sprites (only the visible ones: the renderer hides what it pooled) */
	const previewSprites = () =>
		deep(deep(details(), "PreviewBed"), "Sprites")
			.GetChildren()
			.filter(f => f.Visible);
	const torso = sprites =>
		sprites
			.filter(f => f.ZIndex === Z.player + 1)
			.sort((a, b) => b.Size.X.Offset * b.Size.Y.Offset - a.Size.X.Offset * a.Size.Y.Offset)[0]?.BackgroundColor3;
	/** the torso colour the world's own drawing gives an outfit look (a detached preview, the same code) */
	const torsoOf = look => {
		const ref = new SurvivorPreview(makeInstance("Frame", false), { w: 300, h: 200 });
		ref.setOutfit(look);
		ref.draw(0);
		const c = torso(
			ref.frame
				.FindFirstChild("Sprites")
				.GetChildren()
				.filter(f => f.Visible),
		);
		ref.destroy();
		return c;
	};
	const sameColor = (a, b) =>
		a !== undefined && b !== undefined && Math.abs(a.R - b.R) + Math.abs(a.G - b.G) + Math.abs(a.B - b.B) < 1e-6;
	const petShown = () => previewSprites().some(f => f.ZIndex >= PET_Z && f.ZIndex <= PET_Z + 3);

	check("o guarda-roupa abriu", screen() !== undefined);
	const tabs = deep(screen(), "Tabs")
		.GetChildren()
		.filter(c => c.ClassName === "TextButton")
		.map(b => b.Text);
	check(
		"so as abas do que existe: Outfits, Pets e os titulos (MON-05)",
		JSON.stringify(tabs) === '["Outfits","Pets","Titles"]',
		JSON.stringify(tabs),
	);
	const tilesOf = i =>
		page(i)
			.GetDescendants()
			.filter(d => /^Tile\d+$/.test(d.Name)).length;
	check("3 trajes e 6 pets", tilesOf(0) === 3 && tilesOf(1) === 6, `${tilesOf(0)} / ${tilesOf(1)}`);
	check("abre em Outfits", page(0).Visible && !page(1).Visible);
	check(
		"sem campo de busca",
		screen()
			.GetDescendants()
			.every(d => d.ClassName !== "TextBox"),
	);

	// the tiles: the Cowboy is worn (and selected, since it is what you wear); Santa and Zombie are locked
	const santaTile = tile(0, 0);
	const cowboyTile = tile(0, 2);
	check("o traje vestido abre selecionado (azul em relevo)", sameColor(face(cowboyTile), THEME.tabActive));
	check(
		"Santa bloqueado: cadeado e preco em moedas",
		locked(santaTile) && deep(santaTile, "Price").Visible && deep(santaTile, "Amount").Text === String(SANTA.price),
		deep(santaTile, "Amount")?.Text,
	);
	check("liso escuro para o que esta bloqueado e nao selecionado", sameColor(face(santaTile), SURFACE.section));
	check("contagem na secao: 1 / 3", legend(deep(page(0), "Count")) === "1 / 3", legend(deep(page(0), "Count")));
	check(
		"painel: nome, slot, estado e a acao",
		title() === "Cowboy" &&
			legend(deep(details(), "Slot")) === "OUTFIT" &&
			status() === "Equipped" &&
			action().Text === "Unequip",
		`${title()} / ${legend(deep(details(), "Slot"))} / ${status()} / ${action().Text}`,
	);
	renderFrame();
	check("a previa veste o Cowboy", sameColor(torso(previewSprites()), torsoOf(COS.OutfitLook.Cowboy)));
	check("e sem pet (nenhum vestido)", !petShown());

	// select Santa: a repaint, not a rebuild
	let r = phase("guarda-roupa: seleciona o Santa", () => click(santaTile, "Santa"));
	check("selecionar um ladrilho nao cria nem destroi Instance", zero(r), cost(r));
	check(
		"Santa selecionado: azul, e ainda com o cadeado",
		sameColor(face(santaTile), THEME.tabActive) && locked(santaTile),
	);
	check("o Cowboy volta a ferro (em uso)", sameColor(face(cowboyTile), THEME.secondary));
	check(
		"painel: preco em moedas e Buy for 30 coins",
		statusLabel() === "Price" &&
			status() === `${SANTA.price} coins` &&
			action().Text === `Buy for ${SANTA.price} coins`,
		`${statusLabel()}: ${status()} / ${action().Text}`,
	);
	check("com moedas para pagar, a acao e a principal (verde)", action().GetAttribute("Variant") === "default");
	renderFrame();
	check("a previa experimenta o Santa", sameColor(torso(previewSprites()), torsoOf(COS.OutfitLook.Santa)));

	// buy it: the request is the id and nothing else, the answer is the server's
	r = phase("guarda-roupa: compra o Santa", () => click(action(), "Buy"));
	check(
		"o pedido e so { kind, costumeId }: nenhum preco sai do cliente",
		asked.length === 1 && JSON.stringify(asked[0]) === JSON.stringify({ kind: "buyCostume", costumeId: SANTA.id }),
		JSON.stringify(asked),
	);
	check("comprar atualiza no lugar", zero(r), cost(r));
	check(
		"as moedas e a posse vem do servidor",
		save.money === 40 - SANTA.price && save.costumes[SANTA.id] === 1,
		`${save.money}`,
	);
	check("o ladrilho perde o cadeado", !locked(santaTile));
	check(
		"o painel diz Owned e oferece Equip",
		status() === "Owned" && action().Text === "Equip",
		`${status()} / ${action().Text}`,
	);
	check("contagem: 2 / 3", legend(deep(page(0), "Count")) === "2 / 3");

	r = phase("guarda-roupa: veste o Santa", () => click(action(), "Equip"));
	check("vestir atualiza no lugar", zero(r), cost(r));
	check("o Santa esta vestido (o mesmo caminho do Bag)", save.equipOutfit === SANTA.equipId);
	check("o Cowboy volta a ser so seu (liso escuro)", sameColor(face(cowboyTile), SURFACE.section));
	check(
		"o painel oferece Unequip, em ferro",
		action().Text === "Unequip" && action().GetAttribute("Variant") === "secondary",
	);
	click(action(), "Unequip");
	check("tirar deixa o slot vazio", save.equipOutfit === -1 && action().Text === "Equip");

	// too few coins: the button stays pressable, the server says no, nothing moves
	click(tile(0, 1), "Zombie");
	check("sem moedas: a acao fica discreta (outline)", action().GetAttribute("Variant") === "outline");
	check(
		"e a nota diz quantas moedas voce tem",
		noteText().startsWith("Not enough coins") && noteText().includes(`${save.money}`),
		noteText(),
	);
	click(action(), "Buy Zombie");
	check(
		"o servidor recusa por falta de moedas",
		asked.length === 2 && save.costumes[ZOMBIE.id] === 0 && save.money === 40 - SANTA.price,
	);

	// the Pets page
	r = phase("guarda-roupa: aba Pets", () => click(deep(screen(), "Tabs").FindFirstChild("Tab1"), "Pets"));
	check("trocar de aba nao cria nem destroi Instance", zero(r), cost(r));
	check("Pets aparece, Outfits some", page(1).Visible && !page(0).Visible);
	check(
		"sem pet vestido, abre no primeiro (Pigeon)",
		title() === "Pigeon" && legend(deep(details(), "Slot")) === "PET",
		title(),
	);
	click(tile(1, 3), "Carolina");
	const packAction = () => deep(details(), "PackAction");
	const keep = () => deep(details(), "Keep");
	check(
		"a Carolina de um pacote e sua, mas diz de onde veio",
		status() === "From a pack" && packAction().Visible && packAction().Text === "Equip" && !action().Visible,
		status(),
	);
	// the review of the wardrobe: the old shop always offered the permanent Buy, and the wardrobe replaced it
	check(
		"e a permanente continua a venda ao lado (vestir | comprar)",
		keep().Visible && keep().Text.startsWith("Buy for") && keep().Text.endsWith("coins"),
		keep()?.Text,
	);
	check("e que dura ate o proximo New game", noteText().startsWith("Came in a pack"), noteText());
	click(packAction(), "Equip Carolina");
	check("a Carolina vai para o slot do pet", save.equipPet === CAROLINA.equipId && status() === "Equipped");
	renderFrame();
	check("a previa mostra o pet", petShown());
	check("com o traje que voce veste (nenhum)", sameColor(torso(previewSprites()), torsoOf(COS.OutfitLook.None)));
	const askedBefore = asked.length;
	click(keep(), "Buy Carolina for good");
	check(
		"comprar a do pacote pede so o id, como qualquer compra",
		asked.length === askedBefore + 1 &&
			JSON.stringify(asked[askedBefore]) === JSON.stringify({ kind: "buyCostume", costumeId: CAROLINA.id }),
		JSON.stringify(asked.slice(askedBefore)),
	);
	click(tile(1, 0), "Pigeon");
	check(
		"um pet que nao veio de pacote volta ao botao unico",
		action().Visible && !keep().Visible && !packAction().Visible,
	);

	r = phase("guarda-roupa: 4 trocas de aba", () => {
		for (const i of [0, 1, 0, 1]) click(deep(screen(), "Tabs").FindFirstChild(`Tab${i}`), `tab ${i}`);
	});
	check("ir e voltar entre as abas segue sem criar nem destruir", zero(r), cost(r));

	// the red X, and closing
	click(deep(screen(), "Close"), "X");
	check("o X vermelho volta para quem abriu", closedBy === "X");
	const drawing = service("RunService").RenderStepped.conns.length;
	close();
	check("fechar remove a tela", screen() === undefined);
	check(
		"e a previa para de desenhar (a conexao de quadro e desligada)",
		service("RunService").RenderStepped.conns.length === drawing - 1,
		`${drawing} -> ${service("RunService").RenderStepped.conns.length}`,
	);
	check(
		"as cores de torso comparadas acima sao mesmo diferentes entre si",
		!sameColor(torsoOf(COS.OutfitLook.Cowboy), torsoOf(COS.OutfitLook.Santa)) &&
			!sameColor(torsoOf(COS.OutfitLook.None), torsoOf(COS.OutfitLook.Cowboy)),
	);
}

// ---------------------------------------------------------------- 10. the titles (MON-05), on the same kit

console.log("\n10) os titulos (MON-05): linhas, cadeado, o selecionado, a previa da placa e a acao unica\n");
{
	const saveClient = require(join(SRC, "client/systems/saveClient.ts"));
	const { showWardrobe } = require(join(SRC, "client/ui/wardrobe.ts"));
	const { buyCostume } = require(join(SRC, "server/save/costumes.ts"));
	const { equipTitle } = require(join(SRC, "server/save/titles.ts"));
	const { THEME, SURFACE, STAT } = require(join(SRC, "client/ui/theme.ts"));
	const TIT = require(join(SRC, "shared/data/titles.ts"));
	const { Nameplate, TITLE_TEXT } = require(join(SRC, "client/ui/nameplate.ts"));

	// a survivor who earned Survivor and shows it; 37 zombies put down; this life is at day 3
	for (let i = 0; i < save.titles.length; i++) save.titles[i] = 0;
	save.titles[TIT.TitleId.Survivor] = 1;
	save.equipTitle = TIT.TitleId.Survivor;
	save.zombieKills = 37;
	save.day = 3;
	const asked = [];
	saveClient.sessionReady = () => true;
	saveClient.requestSave = () => true;
	saveClient.invokeShopAction = request => {
		asked.push(JSON.parse(JSON.stringify(request)));
		// the server's own rules, on the same save the client mirrors
		const r =
			request.kind === "equipTitle" ? equipTitle(save, request.titleId) : buyCostume(save, request.costumeId);
		return r.ok ? { ok: true, price: 0 } : { ok: false, reason: r.reason };
	};
	const close = showWardrobe(ctx, { onBack: () => {}, onEquip: () => {}, onUnequip: () => {} });
	flush();
	const screen = () => ctx.uiLayer.FindFirstChild("Wardrobe");
	const deep = (root, name) => root?.GetDescendants().find(d => d.Name === name);
	const titlesPage = () => deep(screen(), "Page2");
	const row = j => deep(titlesPage(), `Row${j}`);
	const rowText = (j, name) => deep(row(j), name)?.Text;
	const rowColor = (j, name) => deep(row(j), name)?.TextColor3;
	const face = r => r.FindFirstChild("PlateFace")?.BackgroundColor3;
	const locked = r => r.FindFirstChild("Lock")?.Visible === true;
	const worn = j => deep(row(j), "Worn")?.Visible === true;
	/** the blue ring of the selected row: the plate's "outline" state in the tab-active blue */
	const ringed = r => {
		const band = r.FindFirstChild("PlateBand");
		return (
			band?.Visible === true &&
			band.BackgroundTransparency === 0 &&
			sameColor(band.BackgroundColor3, THEME.tabActive)
		);
	};
	const sameColor = (a, b) =>
		a !== undefined && b !== undefined && Math.abs(a.R - b.R) + Math.abs(a.G - b.G) + Math.abs(a.B - b.B) < 1e-6;
	const details = () => deep(screen(), "Details");
	const action = () => deep(details(), "Action");
	const legend = root => deep(root, "Legend")?.Text;
	const status = () => legend(deep(details(), "Status"));
	const noteText = () => deep(deep(details(), "Note"), "Text")?.Text ?? "";
	const title = () => details()?.FindFirstChild("Title")?.Text;
	const disabled = b => b.GetAttribute("Disabled") === true;
	const previewTitle = () => deep(deep(details(), "TitlePreview"), "TitleLabel");

	// the Pets page once, unmeasured: its pack buttons pick up their skin on their first "outline" (part 9's page, not
	// this one) -- from here on every step is measured, the Titles tab's first opening included
	click(deep(screen(), "Tabs").FindFirstChild("Tab1"), "Pets");
	click(deep(screen(), "Tabs").FindFirstChild("Tab0"), "Outfits");
	let r = phase("titulos: abre a aba", () => click(deep(screen(), "Tabs").FindFirstChild("Tab2"), "Titles"));
	check("abrir a aba de titulos nao cria nem destroi Instance (tudo montado ao abrir)", zero(r), cost(r));
	check("a aba de titulos aparece, as outras somem", titlesPage().Visible && !deep(screen(), "Page0").Visible);
	const rows = titlesPage()
		.GetDescendants()
		.filter(d => /^Row\d+$/.test(d.Name));
	check(
		"linhas, nao ladrilhos: [None] + 3 titulos",
		rows.length === 4 && rows.every(x => x.ClassName === "TextButton"),
	);
	check(
		"sem campo de busca",
		screen()
			.GetDescendants()
			.every(d => d.ClassName !== "TextBox"),
	);
	check(
		"a primeira linha e [None] / Unequip title",
		rowText(0, "Name") === "[None]" && rowText(0, "HowTo") === "Unequip title",
		`${rowText(0, "Name")} / ${rowText(0, "HowTo")}`,
	);
	check(
		"cada titulo entre colchetes, com a linha de como ganhar",
		rowText(1, "Name") === "[Survivor]" &&
			rowText(2, "Name") === "[Horde Breaker]" &&
			rowText(3, "Name") === "[Week One]" &&
			rowText(1, "HowTo") === "Survive your first night." &&
			rowText(2, "HowTo") === "Put down 100 zombies." &&
			rowText(3, "HowTo") === "Stay alive for 7 days in one life.",
	);
	check(
		"na cor de cada um: verde, laranja, amarelo (tokens STAT)",
		sameColor(rowColor(1, "Name"), STAT.bonus) &&
			sameColor(rowColor(2, "Name"), STAT.effect) &&
			sameColor(rowColor(3, "Name"), STAT.value),
	);
	check(
		"bloqueadas: mais escuras e com cadeado; a ganha, grafite e sem cadeado",
		locked(row(2)) &&
			locked(row(3)) &&
			sameColor(face(row(2)), SURFACE.well) &&
			!locked(row(1)) &&
			sameColor(face(row(1)), SURFACE.row) &&
			!locked(row(0)),
	);
	check(
		"o titulo mostrado abre selecionado (o anel azul) e com a tecla EQUIPPED",
		ringed(row(1)) && worn(1) && !worn(0),
	);
	check("so ele: nenhuma outra linha no anel", !ringed(row(0)) && !ringed(row(2)) && !ringed(row(3)));
	check(
		"contagem na secao: 1 / 3",
		legend(deep(titlesPage(), "Count")) === "1 / 3",
		legend(deep(titlesPage(), "Count")),
	);
	check(
		"painel: nome, TITLE, Equipped e Unequip",
		title() === "Survivor" &&
			legend(deep(details(), "Slot")) === "TITLE" &&
			status() === "Equipped" &&
			action().Text === "Unequip" &&
			!disabled(action()),
		`${title()} / ${legend(deep(details(), "Slot"))} / ${status()} / ${action().Text}`,
	);
	check(
		"a previa e a placa do mundo, com o titulo SOB o nome, na cor dele",
		previewTitle()?.Visible === true &&
			previewTitle().Text === "[Survivor]" &&
			sameColor(previewTitle().TextColor3, STAT.bonus) &&
			previewTitle().Parent === deep(deep(details(), "TitlePreview"), "NameRow")?.Parent &&
			previewTitle().LayoutOrder > deep(deep(details(), "TitlePreview"), "NameRow").LayoutOrder,
	);
	check(
		"a previa do guarda-roupa de trajes fica escondida",
		deep(deep(details(), "PreviewBed"), "Preview").Visible === true &&
			deep(deep(details(), "PreviewBed"), "Scaled").Visible === false,
	);

	// a locked title: "Locked" disabled, the requirement and the server's count
	r = phase("titulos: seleciona Horde Breaker (bloqueado)", () => click(row(2), "Horde Breaker"));
	check("selecionar uma linha nao cria nem destroi Instance", zero(r), cost(r));
	check("o anel vai para ela", ringed(row(2)) && !ringed(row(1)) && locked(row(2)));
	check(
		"bloqueado: Locked, desabilitado",
		status() === "Locked" && action().Text === "Locked" && disabled(action()),
		`${status()} / ${action().Text}`,
	);
	check(
		"com o requisito e o progresso que o servidor contou",
		noteText() === "Put down 100 zombies. Zombies put down: 37 / 100",
		noteText(),
	);
	check(
		"a previa experimenta o titulo, em laranja",
		previewTitle().Text === "[Horde Breaker]" && sameColor(previewTitle().TextColor3, STAT.effect),
	);
	click(action(), "Locked");
	check("um botao desabilitado nao pede nada ao servidor", asked.length === 0);
	click(row(3), "Week One");
	check(
		"Week One conta os dias desta vida: 2 / 7",
		noteText() === "Stay alive for 7 days in one life. Days survived in this life: 2 / 7",
		noteText(),
	);

	// [None] takes the title off, through the server
	click(row(0), "None");
	check("[None] com um titulo mostrado: Unequip", action().Text === "Unequip" && !disabled(action()));
	r = phase("titulos: tira o titulo", () => click(action(), "Unequip"));
	check("tirar atualiza no lugar", zero(r), cost(r));
	check(
		"o pedido e so { kind, titleId: -1 }",
		asked.length === 1 && JSON.stringify(asked[0]) === JSON.stringify({ kind: "equipTitle", titleId: -1 }),
		JSON.stringify(asked),
	);
	check("o servidor tirou, e a copia do cliente tambem", save.equipTitle === -1 && !worn(1));
	check("sem titulo mostrado, [None] nao tem o que tirar", status() === "Equipped" && disabled(action()));
	check("e a placa da previa fica so com o nome", previewTitle().Visible === false);

	// Equip the earned one
	click(row(1), "Survivor");
	check(
		"um titulo ganho e nao mostrado: Equip",
		status() === "Owned" && action().Text === "Equip" && !disabled(action()),
	);
	r = phase("titulos: mostra o Survivor", () => click(action(), "Equip"));
	check("mostrar atualiza no lugar", zero(r), cost(r));
	check(
		"o pedido e so o id, e o servidor aceita um titulo que concedeu",
		JSON.stringify(asked[1]) === JSON.stringify({ kind: "equipTitle", titleId: TIT.TitleId.Survivor }) &&
			save.equipTitle === TIT.TitleId.Survivor &&
			worn(1),
		JSON.stringify(asked),
	);

	// the server grants one while the window is open (the wallet): the row unlocks in place
	save.titles[TIT.TitleId.HordeBreaker] = 1;
	r = phase("titulos: um titulo novo chega", () => click(row(2), "Horde Breaker"));
	check("desbloquear redesenha no lugar", zero(r), cost(r));
	check("a linha perde o cadeado e clareia", !locked(row(2)) && sameColor(face(row(2)), SURFACE.row));
	check("contagem: 2 / 3", legend(deep(titlesPage(), "Count")) === "2 / 3");
	check("e oferece Equip", action().Text === "Equip" && !disabled(action()));

	r = phase("titulos: 4 trocas de aba", () => {
		for (const i of [0, 2, 1, 2]) click(deep(screen(), "Tabs").FindFirstChild(`Tab${i}`), `tab ${i}`);
	});
	check("ir e voltar entre as tres abas segue sem criar nem destruir", zero(r), cost(r));
	click(deep(screen(), "Tabs").FindFirstChild("Tab0"), "Outfits");
	check(
		"de volta aos trajes, a acao unica volta a funcionar (nao herda o Locked)",
		!disabled(action()) && action().Text !== "Locked",
		action().Text,
	);
	close();
	check("fechar remove a tela", screen() === undefined);

	// the nameplate itself, measured (MON-02 / the owner's "it must not hide the survivor")
	const host = makeInstance("Frame", false);
	host.Parent = ctx.uiLayer;
	const plate = new Nameplate(host, 5, { displayName: "Zed", name: "zed_survives" });
	flush();
	plate.update(100, 100, 12, true, 0);
	const pill = host.FindFirstChild("Nameplate");
	const nameRow = pill.FindFirstChild("NameRow");
	const titleLabel = pill.FindFirstChild("TitleLabel");
	const pad = pill.FindFirstChildOfClass("UIPadding");
	const badge = nameRow.FindFirstChild("LevelBadge");
	const badgePad = badge.FindFirstChildOfClass("UIPadding");
	const oneLine =
		pad.PaddingTop.Offset +
		pad.PaddingBottom.Offset +
		Math.max(
			badge.TextSize + badgePad.PaddingTop.Offset + badgePad.PaddingBottom.Offset,
			nameRow.FindFirstChild("NameLabel").TextSize,
		);
	check("sem titulo, a segunda linha nao existe (escondida, sem ocupar espaco)", titleLabel.Visible === false);
	plate.update(100, 100, 12, true, TIT.titleToWire(TIT.TitleId.WeekOne));
	const twoLines = oneLine + titleLabel.TextSize + (pill.FindFirstChildOfClass("UIListLayout")?.Padding.Offset ?? 0);
	check(
		"com titulo: a segunda linha, sob o nome, na cor dele, sem contorno (UI-04)",
		titleLabel.Visible &&
			titleLabel.Text === "[Week One]" &&
			sameColor(titleLabel.TextColor3, STAT.value) &&
			titleLabel.LayoutOrder > nameRow.LayoutOrder &&
			titleLabel.FindFirstChildOfClass("UIStroke") === undefined &&
			(titleLabel.TextStrokeTransparency ?? 1) >= 1,
	);
	check(
		`legivel: ${titleLabel.TextSize} px (piso de 9 px do kit)`,
		titleLabel.TextSize >= 9 && titleLabel.TextSize >= TITLE_TEXT,
	);
	// the pill hangs from its TOP at PLAYER_RADIUS + 14 u under the survivor's centre (gameLoop / allyPlate): a second
	// line grows it downward, away from the body, so it can never cover the survivor; what it costs is height below
	const PLAYER_R = 18;
	const GAP = 14;
	check(
		`a placa cresce ${twoLines - oneLine} px (${oneLine} -> ${twoLines} px a 1080p), para BAIXO: o topo segue ${GAP} px abaixo do corpo`,
		pill.AnchorPoint.Y === 0 && twoLines - oneLine <= oneLine * 0.75 && PLAYER_R + GAP > PLAYER_R,
	);
	plate.update(100, 100, 12, true, 99);
	check("um byte que nao e titulo nao desenha nada", titleLabel.Visible === false);
	plate.destroy();
	host.Destroy();
}

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
