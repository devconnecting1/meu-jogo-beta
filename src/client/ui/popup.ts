import { GameContext } from "shared/game/context";
import { COLORS } from "shared/engine/colors";
import { makeFrame, makeLabel, makeButton } from "./widgets";

export interface PopupButtonSpec {
	text: string;
	onClick?: () => void;
}

export function popup(ctx: GameContext, title: string, body: string, buttons: Array<PopupButtonSpec>): Frame {
	const overlay = makeFrame(ctx.uiLayer, "PopupOverlay", 0, 0, 1120, 630, Color3.fromRGB(0, 0, 0), {
		transparency: 0.45,
		zIndex: 300,
	});
	const panel = makeFrame(overlay, "PopupPanel", 280, 95, 560, 440, COLORS.uiPanel, { zIndex: 301 });
	makeLabel(panel, "PopupTitle", title, 20, 18, 520, 44, 26, COLORS.uiAccent);
	const bodyLabel = makeLabel(panel, "PopupBody", body, 30, 74, 500, 290, 18, COLORS.uiText);
	bodyLabel.TextYAlignment = Enum.TextYAlignment.Top;
	const count = buttons.size();
	const btnW = 150;
	const gap = 20;
	const total = count * btnW + math.max(count - 1, 0) * gap;
	let bx = (560 - total) / 2;
	for (const spec of buttons) {
		const label = spec.text;
		const handler = spec.onClick;
		makeButton(panel, `PopupBtn${label}`, label, bx, 372, btnW, 46, COLORS.uiPanelLight, (): void => {
			if (handler !== undefined) handler();
			overlay.Destroy();
		});
		bx += btnW + gap;
	}
	return overlay;
}

export function toast(ctx: GameContext, text: string): void {
	const TweenService = game.GetService("TweenService");
	const designX = 360;
	const t = new Instance("TextLabel");
	t.Name = "Toast";
	t.Position = UDim2.fromScale(designX / 1120, 70 / 630);
	t.Size = UDim2.fromScale(400 / 1120, 46 / 630);
	t.BackgroundColor3 = COLORS.uiPanel;
	t.BorderSizePixel = 0;
	t.Text = text;
	t.TextSize = 18;
	t.TextColor3 = COLORS.uiText;
	t.Font = Enum.Font.GothamBold;
	t.TextWrapped = true;
	t.BackgroundTransparency = 0.2;
	t.ZIndex = 400;
	t.Parent = ctx.uiLayer;
	task.delay(1.9, (): void => {
		const info = new TweenInfo(0.4, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
		const tween = TweenService.Create(t, info, { BackgroundTransparency: 1, TextTransparency: 1 });
		tween.Play();
		tween.Completed.Wait();
		t.Destroy();
	});
}
