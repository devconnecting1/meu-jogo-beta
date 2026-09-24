/*
 * The first frame of a run is drawn where the SERVER put the survivor (docs/MULTIPLAYER.md §7.1 step 6; the owner's report
 * of 2026-09-24: "entering the world, the player spawns in one place, and a few ms later appears in another").
 *
 * Where a survivor enters is the server's to decide (§7.1 step 4, server/sim/life.ts): the safe spawn point, the body it
 * kept, the corpse waiting for daybreak. The client cannot know it before the server says so, and it used to draw a guess
 * in the meantime: `GameLoop.init` put the survivor on a street of its own choosing (a random one near the centre), the
 * camera on top, and drew that -- even simulated it offline while the handshake was pending -- until the first self block
 * moved the body to the server's spot: a snap past VISUAL_SNAP_DIST, an ease inside it, and the camera sliding across the
 * town after it for half a second.
 *
 * This holds the drawing instead, on a hosted session only (offline and MP_PHASE 0 play as they always did): nothing of
 * the run is drawn -- the world, the night's light map, the zombies' marks, the plates, the chat bubbles -- until the
 * prediction has adopted a self block (`Prediction.placed`), and on that frame the camera is CUT onto the survivor rather
 * than eased there. The hold lasts one downstream trip and a snapshot interval (~60-150 ms), under the backdrop colour of
 * the canvas. If the server never answers (a broken session), it gives up after ENTRY_HOLD_MAX_S and draws what the
 * client has, as it did before -- and when the server's position does arrive after that, the camera is cut to it once
 * (the review of 577c729, L6), as it would have been.
 *
 * The same cut answers a TELEPORT in the middle of a run -- a daybreak or Rebirth stand-up at a safe point, an admin
 * moving the body, a kept body placed elsewhere -- but only a real one (L5): the prediction snapped the body past
 * VISUAL_SNAP_DIST (`PredictionStats.snaps`) AND the new spot is off the screen or TELEPORT_CUT_U from the camera. A
 * nearer correction (a knockback the prediction missed, a door) keeps the camera's ease, as it always had.
 *
 * Pure: no services, no Instances (tools/test-body.mjs 33 drives it with the real server and the real prediction).
 */

/** the longest the first frame waits for the server's position before drawing the client's own */
export const ENTRY_HOLD_MAX_S = 3;
/** a snapped body this far from the camera (or off its screen) is a teleport: the camera is cut, not eased (L5) */
export const TELEPORT_CUT_U = 500;

/** is a body at (dx, dy) from the camera's centre a teleport's distance away, for a screen of half-size halfW × halfH? */
export function isTeleportCut(dx: number, dy: number, halfW: number, halfH: number): boolean {
	if (math.abs(dx) > halfW || math.abs(dy) > halfH) return true;
	return dx * dx + dy * dy > TELEPORT_CUT_U * TELEPORT_CUT_U;
}

export class EntryHold {
	private hold = false;
	private heldFor = 0;
	private snapsSeen = 0;
	/** the hold gave up before the server's position came: the first one to arrive is cut to, once (L6) */
	private awaitingPlace = false;
	/** frames the last hold lasted, and whether it ended by giving up (for the log and the tests) */
	private heldFrames = 0;
	private gaveUp = false;

	/**
	 * A run starts (a new world, a new body): hold the drawing on a `hosted` session until the server has placed the
	 * survivor. `snaps` is the prediction's snap count now, so only a later one reads as a teleport.
	 */
	begin(hosted: boolean, snaps = 0): void {
		this.hold = hosted;
		this.heldFor = 0;
		this.heldFrames = 0;
		this.gaveUp = false;
		this.awaitingPlace = false;
		this.snapsSeen = snaps;
	}

	/** is the drawing held (nothing of the run may be drawn this frame)? */
	holding(): boolean {
		return this.hold;
	}

	/**
	 * Once per frame, after the session's update wrote the survivor's position. `placed`: the prediction has adopted a
	 * self block since the run began (`Prediction.placed`); `snaps`: its snap count (`PredictionStats.snaps`); `dx, dy`:
	 * the survivor's drawn position minus the camera's centre, before this frame moves the camera; `halfW, halfH`: half
	 * the screen, in world units. True when the camera must be CUT onto the survivor this frame: the hold ended, the
	 * server's position arrived after a give-up, or the body was put somewhere far (a teleport).
	 */
	frame(dt: number, placed: boolean, snaps: number, dx = 0, dy = 0, halfW = math.huge, halfH = math.huge): boolean {
		if (this.hold) {
			this.heldFor += math.max(0, dt);
			this.heldFrames += 1;
			if (placed) {
				this.hold = false;
				this.snapsSeen = snaps;
				return true;
			}
			if (this.heldFor >= ENTRY_HOLD_MAX_S) {
				this.hold = false;
				this.gaveUp = true;
				this.awaitingPlace = true;
				this.snapsSeen = snaps;
				return true;
			}
			return false;
		}
		if (this.awaitingPlace && placed) {
			// L6: the drawing went on from the client's own guess; the server's spot is where the camera belongs now
			this.awaitingPlace = false;
			this.snapsSeen = snaps;
			return true;
		}
		if (snaps !== this.snapsSeen) {
			this.snapsSeen = snaps;
			return isTeleportCut(dx, dy, halfW, halfH);
		}
		return false;
	}

	/** how the last hold went: frames held, and whether it ran out instead of being released by the server */
	lastHold(): { frames: number; gaveUp: boolean } {
		return { frames: this.heldFrames, gaveUp: this.gaveUp };
	}
}
