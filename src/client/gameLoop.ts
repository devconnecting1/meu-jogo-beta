import { getCtx, refreshAim } from "./bootstrap";
import { COLORS, Z } from "shared/engine/colors";
import { Camera, ViewRect } from "shared/engine/camera";
import { DESIGN } from "shared/engine/constants";
import { LightMap, LightMapStats, Renderer, SpriteOpts } from "shared/engine/renderer";
import { clamp, lerp } from "shared/engine/vec2";
import { expMaxInit, outfitLookOf, petLookOf, PlayerSaveData, titleWireOf } from "shared/game/save";
import { PetLook, petFlies } from "shared/data/cosmetics";
import { createPlayer, currentWeapon, PlayerState } from "shared/game/player";
import { PLAYER_RADIUS } from "shared/game/physics";
import type { GameContext } from "shared/game/context";
import {
	buildingAt,
	createWorld,
	insideBuilding,
	isOnRoad,
	querySolids,
	queryTown,
	randomOpenPoint,
	rectHitsSolid,
	updateGroundItems,
	WorldData,
	Solid,
} from "shared/game/world";
import { takeTown } from "./boot/townCache";
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
import { rideHeading } from "shared/sim/rideKey";
import * as SurvivorLight from "shared/sim/survivorLight";
import { FxEvent, InputCommand, makeCommand, packEdges, SEQ_MOD } from "shared/sim/types";
import { Nameplate, profileOf } from "./ui/nameplate";
import {
	netActive,
	netBindAdmin,
	netReset,
	netServerSeconds,
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
import { drawVehicle } from "./view/vehicleView";
import { drawPet } from "./view/cosmeticsView";
import { createPetFollower, stepPetFollower } from "./view/petFollow";
import { FootCycle } from "./view/footsteps";
import { circleInView } from "./view/drawKit";
import { WorldView } from "./view/worldView";
import { GroundItemsView } from "./view/groundItemsView";
import { MachinesView } from "./view/machinesView";
import { ageFlinches } from "./view/solidFlinch";
import { BodyGrid } from "./view/bodyGrid";
import { addSurvivorLight, LightList } from "./view/lightList";
import { AwarenessMarks, MarkAvoid, MarkNight } from "./view/zombieAwareness";
import * as Quality from "./view/quality";
import { reducedMotion } from "./ui/skin";

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
/** the zombies' awareness marks: above the night overlay (they must read at night), under the nameplates */
const AWARENESS_Z = NAMEPLATE_Z - 1;
/** world units from the player's centre to the top of the plate: clears the body and its shadow */
const NAMEPLATE_GAP = 14;

/** roof easing per 60 fps frame (the original lerp), applied frame-rate independently */
const ROOF_LERP = 0.15;
/** tree canopy opacity while someone stands under it (original obj_tree1 fades near the player) */
const CANOPY_SEE_THROUGH = 0.35;
/**
 * Night light radii (world units) of built light sources. The survivor's own light (its circle and the flashlight's
 * cone) is shared/sim/survivorLight.ts, the rule the server's horde visibility uses too (LUZ-04).
 */
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

/*
 * The loop's own option tables, one scratch per call site (M4): a literal per decal and particle was a table per
 * sprite per frame. The keys that never change are written here; each draw writes the rest.
 */
const DECAL_O: SpriteOpts = { zIndex: Z.decal };
const PUDDLE_O: SpriteOpts = { color: COLORS.acid, stroke: COLORS.bloodZombie, zIndex: Z.decal + 1 };
const PARTICLE_O: SpriteOpts = { zIndex: Z.particle };

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
	/** this frame's standing zombies by position: what a tree's canopy asks (updateCanopy) */
	private readonly underCanopy = new BodyGrid();
	/** player walk cycle (feet) */
	private walkPhase = 0;
	private walkAmp = 0;
	/** shadow direction: sun by day, away from the player's light at night */
	private sunX = 0.7;
	private sunY = 0.7;
	private nightLight = false;
	/** what `shadowOffset` answers, refilled per call */
	private readonly shadowOut = { x: 0, y: 0 };
	private clock = 0;
	private lightMap?: LightMap;
	private nameplate?: Nameplate;
	/** this frame's lights of the night map (and of the awareness marks), refilled in place */
	private readonly lights = new LightList();
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
	/** the "?" / "!" / dot over each zombie (client/view/zombieAwareness.ts), built on the first frame that can host it */
	private awareness?: AwarenessMarks;
	/** the bodies a mark must never cover, refilled in place: the local survivor first, then the allies */
	private readonly markAvoid = new Array<MarkAvoid>();
	/** the night the light map drew this frame: a mark is only as bright as the ground under its zombie (IA-05) */
	private readonly markNight: MarkNight = { dark: 0, lights: this.lights.items };
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
	/** what lies on the ground to be picked up (client/view/groundItemsView.ts) */
	private readonly groundItems = new GroundItemsView(this.shadowFor);
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
	/** the electric builds: turrets turning, drones in the air, cables, the beacon's arrow (ELE-01..08) */
	private readonly machines = new MachinesView(this.shadowFor);
	/** where the survivor in `slot` is DRAWN this frame: a drone in the air escorts that body (ELE-05) */
	private readonly pilotAt = (slot: number): { x: number; y: number } | undefined =>
		slot === this.wireOpts.localSlot ? (this.player.dead ? undefined : this.player) : this.shooterAt(slot);

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
		this.worldView.machines = this.machines;
	}

	init(save: PlayerSaveData): void {
		this.save = save;
		// the server's town, not always the same one: when every survivor dies the world ends and the next is built
		// from a new seed (MP-22). Offline this is DESIGN.TOWN_SEED, as it always was
		this.townSeed = netTownSeed();
		// the lobby's flyover already generated this seed's town: the match TAKES that copy (it is the match's from now
		// on; the next menu generates its own) instead of generating it again -- client/boot/townCache.ts
		this.world = takeTown(this.townSeed);
		this.fadingRoofs.clear();
		resetEntityIds();
		resetBullets();
		this.zombies.clear();
		this.bosses.clear();
		this.bullets.clear();
		// a new world has none of the old one's bodies, shot lines, blasts or server-flown projectiles
		this.actors.reset();
		this.fxView.clear(this.refs);
		this.machines.clear();
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
		// the session's frame: snapshots in, prediction, reconciliation, commands out (MicroProfiler label)
		debug.profilebegin("pz.net");
		netUpdate(this.refs, dt);
		debug.profileend();
		const dx = p.x - fromX;
		const dy = p.y - fromY;
		const moved = math.sqrt(dx * dx + dy * dy);
		this.walkPhase += moved * FEET_CYCLE_PER_UNIT;
		const speed = dt > 0 ? moved / dt : 0;
		// a rider's feet are on the pedals: no walk cycle, no footsteps (VEI-05)
		const walking = speed > NET_WALK_SPEED && p.ride === undefined;
		this.walkAmp = lerp(this.walkAmp, walking ? 1 : 0, ease(0.25, dt));
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
		// the quality tier (client/view/quality.ts): the Graphics setting, or in Auto this client's own frame time
		this.particles.lowDetail = Quality.qualityFrame(dt, ctx.save.settings.graphics);
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
		if (mirrored) {
			// the snapshot's horde and bosses written into the client's arrays (MicroProfiler label)
			debug.profilebegin("pz.mirror");
			this.actors.sync(refs, dt, this.onZombieDeath);
			debug.profileend();
		}
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
		// the building records and the trees: never a building's own walls or furniture (queryTown)
		queryTown(this.world, v.minX, v.minY, v.maxX, v.maxY, list);
		// the standing zombies, bucketed once for every tree below (L6: each tree walked the whole horde)
		const under = this.underCanopy;
		under.clear();
		for (const z of this.zombies) {
			if (z.hp > 0) under.add(z.x, z.y);
		}
		for (const s of list) {
			if (s.kind === "building") {
				this.fadingRoofs.add(s);
			} else if (s.kind === "tree") {
				this.updateCanopy(s, dt);
			}
		}
		const p = this.player;
		for (const s of this.fadingRoofs) {
			// the footprint's parts, not its box: standing on the porch or in a loading notch is outside (EDI-04)
			const inside = insideBuilding(s, p.x, p.y);
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
		const p = this.player;
		// the survivor, then the standing zombies from the cells under the crown only (updateWorldFx filled the grid
		// this frame), then the bosses
		let under = (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy) < r2 || this.underCanopy.anyWithin(cx, cy, r);
		if (!under) {
			for (const b of this.bosses) {
				if ((b.x - cx) * (b.x - cx) + (b.y - cy) * (b.y - cy) < r2) {
					under = true;
					break;
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

	/**
	 * Where a shadow of length `len` falls for something at (x, y). The answer is one scratch (the drawKit rule, M4):
	 * a frame asks for one per solid, item and actor on screen, and no caller keeps it past its next draw.
	 */
	private shadowOffset(x: number, y: number, len: number): { x: number; y: number } {
		const out = this.shadowOut;
		if (this.nightLight) {
			const dx = x - this.player.x;
			const dy = y - this.player.y;
			const d = math.sqrt(dx * dx + dy * dy);
			if (d < 1) {
				out.x = 0;
				out.y = len * 0.5;
			} else {
				out.x = (dx / d) * len;
				out.y = (dy / d) * len;
			}
			return out;
		}
		out.x = this.sunX * len;
		out.y = this.sunY * len;
		return out;
	}

	private drawDecals(r: Renderer, cam: Camera, v: ViewRect): void {
		const o = DECAL_O;
		for (const d of this.particles.decalRecords()) {
			if (d.life <= 0 || !circleInView(d.x, d.y, d.size, v)) continue;
			o.color = d.color;
			o.alpha = 0.7 * math.min(1, d.life / 5);
			r.drawCircle(cam, d.x, d.y, d.size, o);
		}
		const puddles = this.refs.puddles;
		if (puddles !== undefined) {
			const p = PUDDLE_O;
			for (const pd of puddles) {
				if (!circleInView(pd.x, pd.y, pd.r, v)) continue;
				const k = clamp(pd.life / math.max(0.001, pd.lifeMax), 0, 1);
				p.alpha = 0.45 * k;
				p.strokeAlpha = 0.6 * k;
				r.drawCircle(cam, pd.x, pd.y, pd.r * 2, p);
			}
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
		// VEI-05: on a vehicle the rider faces where it points, feet on the pedals, over the vehicle
		const ride = p.ride;
		look.riding = ride !== undefined;
		if (ride !== undefined) {
			look.angle = rideHeading(ride);
			look.feetAmp = 0;
			// the look's copy: `so` is the loop's one shadow scratch, and the pet above asked for its own since
			drawVehicle(r, cam, ride.kind, p.x, p.y, look.angle, look.shadowX, look.shadowY, Z.player - 2);
		}
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
		const o = PARTICLE_O;
		for (const p of this.particles.active()) {
			if (!circleInView(p.x, p.y, p.size, v)) continue;
			o.color = p.color;
			o.alpha = clamp((p.life / p.maxLife) * 1.5, 0, 1);
			r.drawCircle(cam, p.x, p.y, p.size, o);
		}
	}

	render(): void {
		const ctx = getCtx();
		// effects asked for outside the simulation step (crafting from the backpack, admin tools) still play
		this.playFx(ctx);
		const renderer = ctx.renderer;
		const cam = ctx.cam;
		// MicroProfiler labels (docs/research/performance.md): the sprite pool's frame, then the night's light map
		debug.profilebegin("pz.world");
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
		const items = this.groundItems;
		items.reduceMotion = reducedMotion();
		items.draw(renderer, cam, view, this.world.items, this.clock, this.lastDt);
		this.machines.learn(this.world, this.fxView.shotLines(), this.clock, netServerSeconds(), this.lastDt);
		town.drawSolids(renderer, cam, view, this.world);
		this.machines.drawAir(
			renderer,
			cam,
			view,
			this.lastDt,
			this.pilotAt,
			this.player.dead ? undefined : this.player,
		);
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
		debug.profileend();
		debug.profilebegin("pz.light");
		this.drawLight(cam, view, allies);
		debug.profileend();
		this.drawAwareness(cam, view, allies);
		this.drawNameplate(cam);
		this.drawAllyPlates(cam, view, allies);
		this.drawChatBubbles(cam, view, allies);
	}

	/** the zombies' awareness marks (IA-05), over the night overlay and never over a survivor */
	private drawAwareness(cam: Camera, v: ViewRect, allies: ReadonlyArray<RemotePlayerView>): void {
		let marks = this.awareness;
		if (marks === undefined) {
			const root = getCtx().darkLayer.Parent;
			if (root === undefined || !root.IsA("GuiObject")) return;
			marks = new AwarenessMarks(root, AWARENESS_Z);
			this.awareness = marks;
		}
		const avoid = this.markAvoid;
		const p = this.player;
		this.putAvoid(0, p.x, p.y);
		let n = 1;
		for (const a of allies) {
			this.putAvoid(n, a.x, a.y);
			n += 1;
		}
		while (avoid.size() > n) avoid.pop();
		marks.reduceMotion = reducedMotion();
		marks.draw(cam, v, this.refs.zombies, avoid, this.lastDt, this.world, this.markNight);
	}

	private putAvoid(i: number, x: number, y: number): void {
		const slot = this.markAvoid[i];
		if (slot === undefined) {
			this.markAvoid.push({ x, y });
			return;
		}
		slot.x = x;
		slot.y = y;
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

	/** level, name and title under the player's body (no background); world-anchored, so a menu dims it with the world */
	private drawNameplate(cam: Camera): void {
		const ctx = getCtx();
		if (this.nameplate === undefined) {
			const root = ctx.darkLayer.Parent;
			if (root === undefined || !root.IsA("GuiObject")) return;
			// yours: no @handle, and it gives way to an ally's plate it overlaps (client/ui/nameplate.ts)
			this.nameplate = new Nameplate(root, NAMEPLATE_Z, profileOf(Players.LocalPlayer), {
				self: true,
				world: true,
			});
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
		// the layer itself stays clear (the light map paints the night): a write only if something changed it
		if (ctx.darkLayer.BackgroundTransparency !== 1) ctx.darkLayer.BackgroundTransparency = 1;
		if (this.lightMap === undefined) {
			this.lightMap = new LightMap(ctx.darkLayer, COLORS.overlayNight);
		}
		// night vision (E2): the wearer's own screen sees the night lifted and green; the lit circle is the rule's
		const save = ctx.save;
		this.lightMap.setLowDetail(Quality.lowDetail(save.settings.graphics));
		const nightVision = SurvivorLight.wearsNightVision(save);
		this.lightMap.setColor(nightVision ? COLORS.overlayNightVision : COLORS.overlayNight);
		const dark = this.daynight.darkAlpha * (nightVision ? SurvivorLight.NIGHT_VISION_DARK : 1);
		// the awareness marks follow this very darkness and these very lights (drawAwareness)
		this.markNight.dark = dark > 0.004 ? dark : 0;
		if (dark <= 0.004) {
			this.lightMap.hide();
			return;
		}
		// refilled from its pool of records: no table per light per frame (M4)
		const lights = this.lights;
		lights.clear();
		const p = this.player;
		if (SurvivorLight.carriesLight(p)) {
			// what is in hand or worn, by the ONE rule the server's horde visibility uses (LUZ-04): the circle
			// (Nocturnal, torch, night vision) and the flashlight's cone along the aim, to the unit and the degree
			const radius = SurvivorLight.survivorLightRadius(save);
			const cone = SurvivorLight.survivorCone(save);
			addSurvivorLight(lights, p.x, p.y, p.angle, radius, cone?.radius);
		}
		// every ally's, by the same shape and as far as the wire tells what they carry (playersView.collectLights)
		if (allies.size() > 0) this.playersView.collectLights(allies, lights);
		const list = this.queryBuf;
		list.clear();
		querySolids(this.world, v.minX - 400, v.minY - 400, v.maxX + 400, v.maxY + 400, list);
		for (const s of list) {
			const r = LIGHT_R[s.tags];
			if (r === undefined || s.powered !== true) continue;
			const fire = s.tags === "campfire" || s.tags === "brazier";
			const flicker = fire ? 0.92 + math.sin(this.clock * 11 + s.id) * 0.05 : 1;
			lights.circle(s.x + s.w / 2, s.y + s.h / 2, r * flicker, 0.5);
		}
		this.machines.collectLights(lights.items);
		for (const t of this.fxView.shotLines()) {
			const k = clamp(t.life * 5, 0, 1);
			if (k > 0.05) lights.circle(t.x1, t.y1, 150, 0.2, 0.85 * k);
		}
		for (const b of this.bullets) {
			if (b.kind === "fire") lights.circle(b.x, b.y, 110, 0.2, 0.7);
		}
		const blasts = this.refs.explosions;
		if (blasts !== undefined) {
			for (const e of blasts) lights.circle(e.x, e.y, e.rMax * 1.8, 0.35, explosionFade(e));
		}
		this.lightMap.update(cam, dark, lights.items);
	}

	/** Hide every world sprite and the night overlay (call when leaving the game screen). */
	hideWorld(): void {
		const ctx = getCtx();
		ctx.renderer.releaseAll();
		this.lightMap?.hide();
		this.nameplate?.update(0, 0, ctx.save.level, false);
		this.playersView.hide();
		this.chat?.hide();
		this.awareness?.hide();
		ctx.darkLayer.BackgroundTransparency = 1;
	}

	/**
	 * The ground item the E press would take now (client/systems/interaction.ts `hintedItem`, -1 for none): the one
	 * that wears the brackets (ITM-06). client/main.client.ts sets it with the "E: …" hint, under the same conditions.
	 */
	setItemTarget(id: number): void {
		this.groundItems.target = id;
	}

	getRefs(): GameRefs {
		return this.refs;
	}

	/** what the night's light map did on its last frame (the admin panel's stats card); undefined before any night */
	lightStats(): LightMapStats | undefined {
		return this.lightMap?.stats;
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
