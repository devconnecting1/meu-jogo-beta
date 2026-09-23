import {
	ADMIN_LIMITS,
	BAN_DURATION_LABEL,
	BAN_DURATIONS,
	BanDuration,
	BanHistoryResult,
	PlayerRow,
} from "shared/admin/protocol";
import { GAME, TEXT, THEME, space } from "../ui/theme";
import {
	Badge,
	Button,
	Card,
	Dialog,
	ListRowButton,
	Tabs,
	badgeWidth,
	clearChildren,
	fmtInt,
	makeLabel,
	makeListRow,
	makeScrollList,
	setButtonEnabled,
} from "../ui/widgets";
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
	signature,
} from "./panelTypes";

/*
 * Players (server): who is in this server and what the server knows about them (its copy of the save: day, level,
 * coins, bosses, session / DataStore state, last progress report). Kick / Ban / Unban / ban history go through the
 * server, which re-checks everything. "Spectate" is disabled: each client simulates its own world today, so there
 * is no remote world to look at — "Follow live" streams the player's data on every progress report instead.
 */

const LIST_Y = 34;
/** list + detail card: the card needs >= 242 so its three rows (stats, follow, actions) never overlap */
const LIST_H = 116;
const ROW_H = 50;
const DETAIL_Y = LIST_Y + LIST_H + 8;

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
		description: "By default Roblox also tries to ban the user's alternate accounts",
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

/** caption + value; returns the value label */
function statCell(
	parent: Frame,
	name: string,
	x: number,
	y: number,
	w: number,
	caption: string,
	value: string,
): TextLabel {
	makeLabel(parent, `${name}Caption`, caption, x, y, w, 16, TEXT.xs, THEME.mutedForeground, {
		align: "left",
		zIndex: 3,
	});
	return makeLabel(parent, `${name}Value`, value, x, y + 16, w, 20, TEXT.sm, THEME.foreground, {
		font: "label",
		align: "left",
		zIndex: 3,
	});
}

export function buildPlayers(p: PanelCtx, content: Frame): SectionHandle {
	const tabsH = 36;
	const body = region(content, "Body", 0, tabsH + 8, CONTENT_W, CONTENT_H - tabsH - 8);
	const bodyH = CONTENT_H - tabsH - 8;
	let selected: number | undefined;
	let following: number | undefined;
	let online: { refreshList: () => void; refreshDetail: (row?: PlayerRow) => void } | undefined;

	const stopFollowing = (): void => {
		if (following !== undefined) {
			following = undefined;
			task.spawn(() => p.request({ kind: "watch", userId: 0 }));
		}
	};

	const buildOnline = (): void => {
		clearChildren(body);
		const countLabel = makeLabel(body, "Count", "", 0, 0, CONTENT_W - 110, 30, TEXT.sm, THEME.foreground, {
			font: "label",
			align: "left",
		});
		Button(body, "Refresh", "Refresh", {
			x: CONTENT_W - 100,
			y: 0,
			w: 100,
			h: 30,
			size: "sm",
			variant: "outline",
			onClick: () => p.refreshPlayers(),
		});
		const list = makeScrollList(body, "List", 0, LIST_Y, CONTENT_W, LIST_H);
		const detailH = bodyH - DETAIL_Y;
		const detailCard = Card(body, "Detail", { x: 0, y: DETAIL_Y, w: CONTENT_W, h: detailH, variant: "muted" });
		// rebuilt content lives in a region, so the card keeps its own corner / border
		const detail = region(detailCard, "Body", 0, 0, CONTENT_W, detailH);
		const pad = space(3);
		const innerW = CONTENT_W - pad * 2;
		/** labels updated in place every refresh (timers), so hovering / clicking is never interrupted */
		let liveIds: TextLabel | undefined;
		let liveReport: TextLabel | undefined;
		const rowInfo = new Map<number, TextLabel>();

		const idsText = (row: PlayerRow): string =>
			`UserId ${row.userId} · account ${fmtInt(row.accountAge)} days · in server ${durationText(row.sessionAge)}`;
		const infoText = (row: PlayerRow): string =>
			`Day ${row.day} · Lv ${row.level} · ${fmtInt(row.money)} coins · report ${agoText(row.lastReportAgo)} · ${sessionText(row)}`;
		/** the row without its timers (they change every refresh) */
		const stable = (row: PlayerRow | undefined): unknown =>
			row === undefined ? undefined : { ...row, lastReportAgo: row.lastReportAgo >= 0, sessionAge: 0 };

		const buildDetail = (row: PlayerRow | undefined): void => {
			clearChildren(detail);
			liveIds = undefined;
			liveReport = undefined;
			if (row === undefined) {
				makeLabel(
					detail,
					"Empty",
					"Select a player above.",
					pad,
					pad,
					innerW,
					20,
					TEXT.sm,
					THEME.mutedForeground,
					{
						align: "left",
						zIndex: 3,
					},
				);
				return;
			}
			makeLabel(detail, "Name", rowLabel(row), pad, pad, innerW - 150, 22, TEXT.base, THEME.foreground, {
				font: "heading",
				align: "left",
				zIndex: 3,
			});
			let bx = innerW - 140 + pad;
			if (row.isAdmin) {
				Badge(detail, "AdminBadge", "ADMIN", { x: bx, y: pad, color: GAME.rare, zIndex: 3 });
				bx += badgeWidth("ADMIN") + space(1);
			}
			if (row.userId === p.selfUserId) {
				Badge(detail, "YouBadge", "You", { x: bx, y: pad, variant: "secondary", zIndex: 3 });
			}
			liveIds = makeLabel(
				detail,
				"Ids",
				idsText(row),
				pad,
				pad + 24,
				innerW,
				16,
				TEXT.xs,
				THEME.mutedForeground,
				{
					align: "left",
					zIndex: 3,
				},
			);
			const colW = innerW / 3;
			const y1 = pad + 46;
			statCell(detail, "Day", pad, y1, colW, "Day (best)", `${row.day} (${row.bestDay})`);
			statCell(detail, "Level", pad + colW, y1, colW, "Level · skill pts", `${row.level} · ${row.skillPoint}`);
			statCell(detail, "Coins", pad + colW * 2, y1, colW, "Coins", fmtInt(row.money));
			const y2 = y1 + 40;
			statCell(
				detail,
				"Bosses",
				pad,
				y2,
				colW,
				"Bosses · deaths",
				`${row.bossKills} · ${row.deathCount}${row.runOver ? " · game over" : ""}`,
			);
			liveReport = statCell(detail, "Report", pad + colW, y2, colW, "Last report", agoText(row.lastReportAgo));
			statCell(
				detail,
				"Save",
				pad + colW * 2,
				y2,
				colW,
				"Session / save",
				sessionText(row) + (row.patchPending ? " · patch pending" : ""),
			);
			const y3 = y2 + 44;
			const follow = Switch(detail, "Follow", {
				x: pad,
				y: y3,
				w: 230,
				label: "Follow live",
				description: "Updates on every progress report",
				value: following === row.userId,
				zIndex: 3,
				onChange: on => {
					task.spawn(() => {
						if (on) {
							const res = p.request({ kind: "watch", userId: row.userId });
							if (res.ok) following = row.userId;
							// the switch shows what really happened
							else if (follow.frame.Parent !== undefined) follow.set(false);
						} else {
							stopFollowing();
						}
					});
				},
			});
			const spectate = Button(detail, "Spectate", "Spectate", {
				x: CONTENT_W - pad - 130,
				y: y3 + 4,
				w: 130,
				h: 34,
				size: "sm",
				variant: "outline",
				disabled: true,
				zIndex: 3,
			});
			attachTooltip(spectate, "Available with multiplayer (each client simulates its own world today)", 300);
			const y4 = math.max(y3 + 52, detailH - pad - 36);
			const locked = row.userId === p.selfUserId || row.isAdmin;
			const bw = (innerW - space(2) * 2) / 3;
			Button(detail, "Edit", "Edit progress", {
				x: pad,
				y: y4,
				w: bw,
				h: 36,
				size: "sm",
				variant: "secondary",
				zIndex: 3,
				onClick: () => {
					p.target = row.userId;
					p.goTo("progress");
				},
			});
			const kick = Button(detail, "Kick", "Kick…", {
				x: pad + bw + space(2),
				y: y4,
				w: bw,
				h: 36,
				size: "sm",
				variant: "outline",
				disabled: locked,
				zIndex: 3,
				onClick: () => openKickDialog(p, row),
			});
			const ban = Button(detail, "Ban", "Ban…", {
				x: pad + (bw + space(2)) * 2,
				y: y4,
				w: bw,
				h: 36,
				size: "sm",
				variant: "destructive",
				disabled: locked,
				zIndex: 3,
				onClick: () => openBanDialog(p, tostring(row.userId), `${row.name} (${row.userId})`),
			});
			if (locked) {
				attachTooltip(kick, "Admins (you included) cannot be kicked or banned");
				attachTooltip(ban, "Admins (you included) cannot be kicked or banned");
			}
		};

		let detailSig = "";
		const refreshDetail = (live?: PlayerRow): void => {
			const row = live ?? p.players.find(r => r.userId === selected);
			const sig = signature({ row: stable(row) ?? false, following: following ?? 0, selected: selected ?? 0 });
			if (sig !== detailSig) {
				detailSig = sig;
				buildDetail(row);
			}
			if (row !== undefined) {
				if (liveIds !== undefined) liveIds.Text = idsText(row);
				if (liveReport !== undefined) liveReport.Text = agoText(row.lastReportAgo);
			}
		};

		let listSig = "";
		const refreshList = (): void => {
			countLabel.Text = `${p.players.size()} player${p.players.size() === 1 ? "" : "s"} in this server`;
			if (selected === undefined && p.players.size() > 0) selected = p.players[0].userId;
			const sig = signature({ rows: p.players.map(r => stable(r) ?? false), selected: selected ?? 0 });
			if (sig !== listSig) {
				listSig = sig;
				clearRows(list.frame);
				rowInfo.clear();
				let order = 0;
				for (const row of p.players) {
					const b = ListRowButton(list, `Row${row.userId}`, order++, ROW_H, () => {
						selected = row.userId;
						if (following !== undefined && following !== row.userId) stopFollowing();
						refreshList();
						refreshDetail();
					});
					const mark = row.userId === selected ? "▸ " : "";
					const name = `${mark}${rowLabel(row)}${row.isAdmin ? "  · ADMIN" : ""}`;
					makeLabel(b, "Name", name, space(3), 4, CONTENT_W - space(6), 22, TEXT.sm, THEME.cardForeground, {
						font: "label",
						align: "left",
						zIndex: b.ZIndex + 1,
					});
					const info = makeLabel(
						b,
						"Info",
						"",
						space(3),
						26,
						CONTENT_W - space(6),
						18,
						TEXT.xs,
						THEME.mutedForeground,
						{
							align: "left",
							zIndex: b.ZIndex + 1,
						},
					);
					rowInfo.set(row.userId, info);
				}
			}
			for (const row of p.players) {
				const info = rowInfo.get(row.userId);
				if (info !== undefined) info.Text = infoText(row);
			}
		};
		online = { refreshList, refreshDetail };
		refreshList();
		refreshDetail();
	};

	const buildBans = (): void => {
		online = undefined;
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
			// the followed player left: stop the server's live feed
			if (following !== undefined && p.players.find(r => r.userId === following) === undefined) stopFollowing();
			online?.refreshList();
			if (following === undefined) online?.refreshDetail();
		},
		onWatch(row: PlayerRow): void {
			if (row.userId === following && row.userId === selected) online?.refreshDetail(row);
		},
		destroy(): void {
			stopFollowing();
		},
	};
}
