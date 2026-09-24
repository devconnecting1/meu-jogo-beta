#!/usr/bin/env node
/*
 * Town scale bench (docs/research/SERVER_CLIENT_AND_SCALE.md): the REAL compiled generator, spatial grid, chase
 * field, wire encoder and server tick (out/, after `npm run build`), run in the pinned official Luau CLI
 * (tools/luauRelease.mjs) -- at the town's own size and at bigger ones. A bigger town is a copy of the compiled
 * modules with DESIGN.WORLD_W/H scaled (area × s, aspect kept, multiples of 128 u) and the four boss anchors moved
 * with it; nothing in src/ changes.
 *
 *   npm run build && node tools/bench-town.mjs            # scales 1, 1.5, 2 and 3 of the area, seed 7331
 *   node tools/bench-town.mjs --scales 1,2 --seed 42 --reps 5
 *   node tools/bench-town.mjs --tick                      # also the §3.2 server tick at each scale (20 s each)
 *   PZ_LUAU=/path/to/luau node tools/bench-town.mjs       # a Luau CLI of your own instead of the pinned download
 *
 * What runs how, and why:
 *   - town.luau   interpreted (-O2): the generator is interpreted on a Roblox server too (world.luau carries no
 *                 --!native) and on every client; the O(solids) walks and the ground's cull loop model client code.
 *   - field.luau  --codegen: server/sim/flowField.luau is --!native, as on the live server.
 *   - tick.luau   --codegen: ServerSimulation + Replicator, 6 survivors, 150 zombies (the §3.2 scenario).
 *   - wire.luau   once: WorldInit bytes do not depend on the town's size (the static map is never sent).
 * Wall-clock times are the minimum of --reps runs: on a shared box, load only ever adds. The load average is printed
 * first; read the numbers against it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLuauCompile } from "./luauRelease.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "out");
const BENCH = path.join(ROOT, "tools", "bench-town");
const CACHE = path.join(ROOT, ".cache", "bench-town");
/** codec.ts POS_MAX: a position is a u16 at 0.5 u on the wire */
const POS_MAX = 65535 / 2;

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const scales = arg("--scales", "1,1.5,2,3")
	.split(",")
	.map(Number)
	.filter(s => s > 0);
const seed = Number(arg("--seed", "7331"));
const reps = Math.max(1, Number(arg("--reps", "3")));
const withTick = process.argv.includes("--tick");

async function luauBinary() {
	if (process.env.PZ_LUAU) return process.env.PZ_LUAU;
	const compile = await ensureLuauCompile({ log: m => console.log(m) });
	if (compile === null) throw new Error("no pinned Luau release for this platform: set PZ_LUAU");
	const bin = path.join(path.dirname(compile), process.platform === "win32" ? "luau.exe" : "luau");
	if (!fs.existsSync(bin)) throw new Error(`${bin} is not in the pinned release: set PZ_LUAU`);
	if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
	return bin;
}

const HEADER =
	'local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))';
const GLOBALS = ["game", "Color3", "Vector2", "UDim2", "Random", "warn", "debug", "task"];

/** out/{shared,server} -> `dest`, every module wrapped for rt.luau; `edit(rel, src)` may rewrite one first */
function prep(dest, edit) {
	fs.rmSync(dest, { recursive: true, force: true });
	const mods = [];
	const walk = dir => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(p);
				continue;
			}
			if (!entry.name.endsWith(".luau")) continue;
			const rel = path.relative(OUT, p).replace(/\\/g, "/");
			const mod = rel.replace(/\.luau$/, "");
			const src = edit(rel, fs.readFileSync(p, "utf8"));
			const lines = src.split("\n");
			const native = lines[0].startsWith("--!native");
			const used = GLOBALS.filter(g => new RegExp(`\\b${g}\\b`).test(src));
			const locals =
				`return function(__rt) local TS = __rt.TS; local script = __rt.script(${JSON.stringify(mod)})` +
				used.map(g => `; local ${g} = __rt.${g}`).join("");
			const i = lines.findIndex(l => l.trim() === HEADER);
			if (i >= 0) lines[i] = locals;
			else lines.splice(native ? 1 : 0, 0, locals);
			lines.push("end");
			const body = lines.join("\n");
			const file = path.join(dest, rel);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			if (native) {
				fs.writeFileSync(file, body);
			} else {
				let eq = "=====";
				while (body.includes(`]${eq}]`)) eq += "=";
				fs.writeFileSync(file, `return [${eq}[\n${body}]${eq}]\n`);
			}
			mods.push([mod, native]);
		}
	};
	walk(path.join(OUT, "shared"));
	walk(path.join(OUT, "server"));
	fs.writeFileSync(
		path.join(dest, "manifest.luau"),
		`return {\n${mods.map(([m, n]) => `\t[${JSON.stringify(m)}] = ${n},`).join("\n")}\n}\n`,
	);
}

/** the town's size at `s` times the area (aspect kept, multiples of 128 u) and the constants edit that makes it */
function scaled(s, constants) {
	const w0 = Number(/WORLD_W = (\d+),/.exec(constants)[1]);
	const h0 = Number(/WORLD_H = (\d+),/.exec(constants)[1]);
	const k = Math.sqrt(s);
	const w = Math.round((w0 * k) / 128) * 128;
	const h = Math.round((h0 * k) / 128) * 128;
	const edit = (rel, src) => {
		if (rel !== "shared/engine/constants.luau" || s === 1) return src;
		return src
			.replace(`WORLD_W = ${w0},`, `WORLD_W = ${w},`)
			.replace(`WORLD_H = ${h0},`, `WORLD_H = ${h},`)
			.replace(/(BOSS\d)_([XY]) = (\d+),/g, (_, b, axis, v) => {
				const f = axis === "X" ? w / w0 : h / h0;
				return `${b}_${axis} = ${Math.round((Number(v) * f) / 64) * 64},`;
			});
	};
	return { w, h, edit };
}

function run(luau, flags, script, args) {
	const r = spawnSync(luau, [...flags, script, "-a", ...args.map(String)], { cwd: BENCH, encoding: "utf8" });
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
		.split("\n")
		.filter(l => l.trim() !== "" && !l.startsWith("WARN"))
		.join("\n");
	if (r.status !== 0) throw new Error(`${script} failed (${r.status}):\n${out}`);
	return out;
}

async function main() {
	if (!fs.existsSync(path.join(OUT, "shared", "engine", "constants.luau"))) {
		console.error('out/ is missing: run "npm run build" first.');
		process.exit(1);
	}
	const luau = await luauBinary();
	const constants = fs.readFileSync(path.join(OUT, "shared", "engine", "constants.luau"), "utf8");
	const load = os.loadavg().map(v => v.toFixed(1));
	console.log(`bench-town: seed ${seed}, ${reps} rep(s), ${os.cpus().length} CPUs, load average ${load.join(" / ")}`);
	for (const s of scales) {
		const { w, h, edit } = scaled(s, constants);
		const tag = `x${String(s).replace(".", "_")}`;
		const dest = path.join(CACHE, `mods-${tag}`);
		prep(dest, edit);
		const rel = path.relative(BENCH, dest).replace(/\\/g, "/");
		const mods = rel.startsWith(".") ? rel : `./${rel}`;
		console.log(`\n== ${s} x the area: ${w} x ${h} u`);
		if (w > POS_MAX || h > POS_MAX) {
			console.log(`  !! past the wire: codec.ts POS_MAX is ${POS_MAX} u (u16 at 0.5 u); positions would clamp`);
		}
		console.log(run(luau, ["-O2"], "town.luau", [mods, seed, reps]));
		console.log(run(luau, ["-O2", "--codegen"], "field.luau", [mods, seed]));
		if (withTick) console.log(run(luau, ["-O2", "--codegen"], "tick.luau", [mods, 3000, 1200]));
		if (s === scales[0]) console.log(run(luau, ["-O2"], "wire.luau", [mods]));
	}
}

main().catch(err => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
