/*
 * Window glass, owned by the SERVER (docs/DESIGN_RULES.md EDI-18; docs/MULTIPLAYER.md §4.5, §8.1; protocol.ts note 22).
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
 *   - WHO MAY BREAK ONE, AND HOW (§8.1). The client never names a pane. E breaks glass only on a press that SAYS so
 *     (`HeldBit.Glass`, protocol.ts note 22), and then the server's own query picks the pane at the SERVER's position
 *     (server/sim/interaction.ts); a blade's arc, a bullet's ray and a turret's shot are the combat's own
 *     (server/sim/combat.ts, projectiles.ts, turrets.ts). On top of that:
 *       · by hand (E, a blade): within reach of the pane's edge (+ the latency slack every E gets) with a clear line to it
 *         -- a wall between is a wall; shared/sim/interactQuery.ts `paneAtHand`, the very test the client's hint asks --
 *         and at most WINDOW_BREAK_RATE a second per survivor (a burst of WINDOW_BREAK_BURST): the verbs that cost
 *         nothing get a rate;
 *       · by a shot, an arrow or a turret: the ray IS the line and the reach (the weapon's range, never through a wall),
 *         and the gun's cadence and its ammunition -- the turret's charge -- are the rate the server already enforces.
 *   - THE EVIDENCE (§9.3). Every refusal of a survivor's attempt is counted against their slot (`refusedOf`), and the
 *     admin view's anomaly row carries it (server/net/mpHost.ts `anomalies`): an honest client, whose hint asked the same
 *     test, is refused only across a latency spike; one that keeps asking from across the street shows.
 *
 * Pure module: no Instances, no services, and nothing allocated per tick.
 */
import type { PlayerState } from "shared/game/player";
import { Solid, WorldData } from "shared/game/world";
import * as Win from "shared/game/windows";
import { debrisMaterialId } from "shared/net/fxWire";
import { MAX_PLAYERS } from "shared/net/mpConfig";
import { FxEvent, FxType, SolidState, WorldEv } from "shared/net/protocol";
import type { AiRefs } from "shared/sim/ai/context";
import { shatterWindow } from "shared/sim/ai/zombieBrain";
import { paneAtHand } from "shared/sim/interactQuery";
import { WorldOut } from "./worldOut";

/** panes a survivor may break by hand (E, a blade) per second, and in one burst */
export const WINDOW_BREAK_RATE = 2;
export const WINDOW_BREAK_BURST = 3;
/** the reach checks get the latency allowance every E gets (server/sim/interaction.ts REACH_LATENCY_SLACK) */
export const WINDOW_REACH_SLACK = 10;

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
	/** attempts refused in this town, by reason (the §12.2 metrics; per survivor: `refusedOf`) */
	readonly refused = { range: 0, blocked: 0, rate: 0, budget: 0 };
	private readonly world: WorldData;
	private readonly horde: () => AiRefs | undefined;
	private readonly fx?: (event: FxEvent) => void;
	/** by-hand breaks each slot still has in its bucket (a full burst at rest): one number a slot, no map, no garbage */
	private readonly tokens = new Array<number>();
	/** a survivor's refused attempts by hand (range, line, rate), by slot: the §9.3 evidence */
	private readonly refusals = new Array<number>();

	constructor(options: ServerWindowsOptions) {
		this.world = options.world;
		this.horde = options.horde;
		this.fx = options.fx;
		for (let i = 0; i < MAX_PLAYERS; i++) {
			this.tokens.push(WINDOW_BREAK_BURST);
			this.refusals.push(0);
		}
		const out = options.out;
		// §4.5: GLOBAL -- a pane decides whether a body passes, and every client predicts its own movement against it
		options.world.onWindowBroken = (_w, s) => {
			this.broken += 1;
			out.queue({ t: WorldEv.DoorSet, id: s.id, state: SolidState.Open });
		};
		options.world.windowBudget = Win.WINDOW_BREAKS_PER_TICK;
	}

	/** the start of every tick: the tick's budget, and every survivor's bucket refilled by `dt` (allocates nothing) */
	beginTick(dt: number): void {
		this.world.windowBudget = Win.WINDOW_BREAKS_PER_TICK;
		const t = this.tokens;
		for (let i = 0; i < MAX_PLAYERS; i++) {
			if (t[i] < WINDOW_BREAK_BURST) t[i] = math.min(WINDOW_BREAK_BURST, t[i] + WINDOW_BREAK_RATE * dt);
		}
	}

	/**
	 * A survivor breaks pane `s` by hand -- an E press meant for the glass, or the blade of a swing that crossed it:
	 * within `reach` of its edge (plus the slack), with a clear line from the SERVER's position of the survivor to the
	 * glass (`paneAtHand`), within their rate.
	 */
	byHand(slot: number, p: PlayerState, s: Solid, reach: number): WindowOutcome {
		if (p.dead || !Win.windowIntact(s) || slot < 0 || slot >= MAX_PLAYERS) return "none";
		// the client's hint asked the very same test (shared/sim/interactQuery.ts `paneAtHand`), without the slack
		const at = paneAtHand(this.world, s, p.x, p.y, reach + WINDOW_REACH_SLACK);
		if (at !== "ok") return this.refuse(slot, at);
		const left = this.tokens[slot];
		if (left < 1) return this.refuse(slot, "rate");
		const outcome = this.shatter(s);
		if (outcome === "broken") this.tokens[slot] = left - 1;
		return outcome;
	}

	/**
	 * A bullet, an arrow or a turret's shot stopped at pane `s` (the ray: the weapon's range, never through a wall). The
	 * shot is already paid for -- cadence, ammunition, charge -- so there is no bucket here; the tick's budget holds.
	 */
	byShot(s: Solid): WindowOutcome {
		if (!Win.windowIntact(s)) return "none";
		return this.shatter(s);
	}

	/**
	 * An E press meant for the glass found no pane at hand from the SERVER's position (a client that asked from across
	 * the street, or a latency spike): refused as out of reach, and counted like one.
	 */
	missed(slot: number): WindowOutcome {
		if (slot < 0 || slot >= MAX_PLAYERS) return "none";
		return this.refuse(slot, "range");
	}

	/** the attempts by hand the survivor in `slot` had refused -- out of reach, through a wall, past the rate (§9.3) */
	refusedOf(slot: number): number {
		return this.refusals[slot] ?? 0;
	}

	/** a survivor left: their bucket and their evidence go with the slot */
	remove(slot: number): void {
		if (slot < 0 || slot >= MAX_PLAYERS) return;
		this.tokens[slot] = WINDOW_BREAK_BURST;
		this.refusals[slot] = 0;
	}

	/** this town is over (MP-22): it stops feeding the outbox */
	detach(): void {
		this.world.onWindowBroken = undefined;
		this.world.windowBudget = undefined;
	}

	private refuse(slot: number, why: "range" | "blocked" | "rate"): WindowOutcome {
		this.refused[why] += 1;
		this.refusals[slot] += 1;
		return why;
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
