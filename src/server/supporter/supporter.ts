/*
 * Who is a Supporter, decided by the SERVER (docs/DESIGN_RULES.md MON-07; the offer itself: shared/data/supporter.ts).
 *
 * The subscription is Roblox's (Experience Subscriptions): the platform sells it, renews it, refunds it. What this
 * module does is ask, keep the answer, and say it:
 *
 *   - ASK: MarketplaceService `GetUserSubscriptionStatusAsync(player, id)` -- which the documentation says must be done
 *     from the server -- when the player joins, when Players `UserSubscriptionStatusChanged` fires for this id (a
 *     purchase, a cancellation, a lapse), after a purchase prompt closed with a try (the platform may take a few seconds
 *     to register it), and every SUPPORTER_REFRESH_S for everybody (a period that ends mid-session). A status event is
 *     never taken as the answer: it only makes the server ask. Each ask is one pcall; a failed one is tried again after
 *     RETRY_S (up to RETRIES times), and until an ask succeeds the last answer stands (a new player: not a Supporter);
 *   - KEEP: the answer per UserId, in this server's memory only. Nothing is written to a DataStore: the platform is the
 *     record, so a lapse needs nothing taken back, and there is nothing to erase for a deletion request (RTBF);
 *   - SAY: the Player attribute SUPPORTER_ATTRIBUTE (`pz_supporter`), true while active and removed otherwise. Attributes
 *     the server sets replicate to every client; one a client sets never leaves it. So every client draws the mark from
 *     the server's word, and a client that marks itself fools only its own screen. Nothing on the server reads the
 *     attribute back: `isSupporter` answers from the kept answer.
 *
 * What a Supporter gets is cosmetic and nothing else (MON-01): the heart on the nameplate (client/ui/nameplate.ts) and
 * the rose swing trail (client/view/survivorView.ts). No coins, XP, loot, title or achievement is ever read from here.
 *
 * With no subscription configured (`supporterOffered()` false) `startSupporter` does nothing: no ask, no attribute.
 *
 * Pure of engine globals: every service comes in through `SupporterServices`, so tools/test-titles.mjs runs the real
 * rules with a fake MarketplaceService and fake Players (active, lapsed, failing, a status event, a client's own mark).
 */
import { SUPPORTER_ATTRIBUTE, SUPPORTER_REFRESH_S, supporterOffered } from "shared/data/supporter";

/** a failed ask is tried again after this long (seconds), up to RETRIES more times */
export const SUPPORTER_RETRY_S = 5;
export const SUPPORTER_RETRIES = 3;
/** after a purchase prompt closed with a try, the platform may need a moment: the server asks again after this */
export const SUPPORTER_PROMPT_RECHECK_S = 10;

/** what GetUserSubscriptionStatusAsync answers (the fields we read) */
export interface SubscriptionStatus {
	IsSubscribed: boolean;
	IsRenewing?: boolean;
}

/** a player as this module needs one: its UserId and its attributes */
export interface SupporterPlayer {
	readonly UserId: number;
	SetAttribute(name: string, value: AttributeValue | undefined): void;
}

/** the engine, handed in (server/supporter.server.ts passes the real services; the tests pass fakes) */
export interface SupporterServices<P extends SupporterPlayer> {
	/** MarketplaceService:GetUserSubscriptionStatusAsync -- yields, may throw */
	status: (player: P, subscriptionId: string) => SubscriptionStatus;
	/** is this player still in the server (a yield may outlast them) */
	present: (player: P) => boolean;
	/** task.delay */
	delay: (seconds: number, fn: () => void) => void;
	/** a status flip seen during a session (docs/ANALYTICS.md "Supporter"); undefined = not counted */
	changed?: (player: P, active: boolean) => void;
	/** a line for the server's output */
	log?: (line: string) => void;
}

/** the answer the server keeps for one player */
interface Known {
	active: boolean;
	/** an ask has succeeded for this player in this session (before that, `active` is the default: false) */
	answered: boolean;
	/** an ask is in flight (a second request waits for it instead of stacking) */
	asking: boolean;
	/** another ask was requested while one was in flight: run once more when it lands */
	again: boolean;
}

export class SupporterStatusBook<P extends SupporterPlayer> {
	private readonly id: string;
	private readonly services: SupporterServices<P>;
	private readonly known = new Map<number, Known>();

	constructor(subscriptionId: string, services: SupporterServices<P>) {
		this.id = subscriptionId;
		this.services = services;
	}

	/** is the subscription on offer at all (a real id configured)? Nothing below does anything otherwise */
	offered(): boolean {
		return supporterOffered(this.id);
	}

	/** the server's word: is this player's subscription active, as the last successful ask said? */
	isSupporter(userId: number): boolean {
		return this.known.get(userId)?.active === true;
	}

	/**
	 * Asks the platform for `player` now (yields). `why` is only for the log. A failure keeps the last answer and is
	 * tried again after SUPPORTER_RETRY_S, SUPPORTER_RETRIES times at most; an ask requested while one is in flight
	 * runs once more when it lands (so a status event right after a join is never lost).
	 */
	check(player: P, why: string, retriesLeft = SUPPORTER_RETRIES): void {
		if (!this.offered() || !this.services.present(player)) return;
		const userId = player.UserId;
		let k = this.known.get(userId);
		if (k === undefined) {
			k = { active: false, answered: false, asking: false, again: false };
			this.known.set(userId, k);
		}
		if (k.asking) {
			k.again = true;
			return;
		}
		k.asking = true;
		const [ok, result] = pcall(() => this.services.status(player, this.id));
		k.asking = false;
		// the player may have left while the platform answered: nothing is kept for somebody gone
		if (!this.services.present(player) || this.known.get(userId) !== k) return;
		if (!ok || !typeIs(result, "table")) {
			this.services.log?.(`supporter status not read (${why}); tried again in ${SUPPORTER_RETRY_S} s`);
			if (retriesLeft > 0) this.services.delay(SUPPORTER_RETRY_S, () => this.check(player, why, retriesLeft - 1));
		} else {
			this.apply(player, k, (result as SubscriptionStatus).IsSubscribed === true);
		}
		if (k.again) {
			k.again = false;
			this.check(player, `${why} (again)`);
		}
	}

	/** the answer landed: kept, said to every client, and a flip during the session counted */
	private apply(player: P, k: Known, active: boolean): void {
		const flipped = k.answered && k.active !== active;
		k.active = active;
		k.answered = true;
		// true while active, REMOVED otherwise (never a false left lying around for a client to read as something)
		player.SetAttribute(SUPPORTER_ATTRIBUTE, active ? true : undefined);
		if (flipped) this.services.changed?.(player, active);
	}

	/** Players.UserSubscriptionStatusChanged: only for OUR subscription, and only as a reason to ask */
	statusChanged(player: P, subscriptionId: unknown): void {
		if (subscriptionId !== this.id) return;
		this.check(player, "status changed");
	}

	/** a purchase prompt closed and the player tried to buy: the platform may need a moment to register it */
	promptFinished(player: P, subscriptionId: unknown, didTry: unknown): void {
		if (subscriptionId !== this.id || didTry !== true) return;
		this.services.delay(SUPPORTER_PROMPT_RECHECK_S, () => this.check(player, "prompt"));
	}

	/** the player left: nothing is kept (the platform is the record) */
	forget(player: P): void {
		this.known.delete(player.UserId);
	}

	/** every player kept, asked again (the SUPPORTER_REFRESH_S sweep) */
	refreshAll(players: ReadonlyArray<P>, spawn: (fn: () => void) => void): void {
		if (!this.offered()) return;
		for (const p of players) spawn(() => this.check(p, "refresh"));
	}
}

/** the sweep's period, re-exported for the Script that schedules it */
export { SUPPORTER_REFRESH_S };

/** the book the Script uses (server/supporter.server.ts), so other server code can ask `isSupporter` */
let book: SupporterStatusBook<Player> | undefined;

/** the server's book, once server/supporter.server.ts started it (undefined with no subscription configured) */
export function supporterBook(): SupporterStatusBook<Player> | undefined {
	return book;
}

/** kept for the Script: it builds the book with the real services and hands it here */
export function setSupporterBook(b: SupporterStatusBook<Player> | undefined): void {
	book = b;
}
