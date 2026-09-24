/*
 * What the action button (E) would act on, as pure queries over the world (docs/MULTIPLAYER.md §11.2, §8.1).
 * The client shows the "E: …" hint and acts with them; the server (F3) validates `pickup`, `interact` and `search`
 * with the very same queries, at ITS position of the survivor. No Instances, no random numbers, no state.
 */
import { DESIGN } from "shared/engine/constants";
import type { ZombieState } from "shared/game/entities";
import { PLAYER_RADIUS, ZOMBIE_RADIUS } from "shared/game/physics";
import type { PlayerState } from "shared/game/player";
import { buildingAt, GroundItem, querySolids, Solid, WorldData } from "shared/game/world";
import { rectCircleOverlap } from "./placement";
import { vehicleBroken } from "./vehicle";

/** solids are looked up in a box of this half-size around the survivor */
export const INTERACT_RADIUS = 80;
/** edge distance at which a solid can be used (a door has to be nearer) */
export const SOLID_REACH = 40;
export const DOOR_REACH = 30;

/**
 * Tags that can be repaired with wood or steel. The machines (ELE-08) are the original's repair list
 * (obj_player: turret, battery box, the three generators, the electric trap): steel, as the turret always was.
 */
export const REPAIRABLE: ReadonlyArray<string> = [
	"craftdesk",
	"craftdesk_pro",
	"turret",
	"barricade",
	"iron_barricade",
	"door",
	"iron_door",
	"electric_turret",
	"battery",
	"solar",
	"reactor",
	"oil_generator",
	// only once it is broken (VEI-05): before that E rides it (`interactTarget`)
	"vehicle",
];

/** machines mended with steel rather than wood */
const STEEL_REPAIRED: ReadonlyArray<string> = [
	"iron_barricade",
	"turret",
	"electric_turret",
	"battery",
	"solar",
	"reactor",
	"oil_generator",
];

/** distance from (x, y) to the solid's rect (negative inside) */
export function edgeDist(s: Solid, x: number, y: number): number {
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	return math.max(math.abs(cx - x) - s.w / 2, math.abs(cy - y) - s.h / 2);
}

export function isDoor(s: Solid): boolean {
	return s.kind === "door" || s.kind === "iron_door";
}

/**
 * A campfire, brazier, lamp or lamp drone: E switches it. The lamp drone is a lamp that flies (ELE-05): where the
 * server owns the grid, E launches it to escort you and calls it back (server/sim/power.ts); a client that still
 * owns its own world (MP_PHASE < F3) just switches it on its pad.
 */
export function isLight(s: Solid): boolean {
	return s.tags === "campfire" || s.tags === "lamp" || s.tags === "brazier" || s.tags === "lamp_drone";
}

/** burns wood (a lamp does not) */
export function isFire(s: Solid): boolean {
	return s.tags === "campfire" || s.tags === "brazier";
}

/** tree, car or bin: hitting or searching it may drop materials */
export function isMapItem(s: Solid): boolean {
	return s.kind === "tree" || s.tags === "car" || s.tags === "trash";
}

/** a parked bicycle or motorcycle (VEI-05): passable, but E still finds it */
export function isVehicle(s: Solid): boolean {
	return s.tags === "vehicle";
}

/** wood repairs everything but iron doors, iron barricades, turrets, the other machines and vehicles (steel) */
export function repairMaterial(s: Solid): { kind: number; index: number } {
	if (s.kind === "iron_door" || STEEL_REPAIRED.includes(s.tags) || isVehicle(s)) {
		return { kind: 4, index: 26 };
	}
	return { kind: 4, index: 23 };
}

/** damaged and repairable (the material still has to be in the backpack); a vehicle only once it is broken */
export function canRepair(s: Solid): boolean {
	if (isVehicle(s)) return vehicleBroken(s);
	return s.hp < s.hpMax && REPAIRABLE.includes(s.tags);
}

/**
 * Nearest ground item within reach (DESIGN.ITEM_GET_DISTANCE).
 *
 * This runs every frame, for the "E: pick up" hint, over every item in the world — and the world's item
 * count only grows as a run explores. It used to take a square root for each one. Two things fix that
 * without a new index: reject on the bounding box first (two subtractions and two compares kill everything
 * that is not within 40 u), and then compare SQUARED distances, since `a < b` and `a² < b²` agree for
 * non-negative numbers. The answer is identical; the arithmetic is not.
 */
export function nearestGroundItem(world: WorldData, x: number, y: number): GroundItem | undefined {
	const reach = DESIGN.ITEM_GET_DISTANCE;
	let best: GroundItem | undefined;
	let bestD2 = reach * reach;
	for (const it of world.items) {
		const dx = it.x - x;
		if (dx > reach || dx < -reach) continue;
		const dy = it.y - y;
		if (dy > reach || dy < -reach) continue;
		const d2 = dx * dx + dy * dy;
		if (d2 < bestD2) {
			bestD2 = d2;
			best = it;
		}
	}
	return best;
}

/**
 * Nearest usable solid (doors, lights, trees/cars/bins, vehicles, repairables); never a building record. A parked
 * vehicle (VEI-05) yields to any door in reach: it is passable and can be ridden from anywhere around it, a door only
 * from its threshold -- a bike left in a doorway must not take the door's E (review of 5874cfa).
 */
export function nearestUsableSolid(world: WorldData, x: number, y: number): Solid | undefined {
	let best: Solid | undefined;
	let bestD = SOLID_REACH;
	let door: Solid | undefined;
	let doorD = DOOR_REACH;
	for (const s of querySolids(
		world,
		x - INTERACT_RADIUS,
		y - INTERACT_RADIUS,
		x + INTERACT_RADIUS,
		y + INTERACT_RADIUS,
	)) {
		if (s.kind === "building" || (s.passable === true && !isVehicle(s))) continue;
		const isADoor = isDoor(s);
		const limit = isADoor ? DOOR_REACH : SOLID_REACH;
		const d = edgeDist(s, x, y);
		if (isADoor && d < doorD) {
			doorD = d;
			door = s;
		}
		if (d < limit && d < bestD) {
			bestD = d;
			best = s;
		}
	}
	if (best !== undefined && door !== undefined && isVehicle(best)) return door;
	return best;
}

/** the building the survivor stands INSIDE (leaning on the outer wall is not enough) */
export function buildingToSearch(world: WorldData, x: number, y: number): Solid | undefined {
	const b = buildingAt(world, x, y);
	if (b === undefined) return undefined;
	const loot = b.lootItems;
	return loot !== undefined && loot.size() > 0 ? b : undefined;
}

/** does a body (survivor or live zombie) overlap the solid's rect? (blocks closing a door on it) */
export function bodiesOverlapRect(
	s: Solid,
	players: ReadonlyArray<PlayerState>,
	zombies: ReadonlyArray<ZombieState>,
): boolean {
	for (const p of players) {
		if (rectCircleOverlap(s.x, s.y, s.w, s.h, p.x, p.y, PLAYER_RADIUS)) return true;
	}
	for (const z of zombies) {
		if (z.hp <= 0) continue;
		const zr = ZOMBIE_RADIUS * (z.scale ?? 1);
		if (rectCircleOverlap(s.x, s.y, s.w, s.h, z.x, z.y, zr)) return true;
	}
	return false;
}

/**
 * What E acts on, by priority: ground item → door / light / tree-car-bin / anything else in reach (repair) →
 * the loot of the building you stand in. A solid in reach always wins over the building: reaching through a wall
 * to loot is not a thing. The one exception is a parked vehicle (VEI-05), which comes after a door in reach and
 * after the loot: it can be ridden from anywhere around it, they cannot.
 */
export type InteractTarget =
	| { kind: "item"; item: GroundItem }
	| { kind: "door"; solid: Solid }
	| { kind: "light"; solid: Solid }
	| { kind: "mapItem"; solid: Solid }
	| { kind: "vehicle"; solid: Solid }
	| { kind: "solid"; solid: Solid }
	| { kind: "search"; building: Solid };

export function interactTarget(world: WorldData, x: number, y: number): InteractTarget | undefined {
	const item = nearestGroundItem(world, x, y);
	if (item !== undefined) return { kind: "item", item };
	const s = nearestUsableSolid(world, x, y);
	if (s !== undefined) {
		// ridden (server/sim/vehicles.ts), or repaired once broken (the "solid" path, VEI-05) -- after the loot of the
		// building you stand in: a bike parked indoors must not hide the search
		if (isVehicle(s)) {
			const b = buildingToSearch(world, x, y);
			if (b !== undefined) return { kind: "search", building: b };
			return { kind: "vehicle", solid: s };
		}
		if (isDoor(s)) return { kind: "door", solid: s };
		if (isLight(s)) return { kind: "light", solid: s };
		if (isMapItem(s)) return { kind: "mapItem", solid: s };
		return { kind: "solid", solid: s };
	}
	const b = buildingToSearch(world, x, y);
	if (b !== undefined) return { kind: "search", building: b };
	return undefined;
}
