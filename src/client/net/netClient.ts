/*
 * Client side of the server-authoritative session (docs/MULTIPLAYER.md §2.2, §5).
 *
 * STUB — the F1 "client net" front fills this in. The API below is the contract the game loop already calls,
 * so the view and the network layer can land independently:
 *
 *   netActive()            is this client in a server-simulated session?
 *   netUpdate(refs, dt)    once per frame: sample input into 60 Hz commands, send them (with redundancy),
 *                          predict the local survivor into refs.player, reconcile with the last ack, and
 *                          advance the interpolation of everyone else
 *   remotePlayers()        the other survivors, interpolated for the current render time
 *
 * While MP_PHASE = 0 netActive() is false and the game loop keeps stepping the local player itself, so the
 * single-player build behaves exactly as before.
 */
import { GameRefs } from "../systems/types";
import { RemotePlayerView } from "./netTypes";

const NO_REMOTES: Array<RemotePlayerView> = [];

export function netActive(): boolean {
	return false;
}

export function netUpdate(_refs: GameRefs, _dt: number): void {
	// implemented by F1 (commands + prediction + reconciliation + snapshot interpolation)
}

export function remotePlayers(): ReadonlyArray<RemotePlayerView> {
	return NO_REMOTES;
}
