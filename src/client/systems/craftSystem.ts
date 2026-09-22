import { CRAFT_RECIPES, CraftRecipe } from "shared/data/crafts";
import { Solid } from "shared/game/world";
import { addItem, countItem, removeItem } from "./items";
import { GameRefs } from "./types";

const DESK_RANGE = 180;

function nearestDesk(refs: GameRefs): Solid | undefined {
	const p = refs.player;
	let best: Solid | undefined;
	let bestD = DESK_RANGE;
	for (const s of refs.world.solids) {
		if (s.kind !== "structure") continue;
		if (s.tags !== "craftdesk" && s.tags !== "craftdesk_pro") continue;
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const d = math.max(math.abs(cx - p.x) - s.w / 2, math.abs(cy - p.y) - s.h / 2);
		if (d < bestD) {
			bestD = d;
			best = s;
		}
	}
	return best;
}

export function canCraft(refs: GameRefs, r: CraftRecipe): boolean {
	if (refs.pendingPlace >= 0) return false;
	if (r.needsDesk || r.needsPro) {
		const desk = nearestDesk(refs);
		if (desk === undefined) return false;
		if (r.needsPro && desk.tags !== "craftdesk_pro") return false;
	}
	for (const ing of r.ingredients) {
		if (countItem(refs.save, ing.kind, ing.index) < ing.count) return false;
	}
	return true;
}

export function craft(refs: GameRefs, recipeId: number): boolean {
	const r = CRAFT_RECIPES[recipeId];
	if (r === undefined) return false;
	if (!canCraft(refs, r)) return false;
	for (const ing of r.ingredients) {
		removeItem(refs.save, ing.kind, ing.index, ing.count);
	}
	if (r.craftKind === 1) {
		refs.pendingPlace = r.resultIndex;
	} else {
		addItem(refs.save, r.resultKind, r.resultIndex, r.resultCount);
	}
	return true;
}

export function craftableList(refs: GameRefs): Array<number> {
	const out: Array<number> = [];
	for (const r of CRAFT_RECIPES) {
		if (canCraft(refs, r)) out.push(r.id);
	}
	return out;
}
