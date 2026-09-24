/*
 * B on a pad, Backspace on a keyboard: back out of the screen on top (the settings / menus QA sweep, NAV-B).
 *
 * Before this, nothing closed a screen but its own X / Back or the button that opened it: the pad's B only took the
 * selection off (the engine's GUI navigation), and Esc -- the key a PC player tries first -- belongs to Roblox (UI-02).
 * Roblox's own guidance for a pad is a "BackOrCancel" action on ButtonB that navigates back (creator-docs, input /
 * micro-gamepad); this is that action, for every screen of the kit at once.
 *
 * Every screen that HAS a way out registers it here, with the control that is that way out:
 *   - a UI-07 window with an X (window.ts `Window`: Settings, Wardrobe, the Survivor screen, Records, the Backpack);
 *   - a dialog with an X (widgets.ts `Dialog`: Achievements) and a popup (popup.ts: B dismisses it without answering,
 *     which is what its Close / Cancel / Back does -- a question like "watch the tutorial?" is left unanswered, never
 *     answered "No"); the admin's `confirmAction` (its Cancel);
 *   - the menu pages and cards whose way out is a button: the Shop's and the Credits' Back, How to play's "Got it",
 *     the in-run Menu's "Back to game".
 * B / Backspace runs the newest one still on screen (`closeTopScreen`), exactly as a click on that control would.
 *
 * What is never here: the lobby's own menu (there is nothing behind it to go back to); the end-of-run and daybreak
 * screens (they ask for a decision -- Rebirth, wait, New game -- and B must not pick one); anything of the HUD (UI-09:
 * nothing there is the pad's -- a registered control that is not `Selectable`, like the scoreboard's X, is skipped).
 * With no screen on top the press is not eaten: the pad's B and the keyboard's Backspace mean nothing in a run, and
 * the keyboard's B stays the Backpack.
 *
 * After closing, the pad gets its place back: the control that held the selection when that screen came up (the "?"
 * that opened a help popup, the plate that opened a window), unless the screen underneath already chose one.
 */
const GuiService = game.GetService("GuiService");
const UserInputService = game.GetService("UserInputService");

interface BackEntry {
	/** the screen's way out (or, for a popup, its card): on screen = the screen is up */
	anchor: GuiObject;
	action: () => void;
	/** what held the pad's selection when this screen came up */
	prev?: GuiObject;
	order: number;
}

const entries = new Array<BackEntry>();
let stamp = 0;

function indexOf(anchor: GuiObject): number {
	for (let i = 0; i < entries.size(); i++) {
		if (entries[i].anchor === anchor) return i;
	}
	return -1;
}

/** on screen: every GuiObject up the tree visible, up to an enabled ScreenGui */
function onScreen(g: GuiObject): boolean {
	let p: Instance | undefined = g;
	while (p !== undefined) {
		if (p.IsA("GuiObject") && !p.Visible) return false;
		// (a ScreenGui is Enabled unless something turned it off; the Node shim leaves the property unset)
		if (p.IsA("LayerCollector")) return p.Enabled !== false;
		p = p.Parent;
	}
	return false;
}

/**
 * `anchor` is the way out of a screen that just came up, and `action` what it does (the same function its click runs).
 * Registering an anchor again moves it to the top (a screen kept built and shown again: the Backpack).
 */
export function registerBack(anchor: GuiObject, action: () => void): void {
	const at = indexOf(anchor);
	stamp += 1;
	const prev = GuiService.SelectedObject;
	if (at >= 0) {
		const e = entries[at];
		e.action = action;
		e.prev = prev !== anchor ? prev : undefined;
		e.order = stamp;
		return;
	}
	entries.push({ anchor, action, prev: prev !== anchor ? prev : undefined, order: stamp });
	anchor.Destroying.Connect(() => {
		const i = indexOf(anchor);
		if (i >= 0) entries.remove(i);
	});
}

/** a screen kept built was shown again: it is on top now, and the selection it came up over is the one to return to */
export function raiseBack(anchor: GuiObject): void {
	const at = indexOf(anchor);
	if (at < 0) return;
	const e = entries[at];
	registerBack(anchor, e.action);
}

/** the way out B would take now, if any (the newest registered screen still on screen) */
export function topBack(): GuiObject | undefined {
	// a destroyed screen whose Destroying never reached us (only its ancestor was destroyed) is forgotten here
	for (let i = entries.size() - 1; i >= 0; i--) {
		if (entries[i].anchor.Parent === undefined) entries.remove(i);
	}
	let best: BackEntry | undefined;
	for (const e of entries) {
		if (e.anchor.IsA("GuiButton") && e.anchor.Selectable === false) continue;
		if (!onScreen(e.anchor)) continue;
		if (best === undefined || e.order > best.order) best = e;
	}
	return best?.anchor;
}

/** B / Backspace: runs the top screen's way out. False (and nothing done) when no screen with one is up. */
export function closeTopScreen(): boolean {
	const anchor = topBack();
	if (anchor === undefined) return false;
	const e = entries[indexOf(anchor)];
	const prev = e.prev;
	e.action();
	// after the engine's own handling of the press (on a pad, B also drops the selection): give the pad its place back,
	// unless the screen underneath already put it somewhere that is on screen
	task.defer(() => {
		if (UserInputService.GetLastInputType().Name.sub(1, 7) !== "Gamepad") return;
		const sel = GuiService.SelectedObject;
		if (sel !== undefined && onScreen(sel)) return;
		if (prev !== undefined && prev.Selectable !== false && onScreen(prev)) GuiService.SelectedObject = prev;
	});
	return true;
}
