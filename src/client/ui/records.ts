/*
 * The Records window, opened from the lobby's Records plate (docs/DESIGN_RULES.md UI-10, UI-12): the personal bests
 * as a SIMPLE table (client/ui/table.ts) in a UI-07 window -- a label and a number per row, the numbers in the
 * numeric voice and right-aligned, so they line up down the column.
 *
 *   ┌────────────────────────── Records ───────────────────────── X ┐
 *   │ ┌ All time ─────────────────────────────────────────────────┐ │
 *   │ │ Best day                                               12 │ │
 *   │ │ Level                                                   7 │ │
 *   │ │ Zombies put down                                      137 │ │
 *   │ │ Bosses defeated                                         2 │ │
 *   │ │ Titles earned                                       2 / 3 │ │
 *   │ └───────────────────────────────────────────────────────────┘ │
 *   │ ┌ This life ────────────────────────────────────────────────┐ │
 *   │ │ Life day                                                3 │ │
 *   │ │ Nights survived in this life                            2 │ │
 *   │ │ Rebirths                                                1 │ │
 *   │ └───────────────────────────────────────────────────────────┘ │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * ONLY what the game really keeps (`recordRows` is the list, and test:tables pins it):
 *   - Best day (`bestDay`), Level, and this life's day (`day`) -- the Survivor screen's Stats say the same (MP-13);
 *   - Zombies put down (`zombieKills`): the killing blows the SERVER credited, lifetime (MON-05's counter, the one
 *     Horde Breaker is earned on) -- server-owned, so the number here is the server's;
 *   - Bosses defeated (`bossKills`): the bosses the server credited to this survivor -- every participant of a kill
 *     (MP-15), never a machine's last blow alone (ELE-04). The bosses ARE in the game (CON-03, decided 2026-09-24:
 *     they wake at their plazas from day 5 and drop the only Flamethrower and Plastic armor, ITM-05), so the record
 *     shows them;
 *   - Titles earned: the titles the server granted, of the ones there are (MON-05);
 *   - Nights survived in this life (`lifeNights`): the midnights the server credited to this life (MP-13's count,
 *     Week One's progress) -- which can be fewer than the days, since a night spent AFK or away is not credited;
 *   - Rebirths (`deathCount`): the continues bought in this life (it is what the next one's price grows with).
 * NOT here: achievements (their own window), anything a client counts on its own.
 */
import { GameContext } from "shared/game/context";
import { PlayerSaveData, ownsTitle } from "shared/game/save";
import { TITLES } from "shared/data/titles";
import { langGet } from "shared/data/lang";
import { TEXT, THEME, TRANSPARENCY } from "./theme";
import { Table, TableCell, TABLE_GAP, TABLE_PAD } from "./table";
import { autoFocus, cardHeaderHeight, centredRect, fmtInt, makeScreen } from "./widgets";
import * as Kit from "./window";

export type RecordGroup = "allTime" | "thisLife";

export interface RecordRow {
	/** stable key (test:tables pins the list) */
	key: string;
	/** the lang key of its label */
	label: string;
	value: string;
	group: RecordGroup;
}

/** the records a save really holds, in the order the window shows them */
export function recordRows(save: PlayerSaveData): Array<RecordRow> {
	let titles = 0;
	for (const t of TITLES) if (ownsTitle(save, t.id)) titles++;
	return [
		{ key: "bestDay", label: "Best day", value: fmtInt(save.bestDay), group: "allTime" },
		{ key: "level", label: "Level", value: fmtInt(save.level), group: "allTime" },
		{ key: "zombieKills", label: "Zombies put down", value: fmtInt(save.zombieKills), group: "allTime" },
		{ key: "bossKills", label: "Bosses defeated", value: fmtInt(save.bossKills), group: "allTime" },
		{ key: "titles", label: "Titles earned", value: `${titles} / ${TITLES.size()}`, group: "allTime" },
		{ key: "lifeDay", label: "Life day", value: fmtInt(save.day), group: "thisLife" },
		{ key: "lifeNights", label: "Nights survived in this life", value: fmtInt(save.lifeNights), group: "thisLife" },
		{ key: "rebirths", label: "Rebirths", value: fmtInt(save.deathCount), group: "thisLife" },
	];
}

const WIN_W = 560;
const PAD = 24;
const ROW_H = 34;
const VALUE_W = 140;
const SECTION_GAP = 12;

function tableHeight(n: number): number {
	return TABLE_PAD * 2 + n * ROW_H + math.max(0, n - 1) * TABLE_GAP;
}

/** the Records window over the lobby; returns what closes it */
export function showRecords(ctx: GameContext): () => void {
	const lang = ctx.save.settings.langType;
	const tr = (k: string): string => langGet(k, lang);
	const rows = recordRows(ctx.save);
	const groups: Array<[RecordGroup, string]> = [
		["allTime", "All time"],
		["thisLife", "This life"],
	];
	// the height follows the rows: a section never stands empty under its list (UI-07)
	let contentH = 0;
	for (const [g] of groups) contentH += Kit.sectionHeight(tableHeight(rows.filter(r => r.group === g).size()));
	contentH += SECTION_GAP * (groups.size() - 1);
	// where a UI-07 window's content starts (its header band, the big title): the kit's own number
	const winH = cardHeaderHeight(TEXT.xl3) + contentH + PAD;
	const rect = centredRect(WIN_W, winH);
	// over the lobby's menu, which stays open behind it: the menus' own scrim dims that page (as the popup it replaced
	// did); centred on the FULL screen like every UI-07 window (makeScreen's content rect, test:screens)
	const { root, body } = makeScreen(ctx.uiLayer, "Records", {
		color: THEME.background,
		transparency: TRANSPARENCY.overlay,
		zIndex: 300,
		content: rect,
	});
	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		root.Destroy();
	};
	const win = Kit.Window(body, "Window", {
		x: rect.x,
		y: rect.y,
		w: WIN_W,
		h: winH,
		title: tr("Records"),
		onClose: close,
	});
	const cell = (row: RecordRow, column: string, out: TableCell): void => {
		if (column === "label") out.text = tr(row.label);
		else out.text = row.value;
	};
	let y = win.contentY;
	for (const [g, title] of groups) {
		const list = rows.filter(r => r.group === g);
		const th = tableHeight(list.size());
		const sh = Kit.sectionHeight(th);
		const section = Kit.Section(win.frame, `Section${g}`, {
			x: PAD,
			y,
			w: WIN_W - PAD * 2,
			h: sh,
			title: tr(title),
		});
		const t = Table<RecordRow>(section.frame, "Table", {
			x: 16,
			y: section.contentY,
			w: WIN_W - PAD * 2 - 32,
			h: th,
			header: "none",
			rowH: ROW_H,
			textSize: TEXT.base,
			columns: [
				{ key: "label", header: tr("Record"), flex: 1 },
				{ key: "value", header: "", width: VALUE_W, numeric: true },
			],
			keyOf: r => r.key,
			cell,
			zIndex: section.frame.ZIndex + 1,
		});
		t.setItems(list);
		y += sh + SECTION_GAP;
	}
	if (win.close !== undefined) autoFocus(win.close);
	return close;
}
