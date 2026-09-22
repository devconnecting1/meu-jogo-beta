import { GameContext } from "shared/game/context";
import {
	ButtonStyle,
	FONTS,
	PALETTE,
	addAspect,
	makeButton,
	makeFrame,
	makeLabel,
	makePanel,
	makeScreen,
	setButtonStyle,
} from "./widgets";

interface SliderHandle {
	disconnect(): void;
}

const PANEL_W = 500;
const PANEL_H = 420;
const LABEL_W = 120;
const TRACK_X = 160;
const TRACK_W = 230;
const TRACK_H = 14;
const KNOB_SIZE = 20;
const VALUE_X = TRACK_X + TRACK_W + 16;
const VALUE_W = 70;

/** rounded track + accent fill + circular knob; drag via track InputBegan/InputEnded + UserInputService.InputChanged */
function makeSlider(
	panel: Frame,
	name: string,
	rowY: number,
	get: () => number,
	set: (v: number) => void,
): SliderHandle {
	const UIS = game.GetService("UserInputService");
	const track = makeFrame(
		panel,
		`${name}Track`,
		TRACK_X,
		rowY + (30 - TRACK_H) / 2,
		TRACK_W,
		TRACK_H,
		PALETTE.bgRaised,
		{
			radius: TRACK_H / 2,
			stroke: PALETTE.stroke,
			strokeTransparency: 0.2,
		},
	);
	track.Active = true;
	const fill = makeFrame(track, "Fill", 0, 0, TRACK_W, TRACK_H, PALETTE.accent, { radius: TRACK_H / 2 });
	const knob = makeFrame(track, "Knob", 0, TRACK_H / 2, KNOB_SIZE, KNOB_SIZE, PALETTE.text, {
		radius: KNOB_SIZE,
		stroke: PALETTE.accent,
		strokeThickness: 2,
		zIndex: 3,
	});
	knob.AnchorPoint = new Vector2(0.5, 0.5);
	addAspect(knob, 1);

	const valueLabel = makeLabel(panel, `${name}Val`, "", VALUE_X, rowY, VALUE_W, 30, 16, PALETTE.text, {
		font: FONTS.bold,
		align: "right",
	});

	const refresh = (): void => {
		const v = get();
		fill.Size = UDim2.fromScale(v, 1);
		knob.Position = UDim2.fromScale(v, 0.5);
		valueLabel.Text = `${math.floor(v * 100 + 0.5)}%`;
	};
	const apply = (px: number): void => {
		const rel = math.clamp((px - track.AbsolutePosition.X) / math.max(track.AbsoluteSize.X, 1), 0, 1);
		const v = math.clamp(math.round(rel / 0.05) * 0.05, 0, 1);
		set(v);
		refresh();
	};
	let dragging = false;
	const connDown = track.InputBegan.Connect((input: InputObject): void => {
		if (
			input.UserInputType === Enum.UserInputType.MouseButton1 ||
			input.UserInputType === Enum.UserInputType.Touch
		) {
			dragging = true;
			apply(input.Position.X);
		}
	});
	const connUp = track.InputEnded.Connect((input: InputObject): void => {
		if (
			input.UserInputType === Enum.UserInputType.MouseButton1 ||
			input.UserInputType === Enum.UserInputType.Touch
		) {
			dragging = false;
		}
	});
	const connMove = UIS.InputChanged.Connect((input: InputObject): void => {
		if (
			dragging &&
			(input.UserInputType === Enum.UserInputType.MouseMovement ||
				input.UserInputType === Enum.UserInputType.Touch)
		) {
			apply(input.Position.X);
		}
	});
	refresh();
	return {
		disconnect(): void {
			connDown.Disconnect();
			connUp.Disconnect();
			connMove.Disconnect();
		},
	};
}

function rowLabel(panel: Frame, text: string, y: number): void {
	makeLabel(panel, text, text, 24, y, LABEL_W, 30, 18, PALETTE.textDim, { font: FONTS.medium, align: "left" });
}

export function showSettings(ctx: GameContext, onBack: () => void, onCredits: () => void): () => void {
	const { root, body } = makeScreen(ctx.uiLayer, "Settings", { gradient: true });
	const s = ctx.save.settings;
	const handles: Array<SliderHandle> = [];

	makeButton(body, "Back", "‹  Back", 40, 28, 124, 50, "secondary", (): void => onBack());
	makeLabel(body, "Title", "Settings", 184, 24, 400, 58, 36, PALETTE.text, { font: FONTS.display, align: "left" });

	// --- Audio & display ---------------------------------------------------
	const audioPanel = makePanel(body, "AudioPanel", 40, 100, PANEL_W, PANEL_H);
	makeLabel(audioPanel, "AudioTitle", "Audio & display", 24, 16, PANEL_W - 48, 30, 20, PALETTE.text, {
		font: FONTS.bold,
		align: "left",
	});

	rowLabel(audioPanel, "SFX", 76);
	handles.push(
		makeSlider(
			audioPanel,
			"Sfx",
			76,
			() => s.soundEffect,
			v => {
				s.soundEffect = v;
			},
		),
	);
	rowLabel(audioPanel, "BGM", 156);
	handles.push(
		makeSlider(
			audioPanel,
			"Bgm",
			156,
			() => s.bgm,
			v => {
				s.bgm = v;
			},
		),
	);
	rowLabel(audioPanel, "HUD size", 236);
	handles.push(
		makeSlider(
			audioPanel,
			"UiSize",
			236,
			() => s.uiSize,
			v => {
				s.uiSize = v;
			},
		),
	);

	rowLabel(audioPanel, "Language", 316);
	const engBtn = makeButton(audioPanel, "Eng", "English", TRACK_X, 310, 110, 40, "secondary", (): void => {
		s.langType = 0;
		setButtonStyle(engBtn, "primary");
		setButtonStyle(korBtn, "secondary");
	});
	const korBtn = makeButton(audioPanel, "Kor", "Korean", TRACK_X + 120, 310, 110, 40, "secondary", (): void => {
		s.langType = 1;
		setButtonStyle(korBtn, "primary");
		setButtonStyle(engBtn, "secondary");
	});
	setButtonStyle(engBtn, s.langType === 0 ? "primary" : "secondary");
	setButtonStyle(korBtn, s.langType === 1 ? "primary" : "secondary");

	// --- Mobile controls -----------------------------------------------------
	const mobilePanel = makePanel(body, "MobilePanel", 580, 100, PANEL_W, PANEL_H);
	makeLabel(mobilePanel, "MobileTitle", "Mobile controls", 24, 16, PANEL_W - 48, 30, 20, PALETTE.text, {
		font: FONTS.bold,
		align: "left",
	});

	rowLabel(mobilePanel, "Left size", 66);
	handles.push(
		makeSlider(
			mobilePanel,
			"LeftSize",
			66,
			() => s.leftSize,
			v => {
				s.leftSize = v;
			},
		),
	);
	rowLabel(mobilePanel, "Left pos", 141);
	handles.push(
		makeSlider(
			mobilePanel,
			"LeftPos",
			141,
			() => s.leftPos,
			v => {
				s.leftPos = v;
			},
		),
	);
	rowLabel(mobilePanel, "Right size", 216);
	handles.push(
		makeSlider(
			mobilePanel,
			"RightSize",
			216,
			() => s.rightSize,
			v => {
				s.rightSize = v;
			},
		),
	);
	rowLabel(mobilePanel, "Right pos", 291);
	handles.push(
		makeSlider(
			mobilePanel,
			"RightPos",
			291,
			() => s.rightPos,
			v => {
				s.rightPos = v;
			},
		),
	);

	rowLabel(mobilePanel, "Relative", 366);
	const relStyle = (): ButtonStyle => (s.leftRelative ? "primary" : "secondary");
	const relBtn = makeButton(mobilePanel, "Relative", "", TRACK_X, 360, 110, 40, relStyle(), (): void => {
		s.leftRelative = !s.leftRelative;
		relBtn.Text = s.leftRelative ? "ON" : "OFF";
		setButtonStyle(relBtn, relStyle());
	});
	relBtn.Text = s.leftRelative ? "ON" : "OFF";

	makeButton(body, "Credits", "Credits", 40, 552, 160, 48, "secondary", (): void => onCredits());

	return (): void => {
		for (const h of handles) h.disconnect();
		root.Destroy();
	};
}
