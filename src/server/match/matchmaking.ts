/*
 * The server attributes of custom matchmaking (docs/MULTIPLAYER.md §7.4, docs/DESIGN_RULES.md MP-24). Pure: the
 * MatchmakingService calls are the `MatchmakingPort` server/match/matchHost.ts plugs in.
 *
 * What the platform offers (engine reference `MatchmakingService`, the guide "Attributes and signals" -- Context7
 * `/websites/create_roblox`, read 2026-09-24): `SetServerAttribute(name, value) -> (success, errorMessage)`, names and
 * values of at most 50 characters, NON-persistent (they live as long as the server), read by the scoring the Creator
 * Hub configures OUTSIDE the game. It never queues, pairs or teleports anybody: it only weighs the servers a joining
 * player could be put in. A numerical server signal scores `1 - min(|server - target| / maxRelevantDifference, 1)`,
 * the target being a player attribute (read from a data store) or a constant.
 *
 * So the game publishes two numbers, and the owner decides in the Creator Hub how much they weigh:
 *   WorldDay   the world's day (MP-20): a signal "close to 1" (constant 1) sends joining players toward young towns --
 *              the automatic half of P0-1. Friends still weigh 15 by default, more than every other signal together,
 *              so a veteran still lands with their friends.
 *   Survivors  bodies standing in the town now: a town where everybody is dead is about to end (MP-22), and a new
 *              player should rather not arrive in it.
 * Only a PUBLIC server publishes: the matchmaking's filter step never puts anyone in a reserved or private server.
 * A value is sent when it changes, at most once per MIN_GAP_S per attribute; a platform that keeps refusing (the
 * attributes not created in the Creator Hub yet) is asked again only every BACKOFF_S, and warned once.
 */

export const ATTR_WORLD_DAY = "WorldDay";
export const ATTR_SURVIVORS = "Survivors";
/** at most one SetServerAttribute per attribute this often (s) */
export const MIN_GAP_S = 10;
/** after FAILS_BEFORE_BACKOFF refusals in a row, the next try waits this long (s) */
export const FAILS_BEFORE_BACKOFF = 3;
export const BACKOFF_S = 300;

export interface MatchmakingPort {
	/** MatchmakingService:SetServerAttribute, protected: [success, errorMessage] */
	set(name: string, value: number): [boolean, string | undefined];
}

interface Slot {
	sent: number | undefined;
	at: number;
}

export class MatchmakingAttributes {
	private readonly port: MatchmakingPort;
	private readonly slots = new Map<string, Slot>();
	private fails = 0;
	private pausedUntil = -math.huge;
	/** calls made and refused since boot (the audit shows them) */
	sent = 0;
	refused = 0;
	lastError: string | undefined;
	/** a refusal was warned already (once per server: the Error Report groups by message anyway) */
	warned = false;
	private readonly onRefused: (err: string) => void;

	constructor(port: MatchmakingPort, onRefused: (err: string) => void) {
		this.port = port;
		this.onRefused = onRefused;
	}

	/** once a second: each number that moved goes out, within the gap and the back-off */
	update(now: number, worldDay: number | undefined, survivors: number): void {
		if (now < this.pausedUntil) return;
		if (worldDay !== undefined) this.publish(ATTR_WORLD_DAY, math.max(1, math.floor(worldDay)), now);
		if (now < this.pausedUntil) return;
		this.publish(ATTR_SURVIVORS, math.max(0, math.floor(survivors)), now);
	}

	private publish(name: string, value: number, now: number): void {
		let slot = this.slots.get(name);
		if (slot === undefined) {
			slot = { sent: undefined, at: -math.huge };
			this.slots.set(name, slot);
		}
		if (slot.sent === value || now - slot.at < MIN_GAP_S) return;
		slot.at = now;
		const [ok, err] = this.port.set(name, value);
		if (ok) {
			slot.sent = value;
			this.sent += 1;
			this.fails = 0;
			return;
		}
		this.refused += 1;
		this.fails += 1;
		this.lastError = err ?? "refused";
		if (!this.warned) {
			this.warned = true;
			this.onRefused(this.lastError);
		}
		if (this.fails >= FAILS_BEFORE_BACKOFF) {
			this.fails = 0;
			this.pausedUntil = now + BACKOFF_S;
		}
	}

	/** what the platform was last told (undefined: never accepted) */
	value(name: string): number | undefined {
		return this.slots.get(name)?.sent;
	}
}
