/*
 * The world log of a solo town, throttled (docs/MULTIPLAYER.md §7.4, review LOW 5). SERVER ONLY, but pure: the clock,
 * the timer and the shutdown hook are injected, so tools/test-match.mjs drives it.
 *
 * Every world that ends (MP-22) is appended to ONE shared DataStore document (server/save/worldLog.ts, key "ended" of
 * ProjectZ_Worlds), and every server writes that same key. In a solo town the world ends whenever its one survivor
 * dies and does not pay -- and New game IS that refusal, at once: a player pressing New game in a loop would write
 * the shared key once per press. So a solo town records at most one world per SOLO_WORLD_LOG_GAP_S: the first at
 * once, and of the ones that end inside the gap only the one that LASTED LONGEST (what the record and the future
 * ranking ask: how long a town held out), written when the gap is over or at shutdown. The others are counted and
 * dropped: a statistic, never a save. Public and private servers keep the log as it was.
 */
import type { EndedWorld } from "../sim/worldReset";
import type { WorldLog } from "../save/worldLog";

/** a solo town writes the shared world log at most once in this long (s) */
export const SOLO_WORLD_LOG_GAP_S = 600;

export interface SoloWorldLogHost {
	clock: () => number;
	/** task.delay */
	delay: (seconds: number, fn: () => void) => void;
	/** game.BindToClose: the one kept for the gap still goes out */
	onClose: (fn: () => void) => void;
}

export interface SoloWorldLog extends WorldLog {
	/** worlds that ended inside a gap and were dropped for a longer one (the admin panel, the tests) */
	dropped(): number;
}

export function soloWorldLog(inner: WorldLog, host: SoloWorldLogHost): SoloWorldLog {
	let lastWrite = -math.huge;
	let pending: EndedWorld | undefined;
	let scheduled = false;
	let droppedCount = 0;

	const flush = (): void => {
		scheduled = false;
		const entry = pending;
		if (entry === undefined) return;
		pending = undefined;
		lastWrite = host.clock();
		inner.record(entry);
	};
	host.onClose(flush);

	return {
		record(entry) {
			const now = host.clock();
			if (pending === undefined && now - lastWrite >= SOLO_WORLD_LOG_GAP_S) {
				lastWrite = now;
				inner.record(entry);
				return;
			}
			// inside the gap: keep the town that held out longest, count the others
			if (pending === undefined || entry.days > pending.days) {
				if (pending !== undefined) droppedCount += 1;
				pending = entry;
			} else {
				droppedCount += 1;
			}
			if (!scheduled) {
				scheduled = true;
				host.delay(math.max(0, lastWrite + SOLO_WORLD_LOG_GAP_S - now), flush);
			}
		},
		recent() {
			return inner.recent();
		},
		status() {
			return inner.status();
		},
		dropped() {
			return droppedCount;
		},
	};
}
