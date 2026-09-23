/*
 * The screen the game is drawn on, as the engine reports it (docs/DESIGN_RULES.md UI-02). One place, so the world, the
 * HUD, the menus and the touch hit-test all agree on it:
 *
 *   - the WHOLE screen (Camera.ViewportSize) is the world's: the world, the night, the plates over it and the town behind
 *     the menus bleed to its edges, under a notch too -- their ScreenGui has ScreenInsets.None (client/bootstrap.ts), the
 *     inset the docs keep for non-interactive content;
 *   - the DEVICE SAFE AREA inside it is the interface's: the HUD's and the menus' ScreenGuis use
 *     ScreenInsets.DeviceSafeInsets, so nothing a thumb or a cursor needs sits under a notch, a camera cut-out or a
 *     rounded corner. Their coordinates start at its top-left, and the kit lays them out in its size (skin.ts
 *     viewportSize, bootstrap.ts's touch geometry).
 *
 * The Roblox top bar is NOT reserved by that inset, on purpose: its buttons take one corner of it, and the kit keeps clear
 * of them itself (topInset below, skin.ts topBar) -- the HUD stays under the bar's height, and a window only moves down
 * when it would really run under a button (UI-07). ScreenInsets.CoreUISafeInsets would reserve the bar's whole width and
 * undo that.
 *
 * GuiService:GetInsetArea gives every inset area as a Rect relative to the core UI safe area -- the same origin a touch's
 * InputObject.Position is measured from ("accounting for GUI insets") -- so the safe area's place on the screen and a
 * finger's place in the safe area are both exact. On a client without it (and in a harness that does not model it) the
 * safe area is the whole screen and a touch is shifted by GetGuiInset, which is what the game did before.
 */

const GuiService = game.GetService("GuiService");
const UserInputService = game.GetService("UserInputService");
const Workspace = game.GetService("Workspace");

/** the whole screen before the camera reports one: the 1120 x 630 design space */
const FALLBACK = new Vector2(1120, 630);
const ZERO = new Vector2(0, 0);

/** the whole screen, px: what the world covers (ScreenInsets.None) */
export function screenSize(): Vector2 {
	const cam = Workspace.CurrentCamera;
	if (cam !== undefined) {
		const v = cam.ViewportSize;
		if (v.X > 1 && v.Y > 1) return v;
	}
	return FALLBACK;
}

/** an inset area relative to the core UI safe area, or undefined where the engine cannot say */
function insetArea(kind: Enum.ScreenInsets): Rect | undefined {
	const [ok, rect] = pcall(() => GuiService.GetInsetArea(kind));
	if (!ok || rect === undefined) return undefined;
	const r = rect as Rect;
	return r.Width > 1 && r.Height > 1 ? r : undefined;
}

// the safe area, measured when the screen size changes (the inset areas move with it: a rotation, a resize)
let keyW = -1;
let keyH = -1;
let origin = ZERO;
let size = FALLBACK;

function measure(): void {
	const v = screenSize();
	keyW = v.X;
	keyH = v.Y;
	const none = insetArea(Enum.ScreenInsets.None);
	const safe = insetArea(Enum.ScreenInsets.DeviceSafeInsets);
	if (none === undefined || safe === undefined) {
		origin = ZERO;
		size = v;
		return;
	}
	origin = new Vector2(safe.Min.X - none.Min.X, safe.Min.Y - none.Min.Y);
	size = new Vector2(safe.Width, safe.Height);
}

function fresh(): void {
	const v = screenSize();
	if (v.X !== keyW || v.Y !== keyH) measure();
}

/** where the device safe area starts on the whole screen, px (0, 0 on a screen with no cut-out) */
export function safeOrigin(): Vector2 {
	fresh();
	return origin;
}

/** the device safe area's size, px: the screen the HUD and the menus are laid out on */
export function safeSize(): Vector2 {
	fresh();
	return size;
}

/** reads the safe area again now (the viewport settled: bootstrap.ts resize) */
export function refreshSafeArea(): void {
	measure();
}

/**
 * What to add to a touch's InputObject.Position to land in the safe area's coordinates -- the HUD's, where the touch
 * controls are drawn. Read on every touch: the bar can change size under a finger (a notification), and the offset
 * with it.
 */
export function touchOffset(): Vector2 {
	const safe = insetArea(Enum.ScreenInsets.DeviceSafeInsets);
	if (safe !== undefined) return new Vector2(-safe.Min.X, -safe.Min.Y);
	const [topLeft] = GuiService.GetGuiInset();
	return topLeft;
}

/**
 * Height (px) covered by the Roblox top bar, in the safe area's coordinates: the HUD places nothing above it, and a
 * window keeps clear of its buttons (UI-02, UI-07). The bar ends where the core UI safe area begins (GetInsetArea), or
 * at GetGuiInset's top where the engine cannot say; its own Rect (TopbarInset) counts when it reports it taller.
 */
export function topInset(): number {
	const safe = insetArea(Enum.ScreenInsets.DeviceSafeInsets);
	let inset: number;
	if (safe !== undefined) {
		inset = -safe.Min.Y;
	} else {
		const [topLeft] = GuiService.GetGuiInset();
		inset = topLeft.Y;
	}
	const [ok, value] = pcall(() => GuiService.TopbarInset);
	if (ok) {
		const rect = value as Rect;
		if (rect.Height > 0) inset = math.max(inset, rect.Max.Y);
	}
	return math.max(0, inset);
}

// ---------------------------------------------------------------- the player's input device

/**
 * What the interface is laid out for right now: the touch controls or not, and which keys a hint names (the pad's or
 * the keyboard's). ONE answer for the whole client -- the HUD's touch layer, its key hints, the menus' focus, the
 * Controls tab's first device and the aim mode a session starts in all read it -- where there used to be three
 * heuristics that could disagree on a hybrid device (a touch laptop, a tablet with a keyboard).
 *
 * It is UserInputService.PreferredInput, the engine's own answer ("the player's primary input, based on the devices
 * connected and the one most recently used"): Touch is a touch screen with nothing else in use, Gamepad (or a
 * MicroGamepad) a pad that is connected or was just used, KeyboardAndMouse the rest. On a client without it: the
 * last input from a pad, else a touch screen with no mouse, else the keyboard -- what the game read before.
 */
export type InputDevice = "keyboard" | "touch" | "gamepad";

const [readable, firstRead] = pcall(() => UserInputService.PreferredInput);
const hasPreferred = readable && firstRead !== undefined;

export function inputDevice(): InputDevice {
	if (hasPreferred) {
		const p = UserInputService.PreferredInput;
		if (p === Enum.PreferredInput.Touch) return "touch";
		if (p === Enum.PreferredInput.Gamepad || p === Enum.PreferredInput.MicroGamepad) return "gamepad";
		return "keyboard";
	}
	if (UserInputService.GetLastInputType().Name.sub(1, 7) === "Gamepad") return "gamepad";
	return UserInputService.TouchEnabled && !UserInputService.MouseEnabled ? "touch" : "keyboard";
}

/**
 * Calls `fn` with the new device whenever it changes (PreferredInput's own signal; on a client without it, the last
 * input type's). Returns the connection to end it (undefined where neither signal exists).
 */
export function onInputDeviceChanged(fn: (device: InputDevice) => void): RBXScriptConnection | undefined {
	let last = inputDevice();
	const changed = (): void => {
		const now = inputDevice();
		if (now === last) return;
		last = now;
		fn(now);
	};
	const [ok, conn] = pcall(() =>
		hasPreferred
			? UserInputService.GetPropertyChangedSignal("PreferredInput").Connect(changed)
			: UserInputService.LastInputTypeChanged.Connect(changed),
	);
	return ok ? (conn as RBXScriptConnection) : undefined;
}
