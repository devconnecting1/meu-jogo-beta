import { GameContext } from "shared/game/context";
import { COLORS } from "shared/engine/colors";
import { makeFrame, makeLabel, makeButton } from "./widgets";

interface TutorialStep {
	title: string;
	body: string;
}

const STEPS: Array<TutorialStep> = [
	{ title: "Move", body: "Use W A S D to move.\nOn mobile use the left joystick." },
	{ title: "Aim", body: "Move the mouse to aim.\nOn mobile drag the right side of the screen." },
	{ title: "Attack", body: "Left click to attack.\nOn mobile press the fire button." },
	{
		title: "Interact",
		body: "Press E near doors, items and craft desks.\nAn action button appears when you can interact.",
	},
	{
		title: "Backpack",
		body: "Press Tab to open your backpack.\nThere you can equip weapons, use items and check skills.",
	},
	{ title: "Craft", body: "Open the Craft tab in the backpack.\nStand near a craft desk to make advanced items." },
];

export function showTutorial(ctx: GameContext, onDone: () => void): () => void {
	const root = makeFrame(ctx.uiLayer, "Tutorial", 0, 0, 1120, 630, Color3.fromRGB(0, 0, 0), {
		transparency: 0.35,
		zIndex: 260,
	});
	const panel = makeFrame(root, "Panel", 260, 130, 600, 370, COLORS.uiPanel, { zIndex: 261 });
	const stepLabel = makeLabel(panel, "Step", "1 / 6", 20, 16, 120, 30, 16, COLORS.uiTextDim);
	stepLabel.TextXAlignment = Enum.TextXAlignment.Left;
	const titleLabel = makeLabel(panel, "StepTitle", "", 20, 56, 560, 44, 26, COLORS.uiAccent);
	const bodyLabel = makeLabel(panel, "StepBody", "", 40, 120, 520, 160, 18, COLORS.uiText);
	bodyLabel.TextYAlignment = Enum.TextYAlignment.Top;

	let index = 0;
	const show = (): void => {
		const step = STEPS[index];
		stepLabel.Text = `${index + 1} / ${STEPS.size()}`;
		titleLabel.Text = step.title;
		bodyLabel.Text = step.body;
	};
	let nextBtn: TextButton | undefined;
	const onClick = (): void => {
		if (index >= STEPS.size() - 1) {
			ctx.save.tutorialDone = true;
			cleanup();
			onDone();
			return;
		}
		index++;
		show();
		if (nextBtn !== undefined) nextBtn.Text = index >= STEPS.size() - 1 ? "Done" : "Next";
	};

	nextBtn = makeButton(panel, "Next", "Next", 380, 300, 180, 50, COLORS.uiPanelLight, (): void => onClick());
	show();

	const cleanup = (): void => {
		root.Destroy();
	};

	return cleanup;
}
