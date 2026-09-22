import { getCtx } from "../bootstrap";
import { COLORS } from "shared/engine/colors";
import { makeFrame, makeLabel } from "./widgets";

export function showLogo(onDone: () => void): void {
	const ctx = getCtx();
	const TweenService = game.GetService("TweenService");
	const root = makeFrame(ctx.uiLayer, "Logo", 0, 0, 1120, 630, COLORS.bg, { zIndex: 500 });
	const title = makeLabel(root, "LogoTitle", "DEAD TOWN", 160, 230, 800, 100, 72, COLORS.uiText);
	title.Font = Enum.Font.GothamBlack;
	title.TextTransparency = 1;
	const sub = makeLabel(root, "LogoSub", "Zombie Survival", 160, 340, 800, 50, 24, COLORS.uiAccent);
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
