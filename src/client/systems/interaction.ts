import { DESIGN } from "shared/engine/constants";
import { rndRange } from "shared/engine/rng";
import type { PlayerState } from "shared/game/player";
import { GroundItem, Solid, querySolids, removeGroundItem, spawnGroundItem } from "shared/game/world";
import { gameHours } from "shared/sim/clock";
import { addItem, countItem, removeItem } from "shared/sim/inventory";
import {
	isContainer,
	lootRespawnHours,
	mapItemLoot,
	rollBuildingLoot,
	rollMapItemDrop,
	rollYardLoot,
	thiefFind,
} from "shared/sim/loot";
import {
	bodiesOverlapRect,
	canRepair,
	edgeDist,
	holdsLoot,
	InteractTarget,
	interactTarget,
	isFire,
	isPump,
	isYardContainer,
	nearestGroundItem,
	nearestUsableSolid,
	repairMaterial,
} from "shared/sim/interactQuery";
import {
	hasVaultTool,
	isVaultDoor,
	VAULT_CRACK_S,
	VAULT_GRACE_S,
	VAULT_TOOL_INDEX,
	VAULT_TOOL_KIND,
} from "shared/sim/vault";
import { engineRuns, isRideable, vehicleBroken, vehicleDef, vehicleKindOfSolid } from "shared/sim/vehicle";
import {
	itemCap,
	noRoomIn,
	pickupRoom,
	WALK_PICKUP_DELAY_S,
	WALK_PICKUP_RATE_S,
	walkPickupTarget,
} from "shared/sim/pickupRule";
import { langGet } from "shared/data/lang";
import { flinch } from "../view/solidFlinch";
import { serverOwnsWorld } from "../net/authority";
import { itemName } from "./craftSystem";
import { machineHint } from "./machineHints";
import { gained, pressed, survivorAt, took } from "./pickups";
import { fxMessage, GameRefs } from "./types";

/*
 * Using the world with E: pick up, open/close, light, shake a tree, search a car/bin, drain a gas pump, repair, loot a
 * building.
 * WHAT is in reach is a pure query (shared/sim/interactQuery.ts); this file applies the effect on the world and the
 * backpack of the survivor that pressed E (docs/MULTIPLAYER.md §11.2 → server/sim/interaction.ts in F3).
 *
 * From WORLD_SERVER_PHASE (client/net/authority.ts) none of it runs here: the E press rides the input command and
 * server/sim/interaction.ts applies it; the doors, the items, the loot flags and the fires come back as world deltas
 * (client/net/worldMirror.ts) and the backpack as the wallet's bag. Only the hint is still this client's.
 */

/** cooldown (seconds left) per map item (tree/car/trash) since its last hit */
const hitCooldowns = new Map<Solid, number>();

/** spawn point: nearest point of the solid's rect to the survivor, pushed 24px further out towards them */
function spawnFromSolid(refs: GameRefs, by: PlayerState, s: Solid, kind: number, index: number, count: number): void {
	const qx = math.clamp(by.x, s.x, s.x + s.w);
	const qy = math.clamp(by.y, s.y, s.y + s.h);
	let dx = by.x - qx;
	let dy = by.y - qy;
	let dist = math.sqrt(dx * dx + dy * dy);
	if (dist < 1e-3) {
		// survivor exactly on the rect edge: fall back to pushing away from its centre
		dx = qx - (s.x + s.w / 2);
		dy = qy - (s.y + s.h / 2);
		dist = math.sqrt(dx * dx + dy * dy);
		if (dist < 1e-3) {
			dx = 1;
			dy = 0;
			dist = 1;
		}
	}
	const nx = dx / dist;
	const ny = dy / dist;
	const sx = qx + nx * 24;
	const sy = qy + ny * 24;
	const angle = math.atan2(ny, nx) + rndRange(-0.6, 0.6);
	const speed = rndRange(60, 150);
	spawnGroundItem(refs.world, kind, index, count, sx, sy, math.cos(angle) * speed, math.sin(angle) * speed);
}

/**
 * A melee/ranged hit lands on a map item (tree/car/trash). Own cooldown per solid
 * (DESIGN.MAP_ITEM_HIT_TIME); while on cooldown this is a no-op. Otherwise shakes the sprite and,
 * with DESIGN.MAP_ITEM_PERCENT% chance, drops loot from the object's table at `by`'s side.
 */
export function hitMapItem(refs: GameRefs, s: Solid, choppingTool: boolean, by: PlayerState = refs.player): boolean {
	const cd = hitCooldowns.get(s);
	if (cd !== undefined && cd > 0) return false;
	hitCooldowns.set(s, DESIGN.MAP_ITEM_HIT_TIME);
	flinch(s, 0.25);
	// the shared table and roll (shared/sim/loot.ts): the server's hitMapItem rolls the very same
	if (mapItemLoot(s) === undefined) return true;
	const drop = rollMapItemDrop(s, choppingTool);
	if (drop !== undefined) spawnFromSolid(refs, by, s, drop.kind, drop.index, drop.count);
	return true;
}

/** absolute game clock in hours — building loot respawn timestamps */
function worldHours(refs: GameRefs): number {
	return gameHours(refs.daynight.day, refs.daynight.dayTime);
}

// --- fires (campfire / brazier) burn wood -------------------------------------------------------

/**
 * How often the lazy loot sweep runs. It is NOT per frame: a survivor cannot cross the 320 u trigger radius
 * in half a second, and the sweep is a grid query per survivor. Same cadence as the authoritative version
 * (`LOOT_SWEEP_S`, server/sim/items.ts).
 */
const LOOT_SWEEP_S = 0.5;

/** obj_campfire: 1000 wood burning 0.1/frame → ~5.5 min of fire; relighting costs 5 wood */
const FIRE_TIME = 1000 / 0.1 / 30;
const FIRE_WOOD = 5;
const WOOD_INDEX = 23;
/** ETC index of oil: the motorcycle's fuel (VEI-05) */
const OIL_INDEX = 48;
/** seconds of fire left per campfire/brazier (absent = freshly built, full) */
const fireFuel = new Map<Solid, number>();
let fireTick = 0;
const fireBuf: Array<Solid> = [];

function fuelOf(s: Solid): number {
	return fireFuel.get(s) ?? FIRE_TIME;
}

/**
 * E on a light: lamps just switch; a fire goes out / relights while it still has wood, and an
 * empty fire takes 5 wood from the backpack. Returns a message when it cannot be lit.
 */
function toggleLight(refs: GameRefs, by: PlayerState, s: Solid): string | undefined {
	if (!isFire(s)) {
		s.powered = !(s.powered ?? false);
		return undefined;
	}
	if (s.powered === true) {
		s.powered = false;
		return undefined;
	}
	if (fuelOf(s) <= 0) {
		if (countItem(refs.save, 4, WOOD_INDEX) < FIRE_WOOD) {
			return `Missing: ${itemName(4, WOOD_INDEX)} ${math.floor(countItem(refs.save, 4, WOOD_INDEX))}/${FIRE_WOOD}`;
		}
		removeItem(refs.save, 4, WOOD_INDEX, FIRE_WOOD);
		fireFuel.set(s, FIRE_TIME);
	}
	s.powered = true;
	return undefined;
}

/** burn the fires around the player; an empty one goes out (and stops lighting / smelting) */
function burnFires(refs: GameRefs, dt: number): void {
	fireTick += dt;
	if (fireTick < 0.5) return;
	const step = fireTick;
	fireTick = 0;
	const p = refs.player;
	// reused: this box covers a hundred grid cells, so the result table is the expensive part
	for (const s of querySolids(refs.world, p.x - 2500, p.y - 2500, p.x + 2500, p.y + 2500, fireBuf)) {
		if (!isFire(s) || s.powered !== true) continue;
		const left = fuelOf(s) - step;
		fireFuel.set(s, left);
		if (left <= 0) {
			fireFuel.set(s, 0);
			s.powered = false;
		}
	}
	fireBuf.clear();
	for (const [s] of fireFuel) {
		if (s.removed === true) fireFuel.delete(s);
	}
}

/**
 * The offline pickup: what fits under the save's ceiling (shared/sim/pickupRule.ts) goes into the backpack, the rest
 * stays on the ground -- the server's own rule (server/sim/items.ts `pickup`). Answers how many were taken.
 */
function takeItem(refs: GameRefs, it: GroundItem): number {
	const take = math.min(it.count, pickupRoom(refs.save, it.kind, it.itemId));
	if (take <= 0) return 0;
	addItem(refs.save, it.kind, it.itemId, take);
	if (take < it.count) {
		it.count -= take;
		return take;
	}
	removeGroundItem(refs.world, it);
	return take;
}

/**
 * the shared roll (shared/sim/loot.ts), the one server/sim/items.ts rollLoot makes: a pump its fuel (EDI-16), a market
 * stall, a pile or a shed its own table (EDI-20..MOB-06)
 */
function rollLoot(s: Solid): void {
	s.lootItems = isYardContainer(s) ? rollYardLoot(s) : rollBuildingLoot(s.buildingType ?? 0, s.lootSlots ?? 2);
}

/**
 * The pill at the everyday town's searchable fixtures (EDI-20, EDI-21, MOB-06; LEG-01): what E does there, while this
 * client knows it holds something -- the same rule as a pump island's.
 */
const YARD_HINTS: Record<string, string> = {
	stall: "E: Search stall",
	foodtruck: "E: Search food truck",
	pile: "E: Search pile",
	shed: "E: Search shed",
	// the bank's vault, once cracked (EDI-23)
	vault: "E: Open deposit boxes",
};

// --- the bank's vault (EDI-23, shared/sim/vault.ts) ------------------------------------------------------------

/**
 * This client's own view of the work at a vault door: the door it is at, the seconds of work so far, and the seconds
 * since E was last held or pressed there. The SERVER counts the real work (server/sim/vault.ts) by the same rules --
 * E held, or pressed again within VAULT_GRACE_S, with a crowbar, at the door -- so the two agree to a few ticks; the
 * door opening is the server's DoorSet, never this.
 */
let vaultAt: Solid | undefined;
let vaultWork = 0;
let vaultSince = math.huge;

/** the pill at the vault door: what it needs, what E does, how far the work has gone */
function vaultHint(refs: GameRefs, s: Solid): string | undefined {
	// cracked: it hangs open for good, and E there does nothing
	if (s.open === true) return undefined;
	if (!hasVaultTool(refs.save)) return `Vault: needs ${itemName(VAULT_TOOL_KIND, VAULT_TOOL_INDEX)}`;
	if (vaultAt === s && vaultSince <= VAULT_GRACE_S) {
		const pct = math.floor(math.min(1, vaultWork / VAULT_CRACK_S) * 100);
		return `E: Cracking vault ${pct}%`;
	}
	return "E: Crack vault (hold)";
}

/** the work at a vault door, as this client sees it: E held (or pressed: `tryInteract`), at the door, with the tool */
function stepVaultWork(refs: GameRefs, dt: number): void {
	if (refs.input.keyE) vaultSince = 0;
	else vaultSince += dt;
	const p = refs.player;
	const s = vaultSince <= VAULT_GRACE_S && !p.dead ? nearestUsableSolid(refs.world, p.x, p.y) : undefined;
	if (s === undefined || !isVaultDoor(s) || s.open === true || !hasVaultTool(refs.save)) {
		vaultAt = undefined;
		vaultWork = 0;
		return;
	}
	if (vaultAt !== s) {
		vaultAt = s;
		vaultWork = 0;
	}
	vaultWork += dt;
}

/**
 * The pill at a gas station's pump island (EDI-16, LEG-01): what E does -- drain the fuel left in it into the backpack
 * -- while this client knows it holds some (its own roll offline; the server's LootFlag, which reaches a survivor
 * before they are at the island). A dry island does nothing, and says nothing: the same as an emptied building.
 */
export const PUMP_HINT = "E: Siphon Oil";

function tryRepair(refs: GameRefs, s: Solid): boolean {
	if (!canRepair(s)) return false;
	const mat = repairMaterial(s);
	if (refs.save.invenEtc[mat.index] <= 0) return false;
	refs.save.invenEtc[mat.index] = refs.save.invenEtc[mat.index] - 1;
	const rate = refs.save.skillLevels[17] > 0 ? 0.5 : 0.25;
	s.hp = math.min(s.hpMax, s.hp + s.hpMax * rate);
	return true;
}

const BUILDING_NAMES: Record<string, string> = {
	house: "house",
	gas: "gas station",
	pharmacy: "pharmacy",
	market: "market",
	gunshop: "gun shop",
	cloth: "clothing store",
	restaurant: "restaurant",
	school: "school",
	hospital: "hospital",
	// the campus (EDI-17)
	college: "college hall",
	library: "library",
	lab: "science lab",
	dorm: "dorm",
	// the everyday town (EDI-18)
	hardware: "hardware store",
	autorepair: "auto repair shop",
	electronics: "electronics store",
	bakery: "bakery",
	pawn: "pawn shop",
	postoffice: "post office",
	bank: "bank",
	church: "church",
	firestation: "fire station",
	police: "police station",
	office: "offices",
};

/** "E: Repair (Steel)", or what is missing for it */
function repairHint(refs: GameRefs, s: Solid): string {
	const mat = repairMaterial(s);
	const have = refs.save.invenEtc[mat.index] ?? 0;
	return have > 0 ? `E: Repair (${itemName(mat.kind, mat.index)})` : `Repair: needs ${itemName(mat.kind, mat.index)}`;
}

/**
 * A parked bicycle or motorcycle (VEI-05). The SERVER decides the ride (server/sim/vehicles.ts runs this same
 * target query at its own position), so the hint only promises what it will grant: a vehicle it put in the world,
 * not broken, and for the motorcycle, oil in the backpack.
 */
function vehicleHint(refs: GameRefs, s: Solid): string | undefined {
	if (!isRideable(s)) return undefined;
	if (vehicleBroken(s)) return repairHint(refs, s);
	const def = vehicleDef(vehicleKindOfSolid(s));
	if (def !== undefined && !engineRuns(def, refs.save)) return `${def.name}: needs ${itemName(4, OIL_INDEX)}`;
	return "E: Ride";
}

/** mounted: E gets off; on the motorcycle the backpack's oil is the fuel gauge (the original's vehicle panel) */
function rideHint(refs: GameRefs, by: PlayerState): string {
	const def = by.ride !== undefined ? vehicleDef(by.ride.kind) : undefined;
	if (def === undefined || def.oilFull <= 0) return "E: Get off";
	const oil = math.floor(refs.save.oil);
	return oil > 0 ? `E: Get off · ${itemName(4, OIL_INDEX)} ${oil}` : `E: Get off · No ${itemName(4, OIL_INDEX)}`;
}

/** the hint text for a target the survivor could use, or undefined when it does nothing */
function hintFor(refs: GameRefs, target: InteractTarget): string | undefined {
	if (target.kind === "item") {
		const it = target.item;
		const lang = refs.save.settings.langType;
		const n = langGet(itemName(it.kind, it.itemId), lang);
		hinted = it.id;
		const verb = langGet("Pick up", lang);
		return it.count > 1 ? `E: ${verb} ${n} ×${it.count}` : `E: ${verb} ${n}`;
	}
	if (target.kind === "door") {
		const s = target.solid;
		if (isVaultDoor(s)) return vaultHint(refs, s);
		if (s.open === true) {
			return bodiesOverlapRect(s, refs.players, refs.zombies) ? undefined : "E: Close door";
		}
		return "E: Open door";
	}
	// an electric build, where the server owns the grid: its own job first (ELE-03), the ordinary hint if none
	if (target.kind === "light" || target.kind === "solid") {
		const m = machineHint(refs.save, target.solid);
		if (m !== undefined) return m;
	}
	if (target.kind === "light") {
		const s = target.solid;
		const lamp = s.tags === "lamp" || s.tags === "lamp_drone";
		// lit or not is the server's word in a server-owned world (LightSet mirrors `powered`, client/net/worldMirror.ts)
		if (s.powered === true) return lamp ? "E: Turn off" : "E: Put out";
		// ...but how much wood a fire has left is not on the wire (LightSet carries only on/off, and a fire the server put
		// out for want of wood looks like one somebody put out): there `fuelOf` is the full fire it was built as, and a
		// dry fire shows "E: Light" where relighting costs FIRE_WOOD. Needs a wire change (docs/MULTIPLAYER.md §4.5)
		if (isFire(s) && fuelOf(s) <= 0) return `E: Light (${FIRE_WOOD} ${itemName(4, WOOD_INDEX)})`;
		return lamp ? "E: Turn on" : "E: Light";
	}
	if (target.kind === "mapItem") {
		const s = target.solid;
		if (s.kind === "tree") return "E: Shake tree";
		return s.tags === "car" ? "E: Search car" : "E: Search trash";
	}
	if (target.kind === "vehicle") return vehicleHint(refs, target.solid);
	if (target.kind === "pump") {
		if (!holdsLoot(target.solid)) return undefined;
		return isPump(target.solid) ? PUMP_HINT : (YARD_HINTS[target.solid.tags] ?? "E: Search");
	}
	if (target.kind === "solid") {
		const s = target.solid;
		if (!canRepair(s)) return undefined;
		return repairHint(refs, s);
	}
	const b = target.building;
	return `E: Search ${BUILDING_NAMES[b.tags] ?? b.tags}`;
}

/** the ground item the last `interactHint` promised E takes, or -1 (client/view/groundItemsView.ts brackets it) */
let hinted = -1;

export function hintedItem(): number {
	return hinted;
}

/**
 * What the action button (E) would do right now, for the HUD — same priority as tryInteract.
 * undefined = nothing to do (hide the button).
 */
export function interactHint(refs: GameRefs, by: PlayerState = refs.player): string | undefined {
	hinted = -1;
	// on a vehicle E means one thing, whatever is in reach (server/sim/vehicles.ts takes the press first)
	if (by.ride !== undefined) return rideHint(refs, by);
	if (refs.pendingPlace >= 0) return undefined;
	// the server's query, full stacks passed over (ITM-07): a full stack never hides the door or the search behind it
	const target = interactTarget(refs.world, by.x, by.y, noRoomIn(refs.save));
	if (target === undefined) return fullHint(refs, by);
	return hintFor(refs, target);
}

/**
 * Nothing E can do is in reach, but an item is: every one in reach is full (the save's ceiling, ITM-07). Said, not
 * promised: no "E:", and nothing marked.
 */
function fullHint(refs: GameRefs, by: PlayerState): string | undefined {
	const it = nearestGroundItem(refs.world, by.x, by.y);
	if (it === undefined) return undefined;
	const lang = refs.save.settings.langType;
	return `${langGet(itemName(it.kind, it.itemId), lang)} ${langGet("full", lang)} (${itemCap(it.kind, it.itemId)})`;
}

export class Interaction {
	/** seconds until the next loot sweep, and the buffer it reuses */
	private lootSweep = 0;
	private readonly lootBuf: Array<Solid> = [];

	tryInteract(refs: GameRefs, by: PlayerState = refs.player): void {
		// mounted, E gets off -- and that, like getting on, is the server's (server/sim/vehicles.ts)
		if (refs.pendingPlace >= 0 || by.ride !== undefined) return;
		// what the hint named and what the server will pick: full stacks passed over (ITM-07)
		const target = interactTarget(refs.world, by.x, by.y, noRoomIn(refs.save));
		if (target === undefined) {
			// only full items in reach: offline, say so where the survivor stands (online the HUD's line already does)
			const it = serverOwnsWorld() ? undefined : nearestGroundItem(refs.world, by.x, by.y);
			if (it !== undefined) {
				fxMessage(refs, `${itemName(it.kind, it.itemId)} full (${itemCap(it.kind, it.itemId)})`, by);
			}
			return;
		}
		// a press at a bank's vault door keeps the work going, as E held does (EDI-23: a touch screen taps)
		if (target.kind === "door" && isVaultDoor(target.solid)) vaultSince = 0;
		if (serverOwnsWorld()) {
			// F3: the press is already on its way in the command's action edge, and the server picks the target itself.
			// What it reached here is remembered, so the server's answer can be told for a pickup (./pickups.ts)
			if (target.kind === "item") pressed("item", by.x, by.y);
			else if (target.kind === "search") pressed("loot", by.x, by.y);
			else if (target.kind === "pump" && holdsLoot(target.solid)) pressed("loot", by.x, by.y);
			return;
		}
		if (target.kind === "vehicle") return;
		if (target.kind === "item") {
			const it = target.item;
			const got = takeItem(refs, it);
			if (got > 0) took(it.kind, it.itemId, got);
			else fxMessage(refs, `${itemName(it.kind, it.itemId)} full (${itemCap(it.kind, it.itemId)})`, by);
			return;
		}
		if (target.kind === "door") {
			const s = target.solid;
			// the vault is the server's (EDI-23, server/sim/vault.ts): offline it stays shut
			if (isVaultDoor(s)) return;
			const willOpen = !(s.open ?? false);
			if (!willOpen && bodiesOverlapRect(s, refs.players, refs.zombies)) return;
			s.open = willOpen;
			// the sound the server's own door plays (server/sim/interaction.ts), on this client's own world
			const iron = s.kind === "iron_door";
			const sound = willOpen ? (iron ? "ironDoorOpen" : "doorOpen") : iron ? "ironDoorClose" : "doorClose";
			refs.fx.push({ kind: "sound", sound, x: s.x + s.w / 2, y: s.y + s.h / 2 });
			return;
		}
		if (target.kind === "light") {
			const why = toggleLight(refs, by, target.solid);
			if (why !== undefined) fxMessage(refs, why, by);
			return;
		}
		if (target.kind === "mapItem") {
			hitMapItem(refs, target.solid, false, by);
			return;
		}
		if (target.kind === "pump") {
			// the server's `drain`, offline: everything in it, the island dry until its respawn (no Thief: not a building)
			const pump = target.solid;
			const fuel = pump.lootItems;
			if (fuel === undefined || fuel.size() === 0) return;
			for (const drop of fuel) addItem(refs.save, drop.kind, drop.id, drop.count);
			took();
			pump.lootItems = [];
			pump.lootTimer = worldHours(refs) + lootRespawnHours(pump);
			return;
		}
		if (target.kind === "solid") {
			tryRepair(refs, target.solid);
			return;
		}
		const b = target.building;
		const loot = b.lootItems;
		if (loot === undefined) return;
		for (const drop of loot) {
			addItem(refs.save, drop.kind, drop.id, drop.count);
			gained(drop.kind, drop.id, drop.count);
		}
		// Thief: one more slot of this building's table, for this searcher alone (shared/sim/loot.ts)
		const extra = thiefFind(refs.save, b.buildingType ?? 0);
		if (extra !== undefined) {
			addItem(refs.save, extra.kind, extra.id, extra.count);
			gained(extra.kind, extra.id, extra.count);
		}
		if (loot.size() > 0 || extra !== undefined) took();
		b.lootItems = [];
		// respawn after ITEM_RESPAWN_HOURS of GAME time (was 12 real hours, i.e. never)
		b.lootTimer = worldHours(refs) + DESIGN.ITEM_RESPAWN_HOURS;
	}

	update(refs: GameRefs, dt: number): void {
		// where this survivor is: a supply the server takes from under their feet is theirs (./pickups.ts)
		survivorAt(refs.player.x, refs.player.y);
		// the work at a bank's vault door, for the pill (EDI-23)
		stepVaultWork(refs, dt);
		// F3: the fires burn on the server (LightSet), and the loot is rolled there (LootFlag); the walk-over too
		if (serverOwnsWorld()) return;
		this.walkOver(refs, dt);
		burnFires(refs, dt);
		for (const [solid, t] of hitCooldowns) {
			if (solid.removed === true) {
				hitCooldowns.delete(solid);
				continue;
			}
			const nt = t - dt;
			if (nt <= 0) {
				hitCooldowns.delete(solid);
			} else {
				hitCooldowns.set(solid, nt);
			}
		}
		this.rollNearbyLoot(refs, dt);
	}

	/**
	 * Offline, the supplies under the survivor's feet are walked up here, by the server's rule (shared/sim/pickupRule.ts,
	 * server/sim/items.ts `walkOver`): once lying WALK_PICKUP_DELAY_S, one every WALK_PICKUP_RATE_S, what fits.
	 */
	private walkOver(refs: GameRefs, dt: number): void {
		this.clock += dt;
		const born = this.born;
		for (const it of refs.world.items) {
			if (!born.has(it.id)) born.set(it.id, this.clock);
		}
		if (this.clock < this.walkNext) return;
		this.walkNext = this.clock + WALK_PICKUP_RATE_S;
		// the table forgets the items that are gone, once it holds many more than the world
		if (born.size() > refs.world.items.size() * 2 + 32) {
			const live = new Set<number>();
			for (const it of refs.world.items) live.add(it.id);
			for (const [id] of born) if (!live.has(id)) born.delete(id);
		}
		const p = refs.player;
		if (p.dead || p.ride !== undefined) return;
		const it = walkPickupTarget(refs.world, p.x, p.y, refs.save, this.walkReady);
		if (it === undefined) return;
		const got = takeItem(refs, it);
		if (got > 0) took(it.kind, it.itemId, got);
	}

	/** offline walk-over: its clock, when each item was first seen, and when the next one may be taken */
	private clock = 0;
	private readonly born = new Map<number, number>();
	private walkNext = 0;
	/** has this item lain WALK_PICKUP_DELAY_S since this client first saw it? (bound once: no closure a check) */
	private readonly walkReady = (item: GroundItem): boolean =>
		this.clock - (this.born.get(item.id) ?? this.clock) >= WALK_PICKUP_DELAY_S;

	/*
	 * Loot is rolled lazily, when a survivor comes near a building that has none — but "near" was tested
	 * EVERY FRAME, with a fresh 640 x 640 grid query (and a fresh result table) per survivor. In a dense
	 * block that is a few hundred solid visits and one throwaway array sixty times a second, for a question
	 * whose answer changes at walking pace: it is a slow, steady cost that grows as the player explores into
	 * denser parts of town, which is exactly what it felt like.
	 *
	 * Twice a second is more often than a survivor can cross 320 units, and it is the same cadence the
	 * authoritative version uses (LOOT_SWEEP_S in server/sim/items.ts). The scratch buffer is reused, so the
	 * sweep stops allocating at all.
	 */
	private rollNearbyLoot(refs: GameRefs, dt: number): void {
		this.lootSweep -= dt;
		if (this.lootSweep > 0) return;
		this.lootSweep = LOOT_SWEEP_S;
		const radius = 320;
		const now = worldHours(refs);
		for (const p of refs.players) {
			const found = querySolids(refs.world, p.x - radius, p.y - radius, p.x + radius, p.y + radius, this.lootBuf);
			for (const s of found) {
				if (!isContainer(s)) continue;
				const loot = s.lootItems;
				if (loot === undefined || loot.size() > 0) continue;
				if (now < (s.lootTimer ?? 0)) continue;
				if (edgeDist(s, p.x, p.y) >= radius) continue;
				rollLoot(s);
			}
			this.lootBuf.clear();
		}
	}
}
