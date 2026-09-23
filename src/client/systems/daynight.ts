import { DESIGN } from "shared/engine/constants";
import { chance } from "shared/engine/rng";
import { difficultyOfDay, PlayerSaveData, SAVE_LIMITS } from "shared/game/save";
import { getDayPopulation } from "shared/data/spawns";
import { MP_PHASE } from "shared/net/mpConfig";
import {
	advanceClock,
	CLOCK_ANNOUNCEMENTS,
	clockSpeed,
	crossed,
	darkAlphaAt,
	DAY_BREAK_HOUR,
	gameHours,
	HOURS_PER_DAY,
	inWaveFillWindow,
	isNightAt,
	normalizeClock,
	rainPossible,
	secondsUntilHour,
	soundMattersAt,
	WAVE_FILL_FROM,
	waveActive,
	waveActiveInFlags,
} from "shared/sim/clock";

/**
 * The run's clock, weather and night-wave queues. The clock rules themselves are pure and shared
 * (shared/sim/clock.ts, docs/MULTIPLAYER.md §4.6); this class only holds the state.
 *
 * It runs in one of two modes, and the public surface is the same in both — everything that reads the clock
 * (the HUD, the shadows, the horde, the coach, the audio) never has to know which one is on:
 *
 *   local (MP_PHASE < 2)   the clock is this client's own: it advances it, rolls the rain and fills the
 *                          night's queues. That is the single-player game, unchanged.
 *   server-driven (≥ 2)    the server owns the hour, the weather and the waves (server/sim/waves.ts) and
 *                          sends them as WorldEv.Clock. `applyClock` takes that truth; `update` REPLAYS it
 *                          between two deltas with the same pure rules and eases the visible clock onto it.
 *                          The light is still smooth every frame; only its truth arrives over the wire.
 *
 * Why the eased correction instead of writing the received hour straight in: darkAlpha is a function of the
 * hour, and it moves by roughly 0.48 per game hour. Snapping the clock ten times a minute would be ten
 * visible flickers of the whole screen. §4.6 draws the line at 0.05 h: under it the error is bled off, over
 * it (an admin moved the clock) the clock jumps, because that is what an admin asked for.
 */

/** §4.6: a clock error bigger than this jumps instead of being eased (hours) */
export const CLOCK_SNAP_H = 0.05;
/** the eased correction never runs faster than this fraction of the clock's own speed, so time never stops */
const CLOCK_CATCHUP = 0.25;
/** the same text is not announced twice inside this many seconds (see `announce`) */
const ANNOUNCE_DEDUPE_S = 3;

/** WorldEv.Clock as this class needs it (shared/net/protocol.ts WClock, minus the wire fields) */
export interface ClockUpdate {
	/** the WORLD's day (§6.2), which is not any survivor's own day counter */
	worldDay: number;
	dayTime: number;
	rain: boolean;
	/** raw wave bits (shared/sim/clock.ts WAVE_FLAG_*) */
	waveFlags: number;
}

export class DayNight {
	dayTime = 7;
	day = 1;
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
	/** +1 every time the clock passes 7:00 — zombieAI makes non-wave zombies lose the trail then */
	morningCount = 0;
	onAnnounce: (msg: string) => void = () => {};

	private save: PlayerSaveData;
	private fillDone = false;
	/** a Clock delta has been accepted: the server owns the hour from now on */
	private driven = false;
	/** the server's clock, replayed forward frame by frame; the visible one is eased onto it */
	private srvDay = 0;
	private srvDayTime = 0;
	private srvFlags = 0;
	/** the visible clock was just jumped: the hours it flew over announce nothing (§3.6 skipped hours) */
	private snapped = false;
	private elapsed = 0;
	private lastAnnounce = "";
	private lastAnnounceAt = -ANNOUNCE_DEDUPE_S - 1;

	constructor(save: PlayerSaveData) {
		this.save = save;
		// `day` is the WORLD's day (§6.2, MP-13). Alone in your own world the two are the same number, which
		// is why the survivor's own day seeds it; on a shared server the first Clock delta (or `adoptWorld`)
		// replaces it at once, because nothing a single survivor does may decide what day the town is on.
		this.day = save.day;
		this.dayTime = 7;
		this.difficulty = difficultyOfDay(this.day);
		this.isRaining = this.rollRain();
		this.refreshPopulation();
	}

	/** original: 10% rainy days, but never during the first four days (`if day<=4 weather = 0`) */
	private rollRain(): boolean {
		return rainPossible(this.day) && chance(DESIGN.WEATHER_PERCENT);
	}

	/**
	 * Daytime hours in which noise matters (sys_sound_view: 6 < t < 18 and no rain). At night and in
	 * the rain every zombie already hunts the player, so footsteps/shots add nothing.
	 */
	soundMatters(): boolean {
		return soundMattersAt(this.dayTime, this.isRaining);
	}

	// ---------------------------------------------------------------- the server's clock (§4.5, §4.6)

	/** is the hour coming from the server? (false in the single-player build and until the first delta) */
	serverDriven(): boolean {
		return this.driven;
	}

	/** real seconds until the night ends (MP-21); 0 in broad daylight, because it already has */
	secondsUntilDayBreak(): number {
		return secondsUntilHour(this.dayTime, DAY_BREAK_HOUR);
	}

	/**
	 * MP-20: take the WORLD's clock over from the DayNight of the run that just ended.
	 *
	 * "New game" starts a new life, not a new world. The clock belongs to the town, and the town does not
	 * care that this survivor decided to start over -- so when the loop rebuilds itself around a fresh map
	 * (client/gameLoop.ts `init`), the hour, the day, the weather and the waves come across untouched.
	 *
	 * Without this the new DayNight opened at `save.day` and 07:00, which is day 1 at sunrise after a
	 * `resetRun`: on a shared server one survivor read "Day 1 Morning" while the other read "Day 2 Evening",
	 * and the screen stayed bright through the night until the next Clock delta (up to CLOCK_RESYNC_S away,
	 * §4.5) snapped it back. Returns false when there is nothing to take over -- the single-player build, or
	 * the very first run of a session, where the first Clock delta is what starts the clock instead.
	 */
	adoptWorld(previous: DayNight): boolean {
		if (MP_PHASE < 2 || !previous.driven) return false;
		this.driven = true;
		this.srvDay = previous.srvDay;
		this.srvDayTime = previous.srvDayTime;
		this.srvFlags = previous.srvFlags;
		this.day = previous.day;
		this.dayTime = previous.dayTime;
		this.isRaining = previous.isRaining;
		this.morningCount = previous.morningCount;
		// the hours between the two runs were lived by the town, not by this survivor: they announce nothing
		this.snapped = true;
		this.isNight = isNightAt(this.dayTime);
		this.applyServerWaves();
		this.refreshPopulation();
		this.updateDark();
		return true;
	}

	/**
	 * A WorldEv.Clock delta (§4.5). `ageS` is how long ago the server sampled it — `(clientTick − ev.tick) /
	 * simHz` from client/net/clockSync.ts — so the truth is replayed forward before being compared with what
	 * is on screen, and a 100 ms trip does not read as a 100 ms error to be corrected every ten seconds.
	 *
	 * Returns false (and changes nothing) below MP_PHASE 2: until the server actually owns the world, a
	 * stray delta must not be able to take the clock away from a client that is still simulating for itself.
	 */
	applyClock(c: ClockUpdate, ageS = 0): boolean {
		if (MP_PHASE < 2) return false;
		if (c.worldDay < 1) return false;
		const aged = normalizeClock(c.worldDay, advanceClock(c.dayTime, math.max(0, ageS)));
		this.srvDay = aged.day;
		this.srvDayTime = aged.dayTime;
		this.srvFlags = c.waveFlags;
		this.isRaining = c.rain;
		const drift = gameHours(aged.day, aged.dayTime) - gameHours(this.day, this.dayTime);
		if (!this.driven || math.abs(drift) > CLOCK_SNAP_H) {
			this.driven = true;
			this.snapTo(aged.day, aged.dayTime);
		}
		this.applyServerWaves();
		this.updateDark();
		return true;
	}

	/**
	 * A server Announce (§4.5) reaching the HUD. It goes through the same dedupe as the locally detected
	 * crossings: while F2-2D is wiring the Announce channel up, a client may briefly have both sources, and
	 * seeing "Wave 1" twice is worse than seeing it once from whichever arrived first.
	 */
	announce(text: string): void {
		if (text === this.lastAnnounce && this.elapsed - this.lastAnnounceAt < ANNOUNCE_DEDUPE_S) return;
		this.lastAnnounce = text;
		this.lastAnnounceAt = this.elapsed;
		this.onAnnounce(text);
	}

	private snapTo(day: number, dayTime: number): void {
		this.day = day;
		this.dayTime = dayTime;
		this.snapped = true;
		this.isNight = isNightAt(dayTime);
		this.refreshPopulation();
	}

	/**
	 * Which wave is pouring is the SERVER's answer, never this client's hour (§4.6). `waveQueues` is left
	 * alone on purpose: from MP_PHASE 2 the horde is spawned by server/sim/spawner.ts out of the queues
	 * server/sim/waves.ts filled, and a client that also filled its own would be promising a second night.
	 */
	private applyServerWaves(): void {
		this.wave1Active = waveActiveInFlags(this.srvFlags, 1);
		this.wave2Active = waveActiveInFlags(this.srvFlags, 2);
		this.wave3Active = waveActiveInFlags(this.srvFlags, 3);
	}

	// ---------------------------------------------------------------- shared bookkeeping

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
			this.announce(a.text);
		}
	}

	private updateWaves(): void {
		if (inWaveFillWindow(this.dayTime) && !this.fillDone) {
			const pop = getDayPopulation(this.day);
			this.waveQueues = [pop.wave1, pop.wave2, pop.wave3];
			this.specialWaveQueues = [pop.specialWave1, pop.specialWave2, pop.specialWave3];
			this.fillDone = true;
		}
		if (this.dayTime < WAVE_FILL_FROM) {
			this.fillDone = false;
		}
		this.wave1Active = waveActive(1, this.dayTime);
		this.wave2Active = waveActive(2, this.dayTime);
		this.wave3Active = waveActive(3, this.dayTime);
	}

	private updateDark(): void {
		// deepest night is capped (the renderer punches light holes around the player and lamps/campfires into
		// it); "Nocturnal" keeps the original 0.05 advantage. This stays a CLIENT decision even when the hour
		// comes from the server: the skill belongs to this survivor, and the server's own darkness (the one
		// the horde sees) is the plain one, with nobody's skill in it.
		this.darkAlpha = darkAlphaAt(this.dayTime, this.isRaining, this.save.skillLevels[16] > 0);
	}

	// ---------------------------------------------------------------- the frame

	update(dt: number): void {
		this.elapsed += math.max(0, dt);
		if (this.driven) {
			this.followServer(dt);
			return;
		}
		this.isNight = isNightAt(this.dayTime);
		// original: the night runs 1.2× and the day 0.8× the base clock speed
		const prev = this.dayTime;
		this.dayTime = advanceClock(prev, dt);
		if (this.dayTime >= HOURS_PER_DAY) {
			this.dayTime -= HOURS_PER_DAY;
			this.day += 1;
			this.save.day = this.day;
			this.isRaining = this.rollRain();
			this.refreshPopulation();
		}
		this.detectAnnounce(prev, this.dayTime);
		this.updateWaves();
		this.updateDark();
	}

	/**
	 * One frame of the server-driven clock.
	 *
	 * Two clocks move here. `srv*` is the server's, replayed with the very same pure rule the server ticks
	 * with — so a lost or late Clock delta costs accuracy, never continuity: with no delta at all for a whole
	 * minute the replay still walks through dusk, midnight and dawn in order, and the next delta only nudges
	 * it. The visible clock follows it at a bounded rate, which is what keeps the night from flickering.
	 */
	private followServer(dt: number): void {
		if (!(dt > 0)) {
			this.isNight = isNightAt(this.dayTime);
			this.applyServerWaves();
			this.updateDark();
			return;
		}
		const replayed = normalizeClock(this.srvDay, advanceClock(this.srvDayTime, dt));
		this.srvDay = replayed.day;
		this.srvDayTime = replayed.dayTime;

		this.isNight = isNightAt(this.dayTime);
		const prev = this.dayTime;
		let advanced = advanceClock(prev, dt);
		// bleed the error off at a fraction of the clock's own speed: the correction can never stop time, let
		// alone run it backwards (the pull is at most a quarter of the step it is correcting)
		const drift = gameHours(replayed.day, replayed.dayTime) - gameHours(this.day, advanced);
		const maxPull = clockSpeed(prev) * CLOCK_CATCHUP * dt;
		advanced += math.clamp(drift, -maxPull, maxPull);

		const norm = normalizeClock(this.day, advanced);
		if (norm.day !== this.day) {
			this.day = norm.day;
			// no rain roll here: the weather is the server's (§3.6). `save.day` is NOT the world's day, it is
			// this survivor's own (§6.2, MP-13), so it does not follow `this.day` -- it is bumped by one,
			// mirroring what server/sim/progress.ts `creditDaySurvived` just did to the authoritative copy.
			// The mirror is for the HUD: a report's `day` is pinned by `stripClientProgress`, so it can never
			// inflate anything, and the next LoadAck replaces it with the server's number either way.
			this.save.day = math.min(SAVE_LIMITS.DAY_MAX, this.save.day + 1);
			this.refreshPopulation();
		}
		this.dayTime = norm.dayTime;
		if (this.snapped) this.snapped = false;
		else this.detectAnnounce(prev, this.dayTime);
		this.applyServerWaves();
		this.updateDark();
	}
}
