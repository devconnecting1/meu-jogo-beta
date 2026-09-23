import { GameContext } from "shared/game/context";
import { pendingPacks } from "shared/game/save";
import { ECONOMY, SHOP_PACKS } from "shared/data/shop";
import { langGet } from "shared/data/lang";
import { ShopActionReason, ShopActionRequest } from "shared/net/net";
import { invokeShopAction, onWalletChanged, sessionReady } from "../systems/saveClient";
import { toast } from "./popup";
import { GAME, RADIUS, TEXT, THEME, space } from "./theme";
import {
	BUTTON_SIZE,
	Badge,
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
	CoinIcon,
	Sidebar,
	autoFocus,
	badgeWidth,
	cardHeaderHeight,
	clearChildren,
	fmtInt,
	linkGrid,
	makeCoinPill,
	makeFrame,
	makeLabel,
	makeScreen,
	nl,
	setButtonEnabled,
} from "./widgets";

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
 * The rail. "Wardrobe" is not a page of this screen: it OPENS the wardrobe (client/ui/wardrobe.ts, MON-04), where
 * outfits and pets are tried on, bought and worn. It replaced the costume cards that used to live here, so there
 * is one place to buy a cosmetic, not two.
 */
const TAB_KEYS = ["Packs", "Wardrobe", "Earn coins"];
const TAB_WARDROBE = 1;

// ---------------------------------------------------------------- layout (1120 x 630 design units)

const MARGIN_X = 40;
/** header row: Back button, title and coin pill share this vertical centre */
const HEADER_Y = 32;
/** category navigation (left) and the selected category's content (right) */
const MAIN_Y = 96;
const MAIN_H = 512;
const NAV_W = 200;
const NOTE_H = 60;
const CONTENT_X = MARGIN_X + NAV_W + space(4);
const CONTENT_W = 1120 - MARGIN_X - CONTENT_X;

/** 3 x 3 grid of cards, gap-4 */
const COLS = 3;
const ROWS = 3;
const GAP = space(4);
const CARD_W = (CONTENT_W - GAP * (COLS - 1)) / COLS;
const CARD_H = (MAIN_H - GAP * (ROWS - 1)) / ROWS;
const CARD_PAD = space(4);
const TITLE_H = 24;
const DESC_Y = CARD_PAD + TITLE_H + space(1);
const ACTION_H = BUTTON_SIZE.sm.h;
const ACTION_W = 100;
const FOOTER_Y = CARD_H - CARD_PAD - ACTION_H;
const BADGE_H = 22;
const COIN_ICON = 18;

/** "Earn coins" tab */
const EARN_ROW_H = 48;
const EARN_ROW_GAP = space(2);

function cell(i: number): [number, number] {
	return [(i % COLS) * (CARD_W + GAP), math.floor(i / COLS) * (CARD_H + GAP)];
}

/** card footer, left side: coin icon + price in numeric foreground */
function priceTag(card: Frame, price: number): void {
	CoinIcon(card, "CoinIcon", CARD_PAD, FOOTER_Y + (ACTION_H - COIN_ICON) / 2, COIN_ICON);
	const x = CARD_PAD + COIN_ICON + space(2);
	makeLabel(
		card,
		"Price",
		fmtInt(price),
		x,
		FOOTER_Y,
		CARD_W - x - ACTION_W - CARD_PAD,
		ACTION_H,
		TEXT.lg,
		THEME.foreground,
		{
			font: "numeric",
			align: "left",
		},
	);
}

/** solid-colour badge; `right` = its right edge, `centerY` = its vertical centre (card design units) */
function badgeAt(card: Frame, name: string, text: string, right: number, centerY: number, color: Color3): number {
	const w = badgeWidth(text, TEXT.xs, BADGE_H);
	Badge(card, name, text, { x: right - w, y: centerY - BADGE_H / 2, w, h: BADGE_H, color });
	return w;
}

export function showShop(ctx: GameContext, onBack: () => void, onWardrobe: () => void): () => void {
	const lang = ctx.save.settings.langType;
	const tr = (k: string): string => langGet(k, lang);
	// a menu page: see-through, over the town flyover behind the menus (UI-10); its layout reaches the screen's
	// edges (Back, the coins), so it keeps clear of the Roblox buttons as a whole (makeScreen's default content)
	const { root, body } = makeScreen(ctx.uiLayer, "Shop", { transparency: 1 });

	Button(body, "Back", `‹  ${tr("Back")}`, {
		x: MARGIN_X,
		y: HEADER_Y,
		w: 124,
		variant: "secondary",
		onClick: (): void => onBack(),
	});
	makeLabel(body, "Title", tr("Shop"), 184, HEADER_Y, 400, BUTTON_SIZE.default.h, TEXT.xl3, THEME.foreground, {
		font: "title",
		align: "left",
	});
	const coins = makeCoinPill(body, "Coins", 850, 28, 230, 52, () => ctx.save.money);

	let tab = 0;
	let busy = false;
	let render = (): void => {};

	const nav = Sidebar(body, "Categories", {
		x: MARGIN_X,
		y: MAIN_Y,
		w: NAV_W,
		h: MAIN_H,
		items: TAB_KEYS.map(k => tr(k)),
		value: tab,
		onChange: (i: number): void => {
			if (i === TAB_WARDROBE) {
				// a door, not a page: leave the rail on the page that is showing, and go
				nav.setActive(tab);
				onWardrobe();
				return;
			}
			tab = i;
			render();
		},
	});
	// hint at the bottom of the rail (Packs only)
	const note = makeLabel(
		nav.frame,
		"Note",
		"",
		space(3),
		MAIN_H - NOTE_H - space(3),
		NAV_W - space(6),
		NOTE_H,
		TEXT.sm,
		THEME.mutedForeground,
		{ font: "caption", align: "left", valign: "bottom", zIndex: nav.frame.ZIndex + 1 },
	);
	const content = makeFrame(body, "Content", CONTENT_X, MAIN_Y, CONTENT_W, MAIN_H, THEME.background, {
		transparency: 1,
	});

	const buy = (request: ShopActionRequest, name: string, btn: TextButton, okText: string): void => {
		if (busy) return;
		if (!sessionReady()) {
			toast(ctx, tr("Still loading your progress"), "error");
			return;
		}
		busy = true;
		setButtonEnabled(btn, false);
		const res = invokeShopAction(request);
		busy = false;
		if (btn.Parent !== undefined) setButtonEnabled(btn, true);
		if (res.ok) {
			toast(ctx, `${okText}: ${name}`, "success");
		} else {
			toast(ctx, actionErrorText(res.reason, lang), "error");
		}
		render();
	};

	/** card footer, right side: Buy (outline when the player can't afford it; the server still answers) */
	const actionButton = (card: Frame, name: string, text: string, price: number, onClick: () => void): TextButton =>
		Button(card, name, text, {
			x: CARD_W - CARD_PAD - ACTION_W,
			y: FOOTER_Y,
			w: ACTION_W,
			size: "sm",
			variant: ctx.save.money >= price ? "default" : "outline",
			onClick,
		});

	const renderPacks = (): void => {
		const buys: Array<TextButton> = [];
		for (let i = 0; i < SHOP_PACKS.size(); i++) {
			const pack = SHOP_PACKS[i];
			const [x, y] = cell(i);
			const card = Card(content, `Pack${pack.id}`, { x, y, w: CARD_W, h: CARD_H, pad: CARD_PAD });
			const name = tr(pack.name);
			let titleW = CARD_W - CARD_PAD * 2;
			const pending = pendingPacks(ctx.save, pack.id);
			if (pending > 0) {
				const text = `×${pending} ${tr("Owned").lower()}`;
				const right = CARD_W - CARD_PAD;
				titleW -= badgeAt(card, "Pending", text, right, CARD_PAD + TITLE_H / 2, GAME.info) + space(2);
			}
			CardTitle(card, name, { y: CARD_PAD, w: titleW, h: TITLE_H, size: TEXT.lg });
			CardDescription(card, nl(tr(pack.contents)), { y: DESC_Y, h: FOOTER_Y - DESC_Y - space(0.5) });
			priceTag(card, pack.price);
			const btn = actionButton(card, "Buy", tr("Buy"), pack.price, () =>
				buy({ kind: "buyPack", packId: pack.id }, name, btn, tr("Purchased")),
			);
			buys.push(btn);
		}
		// the pad walks the cards' Buy buttons as the grid they are, row by row (the rail stays to their left)
		linkGrid(buys, COLS);
	};

	const renderEarn = (): void => {
		const rows: Array<[string, number]> = [
			[tr("Day survived"), ECONOMY.COINS_PER_DAY],
			[tr("Record day (every 5 days)"), ECONOMY.MILESTONE_BONUS],
			[tr("Boss defeated"), ECONOMY.COINS_PER_BOSS],
			[tr("Welcome gift"), ECONOMY.STARTING_COINS],
		];
		const pad = space(6);
		const headerH = cardHeaderHeight();
		const listH = rows.size() * EARN_ROW_H + (rows.size() - 1) * EARN_ROW_GAP;
		const cardH = headerH + listH + pad;
		const card = Card(content, "Earn", { x: 0, y: 0, w: CONTENT_W, h: cardH, pad });
		const top = CardHeader(card, tr("Coins are earned by playing"));
		const rowW = CONTENT_W - pad * 2;
		const dot = 10;
		const valueW = 160;
		for (let i = 0; i < rows.size(); i++) {
			const [label, value] = rows[i];
			const row = Card(card, `Row${i}`, {
				x: pad,
				y: top + i * (EARN_ROW_H + EARN_ROW_GAP),
				w: rowW,
				h: EARN_ROW_H,
				variant: "muted",
			});
			makeFrame(row, "Dot", space(4), (EARN_ROW_H - dot) / 2, dot, dot, GAME.coin, { radius: RADIUS.full });
			const labelX = space(4) + dot + space(3);
			makeLabel(
				row,
				"Label",
				label,
				labelX,
				0,
				rowW - labelX - valueW - space(4),
				EARN_ROW_H,
				TEXT.base,
				THEME.foreground,
				{
					align: "left",
				},
			);
			makeLabel(
				row,
				"Value",
				`+${fmtInt(value)}`,
				rowW - space(4) - valueW,
				0,
				valueW,
				EARN_ROW_H,
				TEXT.lg,
				THEME.foreground,
				{
					font: "numeric",
					align: "right",
				},
			);
		}
		makeLabel(
			content,
			"Stats",
			`${tr("Best day")}: ${ctx.save.bestDay}   ·   ${tr("Bosses defeated")}: ${fmtInt(ctx.save.bossKills)}`,
			0,
			cardH + space(4),
			CONTENT_W,
			24,
			TEXT.sm,
			THEME.mutedForeground,
			{ font: "caption", align: "left" },
		);
	};

	render = (): void => {
		if (content.Parent === undefined) return;
		clearChildren(content);
		coins.refresh();
		note.Text = tab === 0 ? tr("Delivered when your next game starts") : "";
		if (tab === 0) renderPacks();
		else renderEarn();
	};

	render();
	autoFocus(nav.items[tab]);
	const unsubscribe = onWalletChanged(() => {
		if (!busy) render();
		else coins.refresh();
	});

	return (): void => {
		unsubscribe();
		root.Destroy();
	};
}
