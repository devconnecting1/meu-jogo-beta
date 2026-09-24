import { GameContext } from "shared/game/context";
import { langGet } from "shared/data/lang";
import { DEVELOPER, INSPIRED_BY } from "shared/module";
import { registerBack } from "./backStack";
import { TEXT, THEME } from "./theme";
import { Button, autoFocus, makeFrame, makeLabel, makeScreen } from "./widgets";

/**
 * The credits, a line each. `true`: words a translator translates, so they go through lang.ts (UI-03) and are in its
 * table; `false`: a name -- the game's, its developer's, the original's -- which reads the same in every language.
 * An empty line is a gap.
 *
 * Who made it and what inspired it, nothing else (the owner's decision, 2026-09-23): no studio, company or tool.
 */
const CREDIT_LINES: Array<[string, boolean]> = [
	["LAST TOWN", false],
	["", false],
	["Developed by", true],
	[DEVELOPER, false],
	["", false],
	["Inspired by the original", true],
	[INSPIRED_BY, false],
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
