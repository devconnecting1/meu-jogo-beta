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
 *
 * THE KEY IS NEVER PRINTED. It is read from `.env` (gitignored), passed in a header, and scrubbed out of any
 * error body before anything reaches the terminal -- an API error that echoes the request would otherwise put
 * the key in a log, and a log is the easiest place in the world to leak one from.
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
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- credentials

/** reads `.env` and checks that `required` are set (each command asks only for what it uses) */
function loadEnv(required) {
	const path = join(ROOT, ".env");
	if (!existsSync(path)) {
		fail(
			"não achei o .env.\n" +
				"  copie o modelo e cole a chave lá:  cp .env.example .env\n" +
				"  (o .env é ignorado pelo git de propósito; nunca cole a chave num chat, commit ou issue)",
		);
	}
	const env = {};
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const t = line.trim();
		if (t === "" || t.startsWith("#") || !t.includes("=")) continue;
		const i = t.indexOf("=");
		env[t.slice(0, i).trim()] = t
			.slice(i + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
	}
	for (const name of required) {
		if (!env[name]) fail(`falta ${name} no .env (veja .env.example)`);
	}
	return env;
}

// filled by `useKey` before any command that talks to Roblox; a dry run never reads the key at all
let env = {};
let KEY = "";
let UNIVERSE = "";
let PLACE = "";

function useKey(required = ["ROBLOX_API_KEY", "ROBLOX_UNIVERSE_ID", "ROBLOX_PLACE_ID"]) {
	env = loadEnv(required);
	KEY = env.ROBLOX_API_KEY;
	UNIVERSE = env.ROBLOX_UNIVERSE_ID ?? "";
	PLACE = env.ROBLOX_PLACE_ID ?? "";
}

/** the one function allowed to touch the key's text: everything else prints what this returns */
function scrub(text) {
	return KEY === "" ? String(text) : String(text).split(KEY).join("<CHAVE>");
}

function fail(msg) {
	console.error("ERRO: " + scrub(msg));
	process.exit(1);
}

// ---------------------------------------------------------------- transport

async function call(url, { method = "GET", body, contentType } = {}) {
	const headers = { "x-api-key": KEY };
	if (contentType !== undefined) headers["Content-Type"] = contentType;
	const res = await fetch(url, { method, headers, body });
	const text = await res.text();
	if (!res.ok) {
		const why =
			res.status === 401
				? "a chave foi recusada (inválida, revogada ou fora do IP permitido)"
				: res.status === 403
					? "a chave não tem o escopo necessário para isto"
					: res.status === 404
						? "não encontrado (confira universe/place no .env)"
						: `HTTP ${res.status}`;
		return { ok: false, status: res.status, why, body: scrub(text).slice(0, 400) };
	}
	try {
		return { ok: true, data: JSON.parse(text) };
	} catch {
		return { ok: true, data: text };
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
	const url =
		`https://apis.roblox.com/cloud/v2/universes/${UNIVERSE}/data-stores/${store}` +
		`/entries/${encodeURIComponent(userId)}`;
	const r = await call(url);
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

// ---------------------------------------------------------------- world art (design/world-art -> Roblox)

const ART_DIR = join(ROOT, "design", "world-art");
const ASSETS_JSON = join(ART_DIR, "assets.json");
const sleep = ms => new Promise(done => setTimeout(done, ms));
const sha1 = bytes => createHash("sha1").update(bytes).digest("hex");

/**
 * Uploads the world art (tools/gen-world-art.mjs) through the Open Cloud Assets API as Image assets, owned by the
 * creator in `.env` (ROBLOX_CREATOR_USER_ID, or ROBLOX_CREATOR_GROUP_ID when the experience belongs to a group).
 * Only textures that are new or whose PNG changed since their last upload go up (assets.json keeps each one's
 * sha1). assets.json is written after EVERY upload, so an interrupted run resumes where it stopped. At the end,
 * src/client/view/worldArtAssets.ts is regenerated from it: build, and the town is textured.
 */
async function uploadArt(dryRun) {
	const manifestPath = join(ART_DIR, "manifest.json");
	if (!existsSync(manifestPath)) fail("sem design/world-art/manifest.json: rode `npm run art:world` antes");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const assets = existsSync(ASSETS_JSON) ? JSON.parse(readFileSync(ASSETS_JSON, "utf8")) : {};
	const ids = assets.ids ?? {};
	const hashes = assets.sha1 ?? {};
	const todo = [];
	for (const t of manifest.textures) {
		const bytes = readFileSync(join(ART_DIR, t.file));
		const hash = sha1(bytes);
		if (ids[t.name] && hashes[t.name] === hash) continue;
		todo.push({ t, bytes, hash });
	}
	console.log(`${manifest.textures.length} texturas; ${todo.length} a enviar (novas ou alteradas)`);
	if (dryRun) {
		for (const { t, bytes } of todo)
			console.log(`  ${t.name.padEnd(16)} ${String(bytes.length).padStart(6)} B  ${t.w}x${t.h}`);
		console.log("(dry run: nada foi enviado, nenhuma chave foi lida)");
		return;
	}
	if (todo.length === 0) {
		regenerateArtModule();
		return;
	}
	useKey(["ROBLOX_API_KEY"]);
	const creator = env.ROBLOX_CREATOR_GROUP_ID
		? { groupId: String(env.ROBLOX_CREATOR_GROUP_ID) }
		: env.ROBLOX_CREATOR_USER_ID
			? { userId: String(env.ROBLOX_CREATOR_USER_ID) }
			: undefined;
	if (creator === undefined)
		fail("falta ROBLOX_CREATOR_USER_ID (ou ROBLOX_CREATOR_GROUP_ID) no .env: de quem é o asset");
	const persist = () => {
		const out = {
			uploadedAt: new Date().toISOString().slice(0, 10),
			source: "tools/gen-world-art.mjs + npm run cloud -- upload-art (Open Cloud Assets API)",
			ids,
			sha1: hashes,
		};
		writeFileSync(ASSETS_JSON, `${JSON.stringify(out, undefined, "\t")}\n`);
	};
	let assetType = "Image";
	let failed = 0;
	for (const { t, bytes, hash } of todo) {
		let id;
		for (let attempt = 0; attempt < 4 && id === undefined; attempt++) {
			const form = new FormData();
			form.append(
				"request",
				JSON.stringify({
					assetType,
					displayName: `ProjectZ world ${t.name}`,
					description: `Project Z town art: ${t.description} (tools/gen-world-art.mjs)`,
					creationContext: { creator },
				}),
			);
			form.append("fileContent", new Blob([bytes], { type: "image/png" }), t.file);
			const r = await call("https://apis.roblox.com/assets/v1/assets", { method: "POST", body: form });
			if (!r.ok) {
				if (r.status === 429 || r.status >= 500) {
					await sleep(2000 * (attempt + 1));
					continue;
				}
				if (r.status === 400 && assetType === "Image") {
					// an older API revision only knows "Decal" for images; its id works in an ImageLabel too
					assetType = "Decal";
					continue;
				}
				fail(`${t.name}: ${r.why}\n  ${r.body ?? ""}`);
			}
			id = await waitForAsset(r.data, t.name);
		}
		if (id === undefined) {
			failed++;
			console.log(`  ${t.name.padEnd(16)} FALHOU (tente de novo: o que subiu fica salvo)`);
			continue;
		}
		ids[t.name] = `rbxassetid://${id}`;
		hashes[t.name] = hash;
		persist();
		console.log(`  ${t.name.padEnd(16)} rbxassetid://${id}`);
		// the Assets API limits uploads per minute: keep well under it
		await sleep(700);
	}
	regenerateArtModule();
	if (failed > 0) fail(`${failed} textura(s) não subiram; rode o comando de novo para enviar só elas`);
}

/** polls an upload's operation until the asset exists; returns its id, or undefined when moderation refused it */
async function waitForAsset(op, name) {
	let cur = op;
	for (let i = 0; i < 30 && !cur.done; i++) {
		await sleep(1000);
		const path = String(cur.path ?? "").replace(/^operations\//, "");
		const r = await call(`https://apis.roblox.com/assets/v1/operations/${path}`);
		if (!r.ok) fail(`${name}: operação ${path}: ${r.why}\n  ${r.body ?? ""}`);
		cur = r.data;
	}
	const res = cur.response ?? {};
	const state = res.moderationResult?.moderationState ?? "";
	if (state === "MODERATION_STATE_REJECTED") {
		console.log(`  ${name.padEnd(16)} recusado pela moderação`);
		return undefined;
	}
	return res.assetId;
}

function regenerateArtModule() {
	execFileSync(process.execPath, [join(ROOT, "tools", "gen-world-art.mjs"), "--assets"], {
		cwd: ROOT,
		stdio: "inherit",
	});
	console.log("pronto: `npm run build` e a cidade sai texturizada (sem id, cada superfície continua lisa)");
}

// ---------------------------------------------------------------- entry

const [cmd, ...rest] = process.argv.slice(2);
const commands = {
	whoami,
	stores,
	bans,
	save: () => save(rest[0]),
	publish: () => publish(rest.includes("--live")),
	"upload-art": () => uploadArt(rest.includes("--dry-run")),
};
if (!cmd || !(cmd in commands)) {
	console.log("uso: npm run cloud -- <whoami|stores|save <userId>|bans|publish [--live]|upload-art [--dry-run]>");
	process.exit(cmd ? 1 : 0);
}
if (cmd !== "upload-art") useKey();
await commands[cmd]();
