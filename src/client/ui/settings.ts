import { GameContext } from "shared/game/context";
import { computeTouchLayout, defaultTouchPrefs, TouchButton, TouchLayout, TouchPrefs } from "shared/engine/input";
import { previewBgm, previewSfx } from "../audio";
import { refreshTouchLayout } from "../bootstrap";
import { requestSave } from "../systems/saveClient";
import { GAME, RADIUS, SURFACE, TEXT, THEME, space } from "./theme";
import {
	BUTTON_SIZE,
	Button,
	Card,
	CardHeader,
	Slider,
	SliderHandle,
	Sidebar,
	Tabs,
	autoFocus,
	makeFrame,
	makeLabel,
	makeScreen,
	makeSurface,
	setButtonVariant,
} from "./widgets";

// ---------------------------------------------------------------- layout (1120 x 630 design units)

const MARGIN_X = 40;
/** header row: Back button and title share this vertical centre */
const HEADER_Y = 32;
/** section navigation (left) and the selected section's card (right) */
const MAIN_Y = 96;
const MAIN_H = 512;
const NAV_W = 200;
const CREDITS_H = BUTTON_SIZE.default.h;
const NAV_H = MAIN_H - CREDITS_H - space(4);
const CARD_X = MARGIN_X + NAV_W + space(4);
const CARD_W = 1120 - MARGIN_X - CARD_X;

/** one setting per row: label | control | value */
const PAD = space(6);
const ROW_H = 40;
const ROW_STRIDE = ROW_H + space(4);
const LABEL_W = 160;
const VALUE_W = 72;
const SWITCH_W = 110;
const LANG_W = 240;

/** the touch-control preview pane (right of the mobile rows): a scale model of the player's own screen */
const PREVIEW_W = 300;

interface RowGeom {
	controlX: number;
	controlW: number;
	valueX: number;
}

/** the row geometry inside a card of `cardW`, leaving `reserved` design units free on the right */
function rowGeom(cardW: number, reserved: number): RowGeom {
	const controlX = PAD + LABEL_W + space(4);
	const controlW = cardW - reserved - controlX - space(4) - VALUE_W - PAD;
	return { controlX, controlW, valueX: controlX + controlW + space(4) };
}

interface Section {
	title: string;
	description: string;
	/** fills the section's card from `y` (below the CardHeader) */
	build: (card: Frame, y: number) => void;
}

function pct(v: number): string {
	return `${math.floor(v * 100 + 0.5)}%`;
}

export function showSettings(ctx: GameContext, onBack: () => void, onCredits: () => void): () => void {
	const { root, body } = makeScreen(ctx.uiLayer, "Settings");
	const s = ctx.save.settings;
	/** sliders of the section on screen (disconnected when the section changes or the screen closes) */
	const handles: Array<SliderHandle> = [];
	/** redraws the control preview after a mobile setting changed */
	let refreshPreview: (() => void) | undefined;
	/** every control of the section on screen re-reads the save (used by "Reset controls") */
	const refreshers: Array<() => void> = [];

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

	Button(body, "Back", "‹  Back", {
		x: MARGIN_X,
		y: HEADER_Y,
		w: 124,
		variant: "secondary",
		onClick: (): void => onBack(),
	});
	makeLabel(body, "Title", "Settings", 184, HEADER_Y, 400, BUTTON_SIZE.default.h, TEXT.xl3, THEME.foreground, {
		font: "title",
		align: "left",
	});

	const rowLabel = (card: Frame, text: string, y: number): void => {
		makeLabel(card, `${text}Label`, text, PAD, y, LABEL_W, ROW_H, TEXT.sm, THEME.foreground, {
			font: "label",
			align: "left",
		});
	};

	const sliderRow = (
		card: Frame,
		g: RowGeom,
		name: string,
		label: string,
		y: number,
		get: () => number,
		set: (v: number) => void,
	): void => {
		rowLabel(card, label, y);
		const value = makeLabel(
			card,
			`${name}Value`,
			pct(get()),
			g.valueX,
			y,
			VALUE_W,
			ROW_H,
			TEXT.base,
			THEME.foreground,
			{
				font: "numeric",
				align: "right",
			},
		);
		const handle = Slider(card, name, {
			x: g.controlX,
			y,
			w: g.controlW,
			h: ROW_H,
			get,
			set: (v: number): void => {
				set(v);
				value.Text = pct(v);
			},
		});
		handles.push(handle);
		refreshers.push(() => {
			handle.refresh();
			value.Text = pct(get());
		});
	};

	/** an ON / OFF switch row (filled when on, outlined when off) */
	const switchRow = (
		card: Frame,
		g: RowGeom,
		name: string,
		label: string,
		y: number,
		get: () => boolean,
		set: (v: boolean) => void,
	): void => {
		rowLabel(card, label, y);
		// declared first: the closure below must capture the variable, not a later one
		let btn: TextButton | undefined;
		const paint = (): void => {
			if (btn === undefined) return;
			btn.Text = get() ? "ON" : "OFF";
			setButtonVariant(btn, get() ? "default" : "outline");
		};
		btn = Button(card, name, get() ? "ON" : "OFF", {
			x: g.controlX,
			y,
			w: SWITCH_W,
			h: ROW_H,
			variant: get() ? "default" : "outline",
			onClick: (): void => {
				set(!get());
				paint();
			},
		});
		refreshers.push(paint);
	};

	const buildAudio = (card: Frame, y: number): void => {
		const g = rowGeom(CARD_W, 0);
		sliderRow(
			card,
			g,
			"Sfx",
			"SFX",
			y,
			() => s.soundEffect,
			v => {
				s.soundEffect = v;
				previewSound(previewSfx);
				persist();
			},
		);
		sliderRow(
			card,
			g,
			"Bgm",
			"BGM",
			y + ROW_STRIDE,
			() => s.bgm,
			v => {
				s.bgm = v;
				previewSound(previewBgm);
				persist();
			},
		);
		sliderRow(
			card,
			g,
			"UiSize",
			"HUD size",
			y + ROW_STRIDE * 2,
			() => s.uiSize,
			v => {
				s.uiSize = v;
				persist();
			},
		);
		const langY = y + ROW_STRIDE * 3;
		rowLabel(card, "Language", langY);
		// langType 0 = English, 1 = Korean (any other value: neither is highlighted)
		const current = s.langType === 0 ? 0 : s.langType === 1 ? 1 : -1;
		Tabs(card, "Language", {
			x: g.controlX,
			y: langY,
			w: LANG_W,
			h: ROW_H,
			items: ["English", "Korean"],
			value: current,
			onChange: (i: number): void => {
				s.langType = i;
				persist();
			},
		});
		makeLabel(
			card,
			"AudioNote",
			"HUD size scales the on-screen panels. The touch controls have their own size in Touch controls.",
			PAD,
			y + ROW_STRIDE * 4 + space(2),
			CARD_W - PAD * 2,
			36,
			TEXT.xs,
			THEME.mutedForeground,
			{ align: "left", valign: "top" },
		);
	};

	const buildMobile = (card: Frame, y: number): void => {
		const g = rowGeom(CARD_W, PREVIEW_W + space(4));
		sliderRow(
			card,
			g,
			"LeftSize",
			"Stick size",
			y,
			() => s.leftSize,
			v => {
				s.leftSize = v;
				applyTouch();
			},
		);
		sliderRow(
			card,
			g,
			"LeftPos",
			"Stick height",
			y + ROW_STRIDE,
			() => s.leftPos,
			v => {
				s.leftPos = v;
				applyTouch();
			},
		);
		sliderRow(
			card,
			g,
			"RightSize",
			"Aim pad size",
			y + ROW_STRIDE * 2,
			() => s.rightSize,
			v => {
				s.rightSize = v;
				applyTouch();
			},
		);
		sliderRow(
			card,
			g,
			"RightPos",
			"Aim pad height",
			y + ROW_STRIDE * 3,
			() => s.rightPos,
			v => {
				s.rightPos = v;
				applyTouch();
			},
		);
		switchRow(
			card,
			g,
			"Relative",
			"Floating stick",
			y + ROW_STRIDE * 4,
			() => s.leftRelative,
			v => {
				s.leftRelative = v;
				applyTouch();
			},
		);
		switchRow(
			card,
			g,
			"Mirror",
			"Left-handed",
			y + ROW_STRIDE * 5,
			() => s.mirror,
			v => {
				s.mirror = v;
				applyTouch();
			},
		);
		makeLabel(
			card,
			"MobileNote",
			"Floating stick: the stick opens wherever your thumb lands. Left-handed swaps the stick and the aim pad.",
			PAD,
			y + ROW_STRIDE * 6 + space(1),
			g.valueX + VALUE_W - PAD,
			40,
			TEXT.xs,
			THEME.mutedForeground,
			{ align: "left", valign: "top" },
		);
		const resetY = y + ROW_STRIDE * 6 + space(1) + 44;
		Button(card, "ResetTouch", "Reset controls", {
			x: PAD,
			y: resetY,
			w: 190,
			variant: "secondary",
			onClick: (): void => {
				const d = defaultTouchPrefs();
				s.leftSize = d.leftSize;
				s.leftPos = d.leftPos;
				s.leftRelative = d.leftRelative;
				s.rightSize = d.rightSize;
				s.rightPos = d.rightPos;
				s.mirror = d.mirror;
				for (const fn of refreshers) fn();
				applyTouch();
			},
		});
		refreshPreview = buildPreview(ctx, card, y);
	};

	const sections: Array<Section> = [
		{ title: "Audio & display", description: "Volume, HUD size and language", build: buildAudio },
		{
			title: "Touch controls",
			description: "Size, height and side of the on-screen controls",
			build: buildMobile,
		},
	];

	let card: Frame | undefined;
	const showSection = (index: number): void => {
		for (const h of handles) h.disconnect();
		handles.clear();
		refreshers.clear();
		refreshPreview = undefined;
		card?.Destroy();
		const section = sections[index];
		const c = Card(body, "Section", { x: CARD_X, y: MAIN_Y, w: CARD_W, h: MAIN_H });
		card = c;
		section.build(c, CardHeader(c, section.title, section.description));
	};

	const nav = Sidebar(body, "Sections", {
		x: MARGIN_X,
		y: MAIN_Y,
		w: NAV_W,
		h: NAV_H,
		items: sections.map(sec => sec.title),
		value: 0,
		onChange: (i: number): void => showSection(i),
	});
	showSection(0);

	Button(body, "Credits", "Credits", {
		x: MARGIN_X,
		y: MAIN_Y + MAIN_H - CREDITS_H,
		w: NAV_W,
		variant: "secondary",
		onClick: (): void => onCredits(),
	});

	autoFocus(nav.items[0]);

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
function buildPreview(ctx: GameContext, card: Frame, y: number): () => void {
	const x = CARD_W - PREVIEW_W - PAD; // flush with the card's right padding
	const aspect = math.max(ctx.viewH, 1) / math.max(ctx.viewW, 1);
	const h = math.min(PREVIEW_W * aspect, MAIN_H - y - PAD - 28);
	const w = h / aspect;
	const px = x + (PREVIEW_W - w) / 2;
	const screen = makeSurface(card, "Preview", px, y, w, h, "well", { clips: true });
	makeLabel(
		card,
		"PreviewCaption",
		`Your screen · ${math.floor(ctx.viewW)} x ${math.floor(ctx.viewH)}`,
		x,
		y + h + space(1),
		PREVIEW_W,
		20,
		TEXT.xs,
		THEME.mutedForeground,
	);

	const draw = (): void => {
		for (const child of screen.GetChildren()) {
			if (child.IsA("GuiObject")) child.Destroy();
		}
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
			const g = makeFrame(screen, name, cx * f - d / 2, cy * f - d / 2, d, d, color, {
				radius: RADIUS.full,
				zIndex,
				transparency: 0.25,
			});
			g.BorderSizePixel = 0;
		};
		dot("Stick", L.move.homeX, L.move.homeY, L.move.baseR, THEME.foreground, 3);
		dot("StickKnob", L.move.homeX, L.move.homeY, L.move.knobR, SURFACE.frame, 4);
		dot("Aim", L.aim.homeX, L.aim.homeY, L.aim.baseR, THEME.destructive, 3);
		const btn = (name: string, b: TouchButton, color: Color3): void => dot(name, b.x, b.y, b.r, color, 5);
		btn("Use", L.use, THEME.primary);
		btn("Reload", L.reload, THEME.secondary);
		btn("Bag", L.bag, THEME.secondary);
		btn("Pause", L.pause, THEME.secondary);
		// the weapon card of the HUD, so the player can see nothing is covered
		makeFrame(screen, "Weapon", w / 2 - w * 0.11, h - h * 0.13, w * 0.22, h * 0.09, GAME.info, {
			radius: RADIUS.sm,
			zIndex: 2,
			transparency: 0.55,
		});
	};
	draw();
	return draw;
}
