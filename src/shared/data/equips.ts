export interface EquipDef {
	id: number;
	name: string;
	kind: number;
	def: number;
	speed: number;
}

export const EQUIPS: Array<EquipDef> = [
	{ id: 0, name: "Cotton clothes", kind: 1, def: 1, speed: 0 },
	{ id: 1, name: "Leather jacket", kind: 1, def: 2, speed: -0.5 },
	{ id: 2, name: "Leather armor", kind: 1, def: 3, speed: -1 },
	{ id: 3, name: "Wooden armor", kind: 1, def: 4, speed: -1 },
	{ id: 4, name: "Steel armor", kind: 1, def: 6, speed: -1.5 },
	{ id: 5, name: "Plastic armor", kind: 1, def: 4, speed: 0 },
	{ id: 6, name: "Night vision", kind: 3, def: 0, speed: 0 },
	{ id: 7, name: "Laser sight", kind: 3, def: 0, speed: 0 },
	{ id: 8, name: "Compass", kind: 2, def: 0, speed: 0 },
	{ id: 9, name: "Sundial", kind: 2, def: 0, speed: 0 },
	{ id: 10, name: "Watch", kind: 2, def: 0, speed: 0 },
	{ id: 11, name: "Digital Watch", kind: 2, def: 0, speed: 0 },
	{ id: 12, name: "Gun silencer", kind: 3, def: 0, speed: 0 },
	{ id: 13, name: "Flashlight", kind: 2, def: 0, speed: 0 },
	{ id: 14, name: "Robot suit", kind: 1, def: 5, speed: 1 },
	{ id: 15, name: "Torchlight", kind: 2, def: 0, speed: 0 },
	{ id: 16, name: "GPS machine", kind: 2, def: 0, speed: 0 },
	{ id: 17, name: "Pigeon", kind: 4, def: 0, speed: 0 },
	{ id: 18, name: "White pigeon", kind: 4, def: 0, speed: 0 },
	{ id: 19, name: "Eagle", kind: 4, def: 0, speed: 0 },
	{ id: 20, name: "Malamute", kind: 4, def: 0, speed: 0 },
	{ id: 21, name: "Carolina", kind: 4, def: 0, speed: 0 },
	{ id: 22, name: "Doberman", kind: 4, def: 0, speed: 0 },
	{ id: 23, name: "Santa", kind: 4, def: 0, speed: 0 },
	{ id: 24, name: "Zombie", kind: 4, def: 0, speed: 0 },
	{ id: 25, name: "Cowboy", kind: 4, def: 0, speed: 0 },
];
