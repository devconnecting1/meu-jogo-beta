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
	/** what they wear (OutfitLook) and what follows them (PetLook), MON-04; 0 = none */
	outfit: number;
	pet: number;
	/**
	 * the title under their name (MON-05) as the wire byte (`titleToWire`: 0 = none) -- only ever one the server says
	 * they earned
	 */
	title: number;
	x: number;
	y: number;
	/** facing/aim in radians (world frame) */
	angle: number;
	hp: number;
	hpMax: number;
	/** downed survivors crawl and show the revive ring (MP-03) */
	downed: boolean;
	/**
	 * Dead (the reliable LifeState, §7.3): a body carries no light (shared/sim/survivorLight.ts `carriesLight`). The
	 * list the network layer hands over leaves the dead out today, so this is false in it; it is the field the rule
	 * reads, not a second place that decides it.
	 */
	dead: boolean;
	/**
	 * They carry a flashlight: the server's `PlayerFlag.Flashlight` (§4.2), set from the rule the horde's visibility
	 * lights with (`survivorCone`). The view draws its cone along `angle` (LUZ-04).
	 */
	flashlight: boolean;
	/** equipped weapon id, so the view draws the right thing in their hands */
	weaponId: number;
	/** walk-cycle phase for the feet, advanced from the interpolated speed */
	feetCycle: number;
	/**
	 * A melee sweep is in progress, and the blade angle relative to the aim.
	 *
	 * Both ride the snapshot already (PlayerFlag.Swinging and the `swing` field of §4.2) -- they were simply
	 * not carried this last step, so every ally swung invisibly: the attack animation played only on the
	 * screen of whoever pressed the button.
	 */
	swinging: boolean;
	swing: number;
	/**
	 * (VEI-05) The VehicleKind they ride (0 on foot) and where it points, radians: the view draws the bicycle or the
	 * motorcycle under them and the rider on it (client/view/vehicleView.ts). Both ride the snapshot (§4.2).
	 */
	ride: number;
	rideHeading: number;
}

/** true once the client is in a server-simulated session (MP_PHASE >= 1 and the handshake is done) */
export type NetActive = () => boolean;
