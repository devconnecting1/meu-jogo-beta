import { getCtx, refreshAim } from "./bootstrap";
import { COLORS, Z } from "shared/engine/colors";
import { Camera, ViewRect } from "shared/engine/camera";
import { DESIGN } from "shared/engine/constants";
import { LightMap, LightSource, Renderer } from "shared/engine/renderer";
import { clamp, lerp } from "shared/engine/vec2";
import { ItemKind, WeaponKind } from "shared/data/kinds";
import { EQUIPS } from "shared/data/equips";
import { USABLES } from "shared/data/usables";
import { isChoppingTool, WEAPONS } from "shared/data/weapons";
import { expMaxInit, outfitLookOf, petLookOf, PlayerSaveData, titleWireOf } from "shared/game/save";
import { PetLook, petFlies } from "shared/data/cosmetics";
import { createPlayer, currentWeapon, PlayerState } from "shared/game/player";
import { PLAYER_RADIUS } from "shared/game/physics";
import type { GameContext } from "shared/game/context";
import {
	buildingAt,
	createWorld,
	generateTown,
	isOnRoad,
	querySolids,
	randomOpenPoint,
	rectHitsSolid,
	updateGroundItems,
	WorldData,
	Solid,
} from "shared/game/world";
import { resetEntityIds, BossState, ZombieState } from "shared/game/entities";
import { resetBullets, Bullet } from "shared/game/bullets";
import { DayNight } from "./systems/daynight";
import { ParticleSystem } from "./systems/particles";
import { Spawner } from "./systems/spawner";
import { updateZombies } from "./systems/zombieAI";
import { updateBosses } from "./systems/bossAI";
import { Combat } from "./systems/combat";
import { Interaction } from "./systems/interaction";
import { BuildSystem } from "./systems/build";
import { GameRefs } from "./systems/types";
import { stepPlayer } from "shared/sim/playerMove";
import { FxEvent, InputCommand, makeCommand, packEdges, SEQ_MOD } from "shared/sim/types";
import { Nameplate, profileOf } from "./ui/nameplate";
import {
	netActive,
	netBindAdmin,
	netReset,
	netStats,
	netTownSeed,
	netUpdate,
	remotePlayers,
	takeNetFx,
	ZombieDeathEvent,
} from "./net/netClient";
import { createRawInput, readRawInput } from "./net/localInput";
import { RemotePlayerView } from "./net/netTypes";
import { MP_PHASE } from "shared/net/mpConfig";
import { FxEvent as WireFxEvent } from "shared/net/protocol";
import { ActorDrawOpts, ActorsView } from "./view/actorsView";
import { explosionFade, FxView, WireFxOpts } from "./view/fxView";
import { PlayersView } from "./view/playersView";
import { ChatBubbles } from "./view/chatBubbles";
import { createLook, createSwingTrail, drawSurvivor } from "./view/survivorView";
import { drawPet } from "./view/cosmeticsView";
import { createPetFollower, stepPetFollower } from "./view/petFollow";
import { FootCycle } from "./view/footsteps";
import { circleInView, part } from "./view/drawKit";
import { WorldView } from "./view/worldView";
import { ageFlinches } from "./view/solidFlinch";

const Players = game.GetService("Players");

/**
 * From this phase the SERVER owns the horde, the bosses and every projectile (§11.1), so the client mirrors
 * them instead of simulating them (client/view/actorsView.ts). `netActive()` on its own is not the test:
 * at MP_PHASE 1 a client is in a server session AND still simulates a horde of its own, and the mirror would
 * fight that simulation for the same array every frame.
 */
const SERVER_ACTORS = MP_PHASE >= 2;

/** nameplate sits between the night light map (Dark, 80) and the HUD (90) so it stays readable at night */
const NAMEPLATE_Z = 85;
/** world units from the player's centre to the top of the plate: clears the body and its shadow */
const NAMEPLATE_GAP = 14;

/** roof easing per 60 fps frame (the original lerp), applied frame-rate independently */
const ROOF_LERP = 0.15;
/** tree canopy opacity while someone stands under it (original obj_tree1 fades near the player) */
const CANOPY_SEE_THROUGH = 0.35;
/** night light radii (world units): the player's own light and built light sources */
const PLAYER_LIGHT_R = 250;
const LIGHT_R: Record<string, number> = { lamp: 400, lamp_drone: 320, campfire: 300, brazier: 330 };
/** walk-cycle phase per world unit travelled (survivors, local and remote) */
const FEET_CYCLE_PER_UNIT = 0.09;
/**
 * Speed (world units per second) above which the local survivor's feet swing in a server session. The single-
 * player path asks the simulation itself (`StepResult.walking`), but a predicted frame is not a simulation step:
 * it can hold 0, 1 or several of them plus the visual offset and the render lead, so there the walk cycle follows
 * the position the view actually shows — exactly as an interpolated ally's does.
 */
const NET_WALK_SPEED = 8;
/** nothing to draw when the session is not server-simulated */
const NO_REMOTES = new Array<RemotePlayerView>();
const WHITE = COLORS.white;
const BLACK = COLORS.shadow;

/**
 * Target roof opacity for a building (0 = invisible, 1 = opaque), eased by the caller.
 * Pure inside/outside like the original (par_building:47-57): from the street you never see
 * what waits inside, so every doorway is a gamble.
 * @param playerInside true when the player's position is inside the building's footprint
 */
function roofTargetAlpha(playerInside: boolean): number {
	return playerInside ? 0 : 1;
}

/** frame-rate independent version of `lerp(a, b, perFrame)` tuned at 60 fps */
function ease(perFrame: number, dt: number): number {
	return 1 - math.pow(1 - perFrame, dt * 60);
}

// ------------------------------------------------------------------ ground items

/** one flat piece of a ground item, in the item's own frame (f along its heading, l to its right) */
interface ItemPart {
	f: number;
	l: number;
	w: number;
	h: number;
	color: Color3;
	/** corner radius (world units); CIRCLE for a disc */
	r: number;
	/** extra turn relative to the item (radians) */
	rot: number;
	/** dark outline that separates the piece from any ground (off for insets such as labels) */
	edge: boolean;
}

/** a ground item's silhouette: its pieces bottom → top and the footprint of its drop shadow */
interface ItemLook {
	parts: Array<ItemPart>;
	shadowW: number;
	shadowH: number;
	shadowR: number;
}

const CIRCLE = -1;

function piece(f: number, l: number, w: number, h: number, color: Color3, r = 2, edge = true, rot = 0): ItemPart {
	return { f, l, w, h, color, r, rot, edge };
}

function look(shadowW: number, shadowH: number, shadowR: number, parts: Array<ItemPart>): ItemLook {
	return { parts, shadowW, shadowH, shadowR };
}

/**
 * Item palette. Built from the world palette and kept clear of the fixed gameplay colours (LEG-02):
 * no zombie green, poison purple or electric yellow on loot. Red appears only as the medical cross
 * (it restores the player's health, the thing red stands for). Each look has one light, saturated
 * piece so it reads on dark asphalt and a dark outline so it reads on pale pavement.
 */
const LOOT = {
	steel: COLORS.blade,
	gunmetal: COLORS.wallIron.Lerp(COLORS.weapon, 0.25),
	grip: COLORS.weapon,
	handle: COLORS.treeTrunk,
	lumber: COLORS.arrow.Lerp(COLORS.treeTrunk, 0.25),
	tin: COLORS.blade.Lerp(COLORS.wallIron, 0.4),
	foodLabel: COLORS.campfire.Lerp(COLORS.blood, 0.15),
	medCase: WHITE.Lerp(COLORS.wallHouse, 0.25),
	medCross: COLORS.uiRed,
	ammoBox: COLORS.treeLeafDark.Lerp(COLORS.fence, 0.6),
	brass: COLORS.uiAccent.Lerp(WHITE, 0.2),
	fuel: COLORS.car.Lerp(COLORS.fence, 0.3),
	cloth: COLORS.wallHouse,
	leather: COLORS.doormat.Lerp(COLORS.treeTrunk, 0.3),
	steelBar: COLORS.wallIron.Lerp(WHITE, 0.2),
	gold: COLORS.uiAccent,
	stone: COLORS.curb.Lerp(WHITE, 0.12),
	burlap: COLORS.dirtPath.Lerp(COLORS.wallHouse, 0.2),
	/** machine parts are blue like every machine (LEG-02) */
	parts: COLORS.uiBlue.Lerp(COLORS.wallIron, 0.45),
	plastic: COLORS.wallShop,
	lens: COLORS.uiBlue.Lerp(WHITE, 0.3),
	fletch: WHITE.Lerp(COLORS.sidewalk, 0.2),
};
const LOOT_EDGE = COLORS.shadow.Lerp(COLORS.road, 0.25);

/** two stacked long pieces: lumber, metal bars */
function stackLook(color: Color3, len: number, thick: number, r: number): ItemLook {
	return look(len + 4, thick * 2 + 6, r, [
		piece(-2, -thick * 0.55, len, thick, color, r),
		piece(2, thick * 0.55, len - 2, thick, color.Lerp(WHITE, 0.12), r),
	]);
}

/** armour lying flat: a vest with its neck opening towards the item's heading */
function vestLook(color: Color3): ItemLook {
	return look(26, 30, 8, [
		piece(0, 0, 26, 30, color, 8),
		piece(9, 0, 9, 12, color.Lerp(COLORS.shadow, 0.45), 4, false),
	]);
}

const ITEM_LOOKS = {
	/** knives, swords, machetes, crowbars: handle + long steel head */
	blade: look(34, 8, 3, [piece(-11, 0, 13, 7, LOOT.handle, 2), piece(6, 0, 23, 6, LOOT.steel, 3)]),
	/** axes and saws: wooden haft + steel head across it */
	axe: look(34, 18, 3, [piece(-2, 0, 32, 6, LOOT.lumber, 3), piece(11, -4, 9, 18, LOOT.steel, 2)]),
	/** wooden stick / baseball bat */
	club: look(34, 9, 4, [piece(2, 0, 30, 8, LOOT.lumber, 4), piece(-13, 0, 9, 6, LOOT.handle, 2)]),
	/** pistols: slide + grip (an L) */
	pistol: look(26, 24, 3, [piece(-7, 8, 9, 15, LOOT.grip, 2, true, 0.3), piece(1, -3, 24, 8, LOOT.gunmetal, 2)]),
	/** rifles, shotguns, machine guns: wooden stock, grip, long receiver and barrel */
	longGun: look(36, 14, 3, [
		piece(-13, 0, 12, 10, LOOT.handle, 3),
		piece(-3, 5, 7, 9, LOOT.grip, 2),
		piece(4, 0, 30, 7, LOOT.gunmetal, 2),
	]),
	/** bows and the crossbow: two limbs in a shallow V + the string */
	bow: look(18, 34, 6, [
		piece(-4, 0, 2, 30, LOOT.fletch, 1, false),
		piece(1, -8, 5, 19, LOOT.handle, 2, true, -0.35),
		piece(1, 8, 5, 19, LOOT.handle, 2, true, 0.35),
	]),
	/** cartridges: an olive ammo box, open, brass showing */
	ammo: look(26, 20, 3, [piece(0, 0, 26, 20, LOOT.ammoBox, 3), piece(1, 0, 18, 12, LOOT.brass, 2, false)]),
	/** a bundle of arrows */
	arrows: look(34, 12, 2, [
		piece(0, -3, 32, 3, LOOT.lumber, 1),
		piece(1, 3, 32, 3, LOOT.lumber, 1),
		piece(-12, 0, 8, 12, LOOT.fletch, 2, false),
	]),
	/** oil: a jerrycan with its cap */
	fuel: look(24, 28, 4, [piece(0, 0, 24, 28, LOOT.fuel, 4), piece(8, -7, 8, 8, LOOT.steel, CIRCLE)]),
	/** food: a can lying on its side (tin ends, paper label) */
	food: look(28, 18, 5, [piece(0, 0, 28, 18, LOOT.tin, 5), piece(0, 0, 16, 18, LOOT.foodLabel, 0, false)]),
	/** medicine: a white case with a red cross */
	medicine: look(28, 24, 4, [
		piece(0, 0, 28, 24, LOOT.medCase, 4),
		piece(0, 0, 16, 5, LOOT.medCross, 1, false),
		piece(0, 0, 5, 16, LOOT.medCross, 1, false),
	]),
	lumber: stackLook(LOOT.lumber, 32, 8, 1),
	steel: stackLook(LOOT.steelBar, 26, 10, 2),
	gold: stackLook(LOOT.gold, 26, 10, 2),
	cloth: stackLook(LOOT.cloth, 28, 11, 5),
	leather: stackLook(LOOT.leather, 28, 11, 5),
	stone: look(26, 20, 9, [
		piece(-2, -1, 22, 18, LOOT.stone, 8),
		piece(8, 6, 12, 10, LOOT.stone.Lerp(WHITE, 0.15), 5),
	]),
	/** gunpowder: a tied sack */
	powder: look(24, 26, 8, [piece(-2, 0, 22, 24, LOOT.burlap, 8), piece(11, 0, 5, 12, LOOT.handle, 2)]),
	/** machine parts and electronics: a big steel-blue washer */
	parts: look(24, 24, 12, [piece(0, 0, 24, 24, LOOT.parts, CIRCLE), piece(0, 0, 9, 9, LOOT.grip, CIRCLE, false)]),
	/** placeable kits (desks, turrets, barricades...): a braced wooden crate */
	crate: look(28, 28, 2, [
		piece(0, 0, 28, 28, LOOT.lumber.Lerp(COLORS.treeTrunk, 0.25), 2),
		piece(0, 0, 34, 5, LOOT.lumber.Lerp(COLORS.treeTrunk, 0.55), 1, false, math.pi / 4),
	]),
	/** gadgets and attachments (flashlight, watch, scope...): a device with a blue lens */
	gadget: look(24, 18, 4, [piece(0, 0, 24, 18, LOOT.plastic, 4), piece(5, 0, 8, 8, LOOT.lens, CIRCLE)]),
};

/** armour (equip kind 1) by material; the rest of the equipment is gadgets */
const VEST_LOOKS: Record<number, ItemLook> = {
	0: vestLook(LOOT.cloth),
	1: vestLook(LOOT.leather),
	2: vestLook(LOOT.leather),
	3: vestLook(LOOT.lumber),
	4: vestLook(LOOT.steelBar),
	5: vestLook(LOOT.plastic),
	14: vestLook(LOOT.parts),
};

/** usables that heal or treat (first aid, pain killer, adrenaline, sedative, bandage) vs food */
function isMedicine(id: number): boolean {
	const u = USABLES[id];
	if (u === undefined) return false;
	return u.pain > 0 || u.speed > 0 || u.calm > 0 || (u.hunger <= 0 && u.hp > 0);
}

/** silhouette of a ground item by category: weapon, ammo/fuel, food, medicine, material, equipment */
function itemLook(kind: number, id: number): ItemLook {
	if (kind === ItemKind.Weapon) {
		const w = WEAPONS[id];
		if (w === undefined) return ITEM_LOOKS.blade;
		if (w.kind === WeaponKind.Melee) {
			if (isChoppingTool(w)) return ITEM_LOOKS.axe;
			return id === 1 || id === 6 ? ITEM_LOOKS.club : ITEM_LOOKS.blade;
		}
		if (w.kind === WeaponKind.Bow) return ITEM_LOOKS.bow;
		return w.kind === WeaponKind.Pistol ? ITEM_LOOKS.pistol : ITEM_LOOKS.longGun;
	}
	if (kind === ItemKind.Equip) {
		const e = EQUIPS[id];
		if (e !== undefined && e.kind === 1) return VEST_LOOKS[id] ?? VEST_LOOKS[0];
		return ITEM_LOOKS.gadget;
	}
	if (kind === ItemKind.Use) return isMedicine(id) ? ITEM_LOOKS.medicine : ITEM_LOOKS.food;
	// etc items (etcItems.ts): kits 0–22, materials 23–43, ammo 44–47, oil 48
	if (id >= 44 && id <= 46) return ITEM_LOOKS.ammo;
	if (id === 47) return ITEM_LOOKS.arrows;
	if (id === 48) return ITEM_LOOKS.fuel;
	if (id === 23) return ITEM_LOOKS.lumber;
	if (id === 24) return ITEM_LOOKS.stone;
	if (id === 25 || id === 26) return ITEM_LOOKS.steel;
	if (id === 27 || id === 28) return ITEM_LOOKS.gold;
	if (id === 33) return ITEM_LOOKS.powder;
	if (id === 34) return ITEM_LOOKS.cloth;
	if (id === 41) return ITEM_LOOKS.leather;
	if (id <= 22) return ITEM_LOOKS.crate;
	return ITEM_LOOKS.parts;
}

/** how far a dropped item lies turned from the world axes (radians), fixed per item */
const ITEM_TILT = 0.55;
/** the glint that marks loot: once every period (s), lasting `len` (s), per item out of phase */
const GLINT_PERIOD = 2.6;
const GLINT_LEN = 0.45;
const GLINT_ARM = 14;

export class GameLoop {
	/** empty placeholder; the town is generated once, in init() */
	private world: WorldData = createWorld(DESIGN.WORLD_W, DESIGN.WORLD_H);
	/**
	 * The seed the town in `world` was generated from (MP-22): the server's (client/net/netClient.ts `netTownSeed`),
	 * which is DESIGN.TOWN_SEED until a world ends. client/main.client.ts compares it with every InitBegin.
	 */
	townSeed: number = DESIGN.TOWN_SEED;
	private player: PlayerState;
	private save: PlayerSaveData;
	private zombies: Array<ZombieState> = [];
	private bosses: Array<BossState> = [];
	private bullets: Array<Bullet> = [];
	/** every survivor in this world (F0: only the local one, players[0]) */
	private players: Array<PlayerState> = [];
	/** cosmetic effects the systems asked for; played (and cleared) by playFx */
	private fx: Array<FxEvent> = [];
	private particles = new ParticleSystem();
	private daynight: DayNight;
	private combat = new Combat();
	private spawner = new Spawner();
	private interaction = new Interaction();
	private build = new BuildSystem();
	private refs: GameRefs;

	/** buildings whose roof is (or may be) not fully opaque; eased even off-screen */
	private fadingRoofs = new Set<Solid>();
	private queryBuf: Array<Solid> = [];
	/** player walk cycle (feet) */
	private walkPhase = 0;
	private walkAmp = 0;
	/** shadow direction: sun by day, away from the player's light at night */
	private sunX = 0.7;
	private sunY = 0.7;
	private nightLight = false;
	private clock = 0;
	private lightMap?: LightMap;
	private nameplate?: Nameplate;
	private lights: Array<LightSource> = [];
	/** sequence of the last input command (u16, wraps): the server acknowledges it from F1 on */
	private seq = 0;
	/** the local survivor's body, its melee-sweep memory and this frame's raw input (no per-frame allocation) */
	private readonly look = createLook();
	private readonly swing = createSwingTrail();
	/** the local survivor's pet (MON-04): a view that follows where this client draws you, never an entity */
	private readonly pet = createPetFollower();
	private petLook: number = PetLook.None;
	private readonly raw = createRawInput();
	/** the other survivors of a server session: bodies, pooled nameplates and their light (§5.3) */
	private readonly playersView = new PlayersView();
	/** what anyone within earshot just said, floating over their head; built on the first frame that can host it */
	private chat?: ChatBubbles;
	/** the local survivor's centre handed to the bubbles, refilled in place so a frame allocates nothing */
	private readonly selfBody = { x: 0, y: 0 };
	/** last frame time, so render() can ease what it has to ease (update() runs every frame of a run, UI-06) */
	private lastDt = 1 / 60;
	/** when the local survivor's foot lands (the walk cycle knows; client/view/footsteps.ts reports it) */
	private readonly foot = new FootCycle();
	/** the sun/light accessor handed to the views, bound once so a frame allocates no closure */
	private readonly shadowFor = (x: number, y: number, len: number): { x: number; y: number } =>
		this.shadowOffset(x, y, len);
	/** the town that stands still: ground, roads, buildings, trees, cars (client/view/worldView.ts) */
	private readonly worldView = new WorldView(this.shadowFor);
	/** the horde and the bosses: the mirror of the server's bodies (§4.2) and everything that draws them */
	private readonly actors = new ActorsView();
	/** blood, debris, shot lines, blasts and the projectiles the server flies (§4.1 Fx) */
	private readonly fxView = new FxView();
	/** what the actor views need from the loop each frame, refilled in place instead of rebuilt */
	private readonly drawOpts: ActorDrawOpts = { shadow: this.shadowFor, clock: 0 };
	/** this frame's §4.2 Fx events, drained from the network layer into one reused buffer */
	private readonly netFx = new Array<WireFxEvent>();
	/**
	 * `shooterAt` answers where a survivor's shot starts, by SLOT: §4.2's `Shot` names the shooter that way
	 * and the tracer has to leave THEIR hands. The local survivor is never looked up here — their own shot is
	 * predicted (client/predict/weaponFx.ts), which is what makes firing feel instant at 150 ms of RTT.
	 */
	private readonly shooterAt = (slot: number): { x: number; y: number } | undefined => {
		for (const ally of remotePlayers()) {
			if (ally.slot === slot) return ally;
		}
		return undefined;
	};
	private readonly wireOpts: WireFxOpts = { localSlot: -1, shooterAt: this.shooterAt };
	/** a reliable `ZombieDied` (§4.4): the mirror hands it over, the effect view decides what it still owes */
	private readonly onZombieDeath = (d: ZombieDeathEvent): void => this.fxView.noteDeath(d);

	constructor() {
		const save = getCtx().save;
		this.save = save;
		this.player = createPlayer(save, 0, 0);
		this.players.push(this.player);
		this.daynight = new DayNight(save);
		this.refs = {
			world: this.world,
			players: this.players,
			player: this.player,
			save: this.save,
			input: undefined as never,
			zombies: this.zombies,
			bosses: this.bosses,
			bullets: this.bullets,
			daynight: this.daynight,
			pendingPlace: -1,
			fx: this.fx,
			onMessage: () => {},
			onExp: () => {},
		};
	}

	init(save: PlayerSaveData): void {
		this.save = save;
		// the server's town, not always the same one: when every survivor dies the world ends and the next is built
		// from a new seed (MP-22). Offline this is DESIGN.TOWN_SEED, as it always was
		this.townSeed = netTownSeed();
		this.world = generateTown(this.townSeed);
		this.fadingRoofs.clear();
		resetEntityIds();
		resetBullets();
		this.zombies.clear();
		this.bosses.clear();
		this.bullets.clear();
		// a new world has none of the old one's bodies, shot lines, blasts or server-flown projectiles
		this.actors.reset();
		this.fxView.clear(this.refs);
		this.netFx.clear();
		this.wireOpts.localSlot = -1;
		this.particles.clear();
		const spawn = this.findSpawnPoint();
		this.player = createPlayer(save, spawn.x, spawn.y);
		this.players.clear();
		this.players.push(this.player);
		this.fx.clear();
		// MP-20: a new map is a new LIFE, never a new world. The clock is the town's, so it is handed over
		// instead of rebuilt -- otherwise "New game" put this client back at day 1, 07:00 while the server
		// (and everybody else on it) was still in the middle of night three. When the WORLD itself ends (MP-22) the
		// handover still happens, and the day-1 Clock delta the server sends right behind its WorldReset jumps it
		const previousClock = this.daynight;
		this.daynight = new DayNight(save);
		this.daynight.adoptWorld(previousClock);
		this.daynight.onAnnounce = msg => {
			this.fx.push({ kind: "message", text: msg });
		};
		const refs = this.refs;
		refs.world = this.world;
		refs.players = this.players;
		refs.player = this.player;
		refs.save = save;
		refs.input = getCtx().input;
		refs.zombies = this.zombies;
		refs.bosses = this.bosses;
		refs.bullets = this.bullets;
		refs.daynight = this.daynight;
		refs.pendingPlace = -1;
		refs.fx = this.fx;
		refs.onMessage = msg => {
			print(msg);
		};
		refs.onExp = amount => {
			save.exp += amount;
			while (save.exp >= expMaxInit(save.level)) {
				save.exp -= expMaxInit(save.level);
				save.level++;
				save.skillPoint++;
			}
		};
		// a new world: the session forgets its prediction history and re-attaches to this survivor (§5.2), and
		// the admin switches travel by reference so the free camera freezes the survivor on both paths
		netBindAdmin(this.admin);
		netReset();
		this.playersView.hide();
		// a new body: the pet appears at its heel rather than running over from where the last one fell
		this.pet.started = false;
		const ctx = getCtx();
		ctx.cam.x = this.player.x;
		ctx.cam.y = this.player.y;
	}

	/** Start on a street near the centre of town: never inside a building, a car or a tree. */
	private findSpawnPoint(): { x: number; y: number } {
		const w = this.world;
		const cx = w.width / 2;
		const cy = w.height / 2;
		for (let i = 0; i < 200; i++) {
			const p = randomOpenPoint(w, cx - 1400, cy - 1400, cx + 1400, cy + 1400);
			if (
				isOnRoad(w, p.x, p.y) &&
				buildingAt(w, p.x, p.y) === undefined &&
				rectHitsSolid(w, p.x, p.y, 80, 80) === undefined
			) {
				return p;
			}
		}
		return randomOpenPoint(w, cx - 800, cy - 800, cx + 800, cy + 800);
	}

	/**
	 * This frame's local input as a quantised command (docs/MULTIPLAYER.md §2.2). Quantising BEFORE stepping is
	 * what makes the client and the server apply the very same numbers from F1 on.
	 */
	private sampleCommand(ctx: GameContext): InputCommand {
		const input = ctx.input;
		// the same reader the server session uses (client/net/localInput.ts), so the two paths cannot drift apart
		const raw = readRawInput(ctx.cam, input, this.admin.frozen, this.raw);
		const edges = packEdges(
			input.attackPressed ? 1 : 0,
			input.attackReleased ? 1 : 0,
			input.actionPressed ? 1 : 0,
			input.reloadPressed ? 1 : 0,
		);
		this.seq = (this.seq + 1) % SEQ_MOD;
		return makeCommand(this.seq, raw.moveX, raw.moveY, raw.magnitude, raw.aim, raw.held, edges);
	}

	/** one step of the local survivor with the shared simulation (the server runs the same one in F1) */
	private stepLocalPlayer(ctx: GameContext, dt: number): void {
		const p = this.player;
		const cmd = this.sampleCommand(ctx);
		// admin switch: noclip travels on the survivor (it arrives in the snapshot's modFlags from F1 on)
		p.noclip = this.admin.noclip;
		const step = stepPlayer(this.world, p, this.save, cmd, dt);
		this.walkPhase += step.moved * FEET_CYCLE_PER_UNIT;
		this.walkAmp = lerp(this.walkAmp, step.walking ? 1 : 0, ease(0.25, dt));
		if (step.died) ctx.phase = "dead";
	}

	/**
	 * The server-simulated path (docs/MULTIPLAYER.md §2.2, §5.2). `netUpdate` owns the whole thing: it samples the
	 * input into 60 Hz commands, sends them with their redundancy, reconciles the last ack and writes the DRAWN
	 * position (prediction + visual offset + render lead) onto the survivor. The loop only reads the result, so
	 * the walk cycle follows the position on screen, like every interpolated ally's does.
	 */
	private stepNetPlayer(ctx: GameContext, dt: number): void {
		const p = this.player;
		// admin switch; the server's own noclip arrives in the snapshot's modFlags and overrides this
		p.noclip = this.admin.noclip;
		const fromX = p.x;
		const fromY = p.y;
		netUpdate(this.refs, dt);
		const dx = p.x - fromX;
		const dy = p.y - fromY;
		const moved = math.sqrt(dx * dx + dy * dy);
		this.walkPhase += moved * FEET_CYCLE_PER_UNIT;
		const speed = dt > 0 ? moved / dt : 0;
		this.walkAmp = lerp(this.walkAmp, speed > NET_WALK_SPEED ? 1 : 0, ease(0.25, dt));
		if (p.dead) ctx.phase = "dead";
	}

	/**
	 * Every cosmetic effect of the frame, from both channels (client/view/fxView.ts).
	 *
	 * The wire is drained FIRST because `Blood`, `Debris` and `Tracer` come back as simulation events and are
	 * pushed into `refs.fx` — so draining that second plays a received bite and a locally simulated one in
	 * the same frame, through the same code, in the same order.
	 */
	private playFx(ctx: GameContext): void {
		if (SERVER_ACTORS && netActive()) {
			const wire = this.netFx;
			wire.clear();
			takeNetFx(wire);
			if (wire.size() > 0) {
				// the slot only has to be looked up until the roster names it; it does not change inside a run
				if (this.wireOpts.localSlot < 0) this.wireOpts.localSlot = netStats().slot;
				this.fxView.playWire(this.refs, wire, ctx.cam, this.particles, this.wireOpts);
			}
		}
		this.fxView.playSim(this.refs, ctx.cam, this.particles);
	}

	/**
	 * One frame of the world. DESIGN_RULES UI-06: this runs on EVERY frame of a mounted run -- with the Bag or
	 * the menu open, and with the survivor dead behind the end-of-run screen. The town is the server's and is
	 * shared, so a client that stopped here would only be drawing a still photograph of a street that is still
	 * moving (a playtest lost 65 HP to zombies it could not see, behind a Bag that "paused"); solo follows the
	 * same rule so there is only one.
	 *
	 * What a menu or a death stops is the SURVIVOR: `input.held` (set by main.client.ts before this call) makes
	 * them stand still with empty hands -- no interact, no build, no aim, a standing command with no buttons --
	 * while the horde, the allies, the clock, the snapshots and the damage carry on.
	 */
	update(dt: number): void {
		const ctx = getCtx();
		const refs = this.refs;
		const p = this.player;
		const input = ctx.input;
		this.clock += dt;
		this.lastDt = dt;
		const acting = !input.held && !p.dead;
		if (acting) {
			const handled = this.build.handleInput(refs, input);
			if (!handled && input.actionPressed) {
				this.interaction.tryInteract(refs);
			}
		}
		this.build.update(refs);
		// F1: in a server session the survivor's position is the server's, predicted and reconciled by netUpdate;
		// everything else in this loop (zombies, combat, the clock) is still simulated locally on every client.
		// The session runs for a dead survivor too: the server keeps stepping them (server/sim/simulation.ts),
		// and it is `netUpdate` that brings the revive (PlayerLife, MP-21), the allies and the horde. Offline, a
		// dead body is simply not stepped -- stepPlayer would regenerate it.
		if (netActive()) this.stepNetPlayer(ctx, dt);
		else if (!p.dead) this.stepLocalPlayer(ctx, dt);
		// F2: and from MP_PHASE 2 the horde and the bosses are the server's as well. `netUpdate` (above) has
		// just interpolated them for this frame's render time, and the mirror writes them into the very
		// arrays the rest of the client already reads — canopies, audio, stuck arrows, the admin overlay.
		const mirrored = SERVER_ACTORS && netActive();
		if (mirrored) this.actors.sync(refs, dt, this.onZombieDeath);
		this.foot.advance(this.walkPhase, this.walkAmp, p.x, p.y, true);
		this.fxView.decayTracers(dt);
		// aim from the survivor's NEW position every frame, not only when the mouse moves -- unless they are held:
		// the cursor is busy with the menu, and a survivor spinning round to follow it would be a lie too
		if (acting) p.angle = refreshAim(p.x, p.y);
		this.combat.update(refs, dt);
		// the three below are no-ops from MP_PHASE 2 on (they say so themselves); below it they ARE the
		// horde, and `mirrored` is false, so exactly one of the two owners writes those arrays in any phase
		updateZombies(refs, dt);
		updateBosses(refs, dt);
		this.spawner.update(refs, dt);
		// with the systems above silent, the blasts, the struck solids and the server's projectiles have
		// nobody left to carry them but the view that put them there
		if (mirrored) this.fxView.advance(refs, dt);
		// a struck tree or car flinches on this client (E, or the server's SolidShake), and from MP_PHASE 2 no
		// system here ages it any more: without this clock the shake never ended (solidFlinch.ts)
		if (SERVER_ACTORS) ageFlinches(dt);
		this.daynight.update(dt);
		// shake before cam.update, particles before particles.update: same frame as before F0
		this.playFx(ctx);
		this.particles.update(dt);
		updateGroundItems(this.world, dt);
		this.interaction.update(refs, dt);
		ctx.cam.follow(p.x, p.y, math.min(1, dt * 8));
		ctx.cam.update(dt);
		this.updateWorldFx(ctx.cam, dt);
		ctx.input.beginFrame();
	}

	// ------------------------------------------------------------------ roofs, canopies, shake

	/**
	 * Roofs and tree canopies around the view (grid query, no full scan).
	 * hitShake is only READ here (drawing); its countdown belongs to the AI below MP_PHASE 2 and to
	 * view/solidFlinch.ts from MP_PHASE 2 on.
	 */
	private updateWorldFx(cam: Camera, dt: number): void {
		const v = cam.viewRect(400);
		const list = this.queryBuf;
		list.clear();
		querySolids(this.world, v.minX, v.minY, v.maxX, v.maxY, list);
		for (const s of list) {
			if (s.kind === "building") {
				this.fadingRoofs.add(s);
			} else if (s.kind === "tree") {
				this.updateCanopy(s, dt);
			}
		}
		const p = this.player;
		for (const s of this.fadingRoofs) {
			const inside = p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h;
			const target = clamp(roofTargetAlpha(inside), 0, 1);
			const a = lerp(s.roofAlpha ?? 1, target, ease(ROOF_LERP, dt));
			if (target >= 1 && a > 0.995) {
				s.roofAlpha = 1;
				this.fadingRoofs.delete(s);
			} else {
				s.roofAlpha = a;
			}
		}
	}

	private updateCanopy(s: Solid, dt: number): void {
		const cx = s.x + s.w / 2;
		const cy = s.y + s.h / 2;
		// any part of a body (≈18 px radius) under the canopy counts: nobody hides half-covered
		const r = (s.canopyR ?? 80) + 18;
		const r2 = r * r;
		let under = false;
		const p = this.player;
		if ((p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy) < r2) {
			under = true;
		} else {
			for (const z of this.zombies) {
				if (z.hp > 0 && (z.x - cx) * (z.x - cx) + (z.y - cy) * (z.y - cy) < r2) {
					under = true;
					break;
				}
			}
			if (!under) {
				for (const b of this.bosses) {
					if ((b.x - cx) * (b.x - cx) + (b.y - cy) * (b.y - cy) < r2) {
						under = true;
						break;
					}
				}
			}
		}
		const target = under ? CANOPY_SEE_THROUGH : 1;
		s.canopyAlpha = lerp(s.canopyAlpha ?? 1, target, ease(0.2, dt));
	}

	// ------------------------------------------------------------------ drawing helpers
	//
	// The town itself (ground, roads, buildings, trees, cars...) is drawn by client/view/worldView.ts, which the
	// menus' flyover draws through as well (DESIGN_RULES UI-10). What stays here is what only a run has: the
	// sun's direction for this hour and the survivor's light, the decals, the loot on the ground.

	private updateShadowDir(): void {
		const t = this.daynight.dayTime;
		if (t > 6 && t < 18) {
			// original: lengthdir(len, day_time/24*360 - 180 - 45) (GameMaker y is flipped)
			const rad = math.rad((t / 24) * 360 - 225);
			this.sunX = math.cos(rad);
			this.sunY = -math.sin(rad);
			this.nightLight = false;
		} else {
			this.nightLight = true;
		}
	}

	/** where a shadow of length `len` falls for something at (x, y) */
	private shadowOffset(x: number, y: number, len: number): { x: number; y: number } {
		if (this.nightLight) {
			const dx = x - this.player.x;
			const dy = y - this.player.y;
			const d = math.sqrt(dx * dx + dy * dy);
			if (d < 1) return { x: 0, y: len * 0.5 };
			return { x: (dx / d) * len, y: (dy / d) * len };
		}
		return { x: this.sunX * len, y: this.sunY * len };
	}

	private drawDecals(r: Renderer, cam: Camera, v: ViewRect): void {
		this.particles.forDecals(d => {
			if (!circleInView(d.x, d.y, d.size, v)) return;
			r.drawCircle(cam, d.x, d.y, d.size, {
				color: d.color,
				alpha: 0.7 * math.min(1, d.life / 5),
				zIndex: Z.decal,
			});
		});
		const puddles = this.refs.puddles;
		if (puddles !== undefined) {
			for (const pd of puddles) {
				if (!circleInView(pd.x, pd.y, pd.r, v)) continue;
				const k = clamp(pd.life / math.max(0.001, pd.lifeMax), 0, 1);
				r.drawCircle(cam, pd.x, pd.y, pd.r * 2, {
					color: COLORS.acid,
					alpha: 0.45 * k,
					stroke: COLORS.bloodZombie,
					strokeAlpha: 0.6 * k,
					zIndex: Z.decal + 1,
				});
			}
		}
	}

	/**
	 * Ground items lie flat where they fell (no floating bob), turned a little, with a short shadow
	 * cast like every other object's. Each category has its own silhouette (see ITEM_LOOKS); a brief
	 * glint every few seconds marks them as loot. A fixed number of sprites per item (the glint is
	 * drawn transparent between flashes) keeps the renderer's pool order stable.
	 */
	private drawItems(r: Renderer, cam: Camera, v: ViewRect): void {
		for (const it of this.world.items) {
			if (!circleInView(it.x, it.y, 26, v)) continue;
			const lk = itemLook(it.kind, it.itemId);
			const a = (((it.id * 37) % 23) / 11 - 1) * ITEM_TILT;
			const so = this.shadowOffset(it.x, it.y, 4);
			part(r, cam, it.x + so.x, it.y + so.y, a, 0, 0, {
				w: lk.shadowW,
				h: lk.shadowH,
				color: BLACK,
				alpha: 0.3,
				cornerRadius: lk.shadowR,
				zIndex: Z.actorShadow,
			});
			const ca = math.cos(a);
			const sa = math.sin(a);
			for (let i = 0; i < lk.parts.size(); i++) {
				const pc = lk.parts[i];
				r.drawRect(cam, it.x + ca * pc.f - sa * pc.l, it.y + sa * pc.f + ca * pc.l, {
					w: pc.w,
					h: pc.h,
					// a piece may be turned inside the item (bow limbs, crate brace)
					rotation: a + pc.rot,
					color: pc.color,
					circle: pc.r === CIRCLE,
					cornerRadius: pc.r,
					stroke: pc.edge ? LOOT_EDGE : undefined,
					strokeThickness: 1,
					strokeAlpha: 0.75,
					zIndex: Z.item + i,
				});
			}
			// glint: a small four-point sparkle at the item's upper-left, out of phase per item
			const t = (this.clock + it.id * 0.61) % GLINT_PERIOD;
			const s = t < GLINT_LEN ? math.sin((t / GLINT_LEN) * math.pi) : 0;
			const gx = it.x - 10;
			const gy = it.y - 11;
			const arm = 3 + GLINT_ARM * s;
			r.drawRect(cam, gx, gy, { w: arm, h: 2, color: WHITE, alpha: 0.9 * s, zIndex: Z.item + 4 });
			r.drawRect(cam, gx, gy, { w: 2, h: arm, color: WHITE, alpha: 0.9 * s, zIndex: Z.item + 4 });
		}
	}

	// ------------------------------------------------------------------ the survivor and the particles
	//
	// The rest of the actors left this file in F2: the horde, the bosses, the arrows and the projectiles are
	// drawn by client/view/actorsView.ts and the effects by client/view/fxView.ts, from the same arrays. What
	// stays is what the loop alone knows — the survivor it steers, and the particle pool it owns.

	/**
	 * The local survivor, through the very same `drawSurvivor` every ally goes through (docs/MULTIPLAYER.md §5.3).
	 * There is exactly one body renderer in the client: an ally can never end up looking like a different species
	 * than you, and a change to the silhouette lands on everyone at once.
	 */
	private drawPlayer(r: Renderer, cam: Camera): void {
		const p = this.player;
		const look = this.look;
		look.x = p.x;
		look.y = p.y;
		look.angle = p.angle;
		look.weapon = currentWeapon(p);
		look.feetPhase = this.walkPhase;
		look.feetAmp = this.walkAmp;
		look.flash = clamp(p.hitFlash ?? 0, 0, 1);
		look.poisoned = p.buffs.poison > 0;
		look.downed = false;
		look.swinging = p.swingerActive;
		look.swingAngle = p.swingerAngle;
		look.swingReach = p.swingReach ?? 46;
		look.clock = this.clock;
		const so = this.shadowOffset(p.x, p.y, 10);
		look.shadowX = so.x;
		look.shadowY = so.y;
		look.z = Z.player;
		// MON-04: what you wear and what follows you, by the same ownership rule the server replicates with
		// (`outfitLookOf` / `petLookOf`), so your screen and everybody else's agree
		const save = getCtx().save;
		look.outfit = outfitLookOf(save);
		this.drawOwnPet(r, cam, petLookOf(save), p.x, p.y, p.angle);
		drawSurvivor(r, cam, look, this.swing);
	}

	/** the local pet, following the position the survivor is DRAWN at this frame */
	private drawOwnPet(r: Renderer, cam: Camera, pet: number, x: number, y: number, angle: number): void {
		if (pet !== this.petLook) {
			// a new animal (or a new run) appears at the heel instead of morphing out of the old one
			this.petLook = pet;
			this.pet.started = false;
		}
		if (pet === PetLook.None) return;
		stepPetFollower(this.pet, x, y, angle, this.lastDt, petFlies(pet));
		drawPet(r, cam, this.pet, pet, this.clock, this.shadowFor);
	}

	private drawParticles(r: Renderer, cam: Camera, v: ViewRect): void {
		this.particles.forActive(p => {
			if (!circleInView(p.x, p.y, p.size, v)) return;
			r.drawCircle(cam, p.x, p.y, p.size, {
				color: p.color,
				alpha: clamp((p.life / p.maxLife) * 1.5, 0, 1),
				zIndex: Z.particle,
			});
		});
	}

	render(): void {
		const ctx = getCtx();
		// effects asked for outside the simulation step (crafting from the backpack, admin tools) still play
		this.playFx(ctx);
		const renderer = ctx.renderer;
		const cam = ctx.cam;
		renderer.beginFrame();
		const view = cam.viewRect(32);
		this.updateShadowDir();
		// the actor views read the loop's sun and its animation clock; the object is refilled, never rebuilt
		const opts = this.drawOpts;
		opts.clock = this.clock;
		// the allies of this frame, already interpolated for the render time (§5.1); empty when solo
		const allies = netActive() ? remotePlayers() : NO_REMOTES;
		const town = this.worldView;
		town.clock = this.clock;
		town.drawGround(renderer, cam, view, this.world);
		this.drawDecals(renderer, cam, view);
		this.drawItems(renderer, cam, view);
		town.drawSolids(renderer, cam, view, this.world);
		this.actors.drawZombies(renderer, cam, view, this.refs, opts);
		// allies first, then you: at the same ZIndex the one who has to read cleanly is the one you steer
		this.playersView.draw(renderer, cam, view, allies, this.lastDt, this.clock, this.shadowFor);
		this.drawPlayer(renderer, cam);
		this.actors.drawBosses(renderer, cam, view, this.refs, opts);
		this.actors.drawBullets(renderer, cam, view, this.refs, opts);
		this.fxView.drawExplosions(renderer, cam, view, this.refs);
		this.fxView.drawTracers(renderer, cam);
		this.drawParticles(renderer, cam, view);
		this.build.draw(renderer, cam);
		renderer.endFrame();
		this.drawLight(cam, view, allies);
		this.drawNameplate(cam);
		this.drawAllyPlates(cam, view, allies);
		this.drawChatBubbles(cam, view, allies);
	}

	/** chat bubbles ride the same layer as the plates, so a survivor's name and their words scale together */
	private drawChatBubbles(cam: Camera, v: ViewRect, allies: ReadonlyArray<RemotePlayerView>): void {
		let chat = this.chat;
		if (chat === undefined) {
			const root = getCtx().darkLayer.Parent;
			if (root === undefined || !root.IsA("GuiObject")) return;
			chat = new ChatBubbles(root, NAMEPLATE_Z);
			this.chat = chat;
		}
		const p = this.player;
		this.selfBody.x = p.x;
		this.selfBody.y = p.y;
		// dead: no body, so nothing to hang your own line on — the rule the nameplate already follows
		chat.update(cam, v, allies, p.dead ? undefined : this.selfBody);
	}

	/** one pooled plate per ally, in the same layer and at the same ZIndex as the local survivor's (§5.3) */
	private drawAllyPlates(cam: Camera, v: ViewRect, allies: ReadonlyArray<RemotePlayerView>): void {
		if (allies.size() === 0 && this.playersView.count() === 0) return;
		const root = getCtx().darkLayer.Parent;
		if (root === undefined || !root.IsA("GuiObject")) return;
		this.playersView.updatePlates(root, NAMEPLATE_Z, cam, v, allies, this.clock);
	}

	/** username + level pill under the player's body; world-anchored, so pause/backpack dim it with the world */
	private drawNameplate(cam: Camera): void {
		const ctx = getCtx();
		if (this.nameplate === undefined) {
			const root = ctx.darkLayer.Parent;
			if (root === undefined || !root.IsA("GuiObject")) return;
			this.nameplate = new Nameplate(root, NAMEPLATE_Z, profileOf(Players.LocalPlayer));
		}
		const p = this.player;
		const at = cam.worldToScreen(p.x, p.y + PLAYER_RADIUS + NAMEPLATE_GAP);
		// MON-05: your title by the rule the server replicates it with (`titleWireOf`: shown only if earned, and
		// `titles` is the server's word -- LoadAck, wallet, its own unlock notice), so every screen agrees
		const shown = ctx.phase === "playing" && !p.dead;
		this.nameplate.update(at.x, at.y, ctx.save.level, shown, titleWireOf(ctx.save));
	}

	/**
	 * Night: a coarse light map instead of a flat overlay (Dead Town simply darkened everything).
	 * The player always sees ~250 px around them; powered lamps / fires light their surroundings,
	 * so building light sources becomes a real defensive choice. Muzzle flashes light up briefly.
	 *
	 * In co-op every standing ally lights the map for everyone (§5.3, MP-08): a group lights a street the way a
	 * group should, and a light you can see but that does not light anything would be a lie.
	 */
	private drawLight(cam: Camera, v: ViewRect, allies: ReadonlyArray<RemotePlayerView>): void {
		const ctx = getCtx();
		ctx.darkLayer.BackgroundTransparency = 1;
		if (this.lightMap === undefined) {
			this.lightMap = new LightMap(ctx.darkLayer, COLORS.overlayNight);
		}
		const dark = this.daynight.darkAlpha;
		if (dark <= 0.004) {
			this.lightMap.hide();
			return;
		}
		const lights = this.lights;
		lights.clear();
		const p = this.player;
		if (!p.dead) {
			lights.push({ x: p.x, y: p.y, r: PLAYER_LIGHT_R, inner: 0.4 });
		}
		if (allies.size() > 0) this.playersView.collectLights(allies, lights);
		const list = this.queryBuf;
		list.clear();
		querySolids(this.world, v.minX - 400, v.minY - 400, v.maxX + 400, v.maxY + 400, list);
		for (const s of list) {
			const r = LIGHT_R[s.tags];
			if (r === undefined || s.powered !== true) continue;
			const fire = s.tags === "campfire" || s.tags === "brazier";
			const flicker = fire ? 0.92 + math.sin(this.clock * 11 + s.id) * 0.05 : 1;
			lights.push({ x: s.x + s.w / 2, y: s.y + s.h / 2, r: r * flicker, inner: 0.5 });
		}
		for (const t of this.fxView.shotLines()) {
			const k = clamp(t.life * 5, 0, 1);
			if (k > 0.05) lights.push({ x: t.x1, y: t.y1, r: 150, k: 0.85 * k, inner: 0.2 });
		}
		for (const b of this.bullets) {
			if (b.kind === "fire") lights.push({ x: b.x, y: b.y, r: 110, k: 0.7, inner: 0.2 });
		}
		const blasts = this.refs.explosions;
		if (blasts !== undefined) {
			for (const e of blasts) {
				lights.push({ x: e.x, y: e.y, r: e.rMax * 1.8, k: explosionFade(e), inner: 0.35 });
			}
		}
		this.lightMap.update(cam, dark, lights);
	}

	/** Hide every world sprite and the night overlay (call when leaving the game screen). */
	hideWorld(): void {
		const ctx = getCtx();
		ctx.renderer.releaseAll();
		this.lightMap?.hide();
		this.nameplate?.update(0, 0, ctx.save.level, false);
		this.playersView.hide();
		this.chat?.hide();
		ctx.darkLayer.BackgroundTransparency = 1;
	}

	getRefs(): GameRefs {
		return this.refs;
	}

	/** admin panel "clear blood": particles and decals are view state, so the view clears them */
	clearEffects(): void {
		this.particles.clear();
		this.fx.clear();
	}

	// ------------------------------------------------------------------ admin panel (src/client/admin)

	/**
	 * admin switches: noclip = the survivor's step skips collision (copied into PlayerState.noclip, which the
	 * server will own in F1), frozen = the sampled command carries no movement (free camera)
	 */
	readonly admin = { noclip: false, frozen: false };
}
