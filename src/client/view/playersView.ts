/*
 * The other survivors on screen (docs/MULTIPLAYER.md §5.3).
 *
 * Everything about an ally that is not the network lives here, and nothing about the network does: the view is
 * handed the already-interpolated `RemotePlayerView[]` of `client/net/netClient.ts` and turns it into
 *
 *   the body      `drawSurvivor` — the very function the local survivor goes through, so an ally can never drift
 *                 into looking like a different species than you (same silhouette, hands, weapon, feet, shadow)
 *   the plate     one pooled `AllyPlate` per userId: name and level, a thin HP bar while they are hurt, and the
 *                 revive ring plus bleed-out countdown while they are down — readable in the dark (MP-08)
 *   the light     every standing ally lights the night map for everyone, not just for themselves (LUZ-02/MP-08)
 *   the cosmetics what they bought, as the server replicated it (MON-04): the outfit rides the same `drawSurvivor`,
 *                 and the pet is a `PetFollower` per ally that follows where THIS client draws them — it is never
 *                 an entity, never on the wire beyond the one byte that says which animal it is
 *
 * Nothing is built inside a frame: plates are pooled by userId, retired only after they have been out of the
 * snapshot for RETIRE_S, and the `SurvivorLook` is one scratch object refilled per ally.
 */
import { Camera, ViewRect } from "shared/engine/camera";
import { LightSource, Renderer } from "shared/engine/renderer";
import { RemotePlayerView } from "../net/netTypes";
import { FEET_CYCLE_PER_UNIT } from "../net/snapshotBuffer";
import { AllyPlate } from "./allyPlate";
import { circleInView, ease } from "./drawKit";
import { FootCycle } from "./footsteps";
import {
	SURVIVOR_LIGHT_R,
	SURVIVOR_R,
	SwingTrail,
	SurvivorLook,
	createLook,
	createSwingTrail,
	drawSurvivor,
	weaponById,
} from "./survivorView";
import { meleeReach } from "shared/data/weapons";
import { PetLook, petFlies } from "shared/data/cosmetics";
import { drawPet } from "./cosmeticsView";
import { drawVehicle } from "./vehicleView";
import { PetFollower, createPetFollower, stepPetFollower } from "./petFollow";

/** a plate whose ally has been out of the snapshot this long is destroyed (§4.4's despawn, with slack) */
const RETIRE_S = 3;
/** margin around the body when culling: the blade, the plate and the revive ring reach past the hitbox */
const CULL_MARGIN = 120;
/**
 * Interpolated speed (world units per second) above which an ally's feet swing. The walk cycle itself arrives
 * already advanced by distance travelled (`snapshotBuffer.FEET_CYCLE_PER_UNIT`), so this only decides the
 * amplitude — and it sits well above the jitter of a standing survivor between two snapshots.
 */
const WALK_SPEED = 8;
/** how fast the feet amplitude follows that decision; the same constant the local survivor uses */
const AMP_EASE = 0.25;
/** where an ally's own light sits between "fully lit" and the falloff, same as the local survivor's */
const LIGHT_INNER = 0.4;
/** culling radius of a pet: the eagle's open wings are the widest thing any of them draws */
const PET_CULL = 60;

/**
 * One pooled ally: their melee-sweep memory, the walk-cycle bookkeeping and — once a parent Frame is known —
 * their plate. The plate is deliberately optional: `draw` runs in the world renderer and may well come before
 * `updatePlates` on the very first frame, and a plate built without its host would be an orphan nobody ever sees.
 */
interface Pooled {
	plate?: AllyPlate;
	trail: SwingTrail;
	/** an ally's feet land like yours do: same cycle, same moment (client/view/footsteps.ts) */
	foot: FootCycle;
	/** clock of the last frame this ally was in the list */
	seen: number;
	/** previous walk-cycle phase, so the amplitude can follow the interpolated speed */
	lastCycle: number;
	amp: number;
	started: boolean;
	/** their pet, following where this client draws them (MON-04), and which animal it was last frame */
	pet: PetFollower;
	petLook: number;
}

/** where a survivor's drop shadow falls; the game loop owns the sun and passes its own accessor */
export type ShadowFn = (x: number, y: number, len: number) => { x: number; y: number };

export class PlayersView {
	private readonly pool = new Map<number, Pooled>();
	/** pool.size(), kept by hand: the frame loop asks for it every frame and a Map walk is not free */
	private pooled = 0;
	private readonly look: SurvivorLook = createLook();
	private parent?: GuiObject;
	private zIndex = 0;

	/**
	 * The bodies, in the world renderer. Call BEFORE the local survivor is drawn, so you are always the one on
	 * top of the pile.
	 */
	draw(
		r: Renderer,
		cam: Camera,
		v: ViewRect,
		list: ReadonlyArray<RemotePlayerView>,
		dt: number,
		clock: number,
		shadow: ShadowFn,
	): void {
		const look = this.look;
		for (const rp of list) {
			const slot = this.slotOf(rp, clock);
			this.advanceWalk(slot, rp, dt);
			this.drawPetOf(r, cam, v, slot, rp, dt, clock, shadow);
			if (!circleInView(rp.x, rp.y, SURVIVOR_R + CULL_MARGIN, v)) continue;
			look.x = rp.x;
			look.y = rp.y;
			look.angle = rp.angle;
			look.outfit = rp.outfit;
			look.weapon = weaponById(rp.weaponId);
			look.feetPhase = rp.feetCycle;
			look.feetAmp = slot.amp;
			// F1's wire carries no hit flash and no poison for an ally (§4.2: 12 bytes, flags only); F2 fills them
			look.flash = 0;
			look.poisoned = false;
			look.downed = rp.downed;
			// the sweep is on the wire (PlayerFlag.Swinging + the blade angle): an ally who attacks has to be
			// SEEN attacking, or co-op combat reads as everyone flailing at nothing
			look.swinging = rp.swinging;
			look.swingAngle = rp.angle + rp.swing;
			look.swingReach = meleeReach(look.weapon);
			look.clock = clock;
			const so = shadow(rp.x, rp.y, 10);
			look.shadowX = so.x;
			look.shadowY = so.y;
			// VEI-05: an ally on a bicycle or a motorcycle is drawn on it, facing where it points
			look.riding = rp.ride > 0;
			if (look.riding) {
				look.angle = rp.rideHeading;
				look.feetAmp = 0;
				drawVehicle(r, cam, rp.ride, rp.x, rp.y, rp.rideHeading, so.x, so.y, look.z - 2);
			}
			drawSurvivor(r, cam, look, slot.trail);
		}
	}

	/**
	 * The plates, above the night layer and below the HUD. `parent` and `zIndex` are the same ones the local
	 * survivor's plate uses, so allies read exactly like you do.
	 */
	updatePlates(
		parent: GuiObject,
		zIndex: number,
		cam: Camera,
		v: ViewRect,
		list: ReadonlyArray<RemotePlayerView>,
		clock: number,
	): void {
		this.parent = parent;
		this.zIndex = zIndex;
		for (const rp of list) {
			const slot = this.slotOf(rp, clock);
			let plate = slot.plate;
			if (plate === undefined) {
				plate = new AllyPlate(parent, zIndex, rp);
				slot.plate = plate;
			}
			// off screen: keep the instances, show nothing (a plate on the edge would point at empty asphalt)
			if (circleInView(rp.x, rp.y, SURVIVOR_R + CULL_MARGIN, v)) plate.update(cam, rp, clock);
			else plate.hide();
		}
		this.retire(clock);
	}

	/** every standing ally's 250 u light, so the night map is lit by the whole group (§5.3, MP-08) */
	collectLights(list: ReadonlyArray<RemotePlayerView>, out: Array<LightSource>): void {
		for (const rp of list) {
			if (rp.downed) continue;
			out.push({ x: rp.x, y: rp.y, r: SURVIVOR_LIGHT_R, inner: LIGHT_INNER });
		}
	}

	/** leaving the game screen: every plate off, the pool kept (rejoining the same session reuses it) */
	hide(): void {
		for (const [, slot] of this.pool) slot.plate?.hide();
	}

	/** drops every instance; the next draw rebuilds the pool from scratch */
	destroy(): void {
		for (const [, slot] of this.pool) slot.plate?.destroy();
		this.pool.clear();
		this.pooled = 0;
	}

	/** how many allies are currently pooled */
	count(): number {
		return this.pooled;
	}

	// ------------------------------------------------------------------ pool

	private slotOf(rp: RemotePlayerView, clock: number): Pooled {
		let slot = this.pool.get(rp.userId);
		if (slot === undefined) {
			slot = {
				trail: createSwingTrail(),
				foot: new FootCycle(),
				seen: clock,
				lastCycle: rp.feetCycle,
				amp: 0,
				started: false,
				pet: createPetFollower(),
				petLook: PetLook.None,
			};
			this.pool.set(rp.userId, slot);
			this.pooled += 1;
		}
		slot.seen = clock;
		return slot;
	}

	/**
	 * An ally's pet (MON-04). It is stepped every frame whether or not its owner is on screen, so it is already at
	 * their heel when they walk into view; a new animal (or none) makes the next one appear at the heel instead of
	 * a dog turning into a bird mid-stride.
	 */
	private drawPetOf(
		r: Renderer,
		cam: Camera,
		v: ViewRect,
		slot: Pooled,
		rp: RemotePlayerView,
		dt: number,
		clock: number,
		shadow: ShadowFn,
	): void {
		if (rp.pet !== slot.petLook) {
			slot.petLook = rp.pet;
			slot.pet.started = false;
		}
		if (rp.pet === PetLook.None) return;
		stepPetFollower(slot.pet, rp.x, rp.y, rp.angle, dt, petFlies(rp.pet));
		if (circleInView(slot.pet.x, slot.pet.y, PET_CULL, v)) drawPet(r, cam, slot.pet, rp.pet, clock, shadow);
	}

	/** feet amplitude from the interpolated speed, eased exactly like the local survivor's */
	private advanceWalk(slot: Pooled, rp: RemotePlayerView, dt: number): void {
		const step = math.max(0, dt);
		// the cycle advances FEET_CYCLE_PER_UNIT per world unit travelled: undo it to read the speed back
		const moved = math.abs(rp.feetCycle - slot.lastCycle);
		slot.lastCycle = rp.feetCycle;
		if (!slot.started) {
			slot.started = true;
			return;
		}
		const speed = step > 0 ? moved / FEET_CYCLE_PER_UNIT / step : 0;
		slot.amp += ((speed > WALK_SPEED ? 1 : 0) - slot.amp) * ease(AMP_EASE, step);
		// a downed survivor drags themselves along: the crawl is not a footstep; nor is a ride (VEI-05)
		if (rp.downed || rp.ride > 0) slot.foot.reset();
		else slot.foot.advance(rp.feetCycle, slot.amp, rp.x, rp.y, false);
	}

	private retire(clock: number): void {
		const gone = new Array<number>();
		for (const [userId, slot] of this.pool) {
			if (clock - slot.seen > RETIRE_S) gone.push(userId);
		}
		for (const userId of gone) {
			const slot = this.pool.get(userId);
			slot?.plate?.destroy();
			if (this.pool.delete(userId)) this.pooled -= 1;
		}
	}
}
