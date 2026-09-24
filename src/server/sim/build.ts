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
 * Rules the client never enforced and could not have:
 *   - the CAPS of §8.1, 150 constructions per player and 600 per server. They are counted from the
 *     constructions themselves, so a wall the horde eats gives its place back -- and the per-player one by the
 *     ACCOUNT that built it (`Solid.builder`, a UserId; MP-24): leaving and coming back in another slot used to
 *     hand the same account another 150, until one account held the server's 600.
 *   - ABANDONED constructions rot (MP-24): a builder out of the world for BUILD_ABANDON_GRACE_S sees them lose
 *     their hp over BUILD_ABANDON_DECAY_S and fall, freeing both caps -- and a survivor who repairs one while it
 *     rots takes it over (`adopt`), which is how a group's base outlives whoever left.
 *   - NOBODY PENNED IN (MP-24): the piece that would close a ring around a living survivor is refused
 *     (server/sim/enclosure.ts); a survivor cannot take a wall down (MP-11), so without it a wall was the way to do
 *     what MP-02 forbids bodies to do.
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
	snapToOpening,
} from "shared/sim/placement";
import { addSolid, isBlocking, removeSolid, Solid, WorldData } from "shared/game/world";
import { PlayerSaveData } from "shared/game/save";
import { PlayerState } from "shared/game/player";
import { ZombieState } from "shared/game/entities";
import {
	BUILD_ABANDON_DECAY_S,
	BUILD_ABANDON_GRACE_S,
	MAX_BUILDS_PER_PLAYER,
	MAX_BUILDS_PER_SERVER,
	SLOT_NONE,
	SOLID_HP_HZ,
} from "shared/net/mpConfig";
import { quantFrac8 } from "shared/net/codec";
import { SOLID_HP_MAX_ENTRIES, SolidHpEntry, SolidState, WorldEv, WSolidAdd } from "shared/net/protocol";
import { WorldOut } from "./worldOut";
import { boxesIn, needsFlood } from "./enclosure";
import { SimProfiler } from "./metrics";

/** §8.1: at most 2 placements per second per survivor */
export const PLACE_RATE = 2;
/**
 * (MP-24) Placements whose "would this pen somebody in?" walk runs, per tick, for the whole server (the security review
 * of the net hardening, M2). The walk is a flood of up to 33 × 33 body tests per survivor in reach, twice: six
 * builders clicking every tick used to buy six of those a tick. Past the budget a placement that needs the walk
 * answers "rate", the same as a click inside the §8.1 rate, and the next click tries again; one that needs none (a
 * door, a trap, a piece nobody is near) never waits for it. The walk is the MicroProfiler's "PZ.build.sealed".
 */
export const SEALED_CHECKS_PER_TICK = 1;
/** quarter turns */
const ROT_STEPS = 4;

/** why a placement was refused, or what it produced */
export type PlaceOutcome =
	| { kind: "placed"; solid: Solid }
	| { kind: "cancelled"; refunded: boolean }
	| { kind: "rotated"; rot: number }
	| { kind: "none" }
	| { kind: "refused"; why: "invalid" | "rate" | "capPlayer" | "capServer" | "sealed" | "unknown" };

/** one survivor's pending construction — the client's `refs.pendingPlace` / `pendingRecipe`, server side */
interface Pending {
	/**
	 * Build edges this cursor has answered (a placement tried, placed or refused; a cancel; a drop). The wallet's bag
	 * signs it (server/main.server.ts `bagFor`): a REFUSED placement changes nothing else the client can see, and
	 * without it no bag was pushed -- the client, which freed its cursor on the click, waited 3 s for an answer
	 * while the server still held the wall and holstered the gun (correctness review of 5967a18, A).
	 */
	turns: number;
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
	/**
	 * (MP-24) The UserId of the survivor in `slot`, or undefined. The per-player cap and the rot of abandoned
	 * constructions go by the ACCOUNT that built them; without it (a test building this class alone) a construction
	 * has no builder and counts against its slot, as before.
	 */
	userOf?: (slot: number) => number | undefined;
	/** (MP-24) is this account's survivor in the world right now? (absent too long, their constructions rot) */
	present?: (userId: number) => boolean;
	/** the tick's MicroProfiler (server/sim/metrics.ts), read when a walk runs; none in the pure tests */
	profile?: () => SimProfiler | undefined;
}

export class ServerBuild {
	private readonly world: WorldData;
	private readonly out: WorldOut;
	private readonly onSolidChanged?: (x: number, y: number, w: number, h: number) => void;
	private readonly onSolid?: (s: Solid, added: boolean) => void;
	private readonly userOf?: (slot: number) => number | undefined;
	private readonly present?: (userId: number) => boolean;
	private readonly profile?: () => SimProfiler | undefined;
	/** walks left this tick (SEALED_CHECKS_PER_TICK), refilled by `step` */
	private checksLeft = SEALED_CHECKS_PER_TICK;
	/** placements the budget sent back as "rate" since boot (the tests', and a playtest's) */
	readonly deferred = { checks: 0 };
	private readonly pending = new Map<number, Pending>();
	/** live constructions per builder account (§8.1's per-player cap, MP-24), and in total (the server's) */
	private readonly owned = new Map<number, Set<Solid>>();
	/** constructions with no builder account but an owner slot (no `userOf`): counted by slot, as before MP-24 */
	private readonly slotOnly = new Map<number, number>();
	private total = 0;
	/** (MP-24) seconds each builder with constructions standing has been out of the world */
	private readonly absent = new Map<number, number>();
	/**
	 * Every construction standing, with the hp (as the wire's frac8) everybody was last told. A zombie chewing on a
	 * wall (shared/sim/ai/zombieBrain.ts `damageStructure`) had no way to tell anyone: the walls looked whole until
	 * they vanished, and "E: Repair" never showed (correctness review of 5967a18, D). `step` sends what moved, at
	 * SOLID_HP_HZ, to everybody -- a wall is global like its SolidAdd, and a few per second at most.
	 */
	private readonly standing = new Map<Solid, number>();
	private hpClock = 0;

	constructor(options: ServerBuildOptions) {
		this.world = options.world;
		this.out = options.out;
		this.onSolidChanged = options.onSolidChanged;
		this.onSolid = options.onSolid;
		this.userOf = options.userOf;
		this.present = options.present;
		this.profile = options.profile;
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

	/** how many build edges this slot's cursor has answered (see `Pending.turns`) */
	turnsOf(slot: number): number {
		return this.pending.get(slot)?.turns ?? 0;
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
		// a barricade or a door aimed at a doorway or a window fills it (EDI-13); the deadband stays on the grid
		return snapToOpening(this.world, def, r);
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
		p.turns += 1;
		if (p.cooldown > 0) return this.refuse(p, "rate");
		const def = PLACEABLES[p.placeable] as PlaceableDef | undefined;
		if (def === undefined) {
			// an unknown id can never become a solid: drop it rather than leave it stuck on the cursor
			this.clear(p);
			return { kind: "refused", why: "unknown" };
		}
		if (this.countOf(slot) >= MAX_BUILDS_PER_PLAYER) return this.refuse(p, "capPlayer");
		if (this.total >= MAX_BUILDS_PER_SERVER) return this.refuse(p, "capServer");
		// a barricade or a door aimed at a doorway or a window fills it (EDI-13): the same snap as the client's ghost
		const r = snapToOpening(
			this.world,
			def,
			ghostRectSticky(def, state.x, state.y, state.angle, p.rot, p.prevX, p.prevY),
		);
		if (!placementValid(this.world, r, players, zombies)) return this.refuse(p, "invalid");
		const rot = p.rot;
		const shape = placedSolid(def, r, rot);
		// MP-24: never the piece that closes a ring around a living survivor. What cannot close a ring is what the
		// bodies walk through (world.ts isBlocking: a trap, anything passable) and a door, which is a way out. The check
		// walks the ground around them, so a refused one waits the placement rate like a placed one (a click every tick
		// must not buy a walk a tick), and the server runs SEALED_CHECKS_PER_TICK of them a tick at most
		const blocks = isBlocking(shape as Solid) && def.kind !== "door" && def.kind !== "iron_door";
		if (needsFlood(this.world, r, blocks, players)) {
			if (this.checksLeft <= 0) {
				this.deferred.checks += 1;
				return this.refuse(p, "rate");
			}
			this.checksLeft -= 1;
			const prof = this.profile?.();
			prof?.begin("PZ.build.sealed");
			const penned = boxesIn(this.world, r, blocks, players);
			prof?.end();
			if (penned !== undefined) {
				p.cooldown = 1 / PLACE_RATE;
				return this.refuse(p, "sealed");
			}
		}
		const placeable = p.placeable;
		this.clear(p);
		p.cooldown = 1 / PLACE_RATE;
		// `addSolid` fires `onSolidAdd`, which is what queues the delta and bumps the caps
		const solid = addSolid(this.world, {
			...shape,
			placeable,
			owner: slot,
			builder: this.userOf?.(slot),
		});
		return { kind: "placed", solid };
	}

	/** §8.1 `cancelPlace`: the construction leaves the cursor and its ingredients come back */
	cancel(slot: number, save: PlayerSaveData): PlaceOutcome {
		const p = this.pending.get(slot);
		if (p === undefined || p.placeable < 0) return { kind: "none" };
		p.turns += 1;
		const recipe = placeRecipe(p.placeable, p.recipe);
		this.clear(p);
		if (recipe === undefined) return { kind: "cancelled", refunded: false };
		for (const ing of recipe.ingredients) addItem(save, ing.kind, ing.index, ing.count);
		return { kind: "cancelled", refunded: true };
	}

	/**
	 * The construction leaves the cursor with NOTHING back, because the life that paid for it is over: a New game
	 * (server/sim/life.ts `newLife`) or the new life a world's end gives (`grantNewLife`). Their `resetRun` already
	 * wiped that life's backpack; a refund after it would land the old run's materials in the new one (security
	 * review of 5967a18, R1). A death does not come here: it refunds into the dying run (`LifeKeeper.died`).
	 */
	drop(slot: number): void {
		const p = this.pending.get(slot);
		if (p === undefined || p.placeable < 0) return;
		p.turns += 1;
		this.clear(p);
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
		 * logged in -- but they stop belonging to the SLOT. A slot is stable for a session and no longer
		 * (§4.4), so the next player to take slot 0 must not inherit walls they never built. They still count
		 * against their BUILDER's account (MP-24) -- that is what stops a leave and a rejoin from resetting the
		 * cap -- and against the server's, and from BUILD_ABANDON_GRACE_S on they rot (`rot`).
		 */
		for (const s of this.world.solids) {
			if (s.placeable === undefined || s.owner !== slot) continue;
			s.owner = SLOT_NONE;
		}
		const orphans = this.slotOnly.get(slot);
		if (orphans !== undefined) {
			this.slotOnly.delete(slot);
			this.slotOnly.set(SLOT_NONE, (this.slotOnly.get(SLOT_NONE) ?? 0) + orphans);
		}
	}

	/**
	 * (MP-24) A survivor entered the world in `slot`: the constructions their account built are theirs again, slot
	 * and all (a turret credits its builder and uses their skills, server/sim/power.ts), and they stop rotting.
	 */
	enter(slot: number): void {
		const user = this.userOf?.(slot);
		if (user === undefined) return;
		this.absent.delete(user);
		const mine = this.owned.get(user);
		if (mine === undefined) return;
		for (const s of mine) s.owner = slot;
	}

	/**
	 * (MP-24) Whoever keeps it standing keeps it: `slot` just repaired `s`. A construction whose builder has been gone
	 * past BUILD_ABANDON_GRACE_S -- one that is rotting -- becomes theirs, if their own cap has room for it: it counts
	 * against them and stops rotting while they are in the world. True when it changed hands.
	 */
	adopt(s: Solid, slot: number): boolean {
		if (s.placeable === undefined || s.removed === true || !this.standing.has(s)) return false;
		const user = this.userOf?.(slot);
		const from = s.builder;
		if (user === undefined || from === undefined || from === user) return false;
		if ((this.absent.get(from) ?? 0) <= BUILD_ABANDON_GRACE_S) return false;
		if (this.countOfUser(user) >= MAX_BUILDS_PER_PLAYER) return false;
		this.unclaim(s);
		s.builder = user;
		s.owner = slot;
		this.claim(s);
		return true;
	}

	/** decays the per-survivor placement cooldowns, and tells everybody the hp that moved (SOLID_HP_HZ) */
	step(dt: number): void {
		// once a tick (server/sim/simulation.ts `stepInteractiveWorld`, after every survivor's command)
		this.checksLeft = SEALED_CHECKS_PER_TICK;
		for (const [, p] of this.pending) {
			if (p.cooldown > 0) p.cooldown = math.max(0, p.cooldown - dt);
		}
		this.hpClock += dt;
		if (this.hpClock < 1 / SOLID_HP_HZ) return;
		const span = this.hpClock;
		this.hpClock = 0;
		this.rot(span);
		let entries = new Array<SolidHpEntry>();
		for (const [s, told] of this.standing) {
			const hp = hpFraction(s);
			const now = quantFrac8(hp);
			if (now === told) continue;
			this.standing.set(s, now);
			entries.push({ id: s.id, hp });
			if (entries.size() >= SOLID_HP_MAX_ENTRIES) {
				this.out.queue({ t: WorldEv.SolidHp, entries });
				entries = new Array<SolidHpEntry>();
			}
		}
		if (entries.size() > 0) this.out.queue({ t: WorldEv.SolidHp, entries });
	}

	// ---------------------------------------------------------------- caps and deltas

	/** live constructions of the account in this slot (§8.1, MP-24); by slot when nobody says whose account it is */
	countOf(slot: number): number {
		const user = this.userOf?.(slot);
		if (user !== undefined) return this.countOfUser(user);
		return this.slotOnly.get(slot) ?? 0;
	}

	/** live constructions this account built (MP-24: in the world or not) */
	countOfUser(userId: number): number {
		return this.owned.get(userId)?.size() ?? 0;
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
		this.slotOnly.clear();
		this.standing.clear();
		this.total = 0;
		for (const s of this.world.solids) {
			if (s.placeable === undefined) continue;
			this.standing.set(s, quantFrac8(hpFraction(s)));
			this.total += 1;
			this.claim(s);
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
		this.standing.set(s, quantFrac8(hpFraction(s)));
		this.total += 1;
		this.claim(s);
		this.out.queue(solidAdd(s));
		if (this.onSolidChanged !== undefined) this.onSolidChanged(s.x, s.y, s.w, s.h);
	}

	private noteRemoved(s: Solid): void {
		this.onSolid?.(s, false);
		if (this.onSolidChanged !== undefined) this.onSolidChanged(s.x, s.y, s.w, s.h);
		if (s.placeable === undefined) return;
		this.standing.delete(s);
		this.total = math.max(0, this.total - 1);
		this.unclaim(s);
		this.out.queue({ t: WorldEv.SolidRemove, id: s.id });
	}

	/**
	 * Counts a construction against its builder's account (MP-24). One that came without a builder but with the
	 * slot of somebody in the world (a test, an admin tool) is given that survivor's account; failing that it counts
	 * against its slot alone, which is all a slot-only construction ever did.
	 */
	private claim(s: Solid): void {
		const owner = s.owner ?? SLOT_NONE;
		if (s.builder === undefined && owner !== SLOT_NONE) s.builder = this.userOf?.(owner);
		const user = s.builder;
		if (user === undefined) {
			this.slotOnly.set(owner, (this.slotOnly.get(owner) ?? 0) + 1);
			return;
		}
		let mine = this.owned.get(user);
		if (mine === undefined) {
			mine = new Set<Solid>();
			this.owned.set(user, mine);
		}
		mine.add(s);
	}

	private unclaim(s: Solid): void {
		const user = s.builder;
		if (user === undefined) {
			const owner = s.owner ?? SLOT_NONE;
			this.slotOnly.set(owner, math.max(0, (this.slotOnly.get(owner) ?? 0) - 1));
			return;
		}
		const mine = this.owned.get(user);
		if (mine === undefined) return;
		mine.delete(s);
		if (mine.size() === 0) {
			this.owned.delete(user);
			this.absent.delete(user);
		}
	}

	/**
	 * (MP-24) `span` seconds of the builders' absence: each account with constructions standing that is out of the
	 * world counts it, and past BUILD_ABANDON_GRACE_S its constructions lose their whole hp over BUILD_ABANDON_DECAY_S
	 * -- the SolidHp pass right after tells everybody -- and fall at 0 like a wall the horde chewed through.
	 */
	private rot(span: number): void {
		if (this.present === undefined || this.owned.size() === 0) return;
		let falling: Array<Solid> | undefined;
		for (const [user, mine] of this.owned) {
			if (this.present(user)) {
				this.absent.delete(user);
				continue;
			}
			const now = (this.absent.get(user) ?? 0) + span;
			this.absent.set(user, now);
			const over = math.min(span, now - BUILD_ABANDON_GRACE_S);
			if (over <= 0) continue;
			for (const s of mine) {
				s.hp -= (s.hpMax * over) / BUILD_ABANDON_DECAY_S;
				if (s.hp > 0) continue;
				s.hp = 0;
				if (falling === undefined) falling = new Array<Solid>();
				falling.push(s);
			}
		}
		if (falling === undefined) return;
		// outside the loop: a removal edits the very sets it walks (`unclaim`)
		for (const s of falling) if (s.removed !== true) removeSolid(this.world, s);
	}

	private stateOf(slot: number): Pending {
		let p = this.pending.get(slot);
		if (p === undefined) {
			p = { turns: 0, placeable: -1, recipe: undefined, rot: 0, prevX: undefined, prevY: undefined, cooldown: 0 };
			this.pending.set(slot, p);
		}
		return p;
	}

	/**
	 * A placement the server will not make. The construction stays on the cursor, UNTURNED: the client, told by the
	 * bag that answers this edge, draws it again from rotation 0 (client/systems/build.ts starts every build mode
	 * there), so the next click places what the player sees.
	 */
	private refuse(p: Pending, why: "rate" | "invalid" | "capPlayer" | "capServer" | "sealed"): PlaceOutcome {
		p.rot = 0;
		p.prevX = undefined;
		p.prevY = undefined;
		return { kind: "refused", why };
	}

	private clear(p: Pending): void {
		p.placeable = -1;
		p.recipe = undefined;
		p.rot = 0;
		p.prevX = undefined;
		p.prevY = undefined;
	}
}

/** a construction's hp as the fraction the wire carries */
function hpFraction(s: Solid): number {
	return s.hpMax > 0 ? math.clamp(s.hp / s.hpMax, 0, 1) : 1;
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
