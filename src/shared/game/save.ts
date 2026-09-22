export type ScreenId = "logo" | "lobby" | "shop" | "settings" | "credits" | "tutorial" | "game";

export interface SettingsData {
	soundEffect: number;
	bgm: number;
	uiSize: number;
	leftSize: number;
	leftPos: number;
	leftRelative: boolean;
	rightSize: number;
	rightPos: number;
	langType: number;
}

export function defaultSettings(): SettingsData {
	return {
		soundEffect: 0.5,
		bgm: 0.5,
		uiSize: 0.5,
		leftSize: 0.5,
		leftPos: 0.5,
		leftRelative: true,
		rightSize: 0.5,
		rightPos: 0.5,
		langType: 0,
	};
}

export interface PlayerSaveData {
	level: number;
	exp: number;
	skillPoint: number;
	skillLevels: Array<number>;
	money: number;
	day: number;
	deathCount: number;
	firstInstall: boolean;
	tutorialDone: boolean;
	achievements: Array<number>;
	shopHave: Array<number>;
	settings: SettingsData;
	invenWeapon: Array<number>;
	invenEquip: Array<number>;
	invenUse: Array<number>;
	invenEtc: Array<number>;
	ammoNormal: number;
	ammoShotgun: number;
	ammoMachinegun: number;
	ammoArrow: number;
	oil: number;
	electric: number;
	equipWeapon: number;
	equipCloth: number;
	equipHand: number;
	equipGun: number;
	equipDeco: number;
}

export function defaultSave(): PlayerSaveData {
	const skillLevels: Array<number> = [];
	for (let i = 0; i < 21; i++) {
		skillLevels.push(0);
	}
	const achievements: Array<number> = [];
	for (let i = 0; i < 22; i++) {
		achievements.push(0);
	}
	const shopHave: Array<number> = [];
	for (let i = 0; i < 9; i++) {
		shopHave.push(0);
	}
	const empty = (n: number) => {
		const a: Array<number> = [];
		for (let i = 0; i < n; i++) {
			a.push(0);
		}
		return a;
	};
	return {
		level: 1,
		exp: 0,
		skillPoint: 0,
		skillLevels,
		money: 0,
		day: 1,
		deathCount: 0,
		firstInstall: true,
		tutorialDone: false,
		achievements,
		shopHave,
		settings: defaultSettings(),
		invenWeapon: empty(30),
		invenEquip: empty(26),
		invenUse: empty(20),
		invenEtc: empty(49),
		ammoNormal: 0,
		ammoShotgun: 0,
		ammoMachinegun: 0,
		ammoArrow: 0,
		oil: 0,
		electric: 0,
		equipWeapon: -1,
		equipCloth: -1,
		equipHand: -1,
		equipGun: -1,
		equipDeco: -1,
	};
}

export function expMaxInit(level: number): number {
	return math.floor(math.sqrt(level) * 10 + 2) * 10;
}

export function expMaxLevelUp(level: number): number {
	return math.floor(level * 10 + 4) * 15;
}

export function difficultyOfDay(day: number): number {
	return math.min(2, math.floor(day / 15));
}
