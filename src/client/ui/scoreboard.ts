/*
 * The match scoreboard (docs/DESIGN_RULES.md MP-23, UI-12): who is in this town right now, as a DATA table in the
 * window vocabulary of UI-07 -- the survivor (name, and the title under it in its colour, MON-05), level, the day of
 * THIS life, the zombies put down, and whether they are up, down, or dead until dawn (MP-21).
 *
 *   ┌──────────── Brackenmere · Survivors · 3 / 6 ───────── X ┐
 *   │ Sort by              [Life day][Level][Put down][Name] │   <- pad and touch; the mouse clicks a header
 *   │ ┌ Survivor ─────── Lv ─ Life day ─ Put down ─ Status ┐ │
 *   │ │ Marta              12         9        137   Alive │ │
 *   │ │ [Horde Breaker]                                    │ │
 *   │ │ Ana                 5         5         12   Dead  │ │
 *   │ │                                        until dawn  │ │
 *   │ └────────────────────────────────────────────────────┘ │
 *   └───────────────────────────────────────────────────────┘
 *
 * How it opens: HOLD Q (release closes it), a tap or click on the survivors chip, or the pad's Back / Select (press
 * again to close). Not Tab: the Roblox player list owns it (UI-02); Select is freed for this by turning off the
 * engine's Select-to-pick-a-GUI (client/bootstrap.ts, `AutoSelectGuiEnabled`), which the kit never needed -- every
 * screen focuses itself.
 *
 * The chip goes where the Bag and the Menu go on the device (hud.ts gives it a slot to fill), and it looks like them:
 * iron and raised (the kit's secondary button), blue while the board is open. On desktop the third plate of the
 * console's button row, after Bag and Menu (hudConsole.ts chipSlot, style "console": the icon, the count and Q /
 * Back); on touch the corner row of Menu and Bag, left of Menu, over the day clock (hudConsole.ts placeTouchChip,
 * style "corner": as tall as the sky's plate, the icon and the count large, a thumb target). The day plate it used to
 * stand beside moved into the console (UI-09).
 *
 * What it never does: pause (UI-06 -- it is part of the HUD, the loop goes on and so does the survivor: holding Q you
 * still walk and shoot), hide the world (no scrim, no input blocker; the panel sits at the left, clear of the survivor
 * in the middle of the screen, of the day clock and of the console), or take the pad from the survivor (nothing in it
 * is selectable; the pad steps the sort with the D-pad while it is open). On a short phone the open panel can reach
 * down to where the move stick rests: the touch controls are drawn above it and the panel does not take their touches
 * (only its X, its headers and its sort bar are buttons), so the stick still works.
 *
 * The numbers are the SERVER's: the roster (PlayerJoined / PlayerProfile / PlayerLife) and, for the day of each life
 * and the kills, `PlayerTally` (shared/net/protocol.ts note 15). Offline it is just you, from your own save.
 *
 * Built once per HUD mount -- the table's pool is warmed to MAX_PLAYERS rows at once -- so opening, closing, sorting
 * and the live refresh (4 times a second while open) create no Instance (test:tables).
 */
import { GameContext } from "shared/game/context";
import { TITLES, titleFromWire } from "shared/data/titles";
import { townNameOf } from "shared/data/townNames";
import { MAX_PLAYERS } from "shared/net/mpConfig";
import { LifeState } from "shared/net/protocol";
import { RosterView, netActive, netHosted, netRoster, netTownSeed } from "../net/netClient";
import { paintPlate } from "./plate";
import type { PxRect } from "./hudConsole";
import { Px, pixelIcon } from "./hudSky";
import { STAT, TEXT, THEME, fontOf } from "./theme";
import { titleColor, titleText } from "./titleStyle";
import {
	SortOption,
	Table,
	TableCell,
	TableColumn,
	TableHandle,
	TableSortBar,
	TableSortBarHandle,
	fitText,
} from "./table";
import {
	DESIGN_H,
	DESIGN_W,
	cardHeaderHeight,
	fmtInt,
	makeFrame,
	makeLabel,
	onLayoutChange,
	scaleText,
	setDesign,
	setVisible,
	topInset,
	viewportSize,
} from "./widgets";
import * as Kit from "./window";

const UserInputService = game.GetService("UserInputService");
const GuiService = game.GetService("GuiService");
const BOLD = fontOf("sans", Enum.FontWeight.Bold);

/**
 * the chip's icon: a survivor's head and shoulders (pixelIcon.ts "people", the lobby's "in town") redrawn on the 7 x 7
 * grid of the console's Bag and Menu icons (hudSky.ts pixelIcon: Frames that fill their host, so it scales with the
 * chip on desktop and on touch alike)
 */
const PEOPLE: Array<Px> = [
	[2, 0, 3, 2],
	[1, 3, 5, 1],
	[0, 4, 7, 1],
	[0, 5, 1, 1],
	[2, 5, 3, 1],
	[6, 5, 1, 1],
	[2, 6, 1, 1],
	[4, 6, 1, 1],
];

/** alive / down (MP-03, bleeding) / dead until dawn (the server stands them up at 06:00, MP-21) / dead offline */
export type ScoreStatus = "alive" | "down" | "dawn" | "dead";

/** one survivor on the scoreboard */
export interface ScoreEntry {
	key: string;
	name: string;
	you: boolean;
	level: number;
	/** a TITLES id, -1 = none */
	title: number;
	/** this life's day, 0 = not known yet */
	lifeDay: number;
	/** zombies put down, -1 = not known yet */
	kills: number;
	status: ScoreStatus;
}

/** fills `out` (entries reused) with who is in the town now; returns it */
export type ScoreSource = (out: Array<ScoreEntry>) => Array<ScoreEntry>;

const STATUS_ORDER: Record<ScoreStatus, number> = { alive: 0, down: 1, dawn: 2, dead: 3 };
/** the status word, and the line under it (lang keys) */
const STATUS_TEXT: Record<ScoreStatus, [string, string]> = {
	alive: ["Alive", ""],
	down: ["Down", ""],
	dawn: ["Dead", "until dawn"],
	dead: ["Dead", ""],
};

/** the colour of a status on the row (SURFACE.row; every one 4,5:1 there, test:contrast) */
export function scoreStatusColor(status: ScoreStatus): Color3 {
	if (status === "alive") return STAT.bonus;
	if (status === "down") return STAT.effect;
	return THEME.mutedForeground;
}

function entryAt(out: Array<ScoreEntry>, i: number): ScoreEntry {
	let e = out[i];
	if (e === undefined) {
		e = { key: "", name: "", you: false, level: 0, title: -1, lifeDay: 0, kills: -1, status: "alive" };
		out[i] = e;
	}
	return e;
}

/**
 * The roster as scoreboard rows (pure: test:tables feeds it the roster a client would hold). `hosted` = the server
 * owns deaths and stands the dead up at daybreak (MP-21): a dead body is then "dead until dawn".
 */
export function rosterToEntries(
	roster: ReadonlyArray<RosterView>,
	hosted: boolean,
	out: Array<ScoreEntry>,
): Array<ScoreEntry> {
	for (let i = 0; i < roster.size(); i++) {
		const v = roster[i];
		const e = entryAt(out, i);
		e.key = tostring(v.userId);
		e.name = v.displayName;
		e.you = v.you;
		e.level = v.level;
		e.title = titleFromWire(v.title);
		e.lifeDay = v.lifeDay;
		e.kills = v.kills;
		if (v.life === LifeState.Downed) e.status = "down";
		else if (v.life === LifeState.Dead) e.status = hosted ? "dawn" : "dead";
		else e.status = "alive";
	}
	while (out.size() > roster.size()) out.pop();
	return out;
}

/** the game's own source: the server's roster in a session, your own save offline */
export function scoreSourceOf(ctx: GameContext): ScoreSource {
	const views = new Array<RosterView>();
	return (out: Array<ScoreEntry>): Array<ScoreEntry> => {
		if (netActive()) return rosterToEntries(netRoster(views), netHosted(), out);
		// offline (or before the handshake): the town is yours alone, from your own save
		const e = entryAt(out, 0);
		const me = game.GetService("Players").LocalPlayer as Player | undefined;
		e.key = me !== undefined ? tostring(me.UserId) : "you";
		e.name = me !== undefined ? me.DisplayName : "Survivor";
		e.you = true;
		e.level = ctx.save.level;
		e.title = ctx.save.equipTitle >= 0 && ctx.save.equipTitle < TITLES.size() ? ctx.save.equipTitle : -1;
		e.lifeDay = ctx.save.day;
		e.kills = ctx.save.zombieKills;
		e.status = ctx.phase === "dead" ? "dead" : "alive";
		while (out.size() > 1) out.pop();
		return out;
	};
}

// ---------------------------------------------------------------- layout (design units of the 1120 x 630 space)

/** the panel's margins from the screen's left edge and from under the bar (design units of the HUD's 1120 x 630) */
const PANEL_X = 16;
/**
 * a band under the bar left above it (where the day plate's row was): the Roblox buttons' corner and the top of the
 * messages; the full town still fits above the console at the largest HUD size (it ends at 436, the console's top is
 * at 481 there)
 */
const PANEL_Y = 66;
/** ends at x = 536 at 16:9 (further left on a wider screen), left of the survivor in the middle (x = 560) */
const PANEL_W = 520;
const PAD = 12;
const TITLE_SIZE = TEXT.xl;
const BAR_H = 30;
const ROW_H = 38;
const HEAD_H = 24;
/** tight cells: a phone draws text at the 9 px floor, which is ~9 design units a character there */
const CELL_PAD = 5;
const TABLE_W = PANEL_W - PAD * 2;
/** the sort bar, right-aligned in the caption row: four segments of ~79 units, a thumb wide on a phone */
const SORT_W = 330;
/**
 * the touch chip's width, in the design units of the sky's plate (hudSky.ts SKY_PLATE_H tall): the icon and the count
 * -- touch has no key to show -- and at least a thumb wide on every phone (hudConsole.ts placeTouchChip)
 */
export const SCORE_CHIP_TOUCH_W = 64;

/**
 * How the chip is laid out in its slot -- iron and raised either way, like the buttons it stands with: "console" = a
 * plate of the console's button row (desktop: 76 x 22 like Bag and Menu, the icon, the count and the key); "corner" =
 * a button of the touch corner's row (as tall as the sky's plate: the icon and the count large; touch has no key).
 */
export type ChipStyle = "console" | "corner";

/** the chip's parts in its slot (design units of the slot): the icon's centre and side, the count's box, the key's box */
interface ChipGeom {
	iconX: number;
	iconS: number;
	countX: number;
	countW: number;
	countSize: number;
	keyX: number;
}
function chipGeom(style: ChipStyle): ChipGeom {
	// row: Bag and Menu put their 12-unit icon at 10..22 and their key from 28 (hudConsole.ts makeIconPlate)
	if (style === "console") return { iconX: 16, iconS: 12, countX: 26, countW: 12, countSize: TEXT.sm, keyX: 38 };
	return { iconX: 20, iconS: 18, countX: 34, countW: 26, countSize: TEXT.xl, keyX: 58 };
}

/** sized so every header and every value reads at the 9 px floor on a 844 x 390 phone (test:tables) */
export const SCORE_COLUMNS: Array<TableColumn> = [
	{ key: "name", header: "Survivor", flex: 1, sortable: true, sub: true, raw: true },
	{ key: "level", header: "Lv", width: 36, numeric: true, sortable: true, descendingFirst: true },
	{ key: "lifeDay", header: "Life day", width: 92, numeric: true, sortable: true, descendingFirst: true },
	{ key: "kills", header: "Put down", width: 92, numeric: true, sortable: true, descendingFirst: true },
	{ key: "status", header: "Status", width: 118, sortable: true, sub: true },
];

/** the pad's and the thumb's sort choices (Segmented), in the order the D-pad steps them */
const SORTS: Array<[string, string, boolean]> = [
	["Life day", "lifeDay", true],
	["Level", "level", true],
	["Put down", "kills", true],
	["Name", "name", false],
];

function tableHeight(rows: number): number {
	return HEAD_H + 3 + 6 * 2 + rows * ROW_H + math.max(0, rows - 1) * 3;
}

/** the panel's height for MAX_PLAYERS rows */
export const SCOREBOARD_H = cardHeaderHeight(TITLE_SIZE) + BAR_H + 6 + tableHeight(MAX_PLAYERS) + PAD;

/** the pixel side a touch target may never go under (shared/engine/input.ts MIN_TOUCH_PX) */
const MIN_TOUCH = 44;

/** an invisible hit area over `host`, at least MIN_TOUCH px on each side (a thumb, never smaller than the plate) */
function touchHit(host: GuiObject, onClick: () => void, minSize: boolean): TextButton {
	const hit = new Instance("TextButton");
	hit.Name = "Hit";
	hit.AnchorPoint = new Vector2(0.5, 0.5);
	hit.Position = UDim2.fromScale(0.5, 0.5);
	hit.Size = UDim2.fromScale(1, 1);
	hit.BackgroundTransparency = 1;
	hit.BackgroundColor3 = THEME.background;
	hit.TextColor3 = THEME.foreground;
	hit.Text = "";
	hit.AutoButtonColor = false;
	hit.Selectable = false;
	hit.ZIndex = host.ZIndex + 8;
	if (minSize) {
		const min = new Instance("UISizeConstraint");
		min.MinSize = new Vector2(MIN_TOUCH, MIN_TOUCH);
		min.Parent = hit;
	}
	hit.Activated.Connect(() => onClick());
	hit.Parent = host;
	return hit;
}

export interface ScoreboardOptions {
	/** the player is on a touch screen: thumb-sized hit areas, the sort bar */
	touch: boolean;
	/** how the chip is drawn in the slot hud.ts gives it (see ChipStyle) */
	chipStyle: ChipStyle;
	/** the key legend on the chip ("Q", "Back"; "" on touch) */
	keyLegend: () => string;
	/** a pad is in the player's hands now (the sort bar shows; the D-pad steps it) */
	gamepad: () => boolean;
	source: ScoreSource;
}

export class Scoreboard {
	readonly frame: Frame;
	readonly panel: Frame;
	readonly chip: Frame;
	readonly table: TableHandle<ScoreEntry>;
	readonly sortBar: TableSortBarHandle;
	private readonly tr: (k: string) => string;
	private readonly opts: ScoreboardOptions;
	private readonly entries = new Array<ScoreEntry>();
	private readonly title: TextLabel | undefined;
	private readonly hint: TextLabel;
	private readonly sortCaption: TextLabel;
	private readonly chipCount: TextLabel;
	private readonly chipKey: TextLabel;
	private readonly chipHit: TextButton;
	private readonly chipIcon: Frame;
	private readonly chipGeom: ChipGeom;
	private toggled = false;
	private held = false;
	private open = false;
	private refreshAt = -math.huge;
	private dpad: RBXScriptConnection | undefined;
	private shownCount = -1;
	/** the town the title names (MP-26: its name from the seed the match runs) */
	private shownSeed = -1;
	private sortShown: boolean | undefined;
	private chipText: Color3 | undefined;
	/** what of the HUD's corner the open panel must stay under (touch: the sky and the chip, when they are on the left) */
	private keepClear: ReadonlyArray<PxRect> = [];

	/**
	 * `chipSlot` is the frame the survivors chip fills (hud.ts: the console's button row on desktop, a frame in the touch
	 * corner, placed in pixels): the chip takes the slot's design space, whatever its size on screen.
	 */
	constructor(root: Frame, chipSlot: Frame, tr: (k: string) => string, opts: ScoreboardOptions) {
		this.tr = tr;
		this.opts = opts;
		// pinned to the screen's LEFT edge under the bar, at the scale of the HUD's 1120 x 630 space under the bar (the
		// largest one that fits both ways): on a screen wider than 16:9 (the owner's 1365 x 567 playtest window) it
		// moves away from the survivor in the middle instead of centring with a 16:9 box, and it keeps the size that
		// fits between a band under the bar and the console at the bottom (UI-09). No scrim and no input blocker: the
		// world stays visible and every click outside the panel still reaches the game (UI-06)
		const frame = new Instance("Frame");
		frame.Name = "Scoreboard";
		frame.BackgroundTransparency = 1;
		frame.BackgroundColor3 = THEME.background;
		frame.BorderSizePixel = 0;
		frame.Active = false;
		// above the vignette and the console, under the touch layer (ZIndex 8): the thumbs' controls stay on top
		frame.ZIndex = 6;
		setDesign(frame, PANEL_W, SCOREBOARD_H);
		this.frame = frame;
		onLayoutChange(frame, () => this.placePanel());
		frame.Parent = root;

		const win = Kit.Window(frame, "Panel", {
			x: 0,
			y: 0,
			w: PANEL_W,
			h: SCOREBOARD_H,
			title: tr("Survivors"),
			titleSize: TITLE_SIZE,
			zIndex: 7,
			onClose: () => this.close(),
		});
		this.panel = win.frame;
		const titleLabel = win.frame.FindFirstChild("Title");
		this.title = titleLabel !== undefined && titleLabel.IsA("TextLabel") ? titleLabel : undefined;
		// part of the HUD: never the pad's (UI-09) -- the X is for the mouse and the thumb
		if (win.close !== undefined) {
			win.close.Selectable = false;
			if (opts.touch) touchHit(win.close, () => this.close(), true);
		}
		const z = win.frame.ZIndex + 1;
		const barY = win.contentY;
		// the caption row: how to sort on this device -- a click on a header (mouse), or the sort bar (pad, thumb)
		this.hint = makeLabel(
			win.frame,
			"Hint",
			tr("Click a column to sort"),
			PAD + 2,
			barY,
			220,
			BAR_H,
			TEXT.xs,
			THEME.mutedForeground,
			{
				align: "left",
				zIndex: z,
			},
		);
		this.sortCaption = makeLabel(
			win.frame,
			"SortBy",
			tr("Sort by"),
			PAD + 2,
			barY,
			PANEL_W - PAD * 3 - SORT_W,
			BAR_H,
			TEXT.sm,
			THEME.mutedForeground,
			{
				align: "left",
				zIndex: z,
			},
		);
		const tableY = barY + BAR_H + 6;
		this.table = Table<ScoreEntry>(win.frame, "Table", {
			x: PAD,
			y: tableY,
			w: TABLE_W,
			h: tableHeight(MAX_PLAYERS),
			columns: SCORE_COLUMNS.map(c => ({ ...c, header: tr(c.header) })),
			rowH: ROW_H,
			headerH: HEAD_H,
			textSize: TEXT.sm,
			cellPad: CELL_PAD,
			keyOf: e => e.key,
			cell: (e, column, out) => this.cell(e, column, out),
			sortValue: (e, column) => sortValueOf(e, column),
			sort: { column: "lifeDay", descending: true },
			// a header click moves the sort bar's choice with it (the bar is built right below; no sort happens before)
			onSort: sort => this.sortBar.sync(sort),
			marked: e => e.you,
			empty: tr("Waiting for the town's list..."),
			zIndex: z,
		});
		// a full town always fits (MAX_PLAYERS rows): the list never scrolls, and so it takes no touch or drag -- a
		// thumb landing on the open board still reaches the stick and the aim pad under it
		this.table.list.frame.ScrollingEnabled = false;
		this.table.list.frame.Active = false;
		const options: Array<SortOption> = SORTS.map(([label, column, descending]) => ({
			label: tr(label),
			column,
			descending,
		}));
		this.sortBar = TableSortBar(win.frame, "Sort", {
			x: PANEL_W - PAD - SORT_W,
			y: barY + 1,
			w: SORT_W,
			h: BAR_H - 2,
			table: this.table,
			options,
			focusable: false,
			textSize: TEXT.sm,
			zIndex: z,
		});
		if (opts.touch) {
			const triggers = this.sortBar.bar.triggers;
			for (let i = 0; i < triggers.size(); i++) {
				const index = i;
				touchHit(triggers[i], () => this.sortBar.step(index - this.sortBar.index()), true);
			}
		}
		// warm the pool to a full town now: opening, a new survivor and a re-sort then create nothing
		const warm = new Array<ScoreEntry>();
		for (let i = 0; i < MAX_PLAYERS; i++) entryAt(warm, i).key = `warm${i}`;
		this.table.setItems(warm);
		this.table.setItems([]);
		setVisible(frame, false);

		// ---- the chip, filling its slot: the survivors icon, how many are in town, and the key that opens this
		const [dw, dh] = designSpace(chipSlot);
		const g = chipGeom(opts.chipStyle);
		this.chipGeom = g;
		const chip = makeFrame(chipSlot, "Survivors", 0, 0, dw, dh, THEME.background, {
			transparency: 1,
			zIndex: chipSlot.ZIndex + 1,
		});
		this.chip = chip;
		const cz = chip.ZIndex + 1;
		const fg = this.chipForeground();
		// the survivor's head and shoulders (the lobby's "in town" icon) on the 7 x 7 grid of the console's Bag and Menu
		// icons, Frames that fill their host: it scales with the chip wherever it is drawn
		const iconHost = makeFrame(chip, "Icon", g.iconX - g.iconS / 2, (dh - g.iconS) / 2, g.iconS, g.iconS, fg, {
			transparency: 1,
			zIndex: cz,
		});
		this.chipIcon = pixelIcon(iconHost, "Pixels", PEOPLE, fg, cz);
		this.chipCount = makeLabel(chip, "Count", "", g.countX, 0, g.countW, dh, g.countSize, fg, {
			font: BOLD,
			align: "left",
			zIndex: cz,
		});
		// light on the plate (UI-05): iron like Bag and Menu, blue while the board is open. Touch shows no key (the
		// thumb taps the chip), so the corner chip may have no room for one
		this.chipKey = makeLabel(chip, "Key", "", g.keyX, 0, math.max(0, dw - g.keyX - 4), dh, TEXT.xs, fg, {
			font: BOLD,
			align: "right",
			zIndex: cz,
		});
		this.chipText = fg;
		this.chipHit = touchHit(chip, () => this.toggle(), opts.touch);
		this.chipHit.ZIndex = cz + 2;
		this.chipHit.GetPropertyChangedSignal("GuiState").Connect(() => this.paintChip());
		this.paintChip();
	}

	/** the chip's text and icon colour: light on its face (UI-05), the pair each face is measured with (test:contrast) */
	private chipForeground(): Color3 {
		return this.open ? THEME.tabActiveForeground : THEME.secondaryForeground;
	}

	private paintChip(): void {
		const gs = this.chipHit.GuiState;
		const press = gs === Enum.GuiState.Press;
		const hot = gs === Enum.GuiState.Hover || press;
		// a button with Bag and Menu: iron and raised like them (the kit's secondary button), blue while the board is
		// open ("what is chosen is blue", UI-07)
		const face = this.open ? THEME.tabActive : THEME.secondary;
		paintPlate(this.chip, face, press ? "press" : hot ? "hot" : "idle");
		const fg = this.chipForeground();
		if (fg !== this.chipText) {
			this.chipText = fg;
			this.chipCount.TextColor3 = fg;
			this.chipKey.TextColor3 = fg;
			for (const px of this.chipIcon.GetChildren()) if (px.IsA("Frame")) px.BackgroundColor3 = fg;
		}
	}

	/**
	 * Pinned to the left edge under the bar at the HUD's scale; and below anything of `keepClear` that stands in its
	 * column (touch with the largest controls moves the sky and the chip to the top left, hudConsole.ts placeTouchSky):
	 * the open board never covers the day clock nor its own chip (MP-23), as long as it still fits on screen.
	 */
	private placePanel(): void {
		const v = viewportSize();
		const inset = topInset();
		const s = math.min(v.X / DESIGN_W, math.max(0, v.Y - inset) / DESIGN_H);
		const x = math.floor(PANEL_X * s);
		const w = PANEL_W * s;
		const h = SCOREBOARD_H * s;
		let y = math.floor(inset + PANEL_Y * s);
		for (const r of this.keepClear) {
			// in the panel's column, and above its middle: the panel goes under it
			if (r[0] < x + w && x < r[2] && r[1] < y + h / 2) y = math.max(y, math.ceil(r[3] + PAD * s));
		}
		y = math.min(y, math.max(inset, math.floor(v.Y - h)));
		this.frame.Position = UDim2.fromOffset(x, y);
		this.frame.Size = UDim2.fromOffset(w, h);
	}

	/** hud.ts, on a change of the touch geometry: the corner's pieces the open panel must stay clear of (never per frame) */
	avoid(rects: ReadonlyArray<PxRect>): void {
		this.keepClear = rects;
		this.placePanel();
	}

	/**
	 * Touch: hud.ts draws the chip's slot at the sky plate's scale, in screen pixels, not at the kit's UI scale; its text
	 * follows, as the sky's does (hudSky.ts setTextScale). Called on a change of the touch geometry, never per frame.
	 */
	setChipTextScale(mult: number): void {
		scaleText(this.chipCount, this.chipGeom.countSize * mult);
		scaleText(this.chipKey, TEXT.xs * mult);
	}

	private cell(e: ScoreEntry, column: string, out: TableCell): void {
		if (column === "name") {
			out.text = fitText(e.name, 14);
			if (e.title >= 0) {
				out.sub = titleText(e.title, 0);
				out.subColor = titleColor(e.title);
			}
		} else if (column === "level") {
			out.text = tostring(e.level);
		} else if (column === "lifeDay") {
			out.text = e.lifeDay > 0 ? fmtInt(e.lifeDay) : "–";
		} else if (column === "kills") {
			out.text = e.kills >= 0 ? fmtInt(e.kills) : "–";
		} else {
			const [word, line] = STATUS_TEXT[e.status];
			out.text = this.tr(word);
			out.color = scoreStatusColor(e.status);
			if (line !== "") out.sub = this.tr(line);
		}
	}

	isOpen(): boolean {
		return this.open;
	}

	/** the pad's Back / Select and the chip: open until pressed again */
	toggle(): void {
		this.toggled = !this.toggled;
		this.apply();
	}

	close(): void {
		this.toggled = false;
		this.held = false;
		this.apply();
	}

	/** every HUD frame: `held` = the Q key is down; refreshes the numbers 4 times a second while open */
	update(held: boolean, now: number): void {
		if (held !== this.held) {
			this.held = held;
			this.apply();
		}
		if (!this.open) {
			// closed: only the chip's count, twice a second (the roster is small)
			if (now - this.refreshAt >= 0.5) {
				this.refreshAt = now;
				this.opts.source(this.entries);
				this.writeCount();
			}
			return;
		}
		const pad = this.opts.gamepad() || this.opts.touch;
		if (pad !== this.sortShown) {
			this.sortShown = pad;
			setVisible(this.sortBar.bar.frame, pad);
			setVisible(this.sortCaption, pad);
			setVisible(this.hint, !pad);
		}
		if (now - this.refreshAt < 0.25) return;
		this.refreshAt = now;
		this.refresh();
	}

	private writeCount(): void {
		const n = this.entries.size();
		const seed = netTownSeed();
		if (n !== this.shownCount || seed !== this.shownSeed) {
			if (n !== this.shownCount) this.chipCount.Text = tostring(n);
			this.shownCount = n;
			this.shownSeed = seed;
			// "Brackenmere · Survivors · 3 / 6": the town's name (a proper noun) and who is in it
			if (this.title !== undefined) {
				this.title.Text = `${townNameOf(seed)} · ${this.tr("Survivors")} · ${n} / ${MAX_PLAYERS}`;
			}
		}
		const legend = this.opts.keyLegend();
		if (this.chipKey.Text !== legend) this.chipKey.Text = legend;
	}

	/** reads the source and rewrites the table in place */
	refresh(): void {
		this.opts.source(this.entries);
		this.writeCount();
		this.table.setItems(this.entries);
	}

	private apply(): void {
		const open = this.held || this.toggled;
		if (open === this.open) return;
		this.open = open;
		setVisible(this.frame, open);
		this.paintChip();
		if (open) {
			this.refreshAt = -math.huge;
			this.sortShown = undefined;
			this.refresh();
			// the pad steps the sort with the D-pad while the board is up (the D-pad does nothing else in a run) -- but
			// not while a menu over it has the pad (the Bag opened with the board still up): there the D-pad is that
			// menu's navigation, and the engine says so (processed, or a GUI selected)
			this.dpad = UserInputService.InputBegan.Connect((input, processed) => {
				if (processed || GuiService.SelectedObject !== undefined) return;
				if (input.KeyCode === Enum.KeyCode.DPadLeft) this.sortBar.step(-1);
				else if (input.KeyCode === Enum.KeyCode.DPadRight) this.sortBar.step(1);
			});
		} else {
			this.dpad?.Disconnect();
			this.dpad = undefined;
		}
	}

	destroy(): void {
		this.dpad?.Disconnect();
		this.dpad = undefined;
		this.frame.Destroy();
		this.chip.Destroy();
	}
}

function sortValueOf(e: ScoreEntry, column: string): number | string {
	if (column === "name") return e.name;
	if (column === "level") return e.level;
	if (column === "lifeDay") return e.lifeDay;
	if (column === "kills") return e.kills;
	return STATUS_ORDER[e.status];
}

function designSpace(host: GuiObject): [number, number] {
	const dw = host.GetAttribute("DesignW");
	const dh = host.GetAttribute("DesignH");
	return [typeIs(dw, "number") ? dw : 300, typeIs(dh, "number") ? dh : 44];
}
