/*
 * Server-side survivors: the authoritative entity, the per-player input queue and the safe spawn point
 * (docs/MULTIPLAYER.md §2.2, §7.1, §8.1, §8.2; DESIGN_RULES MP-00, MP-04).
 *
 * Pure module: no Instances, no services, no os.clock — every function that needs a clock takes `now` as an
 * argument. That is what lets the server simulation run in Node (tools/test-server-sim.mjs) against the very
 * same code the live server runs.
 *
 * Input queue rules (§2.2), all enforced here:
 *   - target depth INPUT_BUFFER_TARGET (2), hard maximum INPUT_BUFFER_MAX (4);
 *   - exactly ONE command is consumed per simulation tick (this is what makes a speedhack impossible: sending
 *     twice as many commands only fills the queue and raises `inputOverflow`, it never moves anyone faster);
 *   - a command whose seq is outside ±INPUT_SEQ_WINDOW of the last consumed one is refused (§8.1);
 *   - a command for a tick the server already simulated (consumed OR filled) is refused as `late`;
 *   - a command already sitting in the queue is refused as `duplicate` (that is the §2.2 redundancy working);
 *   - out-of-order commands are inserted at the right place while they have not been consumed;
 *   - over INPUT_BUFFER_MAX the OLDEST are dropped and `inputOverflow` counts them;
 *   - the packet itself passes a token bucket of INPUT_RATE/s with a burst of INPUT_BURST (§8.2);
 *   - after RESYNC_IDLE_TICKS filled ticks with an empty queue, a stale command RE-ANCHORS the window instead
 *     of being refused for ever: a client that stalled (alt-tab, a hitch) keeps its own numbering, and the
 *     server must not freeze it out of its own session. It is still one command per tick, so it buys nothing.
 *
 * Empty queue (author's decision for F1, documented): the tick is FILLED with the last command's aim and held
 * buttons but `moveMag = 0` and `edges = 0` — the survivor stands still and stays vulnerable (§9.1 "Lag switch:
 * sem comandos o personagem fica parado e vulnerável"), and no discrete action (attack press, reload) is ever
 * replayed. §2.2 also allows coasting one tick on the last movement before stopping; standing still from the
 * first missed tick is the stricter of the two and costs at most one tick of smoothness on a lost packet, which
 * the client's own prediction hides. The filled slot advances `lastSeq`, so the real command for that tick is
 * discarded when it finally arrives (§2.2).
 */
import { dequantAngle8, seqDiff, seqNewer, wrapU16 } from "shared/net/codec";
import {
	FLOOD_MALFORMED,
	FLOOD_MALFORMED_WINDOW_S,
	FLOOD_MESSAGES,
	FLOOD_MESSAGES_WINDOW_S,
	FLOOD_RATE_MULT,
	FLOOD_RATE_WINDOW_S,
	INPUT_BUFFER_MAX,
	INPUT_BURST,
	INPUT_RATE,
	INPUT_SEQ_WINDOW,
	SIM_HZ,
} from "shared/net/mpConfig";
import { InputCommand, InputPacket, decodeInput } from "shared/net/protocol";
import { PLAYER_RADIUS, circleBlocked } from "shared/game/physics";
import { PlayerState, createPlayer } from "shared/game/player";
import { PlayerSaveData } from "shared/game/save";
import { WorldData, buildingAt, isOnRoad, randomOpenPoint, randomRingPoint, rectHitsSolid } from "shared/game/world";
import { WORLD_MARGIN } from "shared/sim/playerMove";

// ---------------------------------------------------------------- counters (§8, F6 admin panel)

/** per-player anomaly counters; they only ever grow, the panel reads deltas (§9.3) */
export interface InputCounters {
	/** Input packets refused by the token bucket (§8.2) */
	rateDropped: number;
	/** payloads decodeInput refused: wrong length, bad count, reserved bits (§8.1) */
	malformed: number;
	/** commands whose seq was outside ±INPUT_SEQ_WINDOW of the last consumed one (§8.1) */
	seqWindow: number;
	/** commands already queued — the §2.2 redundancy doing its job, not an anomaly on its own */
	duplicate: number;
	/** commands for a tick the server already simulated (consumed or filled) */
	late: number;
	/** commands dropped because the queue was over INPUT_BUFFER_MAX (§2.2, §9.1 speedhack signal) */
	inputOverflow: number;
	/** ticks filled because the queue was empty (lost packets, or a lag switch) */
	filled: number;
	/** times the sequence window had to be re-anchored after a client stall (§2.2, see `enqueue`) */
	resync: number;
	/** commands actually consumed by the simulation */
	consumed: number;
	/** Input packets accepted */
	packets: number;
}

function newCounters(): InputCounters {
	return {
		rateDropped: 0,
		malformed: 0,
		seqWindow: 0,
		duplicate: 0,
		late: 0,
		inputOverflow: 0,
		filled: 0,
		resync: 0,
		consumed: 0,
		packets: 0,
	};
}

/** fixed-window counter: cheap, and an over-count only ever delays a flood detection by one window */
interface RateWindow {
	start: number;
	count: number;
}

function newWindow(): RateWindow {
	return { start: 0, count: 0 };
}

function bumpWindow(w: RateWindow, now: number, span: number): number {
	if (now - w.start >= span || now < w.start) {
		w.start = now;
		w.count = 0;
	}
	w.count += 1;
	return w.count;
}

// ---------------------------------------------------------------- the entity

const STANDING: InputCommand = { seq: 0, moveAng: 0, moveMag: 0, aim: 0, held: 0, edges: 0 };

export interface ServerPlayer {
	/** 0..MAX_PLAYERS-1, stable for the whole session (§4.4) */
	slot: number;
	userId: number;
	name: string;
	level: number;
	costume: number;
	deco: number;
	/** the authoritative survivor; the client never sends a position (§2.2, MP-00) */
	state: PlayerState;
	/** the live save the server owns (server/main.server.ts session) */
	save: PlayerSaveData;
	/** pending commands, oldest first, at most INPUT_BUFFER_MAX */
	queue: Array<InputCommand>;
	/** false until the first accepted command: the client's first seq bootstraps `lastSeq` */
	started: boolean;
	/** last seq consumed OR filled; anything not newer than this is late (§2.2) */
	lastSeq: number;
	/** last REAL command consumed — what the snapshot acknowledges (filled ticks do not ack) */
	ackSeq: number;
	/** last command applied (real or filled): the fill inherits its aim and held buttons */
	lastCmd: InputCommand;
	/** consecutive filled ticks since the last real command (the stall detector of `enqueue`) */
	idleFills: number;
	/** the snapshot tick the client said it was drawing, for the F2 rewind (§2.3) */
	viewTick: number;
	viewFrac: number;
	/** token bucket (§8.2) */
	tokens: number;
	tokenAt: number;
	counters: InputCounters;
	/** flood windows (§8.2) */
	inputWindow: RateWindow;
	messageWindow: RateWindow;
	malformedWindow: RateWindow;
	/** view state derived from the last step, for the other players' snapshot block (§4.2) */
	walking: boolean;
	/** feet direction in radians; keeps the last walked direction while standing */
	moveAng: number;
	/** simulation tick the spawn protection ends at (§7.1: 3 s) */
	spawnShieldUntil: number;
	/** tick the survivor entered the world */
	joinTick: number;
}

export interface ServerPlayerInfo {
	slot: number;
	userId: number;
	name: string;
	level?: number;
	costume?: number;
	deco?: number;
}

/** spawn protection, in seconds (§7.1) */
export const SPAWN_SHIELD_S = 3;
/**
 * Filled ticks with an empty queue after which a stale command re-anchors the sequence window (see `enqueue`).
 * 15 ticks = 250 ms at 60 Hz: far longer than any packet loss burst the §2.2 redundancy already covers, and
 * short enough that a player coming back from a stall does not notice the recovery.
 */
export const RESYNC_IDLE_TICKS = 15;

export function createServerPlayer(
	info: ServerPlayerInfo,
	save: PlayerSaveData,
	x: number,
	y: number,
	tick: number,
	simHz = SIM_HZ,
): ServerPlayer {
	return {
		slot: info.slot,
		userId: info.userId,
		name: info.name,
		level: info.level ?? save.level,
		costume: info.costume ?? math.max(0, save.equipCloth),
		deco: info.deco ?? math.max(0, save.equipDeco),
		state: createPlayer(save, x, y),
		save,
		queue: new Array<InputCommand>(),
		started: false,
		lastSeq: 0,
		ackSeq: 0,
		lastCmd: STANDING,
		idleFills: 0,
		viewTick: 0,
		viewFrac: 0,
		tokens: INPUT_BURST,
		tokenAt: 0,
		counters: newCounters(),
		inputWindow: newWindow(),
		messageWindow: newWindow(),
		malformedWindow: newWindow(),
		walking: false,
		moveAng: 0,
		spawnShieldUntil: tick + math.floor(SPAWN_SHIELD_S * simHz),
		joinTick: tick,
	};
}

// ---------------------------------------------------------------- rate limiting and flood (§8.2)

/** one Input packet against the token bucket: false = drop it and count it */
export function takeInputToken(sp: ServerPlayer, now: number): boolean {
	const elapsed = now - sp.tokenAt;
	if (elapsed > 0) {
		sp.tokens = math.min(INPUT_BURST, sp.tokens + elapsed * INPUT_RATE);
		sp.tokenAt = now;
	} else if (elapsed < 0) {
		// the clock went backwards (should not happen with os.clock): restart the bucket rather than stall
		sp.tokenAt = now;
	}
	if (sp.tokens < 1) {
		sp.counters.rateDropped += 1;
		return false;
	}
	sp.tokens -= 1;
	return true;
}

/** counted for every message this player sends on any MP channel, valid or not (§8.2) */
export function noteMessage(sp: ServerPlayer, now: number): void {
	bumpWindow(sp.messageWindow, now, FLOOD_MESSAGES_WINDOW_S);
}

export function noteMalformed(sp: ServerPlayer, now: number): void {
	sp.counters.malformed += 1;
	bumpWindow(sp.malformedWindow, now, FLOOD_MALFORMED_WINDOW_S);
}

/** the reason for an automatic kick (§8.2, §9.2 level 2), or undefined while the player is within the limits */
export function floodReason(sp: ServerPlayer): string | undefined {
	if (sp.messageWindow.count > FLOOD_MESSAGES) {
		return `${sp.messageWindow.count} messages in ${FLOOD_MESSAGES_WINDOW_S}s`;
	}
	if (sp.malformedWindow.count > FLOOD_MALFORMED) {
		return `${sp.malformedWindow.count} malformed payloads in ${FLOOD_MALFORMED_WINDOW_S}s`;
	}
	if (sp.inputWindow.count > INPUT_RATE * FLOOD_RATE_MULT * FLOOD_RATE_WINDOW_S) {
		return `${sp.inputWindow.count} Input packets in ${FLOOD_RATE_WINDOW_S}s`;
	}
	return undefined;
}

// ---------------------------------------------------------------- the input queue (§2.2)

function enqueue(sp: ServerPlayer, cmd: InputCommand): void {
	const seq = cmd.seq;
	if (sp.started) {
		const gap = seqDiff(seq, sp.lastSeq);
		const stale = gap <= 0 || gap > INPUT_SEQ_WINDOW || gap < -INPUT_SEQ_WINDOW;
		// A client that STALLS (alt-tab, a long hitch, a breakpoint) stops numbering while the server keeps
		// filling its ticks, so when it comes back every command it sends is behind `lastSeq` — and would be
		// refused as late forever, freezing the survivor. After RESYNC_IDLE_TICKS filled ticks with nothing
		// queued, the stream is re-anchored on whatever numbering the client is using now. This gives a cheater
		// nothing: the tick still consumes exactly one command, and the protocol has no position or dt.
		if (stale && sp.queue.size() === 0 && sp.idleFills >= RESYNC_IDLE_TICKS) {
			sp.started = false;
			sp.counters.resync += 1;
		}
	}
	if (!sp.started) {
		// the client's own numbering bootstraps the window: the first command is the next one to consume
		sp.started = true;
		sp.lastSeq = wrapU16(seq - 1);
		sp.ackSeq = sp.lastSeq;
		sp.idleFills = 0;
	}
	const d = seqDiff(seq, sp.lastSeq);
	if (d > INPUT_SEQ_WINDOW || d < -INPUT_SEQ_WINDOW) {
		sp.counters.seqWindow += 1;
		return;
	}
	if (d <= 0) {
		// already consumed, or the slot was filled while it was in flight (§2.2)
		sp.counters.late += 1;
		return;
	}
	for (const q of sp.queue) {
		if (q.seq === seq) {
			sp.counters.duplicate += 1;
			return;
		}
	}
	// insertion sort: the queue holds at most INPUT_BUFFER_MAX + 3 entries for an instant
	sp.queue.push(cmd);
	let i = sp.queue.size() - 1;
	while (i > 0 && seqNewer(sp.queue[i - 1].seq, seq)) {
		sp.queue[i] = sp.queue[i - 1];
		i -= 1;
	}
	sp.queue[i] = cmd;
	while (sp.queue.size() > INPUT_BUFFER_MAX) {
		sp.queue.shift();
		sp.counters.inputOverflow += 1;
	}
}

/**
 * Applies one decoded Input packet (§2.2: 1..3 commands, newest first). Call it only after the token bucket
 * accepted the packet. Never throws: every field of `packet` already went through decodeInput.
 */
export function acceptInput(sp: ServerPlayer, packet: InputPacket, now: number): void {
	sp.counters.packets += 1;
	bumpWindow(sp.inputWindow, now, FLOOD_RATE_WINDOW_S);
	sp.viewTick = packet.viewTick;
	sp.viewFrac = packet.viewFrac;
	// oldest first, so the queue keeps its order with a single pass
	for (let i = packet.cmds.size() - 1; i >= 0; i--) enqueue(sp, packet.cmds[i]);
}

/** what one raw Input payload did (§8.1); the Roblox layer only decides whether to kick on top of this */
export const InputVerdict = {
	/** decoded and queued */
	Ok: 0,
	/** the token bucket refused the packet (§8.2) */
	Rate: 1,
	/** decodeInput refused the payload: wrong type, length, count or reserved bits (§8.1) */
	Malformed: 2,
} as const;
export type InputVerdict = (typeof InputVerdict)[keyof typeof InputVerdict];

/**
 * The whole C→S path for one Input payload, with NO Roblox in it: count the message, take a token, decode and
 * queue. `payload` is whatever the remote handed over — a string, a table, a number, a truncated buffer, a
 * 1000 byte blob of noise — and this NEVER throws: `decodeInput` answers `undefined` for anything that is not
 * exactly 4 + 8n bytes of well-formed commands (§8.1), and that is counted as malformed (§8.3).
 *
 * The caller (server/net/mpHost.ts) calls `floodReason` afterwards and kicks when it answers (§8.2).
 */
export function ingestInput(sp: ServerPlayer, payload: unknown, now: number): InputVerdict {
	noteMessage(sp, now);
	if (!takeInputToken(sp, now)) return InputVerdict.Rate;
	const packet = decodeInput(payload);
	if (packet === undefined) {
		noteMalformed(sp, now);
		return InputVerdict.Malformed;
	}
	acceptInput(sp, packet, now);
	return InputVerdict.Ok;
}

/**
 * The session's save table was REPLACED (an admin edit or a reload builds a new one in server/main.server.ts),
 * so the entity must follow it: `stepPlayer` reads the skill levels straight out of it every tick. The live
 * PlayerState is deliberately kept — F1 has no save mirror yet, and rebuilding it here would teleport the
 * survivor; the fields the save owns (level, hp cap) re-sync on the next spawn.
 */
export function adoptSave(sp: ServerPlayer, save: PlayerSaveData): boolean {
	if (sp.save === save) return false;
	sp.save = save;
	sp.level = save.level;
	return true;
}

/**
 * The one command this tick consumes (§2.2). Never returns more than one: the queue is the only thing a client
 * can grow, and growing it costs them `inputOverflow`, never speed.
 */
export function takeCommand(sp: ServerPlayer): InputCommand {
	const head = sp.queue[0];
	if (head !== undefined) {
		sp.queue.shift();
		sp.lastSeq = head.seq;
		sp.ackSeq = head.seq;
		sp.lastCmd = head;
		sp.idleFills = 0;
		sp.counters.consumed += 1;
		return head;
	}
	if (!sp.started) {
		// nothing has ever arrived: stand still without moving the sequence window
		return STANDING;
	}
	const fill: InputCommand = {
		seq: wrapU16(sp.lastSeq + 1),
		moveAng: sp.lastCmd.moveAng,
		moveMag: 0,
		aim: sp.lastCmd.aim,
		held: sp.lastCmd.held,
		edges: 0,
	};
	sp.lastSeq = fill.seq;
	sp.lastCmd = fill;
	sp.idleFills += 1;
	sp.counters.filled += 1;
	return fill;
}

/** queue depth the snapshot reports, so the client can dilate its sampling rate by ±2% (§2.2) */
export function bufferDepth(sp: ServerPlayer): number {
	return math.min(255, sp.queue.size());
}

/** feet direction bookkeeping after a step: keeps the last walked direction while standing */
export function noteStep(sp: ServerPlayer, cmd: InputCommand, walking: boolean): void {
	sp.walking = walking;
	if (cmd.moveMag > 0) sp.moveAng = dequantAngle8(cmd.moveAng);
}

// ---------------------------------------------------------------- safe spawn point (MP-04, §7.1)

export interface SpawnPoint {
	x: number;
	y: number;
	/** the ≥ 900 u rule had to be relaxed to `relaxedZombieDist` (§7.1, after `attempts` tries) */
	relaxed: boolean;
}

export interface SpawnQuery {
	/** standing allies: the spawn prefers a 150–400 u ring around one of them (§7.1 a) */
	allies?: ReadonlyArray<{ x: number; y: number }>;
	/** live zombies; empty in F1, where zombies are still local to each client */
	zombies?: ReadonlyArray<{ x: number; y: number }>;
	/** MP-04: never closer than this to a zombie */
	minZombieDist?: number;
	/** relaxed limit once `attempts` candidates failed (§7.1) */
	relaxedZombieDist?: number;
	attempts?: number;
}

/** MP-04 minimum distance from any live zombie */
export const SPAWN_MIN_ZOMBIE = 900;
/** the relaxed limit §7.1 falls back to */
export const SPAWN_RELAXED_ZOMBIE = 600;
/** §7.1: ring around a standing ally */
export const SPAWN_ALLY_MIN = 150;
export const SPAWN_ALLY_MAX = 400;
/** §7.1: "círculo livre de 40 u (rectHitsSolid 80×80)" */
export const SPAWN_CLEAR_BOX = 80;
const SPAWN_ATTEMPTS = 200;

function inBounds(world: WorldData, x: number, y: number): boolean {
	return (
		x >= WORLD_MARGIN && y >= WORLD_MARGIN && x <= world.width - WORLD_MARGIN && y <= world.height - WORLD_MARGIN
	);
}

/** MP-04: outside any building, on free ground, and far enough from every zombie */
export function spawnPointOk(
	world: WorldData,
	x: number,
	y: number,
	zombies: ReadonlyArray<{ x: number; y: number }>,
	minZombieDist: number,
): boolean {
	if (!inBounds(world, x, y)) return false;
	if (buildingAt(world, x, y) !== undefined) return false;
	if (rectHitsSolid(world, x, y, SPAWN_CLEAR_BOX, SPAWN_CLEAR_BOX) !== undefined) return false;
	if (circleBlocked(world, x, y, PLAYER_RADIUS + 2) !== undefined) return false;
	const min2 = minZombieDist * minZombieDist;
	for (const z of zombies) {
		const dx = z.x - x;
		const dy = z.y - y;
		if (dx * dx + dy * dy < min2) return false;
	}
	return true;
}

/**
 * A safe place to enter the world (§7.1, MP-04): a ring around a standing ally when there is one, otherwise a
 * street near the centre of town (the same rule the single-player loop used). Falls back to the relaxed zombie
 * distance, and finally to the least bad candidate, so this never fails to return a point.
 */
export function findSpawnPoint(world: WorldData, query: SpawnQuery = {}): SpawnPoint {
	const allies = query.allies ?? [];
	const zombies = query.zombies ?? [];
	const strict = query.minZombieDist ?? SPAWN_MIN_ZOMBIE;
	const relaxedDist = query.relaxedZombieDist ?? SPAWN_RELAXED_ZOMBIE;
	const attempts = query.attempts ?? SPAWN_ATTEMPTS;
	const cx = world.width / 2;
	const cy = world.height / 2;

	for (let pass = 0; pass < 2; pass++) {
		const minDist = pass === 0 ? strict : relaxedDist;
		for (let i = 0; i < attempts; i++) {
			let x: number;
			let y: number;
			if (allies.size() > 0) {
				const ally = allies[i % allies.size()];
				const p = randomRingPoint(ally.x, ally.y, SPAWN_ALLY_MIN, SPAWN_ALLY_MAX);
				x = p.x;
				y = p.y;
			} else {
				const p = randomOpenPoint(world, cx - 1400, cy - 1400, cx + 1400, cy + 1400);
				x = p.x;
				y = p.y;
				// like the single-player spawn: prefer a street for the first half of the attempts
				if (i < attempts / 2 && !isOnRoad(world, x, y)) continue;
			}
			if (spawnPointOk(world, x, y, zombies, minDist)) return { x, y, relaxed: pass > 0 };
		}
		if (relaxedDist >= strict) break;
	}
	// last resort: free ground near the centre, ignoring the zombie distance (logged by the caller)
	const p = randomOpenPoint(world, cx - 800, cy - 800, cx + 800, cy + 800);
	return { x: p.x, y: p.y, relaxed: true };
}
