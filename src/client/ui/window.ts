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
 *   SettingRow    one row: bold label centred in a darker cell at the left, the value in a lighter cell at right;
 *                 with `description`, the FORM ROW: label and a muted one-line description under it, left-aligned
 *   SettingAction a form row whose control is one button ("Reset to defaults", "Open credits")
 *   ValueKey      the value as a key: a dark-iron plate with a light legend that grows to fit it
 *   SettingNote   a muted caption line in the list
 *   Switch        an on / off control: the slider's dark groove, steel-blue inside when on, an iron pixel knob
 *   RadioGroup    stacked options on a Groove, each a label and a description, a pixel socket lit blue when chosen
 *   GridTile      a square tile of a grid (the wardrobe): flat, equipped, locked (padlock + price), selected (blue)
 *   ListRow       a row of a selectable list whose text is the content (the wardrobe's titles): graphite, locked
 *                 darker with a padlock, selected inside the blue ring
 *
 * Separate from widgets.ts on purpose: that module is close to Luau's 200-locals-per-chunk budget
 * (npm run check:registers), and these pieces are compositions of it, not primitives.
 */
import { registerBack } from "./backStack";
import { SURFACE, TEXT, THEME, fontOf, space } from "./theme";
import { PlateState, drawPadlock, paintPlate, paintSegment, reliefPx } from "./plate";
import {
	Button,
	ButtonVariant,
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
const UserInputService = game.GetService("UserInputService");

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
		// B / Backspace backs out of the window the way its X does (backStack.ts)
		registerBack(handle.close, onClose);
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
	// the pad's too, like every control of the kit (a help popup closed with B gives the pad back to it, backStack.ts)
	b.Selectable = true;
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

// ---------------------------------------------------------------- Meter

export interface MeterProps {
	x: number;
	y: number;
	w: number;
	h: number;
	/** the fill's plate: a colour the light label reads on at 4,5:1 (UI-05; test:contrast) */
	face: Color3;
	/** the label's design size (default TEXT.sm, Bold) */
	textSize?: number;
	zIndex?: number;
}

export interface MeterHandle {
	frame: Frame;
	fill: Frame;
	label: TextLabel;
	/** fills `ratio` (0..1) of the groove and writes `text` over it; only what changed is written */
	set(ratio: number, text: string): void;
	/** repaints the fill in another face (an achievement going gold) */
	setFace(face: Color3): void;
}

/** relief of the meter's groove and of its fill, in design units (the HUD console's bars) */
const METER_GROOVE_UNIT = 2;
const METER_FILL_UNIT = 2;

/**
 * The HUD console's bar as a kit piece (DESIGN_RULES UI-09, UI-13): the dark notched groove, the fill a PLATE in relief
 * inside it (its light band and lip), and the light Bold label centred over both -- "17 / 500" reads on the fill and
 * on the empty groove alike (test:contrast measures both). Not the thin web progress line: a sliver of progress keeps
 * its notched shape (the narrowest fill is its own relief), and nothing is drawn for zero.
 */
export function Meter(parent: Instance, name: string, props: MeterProps): MeterHandle {
	const groove = Groove(parent, name, props.x, props.y, props.w, props.h);
	const z = props.zIndex ?? groove.ZIndex;
	groove.ZIndex = z;
	const inner = new Instance("Frame");
	inner.Name = "Inner";
	inner.BackgroundTransparency = 1;
	inner.BackgroundColor3 = THEME.background;
	inner.BorderSizePixel = 0;
	inner.ZIndex = z + 1;
	inner.Parent = groove;
	const fill = new Instance("Frame");
	fill.Name = "Fill";
	fill.BackgroundTransparency = 1;
	fill.BackgroundColor3 = THEME.background;
	fill.BorderSizePixel = 0;
	fill.ZIndex = z + 1;
	fill.Parent = inner;
	let face = props.face;
	paintPlate(fill, face, "idle", METER_FILL_UNIT);
	const label = makeLabel(
		groove,
		"Value",
		"",
		space(2),
		0,
		props.w - space(4),
		props.h,
		props.textSize ?? TEXT.sm,
		THEME.foreground,
		{
			font: BOLD,
			zIndex: z + 3,
		},
	);
	let ratio = -1;
	let minPx = 0;
	const size = (): void => {
		const r = math.max(ratio, 0);
		// from `minPx` at 0+ to the full width at 1 (UDim2 cannot take a max(): the offset fades out as it fills)
		fill.Size = new UDim2(r, (1 - r) * minPx, 1, 0);
		fill.Visible = r > 0;
	};
	onLayoutChange(inner, () => {
		const u = reliefPx(METER_GROOVE_UNIT);
		inner.Position = new UDim2(0, u, 0, u);
		inner.Size = new UDim2(1, -2 * u, 1, -2 * u);
		minPx = 2 * reliefPx(METER_FILL_UNIT) + 1;
		size();
	});
	return {
		frame: groove,
		fill,
		label,
		set(r: number, text: string): void {
			const v = math.clamp(r === r ? r : 0, 0, 1);
			if (v !== ratio) {
				ratio = v;
				size();
			}
			if (label.Text !== text) label.Text = text;
		},
		setFace(c: Color3): void {
			if (c === face) return;
			face = c;
			paintPlate(fill, face, "idle", METER_FILL_UNIT);
		},
	};
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
	/** row height (default SETTING_ROW_H, the reference's; SETTING_DESC_ROW_H for a form row) */
	rowH?: number;
	/**
	 * Makes it a FORM ROW (DESIGN_RULES UI-07): the label, and under it this muted one-line description of what the
	 * setting really does, both left-aligned in the label cell; the control goes in the value cell as in any row.
	 * The line is `SURFACE.cellCaption` (4,5:1 on the label cell, where plain muted text is not), TEXT.sm, and never
	 * wraps: one line, and a translation too long for it is cut with an ellipsis instead of spilling out of the row.
	 */
	description?: string;
}

export interface SettingRowHandle {
	frame: Frame;
	label: TextLabel;
	/** the value cell: its own design space (list width - labelW) x rowH, for the control / key / text */
	value: Frame;
	/** the description line of a form row (undefined on a plain row) */
	description?: TextLabel;
}

export const SETTING_ROW_H = 38;
/** a form row: the label (20), the description under it (16) and the cell's breathing room */
export const SETTING_DESC_ROW_H = 46;
/** where a control starts in the value cell of a form row (the slider's track starts there too): one column of them */
export const SETTING_CONTROL_X = space(4);

/** the label column of a form row: label box, description box and the gap between them (design units) */
const DESC_LABEL_H = 20;
const DESC_TEXT_H = 16;
const DESC_GAP = 2;
/** the label and description start this far into the label cell, and stop this far from its right edge */
const DESC_PAD_L = space(4);
const DESC_PAD_R = space(3);

/**
 * The label of a row in `labelW` x `h` of `row`: Bold and centred (the reference's row), or -- with a description --
 * the form row's column, label over description, left-aligned and vertically centred as a block.
 */
function rowLabels(
	row: Frame,
	label: string,
	labelW: number,
	h: number,
	description: string | undefined,
): [TextLabel, TextLabel | undefined] {
	const zIndex = row.ZIndex + 1;
	if (description === undefined) {
		const text = makeLabel(row, "Label", label, space(2), 0, labelW - space(4), h, TEXT.lg, THEME.foreground, {
			font: BOLD,
			zIndex,
		});
		return [text, undefined];
	}
	const w = labelW - DESC_PAD_L - DESC_PAD_R;
	const top = (h - DESC_LABEL_H - DESC_GAP - DESC_TEXT_H) / 2;
	const text = makeLabel(row, "Label", label, DESC_PAD_L, top, w, DESC_LABEL_H, TEXT.lg, THEME.foreground, {
		font: BOLD,
		align: "left",
		zIndex,
	});
	const line = makeLabel(
		row,
		"Description",
		description,
		DESC_PAD_L,
		top + DESC_LABEL_H + DESC_GAP,
		w,
		DESC_TEXT_H,
		TEXT.sm,
		SURFACE.cellCaption,
		{ align: "left", zIndex },
	);
	for (const l of [text, line]) {
		l.TextWrapped = false;
		l.TextTruncate = Enum.TextTruncate.AtEnd;
	}
	return [text, line];
}

/**
 * One settings row, ONE notched shape in two tones (plate.ts paintSegment): the label Bold and centred in the
 * darker cell at the left (`SURFACE.cellLabel`), the value in the lighter cell at the right (`SURFACE.cell`).
 *
 * With `opts.description` it is the FORM ROW -- the structure of a web form's horizontal item (label and description
 * on one side, the control on the other), drawn as our plate: the same two cells, the label over its description in
 * the left one. Put the control at SETTING_CONTROL_X of `value`, vertically centred.
 */
export function SettingRow(
	list: ScrollList,
	name: string,
	order: number,
	label: string,
	opts?: SettingRowOpts,
): SettingRowHandle {
	const described = opts?.description;
	const rowH = opts?.rowH ?? (described !== undefined ? SETTING_DESC_ROW_H : SETTING_ROW_H);
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
	const [text, line] = rowLabels(row, label, labelW, rowH, described);
	const value = makeFrame(row, "Value", labelW, 0, w - labelW, rowH, THEME.background, {
		transparency: 1,
		zIndex: row.ZIndex + 1,
	});
	row.Parent = list.frame;
	return { frame: row, label: text, value, description: line };
}

export interface SettingActionOpts extends SettingRowOpts {
	/** the button's look (default "secondary": an action row is never the window's main action) */
	variant?: ButtonVariant;
	/** button width (default 140) */
	buttonW?: number;
}

export interface SettingActionHandle {
	row: SettingRowHandle;
	button: TextButton;
}

/**
 * A form row whose control is ONE button, at SETTING_CONTROL_X of the value cell: "Reset to defaults" (the Settings
 * tabs), "Open credits". The label says what, the description says what exactly happens -- the button only says the
 * verb. Its click is the caller's (a reset confirms with the kit's popup first).
 */
export function SettingAction(
	list: ScrollList,
	name: string,
	order: number,
	label: string,
	description: string,
	action: string,
	onClick: () => void,
	opts?: SettingActionOpts,
): SettingActionHandle {
	const row = SettingRow(list, name, order, label, { ...opts, description });
	const [, h] = designOf(row.value);
	const bh = 30;
	const button = Button(row.value, "Action", action, {
		x: SETTING_CONTROL_X,
		y: (h - bh) / 2,
		w: opts?.buttonW ?? 140,
		h: bh,
		size: "sm",
		variant: opts?.variant ?? "secondary",
		zIndex: row.value.ZIndex + 1,
		onClick,
	});
	return { row, button };
}

export interface SettingCellProps {
	x: number;
	y: number;
	w: number;
	/** default SETTING_ROW_H (SETTING_DESC_ROW_H with a description) */
	h?: number;
	/** label cell width (design units of the row) */
	labelW: number;
	label: string;
	/** a form row's description line (see SettingRowOpts.description) */
	description?: string;
	zIndex?: number;
}

/**
 * The settings row's shape (label cell | value cell, ONE notched shape in two tones) placed at x, y in any frame
 * instead of stacked in a SettingsList: for a few fixed rows laid out side by side on a Groove (the Survivor
 * screen's stats, two to a line). Same tones, same Bold centred label, same value design space -- and the same
 * form-row variant with `description`.
 */
export function SettingCell(parent: Instance, name: string, props: SettingCellProps): SettingRowHandle {
	const h = props.h ?? (props.description !== undefined ? SETTING_DESC_ROW_H : SETTING_ROW_H);
	const { w, labelW } = props;
	const row = makeFrame(parent, name, props.x, props.y, w, h, THEME.background, {
		transparency: 1,
		zIndex: props.zIndex,
	});
	const split = labelW / w;
	paintSegment(row, "Label", SURFACE.cellLabel, 0, split, 3);
	paintSegment(row, "Value", SURFACE.cell, split, 1, 3);
	const [text, line] = rowLabels(row, props.label, labelW, h, props.description);
	const value = makeFrame(row, "Value", labelW, 0, w - labelW, h, THEME.background, {
		transparency: 1,
		zIndex: row.ZIndex + 1,
	});
	return { frame: row, label: text, value, description: line };
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

// ---------------------------------------------------------------- Switch

export interface SwitchProps {
	/** top-left, in the parent's design units */
	x: number;
	y: number;
	/** default SWITCH_W x SWITCH_H */
	w?: number;
	h?: number;
	value: boolean;
	/** the player flipped it: a click, a tap, the pad's A / Enter, or left (off) / right (on) while it has the focus */
	onChange?: (value: boolean) => void;
	/** the legends in the track's free end, already translated ("On" / "Off"); omitted = none */
	onText?: string;
	offText?: string;
	zIndex?: number;
}

export interface SwitchHandle {
	button: TextButton;
	get(): boolean;
	/** shows `value` without calling onChange (a reset, a value changed elsewhere) */
	set(value: boolean): void;
	/** disabled: a dark slot in the kit's `line`, not selectable, the knob flat */
	setEnabled(enabled: boolean): void;
	/** drops the pad / keyboard listener: call it when the screen closes (like SliderHandle) */
	disconnect(): void;
}

export const SWITCH_W = 68;
export const SWITCH_H = 30;
/** the knob's width, and how far inside the groove the knob and the blue run (design units) */
const KNOB_W = 26;
const TRACK_INSET = 3;

/**
 * An ON / OFF control in the plate vocabulary (DESIGN_RULES UI-07), for a boolean -- not a web toggle: the SLIDER's
 * dark notched groove (`SURFACE.well`), filled steel-blue inside when on (`tabActive`: what is chosen is blue), and
 * an iron pixel knob (the slider's raised `secondary` handle) that sits at the left when off and at the right when
 * on. The free end of the groove carries the legend ("Off" muted on the dark, "On" light on the blue), so the state
 * never rests on colour alone.
 *
 * Input, by the kit's rules: it is a Selectable button (mouse, touch, and the pad's A / Enter flip it); with the pad
 * or the keyboard on it, left and right set it off and on, as they move a Slider; the focus lights the groove's edge
 * in the ring colour, hovering lights the knob. Built once: flipping, hovering or focusing it only repaints and moves
 * what is there -- it creates no Instance, and it snaps rather than tweens (a pixel knob, and nothing to reduce under
 * Reduce Motion).
 */
export function Switch(parent: Instance, name: string, props: SwitchProps): SwitchHandle {
	const [dw, dh] = designOf(parent);
	const w = props.w ?? SWITCH_W;
	const h = props.h ?? SWITCH_H;
	const b = new Instance("TextButton");
	b.Name = name;
	b.Position = UDim2.fromScale(props.x / dw, props.y / dh);
	b.Size = UDim2.fromScale(w / dw, h / dh);
	setDesign(b, w, h);
	b.AutoButtonColor = false;
	b.BorderSizePixel = 0;
	b.BackgroundTransparency = 1;
	b.BackgroundColor3 = THEME.background;
	b.Text = "";
	b.TextColor3 = THEME.foreground;
	if (props.zIndex !== undefined) b.ZIndex = props.zIndex;
	// left / right set the value instead of moving the selection, as on a Slider
	b.SelectionBehaviorLeft = Enum.SelectionBehavior.Stop;
	b.SelectionBehaviorRight = Enum.SelectionBehavior.Stop;
	const z = b.ZIndex;

	// the inside of the groove, TRACK_INSET relief units in (whole pixels), clipped: the blue and the knob live here
	const innerW = w - TRACK_INSET * 2;
	const innerH = h - TRACK_INSET * 2;
	const inner = makeFrame(b, "Inner", TRACK_INSET, TRACK_INSET, innerW, innerH, THEME.background, {
		transparency: 1,
		clips: true,
		zIndex: z + 1,
	});
	onLayoutChange(inner, () => {
		const u = reliefPx(TRACK_INSET);
		inner.Position = new UDim2(0, u, 0, u);
		inner.Size = new UDim2(1, -2 * u, 1, -2 * u);
	});
	const fill = makeFrame(inner, "Fill", 0, 0, innerW, innerH, THEME.tabActive, { zIndex: z + 2 });
	const knobShare = KNOB_W / innerW;
	const legend = makeLabel(inner, "Legend", "", 0, 0, innerW - KNOB_W, innerH, TEXT.xs, THEME.mutedForeground, {
		font: BOLD,
		zIndex: z + 3,
	});
	legend.TextWrapped = false;
	const knob = makeFrame(inner, "Knob", 0, 0, KNOB_W, innerH, THEME.background, { transparency: 1, zIndex: z + 4 });

	let value = props.value;
	let enabled = true;
	const refresh = (): void => {
		const gs = b.GuiState;
		const focus = enabled && isFocused(b);
		const pressed = enabled && gs === Enum.GuiState.Press;
		const hot = enabled && (focus || gs === Enum.GuiState.Hover || pressed);
		// the groove; with the pad / keyboard on it, its notched edge becomes the kit's focus ring (a list row's way)
		paintPlate(b, SURFACE.well, focus ? "outline" : "flat", 2, THEME.ring);
		const on = value && enabled;
		fill.Visible = on;
		knob.Position = UDim2.fromScale(value ? 1 - knobShare : 0, 0);
		if (enabled) paintPlate(knob, THEME.secondary, pressed ? "press" : hot ? "hot" : "idle");
		else paintPlate(knob, SURFACE.well, "outline", 2, SURFACE.line);
		// the legend fills the end the knob left free: "On" light on the blue, "Off" muted on the dark
		const text = (value ? props.onText : props.offText) ?? "";
		if (legend.Text !== text) legend.Text = text;
		legend.Position = UDim2.fromScale(value ? 0 : knobShare, 0);
		legend.TextColor3 = on ? THEME.tabActiveForeground : THEME.mutedForeground;
	};
	const setValue = (want: boolean, fromPlayer: boolean): void => {
		if (want === value) return;
		value = want;
		refresh();
		if (fromPlayer) props.onChange?.(value);
	};
	registerFocus(b, refresh);
	b.GetPropertyChangedSignal("GuiState").Connect(refresh);
	b.Activated.Connect(() => {
		if (enabled) setValue(!value, true);
	});
	const keys = UserInputService.InputBegan.Connect((input: InputObject): void => {
		if (!enabled || !isFocused(b)) return;
		const k = input.KeyCode;
		if (k === Enum.KeyCode.DPadLeft || k === Enum.KeyCode.Left) setValue(false, true);
		else if (k === Enum.KeyCode.DPadRight || k === Enum.KeyCode.Right) setValue(true, true);
	});
	b.Destroying.Connect(() => keys.Disconnect());
	b.Selectable = true;
	refresh();
	b.Parent = parent;
	return {
		button: b,
		get(): boolean {
			return value;
		},
		set(want: boolean): void {
			setValue(want, false);
		},
		setEnabled(want: boolean): void {
			if (want === enabled) return;
			enabled = want;
			b.Interactable = want;
			b.Selectable = want;
			refresh();
		},
		disconnect(): void {
			keys.Disconnect();
		},
	};
}

// ---------------------------------------------------------------- RadioGroup

export interface RadioOption {
	label: string;
	/** one muted line under the label: what picking this option means */
	description?: string;
}

export interface RadioGroupProps {
	x: number;
	y: number;
	w: number;
	options: Array<RadioOption>;
	value: number;
	/** the player picked `index` (a click, a tap, the pad's A / Enter on it) */
	onChange?: (index: number) => void;
	/** height of one option (default SETTING_DESC_ROW_H, a form row's) */
	optionH?: number;
	zIndex?: number;
}

export interface RadioGroupHandle {
	/** the groove that holds the options */
	frame: Frame;
	/** one Selectable button per option, top to bottom */
	options: Array<TextButton>;
	get(): number;
	/** shows `index` as chosen without calling onChange */
	set(index: number): void;
}

/** the pixel socket at the left of an option, and the blue dot inside it when chosen (design units) */
const SOCKET = 18;
const DOT = 10;
const SOCKET_X = space(3);
/** where an option's texts start: past the socket */
const OPTION_TEXT_X = SOCKET_X + SOCKET + space(3);

/** height a RadioGroup of `count` options needs (its groove, with the list's padding and grooves) */
export function radioGroupHeight(count: number, optionH = SETTING_DESC_ROW_H): number {
	const items: Array<number> = [];
	for (let i = 0; i < count; i++) items.push(optionH);
	return settingsListHeight(items);
}

/**
 * A STACKED RADIO GROUP (DESIGN_RULES UI-07): one choice among options that differ in a way a word does not say
 * (a Segmented is for the short, self-explanatory ones). A Groove holding one plate per option, the form row's label
 * cell (`SURFACE.cellLabel`), with a dark pixel socket at the left -- lit by a steel-blue pixel dot on the chosen one
 * (what is chosen is blue) -- and the label over its one-line description, as in a form row.
 *
 * Input, by the kit's rules: each option is a Selectable button (mouse, touch, and the pad's A / Enter pick it); the
 * pad moves between them with up / down; the edge of the option under the pointer turns iron, the one with the pad /
 * keyboard focus the ring colour, and the chosen one blue. Built once: picking, hovering or focusing only repaints.
 */
export function RadioGroup(parent: Instance, name: string, props: RadioGroupProps): RadioGroupHandle {
	const optionH = props.optionH ?? SETTING_DESC_ROW_H;
	const count = props.options.size();
	const groupH = radioGroupHeight(count, optionH);
	const groove = Groove(parent, name, props.x, props.y, props.w, groupH);
	if (props.zIndex !== undefined) groove.ZIndex = props.zIndex;
	const optionW = props.w - LIST_PAD * 2;
	const buttons: Array<TextButton> = [];
	const dots: Array<Frame> = [];
	let value = props.value;
	const repaint = (i: number): void => {
		const b = buttons[i];
		const gs = b.GuiState;
		const hover = gs === Enum.GuiState.Hover || gs === Enum.GuiState.Press;
		// the edge: the focus ring over everything (the dot already says which one is chosen), then chosen, then hover
		let edge = SURFACE.cellLabel;
		if (isFocused(b)) edge = THEME.ring;
		else if (i === value) edge = THEME.tabActive;
		else if (hover) edge = THEME.secondary;
		paintPlate(b, SURFACE.cellLabel, "outline", 3, edge);
		dots[i].Visible = i === value;
	};
	const pick = (index: number, fromPlayer: boolean): void => {
		if (index === value || index < 0 || index >= count) return;
		const before = value;
		value = index;
		repaint(before);
		repaint(index);
		if (fromPlayer) props.onChange?.(index);
	};
	for (let i = 0; i < count; i++) {
		const option = props.options[i];
		const index = i;
		const y = LIST_PAD + i * (optionH + GROOVE);
		const b = new Instance("TextButton");
		b.Name = `Option${i}`;
		b.Position = UDim2.fromScale(LIST_PAD / props.w, y / groupH);
		b.Size = UDim2.fromScale(optionW / props.w, optionH / groupH);
		setDesign(b, optionW, optionH);
		b.AutoButtonColor = false;
		b.BorderSizePixel = 0;
		b.BackgroundTransparency = 1;
		b.BackgroundColor3 = THEME.background;
		b.Text = "";
		b.TextColor3 = THEME.foreground;
		b.ZIndex = groove.ZIndex + 1;
		const z = b.ZIndex;
		const described = option.description !== undefined;
		// texts: the form row's column (label over description), or the label alone, centred on the option
		const textW = optionW - OPTION_TEXT_X - space(3);
		const top = described ? (optionH - DESC_LABEL_H - DESC_GAP - DESC_TEXT_H) / 2 : (optionH - DESC_LABEL_H) / 2;
		const label = makeLabel(
			b,
			"Label",
			option.label,
			OPTION_TEXT_X,
			top,
			textW,
			DESC_LABEL_H,
			TEXT.lg,
			THEME.foreground,
			{
				font: BOLD,
				align: "left",
				zIndex: z + 1,
			},
		);
		label.TextWrapped = false;
		label.TextTruncate = Enum.TextTruncate.AtEnd;
		if (option.description !== undefined) {
			const line = makeLabel(
				b,
				"Description",
				option.description,
				OPTION_TEXT_X,
				top + DESC_LABEL_H + DESC_GAP,
				textW,
				DESC_TEXT_H,
				TEXT.sm,
				SURFACE.cellCaption,
				{ align: "left", zIndex: z + 1 },
			);
			line.TextWrapped = false;
			line.TextTruncate = Enum.TextTruncate.AtEnd;
		}
		// the socket, centred on the label's line: a dark notched square, and the blue dot of the chosen option
		const socket = makeFrame(
			b,
			"Socket",
			SOCKET_X,
			top + (DESC_LABEL_H - SOCKET) / 2,
			SOCKET,
			SOCKET,
			THEME.background,
			{
				transparency: 1,
				zIndex: z + 1,
			},
		);
		paintPlate(socket, SURFACE.well, "flat", 2);
		const dot = makeFrame(socket, "Dot", (SOCKET - DOT) / 2, (SOCKET - DOT) / 2, DOT, DOT, THEME.background, {
			transparency: 1,
			zIndex: z + 2,
		});
		paintPlate(dot, THEME.tabActive, "flat", 1);
		buttons.push(b);
		dots.push(dot);
		registerFocus(b, () => repaint(index));
		b.GetPropertyChangedSignal("GuiState").Connect(() => repaint(index));
		b.Activated.Connect(() => pick(index, true));
		b.Selectable = true;
		b.Parent = groove;
	}
	for (let i = 0; i < count; i++) repaint(i);
	return {
		frame: groove,
		options: buttons,
		get(): number {
			return value;
		},
		set(index: number): void {
			pick(index, false);
		},
	};
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

	// the price: the pixel coin and the amount on a dark chip along the bottom (MON-06): the chip is what holds the coin's
	// contrast on every face of the tile -- the iron of a locked one and the blue of the selected one alike
	const coinS = math.round(size * 0.18);
	const priceY = size - coinS - space(2);
	const price = makeFrame(b, "Price", 0, priceY, size, coinS, THEME.background, { transparency: 1, zIndex: z + 2 });
	const chipW = math.round(size * 0.62);
	const chip = makeFrame(price, "Chip", (size - chipW) / 2, -2, chipW, coinS + 4, THEME.background, {
		transparency: 1,
		zIndex: z + 2,
	});
	paintPlate(chip, SURFACE.well, "flat", 2);
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

// ---------------------------------------------------------------- ListRow

export interface ListRowProps {
	x: number;
	y: number;
	w: number;
	h: number;
	state?: TileState;
	selected?: boolean;
	onClick?: () => void;
	zIndex?: number;
}

export interface ListRowHandle {
	button: TextButton;
	/** where the caller writes the row: w x h design units, above the plate (leave LIST_ROW_TEXT_X for the padlock) */
	content: Frame;
	update(state: TileState, selected: boolean): void;
}

/** where a ListRow's text starts: the padlock's column is left of it, on every row, so the texts line up */
export const LIST_ROW_TEXT_X = 30;

/**
 * A row of a selectable list whose TEXT is the content (the wardrobe's titles, MON-05), on the dark groove like a
 * tile. Unlike a tile its face never turns blue: the text is drawn in game colours, and those fall under 4,5:1 on
 * the blue plate (test:contrast) -- so the face stays dark and the row is drawn by its RING (the plate's "outline"
 * state: the notched edge in one colour, `SURFACE.line` being the kit's outline of a list row):
 *  - owned / equipped: graphite (`SURFACE.row`) in the iron line; the caller marks "equipped" in its content;
 *  - locked: DARKER (`SURFACE.well`), with the pixel padlock in the column left of the text;
 *  - under the pointer the line turns iron (`secondary`), with the pad / keyboard focus it is the kit's focus ring
 *    (`ring`); selected (on top of any of those): the ring turns BLUE -- what is chosen is blue, as in all the kit.
 */
export function ListRow(parent: Instance, name: string, props: ListRowProps): ListRowHandle {
	const [dw, dh] = designOf(parent);
	const b = new Instance("TextButton");
	b.Name = name;
	b.Position = UDim2.fromScale(props.x / dw, props.y / dh);
	b.Size = UDim2.fromScale(props.w / dw, props.h / dh);
	setDesign(b, props.w, props.h);
	b.AutoButtonColor = false;
	b.BorderSizePixel = 0;
	b.BackgroundTransparency = 1;
	b.BackgroundColor3 = THEME.background;
	b.Text = "";
	b.TextColor3 = THEME.foreground;
	if (props.zIndex !== undefined) b.ZIndex = props.zIndex;
	const z = b.ZIndex;
	const content = makeFrame(b, "Content", 0, 0, props.w, props.h, THEME.background, {
		transparency: 1,
		zIndex: z + 1,
	});
	// the padlock: 7 x 9 pixels in the text's left column, centred on the row
	const lockW = 11;
	const lockH = (lockW * 9) / 7;
	const lock = makeFrame(
		b,
		"Lock",
		(LIST_ROW_TEXT_X - lockW) / 2,
		(props.h - lockH) / 2,
		lockW,
		lockH,
		THEME.background,
		{
			transparency: 1,
			zIndex: z + 2,
		},
	);
	drawPadlock(lock, THEME.mutedForeground, SURFACE.well, z + 2);

	let state: TileState = props.state ?? "owned";
	let selected = props.selected === true;
	const refresh = (): void => {
		const gs = b.GuiState;
		const hover = gs === Enum.GuiState.Hover || gs === Enum.GuiState.Press;
		const locked = state === "locked";
		const face = locked ? SURFACE.well : SURFACE.row;
		// chosen: blue; the pad / keyboard focus: the kit's focus ring; under the pointer: the lighter iron
		let ring = SURFACE.line;
		if (selected) ring = THEME.tabActive;
		else if (isFocused(b)) ring = THEME.ring;
		else if (hover) ring = THEME.secondary;
		paintPlate(b, face, "outline", 3, ring);
		lock.Visible = locked;
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
		update(nextState: TileState, nextSelected: boolean): void {
			state = nextState;
			selected = nextSelected;
			refresh();
		},
	};
}
