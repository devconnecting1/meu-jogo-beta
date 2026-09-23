/*
 * Project Z window kit: the pieces of the reference's windows (docs/DESIGN_RULES.md UI-07), for the screens to
 * compose. The plates they stand on are plate.ts; the base kit (Button, Card, Tabs, Slider, Keycap...) is
 * widgets.ts. Every colour is a theme role (theme.ts SURFACE / THEME), every text is light and has no contour
 * (UI-04 / UI-05).
 *
 *   Window        a panel with the dark header band, the big centred title, an optional "?" at the left and the
 *                 red "X" in relief at the right
 *   Section       the lighter notched plate inside a window that holds one group ("Keybinds"), bold title at left
 *   Groove        the dark notched bed inside a section that rows and tiles sit in
 *   SettingsList  a scrolling Groove of rows; the gaps between the rows are the grooves
 *   SettingRow    one row: bold label centred in a darker cell at the left, the value in a lighter cell at right
 *   ValueKey      the value as a key: a dark-iron plate with a light legend that grows to fit it
 *   SettingNote   a muted caption line in the list
 *   GridTile      a square tile of a grid (the wardrobe): flat, equipped, locked (padlock + price), selected (blue)
 *
 * Separate from widgets.ts on purpose: that module is close to Luau's 200-locals-per-chunk budget
 * (npm run check:registers), and these pieces are compositions of it, not primitives.
 */
import { SURFACE, TEXT, THEME, fontOf, space } from "./theme";
import { PlateState, drawPadlock, paintPlate, paintSegment, reliefPx } from "./plate";
import {
	Button,
	CARD_STRIP_INSET,
	Card,
	CardHeader,
	CoinIcon,
	Keycap,
	ScrollList,
	cardStripHeight,
	designOf,
	fmtInt,
	isFocused,
	makeFrame,
	makeLabel,
	makeScrollList,
	onLayoutChange,
	registerFocus,
	setDesign,
	sizeRow,
} from "./widgets";

const BOLD = fontOf("sans", Enum.FontWeight.Bold);

// ---------------------------------------------------------------- Window

export interface WindowProps {
	x: number;
	y: number;
	w: number;
	h: number;
	title: string;
	/** title design size (default TEXT.xl3, the reference's big title) */
	titleSize?: number;
	/** muted line under the header (optional) */
	description?: string;
	/** the red "X" in relief at the right of the header; omitted = no X */
	onClose?: () => void;
	/** the "?" at the left of the header (optional per screen); omitted = no "?" */
	onHelp?: () => void;
	/** inner padding used by the Card* helpers (default space(6)) */
	pad?: number;
	zIndex?: number;
}

export interface WindowHandle {
	/** the window (a Card): place content in its w x h design space, from `contentY` down */
	frame: Frame;
	contentY: number;
	close?: TextButton;
	help?: TextButton;
}

/** side of the header's square buttons ("?", "X") for a title of `titleSize` */
function headerButton(titleSize: number): number {
	return cardStripHeight(titleSize) - space(3);
}

/**
 * The reference's modal window: the thick framed panel of the skin, a header band one shade darker than the body
 * with the title big, Bold and centred, the "?" (help) at its left and the red "X" in relief at its right.
 */
export function Window(parent: Instance, name: string, props: WindowProps): WindowHandle {
	const titleSize = props.titleSize ?? TEXT.xl3;
	const card = Card(parent, name, {
		x: props.x,
		y: props.y,
		w: props.w,
		h: props.h,
		// graphite, lighter than the page and the panels: the window stands off what is behind it
		fill: SURFACE.window,
		pad: props.pad,
		zIndex: props.zIndex,
	});
	const side = headerButton(titleSize);
	const stripH = cardStripHeight(titleSize);
	const btnY = CARD_STRIP_INSET + (stripH - side) / 2;
	const margin = CARD_STRIP_INSET + space(1.5);
	const hasButtons = props.onClose !== undefined || props.onHelp !== undefined;
	const contentY = CardHeader(card, props.title, props.description, {
		titleSize,
		// both sides reserve the same room, so the title stays centred on the window
		action: hasButtons ? margin + side + space(2) : 0,
	});
	const handle: WindowHandle = { frame: card, contentY };
	if (props.onClose !== undefined) {
		const onClose = props.onClose;
		handle.close = Button(card, "Close", "X", {
			x: props.w - margin - side,
			y: btnY,
			w: side,
			h: side,
			size: "icon",
			variant: "destructive",
			textSize: TEXT.xl,
			font: BOLD,
			zIndex: card.ZIndex + 3,
			onClick: (): void => onClose(),
		});
	}
	if (props.onHelp !== undefined) {
		handle.help = HelpButton(card, "Help", margin, btnY, side, props.onHelp, card.ZIndex + 3);
	}
	return handle;
}

/**
 * The header's "?": a quiet outlined square (not a plate -- help is never the main thing on a window), the ring in
 * `line` and the glyph in `muted-foreground` (5,6:1 on the header), both brightening on hover / focus.
 */
export function HelpButton(
	parent: Instance,
	name: string,
	x: number,
	y: number,
	side: number,
	onClick: () => void,
	zIndex?: number,
): TextButton {
	const [dw, dh] = designOf(parent);
	const b = new Instance("TextButton");
	b.Name = name;
	b.Position = UDim2.fromScale(x / dw, y / dh);
	b.Size = UDim2.fromScale(side / dw, side / dh);
	setDesign(b, side, side);
	b.AutoButtonColor = false;
	b.BorderSizePixel = 0;
	b.BackgroundTransparency = 1;
	b.BackgroundColor3 = THEME.background;
	b.Text = "";
	b.TextColor3 = THEME.foreground;
	if (zIndex !== undefined) b.ZIndex = zIndex;
	// the ring: a notched plate in the ring colour with the header's colour inset over it, 2 design units thick
	const hole = makeFrame(b, "Hole", 0, 0, side, side, THEME.background, { transparency: 1 });
	onLayoutChange(hole, () => {
		const t = reliefPx(2);
		hole.Position = new UDim2(0, t, 0, t);
		hole.Size = new UDim2(1, -2 * t, 1, -2 * t);
	});
	const glyph = makeLabel(b, "Glyph", "?", 0, 0, side, side, side * 0.55, THEME.mutedForeground, {
		font: BOLD,
		zIndex: b.ZIndex + 1,
	});
	const refresh = (): void => {
		const hot = isFocused(b) || b.GuiState === Enum.GuiState.Hover || b.GuiState === Enum.GuiState.Press;
		paintPlate(b, hot ? THEME.border : SURFACE.line, "flat", 2);
		paintPlate(hole, SURFACE.header, "flat", 1);
		glyph.TextColor3 = hot ? THEME.foreground : THEME.mutedForeground;
	};
	registerFocus(b, refresh);
	b.GetPropertyChangedSignal("GuiState").Connect(refresh);
	b.Activated.Connect(() => onClick());
	refresh();
	b.Parent = parent;
	return b;
}

// ---------------------------------------------------------------- Section

export interface SectionProps {
	x: number;
	y: number;
	w: number;
	h: number;
	/** bold title at the top left ("Keybinds"); omitted = no title */
	title?: string;
	zIndex?: number;
}

export interface SectionHandle {
	frame: Frame;
	title?: TextLabel;
	/** y (section design units) where the content starts, under the title */
	contentY: number;
}

const SECTION_TITLE_Y = space(3);
const SECTION_TITLE_H = 32;
/** where a titled section's content starts (section design units) */
export const SECTION_CONTENT_Y = SECTION_TITLE_Y + SECTION_TITLE_H + space(2);
/** the vertical middle of a section's title line (a control beside the title centres on it) */
export const SECTION_TITLE_MID = SECTION_TITLE_Y + SECTION_TITLE_H / 2;
/** the section's margin under its list */
const SECTION_BOTTOM = space(4);

/** height of a titled section that holds a list of `listH` (so a short list does not leave an empty plate) */
export function sectionHeight(listH: number): number {
	return SECTION_CONTENT_Y + listH + SECTION_BOTTOM;
}

/** the section plate of a window: lighter than the body (`SURFACE.section`), notched, with a bold title at left */
export function Section(parent: Instance, name: string, props: SectionProps): SectionHandle {
	const f = makeFrame(parent, name, props.x, props.y, props.w, props.h, SURFACE.section, {
		transparency: 1,
		zIndex: props.zIndex,
	});
	paintPlate(f, SURFACE.section, "flat", 4);
	const handle: SectionHandle = { frame: f, contentY: space(4) };
	if (props.title !== undefined) {
		handle.title = makeLabel(
			f,
			"Title",
			props.title,
			space(5),
			SECTION_TITLE_Y,
			props.w - space(10),
			SECTION_TITLE_H,
			TEXT.xl2,
			THEME.foreground,
			{ font: BOLD, align: "left", zIndex: f.ZIndex + 1 },
		);
		handle.contentY = SECTION_CONTENT_Y;
	}
	return handle;
}

// ---------------------------------------------------------------- SettingsList / SettingRow

/** padding inside the list, around the rows (design units) */
const LIST_PAD = 8;
/** the groove between two rows (design units) */
const GROOVE = 4;

/**
 * The dark notched bed (`SURFACE.groove`) that rows and tiles sit in, inside a section: what makes a row's cells or
 * a grid's tiles read as separate plates -- the gaps between them are this colour.
 */
export function Groove(parent: Instance, name: string, x: number, y: number, w: number, h: number): Frame {
	const groove = makeFrame(parent, name, x, y, w, h, SURFACE.groove, { transparency: 1 });
	paintPlate(groove, SURFACE.groove, "flat", 2);
	return groove;
}

/** height a SettingsList needs to show items of these heights (rows, notes) without scrolling */
export function settingsListHeight(items: Array<number>): number {
	let h = LIST_PAD * 2 + GROOVE * math.max(items.size() - 1, 0);
	for (const item of items) h += item;
	return h;
}

/**
 * The dark list of a section (`SURFACE.groove`): a notched plate holding a scrolling column of rows, whose gaps are
 * the grooves between them. The scroll bar is the kit's thin light one, and only shows when the rows overflow.
 */
export function SettingsList(parent: Instance, name: string, x: number, y: number, w: number, h: number): ScrollList {
	const groove = Groove(parent, name, x, y, w, h);
	const list = makeScrollList(groove, "List", 0, 0, w, h, { zIndex: groove.ZIndex + 1 });
	const pad = list.frame.FindFirstChildOfClass("UIPadding");
	onLayoutChange(list.frame, () => {
		const p = reliefPx(LIST_PAD);
		list.layout.Padding = new UDim(0, reliefPx(GROOVE));
		if (pad !== undefined) {
			pad.PaddingLeft = new UDim(0, p);
			pad.PaddingRight = new UDim(0, p);
			pad.PaddingTop = new UDim(0, p);
			pad.PaddingBottom = new UDim(0, p);
		}
	});
	return list;
}

export interface SettingRowOpts {
	/** label cell width (design units of the list, default 220) */
	labelW?: number;
	/** row height (default 38, the reference's) */
	rowH?: number;
}

export interface SettingRowHandle {
	frame: Frame;
	label: TextLabel;
	/** the value cell: its own design space (list width - labelW) x rowH, for the control / key / text */
	value: Frame;
}

export const SETTING_ROW_H = 38;

/**
 * One settings row, ONE notched shape in two tones (plate.ts paintSegment): the label Bold and centred in the
 * darker cell at the left (`SURFACE.cellLabel`), the value in the lighter cell at the right (`SURFACE.cell`).
 */
export function SettingRow(
	list: ScrollList,
	name: string,
	order: number,
	label: string,
	opts?: SettingRowOpts,
): SettingRowHandle {
	const rowH = opts?.rowH ?? SETTING_ROW_H;
	const labelW = opts?.labelW ?? 220;
	const w = list.designW;
	const row = new Instance("Frame");
	row.Name = name;
	row.BackgroundTransparency = 1;
	row.BackgroundColor3 = THEME.background;
	row.BorderSizePixel = 0;
	row.LayoutOrder = order;
	setDesign(row, w, rowH);
	sizeRow(list, row, rowH);
	const split = labelW / w;
	paintSegment(row, "Label", SURFACE.cellLabel, 0, split, 3);
	paintSegment(row, "Value", SURFACE.cell, split, 1, 3);
	const text = makeLabel(row, "Label", label, space(2), 0, labelW - space(4), rowH, TEXT.lg, THEME.foreground, {
		font: BOLD,
		zIndex: row.ZIndex + 1,
	});
	const value = makeFrame(row, "Value", labelW, 0, w - labelW, rowH, THEME.background, {
		transparency: 1,
		zIndex: row.ZIndex + 1,
	});
	row.Parent = list.frame;
	return { frame: row, label: text, value };
}

export interface SettingCellProps {
	x: number;
	y: number;
	w: number;
	/** default SETTING_ROW_H */
	h?: number;
	/** label cell width (design units of the row) */
	labelW: number;
	label: string;
	zIndex?: number;
}

/**
 * The settings row's shape (label cell | value cell, ONE notched shape in two tones) placed at x, y in any frame
 * instead of stacked in a SettingsList: for a few fixed rows laid out side by side on a Groove (the Survivor
 * screen's stats, two to a line). Same tones, same Bold centred label, same value design space.
 */
export function SettingCell(parent: Instance, name: string, props: SettingCellProps): SettingRowHandle {
	const h = props.h ?? SETTING_ROW_H;
	const { w, labelW } = props;
	const row = makeFrame(parent, name, props.x, props.y, w, h, THEME.background, {
		transparency: 1,
		zIndex: props.zIndex,
	});
	const split = labelW / w;
	paintSegment(row, "Label", SURFACE.cellLabel, 0, split, 3);
	paintSegment(row, "Value", SURFACE.cell, split, 1, 3);
	const text = makeLabel(row, "Label", props.label, space(2), 0, labelW - space(4), h, TEXT.lg, THEME.foreground, {
		font: BOLD,
		zIndex: row.ZIndex + 1,
	});
	const value = makeFrame(row, "Value", labelW, 0, w - labelW, h, THEME.background, {
		transparency: 1,
		zIndex: row.ZIndex + 1,
	});
	return { frame: row, label: text, value };
}

/** a muted caption line in a SettingsList (muted-foreground on the groove, never on a cell) */
export function SettingNote(list: ScrollList, name: string, order: number, text: string, h = 40): TextLabel {
	const holder = new Instance("Frame");
	holder.Name = name;
	holder.BackgroundTransparency = 1;
	holder.BackgroundColor3 = THEME.background;
	holder.BorderSizePixel = 0;
	holder.LayoutOrder = order;
	setDesign(holder, list.designW, h);
	sizeRow(list, holder, h);
	const label = makeLabel(
		holder,
		"Text",
		text,
		space(2),
		0,
		list.designW - space(4),
		h,
		TEXT.sm,
		THEME.mutedForeground,
		{
			align: "left",
			zIndex: holder.ZIndex + 1,
		},
	);
	holder.Parent = list.frame;
	return label;
}

// ---------------------------------------------------------------- ValueKey

export interface ValueKeyOpts {
	/** key height (default 28) */
	h?: number;
	/** narrowest key (default 180, the reference's; the legend can make it wider, never narrower) */
	minW?: number;
	/** horizontal anchor in the cell: 0.5 centre (default), 1 right edge at `x` */
	anchorX?: number;
	/** x of the anchor point (default: the cell's centre) */
	x?: number;
	textSize?: number;
}

/**
 * The value of a row shown as a KEY ("W", "LeftShift", "50%"): the Keycap plate of dark iron (`SURFACE.key`) with
 * the legend light and Bold, growing to fit it. Dark and not light grey like the reference's, because a light
 * key would need a contour on its white legend, and text never has one here (UI-04 / UI-05).
 */
export function ValueKey(cell: Frame, name: string, text: string, opts?: ValueKeyOpts): Frame {
	const [w, h] = designOf(cell);
	const keyH = opts?.h ?? 28;
	return Keycap(cell, name, text, {
		x: opts?.x ?? w / 2,
		cy: h / 2,
		h: keyH,
		minW: opts?.minW ?? 180,
		anchorX: opts?.anchorX ?? 0.5,
		textSize: opts?.textSize ?? TEXT.base,
		font: BOLD,
		zIndex: cell.ZIndex + 1,
	});
}

/** rewrites a ValueKey's legend (the key refits itself) */
export function setValueKey(key: Frame, text: string): void {
	const legend = key.FindFirstChild("Legend");
	if (legend !== undefined && legend.IsA("TextLabel") && legend.Text !== text) legend.Text = text;
}

// ---------------------------------------------------------------- GridTile

/** owned: yours, not worn; equipped: worn now; locked: not yours (padlock, and the price when coins buy it) */
export type TileState = "owned" | "equipped" | "locked";

export interface GridTileProps {
	x: number;
	y: number;
	/** side, design units */
	size: number;
	state?: TileState;
	selected?: boolean;
	/** coin price shown under the padlock of a locked tile */
	price?: number;
	onClick?: () => void;
	zIndex?: number;
}

export interface GridTileHandle {
	button: TextButton;
	/** where the caller draws the item: size x size design units, above the plate, under the padlock */
	content: Frame;
	update(state: TileState, selected: boolean, price?: number): void;
}

/**
 * A tile of a grid (the reference's wardrobe): a square notched plate. The grid sits in a Groove (the dark bed),
 * as in the reference -- on a section plate the owned / locked tiles would be the section's own colour.
 *  - owned: flat dark iron (`SURFACE.section`), rising on hover;
 *  - equipped: flat iron (`secondary`), the lighter one -- what you wear now stands out of the grid;
 *  - locked: dark iron with a pixel padlock, and the coin price under it when coins can buy it;
 *  - selected (on top of any of those): the raised BLUE plate of the active tab.
 */
export function GridTile(parent: Instance, name: string, props: GridTileProps): GridTileHandle {
	const [dw, dh] = designOf(parent);
	const size = props.size;
	const b = new Instance("TextButton");
	b.Name = name;
	b.Position = UDim2.fromScale(props.x / dw, props.y / dh);
	b.Size = UDim2.fromScale(size / dw, size / dh);
	setDesign(b, size, size);
	b.AutoButtonColor = false;
	b.BorderSizePixel = 0;
	b.BackgroundTransparency = 1;
	b.BackgroundColor3 = THEME.background;
	b.Text = "";
	b.TextColor3 = THEME.foreground;
	if (props.zIndex !== undefined) b.ZIndex = props.zIndex;
	const z = b.ZIndex;
	const content = makeFrame(b, "Content", 0, 0, size, size, THEME.background, { transparency: 1, zIndex: z + 1 });

	// the padlock: 7 x 9 pixels, centred, a little under the middle (over the item's legs, like the reference)
	const lockW = math.round(size * 0.2);
	const lockH = (lockW * 9) / 7;
	const lock = makeFrame(b, "Lock", (size - lockW) / 2, size * 0.42, lockW, lockH, THEME.background, {
		transparency: 1,
		zIndex: z + 2,
	});
	drawPadlock(lock, THEME.foreground, THEME.background, z + 2);

	// the price: the coin chip and the amount, along the bottom
	const coinS = math.round(size * 0.18);
	const priceY = size - coinS - space(2);
	const price = makeFrame(b, "Price", 0, priceY, size, coinS, THEME.background, { transparency: 1, zIndex: z + 2 });
	CoinIcon(price, "Coin", size / 2 - coinS - space(1), 0, coinS, z + 3);
	const amount = makeLabel(
		price,
		"Amount",
		"",
		size / 2,
		0,
		size / 2 - space(1),
		coinS,
		coinS * 0.9,
		THEME.foreground,
		{
			font: "numeric",
			align: "left",
			zIndex: z + 3,
		},
	);

	let state: TileState = props.state ?? "owned";
	let selected = props.selected === true;
	let cost: number | undefined = props.price;
	const refresh = (): void => {
		const gs = b.GuiState;
		const pressed = gs === Enum.GuiState.Press;
		const hot = isFocused(b) || gs === Enum.GuiState.Hover || pressed;
		const face = selected ? THEME.tabActive : state === "equipped" ? THEME.secondary : SURFACE.section;
		const rest: PlateState = selected ? "idle" : "flat";
		paintPlate(b, face, pressed ? "press" : hot ? "hot" : rest, 4);
		const locked = state === "locked";
		lock.Visible = locked;
		price.Visible = locked && cost !== undefined;
		if (cost !== undefined) amount.Text = fmtInt(cost);
	};
	registerFocus(b, refresh);
	b.GetPropertyChangedSignal("GuiState").Connect(refresh);
	const onClick = props.onClick;
	if (onClick !== undefined) b.Activated.Connect(() => onClick());
	b.Selectable = true;
	refresh();
	b.Parent = parent;
	return {
		button: b,
		content,
		update(nextState: TileState, nextSelected: boolean, nextPrice?: number): void {
			state = nextState;
			selected = nextSelected;
			cost = nextPrice;
			refresh();
		},
	};
}
