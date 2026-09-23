/*
 * Draws the pixel icons of shared/data/itemIcons.ts with Frames (docs/DESIGN_RULES.md UI-11). ONE drawer for every
 * place an item is shown -- the Bag's tiles and its details panel, the item card's header, the HUD hotbar -- so the
 * same item is the same picture everywhere:
 *
 *   const view = IconView(tile, "ItemIcon", 12, 12, 48, zIndex);
 *   drawItemIcon(view, ItemKind.Weapon, id);          // an item, by kind and id
 *   drawIcon(view, "skill_heart");                    // any icon or glyph by key
 *   drawIcon(view, "check", { ink: GAME.success });   // a one-colour glyph in a theme colour
 *
 * How a 16 x 16 grid becomes a few dozen Frames (decompose): the colours are painted one after the other in the
 * order of shared/engine/colors.ts ICON_ART_ORDER, and a Frame of one colour may cover pixels that a LATER colour
 * paints anyway. So the outline, painted first, is a handful of big rectangles under the whole silhouette; each colour
 * after it is its own few runs, a run growing down into a block wherever the rows below allow. Every icon costs
 * between 10 and 50 Frames (npm run test:backpack prints the list), against 256 for a Frame per pixel. The result is
 * computed once per icon and cached.
 *
 * A view is a POOL: drawing another icon rewrites the Frames it already has (position, size, colour, layer) and hides
 * the ones it does not need; only an icon with more runs than any the view has shown creates the difference. So a
 * tile of the Bag that goes back to an item it showed creates nothing (the Bag's zero-churn rule, test:backpack), and
 * a view built with `reserve` runs never creates one again (the HUD hotbar: UI-09 says update() never creates).
 *
 * Pixels land on whole screen pixels: once the view knows its size on screen, every run is placed in offsets whose
 * edges are the icon's pixel edges rounded to the screen grid (an integer multiple of the grid when that loses under
 * 15% of the size), so two runs never leave a hairline between them. Before that -- or in a Node test, which has no
 * layout -- runs are placed in Scale.
 *
 * Colours: an item icon is ART (ICON_ART, like the world's sprites); `dim` draws it in greys of the same lightness
 * (a recipe the station nearby cannot make, a skill not learned yet). A glyph is a UI mark and takes a THEME colour.
 */
import { ICON_ART, ICON_ART_ORDER } from "shared/engine/colors";
import { ICON_GLYPHS, ITEM_ICONS, SKILL_KIND, iconKeys, iconOf } from "shared/data/itemIcons";
import { ItemKind } from "shared/data/kinds";
import { THEME } from "./theme";
import { makeFrame } from "./widgets";

/** one Frame of an icon, in the icon's own pixels */
interface Run {
	x: number;
	y: number;
	w: number;
	h: number;
	/** the art colour's character ("#" for a glyph) */
	ch: string;
	/** painting order: the Frame's ZIndex inside the view */
	layer: number;
}

interface Decomposed {
	/** grid side (16 for an icon, 8 for a glyph) */
	n: number;
	runs: Array<Run>;
	mono: boolean;
}

/** position of each art colour in ICON_ART_ORDER */
const RANK = new Map<string, number>();
for (let i = 1; i <= ICON_ART_ORDER.size(); i++) RANK.set(ICON_ART_ORDER.sub(i, i), i - 1);

const cache = new Map<string, Decomposed>();

/** the widest [x0, x1] of cells in row `y` that `ok` accepts, through x */
function widest(ok: (i: number) => boolean, n: number, x: number, y: number): [number, number] {
	let x0 = x;
	while (x0 > 0 && ok(y * n + x0 - 1)) x0 -= 1;
	let x1 = x;
	while (x1 < n - 1 && ok(y * n + x1 + 1)) x1 += 1;
	return [x0, x1];
}

/**
 * The runs of a grid: colour by colour in painting order, each colour's pixels covered by rectangles that may spill
 * over the pixels of colours painted after it (never over an earlier colour's, never over an empty pixel). Greedy:
 * from each uncovered pixel, of two candidates -- the widest span the rule allows, or just the run of that colour --
 * the one that grows down over more uncovered pixels of its colour.
 */
function decompose(rows: Array<string>, mono: boolean): Decomposed {
	const n = rows.size();
	const rank: Array<number> = [];
	for (let y = 0; y < n; y++) {
		const row = rows[y];
		for (let x = 0; x < n; x++) {
			const ch = row.sub(x + 1, x + 1);
			rank.push(ch === "." ? -1 : mono ? 0 : (RANK.get(ch) ?? -1));
		}
	}
	const layers: Array<number> = [];
	for (const r of rank) if (r >= 0 && !layers.includes(r)) layers.push(r);
	layers.sort((a, b) => a < b);
	const runs: Array<Run> = [];
	for (let li = 0; li < layers.size(); li++) {
		const L = layers[li];
		const ch = mono ? "#" : ICON_ART_ORDER.sub(L + 1, L + 1);
		const covered: Array<boolean> = [];
		for (let i = 0; i < n * n; i++) covered.push(false);
		const needed = (i: number): boolean => rank[i] === L && !covered[i];
		const allowed = (i: number): boolean => rank[i] >= L;
		const mine = (i: number): boolean => rank[i] === L;
		/** how far down [x0, x1] grows from row y, and how many needed pixels it covers */
		const grow = (x0: number, x1: number, y: number): [number, number] => {
			let gain = 0;
			for (let i = x0; i <= x1; i++) if (needed(y * n + i)) gain += 1;
			let y1 = y;
			while (y1 + 1 < n) {
				const ny = y1 + 1;
				let ok = true;
				let more = 0;
				for (let i = x0; i <= x1; i++) {
					if (!allowed(ny * n + i)) ok = false;
					else if (needed(ny * n + i)) more += 1;
				}
				if (!ok || more === 0) break;
				gain += more;
				y1 = ny;
			}
			return [y1, gain];
		};
		for (let y = 0; y < n; y++) {
			for (let x = 0; x < n; x++) {
				if (!needed(y * n + x)) continue;
				const [a0, a1] = widest(allowed, n, x, y);
				const [, b1] = widest(mine, n, x, y);
				const [ay1, again] = grow(a0, a1, y);
				const [by1, bgain] = grow(x, b1, y);
				const wide = again >= bgain;
				const x0 = wide ? a0 : x;
				const x1 = wide ? a1 : b1;
				const y1 = wide ? ay1 : by1;
				for (let yy = y; yy <= y1; yy++) {
					for (let i = x0; i <= x1; i++) if (mine(yy * n + i)) covered[yy * n + i] = true;
				}
				runs.push({ x: x0, y, w: x1 - x0 + 1, h: y1 - y + 1, ch, layer: li + 1 });
			}
		}
	}
	return { n, runs, mono };
}

/** the runs of icon or glyph `key` (undefined: no such key) */
function runsOf(key: string): Decomposed | undefined {
	let d = cache.get(key);
	if (d !== undefined) return d;
	const art = ITEM_ICONS[key];
	const glyph = art === undefined ? ICON_GLYPHS[key] : undefined;
	if (art === undefined && glyph === undefined) return undefined;
	d = decompose((art ?? glyph) as Array<string>, art === undefined);
	cache.set(key, d);
	return d;
}

/** how many Frames icon or glyph `key` costs (0: no such key) */
export function iconFrameCount(key: string): number {
	return runsOf(key)?.runs.size() ?? 0;
}

/** the most Frames any of `keys` costs: the reserve of a view that will show any of them */
export function maxFrameCount(keys: Array<string>): number {
	let most = 0;
	for (const k of keys) most = math.max(most, iconFrameCount(k));
	return most;
}

let mostItemFrames = -1;

/** the most Frames any item or skill icon costs: the reserve of a view that shows whichever is selected */
export function maxItemFrames(): number {
	if (mostItemFrames >= 0) return mostItemFrames;
	let most = 0;
	for (const kind of [ItemKind.Weapon, ItemKind.Equip, ItemKind.Use, ItemKind.Etc, SKILL_KIND]) {
		most = math.max(most, maxFrameCount(iconKeys(kind)));
	}
	mostItemFrames = most;
	return most;
}

/** the runs of `key` as plain data (tests: the decomposition must repaint the grid exactly) */
export function iconRuns(key: string): Array<[number, number, number, number, string]> {
	const out: Array<[number, number, number, number, string]> = [];
	for (const r of runsOf(key)?.runs ?? []) out.push([r.x, r.y, r.w, r.h, r.ch]);
	return out;
}

// ---------------------------------------------------------------- colours

const dimmed = new Map<string, Color3>();

/**
 * An art colour in grey, compressed towards the middle: the icon of something not available now. The outline stays
 * darker than the dark-iron tile it sits on and the lightest colour stays well under white, so the shape still reads
 * and the tile plainly says "not now".
 */
function dimOf(ch: string): Color3 {
	let c = dimmed.get(ch);
	if (c !== undefined) return c;
	const art = ICON_ART[ch] ?? THEME.mutedForeground;
	const lum = art.R * 0.3 + art.G * 0.59 + art.B * 0.11;
	const g = math.clamp(lum * 0.6 + 0.12, 0, 1);
	c = new Color3(g, g, g);
	dimmed.set(ch, c);
	return c;
}

// ---------------------------------------------------------------- the view

export interface IconView {
	/** the transparent square the icon fills; its "Icon" attribute names what it draws ("" = nothing) */
	frame: Frame;
	/** the pooled runs, and what each one shows now (a redraw writes only what changed) */
	runs: Array<Frame>;
	/** per run: the geometry it was placed with ("" = never), its colour and layer */
	placed: Array<string>;
	colors: Array<Color3>;
	layers: Array<number>;
	/** what is drawn: the key, dimmed or not, the ink of a glyph */
	key: string;
	dim: boolean;
	ink: Color3 | undefined;
	/** the grid side of what is drawn, and the square's side / offset in screen pixels (0 = not known: Scale) */
	n: number;
	px: number;
	ox: number;
	oy: number;
	/** the runs of what is drawn */
	current: Array<Run>;
}

function newRun(view: IconView): Frame {
	const f = new Instance("Frame");
	f.Name = "Px";
	f.BorderSizePixel = 0;
	f.BackgroundTransparency = 0;
	f.BackgroundColor3 = THEME.background;
	f.Active = false;
	f.Selectable = false;
	f.Visible = false;
	f.Parent = view.frame;
	view.runs.push(f);
	view.placed.push("");
	// the cache holds what the Frame really shows: its colour at creation
	view.colors.push(f.BackgroundColor3);
	view.layers.push(-1);
	return f;
}

/** places run `i` of the view as `r` (offsets on the screen grid when the size is known, else Scale) */
function place(view: IconView, i: number, r: Run): void {
	const n = view.n;
	const S = view.px;
	const sig = `${r.x},${r.y},${r.w},${r.h},${n},${S},${view.ox},${view.oy}`;
	if (view.placed[i] === sig) return;
	view.placed[i] = sig;
	const f = view.runs[i];
	if (S > 0) {
		const x0 = math.round((r.x * S) / n);
		const x1 = math.round(((r.x + r.w) * S) / n);
		const y0 = math.round((r.y * S) / n);
		const y1 = math.round(((r.y + r.h) * S) / n);
		f.Position = UDim2.fromOffset(view.ox + x0, view.oy + y0);
		f.Size = UDim2.fromOffset(x1 - x0, y1 - y0);
	} else {
		f.Position = UDim2.fromScale(r.x / n, r.y / n);
		f.Size = UDim2.fromScale(r.w / n, r.h / n);
	}
}

/** the square's pixel size and offset from the view's size on screen (grid-snapped when it loses little) */
function measure(view: IconView): boolean {
	const abs = view.frame.AbsoluteSize;
	const side = math.floor(math.min(abs.X, abs.Y));
	let S = 0;
	if (side > 0 && view.n > 0) {
		const whole = math.floor(side / view.n) * view.n;
		S = whole > 0 && whole >= side * 0.85 ? whole : side;
	}
	const ox = S > 0 ? math.floor((abs.X - S) / 2) : 0;
	const oy = S > 0 ? math.floor((abs.Y - S) / 2) : 0;
	if (S === view.px && ox === view.ox && oy === view.oy) return false;
	view.px = S;
	view.ox = ox;
	view.oy = oy;
	return true;
}

function relayout(view: IconView): void {
	if (!measure(view)) return;
	for (let i = 0; i < view.current.size(); i++) place(view, i, view.current[i]);
}

/**
 * A view `size` design units square at (x, y) in `parent`'s design space. `reserve` runs are built up front, hidden
 * (a view that must never create one later: the hotbar's tiles take the most any weapon icon needs).
 */
export function IconView(
	parent: Instance,
	name: string,
	x: number,
	y: number,
	size: number,
	zIndex: number,
	reserve = 0,
): IconView {
	const frame = makeFrame(parent, name, x, y, size, size, THEME.background, { transparency: 1, zIndex });
	frame.SetAttribute("Icon", "");
	const view: IconView = {
		frame,
		runs: [],
		placed: [],
		colors: [],
		layers: [],
		key: "",
		dim: false,
		ink: undefined,
		n: 16,
		px: 0,
		ox: 0,
		oy: 0,
		current: [],
	};
	for (let i = 0; i < reserve; i++) newRun(view);
	frame.GetPropertyChangedSignal("AbsoluteSize").Connect(() => relayout(view));
	measure(view);
	return view;
}

export interface DrawOpts {
	/** grey, a little over half the lightness: not available now (default false) */
	dim?: boolean;
	/** the colour of a glyph (default THEME.foreground); ignored by an art icon */
	ink?: Color3;
}

/** draws icon or glyph `key` in `view`, rewriting its runs in place; an unknown key clears the view */
export function drawIcon(view: IconView, key: string, opts?: DrawOpts): void {
	const d = runsOf(key);
	const dim = opts?.dim === true;
	const ink = d?.mono === true ? (opts?.ink ?? THEME.foreground) : undefined;
	if (d === undefined) {
		clearIcon(view);
		return;
	}
	if (key === view.key && dim === view.dim && ink === view.ink) return;
	if (key !== view.key) view.frame.SetAttribute("Icon", key);
	if (dim !== view.dim) view.frame.SetAttribute("Dim", dim);
	view.key = key;
	view.dim = dim;
	view.ink = ink;
	if (d.n !== view.n) {
		view.n = d.n;
		view.px = 0;
		measure(view);
	}
	view.current = d.runs;
	for (let i = 0; i < d.runs.size(); i++) {
		const r = d.runs[i];
		const f = view.runs[i] ?? newRun(view);
		place(view, i, r);
		const c = ink ?? (dim ? dimOf(r.ch) : (ICON_ART[r.ch] ?? THEME.foreground));
		if (view.colors[i] !== c) {
			view.colors[i] = c;
			f.BackgroundColor3 = c;
		}
		if (view.layers[i] !== r.layer) {
			view.layers[i] = r.layer;
			f.ZIndex = r.layer;
		}
		if (!f.Visible) f.Visible = true;
	}
	for (let i = d.runs.size(); i < view.runs.size(); i++) {
		const f = view.runs[i];
		if (f.Visible) f.Visible = false;
	}
}

/** draws the icon of item `kind` / `id` (shared/data/itemIcons.ts iconOf: its own, or its category's) */
export function drawItemIcon(view: IconView, kind: number, id: number, dim = false): void {
	drawIcon(view, iconOf(kind, id).key, { dim });
}

/** hides every run (the Frames are kept for the next icon) */
export function clearIcon(view: IconView): void {
	if (view.key === "") return;
	view.key = "";
	view.current = [];
	view.frame.SetAttribute("Icon", "");
	for (const f of view.runs) if (f.Visible) f.Visible = false;
}
