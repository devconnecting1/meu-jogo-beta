import { GameContext } from "shared/game/context";
import { equippedIn, outfitLookOf, ownsCostume, ownsEquip, ownsTitle, petLookOf, titleWireOf } from "shared/game/save";
import { COSTUMES, CostumeDef } from "shared/data/shop";
import { EquipSlot } from "shared/data/equips";
import { cosmeticSlotOf, outfitLookOfEquip, petLookOfEquip } from "shared/data/cosmetics";
import { TITLES, TitleId, titleFromWire, titleToWire } from "shared/data/titles";
import { langGet } from "shared/data/lang";
import { invokeShopAction, onWalletChanged, requestSave, sessionReady } from "../systems/saveClient";
import { PreviewSubject, SurvivorPreview } from "../view/cosmeticPreview";
import { actionErrorText } from "./shop";
import { popup, toast } from "./popup";
import { Nameplate, profileOf } from "./nameplate";
import { titleColor, titleText } from "./titleStyle";
import { TEXT, THEME, fontOf, space } from "./theme";
import {
	Button,
	Keycap,
	Tabs,
	autoFocus,
	centredRect,
	fmtInt,
	linkGrid,
	makeCoinPill,
	makeFrame,
	makeLabel,
	makeScreen,
	nl,
	setButtonEnabled,
	setButtonVariant,
	setVisible,
	tabWidth,
} from "./widgets";
import * as Kit from "./window";

/*
 * The wardrobe (DESIGN_RULES MON-04, MON-05, UI-07): the outfits and the pets, tried on and bought in one window --
 * and the titles, which are never bought: earned by playing, chosen here, shown under the name.
 *
 *   ┌──────────────────────────── Wardrobe ───────────────────────────── X ┐
 *   │ [Outfits] [Pets]                                        ($ 1,843)    │
 *   │ ┌ Outfits ───── 1 / 3 ┐   ┌ Santa ─────────────────────── OUTFIT ┐   │
 *   │ │ ▣ ▣ ▣               │   │  the survivor wearing it (+ your pet) │   │
 *   │ └─────────────────────┘   │  Price | 30 coins                     │   │
 *   │  caption                  │  [        Buy for 30 coins         ]  │   │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * - Only tabs for what exists: one per cosmetic slot that has something in the catalogue (COSTUMES), today
 *   Outfits (Santa, Zombie, Cowboy) and Pets (the pigeons, the eagle, the dogs). No search box: nine items.
 * - The grid is the kit's GridTile on the dark groove: dark flat = yours, iron = worn now, padlock + price =
 *   locked, blue raised = selected. Each tile draws its cosmetic with the world's own drawing code.
 * - The preview is your current look with the selected item swapped in: on Outfits, the selected outfit and the
 *   pet you wear; on Pets, the outfit you wear and the selected pet. It is `SurvivorPreview`, the same drawing
 *   the world and the other players see.
 * - One primary action for the selection: Buy (coins), Equip or Unequip. Buying asks the SERVER
 *   (server/save/costumes.ts, through ShopAction): the request is the costume id and nothing else; ownership
 *   and coins come back in the wallet. Equip / Unequip go through the same path as the Bag (main.client.ts):
 *   the save the server re-checks for ownership on the next report.
 * - Nothing here pauses anything (UI-06): the wardrobe is a menu screen, reached from the lobby and the shop,
 *   never over a running world.
 * - Titles (MON-05), the third tab: ROWS, not tiles -- "[None]" / "Unequip title" first, then each title in brackets,
 *   in its colour, with the one line that says how it is earned. Locked rows are darker with a padlock; the one
 *   selected sits in the blue ring (kit ListRow); the one shown carries an EQUIPPED key. The details panel previews
 *   your nameplate with the selected title under your name (the world's own `Nameplate`, under your survivor), and
 *   the one action is Equip / Unequip -- or, locked, a disabled "Locked" with the requirement and the progress the
 *   server counted ("Zombies put down: 37 / 100"). Equip asks the SERVER (server/save/titles.ts, through ShopAction):
 *   the request is the title id, and a title it never granted is refused. No search box: three titles.
 * - Every page, row, tile and preview is built when the window opens; switching tabs and selecting only repaint and
 *   rewrite (tools/test-backpack.mjs parts 9 and 10 count the Instances).
 */

export interface WardrobeHandlers {
	onBack: () => void;
	/** wear an owned cosmetic (EQUIPS id); main.client applies it exactly as the Bag's Equip */
	onEquip: (equipId: number) => void;
	/** take off what is worn in a slot (EquipSlot) */
	onUnequip: (slot: number) => void;
}

// ---------------------------------------------------------------- layout (1120 x 630 design units)

const WIN_W = 960;
const WIN_H = 600;
const PAD = space(6);
const TAB_H = 34;
const COIN_W = 180;
const COIN_H = 40;
/** the section's inner margin (the groove / list inset, like Settings) */
const INSET = space(4);
/** the grid: 3 columns of square tiles on the groove, the gaps being the groove itself */
const COLS = 3;
const TILE = 104;
const TILE_GAP = 8;
const GRID_PAD = 8;
const GROOVE_W = COLS * TILE + (COLS - 1) * TILE_GAP + GRID_PAD * 2;
const GRID_W = GROOVE_W + INSET * 2;
/** a tile's drawing, inside the plate's relief */
const ICON_INSET = 6;
/** the details column, right of the grid */
const DETAIL_X = PAD + GRID_W + space(4);
const DETAIL_W = WIN_W - DETAIL_X - PAD;
const DETAIL_INNER_W = DETAIL_W - INSET * 2;
const STATUS_LABEL_W = 150;
const NOTE_H = 34;
const ACTION_H = 44;
const KEY_H = 28;

const BOLD = fontOf("sans", Enum.FontWeight.Bold);

/** what the "?" of the window explains ("#" = new line) */
const HELP_TEXT = [
	"Outfits change how your survivor looks, and a pet follows you. You can wear one of each.",
	"Everyone sees them, and they change nothing else: no defence, no speed, no loot.",
	"Locked items show their price in coins. Coins are earned by playing: days survived, record days and bosses.",
	"Titles are never sold: each one is earned by playing, and shows under your name for everyone.",
	"Pick an item to try it on in the preview, then buy or wear it.",
].join("#");

/** under the grid: what a purchase is (MON-04) and where coins come from */
const CAPTION = "What you buy is yours for good, and everyone sees it. Coins are earned by playing.";
/** under the titles: what a title is (MON-05) */
const TITLE_CAPTION = "Titles are earned by playing, never sold. Everyone sees yours under your name.";

/** the titles' rows (MON-05): two lines each -- the title, then how it is earned */
const TITLE_ROW_H = 58;
const TITLE_ROW_W = GROOVE_W - GRID_PAD * 2;
/** the EQUIPPED key at the right of the row shown under your name */
const WORN_KEY_H = 22;

/** the note of a slot: what the cosmetic does, and what it does not (MON-01) */
function slotNote(slot: number): string {
	return slot === EquipSlot.Pet
		? "It follows you and everyone sees it. It never fights or collects."
		: "Everyone sees it on your survivor. It changes nothing else.";
}

interface Page {
	/** tab / section title (a lang key) */
	key: string;
	/** EquipSlot.Outfit or EquipSlot.Pet */
	slot: number;
	subject: PreviewSubject;
	items: Array<CostumeDef>;
	tiles: Array<Kit.GridTileHandle>;
	/** index into `items` */
	selected: number;
	frame: Frame;
	/** "owned / total" on the section's title line */
	count: Frame;
}

/** the costumes of one cosmetic slot, in catalogue order (MON-04: a row that fits no slot is never offered) */
function costumesIn(slot: number): Array<CostumeDef> {
	return COSTUMES.filter(c => c.equipId >= 0 && cosmeticSlotOf(c.equipId) === slot);
}

/** a tile's state: worn now, yours, or locked (the SERVER's ownership, as the last wallet / LoadAck mirrored it) */
function tileState(ctx: GameContext, c: CostumeDef, slot: number): Kit.TileState {
	const save = ctx.save;
	if (!ownsEquip(save, c.equipId)) return "locked";
	return equippedIn(save, slot) === c.equipId ? "equipped" : "owned";
}

/** MON-05: the title under your name now (a TITLES id, -1 = none), by the very rule the server replicates with */
function shownTitle(ctx: GameContext): number {
	return titleFromWire(titleWireOf(ctx.save));
}

/**
 * How far a locked title is, on the counters the SERVER keeps (the wallet and the LoadAck mirror them): the kills its
 * credit gave you, the midnights it credited to this life (`lifeNights` -- not `day`, which may hold days counted
 * before the server counted them, or set by an admin). Never above the title's goal.
 */
function titleProgress(ctx: GameContext, titleId: number): number {
	const save = ctx.save;
	const def = TITLES[titleId];
	if (def === undefined) return 0;
	if (titleId === TitleId.HordeBreaker) return math.clamp(save.zombieKills, 0, def.goal);
	if (titleId === TitleId.WeekOne) return math.clamp(save.lifeNights, 0, def.goal);
	return ownsTitle(save, titleId) ? def.goal : 0;
}

/** one row of the Titles page: the title it offers (-1 = the "[None]" row) and its EQUIPPED key */
interface TitleRow {
	id: number;
	row: Kit.ListRowHandle;
	worn: Frame;
}

/**
 * A box for a Renderer drawing (a tile's cosmetic, the big preview). The kit lays out in Scale; the renderer draws
 * in offsets. So the drawing gets its own w x h design-unit space under a UIScale that keeps it exactly as big as
 * its holder on screen, whatever the screen. (The lobby's survivor previews use it too, client/ui/lobby.ts.)
 */
export function drawingBox(
	parent: Instance,
	name: string,
	x: number,
	y: number,
	w: number,
	h: number,
	zIndex: number,
): Frame {
	const holder = makeFrame(parent, name, x, y, w, h, THEME.background, { transparency: 1, zIndex });
	const inner = new Instance("Frame");
	inner.Name = "Scaled";
	inner.BackgroundTransparency = 1;
	inner.BackgroundColor3 = THEME.background;
	inner.BorderSizePixel = 0;
	inner.Size = UDim2.fromOffset(w, h);
	inner.ZIndex = zIndex;
	const scale = new Instance("UIScale");
	scale.Parent = inner;
	const fit = (): void => {
		const px = holder.AbsoluteSize.X;
		if (px > 0) scale.Scale = px / w;
	};
	holder.GetPropertyChangedSignal("AbsoluteSize").Connect(fit);
	fit();
	inner.Parent = holder;
	return inner;
}

export function showWardrobe(ctx: GameContext, handlers: WardrobeHandlers): () => void {
	const lang = ctx.save.settings.langType;
	const tr = (k: string): string => langGet(k, lang);
	// a menu screen: see-through, over the town flyover behind the menus (UI-10), its window centred on the screen
	const { root, body } = makeScreen(ctx.uiLayer, "Wardrobe", { transparency: 1, content: centredRect(WIN_W, WIN_H) });
	const RunService = game.GetService("RunService");
	// the Shop funnel's first step, on the wardrobe's screen (docs/ANALYTICS.md): fired and forgotten, as in shop.ts
	task.spawn(() => invokeShopAction({ kind: "viewShop", screen: 1 }));

	const win = Kit.Window(body, "Window", {
		...centredRect(WIN_W, WIN_H),
		title: tr("Wardrobe"),
		onClose: (): void => handlers.onBack(),
		onHelp: (): void => {
			popup(ctx, tr("Wardrobe"), nl(tr(HELP_TEXT)), [{ text: tr("Close"), variant: "secondary" }]);
		},
	});
	const panel = win.frame;
	const tabsY = win.contentY + space(1);
	const bodyY = tabsY + TAB_H + space(4);
	const bodyH = WIN_H - bodyY - space(5);
	const coins = makeCoinPill(
		panel,
		"Coins",
		WIN_W - PAD - COIN_W,
		tabsY + (TAB_H - COIN_H) / 2,
		COIN_W,
		COIN_H,
		() => ctx.save.money,
	);

	let tab = 0;
	let busy = false;
	const pages: Array<Page> = [];
	const icons: Array<SurvivorPreview> = [];
	let refresh = (): void => {};
	// MON-05: the Titles tab comes after the cosmetic pages; its rows, and which one is selected ("[None]" is row 0)
	let titlesTab = -1;
	const titleRows: Array<TitleRow> = [];
	let titleSel = shownTitle(ctx) + 1;

	// ---- the details column: the selection's name and slot, the preview, its status, the one action
	const details = Kit.Section(panel, "Details", { x: DETAIL_X, y: bodyY, w: DETAIL_W, h: bodyH, title: "" });
	const dz = details.frame.ZIndex + 1;
	const slotKey = Keycap(details.frame, "Slot", "", {
		x: DETAIL_W - space(5),
		cy: Kit.SECTION_TITLE_MID,
		anchorX: 1,
		h: KEY_H,
		minW: 90,
		textSize: TEXT.base,
		font: BOLD,
		zIndex: dz,
	});
	const actionY = bodyH - INSET - ACTION_H;
	const listH = Kit.settingsListHeight([Kit.SETTING_ROW_H, NOTE_H]);
	const listY = actionY - space(3) - listH;
	const previewH = listY - space(3) - Kit.SECTION_CONTENT_Y;
	const bed = Kit.Groove(details.frame, "PreviewBed", INSET, Kit.SECTION_CONTENT_Y, DETAIL_INNER_W, previewH);
	const previewBox = drawingBox(bed, "Preview", 0, 0, DETAIL_INNER_W, previewH, bed.ZIndex + 1);
	const preview = new SurvivorPreview(previewBox, { w: DETAIL_INNER_W, h: previewH, zIndex: previewBox.ZIndex });
	const info = Kit.SettingsList(details.frame, "Info", INSET, listY, DETAIL_INNER_W, listH);
	const statusRow = Kit.SettingRow(info, "Status", 0, tr("Status"), { labelW: STATUS_LABEL_W });
	const statusKey = Kit.ValueKey(statusRow.value, "Value", "", { minW: 160 });
	const note = Kit.SettingNote(info, "Note", 1, "", NOTE_H);

	// ---- MON-05: the Titles tab's preview, in the same bed: your survivor and, hanging under it as in the street, your
	// nameplate -- the world's own `Nameplate` -- with the selected title under your name
	const titleBox = makeFrame(bed, "TitlePreview", 0, 0, DETAIL_INNER_W, previewH, THEME.background, {
		transparency: 1,
		zIndex: bed.ZIndex + 1,
	});
	const bodyS = math.min(previewH * 0.55, 140);
	const bodyTop = previewH * 0.08;
	const bodyBox = drawingBox(
		titleBox,
		"Survivor",
		(DETAIL_INNER_W - bodyS) / 2,
		bodyTop,
		bodyS,
		bodyS,
		titleBox.ZIndex + 1,
	);
	const titleBody = new SurvivorPreview(bodyBox, { w: bodyS, h: bodyS, subject: "outfit", zIndex: bodyBox.ZIndex });
	// drawn once now, so its sprites exist before the tab is ever opened (a later draw only rewrites them)
	titleBody.setOutfit(outfitLookOf(ctx.save));
	titleBody.draw(0);
	const plateTop = bodyTop + bodyS + space(1);
	const plateHost = makeFrame(
		titleBox,
		"PlateHost",
		0,
		plateTop,
		DETAIL_INNER_W,
		previewH - plateTop,
		THEME.background,
		{
			transparency: 1,
			zIndex: titleBox.ZIndex + 1,
		},
	);
	const me = game.GetService("Players").LocalPlayer;
	const who = me !== undefined ? profileOf(me) : { displayName: tr("Survivor"), name: tr("Survivor") };
	// `self`: exactly the plate the street shows under you (no "@handle": nameplate.ts); not `world`, so it never
	// takes part in the street's overlap rule
	const titlePlate = new Nameplate(plateHost, plateHost.ZIndex + 1, who, { self: true });
	/** the title byte the preview plate shows (`titleToWire`) */
	let previewTitle = 0;
	const placePlate = (): void => {
		titlePlate.update(plateHost.AbsoluteSize.X / 2, 0, ctx.save.level, true, previewTitle);
	};
	plateHost.GetPropertyChangedSignal("AbsoluteSize").Connect(placePlate);
	setVisible(titleBox, false);

	const selection = (): [Page, CostumeDef] | undefined => {
		const page = pages[tab];
		if (page === undefined) return undefined;
		const c = page.items[page.selected];
		return c !== undefined ? [page, c] : undefined;
	};

	const buy = (c: CostumeDef, btn: TextButton): void => {
		if (busy) return;
		if (!sessionReady()) {
			toast(ctx, tr("Still loading your progress"), "error");
			return;
		}
		busy = true;
		setButtonEnabled(btn, false);
		// the id and nothing else: the price, the coins and the ownership are the server's (server/save/costumes.ts)
		const res = invokeShopAction({ kind: "buyCostume", costumeId: c.id });
		busy = false;
		if (root.Parent === undefined) return; // closed while the server answered
		setButtonEnabled(btn, true);
		if (res.ok) toast(ctx, `${tr("Purchased")}: ${tr(c.name)}`, "success");
		else toast(ctx, actionErrorText(res.reason, lang), "error");
		refresh();
	};

	/**
	 * MON-05: show `titleId` under the name (-1 = none). The request is the id and nothing else: whether it was EARNED
	 * is the server's to say (server/save/titles.ts, through ShopAction), and a refusal changes nothing here.
	 */
	const setTitle = (titleId: number): void => {
		if (busy) return;
		if (!sessionReady()) {
			toast(ctx, tr("Still loading your progress"), "error");
			return;
		}
		busy = true;
		setButtonEnabled(action, false);
		const res = invokeShopAction({ kind: "equipTitle", titleId });
		busy = false;
		if (root.Parent === undefined) return; // closed while the server answered
		if (res.ok) {
			ctx.save.equipTitle = titleId;
			// the next report carries the same choice, so one already on its way cannot put the old title back
			requestSave("equip");
		} else {
			toast(ctx, actionErrorText(res.reason, lang), "error");
		}
		refresh();
	};

	/** the Titles tab's one action: Equip the selected title, or Unequip the one shown ("[None]" takes it off) */
	const actTitle = (): void => {
		const sel = titleRows[titleSel];
		if (sel === undefined) return;
		const shown = shownTitle(ctx);
		if (sel.id < 0) {
			if (shown >= 0) setTitle(-1);
			return;
		}
		// a locked title's button is disabled; this is only the belt to that brace
		if (!ownsTitle(ctx.save, sel.id)) return;
		setTitle(sel.id === shown ? -1 : sel.id);
	};

	const act = (): void => {
		if (tab === titlesTab) {
			actTitle();
			return;
		}
		const sel = selection();
		if (sel === undefined) return;
		const [page, c] = sel;
		const save = ctx.save;
		if (!ownsEquip(save, c.equipId)) {
			buy(c, action);
			return;
		}
		if (equippedIn(save, page.slot) === c.equipId) handlers.onUnequip(page.slot);
		else handlers.onEquip(c.equipId);
		refresh();
	};
	const action: TextButton = Button(details.frame, "Action", "", {
		x: INSET,
		y: actionY,
		w: DETAIL_INNER_W,
		h: ACTION_H,
		textSize: TEXT.lg,
		zIndex: dz,
		onClick: act,
	});
	// a pet that came in a pack is worn like any other, but it goes with the next New game: the permanent one
	// is still for sale, so the row splits into wear | keep for good (the old shop always offered the Buy)
	const halfW = math.floor((DETAIL_INNER_W - space(2)) / 2);
	const packAction: TextButton = Button(details.frame, "PackAction", "", {
		x: INSET,
		y: actionY,
		w: halfW,
		h: ACTION_H,
		textSize: TEXT.lg,
		zIndex: dz,
		onClick: act,
	});
	const keep: TextButton = Button(details.frame, "Keep", "", {
		x: INSET + DETAIL_INNER_W - halfW,
		y: actionY,
		w: halfW,
		h: ACTION_H,
		textSize: TEXT.lg,
		zIndex: dz,
		onClick: (): void => {
			const sel = selection();
			if (sel !== undefined) buy(sel[1], keep);
		},
	});
	setVisible(packAction, false);
	setVisible(keep, false);

	// ---- the pages: one grid of tiles per slot that has something to sell
	const PAGE_DEFS: Array<[string, number, PreviewSubject]> = [
		["Outfits", EquipSlot.Outfit, "outfit"],
		["Pets", EquipSlot.Pet, "pet"],
	];
	for (const [key, slot, subject] of PAGE_DEFS) {
		const items = costumesIn(slot);
		if (items.size() === 0) continue;
		const index = pages.size();
		const rows = math.ceil(items.size() / COLS);
		const grooveH = rows * TILE + (rows - 1) * TILE_GAP + GRID_PAD * 2;
		const sectionH = Kit.sectionHeight(grooveH);
		const frame = makeFrame(panel, `Page${index}`, PAD, bodyY, GRID_W, bodyH, THEME.background, {
			transparency: 1,
		});
		const sec = Kit.Section(frame, "Grid", { x: 0, y: 0, w: GRID_W, h: sectionH, title: tr(key) });
		const count = Keycap(sec.frame, "Count", "", {
			x: GRID_W - space(5),
			cy: Kit.SECTION_TITLE_MID,
			anchorX: 1,
			h: KEY_H,
			minW: 64,
			textSize: TEXT.base,
			font: BOLD,
			zIndex: sec.frame.ZIndex + 1,
		});
		const groove = Kit.Groove(sec.frame, "Groove", INSET, Kit.SECTION_CONTENT_Y, GROOVE_W, grooveH);
		makeLabel(
			frame,
			"Caption",
			tr(CAPTION),
			space(2),
			sectionH + space(3),
			GRID_W - space(4),
			44,
			TEXT.sm,
			THEME.mutedForeground,
			{ align: "left", valign: "top" },
		);
		const page: Page = { key, slot, subject, items, tiles: [], selected: 0, frame, count };
		const worn = equippedIn(ctx.save, slot);
		for (let j = 0; j < items.size(); j++) {
			const c = items[j];
			if (c.equipId === worn && ownsEquip(ctx.save, worn)) page.selected = j;
			const tile = Kit.GridTile(groove, `Tile${j}`, {
				x: GRID_PAD + (j % COLS) * (TILE + TILE_GAP),
				y: GRID_PAD + math.floor(j / COLS) * (TILE + TILE_GAP),
				size: TILE,
				zIndex: groove.ZIndex + 1,
				onClick: (): void => {
					page.selected = j;
					refresh();
				},
			});
			// the cosmetic itself, drawn once by the world's own code (a tile only changes colour afterwards)
			const iconW = TILE - ICON_INSET * 2;
			const box = drawingBox(tile.content, "Icon", ICON_INSET, ICON_INSET, iconW, iconW, tile.content.ZIndex);
			const icon = new SurvivorPreview(box, { w: iconW, h: iconW, subject, zIndex: box.ZIndex });
			if (subject === "pet") icon.setPet(petLookOfEquip(c.equipId));
			else icon.setOutfit(outfitLookOfEquip(c.equipId));
			icon.draw(0);
			icons.push(icon);
			page.tiles.push(tile);
		}
		// the pad walks the tiles as the grid they are, row by row (the details panel stays to their right)
		linkGrid(
			page.tiles.map(t => t.button),
			COLS,
		);
		pages.push(page);
	}

	// ---- MON-05: the Titles page -- ROWS on the groove, "[None]" first, then every title in the data table's order
	titlesTab = pages.size();
	const rowCount = TITLES.size() + 1;
	const titleGrooveH = rowCount * TITLE_ROW_H + (rowCount - 1) * TILE_GAP + GRID_PAD * 2;
	const titleSectionH = Kit.sectionHeight(titleGrooveH);
	const titleFrame = makeFrame(panel, `Page${titlesTab}`, PAD, bodyY, GRID_W, bodyH, THEME.background, {
		transparency: 1,
	});
	const titleSec = Kit.Section(titleFrame, "List", { x: 0, y: 0, w: GRID_W, h: titleSectionH, title: tr("Titles") });
	const titleCount = Keycap(titleSec.frame, "Count", "", {
		x: GRID_W - space(5),
		cy: Kit.SECTION_TITLE_MID,
		anchorX: 1,
		h: KEY_H,
		minW: 64,
		textSize: TEXT.base,
		font: BOLD,
		zIndex: titleSec.frame.ZIndex + 1,
	});
	const titleGroove = Kit.Groove(titleSec.frame, "Groove", INSET, Kit.SECTION_CONTENT_Y, GROOVE_W, titleGrooveH);
	makeLabel(
		titleFrame,
		"Caption",
		tr(TITLE_CAPTION),
		space(2),
		titleSectionH + space(3),
		GRID_W - space(4),
		44,
		TEXT.sm,
		THEME.mutedForeground,
		{ align: "left", valign: "top" },
	);
	const textX = Kit.LIST_ROW_TEXT_X;
	for (let j = 0; j < rowCount; j++) {
		const id = j - 1;
		const row = Kit.ListRow(titleGroove, `Row${j}`, {
			x: GRID_PAD,
			y: GRID_PAD + j * (TITLE_ROW_H + TILE_GAP),
			w: TITLE_ROW_W,
			h: TITLE_ROW_H,
			zIndex: titleGroove.ZIndex + 1,
			onClick: (): void => {
				titleSel = j;
				refresh();
			},
		});
		const z = row.content.ZIndex + 1;
		// line 1: the title in brackets, in its colour; line 2: how it is earned (built once, never rewritten)
		const name = id < 0 ? `[${tr("None")}]` : titleText(id, lang);
		const tone = id < 0 ? THEME.foreground : titleColor(id);
		makeLabel(row.content, "Name", name, textX, 7, TITLE_ROW_W - textX - 104, 24, TEXT.lg, tone, {
			font: BOLD,
			align: "left",
			zIndex: z,
		});
		const howTo = tr(id < 0 ? "Unequip title" : TITLES[id].howTo);
		makeLabel(
			row.content,
			"HowTo",
			howTo,
			textX,
			31,
			TITLE_ROW_W - textX - space(3),
			20,
			TEXT.sm,
			THEME.mutedForeground,
			{
				align: "left",
				zIndex: z,
			},
		);
		const worn = Keycap(row.content, "Worn", tr("EQUIPPED"), {
			x: TITLE_ROW_W - space(3),
			cy: 19,
			anchorX: 1,
			h: WORN_KEY_H,
			minW: 72,
			textSize: TEXT.xs,
			font: BOLD,
			zIndex: z,
		});
		titleRows.push({ id, row, worn });
	}

	/** the Titles page and, while it is the tab, the details column: a repaint of what exists, never a rebuild */
	const refreshTitles = (): void => {
		const save = ctx.save;
		const shown = shownTitle(ctx);
		let earned = 0;
		for (let j = 0; j < titleRows.size(); j++) {
			const r = titleRows[j];
			const owned = r.id < 0 || ownsTitle(save, r.id);
			if (r.id >= 0 && owned) earned++;
			const worn = r.id === shown;
			r.row.update(owned ? (worn ? "equipped" : "owned") : "locked", j === titleSel);
			setVisible(r.worn, worn && r.id >= 0);
		}
		Kit.setValueKey(titleCount, `${earned} / ${TITLES.size()}`);
		if (tab !== titlesTab) return;
		const sel = titleRows[titleSel];
		if (sel === undefined) return;
		const id = sel.id;
		const owned = id < 0 || ownsTitle(save, id);
		const worn = id === shown;
		if (details.title !== undefined) details.title.Text = id < 0 ? tr("None") : tr(TITLES[id].name);
		Kit.setValueKey(slotKey, tr("TITLE"));
		statusRow.label.Text = tr("Status");
		Kit.setValueKey(statusKey, tr(!owned ? "Locked" : worn ? "Equipped" : "Owned"));
		if (id < 0) {
			note.Text = tr("No title under your name.");
		} else if (!owned) {
			// the requirement and how far the server counted you (MON-05): "Zombies put down: 37 / 100"
			const def = TITLES[id];
			const progress = `${tr(def.progressLabel)}: ${fmtInt(titleProgress(ctx, id))} / ${fmtInt(def.goal)}`;
			note.Text = `${tr(def.howTo)} ${progress}`;
		} else {
			note.Text = tr("Earned by playing, never sold. Everyone sees it under your name.");
		}
		setVisible(action, true);
		setVisible(packAction, false);
		setVisible(keep, false);
		if (!owned) {
			// the quiet iron, disabled: nothing a click could do (the disabled plate is the kit's dark slot)
			action.Text = tr("Locked");
			setButtonVariant(action, "secondary");
			setButtonEnabled(action, false);
		} else if (worn || id < 0) {
			action.Text = tr("Unequip");
			setButtonVariant(action, "secondary");
			// "[None]" while nothing is shown: there is nothing to take off
			setButtonEnabled(action, !busy && shown >= 0);
		} else {
			action.Text = tr("Equip");
			setButtonVariant(action, "default");
			setButtonEnabled(action, !busy);
		}
		// try it on: your survivor as you look now, with the selected title under your name
		previewTitle = titleToWire(id);
		titleBody.setOutfit(outfitLookOf(save));
		titleBody.draw(0);
		placePlate();
	};

	refresh = (): void => {
		if (root.Parent === undefined) return;
		coins.refresh();
		const save = ctx.save;
		const onTitles = tab === titlesTab;
		setVisible(titleFrame, onTitles);
		setVisible(previewBox, !onTitles);
		setVisible(titleBox, onTitles);
		refreshTitles();
		for (let i = 0; i < pages.size(); i++) {
			const page = pages[i];
			setVisible(page.frame, i === tab);
			let owned = 0;
			for (let j = 0; j < page.items.size(); j++) {
				const c = page.items[j];
				const state = tileState(ctx, c, page.slot);
				if (state !== "locked") owned++;
				page.tiles[j].update(state, j === page.selected, state === "locked" ? c.price : undefined);
			}
			Kit.setValueKey(page.count, `${owned} / ${page.items.size()}`);
		}
		if (onTitles) return;
		const sel = selection();
		if (sel === undefined) return;
		// the Titles tab may have left the one action disabled ("Locked"); a cosmetic always has something to offer
		setButtonEnabled(action, true);
		const [page, c] = sel;
		const state = tileState(ctx, c, page.slot);
		const locked = state === "locked";
		const affordable = save.money >= c.price;
		if (details.title !== undefined) details.title.Text = tr(c.name);
		Kit.setValueKey(slotKey, tr(page.slot === EquipSlot.Pet ? "PET" : "OUTFIT"));
		// owned through a pack, not bought: it lives in the run's inventory, which a New game starts over
		const fromPack = !locked && !ownsCostume(save, c.id);
		statusRow.label.Text = tr(locked ? "Price" : "Status");
		let status = tr("Owned");
		if (locked) status = `${fmtInt(c.price)} ${tr("coins")}`;
		else if (state === "equipped") status = tr("Equipped");
		else if (fromPack) status = tr("From a pack");
		Kit.setValueKey(statusKey, status);
		if (locked && !affordable) {
			const have = `${tr("You have")} ${fmtInt(save.money)}`;
			note.Text = `${tr("Not enough coins")}. ${have}. ${tr("Coins are earned by playing")}.`;
		} else if (fromPack) {
			note.Text = tr("Came in a pack: it stays until a New game. Buy it to keep it for good.");
		} else {
			note.Text = tr(slotNote(page.slot));
		}
		if (locked) {
			action.Text = `${tr("Buy for")} ${fmtInt(c.price)} ${tr("coins")}`;
			// can't afford it: the quiet look, still pressable -- the server answers either way, with the reason
			setButtonVariant(action, affordable ? "default" : "outline");
		} else if (state === "equipped") {
			action.Text = tr("Unequip");
			setButtonVariant(action, "secondary");
		} else {
			action.Text = tr("Equip");
			setButtonVariant(action, "default");
		}
		setVisible(action, !fromPack);
		setVisible(packAction, fromPack);
		setVisible(keep, fromPack);
		if (fromPack) {
			packAction.Text = action.Text;
			setButtonVariant(packAction, state === "equipped" ? "secondary" : "default");
			keep.Text = `${tr("Buy for")} ${fmtInt(c.price)} ${tr("coins")}`;
			setButtonVariant(keep, affordable ? "default" : "outline");
		}
		// try it on: your current look with the selected item swapped in
		preview.setOutfit(page.slot === EquipSlot.Outfit ? outfitLookOfEquip(c.equipId) : outfitLookOf(save));
		preview.setPet(page.slot === EquipSlot.Pet ? petLookOfEquip(c.equipId) : petLookOf(save));
	};

	// ---- the tab bar: only the pages that exist, and the titles
	const names = pages.map(p => tr(p.key));
	names.push(tr("Titles"));
	const widths = names.map(n => tabWidth(n));
	let tabsW = 0;
	for (const w of widths) tabsW += w + space(3);
	const tabs = Tabs(panel, "Tabs", {
		x: PAD,
		y: tabsY,
		w: math.min(tabsW, WIN_W - PAD * 2 - COIN_W - space(4)),
		h: TAB_H,
		items: names,
		widths,
		value: tab,
		onChange: (i: number): void => {
			tab = i;
			refresh();
			if (i === titlesTab) {
				const r = titleRows[titleSel];
				if (r !== undefined) autoFocus(r.row.button);
				return;
			}
			const page = pages[i];
			if (page !== undefined) autoFocus(page.tiles[page.selected].button);
		},
	});

	refresh();
	const first = pages[tab];
	autoFocus(first !== undefined ? first.tiles[first.selected].button : tabs.triggers[0]);

	// the big preview breathes (a dog's tail, the idle pose); a frame where nothing moved writes nothing. On the Titles
	// tab it is hidden, and the title preview is still: nothing to draw per frame
	const t0 = os.clock();
	const conn = RunService.RenderStepped.Connect(() => {
		if (tab !== titlesTab) preview.draw(os.clock() - t0);
	});
	const unsubscribe = onWalletChanged(() => {
		if (!busy) refresh();
		else coins.refresh();
	});

	return (): void => {
		unsubscribe();
		conn.Disconnect();
		for (const icon of icons) icon.destroy();
		preview.destroy();
		titleBody.destroy();
		titlePlate.destroy();
		root.Destroy();
	};
}
