#!/usr/bin/env node
/*
 * A struck tree / car / bin stops shaking.
 *
 *   npm run test:flinch
 *
 * The bug (owner's playtest, 2026-09-23): "when I touch the trees and cars it keeps vibrating non-stop". E on a
 * tree or a car runs client/systems/interaction.ts `hitMapItem` on the client, which set `Solid.hitShake` to
 * 0.25 s. Below MP_PHASE 2 the horde's sweep (zombieBrain.sweepAround) counts that down; from MP_PHASE 2 on
 * the horde lives on the server, fxView only aged the shakes IT had started (the wire's SolidShake), and the
 * one started by E was never aged: the sprite shook at full strength for ever.
 *
 * The original has no such hole: every map item owns `shake` and its own Step event takes one off per frame
 * (par_map_item / obj_tree1 / obj_car). Here every client-side flinch goes through view/solidFlinch.ts and
 * `ageFlinches` is its one clock, called from GameLoop.update on every frame from MP_PHASE 2 on.
 *
 * What this proves:
 *   1. E on a tree and on a car flinches it, and the flinch is over within its 0.25 s (+ one frame);
 *   2. the wire's SolidShake goes through the same clock and ends too, and a second hit on a shaking solid
 *      restarts it instead of stacking a second clock;
 *   3. a solid removed while shaking is let go;
 *   4. nothing in src/client writes `hitShake` behind solidFlinch.ts's back, and GameLoop.update runs the
 *      clock outside `if (mirrored)` (offline at MP_PHASE 2 nothing else would).
 *
 * Pure Node (>= 18) + the project's TypeScript on the shared shims of tools/luau-shim.mjs.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { installShims } from "./luau-shim.mjs";

const { SRC, require } = installShims({ seed: 7 });

// client/systems/interaction.ts reaches the audio and UI modules, which touch Roblox services while loading.
// Nothing this suite checks plays a sound or draws a frame, so every service and Instance is an inert stand-in
// that answers any property or call with another stand-in.
const inert = new Proxy(function () {}, {
	get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : key === "then" ? undefined : inert),
	apply: () => inert,
	construct: () => inert,
	set: () => true,
});
globalThis.game ??= inert;
globalThis.Instance ??= inert;
globalThis.Enum ??= inert;
globalThis.task ??= inert;
globalThis.pcall ??= (f, ...a) => {
	try {
		return [true, f(...a)];
	} catch (e) {
		return [false, e];
	}
};

let failures = 0;
function check(name, ok, detail) {
	if (ok) console.log(`  ok   ${name}`);
	else {
		console.log(`  FAIL ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
		failures += 1;
	}
}

const { MP_PHASE } = require(join(SRC, "shared/net/mpConfig.ts"));
const { generateTown } = require(join(SRC, "shared/game/world.ts"));
const { hitMapItem } = require(join(SRC, "client/systems/interaction.ts"));
const { FxView } = require(join(SRC, "client/view/fxView.ts"));
const { ageFlinches, clearFlinches, flinch, flinchCount } = require(join(SRC, "client/view/solidFlinch.ts"));
const Net = require(join(SRC, "shared/net/protocol.ts"));

console.log(`flinch — MP_PHASE ${MP_PHASE}`);
if (MP_PHASE < 2) {
	console.log("  (MP_PHASE < 2: the horde's sweep owns the countdown; nothing here to prove)");
	process.exit(0);
}

const world = generateTown(4242);
const tree = world.solids.find(s => s.kind === "tree");
const car = world.solids.find(s => s.kind === "car" && s.tags === "car");
check("the town has a tree and a car", tree !== undefined && car !== undefined);

const player = { x: tree.x - 30, y: tree.y, dead: false };
const refs = { world, player, players: [player], save: { invenEtc: [] }, fx: [] };

const FRAME = 1 / 60;
/** frames until `s` stops shaking (the loop's own call, one per frame), or Infinity after 10 s */
function framesToRest(s) {
	for (let f = 1; f <= 600; f++) {
		ageFlinches(FRAME);
		if ((s.hitShake ?? 0) <= 0) return f;
	}
	return Infinity;
}
const LIMIT = Math.ceil(0.25 / FRAME) + 1;

// 1. E on a tree, E on a car
for (const [name, s] of [
	["tree", tree],
	["car", car],
]) {
	hitMapItem(refs, s, false, player);
	check(`E on a ${name} makes it flinch`, (s.hitShake ?? 0) > 0, `hitShake=${s.hitShake}`);
	const n = framesToRest(s);
	check(`the ${name} stops shaking within 0.25 s`, n <= LIMIT, `${n} frames (limit ${LIMIT})`);
}
check("nothing is left flinching", flinchCount() === 0, `${flinchCount()} solids`);

// 2. the wire's SolidShake, and a hit on a solid that is already shaking
const view = new FxView();
view.playSolidShake(refs, { t: Net.FxType.SolidShake, solidId: tree.id, angle: 0, strength: 1 });
check("the server's SolidShake flinches the tree", (tree.hitShake ?? 0) > 0);
for (let f = 0; f < 6; f++) ageFlinches(FRAME);
view.playSolidShake(refs, { t: Net.FxType.SolidShake, solidId: tree.id, angle: 0, strength: 1 });
check("a second hit keeps ONE clock on the solid", flinchCount() === 1, `${flinchCount()} entries`);
const n2 = framesToRest(tree);
check("…and it still ends within 0.25 s of the last hit", n2 <= LIMIT, `${n2} frames`);

// 3. removed while shaking
// (not hitMapItem: the car is still on the hit cooldown of step 1, so E would be a no-op)
flinch(car, 0.25);
car.removed = true;
ageFlinches(FRAME);
check("a solid removed mid-shake is let go", flinchCount() === 0 && car.hitShake === 0);
car.removed = undefined;
clearFlinches();

// 4. the source: one writer, one clock, run outside `if (mirrored)`
const writers = [];
(function walk(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p);
		else if (p.endsWith(".ts") && !p.endsWith("solidFlinch.ts")) {
			const text = readFileSync(p, "utf8");
			if (/\.hitShake\s*=(?!=)/.test(text)) writers.push(relative(SRC, p));
		}
	}
})(join(SRC, "client"));
check("no client file writes hitShake except view/solidFlinch.ts", writers.length === 0, writers.join(", "));

const loop = readFileSync(join(SRC, "client/gameLoop.ts"), "utf8");
check(
	"GameLoop.update runs ageFlinches on its own line, not under `if (mirrored)`",
	/\n\t\tif \(SERVER_ACTORS\) ageFlinches\(dt\);/.test(loop),
);

console.log(failures === 0 ? "flinch: all checks passed" : `flinch: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
