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
 * This holds the drawing instead, on a hosted session only (offline and MP_PHASE 0 play as they always did): nothing is
 * drawn until the prediction has adopted a self block (`Prediction.placed`), and on that frame the camera is CUT onto the
 * survivor rather than eased there. The hold lasts one downstream trip and a snapshot interval (~60-150 ms), under the
 * backdrop colour of the canvas. If the server never answers (a broken session), it gives up after ENTRY_HOLD_MAX_S and
 * draws what the client has, as it did before.
 *
 * The same cut answers a TELEPORT in the middle of a run -- a daybreak or Rebirth stand-up at a safe point, an admin
 * moving the body, a kept body placed elsewhere: the prediction snaps past VISUAL_SNAP_DIST (`PredictionStats.snaps`) and
 * the camera goes with it, instead of panning across the town.
 *
 * Pure: no services, no Instances (tools/test-body.mjs 33 drives it with the real server and the real prediction).
 */

/** the longest the first frame waits for the server's position before drawing the client's own */
export const ENTRY_HOLD_MAX_S = 3;

export class EntryHold {
	private hold = false;
	private heldFor = 0;
	private snapsSeen = 0;
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
		this.snapsSeen = snaps;
	}

	/** is the drawing held (nothing of the run may be drawn this frame)? */
	holding(): boolean {
		return this.hold;
	}

	/**
	 * Once per frame, after the session's update wrote the survivor's position. `placed`: the prediction has adopted a
	 * self block since the run began (`Prediction.placed`); `snaps`: its snap count (`PredictionStats.snaps`). True when
	 * the camera must be cut onto the survivor THIS frame: the hold just ended, or the body jumped (a teleport).
	 */
	frame(dt: number, placed: boolean, snaps: number): boolean {
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
				this.snapsSeen = snaps;
				return true;
			}
			return false;
		}
		if (snaps !== this.snapsSeen) {
			this.snapsSeen = snaps;
			return true;
		}
		return false;
	}

	/** how the last hold went: frames held, and whether it ran out instead of being released by the server */
	lastHold(): { frames: number; gaveUp: boolean } {
		return { frames: this.heldFrames, gaveUp: this.gaveUp };
	}
}
