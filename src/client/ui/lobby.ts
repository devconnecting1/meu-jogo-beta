import { GameContext } from "shared/game/context";
import { equippedIn, expMaxInit, totalPendingPacks } from "shared/game/save";
import { TIPS } from "shared/data/tips";
import { ACHIEVEMENTS } from "shared/data/achievements";
import { WEAPONS } from "shared/data/weapons";
import { EQUIPS } from "shared/data/equips";
import { langGet } from "shared/data/lang";
import { onWalletChanged } from "../systems/saveClient";
import { popup } from "./popup";
import { GAME, TEXT, THEME, fontOf, hex, roleFont, space } from "./theme";
import {
	Button,
	Card,
	CardHeader,
	Dialog,
	Progress,
	Separator,
	autoFocus,
	buttonForeground,
	fmtInt,
	makeCoinPill,
	makeLabel,
	makeListRow,
	makeScreen,
	makeScrollList,
	makeSurface,
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
	// 1..5 are EquipSlot: cloth, hand, gun, outfit, pet
	return pick(equippedIn(save, slot), EQUIPS);
}

const ACH_W = 660;
const ACH_H = 530;
const ACH_ROW_H = 60;

function showAchievements(ctx: GameContext): void {
	const lang = ctx.save.settings.langType;
	const tr = (k: string): string => langGet(k, lang);
	const visible = ACHIEVEMENTS.filter(a => a.hidden !== true);
	let done = 0;
	for (const a of visible) {
		if ((ctx.save.achievements[a.id] ?? 0) >= a.max) done++;
	}
	const dialog = Dialog(ctx.uiLayer, "Achievements", {
		w: ACH_W,
		h: ACH_H,
		title: tr("Achievements"),
		description: `${done} / ${visible.size()}`,
		zIndex: 300,
		closeButton: true,
	});
	const pad = space(6);
	const listW = ACH_W - pad * 2;
	const list = makeScrollList(dialog.card, "List", pad, dialog.contentY, listW, ACH_H - dialog.contentY - pad);
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
		const row = makeListRow(list, `Ach${a.id}`, i, ACH_ROW_H);
		// pixel chip: filled in `success` when the achievement is done, an empty socket otherwise
		const badge = makeSurface(row, "Badge", space(4), 16, 28, 28, "well", {
			fill: complete ? GAME.success : THEME.background,
			border: complete ? GAME.success : THEME.border,
			zIndex: 2,
		});
		if (complete) {
			makeLabel(badge, "Check", "✓", 0, 0, 28, 28, TEXT.base, THEME.background, {
				weight: Enum.FontWeight.Bold,
				zIndex: 3,
				outline: false,
			});
		}
		const textX = space(4) + 28 + space(3);
		makeLabel(
			row,
			"Name",
			tr(a.title),
			textX,
			8,
			330,
			24,
			TEXT.base,
			complete ? THEME.foreground : THEME.mutedForeground,
			{
				font: "label",
				align: "left",
			},
		);
		const bar = Progress(row, "Progress", {
			x: textX,
			y: 38,
			w: 360,
			h: 8,
			color: complete ? GAME.success : THEME.primary,
		});
		bar.setRatio(cur / math.max(a.max, 1));
		makeLabel(
			row,
			"Value",
			`${fmtInt(cur)} / ${fmtInt(a.max)}`,
			listW - 170,
			14,
			150,
			32,
			TEXT.sm,
			THEME.mutedForeground,
			{
				font: "numeric",
				align: "right",
			},
		);
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
	popup(ctx, tr("Personal bests"), lines.join("\n"), [{ text: tr("Close"), variant: "secondary" }]);
}

// layout (design units of the 1120 x 630 screen)
const MARGIN = 40;
const TOP = 124;
const LEFT_W = 440;
const RIGHT_X = 512;
const RIGHT_W = 1080 - RIGHT_X;
const TILE_GAP = space(2);

export function showLobby(ctx: GameContext, handlers: LobbyHandlers, status?: LobbyStatus): () => void {
	const save = ctx.save;
	const lang = save.settings.langType;
	const tr = (k: string): string => langGet(k, lang);
	const { root, body } = makeScreen(ctx.uiLayer, "Lobby");

	// ---- header: logo + coins
	makeLabel(
		body,
		"Title",
		`PROJECT <font color="${hex(GAME.brand)}">Z</font>`,
		MARGIN,
		22,
		460,
		60,
		TEXT.xl5,
		THEME.foreground,
		{
			font: "display",
			align: "left",
			rich: true,
		},
	);
	makeLabel(body, "Subtitle", tr("Zombie survival"), MARGIN + 2, 80, 400, 22, TEXT.sm, THEME.mutedForeground, {
		align: "left",
	});
	const coins = makeCoinPill(body, "Coins", 850, 28, 230, 52, () => ctx.save.money, handlers.onShop);
	if (status?.loading === true) {
		makeLabel(body, "Loading", tr("Loading your progress..."), 620, 88, 460, 22, TEXT.sm, THEME.mutedForeground, {
			align: "right",
		});
	} else if (status?.offlineNote !== undefined) {
		makeLabel(body, "Offline", status.offlineNote, 560, 88, 520, 22, TEXT.sm, THEME.destructive, {
			align: "right",
		});
	}

	// ---- survivor card (left)
	const card = Card(body, "Survivor", { x: MARGIN, y: TOP, w: LEFT_W, h: 420 });
	const pad = space(6);
	const innerW = LEFT_W - pad * 2;
	const contentY = CardHeader(card, tr("Survivor"));
	const tiles: Array<[string, string, Color3]> = [
		[`${save.day}`, tr("Current day"), THEME.foreground],
		[`${save.bestDay}`, tr("Best day"), THEME.foreground],
		[`${save.level}`, tr("Level"), GAME.xp],
		[fmtInt(save.bossKills), tr("Bosses defeated"), GAME.rare],
	];
	const tileW = (innerW - space(2)) / 2;
	const tileH = 64;
	for (let i = 0; i < tiles.size(); i++) {
		const [value, caption, color] = tiles[i];
		const tile = Card(card, `Tile${i}`, {
			x: pad + (i % 2) * (tileW + space(2)),
			y: contentY + math.floor(i / 2) * (tileH + space(2)),
			w: tileW,
			h: tileH,
			variant: "muted",
		});
		makeLabel(tile, "Value", value, space(3), 6, tileW - space(6), 32, TEXT.xl2, color, {
			font: "numeric",
			align: "left",
		});
		makeLabel(tile, "Caption", caption, space(3), 40, tileW - space(6), 18, TEXT.xs, THEME.mutedForeground, {
			align: "left",
		});
	}
	const expY = contentY + tileH * 2 + space(2) + space(4);
	const expMax = expMaxInit(save.level);
	const exp = Progress(card, "Exp", { x: pad, y: expY, w: innerW, h: 8, color: GAME.xp });
	exp.setRatio(save.exp / math.max(expMax, 1));
	makeLabel(
		card,
		"ExpText",
		`${fmtInt(save.exp)} / ${fmtInt(expMax)} XP`,
		pad,
		expY + 12,
		innerW,
		18,
		TEXT.xs,
		THEME.mutedForeground,
		{
			font: "numeric",
			align: "right",
		},
	);
	const loadoutY = expY + 40;
	Separator(card, "LoadoutRule", { x: pad, y: loadoutY, length: innerW });
	makeLabel(
		card,
		"LoadoutTitle",
		tr("Loadout").upper(),
		pad,
		loadoutY + space(2),
		innerW,
		20,
		TEXT.xs,
		THEME.mutedForeground,
		{
			weight: Enum.FontWeight.SemiBold,
			align: "left",
		},
	);
	// the outfit and the pet are two slots worn at once (MON-04); six rows on a 20 u pitch end where five on 24 did
	const slotKeys = ["Weapon", "Clothes", "Hand", "Gun", "Outfit", "Pet"];
	for (let i = 0; i < slotKeys.size(); i++) {
		const y = loadoutY + space(2) + 24 + i * 20;
		makeLabel(card, `SlotTag${i}`, tr(slotKeys[i]), pad, y, 110, 22, TEXT.sm, THEME.mutedForeground, {
			align: "left",
		});
		const name = equipName(ctx, i);
		makeLabel(
			card,
			`SlotName${i}`,
			name,
			pad + 110,
			y,
			innerW - 110,
			22,
			TEXT.sm,
			name === "—" ? THEME.mutedForeground : THEME.foreground,
			{
				font: fontOf("sans", Enum.FontWeight.Medium),
				align: "left",
			},
		);
	}

	// ---- play (the primary action of the screen) + menu tiles (secondary)
	const pending = totalPendingPacks(save);
	const playTitle = save.runOver ? tr("Game over") : status?.suspended === true ? tr("Continue") : tr("Play");
	let playSub = `${tr("Day")} ${save.day}`;
	if (pending > 0) playSub = `${playSub}  ·  ${tr("Packs")} +${pending}`;
	const play = Button(body, "Play", "", {
		x: RIGHT_X,
		y: TOP,
		w: RIGHT_W,
		h: 160,
		size: "lg",
		variant: "default",
		onClick: (): void => {
			if (!ctx.save.tutorialDone && !ctx.save.runOver) {
				popup(ctx, tr("How to play"), nl(tr("Do you want to#watch the tutorial?")), [
					{
						text: "No",
						variant: "secondary",
						onClick: (): void => {
							ctx.save.tutorialDone = true;
							handlers.onPlay();
						},
					},
					{ text: "Yes", variant: "default", onClick: (): void => handlers.onTutorial(true) },
				]);
			} else {
				handlers.onPlay();
			}
		},
	});
	const playFg = buttonForeground("default");
	// the one green action of the screen: big title over the relief face -- the plate carries the contrast (UI-05)
	makeLabel(play, "PlayTitle", playTitle.upper(), 0, 30, RIGHT_W, 64, TEXT.xl5, playFg, { font: "display" });
	makeLabel(play, "PlaySub", playSub, 0, 100, RIGHT_W, 28, TEXT.lg, playFg, { font: "label" });

	let achDone = 0;
	let achTotal = 0;
	for (const a of ACHIEVEMENTS) {
		if (a.hidden === true) continue;
		achTotal++;
		if ((save.achievements[a.id] ?? 0) >= a.max) achDone++;
	}
	const menu: Array<[string, string, () => void]> = [
		[tr("Shop"), tr("Packs & costumes"), handlers.onShop],
		[tr("Achievements"), `${achDone} / ${achTotal}`, (): void => showAchievements(ctx)],
		[tr("Records"), `${tr("Best day")} ${save.bestDay}`, (): void => showRecords(ctx)],
		[tr("How to play"), "", (): void => handlers.onTutorial(false)],
		[tr("Settings"), "", handlers.onSettings],
		[tr("Credits"), "", (): void => handlers.onCredits?.()],
	];
	const tileFg = buttonForeground("secondary");
	const menuW = (RIGHT_W - TILE_GAP * 2) / 3;
	const menuH = 122;
	const menuY = TOP + 160 + space(4);
	for (let i = 0; i < menu.size(); i++) {
		const [title, sub, fn] = menu[i];
		const x = RIGHT_X + (i % 3) * (menuW + TILE_GAP);
		const y = menuY + math.floor(i / 3) * (menuH + TILE_GAP);
		const b = Button(body, `Menu${i}`, "", { x, y, w: menuW, h: menuH, variant: "secondary", onClick: fn });
		makeLabel(b, "Title", title, space(3), sub === "" ? 44 : 34, menuW - space(6), 30, TEXT.lg, tileFg, {
			font: "label",
		});
		if (sub !== "") {
			makeLabel(b, "Sub", sub, space(3), 66, menuW - space(6), 22, TEXT.sm, tileFg, {
				font: "body",
			});
		}
	}

	// ---- tips ticker
	const ticker = Card(body, "Ticker", { x: MARGIN, y: 562, w: 1040, h: 44, clips: true });
	const tip = new Instance("TextLabel");
	tip.Name = "Tip";
	tip.BackgroundTransparency = 1;
	tip.BackgroundColor3 = THEME.card;
	tip.FontFace = roleFont("body");
	tip.TextColor3 = THEME.mutedForeground;
	tip.TextStrokeColor3 = THEME.background;
	tip.TextXAlignment = Enum.TextXAlignment.Left;
	tip.AutomaticSize = Enum.AutomaticSize.X;
	tip.Size = UDim2.fromScale(0, 1);
	tip.Text = `${shuffledTips()}     •     ${shuffledTips()}`;
	tip.Parent = ticker;
	let tipX = 0;
	const RunService = game.GetService("RunService");
	const conn = RunService.RenderStepped.Connect((dt: number): void => {
		tip.TextSize = math.max(10, math.round(TEXT.sm * uiScale()));
		tipX += 70 * uiScale() * dt;
		const w = tip.AbsoluteSize.X;
		if (w > 10 && tipX > w / 2) tipX -= w / 2;
		tip.Position = new UDim2(0, 20 - tipX, 0, 0);
	});

	const unsubscribe = onWalletChanged(() => coins.refresh());
	autoFocus(play);

	return (): void => {
		unsubscribe();
		conn.Disconnect();
		root.Destroy();
	};
}
