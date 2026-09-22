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

const player = Players.LocalPlayer;
const playerGui = player.WaitForChild("PlayerGui") as PlayerGui;

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
		viewportX = cam2.ViewportSize.X;
		viewportY = cam2.ViewportSize.Y;
	}
	ctx.viewW = viewportX;
	ctx.viewH = viewportY;
	cam.setView(viewportX, viewportY);
	renderer.setView(viewportX, viewportY);
	print(`[${GAME_NAME}] viewport ${viewportX}x${viewportY}`);
}

resize();

// --- input wiring ---
function pressAttack(): void {
	input.attackPressed = true;
	input.attackHeld = true;
}
function releaseAttack(): void {
	input.attackReleased = true;
	input.attackHeld = false;
}

UserInputService.InputBegan.Connect((inputObj, gpe) => {
	if (gpe) return;
	if (inputObj.UserInputType === Enum.UserInputType.MouseButton1) {
		pressAttack();
	} else if (inputObj.UserInputType === Enum.UserInputType.MouseButton2) {
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
		} else if (k === Enum.KeyCode.Tab) {
			input.keyTab = true;
			input.backpackPressed = true;
		} else if (k === Enum.KeyCode.Escape) {
			input.keyEsc = true;
			input.pausePressed = true;
		}
	} else if (inputObj.UserInputType === Enum.UserInputType.Touch) {
		handleTouchBegin(inputObj);
	}
});

UserInputService.InputEnded.Connect(inputObj => {
	if (inputObj.UserInputType === Enum.UserInputType.MouseButton1) {
		releaseAttack();
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
		handleTouchEnd();
	}
});

UserInputService.InputChanged.Connect(inputObj => {
	if (inputObj.UserInputType === Enum.UserInputType.MouseMovement) {
		const pos = inputObj.Position;
		const world = cam.screenToWorld(pos.X, pos.Y);
		input.aimAngle = math.atan2(world.y - cam.y, world.x - cam.x);
	} else if (inputObj.UserInputType === Enum.UserInputType.Touch) {
		handleTouchMove(inputObj);
	}
});

function handleTouchBegin(t: InputObject): void {
	const pos = t.Position;
	if (pos.X < ctx.viewW * 0.45 && !input.joystickActive) {
		input.joystickActive = true;
		input.joystickBaseX = pos.X;
		input.joystickBaseY = pos.Y;
		input.joystickX = pos.X;
		input.joystickY = pos.Y;
	} else {
		const rightZone = ctx.viewW * 0.55;
		if (pos.X >= rightZone) {
			if (pos.Y > ctx.viewH * 0.55) {
				pressAttack();
			} else {
				input.aimDragActive = true;
				input.aimDragLastX = pos.X;
				input.aimDragLastY = pos.Y;
			}
		} else {
			input.actionPressed = true;
		}
	}
}

function handleTouchMove(t: InputObject): void {
	const pos = t.Position;
	if (input.joystickActive) {
		input.joystickX = pos.X;
		input.joystickY = pos.Y;
		const dx = pos.X - input.joystickBaseX;
		const dy = pos.Y - input.joystickBaseY;
		const dist = math.sqrt(dx * dx + dy * dy);
		const ratio = math.min(dist / input.joystickRadius, 1);
		input.moveMagnitude = ratio;
		if (dist > 1) {
			input.moveX = dx / dist;
			input.moveY = dy / dist;
		}
	} else if (input.aimDragActive) {
		const dx = pos.X - input.aimDragLastX;
		const dy = pos.Y - input.aimDragLastY;
		input.aimAngle += (dx + dy) * 0.01;
		input.aimDragLastX = pos.X;
		input.aimDragLastY = pos.Y;
	}
}

function handleTouchEnd(): void {
	if (input.joystickActive) {
		input.joystickActive = false;
		input.moveX = 0;
		input.moveY = 0;
		input.moveMagnitude = 0;
	}
	if (input.aimDragActive) {
		input.aimDragActive = false;
	}
	if (input.attackHeld) {
		releaseAttack();
	}
}

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
