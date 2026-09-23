import { SURFACE, TEXT, THEME, fontOf, roleFont, space } from "../ui/theme";
import { makeFrame, makeLabel, makeSurface, scaleText, setSurface, uiScale } from "../ui/widgets";

/*
 * Form controls the UI kit does not have yet (Input, Switch, Tooltip), built the same way as the kit: design units
 * relative to the parent (DesignW/DesignH), colours only from theme tokens, relief from the kit's surfaces
 * (skin.ts). In the "Pixel Quest relief" look:
 * - Input: a WELL sunk into the panel (dark fill + 1 px `input` border), the border turning `ring` while focused
 * - Switch: the track is a well (`input` off / `primary` on), the thumb a small raised plate
 * - Tooltip: a well popover with the dark text contour of the reference art
 *
 * Skin layers are children with a negative ZIndex, and with ZIndexBehavior.Sibling children always draw ABOVE
 * their parent: text that must sit over a surface is a child of it (as the kit's buttons do with their "Label").
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

/** shadcn Input as a kit well: `well` fill, 1 px `input` border, `ring` border while focused */
export function TextInput(parent: Instance, name: string, props: TextInputProps): TextInputHandle {
	const h = props.h ?? 36;
	const frame = makeSurface(parent, name, props.x, props.y, props.w, h, "well", {
		fill: SURFACE.well,
		border: THEME.input,
		zIndex: props.zIndex,
	});
	// the TextBox is a child of the well, so it draws above the skin layers (see the header)
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
		setSurface(frame, "well", { fill: SURFACE.well, border: THEME.ring });
	});
	box.FocusLost.Connect(enter => {
		setSurface(frame, "well", { fill: SURFACE.well, border: THEME.input });
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
	// track: a well (dark `input` off, `primary` on); thumb: a small raised plate, as in the reference art
	const track = makeSurface(row, "Track", props.w - TRACK_W, trackY, TRACK_W, TRACK_H, "well", {
		fill: props.value ? THEME.primary : THEME.input,
		border: SURFACE.line,
		zIndex: z + 1,
	});
	const thumb = makeSurface(track, "Thumb", 3, (TRACK_H - THUMB) / 2, THUMB, THUMB, "raised", {
		fill: THEME.foreground,
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
		setSurface(track, "well", { fill: value ? THEME.primary : THEME.input, border: SURFACE.line });
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
	// the box is a kit well; its text is a CHILD label, so it draws above the skin layers (see the header)
	const tip = new Instance("Frame");
	tip.Name = "Tooltip";
	tip.AnchorPoint = new Vector2(0.5, 1);
	tip.Position = new UDim2(0.5, 0, 0, -math.round(6 * k));
	tip.AutomaticSize = Enum.AutomaticSize.XY;
	tip.Size = UDim2.fromOffset(0, 0);
	tip.BackgroundColor3 = THEME.popover;
	tip.BorderSizePixel = 0;
	tip.Active = false;
	tip.Visible = false;
	tip.ZIndex = target.ZIndex + 20;
	setSurface(tip, "well", { fill: SURFACE.well, border: THEME.border });
	const label = new Instance("TextLabel");
	label.Name = "Text";
	// padding and wrap width live on the label: the well grows with it (its skin layers are sized in scale,
	// so they never feed back into the AutomaticSize of the box)
	label.AutomaticSize = Enum.AutomaticSize.XY;
	label.Size = UDim2.fromOffset(0, 0);
	label.BackgroundColor3 = THEME.popover;
	label.BackgroundTransparency = 1;
	label.BorderSizePixel = 0;
	label.TextColor3 = THEME.popoverForeground;
	label.TextStrokeColor3 = THEME.background;
	label.FontFace = fontOf("sans", Enum.FontWeight.Medium);
	label.TextSize = math.max(10, math.round(TEXT.sm * k));
	label.Text = text;
	// long texts wrap inside `width` (design units, scaled like the rest of the UI) instead of running off screen
	label.TextWrapped = true;
	label.TextXAlignment = Enum.TextXAlignment.Left;
	label.ZIndex = tip.ZIndex + 1;
	const padX = math.round(space(2) * k);
	const padY = math.round(space(1.5) * k);
	const pad = new Instance("UIPadding");
	pad.PaddingLeft = new UDim(0, padX);
	pad.PaddingRight = new UDim(0, padX);
	pad.PaddingTop = new UDim(0, padY);
	pad.PaddingBottom = new UDim(0, padY);
	pad.Parent = label;
	const size = new Instance("UISizeConstraint");
	size.MaxSize = new Vector2(math.round(width * k), math.huge);
	size.Parent = label;
	label.Parent = tip;
	tip.Parent = target;
	sensor.MouseEnter.Connect(() => {
		tip.Visible = true;
	});
	sensor.MouseLeave.Connect(() => {
		tip.Visible = false;
	});
}
