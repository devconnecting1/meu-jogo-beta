/*
 * Short position history of every zombie and boss, so a shot is judged in the world the shooter was actually
 * looking at (docs/MULTIPLAYER.md §2.3 "Compensação de latência", §3.1 step 3).
 *
 * Why a ring indexed by the tick itself: `tick % ticks` IS the slot, so a rewind costs two array reads and a
 * lerp with no per-tick allocation and no search. HISTORY_TICKS (24 = 400 ms at 60 Hz) covers REWIND_MAX_S
 * (300 ms) with enough margin left to interpolate the far end of the window.
 *
 * Why the simulation's entity id and not the netId: the wire never names the target of a shot (§4.2: a
 * ShotResult carries end POINTS, not ids) and the netId pool recycles after 2 s (§4.4). `ZombieState.id` never
 * repeats inside a session, so a stale track can never be mistaken for a fresh entity.
 *
 * The rewind a shooter gets is capped by their MEASURED ping, never by what they declare (§2.3 "Teto por
 * jogador"): a client that claims an ancient `viewTick` to rewind further gets the cap, not the claim. That is
 * the whole anti-lag-switch argument of §9.1 — declaring an old view buys nothing, and going quiet still leaves
 * the survivor standing still and vulnerable.
 *
 * Pure module: no Instances, no services, no os.clock. The caller passes the tick, which is what lets the same
 * code run in Node (tools/test-combat.mjs) and on the live server.
 */
import { isFiniteNumber } from "shared/net/codec";
import {
	FAIR_BITE_REWIND_MAX_S,
	HISTORY_TICKS,
	INTERP_DEFAULT_S,
	REWIND_MAX_S,
	SIM_HZ,
	TICK_DT,
} from "shared/net/mpConfig";

/** a position read back out of the ring */
export interface HistoryPoint {
	x: number;
	y: number;
}

interface Track {
	xs: Array<number>;
	ys: Array<number>;
	/** the tick each slot holds; -1 = never written (a fresh entity has no past) */
	at: Array<number>;
	/** newest tick written, used to drop tracks of entities that stopped reporting */
	newest: number;
}

/** v mod n with floor semantics, for negative ticks too (Luau and JS disagree on `%` there) */
function ringSlot(tick: number, n: number): number {
	const t = math.floor(tick);
	return t - math.floor(t / n) * n;
}

export class PositionHistory {
	/** ring depth in ticks (HISTORY_TICKS = 400 ms at 60 Hz, §2.3) */
	readonly ticks: number;
	/** tick currently being written (set by beginTick) */
	private tick = 0;
	private readonly tracks = new Map<number, Track>();

	constructor(ticks = HISTORY_TICKS) {
		this.ticks = math.max(2, math.floor(ticks));
	}

	/**
	 * Opens tick `tick` for writing (§3.1 step 3). Once per full wrap of the ring it also drops the tracks of
	 * entities that have not reported for a whole window — amortised O(n / ticks) instead of a sweep per tick.
	 */
	beginTick(tick: number): void {
		if (!isFiniteNumber(tick)) return;
		this.tick = math.floor(tick);
		if (ringSlot(this.tick, this.ticks) === 0) this.prune();
	}

	/** stores where this entity is at the tick opened by beginTick */
	record(id: number, x: number, y: number): void {
		if (!isFiniteNumber(x) || !isFiniteNumber(y)) return;
		let track = this.tracks.get(id);
		if (track === undefined) {
			const xs = new Array<number>();
			const ys = new Array<number>();
			const at = new Array<number>();
			for (let i = 0; i < this.ticks; i++) {
				xs.push(0);
				ys.push(0);
				at.push(-1);
			}
			track = { xs, ys, at, newest: -1 };
			this.tracks.set(id, track);
		}
		const slot = ringSlot(this.tick, this.ticks);
		track.xs[slot] = x;
		track.ys[slot] = y;
		track.at[slot] = this.tick;
		if (this.tick > track.newest) track.newest = this.tick;
	}

	/** records a whole list in one call (the §3.1 step 3 shape: zombies, then bosses) */
	recordAll(list: ReadonlyArray<{ id: number; x: number; y: number }>): void {
		for (const e of list) this.record(e.id, e.x, e.y);
	}

	/** the entity died or despawned: its track must not survive into a netId reuse window */
	forget(id: number): void {
		this.tracks.delete(id);
	}

	clear(): void {
		this.tracks.clear();
	}

	has(id: number): boolean {
		return this.tracks.has(id);
	}

	/** tracks currently held (a metric, and what the tests assert on) */
	size(): number {
		return this.tracks.size();
	}

	/** oldest tick the ring can still answer for */
	oldestTick(): number {
		return this.tick - (this.ticks - 1);
	}

	/**
	 * Where entity `id` was at the (fractional) tick `time`, written into `out`. False when the ring has nothing
	 * for that instant — the caller then falls back to the present position, which is the honest answer for an
	 * entity that only just appeared.
	 */
	sampleInto(id: number, time: number, out: HistoryPoint): boolean {
		const track = this.tracks.get(id);
		if (track === undefined || !isFiniteNumber(time)) return false;
		const lo = math.floor(time);
		const frac = time - lo;
		const a = this.slotOf(track, lo);
		const b = frac > 0 ? this.slotOf(track, lo + 1) : -1;
		if (a >= 0 && b >= 0) {
			out.x = track.xs[a] + (track.xs[b] - track.xs[a]) * frac;
			out.y = track.ys[a] + (track.ys[b] - track.ys[a]) * frac;
			return true;
		}
		const one = a >= 0 ? a : b;
		if (one < 0) return false;
		out.x = track.xs[one];
		out.y = track.ys[one];
		return true;
	}

	/** allocating convenience over `sampleInto` (tests and one-off queries) */
	sampleAt(id: number, time: number): HistoryPoint | undefined {
		const out: HistoryPoint = { x: 0, y: 0 };
		return this.sampleInto(id, time, out) ? out : undefined;
	}

	private slotOf(track: Track, tick: number): number {
		const slot = ringSlot(tick, this.ticks);
		return track.at[slot] === tick ? slot : -1;
	}

	private prune(): void {
		const cutoff = this.tick - this.ticks;
		const dead = new Array<number>();
		for (const [id, track] of this.tracks) {
			if (track.newest < cutoff) dead.push(id);
		}
		for (const id of dead) this.tracks.delete(id);
	}
}

// ---------------------------------------------------------------- how far a shooter may rewind (§2.3)

/**
 * `min(REWIND_MAX_S, ping + interpolation delay + 2 ticks)` (§2.3 "Teto por jogador"). The ping is the one the
 * SERVER measured (`Player:GetNetworkPing()`), so declaring a stale view never widens the window: a lag switch
 * loses the compensation instead of gaining it (§9.1).
 *
 * The WHOLE round trip, not half of it: what a client draws is its newest snapshot (which left the server a
 * downstream trip ago) held `interpolation delay` further back (§5.1), and its shot reaches the server an upstream
 * trip later. The half-ping version was written for a client that drew `interp` behind the server's clock and
 * made up the downstream trip by extrapolating -- which is what put zombies where the server never had them
 * (client/net/snapshotBuffer.ts, tools/test-zombie-motion.mjs). REWIND_MAX_S still caps it.
 */
export function rewindCapS(pingS: number, interpS = INTERP_DEFAULT_S, simHz = SIM_HZ, maxS = REWIND_MAX_S): number {
	const ping = isFiniteNumber(pingS) && pingS > 0 ? pingS : 0;
	const interp = isFiniteNumber(interpS) && interpS > 0 ? interpS : 0;
	const tick = simHz > 0 ? 1 / simHz : TICK_DT;
	return math.clamp(ping + interp + 2 * tick, 0, maxS);
}

/**
 * §2.3 "Mordida justa": the VICTIM's view is rewound to check a bite, with its own (much shorter) ceiling —
 * a bite is a contact attack, so compensating it as generously as a rifle shot would resurrect "I was bitten
 * from across the street".
 */
export function biteRewindCapS(pingS: number, interpS = INTERP_DEFAULT_S, simHz = SIM_HZ): number {
	return rewindCapS(pingS, interpS, simHz, FAIR_BITE_REWIND_MAX_S);
}

/**
 * The (fractional) tick a shot is judged at: what the client declared it was drawing, clamped into
 * `[now − cap, now]`. Garbage (NaN, a tick from the future, a tick older than the ring) collapses to the
 * nearest legal instant instead of being refused — a refused shot would punish a laggy honest player, while a
 * clamped one simply stops compensating (§9.2 level 0: "corrigir em silêncio").
 */
export function judgedTick(nowTick: number, declaredTick: number, capS: number, simHz = SIM_HZ): number {
	const now = isFiniteNumber(nowTick) ? nowTick : 0;
	if (!isFiniteNumber(declaredTick)) return now;
	const hz = simHz > 0 ? simHz : SIM_HZ;
	const oldest = now - math.max(0, capS) * hz;
	return math.clamp(declaredTick, oldest, now);
}
