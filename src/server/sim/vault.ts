/*
 * The bank's vault, on the SERVER (docs/DESIGN_RULES.md EDI-24; the rules and the numbers: shared/sim/vault.ts).
 *
 * Who is working which vault door, how far the work has gone, and the alarm once a door gave way. Driven by
 * server/sim/interaction.ts: an E press at the door (`press`, after its reach check), the held E of every command
 * (`hold`, from the simulation's `stepWorldActions`) and the world's upkeep (`step`, every tick).
 *
 * What it sends is what a door and a lamp already send, globally: the DoorSet of the door swinging open (and it never
 * shuts again: "open" is "cracked", so a survivor who joins later is told by the WorldInit's open doors), the LightSet
 * of the bell under the bank's portico ringing and falling silent, and the Fx sounds of a door. The noise reaches the
 * horde's ears through `noise` (zombieBrain's emitSound): the work's clank, the bang of the door, the alarm's ring.
 * Nothing new travels.
 *
 * Pure module: no Instances, no services, no os.clock.
 */
import type { PlayerState } from "shared/game/player";
import type { PlayerSaveData } from "shared/game/save";
import type { Solid, WorldData } from "shared/game/world";
import { wireSoundId } from "shared/net/fxWire";
import { FxEvent, FxType, SolidState, WorldEv } from "shared/net/protocol";
import * as V from "shared/sim/vault";
import type { WorldOut } from "./worldOut";

/** what an E press at a vault door did */
export type VaultPress =
	/** the work started, or went on: `progress` seconds of VAULT_CRACK_S so far */
	| { kind: "work"; door: Solid; progress: number }
	/** no crowbar in the backpack ("tool"), or the door is already open ("open") */
	| { kind: "refused"; why: "tool" | "open" };

export interface ServerVaultOptions {
	world: WorldData;
	out: WorldOut;
	/** cosmetic effects (the clank of the work, the door swinging open); undefined in a test that does not look */
	fx?: (event: FxEvent) => void;
	/** a ring of noise the horde hears (zombieBrain's emitSound); undefined: nobody listens */
	noise?: (x: number, y: number, radius: number, shot: boolean) => void;
	/** the door opened: the flow field reads that patch again (§3.3), as for any door */
	onSolidChanged?: (x: number, y: number, w: number, h: number) => void;
	/** may this body still work this door: within the door's reach, a clear line to it (the E press's own rule) */
	reach: (body: PlayerState, door: Solid) => boolean;
	/**
	 * A vault gave way: called once for EVERY survivor working it at that moment (`slot`), since two at one door crack
	 * it together (the titles' Safecracker, the tests and the logs; review of 97cd734, LOW3)
	 */
	onCracked?: (door: Solid, slot: number) => void;
}

interface Worker {
	door: Solid;
	/** seconds the work goes on without a held or pressed E */
	grace: number;
}

interface Alarm {
	portico: Solid;
	/** seconds the bell still rings */
	left: number;
	/** seconds to the next ring of noise */
	pulse: number;
}

export class ServerVaults {
	private readonly world: WorldData;
	private readonly out: WorldOut;
	private readonly fx?: (event: FxEvent) => void;
	private readonly noise?: (x: number, y: number, radius: number, shot: boolean) => void;
	private readonly onSolidChanged?: (x: number, y: number, w: number, h: number) => void;
	private readonly reach: (body: PlayerState, door: Solid) => boolean;
	private readonly onCracked?: (door: Solid, slot: number) => void;
	/** who works which door (by slot) */
	private readonly workers = new Map<number, Worker>();
	/** seconds of work on each door so far, and to its next clank */
	private readonly progress = new Map<Solid, number>();
	private readonly clank = new Map<Solid, number>();
	/** the bells ringing */
	private readonly alarms = new Array<Alarm>();
	/** scratch: the doors worked this tick */
	private readonly worked = new Map<Solid, number>();
	/** scratch: who was working a door when it gave way */
	private readonly crew = new Array<number>();
	/** each bank's portico by the bank's id (listed once: the town is static) */
	private porticos?: Map<number, Solid>;

	constructor(options: ServerVaultOptions) {
		this.world = options.world;
		this.out = options.out;
		this.fx = options.fx;
		this.noise = options.noise;
		this.onSolidChanged = options.onSolidChanged;
		this.reach = options.reach;
		this.onCracked = options.onCracked;
	}

	/** E at the vault door (its reach already checked): the work starts, or goes on */
	press(slot: number, save: PlayerSaveData, door: Solid): VaultPress {
		if (door.open === true) return { kind: "refused", why: "open" };
		if (!V.hasVaultTool(save)) return { kind: "refused", why: "tool" };
		const w = this.workers.get(slot);
		if (w !== undefined && w.door === door) w.grace = V.VAULT_GRACE_S;
		else this.workers.set(slot, { door, grace: V.VAULT_GRACE_S });
		return { kind: "work", door, progress: this.progress.get(door) ?? 0 };
	}

	/**
	 * One command of the survivor in `slot`: E held keeps their work going -- while they stay at the door with the
	 * crowbar. A survivor who walked off, or lost the tool, stops at once.
	 */
	hold(slot: number, body: PlayerState, save: PlayerSaveData, held: boolean): void {
		const w = this.workers.get(slot);
		if (w === undefined) return;
		if (body.dead || w.door.open === true || !V.hasVaultTool(save) || !this.reach(body, w.door)) {
			this.workers.delete(slot);
			return;
		}
		if (held) w.grace = V.VAULT_GRACE_S;
	}

	/** is the survivor in `slot` working a vault door? (the tests; a HUD would ask the same) */
	working(slot: number): boolean {
		return this.workers.has(slot);
	}

	/** seconds of work on this door so far (0: none, or it started over) */
	progressOf(door: Solid): number {
		return this.progress.get(door) ?? 0;
	}

	/** is the bell of this bank's portico ringing? */
	ringing(portico: Solid): boolean {
		for (const a of this.alarms) if (a.portico === portico) return true;
		return false;
	}

	/** the survivor left (§4.4): their work stops */
	remove(slot: number): void {
		this.workers.delete(slot);
	}

	/** every tick: the work goes on (or stops), a door gives way, a bell rings and falls silent */
	step(dt: number): void {
		const worked = this.worked;
		worked.clear();
		for (const [slot, w] of this.workers) {
			w.grace -= dt;
			if (w.grace <= 0 || w.door.open === true) {
				this.workers.delete(slot);
				continue;
			}
			// two survivors at one door work it no faster than one: the door is the limit, not the hands
			if (!worked.has(w.door)) worked.set(w.door, slot);
		}
		// a door nobody works any more starts over: the bolts seat again
		for (const [door] of this.progress) {
			if (!worked.has(door)) {
				this.progress.delete(door);
				this.clank.delete(door);
			}
		}
		for (const [door, slot] of worked) {
			const t = (this.progress.get(door) ?? 0) + dt;
			this.progress.set(door, t);
			const due = (this.clank.get(door) ?? 0) - dt;
			if (due <= 0) {
				this.clank.set(door, due + V.VAULT_WORK_PERIOD);
				this.clankAt(door);
			} else {
				this.clank.set(door, due);
			}
			if (t >= V.VAULT_CRACK_S) this.crack(door, slot);
		}
		for (let i = this.alarms.size() - 1; i >= 0; i--) {
			const a = this.alarms[i];
			a.pulse -= dt;
			if (a.pulse <= 0) {
				a.pulse += V.VAULT_ALARM_PERIOD;
				const p = a.portico;
				this.noise?.(p.x + p.w / 2, p.y + p.h / 2, V.VAULT_ALARM_RADIUS, false);
			}
			a.left -= dt;
			if (a.left <= 0) {
				this.alarms.remove(i);
				a.portico.powered = false;
				this.out.queue({ t: WorldEv.LightSet, id: a.portico.id, powered: false });
			}
		}
	}

	// ---------------------------------------------------------------- internals

	/** the work is heard: a clank of steel the street hears, and the horde's ring */
	private clankAt(door: Solid): void {
		const x = door.x + door.w / 2;
		const y = door.y + door.h / 2;
		this.noise?.(x, y, V.VAULT_WORK_NOISE, true);
		this.fx?.({ t: FxType.Sound, sound: wireSoundId("ironDoorClose"), x, y, volume: 0.8 });
	}

	/** the door gives way: open for good, a bang, and the bank's alarm bell. `slot`: the worker the step counted */
	private crack(door: Solid, slot: number): void {
		door.open = true;
		this.progress.delete(door);
		this.clank.delete(door);
		// everybody at this door cracked it, not only the one the step happened to count (review of 97cd734, LOW3)
		const crew = this.crew;
		crew.clear();
		for (const [s, w] of this.workers) {
			if (w.door !== door) continue;
			crew.push(s);
			this.workers.delete(s);
		}
		if (!crew.includes(slot)) crew.push(slot);
		this.onSolidChanged?.(door.x, door.y, door.w, door.h);
		// GLOBAL, like every door (§4.5): whoever predicts a walk through that doorway has to know it is open
		this.out.queue({ t: WorldEv.DoorSet, id: door.id, state: SolidState.Open });
		const x = door.x + door.w / 2;
		const y = door.y + door.h / 2;
		this.fx?.({ t: FxType.Sound, sound: wireSoundId("ironDoorOpen"), x, y, volume: 1 });
		this.noise?.(x, y, V.VAULT_OPEN_NOISE, true);
		const portico = this.porticoOf(door);
		if (portico !== undefined && !this.ringing(portico)) {
			portico.powered = true;
			// global too: the bell is heard two blocks away, further than any survivor's interest in the solids
			this.out.queue({ t: WorldEv.LightSet, id: portico.id, powered: true });
			this.alarms.push({ portico, left: V.VAULT_ALARM_S, pulse: 0 });
		}
		for (const s of crew) this.onCracked?.(door, s);
	}

	/** the portico of the bank this door belongs to */
	private porticoOf(door: Solid): Solid | undefined {
		if (this.porticos === undefined) {
			const map = new Map<number, Solid>();
			for (const s of this.world.solids) {
				if (V.isPortico(s) && s.bankId !== undefined) map.set(s.bankId, s);
			}
			this.porticos = map;
		}
		return door.bankId !== undefined ? this.porticos.get(door.bankId) : undefined;
	}
}
