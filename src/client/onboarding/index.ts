import { GameContext } from "shared/game/context";
import { AIM_ASSIST, AimTarget } from "shared/engine/input";
import { ZOMBIE_RADIUS } from "shared/game/physics";
import { PROGRESS_SERVER_PHASE } from "shared/game/save";
import { MP_PHASE } from "shared/net/mpConfig";
import { LifeState } from "shared/net/protocol";
import { setAimTargets } from "../bootstrap";
import { RosterView, netActive, netRoster } from "../net/netClient";
import { requestSave } from "../systems/saveClient";
import type { GameRefs } from "../systems/types";
import { Coach } from "./coach";
import { DaybreakWait, RunSummary, RunSummaryHandlers, showDaybreakWait as showDaybreakWaitScreen } from "./gameOver";

/*
 * Everything a live run needs from this folder, behind two calls.
 *
 * `attachRun` is the one hook the rest of the client has to make: from the moment a run is mounted until it is
 * torn down, this module
 *   - feeds the aim assist the bodies it may nudge towards (shared/engine/input.ts documents why it is fair),
 *   - runs the first-match coach (client/onboarding/coach.ts), and
 *   - counts the run's kills, so the end-of-run screen can show what the player actually did: from
 *     PROGRESS_SERVER_PHASE the SERVER's kill credit (`zombieKills`, the killing blows it gave this survivor, MON-05),
 *     read as how far it moved since the run was attached. The horde is the server's there and the client only draws
 *     a mirror whose bodies never reach 0 hp (client/view/actorsView.ts): watching them die counted nothing but an
 *     exploder with its fuse lit (ACH-2). Below that phase the client simulates the horde and watches its bodies.
 *
 * Nothing here touches the simulation: it reads GameRefs and draws. If `attachRun` is never called the game
 * behaves exactly as it did before — no assist, no coach, no counters.
 */

const RunService = game.GetService("RunService");

let connection: RBXScriptConnection | undefined;
let coach: Coach | undefined;
let refsLive: GameRefs | undefined;
/** the lesson the coach was on when the run UI was last torn down */
let resumeIndex = 0;

/** zombies put down since the run was attached (below PROGRESS_SERVER_PHASE: counted here) */
let kills = 0;
/** save.zombieKills when the run was attached (from PROGRESS_SERVER_PHASE: the server's count) */
let killsAtStart = 0;
/** the server credits the kills: nothing to watch here */
const SERVER_KILLS = MP_PHASE >= PROGRESS_SERVER_PHASE;
/** save.bossKills when the run was attached */
let bossesAtStart = 0;
/**
 * The death screen's "New best!" (UI-13): the life whose best day `bestAtLife` holds, keyed `runRev - deathCount` (a
 * paid Rebirth moves both and keeps the life; New game and a world's new life move only runRev), and the best day the
 * player had when this client first saw that life. A life met mid-way (a reconnect) starts from the best it already
 * set, so the screen may miss a record -- it never claims one that is not.
 */
let lifeKey = -1;
let bestAtLife = 0;
/**
 * A survivor of this session stood back up after a death (the daybreak, an ally, a Rebirth): the next death is not
 * the first. The save's own counters catch the rest -- runRev (a New game, a world's new life), deathCount (a paid
 * Rebirth) and lifeDeaths (a death this life already had when it was loaded).
 */
let stoodUp = false;
let wasDead = false;
/**
 * The life's deaths when this run was attached: "as loaded". The live `lifeDeaths` moves on with the pushed wallet
 * (review of 97cd734, LOW1), so the death being shown may already be counted in it. Undefined before any run was
 * attached: then the save's own number is all there is
 */
let deathsAtRun: number | undefined;
/** zombie id → its hp when we last saw it: a body that leaves the list at 0 hp was killed */
const seen = new Map<number, number>();
let killScan = 0;
const KILL_SCAN = 0.1;

/** reused so the assist costs no allocation per frame */
const targetBuffer: Array<AimTarget> = [];

function aimTargets(): Array<AimTarget> {
	targetBuffer.clear();
	const refs = refsLive;
	if (refs === undefined) return targetBuffer;
	const p = refs.player;
	if (p.dead) return targetBuffer;
	const range = AIM_ASSIST.RANGE;
	for (const z of refs.zombies) {
		// what the survivor cannot see, the assist will not aim at (a zombie in the dark stays a surprise)
		if ((z.alpha ?? 1) < 0.35) continue;
		if (math.abs(z.x - p.x) > range || math.abs(z.y - p.y) > range) continue;
		targetBuffer.push({ x: z.x, y: z.y, r: ZOMBIE_RADIUS * (z.scale ?? 1) });
	}
	for (const b of refs.bosses) {
		if (b.dead) continue;
		if (math.abs(b.x - p.x) > range || math.abs(b.y - p.y) > range) continue;
		targetBuffer.push({ x: b.x, y: b.y, r: ZOMBIE_RADIUS * 2 });
	}
	return targetBuffer;
}

/**
 * Counts kills by watching bodies leave the list. Polled at 10 Hz: ids are unique and only grow, so a body
 * cannot be born and buried between two sweeps in any way that matters to a score line.
 */
function scanKills(refs: GameRefs, dt: number): void {
	killScan -= dt;
	if (killScan > 0) return;
	killScan = KILL_SCAN;
	const alive = new Set<number>();
	for (const z of refs.zombies) alive.add(z.id);
	for (const [id, hp] of seen) {
		if (alive.has(id)) continue;
		if (hp <= 0) kills += 1;
		seen.delete(id);
	}
	for (const z of refs.zombies) seen.set(z.id, z.hp);
}

/** starts the aim assist, the coach and the run counters for the run `refs` describes */
export function attachRun(ctx: GameContext, refs: GameRefs): void {
	detachRun();
	refsLive = refs;
	kills = 0;
	killsAtStart = ctx.save.zombieKills;
	bossesAtStart = ctx.save.bossKills;
	deathsAtRun = ctx.save.lifeDeaths;
	const key = ctx.save.runRev - ctx.save.deathCount;
	if (key !== lifeKey) {
		lifeKey = key;
		bestAtLife = ctx.save.bestDay;
	}
	wasDead = refs.player.dead;
	seen.clear();
	killScan = 0;
	setAimTargets(aimTargets);

	// `firstInstall` is the save's "this player has never played" flag; the coach is what it was waiting for
	if (ctx.save.firstInstall) {
		const c = new Coach(ctx);
		coach = c;
		// resuming where it left off: menu → shop → back tears the run UI down and builds it again, and
		// being sent back to "take a walk" for that would be worse than no coach at all
		c.start(
			refs,
			() => {
				ctx.save.firstInstall = false;
				resumeIndex = 0;
				coach = undefined;
				// the run's autosave would carry it anyway; asking now means a crash cannot replay the lessons
				requestSave("auto");
			},
			resumeIndex,
		);
	}

	connection = RunService.Heartbeat.Connect(dt => {
		const live = refsLive;
		if (live === undefined) return;
		const dead = live.player.dead;
		if (wasDead && !dead) stoodUp = true;
		wasDead = dead;
		if (!SERVER_KILLS) scanKills(live, dt);
		coach?.update(live, dt);
	});
}

export function detachRun(): void {
	connection?.Disconnect();
	connection = undefined;
	if (coach !== undefined) resumeIndex = coach.progressIndex();
	coach?.stop();
	coach = undefined;
	refsLive = undefined;
	setAimTargets(undefined);
	seen.clear();
}

/**
 * The numbers the end-of-run screen shows; safe to call after the run has been detached. `first`: the save has never
 * died before this death -- no New game, world's new life or paid Rebirth (runRev, deathCount), no earlier death in
 * this life (lifeDeaths, as loaded) and no stand-up seen this session. `record`: this life went past the best day the
 * player had when it began (UI-13: the only time "Best day" is highlighted).
 */
export function runSummary(ctx: GameContext): RunSummary {
	const save = ctx.save;
	return {
		days: save.day,
		bestDay: save.bestDay,
		level: save.level,
		kills: SERVER_KILLS ? math.max(save.zombieKills - killsAtStart, 0) : kills,
		bosses: math.max(save.bossKills - bossesAtStart, 0),
		first: save.runRev === 0 && save.deathCount === 0 && (deathsAtRun ?? save.lifeDeaths) === 0 && !stoodUp,
		record: lifeKey === save.runRev - save.deathCount && save.day > bestAtLife,
	};
}

const rosterBuf = new Array<RosterView>();

/**
 * MP-22, for the death screen: the OTHER survivors in town still up -- alive, or bleeding out and still revivable
 * (MP-03) -- from the server's reliable roster (the one the match scoreboard reads). Undefined outside a session, or
 * before the roster names this client: then nobody can say, and the screen promises the daybreak.
 */
export function othersStanding(): number | undefined {
	if (!netActive()) return undefined;
	let me = false;
	let n = 0;
	for (const v of netRoster(rosterBuf)) {
		if (v.you) me = true;
		else if (v.life !== LifeState.Dead) n += 1;
	}
	return me ? n : undefined;
}

/** the daybreak wait (gameOver.ts), told who is still standing in town */
export function showDaybreakWait(
	ctx: GameContext,
	summary: RunSummary,
	handlers: RunSummaryHandlers,
	newLife = false,
): DaybreakWait {
	return showDaybreakWaitScreen(ctx, summary, handlers, newLife, othersStanding);
}

export { Coach } from "./coach";
export { showRunSummary } from "./gameOver";
export type { DaybreakWait, RunSummary, RunSummaryHandlers } from "./gameOver";
