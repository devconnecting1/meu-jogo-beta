import { GameContext } from "shared/game/context";
import { COLORS } from "shared/engine/colors";
import { SHOP_PACKS, COIN_PACKS, COSTUMES } from "shared/data/shop";
import { langGet } from "shared/data/lang";
import { toast } from "./popup";
import { makeFrame, makeLabel, makeButton, clearChildren, nl } from "./widgets";

const costumeOwned = new Map<number, boolean>();

const TAB_NAMES = ["Equip", "Costumes", "Coins"];

export function showShop(ctx: GameContext, onBack: () => void): () => void {
	const root = makeFrame(ctx.uiLayer, "Shop", 0, 0, 1120, 630, COLORS.bg);
	makeFrame(root, "TopBar", 0, 0, 1120, 64, Color3.fromRGB(65, 65, 65));
	const moneyLabel = makeLabel(root, "Money", `Coins: ${ctx.save.money}`, 860, 16, 240, 36, 22, COLORS.uiYellow);
	const content = makeFrame(root, "Content", 0, 0, 1120, 630, COLORS.bg, { transparency: 1 });
	let tab = 0;

	const refreshMoney = (): void => {
		moneyLabel.Text = `Coins: ${ctx.save.money}`;
	};

	const render = (): void => {
		clearChildren(content);
		for (let i = 0; i < 3; i++) {
			const active = i === tab;
			const btn = makeButton(
				content,
				`Tab${i}`,
				TAB_NAMES[i],
				60 + i * 180,
				84,
				170,
				52,
				active ? COLORS.uiAccent : COLORS.uiPanelLight,
				(): void => {
					tab = i;
					render();
				},
			);
			if (active) btn.TextColor3 = Color3.fromRGB(30, 30, 30);
		}
		if (tab === 0) {
			for (let i = 0; i < SHOP_PACKS.size(); i++) {
				const pack = SHOP_PACKS[i];
				const col = i % 3;
				const row = math.floor(i / 3);
				const x = 40 + col * 360;
				const y = 160 + row * 148;
				const card = makeFrame(content, `Pack${pack.id}`, x, y, 340, 136, COLORS.uiPanel);
				makeLabel(
					card,
					"Name",
					langGet(pack.name, ctx.save.settings.langType),
					10,
					8,
					320,
					28,
					18,
					COLORS.uiAccent,
				);
				const body = makeLabel(
					card,
					"Contents",
					nl(langGet(pack.contents, ctx.save.settings.langType)),
					10,
					40,
					320,
					56,
					14,
					COLORS.uiTextDim,
				);
				body.TextYAlignment = Enum.TextYAlignment.Top;
				makeButton(card, "Buy", `${pack.price} coin`, 90, 100, 160, 30, COLORS.uiPanelLight, (): void => {
					if (ctx.save.money < pack.price) {
						toast(ctx, langGet("You don't have enough money", ctx.save.settings.langType));
						return;
					}
					ctx.save.money -= pack.price;
					ctx.save.shopHave[pack.id] = (ctx.save.shopHave[pack.id] ?? 0) + 1;
					refreshMoney();
					toast(ctx, `Purchased ${pack.name}`);
				});
			}
		} else if (tab === 1) {
			for (let i = 0; i < COSTUMES.size(); i++) {
				const costume = COSTUMES[i];
				const col = i % 3;
				const row = math.floor(i / 3);
				const x = 40 + col * 360;
				const y = 160 + row * 148;
				const card = makeFrame(content, `Costume${costume.id}`, x, y, 340, 136, COLORS.uiPanel);
				makeLabel(
					card,
					"Name",
					langGet(costume.name, ctx.save.settings.langType),
					10,
					8,
					320,
					28,
					18,
					COLORS.uiAccent,
				);
				const price = ctx.save.settings.langType === 0 ? costume.usd : costume.krw;
				makeLabel(card, "Price", price, 10, 44, 320, 26, 15, COLORS.uiTextDim);
				const owned = costumeOwned.get(costume.id) === true;
				if (owned) {
					makeLabel(card, "Owned", "Owned", 90, 100, 160, 30, 16, COLORS.uiGreen);
				} else {
					makeButton(card, "Unlock", "Unlock 10", 90, 100, 160, 30, COLORS.uiPanelLight, (): void => {
						if (ctx.save.money < 10) {
							toast(ctx, langGet("You don't have enough money", ctx.save.settings.langType));
							return;
						}
						ctx.save.money -= 10;
						costumeOwned.set(costume.id, true);
						refreshMoney();
						render();
						toast(ctx, `Unlocked ${costume.name}`);
					});
				}
			}
		} else {
			for (let i = 0; i < COIN_PACKS.size(); i++) {
				const pack = COIN_PACKS[i];
				const col = i % 3;
				const row = math.floor(i / 3);
				const x = 40 + col * 360;
				const y = 160 + row * 148;
				const card = makeFrame(content, `Coin${pack.id}`, x, y, 340, 136, COLORS.uiPanel);
				makeLabel(
					card,
					"Name",
					langGet(pack.name, ctx.save.settings.langType),
					10,
					8,
					320,
					28,
					18,
					COLORS.uiAccent,
				);
				if (pack.usd !== "") {
					makeLabel(card, "Price", pack.usd, 10, 44, 320, 26, 15, COLORS.uiTextDim);
				}
				if (pack.id === 0) {
					makeButton(card, "Ad", "Watch ad +5", 90, 100, 160, 30, Color3.fromRGB(80, 120, 80), (): void => {
						ctx.save.money += 5;
						refreshMoney();
						toast(ctx, "Rewarded, 5 coins");
					});
				} else {
					const stub = makeButton(
						card,
						"Iap",
						pack.usd,
						90,
						100,
						160,
						30,
						Color3.fromRGB(50, 50, 58),
						(): void => {
							toast(ctx, "IAP coming soon");
						},
					);
					stub.TextColor3 = COLORS.uiTextDim;
				}
			}
		}
	};

	render();

	makeButton(root, "Back", "Back", 970, 84, 120, 52, COLORS.uiPanelLight, (): void => onBack());

	return (): void => {
		root.Destroy();
	};
}
