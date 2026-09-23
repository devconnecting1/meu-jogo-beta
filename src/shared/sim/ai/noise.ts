import { WeaponKind } from "shared/data/kinds";

/*
 * What a zombie hears, and how far (docs/DESIGN_RULES.md IA-02). World units, 55 u ≈ 1 m.
 *
 * The original has two noises and only by day: the survivor's footsteps (sys_sound_view: the distance walked
 * in 20 frames, ÷ 1.2, at most 200 px, halved by Stealth) and a gunshot (sound_view_shot(800), a third with the
 * silencer), whatever the gun. At night and in the rain it simulates no sound at all, because every zombie is
 * already hunting — a blanket this remake no longer has (shared/sim/ai/perception.ts).
 *
 * Here noise matters all day and all night, and it is graded by what made it:
 *   LOUD    a gunshot, by weapon class (a pistol is the original's 800, a sniper rifle carries almost twice as
 *           far); building something; a construction smashed; an exploder going off.
 *   MEDIUM  running — the survivor's normal gait.
 *   LOW     walking (a hurt, starving or slowed survivor drags their feet quieter), a blow landing on a body.
 * That is the tactical trade-off the owner asked for: a blade is quiet and keeps a fight local, a gun ends it
 * faster and brings the street. The rain masks everything to RAIN_HEARING (shared/sim/ai/perception.ts).
 *
 * A noise tells a zombie WHERE IT CAME FROM, never where the survivor is now: it goes and looks (suspicious),
 * and only its eyes turn that into a chase. Walls do not stop a ring — a shot inside a house is heard outside,
 * so a building is never a place where noise is free (the interiors rule: no safe spots inside).
 *
 * Pure: numbers only. No world, no Instances.
 */

/** the survivor's normal gait: the original's walk ring, capped at 200 px, a little wider for a run */
export const STEP_RUN = 220;
/** a survivor slowed below WALK_BELOW (hurt, starving, in acid) drags their feet: half as loud */
export const STEP_WALK = 110;
/** below this speed (u/s) a survivor is walking rather than running: 80% of the base 7 px/frame (210 u/s) */
export const WALK_BELOW = 168;
/** "Stealth" (skill 15) halves the footsteps, as in the original */
export const STEALTH_STEPS = 0.5;
/** a blow landing on a body (a blade, a bat, a bullet's impact): a thud the next zombie over hears */
export const HIT = 150;
/** the original's sound_view_shot(800): what a pistol is heard from */
export const GUNSHOT = 800;
/** the silencer divides a shot by 3 (sys_sound_view) */
export const SILENCER_DIVISOR = 3;
/** placing a construction: hammering, dragging planks */
export const BUILD = 450;
/** a zombie banging on a barricade or a door: every blow carries down the street */
export const STRUCT_HIT = 300;
/** a construction giving way */
export const STRUCT_BREAK = 650;
/** an exploder going off (the original's boom_power 800) */
export const EXPLOSION = 800;

/**
 * How much further than a pistol each class of gun is heard. Handguns are the reference (the original's single
 * number); long guns and shotguns are louder; machine guns fire so often that a burst reads as one long noise;
 * a sniper rifle is the loudest thing in the town. The flamethrower is a hiss and a roar, the stun gun a crack.
 * Bows are not in the table: an arrow is silent until it lands (HIT).
 */
export function gunClassScale(kind: number, weaponId: number): number {
	if (weaponId === 25) return 0.45; // flamethrower
	if (weaponId === 26) return 0.35; // stun gun
	if (kind === WeaponKind.Pistol) return 1;
	if (kind === WeaponKind.Rifle) return 1.4;
	if (kind === WeaponKind.Shotgun) return 1.4;
	if (kind === WeaponKind.MG) return 1.5;
	if (kind === WeaponKind.Sniper) return 1.75;
	if (kind === WeaponKind.Bow || kind === WeaponKind.Melee) return 0;
	return 1;
}

/** radius of one shot of weapon (`kind`, `weaponId`), with or without the silencer */
export function gunshotRadius(kind: number, weaponId: number, silenced: boolean): number {
	const r = GUNSHOT * gunClassScale(kind, weaponId);
	return silenced ? r / SILENCER_DIVISOR : r;
}

/** radius of the footsteps of a survivor moving at `speed` u/s (0 = standing still: no ring) */
export function footstepRadius(speed: number, stealthy: boolean): number {
	if (speed <= 1) return 0;
	const r = speed < WALK_BELOW ? STEP_WALK : STEP_RUN;
	return stealthy ? r * STEALTH_STEPS : r;
}

/** seconds between two footstep rings (the original's walk_tempo, 20 frames) */
export const STEP_TEMPO = 20 / 30;
/** a new ring this close to a young one from the same place merges into it instead of adding another */
export const MERGE_DIST = 100;
