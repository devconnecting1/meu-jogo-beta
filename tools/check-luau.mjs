/*
 * Real Luau compile-time check: runs every `out/**\/*.luau` through the pinned, official `luau-compile`
 * (see `tools/luauRelease.mjs`), the one thing that knows Luau's actual load-time limits -- at most 200
 * active locals per chunk, 255 registers, a bounded constant table, and whatever else the real compiler
 * enforces that a text heuristic cannot. `tools/check-registers.mjs`'s heuristic only models the locals
 * limit, and only approximately (audit: scripting F7); this is the ground truth.
 *
 * Usage: node tools/check-luau.mjs  (after `npm run build`)
 */
import fs from "node:fs";
import path from "node:path";
import { estimateChunkLocals } from "./localsHeuristic.mjs";
import { LUAU_VERSION, ensureLuauCompile, unsupportedPlatformMessage } from "./luauRelease.mjs";
import { compileNull, parseCompileErrors, realHeadroom } from "./realRegisters.mjs";

const OUT = "out";
const LIMIT = 200;
/** below this many free locals, a file is one refactor away from failing to load */
const WARN_FREE = 15;
/** how many of the heaviest files (by the heuristic) get a real padding-probe headroom number */
const HEADROOM_CANDIDATES = 10;

function luauFiles(dir) {
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...luauFiles(p));
		else if (entry.name.endsWith(".luau")) found.push(p);
	}
	return found;
}

async function main() {
	if (!fs.existsSync(OUT)) {
		console.error(`${OUT}/ nao existe: rode "npm run build" antes.`);
		process.exit(1);
	}
	const files = luauFiles(OUT);
	if (files.length === 0) {
		console.error(`nenhum arquivo .luau em ${OUT}/.`);
		process.exit(1);
	}

	let luauCompilePath;
	try {
		luauCompilePath = await ensureLuauCompile({ log: msg => console.log(msg) });
	} catch (err) {
		console.error(err.message ?? String(err));
		process.exit(1);
		return;
	}
	if (!luauCompilePath) {
		console.log(`check:luau: ${unsupportedPlatformMessage()}`);
		process.exit(0);
		return;
	}

	const result = compileNull(luauCompilePath, files);
	if (result.error) {
		console.error(
			`check:luau: nao foi possivel executar o luau-compile em ${luauCompilePath}: ${result.error.message}`,
		);
		process.exit(1);
	}
	if (!result.ok) {
		const byFile = parseCompileErrors(result.stderr);
		if (byFile.size === 0) {
			// the compiler failed but didn't print the "file(line,col): Error: msg" shape we parse -- show it raw
			console.error("check:luau: luau-compile falhou:");
			console.error(result.stderr || result.stdout);
		} else {
			for (const [file, errors] of byFile) {
				for (const e of errors) {
					console.error(`ERRO  ${file}(${e.line},${e.col}): ${e.kind}: ${e.message}`);
				}
			}
			console.error(
				`\n${byFile.size} arquivo(s) que o Luau ${LUAU_VERSION} recusa carregar. O tsc e os testes em Node nao veem isso -- ` +
					`corrija pelo arquivo e linha acima.`,
			);
		}
		process.exit(1);
	}

	console.log(
		`OK: ${files.length} modulos compilam com o Luau ${LUAU_VERSION} oficial (--null -O2, o carregamento real).`,
	);

	// Headroom report: real padding-probe numbers for the heaviest files by the fast heuristic.
	const ranked = files
		.map(file => ({ file, estimate: estimateChunkLocals(fs.readFileSync(file, "utf8")) }))
		.sort((a, b) => b.estimate - a.estimate)
		.slice(0, HEADROOM_CANDIDATES);

	const rows = [];
	for (const { file } of ranked) {
		const free = realHeadroom(luauCompilePath, fs.readFileSync(file, "utf8"), { limit: LIMIT });
		if (free === null) continue; // shouldn't happen -- the file just compiled above -- but don't crash the report over it
		rows.push({ file, free, peak: LIMIT - free });
	}
	rows.sort((a, b) => a.free - b.free);

	console.log(`\nHeadroom real (padding probe, Luau ${LUAU_VERSION}) nos ${rows.length} modulos mais pesados:`);
	for (const r of rows) {
		const name = path.basename(r.file, ".luau");
		const flag = r.free < WARN_FREE ? "  <- aviso: menos de " + WARN_FREE + " livres" : "";
		console.log(`  ${name}: ${r.peak}/${LIMIT} (${r.free} livres)${flag}`);
	}
}

main();
