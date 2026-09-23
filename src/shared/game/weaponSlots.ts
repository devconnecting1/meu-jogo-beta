import { WEAPONS } from "shared/data/weapons";
import { PlayerSaveData, ownsWeapon } from "shared/game/save";

/** keys 1–5 pick a weapon (client/bootstrap.ts WEAPON_KEYS); the HUD's hotbar has one tile per key */
export const WEAPON_KEY_COUNT = 5;

/**
 * The weapons the number keys pick, in key order: every weapon the survivor owns and the one in hand, by id.
 *
 * ONE list for the two readers that must agree on it: client/systems/combat.ts turns key k
 * (`InputState.weaponSlotPressed`) into `list[k]`, and the HUD's hotbar (client/ui/hudConsole.ts) draws `list[0..4]`
 * with the key under each tile. If they each built their own, a tile could say "3: Pistol" while key 3 drew the axe.
 *
 * `out` is cleared and refilled, so a caller that runs every frame (the HUD) allocates nothing.
 */
export function weaponKeyOrder(save: PlayerSaveData, inHand: number, out: Array<number> = []): Array<number> {
	out.clear();
	for (let i = 0; i < WEAPONS.size(); i++) {
		if (ownsWeapon(save, i) || i === inHand) out.push(i);
	}
	return out;
}
