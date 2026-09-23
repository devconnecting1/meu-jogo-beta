#!/usr/bin/env node
/*
 * Roblox Open Cloud, for the jobs that would otherwise need somebody with Studio open.
 *
 *   npm run cloud -- whoami                 what the key can reach, and what it cannot
 *   npm run cloud -- save <userId>          read a player's live save (read-only)
 *   npm run cloud -- stores                 list the DataStores of the universe
 *   npm run cloud -- bans                   list active user restrictions
 *   npm run cloud -- publish [--live]       build with rojo and upload; --live goes to players
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
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- credentials

function loadEnv() {
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
	for (const name of ["ROBLOX_API_KEY", "ROBLOX_UNIVERSE_ID", "ROBLOX_PLACE_ID"]) {
		if (!env[name]) fail(`falta ${name} no .env (veja .env.example)`);
	}
	return env;
}

const env = loadEnv();
const KEY = env.ROBLOX_API_KEY;
const UNIVERSE = env.ROBLOX_UNIVERSE_ID;
const PLACE = env.ROBLOX_PLACE_ID;

/** the one function allowed to touch the key's text: everything else prints what this returns */
function scrub(text) {
	return String(text).split(KEY).join("<CHAVE>");
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

// ---------------------------------------------------------------- entry

const [cmd, ...rest] = process.argv.slice(2);
const commands = {
	whoami,
	stores,
	bans,
	save: () => save(rest[0]),
	publish: () => publish(rest.includes("--live")),
};
if (!cmd || !(cmd in commands)) {
	console.log("uso: npm run cloud -- <whoami|stores|save <userId>|bans|publish [--live]>");
	process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
