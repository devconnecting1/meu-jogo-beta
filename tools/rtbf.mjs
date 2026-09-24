/*
 * Right to erasure (RTBF), the part with no network and no key: which stores hold a player, how the admin log is
 * filtered, and how the `erase` command reads its arguments. tools/cloud.mjs does the Open Cloud calls with these;
 * tools/test-save.mjs checks them against the server's own code (src/server/admin/auditLog.ts, save/stores.ts).
 *
 * Kept apart from cloud.mjs so that file is ONLY a command: importing it always runs it (no "am I the main module?"
 * check, which a symlink or a junction silently defeats).
 */

/**
 * The stores that hold ONE player's data under the key `<UserId>` (src/server/save/stores.ts), each also with the
 * Studio suffix. ProjectZ_Worlds holds nobody's data (seed, days, JobId, a death tally) and is not touched.
 */
export const PLAYER_STORES = ["ProjectZ_Save_v2", "ProjectZ_Save_v1", "ProjectZ_Titles"];
export const ADMIN_LOG_STORE = "ProjectZ_AdminLog";
export const STUDIO_SUFFIX = "_studio";
/** the admin log's keys (src/server/admin/auditLog.ts): one per server per day, and the old single key */
export const AUDIT_KEY_PREFIX = "log_";
export const LEGACY_AUDIT_KEY = "recent";
/** every entry the Open Cloud API names lives in the default scope */
export const SCOPE = "global";

const PLACE_TARGETS = ["", "all", "own world", "own run"];

/** the UserId an entry of the admin log is about as the target: `targetId`, or an old "Name (id)" / "#id" label */
export function auditTargetId(e) {
	if (typeof e.targetId === "number") return e.targetId;
	const label = typeof e.target === "string" ? e.target : "";
	const m = /\((\d+)\)$/.exec(label) ?? /^#?(\d+)$/.exec(label);
	return m ? Number(m[1]) : 0;
}

/**
 * An entry as src/server/admin/auditLog.ts `readAuditEntry` keeps it: ids, and no typed text (an entry written before
 * that scheme loses its name, its "Name (id)" label, and the raw reason of a kick, a ban or an announcement).
 */
export function sanitizeAuditEntry(e) {
	const current = typeof e.targetId === "number";
	const label = typeof e.target === "string" ? e.target : "";
	let details = typeof e.details === "string" ? e.details : "";
	if (!current) {
		if (e.action === "kick" || e.action === "announce") details = "";
		else if (e.action === "ban") {
			const at = details.indexOf(", reason=");
			if (at >= 0) details = details.slice(0, at);
			else if (details.includes("reason") || details.includes("private")) details = "";
		}
	}
	return {
		t: e.t,
		adminId: typeof e.adminId === "number" ? e.adminId : 0,
		action: e.action,
		targetId: auditTargetId(e),
		target: PLACE_TARGETS.includes(label) ? label : "",
		details,
		ok: e.ok === true,
	};
}

/**
 * The same filter as src/server/admin/auditLog.ts `eraseAuditUser`: every entry about `userId` -- the admin who
 * acted, or the player acted on -- removed, and what stays in the stored shape (no names, no typed text). Answers
 * [kept, removed]. It matches ids only: a filtered reason that names someone in words is not found by this.
 */
export function eraseAuditEntries(doc, userId) {
	const kept = [];
	let removed = 0;
	for (const e of Array.isArray(doc) ? doc : []) {
		if (e === null || typeof e !== "object" || typeof e.t !== "number" || typeof e.action !== "string") continue;
		if (e.adminId === userId || auditTargetId(e) === userId) removed++;
		else kept.push(sanitizeAuditEntry(e));
	}
	return [kept, removed];
}

/** what `erase` does, in order, for `userId` (the plan it prints before anything else) */
export function erasePlan(userId) {
	const steps = [];
	for (const suffix of ["", STUDIO_SUFFIX]) {
		for (const store of PLAYER_STORES) steps.push({ kind: "delete", store: store + suffix, key: String(userId) });
	}
	for (const suffix of ["", STUDIO_SUFFIX]) {
		steps.push({
			kind: "scrub",
			store: ADMIN_LOG_STORE + suffix,
			keys: `${LEGACY_AUDIT_KEY} + ${AUDIT_KEY_PREFIX}*`,
		});
	}
	return steps;
}

/** the flags `erase` knows; anything else refuses the whole command */
const ERASE_FLAGS = new Set(["--dry-run", "--yes"]);

/**
 * `erase <userId> [--dry-run | --yes]`, strictly: a destructive command never guesses. Exactly one positive numeric
 * UserId (never a name), and only the known flags; the real run needs --yes (without it, only the plan is printed).
 * Answers { userId, dryRun, yes } or { error }.
 */
export function parseEraseArgs(args) {
	const ids = args.filter(a => !a.startsWith("--"));
	const flags = args.filter(a => a.startsWith("--"));
	const unknown = flags.filter(f => !ERASE_FLAGS.has(f));
	if (unknown.length > 0) return { error: `opção desconhecida: ${unknown.join(" ")} (só --dry-run ou --yes)` };
	// (no Set.size here: the Luau shims of the node tests turn it into a method)
	if (flags.some((f, i) => flags.indexOf(f) !== i)) return { error: "opção repetida" };
	if (ids.length !== 1) return { error: `um UserId, e só um (veio ${ids.length})` };
	if (!/^\d{1,15}$/.test(ids[0]) || Number(ids[0]) <= 0) {
		return { error: `"${ids[0]}" não é um UserId (o número da conta, nunca o nome)` };
	}
	const dryRun = flags.includes("--dry-run");
	const yes = flags.includes("--yes");
	if (dryRun && yes) return { error: "--dry-run e --yes juntos: escolha um" };
	return { userId: Number(ids[0]), dryRun, yes };
}

/**
 * The entry id of a listing row, as the key the game wrote: the listing may name it by `id` or by `path`, and an
 * unscoped listing prefixes the scope ("global/log_..."), which is not part of the key.
 */
export function listedKey(row) {
	const fromPath =
		typeof row.path === "string" && row.path.includes("/entries/") ? row.path.split("/entries/").pop() : "";
	const raw = fromPath !== "" ? fromPath : String(row.id ?? "");
	return raw.startsWith(`${SCOPE}/`) ? raw.slice(SCOPE.length + 1) : raw;
}
