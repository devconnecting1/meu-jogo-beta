/*
 * FxEvent -> sound.
 *
 * `refs.fx` is the simulation's cosmetic channel (docs/MULTIPLAYER.md §4.1). The view already turns those
 * events into particles, camera shake and HUD messages; this module turns the same events into sound, so
 * audio needs no new plumbing in the systems.
 *
 * Two modes, because of WHERE the events can be read today:
 *  - "leftover" (default): `GameLoop.playFx` consumes and CLEARS `refs.fx` at the end of `update()`, so a
 *    reader outside the loop only ever sees events pushed after that point (crafting from the backpack,
 *    admin tools, interaction). In this mode only `debris` is played from the channel; shots, flesh hits,
 *    deaths and the player's own damage come from the state watcher in gameAudio.ts, which sees all of them.
 *  - "full": every event is played from the channel and gameAudio stops deriving them. Switch to this the
 *    day `GameLoop.playFx` calls `playFxEvent(e)` for each event (one line, see the report).
 *
 * `message` is never played here: HUD messages always reach the client through `refs.onMessage`, which is
 * where gameAudio listens for the wave / dawn stingers. Playing them here too would double every stinger.
 */
import type { FxEvent } from "shared/sim/types";
import type { SoundName } from "shared/data/sounds";
import { audio } from "./audio";

export type FxAudioMode = "leftover" | "full";

let mode: FxAudioMode = "leftover";

/** the local survivor's slot in refs.players (F0: always 0) */
let localSlot = 0;

export function setFxAudioMode(value: FxAudioMode): void {
	mode = value;
}

export function fxAudioMode(): FxAudioMode {
	return mode;
}

export function setFxAudioLocalSlot(slot: number): void {
	localSlot = slot;
}

/** what a debris burst is made of -> which impact is heard */
function debrisSound(material: string): SoundName | undefined {
	if (material === "tree" || material === "structure") return "debrisWood";
	if (material === "car" || material === "boss" || material === "impact") return "debrisMetal";
	if (material === "exploder") return "explosion";
	return undefined;
}

/**
 * Plays one cosmetic event. Safe to call for every event of `refs.fx`: entries with an empty slot in the
 * catalogue and events that belong to another survivor are ignored.
 */
export function playFxEvent(e: FxEvent): void {
	if (e.kind === "debris") {
		const name = debrisSound(e.material);
		// a bigger burst is a heavier impact, but never louder than the burst that earns it
		if (name !== undefined) audio.play(name, { x: e.x, y: e.y, scale: math.clamp(e.count / 6, 0.4, 1) });
		return;
	}
	if (mode !== "full") return;
	if (e.kind === "blood") {
		if (e.source === "player") audio.play("playerHurt");
		else audio.play("hitFlesh", { x: e.x, y: e.y, scale: math.clamp(e.count / 8, 0.5, 1) });
		return;
	}
	if (e.kind === "tracer") {
		// "bullet" / "boss" lines carry no weapon kind: the shot itself is played by the weapon watcher
		if (e.tracer === "electric") audio.play("shotElectric", { x: e.x1, y: e.y1 });
		return;
	}
	if (e.kind === "shake") {
		// shake is purely visual; a blast that deserves a sound already pushes its own debris/blood
		if (e.player !== localSlot) return;
	}
}

/**
 * Reads (without clearing) every event still queued in `refs.fx` and plays its sound. Call it once per
 * frame, right before `GameLoop.render()` — render's own `playFx` clears the list straight after, so no
 * event is ever heard twice.
 */
export function drainFxAudio(fx: ReadonlyArray<FxEvent>): void {
	for (const e of fx) playFxEvent(e);
}
