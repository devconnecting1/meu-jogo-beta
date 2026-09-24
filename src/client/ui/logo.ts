import { artId, artSize, onWorldArtChange } from "../view/worldArt";
import { motionTween, onLayoutChange, uiScale } from "./skin";
import { GAME, TEXT, THEME, hex } from "./theme";
import { fadeText, makeFrame, makeLabel, makeScreen } from "./widgets";

/*
 * The game's name, LAST TOWN (DESIGN_RULES UI-10): the lobby's title and the splash draw the same one.
 *
 * Two drawings of it. The PIXEL WORDMARK is the store art's (docs/promo/logo/last-town-wordmark.png: the bold pixel
 * font of tools/title-font.mjs, a one-pixel outline and a hard shadow), generated with the town's art as the texture
 * `wordmark` (tools/gen-world-art.mjs) and uploaded by CI with it: three greyscale cells stacked -- the ink, the fill
 * of LAST, the fill of TOWN -- each drawn by one ImageLabel tinted with a theme token (THEME.background, GAME.brand,
 * THEME.foreground), so its colours are the theme's (UI-01). It is art, like the item icons: the ink round the
 * letters is part of the picture, not a text outline (UI-04 is about text, and the text below has none).
 *
 * The FLAT WORDMARK is text: "LAST TOWN" in `foreground` with LAST in the brand colour, RichText, no stroke (UI-04),
 * which the scrim of the flyover holds at 4,5:1 (test:contrast). It is what shows while the texture has no id (before
 * CI uploads it), while its image has not loaded yet (ImageLabel.IsLoaded -- a moderated image never loads, so a
 * refused upload simply keeps the text), and once the world art is given up (client/view/worldArt.ts). So the name
 * is never a blank box.
 *
 * The pixel wordmark keeps every texel a WHOLE number of screen pixels (like client/ui/pixelIcon.ts): its size is
 * recomputed when the screen changes, as big as its box allows at up to its design size, never bigger than the box.
 * Built once per box, the first time the texture has an id; switching between the two drawings creates nothing.
 */

/** "LAST TOWN" with LAST in the brand colour: the flat wordmark, for RichText labels */
export const WORDMARK = `<font color="${hex(GAME.brand)}">LAST</font> TOWN`;

/** the texture of the pixel wordmark (design/world-art/wordmark.png) */
const ART = "wordmark";

/**
 * its cells, top to bottom: the layer's name and the theme token it is tinted with -- the ink, then the fill of each
 * word (never plain "Town": the lobby's Town section is found by that name)
 */
export const WORDMARK_LAYERS: ReadonlyArray<[string, Color3]> = [
	["Ink", THEME.background],
	["LastFill", GAME.brand],
	["TownFill", THEME.foreground],
];

/** texels of one cell of the texture: the whole wordmark, outline and shadow included */
export function wordmarkTexels(): { w: number; h: number } {
	const size = artSize(ART);
	return { w: size.w, h: size.h / WORDMARK_LAYERS.size() };
}

export interface WordmarkView {
	/** the box: a transparent Frame, placed in the parent's design space under the name the caller gave */
	readonly frame: Frame;
	/** the flat wordmark (text): shown unless the pixel wordmark has loaded */
	readonly text: TextLabel;
	/** true when the pixel wordmark is what shows */
	showsArt(): boolean;
	/** the whole name at `transparency` (0 = opaque), now */
	setTransparency(transparency: number): void;
	/** the whole name to `transparency` over `time` s, through the kit's fade (Reduce Motion: at once) */
	fade(time: number, transparency: number): void;
}

/** every wordmark on screen: a change of the world art (an override, the art given up) repaints them */
const live = new Set<Mark>();
onWorldArtChange(() => {
	for (const m of live) m.refresh();
});

class Mark implements WordmarkView {
	readonly frame: Frame;
	readonly text: TextLabel;
	/** the pixel wordmark's holder (undefined until the texture has an id) and its three layers */
	private art: Frame | undefined;
	private readonly layers: Array<ImageLabel> = [];
	private transparency = 0;
	private readonly w: number;
	private readonly h: number;
	private readonly align: "left" | "center";

	constructor(
		parent: Instance,
		name: string,
		box: [number, number, number, number],
		size: number,
		align: "left" | "center",
	) {
		const [x, y, w, h] = box;
		this.w = w;
		this.h = h;
		this.align = align;
		this.frame = makeFrame(parent, name, x, y, w, h, THEME.background, { transparency: 1 });
		this.text = makeLabel(this.frame, "Text", WORDMARK, 0, 0, w, h, size, THEME.foreground, {
			font: "display",
			align,
			rich: true,
		});
		live.add(this);
		this.frame.Destroying.Connect(() => live.delete(this));
		this.refresh();
	}

	showsArt(): boolean {
		return this.art !== undefined && this.art.Visible && !this.text.Visible;
	}

	setTransparency(transparency: number): void {
		this.transparency = transparency;
		this.text.TextTransparency = transparency;
		for (const l of this.layers) l.ImageTransparency = transparency;
	}

	fade(time: number, transparency: number): void {
		this.transparency = transparency;
		fadeText(this.text, time, transparency);
		for (const l of this.layers) motionTween(l, time, { ImageTransparency: transparency });
	}

	/** the drawing that fits the texture's state: the pixel wordmark once its image is in, the text otherwise */
	refresh(): void {
		const id = artId(ART);
		if (id === undefined) {
			if (this.art !== undefined) this.art.Visible = false;
			this.text.Visible = true;
			return;
		}
		const art = this.art ?? this.build();
		for (const l of this.layers) if (l.Image !== id) l.Image = id;
		art.Visible = true;
		// until every layer's image is in, the text stands in (an image still loading draws nothing)
		let loaded = true;
		for (const l of this.layers) if (l.IsLoaded !== true) loaded = false;
		this.text.Visible = !loaded;
	}

	private build(): Frame {
		const cell = wordmarkTexels();
		const art = new Instance("Frame");
		art.Name = "Art";
		art.BackgroundTransparency = 1;
		art.BackgroundColor3 = THEME.background;
		art.BorderSizePixel = 0;
		WORDMARK_LAYERS.forEach(([name, tint], i) => {
			const l = new Instance("ImageLabel");
			l.Name = name;
			l.BackgroundTransparency = 1;
			l.BackgroundColor3 = THEME.background;
			l.BorderSizePixel = 0;
			l.Size = UDim2.fromScale(1, 1);
			l.ScaleType = Enum.ScaleType.Stretch;
			l.ResampleMode = Enum.ResamplerMode.Pixelated;
			l.ImageRectOffset = new Vector2(0, cell.h * i);
			l.ImageRectSize = new Vector2(cell.w, cell.h);
			l.ImageColor3 = tint;
			l.ImageTransparency = this.transparency;
			// the ink under both fills (siblings: the higher ZIndex draws on top)
			l.ZIndex = i === 0 ? 1 : 2;
			l.GetPropertyChangedSignal("IsLoaded").Connect(() => this.refresh());
			l.Parent = art;
			this.layers.push(l);
		});
		// whole screen pixels per texel: up to the design size that fits the box, never over the box on screen
		const design = math.max(1, math.floor(math.min(this.h / cell.h, this.w / cell.w)));
		const ax = this.align === "center" ? 0.5 : 0;
		onLayoutChange(art, () => {
			const s = uiScale();
			const fit = math.floor(math.min((this.h * s) / cell.h, (this.w * s) / cell.w));
			const unit = math.max(1, math.min(math.round(design * s), fit));
			const pw = unit * cell.w;
			const ph = unit * cell.h;
			art.Size = UDim2.fromOffset(pw, ph);
			// whole-pixel offsets from the box's left (or centre) and its middle: no texel straddles two pixels
			art.Position = new UDim2(ax, -math.floor(ax * pw), 0.5, -math.floor(ph / 2));
		});
		art.Parent = this.frame;
		this.art = art;
		return art;
	}
}

/**
 * The game's name in the box (x, y, w, h) of the parent's design space: the pixel wordmark when its texture is in, the
 * flat one (display role, `size`) until then. The splash below and the lobby's title (DESIGN_RULES UI-10) draw it.
 */
export function Wordmark(
	parent: Instance,
	name: string,
	x: number,
	y: number,
	w: number,
	h: number,
	size: number,
	align: "left" | "center" = "left",
): WordmarkView {
	return new Mark(parent, name, [x, y, w, h], size, align);
}

/**
 * splash: the game's name on the base background, in `layer`, and "Zombie Survival" under it. The two lines fade in
 * through the kit's fade (skin.ts motionTween), so under Reduce Motion they are simply there.
 */
export function showLogo(layer: Instance, onDone: () => void): void {
	const { root, body } = makeScreen(layer, "Logo", { zIndex: 500 });

	const title = Wordmark(body, "LogoTitle", 60, 230, 1000, 110, 84, "center");
	title.setTransparency(1);

	const sub = makeLabel(body, "LogoSub", "Zombie Survival", 60, 350, 1000, 50, TEXT.xl2, THEME.mutedForeground, {
		font: "label",
		align: "center",
	});
	sub.TextTransparency = 1;

	title.fade(0.9, 0);
	task.delay(0.35, (): void => fadeText(sub, 0.9, 0));
	task.delay(1.5, (): void => {
		root.Destroy();
		onDone();
	});
}
