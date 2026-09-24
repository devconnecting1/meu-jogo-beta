import { TEXT, THEME, space } from "../ui/theme";
import { Button, Slider, SliderHandle, Tabs, clearChildren, makeLabel } from "../ui/widgets";
import { Switch, SwitchHandle } from "./controls";
import { confirmAction } from "../ui/numberField";
import * as Kit from "../ui/window";
import { logLocal } from "./net";
import { CONTENT_H, CONTENT_W, PanelCtx, SectionHandle, region } from "./panelTypes";
import { ActionResult, BUILDING_KINDS, OverlayKind } from "./world";
import { Weather, weatherName } from "shared/sim/weather";

/*
 * World, Camera and Debug, all through AdminWorld. Where the server owns the world (MP_PHASE 2) every tool here is a
 * request the SERVER validates and runs (client/admin/serverWorld.ts, docs/MULTIPLAYER.md §10): the toast is its
 * answer -- success only on its OK -- and it writes the audit line and decides whose run becomes assisted. Where this
 * client simulates its own world (offline, MP_PHASE < 2) they act on that copy, as they always did. None of them edits
 * the save directly.
 */

/** Ctrl+click teleport switch (read by adminClient) */
export const worldPrefs = { ctrlTeleport: true };

function hhmm(hour: number): string {
	const h = math.floor(hour) % 24;
	const m = math.floor((hour - math.floor(hour)) * 60);
	return string.format("%02d:%02d", h, m);
}

/** the toast is the answer (the server's, on a server-owned world); only a local tool is logged from here */
function report(p: PanelCtx, res: ActionResult, action: string): void {
	p.notify(res.message, res.ok ? "success" : "error");
	if (res.ok && res.audited !== true) logLocal(action, res.message);
}

function needRun(p: PanelCtx): boolean {
	if (p.world.ready()) return true;
	p.notify("Start a run first: world tools need your survivor in the town", "error");
	return false;
}

const worldMemory = { tab: 0 };

export function buildWorld(p: PanelCtx, content: Frame): SectionHandle {
	const bodyY = 42;
	const bodyH = CONTENT_H - bodyY;
	const body = region(content, "Body", 0, bodyY, CONTENT_W, bodyH);
	let slider: SliderHandle | undefined;
	let statusLabel: TextLabel | undefined;
	let draggingHour: number | undefined;
	const switches: Array<[SwitchHandle, () => boolean]> = [];

	const cleanup = (): void => {
		slider?.disconnect();
		slider = undefined;
		statusLabel = undefined;
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
				// a server-owned clock is logged by the server (one line for a whole drag)
				if (!p.world.serverWorld()) logLocal("clock", `set to ${hhmm(draggingHour)}`);
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
		// the day's weather (LUZ-05), for everyone on the server, until midnight rolls the next day's
		makeLabel(
			body,
			"WeatherLabel",
			"Weather today (fog blinds both sides, thunder hides noise)",
			0,
			142,
			CONTENT_W,
			18,
			TEXT.xs,
			THEME.mutedForeground,
			{ align: "left" },
		);
		const weathers = [Weather.Clear, Weather.Rain, Weather.Storm, Weather.DawnFog, Weather.Fog];
		const ww = (CONTENT_W - space(1) * (weathers.size() - 1)) / weathers.size();
		for (let i = 0; i < weathers.size(); i++) {
			const kind = weathers[i];
			Button(body, `Weather${i + 1}`, weatherName(kind), {
				x: i * (ww + space(1)),
				y: 162,
				w: ww,
				h: 36,
				size: "sm",
				variant: "secondary",
				onClick: () => {
					if (needRun(p)) report(p, p.world.setWeather(kind), "weather");
				},
			});
		}
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
					body: p.world.serverWorld()
						? "Every zombie and boss in the town is removed: no XP, no loot, no blasts. Every run in the town becomes assisted."
						: "Every zombie and boss is removed outright: no XP, no loot, no exploder blasts. The run becomes assisted.",
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
					body: p.world.serverWorld()
						? "Every corpse, blood stain and acid puddle is removed, for everyone in this server."
						: "Every corpse and blood stain in your world is removed.",
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
			p.world.serverWorld()
				? "These act on the whole server. The clock, a wave and Kill all make every run in the town assisted (no coins, titles or records)."
				: "Kill all removes zombies and bosses outright: no XP, no loot, no exploder blasts.",
			0,
			250,
			CONTENT_W,
			44,
			TEXT.xs,
			THEME.mutedForeground,
			{ align: "left", valign: "top" },
		);
	};

	/** `set` answers what happened (the server's word on a server-owned world); undefined = a panel preference */
	const toggle = (
		y: number,
		label: string,
		description: string,
		get: () => boolean,
		set: (v: boolean) => ActionResult | undefined,
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
				const res = set(v);
				if (res === undefined) {
					logLocal(action, v ? "on" : "off");
					return;
				}
				// refused: the switch shows what is really on (the per-frame sync below keeps it there)
				if (!res.ok) s.set(get());
				report(p, res, action);
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
			"Mags never empty; ammo and fuel come back",
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
			"Ctrl + left click teleports the survivor",
			() => worldPrefs.ctrlTeleport,
			v => {
				worldPrefs.ctrlTeleport = v;
				return undefined;
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
					statusLabel.Text = `Day ${c.day} · ${hhmm(c.hour)} · ${phase}${wave} · ${weatherName(c.weather)}`;
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
		description: "WASD / arrows · Shift faster · wheel zooms",
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
	makeLabel(
		content,
		"FreeCamNote",
		w.serverWorld()
			? "Your survivor stands still meanwhile, and can still be hurt."
			: "While it is on, the survivor is frozen and cannot be hurt.",
		0,
		Kit.SETTING_DESC_ROW_H + 4,
		CONTENT_W,
		16,
		TEXT.xs,
		THEME.mutedForeground,
		{ align: "left" },
	);
	const zoomLabel = makeLabel(content, "ZoomLabel", "", 0, 72, CONTENT_W, 20, TEXT.sm, THEME.foreground, {
		font: "label",
		align: "left",
	});
	zoomSlider = Slider(content, "Zoom", {
		x: 0,
		y: 96,
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
		y: 136,
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
		w.serverWorld()
			? "The server sends you what is around the camera, up to 3000 u from your survivor (items stay around the survivor). Watching another player is not possible yet (see Players → Follow live)."
			: "The camera only changes your own view. Watching another player's game is not possible yet: every client simulates its own world (see Players → Follow live).",
		0,
		188,
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

const DEBUG_SWITCHES: Array<{ kind: OverlayKind; label: string; description: string; legend: string }> = [
	{
		kind: "solids",
		label: "Solid hitboxes",
		description: "What stops a body",
		legend: "Yellow = blocks bodies · grey = passable (roofs, open doors)",
	},
	{
		kind: "actors",
		label: "Actor hitboxes",
		description: "Survivor, zombies, bosses and pickups",
		legend: "Green = survivor · yellow / red = zombie wandering / chasing · boss · item pickup",
	},
	{
		kind: "flow",
		label: "Pathfinding flow field",
		description: "The field the zombies follow",
		legend: "Blue arrows lead to the survivor · red = unreachable · green ring = target",
	},
	{
		kind: "lights",
		label: "Light sources",
		description: "Your light, lamps and fires",
		legend: "Grey ring = switched off",
	},
	{
		kind: "stats",
		label: "Stats card",
		description: "The frame's numbers in a card",
		legend: "FPS, zombies, sprites, GameGui instances · graphics tier, night strips · engine frame, draws, memory",
	},
];

/** one debug entry: the switch row (the kit's form row) and its legend under it, up to two lines */
const DEBUG_LEGEND_H = 28;
const DEBUG_STRIDE = Kit.SETTING_DESC_ROW_H + 2 + DEBUG_LEGEND_H + 4;

export function buildDebug(p: PanelCtx, content: Frame): SectionHandle {
	// the pathfinding field only exists where this client runs the horde: on a server-owned world it is the server's,
	// and a switch that draws nothing is not offered
	const field = p.world.hasFlowField();
	if (!field && p.world.overlay("flow")) p.world.setOverlay("flow", false);
	const shown = DEBUG_SWITCHES.filter(d => d.kind !== "flow" || field);
	shown.forEach((d, i) => {
		const y = i * DEBUG_STRIDE;
		Switch(content, `Debug${i}`, {
			x: 0,
			y,
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
		makeLabel(
			content,
			`Debug${i}Legend`,
			d.legend,
			0,
			y + Kit.SETTING_DESC_ROW_H + 2,
			CONTENT_W,
			DEBUG_LEGEND_H,
			TEXT.xs,
			THEME.mutedForeground,
			{ align: "left", valign: "top" },
		);
	});
	makeLabel(
		content,
		"Note",
		field
			? "Overlays are drawn above the night so they stay readable. They only exist on your screen."
			: "Overlays are drawn above the night and only exist on your screen. The zombies' pathfinding runs on the server: there is no field here to draw.",
		0,
		shown.size() * DEBUG_STRIDE,
		CONTENT_W,
		34,
		TEXT.xs,
		THEME.mutedForeground,
		{ align: "left", valign: "top" },
	);
	return {};
}
