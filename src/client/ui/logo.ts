import { GAME, TEXT, THEME, hex } from "./theme";
import { makeLabel, makeScreen } from "./widgets";

/** "PROJECT Z" with the Z in the brand colour: the logo, for RichText labels */
export const WORDMARK = `PROJECT <font color="${hex(GAME.brand)}">Z</font>`;

/**
 * The logo as a label in the parent's design space (display role, the Z in the brand colour): the splash below and
 * the lobby's title (DESIGN_RULES UI-10) draw the same one.
 */
export function Wordmark(
	parent: Instance,
	name: string,
	x: number,
	y: number,
	w: number,
	h: number,
	size: number,
	align: "left" | "center" = "left",
): TextLabel {
	return makeLabel(parent, name, WORDMARK, x, y, w, h, size, THEME.foreground, {
		font: "display",
		align,
		rich: true,
	});
}

/** splash: "PROJECT Z" (display, the Z in the brand colour) on the base background, in `layer` */
export function showLogo(layer: Instance, onDone: () => void): void {
	const TweenService = game.GetService("TweenService");
	const { root, body } = makeScreen(layer, "Logo", { zIndex: 500 });

	const title = Wordmark(body, "LogoTitle", 60, 230, 1000, 110, 84, "center");
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
