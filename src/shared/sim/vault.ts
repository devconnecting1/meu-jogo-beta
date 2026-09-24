/*
 * The bank's vault (docs/DESIGN_RULES.md EDI-24): what it takes to open it, and what that costs.
 *
 * The bank (shared/game/townLots.ts placeBank, one a town, on Main Street by the avenues' crossing) keeps its best
 * behind a steel door (world.ts `bankVault`, a door solid tagged "vault"). Nobody opens it with a hand: it takes a
 * CROWBAR in the backpack (WEAPONS 3: the hardware store and the auto repair shop sell one, a desk makes one from ten
 * steel) and VAULT_CRACK_S of work at the door -- E held (the command's `held` Action bit, already on the wire), or E
 * pressed again and again within VAULT_GRACE_S (a touch screen's USE button, a mouse's right button). Let go for
 * longer and the bolts seat again: the work starts over. Prying steel is LOUD: every VAULT_WORK_PERIOD a ring of
 * VAULT_WORK_NOISE (a construction going up, shared/sim/ai/noise.ts BUILD) goes out from the door.
 *
 * When the door gives, it swings open for good (a DoorSet, global like any door; a cracked vault never shuts again, so
 * "open" IS "cracked" for a survivor who joins later), a bang of VAULT_OPEN_NOISE, and the ALARM: the bell under the
 * bank's portico rings for VAULT_ALARM_S -- its `powered` on, the LightSet of any lamp, global -- and every
 * VAULT_ALARM_PERIOD a ring of VAULT_ALARM_RADIUS goes out from the bank's front: the horde of two blocks round comes
 * to look, and keeps coming while it rings. Inside, the deposit boxes (spawns.ts VAULT_LOOT) are the best of the bank,
 * once a town (loot.ts `lootRespawnHours`). A risk taken for a reward, the Dead Town way.
 *
 * All of it is the SERVER's (server/sim/vault.ts); nothing new travels: the held bit, DoorSet, LightSet, LootFlag and
 * the Fx sounds a door already makes. A client shows its own hold's progress (client/systems/interaction.ts) and
 * rings the bell it is told about (client/audio/bankAlarm.ts). Pure: numbers and predicates, no Instances.
 */
import type { PlayerSaveData } from "shared/game/save";
import { buildingAt, Solid, WorldData } from "shared/game/world";
import { countItem } from "./inventory";

/** the bank's building type (shared/data/buildings.ts BuildingType.Bank) */
export const BANK_TYPE = 22;
/** the tag of the vault door (kind "iron_door") and of the vault's deposit boxes (kind "prop") */
export const VAULT_TAG = "vault";
/** the tag of the bank's portico (kind "canopy"), which carries the alarm bell */
export const PORTICO_TAG = "portico";
/** the tool the door needs in the backpack: a crowbar (item kind 1, WEAPONS 3) */
export const VAULT_TOOL_KIND = 1;
export const VAULT_TOOL_INDEX = 3;
/** seconds of work at the door to crack it */
export const VAULT_CRACK_S = 10;
/** the work stops when neither E is held nor pressed for this long; the bolts seat again and it starts over */
export const VAULT_GRACE_S = 0.5;
/** a ring of noise every this many seconds of work, this loud (a construction going up: noise.ts BUILD) */
export const VAULT_WORK_PERIOD = 1;
export const VAULT_WORK_NOISE = 450;
/** the door giving way: a bang heard as far as a pistol shot (noise.ts GUNSHOT) */
export const VAULT_OPEN_NOISE = 800;
/** the alarm: how long the bell rings, how often its ring goes out, and how far it is heard */
export const VAULT_ALARM_S = 90;
export const VAULT_ALARM_PERIOD = 2;
export const VAULT_ALARM_RADIUS = 1600;

/** the vault's steel door (EDI-24) */
export function isVaultDoor(s: Solid): boolean {
	return s.kind === "iron_door" && s.tags === VAULT_TAG;
}

/** the vault's deposit boxes: a container searched like a market stall, once a town */
export function isVaultBox(s: Solid): boolean {
	return s.kind === "prop" && s.tags === VAULT_TAG;
}

/** the bank's portico, where the alarm bell hangs (`powered`: ringing) */
export function isPortico(s: Solid): boolean {
	return s.kind === "canopy" && s.tags === PORTICO_TAG;
}

/**
 * Is (x, y) inside the vault of the bank `bankId`? The deposit boxes are within reach from there only (EDI-24): the E
 * query, the hint and the server's LootFlag all ask it, so a survivor behind the vault's back wall, or in the office
 * beside it, is never told of the boxes nor able to empty them through the wall.
 */
export function inVaultOf(world: WorldData, bankId: number | undefined, x: number, y: number): boolean {
	if (bankId === undefined) return false;
	const b = buildingAt(world, x, y);
	return b !== undefined && b.id === bankId && inVault(b, x, y);
}

/** is (x, y) inside any bank's vault? (nothing spawns there: a shut vault is sealed, EDI-24) */
export function inAnyVault(world: WorldData, x: number, y: number): boolean {
	const b = buildingAt(world, x, y);
	return b !== undefined && inVault(b, x, y);
}

/** is (x, y) inside the vault of this building (a bank's vault room: world.ts `bankVault`)? */
export function inVault(b: Solid, x: number, y: number): boolean {
	const rooms = b.rooms;
	if (b.buildingType !== BANK_TYPE || rooms === undefined) return false;
	for (const r of rooms) {
		if (r.kind === "vault" && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
	}
	return false;
}

/** does this backpack hold what the vault door needs? */
export function hasVaultTool(save: PlayerSaveData): boolean {
	return countItem(save, VAULT_TOOL_KIND, VAULT_TOOL_INDEX) > 0;
}
