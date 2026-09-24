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
	// the college campus (docs/DESIGN_RULES.md EDI-17): four buildings round a quad on one block, at most one a town
	CampusHall: 12,
	CampusLibrary: 13,
	CampusLab: 14,
	CampusDorm: 15,
	// the everyday town (docs/DESIGN_RULES.md EDI-18): Main Street's small shops, offices, bank and police station, the
	// town hall and the fire station on the avenue
	Hardware: 16,
	AutoRepair: 17,
	Electronics: 18,
	Bakery: 19,
	PawnShop: 20,
	PostOffice: 21,
	Bank: 22,
	TownHall: 23,
	FireStation: 24,
	PoliceStation: 25,
	Office: 26,
} as const;
export type BuildingType = (typeof BuildingType)[keyof typeof BuildingType];

/** the campus's building types, the main hall first (EDI-17) */
export const CAMPUS_TYPES: ReadonlyArray<number> = [
	BuildingType.CampusHall,
	BuildingType.CampusLibrary,
	BuildingType.CampusLab,
	BuildingType.CampusDorm,
];

/** is this building type one of the campus's (EDI-17)? */
export function isCampusType(bt: number): boolean {
	return bt >= BuildingType.CampusHall && bt <= BuildingType.CampusDorm;
}

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

/** what a survivor rides (PlayerState.ride.kind); 0 = on foot */
export const VehicleKind = {
	None: 0,
	Bicycle: 1,
	Motorcycle: 2,
} as const;
export type VehicleKind = (typeof VehicleKind)[keyof typeof VehicleKind];

/**
 * The two rideable builds (docs/DESIGN_RULES.md VEI-05). Everything is in world units and seconds.
 *
 * The original's numbers (obj_bicycle / obj_motocycle, px/frame at 30 fps): speed 12 / 17 (360 / 510 u/s, kept as
 * the top speeds), reverse 4 / 5, turn 1.5 / 1.2 °/frame of a ROTATING camera, accel 0.7 / 1, friction 0.1 / 0.05,
 * oil 0.01 per frame whenever mounted (18 oil a minute, even standing), hp 100 that nothing ever took. Ours steer
 * toward the stick on a fixed camera, so the handling below is new: see VEI-05 for every number and why.
 *
 * The per-tick deltas are exact multiples of the wire's speed step at 60 Hz (shared/sim/vehicle.ts SPEED_STEP = 2 u/s:
 * accel 360 → 3 steps a tick), so the quantised speed the server replicates is exactly the one it simulated.
 */
export interface VehicleDef {
	kind: VehicleKind;
	/** ETC item index of the kit, which is also its PLACEABLES id */
	item: number;
	name: string;
	/** top speed, u/s (walking is 210, 297 with every Trot level and a speed buff) */
	topSpeed: number;
	/** u/s² with the throttle open, braking (stick > 100° off the heading) and coasting (no stick) */
	accel: number;
	brake: number;
	coast: number;
	/** yaw rate when (nearly) stopped, rad/s: the rider walks the front wheel round */
	standTurn: number;
	/** lateral grip, u/s²: at speed v the yaw rate is at most grip / v (turn radius v² / grip) */
	grip: number;
	/** collision radius while ridden (the survivor alone is 18) */
	radius: number;
	/** drawn and parked footprint (PLACEABLES), heading along `length` */
	length: number;
	width: number;
	hpMax: number;
	/** a head-on hit on a solid, or any hit on a zombie ahead, at this speed or more is a crash */
	crashSpeed: number;
	/** vehicle hp and rider hp (armour does not help: it is a fall) a crash at top speed costs, scaled by speed */
	crashDamage: number;
	crashHurt: number;
	/** damage to the zombie that was run into at crash speed or more (the ram's knock and stun are fixed) */
	ramDamage: number;
	/** oil units a second with the engine running: standing, and extra at top speed (0 = pedals) */
	oilIdle: number;
	oilFull: number;
	/** engine noise ring every VEHICLE_NOISE_PERIOD s, from idle to top speed (0 = no engine) */
	noiseIdle: number;
	noiseFull: number;
	/** the bell (bicycle) or the horn (motorcycle), on the attack button */
	hornRadius: number;
	/**
	 * The headlight's reach along the vehicle's heading (LUZ-04, shared/sim/survivorLight.ts `survivorBeam`), 0 = none.
	 * The flashlight's cone (±45°) a little further: the road ahead of a rider at speed, not the aim of the hands.
	 */
	headlight: number;
}

export const VEHICLES: Array<VehicleDef> = [
	{
		kind: VehicleKind.Bicycle,
		item: 21,
		name: "Bicycle",
		topSpeed: 360,
		accel: 360,
		brake: 960,
		coast: 240,
		standTurn: 4.5,
		grip: 1320,
		radius: 20,
		length: 72,
		width: 28,
		hpMax: 100,
		crashSpeed: 240,
		crashDamage: 12,
		crashHurt: 6,
		ramDamage: 20,
		oilIdle: 0,
		oilFull: 0,
		noiseIdle: 0,
		noiseFull: 0,
		hornRadius: 250,
		headlight: 0,
	},
	{
		kind: VehicleKind.Motorcycle,
		item: 22,
		name: "Motorcycle",
		topSpeed: 510,
		accel: 480,
		brake: 1080,
		coast: 120,
		standTurn: 3,
		grip: 1200,
		radius: 22,
		length: 88,
		width: 32,
		hpMax: 120,
		crashSpeed: 300,
		crashDamage: 20,
		crashHurt: 12,
		ramDamage: 45,
		oilIdle: 1 / 60,
		oilFull: 1 / 10,
		noiseIdle: 400,
		noiseFull: 900,
		hornRadius: 900,
		headlight: 640,
	},
];

/** the definition of a vehicle kind, or undefined for 0 and anything unknown */
export function vehicleDef(kind: number): VehicleDef | undefined {
	for (const v of VEHICLES) if (v.kind === kind) return v;
	return undefined;
}

/** the kind a PLACEABLES / ETC id rides as (21 bicycle, 22 motorcycle), or VehicleKind.None */
export function vehicleKindOfItem(item: number): VehicleKind {
	for (const v of VEHICLES) if (v.item === item) return v.kind;
	return VehicleKind.None;
}
