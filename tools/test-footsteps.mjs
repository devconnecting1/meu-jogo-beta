#!/usr/bin/env node
/*
 * Footstep cadence: does a step get reported when a foot really lands?
 *
 *   npm run test:footsteps
 *
 * This is the one link of the footstep chain that cannot be checked live from here: the synthetic WASD the
 * MCP bridge sends never reaches UserInputService, so the survivor will not walk in Studio. Everything else
 * WAS checked there: the two catalogue ids load (MarketplaceService: "Foot Stomp 3/4 (SFX)", ProSoundEffects,
 * public domain), the mixer boots with its three buses and plays other voices, and the sink is attached at
 * boot -- onFootstep(playFootstep) sits above the "client ready" print that the output shows, so it ran.
 *
 * What is left is the DETECTOR: client/view/footsteps.ts watches the same sine the feet are drawn with, and
 * turns it into steps -- for the local survivor, whose phase the simulation advances, and for an ally, whose
 * phase the snapshot interpolation advances.
 *
 * What this proves:
 *   1. a foot is reported at every drawn foot plant, as long as the body is walking slowly enough that a
 *      real one would;
 *   2. at full speed the drawn gait is about twice a real one, and the cadence is capped to a real one
 *      (MIN_STEP_GAP) while still landing ON a drawn foot plant;
 *   3. a survivor standing still, or merely shoved by knockback, reports NOTHING;
 *   4. stopping and walking again does not report the gap, and does not swallow the first step back;
 *   5. survivors are independent, so a group sounds like a group and not like one pair of boots;
 *   6. with no listener nothing is reported, and footstepsWanted says so.
 *
 * The clock is faked (os.clock) so the cadence is measured exactly instead of in real time.
 *
 * Pure Node (>= 18) plus the project's TypeScript, with the same shims the other tools use.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(process.env.PZ_SRC ?? join(ROOT, "src"));
const require = createRequire(import.meta.url);
const Module = require("node:module");
const ts = require("typescript");

globalThis.math = { floor: Math.floor, huge: Infinity, pi: Math.PI, abs: Math.abs, max: Math.max, min: Math.min };

/** fake wall clock; the game's os.clock() is seconds since start, so it never begins at zero */
let now = 1000;
globalThis.os = { clock: () => now };

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
	if (req.startsWith("shared/") || req.startsWith("client/")) return join(SRC, req + ".ts");
	if (req.startsWith(".") && parent?.filename?.endsWith(".ts")) {
		const p = resolve(dirname(parent.filename), req);
		if (existsSync(p + ".ts")) return p + ".ts";
	}
	return resolveFilename.call(this, req, parent, ...rest);
};
Module._extensions[".ts"] = function (m, filename) {
	const out = ts.transpileModule(readFileSync(filename, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	});
	m._compile(out.outputText, filename);
};

const { FootCycle, footstepsWanted, onFootstep } = require(join(SRC, "client/view/footsteps.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const { SPEED_SCALE } = require(join(SRC, "shared/sim/types.ts"));

/** read from the files that own them, so the test breaks when the real numbers move */
const FEET_CYCLE_PER_UNIT = Number(
	readFileSync(join(SRC, "client/gameLoop.ts"), "utf8").match(/FEET_CYCLE_PER_UNIT = ([\d.]+)/)[1],
);
const MIN_STEP_GAP = Number(
	readFileSync(join(SRC, "client/view/footsteps.ts"), "utf8").match(/MIN_STEP_GAP = ([\d.]+)/)[1],
);
/** an unbuffed survivor's speed, in world units per second */
const WALK_SPEED = DESIGN.MOVE_SPEED * SPEED_SCALE;
const DT = 1 / 60;
/** foot plants per second that the DRAWING produces at full speed */
const DRAWN_PER_SEC = (WALK_SPEED * FEET_CYCLE_PER_UNIT) / Math.PI;

let failures = 0;
function check(name, ok, detail) {
	const tail = detail === undefined ? "" : "  (" + detail + ")";
	if (ok) {
		console.log("  ok    " + name + tail);
	} else {
		console.error("  FALHA " + name + tail);
		failures += 1;
	}
}

/** attaches a collecting sink and returns the array it fills */
function collect() {
	const steps = [];
	onFootstep((x, y, isLocal) => steps.push({ x, y, isLocal, t: now }));
	return steps;
}

/** walks one survivor for `seconds` at `speed`, advancing the fake clock frame by frame */
function walk(foot, seconds, speed, state) {
	for (let i = 0; i < Math.round(seconds / DT); i++) {
		const moved = speed * DT;
		state.x += moved;
		state.phase += moved * FEET_CYCLE_PER_UNIT;
		now += DT;
		foot.advance(state.phase, 1, state.x, 0, true);
	}
}

console.log(
	"constantes lidas do codigo: velocidade " +
		WALK_SPEED +
		" u/s, " +
		FEET_CYCLE_PER_UNIT +
		" rad/u -> " +
		DRAWN_PER_SEC.toFixed(2) +
		" pisadas desenhadas/s, limite " +
		MIN_STEP_GAP +
		" s",
);

// ---------------------------------------------------------------- 1: a real cadence passes untouched

console.log("\n1) num passo que um corpo real daria, toda pisada desenhada e reportada");
{
	const steps = collect();
	const foot = new FootCycle();
	const state = { phase: 0, x: 0 };
	// slow enough that the drawn cadence is already under the cap
	const slow = (Math.PI / (MIN_STEP_GAP * FEET_CYCLE_PER_UNIT)) * 0.8;
	walk(foot, 10, slow, state);
	const expected = Math.floor(state.phase / Math.PI);
	check("uma pisada por meio ciclo", Math.abs(steps.length - expected) <= 1, steps.length + " vs ~" + expected);
	// nothing was dropped: the cadence heard IS the cadence drawn, not the cap
	const drawnSlow = (slow * FEET_CYCLE_PER_UNIT) / Math.PI;
	check(
		"nada foi descartado",
		Math.abs(steps.length / 10 - drawnSlow) < 0.15,
		(steps.length / 10).toFixed(2) + "/s vs " + drawnSlow.toFixed(2) + "/s desenhadas",
	);
	check(
		"todas marcadas como local",
		steps.every(s => s.isLocal),
	);
	check("a posicao acompanha o andar", steps[steps.length - 1].x > steps[0].x);
}

// ---------------------------------------------------------------- 2: full speed is capped

console.log("\n2) na velocidade cheia a cadencia vira a de um corpo real");
{
	const steps = collect();
	const foot = new FootCycle();
	const state = { phase: 0, x: 0 };
	walk(foot, 10, WALK_SPEED, state);
	const perSec = steps.length / 10;
	check(
		"o desenho pisaria rapido demais",
		DRAWN_PER_SEC > 1 / MIN_STEP_GAP,
		DRAWN_PER_SEC.toFixed(2) + "/s desenhadas",
	);
	check(
		"o som nao passa do limite",
		perSec <= 1 / MIN_STEP_GAP + 0.05,
		perSec.toFixed(2) + "/s <= " + (1 / MIN_STEP_GAP).toFixed(2),
	);
	check(
		"e nem vira silencio",
		perSec > DRAWN_PER_SEC / 2 - 0.5,
		perSec.toFixed(2) + "/s de " + DRAWN_PER_SEC.toFixed(2),
	);
	// every reported step still lands on a drawn foot plant: the gap is a multiple of the drawn interval
	const drawnInterval = 1 / DRAWN_PER_SEC;
	let onBeat = 0;
	for (let i = 1; i < steps.length; i++) {
		const k = (steps[i].t - steps[i - 1].t) / drawnInterval;
		if (Math.abs(k - Math.round(k)) < 0.2) onBeat += 1;
	}
	check("cada pisada cai em cima de uma do desenho", onBeat >= steps.length - 2, onBeat + "/" + (steps.length - 1));
}

// ---------------------------------------------------------------- 3: still, and shoved

console.log("\n3) parado, ou empurrado, nao pisa");
{
	const steps = collect();
	const foot = new FootCycle();
	for (let i = 0; i < 600; i++) {
		now += DT;
		foot.advance(0, 0, 0, 0, true);
	}
	check("parado nao pisa", steps.length === 0, steps.length + " pisadas");

	let phase = 0;
	for (let i = 0; i < 600; i++) {
		phase += 600 * DT * FEET_CYCLE_PER_UNIT;
		now += DT;
		foot.advance(phase, 0.2, 0, 0, true);
	}
	check("empurrado nao pisa", steps.length === 0, "amp 0.2 abaixo de MIN_AMP");
}

// ---------------------------------------------------------------- 4: stop, then walk again

console.log("\n4) parar e voltar a andar");
{
	const steps = collect();
	const foot = new FootCycle();
	const state = { phase: 0, x: 0 };
	walk(foot, 1, WALK_SPEED, state);
	const afterFirst = steps.length;
	check("andou e pisou", afterFirst > 0, afterFirst + " pisadas");

	foot.reset();
	for (let i = 0; i < 60; i++) {
		now += DT;
		foot.advance(state.phase, 0, 0, 0, true);
	}
	check("a parada nao gera pisada", steps.length === afterFirst, steps.length - afterFirst + " na parada");

	// the first plant after standing still must be heard: a stopped survivor has no cadence to respect
	state.phase += Math.PI;
	now += DT;
	foot.advance(state.phase, 1, state.x, 0, true);
	now += DT;
	state.phase += Math.PI;
	foot.advance(state.phase, 1, state.x, 0, true);
	check("a retomada e ouvida na hora", steps.length > afterFirst, "primeira pisada de volta reportada");
}

// ---------------------------------------------------------------- 5: a group is a group

console.log("\n5) varios sobreviventes sao independentes");
{
	const steps = collect();
	const SURVIVORS = 4;
	const feet = [];
	const phases = [];
	for (let i = 0; i < SURVIVORS; i++) {
		feet.push(new FootCycle());
		phases.push(i * 0.9); // each one starts on a different foot
	}
	for (let f = 0; f < 600; f++) {
		now += DT;
		for (let i = 0; i < SURVIVORS; i++) {
			phases[i] += WALK_SPEED * DT * FEET_CYCLE_PER_UNIT;
			feet[i].advance(phases[i], 1, i * 100, 0, i === 0);
		}
	}
	const local = steps.filter(s => s.isLocal).length;
	const allies = steps.length - local;
	check("o local e os aliados pisam", local > 0 && allies > 0, "local " + local + ", aliados " + allies);
	check(
		"cada um no proprio pe",
		Math.abs(allies - local * (SURVIVORS - 1)) <= SURVIVORS,
		allies + " vs ~" + local * (SURVIVORS - 1),
	);
	const xs = new Set(steps.filter(s => !s.isLocal).map(s => s.x));
	check("cada pisada vem do seu dono", xs.size === SURVIVORS - 1, xs.size + " posicoes distintas");
}

// ---------------------------------------------------------------- 6: no listener

console.log("\n6) sem ouvinte, nada e reportado");
{
	collect();
	check("footstepsWanted com ouvinte", footstepsWanted() === true);
	onFootstep(undefined);
	check("footstepsWanted sem ouvinte", footstepsWanted() === false);
	const foot = new FootCycle();
	const state = { phase: 0, x: 0 };
	walk(foot, 2, WALK_SPEED, state);
	check("andar sem ouvinte nao quebra", true);
}

console.log("");
if (failures > 0) {
	console.error(failures + " verificacao(oes) falharam");
	process.exit(1);
}
console.log("OK: cadencia real, limite na velocidade cheia, silencio parado, retomada, grupo e desligamento");
