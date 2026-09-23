/*
 * Construction, decided by the SERVER (docs/MULTIPLAYER.md §2.1, §2.4, §4.5, §8.1).
 *
 * The client used to place the wall: `BuildSystem.confirm` called `addSolid` on its own copy of the world.
 * So a barricade existed for whoever built it, the horde on the OTHER five screens walked straight through
 * it, and the ingredients came out of a backpack the client also owned. Three bugs in one line.
 *
 * Here the ghost follows the survivor's own aim (an input, §2.5) and the SERVER computes where it lands,
 * from the position it simulated — `ghostRect`, the same pure function the client draws with, so the drawn
 * ghost and the placed wall cannot disagree. The three build actions ride the input command's edges, the way
 * `BuildSystem.handleInput` swallows a frame on the client:
 *
 *      attack → place        action → cancel (and refund)        reload → rotate
 *
 * which means no new message, no id from the client, and the placement is ordered with the movement it
 * happened during for free (§2.4). A client cannot ask for a wall somewhere it is not.
 *
 * Two rules the client never enforced and could not have:
 *   - the CAPS of §8.1, 150 constructions per player and 600 per server. They are counted from the
 *     constructions themselves (`Solid.owner`), so a wall the horde eats gives its slot back.
 *   - the FLOW FIELD. A new wall changes every path through it, and the horde would keep walking the old
 *     one for up to 200 ms — through a wall — until the next full rebuild. `onSolidChanged` dirties exactly
 *     the tiles the wall covers (§3.3), which is why the hook exists.
 *
 * Pure module: no Instances, no services, no os.clock.
 */
import { addItem } from "shared/sim/inventory";
import {
	ghostRectSticky,
	PLACEABLES,
	PlaceableDef,
	PlaceRect,
	placeRecipe,
	placedSolid,
	placementValid,
} from "shared/sim/placement";
import { addSolid, Solid, WorldData } from "shared/game/world";
import { PlayerSaveData } from "shared/game/save";
import { PlayerState } from "shared/game/player";
import { ZombieState } from "shared/game/entities";
import { MAX_BUILDS_PER_PLAYER, MAX_BUILDS_PER_SERVER, SLOT_NONE } from "shared/net/mpConfig";
import { SolidState, WorldEv, WSolidAdd } from "shared/net/protocol";
import { WorldOut } from "./worldOut";

/** §8.1: at most 2 placements per second per survivor */
export const PLACE_RATE = 2;
/** quarter turns */
const ROT_STEPS = 4;

/** why a placement was refused, or what it produced */
export type PlaceOutcome =
	| { kind: "placed"; solid: Solid }
	| { kind: "cancelled"; refunded: boolean }
	| { kind: "rotated"; rot: number }
	| { kind: "none" }
	| { kind: "refused"; why: "invalid" | "rate" | "capPlayer" | "capServer" | "unknown" };

/** one survivor's pending construction — the client's `refs.pendingPlace` / `pendingRecipe`, server side */
interface Pending {
	/** PLACEABLES id, or -1 for "nothing on the cursor" */
	placeable: number;
	/** the CRAFT_RECIPES id that produced it, so a cancel refunds exactly what was spent */
	recipe: number | undefined;
	rot: number;
	/** last ghost position, for `ghostRectSticky`'s grid deadband */
	prevX: number | undefined;
	prevY: number | undefined;
	/** seconds until another placement is allowed (§8.1) */
	cooldown: number;
}

export interface ServerBuildOptions {
	world: WorldData;
	out: WorldOut;
	/**
	 * A solid appeared or disappeared: the flow field has to read those tiles again (§3.3). This is
	 * `ZombieWorld.refs.onSolidChanged`, passed in rather than reached for, so the module stays pure.
	 */
	onSolidChanged?: (x: number, y: number, w: number, h: number) => void;
	/**
	 * Every solid that enters (`added`) or leaves the world, whoever put it there or took it away — a placement, a
	 * wall the horde chewed through, an admin tool. The electric grid (server/sim/power.ts) keeps its machines by it:
	 * this class owns the world's two hooks, so it passes them on rather than letting a second owner overwrite them.
	 */
	onSolid?: (s: Solid, added: boolean) => void;
}

export class ServerBuild {
	private readonly world: WorldData;
	private readonly out: WorldOut;
	private readonly onSolidChanged?: (x: number, y: number, w: number, h: number) => void;
	private readonly onSolid?: (s: Solid, added: boolean) => void;
	private readonly pending = new Map<number, Pending>();
	/** live constructions per owner slot, and in total (§8.1 caps) */
	private readonly owned = new Map<number, number>();
	private total = 0;

	constructor(options: ServerBuildOptions) {
		this.world = options.world;
		this.out = options.out;
		this.onSolidChanged = options.onSolidChanged;
		this.onSolid = options.onSolid;
		// §4.5: a construction is GLOBAL — everybody collides with it, so everybody is told about it, in
		// sight or not. The hooks also catch what the horde chews through, which is a `SolidRemove` nobody
		// would otherwise remember to send.
		this.world.onSolidAdd = (w, s) => this.noteAdded(s);
		this.world.onSolidRemove = (w, s) => this.noteRemoved(s);
	}

	detach(): void {
		this.world.onSolidAdd = undefined;
		this.world.onSolidRemove = undefined;
	}

	// ---------------------------------------------------------------- the pending construction

	/** is this survivor holding a construction on the cursor? (the edges then mean build, not interact) */
	placing(slot: number): boolean {
		return (this.pending.get(slot)?.placeable ?? -1) >= 0;
	}

	/** the PLACEABLES id on the cursor, or -1 */
	pendingOf(slot: number): number {
		return this.pending.get(slot)?.placeable ?? -1;
	}

	/** a craft produced a placeable: it goes on the cursor instead of into the backpack (craftKind 1) */
	hold(slot: number, placeable: number, recipe: number | undefined): void {
		const p = this.stateOf(slot);
		p.placeable = placeable;
		p.recipe = recipe;
		p.rot = 0;
		p.prevX = undefined;
		p.prevY = undefined;
	}

	/** the ghost this survivor would place right now, or undefined when nothing is on the cursor */
	ghost(slot: number, state: PlayerState): PlaceRect | undefined {
		const p = this.pending.get(slot);
		if (p === undefined || p.placeable < 0) return undefined;
		const def = PLACEABLES[p.placeable] as PlaceableDef | undefined;
		if (def === undefined) return undefined;
		const r = ghostRectSticky(def, state.x, state.y, state.angle, p.rot, p.prevX, p.prevY);
		p.prevX = r.x;
		p.prevY = r.y;
		return r;
	}

	rotate(slot: number): PlaceOutcome {
		const p = this.pending.get(slot);
		if (p === undefined || p.placeable < 0) return { kind: "none" };
		p.rot = (p.rot + 1) % ROT_STEPS;
		// the deadband is about a JITTERING position, not a rotation the player asked for
		p.prevX = undefined;
		p.prevY = undefined;
		return { kind: "rotated", rot: p.rot };
	}

	/**
	 * Places the construction where the survivor is aiming. Everything is revalidated here — §8.1's "fantasma
	 * válido", the world bounds, the caps and the rate — because the client's ghost is a drawing, not a claim.
	 */
	place(
		slot: number,
		state: PlayerState,
		players: ReadonlyArray<PlayerState>,
		zombies: ReadonlyArray<ZombieState>,
	): PlaceOutcome {
		const p = this.pending.get(slot);
		if (p === undefined || p.placeable < 0) return { kind: "none" };
		if (p.cooldown > 0) return { kind: "refused", why: "rate" };
		const def = PLACEABLES[p.placeable] as PlaceableDef | undefined;
		if (def === undefined) {
			// an unknown id can never become a solid: drop it rather than leave it stuck on the cursor
			this.clear(p);
			return { kind: "refused", why: "unknown" };
		}
		if ((this.owned.get(slot) ?? 0) >= MAX_BUILDS_PER_PLAYER) return { kind: "refused", why: "capPlayer" };
		if (this.total >= MAX_BUILDS_PER_SERVER) return { kind: "refused", why: "capServer" };
		const r = ghostRectSticky(def, state.x, state.y, state.angle, p.rot, p.prevX, p.prevY);
		if (!placementValid(this.world, r, players, zombies)) return { kind: "refused", why: "invalid" };
		const rot = p.rot;
		const placeable = p.placeable;
		this.clear(p);
		p.cooldown = 1 / PLACE_RATE;
		// `addSolid` fires `onSolidAdd`, which is what queues the delta and bumps the caps
		const solid = addSolid(this.world, { ...placedSolid(def, r, rot), placeable, owner: slot });
		return { kind: "placed", solid };
	}

	/** §8.1 `cancelPlace`: the construction leaves the cursor and its ingredients come back */
	cancel(slot: number, save: PlayerSaveData): PlaceOutcome {
		const p = this.pending.get(slot);
		if (p === undefined || p.placeable < 0) return { kind: "none" };
		const recipe = placeRecipe(p.placeable, p.recipe);
		this.clear(p);
		if (recipe === undefined) return { kind: "cancelled", refunded: false };
		for (const ing of recipe.ingredients) addItem(save, ing.kind, ing.index, ing.count);
		return { kind: "cancelled", refunded: true };
	}

	/**
	 * The survivor left the world with something still on the cursor. The ingredients are theirs — they paid
	 * for them — so this is a cancel, not a forfeit, and it also stops the slot inheriting a pending
	 * construction when somebody else takes it (§4.4: a slot is stable for a session, not beyond one).
	 */
	remove(slot: number, save?: PlayerSaveData): void {
		if (save !== undefined) this.cancel(slot, save);
		this.pending.delete(slot);
		/*
		 * Their walls stay standing -- the base belongs to the server session (§6.1), not to whoever is
		 * logged in -- but they stop counting against the SLOT. A slot is stable for a session and no longer
		 * (§4.4), so the next player to take slot 0 must not inherit a quota of 150 walls they never built.
		 * The server-wide cap still counts them, which is the cap that protects the server.
		 */
		for (const s of this.world.solids) {
			if (s.placeable === undefined || s.owner !== slot) continue;
			s.owner = SLOT_NONE;
			this.owned.set(SLOT_NONE, (this.owned.get(SLOT_NONE) ?? 0) + 1);
		}
		this.owned.delete(slot);
	}

	/** decays the per-survivor placement cooldowns */
	step(dt: number): void {
		for (const [, p] of this.pending) {
			if (p.cooldown > 0) p.cooldown = math.max(0, p.cooldown - dt);
		}
	}

	// ---------------------------------------------------------------- caps and deltas

	/** live constructions owned by this slot (§8.1) */
	countOf(slot: number): number {
		return this.owned.get(slot) ?? 0;
	}

	/** live constructions on the whole server */
	count(): number {
		return this.total;
	}

	/**
	 * Rebuilds the cap counters from the world. Needed when a world already holding constructions is adopted
	 * (a test, a reload) rather than built up through `addSolid` under these hooks.
	 */
	recount(): void {
		this.owned.clear();
		this.total = 0;
		for (const s of this.world.solids) {
			if (s.placeable === undefined) continue;
			this.total += 1;
			const owner = s.owner ?? SLOT_NONE;
			this.owned.set(owner, (this.owned.get(owner) ?? 0) + 1);
		}
	}

	/** every construction a joining survivor has to know about (§4.5 WorldInit) — all of them, they are global */
	initAll(out: Array<Solid>): Array<Solid> {
		for (const s of this.world.solids) {
			if (s.placeable !== undefined) out.push(s);
		}
		return out;
	}

	private noteAdded(s: Solid): void {
		this.onSolid?.(s, true);
		if (s.placeable === undefined) return;
		this.total += 1;
		const owner = s.owner ?? SLOT_NONE;
		this.owned.set(owner, (this.owned.get(owner) ?? 0) + 1);
		this.out.queue(solidAdd(s));
		if (this.onSolidChanged !== undefined) this.onSolidChanged(s.x, s.y, s.w, s.h);
	}

	private noteRemoved(s: Solid): void {
		this.onSolid?.(s, false);
		if (this.onSolidChanged !== undefined) this.onSolidChanged(s.x, s.y, s.w, s.h);
		if (s.placeable === undefined) return;
		this.total = math.max(0, this.total - 1);
		const owner = s.owner ?? SLOT_NONE;
		this.owned.set(owner, math.max(0, (this.owned.get(owner) ?? 0) - 1));
		this.out.queue({ t: WorldEv.SolidRemove, id: s.id });
	}

	private stateOf(slot: number): Pending {
		let p = this.pending.get(slot);
		if (p === undefined) {
			p = { placeable: -1, recipe: undefined, rot: 0, prevX: undefined, prevY: undefined, cooldown: 0 };
			this.pending.set(slot, p);
		}
		return p;
	}

	private clear(p: Pending): void {
		p.placeable = -1;
		p.recipe = undefined;
		p.rot = 0;
		p.prevX = undefined;
		p.prevY = undefined;
	}
}

/** the `SolidAdd` delta of a construction (§4.5) */
export function solidAdd(s: Solid): WSolidAdd {
	let state = 0;
	if (s.powered === true) state += SolidState.Powered;
	if (s.open === true) state += SolidState.Open;
	return {
		t: WorldEv.SolidAdd,
		id: s.id,
		placeable: s.placeable ?? 0,
		x: s.x,
		y: s.y,
		rot: s.rot ?? 0,
		hp: s.hpMax > 0 ? math.clamp(s.hp / s.hpMax, 0, 1) : 1,
		state,
		owner: s.owner ?? SLOT_NONE,
	};
}
