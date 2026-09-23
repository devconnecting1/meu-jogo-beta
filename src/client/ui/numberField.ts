/*
 * The kit's FORM pieces (docs/DESIGN_RULES.md UI-12): a number field that says what is wrong where it is, the form
 * row that holds it, and the confirmation a destructive action asks for. Supabase's form pattern
 * (design-system/docs/ui-patterns/forms) in the window vocabulary of UI-07:
 *
 *   - a FORM ROW: the kit's own (window.ts SettingRow with a description, the one Settings uses): the label (Bold)
 *     over a one-line description in the label cell, the control at SETTING_CONTROL_X of the value cell;
 *   - errors INLINE, on the field that has them: the well's edge turns red and the row says what is wrong and what
 *     would be right ("At most 200") -- in a form row, on its description line (light, where the description was
 *     grey: red text does not read on the grey cells, 2,6:1), elsewhere on a line of its own under the field (red on
 *     the dark panel). Nothing is sent while a field is wrong -- `validate()` answers undefined and the caller does
 *     not send. A toast is only for something that happened (an edit applied) or that blocks nothing;
 *   - a DESTRUCTIVE action (reset, kick, clear, kill all) asks first, in the kit's dialog, naming what it will do,
 *     with the red plate on the button that does it.
 *
 * The field is the admin panel's Input (client/admin/controls.ts, a dark well with the text in it) with a range and a
 * voice: the SERVER stays the authority (shared/admin/ops.ts clamps and refuses whatever arrives), and this only keeps
 * a wrong number from being sent at all.
 */
import { SURFACE, TEXT, THEME, roleFont, space } from "./theme";
import {
	Button,
	Dialog,
	DialogHandle,
	ScrollList,
	designOf,
	fmtInt,
	makeLabel,
	makeSurface,
	scaleText,
	setLabelColor,
	setSurface,
	setVisible,
} from "./widgets";
import { registerBack } from "./backStack";
import { SETTING_CONTROL_X, SettingRow, SettingRowHandle } from "./window";

// ---------------------------------------------------------------- validation (pure)

export interface NumberCheck {
	/** the whole number typed, when it is one and inside the range */
	value?: number;
	/** what is wrong, in words (undefined when nothing is) */
	error?: string;
}

/**
 * Reads `text` as a whole number inside [min, max]. Pure, so the rule the field shows is the rule the tests check:
 * empty -> "Enter a number"; not a whole number -> "Whole numbers only"; below / above the range -> "At least N" /
 * "At most N" (the server's own limits, shared/admin/ops.ts statRange / itemMax).
 */
export function checkNumber(text: string, min: number, max: number): NumberCheck {
	const [trimmed] = text.gsub("^%s+", "");
	const [t] = trimmed.gsub("%s+$", "");
	if (t === "") return { error: "Enter a number" };
	if (t.match("^%-?%d+$")[0] === undefined) return { error: "Whole numbers only" };
	const n = tonumber(t);
	if (n === undefined || n !== n) return { error: "Whole numbers only" };
	if (n < min) return { error: `At least ${fmtInt(min)}` };
	if (n > max) return { error: `At most ${fmtInt(max)}` };
	return { value: n };
}

// ---------------------------------------------------------------- NumberField

export interface NumberFieldProps {
	x: number;
	y: number;
	w: number;
	/** the well's height (default 32) */
	h?: number;
	/** the value shown at first */
	value?: number;
	min: number;
	max: number;
	/** the error line under the field (default true); without it the red edge is the only sign (`error()` has the text) */
	errorLine?: boolean;
	/** error line height, design units (default 16) */
	errorH?: number;
	placeholder?: string;
	/** Enter with a VALID value */
	onSubmit?: (value: number) => void;
	/** the text changed (valid or not) */
	onChange?: () => void;
	/** the error shown changed (`undefined`: none now): for a caller that says it somewhere else (a form row) */
	onError?: (message: string | undefined) => void;
	zIndex?: number;
}

export interface NumberFieldHandle {
	/** the well */
	frame: Frame;
	box: TextBox;
	/** the error line (undefined without `errorLine`) */
	errorLabel?: TextLabel;
	/** the value if the text is valid (and clears the error), else undefined and SHOWS the error */
	validate(): number | undefined;
	/** the value if valid, without showing anything */
	peek(): number | undefined;
	set(value: number): void;
	text(): string;
	/** the error shown now, if any */
	error(): string | undefined;
	clearError(): void;
}

/** digits and one leading minus: what a number field keeps of what is typed */
function numericOnly(text: string): string {
	const neg = text.sub(1, 1) === "-";
	const [digits] = text.gsub("%D", "");
	return neg ? `-${digits}` : digits;
}

/**
 * A whole-number field with a range: a dark well (`SURFACE.well`, the admin Input's) whose edge is `input` at rest,
 * `ring` while typing and `destructive` while wrong, and one red line under it that says what is wrong. The error
 * appears when the caller asks (`validate`, on Apply) or when the field loses focus with a wrong value, and leaves as
 * soon as the text is right again -- never while the first digit is being typed.
 */
export function NumberField(parent: Instance, name: string, props: NumberFieldProps): NumberFieldHandle {
	const h = props.h ?? 32;
	const z = props.zIndex ?? 2;
	const frame = makeSurface(parent, name, props.x, props.y, props.w, h, "well", {
		fill: SURFACE.well,
		border: THEME.input,
		zIndex: z,
	});
	const box = new Instance("TextBox");
	box.Name = "Box";
	box.Size = UDim2.fromScale(1, 1);
	box.BackgroundTransparency = 1;
	box.BackgroundColor3 = THEME.background;
	box.BorderSizePixel = 0;
	box.ClearTextOnFocus = false;
	box.Text = props.value !== undefined ? tostring(props.value) : "";
	box.PlaceholderText = props.placeholder ?? "";
	box.PlaceholderColor3 = THEME.mutedForeground;
	box.TextColor3 = THEME.foreground;
	// numbers in the kit's numeric role, right-aligned like a table's
	box.FontFace = roleFont("numeric");
	box.TextXAlignment = Enum.TextXAlignment.Right;
	box.ZIndex = frame.ZIndex + 1;
	scaleText(box, TEXT.sm);
	const pad = new Instance("UIPadding");
	pad.PaddingLeft = new UDim(space(2) / props.w, 0);
	pad.PaddingRight = new UDim(space(2) / props.w, 0);
	pad.PaddingTop = new UDim(0.16, 0);
	pad.PaddingBottom = new UDim(0.16, 0);
	pad.Parent = box;
	box.Parent = frame;

	let errorLabel: TextLabel | undefined;
	if (props.errorLine !== false) {
		const eh = props.errorH ?? 16;
		errorLabel = makeLabel(
			parent,
			`${name}Error`,
			"",
			props.x,
			props.y + h + 2,
			props.w,
			eh,
			TEXT.xs,
			THEME.destructive,
			{
				font: "label",
				align: "left",
				zIndex: z,
			},
		);
		errorLabel.TextWrapped = false;
		setVisible(errorLabel, false);
	}

	let shown: string | undefined;
	let focused = false;
	const paint = (): void => {
		const border = shown !== undefined ? THEME.destructive : focused ? THEME.ring : THEME.input;
		setSurface(frame, "well", { fill: SURFACE.well, border });
	};
	const show = (message: string | undefined): void => {
		const changed = message !== shown;
		shown = message;
		if (changed) props.onError?.(message);
		if (errorLabel !== undefined) {
			if (errorLabel.Text !== (message ?? "")) errorLabel.Text = message ?? "";
			setVisible(errorLabel, message !== undefined);
		}
		paint();
	};

	box.GetPropertyChangedSignal("Text").Connect(() => {
		const clean = numericOnly(box.Text);
		if (clean !== box.Text) {
			box.Text = clean;
			return;
		}
		// an error goes away the moment the text is right; a new one waits for Apply or for the focus to leave
		if (shown !== undefined && checkNumber(box.Text, props.min, props.max).error === undefined) show(undefined);
		props.onChange?.();
	});
	box.Focused.Connect(() => {
		focused = true;
		paint();
	});
	box.FocusLost.Connect(enter => {
		focused = false;
		const r = checkNumber(box.Text, props.min, props.max);
		show(r.error);
		if (enter && r.value !== undefined) props.onSubmit?.(r.value);
	});

	return {
		frame,
		box,
		errorLabel,
		validate(): number | undefined {
			const r = checkNumber(box.Text, props.min, props.max);
			show(r.error);
			return r.value;
		},
		peek(): number | undefined {
			return checkNumber(box.Text, props.min, props.max).value;
		},
		set(value: number): void {
			box.Text = tostring(value);
			show(undefined);
		},
		text(): string {
			return box.Text;
		},
		error(): string | undefined {
			return shown;
		},
		clearError(): void {
			show(undefined);
		},
	};
}

// ---------------------------------------------------------------- NumberRow

export interface NumberRowProps {
	value?: number;
	min: number;
	max: number;
	/** the label cell's width (default 260: a label and a description such as "now 1,234 · 0–99,999") */
	labelW?: number;
	/** the field's width in the value cell (default 150) */
	fieldW?: number;
	onSubmit?: (value: number) => void;
	onChange?: () => void;
}

export interface NumberRowHandle {
	row: SettingRowHandle;
	field: NumberFieldHandle;
}

/** the field's height in a form row: the kit's controls (Switch, the action button) are 30 tall there */
const ROW_FIELD_H = 30;

/**
 * A FORM ROW whose control is a NumberField: the kit's description row (window.ts SettingRow, the one Settings
 * uses) -- label and description in the label cell, the field at SETTING_CONTROL_X of the value cell, vertically
 * centred, as SettingAction places its button. A wrong number turns the field's edge red and puts what is wrong
 * on the row's description line, in the light voice (THEME.foreground on the label cell); the description comes
 * back the moment the number is right.
 */
export function NumberRow(
	list: ScrollList,
	name: string,
	order: number,
	label: string,
	description: string,
	props: NumberRowProps,
): NumberRowHandle {
	const row = SettingRow(list, name, order, label, { labelW: props.labelW ?? 260, description });
	const [, h] = designOf(row.value);
	const line = row.description;
	const field = NumberField(row.value, "Field", {
		x: SETTING_CONTROL_X,
		y: (h - ROW_FIELD_H) / 2,
		w: props.fieldW ?? 150,
		h: ROW_FIELD_H,
		value: props.value,
		min: props.min,
		max: props.max,
		errorLine: false,
		zIndex: row.value.ZIndex + 1,
		onSubmit: props.onSubmit,
		onChange: props.onChange,
		onError: (message: string | undefined): void => {
			if (line === undefined) return;
			const text = message ?? description;
			if (line.Text !== text) line.Text = text;
			setLabelColor(line, message !== undefined ? THEME.foreground : SURFACE.cellCaption);
		},
	});
	return { row, field };
}

// ---------------------------------------------------------------- confirmation

export interface ConfirmProps {
	title: string;
	/** what exactly will happen, and to whom */
	body: string;
	/** the red button's text ("Reset save") */
	action: string;
	onConfirm: () => void;
	zIndex?: number;
}

/**
 * The confirmation every destructive action asks for: the kit's Dialog, the consequence in words, Cancel (iron) and
 * the action on the RED plate. Nothing happens until the red button is pressed; closing the dialog any other way is
 * Cancel. Returns the dialog (tests press its buttons).
 */
export function confirmAction(layer: Instance, props: ConfirmProps): DialogHandle {
	const w = 480;
	const h = 236;
	const dlg = Dialog(layer, "ConfirmDialog", { w, h, title: props.title, zIndex: props.zIndex ?? 200 });
	const pad = space(6);
	makeLabel(dlg.card, "Body", props.body, pad, dlg.contentY, w - pad * 2, 64, TEXT.sm, THEME.mutedForeground, {
		align: "left",
		valign: "top",
	});
	const fy = h - pad - 40;
	const cancel = Button(dlg.card, "Cancel", "Cancel", {
		x: w - pad - 300 - space(2),
		y: fy,
		w: 140,
		h: 40,
		variant: "secondary",
		onClick: () => dlg.close(),
	});
	// B / Backspace is Cancel, as every other way of closing it (backStack.ts)
	registerBack(cancel, () => dlg.close());
	Button(dlg.card, "Confirm", props.action, {
		x: w - pad - 160,
		y: fy,
		w: 160,
		h: 40,
		variant: "destructive",
		onClick: () => {
			dlg.close();
			props.onConfirm();
		},
	});
	return dlg;
}
