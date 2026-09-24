/*
 * The TownRequest remote (shared/net/townNet.ts) on the server: the lobby's Servers list and join
 * (server/match/serverList.ts) and the keeper's "Restart town" (server/match/townRestart.ts). SERVER ONLY.
 *
 * Every request, in this order: the host's flood accounting (§8.2, the same limits as every other remote), a token
 * bucket per player (REQ_BURST, REQ_PER_SECOND), the payload re-read (`readTownRequest`: anything else is "invalid"),
 * then the rules of the one it is. Nothing the client says about who it is, where it stands or what a server is, is
 * taken: the owner is DataModel's, the lobby is the host's, a server is what the MemoryStore says.
 */
import { GAME_NAME } from "shared/module";
import { townNameOf } from "shared/data/townNames";
import { TOWN_KEEPER_ATTR, TownRefusal, TownResponse, createTownRemotes, readTownRequest } from "shared/net/townNet";
import { ServerList, ServerListGame, startServerList } from "./serverList";
import { RestartGate, restartRightOf } from "./townRestart";

/** requests per player: a burst, then this many a second (the Servers window asks once, and on Refresh) */
export const REQ_BURST = 6;
export const REQ_PER_SECOND = 1;

export interface TownServicesHost extends ServerListGame {
	/** MP-26: a new town now (server/net/mpHost.ts `restartTown`) */
	restart: (by: number) => "started" | "busy";
	/**
	 * Every restart request that got past the bucket, allowed or refused, into the admin audit log by UserId
	 * (server/admin/adminServer.ts `townAudit`). `persist` false: memory and the output only.
	 */
	audit: (userId: number, ok: boolean, details: string, persist: boolean) => void;
	/** (§8.2) the host's flood accounting for a remote it does not own: true = drop the message */
	noteRemote: (player: Player, malformed: boolean) => boolean;
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

	/** the lobby shows "Restart town" to who may use it (the server re-checks every request anyway) */
	const markKeeper = (player: Player): void => {
		if (restartRightOf(player.UserId, game.PrivateServerId, game.PrivateServerOwnerId) === undefined) return;
		pcall(() => player.SetAttribute(TOWN_KEEPER_ATTR, true));
	};
	Players.PlayerAdded.Connect(markKeeper);
	for (const player of Players.GetPlayers()) markKeeper(player);
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
			host.audit(player.UserId, false, "not this server's owner", false);
			return { ok: false, reason: "forbidden" };
		}
		const now = os.clock();
		const wait = gate.waitFor(now);
		if (wait > 0) {
			host.audit(player.UserId, false, `${right}: cooldown, ${math.ceil(wait)} s left`, false);
			return { ok: false, reason: "rate" };
		}
		const town = host.town();
		if (host.restart(player.UserId) !== "started") {
			host.audit(player.UserId, false, `${right}: a new town is already being made`, false);
			return { ok: false, reason: "busy" };
		}
		gate.started(now);
		host.audit(
			player.UserId,
			true,
			`${right}: ${townNameOf(town.seed)} (seed ${town.seed}) restarted on day ${town.day}`,
			true,
		);
		return { ok: true };
	};

	remotes.request.OnServerInvoke = (player: Player, raw: unknown): TownResponse => {
		// counted first, before the payload is read (§8.2): a flood is dropped like on every other remote
		if (host.noteRemote(player, !typeIs(raw, "table"))) return { ok: false, reason: "rate" };
		if (!take(player)) return { ok: false, reason: "rate" };
		const req = readTownRequest(raw);
		if (req === undefined) return { ok: false, reason: "invalid" };
		if (req.kind === "servers") return list.list(player);
		if (req.kind === "join") return list.join(player, req.jobId);
		return restart(player);
	};
	print(`[${GAME_NAME}] town services ready (server list, restart town)`);
	return { list };
}
