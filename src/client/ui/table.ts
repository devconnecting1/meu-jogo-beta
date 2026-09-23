/*
 * The kit's TABLE (docs/DESIGN_RULES.md UI-12): rows of data in the window vocabulary of UI-07 -- a dark groove, a
 * header of iron cells, rows as notched plates with the groove showing between them -- never a web table.
 *
 * The structure is Supabase's two table patterns (design-system/docs/ui-patterns/tables), adapted to a game:
 *   - a SIMPLE table shows data (the Records window): no header clicks, no selection;
 *   - a DATA table sorts, filters and acts on a row (the admin's players, the match scoreboard):
 *       - sorting: a click on a header cell with the mouse; the sorted column's header is the BLUE plate ("what is
 *         chosen is blue", UI-07) with a pixel arrow for the direction. A pad or a thumb gets a Segmented "sort by"
 *         instead (`TableSortBar`): a header cell is a small target and the pad must not have to aim at one;
 *       - filtering is the caller's (it hands `setItems` the rows that pass);
 *       - row actions: SELECT a row (the blue ring of the wardrobe's rows and the Bag's tiles), then act with a
 *         button beside the table. No per-row "..." menu: a dropdown is poor with a pad. No multi-select, no bulk
 *         action;
 *   - scrolling, never pages; an EMPTY state that says why the table is empty.
 *   - numbers in the kit's "numeric" role (BuilderMono Bold), right-aligned, so the digits line up.
 *
 * Look (all tokens, UI-01; text light and never outlined, UI-04 / UI-05):
 *   - the bed: the kit's Groove (`SURFACE.groove`);
 *   - the header: one flat iron cell per column (`SURFACE.cellLabel`, the settings row's label cell) with the
 *     label Bold; the sorted one raised blue (`tabActive`). Sticky (outside the scroll), inline (the first thing in
 *     the scroll) or none;
 *   - a row: the wardrobe's list row (window.ts ListRow) -- a graphite plate (`SURFACE.row`, or `SURFACE.well` for a
 *     denser admin table) drawn by its ring: `SURFACE.line` at rest, iron under the mouse, the kit's focus ring
 *     under the pad, BLUE when selected. A "marked" row (your own, on the scoreboard) wears the iron ring. The
 *     separators are the groove itself: the rows stand GROOVE units apart.
 *
 * Performance (the Bag's rule, test:tables): rows are a POOL of Frames built on first need and rewritten in place.
 * `setItems` / `refresh` / sorting / filtering / selecting write only the properties whose value changed, and once
 * the table has been as long as it gets they create no Instance at all. The i-th row shows the i-th item in the
 * sorted order; the selection follows the item (its key), not the row.
 *
 * Separate from widgets.ts / window.ts on purpose: both are near Luau's 200-locals budget (npm run check:registers),
 * and this is a composition of their pieces, not a primitive.
 */
import { SURFACE, TEXT, THEME, fontOf, space } from "./theme";
import { PlateState, paintPlate, reliefPx } from "./plate";
import {
	ScrollList,
	Segmented,
	TabsHandle,
	isFocused,
	makeFrame,
	makeLabel,
	makeScrollList,
	onLayoutChange,
	registerFocus,
	setDesign,
	setVisible,
	sizeRow,
} from "./widgets";
import { Groove } from "./window";

const BOLD = fontOf("sans", Enum.FontWeight.Bold);

/** padding inside the groove, around the header and the rows (design units) */
export const TABLE_PAD = 6;
/** the groove between two rows, and between two header cells (design units) */
export const TABLE_GAP = 3;
/** the scroll bar's gutter, always reserved so the header lines up with the rows whether they scroll or not */
export const TABLE_BAR = 4;
/** a cell's text inset from its edges (default; `cellPad` overrides it for a tight table) */
const CELL_PAD = space(2);
/** the room a header keeps for its sort arrow (the arrow is 5 wide) */
const ARROW_W = 6;
/** relief unit of a row plate (the wardrobe row's) */
const ROW_UNIT = 3;
const HEADER_UNIT = 2;

export type TableAlign = "left" | "center" | "right";

export interface TableColumn {
	/** what the caller's `cell` / `sortValue` are asked about */
	key: string;
	/** the header's label (already translated) */
	header: string;
	/** fixed width in design units; omitted = the column takes a `flex` share of what the fixed ones leave */
	width?: number;
	/** share of the remaining width (default 1) */
	flex?: number;
	/** default: right for a numeric column, left otherwise */
	align?: TableAlign;
	/** numbers: the kit's "numeric" font role, right-aligned */
	numeric?: boolean;
	/** a click on the header sorts by it (needs the table's `sortValue`) */
	sortable?: boolean;
	/** the first direction when this column is picked: numbers biggest first, text A-Z (default) */
	descendingFirst?: boolean;
	/** this column's cells have a second, smaller line (the title under a name) */
	sub?: boolean;
}

/** what one cell shows; the table hands the SAME object to every `cell` call (nothing is allocated per row) */
export interface TableCell {
	text: string;
	/** default THEME.foreground */
	color?: Color3;
	/** the second line (columns with `sub`) */
	sub?: string;
	/** default THEME.mutedForeground */
	subColor?: Color3;
}

export interface TableSort {
	column: string;
	descending: boolean;
}

export interface TableProps<T> {
	x: number;
	y: number;
	w: number;
	h: number;
	columns: Array<TableColumn>;
	/** a stable, unique key per item: the selection follows it */
	keyOf: (item: T) => string;
	/** writes what `item` shows in `column` into `out` (reset before each call) */
	cell: (item: T, column: string, out: TableCell) => void;
	/** the value a column sorts by; without it the table keeps the caller's order */
	sortValue?: (item: T, column: string) => number | string;
	/** the starting sort */
	sort?: TableSort;
	/** the sort changed (a header click, `setSort`, a sort bar) */
	onSort?: (sort: TableSort) => void;
	/** row height, design units (default 30) */
	rowH?: number;
	/** header height, design units (default 26) */
	headerH?: number;
	/** sticky (outside the scroll, default), inline (scrolls with the rows) or none */
	header?: "sticky" | "inline" | "none";
	/** cell text design size (default TEXT.base; a second line is TEXT.xs) */
	textSize?: number;
	/** rows take a click / a tap / the pad's A and show the blue ring (default false) */
	selectable?: boolean;
	onSelect?: (key: string | undefined, item: T | undefined) => void;
	/** a row to wear the iron ring (your own on the scoreboard) */
	marked?: (item: T) => boolean;
	/** the row plate: `SURFACE.row` (default) or `SURFACE.well` (denser admin tables) */
	rowFace?: Color3;
	/** what the empty table says (why it is empty) */
	empty?: string;
	/** a cell's text inset from its edges, design units (default space(2); a tight table on a phone wants less) */
	cellPad?: number;
	zIndex?: number;
}

export interface TableHandle<T> {
	/** the groove holding everything */
	frame: Frame;
	list: ScrollList;
	/** the items to show (the caller filters); sorts them and rewrites the rows in place */
	setItems(items: ReadonlyArray<T>): void;
	/** re-reads every shown cell (live values) and re-sorts; writes only what changed */
	refresh(): void;
	setSort(sort: TableSort): void;
	sort(): TableSort | undefined;
	select(key: string | undefined): void;
	selected(): string | undefined;
	selectedItem(): T | undefined;
	setEmpty(text: string): void;
	/** keys in display order (the rows shown) */
	order(): ReadonlyArray<string>;
	/** each column's [x, width] inside a row, design units (for layout checks) */
	columnSpans(): ReadonlyArray<[number, number]>;
	/** row Frames built so far (the pool) */
	poolSize(): number;
	/** the row button showing display position `i` (for focus / tests) */
	rowButton(i: number): TextButton | undefined;
	/** the header cell of `column` (undefined without a header) */
	headerCell(column: string): TextButton | undefined;
}

interface CellView {
	label: TextLabel;
	sub?: TextLabel;
	text: string;
	subText: string;
	color?: Color3;
	subColor?: Color3;
}

interface RowView {
	button: TextButton;
	cells: Array<CellView>;
	key: string;
	selected: boolean;
	marked: boolean;
}

interface HeaderView {
	button: TextButton;
	label: TextLabel;
	up: Frame;
	down: Frame;
}

/** a cut-off string that fits about `chars` characters ("Fabricio Dami…"), on a UTF-8 boundary */
export function fitText(text: string, chars: number): string {
	const [n] = utf8.len(text);
	if (!typeIs(n, "number") || n <= chars || chars < 2) return text;
	const cut = utf8.offset(text, chars);
	if (cut === undefined) return text;
	// never "Fabricio …": the cut drops the space it may land after
	const [head] = text.sub(1, cut - 1).gsub("%s+$", "");
	return `${head}…`;
}

/** how many characters of `size` fit in `w` design units (a rough, generous estimate of the kit's fonts) */
export function charsThatFit(w: number, size: number, numeric = false): number {
	return math.max(1, math.floor(w / (size * (numeric ? 0.62 : 0.52))));
}

/**
 * [x, width] of each column inside a row `rowW` design units wide: the fixed widths first, the rest shared by flex.
 * The spans touch; a header cell stands TABLE_GAP / 2 in from both edges of its span (the groove between two cells)
 * and a cell's text `cellPad` in, so neighbouring texts never touch.
 */
export function columnLayout(columns: ReadonlyArray<TableColumn>, rowW: number): Array<[number, number]> {
	let fixed = 0;
	let flex = 0;
	for (const c of columns) {
		if (c.width !== undefined) fixed += c.width;
		else flex += c.flex ?? 1;
	}
	const free = math.max(0, rowW - fixed);
	const out: Array<[number, number]> = [];
	let x = 0;
	for (const c of columns) {
		const w = c.width !== undefined ? c.width : flex > 0 ? (free * (c.flex ?? 1)) / flex : 0;
		out.push([x, w]);
		x += w;
	}
	return out;
}

function alignOf(c: TableColumn): TableAlign {
	if (c.align !== undefined) return c.align;
	return c.numeric === true ? "right" : "left";
}

/** a pixel triangle (5 x 3) pointing up or down, filling `host` */
function arrow(host: Frame, name: string, up: boolean, z: number): Frame {
	const f = makeFrame(host, name, 0, 0, 5, 3, THEME.background, { transparency: 1, zIndex: z });
	const rows: Array<[number, number]> = up
		? [
				[2, 1],
				[1, 3],
				[0, 5],
			]
		: [
				[0, 5],
				[1, 3],
				[2, 1],
			];
	for (let i = 0; i < 3; i++) {
		const [x, w] = rows[i];
		makeFrame(f, `Px${i}`, x, i, w, 1, THEME.foreground, { zIndex: z });
	}
	return f;
}

/** the design space children of `host` are placed in (its DesignW / DesignH) */
function designSpace(host: GuiObject): [number, number] {
	const dw = host.GetAttribute("DesignW");
	const dh = host.GetAttribute("DesignH");
	return [typeIs(dw, "number") && dw > 0 ? dw : 1, typeIs(dh, "number") && dh > 0 ? dh : 1];
}

/**
 * A Table in `parent`'s design space. See the header of this file for what it draws and what it promises.
 */
export function Table<T extends defined>(parent: Instance, name: string, props: TableProps<T>): TableHandle<T> {
	const rowH = props.rowH ?? 30;
	const headerH = props.headerH ?? 26;
	const headerMode = props.header ?? "sticky";
	const textSize = props.textSize ?? TEXT.base;
	const face = props.rowFace ?? SURFACE.row;
	const selectable = props.selectable === true;
	const cellPad = props.cellPad ?? CELL_PAD;
	const columns = props.columns;
	const { w, h } = props;
	// the rows' own width: the groove less its padding and the scroll bar's gutter
	const rowW = w - TABLE_PAD * 2 - TABLE_BAR;
	const spans = columnLayout(columns, rowW);

	const groove = Groove(parent, name, props.x, props.y, w, h);
	if (props.zIndex !== undefined) groove.ZIndex = props.zIndex;
	const z = groove.ZIndex;
	const stickyH = headerMode === "sticky" ? headerH + TABLE_GAP : 0;
	const listY = stickyH;
	const list = makeScrollList(groove, "Rows", 0, listY, w, h - listY, { zIndex: z + 1 });
	// the scroll bar's room is always kept, so a right-aligned number sits under its header whether the rows scroll
	list.frame.VerticalScrollBarInset = Enum.ScrollBarInset.Always;
	const pad = list.frame.FindFirstChildOfClass("UIPadding");
	onLayoutChange(list.frame, () => {
		const p = reliefPx(TABLE_PAD);
		list.layout.Padding = new UDim(0, reliefPx(TABLE_GAP));
		if (pad !== undefined) {
			pad.PaddingLeft = new UDim(0, p);
			pad.PaddingRight = new UDim(0, p);
			pad.PaddingTop = new UDim(0, headerMode === "sticky" ? 0 : p);
			pad.PaddingBottom = new UDim(0, p);
		}
	});

	// assigned at the end; the header's and the rows' callbacks only run after that
	let handle: TableHandle<T>;
	let items: ReadonlyArray<T> = [];
	/** items in display order */
	const shown: Array<T> = [];
	const shownKeys: Array<string> = [];
	const rows: Array<RowView> = [];
	const headers = new Map<string, HeaderView>();
	let sort: TableSort | undefined = props.sort;
	let selectedKey: string | undefined;
	const out: TableCell = { text: "" };

	// ---- the empty state: what the table says when there is nothing to show, and why
	const emptyLabel = makeLabel(
		groove,
		"Empty",
		props.empty ?? "",
		TABLE_PAD + space(2),
		listY + TABLE_PAD,
		w - TABLE_PAD * 2 - space(4),
		math.max(rowH, 28),
		TEXT.sm,
		THEME.mutedForeground,
		{ zIndex: z + 2 },
	);
	setVisible(emptyLabel, false);

	// ---- the header
	const paintHeader = (col: TableColumn, v: HeaderView): void => {
		const on = sort !== undefined && sort.column === col.key;
		const gs = v.button.GuiState;
		const hot = col.sortable === true && (gs === Enum.GuiState.Hover || gs === Enum.GuiState.Press);
		let state: PlateState = "flat";
		if (on) state = gs === Enum.GuiState.Press ? "press" : hot ? "hot" : "idle";
		else if (hot) state = "hot";
		paintPlate(v.button, on ? THEME.tabActive : SURFACE.cellLabel, state, HEADER_UNIT);
		v.up.Visible = on && sort !== undefined && !sort.descending;
		v.down.Visible = on && sort !== undefined && sort.descending;
	};
	const paintHeaders = (): void => {
		for (const col of columns) {
			const v = headers.get(col.key);
			if (v !== undefined) paintHeader(col, v);
		}
	};

	const buildHeader = (host: GuiObject, x0: number, y0: number): void => {
		for (let i = 0; i < columns.size(); i++) {
			const col = columns[i];
			const [cx, cw] = spans[i];
			const b = new Instance("TextButton");
			b.Name = `Head${col.key}`;
			b.AutoButtonColor = false;
			b.BorderSizePixel = 0;
			b.BackgroundTransparency = 1;
			b.BackgroundColor3 = THEME.background;
			b.Text = "";
			b.TextColor3 = THEME.foreground;
			// the pad sorts with the sort bar, never by aiming at a header
			b.Selectable = false;
			b.ZIndex = z + 2;
			const gap = TABLE_GAP / 2;
			const [hw, hh] = designSpace(host);
			b.Position = UDim2.fromScale((x0 + cx + gap) / hw, y0 / hh);
			b.Size = UDim2.fromScale((cw - gap * 2) / hw, headerH / hh);
			setDesign(b, cw - gap * 2, headerH);
			const align = alignOf(col);
			const labelX = align === "right" ? cellPad + ARROW_W : cellPad;
			const label = makeLabel(
				b,
				"Label",
				col.header,
				labelX,
				0,
				cw - gap * 2 - cellPad * 2 - ARROW_W,
				headerH,
				TEXT.sm,
				THEME.foreground,
				{ font: BOLD, align, zIndex: b.ZIndex + 1 },
			);
			label.TextWrapped = false;
			// the direction arrow sits on the side away from the text
			const ax = align === "right" ? cellPad - 1 : cw - gap * 2 - cellPad - 5;
			const holder = makeFrame(b, "Arrow", ax, (headerH - 5) / 2, 5, 5, THEME.background, {
				transparency: 1,
				zIndex: b.ZIndex + 1,
			});
			const up = arrow(holder, "Up", true, b.ZIndex + 2);
			const down = arrow(holder, "Down", false, b.ZIndex + 2);
			up.Position = UDim2.fromScale(0, 0.2);
			down.Position = UDim2.fromScale(0, 0.2);
			up.Size = UDim2.fromScale(1, 0.6);
			down.Size = UDim2.fromScale(1, 0.6);
			const v: HeaderView = { button: b, label, up, down };
			headers.set(col.key, v);
			b.GetPropertyChangedSignal("GuiState").Connect(() => paintHeader(col, v));
			if (col.sortable === true && props.sortValue !== undefined) {
				b.Activated.Connect(() => {
					const same = sort !== undefined && sort.column === col.key;
					handle.setSort({
						column: col.key,
						descending: same ? !sort!.descending : col.descendingFirst === true,
					});
				});
			} else {
				b.Active = false;
			}
			b.Parent = host;
			paintHeader(col, v);
		}
	};

	if (headerMode === "sticky") {
		buildHeader(groove, TABLE_PAD, TABLE_PAD);
	} else if (headerMode === "inline") {
		const holder = new Instance("Frame");
		holder.Name = "Header";
		holder.BackgroundTransparency = 1;
		holder.BackgroundColor3 = THEME.background;
		holder.BorderSizePixel = 0;
		holder.LayoutOrder = -1;
		setDesign(holder, rowW, headerH);
		sizeRow(list, holder, headerH);
		holder.Parent = list.frame;
		buildHeader(holder, 0, 0);
	}

	// ---- the rows (a pool)
	const paintRow = (r: RowView): void => {
		const gs = r.button.GuiState;
		const hover = selectable && (gs === Enum.GuiState.Hover || gs === Enum.GuiState.Press);
		let ring = SURFACE.line;
		if (r.selected) ring = THEME.tabActive;
		else if (selectable && isFocused(r.button)) ring = THEME.ring;
		else if (hover || r.marked) ring = THEME.secondary;
		paintPlate(r.button, face, "outline", ROW_UNIT, ring);
	};

	const makeRow = (index: number): RowView => {
		const b = new Instance("TextButton");
		b.Name = `Row${index}`;
		b.AutoButtonColor = false;
		b.BorderSizePixel = 0;
		b.BackgroundTransparency = 1;
		b.BackgroundColor3 = THEME.background;
		b.Text = "";
		b.TextColor3 = THEME.foreground;
		b.Selectable = selectable;
		b.Active = selectable;
		// a display-only row takes no input at all: a HUD table (the scoreboard) must never swallow a thumb or a click
		b.Interactable = selectable;
		b.ZIndex = z + 2;
		b.LayoutOrder = index;
		// the row's design space is its REAL width (the list less its padding and the bar's gutter), so the cells sit
		// exactly under the header's
		setDesign(b, rowW, rowH);
		sizeRow(list, b, rowH);
		const cells: Array<CellView> = [];
		for (let i = 0; i < columns.size(); i++) {
			const col = columns[i];
			const [cx, cw] = spans[i];
			const align = alignOf(col);
			const two = col.sub === true;
			const mainH = two ? rowH * 0.56 : rowH;
			const label = makeLabel(
				b,
				`C${col.key}`,
				"",
				cx + cellPad,
				two ? rowH * 0.06 : 0,
				cw - cellPad * 2,
				mainH,
				textSize,
				THEME.foreground,
				{
					font: col.numeric === true ? "numeric" : i === 0 ? BOLD : "label",
					align,
					valign: two ? "bottom" : undefined,
					zIndex: b.ZIndex + 1,
				},
			);
			label.TextWrapped = false;
			label.TextTruncate = Enum.TextTruncate.AtEnd;
			const view: CellView = { label, text: "", subText: "" };
			if (two) {
				const sub = makeLabel(
					b,
					`S${col.key}`,
					"",
					cx + cellPad,
					rowH * 0.6,
					cw - cellPad * 2,
					rowH * 0.34,
					TEXT.xs,
					THEME.mutedForeground,
					// Regular, the nameplate's title weight in a narrow cell (the colour carries it)
					{ font: "body", align, valign: "top", zIndex: b.ZIndex + 1 },
				);
				sub.TextWrapped = false;
				sub.TextTruncate = Enum.TextTruncate.AtEnd;
				view.sub = sub;
			}
			cells.push(view);
		}
		const r: RowView = { button: b, cells, key: "", selected: false, marked: false };
		registerFocus(b, () => paintRow(r));
		b.GetPropertyChangedSignal("GuiState").Connect(() => paintRow(r));
		if (selectable) {
			b.Activated.Connect(() => {
				if (r.key !== "") handle.select(r.key);
			});
		}
		b.Parent = list.frame;
		paintRow(r);
		return r;
	};

	const compare = (a: T, b: T): boolean => {
		const s = sort;
		const sv = props.sortValue;
		if (s !== undefined && sv !== undefined) {
			const va = sv(a, s.column);
			const vb = sv(b, s.column);
			if (va !== vb) {
				if (typeIs(va, "string") && typeIs(vb, "string")) {
					const la = va.lower();
					const lb = vb.lower();
					if (la !== lb) return s.descending ? la > lb : la < lb;
				} else if (typeIs(va, "number") && typeIs(vb, "number")) {
					return s.descending ? va > vb : va < vb;
				}
			}
		}
		// a tie keeps a stable order by key: a re-sort never shuffles equal rows between frames
		return props.keyOf(a) < props.keyOf(b);
	};

	const writeCell = (view: CellView, col: TableColumn, item: T): void => {
		out.text = "";
		out.color = undefined;
		out.sub = undefined;
		out.subColor = undefined;
		props.cell(item, col.key, out);
		if (view.text !== out.text) {
			view.text = out.text;
			view.label.Text = out.text;
		}
		const color = out.color ?? THEME.foreground;
		if (view.color !== color) {
			view.color = color;
			view.label.TextColor3 = color;
		}
		const sub = view.sub;
		if (sub !== undefined) {
			const st = out.sub ?? "";
			if (view.subText !== st) {
				view.subText = st;
				sub.Text = st;
			}
			const sc = out.subColor ?? THEME.mutedForeground;
			if (view.subColor !== sc) {
				view.subColor = sc;
				sub.TextColor3 = sc;
			}
		}
	};

	/** sorts `items` into `shown` and rewrites the rows; creates rows only past the pool's size */
	const render = (): void => {
		shown.clear();
		for (const item of items) shown.push(item);
		if (props.sortValue !== undefined && sort !== undefined && shown.size() > 1) shown.sort(compare);
		shownKeys.clear();
		for (let i = 0; i < shown.size(); i++) {
			const item = shown[i];
			const key = props.keyOf(item);
			shownKeys.push(key);
			let r = rows[i];
			if (r === undefined) {
				r = makeRow(i);
				rows.push(r);
			}
			setVisible(r.button, true);
			const sel = key === selectedKey;
			const marked = props.marked !== undefined && props.marked(item);
			const repaint = r.key !== key || r.selected !== sel || r.marked !== marked;
			r.key = key;
			r.selected = sel;
			r.marked = marked;
			for (let c = 0; c < columns.size(); c++) writeCell(r.cells[c], columns[c], item);
			if (repaint) paintRow(r);
		}
		for (let i = shown.size(); i < rows.size(); i++) {
			const r = rows[i];
			if (r.key !== "") {
				r.key = "";
				r.selected = false;
			}
			setVisible(r.button, false);
		}
		setVisible(emptyLabel, shown.size() === 0 && emptyLabel.Text !== "");
	};

	handle = {
		frame: groove,
		list,
		setItems(list: ReadonlyArray<T>): void {
			items = list;
			// a selection whose item left (filtered out, gone) is dropped: an action never targets a hidden row
			if (selectedKey !== undefined && !list.some(it => props.keyOf(it) === selectedKey)) {
				selectedKey = undefined;
				props.onSelect?.(undefined, undefined);
			}
			render();
		},
		refresh(): void {
			render();
		},
		setSort(want: TableSort): void {
			const changed = sort === undefined || sort.column !== want.column || sort.descending !== want.descending;
			sort = { column: want.column, descending: want.descending };
			paintHeaders();
			if (!changed) return;
			render();
			props.onSort?.(sort);
		},
		sort(): TableSort | undefined {
			return sort;
		},
		select(key: string | undefined): void {
			if (key === selectedKey) return;
			selectedKey = key;
			for (const r of rows) {
				const sel = r.key !== "" && r.key === key;
				if (r.selected !== sel) {
					r.selected = sel;
					paintRow(r);
				}
			}
			let item: T | undefined;
			if (key !== undefined) {
				for (const it of items) {
					if (props.keyOf(it) === key) {
						item = it;
						break;
					}
				}
			}
			props.onSelect?.(key, item);
		},
		selected(): string | undefined {
			return selectedKey;
		},
		selectedItem(): T | undefined {
			if (selectedKey === undefined) return undefined;
			for (const it of items) if (props.keyOf(it) === selectedKey) return it;
			return undefined;
		},
		setEmpty(text: string): void {
			if (emptyLabel.Text !== text) emptyLabel.Text = text;
			setVisible(emptyLabel, shown.size() === 0 && text !== "");
		},
		order(): ReadonlyArray<string> {
			return shownKeys;
		},
		columnSpans(): ReadonlyArray<[number, number]> {
			return spans;
		},
		poolSize(): number {
			return rows.size();
		},
		rowButton(i: number): TextButton | undefined {
			return rows[i]?.button;
		},
		headerCell(column: string): TextButton | undefined {
			return headers.get(column)?.button;
		},
	};
	render();
	return handle;
}

// ---------------------------------------------------------------- the sort bar (pad and touch)

export interface SortOption {
	/** the Segmented's label (already translated) */
	label: string;
	column: string;
	descending: boolean;
}

export interface TableSortBarHandle {
	bar: TabsHandle;
	/** marks the option matching `sort` (no callback) */
	sync(sort: TableSort | undefined): void;
	/** moves to the previous / next option and sorts the table (the pad's D-pad) */
	step(dir: number): void;
	index(): number;
}

/**
 * The Segmented "sort by" of a Data table: what a pad or a thumb sorts with instead of a header click. `focusable`
 * false keeps its segments out of the pad's navigation (a HUD panel must never take the pad from the survivor,
 * UI-09): the pad steps it with `step` instead.
 */
export function TableSortBar<T extends defined>(
	parent: Instance,
	name: string,
	props: {
		x: number;
		y: number;
		w: number;
		h: number;
		table: TableHandle<T>;
		options: Array<SortOption>;
		focusable?: boolean;
		textSize?: number;
		zIndex?: number;
	},
): TableSortBarHandle {
	const opts = props.options;
	let current = 0;
	const indexOf = (sort: TableSort | undefined): number => {
		if (sort === undefined) return -1;
		for (let i = 0; i < opts.size(); i++) {
			if (opts[i].column === sort.column && opts[i].descending === sort.descending) return i;
		}
		for (let i = 0; i < opts.size(); i++) if (opts[i].column === sort.column) return i;
		return -1;
	};
	const bar = Segmented(parent, name, {
		x: props.x,
		y: props.y,
		w: props.w,
		h: props.h,
		items: opts.map(o => o.label),
		value: math.max(0, indexOf(props.table.sort())),
		textSize: props.textSize ?? TEXT.sm,
		zIndex: props.zIndex,
		onChange: i => {
			current = i;
			const o = opts[i];
			props.table.setSort({ column: o.column, descending: o.descending });
		},
	});
	if (props.focusable === false) for (const t of bar.triggers) t.Selectable = false;
	current = math.max(0, indexOf(props.table.sort()));
	return {
		bar,
		sync(sort: TableSort | undefined): void {
			const i = indexOf(sort);
			if (i < 0 || i === current) return;
			current = i;
			bar.setActive(i);
		},
		step(dir: number): void {
			const n = opts.size();
			if (n === 0) return;
			current = (((current + dir) % n) + n) % n;
			bar.setActive(current);
			const o = opts[current];
			props.table.setSort({ column: o.column, descending: o.descending });
		},
		index(): number {
			return current;
		},
	};
}
