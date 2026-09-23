/*
 * Client side of the server-authoritative session (docs/MULTIPLAYER.md §2.2, §4, §5).
 *
 * This file is the only one of the F1 client front that touches Roblox. It owns the remotes, the handshake and the
 * frame order, and hands everything that can be reasoned about to the four pure modules next to it:
 *
 *   clockSync.ts       which server tick this client is living in (§4.6)
 *   commands.ts        local input → the 60 Hz stream of quantised commands, with redundancy and dilation (§2.2)
 *   prediction.ts      predict the local survivor, reconcile with the last ack, bleed the error off (§2.2, §5.2)
 *   snapshotBuffer.ts  reassemble snapshots and interpolate everyone else for the render time (§4.4, §5.1)
 *
 * The seam the game loop sees is a handful of functions and nothing else:
 *
 *   netActive()            is this client in a server-simulated session?
 *   netUpdate(refs, dt)    once per frame: sample input into 60 Hz commands, send them (with redundancy), predict
 *                          the local survivor into refs.player, reconcile with the last ack, advance the
 *                          interpolation of everyone else, and apply the world deltas that arrived
 *   remotePlayers()        the other survivors, interpolated for the current render time
 *   remoteZombies()        the horde, interpolated: from F2 the client draws it and simulates none of it
 *   remoteBosses()         the same for bosses (the centipede's body is rebuilt by the view from its head)
 *   takeNetFx(out)         the cosmetic effects of the ticks since the last frame (§4.1 Fx)
 *   takeZombieDeaths(out)  the reliable deaths of §4.4: blood, a corpse and a drop, where the body fell
 *   netTownSeed()          (MP-22) the seed of the server's town, for GameLoop.init; `netOnTown(fn)` hears the
 *                          InitBegin that confirms it and the WorldReset that replaces it when a world ends
 *   netRoster(out)         (MP-23) the survivors in the world as the reliable roster has them, for the scoreboard
 *
 * While MP_PHASE = 0 netActive() is false, no remote is ever looked up, and the game loop keeps stepping the local
 * player itself — the single-player build behaves exactly as before.
 *
 * Frame order (it is the contract, not an accident):
 *   1. bind        the world / survivor / save the loop owns (re-attach after a respawn or a world rebuild)
 *   2. clock       advance the smoothed server-tick estimate
 *   3. reconcile   drain the snapshots that arrived since the last frame: ack, queue depth, rewind + replay
 *   4. predict     sample 0..n commands out of this frame and step each one with the shared simulation
 *   5. interpolate move everyone else to the render time, `delay` behind the clock
 *   6. send        one Input packet per command of step 4 (it + the 2 before it), with the view time of step 5
 *   7. present     bleed the visual offset off and write the drawn position onto the survivor
 */
import { GameRefs } from "../systems/types";
import { RemotePlayerView } from "./netTypes";
import { ClockSync } from "./clockSync";
import { CommandStream, RawInput } from "./commands";
import { Prediction } from "./prediction";
import { RemoteBoss, RemoteState, RemoteZombie, SnapshotBuffer } from "./snapshotBuffer";
import { createRawInput, readRawInput } from "./localInput";
import { getCtx } from "../bootstrap";
import { unwrapTick } from "shared/net/codec";
import { DESIGN } from "shared/engine/constants";
import { titleFromWire } from "shared/data/titles";
import { MAX_PLAYERS, MP_PHASE, TIME_SYNC_RATE, TOWN_SEED_MAX, WORLD_SEED_ATTRIBUTE } from "shared/net/mpConfig";
import {
	AnnounceKind,
	FxEvent,
	InputCommand,
	InputPacket,
	IntentKind,
	LifeState,
	PlayerFlag,
	REMOTE_FX,
	REMOTE_INPUT,
	REMOTE_INTENT,
	REMOTE_SNAP,
	REMOTE_TIME_SYNC,
	REMOTE_WORLD,
	SnapshotPart,
	WorldEv,
	WorldEvent,
	decodeFx,
	decodeSnapshotPart,
	decodeTimePong,
	decodeWorld,
	encodeInput,
	encodeIntent,
	encodeTimePing,
	pongRtt,
} from "shared/net/protocol";
import { NET_FOLDER } from "shared/net/net";
import { GAME_NAME } from "shared/module";
import { PlayerState } from "shared/game/player";
import { PlayerSaveData } from "shared/game/save";
import { WorldData } from "shared/game/world";
import { HitchMeter, ZOMBIE_MOVING_UPS } from "./hitchMeter";

const Players = game.GetService("Players");
const ReplicatedStorage = game.GetService("ReplicatedStorage");
const Workspace = game.GetService("Workspace");

/** a clock probe every this many seconds — half the §8.2 TIME_SYNC_RATE, so the bucket is never near empty */
const TIME_SYNC_PERIOD = 1 / math.max(1, TIME_SYNC_RATE / 2);
/**
 * Snapshot parts waiting for the next netUpdate. At 20 Hz with up to 4 parts this is over a second of backlog; it
 * only ever fills while the loop is not calling netUpdate (loading, a menu), and a stale snapshot is worth less
 * than a fresh one, so the oldest is the one to drop.
 */
const MAX_QUEUED_PARTS = 96;
/** effects waiting for the next frame; a second of a heavy firefight, and the oldest is the one to drop */
const MAX_QUEUED_FX = 256;
/** deaths waiting for the next frame: reliable, so they are never dropped in flight, only if nobody draws */
const MAX_QUEUED_DEATHS = 256;
/** how long the handshake may take before it is worth a line in the log (seconds) */
const RunService = game.GetService("RunService");

const HANDSHAKE_WARN_S = 10;

/**
 * Seconds between the [PZ-NET] lines while a session is live, or 0 to keep quiet.
 *
 * Nothing reads netStats() yet -- it is meant for the F6 admin panel -- so a multi-client playtest would
 * have no way to see the numbers F1 is accepted on (§11.3): divergence p99 < 1 u, corrections over 16 u
 * under one a minute, and the survivors actually seeing each other. Printing them puts those numbers in
 * the Studio output, which is the one place a test driver can read from outside the game.
 */
const NET_LOG_S = 5 as number;

/** a survivor the reliable roster knows about (§4.4 PlayerJoined) */
interface RosterEntry {
	slot: number;
	userId: number;
	displayName: string;
	level: number;
	/** OutfitLook / PetLook (MON-04): from PlayerJoined, then kept current by PlayerProfile */
	outfit: number;
	pet: number;
	/** the title byte under the name (MON-05, `titleToWire`: 0 = none), kept current the same way */
	title: number;
	/** (MP-23) the day of this life and the zombies put down, from `PlayerTally`; 0 / -1 until the first one */
	lifeDay: number;
	kills: number;
	/**
	 * LifeState of the last `PlayerLife` delta (§4.5, §7.3). This — and NOT the snapshot's PlayerFlag.Dead /
	 * Downed — is what says whether a survivor is up, down or gone: `Snap` is unreliable, and a death that is
	 * lost in flight would leave a corpse walking around on someone's screen. The snapshot's own bits stay
	 * what they are good at: the continuous, self-correcting ones (walking, swinging, reloading, fired).
	 */
	life: number;
}

interface Remotes {
	input: UnreliableRemoteEvent;
	intent: RemoteEvent;
	snap: UnreliableRemoteEvent;
	fx: UnreliableRemoteEvent;
	world: RemoteEvent;
	timeSync: UnreliableRemoteEvent;
}

/** one zombie death the view still has to play: blood, a corpse and a drop, where the body fell (§4.4) */
export interface ZombieDeathEvent {
	netId: number;
	x: number;
	y: number;
	/** DeathCause (§4.4): which blood and which debris */
	cause: number;
}

/**
 * MP-22: what the server says about its town — at every entry (InitBegin) and the moment a world ends (WorldReset).
 * client/main.client.ts listens (`netOnTown`) and rebuilds the loop's town when it is not the server's.
 */
export interface TownNotice {
	/** the seed the server's town was generated from */
	seed: number;
	/** WorldReset only: the world day the old town fell on (undefined for InitBegin) */
	endedDay?: number;
	/** WorldReset only: the server gave THIS survivor a new life in the new town (MP-20: life day 1, starter kit) */
	newLife: boolean;
	/**
	 * With `newLife`: the runRev the server's save is on now. The client takes it (never its own value + 1: a wallet
	 * that already carried it would have made that one too many, and every report "outdated" — review B2).
	 */
	runRev?: number;
}

export interface NetStats {
	/** the handshake finished and the session is live */
	active: boolean;
	/** this client's player slot, or -1 before the roster names it */
	slot: number;
	/** survivors in the roster, including this one */
	roster: number;
	/** snapshot parts still waiting to be reconciled (normally 0 or 1) */
	queued: number;
	/** parts thrown away because the queue was full */
	queueDropped: number;
	/** parts that did not decode (a protocol mismatch, or a corrupted payload) */
	malformed: number;
	/** self blocks skipped because a newer snapshot had already been applied (unordered delivery) */
	staleSelf: number;
	/** the map hash of InitBegin did not match the town this client generated (§4.5) */
	mapMismatch: boolean;
	/** round trip time in seconds, from the TimeSync probe */
	rtt: number;
	/** interpolation delay currently in use, seconds */
	interpDelay: number;
	/** |predicted − authoritative| of the last snapshot, and its p99 (§12.2 target: p99 < 1 u) */
	errorLast: number;
	errorP99: number;
	/** corrections above 16 u in the last minute (§11.3 F1 target: < 1/min) */
	correctionsPerMinute: number;
	/** measured snapshot arrival interval and its mean deviation, seconds (client/net/snapshotBuffer.ts) */
	snapInterval: number;
	snapJitter: number;
	/** how far behind this client's clock a fresh snapshot lands, seconds: latency plus any server drift (§5.1) */
	snapLateness: number;
	/** frames whose render time had to be HELD: the tell-tale of a remote survivor moving in steps */
	snapStalls: number;
	/** snapshot parts accepted and dropped by the buffer (stale, duplicate, outside the reorder window) */
	snapAccepted: number;
	snapDropped: number;
	/** remote survivors the buffer is interpolating */
	tracked: number;
	/** zombies and bosses the buffer is interpolating — the number that must match on every client (§11.3) */
	zombies: number;
	bosses: number;
	/** Fx events thrown away because the queue was full (the client was not drawing) */
	fxDropped: number;
	/** commands still waiting for an ack */
	pending: number;
	/** current sampling rate, 58.8 … 61.2 Hz */
	sampleHz: number;
}

// ---------------------------------------------------------------- state

const clock = new ClockSync();
const commands = new CommandStream();
const prediction = new Prediction();
const snapshots = new SnapshotBuffer();

const roster = new Map<number, RosterEntry>();
const queue = new Array<SnapshotPart>();
const views = new Array<RemotePlayerView>();
/**
 * Watches the position every ally is about to be DRAWN at, and counts the jolts an eye would call a stutter
 * (see hitchMeter.ts). Reported in the [PZ-NET] line: offline, every layer that could cause one measures
 * clean, so the only place left to look is this client on this machine.
 */
const allyHitches = new HitchMeter();
/**
 * The same meter on the horde, for the bodies on screen (the owner's "zombies walk laggy, with micro-stutters",
 * 2026-09-23). A zombie walks at 90 u/s, under the survivor threshold, so it is judged from ZOMBIE_MOVING_UPS;
 * a body that leaves the view is forgotten, so coming back is not read as one enormous step.
 */
const zombieHitches = new HitchMeter(ZOMBIE_MOVING_UPS);
/** zombie-seconds on screen since the last [PZ-NET] line: what the zombie jolts are counted against */
let zombieVisibleS = 0;
/** world units of margin around the view: a body half inside the screen is on it */
const ZOMBIE_VIEW_PAD = 32;
/** effects and deaths that arrived since the last frame; the view drains both (see `netUpdate`) */
const fxQueue = new Array<FxEvent>();
const deaths = new Array<ZombieDeathEvent>();
const pendingAnnounce = new Array<string>();
let pendingClock: { worldDay: number; dayTime: number; tick: number; rain: boolean; waveFlags: number } | undefined;
const sampled = new Array<InputCommand>();
/** this frame's Input packets, one per command built (commands.ts `flush`) */
const outbound = new Array<InputPacket>();
const raw: RawInput = createRawInput();

let remotes: Remotes | undefined;
let connections = new Array<RBXScriptConnection>();
let mySlot = -1;
let hasEpoch = false;
let mapHash = 0;
let mapMismatch = false;
/** the hash of the server's town, from the last InitBegin (undefined until one, or after a WorldReset) */
let serverMapHash: number | undefined;
/** the seed of the server's town, from the last InitBegin or WorldReset this client read (MP-22) */
let townSeed: number | undefined;
/**
 * MP-22: the server tick (u16) of the batch that carried the last WorldReset, until the next reconcile turns it into
 * `townGuard`. Snap is unreliable and unordered against World: a snapshot of the old town can still arrive after
 * the rebuild, and its self block, its zombies (the new horde reuses their netIds from 1) and its allies belong to
 * streets that are gone. For TOWN_GUARD_S after the reset, a part stamped with the reset's tick OR EARLIER is
 * dropped: the server sends the reset in the heartbeat right after that tick, whose snapshots (already sent) were
 * still the old town's (server/net/replication.ts `openTown`).
 */
let townResetTick: number | undefined;
let townGuard = -math.huge;
let townGuardUntil = 0;
const TOWN_GUARD_S = 2;
/** who wants to hear about the town (client/main.client.ts); called INSIDE the World event, in order */
const townListeners = new Array<(notice: TownNotice) => void>();
const titleListeners = new Array<(titleId: number) => void>();
let queueDropped = 0;
let fxDropped = 0;
let malformed = 0;
let lastSelfTick = -math.huge;
/** the local survivor's last reliable life state (§7.3), and whether it still has to reach refs.player */
let localLife = LifeState.Up as number;
let localLifeDirty = false;
let staleSelfBlocks = 0;
let timeSeq = 0;
let timeAt = 0;
/**
 * os.clock() the client last asked to enter the world (`netEnterWorld`), or 0 while it has not. This is
 * deliberately NOT when `connect()` first found the remotes: `netPrewarm()` calls that at boot, while the
 * player may still be sitting on the logo/lobby/tutorial screens for longer than HANDSHAKE_WARN_S, and the
 * game loop (the only caller of `netActive()`) does not run until a run is mounted anyway. Arming the timer at
 * boot meant the very first `netActive()` check of a run could already be past the budget purely from lobby
 * time, warning about a handshake that had not even been asked for yet.
 */
let startedAt = 0;
/** os.clock() of the last [PZ-NET] line */
let loggedAt = 0;
/** frames drawn since the last line, so the log says whether the CLIENT is the thing stuttering */
let framesSinceLog = 0;
let warnedSlow = false;

/** the world / survivor / save currently attached, so a respawn or a world rebuild is noticed */
let boundWorld: WorldData | undefined;
let boundPlayer: PlayerState | undefined;
let boundSave: PlayerSaveData | undefined;

/**
 * The admin switches the game loop owns (`GameLoop.admin`). They are bound once, by reference, so the free camera
 * keeps freezing the survivor when the session is server-simulated too — without the seam growing a per-frame
 * argument for a debug switch.
 */
let adminFlags: { noclip: boolean; frozen: boolean } | undefined;

// ---------------------------------------------------------------- map hash (§4.5)

const U32 = 4294967296;

/**
 * "Number of solids + Σ id × coordinates mod 2³²" (§4.5), the same value server/net/replication.ts sends in
 * InitBegin. The client generates the town itself, so a mismatch means the two sides disagree about the map and
 * every prediction from here on is noise — which is worth a line in the log even though F1 cannot fix it.
 *
 * TODO(F2): this belongs next to the wire format in shared/net, together with the server's copy.
 */
function mapHashOf(world: WorldData): number {
	let acc = world.solids.size() % U32;
	for (const s of world.solids) {
		const coords = math.floor(s.x) + math.floor(s.y) * 7 + math.floor(s.w) * 13 + math.floor(s.h) * 17;
		acc = (acc + ((s.id * coords) % U32)) % U32;
	}
	return acc < 0 ? acc + U32 : acc;
}

// ---------------------------------------------------------------- remotes and the handshake (§4.1, §7.1)

function findRemotes(): Remotes | undefined {
	const folder = ReplicatedStorage.FindFirstChild(NET_FOLDER);
	if (folder === undefined || !folder.IsA("Folder")) return undefined;
	const input = folder.FindFirstChild(REMOTE_INPUT);
	const intent = folder.FindFirstChild(REMOTE_INTENT);
	const snap = folder.FindFirstChild(REMOTE_SNAP);
	const fx = folder.FindFirstChild(REMOTE_FX);
	const world = folder.FindFirstChild(REMOTE_WORLD);
	const timeSync = folder.FindFirstChild(REMOTE_TIME_SYNC);
	if (
		input === undefined ||
		!input.IsA("UnreliableRemoteEvent") ||
		intent === undefined ||
		!intent.IsA("RemoteEvent") ||
		snap === undefined ||
		!snap.IsA("UnreliableRemoteEvent") ||
		fx === undefined ||
		!fx.IsA("UnreliableRemoteEvent") ||
		world === undefined ||
		!world.IsA("RemoteEvent") ||
		timeSync === undefined ||
		!timeSync.IsA("UnreliableRemoteEvent")
	) {
		return undefined;
	}
	return { input, intent, snap, fx, world, timeSync };
}

/** looks the remotes up (they only exist when the server runs the MP host) and wires the handlers up once */
function connect(): boolean {
	if (remotes !== undefined) return true;
	const found = findRemotes();
	if (found === undefined) return false;
	remotes = found;
	connections.push(found.world.OnClientEvent.Connect(payload => onWorld(payload)));
	connections.push(found.snap.OnClientEvent.Connect(payload => onSnap(payload)));
	connections.push(found.fx.OnClientEvent.Connect(payload => onFx(payload)));
	connections.push(found.timeSync.OnClientEvent.Connect(payload => onTimeSync(payload)));
	return true;
}

function onWorld(payload: unknown): void {
	const batch = decodeWorld(payload);
	if (batch === undefined) {
		malformed += 1;
		return;
	}
	for (const e of batch.events) applyWorldEvent(e, batch.tick);
}

function applyWorldEvent(e: WorldEvent, batchTick: number): void {
	if (e.t === WorldEv.InitBegin) {
		townSeed = e.seed;
		// FIRST: a listener may rebuild the loop's town around this seed (and `netReset` with it), and everything
		// below — and the rest of this batch — has to land on the rebuilt one
		noticeTown({ seed: e.seed, newLife: false });
		clock.setEpoch(e.tick0Time, e.simHz);
		snapshots.setRate(e.simHz);
		hasEpoch = true;
		serverMapHash = e.mapHash;
		checkMapHash();
		return;
	}
	if (e.t === WorldEv.WorldReset) {
		// MP-22: the world ended and a new town replaced it. Its hash comes with the next InitBegin; until then the
		// old one must not be compared with a town built from the new seed
		townSeed = e.seed;
		serverMapHash = undefined;
		const me = e.lives.find(life => life.userId === Players.LocalPlayer.UserId);
		noticeTown({ seed: e.seed, endedDay: e.endedDay, newLife: me !== undefined, runRev: me?.runRev });
		// AFTER the listeners: their rebuild runs `netReset`, which drops any guard of an earlier town
		townResetTick = batchTick;
		return;
	}
	if (e.t === WorldEv.PlayerJoined) {
		if (e.slot < 0 || e.slot >= MAX_PLAYERS) return;
		roster.set(e.slot, {
			slot: e.slot,
			userId: e.userId,
			displayName: e.name,
			level: e.level,
			outfit: e.outfit,
			pet: e.pet,
			title: e.title,
			lifeDay: 0,
			kills: -1,
			life: 0,
		});
		// this is how a client learns its own slot (§4.4: the newcomer's roster includes itself)
		if (e.userId === Players.LocalPlayer.UserId) mySlot = e.slot;
		return;
	}
	if (e.t === WorldEv.PlayerProfile) {
		// MON-04: an ally changed outfit or pet (or levelled up) mid-session. A profile for a slot the roster
		// does not know yet is dropped: its PlayerJoined, which is reliable and comes next, carries the same values.
		const entry = roster.get(e.slot);
		if (entry === undefined) return;
		entry.level = e.level;
		entry.outfit = e.outfit;
		entry.pet = e.pet;
		entry.title = e.title;
		return;
	}
	if (e.t === WorldEv.PlayerTally) {
		// MP-23: the scoreboard's numbers, the server's (a slot the roster does not know yet is dropped: the round the
		// server sends after every join comes after that join)
		const entry = roster.get(e.slot);
		if (entry === undefined) return;
		entry.lifeDay = e.lifeDay;
		entry.kills = e.kills;
		return;
	}
	if (e.t === WorldEv.PlayerLeft) {
		roster.delete(e.slot);
		snapshots.forget(e.slot);
		if (e.slot === mySlot) mySlot = -1;
		return;
	}
	if (e.t === WorldEv.PlayerLife) {
		const entry = roster.get(e.slot);
		if (entry !== undefined) entry.life = e.state;
		if (e.slot === mySlot) {
			localLife = e.state;
			localLifeDirty = true;
		}
		return;
	}
	if (e.t === WorldEv.ZombieDied) {
		// reliable, so it can be acted on at once: the body leaves the interpolation NOW and the view plays
		// the blood, the corpse and the drop at the position this event carries, not at the last one guessed
		snapshots.forgetZombie(e.netId);
		if (deaths.size() >= MAX_QUEUED_DEATHS) deaths.remove(0);
		deaths.push({ netId: e.netId, x: e.x, y: e.y, cause: e.cause });
		return;
	}
	if (e.t === WorldEv.Clock) {
		// the age of the delta matters: it was sampled at `e.tick`, and by the time it is applied the world
		// has moved on. Replaying that gap is what keeps the received hour from pulling the clock backwards.
		pendingClock = e;
		return;
	}
	if (e.t === WorldEv.Announce) {
		// MON-05: a title this survivor just earned is their news, not the round banner's (the decoder checked the id)
		if (e.msg === AnnounceKind.TitleUnlocked) {
			noticeTitle(titleFromWire(e.arg));
			return;
		}
		pendingAnnounce.push(announceText(e.msg, e.arg));
		return;
	}
	// the remaining deltas (constructions, doors, items) land in F3, when the client stops owning them
}

/** §4.5: the wire carries an AnnounceKind and an argument; the text is the client's (shared/data/lang.ts) */
function announceText(msg: number, arg: number): string {
	if (msg === AnnounceKind.Wave) return `Wave ${math.max(1, math.floor(arg))}`;
	if (msg === AnnounceKind.Night) return "Night";
	if (msg === AnnounceKind.BossSpawn) return "Boss";
	if (msg === AnnounceKind.BossKilled) return "Boss defeated";
	return "Good morning";
}

/** compares InitBegin's hash with the town this client generated, once both are known (§4.5) */
function checkMapHash(): void {
	const serverHash = serverMapHash;
	if (serverHash === undefined || mapHash === 0 || mapMismatch) return;
	if (serverHash === mapHash) return;
	mapMismatch = true;
	warn(`[${GAME_NAME}] map hash mismatch: server ${serverHash}, client ${mapHash} — the worlds are not the same`);
}

/** tells every town listener, each on its own: one that fails must not cost the rest of the World batch */
function noticeTown(notice: TownNotice): void {
	for (const fn of townListeners) {
		const [ok, err] = pcall(() => fn(notice));
		if (!ok) warn(`[${GAME_NAME}] town notice failed: ${tostring(err)}`);
	}
}

/** MON-05: the same for a title the server says this survivor earned (a TITLES id) */
function noticeTitle(titleId: number): void {
	if (titleId < 0) return;
	for (const fn of titleListeners) {
		const [ok, err] = pcall(() => fn(titleId));
		if (!ok) warn(`[${GAME_NAME}] title notice failed: ${tostring(err)}`);
	}
}

function onSnap(payload: unknown): void {
	const part = decodeSnapshotPart(payload);
	if (part === undefined) {
		malformed += 1;
		return;
	}
	// unreliable and unordered: the buffer sorts by tick, so the queue only has to keep them
	if (queue.size() >= MAX_QUEUED_PARTS) {
		queue.remove(0);
		queueDropped += 1;
	}
	queue.push(part);
}

/**
 * One `Fx` batch (§4.1). Unreliable and ephemeral by design: a lost batch is a blood spurt nobody saw, which
 * is worth far less than the head-of-line delay reliability would put on every packet behind it. The queue is
 * drained by the game loop once a frame, and it is capped because a client that is not drawing (a menu, a
 * load) must not grow a table of effects it will never play.
 */
function onFx(payload: unknown): void {
	const batch = decodeFx(payload);
	if (batch === undefined) {
		malformed += 1;
		return;
	}
	for (const e of batch.events) {
		if (fxQueue.size() >= MAX_QUEUED_FX) {
			fxQueue.remove(0);
			fxDropped += 1;
		}
		fxQueue.push(e);
	}
}

function onTimeSync(payload: unknown): void {
	const pong = decodeTimePong(payload);
	if (pong === undefined) {
		malformed += 1;
		return;
	}
	clock.noteRtt(pongRtt(pong, Workspace.GetServerTimeNow()));
	// the server's clock and tick, stamped together: the epoch follows the time the server dropped (clockSync.ts)
	clock.noteServerTick(pong.serverTime, pong.serverTick);
}

function sendTimePing(now: number): void {
	const net = remotes;
	if (net === undefined || now - timeAt < TIME_SYNC_PERIOD) return;
	timeAt = now;
	timeSeq = (timeSeq + 1) % 65536;
	const payload = encodeTimePing({ seq: timeSeq, clientTime: Workspace.GetServerTimeNow() });
	if (payload !== undefined) net.timeSync.FireServer(payload);
}

// ---------------------------------------------------------------- the public seam

/**
 * True once this client is in a server-simulated session: the phase is on, the remotes exist, the clock has an
 * epoch and the roster has named this client's slot. Until then the game loop keeps simulating locally, which is
 * also what happens for the whole of MP_PHASE = 0.
 */
export function netActive(): boolean {
	if (MP_PHASE < 1) return false;
	if (!connect()) return false;
	const live = hasEpoch && mySlot >= 0;
	if (!live && !warnedSlow && startedAt > 0 && os.clock() - startedAt > HANDSHAKE_WARN_S) {
		warnedSlow = true;
		warn(
			`[${GAME_NAME}] MP handshake still pending after ${HANDSHAKE_WARN_S}s (epoch ${hasEpoch}, slot ${mySlot})`,
		);
	}
	return live;
}

/**
 * The server runs the MP host (its remotes exist), so the server owns this survivor's life: it keeps a body dead
 * until daybreak, a Rebirth or the end of the world (MP-21, MP-22), and it is the one that says so. Unlike
 * `netActive()` this does not wait for the handshake of a run, which is what a decision made from the lobby needs.
 */
export function netHosted(): boolean {
	return MP_PHASE >= 1 && connect();
}

/** one frame of the session; only called while netActive() (see the frame order at the top of the file) */
export function netUpdate(refs: GameRefs, dt: number): void {
	if (!bind(refs)) return;
	const now = os.clock();
	applyLife(refs);
	const tick = clock.update(dt, Workspace.GetServerTimeNow());
	// before this frame's snapshots are measured against the corrected clock: the render time ignores the correction
	snapshots.clockCorrected(clock.lastCorrection());
	applyClock(refs, tick);
	reconcile(now);
	predict(refs, dt);
	snapshots.advance(dt, tick, now, refs.world);
	rebuildViews();
	allyHitches.beginFrame(dt);
	for (const v of views) allyHitches.observe(v.slot, v.x, v.y, dt);
	send(now);
	sendTimePing(now);
	// metering only: after the frame's packets are on their way, never in front of them
	observeZombies(dt);
	prediction.present(dt, commands.phase(), commands.newest());
	logStats(now);
}

/**
 * After step 6: every zombie on screen through the hitch meter, exactly as the allies go through theirs. It only
 * measures, so it runs once the frame's Input and TimePing are sent (the review of 2026-09-23, #9).
 */
function observeZombies(dt: number): void {
	zombieHitches.beginFrame(dt);
	const view = getCtx().cam.viewRect(ZOMBIE_VIEW_PAD);
	for (const z of snapshots.zombieStates()) {
		const shown = z.alpha >= 0.5 && z.x >= view.minX && z.x <= view.maxX && z.y >= view.minY && z.y <= view.maxY;
		if (!shown) {
			zombieHitches.forget(z.netId);
			continue;
		}
		zombieHitches.observe(z.netId, z.x, z.y, dt);
		zombieVisibleS += dt;
	}
}

/** the server's dropped-tick counter (server/net/mpHost.ts publishes it on Workspace), or -1 before it has */
function serverDroppedTicks(): number {
	const v = Workspace.GetAttribute("pz_dropped_ticks");
	return typeIs(v, "number") ? v : -1;
}

/** the server's Heartbeat debt being repaid right now, in ms (mpHost.ts `pz_backlog_ms`), or -1 before it has one */
function serverBacklogMs(): number {
	const v = Workspace.GetAttribute("pz_backlog_ms");
	return typeIs(v, "number") ? v : -1;
}

/** periodic line with what F1 is judged on, so a playtest can be read from the output */
function logStats(now: number): void {
	framesSinceLog += 1;
	if (NET_LOG_S <= 0) return;
	if (now - loggedAt < NET_LOG_S) return;
	const frames = framesSinceLog;
	const span = now - loggedAt;
	const fps = loggedAt > 0 && span > 0 ? frames / span : 0;
	framesSinceLog = 0;
	loggedAt = now;
	const st = netStats();
	const h = allyHitches.take();
	const zh = zombieHitches.take();
	const visibleS = zombieVisibleS;
	zombieVisibleS = 0;
	print(
		string.format(
			"[PZ-NET] slot %d | roster %d | outros %d | zumbis %d | chefes %d | rtt %.0f ms | erro p99 %.2f u | correcoes %.1f/min | " +
				"SUAVIDADE: atraso %.0f ms (latencia medida %.0f ms), intervalo %.0f ms, jitter %.0f ms, travadas %d, aceitos %d, buffer-descartou %d, ticks perdidos no servidor %d (divida agora %d ms, relogio reancorado +%.0f ms) | " +
				"fila %d | descartes %d | malformados %d | stale %d | envio %.0f Hz | pendentes %d | fps %.0f | aliado: %d trancos em %.0f s andando (%d em quadro longo, pior %.0f%%) | " +
				"zumbis: %d trancos em %.0f s visiveis (%.0f s andando, %d em quadro longo, pior %.0f%%)%s",
			st.slot,
			st.roster,
			views.size(),
			st.zombies,
			st.bosses,
			st.rtt * 1000,
			st.errorP99,
			st.correctionsPerMinute,
			st.interpDelay * 1000,
			st.snapLateness * 1000,
			st.snapInterval * 1000,
			st.snapJitter * 1000,
			st.snapStalls,
			st.snapAccepted,
			st.snapDropped,
			serverDroppedTicks(),
			serverBacklogMs(),
			clock.stats().epochShift * 1000,
			st.queued,
			st.queueDropped,
			st.malformed,
			st.staleSelf,
			st.sampleHz,
			st.pending,
			fps,
			h.jolts,
			h.walkingS,
			h.inLongFrames,
			h.worst * 100,
			zh.jolts,
			visibleS,
			zh.walkingS,
			zh.inLongFrames,
			zh.worst * 100,
			st.mapMismatch ? " | MAPA DIFERENTE" : "",
		),
	);
}

/** the other survivors, interpolated for this frame's render time (rebuilt by netUpdate; do not keep the array) */
export function remotePlayers(): ReadonlyArray<RemotePlayerView> {
	return views;
}

/**
 * The horde, interpolated for this frame's render time. In phase 2 this is the ONLY horde a client has: the
 * local simulation is switched off (client/systems/zombieAI.ts), so what is drawn is what the server sent —
 * same bodies, same `netId`s, same positions on every screen (§11.3 F2).
 */
export function remoteZombies(): ReadonlyArray<RemoteZombie> {
	return snapshots.zombieStates();
}

export function remoteBosses(): ReadonlyArray<RemoteBoss> {
	return snapshots.bossStates();
}

/** (MP-23) one survivor of the roster, as the scoreboard reads it */
export interface RosterView {
	slot: number;
	userId: number;
	displayName: string;
	level: number;
	/** the title byte (`titleToWire`: 0 = none) */
	title: number;
	/** this life's day, 0 until the server's first PlayerTally */
	lifeDay: number;
	/** zombies put down, -1 until the server's first PlayerTally */
	kills: number;
	/** LifeState */
	life: number;
	/** this client's own survivor */
	you: boolean;
}

/**
 * (MP-23) The survivors in the world, as the reliable roster has them (PlayerJoined / PlayerProfile / PlayerLife /
 * PlayerTally), in slot order, written into `out` (cleared first; its entries are reused, so a scoreboard that
 * reads this every frame allocates nothing once warm). Empty outside a server session.
 */
export function netRoster(out: Array<RosterView>): Array<RosterView> {
	let n = 0;
	for (let slot = 0; slot < MAX_PLAYERS; slot++) {
		const e = roster.get(slot);
		if (e === undefined) continue;
		let v = out[n];
		if (v === undefined) {
			v = { slot: 0, userId: 0, displayName: "", level: 0, title: 0, lifeDay: 0, kills: -1, life: 0, you: false };
			out[n] = v;
		}
		v.slot = e.slot;
		v.userId = e.userId;
		v.displayName = e.displayName;
		v.level = e.level;
		v.title = e.title;
		v.lifeDay = e.lifeDay;
		v.kills = e.kills;
		v.life = e.life;
		v.you = e.slot === mySlot;
		n += 1;
	}
	while (out.size() > n) out.pop();
	return out;
}

/** the effects received since the last call, appended to `out` and cleared here (§4.1 Fx) */
export function takeNetFx(out: Array<FxEvent>): Array<FxEvent> {
	for (const e of fxQueue) out.push(e);
	fxQueue.clear();
	return out;
}

/** the zombie deaths received since the last call (§4.4), appended to `out` and cleared here */
export function takeZombieDeaths(out: Array<ZombieDeathEvent>): Array<ZombieDeathEvent> {
	for (const d of deaths) out.push(d);
	deaths.clear();
	return out;
}

/**
 * Binds the admin switches the game loop owns, by reference. Called once, from GameLoop.init(); the free camera
 * has to freeze the survivor in a server session exactly as it does locally.
 */
export function netBindAdmin(flags: { noclip: boolean; frozen: boolean }): void {
	adminFlags = flags;
}

/**
 * MP-22: the seed of the town the server runs — the one GameLoop.init builds. The last InitBegin or WorldReset this
 * client read; before either, the server's replicated attribute (a client that connected after a world ended and
 * has not entered it yet); failing that, or offline, the town every server opens with.
 */
export function netTownSeed(): number {
	if (MP_PHASE < 1) return DESIGN.TOWN_SEED;
	if (townSeed !== undefined) return townSeed;
	const attr = Workspace.GetAttribute(WORLD_SEED_ATTRIBUTE);
	if (typeIs(attr, "number") && attr % 1 === 0 && attr >= 1 && attr <= TOWN_SEED_MAX) return attr;
	return DESIGN.TOWN_SEED;
}

/**
 * MP-22: `fn` hears what the server says about its town (see TownNotice). It runs INSIDE the World event, before the
 * rest of that batch, so the day-1 Clock and the PlayerLife that follow a WorldReset land on a town rebuilt here.
 */
export function netOnTown(fn: (notice: TownNotice) => void): void {
	townListeners.push(fn);
}

/**
 * MON-05: `fn` hears each title the SERVER granted this survivor (a TITLES id), once, the moment it did -- the
 * `Announce{TitleUnlocked}` sent to this client alone. client/ui/titleNotice.ts mirrors it into the save's display
 * copy and shows the toast.
 */
export function netOnTitle(fn: (titleId: number) => void): void {
	titleListeners.push(fn);
}

/** a new world (a new run, a rebirth): forget the session state but keep the connection and the roster */
export function netReset(): void {
	if (MP_PHASE < 1) return;
	prediction.detach();
	commands.reset();
	snapshots.reset();
	queue.clear();
	views.clear();
	fxQueue.clear();
	deaths.clear();
	pendingAnnounce.clear();
	pendingClock = undefined;
	lastSelfTick = -math.huge;
	localLife = LifeState.Up;
	localLifeDirty = false;
	boundWorld = undefined;
	boundPlayer = undefined;
	boundSave = undefined;
	mapHash = 0;
	// a guard armed in the lobby would unwrap against a tick minutes later (see `townResetTick`)
	townResetTick = undefined;
	townGuardUntil = 0;
}

/** debug overlay / admin panel: the §12.2 numbers, cheap enough to read every frame */
export function netStats(): NetStats {
	const p = prediction.stats(os.clock());
	const c = commands.stats();
	const sb = snapshots.stats();
	return {
		active: netActive(),
		slot: mySlot,
		roster: roster.size(),
		queued: queue.size(),
		queueDropped,
		malformed,
		staleSelf: staleSelfBlocks,
		mapMismatch,
		rtt: clock.rtt(),
		interpDelay: snapshots.delay(),
		errorLast: p.last,
		errorP99: p.p99,
		correctionsPerMinute: p.correctionsPerMinute,
		snapInterval: sb.interval,
		snapJitter: sb.jitter,
		snapLateness: sb.lateness,
		snapStalls: sb.stalls,
		snapAccepted: sb.accepted,
		snapDropped: sb.dropped,
		tracked: sb.tracked,
		zombies: sb.zombies,
		bosses: sb.bosses,
		fxDropped,
		pending: c.pending,
		sampleHz: c.sampleHz,
	};
}

/**
 * BOOT: subscribes to the remotes as soon as they exist, without waiting for a run.
 *
 * `netActive()` connects lazily, but it is only ever called from the game loop, which does not run while
 * the player is in the lobby. The server, meanwhile, admits the player on join and starts sending
 * snapshots at once -- with nothing listening, every one of them is dropped ("Remote event invocation
 * discarded event for Net.Snap"), and the handshake does not even begin until a run is mounted, so the
 * first seconds of a run are simulated locally before the server takes over.
 *
 * Connecting at boot fixes both: the clock epoch and the slot arrive while the player is still choosing
 * PLAY, and the run starts already server-driven. The remotes only appear once the server has built them,
 * so this keeps trying, cheaply, until it lands, and then stops.
 */
export function netPrewarm(): void {
	if (MP_PHASE < 1) return;
	if (connect()) return;
	let waiter: RBXScriptConnection | undefined;
	waiter = RunService.Heartbeat.Connect(() => {
		if (!connect()) return;
		waiter?.Disconnect();
		waiter = undefined;
	});
}

/**
 * Asks the server for a body in the world, or to take it away.
 *
 * Being connected is not playing. Until this is sent the player exists only as a name in the roster: no
 * body in the street, no slot held, nothing for the horde to find while they read the shop. The server
 * decides where (a safe spawn point) and whether (the server may be full); the client only states intent.
 */
function sendIntent(kind: IntentKind): void {
	if (MP_PHASE < 1) return;
	if (!connect()) return;
	const payload = encodeIntent(kind);
	if (payload !== undefined) remotes?.intent.FireServer(payload);
}

/** a run is starting: ask for a body (client/main.client.ts, mountRun) */
export function netEnterWorld(): void {
	// the handshake budget starts NOW, not at boot (see `startedAt`'s own comment): restarting a run (LeaveWorld
	// + EnterWorld in the same frame, client/main.client.ts) re-arms it too, so a second run that genuinely
	// stalls still gets its own warning instead of staying silenced by the first one's.
	startedAt = os.clock();
	warnedSlow = false;
	sendIntent(IntentKind.EnterWorld);
}

/** the run is over or the player went back to the menus: give the body and the slot back */
export function netLeaveWorld(): void {
	sendIntent(IntentKind.LeaveWorld);
	// no run is being asked for any more: disarm the timer so idle time back in the menus is never mistaken
	// for a stalled handshake if `netActive()` happens to be polled again before the next EnterWorld
	startedAt = 0;
	warnedSlow = false;
}

/** SESSION TEARDOWN (leaving the place): drops the handlers so nothing fires into a dead frame loop */
export function netDisconnect(): void {
	for (const conn of connections) conn.Disconnect();
	connections = new Array<RBXScriptConnection>();
	remotes = undefined;
	hasEpoch = false;
	serverMapHash = undefined;
	mySlot = -1;
	startedAt = 0;
	warnedSlow = false;
	roster.clear();
	clock.reset();
	netReset();
}

// ---------------------------------------------------------------- the frame, step by step

/** (re)attaches the prediction when the loop hands over a different world, survivor or save */
function bind(refs: GameRefs): boolean {
	if (boundWorld === refs.world && boundPlayer === refs.player && boundSave === refs.save) {
		return prediction.attached();
	}
	boundWorld = refs.world;
	boundPlayer = refs.player;
	boundSave = refs.save;
	mapHash = mapHashOf(refs.world);
	mapMismatch = false;
	// the server's hash may already be here (a town rebuilt after its InitBegin, MP-22): compare it now
	checkMapHash();
	prediction.attach(refs.world, refs.player, refs.save);
	commands.reset();
	snapshots.reset();
	queue.clear();
	views.clear();
	fxQueue.clear();
	deaths.clear();
	lastSelfTick = -math.huge;
	return true;
}

/**
 * The world clock and its announcements (§4.5, §4.6), onto the DayNight the loop owns. The delta is aged by
 * the ticks that passed between the sample and this frame, so applying it never drags the visible hour back;
 * `applyClock` itself decides whether to ease the error away or jump (an admin moving the clock).
 */
function applyClock(refs: GameRefs, tickNow: number): void {
	const c = pendingClock;
	if (c !== undefined) {
		pendingClock = undefined;
		const age = math.max(0, (tickNow - unwrapTick(c.tick, math.floor(tickNow))) / clock.rate());
		refs.daynight.applyClock(c, age);
	}
	if (pendingAnnounce.size() === 0) return;
	for (const text of pendingAnnounce) refs.daynight.announce(text);
	pendingAnnounce.clear();
}

/**
 * The reliable life state, onto the survivor the loop owns. Death is the one piece of the local state the F1
 * server decides on its own (§7.3), so it arrives on the `World` channel and not in the unreliable self block.
 */
function applyLife(refs: GameRefs): void {
	if (!localLifeDirty) return;
	localLifeDirty = false;
	refs.player.dead = localLife === LifeState.Dead;
}

/** step 3: every snapshot that arrived since the last frame, oldest first */
function reconcile(now: number): void {
	if (queue.size() === 0) return;
	const refTick = clock.tickNow();
	if (townResetTick !== undefined) {
		// unwrapped here, next to a fresh tick estimate, and only compared for a moment: a u16 far from `refTick`
		// would unwrap into the wrong lap
		townGuard = unwrapTick(townResetTick, math.floor(refTick));
		townGuardUntil = now + TOWN_GUARD_S;
		townResetTick = undefined;
	}
	for (const part of queue) {
		const tick = unwrapTick(part.tick, math.floor(refTick));
		// MP-22: a part of the town that ended, overtaken by the WorldReset (see `townResetTick`)
		if (now < townGuardUntil && tick <= townGuard) continue;
		snapshots.receive(part, refTick, now);
		const block = part.self;
		if (block === undefined) continue;
		// Snap is unreliable AND unordered (§1.1): a part from an older tick may well arrive after a newer one.
		// The interpolation buffer sorts its own samples by tick, but a self block is not a sample — applying an
		// older one would rewind the survivor to where the server had them two snapshots ago and replay only the
		// commands the NEWER ack left unacked, i.e. throw the position backwards by everything in between.
		if (staleSelf(tick)) {
			staleSelfBlocks += 1;
			continue;
		}
		lastSelfTick = tick;
		// the ack has to be applied BEFORE the replay: `unacked` is exactly what the server has not simulated
		commands.ack(block.ackSeq);
		commands.noteBufDepth(block.bufDepth);
		prediction.reconcile(block, commands.unacked(), now);
	}
	queue.clear();
}

function staleSelf(tick: number): boolean {
	return lastSelfTick > -math.huge && tick <= lastSelfTick;
}

/** step 4: this frame's input becomes 0..n commands, each stepped with the shared simulation */
function predict(refs: GameRefs, dt: number): void {
	const ctx = getCtx();
	const input = refs.input;
	// the release of a BLOCKED attack button is no release either -- exactly what client combat does with it
	// (`released = attackReleased && !blocked`): letting go of a button that was held through the Bag must not
	// fire the server's bolt-action on the edge (DESIGN_RULES UI-06, tools/test-menus.mjs)
	commands.addEdges(
		input.attackPressed,
		input.attackReleased && !input.attackBlocked,
		input.actionPressed,
		input.reloadPressed,
	);
	readRawInput(ctx.cam, input, adminFlags?.frozen === true, raw);
	sampled.clear();
	commands.sample(dt, raw, sampled);
	for (const cmd of sampled) prediction.step(cmd);
}

/**
 * step 6: one packet per command this frame built -- each with the two before it -- and the view time of the
 * interpolation (§2.2, §2.3). Per command, not per frame: a 15 FPS frame builds four, and a single packet of
 * three would never carry the oldest (see commands.ts `flush`).
 */
function send(now: number): void {
	const net = remotes;
	if (net === undefined) return;
	const render = snapshots.renderNow();
	const viewTick = math.floor(render);
	const viewFrac = math.clamp(math.floor((render - viewTick) * 256), 0, 255);
	outbound.clear();
	commands.flush(viewTick, viewFrac, now, outbound);
	for (const packet of outbound) {
		const payload = encodeInput(packet);
		if (payload !== undefined) net.input.FireServer(payload);
	}
	outbound.clear();
}

/** step 5b: the interpolated slots plus what only the reliable roster knows (name, level) */
function rebuildViews(): void {
	views.clear();
	for (const state of snapshots.states()) {
		if (state.slot === mySlot) continue; // the local survivor is predicted, never interpolated
		const entry = roster.get(state.slot);
		// no roster entry yet: PlayerJoined is reliable and leads the first snapshot, so this is a single frame
		if (entry === undefined) continue;
		// a dead survivor has no body in F1 (§11.3: the downed / spectate flow is F4), and their plate retires
		// with them. Which survivors are dead comes from the reliable channel, never from a snapshot bit.
		if (entry.life === LifeState.Dead) continue;
		views.push(viewOf(state, entry));
	}
}

function viewOf(state: RemoteState, entry: RosterEntry): RemotePlayerView {
	return {
		userId: entry.userId,
		slot: entry.slot,
		displayName: entry.displayName,
		level: entry.level,
		outfit: entry.outfit,
		pet: entry.pet,
		title: entry.title,
		x: state.x,
		y: state.y,
		angle: state.aim,
		// §4.2 carries another survivor's health as a fraction of THEIR own maximum (`hp% u8`), never the raw
		// number: the view only ever needs the ratio, and the ratio is all the wire can honestly give
		hp: state.hp,
		hpMax: 1,
		downed: entry.life === LifeState.Downed,
		weaponId: state.weapon,
		feetCycle: state.feetCycle,
		swinging: (state.flags & PlayerFlag.Swinging) !== 0,
		swing: state.swing,
	};
}
