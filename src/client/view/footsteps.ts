/*
 * When a survivor's foot lands.
 *
 * The walk cycle is the only thing in the client that knows: the feet are drawn at `sin(feetPhase) * 8 * amp`
 * (survivorView), so a foot is planted at each extreme of that sine — twice per full cycle, once per foot. The
 * local survivor's cycle is advanced by the simulation step, an ally's by the distance the interpolation moved
 * them (snapshotBuffer), and both land here, so a group's footsteps sound like a group walking.
 *
 * This file only reports the MOMENT. What is heard is the audio module's business, and it is attached with
 * `onFootstep` — one call, from wherever audio is started:
 *
 *   import { onFootstep } from "client/view/footsteps";
 *   onFootstep(playFootstep);            // (x, y, isLocalPlayer) => void
 *
 * Until something attaches, the detection runs and costs a floor() per survivor per frame. From F2 the footstep
 * becomes a server-side FxEvent (it is what the zombies hear, §3.4 and the "Cat" skill), and this file's job
 * shrinks to forwarding it — the sink signature does not change.
 */

/** (x, y) in world units; `isLocal` is true for the survivor this client steers */
export type FootstepSink = (x: number, y: number, isLocal: boolean) => void;

/**
 * Below this walk amplitude nothing is reported: a survivor easing out of a walk, or one being nudged by
 * knockback, is not taking steps, and the amplitude is exactly the number the feet are drawn with.
 */
const MIN_AMP = 0.35;

let sink: FootstepSink | undefined;

/** attach the listener (pass nothing to detach) */
export function onFootstep(fn?: FootstepSink): void {
	sink = fn;
}

/** is anything listening? (the caller can skip the bookkeeping entirely) */
export function footstepsWanted(): boolean {
	return sink !== undefined;
}

const HALF_UNSET = math.huge;

/** one survivor's cycle: give it the phase every frame, it calls the sink when a foot lands */
export class FootCycle {
	/** which half-cycle of the sine the phase was in last frame */
	private half = HALF_UNSET;

	/** a survivor who stopped walking starts a fresh cycle instead of reporting the gap */
	reset(): void {
		this.half = HALF_UNSET;
	}

	advance(phase: number, amp: number, x: number, y: number, isLocal: boolean): void {
		if (amp < MIN_AMP) {
			this.half = HALF_UNSET;
			return;
		}
		// the feet are at their extreme (and the other foot is planted) at phase = pi/2 + k*pi
		const half = math.floor((phase - math.pi / 2) / math.pi);
		if (this.half === HALF_UNSET) {
			this.half = half;
			return;
		}
		if (half === this.half) return;
		this.half = half;
		if (sink !== undefined) sink(x, y, isLocal);
	}
}
