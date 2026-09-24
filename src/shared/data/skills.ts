export interface SkillDef {
	id: number;
	name: string;
	detail: string;
	kind: number;
	maxLevel: number;
}

export const SKILLS: Array<SkillDef> = [
	{ id: 0, name: "Health", detail: "More maximum health.", kind: 1, maxLevel: 3 },
	{ id: 1, name: "Recovery", detail: "Health comes back faster.", kind: 1, maxLevel: 3 },
	{ id: 2, name: "Knockback", detail: "Hits push zombies further back.", kind: 2, maxLevel: 1 },
	{ id: 3, name: "Melee damage", detail: "Melee hits deal more damage.", kind: 2, maxLevel: 2 },
	{ id: 4, name: "Quick reload", detail: "Reloading takes less time.", kind: 2, maxLevel: 1 },
	{ id: 5, name: "Shooting skill", detail: "Guns spread less.", kind: 2, maxLevel: 1 },
	{ id: 6, name: "Robin Hood", detail: "Arrows fly faster and straighter.", kind: 2, maxLevel: 1 },
	{ id: 7, name: "Trot", detail: "You walk faster.", kind: 1, maxLevel: 3 },
	{ id: 8, name: "Patience", detail: "Hunger drains more slowly.", kind: 1, maxLevel: 3 },
	{ id: 9, name: "Pickpocket", detail: "Zombies drop more loot.", kind: 3, maxLevel: 1 },
	{ id: 10, name: "Thief", detail: "Searching a building finds one more item.", kind: 3, maxLevel: 1 },
	{ id: 11, name: "Chef", detail: "Cooking may give double.", kind: 3, maxLevel: 2 },
	{ id: 12, name: "Dwarf", detail: "Smelting may give double.", kind: 3, maxLevel: 2 },
	// what they do is the electric grid's (shared/data/power.ts, DESIGN_RULES ELE-08): turret and drone damage x1.5
	// and drone battery x1.5; generator output x1.5 and battery box x1.2 -- on what their owner builds
	{ id: 13, name: "Robotics", detail: "Your turrets hit harder and your drones fly longer.", kind: 3, maxLevel: 1 },
	{
		id: 14,
		name: "Engineering",
		detail: "Your generators make more power and your boxes hold more.",
		kind: 3,
		maxLevel: 1,
	},
	{ id: 15, name: "Cat", detail: "Your footsteps are quieter.", kind: 1, maxLevel: 1 },
	{ id: 16, name: "Nocturnal", detail: "You see further at night.", kind: 1, maxLevel: 1 },
	{ id: 17, name: "Repairman", detail: "Repairs go faster.", kind: 3, maxLevel: 1 },
	{ id: 18, name: "Move shooting", detail: "Moving adds no spread to your shots.", kind: 2, maxLevel: 1 },
	{ id: 19, name: "Head shooter", detail: "Shots can hit the head for extra damage.", kind: 2, maxLevel: 1 },
	{ id: 20, name: "Poison immunity", detail: "Poison hurts less.", kind: 1, maxLevel: 1 },
];
