import type { ItemKind } from "./kinds";

export interface SpawnEntry {
	building: number;
	kind: ItemKind;
	index: number;
	min: number;
	max: number;
}

export interface DayPopulation {
	ambient: number;
	ambientSpecial: number;
	wave1: number;
	wave2: number;
	wave3: number;
	specialWave1: number;
	specialWave2: number;
	specialWave3: number;
}

export const DAY_POPULATION: Array<DayPopulation> = [
	{ ambient: 5, ambientSpecial: 0, wave1: 3, wave2: 3, wave3: 6, specialWave1: 0, specialWave2: 0, specialWave3: 0 },
	{ ambient: 8, ambientSpecial: 0, wave1: 5, wave2: 5, wave3: 10, specialWave1: 0, specialWave2: 0, specialWave3: 0 },
	{
		ambient: 10,
		ambientSpecial: 2,
		wave1: 12,
		wave2: 12,
		wave3: 20,
		specialWave1: 2,
		specialWave2: 2,
		specialWave3: 2,
	},
	{
		ambient: 12,
		ambientSpecial: 2,
		wave1: 20,
		wave2: 20,
		wave3: 40,
		specialWave1: 3,
		specialWave2: 3,
		specialWave3: 3,
	},
	{
		ambient: 14,
		ambientSpecial: 3,
		wave1: 30,
		wave2: 30,
		wave3: 50,
		specialWave1: 4,
		specialWave2: 4,
		specialWave3: 4,
	},
];

export function difficultyForDay(day: number): number {
	return math.min(2, math.floor(day / 15));
}

export function getDayPopulation(day: number): DayPopulation {
	if (day < 2) {
		return DAY_POPULATION[0];
	}
	if (day < 4) {
		return DAY_POPULATION[1];
	}
	if (day < 10) {
		return DAY_POPULATION[2];
	}
	if (day < 20) {
		return DAY_POPULATION[3];
	}
	return DAY_POPULATION[4];
}

export const BUILDING_SPAWNS: Array<Array<SpawnEntry>> = [
	[
		{ building: 0, kind: 4, index: 23, min: 2, max: 5 },
		{ building: 0, kind: 4, index: 24, min: 1, max: 3 },
		{ building: 0, kind: 4, index: 25, min: 2, max: 5 },
		{ building: 0, kind: 4, index: 29, min: 0.4, max: 0.4 },
		{ building: 0, kind: 4, index: 30, min: 1, max: 2 },
		{ building: 0, kind: 4, index: 31, min: 0.3, max: 0.3 },
		{ building: 0, kind: 4, index: 44, min: 5, max: 10 },
		{ building: 0, kind: 4, index: 45, min: 5, max: 10 },
		{ building: 0, kind: 4, index: 46, min: 15, max: 25 },
		{ building: 0, kind: 4, index: 47, min: 1, max: 2 },
		{ building: 0, kind: 4, index: 48, min: 7, max: 12 },
		{ building: 0, kind: 4, index: 38, min: 0.1, max: 0.1 },
		{ building: 0, kind: 4, index: 34, min: 0.5, max: 0.5 },
		{ building: 0, kind: 4, index: 37, min: 0.15, max: 0.15 },
		{ building: 0, kind: 4, index: 27, min: 0.1, max: 0.1 },
		{ building: 0, kind: 4, index: 33, min: 0.3, max: 0.3 },
		{ building: 0, kind: 3, index: 17, min: 0.25, max: 0.25 },
		{ building: 0, kind: 3, index: 18, min: 0.25, max: 0.25 },
	],
	[
		{ building: 1, kind: 4, index: 23, min: 2, max: 3 },
		{ building: 1, kind: 4, index: 24, min: 2, max: 3 },
		{ building: 1, kind: 4, index: 25, min: 1, max: 2 },
		{ building: 1, kind: 4, index: 27, min: 0.1, max: 0.1 },
		{ building: 1, kind: 4, index: 29, min: 1, max: 1 },
		{ building: 1, kind: 4, index: 31, min: 0.2, max: 0.2 },
		{ building: 1, kind: 4, index: 32, min: 0.4, max: 0.4 },
		{ building: 1, kind: 4, index: 34, min: 1, max: 1 },
		{ building: 1, kind: 4, index: 41, min: 1, max: 1 },
		{ building: 1, kind: 4, index: 48, min: 10, max: 15 },
		{ building: 1, kind: 3, index: 0, min: 1, max: 1 },
		{ building: 1, kind: 3, index: 4, min: 1, max: 1 },
		{ building: 1, kind: 3, index: 9, min: 1, max: 1 },
	],
	[
		{ building: 2, kind: 4, index: 25, min: 2, max: 3 },
		{ building: 2, kind: 4, index: 27, min: 0.1, max: 0.1 },
		{ building: 2, kind: 4, index: 29, min: 1, max: 1 },
		{ building: 2, kind: 4, index: 31, min: 0.2, max: 0.2 },
		{ building: 2, kind: 4, index: 32, min: 0.4, max: 0.4 },
		{ building: 2, kind: 4, index: 34, min: 1, max: 1 },
		{ building: 2, kind: 4, index: 41, min: 1, max: 1 },
		{ building: 2, kind: 4, index: 48, min: 10, max: 15 },
		{ building: 2, kind: 4, index: 30, min: 1, max: 3 },
		{ building: 2, kind: 4, index: 35, min: 0.2, max: 0.2 },
		{ building: 2, kind: 4, index: 36, min: 0.1, max: 0.1 },
		{ building: 2, kind: 4, index: 38, min: 0.1, max: 0.1 },
		{ building: 2, kind: 4, index: 41, min: 1, max: 2 },
		{ building: 2, kind: 4, index: 48, min: 10, max: 15 },
		{ building: 2, kind: 4, index: 42, min: 0.5, max: 0.5 },
		{ building: 2, kind: 4, index: 43, min: 0.5, max: 0.5 },
	],
	[
		{ building: 3, kind: 4, index: 23, min: 2, max: 3 },
		{ building: 3, kind: 4, index: 24, min: 2, max: 3 },
		{ building: 3, kind: 4, index: 25, min: 1, max: 2 },
		{ building: 3, kind: 4, index: 27, min: 0.1, max: 0.1 },
		{ building: 3, kind: 4, index: 29, min: 2, max: 5 },
		{ building: 3, kind: 4, index: 31, min: 0.5, max: 0.5 },
		{ building: 3, kind: 4, index: 32, min: 0.5, max: 0.5 },
		{ building: 3, kind: 4, index: 34, min: 1, max: 1 },
		{ building: 3, kind: 4, index: 41, min: 1, max: 1 },
		{ building: 3, kind: 4, index: 48, min: 1, max: 5 },
		{ building: 3, kind: 3, index: 12, min: 1, max: 1 },
		{ building: 3, kind: 3, index: 4, min: 1, max: 2 },
		{ building: 3, kind: 3, index: 9, min: 1, max: 2 },
	],
	[
		{ building: 4, kind: 4, index: 34, min: 2, max: 3 },
		{ building: 4, kind: 3, index: 5, min: 0.1, max: 0.1 },
		{ building: 4, kind: 3, index: 6, min: 0.2, max: 0.2 },
		{ building: 4, kind: 3, index: 7, min: 0.2, max: 0.2 },
		{ building: 4, kind: 3, index: 8, min: 0.2, max: 0.2 },
		{ building: 4, kind: 3, index: 12, min: 0.5, max: 0.5 },
	],
	[
		{ building: 5, kind: 4, index: 32, min: 1, max: 1 },
		{ building: 5, kind: 4, index: 38, min: 0.1, max: 0.1 },
		{ building: 5, kind: 3, index: 0, min: 1, max: 1 },
		{ building: 5, kind: 3, index: 2, min: 1, max: 1 },
		{ building: 5, kind: 3, index: 4, min: 1, max: 1 },
		{ building: 5, kind: 3, index: 9, min: 1, max: 1 },
		{ building: 5, kind: 3, index: 10, min: 1, max: 1 },
		{ building: 5, kind: 3, index: 13, min: 1, max: 1 },
		{ building: 5, kind: 3, index: 15, min: 1, max: 1 },
		{ building: 5, kind: 3, index: 17, min: 1, max: 1 },
		{ building: 5, kind: 3, index: 18, min: 1, max: 1 },
		{ building: 5, kind: 4, index: 48, min: 20, max: 30 },
		// not in the original DB: the gas station's garage gives scrap to smelt (steel is otherwise slow to get)
		{ building: 5, kind: 4, index: 25, min: 2, max: 4 },
		{ building: 5, kind: 4, index: 30, min: 0.3, max: 0.3 },
	],
	[
		{ building: 6, kind: 3, index: 5, min: 0.1, max: 0.1 },
		{ building: 6, kind: 3, index: 6, min: 0.1, max: 0.1 },
		{ building: 6, kind: 3, index: 7, min: 0.1, max: 0.1 },
		{ building: 6, kind: 3, index: 8, min: 0.1, max: 0.1 },
		{ building: 6, kind: 3, index: 12, min: 0.5, max: 0.5 },
		{ building: 6, kind: 4, index: 34, min: 1, max: 2 },
		{ building: 6, kind: 4, index: 41, min: 1, max: 1 },
	],
	[
		{ building: 7, kind: 4, index: 32, min: 1, max: 1 },
		{ building: 7, kind: 4, index: 38, min: 0.1, max: 0.1 },
		{ building: 7, kind: 3, index: 0, min: 1, max: 1 },
		{ building: 7, kind: 3, index: 2, min: 1, max: 2 },
		{ building: 7, kind: 3, index: 4, min: 1, max: 1 },
		{ building: 7, kind: 3, index: 9, min: 1, max: 2 },
		{ building: 7, kind: 3, index: 10, min: 1, max: 1 },
		{ building: 7, kind: 3, index: 13, min: 1, max: 1 },
		{ building: 7, kind: 3, index: 15, min: 1, max: 1 },
		{ building: 7, kind: 3, index: 17, min: 1, max: 1 },
		{ building: 7, kind: 3, index: 18, min: 1, max: 1 },
		{ building: 7, kind: 3, index: 5, min: 0.05, max: 0.05 },
		{ building: 7, kind: 3, index: 6, min: 0.05, max: 0.05 },
		{ building: 7, kind: 3, index: 7, min: 0.05, max: 0.05 },
		{ building: 7, kind: 3, index: 8, min: 0.05, max: 0.05 },
		{ building: 7, kind: 3, index: 12, min: 0.5, max: 0.5 },
		{ building: 7, kind: 4, index: 35, min: 0.5, max: 0.5 },
		{ building: 7, kind: 4, index: 36, min: 0.5, max: 0.5 },
	],
	[
		{ building: 8, kind: 3, index: 0, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 2, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 4, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 9, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 10, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 13, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 15, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 17, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 18, min: 1, max: 1 },
		{ building: 8, kind: 3, index: 12, min: 0.5, max: 0.5 },
	],
	[
		{ building: 9, kind: 4, index: 33, min: 3, max: 5 },
		{ building: 9, kind: 4, index: 44, min: 10, max: 20 },
		{ building: 9, kind: 4, index: 45, min: 10, max: 20 },
		{ building: 9, kind: 4, index: 46, min: 20, max: 50 },
		{ building: 9, kind: 1, index: 10, min: 0.1, max: 0.1 },
		{ building: 9, kind: 1, index: 13, min: 0.1, max: 0.1 },
		// gunsmith scrap (not in the original DB): steel pieces and the odd gold piece to smelt
		{ building: 9, kind: 4, index: 25, min: 1, max: 3 },
		{ building: 9, kind: 4, index: 27, min: 0.25, max: 0.25 },
	],
	[
		{ building: 10, kind: 4, index: 34, min: 5, max: 10 },
		{ building: 10, kind: 4, index: 41, min: 1, max: 3 },
		{ building: 10, kind: 2, index: 0, min: 0.1, max: 0.1 },
		{ building: 10, kind: 2, index: 1, min: 0.1, max: 0.1 },
	],
	[
		{ building: 11, kind: 3, index: 11, min: 1, max: 2 },
		{ building: 11, kind: 3, index: 14, min: 1, max: 2 },
		{ building: 11, kind: 3, index: 16, min: 1, max: 2 },
		{ building: 11, kind: 3, index: 1, min: 1, max: 2 },
	],
];
