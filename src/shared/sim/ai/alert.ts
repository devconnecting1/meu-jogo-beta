/*
 * Group alert: a zombie that spots a survivor shouts, and the ones around it come (docs/DESIGN_RULES.md P2).
 *
 * The original has nothing like it. `detect` is an instance variable and NO code ever writes another
 * instance's `detect` (the only mass write is the 7:00 reset in sys_spawn_time_light). The night horde looks
 * coordinated only because every zombie independently reads the same clock — it is a coincidence, not a pack.
 *
 * Here the shout is a real stimulus with a budget, so it can never turn into a chain reaction across the map:
 *   - only a zombie that perceived the survivor with its OWN senses shouts, and only if its shout cooldown is
 *     up (ALERT_COOLDOWN);
 *   - one shout wakes at most ALERT_MAX_WAKE zombies, the nearest first;
 *   - everyone woken also gets the cooldown, so the ones just alerted cannot relay it;
 *   - the caller runs at most ALERT_SHOUTS_PER_TICK shouts per tick.
 * Woken zombies are told WHERE the shouter saw the survivor (memory.report), so they converge on that place
 * and search it — they do not magically learn where the survivor is now.
 *
 * Pure: a list of positions in, a list of indices out. No world, no Instances (docs/MULTIPLAYER.md §11.2).
 */

/** what the propagation needs to know about a zombie (ZombieState satisfies it structurally) */
export interface AlertUnit {
	id: number;
	x: number;
	y: number;
	hp: number;
	detect: boolean;
	/** seconds until this zombie may shout again */
	alertCd?: number;
}

/** how far a shout carries (~7.6 m: a scream down a street, not across the city) */
export const ALERT_RADIUS = 420;
/** at most this many zombies answer one shout */
export const ALERT_MAX_WAKE = 6;
/** a zombie that shouted (or was woken by a shout) stays quiet for this long */
export const ALERT_COOLDOWN = 9;
/** seconds the shout lasts for the view (bigger "!", a roar when the audio owner hooks it up) */
export const ALERT_SHOUT_TIME = 0.9;
/** hard ceiling of shouts resolved in one AI tick, so a crowd cannot spike the CPU */
export const ALERT_SHOUTS_PER_TICK = 2;

/**
 * Which units hear a shout at (x, y): indices into `units`, nearest first, at most `maxWake`.
 * Skips the dead, the ones already hunting and `shouterId` itself. Ties break by id, so the result does not
 * depend on the order the array happens to be in.
 */
export function hearers(
	units: ReadonlyArray<AlertUnit>,
	x: number,
	y: number,
	shouterId: number,
	out: Array<number>,
	radius = ALERT_RADIUS,
	maxWake = ALERT_MAX_WAKE,
): number {
	out.clear();
	const dists: Array<number> = [];
	const r2 = radius * radius;
	for (let i = 0; i < units.size(); i++) {
		const u = units[i];
		if (u.id === shouterId || u.hp <= 0 || u.detect) continue;
		const dx = u.x - x;
		const dy = u.y - y;
		const d2 = dx * dx + dy * dy;
		if (d2 > r2) continue;
		// bounded insertion: at most maxWake entries are ever kept
		let slot = out.size();
		while (slot > 0) {
			const prev = dists[slot - 1];
			if (prev < d2 || (prev === d2 && units[out[slot - 1]].id < u.id)) break;
			slot--;
		}
		if (slot >= maxWake) continue;
		out.insert(slot, i);
		dists.insert(slot, d2);
		if (out.size() > maxWake) {
			out.pop();
			dists.pop();
		}
	}
	return out.size();
}
