import { DESIGN } from "shared/engine/constants";
import { chance } from "shared/engine/rng";
import { difficultyOfDay, PlayerSaveData } from "shared/game/save";
import { getDayPopulation } from "shared/data/spawns";

/** darkest overlay alpha at midnight */
const MAX_DARK = 0.85;

function crossed(prev: number, cur: number, t: number): boolean {
	if (cur >= prev) {
		return prev < t && cur >= t;
	}
	return prev < t || cur >= t;
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
		return this.day > 4 && chance(DESIGN.WEATHER_PERCENT);
	}

	/**
	 * Daytime hours in which noise matters (sys_sound_view: 6 < t < 18 and no rain). At night and in
	 * the rain every zombie already hunts the player, so footsteps/shots add nothing.
	 */
	soundMatters(): boolean {
		return this.dayTime > 6 && this.dayTime < 18 && !this.isRaining;
	}

	private refreshPopulation(): void {
		const pop = getDayPopulation(this.day);
		this.ambientTarget = pop.ambient;
		this.ambientSpecialMax = pop.ambientSpecial;
		this.difficulty = difficultyOfDay(this.day);
	}

	private detectAnnounce(prev: number, cur: number): void {
		if (crossed(prev, cur, 19)) this.onAnnounce("Wave 1");
		if (crossed(prev, cur, 22)) this.onAnnounce("Wave 2");
		if (crossed(prev, cur, 1)) this.onAnnounce("Wave 3");
		if (crossed(prev, cur, 7)) {
			this.morningCount += 1;
			this.onAnnounce("Good morning");
		}
	}

	private updateWaves(): void {
		if (this.dayTime > 18 && this.dayTime < 18.5 && !this.fillDone) {
			const pop = getDayPopulation(this.day);
			this.waveQueues = [pop.wave1, pop.wave2, pop.wave3];
			this.specialWaveQueues = [pop.specialWave1, pop.specialWave2, pop.specialWave3];
			this.fillDone = true;
		}
		if (this.dayTime < 18) {
			this.fillDone = false;
		}
		this.wave1Active = this.dayTime > 19;
		this.wave2Active = this.dayTime > 22;
		this.wave3Active = this.dayTime > 1 && this.dayTime < 6;
	}

	private updateDark(): void {
		let ramp = 0;
		if (this.dayTime >= 18) {
			ramp = this.dayTime - 18;
		} else if (this.dayTime < 6) {
			ramp = 6 - this.dayTime;
		}
		// deepest night is capped at 0.85 (the renderer punches light holes around the player and
		// lamps/campfires into it); "Nocturnal" keeps the original 0.05 advantage
		const cap =
			this.save.skillLevels[16] > 0
				? MAX_DARK - (DESIGN.DARK_ALPHA_MAX - DESIGN.DARK_ALPHA_NIGHT_SKILL)
				: MAX_DARK;
		let dark = math.min(cap, ramp * ((DESIGN.DARK_ALPHA_MAX / 6) * 3));
		if (this.isRaining) {
			dark = math.min(cap, math.max(dark, 0.5));
		}
		this.darkAlpha = dark;
	}

	update(dt: number): void {
		const night = this.dayTime > 19 || this.dayTime < 6;
		this.isNight = night;
		// original: the night runs 1.2× and the day 0.8× the base clock speed
		const speed = DESIGN.TIME_SPEED * (night ? 1.2 : 0.8);
		const prev = this.dayTime;
		this.dayTime += speed * dt;
		if (this.dayTime >= 24) {
			this.dayTime -= 24;
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
