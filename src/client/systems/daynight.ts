import { DESIGN } from "shared/engine/constants";
import { chance } from "shared/engine/rng";
import { difficultyOfDay, PlayerSaveData } from "shared/game/save";
import { getDayPopulation } from "shared/data/spawns";

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
	onAnnounce: (msg: string) => void = () => {};

	private save: PlayerSaveData;
	private fillDone = false;

	constructor(save: PlayerSaveData) {
		this.save = save;
		this.day = save.day;
		this.dayTime = 7;
		this.difficulty = difficultyOfDay(this.day);
		this.isRaining = chance(DESIGN.WEATHER_PERCENT);
		this.refreshPopulation();
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
		if (crossed(prev, cur, 7)) this.onAnnounce("Good morning");
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
		const cap = this.save.skillLevels[16] > 0 ? DESIGN.DARK_ALPHA_NIGHT_SKILL : DESIGN.DARK_ALPHA_MAX;
		let dark = math.min(cap, ramp * ((DESIGN.DARK_ALPHA_MAX / 6) * 3));
		if (this.isRaining) {
			dark = math.min(cap, math.max(dark, 0.5));
		}
		this.darkAlpha = dark;
	}

	update(dt: number): void {
		const night = this.dayTime > 19 || this.dayTime < 6;
		this.isNight = night;
		const speed = DESIGN.TIME_SPEED * (night ? 1 : 0.8);
		const prev = this.dayTime;
		this.dayTime += speed * dt;
		if (this.dayTime >= 24) {
			this.dayTime -= 24;
			this.day += 1;
			this.save.day = this.day;
			this.isRaining = chance(DESIGN.WEATHER_PERCENT);
			this.refreshPopulation();
		}
		this.detectAnnounce(prev, this.dayTime);
		this.updateWaves();
		this.updateDark();
	}
}
