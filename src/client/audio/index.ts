/*
 * Client audio (docs/MULTIPLAYER.md §11.2: the audio is client-side and stays client-side).
 *
 *   audio        mixer: buses, voice pool, 2D spatialisation, preload
 *   gameAudio    run audio: what the world sounds like (state watcher + refs.fx drain + music)
 *   uiAudio      interface audio, wired by watching the HUD and menu layers
 *   fxAudio      FxEvent -> sound (ready for the one-line hook in GameLoop.playFx)
 *   footstepAudio the walk cycle sink: what a foot landing sounds like
 */
export { audio, AUDIO_RANGE, AudioTrack } from "./audio";
export type { PlayOptions } from "./audio";
export { gameAudio, GameAudio } from "./gameAudio";
export { GameMusic } from "./music";
export { previewBgm, previewSfx, startUiAudio } from "./uiAudio";
export { drainFxAudio, fxAudioMode, playFxEvent, setFxAudioLocalSlot, setFxAudioMode } from "./fxAudio";
export type { FxAudioMode } from "./fxAudio";
export { playFootstep } from "./footstepAudio";
