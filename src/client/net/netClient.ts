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
 *   6. send        one Input packet (the new command + the 2 before it) carrying the view time of step 5
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
import { MAX_PLAYERS, MP_PHASE, TIME_SYNC_RATE } from "shared/net/mpConfig";
import {
	AnnounceKind,
	FxEvent,
	InputCommand,
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
import { HitchMeter } from "./hitchMeter";

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
	costume: number;
	deco: number;
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
/** effects and deaths that arrived since the last frame; the view drains both (see `netUpdate`) */
const fxQueue = new Array<FxEvent>();
const deaths = new Array<ZombieDeathEvent>();
const pendingAnnounce = new Array<string>();
let pendingClock: { worldDay: number; dayTime: number; tick: number; rain: boolean; waveFlags: number } | undefined;
const sampled = new Array<InputCommand>();
const raw: RawInput = createRawInput();

let remotes: Remotes | undefined;
let connections = new Array<RBXScriptConnection>();
let mySlot = -1;
let hasEpoch = false;
let mapHash = 0;
let mapMismatch = false;
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
	for (const e of batch.events) applyWorldEvent(e);
}

function applyWorldEvent(e: WorldEvent): void {
	if (e.t === WorldEv.InitBegin) {
		clock.setEpoch(e.tick0Time, e.simHz);
		snapshots.setRate(e.simHz);
		hasEpoch = true;
		checkMapHash(e.mapHash);
		return;
	}
	if (e.t === WorldEv.PlayerJoined) {
		if (e.slot < 0 || e.slot >= MAX_PLAYERS) return;
		roster.set(e.slot, {
			slot: e.slot,
			userId: e.userId,
			displayName: e.name,
			level: e.level,
			costume: e.costume,
			deco: e.deco,
			life: 0,
		});
		// this is how a client learns its own slot (§4.4: the newcomer's roster includes itself)
		if (e.userId === Players.LocalPlayer.UserId) mySlot = e.slot;
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
function checkMapHash(serverHash: number): void {
	if (mapHash === 0 || mapMismatch) return;
	if (serverHash === mapHash) return;
	mapMismatch = true;
	warn(`[${GAME_NAME}] map hash mismatch: server ${serverHash}, client ${mapHash} — the worlds are not the same`);
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

/** one frame of the session; only called while netActive() (see the frame order at the top of the file) */
export function netUpdate(refs: GameRefs, dt: number): void {
	if (!bind(refs)) return;
	const now = os.clock();
	applyLife(refs);
	const tick = clock.update(dt, Workspace.GetServerTimeNow());
	applyClock(refs, tick);
	reconcile(now);
	predict(refs, dt);
	snapshots.advance(dt, tick, now, refs.world);
	rebuildViews();
	allyHitches.beginFrame(dt);
	for (const v of views) allyHitches.observe(v.slot, v.x, v.y, dt);
	send(now);
	sendTimePing(now);
	prediction.present(dt, commands.phase(), commands.newest());
	logStats(now);
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
	print(
		string.format(
			"[PZ-NET] slot %d | roster %d | outros %d | zumbis %d | chefes %d | rtt %.0f ms | erro p99 %.2f u | correcoes %.1f/min | " +
				"SUAVIDADE: atraso %.0f ms, intervalo %.0f ms, jitter %.0f ms, travadas %d, aceitos %d, buffer-descartou %d | " +
				"fila %d | descartes %d | malformados %d | stale %d | envio %.0f Hz | pendentes %d | fps %.0f | aliado: %d trancos em %.0f s andando (%d em quadro longo, pior %.0f%%)%s",
			st.slot,
			st.roster,
			views.size(),
			st.zombies,
			st.bosses,
			st.rtt * 1000,
			st.errorP99,
			st.correctionsPerMinute,
			st.interpDelay * 1000,
			st.snapInterval * 1000,
			st.snapJitter * 1000,
			st.snapStalls,
			st.snapAccepted,
			st.snapDropped,
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
	for (const part of queue) {
		const tick = unwrapTick(part.tick, math.floor(refTick));
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
	commands.addEdges(input.attackPressed, input.attackReleased, input.actionPressed, input.reloadPressed);
	readRawInput(ctx.cam, input, adminFlags?.frozen === true, raw);
	sampled.clear();
	commands.sample(dt, raw, sampled);
	for (const cmd of sampled) prediction.step(cmd);
}

/** step 6: the newest command plus the two before it, with the view time of the interpolation (§2.2, §2.3) */
function send(now: number): void {
	const net = remotes;
	if (net === undefined) return;
	const render = snapshots.renderNow();
	const viewTick = math.floor(render);
	const viewFrac = math.clamp(math.floor((render - viewTick) * 256), 0, 255);
	const packet = commands.packet(viewTick, viewFrac);
	if (packet === undefined) return;
	if (!commands.trySend(now)) return;
	const payload = encodeInput(packet);
	if (payload !== undefined) net.input.FireServer(payload);
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
