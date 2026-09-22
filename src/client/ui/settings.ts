import { GameContext } from "shared/game/context";
import { TEXT, THEME, space } from "./theme";
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
	makeLabel,
	makeScreen,
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
const CONTROL_X = PAD + LABEL_W + space(4);
const CONTROL_W = CARD_W - CONTROL_X - space(4) - VALUE_W - PAD;
const VALUE_X = CONTROL_X + CONTROL_W + space(4);
const SWITCH_W = 110;
const LANG_W = 240;

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
			VALUE_X,
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
		handles.push(
			Slider(card, name, {
				x: CONTROL_X,
				y,
				w: CONTROL_W,
				h: ROW_H,
				get,
				set: (v: number): void => {
					set(v);
					value.Text = pct(v);
				},
			}),
		);
	};

	const buildAudio = (card: Frame, y: number): void => {
		sliderRow(
			card,
			"Sfx",
			"SFX",
			y,
			() => s.soundEffect,
			v => {
				s.soundEffect = v;
			},
		);
		sliderRow(
			card,
			"Bgm",
			"BGM",
			y + ROW_STRIDE,
			() => s.bgm,
			v => {
				s.bgm = v;
			},
		);
		sliderRow(
			card,
			"UiSize",
			"HUD size",
			y + ROW_STRIDE * 2,
			() => s.uiSize,
			v => {
				s.uiSize = v;
			},
		);
		const langY = y + ROW_STRIDE * 3;
		rowLabel(card, "Language", langY);
		// langType 0 = English, 1 = Korean (any other value: neither is highlighted)
		const current = s.langType === 0 ? 0 : s.langType === 1 ? 1 : -1;
		Tabs(card, "Language", {
			x: CONTROL_X,
			y: langY,
			w: LANG_W,
			h: ROW_H,
			items: ["English", "Korean"],
			value: current,
			onChange: (i: number): void => {
				s.langType = i;
			},
		});
	};

	const buildMobile = (card: Frame, y: number): void => {
		sliderRow(
			card,
			"LeftSize",
			"Left size",
			y,
			() => s.leftSize,
			v => {
				s.leftSize = v;
			},
		);
		sliderRow(
			card,
			"LeftPos",
			"Left pos",
			y + ROW_STRIDE,
			() => s.leftPos,
			v => {
				s.leftPos = v;
			},
		);
		sliderRow(
			card,
			"RightSize",
			"Right size",
			y + ROW_STRIDE * 2,
			() => s.rightSize,
			v => {
				s.rightSize = v;
			},
		);
		sliderRow(
			card,
			"RightPos",
			"Right pos",
			y + ROW_STRIDE * 3,
			() => s.rightPos,
			v => {
				s.rightPos = v;
			},
		);
		const relY = y + ROW_STRIDE * 4;
		rowLabel(card, "Relative", relY);
		// switch: default (filled) when ON, outline when OFF
		const relBtn = Button(card, "Relative", s.leftRelative ? "ON" : "OFF", {
			x: CONTROL_X,
			y: relY,
			w: SWITCH_W,
			h: ROW_H,
			variant: s.leftRelative ? "default" : "outline",
			onClick: (): void => {
				s.leftRelative = !s.leftRelative;
				relBtn.Text = s.leftRelative ? "ON" : "OFF";
				setButtonVariant(relBtn, s.leftRelative ? "default" : "outline");
			},
		});
	};

	const sections: Array<Section> = [
		{ title: "Audio & display", description: "Volume, HUD size and language", build: buildAudio },
		{ title: "Mobile controls", description: "Size and position of the touch controls", build: buildMobile },
	];

	let card: Frame | undefined;
	const showSection = (index: number): void => {
		for (const h of handles) h.disconnect();
		handles.clear();
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
		root.Destroy();
	};
}
