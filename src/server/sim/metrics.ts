/*
 * The measuring vocabulary of the server tick (docs/MULTIPLAYER.md §12.2). SERVER ONLY, and pure: the simulation
 * modules are handed a clock and a profiler instead of calling os.clock or debug.profilebegin themselves, so the
 * Node suites run them untouched and the live host (server/net/mpHost.ts) plugs the real ones in.
 */

/**
 * Labels for the MicroProfiler: server/net/mpHost.ts maps these onto `debug.profilebegin` / `debug.profileend`, so
 * every phase of the tick is a named bar in the Server MicroProfiler (create.roblox.com/docs/performance-optimization/
 * microprofiler). Labels are constant strings (no allocation per tick), and every `begin` has its `end` on the same
 * path; the host closes whatever an error left open.
 */
export interface SimProfiler {
	begin(label: string): void;
	end(): void;
}

/**
 * The phases of one tick, in the order `ServerSimulation.step` runs them (§3.1): the survivors, the horde's own
 * phases (ZombieWorld.cost: clock and waves, population, flow field, zombies, bosses, bookkeeping), the projectiles,
 * the turrets, the interactive world, the combat's history and the replication.
 */
export const SIM_PHASES = [
	"players",
	"clock",
	"population",
	"field",
	"zombies",
	"bosses",
	"book",
	"projectiles",
	"turrets",
	"world",
	"combat",
	"replication",
] as const;
export type SimPhase = (typeof SIM_PHASES)[number];

/** milliseconds per phase (of one tick, or averaged per tick over a window) */
export type PhaseCosts = Record<SimPhase, number>;

export function newPhaseCosts(): PhaseCosts {
	return {
		players: 0,
		clock: 0,
		population: 0,
		field: 0,
		zombies: 0,
		bosses: 0,
		book: 0,
		projectiles: 0,
		turrets: 0,
		world: 0,
		combat: 0,
		replication: 0,
	};
}
