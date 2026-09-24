import { THEME } from "./theme";
import { makeFrame } from "./widgets";

/**
 * A box for a Renderer drawing (a wardrobe tile's cosmetic, the big preview, a pet pack's picture in the shop). The kit
 * lays out in Scale; the renderer draws in offsets. So the drawing gets its own w x h design-unit space under a
 * UIScale that keeps it exactly as big as its holder on screen, whatever the screen. (The lobby's survivor previews use
 * it too, client/ui/lobby.ts.) Its own module so the shop and the wardrobe -- which imports the shop -- can both use it
 * without a require cycle.
 */
export function drawingBox(
	parent: Instance,
	name: string,
	x: number,
	y: number,
	w: number,
	h: number,
	zIndex: number,
): Frame {
	const holder = makeFrame(parent, name, x, y, w, h, THEME.background, { transparency: 1, zIndex });
	const inner = new Instance("Frame");
	inner.Name = "Scaled";
	inner.BackgroundTransparency = 1;
	inner.BackgroundColor3 = THEME.background;
	inner.BorderSizePixel = 0;
	inner.Size = UDim2.fromOffset(w, h);
	inner.ZIndex = zIndex;
	const scale = new Instance("UIScale");
	scale.Parent = inner;
	const fit = (): void => {
		const px = holder.AbsoluteSize.X;
		if (px > 0) scale.Scale = px / w;
	};
	holder.GetPropertyChangedSignal("AbsoluteSize").Connect(fit);
	fit();
	inner.Parent = holder;
	return inner;
}
