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
 *     shared/sim/ai/zombieBrain.ts replicates without that file knowing this one exists. Who was told about
 *     which item is kept per slot: an item that comes into range later is sent then (`sweepInterest`), and a
 *     removal reaches every client that was told, however far away it is now (`retract`).
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
 * And the ground is not a warehouse (security review of 5967a18, #3): every item here is world litter, it rots
 * GROUND_ITEM_LIFE_S after it appeared (`upkeep`), and the town never holds more than GROUND_ITEM_CAP -- the oldest
 * goes the moment one more lands (`announce`). Whatever asks "what is near here" reads the world's item grid
 * (shared/game/world.ts `queryGroundItems`) instead of every item in town: the interest sweep, a join's WorldInit,
 * the E press. A chainsaw at one car used to make 73 items a minute that nothing took away, and each of those
 * three walked all of them.
 *
 * And an item that just fell is news (§4.3, audit L2): for ITEM_NEWS_S it is told only to a client that could see
 * the spot (`sees`) -- a zombie's drop lies where the zombie died, and telling it into the dark handed out the death
 * the snapshot had withheld. After that it is litter, told in range like any other.
 *
 * Pure module: no Instances, no services, no os.clock. Time comes in as game hours, like the original, and the
 * items' own clock is the simulation's dt.
 */
import { DESIGN } from "shared/engine/constants";
import { rndRange } from "shared/engine/rng";
import { addItem } from "shared/sim/inventory";
import { isContainer, rollBuildingLoot, rollMapItemDrop, rollPumpLoot, thiefFind } from "shared/sim/loot";
import { edgeDist, isMapItem, isPump } from "shared/sim/interactQuery";
import { GROUND_ITEM_CAP, GROUND_ITEM_LIFE_S, ITEM_INTEREST, ITEM_NEWS_S } from "shared/net/mpConfig";
import { WorldEv, WItemAdd } from "shared/net/protocol";
import {
	GroundItem,
	queryGroundItems,
	querySolids,
	removeGroundItem,
	Solid,
	spawnGroundItem,
	WorldData,
	buildingAt,
	enableItemGrid,
	isBlocking,
	ITEM_GRID_CELL,
} from "shared/game/world";
import { PlayerSaveData } from "shared/game/save";
import { creditTaken } from "../save/achievements";
import { segmentClear } from "shared/game/physics";
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
/** the square (half-side) around a new item where the cap looks for the item that makes room for it (`capVictim`) */
const CAP_AREA = ITEM_GRID_CELL;
/** how often each survivor's item interest is swept for items that came within ITEM_INTEREST (§4.5) */
export const ITEM_SWEEP_S = 0.5;
/** an item a survivor was told about leaves their screen past this (hysteresis over ITEM_INTEREST) */
export const ITEM_INTEREST_EXIT = ITEM_INTEREST + 300;
const NO_VIEWERS: ReadonlyArray<{ x: number; y: number }> = [];
const NO_SLOTS: ReadonlyArray<number> = [];

/** what a `search` found: the building the survivor was inside (if any) and what came out of it */
export interface SearchResult {
	building: Solid | undefined;
	taken: Array<{ kind: number; id: number; count: number }>;
}

/** why a pickup did not happen; `ok` carries what went into the backpack */
export type PickupResult =
	| { ok: true; kind: number; itemId: number; count: number }
	| { ok: false; why: "none" | "range" | "blocked" | "taken" };

export interface ServerItemsOptions {
	world: WorldData;
	out: WorldOut;
	/**
	 * (§4.3, audit L2) Can the survivor in `slot` see (x, y) -- the roof and the dark rules the horde is sent by? An
	 * item younger than ITEM_NEWS_S is only told to a client that could see where it lies (`sees`): a zombie's drop
	 * fell where the zombie died, and telling it into the dark handed out the death the snapshot had withheld. Left
	 * undefined, every item in range is seen (a test without a replication layer).
	 */
	visible?: (slot: number, x: number, y: number) => boolean;
}

export class ServerItems {
	readonly world: WorldData;
	private readonly out: WorldOut;
	private readonly visible?: (slot: number, x: number, y: number) => boolean;
	/** seconds of cooldown left per tree/car/bin, keyed by the solid (the original's `hitCooldowns`) */
	private readonly cooldowns = new Map<Solid, number>();
	private sweep = 0;
	private readonly scratch = new Array<Solid>();
	/**
	 * Who is watching (§4.5 "Interesse (1800 u)"): the simulation's own body and slot arrays, refreshed in place every
	 * tick, so an item made anywhere in the tick is announced to whoever is near it NOW.
	 */
	private viewers: ReadonlyArray<{ x: number; y: number }> = NO_VIEWERS;
	private viewerSlots: ReadonlyArray<number> = NO_SLOTS;
	/**
	 * Which items each slot's client has been TOLD about and not told to forget. A mirror is only as good as its
	 * removals: before this an ItemRemove went to whoever was near the item when it went, so a survivor who saw a
	 * drop and walked on kept a ghost of it for ever once somebody else took it — and a drop made while they were
	 * across town never appeared when they got there.
	 */
	private readonly told = new Map<number, Set<number>>();
	private interestSweep = 0;
	/** every item in the world by id (the sweep turns a told id back into its item) */
	private readonly byId = new Map<number, GroundItem>();
	/** the items' own clock, seconds of simulation (`upkeep`): what `GroundItem.born` is measured on */
	private clock = 0;
	/** items the lifetime and the cap took away since boot (the admin panel's, and the tests') */
	readonly expired = { rotted: 0, capped: 0 };
	private readonly found = new Array<GroundItem>();
	private readonly capScratch = new Array<GroundItem>();
	private readonly leaving = new Array<number>();

	constructor(options: ServerItemsOptions) {
		this.world = options.world;
		this.out = options.out;
		this.visible = options.visible;
		enableItemGrid(this.world);
		// whatever lies there already (a world adopted with items in it) starts its lifetime now
		for (const item of this.world.items) {
			item.born = this.clock;
			this.byId.set(item.id, item);
		}
		// §4.5: every ground item that appears or disappears, whoever made it, becomes a delta here
		this.world.onItemAdd = (w, item) => this.announce(item);
		this.world.onItemRemove = (w, item) => this.retract(item);
	}

	/**
	 * The ground's upkeep, every tick (server/sim/simulation.ts, right after `updateGroundItems`, with or without anybody
	 * in the world): the items older than GROUND_ITEM_LIFE_S rot away, oldest first. `world.items` is in the order the
	 * items appeared -- appended on spawn, and every removal keeps the others' order -- so the oldest is always the
	 * first, and a tick that expires nothing costs one comparison.
	 */
	upkeep(dt: number): void {
		if (dt > 0) this.clock += dt;
		const items = this.world.items;
		while (items.size() > 0) {
			const oldest = items[0];
			if (this.clock - (oldest.born ?? this.clock) <= GROUND_ITEM_LIFE_S) break;
			this.expired.rotted += 1;
			removeGroundItem(this.world, oldest);
		}
	}

	/** the bodies (and their slots, in the same order) that see items; the simulation hands its own arrays over */
	watch(players: ReadonlyArray<{ x: number; y: number }>, slots: ReadonlyArray<number>): void {
		this.viewers = players;
		this.viewerSlots = slots;
	}

	/**
	 * A survivor entered the world at (x, y), and the welcome (server/net/replication.ts `welcomeWorld`) is handing
	 * them every item `initFor` finds there: those are told, so the sweep does not send them a second time.
	 */
	welcomed(slot: number, x: number, y: number): void {
		const set = new Set<number>();
		const r2 = ITEM_INTEREST * ITEM_INTEREST;
		for (const item of this.near(x, y, ITEM_INTEREST)) {
			const dx = item.x - x;
			const dy = item.y - y;
			if (dx * dx + dy * dy <= r2 && this.sees(slot, item)) set.add(item.id);
		}
		this.told.set(slot, set);
	}

	/**
	 * May the client in `slot` be told about this item? Litter (older than ITEM_NEWS_S) always; news only if they could
	 * see where it lies (§4.3, `ServerItemsOptions.visible`). The age goes first: the light test is asked of the few
	 * items that just fell, not of every item in range on every sweep.
	 */
	private sees(slot: number, item: GroundItem): boolean {
		if (this.visible === undefined) return true;
		if (this.clock - (item.born ?? this.clock) >= ITEM_NEWS_S) return true;
		return this.visible(slot, item.x, item.y);
	}

	/** the items in the square of half-side `r` around (x, y), from the grid (a scratch array: read it at once) */
	private near(x: number, y: number, r: number): Array<GroundItem> {
		const found = this.found;
		found.clear();
		return queryGroundItems(this.world, x - r, y - r, x + r, y + r, found);
	}

	/** the survivor in `slot` left the world: their client's mirror is rebuilt by the next welcome */
	forget(slot: number): void {
		this.told.delete(slot);
	}

	/**
	 * §4.5 at walking pace: an item that came within ITEM_INTEREST of a survivor since they were last told is sent
	 * now, and one they were told about that is now past ITEM_INTEREST_EXIT is taken off their screen (they will be
	 * told again when they come back). Twice a second, like the loot sweep: nobody crosses 300 u in half a second.
	 *
	 * What it reads is bounded by what is NEAR, not by the town: the grid's cells around each survivor for the items
	 * coming in, and the survivor's own told set (at most GROUND_ITEM_CAP) for the ones going out.
	 */
	sweepInterest(dt: number): void {
		this.interestSweep -= dt;
		if (this.interestSweep > 0) return;
		this.interestSweep = ITEM_SWEEP_S;
		const inR2 = ITEM_INTEREST * ITEM_INTEREST;
		const outR2 = ITEM_INTEREST_EXIT * ITEM_INTEREST_EXIT;
		const leaving = this.leaving;
		for (let i = 0; i < this.viewers.size(); i++) {
			const v = this.viewers[i];
			const slot = this.viewerSlots[i] ?? i;
			const set = this.toldOf(slot);
			leaving.clear();
			for (const id of set) {
				const item = this.byId.get(id);
				// gone already: `retract` told this client, and only a told id outlives its item for a moment
				if (item === undefined) {
					leaving.push(id);
					continue;
				}
				const dx = item.x - v.x;
				const dy = item.y - v.y;
				if (dx * dx + dy * dy <= outR2) continue;
				leaving.push(id);
				this.out.queueFor(slot, { t: WorldEv.ItemRemove, id });
			}
			for (const id of leaving) set.delete(id);
			for (const item of this.near(v.x, v.y, ITEM_INTEREST)) {
				if (set.has(item.id)) continue;
				const dx = item.x - v.x;
				const dy = item.y - v.y;
				// news in range but out of sight (the dark, a building): the next sweep asks again
				if (dx * dx + dy * dy > inR2 || !this.sees(slot, item)) continue;
				set.add(item.id);
				this.out.queueFor(slot, itemAddOf(item));
			}
		}
		leaving.clear();
	}

	private toldOf(slot: number): Set<number> {
		let set = this.told.get(slot);
		if (set === undefined) {
			set = new Set<number>();
			this.told.set(slot, set);
		}
		return set;
	}

	/**
	 * A new item: to every survivor within ITEM_INTEREST of it this instant (the sweep catches the rest later) -- and
	 * past GROUND_ITEM_CAP an older item leaves the world for it (`capVictim`), so the town never holds more than the cap.
	 */
	private announce(item: GroundItem): void {
		item.born = this.clock;
		this.byId.set(item.id, item);
		const items = this.world.items;
		while (items.size() > GROUND_ITEM_CAP) {
			const victim = this.capVictim(item);
			if (victim === undefined) break;
			this.expired.capped += 1;
			removeGroundItem(this.world, victim);
		}
		const r2 = ITEM_INTEREST * ITEM_INTEREST;
		let ev: WItemAdd | undefined;
		for (let i = 0; i < this.viewers.size(); i++) {
			const v = this.viewers[i];
			const dx = item.x - v.x;
			const dy = item.y - v.y;
			if (dx * dx + dy * dy > r2) continue;
			const slot = this.viewerSlots[i] ?? i;
			// out of sight: the sweep tells them once they can see the spot, or once it is litter (a drop where a zombie
			// died in the dark)
			if (!this.sees(slot, item)) continue;
			ev = ev ?? itemAddOf(item);
			this.toldOf(slot).add(item.id);
			this.out.queueFor(slot, ev);
		}
	}

	/**
	 * Which item makes room for `item` past the cap: the oldest AROUND it (its grid cell and the ones next to it,
	 * CAP_AREA), and only when nothing else lies there the oldest in town. The town's oldest used to go every time, so
	 * a farm dropping junk in one corner pushed a fresh drop out of the other within a few minutes (the security review
	 * of the net hardening, L4); now a farm eats its own junk first.
	 */
	private capVictim(item: GroundItem): GroundItem | undefined {
		const around = this.capScratch;
		around.clear();
		queryGroundItems(
			this.world,
			item.x - CAP_AREA,
			item.y - CAP_AREA,
			item.x + CAP_AREA,
			item.y + CAP_AREA,
			around,
		);
		let victim: GroundItem | undefined;
		for (const other of around) {
			if (other === item) continue;
			if (victim === undefined) {
				victim = other;
				continue;
			}
			// the oldest; of two born on the same tick, the one that fell first (ids only grow)
			const a = other.born ?? 0;
			const b = victim.born ?? 0;
			if (a < b || (a === b && other.id < victim.id)) victim = other;
		}
		around.clear();
		if (victim !== undefined) return victim;
		const oldest = this.world.items[0];
		return oldest !== item ? oldest : undefined;
	}

	/** an item left the world: EVERY client that was told about it is told it is gone, near or not */
	private retract(item: GroundItem): void {
		this.byId.delete(item.id);
		for (const [slot, set] of this.told) {
			if (!set.has(item.id)) continue;
			set.delete(item.id);
			this.out.queueFor(slot, { t: WorldEv.ItemRemove, id: item.id });
		}
	}

	/** stops feeding the outbox (the world outlives the session in tests) */
	detach(): void {
		this.world.onItemAdd = undefined;
		this.world.onItemRemove = undefined;
		this.told.clear();
		this.byId.clear();
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
		// §8.1, like every other reach: a clear line to it, so a wall between the survivor and the item is a wall. Not the
		// solid the item rests INSIDE: a drop slides with no wall collision, and ~28 % of a zombie's drops at a base wall
		// end up inside it -- blocked by its own wall it could never be picked up, and as E's first target it hid the
		// door beside it for good (re-review of f8ccaf0)
		const blocks = (o: Solid): boolean =>
			isBlocking(o) && !(item.x >= o.x && item.x <= o.x + o.w && item.y >= o.y && item.y <= o.y + o.h);
		if (!segmentClear(this.world, x, y, item.x, item.y, blocks)) return { ok: false, why: "blocked" };
		if (!removeGroundItem(this.world, item)) return { ok: false, why: "taken" };
		addItem(save, item.kind, item.itemId, item.count);
		// CON-04: what the SERVER put into the backpack (wood is Woods collector's)
		creditTaken(save, item.kind, item.itemId, item.count);
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
		this.takeAll(save, b, hours, taken);
		// Thief: one more slot of this building's table, rolled for this searcher alone (shared/sim/loot.ts); the
		// building's own loot, the shared part, is exactly what anyone else would have found
		const extra = thiefFind(save, b.buildingType ?? 0);
		if (extra !== undefined) {
			addItem(save, extra.kind, extra.id, extra.count);
			creditTaken(save, extra.kind, extra.id, extra.count);
			taken.push(extra);
		}
		return { building: b, taken };
	}

	/**
	 * A survivor drains a gas station's pump island (EDI-16): the same rules as a building's search (MP-05) -- the
	 * first E takes everything, for everybody, and the island is dry until ITEM_RESPAWN_HOURS of game time have passed
	 * -- minus the Thief's extra: the skill finds one more thing when SEARCHING A BUILDING ("Searching a building finds
	 * one more item"), and a pump has nothing more to find than the fuel in it. The reach is the caller's
	 * (server/sim/interaction.ts, at the SERVER's position, with a clear line to the island).
	 */
	drain(save: PlayerSaveData, pump: Solid, hours: number): Array<{ kind: number; id: number; count: number }> {
		const taken = new Array<{ kind: number; id: number; count: number }>();
		if (!isPump(pump) || pump.removed === true) return taken;
		const loot = pump.lootItems;
		if (loot === undefined || loot.size() === 0) return taken;
		this.takeAll(save, pump, hours, taken);
		return taken;
	}

	/**
	 * Everything in container `c` into `save`, and the container empty until `hours` + ITEM_RESPAWN_HOURS. Emptied
	 * before anything can yield: a second searcher this tick finds it empty, which by then it is (§8.1 "o primeiro
	 * pedido processado leva tudo").
	 */
	private takeAll(
		save: PlayerSaveData,
		c: Solid,
		hours: number,
		taken: Array<{ kind: number; id: number; count: number }>,
	): void {
		for (const drop of c.lootItems ?? []) {
			addItem(save, drop.kind, drop.id, drop.count);
			creditTaken(save, drop.kind, drop.id, drop.count);
			taken.push(drop);
		}
		c.lootItems = [];
		c.lootTimer = hours + DESIGN.ITEM_RESPAWN_HOURS;
	}

	/** does this building (or pump island) still hold something? (what the `LootFlag` delta carries, §4.5) */
	hasLoot(b: Solid): boolean {
		const loot = b.lootItems;
		return loot !== undefined && loot.size() > 0;
	}

	/**
	 * The original's lazy loot, on a sweep instead of every frame: a building rolls its slots the first time
	 * a survivor comes within LOOT_ROLL_RANGE, and again once its respawn timer has passed. Rolling at world
	 * generation would mean rolling 140 buildings nobody will ever walk into. A gas station's pump islands are
	 * containers too (EDI-16) and roll the same way, from their own table.
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
				if (!isContainer(s)) continue;
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
	 * One function on purpose, and the roll itself is the SHARED one (shared/sim/loot.ts), the very roll the
	 * client's MP_PHASE 2 path makes: there is no second place that chooses what a container holds. A pump island
	 * rolls its fuel (EDI-16), a building its type's table.
	 */
	rollLoot(s: Solid): void {
		s.lootItems = isPump(s) ? rollPumpLoot() : rollBuildingLoot(s.buildingType ?? 0, s.lootSlots ?? 2);
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
	 * THE single place a map item's drop is decided on the server, the counterpart of `rollLoot` for the things you
	 * hit rather than search; the table and the roll are the shared ones (shared/sim/loot.ts, QA L1), so the client's
	 * MP_PHASE 2 path and this one give the same things.
	 */
	hitMapItem(s: Solid, choppingTool: boolean, fromX: number, fromY: number): boolean {
		if (!isMapItem(s) || s.removed === true) return false;
		if (this.cooldownOf(s) > 0) return false;
		this.cooldowns.set(s, MAP_ITEM_COOLDOWN);
		s.hitShake = 0.25;
		const drop = rollMapItemDrop(s, choppingTool);
		if (drop === undefined) return false;
		this.spill(s, fromX, fromY, drop.kind, drop.index, drop.count);
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

	/**
	 * Every ground item a joining survivor is shown, as ItemAdd deltas: exactly the ones `welcomed` marked told for
	 * their slot (in range and in sight), so the WorldInit and the sweep can never disagree about what was sent.
	 */
	initFor(slot: number, out: Array<WItemAdd>): Array<WItemAdd> {
		const told = this.told.get(slot);
		if (told === undefined) return out;
		for (const id of told) {
			const item = this.byId.get(id);
			if (item !== undefined) out.push(itemAddOf(item));
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
