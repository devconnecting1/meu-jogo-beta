export interface EquipDef {
	id: number;
	name: string;
	kind: number;
	def: number;
	speed: number;
}

/**
 * The equipment slots a survivor has (`equipSlotOf` in shared/game/save.ts), and the numbers the backpack, the
 * `Unequip` intent (shared/net/protocol.ts) and the server agree on.
 *
 * `kind` 1..3 of an EQUIPS row IS its slot. `kind` 4 is a cosmetic and splits in two (MON-04, decision of the
 * owner 2026-09-23): an OUTFIT changes the body, a PET follows it, and both are worn at once. Which of the two a
 * kind-4 row is lives in shared/data/cosmetics.ts.
 */
export const EquipSlot = {
	Cloth: 1,
	Hand: 2,
	Gun: 3,
	Outfit: 4,
	Pet: 5,
} as const;
export type EquipSlot = (typeof EquipSlot)[keyof typeof EquipSlot];
/** the highest slot number (the Unequip intent's argument is checked against it) */
export const EQUIP_SLOT_MAX = 5;

/**
 * What a worn gadget does to its wearer's light at night (DESIGN_RULES LUZ-04). `radius`: the survivor's own circle
 * grows to it (the largest wins). `coneDeg`: instead, a cone of `radius` along the aim, `coneDeg` to either side of
 * it. `sight`: it lights nothing -- it amplifies (night vision): the same circle for what the survivor makes out, and
 * a brighter, green view of the night on their own screen.
 *
 * ONE table for both sides: the server's horde visibility (shared/sim/ai/zombieBrain.ts, through
 * shared/sim/survivorLight.ts) and the client's light map (client/gameLoop.ts drawLight) read these very numbers,
 * so a zombie is lit on the server exactly where the ground is lit on the screen.
 */
export interface EquipLight {
	radius: number;
	coneDeg?: number;
	sight?: boolean;
}

export const EQUIP_LIGHTS: Record<number, EquipLight> = {
	// Flashlight: the original's power 400 in a 45° cone (obj_player), ~560 u ahead
	13: { radius: 560, coneDeg: 45 },
	// Torchlight: a portable fire, all round
	15: { radius: 400 },
	// Night vision: the dark amplified around you, farther than a torch but no light of its own
	6: { radius: 420, sight: true },
};

/**
 * What a hand gadget shows on the HUD (E2, client/ui/hudNav.ts): the Compass a needle towards your camp (the nearest
 * campfire, brazier or craft desk standing) with how far it is, north when there is none; the GPS machine a map of
 * the streets around you with your camp and your allies on it. Both in the hand slot, so one at a time -- and never
 * with the flashlight or a watch: what you hold is a choice.
 */
export type EquipNav = "compass" | "map";
export const EQUIP_NAV: Record<number, EquipNav> = {
	8: "compass",
	16: "map",
};

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
