import { BORDER, RADIUS, TEXT, THEME, fontOf, roleFont, space } from "../ui/theme";
import { addCorner, addStroke, makeFrame, makeLabel, scaleText, setStrokeWidth, uiScale } from "../ui/widgets";

/*
 * Form controls the UI kit does not have yet (Input, Switch, Tooltip), built the same way as the kit: design units
 * relative to the parent (DesignW/DesignH), colours only from theme tokens (shadcn roles: Input = border-input +
 * transparent background + ring on focus; Switch = primary when on / input when off, background thumb).
 */

export interface TextInputProps {
	x: number;
	y: number;
	w: number;
	h?: number;
	placeholder?: string;
	text?: string;
	maxLength?: number;
	/** digits only (a leading "-" is not allowed either) */
	numeric?: boolean;
	onSubmit?: (text: string) => void;
	zIndex?: number;
}

export interface TextInputHandle {
	frame: Frame;
	box: TextBox;
	get(): string;
	set(text: string): void;
	/** the value as an integer (undefined when empty or not a number) */
	getInt(): number | undefined;
}

/** shadcn Input: 1 px `input` border, transparent background, `ring` border while focused */
export function TextInput(parent: Instance, name: string, props: TextInputProps): TextInputHandle {
	const h = props.h ?? 36;
	const frame = makeFrame(parent, name, props.x, props.y, props.w, h, THEME.background, {
		transparency: 1,
		radius: RADIUS.md,
		stroke: THEME.input,
		zIndex: props.zIndex,
	});
	const stroke = frame.FindFirstChildOfClass("UIStroke");
	const box = new Instance("TextBox");
	box.Name = "Box";
	box.Size = UDim2.fromScale(1, 1);
	box.BackgroundTransparency = 1;
	box.BackgroundColor3 = THEME.background;
	box.BorderSizePixel = 0;
	box.ClearTextOnFocus = false;
	box.Text = props.text ?? "";
	box.PlaceholderText = props.placeholder ?? "";
	box.PlaceholderColor3 = THEME.mutedForeground;
	box.TextColor3 = THEME.foreground;
	box.FontFace = roleFont("body");
	box.TextXAlignment = Enum.TextXAlignment.Left;
	box.TextTruncate = Enum.TextTruncate.AtEnd;
	box.ZIndex = frame.ZIndex + 1;
	scaleText(box, TEXT.sm);
	const pad = new Instance("UIPadding");
	pad.PaddingLeft = new UDim(space(3) / props.w, 0);
	pad.PaddingRight = new UDim(space(3) / props.w, 0);
	pad.PaddingTop = new UDim(0.18, 0);
	pad.PaddingBottom = new UDim(0.18, 0);
	pad.Parent = box;
	box.Parent = frame;
	const max = props.maxLength;
	box.GetPropertyChangedSignal("Text").Connect(() => {
		let t = box.Text;
		if (props.numeric === true) {
			const [digits] = t.gsub("%D", "");
			t = digits;
		}
		if (max !== undefined) {
			// limit in characters, cut on a character boundary (never inside "ç" / "ã")
			const [n] = utf8.len(t);
			if (typeIs(n, "number") && n > max) {
				const cut = utf8.offset(t, max + 1);
				if (cut !== undefined) t = t.sub(1, cut - 1);
			}
		}
		if (t !== box.Text) box.Text = t;
	});
	box.Focused.Connect(() => {
		if (stroke === undefined) return;
		stroke.Color = THEME.ring;
		setStrokeWidth(stroke, BORDER.ring);
	});
	box.FocusLost.Connect(enter => {
		if (stroke !== undefined) {
			stroke.Color = THEME.input;
			setStrokeWidth(stroke, BORDER.width);
		}
		if (enter && props.onSubmit !== undefined) props.onSubmit(box.Text);
	});
	return {
		frame,
		box,
		get(): string {
			return box.Text;
		},
		set(text: string): void {
			box.Text = text;
		},
		getInt(): number | undefined {
			const n = tonumber(box.Text);
			return n !== undefined ? math.floor(n) : undefined;
		},
	};
}

export interface SwitchProps {
	x: number;
	y: number;
	w: number;
	label: string;
	/** muted line under the label */
	description?: string;
	value: boolean;
	onChange: (value: boolean) => void;
	zIndex?: number;
}

export interface SwitchHandle {
	frame: Frame;
	set(value: boolean): void;
	get(): boolean;
}

const TRACK_W = 40;
const TRACK_H = 22;
const THUMB = 16;

/** shadcn Switch + Label row: the whole row toggles */
export function Switch(parent: Instance, name: string, props: SwitchProps): SwitchHandle {
	const hasDesc = props.description !== undefined && props.description !== "";
	const h = hasDesc ? 44 : 30;
	const z = props.zIndex ?? 2;
	const row = makeFrame(parent, name, props.x, props.y, props.w, h, THEME.background, { transparency: 1, zIndex: z });
	const textW = props.w - TRACK_W - space(3);
	makeLabel(row, "Label", props.label, 0, 0, textW, hasDesc ? 22 : h, TEXT.sm, THEME.foreground, {
		font: "label",
		align: "left",
		zIndex: z + 1,
	});
	if (hasDesc) {
		makeLabel(row, "Description", props.description!, 0, 22, textW, 20, TEXT.xs, THEME.mutedForeground, {
			align: "left",
			valign: "top",
			zIndex: z + 1,
		});
	}
	const trackY = hasDesc ? 2 : (h - TRACK_H) / 2;
	const track = makeFrame(row, "Track", props.w - TRACK_W, trackY, TRACK_W, TRACK_H, THEME.input, {
		radius: RADIUS.full,
		zIndex: z + 1,
	});
	const thumb = makeFrame(track, "Thumb", 3, (TRACK_H - THUMB) / 2, THUMB, THUMB, THEME.background, {
		radius: RADIUS.full,
		zIndex: z + 2,
	});
	const hit = new Instance("TextButton");
	hit.Name = "Hit";
	hit.Size = UDim2.fromScale(1, 1);
	hit.BackgroundTransparency = 1;
	hit.BackgroundColor3 = THEME.background;
	hit.TextColor3 = THEME.foreground;
	hit.Text = "";
	hit.AutoButtonColor = false;
	hit.ZIndex = z + 3;
	hit.Parent = row;
	let value = props.value;
	const draw = (): void => {
		track.BackgroundColor3 = value ? THEME.primary : THEME.input;
		thumb.Position = UDim2.fromScale((value ? TRACK_W - THUMB - 3 : 3) / TRACK_W, thumb.Position.Y.Scale);
	};
	draw();
	hit.Activated.Connect(() => {
		value = !value;
		draw();
		props.onChange(value);
	});
	return {
		frame: row,
		set(v: boolean): void {
			value = v;
			draw();
		},
		get(): boolean {
			return value;
		},
	};
}

/**
 * Tooltip (popover) shown while the mouse is over `target`. A transparent, non-Active sensor frame sits on top of
 * the target, so it also works on disabled buttons (which do not receive input).
 */
export function attachTooltip(target: GuiObject, text: string, width = 220): void {
	const sensor = new Instance("Frame");
	sensor.Name = "TooltipSensor";
	sensor.Size = UDim2.fromScale(1, 1);
	sensor.BackgroundTransparency = 1;
	sensor.BackgroundColor3 = THEME.background;
	sensor.BorderSizePixel = 0;
	sensor.Active = false;
	sensor.ZIndex = target.ZIndex + 5;
	sensor.Parent = target;
	const k = uiScale();
	const tip = new Instance("TextLabel");
	tip.Name = "Tooltip";
	tip.AnchorPoint = new Vector2(0.5, 1);
	tip.Position = new UDim2(0.5, 0, 0, -math.round(6 * k));
	tip.AutomaticSize = Enum.AutomaticSize.XY;
	tip.Size = UDim2.fromOffset(0, 0);
	tip.BackgroundColor3 = THEME.popover;
	tip.BorderSizePixel = 0;
	tip.TextColor3 = THEME.popoverForeground;
	tip.FontFace = fontOf("sans", Enum.FontWeight.Medium);
	tip.TextSize = math.max(10, math.round(TEXT.sm * k));
	tip.Text = text;
	// long texts wrap inside `width` (design units, scaled like the rest of the UI) instead of running off screen
	tip.TextWrapped = true;
	tip.TextXAlignment = Enum.TextXAlignment.Left;
	tip.Visible = false;
	tip.ZIndex = target.ZIndex + 20;
	const padX = math.round(space(2) * k);
	const padY = math.round(space(1.5) * k);
	const pad = new Instance("UIPadding");
	pad.PaddingLeft = new UDim(0, padX);
	pad.PaddingRight = new UDim(0, padX);
	pad.PaddingTop = new UDim(0, padY);
	pad.PaddingBottom = new UDim(0, padY);
	pad.Parent = tip;
	const size = new Instance("UISizeConstraint");
	size.MaxSize = new Vector2(math.round(width * k), math.huge);
	size.Parent = tip;
	addCorner(tip, RADIUS.md, width, 28);
	addStroke(tip, THEME.border);
	tip.Parent = target;
	sensor.MouseEnter.Connect(() => {
		tip.Visible = true;
	});
	sensor.MouseLeave.Connect(() => {
		tip.Visible = false;
	});
}
