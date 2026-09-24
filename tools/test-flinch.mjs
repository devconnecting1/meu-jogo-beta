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
 *      clock outside `if (mirrored)` (offline at MP_PHASE 2 nothing else would);
 *   5. Reduce Motion (DESIGN_RULES BEM-08): the camera never shakes -- a recoil, the simulation's shake, the server's
 *      Shake -- and settles at once if the setting comes on mid-kick; a struck solid (the town's drawing) and a struck
 *      machine hold still while the flinch itself keeps counting; the loop feeds the setting every frame, and nothing
 *      but camera.ts writes the shake state.
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

// 5. Reduce Motion (docs/DESIGN_RULES.md BEM-08, research P0-2): the camera never shakes and a struck solid holds still.
// The choice is to TAKE the motion away, not to swap it: every kick doubled a cue that does not move and stays (the
// shot's line and sound, the blow's blood, the bite's flashes, the solid's debris and drop). The flinch itself still
// counts down, so turning the setting off mid-flinch shows the rest of it, and nothing else about 1-4 changes.
{
	const { Camera } = require(join(SRC, "shared/engine/camera.ts"));
	const { WorldView } = require(join(SRC, "client/view/worldView.ts"));
	const noParticles = {};
	/** the camera's offset after a kick of `magnitude` for `duration`, one frame later: [x, y] in px */
	const kick = (cam, how) => {
		how(cam);
		cam.update(FRAME);
		cam.project(0, 0);
		return [cam.screenX - cam.viewW / 2, cam.screenY - cam.viewH / 2];
	};
	const moved = ([x, y]) => Math.abs(x) + Math.abs(y) > 1e-9;
	const sim = cam =>
		view.playSim({ ...refs, fx: [{ kind: "shake", player: 0, magnitude: 5, duration: 0.3 }] }, cam, noParticles);
	const wire = cam =>
		view.playWire(refs, [{ t: Net.FxType.Shake, slot: 0, magnitude: 5, duration: 0.3 }], cam, noParticles, {
			localSlot: 0,
		});
	const direct = cam => cam.shake(5, 0.3);
	const off = [direct, sim, wire].map(how => moved(kick(new Camera(), how)));
	const on = [direct, sim, wire].map(how => {
		const cam = new Camera();
		cam.reduceMotion = true;
		return moved(kick(cam, how));
	});
	check(
		"without Reduce Motion a kick shakes the camera (a shot's recoil, the simulation's shake, the server's Shake)",
		off.every(Boolean),
		JSON.stringify(off),
	);
	check(
		"with Reduce Motion none of the three moves the camera: the view stays exactly where it follows",
		on.every(m => !m),
		JSON.stringify(on),
	);
	// switched on in the middle of a kick: the view settles on the next frame instead of finishing it
	const cam = new Camera();
	cam.shake(6, 1);
	cam.update(FRAME);
	cam.reduceMotion = true;
	const settled = !moved(kick(cam, () => {}));
	check("Reduce Motion turned on mid-kick: the next frame is still", settled && cam.shakeT === 0);

	// the solids: the town's own drawing offset (worldView.ts `shake`), the one every tree / car / bin / build reads
	const town = new WorldView(() => ({ x: 0, y: 0 }));
	flinch(tree, 0.25);
	town.clock = 0.37;
	const offFlinch = town.shake(tree);
	town.reduceMotion = true;
	const onFlinch = town.shake(tree);
	check(
		"a struck tree shakes without Reduce Motion, and holds still with it (offset 0, 0)",
		(offFlinch.x !== 0 || offFlinch.y !== 0) && onFlinch.x === 0 && onFlinch.y === 0,
		`${JSON.stringify(offFlinch)} -> ${JSON.stringify(onFlinch)}`,
	);
	const n5 = framesToRest(tree);
	check("...and its flinch still counts down and ends within 0.25 s (the clock of 1-4 is untouched)", n5 <= LIMIT);
	clearFlinches();

	// the machines draw their own flinch (machinesView.ts), and the loop hands both views and the camera the setting
	const machines = readFileSync(join(SRC, "client/view/machinesView.ts"), "utf8");
	check(
		"a struck machine holds still too (machinesView.ts: `hit > 0 && !this.reduceMotion`)",
		/if \(hit > 0 && !this\.reduceMotion\)/.test(machines),
	);
	check(
		"GameLoop reads Reduce Motion every frame into the camera (update) and the town and machines (draw)",
		/ctx\.cam\.reduceMotion = reducedMotion\(\);/.test(loop) &&
			/town\.reduceMotion = reducedMotion\(\);/.test(loop) &&
			/this\.machines\.reduceMotion = town\.reduceMotion;/.test(loop),
	);
	const writersOfShake = [];
	(function walk(dir) {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (p.endsWith(".ts") && !p.endsWith("camera.ts")) {
				const text = readFileSync(p, "utf8");
				if (/\bshake(X|Y|T|Mag)\s*=(?!=)/.test(text)) writersOfShake.push(relative(SRC, p));
			}
		}
	})(SRC);
	check(
		"nothing outside shared/engine/camera.ts writes the camera's shake state (the gate cannot be walked around)",
		writersOfShake.length === 0,
		writersOfShake.join(", "),
	);
}

console.log(failures === 0 ? "flinch: all checks passed" : `flinch: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
