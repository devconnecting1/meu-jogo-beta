/*
 * The match clock and the night waves, on the server (docs/MULTIPLAYER.md §3.1 step 2, §4.5, §4.6, §11.3 F2-2B).
 *
 * Why this file exists: the clock used to be client/systems/daynight.ts, running once per client. Two survivors
 * on the same server could therefore be at different hours, and the 19h / 22h / 1h waves reached each of them at
 * a different moment. In a game whose entire tension is "hold out until dawn", that is the clock of the whole
 * match out of sync — one player lighting a campfire while the other is already being overrun. From F2 on the
 * server is the ONLY thing that knows what time it is: it ticks this object, sends WorldEv.Clock (§4.5) and the
 * clients replay it between two deltas with the same pure rules (shared/sim/clock.ts).
 *
 * What does NOT change: the original's wave table (shared/data/spawns.ts, sys_spawn_time_light). The queues are
 * filled once, between 18:00 and 18:30, with exactly `pop.waveN` walkers and `pop.specialWaveN` specials, and
 * they pour from 19:00, 22:00 and 01:00. The F1 pacing director (shared/sim/ai/director.ts) still only stretches
 * the INTERVAL between two wave spawns, inside its own limits — a relief paces a wave, it never shortens one.
 * This module owns no spawn interval at all, so there is nothing here for the director to fight with.
 *
 * What this file deliberately does not know about: clusters. §3.5 fills the queues per cluster with `pop.waveN ×
 * S(k)`; with one cluster S(1) = 1, which is what `waveQueues` holds. server/sim/population.ts subscribes to
 * `onWaveFill` and splits the very same promised total across the clusters, so the night's headcount is decided
 * here, in one place, whatever the group does.
 *
 * Pure module: no Instances, no services, no os.clock, no RunService. The caller feeds `step(dt)` once per
 * simulation tick and drains the events; the only randomness is the daily rain roll, which is injectable.
 */
import { DESIGN } from "shared/engine/constants";
import { chance } from "shared/engine/rng";
import { getDayPopulation } from "shared/data/spawns";
import { difficultyOfDay } from "shared/game/save";
import { CLOCK_RESYNC_S } from "shared/net/mpConfig";
import { AnnounceKind, WAnnounce, WClock, WorldEv } from "shared/net/protocol";
import { AiClock } from "shared/sim/ai/context";
import {
	CLOCK_ANNOUNCEMENTS,
	HOURS_PER_DAY,
	WAVE_FILL_FROM,
	advanceClock,
	crossed,
	darkAlphaAt,
	inWaveFillWindow,
	isNightAt,
	normalizeClock,
	rainPossible,
	soundMattersAt,
	waveActive,
	waveFlagsAt,
} from "shared/sim/clock";

/** the night's promised headcount, the moment it is decided (§3.5 splits it per cluster) */
export interface WaveFill {
	/** world day the night belongs to */
	day: number;
	/** walkers promised by waves 1, 2 and 3 — the original's table, untouched */
	walkers: Array<number>;
	/** specials promised by waves 1, 2 and 3 */
	specials: Array<number>;
}

/** an hour worth telling everyone about: ready for the Announce delta (§4.5) and for a local HUD */
export interface WorldAnnouncement {
	/** AnnounceKind */
	msg: number;
	arg: number;
	/** the same English text client/systems/daynight.ts used to push into the HUD */
	text: string;
}

export interface WorldClockOptions {
	/** world day the server starts on (§6.2: the WORLD's day, not any survivor's record) */
	day?: number;
	/** hour the server starts at; a run opens at 07:00 like the original */
	dayTime?: number;
	/**
	 * Rain roll for a new day, injected so a test can script the weather. The default is the original's:
	 * 10 % of days, never in the first four (`if day<=4 weather = 0`).
	 */
	rollRain?: (day: number) => boolean;
}

/**
 * Index (0–2) of the first wave that is pouring AND still owes zombies, or -1.
 *
 * The spawner asks this every wave interval and takes ONE zombie from the queue it names, which is the
 * original's trickle. It lives here, next to the queues, so the client mirror and the server spawner cannot
 * disagree about which wave is being served.
 */
export function pouringWave(clock: AiClock, queues: Array<number>): number {
	if (clock.wave1Active && queues[0] > 0) return 0;
	if (clock.wave2Active && queues[1] > 0) return 1;
	if (clock.wave3Active && queues[2] > 0) return 2;
	return -1;
}

/**
 * The server's clock. Implements AiClock (shared/sim/ai/context.ts), which is the interface the horde and the
 * population already read — so server/sim/zombies.ts and server/sim/population.ts take this object exactly
 * where the client passed its DayNight, with no adapter in between.
 */
export class WorldClock implements AiClock {
	day = 1;
	dayTime = 7;
	difficulty = 0;
	darkAlpha = 0;
	isNight = false;
	isRaining = false;
	ambientTarget = 5;
	ambientSpecialMax = 0;
	waveQueues: Array<number> = [0, 0, 0];
	specialWaveQueues: Array<number> = [0, 0, 0];
	wave1Active = false;
	wave2Active = false;
	wave3Active = false;
	/** +1 every time the clock passes 07:00 — the horde makes non-wave zombies lose the trail then */
	morningCount = 0;

	/** the night's headcount was just decided: §3.5 splits it per cluster from here */
	onWaveFill?: (fill: WaveFill) => void;
	/** the clock rolled past midnight into `day`: §3.6 pays everyone who lived through it */
	onNewDay?: (day: number) => void;

	private readonly rollRain: (day: number) => boolean;
	/** the 18:00–18:30 fill happens once per night */
	private fillDone = false;
	/** seconds since the last Clock delta went out (§4.5: at least every CLOCK_RESYNC_S) */
	private sinceSend = CLOCK_RESYNC_S;
	/** what the last Clock delta said, so a change can be detected without re-encoding it */
	private sentDay = -1;
	private sentRain = false;
	private sentFlags = -1;
	/** an admin moved something the change detection cannot see (the hour inside one segment) */
	private forceSend = false;
	private readonly pending = new Array<WorldAnnouncement>();

	constructor(options: WorldClockOptions = {}) {
		this.rollRain = options.rollRain ?? defaultRainRoll;
		this.restart(options.day, options.dayTime);
	}

	/**
	 * A clock as a new server opens it — day `day` (1) at `dayTime` (07:00), the day's rain rolled, no night
	 * promised, nothing waiting to be announced — WITHOUT a new object: the horde, the simulation and the
	 * replication all hold this one, and so do the `onNewDay` / `onWaveFill` subscriptions (MP-22: the world that
	 * ended gives way to a new one on day 1; server/sim/worldReset.ts). The next Clock delta goes out at once, so
	 * every client jumps to the new hour instead of easing towards it.
	 */
	restart(day = 1, dayTime = 7): void {
		this.day = math.max(1, math.floor(day));
		this.dayTime = math.clamp(dayTime, 0, HOURS_PER_DAY - 1e-6);
		for (let i = 0; i < 3; i++) {
			this.waveQueues[i] = 0;
			this.specialWaveQueues[i] = 0;
		}
		this.morningCount = 0;
		this.fillDone = false;
		this.pending.clear();
		this.forceSend = true;
		this.isRaining = this.rollRain(this.day);
		this.refresh();
	}

	// ---------------------------------------------------------------- the tick (§3.1 step 2)

	/**
	 * One simulation step. `dt` is the server's fixed TICK_DT, but nothing here depends on that: the clock
	 * maths splits the step at the speed changes (shared/sim/clock.ts), so a catch-up tick, a 30 Hz fallback
	 * server (§3.1) and a client replaying ten seconds in one go all land on the same hour.
	 */
	step(dt: number): void {
		if (!(dt > 0)) {
			this.refresh();
			return;
		}
		this.sinceSend += dt;
		// the HUD's "is it night" is the hour the step STARTS in, the way the client always read it
		this.isNight = isNightAt(this.dayTime);
		const prev = this.dayTime;
		const norm = normalizeClock(this.day, advanceClock(prev, dt));
		// the hour lands BEFORE the day rolls, so an onNewDay listener (§3.6 pays for the day just lived)
		// reads the clock it is being told about instead of the one a tick ago
		this.dayTime = norm.dayTime;
		while (this.day < norm.day) {
			this.day += 1;
			this.startDay();
		}
		this.detectAnnounce(prev, this.dayTime);
		this.updateWaves();
		this.updateDark();
	}

	/** daytime without rain: footsteps and shots are worth simulating (sys_sound_view) */
	soundMatters(): boolean {
		return soundMattersAt(this.dayTime, this.isRaining);
	}

	// ---------------------------------------------------------------- replication (§4.5, §4.6)

	/**
	 * The Clock delta when one is due — a change of day, rain or wave flags, or CLOCK_RESYNC_S since the last
	 * one — and undefined otherwise. Call it once per tick and queue whatever comes back for everyone.
	 */
	clockEvent(tick: number): WClock | undefined {
		const flags = waveFlagsAt(this.dayTime);
		const changed =
			this.forceSend || this.day !== this.sentDay || this.isRaining !== this.sentRain || flags !== this.sentFlags;
		if (!changed && this.sinceSend < CLOCK_RESYNC_S) return undefined;
		this.forceSend = false;
		this.sinceSend = 0;
		this.sentDay = this.day;
		this.sentRain = this.isRaining;
		this.sentFlags = flags;
		return this.clockEventNow(tick);
	}

	/**
	 * The clock as a delta right now, WITHOUT touching the broadcast schedule: the block a single joining
	 * client gets in its WorldInit (§4.5, §7.1). Someone joining must not reset the resync timer of the
	 * survivors who were already here.
	 */
	clockEventNow(tick: number): WClock {
		return {
			t: WorldEv.Clock,
			worldDay: this.day,
			dayTime: this.dayTime,
			tick,
			rain: this.isRaining,
			waveFlags: waveFlagsAt(this.dayTime),
		};
	}

	/** the announcements this tick produced, cleared as they are taken (§4.5 Announce) */
	takeAnnouncements(): Array<WorldAnnouncement> {
		if (this.pending.size() === 0) return [];
		const out = new Array<WorldAnnouncement>();
		for (const a of this.pending) out.push(a);
		this.pending.clear();
		return out;
	}

	/** an announcement as the World channel wants it */
	announceEvent(a: WorldAnnouncement): WAnnounce {
		return { t: WorldEv.Announce, msg: a.msg, arg: a.arg };
	}

	// ---------------------------------------------------------------- admin (§10)

	/**
	 * Move the clock without paying for the hours skipped (§3.6: an admin skip credits nobody) and without
	 * announcing them. The next Clock delta goes out immediately, and a client whose error is now larger than
	 * §4.6's threshold jumps instead of easing — which is what an admin asking for night expects to see.
	 *
	 * It moves the clock and NOTHING else, the way client/admin/world.ts always did it: an admin skipping
	 * into the dark calls `fillNight()` first, so the night it lands in has a horde. Doing it here instead
	 * would re-promise a wave the survivors had already beaten whenever the clock was nudged after dusk.
	 */
	setClock(dayTime: number, day?: number): void {
		if (day !== undefined) this.day = math.max(1, math.floor(day));
		this.dayTime = math.clamp(dayTime, 0, HOURS_PER_DAY - 1e-6);
		this.forceSend = true;
		this.refresh();
	}

	setRain(on: boolean): void {
		this.isRaining = on;
		this.forceSend = true;
		this.updateDark();
	}

	/**
	 * Fill tonight's queues now (admin "force wave", and the 18:00 window itself).
	 *
	 * Every night gets the table of ITS OWN day, full stop: the queues are always overwritten with
	 * `getDayPopulation(this.day)`, whatever they still held. A night nobody finished (MP-21: a private server
	 * waits for its own owner, so a solo survivor's horde can sit queued past dawn) used to leave its leftovers
	 * standing in for the NEXT night's numbers, because the old guard only refilled a queue that was already
	 * empty -- measured as low as 5/3/6 = 14 instead of the promised 5/5/10 = 20. A leftover is discarded
	 * instead: it neither adds to the new promise nor substitutes for it, so a player is never quietly short a
	 * night because a previous one went undelivered. Called with no other args every dusk, this is also exactly
	 * what an admin's "force wave" wants -- a hard reset, not a merge with whatever the horde still owed.
	 */
	fillNight(): void {
		const pop = getDayPopulation(this.day);
		const walkers = [pop.wave1, pop.wave2, pop.wave3];
		const specials = [pop.specialWave1, pop.specialWave2, pop.specialWave3];
		for (let i = 0; i < 3; i++) {
			this.waveQueues[i] = walkers[i];
			this.specialWaveQueues[i] = specials[i];
		}
		this.fillDone = true;
		if (this.onWaveFill !== undefined) this.onWaveFill({ day: this.day, walkers, specials });
	}

	// ---------------------------------------------------------------- internals

	/** everything that is a pure function of (day, dayTime, rain), with no crossing detection */
	private refresh(): void {
		this.isNight = isNightAt(this.dayTime);
		this.refreshPopulation();
		this.updateWaves();
		this.updateDark();
	}

	/** midnight: a new world day, new weather and a new quota (§3.6 pays the survivors through onNewDay) */
	private startDay(): void {
		this.isRaining = this.rollRain(this.day);
		this.refreshPopulation();
		if (this.onNewDay !== undefined) this.onNewDay(this.day);
	}

	private refreshPopulation(): void {
		const pop = getDayPopulation(this.day);
		this.ambientTarget = pop.ambient;
		this.ambientSpecialMax = pop.ambientSpecial;
		this.difficulty = difficultyOfDay(this.day);
	}

	private detectAnnounce(prev: number, cur: number): void {
		for (const a of CLOCK_ANNOUNCEMENTS) {
			if (!crossed(prev, cur, a.hour)) continue;
			if (a.morning) this.morningCount += 1;
			this.pending.push(announcementOf(a.hour, a.text));
		}
	}

	private updateWaves(): void {
		if (inWaveFillWindow(this.dayTime) && !this.fillDone) this.fillNight();
		// past the window and before it again: the next dusk is allowed to promise a new night
		if (this.dayTime < WAVE_FILL_FROM) this.fillDone = false;
		this.wave1Active = waveActive(1, this.dayTime);
		this.wave2Active = waveActive(2, this.dayTime);
		this.wave3Active = waveActive(3, this.dayTime);
	}

	/**
	 * The world's darkness, WITHOUT anybody's "Nocturnal" skill: on a server the night is one night. That
	 * skill is per survivor, so it stays where it belongs — the client applies it to what it draws, and the
	 * horde's perception applies it per survivor from that survivor's own save (§3.3).
	 */
	private updateDark(): void {
		this.darkAlpha = darkAlphaAt(this.dayTime, this.isRaining, false);
	}
}

/** original: 10 % rainy days, but never during the first four (`if day<=4 weather = 0`) */
function defaultRainRoll(day: number): boolean {
	return rainPossible(day) && chance(DESIGN.WEATHER_PERCENT);
}

/** CLOCK_ANNOUNCEMENTS carries the text; the wire carries an AnnounceKind and an argument (§4.5) */
function announcementOf(hour: number, text: string): WorldAnnouncement {
	if (hour === 19) return { msg: AnnounceKind.Wave, arg: 1, text };
	if (hour === 22) return { msg: AnnounceKind.Wave, arg: 2, text };
	if (hour === 1) return { msg: AnnounceKind.Wave, arg: 3, text };
	return { msg: AnnounceKind.Morning, arg: 0, text };
}
