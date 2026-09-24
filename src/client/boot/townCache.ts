/*
 * The town's data, from the lobby to the match (docs/DESIGN_RULES.md UI-10, MP-22).
 *
 * The flyover behind the menus (client/view/townFlyover.ts) draws the REAL town the player is about to enter:
 * `generateTown` of the server's seed, built behind the logo (`prewarmTown`). Entering the city used to generate that
 * very town a second time (GameLoop.init) -- the biggest single piece of work of the click on "Enter the city" (the
 * server logs its own generation of a town this size at 100-250 ms, MP-22). Now the match TAKES the lobby's copy.
 *
 * Ownership, never sharing: the match mutates its town (solids added and removed, doors, damage, loot), and no menu may
 * ever draw a street the match changed. So a town has ONE owner at a time:
 *   - the cache (the menus) owns a town nobody has played in. The flyover only READS it: drawing it writes nothing but
 *     the spatial grid's query stamps (world.ts querySolids), bookkeeping that only grows and never changes what a
 *     query returns -- a town the flyover drew IS the town generateTown(seed) returns (npm run test:cache compares
 *     them field by field);
 *   - `takeTown` moves it to the match: the cache forgets it and a flyover still drawing it lets go (`onTownTaken`)
 *     BEFORE the match gets the reference. The next menu that needs a town generates a fresh one (`townFor`) -- so the
 *     generation moves from the click on "Enter the city" to the first menu after it, and never happens twice;
 *   - the seed is the key -- generateTown's only input -- so a new seed (MP-22's new town, or an InitBegin that corrects a
 *     guess) never gets the cached town, and a seed of 0 (a random town) is never cached. A fingerprint taken at
 *     generation (the map hash of §4.5 -- every solid's id and rect -- plus each solid's hp and door state, the ground
 *     items and the id counters) is checked again at the hand-over: a menus' copy that changed anyway is not handed
 *     over, the match generates its own (and the Output says so);
 *   - the cache holds at most one town, and a match start empties it either way.
 * The server generates its own towns (server/net/mpHost.ts, server/sim/worldReset.ts): nothing here reaches it.
 */
import { generateTown, WorldData } from "shared/game/world";

let cachedSeed = 0;
let cached: WorldData | undefined;
/** the cached town's fingerprint when it was generated */
let cachedPrint = "";
const takenHooks = new Array<(world: WorldData) => void>();

/** what the cache did this session (the tests, and the [PZ-LOAD] lines in the Output) */
export interface TownCacheStats {
	/** towns generated on this client (the menus' and the match's) */
	generated: number;
	/** towns the match took from the menus instead of generating them again */
	handedOver: number;
	/** milliseconds the last generation took */
	lastGenMs: number;
	/** menus' copies refused at the hand-over because they no longer matched their fingerprint */
	refused: number;
}

const stats: TownCacheStats = { generated: 0, handedOver: 0, lastGenMs: 0, refused: 0 };

const U32 = 4294967296;

/**
 * What a player could tell apart in two towns of one seed: the solids (the map hash of §4.5, server/net/replication.ts:
 * ids and rects), each one's hp and door state, the ground items and the id counters. O(solids), well under a
 * millisecond; the spatial grid's query stamps (bookkeeping, world.ts querySolids) are left out on purpose.
 */
export function townFingerprint(world: WorldData): string {
	let acc = world.solids.size() % U32;
	let state = 0;
	for (const s of world.solids) {
		const coords = math.floor(s.x) + math.floor(s.y) * 7 + math.floor(s.w) * 13 + math.floor(s.h) * 17;
		acc = (acc + ((s.id * coords) % U32)) % U32;
		state = (state + ((s.id * (math.floor(s.hp) * 3 + (s.open === true ? 1 : 0) + 1)) % U32)) % U32;
	}
	return `${world.solids.size()}:${acc}:${state}:${world.items.size()}:${world.nextId}:${world.nextDynamicId}`;
}

function generate(seed: number): WorldData {
	const t0 = os.clock();
	const world = generateTown(seed);
	stats.generated += 1;
	stats.lastGenMs = (os.clock() - t0) * 1000;
	return world;
}

/**
 * The town of `seed` for the menus: generated once and kept until a match takes it or another seed is asked for. The
 * caller only READS it (the flyover draws it; nothing may mutate it: that is the match's town, after `takeTown`).
 */
export function townFor(seed: number): WorldData {
	if (cached !== undefined && cachedSeed === seed && seed !== 0) return cached;
	const world = generate(seed);
	cached = seed !== 0 ? world : undefined;
	cachedSeed = seed !== 0 ? seed : 0;
	cachedPrint = seed !== 0 ? townFingerprint(world) : "";
	return world;
}

/** builds the menus' town now (behind the logo), so the first lobby does not stall on it */
export function prewarmTown(seed: number): void {
	townFor(seed);
}

/**
 * The match's town (GameLoop.init): the menus' copy of `seed` when it has one -- it moves to the match, and the
 * flyover drawing it lets go first -- or a new one. The cache is empty afterwards either way.
 */
export function takeTown(seed: number): WorldData {
	const world = cached;
	let hit = world !== undefined && seed !== 0 && cachedSeed === seed;
	if (hit && world !== undefined && townFingerprint(world) !== cachedPrint) {
		hit = false;
		stats.refused += 1;
		// the seed differs per town: the log line, not the Error Report's message (docs/ANALYTICS.md §10)
		warn("[PZ-LOAD] the lobby's copy of the town changed since it was generated; the match generates its own");
		print(`[PZ-LOAD] town ${seed}: the lobby's copy was refused`);
	}
	cached = undefined;
	cachedSeed = 0;
	cachedPrint = "";
	if (hit && world !== undefined) {
		for (const fn of takenHooks) fn(world);
		stats.handedOver += 1;
		print(`[PZ-LOAD] town ${seed}: taken from the lobby, not generated again (last generation ${fmtMs()})`);
		return world;
	}
	const fresh = generate(seed);
	print(`[PZ-LOAD] town ${seed}: generated for the match in ${fmtMs()}`);
	return fresh;
}

/** `fn` hears each town the match takes from the menus, before the match gets it (the flyover lets go of it there) */
export function onTownTaken(fn: (world: WorldData) => void): void {
	takenHooks.push(fn);
}

/** what the cache did this session */
export function townCacheStats(): Readonly<TownCacheStats> {
	return stats;
}

function fmtMs(): string {
	return `${math.floor(stats.lastGenMs + 0.5)} ms`;
}
