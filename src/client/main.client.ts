import { GAME_NAME } from "shared/module";

const player = game.GetService("Players").LocalPlayer;
const playerGui = player.WaitForChild("PlayerGui") as PlayerGui;

const screenGui = new Instance("ScreenGui");
screenGui.Name = "GameGui";
screenGui.ResetOnSpawn = false;
screenGui.IgnoreGuiInset = true;
screenGui.DisplayOrder = 100;
screenGui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling;
screenGui.Parent = playerGui;

const root = new Instance("Frame");
root.Name = "Root";
root.Size = UDim2.fromScale(1, 1);
root.BackgroundColor3 = Color3.fromRGB(18, 18, 24);
root.BorderSizePixel = 0;
root.Parent = screenGui;

const label = new Instance("TextLabel");
label.Name = "Title";
label.Size = UDim2.fromScale(1, 0.1);
label.Position = UDim2.fromScale(0, 0.45);
label.BackgroundTransparency = 1;
label.Text = `${GAME_NAME} — fullscreen 2D boot OK`;
label.TextColor3 = Color3.fromRGB(230, 230, 230);
label.TextScaled = true;
label.Font = Enum.Font.GothamBold;
label.Parent = root;

print(`[${GAME_NAME}] client ready`);
