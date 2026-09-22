import { GameContext } from "shared/game/context";
import { langGet } from "shared/data/lang";
import { rebirthPrice } from "shared/data/shop";
import { TEXT, THEME, TRANSPARENCY, space } from "./theme";
import {
	Badge,
	Button,
	ButtonVariant,
	Card,
	CoinIcon,
	Separator,
	autoFocus,
	fmtInt,
	makeLabel,
	makeScreen,
	nl,
} from "./widgets";

export interface PauseHandlers {
	onResume?: () => void;
	onSave?: () => void;
	onHome?: () => void;
	onShop?: () => void;
	onSettings?: () => void;
	onRebirth?: () => void;
	onNewRun?: () => void;
}

export interface PauseInfo {
	/** small note under the buttons (e.g. why saving is off) */
	note?: string;
}

const GAME_OVER_W = 460;
const GAME_OVER_H = 420;
const PAUSE_W = 360;
const PAUSE_H = 450;

/** kind 0 = pause menu, kind 2 = game over; both are cards over a scrim */
export function showPause(ctx: GameContext, kind: number, handlers: PauseHandlers, info?: PauseInfo): () => void {
	const lang = ctx.save.settings.langType;
	const tr = (key: string): string => langGet(key, lang);
	const { root, body } = makeScreen(ctx.uiLayer, "Pause", {
		color: THEME.background,
		transparency: TRANSPARENCY.overlay,
		zIndex: 250,
	});
	const pad = space(6);

	if (kind === 2) {
		const w = GAME_OVER_W;
		const innerW = w - pad * 2;
		const panel = Card(body, "Panel", { x: (1120 - w) / 2, y: (630 - GAME_OVER_H) / 2, w, h: GAME_OVER_H });
		makeLabel(panel, "Title", tr("Game over"), pad, pad, innerW, 44, TEXT.xl3, THEME.destructive, {
			font: "title",
		});
		Separator(panel, "Rule", { x: pad, y: pad + 52, length: innerW });
		const save = ctx.save;
		const stats: Array<[string, string]> = [
			[tr("Survival days"), `${save.day}`],
			[tr("Best day"), `${save.bestDay}`],
			[tr("Level"), `${save.level}`],
		];
		const statsY = pad + 64;
		for (let i = 0; i < stats.size(); i++) {
			const [k, v] = stats[i];
			const y = statsY + i * 30;
			makeLabel(panel, `Stat${i}K`, k, pad, y, 260, 26, TEXT.base, THEME.mutedForeground, { align: "left" });
			makeLabel(panel, `Stat${i}V`, v, w - pad - 140, y, 140, 26, TEXT.base, THEME.foreground, {
				font: "numeric",
				align: "right",
			});
		}
		// rebirth: coin price vs wallet
		const price = rebirthPrice(save.deathCount);
		const canAfford = save.money >= price;
		const walletY = statsY + 3 * 30 + space(2);
		CoinIcon(panel, "Coin", pad, walletY + 4, 18);
		makeLabel(
			panel,
			"Wallet",
			`${tr("Continue price")}: ${fmtInt(price)}   ·   ${fmtInt(save.money)}`,
			pad + 26,
			walletY,
			innerW - 26,
			26,
			TEXT.sm,
			canAfford ? THEME.foreground : THEME.destructive,
			{ font: "numeric", align: "left" },
		);
		// the primary action is Rebirth when affordable; without coins it is shown as destructive (can't pay)
		const rebirthY = walletY + 40;
		const rebirth = Button(panel, "Rebirth", `${tr("Rebirth")}  ·  ${fmtInt(price)}`, {
			x: pad,
			y: rebirthY,
			w: innerW,
			size: "lg",
			variant: canAfford ? "default" : "destructive",
			onClick: (): void => handlers.onRebirth?.(),
		});
		const rowY = rebirthY + 56 + space(3);
		const halfW = (innerW - space(3)) / 2;
		const newRun = Button(panel, "NewRun", tr("New game"), {
			x: pad,
			y: rowY,
			w: halfW,
			variant: "destructive",
			onClick: (): void => handlers.onNewRun?.(),
		});
		Button(panel, "Home", tr("Home"), {
			x: pad + halfW + space(3),
			y: rowY,
			w: halfW,
			variant: "secondary",
			onClick: (): void => handlers.onHome?.(),
		});
		makeLabel(
			panel,
			"Hint",
			nl(
				tr(
					"Rebirth to continue this run, or start a new game from day 1.#Level, skills, coins and packs are kept.",
				),
			),
			pad,
			rowY + 44 + space(3),
			innerW,
			44,
			TEXT.xs,
			THEME.mutedForeground,
		);
		autoFocus(canAfford ? rebirth : newRun);
	} else {
		const w = PAUSE_W;
		const innerW = w - pad * 2;
		const panel = Card(body, "Panel", { x: (1120 - w) / 2, y: (630 - PAUSE_H) / 2, w, h: PAUSE_H });
		makeLabel(panel, "Title", tr("Paused"), pad, pad, innerW - 40, 40, TEXT.xl3, THEME.cardForeground, {
			font: "title",
			align: "left",
		});
		Badge(panel, "KeyHint", "P", { x: w - pad - 28, y: pad + 9, w: 28, variant: "outline" });
		const items: Array<{ key: string; fn: (() => void) | undefined; variant: ButtonVariant }> = [
			{ key: "Resume", fn: handlers.onResume, variant: "default" },
			{ key: "Save", fn: handlers.onSave, variant: "secondary" },
			{ key: "Shop", fn: handlers.onShop, variant: "secondary" },
			{ key: "Settings", fn: handlers.onSettings, variant: "secondary" },
			{ key: "Home", fn: handlers.onHome, variant: "secondary" },
		];
		let first: TextButton | undefined;
		for (let i = 0; i < items.size(); i++) {
			const item = items[i];
			const fn = item.fn;
			const b = Button(panel, `Btn${i}`, tr(item.key), {
				x: pad,
				y: pad + 56 + i * (48 + space(3)),
				w: innerW,
				h: 48,
				variant: item.variant,
				onClick: (): void => {
					if (fn !== undefined) fn();
				},
			});
			if (i === 0) first = b;
		}
		if (info?.note !== undefined) {
			makeLabel(panel, "Note", info.note, pad, PAUSE_H - pad - 32, innerW, 32, TEXT.xs, THEME.mutedForeground);
		}
		if (first !== undefined) autoFocus(first);
	}

	return (): void => {
		root.Destroy();
	};
}
