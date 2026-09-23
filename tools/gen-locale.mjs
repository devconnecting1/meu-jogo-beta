#!/usr/bin/env node
/*
 * Exports the game's strings to the CSV that Roblox's Localization tab imports.
 *
 *   npm run locale            writes design/locale/ProjectZ.csv
 *
 * Why this exists: our text lives in src/shared/data/lang.ts, keyed by the English string itself. Roblox can
 * translate those same strings automatically into every language it supports, pick the right one from each
 * player's account, and let human translators correct the machine. To get there, the strings have to be in
 * ITS table, which is what this file writes.
 *
 * ONLY the source language ships here, on purpose. The Korean that came with the original game was removed:
 * two translators for one label fight over it, and the platform has to win, because it is the one that knows
 * what language the player's account is in. Corrections live in lang.ts's OVERRIDES, per language and per
 * key, for the few strings the machine gets wrong.
 *
 * The CSV shape is Roblox's: Key, Source, Context, Example, then one column per locale.
 *
 * Context is left blank for a human to fill, and it is the part that decides whether this ends well: most of
 * our strings are one or two words with no sentence around them, and a machine translating "Round", "Use",
 * "Drop" or "Melt" in isolation cannot know we mean a magazine, an item action, discarding and smelting.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src/shared/data/lang.ts");
const OUT_DIR = join(ROOT, "design/locale");
const OUT = join(OUT_DIR, "ProjectZ.csv");

/** the source language, and nothing else: everything below it is Roblox's job */
const COLUMNS = ["en"];

const source = readFileSync(SRC, "utf8");

/**
 * Reads LANG_TABLE. A parser rather than an import because that file is roblox-ts, and importing it here
 * would drag the Luau shims in just to read a list of strings.
 */
function entries() {
	const start = source.indexOf("LANG_TABLE: Array<string> = [");
	if (start < 0) return [];
	const block = source.slice(start);
	const out = [];
	const seen = new Set();
	const re = /^\t"((?:[^"\\]|\\.)*)",$/gm;
	let m;
	while ((m = re.exec(block)) !== null) {
		const key = m[1].replace(/\\(.)/g, "$1");
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ key, en: key });
	}
	return out;
}

/** RFC 4180: quote anything with a comma, quote or newline, and double the quotes inside */
function cell(value) {
	const v = value ?? "";
	return /[",\n\r]/.test(v) ? '"' + v.split('"').join('""') + '"' : v;
}

const rows = entries();
if (rows.length === 0) {
	console.error("não achei nenhuma entrada em LANG_TABLE — o formato de lang.ts mudou?");
	process.exit(1);
}

const header = ["Key", "Source", "Context", "Example", ...COLUMNS];
const lines = [header.join(",")];
for (const e of rows) {
	lines.push([cell(e.key), cell(e.en), "", "", ...COLUMNS.map(c => cell(e[c]))].join(","));
}

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, lines.join("\n") + "\n", "utf8");

console.log(`${rows.length} textos (inglês) -> ${OUT}`);

/*
 * --split N also writes the table in chunks of N rows.
 *
 * The Localization tab's importer answers `upstream request timeout` on the whole table sometimes. That is a
 * gateway error on their side, not a format problem: ours is 27 kB, has no parameter syntax in it, and every
 * column header is one the docs list. Uploading is a merge keyed by Source, so the same table split across
 * several files ends up identical to one upload -- and a chunk that times out can be retried on its own
 * instead of starting the whole thing over.
 */
const splitAt = process.argv.indexOf("--split");
if (splitAt >= 0) {
	const size = Math.max(1, Number(process.argv[splitAt + 1] ?? 100));
	const body = lines.slice(1);
	const parts = Math.ceil(body.length / size);
	for (let i = 0; i < parts; i++) {
		const chunk = [lines[0], ...body.slice(i * size, (i + 1) * size)];
		const name = join(OUT_DIR, `ProjectZ-${String(i + 1).padStart(2, "0")}.csv`);
		writeFileSync(name, chunk.join("\n") + "\n", "utf8");
		console.log(`  parte ${i + 1}/${parts}: ${chunk.length - 1} textos -> ${name}`);
	}
}

console.log(
	"\nantes de ligar a tradução automática: preencha a coluna Context das entradas de uma ou duas palavras.\n" +
		'"Round" (carregador), "Use", "Drop", "Melt" e "Learn" não têm como ser traduzidos sem ela.',
);
