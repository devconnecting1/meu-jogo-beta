/*
 * Footsteps: the walk cycle's `onFootstep` sink (client/view/footsteps.ts).
 *
 * The view reports the MOMENT a foot lands, for the local survivor and for every ally the snapshot buffer
 * is interpolating. This module decides what that costs in sound. Three rules, all of them about the fact
 * that a footstep is the most repeated event in the game:
 *
 *  1. YOUR feet are not in the world. The local survivor sits exactly on the listener, so a panned voice
 *     would be dead centre at full level anyway; playing it flat (no position) is the same result without
 *     an emitter attachment, and it stays steady while the camera leads the aim. Allies ARE in the world:
 *     their steps are panned, which is how you hear someone coming up on your left.
 *  2. A footstep does not carry -- but the ENGINE is what shortens it, not this file. The catalogue entry
 *     carries `range: 900`, so the mixer gives the voice its own roll-off and the sound dies within a
 *     street. A curve applied here on top of the engine's would attenuate twice, and did: a step at 500 u
 *     came out at 0.44 where it should have been 0.59. Hearing a stranger's boots two blocks away would
 *     also be free information about where people are, which is the other half of why the range is short.
 *  3. Two takes alternate. One id at two steps per second reads as a metronome no matter how much the pitch
 *     wanders, and the pitch range in the catalogue is there to finish the job.
 *
 * From F2 the footstep also becomes an FxEvent (it is what the zombies hear, docs/MULTIPLAYER.md §3.4), and
 * this module does not change: it will be fed by the event channel instead of the view, with the same call.
 */
import { audio } from "./audio";

/** your own boots, a touch under an ally's: they are constant, and constant is what gets tiring */
const LOCAL_SCALE = 0.85;

/** left foot / right foot — alternates on every reported step, whoever took it */
let flip = false;

/**
 * One foot landed at (x, y). Safe to call for every survivor every frame: out-of-range steps return before
 * touching the mixer, and the catalogue caps how many footstep voices may overlap.
 */
export function playFootstep(x: number, y: number, isLocal: boolean): void {
	flip = !flip;
	const name = flip ? "footstepA" : "footstepB";

	if (isLocal) {
		// no position: flat voice, centred, no emitter (rule 1)
		audio.play(name, { scale: LOCAL_SCALE });
		return;
	}

	// no curve here: the entry's own range does it, once (rule 2)
	audio.play(name, { x, y });
}
