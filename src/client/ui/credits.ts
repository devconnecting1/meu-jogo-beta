import { GameContext } from "shared/game/context";
import { TEXT, THEME } from "./theme";
import { Button, autoFocus, makeFrame, makeLabel, makeScreen } from "./widgets";

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
	const { root, body } = makeScreen(ctx.uiLayer, "Credits");

	const back = Button(body, "Back", "‹  Back", {
		x: 40,
		y: 28,
		w: 124,
		h: 50,
		variant: "secondary",
		onClick: onBack,
	});
	makeLabel(body, "Title", "Credits", 184, 24, 400, 58, TEXT.xl4, THEME.foreground, { font: "title", align: "left" });

	const scroller = makeFrame(body, "Scroller", 260, 104, 600, 500, THEME.background, {
		transparency: 1,
		clips: true,
	});
	const text = makeLabel(
		scroller,
		"CreditText",
		CREDIT_LINES.join("\n"),
		0,
		500,
		600,
		560,
		TEXT.xl,
		THEME.foreground,
		{
			font: "label",
			align: "center",
			valign: "top",
		},
	);

	let scrollY = 500;
	const RunService = game.GetService("RunService");
	const conn = RunService.RenderStepped.Connect((dt: number): void => {
		scrollY -= 40 * dt;
		if (scrollY < -580) scrollY = 500;
		text.Position = UDim2.fromScale(0, scrollY / 500);
	});
	autoFocus(back);

	return (): void => {
		conn.Disconnect();
		root.Destroy();
	};
}
