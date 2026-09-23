import { GAME_NAME } from "shared/module";
import type { PlayerSaveData } from "shared/game/save";
import type { LoadStatus } from "shared/net/net";
import { ADMIN_ATTRIBUTE, isAdminUserId } from "shared/admin/config";
import { AdminOp, describeOps, readAdminOps, safeText } from "shared/admin/ops";
import {
	ADMIN_LIMITS,
	AdminEvent,
	AdminResponse,
	AuditEntry,
	BAN_DURATION_LABEL,
	BAN_DURATION_SECONDS,
	BanDuration,
	BanHistoryEntry,
	BanHistoryResult,
	createAdminRemotes,
	PlayerRow,
	ServerInfo,
} from "shared/admin/protocol";
import { ADMIN_LOG_STORE } from "../save/stores";

/*
 * Server side of the admin panel.
 * - authorization: EVERY request re-checks the caller's UserId (shared/admin/config.ts) before reading its payload;
 *   nothing from the client is trusted (types, ranges and lengths are validated even for admins)
 * - rate limited per admin (token bucket) + a cooldown on announcements; denied callers are logged (throttled)
 * - audit: every action (allowed or refused) is printed with the "[PZ-ADMIN]" prefix, kept in a memory ring shown
 *   in the panel and persisted (best effort, pcall) to the "ProjectZ_AdminLog" DataStore
 * - save edits go through the host (main.server.ts), which owns the sessions, the invariants and the report gate
 */

const Players = game.GetService("Players");
const HttpService = game.GetService("HttpService");
const DataStoreService = game.GetService("DataStoreService");
const RunService = game.GetService("RunService");
const TextService = game.GetService("TextService");
const Workspace = game.GetService("Workspace");

const LOG_PREFIX = "[PZ-ADMIN]";
/** suffixed in Studio, so a playtest never appends to the live audit log (server/save/stores.ts) */
const AUDIT_STORE = ADMIN_LOG_STORE;
const AUDIT_KEY = "recent";
/** entries kept in memory (panel) and in the DataStore document */
const AUDIT_MEMORY = 200;
const AUDIT_STORED = 300;
const AUDIT_FLUSH_INTERVAL = 30;

/** admin requests: token bucket (the panel polls the player list every ~2 s) */
const REQ_BURST = 12;
const REQ_PER_SECOND = 4;
const ANNOUNCE_COOLDOWN = 3;
/** a refused non-admin caller is logged at most this often (s) */
const DENY_LOG_INTERVAL = 60;

/** what main.server.ts exposes of a player's session (read-only snapshot) */
export interface AdminSessionView {
	loaded: boolean;
	status: LoadStatus;
	persist: boolean;
	readOnly: boolean;
	dirty: boolean;
	save: PlayerSaveData;
	/** os.clock() of the last accepted report (-math.huge = none) */
	lastReport: number;
	/** os.clock() when the player joined */
	joinedAt: number;
	patchPending: boolean;
}

export interface AdminEditOutcome {
	ok: boolean;
	error?: string;
	/** runRev after the edit */
	runRev: number;
	/** patch serial the client must acknowledge */
	rev: number;
	/** the edit will reach the DataStore */
	persist: boolean;
	/** the session save after the edit */
	save?: PlayerSaveData;
}

export interface AdminHost {
	session(player: Player): AdminSessionView | undefined;
	/** applies `ops` to the session save (undefined = reset the save), bumps runRev and arms the report gate */
	edit(player: Player, ops: Array<AdminOp> | undefined): AdminEditOutcome;
	/** the player's client applied patch `rev` */
	ackPatch(player: Player, rev: number): void;
	/** how to send patch `rev` again: the server re-sends it while it refuses the player's reports */
	setPatchResend(player: Player, rev: number, resend: () => void): void;
	dataStoreStatus(): string;
	/**
	 * The admin used a world tool (time, spawns, god mode...) in their current run: from now on that run earns no
	 * coins, achievements, boss kills or records (the day may still advance). Returns true when newly marked.
	 */
	markAssisted(player: Player): boolean;
	jobId: string;
}

export interface AdminServer {
	/** a progress report of `player` was accepted (pushes live data to admins watching them) */
	onReport(player: Player): void;
}

interface Bucket {
	tokens: number;
	at: number;
	lastAnnounce: number;
}

function trimText(v: unknown, max: number): string | undefined {
	if (!typeIs(v, "string")) return undefined;
	// no control characters (newlines included): keeps logs, kick messages and banners on one line
	const [clean] = v.gsub("%c", " ");
	const [trimmed] = clean.gsub("^%s+", "");
	const [out] = trimmed.gsub("%s+$", "");
	// valid UTF-8 only (anything else would break the JSON of the audit log / DataStore), limit in characters
	const [chars] = utf8.len(out);
	if (!typeIs(chars, "number") || chars > max) return undefined;
	return out;
}

/** @rbxts/types declares some UserId parameters with an opaque `User` type; the engine takes the number */
function asUser(userId: number): never {
	return userId as never;
}

/** a player of this server: Studio's Local Server test players have negative ids */
function isOnlineId(v: unknown): v is number {
	return typeIs(v, "number") && v === v && v % 1 === 0 && v !== 0 && math.abs(v) < 1e15;
}

function isUserId(v: unknown): v is number {
	return typeIs(v, "number") && v === v && v % 1 === 0 && v > 0 && v < 1e15;
}

export function startAdminServer(host: AdminHost): AdminServer {
	const remotes = createAdminRemotes();
	const buckets = new Map<number, Bucket>();
	const denied = new Map<number, number>();
	/** admin UserId → watched UserId */
	const watching = new Map<number, number>();
	const audit: Array<AuditEntry> = [];
	const unsaved: Array<AuditEntry> = [];
	let auditStatus = "loading";
	const [storeOk, storeValue] = pcall((): unknown => DataStoreService.GetDataStore(AUDIT_STORE));
	const auditStore = storeOk ? (storeValue as DataStore) : undefined;
	if (auditStore === undefined) auditStatus = `unavailable (${tostring(storeValue)})`;

	// ------------------------------------------------------------ audit

	/** `persist` false: memory + output only (refused non-admin calls must not flood the stored log) */
	function record(admin: Player, action: string, target: string, details: string, ok: boolean, persist = true): void {
		// every string is valid UTF-8 and bounded: one bad entry must never block the DataStore flush
		const e: AuditEntry = {
			t: os.time(),
			adminId: admin.UserId,
			admin: admin.Name,
			action: safeText(action, ADMIN_LIMITS.LOG_ACTION + 8),
			target: safeText(target, 80),
			details: safeText(details, ADMIN_LIMITS.LOG_DETAILS),
			ok,
		};
		print(
			`${LOG_PREFIX} ${e.admin} (${e.adminId}) ${e.action} target=${e.target === "" ? "-" : e.target} ` +
				`${ok ? "OK" : "REFUSED"}${e.details !== "" ? ` — ${e.details}` : ""}`,
		);
		audit.push(e);
		while (audit.size() > AUDIT_MEMORY) audit.remove(0);
		if (auditStore !== undefined && persist) unsaved.push(e);
	}

	/** the entry survives a JSON round trip (a DataStore write fails on invalid UTF-8) */
	function encodable(e: AuditEntry): boolean {
		const [ok] = pcall(() => HttpService.JSONEncode(e));
		return ok;
	}

	function readStoredEntry(v: unknown): AuditEntry | undefined {
		if (!typeIs(v, "table")) return undefined;
		const r = v as Record<string, unknown>;
		if (!typeIs(r.t, "number") || !typeIs(r.action, "string")) return undefined;
		return {
			t: r.t,
			adminId: typeIs(r.adminId, "number") ? r.adminId : 0,
			admin: typeIs(r.admin, "string") ? r.admin : "?",
			action: r.action,
			target: typeIs(r.target, "string") ? r.target : "",
			details: typeIs(r.details, "string") ? r.details : "",
			ok: r.ok === true,
		};
	}

	function flushAudit(): void {
		const store = auditStore;
		if (store === undefined || unsaved.size() === 0) return;
		const batch: Array<AuditEntry> = [];
		// an entry that cannot be encoded is dropped alone, never blocking the others
		for (const e of unsaved) {
			if (encodable(e)) batch.push(e);
		}
		unsaved.clear();
		if (batch.size() === 0) return;
		const [ok, err] = pcall(() => {
			store.UpdateAsync<unknown, unknown>(AUDIT_KEY, old => {
				const list: Array<AuditEntry> = [];
				if (typeIs(old, "table")) {
					for (const v of old as Array<unknown>) {
						const e = readStoredEntry(v);
						if (e !== undefined) list.push(e);
					}
				}
				for (const e of batch) list.push(e);
				while (list.size() > AUDIT_STORED) list.remove(0);
				return $tuple(list);
			});
		});
		if (ok) {
			auditStatus = "ok";
		} else {
			// keep them for the next attempt (bounded)
			for (const e of batch) unsaved.push(e);
			while (unsaved.size() > AUDIT_STORED) unsaved.remove(0);
			auditStatus = `write failed (${tostring(err)})`;
			warn(`${LOG_PREFIX} audit log not saved: ${tostring(err)}`);
		}
	}

	task.spawn(() => {
		const store = auditStore;
		if (store === undefined) return;
		const [ok, value] = pcall((): unknown => store.GetAsync<unknown>(AUDIT_KEY)[0]);
		if (!ok) {
			auditStatus = RunService.IsStudio()
				? `unavailable in Studio (${tostring(value)})`
				: `read failed (${tostring(value)})`;
			return;
		}
		auditStatus = "ok";
		if (!typeIs(value, "table")) return;
		const older: Array<AuditEntry> = [];
		for (const v of value as Array<unknown>) {
			const e = readStoredEntry(v);
			if (e !== undefined) older.push(e);
		}
		// stored history first, then whatever was logged while loading
		for (const e of audit) older.push(e);
		audit.clear();
		for (const e of older) audit.push(e);
		while (audit.size() > AUDIT_MEMORY) audit.remove(0);
	});

	task.spawn(() => {
		while (true) {
			task.wait(AUDIT_FLUSH_INTERVAL);
			flushAudit();
		}
	});
	game.BindToClose(() => flushAudit());

	// ------------------------------------------------------------ helpers

	function takeToken(userId: number): boolean {
		const now = os.clock();
		let b = buckets.get(userId);
		if (b === undefined) {
			b = { tokens: REQ_BURST, at: now, lastAnnounce: -math.huge };
			buckets.set(userId, b);
		}
		b.tokens = math.min(REQ_BURST, b.tokens + (now - b.at) * REQ_PER_SECOND);
		b.at = now;
		if (b.tokens < 1) return false;
		b.tokens -= 1;
		return true;
	}

	function playerRow(p: Player): PlayerRow {
		const s = host.session(p);
		const now = os.clock();
		const save = s?.save;
		return {
			userId: p.UserId,
			name: p.Name,
			displayName: p.DisplayName,
			isAdmin: isAdminUserId(p.UserId),
			accountAge: p.AccountAge,
			loaded: s?.loaded ?? false,
			status: s?.status ?? "error",
			persist: s?.persist ?? false,
			readOnly: s?.readOnly ?? true,
			dirty: s?.dirty ?? false,
			day: save?.day ?? 0,
			bestDay: save?.bestDay ?? 0,
			level: save?.level ?? 0,
			exp: save?.exp ?? 0,
			skillPoint: save?.skillPoint ?? 0,
			money: save?.money ?? 0,
			bossKills: save?.bossKills ?? 0,
			deathCount: save?.deathCount ?? 0,
			runOver: save?.runOver ?? false,
			lastReportAgo: s !== undefined && s.lastReport > -math.huge ? math.floor(now - s.lastReport) : -1,
			sessionAge: s !== undefined ? math.floor(now - s.joinedAt) : 0,
			patchPending: s?.patchPending ?? false,
		};
	}

	function pushWatch(target: Player): void {
		for (const [adminId, watched] of watching) {
			if (watched !== target.UserId) continue;
			const admin = Players.GetPlayerByUserId(adminId);
			if (admin === undefined) continue;
			const ev: AdminEvent = { kind: "watch", row: playerRow(target) };
			remotes.event.FireClient(admin, ev);
		}
	}

	/** broadcast-safe version of a user-typed text (undefined when the filter is unavailable) */
	function filterText(text: string, from: Player): string | undefined {
		const [ok, result] = pcall(() => TextService.FilterStringAsync(text, from.UserId));
		if (!ok) return undefined;
		const [ok2, filtered] = pcall(() => (result as TextFilterResult).GetNonChatStringForBroadcastAsync());
		if (!ok2 || !typeIs(filtered, "string")) return undefined;
		return filtered;
	}

	/** a UserId (digits) or a username → [userId, name] */
	function resolveTarget(raw: unknown): [number, string] | string {
		const t = trimText(raw, ADMIN_LIMITS.TARGET);
		if (t === undefined || t === "") return "enter a UserId or a username";
		if (string.match(t, "^%d+$")[0] !== undefined) {
			const id = tonumber(t);
			if (id === undefined || !isUserId(id)) return "invalid UserId";
			const online = Players.GetPlayerByUserId(id);
			if (online !== undefined) return [id, online.Name];
			const [ok, name] = pcall(() => Players.GetNameFromUserIdAsync(asUser(id)));
			return [id, ok && typeIs(name, "string") ? name : `#${id}`];
		}
		if (string.match(t, "^[%w_]+$")[0] === undefined || t.size() < 3 || t.size() > 20) {
			return "invalid username";
		}
		const [ok, id] = pcall(() => Players.GetUserIdFromNameAsync(t));
		if (!ok || !typeIs(id, "number")) return `username "${t}" not found (${tostring(id)})`;
		return [id, t];
	}

	function banApiError(err: unknown): string {
		const hint = RunService.IsStudio()
			? " — in Studio the Ban API needs a published place with Players.BanningEnabled on."
			: " — check that Players.BanningEnabled is on for this place.";
		return `Ban API failed: ${tostring(err)}${hint}`;
	}

	function fail(reason: string): AdminResponse {
		return { ok: false, error: reason };
	}

	function onlineTarget(caller: Player, userId: unknown, action: string): Player | string {
		if (!isOnlineId(userId)) return "invalid player";
		const target = Players.GetPlayerByUserId(userId);
		if (target === undefined) return "that player is not in this server";
		if (target === caller && (action === "kick" || action === "ban")) return `you cannot ${action} yourself`;
		if (target !== caller && isAdminUserId(target.UserId) && (action === "kick" || action === "ban")) {
			return `you cannot ${action} another admin`;
		}
		return target;
	}

	function sendPatch(
		target: Player,
		outcome: AdminEditOutcome,
		ops: Array<AdminOp>,
		by: Player,
		reset: boolean,
	): void {
		const ev: AdminEvent = {
			kind: "patch",
			rev: outcome.rev,
			runRev: outcome.runRev,
			ops: reset ? [] : ops,
			reset: reset ? outcome.save : undefined,
			by: by.Name,
		};
		remotes.event.FireClient(target, ev);
		host.setPatchResend(target, outcome.rev, () => {
			if (target.Parent !== undefined) remotes.event.FireClient(target, ev);
		});
		pushWatch(target);
	}

	// ------------------------------------------------------------ handlers

	function handle(caller: Player, req: Record<string, unknown>): AdminResponse {
		const kind = req.kind;

		if (kind === "players") {
			const rows: Array<PlayerRow> = [];
			for (const p of Players.GetPlayers()) rows.push(playerRow(p));
			return { ok: true, data: rows };
		}

		if (kind === "save") {
			const target = onlineTarget(caller, req.userId, "view");
			if (typeIs(target, "string")) return fail(target);
			const s = host.session(target);
			if (s === undefined || !s.loaded) return fail("that player's save is still loading");
			return { ok: true, data: { row: playerRow(target), save: s.save } };
		}

		if (kind === "kick") {
			const target = onlineTarget(caller, req.userId, "kick");
			const reason = trimText(req.reason, ADMIN_LIMITS.KICK_REASON);
			if (typeIs(target, "string")) {
				record(caller, "kick", tostring(req.userId), target, false);
				return fail(target);
			}
			if (reason === undefined) return fail(`reason: at most ${ADMIN_LIMITS.KICK_REASON} characters`);
			const shown = reason !== "" ? filterText(reason, caller) : "";
			const msg =
				shown !== undefined && shown !== ""
					? `You were kicked by an administrator: ${shown}`
					: "You were kicked by an administrator.";
			record(caller, "kick", `${target.Name} (${target.UserId})`, reason, true);
			target.Kick(msg);
			return { ok: true, message: `${target.Name} was kicked` };
		}

		if (kind === "ban") {
			const resolved = resolveTarget(req.target);
			if (typeIs(resolved, "string")) return fail(resolved);
			const [userId, name] = resolved;
			const label = `${name} (${userId})`;
			if (userId === caller.UserId) {
				record(caller, "ban", label, "refused: self", false);
				return fail("you cannot ban yourself");
			}
			if (isAdminUserId(userId)) {
				record(caller, "ban", label, "refused: target is an admin", false);
				return fail("you cannot ban another admin");
			}
			const dur = req.duration;
			if (!typeIs(dur, "string") || BAN_DURATION_SECONDS[dur as BanDuration] === undefined) {
				return fail("invalid duration");
			}
			const duration = BAN_DURATION_SECONDS[dur as BanDuration];
			const display = trimText(req.displayReason, ADMIN_LIMITS.DISPLAY_REASON);
			const privateReason = trimText(req.privateReason, ADMIN_LIMITS.PRIVATE_REASON);
			if (display === undefined) return fail(`shown reason: at most ${ADMIN_LIMITS.DISPLAY_REASON} characters`);
			if (privateReason === undefined) {
				return fail(`private reason: at most ${ADMIN_LIMITS.PRIVATE_REASON} characters`);
			}
			if (!typeIs(req.applyToUniverse, "boolean") || !typeIs(req.excludeAlts, "boolean")) {
				return fail("invalid options");
			}
			const shown = display !== "" ? filterText(display, caller) : "";
			const displayReason =
				shown !== undefined && shown !== ""
					? shown
					: "You are banned from this experience by an administrator.";
			// accountability: the private reason (only visible in the ban history) names the admin
			// the "| by admin" suffix is never cut: the note is trimmed to leave room for it
			const suffix = ` | by ${caller.Name} (${caller.UserId})`;
			const note = safeText(
				privateReason !== "" ? privateReason : "(no private reason)",
				ADMIN_LIMITS.PRIVATE_REASON - suffix.size(),
			);
			const privateText = `${note}${suffix}`;
			const [ok, err] = pcall(() =>
				Players.BanAsync({
					UserIds: [userId],
					Duration: duration,
					DisplayReason: displayReason,
					PrivateReason: privateText,
					ApplyToUniverse: req.applyToUniverse as boolean,
					ExcludeAltAccounts: req.excludeAlts as boolean,
				}),
			);
			const details = `${BAN_DURATION_LABEL[dur as BanDuration]}, universe=${tostring(req.applyToUniverse)}, excludeAlts=${tostring(req.excludeAlts)}, reason="${display}", private="${privateReason}"`;
			if (!ok) {
				record(caller, "ban", label, `FAILED ${tostring(err)} | ${details}`, false);
				return fail(banApiError(err));
			}
			record(caller, "ban", label, details, true);
			// BanAsync removes a banned player who is online; make sure of it
			const online = Players.GetPlayerByUserId(userId);
			if (online !== undefined) {
				task.delay(1, () => {
					if (online.Parent !== undefined) online.Kick(displayReason);
				});
			}
			return { ok: true, message: `${label} banned (${BAN_DURATION_LABEL[dur as BanDuration]})` };
		}

		if (kind === "unban") {
			const resolved = resolveTarget(req.target);
			if (typeIs(resolved, "string")) return fail(resolved);
			const [userId, name] = resolved;
			if (!typeIs(req.applyToUniverse, "boolean")) return fail("invalid options");
			const label = `${name} (${userId})`;
			const [ok, err] = pcall(() =>
				Players.UnbanAsync({ UserIds: [userId], ApplyToUniverse: req.applyToUniverse as boolean }),
			);
			if (!ok) {
				record(caller, "unban", label, `FAILED ${tostring(err)}`, false);
				return fail(banApiError(err));
			}
			record(caller, "unban", label, `universe=${tostring(req.applyToUniverse)}`, true);
			return { ok: true, message: `${label} unbanned` };
		}

		if (kind === "banHistory") {
			const resolved = resolveTarget(req.target);
			if (typeIs(resolved, "string")) return fail(resolved);
			const [userId, name] = resolved;
			const [ok, pages] = pcall(() => Players.GetBanHistoryAsync(asUser(userId)));
			if (!ok) return fail(banApiError(pages));
			const entries: Array<BanHistoryEntry> = [];
			const bp = pages as BanHistoryPages;
			for (let page = 0; page < 5 && entries.size() < ADMIN_LIMITS.BAN_HISTORY_ENTRIES; page++) {
				const [pok, list] = pcall(() => bp.GetCurrentPage());
				if (!pok || !typeIs(list, "table")) break;
				for (const raw of list as Array<unknown>) {
					if (!typeIs(raw, "table")) continue;
					const r = raw as Record<string, unknown>;
					entries.push({
						ban: r.Ban === true,
						startTime: typeIs(r.StartTime, "string") ? r.StartTime : tostring(r.StartTime ?? "?"),
						duration: typeIs(r.Duration, "number") ? r.Duration : 0,
						displayReason: typeIs(r.DisplayReason, "string") ? r.DisplayReason : "",
						privateReason: typeIs(r.PrivateReason, "string") ? r.PrivateReason : "",
						placeId: typeIs(r.PlaceId, "number") ? r.PlaceId : 0,
					});
					if (entries.size() >= ADMIN_LIMITS.BAN_HISTORY_ENTRIES) break;
				}
				if (bp.IsFinished) break;
				const [aok] = pcall(() => bp.AdvanceToNextPageAsync());
				if (!aok) break;
			}
			const result: BanHistoryResult = { userId, name, entries };
			return { ok: true, data: result };
		}

		if (kind === "edit") {
			const target = onlineTarget(caller, req.userId, "edit");
			if (typeIs(target, "string")) return fail(target);
			const ops = readAdminOps(req.ops, ADMIN_LIMITS.OPS_PER_REQUEST);
			if (ops === undefined) return fail("invalid edit");
			const outcome = host.edit(target, ops);
			const label = `${target.Name} (${target.UserId})`;
			if (!outcome.ok) {
				record(caller, "edit", label, `FAILED ${outcome.error ?? "?"}: ${describeOps(ops)}`, false);
				return fail(outcome.error ?? "edit failed");
			}
			record(caller, "edit", label, describeOps(ops), true);
			sendPatch(target, outcome, ops, caller, false);
			return {
				ok: true,
				message: outcome.persist ? undefined : "applied in memory only (this session is not saved)",
				data: outcome.save,
			};
		}

		if (kind === "resetSave") {
			const target = onlineTarget(caller, req.userId, "reset");
			if (typeIs(target, "string")) return fail(target);
			const outcome = host.edit(target, undefined);
			const label = `${target.Name} (${target.UserId})`;
			if (!outcome.ok) {
				record(caller, "resetSave", label, `FAILED ${outcome.error ?? "?"}`, false);
				return fail(outcome.error ?? "reset failed");
			}
			record(caller, "resetSave", label, "save reset to a new player's", true);
			sendPatch(target, outcome, [], caller, true);
			return { ok: true, data: outcome.save };
		}

		if (kind === "announce") {
			const text = trimText(req.text, ADMIN_LIMITS.ANNOUNCE);
			if (text === undefined || text === "") return fail(`1 to ${ADMIN_LIMITS.ANNOUNCE} characters`);
			const b = buckets.get(caller.UserId);
			if (b !== undefined) {
				if (os.clock() - b.lastAnnounce < ANNOUNCE_COOLDOWN) return fail("wait a moment between announcements");
				b.lastAnnounce = os.clock();
			}
			const filtered = filterText(text, caller);
			if (filtered === undefined) {
				record(caller, "announce", "all", `FAILED text filter: "${text}"`, false);
				return fail("the text filter is unavailable right now; try again");
			}
			record(caller, "announce", "all", `"${filtered}"`, true);
			const ev: AdminEvent = { kind: "announce", text: filtered, from: caller.DisplayName };
			remotes.event.FireAllClients(ev);
			return { ok: true, message: "announcement sent" };
		}

		if (kind === "serverInfo") {
			const info: ServerInfo = {
				jobId: host.jobId,
				placeId: game.PlaceId,
				placeVersion: game.PlaceVersion,
				studio: RunService.IsStudio(),
				uptime: math.floor(Workspace.DistributedGameTime),
				players: Players.GetPlayers().size(),
				maxPlayers: Players.MaxPlayers,
				dataStore: host.dataStoreStatus(),
				auditStore: auditStatus,
			};
			return { ok: true, data: info };
		}

		if (kind === "auditLog") {
			const list: Array<AuditEntry> = [];
			for (let i = audit.size() - 1; i >= 0; i--) list.push(audit[i]);
			return { ok: true, data: list };
		}

		if (kind === "watch") {
			if (req.userId === 0) {
				watching.delete(caller.UserId);
				return { ok: true };
			}
			const target = onlineTarget(caller, req.userId, "watch");
			if (typeIs(target, "string")) return fail(target);
			watching.set(caller.UserId, target.UserId);
			return { ok: true, data: playerRow(target) };
		}

		if (kind === "assist") {
			if (host.markAssisted(caller)) {
				record(
					caller,
					"assist",
					"own run",
					"world tools used: this run earns no coins / achievements / records",
					true,
				);
			}
			return { ok: true };
		}

		if (kind === "logLocal") {
			const action = trimText(req.action, ADMIN_LIMITS.LOG_ACTION);
			const details = trimText(req.details, ADMIN_LIMITS.LOG_DETAILS);
			if (action === undefined || action === "" || details === undefined) return fail("invalid log entry");
			record(caller, `local:${action}`, "own world", details, true);
			return { ok: true };
		}

		return fail("unknown request");
	}

	remotes.request.OnServerInvoke = (player: Player, raw: unknown): AdminResponse => {
		// 1) authorization by UserId, before looking at the payload
		if (!isAdminUserId(player.UserId)) {
			const now = os.clock();
			const last = denied.get(player.UserId) ?? -math.huge;
			if (now - last >= DENY_LOG_INTERVAL) {
				denied.set(player.UserId, now);
				// nothing typed by the caller is logged but a plain request name
				const kind = typeIs(raw, "table") ? (raw as Record<string, unknown>).kind : undefined;
				const k =
					typeIs(kind, "string") && string.match(kind, "^[%w_]+$")[0] !== undefined ? kind.sub(1, 24) : "?";
				record(player, "DENIED", "", `non-admin called the admin remote (request "${k}")`, false, false);
			}
			return fail("forbidden");
		}
		// 2) rate limit, 3) payload shape
		if (!takeToken(player.UserId)) return fail("too many requests; slow down");
		if (!typeIs(raw, "table")) return fail("invalid request");
		const req = raw as Record<string, unknown>;
		if (!typeIs(req.kind, "string")) return fail("invalid request");
		const [ok, res] = pcall(() => handle(player, req));
		if (!ok) {
			warn(`${LOG_PREFIX} request "${req.kind}" from ${player.Name} errored: ${tostring(res)}`);
			return fail("server error (see the server log)");
		}
		return res as AdminResponse;
	};

	remotes.patchAck.OnServerEvent.Connect((player, rev) => {
		if (typeIs(rev, "number")) host.ackPatch(player, rev);
	});

	function markAdmin(p: Player): void {
		if (isAdminUserId(p.UserId)) {
			p.SetAttribute(ADMIN_ATTRIBUTE, true);
			print(`${LOG_PREFIX} admin ${p.Name} (${p.UserId}) joined; panel enabled`);
		}
	}
	Players.PlayerAdded.Connect(markAdmin);
	for (const p of Players.GetPlayers()) markAdmin(p);
	Players.PlayerRemoving.Connect(p => {
		buckets.delete(p.UserId);
		denied.delete(p.UserId);
		watching.delete(p.UserId);
		for (const [adminId, watched] of watching) {
			if (watched === p.UserId) watching.delete(adminId);
		}
	});

	print(`[${GAME_NAME}] admin server ready (${AUDIT_STORE}: ${auditStatus})`);

	return {
		onReport(player: Player): void {
			pushWatch(player);
		},
	};
}
