/*
 * Boot glue of the authoritative server (docs/MULTIPLAYER.md §3.1, §4, §7.1, §8). SERVER ONLY.
 *
 * This is the only file of the F1 server front that touches Roblox: it owns the remotes, the Heartbeat loop and
 * the Player lifecycle, and hands everything else to the pure modules (server/sim/*, server/net/interest.ts,
 * server/net/replication.ts). server/main.server.ts only calls startMpHost() when MP_PHASE >= 1, so with
 * MP_PHASE = 0 not even the remote instances exist and the current single-player game is untouched.
 *
 * Order per Heartbeat (§3.1):
 *   1. admit players whose save finished loading (§7.1: safe spawn point, MP-04)
 *   2. sim.advance(dt) → one fixed tick per 1/SIM_HZ, at most MAX_CATCHUP_TICKS per heartbeat
 *   3. per tick, the replicator flushes the reliable World batch and (every 3 ticks) the snapshots
 *   4. once a second, publish the §12.2 metrics
 */
import { GAME_NAME } from "shared/module";
import { DESIGN } from "shared/engine/constants";
import {
	FLOOD_MESSAGES,
	FLOOD_MESSAGES_WINDOW_S,
	MAX_PLAYERS,
	TIME_SYNC_BURST,
	TIME_SYNC_RATE,
} from "shared/net/mpConfig";
import { IntentKind, LifeState, decodeIntent, decodeTimePing, encodeTimePong } from "shared/net/protocol";
import { PlayerSaveData } from "shared/game/save";
import { WorldData, generateTown } from "shared/game/world";
import {
	MpRemotes,
	createMpRemotes,
	destroyMpRemotes,
	onInput,
	onIntent,
	onTimeSync,
	sendFx,
	sendSnap,
	sendTimePong,
	sendWorld,
	sendWorldAll,
} from "./remotes";
import { Replicator, mapHashOf } from "./replication";
import {
	InputCounters,
	InputVerdict,
	ServerPlayer,
	adoptSave,
	createServerPlayer,
	findSpawnPoint,
	floodReason,
	ingestInput,
	noteMalformed,
	noteMessage,
} from "../sim/players";
import { ServerSimulation } from "../sim/simulation";

const Players = game.GetService("Players");
const RunService = game.GetService("RunService");
const Workspace = game.GetService("Workspace");

/** how often the host looks for players whose save has just finished loading (seconds) */
const ADMIT_INTERVAL = 0.5;
/** how often the §12.2 metrics are published (seconds) */
const METRIC_INTERVAL = 1;
/** an anomaly line is logged at most this often per player, so a cheater cannot spam the server log */
const ANOMALY_LOG_INTERVAL = 10;

export interface MpHostOptions {
	/**
	 * The live save of a connected player, or undefined while it is still loading / the session is closed.
	 * server/main.server.ts owns the sessions; the host never reads the DataStore itself.
	 */
	saveOf: (player: Player) => PlayerSaveData | undefined;
	/** the shared town; generated from DESIGN.TOWN_SEED when omitted (client and server build the same map, §4.5) */
	world?: WorldData;
	/** false disables the periodic metric attributes (used by tests) */
	metrics?: boolean;
}

/** one line of the §9.3 / F6 admin view: who the player is and what their counters say */
export interface MpAnomalyRow {
	slot: number;
	userId: number;
	name: string;
	/** current input queue depth (§2.2) */
	depth: number;
	counters: InputCounters;
}

export interface MpHost {
	simulation: ServerSimulation;
	replicator: Replicator;
	remotes: MpRemotes;
	world: WorldData;
	/** the server entity of a connected player, or undefined when they are not in the world */
	playerOf(player: Player): ServerPlayer | undefined;
	/** every survivor's anomaly counters, ready for the F6 admin panel (§9.3) */
	anomalies(): Array<MpAnomalyRow>;
	stop(): void;
}

let active: MpHost | undefined;

/** the running host, or undefined with MP_PHASE = 0 (what the F6 admin panel will read) */
export function activeMpHost(): MpHost | undefined {
	return active;
}

/** per connected Player, whether or not they are in the world yet */
/** shortest gap between two accepted enter/leave intents from the same client (§8.2) */
const WORLD_INTENT_COOLDOWN_S = 1;

interface Link {
	player: Player;
	slot?: number;
	/** TimeSync token bucket (§8.2 TIME_SYNC_RATE/BURST) */
	timeTokens: number;
	timeAt: number;
	/** messages from a player who is not in the world (flood protection before they even spawn) */
	strangerStart: number;
	strangerCount: number;
	/**
	 * The client asked to be IN the world (IntentKind.EnterWorld) and has not asked to leave.
	 *
	 * Being connected is not the same as playing: someone in the lobby, the shop or the credits must not
	 * have a body standing in the street. The server still decides where and whether; this only records
	 * that the client wants in, so a player who asked while every slot was taken gets in on a later pass.
	 */
	wantsWorld: boolean;
	/** os.clock() of the last accepted enter/leave, to rate-limit a client flipping it (§8.2) */
	worldAt: number;
	/** a kick is asked for once; the player takes a moment to actually leave */
	kicked: boolean;
	lastAnomalyLog: number;
	/** counters already reported, to log deltas instead of totals */
	reportedOverflow: number;
	reportedMalformed: number;
}

export function startMpHost(options: MpHostOptions): MpHost {
	// a second host would fight the first one for the remotes and the Heartbeat: the newest one wins
	if (active !== undefined) active.stop();
	const world = options.world ?? generateTown(DESIGN.TOWN_SEED);
	const remotes = createMpRemotes();
	const sim = new ServerSimulation({ world });
	const links = new Map<Player, Link>();
	const bySlot = new Map<number, Player>();
	const tick0Time = Workspace.GetServerTimeNow();

	const replicator = new Replicator(
		sim,
		{
			// method shorthand: ReplicationTransport declares methods, and roblox-ts keeps the two calling
			// conventions apart (an arrow property here would be called with the wrong `self`)
			snap(slot, part) {
				const player = bySlot.get(slot);
				if (player !== undefined) sendSnap(remotes, player, part);
			},
			fx(slot, packet) {
				const player = bySlot.get(slot);
				if (player !== undefined) sendFx(remotes, player, packet);
			},
			world(slot, packet) {
				const player = bySlot.get(slot);
				if (player !== undefined) sendWorld(remotes, player, packet);
			},
			worldAll(packet) {
				sendWorldAll(remotes, packet);
			},
		},
		{ tick0Time, mapHash: mapHashOf(world) },
	);
	sim.onTick = tick => replicator.afterTick(tick);
	// every cosmetic the simulation asks for goes out on the Fx channel, filtered by interest (§4.1, §4.3)
	sim.onFx = event => replicator.queueFx(event);
	// the snapshot's Dead flag is unreliable, so the transition itself goes out reliably (§4.5); F4 turns this
	// into downed → revive → dead with the same event
	sim.onDeath = sp => replicator.life(sp.slot, LifeState.Dead);

	// ------------------------------------------------------------ lifecycle

	function linkOf(player: Player): Link {
		let link = links.get(player);
		if (link === undefined) {
			link = {
				player,
				timeTokens: TIME_SYNC_BURST,
				timeAt: os.clock(),
				strangerStart: 0,
				strangerCount: 0,
				wantsWorld: false,
				worldAt: 0,
				kicked: false,
				lastAnomalyLog: 0,
				reportedOverflow: 0,
				reportedMalformed: 0,
			};
			links.set(player, link);
		}
		return link;
	}

	function kick(link: Link, reason: string): void {
		if (link.kicked) return;
		link.kicked = true;
		const player = link.player;
		warn(`[${GAME_NAME}] kicking ${player.Name} (${player.UserId}): network flood — ${reason}`);
		pcall(() => player.Kick("Network flood"));
	}

	/** §8.2: the automatic kick, checked after EVERY message, accepted or not */
	function guardFlood(link: Link, sp: ServerPlayer): void {
		const reason = floodReason(sp);
		if (reason !== undefined) kick(link, reason);
	}

	/** §7.1: enter the world at a safe spawn point (MP-04) once the save is available */
	function admit(player: Player): void {
		const link = linkOf(player);
		// nobody enters the world by merely being connected: the client asks (IntentKind.EnterWorld)
		if (!link.wantsWorld) return;
		const save = options.saveOf(player);
		if (link.slot !== undefined) {
			// already in the world: the session may have swapped the save table (admin edit, reload)
			const sp = sim.get(link.slot);
			if (sp !== undefined && save !== undefined && adoptSave(sp, save)) {
				print(`[${GAME_NAME}] ${player.Name}: save replaced by the session, slot ${link.slot} re-synced`);
			}
			return;
		}
		if (save === undefined) return;
		const slot = sim.freeSlot();
		if (slot === undefined) return; // server full: try again next pass
		const allies = new Array<{ x: number; y: number }>();
		for (const other of sim.players()) {
			if (!other.state.dead) allies.push({ x: other.state.x, y: other.state.y });
		}
		// MP-04: nobody enters the world inside the horde. The list is the LIVE one from F2 on — with an
		// empty list (MP_PHASE < 2, where each client has its own horde) the rule has nothing to test.
		const spawn = findSpawnPoint(world, { allies, zombies: sim.horde?.zombies ?? [] });
		const sp = createServerPlayer(
			{ slot, userId: player.UserId, name: player.DisplayName },
			save,
			spawn.x,
			spawn.y,
			sim.tick,
			sim.simHz,
		);
		sim.add(sp);
		link.slot = slot;
		bySlot.set(slot, player);
		replicator.welcome(sp);
		print(
			`[${GAME_NAME}] ${player.Name} joined the world in slot ${slot} at ` +
				`(${string.format("%.0f", spawn.x)}, ${string.format("%.0f", spawn.y)})${spawn.relaxed ? " (relaxed spawn)" : ""}`,
		);
	}

	/**
	 * Leaves the WORLD without leaving the server: the body goes away, the slot is freed and the other
	 * survivors are told, but the player stays connected with their save and can come back through PLAY.
	 */
	function leaveWorld(link: Link): void {
		const slot = link.slot;
		if (slot === undefined) return;
		link.slot = undefined;
		bySlot.delete(slot);
		sim.remove(slot);
		replicator.left(slot);
	}

	function release(player: Player): void {
		const link = links.get(player);
		links.delete(player);
		if (link === undefined || link.slot === undefined) return;
		const slot = link.slot;
		bySlot.delete(slot);
		sim.remove(slot);
		replicator.left(slot);
		if (options.metrics !== false) pcall(() => player.SetAttribute("pz_out_Bps", 0));
	}

	// ------------------------------------------------------------ C→S (§8.1, §8.2)

	/** a message from a player who is not in the world yet: rate-limit it, never act on it */
	function strangerFlood(link: Link, now: number): boolean {
		if (now - link.strangerStart >= FLOOD_MESSAGES_WINDOW_S || now < link.strangerStart) {
			link.strangerStart = now;
			link.strangerCount = 0;
		}
		link.strangerCount += 1;
		return link.strangerCount > FLOOD_MESSAGES;
	}

	const inputConn = onInput(remotes, (player, payload) => {
		const link = linkOf(player);
		const now = os.clock();
		if (link.slot === undefined) {
			if (strangerFlood(link, now)) kick(link, "input before joining the world");
			return;
		}
		const sp = sim.get(link.slot);
		if (sp === undefined) return;
		// the whole validation lives in the pure module (token bucket, decode, counters); a malformed payload
		// is dropped in silence (§9.2 level 0) and only ever counted
		const verdict = ingestInput(sp, payload, now);
		if (verdict !== InputVerdict.Ok || sp.counters.packets % 32 === 0) guardFlood(link, sp);
	});

	/**
	 * The only thing a client may ask about its own presence (§7.1): let me in, or take me out.
	 *
	 * Rate-limited like any message from someone without a slot, because flipping it fast would make the
	 * server spawn and despawn a body -- and each spawn costs a safe-point query. A repeat of what the
	 * player already is costs nothing and is simply ignored.
	 */
	const intentConn = onIntent(remotes, (player, payload) => {
		const link = linkOf(player);
		const now = os.clock();
		if (link.slot === undefined && strangerFlood(link, now)) {
			kick(link, "intent flood before joining the world");
			return;
		}
		const kind = decodeIntent(payload);
		if (kind === undefined) return;
		const wants = kind === IntentKind.EnterWorld;
		if (wants === link.wantsWorld) return;
		if (now - link.worldAt < WORLD_INTENT_COOLDOWN_S && now >= link.worldAt) return;
		link.worldAt = now;
		link.wantsWorld = wants;
		if (wants) admit(player);
		else leaveWorld(link);
	});

	const timeConn = onTimeSync(remotes, (player, payload) => {
		const link = linkOf(player);
		const now = os.clock();
		if (link.slot === undefined && strangerFlood(link, now)) {
			kick(link, "time sync before joining the world");
			return;
		}
		// §8.2 counts every message on every MP channel, so a probe flood also reaches the kick threshold
		const sp = link.slot !== undefined ? sim.get(link.slot) : undefined;
		if (sp !== undefined) {
			noteMessage(sp, now);
			guardFlood(link, sp);
		}
		const elapsed = math.max(0, now - link.timeAt);
		link.timeAt = now;
		link.timeTokens = math.min(TIME_SYNC_BURST, link.timeTokens + elapsed * TIME_SYNC_RATE);
		if (link.timeTokens < 1) return;
		link.timeTokens -= 1;
		const ping = decodeTimePing(payload);
		if (ping === undefined) {
			if (sp !== undefined) {
				noteMalformed(sp, now);
				guardFlood(link, sp);
			}
			return;
		}
		const pong = encodeTimePong({
			seq: ping.seq,
			clientTime: ping.clientTime,
			serverTime: Workspace.GetServerTimeNow(),
			serverTick: sim.tick,
		});
		if (pong !== undefined) sendTimePong(remotes, player, pong);
	});

	// ------------------------------------------------------------ metrics and anomaly log (§9.3, §12.2)

	function publishMetrics(player: Player, sp: ServerPlayer, link: Link, now: number): void {
		// §2.3: the rewind ceiling is the ping the SERVER measured, never one the client declares. Once a
		// second is plenty — it only ever caps the compensation, and leaving it at 0 compensates less.
		const [pingOk, ping] = pcall(() => player.GetNetworkPing());
		if (pingOk && typeIs(ping, "number")) sim.combat?.setPing(sp.slot, ping);
		const bytes = replicator.takeBytes(sp.slot);
		if (options.metrics !== false) {
			pcall(() => player.SetAttribute("pz_out_Bps", math.floor(bytes / METRIC_INTERVAL)));
		}
		const c = sp.counters;
		const newOverflow = c.inputOverflow - link.reportedOverflow;
		const newMalformed = c.malformed - link.reportedMalformed;
		if ((newOverflow > 0 || newMalformed > 0) && now - link.lastAnomalyLog >= ANOMALY_LOG_INTERVAL) {
			link.lastAnomalyLog = now;
			link.reportedOverflow = c.inputOverflow;
			link.reportedMalformed = c.malformed;
			warn(
				`[${GAME_NAME}] input anomaly ${player.Name} (${player.UserId}): ` +
					`+${newOverflow} overflow, +${newMalformed} malformed, ` +
					`+${c.rateDropped} rate-dropped, depth ${sp.queue.size()}, filled ${c.filled}`,
			);
		}
	}

	// ------------------------------------------------------------ the loop (§3.1)

	let admitAt = 0;
	let metricAt = 0;
	let lastError = "";

	const heartbeat = RunService.Heartbeat.Connect(dt => {
		const now = os.clock();
		const [ok, err] = pcall(() => {
			if (now - admitAt >= ADMIT_INTERVAL) {
				admitAt = now;
				for (const player of Players.GetPlayers()) admit(player);
			}
			const started = os.clock();
			const ran = sim.advance(dt);
			if (ran > 0) sim.sample(((os.clock() - started) * 1000) / ran);
			if (now - metricAt >= METRIC_INTERVAL) {
				metricAt = now;
				if (options.metrics !== false) {
					Workspace.SetAttribute("pz_tick_avg_ms", sim.avgMs());
					Workspace.SetAttribute("pz_tick_p95_ms", sim.p95Ms());
					Workspace.SetAttribute("pz_sim_players", sim.count());
					Workspace.SetAttribute("pz_dropped_ticks", sim.stats.droppedTicks);
					// what a playtest reads off the server window to know the world is actually running
					Workspace.SetAttribute("pz_zombies", sim.horde?.count() ?? 0);
					Workspace.SetAttribute("pz_world_day", sim.clock.day);
					Workspace.SetAttribute("pz_day_time", sim.clock.dayTime);
				}
				for (const [player, link] of links) {
					if (link.slot === undefined) continue;
					const sp = sim.get(link.slot);
					if (sp !== undefined) publishMetrics(player, sp, link, now);
				}
			}
		});
		if (!ok) {
			const message = tostring(err);
			if (message !== lastError) {
				lastError = message;
				warn(`[${GAME_NAME}] simulation tick failed: ${message}`);
			}
		}
	});

	const addedConn = Players.PlayerAdded.Connect(player => linkOf(player));
	const removingConn = Players.PlayerRemoving.Connect(player => release(player));
	for (const player of Players.GetPlayers()) linkOf(player);

	print(`[${GAME_NAME}] MP host up: ${sim.simHz} Hz, ${MAX_PLAYERS} slots, map hash ${mapHashOf(world)}`);

	let stopped = false;
	const host: MpHost = {
		simulation: sim,
		replicator,
		remotes,
		world,
		playerOf(player) {
			const link = links.get(player);
			return link !== undefined && link.slot !== undefined ? sim.get(link.slot) : undefined;
		},
		anomalies() {
			const rows = new Array<MpAnomalyRow>();
			for (const sp of sim.players()) {
				rows.push({
					slot: sp.slot,
					userId: sp.userId,
					name: sp.name,
					depth: sp.queue.size(),
					counters: sp.counters,
				});
			}
			return rows;
		},
		stop() {
			if (stopped) return;
			stopped = true;
			heartbeat.Disconnect();
			inputConn.Disconnect();
			intentConn.Disconnect();
			timeConn.Disconnect();
			addedConn.Disconnect();
			removingConn.Disconnect();
			const inWorld = new Array<Player>();
			for (const [, player] of bySlot) inWorld.push(player);
			for (const player of inWorld) release(player);
			links.clear();
			bySlot.clear();
			destroyMpRemotes(remotes);
			if (active === host) active = undefined;
		},
	};
	active = host;
	return host;
}
