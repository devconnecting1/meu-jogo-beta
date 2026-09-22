import { DESIGN } from "shared/engine/constants";
import { choose, rndInt } from "shared/engine/rng";
import { GroundItem, Solid } from "shared/game/world";
import { BUILDING_SPAWNS } from "shared/data/spawns";
import { addItem } from "./items";
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

function findSolid(refs: GameRefs): Solid | undefined {
	const p = refs.player;
	let best: Solid | undefined;
	let bestD = 40;
	for (const s of refs.world.solids) {
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

export class Interaction {
	tryInteract(refs: GameRefs): void {
		if (refs.pendingPlace >= 0) return;
		const item = findItem(refs);
		if (item !== undefined) {
			takeItem(refs, item);
			return;
		}
		const s = findSolid(refs);
		if (s === undefined) return;
		if (s.kind === "door" || s.kind === "iron_door") {
			s.open = !(s.open ?? false);
			return;
		}
		if (s.tags === "campfire" || s.tags === "lamp" || s.tags === "brazier") {
			s.powered = !(s.powered ?? false);
			return;
		}
		if (s.lootItems !== undefined && s.lootItems.size() > 0) {
			for (const loot of s.lootItems) {
				addItem(refs.save, loot.kind, loot.id, loot.count);
			}
			s.lootItems = [];
			s.lootTimer = DESIGN.ITEM_RESPAWN_HOURS * 3600;
			return;
		}
		tryRepair(refs, s);
	}

	update(refs: GameRefs, dt: number): void {
		const p = refs.player;
		for (const s of refs.world.solids) {
			if (s.buildingType === undefined) continue;
			const near = edgeDist(s, p.x, p.y) < 320;
			if (!near) continue;
			if (s.lootTimer !== undefined && s.lootTimer > 0) {
				s.lootTimer -= dt;
				if (s.lootTimer < 0) s.lootTimer = 0;
			}
			const loot = s.lootItems;
			if (loot !== undefined && loot.size() === 0 && (s.lootTimer ?? 0) <= 0) {
				rollLoot(s);
			}
		}
	}
}
