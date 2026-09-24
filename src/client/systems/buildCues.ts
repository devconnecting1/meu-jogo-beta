/*
 * "A construction was set down" and "the red ghost refused the click": what the build sounds hang on
 * (client/audio/gameAudio.ts reads the two counts once a frame, like the pickups' in ./pickups.ts).
 *
 * Counts, not calls into the mixer: client/systems stays loadable by the Node suites, which have no SoundService, and
 * the audio stays the one reader. Pure: no Instances, no services.
 */

let placed = 0;
let refused = 0;

/** the click set the construction down (offline), or sent it to the server that places it (F3) */
export function notePlaced(): void {
	placed += 1;
}

/** the click landed on a ghost that cannot stand there (red): nothing was placed */
export function noteRefused(): void {
	refused += 1;
}

/** constructions set down so far, this session: a reader compares it with the value it last saw */
export function placedCount(): number {
	return placed;
}

/** refused clicks so far, this session */
export function refusedCount(): number {
	return refused;
}
