/*
 * The end of a world, and the next one (docs/DESIGN_RULES.md MP-22, the owner's decision of 23 Sep 2026: "se todos
 * os jogadores sobreviventes do mundo morrerem, o mundo finaliza naquele dia específico pra resetar pro dia 1. O
 * objetivo do jogo é durar mais tempo vivo e explorar o mundo."). SERVER ONLY.
 *
 * WHEN is not decided here: server/sim/life.ts rule 6 fires `onWorldWiped` once, after the last living survivor fell
 * and nobody paid a Rebirth in WIPE_DECISION_S (or everybody declined sooner). server/net/mpHost.ts answers that
 * hook with `endWorld`, and server/main.server.ts keeps the record (server/save/worldLog.ts). The one other caller is
 * the keeper's restart (MP-26: a private server's owner, or an admin on it; server/match/townRestart.ts), which hands
 * the host a report of reason "restart" -- the same end of the world, run through the same steps, and for EVERY
 * survivor of the town: standing or down, each starts a new life on day 1 in the new one (`LifeKeeper.survivorsNow`,
 * read at the commit, and `restartWorld` with `everyone`). Its record stays in this server's memory.
 *
 * WHAT happens, in this order — the order is the contract:
 *
 *   1. the RECORD of the world that ended: its seed, the day it fell on (how many days it lasted), when it began and
 *      ended, why, and how many survivors fell with it;
 *   2. a NEW SEED, never the old one: exploring is half the goal, and the same streets again would be a respawn;
 *   3. the NEW TOWN, `generateTown(seed)` — the generator the boot runs — handed to the simulation, which rebuilds
 *      everything that stood on the old one through its own boot path (`ServerSimulation.restartWorld`): horde,
 *      bosses, projectiles, combat, kill credit, the F3 world (items, loot, doors, fires, constructions) and the
 *      clock, back to day 1 at 07:00. Everything that can FAIL is in this step, and it changes nothing until all
 *      of it has succeeded (review of f851ad2, M2): a throw here leaves the old world exactly as it was, and the
 *      host lets it go on under the daybreak rule. Once it has succeeded the reset is COMMITTED (review of
 *      de4ba1e, N2): the host names the new town at once (`onSwitched`), and each step below is contained on its
 *      own — one that throws is logged and skipped, the others still run, the clients are always told, and if
 *      the lives fail the fallen still get theirs (`LifeKeeper.settleFallen`);
 *   4. the old town's last events go out (`Replicator.closeTown`), so none of them can arrive after the news;
 *   5. the LIVES (`LifeKeeper.restartWorld`): every survivor who fell with the old world and whose loaded save is
 *      here starts a new life in the new one — life day 1, the starter kit; level, skills, coins, packs and
 *      costumes kept — standing at a safe point if they are in the world, on their next entry if they are in the
 *      lobby; one who is away, or still loading, is owed it until their save is back;
 *   6. the CLIENTS told (`Replicator.openTown`), in the same heartbeat: WorldReset to everybody connected, the lobby
 *      included, carrying each new life's runRev as the server wrote it, AHEAD of the stand-ups of step 5; then the
 *      join message again for those in the world.
 *
 * Pure module: no Instances, no services, no os.clock / os.time (the caller passes the time), so tools/test-reset.mjs
 * runs it under Node through the real host.
 */
import { rndInt } from "shared/engine/rng";
import { PlayerSaveData } from "shared/game/save";
import { WorldData, generateTown } from "shared/game/world";
import { TOWN_SEED_MAX } from "shared/net/mpConfig";
import { WorldResetCause, WorldResetLife } from "shared/net/protocol";
import { mapHashOf, Replicator } from "../net/replication";
import { LifeKeeper, WipeReport } from "./life";
import { ServerSimulation } from "./simulation";

/** ended worlds kept in the shared DataStore document (server/save/worldLog.ts) — a bounded list, newest last */
export const WORLD_LOG_KEEP = 50;
/** ended worlds one server remembers in memory (the log line, the admin panel) */
export const WORLD_LOG_MEMORY = 20;
/** a JobId longer than this is not one (Roblox's are a GUID, Studio's "studio-" + a GUID): the record leaves it out */
const JOB_MAX = 64;

/** one world that ended (MP-22): what is persisted, and nothing more */
export interface EndedWorld {
	/** the seed its town was generated from */
	seed: number;
	/** the world day it fell on — how many days it lasted, the first one counted (≥ 1) */
	days: number;
	/** os.time() when it began (the server's boot, or the previous world's end) and when it ended */
	startedAt: number;
	endedAt: number;
	/**
	 * WipeReport.reason: "timeout" (nobody paid in the window), "declined" (every dead survivor chose not to) or
	 * "restart" (its keeper asked for a new town, MP-26 -- server/match/townRestart.ts). A restart is kept in this
	 * server's memory only, never in the shared document (review of 0b44458, M4): the stored list is MP-22's
	 */
	reason: string;
	/** survivors who fell with it (the ones the window waited on) */
	fallen: number;
	/** the server it ran on (game.JobId) */
	job: string;
}

/** the town a server is running right now */
export interface TownState {
	seed: number;
	/** os.time() when this world began */
	startedAt: number;
}

/** what the end of a world touches, all of it pure (server/net/mpHost.ts hands its own) */
export interface WorldParts {
	sim: ServerSimulation;
	lives: LifeKeeper;
	/** omitted by a harness that has no clients to tell */
	replicator?: Replicator;
}

export interface EndWorldOptions {
	/** os.time() now */
	now: number;
	/** game.JobId, for the record */
	job: string;
	/** the live save of a connected survivor by UserId (the session's, server/main.server.ts) */
	saveOf: (userId: number) => PlayerSaveData | undefined;
	/** the next town's seed; drawn at random (never the ended one) when omitted */
	seed?: number;
	/** seconds, for measuring the generator (os.clock on the server); omitted = not measured */
	clock?: () => number;
	/**
	 * Handed to `generateTown`, which calls it between two buildings' interiors: the host yields there when a frame's
	 * share of the work is spent (server/net/mpHost.ts), so a new town costs no stall. It cannot change the town, and
	 * nothing has changed yet while it runs; a throw from it abandons the reset (step 3) and the old world goes on.
	 */
	pace?: () => void;
	/**
	 * Called the moment the simulation stands in the new town, BEFORE anything else happens: from then on the reset
	 * is committed whatever fails after it, so the host names the town the simulation runs (its seed, the Workspace
	 * attribute) there and then (review of de4ba1e, N2).
	 */
	onSwitched?: (town: { seed: number; mapHash: number; world: WorldData }) => void;
}

/** what `endWorld` did, for the host (its log line and attributes) and the record keeper */
export interface WorldEnd {
	/** the world that ended, as it is persisted */
	ended: EndedWorld;
	/** the new town */
	world: WorldData;
	seed: number;
	mapHash: number;
	/** os.time() the new world began */
	startedAt: number;
	/** the survivors given a new life in it, and the runRev each save is on now */
	lives: Array<WorldResetLife>;
	/** milliseconds `generateTown` took (0 when not measured): a server hitch the owner can read in Studio */
	generateMs: number;
	/** the steps after the switch that threw — each one contained, the others still ran (N2); empty when all went well */
	failures: Array<string>;
}

function wholeIn(v: unknown, min: number, max: number): v is number {
	return typeIs(v, "number") && v === v && v % 1 === 0 && v >= min && v <= max;
}

/**
 * A seed for the next town: 1 … TOWN_SEED_MAX (every value `TownRng` turns into a town of its own), never
 * `previous`. `roll` is injectable for a test; the default is the engine's `math.random`, like `generateTown(0)`.
 */
export function pickTownSeed(previous: number, roll: () => number = () => rndInt(1, TOWN_SEED_MAX)): number {
	for (let i = 0; i < 8; i++) {
		const seed = math.floor(roll());
		if (seed >= 1 && seed <= TOWN_SEED_MAX && seed !== previous) return seed;
	}
	// eight draws that all failed are a broken roll, not bad luck: the next seed along is new by construction
	return (math.max(0, math.floor(previous)) % TOWN_SEED_MAX) + 1;
}

/**
 * The seed of a server's FIRST town (the owner, 2026-09-24: "the map must be made when the player enters the match
 * (if they entered alone/first) … generated exclusively by the server, as a seed"). The server is the one authority
 * on its town: it picks a fresh seed at boot -- which, for the first survivor to arrive, is the same thing as picking
 * it when they arrive -- and every later joiner gets that town; it changes only when the world ends (MP-22,
 * `endWorld`) or the server shuts down. Until this, every server opened on DESIGN.TOWN_SEED: the same streets in
 * every server, and a new town only after a world ended.
 *
 * `pinned` is a seed a developer set on the server itself (server/main.server.ts reads ServerStorage's
 * TOWN_SEED_PIN_ATTRIBUTE, which no client can see or write): a town reproduced in Studio, and the node suites that
 * play on the validated town. Anything that is not a whole 1 … TOWN_SEED_MAX is no pin. Nothing a client sends is
 * ever an input here.
 */
export function bootTownSeed(pinned: unknown, roll?: () => number): number {
	if (wholeIn(pinned, 1, TOWN_SEED_MAX)) return pinned;
	return pickTownSeed(0, roll);
}

/**
 * The world `current` ends, as `report` (life.ts rule 6) says, and a new one begins — the five steps at the top of
 * this file, in that order. Returns what happened; nothing here waits for anything but `options.pace`, while the new
 * town is generated and before anything has changed.
 */
export function endWorld(
	parts: WorldParts,
	report: WipeReport,
	current: TownState,
	options: EndWorldOptions,
): WorldEnd {
	const ended: EndedWorld = {
		seed: current.seed,
		days: math.max(1, math.floor(report.day)),
		startedAt: current.startedAt,
		endedAt: options.now,
		reason: report.reason,
		fallen: report.dead.size(),
		job: options.job.size() <= JOB_MAX ? options.job : "",
	};
	const requested = options.seed;
	const seed =
		wholeIn(requested, 1, TOWN_SEED_MAX) && requested !== current.seed ? requested : pickTownSeed(current.seed);
	const clock = options.clock;
	const t0 = clock !== undefined ? clock() : 0;
	const world = generateTown(seed, options.pace);
	const generateMs = clock !== undefined ? math.floor((clock() - t0) * 1000 + 0.5) : 0;
	const mapHash = mapHashOf(world);
	const restart = report.reason === "restart";
	// MP-26: a keeper's restart ends EVERY life of the town -- read at the commit, not when it was asked: the new town
	// takes frames to generate, and whoever entered, left or paid a Rebirth meanwhile is judged as the town ends
	// (review of 0b44458, L1; a Rebirth is refused while a world is ending, server/main.server.ts)
	if (restart) ended.days = math.max(1, math.floor(parts.sim.clock.day));
	// everything that can fail comes first, and changes nothing until it has all succeeded (step 3): a throw from
	// here out leaves the old world exactly as it was
	parts.sim.restartWorld(world);
	// COMMITTED: the simulation runs the new town. From here on nothing is built, only handed out, and no step may
	// abandon the rest (review of de4ba1e, N2) — a reset stopped half-way left the host naming the old town, the
	// clients never told, the fallen down and rule 6 disarmed. Each step is contained on its own; the host is told
	// first, and the clients always
	const failures = new Array<string>();
	const contain = (step: string, fn: () => void): boolean => {
		const [ok, err] = pcall(fn);
		if (!ok) failures.push(`${step}: ${tostring(err)}`);
		return ok;
	};
	contain("host", () => options.onSwitched?.({ seed, mapHash, world }));
	contain("closeTown", () => parts.replicator?.closeTown());
	let fallen = new Array<number>();
	contain("fallenOf", () => {
		if (restart) {
			report.dead = parts.lives.survivorsNow();
			ended.fallen = report.dead.size();
		}
		fallen = parts.lives.fallenOf(report.dead, options.saveOf);
	});
	if (!contain("lives", () => parts.lives.restartWorld(fallen, options.saveOf, restart))) {
		// whatever it got done, nobody who fell stays down in a town nobody else can end the window of
		contain("lives (fallback)", () => parts.lives.settleFallen(fallen, options.saveOf));
	}
	const lives = new Array<WorldResetLife>();
	contain("lives list", () => {
		for (const userId of fallen) lives.push({ userId, runRev: options.saveOf(userId)?.runRev ?? 0 });
	});
	// the clients word the news by why it ended: a town its keeper restarted did not fall (protocol note 21)
	const cause = report.reason === "restart" ? WorldResetCause.Restarted : WorldResetCause.Fell;
	contain("openTown", () => parts.replicator?.openTown({ seed, mapHash, endedDay: ended.days, cause, lives }));
	return { ended, world, seed, mapHash, startedAt: options.now, lives, generateMs, failures };
}

// ---------------------------------------------------------------- the record (server/save/worldLog.ts)

/** `list` with `entry` appended and the oldest dropped beyond `keep` (in place; returns it) */
export function appendEnded(list: Array<EndedWorld>, entry: EndedWorld, keep = WORLD_LOG_KEEP): Array<EndedWorld> {
	list.push(entry);
	while (list.size() > math.max(1, keep)) list.remove(0);
	return list;
}

/**
 * A stored record, checked the way `sanitizeStoredSave` checks a save: the document is shared by every server and
 * outlives this code, so anything that is not a well-formed record is dropped instead of trusted.
 */
export function readEndedWorld(v: unknown): EndedWorld | undefined {
	if (!typeIs(v, "table")) return undefined;
	const r = v as Record<string, unknown>;
	if (!wholeIn(r.seed, 1, TOWN_SEED_MAX) || !wholeIn(r.days, 1, 1e7)) return undefined;
	if (!wholeIn(r.startedAt, 0, 1e12) || !wholeIn(r.endedAt, 0, 1e12)) return undefined;
	return {
		seed: r.seed,
		days: r.days,
		startedAt: r.startedAt,
		endedAt: r.endedAt,
		reason: r.reason === "declined" ? "declined" : "timeout",
		fallen: wholeIn(r.fallen, 0, 1000) ? r.fallen : 0,
		job: typeIs(r.job, "string") && r.job.size() <= JOB_MAX ? r.job : "",
	};
}

/** the stored document (an array of records) → the records that survive `readEndedWorld`, oldest first */
export function readEndedList(v: unknown): Array<EndedWorld> {
	const out = new Array<EndedWorld>();
	if (!typeIs(v, "table")) return out;
	for (const item of v as Array<unknown>) {
		const e = readEndedWorld(item);
		if (e !== undefined) out.push(e);
	}
	return out;
}
