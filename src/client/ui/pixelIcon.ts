/*
 * Pixel icons of the menus (docs/DESIGN_RULES.md UI-10): 9 x 9 bitmaps drawn with Frames, no image asset, in the
 * same pixel language as the plates (plate.ts) and the padlock of the wardrobe tiles.
 *
 * An icon is a square holder whose side is a WHOLE number of screen pixels per bitmap pixel, recomputed when the
 * screen changes size (onLayoutChange), so every pixel of the icon lands on the screen's own pixel grid at any UI
 * scale -- crisp, never blurred between two columns. Each run of lit pixels in a row is one Frame; the heaviest
 * icon is 15 Frames, built once and afterwards only recoloured.
 *
 * Every Frame is painted with exactly one theme token passed by the caller (UI-01), normally the plate's light
 * label colour (UI-05).
 */
import { onLayoutChange, uiScale } from "./skin";
import { THEME } from "./theme";
import { designOf, setDesign } from "./widgets";

export type PixelIconKind =
	| "start"
	| "shop"
	| "wardrobe"
	| "trophy"
	| "records"
	| "help"
	| "settings"
	| "credits"
	| "sun"
	| "moon"
	| "people"
	| "grave";

/** bitmap side (pixels) */
const N = 9;

/** "#" = lit; every row is N characters */
const BITMAPS: Record<PixelIconKind, Array<string>> = {
	// a play triangle: the way into the game
	start: [
		"##.......",
		"####.....",
		"######...",
		"########.",
		"#########",
		"########.",
		"######...",
		"####.....",
		"##.......",
	],
	// a shopping bag with its handle
	shop: [
		"...###...",
		"..#...#..",
		"..#...#..",
		"#########",
		"#########",
		"#########",
		"#########",
		"#########",
		".#######.",
	],
	// a T-shirt: the wardrobe
	wardrobe: [
		"..##.##..",
		".#######.",
		"#########",
		"##.###.##",
		"..#####..",
		"..#####..",
		"..#####..",
		"..#####..",
		"..#####..",
	],
	// a cup with two handles on a stem and a base
	trophy: [
		"#########",
		"#.#####.#",
		"#.#####.#",
		".#######.",
		"..#####..",
		"...###...",
		"....#....",
		"..#####..",
		"..#####..",
	],
	// three bars rising to the right: the personal bests
	records: [
		".......##",
		".......##",
		"....##.##",
		"....##.##",
		".##.##.##",
		".##.##.##",
		".##.##.##",
		".##.##.##",
		"#########",
	],
	// a question mark
	help: [
		"..#####..",
		".##...##.",
		".##...##.",
		".....##..",
		"....##...",
		"....##...",
		".........",
		"....##...",
		"....##...",
	],
	// a cog: ring, hub and eight teeth
	settings: [
		"....#....",
		".#.###.#.",
		"..#####..",
		".##...##.",
		"###...###",
		".##...##.",
		"..#####..",
		".#.###.#.",
		"....#....",
	],
	// a five-point star
	credits: [
		"....#....",
		"....#....",
		"...###...",
		"#########",
		".#######.",
		"..#####..",
		"..##.##..",
		".##...##.",
		".#.....#.",
	],
	// the sun with its rays
	sun: [
		"....#....",
		".#.....#.",
		"...###...",
		"..#####..",
		"#.#####.#",
		"..#####..",
		"...###...",
		".#.....#.",
		"....#....",
	],
	// a crescent moon
	moon: [
		"...####..",
		"..##.....",
		".##......",
		".##......",
		".##......",
		".##......",
		".##......",
		"..##.....",
		"...####..",
	],
	// a survivor seen from the front: head and shoulders
	people: [
		"...###...",
		"...###...",
		"...###...",
		".........",
		".#######.",
		"#########",
		"#.#####.#",
		"..##.##..",
		"..##.##..",
	],
	// a gravestone with its cross: a town that fell
	grave: [
		"..#####..",
		".###.###.",
		".##...##.",
		".###.###.",
		".###.###.",
		".#######.",
		".#######.",
		".#######.",
		"#########",
	],
};

export interface PixelIcon {
	frame: Frame;
	setColor(color: Color3): void;
}

/**
 * Draws `kind` centred on (cx, cy) in the parent's design space, about `size` design units square (it snaps to the
 * nearest whole number of screen pixels per bitmap pixel, never below one).
 */
export function PixelIcon(
	parent: Instance,
	name: string,
	kind: PixelIconKind,
	cx: number,
	cy: number,
	size: number,
	color: Color3,
	zIndex?: number,
): PixelIcon {
	const [dw, dh] = designOf(parent);
	const holder = new Instance("Frame");
	holder.Name = name;
	holder.BackgroundTransparency = 1;
	holder.BackgroundColor3 = THEME.background;
	holder.BorderSizePixel = 0;
	holder.AnchorPoint = new Vector2(0.5, 0.5);
	holder.Position = UDim2.fromScale(cx / dw, cy / dh);
	setDesign(holder, size, size);
	if (zIndex !== undefined) holder.ZIndex = zIndex;
	const pixels: Array<Frame> = [];
	const rows = BITMAPS[kind];
	for (let y = 0; y < N; y++) {
		const row = rows[y];
		let x = 0;
		while (x < N) {
			if (row.sub(x + 1, x + 1) !== "#") {
				x++;
				continue;
			}
			let len = 1;
			while (x + len < N && row.sub(x + len + 1, x + len + 1) === "#") len++;
			const px = new Instance("Frame");
			px.Name = "Px";
			px.BorderSizePixel = 0;
			px.BackgroundColor3 = color;
			px.Position = UDim2.fromScale(x / N, y / N);
			px.Size = UDim2.fromScale(len / N, 1 / N);
			px.ZIndex = holder.ZIndex;
			px.Parent = holder;
			pixels.push(px);
			x += len;
		}
	}
	onLayoutChange(holder, () => {
		// whole screen pixels per bitmap pixel: the icon stays on the pixel grid at every UI scale
		const unit = math.max(1, math.round((size / N) * uiScale()));
		holder.Size = UDim2.fromOffset(unit * N, unit * N);
	});
	holder.Parent = parent;
	return {
		frame: holder,
		setColor(c: Color3): void {
			for (const px of pixels) if (px.BackgroundColor3 !== c) px.BackgroundColor3 = c;
		},
	};
}
