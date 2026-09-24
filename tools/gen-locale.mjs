#!/usr/bin/env node
/*
 * Exports the game's strings to the CSV that Roblox's localization table imports.
 *
 *   npm run locale                  writes design/locale/LastTown.csv
 *   npm run locale -- --split 100   also writes it in chunks of 100 rows
 *
 * Why this exists: our text lives in src/shared/data/lang.ts, keyed by the English string itself. Roblox can
 * translate those same strings into the 44 languages it supports, pick the right one from each player's
 * account, and let human translators correct the machine. To get there, the strings have to be in ITS table.
 *
 * THE FORMAT IS THE DOCUMENTED ONE, AND THE ORDER MATTERS. The columns are, in this order:
 *
 *     Key, Context, Example, Source
 *
 * An earlier version of this file wrote `Key, Source, Context, Example, en` and the importer refused every
 * single row with "Could not apply changes", no reason given. Two things were wrong with it:
 *
 *   - the column ORDER was invented rather than read;
 *   - it carried an `en` column. English is the SOURCE, not a translation of English into English, and the
 *     docs are explicit that you fill Source and may leave the other columns blank.
 *
 * Key and Example are left blank for a human. Context is not: most of our strings are one or two words with
 * no sentence around them, and a machine translating "Round", "Use", "Drop" or "Melt" in isolation cannot know
 * we mean a magazine, an item action, discarding and smelting. tools/locale-context.mjs is the hand-kept
 * Source -> Context map for every such string this file found; it fails the build if one of its entries is
 * no longer in LANG_TABLE (see the check below), so it cannot silently drift from what the game actually shows.
 *
 * Entries are case-sensitive on their side: "hello" and "Hello" are two different strings -- so a label drawn in
 * capitals is its own entry in lang.ts ("START"), never an entry upper-cased in code.
 *
 * THE SOURCE IS THE TEXT AS IT IS ON SCREEN. Roblox matches what a label displays against the Source column, whole
 * and exact (the Source is "the in-game source text", the same string Automatic Text Capture would collect). Our
 * multi-line entries keep "#" as the line break in lang.ts, and the screens turn it into a real one (widgets.ts `nl`)
 * before showing it -- so a Source still holding "#" never matched anything, and 24 texts could not be translated.
 * Here "#" becomes a real line break, inside a quoted cell as RFC 4180 has it (a quoted field may hold line breaks),
 * which is also how the Localization tools download a table with such an entry.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTEXT } from "./locale-context.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src/shared/data/lang.ts");
const OUT_DIR = join(ROOT, "design/locale");
const OUT = join(OUT_DIR, "LastTown.csv");

/** the documented column order; Source last is not a typo */
const HEADER = ["Key", "Context", "Example", "Source"];

const source = readFileSync(SRC, "utf8");

/**
 * Reads LANG_TABLE. A parser rather than an import because that file is roblox-ts, and importing it here
 * would drag the Luau shims in just to read a list of strings.
 */
function strings() {
	const start = source.indexOf("LANG_TABLE: Array<string> = [");
	if (start < 0) return [];
	const block = source.slice(start);
	const out = [];
	const seen = new Set();
	const re = /^\t"((?:[^"\\]|\\.)*)",$/gm;
	let m;
	while ((m = re.exec(block)) !== null) {
		// "#" is lang.ts's line break (widgets.ts `nl`): the Source is what the screen shows, with the real one
		const text = m[1].replace(/\\(.)/g, "$1").split("#").join("\n");
		if (seen.has(text)) continue;
		seen.add(text);
		out.push(text);
	}
	return out;
}

/** RFC 4180: quote anything with a comma, quote or newline, and double the quotes inside */
function cell(value) {
	const v = value ?? "";
	return /[",\n\r]/.test(v) ? '"' + v.split('"').join('""') + '"' : v;
}

const rows = strings();
if (rows.length === 0) {
	console.error("não achei nenhuma entrada em LANG_TABLE — o formato de lang.ts mudou?");
	process.exit(1);
}

/*
 * tools/locale-context.mjs is a hand-kept map, and a hand-kept map rots: a string renamed or removed in
 * lang.ts leaves a Context entry that describes something that no longer exists. Fail loudly rather than
 * silently drop it, so the fix (update or delete the entry) happens right where the rename did.
 */
const known = new Set(rows);
const stale = Object.keys(CONTEXT).filter(src => !known.has(src));
if (stale.length > 0) {
	console.error(
		`tools/locale-context.mjs tem ${stale.length} entrada(s) que não existem mais em LANG_TABLE:\n` +
			stale.map(s => `  ${JSON.stringify(s)}`).join("\n") +
			"\n\nAtualize ou remova essas entradas em tools/locale-context.mjs.",
	);
	process.exit(1);
}
const tooLong = Object.entries(CONTEXT).filter(([, ctx]) => ctx.length > 80);
if (tooLong.length > 0) {
	console.error(
		`tools/locale-context.mjs tem ${tooLong.length} Context com mais de 80 caracteres:\n` +
			tooLong.map(([s, ctx]) => `  ${JSON.stringify(s)}: ${ctx.length} chars`).join("\n"),
	);
	process.exit(1);
}

const lines = [HEADER.join(",")];
for (const text of rows) lines.push(["", cell(CONTEXT[text] ?? ""), "", cell(text)].join(","));

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
const withContext = rows.filter(text => CONTEXT[text] !== undefined).length;
console.log(`${rows.length} textos (${withContext} com Context) -> ${OUT}`);

/*
 * --split N writes the same table in chunks.
 *
 * Uploading is a merge keyed by Source, so five files of a hundred end up identical to one of 475 -- and a
 * chunk that fails is retried on its own instead of starting the whole thing over. Useful because the
 * importer has also answered `upstream request timeout` on the full table, which is a gateway error on their
 * side rather than anything about the file.
 */
const splitAt = process.argv.indexOf("--split");
if (splitAt >= 0) {
	const size = Math.max(1, Number(process.argv[splitAt + 1] ?? 100));
	const body = lines.slice(1);
	const parts = Math.ceil(body.length / size);
	for (let i = 0; i < parts; i++) {
		const chunk = [lines[0], ...body.slice(i * size, (i + 1) * size)];
		const name = join(OUT_DIR, `LastTown-${String(i + 1).padStart(2, "0")}.csv`);
		writeFileSync(name, chunk.join("\n") + "\n", "utf8");
		console.log(`  parte ${i + 1}/${parts}: ${chunk.length - 1} textos -> ${name}`);
	}
}

console.log(
	"\nachou um texto ambíguo sem Context (uma palavra comum como nome de item, ou termo próprio do jogo)?\n" +
		"adicione o par Source -> Context em tools/locale-context.mjs.",
);
