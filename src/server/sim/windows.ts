/*
 * Window glass, owned by the SERVER (docs/DESIGN_RULES.md EDI-18; docs/MULTIPLAYER.md §4.5, §8.1; protocol.ts note 21).
 *
 * What a window is and how it breaks is shared/game/windows.ts; what a pane giving way does in a simulation -- the crash
 * the horde hears, the glass on the floor, the open frame in the flow field -- is zombieBrain `shatterWindow`. This is
 * the server's side of it:
 *
 *   - THE WIRE. The world's hook (`WorldData.onWindowBroken`) queues one GLOBAL `DoorSet{id, Open}` per pane, whatever
 *     broke it: every client predicts its own movement against the frame (§4.5, like a door), and a zombie's blow in
 *     shared/sim/ai/zombieBrain.ts reaches the outbox without knowing there is one. A newcomer's WorldInit carries the
 *     panes broken since the town was generated (server/net/replication.ts `welcomeWorld`).
 *   - THE BUDGET. At most WINDOW_BREAKS_PER_TICK panes break in one tick, whatever broke them (`beginTick` refills it):
 *     a safety valve on the reliable channel and the flow field, which nothing honest reaches.
 *   - WHO MAY BREAK ONE, AND HOW (§8.1). The client never names a pane: E is the edge every command carries and the
 *     server's own `interactTarget` picks the pane at the SERVER's position (server/sim/interaction.ts); a blade's arc
 *     and a bullet's ray are the combat's own (server/sim/combat.ts, projectiles.ts). On top of that:
 *       · by hand (E, a blade): within reach of the pane's edge (+ the latency slack every E gets) with a clear line to it
 *         -- a wall between is a wall -- and at most WINDOW_BREAK_RATE a second per survivor (a burst of
 *         WINDOW_BREAK_BURST): the verbs that cost nothing get a rate;
 *       · by a shot or an arrow: the ray IS the line and the reach (the weapon's range, never through a wall), and the
 *         gun's cadence and its ammunition are the rate the server already enforces.
 *
 * Pure module: no Instances, no services.
 */
import { segmentClear } from "shared/game/physics";
import type { PlayerState } from "shared/game/player";
import { isBlocking, Solid, WorldData } from "shared/game/world";
import * as Win from "shared/game/windows";
import { debrisMaterialId } from "shared/net/fxWire";
import { FxEvent, FxType, SolidState, WorldEv } from "shared/net/protocol";
import type { AiRefs } from "shared/sim/ai/context";
import { shatterWindow } from "shared/sim/ai/zombieBrain";
import { edgeDist } from "shared/sim/interactQuery";
import { WorldOut } from "./worldOut";

/** panes a survivor may break by hand (E, a blade) per second, and in one burst */
export const WINDOW_BREAK_RATE = 2;
export const WINDOW_BREAK_BURST = 3;
/** the reach checks get the latency allowance every E gets (server/sim/interaction.ts REACH_LATENCY_SLACK) */
const REACH_SLACK = 10;

/** what an attempt to break a pane came to */
export type WindowOutcome =
	| "broken"
	/** no pane there (broken already, not a window) */
	| "none"
	/** too far from the glass */
	| "range"
	/** a wall (or anything blocking) between the survivor and the glass */
	| "blocked"
	/** this survivor broke too many by hand, too fast */
	| "rate"
	/** the tick's WINDOW_BREAKS_PER_TICK are spent: the pane holds, this once */
	| "budget";

export interface ServerWindowsOptions {
	world: WorldData;
	out: WorldOut;
	/** the horde's refs, when this server has a horde: its ears hear the crash and its field reads the open frame */
	horde: () => AiRefs | undefined;
	/** the glass on the floor where there is no horde to push it (a world without zombies: the tests) */
	fx?: (event: FxEvent) => void;
}

export class ServerWindows {
	/** panes broken in this town, whatever broke them (the §12.2 metrics, the tests) */
	broken = 0;
	/** attempts refused, by reason (the §9.3 evidence: a client that keeps asking from across the street) */
	readonly refused = { range: 0, blocked: 0, rate: 0, budget: 0 };
	private readonly world: WorldData;
	private readonly horde: () => AiRefs | undefined;
	private readonly fx?: (event: FxEvent) => void;
	/** by-hand breaks each survivor still has in their bucket (absent: a full burst) */
	private readonly tokens = new Map<number, number>();

	constructor(options: ServerWindowsOptions) {
		this.world = options.world;
		this.horde = options.horde;
		this.fx = options.fx;
		const out = options.out;
		// §4.5: GLOBAL -- a pane decides whether a body passes, and every client predicts its own movement against it
		options.world.onWindowBroken = (_w, s) => {
			this.broken += 1;
			out.queue({ t: WorldEv.DoorSet, id: s.id, state: SolidState.Open });
		};
		options.world.windowBudget = Win.WINDOW_BREAKS_PER_TICK;
	}

	/** the start of every tick: the tick's budget, and every survivor's bucket refilled by `dt` */
	beginTick(dt: number): void {
		this.world.windowBudget = Win.WINDOW_BREAKS_PER_TICK;
		if (this.tokens.size() === 0) return;
		const full = new Array<number>();
		for (const [slot, n] of this.tokens) {
			const refilled = n + WINDOW_BREAK_RATE * dt;
			if (refilled >= WINDOW_BREAK_BURST) full.push(slot);
			else this.tokens.set(slot, refilled);
		}
		for (const slot of full) this.tokens.delete(slot);
	}

	/**
	 * A survivor breaks pane `s` by hand -- E, or the blade of a swing that crossed it: within `reach` of its edge (plus
	 * the slack), with a clear line from the SERVER's position of the survivor to the glass, within their rate.
	 */
	byHand(slot: number, p: PlayerState, s: Solid, reach: number): WindowOutcome {
		if (p.dead || !Win.windowIntact(s)) return "none";
		if (edgeDist(s, p.x, p.y) > reach + REACH_SLACK) {
			this.refused.range += 1;
			return "range";
		}
		const cx = math.clamp(p.x, s.x, s.x + s.w);
		const cy = math.clamp(p.y, s.y, s.y + s.h);
		if (!segmentClear(this.world, p.x, p.y, cx, cy, other => other !== s && isBlocking(other))) {
			this.refused.blocked += 1;
			return "blocked";
		}
		const left = this.tokens.get(slot) ?? WINDOW_BREAK_BURST;
		if (left < 1) {
			this.refused.rate += 1;
			return "rate";
		}
		const outcome = this.shatter(s);
		if (outcome === "broken") this.tokens.set(slot, left - 1);
		return outcome;
	}

	/**
	 * A bullet or an arrow stopped at pane `s` (the combat's own ray: the weapon's range, never through a wall). The
	 * shot is already paid for -- cadence, ammunition -- so there is no bucket here; the tick's budget still holds.
	 */
	byShot(s: Solid): WindowOutcome {
		if (!Win.windowIntact(s)) return "none";
		return this.shatter(s);
	}

	/** a survivor left: their bucket goes with the slot */
	remove(slot: number): void {
		this.tokens.delete(slot);
	}

	/** this town is over (MP-22): it stops feeding the outbox */
	detach(): void {
		this.world.onWindowBroken = undefined;
		this.world.windowBudget = undefined;
	}

	private shatter(s: Solid): WindowOutcome {
		const refs = this.horde();
		if (refs !== undefined && refs.world === this.world) {
			if (shatterWindow(refs, s)) return "broken";
		} else if (Win.breakWindow(this.world, s)) {
			// no horde to hear it: the glass on the floor, and its crash, for whoever is near
			this.fx?.({
				t: FxType.Debris,
				x: s.x + s.w / 2,
				y: s.y + s.h / 2,
				angle: 0,
				material: debrisMaterialId("glass"),
				count: 12,
			});
			return "broken";
		}
		this.refused.budget += 1;
		return "budget";
	}
}
