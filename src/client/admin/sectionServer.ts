import { ADMIN_LIMITS, AuditEntry, ServerInfo, SimMetrics } from "shared/admin/protocol";
import { TEXT, THEME, space } from "../ui/theme";
import { Button, Tabs, clearChildren, makeLabel, makeListRow, makeScrollList, setButtonEnabled } from "../ui/widgets";
import { TextInput } from "./controls";
import { CONTENT_H, CONTENT_W, PanelCtx, SectionHandle, clearRows, durationText, region } from "./panelTypes";

/*
 * Server: announcement to every player of this server (text-filtered by the server, shown as a banner), what the
 * server knows about itself (JobId, uptime, DataStore state) and the admin audit log (memory + ProjectZ_AdminLog).
 */

const serverMemory = { tab: 0 };

function timeText(t: number): string {
	return os.date("!%Y-%m-%d %H:%M:%S", t);
}

/** milliseconds as the panel shows them: two decimals, or three below 0.1 ms */
function msText(ms: number): string {
	return string.format(ms < 0.1 ? "%.3f" : "%.2f", ms);
}

/**
 * The simulation's §12.2 lines (server/net/mpHost.ts publishes them once a second): the tick against its 6 ms p95
 * budget, then what each phase of it cost on average over the last second -- the zero ones left out.
 */
function simLines(m: SimMetrics): Array<string> {
	const phases = new Array<string>();
	for (const p of m.phases) {
		if (p.ms >= 0.0005) phases.push(`${p.name} ${msText(p.ms)}`);
	}
	return [
		`Tick: avg ${msText(m.tickAvgMs)} ms · p95 ${msText(m.tickP95Ms)} ms (budget 6) · ${m.zombies} zombies`,
		`Backlog ${m.backlogMs} ms · dropped ticks ${m.droppedTicks} · tick errors ${m.tickErrors}`,
		`Per tick (ms): ${phases.size() > 0 ? phases.join(" · ") : "nothing measured yet"}`,
	];
}

export function buildServer(p: PanelCtx, content: Frame): SectionHandle {
	const bodyY = 42;
	const bodyH = CONTENT_H - bodyY;
	const body = region(content, "Body", 0, bodyY, CONTENT_W, bodyH);

	const buildAnnounce = (): void => {
		makeLabel(
			body,
			"Hint",
			"Shown as a banner to every player in this server (not other servers). The text goes through the Roblox text filter first.",
			0,
			0,
			CONTENT_W,
			36,
			TEXT.xs,
			THEME.mutedForeground,
			{ align: "left", valign: "top" },
		);
		const counter = makeLabel(body, "Counter", "", 0, 88, CONTENT_W, 18, TEXT.xs, THEME.mutedForeground, {
			align: "right",
		});
		let send: TextButton | undefined;
		const doSend = (): void => {
			const text = input.get();
			if (text === "" || send === undefined) return;
			const b = send;
			setButtonEnabled(b, false);
			task.spawn(() => {
				const res = p.request({ kind: "announce", text }, "Announcement sent");
				if (res.ok) input.set("");
				setButtonEnabled(b, true);
			});
		};
		const input = TextInput(body, "Text", {
			x: 0,
			y: 42,
			w: CONTENT_W,
			h: 40,
			placeholder: "Announcement (Enter sends)",
			maxLength: ADMIN_LIMITS.ANNOUNCE,
			onSubmit: doSend,
		});
		const refreshCounter = (): void => {
			counter.Text = `${input.get().size()}/${ADMIN_LIMITS.ANNOUNCE}`;
		};
		input.box.GetPropertyChangedSignal("Text").Connect(refreshCounter);
		refreshCounter();
		send = Button(body, "Send", "Send to everyone", {
			x: 0,
			y: 112,
			w: 220,
			h: 40,
			variant: "default",
			onClick: doSend,
		});
	};

	const buildInfo = (): void => {
		// as tall as the tab allows, the button at the bottom like the audit log's: the simulation's lines wrap
		const text = makeLabel(body, "Info", "Loading…", 0, 0, CONTENT_W, bodyH - 46, TEXT.sm, THEME.foreground, {
			align: "left",
			valign: "top",
		});
		const load = (): void => {
			task.spawn(() => {
				const res = p.request({ kind: "serverInfo" });
				if (!res.ok || !typeIs(res.data, "table") || text.Parent === undefined) return;
				const i = res.data as ServerInfo;
				const lines = [
					`JobId: ${i.jobId}`,
					`Place: ${i.placeId} · version ${i.placeVersion}${i.studio ? " · Studio" : ""}`,
					`Uptime: ${durationText(i.uptime)}`,
					`Players: ${i.players} / ${i.maxPlayers}`,
					`Save DataStore: ${i.dataStore}`,
					`Audit log DataStore: ${i.auditStore}`,
				];
				if (i.sim !== undefined) for (const line of simLines(i.sim)) lines.push(line);
				text.Text = lines.join("\n");
			});
		};
		Button(body, "Refresh", "Refresh", {
			x: 0,
			y: bodyH - 38,
			w: 140,
			h: 36,
			size: "sm",
			variant: "outline",
			onClick: load,
		});
		load();
	};

	const buildAudit = (): void => {
		const list = makeScrollList(body, "Log", 0, 0, CONTENT_W, bodyH - 46);
		const load = (): void => {
			task.spawn(() => {
				const res = p.request({ kind: "auditLog" });
				if (!res.ok || !typeIs(res.data, "table") || list.frame.Parent === undefined) return;
				clearRows(list.frame);
				const entries = res.data as Array<AuditEntry>;
				if (entries.size() === 0) {
					const r = makeListRow(list, "Empty", 0, 34);
					makeLabel(
						r,
						"Text",
						"No admin actions yet.",
						space(3),
						0,
						CONTENT_W - space(6),
						34,
						TEXT.sm,
						THEME.mutedForeground,
						{
							align: "left",
							zIndex: 3,
						},
					);
					return;
				}
				entries.forEach((e, i) => {
					const r = makeListRow(list, `Entry${i}`, i, 58);
					const head = `${timeText(e.t)} UTC · ${e.admin} · ${e.action}${e.target !== "" ? ` → ${e.target}` : ""}`;
					makeLabel(
						r,
						"Head",
						head,
						space(3),
						4,
						CONTENT_W - space(6),
						20,
						TEXT.xs,
						e.ok ? THEME.foreground : THEME.destructive,
						{
							font: "label",
							align: "left",
							zIndex: 3,
						},
					);
					makeLabel(
						r,
						"Details",
						e.details !== "" ? e.details : "—",
						space(3),
						24,
						CONTENT_W - space(6),
						30,
						TEXT.xs,
						THEME.mutedForeground,
						{
							align: "left",
							valign: "top",
							zIndex: 3,
						},
					);
				});
			});
		};
		Button(body, "Refresh", "Refresh", {
			x: 0,
			y: bodyH - 38,
			w: 140,
			h: 36,
			size: "sm",
			variant: "outline",
			onClick: load,
		});
		load();
	};

	const build = (): void => {
		clearChildren(body);
		if (serverMemory.tab === 0) buildAnnounce();
		else if (serverMemory.tab === 1) buildInfo();
		else buildAudit();
	};

	Tabs(content, "Tabs", {
		x: 0,
		y: 0,
		w: CONTENT_W,
		h: 34,
		items: ["Announce", "Server info", "Audit log"],
		value: serverMemory.tab,
		onChange: i => {
			serverMemory.tab = i;
			build();
		},
	});
	build();
	return {};
}
