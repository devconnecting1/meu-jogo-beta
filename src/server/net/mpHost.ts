/*
 * Boot glue of the authoritative server (docs/MULTIPLAYER.md §3.1, §4, §7.1, §8). SERVER ONLY.
 *
 * This is the only file of the F1 server front that touches Roblox: it owns the remotes, the Heartbeat loop and
 * the Player lifecycle, and hands everything else to the pure modules (server/sim/*, server/net/interest.ts,
 * server/net/replication.ts). server/main.server.ts only calls startMpHost() when MP_PHASE >= 1, so with
 * MP_PHASE = 0 not even the remote instances exist and the current single-player game is untouched.
 *
 * Who is alive is NOT decided here: every body — in the world, in the lobby, or kept 5 min after a disconnect —
 * belongs to server/sim/life.ts (`LifeKeeper`), which this file only feeds with Players mapped to UserIds. That
 * split is what closed the Leave/Enter revive (security review, Sep 2026): entering the world used to build a
 * fresh, full, living body every time.
 *
 * Order per Heartbeat (§3.1):
 *   1. admit players whose save finished loading (§7.1: safe spawn point, MP-04)
 *   2. sim.advance(dt) → one fixed tick per 1/SIM_HZ, at most MAX_CATCHUP_TICKS per heartbeat
 *   3. per tick, the replicator flushes the reliable World batch and (every 3 ticks) the snapshots
 *   4. the bodies' own clock (`lives.step`): daybreak, the 5 min memory, the wipe window — and, when that window
 *      closes on a world with nobody alive, the end of that world and a new town on day 1 (MP-22, server/sim/
 *      worldReset.ts)
 *   5. once a second, publish the §12.2 metrics: the tick's average and p95, the backlog, the dropped ticks, the ticks
 *      that threw (`pz_tick_errors`) and what each phase of the tick costs (`pz_cost_<phase>_ms`, server/sim/metrics.ts)
 *      -- as Workspace attributes, and to the admin panel's Server info (`metrics()`)
 *
 * Every phase of the tick is also a named MicroProfiler bar (`PZ.*`, `debug.profilebegin`), and the simulation's memory
 * is its own category (`PZ.sim`) in the Developer Console.
 */
import { GAME_NAME } from "shared/module";
import { DESIGN } from "shared/engine/constants";
import { TITLES } from "shared/data/titles";
import { floodKickMessage, langTypeOfLocale } from "shared/data/rules";
import {
	FLOOD_MALFORMED,
	FLOOD_MALFORMED_WINDOW_S,
	FLOOD_MESSAGES,
	FLOOD_MESSAGES_WINDOW_S,
	FLOOD_RATE_WINDOW_S,
	MAX_PLAYERS,
	TIME_SYNC_BURST,
	TIME_SYNC_RATE,
	WORLD_SEED_ATTRIBUTE,
} from "shared/net/mpConfig";
import { IntentKind, decodeIntentMessage, decodeTimePing, encodeTimePong, isBackpackIntent } from "shared/net/protocol";
import { SHOP_FLOOD_CALLS } from "shared/net/shopGuard";
import { PlayerSaveData } from "shared/game/save";
import type { SimMetrics } from "shared/admin/protocol";
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
	floodReason,
	ingestInput,
	noteMalformed,
	noteMessage,
	SPAWN_MIN_ZOMBIE,
} from "../sim/players";
import { creditFirstSteps } from "../save/achievements";
import { LifeKeeper, WipeReport } from "../sim/life";
import { ServerSimulation } from "../sim/simulation";
import { TownState, WorldEnd, endWorld } from "../sim/worldReset";
import { newPhaseCosts, SIM_PHASES, SimProfiler } from "../sim/metrics";
import * as Analytics from "../analytics/events";

const Players = game.GetService("Players");
const RunService = game.GetService("RunService");
const Workspace = game.GetService("Workspace");

/** a survivor hit this recently (os.clock seconds) is still in the fight: no trip to another town (`keptInDanger`) */
export const KEPT_HURT_S = 10;
/** how often the host looks for players whose save has just finished loading (seconds) */
const ADMIT_INTERVAL = 0.5;
/** how often the §12.2 metrics are published (seconds) */
const METRIC_INTERVAL = 1;
/** an anomaly line is logged at most this often per player, so a cheater cannot spam the server log */
const ANOMALY_LOG_INTERVAL = 10;
/**
 * A world reset's new town is generated this many seconds of work per frame at most (MP-22; review of ea5cf71): a
 * town is ~150 buildings planned room by room, a second or more of Luau, and the heartbeat, the lobby and the
 * network go on meanwhile. Everyone in the world that ended is down, so the wait costs nobody a thing.
 */
const RESET_SLICE_S = 0.008;
/** the attribute each phase's cost is published under, in SIM_PHASES order (built once: no string per second) */
const COST_ATTRIBUTES = SIM_PHASES.map(phase => `pz_cost_${phase}_ms`);

/** milliseconds to three decimals: what an attribute and the admin panel show */
function roundMs(ms: number): number {
	return math.floor(ms * 1000 + 0.5) / 1000;
}

export interface MpHostOptions {
	/**
	 * The live save of a connected player, or undefined while it is still loading / the session is closed.
	 * server/main.server.ts owns the sessions; the host never reads the DataStore itself.
	 */
	saveOf: (player: Player) => PlayerSaveData | undefined;
	/**
	 * May this player's body enter the city now (asked right before `lives.enter`, only there)? server/main.server.ts
	 * asks server/match/matchHost.ts: not while a trip of theirs is in flight, not before a solo / private town knows
	 * the day it opens on. A hold here never hides the save: rule 6 and the kept body still see it (second review,
	 * LOW 2 -- a hold inside `saveOf` let a world end without the traveller, whose kept body was lost). Omitted: yes.
	 */
	mayEnter?: (player: Player) => boolean;
	/** the shared town; generated from `seed` when omitted (client and server build the same map, §4.5) */
	world?: WorldData;
	/** the seed of the first town (DESIGN.TOWN_SEED by default): InitBegin tells every client which it is (MP-22) */
	seed?: number;
	/** false disables the periodic metric attributes (used by tests) */
	metrics?: boolean;
	/**
	 * The server wrote into this survivor's save on its own (a death, a stand-up, the body banked on the way out):
	 * the session must persist it. server/main.server.ts marks the session dirty.
	 */
	saveChanged?: (userId: number) => void;
	/**
	 * The world ended: everybody in it died and nobody paid a Rebirth inside the decision window (server/sim/life.ts
	 * rule 6), and the host has ALREADY replaced it with a new town on day 1 and given the fallen a new life in it
	 * (MP-22, server/sim/worldReset.ts). `outcome.ended` is the record to keep: server/main.server.ts persists it
	 * (server/save/worldLog.ts). Fired once per world.
	 */
	onWorldWiped?: (report: WipeReport, outcome: WorldEnd) => void;
	/**
	 * (§8.2, audit L4) The host just kicked this player for a network flood, for `reason` (the counters that crossed,
	 * written by the server). server/main.server.ts writes it to the admin audit log -- by UserId only, like the rest
	 * of that log -- so a human can review every automatic kick after the fact (MP-16).
	 */
	onFloodKick?: (player: Player, reason: string) => void;
}

/** one line of the §9.3 / F6 admin view: who the player is and what their counters say */
export interface MpAnomalyRow {
	slot: number;
	userId: number;
	name: string;
	/** current input queue depth (§2.2) */
	depth: number;
	counters: InputCounters;
	/**
	 * MP-16 level 1 (§9.2 "sinalizar"): shots whose declared view the rewind had to move -- past the measured ping
	 * ceiling, or away from where this survivor's view normally sits (server/sim/combat.ts `judge`) -- out of how
	 * many it resolved. An honest client is not clamped (tools/test-combat.mjs c''); evidence, never an action.
	 */
	rewindClamped: number;
	shots: number;
}

export interface MpHost {
	simulation: ServerSimulation;
	replicator: Replicator;
	remotes: MpRemotes;
	/** the town the server is running NOW: it is replaced when a world ends (MP-22) */
	world: WorldData;
	/** the seed `world` was generated from (DESIGN.TOWN_SEED until the first world ends) */
	seed: number;
	/** every survivor's body, in the world and out of it: death, daybreak, Rebirth, New game (server/sim/life.ts) */
	lives: LifeKeeper;
	/** the server entity of a connected player, or undefined when they are not in the world */
	playerOf(player: Player): ServerPlayer | undefined;
	/**
	 * The client asked to be in the world (EnterWorld) and has not asked to leave -- admitted or about to be. A trip to a
	 * town of one's own starts only from the lobby (server/match/travel.ts): this closes the half second between the
	 * intent and the admission.
	 */
	wantsWorld(player: Player): boolean;
	/**
	 * This server keeps the player's LIVING body where they left the city (§7.2: frozen, exactly as it was), and that
	 * spot is not safe: a zombie or a boss within the safe-spawn radius of it (SPAWN_MIN_ZOMBIE, MP-04), or a hit taken
	 * less than KEPT_HURT_S ago. A trip to a town of one's own is refused then (server/match/travel.ts `danger`,
	 * review H1): Leave + Play solo was a free, instant escape from a fight, with a fresh spawn and its shield.
	 */
	keptInDanger(player: Player): boolean;
	/**
	 * A solo or private town opens on its owner's LIFE day (MP-13): the clock restarts on `day` at 07:00, before anybody
	 * has stood in this town. False (and nothing changes) once a body has entered it. The world's record (MP-22) counts
	 * the days it lasted from this day on (server/sim/worldReset.ts `startDay`); a world that ends here is followed by a
	 * new town on day 1, as everywhere.
	 */
	startTownOn(day: number): boolean;
	/** dead as far as the SERVER knows (in the world, in the lobby, or — never seen here — as the save says) */
	isDead(player: Player, save: PlayerSaveData): boolean;
	/**
	 * A paid Rebirth the economy accepted: up now if the body is in the world, on the next entry otherwise.
	 *
	 * The save says the run continues; this is what makes the SIMULATED survivor agree. Without it the coins were
	 * spent, `runOver` went false, and the body stayed dead.
	 */
	rebirth(player: Player, save: PlayerSaveData): void;
	/** a New game the economy accepted (after `resetRun`): a new life whose body still waits for daybreak */
	newLife(player: Player, save: PlayerSaveData): void;
	/**
	 * The player is leaving the server: out of the world, and the body banked into `save` (§7.2) — runHp,
	 * runHunger, runOver, the magazine back into the reserve. Idempotent. server/main.server.ts calls it BEFORE its
	 * final flush, because the two PlayerRemoving handlers run in no guaranteed order.
	 */
	release(player: Player, save?: PlayerSaveData): void;
	/** the live body into `save`, without moving it (the autosave); true when the save changed */
	settle(player: Player, save: PlayerSaveData): boolean;
	/**
	 * The player's save has just finished loading, and its LoadAck has not gone out yet (server/main.server.ts): the
	 * body the server kept catches up with it — a reconnect reconciled, and a new life a world that ended while they
	 * were away owed them (MP-22) — so the client's first look at its save is the truth. True when it changed.
	 */
	adopt(player: Player, save: PlayerSaveData): boolean;
	/**
	 * A retry just loaded the real save of a session that had been playing on the blank, read-only one (status
	 * "error"): what the body lived through on that blank table is nobody's, and is forgotten (server/sim/life.ts
	 * `forgetUnsaved`; review of de4ba1e, R3b). Call it BEFORE `adopt`. True when something was dropped.
	 */
	forgetUnsaved(player: Player, blank: PlayerSaveData): boolean;

	/** every survivor's anomaly counters, ready for the F6 admin panel (§9.3) */
	anomalies(): Array<MpAnomalyRow>;
	/**
	 * (§8.2, audit M2) One message from `player` on a remote this host does not own -- SaveRequest, LoadRequest,
	 * ShopAction, the admin remotes -- counted against the same flood limits as its own (`malformed`: a payload that is
	 * not what that remote takes). True when the message must be dropped: the player is being kicked, or has left.
	 * Call it FIRST in every handler, before the payload is read. `channel` "shop": a ShopAction that takes a token,
	 * also counted against that channel's own line (§8.2 "> 3× o limite por 5 s": SHOP_FLOOD_CALLS in
	 * FLOOD_RATE_WINDOW_S, shared/net/shopGuard.ts) -- 300 purchases in a few seconds are far under the 500 messages of
	 * the connection's line, and were never kicked.
	 */
	noteRemote(player: Player, malformed: boolean, channel?: "shop"): boolean;
	/** the §12.2 numbers as last published (once a second): the admin panel's Server info shows them */
	metrics(): SimMetrics;
	/** stops the simulation and banks every body into its save (§7.2 "Servidor desligando") */
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
	/** ...and the malformed ones among them (§8.2's second limit; in the world the ServerPlayer counts both) */
	strangerBadStart: number;
	strangerBadCount: number;
	/** token-taking ShopActions in the current FLOOD_RATE_WINDOW_S window, in the world or not (§8.2, `noteRemote`) */
	shopStart: number;
	shopCount: number;
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
	reportedClamped: number;
}

export function startMpHost(options: MpHostOptions): MpHost {
	// a second host would fight the first one for the remotes and the Heartbeat: the newest one wins
	if (active !== undefined) active.stop();
	/** the world running now: its seed and when it began (MP-22 records it when it ends) */
	let town: TownState = { seed: options.seed ?? DESIGN.TOWN_SEED, startedAt: os.time() };
	const world = options.world ?? generateTown(town.seed);
	/** a body has stood in this town (the start day of a solo / private town is settled then, MP-13) */
	let townEntered = false;
	/** os.clock() of the last hit each survivor took in the city, by UserId (`keptInDanger`; a rejoin keeps it) */
	const hurtAt = new Map<number, number>();
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
		// the real clock: a client retires a track by real time, and ticks are not real time on a slow server
		{ tick0Time, mapHash: mapHashOf(world), seed: town.seed, now: () => os.clock() },
	);
	sim.onTick = tick => replicator.afterTick(tick);
	// every cosmetic the simulation asks for goes out on the Fx channel, filtered by interest (§4.1, §4.3)
	sim.onFx = event => replicator.queueFx(event);

	const lives = new LifeKeeper(sim, {
		welcome(sp) {
			replicator.welcome(sp);
		},
		left(slot) {
			replicator.left(slot);
		},
		life(slot, state) {
			replicator.life(slot, state);
		},
	});
	// the death goes out reliably (§4.5), `runOver` goes into the save the same tick, and the daybreak countdown
	// starts — on every server kind (server/sim/life.ts rules 4 and 5)
	sim.onDeath = sp => lives.died(sp);
	lives.onSaveChanged = userId => options.saveChanged?.(userId);
	// MON-05: a title was earned (the save has it already): the survivor hears it on the reliable channel, and the
	// session writes it -- a title must not wait for the next report to reach the DataStore
	sim.onTitleUnlocked = (sp, titleId) => {
		replicator.titleUnlocked(sp.slot, titleId);
		options.saveChanged?.(sp.userId);
		Analytics.titleEarned(sp.save, titleId);
		print(`[${GAME_NAME}] ${sp.name} earned the title ${TITLES[titleId]?.name ?? titleId}`);
	};
	lives.onStandUp = (sp, why) => {
		print(
			`[${GAME_NAME}] ${sp.name} is back on their feet (${why}) in slot ${sp.slot} at ` +
				`(${string.format("%.0f", sp.state.x)}, ${string.format("%.0f", sp.state.y)})`,
		);
	};

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
				strangerBadStart: 0,
				strangerBadCount: 0,
				shopStart: 0,
				shopCount: 0,
				wantsWorld: false,
				worldAt: 0,
				kicked: false,
				lastAnomalyLog: 0,
				reportedOverflow: 0,
				reportedMalformed: 0,
				reportedClamped: 0,
			};
			links.set(player, link);
			// a body kept from a disconnect a moment ago stops expiring (§7.2)
			lives.connect(player.UserId);
		}
		return link;
	}

	/**
	 * A message from a Player instance that has already left the server (a remote still in flight when PlayerRemoving
	 * ran). Acting on it would recreate the link — and `lives.connect` would stop the kept body from ever expiring,
	 * or a rejoined player's NEW session would be steered by the old instance's leftovers.
	 */
	function departed(player: Player): boolean {
		return !links.has(player) && player.Parent === undefined;
	}

	/** another, newer Player instance of the same user is connected (a rejoin overtook this one's removal) */
	function supersededBy(player: Player): boolean {
		for (const [other] of links) {
			if (other !== player && other.UserId === player.UserId) return true;
		}
		return false;
	}

	function kick(link: Link, reason: string): void {
		if (link.kicked) return;
		link.kicked = true;
		const player = link.player;
		// one Error Report row for every flood kick (docs/ANALYTICS.md §10): who, and the counts, go to the log line
		warn(`[${GAME_NAME}] kicking a player: network flood`);
		print(`[${GAME_NAME}] flood kick: ${player.Name} (${player.UserId}), ${reason}`);
		// what the player reads, in their account's language (lang.ts, shared/data/rules.ts)
		const message = floodKickMessage(langTypeOfLocale(player.LocaleId));
		pcall(() => player.Kick(message));
		// §8.2 "registrado" (audit L4): into the admin audit log, for a human to review (MP-16)
		const audit = options.onFloodKick;
		if (audit !== undefined) pcall(() => audit(player, reason));
	}

	/** §8.2: the automatic kick, checked after EVERY message, accepted or not */
	function guardFlood(link: Link, sp: ServerPlayer): void {
		const reason = floodReason(sp);
		if (reason !== undefined) kick(link, reason);
	}

	/** §7.1: enter the world once the save is available — with the body the server kept, or one from the save */
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
		// held by where the survivor plays (a trip in flight, a town whose day is not settled): the next pass tries again
		const mayEnter = options.mayEnter;
		if (mayEnter !== undefined && !mayEnter(player)) return;
		const sp = lives.enter({ userId: player.UserId, name: player.DisplayName }, save);
		if (sp === undefined) return; // server full: try again next pass
		townEntered = true;
		link.slot = sp.slot;
		bySlot.set(sp.slot, player);
		// CON-04 First steps: the server stood a body of this survivor in the town (once; the wallet push carries it)
		creditFirstSteps(save);
		Analytics.enteredWorld(player);
		print(
			`[${GAME_NAME}] ${player.Name} joined the world in slot ${sp.slot} at ` +
				`(${string.format("%.0f", sp.state.x)}, ${string.format("%.0f", sp.state.y)})` +
				`${sp.state.dead ? " (dead: waiting for daybreak or a Rebirth)" : ""}`,
		);
	}

	/**
	 * Leaves the WORLD without leaving the server: the body goes away (and is KEPT, exactly as it was), the slot
	 * is freed and the other survivors are told, but the player stays connected with their save and can come back
	 * through PLAY.
	 */
	function leaveWorld(link: Link): void {
		const slot = link.slot;
		if (slot === undefined) return;
		link.slot = undefined;
		bySlot.delete(slot);
		lives.leave(link.player.UserId);
	}

	function release(player: Player, save?: PlayerSaveData): void {
		const link = links.get(player);
		links.delete(player);
		const bank =
			save ?? options.saveOf(player) ?? (link?.slot !== undefined ? sim.get(link.slot)?.save : undefined);
		if (link !== undefined) {
			const wasIn = link.slot !== undefined;
			leaveWorld(link);
			if (wasIn && options.metrics !== false) pcall(() => player.SetAttribute("pz_out_Bps", 0));
		}
		// idempotent: main.server.ts calls this with the session's save before its flush, and the PlayerRemoving
		// handler below calls it again (or first) — whichever runs second finds nothing left to do. Keyed by UserId,
		// so a removal that arrives after the same user already rejoined (main.server.ts may wait up to 60 s for a
		// load) must leave the new session's body alone.
		if (supersededBy(player)) return;
		lives.disconnect(player.UserId, bank);
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

	/** a malformed payload from a player who is not in the world yet (§8.2: > 50 in 10 s) */
	function strangerMalformed(link: Link, now: number): boolean {
		if (now - link.strangerBadStart >= FLOOD_MALFORMED_WINDOW_S || now < link.strangerBadStart) {
			link.strangerBadStart = now;
			link.strangerBadCount = 0;
		}
		link.strangerBadCount += 1;
		return link.strangerBadCount > FLOOD_MALFORMED;
	}

	/** one token-taking ShopAction (§8.2: more than SHOP_FLOOD_CALLS in FLOOD_RATE_WINDOW_S is a flood) */
	function shopFlood(link: Link, now: number): boolean {
		if (now - link.shopStart >= FLOOD_RATE_WINDOW_S || now < link.shopStart) {
			link.shopStart = now;
			link.shopCount = 0;
		}
		link.shopCount += 1;
		return link.shopCount > SHOP_FLOOD_CALLS;
	}

	/**
	 * §8.2 for one message on any remote (audit M2): in the world it is the survivor's counters, the same the Input
	 * and the TimeSync feed (so the limits are for the whole connection, not one channel); out of it, the link's own
	 * windows. Crossing either limit is the automatic kick. True when the message must be dropped (kicked).
	 */
	function noteMessageOf(link: Link, now: number, malformed: boolean): boolean {
		if (link.kicked) return true;
		const sp = link.slot !== undefined ? sim.get(link.slot) : undefined;
		if (sp !== undefined) {
			noteMessage(sp, now);
			if (malformed) noteMalformed(sp, now);
			guardFlood(link, sp);
			return link.kicked;
		}
		if (strangerFlood(link, now)) {
			kick(link, `${link.strangerCount} messages in ${FLOOD_MESSAGES_WINDOW_S}s outside the world`);
		} else if (malformed && strangerMalformed(link, now)) {
			kick(link, `${link.strangerBadCount} malformed payloads in ${FLOOD_MALFORMED_WINDOW_S}s outside the world`);
		}
		return link.kicked;
	}

	/** os.clock() when the last Heartbeat began: how late the next one is, for the input queue's grace */
	let beatAt = os.clock();

	const inputConn = onInput(remotes, (player, payload) => {
		if (departed(player)) return;
		const link = linkOf(player);
		const now = os.clock();
		if (link.slot === undefined) {
			if (strangerFlood(link, now)) kick(link, "input before joining the world");
			return;
		}
		const sp = sim.get(link.slot);
		if (sp === undefined) return;
		// the whole validation lives in the pure module (token bucket, decode, counters); a malformed payload
		// is dropped in silence (§9.2 level 0) and only ever counted. The grace is the SERVER's lateness: the
		// commands for the ticks it owes, while it is repaying them, are kept for the repayment instead of capped
		// (server/sim/heartbeat.ts)
		const verdict = ingestInput(sp, payload, now, sim.inputGrace(now - beatAt));
		if (verdict !== InputVerdict.Ok || sp.counters.packets % 32 === 0) guardFlood(link, sp);
	});

	/**
	 * The only thing a client may ask about its own presence (§7.1): let me in, or take me out.
	 *
	 * Rate-limited like any message from someone without a slot, because flipping it fast would make the
	 * server spawn and despawn a body -- and each spawn costs a safe-point query. A repeat of what the
	 * player already is costs nothing and is simply ignored. Flipping it buys nothing else either: the body that
	 * comes back is the body that left (server/sim/life.ts rule 1), dead or alive, where it stood.
	 */
	const intentConn = onIntent(remotes, (player, payload) => {
		if (departed(player)) return;
		const link = linkOf(player);
		const now = os.clock();
		// EVERY Intent is counted here, presence or backpack verb, in the world or not (§8.2; the backpack's own handler,
		// server/net/backpackIntents.ts, only rate-limits and applies its verbs)
		const msg = decodeIntentMessage(payload);
		if (noteMessageOf(link, now, msg === undefined)) return;
		if (msg === undefined || isBackpackIntent(msg.kind)) return;
		const kind = msg.kind;
		const wants = kind === IntentKind.EnterWorld;
		if (wants === link.wantsWorld) return;
		/*
		 * The wish is recorded FIRST and unconditionally, and only the acting on it is rate-limited.
		 *
		 * Restarting a run sends LeaveWorld and EnterWorld in the same frame (client/main.client.ts:
		 * `stopGame` then `mountRun`), and dropping the second one because it arrived inside the cooldown
		 * left `wantsWorld` false -- so the periodic `admit` pass refused to spawn the survivor too and the
		 * player came out of "New game" with no body on the server at all, until they walked out to the
		 * lobby and back. What the cooldown is actually for is the COST of entering (a safe-spawn query),
		 * and that cost is already bounded: `admit` runs at most once per ADMIT_INTERVAL and only ever
		 * spawns a survivor who has no slot, so a client flipping the intent fast gains nothing by it.
		 */
		link.wantsWorld = wants;
		if (!wants) {
			link.worldAt = now;
			leaveWorld(link);
			return;
		}
		if (now - link.worldAt < WORLD_INTENT_COOLDOWN_S && now >= link.worldAt) return;
		link.worldAt = now;
		admit(player);
	});

	const timeConn = onTimeSync(remotes, (player, payload) => {
		if (departed(player)) return;
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
		// through the simulation, which keeps the filtered value across a leave/enter and a new town (N4)
		if (pingOk && typeIs(ping, "number")) sim.setPing(sp, ping);
		const bytes = replicator.takeBytes(sp.slot);
		if (options.metrics !== false) {
			pcall(() => player.SetAttribute("pz_out_Bps", math.floor(bytes / METRIC_INTERVAL)));
		}
		const c = sp.counters;
		const newOverflow = c.inputOverflow - link.reportedOverflow;
		const newMalformed = c.malformed - link.reportedMalformed;
		// MP-16 level 1: a declared view the rewind had to move (server/sim/combat.ts `judge`) is evidence, not guilt
		const fight = sp.slot >= 0 ? sim.combat?.statsOf(sp.slot) : undefined;
		const clamped = fight?.rewindClamped ?? 0;
		const newClamped = clamped - link.reportedClamped;
		if (
			(newOverflow > 0 || newMalformed > 0 || newClamped > 0) &&
			now - link.lastAnomalyLog >= ANOMALY_LOG_INTERVAL
		) {
			link.lastAnomalyLog = now;
			link.reportedOverflow = c.inputOverflow;
			link.reportedMalformed = c.malformed;
			link.reportedClamped = clamped;
			// the Error Report counts how often; the counts themselves are the log line after it (docs/ANALYTICS.md §10)
			warn(`[${GAME_NAME}] input anomaly: overflow, malformed or clamped input`);
			print(
				`[${GAME_NAME}] input anomaly ${player.Name} (${player.UserId}): ` +
					`+${newOverflow} overflow, +${newMalformed} malformed, ` +
					`+${c.rateDropped} rate-dropped, depth ${sp.queue.size()}, filled ${c.filled}, ` +
					`+${newClamped} rewind clamped (${clamped} of ${fight?.shots ?? 0} shots)`,
			);
		}
	}

	// ------------------------------------------------------------ the loop (§3.1)

	let admitAt = 0;
	let metricAt = 0;
	let lastError = "";
	/**
	 * Heartbeats whose work threw, since boot (`pz_tick_errors`). A repeat of the last message is not logged again, so
	 * this is the only place a steady failure shows how often it happens.
	 */
	let tickErrors = 0;
	let tickErrorsAt = 0;
	/** xpcall's handler for the tick: the error with the stack it was raised on, so the log says where (F6) */
	const tickTrace = (err: unknown): string => debug.traceback(tostring(err), 2);

	// ------------------------------------------------------------ what the tick costs (§12.2, F6)

	/**
	 * MicroProfiler labels open right now. Every `begin` of the simulation has its `end` on the same path, but a tick
	 * that throws leaves the ones it was inside open: the heartbeat closes them, or every later frame would nest under
	 * the bar of the tick that failed.
	 */
	let profileDepth = 0;
	const profiler: SimProfiler = {
		begin(label) {
			debug.profilebegin(label);
			profileDepth += 1;
		},
		end() {
			if (profileDepth <= 0) return;
			profileDepth -= 1;
			debug.profileend();
		},
	};
	// os.clock is the per-phase clock the pure modules were waiting for (`nowMs`): until now only the tests set it
	sim.instrument(() => os.clock() * 1000, profiler);
	const phaseMs = newPhaseCosts();
	const published: SimMetrics = {
		tickAvgMs: 0,
		tickP95Ms: 0,
		backlogMs: 0,
		droppedTicks: 0,
		tickErrors: 0,
		zombies: 0,
		phases: SIM_PHASES.map(name => ({ name, ms: 0 })),
	};

	/** once a second: the tick's numbers into `published`, and (unless the options say not to) the attributes */
	function publishTick(): void {
		sim.takeCosts(phaseMs);
		published.tickAvgMs = roundMs(sim.avgMs());
		published.tickP95Ms = roundMs(sim.p95Ms());
		published.backlogMs = math.floor(sim.backlogS() * 1000 + 0.5);
		published.droppedTicks = sim.stats.droppedTicks;
		published.tickErrors = tickErrors;
		published.zombies = sim.horde?.count() ?? 0;
		for (let i = 0; i < SIM_PHASES.size(); i++) published.phases[i].ms = roundMs(phaseMs[SIM_PHASES[i]]);
		if (options.metrics === false) return;
		Workspace.SetAttribute("pz_tick_avg_ms", sim.avgMs());
		Workspace.SetAttribute("pz_tick_p95_ms", sim.p95Ms());
		Workspace.SetAttribute("pz_tick_errors", tickErrors);
		Workspace.SetAttribute("pz_sim_players", sim.count());
		Workspace.SetAttribute("pz_dropped_ticks", sim.stats.droppedTicks);
		// the Heartbeat debt still being repaid right now (§3.1): next to the dropped ticks in [PZ-NET]
		Workspace.SetAttribute("pz_backlog_ms", published.backlogMs);
		// what a playtest reads off the server window to know the world is actually running
		Workspace.SetAttribute("pz_zombies", published.zombies);
		Workspace.SetAttribute("pz_world_day", sim.clock.day);
		Workspace.SetAttribute("pz_day_time", sim.clock.dayTime);
		// MP-21's stall counter (shared/sim/ai/population.ts PopulationStall), visible for a playtest
		Workspace.SetAttribute("pz_stall_s", sim.horde?.population.stall().current ?? 0);
		Workspace.SetAttribute("pz_stall_episodes", sim.horde?.population.stall().episodes ?? 0);
		// what each phase of the tick cost on average over the last second (server/sim/metrics.ts SIM_PHASES)
		for (let i = 0; i < SIM_PHASES.size(); i++) Workspace.SetAttribute(COST_ATTRIBUTES[i], published.phases[i].ms);
	}

	/** this heartbeat's clock reading and delta, for `beatBody` (hoisted: no closure is made per heartbeat) */
	let beatNow = 0;
	let beatDt = 0;
	const beatBody = (): void => {
		const now = beatNow;
		const dt = beatDt;
		if (now - admitAt >= ADMIT_INTERVAL) {
			admitAt = now;
			for (const player of Players.GetPlayers()) admit(player);
		}
		const started = os.clock();
		// the heartbeat after a world reset runs one tick and forgets the rest of its delta: that was the new
		// town's construction, not time the world lived (ServerSimulation.restartWorld, `advance`)
		const ran = sim.advance(dt);
		if (ran > 0) sim.sample(((os.clock() - started) * 1000) / ran);
		// who is being hit right now (the server's hit flash lasts a second after every hit): `keptInDanger`
		for (const [player, link] of links) {
			if (link.slot === undefined) continue;
			const hit = sim.get(link.slot);
			if (hit !== undefined && (hit.state.hitFlash ?? 0) > 0) hurtAt.set(player.UserId, now);
		}
		// the night the dead are waiting out ran in the same real seconds the sim just did (MP-21)
		lives.step(dt);
		if (now - metricAt >= METRIC_INTERVAL) {
			metricAt = now;
			publishTick();
			for (const [player, link] of links) {
				if (link.slot === undefined) continue;
				const sp = sim.get(link.slot);
				if (sp !== undefined) publishMetrics(player, sp, link, now);
			}
		}
	};

	const heartbeat = RunService.Heartbeat.Connect(dt => {
		const now = os.clock();
		// FIRST, outside the pcall: set after the admit loop, an admit that threw left it on the previous heartbeat, and
		// the queues' grace counted a whole frame the debt never received (the review of dee095a, N7)
		beatAt = now;
		beatNow = now;
		beatDt = dt;
		// what the simulation allocates is its own line in the Developer Console's memory categories (F6)
		debug.setmemorycategory("PZ.sim");
		const [ok, err] = xpcall(beatBody, tickTrace);
		// a tick that threw left the labels it was inside open (see `profiler`)
		while (profileDepth > 0) profiler.end();
		if (!ok) {
			tickErrors += 1;
			const message = tostring(err);
			if (message !== lastError) {
				lastError = message;
				// the running count is `pz_tick_errors` and the admin's metrics, never the message (one row per failure)
				warn(`[${GAME_NAME}] simulation tick failed: ${message}`);
			}
			// a tick that fails every time never reaches `publishTick`: the count goes out from here, once a second
			if (options.metrics !== false && now - tickErrorsAt >= METRIC_INTERVAL) {
				tickErrorsAt = now;
				pcall(() => Workspace.SetAttribute("pz_tick_errors", tickErrors));
			}
		}
		debug.resetmemorycategory();
	});

	const addedConn = Players.PlayerAdded.Connect(player => linkOf(player));
	const removingConn = Players.PlayerRemoving.Connect(player => release(player));
	for (const player of Players.GetPlayers()) linkOf(player);

	print(
		`[${GAME_NAME}] MP host up: ${sim.simHz} Hz, ${MAX_PLAYERS} slots, town seed ${town.seed}, ` +
			`map hash ${mapHashOf(world)}`,
	);
	// MP-22: which town this server runs, for a client building its town before it enters (client/net/netClient.ts
	// `netTownSeed`); InitBegin confirms it on entry
	pcall(() => Workspace.SetAttribute(WORLD_SEED_ATTRIBUTE, town.seed));

	let stopped = false;
	const host: MpHost = {
		simulation: sim,
		replicator,
		remotes,
		world,
		seed: town.seed,
		lives,
		playerOf(player) {
			const link = links.get(player);
			return link !== undefined && link.slot !== undefined ? sim.get(link.slot) : undefined;
		},
		wantsWorld(player) {
			const link = links.get(player);
			return link !== undefined && (link.wantsWorld || link.slot !== undefined);
		},
		keptInDanger(player) {
			const body = lives.keptBody(player.UserId);
			if (body === undefined || body.dead) return false;
			const hit = hurtAt.get(player.UserId);
			if (hit !== undefined && os.clock() - hit < KEPT_HURT_S) return true;
			const r2 = SPAWN_MIN_ZOMBIE * SPAWN_MIN_ZOMBIE;
			const horde = sim.horde;
			if (horde === undefined) return false;
			for (const z of horde.zombies) {
				if (z.hp <= 0) continue;
				const dx = z.x - body.x;
				const dy = z.y - body.y;
				if (dx * dx + dy * dy < r2) return true;
			}
			for (const b of horde.bossRoster.list) {
				if (b.dead) continue;
				const dx = b.x - body.x;
				const dy = b.y - body.y;
				if (dx * dx + dy * dy < r2) return true;
			}
			return false;
		},
		startTownOn(day) {
			if (townEntered) return false;
			const d = math.max(1, math.floor(day));
			if (d !== sim.clock.day) sim.clock.restart(d);
			town.startDay = d;
			return true;
		},
		isDead(player, save) {
			return lives.isDead(player.UserId, save);
		},
		rebirth(player, save) {
			lives.rebirth(player.UserId, save);
		},
		newLife(player, save) {
			lives.newLife(player.UserId, save);
		},
		release(player, save) {
			release(player, save);
		},
		settle(player, save) {
			return lives.settle(player.UserId, save);
		},
		adopt(player, save) {
			return lives.adopt(player.UserId, save);
		},
		forgetUnsaved(player, blank) {
			return lives.forgetUnsaved(player.UserId, blank);
		},
		noteRemote(player, malformed, channel) {
			if (departed(player)) return true;
			const link = linkOf(player);
			const now = os.clock();
			if (noteMessageOf(link, now, malformed)) return true;
			if (channel === "shop" && shopFlood(link, now)) {
				kick(link, `${link.shopCount} ShopActions in ${FLOOD_RATE_WINDOW_S}s`);
			}
			return link.kicked;
		},
		metrics() {
			// the counter moves between two publications (a tick that keeps failing never reaches `publishTick`)
			published.tickErrors = tickErrors;
			return published;
		},
		anomalies() {
			const rows = new Array<MpAnomalyRow>();
			for (const sp of sim.players()) {
				const fight = sim.combat?.statsOf(sp.slot);
				rows.push({
					slot: sp.slot,
					userId: sp.userId,
					name: sp.name,
					depth: sp.queue.size(),
					counters: sp.counters,
					rewindClamped: fight?.rewindClamped ?? 0,
					shots: fight?.shots ?? 0,
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
			// §7.2 "Servidor desligando": the simulation has stopped, so every body — in the world or kept in the
			// lobby — is banked into its save before server/main.server.ts writes them all
			const everyone = new Array<Player>();
			for (const [player] of links) everyone.push(player);
			for (const player of everyone) {
				// one body that cannot be banked leaves the others to be (F5)
				const [ok, err] = xpcall(() => release(player), tickTrace);
				if (!ok) warn(`[${GAME_NAME}] banking a body at shutdown failed: ${tostring(err)}`);
			}
			links.clear();
			bySlot.clear();
			destroyMpRemotes(remotes);
			if (active === host) {
				active = undefined;
				Analytics.bindWorld(undefined);
			}
		},
	};
	// the clock the Night funnel follows and where each player stands (docs/ANALYTICS.md): read once a second, inside
	// analytics' own guard -- nothing here is asked for on the tick
	Analytics.bindWorld({
		dayTime() {
			return sim.clock.dayTime;
		},
		day() {
			return sim.clock.day;
		},
		bodyOf(player) {
			return host.playerOf(player)?.state;
		},
		standing() {
			let n = 0;
			for (const sp of sim.players()) if (!sp.state.dead) n += 1;
			return n;
		},
	});

	/**
	 * The live, LOADED save of a connected player by UserId (the session's), or undefined. A user can have two links
	 * for a moment — the Player instance that is leaving and the one that just rejoined — and neither has a save
	 * while one closes and the other loads: the first link is not the answer, the first link WITH a save is (B1).
	 */
	function saveOfUser(userId: number): PlayerSaveData | undefined {
		for (const [player] of links) {
			if (player.UserId !== userId) continue;
			const save = options.saveOf(player);
			if (save !== undefined) return save;
		}
		return undefined;
	}
	// rule 6 counts only survivors whose save is really here (server/sim/life.ts `liveSave`)
	lives.liveSave = userId => saveOfUser(userId);

	function worldWiped(report: WipeReport): void {
		// rule 6: the single point where "nobody alive, nobody paying" is known — and MP-22 (the owner's decision of
		// 23 Sep 2026): that world is over. A new town from a new seed, day 1, and a new life for everyone who fell
		// a world ending is the game (MP-22), not a fault: the log, not the Error Report
		print(
			`[${GAME_NAME}] the world is lost on day ${report.day} (${report.reason}): ` +
				`${report.dead.size()} survivor(s) down and nobody paid a Rebirth`,
		);
		const previous = sim.world;
		const now = os.time();
		// the generator calls this between two buildings: past RESET_SLICE_S of work in this frame it waits for the
		// next one. A host stopped meanwhile (the server shutting down) abandons the reset before anything changed
		let sliceStart = os.clock();
		let frames = 1;
		const pace = () => {
			if (stopped) error("the host stopped");
			if (os.clock() - sliceStart < RESET_SLICE_S) return;
			task.wait();
			frames += 1;
			sliceStart = os.clock();
			if (stopped) error("the host stopped");
		};
		const [returned, result] = pcall(() =>
			endWorld({ sim, lives, replicator }, report, town, {
				now,
				job: game.JobId,
				saveOf: saveOfUser,
				clock: () => os.clock(),
				pace,
				// the reset is committed the moment the simulation stands in the new town (review of de4ba1e, N2): the
				// host names THAT town at once — seed, map, the attribute a joining client builds from — whatever fails
				// after it
				onSwitched: newTown => {
					town = { seed: newTown.seed, startedAt: now };
					townEntered = true;
					host.world = newTown.world;
					host.seed = newTown.seed;
					pcall(() => Workspace.SetAttribute(WORLD_SEED_ATTRIBUTE, newTown.seed));
				},
			}),
		);
		// what decides is the town the simulation runs, not whether endWorld returned (N2)
		if (sim.world === previous) {
			// endWorld builds everything before it changes anything (review of f851ad2, M2): the old world is intact,
			// and it goes on under the rule that held before MP-22 — the dead stand up at daybreak, a Rebirth still
			// works, and the next fall of the last survivor tries again
			const why = returned ? "no new town" : tostring(result);
			warn(`[${GAME_NAME}] the new town could not be made (${why}): this world goes on until daybreak`);
			return;
		}
		if (!returned) {
			// every step after the switch is contained inside endWorld, so this is a bug there: the new town stands
			// (and `onSwitched` named it), but nothing else about this reset can be vouched for
			warn(`[${GAME_NAME}] the new town stands, but the end of the old one failed after it: ${tostring(result)}`);
			return;
		}
		const outcome = result as WorldEnd;
		for (const failure of outcome.failures) {
			warn(`[${GAME_NAME}] the new world went on past a failure (${failure})`);
		}
		print(
			`[${GAME_NAME}] the town of seed ${outcome.ended.seed} lasted ${outcome.ended.days} day(s); a new one rises from ` +
				`seed ${outcome.seed} (map hash ${outcome.mapHash}, generated in ${outcome.generateMs} ms over ` +
				`${frames} frame(s)) on day 1, and ${outcome.lives.size()} survivor(s) start a new life`,
		);
		Analytics.worldEnded(report, outcome);
		options.onWorldWiped?.(report, outcome);
	}

	/** a world reset under way (its new town is being generated, a slice per frame): a second report waits for it */
	let resetting = false;
	lives.onWorldWiped = report => {
		if (resetting) return;
		resetting = true;
		// in its own thread, so the new town can be generated a slice per frame (`pace` below) while this tick, and
		// the ones after it, go on in the old world
		task.spawn(() => {
			const [ok, err] = pcall(() => worldWiped(report));
			resetting = false;
			if (!ok) warn(`[${GAME_NAME}] the world reset failed: ${tostring(err)}`);
		});
	};

	active = host;
	return host;
}
