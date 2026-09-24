/*
 * Text heuristic for a Luau chunk's top-level local-register count (see `tools/check-registers.mjs`'s own
 * header for why this exists and why it is only ever a heuristic; `tools/check-luau.mjs` runs the real
 * compiler and is the source of truth).
 *
 * Two known gaps, found by compiling `out/**\/*.luau` with the real Luau compiler and comparing
 * (audit: scripting F7):
 *
 *   - over-counts: `local NAME = <bare numeric literal>` that is never reassigned is folded into a
 *     compile-time constant by Luau at -O1/-O2 and costs no register. roblox-ts emits exactly this shape
 *     for a TS numeric `const`. We skip these.
 *   - under-counts: roblox-ts wraps every class body in a top-level `do ... end` (transparent to the
 *     surrounding chunk's register file, unlike a nested `function`), and this heuristic's line scan
 *     never looked past column 0, so it missed every local declared directly inside one. We now also
 *     count locals indented exactly one tab directly under a bare top-level `do`.
 *
 * This still is not a real Lua/Luau parser: locals inside a nested `if`/`for`/`while` block that itself
 * sits directly in a top-level `do` (two scopes deep) are not attributed, and a local that is reassigned
 * through an assignment this scan does not recognise is conservatively still counted (never folded) rather
 * than risk an under-count. When it matters, trust the real compiler over this file.
 */

/** Bare numeric literal, optionally negative/decimal -- the only RHS shape Luau folds that we try to detect. */
const NUMERIC_LITERAL = /^-?\d+(?:\.\d+)?$/;

function declaredNames(afterLocalKeyword) {
	// `local a, b, c = ...` declares three; a plain `local function f(...)` declares one (the closure itself).
	return afterLocalKeyword
		.split("=")[0]
		.split(",")
		.map(s => s.trim());
}

/** True if `name` is only ever read, never reassigned, going by a simple whole-line text scan (see header). */
function isNeverReassigned(lines, name, declarationLineIndex) {
	const assign = new RegExp(`(^|[^\\w.:])${name}\\s*=(?!=)`);
	// roblox-ts exports module-level consts as a table's shorthand field, `NAME = NAME,` -- a read, not a write.
	const shorthandExport = new RegExp(`^\\s*${name}\\s*=\\s*${name}\\s*,?\\s*$`);
	for (let i = 0; i < lines.length; i++) {
		if (i === declarationLineIndex) continue;
		const line = lines[i];
		if (line.trimStart().startsWith("local ") && line.includes(name)) continue; // a different `local NAME` in another scope
		if (shorthandExport.test(line)) continue;
		if (assign.test(line)) return false;
	}
	return true;
}

/**
 * Estimated count of locals active in the module chunk's own register file: top-level (column 0)
 * declarations, plus declarations one tab directly inside a bare top-level `do ... end` block, minus
 * numeric-literal constants Luau folds away. See this file's header for the known remaining gaps.
 */
export function estimateChunkLocals(source) {
	const lines = source.split("\n");
	let n = 0;
	let inTopDo = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (line === "do") {
			inTopDo = true;
			continue;
		}
		if (inTopDo && line === "end") {
			inTopDo = false;
			continue;
		}

		const isTopLevel = !line.startsWith("\t") && !line.startsWith(" ");
		const isDoBodyLocal = inTopDo && line.startsWith("\t") && !line.startsWith("\t\t");
		if (!isTopLevel && !isDoBodyLocal) continue;

		const trimmed = isDoBodyLocal ? line.slice(1) : line;
		if (!trimmed.startsWith("local ")) continue;

		if (trimmed.startsWith("local function ")) {
			n += 1;
			continue;
		}

		for (const name of declaredNames(trimmed.slice("local ".length))) {
			const rhsMatch = trimmed.match(new RegExp(`^local\\s+${name}\\s*=\\s*(.+)$`));
			const rhs = rhsMatch ? rhsMatch[1].trim() : null;
			if (rhs !== null && NUMERIC_LITERAL.test(rhs) && isNeverReassigned(lines, name, i)) {
				continue; // folded to a compile-time constant; costs no register
			}
			n += 1;
		}
	}
	return n;
}
