/*
 * The Achievements window, opened from the lobby's Achievements plate (docs/DESIGN_RULES.md UI-14, CON-04): a UI-07
 * window with the other windows' chrome ("?" at the left, the red X in relief at the right, B / Backspace = X), a
 * summary, and every achievement on view as a row with its picture, its name, what earns it and how far along it is.
 *
 *   ┌ ? ─────────────────────────── Achievements ──────────────────────────── X ┐
 *   │ ┌──────────────────────────────────────────────────────────────────────┐ │
 *   │ │ [trophy]  Unlocked     [███░░░░░░░░░░░░░░░░░░░░░░░ 6%             ]  │ │  summary
 *   │ │           1 / 18       In progress: 3  ·  Not started: 14            │ │
 *   │ │                        A record of what you did: no coins, no items.  │ │
 *   │ └──────────────────────────────────────────────────────────────────────┘ │
 *   │ ┌ In progress · 3 ─────────────────────────────────────────────────────┐ │
 *   │ │ [zombie] Street Sweeper                  [██░░░░░░░░ 17 / 500     ]  │ │  a row
 *   │ │          Put down zombies, any kind.                                  │ │
 *   │ │ ...                                                                   │ │
 *   │ │ Unlocked · 1                                                          │ │
 *   │ │ [boot]   Arrival                              Unlocked  [medal]      │ │  gold ring
 *   │ │ Not started · 14                                                      │ │
 *   │ │ [bulb]   Lights On  (grey picture)          [         0 / 1       ]  │ │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * - THREE states, never told apart by colour alone: IN PROGRESS (the picture in colour, a steel-blue meter with
 *   "17 / 500"), UNLOCKED (a gold ring, the pixel medal and the word "Unlocked" in gold -- celebratory, and calm: no
 *   glow, no motion), NOT STARTED (a darker row and the picture in grey, the empty meter "0 / 500"). Listed in that
 *   order under a header each: what you are working on first, the closest to done at the top; then what you have; then
 *   what is left.
 * - The meter is the HUD console's bar (window.ts Meter: a plate in relief in the dark groove, the light label on it),
 *   not a thin grey line: the label reads on the fill and on the empty groove alike (test:contrast).
 * - The pictures (achievements.ts `icon`): the item icon that already says the thing (the bow, the wood, the turret),
 *   or one of shared/data/badgeIcons.ts (the zombies, the four bosses, the sunrise), drawn by the Bag's own drawer.
 * - No reward is shown because none is given: an achievement grants no coins, no item and no title (titles are earned
 *   their own way, MON-05). The summary says so in one line, the "?" in full -- nothing invented to fill the space.
 * - A pad walks the rows (each is selectable, the list scrolls to the one in focus) and B / Backspace closes; a row is
 *   information, so it has no hover look and no action.
 * - Built once when it opens (the rows, their pictures and meters); nothing is created while it is open, scrolling
 *   included (UI-09's rule). Closing destroys it all (test:nav: five open / close cycles leave nothing).
 */
import { GameContext } from "shared/game/context";
import { PlayerSaveData } from "shared/game/save";
import { ACHIEVEMENTS, AchievementDef } from "shared/data/achievements";
import { langGet } from "shared/data/lang";
import { IconView, drawIcon } from "./itemIcon";
import { PixelMedal } from "./pixelArt";
import { paintPlate } from "./plate";
import { popup } from "./popup";
import { GAME, SURFACE, TEXT, THEME, TRANSPARENCY, fontOf, space } from "./theme";
import {
	autoFocus,
	centredRect,
	fmtInt,
	isFocused,
	makeFrame,
	makeLabel,
	makeScreen,
	nl,
	registerFocus,
	setDesign,
	setVisible,
	sizeRow,
} from "./widgets";
import * as Kit from "./window";

export type AchievementState = "progress" | "unlocked" | "notStarted";

export interface AchievementEntry {
	def: AchievementDef;
	/** the save's counter, never past the goal */
	cur: number;
	state: AchievementState;
}

/** where an achievement stands in `save` */
export function achievementEntry(save: PlayerSaveData, def: AchievementDef): AchievementEntry {
	const cur = math.clamp(save.achievements[def.id] ?? 0, 0, def.max);
	const state: AchievementState = cur >= def.max ? "unlocked" : cur > 0 ? "progress" : "notStarted";
	return { def, cur, state };
}

/**
 * Every achievement on view (hidden ones out: CON-03 / CON-04), in the window's order: in progress (closest to done
 * first), unlocked, not started -- each group in the data's order when tied.
 */
export function achievementList(save: PlayerSaveData): Array<AchievementEntry> {
	const out: Array<AchievementEntry> = [];
	for (const def of ACHIEVEMENTS) if (def.hidden !== true) out.push(achievementEntry(save, def));
	const group = (e: AchievementEntry): number => (e.state === "progress" ? 0 : e.state === "unlocked" ? 1 : 2);
	const ratio = (e: AchievementEntry): number => e.cur / math.max(e.def.max, 1);
	out.sort((a, b) => {
		const ga = group(a);
		const gb = group(b);
		if (ga !== gb) return ga < gb;
		if (ga === 0 && ratio(a) !== ratio(b)) return ratio(a) > ratio(b);
		return a.def.id < b.def.id;
	});
	return out;
}

/** [unlocked, on view]: the lobby plate's "1 / 18" and the summary's */
export function achievementCounts(save: PlayerSaveData): [number, number] {
	let done = 0;
	let total = 0;
	for (const def of ACHIEVEMENTS) {
		if (def.hidden === true) continue;
		total++;
		if ((save.achievements[def.id] ?? 0) >= def.max) done++;
	}
	return [done, total];
}

// ---------------------------------------------------------------- layout (1120 x 630 design units)

const WIN_W = 760;
const WIN_H = 590;
const PAD = space(6);
const INNER_W = WIN_W - PAD * 2;
const SUMMARY_H = 100;
/** the summary's trophy and its "Unlocked / 1 / 18" block */
const TROPHY = 60;
const COUNT_W = 170;
const LIST_GAP = space(3);
const ROW_H = 68;
const HEAD_H = 28;
/** the picture's socket and the picture in it */
const SOCKET = 52;
const SOCKET_X = 10;
const ICON = 44;
const TEXT_X = SOCKET_X + SOCKET + 14;
/** the right column: the meter, or "Unlocked" and the medal */
const METER_W = 210;
const METER_H = 28;
const MEDAL = 40;

const BOLD = fontOf("sans", Enum.FontWeight.Bold);
const EXTRA_BOLD = fontOf("sans", Enum.FontWeight.ExtraBold);

/** the "?" of the window ("#" = new line) */
const HELP_TEXT = [
	"Achievements count what you do in the city. The server keeps the count, as you play.",
	"In progress comes first, the closest to done at the top; then what you have unlocked; then what is left.",
	"They are a record of what you did: they give no coins and no items. Titles are earned their own way, in the Wardrobe.",
].join("#");

interface Row {
	entry: AchievementEntry;
	button: TextButton;
	icon: IconView;
	meter: Kit.MeterHandle;
	medal: Frame;
	unlocked: TextLabel;
}

/** paints a row from its state and the pad's focus: the ring is gold when unlocked, the focus ring on focus */
function paintRow(r: Row): void {
	const state = r.entry.state;
	const face = state === "notStarted" ? SURFACE.well : SURFACE.row;
	let ring = state === "unlocked" ? GAME.medal : SURFACE.line;
	if (isFocused(r.button)) ring = THEME.ring;
	paintPlate(r.button, face, "outline", 3, ring);
}

/** the Achievements window over the lobby; returns what closes it */
export function showAchievements(ctx: GameContext): () => void {
	const lang = ctx.save.settings.langType;
	const tr = (k: string): string => langGet(k, lang);
	const save = ctx.save;
	const rect = centredRect(WIN_W, WIN_H);
	// over the lobby's menu, which stays open behind it: the menus' own scrim dims that page, as Records does. Under the
	// kit's popup (300), so its "?" opens on top of it
	const { root, body } = makeScreen(ctx.uiLayer, "Achievements", {
		color: THEME.background,
		transparency: TRANSPARENCY.overlay,
		zIndex: 290,
		content: rect,
	});
	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		root.Destroy();
	};
	const win = Kit.Window(body, "Window", {
		...rect,
		title: tr("Achievements"),
		onClose: close,
		onHelp: (): void => {
			popup(ctx, tr("Achievements"), nl(tr(HELP_TEXT)), [{ text: tr("Close"), variant: "secondary" }]);
		},
	});
	const panel = win.frame;
	const entries = achievementList(save);
	const [done, total] = achievementCounts(save);
	let inProgress = 0;
	let notStarted = 0;
	for (const e of entries) {
		if (e.state === "progress") inProgress++;
		else if (e.state === "notStarted") notStarted++;
	}

	// ---- the summary: how many are unlocked, as a number and as the meter, and what is going on with the rest
	const top = win.contentY;
	const summary = Kit.Section(panel, "Summary", { x: PAD, y: top, w: INNER_W, h: SUMMARY_H });
	const sz = summary.frame.ZIndex + 1;
	const trophy = IconView(summary.frame, "Trophy", space(4), (SUMMARY_H - TROPHY) / 2, TROPHY, sz, 0, "drawn");
	drawIcon(trophy, "badge_trophy");
	const countX = space(4) + TROPHY + space(4);
	makeLabel(summary.frame, "UnlockedLabel", tr("Unlocked"), countX, 14, COUNT_W, 20, TEXT.base, SURFACE.cellCaption, {
		font: BOLD,
		align: "left",
		zIndex: sz,
	});
	makeLabel(summary.frame, "Count", `${done} / ${total}`, countX, 38, COUNT_W, 44, TEXT.xl3, THEME.foreground, {
		font: EXTRA_BOLD,
		align: "left",
		zIndex: sz,
	});
	const meterX = countX + COUNT_W + space(3);
	const meterW = INNER_W - meterX - space(5);
	const overall = Kit.Meter(summary.frame, "Overall", {
		x: meterX,
		y: 14,
		w: meterW,
		h: METER_H,
		face: THEME.primary,
		zIndex: sz,
	});
	const pct = math.floor((done / math.max(total, 1)) * 100 + 0.5);
	overall.set(done / math.max(total, 1), `${pct}%`);
	makeLabel(
		summary.frame,
		"Breakdown",
		`${tr("In progress")}: ${inProgress}   ·   ${tr("Not started")}: ${notStarted}`,
		meterX,
		14 + METER_H + 8,
		meterW,
		20,
		TEXT.sm,
		THEME.foreground,
		{ align: "left", zIndex: sz },
	);
	makeLabel(
		summary.frame,
		"Reward",
		tr("No coins or items: a record of what you did."),
		meterX,
		14 + METER_H + 30,
		meterW,
		18,
		TEXT.sm,
		SURFACE.cellCaption,
		{ align: "left", zIndex: sz },
	);

	// ---- the list: a header per group, a row per achievement, in the dark bed
	const listY = top + SUMMARY_H + LIST_GAP;
	const listH = WIN_H - listY - space(5);
	const list = Kit.SettingsList(panel, "List", PAD, listY, INNER_W, listH);
	const rows: Array<Row> = [];
	let order = 0;
	const header = (name: string, text: string): void => {
		const h = makeFrame(list.frame, name, 0, 0, list.designW, HEAD_H, THEME.background, { transparency: 1 });
		h.LayoutOrder = order++;
		sizeRow(list, h, HEAD_H);
		makeLabel(h, "Text", text, space(2), 4, list.designW - space(4), HEAD_H - 6, TEXT.base, THEME.foreground, {
			font: BOLD,
			align: "left",
			valign: "bottom",
		});
	};
	const groups: Array<[AchievementState, string, number]> = [
		["progress", "In progress", inProgress],
		["unlocked", "Unlocked", done],
		["notStarted", "Not started", notStarted],
	];
	const rowW = list.designW;
	const meterRight = rowW - space(4);
	for (const [state, title, count] of groups) {
		if (count === 0) continue;
		header(`Head${state}`, `${tr(title)}  ·  ${count}`);
		for (const e of entries) {
			if (e.state !== state) continue;
			const def = e.def;
			const b = new Instance("TextButton");
			b.Name = `Ach${def.id}`;
			b.AutoButtonColor = false;
			b.BorderSizePixel = 0;
			b.BackgroundTransparency = 1;
			b.BackgroundColor3 = THEME.background;
			b.Text = "";
			b.TextColor3 = THEME.foreground;
			b.Selectable = true;
			b.LayoutOrder = order++;
			setDesign(b, rowW, ROW_H);
			sizeRow(list, b, ROW_H);
			b.Parent = list.frame;
			const z = b.ZIndex + 1;
			// the picture, in its dark socket: in colour once started, grey before
			const socket = makeFrame(b, "Socket", SOCKET_X, (ROW_H - SOCKET) / 2, SOCKET, SOCKET, THEME.background, {
				transparency: 1,
				zIndex: z,
			});
			paintPlate(socket, SURFACE.groove, "flat", 2);
			const icon = IconView(socket, "Icon", (SOCKET - ICON) / 2, (SOCKET - ICON) / 2, ICON, z + 1, 0, "drawn");
			drawIcon(icon, def.icon, { dim: state === "notStarted" });
			const textW = rowW - TEXT_X - METER_W - space(8);
			const name = makeLabel(b, "Name", tr(def.title), TEXT_X, 12, textW, 22, TEXT.lg, THEME.foreground, {
				font: BOLD,
				align: "left",
				zIndex: z,
			});
			const how = makeLabel(b, "HowTo", tr(def.howTo), TEXT_X, 38, textW, 18, TEXT.sm, THEME.mutedForeground, {
				align: "left",
				zIndex: z,
			});
			for (const l of [name, how]) {
				l.TextWrapped = false;
				l.TextTruncate = Enum.TextTruncate.AtEnd;
			}
			// the right column: the meter while it is being earned; "Unlocked" and the medal once it is
			const meter = Kit.Meter(b, "Meter", {
				x: meterRight - METER_W,
				y: (ROW_H - METER_H) / 2,
				w: METER_W,
				h: METER_H,
				face: THEME.primary,
				zIndex: z,
			});
			meter.set(e.cur / math.max(def.max, 1), `${fmtInt(e.cur)} / ${fmtInt(def.max)}`);
			const medal = PixelMedal(b, "Medal", meterRight - MEDAL / 2, ROW_H / 2, MEDAL, z + 1).frame;
			const unlocked = makeLabel(
				b,
				"Unlocked",
				tr("Unlocked"),
				meterRight - METER_W,
				0,
				METER_W - MEDAL - space(3),
				ROW_H,
				TEXT.lg,
				GAME.medal,
				{ font: BOLD, align: "right", zIndex: z },
			);
			const isDone = state === "unlocked";
			setVisible(meter.frame, !isDone);
			setVisible(medal, isDone);
			setVisible(unlocked, isDone);
			const row: Row = { entry: e, button: b, icon, meter, medal, unlocked };
			registerFocus(b, () => paintRow(row));
			paintRow(row);
			rows.push(row);
		}
	}
	// the pad walks the rows top to bottom (the list scrolls to the one in focus); the headers are not stops. The X goes
	// down into the list, and up from the first row comes back to it
	for (let i = 0; i < rows.size(); i++) {
		const b = rows[i].button;
		b.NextSelectionUp = i > 0 ? rows[i - 1].button : win.close;
		b.NextSelectionDown = i < rows.size() - 1 ? rows[i + 1].button : undefined;
	}
	const first = rows[0];
	if (win.close !== undefined && first !== undefined) win.close.NextSelectionDown = first.button;
	if (first !== undefined) autoFocus(first.button);
	else if (win.close !== undefined) autoFocus(win.close);
	return close;
}
