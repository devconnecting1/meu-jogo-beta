/*
 * What the action button (E) would act on, as pure queries over the world (docs/MULTIPLAYER.md §11.2, §8.1).
 * The client shows the "E: …" hint and acts with them; the server (F3) validates `pickup`, `interact` and `search`
 * with the very same queries, at ITS position of the survivor. No Instances, no random numbers, no state.
 */
import { DESIGN } from "shared/engine/constants";
import type { ZombieState } from "shared/game/entities";
import { PLAYER_RADIUS, ZOMBIE_RADIUS } from "shared/game/physics";
import type { PlayerState } from "shared/game/player";
import { buildingAt, GroundItem, queryGroundItems, querySolids, Solid, WorldData } from "shared/game/world";
import { WINDOW_REACH, windowIntact } from "shared/game/windows";
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

/**
 * A gas station's pump island (EDI-16): a container of oil, searched like a building (MP-05) -- rolled lazily by
 * whoever comes near, shared, taken whole by the first E, back after ITEM_RESPAWN_HOURS.
 */
export function isPump(s: Solid): boolean {
	return s.tags === "pump";
}

/** does this container (a building, a pump island) hold something, as far as this side knows? */
export function holdsLoot(s: Solid): boolean {
	const loot = s.lootItems;
	return loot !== undefined && loot.size() > 0;
}

/**
 * The pump island nearest (x, y) within `reach` of its edge, out of `pumps` (the town's islands, listed once by the
 * caller: a town has ten). What the server's LootFlag tells a survivor standing outside (server/sim/interaction.ts).
 */
export function nearestPump(pumps: ReadonlyArray<Solid>, x: number, y: number, reach: number): Solid | undefined {
	let best: Solid | undefined;
	let bestD = reach;
	for (const s of pumps) {
		if (s.removed === true) continue;
		const d = edgeDist(s, x, y);
		if (d < bestD) {
			bestD = d;
			best = s;
		}
	}
	return best;
}

/** every pump island of the town (static: listed once per world by whoever needs them) */
export function pumpsOf(world: WorldData): Array<Solid> {
	const out = new Array<Solid>();
	for (const s of world.solids) if (isPump(s)) out.push(s);
	return out;
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

/** reused by every `nearestGroundItem`: the E hint asks every frame, and a table per answer would be garbage */
const ITEM_SCRATCH = new Array<GroundItem>();

/**
 * Nearest ground item within reach (DESIGN.ITEM_GET_DISTANCE).
 *
 * This runs every frame, for the "E: pick up" hint, and on the server for every E press. It used to take a
 * square root for each item in the world. Now: only the items in the reach's box (on the server the item grid
 * reads one to four cells of it, shared/game/world.ts `queryGroundItems`; a client scans its own short list), then
 * SQUARED distances, since `a < b` and `a² < b²` agree for non-negative numbers. The answer is identical; the
 * arithmetic is not.
 *
 * `skip` leaves items out (ITM-07: the ones the survivor has no room for), so that a full stack does not hide the
 * door, the search or the repair behind it. The server's E and the client's hint pass the same check.
 */
export function nearestGroundItem(
	world: WorldData,
	x: number,
	y: number,
	skip?: (it: GroundItem) => boolean,
): GroundItem | undefined {
	const reach = DESIGN.ITEM_GET_DISTANCE;
	let best: GroundItem | undefined;
	let bestD2 = reach * reach;
	const found = ITEM_SCRATCH;
	found.clear();
	queryGroundItems(world, x - reach, y - reach, x + reach, y + reach, found);
	for (const it of found) {
		if (skip !== undefined && skip(it)) continue;
		const dx = it.x - x;
		if (dx > reach || dx < -reach) continue;
		const dy = it.y - y;
		if (dy > reach || dy < -reach) continue;
		const d2 = dx * dx + dy * dy;
		// a tie (a boss's trophies land on one spot) goes to the oldest id: the grid's cells and a client's list are
		// in different orders, and the item the hint names must be the one the server hands over
		if (d2 < bestD2 || (d2 === bestD2 && best !== undefined && it.id < best.id)) {
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
		// a building's own walls and furniture do nothing on E: standing by the pharmacy shelves must search the
		// pharmacy, not "use" the shelf (a wall within reach used to swallow the search the same way)
		if (s.parentId !== undefined) continue;
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

/**
 * How close to a loot spot a survivor must stand to search (EDI-03): the spot is in front of the furniture that
 * holds the loot -- the fridge, the pharmacy shelves, the gun rack -- so this is "within arm's reach of it".
 */
export const LOOT_REACH = 96;

/** is (x, y) close enough to one of the building's loot spots? (a building without spots: anywhere inside) */
export function nearLootSpot(b: Solid, x: number, y: number): boolean {
	const spots = b.lootSpots;
	if (spots === undefined || spots.size() === 0) return true;
	for (const p of spots) {
		const dx = p.x - x;
		const dy = p.y - y;
		if (dx * dx + dy * dy <= LOOT_REACH * LOOT_REACH) return true;
	}
	return false;
}

/**
 * The building the survivor stands INSIDE (leaning on the outer wall is not enough), when they are at one of its
 * loot spots. The search itself still takes the whole building's loot (MP-05): the spots only say WHERE in the
 * building it is, so that the loot is where the furniture explains it (EDI-03).
 */
export function buildingToSearch(world: WorldData, x: number, y: number): Solid | undefined {
	const b = buildingAt(world, x, y);
	if (b === undefined) return undefined;
	const loot = b.lootItems;
	if (loot === undefined || loot.size() === 0) return undefined;
	return nearLootSpot(b, x, y) ? b : undefined;
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
 * What E acts on, by priority: ground item → door / light / tree-car-bin / pump island / anything else in reach
 * (repair) → the loot of the building you stand in → an intact window at hand (EDI-18, breaking it: last, so nothing
 * else ever becomes a smashed pane by accident). A solid in reach always wins over the building: reaching through
 * a wall to loot is not a thing. The one exception is a parked vehicle (VEI-05), which comes after a door in reach and
 * after the loot: it can be ridden from anywhere around it, they cannot. A pump island is the target in reach whether
 * or not it holds oil (a dry one does nothing, and the hint says nothing).
 */
export type InteractTarget =
	| { kind: "item"; item: GroundItem }
	| { kind: "door"; solid: Solid }
	| { kind: "light"; solid: Solid }
	| { kind: "mapItem"; solid: Solid }
	| { kind: "vehicle"; solid: Solid }
	| { kind: "pump"; solid: Solid }
	| { kind: "solid"; solid: Solid }
	| { kind: "search"; building: Solid }
	/** a window with its glass in, right at hand: E breaks it (EDI-18), the noisy shortcut */
	| { kind: "window"; solid: Solid };

/** reused by every `nearestIntactWindow` (the hint asks every frame) */
const WINDOW_SCRATCH = new Array<Solid>();

/**
 * The intact pane nearest (x, y) within WINDOW_REACH of its edge (EDI-18), or undefined. A small box: the pane has to
 * be right there, at arm's length, from inside or from outside.
 */
export function nearestIntactWindow(world: WorldData, x: number, y: number): Solid | undefined {
	const reach = WINDOW_REACH;
	let best: Solid | undefined;
	let bestD = reach;
	const found = WINDOW_SCRATCH;
	found.clear();
	querySolids(world, x - reach - 8, y - reach - 8, x + reach + 8, y + reach + 8, found);
	for (const s of found) {
		if (!windowIntact(s)) continue;
		const d = edgeDist(s, x, y);
		if (d < bestD) {
			bestD = d;
			best = s;
		}
	}
	found.clear();
	return best;
}

/**
 * `skip`: ground items E passes over (see `nearestGroundItem`). An intact window (EDI-18) comes LAST: after the ground,
 * every usable solid and the loot of the building -- a press meant for the shelf by the window never smashes the glass,
 * and the hint always says "E: Break window" before the press does.
 */
export function interactTarget(
	world: WorldData,
	x: number,
	y: number,
	skip?: (it: GroundItem) => boolean,
): InteractTarget | undefined {
	const item = nearestGroundItem(world, x, y, skip);
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
		if (isPump(s)) return { kind: "pump", solid: s };
		return { kind: "solid", solid: s };
	}
	const b = buildingToSearch(world, x, y);
	if (b !== undefined) return { kind: "search", building: b };
	const pane = nearestIntactWindow(world, x, y);
	if (pane !== undefined) return { kind: "window", solid: pane };
	return undefined;
}
