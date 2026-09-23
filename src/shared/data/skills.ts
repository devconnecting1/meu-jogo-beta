export interface SkillDef {
	id: number;
	name: string;
	detail: string;
	kind: number;
	maxLevel: number;
}

export const SKILLS: Array<SkillDef> = [
	{ id: 0, name: "Health", detail: "Health increases", kind: 1, maxLevel: 3 },
	{ id: 1, name: "Recovery", detail: "Recovery increases", kind: 1, maxLevel: 3 },
	{ id: 2, name: "Knockback", detail: "Knockback increases", kind: 2, maxLevel: 1 },
	{ id: 3, name: "Melee damage", detail: "Melee damage increases", kind: 2, maxLevel: 2 },
	{ id: 4, name: "Quick reload", detail: "Reload becomes faster", kind: 2, maxLevel: 1 },
	{ id: 5, name: "Shooting skill", detail: "Accuracy improves", kind: 2, maxLevel: 1 },
	{ id: 6, name: "Robin Hood", detail: "Bow accuracy improves", kind: 2, maxLevel: 1 },
	{ id: 7, name: "Trot", detail: "Speed increases", kind: 1, maxLevel: 3 },
	{ id: 8, name: "Patience", detail: "Hungry decreases", kind: 1, maxLevel: 3 },
	{ id: 9, name: "Pickpocket", detail: "Zombies drop more items", kind: 3, maxLevel: 1 },
	{ id: 10, name: "Thief", detail: "Find more items", kind: 3, maxLevel: 1 },
	{ id: 11, name: "Chef", detail: "A chance to get more foods", kind: 3, maxLevel: 2 },
	{ id: 12, name: "Dwarf", detail: "A chance to get more metal", kind: 3, maxLevel: 2 },
	{ id: 13, name: "Robotics", detail: "Turret reinforced", kind: 3, maxLevel: 1 },
	{ id: 14, name: "Engineering", detail: "Generator reinforced", kind: 3, maxLevel: 1 },
	{ id: 15, name: "Cat", detail: "Footsteps sound decreases", kind: 1, maxLevel: 1 },
	{ id: 16, name: "Nocturnal", detail: "Night vision increases", kind: 1, maxLevel: 1 },
	{ id: 17, name: "Repairman", detail: "Repair speed increases", kind: 3, maxLevel: 1 },
	{ id: 18, name: "Move shooting", detail: "Accuracy improves with moving", kind: 2, maxLevel: 1 },
	{ id: 19, name: "Head shooter", detail: "Able to shoot heads", kind: 2, maxLevel: 1 },
	{ id: 20, name: "Poison immunity", detail: "Get less damage from poison", kind: 1, maxLevel: 1 },
];
