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
 *   - exactly ONE command is used per simulation tick, consumed or filled, never two (this is what makes a
 *     speedhack impossible: sending twice as many commands only fills the queue and raises `inputOverflow`, it
 *     never moves anyone faster);
 *   - a command whose seq is outside ±INPUT_SEQ_WINDOW of `lastSeq` (the last one consumed, jumped over or dropped)
 *     is refused (§8.1);
 *   - a command the server already CONSUMED (or jumped over, or dropped at the ceiling, see below) is refused as
 *     `late`: with the §2.2 redundancy every command arrives three times, so this is mostly the second and third
 *     copies;
 *   - a command already sitting in the queue is refused as `duplicate` (that is the §2.2 redundancy working);
 *   - out-of-order commands are inserted at the right place while they have not been consumed;
 *   - a gap at the head of the queue is a command that will never come (its three copies were lost): the head is
 *     consumed at once instead of waiting for it. The client never leaves a gap on purpose -- a hitch drops time,
 *     not numbers (client/net/commands.ts `dropBacklog`);
 *   - over INPUT_BUFFER_MAX the OLDEST are dropped and `inputOverflow` counts them. Their MOVEMENT is gone -- that
 *     is what caps a lag switch at INPUT_BUFFER_MAX ticks -- but their TAPS are carried to the commands still queued
 *     (`carryEdges`): a server hitch or a burst must not delete a shot, a reload or an E;
 *   - EXCEPT while the server itself is repaying ticks it owes: the ceiling is raised by `grace`, one command per
 *     tick the Heartbeat still has to run (server/sim/heartbeat.ts `grace`, at most INPUT_GRACE_MAX). A server hitch
 *     is repaid at two ticks a heartbeat, and each repaid tick consumes a command; the ones that landed during the
 *     hitch are exactly those, and capping them at INPUT_BUFFER_MAX threw them away and left every repaid tick to WAIT
 *     (the review of 2026-09-23: 3.91 waits a second, tools/test-input-buffer.mjs case 5). Only a debt that is being
 *     REPAID counts: a server that cannot keep up owes ticks it never runs, and granting them kept every queue as deep
 *     as the debt for good (the review of dee095a, B1: 352 ms from input to simulation at a 25 Hz heartbeat). Only
 *     the server's lateness raises it -- nothing a client sends does -- and it is still one command per tick, so a
 *     lag switch banks nothing it could spend faster than the world runs;
 *   - the packet itself passes a token bucket of INPUT_RATE/s with a burst of INPUT_BURST (§8.2);
 *   - after RESYNC_IDLE_TICKS filled ticks with an empty queue, a command AHEAD of the window re-anchors it instead
 *     of being refused for ever: an upstream outage longer than INPUT_SEQ_WINDOW ticks (the client kept numbering,
 *     every packet was lost) must not freeze the survivor out of its own session. Only AHEAD, never behind: see
 *     `enqueue`. It is still one command per tick, so it buys nothing.
 *
 * Empty queue: the tick WAITS. It is filled with the last command's aim and held buttons but `moveMag = 0` and
 * `edges = 0` — the survivor stands still and stays vulnerable (§9.1 "Lag switch: sem comandos o personagem fica
 * parado e vulnerável"), and no discrete action (attack press, reload) is ever replayed — and it spends NO
 * sequence number and acknowledges nothing. The real command that was late for it is not late at all: it enters
 * the queue when it lands and is consumed on the next tick, one tick later than planned.
 *
 * Why waiting and not "the fill takes the command's number" (the F1 rule until tools/test-input-buffer.mjs
 * measured it): a fill that spends the seq makes the real command arrive `late` and be thrown away, so the queue
 * cannot refill — the next tick fills again, the next real command is thrown away too, and a client that hitched
 * once (a long frame makes at most MAX_COMMANDS_PER_FRAME commands) locked into it: 30 filled ticks a second, the
 * body stopping in the world everyone else watches. That rule "cost one tick of smoothness the client's
 * prediction hides" — true only for the owner. Waiting instead makes every fill buy one tick of queue depth, so a
 * hitch costs the ticks it lasted and not one more; the extra depth is drained by the -2% dilation, and it can
 * never pass INPUT_BUFFER_MAX (plus the ticks a late SERVER is repaying, see `grace` above), which is also the most a lag
 * switch can bank. Coasting (repeating the last
 * movement) was rejected with it: coasting a tick and then consuming the real command late would move the body
 * twice for one command.
 *
 * A stall does not need the re-anchor: the server waited, and the client carries its numbering on through a stall
 * (it drops the backlog's time, not its numbers), so it resumes exactly where the server left it. Nor does a new
 * run: netReset comes with LeaveWorld + EnterWorld, i.e. a NEW ServerPlayer that bootstraps on its first command,
 * and the client's numbering carries on across the reset too (commands.ts `reset`), so even an in-flight packet of
 * the old run that bootstraps the new body is older than everything after it. So nothing honest ever lands BEHIND
 * the window: a command back there is a stale copy, and re-anchoring on it would simulate consumed commands a
 * second time and walk the ack backwards.
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
	INPUT_GRACE_MAX,
	INPUT_RATE,
	INPUT_SEQ_WINDOW,
	SIM_HZ,
} from "shared/net/mpConfig";
import { EDGE_MAX, EdgeShift, InputCommand, InputPacket, decodeInput, edgeCount, packEdges } from "shared/net/protocol";
import { PLAYER_RADIUS, circleBlocked } from "shared/game/physics";
import { PlayerState, createPlayer } from "shared/game/player";
import { PlayerSaveData, outfitLookOf, petLookOf, titleWireOf } from "shared/game/save";
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
	/** commands already consumed, jumped over or dropped at the ceiling: mostly the §2.2 redundant copies */
	late: number;
	/** commands dropped because the queue was over INPUT_BUFFER_MAX (§2.2, §9.1 speedhack signal) */
	inputOverflow: number;
	/** ticks that WAITED because the queue was empty (a client hitch, lost packets, a lag switch) */
	filled: number;
	/** times the window was re-anchored AHEAD, after an upstream outage longer than it (§2.2, see `enqueue`) */
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

/**
 * Commands whose view is remembered: every one the queue can hold (INPUT_BUFFER_MAX + INPUT_GRACE_MAX) plus the
 * redundancy's copies, so two commands in the queue never share a slot.
 */
const VIEW_RING = 32;

function newViewRing(fill: number): Array<number> {
	const out = new Array<number>();
	for (let i = 0; i < VIEW_RING; i++) out.push(fill);
	return out;
}

export interface ServerPlayer {
	/** 0..MAX_PLAYERS-1, stable for the whole session (§4.4) */
	slot: number;
	userId: number;
	name: string;
	/**
	 * The PROFILE — what the roster tells everybody about this survivor: the level on their plate, the outfit on
	 * their body and the pet at their heel (§4.4, MON-04). These three are what the others were LAST TOLD, not
	 * the save itself: `refreshProfile` compares them with the save and says when the roster has to be told again
	 * (server/net/replication.ts sends `PlayerProfile`). The looks are OutfitLook / PetLook numbers, already
	 * checked against what the server says this player owns.
	 */
	level: number;
	outfit: number;
	pet: number;
	/** MON-05: the title under their name, as the wire byte (0 = none), already checked against what they EARNED */
	title: number;
	/**
	 * MP-23, the match scoreboard: the day of this life and the zombies put down, as the others were LAST TOLD
	 * (`PlayerTally`). Like the profile above, `refreshTally` compares them with the save and says when to tell again.
	 */
	lifeDay: number;
	kills: number;
	/** the authoritative survivor; the client never sends a position (§2.2, MP-00) */
	state: PlayerState;
	/** the live save the server owns (server/main.server.ts session) */
	save: PlayerSaveData;
	/** pending commands, oldest first, at most INPUT_BUFFER_MAX (plus the server's grace while it owes ticks) */
	queue: Array<InputCommand>;
	/** false until the first accepted command: the client's first seq bootstraps `lastSeq` */
	started: boolean;
	/**
	 * the newest seq the queue is DONE with: consumed, jumped over, or dropped at the ceiling (a filled tick spends
	 * none). Anything not newer than this is late (§2.2)
	 */
	lastSeq: number;
	/**
	 * What the snapshot acknowledges: every command up to here is SETTLED -- the server simulated it or never
	 * will -- so the client may drop it from the replay. Normally that is the last command really simulated. When
	 * the window is (re-)anchored on a command `s`, the ack becomes `s - 1`, a command the server did NOT simulate:
	 * it means "everything before `s` is settled", which is exactly right -- whatever the client still holds from
	 * before `s` is never going to run, and replaying it would mispredict. It trails `lastSeq` after an overflow
	 * until the next command is consumed, so it only ever names a command that was simulated or skipped for good.
	 */
	ackSeq: number;
	/** last command applied (real or filled): the fill inherits its aim and held buttons */
	lastCmd: InputCommand;
	/** consecutive filled ticks since the last real command (the stall detector of `enqueue`) */
	idleFills: number;
	/**
	 * The snapshot tick the client said it was drawing, for the F2 rewind (§2.3): the view of the command THIS tick
	 * consumes (`takeCommand`), the frame that built it -- not the latest packet's, which is a queue's depth newer.
	 * Only a consumed command sets it: on a tick that waits it is still the last consumed command's, the one whose
	 * held trigger the fill repeats. It used to follow every packet between ticks, and a packet refused as late or
	 * out of the window still set it, so a held trigger on a filled tick fired in whatever view the latest (stale)
	 * packet named (the review of dee095a, N1).
	 */
	viewTick: number;
	viewFrac: number;
	/** the view each queued command was built under, by seq (a ring of VIEW_RING: seq, u16 tick, 1/256 fraction) */
	viewSeqs: Array<number>;
	viewTicks: Array<number>;
	viewFracs: Array<number>;
	/** ...and how many ticks had been taken when it landed, to measure its wait */
	viewTakes: Array<number>;
	/**
	 * Ticks the command this tick consumed waited in the queue: measured HERE, never claimed. It is part of how old
	 * an honest view is when its shot is judged, and the rewind ceiling counts it (server/sim/combat.ts).
	 */
	viewWait: number;
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

/**
 * Who is joining. The profile (level, outfit, pet, title) is NOT here on purpose: it is read off the save the server
 * owns, never handed in by a caller that could have taken it from the client (MON-04: the client never declares
 * what it owns).
 */
export interface ServerPlayerInfo {
	slot: number;
	userId: number;
	name: string;
}

/** spawn protection, in seconds (§7.1) */
export const SPAWN_SHIELD_S = 3;
/**
 * Filled ticks with an empty queue after which a command AHEAD of the sequence window re-anchors it (see
 * `enqueue`). 15 ticks = 250 ms at 60 Hz: far longer than any packet loss burst the §2.2 redundancy already
 * covers, and short enough that a player coming back from an upstream outage does not notice the recovery (an
 * outage long enough to leave the window, > 1 s, has already filled far more than this).
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
		level: save.level,
		outfit: outfitLookOf(save),
		pet: petLookOf(save),
		title: titleWireOf(save),
		lifeDay: save.day,
		kills: save.zombieKills,
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
		viewSeqs: newViewRing(-1),
		viewTicks: newViewRing(0),
		viewFracs: newViewRing(0),
		viewTakes: newViewRing(0),
		viewWait: 0,
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

/**
 * Hands the one-shot counters of a command the ceiling dropped to the commands still queued, oldest first. Each takes
 * what its own counters still hold (EDGE_MAX a kind: two bits, §2.2) and the rest moves on to the next: piled onto
 * the head alone they were capped at 3, and a hitch that drops a dozen commands at once -- a 250 ms one, or a
 * crawling repayment's grace taken back (server/sim/heartbeat.ts) -- lost the presses past the third
 * (tools/test-input-buffer.mjs case 16: 1075 of 1080 taps with the fixed ceiling).
 */
function carryEdges(edges: number, queue: Array<InputCommand>): void {
	let press = edgeCount(edges, EdgeShift.AttackPress);
	let release = edgeCount(edges, EdgeShift.AttackRelease);
	let action = edgeCount(edges, EdgeShift.ActionPress);
	let reload = edgeCount(edges, EdgeShift.Reload);
	for (let i = 0; i < queue.size() && press + release + action + reload > 0; i++) {
		const q = queue[i];
		const e = q.edges;
		const p = edgeCount(e, EdgeShift.AttackPress);
		const r = edgeCount(e, EdgeShift.AttackRelease);
		const a = edgeCount(e, EdgeShift.ActionPress);
		const l = edgeCount(e, EdgeShift.Reload);
		const tp = math.min(press, EDGE_MAX - p);
		const tr = math.min(release, EDGE_MAX - r);
		const ta = math.min(action, EDGE_MAX - a);
		const tl = math.min(reload, EDGE_MAX - l);
		if (tp + tr + ta + tl === 0) continue;
		press -= tp;
		release -= tr;
		action -= ta;
		reload -= tl;
		// in place: a queued command is the queue's own table (`acceptInput`), no new one per change
		q.edges = packEdges(p + tp, r + tr, a + ta, l + tl);
	}
}

/** one command into the queue (see the header); true when the queue took it -- not late, out of the window or a copy */
function enqueue(sp: ServerPlayer, cmd: InputCommand, grace: number): boolean {
	const seq = cmd.seq;
	if (sp.started) {
		const gap = seqDiff(seq, sp.lastSeq);
		// An upstream outage longer than INPUT_SEQ_WINDOW ticks (the client kept numbering while every packet was
		// lost) lands AHEAD of the window, and §8.1 would refuse every command from then on, freezing the survivor.
		// After RESYNC_IDLE_TICKS filled ticks with nothing queued, the window is re-anchored on it. This gives a
		// cheater nothing: the tick still consumes exactly one command, and the protocol has no position or dt.
		// Only AHEAD. Nothing honest lands behind the window: a stall carries the numbering on (commands.ts
		// `dropBacklog`), and a new run is a new ServerPlayer whose client carried its numbering on as well
		// (commands.ts `reset`). A command behind it is a stale copy -- say [100, 99, 98] held up in the network
		// while a forward re-anchor moved the window on -- and re-anchoring BACK on it simulated 98..100 a second
		// time and walked the ack backwards (the reviewer's reproduction; tools/test-server-sim.mjs case d).
		if (gap > INPUT_SEQ_WINDOW && sp.queue.size() === 0 && sp.idleFills >= RESYNC_IDLE_TICKS) {
			sp.started = false;
			sp.counters.resync += 1;
		}
	}
	if (!sp.started) {
		// The client's own numbering anchors the window: this command is the next one to consume. The ack names
		// the one before it -- never simulated, but settled: see `ackSeq`.
		sp.started = true;
		sp.lastSeq = wrapU16(seq - 1);
		sp.ackSeq = sp.lastSeq;
		sp.idleFills = 0;
	}
	const d = seqDiff(seq, sp.lastSeq);
	if (d > INPUT_SEQ_WINDOW || d < -INPUT_SEQ_WINDOW) {
		sp.counters.seqWindow += 1;
		return false;
	}
	if (d <= 0) {
		// already consumed (the second and third copies of the §2.2 redundancy), jumped over by a newer one when
		// it never came, or dropped at the ceiling; a FILLED tick never makes a command late, as it spends no seq
		sp.counters.late += 1;
		return false;
	}
	for (const q of sp.queue) {
		if (q.seq === seq) {
			sp.counters.duplicate += 1;
			return false;
		}
	}
	// insertion sort: the queue holds at most its ceiling + 3 entries for an instant
	sp.queue.push(cmd);
	let i = sp.queue.size() - 1;
	while (i > 0 && seqNewer(sp.queue[i - 1].seq, seq)) {
		sp.queue[i] = sp.queue[i - 1];
		i -= 1;
	}
	sp.queue[i] = cmd;
	while (sp.queue.size() > INPUT_BUFFER_MAX + grace) {
		const dropped = sp.queue.shift();
		if (dropped === undefined) break;
		sp.counters.inputOverflow += 1;
		// the queue is done with it: a later copy (the redundancy carries each command three times) must read as
		// late, not as a newcomer to queue -- and drop, and carry its taps -- a second time
		sp.lastSeq = dropped.seq;
		// Its MOVEMENT is gone: that is the ceiling, and what holds a lag switch to INPUT_BUFFER_MAX ticks of
		// banked movement. Its TAPS ride on in the new head instead. A tap is not movement the ceiling has to cap
		// (a shot still waits for the weapon's cadence, a reload or an E happens once however many presses carry
		// it), and dropping it is the one loss the player cannot be compensated for: a server hitch, or a burst
		// that lands on a full queue, must not eat a shot. tools/test-input-buffer.mjs case 5 lost 161 of 1080.
		if (dropped.edges !== 0) carryEdges(dropped.edges, sp.queue);
	}
	return true;
}

/**
 * Applies one decoded Input packet (§2.2: 1..3 commands, newest first). Call it only after the token bucket
 * accepted the packet. Never throws: every field of `packet` already went through decodeInput.
 *
 * The commands the queue takes become ITS tables: the ceiling hands a dropped command's taps on to the queued ones by
 * writing their `edges` (`carryEdges`). `ingestInput` passes the fresh tables `decodeInput` just made; a caller that
 * keeps its own commands (a test driving the queue directly) hands over copies.
 *
 * `grace` is the SERVER's (ServerSimulation.inputGrace): how many ticks of a debt it is repaying it owes right now
 * beyond the next one, each of which will consume a command. Clamped here as well, so no caller can open the
 * ceiling further.
 */
export function acceptInput(sp: ServerPlayer, packet: InputPacket, now: number, grace = 0): void {
	sp.counters.packets += 1;
	bumpWindow(sp.inputWindow, now, FLOOD_RATE_WINDOW_S);
	const room = grace > 0 && grace < math.huge ? math.min(math.floor(grace), INPUT_GRACE_MAX) : 0;
	const takes = sp.counters.consumed + sp.counters.filled;
	// oldest first, so the queue keeps its order with a single pass
	for (let i = packet.cmds.size() - 1; i >= 0; i--) {
		const cmd = packet.cmds[i];
		if (!enqueue(sp, cmd, room)) continue;
		/*
		 * The view of a command the queue TOOK: the packet names the frame of its NEWEST command, and that is the
		 * command it belongs to; a redundant copy that is taken fills in for a command whose own packet never came,
		 * one frame earlier per place. `takeCommand` hands the consumed command's view to the rewind (§2.3): the
		 * latest packet's was a queue's depth newer than the frame that pulled the trigger, and let a view declared
		 * for one shot be overwritten by the next packets before that shot was simulated.
		 *
		 * Only a command the queue took (the review of dee095a, N2). A command refused as out of the window shares
		 * its ring slot with a queued one 32 apart and overwrote that one's view; a copy of a command already queued
		 * re-declared its view after the fact.
		 */
		const slot = cmd.seq % VIEW_RING;
		sp.viewSeqs[slot] = cmd.seq;
		sp.viewTicks[slot] = wrapU16(packet.viewTick - i);
		sp.viewFracs[slot] = packet.viewFrac;
		sp.viewTakes[slot] = takes;
	}
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
export function ingestInput(sp: ServerPlayer, payload: unknown, now: number, grace = 0): InputVerdict {
	noteMessage(sp, now);
	if (!takeInputToken(sp, now)) return InputVerdict.Rate;
	const packet = decodeInput(payload);
	if (packet === undefined) {
		noteMalformed(sp, now);
		return InputVerdict.Malformed;
	}
	acceptInput(sp, packet, now, grace);
	return InputVerdict.Ok;
}

/**
 * The session's save table was REPLACED (an admin edit or a reload builds a new one in server/main.server.ts),
 * so the entity must follow it: `stepPlayer` reads the skill levels straight out of it every tick. The live
 * PlayerState is deliberately kept — F1 has no save mirror yet, and rebuilding it here would teleport the
 * survivor; the fields the save owns (level, hp cap) re-sync on the next spawn.
 *
 * The profile (level, outfit, pet, title) is deliberately NOT copied here: it is what the others were last told, and
 * copying it would make `refreshProfile` see no change and the allies would never hear of it. The replicator's
 * next pass notices the difference and tells everybody.
 */
export function adoptSave(sp: ServerPlayer, save: PlayerSaveData): boolean {
	if (sp.save === save) return false;
	sp.save = save;
	return true;
}

/**
 * Brings the profile the roster advertises (level, outfit, pet, title) up to date with the save, and answers whether
 * it moved — i.e. whether everybody has to be told (`PlayerProfile`, §4.4, MON-04, MON-05).
 *
 * Every path that changes those lands in the save: XP from a kill (server/sim/progress.ts), a client report after
 * the backpack equipped an outfit (server/main.server.ts, MP_PHASE 2), the `Equip` intent (F3), the wardrobe's
 * `equipTitle` (server/save/titles.ts), an admin edit, a new run. Watching the SAVE instead of each of those call
 * sites is what makes it impossible to add another path and forget to tell the others. The looks go through
 * `outfitLookOf` / `petLookOf` / `titleWireOf`, which check ownership again, so the wire can never carry a cosmetic
 * the server does not know this player owns, nor a title it does not know they earned.
 *
 * Cheap on purpose (four comparisons and three ownership lookups): the replicator calls it for every survivor
 * every time it flushes the reliable channel.
 */
export function refreshProfile(sp: ServerPlayer): boolean {
	const save = sp.save;
	const level = save.level;
	const outfit = outfitLookOf(save);
	const pet = petLookOf(save);
	const title = titleWireOf(save);
	if (level === sp.level && outfit === sp.outfit && pet === sp.pet && title === sp.title) return false;
	sp.level = level;
	sp.outfit = outfit;
	sp.pet = pet;
	sp.title = title;
	return true;
}

/**
 * (MP-23) Brings the scoreboard numbers the roster advertises (this life's day, the zombies put down) up to date with
 * the save the server owns, and answers whether they moved -- i.e. whether everybody has to be told (`PlayerTally`).
 *
 * The same idea as `refreshProfile`: every path that changes them writes the SAVE -- the midnight that credits a day
 * (server/sim/progress.ts), the kill credit (`zombieKilled`), a New game or a world that ended (`resetRun`), an admin
 * edit -- so watching the save is what makes it impossible to add a path and forget to tell the others. Both numbers
 * are the server's own: a client report never writes `zombieKills`, and from PROGRESS_SERVER_PHASE never the day.
 */
export function refreshTally(sp: ServerPlayer): boolean {
	const save = sp.save;
	const day = save.day;
	const kills = save.zombieKills;
	if (day === sp.lifeDay && kills === sp.kills) return false;
	sp.lifeDay = day;
	sp.kills = kills;
	return true;
}

/**
 * The one command this tick consumes (§2.2). Never returns more than one: the queue is the only thing a client
 * can grow, and growing it costs them `inputOverflow`, never speed.
 */
export function takeCommand(sp: ServerPlayer): InputCommand {
	const head = sp.queue[0];
	if (head !== undefined) {
		// the head may be ahead of lastSeq + 1: the commands in between never came, so there is nothing to wait for
		sp.queue.shift();
		sp.lastSeq = head.seq;
		sp.ackSeq = head.seq;
		// the frame that built this command is the view its shot is judged in (§2.3, `acceptInput`), and the
		// ticks it sat here are part of how old that view is by now
		const slot = head.seq % VIEW_RING;
		if (sp.viewSeqs[slot] === head.seq) {
			sp.viewTick = sp.viewTicks[slot];
			sp.viewFrac = sp.viewFracs[slot];
			// the ticks taken since it landed, plus the one it landed in: it may have come right after a tick
			sp.viewWait = math.max(0, sp.counters.consumed + sp.counters.filled - sp.viewTakes[slot]) + 1;
		} else {
			sp.viewWait = 0;
		}
		sp.lastCmd = head;
		sp.idleFills = 0;
		sp.counters.consumed += 1;
		return head;
	}
	if (!sp.started) {
		// nothing has ever arrived: stand still without moving the sequence window
		return STANDING;
	}
	// the queue is dry: this tick WAITS for the command (see the header). The fill carries no new seq, so
	// `lastSeq` and `ackSeq` stay put and the real command is still welcome when it lands. It repeats the last
	// command's held buttons, and a trigger held through it fires in that command's view: `viewTick` is left as the
	// last consumed command set it, whatever packets landed since (N1) -- a tick older now, which its wait counts
	sp.viewWait += 1;
	const fill: InputCommand = {
		seq: sp.lastSeq,
		moveAng: sp.lastCmd.moveAng,
		moveMag: 0,
		aim: sp.lastCmd.aim,
		held: sp.lastCmd.held,
		edges: 0,
	};
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
