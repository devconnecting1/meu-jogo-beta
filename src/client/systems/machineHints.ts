/*
 * The HUD's "E: …" on an electric build (LEG-01), where the SERVER owns the grid (F3, `WORLD_SERVER_PHASE`): what
 * server/sim/power.ts `act` will do with the press, told from what the grid published (client/systems/powerMirror.ts)
 * and from this client's copy of the backpack. Below that phase the client's own world answers E, and the ordinary
 * hint (client/systems/interaction.ts) is the truth.
 *
 * A machine whose E has nothing to do answers undefined, and the ordinary hint follows — a repair, when it is hurt
 * and the material is in the backpack, exactly as the server falls back to one.
 */
import {
	machineOf,
	OIL_REFUEL_COST,
	powerFlying,
	powerLevel,
	powerOn,
	powerWorking,
	STUN_GUN_ID,
} from "shared/data/power";
import { ownsWeapon, PlayerSaveData } from "shared/game/save";
import { Solid } from "shared/game/world";
import { MP_PHASE, WORLD_SERVER_PHASE } from "shared/net/mpConfig";
import { countItem } from "shared/sim/inventory";
import { mirroredPower } from "./powerMirror";

/** ETC index of oil */
const OIL_ITEM = 48;

export function machineHint(save: PlayerSaveData, s: Solid): string | undefined {
	if (MP_PHASE < WORLD_SERVER_PHASE) return undefined;
	const def = machineOf(s);
	if (def === undefined) return undefined;
	const state = mirroredPower(s.id)?.state ?? 0;
	if (def.role === "battery") {
		if (!ownsWeapon(save, STUN_GUN_ID)) return undefined;
		return powerLevel(state) > 0 ? "E: Charge stun gun" : "Battery box empty";
	}
	if (def.role === "generator") {
		// the tank's level: a full one has nothing to take (the server then repairs, if anything)
		if (def.source !== "oil" || powerLevel(state) >= 3) return undefined;
		return countItem(save, 4, OIL_ITEM) >= OIL_REFUEL_COST ? "E: Refuel (5 Oil)" : "Refuel: needs 5 Oil";
	}
	if (def.role === "drone") {
		if (powerFlying(state)) return "E: Call back drone";
		return powerLevel(state) > 0 ? "E: Launch drone" : "Drone charging";
	}
	if (!def.switched) return undefined;
	if (!powerOn(state)) return "E: Turn on";
	return powerWorking(state) ? "E: Turn off" : "E: Turn off (no power)";
}
