import { PaceDirector } from "shared/sim/ai/director";
import { Population, PopulationStall } from "shared/sim/ai/population";
import * as Ctx from "shared/sim/ai/context";
import { WaveFill } from "./waves";

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

	/** ΣS(k) applied to the last night's promise (1 = the original's numbers) */
	lastPromise = 1;

	/** peak → relief → build of the first cluster (§3.5): what the admin panel shows as "the" pacing */
	director(): PaceDirector {
		return this.population.director;
	}

	/** S(k) of every cluster of survivors right now, biggest group first is NOT guaranteed */
	scales(): Array<number> {
		return this.population.scales();
	}

	/** MP-21's own counter (shared/sim/ai/population.ts `PopulationStall`): survivors present, none standing */
	stall(): PopulationStall {
		return this.population.stall;
	}

	/**
	 * The night's promised headcount, rationed across the groups that exist when dusk falls (§3.5).
	 *
	 * The clock decides the total once, from the original's day table, and it decides it for ONE group:
	 * `waveQueues` holds the numbers at S(1) = 1. But a party that splits into three corners of the town is
	 * three fronts the horde has to cover, so the promise scales with the sum of S(k). Without this, the more
	 * people played together the emptier the night would feel, which is backwards for a survival game.
	 *
	 * It scales the queues the clock owns instead of keeping a queue per cluster, for two reasons: the pacing
	 * per cluster already lives in the drain (shared/sim/ai/population.ts), and MP-09's ceiling is enforced
	 * there too. So a bigger promise can never put more bodies on the map than the server allows -- it only
	 * means the queue takes longer to empty, which is exactly what "a longer night" should mean.
	 *
	 * Called from the clock's `onWaveFill` (server/sim/waves.ts), once per night, at dusk.
	 */
	split(fill: WaveFill, clock: Ctx.AiClock): void {
		let total = 0;
		for (const k of this.population.scales()) total += k;
		// nobody in the world yet, or one lone survivor: the original's numbers, untouched
		if (total <= 1) return;
		for (let i = 0; i < fill.walkers.size(); i++) {
			clock.waveQueues[i] = math.floor(fill.walkers[i] * total + 0.5);
			clock.specialWaveQueues[i] = math.floor(fill.specials[i] * total + 0.5);
		}
		this.lastPromise = total;
	}

	/**
	 * `n` of the day table at the groups' ΣS(k) right now, by `split`'s rule: what an admin's forced wave queues
	 * (server/admin/adminWorld.ts, §10), so a forced wave 2 or 3 is as big as the natural one would be.
	 */
	scaled(n: number): number {
		let total = 0;
		for (const k of this.population.scales()) total += k;
		return total <= 1 ? n : math.floor(n * total + 0.5);
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
