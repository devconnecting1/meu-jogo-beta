/*
 * Interest management: what each client is allowed to receive (docs/MULTIPLAYER.md §4.3, §4.4; MP-07).
 *
 * F1 only has survivors, so this file answers one question per pair of players: near ring, mid ring or out of
 * interest. F2 adds zombies, bosses and the visibility rules (inside a building, in the dark outside every
 * light) on top of exactly the same rings.
 *
 *   near  ≤ INTEREST_NEAR  (800 u)   → in every snapshot (SNAP_NEAR_HZ = 20 Hz)
 *   mid   ≤ INTEREST_MID   (1500 u)  → in every MID_DIVISOR-th snapshot (SNAP_MID_HZ = 10 Hz per entity)
 *   out   > INTEREST_EXIT  (1650 u)  → not sent; the hysteresis band keeps an entity that is hovering on the
 *                                      border from flickering in and out (and the client's despawn timeout of
 *                                      §4.4 covers the gap either way)
 *
 * Pure module: state is a small table keyed by (viewer, target), no Instances.
 */
import {
	INTEREST_EXIT,
	INTEREST_MID,
	INTEREST_NEAR,
	MAX_PLAYERS,
	SNAP_MID_EVERY_TICKS,
	SNAP_NEAR_EVERY_TICKS,
} from "shared/net/mpConfig";

export const Ring = {
	Out: 0,
	Mid: 1,
	Near: 2,
} as const;
export type Ring = (typeof Ring)[keyof typeof Ring];

const NEAR2 = INTEREST_NEAR * INTEREST_NEAR;
const MID2 = INTEREST_MID * INTEREST_MID;
const EXIT2 = INTEREST_EXIT * INTEREST_EXIT;

/** snapshots between two sends of the same mid-ring entity: 6/3 = 2 at 60 Hz, i.e. 20 Hz → 10 Hz (§4.1) */
export const MID_DIVISOR = math.max(1, math.floor(SNAP_MID_EVERY_TICKS / SNAP_NEAR_EVERY_TICKS + 0.5));

/** ring of a squared distance, given the ring it was in before (hysteresis on the way out only) */
export function ringOf(dist2: number, previous: Ring): Ring {
	if (dist2 <= NEAR2) return Ring.Near;
	if (dist2 <= MID2) return Ring.Mid;
	if (previous !== Ring.Out && dist2 <= EXIT2) return Ring.Mid;
	return Ring.Out;
}

export interface InterestEntry {
	slot: number;
	ring: Ring;
	dist2: number;
}

/**
 * Remembers the ring of every (viewer, target) pair so `ringOf` can apply its hysteresis. With MAX_PLAYERS = 6
 * that is at most 36 entries, so a flat map keyed by viewer × MAX_PLAYERS + target is the cheapest thing that
 * works (and it is what §4.3 needs per zombie in F2, where the same shape scales to the spatial hash).
 */
export class InterestTable {
	private readonly rings = new Map<number, Ring>();

	private static key(viewer: number, target: number): number {
		return viewer * MAX_PLAYERS + target;
	}

	ring(viewer: number, target: number): Ring {
		return this.rings.get(InterestTable.key(viewer, target)) ?? Ring.Out;
	}

	/** classifies one target for one viewer and stores the result */
	update(viewer: number, target: number, dx: number, dy: number): Ring {
		const key = InterestTable.key(viewer, target);
		const ring = ringOf(dx * dx + dy * dy, this.rings.get(key) ?? Ring.Out);
		if (ring === Ring.Out) this.rings.delete(key);
		else this.rings.set(key, ring);
		return ring;
	}

	/** drops every pair that mentions `slot` (the player left, or their slot was reused) */
	forget(slot: number): void {
		for (let other = 0; other < MAX_PLAYERS; other++) {
			this.rings.delete(InterestTable.key(slot, other));
			this.rings.delete(InterestTable.key(other, slot));
		}
	}

	clear(): void {
		this.rings.clear();
	}
}

export interface Positioned {
	slot: number;
	x: number;
	y: number;
}

/** every other survivor `viewer` has in interest, nearest first (the snapshot fills parts in priority order) */
export function classify(
	rings: InterestTable,
	viewer: Positioned,
	targets: ReadonlyArray<Positioned>,
): Array<InterestEntry> {
	const out = new Array<InterestEntry>();
	for (const t of targets) {
		if (t.slot === viewer.slot) continue;
		const dx = t.x - viewer.x;
		const dy = t.y - viewer.y;
		const ring = rings.update(viewer.slot, t.slot, dx, dy);
		if (ring === Ring.Out) continue;
		out.push({ slot: t.slot, ring, dist2: dx * dx + dy * dy });
	}
	out.sort((a, b) => a.dist2 < b.dist2);
	return out;
}

/**
 * Is this entry in THIS snapshot? Near ring: always (20 Hz). Mid ring: one snapshot out of MID_DIVISOR, spread
 * by slot so the mid-ring players of a given viewer do not all land on the same packet (§4.1 "em rodízio").
 */
export function inSnapshot(entry: InterestEntry, snapIndex: number): boolean {
	if (entry.ring === Ring.Near) return true;
	if (entry.ring === Ring.Out) return false;
	return (snapIndex + entry.slot) % MID_DIVISOR === 0;
}
