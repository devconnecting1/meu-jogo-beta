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

/** solids are looked up in a box of this half-size around the survivor */
export const INTERACT_RADIUS = 80;
/** edge distance at which a solid can be used (a door has to be nearer) */
export const SOLID_REACH = 40;
export const DOOR_REACH = 30;

/** tags that can be repaired with wood or steel */
export const REPAIRABLE: ReadonlyArray<string> = [
	"craftdesk",
	"craftdesk_pro",
	"turret",
	"barricade",
	"iron_barricade",
	"door",
	"iron_door",
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

/** a campfire, brazier or lamp: E switches it */
export function isLight(s: Solid): boolean {
	return s.tags === "campfire" || s.tags === "lamp" || s.tags === "brazier";
}

/** burns wood (a lamp does not) */
export function isFire(s: Solid): boolean {
	return s.tags === "campfire" || s.tags === "brazier";
}

/** tree, car or bin: hitting or searching it may drop materials */
export function isMapItem(s: Solid): boolean {
	return s.kind === "tree" || s.tags === "car" || s.tags === "trash";
}

/** wood repairs everything but iron doors, iron barricades and turrets (steel) */
export function repairMaterial(s: Solid): { kind: number; index: number } {
	if (s.kind === "iron_door" || s.tags === "iron_barricade" || s.tags === "turret") {
		return { kind: 4, index: 26 };
	}
	return { kind: 4, index: 23 };
}

/** damaged and repairable (the material still has to be in the backpack) */
export function canRepair(s: Solid): boolean {
	return s.hp < s.hpMax && REPAIRABLE.includes(s.tags);
}

/** nearest ground item within reach (DESIGN.ITEM_GET_DISTANCE) */
export function nearestGroundItem(world: WorldData, x: number, y: number): GroundItem | undefined {
	let best: GroundItem | undefined;
	let bestD: number = DESIGN.ITEM_GET_DISTANCE;
	for (const it of world.items) {
		const d = math.sqrt((it.x - x) * (it.x - x) + (it.y - y) * (it.y - y));
		if (d < bestD) {
			bestD = d;
			best = it;
		}
	}
	return best;
}

/** nearest usable solid (doors, lights, trees/cars/bins, repairables); never a building record */
export function nearestUsableSolid(world: WorldData, x: number, y: number): Solid | undefined {
	let best: Solid | undefined;
	let bestD = SOLID_REACH;
	for (const s of querySolids(
		world,
		x - INTERACT_RADIUS,
		y - INTERACT_RADIUS,
		x + INTERACT_RADIUS,
		y + INTERACT_RADIUS,
	)) {
		if (s.kind === "building" || s.passable === true) continue;
		const limit = isDoor(s) ? DOOR_REACH : SOLID_REACH;
		const d = edgeDist(s, x, y);
		if (d < limit && d < bestD) {
			bestD = d;
			best = s;
		}
	}
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
 * to loot is not a thing.
 */
export type InteractTarget =
	| { kind: "item"; item: GroundItem }
	| { kind: "door"; solid: Solid }
	| { kind: "light"; solid: Solid }
	| { kind: "mapItem"; solid: Solid }
	| { kind: "solid"; solid: Solid }
	| { kind: "search"; building: Solid };

export function interactTarget(world: WorldData, x: number, y: number): InteractTarget | undefined {
	const item = nearestGroundItem(world, x, y);
	if (item !== undefined) return { kind: "item", item };
	const s = nearestUsableSolid(world, x, y);
	if (s !== undefined) {
		if (isDoor(s)) return { kind: "door", solid: s };
		if (isLight(s)) return { kind: "light", solid: s };
		if (isMapItem(s)) return { kind: "mapItem", solid: s };
		return { kind: "solid", solid: s };
	}
	const b = buildingToSearch(world, x, y);
	if (b !== undefined) return { kind: "search", building: b };
	return undefined;
}
