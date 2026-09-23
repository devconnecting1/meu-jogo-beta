#!/usr/bin/env node
/*
 * Does the Bag create Instances when all it should do is switch a tab or update a number? And does it show what the
 * save says, with a picture for every item?
 *
 *   node tools/test-backpack.mjs
 *   PZ_SRC=<another checkout>/src node tools/test-backpack.mjs    (measures that version, e.g. the code before)
 *
 * The owner, in a playtest: "when I open the Bag and go through the tabs, Craft and so on, it takes a few ms to
 * load, and it should be instant". Creating GuiObjects is one of the most expensive things a Roblox client does
 * (Instance.new, every property, the reparent, a layout pass). And later: "make items, equipment etc. show a VISUAL of
 * the item instead of a table, so it's easy to see what each item is" -- the Bag of DESIGN_RULES UI-11: a grid of
 * tiles with pixel icons (client/ui/bagGrid.ts, itemIcon.ts) and a details panel (bagPanel.ts).
 *
 * There is no Studio in CI, so this runs the REAL backpack.ts / bagGrid.ts / bagPanel.ts / itemIcon.ts / widgets.ts /
 * skin.ts / theme.ts / save.ts under Node, over a small fake Instance tree, and counts what a profiler would blame:
 * Instances created and destroyed (plus the property writes on Instances that already existed, to show an update
 * only touches what changed).
 *
 * 0. the icons (shared/data/itemIcons.ts): every item id of every kind has one, and it is a drawing (never the old
 *    letter, never the generic box); every item of Núcleo 1 (CON-03) has its OWN drawing, not only its category's;
 *    every icon repaints its grid exactly from its Frames and costs at most ~80 of them.
 * 1-8. the walk: open the Bag; every tab 5 times; select tiles; equip; use an item (a count drops) and the last one
 *    (a tile goes); craft (counts drop, a new item appears in another tab); learn a skill; a change from OUTSIDE while
 *    open (server reply, admin patch); close and reopen; a change while closed; every tab once more; the mouse's
 *    card and the pad's cursor. It asserts:
 *     a. once a screen was built, going back to it creates and destroys ZERO Instances;
 *     b. an action creates at most what the new data needs (one tile for an item the grid never had);
 *     c. what is on screen always matches the save -- the tiles, their icons and counts, the panel.
 * 9. the WARDROBE (client/ui/wardrobe.ts, MON-04 / UI-07) on the same kit and fake tree.
 * 10. what a full page costs (all 30 weapons; the 80 recipes), reported.
 * 11. the layout at 1120 x 630 and at 1360 x 435 (a phone), through a small layout pass over the fake tree: no
 *    two blocks of the window overlap, and a tile is at least MIN_TOUCH_PX (44 px) on the phone.
 *
 * Pure Node (>= 18) plus the project's TypeScript, on the shared shims of tools/luau-shim.mjs. The fake tree
 * only models what the kit touches (parenting, Destroy, attributes, property / event signals, Visible); it has
 * no layout engine (part 11 brings a small one), so it counts WORK, it does not time it.
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
globalThis.tonumber = v => (Number.isFinite(Number(v)) ? Number(v) : undefined);

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
const { defaultSave, equipSlotOf, setEquipped, ownsWeapon, ownsEquip } = require(join(SRC, "shared/game/save.ts"));
const { WEAPONS } = require(join(SRC, "shared/data/weapons.ts"));
const { EQUIPS } = require(join(SRC, "shared/data/equips.ts"));
const { USABLES } = require(join(SRC, "shared/data/usables.ts"));
const { ETC_ITEMS } = require(join(SRC, "shared/data/etcItems.ts"));
const { CRAFT_RECIPES } = require(join(SRC, "shared/data/crafts.ts"));
const { SKILLS } = require(join(SRC, "shared/data/skills.ts"));
const { ITEM_ICONS, ICON_GLYPHS, iconOf, skillIconOf } = require(join(SRC, "shared/data/itemIcons.ts"));
const { ICON_ART_ORDER } = require(join(SRC, "shared/engine/colors.ts"));
const Icon = require(join(SRC, "client/ui/itemIcon.ts"));
const { STAT, GAME, THEME, SURFACE } = require(join(SRC, "client/ui/theme.ts"));
flush();

// ---------------------------------------------------------------- measuring

let failures = 0;
function check(name, ok, detail) {
	const tail = detail === undefined || detail === "" ? "" : `  (${detail})`;
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
	const r = {
		label,
		bagNew: 0,
		bagGone: 0,
		toastNew: 0,
		writes: stats.writes,
		tweens: tweens - tweensBefore,
		made: [],
	};
	for (const e of stats.log.slice(from)) {
		const my = e.inst[INTERNAL];
		const toast = e.kind === "gone" ? e.toast : my.destroyed ? my.toastAtDestroy : underToast(e.inst);
		if (toast) {
			if (e.kind === "new") r.toastNew++;
		} else if (e.kind === "new") {
			r.bagNew++;
			r.made.push(e.inst);
		} else r.bagGone++;
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
const sameColor = (a, b) => a !== undefined && b !== undefined && a.R === b.R && a.G === b.G && a.B === b.B;

// ---------------------------------------------------------------- 0. the icons

console.log(`Bag: fonte ${SRC}\n`);
console.log("0) os icones (UI-11): um desenho para cada item, o proprio para o Nucleo 1, poucos Frames cada\n");

const KIND = { Weapon: 1, Equip: 2, Use: 3, Etc: 4 };
const TABLES = [
	[KIND.Weapon, WEAPONS, "WEAPONS"],
	[KIND.Equip, EQUIPS, "EQUIPS"],
	[KIND.Use, USABLES, "USABLES"],
	[KIND.Etc, ETC_ITEMS, "ETC_ITEMS"],
];
{
	const unresolved = [];
	const generic = [];
	for (const [kind, rows, label] of TABLES) {
		let own = 0;
		const cats = new Set();
		for (const item of rows) {
			const ref = iconOf(kind, item.id);
			if (ITEM_ICONS[ref.key] === undefined) unresolved.push(`${label}[${item.id}] ${item.name} -> ${ref.key}`);
			else if (ref.key === "cat_item") generic.push(`${label}[${item.id}] ${item.name}`);
			if (ref.own) own++;
			else cats.add(ref.key);
		}
		console.log(`  ${label}: ${rows.length} itens -> ${own} icones proprios + ${[...cats].length} categorias`);
	}
	check(
		"todo item de toda tabela resolve para um DESENHO (nenhuma letra: o glifo antigo nao existe mais)",
		unresolved.length === 0,
		unresolved.join("; "),
	);
	check(
		"nenhum item real cai no icone de ultimo recurso (a caixa cat_item)",
		generic.length === 0,
		generic.join("; "),
	);
	const skills = SKILLS.map(s => skillIconOf(s.id));
	check(
		`as ${SKILLS.length} skills tem cada uma um glifo desenhado`,
		skills.every(k => ITEM_ICONS[k] !== undefined && k !== "cat_item"),
		skills.join(", "),
	);
}

/** Núcleo 1 (DESIGN_RULES CON-03), by kind and id, with the name the data must still have there */
const NUCLEO_1 = [
	[KIND.Weapon, 0, "Dagger"],
	[KIND.Weapon, 2, "Axe"],
	[KIND.Weapon, 6, "Baseball bat"],
	[KIND.Weapon, 10, "Pistol"],
	[KIND.Use, 0, "Raw meat"],
	[KIND.Use, 1, "Cooked meat"],
	[KIND.Use, 17, "Apple"],
	[KIND.Use, 9, "Canned food"],
	[KIND.Use, 12, "Bandage"],
	[KIND.Etc, 23, "Wood"],
	[KIND.Etc, 24, "Stone"],
	[KIND.Etc, 26, "Steel"],
	[KIND.Etc, 34, "Cloth"],
	[KIND.Etc, 44, "Normal ammo"],
	[KIND.Etc, 14, "Campfire"],
	[KIND.Etc, 10, "Wooden barricade"],
	[KIND.Etc, 11, "Wooden door"],
	[KIND.Etc, 0, "Craft desk"],
	[KIND.Equip, 0, "Cotton clothes"],
	[KIND.Equip, 13, "Flashlight"],
];
{
	const tableOf = kind => TABLES.find(t => t[0] === kind)[1];
	const drift = NUCLEO_1.filter(([kind, id, name]) => tableOf(kind)[id]?.name !== name);
	check("a lista do Nucleo 1 bate com os dados (ids e nomes)", drift.length === 0, drift.map(d => d[2]).join(", "));
	const refs = NUCLEO_1.map(([kind, id, name]) => [name, iconOf(kind, id)]);
	const notOwn = refs.filter(([, ref]) => !ref.own || ref.key.startsWith("cat_"));
	check(
		`os ${NUCLEO_1.length} itens do Nucleo 1 tem cada um o PROPRIO icone, nao so o da categoria`,
		notOwn.length === 0,
		notOwn.map(([n, ref]) => `${n} -> ${ref.key}`).join(", "),
	);
	const keys = refs.map(([, ref]) => ref.key);
	check("e nenhum dos 20 divide o desenho com outro", [...new Set(keys)].length === keys.length, keys.join(", "));
}

const ORDER = ICON_ART_ORDER;
/** paints the runs of `key` in order and compares with its grid: the Frames must BE the icon, pixel for pixel */
function repaints(key, rows, mono) {
	const n = rows.length;
	const canvas = new Array(n * n).fill(".");
	for (const [x, y, w, h, ch] of Icon.iconRuns(key)) {
		for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) canvas[yy * n + xx] = ch;
	}
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const want = rows[y][x] === "." ? "." : mono ? "#" : rows[y][x];
			if (canvas[y * n + x] !== want) return false;
		}
	}
	return (
		rows.every(r => r.length === n) &&
		rows.every(r => [...r].every(c => c === "." || (mono ? c === "#" : ORDER.includes(c))))
	);
}
const ICON_KEYS = Object.keys(ITEM_ICONS);
const GLYPH_KEYS = Object.keys(ICON_GLYPHS);
const frameCounts = ICON_KEYS.map(k => [k, Icon.iconFrameCount(k)]).sort((a, b) => b[1] - a[1]);
const MAX_ICON_FRAMES = 80;
{
	const bad = [
		...ICON_KEYS.filter(k => !repaints(k, ITEM_ICONS[k], false)),
		...GLYPH_KEYS.filter(k => !repaints(k, ICON_GLYPHS[k], true)),
	];
	check(
		`os ${ICON_KEYS.length} icones e ${GLYPH_KEYS.length} glifos se repintam EXATAMENTE a partir dos seus Frames (16 x 16 / 8 x 8, cores do ICON_ART)`,
		bad.length === 0,
		bad.join(", "),
	);
	const over = frameCounts.filter(([, c]) => c > MAX_ICON_FRAMES);
	const total = frameCounts.reduce((s, [, c]) => s + c, 0);
	check(
		`nenhum icone passa de ${MAX_ICON_FRAMES} Frames depois de juntar as corridas (256 sem juntar)`,
		over.length === 0,
		`media ${(total / frameCounts.length).toFixed(1)}, maximo ${frameCounts[0][1]} (${frameCounts[0][0]})${over.length > 0 ? `; acima: ${over.map(o => o.join("=")).join(", ")}` : ""}`,
	);
	console.log(`  Frames por icone: ${frameCounts.map(([k, c]) => `${k} ${c}`).join(", ")}`);
	console.log(`  Frames por glifo: ${GLYPH_KEYS.map(k => `${k} ${Icon.iconFrameCount(k)}`).join(", ")}`);
}

// ---------------------------------------------------------------- the save and the game's callbacks

const MAT_START = 23;
const save = defaultSave();
// a survivor a few days in: some weapons, some equipment, food and medicine, a pile of materials, 2 points
for (let id = 1; id <= 8 && id < WEAPONS.length; id++) save.invenWeapon[id] = id % 3 === 0 ? 2 : 1;
// and the pistol of Núcleo 1: a gun, with a magazine, a reserve and a reload
save.invenWeapon[10] = 1;
save.ammoNormal = 41;
for (let id = 0; id < 6 && id < EQUIPS.length; id++) save.invenEquip[id] = 1;
for (let id = 0; id < 8 && id < USABLES.length; id++) save.invenUse[id] = 3;
for (let id = MAT_START; id < MAT_START + 14 && id < ETC_ITEMS.length; id++) save.invenEtc[id] = 6;
save.skillPoint = 2;

// the recipe the walk crafts: hand-made, only materials, result not owned yet (so a new tile must appear)
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

function newCtx(forSave) {
	const c = { phase: "playing", save: forSave, uiLayer: undefined };
	const gui = makeInstance("ScreenGui", false);
	const layer = makeInstance("Frame", false);
	layer.Name = "Ui";
	layer.Parent = gui;
	c.uiLayer = layer;
	c.screen = gui;
	return c;
}
const ctx = newCtx(save);

/** what main.client does (without the world): the backpack only asks, the game changes the save */
function wire(pack, s) {
	pack.nearbyDesk = true;
	pack.nearbyPro = true;
	pack.nearbyFire = true;
	pack.craftCheck = () => undefined;
	pack.onEquipWeapon = id => {
		s.equipWeapon = id;
	};
	pack.onEquipItem = id => {
		setEquipped(s, equipSlotOf(id), id);
	};
	pack.onUnequipItem = slot => {
		setEquipped(s, slot, -1);
	};
	pack.onUse = id => {
		if ((s.invenUse[id] ?? 0) > 0) s.invenUse[id] -= 1;
	};
	pack.onCraft = id => {
		const r = CRAFT_RECIPES.find(x => x.id === id);
		const inv = kind =>
			kind === KIND.Weapon
				? s.invenWeapon
				: kind === KIND.Equip
					? s.invenEquip
					: kind === KIND.Use
						? s.invenUse
						: s.invenEtc;
		for (const ing of r.ingredients) inv(ing.kind)[ing.index] -= ing.count;
		inv(r.resultKind)[r.resultIndex] = (inv(r.resultKind)[r.resultIndex] ?? 0) + r.resultCount;
	};
}
const pack = new Backpack(ctx);
wire(pack, save);

// ---------------------------------------------------------------- driving the UI like a player

let uiCtx = ctx;
const bag = () => uiCtx.uiLayer.FindFirstChild("Backpack");
/** first descendant with that name (hidden or not) */
const deep = (root, name) => root?.GetDescendants().find(d => d.Name === name);
const win = () => bag()?.FindFirstChild("Body")?.FindFirstChild("Window");
function click(button, what) {
	if (button === undefined) throw new Error(`button not found: ${what}`);
	button.Activated.Fire();
	flush();
}
const TABS = ["Weapons", "Gear", "Usables", "Materials", "Craft", "Skills"];
const tabBtn = i => win()?.FindFirstChild("Tabs")?.FindFirstChild(`Tab${i}`);
const tab = i => click(tabBtn(i), `tab ${TABS[i]}`);
const page = i => win()?.FindFirstChild(`Page${i}`);
/** the tiles of tab `i` on screen, in grid order; `all` includes the empty cells */
function cellsOf(i, all = false) {
	const p = page(i);
	if (p === undefined) return [];
	return p
		.GetDescendants()
		.filter(d => d.ClassName === "TextButton" && /^Tile\d+$/.test(d.Name) && d.Visible && d.Parent.Visible)
		.filter(d => all || d.GetAttribute("Key") !== "")
		.sort((a, b) => a.Parent.LayoutOrder - b.Parent.LayoutOrder || a.Position.X.Scale - b.Position.X.Scale);
}
const tilesOf = i => cellsOf(i, false);
const keyOf = t => t.GetAttribute("Key");
const iconKey = t => t?.FindFirstChild("ItemIcon")?.GetAttribute("Icon");
/** the text of a tile's chip ("Count", "Ammo"), or undefined when it does not show */
const chip = (t, name) => {
	const c = t?.FindFirstChild(name);
	return c?.Visible ? c.FindFirstChild("Text")?.Text : undefined;
};
const chipColor = (t, name) => t?.FindFirstChild(name)?.FindFirstChild("Text")?.TextColor3;
const tileFor = (i, key) => tilesOf(i).find(t => keyOf(t) === key);
const face = host => host?.FindFirstChild("PlateFace")?.BackgroundColor3;
const tagShown = t => t?.FindFirstChild("Tag")?.Visible === true;
const details = () => win()?.FindFirstChild("Details");
const panelTitle = () => details()?.FindFirstChild("Title")?.Text;
const panelState = () => {
	const k = details()?.FindFirstChild("State");
	return k?.Visible ? k.FindFirstChild("Legend")?.Text : "";
};
const panelIcon = () => deep(details()?.FindFirstChild("IconBed"), "ItemIcon")?.GetAttribute("Icon");
const action = () => details()?.FindFirstChild("Action");
const act = () => click(action(), "the panel's button");
/** the value label of the stat line `label` in the panel (or in `root`) */
const statValue = (label, root = details()) =>
	root
		?.GetDescendants()
		.find(d => d.Name === "Label" && d.Text === label && d.Parent.Visible)
		?.Parent?.FindFirstChild("Value");
const legends = root =>
	root === undefined
		? []
		: root
				.GetDescendants()
				.filter(d => d.Name === "Legend" && d.Parent.Parent.Visible && d.Parent.Visible)
				.map(d => d.Text);
const heartbeat = dt => {
	service("RunService").Heartbeat.Fire(dt);
	flush();
};

/** what tab `cat` must list, in order, from the save alone (the Bag's rules, written again here) */
function expectedTiles(cat, s = save) {
	const out = [];
	if (cat === 0) {
		for (const w of WEAPONS)
			if (ownsWeapon(s, w.id))
				out.push([
					`1:${w.id}`,
					iconOf(1, w.id).key,
					(s.invenWeapon[w.id] ?? 0) > 1 ? `×${s.invenWeapon[w.id]}` : undefined,
				]);
	} else if (cat === 1) {
		for (const e of EQUIPS)
			if (ownsEquip(s, e.id))
				out.push([
					`2:${e.id}`,
					iconOf(2, e.id).key,
					(s.invenEquip[e.id] ?? 0) > 1 ? `×${s.invenEquip[e.id]}` : undefined,
				]);
	} else if (cat === 2) {
		for (const u of USABLES)
			if ((s.invenUse[u.id] ?? 0) > 0) out.push([`3:${u.id}`, iconOf(3, u.id).key, `×${s.invenUse[u.id]}`]);
	} else if (cat === 3) {
		for (let i = MAT_START; i < ETC_ITEMS.length; i++)
			if ((s.invenEtc[i] ?? 0) > 0) out.push([`4:${i}`, iconOf(4, i).key, `×${s.invenEtc[i]}`]);
	} else if (cat === 5) {
		for (const sk of SKILLS) out.push([`s:${sk.id}`, skillIconOf(sk.id), undefined]);
	}
	return out;
}
/** does tab `cat` show what the save says: the same items, in order, with their icons and counts? */
function showsSave(cat) {
	const want = expectedTiles(cat);
	const got = tilesOf(cat).map(t => [keyOf(t), iconKey(t), chip(t, "Count")]);
	const ok = JSON.stringify(want) === JSON.stringify(got);
	return [ok, ok ? `${got.length} ladrilhos` : `esperado ${JSON.stringify(want)} / na tela ${JSON.stringify(got)}`];
}

// ---------------------------------------------------------------- 1. open, and every tab

console.log("\n1) abrir e percorrer as abas\n");

phase("abrir o Bag (1a vez)", () => pack.open());
check(
	"o Bag abre numa janela so, com as 6 abas",
	win() !== undefined && [0, 1, 2, 3, 4, 5].every(i => tabBtn(i)?.Text === TABS[i]),
);
check(
	'o cabecalho perdeu o "<" e a tecla B; o "?" e o X vermelho ficam',
	deep(win(), "Nav") === undefined &&
		deep(win(), "KeyHint") === undefined &&
		win().FindFirstChild("Help") !== undefined &&
		win().FindFirstChild("Close") !== undefined,
);
check("abre em Weapons, com as armas da mochila (icones e contagens)", ...showsSave(0));
check(
	"a primeira arma vem selecionada (azul) e o painel a mostra",
	sameColor(face(tilesOf(0)[0]), THEME.tabActive) &&
		panelTitle() === WEAPONS[0].name &&
		panelIcon() === iconOf(1, 0).key,
	`${panelTitle()} / ${panelIcon()}`,
);
check(
	"os pontos de skill sao um badge na aba Skills (o SP 0 saiu do cabecalho)",
	deep(tabBtn(5), "Points")?.Visible === true &&
		deep(deep(tabBtn(5), "Points"), "Text")?.Text === "2" &&
		deep(win(), "SkillPoints") === undefined,
);

const firstVisit = [1, 2, 3, 4, 5, 0].map(i => phase(`1a visita: ${TABS[i]}`, () => tab(i)));
for (const cat of [1, 2, 3, 5]) {
	tab(cat);
	check(`${TABS[cat]} mostra o que o save diz`, ...showsSave(cat));
}
tab(4);
check(
	"Craft mostra as receitas, cada uma com o icone do que ela faz",
	tilesOf(4).length === CRAFT_RECIPES.length &&
		tilesOf(4)
			.slice(0, 6)
			.every(t => {
				const r = CRAFT_RECIPES.find(x => `r:${x.id}` === keyOf(t));
				return r !== undefined && iconKey(t) === iconOf(r.resultKind, r.resultIndex).key;
			}),
	`${tilesOf(4).length} receitas`,
);
tab(0);

for (let round = 2; round <= 5; round++) {
	const r = phase(`volta ${round}: 6 trocas de aba`, () => {
		for (const i of [1, 2, 3, 4, 5, 0]) tab(i);
	});
	check(`volta ${round} pelas 6 abas nao cria nem destroi Instance`, zero(r), cost(r));
}

// ---------------------------------------------------------------- 2. selecting, and the panel

console.log("\n2) selecionar um ladrilho: o painel da direita\n");
tab(0);
const weaponTiles = tilesOf(0);
const weaponOf = t => WEAPONS[Number(keyOf(t).split(":")[1])];
let r = phase("seleciona a 2a arma", () => click(weaponTiles[1], "weapon 2"));
check("selecionar outro ladrilho nao cria nem destroi Instance", zero(r), cost(r));
check(
	"o painel mostra a arma clicada: nome, icone grande e o dano na voz amarela",
	panelTitle() === weaponOf(weaponTiles[1]).name &&
		panelIcon() === iconOf(1, weaponOf(weaponTiles[1]).id).key &&
		statValue("Damage")?.Text === String(weaponOf(weaponTiles[1]).dmg) &&
		sameColor(statValue("Damage")?.TextColor3, STAT.value),
	`${panelTitle()} / ${statValue("Damage")?.Text}`,
);
check(
	"o selecionado e o azul em relevo; o anterior volta ao ferro",
	sameColor(face(weaponTiles[1]), THEME.tabActive) &&
		sameColor(
			face(weaponTiles[0]),
			save.equipWeapon === weaponOf(weaponTiles[0]).id ? THEME.secondary : SURFACE.section,
		),
);
const gunTile = weaponTiles.find(t => weaponOf(t).mag > 0 && weaponOf(t).kind !== 7);
r = phase("seleciona uma arma de fogo", () => click(gunTile, "gun"));
check("uma arma de fogo (6 stats, dica de recarga) tambem nao cria Instance", zero(r), cost(r));
check(
	"a arma de fogo mostra a reserva de municao em amarelo no ladrilho",
	chip(gunTile, "Ammo") !== undefined && sameColor(chipColor(gunTile, "Ammo"), STAT.value),
	chip(gunTile, "Ammo"),
);
check(
	"e o painel fala o teclado: clique ataca, R recarrega",
	legends(details()).includes("Left click") && legends(details()).includes("R"),
	legends(details()).join(", "),
);
r = phase("volta a 1a arma", () => click(weaponTiles[0], "weapon 1"));
check("voltar a um item ja visto nao cria nem destroi Instance", zero(r), cost(r));

const toEquip = weaponTiles[2];
/** did `r` create only the equipped check of `tile` (the first time that tile shows one)? */
const onlyTag = (r, tile) =>
	r.made.every(i => i.IsDescendantOf(tile) && (i.Name === "Tag" || i.IsDescendantOf(tile.FindFirstChild("Tag"))));
r = phase("equipa uma arma (botao do painel)", () => {
	click(toEquip, "weapon 3");
	act();
});
check(
	"equipar atualiza no lugar: cria no maximo o check verde do ladrilho (a 1a vez que ele o mostra)",
	r.bagGone === 0 && onlyTag(r, toEquip),
	cost(r),
);
check("o save tem a arma na mao", save.equipWeapon === weaponOf(toEquip).id);
r = phase("equipa a 1a arma e volta a 3a", () => {
	click(weaponTiles[0], "weapon 1");
	act();
	click(toEquip, "weapon 3");
	act();
});
check(
	"equipar de novo uma arma que ja teve o check nao cria nem destroi Instance",
	r.bagGone === 0 && onlyTag(r, weaponTiles[0]),
	cost(r),
);
r = phase("e de novo, ida e volta", () => {
	click(weaponTiles[0], "weapon 1");
	act();
	click(toEquip, "weapon 3");
	act();
});
check("ida e volta entre duas armas ja equipadas antes: zero", zero(r), cost(r));
check("o save tem a arma na mao de novo", save.equipWeapon === weaponOf(toEquip).id);
check(
	'o painel diz EQUIPPED e o botao fica "Equipped", desligado',
	panelState() === "EQUIPPED" && action()?.Text === "Equipped" && action()?.GetAttribute("Disabled") === true,
	`${panelState()} / ${action()?.Text}`,
);
click(weaponTiles[0], "weapon 1");
check(
	"o ladrilho da arma equipada: face de ferro e o check verde",
	tagShown(toEquip) && sameColor(face(toEquip), THEME.secondary) && !tagShown(weaponTiles[0]),
);
check(
	"a acao principal e a chapa azul (Equip)",
	action()?.Text === "Equip" && action()?.GetAttribute("Variant") === "default",
);

// ---------------------------------------------------------------- 3. using an item

console.log("\n3) usar item (uma contagem muda) e usar o ultimo (um ladrilho sai)\n");
tab(2);
const useA = USABLES[0];
const useB = USABLES[1];
click(tileFor(2, `3:${useA.id}`), useA.name);
check(`comida se come: o botao diz Eat (${useA.name})`, action()?.Text === "Eat", action()?.Text);
r = phase(`Eat ${useA.name} (3 -> 2)`, act);
check("usar nao cria nem destroi Instance", zero(r), cost(r));
check(
	"o painel e o ladrilho mostram a contagem nova",
	panelState() === "×2" && chip(tileFor(2, `3:${useA.id}`), "Count") === "×2",
	`${panelState()} / ${chip(tileFor(2, `3:${useA.id}`), "Count")}`,
);
const medicine = USABLES.find(u => u.pain > 0 || u.speed > 0 || u.calm > 0);
click(tileFor(2, `3:${medicine.id}`), medicine.name);
check(`remedio se usa: o botao diz Use (${medicine.name})`, action()?.Text === "Use", action()?.Text);
save.invenUse[useB.id] = 1;
heartbeat(0.3);
const before = tilesOf(2).length;
click(tileFor(2, `3:${useB.id}`), useB.name);
r = phase(`usa o ultimo ${useB.name} (1 -> 0)`, act);
check("usar o ultimo nao cria nem destroi Instance (o ladrilho vira celula vazia)", zero(r), cost(r));
check(
	"o ladrilho do item acabado saiu",
	tileFor(2, `3:${useB.id}`) === undefined && tilesOf(2).length === before - 1,
	`${before} -> ${tilesOf(2).length}`,
);
check(
	"e a selecao passou para um item que existe",
	panelTitle() === USABLES[Number(keyOf(tilesOf(2)[0]).split(":")[1])].name,
	panelTitle(),
);
check("Usables segue batendo com o save", ...showsSave(2));

// ---------------------------------------------------------------- 4. craft

console.log("\n4) craft\n");
const resultName = (RECIPE.resultKind === KIND.Weapon ? WEAPONS : USABLES)[RECIPE.resultIndex].name;
const resultIcon = iconOf(RECIPE.resultKind, RECIPE.resultIndex).key;
tab(4);
const recipeTile = () => tileFor(4, `r:${RECIPE.id}`);
check(
	`a receita de ${resultName}: o icone do resultado, a estacao (maos) e quantas da para fazer`,
	iconKey(recipeTile()) === resultIcon &&
		deep(recipeTile(), "Station")?.GetAttribute("Icon") === "hand" &&
		chip(recipeTile(), "Count") === "×1",
	`${iconKey(recipeTile())} / ${deep(recipeTile(), "Station")?.GetAttribute("Icon")} / ${chip(recipeTile(), "Count")}`,
);
phase(`seleciona a receita ${resultName}`, () => click(recipeTile(), resultName));
check(
	"o painel mostra o resultado e os ingredientes com tem / precisa",
	panelTitle() === resultName &&
		deep(details(), "Ing0")?.Visible === true &&
		deep(deep(details(), "Ing0"), "Count")?.Text ===
			`${RECIPE.ingredients[0].count} / ${RECIPE.ingredients[0].count}`,
	`${panelTitle()} / ${deep(deep(details(), "Ing0"), "Count")?.Text}`,
);
check(
	"o aviso da estacao virou uma linha compacta no painel",
	deep(details(), "Nearby")?.Text?.startsWith("Near you") && deep(win(), "Notice") === undefined,
	deep(details(), "Nearby")?.Text,
);
const undrawn = new Set(cellsOf(4).filter(t => iconKey(t) === ""));
r = phase("Craft", act);
// a craft re-sorts the recipes (what can be made first): a recipe that comes on screen for the first time gets its icon
// then -- its Frames are the only thing a craft may create (the grid draws an icon when its row is shown)
const iconTile = i => i.Parent?.Parent;
check(
	"craftar atualiza no lugar: cria so os icones das receitas que entram na tela pela 1a vez",
	r.bagGone === 0 && r.made.every(i => i.Name === "Px" && undrawn.has(iconTile(i)) && iconKey(iconTile(i)) !== ""),
	`${cost(r)}; ${[...new Set(r.made.map(iconTile))].length} icones novos`,
);
const ing0 = RECIPE.ingredients[0];
check(
	"os ingredientes gastos aparecem em vermelho (0 / n)",
	deep(deep(details(), "Ing0"), "Count")?.Text === `0 / ${ing0.count}` &&
		sameColor(deep(deep(details(), "Ing0"), "Count")?.TextColor3, STAT.penalty),
	deep(deep(details(), "Ing0"), "Count")?.Text,
);
check(
	'e o ladrilho da receita diz "×0" em vermelho',
	chip(recipeTile(), "Count") === "×0" && sameColor(chipColor(recipeTile(), "Count"), STAT.penalty),
	chip(recipeTile(), "Count"),
);
check(
	"o botao passa a dizer o motivo, desligado",
	action()?.Text === "Missing items" && action()?.GetAttribute("Disabled") === true,
	action()?.Text,
);
const resultTab = RECIPE.resultKind === KIND.Weapon ? 0 : 2;
r = phase(`aba ${TABS[resultTab]} com o item novo`, () => tab(resultTab));
const newTile = tileFor(resultTab, `${RECIPE.resultKind}:${RECIPE.resultIndex}`);
const TILE_BUDGET = Icon.iconFrameCount(resultIcon) + 3;
check(
	"o item novo cria no maximo um ladrilho (os Frames do icone dele e um chip)",
	r.bagNew <= TILE_BUDGET && r.bagGone === 0,
	`${cost(r)}; teto ${TILE_BUDGET}`,
);
check("e o ladrilho dele esta la, com o icone certo", newTile !== undefined && iconKey(newTile) === resultIcon);
check(`${TABS[resultTab]} segue batendo com o save`, ...showsSave(resultTab));

// ---------------------------------------------------------------- 5. skills

console.log("\n5) skills\n");
tab(5);
const skill = SKILLS.find(s => s.maxLevel > 1);
const skillTile = () => tileFor(5, `s:${skill.id}`);
click(skillTile(), skill.name);
check(
	"o painel da skill: o glifo, o nivel e os pontos para gastar",
	panelTitle() === skill.name &&
		panelIcon() === skillIconOf(skill.id) &&
		panelState() === `LV 0 / ${skill.maxLevel}` &&
		deep(details(), "Extra")?.Text.startsWith("2 skill points"),
	`${panelState()} / ${deep(details(), "Extra")?.Text}`,
);
r = phase(`aprende ${skill.name}`, act);
check("aprender skill atualiza no lugar", zero(r), cost(r));
const pips = () =>
	[0, 1, 2]
		.map(p => deep(skillTile(), `Pip${p}`))
		.filter(p => p?.Visible)
		.map(p => (sameColor(p.BackgroundColor3, GAME.xp) ? "#" : "."))
		.join("");
check(`o ladrilho acende um pip de ${skill.maxLevel}`, pips() === "#" + ".".repeat(skill.maxLevel - 1), pips());
check(
	"o painel diz o nivel novo e o ponto que sobrou",
	panelState() === `LV 1 / ${skill.maxLevel}` && deep(details(), "Extra")?.Text.startsWith("1 skill point "),
	`${panelState()} / ${deep(details(), "Extra")?.Text}`,
);
check("o badge da aba Skills desce para 1", deep(deep(tabBtn(5), "Points"), "Text")?.Text === "1");
check("Skills segue batendo com o save", ...showsSave(5));

// ---------------------------------------------------------------- 6. a change from outside

console.log("\n6) dado que muda por fora com o Bag aberto (resposta do servidor, admin)\n");
tab(3);
const mat = ETC_ITEMS[MAT_START + 13];
save.invenEtc[mat.id] += 5;
r = phase("mudanca de fora + 0,5 s de quadros", () => {
	for (let i = 0; i < 30; i++) heartbeat(1 / 60);
});
check("a atualizacao por fora nao cria nem destroi Instance", zero(r), cost(r));
check(
	"o ladrilho mostra a contagem nova",
	chip(tileFor(3, `4:${mat.id}`), "Count") === "×11",
	chip(tileFor(3, `4:${mat.id}`), "Count"),
);

// ---------------------------------------------------------------- 7. close and reopen

console.log("\n7) fechar e reabrir\n");
r = phase("fecha e reabre 3 vezes", () => {
	for (let i = 0; i < 3; i++) {
		pack.close();
		pack.open();
	}
});
check("reabrir nao cria nem destroi Instance", zero(r), cost(r));
check("reabre na ultima aba", page(3)?.Visible === true && !page(0)?.Visible);
// a pad user had a tile selected: a hidden Bag must not keep it (bootstrap reads a selection as "a menu has the pad")
service("GuiService").SelectedObject = tilesOf(3)[0];
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
	tileFor(2, `3:${fresh.id}`) !== undefined && tileFor(2, `3:${USABLES[0].id}`) === undefined,
);
check(
	"e custa no maximo um ladrilho",
	r.bagNew <= Icon.iconFrameCount(iconOf(3, fresh.id).key) + 3 && r.bagGone === 0,
	cost(r),
);

// ---------------------------------------------------------------- 8. every tab once more

console.log("\n8) todas as abas mais uma vez\n");
r = phase("volta final pelas 6 abas", () => {
	for (const i of [0, 1, 2, 3, 4, 5]) tab(i);
});
check("depois de tudo, trocar de aba segue sem criar nem destruir", zero(r), cost(r));
for (const cat of [0, 1, 2, 3, 5]) {
	tab(cat);
	check(`${TABS[cat]} bate com o save`, ...showsSave(cat));
}

// ---------------------------------------------------------------- 8b. the mouse's card and the pad's cursor

console.log("\n8b) o cartao do item (UI-08) sob o mouse, e o cursor do controle\n");
const uis = service("UserInputService");
const gui = service("GuiService");
const tip = () => {
	const t = win()?.FindFirstChild("Tooltip");
	return t?.Visible ? t : undefined;
};
/** the tile's GuiState, as the engine sets it when the pointer enters / leaves it */
const pointer = (tile, on) => {
	tile.GuiState = on ? Enum.GuiState.Hover : Enum.GuiState.Idle;
	flush();
};
tab(0);
const listed = tilesOf(0);
const selectedTile = listed.find(t => sameColor(face(t), THEME.tabActive));
const other = listed.find(t => t !== selectedTile);
phase("mouse sobre outra arma (1a vez: monta o cartao)", () => pointer(other, true));
check(
	"o cartao aparece com a arma do ladrilho",
	tip()?.FindFirstChild("Header")?.FindFirstChild("Name")?.Text === weaponOf(other).name,
	tip()?.FindFirstChild("Header")?.FindFirstChild("Name")?.Text,
);
check(
	"com o icone dela no cabecalho (o mesmo do ladrilho)",
	deep(tip(), "ItemIcon")?.GetAttribute("Icon") === iconKey(other),
);
check(
	"o dano vem da tabela, em amarelo",
	statValue("Damage", tip())?.Text === String(weaponOf(other).dmg) &&
		sameColor(statValue("Damage", tip())?.TextColor3, STAT.value),
);
check(
	"o cartao nao oferece botao nenhum",
	tip()
		?.GetDescendants()
		.every(d => !d.IsA("GuiButton")),
);
pointer(other, false);
r = phase(`mouse percorre as ${listed.length} armas`, () => {
	for (const t of listed) {
		pointer(t, true);
		pointer(t, false);
	}
	for (const t of listed) pointer(t, true);
});
check("percorrer a grade com o mouse nao cria nem destroi Instance", zero(r), cost(r));
for (const t of listed) pointer(t, false);
pointer(selectedTile, true);
check("sobre o item selecionado, nada de cartao (o cartao dele e o painel)", tip() === undefined);
pointer(selectedTile, false);
check("sem mouse em cima, o cartao some", tip() === undefined);

uis.GetLastInputType = () => Enum.UserInputType.Gamepad1;
r = phase("o cursor do controle anda pela grade", () => {
	for (const t of listed) {
		gui.SelectedObject = t;
		t.SelectionGained.Fire();
		flush();
	}
});
check(
	"o cursor do controle seleciona o que toca, sem criar Instance",
	zero(r) && panelTitle() === weaponOf(listed[listed.length - 1]).name,
	`${cost(r)}; ${panelTitle()}`,
);
check("com o controle nao ha cartao (o painel segue o cursor)", tip() === undefined);
gui.SelectedObject = undefined;
flush();
uis.GetLastInputType = () => Enum.UserInputType.Touch;
uis.TouchEnabled = true;
uis.MouseEnabled = false;
pointer(other, true);
check("no toque nao ha cartao", tip() === undefined);
pointer(other, false);
uis.GetLastInputType = () => Enum.UserInputType.MouseMovement;
uis.TouchEnabled = false;
uis.MouseEnabled = true;
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

// ---------------------------------------------------------------- 9b. the titles (MON-05), on the same kit

console.log("\n9b) os titulos (MON-05): linhas, cadeado, o selecionado, a previa da placa e a acao unica\n");
{
	const saveClient = require(join(SRC, "client/systems/saveClient.ts"));
	const { showWardrobe } = require(join(SRC, "client/ui/wardrobe.ts"));
	const { buyCostume } = require(join(SRC, "server/save/costumes.ts"));
	const { equipTitle } = require(join(SRC, "server/save/titles.ts"));
	const { THEME, SURFACE, STAT } = require(join(SRC, "client/ui/theme.ts"));
	const TIT = require(join(SRC, "shared/data/titles.ts"));
	const { Nameplate, TITLE_TEXT } = require(join(SRC, "client/ui/nameplate.ts"));

	// a survivor who earned Survivor and shows it; 37 zombies put down; this life is at day 8, but only 2 of its
	// midnights were credited by the server (the others were counted before it counted days, or set by an admin)
	for (let i = 0; i < save.titles.length; i++) save.titles[i] = 0;
	save.titles[TIT.TitleId.Survivor] = 1;
	save.equipTitle = TIT.TitleId.Survivor;
	save.zombieKills = 37;
	save.day = 8;
	save.lifeNights = 2;
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
		"Week One conta as noites que o SERVIDOR creditou a esta vida (nao o dia do save): 2 / 7",
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

// ---------------------------------------------------------------- 10. what a full page costs

console.log("\n10) o custo de uma pagina cheia (todas as 30 armas; as 80 receitas)\n");
/** Instances, Frames and icon Frames ("Px") under `root` */
function census(root) {
	const d = root === undefined ? [] : root.GetDescendants();
	return {
		all: d.length + 1,
		frames: d.filter(x => x.ClassName === "Frame").length + 1,
		px: d.filter(x => x.Name === "Px").length,
		tiles: d.filter(x => /^Tile\d+$/.test(x.Name)).length,
	};
}
const fmtCensus = c => `${c.all} Instances (${c.frames} Frames, dos quais ${c.px} de icone), ${c.tiles} ladrilhos`;
let fullWeapons;
let fullCraft;
{
	const full = defaultSave();
	for (const w of WEAPONS) full.invenWeapon[w.id] = 1;
	full.ammoNormal = 60;
	const c2 = newCtx(full);
	const p2 = new Backpack(c2);
	wire(p2, full);
	uiCtx = c2;
	const opened = phase("Bag novo, 30 armas: abre em Weapons", () => p2.open());
	fullWeapons = census(page(0));
	console.log(`  abrir: ${cost(opened)} (janela + painel + a grade de armas)`);
	console.log(`  pagina de armas cheia: ${fmtCensus(fullWeapons)}`);
	check(
		"a pagina cheia mostra as 30 armas, cada uma com o seu icone",
		tilesOf(0).length === WEAPONS.length &&
			tilesOf(0).every(t => iconKey(t) === iconOf(1, Number(keyOf(t).split(":")[1])).key),
		`${tilesOf(0).length} ladrilhos`,
	);
	const craftFirst = phase("e vai a Craft", () => tab(4));
	fullCraft = census(page(4));
	console.log(
		`  Craft, 1a vista (so as linhas na tela e a seguinte tem icone): ${cost(craftFirst)}; ${fmtCensus(fullCraft)}`,
	);
	const drawn = () => tilesOf(4).filter(t => iconKey(t) !== "").length;
	check(
		"as receitas fora da tela ainda nao pagam os Frames do icone",
		drawn() < CRAFT_RECIPES.length && drawn() >= 25,
		`${drawn()} de ${CRAFT_RECIPES.length} desenhadas`,
	);
	// scroll to the end, a row at a time (the fake tree has no layout: the list gets its size on screen here)
	const list = deep(page(4), "List");
	list.AbsoluteSize = new Vector2(408, 408);
	const rows = Math.ceil(CRAFT_RECIPES.length / 5);
	const scrolled = phase("rola Craft ate o fim", () => {
		for (let y = 0; y <= rows * 80; y += 80) {
			list.CanvasPosition = new Vector2(0, y);
			flush();
		}
	});
	console.log(`  rolar ate o fim: ${cost(scrolled)}; ${fmtCensus(census(page(4)))}`);
	check(
		"rolar desenha as linhas que chegam, ate a ultima",
		drawn() === CRAFT_RECIPES.length,
		`${drawn()} de ${CRAFT_RECIPES.length}`,
	);
	const again = phase("rola de volta e de novo", () => {
		for (const y of [0, rows * 40, rows * 80, 0]) {
			list.CanvasPosition = new Vector2(0, y);
			flush();
		}
	});
	check("rolar de novo nao cria nem destroi Instance", zero(again), cost(again));
	p2.close();
	uiCtx = ctx;
}

// ---------------------------------------------------------------- 11. the layout, on a small layout pass

console.log(
	"\n11) o layout a 1120 x 630 e a 1360 x 435 (celular): nada se sobrepoe, e o ladrilho tem 44 px no toque\n",
);
const udim = (u, total) => (u?.Scale ?? 0) * total + (u?.Offset ?? 0);
/** Scale + Offset, AnchorPoint, UIPadding, UIAspectRatioConstraint and vertical UIListLayouts: what the Bag uses */
function layoutNode(inst, x, y, w, h) {
	const pos = inst.AbsolutePosition;
	const size = inst.AbsoluteSize;
	if (pos.X !== x || pos.Y !== y) inst.AbsolutePosition = new Vector2(x, y);
	if (size.X !== w || size.Y !== h) inst.AbsoluteSize = new Vector2(w, h);
	const pad = inst.FindFirstChildOfClass("UIPadding");
	let ix = x;
	let iy = y;
	let iw = w;
	let ih = h;
	if (pad !== undefined) {
		const l = udim(pad.PaddingLeft, w);
		const t = udim(pad.PaddingTop, h);
		ix += l;
		iy += t;
		iw -= l + udim(pad.PaddingRight, w);
		ih -= t + udim(pad.PaddingBottom, h);
	}
	const list = inst.FindFirstChildOfClass("UIListLayout");
	let kids = inst.GetChildren().filter(c => c.IsA("GuiObject"));
	if (list !== undefined) kids = kids.filter(c => c.Visible).sort((a, b) => a.LayoutOrder - b.LayoutOrder);
	let cursor = iy - (inst.ClassName === "ScrollingFrame" ? inst.CanvasPosition.Y : 0);
	for (const c of kids) {
		let cw = udim(c.Size.X, iw);
		let ch = udim(c.Size.Y, ih);
		// a key's legend grows with its text (AutomaticSize X, fixed TextSize): the key fits itself to it (Keycap)
		if (c.AutomaticSize?.Name === "X" && typeof c.Text === "string")
			cw = Math.max(cw, c.Text.length * (c.TextSize ?? 14) * 0.55);
		const ar = c.FindFirstChildOfClass("UIAspectRatioConstraint");
		if (ar !== undefined && ch > 0) {
			if (cw / ch > ar.AspectRatio) cw = ch * ar.AspectRatio;
			else ch = cw / ar.AspectRatio;
		}
		let cx;
		let cy;
		if (list !== undefined) {
			cx = ix;
			cy = cursor;
			cursor += ch + udim(list.Padding, ih);
		} else {
			cx = ix + udim(c.Position.X, iw) - c.AnchorPoint.X * cw;
			cy = iy + udim(c.Position.Y, ih) - c.AnchorPoint.Y * ch;
		}
		layoutNode(c, cx, cy, cw, ch);
	}
}
function layoutAt(vw, vh) {
	service("Workspace").CurrentCamera.ViewportSize = new Vector2(vw, vh);
	flush();
	for (let pass = 0; pass < 4; pass++) {
		layoutNode(bag(), 0, 0, vw, vh);
		flush();
	}
}
const rectOf = g => ({
	n: g.Name,
	x: g.AbsolutePosition.X,
	y: g.AbsolutePosition.Y,
	w: g.AbsoluteSize.X,
	h: g.AbsoluteSize.Y,
});
const overlapping = (a, b) =>
	Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 &&
	Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;
const within = (a, o) =>
	a.x >= o.x - 0.5 && a.y >= o.y - 0.5 && a.x + a.w <= o.x + o.w + 0.5 && a.y + a.h <= o.y + o.h + 0.5;
function pairwise(items) {
	const bad = [];
	for (let i = 0; i < items.length; i++) {
		for (let j = i + 1; j < items.length; j++)
			if (overlapping(items[i], items[j])) bad.push(`${items[i].n} x ${items[j].n}`);
	}
	return bad;
}
const px = n => n.toFixed(1);
pack.open();
for (const [vw, vh, touch] of [
	[1120, 630, false],
	[1360, 435, true],
]) {
	uis.TouchEnabled = touch;
	uis.MouseEnabled = !touch;
	uis.GetLastInputType = () => (touch ? Enum.UserInputType.Touch : Enum.UserInputType.MouseMovement);
	for (const cat of [0, 4, 5]) {
		tab(cat);
		layoutAt(vw, vh);
		const W0 = win();
		const winRect = rectOf(W0);
		const blocks = [
			W0.FindFirstChild("Help"),
			W0.FindFirstChild("Close"),
			W0.FindFirstChild("Title"),
			...[0, 1, 2, 3, 4, 5].map(i => tabBtn(i)),
			page(cat),
			details(),
		].map(rectOf);
		const where = `${vw}x${vh} ${TABS[cat]}`;
		check(
			`${where}: cabecalho, abas, grade e painel sem sobreposicao`,
			pairwise(blocks).length === 0,
			pairwise(blocks).join(", "),
		);
		check(
			`${where}: tudo dentro da janela`,
			blocks.every(b => within(b, winRect)),
			blocks
				.filter(b => !within(b, winRect))
				.map(b => b.n)
				.join(", "),
		);
		const D = details();
		const inPanel = ["Title", "State", "IconBed", "Stats", "Lower", "Action"]
			.map(n => D.FindFirstChild(n))
			.filter(g => g !== undefined && g.Visible)
			.map(rectOf);
		check(
			`${where}: o painel (titulo, tecla, icone, stats, notas, botao) sem sobreposicao`,
			pairwise(inPanel).length === 0,
			pairwise(inPanel).join(", "),
		);
		check(
			`${where}: e dentro do painel`,
			inPanel.every(b => within(b, rectOf(D))),
			inPanel
				.filter(b => !within(b, rectOf(D)))
				.map(b => b.n)
				.join(", "),
		);
		const cells = cellsOf(cat, true).map(rectOf);
		const groove = rectOf(deep(page(cat), "Groove"));
		check(
			`${where}: os ladrilhos nao se sobrepoem`,
			pairwise(cells).length === 0,
			pairwise(cells).slice(0, 4).join(", "),
		);
		check(
			`${where}: e ficam dentro do sulco, na largura`,
			cells.every(c => c.x >= groove.x - 0.5 && c.x + c.w <= groove.x + groove.w + 0.5),
		);
		const glyphsIn = [0, 1, 2, 3, 4, 5].every(i =>
			within(rectOf(tabBtn(i).FindFirstChild("Glyph")), rectOf(tabBtn(i))),
		);
		check(`${where}: o glifo de cada aba fica dentro da aba`, glyphsIn);
		if (cat === 0) {
			const tile = cells[0];
			const min = touch ? 44 : 0;
			check(
				`${where}: um ladrilho tem ${px(tile.w)} x ${px(tile.h)} px${touch ? " (MIN_TOUCH_PX = 44 no toque)" : ""}`,
				tile.w >= min && tile.h >= min && Math.abs(tile.w - tile.h) <= 1.5,
			);
			const icon = rectOf(tilesOf(0)[0].FindFirstChild("ItemIcon"));
			const runs = tilesOf(0)[0]
				.FindFirstChild("ItemIcon")
				.GetChildren()
				.filter(f => f.Visible);
			const snapped = runs.every(
				f =>
					f.Position.X.Scale === 0 &&
					Number.isInteger(f.Position.X.Offset) &&
					Number.isInteger(f.Size.X.Offset),
			);
			check(
				`${where}: o icone (${px(icon.w)} px) cai em pixels inteiros da tela`,
				runs.length > 0 && snapped,
				`${runs.length} Frames`,
			);
		}
	}
}
uis.TouchEnabled = false;
uis.MouseEnabled = true;
uis.GetLastInputType = () => Enum.UserInputType.MouseMovement;
service("Workspace").CurrentCamera.ViewportSize = new Vector2(1920, 1080);
flush();
pack.close();

// ---------------------------------------------------------------- report

console.log("\nPasso                                              criadas  destruidas  escritas  (toast)");
for (const x of table) {
	console.log(
		`${x.label.padEnd(50)} ${String(x.bagNew).padStart(7)} ${String(x.bagGone).padStart(11)} ${String(x.writes).padStart(9)}  ${x.toastNew > 0 ? `(${x.toastNew})` : ""}`,
	);
}
const sum = (list, k) => list.reduce((s, x) => s + x[k], 0);
console.log(`\nprimeira visita das abas: ${sum(firstVisit, "bagNew")} criadas`);
console.log(`Instances vivas no Bag no fim da caminhada: ${alive}`);
console.log(`pagina cheia de armas (30): ${fmtCensus(fullWeapons)}`);
console.log(`pagina de Craft (80 receitas), 1a vista: ${fmtCensus(fullCraft)}`);
console.log(
	`icones: ${frameCounts.length}, media ${(frameCounts.reduce((s, [, c]) => s + c, 0) / frameCounts.length).toFixed(1)} Frames, maximo ${frameCounts[0][1]} (${frameCounts[0][0]})`,
);
console.log(`(escritas = propriedades escritas em Instances que ja existiam; toast = popup de aviso, fora do Bag)`);

console.log("");
if (failures > 0) {
	console.error(`${failures} verificacao(oes) falharam`);
	process.exit(1);
}
console.log(
	"OK: cada item tem o seu desenho, e depois de montada cada tela do Bag troca e atualiza sem criar nem destruir Instance",
);
