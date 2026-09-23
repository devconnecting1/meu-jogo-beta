/*
 * The Bag's grid (docs/DESIGN_RULES.md UI-11): square tiles on the dark groove of a section, each showing the item's
 * pixel icon (client/ui/itemIcon.ts), in the vocabulary of the wardrobe's GridTile (UI-07 "Ladrilho"):
 *
 *   dark iron, flat ....... yours                     a pixel check on a dark chip, top left ... EQUIPPED
 *   iron, flat ............ equipped (worn / in hand) "x3" on a dark chip, bottom right ........ how many
 *   blue, raised .......... selected                  yellow number, bottom left .............. ammo of a gun
 *   dark socket in `line` . an empty cell            station glyph, top right ................ a recipe's station
 *                                                      padlock over a grey icon ................ locked by station
 *                                                      three pips on a dark strip, bottom ...... a skill's level
 *
 * A grid is built for one tab and kept (the Bag shows / hides it). Its tiles are a POOL keyed by what they show, like
 * the old list's RowPool: a render hands each tile back to the key it showed last time (so a tile whose item did not
 * change has nothing to rewrite, and a re-sort only moves tiles), gives a new key a tile a vanished key left behind,
 * and only creates a tile when there is none. The empty cells after the last item (enough to fill the visible rows)
 * are tiles too, keyed by position: an item used up hands its tile to the empty cell that appears, so using the last
 * one creates nothing.
 *
 * Rows are the kit's list rows (a ScrollList, so the groove scrolls when the items overflow it) and a tile moves
 * between rows by reparenting. The icon of a tile is drawn when its row is on screen or next to it (reveal): the
 * Craft grid has 80 recipes, and the rows nobody scrolled to cost no icon Frames until they are scrolled to.
 */
import { GAME, STAT, SURFACE, TEXT, THEME, fontOf, space } from "./theme";
import { PlateState, drawPadlock, paintPlate, reliefPx } from "./plate";
import { IconView, clearIcon, drawIcon } from "./itemIcon";
import { Groove, Section } from "./window";
import {
	ScrollList,
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

// ---------------------------------------------------------------- geometry (design units)

/** a tile's side: 72 x the UI scale is 50 px on a 1360 x 435 phone and 45 px on an 844 x 390 one (MIN_TOUCH_PX 44) */
export const TILE = 72;
export const TILE_GAP = 8;
export const COLS = 5;
/** a row: the tile and half a gap above and under it */
export const PITCH = TILE + TILE_GAP;
/** the groove's margin left and right of the tiles (above and under: half a gap in the row + the list's padding) */
const EDGE = 8;
export const VISIBLE_ROWS = 5;
export const GROOVE_W = EDGE * 2 + COLS * TILE + (COLS - 1) * TILE_GAP;
export const GROOVE_H = VISIBLE_ROWS * PITCH + EDGE;
/** the section around the groove */
const INSET = space(4);
export const GRID_W = GROOVE_W + INSET * 2;
export const GRID_H = GROOVE_H + INSET * 2;
/** the least cells a grid shows: the visible rows, filled with empty cells */
const MIN_CELLS = COLS * VISIBLE_ROWS;

/** inside a tile */
const ICON = 48;
const ICON_X = (TILE - ICON) / 2;
const ICON_Y = 8;
const CHIP_H = 16;
const CHIP_Y = TILE - CHIP_H - 4;
const COUNT_W = 34;
const AMMO_W = 30;
const TAG = 16;
const CORNER = 12;
const LOCK_W = 14;
const LOCK_H = 18;
const PIP_W = 10;
const PIP_H = 5;
const PIP_GAP = 3;
const TILE_UNIT = 4;
const SOCKET_UNIT = 2;

const NUMERIC = fontOf("mono", Enum.FontWeight.Bold);

// ---------------------------------------------------------------- the model

/** what one tile shows, computed from the save by the Bag (plain data: two equal models draw the same tile) */
export interface TileModel {
	/** unique in its grid: "w:10", "r:4"... (the Bag's selection is a key) */
	key: string;
	/** the item's name (the hover card and the tests read it) */
	name: string;
	/** ITEM_ICONS key */
	icon: string;
	/** drawn in grey: not available now */
	dim: boolean;
	/** the iron face of what is worn or in hand */
	equipped: boolean;
	/** the check chip at the top left */
	tag: boolean;
	/** bottom right, e.g. "x3" ("" = no chip); `short` draws it in the red of a penalty */
	count: string;
	short: boolean;
	/** bottom left in the yellow of numbers: a gun's reserve ("" = none) */
	ammo: string;
	/** ICON_GLYPHS key at the top right: a recipe's station ("" = none) */
	corner: string;
	/** the padlock over the icon */
	locked: boolean;
	/** a skill's level pips: how many, how many lit (0 = none) */
	pips: number;
	pipsOn: number;
}

function modelSig(m: TileModel): string {
	return `${m.icon}|${m.dim}|${m.equipped}|${m.tag}|${m.count}|${m.short}|${m.ammo}|${m.corner}|${m.locked}|${m.pips}|${m.pipsOn}`;
}

// ---------------------------------------------------------------- a tile

/** a small dark chip with one line of text (count, ammo) */
interface Chip {
	frame: Frame;
	label: TextLabel;
}

export interface BagTile {
	button: TextButton;
	icon: IconView;
	/** the key it shows ("" = spare), and its model (undefined = an empty cell) */
	key: string;
	model: TileModel | undefined;
	/** what its chips and face were written for ("" = never) */
	shown: string;
	/** the icon it should show, and the one drawn ("" = none) */
	wantIcon: string;
	wantDim: boolean;
	drawnIcon: string;
	drawnDim: boolean;
	row: number;
	col: number;
	selected: boolean;
	count?: Chip;
	ammo?: Chip;
	corner?: IconView;
	tag?: Frame;
	lock?: Frame;
	pips?: Array<Frame>;
	pipStrip?: Frame;
}

/** the plate of a tile from its state and the pointer / pad on it (GridTile's rule) */
function paintTile(t: BagTile): void {
	const b = t.button;
	if (t.model === undefined) {
		paintPlate(b, SURFACE.well, "outline", SOCKET_UNIT, SURFACE.line);
		return;
	}
	const gs = b.GuiState;
	const pressed = gs === Enum.GuiState.Press;
	const hot = isFocused(b) || gs === Enum.GuiState.Hover || pressed;
	const face = t.selected ? THEME.tabActive : t.model.equipped ? THEME.secondary : SURFACE.section;
	const rest: PlateState = t.selected ? "idle" : "flat";
	paintPlate(b, face, pressed ? "press" : hot ? "hot" : rest, TILE_UNIT);
}

function makeChip(parent: GuiObject, name: string, x: number, w: number, color: Color3, z: number): Chip {
	const frame = makeFrame(parent, name, x, CHIP_Y, w, CHIP_H, SURFACE.well, { zIndex: z });
	const label = makeLabel(frame, "Text", "", 1, 0, w - 2, CHIP_H, TEXT.xs, color, { font: NUMERIC, zIndex: z + 1 });
	return { frame, label };
}

function setChip(chip: Chip | undefined, text: string, color: Color3): void {
	if (chip === undefined) return;
	const on = text !== "";
	if (chip.frame.Visible !== on) chip.frame.Visible = on;
	if (!on) return;
	if (chip.label.Text !== text) chip.label.Text = text;
	if (chip.label.TextColor3 !== color) chip.label.TextColor3 = color;
}

// ---------------------------------------------------------------- the grid

export interface GridHandlers {
	/** a tile was clicked / tapped (or selected with the pad): select its item */
	onSelect: (key: string) => void;
	/** the pointer is on `tile` (on = true) or left it; a tile without an item is never "on" */
	onHover: (tile: BagTile, on: boolean) => void;
}

export class BagGrid {
	/** the section plate (the Bag shows / hides it with its tab) */
	readonly frame: Frame;
	readonly list: ScrollList;
	/** tiles by the key they show (items and empty cells) */
	private byKey = new Map<string, BagTile>();
	/** tiles no key uses: hidden, kept for the next new key */
	private spare: Array<BagTile> = [];
	private readonly rows: Array<Frame> = [];
	private built = 0;
	private rowsShown = 0;
	private selectedKey = "";
	private readonly handlers: GridHandlers;
	/** the render's signature: a render with the same models writes nothing */
	private sig = "";

	constructor(parent: Instance, name: string, x: number, y: number, handlers: GridHandlers) {
		this.handlers = handlers;
		const sec = Section(parent, name, { x, y, w: GRID_W, h: GRID_H });
		this.frame = sec.frame;
		const groove = Groove(sec.frame, "Groove", INSET, INSET, GROOVE_W, GROOVE_H);
		groove.ZIndex = sec.frame.ZIndex + 1;
		const list = makeScrollList(groove, "List", 0, 0, GROOVE_W, GROOVE_H, { zIndex: groove.ZIndex + 1 });
		// the rows carry their own gaps; the thin scroll bar rides over the right margin, not over the tiles
		list.layout.Padding = new UDim(0, 0);
		list.frame.VerticalScrollBarInset = Enum.ScrollBarInset.None;
		const pad = list.frame.FindFirstChildOfClass("UIPadding");
		onLayoutChange(list.frame, () => {
			const p = reliefPx(EDGE / 2);
			if (pad !== undefined) {
				pad.PaddingTop = new UDim(0, p);
				pad.PaddingBottom = new UDim(0, p);
				pad.PaddingRight = new UDim(0, 0);
			}
		});
		this.list = list;
		// the icons of rows coming on screen are drawn as they come
		list.frame.GetPropertyChangedSignal("CanvasPosition").Connect(() => this.reveal());
		list.frame.GetPropertyChangedSignal("AbsoluteSize").Connect(() => this.reveal());
	}

	/** the tile showing `key` (undefined: none) */
	tileOf(key: string): BagTile | undefined {
		return this.byKey.get(key);
	}

	/** every tile that shows an item, in grid order */
	itemTiles(): Array<BagTile> {
		const out: Array<BagTile> = [];
		for (const [, t] of this.byKey) if (t.model !== undefined) out.push(t);
		out.sort((a, b) => a.row * COLS + a.col < b.row * COLS + b.col);
		return out;
	}

	/** shows `models` in order, then as many empty cells as fill the visible rows; writes only what changed */
	render(models: Array<TileModel>): void {
		let sig = "";
		for (const m of models) sig += `${m.key}=${modelSig(m)};`;
		if (sig === this.sig) return;
		this.sig = sig;
		const n = models.size();
		const cells = math.max(MIN_CELLS, math.ceil(n / COLS) * COLS);
		const keys: Array<string> = [];
		for (let i = 0; i < cells; i++) keys.push(i < n ? models[i].key : `#${i}`);
		// every key keeps the tile it had; the rest are free for the new keys
		const kept = new Map<string, BagTile>();
		for (const k of keys) {
			const t = this.byKey.get(k);
			if (t === undefined) continue;
			kept.set(k, t);
			this.byKey.delete(k);
		}
		const free = this.spare;
		for (const [, t] of this.byKey) free.push(t);
		this.byKey = kept;
		const rowCount = math.ceil(cells / COLS);
		this.ensureRows(rowCount);
		for (let i = 0; i < cells; i++) {
			const k = keys[i];
			let t = kept.get(k);
			if (t === undefined) {
				t = free.pop() ?? this.makeTile();
				kept.set(k, t);
			}
			this.put(t, i);
			this.fill(t, k, i < n ? models[i] : undefined);
		}
		for (const t of free) {
			t.key = "";
			setVisible(t.button, false);
		}
		this.spare = free;
		this.reveal();
	}

	/** marks the tile of `key` as the selection (the blue raised plate); "" = none */
	setSelected(key: string): void {
		if (key === this.selectedKey) return;
		const old = this.byKey.get(this.selectedKey);
		this.selectedKey = key;
		if (old !== undefined && old.selected) {
			old.selected = false;
			paintTile(old);
		}
		const t = this.byKey.get(key);
		if (t !== undefined && t.model !== undefined && !t.selected) {
			t.selected = true;
			paintTile(t);
		}
	}

	/** the rows the list shows now, give or take one (all of the first ones before any layout) */
	private visibleRows(): [number, number] {
		const f = this.list.frame;
		const w = f.AbsoluteSize.X;
		const rowPx = w > 1 ? (w * PITCH) / GROOVE_W : 0;
		if (rowPx <= 0) return [0, VISIBLE_ROWS];
		const top = f.CanvasPosition.Y;
		return [math.floor(top / rowPx) - 1, math.floor((top + f.AbsoluteSize.Y) / rowPx) + 1];
	}

	/** draws the icons of the tiles on (or next to) the screen whose icon is not drawn yet */
	private reveal(): void {
		const [r0, r1] = this.visibleRows();
		for (const [, t] of this.byKey) {
			if (t.row < r0 || t.row > r1) continue;
			if (t.wantIcon === t.drawnIcon && t.wantDim === t.drawnDim) continue;
			t.drawnIcon = t.wantIcon;
			t.drawnDim = t.wantDim;
			if (t.wantIcon === "") clearIcon(t.icon);
			else drawIcon(t.icon, t.wantIcon, { dim: t.wantDim });
		}
	}

	private ensureRows(count: number): void {
		while (this.rows.size() < count) {
			const i = this.rows.size();
			const row = new Instance("Frame");
			row.Name = `Row${i}`;
			row.BackgroundTransparency = 1;
			row.BackgroundColor3 = THEME.background;
			row.BorderSizePixel = 0;
			row.LayoutOrder = i;
			setDesign(row, GROOVE_W, PITCH);
			sizeRow(this.list, row, PITCH);
			row.Parent = this.list.frame;
			this.rows.push(row);
		}
		if (count === this.rowsShown) return;
		this.rowsShown = count;
		for (let i = 0; i < this.rows.size(); i++) {
			const on = i < count;
			if (this.rows[i].Visible !== on) this.rows[i].Visible = on;
		}
	}

	/** moves tile `t` to cell `i` (another row = a reparent; another column = a new position) */
	private put(t: BagTile, i: number): void {
		const row = math.floor(i / COLS);
		const col = i % COLS;
		if (row !== t.row) {
			t.row = row;
			t.button.Parent = this.rows[row];
		}
		if (col !== t.col) {
			t.col = col;
			t.button.Position = UDim2.fromScale((EDGE + col * PITCH) / GROOVE_W, TILE_GAP / 2 / PITCH);
		}
		setVisible(t.button, true);
	}

	private makeTile(): BagTile {
		const index = this.built;
		this.built += 1;
		const b = new Instance("TextButton");
		b.Name = `Tile${index}`;
		b.Size = UDim2.fromScale(TILE / GROOVE_W, TILE / PITCH);
		setDesign(b, TILE, TILE);
		b.AutoButtonColor = false;
		b.BorderSizePixel = 0;
		b.BackgroundTransparency = 1;
		b.BackgroundColor3 = THEME.background;
		b.Text = "";
		b.TextColor3 = THEME.foreground;
		b.ZIndex = 2;
		const icon = IconView(b, "ItemIcon", ICON_X, ICON_Y, ICON, 3);
		const t: BagTile = {
			button: b,
			icon,
			key: "",
			model: undefined,
			shown: "",
			wantIcon: "",
			wantDim: false,
			drawnIcon: "",
			drawnDim: false,
			row: -1,
			col: -1,
			selected: false,
		};
		registerFocus(b, () => paintTile(t));
		b.GetPropertyChangedSignal("GuiState").Connect(() => {
			paintTile(t);
			const gs = b.GuiState;
			this.handlers.onHover(
				t,
				t.model !== undefined && (gs === Enum.GuiState.Hover || gs === Enum.GuiState.Press),
			);
		});
		b.Activated.Connect(() => {
			if (t.model !== undefined) this.handlers.onSelect(t.model.key);
		});
		// the pad's selection on a tile selects its item: the details panel follows the cursor (no tooltip on the pad)
		b.SelectionGained.Connect(() => {
			if (t.model !== undefined) this.handlers.onSelect(t.model.key);
		});
		return t;
	}

	/** writes model `m` (undefined: an empty cell) on tile `t`, creating a chip only the first time one is needed */
	private fill(t: BagTile, key: string, m: TileModel | undefined): void {
		t.key = key;
		// the key too: two items can draw the same tile (a wooden stick and a crowbar are both the blunt category)
		const sig = m === undefined ? "#" : `${m.key}|${modelSig(m)}`;
		t.model = m;
		const selected = m !== undefined && m.key === this.selectedKey;
		if (sig === t.shown && selected === t.selected) return;
		t.shown = sig;
		t.selected = selected;
		const b = t.button;
		const z = b.ZIndex;
		b.Selectable = m !== undefined;
		b.SetAttribute("Key", m !== undefined ? m.key : "");
		t.wantIcon = m !== undefined ? m.icon : "";
		t.wantDim = m !== undefined && m.dim;
		const need = (on: boolean, made: unknown): boolean => on && made === undefined;
		const count = m !== undefined ? m.count : "";
		if (need(count !== "", t.count)) {
			t.count = makeChip(b, "Count", TILE - COUNT_W - 4, COUNT_W, THEME.foreground, z + 4);
		}
		setChip(t.count, count, m !== undefined && m.short ? STAT.penalty : THEME.foreground);
		const ammo = m !== undefined ? m.ammo : "";
		if (need(ammo !== "", t.ammo)) t.ammo = makeChip(b, "Ammo", 4, AMMO_W, STAT.value, z + 4);
		setChip(t.ammo, ammo, STAT.value);
		const corner = m !== undefined ? m.corner : "";
		if (need(corner !== "", t.corner)) t.corner = IconView(b, "Station", TILE - CORNER - 5, 5, CORNER, z + 4);
		if (t.corner !== undefined) {
			if (corner !== "") drawIcon(t.corner, corner, { ink: THEME.foreground });
			else clearIcon(t.corner);
		}
		const tag = m !== undefined && m.tag;
		if (need(tag, t.tag)) {
			const chip = makeFrame(b, "Tag", 4, 4, TAG, TAG, SURFACE.well, { zIndex: z + 4 });
			drawIcon(IconView(chip, "Check", 3, 3, TAG - 6, z + 5), "check", { ink: GAME.success });
			t.tag = chip;
		}
		if (t.tag !== undefined && t.tag.Visible !== tag) t.tag.Visible = tag;
		const locked = m !== undefined && m.locked;
		if (need(locked, t.lock)) {
			const lock = makeFrame(
				b,
				"Lock",
				(TILE - LOCK_W) / 2,
				ICON_Y + (ICON - LOCK_H) / 2,
				LOCK_W,
				LOCK_H,
				THEME.background,
				{
					transparency: 1,
					zIndex: z + 4,
				},
			);
			drawPadlock(lock, THEME.foreground, THEME.background, z + 4);
			t.lock = lock;
		}
		if (t.lock !== undefined && t.lock.Visible !== locked) t.lock.Visible = locked;
		this.fillPips(t, m);
		paintTile(t);
	}

	/** a skill's level: pips lit in the XP blue on a dark strip at the bottom of the tile */
	private fillPips(t: BagTile, m: TileModel | undefined): void {
		const count = m !== undefined ? m.pips : 0;
		if (count > 0 && t.pipStrip === undefined) {
			const most = 3;
			const w = most * PIP_W + (most - 1) * PIP_GAP + 6;
			const strip = makeFrame(t.button, "Pips", (TILE - w) / 2, TILE - PIP_H - 10, w, PIP_H + 4, SURFACE.well, {
				zIndex: t.button.ZIndex + 4,
			});
			const pips: Array<Frame> = [];
			for (let p = 0; p < most; p++) {
				pips.push(
					makeFrame(strip, `Pip${p}`, 3 + p * (PIP_W + PIP_GAP), 2, PIP_W, PIP_H, SURFACE.line, {
						zIndex: strip.ZIndex + 1,
					}),
				);
			}
			t.pipStrip = strip;
			t.pips = pips;
		}
		const strip = t.pipStrip;
		const pips = t.pips;
		if (strip === undefined || pips === undefined) return;
		if (strip.Visible !== count > 0) strip.Visible = count > 0;
		if (count <= 0) return;
		const w = count * PIP_W + (count - 1) * PIP_GAP + 6;
		strip.Size = UDim2.fromScale(w / TILE, (PIP_H + 4) / TILE);
		strip.Position = UDim2.fromScale((TILE - w) / 2 / TILE, (TILE - PIP_H - 10) / TILE);
		setDesign(strip, w, PIP_H + 4);
		for (let p = 0; p < pips.size(); p++) {
			const on = p < count;
			if (pips[p].Visible !== on) pips[p].Visible = on;
			const c = p < (m?.pipsOn ?? 0) ? GAME.xp : SURFACE.line;
			if (pips[p].BackgroundColor3 !== c) pips[p].BackgroundColor3 = c;
			pips[p].Position = UDim2.fromScale((3 + p * (PIP_W + PIP_GAP)) / w, 2 / (PIP_H + 4));
			pips[p].Size = UDim2.fromScale(PIP_W / w, PIP_H / (PIP_H + 4));
		}
	}
}
