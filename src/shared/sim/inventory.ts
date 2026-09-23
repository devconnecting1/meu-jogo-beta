/*
 * Backpack counts (docs/MULTIPLAYER.md §11.2: client/systems/items.ts → shared/sim/inventory.ts). Pure operations on a
 * PlayerSaveData: the client uses them today, the server's live save from F3 on (the client then only reads).
 * Ammo, arrows and oil are ETC items 44–48 kept in their own save fields (moved as-is from items.ts).
 */
import { EQUIP_SLOT_MAX } from "shared/data/equips";
import { ItemKind } from "shared/data/kinds";
import { PlayerSaveData, equippedIn, ownsEquip, ownsWeapon, setEquipped } from "shared/game/save";

function ammoArray(save: PlayerSaveData, index: number): number {
	if (index === 44) return save.ammoNormal;
	if (index === 45) return save.ammoShotgun;
	if (index === 46) return save.ammoMachinegun;
	if (index === 47) return save.ammoArrow;
	if (index === 48) return save.oil;
	return save.electric;
}

function setAmmoArray(save: PlayerSaveData, index: number, value: number): void {
	const v = math.max(0, value);
	if (index === 44) save.ammoNormal = v;
	else if (index === 45) save.ammoShotgun = v;
	else if (index === 46) save.ammoMachinegun = v;
	else if (index === 47) save.ammoArrow = v;
	else if (index === 48) save.oil = v;
	else save.electric = v;
}

export function countItem(save: PlayerSaveData, kind: number, index: number): number {
	if (kind === ItemKind.Weapon) return save.invenWeapon[index] ?? 0;
	if (kind === ItemKind.Equip) return save.invenEquip[index] ?? 0;
	if (kind === ItemKind.Use) return save.invenUse[index] ?? 0;
	if (kind === ItemKind.Etc) {
		if (index >= 44 && index <= 48) return ammoArray(save, index);
		return save.invenEtc[index] ?? 0;
	}
	return 0;
}

export function addItem(save: PlayerSaveData, kind: number, index: number, count: number): void {
	if (count <= 0) return;
	if (kind === ItemKind.Weapon) {
		save.invenWeapon[index] = (save.invenWeapon[index] ?? 0) + count;
	} else if (kind === ItemKind.Equip) {
		save.invenEquip[index] = (save.invenEquip[index] ?? 0) + count;
	} else if (kind === ItemKind.Use) {
		save.invenUse[index] = (save.invenUse[index] ?? 0) + count;
	} else if (kind === ItemKind.Etc) {
		if (index >= 44 && index <= 48) {
			setAmmoArray(save, index, ammoArray(save, index) + count);
		} else {
			save.invenEtc[index] = (save.invenEtc[index] ?? 0) + count;
		}
	}
}

export function removeItem(save: PlayerSaveData, kind: number, index: number, count: number): boolean {
	if (count <= 0) return true;
	if (countItem(save, kind, index) < count) return false;
	if (kind === ItemKind.Weapon) {
		save.invenWeapon[index] = (save.invenWeapon[index] ?? 0) - count;
	} else if (kind === ItemKind.Equip) {
		save.invenEquip[index] = (save.invenEquip[index] ?? 0) - count;
	} else if (kind === ItemKind.Use) {
		save.invenUse[index] = (save.invenUse[index] ?? 0) - count;
	} else if (kind === ItemKind.Etc) {
		if (index >= 44 && index <= 48) {
			setAmmoArray(save, index, ammoArray(save, index) - count);
		} else {
			save.invenEtc[index] = (save.invenEtc[index] ?? 0) - count;
		}
	}
	return true;
}

/**
 * Takes off whatever the survivor holds or wears but no longer owns -- what a craft just ate: the pistol that became
 * an auto pistol, the steel armour inside a robot suit, the flashlight inside a laser sight. Without this the slot
 * kept pointing at an item the backpack no longer had: the armour went on protecting and the pistol stayed in the
 * client's hands until a report reached the server, whose `enforceSaveInvariants` then quietly took them away.
 *
 * The weapon goes back to -1 (the default blade, as `enforceSaveInvariants` leaves it); a cosmetic unlocked by a
 * costume is still owned (`ownsEquip`) and stays on. Returns true when the weapon in hand was the one that went, so
 * the client can put the blade in the survivor's hands (client/main.client.ts `pack.onCraft`).
 */
export function unequipGone(save: PlayerSaveData): boolean {
	let weaponGone = false;
	if (save.equipWeapon >= 0 && !ownsWeapon(save, save.equipWeapon)) {
		save.equipWeapon = -1;
		weaponGone = true;
	}
	for (let slot = 1; slot <= EQUIP_SLOT_MAX; slot++) {
		const id = equippedIn(save, slot);
		if (id >= 0 && !ownsEquip(save, id)) setEquipped(save, slot, -1);
	}
	return weaponGone;
}
