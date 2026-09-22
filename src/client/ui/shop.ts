import { GameContext } from "shared/game/context";
import { ownsCostume, pendingPacks } from "shared/game/save";
import { COSTUMES, ECONOMY, SHOP_PACKS } from "shared/data/shop";
import { EQUIPS } from "shared/data/equips";
import { langGet } from "shared/data/lang";
import { ShopActionReason, ShopActionRequest } from "shared/net/net";
import { invokeShopAction, onWalletChanged, sessionReady } from "../systems/saveClient";
import { toast } from "./popup";
import {
	FONTS,
	PALETTE,
	clearChildren,
	fmtInt,
	makeButton,
	makeCoinPill,
	makeFrame,
	makeLabel,
	makePanel,
	makeScreen,
	nl,
	setButtonEnabled,
	setButtonStyle,
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
	if (reason === "outdated") return tr("Please try again");
	return tr("Connection problem, try again");
}

const TAB_KEYS = ["Packs", "Costumes", "Earn coins"];

export function showShop(ctx: GameContext, onBack: () => void): () => void {
	const lang = ctx.save.settings.langType;
	const tr = (k: string): string => langGet(k, lang);
	const { root, body } = makeScreen(ctx.uiLayer, "Shop", { gradient: true });

	makeButton(body, "Back", `‹  ${tr("Back")}`, 40, 28, 124, 50, "secondary", (): void => onBack());
	makeLabel(body, "Title", tr("Shop"), 184, 24, 400, 58, 36, PALETTE.text, { font: FONTS.display, align: "left" });
	const coins = makeCoinPill(body, "Coins", 850, 28, 230, 52, () => ctx.save.money);

	const tabBar = makeFrame(body, "Tabs", 40, 100, 600, 50, PALETTE.surface, { transparency: 1 });
	const content = makeFrame(body, "Content", 40, 166, 1040, 446, PALETTE.surface, { transparency: 1 });
	const note = makeLabel(body, "Note", "", 660, 110, 420, 30, 14, PALETTE.textMuted, { align: "right" });
	let tab = 0;
	let busy = false;
	let render = (): void => {};

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

	const renderPacks = (): void => {
		for (let i = 0; i < SHOP_PACKS.size(); i++) {
			const pack = SHOP_PACKS[i];
			const x = (i % 3) * 352;
			const y = math.floor(i / 3) * 152;
			const card = makePanel(content, `Pack${pack.id}`, x, y, 336, 140);
			const name = tr(pack.name);
			makeLabel(card, "Name", name, 18, 12, 220, 26, 18, PALETTE.accent, { font: FONTS.bold, align: "left" });
			const pending = pendingPacks(ctx.save, pack.id);
			if (pending > 0) {
				const badge = makeFrame(card, "Pending", 232, 12, 86, 24, PALETTE.info, {
					radius: 12,
					transparency: 0.2,
				});
				makeLabel(badge, "Text", `×${pending} ${tr("Owned").lower()}`, 4, 0, 78, 24, 12, PALETTE.text, {
					font: FONTS.bold,
				});
			}
			makeLabel(card, "Contents", nl(tr(pack.contents)), 18, 42, 300, 52, 14, PALETTE.textDim, {
				align: "left",
				valign: "top",
			});
			const affordable = ctx.save.money >= pack.price;
			makeLabel(card, "Price", `$ ${fmtInt(pack.price)}`, 18, 100, 120, 28, 18, PALETTE.coin, {
				font: FONTS.bold,
				align: "left",
			});
			const btn = makeButton(card, "Buy", tr("Buy"), 196, 96, 122, 36, affordable ? "primary" : "secondary", () =>
				buy({ kind: "buyPack", packId: pack.id }, name, btn, tr("Purchased")),
			);
		}
	};

	const renderCostumes = (): void => {
		for (let i = 0; i < COSTUMES.size(); i++) {
			const c = COSTUMES[i];
			const x = (i % 3) * 352;
			const y = math.floor(i / 3) * 152;
			const owned = ownsCostume(ctx.save, c.id);
			const card = makePanel(content, `Costume${c.id}`, x, y, 336, 140, {
				stroke: owned ? PALETTE.success : PALETTE.strokeSoft,
				strokeTransparency: owned ? 0.3 : 0,
			});
			const name = tr(c.name);
			makeLabel(card, "Name", name, 18, 12, 300, 26, 18, PALETTE.accent, { font: FONTS.bold, align: "left" });
			const deco = EQUIPS[c.equipId];
			const decoName = deco !== undefined ? tr(deco.name) : name;
			makeLabel(card, "Info", `${tr("Deco")}: ${decoName}`, 18, 42, 300, 22, 14, PALETTE.textDim, {
				align: "left",
			});
			if (owned) {
				makeLabel(card, "Owned", `✓  ${tr("Owned")}`, 18, 96, 300, 36, 18, PALETTE.success, {
					font: FONTS.bold,
					align: "right",
				});
			} else {
				makeLabel(card, "Price", `$ ${fmtInt(c.price)}`, 18, 100, 120, 28, 18, PALETTE.coin, {
					font: FONTS.bold,
					align: "left",
				});
				const affordable = ctx.save.money >= c.price;
				const btn = makeButton(
					card,
					"Unlock",
					tr("Unlock"),
					196,
					96,
					122,
					36,
					affordable ? "primary" : "secondary",
					() => buy({ kind: "buyCostume", costumeId: c.id }, name, btn, tr("Unlocked")),
				);
			}
		}
	};

	const renderEarn = (): void => {
		const panel = makePanel(content, "Earn", 0, 0, 1040, 330);
		makeLabel(panel, "Title", tr("Coins are earned by playing"), 32, 22, 976, 34, 24, PALETTE.text, {
			font: FONTS.display,
			align: "left",
		});
		const rows: Array<[string, number]> = [
			[tr("Day survived"), ECONOMY.COINS_PER_DAY],
			[tr("Record day (every 5 days)"), ECONOMY.MILESTONE_BONUS],
			[tr("Boss defeated"), ECONOMY.COINS_PER_BOSS],
			[tr("Welcome gift"), ECONOMY.STARTING_COINS],
		];
		for (let i = 0; i < rows.size(); i++) {
			const [label, value] = rows[i];
			const row = makeFrame(panel, `Row${i}`, 32, 76 + i * 60, 976, 50, PALETTE.surfaceAlt, { radius: 10 });
			makeFrame(row, "Dot", 18, 17, 16, 16, PALETTE.coin, { radius: 8 });
			makeLabel(row, "Label", label, 50, 0, 700, 50, 18, PALETTE.text, { align: "left" });
			makeLabel(row, "Value", `+${value}`, 780, 0, 176, 50, 22, PALETTE.coin, {
				font: FONTS.bold,
				align: "right",
			});
		}
		makeLabel(
			content,
			"Stats",
			`${tr("Best day")}: ${ctx.save.bestDay}   ·   ${tr("Bosses defeated")}: ${fmtInt(ctx.save.bossKills)}`,
			0,
			350,
			1040,
			30,
			16,
			PALETTE.textDim,
		);
	};

	const tabButtons: Array<TextButton> = [];
	for (let i = 0; i < TAB_KEYS.size(); i++) {
		const index = i;
		const b = makeButton(tabBar, `Tab${i}`, tr(TAB_KEYS[i]), i * 196, 0, 186, 50, "secondary", (): void => {
			tab = index;
			render();
		});
		tabButtons.push(b);
	}

	render = (): void => {
		if (content.Parent === undefined) return;
		clearChildren(content);
		for (let i = 0; i < tabButtons.size(); i++) setButtonStyle(tabButtons[i], i === tab ? "primary" : "secondary");
		coins.refresh();
		note.Text = tab === 0 ? tr("Delivered when your next game starts") : "";
		if (tab === 0) renderPacks();
		else if (tab === 1) renderCostumes();
		else renderEarn();
	};

	render();
	const unsubscribe = onWalletChanged(() => {
		if (!busy) render();
		else coins.refresh();
	});

	return (): void => {
		unsubscribe();
		root.Destroy();
	};
}
