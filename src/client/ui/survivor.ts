import { GameContext } from "shared/game/context";
import { declineTutorial, equippedIn, expMaxInit, outfitLookOf, petLookOf, totalPendingPacks } from "shared/game/save";
import { WEAPONS } from "shared/data/weapons";
import { EQUIPS, EquipSlot } from "shared/data/equips";
import { ItemKind } from "shared/data/kinds";
import { iconKeys } from "shared/data/itemIcons";
import { langGet } from "shared/data/lang";
import { rebirthPrice } from "shared/data/shop";
import { DAY_BREAK_HOUR, isNightAt, secondsUntilHour } from "shared/sim/clock";
import { PetLook } from "shared/data/cosmetics";
import { requestSave } from "../systems/saveClient";
import { countdown } from "../onboarding/gameOver";
import { SurvivorPreview } from "../view/cosmeticPreview";
import { IconView, clearIcon, drawItemIcon, maxFrameCount } from "./itemIcon";
import { paintPlate } from "./plate";
import { PixelIcon } from "./pixelIcon";
import { popup, toast } from "./popup";
import { GAME, SURFACE, TEXT, THEME, fontOf, space } from "./theme";
import { drawingBox } from "./wardrobe";
import {
	Bar,
	Button,
	DesignRect,
	Progress,
	autoFocus,
	buttonForeground,
	centredRect,
	designOf,
	fmtInt,
	isFocused,
	makeFrame,
	makeLabel,
	makeSurface,
	nl,
	registerFocus,
	setButtonVariant,
	setDesign,
	setVisible,
} from "./widgets";
import * as Kit from "./window";

/*
 * The Survivor screen (DESIGN_RULES UI-10): what the lobby's START opens, and the one place the city is entered
 * from. A UI-07 window -- thick frame, graphite body, "Survivor" in the header with the "?" and the red X -- over
 * the town flyover:
 *
 *   ┌ ? ─────────────────────────── Survivor ─────────────────────────── X ┐
 *   │ ┌ Fabricio ── [👕 Wardrobe] ┐  ┌ Stats ─────────────────────────────┐ │
 *   │ │                           │  │ This life │ Day 3   Record │ Day 12 │ │
 *   │ │    the survivor, as       │  │ Level     │ [7] ▮▮▮▮▯▯  340 / 800 XP │ │
 *   │ │    everyone sees them     │  │ Bosses defeated │        2         │ │
 *   │ │                           │  └────────────────────────────────────┘ │
 *   │ │    (outfit + pet)         │  ┌ Loadout ───────────────────────────┐ │
 *   │ │                           │  │ [D] WEAPON  [ ] CLOTHES  [ ] HAND   │ │
 *   │ │                           │  │ [ ] GUN     [S] OUTFIT   [P] PET    │ │
 *   │ └───────────────────────────┘  └────────────────────────────────────┘ │
 *   │  note: packs waiting, the town's day, or the MP-21 choice's words        │
 *   │ [ Home ]  [ Play solo ]           [ Enter the city · Day 1           ] │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * The action row is the only thing that changes with the run (main.client.ts keeps every semantic): Enter the city
 * (a fresh life, or a new life still waiting for first light) or Continue (a run suspended in memory), both
 * `onPlay`; and when the run is over, the MP-21 choice itself, in place, instead of the popup that used to open over
 * the lobby. MP-21 gives a dead survivor three ways out, and the row offers every one the server honours: Rebirth ·
 * price (the steel-blue main action: now, for coins), Wait for daybreak (iron: free, the SAME life wakes at 06:00 --
 * only where the server revives at daybreak and runs the clock) and New game (red: it throws this life away, and
 * the new one still waits for first light), with the MP-21 / MP-22 wording. Home and the X go back to the menu.
 * Beside Home, Play solo (iron, P0-2: a town of your own, docs/MULTIPLAYER.md §7.4) -- only for a living survivor, on
 * a server that can send them there (client/net/matchClient.ts asks first; the server decides).
 *
 * Built once per lobby and then only rewritten (the Bag's rule): every row, tile and button exists from the start
 * and a state change writes text and visibility, never an Instance.
 */

export type RunState = "fresh" | "suspended" | "over" | "newLife";

export interface SurvivorState {
	run: RunState;
	/** the server owns this survivor's death (MP-21): the choice's wording */
	hosted: boolean;
	/** the town's day on this server (MP-20), when the server publishes it; the life's day otherwise */
	worldDay?: number;
	/**
	 * MP-21's free way out is on offer: the run is over and the server stands this survivor up at daybreak (it owns
	 * the death and runs the clock). Offline, or with no server revive, only Rebirth and New game are.
	 */
	canWait?: boolean;
	/** the world's hour, when the server publishes it: the note counts down to 06:00 at night */
	hour?: number;
	/** Play solo is on offer here (a hosted server that is not a solo town already, and a handler for it) */
	playSolo?: boolean;
}

export interface SurvivorHandlers {
	/** back to the menu page (the X and Home) */
	onBack: () => void;
	/** Enter the city / Continue: main.client's playPressed, the startRun semantics */
	onPlay: () => void;
	onRebirth: () => void;
	/** MP-21: wait for daybreak, the same life (main.client's enterToWait, keeping it) */
	onWaitDawn: () => void;
	onNewRun: () => void;
	/** the wardrobe; `slot` (EquipSlot.Outfit / Pet) is the tab it opens on -- the loadout tile of that slot */
	onWardrobe: (slot?: number) => void;
	/** `thenPlay`: the first-run prompt's "Yes": the tutorial, then the city */
	onTutorial: (thenPlay?: boolean) => void;
	/** P0-2: a town of your own (client/net/matchClient.ts `askPlaySolo`: a question first, then the server) */
	onPlaySolo?: () => void;
}

// ---------------------------------------------------------------- layout (window design units)

const WIN_W = 960;
const WIN_H = 600;
/** where the window sits in the lobby's 1120 x 630 space: centred (the lobby centres the screen on it, UI-07) */
export const SURVIVOR_WINDOW: DesignRect = centredRect(WIN_W, WIN_H);
const PAD = space(6);
const INSET = space(4);
const GAP = space(3);
/** between the sections of a column (Stats, Loadout, the note): tighter than the row's GAP since the bosses' row */
const SECTION_GAP = space(2);
const BOTTOM = space(5);
const STAGE_W = 372;
const RIGHT_X = PAD + STAGE_W + space(4);
const RIGHT_W = WIN_W - PAD - RIGHT_X;
const GROOVE_W = RIGHT_W - INSET * 2;
const CELL_PAD = 8;
/** the stats' groove is a little tighter than the loadout's: three rows of it (life | record, level, bosses) */
const STATS_PAD = 6;
const STATS_ROW_GAP = 3;
/** a stat row: a settings row (Kit.SETTING_ROW_H 38) four units shorter, so the third row fits the window */
const ROW_H = Kit.SETTING_ROW_H - 4;
const STATS_ROWS = 3;
const STATS_GROOVE_H = STATS_PAD * 2 + ROW_H * STATS_ROWS + STATS_ROW_GAP * (STATS_ROWS - 1);
const STATS_H = Kit.sectionHeight(STATS_GROOVE_H);
const TILE_H = 46;
/** the icon's well in a slot tile: a 32 unit icon, 2x its 16 px grid at 1120 x 630 */
const ICON_WELL = 36;
const TILE_GAP = 6;
const TILE_W = (GROOVE_W - CELL_PAD * 2 - TILE_GAP * 2) / 3;
const LOADOUT_GROOVE_H = CELL_PAD * 2 + TILE_H * 2 + TILE_GAP;
/** the bosses' row: "Bosses defeated" is a long label */
const BOSSES_LABEL_W = 184;
const LOADOUT_H = Kit.sectionHeight(LOADOUT_GROOVE_H);
const ACTION_H = 56;
const ACTION_Y = WIN_H - BOTTOM - ACTION_H;
/** Home at the bottom left (the PC menu's way back), the main action at the bottom right, under the right column */
const HOME_W = 168;
const MAIN_X = RIGHT_X;
const MAIN_W = RIGHT_W;
/** Play solo, between Home and the main action (the room under the stage the action row leaves free) */
const SOLO_X = PAD + HOME_W + GAP;
const SOLO_W = MAIN_X - GAP - SOLO_X;
/** the MP-21 row: New game | Rebirth, or New game | Wait for daybreak | Rebirth when waiting is on offer */
const NEW_GAME_W = 196;
const NEW_GAME_W3 = 150;
const WAIT_W = 188;
const LABEL_W = 116;
/** the Wardrobe shortcut on the stage's title line, at its right (like the wardrobe's own keys) */
const WARDROBE_W = 150;
const WARDROBE_H = 34;

const BOLD = fontOf("sans", Enum.FontWeight.Bold);

/** the six slots of the loadout, in the order of the save (0 = the weapon, 1..5 = EquipSlot) */
/** the loadout slots, in capitals as drawn: each its own lang.ts entry (translation is case-sensitive) */
const SLOT_KEYS = ["WEAPON", "CLOTHES", "HAND", "GUN", "OUTFIT", "PET"];

const HELP_TEXT = [
	"Your survivor as everyone sees them, how long this life has lasted and what you carry.",
	"Enter the city to play. The town keeps its own day, shared by everyone on this server.",
	"Play solo takes you to a town of your own, on the day this life has reached: nobody else can join it.",
	"When a run is over: Rebirth wakes you now for coins, waiting for daybreak is free and keeps this life, and New game starts a new life at day 1.",
	"Outfits and pets are in the Wardrobe. Everyone sees them, and they change nothing else.",
].join("#");

interface SlotTile {
	/** a flat plate that lights under the pointer and the pad's focus ring (the wardrobe's tiles' rule) */
	frame: TextButton;
	/** the item's pixel icon (UI-11: the Bag's drawing), in a dark well; empty = the well alone */
	icon: IconView;
	name: TextLabel;
	/** the plate's face: iron with an item in the slot, the dark section when it is empty */
	face: Color3;
}

/** a loadout slot's plate: a button the size of the tile (it paints itself: SurvivorScreen.paintTile) */
function slotButton(parent: Frame, name: string, x: number, y: number, w: number, h: number, z: number): TextButton {
	const [dw, dh] = designOf(parent);
	const b = new Instance("TextButton");
	b.Name = name;
	b.Position = UDim2.fromScale(x / dw, y / dh);
	b.Size = UDim2.fromScale(w / dw, h / dh);
	setDesign(b, w, h);
	b.AutoButtonColor = false;
	b.BorderSizePixel = 0;
	b.BackgroundTransparency = 1;
	b.BackgroundColor3 = THEME.background;
	b.Text = "";
	b.ZIndex = z;
	b.Selectable = true;
	b.Parent = parent;
	return b;
}

export class SurvivorScreen {
	readonly frame: Frame;
	private readonly ctx: GameContext;
	private readonly handlers: SurvivorHandlers;
	private readonly tr: (key: string) => string;
	private readonly title: TextLabel;
	private readonly preview: SurvivorPreview;
	private readonly life: TextLabel;
	private readonly record: TextLabel;
	private readonly bosses: TextLabel;
	private readonly levelKey: Frame;
	private readonly xp: Bar;
	private readonly xpText: TextLabel;
	private readonly slots: Array<SlotTile> = [];
	private readonly note: TextLabel;
	private readonly enter: TextButton;
	private readonly solo: TextButton;
	private readonly newGame: TextButton;
	private readonly wait: TextButton;
	private readonly rebirth: TextButton;
	/** the MP-21 row as it is laid out now: 2 (New game | Rebirth) or 3 buttons (with Wait); 0 = not yet */
	private rowCount = 0;
	private state: SurvivorState = { run: "fresh", hosted: false };

	constructor(parent: Instance, ctx: GameContext, handlers: SurvivorHandlers) {
		this.ctx = ctx;
		this.handlers = handlers;
		const lang = ctx.save.settings.langType;
		const tr = (k: string): string => langGet(k, lang);
		this.tr = tr;
		this.frame = makeFrame(parent, "Survivor", 0, 0, 1120, 630, THEME.background, { transparency: 1 });
		const win = Kit.Window(this.frame, "Window", {
			...SURVIVOR_WINDOW,
			title: tr("Survivor"),
			onClose: (): void => handlers.onBack(),
			onHelp: (): void => {
				popup(ctx, tr("Survivor"), nl(tr(HELP_TEXT)), [{ text: tr("Close"), variant: "secondary" }]);
			},
		});
		const panel = win.frame;
		const top = win.contentY + space(1);

		// ---- the stage: the survivor as everyone sees them (as tall as the stats and the loadout beside it), with the
		// way to the wardrobe on its title line
		const stageH = STATS_H + SECTION_GAP + LOADOUT_H;
		const stage = Kit.Section(panel, "Stage", { x: PAD, y: top, w: STAGE_W, h: stageH });
		const sz = stage.frame.ZIndex + 1;
		this.title = makeLabel(
			stage.frame,
			"Name",
			"",
			space(5),
			Kit.SECTION_TITLE_MID - 16,
			STAGE_W - space(10) - WARDROBE_W - space(2),
			32,
			TEXT.xl2,
			THEME.foreground,
			{ font: BOLD, align: "left", zIndex: sz },
		);
		// the player's display name: never captured for automatic translation (compliance F9)
		this.title.AutoLocalize = false;
		const wardrobe = Button(stage.frame, "Wardrobe", "", {
			x: STAGE_W - space(4) - WARDROBE_W,
			y: Kit.SECTION_TITLE_MID - WARDROBE_H / 2,
			w: WARDROBE_W,
			h: WARDROBE_H,
			size: "sm",
			variant: "secondary",
			zIndex: sz,
			onClick: (): void => handlers.onWardrobe(),
		});
		const wfg = buttonForeground("secondary");
		PixelIcon(wardrobe, "Icon", "wardrobe", 22, WARDROBE_H / 2, 18, wfg, wardrobe.ZIndex + 1);
		makeLabel(wardrobe, "Title", tr("Wardrobe"), 40, 0, WARDROBE_W - 48, WARDROBE_H, TEXT.base, wfg, {
			font: BOLD,
			align: "left",
			zIndex: wardrobe.ZIndex + 1,
		});
		const bedW = STAGE_W - INSET * 2;
		const bedH = stageH - Kit.SECTION_CONTENT_Y - INSET;
		const bed = Kit.Groove(stage.frame, "Bed", INSET, Kit.SECTION_CONTENT_Y, bedW, bedH);
		const box = drawingBox(bed, "Preview", 0, 0, bedW, bedH, bed.ZIndex + 1);
		// with no pet the survivor stands in the middle; with one, the scene keeps the pet's room at their side
		const subject = petLookOf(ctx.save) === PetLook.None ? "outfit" : "both";
		this.preview = new SurvivorPreview(box, { w: bedW, h: bedH, scale: 4, subject, zIndex: box.ZIndex });

		// ---- stats: this life against the record (MP-13), the level and its XP, and the bosses put down (CON-03: they
		// are in the game from day 5, and a record that hid them made the player think they were not)
		const stats = Kit.Section(panel, "Stats", { x: RIGHT_X, y: top, w: RIGHT_W, h: STATS_H, title: tr("Stats") });
		const sGroove = Kit.Groove(stats.frame, "Rows", INSET, Kit.SECTION_CONTENT_Y, GROOVE_W, STATS_GROOVE_H);
		const halfW = (GROOVE_W - STATS_PAD * 3) / 2;
		const rowY = (i: number): number => STATS_PAD + i * (ROW_H + STATS_ROW_GAP);
		const lifeRow = Kit.SettingCell(sGroove, "Life", {
			x: STATS_PAD,
			y: rowY(0),
			w: halfW,
			h: ROW_H,
			labelW: LABEL_W,
			label: tr("This life"),
			zIndex: sGroove.ZIndex + 1,
		});
		const recordRow = Kit.SettingCell(sGroove, "Record", {
			x: STATS_PAD * 2 + halfW,
			y: rowY(0),
			w: halfW,
			h: ROW_H,
			labelW: LABEL_W,
			label: tr("Record"),
			zIndex: sGroove.ZIndex + 1,
		});
		this.life = this.valueText(lifeRow.value, halfW - LABEL_W);
		this.record = this.valueText(recordRow.value, halfW - LABEL_W);
		const levelW = GROOVE_W - STATS_PAD * 2;
		const bossRow = Kit.SettingCell(sGroove, "Bosses", {
			x: STATS_PAD,
			y: rowY(2),
			w: levelW,
			h: ROW_H,
			labelW: BOSSES_LABEL_W,
			label: tr("Bosses defeated"),
			zIndex: sGroove.ZIndex + 1,
		});
		this.bosses = this.valueText(bossRow.value, levelW - BOSSES_LABEL_W);
		const levelRow = Kit.SettingCell(sGroove, "Level", {
			x: STATS_PAD,
			y: rowY(1),
			w: levelW,
			h: ROW_H,
			labelW: LABEL_W,
			label: tr("Level"),
			zIndex: sGroove.ZIndex + 1,
		});
		const cell = levelRow.value;
		const cellW = levelW - LABEL_W;
		this.levelKey = Kit.ValueKey(cell, "Key", "1", { x: space(3), anchorX: 0, minW: 44 });
		const xpTextW = 136;
		const barX = 72;
		this.xp = Progress(cell, "Xp", {
			x: barX,
			y: (ROW_H - 10) / 2,
			w: cellW - barX - xpTextW - space(3),
			h: 10,
			color: GAME.xp,
			zIndex: cell.ZIndex + 1,
		});
		this.xpText = makeLabel(
			cell,
			"XpText",
			"",
			cellW - xpTextW - space(2),
			0,
			xpTextW,
			ROW_H,
			TEXT.sm,
			THEME.foreground,
			{
				font: "numeric",
				align: "right",
				zIndex: cell.ZIndex + 1,
			},
		);

		// ---- the loadout: the six slots, with the Bag's icons (UI-11); an empty slot is a dark tile that says so. OUTFIT and
		// PET open the wardrobe on their tab (what everyone sees is changed here, in the lobby); the other four say where
		// they are changed -- the Bag, during a match, where the body is
		const loadoutY = top + STATS_H + SECTION_GAP;
		const loadout = Kit.Section(panel, "Loadout", {
			x: RIGHT_X,
			y: loadoutY,
			w: RIGHT_W,
			h: LOADOUT_H,
			title: tr("Loadout"),
		});
		const lGroove = Kit.Groove(loadout.frame, "Slots", INSET, Kit.SECTION_CONTENT_Y, GROOVE_W, LOADOUT_GROOVE_H);
		for (let i = 0; i < SLOT_KEYS.size(); i++) {
			const x = CELL_PAD + (i % 3) * (TILE_W + TILE_GAP);
			const y = CELL_PAD + math.floor(i / 3) * (TILE_H + TILE_GAP);
			const tile = slotButton(lGroove, `Slot${i}`, x, y, TILE_W, TILE_H, lGroove.ZIndex + 1);
			const z = tile.ZIndex + 1;
			// the well, and in it as many Frames as the costliest icon of the slot's kind from the start: changing
			// what is equipped rewrites them and creates nothing (the Bag's rule)
			const well = makeSurface(tile, "IconWell", 8, (TILE_H - ICON_WELL) / 2, ICON_WELL, ICON_WELL, "well", {
				fill: SURFACE.well,
				border: SURFACE.line,
				zIndex: z,
			});
			const reserve = maxFrameCount(iconKeys(i === 0 ? ItemKind.Weapon : ItemKind.Equip));
			const icon = IconView(well, "ItemIcon", 2, 2, ICON_WELL - 4, z + 1, reserve, "drawn");
			makeLabel(tile, "Slot", tr(SLOT_KEYS[i]), 50, 4, TILE_W - 58, 17, TEXT.xs, THEME.foreground, {
				font: "label",
				align: "left",
				zIndex: z,
			});
			const name = makeLabel(tile, "Name", "", 50, 21, TILE_W - 58, 21, TEXT.sm, THEME.foreground, {
				font: BOLD,
				align: "left",
				zIndex: z,
			});
			const slot: SlotTile = { frame: tile, icon, name, face: SURFACE.section };
			const repaint = (): void => this.paintTile(slot);
			registerFocus(tile, repaint);
			tile.GetPropertyChangedSignal("GuiState").Connect(repaint);
			tile.Activated.Connect(() => this.slotPressed(i));
			this.slots.push(slot);
		}

		// ---- the note, across the window, and the action row: Home at the left, the main action at the right
		const noteY = loadoutY + LOADOUT_H + SECTION_GAP;
		this.note = makeLabel(
			panel,
			"Note",
			"",
			PAD + space(1),
			noteY,
			WIN_W - PAD * 2 - space(2),
			ACTION_Y - space(2) - noteY,
			TEXT.sm,
			THEME.mutedForeground,
			{ align: "left", valign: "top" },
		);
		Button(panel, "Home", tr("Home"), {
			x: PAD,
			y: ACTION_Y,
			w: HOME_W,
			h: ACTION_H,
			variant: "secondary",
			textSize: TEXT.lg,
			font: BOLD,
			onClick: (): void => handlers.onBack(),
		});
		// P0-2: iron, beside Home -- a way to play, never the main action (the steel blue stays on Enter)
		this.solo = Button(panel, "Solo", tr("Play solo"), {
			x: SOLO_X,
			y: ACTION_Y,
			w: SOLO_W,
			h: ACTION_H,
			variant: "secondary",
			textSize: TEXT.lg,
			font: BOLD,
			onClick: (): void => handlers.onPlaySolo?.(),
		});
		this.enter = Button(panel, "Enter", "", {
			x: MAIN_X,
			y: ACTION_Y,
			w: MAIN_W,
			h: ACTION_H,
			variant: "default",
			textSize: TEXT.lg,
			font: BOLD,
			onClick: (): void => this.enterCity(),
		});
		this.newGame = Button(panel, "NewGame", tr("New game"), {
			x: MAIN_X,
			y: ACTION_Y,
			w: NEW_GAME_W,
			h: ACTION_H,
			// starting over throws this life away: the red plate
			variant: "destructive",
			textSize: TEXT.lg,
			font: BOLD,
			onClick: (): void => handlers.onNewRun(),
		});
		this.wait = Button(panel, "Wait", tr("Wait for daybreak"), {
			x: MAIN_X + NEW_GAME_W3 + GAP,
			y: ACTION_Y,
			w: WAIT_W,
			h: ACTION_H,
			// free, and the same life: an ordinary iron action beside the paid one
			variant: "secondary",
			textSize: TEXT.lg,
			font: BOLD,
			onClick: (): void => handlers.onWaitDawn(),
		});
		this.rebirth = Button(panel, "Rebirth", "", {
			x: MAIN_X + NEW_GAME_W + GAP,
			y: ACTION_Y,
			w: MAIN_W - NEW_GAME_W - GAP,
			h: ACTION_H,
			// paying to continue is the main action: the steel-blue plate
			variant: "default",
			textSize: TEXT.lg,
			font: BOLD,
			onClick: (): void => handlers.onRebirth(),
		});
	}

	/** a value in a stat row's cell: light, Bold, centred (the settings row's text value) */
	private valueText(cell: Frame, w: number): TextLabel {
		return makeLabel(cell, "Value", "", space(2), 0, w - space(4), ROW_H, TEXT.lg, THEME.foreground, {
			font: BOLD,
			zIndex: cell.ZIndex + 1,
		});
	}

	/** the first run asks about the tutorial before the city, exactly as the lobby's old Play did */
	private enterCity(): void {
		const ctx = this.ctx;
		const tr = this.tr;
		const handlers = this.handlers;
		if (!ctx.save.tutorialDone && !ctx.save.runOver) {
			popup(ctx, tr("How to play"), nl(tr("Do you want to#watch the tutorial?")), [
				{
					text: "No",
					variant: "secondary",
					onClick: (): void => {
						// "No" answers the question AND keeps the first-run coach off (declineTutorial), saved now
						declineTutorial(ctx.save);
						requestSave("auto");
						handlers.onPlay();
					},
				},
				{ text: "Yes", variant: "default", onClick: (): void => handlers.onTutorial(true) },
			]);
			return;
		}
		handlers.onPlay();
	}

	/** rewrites everything from the save and the run state (text and visibility only: no Instance) */
	refresh(state: SurvivorState): void {
		this.state = state;
		const save = this.ctx.save;
		const tr = this.tr;
		const Players = game.GetService("Players");
		const me = Players.LocalPlayer as Player | undefined;
		this.write(this.title, me !== undefined ? me.DisplayName : tr("Survivor"));
		this.preview.setOutfit(outfitLookOf(save));
		this.preview.setPet(petLookOf(save));
		this.write(this.life, `${tr("Day")} ${save.day}`);
		this.write(this.record, `${tr("Day")} ${save.bestDay}`);
		// the server's count (`bossKills`, credited to every participant, MP-15), like the Records window's
		this.write(this.bosses, fmtInt(save.bossKills));
		Kit.setValueKey(this.levelKey, `${save.level}`);
		const expMax = expMaxInit(save.level);
		this.xp.setRatio(save.exp / math.max(expMax, 1));
		this.write(this.xpText, `${fmtInt(save.exp)} / ${fmtInt(expMax)} XP`);
		for (let i = 0; i < this.slots.size(); i++) this.paintSlot(i);
		this.paintAction(state);
	}

	private write(label: TextLabel, text: string): void {
		if (label.Text !== text) label.Text = text;
	}

	/** a slot tile: iron with the item's icon and name when something is in it, a dark tile saying Empty when not */
	private paintSlot(i: number): void {
		const save = this.ctx.save;
		const tile = this.slots[i];
		let name: string | undefined;
		let kind: number = ItemKind.Equip;
		let id: number;
		if (i === 0) {
			// no weapon chosen yet means the starter one in hand (the old lobby said so too)
			id = save.equipWeapon >= 0 ? save.equipWeapon : 0;
			name = WEAPONS[id]?.name;
			kind = ItemKind.Weapon;
		} else {
			id = equippedIn(save, i);
			name = id >= 0 ? EQUIPS[id]?.name : undefined;
		}
		const shown = name !== undefined ? this.tr(name) : this.tr("Empty");
		tile.face = name !== undefined ? THEME.secondary : SURFACE.section;
		this.paintTile(tile);
		if (name !== undefined) drawItemIcon(tile.icon, kind, id);
		else clearIcon(tile.icon);
		this.write(tile.name, shown);
	}

	/** a slot's plate: flat at rest, lit under the pointer or the pad's focus ring, pressed while held */
	private paintTile(tile: SlotTile): void {
		const gs = tile.frame.GuiState;
		const pressed = gs === Enum.GuiState.Press;
		const hot = pressed || gs === Enum.GuiState.Hover || isFocused(tile.frame);
		paintPlate(tile.frame, tile.face, pressed ? "press" : hot ? "hot" : "flat", 4);
	}

	/**
	 * A loadout tile pressed: the outfit and the pet are changed here (MON-04), in the wardrobe on their tab; the weapon,
	 * the clothes, the hand and the gun belong to the body in the city, so the tile says where -- the Bag, during a match.
	 */
	private slotPressed(i: number): void {
		if (i === EquipSlot.Outfit || i === EquipSlot.Pet) {
			this.handlers.onWardrobe(i);
			return;
		}
		toast(this.ctx, this.tr("Change in the Bag during a match"));
	}

	/** lays the MP-21 row out for 2 or 3 buttons (only when that changes: positions are written, nothing is made) */
	private layoutRow(count: number): void {
		if (count === this.rowCount) return;
		this.rowCount = count;
		const place = (b: TextButton, x: number, w: number): void => {
			b.Position = UDim2.fromScale(x / WIN_W, ACTION_Y / WIN_H);
			b.Size = UDim2.fromScale(w / WIN_W, ACTION_H / WIN_H);
			b.SetAttribute("DesignW", w);
		};
		const newW = count === 3 ? NEW_GAME_W3 : NEW_GAME_W;
		place(this.newGame, MAIN_X, newW);
		let x = MAIN_X + newW + GAP;
		if (count === 3) {
			place(this.wait, x, WAIT_W);
			x += WAIT_W + GAP;
		}
		place(this.rebirth, x, MAIN_X + MAIN_W - x);
	}

	/** the action row and its note: Enter / Continue, or the MP-21 choice when the run is over */
	private paintAction(state: SurvivorState): void {
		const save = this.ctx.save;
		const tr = this.tr;
		const over = state.run === "over";
		const canWait = over && state.canWait === true;
		setVisible(this.enter, !over);
		// a living survivor only: a death is answered where it happened (MP-21), and a new life waits for its first light
		setVisible(this.solo, !over && state.run !== "newLife" && state.playSolo === true);
		setVisible(this.newGame, over);
		setVisible(this.wait, canWait);
		setVisible(this.rebirth, over);
		const lines: Array<string> = [];
		if (over) {
			this.layoutRow(canWait ? 3 : 2);
			const price = rebirthPrice(save.deathCount);
			this.rebirth.Text = `${tr("Rebirth")}  ·  ${fmtInt(price)}`;
			setButtonVariant(this.rebirth, "default");
			let words =
				"Rebirth to continue this run, or start a new game from day 1.#Level, skills, coins and packs are kept.";
			if (canWait) {
				words =
					"Rebirth wakes you now, for coins. Waiting for daybreak is free and keeps this life.#New game starts a new life at day 1, woken at first light. Level, skills, coins and packs are kept.";
			} else if (state.hosted) {
				words =
					"Rebirth wakes you now. New game starts a new life at day 1,#which wakes at first light. Level, skills, coins and packs are kept.";
			}
			lines.push(nl(tr(words)));
			const last: Array<string> = [];
			// at night the world's clock says exactly when 06:00 comes; by day the server's own cap (one night from
			// the death, which the lobby does not know) may wake the survivor sooner, so no number is promised
			const hour = state.hour;
			if (canWait && hour !== undefined && isNightAt(hour)) {
				last.push(`${tr("Daybreak in")} ${countdown(secondsUntilHour(hour, DAY_BREAK_HOUR))}`);
			}
			const short = price - save.money;
			// the Rebirth stays pressable either way: the server answers with the reason, and this says it first
			if (short > 0) last.push(`${tr("Not enough coins")}: ${fmtInt(short)} ${tr("more needed")}`);
			if (last.size() > 0) lines.push(last.join("  ·  "));
		} else {
			const day = state.worldDay ?? save.day;
			if (state.run === "newLife") {
				this.enter.Text = tr("Enter the city");
				lines.push(
					nl(
						tr(
							"Your new life wakes at first light.#If nobody is left standing, a new town begins at day 1.",
						),
					),
				);
			} else {
				const verb = state.run === "suspended" ? tr("Continue") : tr("Enter the city");
				this.enter.Text = `${verb}  ·  ${tr("Day")} ${day}`;
				const packs = totalPendingPacks(save);
				if (packs > 0) lines.push(`${tr("Packs")} +${packs}: ${tr("Delivered when you enter the city")}`);
				// MP-20: the button says the town's day; when the life's differs, one line says why
				if (state.worldDay !== undefined && state.worldDay !== save.day) {
					lines.push(tr("The town keeps its own day. This life and your record count yours."));
				}
			}
		}
		const text = lines.join("\n");
		this.write(this.note, text);
	}

	/**
	 * The gamepad's first stop: the action that works -- Rebirth when it can be paid; otherwise the free wait (the
	 * same life) where it is on offer, and New game where it is not.
	 */
	focus(): void {
		const s = this.state;
		if (s.run !== "over") {
			autoFocus(this.enter);
			return;
		}
		const affordable = this.ctx.save.money >= rebirthPrice(this.ctx.save.deathCount);
		if (affordable) autoFocus(this.rebirth);
		else autoFocus(s.canWait === true ? this.wait : this.newGame);
	}

	/** the survivor's idle breath (a dog's tail); a frame where nothing moved writes nothing */
	draw(clock: number): void {
		this.preview.draw(clock);
	}

	destroy(): void {
		this.preview.destroy();
		this.frame.Destroy();
	}
}
