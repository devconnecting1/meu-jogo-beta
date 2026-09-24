/*
 * The bank's alarm bell, heard (docs/DESIGN_RULES.md EDI-23; the rules: shared/sim/vault.ts).
 *
 * While the portico of a bank has its `powered` on -- the server's LightSet, the bell ringing after its vault was
 * cracked -- an electric bell rings there: the bicycle bell's recording (shared/data/sounds.ts `bellBike`) pitched down
 * and struck fast, the hammer of a bell box on a wall. Spatial like every world sound: loud on Main Street, gone two
 * blocks away (the entry's own range). Nothing to send and nothing to decide: what rings is what the server said rings.
 */
import type { Solid, WorldData } from "shared/game/world";
import { isPortico } from "shared/sim/vault";
import { audio } from "./audio";

/** a stroke of the hammer every this many seconds, alternating two pitches: ring-ring-ring */
const STROKE_S = 0.18;
const PITCH_A = 0.6;
const PITCH_B = 0.66;

let listedFor: WorldData | undefined;
let porticos: Array<Solid> = [];
let clock = 0;
let nextStroke = 0;
let stroke = 0;

/** every frame of a run: the bells of the town that ring, struck at their porticos */
export function stepBankAlarm(world: WorldData, dt: number): void {
	if (listedFor !== world) {
		// the town is static: its porticos, listed once (a town has one bank)
		listedFor = world;
		porticos = [];
		for (const s of world.solids) if (isPortico(s)) porticos.push(s);
	}
	clock += dt;
	if (clock < nextStroke) return;
	nextStroke = clock + STROKE_S;
	stroke += 1;
	for (const p of porticos) {
		if (p.powered !== true) continue;
		audio.play("bellBike", { x: p.x + p.w / 2, y: p.y + p.h / 2, pitch: stroke % 2 === 0 ? PITCH_A : PITCH_B });
	}
}
