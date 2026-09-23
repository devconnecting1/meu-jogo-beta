import {
	ADMIN_AFK_S,
	ADMIN_LIMITS,
	BAN_DURATION_LABEL,
	BAN_DURATIONS,
	BanDuration,
	BanHistoryResult,
	PlayerRow,
} from "shared/admin/protocol";
import { STAT, SURFACE, TEXT, THEME, space } from "../ui/theme";
import { Table, TableCell, TableColumn, TableSort, fitText } from "../ui/table";
import {
	Button,
	Dialog,
	Tabs,
	clearChildren,
	fmtInt,
	makeLabel,
	makeListRow,
	makeScrollList,
	setButtonEnabled,
} from "../ui/widgets";
import * as Kit from "../ui/window";
import { Switch, TextInput, attachTooltip } from "./controls";
import {
	CONTENT_H,
	CONTENT_W,
	PanelCtx,
	SectionHandle,
	agoText,
	clearRows,
	durationText,
	region,
	rowLabel,
	sessionText,
} from "./panelTypes";

/*
 * Players (server): who is in this server and what the server knows about them -- its copy of the save (day, level,
 * coins, rebirths, session / DataStore state, last progress report) and, from the simulation, the body in the town
 * (HP, dead or alive, how long since a real input: AFK past MP-13's 3 minutes) and the client's ping (§9.3). A DATA
 * table (client/ui/table.ts, DESIGN_RULES UI-12): filter by name, sort by a header, select a row, act with the buttons
 * under it. Kick / Ban / Unban / ban history go through the server, which re-checks everything (the kick and the ban
 * are their own confirmation dialogs). "Follow live" streams the selected player's data on every progress report.
 */

/** kick confirmation: optional reason (shown to the player, text-filtered by the server) */
export function openKickDialog(p: PanelCtx, row: PlayerRow): void {
	const w = 480;
	const h = 250;
	const dlg = Dialog(p.layer, "KickDialog", {
		w,
		h,
		title: `Kick ${row.name}?`,
		description: "They leave the server now and can rejoin right away.",
		zIndex: 200,
	});
	const pad = space(6);
	const reason = TextInput(dlg.card, "Reason", {
		x: pad,
		y: dlg.contentY,
		w: w - pad * 2,
		placeholder: "Reason shown to the player (optional)",
		maxLength: ADMIN_LIMITS.KICK_REASON,
	});
	const footerY = h - pad - 40;
	const cancel = Button(dlg.card, "Cancel", "Cancel", {
		x: w - pad - 260 - space(2),
		y: footerY,
		w: 130,
		h: 40,
		variant: "secondary",
		onClick: () => dlg.close(),
	});
	const go = Button(dlg.card, "Kick", "Kick", {
		x: w - pad - 130,
		y: footerY,
		w: 130,
		h: 40,
		variant: "destructive",
		onClick: () => {
			setButtonEnabled(go, false);
			setButtonEnabled(cancel, false);
			task.spawn(() => {
				const res = p.request(
					{ kind: "kick", userId: row.userId, reason: reason.get() },
					`${row.name} was kicked`,
				);
				if (res.ok) {
					dlg.close();
					p.refreshPlayers();
				} else {
					setButtonEnabled(go, true);
					setButtonEnabled(cancel, true);
				}
			});
		},
	});
}

/** ban form: duration, shown reason (filtered), private reason, universe / alt-account options */
export function openBanDialog(p: PanelCtx, target: string, label: string): void {
	const w = 540;
	const h = 470;
	const dlg = Dialog(p.layer, "BanDialog", {
		w,
		h,
		title: `Ban ${label}?`,
		description: "Uses the Roblox Ban API. The shown reason goes through the text filter.",
		zIndex: 200,
	});
	const pad = space(6);
	const innerW = w - pad * 2;
	let y = dlg.contentY;
	makeLabel(dlg.card, "DurationLabel", "Duration", pad, y, innerW, 18, TEXT.sm, THEME.popoverForeground, {
		font: "label",
		align: "left",
	});
	y += 22;
	let duration: BanDuration = "1d";
	let go: TextButton | undefined;
	const refreshGo = (): void => {
		if (go !== undefined) go.Text = `Ban · ${BAN_DURATION_LABEL[duration]}`;
	};
	Tabs(dlg.card, "Duration", {
		x: pad,
		y,
		w: innerW,
		h: 36,
		items: BAN_DURATIONS.map(d => BAN_DURATION_LABEL[d]),
		value: BAN_DURATIONS.indexOf(duration),
		onChange: i => {
			duration = BAN_DURATIONS[i];
			refreshGo();
		},
	});
	y += 46;
	const shown = TextInput(dlg.card, "Shown", {
		x: pad,
		y,
		w: innerW,
		placeholder: "Reason shown to the player (optional)",
		maxLength: ADMIN_LIMITS.DISPLAY_REASON,
	});
	y += 44;
	const hidden = TextInput(dlg.card, "Private", {
		x: pad,
		y,
		w: innerW,
		placeholder: "Private note for the ban history (optional)",
		maxLength: ADMIN_LIMITS.PRIVATE_REASON,
	});
	y += 48;
	let universe = true;
	let excludeAlts = false;
	Switch(dlg.card, "Universe", {
		x: pad,
		y,
		w: innerW,
		label: "Apply to the whole universe",
		description: "Every place of this experience, not only this one",
		value: universe,
		onChange: v => {
			universe = v;
		},
	});
	y += 50;
	Switch(dlg.card, "Alts", {
		x: pad,
		y,
		w: innerW,
		label: "Do not ban alt accounts",
		description: "Otherwise Roblox also bans their alt accounts",
		value: excludeAlts,
		onChange: v => {
			excludeAlts = v;
		},
	});
	const footerY = h - pad - 40;
	const cancel = Button(dlg.card, "Cancel", "Cancel", {
		x: w - pad - 330 - space(2),
		y: footerY,
		w: 130,
		h: 40,
		variant: "secondary",
		onClick: () => dlg.close(),
	});
	const button = Button(dlg.card, "Ban", "", {
		x: w - pad - 200,
		y: footerY,
		w: 200,
		h: 40,
		variant: "destructive",
		onClick: () => {
			setButtonEnabled(button, false);
			setButtonEnabled(cancel, false);
			task.spawn(() => {
				const res = p.request({
					kind: "ban",
					target,
					duration,
					displayReason: shown.get(),
					privateReason: hidden.get(),
					applyToUniverse: universe,
					excludeAlts,
				});
				if (res.ok) {
					p.notify(res.message ?? "Banned", "success");
					dlg.close();
					p.refreshPlayers();
				} else {
					setButtonEnabled(button, true);
					setButtonEnabled(cancel, true);
				}
			});
		},
	});
	go = button;
	refreshGo();
}

/** what a player is doing, in one word (the Status column): the save, then the body in the town (§9.3) */
export type PlayerStatus = "loading" | "lobby" | "dead" | "afk" | "alive";

export function playerStatus(row: PlayerRow): PlayerStatus {
	if (!row.loaded) return "loading";
	if (!row.inWorld) return "lobby";
	if (row.dead) return "dead";
	if (row.idleS >= ADMIN_AFK_S) return "afk";
	return "alive";
}

const STATUS_TEXT: Record<PlayerStatus, string> = {
	loading: "Loading",
	lobby: "Lobby",
	dead: "Dead",
	afk: "AFK",
	alive: "Alive",
};
/** the order the Status column sorts in: who is out there first */
const STATUS_ORDER: Record<PlayerStatus, number> = { alive: 0, afk: 1, dead: 2, lobby: 3, loading: 4 };

/** the colour of a status on the table's dark rows (SURFACE.well: every one 4,5:1 there, test:contrast) */
function statusColor(status: PlayerStatus): Color3 {
	if (status === "alive") return STAT.bonus;
	if (status === "afk") return STAT.effect;
	if (status === "dead") return THEME.destructive;
	return THEME.mutedForeground;
}

/** the players table's columns: the name, then numbers right-aligned in the numeric voice, then the status */
export const PLAYER_COLUMNS: Array<TableColumn> = [
	{ key: "name", header: "Name", flex: 1, sortable: true },
	{ key: "level", header: "Lv", width: 36, numeric: true, sortable: true, descendingFirst: true },
	{ key: "day", header: "Day", width: 48, numeric: true, sortable: true, descendingFirst: true },
	{ key: "hp", header: "HP", width: 64, numeric: true, sortable: true },
	{ key: "ping", header: "Ping", width: 52, numeric: true, sortable: true, descendingFirst: true },
	{ key: "status", header: "Status", width: 66, sortable: true },
];

/** the rows the name filter lets through (case-insensitive, on the name, the display name or the UserId) */
export function filterPlayers(rows: ReadonlyArray<PlayerRow>, filter: string): Array<PlayerRow> {
	const [trimmed] = filter.lower().gsub("^%s+", "");
	const [f] = trimmed.gsub("%s+$", "");
	const out: Array<PlayerRow> = [];
	for (const r of rows) {
		if (f === "") {
			out.push(r);
			continue;
		}
		const hay = `${r.name} ${r.displayName} ${r.userId}`.lower();
		if (hay.find(f, 1, true)[0] !== undefined) out.push(r);
	}
	return out;
}

function playerCell(row: PlayerRow, column: string, out: TableCell): void {
	const status = playerStatus(row);
	if (column === "name") {
		out.text = fitText(row.isAdmin ? `${rowLabel(row)} · ADMIN` : rowLabel(row), 28);
	} else if (column === "level") {
		out.text = row.loaded ? tostring(row.level) : "–";
	} else if (column === "day") {
		out.text = row.loaded ? tostring(row.day) : "–";
	} else if (column === "hp") {
		out.text = row.inWorld ? `${row.hp}/${row.hpMax}` : "–";
		if (row.inWorld && row.dead) out.color = THEME.destructive;
	} else if (column === "ping") {
		out.text = row.pingMs >= 0 ? tostring(row.pingMs) : "–";
	} else {
		out.text = STATUS_TEXT[status];
		out.color = statusColor(status);
	}
	if (out.color === undefined && !row.loaded) out.color = THEME.mutedForeground;
}

function playerSortValue(row: PlayerRow, column: string): number | string {
	if (column === "name") return rowLabel(row);
	// a save still loading shows "–" and sorts under every real number
	if (column === "level") return row.loaded ? row.level : -1;
	if (column === "day") return row.loaded ? row.day : -1;
	if (column === "hp") return row.inWorld ? row.hp : -1;
	if (column === "ping") return row.pingMs;
	return STATUS_ORDER[playerStatus(row)];
}

/** remembered across visits to the section (like the backpack's tab) */
const playersMemory: { filter: string; sort: TableSort } = { filter: "", sort: { column: "name", descending: false } };

/** the Follow live row (a kit switch row): its label cell and the switch's value cell */
const FOLLOW_W = 240;

export function buildPlayers(p: PanelCtx, content: Frame): SectionHandle {
	const tabsH = 36;
	const body = region(content, "Body", 0, tabsH + 8, CONTENT_W, CONTENT_H - tabsH - 8);
	const bodyH = CONTENT_H - tabsH - 8;
	let selected: number | undefined;
	let following: number | undefined;
	/** the first player list has arrived (before it, the empty table says "loading", not "nobody") */
	let heard = p.players.size() > 0;
	let online: { refresh: () => void; onWatch: (row: PlayerRow) => void } | undefined;

	const stopFollowing = (): void => {
		if (following !== undefined) {
			following = undefined;
			task.spawn(() => p.request({ kind: "watch", userId: 0 }));
		}
	};

	/*
	 * Online: a DATA table (client/ui/table.ts, DESIGN_RULES UI-12) -- filter by name, sort by a header, select a row,
	 * then act with the buttons under it. What the server knows about the selected one (ids, save, report) sits between
	 * the table and the buttons, rewritten in place; nothing here is rebuilt on a poll.
	 */
	const buildOnline = (): void => {
		clearChildren(body);
		const filter = TextInput(body, "Filter", {
			x: 0,
			y: 0,
			w: 206,
			h: 30,
			placeholder: "Filter by name or UserId",
			text: playersMemory.filter,
			maxLength: ADMIN_LIMITS.TARGET,
		});
		const countLabel = makeLabel(
			body,
			"Count",
			"",
			214,
			0,
			CONTENT_W - 214 - 108,
			30,
			TEXT.xs,
			THEME.mutedForeground,
			{
				align: "left",
			},
		);
		Button(body, "Refresh", "Refresh", {
			x: CONTENT_W - 100,
			y: 0,
			w: 100,
			h: 30,
			size: "sm",
			variant: "outline",
			onClick: () => p.refreshPlayers(),
		});

		const tableY = 38;
		const tableH = 214;
		// assigned below (it needs the buttons); the table's selection callback reads it
		let refreshDetail: (live?: PlayerRow) => void = () => {};
		const grid = Table<PlayerRow>(body, "Players", {
			x: 0,
			y: tableY,
			w: CONTENT_W,
			h: tableH,
			columns: PLAYER_COLUMNS,
			rowH: 28,
			headerH: 24,
			textSize: TEXT.sm,
			rowFace: SURFACE.well,
			// a tight table (six columns in the panel's 442): the headers still read at 9 px on a 435 px-tall screen
			cellPad: 5,
			selectable: true,
			keyOf: r => tostring(r.userId),
			cell: playerCell,
			sortValue: playerSortValue,
			sort: playersMemory.sort,
			onSort: sort => {
				playersMemory.sort = sort;
			},
			onSelect: key => {
				const id = key !== undefined ? tonumber(key) : undefined;
				if (following !== undefined && following !== id) stopFollowing();
				selected = id;
				refreshDetail();
			},
		});

		// ---- the selected player: what the server knows, in muted lines (rewritten, never rebuilt)
		const detailY = tableY + tableH + 6;
		const pad = space(1);
		const lineW = CONTENT_W - pad * 2;
		// the name beside the Follow switch row (the kit's, SETTING_ROW_H tall), the muted lines under both
		const nameW = CONTENT_W - FOLLOW_W - space(2) - pad;
		const nameLine = makeLabel(
			body,
			"SelName",
			"",
			pad,
			detailY + (Kit.SETTING_ROW_H - 20) / 2,
			nameW,
			20,
			TEXT.sm,
			THEME.foreground,
			{
				font: "label",
				align: "left",
			},
		);
		const muted = (name: string, y: number): TextLabel =>
			makeLabel(body, name, "", pad, y, lineW, 16, TEXT.xs, THEME.mutedForeground, { align: "left" });
		const linesY = detailY + Kit.SETTING_ROW_H + 4;
		const idsLine = muted("SelIds", linesY);
		const saveLine = muted("SelSave", linesY + 18);
		const reportLine = muted("SelReport", linesY + 36);
		const follow = Switch(body, "Follow", {
			x: CONTENT_W - FOLLOW_W,
			y: detailY,
			w: FOLLOW_W,
			label: "Follow live",
			value: false,
			onChange: on => {
				const id = selected;
				task.spawn(() => {
					if (on && id !== undefined) {
						const res = p.request({ kind: "watch", userId: id });
						if (res.ok) following = id;
						// the switch shows what really happened
						else if (follow.frame.Parent !== undefined) follow.set(false);
					} else {
						stopFollowing();
					}
				});
			},
		});

		// ---- the row actions: select a row, then act (no per-row menu, DESIGN_RULES UI-12)
		const actionsY = bodyH - 36;
		const bw = (CONTENT_W - space(2) * 2) / 3;
		const edit = Button(body, "Edit", "Edit progress", {
			x: 0,
			y: actionsY,
			w: bw,
			h: 36,
			size: "sm",
			variant: "secondary",
			onClick: () => {
				if (selected === undefined) return;
				p.target = selected;
				p.goTo("progress");
			},
		});
		const kick = Button(body, "Kick", "Kick…", {
			x: bw + space(2),
			y: actionsY,
			w: bw,
			h: 36,
			size: "sm",
			variant: "outline",
			onClick: () => {
				const row = p.players.find(r => r.userId === selected);
				if (row !== undefined) openKickDialog(p, row);
			},
		});
		const ban = Button(body, "Ban", "Ban…", {
			x: (bw + space(2)) * 2,
			y: actionsY,
			w: bw,
			h: 36,
			size: "sm",
			variant: "destructive",
			onClick: () => {
				const row = p.players.find(r => r.userId === selected);
				if (row !== undefined) openBanDialog(p, tostring(row.userId), `${row.name} (${row.userId})`);
			},
		});
		attachTooltip(kick, "Admins (you included) cannot be kicked or banned");
		attachTooltip(ban, "Admins (you included) cannot be kicked or banned");

		refreshDetail = (live?: PlayerRow): void => {
			const row = live ?? p.players.find(r => r.userId === selected);
			const locked = row === undefined || row.userId === p.selfUserId || row.isAdmin;
			setButtonEnabled(edit, row !== undefined);
			setButtonEnabled(kick, !locked);
			setButtonEnabled(ban, !locked);
			if (row === undefined) {
				nameLine.Text = "Select a player in the table.";
				idsLine.Text = "Then act on them with the buttons below.";
				saveLine.Text = "";
				reportLine.Text = "";
				if (follow.get()) follow.set(false);
				return;
			}
			const tags = `${row.isAdmin ? " · ADMIN" : ""}${row.userId === p.selfUserId ? " · you" : ""}`;
			nameLine.Text = fitText(`${rowLabel(row)}${tags}`, 23);
			idsLine.Text = `UserId ${row.userId} · account ${fmtInt(row.accountAge)} days · in server ${durationText(row.sessionAge)}`;
			saveLine.Text =
				`Day ${row.day} (best ${row.bestDay}) · Lv ${row.level} · ${row.skillPoint} skill pts · ` +
				`${fmtInt(row.money)} coins · ${row.deathCount} rebirths${row.runOver ? " · run over" : ""}`;
			const idle = row.inWorld ? ` · idle ${durationText(row.idleS)}` : "";
			const pending = row.patchPending ? " · patch pending" : "";
			reportLine.Text = `Report ${agoText(row.lastReportAgo)} · ${sessionText(row)}${pending}${idle}`;
			const on = following === row.userId;
			if (follow.get() !== on) follow.set(on);
		};

		const refresh = (): void => {
			const shown = filterPlayers(p.players, filter.get());
			grid.setItems(shown);
			const total = p.players.size();
			countLabel.Text =
				shown.size() === total
					? `${total} player${total === 1 ? "" : "s"}`
					: `${shown.size()} of ${total} players`;
			if (!heard) grid.setEmpty("Loading the player list…");
			else if (total === 0) grid.setEmpty("Nobody is in this server.");
			else grid.setEmpty(`No player matches "${filter.get()}". Clear the filter to see all ${total}.`);
			// the first time, the admin's own row is selected, like the old list did
			if (selected === undefined && grid.selected() === undefined && shown.size() > 0) {
				const mine = shown.find(r => r.userId === p.selfUserId) ?? shown[0];
				grid.select(tostring(mine.userId));
			}
			refreshDetail();
		};
		filter.box.GetPropertyChangedSignal("Text").Connect(() => {
			playersMemory.filter = filter.get();
			refresh();
		});
		online = {
			refresh,
			onWatch: row => refreshDetail(row),
		};
		refresh();
	};

	const buildBans = (): void => {
		online = undefined;
		stopFollowing();
		clearChildren(body);
		makeLabel(
			body,
			"Hint",
			"Any user, in this server or not: type a UserId or a username.",
			0,
			0,
			CONTENT_W,
			20,
			TEXT.xs,
			THEME.mutedForeground,
			{ align: "left" },
		);
		const target = TextInput(body, "Target", {
			x: 0,
			y: 24,
			w: CONTENT_W,
			placeholder: "UserId or username",
			maxLength: ADMIN_LIMITS.TARGET,
		});
		let universe = true;
		Switch(body, "Universe", {
			x: 0,
			y: 68,
			w: CONTENT_W,
			label: "Whole universe",
			value: universe,
			onChange: v => {
				universe = v;
			},
		});
		const results = makeScrollList(body, "History", 0, 150, CONTENT_W, bodyH - 150);
		const bw = (CONTENT_W - space(2) * 2) / 3;
		const showHistory = (h: BanHistoryResult): void => {
			if (results.frame.Parent === undefined) return;
			clearRows(results.frame);
			const head = makeListRow(results, "Head", 0, 30);
			makeLabel(
				head,
				"Text",
				`${h.name} (${h.userId}) · ${h.entries.size()} entr${h.entries.size() === 1 ? "y" : "ies"}`,
				space(3),
				0,
				CONTENT_W - space(6),
				30,
				TEXT.sm,
				THEME.foreground,
				{
					font: "label",
					align: "left",
					zIndex: 3,
				},
			);
			let order = 1;
			for (const e of h.entries) {
				const row = makeListRow(results, `Entry${order}`, order++, 64);
				const dur = e.duration < 0 ? "permanent" : durationText(e.duration);
				makeLabel(
					row,
					"Kind",
					`${e.ban ? "BAN" : "UNBAN"}${e.ban ? ` · ${dur}` : ""} · ${e.startTime}`,
					space(3),
					4,
					CONTENT_W - space(6),
					20,
					TEXT.sm,
					e.ban ? THEME.destructive : THEME.foreground,
					{
						font: "label",
						align: "left",
						zIndex: 3,
					},
				);
				makeLabel(
					row,
					"Shown",
					`Shown: ${e.displayReason !== "" ? e.displayReason : "—"}`,
					space(3),
					24,
					CONTENT_W - space(6),
					18,
					TEXT.xs,
					THEME.foreground,
					{
						align: "left",
						zIndex: 3,
					},
				);
				makeLabel(
					row,
					"Private",
					`Private: ${e.privateReason !== "" ? e.privateReason : "—"}`,
					space(3),
					42,
					CONTENT_W - space(6),
					18,
					TEXT.xs,
					THEME.mutedForeground,
					{
						align: "left",
						zIndex: 3,
					},
				);
			}
		};
		const busy = (b: TextButton, fn: () => void): void => {
			setButtonEnabled(b, false);
			task.spawn(() => {
				fn();
				setButtonEnabled(b, true);
			});
		};
		const unban: TextButton = Button(body, "Unban", "Unban", {
			x: 0,
			y: 106,
			w: bw,
			h: 36,
			size: "sm",
			variant: "secondary",
			onClick: () =>
				busy(unban, () => {
					const res = p.request({ kind: "unban", target: target.get(), applyToUniverse: universe });
					if (res.ok) p.notify(res.message ?? "Unbanned", "success");
				}),
		});
		const history: TextButton = Button(body, "HistoryBtn", "Ban history", {
			x: bw + space(2),
			y: 106,
			w: bw,
			h: 36,
			size: "sm",
			variant: "outline",
			onClick: () =>
				busy(history, () => {
					const res = p.request({ kind: "banHistory", target: target.get() });
					if (res.ok && typeIs(res.data, "table")) showHistory(res.data as BanHistoryResult);
				}),
		});
		Button(body, "BanBtn", "Ban…", {
			x: (bw + space(2)) * 2,
			y: 106,
			w: bw,
			h: 36,
			size: "sm",
			variant: "destructive",
			onClick: () => {
				const t = target.get();
				if (t === "") {
					p.notify("Type a UserId or a username first", "error");
					return;
				}
				openBanDialog(p, t, t);
			},
		});
	};

	Tabs(content, "Tabs", {
		x: 0,
		y: 0,
		w: CONTENT_W,
		h: tabsH,
		items: ["Online", "Bans & history"],
		onChange: i => {
			if (i === 0) buildOnline();
			else buildBans();
		},
	});
	buildOnline();

	return {
		onPlayers(): void {
			heard = true;
			// the followed player left: stop the server's live feed
			if (following !== undefined && p.players.find(r => r.userId === following) === undefined) stopFollowing();
			online?.refresh();
		},
		onWatch(row: PlayerRow): void {
			if (row.userId === following && row.userId === selected) online?.onWatch(row);
		},
		destroy(): void {
			stopFollowing();
		},
	};
}
