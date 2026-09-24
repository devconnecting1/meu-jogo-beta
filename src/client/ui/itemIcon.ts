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
 * Where the drawing sits in the square (IconFit): "cell" puts the whole 16 x 16 grid on it, as drawn; "drawn" moves
 * the same pixels by whole screen pixels so the box of what is DRAWN is centred -- the art is rarely centred in its
 * grid (the dagger is half a cell right and a cell and a half low), and an item shown in a tile belongs in its middle.
 * Every item view uses "drawn" (the hotbar, the Bag's tiles and panel, the item card, the Survivor loadout); a layout
 * that must know where those pixels land asks drawnRects (hudConsole.ts keeps the hotbar's icons off its key badge).
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
 *
 * The atlas: those same pixels are also one image, design/world-art/itemIcons.png (tools/icon-atlas.mjs, generated
 * and uploaded with the town's art; the cells in ./itemIconAtlas.ts). Once it has an asset id, a view is ONE
 * ImageLabel showing its icon's cell (ImageRectOffset / ImageRectSize, Pixelated), untinted for an icon, its dimmed
 * cell when dimmed, and tinted with the ink for a glyph (the glyph is white): the same picture on the same square,
 * for 1 Instance instead of 10-50 -- and a view built then never creates its reserve of Frames. With no id, or once
 * the atlas fails to load (client/view/worldArt.ts gives it up and every live view repaints), the Frames above draw
 * it exactly as before (npm run test:icons).
 */
import { ICON_ART, ICON_ART_ORDER } from "shared/engine/colors";
import { BADGE_ICONS } from "shared/data/badgeIcons";
import { ICON_GLYPHS, ITEM_ICONS, SKILL_KIND, iconKeys, iconOf } from "shared/data/itemIcons";
import { ItemKind } from "shared/data/kinds";
import { artId, onWorldArtChange } from "../view/worldArt";
import { ICON_ATLAS_CELLS } from "./itemIconAtlas";
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
	/** the drawn box: the cells that paint anything, [x0, y0, x1, y1) (the art is rarely centred in its grid) */
	box: [number, number, number, number];
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
	const box: [number, number, number, number] = [n, n, 0, 0];
	for (let i = 0; i < n * n; i++) {
		if (rank[i] < 0) continue;
		const x = i % n;
		const y = math.floor(i / n);
		box[0] = math.min(box[0], x);
		box[1] = math.min(box[1], y);
		box[2] = math.max(box[2], x + 1);
		box[3] = math.max(box[3], y + 1);
	}
	// an empty grid: the whole cell
	if (box[2] <= box[0]) {
		box[0] = 0;
		box[1] = 0;
		box[2] = n;
		box[3] = n;
	}
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
	return { n, runs, mono, box };
}

/**
 * The runs of icon or glyph `key` (undefined: no such key): an item icon, a UI glyph, or one of the pictures of what the
 * game counts (shared/data/badgeIcons.ts: the achievements' zombies and bosses, the coin sources) -- art like the items,
 * but not in the atlas, so always drawn with runs.
 */
function runsOf(key: string): Decomposed | undefined {
	let d = cache.get(key);
	if (d !== undefined) return d;
	const art = ITEM_ICONS[key] ?? BADGE_ICONS[key];
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

// ---------------------------------------------------------------- the drawn box

/** where cell edge `c` of an `n` grid lands in a `side` px square: the drawer's rounding (every run is placed so) */
function edge(c: number, n: number, side: number): number {
	return math.round((c * side) / n);
}

/**
 * The whole pixels that move the centre of `d`'s drawn box onto the centre of a `side` px square. Rounded half up
 * (floor of x + 0.5) rather than with math.round, so Luau and the Node suites agree on a negative half.
 */
function shiftOf(d: Decomposed, side: number): [number, number] {
	const [x0, y0, x1, y1] = d.box;
	const sx = math.floor((side - edge(x0, d.n, side) - edge(x1, d.n, side)) / 2 + 0.5);
	const sy = math.floor((side - edge(y0, d.n, side) - edge(y1, d.n, side)) / 2 + 0.5);
	return [sx, sy];
}

/** the drawn box of icon or glyph `key`, [x0, y0, x1, y1) in its own cells (undefined: no such key) */
export function drawnBox(key: string): [number, number, number, number] | undefined {
	const d = runsOf(key);
	return d === undefined ? undefined : [d.box[0], d.box[1], d.box[2], d.box[3]];
}

/**
 * What a view of fit "drawn" paints for `key` in a `side` px square: each run as [x0, y0, x1, y1) in the square's
 * pixels, with the drawer's rounding and its centring shift -- for a layout that must know where the drawing lands
 * (hudConsole.ts keeps the hotbar's icons clear of the key badge). Empty for an unknown key.
 */
export function drawnRects(key: string, side: number): Array<[number, number, number, number]> {
	const out: Array<[number, number, number, number]> = [];
	const d = runsOf(key);
	if (d === undefined || side <= 0) return out;
	const [sx, sy] = shiftOf(d, side);
	for (const r of d.runs) {
		out.push([
			sx + edge(r.x, d.n, side),
			sy + edge(r.y, d.n, side),
			sx + edge(r.x + r.w, d.n, side),
			sy + edge(r.y + r.h, d.n, side),
		]);
	}
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

// ---------------------------------------------------------------- the atlas

/** the atlas image in worldArtAssets.ts */
const ATLAS = "itemIcons";
const WHITE = new Color3(1, 1, 1);
/** no run is drawn (a view showing its icon from the atlas) */
const NO_RUNS: Array<Run> = [];

/** the rect Vector2s, made once per cell and shared by every view: a paint allocates nothing */
const cellOffsets = new Map<string, Vector2>();
const dimOffsets = new Map<string, Vector2>();
const cellSizes = new Map<number, Vector2>();

/** the corner of `key`'s cell (its dimmed copy when `dim`), or undefined when the atlas has no such cell */
function cellOffset(key: string, dim: boolean): Vector2 | undefined {
	const cache = dim ? dimOffsets : cellOffsets;
	let v = cache.get(key);
	if (v !== undefined) return v;
	const c = ICON_ATLAS_CELLS[key];
	if (c === undefined) return undefined;
	v = dim ? new Vector2(c[3], c[4]) : new Vector2(c[0], c[1]);
	cache.set(key, v);
	return v;
}

function cellSize(n: number): Vector2 {
	let v = cellSizes.get(n);
	if (v === undefined) {
		v = new Vector2(n, n);
		cellSizes.set(n, v);
	}
	return v;
}

// ---------------------------------------------------------------- the view

/**
 * How a drawing sits in its view's square:
 *  - "cell": its whole grid fills the square, as drawn in itemIcons.ts (the art sits where its grid puts it: the
 *    dagger's is half a cell right and a cell and a half low);
 *  - "drawn": the same pixels at the same size, moved by whole screen pixels so the box of what is drawn is centred
 *    in the square -- every item sits in the middle of its tile whatever the art's place in its grid (the hotbar,
 *    the Bag's tiles and panel, the item card, the Survivor loadout).
 */
export type IconFit = "cell" | "drawn";

export interface IconView {
	/** the transparent square the icon fills; its "Icon" attribute names what it draws ("" = nothing) */
	frame: Frame;
	/** the atlas image: ONE ImageLabel drawing the whole icon (undefined: the atlas has no id, runs draw it) */
	image: ImageLabel | undefined;
	/** what the image shows now (a redraw writes only what changed); geometry -1 = never placed */
	imageId: string;
	imageOffset: Vector2 | undefined;
	imageSize: Vector2 | undefined;
	imageTint: Color3;
	imagePx: number;
	imageOx: number;
	imageOy: number;
	imageFx: number;
	imageFy: number;
	/** how the drawing sits in the square (IconFit), and the shift "drawn" puts on it now: px, or Scale before the size */
	fit: IconFit;
	sx: number;
	sy: number;
	fx: number;
	fy: number;
	/** the runs a view falling back to Frames builds up front (the constructor's `reserve`) */
	reserve: number;
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
	const sig = `${r.x},${r.y},${r.w},${r.h},${n},${S},${view.ox + view.sx},${view.oy + view.sy},${view.fx},${view.fy}`;
	if (view.placed[i] === sig) return;
	view.placed[i] = sig;
	const f = view.runs[i];
	if (S > 0) {
		const x0 = edge(r.x, n, S);
		const x1 = edge(r.x + r.w, n, S);
		const y0 = edge(r.y, n, S);
		const y1 = edge(r.y + r.h, n, S);
		f.Position = UDim2.fromOffset(view.ox + view.sx + x0, view.oy + view.sy + y0);
		f.Size = UDim2.fromOffset(x1 - x0, y1 - y0);
	} else {
		f.Position = UDim2.fromScale(r.x / n + view.fx, r.y / n + view.fy);
		f.Size = UDim2.fromScale(r.w / n, r.h / n);
	}
}

/** the shift fit "drawn" puts on what the view draws now (none for "cell", or with nothing drawn) */
function reshift(view: IconView): void {
	let sx = 0;
	let sy = 0;
	let fx = 0;
	let fy = 0;
	const d = view.fit === "drawn" && view.key !== "" ? runsOf(view.key) : undefined;
	if (d !== undefined && view.px > 0) {
		[sx, sy] = shiftOf(d, view.px);
	} else if (d !== undefined) {
		fx = (d.n - d.box[0] - d.box[2]) / (2 * d.n);
		fy = (d.n - d.box[1] - d.box[3]) / (2 * d.n);
	}
	view.sx = sx;
	view.sy = sy;
	view.fx = fx;
	view.fy = fy;
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

/** the image on the square the runs fill (offsets once the size is known, else the whole view in Scale) */
function placeImage(view: IconView, img: ImageLabel): void {
	const S = view.px;
	const x = view.ox + view.sx;
	const y = view.oy + view.sy;
	if (
		S === view.imagePx &&
		x === view.imageOx &&
		y === view.imageOy &&
		view.fx === view.imageFx &&
		view.fy === view.imageFy
	) {
		return;
	}
	view.imagePx = S;
	view.imageOx = x;
	view.imageOy = y;
	view.imageFx = view.fx;
	view.imageFy = view.fy;
	if (S > 0) {
		img.Position = UDim2.fromOffset(x, y);
		img.Size = UDim2.fromOffset(S, S);
	} else {
		img.Position = UDim2.fromScale(view.fx, view.fy);
		img.Size = UDim2.fromScale(1, 1);
	}
}

function relayout(view: IconView): void {
	if (!measure(view)) return;
	reshift(view);
	for (let i = 0; i < view.current.size(); i++) place(view, i, view.current[i]);
	const img = view.image;
	if (img !== undefined && img.Visible) placeImage(view, img);
}

/** live views drawing from the atlas: repainted with Frames if it is given up (worldArt.ts), forgotten when destroyed */
const atlasViews = new Set<IconView>();

function newImage(view: IconView, id: string): void {
	const img = new Instance("ImageLabel");
	img.Name = "Atlas";
	img.BorderSizePixel = 0;
	img.BackgroundTransparency = 1;
	img.BackgroundColor3 = THEME.background;
	img.Active = false;
	img.Selectable = false;
	img.Image = id;
	img.ScaleType = Enum.ScaleType.Stretch;
	img.ResampleMode = Enum.ResamplerMode.Pixelated;
	img.ImageColor3 = WHITE;
	img.ImageTransparency = 0;
	img.Position = new UDim2();
	img.Size = UDim2.fromScale(1, 1);
	img.Visible = false;
	img.Parent = view.frame;
	view.image = img;
	view.imageId = id;
	view.imagePx = 0;
	view.imageOx = 0;
	view.imageOy = 0;
	view.imageFx = 0;
	view.imageFy = 0;
	atlasViews.add(view);
	view.frame.Destroying.Connect(() => atlasViews.delete(view));
}

/** the atlas is gone (or its id changed): each live view repaints -- with Frames, or from the new id */
function atlasChanged(): void {
	const id = artId(ATLAS);
	for (const view of atlasViews) {
		const img = view.image;
		if (img === undefined) continue;
		if (id !== undefined) {
			if (view.imageId !== id) {
				view.imageId = id;
				img.Image = id;
			}
			continue;
		}
		atlasViews.delete(view);
		view.image = undefined;
		img.Destroy();
		for (let i = view.runs.size(); i < view.reserve; i++) newRun(view);
		const key = view.key;
		if (key === "") continue;
		view.key = "";
		drawIcon(view, key, { dim: view.dim, ink: view.ink });
	}
}
onWorldArtChange(atlasChanged);

/**
 * A view `size` design units square at (x, y) in `parent`'s design space. `reserve` runs are built up front, hidden
 * (a view that must never create one later: the hotbar's tiles take the most any weapon icon needs) -- unless the
 * atlas is live: then the view is its one ImageLabel, and never needs a run. `fit` (IconFit): "drawn" centres what is
 * drawn in the square, "cell" (the default) keeps the art where its grid puts it.
 */
export function IconView(
	parent: Instance,
	name: string,
	x: number,
	y: number,
	size: number,
	zIndex: number,
	reserve = 0,
	fit: IconFit = "cell",
): IconView {
	const frame = makeFrame(parent, name, x, y, size, size, THEME.background, { transparency: 1, zIndex });
	frame.SetAttribute("Icon", "");
	const view: IconView = {
		frame,
		image: undefined,
		imageId: "",
		imageOffset: undefined,
		imageSize: undefined,
		imageTint: WHITE,
		imagePx: -1,
		imageOx: -1,
		imageOy: -1,
		imageFx: 0,
		imageFy: 0,
		fit,
		sx: 0,
		sy: 0,
		fx: 0,
		fy: 0,
		reserve,
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
	const id = artId(ATLAS);
	if (id !== undefined) newImage(view, id);
	else for (let i = 0; i < reserve; i++) newRun(view);
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
	reshift(view);
	const img = view.image;
	// a glyph's colour is its ink, dimmed or not: its one cell
	const offset = img !== undefined ? cellOffset(key, dim && !d.mono) : undefined;
	if (img !== undefined && offset !== undefined) {
		placeImage(view, img);
		if (view.imageOffset !== offset) {
			view.imageOffset = offset;
			img.ImageRectOffset = offset;
		}
		const size = cellSize(d.n);
		if (view.imageSize !== size) {
			view.imageSize = size;
			img.ImageRectSize = size;
		}
		const tint = ink ?? WHITE;
		if (view.imageTint !== tint) {
			view.imageTint = tint;
			img.ImageColor3 = tint;
		}
		if (!img.Visible) img.Visible = true;
		view.current = NO_RUNS;
		for (const f of view.runs) if (f.Visible) f.Visible = false;
		return;
	}
	// no atlas, or a key newer than it (npm run art:world): the runs
	if (img !== undefined && img.Visible) img.Visible = false;
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

/** hides every run and the image (the Instances are kept for the next icon) */
export function clearIcon(view: IconView): void {
	if (view.key === "") return;
	view.key = "";
	view.current = [];
	view.frame.SetAttribute("Icon", "");
	for (const f of view.runs) if (f.Visible) f.Visible = false;
	const img = view.image;
	if (img !== undefined && img.Visible) img.Visible = false;
}
