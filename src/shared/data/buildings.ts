export const BuildingType = {
	ZombieLoot: 0,
	House: 1,
	LargeHouse: 2,
	School: 3,
	Hospital: 4,
	GasStation: 5,
	Pharmacy: 6,
	Market: 7,
	SmallMarket: 8,
	GunShop: 9,
	ClothShop: 10,
	Restaurant: 11,
} as const;
export type BuildingType = (typeof BuildingType)[keyof typeof BuildingType];

export const STRUCTURE_HP: Record<string, number> = {
	WoodenBarricade: 700,
	SteelBarricade: 1700,
	WoodenDoor: 500,
	SteelDoor: 1500,
	CraftDesk: 200,
	CraftDeskPro: 400,
	Campfire: 400,
	Brazier: 400,
	BrazierElectric: 300,
	Cooker: 300,
	BatteryBox: 300,
	SolarGenerator: 500,
	NuclearReactor: 500,
	OilGenerator: 500,
	Turret: 400,
	TurretDrone: 1000,
	Lamp: 400,
	ElectricTurret: 400,
	Trap: 100,
	SignalGenerator: 100,
};

export interface VehicleDef {
	name: string;
	speed: number;
	back: number;
	angle: number;
	accel: number;
	fric: number;
	oil: number;
	hpMax: number;
}

export const VEHICLES: Array<VehicleDef> = [
	{ name: "Bicycle", speed: 12, back: 4, angle: 1.5, accel: 0.7, fric: 0.1, oil: 0, hpMax: 100 },
	{ name: "Motorcycle", speed: 17, back: 5, angle: 1.2, accel: 1, fric: 0.05, oil: 0.01, hpMax: 100 },
];
