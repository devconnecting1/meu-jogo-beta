import { GameContext } from "shared/game/context";
import { langGet } from "shared/data/lang";
import { rebirthPrice } from "shared/data/shop";
import { NIGHT_REAL_SECONDS } from "shared/sim/clock";
import { inputDevice } from "../ui/device";
import { PixelIcon, PixelIconKind } from "../ui/pixelIcon";
import { paintPlate } from "../ui/plate";
import { popup } from "../ui/popup";
import { GAME, STAT, SURFACE, TEXT, THEME, TRANSPARENCY, fontOf, space } from "../ui/theme";
import { Groove, Section, Window } from "../ui/window";
import {
	Badge,
	Button,
	ButtonVariant,
	CoinIcon,
	Separator,
	autoFocus,
	buttonForeground,
	cardHeaderHeight,
	centredRect,
	fixedTextPx,
	fmtInt,
	makeFrame,
	makeLabel,
	makeScreen,
	setButtonEnabled,
	setVisible,
	uiScale,
} from "../ui/widgets";

/*
 * The death screen (docs/DESIGN_RULES.md UI-13, MP-21, MP-22): what happened, what happens next, what you can do
 * about it, and -- quietly, last -- what the life added up to.
 *
 * The owner's verdict on the screen this replaces (2026-09-24, "Falta melhorar o design disso"): a title that
 * congratulated a survivor who had just died ("You survived a day"), a table of numbers in colours that meant
 * nothing (a green best day that was no record, a blue level), a daybreak count that was a lie on a server with
 * nobody else standing (the town ends 30 s later, MP-22), a "Rebirth · 10" in a flat dark box that did not look
 * pressable and did not say 10 of WHAT, and two flat grey buttons that read as disabled -- three boxes of the same
 * weight and no main action.
 *
 *   ┌──────────────── Dead until dawn ─────────────────┐   1. what happened: the title says the STATE, the line
 *   │   Everyone's first night ends this way. ...      │      under it the epitaph (the onboarding line on a first
 *   │ ┌──────────────────────────────────────────────┐ │      death, "New best" on a record)
 *   │ │      .  .  ☾  .  .  .  .  .  .  .  .        ☀ │ │   2. what happens next, the HERO: the night as the HUD's
 *   │ │ ─────────────────────────────────────────────│ │      sky draws it (hudSky.ts), the moon on its way to the
 *   │ │                 Daybreak in                   │ │      sunrise, and the count in the numbers' yellow, the
 *   │ │                   3:17                        │ │      biggest thing on the panel
 *   │ │  2 survivors still standing. You wake at ...  │ │
 *   │ └──────────────────────────────────────────────┘ │
 *   │ ┌ Life day 1 │ Best day 1 │ Level 1 │ Zombies 11 ┐ │   4. the life, a compact strip (values in STAT.value)
 *   │ Rebirth wakes you now, at full health, ...       │   3. the choice: what Rebirth does and costs, then the row
 *   │ [⌂ Home]  [↻ New game]  [♥ Rebirth now   ($) 10] │      -- Home (iron), New game (red, asks first), Rebirth
 *   └──────────────────────────────────────────────────┘      (steel blue, the one main action) at the right
 *
 * THE STATES, each told apart on screen because each ends differently (server/sim/life.ts is the truth):
 *
 *   over    `showRunSummary`: nobody will stand you up (offline, or a session whose server never drove the clock --
 *           and the fallback once the session is gone). "You died"; the hero is the day the life ended on.
 *   dawn    `showDaybreakWait` with somebody still standing in town (or no roster to ask): "Dead until dawn", the
 *           count to 06:00 (a death in daylight waits one whole night: "You wake in"), and who is still up.
 *   falls   `showDaybreakWait` with NOBODY else standing -- solo, always: "Nobody is left standing". The world waits
 *           WORLD_WIPE_S for somebody to pay a Rebirth, then ends, and everyone who fell starts a new life in a new
 *           town at day 1 (MP-22). The count is that window, in red: it is estimated here from the moment the roster
 *           emptied, so if it runs out and no new town comes (a living survivor the roster cannot see, in the lobby),
 *           the screen goes back to the daybreak count after WIPE_GRACE_S.
 *   + newLife: a New game the server accepted, waiting for first light -- "New life at first light", no second New
 *           game (MP-21).
 *
 * Rebirth is the one main action when it can be paid, and says what it costs in coins with the coin; when it cannot,
 * it is disabled and the line above it says how many coins are missing -- never a red button that fails when pressed.
 * New game is red and asks first: it is a new LIFE (day 1, the starter kit). Home is the iron plate. The pad lands on
 * Rebirth when it can be paid; otherwise on Home in a wait (waiting needs no press) and on New game when the run is
 * over. B / Backspace does nothing here (backStack.ts: the screen asks for a decision); Start and LB still reach the
 * game, as from every menu, and mean nothing to a dead survivor. No key cap is drawn: no key of this screen does
 * anything but move the focus.
 *
 * Built once. `setRemaining` runs every frame (main.client.ts `updateDawnWait`) and writes only what changed -- the
 * count once a second, the moon every few seconds, the state when somebody stands up or falls, the Rebirth plate when
 * the coins change -- and creates no Instance (test:screens section 7). Nothing here pauses anything (UI-06): the town
 * keeps going behind the see-through scrim.
 *
 * Only the presentation lives here. Rebirth, New game, Home and the revive itself are the run lifecycle of
 * main.client.ts (and, for the revive, server/sim/life.ts) and arrive as handlers; who is still standing arrives as a
 * function (client/onboarding/index.ts reads the server's roster).
 */

export interface RunSummary {
	/** this life's day when it ended (MP-13) */
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
	/** this life went past the best day the player had when it began ("New best!") */
	record?: boolean;
}

export interface RunSummaryHandlers {
	onRebirth?: () => void;
	onNewRun?: () => void;
	onHome?: () => void;
}

/**
 * MP-22: once the last survivor standing falls, how long the world waits for somebody to pay a Rebirth before it ends
 * (seconds). The server's number is server/sim/life.ts WIPE_DECISION_S, which the client cannot import; test:nav pins
 * the two equal.
 */
export const WORLD_WIPE_S = 30;
/** the town's fall ran out on this screen's estimate and no new town came: how long "Any moment now" is believed */
const WIPE_GRACE_S = 10;

/**
 * M:SS of a real-seconds countdown; never negative, because "-0:01 to dawn" reads as a broken clock. The lobby's
 * Survivor screen and the HUD's sky count the same way (client/ui/survivor.ts, client/ui/hudSky.ts).
 */
export function countdown(seconds: number): string {
	const total = math.max(0, math.ceil(seconds));
	return string.format("%d:%02d", math.floor(total / 60), total % 60);
}

// ---------------------------------------------------------------- layout (design units of the window)

const W = 640;
const PAD = space(6);
const INNER = W - PAD * 2;
const TITLE_SIZE = TEXT.xl3;
const GAP = space(3);
/** the epitaph under the header */
const SUB_H = 20;
/** section -> groove inset of the hero (the HUD sky's body -> section -> groove) */
const INSET = 8;
const SKY_W = INNER - INSET * 2;
const SKY_H = 180;
const HERO_H = SKY_H + INSET * 2;
const STRIP_INSET = 6;
const STRIP_W = INNER - STRIP_INSET * 2;
const STRIP_H = 52;
const STATS_H = STRIP_H + STRIP_INSET * 2;
/** two lines of TEXT.sm */
const NOTE_H = 40;
/** the action row; on touch 80 units, so a button is a thumb (>= 44 px) even at a phone's 0,57 px per unit */
const ACTION_H = 64;
const ACTION_H_TOUCH = 80;
/** Home | New game | Rebirth; without New game, Home and the rest */
const HOME_W = 124;
const NEW_W = 168;
/** the price at the right of the Rebirth plate: the coin and up to "1,010" in the numeric role */
const COIN = 20;
const PRICE_W = 60;

/** the sky in the groove: the arc from nightfall (left) to daybreak (right), the horizon under it */
const ARC_CX = SKY_W / 2;
const ARC_HY = 64;
const ARC_RX = 236;
const ARC_RY = 44;
const DOTS = 33;
const DOT = 3;
const MOON = 18;
const SUN = 24;
const GRAVE = 34;
/** the three lines under the horizon */
const LABEL_Y = 68;
const LABEL_H = 20;
const NUMBER_Y = 86;
const NUMBER_H = 54;
const CAPTION_Y = 140;
const CAPTION_H = 36;

const BOLD = fontOf("sans", Enum.FontWeight.Bold);

type Mode = "over" | "dawn" | "falls";

/** the survivor's epitaph, warmer the further they got; the onboarding line on a first death */
function epitaph(s: RunSummary): string {
	if (s.first) return "Everyone's first night ends this way. The second one goes better.";
	if (s.record === true) return "A new record. The town remembers.";
	if (s.days >= 5) return "Five days is more than most.";
	return "The street took it back. Take it again.";
}

/** the arc's point at share `f` of the night: the left horizon at 0, the top at 0,5, the right horizon at 1 */
function arcAt(f: number): [number, number] {
	const a = math.pi * math.clamp(f, 0, 1);
	return [ARC_CX - ARC_RX * math.cos(a), ARC_HY - ARC_RY * math.sin(a)];
}

/**
 * An icon and a Bold title on a kit button, the lobby's plates (lobby.ts): `variant` gives them the plate's light.
 * `w` is the room the title may take. Returns the icon (a disabled plate greys it).
 */
function dress(
	b: TextButton,
	icon: PixelIconKind,
	title: string,
	w: number,
	h: number,
	variant: ButtonVariant,
): PixelIcon {
	const fg = buttonForeground(variant);
	const z = b.ZIndex + 1;
	const glyph = PixelIcon(b, "Icon", icon, 22, h / 2, 20, fg, z);
	makeLabel(b, "Name", title, 40, 0, w - 48, h, TEXT.lg, fg, { font: BOLD, align: "left", zIndex: z });
	return glyph;
}

/** characters of `s` (a translation may not be ASCII) */
function chars(s: string): number {
	const [n] = utf8.len(s);
	return typeIs(n, "number") ? n : s.size();
}

/** the first descendant of `root` named `name` that is a GuiObject (a popup's button, to put the pad on it) */
function findGui(root: Instance, name: string): GuiObject | undefined {
	for (const d of root.GetDescendants()) if (d.Name === name && d.IsA("GuiObject")) return d;
	return undefined;
}

/** the screen both endings share, in one of its modes; `refresh` is its per-frame half */
interface DeathScreen {
	refresh(seconds: number, night: boolean): void;
	close(): void;
}

function buildDeathScreen(
	ctx: GameContext,
	summary: RunSummary,
	handlers: RunSummaryHandlers,
	waiting: boolean,
	newLife: boolean,
	standing: (() => number | undefined) | undefined,
): DeathScreen {
	const lang = ctx.save.settings.langType;
	const tr = (key: string): string => langGet(key, lang);
	const actionH = inputDevice() === "touch" ? ACTION_H_TOUCH : ACTION_H;
	const top = cardHeaderHeight(TITLE_SIZE);
	// the epitaph takes a second line only where it needs one: at a phone's 9 px floor TEXT.sm is drawn bigger than
	// its design size, and the first death's line no longer fits the window's width
	const epitaphText = tr(epitaph(summary));
	const subSize = math.max(TEXT.sm, fixedTextPx(TEXT.sm) / uiScale());
	const subH = chars(epitaphText) * subSize * 0.62 > INNER ? math.ceil(subSize * 2.5) + 4 : SUB_H;
	const heroY = top + subH + space(2);
	const statsY = heroY + HERO_H + GAP;
	const noteY = statsY + STATS_H + GAP;
	const rowY = noteY + NOTE_H + space(2.5);
	const h = rowY + actionH + PAD;

	const rect = centredRect(W, h);
	const { root, body } = makeScreen(ctx.uiLayer, "RunOver", {
		color: THEME.background,
		// over the run (UI-06): the town keeps going behind, dimmed and in sight, never a page that hides it
		transparency: TRANSPARENCY.overWorld,
		zIndex: 250,
		content: rect,
	});
	const win = Window(body, "Window", { ...rect, title: "", titleSize: TITLE_SIZE }).frame;
	const titleLabel = win.FindFirstChild("Title") as TextLabel;
	const z = win.ZIndex + 1;

	// ---- 1. what happened: the epitaph under the state
	makeLabel(win, "Epitaph", epitaphText, PAD, top, INNER, subH, TEXT.sm, THEME.mutedForeground, {
		zIndex: z,
	});

	// ---- 2. what happens next: the night in the HUD sky's language, and the count
	const hero = Section(win, "Hero", { x: PAD, y: heroY, w: INNER, h: HERO_H, zIndex: z }).frame;
	const sky = Groove(hero, "Sky", INSET, INSET, SKY_W, SKY_H);
	sky.ZIndex = hero.ZIndex + 1;
	const sz = sky.ZIndex + 1;
	makeFrame(sky, "Horizon", 16, ARC_HY - 1, SKY_W - 32, 2, SURFACE.line, { zIndex: sz });
	const dots: Array<Frame> = [];
	for (let i = 0; i < DOTS; i++) {
		const [x, y] = arcAt(i / (DOTS - 1));
		dots.push(makeFrame(sky, `Dot${i + 1}`, x - DOT / 2, y - DOT / 2, DOT, DOT, SURFACE.line, { zIndex: sz }));
	}
	// first light: the sun waiting on the right end of the horizon; the moon on its way there
	const sun = PixelIcon(sky, "Sun", "sun", ARC_CX + ARC_RX, ARC_HY, SUN, GAME.sun, sz + 1).frame;
	const moon = PixelIcon(sky, "Moon", "moon", ARC_CX - ARC_RX, ARC_HY, MOON, GAME.moon, sz + 2).frame;
	// a life that ended stands on the horizon as a gravestone: grey when nobody wakes you, red when the town falls
	const grave = PixelIcon(sky, "Grave", "grave", ARC_CX, ARC_HY - GRAVE / 2, GRAVE, THEME.mutedForeground, sz + 1);
	const label = makeLabel(sky, "Lead", "", 0, LABEL_Y, SKY_W, LABEL_H, TEXT.base, THEME.foreground, {
		font: BOLD,
		zIndex: sz,
	});
	const number = makeLabel(sky, "Count", "", 0, NUMBER_Y, SKY_W, NUMBER_H, TEXT.xl5, STAT.value, {
		font: "numeric",
		zIndex: sz,
	});
	const caption = makeLabel(
		sky,
		"Caption",
		"",
		space(4),
		CAPTION_Y,
		SKY_W - space(8),
		CAPTION_H,
		TEXT.sm,
		THEME.mutedForeground,
		{
			zIndex: sz,
		},
	);

	// ---- 4. the life, a compact strip: what the numbers are, in the numbers' yellow (UI-08); green only for a record
	const stats: Array<[string, string, boolean]> = [
		["Life day", fmtInt(summary.days), false],
		["Best day", fmtInt(summary.bestDay), summary.record === true],
		["Level", fmtInt(summary.level), false],
	];
	if (summary.kills >= 0) stats.push(["Zombies killed", fmtInt(summary.kills), false]);
	if (summary.bosses > 0) stats.push(["Bosses", fmtInt(summary.bosses), false]);
	const statsSection = Section(win, "Stats", { x: PAD, y: statsY, w: INNER, h: STATS_H, zIndex: z }).frame;
	const strip = Groove(statsSection, "Strip", STRIP_INSET, STRIP_INSET, STRIP_W, STRIP_H);
	strip.ZIndex = statsSection.ZIndex + 1;
	// each cell as wide as what it holds, at the size the text will really be drawn (on a phone the 9 px floor makes
	// TEXT.xs bigger than its design size), and the rest shared evenly: "Zombies killed" and a record's badge get
	// their room instead of being squeezed into a quarter
	const xs = math.max(TEXT.xs, fixedTextPx(TEXT.xs) / uiScale());
	const newBest = tr("New best!");
	const badgeW = chars(newBest) * xs * 0.66 + space(4);
	const needs: Array<number> = [];
	let needed = 0;
	for (const [key, value, best] of stats) {
		const label = chars(tr(key)) * xs * 0.62;
		const shown = value.size() * TEXT.xl * 0.62 + (best ? space(2) + badgeW : 0);
		const need = math.max(label, shown) + space(5);
		needs.push(need);
		needed += need;
	}
	const spare = (STRIP_W - needed) / stats.size();
	let x0 = 0;
	for (let i = 0; i < stats.size(); i++) {
		const [key, value, best] = stats[i];
		const cellW = spare >= 0 ? needs[i] + spare : STRIP_W / stats.size();
		if (i > 0) Separator(strip, `Rule${i}`, { x: x0, y: 8, length: STRIP_H - 16, vertical: true, zIndex: sz });
		makeLabel(
			strip,
			`Key${i + 1}`,
			tr(key),
			x0 + space(3),
			5,
			cellW - space(4),
			16,
			TEXT.xs,
			THEME.mutedForeground,
			{
				align: "left",
				zIndex: sz,
			},
		);
		const color = best ? STAT.bonus : STAT.value;
		makeLabel(strip, `Value${i + 1}`, value, x0 + space(3), 21, cellW - space(4), 26, TEXT.xl, color, {
			font: "numeric",
			align: "left",
			zIndex: sz,
		});
		// the record, said in words next to the number (a badge of the kit, outlined in the bonus green)
		const bx = x0 + space(3) + value.size() * TEXT.xl * 0.62 + space(2);
		if (best && bx + badgeW <= x0 + cellW - space(1)) {
			Badge(strip, "NewBest", newBest, { x: bx, y: 25, w: badgeW, h: 18, color: STAT.bonus, zIndex: sz });
		}
		x0 += cellW;
	}

	// ---- 3. the choice: what Rebirth does and costs, then the row -- Home, New game, Rebirth (the main action last)
	const note = makeLabel(win, "Note", "", PAD, noteY, INNER, NOTE_H, TEXT.sm, THEME.mutedForeground, {
		align: "left",
		zIndex: z,
	});
	const onNewRun = handlers.onNewRun;
	const onRebirth = handlers.onRebirth;
	const withNew = onNewRun !== undefined;
	const home = Button(win, "Home", "", {
		x: PAD,
		y: rowY,
		w: HOME_W,
		h: actionH,
		variant: "secondary",
		zIndex: z,
		onClick: (): void => handlers.onHome?.(),
	});
	dress(home, "home", tr("Home"), HOME_W, actionH, "secondary");

	let confirm: Frame | undefined;
	let newGame: TextButton | undefined;
	let mode: Mode = waiting ? "dawn" : "over";
	if (onNewRun !== undefined) {
		newGame = Button(win, "NewGame", "", {
			x: PAD + HOME_W + GAP,
			y: rowY,
			w: NEW_W,
			h: actionH,
			variant: "destructive",
			zIndex: z,
			onClick: (): void => {
				// a new LIFE -- day 1 and the starter kit -- is not undone: it asks first (UI-12), in the consequence's words
				let body = tr(
					"Day 1 and the starter kit. Level, skills, coins and packs stay; this life's backpack does not.",
				);
				const falls = tr("Nobody else is standing: this town ends now and a new one begins.");
				if (mode === "falls") body = `${body}\n${falls}`;
				else if (mode === "dawn") body = `${body}\n${tr("It wakes at first light.")}`;
				confirm = popup(ctx, tr("Start a new life?"), body, [
					{ text: tr("Cancel"), variant: "secondary" },
					{ text: tr("New game"), variant: "destructive", onClick: onNewRun },
				]);
				// the pad lands on Cancel: two presses of A must never throw a life away (B dismisses it, unanswered)
				const cancel = findGui(confirm, "PopupBtn0");
				if (cancel !== undefined) autoFocus(cancel);
			},
		});
		dress(newGame, "restart", tr("New game"), NEW_W, actionH, "destructive");
	}

	const price = rebirthPrice(ctx.save.deathCount);
	let rebirth: TextButton | undefined;
	let rebirthIcon: PixelIcon | undefined;
	let priceLabel: TextLabel | undefined;
	if (onRebirth !== undefined) {
		const x = PAD + HOME_W + GAP + (withNew ? NEW_W + GAP : 0);
		const w = W - PAD - x;
		rebirth = Button(win, "Rebirth", "", {
			x,
			y: rowY,
			w,
			h: actionH,
			variant: "default",
			zIndex: z,
			onClick: (): void => onRebirth(),
		});
		rebirthIcon = dress(rebirth, "heart", tr("Rebirth now"), w - PRICE_W - COIN - space(6), actionH, "default");
		// the price, in what it is paid with: the round pixel coin (MON-06), then the number -- on the dark price chip
		// every coin amount sits on (the Shop's Earn coins, the wardrobe's tiles): orange straight on the steel-blue
		// plate would all but vanish (1.4:1)
		const px = w - space(4) - PRICE_W;
		const chipX = px - space(1.5) - COIN - space(2);
		const chipH = COIN + space(3);
		const chip = makeFrame(
			rebirth,
			"PriceChip",
			chipX,
			(actionH - chipH) / 2,
			w - space(2) - chipX,
			chipH,
			THEME.background,
			{
				transparency: 1,
				zIndex: rebirth.ZIndex + 1,
			},
		);
		paintPlate(chip, SURFACE.well, "flat", 2);
		CoinIcon(rebirth, "Coin", px - space(1.5) - COIN, (actionH - COIN) / 2, COIN, rebirth.ZIndex + 2);
		priceLabel = makeLabel(rebirth, "Price", fmtInt(price), px, 0, PRICE_W, actionH, TEXT.lg, THEME.foreground, {
			font: "numeric",
			align: "left",
			zIndex: rebirth.ZIndex + 2,
		});
	}

	// ---- the per-frame half: writes only what changed
	let shownMode: Mode | undefined;
	let shownTitle = "";
	let shownLabel = "";
	let shownNumber = "";
	let shownCaption = "";
	let shownNote = "";
	let affordable: boolean | undefined;
	let moonX = math.huge;
	let moonY = math.huge;
	let passed = -1;
	/** os.clock() when the town's fall is estimated to come (MP-22), while nobody else is standing */
	let wipeAt: number | undefined;
	/** what the last frame was drawn from (see the early exit in `refresh`) */
	let lastTick = math.huge;
	let lastNight: boolean | undefined;
	let lastOthers: number | undefined;
	let lastMoney = -1;

	const write = (l: TextLabel, text: string, last: string): string => {
		if (text !== last) l.Text = text;
		return text;
	};

	const refresh = (seconds: number, night: boolean): void => {
		if (root.Parent === undefined) return;
		// who is still up decides what the wait ends in: first light, or the town's fall (MP-22)
		let others: number | undefined;
		if (waiting && standing !== undefined) others = standing();
		if (waiting && others === 0) {
			if (wipeAt === undefined) wipeAt = os.clock() + WORLD_WIPE_S;
		} else {
			wipeAt = undefined;
		}
		const wipeLeft = wipeAt !== undefined ? wipeAt - os.clock() : undefined;
		mode = !waiting ? "over" : wipeLeft !== undefined && wipeLeft > -WIPE_GRACE_S ? "falls" : "dawn";
		// a frame that shows what the last one showed makes no string at all: the count moves once a second (and the
		// moon with it), the rest when somebody stands up or falls, night turns to day, or the coins change
		const tick = mode === "falls" ? math.ceil(wipeLeft ?? 0) : math.ceil(seconds);
		const money = ctx.save.money;
		if (
			mode === shownMode &&
			tick === lastTick &&
			night === lastNight &&
			others === lastOthers &&
			money === lastMoney
		) {
			return;
		}
		lastTick = tick;
		lastNight = night;
		lastOthers = others;
		lastMoney = money;

		if (mode !== shownMode) {
			shownMode = mode;
			const dawn = mode === "dawn";
			for (const d of dots) setVisible(d, dawn);
			setVisible(sun, dawn);
			setVisible(moon, dawn);
			setVisible(grave.frame, !dawn);
			grave.setColor(mode === "falls" ? STAT.penalty : THEME.mutedForeground);
			number.TextColor3 = mode === "falls" ? STAT.penalty : STAT.value;
			passed = -1;
		}
		let title = tr("Dead until dawn");
		if (mode === "over") title = tr("You died");
		else if (mode === "falls") title = tr("Nobody is left standing");
		else if (newLife) title = tr("New life at first light");
		shownTitle = write(titleLabel, title, shownTitle);

		// the hero: the label, the number, the caption
		let key: string;
		let value: string;
		const lines: Array<string> = [];
		if (mode === "over") {
			key = tr("This life ended on");
			value = `${tr("Day")} ${fmtInt(summary.days)}`;
			lines.push(
				tr(
					withNew
						? "Nobody wakes you here. Rebirth continues this life; New game starts a new one at day 1."
						: "Nobody wakes you here. Rebirth continues this life.",
				),
			);
		} else if (mode === "falls") {
			const left = math.max(0, wipeLeft ?? 0);
			key = left > 0 ? tr("Town falls in") : tr("Any moment now");
			value = countdown(left);
			lines.push(tr("No Rebirth in time: a new town begins at day 1, with a new life for everyone who fell."));
		} else {
			// (a negative count: not told yet -- the frame before the run loop's first `setRemaining`)
			key = seconds === 0 ? tr("Any moment now") : night ? tr("Daybreak in") : tr("You wake in");
			value = seconds < 0 ? "" : countdown(seconds);
			if (others !== undefined && others > 0) {
				lines.push(
					`${fmtInt(others)} ${tr(others === 1 ? "survivor still standing." : "survivors still standing.")}`,
				);
			}
			if (newLife) lines.push(tr("Your new life starts at day 1."));
			if (night) lines.push(tr("You wake at first light."));
			// the moon on the night's arc: the share of a night gone by, in the real seconds the wait is counted in (a
			// death in daylight waits one whole night, so it starts at nightfall's end of the arc)
			const f = seconds < 0 ? 0 : math.clamp(1 - seconds / NIGHT_REAL_SECONDS, 0, 1);
			const [ax, ay] = arcAt(f);
			const qx = math.round(ax);
			const qy = math.round(ay);
			if (qx !== moonX || qy !== moonY) {
				moonX = qx;
				moonY = qy;
				moon.Position = UDim2.fromScale(qx / SKY_W, qy / SKY_H);
			}
			const done = math.floor(f * (DOTS - 1) + 1e-6);
			if (done !== passed) {
				passed = done;
				for (let i = 0; i < DOTS; i++) {
					const c = i < done ? SURFACE.section : SURFACE.line;
					if (dots[i].BackgroundColor3 !== c) dots[i].BackgroundColor3 = c;
				}
			}
		}
		shownLabel = write(label, key, shownLabel);
		shownNumber = write(number, value, shownNumber);
		shownCaption = write(caption, lines.join(" "), shownCaption);

		// the Rebirth plate and its line: pressable only when it can be paid, and the line says why not
		const can = money >= price;
		if (rebirth !== undefined && can !== affordable) {
			affordable = can;
			setButtonEnabled(rebirth, can);
			rebirthIcon?.setColor(can ? buttonForeground("default") : THEME.mutedForeground);
			if (priceLabel !== undefined) priceLabel.TextColor3 = can ? THEME.foreground : THEME.mutedForeground;
		}
		let text = "";
		if (rebirth !== undefined) {
			const wallet = can
				? `${tr("You have")} ${fmtInt(money)} ${tr("coins")}. ${tr("Each Rebirth costs more than the last.")}`
				: `${tr("Not enough coins")}: ${fmtInt(price - money)} ${tr("more needed")}. ${tr("You have")} ${fmtInt(money)} ${tr("coins")}.`;
			text = `${tr("Rebirth wakes you now, at full health, with your backpack.")}\n${wallet}`;
		}
		shownNote = write(note, text, shownNote);
	};

	refresh(-1, true);
	// the pad's first stop: the action that works -- Rebirth when it can be paid; else, in a wait, Home (waiting needs no
	// press); else New game, the only way on
	const payable = rebirth !== undefined && ctx.save.money >= price;
	autoFocus(payable && rebirth !== undefined ? rebirth : waiting || newGame === undefined ? home : newGame);

	return {
		refresh(seconds: number, night: boolean): void {
			refresh(seconds, night);
		},
		close(): void {
			confirm?.Destroy();
			confirm = undefined;
			root.Destroy();
		},
	};
}

/**
 * The end of a run with nobody to stand you up (the "over" state above): the single-player build, a session whose
 * server never drove the clock, and the fallback once a wait's session is gone (main.client.ts `updateDawnWait`).
 * Returns the close.
 */
export function showRunSummary(ctx: GameContext, summary: RunSummary, handlers: RunSummaryHandlers): () => void {
	const screen = buildDeathScreen(ctx, summary, handlers, false, false, undefined);
	return (): void => screen.close();
}

/** the daybreak screen, while it is on screen */
export interface DaybreakWait {
	/**
	 * Real seconds still to wait; the run loop refreshes it every frame off the world clock. `night` (default true):
	 * the wait ends at daybreak; false for a death in daylight, whose wait is one whole night (MP-21) and ends in
	 * daylight.
	 */
	setRemaining(seconds: number, night?: boolean): void;
	close(): void;
}

/**
 * MP-21: died where the server stands its dead back up -- the "dawn" and "falls" states above. The run is not over:
 * the night is, and it ends at 06:00 (~3,6 real minutes end to end) unless nobody else is standing, and then the town
 * ends in WORLD_WIPE_S unless somebody pays (MP-22). "New game" is still here for a survivor who would rather start a
 * new life; that life waits for daybreak too, so once it is chosen (`newLife`) the button goes and the title says
 * whose wait it is now.
 *
 * `standing` (client/onboarding/index.ts passes the server's roster): the OTHER survivors in town still up, alive or
 * bleeding out; undefined when there is no roster to ask, and then the screen promises the daybreak.
 */
export function showDaybreakWait(
	ctx: GameContext,
	summary: RunSummary,
	handlers: RunSummaryHandlers,
	newLife = false,
	standing?: () => number | undefined,
): DaybreakWait {
	const screen = buildDeathScreen(ctx, summary, handlers, true, newLife, standing);
	return {
		setRemaining(seconds: number, night = true): void {
			screen.refresh(seconds, night);
		},
		close(): void {
			screen.close();
		},
	};
}
