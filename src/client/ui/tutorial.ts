import { GameContext } from "shared/game/context";
import { FONTS, PALETTE, makeButton, makeFrame, makeLabel, makePanel, makeScreen, setButtonEnabled } from "./widgets";

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
const DOT_SIZE = 14;
const DOT_GAP = 10;

export function showTutorial(ctx: GameContext, onDone: () => void): () => void {
	const { root, body } = makeScreen(ctx.uiLayer, "Tutorial", {
		color: PALETTE.overlay,
		transparency: 0.35,
		zIndex: 260,
	});
	const panel = makePanel(body, "Panel", 250, 120, PANEL_W, PANEL_H, { zIndex: 261 });

	const dotsWidth = STEPS.size() * DOT_SIZE + (STEPS.size() - 1) * DOT_GAP;
	const dotsStartX = (PANEL_W - dotsWidth) / 2;
	const dots: Array<Frame> = [];
	for (let i = 0; i < STEPS.size(); i++) {
		const dot = makeFrame(
			panel,
			`Dot${i}`,
			dotsStartX + i * (DOT_SIZE + DOT_GAP),
			24,
			DOT_SIZE,
			DOT_SIZE,
			PALETTE.strokeSoft,
			{ radius: DOT_SIZE, zIndex: 262 },
		);
		dots.push(dot);
	}

	const titleLabel = makeLabel(panel, "StepTitle", "", 40, 56, 540, 48, 26, PALETTE.accent, {
		font: FONTS.display,
		align: "left",
		zIndex: 262,
	});
	const bodyLabel = makeLabel(panel, "StepBody", "", 40, 114, 540, 180, 18, PALETTE.text, {
		font: FONTS.medium,
		align: "left",
		valign: "top",
		zIndex: 262,
	});

	let index = 0;
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
		for (let i = 0; i < dots.size(); i++) {
			dots[i].BackgroundColor3 = i === index ? PALETTE.accent : PALETTE.strokeSoft;
		}
		if (backBtn !== undefined) setButtonEnabled(backBtn, index > 0);
		if (nextBtn !== undefined) nextBtn.Text = index >= STEPS.size() - 1 ? "Done" : "Next";
	};

	makeButton(panel, "Skip", "Skip", 40, 326, 120, 48, "ghost", (): void => finish(), { zIndex: 262 });
	backBtn = makeButton(
		panel,
		"Back",
		"Back",
		250,
		326,
		140,
		48,
		"secondary",
		(): void => {
			if (index <= 0) return;
			index--;
			show();
		},
		{ zIndex: 262 },
	);
	nextBtn = makeButton(
		panel,
		"Next",
		"Next",
		460,
		326,
		120,
		48,
		"primary",
		(): void => {
			if (index >= STEPS.size() - 1) {
				finish();
				return;
			}
			index++;
			show();
		},
		{ zIndex: 262 },
	);
	show();

	const cleanup = (): void => {
		root.Destroy();
	};

	return cleanup;
}
