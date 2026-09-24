/*
 * What the action button (E) would act on, as pure queries over the world (docs/MULTIPLAYER.md §11.2, §8.1).
 * The client shows the "E: …" hint and acts with them; the server (F3) validates `pickup`, `interact` and `search`
 * with the very same queries, at ITS position of the survivor. No Instances, no random numbers, no state.
 */
import { YARD_TAGS } from "shared/data/spawns";
import { DESIGN } from "shared/engine/constants";
import type { ZombieState } from "shared/game/entities";
import { PLAYER_RADIUS, segmentClear, ZOMBIE_RADIUS } from "shared/game/physics";
import type { PlayerState } from "shared/game/player";
import { buildingAt, GroundItem, isBlocking, queryGroundItems, querySolids, Solid, WorldData } from "shared/game/world";
import { WINDOW_REACH, windowIntact } from "shared/game/windows";
import { rectCircleOverlap } from "./placement";
import { inVaultOf, isVaultBox } from "./vault";
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

/**
 * A container out in the open, searched like a pump island (the same lazy roll, the same shared take, the same
 * LootFlag): a pump island, or one of the everyday town's searchable fixtures -- a market stall, the market's food
 * truck, a pile of building material, a garden shed (shared/data/spawns.ts YARD_TAGS, EDI-21, EDI-22, MOB-06).
 */
export function isYardContainer(s: Solid): boolean {
	return s.tags === "pump" || (s.lootSlots !== undefined && YARD_TAGS.includes(s.tags));
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

/**
 * Every container out in the open of the town (`isYardContainer`: the pump islands, the market's stalls and food
 * truck, the construction site's piles, the backyards' sheds) -- static: listed once per world by whoever needs them.
 */
export function pumpsOf(world: WorldData): Array<Solid> {
	const out = new Array<Solid>();
	for (const s of world.solids) if (isYardContainer(s)) out.push(s);
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
		// nor does a fixture of the town that holds nothing (a bench, a hydrant, a street lamp): only the searchable
		// ones -- a market stall, a pile, a shed -- are E's (`isYardContainer`)
		if (s.kind === "prop" && s.lootSlots === undefined) continue;
		// a bank's deposit boxes are reached from inside its vault only, never through the wall (EDI-24)
		if (isVaultBox(s) && !inVaultOf(world, s.bankId, x, y)) continue;
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
 * (repair) → the loot of the building you stand in. A solid in reach always wins over the building: reaching through
 * a wall to loot is not a thing. The one exception is a parked vehicle (VEI-05), which comes after a door in reach and
 * after the loot: it can be ridden from anywhere around it, they cannot. A pump island is the target in reach whether
 * or not it holds oil (a dry one does nothing, and the hint says nothing).
 *
 * A window's glass (EDI-18) is never one of these: breaking it is its own intent (`nearestIntactWindow`), asked for
 * only when nothing here is in reach and carried as `HeldBit.Glass` (protocol.ts note 23) -- so no press meant for
 * something else can ever smash a pane, on this client's world or on the server's.
 */
export type InteractTarget =
	| { kind: "item"; item: GroundItem }
	| { kind: "door"; solid: Solid }
	| { kind: "light"; solid: Solid }
	| { kind: "mapItem"; solid: Solid }
	| { kind: "vehicle"; solid: Solid }
	| { kind: "pump"; solid: Solid }
	| { kind: "solid"; solid: Solid }
	| { kind: "search"; building: Solid };

/** reused by every `nearestIntactWindow` (the hint asks every frame) */
const WINDOW_SCRATCH = new Array<Solid>();
/** the pane `paneAtHand` looks at: its own glass is not in the way of the line to it */
let paneLooked: Solid | undefined;
const blocksPaneLine = (s: Solid): boolean => s !== paneLooked && isBlocking(s);

/**
 * Is intact pane `s` at hand from (x, y)? Within `reach` of its edge, and a clear line to it -- to a point 1.5 u INSIDE
 * the pane, so the wall it sits in (touching its ends) is never "in the way" of a survivor standing at an angle, while a
 * wall between them is. The ONE test of the client's hint and the server's check (server/sim/windows.ts `byHand`).
 */
export function paneAtHand(
	world: WorldData,
	s: Solid,
	x: number,
	y: number,
	reach: number,
): "ok" | "range" | "blocked" {
	if (edgeDist(s, x, y) > reach) return "range";
	const inset = 1.5;
	const px = math.clamp(x, s.x + math.min(inset, s.w / 2), s.x + s.w - math.min(inset, s.w / 2));
	const py = math.clamp(y, s.y + math.min(inset, s.h / 2), s.y + s.h - math.min(inset, s.h / 2));
	paneLooked = s;
	const clear = segmentClear(world, x, y, px, py, blocksPaneLine);
	paneLooked = undefined;
	return clear ? "ok" : "blocked";
}

/**
 * The intact pane nearest (x, y) at hand (EDI-18, `paneAtHand`: within `reach` of its edge, WINDOW_REACH for the hint,
 * with a clear line), or undefined. A small box: the pane has to be right there, at arm's length, from inside or from
 * outside. The client asks it with its reach; the server with the latency slack every E gets.
 */
export function nearestIntactWindow(world: WorldData, x: number, y: number, reach = WINDOW_REACH): Solid | undefined {
	let best: Solid | undefined;
	let bestD = math.huge;
	const found = WINDOW_SCRATCH;
	found.clear();
	querySolids(world, x - reach - 8, y - reach - 8, x + reach + 8, y + reach + 8, found);
	for (const s of found) {
		if (!windowIntact(s)) continue;
		const d = edgeDist(s, x, y);
		if (d >= bestD || paneAtHand(world, s, x, y, reach) !== "ok") continue;
		bestD = d;
		best = s;
	}
	found.clear();
	return best;
}

/** `skip`: ground items E passes over (see `nearestGroundItem`). Never a window's glass (see InteractTarget). */
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
		// a pump island, or any other container out in the open (a market stall, a shed): taken like the pump's fuel
		if (isYardContainer(s)) return { kind: "pump", solid: s };
		return { kind: "solid", solid: s };
	}
	const b = buildingToSearch(world, x, y);
	if (b !== undefined) return { kind: "search", building: b };
	return undefined;
}
