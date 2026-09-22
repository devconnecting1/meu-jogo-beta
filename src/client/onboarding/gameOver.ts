import { GameContext } from "shared/game/context";
import { langGet } from "shared/data/lang";
import { rebirthPrice } from "shared/data/shop";
import { GAME, TEXT, THEME, TRANSPARENCY, space } from "../ui/theme";
import {
	Button,
	CardHeader,
	Card,
	CoinIcon,
	autoFocus,
	fmtInt,
	makeLabel,
	makeScreen,
	makeSurface,
	nl,
} from "../ui/widgets";

/*
 * End of a run, written for the FIRST one.
 *
 * The screen this replaces opened with "Game over" in red over a price tag. For a player who has been alive
 * for eleven minutes that reads as a bill, not as an ending — and the first death is the moment most survival
 * games lose people. So: the run's own numbers first (days, level, kills — proof that something happened),
 * then the two ways forward, then the price. No red title, no "you failed", and New game is never dressed as
 * the dangerous option on a first death, because at that point there is nothing to throw away.
 *
 * Only the presentation lives here. Rebirth, New game and Home are the run lifecycle of main.client.ts and
 * arrive as handlers.
 */

export interface RunSummary {
	/** days survived in the run that just ended */
	days: number;
	/** the player's best run ever */
	bestDay: number;
	level: number;
	/** zombies put down in this run (-1 when the caller does not track it) */
	kills: number;
	/** bosses killed in this run (-1 when unknown) */
	bosses: number;
	/** this is the player's first death */
	first: boolean;
}

export interface RunSummaryHandlers {
	onRebirth?: () => void;
	onNewRun?: () => void;
	onHome?: () => void;
}

const W = 520;
const H = 470;
const PAD = space(6);
const ROW_H = 34;

/** the survivor's epitaph, warmer the further they got */
function closingLine(s: RunSummary): string {
	if (s.days >= s.bestDay && s.bestDay > 1) return "A new record. The town remembers.";
	if (s.days >= 5) return "Five days is more than most.";
	if (s.first) return "Everyone's first night ends this way. The second one goes better.";
	return "The street took it back. Take it again.";
}

/**
 * The end-of-run screen. `showPause(ctx, 2, ...)` in ui/pauseMenu.ts does the same job today; swapping the
 * call in main.client.ts's `openDeath` for this one is the whole integration.
 */
export function showRunSummary(ctx: GameContext, summary: RunSummary, handlers: RunSummaryHandlers): () => void {
	const lang = ctx.save.settings.langType;
	const tr = (key: string): string => langGet(key, lang);
	const { root, body } = makeScreen(ctx.uiLayer, "RunOver", {
		color: THEME.background,
		transparency: TRANSPARENCY.overlay,
		zIndex: 250,
	});
	const panel = Card(body, "Panel", { x: (1120 - W) / 2, y: (630 - H) / 2, w: W, h: H });
	const innerW = W - PAD * 2;
	// the title is the run, not the failure: "You survived N days"
	const title = summary.days === 1 ? tr("You survived a day") : `${tr("You survived")} ${summary.days} ${tr("days")}`;
	let y = CardHeader(panel, title, tr(closingLine(summary)));

	const stats: Array<[string, string, Color3]> = [
		[tr("Days survived"), `${summary.days}`, THEME.foreground],
		[tr("Best day"), `${summary.bestDay}`, summary.days >= summary.bestDay ? GAME.success : THEME.foreground],
		[tr("Level"), `${summary.level}`, GAME.xp],
	];
	if (summary.kills >= 0) stats.push([tr("Zombies killed"), `${summary.kills}`, THEME.foreground]);
	if (summary.bosses > 0) stats.push([tr("Bosses"), `${summary.bosses}`, GAME.rare]);

	const wellH = stats.size() * ROW_H + space(4);
	const well = makeSurface(panel, "Stats", PAD, y, innerW, wellH, "well");
	for (let i = 0; i < stats.size(); i++) {
		const [k, v, color] = stats[i];
		const ry = space(2) + i * ROW_H;
		makeLabel(well, `K${i}`, k, space(3), ry, innerW - 180, ROW_H, TEXT.base, THEME.mutedForeground, {
			align: "left",
			zIndex: 2,
		});
		makeLabel(well, `V${i}`, v, innerW - space(3) - 160, ry, 160, ROW_H, TEXT.xl, color, {
			font: "numeric",
			align: "right",
			zIndex: 2,
		});
	}
	y += wellH + space(4);

	// what the run keeps, said plainly: this is the sentence that stops a first death feeling like a wipe
	makeLabel(
		panel,
		"Kept",
		nl(tr("Your level, skills, coins and packs stay with you.#Only this run's day counter goes back to 1.")),
		PAD,
		y,
		innerW,
		40,
		TEXT.sm,
		THEME.mutedForeground,
		{ align: "left", valign: "top" },
	);
	y += 40 + space(2);

	const price = rebirthPrice(ctx.save.deathCount);
	const canAfford = ctx.save.money >= price;
	CoinIcon(panel, "Coin", PAD, y + 5, 18);
	makeLabel(
		panel,
		"Wallet",
		`${tr("Continue this run")}: ${fmtInt(price)}   ·   ${tr("You have")} ${fmtInt(ctx.save.money)}`,
		PAD + 26,
		y,
		innerW - 26,
		26,
		TEXT.sm,
		canAfford ? THEME.foreground : THEME.mutedForeground,
		{ font: "numeric", align: "left" },
	);
	y += 30;

	/*
	 * Which action is "the" action depends on what the player can actually do. With the coins, continuing the
	 * run is the main (green) one. Without them, the main one is a fresh run — the thing that works — and
	 * Rebirth stays there, outlined and honest about the price instead of red and unaffordable.
	 */
	const rebirth = Button(panel, "Rebirth", `${tr("Rebirth")}  ·  ${fmtInt(price)}`, {
		x: PAD,
		y,
		w: innerW,
		size: "lg",
		variant: canAfford ? "default" : "outline",
		onClick: (): void => handlers.onRebirth?.(),
	});
	y += 56 + space(3);
	const halfW = (innerW - space(3)) / 2;
	const newRun = Button(panel, "NewRun", tr("New game"), {
		x: PAD,
		y,
		w: halfW,
		h: 48,
		// starting over only throws something away once there is a run worth keeping
		variant: canAfford ? "secondary" : "default",
		onClick: (): void => handlers.onNewRun?.(),
	});
	Button(panel, "Home", tr("Home"), {
		x: PAD + halfW + space(3),
		y,
		w: halfW,
		h: 48,
		variant: "secondary",
		onClick: (): void => handlers.onHome?.(),
	});
	autoFocus(canAfford ? rebirth : newRun);

	return (): void => {
		root.Destroy();
	};
}
