/*
 * The night's lights of one frame, as the light map and the zombies' awareness marks read them (GameLoop.drawLight →
 * LightMap.update and renderer.lightAt), and the ONE shape a survivor's own light has on this screen -- yours and
 * every ally's alike (DESIGN_RULES LUZ-04, MP-08).
 *
 * The list is refilled every frame from a pool of LightSource records (M4): the survivors, the lamps and fires in
 * reach, the muzzle flashes of a fight and the blasts were a new table each, every frame. `items` is the same array
 * for the whole run, so the marks' `MarkNight.lights` can hold on to it.
 */
import { LightSource } from "shared/engine/renderer";
import * as SurvivorLight from "shared/sim/survivorLight";

/** where a survivor's own circle sits between "fully lit" and the falloff */
export const SURVIVOR_INNER = 0.4;
/** the flashlight's beam is fully bright to this fraction of its reach, then fades to 0 at its end */
export const FLASHLIGHT_INNER = 0.35;

export class LightList {
	/** this frame's lights, in the order they were added (the light map tracks each by its index) */
	readonly items = new Array<LightSource>();
	/** every record ever handed out; [0, used) are in `items` this frame */
	private readonly records = new Array<LightSource>();
	private used = 0;

	clear(): void {
		this.items.clear();
		this.used = 0;
	}

	/** a round light at (x, y): full to `inner` of `r`, fading to 0 at `r`, `k` its peak (0..1) */
	circle(x: number, y: number, r: number, inner: number, k = 1): void {
		const l = this.take();
		l.x = x;
		l.y = y;
		l.r = r;
		l.inner = inner;
		l.k = k;
		l.angle = undefined;
		l.cone = undefined;
	}

	/** a cone along world heading `angle`, lit within `half` radians of it (the flashlight) */
	cone(x: number, y: number, r: number, inner: number, angle: number, half: number): void {
		const l = this.take();
		l.x = x;
		l.y = y;
		l.r = r;
		l.inner = inner;
		l.k = 1;
		l.angle = angle;
		l.cone = half;
	}

	/** a light someone else built (a lamp drone): taken as it is */
	push(l: LightSource): void {
		this.items.push(l);
	}

	private take(): LightSource {
		let l = this.records[this.used];
		if (l === undefined) {
			l = { x: 0, y: 0, r: 0 };
			this.records.push(l);
		}
		this.used += 1;
		this.items.push(l);
		return l;
	}
}

/**
 * A survivor's own light, the shape every screen draws it with: their circle (`radius`, from
 * `SurvivorLight.survivorLightRadius` for the local survivor) and, when they carry one, the flashlight's cone of
 * `cone` units along their aim, as wide as the server's (`SurvivorLight.CONE_HALF_ANGLE`, LUZ-04).
 */
export function addSurvivorLight(
	lights: LightList,
	x: number,
	y: number,
	aim: number,
	radius: number,
	cone: number | undefined,
): void {
	lights.circle(x, y, radius, SURVIVOR_INNER);
	if (cone !== undefined) lights.cone(x, y, cone, FLASHLIGHT_INNER, aim, SurvivorLight.CONE_HALF_ANGLE);
}

/** what an ally's record says about their light (client/net/netTypes.ts RemotePlayerView) */
export interface AllyLightSource {
	x: number;
	y: number;
	angle: number;
	dead: boolean;
	flashlight: boolean;
	/** VehicleKind they ride (0 on foot) and its heading */
	ride: number;
	rideHeading: number;
}

/**
 * An ally's light, by the same shape as yours: whoever carries a light (`carriesLight`: the dead do not) lights their
 * 250 u circle; riding a motorcycle, its headlight along the RIDE (SurvivorLight.survivorBeamReach: it replaces the
 * flashlight, both hands are on the bars) -- the wire already says what they ride and where it points (VEI-05), so no
 * bit is spent on it; otherwise the flashlight's cone along the aim when `PlayerFlag.Flashlight` says they hold one.
 */
export function addAllyLight(lights: LightList, rp: AllyLightSource): void {
	if (!SurvivorLight.carriesLight(rp)) return;
	const head = SurvivorLight.vehicleHeadlight(rp.ride);
	if (head > 0) {
		addSurvivorLight(lights, rp.x, rp.y, rp.rideHeading, SurvivorLight.SURVIVOR_LIGHT_R, head);
		return;
	}
	const cone = rp.flashlight ? SurvivorLight.FLASHLIGHT_REACH : undefined;
	addSurvivorLight(lights, rp.x, rp.y, rp.angle, SurvivorLight.SURVIVOR_LIGHT_R, cone);
}
