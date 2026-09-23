import { GameContext } from "shared/game/context";
import { langGet } from "shared/data/lang";
import { registerBack } from "./backStack";
import { TEXT, THEME } from "./theme";
import { Button, autoFocus, makeFrame, makeLabel, makeScreen } from "./widgets";

/**
 * The credits, a line each. `true`: words a translator translates, so they go through lang.ts (UI-03) and are in its
 * table; `false`: a name -- the game's, a studio's, a site's, a person's handle -- which reads the same in every
 * language. An empty line is a gap.
 */
const CREDIT_LINES: Array<[string, boolean]> = [
	["PROJECT Z", false],
	["Top-down zombie survival for Roblox", true],
	["", false],
	["Inspired by Dead Town", true],
	["by Lemon Puppy Games", true],
	["", false],
	["Special thanks (original Dead Town credits)", true],
	["Yoyo games", false],
	["Crazy GM", false],
	["Play GM", false],
	["opengameart.org", false],
	["dlf0325", false],
	["sodium031", false],
	["zizonpink", false],
	["", false],
	["Built with roblox-ts", true],
	["", false],
	["Thank you for playing!", true],
];

export function showCredits(ctx: GameContext, onBack: () => void): () => void {
	const tr = (key: string): string => langGet(key, ctx.save.settings.langType);
	// a menu page over the town flyover (UI-10): every line is `foreground`, which the flyover's scrim holds at 4,5:1
	const { root, body } = makeScreen(ctx.uiLayer, "Credits", { transparency: 1 });

	const back = Button(body, "Back", `‹  ${tr("Back")}`, {
		x: 40,
		y: 28,
		w: 124,
		h: 50,
		variant: "secondary",
		onClick: onBack,
	});
	makeLabel(body, "Title", tr("Credits"), 184, 24, 400, 58, TEXT.xl4, THEME.foreground, {
		font: "title",
		align: "left",
	});

	const scroller = makeFrame(body, "Scroller", 260, 104, 600, 500, THEME.background, {
		transparency: 1,
		clips: true,
	});
	const text = makeLabel(
		scroller,
		"CreditText",
		CREDIT_LINES.map(([line, words]) => (words ? tr(line) : line)).join("\n"),
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
	// B / Backspace goes Back (backStack.ts)
	registerBack(back, onBack);
	autoFocus(back);

	return (): void => {
		conn.Disconnect();
		root.Destroy();
	};
}
