import { GameContext } from "shared/game/context";
import { COLORS } from "shared/engine/colors";
import { makeFrame, makeLabel, makeButton } from "./widgets";

export interface PauseHandlers {
	onResume?: () => void;
	onSave?: () => void;
	onHome?: () => void;
	onShop?: () => void;
	onSettings?: () => void;
	onRebirth?: () => void;
}

export function showPause(ctx: GameContext, kind: number, handlers: PauseHandlers): () => void {
	const root = makeFrame(ctx.uiLayer, "Pause", 0, 0, 1120, 630, Color3.fromRGB(0, 0, 0), {
		transparency: 0.45,
		zIndex: 250,
	});
	const panel = makeFrame(root, "Panel", 360, 120, 400, 400, COLORS.uiPanel, { zIndex: 251 });

	if (kind === 2) {
		makeLabel(panel, "Title", "Game over", 20, 24, 360, 44, 28, COLORS.uiRed);
		makeLabel(panel, "Days", `Survival days : ${ctx.save.day}`, 20, 90, 360, 34, 18, COLORS.uiText);
		makeLabel(panel, "Level", `Level : ${ctx.save.level}`, 20, 130, 360, 34, 18, COLORS.uiText);
		const price = ctx.save.deathCount * ctx.save.deathCount * 10 + 10;
		makeLabel(panel, "Price", `Continue price : ${price} coin`, 20, 170, 360, 34, 18, COLORS.uiYellow);
		makeButton(panel, "Rebirth", `Rebirth (${price})`, 100, 240, 200, 52, COLORS.uiPanelLight, (): void => {
			if (handlers.onRebirth !== undefined) handlers.onRebirth();
		});
		makeButton(panel, "Home", "Home", 100, 310, 200, 52, COLORS.uiPanelLight, (): void => {
			if (handlers.onHome !== undefined) handlers.onHome();
		});
	} else {
		makeLabel(panel, "Title", "Paused", 20, 24, 360, 44, 28, COLORS.uiAccent);
		const items: Array<{ label: string; fn: (() => void) | undefined }> = [
			{ label: "Resume", fn: handlers.onResume },
			{ label: "Save", fn: handlers.onSave },
			{ label: "Home", fn: handlers.onHome },
			{ label: "Shop", fn: handlers.onShop },
			{ label: "Settings", fn: handlers.onSettings },
		];
		for (let i = 0; i < items.size(); i++) {
			const item = items[i];
			const fn = item.fn;
			makeButton(panel, `Btn${i}`, item.label, 100, 90 + i * 58, 200, 48, COLORS.uiPanelLight, (): void => {
				if (fn !== undefined) fn();
			});
		}
	}

	return (): void => {
		root.Destroy();
	};
}
