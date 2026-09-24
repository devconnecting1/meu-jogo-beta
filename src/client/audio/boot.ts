/*
 * The client's audio, started in one call from main.client.ts (which is close to Luau's 200-locals budget: one import
 * instead of four).
 *
 *   - the mixer boots with the client and reads the Settings sliders straight from the save, so it follows a LoadAck
 *     that swaps `ctx.save`;
 *   - the interface is heard by watching the HUD and menu layers (./uiAudio.ts);
 *   - the network is HANDED IN (./gameAudio.ts `AudioNet`): the audio never imports client/net/netClient.ts, whose
 *     import chain runs client/bootstrap.ts's module-level side effects in every suite that loads the view;
 *   - the walk cycle only reports the moment a foot lands (client/view/footsteps.ts); from here on it is heard.
 */
import type { GameContext } from "shared/game/context";
import { onFootstep } from "../view/footsteps";
import { audio } from "./audio";
import { playFootstep } from "./footstepAudio";
import { AudioNet, setAudioNet } from "./gameAudio";
import { startUiAudio } from "./uiAudio";

export function startAudio(ctx: GameContext, net: AudioNet): void {
	audio.start();
	audio.bindSettings(() => ctx.save.settings);
	startUiAudio(ctx);
	setAudioNet(net);
	onFootstep(playFootstep);
}
