import { GameContext } from "shared/game/context";
import { SURFACE, TEXT, THEME, space } from "./theme";
import {
	BUTTON_SIZE,
	Button,
	CARD_STRIP_INSET,
	Dialog,
	autoFocus,
	cardStripHeight,
	makeLabel,
	makeSurface,
	setButtonEnabled,
	setSurface,
} from "./widgets";

interface TutorialStep {
	title: string;
	body: string;
}

const STEPS: Array<TutorialStep> = [
	{ title: "Move", body: "Use W A S D to move.\nOn mobile use the left joystick." },
	{ title: "Aim", body: "Move the mouse to aim.\nOn mobile drag the right side of the screen." },
	{ title: "Attack", body: "Left click to attack.\nOn mobile press the FIRE button." },
	{ title: "Reload & weapons", body: "Press R to reload.\nPress 1-5 to switch between the weapons you own." },
	{
		title: "Interact",
		body: "Press E (or right-click) near doors, items, fires and craft desks.\nOn mobile tap the action button when it appears.",
	},
	{
		title: "Backpack",
		body: "Press B to open your backpack.\nEquip weapons, use items and check skills. The game pauses while it's open.",
	},
	{
		title: "Craft",
		body: "Open the Craft tab in the backpack.\nStand near a craft desk for advanced items, or a lit fire to smelt metal.",
	},
	{
		title: "Pause",
		body: "Press P to pause.\nFrom the pause menu you can save, visit the shop or return to the lobby. The match stays suspended until you press Play again.",
	},
];

const PANEL_W = 620;
const DOT_W = 20;
const DOT_H = 10;
const DOT_GAP = space(2);

// the footer (Skip / Back / Next) must sit right below the actual body text, not in a box sized for the
// longest step: it used to leave a large empty gap for every shorter step (fixed PANEL_H, fixed footer y).
/** the step title rides on the panel's title strip, with the dots and the counter under it */
const STRIP_H = cardStripHeight();
const DOTS_Y = CARD_STRIP_INSET + STRIP_H + space(3);
const COUNTER_Y = DOTS_Y + DOT_H + space(2);
/** y where the body text starts (title strip + dots row + counter) */
const BODY_Y = COUNTER_Y + 18 + space(4);
/** wrapped-line height estimate at TEXT.base, same ratio the popup dialog (popup.ts) uses for its body */
const BODY_LINE_H = TEXT.base * 1.45;
/** ~chars per wrapped line at PANEL_W's inner width (pad(6) each side), scaled from popup.ts's own estimate */
const BODY_CHARS_PER_LINE = 65;
/** theme-scale gap between the body text and the footer row (matches the card's own padding step) */
const FOOTER_GAP = space(6);
const FOOTER_H = BUTTON_SIZE.default.h;

/** estimated rendered height (design px) of a step's body text, wrapped at the panel's inner width */
function stepBodyHeight(body: string): number {
	let lines = 0;
	for (const line of body.split("\n")) {
		lines += math.max(1, math.ceil(line.size() / BODY_CHARS_PER_LINE));
	}
	return math.ceil(math.max(1, lines) * BODY_LINE_H);
}

function maxStepBodyHeight(): number {
	let max = 0;
	for (const step of STEPS) max = math.max(max, stepBodyHeight(step.body));
	return max;
}

/** longest step's body height, plus one line of buffer to absorb the wrap estimate's imprecision */
const MAX_BODY_H = maxStepBodyHeight() + math.ceil(BODY_LINE_H);

// panel height: content down to the longest step's body, plus the footer row and its gaps (no dead space
// sized for text no step actually has).
const PANEL_H = BODY_Y + MAX_BODY_H + FOOTER_GAP + FOOTER_H + space(6);

/** tutorial: a popover dialog with a step indicator (current step = primary, others = secondary) */
export function showTutorial(ctx: GameContext, onDone: () => void): () => void {
	const dialog = Dialog(ctx.uiLayer, "Tutorial", { w: PANEL_W, h: PANEL_H, zIndex: 260 });
	const panel = dialog.card;
	const pad = space(6);
	const innerW = PANEL_W - pad * 2;

	// title strip of the reference art: the step title sits on it, centred
	const stripW = PANEL_W - CARD_STRIP_INSET * 2;
	const strip = makeSurface(panel, "TitleStrip", CARD_STRIP_INSET, CARD_STRIP_INSET, stripW, STRIP_H, "strip", {
		zIndex: panel.ZIndex + 1,
	});
	const titleLabel = makeLabel(strip, "StepTitle", "", 0, 0, stripW, STRIP_H, TEXT.xl2, THEME.foreground, {
		font: "title",
		zIndex: strip.ZIndex + 1,
	});
	const dotsWidth = STEPS.size() * DOT_W + (STEPS.size() - 1) * DOT_GAP;
	const dotsStartX = (PANEL_W - dotsWidth) / 2;
	const dots: Array<Frame> = [];
	for (let i = 0; i < STEPS.size(); i++) {
		// step pips: the current one is a raised plate, the others stay sunk
		dots.push(
			makeSurface(panel, `Dot${i}`, dotsStartX + i * (DOT_W + DOT_GAP), DOTS_Y, DOT_W, DOT_H, "well", {
				fill: THEME.secondary,
				border: SURFACE.line,
			}),
		);
	}
	const counter = makeLabel(panel, "StepCount", "", pad, COUNTER_Y, innerW, 18, TEXT.xs, THEME.mutedForeground, {
		font: "numeric",
	});
	const bodyLabel = makeLabel(
		panel,
		"StepBody",
		"",
		pad,
		BODY_Y,
		innerW,
		MAX_BODY_H,
		TEXT.base,
		THEME.mutedForeground,
		{
			align: "left",
			valign: "top",
		},
	);

	let index = 0;
	const cleanup = (): void => {
		dialog.root.Destroy();
	};
	const finish = (): void => {
		ctx.save.tutorialDone = true;
		cleanup();
		onDone();
	};

	const skipX = pad;
	const backX = PANEL_W - pad - 130 - space(2) - 130;
	const nextX = PANEL_W - pad - 130;

	let skipBtn: TextButton | undefined;
	let backBtn: TextButton | undefined;
	let nextBtn: TextButton | undefined;

	const show = (): void => {
		const step = STEPS[index];
		titleLabel.Text = step.title;
		bodyLabel.Text = step.body;
		counter.Text = `${index + 1} / ${STEPS.size()}`;
		for (let i = 0; i < dots.size(); i++) {
			if (i === index) setSurface(dots[i], "raised", { fill: THEME.primary });
			else setSurface(dots[i], "well", { fill: THEME.secondary, border: SURFACE.line });
		}
		// the footer follows this step's actual body height instead of a fixed y, so short steps never leave
		// a gap between the text and the buttons
		const footerY = BODY_Y + stepBodyHeight(step.body) + FOOTER_GAP;
		if (skipBtn !== undefined) skipBtn.Position = UDim2.fromScale(skipX / PANEL_W, footerY / PANEL_H);
		if (backBtn !== undefined) backBtn.Position = UDim2.fromScale(backX / PANEL_W, footerY / PANEL_H);
		if (nextBtn !== undefined) nextBtn.Position = UDim2.fromScale(nextX / PANEL_W, footerY / PANEL_H);
		if (backBtn !== undefined) setButtonEnabled(backBtn, index > 0);
		if (nextBtn !== undefined) nextBtn.Text = index >= STEPS.size() - 1 ? "Done" : "Next";
	};

	skipBtn = Button(panel, "Skip", "Skip", {
		x: skipX,
		y: 0,
		w: 110,
		variant: "ghost",
		onClick: (): void => finish(),
	});
	backBtn = Button(panel, "Back", "Back", {
		x: backX,
		y: 0,
		w: 130,
		variant: "secondary",
		onClick: (): void => {
			if (index <= 0) return;
			index--;
			show();
		},
	});
	nextBtn = Button(panel, "Next", "Next", {
		x: nextX,
		y: 0,
		w: 130,
		variant: "default",
		onClick: (): void => {
			if (index >= STEPS.size() - 1) {
				finish();
				return;
			}
			index++;
			show();
		},
	});
	show();
	autoFocus(nextBtn);

	return cleanup;
}
