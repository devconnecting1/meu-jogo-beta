/*
 * The town's data, from the lobby to the match (docs/DESIGN_RULES.md UI-10, MP-22, MP-26).
 *
 * The flyover behind the menus (client/view/townFlyover.ts) draws the REAL town the player is about to enter:
 * `generateTown` of the SERVER's seed (client/boot/serverTown.ts: the Workspace attribute the server writes, heard the
 * moment the client joins). Entering the city used to generate that very town a second time (GameLoop.init) -- the
 * biggest single piece of work of the click on "Enter the city". Now the match TAKES the lobby's copy.
 *
 * A slice per frame (`requestTown`): a town is a second or more of Luau (the server logs its own at a world reset), and
 * generated in one go it froze the client -- behind the logo, on the way back to the lobby after every match, and in
 * the lobby when a world ended. Now the menus ask for it and it is built in a coroutine this module resumes once per
 * frame, a few milliseconds of work at a time (TOWN_SLICE_S with a town gliding on screen, TOWN_SLICE_IDLE_S with
 * nothing but the logo or the menus): `generateTown` calls `pace` between two lots and between two buildings'
 * interiors, and the coroutine yields there when the frame's share is spent. The town is the same one either way (the
 * seed is generateTown's only input; `pace` draws nothing from the town's RNG and touches none of it; npm run
 * test:seed compares the sliced town with the one-shot one, and with the server's, seed after seed). The flyover shows
 * the page colour (never a guessed town) until it is ready, then fades it in -- or, with a town already on screen,
 * cross-fades to it (a world that ended, MP-22).
 *
 * Ownership, never sharing: the match mutates its town (solids added and removed, doors, damage, loot), and no menu may
 * ever draw a street the match changed. So a town has ONE owner at a time:
 *   - the cache (the menus) owns a town nobody has played in. The flyover only READS it: drawing it writes nothing but
 *     the spatial grid's query stamps (world.ts querySolids), bookkeeping that only grows and never changes what a
 *     query returns -- a town the flyover drew IS the town generateTown(seed) returns (npm run test:cache compares
 *     them field by field);
 *   - `takeTown` moves it to the match: the cache forgets it and a flyover still drawing it lets go (`onTownTaken`)
 *     BEFORE the match gets the reference. A generation of that seed still under way is FINISHED there, in place
 *     (`rush`), not started over: the match never pays for a town twice. The next menu that needs a town generates a
 *     fresh one -- so the generation moves from the click on "Enter the city" to the first menu after it, and never
 *     happens twice;
 *   - the seed is the key -- generateTown's only input -- so a new seed (MP-22's new town) never gets the cached town,
 *     and a seed of 0 (a random town) is never cached. A fingerprint taken at generation (the map hash of §4.5 --
 *     every solid's id and rect -- plus each solid's hp and door state, the ground items and the id counters) is
 *     checked again at the hand-over: a menus' copy that changed anyway is not handed over, the match generates its
 *     own (and the Output says so);
 *   - the cache holds at most one town, plus at most one being generated; a match start empties both.
 * The server generates its own towns (server/net/mpHost.ts, server/sim/worldReset.ts): nothing here reaches it.
 */
import { generateTown, WorldData } from "shared/game/world";

const RunService = game.GetService("RunService");

/**
 * Seconds of generation per frame while a town glides on screen (the flyover draws in the same frame: MP-22's next
 * town being generated behind the old one), and while nothing does (the logo, or the menus over the page colour: the
 * frame has room, and the sooner the town is there the sooner the page lifts). A town is ~300 slices (lots and
 * buildings), so a desktop has it in a second or two and nothing ever stalls for it. One building's interior is planned
 * whole between two slices: a big one (a hospital) can go over, never by much.
 */
export const TOWN_SLICE_S = 0.004;
export const TOWN_SLICE_IDLE_S = 0.008;

/** is a town on screen right now (the flyover says: client/view/townFlyover.ts) */
let drawing: () => boolean = () => false;

/** the flyover tells the cache when a town is on screen, so a slice leaves room for its drawing */
export function onDrawingTown(fn: () => boolean): void {
	drawing = fn;
}

let cachedSeed = 0;
let cached: WorldData | undefined;
/** the cached town's fingerprint when it was generated */
let cachedPrint = "";
const takenHooks = new Array<(world: WorldData) => void>();

/** a town being generated a slice per frame */
interface Job {
	seed: number;
	co: thread;
	/** finish without yielding (`takeTown`, `townFor`: the town is wanted NOW) */
	rush: boolean;
	/** os.clock() when this frame's slice began, and how long this frame's slice may be */
	sliceAt: number;
	budget: number;
	/** frames it took, and seconds of work in them */
	frames: number;
	workS: number;
	world?: WorldData;
}
let job: Job | undefined;
let driver: RBXScriptConnection | undefined;
/** a seed whose paced generation threw: the menus do not ask for it again every frame (`townFor` still tries) */
let failedSeed = 0;

/** what the cache did this session (the tests, and the [PZ-LOAD] lines in the Output) */
export interface TownCacheStats {
	/** towns generated on this client (the menus' and the match's), whole or a slice per frame */
	generated: number;
	/** of those, generated a slice per frame (the menus' `requestTown`) */
	paced: number;
	/** generations given up before they finished (the menus wanted another seed, or a match started) */
	abandoned: number;
	/** generations finished at once because the town was wanted before its last slice (`takeTown`, `townFor`) */
	rushed: number;
	/** towns the match took from the menus instead of generating them again */
	handedOver: number;
	/** milliseconds the last generation took (its work, not the frames in between) */
	lastGenMs: number;
	/** frames the last paced generation was spread over */
	lastFrames: number;
	/** menus' copies refused at the hand-over because they no longer matched their fingerprint */
	refused: number;
}

const stats: TownCacheStats = {
	generated: 0,
	paced: 0,
	abandoned: 0,
	rushed: 0,
	handedOver: 0,
	lastGenMs: 0,
	lastFrames: 0,
	refused: 0,
};

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

/** `world` becomes the menus' town of `seed` */
function keep(seed: number, world: WorldData): void {
	cached = seed !== 0 ? world : undefined;
	cachedSeed = seed !== 0 ? seed : 0;
	cachedPrint = seed !== 0 ? townFingerprint(world) : "";
}

/** gives up the generation under way (its coroutine is simply never resumed again) */
function abandon(): void {
	if (job === undefined) return;
	job = undefined;
	stats.abandoned += 1;
	driver?.Disconnect();
	driver = undefined;
}

/** one slice of the job (or all of it, rushed); true once the town is done */
function resume(j: Job): boolean {
	const t0 = os.clock();
	j.sliceAt = t0;
	j.budget = drawing() ? TOWN_SLICE_S : TOWN_SLICE_IDLE_S;
	j.frames += 1;
	const [ok, err] = coroutine.resume(j.co);
	j.workS += os.clock() - t0;
	if (!ok) {
		// the generator threw: nothing to keep. The menus stay on what they show (the page colour, or the last town);
		// the match, if it asks, generates the town itself and meets the same error where it can be seen
		// a fixed sentence (docs/ANALYTICS.md §10): the seed goes to the log line
		warn(`[PZ-LOAD] the lobby's town could not be generated: ${tostring(err)}`);
		print(`[PZ-LOAD] town ${j.seed}: generation failed`);
		failedSeed = j.seed;
		if (job === j) abandon();
		return false;
	}
	if (coroutine.status(j.co) !== "dead" || j.world === undefined) return false;
	if (job === j) {
		job = undefined;
		driver?.Disconnect();
		driver = undefined;
	}
	stats.generated += 1;
	stats.paced += 1;
	stats.lastGenMs = j.workS * 1000;
	stats.lastFrames = j.frames;
	keep(j.seed, j.world);
	print(
		`[PZ-LOAD] town ${j.seed}: generated for the menus over ${j.frames} frame(s) (${fmtMs()} of work` +
			`${j.rush ? ", finished at once" : ""})`,
	);
	return true;
}

/** the job of `seed` finished now, in place: what it already did is kept (the town is wanted before its last slice) */
function rushJob(seed: number): boolean {
	const j = job;
	if (j === undefined || j.seed !== seed) return false;
	j.rush = true;
	stats.rushed += 1;
	// with `rush` set, `pace` never yields: one resume runs it to the end
	for (let i = 0; i < 4 && coroutine.status(j.co) !== "dead"; i++) {
		if (resume(j)) return true;
		if (job !== j) return false;
	}
	return cachedSeed === seed && cached !== undefined;
}

/**
 * The menus want the town of `seed` (the server's, client/boot/serverTown.ts): nothing when it is cached or being
 * generated already; otherwise it is generated a slice per frame, from the next frame on (a generation of another seed
 * is given up: the menus only ever want the town the server runs now). `readyTown` says when it is there. A seed of 0
 * (a random town) is never asked for this way.
 */
export function requestTown(seed: number): void {
	if (seed === 0 || seed === failedSeed) return;
	if (cached !== undefined && cachedSeed === seed) {
		abandon();
		return;
	}
	if (job !== undefined && job.seed === seed) return;
	abandon();
	const j: Job = {
		seed,
		co: undefined as unknown as thread,
		rush: false,
		sliceAt: os.clock(),
		budget: TOWN_SLICE_IDLE_S,
		frames: 0,
		workS: 0,
	};
	const pace = (): void => {
		if (j.rush || os.clock() - j.sliceAt < j.budget) return;
		coroutine.yield();
		// a new slice from here (`resume` stamps it too; this keeps the cadence whoever resumes the coroutine)
		j.sliceAt = os.clock();
	};
	j.co = coroutine.create(() => {
		j.world = generateTown(seed, pace);
	});
	job = j;
	driver = RunService.RenderStepped.Connect(() => {
		const current = job;
		if (current === undefined) return;
		resume(current);
	});
}

/** the menus' town of `seed` when it is generated and still the cache's (a match has not taken it); else undefined */
export function readyTown(seed: number): WorldData | undefined {
	return cached !== undefined && cachedSeed === seed ? cached : undefined;
}

/** the seed being generated a slice per frame right now, if any */
export function pendingTown(): number | undefined {
	return job?.seed;
}

/**
 * The town of `seed` for the menus, NOW: the cached one, the one being generated finished at once, or one generated
 * whole. Kept until a match takes it or another seed is asked for. The caller only READS it (nothing may mutate it:
 * that is the match's town, after `takeTown`). The menus themselves use `requestTown` + `readyTown`, which never stall
 * a frame; this is for a caller that cannot wait.
 */
export function townFor(seed: number): WorldData {
	if (cached !== undefined && cachedSeed === seed && seed !== 0) return cached;
	if (seed !== 0 && rushJob(seed)) {
		const ready = readyTown(seed);
		if (ready !== undefined) return ready;
	}
	abandon();
	const world = generate(seed);
	keep(seed, world);
	return world;
}

/** builds the menus' town behind the logo, a slice per frame, so the first lobby does not wait for it */
export function prewarmTown(seed: number): void {
	requestTown(seed);
}

/**
 * The match's town (GameLoop.init): the menus' copy of `seed` when it has one -- or when it is being generated: then it
 * is finished now, not started over -- and it moves to the match, the flyover drawing it letting go first; or a new
 * one. The cache is empty afterwards either way, and no generation goes on behind the match.
 */
export function takeTown(seed: number): WorldData {
	if (seed !== 0) rushJob(seed);
	abandon();
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
