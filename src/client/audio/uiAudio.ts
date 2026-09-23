/*
 * Interface audio, wired without touching a single screen.
 *
 * Every screen of this game lives under one ScreenGui, and every button of the kit carries the "Variant"
 * attribute that `widgets.buildButton` stamps on it. So instead of threading a callback through the whole
 * UI, this module watches the ScreenGui:
 *  - a kit button added anywhere gets a click (Activated) and a hover (MouseEnter / SelectionGained);
 *    the full-screen `InputBlocker` and the slider hit areas have no Variant attribute, so they stay silent;
 *  - a screen or dialog added to `ctx.uiLayer` is a panel opening; the last one leaving is it closing. A screen
 *    kept built between uses (the backpack) is shown and hidden instead, and counts the same way;
 *  - a toast is read from its own glyph ("!" error, "✓" success, "$" coins) and answered accordingly.
 *
 * Everything here is on the UI bus, short and quiet: hover is barely audible (0.11 base), and no UI sound
 * is ever louder than the click.
 */
import type { GameContext } from "shared/game/context";
import { audio } from "./audio";

/** seconds between two hover blips, however fast the pointer sweeps a list */
const HOVER_GAP = 0.07;

let started = false;
let lastHover = 0;

/** buttons of the kit are the ones widgets.buildButton stamped */
function isKitButton(inst: Instance): inst is TextButton {
	if (!inst.IsA("TextButton")) return false;
	return inst.GetAttribute("Variant") !== undefined;
}

function hover(): void {
	const now = os.clock();
	if (now - lastHover < HOVER_GAP) return;
	lastHover = now;
	audio.play("uiHover");
}

function hookButton(b: TextButton): void {
	b.Activated.Connect(() => {
		if (b.GetAttribute("Disabled") === true) return;
		audio.play("uiClick");
	});
	b.MouseEnter.Connect(hover);
	b.SelectionGained.Connect(hover);
}

/** a screen, dialog or overlay that is showing (the toast stack is not one; nor is a screen kept hidden for reuse) */
function isPanel(child: Instance): boolean {
	return child.IsA("Frame") && child.Name !== "ToastStack" && child.Visible;
}

function hasPanel(layer: Instance): boolean {
	for (const child of layer.GetChildren()) {
		if (isPanel(child)) return true;
	}
	return false;
}

/** a panel went away: a screen replacing another already played its "open", so only the last one is a "close" */
function panelClosed(layer: Instance): void {
	task.defer(() => {
		if (!hasPanel(layer)) audio.play("uiClose");
	});
}

/** toasts say what they are with their glyph: read it instead of guessing from the text */
function hookToast(slot: Frame): void {
	task.defer(() => {
		const card = slot.FindFirstChild("Card");
		const icon = card?.FindFirstChild("Icon");
		const glyph = icon?.FindFirstChild("Glyph");
		if (glyph === undefined || !glyph.IsA("TextLabel")) return;
		const g = glyph.Text;
		if (g === "!") audio.play("uiError");
		else if (g === "✓") audio.play("uiBuy");
		else if (g === "$") audio.play("pickupCoin");
		// "i" (plain information) stays silent: those appear often and deserve no attention
	});
}

function hook(inst: Instance): void {
	if (isKitButton(inst)) {
		hookButton(inst);
		return;
	}
	if (inst.IsA("Frame") && inst.Name === "Toast") hookToast(inst);
}

/** starts the interface audio; safe to call more than once */
export function startUiAudio(ctx: GameContext): void {
	if (started) return;
	started = true;
	for (const d of ctx.screen.GetDescendants()) hook(d);
	ctx.screen.DescendantAdded.Connect(hook);

	const layer = ctx.uiLayer;
	// a screen kept built between uses (the backpack) opens and closes by visibility, not by being added / removed
	const watched = new Map<Instance, RBXScriptConnection>();
	const watch = (child: Instance): void => {
		if (!child.IsA("Frame") || child.Name === "ToastStack" || watched.has(child)) return;
		const conn = child.GetPropertyChangedSignal("Visible").Connect(() => {
			if (child.Visible) audio.play("uiOpen");
			else panelClosed(layer);
		});
		watched.set(child, conn);
	};
	for (const child of layer.GetChildren()) watch(child);
	layer.ChildAdded.Connect(child => {
		watch(child);
		if (isPanel(child)) audio.play("uiOpen");
	});
	layer.ChildRemoved.Connect(child => {
		watched.get(child)?.Disconnect();
		watched.delete(child);
		if (isPanel(child)) panelClosed(layer);
	});
}

/** debounce of the Settings previews, so dragging a slider ticks instead of stuttering */
const PREVIEW_GAP_SFX = 0.08;
const PREVIEW_GAP_BGM = 0.6;
let lastPreviewSfx = 0;
let lastPreviewBgm = 0;

/** the SFX slider plays this while it is dragged, so the level is heard, not guessed */
export function previewSfx(): void {
	const now = os.clock();
	if (now - lastPreviewSfx < PREVIEW_GAP_SFX) return;
	lastPreviewSfx = now;
	audio.play("uiClick");
}

/** the BGM slider's own preview, on the music bus (there is no music playing behind the Settings screen) */
export function previewBgm(): void {
	const now = os.clock();
	if (now - lastPreviewBgm < PREVIEW_GAP_BGM) return;
	lastPreviewBgm = now;
	audio.play("stingerDawn", { scale: 0.7 });
}
