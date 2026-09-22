import { GameContext } from "shared/game/context";
import { RADIUS, TEXT, THEME, space } from "./theme";
import { Button, Dialog, autoFocus, makeFrame, makeLabel, setButtonEnabled } from "./widgets";

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
const PANEL_H = 390;
const DOT_W = 20;
const DOT_H = 6;
const DOT_GAP = space(2);

/** tutorial: a popover dialog with a step indicator (current step = primary, others = secondary) */
export function showTutorial(ctx: GameContext, onDone: () => void): () => void {
	const dialog = Dialog(ctx.uiLayer, "Tutorial", { w: PANEL_W, h: PANEL_H, zIndex: 260 });
	const panel = dialog.card;
	const pad = space(6);
	const innerW = PANEL_W - pad * 2;

	const dotsWidth = STEPS.size() * DOT_W + (STEPS.size() - 1) * DOT_GAP;
	const dotsStartX = (PANEL_W - dotsWidth) / 2;
	const dots: Array<Frame> = [];
	for (let i = 0; i < STEPS.size(); i++) {
		dots.push(
			makeFrame(panel, `Dot${i}`, dotsStartX + i * (DOT_W + DOT_GAP), pad, DOT_W, DOT_H, THEME.secondary, {
				radius: RADIUS.full,
			}),
		);
	}
	const counter = makeLabel(panel, "StepCount", "", pad, pad + 20, innerW, 18, TEXT.xs, THEME.mutedForeground, {
		font: "numeric",
	});
	const titleLabel = makeLabel(panel, "StepTitle", "", pad, pad + 48, innerW, 40, TEXT.xl2, THEME.popoverForeground, {
		font: "heading",
		align: "left",
	});
	const bodyLabel = makeLabel(panel, "StepBody", "", pad, pad + 100, innerW, 160, TEXT.base, THEME.mutedForeground, {
		align: "left",
		valign: "top",
	});

	let index = 0;
	const cleanup = (): void => {
		dialog.root.Destroy();
	};
	const finish = (): void => {
		ctx.save.tutorialDone = true;
		cleanup();
		onDone();
	};

	let backBtn: TextButton | undefined;
	let nextBtn: TextButton | undefined;

	const show = (): void => {
		const step = STEPS[index];
		titleLabel.Text = step.title;
		bodyLabel.Text = step.body;
		counter.Text = `${index + 1} / ${STEPS.size()}`;
		for (let i = 0; i < dots.size(); i++) {
			dots[i].BackgroundColor3 = i === index ? THEME.primary : THEME.secondary;
		}
		if (backBtn !== undefined) setButtonEnabled(backBtn, index > 0);
		if (nextBtn !== undefined) nextBtn.Text = index >= STEPS.size() - 1 ? "Done" : "Next";
	};

	const footerY = PANEL_H - pad - 44;
	Button(panel, "Skip", "Skip", { x: pad, y: footerY, w: 110, variant: "ghost", onClick: (): void => finish() });
	backBtn = Button(panel, "Back", "Back", {
		x: PANEL_W - pad - 130 - space(2) - 130,
		y: footerY,
		w: 130,
		variant: "secondary",
		onClick: (): void => {
			if (index <= 0) return;
			index--;
			show();
		},
	});
	nextBtn = Button(panel, "Next", "Next", {
		x: PANEL_W - pad - 130,
		y: footerY,
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
