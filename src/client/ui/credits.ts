import { GameContext } from "shared/game/context";
import { FONTS, PALETTE, makeButton, makeFrame, makeLabel, makeScreen } from "./widgets";

const CREDIT_LINES = [
	"PROJECT Z",
	"Top-down zombie survival for Roblox",
	"",
	"Inspired by Dead Town",
	"by Lemon Puppy Games",
	"",
	"Special thanks (original Dead Town credits)",
	"Yoyo games",
	"Crazy GM",
	"Play GM",
	"opengameart.org",
	"dlf0325",
	"sodium031",
	"zizonpink",
	"",
	"Built with roblox-ts",
	"",
	"Thank you for playing!",
];

export function showCredits(ctx: GameContext, onBack: () => void): () => void {
	const { root, body } = makeScreen(ctx.uiLayer, "Credits", { gradient: true });

	makeLabel(body, "Title", "Credits", 184, 24, 400, 58, 36, PALETTE.text, { font: FONTS.display, align: "left" });
	makeButton(body, "Back", "‹  Back", 40, 28, 124, 50, "secondary", (): void => onBack());

	const scroller = makeFrame(body, "Scroller", 260, 104, 600, 500, PALETTE.bg, { transparency: 1, clips: true });
	const text = makeLabel(scroller, "CreditText", CREDIT_LINES.join("\n"), 0, 500, 600, 560, 20, PALETTE.text, {
		font: FONTS.medium,
		align: "center",
		valign: "top",
	});

	let scrollY = 500;
	const RunService = game.GetService("RunService");
	const conn = RunService.RenderStepped.Connect((dt: number): void => {
		scrollY -= 40 * dt;
		if (scrollY < -580) scrollY = 500;
		text.Position = UDim2.fromScale(0, scrollY / 500);
	});

	return (): void => {
		conn.Disconnect();
		root.Destroy();
	};
}
