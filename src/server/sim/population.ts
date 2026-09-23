import { PaceDirector } from "shared/sim/ai/director";
import { Population } from "shared/sim/ai/population";
import * as Ctx from "shared/sim/ai/context";

/*
 * The server's population (docs/MULTIPLAYER.md §3.5, §11.3 F2-2A).
 *
 * The decisions themselves — clusters, S(k), the day table, the pacing director and MP-09 — are the shared
 * ones (shared/sim/ai/population.ts), because the client still runs them while MP_PHASE < 2 and the two must
 * never drift. What belongs to the server is the bookkeeping around them: how many zombies are alive, how the
 * groups are scaled right now and what the director is doing, which the admin panel (§10) and the playtest
 * metrics (§12.2) read.
 */
export class ServerPopulation {
	private readonly population = new Population();
	/** zombies alive at the end of the last tick */
	alive = 0;
	/** how many appeared and how many left since boot (a cheap sanity line for a playtest) */
	spawned = 0;
	despawned = 0;

	/** peak → relief → build of the first cluster (§3.5): what the admin panel shows as "the" pacing */
	director(): PaceDirector {
		return this.population.director;
	}

	/** S(k) of every cluster of survivors right now, biggest group first is NOT guaranteed */
	scales(): Array<number> {
		return this.population.scales();
	}

	update(refs: Ctx.AiRefs, dt: number): void {
		const before = refs.zombies.size();
		this.population.update(refs, dt);
		const after = refs.zombies.size();
		if (after > before) this.spawned += after - before;
		else this.despawned += before - after;
		this.alive = after;
	}
}
