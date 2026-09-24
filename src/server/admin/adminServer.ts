import { GAME_NAME } from "shared/module";
import type { PlayerSaveData } from "shared/game/save";
import type { LoadStatus } from "shared/net/net";
import { ADMIN_ATTRIBUTE, ADMIN_LABELS, isAdminUserId } from "shared/admin/config";
import { AdminOp, describeOps, readAdminOps, safeText } from "shared/admin/ops";
import { banMessage, floodKickMessage, kickMessage, langTypeOfLocale } from "shared/data/rules";
import { ADMIN_BURST, ADMIN_RATE } from "shared/net/mpConfig";
import { ADMIN_WORLD_LIMITS } from "shared/admin/worldOps";
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
import {
	appendAudit,
	auditDayPrefix,
	auditIdentity,
	auditKey,
	auditNeedsScrub,
	AuditRecord,
	BAN_NOTE_SUFFIX,
	LEGACY_AUDIT_KEY,
	readAuditList,
	splitBanNote,
	trimAudit,
} from "./auditLog";
import { startAdminWorld } from "./adminWorld";
import { activeMpHost } from "../net/mpHost";

/*
 * Server side of the admin panel.
 * - authorization: EVERY request re-checks the caller's UserId (shared/admin/config.ts) before reading its payload;
 *   nothing from the client is trusted (types, ranges and lengths are validated even for admins)
 * - rate limited per admin (token bucket) + a cooldown on announcements; denied callers are logged (throttled)
 * - audit: every action (allowed or refused) is printed with the "[PZ-ADMIN]" prefix, kept in a memory ring shown
 *   in the panel and persisted (best effort, pcall) to the "ProjectZ_AdminLog" DataStore -- UserIds and filtered
 *   text only, one key per server per day (server/admin/auditLog.ts); names are looked up when the panel shows it
 * - save edits go through the host (main.server.ts), which owns the sessions, the invariants and the report gate
 * - world tools (`kind: "world"`, docs/MULTIPLAYER.md §10) run on the world the server owns (server/admin/adminWorld.ts)
 *   and answer what really happened: the panel toasts success only on that OK
 * - a NON-admin who floods this remote (ADMIN_RATE / ADMIN_BURST) is kicked, once, with one audit entry (§8.2, §9.2)
 * - what a kicked or banned player reads comes from shared/data/rules.ts (lang.ts, and a pointer to the rules)
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
/** entries kept in memory (panel); each stored key keeps auditLog.ts AUDIT_PER_KEY */
const AUDIT_MEMORY = 200;
/** entries waiting for a write that keeps failing, at most */
const AUDIT_UNSAVED_MAX = 300;
const AUDIT_FLUSH_INTERVAL = 30;
/** the panel's log reads the stored keys of the last this-many UTC days (today included) */
const AUDIT_READ_DAYS = 2;
/** stored keys read per day at most (one per server that logged something that day) */
const AUDIT_READ_KEYS = 20;
/** the stored log is read again (other servers' new entries) when the panel asks this long after the last read */
const AUDIT_RELOAD_S = 60;
/** names looked up (GetNameFromUserIdAsync) per log request at most; the rest show as #UserId */
const NAME_LOOKUPS = 8;

/** admin requests: token bucket (the panel polls the player list every ~2 s) */
const REQ_BURST = 12;
const REQ_PER_SECOND = 4;
const ANNOUNCE_COOLDOWN = 3;
/** a refused non-admin caller is logged at most this often (s) */
const DENY_LOG_INTERVAL = 60;
/** the free camera's updates have a bucket of their own (§10: 5/s), so moving the camera never starves the panel */
const CAM_BURST = ADMIN_WORLD_LIMITS.FREECAM_HZ;
const CAM_PER_SECOND = ADMIN_WORLD_LIMITS.FREECAM_HZ;
/** repeats of one world tool by one admin inside this window share one audit line ("×N"): a slider, Shift+click */
const MERGE_S = 2;

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
	/** the body in the town, as the simulation has it (undefined = not in the world / MP_PHASE 0) */
	live?: AdminLiveView;
}

/** §9.3: what the simulation says about a survivor in the town, read-only, for the admin's players table */
export interface AdminLiveView {
	dead: boolean;
	hp: number;
	hpMax: number;
	/** seconds since the last real input (MP-13's AFK test) */
	idleS: number;
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

/** a plain token bucket: `rate` tokens a second up to `burst` */
interface Tokens {
	tokens: number;
	at: number;
}

function take(bucket: Tokens, burst: number, rate: number, now: number): boolean {
	bucket.tokens = math.min(burst, bucket.tokens + math.max(0, now - bucket.at) * rate);
	bucket.at = now;
	if (bucket.tokens < 1) return false;
	bucket.tokens -= 1;
	return true;
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
	/** §10: the world tools, on the world the server owns (server/admin/adminWorld.ts) */
	const world = startAdminWorld({
		host: () => activeMpHost(),
		markAssisted: p => host.markAssisted(p),
		broadcast: ev => remotes.event.FireAllClients(ev),
	});
	const buckets = new Map<number, Bucket>();
	const camBuckets = new Map<number, Tokens>();
	/** non-admins who called this remote: their flood bucket (ADMIN_RATE / ADMIN_BURST), and who was kicked for it */
	const strangers = new Map<number, Tokens>();
	const flooded = new Set<number>();
	const denied = new Map<number, number>();
	/** admin UserId → watched UserId */
	const watching = new Map<number, number>();
	const audit: Array<AuditRecord> = [];
	const unsaved: Array<AuditRecord> = [];
	/** what the last read of the stored log said, and the last write's error (undefined = the last write landed) */
	let auditStatus = "not read yet (read when an admin opens the log)";
	let auditWriteError: string | undefined;
	const [storeOk, storeValue] = pcall((): unknown => DataStoreService.GetDataStore(AUDIT_STORE));
	const auditStore = storeOk ? (storeValue as DataStore) : undefined;
	if (auditStore === undefined) auditStatus = `unavailable (${tostring(storeValue)})`;
	/** os.clock() of the last read of the stored log (-huge = never); `reading` while one is in flight */
	let auditReadAt = -math.huge;
	let reading = false;
	/** UserId → name, looked up for the panel only (never stored) */
	const names = new Map<number, string>();

	// ------------------------------------------------------------ audit

	/** the last merged world-tool line, so a repeat inside MERGE_S counts on it instead of adding one */
	let lastMerge: { e: AuditRecord; n: number; at: number } | undefined;

	/**
	 * `targetId`: the player acted on (0 = none); `target`: a place word when there is no player ("all", "own world",
	 * "own run"); `details`: filtered or game-written text only (server/admin/auditLog.ts). `persist` false: memory +
	 * output only (refused non-admin calls must not flood the stored log). `merge`: the same tool again by the same
	 * admin within MERGE_S (a slider, Shift+click) updates the last line ("×N") instead of adding one.
	 */
	function record(
		admin: Player,
		action: string,
		targetId: number,
		target: string,
		details: string,
		ok: boolean,
		persist = true,
		merge = false,
	): void {
		const last = lastMerge;
		if (
			merge &&
			last !== undefined &&
			os.clock() - last.at <= MERGE_S &&
			last.e.adminId === admin.UserId &&
			last.e.action === action &&
			last.e.targetId === targetId &&
			last.e.ok === ok
		) {
			// the same tool again (a slider dragged, Shift+click placing): one line, the latest details and a count
			last.n += 1;
			last.at = os.clock();
			last.e.details = safeText(`${details} (×${last.n})`, ADMIN_LIMITS.LOG_DETAILS);
			return;
		}
		// every string is valid UTF-8 and bounded: one bad entry must never block the DataStore flush
		const e: AuditRecord = {
			t: os.time(),
			adminId: admin.UserId,
			action: safeText(action, ADMIN_LIMITS.LOG_ACTION + 8),
			targetId,
			target: safeText(target, 24),
			details: safeText(details, ADMIN_LIMITS.LOG_DETAILS),
			ok,
		};
		// the server output carries ids only, like the stored log
		const on = targetId !== 0 ? tostring(targetId) : e.target !== "" ? e.target : "-";
		print(
			`${LOG_PREFIX} admin ${e.adminId} ${e.action} target=${on} ` +
				`${ok ? "OK" : "REFUSED"}${e.details !== "" ? ` — ${e.details}` : ""}`,
		);
		audit.push(e);
		trimAudit(audit, AUDIT_MEMORY);
		if (auditStore !== undefined && persist) unsaved.push(e);
		lastMerge = merge ? { e, n: 1, at: os.clock() } : undefined;
	}

	/** the entry survives a JSON round trip (a DataStore write fails on invalid UTF-8) */
	function encodable(e: AuditRecord): boolean {
		const [ok] = pcall(() => HttpService.JSONEncode(e));
		return ok;
	}

	/** writes what is waiting, each entry to its own day's key of THIS server (one writer per key: no contention) */
	function flushAudit(): void {
		const store = auditStore;
		if (store === undefined || unsaved.size() === 0) return;
		const byKey = new Map<string, Array<AuditRecord>>();
		// an entry that cannot be encoded is dropped alone, never blocking the others
		for (const e of unsaved) {
			if (!encodable(e)) continue;
			const key = auditKey(e.t, host.jobId);
			const list = byKey.get(key) ?? [];
			list.push(e);
			byKey.set(key, list);
		}
		unsaved.clear();
		for (const [key, batch] of byKey) {
			const [ok, err] = pcall(() => {
				store.UpdateAsync<unknown, unknown>(key, old => $tuple(appendAudit(old, batch)));
			});
			if (ok) {
				auditWriteError = undefined;
				continue;
			}
			// keep them for the next attempt (bounded)
			for (const e of batch) unsaved.push(e);
			while (unsaved.size() > AUDIT_UNSAVED_MAX) unsaved.remove(0);
			auditWriteError = `write failed (${tostring(err)})`;
			warn(`${LOG_PREFIX} audit log not saved: ${tostring(err)}`);
		}
	}

	/** one stored document, or undefined when it could not be read */
	function readKey(store: DataStore, key: string): unknown {
		const [ok, value] = pcall((): unknown => store.GetAsync<unknown>(key)[0]);
		if (!ok) error(value, 0);
		return value;
	}

	/**
	 * The entries written before the per-server-per-day keys (auditLog.ts LEGACY_AUDIT_KEY): read through the
	 * sanitizer, and the document rewritten once without names and raw text if it still has any. Nothing appends to it.
	 */
	function readLegacy(store: DataStore): Array<AuditRecord> {
		const raw = readKey(store, LEGACY_AUDIT_KEY);
		if (!typeIs(raw, "table")) return [];
		if (auditNeedsScrub(raw)) {
			pcall(() => {
				// nothing left to scrub (another server did it meanwhile): no write
				store.UpdateAsync<unknown, unknown>(LEGACY_AUDIT_KEY, old =>
					$tuple(auditNeedsScrub(old) ? readAuditList(old) : undefined),
				);
			});
		}
		return readAuditList(raw);
	}

	/**
	 * The stored log of the last AUDIT_READ_DAYS days, merged into the memory ring (what this server logged is in both
	 * once flushed: shown once). Read when an admin opens the log, and again after AUDIT_RELOAD_S -- never at boot:
	 * a server nobody administers never reads it. Yields.
	 */
	function readStoredLog(): void {
		const store = auditStore;
		if (store === undefined || reading || os.clock() - auditReadAt < AUDIT_RELOAD_S) return;
		reading = true;
		const [ok, err] = pcall(() => {
			const found = readLegacy(store);
			for (let d = AUDIT_READ_DAYS - 1; d >= 0; d--) {
				const pages = store.ListKeysAsync(auditDayPrefix(os.time() - d * 86400), AUDIT_READ_KEYS);
				// one page is enough: a key per server that logged something that day, and AUDIT_READ_KEYS of them at most
				const keys = pages.GetCurrentPage() as unknown as Array<DataStoreKey>;
				for (let i = 0; i < keys.size() && i < AUDIT_READ_KEYS; i++) {
					for (const e of readAuditList(readKey(store, keys[i].KeyName))) found.push(e);
				}
			}
			const seen = new Set<string>();
			const merged: Array<AuditRecord> = [];
			for (const list of [found, audit]) {
				for (const e of list) {
					const id = auditIdentity(e);
					if (seen.has(id)) continue;
					seen.add(id);
					merged.push(e);
				}
			}
			merged.sort((a, b) => a.t < b.t);
			audit.clear();
			for (const e of merged) audit.push(e);
			trimAudit(audit, AUDIT_MEMORY);
		});
		reading = false;
		auditReadAt = os.clock();
		if (ok) {
			auditStatus = "ok";
		} else {
			auditStatus = RunService.IsStudio()
				? `unavailable in Studio (${tostring(err)})`
				: `read failed (${tostring(err)})`;
		}
	}

	/** a player's name for the panel: online, an admin label, a cached lookup, or `#id` past the lookup budget */
	function nameOf(userId: number, budget: { left: number }): string {
		const online = Players.GetPlayerByUserId(userId);
		if (online !== undefined) return online.Name;
		const known = names.get(userId) ?? ADMIN_LABELS.get(userId);
		if (known !== undefined) return known;
		if (budget.left <= 0 || userId <= 0) return `#${userId}`;
		budget.left -= 1;
		const [ok, name] = pcall(() => Players.GetNameFromUserIdAsync(asUser(userId)));
		const shown = ok && typeIs(name, "string") ? name : `#${userId}`;
		names.set(userId, shown);
		return shown;
	}

	/** the memory ring as the panel shows it, newest first, with names looked up now (and never written anywhere) */
	function auditForPanel(): Array<AuditEntry> {
		const budget = { left: NAME_LOOKUPS };
		const list: Array<AuditEntry> = [];
		for (let i = audit.size() - 1; i >= 0; i--) {
			const e = audit[i];
			list.push({
				t: e.t,
				adminId: e.adminId,
				admin: e.adminId !== 0 ? nameOf(e.adminId, budget) : "?",
				action: e.action,
				target: e.targetId !== 0 ? `${nameOf(e.targetId, budget)} (${e.targetId})` : e.target,
				details: e.details,
				ok: e.ok,
			});
		}
		return list;
	}

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
		const live = s?.live;
		// the engine's own measure of this client's round trip (seconds); an old client or a test may not have it
		const [pingOk, ping] = pcall(() => p.GetNetworkPing());
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
			inWorld: live !== undefined,
			dead: live?.dead ?? false,
			hp: live !== undefined ? math.floor(live.hp) : 0,
			hpMax: live !== undefined ? math.floor(live.hpMax) : 0,
			idleS: live !== undefined ? math.floor(live.idleS) : -1,
			pingMs: pingOk && typeIs(ping, "number") && ping === ping && ping >= 0 ? math.floor(ping * 1000) : -1,
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

	/** stored text shown back to one admin, as the filter returns it for them (a failure hides it) */
	function filterFor(text: string, viewer: Player): string {
		const [ok, result] = pcall(() => TextService.FilterStringAsync(text, viewer.UserId));
		if (ok) {
			const [ok2, shown] = pcall(() => (result as TextFilterResult).GetNonChatStringForUserAsync(viewer.UserId));
			if (ok2 && typeIs(shown, "string")) return shown;
		}
		return "(hidden: the text filter is unavailable)";
	}

	/** a UserId (digits) or a username → [userId, name] */
	function resolveTarget(raw: unknown): [number, string] | string {
		const t = trimText(raw, ADMIN_LIMITS.TARGET);
		if (t === undefined || t === "") return "enter a UserId or a username";
		// Studio's Local Server test players have negative ids: they are not Roblox accounts, and the Ban API only
		// takes real ones (it used to fall through to the username check and read "invalid username")
		if (string.match(t, "^%-%d+$")[0] !== undefined) {
			return "a negative UserId is a Studio test player, not a Roblox account: the Ban API cannot act on it";
		}
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

	/**
	 * What to do about a failed Ban API call. BanAsync / UnbanAsync need Players.BanningEnabled (a place property that
	 * script cannot set: default.project.json, `npm run check:place`). GetBanHistoryAsync ALSO only works on a live
	 * (production) server -- never in Studio, published or not (creator-docs, Players:GetBanHistoryAsync) -- so no
	 * setting fixes it there, and the hint used to send the admin publishing for nothing.
	 */
	function banApiError(err: unknown, history = false): string {
		let hint = " — check that Players.BanningEnabled is on for this place.";
		if (history && RunService.IsStudio()) {
			hint = " — the ban history only works on a live server, never in Studio: no setting changes that.";
		} else if (history) {
			hint = " — check that Players.BanningEnabled is on (the ban history only works on live servers).";
		}
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

	/** the edit reaches the edited player's client; it does not name the admin (the toast says "an administrator") */
	function sendPatch(target: Player, outcome: AdminEditOutcome, ops: Array<AdminOp>, reset: boolean): void {
		const ev: AdminEvent = {
			kind: "patch",
			rev: outcome.rev,
			runRev: outcome.runRev,
			ops: reset ? [] : ops,
			reset: reset ? outcome.save : undefined,
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
				record(caller, "kick", isOnlineId(req.userId) ? req.userId : 0, "", target, false);
				return fail(target);
			}
			if (reason === undefined) return fail(`reason: at most ${ADMIN_LIMITS.KICK_REASON} characters`);
			// the player reads the reason only as the text filter returned it; the log keeps exactly that, never the
			// typed text (a reason the filter could not check is neither shown nor stored)
			const shown = reason !== "" ? filterText(reason, caller) : "";
			record(
				caller,
				"kick",
				target.UserId,
				"",
				shown === undefined ? "reason not shown (text filter unavailable)" : shown,
				true,
			);
			target.Kick(kickMessage(langTypeOfLocale(target.LocaleId), shown));
			return { ok: true, message: `${target.Name} was kicked` };
		}

		if (kind === "ban") {
			const resolved = resolveTarget(req.target);
			if (typeIs(resolved, "string")) return fail(resolved);
			const [userId, name] = resolved;
			const label = `${name} (${userId})`;
			if (userId === caller.UserId) {
				record(caller, "ban", userId, "", "refused: self", false);
				return fail("you cannot ban yourself");
			}
			if (isAdminUserId(userId)) {
				record(caller, "ban", userId, "", "refused: target is an admin", false);
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
			// what the banned player reads (Roblox shows it on every attempt to join): the reason as the filter returned
			// it, or the fixed line, and where the rules and the appeal are -- the experience page, the one place a
			// banned player can still open (shared/data/rules.ts). In the target's language when they are online
			const online = Players.GetPlayerByUserId(userId);
			const displayReason = banMessage(
				online !== undefined ? langTypeOfLocale(online.LocaleId) : 0,
				shown,
				ADMIN_LIMITS.DISPLAY_REASON,
				safeText,
			);
			// accountability: the private reason (only visible in the ban history) names the admin by UserId
			// the "| by admin" suffix is never cut: the note is trimmed to leave room for it
			const suffix = `${BAN_NOTE_SUFFIX}${caller.UserId}`;
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
			// the log keeps the options and the reason AS SHOWN (filtered); the typed text and the private note never
			// (the note lives in Roblox's ban history, read back through the filter: `banHistory` below)
			const shownLog =
				shown === undefined ? "not shown (text filter unavailable)" : shown === "" ? "none" : `"${shown}"`;
			const details =
				`${BAN_DURATION_LABEL[dur as BanDuration]}, universe=${tostring(req.applyToUniverse)}, ` +
				`excludeAlts=${tostring(req.excludeAlts)}, shown reason ${shownLog}, private note ${privateReason !== "" ? "yes" : "no"}`;
			if (!ok) {
				record(caller, "ban", userId, "", `FAILED ${tostring(err)} | ${details}`, false);
				return fail(banApiError(err));
			}
			record(caller, "ban", userId, "", details, true);
			// BanAsync removes a banned player who is online; make sure of it
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
				record(caller, "unban", userId, "", `FAILED ${tostring(err)}`, false);
				return fail(banApiError(err));
			}
			record(caller, "unban", userId, "", `universe=${tostring(req.applyToUniverse)}`, true);
			return { ok: true, message: `${label} unbanned` };
		}

		if (kind === "banHistory") {
			const resolved = resolveTarget(req.target);
			if (typeIs(resolved, "string")) return fail(resolved);
			const [userId, name] = resolved;
			const [ok, pages] = pcall(() => Players.GetBanHistoryAsync(asUser(userId)));
			if (!ok) return fail(banApiError(pages, true));
			const entries: Array<BanHistoryEntry> = [];
			const bp = pages as BanHistoryPages;
			// the reasons were typed by an admin (here, in the Creator Hub or through Open Cloud) and never went through
			// the filter as a whole: each one is shown to the admin reading it as the filter returns it for them (F12)
			const seen = new Map<string, string>();
			const forViewer = (text: string): string => {
				if (text === "") return "";
				const hit = seen.get(text);
				if (hit !== undefined) return hit;
				const shown = filterFor(text, caller);
				seen.set(text, shown);
				return shown;
			};
			// the note's " | by admin <UserId>" was written by the game: only the typed part goes through the filter
			const privateForViewer = (note: string): string => {
				const [typed, suffix] = splitBanNote(note);
				return `${forViewer(typed)}${suffix}`;
			};
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
						displayReason: forViewer(typeIs(r.DisplayReason, "string") ? r.DisplayReason : ""),
						privateReason: privateForViewer(typeIs(r.PrivateReason, "string") ? r.PrivateReason : ""),
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
			if (!outcome.ok) {
				record(caller, "edit", target.UserId, "", `FAILED ${outcome.error ?? "?"}: ${describeOps(ops)}`, false);
				return fail(outcome.error ?? "edit failed");
			}
			record(caller, "edit", target.UserId, "", describeOps(ops), true);
			sendPatch(target, outcome, ops, false);
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
			if (!outcome.ok) {
				record(caller, "resetSave", target.UserId, "", `FAILED ${outcome.error ?? "?"}`, false);
				return fail(outcome.error ?? "reset failed");
			}
			record(caller, "resetSave", target.UserId, "", "save reset to a new player's", true);
			sendPatch(target, outcome, [], true);
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
				// the text the filter could not check is neither sent nor stored
				record(caller, "announce", 0, "all", "FAILED: text filter unavailable (the text was not sent)", false);
				return fail("the text filter is unavailable right now; try again");
			}
			record(caller, "announce", 0, "all", `"${filtered}"`, true);
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
				auditStore: auditWriteError ?? auditStatus,
			};
			return { ok: true, data: info };
		}

		if (kind === "auditLog") {
			readStoredLog();
			return { ok: true, data: auditForPanel() };
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
					0,
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
			record(caller, `local:${action}`, 0, "own world", details, true);
			return { ok: true };
		}

		if (kind === "world") {
			const out = world.handle(caller, req);
			const a = out.audit;
			if (a !== undefined) record(caller, a.action, a.targetId, a.target, a.details, a.ok, true, a.merge);
			return out.res;
		}

		return fail("unknown request");
	}

	/**
	 * §8.2 / §9.2 level 2: a non-admin has no reason to call this remote at all (the panel is never built for them), so
	 * one who calls it faster than ADMIN_RATE a second past a burst of ADMIN_BURST is flooding it -- kicked, once, with
	 * the account-language line of shared/data/rules.ts and ONE audit entry (the refusals themselves stay throttled).
	 */
	function strangerFlood(player: Player, now: number): void {
		if (flooded.has(player.UserId)) return;
		let b = strangers.get(player.UserId);
		if (b === undefined) {
			b = { tokens: ADMIN_BURST, at: now };
			strangers.set(player.UserId, b);
		}
		if (take(b, ADMIN_BURST, ADMIN_RATE, now)) return;
		flooded.add(player.UserId);
		record(
			player,
			"auto-kick",
			player.UserId,
			"",
			`flooded the admin remote (over ${ADMIN_BURST} requests at more than ${ADMIN_RATE}/s) without being an admin`,
			true,
		);
		pcall(() => player.Kick(floodKickMessage(langTypeOfLocale(player.LocaleId))));
	}

	/** the free camera's own bucket (see CAM_BURST) */
	function takeCamToken(userId: number): boolean {
		const now = os.clock();
		let b = camBuckets.get(userId);
		if (b === undefined) {
			b = { tokens: CAM_BURST, at: now };
			camBuckets.set(userId, b);
		}
		return take(b, CAM_BURST, CAM_PER_SECOND, now);
	}

	remotes.request.OnServerInvoke = (player: Player, raw: unknown): AdminResponse => {
		// 1) authorization by UserId, before looking at the payload
		if (!isAdminUserId(player.UserId)) {
			const now = os.clock();
			strangerFlood(player, now);
			const last = denied.get(player.UserId) ?? -math.huge;
			if (now - last >= DENY_LOG_INTERVAL) {
				denied.set(player.UserId, now);
				// nothing typed by the caller is logged but a plain request name
				const kind = typeIs(raw, "table") ? (raw as Record<string, unknown>).kind : undefined;
				const k =
					typeIs(kind, "string") && string.match(kind, "^[%w_]+$")[0] !== undefined ? kind.sub(1, 24) : "?";
				record(player, "DENIED", 0, "", `non-admin called the admin remote (request "${k}")`, false, false);
			}
			return fail("forbidden");
		}
		// 2) rate limit (the free camera's moves on a bucket of their own), 3) payload shape
		const cam =
			typeIs(raw, "table") &&
			(raw as Record<string, unknown>).kind === "world" &&
			(raw as Record<string, unknown>).op === "freecam";
		const allowed = cam ? takeCamToken(player.UserId) : takeToken(player.UserId);
		if (!allowed) return fail("too many requests; slow down");
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
		camBuckets.delete(p.UserId);
		strangers.delete(p.UserId);
		flooded.delete(p.UserId);
		world.left(p.UserId);
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
