/*
 * A survivor's own light at night, ONE rule for the two places that need it (DESIGN_RULES LUZ-04):
 *
 *   - the server's horde visibility (shared/sim/ai/zombieBrain.ts collectLights / isLit): a zombie inside this light
 *     is drawn at full alpha and replicated (§4.3, MP-07); outside every light it fades out and is not sent;
 *   - the client's light map (client/gameLoop.ts drawLight): the ground the player sees lit.
 *
 * Until 2026-09-23 the two disagreed (QA E1): the server lit the flashlight's cone and the torch's 400 u, the screen
 * drew a plain 250 u whatever was in hand, so the zombies caught by the beam glowed on dark ground. Both now ask
 * this module, which reads the gadget table (shared/data/equips.ts EQUIP_LIGHTS).
 *
 * Pure, and allocation-free (the client asks every frame).
 */
import { EQUIP_LIGHTS, EquipLight } from "shared/data/equips";
import type { PlayerSaveData } from "shared/game/save";

/** everyone's own light: ~250 u around the survivor (LUZ-02, LUZ-03) */
export const SURVIVOR_LIGHT_R = 250;
/** skill id of Nocturnal ("Night vision increases"): the survivor's light 1.5× wider */
export const SKILL_NOCTURNAL = 16;
export const NOCTURNAL_MULT = 1.5;
/** EQUIPS id of the flashlight, the one cone of the table */
export const FLASHLIGHT_ID = 13;
/** half the flashlight's cone, in radians: a point more than this off the aim is outside it */
export const CONE_HALF_ANGLE = math.rad(EQUIP_LIGHTS[FLASHLIGHT_ID].coneDeg ?? 45);

/**
 * Night vision on the wearer's own screen: the night's darkness × this (15 % of it lifted everywhere), in the
 * phosphor green of COLORS.overlayNightVision. Only the screen: the horde's visibility is the `sight` circle, so the
 * lift stays small -- the ground past the circle reads a little, but it is still night there, and a zombie there is
 * still unseen (LUZ-04).
 */
export const NIGHT_VISION_DARK = 0.85;

/** the light row of a worn gadget, or undefined */
function lightOf(id: number): EquipLight | undefined {
	return id >= 0 ? EQUIP_LIGHTS[id] : undefined;
}

/**
 * The radius of the survivor's own circle: 250 u, ×1.5 with Nocturnal, and at least the radius of a worn torch or
 * night vision (a gadget in the hand or on the gun slot).
 */
export function survivorLightRadius(save: PlayerSaveData): number {
	let r = SURVIVOR_LIGHT_R;
	if ((save.skillLevels[SKILL_NOCTURNAL] ?? 0) > 0) r *= NOCTURNAL_MULT;
	const hand = lightOf(save.equipHand);
	if (hand !== undefined && hand.coneDeg === undefined) r = math.max(r, hand.radius);
	const gun = lightOf(save.equipGun);
	if (gun !== undefined && gun.coneDeg === undefined) r = math.max(r, gun.radius);
	return r;
}

/** the cone the survivor carries along their aim (the flashlight), or undefined */
export function survivorCone(save: PlayerSaveData): EquipLight | undefined {
	const hand = lightOf(save.equipHand);
	if (hand !== undefined && hand.coneDeg !== undefined) return hand;
	const gun = lightOf(save.equipGun);
	if (gun !== undefined && gun.coneDeg !== undefined) return gun;
	return undefined;
}

/** is the survivor wearing night vision (a `sight` gadget)? Their own screen sees the night brighter and green */
export function wearsNightVision(save: PlayerSaveData): boolean {
	return lightOf(save.equipGun)?.sight === true || lightOf(save.equipHand)?.sight === true;
}

/** shortest signed difference between two angles, in [−π, π] (the same in Luau and in the Node tests) */
function angleDelta(a: number, b: number): number {
	const d = a - b;
	return math.atan2(math.sin(d), math.cos(d));
}

/**
 * Is (x, y) inside the light of a survivor at (px, py) aiming at `aim`? The circle, or the cone. The same geometry
 * the horde's `isLit` applies to the lights it collects -- here for one survivor, for the tests and the tools.
 */
export function survivorLights(
	save: PlayerSaveData,
	px: number,
	py: number,
	aim: number,
	x: number,
	y: number,
): boolean {
	const dx = x - px;
	const dy = y - py;
	const d2 = dx * dx + dy * dy;
	const r = survivorLightRadius(save);
	if (d2 <= r * r) return true;
	const cone = survivorCone(save);
	if (cone === undefined || d2 > cone.radius * cone.radius) return false;
	return math.abs(angleDelta(aim, math.atan2(dy, dx))) <= CONE_HALF_ANGLE;
}
