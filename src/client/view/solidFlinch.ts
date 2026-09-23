/*
 * The flinch of a struck tree, car or bin on THIS client, and the one place that counts it down.
 *
 * In the original every map item owns its `shake` and its own Step event takes one off every frame
 * (par_map_item, obj_tree1, obj_car): a shake cannot outlive the object's own clock. Here `Solid.hitShake` is
 * written by several hands, and below MP_PHASE 2 the horde's sweep (zombieBrain.sweepAround) ages it. From
 * MP_PHASE 2 on that sweep only runs on the server, so a shake the client started itself (E on a tree or a
 * car, interaction.hitMapItem) had nobody left to count it down: it stayed at its full 0.25 s and the solid
 * vibrated for ever. Every client-side flinch goes through `flinch`, and `ageFlinches` is its only clock.
 */
import { Solid } from "shared/game/world";
import { MP_PHASE } from "shared/net/mpConfig";

/** solids with a flinch this file has to carry (MP_PHASE ≥ 2 only) */
const shaking = new Array<Solid>();

/** make `s` flinch for at least `seconds`; a longer flinch already running is kept */
export function flinch(s: Solid, seconds: number): void {
	if (seconds <= 0) return;
	s.hitShake = math.max(s.hitShake ?? 0, seconds);
	// below MP_PHASE 2 the simulation that struck it also ages it; a second clock would halve the flinch
	if (MP_PHASE < 2) return;
	for (const had of shaking) {
		if (had === s) return;
	}
	shaking.push(s);
}

/** one frame of every flinch this client started; call it every frame from MP_PHASE 2 on, online or not */
export function ageFlinches(dt: number): void {
	const step = math.max(0, dt);
	for (let i = shaking.size() - 1; i >= 0; i--) {
		const s = shaking[i];
		const left = s.removed === true ? 0 : math.max(0, (s.hitShake ?? 0) - step);
		s.hitShake = left;
		if (left <= 0) shaking.remove(i);
	}
}

/** a new world: the old town's solids are gone, and so are their flinches */
export function clearFlinches(): void {
	shaking.clear();
}

/** how many solids are flinching right now (tests, the admin overlay) */
export function flinchCount(): number {
	return shaking.size();
}
