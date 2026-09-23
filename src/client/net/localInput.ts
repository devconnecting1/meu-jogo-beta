/*
 * The one place that turns this machine's keyboard / mouse / touch state into the `RawInput` a command is built
 * from (docs/MULTIPLAYER.md §2.2).
 *
 * Both paths read it: the single-player loop (which quantises it straight into one command per frame) and
 * `netClient` (which feeds it to the 60 Hz CommandStream). They must not drift apart — the whole point of §2.2 is
 * that what the survivor feels locally is built from the same numbers the server will consume.
 *
 * This file is allowed to touch the client's input plumbing (`syncKeyboardMove`); `commands.ts`, `prediction.ts`
 * and `snapshotBuffer.ts` stay pure so tools/test-predict.mjs can drive them.
 */
import { Camera } from "shared/engine/camera";
import { InputState } from "shared/engine/input";
import { HeldBit } from "shared/net/protocol";
import { syncKeyboardMove } from "../bootstrap";
import { RawInput } from "./commands";

/**
 * The smallest magnitude a command can carry and still mean "walking" (1/255 is the u8 step). Any deflection at
 * all walks at full speed — the stick's magnitude travels for later use but never scales the speed (§2.2,
 * InputCommand.moveMag) — so a barely-touched stick must not quantise down to "standing".
 */
const MIN_MAGNITUDE = 1 / 255;

export function createRawInput(): RawInput {
	return { moveX: 0, moveY: 0, magnitude: 0, aim: 0, held: 0 };
}

/**
 * Fills `out` with this frame's local input, in world space, and returns it. Nothing is allocated.
 *
 * `frozen` is the admin free camera: the survivor stands still, which is a command with no movement rather than a
 * special case anywhere downstream.
 *
 * `input.held` (DESIGN_RULES UI-06) is a menu over the run, or a dead survivor: the same standing command, and
 * with empty hands too -- no held attack, no held E -- while the commands keep flowing at 60 Hz. That is the
 * honest thing to send: the survivor is in the Bag, not out of the world, and the server keeps the world going.
 * The aim is the last one the survivor had (the loop stops refreshing it while held), so they do not spin round
 * following a cursor that is busy with the menu.
 */
export function readRawInput(cam: Camera, input: InputState, frozen: boolean, out: RawInput): RawInput {
	syncKeyboardMove();
	let dx = 0;
	let dy = 0;
	let magnitude = 0;
	// input is screen-space; in top-down it maps 1:1 to world (camera rotation undone)
	if (input.moveMagnitude > 0 && !frozen && !input.held) {
		const d = cam.screenDirToWorld(input.moveX, input.moveY);
		const l = math.sqrt(d.x * d.x + d.y * d.y);
		if (l > 0.0001) {
			dx = d.x / l;
			dy = d.y / l;
			magnitude = math.max(MIN_MAGNITUDE, math.min(1, input.moveMagnitude));
		}
	}
	out.moveX = dx;
	out.moveY = dy;
	out.magnitude = magnitude;
	out.aim = input.aimAngle;
	let held = 0;
	if (input.attackHeld && !input.held) held += HeldBit.Attack;
	if (input.keyE && !input.held) held += HeldBit.Action;
	out.held = held;
	return out;
}
