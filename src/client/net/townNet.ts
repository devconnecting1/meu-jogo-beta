/*
 * The client side of the town's remotes (shared/net/townNet.ts): the lobby's Servers list, the join from it and the
 * keeper's "Restart town". Everything here is asked from a click, in its own thread: `townRequest` YIELDS until the
 * server answers, and the answer is re-read (`readTownResponse`) before anything shows it.
 *
 * Its own module on purpose: client/net/netClient.ts and client/main.client.ts are close to Luau's 200-locals budget
 * (npm run check:registers), and nothing here is on the per-frame path.
 */
import {
	TownRefusal,
	TownRemotes,
	TownRequest,
	TownResponse,
	readRefusal,
	readTownResponse,
	waitTownRemotes,
} from "shared/net/townNet";

/** how long the first request waits for the remotes to replicate (s) */
const REMOTE_TIMEOUT = 20;

let remotes: TownRemotes | undefined;
let noticeConn: RBXScriptConnection | undefined;
const joinFailedListeners = new Set<(why: TownRefusal) => void>();

/** a request's transport; tools/test-lobby.mjs and test-nav.mjs put a fake in its place (`setTownRequester`) */
export type TownRequester = (req: TownRequest) => TownResponse;

function remotesNow(): TownRemotes | undefined {
	if (remotes !== undefined) return remotes;
	const found = waitTownRemotes(REMOTE_TIMEOUT);
	if (found === undefined) return undefined;
	remotes = found;
	noticeConn ??= found.notice.OnClientEvent.Connect((raw: unknown) => {
		if (!typeIs(raw, "table")) return;
		const msg = raw as Record<string, unknown>;
		const why = readRefusal(msg.why);
		if (msg.k !== "joinFailed" || why === undefined) return;
		noticeJoinFailed(why);
	});
	return found;
}

const remoteRequester: TownRequester = req => {
	const r = remotesNow();
	if (r === undefined) return { ok: false, reason: "unavailable" };
	const [ok, raw] = pcall(() => r.request.InvokeServer(req));
	if (!ok) return { ok: false, reason: "failed" };
	return readTownResponse(raw);
};

let requester: TownRequester = remoteRequester;

/** sends `req` and YIELDS until the server answers (call it from a task) */
export function townRequest(req: TownRequest): TownResponse {
	return requester(req);
}

/**
 * Sends `req` in its own thread and hands the answer to `done` (from a click handler: it never yields). A test's fake
 * requester answers at once, on the caller's thread (the UI suites run no coroutines).
 */
export function townRequestAsync(req: TownRequest, done: (res: TownResponse) => void): void {
	if (requester !== remoteRequester) {
		done(requester(req));
		return;
	}
	task.spawn(() => done(remoteRequester(req)));
}

/** tests: answer every request with `fn` (undefined: the real remote again) */
export function setTownRequester(fn: TownRequester | undefined): void {
	requester = fn ?? remoteRequester;
}

/**
 * The server's TownNotice "joinFailed", read: every listener hears why (the remote's handler calls it; a test does too,
 * to put the notice before or after the join's own answer -- it can come before, review of 0b44458 L5)
 */
export function noticeJoinFailed(why: TownRefusal): void {
	for (const fn of joinFailedListeners) fn(why);
}

/** a join that failed after the server sent it (TeleportInitFailed): `fn` hears why. Returns the unsubscribe */
export function onJoinFailed(fn: (why: TownRefusal) => void): () => void {
	joinFailedListeners.add(fn);
	return () => joinFailedListeners.delete(fn);
}
