/*
 * The action button (E), resolved by the SERVER (docs/MULTIPLAYER.md §2.1, §2.4, §4.5, §8.1).
 *
 * The one design decision worth stating, because everything else follows from it: **the client never names
 * a target.** It sends the press, as one of the four edges the input command already carries (§2.2), and the
 * server runs the very same `interactTarget` query the HUD ran — at the position the SERVER simulated. So:
 *
 *   - there is no `interact(solidId)` payload to forge, and therefore no "open the door on the far side of
 *     town", no "search a building I am not in", no "pick up an item 4000 units away" (§8.3);
 *   - the press is ordered with the movement it happened during, for free, because it IS the movement packet
 *     (§2.4 — no second channel to race);
 *   - the HUD's hint and the server's action cannot disagree about priority, because they call one function
 *     (shared/sim/interactQuery.ts), which is why that module was pulled out of the client in the first place.
 *
 * And the thing F3 exists to fix: there is ONE door. Opening it is a `DoorSet` delta to everybody (§4.5,
 * global — everybody predicts their movement against it), so a door cannot be open for one survivor and shut
 * for the next. Same for a light, a repaired barricade and a looted house.
 *
 * Pure module: no Instances, no services, no os.clock.
 */
import { countItem, removeItem } from "shared/sim/inventory";
import {
	bodiesOverlapRect,
	canRepair,
	DOOR_REACH,
	edgeDist,
	interactTarget,
	isFire,
	nearestGroundItem,
	nearestPump,
	pumpsOf,
	repairMaterial,
	SOLID_REACH,
} from "shared/sim/interactQuery";
import { noRoomIn } from "shared/sim/pickupRule";
import { segmentClear } from "shared/game/physics";
import { buildingAt, isBlocking, querySolids, Solid, WorldData } from "shared/game/world";
import { PlayerSaveData } from "shared/game/save";
import { PlayerState } from "shared/game/player";
import { ZombieState } from "shared/game/entities";
import { FxEvent, FxType, SolidState, WorldEv } from "shared/net/protocol";
import { wireSoundId } from "shared/net/fxWire";
import { isMachine } from "shared/data/power";
import { ServerItems } from "./items";
import type { MachineOutcome } from "./power";
import { WorldOut } from "./worldOut";

/** §8.1: the reach checks get the same latency allowance as `pickup` */
export const REACH_LATENCY_SLACK = 10;
/** obj_campfire: 1000 wood burning 0.1 per frame at 30 fps → ~5.5 min of fire (the original's number) */
export const FIRE_TIME = 1000 / 0.1 / 30;
/** relighting a burnt-out fire costs this much wood */
export const FIRE_WOOD = 5;
/** ETC index of wood */
export const WOOD_INDEX = 23;
/** the fire sweep runs at 2 Hz, like the original's `burnFires` */
const FIRE_STEP_S = 0.5;
/** how far around a survivor fires are burnt down (the original's box) */
const FIRE_RANGE = 2500;
/** a repair with wood restores this much of the maximum; the "handy" skill doubles it */
const REPAIR_RATE = 0.25;
const REPAIR_RATE_SKILLED = 0.5;
/** skill index of "handy" (the one that doubles a repair) */
const SKILL_HANDY = 17;
/**
 * §8.1 / §8.2: the E press is an edge on EVERY command, so without a rate a modified client flipped a door 60 times
 * a second, each flip a reliable DoorSet to every client (security review of 5967a18, R3). One press per survivor
 * per PRESS_COOLDOWN_S -- faster than a finger -- and one change per door or lamp per TOGGLE_COOLDOWN_S, whoever
 * presses: at most 4 DoorSet a second per door, however many survivors crowd it.
 */
export const PRESS_COOLDOWN_S = 0.2;
export const TOGGLE_COOLDOWN_S = 0.25;
/**
 * A survivor outside every building is told about the pump island within this of its edge (EDI-16, the LootFlag of
 * §4.5): wider than the reach of E (SOLID_REACH), so the flag is on this client before the survivor is at the island
 * and the hint never lies for a moment; narrow enough that the two islands of a station (80 u apart) are told one at
 * a time, the nearer first.
 */
export const PUMP_FLAG_REACH = 160;

/** what the press did, for the caller's Fx and for the tests */
export type InteractOutcome =
	| { kind: "none" }
	| { kind: "item"; count: number }
	| { kind: "door"; solid: Solid; open: boolean }
	| { kind: "light"; solid: Solid; powered: boolean }
	| { kind: "mapItem"; solid: Solid; dropped: boolean }
	| { kind: "repair"; solid: Solid }
	| { kind: "search"; building: Solid; taken: number }
	/** a gas station's pump island drained into the backpack (EDI-16): `taken` entries (its oil) */
	| { kind: "pump"; solid: Solid; taken: number }
	/** an electric build did its own job (server/sim/power.ts): charged, refuelled, switched, launched a drone… */
	| { kind: "machine"; machine: MachineOutcome }
	| { kind: "refused"; why: "range" | "blocked" | "material" | "empty" | "cooldown" | "taken" | "full" };

/** what E does on an electric build (server/sim/power.ts `ServerPower.act`); undefined = the ordinary E */
export interface MachineActions {
	act(slot: number, body: PlayerState, save: PlayerSaveData, s: Solid): MachineOutcome | undefined;
}

export interface ServerInteractionOptions {
	world: WorldData;
	items: ServerItems;
	out: WorldOut;
	/** cosmetic effects (a tree shaking); left undefined they are simply dropped, which is what tests want */
	fx?: (event: FxEvent) => void;
	/** the electric grid: E on a machine is its job first (ELE-03), the ordinary E (repair, a light) only if not */
	machines?: MachineActions;
	/**
	 * A door opened or closed: the horde's flow field reads that patch again (§3.3 dirty tiles). Passed in, like
	 * server/sim/build.ts's, so the module stays pure. Without it the field kept routing through a door that had been
	 * shut, or round one that had been opened, until something else dirtied the tile.
	 */
	onSolidChanged?: (x: number, y: number, w: number, h: number) => void;
	/**
	 * §9.3: does the run of the survivor in `slot` still earn rewards? What a pickup or a search puts in an assisted
	 * run's backpack is theirs, the achievement (Woodpile) is not. Left undefined, every run does -- what a test wants.
	 */
	paysRewards?: (slot: number) => boolean;
}

/** the world as the resolver needs to see it for one press */
export interface InteractContext {
	slot: number;
	state: PlayerState;
	save: PlayerSaveData;
	/** every survivor's body — closing a door on one is refused (§8.1) */
	players: ReadonlyArray<PlayerState>;
	zombies: ReadonlyArray<ZombieState>;
	/** the world clock in game hours, `gameHours(day, dayTime)` */
	hours: number;
}

export class ServerInteraction {
	private readonly world: WorldData;
	private readonly items: ServerItems;
	private readonly out: WorldOut;
	private readonly fx?: (event: FxEvent) => void;
	private readonly machines?: MachineActions;
	private readonly onSolidChanged?: (x: number, y: number, w: number, h: number) => void;
	private readonly paysRewards?: (slot: number) => boolean;
	/** seconds of fire left per campfire/brazier; absent = freshly built, full (the original's `fuelOf`) */
	private readonly fuel = new Map<Solid, number>();
	private fireTick = 0;
	private readonly scratch = new Array<Solid>();
	/** the building whose loot flag each slot was last told about, or 0 for "nothing here" */
	private readonly lootSeen = new Map<number, number>();
	/** seconds until this slot's next E press is heard (PRESS_COOLDOWN_S) */
	private readonly pressCd = new Map<number, number>();
	/** seconds until this door or lamp can change again (TOGGLE_COOLDOWN_S) */
	private readonly toggleCd = new Map<Solid, number>();
	/** the town's pump islands, listed the first time the loot flags need them (static: the world is this one's) */
	private pumps?: Array<Solid>;

	constructor(options: ServerInteractionOptions) {
		this.world = options.world;
		this.items = options.items;
		this.out = options.out;
		this.fx = options.fx;
		this.machines = options.machines;
		this.onSolidChanged = options.onSolidChanged;
		this.paysRewards = options.paysRewards;
	}

	/** §9.3: the run of the survivor in `slot` still earns achievements */
	private pays(slot: number): boolean {
		return this.paysRewards?.(slot) ?? true;
	}

	/**
	 * One press of E. Everything is decided from `ctx.state.x/y`, which is the server's position.
	 *
	 * A survivor who is dead, or who has a construction on the cursor, presses E for something else — the
	 * caller (server/sim/build.ts) takes the edge first in that case, exactly as `BuildSystem.handleInput`
	 * swallows the frame on the client.
	 */
	act(ctx: InteractContext): InteractOutcome {
		const p = ctx.state;
		if (p.dead) return { kind: "none" };
		if ((this.pressCd.get(ctx.slot) ?? 0) > 0) return { kind: "refused", why: "cooldown" };
		// ITM-07: an item this save has no room for is passed over, so a full stack does not hide the door, the search
		// or the repair behind it (review of 1186a83, M1); the client's hint passes the same check
		const target = interactTarget(this.world, p.x, p.y, noRoomIn(ctx.save));
		if (target === undefined) {
			// nothing else in reach: say why the item did not come (spends no cooldown, changes nothing)
			const full = nearestGroundItem(this.world, p.x, p.y);
			return full !== undefined ? { kind: "refused", why: "full" } : { kind: "none" };
		}
		// only a press that reaches something spends the cooldown: an empty press used to eat it, so a door flipped every
		// 0.4 s and a press right after an input hitch was dropped (re-review of f8ccaf0)
		this.pressCd.set(ctx.slot, PRESS_COOLDOWN_S);

		if (target.kind === "item") {
			const got = this.items.pickup(ctx.save, p.x, p.y, target.item, ctx.slot, this.pays(ctx.slot));
			if (got.ok) return { kind: "item", count: got.count };
			if (got.why === "range" || got.why === "blocked" || got.why === "full") {
				return { kind: "refused", why: got.why };
			}
			return { kind: "refused", why: "taken" };
		}

		// a vehicle that could be ridden was already taken by server/sim/vehicles.ts; what reaches here is a broken
		// one (VEI-05), and `repair` only ever fixes that
		if (target.kind === "vehicle") return this.repair(ctx, target.solid);
		if (target.kind === "door") return this.door(ctx, target.solid);
		if (
			(target.kind === "light" || target.kind === "solid") &&
			this.machines !== undefined &&
			isMachine(target.solid)
		) {
			const s = target.solid;
			if (!this.inReach(ctx.state, s, SOLID_REACH)) return { kind: "refused", why: "range" };
			// a machine changes at most once per TOGGLE_COOLDOWN_S, whoever presses, like a door or a lamp: a switch, a
			// launch or a recall is a reliable PowerSet to every client (and a charge or a refuel moves the save)
			if (this.toggling(s)) return { kind: "refused", why: "cooldown" };
			const done = this.machines.act(ctx.slot, ctx.state, ctx.save, s);
			// a machine that cannot do its job (a box with nothing to give, no oil for the tank, a drone still charging)
			// and is damaged is repaired instead: its job must never lock its repair out
			if (done !== undefined && !(done.kind === "refused" && canRepair(s))) {
				if (done.kind !== "refused") this.toggleCd.set(s, TOGGLE_COOLDOWN_S);
				return { kind: "machine", machine: done };
			}
			if (done !== undefined) return this.repair(ctx, s);
		}
		if (target.kind === "light") return this.light(ctx, target.solid);
		if (target.kind === "mapItem") return this.mapItem(ctx, target.solid);
		if (target.kind === "pump") return this.pump(ctx, target.solid);
		if (target.kind === "solid") return this.repair(ctx, target.solid);
		return this.search(ctx, target.building);
	}

	// ---------------------------------------------------------------- one door, for everybody

	private door(ctx: InteractContext, s: Solid): InteractOutcome {
		if (!this.inReach(ctx.state, s, DOOR_REACH)) return { kind: "refused", why: "range" };
		if (this.toggling(s)) return { kind: "refused", why: "cooldown" };
		const willOpen = !(s.open ?? false);
		// §8.1: closing a door on a body is refused — otherwise a door is a weapon, and a griefing tool
		if (!willOpen && bodiesOverlapRect(s, ctx.players, ctx.zombies)) return { kind: "refused", why: "blocked" };
		s.open = willOpen;
		this.toggleCd.set(s, TOGGLE_COOLDOWN_S);
		if (this.onSolidChanged !== undefined) this.onSolidChanged(s.x, s.y, s.w, s.h);
		// GLOBAL, not interest-filtered (§4.5): a door decides whether a corridor is walkable, and every
		// client predicts its own movement against it. A door somebody was not told about is a wall.
		this.out.queue({ t: WorldEv.DoorSet, id: s.id, state: willOpen ? SolidState.Open : 0 });
		// and it is HEARD where it turned (P0-4), by whoever is near: the unreliable Fx channel, interest-filtered
		// like any effect -- a creak lost on the way costs nothing, the DoorSet above is the door
		const iron = s.kind === "iron_door";
		const sound = willOpen ? (iron ? "ironDoorOpen" : "doorOpen") : iron ? "ironDoorClose" : "doorClose";
		this.fx?.({ t: FxType.Sound, sound: wireSoundId(sound), x: s.x + s.w / 2, y: s.y + s.h / 2, volume: 1 });
		return { kind: "door", solid: s, open: willOpen };
	}

	// ---------------------------------------------------------------- lamps and fires

	private light(ctx: InteractContext, s: Solid): InteractOutcome {
		if (!this.inReach(ctx.state, s, SOLID_REACH)) return { kind: "refused", why: "range" };
		if (this.toggling(s)) return { kind: "refused", why: "cooldown" };
		const outcome = this.switchLight(ctx, s);
		if (outcome.kind === "light") this.toggleCd.set(s, TOGGLE_COOLDOWN_S);
		return outcome;
	}

	private switchLight(ctx: InteractContext, s: Solid): InteractOutcome {
		if (!isFire(s)) {
			const powered = !(s.powered ?? false);
			s.powered = powered;
			this.emitLight(s, powered);
			return { kind: "light", solid: s, powered };
		}
		if (s.powered === true) {
			s.powered = false;
			this.emitLight(s, false);
			return { kind: "light", solid: s, powered: false };
		}
		if (this.fuelOf(s) <= 0) {
			if (countItem(ctx.save, 4, WOOD_INDEX) < FIRE_WOOD) return { kind: "refused", why: "material" };
			removeItem(ctx.save, 4, WOOD_INDEX, FIRE_WOOD);
			this.fuel.set(s, FIRE_TIME);
		}
		s.powered = true;
		this.emitLight(s, true);
		return { kind: "light", solid: s, powered: true };
	}

	/** seconds of fire left; a fire nobody has burnt yet is full, as in the original */
	fuelOf(s: Solid): number {
		return this.fuel.get(s) ?? FIRE_TIME;
	}

	// ---------------------------------------------------------------- trees, cars, bins

	private mapItem(ctx: InteractContext, s: Solid): InteractOutcome {
		if (!this.inReach(ctx.state, s, SOLID_REACH)) return { kind: "refused", why: "range" };
		if (this.items.cooldownOf(s) > 0) return { kind: "refused", why: "cooldown" };
		const dropped = this.items.hitMapItem(s, false, ctx.state.x, ctx.state.y);
		// §4.5 routes the shake "via Fx": it is cosmetic and self-correcting, so it does not need to be reliable
		if (this.fx !== undefined) {
			this.fx({
				t: FxType.SolidShake,
				solidId: s.id,
				angle: math.atan2(s.y + s.h / 2 - ctx.state.y, s.x + s.w / 2 - ctx.state.x),
				strength: 1,
				// server only: where it is, for the interest filter (§4.3)
				x: s.x + s.w / 2,
				y: s.y + s.h / 2,
			});
		}
		return { kind: "mapItem", solid: s, dropped };
	}

	// ---------------------------------------------------------------- repair

	private repair(ctx: InteractContext, s: Solid): InteractOutcome {
		if (!this.inReach(ctx.state, s, SOLID_REACH)) return { kind: "refused", why: "range" };
		if (!canRepair(s)) return { kind: "none" };
		const mat = repairMaterial(s);
		// through `removeItem`, not by writing `invenEtc[i] -= 1`: the client's version bypassed the
		// inventory API and so bypassed its "do you actually have this?" check
		if (!removeItem(ctx.save, mat.kind, mat.index, 1)) return { kind: "refused", why: "material" };
		const rate = (ctx.save.skillLevels[SKILL_HANDY] ?? 0) > 0 ? REPAIR_RATE_SKILLED : REPAIR_RATE;
		s.hp = math.min(s.hpMax, s.hp + s.hpMax * rate);
		// to everybody: a repair is rare, and one told only to who was near would be a wall that looks broken to
		// whoever comes back later (correctness review of 5967a18, B)
		this.out.queue({ t: WorldEv.SolidHp, entries: [{ id: s.id, hp: s.hpMax > 0 ? s.hp / s.hpMax : 1 }] });
		return { kind: "repair", solid: s };
	}

	// ---------------------------------------------------------------- searching a building

	private search(ctx: InteractContext, b: Solid): InteractOutcome {
		const found = this.items.search(ctx.save, ctx.state.x, ctx.state.y, ctx.hours, this.pays(ctx.slot));
		if (found.building === undefined) return { kind: "refused", why: "range" };
		if (found.taken.size() === 0) return { kind: "refused", why: "empty" };
		// the flag for everyone standing in that house is refreshed by the sweep in `step`, on the next
		// tick: one place decides who is inside what, instead of two that can disagree
		return { kind: "search", building: b, taken: found.taken.size() };
	}

	// ---------------------------------------------------------------- a gas station's pump

	/**
	 * E at a pump island (EDI-16): its oil into the backpack, the island dry for everybody until its respawn -- the
	 * building search's rules (MP-05), at the SERVER's position, within SOLID_REACH of the island with a clear line to
	 * it. The flag that it held something goes down on the next tick's sweep, for everyone told about it.
	 */
	private pump(ctx: InteractContext, s: Solid): InteractOutcome {
		if (!this.inReach(ctx.state, s, SOLID_REACH)) return { kind: "refused", why: "range" };
		const taken = this.items.drain(ctx.save, s, ctx.hours, this.pays(ctx.slot));
		if (taken.size() === 0) return { kind: "refused", why: "empty" };
		return { kind: "pump", solid: s, taken: taken.size() };
	}

	// ---------------------------------------------------------------- the world's own upkeep

	/**
	 * Burns the fires near the survivors and puts out the ones that ran dry, at 2 Hz like the original.
	 * A fire going out is a `LightSet` delta: it changes what the night looks like, and at §4.3 it changes
	 * which zombies are replicated at all.
	 */
	step(players: ReadonlyArray<PlayerState>, slots: ReadonlyArray<number>, dt: number): void {
		this.items.step(dt);
		decay(this.pressCd, dt);
		decay(this.toggleCd, dt);
		this.publishLootFlags(players, slots);
		this.fireTick += dt;
		if (this.fireTick < FIRE_STEP_S) return;
		const step = this.fireTick;
		this.fireTick = 0;
		for (const p of players) {
			const found = querySolids(
				this.world,
				p.x - FIRE_RANGE,
				p.y - FIRE_RANGE,
				p.x + FIRE_RANGE,
				p.y + FIRE_RANGE,
				this.scratch,
			);
			for (const s of found) {
				if (!isFire(s) || s.powered !== true) continue;
				const left = this.fuelOf(s) - step;
				if (left > 0) {
					this.fuel.set(s, left);
					continue;
				}
				this.fuel.set(s, 0);
				s.powered = false;
				this.emitLight(s, false);
			}
			this.scratch.clear();
		}
		this.forgetGone();
	}

	/**
	 * §4.3/§4.5 `LootFlag`: "there is something to search here" reaches ONLY whoever is standing inside, and
	 * only when the answer changes. The content never travels at all — the server hands the items straight
	 * into the backpack of whoever searched — so the most a modified client can learn from this channel is
	 * what its own player could already see by walking in.
	 *
	 * One sweep instead of a flag pushed from `search`, because two survivors can be in the same house: the
	 * one who did not press E has to watch the hint go out too.
	 *
	 * The container a survivor is AT: the building they stand in, or -- outside every building -- the gas station's
	 * pump island within PUMP_FLAG_REACH (EDI-16). Same message, same rule: the island's static id (a town's pump ids
	 * are small, like its buildings'; the wire's u16 holds them), "something here", never what.
	 */
	private publishLootFlags(players: ReadonlyArray<PlayerState>, slots: ReadonlyArray<number>): void {
		for (let i = 0; i < players.size(); i++) {
			const slot = slots[i] ?? i;
			const p = players[i];
			let b = p.dead ? undefined : buildingAt(this.world, p.x, p.y);
			if (b === undefined && !p.dead) {
				if (this.pumps === undefined) this.pumps = pumpsOf(this.world);
				b = nearestPump(this.pumps, p.x, p.y, PUMP_FLAG_REACH);
			}
			const has = b !== undefined && this.items.hasLoot(b);
			const id = b !== undefined && has ? b.id : 0;
			if (this.lootSeen.get(slot) === id) continue;
			const before = this.lootSeen.get(slot);
			this.lootSeen.set(slot, id);
			// leaving a building (or emptying it) turns the old flag off before the new one goes on
			if (before !== undefined && before !== 0) {
				this.out.queueFor(slot, { t: WorldEv.LootFlag, buildingId: before, hasLoot: false });
			}
			if (id !== 0) this.out.queueFor(slot, { t: WorldEv.LootFlag, buildingId: id, hasLoot: true });
		}
	}

	/** the survivor left: forget which building they were told about (§4.4, a slot is per session) */
	remove(slot: number): void {
		this.lootSeen.delete(slot);
		this.pressCd.delete(slot);
	}

	// ---------------------------------------------------------------- internals

	/**
	 * §8.1: within reach of the solid's EDGE, with a latency allowance, and with a clear line to it — so a
	 * wall between the survivor and a door is still a wall.
	 */
	private inReach(p: PlayerState, s: Solid, limit: number): boolean {
		if (edgeDist(s, p.x, p.y) > limit + REACH_LATENCY_SLACK) return false;
		const cx = math.clamp(p.x, s.x, s.x + s.w);
		const cy = math.clamp(p.y, s.y, s.y + s.h);
		return segmentClear(this.world, p.x, p.y, cx, cy, other => other !== s && isBlocking(other));
	}

	/** is this door or lamp inside its TOGGLE_COOLDOWN_S? */
	private toggling(s: Solid): boolean {
		return (this.toggleCd.get(s) ?? 0) > 0;
	}

	private emitLight(s: Solid, powered: boolean): void {
		// To EVERYBODY, not by interest: nothing ever resent a LightSet, so a fire that burnt out while a survivor was
		// far away still looked lit when they came back -- its light at night, and a cook there predicted and undone
		// (correctness review of 5967a18, B). A light changes a few times a minute, not per tick.
		this.out.queue({ t: WorldEv.LightSet, id: s.id, powered });
	}

	/** drops the fuel entries of fires that were destroyed (the map keys them by object identity) */
	private forgetGone(): void {
		const gone = new Array<Solid>();
		for (const [s] of this.fuel) {
			if (s.removed === true) gone.push(s);
		}
		for (const s of gone) this.fuel.delete(s);
	}
}

/** counts every cooldown in `m` down by `dt`, and drops the ones that ran out */
function decay<K extends defined>(m: Map<K, number>, dt: number): void {
	const done = new Array<K>();
	for (const [k, left] of m) {
		if (left - dt <= 0) done.push(k);
		else m.set(k, left - dt);
	}
	for (const k of done) m.delete(k);
}
