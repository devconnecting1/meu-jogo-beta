/*
 * Thin wrapper around the pinned `luau-compile` (see `tools/luauRelease.mjs`): the real-compiler checks
 * shared by `tools/check-luau.mjs` and `tools/check-registers.mjs`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Runs `luau-compile --null -O2` over `files` (one process for all of them). Never throws. */
export function compileNull(luauCompilePath, files) {
	const res = spawnSync(luauCompilePath, ["--null", "-O2", ...files], { encoding: "utf8" });
	return {
		ok: res.status === 0,
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? "",
		error: res.error, // set if the binary itself could not be spawned
	};
}

const ERROR_LINE = /^(.+?)\((\d+),(\d+)\):\s*(\w*Error):\s*(.+)$/;

/** Groups `luau-compile`'s stderr lines ("path(line,col): CompileError: msg") by file, in first-seen order. */
export function parseCompileErrors(stderr) {
	const byFile = new Map();
	for (const raw of stderr.split("\n")) {
		const line = raw.trimEnd();
		if (!line) continue;
		const m = ERROR_LINE.exec(line);
		if (!m) continue;
		const [, file, ln, col, kind, message] = m;
		if (!byFile.has(file)) byFile.set(file, []);
		byFile.get(file).push({ line: Number(ln), col: Number(col), kind, message });
	}
	return byFile;
}

/**
 * Binary search, via the real compiler, for how many extra never-folded locals
 * (`local _padN = math.random()`, prepended) a file can take before it stops compiling -- i.e. its real
 * headroom under Luau's 200-local chunk limit. Returns null if the file does not compile cleanly on its
 * own (not this function's job to report that).
 */
export function realHeadroom(luauCompilePath, source, { limit = 200, ceiling = limit + 50 } = {}) {
	const tmp = path.join(os.tmpdir(), `pz-regprobe-${process.pid}-${Math.random().toString(36).slice(2)}.luau`);
	try {
		const compiles = pad => {
			const padLines = [];
			for (let i = 0; i < pad; i++) padLines.push(`local _pad${i} = math.random()`);
			fs.writeFileSync(tmp, padLines.join("\n") + "\n" + source);
			return compileNull(luauCompilePath, [tmp]).ok;
		};

		if (!compiles(0)) return null;

		let lo = 0;
		let hi = 1;
		while (hi <= ceiling && compiles(hi)) {
			lo = hi;
			hi *= 2;
		}
		hi = Math.min(hi, ceiling + 1);
		while (hi - lo > 1) {
			const mid = Math.floor((lo + hi) / 2);
			if (compiles(mid)) lo = mid;
			else hi = mid;
		}
		return lo;
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}
