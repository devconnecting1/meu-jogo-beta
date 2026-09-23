import { GameContext } from "shared/game/context";
import { langGet } from "shared/data/lang";
import { defaultSettings } from "shared/game/save";
import { TouchButton, TouchLayout } from "shared/engine/input";
import { MAX_PLAYERS } from "shared/net/mpConfig";
import { previewBgm, previewSfx } from "../audio";
import { getTouchLayout, refreshTouchLayout } from "../bootstrap";
import { requestSave } from "../systems/saveClient";
import { COMPACT_LAYOUT, placeTouchConsole } from "./hudConsole";
import { popup } from "./popup";
import { RADIUS, SURFACE, TEXT, THEME, TRANSPARENCY, space } from "./theme";
import { SCHEMES, currentScheme } from "./tutorial";
import {
	Button,
	ScrollList,
	Slider,
	SliderHandle,
	Tabs,
	autoFocus,
	cardHeaderHeight,
	centredRect,
	makeFrame,
	makeLabel,
	makeScreen,
	makeSurface,
	nl,
	onLayoutChange,
	reducedMotion,
	setVisible,
	tabWidth,
} from "./widgets";
import {
	RadioGroup,
	SECTION_CONTENT_Y,
	SETTING_CONTROL_X,
	SETTING_DESC_ROW_H,
	SETTING_ROW_H,
	SWITCH_H,
	Section,
	Groove,
	SettingAction,
	SettingRow,
	SettingRowHandle,
	SettingRowOpts,
	SettingsList,
	Switch,
	SwitchHandle,
	ValueKey,
	Window,
	radioGroupHeight,
	sectionHeight,
	setValueKey,
	settingsListHeight,
} from "./window";

/*
 * Settings: the reference's modal window (DESIGN_RULES UI-07) -- header with the big centred title, "?" and the red
 * X; a tab bar; the tabs' sections of rows "label cell | value cell".
 *
 * Every row that CHANGES something is a form row (window.ts, the structure of a web form's horizontal item drawn in
 * our plates): its label, a muted one-line description of what it really does, and the control in the value cell --
 * a slider, a Switch for a boolean (floating stick, left-handed), a key for a read-only value. A tab with settings of
 * its own ends in a "Defaults" action row, which asks before putting that tab's fields back to defaultSettings().
 * Controls picks the device whose keys it lists with a stacked radio group (the schemes differ in a way one word does
 * not say); About keeps the plain rows (facts, not settings).
 *
 * Deliberately NOT here (UI-07's form exceptions): a Save / Cancel footer and a "dirty" state -- a change applies at
 * once and is saved with the progress, as in a game; and text inputs, dropdowns, date pickers, multi-selects.
 *
 * What is NOT here any more: the English / Korean switch. Roblox translates the game by the player's own account
 * (src/shared/data/lang.ts only keeps overrides), so that switch changed nothing a player could see.
 */

// ---------------------------------------------------------------- layout (1120 x 630 design units)

const WIN_W = 900;
const PAD = space(6);
const TAB_H = 34;
/** a tab's page: the width under the tab bar, and the gap between two of its sections */
const SECTION_W = WIN_W - PAD * 2;
const SECTION_GAP = space(4);
/** the list inside a section, inset like the reference's */
const LIST_X = space(4);
const LIST_W = SECTION_W - LIST_X * 2;
/** every row that changes something is a form row (window.ts SettingRow with a description) */
const ROW_H = SETTING_DESC_ROW_H;
/** General: the label column is wide enough for its descriptions in one line, down to a phone */
const GENERAL_LABEL_W = 400;
/** Touch: the rows on the left, the preview of the player's own screen on the right */
const TOUCH_LIST_W = 580;
const TOUCH_LABEL_W = 330;
/** Controls: the device (radio group) on the left, its keys on the right */
const DEVICE_W = 320;
const KEYS_LABEL_W = 280;
/** the key rows: a key (28) with a hair of room, so the longest scheme (Touch, nine rows) fits without scrolling */
const KEY_ROW_H = 34;
/** the device's note under the radio group: three lines of TEXT.sm, down to a phone */
const DEVICE_NOTE_H = 72;
/** a slider row: the slider, then its value as a key at the right of the cell */
const VALUE_KEY_W = 72;

/** `n` form rows */
function formRows(n: number): Array<number> {
	const out: Array<number> = [];
	for (let i = 0; i < n; i++) out.push(ROW_H);
	return out;
}

/** General: Audio (SFX, BGM) and Interface (HUD size, Reduce motion, Defaults) */
const AUDIO_LIST_H = settingsListHeight(formRows(2));
const INTERFACE_LIST_H = settingsListHeight(formRows(3));
const GENERAL_H = sectionHeight(AUDIO_LIST_H) + SECTION_GAP + sectionHeight(INTERFACE_LIST_H);
/** Touch controls: six settings and Defaults, in one section beside the preview */
const TOUCH_H = sectionHeight(settingsListHeight(formRows(7)));
/**
 * The window is ONE fixed size for every tab (UI-07: it does not jump when a tab changes), that of the TALLEST page
 * -- General and Touch controls are within a few units of each other, so neither leaves a band of empty window
 * under its sections; Controls fills it with its key list, and About is a short list of facts.
 */
const PAGE_H = math.max(GENERAL_H, TOUCH_H);
/** where the pages start: under the header and the tab bar */
const SECTION_Y = cardHeaderHeight(TEXT.xl3) + space(1) + TAB_H + space(4);
const WIN_H = SECTION_Y + PAGE_H + space(5);

type Tr = (key: string) => string;

function pct(v: number): string {
	return `${math.floor(v * 100 + 0.5)}%`;
}

/** what the "?" of the window explains: what each tab is for, one line each ("#" = new line, see nl) */
const HELP_TEXT = [
	"General: how loud the sounds and the music are, and how big the panels of a run are.",
	"Touch controls: size, height and side of the phone controls, with a preview of your screen.",
	"Controls: every key and button the game listens to, on each device.",
	"About: the game and its credits.",
	"A change applies at once and is saved with your progress. Defaults puts a tab back as it came.",
].join("#");

/** the one line under each device of Controls (SCHEMES order): what sets it apart, from its own rows */
const SCHEME_BLURBS = ["WASD moves, mouse aims.", "Thumbs move and aim.", "Sticks move and aim."];

/**
 * `onCredits` undefined: no credits row (Settings opened over a running match, where the credits page -- text straight
 * on the page -- would not read over a bright street). `overWorld`: opened over a running match from its menu
 * (DESIGN_RULES UI-06): the world's see-through scrim, so the street keeps moving behind it; from the lobby the screen
 * is see-through and the town flyover behind the menus is what shows (UI-10).
 */
export function showSettings(
	ctx: GameContext,
	onBack: () => void,
	onCredits?: () => void,
	overWorld = false,
): () => void {
	const tr: Tr = (key: string): string => langGet(key, ctx.save.settings.langType);
	const { root, body } = makeScreen(ctx.uiLayer, "Settings", {
		transparency: overWorld ? TRANSPARENCY.overWorld : 1,
		zIndex: 250,
		content: centredRect(WIN_W, WIN_H),
	});
	const s = ctx.save.settings;
	/** every slider and switch of the screen (their input listeners go when it closes) */
	const handles: Array<SliderHandle> = [];
	const switches: Array<SwitchHandle> = [];
	/** redraws the control preview after a touch setting changed */
	let refreshPreview: (() => void) | undefined;
	/** each tab's controls re-read the save (a "Defaults" reset) */
	const generalRefreshers: Array<() => void> = [];
	const touchRefreshers: Array<() => void> = [];

	/*
	 * Persistence: a settings change is a save like any other, but a slider fires on every pixel of the drag.
	 * The write is therefore coalesced into one request a second at most; leaving the screen saves again, so
	 * nothing can be lost by closing the game right after a change.
	 */
	let saveQueued = false;
	const persist = (): void => {
		if (saveQueued) return;
		saveQueued = true;
		task.delay(1, () => {
			saveQueued = false;
			requestSave("menu");
		});
	};

	/** touch controls: the geometry the game uses is recomputed at once, so a preview never lies */
	const applyTouch = (): void => {
		refreshTouchLayout();
		refreshPreview?.();
		persist();
	};

	/** slider audio: the level has to be HEARD while dragging, but not once per pixel */
	let lastPreviewSound = 0;
	const previewSound = (fn: () => void): void => {
		const now = os.clock();
		if (now - lastPreviewSound < 0.14) return;
		lastPreviewSound = now;
		fn();
	};

	const win = Window(body, "Window", {
		...centredRect(WIN_W, WIN_H),
		title: tr("Settings"),
		onClose: (): void => onBack(),
		onHelp: (): void => {
			popup(ctx, tr("Settings"), nl(tr(HELP_TEXT)), [{ text: tr("Close"), variant: "secondary" }]);
		},
	});
	const panel = win.frame;
	const tabsY = win.contentY + space(1);

	// ---- rows

	/** a slider form row: the slider from the control column across the cell, the value as a key at its right */
	const sliderRow = (
		row: SettingRowHandle,
		name: string,
		valueW: number,
		get: () => number,
		set: (v: number) => void,
		refreshers: Array<() => void>,
	): void => {
		const cell = row.value;
		const key = ValueKey(cell, `${name}Value`, pct(get()), {
			x: valueW - space(4),
			anchorX: 1,
			minW: VALUE_KEY_W,
			textSize: TEXT.base,
		});
		const handle = Slider(cell, name, {
			x: SETTING_CONTROL_X,
			y: 0,
			w: valueW - SETTING_CONTROL_X - space(4) - VALUE_KEY_W - space(3),
			h: ROW_H,
			get,
			set: (v: number): void => {
				set(v);
				setValueKey(key, pct(v));
			},
			zIndex: cell.ZIndex + 1,
		});
		handles.push(handle);
		refreshers.push(() => {
			handle.refresh();
			setValueKey(key, pct(get()));
		});
	};

	/** a boolean form row: the kit's Switch in the control column */
	const switchRow = (
		row: SettingRowHandle,
		name: string,
		get: () => boolean,
		set: (v: boolean) => void,
		refreshers: Array<() => void>,
	): void => {
		const sw = Switch(row.value, name, {
			x: SETTING_CONTROL_X,
			y: (ROW_H - SWITCH_H) / 2,
			value: get(),
			onText: tr("On"),
			offText: tr("Off"),
			zIndex: row.value.ZIndex + 1,
			onChange: set,
		});
		switches.push(sw);
		refreshers.push(() => sw.set(get()));
	};

	/**
	 * A tab's "Defaults" action row: its button asks first (the kit's popup), then `reset` puts that tab's fields back
	 * to defaultSettings() -- the one source of the defaults, the save's own.
	 */
	const defaultsRow = (
		list: ScrollList,
		order: number,
		labelW: number,
		description: string,
		confirm: string,
		reset: () => void,
	): void => {
		SettingAction(
			list,
			"Defaults",
			order,
			tr("Defaults"),
			tr(description),
			tr("Reset"),
			(): void => {
				popup(ctx, tr("Reset to defaults?"), tr(confirm), [
					{ text: tr("Cancel"), variant: "secondary" },
					{ text: tr("Reset"), onClick: reset },
				]);
			},
			{ labelW },
		);
	};

	/** a text value, centred in the value cell (About) */
	const textRow = (row: SettingRowHandle, valueW: number, text: string): void => {
		makeLabel(row.value, "Text", text, space(3), 0, valueW - space(6), SETTING_ROW_H, TEXT.base, THEME.foreground, {
			zIndex: row.value.ZIndex + 1,
		});
	};

	// ---- pages (built on first visit, then only shown / hidden)

	/** a page: the area under the tab bar, holding one full-height section or a few fitted ones */
	const pageFrame = (index: number): Frame =>
		makeFrame(panel, `Page${index}`, PAD, SECTION_Y, SECTION_W, PAGE_H, THEME.background, { transparency: 1 });
	const listY = SECTION_CONTENT_Y;
	/** the list of a section as tall as the page */
	const fullListH = PAGE_H - sectionHeight(0);

	const buildGeneral = (index: number): Frame => {
		const page = pageFrame(index);
		const valueW = LIST_W - GENERAL_LABEL_W;
		const form = (description: string): SettingRowOpts => ({
			labelW: GENERAL_LABEL_W,
			description: tr(description),
		});
		const audio = Section(page, "Audio", {
			x: 0,
			y: 0,
			w: SECTION_W,
			h: sectionHeight(AUDIO_LIST_H),
			title: tr("Audio"),
		});
		const list = SettingsList(audio.frame, "List", LIST_X, listY, LIST_W, AUDIO_LIST_H);
		// the SFX bus also carries the interface's clicks (audio.ts: the UI rides the SFX slider)
		sliderRow(
			SettingRow(list, "Sfx", 0, tr("SFX"), form("Gunshots, hits, footsteps, menu clicks.")),
			"Sfx",
			valueW,
			() => s.soundEffect,
			v => {
				s.soundEffect = v;
				previewSound(previewSfx);
				persist();
			},
			generalRefreshers,
		);
		// the BGM bus: the night music, the day's ambience, the wave and dawn stingers and the heartbeat (music.ts);
		// there is no menu music
		sliderRow(
			SettingRow(list, "Bgm", 1, tr("BGM"), form("Night music, ambience and the heartbeat.")),
			"Bgm",
			valueW,
			() => s.bgm,
			v => {
				s.bgm = v;
				previewSound(previewBgm);
				persist();
			},
			generalRefreshers,
		);

		const ui = Section(page, "Interface", {
			x: 0,
			y: sectionHeight(AUDIO_LIST_H) + SECTION_GAP,
			w: SECTION_W,
			h: sectionHeight(INTERFACE_LIST_H),
			title: tr("Interface"),
		});
		const uiList = SettingsList(ui.frame, "List", LIST_X, listY, LIST_W, INTERFACE_LIST_H);
		// hud.ts (the console -- the day clock and the scoreboard's chip are in it --, the E hint, the messages) and
		// the first run's coach read it when a run mounts
		sliderRow(
			SettingRow(uiList, "UiSize", 0, tr("HUD size"), form("Console, hints and messages.")),
			"UiSize",
			valueW,
			() => s.uiSize,
			v => {
				s.uiSize = v;
				// the Touch tab's preview draws the compact console at this size: a page built earlier follows it
				refreshPreview?.();
				persist();
			},
			generalRefreshers,
		);
		// Reduce Motion is the player's Roblox setting, and the game honours it (skin.ts): the town behind the menus
		// stands still and the fades cut. Shown as a key -- information, never a control -- that follows it live
		const motion = SettingRow(
			uiList,
			"Motion",
			1,
			tr("Reduce motion"),
			form("Set in the Roblox menu. Stills the town."),
		);
		const motionKey = ValueKey(motion.value, "Value", "", { x: SETTING_CONTROL_X, anchorX: 0, minW: VALUE_KEY_W });
		onLayoutChange(motionKey, () => setValueKey(motionKey, tr(reducedMotion() ? "On" : "Off")));
		defaultsRow(
			uiList,
			2,
			GENERAL_LABEL_W,
			"SFX, BGM and HUD size back to 50%.",
			"SFX, BGM and HUD size go back to 50%.",
			(): void => {
				const d = defaultSettings();
				s.soundEffect = d.soundEffect;
				s.bgm = d.bgm;
				s.uiSize = d.uiSize;
				for (const fn of generalRefreshers) fn();
				refreshPreview?.();
				persist();
			},
		);
		return page;
	};

	const buildTouch = (index: number): Frame => {
		const page = Section(panel, `Page${index}`, {
			x: PAD,
			y: SECTION_Y,
			w: SECTION_W,
			h: PAGE_H,
			title: tr("Touch controls"),
		}).frame;
		const list = SettingsList(page, "List", LIST_X, listY, TOUCH_LIST_W, fullListH);
		const valueW = TOUCH_LIST_W - TOUCH_LABEL_W;
		const form = (description: string): SettingRowOpts => ({ labelW: TOUCH_LABEL_W, description: tr(description) });
		const slider = (
			name: string,
			order: number,
			label: string,
			description: string,
			get: () => number,
			set: (v: number) => void,
		): void =>
			sliderRow(
				SettingRow(list, name, order, tr(label), form(description)),
				name,
				valueW,
				get,
				(v: number): void => {
					set(v);
					applyTouch();
				},
				touchRefreshers,
			);
		// shared/engine/input.ts computeTouchLayout: sizes 75%..125%, heights along the side's lift range
		slider(
			"LeftSize",
			0,
			"Stick size",
			"How big the move stick is.",
			() => s.leftSize,
			v => {
				s.leftSize = v;
			},
		);
		slider(
			"LeftPos",
			1,
			"Stick height",
			"How high the move stick sits.",
			() => s.leftPos,
			v => {
				s.leftPos = v;
			},
		);
		// the aim pad's size also sizes USE and RELOAD beside it and BAG and MENU in the corner
		slider(
			"RightSize",
			2,
			"Aim pad size",
			"Aim pad and the four buttons.",
			() => s.rightSize,
			v => {
				s.rightSize = v;
			},
		);
		slider(
			"RightPos",
			3,
			"Aim pad height",
			"How high the aim pad sits.",
			() => s.rightPos,
			v => {
				s.rightPos = v;
			},
		);
		switchRow(
			SettingRow(list, "Relative", 4, tr("Floating stick"), form("The stick opens under your thumb.")),
			"Relative",
			() => s.leftRelative,
			v => {
				s.leftRelative = v;
				applyTouch();
			},
			touchRefreshers,
		);
		switchRow(
			SettingRow(list, "Mirror", 5, tr("Left-handed"), form("Swaps the stick and the aim pad.")),
			"Mirror",
			() => s.mirror,
			v => {
				s.mirror = v;
				applyTouch();
			},
			touchRefreshers,
		);
		defaultsRow(
			list,
			6,
			TOUCH_LABEL_W,
			"All six back to how they came.",
			"Sizes and heights back to 50%, a floating stick, the aim pad on the right.",
			(): void => {
				const d = defaultSettings();
				s.leftSize = d.leftSize;
				s.leftPos = d.leftPos;
				s.leftRelative = d.leftRelative;
				s.rightSize = d.rightSize;
				s.rightPos = d.rightPos;
				s.mirror = d.mirror;
				for (const fn of touchRefreshers) fn();
				applyTouch();
			},
		);
		const previewX = LIST_X + TOUCH_LIST_W + space(4);
		refreshPreview = buildPreview(ctx, tr, page, previewX, listY, SECTION_W - previewX - LIST_X, fullListH);
		return page;
	};

	const buildControls = (index: number): Frame => {
		const page = pageFrame(index);
		// the player's own device first: a phone player should not have to read the keyboard's keys to find theirs
		const lastInput = currentScheme();
		const keysX = DEVICE_W + SECTION_GAP;
		const keysW = SECTION_W - keysX;
		const keysListW = keysW - LIST_X * 2;
		const keys = Section(page, "Keys", {
			x: keysX,
			y: 0,
			w: keysW,
			h: PAGE_H,
			title: tr(SCHEMES[lastInput].title),
		});
		const lists: Array<Frame> = [];
		for (let i = 0; i < SCHEMES.size(); i++) {
			const scheme = SCHEMES[i];
			const list = SettingsList(keys.frame, `List${i}`, LIST_X, listY, keysListW, fullListH);
			for (let r = 0; r < scheme.rows.size(); r++) {
				const [chip, what] = scheme.rows[r];
				const row = SettingRow(list, `Row${r}`, r, tr(what), { labelW: KEYS_LABEL_W, rowH: KEY_ROW_H });
				ValueKey(row.value, "Key", chip, { minW: 180 });
			}
			lists.push(list.frame.Parent as Frame);
		}
		// which device's keys: three options that differ in more than a word, so a stacked radio group, each with the
		// line that says how that device plays -- and under it, that device's note ("Right click also interacts.")
		const deviceW = DEVICE_W - LIST_X * 2;
		const radioH = radioGroupHeight(SCHEMES.size());
		const device = Section(page, "Device", {
			x: 0,
			y: 0,
			w: DEVICE_W,
			h: sectionHeight(radioH + space(2) + DEVICE_NOTE_H),
			title: tr("Device"),
		});
		const bed = Groove(device.frame, "NoteBed", LIST_X, listY + radioH + space(2), deviceW, DEVICE_NOTE_H);
		const note = makeLabel(
			bed,
			"Note",
			"",
			space(3),
			space(2),
			deviceW - space(6),
			DEVICE_NOTE_H - space(4),
			TEXT.sm,
			THEME.mutedForeground,
			{ align: "left", valign: "top", zIndex: bed.ZIndex + 1 },
		);
		const show = (i: number): void => {
			for (let k = 0; k < lists.size(); k++) setVisible(lists[k], k === i);
			if (keys.title !== undefined) keys.title.Text = tr(SCHEMES[i].title);
			note.Text = tr(SCHEMES[i].note);
		};
		RadioGroup(device.frame, "Schemes", {
			x: LIST_X,
			y: listY,
			w: deviceW,
			options: SCHEMES.map((sc, i) => ({ label: tr(sc.title), description: tr(SCHEME_BLURBS[i] ?? "") })),
			value: lastInput,
			zIndex: device.frame.ZIndex + 1,
			onChange: show,
		});
		show(lastInput);
		return page;
	};

	const buildAbout = (index: number): Frame => {
		const page = pageFrame(index);
		// five rows about the game, and the way to the credits where there is one
		const rows = [SETTING_ROW_H, SETTING_ROW_H, SETTING_ROW_H, SETTING_ROW_H, SETTING_ROW_H];
		if (onCredits !== undefined) rows.push(SETTING_ROW_H);
		const aboutListH = settingsListHeight(rows);
		const about = Section(page, "About", {
			x: 0,
			y: 0,
			w: SECTION_W,
			h: sectionHeight(aboutListH),
			title: tr("About"),
		});
		const list = SettingsList(about.frame, "List", LIST_X, listY, LIST_W, aboutListH);
		const valueW = LIST_W - 220;
		textRow(SettingRow(list, "Game", 0, tr("Game")), valueW, "Project Z");
		textRow(SettingRow(list, "Genre", 1, tr("Genre")), valueW, tr("Top-down zombie survival"));
		// CON-01: the original is credited, by name and studio
		textRow(SettingRow(list, "Inspired", 2, tr("Inspired by")), valueW, "Dead Town (Lemon Puppy Games)");
		// MP-01 / MULTIPLAYER.md: co-op only, MAX_PLAYERS survivors per server
		textRow(
			SettingRow(list, "Mode", 3, tr("Mode")),
			valueW,
			`${tr("Co-op, up to")} ${MAX_PLAYERS} ${tr("survivors")}`,
		);
		textRow(SettingRow(list, "Built", 4, tr("Built with")), valueW, "roblox-ts");
		const openCredits = onCredits;
		if (openCredits === undefined) return page;
		const credits = SettingRow(list, "Credits", 5, tr("Credits"));
		Button(credits.value, "OpenCredits", tr("Open credits"), {
			x: (valueW - 180) / 2,
			y: (SETTING_ROW_H - 30) / 2,
			w: 180,
			h: 30,
			size: "sm",
			variant: "secondary",
			zIndex: credits.value.ZIndex + 1,
			onClick: (): void => openCredits(),
		});
		return page;
	};

	const PAGES: Array<[string, (index: number) => Frame]> = [
		["General", buildGeneral],
		["Touch controls", buildTouch],
		["Controls", buildControls],
		["About", buildAbout],
	];
	const pages = new Map<number, Frame>();
	const showPage = (index: number): void => {
		for (const [i, page] of pages) setVisible(page, i === index);
		if (!pages.has(index)) pages.set(index, PAGES[index][1](index));
	};

	const names = PAGES.map(([label]) => tr(label));
	const widths = names.map(n => tabWidth(n));
	let tabsW = 0;
	for (const wd of widths) tabsW += wd + space(3);
	const tabs = Tabs(panel, "Tabs", {
		x: PAD,
		y: tabsY,
		w: math.min(tabsW, SECTION_W),
		h: TAB_H,
		items: names,
		widths,
		value: 0,
		onChange: showPage,
	});
	showPage(0);
	autoFocus(tabs.triggers[0]);

	return (): void => {
		for (const h of handles) h.disconnect();
		handles.clear();
		for (const sw of switches) sw.disconnect();
		switches.clear();
		requestSave("menu");
		root.Destroy();
	};
}

// ---------------------------------------------------------------- touch-control preview

/** one control of the preview: its dot, and where it is (screen px of the real layout) */
interface PreviewDot {
	frame: Frame;
	pick: (L: TouchLayout) => TouchButton;
}

/**
 * A scale model of the player's own screen with the controls where they will actually be. It draws the bootstrap's
 * own touch layout (`getTouchLayout`, the REAL viewport and top bar) shrunk, so it is the same geometry the thumbs
 * will meet — including the device's shape and the Roblox bar — and not a drawing that has to be kept in sync. The HUD's
 * compact console is drawn where hudConsole.ts puts it between the thumbs, at the HUD size of the General tab.
 *
 * It is also the only way a player on a PC (or the author on a monitor) can set up the phone layout at all.
 *
 * Built once: a slider dragged or a switch flipped only moves and resizes its frames (no Instance is created).
 */
function buildPreview(
	ctx: GameContext,
	tr: Tr,
	parent: Frame,
	x: number,
	y: number,
	boxW: number,
	boxH: number,
): () => void {
	const captionH = 20;
	const aspect = math.max(ctx.viewH, 1) / math.max(ctx.viewW, 1);
	const h = math.min(boxW * aspect, boxH - captionH - space(1));
	const w = h / aspect;
	const px = x + (boxW - w) / 2;
	const screen = makeSurface(parent, "Preview", px, y, w, h, "well", { clips: true, zIndex: parent.ZIndex + 1 });
	makeLabel(
		parent,
		"PreviewCaption",
		`${tr("Your screen")} · ${math.floor(ctx.viewW)} x ${math.floor(ctx.viewH)}`,
		x,
		y + h + space(1),
		boxW,
		captionH,
		TEXT.xs,
		THEME.foreground,
		{ zIndex: parent.ZIndex + 1 },
	);

	const dot = (name: string, color: Color3, zIndex: number): Frame =>
		makeFrame(screen, name, 0, 0, 1, 1, color, {
			radius: RADIUS.full,
			zIndex: screen.ZIndex + zIndex,
			transparency: 0.25,
		});
	// the stick's knob sits on its base: both are drawn at the stick's home, one radius each
	const dots: Array<PreviewDot> = [
		{
			frame: dot("Stick", THEME.foreground, 1),
			pick: L => ({ x: L.move.homeX, y: L.move.homeY, r: L.move.baseR }),
		},
		{
			frame: dot("StickKnob", SURFACE.frame, 2),
			pick: L => ({ x: L.move.homeX, y: L.move.homeY, r: L.move.knobR }),
		},
		{ frame: dot("Aim", THEME.destructive, 1), pick: L => ({ x: L.aim.homeX, y: L.aim.homeY, r: L.aim.baseR }) },
		{ frame: dot("Use", THEME.primary, 3), pick: L => L.use },
		{ frame: dot("Reload", THEME.secondary, 3), pick: L => L.reload },
		{ frame: dot("Bag", THEME.secondary, 3), pick: L => L.bag },
		{ frame: dot("Menu", THEME.secondary, 3), pick: L => L.pause },
	];
	// the HUD's compact console on touch, so the player can see nothing is covered
	const deck = makeFrame(screen, "Console", 0, 0, 1, 1, SURFACE.section, {
		radius: RADIUS.sm,
		zIndex: screen.ZIndex + 1,
		transparency: 0.25,
	});

	const draw = (): void => {
		const st = ctx.save.settings;
		// THE layout the bootstrap hit-tests with and the HUD draws (applyTouch refreshed it from the save a moment
		// ago), Roblox top bar included: a layout computed here without the bar put BAG and MENU under it on a phone,
		// and on a short one the aim pad, USE and RELOAD a few pixels off too
		const L: TouchLayout = getTouchLayout();
		const f = w / math.max(L.viewW, 1);
		for (const d of dots) {
			const b = d.pick(L);
			const size = math.max(b.r * 2 * f, 4);
			d.frame.Position = UDim2.fromScale((b.x * f - size / 2) / w, (b.y * f - size / 2) / h);
			d.frame.Size = UDim2.fromScale(size / w, size / h);
		}
		// hud.ts: the HUD size setting is 80% .. 120% of the HUD
		const k = 0.8 + 0.4 * math.clamp(st.uiSize, 0, 1);
		const c = placeTouchConsole(L, COMPACT_LAYOUT, k);
		deck.Position = UDim2.fromScale((c.x * f) / w, (c.y * f) / h);
		deck.Size = UDim2.fromScale((c.w * f) / w, (c.h * f) / h);
	};
	// the geometry can predate the save being edited (a save loaded after its last refresh): bring it up to date once
	refreshTouchLayout();
	draw();
	return draw;
}
