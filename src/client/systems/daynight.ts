import { DESIGN } from "shared/engine/constants";
import { difficultyOfDay, PlayerSaveData, PROGRESS_SERVER_PHASE, SAVE_LIMITS } from "shared/game/save";
import { getDayPopulation } from "shared/data/spawns";
import { MP_PHASE } from "shared/net/mpConfig";
import {
	advanceClock,
	CLOCK_ANNOUNCEMENTS,
	clockSpeed,
	crossed,
	DAY_BREAK_HOUR,
	gameHours,
	HOURS_PER_DAY,
	inWaveFillWindow,
	isNightAt,
	normalizeClock,
	secondsUntilHour,
	soundMattersAt,
	WAVE_FILL_FROM,
	waveActive,
	waveActiveInFlags,
} from "shared/sim/clock";
import {
	FLASH_MIN_GAP_S,
	flashReveals,
	flashStrikeSlot,
	fogDensityAt,
	isWeather,
	stormFlashAt,
	thunderMaskAt,
	Weather,
	WEATHER_EASE_S,
	weatherAnnouncement,
	weatherDark,
	weatherOfDay,
	weatherRains,
} from "shared/sim/weather";

/**
 * The run's clock, weather and night-wave queues. The clock rules themselves are pure and shared
 * (shared/sim/clock.ts, docs/MULTIPLAYER.md §4.6); this class only holds the state.
 *
 * It runs in one of two modes, and the public surface is the same in both — everything that reads the clock
 * (the HUD, the shadows, the horde, the coach, the audio) never has to know which one is on:
 *
 *   local (MP_PHASE < 2)   the clock is this client's own: it advances it, rolls the weather and fills the
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
	/** the day's weather (shared/sim/weather.ts `Weather`); left out, `rain` decides (Rain or Clear) */
	weather?: number;
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
	/** the day's weather (shared/sim/weather.ts `Weather`): the server's byte, or this client's own roll offline */
	weather: number = Weather.Clear;
	/** fog density now, 0..1: the local horde's eyes (instant, as the server's horde lives by it) */
	fog = 0;
	/**
	 * The fog the SCREEN shows (client/view/weatherView.ts, the HUD's icon): `fog`, eased over WEATHER_EASE_S when the
	 * day's weather changes (a midnight, the admin) so a fog never pops in or out -- the horde's eyes do not wait.
	 */
	fogShown = 0;
	/** what a noise carries now besides the rain (< 1 while a thunderclap rolls) */
	thunderMask = 1;
	/**
	 * The lightning ON SCREEN, 0..1 (inside `darkAlpha`), and its Reduce Motion shape: the strike as it is at the RENDER
	 * time (`renderLagS`), where the horde it lights is drawn; a strike this screen already showed is never shown again,
	 * and no two start closer than FLASH_MIN_GAP_S (a clock that snaps back replays nothing).
	 */
	flash = 0;
	gentleFlash = 0;
	/**
	 * The lightning lights the town at the render time (shared/sim/weather.ts `flashReveals`): the horde drawn now is at
	 * full alpha at once (client/net/snapshotBuffer.ts `reveal`, set from this by client/net/netClient.ts).
	 */
	reveal = false;
	/**
	 * Seconds the horde is drawn behind this clock (client/net/snapshotBuffer.ts `delay`, handed in every frame by
	 * client/net/netClient.ts; 0 offline): the flash is drawn at `dayTime − renderLagS × clockSpeed`, the moment the
	 * zombies on screen are at, so the screen and the bodies it lights agree (LUZ-05).
	 */
	renderLagS = 0;
	/**
	 * The darkness without the lightning, for the SCREEN (it applies the flash of its own choosing, Reduce Motion):
	 * eased over WEATHER_EASE_S when the day's weather changes, like `fogShown`.
	 */
	darkBase = 0;
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
	/** the town's seed: offline, the day's weather is rolled from it exactly as the server rolls it */
	private readonly seed: number;
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
	/** the weather being eased away from (-1: none) and how far the screen has come, 0..1 (`fogShown`, `darkBase`) */
	private easeFrom = -1;
	private ease = 1;
	/** the strikes this screen showed on `flashDay` (slots), the one on screen now (-1) and whether it is shown */
	private flashDay = -1;
	private readonly shownStrikes = new Set<number>();
	private strikeOn = -1;
	private strikeShown = false;
	/** `elapsed` when the last strike shown started */
	private lastStrikeAt = -math.huge;
	private lastAnnounce = "";
	private lastAnnounceAt = -ANNOUNCE_DEDUPE_S - 1;

	constructor(save: PlayerSaveData, seed: number = DESIGN.TOWN_SEED) {
		this.save = save;
		this.seed = seed;
		// `day` is the WORLD's day (§6.2, MP-13). Alone in your own world the two are the same number, which
		// is why the survivor's own day seeds it; on a shared server the first Clock delta (or `adoptWorld`)
		// replaces it at once, because nothing a single survivor does may decide what day the town is on.
		this.day = save.day;
		this.dayTime = 7;
		this.difficulty = difficultyOfDay(this.day);
		this.setWeather(weatherOfDay(this.seed, this.day));
		this.refreshPopulation();
	}

	/**
	 * The admin's weather on a world this client runs itself (client/admin/world.ts; a server-owned world's comes back
	 * in the Clock delta instead): today's, until midnight rolls the next day's.
	 */
	forceWeather(kind: number): void {
		if (!isWeather(kind)) return;
		if (kind !== this.weather) this.easeWeatherFrom(this.weather);
		this.setWeather(kind);
		this.updateDark();
	}

	/**
	 * The weather the town's day ROLLED (offline, and what the admin's weather is measured against: a weather that eases
	 * the night against it assists the run, shared/sim/weather.ts `weatherAssists`).
	 */
	dayRoll(): number {
		return weatherOfDay(this.seed, this.day);
	}

	/** the day's weather, and the rain that follows from it */
	private setWeather(kind: number): void {
		this.weather = kind;
		this.isRaining = weatherRains(kind);
	}

	/**
	 * A change the screen lives through: the darkness and the fog it shows go from `from`'s to the new weather's over
	 * WEATHER_EASE_S instead of jumping (the first delta of a session and a clock taken over are not lived: they snap).
	 */
	private easeWeatherFrom(from: number): void {
		this.easeFrom = from;
		this.ease = 0;
	}

	/**
	 * A new weather for the day (a midnight, the admin): told in the feed with what it does (LUZ-05). The first delta of
	 * a session and a run taking the world over are not news -- only a change lived on this screen is.
	 */
	private changeWeather(kind: number, news: boolean): void {
		if (kind === this.weather) return;
		if (news) this.easeWeatherFrom(this.weather);
		else this.ease = 1;
		this.setWeather(kind);
		if (!news) return;
		const text = weatherAnnouncement(kind);
		if (text !== "") this.announce(text);
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
		this.setWeather(previous.weather);
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
		const kind =
			c.weather !== undefined && isWeather(c.weather) ? c.weather : c.rain ? Weather.Rain : Weather.Clear;
		this.changeWeather(kind, this.driven);
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
		// the horde sees) is the plain one, with nobody's skill in it. The weather is the server's (LUZ-05): the
		// fog, the thunder and the lightning are the same pure functions of (weather, day, hour) it evaluates.
		const kind = this.weather;
		const t = this.dayTime;
		const nocturnal = this.save.skillLevels[16] > 0;
		this.fog = fogDensityAt(kind, t);
		this.thunderMask = thunderMaskAt(kind, this.day, t);
		// the lightning where the horde is DRAWN: `renderLagS` behind the clock (never across midnight: no strike is)
		const at = this.renderLagS > 0 ? math.max(0, t - this.renderLagS * clockSpeed(t)) : t;
		let flash = stormFlashAt(kind, this.day, at);
		let slot = flashStrikeSlot();
		let gentle = 0;
		if (kind === Weather.Storm) {
			gentle = stormFlashAt(kind, this.day, at, true);
			if (slot < 0) slot = flashStrikeSlot();
		}
		if ((flash > 0 || gentle > 0) && !this.showStrike(slot)) {
			flash = 0;
			gentle = 0;
		} else if (flash <= 0 && gentle <= 0) {
			this.strikeOn = -1;
		}
		this.flash = flash;
		this.gentleFlash = gentle;
		this.reveal = flashReveals(kind, at, flash);
		const base = weatherDark(kind, t, nocturnal, 0);
		this.darkAlpha = flash > 0 ? weatherDark(kind, t, nocturnal, flash) : base;
		// the screen's darkness and fog ease from the weather it had to the new one (the horde's above do not)
		if (this.ease < 1 && this.easeFrom >= 0) {
			const k = this.ease * this.ease * (3 - 2 * this.ease);
			const fromDark = weatherDark(this.easeFrom, t, nocturnal, 0);
			const fromFog = fogDensityAt(this.easeFrom, t);
			this.darkBase = fromDark + (base - fromDark) * k;
			this.fogShown = fromFog + (this.fog - fromFog) * k;
		} else {
			this.darkBase = base;
			this.fogShown = this.fog;
		}
	}

	/**
	 * Is strike `slot` of today to be shown? Asked on every frame it lights the sky; the answer is kept while it lasts. A
	 * strike this screen already showed (the clock snapped back into it: a resync, an admin) is never shown twice, and a
	 * strike that starts less than FLASH_MIN_GAP_S after the last one shown is not shown at all: the photosensitivity cap
	 * (≤ 2 flashes a second) holds whatever the clock does.
	 */
	private showStrike(slot: number): boolean {
		if (this.day !== this.flashDay) {
			this.flashDay = this.day;
			this.shownStrikes.clear();
			this.strikeOn = -1;
		}
		if (slot === this.strikeOn) return this.strikeShown;
		this.strikeOn = slot;
		this.strikeShown = !this.shownStrikes.has(slot) && this.elapsed - this.lastStrikeAt >= FLASH_MIN_GAP_S;
		if (this.strikeShown) {
			this.shownStrikes.add(slot);
			this.lastStrikeAt = this.elapsed;
		}
		return this.strikeShown;
	}

	// ---------------------------------------------------------------- the frame

	update(dt: number): void {
		this.elapsed += math.max(0, dt);
		if (this.ease < 1) this.ease = math.min(1, this.ease + math.max(0, dt) / WEATHER_EASE_S);
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
			this.changeWeather(weatherOfDay(this.seed, this.day), true);
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
			// no weather roll here: the weather is the server's (§3.6, LUZ-05). `save.day` is NOT the world's day, it is
			// this survivor's own (§6.2, MP-13), so it does not follow `this.day`. From PROGRESS_SERVER_PHASE the
			// server's midnight decides it -- and may refuse it: dead, absent, AFK -- and the pushed wallet brings
			// it here (shared/game/save.ts `applyWallet`). Bumping it here as well counted that midnight twice
			// whenever the wallet landed before this clock got there. Below that phase this mirror is all there is.
			if (MP_PHASE < PROGRESS_SERVER_PHASE) this.save.day = math.min(SAVE_LIMITS.DAY_MAX, this.save.day + 1);
			this.refreshPopulation();
		}
		this.dayTime = norm.dayTime;
		if (this.snapped) this.snapped = false;
		else this.detectAnnounce(prev, this.dayTime);
		this.applyServerWaves();
		this.updateDark();
	}
}
