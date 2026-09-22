import { GameContext } from "shared/game/context";
import { COLORS } from "shared/engine/colors";
import { makeButton, makeFrame, makeLabel } from "./widgets";

const CREDIT_LINES = [
	"DEAD TOWN",
	"Zombie Survival - 2D port",
	"",
	"Original game",
	"Dead Town: Zombie Survival",
	"",
	"Thanks to",
	"Yoyo games",
	"Crazy GM",
	"Play GM",
	"opengameart.org",
	"dlf0325",
	"sodium031",
	"zizonpink",
	"",
	"Assets and music from community contributors",
	"",
	"Port built with roblox-ts",
	"",
	"Thank you for playing!",
];

export function showCredits(ctx: GameContext, onBack: () => void): () => void {
	const root = makeFrame(ctx.uiLayer, "Credits", 0, 0, 1120, 630, COLORS.bg);
	makeFrame(root, "TopBar", 0, 0, 1120, 64, Color3.fromRGB(65, 65, 65));
	const scroller = makeFrame(root, "Scroller", 0, 0, 1120, 630, COLORS.bg, { transparency: 1, clips: true });
	const text = makeLabel(scroller, "CreditText", CREDIT_LINES.join("\n"), 260, 630, 600, 560, 20, COLORS.uiText);
	text.TextYAlignment = Enum.TextYAlignment.Top;
	makeButton(root, "Back", "Back", 970, 14, 120, 44, COLORS.uiPanelLight, (): void => onBack());

	let scrollY = 630;
	const RunService = game.GetService("RunService");
	const conn = RunService.RenderStepped.Connect((dt: number): void => {
		scrollY -= 40 * dt;
		if (scrollY < -580) scrollY = 630;
		text.Position = new UDim2(0, 0, 0, scrollY);
	});

	return (): void => {
		conn.Disconnect();
		root.Destroy();
	};
}
