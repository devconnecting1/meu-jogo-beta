import { DESIGN, TOWN } from "shared/engine/constants";
import { BuildingType } from "shared/data/buildings";
import { getDayPopulation } from "shared/data/spawns";
import { zombieDef } from "shared/data/zombies";
import { BossState, bossHitRadius, createBoss, createZombie, ZombieType } from "shared/game/entities";
import { circleBlocked, PLAYER_RADIUS } from "shared/game/physics";
import { currentWeapon } from "shared/game/player";
import { addSolid, querySolids, removeSolid, Solid, spawnGroundItem, WorldData } from "shared/game/world";
import type { GameContext } from "shared/game/context";
import type { ItemGroup } from "shared/admin/ops";
import * as WO from "shared/admin/worldOps";
import type { SpawnKind, StructureKind } from "shared/admin/worldOps";
import { PLACEABLES } from "../systems/build";
import { debugFlowField } from "../systems/zombieAI";
import type { GameRefs } from "../systems/types";
import type { GameLoop } from "../gameLoop";
import { AdminOverlay, OverlayFlags, PlacementPreview } from "./overlay";

/*
 * AdminWorld: the ONLY way the admin panel touches the game world.
 *
 * LocalAdminWorld acts directly on this client's GameLoop: that is right only where this client simulates its own
 * world (MP_PHASE < 2, or offline). From MP_PHASE 2 the server owns the world, and a spawn, the clock, god mode or a
 * teleport made here would be overwritten by the next snapshot; client/admin/serverWorld.ts (`AdminWorldHost`) then
 * sends every world tool to the server instead (docs/MULTIPLAYER.md §10, F6-6B) and the panel does not change. The
 * "view" methods (free camera, overlays, preview, stats) stay on the client either way.
 */

// the catalogues are shared with the server, which validates every spawn against them (shared/admin/worldOps.ts)
export const SPAWN_KINDS = WO.SPAWN_KINDS;
export const STRUCTURE_KINDS = WO.STRUCTURE_KINDS;
export type { SpawnKind, StructureKind };

export const BUILDING_KINDS: Array<{ type: number; label: string }> = [
	{ type: BuildingType.House, label: "House" },
	{ type: BuildingType.LargeHouse, label: "Large house" },
	{ type: BuildingType.School, label: "School" },
	{ type: BuildingType.Hospital, label: "Hospital" },
	{ type: BuildingType.GasStation, label: "Gas station" },
	{ type: BuildingType.Pharmacy, label: "Pharmacy" },
	{ type: BuildingType.Market, label: "Market" },
	{ type: BuildingType.SmallMarket, label: "Small market" },
	{ type: BuildingType.GunShop, label: "Gun shop" },
	{ type: BuildingType.ClothShop, label: "Clothing shop" },
	{ type: BuildingType.Restaurant, label: "Restaurant" },
	{ type: BuildingType.CampusHall, label: "Campus hall" },
	{ type: BuildingType.CampusLibrary, label: "Campus library" },
	{ type: BuildingType.CampusLab, label: "Science lab" },
	{ type: BuildingType.CampusDorm, label: "Dorm" },
];

export type OverlayKind = "solids" | "actors" | "flow" | "lights" | "stats";

export interface WorldPoint {
	x: number;
	y: number;
}

export interface ClockState {
	day: number;
	/** 0..24 */
	hour: number;
	night: boolean;
	raining: boolean;
	/** active night wave 1..3 (0 = none) */
	wave: number;
}

export interface WorldStats {
	fps: number;
	zombies: number;
	bosses: number;
	items: number;
	bullets: number;
	solidsInView: number;
	sprites: number;
	guiInstances: number;
}

/** result of an action: ok + a short message for a toast */
export interface ActionResult {
	ok: boolean;
	message: string;
	/**
	 * The SERVER ran it and already wrote the audit line (a world tool of a server-owned world): the panel must not log
	 * it again as a local one. `ok` is then the server's answer, and nothing else.
	 */
	audited?: boolean;
}

export interface AdminWorld {
	/** a run is on screen and the survivor is alive (world tools do nothing otherwise) */
	ready(): boolean;
	/** the world tools go to the server (it owns the world) instead of acting on this client's copy */
	serverWorld(): boolean;
	playerPosition(): WorldPoint;
	screenToWorld(sx: number, sy: number): WorldPoint;

	// spawning (x, y in world units)
	/** body radius of one spawn of this kind (the placement preview uses it) */
	spawnRadius(kind: SpawnKind): number;
	/** zombies/items farther than this from the survivor (on either axis) are recycled by the spawner */
	spawnRange(kind: "zombie" | "item"): number;
	/** nearest point around (x, y) where a circle of radius r fits (undefined when none within `search` u) */
	freePoint(x: number, y: number, r: number, search?: number): WorldPoint | undefined;
	spawnZombies(kind: SpawnKind, count: number, x: number, y: number, chase: boolean): ActionResult;
	/** ammo index 5 (electricity) has no ground item */
	spawnItem(group: ItemGroup, index: number, count: number, x: number, y: number): ActionResult;
	structureSize(kind: StructureKind): [number, number];
	canPlaceStructure(kind: StructureKind, x: number, y: number): boolean;
	spawnStructure(kind: StructureKind, x: number, y: number): ActionResult;
	/** the construction a "Remove structure" click at (x, y) would take (the preview), or undefined */
	structureNear(x: number, y: number): Solid | undefined;
	/** takes down the construction nearest to (x, y), whoever built it */
	removeStructure(x: number, y: number): ActionResult;

	// time & weather
	clock(): ClockState;
	/** a slider: on a server-owned world the requests are paced and a refusal is told through `notify` */
	setClock(hour: number): void;
	skipToNight(): ActionResult;
	skipToDawn(): ActionResult;
	forceWave(): ActionResult;
	setRain(on: boolean): ActionResult;

	// population
	killAll(): ActionResult;
	clearCorpses(): ActionResult;

	// the survivor
	heal(): ActionResult;
	setGod(on: boolean): ActionResult;
	god(): boolean;
	setInfiniteAmmo(on: boolean): ActionResult;
	infiniteAmmo(): boolean;
	setNoclip(on: boolean): ActionResult;
	noclip(): boolean;
	teleport(x: number, y: number): ActionResult;
	buildingCount(buildingType: number): number;
	teleportToBuilding(buildingType: number): ActionResult;

	// view (client-side in any architecture)
	setFreeCam(on: boolean): void;
	freeCam(): boolean;
	moveFreeCam(dx: number, dy: number): void;
	setZoom(zoom: number): void;
	zoom(): number;
	setOverlay(kind: OverlayKind, on: boolean): void;
	overlay(kind: OverlayKind): boolean;
	/** this client has a pathfinding field to draw (it runs the horde itself: never while the server owns it) */
	hasFlowField(): boolean;
	setPreview(preview: PlacementPreview | undefined): void;
	stats(): WorldStats;
}

/** the same caps as the server's (a boss is heavy: boss 1 is 50 segments, and the snapshot carries MAX_BOSSES) */
const MAX_BOSSES = WO.ADMIN_WORLD_LIMITS.BOSSES;
const MAX_SPAWN = WO.ADMIN_WORLD_LIMITS.SPAWN_PER_REQUEST;
const FREE_SEARCH = WO.ADMIN_WORLD_LIMITS.FREE_SEARCH;
/** how far to look for free ground when noclip ends inside something solid */
const UNSTICK_SEARCH = WO.ADMIN_WORLD_LIMITS.UNSTICK_SEARCH;

function sideNormal(side: string | undefined): WorldPoint {
	if (side === "top") return { x: 0, y: -1 };
	if (side === "left") return { x: -1, y: 0 };
	if (side === "right") return { x: 1, y: 0 };
	return { x: 0, y: 1 };
}

function rectCircle(rx: number, ry: number, rw: number, rh: number, cx: number, cy: number, r: number): boolean {
	const qx = math.clamp(cx, rx, rx + rw);
	const qy = math.clamp(cy, ry, ry + rh);
	return (cx - qx) * (cx - qx) + (cy - qy) * (cy - qy) < r * r;
}

/**
 * LocalAdminWorld: thin implementation over this client's GameLoop. Per-frame hooks (called by adminClient around
 * GameLoop.update / after render) keep god mode, infinite ammo and the overlays in sync.
 */
export class LocalAdminWorld implements AdminWorld {
	protected godOn = false;
	protected ammoOn = false;
	protected freeOn = false;
	private flags: OverlayFlags = { solids: false, actors: false, flow: false, lights: false, stats: false };
	private preview?: PlacementPreview;
	private overlayView: AdminOverlay;
	private ammoBefore: Array<number> = [0, 0, 0, 0, 0, 0];
	private buildingCursor = new Map<number, number>();
	private fps = 60;
	private guiCount = 0;
	private guiSampledAt = -math.huge;
	/**
	 * called when a tool that changes the run is used (time, weather, spawns, god mode...): adminClient tells the
	 * server, which stops crediting that run (no coins / achievements / records)
	 */
	onAssist: (what: string) => void = () => {};

	constructor(
		protected readonly ctx: GameContext,
		protected readonly loop: GameLoop,
		overlayParent: GuiObject,
	) {
		this.overlayView = new AdminOverlay(overlayParent);
	}

	protected refs(): GameRefs {
		return this.loop.getRefs();
	}

	protected world(): WorldData {
		return this.refs().world;
	}

	/** the town inside the border forest, shrunk by `r`: noclip and teleports never leave it */
	protected bounds(r: number): [number, number, number, number] {
		return WO.townBounds(this.world(), r);
	}

	/** out of a solid (noclip ended inside a wall / car / tree): to the nearest free ground */
	private unstick(): void {
		const refs = this.refs();
		const p = refs.player;
		if (circleBlocked(refs.world, p.x, p.y, PLAYER_RADIUS) === undefined) return;
		const at = this.freePoint(p.x, p.y, PLAYER_RADIUS + 2, UNSTICK_SEARCH);
		if (at === undefined) return;
		p.x = at.x;
		p.y = at.y;
	}

	ready(): boolean {
		return this.ctx.phase === "playing" && !this.refs().player.dead;
	}

	serverWorld(): boolean {
		return false;
	}

	playerPosition(): WorldPoint {
		const p = this.refs().player;
		return { x: p.x, y: p.y };
	}

	screenToWorld(sx: number, sy: number): WorldPoint {
		const v = this.ctx.cam.screenToWorld(sx, sy);
		return { x: v.x, y: v.y };
	}

	// ------------------------------------------------------------ spawning

	spawnRadius(kind: SpawnKind): number {
		const info = WO.spawnKindInfo(kind);
		if (info !== undefined && info.boss) {
			// bossHitRadius only reads the type (no createBoss here: it would burn an entity id every frame)
			return bossHitRadius({ type: info.type } as BossState);
		}
		const r = zombieDef(info?.type ?? 1).radius;
		return kind === "big" ? r * 1.4 : r;
	}

	spawnRange(kind: "zombie" | "item"): number {
		return kind === "zombie" ? DESIGN.ZOMBIE_SPAWN_MAX : DESIGN.ITEM_SPAWN_MAX;
	}

	freePoint(x: number, y: number, r: number, search: number = FREE_SEARCH): WorldPoint | undefined {
		return WO.freePointIn(this.world(), x, y, r, search);
	}

	protected tooFar(x: number, y: number, range: number): boolean {
		const p = this.refs().player;
		return math.abs(x - p.x) > range || math.abs(y - p.y) > range;
	}

	spawnZombies(kind: SpawnKind, count: number, x: number, y: number, chase: boolean): ActionResult {
		if (!this.ready()) return { ok: false, message: "Start a run first" };
		const refs = this.refs();
		const n = math.clamp(math.floor(count), 1, MAX_SPAWN);
		const r = this.spawnRadius(kind);
		const info = WO.spawnKindInfo(kind);
		const boss = info !== undefined && info.boss ? info.type : undefined;
		if (boss === undefined && this.tooFar(x, y, this.spawnRange("zombie"))) {
			return { ok: false, message: "Too far from the survivor: the spawner would recycle it" };
		}
		const day = refs.daynight.day;
		let placed = 0;
		for (let i = 0; i < n; i++) {
			if (boss !== undefined && refs.bosses.size() >= MAX_BOSSES) break;
			// sunflower spread around the click: close together, never on top of each other
			const [dx, dy] = WO.sunflower(i, r);
			const at = this.freePoint(x + dx, y + dy, r + 2);
			if (at === undefined) continue;
			if (boss !== undefined) {
				refs.bosses.push(createBoss(boss, at.x, at.y));
			} else {
				const z = createZombie((info?.type ?? 1) as ZombieType, at.x, at.y, day, false);
				if (z.type === 1) WO.shapeWalker(z, kind, day);
				z.detect = chase;
				z.detectShow = chase ? 1 : 0;
				refs.zombies.push(z);
			}
			placed++;
		}
		if (placed > 0) this.onAssist("spawn");
		if (placed === 0) {
			return {
				ok: false,
				message: boss !== undefined ? `At most ${MAX_BOSSES} bosses at once` : "No free space there",
			};
		}
		return { ok: true, message: `Spawned ${placed}` };
	}

	spawnItem(group: ItemGroup, index: number, count: number, x: number, y: number): ActionResult {
		if (!this.ready()) return { ok: false, message: "Start a run first" };
		// the shop sells outfits and pets: an admin never drops one (the server refuses them too, worldOps.ts)
		if (group === "equip" && WO.isCosmeticEquip(index)) {
			return { ok: false, message: "Outfits and pets are sold in the shop, not dropped" };
		}
		// ammo pools are ETC items 44..48; electricity has no ground item
		if (group === "ammo" && index > WO.AMMO_GROUND_MAX_INDEX) {
			return { ok: false, message: "Electricity cannot be dropped on the ground" };
		}
		const itemId = WO.groundItemId(group, index);
		if (this.tooFar(x, y, this.spawnRange("item"))) {
			return { ok: false, message: "Too far from the survivor: the spawner would recycle it" };
		}
		const at = this.freePoint(x, y, 10);
		if (at === undefined) return { ok: false, message: "No free space there" };
		spawnGroundItem(
			this.world(),
			WO.ITEM_GROUP_KIND[group],
			itemId,
			math.clamp(math.floor(count), 1, 9999),
			at.x,
			at.y,
		);
		this.onAssist("spawn");
		return { ok: true, message: "Item dropped" };
	}

	structureSize(kind: StructureKind): [number, number] {
		const info = STRUCTURE_KINDS.find(s => s.kind === kind);
		const def = info !== undefined ? PLACEABLES[info.placeable] : undefined;
		return def !== undefined ? [def.w, def.h] : [64, 64];
	}

	canPlaceStructure(kind: StructureKind, x: number, y: number): boolean {
		const w = this.world();
		const [sw, sh] = this.structureSize(kind);
		const gx = x - sw / 2;
		const gy = y - sh / 2;
		if (gx < 0 || gy < 0 || gx + sw > w.width || gy + sh > w.height) return false;
		for (const s of querySolids(w, gx, gy, gx + sw, gy + sh)) {
			if (s.passable === true) continue;
			if (gx < s.x + s.w && gx + sw > s.x && gy < s.y + s.h && gy + sh > s.y) return false;
		}
		const refs = this.refs();
		if (rectCircle(gx, gy, sw, sh, refs.player.x, refs.player.y, PLAYER_RADIUS)) return false;
		for (const z of refs.zombies) {
			if (z.hp > 0 && rectCircle(gx, gy, sw, sh, z.x, z.y, zombieDef(z.type).radius * (z.scale ?? 1))) {
				return false;
			}
		}
		return true;
	}

	spawnStructure(kind: StructureKind, x: number, y: number): ActionResult {
		if (!this.ready()) return { ok: false, message: "Start a run first" };
		const info = STRUCTURE_KINDS.find(s => s.kind === kind);
		const def = info !== undefined ? PLACEABLES[info.placeable] : undefined;
		if (def === undefined) return { ok: false, message: "Unknown structure" };
		if (!this.canPlaceStructure(kind, x, y)) return { ok: false, message: "Blocked: something is in the way" };
		addSolid(this.world(), {
			kind: def.kind,
			x: x - def.w / 2,
			y: y - def.h / 2,
			w: def.w,
			h: def.h,
			hp: def.hp,
			hpMax: def.hp,
			destructible: def.destructible,
			tags: def.tag,
			rot: 0,
			open: def.kind === "door" || def.kind === "iron_door" ? false : undefined,
			powered: def.powered,
			// a construction like the server's (`placeable`): "Remove structure" can take it down again
			placeable: info!.placeable,
		});
		this.onAssist("spawn");
		return { ok: true, message: `${info!.label} placed` };
	}

	structureNear(x: number, y: number): Solid | undefined {
		return WO.nearestConstruction(this.world(), x, y, WO.ADMIN_WORLD_LIMITS.REMOVE_REACH);
	}

	removeStructure(x: number, y: number): ActionResult {
		if (!this.ready()) return { ok: false, message: "Start a run first" };
		const s = this.structureNear(x, y);
		if (s === undefined) {
			return {
				ok: false,
				message: `No construction within ${WO.ADMIN_WORLD_LIMITS.REMOVE_REACH} u of that point`,
			};
		}
		// like a placement (addSolid above): the local flow field reads the solids again on its own rebuild
		removeSolid(this.world(), s);
		this.onAssist("spawn");
		return { ok: true, message: `Removed ${s.kind}` };
	}

	// ------------------------------------------------------------ time & weather

	clock(): ClockState {
		const dn = this.refs().daynight;
		let wave = 0;
		if (dn.wave3Active) wave = 3;
		else if (dn.wave2Active) wave = 2;
		else if (dn.wave1Active) wave = 1;
		return { day: dn.day, hour: dn.dayTime, night: dn.isNight, raining: dn.isRaining, wave };
	}

	setClock(hour: number): void {
		const dn = this.refs().daynight;
		dn.dayTime = math.clamp(hour, 0, 23.99);
		dn.update(0);
		this.onAssist("clock");
	}

	/** advances the clock past midnight the way DayNight does it (day + 1, new weather, new population) */
	private rollDay(): void {
		const dn = this.refs().daynight;
		dn.dayTime = 24 - 1e-6;
		dn.update(0.01);
	}

	/** puts the clock at 18:15 for one tick, so DayNight fills the night's wave queues */
	private fillNight(): void {
		const dn = this.refs().daynight;
		dn.dayTime = 18.25;
		dn.update(0);
	}

	skipToNight(): ActionResult {
		const dn = this.refs().daynight;
		const t = dn.dayTime;
		if (t >= 19 || t < 6) return { ok: false, message: "It is already night" };
		if (t < 18.5) this.fillNight();
		// just before 19:00: the next tick crosses it and announces wave 1 like a normal dusk
		dn.dayTime = 18.99;
		dn.update(0);
		this.onAssist("clock");
		return { ok: true, message: "Night falls" };
	}

	skipToDawn(): ActionResult {
		const dn = this.refs().daynight;
		const t = dn.dayTime;
		if (t >= 7 && t < 18) return { ok: false, message: "It is already day" };
		if (t >= 18) this.rollDay();
		// just before 7:00: the next tick says "Good morning" and non-wave zombies lose the trail
		dn.dayTime = 6.99;
		dn.update(0);
		this.onAssist("clock");
		return { ok: true, message: `Dawn of day ${dn.day}` };
	}

	forceWave(): ActionResult {
		const dn = this.refs().daynight;
		const refill = (i: number, always: boolean): void => {
			const pop = getDayPopulation(dn.day);
			const walkers = [pop.wave1, pop.wave2, pop.wave3];
			const specials = [pop.specialWave1, pop.specialWave2, pop.specialWave3];
			if (always || dn.waveQueues[i] <= 0) dn.waveQueues[i] = walkers[i];
			if (always || dn.specialWaveQueues[i] <= 0) dn.specialWaveQueues[i] = specials[i];
		};
		const t = dn.dayTime;
		let label: string;
		if (t >= 6 && t < 19) {
			if (t < 18.5) this.fillNight();
			refill(0, false);
			dn.dayTime = 18.99;
			label = "Wave 1 incoming";
		} else if (t >= 19 && t < 22) {
			refill(1, false);
			dn.dayTime = 21.99;
			label = "Wave 2 incoming";
		} else {
			if (t >= 22) this.rollDay();
			if (dn.dayTime < 1) {
				refill(2, false);
				dn.dayTime = 0.99;
				label = "Wave 3 incoming";
			} else {
				// wave 3 is already running (1:00–6:00): refill it
				refill(2, true);
				label = "Wave 3 refilled";
			}
		}
		dn.update(0);
		this.onAssist("wave");
		return { ok: true, message: label };
	}

	setRain(on: boolean): ActionResult {
		const dn = this.refs().daynight;
		dn.isRaining = on;
		dn.update(0);
		this.onAssist("weather");
		return { ok: true, message: on ? "Rain on" : "Rain off" };
	}

	// ------------------------------------------------------------ population

	killAll(): ActionResult {
		const refs = this.refs();
		// removed outright: no XP, no loot, no exploder blasts
		const n = refs.zombies.size() + refs.bosses.size();
		refs.zombies.clear();
		refs.bosses.clear();
		this.onAssist("killAll");
		return { ok: true, message: `Removed ${n} enemies` };
	}

	clearCorpses(): ActionResult {
		const refs = this.refs();
		let n = 0;
		for (let i = refs.zombies.size() - 1; i >= 0; i--) {
			if (refs.zombies[i].hp <= 0) {
				refs.zombies.remove(i);
				n++;
			}
		}
		n += refs.puddles?.size() ?? 0;
		refs.puddles?.clear();
		refs.explosions?.clear();
		this.loop.clearEffects();
		return { ok: true, message: `Cleared blood, acid and ${n} leftovers` };
	}

	// ------------------------------------------------------------ the survivor

	heal(): ActionResult {
		if (!this.ready()) return { ok: false, message: "Start a run first" };
		const p = this.refs().player;
		p.hp = p.hpMax;
		p.hungry = p.hungryMax;
		p.buffs.poison = 0;
		p.puddleSlow = 0;
		this.onAssist("heal");
		return { ok: true, message: "Healed and fed" };
	}

	setGod(on: boolean): ActionResult {
		this.godOn = on;
		this.syncGod();
		if (on) this.onAssist("god");
		return { ok: true, message: on ? "God mode on" : "God mode off" };
	}

	god(): boolean {
		return this.godOn;
	}

	setInfiniteAmmo(on: boolean): ActionResult {
		const p = this.refs().player;
		if (this.ammoOn && !on) {
			// the free magazine must not become real ammo: it is emptied (the weapon reloads from its pool)
			p.weapon.ammoCount = 0;
			p.weapon.reloading = false;
			p.weapon.reloadCount = 0;
		}
		this.ammoOn = on;
		p.infiniteAmmo = on;
		if (on) this.onAssist("infiniteAmmo");
		return { ok: true, message: on ? "Infinite ammo on" : "Infinite ammo off" };
	}

	infiniteAmmo(): boolean {
		return this.ammoOn;
	}

	setNoclip(on: boolean): ActionResult {
		const was = this.loop.admin.noclip;
		this.loop.admin.noclip = on;
		if (on) this.onAssist("noclip");
		else if (was) this.unstick();
		return { ok: true, message: on ? "Noclip on" : "Noclip off" };
	}

	noclip(): boolean {
		return this.loop.admin.noclip;
	}

	teleport(x: number, y: number): ActionResult {
		if (!this.ready()) return { ok: false, message: "Start a run first" };
		const p = this.refs().player;
		const [x0, y0, x1, y1] = this.bounds(PLAYER_RADIUS);
		let at: WorldPoint | undefined = { x: math.clamp(x, x0, x1), y: math.clamp(y, y0, y1) };
		if (!this.loop.admin.noclip) at = this.freePoint(at.x, at.y, PLAYER_RADIUS + 2);
		if (at === undefined) return { ok: false, message: "No free space there" };
		p.x = at.x;
		p.y = at.y;
		p.reactionSpeed = 0;
		this.onAssist("teleport");
		if (!this.ctx.cam.detached) {
			this.ctx.cam.x = at.x;
			this.ctx.cam.y = at.y;
		}
		return { ok: true, message: "Teleported" };
	}

	protected buildings(buildingType: number): Array<Solid> {
		const out: Array<Solid> = [];
		for (const s of this.world().solids) {
			if (s.kind === "building" && s.buildingType === buildingType) out.push(s);
		}
		return out;
	}

	buildingCount(buildingType: number): number {
		return this.buildings(buildingType).size();
	}

	teleportToBuilding(buildingType: number): ActionResult {
		const list = this.buildings(buildingType);
		const label = BUILDING_KINDS.find(b => b.type === buildingType)?.label ?? "Building";
		if (list.size() === 0) return { ok: false, message: `No ${label.lower()} in this town` };
		// each press visits the next one
		const i = ((this.buildingCursor.get(buildingType) ?? -1) + 1) % list.size();
		this.buildingCursor.set(buildingType, i);
		const b = list[i];
		// in front of the door, on the street side
		const n = sideNormal(b.doorSide);
		const off = TOWN.WALL_T / 2 + 70;
		const dx = (b.doorX ?? b.x + b.w / 2) + n.x * off;
		const dy = (b.doorY ?? b.y + b.h) + n.y * off;
		const res = this.teleport(dx, dy);
		return res.ok ? { ok: true, message: `${label} ${i + 1}/${list.size()}`, audited: res.audited } : res;
	}

	// ------------------------------------------------------------ view

	setFreeCam(on: boolean): void {
		if (on && !this.freeOn) this.onAssist("freeCam");
		this.freeOn = on;
		this.ctx.cam.setDetached(on);
		this.loop.admin.frozen = on;
		if (!on) {
			const p = this.refs().player;
			this.ctx.cam.x = p.x;
			this.ctx.cam.y = p.y;
		}
		this.syncGod();
	}

	freeCam(): boolean {
		return this.freeOn;
	}

	moveFreeCam(dx: number, dy: number): void {
		if (!this.freeOn) return;
		const w = this.world();
		const cam = this.ctx.cam;
		cam.x = math.clamp(cam.x + dx, 0, w.width);
		cam.y = math.clamp(cam.y + dy, 0, w.height);
	}

	setZoom(zoom: number): void {
		if (!this.freeOn) return;
		this.ctx.cam.zoom = math.clamp(zoom, 0.5, 2);
	}

	zoom(): number {
		return this.ctx.cam.zoom;
	}

	setOverlay(kind: OverlayKind, on: boolean): void {
		this.flags[kind] = on;
	}

	overlay(kind: OverlayKind): boolean {
		return this.flags[kind];
	}

	hasFlowField(): boolean {
		return debugFlowField().valid;
	}

	setPreview(preview: PlacementPreview | undefined): void {
		this.preview = preview;
	}

	stats(): WorldStats {
		const refs = this.refs();
		const v = this.ctx.cam.viewRect(0);
		const now = os.clock();
		if (now - this.guiSampledAt >= 1) {
			this.guiSampledAt = now;
			// the world's, the HUD's and the menus' ScreenGuis (client/bootstrap.ts)
			this.guiCount =
				this.ctx.screen.GetDescendants().size() +
				this.ctx.hudGui.GetDescendants().size() +
				this.ctx.uiGui.GetDescendants().size();
		}
		return {
			fps: this.fps,
			zombies: refs.zombies.size(),
			bosses: refs.bosses.size(),
			items: refs.world.items.size(),
			bullets: refs.bullets.size(),
			solidsInView: querySolids(refs.world, v.minX, v.minY, v.maxX, v.maxY).size(),
			sprites: this.ctx.renderer.drawCount(),
			guiInstances: this.guiCount,
		};
	}

	// ------------------------------------------------------------ frame hooks (adminClient)

	protected syncGod(): void {
		this.refs().player.godMode = this.godOn || this.freeOn;
	}

	/** before GameLoop.update (world simulating) */
	beforeUpdate(): void {
		this.syncGod();
		this.refs().player.infiniteAmmo = this.ammoOn;
		if (this.ammoOn) {
			const s = this.refs().save;
			this.ammoBefore[0] = s.ammoNormal;
			this.ammoBefore[1] = s.ammoShotgun;
			this.ammoBefore[2] = s.ammoMachinegun;
			this.ammoBefore[3] = s.ammoArrow;
			this.ammoBefore[4] = s.oil;
			this.ammoBefore[5] = s.electric;
		}
	}

	/** after GameLoop.update: god mode tops the survivor up, infinite ammo gives back what was spent */
	afterUpdate(): void {
		const refs = this.refs();
		const p = refs.player;
		this.syncGod();
		if (this.loop.admin.noclip) {
			// noclip walks through solids, not out of the town (the border forest is the edge of the map)
			const [x0, y0, x1, y1] = this.bounds(PLAYER_RADIUS);
			p.x = math.clamp(p.x, x0, x1);
			p.y = math.clamp(p.y, y0, y1);
		}
		if (p.godMode === true && !p.dead) {
			// starvation and poison hurt without damageToPlayer
			p.hp = p.hpMax;
			p.buffs.poison = 0;
		}
		if (this.ammoOn) {
			const s = refs.save;
			// pick-ups still count; nothing spent is lost
			s.ammoNormal = math.max(s.ammoNormal, this.ammoBefore[0]);
			s.ammoShotgun = math.max(s.ammoShotgun, this.ammoBefore[1]);
			s.ammoMachinegun = math.max(s.ammoMachinegun, this.ammoBefore[2]);
			s.ammoArrow = math.max(s.ammoArrow, this.ammoBefore[3]);
			s.oil = math.max(s.oil, this.ammoBefore[4]);
			s.electric = math.max(s.electric, this.ammoBefore[5]);
			// magazine weapons (fuel weapons included) never need a reload
			const mag = currentWeapon(p).mag;
			if (mag > 0 && !p.dead) {
				p.weapon.ammoCount = mag;
				p.weapon.reloading = false;
				p.weapon.reloadCount = 0;
			}
		}
	}

	/** every rendered frame (after GameLoop.render) */
	afterRender(dt: number): void {
		if (dt > 0) this.fps = this.fps + (1 / dt - this.fps) * math.min(1, dt * 4);
		// the world is drawn on every frame of a run, a death included (no "paused" phase exists: DESIGN_RULES UI-06)
		const show = this.ctx.phase === "playing" || this.ctx.phase === "dead";
		if (!show) {
			this.overlayView.hide();
			return;
		}
		this.overlayView.draw(this.ctx, this.refs(), this.flags, this.preview);
	}

	/** the game screen is gone (lobby / menus): no overlay left on screen */
	hideOverlay(): void {
		this.overlayView.hide();
	}

	/** leaving the admin mode (e.g. the attribute was removed): everything back to normal */
	reset(): void {
		this.setFreeCam(false);
		this.setGod(false);
		this.setInfiniteAmmo(false);
		this.setNoclip(false);
		this.resetView();
	}

	/** the overlays and the placement ghost off (what is drawn on this screen only) */
	protected resetView(): void {
		this.preview = undefined;
		for (const [k] of pairs(this.flags)) this.flags[k] = false;
		this.overlayView.hide();
	}
}
