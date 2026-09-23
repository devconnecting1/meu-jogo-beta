import { GameContext } from "shared/game/context";
import { langGet } from "shared/data/lang";
import { computeTouchLayout, defaultTouchPrefs, TouchButton, TouchLayout, TouchPrefs } from "shared/engine/input";
import { MAX_PLAYERS } from "shared/net/mpConfig";
import { previewBgm, previewSfx } from "../audio";
import { refreshTouchLayout } from "../bootstrap";
import { requestSave } from "../systems/saveClient";
import { popup } from "./popup";
import { GAME, RADIUS, SURFACE, TEXT, THEME, space } from "./theme";
import { SCHEMES } from "./tutorial";
import {
	Button,
	Segmented,
	Slider,
	SliderHandle,
	Tabs,
	autoFocus,
	gamepadActive,
	makeFrame,
	makeLabel,
	makeScreen,
	makeSurface,
	nl,
	setVisible,
	tabWidth,
} from "./widgets";
import {
	SECTION_CONTENT_Y,
	SECTION_TITLE_MID,
	SETTING_ROW_H,
	Section,
	SettingNote,
	SettingRow,
	SettingRowHandle,
	SettingsList,
	ValueKey,
	Window,
	sectionHeight,
	setValueKey,
	settingsListHeight,
} from "./window";

/*
 * Settings: the reference's modal window (DESIGN_RULES UI-07) -- header with the big centred title, "?" and the red
 * X; a tab bar; one section per tab whose rows are "label cell | value cell", the value a slider, a segmented
 * choice or a dark key.
 *
 * What is NOT here any more: the English / Korean switch. Roblox translates the game by the player's own account
 * (src/shared/data/lang.ts only keeps overrides), so that switch changed nothing a player could see.
 */

const UserInputService = game.GetService("UserInputService");

// ---------------------------------------------------------------- layout (1120 x 630 design units)

const WIN_W = 900;
const WIN_H = 576;
const PAD = space(6);
const TAB_H = 34;
/** the section: from under the tab bar to the window's bottom padding */
const SECTION_W = WIN_W - PAD * 2;
/** the list inside a section, inset like the reference's */
const LIST_X = space(4);
const LIST_W = SECTION_W - LIST_X * 2;
const LABEL_W = 220;
/** the touch page: rows on the left, the preview of the player's own screen on the right */
const TOUCH_LIST_W = 500;
const TOUCH_LABEL_W = 170;
/** a slider row: the slider, then its value as a key at the right of the cell */
const VALUE_KEY_W = 72;
const SEGMENT_W = 200;
const SEGMENT_H = 30;

type Tr = (key: string) => string;

function pct(v: number): string {
	return `${math.floor(v * 100 + 0.5)}%`;
}

/** what the "?" of the window explains: what each tab is for, one line each ("#" = new line, see nl) */
const HELP_TEXT = [
	"General: sound effects and music volume, and the size of the on-screen panels.",
	"Touch controls: size, height and side of the phone controls, with a preview of your screen.",
	"Controls: every key and button the game listens to.",
	"About: the game and its credits.",
	"Changes are saved with your progress, by themselves.",
].join("#");

export function showSettings(ctx: GameContext, onBack: () => void, onCredits: () => void): () => void {
	const tr: Tr = (key: string): string => langGet(key, ctx.save.settings.langType);
	const { root, body } = makeScreen(ctx.uiLayer, "Settings");
	const s = ctx.save.settings;
	/** every slider of the screen (disconnected when it closes) */
	const handles: Array<SliderHandle> = [];
	/** redraws the control preview after a touch setting changed */
	let refreshPreview: (() => void) | undefined;
	/** every control of the touch page re-reads the save (used by "Reset controls") */
	const touchRefreshers: Array<() => void> = [];

	/*
	 * Persistence: a settings change is a save like any other, but a slider fires on every pixel of the drag.
	 * The write is therefore coalesced into one request a second at most; leaving the screen goes through the
	 * lobby, which saves again, so nothing can be lost by closing the game right after a change.
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
		x: (1120 - WIN_W) / 2,
		y: (630 - WIN_H) / 2,
		w: WIN_W,
		h: WIN_H,
		title: tr("Settings"),
		onClose: (): void => onBack(),
		onHelp: (): void => {
			popup(ctx, tr("Settings"), nl(tr(HELP_TEXT)), [{ text: tr("Close"), variant: "secondary" }]);
		},
	});
	const panel = win.frame;
	const tabsY = win.contentY + space(1);
	const sectionY = tabsY + TAB_H + space(4);
	const sectionH = WIN_H - sectionY - space(5);

	// ---- rows

	/** a slider row: the slider across the value cell, the value as a key at its right */
	const sliderRow = (
		row: SettingRowHandle,
		name: string,
		valueW: number,
		get: () => number,
		set: (v: number) => void,
		refreshers?: Array<() => void>,
	): void => {
		const cell = row.value;
		const key = ValueKey(cell, `${name}Value`, pct(get()), {
			x: valueW - space(4),
			anchorX: 1,
			minW: VALUE_KEY_W,
			textSize: TEXT.base,
		});
		const handle = Slider(cell, name, {
			x: space(4),
			y: 0,
			w: valueW - space(4) * 2 - VALUE_KEY_W - space(3),
			h: SETTING_ROW_H,
			get,
			set: (v: number): void => {
				set(v);
				setValueKey(key, pct(v));
			},
			zIndex: cell.ZIndex + 1,
		});
		handles.push(handle);
		refreshers?.push(() => {
			handle.refresh();
			setValueKey(key, pct(get()));
		});
	};

	/** an Off / On row: a segmented choice, centred in the value cell */
	const switchRow = (
		row: SettingRowHandle,
		name: string,
		valueW: number,
		get: () => boolean,
		set: (v: boolean) => void,
		refreshers?: Array<() => void>,
	): void => {
		const tabs = Segmented(row.value, name, {
			x: (valueW - SEGMENT_W) / 2,
			y: (SETTING_ROW_H - SEGMENT_H) / 2,
			w: SEGMENT_W,
			h: SEGMENT_H,
			items: [tr("Off"), tr("On")],
			value: get() ? 1 : 0,
			zIndex: row.value.ZIndex + 1,
			onChange: (i: number): void => set(i === 1),
		});
		refreshers?.push(() => tabs.setActive(get() ? 1 : 0));
	};

	/** a text value, centred in the value cell */
	const textRow = (row: SettingRowHandle, valueW: number, text: string): void => {
		makeLabel(row.value, "Text", text, space(3), 0, valueW - space(6), SETTING_ROW_H, TEXT.base, THEME.foreground, {
			zIndex: row.value.ZIndex + 1,
		});
	};

	// ---- pages (built on first visit, then only shown / hidden)

	/** a page: the area under the tab bar, holding one full-height section or a few fitted ones */
	const pageFrame = (index: number): Frame =>
		makeFrame(panel, `Page${index}`, PAD, sectionY, SECTION_W, sectionH, THEME.background, { transparency: 1 });
	/** one section filling the page (a long list scrolls inside it) */
	const pageSection = (index: number, title: string): Frame => {
		const sec = Section(panel, `Page${index}`, { x: PAD, y: sectionY, w: SECTION_W, h: sectionH, title });
		return sec.frame;
	};
	const listY = SECTION_CONTENT_Y;
	const listH = sectionH - sectionHeight(0);

	const buildGeneral = (index: number): Frame => {
		const page = pageFrame(index);
		const valueW = LIST_W - LABEL_W;
		// two short sections, each as tall as its rows: an empty plate under two sliders reads as an unfinished screen
		const audioListH = settingsListHeight([SETTING_ROW_H, SETTING_ROW_H]);
		const audio = Section(page, "Audio", {
			x: 0,
			y: 0,
			w: SECTION_W,
			h: sectionHeight(audioListH),
			title: tr("Audio"),
		});
		const list = SettingsList(audio.frame, "List", LIST_X, listY, LIST_W, audioListH);
		sliderRow(
			SettingRow(list, "Sfx", 0, tr("SFX")),
			"Sfx",
			valueW,
			() => s.soundEffect,
			v => {
				s.soundEffect = v;
				previewSound(previewSfx);
				persist();
			},
		);
		sliderRow(
			SettingRow(list, "Bgm", 1, tr("BGM")),
			"Bgm",
			valueW,
			() => s.bgm,
			v => {
				s.bgm = v;
				previewSound(previewBgm);
				persist();
			},
		);

		const noteH = 40;
		const uiListH = settingsListHeight([SETTING_ROW_H, noteH]);
		const ui = Section(page, "Interface", {
			x: 0,
			y: sectionHeight(audioListH) + space(4),
			w: SECTION_W,
			h: sectionHeight(uiListH),
			title: tr("Interface"),
		});
		const uiList = SettingsList(ui.frame, "List", LIST_X, listY, LIST_W, uiListH);
		sliderRow(
			SettingRow(uiList, "UiSize", 0, tr("HUD size")),
			"UiSize",
			valueW,
			() => s.uiSize,
			v => {
				s.uiSize = v;
				persist();
			},
		);
		SettingNote(
			uiList,
			"Note",
			1,
			tr("HUD size scales the on-screen panels. The touch controls have their own size in Touch controls."),
			noteH,
		);
		return page;
	};

	const buildTouch = (index: number): Frame => {
		const page = pageSection(index, tr("Touch controls"));
		const list = SettingsList(page, "List", LIST_X, listY, TOUCH_LIST_W, listH);
		const opts = { labelW: TOUCH_LABEL_W };
		const valueW = TOUCH_LIST_W - TOUCH_LABEL_W;
		const slider = (name: string, order: number, label: string, get: () => number, set: (v: number) => void) =>
			sliderRow(SettingRow(list, name, order, tr(label), opts), name, valueW, get, set, touchRefreshers);
		slider(
			"LeftSize",
			0,
			"Stick size",
			() => s.leftSize,
			v => {
				s.leftSize = v;
				applyTouch();
			},
		);
		slider(
			"LeftPos",
			1,
			"Stick height",
			() => s.leftPos,
			v => {
				s.leftPos = v;
				applyTouch();
			},
		);
		slider(
			"RightSize",
			2,
			"Aim pad size",
			() => s.rightSize,
			v => {
				s.rightSize = v;
				applyTouch();
			},
		);
		slider(
			"RightPos",
			3,
			"Aim pad height",
			() => s.rightPos,
			v => {
				s.rightPos = v;
				applyTouch();
			},
		);
		switchRow(
			SettingRow(list, "Relative", 4, tr("Floating stick"), opts),
			"Relative",
			valueW,
			() => s.leftRelative,
			v => {
				s.leftRelative = v;
				applyTouch();
			},
			touchRefreshers,
		);
		switchRow(
			SettingRow(list, "Mirror", 5, tr("Left-handed"), opts),
			"Mirror",
			valueW,
			() => s.mirror,
			v => {
				s.mirror = v;
				applyTouch();
			},
			touchRefreshers,
		);
		SettingNote(
			list,
			"Note",
			6,
			tr(
				"Floating stick: the stick opens wherever your thumb lands. Left-handed swaps the stick and the aim pad.",
			),
			48,
		);
		const reset = SettingRow(list, "Reset", 7, tr("Defaults"), opts);
		Button(reset.value, "ResetTouch", tr("Reset controls"), {
			x: (valueW - 180) / 2,
			y: (SETTING_ROW_H - 30) / 2,
			w: 180,
			h: 30,
			size: "sm",
			variant: "secondary",
			zIndex: reset.value.ZIndex + 1,
			onClick: (): void => {
				const d = defaultTouchPrefs();
				s.leftSize = d.leftSize;
				s.leftPos = d.leftPos;
				s.leftRelative = d.leftRelative;
				s.rightSize = d.rightSize;
				s.rightPos = d.rightPos;
				s.mirror = d.mirror;
				for (const fn of touchRefreshers) fn();
				applyTouch();
			},
		});
		const previewX = LIST_X + TOUCH_LIST_W + space(4);
		refreshPreview = buildPreview(ctx, tr, page, previewX, listY, SECTION_W - previewX - LIST_X, listH);
		return page;
	};

	const buildControls = (index: number): Frame => {
		const page = pageSection(index, tr(SCHEMES[0].title));
		const title = page.FindFirstChild("Title") as TextLabel | undefined;
		// the player's own scheme first: a phone player should not have to read the keyboard's to find theirs
		const lastInput = gamepadActive() ? 2 : UserInputService.TouchEnabled && !UserInputService.MouseEnabled ? 1 : 0;
		const lists: Array<Frame> = [];
		const labelW = 320;
		for (let i = 0; i < SCHEMES.size(); i++) {
			const scheme = SCHEMES[i];
			const list = SettingsList(page, `List${i}`, LIST_X, listY, LIST_W, listH);
			for (let r = 0; r < scheme.rows.size(); r++) {
				const [chip, what] = scheme.rows[r];
				const row = SettingRow(list, `Row${r}`, r, tr(what), { labelW });
				ValueKey(row.value, "Key", chip, { minW: 180 });
			}
			SettingNote(list, "Note", scheme.rows.size(), tr(scheme.note));
			lists.push(list.frame.Parent as Frame);
		}
		const show = (i: number): void => {
			for (let k = 0; k < lists.size(); k++) setVisible(lists[k], k === i);
			if (title !== undefined) title.Text = tr(SCHEMES[i].title);
		};
		// the scheme switch sits on the section's title line, at its right
		const schemeNames = SCHEMES.map(sc => tr(sc.title === "Keyboard & mouse" ? "Keyboard" : sc.title));
		const widths = schemeNames.map(n => tabWidth(n, TEXT.base));
		let total = 6 + 3 * (widths.size() - 1);
		for (const wd of widths) total += wd;
		Segmented(page, "Scheme", {
			x: SECTION_W - space(5) - total,
			y: SECTION_TITLE_MID - SEGMENT_H / 2,
			w: total,
			h: SEGMENT_H,
			items: schemeNames,
			widths,
			value: lastInput,
			zIndex: page.ZIndex + 1,
			onChange: show,
		});
		show(lastInput);
		return page;
	};

	const buildAbout = (index: number): Frame => {
		const page = pageFrame(index);
		const aboutListH = settingsListHeight([
			SETTING_ROW_H,
			SETTING_ROW_H,
			SETTING_ROW_H,
			SETTING_ROW_H,
			SETTING_ROW_H,
			SETTING_ROW_H,
		]);
		const about = Section(page, "About", {
			x: 0,
			y: 0,
			w: SECTION_W,
			h: sectionHeight(aboutListH),
			title: tr("About"),
		});
		const list = SettingsList(about.frame, "List", LIST_X, listY, LIST_W, aboutListH);
		const valueW = LIST_W - LABEL_W;
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
		const credits = SettingRow(list, "Credits", 5, tr("Credits"));
		Button(credits.value, "OpenCredits", tr("Open credits"), {
			x: (valueW - 180) / 2,
			y: (SETTING_ROW_H - 30) / 2,
			w: 180,
			h: 30,
			size: "sm",
			variant: "secondary",
			zIndex: credits.value.ZIndex + 1,
			onClick: (): void => onCredits(),
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
		requestSave("menu");
		root.Destroy();
	};
}

// ---------------------------------------------------------------- touch-control preview

/**
 * A scale model of the player's own screen with the controls where they will actually be. It is built from
 * `computeTouchLayout` at the REAL viewport size and then shrunk, so it is the same geometry the thumbs will
 * meet — including the device's shape and the safe area — and not a drawing that has to be kept in sync.
 *
 * It is also the only way a player on a PC (or the author on a monitor) can set up the phone layout at all.
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
	// the drawing lives in its own layer, so a redraw clears it without touching the well's skin layers
	const dots = makeFrame(screen, "Dots", 0, 0, w, h, THEME.background, { transparency: 1, zIndex: screen.ZIndex });
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

	const draw = (): void => {
		for (const child of dots.GetChildren()) child.Destroy();
		const prefs: TouchPrefs = {
			leftSize: ctx.save.settings.leftSize,
			leftPos: ctx.save.settings.leftPos,
			leftRelative: ctx.save.settings.leftRelative,
			rightSize: ctx.save.settings.rightSize,
			rightPos: ctx.save.settings.rightPos,
			mirror: ctx.save.settings.mirror,
		};
		const L: TouchLayout = computeTouchLayout(prefs, ctx.viewW, ctx.viewH, 0);
		const f = w / math.max(L.viewW, 1);
		const dot = (name: string, cx: number, cy: number, r: number, color: Color3, zIndex: number): void => {
			const d = math.max(r * 2 * f, 4);
			const g = makeFrame(dots, name, cx * f - d / 2, cy * f - d / 2, d, d, color, {
				radius: RADIUS.full,
				zIndex: dots.ZIndex + zIndex,
				transparency: 0.25,
			});
			g.BorderSizePixel = 0;
		};
		dot("Stick", L.move.homeX, L.move.homeY, L.move.baseR, THEME.foreground, 1);
		dot("StickKnob", L.move.homeX, L.move.homeY, L.move.knobR, SURFACE.frame, 2);
		dot("Aim", L.aim.homeX, L.aim.homeY, L.aim.baseR, THEME.destructive, 1);
		const btn = (name: string, b: TouchButton, color: Color3): void => dot(name, b.x, b.y, b.r, color, 3);
		btn("Use", L.use, THEME.primary);
		btn("Reload", L.reload, THEME.secondary);
		btn("Bag", L.bag, THEME.secondary);
		btn("Pause", L.pause, THEME.secondary);
		// the weapon card of the HUD, so the player can see nothing is covered
		makeFrame(dots, "Weapon", w / 2 - w * 0.11, h - h * 0.13, w * 0.22, h * 0.09, GAME.info, {
			radius: RADIUS.sm,
			zIndex: dots.ZIndex + 1,
			transparency: 0.55,
		});
	};
	draw();
	return draw;
}
