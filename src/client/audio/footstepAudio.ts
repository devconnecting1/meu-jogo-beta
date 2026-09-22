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
 *  2. A footstep does not carry. The mixer is silent at AUDIO_RANGE (1600 u, ~29 m); boots on asphalt are
 *     gone long before that, so this module culls at FOOTSTEP_RANGE and fades over it. Hearing a stranger's
 *     steps across two blocks would also be free information about where people are.
 *  3. Two takes alternate. One id at two steps per second reads as a metronome no matter how much the pitch
 *     wanders, and the pitch range in the catalogue is there to finish the job.
 *
 * From F2 the footstep also becomes an FxEvent (it is what the zombies hear, docs/MULTIPLAYER.md §3.4), and
 * this module does not change: it will be fed by the event channel instead of the view, with the same call.
 */
import { audio } from "./audio";

/** past this many world units a footstep is not heard at all (the mixer's own range is 1600) */
const FOOTSTEP_RANGE = 900;

/** inside this radius an ally's step is at full level; beyond it the level falls to 0 at FOOTSTEP_RANGE */
const FOOTSTEP_NEAR = 220;

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

	const dist = audio.distanceToListener(x, y);
	if (dist >= FOOTSTEP_RANGE) return;
	// linear fade over the tail of the range, on top of the engine's own roll-off (rule 2)
	const near = 1 - math.clamp((dist - FOOTSTEP_NEAR) / (FOOTSTEP_RANGE - FOOTSTEP_NEAR), 0, 1);
	if (near <= 0.02) return;
	audio.play(name, { x, y, scale: near });
}
