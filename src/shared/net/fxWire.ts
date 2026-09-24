/*
 * The cosmetic effects of the simulation, on the wire (docs/MULTIPLAYER.md §4.1 "Fx", §4.2, §11.3 F2-2D).
 *
 * The horde and the bosses ask for effects in the vocabulary of the simulation (`shared/sim/types.ts`:
 * "blood", "debris", "shake", "tracer", "message"). The wire speaks the vocabulary of §4.2 (`FxType.*`).
 * Both directions of that translation live HERE, in one file, because the alternative is a pair of tables
 * that drift: the server writing material 3 for "structure" and the client reading 3 as "car" is a bug that
 * no test of either side alone can see.
 *
 * What does NOT travel:
 *   - `message`: HUD text is built from shared/data/lang.ts on the client (§4.5 `Announce` carries the id,
 *     not the string), so a simulation message has no place on this channel;
 *   - a survivor's own muzzle flash, kick and tracer: §2.5 leaves those to the client that fired
 *     (client/predict/weaponFx.ts), which is what makes shooting feel instant at 150 ms of RTT.
 *
 * Pure module: no Instances, no services. Both sides import it, so tools/ tests it in Node.
 */
import { BloodSource, DebrisMaterial, FxEvent as SimFx, TracerKind, WorldSound } from "shared/sim/types";
import { BloodKind, FxEvent as WireFx, FxType, TRACER_KIND_MAX } from "./protocol";
import { SLOT_NONE } from "./mpConfig";

/**
 * The sounds the SERVER decides (§4.2 `Sound`: a u8 id, a position and a volume), P0-4: id = index + 1, 0 is never
 * sent. APPEND ONLY -- an id is the wire contract between a server and every client of a different build. The client
 * plays each by its catalogue name (shared/data/sounds.ts), which is the same string.
 */
export const WIRE_SOUNDS: ReadonlyArray<WorldSound> = [
	"bite",
	"doorOpen",
	"doorClose",
	"ironDoorOpen",
	"ironDoorClose",
	"useEat",
	"useBandage",
	"useMedkit",
	"usePills",
	"useInject",
	"hornMoto",
	"bellBike",
];

/** the u8 a world sound travels as (1..WIRE_SOUNDS.size()) */
export function wireSoundId(sound: WorldSound): number {
	for (let i = 0; i < WIRE_SOUNDS.size(); i++) {
		if (WIRE_SOUNDS[i] === sound) return i + 1;
	}
	return 0;
}

/** the world sound of a wire id, or undefined for an id this build does not know (a newer server: stays silent) */
export function wireSoundOf(id: number): WorldSound | undefined {
	if (id < 1 || id !== math.floor(id)) return undefined;
	return WIRE_SOUNDS[id - 1];
}

/** debris material ids on the wire (the u8 of §4.2's Debris event); 0 is the fallback, never a hole */
const DEBRIS_IDS: ReadonlyArray<DebrisMaterial> = ["impact", "tree", "car", "structure", "exploder", "boss"];
/** tracer kind ids 1..TRACER_KIND_MAX, in the order of shared/sim/types.ts */
const TRACER_IDS: ReadonlyArray<TracerKind> = ["bullet", "electric", "boss"];

export function debrisMaterialId(material: DebrisMaterial): number {
	for (let i = 0; i < DEBRIS_IDS.size(); i++) {
		if (DEBRIS_IDS[i] === material) return i;
	}
	return 0;
}

export function debrisMaterialOf(id: number): DebrisMaterial {
	return DEBRIS_IDS[id] ?? "impact";
}

export function tracerKindId(kind: TracerKind): number {
	for (let i = 0; i < TRACER_IDS.size(); i++) {
		if (TRACER_IDS[i] === kind) return i + 1;
	}
	return 1;
}

export function tracerKindOf(id: number): TracerKind {
	return TRACER_IDS[math.clamp(id, 1, TRACER_KIND_MAX) - 1] ?? "bullet";
}

/** survivors bleed red, everything else green (LEG-02) */
export function bloodKindId(source: BloodSource): number {
	return source === "player" ? BloodKind.Red : BloodKind.Green;
}

export function bloodSourceOf(kind: number): BloodSource {
	return kind === BloodKind.Red ? "player" : "zombie";
}

/**
 * One simulation effect as the wire carries it, or undefined when it does not travel at all.
 *
 * `slotOf` turns the simulation's player INDEX (a position in `refs.players`) into the survivor's slot,
 * which is what §4.2 addresses: with slots 0 and 3 in the world, index 1 is slot 3. A shake for somebody who
 * is no longer in the world (SLOT_NONE) would shake nobody, so it is dropped here rather than encoded.
 */
export function toWireFx(e: SimFx, slotOf: (index: number) => number): WireFx | undefined {
	if (e.kind === "blood") {
		return {
			t: FxType.Blood,
			x: e.x,
			y: e.y,
			angle: e.dir ?? 0,
			amount: e.count,
			kind: bloodKindId(e.source),
		};
	}
	if (e.kind === "debris") {
		return {
			t: FxType.Debris,
			x: e.x,
			y: e.y,
			angle: 0,
			material: debrisMaterialId(e.material),
			count: e.count,
		};
	}
	if (e.kind === "shake") {
		const slot = slotOf(e.player);
		if (slot === SLOT_NONE) return undefined;
		return { t: FxType.Shake, slot, magnitude: e.magnitude, duration: e.duration };
	}
	if (e.kind === "tracer") {
		return {
			t: FxType.Tracer,
			x1: e.x1,
			y1: e.y1,
			x2: e.x2,
			y2: e.y2,
			kind: tracerKindId(e.tracer),
			life: e.life,
		};
	}
	if (e.kind === "sound") {
		const id = wireSoundId(e.sound);
		if (id === 0) return undefined;
		return { t: FxType.Sound, sound: id, x: e.x, y: e.y, volume: 1 };
	}
	// "message": the client writes its own HUD text (§4.5 Announce)
	return undefined;
}

/**
 * The reverse, for the effects that have a simulation shape: the client hands these straight to the view it
 * already had (particles, camera shake, tracers), so a bite looks the same whether it was simulated here
 * (MP_PHASE < 2) or received (≥ 2). The events with no simulation shape — a shot, a projectile, an explosion,
 * a solid being struck — are played by client/view/fxView.ts from the wire event itself.
 */
export function fromWireFx(e: WireFx): SimFx | undefined {
	if (e.t === FxType.Blood) {
		return { kind: "blood", x: e.x, y: e.y, count: e.amount, source: bloodSourceOf(e.kind), dir: e.angle };
	}
	if (e.t === FxType.Debris) {
		return { kind: "debris", x: e.x, y: e.y, count: e.count, material: debrisMaterialOf(e.material) };
	}
	if (e.t === FxType.Tracer) {
		return {
			kind: "tracer",
			x1: e.x1,
			y1: e.y1,
			x2: e.x2,
			y2: e.y2,
			tracer: tracerKindOf(e.kind),
			life: e.life,
		};
	}
	if (e.t === FxType.Sound) {
		const sound = wireSoundOf(e.sound);
		if (sound === undefined) return undefined;
		return { kind: "sound", sound, x: e.x, y: e.y };
	}
	return undefined;
}

/**
 * Where an effect happens, for the interest filter of §4.3 — the wire must not tell a client about a fight
 * it cannot see. A `Shake` has no position: it is addressed to one survivor and only ever sent to them, so
 * it answers false and the caller routes it by slot instead. The position goes into `out` (no table per event per
 * viewer: server/net/replication.ts asks once per event and tick).
 */
export function fxPosition(e: WireFx, out: { x: number; y: number }): boolean {
	if (e.t === FxType.Shake) return false;
	if (e.t === FxType.SolidShake) return false;
	if (e.t === FxType.Shot) {
		const hits = e.hits;
		if (hits.size() === 0) return false;
		out.x = hits[0].x;
		out.y = hits[0].y;
		return true;
	}
	if (e.t === FxType.Tracer) {
		out.x = e.x1;
		out.y = e.y1;
		return true;
	}
	out.x = e.x;
	out.y = e.y;
	return true;
}

/** the survivor a `Shake` belongs to, or SLOT_NONE for every other event */
export function fxSlot(e: WireFx): number {
	return e.t === FxType.Shake ? e.slot : SLOT_NONE;
}
