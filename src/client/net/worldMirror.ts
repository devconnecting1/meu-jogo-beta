/*
 * The client's mirror of the server's interactive world (docs/MULTIPLAYER.md §4.5, §6.3, §11.3 F3 front 3B).
 *
 * From WORLD_SERVER_PHASE the server owns the constructions, the doors, the lights, the ground items and the loot,
 * and tells every client what changed on the reliable `World` channel. This applies those deltas to the town this
 * client generated from the same seed:
 *
 *   SolidAdd / SolidRemove   a construction appears (rebuilt from its PLACEABLES row, with the SERVER's id) or goes
 *   DoorSet / LightSet       a door opens or closes, a lamp or a fire goes on or off (static or built)
 *   SolidHp                  a construction's hp, as a fraction of its maximum
 *   ItemAdd / ItemRemove     a ground item appears (with the server's id and velocity) or is gone
 *   LootFlag                 the building this survivor stands in has something to search (the CONTENT never
 *                            travels, §4.3: the flag leaves a placeholder the "E: Search" hint can see)
 *
 * Every delta is idempotent (an add of an id already here updates it; a removal of an id not here is ignored), so
 * the WorldInit a re-entry brings can be laid over a town that already holds some of it. `resetMirror` wipes what
 * only the server can know — the constructions, the items, the open doors, the loot flags — before a WorldInit is
 * laid down, so nothing of a previous visit to this town lingers.
 *
 * Pure module: no Instances, no services. tools/test-items.mjs drives it with the server's own deltas.
 */
import { DYNAMIC_ID_BASE } from "shared/net/mpConfig";
import { SolidState, WorldEv, WorldEvent } from "shared/net/protocol";
import {
	addSolid,
	GroundItem,
	removeGroundItem,
	removeSolid,
	Solid,
	spawnGroundItem,
	WorldData,
} from "shared/game/world";
import { fortifies, openingAt, PLACEABLES, PlaceableDef, placedSolid, PlaceRect } from "shared/sim/placement";
import { isDoor } from "shared/sim/interactQuery";
import { itemGone, lootGone } from "../systems/pickups";

/** is this one of the interactive-world deltas the mirror applies? */
export function isMirrorEvent(e: WorldEvent): boolean {
	return e.t >= WorldEv.SolidAdd && e.t <= WorldEv.LootFlag;
}

/** what a building flagged by LootFlag holds on this client: something, never what (§4.3) */
function lootPlaceholder(): Array<{ kind: number; id: number; count: number }> {
	return [{ kind: 0, id: 0, count: 0 }];
}

/** id → solid and id → item of ONE world, built the first time a delta needs it and kept in step by the mirror */
interface MirrorIndex {
	world: WorldData;
	solids: Map<number, Solid>;
	items: Map<number, GroundItem>;
}

let index: MirrorIndex | undefined;

function indexOf(world: WorldData): MirrorIndex {
	if (index !== undefined && index.world === world) return index;
	const solids = new Map<number, Solid>();
	for (const s of world.solids) solids.set(s.id, s);
	const items = new Map<number, GroundItem>();
	for (const it of world.items) items.set(it.id, it);
	index = { world, solids, items };
	return index;
}

/** the footprint of a construction from its row and its quarter turns (as shared/sim/placement.ts `ghostRect`) */
function footprint(def: PlaceableDef, rot: number): [number, number] {
	if (def.rotatable && (rot === 1 || rot === 3)) return [def.h, def.w];
	return [def.w, def.h];
}

/**
 * Where a construction stands: a barricade or a door the server snapped into a doorway or a window fills THAT gap
 * (EDI-13, shared/sim/placement.ts `snapToOpening`), and the SolidAdd carries only its corner -- the gap is found
 * again in this client's own copy of the town (`openingAt`); anything else is its row's footprint
 */
function standRect(world: WorldData, def: PlaceableDef, x: number, y: number, rot: number): PlaceRect {
	if (fortifies(def)) {
		const gap = openingAt(world, x, y);
		if (gap !== undefined) return gap;
	}
	const [w, h] = footprint(def, rot);
	return { x, y, w, h };
}

/** one delta of the interactive world, onto this client's town */
export function applyMirrorEvent(world: WorldData, e: WorldEvent): void {
	const ix = indexOf(world);
	if (e.t === WorldEv.SolidAdd) {
		let s = ix.solids.get(e.id);
		if (s === undefined) {
			const def = PLACEABLES[e.placeable] as PlaceableDef | undefined;
			if (def === undefined) return;
			s = addSolid(world, {
				...placedSolid(def, standRect(world, def, e.x, e.y, e.rot), e.rot),
				placeable: e.placeable,
				owner: e.owner,
			});
			// the SERVER's id (§4.5): every later delta about it names this one. The grid does not key on the id
			s.id = e.id;
			ix.solids.set(e.id, s);
		}
		s.hp = e.hp * s.hpMax;
		if (isDoor(s)) s.open = (e.state & SolidState.Open) !== 0;
		if ((e.state & SolidState.Powered) !== 0) s.powered = true;
		else if (s.powered !== undefined) s.powered = false;
		return;
	}
	if (e.t === WorldEv.SolidRemove) {
		const s = ix.solids.get(e.id);
		if (s === undefined) return;
		ix.solids.delete(e.id);
		if (s.removed !== true) removeSolid(world, s);
		return;
	}
	if (e.t === WorldEv.DoorSet) {
		const s = ix.solids.get(e.id);
		if (s !== undefined) s.open = (e.state & SolidState.Open) !== 0;
		return;
	}
	if (e.t === WorldEv.SolidHp) {
		for (const entry of e.entries) {
			const s = ix.solids.get(entry.id);
			if (s !== undefined) s.hp = entry.hp * s.hpMax;
		}
		return;
	}
	if (e.t === WorldEv.LightSet) {
		const s = ix.solids.get(e.id);
		if (s !== undefined) s.powered = e.powered;
		return;
	}
	if (e.t === WorldEv.ItemAdd) {
		const known = ix.items.get(e.id);
		if (known !== undefined) {
			// fewer than before: somebody took what their backpack had room for and left the rest (ITM-06, the save's
			// ceiling) -- for the pickup feedback that is a take like any other (client/systems/pickups.ts)
			const taken = known.count - e.count;
			known.x = e.x;
			known.y = e.y;
			known.vx = e.vx;
			known.vy = e.vy;
			known.count = e.count;
			if (taken > 0) itemGone(known.x, known.y, known.kind, known.itemId, taken);
			return;
		}
		const it = spawnGroundItem(world, e.kind, e.itemId, e.count, e.x, e.y, e.vx, e.vy);
		it.id = e.id;
		ix.items.set(e.id, it);
		return;
	}
	if (e.t === WorldEv.ItemRemove) {
		const it = ix.items.get(e.id);
		if (it === undefined) return;
		ix.items.delete(e.id);
		removeGroundItem(world, it);
		// half of what tells this survivor's pickup from a bag that grew for another reason (client/systems/pickups.ts)
		itemGone(it.x, it.y, it.kind, it.itemId, it.count);
		return;
	}
	if (e.t === WorldEv.LootFlag) {
		const b = ix.solids.get(e.buildingId);
		if (b === undefined || b.kind !== "building") return;
		const had = (b.lootItems?.size() ?? 0) > 0;
		b.lootItems = e.hasLoot ? lootPlaceholder() : [];
		if (had && !e.hasLoot) lootGone();
	}
}

/**
 * Everything only the server can know about this town, wiped before a WorldInit is laid over it: the constructions
 * and the items (all of them have server ids), the doors of the generated map back to closed (the WorldInit names the
 * open ones), and every loot flag (the next LootFlag names the building this survivor is in).
 */
export function resetMirror(world: WorldData): void {
	const ix = indexOf(world);
	const built = new Array<Solid>();
	for (const s of world.solids) {
		if (s.id >= DYNAMIC_ID_BASE || s.placeable !== undefined) built.push(s);
		else if (isDoor(s)) s.open = false;
		else if (s.kind === "building" && s.lootItems !== undefined) s.lootItems = [];
	}
	for (const s of built) {
		ix.solids.delete(s.id);
		removeSolid(world, s);
	}
	world.items.clear();
	ix.items.clear();
}

/** a new town (a rebuild) needs a new index: the next delta builds it */
export function forgetMirrorIndex(): void {
	index = undefined;
}
