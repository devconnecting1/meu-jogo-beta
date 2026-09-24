/*
 * Luau register budget: a module chunk may hold at most 200 locals.
 *
 * This limit is invisible to every other check we run. `rbxtsc` compiles fine (TypeScript has no such
 * rule), `eslint` sees nothing, and the node tests run the same logic under V8, which has no limit either.
 * Luau only refuses when it LOADS the module -- so the first thing that tells you is the client failing to
 * boot, with every `require` above it failing too. That is exactly how it happened once:
 *
 *   zombieAI:2129: Out of local registers when trying to allocate seedHunt: exceeded limit 200
 *
 * The count is dominated by imports, because roblox-ts emits ONE local per named binding (plus one for the
 * module itself). A file that imports 24 names from four modules spends 28 registers before writing a line
 * of code. `import * as X from "..."` costs one, and is the usual fix.
 *
 * This file is a fast, offline TEXT HEURISTIC (`tools/localsHeuristic.mjs`) -- it does not run the real
 * Luau compiler and can be wrong in both directions; see that file's header for the two known gaps.
 * `tools/check-luau.mjs` runs the actual pinned compiler (`tools/luauRelease.mjs`) over every file and is
 * the source of truth. When that compiler is already cached on disk (because `check:luau` ran earlier, as
 * it does in CI), this script uses it instead of the heuristic for the files close to the limit, so its
 * numbers agree with the real one; otherwise it falls back to the heuristic alone.
 *
 * Usage: node tools/check-registers.mjs  (after `npm run build`)
 */
import fs from "node:fs";
import path from "node:path";
import { estimateChunkLocals } from "./localsHeuristic.mjs";
import { cachedLuauCompile } from "./luauRelease.mjs";
import { realHeadroom } from "./realRegisters.mjs";

/** Luau's hard limit; loading a module with more locals in one chunk throws */
const LIMIT = 200;
/** fail here, leaving room to land a change without a surprise */
const FAIL = 190;
/** print a heads-up here, so a file is flagged while the fix is still cheap */
const WARN = 170;
/** how many of the heaviest files (by the heuristic) get checked against the real compiler, when it's cached */
const REAL_CHECK_CANDIDATES = 15;

const OUT = "out";

function luauFiles(dir) {
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...luauFiles(p));
		else if (entry.name.endsWith(".luau")) found.push(p);
	}
	return found;
}

if (!fs.existsSync(OUT)) {
	console.error(`${OUT}/ nao existe: rode "npm run build" antes.`);
	process.exit(1);
}

const rows = luauFiles(OUT)
	.map(file => ({ file, locals: estimateChunkLocals(fs.readFileSync(file, "utf8")), real: false }))
	.sort((a, b) => b.locals - a.locals);

const luauCompilePath = cachedLuauCompile();
let realChecked = 0;
if (luauCompilePath) {
	for (const row of rows.slice(0, REAL_CHECK_CANDIDATES)) {
		const free = realHeadroom(luauCompilePath, fs.readFileSync(row.file, "utf8"), { limit: LIMIT });
		if (free === null) continue; // the file doesn't compile at all -- not this script's job; check:luau reports it
		row.locals = LIMIT - free;
		row.real = true;
		realChecked += 1;
	}
	rows.sort((a, b) => b.locals - a.locals);
}

const failed = rows.filter(r => r.locals > FAIL);
const warned = rows.filter(r => r.locals > WARN && r.locals <= FAIL);

for (const r of warned) {
	console.log(`aviso  ${String(r.locals).padStart(3)}/${LIMIT}${r.real ? " (real)" : ""}  ${r.file}`);
}
for (const r of failed) {
	console.error(`ERRO   ${String(r.locals).padStart(3)}/${LIMIT}${r.real ? " (real)" : ""}  ${r.file}`);
}

if (failed.length > 0) {
	console.error(
		`\n${failed.length} modulo(s) acima de ${FAIL} locais no chunk. O Luau recusa a partir de ${LIMIT} e o\n` +
			`cliente nao inicia. Troque os imports nomeados mais pesados por 'import * as X from "..."'\n` +
			`(um local em vez de um por nome), ou mova parte do arquivo para outro modulo.`,
	);
	process.exit(1);
}

const top = rows[0];
const realNote = luauCompilePath
	? ` (${realChecked} dos mais pesados conferidos no compilador real; rode "npm run check:luau" para o resto)`
	: ` (heuristica de texto; rode "npm run check:luau" para o numero real)`;
console.log(
	`OK: ${rows.length} modulos, pior caso ${top.locals}/${LIMIT}${top.real ? " (real)" : ""} em ${top.file}${realNote}`,
);
