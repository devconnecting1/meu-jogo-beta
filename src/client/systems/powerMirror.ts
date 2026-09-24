/*
 * The client's copy of the electric grid (docs/DESIGN_RULES.md ELE-01..ELE-08, docs/MULTIPLAYER.md §4.5 `PowerSet`).
 *
 * The grid is the server's (server/sim/power.ts); a client only DRAWS it. What it needs to draw is small and arrives
 * on a change: per machine, whether it is working, the level of its store and, for a drone in the air, the survivor
 * it escorts. `applyPowerSet` keeps that, keyed by the construction's id, and mirrors the working bit into
 * `Solid.powered` for everything that is not a drone — the one flag the client already reads (a lit lamp in the
 * light map, a working cooker as cooking heat), so nothing else has to learn about power.
 *
 * Until the server owns the constructions (F3) nothing arrives here, and every machine is drawn as the client's own
 * world has it: unpowered.
 *
 * No Instances, nothing per frame: a solid is looked up by id through a small index rebuilt only when a lookup misses.
 */
import { machineOf, powerWorking } from "shared/data/power";
import { SLOT_NONE } from "shared/net/mpConfig";
import { Solid, WorldData } from "shared/game/world";
import { WPowerSet } from "shared/net/protocol";

/** what the server last said about one machine */
export interface MirroredPower {
	/** shared/data/power.ts PowerBit */
	state: number;
	/** the slot a drone in the air escorts, else SLOT_NONE */
	pilot: number;
}

const byId = new Map<number, MirroredPower>();
/** solids by id, for the constructions only (dynamic ids); rebuilt when a lookup misses */
const solids = new Map<number, Solid>();
let indexed: WorldData | undefined;

function solidOf(world: WorldData, id: number): Solid | undefined {
	if (indexed === world) {
		const hit = solids.get(id);
		if (hit !== undefined && hit.removed !== true) return hit;
	}
	solids.clear();
	indexed = world;
	for (const s of world.solids) {
		if (s.placeable !== undefined || machineOf(s) !== undefined) solids.set(s.id, s);
	}
	return solids.get(id);
}

/** one `PowerSet` from the server (client/net/netClient.ts) */
export function applyPowerSet(world: WorldData | undefined, e: WPowerSet): void {
	let m = byId.get(e.id);
	if (m === undefined) {
		m = { state: e.state, pilot: e.pilot };
		byId.set(e.id, m);
	} else {
		m.state = e.state;
		m.pilot = e.pilot;
	}
	if (world === undefined) return;
	const s = solidOf(world, e.id);
	if (s === undefined) return;
	// a drone's pad never lights anything: the drone does, where it flies (client/view/machinesView.ts)
	if (machineOf(s)?.role === "drone") return;
	s.powered = powerWorking(e.state);
}

/** what the server last said about the machine with this id, or undefined (never heard of: drawn unpowered) */
export function mirroredPower(id: number): MirroredPower | undefined {
	return byId.get(id);
}

/** the drone with this id is in the air, escorting `pilot` (SLOT_NONE: on its pad) */
export function mirroredPilot(id: number): number {
	return byId.get(id)?.pilot ?? SLOT_NONE;
}

/** a new town, or the client left the world: what was heard belongs to the old one */
export function resetPowerMirror(): void {
	byId.clear();
	solids.clear();
	indexed = undefined;
}
