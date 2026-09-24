/*
 * The TownRequest remote (shared/net/townNet.ts) on the server: the lobby's Servers list and join
 * (server/match/serverList.ts) and the keeper's "Restart town" (server/match/townRestart.ts). SERVER ONLY.
 *
 * Every request, in this order: the payload read (`readTownRequest`, a pure O(1) look at a table), the host's flood
 * accounting with it (§8.2: a payload that is not a request of this remote -- a table of the wrong shape included -- is
 * a malformed one, review of 0b44458, L6), a token bucket per player (REQ_BURST, REQ_PER_SECOND), then the rules of the
 * one it is. Nothing the client says about who it is, where it stands or what a server is, is taken: the owner is
 * DataModel's, the lobby is the host's, a server is what the MemoryStore says.
 *
 * It also notices a player who ARRIVED from another server's list (their join data carries SERVER_LIST_TELEPORT_DATA,
 * from this very place): that is when JoinedFromList is logged (review of 0b44458, L5). The flag is trusted for that
 * analytics event and for nothing else -- teleport data passes through the client.
 */
import { GAME_NAME } from "shared/module";
import { townNameOf } from "shared/data/townNames";
import { TOWN_KEEPER_ATTR, TownRefusal, TownResponse, createTownRemotes, readTownRequest } from "shared/net/townNet";
import { ServerList, ServerListGame, arrivedFromList, startServerList } from "./serverList";
import { RestartGate, restartRightOf } from "./townRestart";

/** requests per player: a burst, then this many a second (the Servers window asks once, and on Refresh) */
export const REQ_BURST = 6;
export const REQ_PER_SECOND = 1;

export interface TownServicesHost extends ServerListGame {
	/** MP-26: a new town now (server/net/mpHost.ts `restartTown`) */
	restart: (by: number) => "started" | "busy";
	/**
	 * Every restart request that got past the bucket, allowed or refused (server/admin/adminServer.ts `townAudit`):
	 * `byAdmin` -- an admin's restart is stored as an admin action; the owner's and every refusal stay in memory.
	 */
	audit: (userId: number, ok: boolean, details: string, byAdmin: boolean) => void;
	/** (§8.2) the host's flood accounting for a remote it does not own: true = drop the message */
	noteRemote: (player: Player, malformed: boolean) => boolean;
	/** this player arrived here from another server's Servers list (analytics' JoinedFromList, logged on arrival) */
	arrived: (player: Player) => void;
}

export interface TownServices {
	list: ServerList;
}

export function startTownServices(host: TownServicesHost): TownServices {
	const Players = game.GetService("Players");
	const remotes = createTownRemotes();
	const list = startServerList(host, (player: Player, why: TownRefusal) => {
		pcall(() => remotes.notice.FireClient(player, { k: "joinFailed", why }));
	});
	const gate = new RestartGate();
	const buckets = new Map<Player, { tokens: number; at: number }>();

	const onJoin = (player: Player): void => {
		// the lobby shows "Restart town" to who may use it: only on a private server (the server re-checks every request)
		if (restartRightOf(player.UserId, game.PrivateServerId, game.PrivateServerOwnerId) !== undefined) {
			pcall(() => player.SetAttribute(TOWN_KEEPER_ATTR, true));
		}
		// sent here by another server's Servers list: the join the list is measured by (review of 0b44458, L5)
		const [ok, joinData] = pcall(() => player.GetJoinData());
		if (ok && arrivedFromList(joinData, game.PlaceId)) host.arrived(player);
	};
	Players.PlayerAdded.Connect(onJoin);
	for (const player of Players.GetPlayers()) onJoin(player);
	Players.PlayerRemoving.Connect(player => {
		buckets.delete(player);
		list.forget(player);
	});

	const take = (player: Player): boolean => {
		const now = os.clock();
		const b = buckets.get(player) ?? { tokens: REQ_BURST, at: now };
		b.tokens = math.min(REQ_BURST, b.tokens + (now - b.at) * REQ_PER_SECOND);
		b.at = now;
		buckets.set(player, b);
		if (b.tokens < 1) return false;
		b.tokens -= 1;
		return true;
	};

	const restart = (player: Player): TownResponse => {
		const right = restartRightOf(player.UserId, game.PrivateServerId, game.PrivateServerOwnerId);
		if (right === undefined) {
			host.audit(player.UserId, false, "not this private server's owner", false);
			return { ok: false, reason: "forbidden" };
		}
		const byAdmin = right === "admin";
		const now = os.clock();
		const wait = gate.waitFor(now);
		if (wait > 0) {
			host.audit(player.UserId, false, `${right}: cooldown, ${math.ceil(wait)} s left`, byAdmin);
			return { ok: false, reason: "rate" };
		}
		const town = host.town();
		if (host.restart(player.UserId) !== "started") {
			host.audit(player.UserId, false, `${right}: a new town is already being made`, byAdmin);
			return { ok: false, reason: "busy" };
		}
		gate.started(now);
		host.audit(
			player.UserId,
			true,
			`${right}: ${townNameOf(town.seed)} (seed ${town.seed}) restarted on day ${town.day}`,
			byAdmin,
		);
		return { ok: true };
	};

	remotes.request.OnServerInvoke = (player: Player, raw: unknown): TownResponse => {
		// read first (a pure look at a table), so the flood accounting knows a malformed payload of any shape (§8.2)
		const req = readTownRequest(raw);
		if (host.noteRemote(player, req === undefined)) return { ok: false, reason: "rate" };
		if (!take(player)) return { ok: false, reason: "rate" };
		if (req === undefined) return { ok: false, reason: "invalid" };
		if (req.kind === "servers") return list.list(player);
		if (req.kind === "join") return list.join(player, req.jobId);
		return restart(player);
	};
	print(`[${GAME_NAME}] town services ready (server list, restart town)`);
	return { list };
}
