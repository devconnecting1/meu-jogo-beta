import { getCtx } from "../bootstrap";
import { FONTS, PALETTE, makeLabel, makeScreen } from "./widgets";

export function showLogo(onDone: () => void): void {
	const ctx = getCtx();
	const TweenService = game.GetService("TweenService");
	const { root, body } = makeScreen(ctx.uiLayer, "Logo", { zIndex: 500, gradient: true });

	const title = makeLabel(
		body,
		"LogoTitle",
		`PROJECT <font color="#${PALETTE.accent.ToHex()}">Z</font>`,
		60,
		230,
		1000,
		110,
		84,
		PALETTE.text,
		{ font: FONTS.display, align: "center", rich: true },
	);
	title.TextTransparency = 1;

	const sub = makeLabel(body, "LogoSub", "Zombie Survival", 60, 350, 1000, 50, 24, PALETTE.textDim, {
		font: FONTS.medium,
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
