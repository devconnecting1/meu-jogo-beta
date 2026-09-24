/*
 * The multiplayer remotes (docs/MULTIPLAYER.md §4.1). SERVER ONLY.
 *
 * Creates the instances named in MP_REMOTES inside ReplicatedStorage/Net — next to the LoadRequest/LoadAck/
 * ShopAction of shared/net/net.ts, which stay exactly as they are — and offers typed send/receive helpers.
 * There is no game logic in this file: it is the boundary between Roblox instances and the pure simulation.
 *
 *   Input     UnreliableRemoteEvent  C→S  continuous, self-correcting: a lost packet is covered by the §2.2
 *                                        redundancy, so reliability would only add head-of-line delay
 *   Snap      UnreliableRemoteEvent  S→C  the next snapshot supersedes the last one
 *   Fx        UnreliableRemoteEvent  S→C  ephemeral cosmetics (F2)
 *   TimeSync  UnreliableRemoteEvent  ↔    clock probe (§4.6)
 *   Intent    RemoteEvent            C→S  reliable, ordered: it changes persistent state (F3)
 *   World     RemoteEvent            S→C  reliable world deltas and the roster (§4.5)
 *   Self      RemoteEvent            S→C  save mirror deltas (F3)
 *
 * Engine limits honoured here (verified against /roblox/creator-docs and @rbxts/types):
 *   - an UnreliableRemoteEvent payload over 1000 bytes is DROPPED silently, so every unreliable send checks
 *     UNRELIABLE_MAX_BYTES (our raw ceiling under it) first and reports the refusal instead of losing the packet;
 *   - unreliable events are neither ordered nor guaranteed — every Snap part is self-contained (§4.2);
 *   - remotes are throttled at ~500 requests/s per client, shared by class: we send 60 Input/s upstream.
 */
import { NET_FOLDER } from "shared/net/net";
import { UNRELIABLE_MAX_BYTES } from "shared/net/mpConfig";
import {
	MP_REMOTES,
	REMOTE_FX,
	REMOTE_INPUT,
	REMOTE_INTENT,
	REMOTE_SELF,
	REMOTE_SNAP,
	REMOTE_TIME_SYNC,
	REMOTE_WORLD,
} from "shared/net/protocol";

const ReplicatedStorage = game.GetService("ReplicatedStorage");

export interface MpRemotes {
	folder: Folder;
	input: UnreliableRemoteEvent;
	intent: RemoteEvent;
	snap: UnreliableRemoteEvent;
	fx: UnreliableRemoteEvent;
	world: RemoteEvent;
	self: RemoteEvent;
	timeSync: UnreliableRemoteEvent;
}

type RemoteClassName = "RemoteEvent" | "UnreliableRemoteEvent";

function netFolder(): Folder {
	const existing = ReplicatedStorage.FindFirstChild(NET_FOLDER);
	if (existing !== undefined && existing.IsA("Folder")) return existing;
	if (existing !== undefined) existing.Destroy();
	const created = new Instance("Folder");
	created.Name = NET_FOLDER;
	created.Parent = ReplicatedStorage;
	return created;
}

function ensureRemote<C extends RemoteClassName>(folder: Folder, name: string, className: C): Instances[C] {
	const existing = folder.FindFirstChild(name);
	if (existing !== undefined) {
		if (existing.IsA(className)) return existing as Instances[C];
		// a leftover of the wrong class (a hot reload that changed the protocol) must not linger
		existing.Destroy();
	}
	const created = new Instance(className);
	created.Name = name;
	created.Parent = folder;
	return created as unknown as Instances[C];
}

/** creates (or reuses) every remote of MP_REMOTES; call once, from the server boot */
export function createMpRemotes(): MpRemotes {
	const folder = netFolder();
	// MP_REMOTES is the single source of truth for the names and classes (§4.1)
	for (const spec of MP_REMOTES) ensureRemote(folder, spec.name, spec.className);
	return {
		folder,
		input: ensureRemote(folder, REMOTE_INPUT, "UnreliableRemoteEvent"),
		intent: ensureRemote(folder, REMOTE_INTENT, "RemoteEvent"),
		snap: ensureRemote(folder, REMOTE_SNAP, "UnreliableRemoteEvent"),
		fx: ensureRemote(folder, REMOTE_FX, "UnreliableRemoteEvent"),
		world: ensureRemote(folder, REMOTE_WORLD, "RemoteEvent"),
		self: ensureRemote(folder, REMOTE_SELF, "RemoteEvent"),
		timeSync: ensureRemote(folder, REMOTE_TIME_SYNC, "UnreliableRemoteEvent"),
	};
}

/** removes the MP remotes again (the legacy LoadRequest/ShopAction ones are left alone) */
export function destroyMpRemotes(remotes: MpRemotes): void {
	for (const spec of MP_REMOTES) {
		const child = remotes.folder.FindFirstChild(spec.name);
		if (child !== undefined) child.Destroy();
	}
}

// ---------------------------------------------------------------- receiving (C→S)

/**
 * `player` always comes from the remote's first argument, never from the payload (§8.3). The payload is passed
 * through untouched: only the decoders of shared/net/protocol.ts are allowed to interpret it.
 */
export function onInput(remotes: MpRemotes, handler: (player: Player, payload: unknown) => void): RBXScriptConnection {
	return remotes.input.OnServerEvent.Connect((player, payload) => handler(player, payload));
}

export function onIntent(remotes: MpRemotes, handler: (player: Player, payload: unknown) => void): RBXScriptConnection {
	return remotes.intent.OnServerEvent.Connect((player, payload) => handler(player, payload));
}

export function onTimeSync(
	remotes: MpRemotes,
	handler: (player: Player, payload: unknown) => void,
): RBXScriptConnection {
	return remotes.timeSync.OnServerEvent.Connect((player, payload) => handler(player, payload));
}

// ---------------------------------------------------------------- sending (S→C)

/**
 * False when the payload is over our own raw ceiling (the caller counts it). UNRELIABLE_MAX_BYTES, not the engine's
 * 1000 (audit L1): the engine's limit applies to the ENCODED event -- a buffer is compressed, and carries its own
 * framing -- so a raw buffer just under 1000 B may still be over it, and production drops it without a word.
 */
export function sendUnreliable(remote: UnreliableRemoteEvent, player: Player, payload: buffer): boolean {
	if (buffer.len(payload) > UNRELIABLE_MAX_BYTES) return false;
	remote.FireClient(player, payload);
	return true;
}

export function sendSnap(remotes: MpRemotes, player: Player, part: buffer): boolean {
	return sendUnreliable(remotes.snap, player, part);
}

export function sendFx(remotes: MpRemotes, player: Player, batch: buffer): boolean {
	return sendUnreliable(remotes.fx, player, batch);
}

export function sendTimePong(remotes: MpRemotes, player: Player, payload: buffer): boolean {
	return sendUnreliable(remotes.timeSync, player, payload);
}

export function sendWorld(remotes: MpRemotes, player: Player, packet: buffer): void {
	remotes.world.FireClient(player, packet);
}

export function sendWorldAll(remotes: MpRemotes, packet: buffer): void {
	remotes.world.FireAllClients(packet);
}

export function sendSelf(remotes: MpRemotes, player: Player, packet: buffer): void {
	remotes.self.FireClient(player, packet);
}
