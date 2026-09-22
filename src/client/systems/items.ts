import { ItemKind } from "shared/data/kinds";
import { PlayerSaveData } from "shared/game/save";

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
