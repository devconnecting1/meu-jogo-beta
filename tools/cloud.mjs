#!/usr/bin/env node
/*
 * Roblox Open Cloud, for the jobs that would otherwise need somebody with Studio open.
 *
 *   npm run cloud -- whoami                 what the key can reach, and what it cannot
 *   npm run cloud -- save <userId>          read a player's live save (read-only)
 *   npm run cloud -- stores                 list the DataStores of the universe
 *   npm run cloud -- bans                   list active user restrictions
 *   npm run cloud -- publish [--live]       build with rojo and upload; --live goes to players
 *   npm run cloud -- upload-art [--dry-run] upload design/world-art/*.png (new or changed ones only), write their
 *                                           ids to design/world-art/assets.json and regenerate
 *                                           src/client/view/worldArtAssets.ts; --dry-run lists without a key
 *   npm run cloud -- erase <userId> [--dry-run | --yes]
 *                                           right to erasure: delete the player's key from every per-player store
 *                                           (and their _studio copies) and take their entries out of the admin log;
 *                                           prints the plan first and does it only with --yes; --dry-run reads no key;
 *                                           any other argument refuses the whole command (tools/rtbf.mjs)
 *   node tools/cloud.mjs has <command>      exit 0 when this file has that command (the CI asks before calling one)
 *
 *   --ci (any command; the CI job `assets` of .github/workflows/ci.yml): the credentials may come from the
 *   environment alone (no .env on a runner), the key is masked with `::add-mask::` before anything else is printed,
 *   problems become annotations (::error / ::warning / ::notice), a summary table goes to $GITHUB_STEP_SUMMARY, and
 *   an upload is strict: only an id that moderation APPROVED is written (one still in review waits up to
 *   PZ_MODERATION_WAIT_S, default 600 s, then stays in assets.json's `pending` for the next run -- never uploaded
 *   twice), a rejected file is never sent again while its bytes are the same, and missing secrets skip the upload
 *   with a notice instead of failing. Without --ci everything behaves as it always did on the owner's PC.
 *
 * THE KEY IS NEVER PRINTED. It is read from `.env` (gitignored) or the environment (a CI secret; `.env` wins when
 * both have it), passed in a header, and scrubbed out of any error body before anything reaches the terminal -- an
 * API error that echoes the request would otherwise put the key in a log, and a log is the easiest place in the
 * world to leak one from.
 *
 * Exit codes: 0 done (or nothing to do, or --ci with no secrets yet); 1 anything failed, was refused or rejected.
 * Transient answers (429 and 5xx, a dropped connection) are retried with exponential backoff (Retry-After honoured).
 *
 * Least privilege is the point of the `whoami` command: it probes each endpoint read-only and reports which
 * scopes the key actually carries, so we plan around what is granted instead of what we assumed.
 *
 * What Open Cloud CANNOT do, so nothing here pretends otherwise: it does not change experience settings
 * (ChatVersion, Studio access to API services, permissions) and it does not replace a playtest. Those stay in
 * Studio and the Creator Hub.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AUDIT_KEY_PREFIX,
	LEGACY_AUDIT_KEY,
	SCOPE,
	eraseAuditEntries,
	erasePlan,
	listedKey,
	parseEraseArgs,
} from "./rtbf.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://apis.roblox.com";
/**
 * A test is running this (tools/test-save.mjs sets these): then nothing may reach the real Open Cloud -- the repo's
 * `.env` on the owner's PC holds a real key. Only tools/fake-open-cloud.mjs, preloaded, may answer.
 */
const UNDER_TEST = ["PZ_CLOUD_ENV", "PZ_FAKE_CLOUD_STATE", "PZ_FAKE_ASSETS_STATE"].some(
	name => process.env[name] !== undefined,
);

// the command line: `--ci` is global (any command may get it, none sees it in its own arguments)
const ARGV = process.argv.slice(2);
const CI = ARGV.includes("--ci");
/** GitHub Actions reads workflow commands (::add-mask::, ::error::) from stdout; anywhere else they are just noise */
const IN_ACTIONS = CI && process.env.GITHUB_ACTIONS === "true";

// ---------------------------------------------------------------- CI output (only with --ci)

/** a workflow command's message: %, CR and LF escaped, as the runner expects */
const escapeData = text => String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
/** ... and a property's value (the title), where `:` and `,` are escaped too */
const escapeProperty = text => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** an annotation on the run (::error / ::warning / ::notice); without --ci nothing extra is printed */
function annotate(level, title, message) {
	if (!CI) return;
	console.log(`::${level} title=${escapeProperty(title)}::${escapeData(scrub(message))}`);
}

/** the step summary (markdown) of a --ci run: $GITHUB_STEP_SUMMARY on a runner, stdout elsewhere */
function stepSummary(markdown) {
	if (!CI) return;
	const text = scrub(markdown);
	const path = process.env.GITHUB_STEP_SUMMARY;
	if (path) appendFileSync(path, `${text}\n`);
	else console.log(text);
}

// ---------------------------------------------------------------- credentials

/** the only names read from the environment: nothing else of a runner's (or a shell's) environment leaks in */
const CREDENTIAL_NAMES = [
	"ROBLOX_API_KEY",
	"ROBLOX_ERASE_API_KEY",
	"ROBLOX_UNIVERSE_ID",
	"ROBLOX_PLACE_ID",
	"ROBLOX_CREATOR_USER_ID",
	"ROBLOX_CREATOR_GROUP_ID",
];

/** the `.env` path: PZ_CLOUD_ENV points the tests at a throwaway (or missing) file, never the owner's real one */
const envPath = () => process.env.PZ_CLOUD_ENV ?? join(ROOT, ".env");

/**
 * The credentials without judging them: `.env` when it exists, filled in by the environment (a CI secret) for any
 * name `.env` leaves empty -- so on the owner's PC, where `.env` has everything, nothing changes.
 */
function readCredentials() {
	const fromEnv = {};
	for (const name of CREDENTIAL_NAMES) {
		const v = (process.env[name] ?? "").trim();
		if (v !== "") fromEnv[name] = v;
	}
	const path = envPath();
	const fromFile = {};
	if (existsSync(path)) {
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const t = line.trim();
			if (t === "" || t.startsWith("#") || !t.includes("=")) continue;
			const i = t.indexOf("=");
			const value = t
				.slice(i + 1)
				.trim()
				.replace(/^["']|["']$/g, "");
			if (value !== "") fromFile[t.slice(0, i).trim()] = value;
		}
	}
	return { values: { ...fromEnv, ...fromFile }, hasFile: existsSync(path) };
}

/** reads `.env` (and the environment) and checks that `required` are set (each command asks only for what it uses) */
function loadEnv(required) {
	const { values, hasFile } = readCredentials();
	if (!hasFile && !required.every(name => values[name])) {
		fail(
			"não achei o .env.\n" +
				"  copie o modelo e cole a chave lá:  cp .env.example .env\n" +
				"  (o .env é ignorado pelo git de propósito; nunca cole a chave num chat, commit ou issue)\n" +
				"  na CI: os secrets do repositório (Settings → Secrets and variables → Actions), veja docs/CREATOR_HUB.md",
		);
	}
	for (const name of required) {
		if (!values[name]) fail(`falta ${name} no .env (veja .env.example)`);
	}
	return values;
}

// filled by `useKey` before any command that talks to Roblox; a dry run never reads the key at all
let env = {};
let KEY = "";
let UNIVERSE = "";
let PLACE = "";

/**
 * Reads the key and the ids. `keyName`: a command with its own, narrower key (erase: ROBLOX_ERASE_API_KEY, data
 * stores only) uses it when set, and says so when it falls back to the general ROBLOX_API_KEY.
 */
function useKey(required = ["ROBLOX_API_KEY", "ROBLOX_UNIVERSE_ID", "ROBLOX_PLACE_ID"], keyName = "ROBLOX_API_KEY") {
	env = loadEnv(required);
	KEY = env[keyName] || env.ROBLOX_API_KEY || "";
	if (KEY === "") fail(`falta ${keyName} (ou ROBLOX_API_KEY) no .env (veja .env.example)`);
	// before anything else is printed: from here on the runner shows *** wherever the key would appear (the secret
	// is masked already when it comes from `secrets.`; this also covers a key that reached us any other way)
	if (IN_ACTIONS) console.log(`::add-mask::${KEY}`);
	if (keyName !== "ROBLOX_API_KEY" && !env[keyName]) {
		console.log(`(sem ${keyName} no .env: usando ROBLOX_API_KEY; o recomendado é uma chave só para isto)`);
	}
	UNIVERSE = env.ROBLOX_UNIVERSE_ID ?? "";
	PLACE = env.ROBLOX_PLACE_ID ?? "";
}

/** the one function allowed to touch the key's text: everything else prints what this returns */
function scrub(text) {
	return KEY === "" ? String(text) : String(text).split(KEY).join("<CHAVE>");
}

function fail(msg) {
	annotate("error", "cloud.mjs", String(msg).split("\n")[0]);
	console.error("ERRO: " + scrub(msg));
	process.exit(1);
}

// ---------------------------------------------------------------- transport

const sleep = ms => new Promise(done => setTimeout(done, ms));
/** retries after a 429 / 5xx / dropped connection, and the first wait (doubled each time, capped at 30 s) */
const RETRIES = 4;
const BACKOFF_MS = UNDER_TEST ? 1 : 1000;

/** how long to wait before retry `attempt` (0-based): the server's Retry-After when it sends one, else backoff */
function backoff(attempt, retryAfter) {
	const told = Number(retryAfter);
	if (retryAfter != null && Number.isFinite(told) && told >= 0) return Math.min(told * 1000, 60_000);
	const base = Math.min(BACKOFF_MS * 2 ** attempt, 30_000);
	return base + Math.floor(Math.random() * base * 0.25);
}

/**
 * One Open Cloud request. `body` may be a function that builds a fresh body (a multipart form is rebuilt for each
 * retry). 429 and 5xx are retried with backoff (a 429 was refused, so it is always safe to send again); the result
 * never carries the key.
 */
async function call(url, { method = "GET", body, contentType } = {}) {
	if (UNDER_TEST && globalThis.__PZ_FAKE_OPEN_CLOUD !== true) {
		fail("ambiente de teste sem o Open Cloud falso (tools/fake-open-cloud.mjs): nada vai para apis.roblox.com");
	}
	const headers = { "x-api-key": KEY };
	if (contentType !== undefined) headers["Content-Type"] = contentType;
	for (let attempt = 0; ; attempt++) {
		let res;
		let text;
		try {
			res = await fetch(url, { method, headers, body: typeof body === "function" ? body() : body });
			text = await res.text();
		} catch (e) {
			if (attempt < RETRIES) {
				await sleep(backoff(attempt));
				continue;
			}
			const why = `sem resposta (${e instanceof Error ? e.message : e})`;
			return { ok: false, status: 0, why: scrub(why), body: "" };
		}
		if ((res.status === 429 || res.status >= 500) && attempt < RETRIES) {
			await sleep(backoff(attempt, res.headers.get("retry-after")));
			continue;
		}
		if (!res.ok) {
			const why =
				res.status === 401
					? "a chave foi recusada (inválida, revogada ou fora do IP permitido)"
					: res.status === 403
						? "a chave não tem o escopo necessário para isto"
						: res.status === 404
							? "não encontrado (confira universe/place no .env)"
							: res.status === 429
								? "limite de requisições (HTTP 429), mesmo depois de esperar"
								: `HTTP ${res.status}`;
			return { ok: false, status: res.status, why, body: scrub(text).slice(0, 400) };
		}
		try {
			return { ok: true, data: JSON.parse(text) };
		} catch {
			return { ok: true, data: text };
		}
	}
}

// ---------------------------------------------------------------- commands

async function whoami() {
	const probes = [
		["universo", `https://apis.roblox.com/cloud/v2/universes/${UNIVERSE}`],
		["lugar", `https://apis.roblox.com/cloud/v2/universes/${UNIVERSE}/places/${PLACE}`],
		["datastores (ler)", `https://apis.roblox.com/cloud/v2/universes/${UNIVERSE}/data-stores?maxPageSize=1`],
		["banimentos (ler)", `https://apis.roblox.com/cloud/v2/universes/${UNIVERSE}/user-restrictions`],
	];
	console.log("o que esta chave alcança (só leitura foi testada):\n");
	for (const [name, url] of probes) {
		const r = await call(url);
		console.log(`  ${name.padEnd(20)} ${r.ok ? "permitido" : r.why}`);
	}
	console.log(
		"\npublicar e escrever em DataStore não são testados aqui de propósito:\n" +
			"  uma sondagem de escrita É uma escrita. Descobrimos na primeira vez que forem usados de verdade.",
	);
}

async function stores() {
	const r = await call(`https://apis.roblox.com/cloud/v2/universes/${UNIVERSE}/data-stores?maxPageSize=50`);
	if (!r.ok) fail(`${r.why}\n  ${r.body ?? ""}`);
	const list = r.data.dataStores ?? [];
	if (list.length === 0) return console.log("nenhum DataStore ainda (ninguém salvou no lugar publicado)");
	console.log(`${list.length} DataStore(s):`);
	for (const s of list) console.log("  " + (s.path ?? "").split("/").pop());
}

async function save(userId) {
	if (!userId) fail("uso: npm run cloud -- save <userId>");
	// the save is one entry per player, keyed by userId (src/server/main.server.ts)
	const store = "ProjectZ_Save_v2";
	const r = await call(entryUrl(store, userId));
	if (!r.ok) {
		if (r.status === 404) return console.log(`sem save para ${userId} em ${store} (jogador nunca salvou aqui)`);
		fail(`${r.why}\n  ${r.body ?? ""}`);
	}
	const raw = r.data.value ?? r.data;
	const data = typeof raw === "string" ? JSON.parse(raw) : raw;
	console.log(`save de ${userId} (somente leitura):`);
	console.log(JSON.stringify(data, undefined, 2).slice(0, 4000));
}

async function bans() {
	const r = await call(`https://apis.roblox.com/cloud/v2/universes/${UNIVERSE}/user-restrictions`);
	if (!r.ok) fail(`${r.why}\n  ${r.body ?? ""}`);
	const list = r.data.userRestrictions ?? [];
	if (list.length === 0) return console.log("nenhuma restrição ativa");
	for (const u of list) console.log("  " + JSON.stringify(u));
}

async function publish(live) {
	// rojo build is what CI already does, so what goes up is exactly what CI verified
	// place properties a script cannot set (Players.BanningEnabled) ride on the build: refuse to publish without them
	execFileSync(process.execPath, [join(ROOT, "tools", "check-place.mjs")], { cwd: ROOT, stdio: "inherit" });
	const out = join(ROOT, "ProjectZ-cloud.rbxl");
	console.log("montando o lugar com o rojo...");
	execFileSync("rojo", ["build", "-o", out], { cwd: ROOT, stdio: "inherit" });
	const bytes = readFileSync(out);
	console.log(`  ${(statSync(out).size / 1024).toFixed(0)} kB`);

	const versionType = live ? "Published" : "Saved";
	console.log(`enviando como ${versionType}${live ? " (VAI PARA OS JOGADORES)" : " (fica como versão salva)"}...`);
	const r = await call(
		`https://apis.roblox.com/universes/v1/${UNIVERSE}/places/${PLACE}/versions?versionType=${versionType}`,
		{ method: "POST", body: bytes, contentType: "application/octet-stream" },
	);
	if (!r.ok) fail(`${r.why}\n  ${r.body ?? ""}`);
	console.log(`ok — versão ${r.data.versionNumber ?? "?"}`);
}

// ---------------------------------------------------------------- uploads (Open Cloud Assets API)

const ART_DIR = join(ROOT, "design", "world-art");
const ASSETS_JSON = join(ART_DIR, "assets.json");
const sha1 = bytes => createHash("sha1").update(bytes).digest("hex");
const today = () => new Date().toISOString().slice(0, 10);

/** polls of an upload's operation (one per OP_POLL_MS) before it is left `pending` for a later look */
const OP_POLLS = 30;
const OP_POLL_MS = UNDER_TEST ? 1 : 1000;
/** the Assets API allows 120 uploads and 120 asset reads per minute per key owner: keep well under both */
const UPLOAD_GAP_MS = UNDER_TEST ? 0 : 700;
const READ_GAP_MS = UNDER_TEST ? 0 : 600;
/** --ci: one round of moderation reads this often while something is still in review */
const REVIEW_ROUND_MS = UNDER_TEST ? 5 : 10_000;
/** --ci: how long to wait for moderation before leaving the rest `pending` (PZ_MODERATION_WAIT_S, default 600 s) */
function moderationWaitMs() {
	const s = Number(process.env.PZ_MODERATION_WAIT_S ?? 600);
	return Number.isFinite(s) && s >= 0 ? s * 1000 : 600_000;
}

/**
 * An asset's `moderationResult` -> "approved" | "rejected" | "reviewing", or "" when the answer carries none. The
 * reference describes the state as `Reviewing` / `Rejected` / `Approved`; the API answers `MODERATION_STATE_...`
 * (what this file always read): both forms are accepted, and anything else counts as still in review.
 */
function moderationOf(result) {
	const s = String(result?.moderationState ?? "")
		.trim()
		.toUpperCase()
		.replace(/^MODERATION_STATE_/, "");
	if (s === "") return "";
	return s === "APPROVED" ? "approved" : s === "REJECTED" ? "rejected" : "reviewing";
}

/** an operation's id from its `path` ("operations/{id}") */
const operationId = op => String(op?.path ?? "").replace(/^operations\//, "");

/** what a finished (or not) operation says: { state: "done" | "running" | "error", assetId, moderation, why } */
function fromOperation(op) {
	if (!op?.done) {
		const operation = operationId(op);
		return operation === "" ? { state: "error", why: "resposta sem operação" } : { state: "running", operation };
	}
	if (op.error && (op.error.code || op.error.message)) {
		return { state: "error", why: `a operação falhou: ${op.error.message ?? op.error.code}` };
	}
	const res = op.response ?? {};
	if (res.assetId === undefined || res.assetId === null) return { state: "error", why: "operação sem assetId" };
	return {
		state: "done",
		assetId: String(res.assetId),
		moderation: moderationOf(res.moderationResult),
		revisionId: res.revisionId,
	};
}

/** assets.json: `ids` + `sha1` (what the game uses), `pending` (uploaded, not approved yet) and `rejected` */
function readBook(path) {
	const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
	return {
		ids: { ...(raw.ids ?? {}) },
		sha1: { ...(raw.sha1 ?? {}) },
		pending: { ...(raw.pending ?? {}) },
		rejected: { ...(raw.rejected ?? {}) },
	};
}

function writeBook(path, book, source) {
	const out = { uploadedAt: today(), source, ids: book.ids, sha1: book.sha1 };
	if (Object.keys(book.pending).length > 0) out.pending = book.pending;
	if (Object.keys(book.rejected).length > 0) out.rejected = book.rejected;
	writeFileSync(path, `${JSON.stringify(out, undefined, "\t")}\n`);
}

/** a markdown table cell */
const cell = text => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");

/**
 * The upload core of every `upload-*` command: sends the items that are new or changed (by sha1) through the Open
 * Cloud Assets API as `spec.assetType`, owned by ROBLOX_CREATOR_USER_ID (or ROBLOX_CREATOR_GROUP_ID when the
 * experience belongs to a group), records each result in `spec.assetsPath` as soon as it is known (an interrupted
 * run resumes where it stopped) and calls `spec.regenerate()` at the end. Returns the exit code.
 *
 *   spec.items   [{ name, file, bytes, hash, size, description }] -- everything the game may use
 *   spec.mime    the files' content type; spec.fallbackAssetType is tried once if the API answers 400 to assetType
 *
 * Moderation. Locally (as it always was) an id is written unless moderation REJECTED it. With --ci only an APPROVED
 * id is written: one still in review goes to `pending` (with its id, or its operation while that has not finished)
 * and is looked at again -- never uploaded again -- until it is approved or rejected. A rejected file goes to
 * `rejected` with its sha1, and --ci never sends those same bytes again (each rejection counts against the account;
 * the owner's own run still may, as before). Changing the file clears both.
 */
async function uploadAssets(spec, dryRun) {
	const book = readBook(spec.assetsPath);
	let dirty = false;
	// what the book says about a file that changed or left the list no longer applies: new bytes are a new upload
	const current = new Map(spec.items.map(it => [it.name, it.hash]));
	for (const list of [book.pending, book.rejected]) {
		for (const name of Object.keys(list)) {
			const live = book.ids[name] !== undefined && book.sha1[name] === current.get(name);
			if (current.get(name) !== list[name]?.sha1 || live) {
				delete list[name];
				dirty = true;
			}
		}
	}
	const upload = [];
	const recheck = [];
	const blocked = [];
	for (const it of spec.items) {
		if (book.ids[it.name] && book.sha1[it.name] === it.hash) continue;
		if (book.pending[it.name] !== undefined) recheck.push(it);
		else if (book.rejected[it.name] !== undefined && CI) blocked.push(it);
		else upload.push(it);
	}
	const extra = [
		recheck.length > 0 ? `; ${recheck.length} em análise na moderação (só consultadas)` : "",
		blocked.length > 0 ? `; ${blocked.length} recusada(s) antes com os mesmos bytes (não reenviadas)` : "",
	].join("");
	console.log(`${spec.items.length} ${spec.noun}; ${upload.length} a enviar (novas ou alteradas)${extra}`);
	if (dryRun) {
		for (const it of upload) {
			console.log(`  ${it.name.padEnd(16)} ${String(it.bytes.length).padStart(6)} B  ${it.size}`);
		}
		for (const it of recheck) console.log(`  ${it.name.padEnd(16)} em análise: será consultado, não reenviado`);
		for (const it of blocked) console.log(`  ${it.name.padEnd(16)} RECUSADO antes: mude o arquivo`);
		console.log("(dry run: nada foi enviado, nenhuma chave foi lida)");
		return 0;
	}
	const rows = new Map();
	const table = footer => {
		const lines = [`### ${spec.title}`, ""];
		if (rows.size > 0) {
			lines.push(`| ${spec.nounOne} | resultado | asset |`, "| --- | --- | --- |");
			for (const [name, [result, id]] of rows) lines.push(`| ${cell(name)} | ${cell(result)} | ${cell(id)} |`);
			lines.push("");
		}
		lines.push(footer, "");
		return lines.join("\n");
	};
	if (upload.length + recheck.length + blocked.length === 0) {
		if (dirty) writeBook(spec.assetsPath, book, spec.source);
		spec.regenerate();
		stepSummary(table(`${spec.items.length} ${spec.noun}, todas no ar: nada a enviar.`));
		return 0;
	}

	// --ci before the owner set the secrets up: say so and let the CI go on (without an id each one stays as before)
	const { values } = readCredentials();
	if (CI) {
		const missing = [];
		if (!values.ROBLOX_API_KEY) missing.push("ROBLOX_API_KEY");
		if (!values.ROBLOX_CREATOR_USER_ID && !values.ROBLOX_CREATOR_GROUP_ID) {
			missing.push("ROBLOX_CREATOR_USER_ID (ou ROBLOX_CREATOR_GROUP_ID)");
		}
		if (missing.length > 0) {
			const msg =
				`sem ${missing.join(" e ")} nos secrets do repositório: ${upload.length + recheck.length} ` +
				`${spec.noun} esperam o upload e nada foi enviado. A CI segue (sem id, cada uma fica como antes); ` +
				"a configuração única está em docs/CREATOR_HUB.md (Open Cloud na CI).";
			console.log(msg);
			annotate("notice", `${spec.title}: upload pulado`, msg);
			for (const it of [...upload, ...recheck]) rows.set(it.name, ["esperando os secrets", ""]);
			stepSummary(table(`**Upload pulado:** ${msg}`));
			return 0;
		}
	}
	useKey(["ROBLOX_API_KEY"]);
	const group = String(env.ROBLOX_CREATOR_GROUP_ID ?? "");
	const user = String(env.ROBLOX_CREATOR_USER_ID ?? "");
	const creator = group !== "" ? { groupId: group } : user !== "" ? { userId: user } : undefined;
	if (creator === undefined)
		fail("falta ROBLOX_CREATOR_USER_ID (ou ROBLOX_CREATOR_GROUP_ID) no .env: de quem é o asset");
	if (!/^\d+$/.test(group || user))
		fail("ROBLOX_CREATOR_USER_ID / ROBLOX_CREATOR_GROUP_ID é o número do id, só dígitos");

	const persist = () => {
		writeBook(spec.assetsPath, book, spec.source);
		dirty = false;
	};
	const count = { approved: 0, accepted: 0, pending: 0, rejected: 0, failed: 0 };

	/** the moderation of an asset that exists: the asset's own answer, or its version's when the asset omits it */
	const readModeration = async (id, revisionId) => {
		const r = await call(`${API}/assets/v1/assets/${encodeURIComponent(id)}`);
		if (!r.ok && r.status === 404) return { gone: true, moderation: "" };
		if (r.ok) {
			const m = moderationOf(r.data?.moderationResult);
			if (m !== "") return { moderation: m };
			revisionId = r.data?.revisionId ?? revisionId;
		}
		const v = await call(
			`${API}/assets/v1/assets/${encodeURIComponent(id)}/versions/${encodeURIComponent(revisionId ?? "1")}`,
		);
		return { moderation: v.ok ? moderationOf(v.data?.moderationResult) : "" };
	};

	/** one more look at something in `pending`: its operation while it has no id, then the asset's moderation */
	const lookAgain = async p => {
		if (!p.id) {
			if (!p.operation) return { state: "error", why: "pendente sem operação nem id" };
			const r = await call(`${API}/assets/v1/operations/${encodeURIComponent(p.operation)}`);
			if (!r.ok) {
				return r.status === 404
					? { state: "error", why: `a operação ${p.operation} não existe mais` }
					: { state: "running", operation: p.operation };
			}
			const got = fromOperation(r.data);
			if (got.state !== "done" || got.moderation !== "" || !CI) return got;
			return { ...got, ...(await readModeration(got.assetId, got.revisionId)) };
		}
		const m = await readModeration(p.id);
		return m.gone
			? { state: "error", why: `o asset ${p.id} não existe mais` }
			: { state: "done", assetId: p.id, ...m };
	};

	/** what one answer means for the book (written at once); "pending" when it is still to be decided */
	const resolve = (it, got, fresh) => {
		const name = it.name;
		const label = name.padEnd(16);
		if (got.state === "error") {
			delete book.pending[name];
			count.failed++;
			rows.set(name, [`FALHOU: ${got.why}`, ""]);
			console.log(`  ${label} FALHOU: ${got.why} (tente de novo: o que subiu fica salvo)`);
			persist();
			return "done";
		}
		if (got.state === "running") {
			book.pending[name] = {
				sha1: it.hash,
				operation: got.operation,
				since: book.pending[name]?.since ?? today(),
			};
			rows.set(name, ["processando: fica para o próximo run (não será reenviado)", `operação ${got.operation}`]);
			persist();
			return "pending";
		}
		const id = got.assetId;
		if (got.moderation === "rejected") {
			delete book.pending[name];
			book.rejected[name] = { sha1: it.hash, id, at: today() };
			count.rejected++;
			rows.set(name, ["RECUSADO pela moderação: o id não entra; mude o arquivo", id]);
			console.log(`  ${label} recusado pela moderação (asset ${id})`);
			annotate(
				"error",
				`${spec.title}: ${name} recusado`,
				`a moderação do Roblox recusou ${name} (asset ${id}): o id não foi gravado e a CI não reenvia estes ` +
					"mesmos bytes. Mude o arquivo e faça push.",
			);
			persist();
			return "done";
		}
		if (got.moderation === "approved" || !CI) {
			book.ids[name] = `rbxassetid://${id}`;
			book.sha1[name] = it.hash;
			delete book.pending[name];
			delete book.rejected[name];
			if (got.moderation === "approved") count.approved++;
			else count.accepted++;
			const result =
				got.moderation !== "approved"
					? "gravado (ainda em análise na moderação)"
					: fresh
						? "aprovado (enviado agora)"
						: "aprovado (estava em análise)";
			rows.set(name, [result, `rbxassetid://${id}`]);
			console.log(`  ${label} rbxassetid://${id}${got.moderation !== "approved" ? " (em análise)" : ""}`);
			persist();
			return "done";
		}
		book.pending[name] = { sha1: it.hash, id, since: book.pending[name]?.since ?? today() };
		rows.set(name, ["em análise: fica para o próximo run (não será reenviado)", id]);
		persist();
		return "pending";
	};

	// 1) the uploads
	let assetType = spec.assetType;
	const waiting = [...recheck];
	for (const it of upload) {
		let created;
		for (;;) {
			const r = await call(`${API}/assets/v1/assets`, {
				method: "POST",
				body: () => {
					const form = new FormData();
					form.append(
						"request",
						JSON.stringify({
							assetType,
							displayName: spec.displayName(it),
							description: spec.description(it),
							creationContext: { creator },
						}),
					);
					form.append("fileContent", new Blob([it.bytes], { type: spec.mime }), it.file);
					return form;
				},
			});
			if (r.ok) {
				created = r.data;
				break;
			}
			if (r.status === 400 && spec.fallbackAssetType !== undefined && assetType !== spec.fallbackAssetType) {
				// an older API revision only knows "Decal" for images; its id works in an ImageLabel too
				assetType = spec.fallbackAssetType;
				continue;
			}
			if (r.status === 401 || r.status === 403) {
				// the key itself: every other upload would fail the same way
				persist();
				spec.regenerate();
				fail(`${it.name}: ${r.why}\n  ${r.body ?? ""}`);
			}
			resolve(it, { state: "error", why: `${r.why}${r.body ? ` (${r.body.slice(0, 160)})` : ""}` }, true);
			break;
		}
		if (created !== undefined) {
			let cur = created;
			for (let i = 0; i < OP_POLLS && !cur.done && operationId(cur) !== ""; i++) {
				await sleep(OP_POLL_MS);
				const r = await call(`${API}/assets/v1/operations/${encodeURIComponent(operationId(cur))}`);
				if (!r.ok) break;
				cur = r.data;
			}
			let got = fromOperation(cur);
			// strict: an answer without a moderation result is asked again (the asset, then its version)
			if (got.state === "done" && got.moderation === "" && CI) {
				got = { ...got, ...(await readModeration(got.assetId, got.revisionId)) };
			}
			if (resolve(it, got, true) === "pending") waiting.push(it);
		}
		await sleep(UPLOAD_GAP_MS);
	}

	// 2) moderation: --ci looks again every REVIEW_ROUND_MS until each one is decided or the wait is over; locally
	// one look (an id that exists is taken, as it always was)
	const deadline = Date.now() + (CI ? moderationWaitMs() : 0);
	let open = waiting;
	for (let round = 0; open.length > 0; round++) {
		if (round > 0) {
			if (Date.now() + REVIEW_ROUND_MS > deadline) break;
			console.log(`  moderação: ${open.length} ainda em análise; nova consulta em ${REVIEW_ROUND_MS / 1000} s`);
			await sleep(REVIEW_ROUND_MS);
		}
		const still = [];
		for (const it of open) {
			if (resolve(it, await lookAgain(book.pending[it.name]), false) === "pending") still.push(it);
			await sleep(READ_GAP_MS);
		}
		open = still;
	}
	count.pending = open.length;
	for (const it of open) console.log(`  ${it.name.padEnd(16)} ainda em análise: fica para o próximo run`);
	for (const it of blocked) {
		const r = book.rejected[it.name];
		rows.set(it.name, ["RECUSADO antes com estes mesmos bytes: mude o arquivo (não reenviado)", r?.id ?? ""]);
		console.log(`  ${it.name.padEnd(16)} recusado antes com estes bytes: mude o arquivo`);
		annotate(
			"error",
			`${spec.title}: ${it.name} recusado`,
			`${it.name} foi recusado pela moderação (asset ${r?.id ?? "?"}, em ${r?.at ?? "?"}) e o arquivo não ` +
				"mudou desde então: a CI não o reenvia. Mude o arquivo e faça push.",
		);
	}

	if (dirty) persist();
	spec.regenerate();

	const up = spec.items.length - upload.length - recheck.length - blocked.length;
	const parts = [
		`${up} já no ar`,
		count.approved > 0 ? `${count.approved} aprovada(s) agora` : "",
		count.accepted > 0 ? `${count.accepted} gravada(s) ainda em análise` : "",
		count.pending > 0 ? `${count.pending} em análise (próximo run)` : "",
		count.rejected + blocked.length > 0 ? `${count.rejected + blocked.length} recusada(s)` : "",
		count.failed > 0 ? `${count.failed} falharam` : "",
	].filter(Boolean);
	stepSummary(table(`${spec.items.length} ${spec.noun}: ${parts.join(" · ")}.`));
	if (count.pending > 0 && CI) {
		annotate(
			"warning",
			`${spec.title}: em análise`,
			`${count.pending} ${spec.noun} ainda em análise na moderação depois da espera: ficam sem id neste place ` +
				"(como antes) e entram no próximo run, sem novo upload.",
		);
	}
	// locally an operation that never finished is a failure too: `exit 0` there has always meant "every id written"
	const bad = count.failed + count.rejected + blocked.length + (CI ? 0 : count.pending);
	if (bad > 0) {
		console.error(
			`ERRO: ${bad} ${spec.noun} não subiram ou foram recusadas; rode o comando de novo para enviar só as que faltam` +
				(count.rejected + blocked.length > 0 ? " (as recusadas precisam de um arquivo novo)" : ""),
		);
		return 1;
	}
	return 0;
}

/**
 * Uploads the world art (tools/gen-world-art.mjs) as Image assets. Only textures that are new or whose PNG changed
 * since their last upload go up (assets.json keeps each one's sha1). At the end src/client/view/worldArtAssets.ts is
 * regenerated from assets.json: build, and the town is textured.
 */
async function uploadArt(dryRun) {
	const manifestPath = join(ART_DIR, "manifest.json");
	if (!existsSync(manifestPath)) fail("sem design/world-art/manifest.json: rode `npm run art:world` antes");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const items = manifest.textures.map(t => {
		// only design/world-art/<name>.png: a manifest can never make this read (and upload) any other file
		if (!/^\w+$/.test(String(t.name)) || !/^[\w-]+\.png$/.test(String(t.file))) {
			fail(`manifest.json: textura inválida (${JSON.stringify(t.name)} / ${JSON.stringify(t.file)})`);
		}
		const bytes = readFileSync(join(ART_DIR, t.file));
		return {
			name: t.name,
			file: t.file,
			bytes,
			hash: sha1(bytes),
			size: `${t.w}x${t.h}`,
			description: t.description,
		};
	});
	return uploadAssets(
		{
			title: "Arte da cidade (upload-art)",
			noun: "texturas",
			nounOne: "textura",
			assetsPath: ASSETS_JSON,
			source: "tools/gen-world-art.mjs + npm run cloud -- upload-art (Open Cloud Assets API)",
			items,
			assetType: "Image",
			fallbackAssetType: "Decal",
			mime: "image/png",
			displayName: it => `ProjectZ world ${it.name}`,
			description: it => `Project Z town art: ${it.description} (tools/gen-world-art.mjs)`,
			regenerate: regenerateArtModule,
		},
		dryRun,
	);
}

function regenerateArtModule() {
	execFileSync(process.execPath, [join(ROOT, "tools", "gen-world-art.mjs"), "--assets"], {
		cwd: ROOT,
		stdio: "inherit",
	});
	console.log("pronto: `npm run build` e a cidade sai texturizada (sem id, cada superfície continua lisa)");
}

// ---------------------------------------------------------------- right to erasure

/**
 * An entry of `store` in the default scope, by its key. Always the SCOPED path (`/scopes/global/entries/<key>`), the
 * same one the listing uses: one path shape for read, update and delete, so no call can land on a different
 * resource than the one listed (tools/fake-open-cloud.mjs refuses the unscoped form).
 */
const entryUrl = (store, key) =>
	`${API}/cloud/v2/universes/${UNIVERSE}/data-stores/${encodeURIComponent(store)}` +
	`/scopes/${SCOPE}/entries/${encodeURIComponent(key)}`;

/** listing pages read at most (256 keys each); past that the listing is refused, never silently cut */
const MAX_LIST_PAGES = 200;

/** every key of `store` starting with `prefix` (the default scope); the prefix is matched here, not by the API */
async function listKeys(store, prefix) {
	const keys = [];
	let token = "";
	for (let page = 0; ; page++) {
		if (page >= MAX_LIST_PAGES) {
			throw new Error(`${store}: mais de ${MAX_LIST_PAGES} páginas de chaves; a listagem foi interrompida`);
		}
		const url =
			`${API}/cloud/v2/universes/${UNIVERSE}/data-stores/${encodeURIComponent(store)}` +
			`/scopes/${SCOPE}/entries?maxPageSize=256${token !== "" ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
		const r = await call(url);
		if (!r.ok) {
			if (r.status === 404) return keys;
			throw new Error(`${store}: listar chaves: ${r.why}\n  ${r.body ?? ""}`);
		}
		for (const row of r.data.dataStoreEntries ?? []) {
			const key = listedKey(row);
			if (key.startsWith(prefix)) keys.push(key);
		}
		token = r.data.nextPageToken ?? "";
		if (token === "") return keys;
	}
}

/** one admin log document without `userId`'s entries; written back only when something was removed */
async function scrubAuditKey(store, key, userId) {
	for (let attempt = 0; attempt < 3; attempt++) {
		const r = await call(entryUrl(store, key));
		if (!r.ok) {
			if (r.status === 404) return 0;
			throw new Error(`${store}/${key}: ler: ${r.why}\n  ${r.body ?? ""}`);
		}
		const raw = r.data.value;
		const doc = typeof raw === "string" ? JSON.parse(raw) : raw;
		const [kept, removed] = eraseAuditEntries(doc, userId);
		if (removed === 0) return 0;
		// the whole value (partial updates do not exist; what stays is in the stored shape, with no name or typed
		// text), and the etag, so a server that wrote meanwhile is not overwritten
		const body = JSON.stringify({
			value: kept,
			etag: r.data.etag,
			users: r.data.users,
			attributes: r.data.attributes,
		});
		const w = await call(entryUrl(store, key), { method: "PATCH", body, contentType: "application/json" });
		if (w.ok) return removed;
		if (w.status !== 409 && w.status !== 412 && !(w.status === 400 && /etag/i.test(w.body ?? ""))) {
			throw new Error(`${store}/${key}: gravar: ${w.why}\n  ${w.body ?? ""}`);
		}
		// a server appended to this key between the read and the write: read it again
	}
	throw new Error(`${store}/${key}: a chave mudou 3 vezes seguidas durante a limpeza; rode de novo`);
}

const ERASE_USAGE = "uso: npm run cloud -- erase <userId> [--dry-run | --yes]   (o UserId numérico, nunca o nome)";

async function erase(args) {
	const parsed = parseEraseArgs(args);
	if (parsed.error !== undefined) fail(`${parsed.error}\n${ERASE_USAGE}\nnada foi feito.`);
	const uid = parsed.userId;
	console.log(`apagar os dados do jogador ${uid} (pedido de exclusão / RTBF):`);
	for (const s of erasePlan(uid)) {
		console.log(
			s.kind === "delete"
				? `  apagar a chave ${s.key} de ${s.store}`
				: `  tirar as entradas do ${uid} do log de admin ${s.store} (${s.keys})`,
		);
	}
	console.log(
		"\nANTES: o jogador tem de estar FORA do jogo. Se estiver online, kick pelo painel de admin (ou ban, se ele não\n" +
			"deve voltar) e espere 1 minuto: ao sair, o servidor dele ainda grava o registro de títulos, o save e o log\n" +
			"de admin -- rodar antes disso recria as chaves que este comando apaga.",
	);
	if (parsed.dryRun) {
		console.log("(dry run: nada foi apagado, nenhuma chave foi lida)");
		return;
	}
	if (!parsed.yes)
		fail("isto APAGA dados de verdade: confira o plano acima e rode de novo com --yes. Nada foi feito.");
	// a key for this job only (data stores: read, list, update, delete entries), apart from publish / upload-art
	useKey(["ROBLOX_UNIVERSE_ID"], "ROBLOX_ERASE_API_KEY");
	let failed = 0;
	let existed = 0;
	for (const s of erasePlan(uid)) {
		if (s.kind === "delete") {
			const r = await call(entryUrl(s.store, s.key), { method: "DELETE" });
			if (r.ok) {
				existed++;
				console.log(`  ok     ${s.store}/${s.key} apagada`);
			} else if (r.status === 404) {
				console.log(`  ok     ${s.store}/${s.key} não existia`);
			} else {
				failed++;
				console.log(`  FALHOU ${s.store}/${s.key}: ${r.why}\n  ${r.body ?? ""}`);
			}
			continue;
		}
		// the admin log key by key: one that fails is reported and the others are still cleaned
		let keys;
		try {
			keys = [LEGACY_AUDIT_KEY, ...(await listKeys(s.store, AUDIT_KEY_PREFIX))];
		} catch (e) {
			failed++;
			console.log(`  FALHOU ${scrub(e instanceof Error ? e.message : e)}`);
			continue;
		}
		let removed = 0;
		for (const key of keys) {
			try {
				removed += await scrubAuditKey(s.store, key, uid);
			} catch (e) {
				failed++;
				console.log(`  FALHOU ${scrub(e instanceof Error ? e.message : e)}`);
			}
		}
		console.log(`  ok     ${s.store}: ${removed} entrada(s) removida(s) em ${keys.length} chave(s)`);
	}
	console.log(
		"\no Roblox guarda versões antigas de uma chave por até 30 dias e só então as remove de vez; é o mesmo prazo\n" +
			"das exclusões pelos modelos de RTBF do Creator Hub (docs/CREATOR_HUB.md).",
	);
	if (failed > 0) fail(`${failed} passo(s) falharam; rode de novo (o que já foi apagado continua apagado)`);
	if (existed === 0) {
		fail(
			`nenhuma das seis chaves de ${uid} existia: confira o UserId e ROBLOX_UNIVERSE_ID (ou os modelos de RTBF já\n` +
				"  apagaram tudo). O log de admin foi limpo mesmo assim.",
		);
	}
}

// ---------------------------------------------------------------- entry

const [cmd, ...rest] = ARGV.filter(a => a !== "--ci");
const commands = {
	whoami,
	stores,
	bans,
	save: () => save(rest[0]),
	publish: () => publish(rest.includes("--live")),
	"upload-art": () => uploadArt(rest.includes("--dry-run")),
	erase: () => erase(rest),
};
// the CI asks before calling a command another branch may still be adding (upload-audio): no key, no output
if (cmd === "has") process.exit(rest.length === 1 && Object.hasOwn(commands, rest[0]) ? 0 : 1);
if (!cmd || !Object.hasOwn(commands, cmd)) {
	console.log(
		"uso: npm run cloud -- <whoami|stores|save <userId>|bans|publish [--live]|upload-art [--dry-run]|" +
			"erase <userId> [--dry-run | --yes]> [--ci]",
	);
	process.exit(cmd ? 1 : 0);
}
// upload-art and erase ask for their own key (a dry run of either reads none)
if (cmd !== "upload-art" && cmd !== "erase") useKey();
let code;
try {
	code = await commands[cmd]();
} catch (e) {
	// never a raw stack: the message goes through scrub like everything else
	fail(e instanceof Error ? e.message : String(e));
}
process.exit(typeof code === "number" ? code : 0);
