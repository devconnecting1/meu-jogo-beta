import { ETC_ITEMS } from "shared/data/etcItems";
import { PlayerSaveData } from "shared/game/save";
import { querySolids, Solid } from "shared/game/world";
import { placeRecipe } from "shared/sim/placement";
import type { GameRefs } from "../systems/types";

/*
 * The five things a survivor has to know, in the order the town teaches them.
 *
 * Nothing here interrupts the game: an objective watches the world and notices when the player has already
 * done the thing. That is the whole point — the deck this replaces asked the player to read about walking
 * before they had walked.
 *
 * The last one has a deadline (19:00, when the first wave comes) because it is the one lesson the game will
 * otherwise teach with a death: the night is dark and fire is the answer. Missing it is not punished — the
 * objective just says so and steps aside.
 */

export interface ObjectiveTarget {
	x: number;
	y: number;
	/** "go here" (a place) vs "hit this" (a body): the pointer draws them differently */
	kind: "place" | "body";
}

export interface ObjectiveView {
	/** short imperative, e.g. "Search a house" */
	title: string;
	/** one line of how */
	hint: string;
	/** "4 / 10 wood", or "" */
	progress: string;
	/** 0..1 for the objective's own bar, or -1 when it has no measurable progress */
	ratio: number;
	target: ObjectiveTarget | undefined;
}

/** scratch state an objective keeps while it is the current one */
export interface Memory {
	distance: number;
	lastX: number;
	lastY: number;
	items: number;
	campfires: number;
	/** building solid id → how much loot it held last time we looked */
	loot: Map<number, number>;
	lootScan: number;
	looted: boolean;
	/** the campfire deadline went past while this objective was open */
	late: boolean;
}

export interface Objective {
	id: string;
	title: string;
	hint: string;
	/** prepares the memory when this objective becomes the current one */
	begin(refs: GameRefs, mem: Memory): void;
	/** watches the world; true once the player has done it */
	done(refs: GameRefs, mem: Memory): boolean;
	/** what the arrow points at, if anything */
	target(refs: GameRefs, mem: Memory): ObjectiveTarget | undefined;
	/** progress line + bar ratio (-1 = no bar) */
	view?(refs: GameRefs, mem: Memory): { progress: string; ratio: number };
}

const CAMPFIRE_ETC = ETC_ITEMS.findIndex(e => e.name === "Campfire");
const CAMPFIRE_RECIPE = CAMPFIRE_ETC >= 0 ? placeRecipe(CAMPFIRE_ETC) : undefined;
const WOOD_INGREDIENT = CAMPFIRE_RECIPE?.ingredients[0];
/** ETC index of the wood a campfire is made of, read from the recipe so the number never drifts */
const WOOD_ETC = WOOD_INGREDIENT?.index ?? ETC_ITEMS.findIndex(e => e.name === "Wood");
const WOOD_NEEDED = WOOD_INGREDIENT?.count ?? 10;

/** the night starts at 19:00 (daynight.ts); the campfire lesson is due before it */
export const FIRE_DEADLINE_HOUR = 19;
/** ~3.6 m: far enough that the player has really walked, close enough that it happens in seconds */
const MOVE_DISTANCE = 260;
/** how often the building sweep runs (seconds): loot changes on an E press, not per frame */
const LOOT_SCAN = 0.2;
/** the sweep's reach around the survivor, in world units */
const LOOT_RANGE = 1100;

export function newMemory(): Memory {
	return {
		distance: 0,
		lastX: 0,
		lastY: 0,
		items: 0,
		campfires: 0,
		loot: new Map<number, number>(),
		lootScan: 0,
		looted: false,
		late: false,
	};
}

/** everything the survivor carries, as one number: a pickup of any kind moves it */
function totalItems(save: PlayerSaveData): number {
	let n = 0;
	for (const v of save.invenWeapon) n += v;
	for (const v of save.invenEquip) n += v;
	for (const v of save.invenUse) n += v;
	for (const v of save.invenEtc) n += v;
	return n + save.ammoNormal + save.ammoShotgun + save.ammoMachinegun + save.ammoArrow + save.oil + save.electric;
}

function countCampfires(refs: GameRefs): number {
	let n = 0;
	for (const s of refs.world.solids) {
		if (s.removed !== true && s.tags === "campfire") n += 1;
	}
	return n;
}

function woodCount(save: PlayerSaveData): number {
	return WOOD_ETC >= 0 ? (save.invenEtc[WOOD_ETC] ?? 0) : 0;
}

/** the closest solid around the survivor that `pick` accepts */
function nearestSolid(refs: GameRefs, range: number, pick: (s: Solid) => boolean): ObjectiveTarget | undefined {
	const p = refs.player;
	let best: Solid | undefined;
	let bestD = math.huge;
	for (const s of querySolids(refs.world, p.x - range, p.y - range, p.x + range, p.y + range)) {
		if (s.removed === true || !pick(s)) continue;
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		const d = (cx - p.x) * (cx - p.x) + (cy - p.y) * (cy - p.y);
		if (d < bestD) {
			bestD = d;
			best = s;
		}
	}
	if (best === undefined) return undefined;
	return { x: best.x + best.w / 2, y: best.y + best.h / 2, kind: "place" };
}

function nearestGroundItem(refs: GameRefs): ObjectiveTarget | undefined {
	const p = refs.player;
	let bx = 0;
	let by = 0;
	let bestD = math.huge;
	for (const it of refs.world.items) {
		const d = (it.x - p.x) * (it.x - p.x) + (it.y - p.y) * (it.y - p.y);
		if (d < bestD) {
			bestD = d;
			bx = it.x;
			by = it.y;
		}
	}
	if (bestD === math.huge) return undefined;
	return { x: bx, y: by, kind: "place" };
}

function nearestZombie(refs: GameRefs): ObjectiveTarget | undefined {
	const p = refs.player;
	let bx = 0;
	let by = 0;
	let bestD = math.huge;
	for (const z of refs.zombies) {
		if ((z.alpha ?? 1) < 0.2) continue;
		const d = (z.x - p.x) * (z.x - p.x) + (z.y - p.y) * (z.y - p.y);
		if (d < bestD) {
			bestD = d;
			bx = z.x;
			by = z.y;
		}
	}
	if (bestD === math.huge) return undefined;
	return { x: bx, y: by, kind: "body" };
}

/** a zombie that was struck in the last tenth of a second (combat sets hitFlash to 1 on every hit) */
function zombieJustHit(refs: GameRefs): boolean {
	for (const z of refs.zombies) {
		if ((z.hitFlash ?? 0) > 0.9) return true;
	}
	for (const b of refs.bosses) {
		if ((b.hitFlash ?? 0) > 0.9) return true;
	}
	return false;
}

/**
 * Watches the buildings around the survivor and notices the moment one of them is emptied. Reading the world
 * instead of hooking the interaction system keeps this module out of everyone else's files — and it means a
 * house looted by any route (E, a future remote, another survivor) counts.
 */
function scanLoot(refs: GameRefs, mem: Memory, dt: number): void {
	mem.lootScan -= dt;
	if (mem.lootScan > 0) return;
	mem.lootScan = LOOT_SCAN;
	const p = refs.player;
	for (const s of querySolids(refs.world, p.x - LOOT_RANGE, p.y - LOOT_RANGE, p.x + LOOT_RANGE, p.y + LOOT_RANGE)) {
		if (s.kind !== "building" || s.removed === true) continue;
		const loot = s.lootItems;
		if (loot === undefined) continue;
		const now = loot.size();
		const before = mem.loot.get(s.id);
		if (before !== undefined && before > 0 && now === 0) mem.looted = true;
		mem.loot.set(s.id, now);
	}
}

/** the five lessons, in order */
export const OBJECTIVES: Array<Objective> = [
	{
		id: "move",
		title: "Take a walk",
		hint: "Move with the stick, or with W A S D.",
		begin(refs, mem): void {
			mem.distance = 0;
			mem.lastX = refs.player.x;
			mem.lastY = refs.player.y;
		},
		done(refs, mem): boolean {
			const p = refs.player;
			const dx = p.x - mem.lastX;
			const dy = p.y - mem.lastY;
			mem.lastX = p.x;
			mem.lastY = p.y;
			// a teleport (respawn, admin) must not complete the lesson by itself
			const step = math.sqrt(dx * dx + dy * dy);
			if (step < 40) mem.distance += step;
			return mem.distance >= MOVE_DISTANCE;
		},
		target(): ObjectiveTarget | undefined {
			return undefined;
		},
		view(refs, mem): { progress: string; ratio: number } {
			const r = math.clamp(mem.distance / MOVE_DISTANCE, 0, 1);
			return { progress: "", ratio: r };
		},
	},
	{
		id: "pickup",
		title: "Pick something up",
		hint: "Walk over loot on the ground, or press the use button next to it.",
		begin(refs, mem): void {
			mem.items = totalItems(refs.save);
		},
		done(refs, mem): boolean {
			return totalItems(refs.save) > mem.items;
		},
		target(refs): ObjectiveTarget | undefined {
			return nearestGroundItem(refs);
		},
	},
	{
		id: "hit",
		title: "Hit a zombie",
		hint: "Aim at it and attack. Your dagger swings while you hold.",
		begin(): void {},
		done(refs): boolean {
			return zombieJustHit(refs);
		},
		target(refs): ObjectiveTarget | undefined {
			return nearestZombie(refs);
		},
	},
	{
		id: "loot",
		title: "Search a house",
		hint: "Step inside and use the door-side prompt to empty its shelves.",
		begin(refs, mem): void {
			mem.loot.clear();
			mem.lootScan = 0;
			mem.looted = false;
		},
		done(refs, mem): boolean {
			return mem.looted;
		},
		target(refs): ObjectiveTarget | undefined {
			return nearestSolid(refs, 2600, s => s.kind === "building" && (s.lootItems?.size() ?? 0) > 0);
		},
	},
	{
		id: "fire",
		title: "Light a fire before 19:00",
		hint: "Hit trees for wood, craft a campfire in the backpack and place it.",
		begin(refs, mem): void {
			mem.campfires = countCampfires(refs);
			mem.late = false;
		},
		done(refs, mem): boolean {
			if (refs.daynight.dayTime >= FIRE_DEADLINE_HOUR) mem.late = true;
			return countCampfires(refs) > mem.campfires;
		},
		target(refs): ObjectiveTarget | undefined {
			// while the wood is short the lesson is "wood comes from trees"; after that it is in the backpack
			if (woodCount(refs.save) >= WOOD_NEEDED) return undefined;
			return nearestSolid(refs, 2200, s => s.tags === "tree");
		},
		view(refs): { progress: string; ratio: number } {
			const wood = woodCount(refs.save);
			if (wood < WOOD_NEEDED) {
				return { progress: `${wood} / ${WOOD_NEEDED} wood`, ratio: wood / WOOD_NEEDED };
			}
			return { progress: "Backpack › Craft › Campfire", ratio: 1 };
		},
	},
];

/** per-tick bookkeeping that is not tied to one objective (the loot sweep) */
export function trackWorld(refs: GameRefs, mem: Memory, dt: number, objective: Objective): void {
	if (objective.id === "loot") scanLoot(refs, mem, dt);
}

export function objectiveView(refs: GameRefs, mem: Memory, objective: Objective): ObjectiveView {
	const extra = objective.view?.(refs, mem);
	return {
		title: objective.title,
		hint: objective.hint,
		progress: extra?.progress ?? "",
		ratio: extra?.ratio ?? -1,
		target: objective.target(refs, mem),
	};
}
