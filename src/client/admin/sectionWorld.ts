import { TEXT, THEME, space } from "../ui/theme";
import { Button, Slider, SliderHandle, Tabs, clearChildren, makeLabel } from "../ui/widgets";
import { Switch, SwitchHandle } from "./controls";
import { confirmAction } from "../ui/numberField";
import { logLocal } from "./net";
import { CONTENT_H, CONTENT_W, PanelCtx, SectionHandle, region } from "./panelTypes";
import { ActionResult, BUILDING_KINDS, OverlayKind } from "./world";

/*
 * World, Camera and Debug: tools for the admin's OWN world (every client simulates its own), all through AdminWorld.
 * They do not touch the save directly; the survivor's progress still reaches the server through the normal reports
 * (which the server trusts for admins: no time-based plausibility limits).
 */

/** Ctrl+click teleport switch (read by adminClient) */
export const worldPrefs = { ctrlTeleport: true };

function hhmm(hour: number): string {
	const h = math.floor(hour) % 24;
	const m = math.floor((hour - math.floor(hour)) * 60);
	return string.format("%02d:%02d", h, m);
}

function report(p: PanelCtx, res: ActionResult, action: string): void {
	p.notify(res.message, res.ok ? "success" : "error");
	if (res.ok) logLocal(action, res.message);
}

function needRun(p: PanelCtx): boolean {
	if (p.world.ready()) return true;
	p.notify("Start a run first: world tools act on your own world", "error");
	return false;
}

const worldMemory = { tab: 0 };

export function buildWorld(p: PanelCtx, content: Frame): SectionHandle {
	const bodyY = 42;
	const bodyH = CONTENT_H - bodyY;
	const body = region(content, "Body", 0, bodyY, CONTENT_W, bodyH);
	let slider: SliderHandle | undefined;
	let statusLabel: TextLabel | undefined;
	let rain: SwitchHandle | undefined;
	let draggingHour: number | undefined;
	const switches: Array<[SwitchHandle, () => boolean]> = [];

	const cleanup = (): void => {
		slider?.disconnect();
		slider = undefined;
		statusLabel = undefined;
		rain = undefined;
		switches.clear();
	};

	const buildTime = (): void => {
		statusLabel = makeLabel(body, "Status", "", 0, 0, CONTENT_W, 40, TEXT.sm, THEME.foreground, {
			font: "label",
			align: "left",
			valign: "top",
		});
		makeLabel(body, "HourLabel", "Time of day (drag)", 0, 44, CONTENT_W, 18, TEXT.xs, THEME.mutedForeground, {
			align: "left",
		});
		slider = Slider(body, "Hour", {
			x: 0,
			y: 62,
			w: CONTENT_W,
			h: 26,
			step: 1 / 48,
			get: () => (draggingHour ?? (p.world.ready() ? p.world.clock().hour : 7)) / 24,
			set: v => {
				if (!needRun(p)) return;
				draggingHour = math.clamp(v * 24, 0, 23.99);
				p.world.setClock(draggingHour);
				logLocal("clock", `set to ${hhmm(draggingHour)}`);
				task.delay(0.3, () => {
					draggingHour = undefined;
				});
			},
		});
		const bw = (CONTENT_W - space(2) * 2) / 3;
		const act = (name: string, text: string, i: number, fn: () => ActionResult, action: string): void => {
			Button(body, name, text, {
				x: i * (bw + space(2)),
				y: 100,
				w: bw,
				h: 36,
				size: "sm",
				variant: "secondary",
				onClick: () => {
					if (needRun(p)) report(p, fn(), action);
				},
			});
		};
		act("Night", "Skip to night", 0, () => p.world.skipToNight(), "clock");
		act("Dawn", "Dawn", 1, () => p.world.skipToDawn(), "clock");
		act("Wave", "Force next wave", 2, () => p.world.forceWave(), "wave");
		rain = Switch(body, "Rain", {
			x: 0,
			y: 148,
			w: CONTENT_W,
			label: "Rain",
			description: "Darker, and every zombie hunts (re-rolled at the next day)",
			value: p.world.ready() && p.world.clock().raining,
			onChange: v => {
				if (!needRun(p)) {
					rain?.set(!v);
					return;
				}
				p.world.setRain(v);
				logLocal("weather", v ? "rain on" : "rain off");
			},
		});
		const hw = (CONTENT_W - space(2)) / 2;
		Button(body, "Kill", "Kill all zombies", {
			x: 0,
			y: 208,
			w: hw,
			h: 36,
			size: "sm",
			variant: "destructive",
			// destructive (DESIGN_RULES UI-12): asks first
			onClick: () => {
				if (!needRun(p)) return;
				confirmAction(p.layer, {
					title: "Kill all zombies?",
					body: "Every zombie and boss is removed outright: no XP, no loot, no exploder blasts. The run becomes assisted.",
					action: "Kill all",
					onConfirm: () => {
						if (needRun(p)) report(p, p.world.killAll(), "killAll");
					},
				});
			},
		});
		Button(body, "Clear", "Clear bodies & blood", {
			x: hw + space(2),
			y: 208,
			w: hw,
			h: 36,
			size: "sm",
			variant: "destructive",
			onClick: () => {
				if (!needRun(p)) return;
				confirmAction(p.layer, {
					title: "Clear bodies and blood?",
					body: "Every corpse and blood stain in your world is removed.",
					action: "Clear",
					onConfirm: () => {
						if (needRun(p)) report(p, p.world.clearCorpses(), "clear");
					},
				});
			},
		});
		makeLabel(
			body,
			"KillHint",
			"Kill all removes zombies and bosses outright: no XP, no loot, no exploder blasts.",
			0,
			250,
			CONTENT_W,
			30,
			TEXT.xs,
			THEME.mutedForeground,
			{ align: "left", valign: "top" },
		);
	};

	const toggle = (
		y: number,
		label: string,
		description: string,
		get: () => boolean,
		set: (v: boolean) => void,
		action: string,
	): void => {
		const s = Switch(body, `Switch${y}`, {
			x: 0,
			y,
			w: CONTENT_W,
			label,
			description,
			value: get(),
			onChange: v => {
				set(v);
				logLocal(action, v ? "on" : "off");
			},
		});
		switches.push([s, get]);
	};

	const buildSurvivor = (): void => {
		Button(body, "Heal", "Heal & feed", {
			x: 0,
			y: 0,
			w: 200,
			h: 36,
			size: "sm",
			variant: "secondary",
			onClick: () => {
				if (needRun(p)) report(p, p.world.heal(), "heal");
			},
		});
		const w = p.world;
		toggle(
			50,
			"God mode",
			"No damage, no starvation, no poison",
			() => w.god(),
			v => w.setGod(v),
			"god",
		);
		toggle(
			102,
			"Infinite ammo",
			"Magazines never empty; spent ammo / fuel is given back",
			() => w.infiniteAmmo(),
			v => w.setInfiniteAmmo(v),
			"infiniteAmmo",
		);
		toggle(
			154,
			"Noclip",
			"Walk through walls, cars and trees",
			() => w.noclip(),
			v => w.setNoclip(v),
			"noclip",
		);
		toggle(
			206,
			"Ctrl+click teleport",
			"Ctrl + left click on the map teleports the survivor there",
			() => worldPrefs.ctrlTeleport,
			v => {
				worldPrefs.ctrlTeleport = v;
			},
			"ctrlTeleport",
		);
		Button(body, "Teleport", "Teleport to cursor…", {
			x: 0,
			y: 266,
			w: 200,
			h: 36,
			size: "sm",
			variant: "outline",
			onClick: () => p.placement.begin({ kind: "teleport", label: "teleport (click where)" }),
		});
	};

	const buildTeleport = (): void => {
		makeLabel(
			body,
			"Hint",
			"Each press goes to the next one of that kind, in front of its door.",
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
		const colW = (CONTENT_W - space(2)) / 2;
		BUILDING_KINDS.forEach((b, i) => {
			const n = p.world.ready() ? p.world.buildingCount(b.type) : 0;
			Button(body, `Building${i}`, `${b.label} (${n})`, {
				x: (i % 2) * (colW + space(2)),
				y: 26 + math.floor(i / 2) * 40,
				w: colW,
				h: 34,
				size: "sm",
				variant: "outline",
				disabled: n === 0,
				onClick: () => {
					if (needRun(p)) report(p, p.world.teleportToBuilding(b.type), "teleport");
				},
			});
		});
	};

	const build = (): void => {
		cleanup();
		clearChildren(body);
		if (worldMemory.tab === 0) buildTime();
		else if (worldMemory.tab === 1) buildSurvivor();
		else buildTeleport();
	};

	Tabs(content, "Tabs", {
		x: 0,
		y: 0,
		w: CONTENT_W,
		h: 34,
		items: ["Time & weather", "Survivor", "Teleport"],
		value: worldMemory.tab,
		onChange: i => {
			worldMemory.tab = i;
			build();
		},
	});
	build();

	return {
		update(): void {
			if (statusLabel !== undefined) {
				if (p.world.ready()) {
					const c = p.world.clock();
					const phase = c.night ? "Night" : "Day";
					const wave = c.wave > 0 ? ` · wave ${c.wave}` : "";
					statusLabel.Text = `Day ${c.day} · ${hhmm(c.hour)} · ${phase}${wave} · ${c.raining ? "Rain" : "Clear"}`;
					if (rain !== undefined && rain.get() !== c.raining) rain.set(c.raining);
				} else {
					statusLabel.Text = "No run on screen: start a run to use the world tools.";
				}
				slider?.refresh();
			}
			for (const [s, get] of switches) {
				if (s.get() !== get()) s.set(get());
			}
		},
		destroy(): void {
			cleanup();
		},
	};
}

// ---------------------------------------------------------------- camera

export function buildCamera(p: PanelCtx, content: Frame): SectionHandle {
	const w = p.world;
	let zoomSlider: SliderHandle | undefined;
	const free = Switch(content, "FreeCam", {
		x: 0,
		y: 0,
		w: CONTENT_W,
		label: "Free camera",
		description: "WASD / arrows move · Shift = faster · wheel zooms · the survivor is frozen and invulnerable",
		value: w.freeCam(),
		onChange: v => {
			if (v && !needRun(p)) {
				free.set(false);
				return;
			}
			w.setFreeCam(v);
			logLocal("freeCam", v ? "on" : "off");
		},
	});
	const zoomLabel = makeLabel(content, "ZoomLabel", "", 0, 60, CONTENT_W, 20, TEXT.sm, THEME.foreground, {
		font: "label",
		align: "left",
	});
	zoomSlider = Slider(content, "Zoom", {
		x: 0,
		y: 84,
		w: CONTENT_W,
		h: 26,
		step: 0.1 / 1.5,
		get: () => (w.zoom() - 0.5) / 1.5,
		set: v => {
			if (!w.freeCam()) {
				p.notify("Turn the free camera on to zoom", "info");
				return;
			}
			w.setZoom(0.5 + v * 1.5);
		},
	});
	Button(content, "Back", "Back to the survivor", {
		x: 0,
		y: 124,
		w: 220,
		h: 36,
		size: "sm",
		variant: "secondary",
		onClick: () => {
			w.setFreeCam(false);
			free.set(false);
		},
	});
	makeLabel(
		content,
		"Note",
		"The camera only changes your own view. Watching another player's game is not possible yet: every client simulates its own world (see Players → Follow live).",
		0,
		176,
		CONTENT_W,
		60,
		TEXT.xs,
		THEME.mutedForeground,
		{ align: "left", valign: "top" },
	);
	return {
		update(): void {
			zoomLabel.Text = `Zoom ${string.format("%.2f", w.zoom())}× ${w.freeCam() ? "" : "(free camera only)"}`;
			if (free.get() !== w.freeCam()) free.set(w.freeCam());
			zoomSlider?.refresh();
		},
		destroy(): void {
			zoomSlider?.disconnect();
			zoomSlider = undefined;
		},
	};
}

// ---------------------------------------------------------------- debug

const DEBUG_SWITCHES: Array<{ kind: OverlayKind; label: string; description: string }> = [
	{
		kind: "solids",
		label: "Solid hitboxes",
		description: "Yellow = blocks bodies · grey = passable (roofs, open doors)",
	},
	{
		kind: "actors",
		label: "Actor hitboxes",
		description: "Green = survivor · yellow / red = zombie wandering / chasing · boss · item pickup",
	},
	{
		kind: "flow",
		label: "Pathfinding flow field",
		description: "Blue arrows lead to the survivor · red = unreachable · green ring = target",
	},
	{
		kind: "lights",
		label: "Light sources",
		description: "Survivor light and lamps / fires (grey ring = switched off)",
	},
	{ kind: "stats", label: "Stats card", description: "FPS, zombies, solids in view, sprites, GameGui instances" },
];

export function buildDebug(p: PanelCtx, content: Frame): SectionHandle {
	DEBUG_SWITCHES.forEach((d, i) => {
		Switch(content, `Debug${i}`, {
			x: 0,
			y: i * 56,
			w: CONTENT_W,
			label: d.label,
			description: d.description,
			value: d.kind === "stats" ? p.statsCard() : p.world.overlay(d.kind),
			onChange: v => {
				if (d.kind === "stats") p.setStatsCard(v);
				else p.world.setOverlay(d.kind, v);
				logLocal("debug", `${d.label} ${v ? "on" : "off"}`);
			},
		});
	});
	makeLabel(
		content,
		"Note",
		"Overlays are drawn above the night so they stay readable. They only exist on your screen.",
		0,
		DEBUG_SWITCHES.size() * 56 + 8,
		CONTENT_W,
		34,
		TEXT.xs,
		THEME.mutedForeground,
		{ align: "left", valign: "top" },
	);
	return {};
}
