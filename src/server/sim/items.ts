/*
 * Ground items and building loot, decided by the SERVER (docs/MULTIPLAYER.md §2.1, §4.5, §8.1, §8.3).
 *
 * What was wrong. Every client rolled its own loot, spawned its own drops and picked them up into its own
 * copy of the save. Two survivors searching the same house each walked out with a different armful, because
 * there were two houses; a dropped rifle existed for whoever dropped it and for nobody else; and "pick up"
 * was a local `addItem`, which is to say: free items for anyone willing to edit their client.
 *
 * What is true now:
 *   - ONE set of items, with server-issued dynamic ids (§4.5), replicated as ItemAdd/ItemRemove within
 *     ITEM_INTEREST. The mutation hooks live on `WorldData` itself, so a zombie's death drop deep inside
 *     shared/sim/ai/zombieBrain.ts replicates without that file knowing this one exists.
 *   - PICKUP is a request, resolved at the server's position of the survivor, and it is atomic: the world's
 *     `removeGroundItem` is the arbiter, so of two survivors reaching for the same can in the same tick, one
 *     gets a can and the other gets nothing (§8.3 "checar + mutar sem yield no meio"). That is the §11.3 F3
 *     acceptance line, and it is the same line that makes duplication impossible: an item can only pay out
 *     once because it can only be removed once.
 *   - LOOT of a building is rolled once, by the server, and the CONTENT never travels (§4.3). What the
 *     client learns is a flag — "there is something here" — and only while standing inside. The first valid
 *     `search` takes everything; the second is told the building is empty, which is what it is.
 *
 * The roll itself is the original's, moved verbatim from client/systems/interaction.ts, with one fix: the
 * "probability of exactly one" branch used raw `math.random()` while everything around it used the shared
 * rng. On a server that has to be replayable in Node (tools/) that is not a style question.
 *
 * Pure module: no Instances, no services, no os.clock. Time comes in as game hours, like the original.
 */
import { ItemKind } from "shared/data/kinds";
import { BUILDING_SPAWNS } from "shared/data/spawns";
import { DESIGN } from "shared/engine/constants";
import { chance, choose, rndInt, rndRange } from "shared/engine/rng";
import { addItem } from "shared/sim/inventory";
import { edgeDist, isMapItem } from "shared/sim/interactQuery";
import { ITEM_INTEREST } from "shared/net/mpConfig";
import { WorldEv, WItemAdd } from "shared/net/protocol";
import {
	GroundItem,
	querySolids,
	removeGroundItem,
	Solid,
	spawnGroundItem,
	WorldData,
	buildingAt,
} from "shared/game/world";
import { PlayerSaveData } from "shared/game/save";
import { creditWood } from "../save/achievements";
import { WorldOut } from "./worldOut";

/** §8.1: `pickup` is allowed at the reach the game draws, plus a latency allowance */
export const PICKUP_LATENCY_SLACK = 10;
export const PICKUP_RANGE = DESIGN.ITEM_GET_DISTANCE + PICKUP_LATENCY_SLACK;
/** the original's lazy loot: a building rolls its slots when a survivor comes this close (interaction.ts) */
export const LOOT_ROLL_RANGE = 320;
/** how often the roll sweep runs; every tick would walk the grid 60 times a second for nothing */
export const LOOT_SWEEP_S = 0.5;
/** a map item (tree, car, bin) cannot be harvested again for this long — PER SOLID, for everybody (§8.1) */
export const MAP_ITEM_COOLDOWN = DESIGN.MAP_ITEM_HIT_TIME;
/** ETC index of wood, the only thing a chopping tool gets out of a tree */
const WOOD_INDEX = 23;

/** what a `search` found: the building the survivor was inside (if any) and what came out of it */
export interface SearchResult {
	building: Solid | undefined;
	taken: Array<{ kind: number; id: number; count: number }>;
}

/** why a pickup did not happen; `ok` carries what went into the backpack */
export type PickupResult =
	{ ok: true; kind: number; itemId: number; count: number } | { ok: false; why: "none" | "range" | "taken" };

/** one line of the original's loot tables, by solid kind */
interface LootEntry {
	kind: number;
	index: number;
	/** < 1: the probability of getting exactly one. Otherwise the quantity. */
	amount: number;
}

const TREE_LOOT: Array<LootEntry> = [
	{ kind: 4, index: 23, amount: 2 },
	{ kind: 4, index: 29, amount: 0.15 },
];
const CAR_LOOT: Array<LootEntry> = [
	{ kind: 4, index: 26, amount: 1 },
	{ kind: 4, index: 27, amount: 0.3 },
	{ kind: 4, index: 48, amount: 0.4 },
];
const TRASH_LOOT: Array<LootEntry> = [
	{ kind: 4, index: 23, amount: 1 },
	{ kind: 4, index: 25, amount: 1 },
	{ kind: 4, index: 30, amount: 0.3 },
];

function lootTableFor(s: Solid): Array<LootEntry> {
	if (s.kind === "tree") return TREE_LOOT;
	if (s.tags === "car") return CAR_LOOT;
	return TRASH_LOOT;
}

export interface ServerItemsOptions {
	world: WorldData;
	out: WorldOut;
}

export class ServerItems {
	readonly world: WorldData;
	private readonly out: WorldOut;
	/** seconds of cooldown left per tree/car/bin, keyed by the solid (the original's `hitCooldowns`) */
	private readonly cooldowns = new Map<Solid, number>();
	private sweep = 0;
	private readonly scratch = new Array<Solid>();

	constructor(options: ServerItemsOptions) {
		this.world = options.world;
		this.out = options.out;
		// §4.5: every ground item that appears or disappears, whoever made it, becomes a delta here
		this.world.onItemAdd = (w, item) => this.out.queueNear(itemAddOf(item), item.x, item.y, ITEM_INTEREST);
		this.world.onItemRemove = (w, item) =>
			this.out.queueNear({ t: WorldEv.ItemRemove, id: item.id }, item.x, item.y, ITEM_INTEREST);
	}

	/** stops feeding the outbox (the world outlives the session in tests) */
	detach(): void {
		this.world.onItemAdd = undefined;
		this.world.onItemRemove = undefined;
	}

	// ---------------------------------------------------------------- pickup (§8.1)

	/**
	 * The survivor at (x, y) asks for `item`. The distance is measured HERE, from the position the server
	 * simulated, never from one the client sent (§8.3), with PICKUP_LATENCY_SLACK for the trip.
	 *
	 * The order matters and is deliberate: check reach, then REMOVE, then credit. Removing before crediting
	 * is what makes two simultaneous requests resolve to one winner — `removeGroundItem` answers false for
	 * the loser, who is credited nothing. Doing it the other way round would credit both and then remove
	 * once, which is the duplication bug written out longhand.
	 */
	pickup(save: PlayerSaveData, x: number, y: number, item: GroundItem | undefined): PickupResult {
		if (item === undefined) return { ok: false, why: "none" };
		const dx = item.x - x;
		const dy = item.y - y;
		if (dx * dx + dy * dy > PICKUP_RANGE * PICKUP_RANGE) return { ok: false, why: "range" };
		if (!removeGroundItem(this.world, item)) return { ok: false, why: "taken" };
		addItem(save, item.kind, item.itemId, item.count);
		// CON-04 Woods collector: wood the SERVER put into the backpack
		if (item.kind === ItemKind.Etc && item.itemId === WOOD_INDEX) creditWood(save, item.count);
		return { ok: true, kind: item.kind, itemId: item.itemId, count: item.count };
	}

	// ---------------------------------------------------------------- building loot (§4.3, §8.1)

	/**
	 * The survivor searches the building they are standing in. Everything in it goes into their backpack and
	 * the building is empty — for everybody, because there is one building.
	 *
	 * `hours` is the world clock in game hours (`gameHours(day, dayTime)`): the respawn timer is the
	 * original's 12 in-game hours, so a town that has been picked clean refills overnight and not before.
	 */
	search(save: PlayerSaveData, x: number, y: number, hours: number): SearchResult {
		const b = buildingAt(this.world, x, y);
		const taken = new Array<{ kind: number; id: number; count: number }>();
		if (b === undefined) return { building: undefined, taken };
		const loot = b.lootItems;
		if (loot === undefined || loot.size() === 0) return { building: b, taken };
		for (const drop of loot) {
			addItem(save, drop.kind, drop.id, drop.count);
			if (drop.kind === ItemKind.Etc && drop.id === WOOD_INDEX) creditWood(save, drop.count);
			taken.push(drop);
		}
		// emptied before anything can yield: a second searcher this tick finds size() === 0 above and is
		// told the building is empty, which by then it is (§8.1 "o primeiro pedido processado leva tudo")
		b.lootItems = [];
		b.lootTimer = hours + DESIGN.ITEM_RESPAWN_HOURS;
		return { building: b, taken };
	}

	/** does this building still hold something? (what the `LootFlag` delta carries, §4.5) */
	hasLoot(b: Solid): boolean {
		const loot = b.lootItems;
		return loot !== undefined && loot.size() > 0;
	}

	/**
	 * The original's lazy loot, on a sweep instead of every frame: a building rolls its slots the first time
	 * a survivor comes within LOOT_ROLL_RANGE, and again once its respawn timer has passed. Rolling at world
	 * generation would mean rolling 140 buildings nobody will ever walk into.
	 */
	rollNearby(players: ReadonlyArray<{ x: number; y: number }>, hours: number, dt: number): void {
		this.sweep -= dt;
		if (this.sweep > 0) return;
		this.sweep = LOOT_SWEEP_S;
		for (const p of players) {
			const found = querySolids(
				this.world,
				p.x - LOOT_ROLL_RANGE,
				p.y - LOOT_ROLL_RANGE,
				p.x + LOOT_ROLL_RANGE,
				p.y + LOOT_ROLL_RANGE,
				this.scratch,
			);
			for (const s of found) {
				if (s.kind !== "building") continue;
				const loot = s.lootItems;
				if (loot === undefined || loot.size() > 0) continue;
				if (hours < (s.lootTimer ?? 0)) continue;
				if (edgeDist(s, p.x, p.y) >= LOOT_ROLL_RANGE) continue;
				this.rollLoot(s);
			}
			this.scratch.clear();
		}
	}

	/**
	 * THE single place a container's contents are decided (the original's roll, moved from
	 * client/systems/interaction.ts and put on the shared rng so a test can replay it).
	 *
	 * One function on purpose: a per-stage content lock ("this item is not in the game yet") is one filter
	 * on `rows` here, and it then holds for every building in town, because there is no second place that
	 * chooses what a container holds.
	 */
	rollLoot(s: Solid): void {
		const bt = s.buildingType ?? 0;
		const rows = bt < BUILDING_SPAWNS.size() ? BUILDING_SPAWNS[bt] : BUILDING_SPAWNS[0];
		const slots = s.lootSlots ?? 2;
		const loot = new Array<{ kind: number; id: number; count: number }>();
		for (let i = 0; i < slots; i++) {
			const e = choose(rows);
			let count = 1;
			if (e.max < 1) {
				if (!chance(e.max * 100)) continue;
			} else {
				count = rndInt(e.min, e.max);
			}
			loot.push({ kind: e.kind, id: e.index, count });
		}
		s.lootItems = loot;
	}

	// ---------------------------------------------------------------- map items (§8.1)

	/** seconds of cooldown left on this tree / car / bin, for EVERY survivor (§8.1 "por sólido") */
	cooldownOf(s: Solid): number {
		return this.cooldowns.get(s) ?? 0;
	}

	/**
	 * A survivor chopped, smashed or searched a tree, a car or a bin. Answers whether anything came out.
	 * The cooldown is on the SOLID, so one survivor harvesting a tree puts it on cooldown for the group —
	 * exactly like the door: there is one tree.
	 *
	 * THE single place a map item's drop is decided, the counterpart of `rollLoot` for the things you hit
	 * rather than search: one content filter on `lootTableFor`'s result covers every tree, car and bin.
	 */
	hitMapItem(s: Solid, choppingTool: boolean, fromX: number, fromY: number): boolean {
		if (!isMapItem(s) || s.removed === true) return false;
		if (this.cooldownOf(s) > 0) return false;
		this.cooldowns.set(s, MAP_ITEM_COOLDOWN);
		s.hitShake = 0.25;
		if (choppingTool && s.kind === "tree") {
			this.spill(s, fromX, fromY, 4, WOOD_INDEX, 2 + (chance(50) ? 1 : 0));
			return true;
		}
		if (!chance(DESIGN.MAP_ITEM_PERCENT)) return false;
		const e = choose(lootTableFor(s));
		if (e.amount < 1) {
			if (!chance(e.amount * 100)) return false;
			this.spill(s, fromX, fromY, e.kind, e.index, 1);
			return true;
		}
		this.spill(s, fromX, fromY, e.kind, e.index, math.floor(e.amount));
		return true;
	}

	/** decays the per-solid cooldowns and drops the entries of solids that no longer exist */
	step(dt: number): void {
		const live = new Array<Solid>();
		const left = new Array<number>();
		for (const [s, value] of this.cooldowns) {
			const remaining = value - dt;
			if (remaining > 0 && s.removed !== true) {
				live.push(s);
				left.push(remaining);
			}
		}
		this.cooldowns.clear();
		for (let i = 0; i < live.size(); i++) this.cooldowns.set(live[i], left[i]);
	}

	// ---------------------------------------------------------------- WorldInit (§4.5)

	/** every ground item a joining survivor at (x, y) can see, as ItemAdd deltas */
	initFor(x: number, y: number, out: Array<WItemAdd>): Array<WItemAdd> {
		const r2 = ITEM_INTEREST * ITEM_INTEREST;
		for (const item of this.world.items) {
			const dx = item.x - x;
			const dy = item.y - y;
			if (dx * dx + dy * dy <= r2) out.push(itemAddOf(item));
		}
		return out;
	}

	/** the original's spill: out of the solid's nearest edge, toward whoever hit it, with a bit of scatter */
	private spill(s: Solid, fromX: number, fromY: number, kind: number, index: number, count: number): void {
		const cx = math.clamp(fromX, s.x, s.x + s.w);
		const cy = math.clamp(fromY, s.y, s.y + s.h);
		let nx = fromX - cx;
		let ny = fromY - cy;
		const len = math.sqrt(nx * nx + ny * ny);
		if (len < 1e-4) {
			nx = 0;
			ny = -1;
		} else {
			nx /= len;
			ny /= len;
		}
		const angle = math.atan2(ny, nx) + rndRange(-0.6, 0.6);
		const speed = rndRange(60, 150);
		spawnGroundItem(
			this.world,
			kind,
			index,
			count,
			cx + nx * 24,
			cy + ny * 24,
			math.cos(angle) * speed,
			math.sin(angle) * speed,
		);
	}
}

/** the wire form of a ground item (§4.5 ItemAdd) */
export function itemAddOf(item: GroundItem): WItemAdd {
	return {
		t: WorldEv.ItemAdd,
		id: item.id,
		kind: item.kind,
		itemId: item.itemId,
		// the wire carries 1..65535; a drop table that produced 0 would otherwise encode as 1 anyway, so
		// clamping here keeps what the client sees equal to what the server holds
		count: math.clamp(math.floor(item.count), 1, 65535),
		x: item.x,
		y: item.y,
		vx: item.vx,
		vy: item.vy,
	};
}
