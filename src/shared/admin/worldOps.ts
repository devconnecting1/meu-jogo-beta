import { DESIGN, TOWN } from "shared/engine/constants";
import { zombieDef } from "shared/data/zombies";
import { ItemKind } from "shared/data/kinds";
import { EQUIPS } from "shared/data/equips";
import { difficultyOfDay } from "shared/game/save";
import { ZombieState } from "shared/game/entities";
import { circleBlocked } from "shared/game/physics";
import { Solid, WorldData } from "shared/game/world";
import { VehicleKind } from "shared/data/buildings";
import { vehicleKindOfSolid } from "shared/sim/vehicle";
import { FREECAM_MAX_RANGE, MAX_BOSSES, MAX_ZOMBIES_ADMIN } from "shared/net/mpConfig";
import { ItemGroup, isAmmoEtcId, itemGroupSize, itemMax } from "./ops";

/*
 * The admin's WORLD tools as requests (docs/MULTIPLAYER.md §10, F6-6B). From MP_PHASE 2 the server owns the world, so
 * a spawn, the clock, god mode or a teleport made on the admin's own client was overwritten a tick later -- and still
 * toasted "done". Every one of them is now an `AdminRequest { kind: "world", op }` that the SERVER validates and runs
 * on the world it owns (server/admin/adminWorld.ts), through the same remote, the same UserId check, the same rate
 * limit and the same audit log as every other admin request; the panel toasts success only on the server's OK.
 *
 * What lives here is what both sides must agree on: the catalogues (what can be spawned or built), the limits, the
 * strict reader of an untrusted op, and the small pure helpers both the panel's preview and the server use (the free
 * point around a click, the walker variants). Nothing here trusts the client: an admin's request is validated like
 * anyone's payload (§8.3), only the authorization differs.
 */

export type SpawnKind =
	"walker" | "fast" | "big" | "spitter" | "exploder" | "charger" | "jumper" | "boss1" | "boss2" | "boss3" | "boss4";

export interface SpawnKindInfo {
	kind: SpawnKind;
	label: string;
	boss: boolean;
	/** ZombieType (1..5) of a zombie, or the boss type (1..4) of a boss */
	type: number;
}

export const SPAWN_KINDS: Array<SpawnKindInfo> = [
	{ kind: "walker", label: "Walker", boss: false, type: 1 },
	{ kind: "fast", label: "Fast walker", boss: false, type: 1 },
	{ kind: "big", label: "Big walker", boss: false, type: 1 },
	{ kind: "spitter", label: "Spitter", boss: false, type: 2 },
	{ kind: "exploder", label: "Exploder", boss: false, type: 3 },
	{ kind: "charger", label: "Charger", boss: false, type: 4 },
	{ kind: "jumper", label: "Jumper", boss: false, type: 5 },
	{ kind: "boss1", label: "Boss 1 · Centipede", boss: true, type: 1 },
	{ kind: "boss2", label: "Boss 2 · Rafflesia", boss: true, type: 2 },
	{ kind: "boss3", label: "Boss 3 · Giant", boss: true, type: 3 },
	{ kind: "boss4", label: "Boss 4 · Hedgehog", boss: true, type: 4 },
];

export function spawnKindInfo(kind: unknown): SpawnKindInfo | undefined {
	if (!typeIs(kind, "string")) return undefined;
	return SPAWN_KINDS.find(k => k.kind === kind);
}

export type StructureKind =
	| "barricade"
	| "steelBarricade"
	| "door"
	| "lamp"
	| "campfire"
	| "brazier"
	| "turret"
	| "electricTurret"
	| "trap"
	| "craftDesk";

/** PLACEABLES id (shared/sim/placement.ts) of every structure the panel can place */
export const STRUCTURE_KINDS: Array<{ kind: StructureKind; label: string; placeable: number }> = [
	{ kind: "barricade", label: "Barricade", placeable: 10 },
	{ kind: "steelBarricade", label: "Steel barricade", placeable: 12 },
	{ kind: "door", label: "Wooden door", placeable: 11 },
	{ kind: "lamp", label: "Lamp", placeable: 4 },
	{ kind: "campfire", label: "Campfire", placeable: 14 },
	{ kind: "brazier", label: "Brazier", placeable: 15 },
	{ kind: "turret", label: "Turret", placeable: 2 },
	{ kind: "electricTurret", label: "Electric turret", placeable: 16 },
	{ kind: "trap", label: "Trap", placeable: 17 },
	{ kind: "craftDesk", label: "Craft desk", placeable: 0 },
];

export function structureInfo(kind: unknown): { kind: StructureKind; label: string; placeable: number } | undefined {
	if (!typeIs(kind, "string")) return undefined;
	return STRUCTURE_KINDS.find(s => s.kind === kind);
}

export const ADMIN_WORLD_LIMITS = {
	/** bodies one spawn request places at most */
	SPAWN_PER_REQUEST: 20,
	/** live zombies on the server an admin may push the horde to (§3.5, §10: over MAX_ZOMBIES, never past this) */
	ZOMBIES: MAX_ZOMBIES_ADMIN,
	/** live bosses: the snapshot carries MAX_BOSSES and drops a part with more (shared/net/protocol.ts) */
	BOSSES: MAX_BOSSES,
	/** a kill-all radius (0 = the whole world) */
	KILL_RADIUS_MAX: 6000,
	/** any coordinate further out than this is not a point of any town */
	COORD_ABS_MAX: 100000,
	/** the free camera's point is kept this close to the admin's body (§10) */
	FREECAM_RANGE: FREECAM_MAX_RANGE,
	/** free-camera updates per second (§10: 5/s), on their own bucket so they never starve the panel's requests */
	FREECAM_HZ: 5,
	/** where around a click a spawn looks for free ground */
	FREE_SEARCH: 500,
	/** how far a body that noclip left inside something solid is carried to free ground */
	UNSTICK_SEARCH: 800,
	/** "Remove structure" takes the nearest construction whose footprint is this close to the click */
	REMOVE_REACH: 96,
} as const;

/**
 * An EQUIPS row that is a cosmetic (MON-04: an outfit or a pet, `kind` 4): it is sold for coins in the shop, never
 * dropped by an admin -- a free one on the ground was a shop item for whoever picked it up (the review of 8f50bc5, L2).
 */
export function isCosmeticEquip(index: number): boolean {
	const row = EQUIPS[index];
	return row !== undefined && row.kind >= 4;
}

/** ammo index 5 (electricity) has no ground item; 0..4 are the ETC items 44..48 */
export const AMMO_GROUND_MAX_INDEX = 4;

/** the ItemKind a group's item is dropped as (an ammo pool is an ETC item on the ground) */
export const ITEM_GROUP_KIND: Record<ItemGroup, number> = {
	weapon: ItemKind.Weapon,
	equip: ItemKind.Equip,
	use: ItemKind.Use,
	etc: ItemKind.Etc,
	ammo: ItemKind.Etc,
};

/** the ground item id of a group's index (an ammo pool is an ETC item 44 + index) */
export function groundItemId(group: ItemGroup, index: number): number {
	return group === "ammo" ? 44 + index : index;
}

/** what the server's world tools say about the admin's own survivor (the panel's switches mirror it) */
export interface AdminWorldState {
	god: boolean;
	noclip: boolean;
	ammo: boolean;
	freecam: boolean;
}

/** the `data` of an answered world op */
export interface AdminWorldData {
	state: AdminWorldState;
	/** the caller's own run was marked assisted by THIS op (§9.3: no coins, achievements or records from it) */
	assisted: boolean;
	/** where a teleport, a spawn or the free camera's interest actually landed */
	x?: number;
	y?: number;
}

export type AdminWorldOp =
	/** the caller's switches as the server holds them (read-only, not logged) */
	| { op: "state" }
	| { op: "spawn"; spawn: SpawnKind; count: number; x: number; y: number; chase: boolean }
	/** `radius` 0 = the whole world, else around (x, y) */
	| { op: "killAll"; radius: number; x: number; y: number }
	| { op: "clock"; hour: number }
	| { op: "night" }
	| { op: "dawn" }
	| { op: "wave" }
	| { op: "rain"; on: boolean }
	/** the caller or another survivor in the world */
	| { op: "heal"; userId: number }
	| { op: "god"; on: boolean }
	| { op: "noclip"; on: boolean }
	| { op: "ammo"; on: boolean }
	| { op: "teleport"; x: number; y: number }
	/** blood, acid and corpses, on the server and on every client */
	| { op: "clearFx" }
	| { op: "spawnItem"; group: ItemGroup; index: number; count: number; x: number; y: number }
	| { op: "spawnStructure"; structure: StructureKind; x: number; y: number }
	/** the construction nearest to (x, y), whoever built it (a survivor or an admin) */
	| { op: "removeStructure"; x: number; y: number }
	/** the replication interest of the caller moves to (x, y) while `on` (§10); refreshed by the panel */
	| { op: "freecam"; on: boolean; x: number; y: number };

export type WorldOpName = AdminWorldOp["op"];

const OP_NAMES = new Set<string>([
	"state",
	"spawn",
	"killAll",
	"clock",
	"night",
	"dawn",
	"wave",
	"rain",
	"heal",
	"god",
	"noclip",
	"ammo",
	"teleport",
	"clearFx",
	"spawnItem",
	"spawnStructure",
	"removeStructure",
	"freecam",
]);

const ITEM_GROUPS = new Set<string>(["weapon", "equip", "use", "etc", "ammo"]);

function isNum(v: unknown): v is number {
	return typeIs(v, "number") && v === v && v > -math.huge && v < math.huge;
}

function isInt(v: unknown): v is number {
	return isNum(v) && v % 1 === 0;
}

function isCoord(v: unknown): v is number {
	return isNum(v) && math.abs(v) <= ADMIN_WORLD_LIMITS.COORD_ABS_MAX;
}

/** the op name of an untrusted request, when it is one of ours (for the audit of a refusal) */
export function worldOpName(raw: Record<string, unknown>): string {
	const op = raw.op;
	return typeIs(op, "string") && OP_NAMES.has(op) ? op : "?";
}

/**
 * One untrusted world request → a valid op, or why not (shown to the admin as is). STRICT: a value out of its range
 * is refused, not clamped -- the panel never sends one, so one that arrives was not sent by the panel.
 */
export function readWorldOp(raw: Record<string, unknown>): AdminWorldOp | string {
	const op = raw.op;
	if (!typeIs(op, "string") || !OP_NAMES.has(op)) return "unknown world tool";
	const L = ADMIN_WORLD_LIMITS;
	if (op === "state" || op === "night" || op === "dawn" || op === "wave" || op === "clearFx") {
		return { op } as AdminWorldOp;
	}
	if (op === "spawn") {
		const info = spawnKindInfo(raw.spawn);
		if (info === undefined) return "unknown zombie or boss";
		if (!isInt(raw.count) || raw.count < 1 || raw.count > L.SPAWN_PER_REQUEST) {
			return `count: 1 to ${L.SPAWN_PER_REQUEST}`;
		}
		if (!isCoord(raw.x) || !isCoord(raw.y)) return "invalid point";
		if (!typeIs(raw.chase, "boolean")) return "invalid options";
		return { op, spawn: info.kind, count: raw.count, x: raw.x, y: raw.y, chase: raw.chase };
	}
	if (op === "killAll") {
		if (!isNum(raw.radius) || raw.radius < 0 || raw.radius > L.KILL_RADIUS_MAX) {
			return `radius: 0 (everywhere) to ${L.KILL_RADIUS_MAX}`;
		}
		if (!isCoord(raw.x) || !isCoord(raw.y)) return "invalid point";
		return { op, radius: raw.radius, x: raw.x, y: raw.y };
	}
	if (op === "clock") {
		if (!isNum(raw.hour) || raw.hour < 0 || raw.hour >= 24) return "hour: 0 to 24";
		return { op, hour: raw.hour };
	}
	if (op === "rain" || op === "god" || op === "noclip" || op === "ammo") {
		if (!typeIs(raw.on, "boolean")) return "invalid options";
		return { op, on: raw.on } as AdminWorldOp;
	}
	if (op === "heal") {
		if (!isInt(raw.userId) || raw.userId === 0 || math.abs(raw.userId) >= 1e15) return "invalid player";
		return { op, userId: raw.userId };
	}
	if (op === "teleport") {
		if (!isCoord(raw.x) || !isCoord(raw.y)) return "invalid point";
		return { op, x: raw.x, y: raw.y };
	}
	if (op === "spawnItem") {
		const g = raw.group;
		if (!typeIs(g, "string") || !ITEM_GROUPS.has(g)) return "unknown item group";
		const group = g as ItemGroup;
		if (!isInt(raw.index) || raw.index < 0 || raw.index >= itemGroupSize(group)) return "unknown item";
		if (group === "etc" && isAmmoEtcId(raw.index)) return "unknown item";
		if (group === "equip" && isCosmeticEquip(raw.index)) {
			return "outfits and pets are sold in the shop, not dropped";
		}
		if (group === "ammo" && raw.index > AMMO_GROUND_MAX_INDEX) return "electricity cannot be dropped on the ground";
		if (!isInt(raw.count) || raw.count < 1 || raw.count > itemMax(group)) return `count: 1 to ${itemMax(group)}`;
		if (!isCoord(raw.x) || !isCoord(raw.y)) return "invalid point";
		return { op, group, index: raw.index, count: raw.count, x: raw.x, y: raw.y };
	}
	if (op === "spawnStructure") {
		const info = structureInfo(raw.structure);
		if (info === undefined) return "unknown structure";
		if (!isCoord(raw.x) || !isCoord(raw.y)) return "invalid point";
		return { op, structure: info.kind, x: raw.x, y: raw.y };
	}
	if (op === "removeStructure") {
		if (!isCoord(raw.x) || !isCoord(raw.y)) return "invalid point";
		return { op, x: raw.x, y: raw.y };
	}
	// freecam
	if (!typeIs(raw.on, "boolean")) return "invalid options";
	if (!isCoord(raw.x) || !isCoord(raw.y)) return "invalid point";
	return { op: "freecam", on: raw.on, x: raw.x, y: raw.y };
}

/** the audit line of an op (game-written text only: numbers and catalogue names) */
export function describeWorldOp(o: AdminWorldOp): string {
	const at = (x: number, y: number): string => `(${math.floor(x)}, ${math.floor(y)})`;
	if (o.op === "spawn") {
		return `${spawnKindInfo(o.spawn)?.label ?? o.spawn} ×${o.count} ${o.chase ? "chasing" : "wandering"} at ${at(o.x, o.y)}`;
	}
	if (o.op === "killAll") return o.radius > 0 ? `within ${math.floor(o.radius)} u of ${at(o.x, o.y)}` : "everywhere";
	if (o.op === "clock") {
		const h = math.floor(o.hour);
		return `set to ${string.format("%02d:%02d", h, math.floor((o.hour - h) * 60))}`;
	}
	if (o.op === "rain" || o.op === "god" || o.op === "noclip" || o.op === "ammo" || o.op === "freecam") {
		return o.on ? "on" : "off";
	}
	if (o.op === "teleport") return `to ${at(o.x, o.y)}`;
	if (o.op === "removeStructure") return `near ${at(o.x, o.y)}`;
	if (o.op === "spawnItem") return `${o.group}[${o.index}] ×${o.count} at ${at(o.x, o.y)}`;
	if (o.op === "spawnStructure") return `${structureInfo(o.structure)?.label ?? o.structure} at ${at(o.x, o.y)}`;
	return "";
}

// ---------------------------------------------------------------- pure helpers (panel preview + server)

/**
 * The construction "Remove structure" takes for a click at (x, y): the one whose footprint is nearest, within
 * `reach`, whoever built it (a survivor or an admin). Only constructions (`placeable`): the town's own walls,
 * buildings and trees never are. Never a vehicle: somebody may be riding it. The panel's preview and the server ask
 * the same question.
 */
export function nearestConstruction(world: WorldData, x: number, y: number, reach: number): Solid | undefined {
	let best: Solid | undefined;
	let bestD = reach * reach;
	for (const s of world.solids) {
		if (s.placeable === undefined || s.removed === true) continue;
		if (vehicleKindOfSolid(s) !== VehicleKind.None) continue;
		const qx = math.clamp(x, s.x, s.x + s.w);
		const qy = math.clamp(y, s.y, s.y + s.h);
		const d = (x - qx) * (x - qx) + (y - qy) * (y - qy);
		if (d > bestD) continue;
		bestD = d;
		best = s;
	}
	return best;
}

/** the town inside the border forest, shrunk by `r`: no tool puts anything outside it */
export function townBounds(world: WorldData, r: number): [number, number, number, number] {
	const b = TOWN.BORDER + r;
	return [b, b, world.width - b, world.height - b];
}

/** the nearest point around (x, y) where a circle of radius r fits inside the town (undefined within `search` u) */
export function freePointIn(
	world: WorldData,
	x: number,
	y: number,
	r: number,
	search: number = ADMIN_WORLD_LIMITS.FREE_SEARCH,
): { x: number; y: number } | undefined {
	const [x0, y0, x1, y1] = townBounds(world, r);
	const inside = (px: number, py: number): boolean => px >= x0 && py >= y0 && px <= x1 && py <= y1;
	if (inside(x, y) && circleBlocked(world, x, y, r) === undefined) return { x, y };
	for (let ring = 12; ring <= search; ring += 12) {
		const n = math.max(8, math.ceil((ring * math.pi * 2) / 14));
		for (let i = 0; i < n; i++) {
			const a = (i / n) * math.pi * 2;
			const px = x + math.cos(a) * ring;
			const py = y + math.sin(a) * ring;
			if (inside(px, py) && circleBlocked(world, px, py, r) === undefined) return { x: px, y: py };
		}
	}
	return undefined;
}

/** the n-th body of a spawn: a sunflower spread around the click, close together, never on top of each other */
export function sunflower(i: number, r: number): [number, number] {
	const a = i * 2.39996;
	const d = i === 0 ? 0 : r * 2.4 * math.sqrt(i);
	return [math.cos(a) * d, math.sin(a) * d];
}

/** the walker variants of createZombie (fast & frail / big & tough), forced instead of rolled */
export function shapeWalker(z: ZombieState, kind: SpawnKind, day: number): void {
	const d = difficultyOfDay(day);
	const b = zombieDef(1);
	let speed = b.speed * (1 + d / 3);
	let hp = math.floor(b.hp * (1 + d));
	let scale = 1;
	if (kind === "fast") {
		speed *= 2;
		hp = math.floor(hp / 2);
	} else if (kind === "big") {
		hp = math.floor(hp * 1.5);
		scale = 1.4;
	}
	z.moveSpeed = speed;
	z.hp = hp;
	z.hpMax = hp;
	z.scale = scale;
}

/** zombies farther than this from every survivor (on either axis) are recycled by the population; bosses are not */
export const ZOMBIE_KEEP_RANGE = DESIGN.ZOMBIE_SPAWN_MAX;
/** ground items farther than this from every survivor are swept away */
export const ITEM_KEEP_RANGE = DESIGN.ITEM_SPAWN_MAX;
