import { PlayerSaveData, sanitizeStoredSave } from "shared/game/save";
import { WEAPONS } from "shared/data/weapons";
import { EQUIPS } from "shared/data/equips";
import { USABLES } from "shared/data/usables";
import { ETC_ITEMS } from "shared/data/etcItems";
import { COSTUMES } from "shared/data/shop";
import {
	AMMO_LABELS,
	AdminOp,
	ItemGroup,
	StatField,
	isAmmoEtcId,
	itemCount,
	itemMax,
	statRange,
} from "shared/admin/ops";
import type { PlayerRow } from "shared/admin/protocol";
import { TEXT, THEME, space } from "../ui/theme";
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
import { Switch, TextInput, TextInputHandle } from "./controls";
import { CONTENT_H, CONTENT_W, PanelCtx, SectionHandle, region, rowLabel } from "./panelTypes";

/*
 * Progress & items (server): edits the server's copy of a player's save (any player of this server, the admin by
 * default). The server applies the ops, enforces the save invariants, bumps runRev and patches the player's running
 * game at once; the next progress report can not undo it (see shared/admin/protocol.ts).
 */

const STAT_ROWS: Array<{ field: StatField; label: string }> = [
	{ field: "level", label: "Level" },
	{ field: "exp", label: "XP" },
	{ field: "skillPoint", label: "Skill points" },
	{ field: "money", label: "Coins" },
	{ field: "day", label: "Day" },
];

const GROUPS: Array<{ group: ItemGroup; label: string }> = [
	{ group: "weapon", label: "Weapons" },
	{ group: "equip", label: "Equipment" },
	{ group: "use", label: "Consumables" },
	{ group: "etc", label: "Materials" },
	{ group: "ammo", label: "Ammo" },
];

/** [index, name] of every editable entry of a group (ETC ids 44–48 are the ammo pools) */
function entries(group: ItemGroup): Array<[number, string]> {
	const out: Array<[number, string]> = [];
	if (group === "weapon") {
		WEAPONS.forEach((w, i) => out.push([i, w.name]));
	} else if (group === "equip") {
		EQUIPS.forEach((e, i) => out.push([i, e.name]));
	} else if (group === "use") {
		USABLES.forEach((u, i) => out.push([i, u.name]));
	} else if (group === "etc") {
		ETC_ITEMS.forEach((e, i) => {
			if (!isAmmoEtcId(i)) out.push([i, e.name]);
		});
	} else {
		AMMO_LABELS.forEach((name, i) => out.push([i, name]));
	}
	return out;
}

function statValue(save: PlayerSaveData, field: StatField): number {
	return save[field];
}

export function buildProgress(p: PanelCtx, content: Frame): SectionHandle {
	let save: PlayerSaveData | undefined;
	let row: PlayerRow | undefined;
	let tab = 0;
	let group = 0;
	let loading = false;
	/** every load / edit answer carries the serial and the target of its request: late answers are dropped */
	let seq = 0;
	/** scroll position of the item list per group, kept across rebuilds (like the backpack) */
	const scrollMemory = new Map<number, Vector2>();

	const header = region(content, "Header", 0, 0, CONTENT_W, 34);
	const tabsY = 42;
	const bodyY = tabsY + 42;
	const bodyH = CONTENT_H - bodyY;
	const body = region(content, "Body", 0, bodyY, CONTENT_W, bodyH);

	const targetLabel = (): string => {
		const r = p.players.find(x => x.userId === p.target);
		if (r === undefined) return `#${p.target}`;
		return `${rowLabel(r)}${r.userId === p.selfUserId ? " · you" : ""}`;
	};

	/**
	 * sends ops to the target shown right now; the answer carries the new save (ignored when the target changed or
	 * another request went out meanwhile). `onFail` restores a control that already shows the new value.
	 */
	const edit = (ops: Array<AdminOp>, done?: string, onFail?: () => void): void => {
		if (loading || save === undefined) {
			p.notify("Wait for the save to load", "error");
			onFail?.();
			return;
		}
		const target = p.target;
		const mySeq = ++seq;
		task.spawn(() => {
			const res = p.request({ kind: "edit", userId: target, ops }, done);
			if (!res.ok) {
				onFail?.();
				return;
			}
			if (res.message !== undefined) p.notify(res.message, "info");
			p.refreshPlayers();
			if (mySeq !== seq || target !== p.target) return;
			if (typeIs(res.data, "table")) save = sanitizeStoredSave(res.data);
			buildBody();
		});
	};

	const buildStats = (s: PlayerSaveData): void => {
		const inputs = new Map<StatField, TextInputHandle>();
		STAT_ROWS.forEach((r, i) => {
			const y = i * 44;
			makeLabel(body, `${r.field}Label`, r.label, 0, y, 120, 36, TEXT.sm, THEME.foreground, {
				font: "label",
				align: "left",
			});
			const [lo, hi] = statRange(r.field);
			inputs.set(
				r.field,
				TextInput(body, `${r.field}Input`, {
					x: 124,
					y,
					w: 150,
					text: tostring(statValue(s, r.field)),
					numeric: true,
					maxLength: 10,
				}),
			);
			makeLabel(
				body,
				`${r.field}Range`,
				`now ${fmtInt(statValue(s, r.field))} · ${fmtInt(lo)}–${fmtInt(hi)}`,
				284,
				y,
				CONTENT_W - 284,
				36,
				TEXT.xs,
				THEME.mutedForeground,
				{
					align: "left",
				},
			);
		});
		makeLabel(
			body,
			"Rules",
			"Setting the level also grants (or takes back) 1 skill point per level crossed. The save rules clamp the rest: spent skills ≤ levels, XP < next level.",
			0,
			224,
			CONTENT_W,
			40,
			TEXT.xs,
			THEME.mutedForeground,
			{ align: "left", valign: "top" },
		);
		const bw = (CONTENT_W - space(2)) / 2;
		Button(body, "Apply", "Apply changes", {
			x: 0,
			y: 272,
			w: bw,
			h: 40,
			variant: "default",
			onClick: () => {
				const ops: Array<AdminOp> = [];
				for (const r of STAT_ROWS) {
					const v = inputs.get(r.field)?.getInt();
					if (v === undefined || v === statValue(s, r.field)) continue;
					const [lo, hi] = statRange(r.field);
					ops.push({ op: "stat", field: r.field, value: math.clamp(v, lo, hi) });
				}
				if (ops.size() === 0) {
					p.notify("Nothing changed", "info");
					return;
				}
				edit(ops, "Progress updated");
			},
		});
		Button(body, "Refund", "Refund skill points", {
			x: bw + space(2),
			y: 272,
			w: bw,
			h: 40,
			variant: "secondary",
			onClick: () =>
				confirm(
					`Refund ${targetLabel()}'s skills?`,
					"Every learnt skill goes back to level 0 and its points return as free skill points.",
					"Refund",
					() => edit([{ op: "resetSkills" }], "Skill points refunded"),
				),
		});
		makeLabel(
			body,
			"Note",
			"Applied to the server's copy and to the player's running game at once.",
			0,
			322,
			CONTENT_W,
			20,
			TEXT.xs,
			THEME.mutedForeground,
			{
				align: "left",
			},
		);
	};

	const buildItems = (s: PlayerSaveData): void => {
		Tabs(body, "Groups", {
			x: 0,
			y: 0,
			w: CONTENT_W,
			h: 32,
			items: GROUPS.map(g => g.label),
			value: group,
			textSize: TEXT.xs,
			onChange: i => {
				group = i;
				buildBody();
			},
		});
		const g = GROUPS[group].group;
		const listH = bodyH - 40 - 46;
		const list = makeScrollList(body, "Items", 0, 40, CONTENT_W, listH);
		const groupIndex = group;
		const pos = scrollMemory.get(groupIndex);
		if (pos !== undefined) {
			// the automatic canvas size is only known after layout: apply the position once it is
			const frame = list.frame;
			const conn = frame.GetPropertyChangedSignal("AbsoluteCanvasSize").Connect(() => {
				frame.CanvasPosition = pos;
			});
			frame.CanvasPosition = pos;
			task.delay(0.5, () => conn.Disconnect());
		}
		list.frame.GetPropertyChangedSignal("CanvasPosition").Connect(() => {
			if (list.frame.Parent !== undefined) scrollMemory.set(groupIndex, list.frame.CanvasPosition);
		});
		const rowH = 40;
		const rowW = CONTENT_W - 10;
		let order = 0;
		for (const [index, name] of entries(g)) {
			const r = makeListRow(list, `Item${index}`, order++, rowH);
			const have = itemCount(s, g, index);
			makeLabel(
				r,
				"Name",
				name,
				space(3),
				0,
				200,
				rowH,
				TEXT.sm,
				have > 0 ? THEME.foreground : THEME.mutedForeground,
				{
					font: "label",
					align: "left",
					zIndex: 3,
				},
			);
			makeLabel(r, "Have", `×${fmtInt(have)}`, 214, 0, 64, rowH, TEXT.xs, THEME.mutedForeground, {
				align: "left",
				zIndex: 3,
			});
			const input = TextInput(r, "Count", {
				x: rowW - 64 - 8 - 84,
				y: 5,
				w: 84,
				h: 30,
				text: tostring(have),
				numeric: true,
				maxLength: 5,
				zIndex: 3,
			});
			Button(r, "Set", "Set", {
				x: rowW - 64 - 4,
				y: 5,
				w: 64,
				h: 30,
				size: "sm",
				variant: "secondary",
				zIndex: 3,
				onClick: () => {
					const v = input.getInt();
					if (v === undefined) return;
					edit([{ op: "item", group: g, index, count: math.clamp(v, 0, itemMax(g)) }], `${name}: ${v}`);
				},
			});
		}
		const bw = (CONTENT_W - space(2)) / 2;
		const fy = bodyH - 38;
		Button(body, "GiveAll", g === "ammo" ? "Fill all to 999" : "Give 1 of each", {
			x: 0,
			y: fy,
			w: bw,
			h: 36,
			size: "sm",
			variant: "secondary",
			onClick: () => {
				// "at least": each side raises its OWN copy, so newer counts in the running game are never lowered
				const ops: Array<AdminOp> = [];
				const want = g === "ammo" ? 999 : 1;
				for (const [index] of entries(g)) {
					ops.push({ op: "item", group: g, index, count: want, mode: "min" });
				}
				if (ops.size() === 0) p.notify("Nothing to add", "info");
				else edit(ops, `${GROUPS[group].label}: filled`);
			},
		});
		Button(body, "ClearAll", `Clear ${GROUPS[group].label.lower()}…`, {
			x: bw + space(2),
			y: fy,
			w: bw,
			h: 36,
			size: "sm",
			variant: "destructive",
			onClick: () => {
				const ops: Array<AdminOp> = [];
				for (const [index] of entries(g)) {
					if (itemCount(s, g, index) > 0) ops.push({ op: "item", group: g, index, count: 0 });
				}
				if (ops.size() === 0) {
					p.notify("Already empty", "info");
					return;
				}
				confirm(
					`Clear ${GROUPS[group].label.lower()}?`,
					`Sets every ${GROUPS[group].label.lower()} count of ${targetLabel()} to 0.`,
					"Clear",
					() => edit(ops, `${GROUPS[group].label}: cleared`),
				);
			},
		});
	};

	const buildCostumes = (s: PlayerSaveData): void => {
		makeLabel(
			body,
			"Hint",
			"Costumes unlock their pet / deco permanently (normally bought with coins).",
			0,
			0,
			CONTENT_W,
			20,
			TEXT.xs,
			THEME.mutedForeground,
			{
				align: "left",
			},
		);
		const list = makeScrollList(body, "Costumes", 0, 26, CONTENT_W, bodyH - 26);
		COSTUMES.forEach((c, i) => {
			const r = makeListRow(list, `Costume${i}`, i, 44);
			const owned = Switch(r, "Owned", {
				x: space(3),
				y: 7,
				w: CONTENT_W - 10 - space(6),
				label: `${c.name} · ${fmtInt(c.price)} coins`,
				value: (s.costumes[i] ?? 0) > 0,
				zIndex: 3,
				onChange: v =>
					edit([{ op: "costume", id: i, owned: v }], `${c.name}: ${v ? "unlocked" : "locked"}`, () => {
						if (owned.frame.Parent !== undefined) owned.set(!v);
					}),
			});
		});
	};

	const buildReset = (): void => {
		makeLabel(
			body,
			"Warning",
			`Replaces ${targetLabel()}'s save with a new player's: level 1, day 1, starter kit, starting coins, no packs, no costumes, no achievements. Settings are kept. The running game goes back to the lobby. This cannot be undone.`,
			0,
			0,
			CONTENT_W,
			90,
			TEXT.sm,
			THEME.foreground,
			{ align: "left", valign: "top" },
		);
		Button(body, "Reset", "Reset save…", {
			x: 0,
			y: 100,
			w: 220,
			h: 40,
			variant: "destructive",
			onClick: () =>
				confirm(
					`Reset ${targetLabel()}'s save?`,
					"Everything but the settings is erased. This cannot be undone.",
					"Reset save",
					() =>
						task.spawn(() => {
							const target = p.target;
							const mySeq = ++seq;
							const res = p.request({ kind: "resetSave", userId: target }, "Save reset");
							if (!res.ok) return;
							p.refreshPlayers();
							if (mySeq !== seq || target !== p.target) return;
							if (typeIs(res.data, "table")) save = sanitizeStoredSave(res.data);
							buildBody();
						}),
				),
		});
	};

	/** destructive confirmation dialog */
	const confirm = (title: string, text: string, action: string, onYes: () => void): void => {
		const w = 480;
		const h = 230;
		const dlg = Dialog(p.layer, "ConfirmDialog", { w, h, title, zIndex: 200 });
		const pad = space(6);
		makeLabel(dlg.card, "Body", text, pad, dlg.contentY, w - pad * 2, 60, TEXT.sm, THEME.mutedForeground, {
			align: "left",
			valign: "top",
		});
		const fy = h - pad - 40;
		Button(dlg.card, "Cancel", "Cancel", {
			x: w - pad - 300 - space(2),
			y: fy,
			w: 140,
			h: 40,
			variant: "secondary",
			onClick: () => dlg.close(),
		});
		Button(dlg.card, "Yes", action, {
			x: w - pad - 160,
			y: fy,
			w: 160,
			h: 40,
			variant: "destructive",
			onClick: () => {
				dlg.close();
				onYes();
			},
		});
	};

	const buildBody = (): void => {
		// an answer can arrive after the section was closed (its frames are gone then)
		if (body.Parent === undefined) return;
		clearChildren(body);
		const s = save;
		if (s === undefined) {
			makeLabel(
				body,
				"Loading",
				loading ? "Loading the save…" : "Save not available.",
				0,
				0,
				CONTENT_W,
				24,
				TEXT.sm,
				THEME.mutedForeground,
				{
					align: "left",
				},
			);
			return;
		}
		if (tab === 0) buildStats(s);
		else if (tab === 1) buildItems(s);
		else if (tab === 2) buildCostumes(s);
		else buildReset();
	};

	let reloadBtn: TextButton | undefined;
	let prevBtn: TextButton | undefined;
	let nextBtn: TextButton | undefined;
	const setHeaderEnabled = (on: boolean): void => {
		for (const b of [reloadBtn, prevBtn, nextBtn]) if (b !== undefined) setButtonEnabled(b, on);
	};
	const load = (): void => {
		loading = true;
		save = undefined;
		scrollMemory.clear();
		const target = p.target;
		const mySeq = ++seq;
		buildBody();
		buildHeader();
		setHeaderEnabled(false);
		task.spawn(() => {
			const res = p.request({ kind: "save", userId: target });
			// a newer load / another target: this answer is stale
			if (mySeq !== seq || target !== p.target) return;
			loading = false;
			if (res.ok && typeIs(res.data, "table")) {
				const d = res.data as { row: PlayerRow; save: unknown };
				row = d.row;
				save = sanitizeStoredSave(d.save);
			}
			setHeaderEnabled(true);
			buildHeader();
			buildBody();
		});
	};

	const step = (dir: number): void => {
		if (loading) return;
		const list = p.players;
		if (list.size() === 0) return;
		let i = list.findIndex(r => r.userId === p.target);
		i = (i + dir + list.size()) % list.size();
		p.target = list[i].userId;
		load();
	};

	let targetText: TextLabel | undefined;
	const headerText = (): string => {
		const lvl = row !== undefined && row.userId === p.target ? ` · Lv ${row.level} · Day ${row.day}` : "";
		return `Editing: ${targetLabel()}${lvl}`;
	};
	const buildHeader = (): void => {
		if (header.Parent === undefined) return;
		if (targetText !== undefined) {
			targetText.Text = headerText();
			return;
		}
		prevBtn = Button(header, "Prev", "<", {
			x: 0,
			y: 0,
			w: 34,
			h: 34,
			size: "icon",
			variant: "outline",
			onClick: () => step(-1),
		});
		targetText = makeLabel(
			header,
			"Target",
			headerText(),
			42,
			0,
			CONTENT_W - 42 - 42 - 108,
			34,
			TEXT.sm,
			THEME.foreground,
			{
				font: "label",
				align: "left",
			},
		);
		nextBtn = Button(header, "Next", ">", {
			x: CONTENT_W - 108 - 42,
			y: 0,
			w: 34,
			h: 34,
			size: "icon",
			variant: "outline",
			onClick: () => step(1),
		});
		reloadBtn = Button(header, "Reload", "Reload", {
			x: CONTENT_W - 100,
			y: 0,
			w: 100,
			h: 34,
			size: "sm",
			variant: "outline",
			onClick: load,
		});
	};

	Tabs(content, "Tabs", {
		x: 0,
		y: tabsY,
		w: CONTENT_W,
		h: 34,
		items: ["Stats", "Items", "Costumes", "Reset"],
		value: tab,
		onChange: i => {
			tab = i;
			buildBody();
		},
	});
	if (p.players.find(r => r.userId === p.target) === undefined) p.target = p.selfUserId;
	load();

	return {
		onPlayers(): void {
			if (!loading) buildHeader();
		},
	};
}
