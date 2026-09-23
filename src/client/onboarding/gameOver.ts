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
 * TWO ENDINGS:
 *
 *   `showRunSummary`     nobody will stand you up (the single-player build, or a session whose server never
 *                        drove the clock): Rebirth · N coins, or New game.
 *   `showDaybreakWait`   a server that revives at daybreak — every server kind from MP_PHASE 2 (MP-21 as the
 *                        owner rewrote it on 23 Sep 2026). The ending is a wait: the screen keeps the town
 *                        visible behind it and counts the REAL seconds down to 06:00, when the server puts the
 *                        survivor back on the street; Rebirth buys the rest of the night off with coins. A wait
 *                        with no number on it is indistinguishable from a frozen game, which is why the count is
 *                        the biggest thing on the panel.
 *
 * Only the presentation lives here. Rebirth, New game, Home and the revive itself are the run lifecycle of
 * main.client.ts (and, for the revive, server/sim/life.ts) and arrive as handlers.
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
const H_WAIT = 486;
/** the daybreak panel with its Rebirth row (a 56 px button and its gap) */
const H_WAIT_REBIRTH = H_WAIT + 56 + space(3);
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
 * M:SS of a real-seconds countdown; never negative, because "-0:01 to dawn" reads as a broken clock. The lobby's
 * Survivor screen counts the same way (client/ui/survivor.ts).
 */
export function countdown(seconds: number): string {
	const total = math.max(0, math.ceil(seconds));
	return string.format("%d:%02d", math.floor(total / 60), total % 60);
}

/**
 * The half of the panel both endings share: the title, the epitaph and the well of numbers. Returns the y
 * the caller carries on from, so the two screens can never drift apart on what a run "was".
 */
function summaryHead(panel: Frame, summary: RunSummary, tr: (key: string) => string): number {
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
	return y + wellH + space(4);
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
		// over the run: the town keeps going behind this screen too (UI-06), so it is dimmed, not hidden
		transparency: TRANSPARENCY.overWorld,
		zIndex: 250,
	});
	const panel = Card(body, "Panel", { x: (1120 - W) / 2, y: (630 - H) / 2, w: W, h: H });
	const innerW = W - PAD * 2;
	let y = summaryHead(panel, summary, tr);

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

/** the daybreak screen, while it is on screen */
export interface DaybreakWait {
	/** real seconds still to wait; the run loop refreshes it every frame off the world clock */
	setRemaining(seconds: number): void;
	close(): void;
}

/**
 * MP-21: died where the server stands its dead back up. The run is not over: the night is, and the night ends
 * at 06:00 (~3.6 real minutes end to end), so the survivor waits it out and the server puts them back on the
 * street.
 *
 * Two deliberate differences from the screen above. The overlay is lighter, because the point is that the
 * town keeps going without you and you are meant to watch it. And the biggest thing on the panel is a
 * running count, not a button: a wait the player cannot measure is a wait they read as a crash.
 *
 * Rebirth (when a handler is given) buys the rest of the night off with coins — legal on every server kind
 * since the owner's rule of 23 Sep 2026 — so it sits under the count, outlined, never louder than the wait.
 * "New game" is still here for a survivor who would rather start a new life; that life waits for daybreak too,
 * so once it is chosen (`newLife`) the button goes and the panel says whose wait it is now. Either way the panel
 * says what really happens (MP-21, MP-22): you wake at first light — unless nobody is left standing, and then the
 * town falls and a new one begins at day 1.
 */
export function showDaybreakWait(
	ctx: GameContext,
	summary: RunSummary,
	handlers: RunSummaryHandlers,
	newLife = false,
): DaybreakWait {
	const lang = ctx.save.settings.langType;
	const tr = (key: string): string => langGet(key, lang);
	const { root, body } = makeScreen(ctx.uiLayer, "RunOver", {
		color: THEME.background,
		// the world behind this one is the whole message: the same see-through scrim as every screen over a
		// run (UI-06), and since UI-06 the town behind it really moves -- the loop no longer stops for a death
		transparency: TRANSPARENCY.overWorld,
		zIndex: 250,
	});
	const withRebirth = handlers.onRebirth !== undefined;
	const h = withRebirth ? H_WAIT_REBIRTH : H_WAIT;
	const panel = Card(body, "Panel", { x: (1120 - W) / 2, y: (630 - h) / 2, w: W, h });
	const innerW = W - PAD * 2;
	let y = summaryHead(panel, summary, tr);

	makeLabel(
		panel,
		"Wait",
		nl(
			tr(
				newLife
					? "Your new life wakes at first light.#If nobody is left standing, a new town begins at day 1."
					: "You wake at first light.#If nobody is left standing, a new town begins at day 1.",
			),
		),
		PAD,
		y,
		innerW,
		44,
		TEXT.sm,
		THEME.mutedForeground,
		{ align: "left", valign: "top" },
	);
	y += 44 + space(2);

	// the count itself: label on the left, the seconds in the numeric role on the right, in a well so it
	// reads as a readout and not as a disabled button
	const clockH = 64;
	const clockWell = makeSurface(panel, "Dawn", PAD, y, innerW, clockH, "well");
	makeLabel(clockWell, "DawnKey", tr("Daybreak in"), space(3), 0, innerW - 200, clockH, TEXT.base, GAME.sun, {
		align: "left",
		zIndex: 2,
	});
	const remaining = makeLabel(
		clockWell,
		"DawnValue",
		countdown(0),
		innerW - space(3) - 180,
		0,
		180,
		clockH,
		TEXT.xl3,
		THEME.foreground,
		{ font: "numeric", align: "right", zIndex: 2 },
	);
	y += clockH + space(4);

	if (withRebirth) {
		const price = rebirthPrice(ctx.save.deathCount);
		Button(panel, "Rebirth", `${tr("Rebirth")}  ·  ${fmtInt(price)}`, {
			x: PAD,
			y,
			w: innerW,
			size: "lg",
			// the wait is free and it is the default: paying to skip it is offered, never pushed
			variant: "outline",
			onClick: (): void => handlers.onRebirth?.(),
		});
		y += 56 + space(3);
	}

	const halfW = (innerW - space(3)) / 2;
	// no handler: the new life is already chosen and waiting, and Home takes the whole row
	const onNewRun = handlers.onNewRun;
	const newRun =
		onNewRun !== undefined
			? Button(panel, "NewRun", tr("New game"), {
					x: PAD,
					y,
					w: halfW,
					h: 48,
					// waiting is the default, so starting over is the one that throws this life away
					variant: "secondary",
					onClick: (): void => onNewRun(),
				})
			: undefined;
	const home = Button(panel, "Home", tr("Home"), {
		x: newRun !== undefined ? PAD + halfW + space(3) : PAD,
		y,
		w: newRun !== undefined ? halfW : innerW,
		h: 48,
		variant: "secondary",
		onClick: (): void => handlers.onHome?.(),
	});
	autoFocus(newRun ?? home);

	let shown = "";
	return {
		setRemaining(seconds: number): void {
			const text = countdown(seconds);
			// the panel is refreshed every frame and the text only moves once a second
			if (text === shown || remaining.Parent === undefined) return;
			shown = text;
			remaining.Text = text;
		},
		close(): void {
			root.Destroy();
		},
	};
}
