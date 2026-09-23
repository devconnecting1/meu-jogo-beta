/*
 * Contract between the client's network layer (F1 1B: commands, prediction, snapshot buffer) and the view
 * (F1 1C: gameLoop / playersView). docs/MULTIPLAYER.md §5.
 *
 * The seam is deliberately small: the view never touches remotes or buffers, and the network layer never
 * touches Instances. `netUpdate` is the only thing the frame loop calls; everything else is a read.
 */

/** another survivor as the view should draw them right now (already interpolated for the render time) */
export interface RemotePlayerView {
	/** Players.UserId — stable id of the entity across snapshots */
	userId: number;
	/**
	 * Their player slot, 0..MAX_PLAYERS-1 (§4.4). The view pools plates and bodies by userId, which is what
	 * survives a slot being freed and handed to somebody else; the SLOT is what the binary channels address
	 * a survivor by (§4.2's `Shot`, §4.2's `Shake`), so a view that has to resolve "who fired this" needs
	 * both. Without it a received shot can only draw its impacts and no line.
	 */
	slot: number;
	/** what the nameplate shows */
	displayName: string;
	level: number;
	x: number;
	y: number;
	/** facing/aim in radians (world frame) */
	angle: number;
	hp: number;
	hpMax: number;
	/** downed survivors crawl and show the revive ring (MP-03) */
	downed: boolean;
	/** equipped weapon id, so the view draws the right thing in their hands */
	weaponId: number;
	/** walk-cycle phase for the feet, advanced from the interpolated speed */
	feetCycle: number;
}

/** true once the client is in a server-simulated session (MP_PHASE >= 1 and the handshake is done) */
export type NetActive = () => boolean;
