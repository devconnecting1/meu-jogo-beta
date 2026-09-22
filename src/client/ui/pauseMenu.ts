import { GameContext } from "shared/game/context";
import { langGet } from "shared/data/lang";
import { rebirthPrice } from "shared/data/shop";
import { FONTS, PALETTE, fmtInt, makeButton, makeFrame, makeLabel, makePanel, makeScreen, nl } from "./widgets";

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

/** kind 0 = pause menu, kind 2 = game over */
export function showPause(ctx: GameContext, kind: number, handlers: PauseHandlers, info?: PauseInfo): () => void {
	const lang = ctx.save.settings.langType;
	const tr = (key: string): string => langGet(key, lang);
	const { root, body } = makeScreen(ctx.uiLayer, "Pause", {
		color: PALETTE.overlay,
		transparency: kind === 2 ? 0.3 : 0.45,
		zIndex: 250,
	});

	if (kind === 2) {
		const panel = makePanel(body, "Panel", 330, 90, 460, 450);
		makeLabel(panel, "Title", tr("Game over"), 32, 26, 396, 48, 34, PALETTE.danger, { font: FONTS.display });
		makeFrame(panel, "Rule", 32, 82, 396, 2, PALETTE.danger, { transparency: 0.5 });
		const save = ctx.save;
		const stats: Array<[string, string]> = [
			[tr("Survival days"), `${save.day}`],
			[tr("Best day"), `${save.bestDay}`],
			[tr("Level"), `${save.level}`],
		];
		for (let i = 0; i < stats.size(); i++) {
			const [k, v] = stats[i];
			makeLabel(panel, `Stat${i}K`, k, 48, 100 + i * 32, 240, 28, 17, PALETTE.textDim, { align: "left" });
			makeLabel(panel, `Stat${i}V`, v, 288, 100 + i * 32, 124, 28, 18, PALETTE.text, {
				align: "right",
				font: FONTS.bold,
			});
		}
		const price = rebirthPrice(save.deathCount);
		const canAfford = save.money >= price;
		makeLabel(
			panel,
			"Wallet",
			`${tr("Continue price")}: ${fmtInt(price)}   ·   $ ${fmtInt(save.money)}`,
			32,
			204,
			396,
			26,
			16,
			canAfford ? PALETTE.coin : PALETTE.textMuted,
		);
		makeButton(
			panel,
			"Rebirth",
			`${tr("Rebirth")}  ·  ${fmtInt(price)}`,
			48,
			244,
			364,
			56,
			canAfford ? "primary" : "secondary",
			(): void => handlers.onRebirth?.(),
			{ textSize: 20 },
		);
		makeButton(panel, "NewRun", tr("New game"), 48, 312, 176, 50, "secondary", (): void => handlers.onNewRun?.());
		makeButton(panel, "Home", tr("Home"), 236, 312, 176, 50, "ghost", (): void => handlers.onHome?.());
		makeLabel(
			panel,
			"Hint",
			nl(
				tr(
					"Rebirth to continue this run, or start a new game from day 1.#Level, skills, coins and packs are kept.",
				),
			),
			32,
			374,
			396,
			56,
			13,
			PALETTE.textMuted,
		);
	} else {
		const panel = makePanel(body, "Panel", 380, 100, 360, 440);
		makeLabel(panel, "Title", tr("Paused"), 28, 22, 304, 46, 32, PALETTE.text, { font: FONTS.display });
		makeLabel(panel, "KeyHint", "P", 296, 30, 36, 28, 14, PALETTE.textMuted, { font: FONTS.bold });
		const items: Array<{ key: string; fn: (() => void) | undefined; style: "primary" | "secondary" | "ghost" }> = [
			{ key: "Resume", fn: handlers.onResume, style: "primary" },
			{ key: "Save", fn: handlers.onSave, style: "secondary" },
			{ key: "Shop", fn: handlers.onShop, style: "secondary" },
			{ key: "Settings", fn: handlers.onSettings, style: "secondary" },
			{ key: "Home", fn: handlers.onHome, style: "ghost" },
		];
		for (let i = 0; i < items.size(); i++) {
			const item = items[i];
			const fn = item.fn;
			makeButton(panel, `Btn${i}`, tr(item.key), 40, 84 + i * 62, 280, 52, item.style, (): void => {
				if (fn !== undefined) fn();
			});
		}
		if (info?.note !== undefined) {
			makeLabel(panel, "Note", info.note, 28, 396, 304, 32, 13, PALETTE.textMuted);
		}
	}

	return (): void => {
		root.Destroy();
	};
}
