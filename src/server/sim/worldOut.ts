/*
 * The outbox for reliable world deltas (docs/MULTIPLAYER.md §4.5).
 *
 * The simulation must not know what a Player, a remote or an interest ring is — it is a pure module and stays
 * one (§3.1). But it is the only thing that KNOWS a door opened, and the door has to reach five other screens
 * within 200 ms (§11.3 F3 acceptance). So the simulation writes the fact here, and server/net/replication.ts
 * drains the queue once per tick, exactly the way it already drains the horde's deaths.
 *
 * Three audiences, because §4.5 has three:
 *   - GLOBAL (`queue`): constructions and doors. Everybody needs them, even out of sight, because everybody
 *     predicts movement against them — a door you are not told about is a wall you walk into.
 *   - DIRECTED (`queueFor`): one slot. Building loot flags (§4.3: only for whoever is inside).
 *   - NEAR (`queueNear`): a radius. Ground items at ITEM_INTEREST, solid HP. Cheap, and it also means a
 *     modified client cannot read a map of every drop in town.
 *
 * Ordering is preserved: the queue is one list, so an ItemAdd followed by its ItemRemove can never arrive the
 * other way round and leave a ghost item on a screen for ever. That is also why removal is never "silently
 * skip the add" — the pair is what the mirror replays.
 */
import { SLOT_NONE } from "shared/net/mpConfig";
import { WorldEvent } from "shared/net/protocol";

/** one queued delta and who it is for */
export interface PendingWorld {
	ev: WorldEvent;
	/** SLOT_NONE = every client in the world; otherwise only that slot */
	slot: number;
	/** > 0: only clients within this distance of (x, y); 0 = no distance filter */
	range: number;
	x: number;
	y: number;
}

/**
 * Everything produced in one tick, in the order it happened. The cap is a safety valve, not a budget: a
 * normal tick queues a handful of events, and a tick that somehow queued thousands (an admin clearing the
 * map, a bug) must drop them rather than build a 16 MB packet.
 */
export const WORLD_OUT_MAX = 4096;

export class WorldOut {
	/** events dropped because the queue was full; server/net/replication.ts folds this into its stats */
	dropped = 0;
	private readonly pending = new Array<PendingWorld>();

	/** §4.5 "Global": everybody, wherever they are */
	queue(ev: WorldEvent): void {
		this.push({ ev, slot: SLOT_NONE, range: 0, x: 0, y: 0 });
	}

	/** §4.5 "Só para quem está dentro": one slot and nobody else */
	queueFor(slot: number, ev: WorldEvent): void {
		this.push({ ev, slot, range: 0, x: 0, y: 0 });
	}

	/** §4.5 "Interesse": whoever is within `range` of (x, y) when the batch is flushed */
	queueNear(ev: WorldEvent, x: number, y: number, range: number): void {
		this.push({ ev, slot: SLOT_NONE, range: math.max(0, range), x, y });
	}

	/** moves everything queued into `out` (reused by the caller) and empties the queue */
	take(out: Array<PendingWorld>): Array<PendingWorld> {
		out.clear();
		for (const p of this.pending) out.push(p);
		this.pending.clear();
		return out;
	}

	size(): number {
		return this.pending.size();
	}

	clear(): void {
		this.pending.clear();
	}

	private push(p: PendingWorld): void {
		if (this.pending.size() >= WORLD_OUT_MAX) {
			this.dropped += 1;
			return;
		}
		this.pending.push(p);
	}
}
