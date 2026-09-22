import { DESIGN } from "shared/engine/constants";
import { choose, chance, rndInt, rndRange } from "shared/engine/rng";
import { PLAYER_RADIUS, ZOMBIE_RADIUS } from "shared/game/physics";
import { buildingAt, GroundItem, Solid, querySolids, spawnGroundItem } from "shared/game/world";
import { BUILDING_SPAWNS } from "shared/data/spawns";
import { itemName } from "./craftSystem";
import { addItem, countItem, removeItem } from "./items";
import { GameRefs } from "./types";

const REPAIRABLE: Array<string> = [
	"craftdesk",
	"craftdesk_pro",
	"turret",
	"barricade",
	"iron_barricade",
	"door",
	"iron_door",
];

/** cooldown (seconds left) per map item (tree/car/trash) since its last hit */
const hitCooldowns = new Map<Solid, number>();

interface LootEntry {
	kind: number;
	index: number;
	/** < 1 → probability (as a fraction) of dropping exactly 1; otherwise the quantity dropped */
	amount: number;
}

const TREE_LOOT: Array<LootEntry> = [
	{ kind: 4, index: 23, amount: 2 },
	{ kind: 3, index: 17, amount: 0.1 },
	{ kind: 3, index: 18, amount: 0.1 },
];

const CAR_LOOT: Array<LootEntry> = [
	{ kind: 4, index: 25, amount: 1 },
	{ kind: 4, index: 30, amount: 0.1 },
	{ kind: 4, index: 36, amount: 0.05 },
];

const TRASH_LOOT: Array<LootEntry> = [
	{ kind: 4, index: 23, amount: 1 },
	{ kind: 4, index: 24, amount: 1 },
	{ kind: 4, index: 25, amount: 0.1 },
	{ kind: 4, index: 29, amount: 0.1 },
	{ kind: 4, index: 30, amount: 0.1 },
];

function isMapItem(s: Solid): boolean {
	return s.kind === "tree" || s.tags === "car" || s.tags === "trash";
}

function lootTableFor(s: Solid): Array<LootEntry> | undefined {
	if (s.kind === "tree") return TREE_LOOT;
	if (s.tags === "car") return CAR_LOOT;
	if (s.tags === "trash") return TRASH_LOOT;
	return undefined;
}

/** spawn point: nearest point of the solid's rect to the player, pushed 24px further out towards them */
function spawnFromSolid(refs: GameRefs, s: Solid, kind: number, index: number, count: number): void {
	const p = refs.player;
	const qx = math.clamp(p.x, s.x, s.x + s.w);
	const qy = math.clamp(p.y, s.y, s.y + s.h);
	let dx = p.x - qx;
	let dy = p.y - qy;
	let dist = math.sqrt(dx * dx + dy * dy);
	if (dist < 1e-3) {
		// player exactly on the rect edge: fall back to pushing away from its centre
		dx = qx - (s.x + s.w / 2);
		dy = qy - (s.y + s.h / 2);
		dist = math.sqrt(dx * dx + dy * dy);
		if (dist < 1e-3) {
			dx = 1;
			dy = 0;
			dist = 1;
		}
	}
	const nx = dx / dist;
	const ny = dy / dist;
	const sx = qx + nx * 24;
	const sy = qy + ny * 24;
	const angle = math.atan2(ny, nx) + rndRange(-0.6, 0.6);
	const speed = rndRange(60, 150);
	spawnGroundItem(refs.world, kind, index, count, sx, sy, math.cos(angle) * speed, math.sin(angle) * speed);
}

/**
 * A melee/ranged hit lands on a map item (tree/car/trash). Own cooldown per solid
 * (DESIGN.MAP_ITEM_HIT_TIME); while on cooldown this is a no-op. Otherwise shakes the sprite and,
 * with DESIGN.MAP_ITEM_PERCENT% chance, drops loot from the object's table.
 */
export function hitMapItem(refs: GameRefs, s: Solid, choppingTool: boolean): boolean {
	const cd = hitCooldowns.get(s);
	if (cd !== undefined && cd > 0) return false;
	hitCooldowns.set(s, DESIGN.MAP_ITEM_HIT_TIME);
	s.hitShake = 0.25;

	const lootTable = lootTableFor(s);
	if (lootTable === undefined) return true;
	if (!chance(DESIGN.MAP_ITEM_PERCENT)) return true;

	if (choppingTool && s.kind === "tree") {
		const count = 2 + (chance(50) ? 1 : 0);
		spawnFromSolid(refs, s, 4, 23, count);
		return true;
	}

	const entry = choose(lootTable);
	if (entry.amount < 1) {
		if (!chance(entry.amount * 100)) return true;
		spawnFromSolid(refs, s, entry.kind, entry.index, 1);
	} else {
		spawnFromSolid(refs, s, entry.kind, entry.index, entry.amount);
	}
	return true;
}

/** absolute game clock in hours (day × 24 + time of day) — building loot respawn timestamps */
function gameHours(refs: GameRefs): number {
	return refs.daynight.day * 24 + refs.daynight.dayTime;
}

function edgeDist(s: Solid, x: number, y: number): number {
	const cx = s.x + s.w / 2;
	const cy = s.y + s.h / 2;
	return math.max(math.abs(cx - x) - s.w / 2, math.abs(cy - y) - s.h / 2);
}

function findItem(refs: GameRefs): GroundItem | undefined {
	const p = refs.player;
	let best: GroundItem | undefined;
	let bestD: number = DESIGN.ITEM_GET_DISTANCE;
	for (const it of refs.world.items) {
		const d = math.sqrt((it.x - p.x) * (it.x - p.x) + (it.y - p.y) * (it.y - p.y));
		if (d < bestD) {
			bestD = d;
			best = it;
		}
	}
	return best;
}

const INTERACT_RADIUS = 80;

/** nearest non-building, non-passable solid within range (doors/lights/map-items/repairables) */
function findSolid(refs: GameRefs): Solid | undefined {
	const p = refs.player;
	let best: Solid | undefined;
	let bestD = 40;
	for (const s of querySolids(
		refs.world,
		p.x - INTERACT_RADIUS,
		p.y - INTERACT_RADIUS,
		p.x + INTERACT_RADIUS,
		p.y + INTERACT_RADIUS,
	)) {
		if (s.kind === "building" || s.passable === true) continue;
		const isDoor = s.kind === "door" || s.kind === "iron_door";
		const limit = isDoor ? 30 : 40;
		const d = edgeDist(s, p.x, p.y);
		if (d < limit && d < bestD) {
			bestD = d;
			best = s;
		}
	}
	return best;
}

/** the building record (footprint) the player stands in or is within 40px of, if any */
function findBuilding(refs: GameRefs): Solid | undefined {
	// you loot a building from INSIDE it (leaning on the outer wall is not enough)
	const p = refs.player;
	return buildingAt(refs.world, p.x, p.y);
}

// --- fires (campfire / brazier) burn wood -------------------------------------------------------

/** obj_campfire: 1000 wood burning 0.1/frame → ~5.5 min of fire; relighting costs 5 wood */
const FIRE_TIME = 1000 / 0.1 / 30;
const FIRE_WOOD = 5;
const WOOD_INDEX = 23;
/** seconds of fire left per campfire/brazier (absent = freshly built, full) */
const fireFuel = new Map<Solid, number>();
let fireTick = 0;

function isFire(s: Solid): boolean {
	return s.tags === "campfire" || s.tags === "brazier";
}

function fuelOf(s: Solid): number {
	return fireFuel.get(s) ?? FIRE_TIME;
}

/**
 * E on a light: lamps just switch; a fire goes out / relights while it still has wood, and an
 * empty fire takes 5 wood from the backpack. Returns a message when it cannot be lit.
 */
function toggleLight(refs: GameRefs, s: Solid): string | undefined {
	if (!isFire(s)) {
		s.powered = !(s.powered ?? false);
		return undefined;
	}
	if (s.powered === true) {
		s.powered = false;
		return undefined;
	}
	if (fuelOf(s) <= 0) {
		if (countItem(refs.save, 4, WOOD_INDEX) < FIRE_WOOD) {
			return `Missing: ${itemName(4, WOOD_INDEX)} ${math.floor(countItem(refs.save, 4, WOOD_INDEX))}/${FIRE_WOOD}`;
		}
		removeItem(refs.save, 4, WOOD_INDEX, FIRE_WOOD);
		fireFuel.set(s, FIRE_TIME);
	}
	s.powered = true;
	return undefined;
}

/** burn the fires around the player; an empty one goes out (and stops lighting / smelting) */
function burnFires(refs: GameRefs, dt: number): void {
	fireTick += dt;
	if (fireTick < 0.5) return;
	const step = fireTick;
	fireTick = 0;
	const p = refs.player;
	for (const s of querySolids(refs.world, p.x - 2500, p.y - 2500, p.x + 2500, p.y + 2500)) {
		if (!isFire(s) || s.powered !== true) continue;
		const left = fuelOf(s) - step;
		fireFuel.set(s, left);
		if (left <= 0) {
			fireFuel.set(s, 0);
			s.powered = false;
		}
	}
	for (const [s] of fireFuel) {
		if (s.removed === true) fireFuel.delete(s);
	}
}

function rectCircleOverlap(
	rx: number,
	ry: number,
	rw: number,
	rh: number,
	cx: number,
	cy: number,
	cr: number,
): boolean {
	const qx = math.clamp(cx, rx, rx + rw);
	const qy = math.clamp(cy, ry, ry + rh);
	const dx = cx - qx;
	const dy = cy - qy;
	return dx * dx + dy * dy < cr * cr;
}

/** true when the player's or a live zombie's body overlaps the solid's rect (blocks closing a door on them) */
function actorOverlapsRect(refs: GameRefs, s: Solid): boolean {
	const p = refs.player;
	if (rectCircleOverlap(s.x, s.y, s.w, s.h, p.x, p.y, PLAYER_RADIUS)) return true;
	for (const z of refs.zombies) {
		if (z.hp <= 0) continue;
		const zr = ZOMBIE_RADIUS * (z.scale ?? 1);
		if (rectCircleOverlap(s.x, s.y, s.w, s.h, z.x, z.y, zr)) return true;
	}
	return false;
}

function takeItem(refs: GameRefs, it: GroundItem): void {
	addItem(refs.save, it.kind, it.itemId, it.count);
	const idx = refs.world.items.indexOf(it);
	if (idx >= 0) refs.world.items.remove(idx);
}

function rollLoot(s: Solid): void {
	const bt = s.buildingType ?? 0;
	const lootTable = bt < BUILDING_SPAWNS.size() ? BUILDING_SPAWNS[bt] : BUILDING_SPAWNS[0];
	const slots = s.lootSlots ?? 2;
	const loot: Array<{ kind: number; id: number; count: number }> = [];
	for (let i = 0; i < slots; i++) {
		const e = choose(lootTable);
		let count = 1;
		if (e.max < 1) {
			if (math.random() * 100 >= e.max * 100) continue;
		} else {
			count = rndInt(e.min, e.max);
		}
		loot.push({ kind: e.kind, id: e.index, count });
	}
	s.lootItems = loot;
}

function repairMaterial(s: Solid): { kind: number; index: number } {
	if (s.kind === "iron_door" || s.tags === "iron_barricade" || s.tags === "turret") {
		return { kind: 4, index: 26 };
	}
	return { kind: 4, index: 23 };
}

function tryRepair(refs: GameRefs, s: Solid): boolean {
	if (s.hp >= s.hpMax) return false;
	if (!REPAIRABLE.includes(s.tags)) return false;
	const mat = repairMaterial(s);
	if (refs.save.invenEtc[mat.index] <= 0) return false;
	refs.save.invenEtc[mat.index] = refs.save.invenEtc[mat.index] - 1;
	const rate = refs.save.skillLevels[17] > 0 ? 0.5 : 0.25;
	s.hp = math.min(s.hpMax, s.hp + s.hpMax * rate);
	return true;
}

const BUILDING_NAMES: Record<string, string> = {
	house: "house",
	gas: "gas station",
	pharmacy: "pharmacy",
	market: "market",
	gunshop: "gun shop",
	cloth: "clothing store",
	restaurant: "restaurant",
	school: "school",
	hospital: "hospital",
};

/**
 * What the action button (E) would do right now, for the HUD — same priority as tryInteract:
 * ground item → door / light / tree-car-trash / repair → loot the building you are in.
 * undefined = nothing to do (hide the button).
 */
export function interactHint(refs: GameRefs): string | undefined {
	if (refs.pendingPlace >= 0) return undefined;
	const item = findItem(refs);
	if (item !== undefined) {
		const n = itemName(item.kind, item.itemId);
		return item.count > 1 ? `E: Pick up ${n} x${item.count}` : `E: Pick up ${n}`;
	}
	const s = findSolid(refs);
	if (s !== undefined) {
		if (s.kind === "door" || s.kind === "iron_door") {
			if (s.open === true) return actorOverlapsRect(refs, s) ? undefined : "E: Close door";
			return "E: Open door";
		}
		if (s.tags === "campfire" || s.tags === "lamp" || s.tags === "brazier") {
			if (s.powered === true) return s.tags === "lamp" ? "E: Turn off" : "E: Put out";
			if (isFire(s) && fuelOf(s) <= 0) return `E: Light (${FIRE_WOOD} ${itemName(4, WOOD_INDEX)})`;
			return s.tags === "lamp" ? "E: Turn on" : "E: Light";
		}
		if (s.kind === "tree") return "E: Shake tree";
		if (s.tags === "car") return "E: Search car";
		if (s.tags === "trash") return "E: Search trash";
		if (s.hp < s.hpMax && REPAIRABLE.includes(s.tags)) {
			const mat = repairMaterial(s);
			const have = refs.save.invenEtc[mat.index] ?? 0;
			return have > 0
				? `E: Repair (${itemName(mat.kind, mat.index)})`
				: `Repair: needs ${itemName(mat.kind, mat.index)}`;
		}
		return undefined;
	}
	const b = findBuilding(refs);
	if (b !== undefined && b.lootItems !== undefined && b.lootItems.size() > 0) {
		return `E: Search ${BUILDING_NAMES[b.tags] ?? b.tags}`;
	}
	return undefined;
}

export class Interaction {
	tryInteract(refs: GameRefs): void {
		if (refs.pendingPlace >= 0) return;
		const item = findItem(refs);
		if (item !== undefined) {
			takeItem(refs, item);
			return;
		}
		const s = findSolid(refs);
		if (s !== undefined) {
			if (s.kind === "door" || s.kind === "iron_door") {
				const willOpen = !(s.open ?? false);
				if (!willOpen && actorOverlapsRect(refs, s)) return;
				s.open = willOpen;
				return;
			}
			if (s.tags === "campfire" || s.tags === "lamp" || s.tags === "brazier") {
				const why = toggleLight(refs, s);
				if (why !== undefined) refs.onMessage(why);
				return;
			}
			if (isMapItem(s)) {
				hitMapItem(refs, s, false);
				return;
			}
			tryRepair(refs, s);
			return;
		}
		const b = findBuilding(refs);
		if (b !== undefined && b.lootItems !== undefined && b.lootItems.size() > 0) {
			for (const loot of b.lootItems) {
				addItem(refs.save, loot.kind, loot.id, loot.count);
			}
			b.lootItems = [];
			// respawn after ITEM_RESPAWN_HOURS of GAME time (was 12 real hours, i.e. never)
			b.lootTimer = gameHours(refs) + DESIGN.ITEM_RESPAWN_HOURS;
		}
	}

	update(refs: GameRefs, dt: number): void {
		burnFires(refs, dt);
		for (const [solid, t] of hitCooldowns) {
			if (solid.removed === true) {
				hitCooldowns.delete(solid);
				continue;
			}
			const nt = t - dt;
			if (nt <= 0) {
				hitCooldowns.delete(solid);
			} else {
				hitCooldowns.set(solid, nt);
			}
		}

		const p = refs.player;
		const radius = 320;
		for (const s of querySolids(refs.world, p.x - radius, p.y - radius, p.x + radius, p.y + radius)) {
			if (s.kind !== "building") continue;
			if (edgeDist(s, p.x, p.y) >= radius) continue;
			const loot = s.lootItems;
			if (loot !== undefined && loot.size() === 0 && gameHours(refs) >= (s.lootTimer ?? 0)) {
				rollLoot(s);
			}
		}
	}
}
