import type { LoadStatus } from "shared/net/net";
import type { AdminOp } from "./ops";

/*
 * Admin protocol (ReplicatedStorage/PZAdminNet). Every request is authorized on the server by the caller's
 * UserId (shared/admin/config.ts); nothing the client sends is trusted, not even from an admin.
 *
 *   AdminRequest   C→S  RemoteFunction  (AdminRequest) → AdminResponse   admins only (others get "forbidden")
 *   AdminEvent     S→C  RemoteEvent     (AdminEvent)                     patch (to the edited player),
 *                                                                        announce (everyone), watch (admins)
 *   AdminPatchAck  C→S  RemoteEvent     (rev)                            "patch `rev` applied" from the edited
 *                                                                        player (any player, own session only)
 *
 * Save edits: the server applies AdminOps to its copy of the target's save, bumps runRev (so any progress report
 * captured before the edit is refused as "outdated") and sends the same ops to the target's client, which applies
 * them to ctx.save and the running game at once. Until the client confirms with AdminPatchAck (or a short timeout)
 * the server also refuses reports, so an old snapshot can never undo the edit.
 */
export const ADMIN_FOLDER = "PZAdminNet";
export const REMOTE_ADMIN_REQUEST = "AdminRequest";
export const REMOTE_ADMIN_EVENT = "AdminEvent";
export const REMOTE_ADMIN_PATCH_ACK = "AdminPatchAck";

/** string / list limits enforced by the server (the panel uses the same ones) */
export const ADMIN_LIMITS = {
	KICK_REASON: 200,
	/** Players:BanAsync DisplayReason max length */
	DISPLAY_REASON: 400,
	/** Players:BanAsync PrivateReason max length */
	PRIVATE_REASON: 1000,
	ANNOUNCE: 200,
	/** a UserId (digits) or a username */
	TARGET: 40,
	OPS_PER_REQUEST: 400,
	LOG_ACTION: 48,
	LOG_DETAILS: 240,
	BAN_HISTORY_ENTRIES: 30,
} as const;

export type BanDuration = "1h" | "1d" | "7d" | "perm";

/** Players:BanAsync Duration in seconds (-1 = permanent) */
export const BAN_DURATION_SECONDS: Record<BanDuration, number> = {
	"1h": 3600,
	"1d": 86400,
	"7d": 604800,
	perm: -1,
};

export const BAN_DURATION_LABEL: Record<BanDuration, string> = {
	"1h": "1 hour",
	"1d": "1 day",
	"7d": "7 days",
	perm: "Permanent",
};

export const BAN_DURATIONS: Array<BanDuration> = ["1h", "1d", "7d", "perm"];

export type AdminRequest =
	| { kind: "players" }
	| { kind: "save"; userId: number }
	| { kind: "kick"; userId: number; reason: string }
	| {
			kind: "ban";
			/** a UserId (digits) or a username */
			target: string;
			duration: BanDuration;
			displayReason: string;
			privateReason: string;
			applyToUniverse: boolean;
			excludeAlts: boolean;
	  }
	| { kind: "unban"; target: string; applyToUniverse: boolean }
	| { kind: "banHistory"; target: string }
	| { kind: "edit"; userId: number; ops: Array<AdminOp> }
	| { kind: "resetSave"; userId: number }
	| { kind: "announce"; text: string }
	| { kind: "serverInfo" }
	| { kind: "auditLog" }
	/** live data of a player on every progress report (0 = stop) */
	| { kind: "watch"; userId: number }
	/** the admin used a world tool in the current run: the server stops crediting it (coins, achievements...) */
	| { kind: "assist" }
	/** audit entry for a tool that runs in the admin's own (client-simulated) world */
	| { kind: "logLocal"; action: string; details: string };

export interface AdminResponse {
	ok: boolean;
	/** why it failed (shown to the admin as is) */
	error?: string;
	/** extra note on success (e.g. "not persisted: DataStore unavailable") */
	message?: string;
	data?: unknown;
}

/** what the server knows about a player of this server */
export interface PlayerRow {
	userId: number;
	name: string;
	displayName: string;
	isAdmin: boolean;
	/** days since the account was created */
	accountAge: number;
	loaded: boolean;
	status: LoadStatus;
	/** progress reaches the DataStore */
	persist: boolean;
	/** the session refuses reports (load error / lock lost) */
	readOnly: boolean;
	/** changes not written to the DataStore yet */
	dirty: boolean;
	day: number;
	bestDay: number;
	level: number;
	exp: number;
	skillPoint: number;
	money: number;
	bossKills: number;
	deathCount: number;
	runOver: boolean;
	/** seconds since the last accepted progress report (-1 = none yet) */
	lastReportAgo: number;
	/** seconds since the player joined this server */
	sessionAge: number;
	/** an admin edit is waiting for the client's confirmation */
	patchPending: boolean;
	/**
	 * Live, from the server's simulation (§9.3; MP_PHASE >= 1): the survivor has a body in the town (false = lobby,
	 * shop, loading). The rest of this block is meaningful only while it is true.
	 */
	inWorld: boolean;
	/** the body in the town is dead (waiting for daybreak or a Rebirth, MP-21) */
	dead: boolean;
	hp: number;
	hpMax: number;
	/** seconds since the last real input with movement or an edge (MP-13's AFK test), -1 = not in the world */
	idleS: number;
	/** round trip to this player's client in ms (Player:GetNetworkPing), -1 = unknown */
	pingMs: number;
}

/** MP-13's AFK window (server/sim/progress.ts AFK_WINDOW_S): the admin table calls an idle survivor AFK past it */
export const ADMIN_AFK_S = 180;

export interface BanHistoryEntry {
	/** true = ban, false = unban */
	ban: boolean;
	startTime: string;
	/** seconds (-1 = permanent) */
	duration: number;
	displayReason: string;
	privateReason: string;
	placeId: number;
}

export interface BanHistoryResult {
	userId: number;
	name: string;
	entries: Array<BanHistoryEntry>;
}

export interface ServerInfo {
	jobId: string;
	placeId: number;
	placeVersion: number;
	studio: boolean;
	uptime: number;
	players: number;
	maxPlayers: number;
	dataStore: string;
	auditStore: string;
}

export interface AuditEntry {
	/** os.time() */
	t: number;
	adminId: number;
	admin: string;
	action: string;
	target: string;
	details: string;
	ok: boolean;
}

export type AdminEvent =
	| {
			kind: "patch";
			rev: number;
			runRev: number;
			ops: Array<AdminOp>;
			/** full save after a reset (ops is empty then) */
			reset?: unknown;
			by: string;
	  }
	| { kind: "announce"; text: string; from: string }
	| { kind: "watch"; row: PlayerRow };

export interface AdminRemotes {
	request: RemoteFunction;
	event: RemoteEvent;
	patchAck: RemoteEvent;
}

function ensure<C extends "RemoteEvent" | "RemoteFunction">(folder: Folder, name: string, className: C): Instances[C] {
	const existing = folder.FindFirstChild(name);
	if (existing !== undefined) {
		if (existing.IsA(className)) return existing as Instances[C];
		existing.Destroy();
	}
	const created = new Instance(className);
	created.Name = name;
	created.Parent = folder;
	return created as unknown as Instances[C];
}

/** SERVER ONLY: creates (or reuses) the admin remotes */
export function createAdminRemotes(): AdminRemotes {
	const storage = game.GetService("ReplicatedStorage");
	let folder = storage.FindFirstChild(ADMIN_FOLDER);
	if (folder === undefined || !folder.IsA("Folder")) {
		folder?.Destroy();
		const created = new Instance("Folder");
		created.Name = ADMIN_FOLDER;
		created.Parent = storage;
		folder = created;
	}
	const f = folder as Folder;
	return {
		request: ensure(f, REMOTE_ADMIN_REQUEST, "RemoteFunction"),
		event: ensure(f, REMOTE_ADMIN_EVENT, "RemoteEvent"),
		patchAck: ensure(f, REMOTE_ADMIN_PATCH_ACK, "RemoteEvent"),
	};
}

/** CLIENT: waits for the admin remotes (undefined when they do not show up within `timeout` s). Yields. */
export function waitAdminRemotes(timeout: number): AdminRemotes | undefined {
	const storage = game.GetService("ReplicatedStorage");
	const folder = storage.WaitForChild(ADMIN_FOLDER, timeout);
	if (folder === undefined) return undefined;
	const request = folder.WaitForChild(REMOTE_ADMIN_REQUEST, timeout);
	const event = folder.WaitForChild(REMOTE_ADMIN_EVENT, timeout);
	const patchAck = folder.WaitForChild(REMOTE_ADMIN_PATCH_ACK, timeout);
	if (
		request === undefined ||
		event === undefined ||
		patchAck === undefined ||
		!request.IsA("RemoteFunction") ||
		!event.IsA("RemoteEvent") ||
		!patchAck.IsA("RemoteEvent")
	) {
		return undefined;
	}
	return { request, event, patchAck };
}
