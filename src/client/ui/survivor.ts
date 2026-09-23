import { GameContext } from "shared/game/context";
import { declineTutorial, equippedIn, expMaxInit, outfitLookOf, petLookOf, totalPendingPacks } from "shared/game/save";
import { WEAPONS } from "shared/data/weapons";
import { EQUIPS } from "shared/data/equips";
import { ItemKind } from "shared/data/kinds";
import { langGet } from "shared/data/lang";
import { rebirthPrice } from "shared/data/shop";
import { PetLook } from "shared/data/cosmetics";
import { requestSave } from "../systems/saveClient";
import { SurvivorPreview } from "../view/cosmeticPreview";
import { Glyph, kindTone, makeGlyph, setGlyph } from "./itemCard";
import { paintPlate } from "./plate";
import { PixelIcon } from "./pixelIcon";
import { popup } from "./popup";
import { GAME, SURFACE, TEXT, THEME, fontOf, space } from "./theme";
import { drawingBox } from "./wardrobe";
import {
	Bar,
	Button,
	Progress,
	autoFocus,
	buttonForeground,
	fmtInt,
	makeFrame,
	makeLabel,
	nl,
	setButtonVariant,
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
 *   │ │    everyone sees them     │  └────────────────────────────────────┘ │
 *   │ │    (outfit + pet)         │  ┌ Loadout ───────────────────────────┐ │
 *   │ │                           │  │ [D] WEAPON  [ ] CLOTHES  [ ] HAND   │ │
 *   │ │                           │  │ [ ] GUN     [S] OUTFIT   [P] PET    │ │
 *   │ └───────────────────────────┘  └────────────────────────────────────┘ │
 *   │  note: packs waiting, the town's day, or the MP-21 choice's words        │
 *   │ [ Home ]                          [ Enter the city · Day 1           ] │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * The action row is the only thing that changes with the run (main.client.ts keeps every semantic): Enter the city
 * (a fresh life, or a new life still waiting for first light) or Continue (a run suspended in memory), both
 * `onPlay`; and when the run is over, the MP-21 choice itself, in place -- Rebirth · price (the steel-blue main
 * action) and New game (red, it throws this life away), with the MP-21 / MP-22 wording -- instead of the popup that
 * used to open over the lobby. Home and the X go back to the menu.
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
}

export interface SurvivorHandlers {
	/** back to the menu page (the X and Home) */
	onBack: () => void;
	/** Enter the city / Continue: main.client's playPressed, the startRun semantics */
	onPlay: () => void;
	onRebirth: () => void;
	onNewRun: () => void;
	onWardrobe: () => void;
	/** `thenPlay`: the first-run prompt's "Yes": the tutorial, then the city */
	onTutorial: (thenPlay?: boolean) => void;
}

// ---------------------------------------------------------------- layout (window design units)

const WIN_W = 960;
const WIN_H = 600;
const PAD = space(6);
const INSET = space(4);
const GAP = space(3);
const BOTTOM = space(5);
const STAGE_W = 372;
const RIGHT_X = PAD + STAGE_W + space(4);
const RIGHT_W = WIN_W - PAD - RIGHT_X;
const GROOVE_W = RIGHT_W - INSET * 2;
const CELL_PAD = 8;
const ROW_H = Kit.SETTING_ROW_H;
const STATS_GROOVE_H = CELL_PAD * 2 + ROW_H * 2 + 4;
const STATS_H = Kit.sectionHeight(STATS_GROOVE_H);
const TILE_H = 52;
const TILE_GAP = 8;
const TILE_W = (GROOVE_W - CELL_PAD * 2 - TILE_GAP * 2) / 3;
const LOADOUT_GROOVE_H = CELL_PAD * 2 + TILE_H * 2 + TILE_GAP;
const LOADOUT_H = Kit.sectionHeight(LOADOUT_GROOVE_H);
const ACTION_H = 56;
const ACTION_Y = WIN_H - BOTTOM - ACTION_H;
/** Home at the bottom left (the PC menu's way back), the main action at the bottom right, under the right column */
const HOME_W = 168;
const MAIN_X = RIGHT_X;
const MAIN_W = RIGHT_W;
const NEW_GAME_W = 196;
const LABEL_W = 116;
/** the Wardrobe shortcut on the stage's title line, at its right (like the wardrobe's own keys) */
const WARDROBE_W = 150;
const WARDROBE_H = 34;

const BOLD = fontOf("sans", Enum.FontWeight.Bold);

/** the six slots of the loadout, in the order of the save (0 = the weapon, 1..5 = EquipSlot) */
const SLOT_KEYS = ["Weapon", "Clothes", "Hand", "Gun", "Outfit", "Pet"];

const HELP_TEXT = [
	"Your survivor as everyone sees them, how long this life has lasted and what you carry.",
	"Enter the city to play. The town keeps its own day, shared by everyone on this server.",
	"When a run is over: Rebirth wakes you now for coins, New game starts a new life at day 1.",
	"Outfits and pets are in the Wardrobe. Everyone sees them, and they change nothing else.",
].join("#");

interface SlotTile {
	frame: Frame;
	glyph: Glyph;
	name: TextLabel;
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
	private readonly levelKey: Frame;
	private readonly xp: Bar;
	private readonly xpText: TextLabel;
	private readonly slots: Array<SlotTile> = [];
	private readonly note: TextLabel;
	private readonly enter: TextButton;
	private readonly newGame: TextButton;
	private readonly rebirth: TextButton;
	private state: SurvivorState = { run: "fresh", hosted: false };

	constructor(parent: Instance, ctx: GameContext, handlers: SurvivorHandlers) {
		this.ctx = ctx;
		this.handlers = handlers;
		const lang = ctx.save.settings.langType;
		const tr = (k: string): string => langGet(k, lang);
		this.tr = tr;
		this.frame = makeFrame(parent, "Survivor", 0, 0, 1120, 630, THEME.background, { transparency: 1 });
		const win = Kit.Window(this.frame, "Window", {
			x: (1120 - WIN_W) / 2,
			y: (630 - WIN_H) / 2,
			w: WIN_W,
			h: WIN_H,
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
		const stageH = STATS_H + GAP + LOADOUT_H;
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

		// ---- stats: this life against the record (MP-13), the level and its XP
		const stats = Kit.Section(panel, "Stats", { x: RIGHT_X, y: top, w: RIGHT_W, h: STATS_H, title: tr("Stats") });
		const sGroove = Kit.Groove(stats.frame, "Rows", INSET, Kit.SECTION_CONTENT_Y, GROOVE_W, STATS_GROOVE_H);
		const halfW = (GROOVE_W - CELL_PAD * 3) / 2;
		const lifeRow = Kit.SettingCell(sGroove, "Life", {
			x: CELL_PAD,
			y: CELL_PAD,
			w: halfW,
			labelW: LABEL_W,
			label: tr("This life"),
			zIndex: sGroove.ZIndex + 1,
		});
		const recordRow = Kit.SettingCell(sGroove, "Record", {
			x: CELL_PAD * 2 + halfW,
			y: CELL_PAD,
			w: halfW,
			labelW: LABEL_W,
			label: tr("Record"),
			zIndex: sGroove.ZIndex + 1,
		});
		this.life = this.valueText(lifeRow.value, halfW - LABEL_W);
		this.record = this.valueText(recordRow.value, halfW - LABEL_W);
		const levelW = GROOVE_W - CELL_PAD * 2;
		const levelRow = Kit.SettingCell(sGroove, "Level", {
			x: CELL_PAD,
			y: CELL_PAD + ROW_H + 4,
			w: levelW,
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

		// ---- the loadout: the six slots, with the Bag's glyphs; an empty slot is a dark tile that says so
		const loadoutY = top + STATS_H + GAP;
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
			const tile = makeFrame(lGroove, `Slot${i}`, x, y, TILE_W, TILE_H, THEME.background, {
				transparency: 1,
				zIndex: lGroove.ZIndex + 1,
			});
			const z = tile.ZIndex + 1;
			const glyph = makeGlyph(tile, 10, (TILE_H - 32) / 2, 32, z);
			makeLabel(tile, "Slot", tr(SLOT_KEYS[i]).upper(), 50, 6, TILE_W - 58, 18, TEXT.xs, THEME.foreground, {
				font: "label",
				align: "left",
				zIndex: z,
			});
			const name = makeLabel(tile, "Name", "", 50, 24, TILE_W - 58, 22, TEXT.sm, THEME.foreground, {
				font: BOLD,
				align: "left",
				zIndex: z,
			});
			this.slots.push({ frame: tile, glyph, name });
		}

		// ---- the note, across the window, and the action row: Home at the left, the main action at the right
		const noteY = loadoutY + LOADOUT_H + GAP;
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

	/** a slot tile: iron with the item's glyph and name when something is in it, a dark tile saying Empty when not */
	private paintSlot(i: number): void {
		const save = this.ctx.save;
		const tile = this.slots[i];
		let name: string | undefined;
		let kind: number = ItemKind.Equip;
		if (i === 0) {
			// no weapon chosen yet means the starter one in hand (the old lobby said so too)
			const def = WEAPONS[save.equipWeapon >= 0 ? save.equipWeapon : 0];
			name = def?.name;
			kind = ItemKind.Weapon;
		} else {
			const id = equippedIn(save, i);
			name = id >= 0 ? EQUIPS[id]?.name : undefined;
		}
		const shown = name !== undefined ? this.tr(name) : this.tr("Empty");
		paintPlate(tile.frame, name !== undefined ? THEME.secondary : SURFACE.section, "flat", 4);
		setGlyph(tile.glyph, name !== undefined ? shown : "", kindTone(kind), name === undefined);
		this.write(tile.name, shown);
	}

	/** the action row and its note: Enter / Continue, or the MP-21 choice when the run is over */
	private paintAction(state: SurvivorState): void {
		const save = this.ctx.save;
		const tr = this.tr;
		const over = state.run === "over";
		setVisible(this.enter, !over);
		setVisible(this.newGame, over);
		setVisible(this.rebirth, over);
		const lines: Array<string> = [];
		if (over) {
			const price = rebirthPrice(save.deathCount);
			this.rebirth.Text = `${tr("Rebirth")}  ·  ${fmtInt(price)}`;
			setButtonVariant(this.rebirth, "default");
			lines.push(
				nl(
					tr(
						state.hosted
							? "Rebirth wakes you now. New game starts a new life at day 1,#which wakes at first light. Level, skills, coins and packs are kept."
							: "Rebirth to continue this run, or start a new game from day 1.#Level, skills, coins and packs are kept.",
					),
				),
			);
			const short = price - save.money;
			// the Rebirth stays pressable either way: the server answers with the reason, and this says it first
			if (short > 0) lines.push(`${tr("Not enough coins")} (need ${fmtInt(short)} more)`);
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

	/** the gamepad's first stop: the action that works (Rebirth only when it can be paid) */
	focus(): void {
		const s = this.state;
		if (s.run !== "over") {
			autoFocus(this.enter);
			return;
		}
		const affordable = this.ctx.save.money >= rebirthPrice(this.ctx.save.deathCount);
		autoFocus(affordable ? this.rebirth : this.newGame);
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
