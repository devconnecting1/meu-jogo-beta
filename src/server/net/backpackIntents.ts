/*
 * The backpack verbs on the `Intent` remote (docs/MULTIPLAYER.md §4.8, §8.1, §8.2, §8.4). SERVER ONLY: the Roblox
 * glue around the pure checks of server/net/intentGate.ts and the simulation's server/sim/backpack.ts.
 *
 * The remote is shared with the presence verbs, and Roblox fires every connection: server/net/mpHost.ts reads
 * EnterWorld / LeaveWorld (and counts every message of a player who is not in the world yet against its stranger
 * flood limit), and this file reads the rest. The two decoders are disjoint — a presence verb is 2 bytes, a backpack
 * verb 8 — so each handler acts only on its own verbs.
 *
 * What a payload goes through here, in order (§8.1, §8.2, §9.2):
 *   1. decode (shared/net/intentWire.ts): exact length, header, verb, `arg` inside the verb's table;
 *   2. a token bucket of INTENT_RATE per second with a burst of INTENT_BURST, per Player — a verb over it is dropped
 *      and its nonce ACKNOWLEDGED, so the client's prediction is undone by the next push instead of lingering;
 *   3. every message counts toward the §8.2 flood limits of the survivor in the world (`noteMessage`), a malformed one
 *      toward the malformed limit (`noteMalformed`, and a window of its own for a player not in the world yet), and
 *      either limit crossed is the automatic kick of §9.2 level 2 — the only automatic sanction;
 *   4. in the world: queued in the simulation (server/sim/backpack.ts), which checks ownership, counts, cooldowns,
 *      the station and being alive against the SERVER's own save and body, and applies it inside the tick;
 *   5. out of the world (the lobby's wardrobe, MON-04): ONLY a cosmetic slot — outfit or pet — may be equipped or
 *      cleared, straight on the session's save, and only with something `ownsEquip` says is theirs
 *      (`applyOutOfWorld`). Everything else is acknowledged and refused: there is no body to eat with, no desk to
 *      craft at and no gun to hold in the lobby.
 *
 * Nothing in a payload names the player: it is always the remote's first argument (§8.3).
 */
import { GAME_NAME } from "shared/module";
import { FLOOD_MALFORMED_WINDOW_S } from "shared/net/mpConfig";
import { IntentMessage } from "shared/net/protocol";
import { PlayerSaveData } from "shared/game/save";
import { ServerPlayer, floodReason, noteMalformed, noteMessage } from "../sim/players";
import { ServerBackpack } from "../sim/backpack";
import {
	IntentGate,
	IntentVerdict,
	applyOutOfWorld,
	ingestBackpackIntent,
	malformedFlood,
	newIntentGate,
} from "./intentGate";

export interface BackpackIntentOptions {
	/** the `Intent` RemoteEvent (server/net/remotes.ts; the same instance mpHost listens on) */
	intent: RemoteEvent;
	/** acknowledgements and the rest of the verb's life (server/sim/backpack.ts) */
	backpack: ServerBackpack;
	/** the survivor in the world, or undefined */
	playerOf: (player: Player) => ServerPlayer | undefined;
	/** hands a verb to the simulation (`ServerSimulation.queueIntent`) */
	queue: (slot: number, msg: IntentMessage) => boolean;
	/** the player's loaded session save, for the out-of-world path; undefined while loading or closed */
	saveOf: (player: Player) => PlayerSaveData | undefined;
	/** the server just wrote into this player's save out of the world: the session must persist it */
	changed: (player: Player) => void;
}

/** starts listening; the returned function stops (server shutdown, tests) */
export function startBackpackIntents(options: BackpackIntentOptions): () => void {
	const Players = game.GetService("Players");
	const gates = new Map<Player, IntentGate>();
	const kicked = new Set<Player>();

	function kick(player: Player, reason: string): void {
		if (kicked.has(player)) return;
		kicked.add(player);
		// one Error Report row for every flood kick (docs/ANALYTICS.md §10): who, and why, go to the log line
		warn(`[${GAME_NAME}] kicking a player: network flood`);
		print(`[${GAME_NAME}] flood kick: ${player.Name} (${player.UserId}), ${reason}`);
		pcall(() => player.Kick("Network flood"));
	}

	const conn = options.intent.OnServerEvent.Connect((player, payload) => {
		// a remote still in flight when the player left: acting on it would only recreate state for nobody
		if (player.Parent === undefined) return;
		const now = os.clock();
		let gate = gates.get(player);
		if (gate === undefined) {
			gate = newIntentGate(now);
			gates.set(player, gate);
		}
		const res = ingestBackpackIntent(gate, payload, now);
		const sp = options.playerOf(player);
		if (sp !== undefined) {
			// EVERY message of a survivor in the world counts toward §8.2, the presence verbs included: mpHost.ts only
			// counts those for a player who is not in the world yet (security review of 5967a18, R5)
			noteMessage(sp, now);
			if (res.verdict === IntentVerdict.Malformed) noteMalformed(sp, now);
			const reason = floodReason(sp);
			if (reason !== undefined) kick(player, reason);
		} else if (res.verdict !== IntentVerdict.Presence && malformedFlood(gate)) {
			kick(player, `${gate.badCount} malformed intents in ${FLOOD_MALFORMED_WINDOW_S}s`);
		}
		if (res.verdict === IntentVerdict.Presence) return;
		const msg = res.msg;
		if (msg === undefined) return;
		if (res.verdict === IntentVerdict.Rate) {
			options.backpack.handled(player.UserId, msg.nonce);
			return;
		}
		// in the world: the simulation decides, inside the tick (a full queue acknowledges it there)
		if (sp !== undefined) {
			options.queue(sp.slot, msg);
			return;
		}
		const save = options.saveOf(player);
		if (save !== undefined && applyOutOfWorld(save, msg)) options.changed(player);
		options.backpack.handled(player.UserId, msg.nonce);
	});
	const leaving = Players.PlayerRemoving.Connect(player => {
		gates.delete(player);
		kicked.delete(player);
		options.backpack.forget(player.UserId);
	});
	return () => {
		conn.Disconnect();
		leaving.Disconnect();
	};
}
