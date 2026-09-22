import { safeText } from "shared/admin/ops";
import { ADMIN_LIMITS, AdminRemotes, AdminRequest, AdminResponse, waitAdminRemotes } from "shared/admin/protocol";

/*
 * Client side of the admin protocol (shared/admin/protocol.ts). Every player's client listens to AdminEvent (save
 * patches and announcements concern everybody); only admins send AdminRequest, and the server re-checks that anyway.
 */

const REMOTE_TIMEOUT = 60;
/** local-world tool logs are merged and sent at most this often (keeps the admin's request budget free) */
const LOG_FLUSH = 1.5;

let remotes: AdminRemotes | undefined;
let failed = false;
const listeners = new Set<(ev: Record<string, unknown>) => void>();

export function startAdminNet(): void {
	task.spawn(() => {
		const r = waitAdminRemotes(REMOTE_TIMEOUT);
		if (r === undefined) {
			failed = true;
			warn("[PZ-ADMIN] admin remotes not found");
			return;
		}
		remotes = r;
		r.event.OnClientEvent.Connect((raw: unknown) => {
			if (!typeIs(raw, "table")) return;
			const ev = raw as Record<string, unknown>;
			if (!typeIs(ev.kind, "string")) return;
			for (const fn of listeners) task.spawn(fn, ev);
		});
	});
}

export function adminNetReady(): boolean {
	return remotes !== undefined;
}

/** raw AdminEvent tables (validated by each listener) */
export function onAdminEvent(fn: (ev: Record<string, unknown>) => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** sends a request and YIELDS until the server answers (call from a task / click handler) */
export function adminRequest(req: AdminRequest): AdminResponse {
	const r = remotes;
	if (r === undefined) return { ok: false, error: failed ? "admin remotes unavailable" : "still connecting" };
	const [ok, raw] = pcall(() => r.request.InvokeServer(req));
	if (!ok) return { ok: false, error: `network error: ${tostring(raw)}` };
	if (!typeIs(raw, "table")) return { ok: false, error: "invalid answer" };
	const res = raw as Record<string, unknown>;
	return {
		ok: res.ok === true,
		error: typeIs(res.error, "string") ? res.error : undefined,
		message: typeIs(res.message, "string") ? res.message : undefined,
		data: res.data,
	};
}

/** fire-and-forget request (errors go to `onDone` when given) */
export function adminRequestAsync(req: AdminRequest, onDone?: (res: AdminResponse) => void): void {
	task.spawn(() => {
		const res = adminRequest(req);
		onDone?.(res);
	});
}

export function sendPatchAck(rev: number): void {
	remotes?.patchAck.FireServer(rev);
}

// ---------------------------------------------------------------- audit of local-world tools

const pendingLogs = new Map<string, { count: number; last: string }>();
let flushScheduled = false;

function flushLogs(): void {
	flushScheduled = false;
	for (const [action, e] of pendingLogs) {
		const details = e.count > 1 ? `${e.last} (×${e.count} in ${LOG_FLUSH} s)` : e.last;
		adminRequestAsync({ kind: "logLocal", action, details: safeText(details, ADMIN_LIMITS.LOG_DETAILS) });
	}
	pendingLogs.clear();
}

/**
 * Records a tool used in the admin's own world in the server's audit log. Repeated uses of the same tool within
 * LOG_FLUSH seconds (Shift+click placing, sliders) are merged into one entry.
 */
export function logLocal(action: string, details: string): void {
	const e = pendingLogs.get(action);
	if (e !== undefined) {
		e.count += 1;
		e.last = details;
	} else {
		pendingLogs.set(action, { count: 1, last: details });
	}
	if (!flushScheduled) {
		flushScheduled = true;
		task.delay(LOG_FLUSH, flushLogs);
	}
}
