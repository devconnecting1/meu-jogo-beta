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
 * Usage: node tools/check-registers.mjs  (after `npm run build`)
 */
import fs from "node:fs";
import path from "node:path";

/** Luau's hard limit; loading a module with more locals in one chunk throws */
const LIMIT = 200;
/** fail here, leaving room to land a change without a surprise */
const FAIL = 190;
/** print a heads-up here, so a file is flagged while the fix is still cheap */
const WARN = 170;

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

/**
 * Locals declared in the module chunk itself (column 0). Nested scopes have their own budget, so only
 * top-level declarations count here -- and `local a, b, c = ...` declares three.
 */
function topLevelLocals(source) {
	let n = 0;
	for (const line of source.split("\n")) {
		if (!line.startsWith("local ")) continue;
		if (line.startsWith("local function ")) {
			n += 1;
			continue;
		}
		const names = line.slice("local ".length).split("=")[0];
		n += names.split(",").length;
	}
	return n;
}

if (!fs.existsSync(OUT)) {
	console.error(`${OUT}/ nao existe: rode "npm run build" antes.`);
	process.exit(1);
}

const rows = luauFiles(OUT)
	.map(file => ({ file, locals: topLevelLocals(fs.readFileSync(file, "utf8")) }))
	.sort((a, b) => b.locals - a.locals);

const failed = rows.filter(r => r.locals > FAIL);
const warned = rows.filter(r => r.locals > WARN && r.locals <= FAIL);

for (const r of warned) {
	console.log(`aviso  ${String(r.locals).padStart(3)}/${LIMIT}  ${r.file}`);
}
for (const r of failed) {
	console.error(`ERRO   ${String(r.locals).padStart(3)}/${LIMIT}  ${r.file}`);
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
console.log(`OK: ${rows.length} modulos, pior caso ${top.locals}/${LIMIT} em ${top.file}`);
