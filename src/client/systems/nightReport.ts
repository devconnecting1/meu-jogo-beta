/*
 * The night in numbers, for the dawn card (client/ui/dawnCard.ts; docs/DESIGN_RULES.md BEM-04: the night ends well).
 *
 * The research (docs/research/MOTIVATION_AND_ETHICS.md §2.12, §4.7) asks for the one healthy stopping point the game
 * has -- dawn, after a night won -- to be CLOSED: what the night was, and the truth about what is saved. This file only
 * counts; it decides nothing about saving and shows nothing.
 *
 *   zombies   the killing blows the SERVER credited to this survivor over the night (`save.zombieKills`, the counter the
 *             wallet push mirrors; MON-05): never a guess made here
 *   damage    the health this survivor lost over the night: in a session the SERVER's hp, read from the last self block
 *             (client/net/netClient.ts `netSelfHp`) -- never the prediction, whose wobble around each ack would count
 *             as hits; offline the body's own. Every bite, blast, poison tick and empty-stomach tick; a heal never
 *             takes a hit back
 *   items     the pickups client/systems/pickups.ts counted: only the ones the server made for THIS survivor
 *
 * A night counts from the first frame this survivor is alive in the city after nightfall (or after a Rebirth in it) to
 * the first frame of daylight. A death drops it (the death screen says what happened; no card for a night lost), and so
 * does leaving the city. A night lived for less than MIN_NIGHT_SHARE of its length (a survivor who walked in at 05:50)
 * earns no card: there was no night to report. Pure: no Instances, no services.
 */
import { MIN_NIGHT_SHARE, NIGHT_LIVED_S } from "shared/data/wellbeing";

export { MIN_NIGHT_SHARE };

/** what the dawn card says about the night */
export interface NightReport {
	zombies: number;
	damage: number;
	items: number;
}

/** one frame of what the tally reads */
export interface NightSample {
	/** the world clock is at night (shared/sim/clock.ts isNightAt) */
	night: boolean;
	/** a survivor standing in the city: in a run, not dead */
	alive: boolean;
	hp: number;
	/** the server's lifetime kill credit, as the wallet mirrors it */
	kills: number;
	/** client/systems/pickups.ts `pickupCount()` */
	pickups: number;
	/** seconds (os.clock()) */
	now: number;
}

export class NightTally {
	private on = false;
	private since = 0;
	private kills0 = 0;
	private pickups0 = 0;
	private damage = 0;
	private lastHp = 0;

	/** is a night being counted right now (tests) */
	counting(): boolean {
		return this.on;
	}

	/** forget the night (a new world, the lobby) */
	reset(): void {
		this.on = false;
	}

	/**
	 * One frame. Returns the report on the first frame of daylight after a night lived long enough, and undefined on
	 * every other frame -- so a caller shows at most one card per dawn.
	 */
	step(s: NightSample): NightReport | undefined {
		if (!s.alive) {
			this.on = false;
			return undefined;
		}
		if (s.night) {
			if (!this.on) {
				this.on = true;
				this.since = s.now;
				this.kills0 = s.kills;
				this.pickups0 = s.pickups;
				this.damage = 0;
				this.lastHp = s.hp;
				return undefined;
			}
			if (s.hp < this.lastHp) this.damage += this.lastHp - s.hp;
			this.lastHp = s.hp;
			return undefined;
		}
		if (!this.on) return undefined;
		this.on = false;
		if (s.now - this.since < NIGHT_LIVED_S) return undefined;
		return {
			zombies: math.max(0, s.kills - this.kills0),
			damage: math.max(0, math.floor(this.damage + 0.5)),
			items: math.max(0, s.pickups - this.pickups0),
		};
	}
}

/**
 * The break line (BEM-04, research §4.7 recommendation 3) is the SERVER's decision (shared/data/wellbeing.ts
 * `breakNudgeEarned`, told as `Announce{BreakNudge}`): this client only shows it. On the dawn card when the card is up
 * (or comes up within this many seconds of being told: the two dawns, the server's and this client's, are a frame or
 * two apart); otherwise, on the message feed -- a line the server counted is always a line the player saw.
 */
export const BREAK_CARD_WAIT_S = 3;
