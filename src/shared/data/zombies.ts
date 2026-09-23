/** Zombie archetypes (obj_zombie … obj_zombie5). Speeds are px/frame @30fps like the original. */
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
	/** collision radius in world units (the big walker multiplies it by 1.4) */
	radius: number;
	/** chance (0..1) of each entry of the own drop table (rotten meat / leather) */
	dropChance: number;
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
		radius: 16,
		dropChance: 0.25,
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
		radius: 16,
		dropChance: 0.5,
	},
	{
		id: 3,
		name: "Exploder",
		speed: 1.7,
		hp: 150,
		dmg: 10,
		exp: 20,
		ranged: false,
		explodes: true,
		rushDamage: 0,
		jumper: false,
		radius: 17,
		dropChance: 0.5,
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
		radius: 17,
		dropChance: 0.5,
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
		radius: 16,
		dropChance: 0.5,
	},
];

/** definition for a zombie type id (1..5); falls back to the walker */
export function zombieDef(typeId: number): ZombieDef {
	for (const z of ZOMBIES) {
		if (z.id === typeId) return z;
	}
	return ZOMBIES[0];
}

export function hpWithDiff(base: number, difficulty: number): number {
	return math.floor(base * (1 + difficulty));
}

export function speedWithDiff(base: number, difficulty: number): number {
	return base * (1 + difficulty / 3);
}
