import { GAME_NAME } from "shared/module";
import { Camera } from "shared/engine/camera";
import { InputState } from "shared/engine/input";
import { Renderer } from "shared/engine/renderer";
import { COLORS } from "shared/engine/colors";
import { defaultSave, PlayerSaveData } from "shared/game/save";
import { GameContext, GamePhase } from "shared/game/context";

const Players = game.GetService("Players");
const RunService = game.GetService("RunService");
const UserInputService = game.GetService("UserInputService");
const GuiService = game.GetService("GuiService");

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

const worldLayer = new Instance("Frame");
worldLayer.Name = "World";
worldLayer.Size = UDim2.fromScale(1, 1);
worldLayer.BackgroundTransparency = 1;
worldLayer.BorderSizePixel = 0;
worldLayer.ClipsDescendants = true;
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
	print(`[${GAME_NAME}] viewport ${viewportX}x${viewportY}`);
}

resize();
const bootCam = game.GetService("Workspace").CurrentCamera;
if (bootCam !== undefined) {
	bootCam.GetPropertyChangedSignal("ViewportSize").Connect(resize);
}
task.delay(1, resize);
task.delay(3, resize);

// --- input wiring ---
function pressAttack(): void {
	input.attackPressed = true;
	input.attackHeld = true;
}
function releaseAttack(): void {
	input.attackReleased = true;
	input.attackHeld = false;
}

// Several sources can hold the attack button at once (mouse + fire-zone fingers).
// pressAttack/releaseAttack only fire on the 0→1 / 1→0 transition of this counter.
let attackSources = 0;
function addAttackSource(): void {
	attackSources += 1;
	if (attackSources === 1) {
		pressAttack();
	}
}
function removeAttackSource(): void {
	if (attackSources <= 0) return;
	attackSources -= 1;
	if (attackSources === 0) {
		releaseAttack();
	}
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
const touchRoles = new Map<InputObject, "move" | "aim" | "fire" | "action">();

/**
 * Recomputes input.aimAngle from the live mouse position every frame (mouse mode only;
 * touch mode is driven by the aim stick in handleTouchMove). Called by the combat system
 * with the player's world position. Returns the resulting aim angle.
 */
export function refreshAim(px: number, py: number): number {
	if (input.aimMode === "touch") {
		// no aim stick held: face where the survivor walks (twin-stick fallback)
		if (!input.aimStickActive && input.moveMagnitude > 0.2) {
			const d = cam.screenDirToWorld(input.moveX, input.moveY);
			if (d.x * d.x + d.y * d.y > 1e-6) input.aimAngle = math.atan2(d.y, d.x);
		}
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
		} else {
			const slot = WEAPON_KEYS.indexOf(k);
			if (slot >= 0) input.weaponSlotPressed = slot;
		}
	} else if (inputObj.UserInputType === Enum.UserInputType.Touch) {
		handleTouchBegin(inputObj);
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
	} else if (inputObj.UserInputType === Enum.UserInputType.Touch) {
		handleTouchEnd(inputObj);
	}
});

UserInputService.InputChanged.Connect(inputObj => {
	if (inputObj.UserInputType === Enum.UserInputType.MouseMovement) {
		input.aimMode = "mouse";
	} else if (inputObj.UserInputType === Enum.UserInputType.Touch) {
		handleTouchMove(inputObj);
	}
});

/** Touch positions come inset-relative; with IgnoreGuiInset=true GUI coords include the inset. */
function touchPos(t: InputObject): { x: number; y: number } {
	const [inset] = GuiService.GetGuiInset();
	return { x: t.Position.X + inset.X, y: t.Position.Y + inset.Y };
}

function handleTouchBegin(t: InputObject): void {
	// on a touch screen GetMouseLocation() is the last finger (e.g. the fire button): never aim with it
	input.aimMode = "touch";
	const pos = touchPos(t);
	if (pos.x < ctx.viewW * 0.45 && !input.joystickActive) {
		touchRoles.set(t, "move");
		input.joystickActive = true;
		input.joystickBaseX = pos.x;
		input.joystickBaseY = pos.y;
		input.joystickX = pos.x;
		input.joystickY = pos.y;
	} else {
		const rightZone = ctx.viewW * 0.55;
		if (pos.x >= rightZone) {
			if (pos.y > ctx.viewH * 0.55) {
				touchRoles.set(t, "fire");
				addAttackSource();
			} else {
				touchRoles.set(t, "aim");
				input.aimMode = "touch";
				input.aimStickActive = true;
				input.aimDragActive = true;
				input.aimStickBaseX = pos.x;
				input.aimStickBaseY = pos.y;
				input.aimStickX = pos.x;
				input.aimStickY = pos.y;
				input.aimDragLastX = pos.x;
				input.aimDragLastY = pos.y;
			}
		} else {
			touchRoles.set(t, "action");
			input.actionPressed = true;
		}
	}
}

function handleTouchMove(t: InputObject): void {
	const role = touchRoles.get(t);
	if (role === undefined) return;
	const pos = touchPos(t);
	if (role === "move") {
		input.joystickX = pos.x;
		input.joystickY = pos.y;
		const dx = pos.x - input.joystickBaseX;
		const dy = pos.y - input.joystickBaseY;
		const dist = math.sqrt(dx * dx + dy * dy);
		const ratio = math.min(dist / input.joystickRadius, 1);
		input.moveMagnitude = ratio;
		if (dist > 1) {
			input.moveX = dx / dist;
			input.moveY = dy / dist;
		}
	} else if (role === "aim") {
		input.aimStickX = pos.x;
		input.aimStickY = pos.y;
		const dx = pos.x - input.aimStickBaseX;
		const dy = pos.y - input.aimStickBaseY;
		const dist = math.sqrt(dx * dx + dy * dy);
		if (dist > 12) {
			const a = cam.screenToWorld(input.aimStickBaseX, input.aimStickBaseY);
			const b = cam.screenToWorld(pos.x, pos.y);
			input.aimAngle = math.atan2(b.y - a.y, b.x - a.x);
		}
		input.aimDragLastX = pos.x;
		input.aimDragLastY = pos.y;
	}
}

function handleTouchEnd(t: InputObject): void {
	const role = touchRoles.get(t);
	if (role === undefined) return;
	touchRoles.delete(t);
	if (role === "move") {
		input.joystickActive = false;
		input.moveX = 0;
		input.moveY = 0;
		input.moveMagnitude = 0;
	} else if (role === "aim") {
		input.aimStickActive = false;
		input.aimDragActive = false;
	} else if (role === "fire") {
		removeAttackSource();
	}
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
	input.joystickActive = false;
	input.moveX = 0;
	input.moveY = 0;
	input.moveMagnitude = 0;
	input.aimStickActive = false;
	input.aimDragActive = false;
	if (input.attackHeld) {
		releaseAttack();
	}
	attackSources = 0;
	mouseDown = false;
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
	} else if (!input.joystickActive) {
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
}

export { RunService, releaseAttack, pressAttack };
print(`[${GAME_NAME}] client bootstrap OK`);
