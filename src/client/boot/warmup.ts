/*
 * Idle-time warm-up: what the first open of a screen would build, built beforehand, a slice per frame.
 *
 * Creating GuiObjects is one of the most expensive things a Roblox client does (Instance.new, every property, the
 * reparent, a layout pass). The kit already builds each screen once and then only rewrites it (npm run test:backpack),
 * but "once" was the first open: the Bag's first B press built about a thousand Instances, and its Craft tab about
 * two thousand more -- a hitch in the middle of a fight. So:
 *
 *   - IN A RUN (`warmRun`, from client/main.client.ts mountRun): a second after the run mounts (its own first frames are
 *     the heaviest: the flyover let go, the HUD built, the snapshot caught up), the Bag is built out of sight
 *     (client/ui/backpack.ts warmStep: the window, each tab's grid a row at a time, the panel, the tooltip card). The
 *     match scoreboard needs nothing: the HUD builds it with the console, its pool warmed to a full town (MP-23).
 *   - IN THE LOBBY (`warmLobby`, from goLobby): after a moment on the menu, the Survivor page that START opens.
 *
 * A WarmQueue runs one step, then more while the frame's budget (WARM_BUDGET_S of os.clock) allows: a step is small
 * (a few tiles), and the queue never starts another one in a frame when the longest step so far would overrun it. Nothing waits for it: a B
 * press before it is done builds what is missing, as before. One [PZ-LOAD] line when the Bag is ready.
 */
import type { Backpack } from "../ui/backpack";
import type { LobbyHandle } from "../ui/lobby";

const RunService = game.GetService("RunService");

/** work per frame (seconds): the rest of the frame stays the game's */
export const WARM_BUDGET_S = 0.002;
/** a run's first second is its heaviest: the warm-up waits it out */
export const RUN_WARM_DELAY_S = 1;
/** the lobby has just been built: its warm-up waits this long on the menu */
export const LOBBY_WARM_DELAY_S = 1.5;
/** cells of a grid per step: a tile with its plate, icon and chips is 40-60 Instances */
export const BAG_TILES_PER_STEP = 3;

/** one job of the warm-up: `step` does one small piece of work and answers true when nothing is left */
export interface WarmJob {
	name: string;
	step: () => boolean;
}

/** what a queue cost, frame by frame (the [PZ-LOAD] line, and the tests) */
export interface WarmStats {
	frames: number;
	steps: number;
	/** milliseconds of work, in all and in the costliest frame */
	workMs: number;
	maxFrameMs: number;
}

/** runs its jobs a slice per frame: one step, then more while the budget lasts */
export class WarmQueue {
	readonly stats: WarmStats = { frames: 0, steps: 0, workMs: 0, maxFrameMs: 0 };
	private readonly jobs = new Array<WarmJob>();
	/** the longest step so far: another step is not started in a frame when one like it would end past the budget */
	private longestStep = 0;

	constructor(
		private readonly budget = WARM_BUDGET_S,
		private readonly clock: () => number = () => os.clock(),
	) {}

	add(job: WarmJob): void {
		this.jobs.push(job);
	}

	/** jobs left */
	pending(): number {
		return this.jobs.size();
	}

	/** one frame of work; answers true when every job is done */
	frame(): boolean {
		if (this.jobs.size() === 0) return true;
		const t0 = this.clock();
		let spent = 0;
		let steps = 0;
		while (this.jobs.size() > 0) {
			if (steps > 0 && spent + this.longestStep > this.budget) break;
			const s0 = this.clock();
			const done = this.jobs[0].step();
			const now = this.clock();
			this.longestStep = math.max(this.longestStep, now - s0);
			spent = now - t0;
			steps += 1;
			if (done) this.jobs.remove(0);
		}
		const st = this.stats;
		st.frames += 1;
		st.steps += steps;
		st.workMs += spent * 1000;
		st.maxFrameMs = math.max(st.maxFrameMs, spent * 1000);
		return this.jobs.size() === 0;
	}
}

// ---------------------------------------------------------------- in a run: the Bag

let runConn: RBXScriptConnection | undefined;
let bagReported = false;

function fmt(ms: number): string {
	return `${math.floor(ms * 10 + 0.5) / 10} ms`;
}

/**
 * A run just mounted: the Bag is built in idle time from a second on. `mounted` says whether the run is still on
 * screen; the warm-up stops with it (the next mount carries on from what is built).
 */
export function warmRun(pack: Backpack, mounted: () => boolean): WarmQueue {
	runConn?.Disconnect();
	const queue = new WarmQueue();
	queue.add({ name: "Backpack", step: () => pack.warmStep(BAG_TILES_PER_STEP) });
	let wait = RUN_WARM_DELAY_S;
	const conn = RunService.Heartbeat.Connect((dt: number) => {
		if (!mounted()) {
			conn.Disconnect();
			return;
		}
		if (wait > 0) {
			wait -= dt;
			return;
		}
		if (!queue.frame()) return;
		conn.Disconnect();
		if (bagReported) return;
		bagReported = true;
		const s = queue.stats;
		print(
			`[PZ-LOAD] warm-up: the Bag is built (${s.steps} steps over ${s.frames} frames, ${fmt(s.workMs)} of work,` +
				` at most ${fmt(s.maxFrameMs)} in one frame): the first B press builds nothing`,
		);
	});
	runConn = conn;
	return queue;
}

// ---------------------------------------------------------------- in the lobby: the Survivor page

/** the lobby on screen: after a moment on the menu, the Survivor page is built out of sight (START only shows it) */
export function warmLobby(lobby: LobbyHandle): void {
	task.delay(LOBBY_WARM_DELAY_S, () => {
		const t0 = os.clock();
		if (lobby.prebuild()) print(`[PZ-LOAD] warm-up: the Survivor page is built (${fmt((os.clock() - t0) * 1000)})`);
	});
}
