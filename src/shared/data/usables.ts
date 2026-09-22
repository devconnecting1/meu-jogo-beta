export interface UsableDef {
	id: number;
	name: string;
	hp: number;
	hunger: number;
	speed: number;
	calm: number;
	pain: number;
	cook: number;
}

export const USABLES: Array<UsableDef> = [
	{ id: 0, name: "Raw meat", hp: 5, hunger: 20, speed: 0, calm: 0, pain: 0, cook: 1 },
	{ id: 1, name: "Cooked meat", hp: 5, hunger: 30, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 2, name: "Potato", hp: 0, hunger: 10, speed: 0, calm: 0, pain: 0, cook: 3 },
	{ id: 3, name: "Baked potato", hp: 0, hunger: 20, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 4, name: "Bread", hp: 5, hunger: 20, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 5, name: "First aid kit", hp: 50, hunger: 0, speed: 0, calm: 0, pain: 2, cook: -1 },
	{ id: 6, name: "Pain killer", hp: 0, hunger: 0, speed: 0, calm: 0, pain: 4, cook: -1 },
	{ id: 7, name: "Adrenaline", hp: 0, hunger: 0, speed: 4, calm: 0, pain: 0, cook: -1 },
	{ id: 8, name: "Sedative", hp: 0, hunger: 0, speed: 0, calm: 4, pain: 0, cook: -1 },
	{ id: 9, name: "Canned food", hp: 5, hunger: 25, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 10, name: "Frozen pizza", hp: 0, hunger: 15, speed: 0, calm: 0, pain: 0, cook: 11 },
	{ id: 11, name: "Pizza", hp: 5, hunger: 30, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 12, name: "Bandage", hp: 20, hunger: 0, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 13, name: "Frozen meal", hp: 0, hunger: 20, speed: 0, calm: 0, pain: 0, cook: 14 },
	{ id: 14, name: "Cooked meal", hp: 0, hunger: 30, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 15, name: "Mushroom", hp: 0, hunger: 10, speed: 0, calm: 0, pain: 0, cook: 16 },
	{ id: 16, name: "Mushroom soup", hp: 0, hunger: 20, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 17, name: "Apple", hp: 0, hunger: 20, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 18, name: "Berry", hp: 0, hunger: 15, speed: 0, calm: 0, pain: 0, cook: -1 },
	{ id: 19, name: "Rotten meat", hp: 20, hunger: -10, speed: 0, calm: 0, pain: 0, cook: -1 },
];
