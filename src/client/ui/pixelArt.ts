/*
 * Small pixel pictures of the UI drawn with Frames, in THEME colours (docs/DESIGN_RULES.md UI-01, UI-10, MON-06,
 * UI-14): the round coin that stands for coins everywhere, and the medal of an unlocked achievement. Not item art --
 * those are shared/data/itemIcons.ts, drawn by client/ui/itemIcon.ts in their own art colours -- but interface marks,
 * each character of a bitmap one slot of a palette the caller fills with theme tokens.
 *
 * The same pixel rule as the menu icons (pixelIcon.ts): a picture is a square holder whose side is a WHOLE number of
 * screen pixels per bitmap pixel, recomputed when the screen changes size (onLayoutChange), so every pixel lands on the
 * screen's own grid at any UI scale. The Frames are few: the palette's colours are painted in order, and a Frame of one
 * colour may cover pixels a LATER colour paints over anyway (itemIcon.ts decompose, in small) -- the rim of the coin is
 * a handful of blocks under the whole disc, the face a few more, the shine two. Built once; afterwards a picture is only
 * recoloured (setPalette), never rebuilt.
 *
 * No import of widgets.ts on purpose: widgets.ts draws its coin with this module (CoinIcon), and a require cycle does
 * not load in Luau.
 */
import { DESIGN_H, DESIGN_W, onLayoutChange, uiScale } from "./skin";
import { GAME, THEME } from "./theme";

/** a bitmap: rows of equal length, "." empty, any other character a palette slot */
export type PixelBitmap = ReadonlyArray<string>;

/** one Frame of a picture, in the bitmap's own pixels */
interface Block {
	x: number;
	y: number;
	w: number;
	h: number;
	ch: string;
	layer: number;
}

/** the blocks of `rows`, painted in `order` (a colour's block may spill over pixels of a colour painted after it) */
function blocksOf(rows: PixelBitmap, order: string): Array<Block> {
	const n = rows.size();
	const w = n > 0 ? rows[0].size() : 0;
	const slot = new Map<string, number>();
	for (let i = 1; i <= order.size(); i++) slot.set(order.sub(i, i), i - 1);
	const rank: Array<number> = [];
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < w; x++) {
			const ch = rows[y].sub(x + 1, x + 1);
			// a character the order does not name is painted first, under everything
			rank.push(ch === "." ? -1 : (slot.get(ch) ?? 0));
		}
	}
	const out: Array<Block> = [];
	for (let L = 0; L < order.size(); L++) {
		const ch = order.sub(L + 1, L + 1);
		const covered: Array<boolean> = [];
		for (let i = 0; i < w * n; i++) covered.push(false);
		const needed = (i: number): boolean => rank[i] === L && !covered[i];
		const allowed = (i: number): boolean => rank[i] >= L;
		for (let y = 0; y < n; y++) {
			for (let x = 0; x < w; x++) {
				if (!needed(y * w + x)) continue;
				let x0 = x;
				while (x0 > 0 && allowed(y * w + x0 - 1)) x0 -= 1;
				let x1 = x;
				while (x1 < w - 1 && allowed(y * w + x1 + 1)) x1 += 1;
				// grow down while every pixel of the span may be painted and the row below still needs this colour
				let y1 = y;
				while (y1 + 1 < n) {
					let ok = true;
					let more = false;
					for (let i = x0; i <= x1; i++) {
						const k = (y1 + 1) * w + i;
						if (!allowed(k)) ok = false;
						else if (needed(k)) more = true;
					}
					if (!ok || !more) break;
					y1 += 1;
				}
				for (let yy = y; yy <= y1; yy++) {
					for (let i = x0; i <= x1; i++) if (rank[yy * w + i] === L) covered[yy * w + i] = true;
				}
				out.push({ x: x0, y, w: x1 - x0 + 1, h: y1 - y + 1, ch, layer: L });
			}
		}
	}
	return out;
}

const cache = new Map<string, Array<Block>>();

function cachedBlocks(key: string, rows: PixelBitmap, order: string): Array<Block> {
	let b = cache.get(key);
	if (b === undefined) {
		b = blocksOf(rows, order);
		cache.set(key, b);
	}
	return b;
}

export interface PixelArt {
	frame: Frame;
	/** recolours the picture (a coin going grey, a medal lighting up): only the Frames whose colour changes */
	setPalette(palette: Record<string, Color3>): void;
}

/** the design space (w, h) of `parent`: its DesignW / DesignH (the kit's), or the root 1120 x 630 */
function designSize(parent: Instance): [number, number] {
	if (parent.IsA("GuiObject")) {
		const dw = parent.GetAttribute("DesignW");
		const dh = parent.GetAttribute("DesignH");
		if (typeIs(dw, "number") && typeIs(dh, "number") && dw > 0 && dh > 0) return [dw, dh];
	}
	return [DESIGN_W, DESIGN_H];
}

/**
 * Draws bitmap `rows` (a `key` names it for the cache) centred on (cx, cy) in the parent's design space, about `size`
 * design units square, snapped to a whole number of screen pixels per bitmap pixel (never below one). `order` is the
 * painting order of the palette's characters, the darkest / widest first.
 */
export function PixelArt(
	parent: Instance,
	name: string,
	key: string,
	rows: PixelBitmap,
	order: string,
	palette: Record<string, Color3>,
	cx: number,
	cy: number,
	size: number,
	zIndex?: number,
): PixelArt {
	const [dw, dh] = designSize(parent);
	const n = rows.size();
	const holder = new Instance("Frame");
	holder.Name = name;
	holder.BackgroundTransparency = 1;
	holder.BackgroundColor3 = THEME.background;
	holder.BorderSizePixel = 0;
	holder.AnchorPoint = new Vector2(0.5, 0.5);
	holder.Position = UDim2.fromScale(cx / dw, cy / dh);
	holder.SetAttribute("DesignW", size);
	holder.SetAttribute("DesignH", size);
	if (zIndex !== undefined) holder.ZIndex = zIndex;
	const frames: Array<Frame> = [];
	const chars: Array<string> = [];
	for (const b of cachedBlocks(key, rows, order)) {
		const px = new Instance("Frame");
		px.Name = "Px";
		px.BorderSizePixel = 0;
		px.BackgroundColor3 = palette[b.ch] ?? THEME.foreground;
		px.Position = UDim2.fromScale(b.x / n, b.y / n);
		px.Size = UDim2.fromScale(b.w / n, b.h / n);
		px.ZIndex = holder.ZIndex + b.layer;
		px.Parent = holder;
		frames.push(px);
		chars.push(b.ch);
	}
	onLayoutChange(holder, () => {
		// whole screen pixels per bitmap pixel: the picture stays on the pixel grid at every UI scale
		// the nearest whole unit, but never more than a pixel past the box it was given (a coin in its pill)
		const box = size * uiScale();
		let unit = math.max(1, math.round(box / n));
		if (unit > 1 && unit * n > box + 1) unit -= 1;
		holder.Size = UDim2.fromOffset(unit * n, unit * n);
	});
	holder.Parent = parent;
	return {
		frame: holder,
		setPalette(p: Record<string, Color3>): void {
			for (let i = 0; i < frames.size(); i++) {
				const c = p[chars[i]];
				if (c !== undefined && frames[i].BackgroundColor3 !== c) frames[i].BackgroundColor3 = c;
			}
		},
	};
}

// ---------------------------------------------------------------- the coin (MON-06)

/**
 * The coin: a round copper disc seen from the front -- a dark rim, the coin colour, the light on its upper left, the
 * shade on its lower right and a slot stamped in its middle, as on a token -- so it reads as a COIN, never as money of
 * the real world: the old icon was a "$" on an orange chip, and a "$" is a dollar. Painted rim, face, shine.
 */
export const COIN_BITMAP: PixelBitmap = [
	"..rrrrr..",
	".rhhcccr.",
	"rhhcccccr",
	"rhccscccr",
	"rcccscccr",
	"rcccsccsr",
	"rccccccsr",
	".rcccssr.",
	"..rrrrr..",
];
export const COIN_ORDER = "rcsh";

/** the coin's colours (theme tokens: chart-3 and its two steps, MON-06) */
export function coinPalette(): Record<string, Color3> {
	return { r: GAME.coinShade, c: GAME.coin, s: GAME.coinShade, h: GAME.coinShine };
}

/** the pixel coin centred on (cx, cy), about `size` design units */
export function PixelCoin(
	parent: Instance,
	name: string,
	cx: number,
	cy: number,
	size: number,
	zIndex?: number,
): PixelArt {
	return PixelArt(parent, name, "coin", COIN_BITMAP, COIN_ORDER, coinPalette(), cx, cy, size, zIndex);
}

// ---------------------------------------------------------------- the medal (UI-14)

/**
 * The medal of an unlocked achievement: a gold disc with a check stamped on it, hung from a steel-blue ribbon (the
 * palette's one accent). Gold is the colour of what is unlocked and nothing else (the `medal` token); the check is
 * the page's near-black, so "done" reads by shape as well as by colour.
 */
export const MEDAL_BITMAP: PixelBitmap = [
	"..bb....bb..",
	"..bbb..bbb..",
	"...bbbbbb...",
	"...dddddd...",
	"..dwwggggd..",
	".dwggggggkd.",
	".dggggggkgd.",
	".dgggggkggd.",
	".dgkgggkggd.",
	".dggkgkgggd.",
	"..dggkgggd..",
	"...dddddd...",
];
export const MEDAL_ORDER = "bdgwk";

/** the medal's colours (theme tokens): the ribbon in the accent, the gold and its rim, the shine, the check */
export function medalPalette(): Record<string, Color3> {
	return { b: THEME.primary, d: GAME.medalShade, g: GAME.medal, w: THEME.foreground, k: THEME.background };
}

/** the medal centred on (cx, cy), about `size` design units */
export function PixelMedal(
	parent: Instance,
	name: string,
	cx: number,
	cy: number,
	size: number,
	zIndex?: number,
): PixelArt {
	return PixelArt(parent, name, "medal", MEDAL_BITMAP, MEDAL_ORDER, medalPalette(), cx, cy, size, zIndex);
}
