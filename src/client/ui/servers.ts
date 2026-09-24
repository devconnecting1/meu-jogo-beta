/*
 * The lobby's SERVERS window and the keeper's "Restart town" question (docs/DESIGN_RULES.md MP-26, UI-07, UI-12).
 *
 *   ┌─────────────────────────── Servers ──────────────────────────── X ┐
 *   │ ┌ Public towns ───────────────────────────────────────────────────┐ │
 *   │ │ Town                          Day      Players      Status      │ │
 *   │ │ Brackenmere                     6        3 / 6      Open        │ │
 *   │ │ Ploverstead                    11        2 / 6      Open        │ │
 *   │ │ Wrenvale                        4        6 / 6      Full        │ │
 *   │ └─────────────────────────────────────────────────────────────────┘ │
 *   │ 3 towns open                                  [Refresh]  [ Join ]  │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * A DATA table of UI-12: select a row, then Join -- no per-row buttons, the pad's A selects and the Join beside the
 * table acts. The rows come from the SERVER (client/net/townNet.ts), already in its order: not full first, then the
 * day closest to this player's best day. What the server did not publish is not shown: no ping (a player's ping is
 * to the server they are on, never to another one) and no region (no engine API tells a game server where it is).
 *
 * The join is the server's decision (server/match/serverList.ts): the window says what it answered, and a teleport
 * the platform refused later (TeleportInitFailed) arrives as a notice that lands on the status line.
 */
import { GameContext } from "shared/game/context";
import { townNameOf } from "shared/data/townNames";
import { langGet } from "shared/data/lang";
import { ServerRow, TownRefusal } from "shared/net/townNet";
import { onJoinFailed, townRequestAsync } from "../net/townNet";
import { popup, toast } from "./popup";
import { TEXT, THEME, TRANSPARENCY, space } from "./theme";
import { Table, TableCell, TABLE_GAP, TABLE_PAD } from "./table";
import { Button, autoFocus, cardHeaderHeight, centredRect, makeLabel, makeScreen, setButtonEnabled } from "./widgets";
import * as Kit from "./window";

const WIN_W = 680;
const PAD = 24;
const ROW_H = 40;
const HEADER_H = 26;
/** rows the table shows without scrolling */
const ROWS_SHOWN = 6;
const TABLE_H = TABLE_PAD * 2 + HEADER_H + TABLE_GAP + ROWS_SHOWN * ROW_H + (ROWS_SHOWN - 1) * TABLE_GAP;
const FOOT_H = 44;
const JOIN_W = 150;
/** a trip that has neither left nor failed this long after the server sent it gives the list back (s) */
export const TRAVEL_TIMEOUT_S = 30;
const REFRESH_W = 140;

/** what the window says for each refusal (shared/net/townNet.ts TownRefusal) */
export function refusalText(reason: TownRefusal | undefined): string {
	if (reason === "studio") return "The server list works in the published game, not in Studio";
	if (reason === "unavailable") return "The server list is unavailable right now";
	if (reason === "rate") return "Too many requests. Try again in a moment";
	if (reason === "full") return "That town is full";
	if (reason === "gone") return "That town is no longer open";
	if (reason === "same") return "You are already in that town";
	if (reason === "inWorld") return "Leave the city before joining another town";
	if (reason === "busy") return "A join is already under way";
	if (reason === "loading") return "Your progress is still loading";
	if (reason === "dead") return "Choose Rebirth, the wait or New game first.";
	if (reason === "danger") {
		return "Your survivor is still in danger where you left the city. Get clear of the zombies first, or wait a little";
	}
	if (reason === "trip") return "Already on the way to your town...";
	if (reason === "forbidden") return "Only this server's owner can restart the town";
	return "Something went wrong. Try again";
}

export interface ServersWindow {
	readonly close: () => void;
	/** asks the server for the list again (the Refresh button) */
	readonly refresh: () => void;
	/** the rows shown (for the tests) */
	readonly rows: () => ReadonlyArray<ServerRow>;
}

/** the Servers window over the lobby */
export function showServers(ctx: GameContext): ServersWindow {
	const lang = ctx.save.settings.langType;
	const tr = (k: string): string => langGet(k, lang);
	const sectionH = Kit.sectionHeight(TABLE_H);
	const winH = cardHeaderHeight(TEXT.xl3) + sectionH + space(3) + FOOT_H + PAD;
	const rect = centredRect(WIN_W, winH);
	const { root, body } = makeScreen(ctx.uiLayer, "Servers", {
		color: THEME.background,
		transparency: TRANSPARENCY.overlay,
		zIndex: 300,
		content: rect,
	});
	let closed = false;
	let loading = false;
	let joining = false;
	/** the join under way (a number bumped by every start and end: late answers of an older one are ignored) */
	let trip = 0;
	let rows: Array<ServerRow> = [];
	let unsubscribe: (() => void) | undefined;
	// assigned below, once the table and the buttons they touch exist (the callbacks only run after that)
	let updateJoin = (): void => {};
	let load = (): void => {};
	let doJoin = (): void => {};
	const close = (): void => {
		if (closed) return;
		closed = true;
		unsubscribe?.();
		root.Destroy();
	};
	const win = Kit.Window(body, "Window", {
		x: rect.x,
		y: rect.y,
		w: WIN_W,
		h: winH,
		title: tr("Servers"),
		onClose: close,
	});
	const section = Kit.Section(win.frame, "Towns", {
		x: PAD,
		y: win.contentY,
		w: WIN_W - PAD * 2,
		h: sectionH,
		title: tr("Public towns"),
	});
	const full = (r: ServerRow): boolean => r.players >= r.max;
	const cell = (r: ServerRow, column: string, out: TableCell): void => {
		if (column === "town") {
			out.text = townNameOf(r.seed);
		} else if (column === "day") {
			out.text = tostring(r.day);
		} else if (column === "players") {
			out.text = `${r.players} / ${r.max}`;
		} else {
			out.text = full(r) ? tr("Full") : tr("Open");
			out.color = full(r) ? THEME.mutedForeground : THEME.foreground;
		}
	};
	const footY = win.contentY + sectionH + space(3);
	const status = makeLabel(
		win.frame,
		"Status",
		"",
		PAD,
		footY,
		WIN_W - PAD * 2 - JOIN_W - REFRESH_W - space(4),
		FOOT_H,
		TEXT.sm,
		THEME.mutedForeground,
		{
			align: "left",
			zIndex: win.frame.ZIndex + 1,
		},
	);
	// the status line names towns (proper nouns): never captured for automatic translation
	status.AutoLocalize = false;
	const setStatus = (text: string, bad = false): void => {
		if (status.Text !== text) status.Text = text;
		const color = bad ? THEME.destructive : THEME.mutedForeground;
		if (status.TextColor3 !== color) status.TextColor3 = color;
	};

	const towns = Table<ServerRow>(section.frame, "Table", {
		x: 16,
		y: section.contentY,
		w: WIN_W - PAD * 2 - 32,
		h: TABLE_H,
		rowH: ROW_H,
		headerH: HEADER_H,
		textSize: TEXT.base,
		selectable: true,
		columns: [
			{ key: "town", header: tr("Town"), flex: 1, raw: true },
			{ key: "day", header: tr("Day"), width: 90, numeric: true },
			{ key: "players", header: tr("Players"), width: 110, numeric: true },
			{ key: "status", header: tr("Status"), width: 110 },
		],
		keyOf: r => r.jobId,
		cell,
		onSelect: () => updateJoin(),
		empty: tr("Looking for towns..."),
		zIndex: section.frame.ZIndex + 1,
	});
	const refreshButton = Button(win.frame, "Refresh", tr("Refresh"), {
		x: WIN_W - PAD - JOIN_W - space(2) - REFRESH_W,
		y: footY,
		w: REFRESH_W,
		h: FOOT_H,
		variant: "secondary",
		zIndex: win.frame.ZIndex + 1,
		onClick: () => load(),
	});
	const join = Button(win.frame, "Join", tr("Join"), {
		x: WIN_W - PAD - JOIN_W,
		y: footY,
		w: JOIN_W,
		h: FOOT_H,
		variant: "default",
		zIndex: win.frame.ZIndex + 1,
		onClick: () => doJoin(),
	});
	updateJoin = (): void => {
		const r = towns.selectedItem();
		setButtonEnabled(join, !closed && !loading && !joining && r !== undefined && !full(r));
	};

	load = (): void => {
		if (closed || loading || joining) return;
		loading = true;
		setButtonEnabled(refreshButton, false);
		updateJoin();
		setStatus(tr("Looking for towns..."));
		townRequestAsync({ kind: "servers" }, res => {
			if (closed) return;
			loading = false;
			setButtonEnabled(refreshButton, true);
			if (res.ok) {
				rows = res.servers ?? [];
				towns.setItems(rows);
				towns.setEmpty(tr("No other public towns right now"));
				const open = rows.filter(r => !full(r)).size();
				setStatus(open === 1 ? tr("1 town open") : `${open} ${tr("towns open")}`);
			} else {
				rows = [];
				towns.setItems(rows);
				towns.setEmpty(tr(refusalText(res.reason)));
				setStatus("");
			}
			updateJoin();
			// the pad lands on the first town, or on Refresh when there is none
			const first = towns.rowButton(0);
			autoFocus(rows.size() > 0 && first !== undefined ? first : refreshButton);
		});
	};

	/** the window's answer to a join that is over without the player leaving: back to the list, with why */
	const joinOver = (text: string): void => {
		joining = false;
		trip += 1;
		setButtonEnabled(refreshButton, true);
		setStatus(text, true);
		updateJoin();
	};
	doJoin = (): void => {
		const r = towns.selectedItem();
		if (closed || loading || joining || r === undefined || full(r)) return;
		joining = true;
		// every join is a trip of its own: an answer, a notice or a timeout of an older one moves nothing
		trip += 1;
		const mine = trip;
		const name = townNameOf(r.seed);
		setStatus(`${tr("Joining")} ${name}...`);
		setButtonEnabled(refreshButton, false);
		updateJoin();
		townRequestAsync({ kind: "join", jobId: r.jobId }, res => {
			// a TeleportInitFailed can come BEFORE this answer (review of 0b44458, L5): that trip is already over
			if (closed || mine !== trip) return;
			if (!res.ok) {
				joinOver(tr(refusalText(res.reason)));
				return;
			}
			// the platform is moving this player: nothing to press meanwhile. A refusal after this is a notice; and a
			// trip that neither lands nor fails within TRAVEL_TIMEOUT_S gives the list back, saying so
			setStatus(`${tr("Travelling to")} ${name}...`);
			task.delay(TRAVEL_TIMEOUT_S, () => {
				if (!closed && mine === trip && joining) joinOver(tr("The trip did not start. Try again"));
			});
		});
	};

	unsubscribe = onJoinFailed(why => {
		if (closed || !joining) return;
		joinOver(tr(refusalText(why)));
	});

	updateJoin();
	if (win.close !== undefined) autoFocus(win.close);
	load();
	return {
		close,
		refresh: load,
		rows: () => rows,
	};
}

/**
 * "Restart town" (MP-26): the keeper is asked first -- Cancel is where the pad lands -- and only a Yes goes to the
 * server, which decides (server/match/townServices.ts). The news of the new town itself comes as every world end
 * does (the WorldReset, client/main.client.ts): this only says when the server refused.
 */
export function askRestartTown(ctx: GameContext, seed: number | undefined): void {
	const lang = ctx.save.settings.langType;
	const tr = (k: string): string => langGet(k, lang);
	// the orchestrator's decision on the review of 0b44458 (M1 + M2): a restart ends EVERY life of the town -- said
	// plainly, before anything is sent
	const warning = tr(
		"Everyone's current life ends: everybody who played in this town, standing or down, starts a new game on day 1 in a new town. Levels, skills, coins and packs are kept. This town is gone for good.",
	);
	popup(ctx, tr("Restart town?"), seed !== undefined ? `${townNameOf(seed)}\n${warning}` : warning, [
		{
			text: tr("Restart"),
			variant: "destructive",
			onClick: () => {
				townRequestAsync({ kind: "restart" }, res => {
					if (res.ok) toast(ctx, tr("A new town is being made..."), "info");
					else toast(ctx, tr(restartRefusalText(res.reason)), "error");
				});
			},
		},
		{ text: tr("Cancel"), variant: "secondary" },
	]);
}

/** what a refused restart says */
export function restartRefusalText(reason: TownRefusal | undefined): string {
	if (reason === "rate") return "The town was restarted a moment ago. Try again later";
	if (reason === "busy") return "A new town is already being made";
	if (reason === "forbidden") return "Only this server's owner can restart the town";
	if (reason === "unavailable") return "The town cannot be restarted right now";
	return "Something went wrong. Try again";
}
