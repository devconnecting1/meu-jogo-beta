/*
 * The sky: the HUD's day clock (docs/DESIGN_RULES.md UI-09, MP-13 / MP-20, MP-21). It replaces the "Day 1 | Afternoon"
 * plate that floated at the top centre -- the last loose card of the HUD (UI-09: "one console") -- and it answers the
 * two questions a survivor actually has about the time: HOW LONG UNTIL THE HORDE, and how long the night still lasts.
 *
 *   the sky window (a dark groove)           desktop: a section at the LEFT end of the console (hudConsole.ts)
 *   .-------------------------------.        touch:   a plate in the top corner, under Menu and Bag -- the thumbs
 *   |          .  .  O  .           |                 own the bottom (hudConsole.ts placeTouchSky)
 *   |      .    the sun, or the moon .  |
 *   | ~       travels the arc      ! |    <- red pips: where the horde comes (nightfall by day; the three waves at night);
 *   |                               |       top left, the weather when there is some (LUZ-05): rain, storm, fog
 *   |_______________________________|    <- the horizon
 *   |            Day 5              |    <- the WORLD's day (MP-20), ExtraBold
 *   |        Night in 2:10          |    <- real seconds to 19:00 by day, to daybreak (06:00) at night
 *   |     Life day 2 · 14:30        |    <- only when there is something to say: this life's day where it has parted
 *   '-------------------------------'       from the world's (MP-13 / MP-20), HH:MM with a watch (the item perk)
 *
 * What it reads, and where from -- nothing is invented:
 *  - the arc: the sun rises at the left horizon at 06:00 and sets at the right at 19:00; at night the moon does the same
 *    from 19:00 to 06:00. Its place is the share of the phase gone by in REAL seconds (shared/sim/clock.ts
 *    `secondsUntilHour`), which is also the share in game hours, since each phase runs at one speed. The dots it has
 *    passed go dim: what is left of the day is the bright part of the path.
 *  - the pips are the horde's schedule (clock.ts CLOCK_ANNOUNCEMENTS / `waveActive`): by day one, at the sunset end --
 *    the horde comes at nightfall; at night the three waves (19:00, 22:00, 01:00), dimmed once they have started.
 *  - the countdown is `secondsUntilHour` to NIGHTFALL_HOUR by day and DAY_BREAK_HOUR at night, written by the dawn
 *    wait's own `countdown` (M:SS, never negative) and, at night, in its words ("Daybreak in", MP-21), with the number
 *    in the item card's yellow (STAT.value, the numbers' voice): a game hour is not a real minute, and the countdown is
 *    the one the player sits through.
 *  - in the last NIGHTFALL_WARN_S seconds before 19:00 the number turns red and pulses once a second (well under the 3
 *    a second of WCAG 2.3.1); with Reduce Motion it is simply red.
 *
 * Every text sits on the dark groove, where the light text, the muted grey, the yellow and the red all read (UI-05,
 * `npm run test:contrast`); the sun and the moon are the game colours the day plate used (GAME.sun / GAME.moon).
 *
 * The weather (LUZ-05): a pixel icon in the groove's top-left corner, where the arc never passes -- a cloud with drops
 * (rain), a cloud with a bolt (storm), three bands (fog, only while there is fog: a morning fog's icon comes at 04:00 and
 * goes by 09:00). Nothing on a clear day. The server's weather, as the client's clock mirrors it; theme colours only
 * (GAME.weatherCloud / weatherRain / weatherBolt).
 *
 * Built once; `update()` runs every frame, creates no Instance and writes only what changed: the body moves in half-unit
 * steps (every ~2 s by day), a dot or a pip repaints when it is passed, the countdown once a second.
 */
import {
	CLOCK_ANNOUNCEMENTS,
	DAY_BREAK_HOUR,
	DAY_REAL_SECONDS,
	NIGHTFALL_HOUR,
	NIGHT_REAL_SECONDS,
	isNightAt,
	secondsUntilHour,
} from "shared/sim/clock";
import { Weather, weatherRains } from "shared/sim/weather";
import { countdown } from "../onboarding/gameOver";
import { GAME, STAT, SURFACE, TEXT, THEME, fontOf, hex } from "./theme";
import { Groove, Section } from "./window";
import * as W from "./widgets";

// ---------------------------------------------------------------- pixel icons (also the console's Bag / Menu)

/** a pixel-art icon: [x, y, w, h] rectangles on a 7 x 7 grid, drawn with Frames that fill their host */
export type Px = [number, number, number, number];

const SUN: Array<Px> = [
	[2, 2, 3, 3],
	[3, 0, 1, 1],
	[3, 6, 1, 1],
	[0, 3, 1, 1],
	[6, 3, 1, 1],
	[1, 1, 1, 1],
	[5, 1, 1, 1],
	[1, 5, 1, 1],
	[5, 5, 1, 1],
];
/** a crescent, horns to the right */
const MOON: Array<Px> = [
	[2, 0, 3, 1],
	[1, 1, 2, 1],
	[0, 2, 2, 3],
	[1, 5, 2, 1],
	[2, 6, 3, 1],
];

/** the weather's icons (LUZ-05), each in two colours: a cloud and what falls from it, or the fog's bands */
const CLOUD: Array<Px> = [
	[2, 0, 3, 1],
	[1, 1, 5, 1],
	[0, 2, 7, 2],
];
const DROPS: Array<Px> = [
	[1, 5, 1, 1],
	[3, 5, 1, 1],
	[5, 5, 1, 1],
	[0, 6, 1, 1],
	[2, 6, 1, 1],
	[4, 6, 1, 1],
];
const BOLT: Array<Px> = [
	[3, 4, 2, 1],
	[2, 5, 2, 1],
	[3, 6, 1, 1],
];
const FOG: Array<Px> = [
	[1, 1, 5, 1],
	[0, 3, 5, 1],
	[2, 5, 5, 1],
];
/** fog thinner than this shows no icon (a morning fog's first and last minutes) */
const FOG_ICON_MIN = 0.05;

/** draws `rects` (a 7 x 7 grid) in `color`, filling `host`; returns the icon's frame (shown / hidden as one) */
export function pixelIcon(host: GuiObject, name: string, rects: Array<Px>, color: Color3, zIndex: number): Frame {
	const icon = new Instance("Frame");
	icon.Name = name;
	icon.BackgroundTransparency = 1;
	icon.BackgroundColor3 = THEME.background;
	icon.BorderSizePixel = 0;
	icon.Size = UDim2.fromScale(1, 1);
	icon.ZIndex = zIndex;
	for (let i = 0; i < rects.size(); i++) {
		const [x, y, w, h] = rects[i];
		const f = new Instance("Frame");
		f.Name = `Px${i}`;
		f.BorderSizePixel = 0;
		f.BackgroundColor3 = color;
		f.Position = UDim2.fromScale(x / 7, y / 7);
		f.Size = UDim2.fromScale(w / 7, h / 7);
		f.ZIndex = zIndex;
		f.Parent = icon;
	}
	icon.Parent = host;
	return icon;
}

// ---------------------------------------------------------------- geometry (design units of the sky groove)

/** the last seconds before nightfall in which the countdown turns red and pulses */
export const NIGHTFALL_WARN_S = 30;
/** the pulse: red for half a second, yellow for the other half -- one flash a second */
const PULSE_HZ = 1;

/** [x, y, w, h] */
type Box = [number, number, number, number];

interface SkyGeom {
	/** the groove */
	w: number;
	h: number;
	/** the arc: centre x, the horizon's y, its half-width and its height */
	cx: number;
	hy: number;
	rx: number;
	ry: number;
	/** the sun / moon, a path dot, a horde pip */
	glyph: number;
	dot: number;
	pip: number;
	dots: number;
	/** the horizon line's ends */
	h0: number;
	h1: number;
	/** the weather icon, in the corner the arc never reaches */
	weather: Box;
	day: Box;
	count: Box;
	/** the same two with the extra line under them */
	dayX: Box;
	countX: Box;
	extra: Box;
	daySize: number;
	countSize: number;
	extraSize: number;
	align: W.TextAlign;
	extraAlign: W.TextAlign;
}

/**
 * desktop: the console's section at its left end, text under the sky. 120 wide so the longest line, the night's
 * "Daybreak in 2:48" (~111 units of Bold at TEXT.sm), keeps its design size instead of shrinking to fit
 */
const STACK: SkyGeom = {
	w: 120,
	h: 82,
	cx: 60,
	hy: 30,
	rx: 50,
	ry: 23,
	glyph: 12,
	dot: 2,
	pip: 4,
	dots: 15,
	h0: 4,
	h1: 116,
	weather: [2, 2, 9, 9],
	day: [2, 33, 116, 20],
	count: [2, 55, 116, 17],
	dayX: [2, 31, 116, 19],
	countX: [2, 50, 116, 16],
	extra: [2, 66, 116, 14],
	daySize: TEXT.lg,
	countSize: TEXT.sm,
	extraSize: TEXT.xs,
	align: "center",
	extraAlign: "center",
};

/** touch: a plate in the top row, the sky at its left and the text beside it */
const ROW: SkyGeom = {
	w: 186,
	h: 40,
	cx: 32,
	hy: 32,
	rx: 26,
	ry: 21,
	glyph: 10,
	dot: 2,
	pip: 4,
	dots: 11,
	h0: 3,
	h1: 61,
	weather: [1, 1, 9, 9],
	day: [66, 3, 116, 18],
	count: [66, 21, 116, 16],
	dayX: [66, 3, 54, 18],
	countX: [66, 21, 116, 16],
	extra: [118, 5, 64, 14],
	daySize: TEXT.base,
	countSize: TEXT.sm,
	extraSize: TEXT.xs,
	align: "left",
	extraAlign: "right",
};

/** the touch plate: the window body, a section in it, the sky groove in that (UI-09: body -> section -> groove) */
export const SKY_PLATE_W = 204;
export const SKY_PLATE_H = 58;
const PLATE_PAD = 5;
const PLATE_INSET = 4;

/** the console's section around the desktop sky: the groove plus the section's inset (hudConsole.ts) */
export const SKY_STACK_W = STACK.w;
export const SKY_STACK_H = STACK.h;

/** the horde's hours (the night's waves), as shares of the night gone by when each starts */
const WAVE_SHARES: Array<number> = [];
for (const a of CLOCK_ANNOUNCEMENTS) {
	if (a.morning) continue;
	WAVE_SHARES.push(1 - secondsUntilHour(a.hour, DAY_BREAK_HOUR) / NIGHT_REAL_SECONDS);
}

/** what the sky reads from the HUD's state (a HudState is one) */
export interface SkyState {
	/** the WORLD's day (MP-20) */
	day: number;
	/** this life's day (MP-13): shown only where it has parted from the world's */
	lifeDay: number;
	/** 0..24 in-game hours */
	dayTime: number;
	/** a watch is equipped: HH:MM under the countdown */
	showClock: boolean;
	/** the day's weather (shared/sim/weather.ts `Weather`) and the fog's density now; left out = clear */
	weather?: number;
	fog?: number;
}

export type SkyShape = "stack" | "row";

const BOLD = fontOf("sans", Enum.FontWeight.Bold);
const EXTRA_BOLD = fontOf("sans", Enum.FontWeight.ExtraBold);

function place(g: GuiObject, box: Box, gw: number, gh: number): void {
	g.Position = UDim2.fromScale(box[0] / gw, box[1] / gh);
	g.Size = UDim2.fromScale(box[2] / gw, box[3] / gh);
}

export class HudSky {
	readonly groove: Frame;
	private readonly tr: (key: string) => string;
	private readonly g: SkyGeom;
	private readonly dayLabel: TextLabel;
	private readonly countLabel: TextLabel;
	private readonly extraLabel: TextLabel;
	private readonly body: Frame;
	private readonly sun: Frame;
	private readonly moon: Frame;
	private readonly dots: Array<Frame> = [];
	private readonly pips: Array<Frame> = [];
	/** the weather icon's host and its three pictures (built once, shown / hidden as the weather changes) */
	private readonly weatherIcon: Frame;
	private readonly rainIcon: Frame;
	private readonly stormIcon: Frame;
	private readonly fogIcon: Frame;
	/** which one shows: 0 none, 1 rain, 2 storm, 3 fog */
	private shownWeather = -1;
	private day = -1;
	private extraText = "";
	private extraShown: boolean | undefined;
	/** what the extra line was built from: this life's day (-1 = same as the world's) and the watch's minute (-1 = none) */
	private life = -2;
	private minute = -2;
	private night: boolean | undefined;
	private passed = -1;
	private pipsPassed = -1;
	private bodyX = math.huge;
	private bodyY = math.huge;
	private seconds = -1;
	private warnRed: boolean | undefined;

	/** fills `groove` (a Groove of the kit, `shape`'s size in design units) with the sky */
	constructor(groove: Frame, tr: (key: string) => string, shape: SkyShape) {
		this.groove = groove;
		this.tr = tr;
		const g = shape === "stack" ? STACK : ROW;
		this.g = g;
		const z = groove.ZIndex + 1;

		// the horizon, then the path of dots and the horde's pips on it, then the body over them
		W.makeFrame(groove, "Horizon", g.h0, g.hy - 1, g.h1 - g.h0, 2, SURFACE.line, { zIndex: z });
		for (let i = 0; i < g.dots; i++) {
			const [x, y] = this.arc(i / (g.dots - 1));
			const d = W.makeFrame(groove, `Dot${i + 1}`, x - g.dot / 2, y - g.dot / 2, g.dot, g.dot, SURFACE.line, {
				zIndex: z,
			});
			this.dots.push(d);
		}
		for (let i = 0; i < WAVE_SHARES.size(); i++) {
			const p = W.makeFrame(groove, `Pip${i + 1}`, 0, 0, g.pip, g.pip, STAT.penalty, { zIndex: z + 1 });
			p.AnchorPoint = new Vector2(0.5, 0.5);
			p.Visible = false;
			this.pips.push(p);
		}
		const body = W.makeFrame(groove, "Body", 0, 0, g.glyph, g.glyph, THEME.background, {
			transparency: 1,
			zIndex: z + 2,
		});
		body.AnchorPoint = new Vector2(0.5, 0.5);
		this.body = body;
		this.sun = pixelIcon(body, "Sun", SUN, GAME.sun, z + 2);
		this.moon = pixelIcon(body, "Moon", MOON, GAME.moon, z + 2);
		this.moon.Visible = false;

		// the weather (LUZ-05): three pictures in one corner, none of them shown on a clear day
		const [wx, wy, wsz] = g.weather;
		const icon = W.makeFrame(groove, "Weather", wx, wy, wsz, wsz, THEME.background, {
			transparency: 1,
			zIndex: z + 1,
		});
		icon.Visible = false;
		this.weatherIcon = icon;
		const two = (name: string, a: Array<Px>, ca: Color3, b: Array<Px>, cb: Color3): Frame => {
			const f = W.makeFrame(icon, name, 0, 0, wsz, wsz, THEME.background, { transparency: 1, zIndex: z + 1 });
			f.Size = UDim2.fromScale(1, 1);
			pixelIcon(f, "Cloud", a, ca, z + 1);
			pixelIcon(f, "Fall", b, cb, z + 1);
			f.Visible = false;
			return f;
		};
		this.rainIcon = two("Rain", CLOUD, GAME.weatherCloud, DROPS, GAME.weatherRain);
		this.stormIcon = two("Storm", CLOUD, GAME.weatherCloud, BOLT, GAME.weatherBolt);
		this.fogIcon = pixelIcon(icon, "Fog", FOG, GAME.weatherCloud, z + 1);
		this.fogIcon.Visible = false;

		const [dx, dy, dw, dh] = g.day;
		this.dayLabel = W.makeLabel(groove, "Day", "", dx, dy, dw, dh, g.daySize, THEME.foreground, {
			font: EXTRA_BOLD,
			align: g.align,
			zIndex: z,
		});
		const [cx, cy, cw, ch] = g.count;
		this.countLabel = W.makeLabel(groove, "Countdown", "", cx, cy, cw, ch, g.countSize, THEME.foreground, {
			font: BOLD,
			align: g.align,
			rich: true,
			zIndex: z,
		});
		const [ex, ey, ew, eh] = g.extra;
		this.extraLabel = W.makeLabel(groove, "Extra", "", ex, ey, ew, eh, g.extraSize, THEME.mutedForeground, {
			font: "caption",
			align: g.extraAlign,
			zIndex: z,
		});
		this.extraLabel.Visible = false;
	}

	/**
	 * The touch plate is drawn at its own scale (hud.ts places it in screen pixels): its text follows, as the touch
	 * console's does (hudConsole.ts placeTouch). Called on a change of the touch geometry, never per frame.
	 */
	setTextScale(mult: number): void {
		W.scaleText(this.dayLabel, this.g.daySize * mult);
		W.scaleText(this.countLabel, this.g.countSize * mult);
		W.scaleText(this.extraLabel, this.g.extraSize * mult);
	}

	/** the point of the arc at share `f` of the phase: the left horizon at 0, the top at 0.5, the right horizon at 1 */
	private arc(f: number): [number, number] {
		const g = this.g;
		const a = math.pi * math.clamp(f, 0, 1);
		return [g.cx - g.rx * math.cos(a), g.hy - g.ry * math.sin(a)];
	}

	/** every frame: writes only what changed, creates nothing */
	update(state: SkyState, now: number): void {
		const g = this.g;
		if (state.day !== this.day) {
			this.day = state.day;
			this.dayLabel.Text = `${this.tr("Day")} ${state.day}`;
		}

		// the weather's icon: rain or storm all day, fog while there is fog (LUZ-05)
		const kind = state.weather ?? Weather.Clear;
		let pic = 0;
		if (weatherRains(kind)) pic = kind === Weather.Storm ? 2 : 1;
		else if ((state.fog ?? 0) >= FOG_ICON_MIN) pic = 3;
		if (pic !== this.shownWeather) {
			this.shownWeather = pic;
			this.weatherIcon.Visible = pic !== 0;
			this.rainIcon.Visible = pic === 1;
			this.stormIcon.Visible = pic === 2;
			this.fogIcon.Visible = pic === 3;
		}

		// the phase, how much of it is gone and how long is left, in the real seconds the player waits them
		const t = state.dayTime;
		const night = isNightAt(t);
		const left = secondsUntilHour(t, night ? DAY_BREAK_HOUR : NIGHTFALL_HOUR);
		const f = math.clamp(1 - left / (night ? NIGHT_REAL_SECONDS : DAY_REAL_SECONDS), 0, 1);
		if (night !== this.night) {
			this.night = night;
			this.sun.Visible = !night;
			this.moon.Visible = night;
			// by day one pip at the sunset end (the horde comes at nightfall); at night one per wave
			for (let i = 0; i < this.pips.size(); i++) {
				const pip = this.pips[i];
				const share = night ? WAVE_SHARES[i] : 1;
				const [x, y] = this.arc(share);
				pip.Position = UDim2.fromScale(x / g.w, y / g.h);
				pip.Visible = night || i === 0;
			}
			this.pipsPassed = -1;
			this.passed = -1;
			this.seconds = -1;
		}

		// the body on the arc, in half-unit steps (the arc's maths inline: nothing is allocated per frame)
		const a = math.pi * f;
		const qx = math.round((g.cx - g.rx * math.cos(a)) * 2) / 2;
		const qy = math.round((g.hy - g.ry * math.sin(a)) * 2) / 2;
		if (qx !== this.bodyX || qy !== this.bodyY) {
			this.bodyX = qx;
			this.bodyY = qy;
			this.body.Position = UDim2.fromScale(qx / g.w, qy / g.h);
		}
		// the dots it has passed go dim
		const passed = math.floor(f * (g.dots - 1) + 1e-6);
		if (passed !== this.passed) {
			this.passed = passed;
			for (let i = 0; i < this.dots.size(); i++) {
				const c = i < passed ? SURFACE.section : SURFACE.line;
				if (this.dots[i].BackgroundColor3 !== c) this.dots[i].BackgroundColor3 = c;
			}
		}
		// a wave that has started is no longer ahead
		let pipsPassed = 0;
		if (night) for (const share of WAVE_SHARES) if (f >= share - 1e-6) pipsPassed++;
		if (pipsPassed !== this.pipsPassed) {
			this.pipsPassed = pipsPassed;
			for (let i = 0; i < this.pips.size(); i++) {
				const c = i < pipsPassed ? SURFACE.section : STAT.penalty;
				if (this.pips[i].BackgroundColor3 !== c) this.pips[i].BackgroundColor3 = c;
			}
		}

		// the countdown, and its warning in the last seconds of the day
		const seconds = math.max(0, math.ceil(left));
		const warn = !night && left <= NIGHTFALL_WARN_S;
		const red = warn && (W.reducedMotion() || math.floor(now * PULSE_HZ * 2) % 2 === 0);
		if (seconds !== this.seconds || red !== this.warnRed) {
			this.seconds = seconds;
			this.warnRed = red;
			const word = this.tr(night ? "Daybreak in" : "Night in");
			const color = red ? STAT.penalty : STAT.value;
			this.countLabel.Text = `${word} <font color="${hex(color)}">${countdown(left)}</font>`;
		}

		// the extra line: this life's day where it has parted from the world's, HH:MM with a watch. Rebuilt only when
		// one of the two changes (a game minute is ~0,7 real seconds): no string is made on a frame that shows the same
		const life = state.lifeDay !== state.day ? state.lifeDay : -1;
		const minute = state.showClock ? math.floor(t * 60) % (24 * 60) : -1;
		if (life !== this.life || minute !== this.minute) {
			this.life = life;
			this.minute = minute;
			const lifeText = life >= 0 ? `${this.tr("Life day")} ${life}` : "";
			const clockText = minute >= 0 ? string.format("%02d:%02d", math.floor(minute / 60), minute % 60) : "";
			const extra = lifeText !== "" && clockText !== "" ? `${lifeText} · ${clockText}` : lifeText + clockText;
			if (extra !== this.extraText) {
				this.extraText = extra;
				this.extraLabel.Text = extra;
			}
		}
		const shown = this.extraText !== "";
		if (shown !== this.extraShown) {
			this.extraShown = shown;
			this.extraLabel.Visible = shown;
			place(this.dayLabel, shown ? g.dayX : g.day, g.w, g.h);
			place(this.countLabel, shown ? g.countX : g.count, g.w, g.h);
		}
	}
}

/**
 * The desktop sky: a section of `w` x `h` design units at (x, y) of the console's body, holding the sky groove. The
 * section inset is `inset` (the console's own), so the groove is exactly the STACK geometry.
 */
export function skySection(
	body: Frame,
	tr: (key: string) => string,
	x: number,
	y: number,
	inset: number,
	zIndex: number,
): HudSky {
	const section = Section(body, "Sky", { x, y, w: STACK.w + inset * 2, h: STACK.h + inset * 2, zIndex }).frame;
	const groove = Groove(section, "SkyWindow", inset, inset, STACK.w, STACK.h);
	groove.ZIndex = section.ZIndex + 1;
	return new HudSky(groove, tr, "stack");
}

/**
 * The touch sky: its own small plate (the window body, a section, the sky groove), placed in screen pixels by hud.ts
 * in the top corner of the touch controls, under Menu and Bag. Returns the plate's frame (its design space is SKY_PLATE_W x SKY_PLATE_H)
 * and the sky in it.
 */
export function skyPlate(root: Frame, tr: (key: string) => string): [Frame, HudSky] {
	const frame = new Instance("Frame");
	frame.Name = "SkyPlate";
	frame.BackgroundTransparency = 1;
	frame.BackgroundColor3 = THEME.background;
	frame.BorderSizePixel = 0;
	// with the console: above the damage vignette, under the touch layer (ZIndex 8), which it never overlaps anyway
	frame.ZIndex = 2;
	frame.Size = UDim2.fromOffset(SKY_PLATE_W, SKY_PLATE_H);
	W.setDesign(frame, SKY_PLATE_W, SKY_PLATE_H);
	frame.Parent = root;
	const body = W.Card(frame, "Body", {
		x: 0,
		y: 0,
		w: SKY_PLATE_W,
		h: SKY_PLATE_H,
		fill: SURFACE.window,
		pad: PLATE_PAD,
	});
	const sw = SKY_PLATE_W - PLATE_PAD * 2;
	const sh = SKY_PLATE_H - PLATE_PAD * 2;
	const section = Section(body, "Sky", { x: PLATE_PAD, y: PLATE_PAD, w: sw, h: sh, zIndex: body.ZIndex + 1 }).frame;
	const groove = Groove(section, "SkyWindow", PLATE_INSET, PLATE_INSET, ROW.w, ROW.h);
	groove.ZIndex = section.ZIndex + 1;
	return [frame, new HudSky(groove, tr, "row")];
}
