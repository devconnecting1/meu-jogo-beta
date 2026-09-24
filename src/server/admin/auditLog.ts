/*
 * The admin audit log as it is STORED (DataStore ProjectZ_AdminLog), with no service in it: the key names, what an
 * entry may hold, how an old entry is read, and the filter the right-to-erasure tooling applies.
 * server/admin/adminServer.ts does the I/O; `npm run cloud -- erase` (tools/cloud.mjs) applies the same filter to the
 * same keys through Open Cloud; tools/test-save.mjs drives both.
 *
 * What an entry may hold (compliance audit F5):
 *   - people only as UserIds (`adminId`, `targetId`). A name is looked up when the panel shows the log, never stored:
 *     a username changes, and a stored one is personal data sitting under a key no erasure template can match;
 *   - text only as the Roblox text filter returned it (a kick or ban reason as the player saw it, an announcement) or
 *     as the game itself wrote it (an edit's ops, a duration, an error). A text that failed the filter is not stored
 *     at all, and neither is the ban's private note (it lives in Roblox's own ban history, where it belongs).
 *
 * Keys (data audit F4, the hot key): one per SERVER per UTC DAY, `log_<YYYYMMDD>_<job>`. Every key has one writer,
 * the server whose JobId it names, so no two servers ever contend for it: the old single key "recent" took an
 * UpdateAsync from every server that logged anything, and a key's write budget does not grow with the server count.
 * The panel lists the keys of today and yesterday by their day prefix. The old key stays readable (LEGACY_AUDIT_KEY):
 * its entries are read through the same sanitizer and the key is scrubbed in place once; nothing appends to it.
 */

/** a DataStore key name is at most 50 characters: "log_" + 8 + "_" + JOB_TAG_MAX = 45 */
export const AUDIT_KEY_PREFIX = "log_";
const JOB_TAG_MAX = 32;
/** the single document every server appended to before the per-server-per-day keys (read-only now) */
export const LEGACY_AUDIT_KEY = "recent";
/** entries kept per key (one server's day); the oldest go first */
export const AUDIT_PER_KEY = 300;

/** targets that are not a player, and therefore may be stored as words */
const PLACE_TARGETS: ReadonlyArray<string> = ["", "all", "own world", "own run", "own town"];

/** one stored entry */
export interface AuditRecord {
	/** os.time() */
	t: number;
	adminId: number;
	/** e.g. "kick", "ban", "edit", "local:spawn" */
	action: string;
	/** the player acted on, 0 = none (an announcement, the admin's own world) */
	targetId: number;
	/** what was acted on when it is not a player: one of PLACE_TARGETS */
	target: string;
	/** filtered or game-written text only (see the header) */
	details: string;
	ok: boolean;
}

function two(n: number): string {
	return n < 10 ? `0${n}` : tostring(n);
}

/** "YYYYMMDD" of an os.time() in UTC (days since the epoch to a civil date, H. Hinnant's algorithm: no os.date) */
export function utcDay(t: number): string {
	const z = math.floor(t / 86400) + 719468;
	const era = math.floor(z / 146097);
	const doe = z - era * 146097;
	const yoe = math.floor((doe - math.floor(doe / 1460) + math.floor(doe / 36524) - math.floor(doe / 146096)) / 365);
	const doy = doe - (365 * yoe + math.floor(yoe / 4) - math.floor(yoe / 100));
	const mp = math.floor((5 * doy + 2) / 153);
	const d = doy - math.floor((153 * mp + 2) / 5) + 1;
	const m = mp < 10 ? mp + 3 : mp - 9;
	const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
	return `${y}${two(m)}${two(d)}`;
}

function isAlnum(c: string): boolean {
	return (c >= "0" && c <= "9") || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

/** the server's JobId reduced to what a key may carry: letters and digits, at most JOB_TAG_MAX ("studio" if none) */
export function jobTag(jobId: string): string {
	let out = "";
	for (let i = 1; i <= jobId.size() && out.size() < JOB_TAG_MAX; i++) {
		const c = jobId.sub(i, i);
		if (isAlnum(c)) out += c;
	}
	return out === "" ? "studio" : out;
}

/** the prefix of every key of the UTC day `t` falls in (what the panel lists) */
export function auditDayPrefix(t: number): string {
	return `${AUDIT_KEY_PREFIX}${utcDay(t)}_`;
}

/** the key an entry logged at `t` by the server `jobId` is written to */
export function auditKey(t: number, jobId: string): string {
	return `${auditDayPrefix(t)}${jobTag(jobId)}`;
}

function isDigits(s: string): boolean {
	if (s.size() === 0 || s.size() > 15) return false;
	for (let i = 1; i <= s.size(); i++) {
		const c = s.sub(i, i);
		if (c < "0" || c > "9") return false;
	}
	return true;
}

/** 1-based position of `needle` in `s` (plain text), or 0 */
function findPlain(s: string, needle: string): number {
	const n = needle.size();
	for (let i = 1; i + n - 1 <= s.size(); i++) {
		if (s.sub(i, i + n - 1) === needle) return i;
	}
	return 0;
}

/** the UserId an old entry's target label named: "Name (123)", "#123" or "123"; 0 when it named none */
function legacyTargetId(label: string): number {
	let digits = "";
	if (label.sub(-1) === ")") {
		for (let i = label.size() - 1; i >= 1; i--) {
			if (label.sub(i, i) === "(") {
				digits = label.sub(i + 1, label.size() - 1);
				break;
			}
		}
	} else if (label.sub(1, 1) === "#") {
		digits = label.sub(2);
	} else {
		digits = label;
	}
	return isDigits(digits) ? (tonumber(digits) ?? 0) : 0;
}

/**
 * What an entry written before this scheme may keep of its `details`. A kick stored the raw reason, a ban the raw
 * shown and private reasons after its options, an announcement the text (the one that failed the filter too): all of
 * that goes. Edits, resets, unbans, world tools and errors were written by the game and stay.
 */
function legacyDetails(action: string, details: string): string {
	if (action === "kick" || action === "announce") return "";
	if (action === "ban") {
		const at = findPlain(details, ", reason=");
		if (at > 0) return details.sub(1, at - 1);
		// a refusal ("refused: self") names nobody and typed nothing
		return findPlain(details, "reason") > 0 || findPlain(details, "private") > 0 ? "" : details;
	}
	return details;
}

/**
 * An entry read from the store, in the stored shape; undefined when it is not one. An entry of the current shape
 * (it has `targetId`) is taken as written, with a target that is not a place word dropped; an older one (a name in
 * `admin`, a "Name (id)" target) is reduced to what the current shape may hold.
 */
export function readAuditEntry(v: unknown): AuditRecord | undefined {
	if (!typeIs(v, "table")) return undefined;
	const r = v as Record<string, unknown>;
	if (!typeIs(r.t, "number") || !typeIs(r.action, "string")) return undefined;
	const adminId = typeIs(r.adminId, "number") ? r.adminId : 0;
	const label = typeIs(r.target, "string") ? r.target : "";
	const details = typeIs(r.details, "string") ? r.details : "";
	const current = typeIs(r.targetId, "number");
	const targetId = current ? (r.targetId as number) : legacyTargetId(label);
	return {
		t: r.t,
		adminId,
		action: r.action,
		targetId,
		target: PLACE_TARGETS.includes(label) ? label : "",
		details: current ? details : legacyDetails(r.action, details),
		ok: r.ok === true,
	};
}

/**
 * A stored document still holds something the current shape may not: an entry written before it (no `targetId`, a
 * name in `admin`, a "Name (id)" target) or something that is not an entry at all. The legacy key is rewritten
 * through readAuditList only while this is true, so a clean document is never written again.
 */
export function auditNeedsScrub(doc: unknown): boolean {
	if (!typeIs(doc, "table")) return false;
	for (const v of doc as Array<unknown>) {
		if (!typeIs(v, "table")) return true;
		const r = v as Record<string, unknown>;
		if (!typeIs(r.targetId, "number") || r.admin !== undefined) return true;
		if (!typeIs(r.target, "string") || !PLACE_TARGETS.includes(r.target)) return true;
	}
	return false;
}

/** a stored document (an array of entries) read into records; anything else reads as empty */
export function readAuditList(doc: unknown): Array<AuditRecord> {
	const list: Array<AuditRecord> = [];
	if (!typeIs(doc, "table")) return list;
	for (const v of doc as Array<unknown>) {
		const e = readAuditEntry(v);
		if (e !== undefined) list.push(e);
	}
	return list;
}

/** the same entry read twice (from memory and from the store) is shown once */
export function auditIdentity(e: AuditRecord): string {
	return `${e.t}|${e.adminId}|${e.action}|${e.targetId}|${e.target}|${e.details}|${e.ok ? 1 : 0}`;
}

/**
 * A world tool (a spawn, the clock, a teleport... in the admin's own world, "local:", or in the server's, "world:"),
 * the "assist" mark, a refused non-admin call, or what the server did on its own (`auto:`): many, cheap, and written by
 * the game rather than decided by an admin -- a stream of them (an afternoon of spawning, a flood of alts kicked one
 * after the other) must never push an admin's kick or ban out of the log (the review of 8f50bc5, MEDIUM-4; the
 * security review of the net hardening, L6). Everything else (kick, ban, unban, a save edit or reset, an
 * announcement) is an admin's action on players, and is what the log is for.
 */
function isToolEntry(e: AuditRecord): boolean {
	const head = e.action.sub(1, 6);
	return head === "local:" || head === "world:" || e.action === "assist" || e.action === "DENIED" || isAutoEntry(e);
}

/**
 * What the server did on its own (`auto:`: a flood kick, by server/net/mpHost.ts or by the admin remote's own
 * ADMIN_RATE rule): the audit keeps it, but it is cheap to cause -- one alt rejoining and flooding again is one more
 * kick -- so it trims like a tool entry, the admin server writes one per action and UserId per server
 * (server/admin/adminServer.ts `recordAs`), and a key keeps one per action and UserId (`appendAudit` keeps the
 * newest: the same player kicked by another server of the same day). The security review of the net hardening, L6.
 */
function isAutoEntry(e: AuditRecord): boolean {
	return e.action.sub(1, 5) === "auto:";
}

/**
 * Cuts `list` (oldest first) down to `max`: the oldest TOOL entry goes first, and an action on a player only once no
 * tool entry is left -- an afternoon of spawning zombies never pushes a ban out of the log.
 */
export function trimAudit(list: Array<AuditRecord>, max: number): void {
	while (list.size() > max) {
		let victim = 0;
		for (let i = 0; i < list.size(); i++) {
			if (isToolEntry(list[i])) {
				victim = i;
				break;
			}
		}
		list.remove(victim);
	}
}

/** a key's document with `batch` appended, cut to AUDIT_PER_KEY (trimAudit: tool entries go first) */
export function appendAudit(doc: unknown, batch: ReadonlyArray<AuditRecord>): Array<AuditRecord> {
	const list = readAuditList(doc);
	for (const e of batch) {
		// an automatic action repeated on the same UserId replaces its older line (`isAutoEntry`)
		if (isAutoEntry(e)) {
			for (let i = list.size() - 1; i >= 0; i--) {
				const old = list[i];
				if (old.action === e.action && old.targetId === e.targetId) list.remove(i);
			}
		}
		list.push(e);
	}
	trimAudit(list, AUDIT_PER_KEY);
	return list;
}

/** what the game appends to a ban's private note (server/admin/adminServer.ts): " | by admin <UserId>" */
export const BAN_NOTE_SUFFIX = " | by admin ";

/**
 * A ban's private note split into what an admin typed and the suffix the game wrote. Only the typed part goes
 * through the text filter when it is shown back (the filter hashes digit runs, so the admin's UserId would come
 * back as "#########"); a note without the suffix (a ban made elsewhere) is all typed.
 */
export function splitBanNote(note: string): [string, string] {
	const n = BAN_NOTE_SUFFIX.size();
	for (let i = note.size() - n + 1; i >= 1; i--) {
		if (note.sub(i, i + n - 1) !== BAN_NOTE_SUFFIX) continue;
		const id = note.sub(i + n);
		return isDigits(id) ? [note.sub(1, i - 1), note.sub(i)] : [note, ""];
	}
	return [note, ""];
}

/**
 * Right to erasure: the entries of `doc` that are about `userId` -- as the admin who acted or as the player acted on
 * -- removed. Also the scrub of the legacy key (userId 0 removes nobody but still sanitizes). Answers the kept list
 * and how many entries went.
 */
export function eraseAuditUser(doc: unknown, userId: number): [Array<AuditRecord>, number] {
	const kept: Array<AuditRecord> = [];
	let removed = 0;
	for (const e of readAuditList(doc)) {
		if (userId !== 0 && (e.adminId === userId || e.targetId === userId)) removed += 1;
		else kept.push(e);
	}
	return [kept, removed];
}
