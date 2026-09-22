import { DESIGN } from "shared/engine/constants";
import { chance } from "shared/engine/rng";
import { difficultyOfDay, PlayerSaveData } from "shared/game/save";
import { getDayPopulation } from "shared/data/spawns";
import {
	advanceClock,
	CLOCK_ANNOUNCEMENTS,
	crossed,
	darkAlphaAt,
	HOURS_PER_DAY,
	inWaveFillWindow,
	isNightAt,
	rainPossible,
	soundMattersAt,
	WAVE_FILL_FROM,
	waveActive,
} from "shared/sim/clock";

/**
 * The run's clock, weather and night-wave queues. The clock rules themselves are pure and shared
 * (shared/sim/clock.ts, docs/MULTIPLAYER.md §4.6); this class only holds the state and rolls the rain.
 */
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

	constructor(save: PlayerSaveData) {
		this.save = save;
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
			this.onAnnounce(a.text);
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
		// it); "Nocturnal" keeps the original 0.05 advantage
		this.darkAlpha = darkAlphaAt(this.dayTime, this.isRaining, this.save.skillLevels[16] > 0);
	}

	update(dt: number): void {
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
}
