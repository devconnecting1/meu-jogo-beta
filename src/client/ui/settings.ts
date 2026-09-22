import { GameContext } from "shared/game/context";
import { COLORS } from "shared/engine/colors";
import { fmtNum, makeButton, makeFrame, makeLabel } from "./widgets";

interface SliderHandle {
	disconnect(): void;
}

function makeSlider(
	root: Frame,
	name: string,
	x: number,
	y: number,
	w: number,
	get: () => number,
	set: (v: number) => void,
): SliderHandle {
	const UIS = game.GetService("UserInputService");
	const track = makeFrame(root, name, x, y, w, 12, Color3.fromRGB(50, 50, 58));
	track.Active = true;
	const knob = makeFrame(track, "Knob", 0, 0, 16, 16, COLORS.uiAccent);
	knob.AnchorPoint = new Vector2(0.5, 0.5);
	const valueLabel = makeLabel(root, `${name}Val`, "", x + w + 16, y - 8, 80, 28, 16, COLORS.uiText);
	valueLabel.TextXAlignment = Enum.TextXAlignment.Left;

	const refresh = (): void => {
		const v = get();
		knob.Position = UDim2.fromScale(v, 0.5);
		valueLabel.Text = fmtNum(v);
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

export function showSettings(ctx: GameContext, onBack: () => void, onCredits: () => void): () => void {
	const root = makeFrame(ctx.uiLayer, "Settings", 0, 0, 1120, 630, COLORS.bg);
	makeFrame(root, "TopBar", 0, 0, 1120, 64, Color3.fromRGB(65, 65, 65));
	makeLabel(root, "Title", "Settings", 60, 14, 400, 44, 30, COLORS.uiText);
	const s = ctx.save.settings;
	const handles: Array<SliderHandle> = [];

	const label = (text: string, x: number, y: number): void => {
		const l = makeLabel(root, text, text, x, y, 160, 30, 18, COLORS.uiText);
		l.TextXAlignment = Enum.TextXAlignment.Left;
	};

	label("SFX", 80, 110);
	handles.push(
		makeSlider(
			root,
			"SfxSlider",
			250,
			114,
			240,
			() => s.soundEffect,
			v => {
				s.soundEffect = v;
			},
		),
	);
	label("BGM", 80, 180);
	handles.push(
		makeSlider(
			root,
			"BgmSlider",
			250,
			184,
			240,
			() => s.bgm,
			v => {
				s.bgm = v;
			},
		),
	);
	label("UI size", 80, 250);
	handles.push(
		makeSlider(
			root,
			"UiSlider",
			250,
			254,
			240,
			() => s.uiSize,
			v => {
				s.uiSize = v;
			},
		),
	);

	label("Left size", 600, 110);
	handles.push(
		makeSlider(
			root,
			"LeftSizeSlider",
			770,
			114,
			240,
			() => s.leftSize,
			v => {
				s.leftSize = v;
			},
		),
	);
	label("Left pos", 600, 180);
	handles.push(
		makeSlider(
			root,
			"LeftPosSlider",
			770,
			184,
			240,
			() => s.leftPos,
			v => {
				s.leftPos = v;
			},
		),
	);
	label("Right size", 600, 250);
	handles.push(
		makeSlider(
			root,
			"RightSizeSlider",
			770,
			254,
			240,
			() => s.rightSize,
			v => {
				s.rightSize = v;
			},
		),
	);
	label("Right pos", 600, 320);
	handles.push(
		makeSlider(
			root,
			"RightPosSlider",
			770,
			324,
			240,
			() => s.rightPos,
			v => {
				s.rightPos = v;
			},
		),
	);

	const relBtn = makeButton(root, "Relative", "", 600, 390, 240, 44, COLORS.uiPanelLight, (): void => {
		s.leftRelative = !s.leftRelative;
		relBtn.Text = `Relative: ${s.leftRelative ? "ON" : "OFF"}`;
	});
	relBtn.Text = `Relative: ${s.leftRelative ? "ON" : "OFF"}`;

	const engBtn = makeButton(root, "Eng", "English", 870, 390, 140, 44, COLORS.uiPanelLight, (): void => {
		s.langType = 0;
		engBtn.BackgroundColor3 = COLORS.uiAccent;
		korBtn.BackgroundColor3 = COLORS.uiPanelLight;
	});
	const korBtn = makeButton(root, "Kor", "Korean", 870, 450, 140, 44, COLORS.uiPanelLight, (): void => {
		s.langType = 1;
		korBtn.BackgroundColor3 = COLORS.uiAccent;
		engBtn.BackgroundColor3 = COLORS.uiPanelLight;
	});
	if (s.langType === 0) {
		engBtn.BackgroundColor3 = COLORS.uiAccent;
	} else {
		korBtn.BackgroundColor3 = COLORS.uiAccent;
	}

	makeButton(root, "Credits", "Credits", 80, 540, 160, 48, COLORS.uiPanelLight, (): void => onCredits());
	makeButton(root, "Back", "Back", 940, 540, 140, 48, COLORS.uiPanelLight, (): void => onBack());

	return (): void => {
		for (const h of handles) h.disconnect();
		root.Destroy();
	};
}
