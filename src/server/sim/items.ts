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
 *   - WALK-OVER (DESIGN_RULES ITM-06): a supply -- food, medicine, materials, ammunition -- is taken by the body over
 *     it, by `walkOver`, the server's own sweep: no message asks for it, so none can be forged. It is the E press's
 *     `pickup` below with every one of its checks (reach from the server's position, a clear line, the atomic removal,
 *     the save's ceiling), for the item the shared rule names (shared/sim/pickupRule.ts), once it has lain
 *     WALK_PICKUP_DELAY_S and at most one per survivor every WALK_PICKUP_RATE_S. Weapons and equipment still take E.
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
import { DESIGN } from "shared/engine/constants";
import { rndRange } from "shared/engine/rng";
import { addItem } from "shared/sim/inventory";
import { rollBuildingLoot, rollMapItemDrop, thiefFind } from "shared/sim/loot";
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
	isBlocking,
} from "shared/game/world";
import { PlayerSaveData } from "shared/game/save";
import { creditTaken } from "../save/achievements";
import { segmentClear } from "shared/game/physics";
import type { PlayerState } from "shared/game/player";
import { pickupRoom, WALK_PICKUP_DELAY_S, WALK_PICKUP_RATE_S, walkPickupTarget } from "shared/sim/pickupRule";
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

/**
 * why a pickup did not happen; `ok` carries what went into the backpack (`count`: what fitted under the save's
 * ceiling -- the rest stays on the ground); "full": the save holds as many of that item as it can keep
 */
export type PickupResult =
	| { ok: true; kind: number; itemId: number; count: number }
	| { ok: false; why: "none" | "range" | "blocked" | "taken" | "full" };

/** a survivor the walk-over sweep looks at: the simulation's own records (server/sim/players.ts ServerPlayer) */
export interface WalkingSurvivor {
	slot: number;
	state: PlayerState;
	save: PlayerSaveData;
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
	/** the walk-over's clock (s), when each item appeared on it, and when each slot may walk the next one up */
	private walkClock = 0;
	private readonly bornAt = new Map<number, number>();
	private readonly walkNext = new Map<number, number>();
	/**
	 * has this item lain WALK_PICKUP_DELAY_S? (one closure for the session: one per tick would be garbage). An item
	 * with no record was on the ground before the hooks were (the town's own scatter): it has lain long enough
	 */
	private readonly walkReady = (item: GroundItem): boolean =>
		this.walkClock - (this.bornAt.get(item.id) ?? -math.huge) >= WALK_PICKUP_DELAY_S;

	constructor(options: ServerItemsOptions) {
		this.world = options.world;
		this.out = options.out;
		// §4.5: every ground item that appears or disappears, whoever made it, becomes a delta here
		this.world.onItemAdd = (w, item) => {
			this.bornAt.set(item.id, this.walkClock);
			this.announce(item);
		};
		this.world.onItemRemove = (w, item) => {
			this.bornAt.delete(item.id);
			this.retract(item);
		};
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
		for (const item of this.world.items) {
			const dx = item.x - x;
			const dy = item.y - y;
			if (dx * dx + dy * dy <= r2) set.add(item.id);
		}
		this.told.set(slot, set);
	}

	/** the survivor in `slot` left the world: their client's mirror is rebuilt by the next welcome */
	forget(slot: number): void {
		this.told.delete(slot);
		this.walkNext.delete(slot);
	}

	/**
	 * §4.5 at walking pace: an item that came within ITEM_INTEREST of a survivor since they were last told is sent
	 * now, and one they were told about that is now past ITEM_INTEREST_EXIT is taken off their screen (they will be
	 * told again when they come back). Twice a second, like the loot sweep: nobody crosses 300 u in half a second.
	 */
	sweepInterest(dt: number): void {
		this.interestSweep -= dt;
		if (this.interestSweep > 0) return;
		this.interestSweep = ITEM_SWEEP_S;
		const inR2 = ITEM_INTEREST * ITEM_INTEREST;
		const outR2 = ITEM_INTEREST_EXIT * ITEM_INTEREST_EXIT;
		for (let i = 0; i < this.viewers.size(); i++) {
			const v = this.viewers[i];
			const slot = this.viewerSlots[i] ?? i;
			const set = this.toldOf(slot);
			for (const item of this.world.items) {
				const dx = item.x - v.x;
				const dy = item.y - v.y;
				const d2 = dx * dx + dy * dy;
				if (d2 <= inR2 && !set.has(item.id)) {
					set.add(item.id);
					this.out.queueFor(slot, itemAddOf(item));
				} else if (d2 > outR2 && set.has(item.id)) {
					set.delete(item.id);
					this.out.queueFor(slot, { t: WorldEv.ItemRemove, id: item.id });
				}
			}
		}
	}

	private toldOf(slot: number): Set<number> {
		let set = this.told.get(slot);
		if (set === undefined) {
			set = new Set<number>();
			this.told.set(slot, set);
		}
		return set;
	}

	/** a new item: to every survivor within ITEM_INTEREST of it this instant (the sweep catches the rest later) */
	private announce(item: GroundItem): void {
		const r2 = ITEM_INTEREST * ITEM_INTEREST;
		let ev: WItemAdd | undefined;
		for (let i = 0; i < this.viewers.size(); i++) {
			const v = this.viewers[i];
			const dx = item.x - v.x;
			const dy = item.y - v.y;
			if (dx * dx + dy * dy > r2) continue;
			const slot = this.viewerSlots[i] ?? i;
			ev = ev ?? itemAddOf(item);
			this.toldOf(slot).add(item.id);
			this.out.queueFor(slot, ev);
		}
	}

	/** an item left the world: EVERY client that was told about it is told it is gone, near or not */
	private retract(item: GroundItem): void {
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
		this.bornAt.clear();
		this.walkNext.clear();
	}

	/**
	 * An item's count went down while it stays on the ground (a pickup took what the backpack had room for): every
	 * client that was told about it is told again, and its mirror updates the count on the id it has (§4.5, ItemAdd is
	 * idempotent). No new message.
	 */
	private recount(item: GroundItem): void {
		let ev: WItemAdd | undefined;
		for (const [slot, set] of this.told) {
			if (!set.has(item.id)) continue;
			ev = ev ?? itemAddOf(item);
			this.out.queueFor(slot, ev);
		}
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
		// ITM-06: the save keeps at most its ceiling of an item (shared/game/save.ts SAVE_LIMITS); past it, what went in
		// was clamped away at the next load. Take what fits, leave the rest lying where it is
		const room = pickupRoom(save, item.kind, item.itemId);
		if (room <= 0) return { ok: false, why: "full" };
		if (!this.world.items.includes(item)) return { ok: false, why: "taken" };
		const take = math.min(item.count, room);
		if (take < item.count) {
			item.count -= take;
			this.recount(item);
		} else if (!removeGroundItem(this.world, item)) {
			return { ok: false, why: "taken" };
		}
		addItem(save, item.kind, item.itemId, take);
		// CON-04: what the SERVER put into the backpack (wood is Woods collector's)
		creditTaken(save, item.kind, item.itemId, take);
		return { ok: true, kind: item.kind, itemId: item.itemId, count: take };
	}

	/**
	 * The walk-over (ITM-06): each survivor on foot takes the supply under their body, if any -- the one the shared
	 * rule names (shared/sim/pickupRule.ts `walkPickupTarget`: within WALK_PICKUP_RANGE of the SERVER's position, lying
	 * for WALK_PICKUP_DELAY_S, room in the save) -- through `pickup`, so the reach, the clear line, the first-come
	 * removal and the ceiling are the E press's own. Each survivor is looked at once every WALK_PICKUP_RATE_S, which
	 * is also the rate: ten items a second at most, and the item scan runs at 10 Hz per survivor, not 60.
	 *
	 * `onTaken` hears each pickup (the caller marks the save dirty, as for an E press). Riding (VEI-05: the hands are
	 * on the bars) and dead survivors take nothing.
	 */
	walkOver(
		survivors: ReadonlyArray<WalkingSurvivor>,
		dt: number,
		onTaken?: (who: WalkingSurvivor, got: PickupResult) => void,
	): void {
		this.walkClock += dt;
		const now = this.walkClock;
		// an item taken out of the list without the removal hook (the population's cleanup) leaves its entry behind:
		// once the table holds many more than the world, the gone ones are dropped
		if (this.bornAt.size() > this.world.items.size() * 2 + 64) {
			const live = new Set<number>();
			for (const it of this.world.items) live.add(it.id);
			for (const [id] of this.bornAt) if (!live.has(id)) this.bornAt.delete(id);
		}
		for (const sp of survivors) {
			const p = sp.state;
			if (p.dead || p.ride !== undefined) continue;
			if (now < (this.walkNext.get(sp.slot) ?? 0)) continue;
			this.walkNext.set(sp.slot, now + WALK_PICKUP_RATE_S);
			const item = walkPickupTarget(this.world, p.x, p.y, sp.save, this.walkReady);
			if (item === undefined) continue;
			const got = this.pickup(sp.save, p.x, p.y, item);
			if (got.ok && onTaken !== undefined) onTaken(sp, got);
		}
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
			creditTaken(save, drop.kind, drop.id, drop.count);
			taken.push(drop);
		}
		// Thief: one more slot of this building's table, rolled for this searcher alone (shared/sim/loot.ts); the
		// building's own loot, the shared part, is exactly what anyone else would have found
		const extra = thiefFind(save, b.buildingType ?? 0);
		if (extra !== undefined) {
			addItem(save, extra.kind, extra.id, extra.count);
			creditTaken(save, extra.kind, extra.id, extra.count);
			taken.push(extra);
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
	 * One function on purpose, and the roll itself is the SHARED one (shared/sim/loot.ts), the very roll the
	 * client's MP_PHASE 2 path makes: there is no second place that chooses what a container holds.
	 */
	rollLoot(s: Solid): void {
		s.lootItems = rollBuildingLoot(s.buildingType ?? 0, s.lootSlots ?? 2);
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
