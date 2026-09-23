import { GAME_NAME } from "shared/module";
import { Camera } from "shared/engine/camera";
import {
	AimTarget,
	InputState,
	TouchLayout,
	TouchPrefs,
	applyAimAssist,
	computeTouchLayout,
	onMoveSide,
} from "shared/engine/input";
import { Renderer } from "shared/engine/renderer";
import { COLORS } from "shared/engine/colors";
import { defaultSave, PlayerSaveData } from "shared/game/save";
import { GameContext, GamePhase } from "shared/game/context";
import { syncChatInput } from "./chatInput";
import { warmFightPool } from "./view/poolWarmup";

const Players = game.GetService("Players");
const RunService = game.GetService("RunService");
const UserInputService = game.GetService("UserInputService");
const GuiService = game.GetService("GuiService");
const StarterGui = game.GetService("StarterGui");

/**
 * There is no character/tools in this game: the Backpack CoreGui's number-key hotbar collides
 * with WEAPON_KEYS (1-5 below) and Health/EmotesMenu have nothing of ours to show, so we turn
 * them off. Chat and PlayerList stay on (social). SetCoreGuiEnabled can fail if called before the
 * CoreGui is ready, so retry a few times without blocking the rest of bootstrap.
 */
function disableCoreGui(guiType: Enum.CoreGuiType): void {
	task.spawn(() => {
		for (let attempt = 0; attempt < 5; attempt++) {
			const [ok] = pcall(() => StarterGui.SetCoreGuiEnabled(guiType, false));
			if (ok) return;
			task.wait(0.2);
		}
	});
}
disableCoreGui(Enum.CoreGuiType.Backpack);
disableCoreGui(Enum.CoreGuiType.Health);
disableCoreGui(Enum.CoreGuiType.EmotesMenu);

// gamepad players navigate the menus with the kit's focus ring (widgets.ts); this is the engine side of it
pcall(() => {
	GuiService.GuiNavigationEnabled = true;
});
// ...but not the engine's "Select picks a GUI" (AutoSelectGuiEnabled): every screen of the kit focuses itself
// (widgets.autoFocus, focusFirstMenuControl below), and Back / Select is the match scoreboard's (MP-23)
pcall(() => {
	GuiService.AutoSelectGuiEnabled = false;
});

const player = Players.LocalPlayer;
const playerGui = player.WaitForChild("PlayerGui") as PlayerGui;

const stale = playerGui.FindFirstChild("GameGui");
if (stale !== undefined) {
	stale.Destroy();
}

const screen = new Instance("ScreenGui");
screen.Name = "GameGui";
screen.ResetOnSpawn = false;
screen.IgnoreGuiInset = true;
screen.DisplayOrder = 100;
screen.ZIndexBehavior = Enum.ZIndexBehavior.Sibling;
screen.Parent = playerGui;

const root = new Instance("Frame");
root.Name = "Root";
root.Size = UDim2.fromScale(1, 1);
root.BackgroundColor3 = COLORS.bg;
root.BorderSizePixel = 0;
root.Parent = screen;

// no clip of its own: its one child, the renderer's layer, fills it and clips the world sprites to the same rect
const worldLayer = new Instance("Frame");
worldLayer.Name = "World";
worldLayer.Size = UDim2.fromScale(1, 1);
worldLayer.BackgroundTransparency = 1;
worldLayer.BorderSizePixel = 0;
worldLayer.Parent = root;

const darkLayer = new Instance("Frame");
darkLayer.Name = "Dark";
darkLayer.Size = UDim2.fromScale(1, 1);
darkLayer.BackgroundColor3 = COLORS.overlayNight;
darkLayer.BackgroundTransparency = 1;
darkLayer.BorderSizePixel = 0;
darkLayer.ZIndex = 80;
darkLayer.Parent = root;

const hudLayer = new Instance("Frame");
hudLayer.Name = "Hud";
hudLayer.Size = UDim2.fromScale(1, 1);
hudLayer.BackgroundTransparency = 1;
hudLayer.BorderSizePixel = 0;
hudLayer.ZIndex = 90;
hudLayer.Parent = root;

const uiLayer = new Instance("Frame");
uiLayer.Name = "Ui";
uiLayer.Size = UDim2.fromScale(1, 1);
uiLayer.BackgroundTransparency = 1;
uiLayer.BorderSizePixel = 0;
uiLayer.ZIndex = 100;
uiLayer.Parent = root;

const cam = new Camera();
const input = new InputState();
// phones/tablets start in touch aim (the "mouse" location there is just the last finger)
if (UserInputService.TouchEnabled && !UserInputService.MouseEnabled) input.aimMode = "touch";
const renderer = new Renderer(worldLayer, "Sprites");
const save: PlayerSaveData = defaultSave();

const ctx: GameContext = {
	playerGui,
	screen,
	root,
	hudLayer,
	worldLayer,
	uiLayer,
	darkLayer,
	cam,
	input,
	renderer,
	save,
	phase: "boot",
	viewW: 1120,
	viewH: 630,
};

// ---------------------------------------------------------------- touch layout

/** px covered by the Roblox top bar (our ScreenGui ignores the inset, so we keep clear of it) */
function topInset(): number {
	const [topLeft] = GuiService.GetGuiInset();
	let inset = topLeft.Y;
	const [ok, value] = pcall(() => GuiService.TopbarInset);
	if (ok) {
		const rect = value as Rect;
		if (rect.Height > 0) inset = math.max(inset, rect.Max.Y);
	}
	return math.max(0, inset);
}

function touchPrefs(): TouchPrefs {
	const s = ctx.save.settings;
	return {
		leftSize: s.leftSize,
		leftPos: s.leftPos,
		leftRelative: s.leftRelative,
		rightSize: s.rightSize,
		rightPos: s.rightPos,
		mirror: s.mirror,
	};
}

let layout: TouchLayout = computeTouchLayout(touchPrefs(), ctx.viewW, ctx.viewH, 0);
/** bumped whenever the geometry changes, so the HUD can redraw the controls without polling the settings */
let layoutRevision = 0;
const layoutListeners = new Set<() => void>();

/**
 * Recomputes the touch geometry from the current save + viewport. Called on a viewport change and by the
 * settings screen whenever a control slider moves, so what the thumb hits and what the HUD draws stay identical.
 */
export function refreshTouchLayout(): TouchLayout {
	layout = computeTouchLayout(touchPrefs(), ctx.viewW, ctx.viewH, topInset());
	input.joystickRadius = layout.move.radius;
	layoutRevision += 1;
	for (const fn of layoutListeners) fn();
	return layout;
}

export function getTouchLayout(): TouchLayout {
	return layout;
}

export function touchLayoutRevision(): number {
	return layoutRevision;
}

/** subscribe to layout changes (settings, rotation, resize); returns the unsubscriber */
export function onTouchLayoutChanged(fn: () => void): () => void {
	layoutListeners.add(fn);
	return (): void => {
		layoutListeners.delete(fn);
	};
}

function resize(): void {
	let viewportX = 1120;
	let viewportY = 630;
	const cam2 = game.GetService("Workspace").CurrentCamera;
	if (cam2 !== undefined) {
		const vs = cam2.ViewportSize;
		if (vs.X > 1 && vs.Y > 1) {
			viewportX = vs.X;
			viewportY = vs.Y;
		}
	}
	ctx.viewW = viewportX;
	ctx.viewH = viewportY;
	cam.setView(viewportX, viewportY);
	renderer.setView(viewportX, viewportY);
	refreshTouchLayout();
	print(`[${GAME_NAME}] viewport ${viewportX}x${viewportY} (${layout.shape})`);
}

resize();
const bootCam = game.GetService("Workspace").CurrentCamera;
if (bootCam !== undefined) {
	bootCam.GetPropertyChangedSignal("ViewportSize").Connect(resize);
}
// the top bar grows/shrinks (chat, notifications): the controls must stay under it (DESIGN_RULES UI-02)
pcall(() => {
	GuiService.GetPropertyChangedSignal("TopbarInset").Connect(() => refreshTouchLayout());
});
task.delay(1, resize);
task.delay(3, resize);
// a night fight's sprites are built behind the lobby, a few per frame, never during a run (client/view/poolWarmup.ts)
task.delay(1, () => warmFightPool(ctx));

// --- input wiring ---
function pressAttack(): void {
	input.attackPressed = true;
	input.attackHeld = true;
}
function releaseAttack(): void {
	input.attackReleased = true;
	input.attackHeld = false;
}

// Several sources can hold the attack button at once (mouse + aim pad + gamepad trigger).
// pressAttack/releaseAttack only fire on the 0→1 / 1→0 transition of this counter.
let attackSources = 0;
/**
 * `edge` false holds the trigger WITHOUT the press edge. That is what the aim pad wants: `combat.ts` reads
 * `want = w.auto ? held || pressed : pressed`, so a held-only source keeps an automatic firing while a
 * semi-auto or a bolt action waits for the "let go" edge that `tapAttack` gives it.
 */
function addAttackSource(edge = true): void {
	attackSources += 1;
	if (attackSources !== 1) return;
	if (edge) pressAttack();
	else input.attackHeld = true;
}
function removeAttackSource(): void {
	if (attackSources <= 0) return;
	attackSources -= 1;
	if (attackSources === 0) {
		releaseAttack();
	}
}

/**
 * The "let go" edge of the aim pad: one press + release in the same frame, which is one aimed shot from a
 * semi-auto, one from a bolt action (it fires on the release), and a harmless extra edge on an automatic that
 * is already firing and still on cooldown.
 */
function tapAttack(): void {
	if (attackSources > 0) return; // something else is still holding the trigger
	input.attackPressed = true;
	input.attackReleased = true;
	input.attackHeld = false;
}

/** keys 1–5 pick the 1st…5th weapon the survivor owns */
const WEAPON_KEYS: Array<Enum.KeyCode> = [
	Enum.KeyCode.One,
	Enum.KeyCode.Two,
	Enum.KeyCode.Three,
	Enum.KeyCode.Four,
	Enum.KeyCode.Five,
];

let mouseDown = false;
/** finger InputObject → the zone it started in, so releasing one finger never affects another */
const touchRoles = new Map<InputObject, "move" | "aim">();
/** the finger currently driving the move stick / the aim pad (at most one each, simultaneously) */
let moveFinger: InputObject | undefined;
let aimFinger: InputObject | undefined;

/*
 * Aim pad gesture (docs/DESIGN_RULES.md P2: the original just fired wherever the last finger happened to be):
 * - the first AIM_GRACE seconds are pure aiming — drag to turn the survivor, nothing else;
 * - held past AIM_GRACE the trigger goes DOWN WITHOUT A PRESS EDGE, so automatics (and melee, which is
 *   `auto` too) keep firing while the thumb stays on the glass, and semi-autos stay quiet;
 * - releasing emits one press+release edge, so "drag to aim, let go to shoot" is the same gesture on every
 *   weapon, and a quick tap inside the grace is simply the same thing done fast.
 */
const AIM_GRACE = 0.16;
let aimHoldStart = 0;
let aimHoldArmed = false;

/** the assist needs bodies; the run registers a provider (client/onboarding/index.ts) while it is alive */
let aimTargetProvider: (() => Array<AimTarget>) | undefined;
const NO_TARGETS: Array<AimTarget> = [];

/**
 * Registers where the aim assist may look for bodies (zombies and bosses of the live run). Passing `undefined`
 * turns the assist off again, which is what the menus want.
 */
export function setAimTargets(provider: (() => Array<AimTarget>) | undefined): void {
	aimTargetProvider = provider;
}

/**
 * Recomputes input.aimAngle from the live pointer every frame. Called by the game loop with the survivor's
 * world position, and the only place the aim angle is produced — so the assist below lands in the ordinary
 * 60 Hz command (docs/MULTIPLAYER.md §2.2) like any other aim.
 */
export function refreshAim(px: number, py: number): number {
	if (input.aimMode === "touch") {
		// the thumb has been on the pad long enough: the trigger goes down (automatics fire, semi-autos wait)
		if (aimFinger !== undefined && !aimHoldArmed && os.clock() - aimHoldStart >= AIM_GRACE) {
			aimHoldArmed = true;
			addAttackSource(false);
		}
		// no aim pad / right stick held: face where the survivor walks (twin-stick fallback)
		if (!input.aimStickActive && !gamepadAimActive && input.moveMagnitude > 0.2) {
			const d = cam.screenDirToWorld(input.moveX, input.moveY);
			if (d.x * d.x + d.y * d.y > 1e-6) input.aimAngle = math.atan2(d.y, d.x);
		}
		// aim assist is for thumbs and sticks only: a mouse is precise and would feel it fight back
		const targets = aimTargetProvider !== undefined ? aimTargetProvider() : NO_TARGETS;
		if (targets.size() > 0) input.aimAngle = applyAimAssist(input.aimAngle, px, py, targets);
		return input.aimAngle;
	}
	if (input.aimMode === "mouse") {
		const m = UserInputService.GetMouseLocation();
		const w = cam.screenToWorld(m.X, m.Y);
		const dx = w.x - px;
		const dy = w.y - py;
		if (math.sqrt(dx * dx + dy * dy) > 1) {
			input.aimAngle = math.atan2(dy, dx);
		}
	}
	return input.aimAngle;
}

// ---------------------------------------------------------------- gamepad

const GAMEPAD_DEAD = 0.2;

/** a stick reading past the dead zone, rescaled so the first degree of travel is not swallowed */
function stickVector(pos: Vector3): { x: number; y: number; mag: number } {
	// Roblox thumbsticks are y-up; the game's screen space is y-down
	const x = pos.X;
	const y = -pos.Y;
	const len = math.sqrt(x * x + y * y);
	if (len <= GAMEPAD_DEAD) return { x: 0, y: 0, mag: 0 };
	const mag = math.min((len - GAMEPAD_DEAD) / (1 - GAMEPAD_DEAD), 1);
	return { x: x / len, y: y / len, mag };
}

/** a gamepad is in the player's hands: menus must be navigable, and the game must not steal the buttons */
function menuHasFocus(): boolean {
	return GuiService.SelectedObject !== undefined;
}

/**
 * Picks the first control of the top-most open screen. The kit only auto-focuses when the player's LAST input
 * was a pad (widgets.autoFocus), so a player who opens a menu with a thumb and then reaches for the controller
 * would otherwise find nothing selected and nothing to navigate from. Returns false when no screen is open,
 * which is also how the toast stack is skipped: it has no selectable control.
 */
function focusFirstMenuControl(): boolean {
	const screens = uiLayer.GetChildren();
	for (let i = screens.size() - 1; i >= 0; i--) {
		const screen = screens[i];
		if (!screen.IsA("GuiObject") || !screen.Visible) continue;
		for (const d of screen.GetDescendants()) {
			if (d.IsA("GuiButton") && d.Selectable && d.Visible) {
				GuiService.SelectedObject = d;
				return true;
			}
		}
	}
	return false;
}

/** the left stick is deflected: keeps it from fighting WASD when both are plugged in */
let gamepadMoveActive = false;
/** the right stick is deflected: while it is, the aim comes from it and not from the walk direction */
let gamepadAimActive = false;
/** attack buttons currently down (a trigger and a face button can be held at once) */
const gamepadAttackDown = new Set<Enum.KeyCode>();

const GAMEPAD_ATTACK: Array<Enum.KeyCode> = [Enum.KeyCode.ButtonR2, Enum.KeyCode.ButtonR1, Enum.KeyCode.ButtonA];

function handleGamepadButton(key: Enum.KeyCode, down: boolean): void {
	if (GAMEPAD_ATTACK.indexOf(key) >= 0) {
		if (down) {
			if (gamepadAttackDown.has(key)) return;
			gamepadAttackDown.add(key);
			addAttackSource();
		} else if (gamepadAttackDown.has(key)) {
			gamepadAttackDown.delete(key);
			removeAttackSource();
		}
		return;
	}
	if (key === Enum.KeyCode.ButtonX) {
		input.keyE = down;
		if (down) input.actionPressed = true;
		return;
	}
	if (!down) return;
	if (key === Enum.KeyCode.ButtonY) {
		input.reloadPressed = true;
	} else if (key === Enum.KeyCode.ButtonL1) {
		input.backpackPressed = true;
	} else if (key === Enum.KeyCode.ButtonStart) {
		input.pausePressed = true;
	} else if (key === Enum.KeyCode.ButtonSelect) {
		// the match scoreboard (MP-23): press to open, press again to close
		input.scoreboardPressed = true;
	}
}

UserInputService.InputBegan.Connect((inputObj, gpe) => {
	if (inputObj.UserInputType === Enum.UserInputType.MouseButton1) {
		if (gpe) return;
		mouseDown = true;
		input.aimMode = "mouse";
		addAttackSource();
		return;
	}
	if (gpe) return;
	if (inputObj.UserInputType === Enum.UserInputType.MouseButton2) {
		input.actionPressed = true;
	} else if (inputObj.UserInputType === Enum.UserInputType.Keyboard) {
		const k = inputObj.KeyCode;
		if (k === Enum.KeyCode.W) {
			input.keyW = true;
		} else if (k === Enum.KeyCode.A) {
			input.keyA = true;
		} else if (k === Enum.KeyCode.S) {
			input.keyS = true;
		} else if (k === Enum.KeyCode.D) {
			input.keyD = true;
		} else if (k === Enum.KeyCode.LeftShift) {
			input.keyShift = true;
		} else if (k === Enum.KeyCode.E) {
			input.keyE = true;
			input.actionPressed = true;
		} else if (k === Enum.KeyCode.R) {
			input.keyR = true;
			input.reloadPressed = true;
		} else if (k === Enum.KeyCode.B || k === Enum.KeyCode.Tab) {
			// Tab/Esc are usually swallowed by Roblox's CoreGui; B/P always reach the game
			if (k === Enum.KeyCode.Tab) input.keyTab = true;
			input.backpackPressed = true;
		} else if (k === Enum.KeyCode.P || k === Enum.KeyCode.Escape) {
			if (k === Enum.KeyCode.Escape) input.keyEsc = true;
			input.pausePressed = true;
		} else if (k === Enum.KeyCode.Q) {
			// held: the match scoreboard shows while Q is down (MP-23; Tab is the Roblox player list's, UI-02)
			input.keyScoreboard = true;
		} else {
			const slot = WEAPON_KEYS.indexOf(k);
			if (slot >= 0) input.weaponSlotPressed = slot;
		}
	} else if (inputObj.UserInputType === Enum.UserInputType.Touch) {
		handleTouchBegin(inputObj);
	} else if (inputObj.UserInputType.Name.sub(1, 7) === "Gamepad") {
		// a selected menu owns the pad: only the two toggles still reach the game -- Start (the menu) and LB (the Bag),
		// so the button that opened a screen closes it too (UI-11: "B / LB keep opening and closing"; the Bag takes the
		// focus when a pad opens it, and LB used to be swallowed right there)
		if (menuHasFocus()) {
			if (inputObj.KeyCode !== Enum.KeyCode.ButtonStart && inputObj.KeyCode !== Enum.KeyCode.ButtonL1) return;
		} else if (focusFirstMenuControl()) {
			// a screen was open with nothing selected: this press is what wakes the navigation up
			return;
		}
		handleGamepadButton(inputObj.KeyCode, true);
	}
});

UserInputService.InputEnded.Connect(inputObj => {
	if (inputObj.UserInputType === Enum.UserInputType.MouseButton1) {
		if (mouseDown) {
			mouseDown = false;
			removeAttackSource();
		}
	} else if (inputObj.UserInputType === Enum.UserInputType.Keyboard) {
		const k = inputObj.KeyCode;
		if (k === Enum.KeyCode.W) input.keyW = false;
		else if (k === Enum.KeyCode.A) input.keyA = false;
		else if (k === Enum.KeyCode.S) input.keyS = false;
		else if (k === Enum.KeyCode.D) input.keyD = false;
		else if (k === Enum.KeyCode.LeftShift) input.keyShift = false;
		else if (k === Enum.KeyCode.E) input.keyE = false;
		else if (k === Enum.KeyCode.R) input.keyR = false;
		else if (k === Enum.KeyCode.Tab) input.keyTab = false;
		else if (k === Enum.KeyCode.Escape) input.keyEsc = false;
		else if (k === Enum.KeyCode.Q) input.keyScoreboard = false;
	} else if (inputObj.UserInputType === Enum.UserInputType.Touch) {
		handleTouchEnd(inputObj);
	} else if (inputObj.UserInputType.Name.sub(1, 7) === "Gamepad") {
		handleGamepadButton(inputObj.KeyCode, false);
	}
});

UserInputService.InputChanged.Connect(inputObj => {
	if (inputObj.UserInputType === Enum.UserInputType.MouseMovement) {
		input.aimMode = "mouse";
	} else if (inputObj.UserInputType === Enum.UserInputType.Touch) {
		handleTouchMove(inputObj);
	} else if (inputObj.UserInputType.Name.sub(1, 7) === "Gamepad") {
		handleGamepadStick(inputObj);
	}
});

function handleGamepadStick(inputObj: InputObject): void {
	if (menuHasFocus()) return; // the menu's own navigation owns the sticks
	const k = inputObj.KeyCode;
	if (k === Enum.KeyCode.Thumbstick1) {
		const s = stickVector(inputObj.Position);
		gamepadMoveActive = s.mag > 0;
		if (gamepadMoveActive) {
			input.moveX = s.x;
			input.moveY = s.y;
			input.moveMagnitude = s.mag;
		} else if (!input.joystickActive) {
			input.moveX = 0;
			input.moveY = 0;
			input.moveMagnitude = 0;
		}
	} else if (k === Enum.KeyCode.Thumbstick2) {
		const s = stickVector(inputObj.Position);
		gamepadAimActive = s.mag > 0;
		if (!input.aimStickActive) input.aimMagnitude = s.mag;
		if (s.mag > 0) {
			// the pad aims like the touch pad: a direction, helped by the same light assist
			input.aimMode = "touch";
			const d = cam.screenDirToWorld(s.x, s.y);
			if (d.x * d.x + d.y * d.y > 1e-6) input.aimAngle = math.atan2(d.y, d.x);
		}
	}
}

// ---------------------------------------------------------------- touch

/** Touch positions come inset-relative; with IgnoreGuiInset=true GUI coords include the inset. */
function touchPos(t: InputObject): { x: number; y: number } {
	const [inset] = GuiService.GetGuiInset();
	return { x: t.Position.X + inset.X, y: t.Position.Y + inset.Y };
}

function startMove(t: InputObject, x: number, y: number): void {
	touchRoles.set(t, "move");
	moveFinger = t;
	input.joystickActive = true;
	// floating stick: the base appears under the thumb; fixed stick: the base stays at its home
	const baseX = layout.floating ? x : layout.move.homeX;
	const baseY = layout.floating ? y : layout.move.homeY;
	input.joystickBaseX = baseX;
	input.joystickBaseY = baseY;
	input.joystickX = x;
	input.joystickY = y;
	input.joystickRadius = layout.move.radius;
	applyMove(x, y);
}

function applyMove(x: number, y: number): void {
	const dx = x - input.joystickBaseX;
	const dy = y - input.joystickBaseY;
	const dist = math.sqrt(dx * dx + dy * dy);
	const dead = layout.move.dead;
	if (dist <= dead) {
		input.moveMagnitude = 0;
		return;
	}
	// rescale past the dead zone so the very first millimetre of travel already walks
	const travel = math.max(layout.move.radius - dead, 1);
	input.moveMagnitude = math.min((dist - dead) / travel, 1);
	input.moveX = dx / dist;
	input.moveY = dy / dist;
}

function startAim(t: InputObject, x: number, y: number): void {
	touchRoles.set(t, "aim");
	aimFinger = t;
	aimHoldStart = os.clock();
	aimHoldArmed = false;
	input.aimMode = "touch";
	input.aimStickActive = true;
	input.aimDragActive = true;
	// the pad always opens under the thumb: the survivor aims relative to where the gesture started
	input.aimStickBaseX = x;
	input.aimStickBaseY = y;
	input.aimStickX = x;
	input.aimStickY = y;
	input.aimDragLastX = x;
	input.aimDragLastY = y;
	input.aimMagnitude = 0;
}

function applyAim(x: number, y: number): void {
	input.aimStickX = x;
	input.aimStickY = y;
	input.aimDragLastX = x;
	input.aimDragLastY = y;
	const dx = x - input.aimStickBaseX;
	const dy = y - input.aimStickBaseY;
	const dist = math.sqrt(dx * dx + dy * dy);
	if (dist <= layout.aim.dead) return;
	input.aimMagnitude = math.min(dist / math.max(layout.aim.radius, 1), 1);
	// screen direction → world direction (the top-down camera may be rotated)
	const d = cam.screenDirToWorld(dx / dist, dy / dist);
	if (d.x * d.x + d.y * d.y > 1e-6) input.aimAngle = math.atan2(d.y, d.x);
}

function handleTouchBegin(t: InputObject): void {
	// on a touch screen GetMouseLocation() is the last finger (e.g. the fire button): never aim with it
	input.aimMode = "touch";
	const pos = touchPos(t);
	if (onMoveSide(layout, pos.x)) {
		if (moveFinger !== undefined) return; // a second finger on the move half is not a second stick
		if (!layout.floating) {
			const dx = pos.x - layout.move.homeX;
			const dy = pos.y - layout.move.homeY;
			// a fixed stick is only grabbed near its base: the rest of that half stays free
			if (dx * dx + dy * dy > layout.move.grabR * layout.move.grabR) return;
		}
		startMove(t, pos.x, pos.y);
		return;
	}
	if (aimFinger !== undefined) return;
	startAim(t, pos.x, pos.y);
}

function handleTouchMove(t: InputObject): void {
	const role = touchRoles.get(t);
	if (role === undefined) return;
	const pos = touchPos(t);
	if (role === "move") {
		input.joystickX = pos.x;
		input.joystickY = pos.y;
		applyMove(pos.x, pos.y);
	} else {
		applyAim(pos.x, pos.y);
	}
}

function handleTouchEnd(t: InputObject): void {
	const role = touchRoles.get(t);
	if (role === undefined) return;
	touchRoles.delete(t);
	if (role === "move") {
		if (moveFinger !== t) return;
		moveFinger = undefined;
		input.joystickActive = false;
		if (!gamepadMoveActive) {
			input.moveX = 0;
			input.moveY = 0;
			input.moveMagnitude = 0;
		}
		return;
	}
	if (aimFinger !== t) return;
	aimFinger = undefined;
	input.aimStickActive = false;
	input.aimDragActive = false;
	input.aimMagnitude = 0;
	if (aimHoldArmed) {
		aimHoldArmed = false;
		removeAttackSource();
	}
	// aimed, then let go: the shot every weapon understands
	tapAttack();
}

UserInputService.WindowFocusReleased.Connect(() => {
	input.keyW = false;
	input.keyA = false;
	input.keyS = false;
	input.keyD = false;
	input.keyShift = false;
	input.keyE = false;
	input.keyR = false;
	input.keyTab = false;
	input.keyEsc = false;
	input.keyScoreboard = false;
	input.joystickActive = false;
	input.moveX = 0;
	input.moveY = 0;
	input.moveMagnitude = 0;
	input.aimStickActive = false;
	input.aimDragActive = false;
	input.aimMagnitude = 0;
	if (input.attackHeld) {
		releaseAttack();
	}
	attackSources = 0;
	mouseDown = false;
	gamepadMoveActive = false;
	gamepadAimActive = false;
	gamepadAttackDown.clear();
	moveFinger = undefined;
	aimFinger = undefined;
	aimHoldArmed = false;
	touchRoles.clear();
});

export function syncKeyboardMove(): void {
	if (input.keyW || input.keyA || input.keyS || input.keyD) {
		let dx = 0;
		let dy = 0;
		if (input.keyD) dx += 1;
		if (input.keyA) dx -= 1;
		if (input.keyS) dy += 1;
		if (input.keyW) dy -= 1;
		const l = math.sqrt(dx * dx + dy * dy);
		if (l > 0) {
			input.moveX = dx / l;
			input.moveY = dy / l;
			input.moveMagnitude = 1;
		}
	} else if (!input.joystickActive && !gamepadMoveActive) {
		input.moveX = 0;
		input.moveY = 0;
		input.moveMagnitude = 0;
	}
}

export function getCtx(): GameContext {
	return ctx;
}

export function setPhase(p: GamePhase): void {
	ctx.phase = p;
	// MP-18: the chat bar follows the body -- on in the town (alive or waiting for daybreak), off everywhere else
	syncChatInput(p === "playing" || p === "dead", ctx.save.settings.langType);
}

export { RunService, releaseAttack, pressAttack };
print(`[${GAME_NAME}] client bootstrap OK`);
