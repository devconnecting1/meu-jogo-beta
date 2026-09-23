#!/usr/bin/env node
/*
 * Exports the game's strings to the CSV that Roblox's Localization tab imports.
 *
 *   npm run locale            writes design/locale/ProjectZ.csv
 *
 * Why this exists: our text lives in src/shared/data/lang.ts, keyed by the English string itself, with a
 * Korean column inherited from the original game. Roblox's own localization system can translate the same
 * strings AUTOMATICALLY into the languages it supports, pick the right one from each player's account, and
 * let human translators correct the machine's guesses. To get there, the strings have to be in ITS table.
 *
 * The CSV shape is Roblox's: Key, Source, Context, Example, then one column per locale. We fill:
 *   Key      our stable key (so a future rename of the English text does not orphan a translation)
 *   Source   the English text, which is also the key today
 *   Context  left for a human, and it MATTERS here -- see below
 *   Example  left for a human
 *   en / ko  what we already have
 *
 * The thing to understand before enabling automatic translation: most of our strings are one or two words
 * with no sentence around them, and a machine translating "Round", "Use", "Drop" or "Melt" in isolation has
 * no way to know we mean a magazine, an item action, discarding and smelting. That is what the Context
 * column is for, and it is the difference between a translated game and an embarrassing one. Fill it for
 * every ambiguous entry before turning the switch on.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src/shared/data/lang.ts");
const OUT_DIR = join(ROOT, "design/locale");
const OUT = join(OUT_DIR, "ProjectZ.csv");

/** locales Roblox supports that we have something for; the rest are filled by automatic translation */
const COLUMNS = ["en", "ko", "zh-hans", "ja"];

const source = readFileSync(SRC, "utf8");

/**
 * Reads the LANG_TABLE entries. A parser rather than an import because this file is roblox-ts and importing
 * it here would drag the Luau shims in for four fields.
 */
function entries() {
	const out = [];
	const re = /\{\s*key:\s*"((?:[^"\\]|\\.)*)"\s*,\s*korean:\s*"((?:[^"\\]|\\.)*)"\s*,\s*chinese:\s*"((?:[^"\\]|\\.)*)"\s*,\s*japanese:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
	let m;
	while ((m = re.exec(source)) !== null) {
		const [, key, korean, chinese, japanese] = m;
		out.push({ key, en: key, ko: korean, "zh-hans": chinese, ja: japanese });
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

const filled = {};
for (const c of COLUMNS) filled[c] = rows.filter(e => (e[c] ?? "") !== "").length;

console.log(`${rows.length} textos -> ${OUT}`);
for (const c of COLUMNS) {
	const n = filled[c];
	console.log(`  ${c.padEnd(8)} ${String(n).padStart(4)} preenchidos, ${rows.length - n} para a tradução automática`);
}
console.log(
	"\nantes de ligar a tradução automática: preencha a coluna Context das entradas de uma ou duas palavras.\n" +
		'"Round" (carregador), "Use", "Drop", "Melt" e "Learn" não têm como ser traduzidos sem ela.',
);
