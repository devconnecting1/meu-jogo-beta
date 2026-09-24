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
	/**
	 * The world's ScreenGui (client/bootstrap.ts): the whole screen, non-interactive. `root` holds the world, the night
	 * (`darkLayer`), the plates over it and the town behind the menus (`backdropLayer`).
	 */
	screen: ScreenGui;
	root: Frame;
	/** the HUD's ScreenGui (the device safe area), holding `hudLayer` */
	hudGui: ScreenGui;
	hudLayer: Frame;
	worldLayer: Frame;
	/** the menus' ScreenGui (the device safe area), holding `uiLayer`; drawn only while something is on it */
	uiGui: ScreenGui;
	uiLayer: Frame;
	darkLayer: Frame;
	/** where the town behind the menus is pinned (UI-10, client/view/townFlyover.ts): the world's GUI, above the world */
	backdropLayer: Frame;
	cam: Camera;
	input: InputState;
	renderer: Renderer;
	save: PlayerSaveData;
	phase: GamePhase;
	viewW: number;
	viewH: number;
}
