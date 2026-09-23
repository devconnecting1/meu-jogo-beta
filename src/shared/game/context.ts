import { Camera } from "shared/engine/camera";
import { InputState } from "shared/engine/input";
import { Renderer } from "shared/engine/renderer";
import { PlayerSaveData } from "shared/game/save";

/**
 * Where the client is. There is no "paused": no screen opened over a run pauses the world (DESIGN_RULES UI-06),
 * so a run is "playing" (menus included) or "dead" until the player leaves it.
 */
export type GamePhase = "boot" | "lobby" | "shop" | "settings" | "credits" | "tutorial" | "playing" | "dead";

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
