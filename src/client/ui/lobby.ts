import { GameContext } from "shared/game/context";
import { expMaxInit, totalPendingPacks } from "shared/game/save";
import { TIPS } from "shared/data/tips";
import { ACHIEVEMENTS } from "shared/data/achievements";
import { WEAPONS } from "shared/data/weapons";
import { EQUIPS } from "shared/data/equips";
import { langGet } from "shared/data/lang";
import { onWalletChanged } from "../systems/saveClient";
import { popup } from "./popup";
import {
	FONTS,
	PALETTE,
	fmtInt,
	makeBar,
	makeButton,
	makeCoinPill,
	makeFrame,
	makeLabel,
	makeListRow,
	makePanel,
	makeScreen,
	makeScrollList,
	nl,
	uiScale,
} from "./widgets";

export interface LobbyHandlers {
	onPlay: () => void;
	onShop: () => void;
	onSettings: () => void;
	onCredits?: () => void;
	/** `thenPlay`: opened from the Play prompt, start the game when the tutorial ends */
	onTutorial: (thenPlay?: boolean) => void;
}

export interface LobbyStatus {
	/** the save is still being loaded from the server */
	loading: boolean;
	/** a run is suspended in memory: Play continues it */
	suspended: boolean;
	/** why progress is not being saved (undefined = saving normally) */
	offlineNote?: string;
}

function shuffledTips(): string {
	const list: Array<string> = [];
	for (const tip of TIPS) list.push(tip);
	for (let i = list.size() - 1; i > 0; i--) {
		const j = math.random(0, i);
		const tmp = list[i];
		list[i] = list[j];
		list[j] = tmp;
	}
	return list.join("     •     ");
}

function equipName(ctx: GameContext, slot: number): string {
	const save = ctx.save;
	const lang = save.settings.langType;
	const pick = (id: number, defs: Array<{ name: string }>): string => {
		const def = id >= 0 ? defs[id] : undefined;
		return def !== undefined ? langGet(def.name, lang) : "—";
	};
	if (slot === 0) return pick(save.equipWeapon >= 0 ? save.equipWeapon : 0, WEAPONS);
	if (slot === 1) return pick(save.equipCloth, EQUIPS);
	if (slot === 2) return pick(save.equipHand, EQUIPS);
	if (slot === 3) return pick(save.equipGun, EQUIPS);
	return pick(save.equipDeco, EQUIPS);
}

function showAchievements(ctx: GameContext): void {
	const lang = ctx.save.settings.langType;
	const tr = (k: string): string => langGet(k, lang);
	const { root, body } = makeScreen(ctx.uiLayer, "Achievements", {
		color: PALETTE.overlay,
		transparency: 0.4,
		zIndex: 300,
	});
	const panel = makePanel(body, "Panel", 230, 50, 660, 530);
	const visible = ACHIEVEMENTS.filter(a => a.hidden !== true);
	let done = 0;
	for (const a of visible) {
		if ((ctx.save.achievements[a.id] ?? 0) >= a.max) done++;
	}
	makeLabel(panel, "Title", tr("Achievements"), 28, 22, 400, 40, 28, PALETTE.text, {
		font: FONTS.display,
		align: "left",
	});
	makeLabel(panel, "Count", `${done} / ${visible.size()}`, 430, 26, 110, 32, 18, PALETTE.accent, {
		font: FONTS.bold,
		align: "right",
	});
	makeButton(panel, "Close", "X", 572, 20, 60, 44, "ghost", (): void => root.Destroy());
	const list = makeScrollList(panel, "List", 24, 80, 612, 426);
	// unfinished (closest to done first), then finished
	const ordered = [...visible];
	const ratio = (a: (typeof visible)[number]): number => (ctx.save.achievements[a.id] ?? 0) / math.max(a.max, 1);
	ordered.sort((a, b) => {
		const ra = ratio(a) >= 1 ? -1 : ratio(a);
		const rb = ratio(b) >= 1 ? -1 : ratio(b);
		return ra > rb;
	});
	for (let i = 0; i < ordered.size(); i++) {
		const a = ordered[i];
		const cur = math.min(ctx.save.achievements[a.id] ?? 0, a.max);
		const complete = cur >= a.max;
		const row = makeListRow(list, `Ach${a.id}`, i, 58, complete ? PALETTE.surfaceHi : PALETTE.surfaceAlt);
		makeFrame(row, "Badge", 14, 15, 28, 28, complete ? PALETTE.success : PALETTE.bgRaised, {
			radius: 14,
			stroke: complete ? PALETTE.success : PALETTE.stroke,
		});
		if (complete) makeLabel(row, "Check", "✓", 14, 15, 28, 28, 18, PALETTE.text, { font: FONTS.bold });
		makeLabel(row, "Name", tr(a.title), 56, 8, 330, 24, 17, complete ? PALETTE.text : PALETTE.textDim, {
			font: FONTS.bold,
			align: "left",
		});
		const bar = makeBar(row, "Progress", 56, 36, 380, 8, complete ? PALETTE.success : PALETTE.accent);
		bar.setRatio(cur / math.max(a.max, 1));
		makeLabel(row, "Value", `${fmtInt(cur)} / ${fmtInt(a.max)}`, 450, 14, 140, 30, 16, PALETTE.textDim, {
			align: "right",
		});
	}
}

function showRecords(ctx: GameContext): void {
	const s = ctx.save;
	const lang = s.settings.langType;
	const tr = (k: string): string => langGet(k, lang);
	const lines = [
		`${tr("Best day")}:  ${s.bestDay}`,
		`${tr("Current day")}:  ${s.day}`,
		`${tr("Level")}:  ${s.level}`,
		`${tr("Bosses defeated")}:  ${fmtInt(s.bossKills)}`,
		`${tr("Rebirth")}:  ${s.deathCount}`,
	];
	popup(ctx, tr("Personal bests"), lines.join("\n"), [{ text: tr("Close") }]);
}

export function showLobby(ctx: GameContext, handlers: LobbyHandlers, status?: LobbyStatus): () => void {
	const save = ctx.save;
	const lang = save.settings.langType;
	const tr = (k: string): string => langGet(k, lang);
	const { root, body } = makeScreen(ctx.uiLayer, "Lobby", { gradient: true });

	// ---- header
	makeLabel(body, "Title", `PROJECT <font color="#E8A838">Z</font>`, 40, 22, 460, 60, 46, PALETTE.text, {
		font: FONTS.display,
		align: "left",
		rich: true,
	});
	makeLabel(body, "Subtitle", tr("Zombie survival"), 42, 78, 400, 22, 15, PALETTE.textDim, { align: "left" });
	const coins = makeCoinPill(body, "Coins", 850, 28, 230, 52, () => ctx.save.money, handlers.onShop);
	if (status?.loading === true) {
		makeLabel(body, "Loading", tr("Loading your progress..."), 620, 88, 460, 22, 14, PALETTE.textDim, {
			align: "right",
		});
	} else if (status?.offlineNote !== undefined) {
		makeLabel(body, "Offline", status.offlineNote, 560, 88, 520, 22, 14, PALETTE.danger, { align: "right" });
	}

	// ---- survivor card (left)
	const card = makePanel(body, "Survivor", 40, 124, 440, 420);
	makeLabel(card, "CardTitle", tr("Survivor").upper(), 24, 16, 392, 22, 14, PALETTE.textMuted, {
		font: FONTS.bold,
		align: "left",
	});
	const tiles: Array<[string, string, Color3]> = [
		[`${save.day}`, tr("Current day"), PALETTE.text],
		[`${save.bestDay}`, tr("Best day"), PALETTE.accent],
		[`${save.level}`, tr("Level"), PALETTE.exp],
		[fmtInt(save.bossKills), tr("Bosses defeated"), PALETTE.danger],
	];
	for (let i = 0; i < tiles.size(); i++) {
		const [value, caption, color] = tiles[i];
		const tx = 24 + (i % 2) * 200;
		const ty = 46 + math.floor(i / 2) * 80;
		const tile = makeFrame(card, `Tile${i}`, tx, ty, 192, 72, PALETTE.surfaceAlt, { radius: 10 });
		makeLabel(tile, "Value", value, 14, 6, 164, 36, 28, color, { font: FONTS.display, align: "left" });
		makeLabel(tile, "Caption", caption, 14, 44, 164, 20, 13, PALETTE.textDim, { align: "left" });
	}
	const expMax = expMaxInit(save.level);
	const exp = makeBar(card, "Exp", 24, 214, 392, 12, PALETTE.exp);
	exp.setRatio(save.exp / math.max(expMax, 1));
	makeLabel(card, "ExpText", `${fmtInt(save.exp)} / ${fmtInt(expMax)} XP`, 24, 230, 392, 18, 13, PALETTE.textDim, {
		align: "right",
	});
	makeLabel(card, "LoadoutTitle", tr("Loadout").upper(), 24, 258, 392, 20, 13, PALETTE.textMuted, {
		font: FONTS.bold,
		align: "left",
	});
	const slotKeys = ["Weapon", "Clothes", "Hand", "Gun", "Deco"];
	for (let i = 0; i < slotKeys.size(); i++) {
		const y = 284 + i * 26;
		makeLabel(card, `SlotTag${i}`, tr(slotKeys[i]), 24, y, 110, 22, 14, PALETTE.textDim, { align: "left" });
		const name = equipName(ctx, i);
		makeLabel(card, `SlotName${i}`, name, 134, y, 282, 22, 15, name === "—" ? PALETTE.textMuted : PALETTE.text, {
			font: FONTS.medium,
			align: "left",
		});
	}

	// ---- play (primary) + menu grid (right)
	const pending = totalPendingPacks(save);
	const playTitle = save.runOver ? tr("Game over") : status?.suspended === true ? tr("Continue") : tr("Play");
	let playSub = `${tr("Day")} ${save.day}`;
	if (pending > 0) playSub = `${playSub}  ·  ${tr("Packs")} +${pending}`;
	const play = makeButton(body, "Play", "", 512, 124, 568, 160, "primary", (): void => {
		if (!ctx.save.tutorialDone && !ctx.save.runOver) {
			popup(ctx, tr("How to play"), nl(tr("Do you want to#watch the tutorial?")), [
				{
					text: "No",
					style: "secondary",
					onClick: (): void => {
						ctx.save.tutorialDone = true;
						handlers.onPlay();
					},
				},
				{ text: "Yes", onClick: (): void => handlers.onTutorial(true) },
			]);
		} else {
			handlers.onPlay();
		}
	});
	makeLabel(play, "PlayTitle", playTitle.upper(), 0, 26, 568, 70, 50, PALETTE.textOnAccent, { font: FONTS.display });
	makeLabel(play, "PlaySub", playSub, 0, 100, 568, 30, 18, PALETTE.textOnAccent, { font: FONTS.medium });

	let achDone = 0;
	let achTotal = 0;
	for (const a of ACHIEVEMENTS) {
		if (a.hidden === true) continue;
		achTotal++;
		if ((save.achievements[a.id] ?? 0) >= a.max) achDone++;
	}
	const tiles2: Array<[string, string, () => void]> = [
		[tr("Shop"), tr("Packs & costumes"), handlers.onShop],
		[tr("Achievements"), `${achDone} / ${achTotal}`, (): void => showAchievements(ctx)],
		[tr("Records"), `${tr("Best day")} ${save.bestDay}`, (): void => showRecords(ctx)],
		[tr("How to play"), "", (): void => handlers.onTutorial(false)],
		[tr("Settings"), "", handlers.onSettings],
		[tr("Credits"), "", (): void => handlers.onCredits?.()],
	];
	for (let i = 0; i < tiles2.size(); i++) {
		const [title, sub, fn] = tiles2[i];
		const x = 512 + (i % 3) * 192;
		const y = 300 + math.floor(i / 3) * 128;
		const b = makeButton(body, `Menu${i}`, "", x, y, 184, 116, "secondary", fn);
		makeLabel(b, "Title", title, 12, sub === "" ? 38 : 28, 160, 30, 19, PALETTE.text, { font: FONTS.bold });
		if (sub !== "") makeLabel(b, "Sub", sub, 12, 62, 160, 22, 13, PALETTE.textDim);
	}

	// ---- tips ticker
	const ticker = makePanel(body, "Ticker", 40, 562, 1040, 44, { color: PALETTE.bgRaised, radius: 22 });
	ticker.ClipsDescendants = true;
	const tip = new Instance("TextLabel");
	tip.Name = "Tip";
	tip.BackgroundTransparency = 1;
	tip.Font = FONTS.body;
	tip.TextColor3 = PALETTE.textDim;
	tip.TextXAlignment = Enum.TextXAlignment.Left;
	tip.AutomaticSize = Enum.AutomaticSize.X;
	tip.Size = UDim2.fromScale(0, 1);
	tip.Text = `${shuffledTips()}     •     ${shuffledTips()}`;
	tip.Parent = ticker;
	let tipX = 0;
	const RunService = game.GetService("RunService");
	const conn = RunService.RenderStepped.Connect((dt: number): void => {
		tip.TextSize = math.max(10, math.round(15 * uiScale()));
		tipX += 70 * uiScale() * dt;
		const w = tip.AbsoluteSize.X;
		if (w > 10 && tipX > w / 2) tipX -= w / 2;
		tip.Position = new UDim2(0, 20 - tipX, 0, 0);
	});

	const unsubscribe = onWalletChanged(() => coins.refresh());

	return (): void => {
		unsubscribe();
		conn.Disconnect();
		root.Destroy();
	};
}
