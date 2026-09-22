import { Camera } from "shared/engine/camera";
import { InputState } from "shared/engine/input";
import { Renderer } from "shared/engine/renderer";
import { PlayerSaveData } from "shared/game/save";

export type GamePhase = "boot" | "lobby" | "shop" | "settings" | "credits" | "tutorial" | "playing" | "paused" | "dead";

export interface GameContext {
	playerGui: PlayerGui;
	screen: ScreenGui;
	root: Frame;
	hudLayer: Frame;
	worldLayer: Frame;
	uiLayer: Frame;
	darkLayer: Frame;
	cam: Camera;
	input: InputState;
	renderer: Renderer;
	save: PlayerSaveData;
	phase: GamePhase;
	viewW: number;
	viewH: number;
}
