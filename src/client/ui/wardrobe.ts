import { GameContext } from "shared/game/context";
import { equippedIn, outfitLookOf, ownsCostume, ownsEquip, ownsTitle, petLookOf, titleWireOf } from "shared/game/save";
import { COSTUMES, CostumeDef } from "shared/data/shop";
import { EquipSlot } from "shared/data/equips";
import { cosmeticSlotOf, outfitLookOfEquip, petLookOfEquip } from "shared/data/cosmetics";
import {
	TITLES,
	bitCount,
	rarityKeyName,
	rarityName,
	titleFromWire,
	titlesInOrder,
	titleToWire,
} from "shared/data/titles";
import { langGet } from "shared/data/lang";
import {
	invokeShopAction,
	onRobuxOfferChanged,
	onRobuxPendingChanged,
	onWalletChanged,
	requestSave,
	robuxOffer,
	robuxPending,
	robuxRejoin,
	sessionReady,
} from "../systems/saveClient";
import { askRobuxPrice, onRobuxPrice, robuxPriceShown } from "../systems/robuxPrices";
import { PreviewSubject, SurvivorPreview } from "../view/cosmeticPreview";
import { drawingBox } from "./drawingBox";
import { actionErrorText, fundsErrorText } from "./shop";
import { popup, toast } from "./popup";
import { Nameplate, profileOf } from "./nameplate";
import { rarityColor, titleColor, titleText } from "./titleStyle";
import { localIsSupporter, supporterOnOffer } from "../systems/supporterClient";
import { SupporterPage, mountSupporterPage } from "./supporterPage";
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
	sizeRow,
	tabWidth,
} from "./widgets";
import * as Kit from "./window";

/*
 * The wardrobe (DESIGN_RULES MON-04, MON-05, UI-07): the outfits and the pets, tried on and bought in one window --
 * and the titles, which are never bought: earned by playing, chosen here, shown under the name.
 *
 *   ┌──────────────────────────── Wardrobe ───────────────────────────── X ┐
 *   │ [Outfits] [Pets]                                        (● 1,843)    │
 *   │ ┌ Outfits ───── 1 / 3 ┐   ┌ Santa ─────────────────────── OUTFIT ┐   │
 *   │ │ ▣ ▣ ▣               │   │  the survivor wearing it (+ your pet) │   │
 *   │ └─────────────────────┘   │  Price | 250 coins                    │   │
 *   │  caption                  │  [        Buy for 250 coins        ]  │   │
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
 * - Robux (docs/SHOP.md "Robux: decisões e desenho", MON-04 as amended): a locked costume the server sells for Robux
 *   too shows both prices on its row ("600 coins · 349 Robux" -- the word, never "R$": MON-06 keeps real-money signs
 *   out) and splits the action: the coin Buy stays the primary, on the left where the pad arrives from the grid, and
 *   "See price" sits at its right, secondary (BEM-02). It asks the SERVER to open Roblox's own prompt
 *   (server/save/robux.ts); the costume comes with the receipt, on the pushed wallet, and says "Unlocked". The Robux
 *   number is what THIS player pays (client/systems/robuxPrices.ts: Roblox Plus and regional pricing change it), and
 *   none is shown until Roblox says it. A payment on its way (the server's pz_robux_pending) shows as Pending, with
 *   nothing to buy. No offer (no product configured, or one whose price Roblox does not confirm): the panel is exactly
 *   the coin one. A pet that came in a pack keeps its two buttons (wear | keep for good, in coins). The tiles show
 *   coins only.
 * - Nothing here pauses anything (UI-06): the wardrobe is a menu screen, reached from the lobby and the shop,
 *   never over a running world.
 * - Titles (MON-05), the third tab: ROWS, not tiles, in a scrolling groove -- "[None]" / "Unequip title" first, then
 *   every title by rarity from Common up (the ladder), each in brackets in its rarity's colour with the rarity's word
 *   at the right ("Legendary": the colour is never the only cue) and the one line that says how it is earned. Locked
 *   rows are darker with a padlock; a locked SECRET says "[???]" and only that it is a secret, until the server grants
 *   it. The one selected sits in the blue ring (kit ListRow); the one shown carries an EQUIPPED key. The details panel
 *   previews your nameplate with the selected title under your name (the world's own `Nameplate`, under your survivor),
 *   and the one action is Equip / Unequip -- or, locked, a disabled "Locked" with the requirement and the progress the
 *   server counted ("Zombies put down: 37 / 100"). Equip asks the SERVER (server/save/titles.ts, through ShopAction):
 *   the request is the title id, and a title it never granted is refused. No search box: the ladder is short.
 * - Supporter (MON-07), a fourth tab only when the subscription is configured (shared/data/supporter.ts): the whole
 *   body, apart from the titles -- what it gives, what it never gives, the price the platform states and its prompt
 *   (client/ui/supporterPage.ts). The Supporter heart is never a title.
 * - Every page, row, tile and preview is built when the window opens; switching tabs and selecting only repaint and
 *   rewrite (tools/test-backpack.mjs parts 9 and 10 count the Instances).
 */

export interface WardrobeHandlers {
	onBack: () => void;
	/** wear an owned cosmetic (EQUIPS id); main.client applies it exactly as the Bag's Equip */
	onEquip: (equipId: number) => void;
	/** take off what is worn in a slot (EquipSlot) */
	onUnequip: (slot: number) => void;
	/** the tab to open on: EquipSlot.Outfit or Pet (the Survivor screen's loadout tile of that slot); none = the first */
	slot?: number;
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
	"A title's colour says how rare it is, from Common to Legendary. A few are secret until you earn them.",
	"Pick an item to try it on in the preview, then buy or wear it.",
].join("#");

/** under the grid: what a purchase is (MON-04) and where coins come from */
const CAPTION = "What you buy is yours for good, and everyone sees it. Coins are earned by playing.";
/** under the titles: what a title is (MON-05) */
const TITLE_CAPTION = "Titles are earned by playing, never sold. Everyone sees yours under your name.";

/** the titles' rows (MON-05): two lines each -- the title and its rarity, then how it is earned */
const TITLE_ROW_H = 58;
/** the EQUIPPED key at the right of the row shown under your name */
const WORN_KEY_H = 22;
/** the rarity's word at the right of a row's first line ("Legendary") */
const RARITY_W = 96;
/** a secret title while it is locked (MON-05): its name and its how-to stay a surprise */
const SECRET_NAME = "???";
const SECRET_HOWTO = "A secret title. It shows here once you earn it.";

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
 * before the server counted them, or set by an admin), the nights of a life that has not died, and the title counters
 * (`titleStats`: nights lived, the kinds of zombie and boss, firearm and turret kills, constructions, crafts). Never
 * above the title's goal; an earned title is at its goal whatever the counter says (it may have been earned before
 * the counter existed).
 */
export function titleProgress(ctx: GameContext, titleId: number): number {
	const save = ctx.save;
	const def = TITLES[titleId];
	if (def === undefined) return 0;
	if (ownsTitle(save, titleId)) return def.goal;
	let v = 0;
	if (def.track === "kills") v = save.zombieKills;
	else if (def.track === "lifeNights") v = save.lifeNights;
	else if (def.track === "deathless") v = save.lifeDeaths > 0 ? 0 : save.lifeNights;
	else if (def.track === "stat" && def.stat !== undefined) v = save.titleStats[def.stat] ?? 0;
	else if (def.track === "bits" && def.stat !== undefined) v = bitCount(save.titleStats[def.stat] ?? 0, 8);
	return math.clamp(v, 0, def.goal);
}

/**
 * One row of the Titles page: the title it offers (-1 = the "[None]" row), its EQUIPPED key, and the two labels a
 * secret title rewrites the moment it is earned (its name and its how-to; every other row writes them once).
 */
interface TitleRow {
	id: number;
	row: Kit.ListRowHandle;
	worn: Frame;
	name: TextLabel;
	howTo: TextLabel;
	/** the row shows a secret title's real name (it was earned); false for a locked secret and every other row */
	revealed: boolean;
}

/** a secret title the save has not earned: the wardrobe keeps its name and how-to to itself (MON-05) */
function hiddenSecret(ctx: GameContext, titleId: number): boolean {
	const def = TITLES[titleId];
	return def !== undefined && def.secret === true && !ownsTitle(ctx.save, titleId);
}

/** the box a Renderer drawing lives in: client/ui/drawingBox.ts (kept importable from here: lobby, Survivor screen) */
export { drawingBox };

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
	/** MON-07: the Supporter tab's index and its page, -1 / undefined when there is no subscription to offer */
	let supporterTab = -1;
	let supporter: SupporterPage | undefined;
	const titleRows: Array<TitleRow> = [];
	let titleSel = 0;

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
		// exactly the street's plate: your title (or the one tried on) and, MON-07, your Supporter heart if you wear one
		titlePlate.update(plateHost.AbsoluteSize.X / 2, 0, ctx.save.level, true, previewTitle, localIsSupporter());
	};
	plateHost.GetPropertyChangedSignal("AbsoluteSize").Connect(placePlate);
	setVisible(titleBox, false);

	const selection = (): [Page, CostumeDef] | undefined => {
		const page = pages[tab];
		if (page === undefined) return undefined;
		const c = page.items[page.selected];
		return c !== undefined ? [page, c] : undefined;
	};

	/**
	 * The costumes owned for good as this window last saw them: one that turns up owned outside a coin purchase came
	 * with a Robux receipt (server/save/robux.ts), and says so ("Unlocked: Santa")
	 */
	const ownedSeen = new Set<number>();
	for (const c of COSTUMES) if (ownsCostume(ctx.save, c.id)) ownedSeen.add(c.id);
	const noteUnlocks = (): void => {
		for (const c of COSTUMES) {
			if (ownedSeen.has(c.id) || !ownsCostume(ctx.save, c.id)) continue;
			ownedSeen.add(c.id);
			toast(ctx, `${tr("Unlocked")}: ${tr(c.name)}`, "success");
		}
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
		if (res.ok) {
			ownedSeen.add(c.id);
			toast(ctx, `${tr("Purchased")}: ${tr(c.name)}`, "success");
		} else {
			toast(ctx, fundsErrorText(res.reason, c.price - ctx.save.money, lang), "error");
		}
		noteUnlocks();
		refresh();
	};

	/**
	 * "See price": asks the SERVER to open Roblox's prompt for `c` -- the id and nothing else (server/save/robux.ts
	 * decides whether it is sold, at what price, and that it is not yours). Nothing is granted here: the costume comes
	 * with its receipt, on the pushed wallet (`noteUnlocks`).
	 */
	const seePrice = (c: CostumeDef, btn: TextButton): void => {
		if (busy) return;
		if (!sessionReady()) {
			toast(ctx, tr("Still loading your progress"), "error");
			return;
		}
		busy = true;
		setButtonEnabled(btn, false);
		const res = invokeShopAction({ kind: "robuxCostume", costumeId: c.id });
		busy = false;
		if (root.Parent === undefined) return; // closed while the server answered
		setButtonEnabled(btn, true);
		if (!res.ok) toast(ctx, actionErrorText(res.reason, lang), "error");
		noteUnlocks();
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
	// the same costume for Robux (docs/SHOP.md): the coin Buy on the left -- the primary, where the pad lands coming
	// from the grid -- and "See price" on the right, secondary (BEM-02). Built now, shown only for a locked costume the
	// server sells for Robux
	const coinBuy: TextButton = Button(details.frame, "CoinBuy", "", {
		x: INSET,
		y: actionY,
		w: halfW,
		h: ACTION_H,
		textSize: TEXT.lg,
		zIndex: dz,
		onClick: (): void => {
			const sel = selection();
			if (sel !== undefined) buy(sel[1], coinBuy);
		},
	});
	const robuxBuy: TextButton = Button(details.frame, "RobuxBuy", tr("See price"), {
		x: INSET + DETAIL_INNER_W - halfW,
		y: actionY,
		w: halfW,
		h: ACTION_H,
		textSize: TEXT.lg,
		variant: "secondary",
		zIndex: dz,
		onClick: (): void => {
			const sel = selection();
			if (sel !== undefined) seePrice(sel[1], robuxBuy);
		},
	});
	coinBuy.NextSelectionRight = robuxBuy;
	robuxBuy.NextSelectionLeft = coinBuy;
	setVisible(coinBuy, false);
	setVisible(robuxBuy, false);

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

	// the Survivor screen's OUTFIT / PET tile asked for its slot's page
	if (handlers.slot !== undefined) {
		for (let i = 0; i < pages.size(); i++) if (pages[i].slot === handlers.slot) tab = i;
	}

	// ---- MON-05: the Titles page -- ROWS in a scrolling groove, "[None]" first, then every title by rarity from common
	// up (shared/data/titles.ts `titlesInOrder`): the list reads as a ladder, and the colours come in bands
	titlesTab = pages.size();
	const ordered = titlesInOrder();
	const rowCount = ordered.size() + 1;
	// the section fills the column down to the caption; the groove scrolls (the kit's list: a pad scrolls to its focus)
	const titleSectionH = bodyH - 44 - space(3);
	const titleGrooveH = titleSectionH - Kit.sectionHeight(0);
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
	const titleList = Kit.SettingsList(titleSec.frame, "Groove", INSET, Kit.SECTION_CONTENT_Y, GROOVE_W, titleGrooveH);
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
	const rowW = titleList.designW;
	for (let j = 0; j < rowCount; j++) {
		const id = j === 0 ? -1 : ordered[j - 1].id;
		const row = Kit.ListRow(titleList.frame, `Row${j}`, {
			x: 0,
			y: 0,
			w: rowW,
			h: TITLE_ROW_H,
			zIndex: titleList.frame.ZIndex + 1,
			onClick: (): void => {
				titleSel = j;
				refresh();
			},
		});
		// a row of the scrolling list: the kit's layout places it, in the ladder's order, at its design height
		row.button.LayoutOrder = j;
		sizeRow(titleList, row.button, TITLE_ROW_H);
		const z = row.content.ZIndex + 1;
		const def = id >= 0 ? TITLES[id] : undefined;
		// line 1: the title in brackets, in its rarity's colour, and the rarity's word at the right (the colour is never
		// the only cue); line 2: how it is earned. A locked secret shows "[???]" and says only that it is a secret
		const secret = id >= 0 && hiddenSecret(ctx, id);
		const tone = def === undefined ? THEME.foreground : titleColor(id);
		const nameText = def === undefined ? `[${tr("None")}]` : secret ? `[${SECRET_NAME}]` : titleText(id, lang);
		const name = makeLabel(
			row.content,
			"Name",
			nameText,
			textX,
			7,
			rowW - textX - RARITY_W - space(4),
			24,
			TEXT.lg,
			tone,
			{
				font: BOLD,
				align: "left",
				zIndex: z,
			},
		);
		if (def !== undefined) {
			makeLabel(
				row.content,
				"Rarity",
				tr(rarityName(def.rarity)),
				rowW - space(3) - RARITY_W,
				7,
				RARITY_W,
				24,
				TEXT.sm,
				rarityColor(def.rarity),
				{ font: BOLD, align: "right", zIndex: z },
			);
		}
		const howText = tr(def === undefined ? "Unequip title" : secret ? SECRET_HOWTO : def.howTo);
		const howTo = makeLabel(
			row.content,
			"HowTo",
			howText,
			textX,
			31,
			rowW - textX - space(3) - 80,
			20,
			TEXT.sm,
			THEME.mutedForeground,
			{
				align: "left",
				zIndex: z,
			},
		);
		// a long how-to ends in "..." on the row; the details panel says it in full
		for (const l of [name, howTo]) {
			l.TextWrapped = false;
			l.TextTruncate = Enum.TextTruncate.AtEnd;
		}
		const worn = Keycap(row.content, "Worn", tr("EQUIPPED"), {
			x: rowW - space(3),
			cy: 41,
			anchorX: 1,
			h: WORN_KEY_H,
			minW: 72,
			textSize: TEXT.xs,
			font: BOLD,
			zIndex: z,
		});
		titleRows.push({ id, row, worn, name, howTo, revealed: !secret });
	}

	// the title shown under your name opens selected (its row, in the ladder's order)
	titleSel = 0;
	for (let j = 0; j < titleRows.size(); j++) if (titleRows[j].id === shownTitle(ctx)) titleSel = j;

	/** the Titles page and, while it is the tab, the details column: a repaint of what exists, never a rebuild */
	const refreshTitles = (): void => {
		const save = ctx.save;
		const shown = shownTitle(ctx);
		let earned = 0;
		for (let j = 0; j < titleRows.size(); j++) {
			const r = titleRows[j];
			const owned = r.id < 0 || ownsTitle(save, r.id);
			if (r.id >= 0 && owned) earned++;
			// a secret the server just granted shows its real name and how-to, once (a rewrite, never a rebuild)
			if (!r.revealed && owned) {
				r.revealed = true;
				r.name.Text = titleText(r.id, lang);
				r.howTo.Text = tr(TITLES[r.id].howTo);
			}
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
		const secret = id >= 0 && hiddenSecret(ctx, id);
		let heading = tr("None");
		if (id >= 0) heading = secret ? tr("Secret title") : tr(TITLES[id].name);
		if (details.title !== undefined) details.title.Text = heading;
		// the key on the title line says how rare it is ("RARE"; the colour is the row's, the word is here too)
		Kit.setValueKey(slotKey, tr(id < 0 ? "TITLE" : rarityKeyName(TITLES[id].rarity)));
		statusRow.label.Text = tr("Status");
		Kit.setValueKey(statusKey, tr(!owned ? "Locked" : worn ? "Equipped" : "Owned"));
		if (id < 0) {
			note.Text = tr("No title under your name.");
		} else if (secret) {
			note.Text = tr(SECRET_HOWTO);
		} else if (!owned) {
			// the requirement and how far the server counted you (MON-05): "Zombies put down: 37 / 100"; a title earned
			// in one go ("none": a night, a vault) has only its sentence
			const def = TITLES[id];
			if (def.track === "none") {
				note.Text = tr(def.howTo);
			} else {
				const progress = `${tr(def.progressLabel)}: ${fmtInt(titleProgress(ctx, id))} / ${fmtInt(def.goal)}`;
				note.Text = `${tr(def.howTo)} ${progress}`;
			}
		} else {
			note.Text = tr("Earned by playing, never sold. Everyone sees it under your name.");
		}
		setVisible(action, true);
		setVisible(packAction, false);
		setVisible(keep, false);
		setVisible(coinBuy, false);
		setVisible(robuxBuy, false);
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
		// try it on: your survivor as you look now, with the selected title under your name (a locked secret keeps its
		// name to itself here too)
		previewTitle = secret ? 0 : titleToWire(id);
		titleBody.setOutfit(outfitLookOf(save));
		titleBody.draw(0);
		placePlate();
	};

	refresh = (): void => {
		if (root.Parent === undefined) return;
		coins.refresh();
		const save = ctx.save;
		const onTitles = tab === titlesTab;
		// MON-07: the Supporter tab (only with a subscription configured) has the whole body: no details column
		const onSupporter = supporter !== undefined && tab === supporterTab;
		if (supporter !== undefined) {
			setVisible(supporter.frame, onSupporter);
			if (onSupporter) supporter.refresh();
		}
		setVisible(details.frame, !onSupporter);
		setVisible(titleFrame, onTitles);
		setVisible(previewBox, !onTitles);
		setVisible(titleBox, onTitles);
		refreshTitles();
		if (onSupporter) {
			for (const page of pages) setVisible(page.frame, false);
			return;
		}
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
		// a Robux payment of theirs for it may be on its way (the server's pz_robux_pending): nothing is sold for it --
		// coins or a second prompt -- until it lands (server/save/robux.ts holds)
		const pending = !ownsCostume(save, c.id) && robuxPending().has(c.id);
		// the server offers it for Robux (its check with Roblox), for a locked costume only (never for what is yours)
		const dual = locked && !pending && robuxOffer().has(c.id);
		// ...and the number is what THIS player pays (Roblox Plus, regional pricing), asked of Roblox: none while unknown
		if (dual) askRobuxPrice(c.id);
		const robuxPrice = dual ? robuxPriceShown(c.id) : undefined;
		statusRow.label.Text = tr(locked && !pending ? "Price" : "Status");
		let status = tr("Owned");
		if (locked) status = `${fmtInt(c.price)} ${tr("coins")}`;
		if (pending) status = tr("Pending");
		else if (robuxPrice !== undefined) status = `${status}  ·  ${fmtInt(robuxPrice)} ${tr("Robux")}`;
		else if (state === "equipped") status = tr("Equipped");
		else if (fromPack) status = tr("From a pack");
		Kit.setValueKey(statusKey, status);
		if (pending && robuxRejoin().has(c.id)) {
			// Roblox asks about this receipt again only at the next join (the load failed, or the save could not be written)
			note.Text = tr("Your Robux purchase is safe with Roblox. Rejoin to receive it.");
		} else if (pending) {
			note.Text = tr("Your Robux purchase is on its way. It shows here as soon as Roblox confirms it.");
		} else if (locked && !affordable) {
			const have = `${tr("You have")} ${fmtInt(save.money)}`;
			note.Text = `${tr("Not enough coins")}. ${have}. ${tr("Coins are earned by playing")}.`;
		} else if (fromPack) {
			note.Text = tr("Came in a pack: it stays for this life. Buy it to keep it for good.");
		} else {
			note.Text = tr(slotNote(page.slot));
		}
		// can't afford it: the button says how many coins are missing and is disabled, as on the shop's cards (MON-06)
		const buyText = affordable
			? `${tr("Buy for")} ${fmtInt(c.price)} ${tr("coins")}`
			: `${fmtInt(c.price - save.money)} ${tr("more needed")}`;
		if (locked && pending) {
			// the quiet iron, disabled: nothing to buy until the payment on its way lands
			action.Text = tr("Pending");
			setButtonVariant(action, "secondary");
			setButtonEnabled(action, false);
		} else if (locked) {
			action.Text = buyText;
			setButtonVariant(action, "default");
			setButtonEnabled(action, affordable);
		} else if (state === "equipped") {
			action.Text = tr("Unequip");
			setButtonVariant(action, "secondary");
		} else {
			action.Text = tr("Equip");
			setButtonVariant(action, "default");
		}
		setVisible(action, !fromPack && !dual);
		setVisible(packAction, fromPack);
		setVisible(keep, fromPack);
		setVisible(coinBuy, dual);
		setVisible(robuxBuy, dual);
		if (dual) {
			// without the coins the coin Buy says how many are missing, disabled -- and the pad stays on the grid: it is
			// never sent to the Robux button instead (BEM-02)
			coinBuy.Text = buyText;
			setButtonVariant(coinBuy, "default");
			setButtonEnabled(coinBuy, affordable && !busy);
			setButtonEnabled(robuxBuy, !busy);
		}
		if (fromPack) {
			packAction.Text = action.Text;
			setButtonVariant(packAction, state === "equipped" ? "secondary" : "default");
			keep.Text = pending ? tr("Pending") : buyText;
			setButtonVariant(keep, pending ? "secondary" : "default");
			setButtonEnabled(keep, affordable && !pending);
		}
		// try it on: your current look with the selected item swapped in
		preview.setOutfit(page.slot === EquipSlot.Outfit ? outfitLookOfEquip(c.equipId) : outfitLookOf(save));
		preview.setPet(page.slot === EquipSlot.Pet ? petLookOfEquip(c.equipId) : petLookOf(save));
	};

	// ---- MON-07: the Supporter tab, after the titles and apart from them -- only when the subscription exists
	if (supporterOnOffer()) {
		supporterTab = titlesTab + 1;
		supporter = mountSupporterPage(ctx, panel, PAD, bodyY, WIN_W - PAD * 2, bodyH);
	}

	// ---- the tab bar: only the pages that exist, the titles, and the Supporter tab when there is one
	const names = pages.map(p => tr(p.key));
	names.push(tr("Titles"));
	if (supporter !== undefined) names.push(tr("Supporter"));
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
			if (supporter !== undefined && i === supporterTab) {
				autoFocus(supporter.action);
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
		if (tab !== titlesTab && tab !== supporterTab) preview.draw(os.clock() - t0);
	});
	const unsubscribe = onWalletChanged(() => {
		if (busy) {
			coins.refresh();
			return;
		}
		// a costume the Robux receipt granted (the pushed wallet) says so, then shows as yours
		noteUnlocks();
		refresh();
	});
	// the server's price check publishes the Robux offer at boot: a window opened before it repaints when it comes
	const unsubscribeOffer = onRobuxOfferChanged(() => refresh());
	// ...and so do a payment on its way (Pending) and this player's own Robux price, when Roblox answers
	const unsubscribePending = onRobuxPendingChanged(() => {
		if (!busy) refresh();
	});
	const unsubscribePrice = onRobuxPrice(() => {
		if (!busy) refresh();
	});

	return (): void => {
		unsubscribe();
		unsubscribeOffer();
		unsubscribePending();
		unsubscribePrice();
		conn.Disconnect();
		for (const icon of icons) icon.destroy();
		preview.destroy();
		titleBody.destroy();
		titlePlate.destroy();
		supporter?.destroy();
		root.Destroy();
	};
}
