//!native
/*
 * What the enemy simulation needs from the world it runs in (docs/MULTIPLAYER.md §3, §11.2).
 *
 * The AI used to read a client-side `GameRefs`: one survivor, one save, one day/night object, one camera to
 * shake. F2 moves it to the server, where there are up to six survivors with six saves, and the client keeps
 * running the very same code until the zombie replication of F2-2D lands (MP_PHASE < 2). So the behaviour is
 * written once, against THIS interface, and both sides supply it:
 *
 *   - the client (client/systems/zombieAI.ts) fills it from its GameRefs, with one flow field centred on the
 *     local survivor, and every `saveOf` answering the local save;
 *   - the server (server/sim/zombies.ts) fills it from the authoritative roster, with the multi-source flow
 *     field of §3.3 and each survivor's own save.
 *
 * Pure: no Instances, no services, no camera, no getCtx. Everything cosmetic goes out as an FxEvent.
 */
import { damageToPlayer, PlayerState } from "shared/game/player";
import { PlayerSaveData } from "shared/game/save";
import { WorldData } from "shared/game/world";
import { BossState, ZombieState } from "shared/game/entities";
import { Bullet } from "shared/game/bullets";
import { BloodSource, DebrisMaterial, FxEvent, TracerKind, WorldSound } from "shared/sim/types";
import * as Flank from "shared/sim/ai/flank";
import * as Sense from "shared/sim/ai/perception";

// ---------------------------------------------------------------- world objects the AI owns

/** spitter acid puddle on the ground: slows a survivor standing in it */
export interface Puddle {
	x: number;
	y: number;
	r: number;
	life: number;
	lifeMax: number;
}

/** expanding noise ring: the zombies it reaches go and look where it came from (shared/sim/ai/noise.ts) */
export interface SoundRing {
	x: number;
	y: number;
	r: number;
	rMax: number;
	/** a bang (shot, blast, construction): the front races out and slows down, like the original's shot ring */
	shot: boolean;
	/** which ring this is: a zombie hears each ring once (`ZombieState.heardRing`), 0 on an older caller */
	id?: number;
}

/** blast of a dead exploder: grows to rMax, hurting whoever the front passes over */
export interface Explosion {
	x: number;
	y: number;
	r: number;
	rMax: number;
	/** seconds the (already full-size) blast stays drawable */
	life: number;
}

// ---------------------------------------------------------------- navigation (§3.3)

/**
 * The chase field, as the AI queries it. The OWNER drives the rebuild (the client one window around the local
 * survivor, the server the multi-source tiles of §3.3); the AI only ever reads it, so neither side can make
 * the horde path differently by accident.
 */
export interface NavField extends Flank.PathField {
	/** heading (radians) to follow the gradient from (x, y), or undefined outside / at the target */
	heading(x: number, y: number): number | undefined;
	/**
	 * Index in `AiRefs.players` of the survivor this cell routes to — "the nearest one along a real path",
	 * which is not the nearest one in a straight line when a wall is in the way (§3.3 `targetOf`).
	 * -1 when the point is outside the field.
	 */
	targetOf(x: number, y: number): number;
}

// ---------------------------------------------------------------- the clock

/** what the AI and the population need from the day/night clock (client DayNight, server waves.ts) */
export interface AiClock {
	day: number;
	dayTime: number;
	/** 0 = full daylight, 1 = deepest night */
	darkAlpha: number;
	isNight: boolean;
	isRaining: boolean;
	/** the day's weather (shared/sim/weather.ts `Weather`; the server's, mirrored by the client) */
	weather: number;
	/** fog density now, 0..1 (LUZ-05): it shortens the eyes like the rain (perception.ts) */
	fog: number;
	/** what a noise carries now besides the rain: THUNDER_HEARING while a thunderclap rolls, else 1 (LUZ-05) */
	thunderMask: number;
	/** +1 every time the clock passes 7:00: non-wave zombies lose the trail then */
	morningCount: number;
	/**
	 * The original's "daytime without rain: noise is worth simulating" (sys_sound_view). The AI no longer asks:
	 * with no blanket night alert, a zombie hears day and night, and the rain only masks (shared/sim/ai/noise.ts).
	 */
	soundMatters(): boolean;
	/** night wave queues (walkers / specials) and which of the three is pouring right now */
	waveQueues: Array<number>;
	specialWaveQueues: Array<number>;
	wave1Active: boolean;
	wave2Active: boolean;
	wave3Active: boolean;
}

// ---------------------------------------------------------------- per-survivor bookkeeping

/** footsteps and velocity of one survivor (the spitter leads its target with it) */
export interface PlayerTrack {
	lastX?: number;
	lastY: number;
	vx: number;
	vy: number;
	walkAccum: number;
	walkTimer: number;
}

/**
 * State the horde carries between frames. It lives on the refs (one per simulated world) instead of in module
 * locals, so a client world and a server world never share a flow timer or a kill counter — and a test can run
 * two worlds side by side.
 */
export interface BrainState {
	/** frame counter used to stagger expensive per-zombie checks */
	frameNo: number;
	/** the world this state was built for; a different one resets everything */
	boundWorld?: WorldData;
	/** last `clock.morningCount` seen, so 7:00 clears the trail exactly once */
	seenMorning: number;
	/** zombies killed since the population director last looked */
	killCount: number;
	/** crowd map of the hunting zombies: the flanking probes price the busy lanes with it */
	crowd: Flank.Congestion;
	/** per survivor, in `players` order: how far each sense reaches for THAT survivor this frame (pooled) */
	senses: Array<Sense.SenseRanges>;
	/** per survivor, in `players` order: the light they carry or stand in this frame (pooled) */
	beacons: Array<Sense.Beacon>;
	/** id of the last noise ring emitted in this world */
	ringSeq: number;
	/**
	 * Is there a floor trap anywhere in this world, and the solids' signature it was counted at? Nearly every world
	 * has none, and then no zombie has to look under its feet every tick (a spatial query per body per tick).
	 */
	anyTrap: boolean;
	trapKey: number;
	/**
	 * Where this tick's pass over the horde starts: right after the last zombie the previous tick's rays reached, so
	 * the per-tick budgets (rays, shouts) are shared out round the whole horde instead of served to one end of it.
	 * -1: nobody was cut off, start with the newest.
	 */
	scanFrom: number;
	tracks: Map<PlayerState, PlayerTrack>;
}

export function newBrainState(): BrainState {
	return {
		frameNo: 0,
		seenMorning: -1,
		killCount: 0,
		crowd: new Flank.Congestion(),
		senses: new Array<Sense.SenseRanges>(),
		beacons: new Array<Sense.Beacon>(),
		ringSeq: 0,
		anyTrap: false,
		trapKey: -1,
		scanFrom: -1,
		tracks: new Map<PlayerState, PlayerTrack>(),
	};
}

// ---------------------------------------------------------------- the refs

/** the world the enemy simulation runs in; both the client loop and the server tick supply one */
export interface AiRefs {
	world: WorldData;
	/** every survivor in this world, in a stable order (the server: slot order) */
	players: Array<PlayerState>;
	zombies: Array<ZombieState>;
	bosses: Array<BossState>;
	bullets: Array<Bullet>;
	/** cosmetic effects the simulation asks for; the view (or the Fx channel) plays and clears them */
	fx: Array<FxEvent>;
	clock: AiClock;
	field: NavField;
	ai: BrainState;
	/**
	 * That survivor's save: armour, equipped light and skills are PER PERSON. The client answers the local
	 * save for everyone (it only ever simulates its own horde); the server answers each player's own.
	 */
	saveOf: (p: PlayerState) => PlayerSaveData;
	/** xp for a kill at (x, y); the server attributes it (§3.6), the client credits the local survivor */
	onExp: (amount: number, x: number, y: number) => void;
	/** a solid was added or removed by the simulation: the server marks the flow-field tile dirty (§3.3) */
	onSolidChanged?: (x: number, y: number, w: number, h: number) => void;
	/**
	 * A zombie is about to leave the world, at the position it is standing in right now. `killed` separates
	 * the two endings the client has to draw differently (§4.4 `ZombieDied`): hp reached 0 (blood, a corpse
	 * and a drop, exactly there) or the population recycled it far from everyone (nothing at all).
	 */
	onZombieGone?: (z: ZombieState, killed: boolean) => void;
	/**
	 * The population is about to MOVE this zombie across the map: a wave walker or a special that fell out of every
	 * survivor's spawn square, put back on the ring of the nearest one (shared/sim/ai/population.ts `cleanup`). Called
	 * while it still stands where it was. To the clients it is a different body from here on: the server gives it a new
	 * identity (server/sim/zombies.ts), so the old one leaves in silence where it stood and the new one fades in where it
	 * lands -- under its old netId every screen that still had it drew it racing across the town in one snapshot
	 * (docs/MULTIPLAYER.md §4.4, the owner's report of 2026-09-24, tools/test-zombie-motion.mjs (h)).
	 */
	onZombieMoved?: (z: ZombieState) => void;
	/**
	 * How a bite, a blast or a boss takes HP off a survivor (§2.3 "Dano em jogadores", MP-00).
	 *
	 * `damageToPlayer` deliberately becomes a no-op at MP_PHASE ≥ 2 (shared/game/player.ts), because a CLIENT
	 * must never decide how much HP anybody loses. The same brains run on the server, where the damage is
	 * legitimate, so the owner of the horde injects its own sink here (server/sim/combat.ts `damageSink`,
	 * which also records who hurt whom and emits the blood). Leave it undefined and the shared default
	 * applies, which is exactly the single-player game below phase 2.
	 */
	damagePlayer?: (p: PlayerState, save: PlayerSaveData, raw: number, bypassDef?: boolean) => boolean;
	puddles?: Array<Puddle>;
	sounds?: Array<SoundRing>;
	explosions?: Array<Explosion>;
	/**
	 * Lights that MOVE, lit at night like a lamp: a lamp drone escorting a survivor (server/sim/power.ts `lights`,
	 * ELE-05). A lamp on the ground is a solid and is found by the structure sweep; this is what is not a solid.
	 */
	carriedLights?: ReadonlyArray<{ x: number; y: number; r: number }>;
}

/**
 * The one place the enemy simulation is allowed to hurt a survivor. Routing every brain through it is what
 * lets the server own the damage without `damageToPlayer` having to tell a server apart from a client — a
 * gate with an exception is a gate with a hole.
 */
export function hurtPlayer(
	refs: AiRefs,
	p: PlayerState,
	save: PlayerSaveData,
	raw: number,
	bypassDef = false,
): boolean {
	const sink = refs.damagePlayer;
	if (sink !== undefined) return sink(p, save, raw, bypassDef);
	return damageToPlayer(p, save, raw, bypassDef);
}

// ---------------------------------------------------------------- helpers

export function actorDist(ax: number, ay: number, bx: number, by: number): number {
	const dx = ax - bx;
	const dy = ay - by;
	return math.sqrt(dx * dx + dy * dy);
}

/**
 * Index of the nearest living survivor to (x, y), or -1 when nobody is alive. The AI turns that index into a
 * PlayerState, a save and an Fx target, so it never has to search the array again.
 */
export function nearestPlayerIndex(refs: AiRefs, x: number, y: number): number {
	let best = -1;
	let bestD = math.huge;
	const players = refs.players;
	for (let i = 0; i < players.size(); i++) {
		const p = players[i];
		if (p.dead) continue;
		const dx = p.x - x;
		const dy = p.y - y;
		const d = dx * dx + dy * dy;
		if (d < bestD) {
			bestD = d;
			best = i;
		}
	}
	return best;
}

/**
 * Whom this zombie is hunting: the survivor the flow field routes its cell to ("nearest along a real path",
 * §3.3), falling back to the nearest one in a straight line when the field has no answer here.
 */
export function targetIndexFor(refs: AiRefs, x: number, y: number): number {
	const owned = refs.field.targetOf(x, y);
	if (owned >= 0) {
		const p = refs.players[owned];
		if (p !== undefined && !p.dead) return owned;
	}
	return nearestPlayerIndex(refs, x, y);
}

export function trackOf(refs: AiRefs, p: PlayerState): PlayerTrack {
	let t = refs.ai.tracks.get(p);
	if (t === undefined) {
		t = { lastY: 0, vx: 0, vy: 0, walkAccum: 0, walkTimer: 0 };
		refs.ai.tracks.set(p, t);
	}
	return t;
}

/** senses against nobody: what an index outside the roster answers */
const NO_SENSES: Sense.SenseRanges = { sight: 0, cone: 0, beam: 0, beamAngle: 0 };

/** how far each sense reaches against survivor `index` this frame (its light and Stealth skill are its own) */
export function sensesOf(refs: AiRefs, index: number): Sense.SenseRanges {
	return refs.ai.senses[index] ?? NO_SENSES;
}

// ---------------------------------------------------------------- cosmetic effects (§4.1 Fx)

/** shake the camera of the survivor at `player` (its index in refs.players = its slot on the server) */
export function fxShake(refs: AiRefs, player: number, magnitude: number, duration: number): void {
	if (player < 0) return;
	refs.fx.push({ kind: "shake", player, magnitude, duration });
}

/** blood spray; `dir` (radians) biases it away from the hit; big bursts (≥ 8) also leave a pool */
export function fxBlood(
	refs: AiRefs,
	x: number,
	y: number,
	count: number,
	source: BloodSource = "zombie",
	dir?: number,
): void {
	refs.fx.push({ kind: "blood", x, y, count, source, dir });
}

/** debris (wood chips, sparks, dust) */
export function fxDebris(refs: AiRefs, x: number, y: number, count: number, material: DebrisMaterial): void {
	refs.fx.push({ kind: "debris", x, y, count, material });
}

/** a shot line that fades over `life` seconds (it also lights the night briefly) */
export function fxTracer(
	refs: AiRefs,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	tracer: TracerKind,
	life: number,
): void {
	refs.fx.push({ kind: "tracer", x1, y1, x2, y2, tracer, life });
}

/** a sound the simulation decided, heard where it happened (P0-4: the bite; shared/net/fxWire.ts WIRE_SOUNDS) */
export function fxSound(refs: AiRefs, sound: WorldSound, x: number, y: number): void {
	refs.fx.push({ kind: "sound", sound, x, y });
}

/** HUD message for one survivor, or for everyone when `player` is undefined */
export function fxMessage(refs: AiRefs, text: string, player?: number): void {
	refs.fx.push({ kind: "message", text, player });
}
