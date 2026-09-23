import { getCtx } from "../bootstrap";
import { GAME, TEXT, THEME, hex } from "./theme";
import { makeLabel, makeScreen } from "./widgets";

/** splash: "PROJECT Z" (display, the Z in the brand colour) on the base background */
export function showLogo(onDone: () => void): void {
	const ctx = getCtx();
	const TweenService = game.GetService("TweenService");
	const { root, body } = makeScreen(ctx.uiLayer, "Logo", { zIndex: 500 });

	const title = makeLabel(
		body,
		"LogoTitle",
		`PROJECT <font color="${hex(GAME.brand)}">Z</font>`,
		60,
		230,
		1000,
		110,
		84,
		THEME.foreground,
		{ font: "display", align: "center", rich: true },
	);
	title.TextTransparency = 1;

	const sub = makeLabel(body, "LogoSub", "Zombie Survival", 60, 350, 1000, 50, TEXT.xl2, THEME.mutedForeground, {
		font: "label",
		align: "center",
	});
	sub.TextTransparency = 1;

	const info = new TweenInfo(0.9, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
	TweenService.Create(title, info, { TextTransparency: 0 }).Play();
	task.delay(0.35, (): void => {
		TweenService.Create(sub, info, { TextTransparency: 0 }).Play();
	});
	task.delay(1.5, (): void => {
		root.Destroy();
		onDone();
	});
}
