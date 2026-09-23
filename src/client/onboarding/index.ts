import { GameContext } from "shared/game/context";
import { AIM_ASSIST, AimTarget } from "shared/engine/input";
import { ZOMBIE_RADIUS } from "shared/game/physics";
import { setAimTargets } from "../bootstrap";
import { requestSave } from "../systems/saveClient";
import type { GameRefs } from "../systems/types";
import { Coach } from "./coach";
import { RunSummary } from "./gameOver";

/*
 * Everything a live run needs from this folder, behind two calls.
 *
 * `attachRun` is the one hook the rest of the client has to make: from the moment a run is mounted until it is
 * torn down, this module
 *   - feeds the aim assist the bodies it may nudge towards (shared/engine/input.ts documents why it is fair),
 *   - runs the first-match coach (client/onboarding/coach.ts), and
 *   - counts the run's kills, so the end-of-run screen can show what the player actually did.
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

/** zombies put down since the run was attached */
let kills = 0;
/** save.bossKills when the run was attached */
let bossesAtStart = 0;
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
	bossesAtStart = ctx.save.bossKills;
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
		scanKills(live, dt);
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

/** the numbers the end-of-run screen shows; safe to call after the run has been detached */
export function runSummary(ctx: GameContext, first: boolean): RunSummary {
	return {
		days: ctx.save.day,
		bestDay: ctx.save.bestDay,
		level: ctx.save.level,
		kills,
		bosses: math.max(ctx.save.bossKills - bossesAtStart, 0),
		first,
	};
}

export { Coach } from "./coach";
export { showDaybreakWait, showRunSummary } from "./gameOver";
export type { DaybreakWait, RunSummary, RunSummaryHandlers } from "./gameOver";
