export interface ZombieDef {
	id: number;
	name: string;
	speed: number;
	hp: number;
	dmg: number;
	exp: number;
	ranged: boolean;
	explodes: boolean;
	rushDamage: number;
	jumper: boolean;
}

export const ZOMBIES: Array<ZombieDef> = [
	{
		id: 1,
		name: "Walker",
		speed: 3,
		hp: 100,
		dmg: 10,
		exp: 10,
		ranged: false,
		explodes: false,
		rushDamage: 0,
		jumper: false,
	},
	{
		id: 2,
		name: "Spitter",
		speed: 2.5,
		hp: 100,
		dmg: 10,
		exp: 20,
		ranged: true,
		explodes: false,
		rushDamage: 0,
		jumper: false,
	},
	{
		id: 3,
		name: "Explorer",
		speed: 1.7,
		hp: 150,
		dmg: 10,
		exp: 20,
		ranged: false,
		explodes: true,
		rushDamage: 0,
		jumper: false,
	},
	{
		id: 4,
		name: "Charger",
		speed: 2.5,
		hp: 150,
		dmg: 10,
		exp: 20,
		ranged: false,
		explodes: false,
		rushDamage: 20,
		jumper: false,
	},
	{
		id: 5,
		name: "Jumper",
		speed: 2.5,
		hp: 100,
		dmg: 10,
		exp: 20,
		ranged: false,
		explodes: false,
		rushDamage: 0,
		jumper: true,
	},
];

export function hpWithDiff(base: number, difficulty: number): number {
	return math.floor(base * (1 + difficulty));
}

export function speedWithDiff(base: number, difficulty: number): number {
	return base * (1 + difficulty / 3);
}
