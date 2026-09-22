import { GameContext } from "shared/game/context";
import { COLORS } from "shared/engine/colors";
import { TIPS } from "shared/data/tips";
import { ACHIEVEMENTS } from "shared/data/achievements";
import { WEAPONS } from "shared/data/weapons";
import { EQUIPS } from "shared/data/equips";
import { langGet } from "shared/data/lang";
import { popup, toast } from "./popup";
import { makeFrame, makeLabel, makeButton, makeBar, nl } from "./widgets";

export interface LobbyHandlers {
	onPlay: () => void;
	onShop: () => void;
	onSettings: () => void;
	onCredits?: () => void;
	onTutorial: () => void;
}

function shuffledTips(): string {
	const list: Array<string> = [];
	for (const tip of TIPS) list.push(tip);
	for (let i = 0; i < 40; i++) {
		const a = math.random(0, list.size() - 1);
		const b = math.random(0, list.size() - 1);
		const tmp = list[a];
		list[a] = list[b];
		list[b] = tmp;
	}
	return list.join(" / ");
}

function equipName(ctx: GameContext, slot: number): string {
	const save = ctx.save;
	if (slot === 0) {
		return save.equipWeapon >= 0 ? WEAPONS[save.equipWeapon].name : "-";
	}
	if (slot === 1) return save.equipCloth >= 0 ? EQUIPS[save.equipCloth].name : "-";
	if (slot === 2) return save.equipHand >= 0 ? EQUIPS[save.equipHand].name : "-";
	if (slot === 3) return save.equipGun >= 0 ? EQUIPS[save.equipGun].name : "-";
	return save.equipDeco >= 0 ? EQUIPS[save.equipDeco].name : "-";
}

export function showLobby(ctx: GameContext, handlers: LobbyHandlers): () => void {
	const root = makeFrame(ctx.uiLayer, "Lobby", 0, 0, 1120, 630, COLORS.bg);
	makeFrame(root, "TopBar", 0, 0, 1120, 64, Color3.fromRGB(65, 65, 65));
	makeFrame(root, "BottomBar", 0, 582, 1120, 48, Color3.fromRGB(65, 65, 65));
	makeFrame(root, "CoinPanel", 834, 0, 286, 64, Color3.fromRGB(117, 117, 117));
	const coinZone = makeButton(root, "CoinZone", "", 834, 0, 286, 64, Color3.fromRGB(117, 117, 117), (): void =>
		handlers.onShop(),
	);
	coinZone.TextTransparency = 1;
	const coinIcon = makeLabel(root, "CoinIcon", "$", 850, 14, 40, 40, 26, COLORS.uiYellow);
	coinIcon.ZIndex = 2;
	const moneyLabel = makeLabel(root, "Money", `${ctx.save.money}`, 894, 16, 210, 36, 24, COLORS.uiText);
	moneyLabel.TextXAlignment = Enum.TextXAlignment.Left;
	moneyLabel.ZIndex = 2;
	const title = makeLabel(root, "Title", "DEAD TOWN", 60, 14, 400, 44, 30, COLORS.uiText);
	title.TextXAlignment = Enum.TextXAlignment.Left;

	const refreshMoney = (): void => {
		moneyLabel.Text = `${ctx.save.money}`;
	};

	makeButton(root, "Play", "Play", 224, 128, 200, 70, COLORS.uiPanelLight, (): void => {
		if (!ctx.save.tutorialDone) {
			popup(
				ctx,
				langGet("Tutorial", ctx.save.settings.langType),
				nl(langGet("Do you want to#watch the tutorial?", ctx.save.settings.langType)),
				[
					{
						text: "Yes",
						onClick: (): void => handlers.onTutorial(),
					},
					{
						text: "No",
						onClick: (): void => {
							ctx.save.tutorialDone = true;
							handlers.onPlay();
						},
					},
				],
			);
		} else {
			handlers.onPlay();
		}
	});
	makeButton(root, "Shop", "Shop", 544, 128, 200, 70, COLORS.uiPanelLight, (): void => handlers.onShop());
	makeButton(root, "Adv", "Adv\n+5", 896, 128, 200, 70, Color3.fromRGB(80, 120, 80), (): void => {
		ctx.save.money += 5;
		refreshMoney();
		toast(ctx, "Rewarded, 5 coins");
	});
	makeButton(root, "Ach", "Achievements", 256, 416, 200, 70, COLORS.uiPanelLight, (): void => {
		let body = "";
		for (const ach of ACHIEVEMENTS) {
			const cur = ctx.save.achievements[ach.id] ?? 0;
			body += `${ach.key}  ${cur}/${ach.max}\n`;
		}
		popup(ctx, "Achievements", body, [{ text: "Close" }]);
	});
	makeButton(root, "Leader", "Leaderboard", 512, 384, 200, 70, COLORS.uiPanelLight, (): void => {
		popup(ctx, "Leaderboard", "Survival days : --\nLevels : --\n\nLeaderboards coming soon.", [{ text: "Close" }]);
	});
	makeButton(root, "Settings", "Settings", 832, 384, 200, 70, COLORS.uiPanelLight, (): void => handlers.onSettings());

	makeLabel(root, "DayTitle", `Day ${ctx.save.day}`, 80, 214, 180, 34, 22, COLORS.uiText);
	makeLabel(root, "HpTag", "HP", 80, 254, 36, 20, 14, COLORS.uiRed);
	const hpBar = makeBar(root, "HpBar", 120, 256, 160, 16, COLORS.uiRed);
	hpBar.setRatio(1);
	makeLabel(root, "HungerTag", "FD", 80, 280, 36, 20, 14, COLORS.uiYellow);
	const hungerBar = makeBar(root, "HungerBar", 120, 282, 160, 16, COLORS.uiYellow);
	hungerBar.setRatio(1);
	const slotNames = ["Weapon", "Cloth", "Hand", "Gun", "Deco"];
	for (let i = 0; i < 5; i++) {
		const y = 330 + i * 44;
		const box = makeFrame(root, `SlotBox${i}`, 80, y, 40, 36, Color3.fromRGB(200, 200, 200));
		const tag = makeLabel(box, `SlotTag`, slotNames[i].sub(1, 1), 0, 6, 40, 24, 16, Color3.fromRGB(40, 40, 40));
		tag.ZIndex = 2;
		const name = makeLabel(root, `SlotName${i}`, equipName(ctx, i), 130, y + 4, 240, 28, 16, COLORS.uiTextDim);
		name.TextXAlignment = Enum.TextXAlignment.Left;
	}

	const tipLabel = makeLabel(root, "Tip", "", 0, 596, 0, 30, 16, COLORS.uiTextDim);
	tipLabel.AutomaticSize = Enum.AutomaticSize.X;
	tipLabel.Size = UDim2.fromOffset(0, 30);
	tipLabel.TextXAlignment = Enum.TextXAlignment.Left;
	const tipText = `${shuffledTips()}   /   ${shuffledTips()}`;
	tipLabel.Text = tipText;

	let tipX = 0;
	const RunService = game.GetService("RunService");
	const conn = RunService.RenderStepped.Connect((dt: number): void => {
		tipX += 80 * dt;
		const w = tipLabel.AbsoluteSize.X;
		if (w > 10 && tipX > w / 2) tipX -= w / 2;
		tipLabel.Position = new UDim2(0, -tipX, 1, -36);
	});

	return (): void => {
		conn.Disconnect();
		root.Destroy();
	};
}
