export const ItemKind = {
	Weapon: 1,
	Equip: 2,
	Use: 3,
	Etc: 4,
} as const;
export type ItemKind = (typeof ItemKind)[keyof typeof ItemKind];

export const WeaponKind = {
	Rifle: 1,
	Pistol: 2,
	MG: 3,
	Shotgun: 4,
	Sniper: 5,
	Bow: 6,
	Melee: 7,
	Special: 8,
} as const;
export type WeaponKind = (typeof WeaponKind)[keyof typeof WeaponKind];

export const AmmoPool = {
	Normal: 1,
	Shotgun: 2,
	MG: 3,
	Arrow: 4,
	Oil: 5,
} as const;
export type AmmoPool = (typeof AmmoPool)[keyof typeof AmmoPool];
