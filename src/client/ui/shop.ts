import { GameContext } from "shared/game/context";
import { ownsEquip, pendingPacks } from "shared/game/save";
import { ECONOMY, SHOP_PACKS, ShopPack } from "shared/data/shop";
import { ItemKind } from "shared/data/kinds";
import { petLookOfEquip } from "shared/data/cosmetics";
import { DESIGN } from "shared/engine/constants";
import { langGet } from "shared/data/lang";
import { ShopActionReason, ShopActionRequest } from "shared/net/net";
import { invokeShopAction, onWalletChanged, sessionReady } from "../systems/saveClient";
import { SurvivorPreview, packPetPicture } from "../view/cosmeticPreview";
import { inputDevice } from "./device";
import { drawingBox } from "./drawingBox";
import { IconView, drawIcon, drawItemIcon } from "./itemIcon";
import { nameOf } from "./itemInfo";
import { paintPlate } from "./plate";
import { PixelIcon } from "./pixelIcon";
import { popup, toast } from "./popup";
import { GAME, SURFACE, TEXT, THEME, fontOf, space } from "./theme";
import {
	Badge,
	Button,
	Card,
	CoinIcon,
	Keycap,
	Tabs,
	autoFocus,
	buttonForeground,
	centredRect,
	fmtInt,
	makeCoinPill,
	makeFrame,
	makeLabel,
	makeScreen,
	nl,
	setBadge,
	setButtonEnabled,
	setVisible,
	tabWidth,
	unlinkCell,
} from "./widgets";
import * as Kit from "./window";

/*
 * The Shop (docs/DESIGN_RULES.md MON-03, MON-06, UI-07, UI-11): a UI-07 window like Settings, the Wardrobe and the
 * Survivor screen -- the header with the big title, the "?" at its left and the red X at its right (B / Backspace =
 * the X, back where the shop was opened from) -- with two tabs, the coins and the door to the Wardrobe on one line.
 *
 *   ┌ ? ──────────────────────────────── Shop ─────────────────────────────────── X ┐
 *   │ [Packs] [Earn coins]                           [👕 Wardrobe]  (● 20)          │
 *   │ [bag] Fixed contents, shown in full. A pack goes into your backpack when you   │
 *   │       enter the city.                                                          │
 *   │ ┌ First Night Kit ─────┐ ┌ Pantry Crate ──────────┐ ┌ Medic Bag ───────────┐ │
 *   │ │ [ic][ic][ic] Cotton… │ │ [ic][ic][ic] Cooked…   │ │ [ic][ic][ic] First…  │ │
 *   │ │ ● 20         [ Buy ] │ │ ● 20          [ Buy ]  │ │ ● 30 [10 more needed]│ │
 *   │ └──────────────────────┘ └────────────────────────┘ └──────────────────────┘ │  3 x 3
 *   └───────────────────────────────────────────────────────────────────────────────┘
 *
 * - A pack card: its name (and "Pending ×N" when bought packs wait for the next entry into the city), what is inside
 *   as the Bag's own item icons (UI-11) on tiles with the count on each, the names beside them in the same order, and
 *   the price with Buy on one line. A pet pack shows the pet itself, drawn by the wardrobe's SurvivorPreview (a bird
 *   in flight, wings spread: landed and seen from above, a pigeon is a grey oval), and says the truth about it: it
 *   stays until a New game (MON-04; the Wardrobe sells the one that stays). Already owned for good: "Owned".
 * - Can't afford it: Buy is disabled and says how much is missing ("10 more needed"), on every card alike. It used to
 *   turn into a hollow outline -- a style of its own that read as focus or as another kind of button.
 * - No "popular" or "best value" tag: nothing in the data says which pack is either, and a tag that invents urgency is
 *   what MON-03 forbids. The contents are fixed and declared (MON-03) -- the note line says so, and where they go.
 * - Earn coins: the four real sources (shared/data/shop.ts ECONOMY; paid by the server, server/sim/progress.ts), each
 *   with its picture, its coin chip ("+3") and how far you are from the next one -- this life's day, the next record
 *   day and the days left to it, the bosses defeated, the welcome gift received. Nothing that is not paid.
 * - The coin is the pixel coin (MON-06), never a "$".
 * - Both pages are built when the shop opens and switch by visibility; the wallet and a purchase rewrite them in place:
 *   no Instance is created after the shop opens (UI-09's rule; test:nav, test:screens).
 */

/** player-facing text for a refused shop/rebirth request */
export function actionErrorText(reason: ShopActionReason | undefined, langType: number): string {
	const tr = (k: string): string => langGet(k, langType);
	if (reason === "funds") return tr("Not enough coins");
	if (reason === "owned") return tr("Already owned");
	if (reason === "limit") return tr("Too many packs waiting");
	if (reason === "rate") return tr("Please wait a moment");
	if (reason === "loading") return tr("Still loading your progress");
	if (reason === "readonly") return tr("Progress not loaded");
	// "outdated" = the request named a run the session has already moved past. client/main.client.ts retries
	// it once with the corrected runRev, so reaching this text means the two really do disagree -- say that,
	// instead of "Please try again", which told a player to repeat the click that had just failed.
	if (reason === "outdated") return tr("Your progress changed, try again");
	return tr("Connection problem, try again");
}

/**
 * A refused purchase in words; a refusal for coins says how many are missing, as the Rebirth does ("Not enough coins:
 * 10 more needed"). `short` is the price less the coins this client knows of (the server's answer may be newer).
 */
export function fundsErrorText(reason: ShopActionReason | undefined, short: number, langType: number): string {
	if (reason === "funds" && short > 0) {
		return `${langGet("Not enough coins", langType)}: ${fmtInt(short)} ${langGet("more needed", langType)}`;
	}
	return actionErrorText(reason, langType);
}

/** the two pages; the Wardrobe is a door beside them (client/ui/wardrobe.ts, MON-04), not a page of this window */
const TAB_KEYS = ["Packs", "Earn coins"];
export const SHOP_TAB_PACKS = 0;
export const SHOP_TAB_EARN = 1;

// ---------------------------------------------------------------- layout (1120 x 630 design units)

const WIN_W = 1060;
const WIN_H = 620;
export const SHOP_WINDOW = centredRect(WIN_W, WIN_H);
const PAD = space(6);
const INNER_W = WIN_W - PAD * 2;
const TAB_H = 36;
const COIN_W = 176;
const COIN_H = 40;
const DOOR_W = 158;
/** the pages start under the tab line */
const BODY_GAP = space(3);
const BOTTOM = space(4);

/** the note line over the cards */
const NOTE_H = 30;
/** 3 x 3 cards */
const COLS = 3;
const ROWS = 3;
const GAP = 10;
const CARD_PAD = space(3);
/** a card: name line, contents line (tiles + their names), price + Buy line */
const TITLE_Y = 9;
const TITLE_H = 24;
const TILES_Y = 40;
const TILE = 50;
const TILE_GAP = 6;
const ICON_INSET = 5;
const COUNT_H = 16;
const FOOT_H = 30;
const BUY_W = 136;
const COIN_ICON = 22;
const PENDING_W = 108;
const PENDING_H = 22;
/**
 * A pet pack's picture: the pet alone, drawn as the wardrobe's tile draws it, in a bed as tall as the contents and the
 * price lines together (a pet is small in the world; a 50-unit bed would draw it at half the wardrobe's size)
 */
const PET_W = 96;

/** Earn coins: one row per source */
const EARN_ROW_H = 92;
const EARN_GAP = space(2);
const EARN_SOCKET = 60;
const EARN_ICON = 48;
const EARN_TEXT_X = 16 + EARN_SOCKET + space(4);
const CHIP_W = 124;
const CHIP_H = 48;
const EARN_METER_W = 240;
const EARN_METER_H = 24;

/** the smallest side a thumb's target may have (shared/engine/input.ts MIN_TOUCH_PX) */
const MIN_TOUCH = 44;

const BOLD = fontOf("sans", Enum.FontWeight.Bold);

/** what the "?" of the window says ("#" = new line) */
const HELP_TEXT = [
	"Every pack has fixed contents, shown in full on its card: what you see is what you get.",
	"Packs go into your backpack the next time you enter the city.",
	"A pet from a pack stays until a New game. The Wardrobe sells outfits and pets you keep for good.",
	"Coins are earned by playing: the Earn coins tab shows how, and how far you are from the next ones.",
].join("#");

/** the first boss of a town wakes on this world day (shared/game/world.ts bossAnchors: the earliest of the four) */
const FIRST_BOSS_DAY = math.min(DESIGN.BOSS1_DAY, DESIGN.BOSS2_DAY, DESIGN.BOSS3_DAY, DESIGN.BOSS4_DAY);

/**
 * An invisible hit area over `host` on a touch screen, at least MIN_TOUCH px a side (the button stays the size it is
 * drawn; the thumb gets the room). Its tap is the button's click.
 */
function touchHit(host: TextButton, onClick: () => void): TextButton {
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
	const min = new Instance("UISizeConstraint");
	min.MinSize = new Vector2(MIN_TOUCH, MIN_TOUCH);
	min.Parent = hit;
	hit.Activated.Connect(() => {
		if (host.GetAttribute("Disabled") !== true) onClick();
	});
	hit.Parent = host;
	return hit;
}

/**
 * The pad through cards whose button may be disabled (a pack you cannot afford): `cells` in reading order, `cols` to a
 * row, `stop[i]` false for a cell that is no stop (its links are cleared). Left / right walk the row to the nearest stop,
 * up / down go to the nearest row that has one, to its stop closest in column; the outer edges stay the engine's (the
 * tabs above), like widgets.ts linkGrid. Writes only what changed.
 */
export function linkSparseGrid(cells: ReadonlyArray<GuiObject>, stop: ReadonlyArray<boolean>, cols: number): void {
	const n = cells.size();
	const rows = math.ceil(n / cols);
	const at = (r: number, c: number): GuiObject | undefined => {
		const i = r * cols + c;
		return i < n && stop[i] === true ? cells[i] : undefined;
	};
	const nearestIn = (r: number, c: number): GuiObject | undefined => {
		let best: GuiObject | undefined;
		let bestD = math.huge;
		for (let k = 0; k < cols; k++) {
			const cell = at(r, k);
			if (cell === undefined) continue;
			const d = math.abs(k - c);
			if (d < bestD) {
				best = cell;
				bestD = d;
			}
		}
		return best;
	};
	for (let i = 0; i < n; i++) {
		const cell = cells[i];
		if (stop[i] !== true) {
			unlinkCell(cell);
			continue;
		}
		const r = math.floor(i / cols);
		const c = i % cols;
		let left: GuiObject | undefined;
		for (let k = c - 1; k >= 0 && left === undefined; k--) left = at(r, k);
		let right: GuiObject | undefined;
		for (let k = c + 1; k < cols && right === undefined; k++) right = at(r, k);
		let up: GuiObject | undefined;
		for (let rr = r - 1; rr >= 0 && up === undefined; rr--) up = nearestIn(rr, c);
		let down: GuiObject | undefined;
		for (let rr = r + 1; rr < rows && down === undefined; rr++) down = nearestIn(rr, c);
		if (cell.NextSelectionLeft !== left) cell.NextSelectionLeft = left;
		if (cell.NextSelectionRight !== right) cell.NextSelectionRight = right;
		if (cell.NextSelectionUp !== up) cell.NextSelectionUp = up;
		if (cell.NextSelectionDown !== down) cell.NextSelectionDown = down;
	}
}

interface PackCard {
	pack: ShopPack;
	frame: Frame;
	buy: TextButton;
	pending: Frame;
	/** the pet a pet pack delivers (EQUIPS id), -1 for any other pack */
	pet: number;
	title: TextLabel;
}

interface EarnRow {
	/** rewrites the row's progress line from the save */
	refresh: () => void;
}

export function showShop(ctx: GameContext, onBack: () => void, onWardrobe: () => void): () => void {
	const lang = ctx.save.settings.langType;
	const tr = (k: string): string => langGet(k, lang);
	const save = ctx.save;
	const touch = inputDevice() === "touch";
	// a menu screen: see-through, over the town flyover behind the menus (UI-10), its window centred on the screen
	const { root, body } = makeScreen(ctx.uiLayer, "Shop", { transparency: 1, content: SHOP_WINDOW });
	// the Shop funnel's first step (docs/ANALYTICS.md): fired and forgotten, once per visit (this screen opening; a
	// tab switch is not a visit) -- the answer carries nothing, the screen never waits on it, and the server decides
	// what it is worth (server/analytics/events.ts `shopViewed`)
	task.spawn(() => invokeShopAction({ kind: "viewShop", screen: 0 }));
	const win = Kit.Window(body, "Window", {
		...SHOP_WINDOW,
		title: tr("Shop"),
		onClose: (): void => onBack(),
		onHelp: (): void => {
			popup(ctx, tr("Shop"), nl(tr(HELP_TEXT)), [{ text: tr("Close"), variant: "secondary" }]);
		},
	});
	const panel = win.frame;
	const tabsY = win.contentY + space(1);
	const bodyY = tabsY + TAB_H + BODY_GAP;
	const bodyH = WIN_H - bodyY - BOTTOM;

	let tab = SHOP_TAB_PACKS;
	let busy = false;
	const cards: Array<PackCard> = [];
	const earnRows: Array<EarnRow> = [];
	const previews: Array<SurvivorPreview> = [];

	// ---- the tab line: the pages, the door to the Wardrobe, the coins
	const coins = makeCoinPill(
		panel,
		"Coins",
		WIN_W - PAD - COIN_W,
		tabsY + (TAB_H - COIN_H) / 2,
		COIN_W,
		COIN_H,
		() => save.money,
	);
	const door = Button(panel, "Wardrobe", "", {
		x: WIN_W - PAD - COIN_W - space(3) - DOOR_W,
		y: tabsY,
		w: DOOR_W,
		h: TAB_H,
		variant: "secondary",
		onClick: (): void => onWardrobe(),
	});
	{
		const fg = buttonForeground("secondary");
		PixelIcon(door, "Icon", "wardrobe", 22, TAB_H / 2, 18, fg, door.ZIndex + 1);
		makeLabel(door, "Title", tr("Wardrobe"), 40, 0, DOOR_W - 52, TAB_H, TEXT.lg, fg, {
			font: BOLD,
			align: "left",
			zIndex: door.ZIndex + 1,
		});
	}

	const packsPage = makeFrame(panel, "Packs", PAD, bodyY, INNER_W, bodyH, THEME.background, { transparency: 1 });
	const earnPage = makeFrame(panel, "Earn", PAD, bodyY, INNER_W, bodyH, THEME.background, { transparency: 1 });

	// ---- buying: the request is the pack id and nothing else; coins, delivery and the answer are the server's
	let refresh = (): void => {};
	const buy = (request: ShopActionRequest, name: string, price: number, btn: TextButton): void => {
		if (busy || btn.GetAttribute("Disabled") === true) return;
		if (!sessionReady()) {
			toast(ctx, tr("Still loading your progress"), "error");
			return;
		}
		busy = true;
		setButtonEnabled(btn, false);
		const res = invokeShopAction(request);
		busy = false;
		if (root.Parent === undefined) return; // closed while the server answered
		if (res.ok) toast(ctx, `${tr("Purchased")}: ${name}`, "success");
		else toast(ctx, fundsErrorText(res.reason, price - save.money, lang), "error");
		refresh();
	};

	// ---- Packs: the note line, then the 3 x 3 cards
	{
		const note = makeFrame(packsPage, "Note", 0, 0, INNER_W, NOTE_H, THEME.background, { transparency: 1 });
		paintPlate(note, SURFACE.section, "flat", 3);
		PixelIcon(note, "Icon", "shop", 22, NOTE_H / 2, 18, THEME.foreground, note.ZIndex + 1);
		makeLabel(
			note,
			"Text",
			tr("Fixed contents, shown in full. A pack goes into your backpack when you enter the city."),
			42,
			0,
			INNER_W - 54,
			NOTE_H,
			TEXT.base,
			THEME.foreground,
			{ align: "left", zIndex: note.ZIndex + 1 },
		);
	}
	const gridY = NOTE_H + GAP;
	const cardW = (INNER_W - GAP * (COLS - 1)) / COLS;
	const cardH = (bodyH - gridY - GAP * (ROWS - 1)) / ROWS;
	const content = makeFrame(packsPage, "Content", 0, gridY, INNER_W, bodyH - gridY, THEME.background, {
		transparency: 1,
	});
	const footY = cardH - CARD_PAD - FOOT_H;
	for (let i = 0; i < SHOP_PACKS.size(); i++) {
		const pack = SHOP_PACKS[i];
		const x = (i % COLS) * (cardW + GAP);
		const y = math.floor(i / COLS) * (cardH + GAP);
		const card = Card(content, `Pack${pack.id}`, { x, y, w: cardW, h: cardH, pad: CARD_PAD, fill: SURFACE.window });
		const z = card.ZIndex + 2;
		const name = tr(pack.name);
		const title = makeLabel(
			card,
			"Title",
			name,
			CARD_PAD + 2,
			TITLE_Y,
			cardW - CARD_PAD * 2,
			TITLE_H,
			TEXT.lg,
			THEME.foreground,
			{
				font: BOLD,
				align: "left",
				zIndex: z,
			},
		);
		// packs bought and not opened yet: they go into the backpack at the next entry into the city
		const pending = Badge(card, "Pending", "", {
			x: cardW - CARD_PAD - PENDING_W,
			y: TITLE_Y + (TITLE_H - PENDING_H) / 2,
			w: PENDING_W,
			h: PENDING_H,
			color: GAME.info,
			zIndex: z,
		});
		setVisible(pending, false);
		// what is inside: the Bag's icons on tiles with the count, their names beside them in the same order
		let petEquip = -1;
		for (const it of pack.items) {
			if (it.kind === ItemKind.Equip && petLookOfEquip(it.index) !== 0) petEquip = it.index;
		}
		const namesX = CARD_PAD + (petEquip >= 0 ? PET_W : pack.items.size() * (TILE + TILE_GAP) - TILE_GAP) + space(2);
		const lines: Array<string> = [];
		// where the price starts: at the card's left edge, or right of a pet's picture
		let priceX = CARD_PAD;
		if (petEquip >= 0) {
			// a pet pack: the pet itself, drawn as the wardrobe draws it, in a bed down to the price line, and what it
			// is -- it stays until a New game (MON-04: the Wardrobe sells the one that stays)
			const bedH = footY + FOOT_H - TILES_Y;
			const bed = makeFrame(card, "PetBed", CARD_PAD, TILES_Y, PET_W, bedH, THEME.background, {
				transparency: 1,
				zIndex: z,
			});
			paintPlate(bed, SURFACE.groove, "flat", 2);
			const box = drawingBox(bed, "Pet", 3, 3, PET_W - 6, bedH - 6, z + 1);
			const look = petLookOfEquip(petEquip);
			const picture = packPetPicture(look);
			const pet = new SurvivorPreview(box, {
				w: PET_W - 6,
				h: bedH - 6,
				subject: "pet",
				scene: picture.scene,
				petInFlight: picture.inFlight,
				zIndex: box.ZIndex,
			});
			pet.setPet(look);
			pet.draw(0);
			previews.push(pet);
			lines.push(tr(nameOf(ItemKind.Equip, petEquip)));
			lines.push(tr("Stays until a New game"));
			priceX = namesX;
		} else {
			for (let k = 0; k < pack.items.size(); k++) {
				const it = pack.items[k];
				const tile = makeFrame(
					card,
					`Item${k}`,
					CARD_PAD + k * (TILE + TILE_GAP),
					TILES_Y,
					TILE,
					TILE,
					THEME.background,
					{
						transparency: 1,
						zIndex: z,
					},
				);
				paintPlate(tile, SURFACE.section, "flat", 3);
				const icon = IconView(tile, "Icon", ICON_INSET, ICON_INSET, TILE - ICON_INSET * 2, z + 1, 0, "drawn");
				drawItemIcon(icon, it.kind, it.index);
				Keycap(tile, "Count", `×${it.count}`, {
					x: TILE + 3,
					cy: TILE - COUNT_H / 2 + 3,
					anchorX: 1,
					h: COUNT_H,
					minW: 20,
					textSize: TEXT.xs,
					font: BOLD,
					zIndex: z + 3,
				});
				lines.push(tr(nameOf(it.kind, it.index)));
			}
		}
		const names = makeLabel(
			card,
			"Contents",
			lines.join("\n"),
			namesX,
			TILES_Y - 2,
			cardW - namesX - CARD_PAD,
			TILE + 4,
			TEXT.sm,
			THEME.mutedForeground,
			{ align: "left", zIndex: z },
		);
		names.LineHeight = 1.05;
		// the price and Buy, on one line
		CoinIcon(card, "Coin", priceX, footY + (FOOT_H - COIN_ICON) / 2, COIN_ICON, z);
		makeLabel(
			card,
			"Price",
			fmtInt(pack.price),
			priceX + COIN_ICON + space(2),
			footY,
			80,
			FOOT_H,
			TEXT.xl,
			THEME.foreground,
			{
				font: "numeric",
				align: "left",
				zIndex: z,
			},
		);
		const btn: TextButton = Button(card, "Buy", tr("Buy"), {
			x: cardW - CARD_PAD - BUY_W,
			y: footY,
			w: BUY_W,
			h: FOOT_H,
			textSize: TEXT.base,
			zIndex: z,
			onClick: (): void => buy({ kind: "buyPack", packId: pack.id }, name, pack.price, btn),
		});
		if (touch) touchHit(btn, () => buy({ kind: "buyPack", packId: pack.id }, name, pack.price, btn));
		cards.push({ pack, frame: card, buy: btn, pending, pet: petEquip, title });
	}

	// ---- Earn coins: every real source, what it pays and how far you are from the next one
	{
		const sources = 4;
		const grooveH = sources * EARN_ROW_H + (sources - 1) * EARN_GAP + space(4);
		const sec = Kit.Section(earnPage, "Sources", {
			x: 0,
			y: 0,
			w: INNER_W,
			h: Kit.sectionHeight(grooveH),
			title: tr("Coins are earned by playing"),
		});
		const groove = Kit.Groove(sec.frame, "Groove", space(4), Kit.SECTION_CONTENT_Y, INNER_W - space(8), grooveH);
		const rowW = INNER_W - space(8) - space(4);
		const row = (
			i: number,
			icon: string,
			label: string,
			how: string,
			amount: number,
			progress: (holder: Frame, z: number) => () => void,
		): void => {
			const r = makeFrame(
				groove,
				`Earn${i}`,
				space(2),
				space(2) + i * (EARN_ROW_H + EARN_GAP),
				rowW,
				EARN_ROW_H,
				THEME.background,
				{
					transparency: 1,
					zIndex: groove.ZIndex + 1,
				},
			);
			paintPlate(r, SURFACE.row, "outline", 3, SURFACE.line);
			const z = r.ZIndex + 2;
			const socket = makeFrame(
				r,
				"Socket",
				16,
				(EARN_ROW_H - EARN_SOCKET) / 2,
				EARN_SOCKET,
				EARN_SOCKET,
				THEME.background,
				{
					transparency: 1,
					zIndex: z,
				},
			);
			paintPlate(socket, SURFACE.groove, "flat", 2);
			const view = IconView(
				socket,
				"Icon",
				(EARN_SOCKET - EARN_ICON) / 2,
				(EARN_SOCKET - EARN_ICON) / 2,
				EARN_ICON,
				z + 1,
				0,
				"drawn",
			);
			drawIcon(view, icon);
			const textW = rowW - EARN_TEXT_X - CHIP_W - space(8);
			makeLabel(r, "Label", label, EARN_TEXT_X, 10, textW, 24, TEXT.lg, THEME.foreground, {
				font: BOLD,
				align: "left",
				zIndex: z,
			});
			makeLabel(r, "How", how, EARN_TEXT_X, 36, textW, 18, TEXT.sm, THEME.mutedForeground, {
				align: "left",
				zIndex: z,
			});
			const line = makeFrame(r, "Progress", EARN_TEXT_X, 58, textW, EARN_METER_H, THEME.background, {
				transparency: 1,
				zIndex: z,
			});
			// the coin chip: what one of these pays, sunk in a dark well like the Bag's counts (information, never a button)
			const chip = makeFrame(
				r,
				"Chip",
				rowW - space(4) - CHIP_W,
				(EARN_ROW_H - CHIP_H) / 2,
				CHIP_W,
				CHIP_H,
				THEME.background,
				{
					transparency: 1,
					zIndex: z,
				},
			);
			paintPlate(chip, SURFACE.well, "flat", 3);
			CoinIcon(chip, "Coin", 14, (CHIP_H - 26) / 2, 26, z + 2);
			makeLabel(chip, "Amount", `+${fmtInt(amount)}`, 48, 0, CHIP_W - 58, CHIP_H, TEXT.xl2, THEME.foreground, {
				font: BOLD,
				align: "left",
				zIndex: z + 2,
			});
			earnRows.push({ refresh: progress(line, z + 1) });
		};
		/** a progress line of text (the whole line), rewritten in place */
		const textLine = (holder: Frame, z: number, text: () => string): (() => void) => {
			const l = makeLabel(holder, "Text", "", 0, 0, EARN_METER_W * 2, EARN_METER_H, TEXT.base, THEME.foreground, {
				align: "left",
				zIndex: z,
			});
			return () => {
				const t = text();
				if (l.Text !== t) l.Text = t;
			};
		};
		row(
			0,
			"badge_sunrise",
			tr("Day survived"),
			tr("Paid at every midnight your survivor lives through."),
			ECONOMY.COINS_PER_DAY,
			(h, z) =>
				textLine(
					h,
					z,
					() => `${tr("This life")}: ${tr("Day")} ${save.day}   ·   ${tr("Next pay at midnight")}`,
				),
		);
		row(
			1,
			"badge_trophy",
			tr("Record day (every 5 days)"),
			tr("Paid the first time a life reaches a new best day that is a multiple of 5."),
			ECONOMY.MILESTONE_BONUS,
			(h, z) => {
				const meter = Kit.Meter(h, "Meter", {
					x: 0,
					y: 0,
					w: EARN_METER_W,
					h: EARN_METER_H,
					face: THEME.primary,
					zIndex: z,
				});
				const after = makeLabel(
					h,
					"Left",
					"",
					EARN_METER_W + space(3),
					0,
					EARN_METER_W,
					EARN_METER_H,
					TEXT.base,
					THEME.foreground,
					{
						align: "left",
						zIndex: z,
					},
				);
				return () => {
					const every = ECONOMY.MILESTONE_EVERY;
					// the next multiple of 5 past the best day: the one that pays; this life has to get there
					const goal = (math.floor(save.bestDay / every) + 1) * every;
					meter.set(save.day / goal, `${tr("Day")} ${save.day} / ${goal}`);
					const left = math.max(goal - save.day, 0);
					const t = `${left} ${left === 1 ? tr("day to go") : tr("days to go")}`;
					if (after.Text !== t) after.Text = t;
				};
			},
		);
		row(
			2,
			"skill_skull",
			tr("Boss defeated"),
			`${tr("Help bring one down. Bosses wake at landmarks from day")} ${FIRST_BOSS_DAY}.`,
			ECONOMY.COINS_PER_BOSS,
			(h, z) => textLine(h, z, () => `${tr("Bosses defeated")}: ${fmtInt(save.bossKills)}`),
		);
		row(
			3,
			"badge_gift",
			tr("Welcome gift"),
			tr("Given once, to every new survivor."),
			ECONOMY.STARTING_COINS,
			(h, z) => {
				const check = IconView(h, "Check", 0, 2, 20, z, 0, "drawn");
				drawIcon(check, "check", { ink: GAME.success });
				const l = makeLabel(
					h,
					"Text",
					tr("Received"),
					28,
					0,
					EARN_METER_W,
					EARN_METER_H,
					TEXT.base,
					THEME.foreground,
					{
						font: BOLD,
						align: "left",
						zIndex: z,
					},
				);
				return () => {
					if (l.Text !== tr("Received")) l.Text = tr("Received");
				};
			},
		);
	}

	// ---- the tabs
	const names = TAB_KEYS.map(k => tr(k));
	const widths = names.map(n => tabWidth(n));
	let tabsW = 0;
	for (const w of widths) tabsW += w + space(3);
	const tabs = Tabs(panel, "Tabs", {
		x: PAD,
		y: tabsY,
		w: tabsW,
		h: TAB_H,
		items: names,
		widths,
		value: tab,
		onChange: (i: number): void => {
			tab = i;
			refresh();
		},
	});
	if (touch) {
		for (let i = 0; i < tabs.triggers.size(); i++) {
			touchHit(tabs.triggers[i], () => {
				tabs.setActive(i);
				tab = i;
				refresh();
			});
		}
		touchHit(door, () => onWardrobe());
	}

	// ---- a repaint of what exists: the coins, the cards' buttons and badges, the progress lines
	const buys = cards.map(c => c.buy);
	refresh = (): void => {
		if (root.Parent === undefined) return;
		coins.refresh();
		setVisible(packsPage, tab === SHOP_TAB_PACKS);
		setVisible(earnPage, tab === SHOP_TAB_EARN);
		const stops: Array<boolean> = [];
		for (const c of cards) {
			const waiting = pendingPacks(save, c.pack.id);
			setVisible(c.pending, waiting > 0);
			// bought, not delivered yet: it goes into the backpack at the next entry into the city
			if (waiting > 0) setBadge(c.pending, `${tr("Pending")} ×${waiting}`);
			const short = c.pack.price - save.money;
			// a pet pack whose pet is already yours (bought for good in the Wardrobe, or in this life's backpack): a
			// second one would do nothing, so the card says so instead of selling it
			const owned = c.pet >= 0 && ownsEquip(save, c.pet);
			const can = short <= 0 && !owned && !busy;
			let text = tr("Buy");
			if (owned) text = tr("Owned");
			else if (short > 0) text = `${fmtInt(short)} ${tr("more needed")}`;
			if (c.buy.Text !== text) c.buy.Text = text;
			if ((c.buy.GetAttribute("Disabled") === true) === can) setButtonEnabled(c.buy, can);
			stops.push(can);
		}
		// the pad walks the cards it can buy, row by row (the tabs stay above them)
		linkSparseGrid(buys, stops, COLS);
		for (const r of earnRows) r.refresh();
	};

	refresh();
	autoFocus(tabs.triggers[tab]);
	const unsubscribe = onWalletChanged(() => {
		if (!busy) refresh();
		else coins.refresh();
	});

	return (): void => {
		unsubscribe();
		for (const p of previews) p.destroy();
		root.Destroy();
	};
}
