import { MP_PHASE } from "shared/net/mpConfig";
import { PaceDirector } from "shared/sim/ai/director";
import { Population } from "shared/sim/ai/population";
import { GameRefs } from "./types";
import { aiContext } from "./zombieAI";

/*
 * The client's side of the population (docs/MULTIPLAYER.md §3.5, §11.3 F2). Ambient walkers, specials, night
 * waves, ground items and the bosses are decided by shared/sim/ai/population.ts, which the server owns from
 * F2 on (server/sim/population.ts); this is the adapter that keeps the single-player world running until the
 * zombie replication of 2D lands.
 *
 * MP-09 (150 alive, nothing within 720 u of ANY survivor) is enforced in that shared module and only there.
 */

export class Spawner {
	private readonly population = new Population();

	/** peak → relief → build: scales the ambient quota and the spawn intervals, never the wave queues */
	readonly director: PaceDirector = this.population.director;

	update(refs: GameRefs, dt: number): void {
		if (MP_PHASE >= 2) return;
		this.population.update(aiContext(refs), dt);
	}
}
